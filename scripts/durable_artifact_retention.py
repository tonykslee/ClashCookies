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
RETENTION_VERSION = 2
LEGACY_RETENTION_VERSION = 1
STATE_FILENAME = "retention-state.json"
LOCK_FILENAME = ".artifact-retention.lock"
LEGACY_BASELINE_ID = "legacy-runtime-baseline"
LEGACY_BASELINE_METADATA_FILENAME = "legacy-runtime-baseline.json"
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
MAX_ACTIVATION_OPERATIONS = 8
ACTIVATION_PHASES = (
    "validated-intent",
    "authorization-consumption-pending",
    "authorization-consumed",
    "incumbent-stop-intent",
    "incumbent-stop-observed",
    "candidate-start-intent",
    "candidate-start-observed",
    "candidate-health-verified",
    "compensation-authorization-consumption-pending",
    "successful-activation",
    "rollback-intent",
    "rollback-observed",
    "successful-rollback",
    "recovery-required",
)
ACTIVATION_TERMINAL_PHASES = {"successful-activation", "successful-rollback"}
ACTIVATION_OBSERVED_PHASES = {"incumbent-stop-observed", "candidate-start-observed", "candidate-health-verified", "rollback-observed"}


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


def _mutable_directory(path: Path, label: str) -> None:
    """Validate a checkout boundary without applying private-custody rules."""
    _require(path.is_absolute(), f"{label} must be absolute")
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid(), f"{label} is not owner-controlled")


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
    try:
        raw = provenance._read_bounded_bytes(path, maximum, label)
        return json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, provenance.ProvenanceError) as error:
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
        "pointer_generation": 0,
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
        "activation_operations": {},
        "gc_transactions": {},
    }


