#!/usr/bin/env python3
"""Durable, fail-closed retention state for immutable runtime artifacts.

This module owns retention metadata and garbage collection only.  It does not
activate a runtime, consume authorization, inspect Docker, or decide
production eligibility.  Delivery and future activation share the lock in the
publication root with this module.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import time
from typing import Any, Iterator
from zipfile import ZipFile

import runtime_artifact_provenance as provenance


RETENTION_CONTRACT = "clashcookies.durable-artifact-retention"
RETENTION_VERSION = 1
STATE_FILENAME = "retention-state.json"
LOCK_FILENAME = ".artifact-retention.lock"
LEGACY_BASELINE_ID = "legacy-runtime-baseline"
MAX_STATE_BYTES = 1024 * 1024
MAX_RELEASES = 128
MAX_GC_DELETIONS = 16
MAX_IDENTITY_BYTES = 128 * 1024
MAX_EVIDENCE_BYTES = provenance.MAX_BUNDLE_BYTES
DEFAULT_TEMP_INODES = 4096
DEFAULT_PERSISTENT_INODES = 32
MAX_INVENTORY_ENTRIES = 256
MAX_GC_TRANSACTIONS = MAX_GC_DELETIONS
MAX_RELEASE_ENTRIES = 16


class RetentionError(RuntimeError):
    """Raised when retention evidence, durability, ownership, or capacity is unsafe."""


def _fail(message: str) -> None:
    raise RetentionError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        _fail(f"retention metadata is not canonical JSON: {error}")


def identity_digest(identity: dict[str, Any]) -> str:
    payload = _canonical(identity)
    digest = hashlib.sha256(payload).hexdigest()
    _require(len(digest) == 64, "retention identity digest is malformed")
    return digest


def _safe_directory(path: Path, label: str) -> None:
    _require(path.is_absolute(), f"{label} must be absolute")
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid(), f"{label} is not owner-controlled")
        _require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private")


def _private_regular_file(path: Path, label: str) -> os.stat_result:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a regular file")
    _require(metadata.st_nlink == 1, f"{label} must be a single regular file")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid(), f"{label} is not owner-controlled")
        _require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private")
    return metadata


def _timestamp(value: Any, label: str, *, allow_none: bool = False) -> None:
    if value is None and allow_none:
        return
    _require(isinstance(value, str) and value != "", f"{label} is malformed")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(f"{label} is malformed")
    _require(parsed.tzinfo is not None, f"{label} must include a timezone")


def _nonnegative_int(value: Any, label: str) -> int:
    _require(type(value) is int and value >= 0, f"{label} must be a non-negative integer")
    return value


def _fsync_directory(path: Path, *, required: bool = True) -> None:
    if os.name != "posix":
        if required:
            _fail("retention directory durability is unavailable on this platform")
        return
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        os.fsync(descriptor)
    except OSError as error:
        if required:
            _fail(f"retention directory fsync failed: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


@contextmanager
def activity_lock(publication_root: Path, timeout_seconds: float = 5.0) -> Iterator[None]:
    """Shared kernel-backed lock for delivery, retention, GC, and future activation."""
    _safe_directory(publication_root, "publication root")
    _require(timeout_seconds > 0, "retention lock timeout must be positive")
    path = publication_root / LOCK_FILENAME
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        metadata = os.fstat(descriptor)
        _require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "retention lock must be a single regular file")
        if os.name == "posix":
            _require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "retention lock ownership or permissions are unsafe")
            import fcntl
            deadline = time.monotonic() + timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        _fail("retention lock acquisition deadline exceeded")
                    time.sleep(0.01)
        yield
    except OSError as error:
        _fail(f"retention lock failed: {error}")
    finally:
        if descriptor is not None:
            if os.name == "posix":
                try:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                except OSError:
                    pass
            os.close(descriptor)


def _strict_identity(value: Any) -> dict[str, Any]:
    _require(isinstance(value, dict) and value, "retained release identity is missing or malformed")
    encoded = _canonical(value)
    _require(0 < len(encoded) <= MAX_IDENTITY_BYTES, "retained release identity is empty or oversized")
    expected_fields = set(provenance.TrustedReleaseIdentity.__dataclass_fields__)
    _require(set(value) == expected_fields, "retained release identity has missing or unexpected fields")
    artifact_class = value.get("artifact_class")
    _require(artifact_class in {provenance.DEVELOPMENT_ARTIFACT_CLASS, provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS}, "retained release artifact class is unsupported")
    for field in ("repository", "source_ref", "source_sha", "event", "producer_workflow", "producer_revision", "signer_workflow", "signer_revision", "artifact_name", "artifact_class", "artifact_service_zip_sha256", "archive_name", "archive_sha256", "platform", "image", "image_digest", "authorization_context"):
        _require(type(value[field]) is str and value[field] != "", f"retained identity field is malformed: {field}")
    for field in ("repository_id", "repository_owner_id", "run_id", "run_attempt", "artifact_id", "artifact_service_zip_bytes", "archive_bytes"):
        _require(type(value[field]) is int and value[field] > 0, f"retained identity field is malformed: {field}")
    if artifact_class == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
        try:
            provenance.validate_trusted_release_identity(provenance.TrustedReleaseIdentity(**value))
        except (TypeError, provenance.ProvenanceError) as error:
            _fail(f"retained production-candidate identity is invalid: {error}")
    else:
        _require(provenance.GIT_SHA_RE.fullmatch(str(value["source_sha"])) is not None, "retained development source SHA is malformed")
        _require(provenance.GIT_SHA_RE.fullmatch(str(value["producer_revision"])) is not None, "retained development producer revision is malformed")
        _require(provenance.GIT_SHA_RE.fullmatch(str(value["signer_revision"])) is not None, "retained development signer revision is malformed")
        for field in ("artifact_service_zip_sha256", "archive_sha256"):
            _require(provenance.SHA256_RE.fullmatch(str(value[field])) is not None, f"retained development {field} is malformed")
        _require(type(value["artifact_service_zip_bytes"]) is int and value["artifact_service_zip_bytes"] > 0, "retained development ZIP byte count is invalid")
        _require(type(value["archive_bytes"]) is int and value["archive_bytes"] > 0, "retained development archive byte count is invalid")
    return value


def _read_json(path: Path, maximum: int, label: str) -> Any:
    metadata = _private_regular_file(path, label)
    _require(metadata.st_size <= maximum, f"{label} is oversized")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{label} is malformed: {error}")


def _file_evidence(path: Path, maximum: int, label: str) -> dict[str, Any]:
    _private_regular_file(path, label)
    digest, size = provenance._sha256_file(path, maximum, label)
    return {"sha256": digest, "bytes": size}


def _initial_state() -> dict[str, Any]:
    return {
        "contract": RETENTION_CONTRACT,
        "version": RETENTION_VERSION,
        "generation": 0,
        "updated_at": _now(),
        "active_release": None,
        "previous_known_good_release": LEGACY_BASELINE_ID,
        "legacy_baseline": {
            "id": LEGACY_BASELINE_ID,
            "authenticated": False,
            "protected": True,
            "description": "first legacy runtime rollback baseline; not an authenticated release",
        },
        "releases": {},
        "operations": {},
        "gc_transactions": {},
    }


def _validate_state(state: Any) -> dict[str, Any]:
    _require(isinstance(state, dict), "retention metadata must be an object")
    expected = {"contract", "version", "generation", "updated_at", "active_release", "previous_known_good_release", "legacy_baseline", "releases", "operations", "gc_transactions"}
    _require(set(state) == expected, "retention metadata has missing or unexpected fields")
    _require(state["contract"] == RETENTION_CONTRACT and state["version"] == RETENTION_VERSION, "retention metadata contract version is unsupported")
    _require(isinstance(state["generation"], int) and state["generation"] >= 0, "retention metadata generation is invalid")
    _timestamp(state["updated_at"], "retention metadata updated_at")
    _require(isinstance(state["releases"], dict) and len(state["releases"]) <= MAX_RELEASES, "retention release table is invalid")
    _require(isinstance(state["operations"], dict) and len(state["operations"]) <= MAX_RELEASES, "retention operation table is invalid")
    _require(isinstance(state["gc_transactions"], dict) and len(state["gc_transactions"]) <= MAX_GC_TRANSACTIONS, "retention GC transaction table is invalid")
    legacy = state["legacy_baseline"]
    _require(isinstance(legacy, dict) and set(legacy) == {"id", "authenticated", "protected", "description"}, "legacy rollback baseline metadata is malformed")
    _require(legacy["id"] == LEGACY_BASELINE_ID and legacy["authenticated"] is False and legacy["protected"] is True, "legacy rollback baseline must remain unauthenticated and protected")
    for pointer_name in ("active_release", "previous_known_good_release"):
        pointer = state[pointer_name]
        _require(pointer is None or pointer == LEGACY_BASELINE_ID or (isinstance(pointer, str) and len(pointer) == 64 and all(char in "0123456789abcdef" for char in pointer)), f"{pointer_name} is malformed")
    for key, record in state["releases"].items():
        _require(isinstance(key, str) and len(key) == 64 and key == key.lower(), "retention release key is malformed")
        _require(isinstance(record, dict), "retention release record is malformed")
        required = {"identity_sha256", "identity", "publication_name", "roles", "evidence", "reconciliation", "created_at", "retired_at"}
        _require(set(record) == required, "retention release record has missing or unexpected fields")
        identity = _strict_identity(record["identity"])
        _require(record["identity_sha256"] == key == identity_digest(identity), "retention identity digest conflict")
        name = record["publication_name"]
        _require(isinstance(name, str) and name == f"release-{key}", "retention publication ownership is malformed")
        roles = record["roles"]
        _require(isinstance(roles, list) and all(role in {"pending", "reserved", "in-flight", "recovery-protected", "retired"} for role in roles) and len(set(roles)) == len(roles), "retention release roles are malformed")
        _timestamp(record["created_at"], "retention release created_at")
        _timestamp(record["retired_at"], "retention release retired_at", allow_none=True)
        if "retired" in roles:
            _require(record["retired_at"] is not None, "retired release is missing retired_at")
        else:
            _require(record["retired_at"] is None, "unretired release has retired_at")
        evidence = record["evidence"]
        _require(isinstance(evidence, dict) and "artifact-service.zip" in evidence and set(evidence).issubset({"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}), "retention evidence metadata is malformed")
        for evidence_name, evidence_record in evidence.items():
            _require(isinstance(evidence_record, dict) and set(evidence_record) == {"sha256", "bytes"} and provenance.SHA256_RE.fullmatch(str(evidence_record["sha256"])) is not None and type(evidence_record["bytes"]) is int and evidence_record["bytes"] > 0, f"retention evidence record is malformed: {evidence_name}")
        reconciliation = record["reconciliation"]
        _require(isinstance(reconciliation, dict) and set(reconciliation) == {"authorization", "recovery"}, "retention reconciliation metadata is malformed")
        _require(reconciliation["authorization"] in {None, "released", "consumed", "expired", "not-applicable"}, "retention authorization reconciliation is malformed")
        _require(reconciliation["recovery"] in {None, "recovered", "abandoned", "not-applicable"}, "retention recovery reconciliation is malformed")
    for operation_id, operation in state["operations"].items():
        _require(isinstance(operation_id, str) and 0 < len(operation_id) <= 128 and isinstance(operation, dict), "retention in-flight operation is malformed")
        _require(set(operation) == {"release_sha256", "kind", "started_at"}, "retention in-flight operation has unexpected fields")
        _require(operation["release_sha256"] in state["releases"], "retention operation references an unknown release")
        _require(isinstance(operation["kind"], str) and operation["kind"] != "", "retention operation kind is malformed")
        _timestamp(operation["started_at"], "retention operation started_at")
        _require("in-flight" in state["releases"][operation["release_sha256"]]["roles"], "retention operation is not represented by an in-flight release role")
    for transaction_id, transaction in state["gc_transactions"].items():
        _require(isinstance(transaction_id, str) and transaction_id in state["releases"], "retention GC transaction identity is malformed")
        _require(isinstance(transaction, dict) and set(transaction) == {"release_sha256", "publication_name", "owner", "phase", "started_at"}, "retention GC transaction is malformed")
        _require(transaction["release_sha256"] == transaction_id, "retention GC transaction identity conflict")
        _require(transaction["publication_name"] == f"release-{transaction_id}", "retention GC transaction publication is malformed")
        _require(transaction["phase"] in {"planned", "deleting"}, "retention GC transaction phase is malformed")
        _timestamp(transaction["started_at"], "retention GC transaction started_at")
        owner = transaction["owner"]
        _require(isinstance(owner, dict) and set(owner) == {"st_dev", "st_ino", "st_uid"} and all(type(owner[key]) is int and owner[key] >= 0 for key in owner), "retention GC transaction owner is malformed")
    for pointer_name in ("active_release", "previous_known_good_release"):
        pointer = state[pointer_name]
        if pointer not in (None, LEGACY_BASELINE_ID):
            _require(pointer in state["releases"], f"{pointer_name} references an unknown release")
    _require(state["active_release"] is None or state["active_release"] != state["previous_known_good_release"], "active and previous known-good releases must be distinct")
    for pointer in (state["active_release"], state["previous_known_good_release"]):
        if pointer not in (None, LEGACY_BASELINE_ID):
            _require(state["releases"][pointer]["roles"] == [], "active or previous release has conflicting retention roles")
    for key, record in state["releases"].items():
        if key not in {state["active_release"], state["previous_known_good_release"]}:
            _require(record["roles"] != [], "unreferenced release has no retention role")
    return state


@dataclass(frozen=True)
class StorageAssessment:
    status: str
    filesystems: tuple[dict[str, Any], ...]
    required_bytes: int
    required_inodes: int


def assess_storage(
    paths: list[Path],
    *,
    temporary_bytes: int,
    persistent_bytes: int,
    preserved_runtime_bytes: int = 0,
    incremental_preservation_bytes: int = 0,
    database_headroom_bytes: int = 0,
    host_headroom_bytes: int = 0,
    temporary_inodes: int = DEFAULT_TEMP_INODES,
    persistent_inodes: int = DEFAULT_PERSISTENT_INODES,
    headroom_inodes: int = 128,
) -> StorageAssessment:
    """Account once per filesystem, including overlapping receiving/publication roots."""
    _require(paths and all(isinstance(path, Path) for path in paths), "storage admission requires explicit paths")
    for value, label in ((temporary_bytes, "temporary_bytes"), (persistent_bytes, "persistent_bytes"), (preserved_runtime_bytes, "preserved_runtime_bytes"), (incremental_preservation_bytes, "incremental_preservation_bytes"), (database_headroom_bytes, "database_headroom_bytes"), (host_headroom_bytes, "host_headroom_bytes"), (temporary_inodes, "temporary_inodes"), (persistent_inodes, "persistent_inodes"), (headroom_inodes, "headroom_inodes")):
        _nonnegative_int(value, label)
    values: dict[int, dict[str, Any]] = {}
    for path in paths:
        try:
            metadata = os.stat(path)
        except OSError as error:
            _fail(f"storage admission cannot inspect filesystem: {error}")
        device = int(metadata.st_dev)
        if device not in values:
            try:
                stats = os.statvfs(path)
                free_bytes = int(stats.f_bavail * stats.f_frsize)
                free_inodes = int(stats.f_favail)
                inode_verified = True
            except AttributeError:
                usage = shutil.disk_usage(path)
                free_bytes = int(usage.free)
                # Windows development hosts do not expose portable inode
                # accounting. Linux production admission remains strict.
                free_inodes = 2**63 - 1
                inode_verified = False
            values[device] = {"device": device, "free_bytes": free_bytes, "free_inodes": free_inodes, "inode_verified": inode_verified, "paths": 0}
        values[device]["paths"] += 1
    required_bytes = max(0, temporary_bytes) + max(0, persistent_bytes) + max(0, incremental_preservation_bytes) + max(0, database_headroom_bytes) + max(0, host_headroom_bytes)
    required_inodes = max(0, temporary_inodes) + max(0, persistent_inodes) + max(0, headroom_inodes)
    observed = []
    blocked = False
    for item in values.values():
        item = dict(item)
        item["required_bytes"] = required_bytes
        item["required_inodes"] = required_inodes
        item["preserved_runtime_bytes"] = max(0, preserved_runtime_bytes)
        item["incremental_preservation_bytes"] = max(0, incremental_preservation_bytes)
        item["status"] = "PASS" if item["free_bytes"] >= required_bytes and item["free_inodes"] >= required_inodes else "BLOCKED"
        blocked = blocked or item["status"] == "BLOCKED"
        observed.append(item)
    return StorageAssessment("BLOCKED" if blocked else "PASS", tuple(observed), required_bytes, required_inodes)


def retained_bytes(publication_root: Path) -> int:
    total = 0
    if not publication_root.exists():
        return 0
    release_count = 0
    for child in publication_root.iterdir():
        if not child.is_dir() or child.is_symlink() or not child.name.startswith("release-"):
            continue
        release_count += 1
        _require(release_count <= MAX_INVENTORY_ENTRIES, "retained storage inventory exceeds its bound")
        entries: list[Path] = []
        for path in child.iterdir():
            if len(entries) >= MAX_RELEASE_ENTRIES:
                _fail("retained release inventory exceeds its bound")
            entries.append(path)
        for path in entries:
            _require(not path.is_symlink(), "retained storage contains a symlink")
            if path.is_file():
                total += path.stat().st_size
    return total


class RetentionStore:
    """Atomic metadata store. Public mutators require the caller to be in activity_lock."""

    def __init__(self, publication_root: Path, *, repository_root: Path, require_durable: bool = True):
        self.root = publication_root
        self.repository_root = repository_root
        self.require_durable = require_durable
        _safe_directory(publication_root, "publication root")
        _safe_directory(repository_root, "repository root")
        try:
            publication_root.resolve().relative_to(repository_root.resolve())
        except ValueError:
            pass
        else:
            _fail("publication root must be outside the mutable checkout")
        self.state_path = publication_root / STATE_FILENAME

    def load(self) -> dict[str, Any]:
        if not self.state_path.exists():
            _fail("retention metadata is missing; explicit initialization is required")
        state = _read_json(self.state_path, MAX_STATE_BYTES, "retention metadata")
        return _validate_state(state)

    def initialize(self, *, assume_locked: bool = False) -> None:
        """Create the first state only when the publication root is demonstrably empty."""
        def apply() -> None:
            if self.state_path.exists():
                _validate_state(_read_json(self.state_path, MAX_STATE_BYTES, "retention metadata"))
                return
            entries = [entry for entry in self.root.iterdir() if entry.name != LOCK_FILENAME]
            _require(not entries, "retention metadata is missing beside existing publication material")
            self._save(_initial_state())
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def _save(self, state: dict[str, Any]) -> None:
        state = _validate_state(state)
        state["generation"] += 1
        state["updated_at"] = _now()
        temporary = self.root / f".{STATE_FILENAME}.tmp-{os.getpid()}-{time.time_ns()}"
        payload = _canonical(state) + b"\n"
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            written = 0
            while written < len(payload):
                written += os.write(descriptor, payload[written:])
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            os.replace(temporary, self.state_path)
            _fsync_directory(self.root, required=self.require_durable)
        except OSError as error:
            _fail(f"retention metadata atomic update failed: {error}")
        finally:
            if descriptor is not None:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _record(state: dict[str, Any], identity: dict[str, Any], publication_name: str, evidence: dict[str, Any], roles: list[str]) -> None:
        digest = identity_digest(identity)
        _require(publication_name == f"release-{digest}", "retention publication name is not bound to exact immutable identity")
        _require(digest not in state["releases"], "retention release already exists with conflicting metadata")
        _require(len(state["releases"]) < MAX_RELEASES, "retention release table is full")
        state["releases"][digest] = {"identity_sha256": digest, "identity": identity, "publication_name": publication_name, "roles": roles, "evidence": evidence, "reconciliation": {"authorization": None, "recovery": None}, "created_at": _now(), "retired_at": None}

    def register_delivery(self, identity: dict[str, Any], publication: Path, *, authorization_reserved: bool = False, assume_locked: bool = False) -> None:
        _strict_identity(identity)
        digest = identity_digest(identity)
        _require(publication.parent == self.root and publication.name == f"release-{digest}", "retention publication is not exact identity-owned path")
        _require(publication.is_dir() and not publication.is_symlink(), "retention publication is missing")
        evidence: dict[str, Any] = {}
        for name in ("artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"):
            path = publication / name
            if path.exists():
                evidence[name] = _file_evidence(path, MAX_EVIDENCE_BYTES if name != "artifact-service.zip" else provenance.MAX_ARTIFACT_BYTES, f"retained {name}")
        _require("artifact-service.zip" in evidence, "retained publication is missing the original artifact-service ZIP")
        _require(evidence["artifact-service.zip"] == {"sha256": identity["artifact_service_zip_sha256"], "bytes": identity["artifact_service_zip_bytes"]}, "retained artifact does not match the immutable release identity")
        verification_names = {"attestation-bundle.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
        if "attestation-bundle.json" in evidence:
            _require(verification_names.issubset(evidence), "attested retention requires independently retained expectation, receipt, and trust root")
            expectation = _read_json(publication / "verification-expectation.json", MAX_EVIDENCE_BYTES, "verification expectation")
            receipt = _read_json(publication / "verification-receipt.json", MAX_EVIDENCE_BYTES, "verification receipt")
            _require(isinstance(expectation, dict) and expectation.get("contract") == "clashcookies.retained-verification-expectation" and expectation.get("version") == 1 and expectation.get("identity_sha256") == digest, "verification expectation is not bound to the immutable identity")
            _require(isinstance(receipt, dict) and receipt.get("status") == "verified-provenance-only" and receipt.get("authenticated") is True, "verification receipt is not authenticated provenance evidence")
            root_digest, root_bytes = provenance._sha256_file(publication / "trusted-root.jsonl", provenance.MAX_BUNDLE_BYTES, "retained trusted root")
            _require(expectation.get("trusted_root_sha256") == root_digest and expectation.get("trusted_root_bytes") == root_bytes, "retained trust root is not bound to the verification expectation")
        roles = ["pending"] + (["reserved"] if authorization_reserved else [])
        def apply() -> None:
            state = self.load()
            existing = state["releases"].get(digest)
            if existing is None:
                self._record(state, identity, publication.name, evidence, roles)
                self._save(state)
                return
            _require(existing["identity"] == identity and existing["evidence"] == evidence, "retention retry has conflicting release or evidence metadata")
            _require("retired" not in existing["roles"], "retired release cannot be silently reactivated")
            if authorization_reserved and "reserved" not in existing["roles"]:
                existing["roles"].append("reserved")
                self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def mark_operation(self, operation_id: str, identity_sha256: str, *, kind: str, recovery_required: bool = False, assume_locked: bool = False) -> None:
        _require(0 < len(operation_id) <= 128 and isinstance(kind, str) and kind != "", "retention operation reference is invalid")
        def apply() -> None:
            state = self.load()
            _require(identity_sha256 in state["releases"], "retention operation reference is invalid")
            _require(operation_id not in state["operations"], "retention operation already exists")
            state["operations"][operation_id] = {"release_sha256": identity_sha256, "kind": kind, "started_at": _now()}
            record = state["releases"][identity_sha256]
            if "in-flight" not in record["roles"]:
                record["roles"].append("in-flight")
            if recovery_required and "recovery-protected" not in record["roles"]:
                record["roles"].append("recovery-protected")
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def retire(self, identity_sha256: str, *, assume_locked: bool = False) -> None:
        def apply() -> None:
            state = self.load()
            _require(identity_sha256 in state["releases"], "cannot retire unknown release")
            _require(state["active_release"] != identity_sha256 and state["previous_known_good_release"] != identity_sha256, "active or previous known-good release cannot be retired")
            _require(all(operation["release_sha256"] != identity_sha256 for operation in state["operations"].values()), "in-flight release cannot be retired")
            record = state["releases"][identity_sha256]
            _require(not (set(record["roles"]) & {"pending", "reserved", "in-flight", "recovery-protected"}), "release protection requires actual authorization or recovery reconciliation before retirement")
            record["roles"] = ["retired"]
            record["retired_at"] = _now()
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def consume_reserved_authorization(self, identity_sha256: str, envelope: Any, revision_allowlist: Any, trust: Any, journal: Any, *, operation: str, now: Any = None, assume_locked: bool = False) -> None:
        """Consume a real replay-journal reservation before removing reserved protection."""
        def apply() -> None:
            state = self.load()
            record = state["releases"].get(identity_sha256)
            _require(record is not None and "reserved" in record["roles"], "retained release has no reserved authorization to consume")
            identity = provenance.TrustedReleaseIdentity(**record["identity"])
            journal.consume(envelope, identity, revision_allowlist, trust, operation=operation, now=now)
            state = self.load()
            record = state["releases"].get(identity_sha256)
            _require(record is not None and "reserved" in record["roles"], "retained reservation changed during authorization consumption")
            record["roles"] = [role for role in record["roles"] if role not in {"pending", "reserved"}]
            if not record["roles"]:
                record["roles"] = ["retired"]
                record["retired_at"] = _now()
            record["reconciliation"]["authorization"] = "consumed"
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def transition_active_for_test(self, identity_sha256: str, *, health_gate: Any, consume_authorization: Any, assume_locked: bool = False) -> None:
        """Exercise the future atomic health-gated pointer contract; never called operationally."""
        def apply() -> None:
            state = self.load()
            _require(identity_sha256 in state["releases"], "activation candidate is unknown")
            record = state["releases"][identity_sha256]
            _require("pending" in record["roles"] or "reserved" in record["roles"], "activation candidate is not pending or reserved")
            _require(bool(health_gate()), "activation health gate did not pass")
            consume_authorization()
            old_active = state["active_release"]
            old_previous = state["previous_known_good_release"]
            if old_previous not in (None, LEGACY_BASELINE_ID, old_active):
                previous_record = state["releases"][old_previous]
                previous_record["roles"] = ["retired"]
                previous_record["reconciliation"] = {"authorization": "not-applicable", "recovery": "not-applicable"}
                previous_record["retired_at"] = _now()
            if old_active and old_active != identity_sha256:
                old_record = state["releases"][old_active]
                old_record["roles"] = [role for role in old_record["roles"] if role not in {"pending", "reserved", "in-flight", "recovery-protected", "retired"}]
            state["previous_known_good_release"] = old_active or LEGACY_BASELINE_ID
            state["active_release"] = identity_sha256
            record["roles"] = []
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def inventory(self, *, assume_locked: bool = False) -> dict[str, Any]:
        def collect() -> dict[str, Any]:
            state = self.load()
            known: list[dict[str, Any]] = []
            unknown: list[dict[str, Any]] = []
            children: list[Path] = []
            truncated = False
            for child in self.root.iterdir():
                if len(children) >= MAX_INVENTORY_ENTRIES:
                    truncated = True
                    break
                children.append(child)
            for child in children:
                if not child.is_dir() or child.is_symlink() or not child.name.startswith("release-"):
                    continue
                try:
                    _safe_directory(child, "retained release directory")
                    identity = _strict_identity(_read_json(child / "identity.json", MAX_IDENTITY_BYTES, "retained identity"))
                    digest = identity_digest(identity)
                    _require(child.name == f"release-{digest}", "publication directory is not identity-named")
                    record = state["releases"].get(digest)
                    _require(record is not None and record["publication_name"] == child.name and record["identity"] == identity, "publication has missing or conflicting retention metadata")
                    known.append({"identity_sha256": digest, "publication": child.name, "roles": record["roles"], "eligible": record["roles"] == ["retired"] and state["active_release"] != digest and state["previous_known_good_release"] != digest})
                except (RetentionError, OSError):
                    unknown.append({"publication": child.name, "reason": "unknown-or-ambiguous-ownership"})
            if truncated:
                unknown.append({"publication": "<inventory-truncated>", "reason": "inventory-bound-exceeded"})
            return {"contract": RETENTION_CONTRACT, "version": RETENTION_VERSION, "active_release": state["active_release"], "previous_known_good_release": state["previous_known_good_release"], "known": known, "unknown": unknown, "truncated": truncated, "legacy_baseline_protected": True}
        if assume_locked:
            return collect()
        with activity_lock(self.root):
            return collect()

    def garbage_collect(self, *, execute: bool = False, max_deletions: int = MAX_GC_DELETIONS, assume_locked: bool = False) -> dict[str, Any]:
        _require(0 <= max_deletions <= MAX_GC_DELETIONS, "garbage-collection deletion bound is invalid")
        def collect() -> dict[str, Any]:
            if execute and os.name != "posix":
                _fail("destructive retention garbage collection requires POSIX descriptor safety")
            state = self.load()
            if execute:
                self._recover_gc_transactions(state)
            else:
                self._validate_gc_transactions(state)
            state = self.load()
            inventory = self.inventory(assume_locked=True)
            transaction_ids = set(state["gc_transactions"])
            transaction_unknown = [{"publication": transaction["publication_name"], "reason": "gc-transaction-recovery-required"} for transaction in state["gc_transactions"].values() if not (self.root / transaction["publication_name"]).exists()]
            candidates = [] if inventory.get("truncated") else [item for item in inventory["known"] if item["eligible"] and item["identity_sha256"] not in transaction_ids]
            candidates = candidates[:max_deletions]
            deleted: list[str] = []
            if execute:
                for item in candidates:
                    digest = item["identity_sha256"]
                    current = self.load()
                    _require(current["active_release"] != digest and current["previous_known_good_release"] != digest, "release became protected during garbage collection")
                    record = current["releases"].get(digest)
                    _require(record is not None and record["roles"] == ["retired"], "release became ineligible during garbage collection")
                    path = self.root / record["publication_name"]
                    owner = self._verify_owned_release(path, record)
                    current["gc_transactions"][digest] = {"release_sha256": digest, "publication_name": path.name, "owner": owner, "phase": "planned", "started_at": _now()}
                    self._save(current)
                    current = self.load()
                    current["gc_transactions"][digest]["phase"] = "deleting"
                    self._save(current)
                    self._delete_owned_release(path, record, owner)
                    deleted.append(digest)
                    current = self.load()
                    current["releases"].pop(digest, None)
                    current["gc_transactions"].pop(digest, None)
                    self._save(current)
            return {"dry_run": not execute, "candidates": [item["identity_sha256"] for item in candidates], "deleted": deleted, "unknown": inventory["unknown"] + transaction_unknown, "protected": [item["identity_sha256"] for item in inventory["known"] if not item["eligible"]] + sorted(transaction_ids)}
        if assume_locked:
            return collect()
        with activity_lock(self.root):
            return collect()

    def _recover_gc_transactions(self, state: dict[str, Any]) -> None:
        self._validate_gc_transactions(state)
        changed = False
        for digest, transaction in list(state["gc_transactions"].items()):
            record = state["releases"].get(digest)
            path = self.root / transaction["publication_name"]
            if record is None or transaction["publication_name"] != f"release-{digest}":
                _fail("retention GC transaction has conflicting ownership")
            if "recovery-protected" not in record["roles"]:
                record["roles"].append("recovery-protected")
                if "retired" in record["roles"]:
                    record["roles"].remove("retired")
                    record["retired_at"] = None
                changed = True
        if changed:
            self._save(state)

    def _validate_gc_transactions(self, state: dict[str, Any]) -> None:
        for digest, transaction in state["gc_transactions"].items():
            _require(state["active_release"] != digest and state["previous_known_good_release"] != digest, "GC transaction references a protected release")
            _require(not any(operation["release_sha256"] == digest for operation in state["operations"].values()), "GC transaction conflicts with an in-flight operation")
            record = state["releases"].get(digest)
            _require(record is not None and set(record["roles"]) <= {"retired", "recovery-protected"}, "GC transaction references an invalid release role")
            path = self.root / transaction["publication_name"]
            if path.exists():
                self._verify_owned_release(path, record)

    def acknowledge_gc_deletion(self, identity_sha256: str, owner: dict[str, int], *, assume_locked: bool = False) -> None:
        """Explicitly finalize a missing-path GC transaction after owner review."""
        def apply() -> None:
            state = self.load()
            transaction = state["gc_transactions"].get(identity_sha256)
            record = state["releases"].get(identity_sha256)
            _require(transaction is not None and record is not None, "GC deletion transaction is unknown")
            _require(transaction["owner"] == owner and transaction["phase"] == "deleting", "GC deletion ownership confirmation is invalid")
            _require(state["active_release"] != identity_sha256 and state["previous_known_good_release"] != identity_sha256, "cannot finalize protected GC deletion")
            _require("recovery-protected" in record["roles"] and not (self.root / transaction["publication_name"]).exists(), "GC deletion is not explicitly recovery-ready")
            _require(not any(operation["release_sha256"] == identity_sha256 for operation in state["operations"].values()), "GC deletion conflicts with an in-flight operation")
            state["releases"].pop(identity_sha256, None)
            state["gc_transactions"].pop(identity_sha256, None)
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def _verify_owned_release(self, path: Path, record: dict[str, Any]) -> dict[str, int]:
        _require(path.parent == self.root and path.name == record["publication_name"], "release ownership path changed")
        metadata = os.lstat(path)
        _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), "release ownership directory is unsafe")
        if os.name == "posix":
            _require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "release ownership directory is not private or owner-controlled")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(descriptor)
                _require((opened.st_dev, opened.st_ino, opened.st_uid) == (metadata.st_dev, metadata.st_ino, metadata.st_uid), "release ownership directory changed during inspection")
            finally:
                os.close(descriptor)
        identity = _strict_identity(_read_json(path / "identity.json", MAX_IDENTITY_BYTES, "retained identity"))
        _require(identity_digest(identity) == record["identity_sha256"] and identity == record["identity"], "release ownership identity changed")
        allowed = set(record["evidence"]) | {"identity.json", "artifact-service.zip"}
        _require({child.name for child in path.iterdir()} == allowed, "release contains unknown or missing material")
        for name, evidence in record["evidence"].items():
            actual = _file_evidence(path / name, MAX_EVIDENCE_BYTES if name != "artifact-service.zip" else provenance.MAX_ARTIFACT_BYTES, f"retained {name}")
            _require(actual == evidence, f"retained {name} changed")
        return {"st_dev": int(metadata.st_dev), "st_ino": int(metadata.st_ino), "st_uid": int(metadata.st_uid)}

    def _delete_owned_release(self, path: Path, record: dict[str, Any], owner: dict[str, int]) -> None:
        """Delete one already-verified flat release through descriptor-bound names."""
        parent_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        parent_fd = os.open(self.root, parent_flags)
        release_fd = None
        try:
            parent_stat = os.fstat(parent_fd)
            root_stat = os.lstat(self.root)
            _require((parent_stat.st_dev, parent_stat.st_ino, parent_stat.st_uid) == (root_stat.st_dev, root_stat.st_ino, root_stat.st_uid), "publication root changed during deletion")
            release_fd = os.open(path.name, parent_flags, dir_fd=parent_fd)
            release_stat = os.fstat(release_fd)
            _require({"st_dev": int(release_stat.st_dev), "st_ino": int(release_stat.st_ino), "st_uid": int(release_stat.st_uid)} == owner, "release ownership changed during deletion")
            for name in ("identity.json", *record["evidence"].keys()):
                child_stat = os.stat(name, dir_fd=release_fd, follow_symlinks=False)
                _require(stat.S_ISREG(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode) and child_stat.st_nlink == 1, "release evidence changed during deletion")
                if os.name == "posix":
                    _require(child_stat.st_uid == os.geteuid() and stat.S_IMODE(child_stat.st_mode) & 0o077 == 0, "release evidence ownership changed during deletion")
                os.unlink(name, dir_fd=release_fd)
            os.rmdir(path.name, dir_fd=parent_fd)
            _fsync_directory(self.root, required=True)
        except OSError as error:
            _fail(f"descriptor-bound release deletion failed: {error}")
        finally:
            if release_fd is not None:
                os.close(release_fd)
            os.close(parent_fd)

    def verify_retained_offline(self, identity_sha256: str, *, trusted_root: Path, trusted_root_version: str, verifier_version: str | None = None) -> dict[str, Any]:
        """Re-verify retained evidence with an independently maintained trust root."""
        _require(isinstance(trusted_root_version, str) and len(trusted_root_version) == 16 and all(char in "0123456789abcdef" for char in trusted_root_version), "independent trusted-root version is malformed")
        _require(trusted_root.is_absolute() and trusted_root.is_file() and not trusted_root.is_symlink(), "independent trusted root is unavailable")
        for base in (self.root, self.repository_root):
            try:
                trusted_root.resolve().relative_to(base.resolve())
            except ValueError:
                pass
            else:
                _fail("independent trusted root must be outside retention and checkout roots")
        trusted_metadata = _private_regular_file(trusted_root, "independent trusted root")
        if os.name == "posix":
            _require(trusted_metadata.st_uid == os.geteuid() and stat.S_IMODE(trusted_metadata.st_mode) & 0o077 == 0, "independent trusted root is not private")
        with activity_lock(self.root):
            state = self.load()
            record = state["releases"].get(identity_sha256)
            _require(record is not None, "offline verification release is unknown")
            evidence = record["evidence"]
            required = {"artifact-service.zip", "attestation-bundle.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
            _require(required.issubset(evidence), "retained offline verification evidence is incomplete")
            path = self.root / record["publication_name"]
            self._verify_owned_release(path, record)
            expectation = _read_json(path / "verification-expectation.json", MAX_EVIDENCE_BYTES, "retained verification expectation")
            receipt = _read_json(path / "verification-receipt.json", MAX_EVIDENCE_BYTES, "retained verification receipt")
            _require(isinstance(expectation, dict) and expectation.get("contract") == "clashcookies.retained-verification-expectation" and expectation.get("version") == 1, "retained verification expectation is not bound")
            _require(expectation.get("identity_sha256") == identity_sha256, "retained verification expectation identity is not bound")
            _require(isinstance(receipt, dict) and receipt.get("status") == "verified-provenance-only" and receipt.get("authenticated") is True, "retained verification receipt is not an authenticated receipt")
            retained_root_digest, retained_root_bytes = provenance._sha256_file(path / "trusted-root.jsonl", provenance.MAX_BUNDLE_BYTES, "retained trusted root")
            root_digest, root_bytes = provenance._sha256_file(trusted_root, provenance.MAX_BUNDLE_BYTES, "independent trusted root")
            _require(expectation.get("trusted_root_sha256") == root_digest == retained_root_digest and expectation.get("trusted_root_bytes") == root_bytes == retained_root_bytes and expectation.get("trusted_root_version") == trusted_root_version, "trusted-root version, fingerprint, or retained snapshot does not match the verification expectation")
            identity = record["identity"]
            with tempfile.TemporaryDirectory(prefix="retained-verify-", dir=self.root) as directory_name:
                temporary = Path(directory_name)
                archive_path = temporary / identity["archive_name"]
                with ZipFile(path / "artifact-service.zip") as service:
                    _require(identity["archive_name"] in service.namelist(), "retained artifact is missing the authenticated archive")
                    with service.open(identity["archive_name"]) as source, archive_path.open("wb") as target:
                        remaining = provenance.MAX_ARCHIVE_BYTES
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                break
                            target.write(chunk)
                            remaining -= len(chunk)
                        _require(source.read(1) == b"", "retained archive exceeds the verification limit")
                actual_version = verifier_version or expectation.get("verifier_version", provenance.SUPPORTED_GH_VERSION)
                verified = provenance.run_gh_attestation_verify(archive_path, bundle=path / "attestation-bundle.json", repository=expectation["repository"], signer_workflow=expectation["signer_workflow"], signer_revision=expectation["signer_revision"], source_ref=expectation["source_ref"], source_sha=expectation["source_sha"], verifier_version=actual_version, custom_trusted_root=trusted_root, offline=True, repository_root=self.repository_root, excluded_roots=(self.repository_root, self.root))
                authenticated = provenance.validate_verified_result(verified, archive_name=identity["archive_name"], archive_digest=identity["archive_sha256"], archive_bytes=identity["archive_bytes"], expected=expectation, run_metadata=None, require_run_metadata=False)
                return authenticated.diagnostic_json()


def gc_command(publication_root: Path, repository_root: Path, *, execute: bool, max_deletions: int) -> dict[str, Any]:
    store = RetentionStore(publication_root, repository_root=repository_root)
    return store.garbage_collect(execute=execute, max_deletions=max_deletions)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="bounded durable artifact retention inventory and GC")
    parser.add_argument("--publication-root", required=True)
    parser.add_argument("--repository-root", required=True)
    parser.add_argument("--execute", action="store_true", help="execute the separately requested bounded deletion")
    parser.add_argument("--max-deletions", type=int, default=MAX_GC_DELETIONS)
    args = parser.parse_args()
    try:
        print(json.dumps(gc_command(Path(args.publication_root), Path(args.repository_root), execute=args.execute, max_deletions=args.max_deletions), sort_keys=True))
    except (RetentionError, OSError, ValueError) as error:
        print(f"[durable-artifact-retention] blocked: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