def _validate_state(state: Any) -> dict[str, Any]:
    _require(isinstance(state, dict), "retention metadata must be an object")
    legacy_expected = {"contract", "version", "generation", "updated_at", "active_release", "previous_known_good_release", "legacy_baseline", "releases", "operations", "gc_transactions"}
    expected = legacy_expected | {"pointer_generation", "activation_operations"}
    if state.get("version") == LEGACY_RETENTION_VERSION and set(state) == legacy_expected:
        # This is a validated schema upgrade, not initialization: every v1
        # field is still checked below and the first mutating save publishes v2.
        state["version"] = RETENTION_VERSION
        state["pointer_generation"] = state["generation"]
        state["activation_operations"] = {}
    _require(set(state) == expected, "retention metadata has missing or unexpected fields")
    _require(state["contract"] == RETENTION_CONTRACT and state["version"] == RETENTION_VERSION, "retention metadata contract version is unsupported")
    _require(isinstance(state["generation"], int) and state["generation"] >= 0, "retention metadata generation is invalid")
    _require(isinstance(state["pointer_generation"], int) and state["pointer_generation"] >= 0, "retention pointer generation is invalid")
    _timestamp(state["updated_at"], "retention metadata updated_at")
    _require(isinstance(state["releases"], dict) and len(state["releases"]) <= MAX_RELEASES, "retention release table is invalid")
    _require(isinstance(state["operations"], dict) and len(state["operations"]) <= MAX_RELEASES, "retention operation table is invalid")
    _require(isinstance(state["activation_operations"], dict) and len(state["activation_operations"]) <= MAX_ACTIVATION_OPERATIONS, "retention activation-operation table is invalid")
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
        _require(isinstance(roles, list) and all(role in {"pending", "reserved", "in-flight", "prepared", "recovery-protected", "retired"} for role in roles) and len(set(roles)) == len(roles), "retention release roles are malformed")
        _timestamp(record["created_at"], "retention release created_at")
        _timestamp(record["retired_at"], "retention release retired_at", allow_none=True)
        if "retired" in roles:
            _require(record["retired_at"] is not None, "retired release is missing retired_at")
        else:
            _require(record["retired_at"] is None, "unretired release has retired_at")
        evidence = record["evidence"]
        _require(isinstance(evidence, dict) and "artifact-service.zip" in evidence and set(evidence).issubset({"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}), "retention evidence metadata is malformed")
        if identity["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
            _require({"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}.issubset(evidence), "candidate retention evidence is incomplete")
        for evidence_name, evidence_record in evidence.items():
            _require(isinstance(evidence_record, dict) and set(evidence_record) == {"sha256", "bytes"} and provenance.SHA256_RE.fullmatch(str(evidence_record["sha256"])) is not None and type(evidence_record["bytes"]) is int and evidence_record["bytes"] > 0, f"retention evidence record is malformed: {evidence_name}")
        reconciliation = record["reconciliation"]
        _require(isinstance(reconciliation, dict) and set(reconciliation) == {"authorization", "recovery"}, "retention reconciliation metadata is malformed")
        _require(reconciliation["authorization"] in {None, "released", "consumed", "expired", "not-applicable"}, "retention authorization reconciliation is malformed")
        _require(reconciliation["recovery"] in {None, "recovered", "abandoned", "not-applicable"}, "retention recovery reconciliation is malformed")
    for operation_id, operation in state["operations"].items():
        _require(isinstance(operation_id, str) and 0 < len(operation_id) <= 128 and isinstance(operation, dict), "retention in-flight operation is malformed")
        _require(set(operation) in ({"release_sha256", "kind", "started_at"}, {"release_sha256", "kind", "started_at", "phase", "metadata_sha256"}), "retention operation has unexpected fields")
        _require(operation["release_sha256"] in state["releases"], "retention operation references an unknown release")
        _require(isinstance(operation["kind"], str) and operation["kind"] != "", "retention operation kind is malformed")
        _timestamp(operation["started_at"], "retention operation started_at")
        phase = operation.get("phase", "started")
        _require(phase in {"started", "admission-approved", "legacy-published", "legacy-registered", "candidate-extracted", "candidate-published", "completed", "recovery-required"}, "retention operation phase is malformed")
        if "metadata_sha256" in operation:
            _require(operation["metadata_sha256"] is None or provenance.SHA256_RE.fullmatch(str(operation["metadata_sha256"])) is not None, "retention operation metadata digest is malformed")
        roles = state["releases"][operation["release_sha256"]]["roles"]
        if phase == "completed":
            _require(("prepared" in roles or "retired" in roles or operation["release_sha256"] in {state["active_release"], state["previous_known_good_release"]}) and "in-flight" not in roles, "completed preparation is not represented by a prepared release role")
        else:
            _require("in-flight" in roles, "retention operation is not represented by an in-flight release role")
        if phase == "recovery-required":
            _require("recovery-protected" in roles, "recovery-required operation is not recovery protected")
    unresolved_activation_count = 0
    for operation_id, operation in state["activation_operations"].items():
        _require(isinstance(operation_id, str) and 0 < len(operation_id) <= 128, "activation operation identity is malformed")
        required = {"contract", "version", "operation_id", "retry_key", "candidate_release", "preparation_metadata_sha256", "authorization_record_sha256", "authorization_id", "authorization_scope", "incumbent_release", "previous_known_good_release", "rollback_target", "rollback_kind", "rollback_authorization_record_sha256", "rollback_authorization_id", "rollback_retry_key", "expected_pointer_generation", "rollback_expected_pointer_generation", "forward_consumption", "rollback_consumption", "delivery_consumption", "runtime_identity_sha256", "phase", "intent", "observations", "started_at", "updated_at"}
        _require(isinstance(operation, dict) and set(operation) == required, "activation operation has missing or unexpected fields")
        _require(operation["contract"] == "clashcookies.durable-activation-transaction" and operation["version"] == 1, "activation operation contract version is unsupported")
        _require(operation["operation_id"] == operation_id and isinstance(operation["retry_key"], str) and 0 < len(operation["retry_key"]) <= 128, "activation operation identity is inconsistent")
        for field in ("candidate_release", "preparation_metadata_sha256", "authorization_record_sha256"):
            _require(isinstance(operation[field], str) and provenance.SHA256_RE.fullmatch(operation[field]) is not None, f"activation operation {field} is malformed")
        _require(isinstance(operation["authorization_id"], str) and operation["authorization_id"] != "", "activation authorization identity is malformed")
        _require(operation["authorization_scope"] == "activation-forward", "activation authorization scope is malformed")
        _require(operation["rollback_kind"] in {None, "compensation", "post-activation"}, "activation rollback kind is malformed")
        for field in ("rollback_authorization_record_sha256",):
            _require(operation[field] is None or (isinstance(operation[field], str) and provenance.SHA256_RE.fullmatch(operation[field]) is not None), f"activation operation {field} is malformed")
        for field in ("rollback_authorization_id", "rollback_retry_key"):
            _require(operation[field] is None or (isinstance(operation[field], str) and operation[field] != ""), f"activation operation {field} is malformed")
        rollback_fields = (operation["rollback_kind"], operation["rollback_authorization_record_sha256"], operation["rollback_authorization_id"], operation["rollback_retry_key"], operation["rollback_expected_pointer_generation"])
        _require((all(value is None for value in rollback_fields) or all(value is not None for value in rollback_fields)), "rollback authorization binding is incomplete")
        for field in ("incumbent_release", "previous_known_good_release", "rollback_target"):
            value = operation[field]
            _require(value is None or value == LEGACY_BASELINE_ID or (isinstance(value, str) and provenance.SHA256_RE.fullmatch(value) is not None), f"activation operation {field} is malformed")
        _require(type(operation["expected_pointer_generation"]) is int and operation["expected_pointer_generation"] >= 0, "activation expected pointer generation is malformed")
        _require(operation["rollback_expected_pointer_generation"] is None or (type(operation["rollback_expected_pointer_generation"]) is int and operation["rollback_expected_pointer_generation"] >= 0), "rollback pointer generation is malformed")
        for field in ("forward_consumption", "rollback_consumption", "delivery_consumption"):
            consumption = operation[field]
            required_consumption = {"operation_id", "candidate_release", "preparation_metadata_sha256", "record_sha256", "authorization_id", "retry_key", "scope", "state", "pointer_generation", "observed_at"}
            _require(consumption is None or (isinstance(consumption, dict) and set(consumption) == required_consumption), f"activation {field} evidence is malformed")
            if consumption is not None:
                _require(consumption["operation_id"] == operation_id and consumption["candidate_release"] == operation["candidate_release"] and consumption["preparation_metadata_sha256"] == operation["preparation_metadata_sha256"], f"activation {field} identity is inconsistent")
                expected_scope = "forward-release" if field == "delivery_consumption" else ("activation-forward" if field == "forward_consumption" else "activation-recovery")
                _require(consumption["state"] == "consumed" and consumption["scope"] == expected_scope, f"activation {field} state is invalid")
                if field == "forward_consumption":
                    _require(consumption["record_sha256"] == operation["authorization_record_sha256"] and consumption["authorization_id"] == operation["authorization_id"] and consumption["retry_key"] == operation["retry_key"], "forward activation consumption is not bound to its signed intent")
                if field == "rollback_consumption":
                    _require(operation["rollback_authorization_record_sha256"] is not None and consumption["record_sha256"] == operation["rollback_authorization_record_sha256"] and consumption["authorization_id"] == operation["rollback_authorization_id"] and consumption["retry_key"] == operation["rollback_retry_key"], "rollback consumption is not bound to its signed intent")
                _require(provenance.SHA256_RE.fullmatch(str(consumption["record_sha256"])) is not None and type(consumption["pointer_generation"]) is int and consumption["pointer_generation"] >= 0, f"activation {field} digest or generation is invalid")
                expected_consumption_generation = operation["expected_pointer_generation"] if field in {"forward_consumption", "delivery_consumption"} else operation["rollback_expected_pointer_generation"]
                _require(consumption["pointer_generation"] == expected_consumption_generation, f"activation {field} generation is not bound to the exact transaction phase")
                _timestamp(consumption["observed_at"], f"activation {field} observed_at")
        _require(isinstance(operation["runtime_identity_sha256"], str) and provenance.SHA256_RE.fullmatch(operation["runtime_identity_sha256"]) is not None and operation["runtime_identity_sha256"] == operation["candidate_release"], "activation runtime identity is malformed")
        _require(operation["phase"] in ACTIVATION_PHASES, "activation operation phase is malformed")
        _timestamp(operation["started_at"], "activation operation started_at")
        _timestamp(operation["updated_at"], "activation operation updated_at")
        _require(isinstance(operation["intent"], dict) and operation["intent"].get("candidate_release") == operation["candidate_release"] and operation["intent"].get("operation_id") == operation_id, "activation intent evidence is malformed")
        intent = operation["intent"]
        intent_fields = {"contract", "version", "operation_id", "retry_key", "candidate_release", "preparation_metadata_sha256", "authorization_record_sha256", "incumbent_release", "previous_known_good_release", "rollback_target", "expected_pointer_generation"}
        _require(set(intent).issubset(intent_fields | {"recovery_phase"}) and intent_fields.issubset(intent), "activation intent evidence is incomplete")
        for field in intent_fields - {"contract", "version"}:
            _require(intent[field] == operation[field], f"activation intent binding conflicts on {field}")
        _require(intent["contract"] == "clashcookies.durable-activation-intent" and intent["version"] == 1, "activation intent contract is malformed")
        if operation["phase"] == "recovery-required":
            _require(intent.get("recovery_phase") in ACTIVATION_PHASES and intent.get("recovery_phase") != "recovery-required", "recovery-required activation lacks an exact resume phase")
        else:
            _require("recovery_phase" not in intent, "recovery resume evidence is present outside recovery-required")
        _require(isinstance(operation["observations"], dict), "activation observations are malformed")
        if operation["phase"] not in ACTIVATION_TERMINAL_PHASES:
            unresolved_activation_count += 1
        if operation["phase"] in ACTIVATION_OBSERVED_PHASES:
            observation = operation["observations"].get(operation["phase"])
            observation_fields = {"contract", "version", "source", "phase", "outcome", "operation_id", "candidate_release", "runtime_identity_sha256", "subject", "subject_release", "details"}
            _require(isinstance(observation, dict) and observation_fields.issubset(observation) and observation.get("contract") == "clashcookies.activation-observation" and observation.get("version") == 1 and observation.get("source") == "isolated-test-harness" and isinstance(observation.get("subject"), str) and isinstance(observation.get("subject_release"), (str, type(None))), "activation observed outcome evidence is missing")
            expected_subject = {"incumbent-stop-observed": "incumbent", "candidate-start-observed": "candidate", "candidate-health-verified": "candidate", "rollback-observed": "rollback-target"}[operation["phase"]]
            expected_release = operation["candidate_release"] if expected_subject == "candidate" else (operation["incumbent_release"] or LEGACY_BASELINE_ID if expected_subject == "incumbent" else operation["rollback_target"])
            _require(observation["phase"] == operation["phase"] and observation["operation_id"] == operation_id and observation["candidate_release"] == operation["candidate_release"] and observation["runtime_identity_sha256"] == operation["runtime_identity_sha256"], "activation observed outcome is not bound to the exact transaction")
            _require(observation["subject"] == expected_subject and observation["subject_release"] == expected_release, "activation observed outcome subject is not the exact transaction target")
            _require(isinstance(observation.get("outcome"), str) and observation["outcome"] in {"stopped", "started", "healthy", "failed", "unhealthy", "uncertain"}, "activation observed outcome is unsupported")
        phase = operation["phase"]
        if phase in {"incumbent-stop-intent", "incumbent-stop-observed", "candidate-start-intent", "candidate-start-observed", "candidate-health-verified", "successful-activation"}:
            _require(operation["forward_consumption"] is not None and operation["delivery_consumption"] is not None, "forward disruption requires exact activation and delivery consumption")
        if phase in {"candidate-start-intent", "candidate-start-observed", "candidate-health-verified", "successful-activation"}:
            _require(operation["observations"].get("incumbent-stop-observed", {}).get("outcome") == "stopped", "candidate progression requires a stopped incumbent")
        if phase in {"candidate-health-verified", "successful-activation"}:
            _require(operation["observations"].get("candidate-start-observed", {}).get("outcome") == "started", "candidate health requires a started candidate")
        if phase == "successful-activation":
            _require(operation["observations"].get("candidate-health-verified", {}).get("outcome") == "healthy", "activation commit requires healthy candidate evidence")
        if phase in {"rollback-intent", "rollback-observed", "successful-rollback"}:
            _require(operation["rollback_consumption"] is not None, "rollback phase requires exact recovery consumption")
        if phase == "rollback-observed":
            _require(isinstance(operation["observations"].get("rollback-observed"), dict), "rollback observation is missing")
        if phase == "successful-rollback":
            _require(operation["observations"].get("rollback-observed", {}).get("outcome") == "healthy", "rollback commit requires healthy target evidence")
        for release_id in (operation["candidate_release"], operation["incumbent_release"], operation["previous_known_good_release"], operation["rollback_target"]):
            if release_id not in (None, LEGACY_BASELINE_ID):
                _require(release_id in state["releases"], "activation operation references an unknown release")
        candidate = state["releases"].get(operation["candidate_release"])
        _require(candidate is not None, "activation candidate is unknown")
        if operation["phase"] not in ACTIVATION_TERMINAL_PHASES:
            _require("recovery-protected" in candidate["roles"] or operation["candidate_release"] in {state["active_release"], state["previous_known_good_release"]}, "unresolved activation candidate is not protected")
    _require(unresolved_activation_count <= 1, "multiple unresolved activation transactions are ambiguous")
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


_AUTHORITY_TOKEN = object()


@dataclass(frozen=True)
class _ActivationAuthority:
    """Opaque journal-derived authority; dictionaries are never transition authority."""

    operation_id: str
    candidate_release: str
    preparation_metadata_sha256: str
    record_sha256: str
    authorization_id: str
    retry_key: str
    scope: str
    state: str
    pointer_generation: int
    observed_at: str
    _token: object


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
    entry_count = 0
    for child in publication_root.iterdir():
        entry_count += 1
        _require(entry_count <= MAX_INVENTORY_ENTRIES, "retained storage inventory exceeds its bound")
        if not child.is_dir() or child.is_symlink() or not child.name.startswith("release-"):
            continue
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
        _mutable_directory(repository_root, "repository root")
        try:
            publication_root.resolve().relative_to(repository_root.resolve())
        except ValueError:
            pass
        else:
            _fail("publication root must be outside the mutable checkout")
        self.state_path = publication_root / STATE_FILENAME
        self.legacy_baseline_path = publication_root / LEGACY_BASELINE_METADATA_FILENAME

    def load(self) -> dict[str, Any]:
        if not self.state_path.exists():
            _fail("retention metadata is missing; explicit initialization is required")
        state = _read_json(self.state_path, MAX_STATE_BYTES, "retention metadata")
        state = _validate_state(state)
        self._validate_delivery_evidence(state)
        return state

    def _reestablish_state_durability(self) -> None:
        """Re-fsync the validated state and its directory under the caller lock."""
        self.load()
        descriptor = None
        try:
            descriptor = os.open(self.state_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            os.fsync(descriptor)
        except OSError as error:
            _fail(f"retention state fsync failed: {error}")
        finally:
            if descriptor is not None:
                os.close(descriptor)
        _fsync_directory(self.root, required=self.require_durable)

    def _validate_delivery_evidence(self, state: dict[str, Any]) -> None:
        """Bind recorded delivery consumption to the retained signed record."""
        for operation in state["activation_operations"].values():
            evidence = operation["delivery_consumption"]
            if evidence is None:
                continue
            envelope_path = self.root / f"release-{operation['candidate_release']}" / "authorization-envelope.json"
            envelope = _read_json(envelope_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "retained delivery authorization")
            record = envelope.get("record") if isinstance(envelope, dict) else None
            authorization = record.get("authorization") if isinstance(record, dict) else None
            _require(isinstance(record, dict) and isinstance(authorization, dict), "retained delivery authorization evidence is malformed")
            record_sha256 = hashlib.sha256(provenance._canonical_json(record)).hexdigest()
            _require(evidence["record_sha256"] == record_sha256 and evidence["authorization_id"] == authorization.get("authorization_id") and evidence["retry_key"] == authorization.get("retry_key") and evidence["scope"] == authorization.get("scope") == "forward-release", "delivery consumption is not bound to the retained signed record")

    def legacy_baseline_status(self) -> dict[str, Any]:
        """Return durable legacy custody, preserving the v1 placeholder contract.

        The original retention state intentionally contains only an
        unauthenticated placeholder.  A real legacy capture is recorded in a
        separate, identity-bound file so loading or upgrading v1 state can
        never silently adopt or replace runtime material.
        """
        if not self.legacy_baseline_path.exists():
            return {
                "id": LEGACY_BASELINE_ID,
                "authenticated": False,
                "protected": True,
                "status": "placeholder",
            }
        record = _read_json(self.legacy_baseline_path, MAX_STATE_BYTES, "legacy baseline metadata")
        _require(isinstance(record, dict), "legacy baseline metadata is malformed")
        required = {"contract", "version", "id", "authenticated", "protected", "status", "runtime_path", "integrity", "identity"}
        _require(set(record) == required, "legacy baseline metadata has missing or unexpected fields")
        _require(record["contract"] == "clashcookies.legacy-runtime-baseline" and record["version"] == 1, "legacy baseline metadata contract is unsupported")
        _require(record["id"] == LEGACY_BASELINE_ID and record["authenticated"] is False and record["protected"] is True and record["status"] == "preserved-verified", "legacy baseline metadata is not an unauthenticated protected capture")
        _require(isinstance(record["runtime_path"], str) and Path(record["runtime_path"]).is_absolute(), "legacy baseline runtime path is malformed")
        _require(isinstance(record["identity"], dict) and record["identity"], "legacy baseline identity is missing")
        integrity = record["integrity"]
        _require(isinstance(integrity, dict) and set(integrity) == {"tree_sha256", "bytes", "entries"} and provenance.SHA256_RE.fullmatch(str(integrity["tree_sha256"])) is not None and type(integrity["bytes"]) is int and integrity["bytes"] > 0 and type(integrity["entries"]) is int and integrity["entries"] > 0, "legacy baseline integrity is malformed")
        runtime = Path(record["runtime_path"])
        for base in (self.root, self.repository_root):
            try:
                runtime.resolve().relative_to(base.resolve())
            except ValueError:
                continue
            _fail("preserved legacy runtime must be outside retention and checkout roots")
        _safe_directory(runtime, "preserved legacy runtime")
        return record

    def register_legacy_baseline(self, record: dict[str, Any], *, assume_locked: bool = False) -> dict[str, Any]:
        """Publish the first real legacy baseline without replacement.

        This metadata is deliberately outside the release table and remains
        unauthenticated.  A conflicting existing capture is always rejected.
        """
        _require(isinstance(record, dict), "legacy baseline record is malformed")
        expected = {"contract", "version", "id", "authenticated", "protected", "status", "runtime_path", "integrity", "identity"}
        _require(set(record) == expected, "legacy baseline record has missing or unexpected fields")
        _require(record["id"] == LEGACY_BASELINE_ID and record["authenticated"] is False and record["protected"] is True and record["status"] == "preserved-verified", "legacy baseline record must remain unauthenticated and protected")
        runtime = Path(record["runtime_path"])
        for base in (self.root, self.repository_root):
            try:
                runtime.resolve().relative_to(base.resolve())
            except ValueError:
                continue
            _fail("preserved legacy runtime must be outside retention and checkout roots")
        _safe_directory(runtime, "preserved legacy runtime")
        payload = _canonical(record) + b"\n"

        def apply() -> dict[str, Any]:
            if self.legacy_baseline_path.exists():
                existing = self.legacy_baseline_status()
                _require(existing == record, "existing legacy baseline conflicts with the requested capture")
                return existing
            temporary = self.root / f".{LEGACY_BASELINE_METADATA_FILENAME}.tmp-{os.getpid()}-{time.time_ns()}"
            descriptor = None
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                written = 0
                while written < len(payload):
                    written += os.write(descriptor, payload[written:])
                os.fsync(descriptor)
                os.close(descriptor)
                descriptor = None
                try:
                    if os.name == "posix":
                        os.link(temporary, self.legacy_baseline_path)
                        temporary.unlink(missing_ok=True)
                    else:
                        if self.legacy_baseline_path.exists():
                            _fail("legacy baseline appeared during publication")
                        os.rename(temporary, self.legacy_baseline_path)
                except FileExistsError:
                    temporary.unlink(missing_ok=True)
                    existing = self.legacy_baseline_status()
                    _require(existing == record, "existing legacy baseline conflicts with the requested capture")
                    return existing
                _fsync_directory(self.root, required=self.require_durable)
                return record
            except OSError as error:
                _fail(f"legacy baseline metadata publication failed: {error}")
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                temporary.unlink(missing_ok=True)

        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

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
        _require(len(payload) <= MAX_STATE_BYTES, "retention metadata exceeds its serialized size limit")
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

    def register_delivery(self, identity: dict[str, Any], publication: Path, *, authorization_envelope: Any = None, authorization_journal: Any = None, authorization_revision_allowlist: Any = None, authorization_trust: Any = None, authorization_operation: str | None = None, assume_locked: bool = False, excluded_roots: tuple[Path, ...] = (), allow_synthetic_test: bool = False) -> None:
        _strict_identity(identity)
        digest = identity_digest(identity)
        _require(publication.parent == self.root and publication.name == f"release-{digest}", "retention publication is not exact identity-owned path")
        _require(publication.is_dir() and not publication.is_symlink(), "retention publication is missing")
        evidence: dict[str, Any] = {}
        for name in ("artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"):
            path = publication / name
            if path.exists():
                evidence[name] = _file_evidence(path, MAX_EVIDENCE_BYTES if name != "artifact-service.zip" else provenance.MAX_ARTIFACT_BYTES, f"retained {name}")
        _require("artifact-service.zip" in evidence, "retained publication is missing the original artifact-service ZIP")
        _require(evidence["artifact-service.zip"] == {"sha256": identity["artifact_service_zip_sha256"], "bytes": identity["artifact_service_zip_bytes"]}, "retained artifact does not match the immutable release identity")
        release_path = publication
        verification_names = {"attestation-bundle.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
        if "attestation-bundle.json" in evidence:
            _require(verification_names.issubset(evidence), "attested retention requires independently retained expectation, receipt, and trust root")
            expectation = _read_json(publication / "verification-expectation.json", MAX_EVIDENCE_BYTES, "verification expectation")
            receipt = _read_json(publication / "verification-receipt.json", MAX_EVIDENCE_BYTES, "verification receipt")
            _require(isinstance(expectation, dict) and expectation.get("contract") == "clashcookies.retained-verification-expectation" and expectation.get("version") == 1 and expectation.get("identity_sha256") == digest, "verification expectation is not bound to the immutable identity")
            _require(isinstance(receipt, dict) and receipt.get("status") == "verified-provenance-only" and receipt.get("authenticated") is True, "verification receipt is not authenticated provenance evidence")
            if receipt.get("synthetic") is True:
                _require(allow_synthetic_test is True and receipt.get("source") == "isolated-test-harness", "synthetic diagnostic receipt cannot establish operational candidate custody")
            else:
                _require("synthetic" not in receipt, "synthetic diagnostic receipt cannot establish operational candidate custody")
            root_digest, root_bytes = provenance._sha256_file(publication / "trusted-root.jsonl", provenance.MAX_BUNDLE_BYTES, "retained trusted root")
            _require(expectation.get("trusted_root_sha256") == root_digest and expectation.get("trusted_root_bytes") == root_bytes, "retained trust root is not bound to the verification expectation")
        if identity["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
            required_candidate = {"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
            _require(required_candidate.issubset(evidence), "candidate retention evidence is incomplete")
            context_path = publication / "independent-verification-context.json"
            context = _read_json(context_path, MAX_EVIDENCE_BYTES, "independent candidate verification context")
            context_raw = context_path.read_bytes()
            _require(context_raw == provenance._canonical_json(context) + b"\n", "independent candidate verification context is not canonical")
            try:
                candidate_identity = provenance.TrustedReleaseIdentity(**identity)
                provenance.validate_candidate_verification_context(context, candidate_identity)
            except (TypeError, provenance.ProvenanceError) as error:
                _fail(f"independent candidate verification context is invalid: {error}")
            authorization_path = publication / "authorization-envelope.json"
            authorization = _read_json(authorization_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "authorization envelope")
            _require(authorization_path.read_bytes() == provenance._canonical_json(authorization) + b"\n", "authorization envelope is not canonical")
            _require(authorization_envelope is not None and provenance._canonical_json(authorization_envelope) + b"\n" == authorization_path.read_bytes(), "candidate retention envelope does not exactly match the retained envelope")
            context_digest = hashlib.sha256(context_raw).hexdigest()
            record = authorization.get("record") if isinstance(authorization, dict) else None
            lifecycle = record.get("authorization") if isinstance(record, dict) else None
            _require(isinstance(lifecycle, dict) and lifecycle.get("context") == provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT and lifecycle.get("destination") == str(self.root) and lifecycle.get("verification_context_sha256") == context_digest, "candidate authorization is not bound to retained verification context and destination")
            _require(authorization_envelope is not None and authorization_journal is not None and authorization_revision_allowlist is not None and authorization_trust is not None and authorization_operation == "forward-release", "candidate retention requires the exact authorization and durable replay reservation")
            try:
                authorization_journal.assert_reserved(authorization_envelope, provenance.TrustedReleaseIdentity(**identity), authorization_revision_allowlist, authorization_trust, operation=authorization_operation)
            except (TypeError, provenance.ProvenanceError) as error:
                _fail(f"candidate retention replay reservation is invalid: {error}")
        else:
            _require(authorization_envelope is None and authorization_journal is None and authorization_revision_allowlist is None and authorization_trust is None and authorization_operation is None, "development retention cannot carry candidate authorization custody")
        roles = ["pending"] + (["reserved"] if identity["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS else [])
        def apply() -> None:
            state = self.load()
            existing = state["releases"].get(digest)
            if existing is None:
                self._record(state, identity, publication.name, evidence, roles)
                self._save(state)
                return
            _require(existing["identity"] == identity and existing["evidence"] == evidence, "retention retry has conflicting release or evidence metadata")
            _require("retired" not in existing["roles"], "retired release cannot be silently reactivated")
            _require(set(existing["roles"]) <= set(roles) | {"prepared", "in-flight", "recovery-protected"}, "retention retry has conflicting authorization custody state")
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    def mark_operation(self, operation_id: str, identity_sha256: str, *, kind: str, phase: str | None = None, metadata_sha256: str | None = None, recovery_required: bool = False, assume_locked: bool = False) -> None:
        _require(0 < len(operation_id) <= 128 and isinstance(kind, str) and kind != "", "retention operation reference is invalid")
        def apply() -> None:
            state = self.load()
            _require(identity_sha256 in state["releases"], "retention operation reference is invalid")
            existing = state["operations"].get(operation_id)
            if existing is not None:
                _require(existing["release_sha256"] == identity_sha256 and existing["kind"] == kind, "retention operation already exists with conflicting ownership")
                if existing.get("phase") == "completed":
                    _require(phase in {None, "admission-approved", "completed"}, "completed retention operation cannot be restarted")
                    return
                record = state["releases"][identity_sha256]
                changed = False
                if "in-flight" not in record["roles"]:
                    record["roles"].append("in-flight")
                    changed = True
                if recovery_required and "recovery-protected" not in record["roles"]:
                    record["roles"].append("recovery-protected")
                    changed = True
                if changed:
                    self._save(state)
                return
            operation = {"release_sha256": identity_sha256, "kind": kind, "started_at": _now()}
            if phase is not None:
                _require(phase != "completed", "a new retention operation cannot start completed")
                operation.update({"phase": phase, "metadata_sha256": metadata_sha256})
            state["operations"][operation_id] = operation
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

    def update_operation(self, operation_id: str, *, phase: str, metadata_sha256: str | None = None, assume_locked: bool = False) -> None:
        """Advance a preparation phase while retaining durable custody protection."""
        _require(phase in {"started", "admission-approved", "legacy-published", "legacy-registered", "candidate-extracted", "candidate-published", "completed", "recovery-required"}, "retention operation phase is invalid")
        _require(metadata_sha256 is None or provenance.SHA256_RE.fullmatch(metadata_sha256) is not None, "retention operation metadata digest is invalid")
        def apply() -> None:
            state = self.load()
            operation = state["operations"].get(operation_id)
            _require(operation is not None, "retention operation is unknown")
            current_phase = operation.get("phase", "started")
            order = {"started": 0, "admission-approved": 1, "legacy-published": 2, "legacy-registered": 3, "candidate-extracted": 4, "candidate-published": 5, "completed": 6, "recovery-required": 99}
            _require(current_phase == "recovery-required" or phase == "recovery-required" or order[phase] >= order[current_phase], "retention operation phase cannot move backward")
            preserved_metadata_sha256 = operation.get("metadata_sha256") if metadata_sha256 is None else metadata_sha256
            operation.update({"phase": phase, "metadata_sha256": preserved_metadata_sha256})
            record = state["releases"][operation["release_sha256"]]
            if phase == "completed":
                record["roles"] = [role for role in record["roles"] if role not in {"in-flight", "recovery-protected"}]
                if "prepared" not in record["roles"]:
                    record["roles"].append("prepared")
            else:
                if "in-flight" not in record["roles"]:
                    record["roles"].append("in-flight")
                if phase == "recovery-required" and "recovery-protected" not in record["roles"]:
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
            _require(all(operation["release_sha256"] != identity_sha256 or operation.get("phase", "started") == "completed" for operation in state["operations"].values()), "in-flight release cannot be retired")
            record = state["releases"][identity_sha256]
            _require(not (set(record["roles"]) & {"pending", "reserved", "in-flight", "prepared", "recovery-protected"}), "release protection requires actual authorization or recovery reconciliation before retirement")
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
            record["roles"] = [role for role in record["roles"] if role not in {"pending", "reserved", "retired"}]
            _require(set(record["roles"]) <= {"in-flight", "prepared", "recovery-protected"}, "retained authorization has an unexpected lifecycle role")
            if "recovery-protected" not in record["roles"]:
                record["roles"].append("recovery-protected")
            record["retired_at"] = None
            record["reconciliation"]["authorization"] = "consumed"
            self._save(state)
        if assume_locked:
            apply()
        else:
            with activity_lock(self.root):
                apply()

    @staticmethod
    def _authority_from_replay_entry(entry: dict[str, Any], *, operation_id: str, candidate_release: str, preparation_metadata_sha256: str, pointer_generation: int, expected_scope: str, expected_state: str, expected_record_sha256: str, expected_authorization_id: str, expected_retry_key: str, journal_identity_sha256: str | None = None) -> _ActivationAuthority:
        _require(isinstance(entry, dict) and entry.get("state") == expected_state, "activation replay state does not establish the requested authority")
        expected = {"record_sha256": expected_record_sha256, "authorization_id": expected_authorization_id, "retry_key": expected_retry_key, "scope": expected_scope}
        if journal_identity_sha256 is not None:
            expected["identity_sha256"] = journal_identity_sha256
        for field, value in expected.items():
            _require(entry.get(field) == value, f"activation replay evidence conflicts on {field}")
        # Replay entries predating an explicit observed-at field still carry
        # stable signed timestamps.  Never synthesize a new wall-clock value
        # on each retry: doing so would make exact delivery reconciliation
        # conflict with its own durable evidence.
        observed_at = entry.get("observed_at") or entry.get("issued_at")
        return _ActivationAuthority(operation_id, candidate_release, preparation_metadata_sha256, expected_record_sha256, expected_authorization_id, expected_retry_key, expected_scope, expected_state, pointer_generation, str(observed_at or _now()), _AUTHORITY_TOKEN)

    @staticmethod
    def _validate_activation_authority(authority: _ActivationAuthority, *, operation_id: str, candidate_release: str, preparation_metadata_sha256: str, record_sha256: str, authorization_id: str, retry_key: str, scope: str, state: str, pointer_generation: int) -> None:
        _require(isinstance(authority, _ActivationAuthority) and authority._token is _AUTHORITY_TOKEN, "activation authority must come from the replay journal")
        expected = {"operation_id": operation_id, "candidate_release": candidate_release, "preparation_metadata_sha256": preparation_metadata_sha256, "record_sha256": record_sha256, "authorization_id": authorization_id, "retry_key": retry_key, "scope": scope, "state": state, "pointer_generation": pointer_generation}
        for field, value in expected.items():
            _require(getattr(authority, field) == value, f"activation authority conflicts on {field}")
        _require(provenance.SHA256_RE.fullmatch(record_sha256 or "") is not None and scope in {"activation-forward", "activation-recovery", "forward-release"} and state in {"reserved", "consumed"}, "activation authority is invalid")
        _timestamp(authority.observed_at, "activation authority observed_at")

    def _authority_from_journal(self, *, operation_id: str, candidate_release: str, preparation_metadata_sha256: str, pointer_generation: int, journal: Any, operation: str, envelope: Any | None = None, identity: Any | None = None, revision_allowlist: Any | None = None, trust: Any | None = None, record_sha256: str, authorization_id: str, retry_key: str, scope: str, state: str, now: Any = None, historical: bool = False, assume_locked: bool = False) -> _ActivationAuthority:
        def read() -> _ActivationAuthority:
            if envelope is not None:
                _require(identity is not None and revision_allowlist is not None and trust is not None, "signed replay inputs are incomplete")
                entry = journal.inspect(envelope, identity, revision_allowlist, trust, operation=operation, allow_consumed=(state == "consumed"), now=now)
            else:
                _require(state == "consumed", "historical replay reconciliation requires a consumed record")
                # The replay journal stores the provenance identity fingerprint,
                # not the retention release digest.  The exact release/runtime
                # binding is checked by the durable activation operation fields;
                # the journal record itself is still matched byte-for-byte by
                # authorization ID, record digest, retry key, scope, and op.
                entry = journal.inspect_consumed_record(authorization_id, record_sha256=record_sha256, retry_key=retry_key, scope=scope, operation=operation)
            journal_identity = provenance._identity_fingerprint(identity) if envelope is not None and identity is not None else None
            return self._authority_from_replay_entry(entry, operation_id=operation_id, candidate_release=candidate_release, preparation_metadata_sha256=preparation_metadata_sha256, pointer_generation=pointer_generation, expected_scope=scope, expected_state=state, expected_record_sha256=record_sha256, expected_authorization_id=authorization_id, expected_retry_key=retry_key, journal_identity_sha256=journal_identity)
        if assume_locked:
            return read()
        with activity_lock(self.root):
            return read()

    def begin_activation(self, *, operation_id: str, retry_key: str, candidate_release: str, preparation_metadata_sha256: str, authorization_record_sha256: str, authorization_id: str, authorization_scope: str, rollback_target: str | None, expected_pointer_generation: int, authority: _ActivationAuthority, assume_locked: bool = False) -> dict[str, Any]:
        """Persist one exact activation intent and protect all referenced material.

        This is the retention-owned activation transaction boundary.  It does
        not inspect or control Docker and it never consumes authorization.
        """
        _require(isinstance(operation_id, str) and 0 < len(operation_id) <= 128, "activation operation identity is invalid")
        _require(isinstance(retry_key, str) and 0 < len(retry_key) <= 128, "activation retry key is invalid")
        for value, label in ((candidate_release, "activation candidate release"), (preparation_metadata_sha256, "preparation metadata digest"), (authorization_record_sha256, "authorization record digest")):
            _require(isinstance(value, str) and provenance.SHA256_RE.fullmatch(value) is not None, f"{label} is invalid")
        _require(isinstance(authorization_id, str) and authorization_id != "", "activation authorization ID is invalid")
        _require(authorization_scope == "activation-forward", "activation intent requires forward activation authority")
        _require(rollback_target is None or rollback_target == LEGACY_BASELINE_ID or provenance.SHA256_RE.fullmatch(str(rollback_target)) is not None, "activation rollback target is invalid")
        _require(type(expected_pointer_generation) is int and expected_pointer_generation >= 0, "activation pointer generation is invalid")

        def apply() -> dict[str, Any]:
            state = self.load()
            self._validate_activation_authority(authority, operation_id=operation_id, candidate_release=candidate_release, preparation_metadata_sha256=preparation_metadata_sha256, record_sha256=authorization_record_sha256, authorization_id=authorization_id, retry_key=retry_key, scope=authorization_scope, state="reserved", pointer_generation=expected_pointer_generation)
            existing = state["activation_operations"].get(operation_id)
            if existing is not None:
                expected = {
                    "retry_key": retry_key, "candidate_release": candidate_release,
                    "preparation_metadata_sha256": preparation_metadata_sha256,
                    "authorization_record_sha256": authorization_record_sha256,
                    "authorization_id": authorization_id, "authorization_scope": authorization_scope,
                    "incumbent_release": state["active_release"],
                    "previous_known_good_release": state["previous_known_good_release"],
                    "rollback_target": rollback_target,
                    "expected_pointer_generation": expected_pointer_generation,
                }
                for field, value in expected.items():
                    _require(existing.get(field) == value, "activation retry has conflicting ownership")
                _require(existing.get("phase") not in ACTIVATION_TERMINAL_PHASES, "terminal activation cannot be restarted as a fresh deployment")
                self._reestablish_state_durability()
                return existing
            unresolved = [item for item in state["activation_operations"].values() if item["phase"] not in ACTIVATION_TERMINAL_PHASES]
            _require(not unresolved, "another activation transaction is unresolved")
            if len(state["activation_operations"]) >= MAX_ACTIVATION_OPERATIONS:
                _fail("activation operation history capacity is exhausted; explicit history retirement is required")
            _require(expected_pointer_generation == state["pointer_generation"], "activation pointer generation is stale")
            candidate = state["releases"].get(candidate_release)
            _require(candidate is not None, "activation candidate is unknown")
            _require(candidate["identity"]["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "development artifact cannot be activated")
            _require("prepared" in candidate["roles"], "activation candidate is not a completed preparation")
            preparation_operations = [item for item in state["operations"].values() if item["release_sha256"] == candidate_release and item["kind"] == "immutable-runtime-preparation" and item.get("phase") == "completed" and item.get("metadata_sha256") == preparation_metadata_sha256]
            _require(len(preparation_operations) == 1, "exact completed preparation record is missing or ambiguous")
            _require(state["active_release"] != candidate_release and state["previous_known_good_release"] != candidate_release, "activation candidate is already a pointer")
            expected_rollback_target = state["active_release"] if state["active_release"] is not None else LEGACY_BASELINE_ID
            _require(rollback_target == expected_rollback_target, "rollback target must be the actual incumbent")
            now = _now()
            operation = {
                "contract": "clashcookies.durable-activation-transaction", "version": 1,
                "operation_id": operation_id, "retry_key": retry_key,
                "candidate_release": candidate_release, "preparation_metadata_sha256": preparation_metadata_sha256,
                "authorization_record_sha256": authorization_record_sha256, "authorization_id": authorization_id,
                "authorization_scope": authorization_scope, "incumbent_release": state["active_release"],
                "previous_known_good_release": state["previous_known_good_release"], "rollback_target": rollback_target,
                "rollback_kind": None, "rollback_authorization_record_sha256": None, "rollback_authorization_id": None, "rollback_retry_key": None,
                "expected_pointer_generation": expected_pointer_generation, "rollback_expected_pointer_generation": None,
                "forward_consumption": None, "rollback_consumption": None, "delivery_consumption": None, "runtime_identity_sha256": candidate_release,
                "phase": "validated-intent",
                "intent": {"contract": "clashcookies.durable-activation-intent", "version": 1, "operation_id": operation_id, "retry_key": retry_key, "candidate_release": candidate_release, "preparation_metadata_sha256": preparation_metadata_sha256, "authorization_record_sha256": authorization_record_sha256, "incumbent_release": state["active_release"], "previous_known_good_release": state["previous_known_good_release"], "rollback_target": rollback_target, "expected_pointer_generation": expected_pointer_generation},
                "observations": {}, "started_at": now, "updated_at": now,
            }
            state["activation_operations"][operation_id] = operation
            for release_id in (candidate_release, rollback_target):
                if release_id not in (None, LEGACY_BASELINE_ID) and release_id not in {state["active_release"], state["previous_known_good_release"]}:
                    record = state["releases"][release_id]
                    if "recovery-protected" not in record["roles"]:
                        record["roles"].append("recovery-protected")
            self._save(state)
            return operation
        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

    def transition_activation(self, operation_id: str, *, phase: str, observation: dict[str, Any] | None = None, expected_phase: str | None = None, authority: _ActivationAuthority | None = None, assume_locked: bool = False) -> dict[str, Any]:
        """Advance one activation transaction with strict compare-and-transition semantics."""
        _require(phase in ACTIVATION_PHASES, "activation phase is invalid")
        if phase in ACTIVATION_OBSERVED_PHASES:
            _require(isinstance(observation, dict) and observation.get("contract") == "clashcookies.activation-observation" and observation.get("version") == 1 and observation.get("source") == "isolated-test-harness", "observed runtime outcomes require the isolated non-operational test boundary")

        def apply() -> dict[str, Any]:
            state = self.load()
            operation = state["activation_operations"].get(operation_id)
            _require(operation is not None, "activation operation is unknown")
            _require(authority is not None, "activation transitions require replay-derived authority")
            recovery_phases = {"compensation-authorization-consumption-pending", "rollback-intent", "rollback-observed", "successful-rollback"}
            recovery_resume = operation["intent"].get("recovery_phase") if operation["phase"] == "recovery-required" else None
            recovery_phase = phase in recovery_phases or operation["phase"] in recovery_phases or recovery_resume in recovery_phases
            proof_scope = "activation-recovery" if recovery_phase else "activation-forward"
            proof_state = "reserved" if phase in {"authorization-consumption-pending", "compensation-authorization-consumption-pending"} else "consumed"
            proof_record = operation["rollback_authorization_record_sha256"] if recovery_phase else operation["authorization_record_sha256"]
            proof_auth_id = operation["rollback_authorization_id"] if recovery_phase else operation["authorization_id"]
            proof_retry = operation["rollback_retry_key"] if recovery_phase else operation["retry_key"]
            proof_generation = operation["rollback_expected_pointer_generation"] if recovery_phase and operation["rollback_expected_pointer_generation"] is not None else operation["expected_pointer_generation"]
            _require(proof_record is not None and proof_auth_id is not None and proof_retry is not None, "activation transition lacks its exact authorization binding")
            accepted_state = proof_state
            if phase in {"authorization-consumption-pending", "recovery-required"} and operation["phase"] in {"validated-intent", "authorization-consumption-pending"} and not recovery_phase:
                accepted_state = authority.state
            if phase == "recovery-required" and authority.state in {"reserved", "consumed"}:
                accepted_state = authority.state
            if phase == "compensation-authorization-consumption-pending" and operation["phase"] == "recovery-required" and authority.state == "consumed":
                # A crash may leave the replay journal consumed while the
                # recovery-required retention transition was not published.
                # Resuming the exact bound authority is reconciliation, not a
                # new authorization.
                accepted_state = "consumed"
            self._validate_activation_authority(authority, operation_id=operation_id, candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], record_sha256=proof_record, authorization_id=proof_auth_id, retry_key=proof_retry, scope=proof_scope, state=accepted_state, pointer_generation=proof_generation)
            current = operation["phase"]
            if expected_phase is not None:
                _require(current == expected_phase, "activation compare phase is stale")
            if current == phase:
                if observation is not None:
                    _require(operation["observations"].get(phase) == observation, "activation retry has conflicting observed evidence")
                self._reestablish_state_durability()
                return operation
            legal = {
                "validated-intent": {"authorization-consumption-pending", "recovery-required"},
                "authorization-consumption-pending": {"authorization-consumed", "recovery-required"},
                "authorization-consumed": {"incumbent-stop-intent", "recovery-required"},
                "incumbent-stop-intent": {"incumbent-stop-observed", "recovery-required"},
                "incumbent-stop-observed": {"candidate-start-intent", "recovery-required"},
                "candidate-start-intent": {"candidate-start-observed", "recovery-required"},
                "candidate-start-observed": {"candidate-health-verified", "recovery-required"},
                "candidate-health-verified": {"successful-activation", "recovery-required"},
                "compensation-authorization-consumption-pending": {"rollback-intent", "recovery-required"},
                "successful-activation": set(),
                "rollback-intent": {"rollback-observed", "recovery-required"},
                "rollback-observed": {"successful-rollback", "recovery-required"},
                "successful-rollback": set(), "recovery-required": set(),
            }
            if current == "recovery-required":
                _require(isinstance(recovery_resume, str) and (phase == recovery_resume or (phase == "compensation-authorization-consumption-pending" and operation["rollback_authorization_record_sha256"] is not None)), "recovery resumption must use the exact persisted phase")
                legal[current] = {phase}
                if operation["rollback_authorization_record_sha256"] is not None:
                    legal[current].add("compensation-authorization-consumption-pending")
            _require(phase in legal[current], f"illegal activation phase transition: {current} -> {phase}")
            if phase in {"incumbent-stop-intent", "successful-activation"}:
                _require(operation["forward_consumption"] is not None and operation["delivery_consumption"] is not None, "authoritative activation transition requires exact delivery and activation consumption")
                self._validate_delivery_evidence(state)
            if current == "incumbent-stop-observed" and phase == "candidate-start-intent":
                _require(operation["observations"].get("incumbent-stop-observed", {}).get("outcome") == "stopped", "candidate start cannot follow a failed or uncertain incumbent stop")
            if current == "candidate-start-observed" and phase == "candidate-health-verified":
                _require(operation["observations"].get("candidate-start-observed", {}).get("outcome") == "started", "candidate health cannot follow a failed or uncertain candidate start")
            if phase == "successful-activation":
                _require(current == "candidate-health-verified", "candidate health evidence is required before activation commit")
                health = operation["observations"].get("candidate-health-verified")
                _require(isinstance(health, dict) and health.get("outcome") == "healthy", "ambiguous candidate health evidence cannot change pointers")
                _require(operation["forward_consumption"] is not None, "forward replay consumption is not durably recorded")
                _require(operation["delivery_consumption"] is not None, "delivery replay consumption is not durably recorded")
                self._commit_activation_state(state, operation, rollback=False)
            elif phase == "successful-rollback":
                _require(current == "rollback-observed", "rollback observation is required before rollback commit")
                rollback = operation["observations"].get("rollback-observed")
                _require(isinstance(rollback, dict) and rollback.get("outcome") == "healthy", "ambiguous rollback evidence cannot change pointers")
                _require(operation["rollback_consumption"] is not None, "rollback replay consumption is not durably recorded")
                self._commit_activation_state(state, operation, rollback=True)
            else:
                operation["phase"] = phase
                if phase == "recovery-required":
                    # Keep the exact retry point in the intent record.  This
                    # does not grant new authority; the next transition must
                    # validate the same replay-derived authority and binding.
                    operation["intent"]["recovery_phase"] = current
                if observation is not None:
                    _require(observation.get("operation_id") == operation_id and observation.get("candidate_release") == operation["candidate_release"] and observation.get("runtime_identity_sha256") == operation["runtime_identity_sha256"], "activation observation is not bound to the exact operation and runtime")
                    operation["observations"][phase] = observation
                if phase == "authorization-consumed":
                    operation["forward_consumption"] = {"operation_id": authority.operation_id, "candidate_release": authority.candidate_release, "preparation_metadata_sha256": authority.preparation_metadata_sha256, "record_sha256": authority.record_sha256, "authorization_id": authority.authorization_id, "retry_key": authority.retry_key, "scope": authority.scope, "state": authority.state, "pointer_generation": authority.pointer_generation, "observed_at": authority.observed_at}
                if phase == "rollback-intent":
                    operation["rollback_consumption"] = {"operation_id": authority.operation_id, "candidate_release": authority.candidate_release, "preparation_metadata_sha256": authority.preparation_metadata_sha256, "record_sha256": authority.record_sha256, "authorization_id": authority.authorization_id, "retry_key": authority.retry_key, "scope": authority.scope, "state": authority.state, "pointer_generation": authority.pointer_generation, "observed_at": authority.observed_at}
                operation["updated_at"] = _now()
                if phase == "recovery-required":
                    pointer_ids = {state["active_release"], state["previous_known_good_release"]}
                    for release_id in (operation["candidate_release"], operation["rollback_target"]):
                        if release_id not in (None, LEGACY_BASELINE_ID) and release_id not in pointer_ids:
                            record = state["releases"][release_id]
                            if "recovery-protected" not in record["roles"]:
                                record["roles"].append("recovery-protected")
                elif current == "recovery-required":
                    operation["intent"].pop("recovery_phase", None)
            self._save(state)
            return state["activation_operations"][operation_id]
        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

    def record_delivery_consumption(self, operation_id: str, authority: _ActivationAuthority, *, assume_locked: bool = False) -> dict[str, Any]:
        """Persist exact delivery-journal consumption before pointer publication."""
        def apply() -> dict[str, Any]:
            state = self.load()
            operation = state["activation_operations"].get(operation_id)
            _require(operation is not None, "activation operation is unknown")
            _require(authority.scope == "forward-release" and authority.state == "consumed", "delivery authority is not consumed")
            self._validate_activation_authority(authority, operation_id=operation_id, candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], record_sha256=authority.record_sha256, authorization_id=authority.authorization_id, retry_key=authority.retry_key, scope="forward-release", state="consumed", pointer_generation=operation["expected_pointer_generation"])
            evidence = {"operation_id": authority.operation_id, "candidate_release": authority.candidate_release, "preparation_metadata_sha256": authority.preparation_metadata_sha256, "record_sha256": authority.record_sha256, "authorization_id": authority.authorization_id, "retry_key": authority.retry_key, "scope": authority.scope, "state": authority.state, "pointer_generation": authority.pointer_generation, "observed_at": authority.observed_at}
            if operation["delivery_consumption"] is not None:
                _require(operation["delivery_consumption"] == evidence, "delivery consumption retry conflicts with durable evidence")
                self._reestablish_state_durability()
                return operation
            operation["delivery_consumption"] = evidence
            self._validate_delivery_evidence(state)
            candidate = state["releases"][operation["candidate_release"]]
            candidate["roles"] = [role for role in candidate["roles"] if role not in {"pending", "reserved"}]
            if "recovery-protected" not in candidate["roles"]:
                candidate["roles"].append("recovery-protected")
            operation["updated_at"] = _now()
            self._save(state)
            return operation
        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

    def _commit_activation_state(self, state: dict[str, Any], operation: dict[str, Any], *, rollback: bool) -> None:
        candidate_id = operation["candidate_release"]
        candidate = state["releases"][candidate_id]
        expected_generation = operation["rollback_expected_pointer_generation"] if rollback else operation["expected_pointer_generation"]
        _require(expected_generation is not None and state["pointer_generation"] == expected_generation, "activation pointer generation changed during transaction")
        old_active = state["active_release"]
        old_previous = state["previous_known_good_release"]
        if rollback:
            target = operation["rollback_target"]
            if operation["rollback_kind"] == "compensation":
                _require(old_active == operation["incumbent_release"], "compensation cannot change the incumbent pointer")
                state["active_release"] = old_active
                state["previous_known_good_release"] = old_previous
                candidate["roles"] = ["retired"]
                candidate["retired_at"] = _now()
            else:
                if target == LEGACY_BASELINE_ID:
                    state["active_release"] = None
                    state["previous_known_good_release"] = LEGACY_BASELINE_ID
                else:
                    _require(target in state["releases"], "rollback target release is unknown")
                    state["active_release"] = target
                    fallback = old_previous
                    state["previous_known_good_release"] = fallback if fallback not in {None, target, candidate_id} else LEGACY_BASELINE_ID
                candidate["roles"] = ["retired"]
                candidate["retired_at"] = _now()
        else:
            _require(old_active == operation["incumbent_release"] and old_previous == operation["previous_known_good_release"], "activation incumbent or previous-known-good identity changed")
            state["active_release"] = candidate_id
            state["previous_known_good_release"] = old_active or LEGACY_BASELINE_ID
            candidate["roles"] = [role for role in candidate["roles"] if role not in {"prepared", "pending", "reserved", "recovery-protected", "in-flight", "retired"}]
            candidate["retired_at"] = None
        for pointer in (state["active_release"], state["previous_known_good_release"]):
            if pointer not in (None, LEGACY_BASELINE_ID):
                state["releases"][pointer]["roles"] = []
                state["releases"][pointer]["retired_at"] = None
        if old_previous not in (None, LEGACY_BASELINE_ID, state["active_release"], state["previous_known_good_release"]):
            previous_record = state["releases"][old_previous]
            previous_record["roles"] = ["retired"]
            previous_record["retired_at"] = _now()
        operation["phase"] = "successful-rollback" if rollback else "successful-activation"
        operation["updated_at"] = _now()
        if not (rollback and operation["rollback_kind"] == "compensation"):
            state["pointer_generation"] += 1

    def start_activation_rollback(self, operation_id: str, *, authorization_record_sha256: str, authorization_id: str, retry_key: str, rollback_kind: str, authority: _ActivationAuthority, assume_locked: bool = False) -> dict[str, Any]:
        """Persist a distinct recovery authorization binding before its use."""
        _require(provenance.SHA256_RE.fullmatch(authorization_record_sha256 or "") is not None, "rollback authorization record digest is invalid")
        _require(isinstance(authorization_id, str) and authorization_id != "" and isinstance(retry_key, str) and retry_key != "", "rollback authorization identity is invalid")
        _require(rollback_kind in {"compensation", "post-activation"}, "rollback kind is invalid")
        def apply() -> dict[str, Any]:
            state = self.load()
            operation = state["activation_operations"].get(operation_id)
            _require(operation is not None and operation["phase"] in {"successful-activation", "incumbent-stop-observed", "candidate-start-observed", "candidate-health-verified", "compensation-authorization-consumption-pending", "recovery-required"}, "activation rollback cannot start from the current phase")
            expected_target = operation["rollback_target"] if state["active_release"] == operation["candidate_release"] else (state["active_release"] or LEGACY_BASELINE_ID)
            _require(operation["rollback_target"] == expected_target, "rollback target is not the actual incumbent")
            expected_kind = "post-activation" if state["active_release"] == operation["candidate_release"] else "compensation"
            _require(rollback_kind == expected_kind, "rollback kind does not match the observed activation state")
            self._validate_activation_authority(authority, operation_id=operation_id, candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], record_sha256=authorization_record_sha256, authorization_id=authorization_id, retry_key=retry_key, scope="activation-recovery", state="reserved", pointer_generation=state["pointer_generation"])
            if operation["phase"] == "compensation-authorization-consumption-pending":
                _require(operation["rollback_authorization_record_sha256"] == authorization_record_sha256 and operation["rollback_authorization_id"] == authorization_id and operation["rollback_retry_key"] == retry_key and operation["rollback_kind"] == rollback_kind and operation["rollback_expected_pointer_generation"] == state["pointer_generation"], "rollback retry conflicts with the pending recovery authorization")
                return operation
            if operation["phase"] == "recovery-required" and operation["rollback_authorization_record_sha256"] is not None:
                _require(operation["rollback_authorization_record_sha256"] == authorization_record_sha256 and operation["rollback_authorization_id"] == authorization_id and operation["rollback_retry_key"] == retry_key and operation["rollback_kind"] == rollback_kind and operation["rollback_expected_pointer_generation"] == state["pointer_generation"], "recovery resumption conflicts with the already-bound rollback authorization")
                operation["phase"] = "compensation-authorization-consumption-pending"
                operation["intent"].pop("recovery_phase", None)
                operation["updated_at"] = _now()
                self._save(state)
                return operation
            _require(operation["rollback_authorization_record_sha256"] is None and operation["rollback_authorization_id"] is None and operation["rollback_retry_key"] is None and operation["rollback_expected_pointer_generation"] is None, "rollback authorization is already bound to a different retry")
            operation["rollback_authorization_record_sha256"] = authorization_record_sha256
            operation["rollback_authorization_id"] = authorization_id
            operation["rollback_retry_key"] = retry_key
            operation["rollback_kind"] = rollback_kind
            operation["rollback_expected_pointer_generation"] = state["pointer_generation"]
            operation["phase"] = "compensation-authorization-consumption-pending"
            operation["updated_at"] = _now()
            self._save(state)
            return operation
        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

    def inventory(self, *, assume_locked: bool = False) -> dict[str, Any]:
        def collect() -> dict[str, Any]:
            state = self.load()
            historical_refs = self._activation_reference_set(state)
            gc_transaction_ids = set(state["gc_transactions"])
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
                    eligible = record["roles"] == ["retired"] and state["active_release"] != digest and state["previous_known_good_release"] != digest and digest not in historical_refs and digest not in gc_transaction_ids
                    known.append({"identity_sha256": digest, "publication": child.name, "roles": record["roles"], "eligible": eligible})
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
            self._validate_gc_transactions(state)
            state = self.load()
            inventory = self.inventory(assume_locked=True)
            transaction_ids = set(state["gc_transactions"])
            historical_refs = self._activation_reference_set(state)
            transaction_unknown = [{"publication": transaction["publication_name"], "reason": "gc-transaction-recovery-required"} for transaction in state["gc_transactions"].values() if not (self.root / transaction["publication_name"]).exists()]
            candidates = [] if inventory.get("truncated") else [item for item in inventory["known"] if item["eligible"] and item["identity_sha256"] not in transaction_ids and item["identity_sha256"] not in historical_refs]
            candidates = candidates[:max_deletions]
            deleted: list[str] = []
            if execute:
                for item in candidates:
                    digest = item["identity_sha256"]
                    current = self.load()
                    _require(current["active_release"] != digest and current["previous_known_good_release"] != digest, "release became protected during garbage collection")
                    _require(digest not in self._activation_reference_set(current), "release became protected by historical activation evidence")
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
            return {"dry_run": not execute, "candidates": [item["identity_sha256"] for item in candidates], "deleted": deleted, "unknown": inventory["unknown"] + transaction_unknown, "protected": sorted({item["identity_sha256"] for item in inventory["known"] if not item["eligible"]} | transaction_ids | historical_refs)}
        if assume_locked:
            return collect()
        with activity_lock(self.root):
            return collect()

    def recover(self, *, assume_locked: bool = False) -> dict[str, Any]:
        """Explicitly reconcile interrupted GC transactions under the shared lock."""
        def apply() -> dict[str, Any]:
            state = self.load()
            self._recover_gc_transactions(state)
            final_state = self.load()
            recovered = sorted(
                digest for digest, record in final_state["releases"].items()
                if "recovery-protected" in record["roles"] and digest in final_state["gc_transactions"]
            )
            return {"recovered": recovered, "dry_run": False}
        if assume_locked:
            return apply()
        with activity_lock(self.root):
            return apply()

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
        historical_refs = self._activation_reference_set(state)
        for digest, transaction in state["gc_transactions"].items():
            _require(state["active_release"] != digest and state["previous_known_good_release"] != digest, "GC transaction references a protected release")
            _require(not any(operation["release_sha256"] == digest for operation in state["operations"].values()), "GC transaction conflicts with an in-flight operation")
            _require(digest not in historical_refs, "GC transaction conflicts with historical activation evidence")
            record = state["releases"].get(digest)
            _require(record is not None and set(record["roles"]) <= {"retired", "recovery-protected"}, "GC transaction references an invalid release role")
            path = self.root / transaction["publication_name"]
            if path.exists():
                self._verify_owned_release(path, record)

    @staticmethod
    def _activation_reference_set(state: dict[str, Any]) -> set[str]:
        """Return every release retained as historical activation evidence."""
        references: set[str] = set()
        for operation in state.get("activation_operations", {}).values():
            for field in ("candidate_release", "incumbent_release", "previous_known_good_release", "rollback_target"):
                value = operation.get(field)
                if isinstance(value, str) and value != LEGACY_BASELINE_ID:
                    references.add(value)
        return references

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

    def verify_retained_offline(self, identity_sha256: str, *, trusted_root: Path, trusted_root_version: str, verifier_version: str | None = None, authorization_public_key: Path | None = None, authorization_key_id: str | None = None, authorization_key_fingerprint: str | None = None, authorization_allowlist: Path | None = None, excluded_roots: tuple[Path, ...] = (), assume_locked: bool = False) -> dict[str, Any]:
        """Re-verify retained evidence without reserving or consuming authority.

        Candidate authorization is checked against the owner-supplied key and
        revision policy at the authorization's historical issuance time. No
        replay journal is opened and no current online authority is consulted.
        """
        _require(isinstance(trusted_root_version, str) and len(trusted_root_version) == 16 and all(char in "0123456789abcdef" for char in trusted_root_version), "independent trusted-root version is malformed")
        _require(trusted_root.is_absolute() and trusted_root.is_file() and not trusted_root.is_symlink(), "independent trusted root is unavailable")
        for base in (self.root, self.repository_root, *excluded_roots):
            try:
                trusted_root.resolve().relative_to(base.resolve())
            except ValueError:
                pass
            else:
                _fail("independent trusted root must be outside retention and checkout roots")
        trusted_metadata = _private_regular_file(trusted_root, "independent trusted root")
        if os.name == "posix":
            _require(trusted_metadata.st_uid == os.geteuid() and stat.S_IMODE(trusted_metadata.st_mode) & 0o077 == 0, "independent trusted root is not private")
        def verify() -> dict[str, Any]:
            state = self.load()
            record = state["releases"].get(identity_sha256)
            _require(record is not None, "offline verification release is unknown")
            evidence = record["evidence"]
            required = {"artifact-service.zip", "attestation-bundle.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
            _require(required.issubset(evidence), "retained offline verification evidence is incomplete")
            release_path = self.root / record["publication_name"]
            self._verify_owned_release(release_path, record)
            identity = record["identity"]
            candidate_identity = provenance.TrustedReleaseIdentity(**identity)
            candidate_delivery = candidate_identity.artifact_class == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS
            if candidate_delivery:
                candidate_required = {"authorization-envelope.json", "independent-verification-context.json"}
                _require(candidate_required.issubset(evidence), "retained candidate authorization evidence is incomplete")
                _require(authorization_public_key is not None and authorization_allowlist is not None and isinstance(authorization_key_id, str) and authorization_key_id != "" and isinstance(authorization_key_fingerprint, str) and provenance.SHA256_RE.fullmatch(authorization_key_fingerprint) is not None, "historical candidate verification requires explicit authorization trust inputs")
                for trust_path, label in ((authorization_public_key, "historical authorization public key"), (authorization_allowlist, "historical authorization revision allowlist")):
                    assert trust_path is not None
                    _require(trust_path.is_absolute() and not trust_path.is_symlink(), f"{label} is unavailable")
                    for base in (self.root, self.repository_root, *excluded_roots):
                        try:
                            trust_path.resolve().relative_to(base.resolve())
                        except ValueError:
                            continue
                        _fail(f"{label} must be outside mutable retention, checkout, and receiver roots")
                context_path = release_path / "independent-verification-context.json"
                context_raw = provenance._read_bounded_bytes(context_path, MAX_EVIDENCE_BYTES, "retained candidate verification context")
                _require(context_raw == provenance._canonical_json(_read_json(context_path, MAX_EVIDENCE_BYTES, "retained candidate verification context")) + b"\n", "retained candidate verification context is not canonical")
                context = _read_json(context_path, MAX_EVIDENCE_BYTES, "retained candidate verification context")
                provenance.validate_candidate_verification_context(context, candidate_identity)
                context_digest = hashlib.sha256(context_raw).hexdigest()
                envelope_path = release_path / "authorization-envelope.json"
                envelope_raw = provenance._read_bounded_bytes(envelope_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "retained authorization envelope")
                envelope = _read_json(envelope_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "retained authorization envelope")
                _require(envelope_raw == provenance._canonical_json(envelope) + b"\n", "retained authorization envelope is not canonical")
                allowlist_value = _read_json(authorization_allowlist, MAX_EVIDENCE_BYTES, "historical authorization revision allowlist")
                _require(isinstance(allowlist_value, dict) and set(allowlist_value) == {"producer_workflow", "producer_revisions", "signer_workflow", "signer_revisions"}, "historical authorization revision allowlist is malformed")
                try:
                    allowlist = provenance.AuthorizationRevisionAllowlist(
                        producer_workflow=allowlist_value["producer_workflow"],
                        producer_revisions=tuple(allowlist_value["producer_revisions"]),
                        signer_workflow=allowlist_value["signer_workflow"],
                        signer_revisions=tuple(allowlist_value["signer_revisions"]),
                    )
                    provenance.validate_authorization_revision_allowlist(allowlist)
                    trust = provenance.AuthorizationTrustConfig(authorization_public_key, authorization_key_id, authorization_key_fingerprint, self.repository_root)
                    historical_authorization = provenance.verify_signed_authorization_record(envelope, trust, candidate_identity, allowlist, historical=True)
                except (TypeError, provenance.ProvenanceError) as error:
                    _fail(f"retained candidate authorization is invalid: {error}")
                _require(historical_authorization.scope == "forward-release" and historical_authorization.context == provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT and historical_authorization.verification_context_sha256 == context_digest, "retained candidate authorization is not bound to the historical verification context")
            outer_digest, outer_bytes = provenance._sha256_file(release_path / "artifact-service.zip", provenance.MAX_ARTIFACT_BYTES, "retained artifact-service ZIP")
            _require(outer_digest == identity["artifact_service_zip_sha256"] and outer_bytes == identity["artifact_service_zip_bytes"], "retained outer artifact does not match the immutable release identity")
            expectation = _read_json(release_path / "verification-expectation.json", MAX_EVIDENCE_BYTES, "retained verification expectation")
            receipt = _read_json(release_path / "verification-receipt.json", MAX_EVIDENCE_BYTES, "retained verification receipt")
            _require(isinstance(expectation, dict) and expectation.get("contract") == "clashcookies.retained-verification-expectation" and expectation.get("version") == 1, "retained verification expectation is not bound")
            _require(expectation.get("identity_sha256") == identity_sha256, "retained verification expectation identity is not bound")
            try:
                provenance.validate_expectation_identity_binding(provenance.TrustedReleaseIdentity(**identity), expectation)
            except (TypeError, provenance.ProvenanceError) as error:
                _fail(f"retained verification expectation does not match the immutable release identity: {error}")
            _require(isinstance(receipt, dict) and receipt.get("status") == "verified-provenance-only" and receipt.get("authenticated") is True, "retained verification receipt is not an authenticated receipt")
            retained_root_digest, retained_root_bytes = provenance._sha256_file(release_path / "trusted-root.jsonl", provenance.MAX_BUNDLE_BYTES, "retained trusted root")
            root_digest, root_bytes = provenance._sha256_file(trusted_root, provenance.MAX_BUNDLE_BYTES, "independent trusted root")
            _require(expectation.get("trusted_root_sha256") == root_digest == retained_root_digest and expectation.get("trusted_root_bytes") == root_bytes == retained_root_bytes and expectation.get("trusted_root_version") == trusted_root_version, "trusted-root version, fingerprint, or retained snapshot does not match the verification expectation")
            with tempfile.TemporaryDirectory(prefix="retained-verify-", dir=self.root) as directory_name:
                temporary = Path(directory_name)
                archive_path = temporary / identity["archive_name"]
                with ZipFile(release_path / "artifact-service.zip") as service:
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
                verified = provenance.run_gh_attestation_verify(archive_path, bundle=release_path / "attestation-bundle.json", repository=expectation["repository"], signer_workflow=expectation["signer_workflow"], signer_revision=expectation["signer_revision"], source_ref=expectation["source_ref"], source_sha=expectation["source_sha"], verifier_version=actual_version, custom_trusted_root=trusted_root, offline=True, repository_root=self.repository_root, excluded_roots=(self.repository_root, self.root, *excluded_roots))
                _require(verified.get("_trustedRootSha256") == root_digest and verified.get("_trustedRootBytes") == root_bytes, "offline verifier did not report the independently pinned trusted-root snapshot")
                authenticated = provenance.validate_verified_result(verified, archive_name=identity["archive_name"], archive_digest=identity["archive_sha256"], archive_bytes=identity["archive_bytes"], expected=expectation, run_metadata=None, require_run_metadata=False)
                fresh_receipt = authenticated.diagnostic_json()
                _require(receipt == fresh_receipt, "retained verification receipt does not match reverified authenticated provenance")
                result = dict(fresh_receipt)
                if candidate_delivery:
                    result["authorizationDiagnostic"] = {"historicalSignatureValid": True, "historicalLifecycleValidAtIssuedAt": True, "deliveryTimeValidity": "not-evaluated", "replayStatus": "not-evaluated", "replayMutation": "none"}
                return result
        if assume_locked:
            return verify()
        with activity_lock(self.root):
            return verify()


def gc_command(publication_root: Path, repository_root: Path, *, execute: bool, max_deletions: int, recover: bool = False) -> dict[str, Any]:
    store = RetentionStore(publication_root, repository_root=repository_root)
    if recover:
        return store.recover()
    return store.garbage_collect(execute=execute, max_deletions=max_deletions)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="bounded durable artifact retention inventory and GC")
    parser.add_argument("--publication-root", required=True)
    parser.add_argument("--repository-root", required=True)
    action_group = parser.add_mutually_exclusive_group()
    action_group.add_argument("--execute", action="store_true", help="execute the separately requested bounded deletion")
    action_group.add_argument("--recover", action="store_true", help="explicitly reconcile interrupted deletion transactions")
    parser.add_argument("--max-deletions", type=int, default=MAX_GC_DELETIONS)
    args = parser.parse_args()
    try:
        print(json.dumps(gc_command(Path(args.publication_root), Path(args.repository_root), execute=args.execute, recover=args.recover, max_deletions=args.max_deletions), sort_keys=True))
    except (RetentionError, OSError, ValueError) as error:
        print(f"[durable-artifact-retention] blocked: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
