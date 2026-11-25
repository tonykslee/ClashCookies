#!/usr/bin/env python3
"""Bounded, repository-only SSH artifact delivery and receiving boundary.

This module is intentionally a delivery primitive, not a deployment wrapper.
It never activates a runtime, consumes deployment authorization, or decides
production eligibility.  The sender uses standard OpenSSH with an explicit
private known_hosts file and identity.  The receiver accepts a small framed
stream, validates it into a private workspace, and publishes one immutable
identity directory without replacement.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import time
from typing import BinaryIO, Iterator, Any
from zipfile import ZipFile, BadZipFile

import runtime_artifact_provenance as provenance


DELIVERY_CONTRACT = "clashcookies.trusted-ssh-artifact-delivery"
DELIVERY_VERSION = 1
FRAME_MAGIC = b"CCSSH-ARTIFACT-1\n"
MAX_HEADER_BYTES = 256 * 1024
MAX_FILE_COUNT = 8
MAX_FILE_BYTES = provenance.MAX_BUNDLE_BYTES
MAX_SERVICE_ZIP_BYTES = provenance.MAX_ARTIFACT_BYTES
MAX_AGGREGATE_BYTES = MAX_SERVICE_ZIP_BYTES + provenance.MAX_BUNDLE_BYTES + provenance.MAX_AUTHORIZATION_RECORD_BYTES
MAX_RECEIVING_SECONDS = 180
MAX_SSH_OUTPUT_BYTES = 64 * 1024
ALLOWED_FILES = {"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json"}


class DeliveryError(RuntimeError):
    """Raised for transport, boundary, content, or publication failure."""


@dataclass(frozen=True)
class DeliveryLimits:
    max_service_zip_bytes: int = MAX_SERVICE_ZIP_BYTES
    max_bundle_bytes: int = provenance.MAX_BUNDLE_BYTES
    max_authorization_bytes: int = provenance.MAX_AUTHORIZATION_RECORD_BYTES
    max_file_count: int = MAX_FILE_COUNT
    max_aggregate_bytes: int = MAX_AGGREGATE_BYTES
    max_elapsed_seconds: int = MAX_RECEIVING_SECONDS
    max_subprocess_output_bytes: int = MAX_SSH_OUTPUT_BYTES


@dataclass(frozen=True)
class SshDeliveryEndpoint:
    host: str
    user: str
    known_hosts: Path
    identity_file: Path
    destination: str
    remote_repository_root: str = ""
    remote_receiving_root: str = ""
    remote_publication_root: str = ""
    remote_expected_identity: str = ""
    remote_trusted_root: str = ""
    remote_offline_expectation: str = ""
    port: int = 22
    connect_timeout_seconds: int = 10
    execution_timeout_seconds: int = MAX_RECEIVING_SECONDS


@dataclass(frozen=True)
class DeliveryResult:
    status: str
    publication: str
    identity_sha256: str
    artifact_service_zip_sha256: str
    artifact_service_zip_bytes: int
    archive_sha256: str
    archive_bytes: int
    offline_attestation: bool
    authorization_reserved: bool


@dataclass(frozen=True)
class DevelopmentDeliveryIdentity:
    """Exact non-authoritative development artifact identity from intake."""

    repository: str
    repository_id: int
    repository_owner_id: int
    source_ref: str
    source_sha: str
    event: str
    producer_workflow: str
    producer_revision: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    artifact_id: int
    artifact_name: str
    artifact_class: str
    artifact_service_zip_sha256: str
    artifact_service_zip_bytes: int
    archive_name: str
    archive_sha256: str
    archive_bytes: int
    platform: str
    image: str
    image_digest: str
    authorization_context: str


def _fail(message: str) -> None:
    raise DeliveryError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _load_validator() -> Any:
    path = Path(__file__).with_name("validate-runtime-artifact.py")
    spec = importlib.util.spec_from_file_location("validate_runtime_artifact_delivery", path)
    if spec is None or spec.loader is None:
        _fail("hardened runtime-artifact validator cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _validate_delivery_identity(identity: Any) -> None:
    _require(isinstance(identity, (provenance.TrustedReleaseIdentity, DevelopmentDeliveryIdentity)), "delivery identity has an unsupported type")
    if isinstance(identity, provenance.TrustedReleaseIdentity):
        provenance.validate_trusted_release_identity(identity)
        return
    _require(identity.artifact_class == provenance.DEVELOPMENT_ARTIFACT_CLASS, "development delivery identity has an unsupported artifact class")
    _require(provenance.GIT_SHA_RE.fullmatch(identity.source_sha) and provenance.GIT_SHA_RE.fullmatch(identity.producer_revision) and provenance.GIT_SHA_RE.fullmatch(identity.signer_revision), "development identity revision is malformed")
    _require(provenance.SHA256_RE.fullmatch(identity.artifact_service_zip_sha256) and provenance.SHA256_RE.fullmatch(identity.archive_sha256), "development identity digest is malformed")
    _require(identity.repository != "" and identity.source_ref != "" and identity.archive_name != "", "development identity is incomplete")
    _require(identity.artifact_service_zip_bytes > 0 and identity.archive_bytes > 0, "development identity byte counts are invalid")


def _identity_payload(identity: Any) -> dict[str, Any]:
    _validate_delivery_identity(identity)
    return asdict(identity)


def identity_from_json(value: Any) -> Any:
    _require(isinstance(value, dict), "trusted release identity must be an object")
    fields = set(provenance.TrustedReleaseIdentity.__dataclass_fields__)
    _require(set(value) == fields, "trusted release identity has missing or unexpected fields")
    try:
        identity_class = DevelopmentDeliveryIdentity if value.get("artifact_class") == provenance.DEVELOPMENT_ARTIFACT_CLASS else provenance.TrustedReleaseIdentity
        identity = identity_class(**value)
    except (TypeError, ValueError) as error:
        _fail(f"trusted release identity is malformed: {error}")
    _validate_delivery_identity(identity)
    return identity


def _identity_digest(identity: Any) -> str:
    return hashlib.sha256(provenance._canonical_json(_identity_payload(identity))).hexdigest()


def _assert_external_directory(path: Path, repository_root: Path, label: str) -> None:
    _require(path.is_absolute() and repository_root.is_absolute(), f"{label} paths must be absolute")
    provenance._require_external_path(path, repository_root, label)
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid(), f"{label} is not owner-controlled")
        _require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private")


def _assert_private_input(path: Path, repository_root: Path, label: str, maximum: int) -> None:
    provenance._require_external_path(path, repository_root, label)
    try:
        metadata = os.lstat(path)
        parent = os.lstat(path.parent)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a regular non-symlink file")
    _require(metadata.st_size <= maximum, f"{label} exceeds the size limit")
    _require(stat.S_ISDIR(parent.st_mode) and not stat.S_ISLNK(parent.st_mode), f"{label} parent must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid() and parent.st_uid == os.geteuid(), f"{label} is not owner-controlled")
        _require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0 and stat.S_IMODE(parent.st_mode) & 0o077 == 0, f"{label} is not private")


@contextmanager
def _receiver_lock(root: Path, timeout_seconds: int = 5) -> Iterator[None]:
    """Serialize bounded receiving activity without deleting the lock file."""
    lock_path = root / ".receiver.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        _require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "receiver lock must be a single regular file")
        if os.name == "posix":
            import fcntl
            _require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "receiver lock ownership or permissions are unsafe")
            deadline = time.monotonic() + timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        _fail("receiver activity lock acquisition deadline exceeded")
                    time.sleep(0.01)
        yield
    except OSError as error:
        _fail(f"receiver activity lock failed: {error}")
    finally:
        if os.name == "posix":
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(descriptor)


def _bounded_copy(source: Path, destination: Path, maximum: int, label: str) -> tuple[str, int]:
    """Copy a regular input through a private descriptor-backed snapshot."""
    descriptor, size = provenance._open_nofollow_regular(source, maximum, label)
    digest = hashlib.sha256()
    try:
        with destination.open("xb") as output:
            remaining = size
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                _require(chunk, f"{label} changed while snapshotting")
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            _require(os.fstat(descriptor).st_size == size, f"{label} changed during snapshot")
            output.flush()
            os.fsync(output.fileno())
    except OSError as error:
        destination.unlink(missing_ok=True)
        _fail(f"{label} snapshot failed: {error}")
    finally:
        os.close(descriptor)
    return digest.hexdigest(), size


def _validate_endpoint(endpoint: SshDeliveryEndpoint, repository_root: Path) -> None:
    _require(endpoint.host != "" and endpoint.user != "", "SSH host and user are required")
    _require(all(ord(ch) >= 0x20 and ch not in "\r\n\x7f" for ch in endpoint.host + endpoint.user), "SSH host or user contains control characters")
    _require(1 <= endpoint.port <= 65535, "SSH port is out of range")
    _require(1 <= endpoint.connect_timeout_seconds <= 60, "SSH connect timeout is out of bounds")
    _require(1 <= endpoint.execution_timeout_seconds <= MAX_RECEIVING_SECONDS, "SSH execution timeout is out of bounds")
    _assert_private_input(endpoint.known_hosts, repository_root, "trusted known_hosts", 1024 * 1024)
    _assert_private_input(endpoint.identity_file, repository_root, "disposable SSH identity", 1024 * 1024)
    _require(endpoint.destination != "" and "\x00" not in endpoint.destination, "SSH destination is required")
    for value, label in ((endpoint.remote_repository_root, "remote repository root"), (endpoint.remote_receiving_root, "remote receiving root"), (endpoint.remote_publication_root, "remote publication root"), (endpoint.remote_expected_identity, "remote expected identity"), (endpoint.remote_trusted_root, "remote trusted root"), (endpoint.remote_offline_expectation, "remote offline expectation")):
        _require(value != "" and all(ch.isalnum() or ch in "_./:-" for ch in value), f"{label} must be an explicit shell-safe path")
    _require(endpoint.destination == endpoint.remote_publication_root, "SSH destination does not match the explicit receiver publication directory")


def _sha256_path(path: Path, expected_size: int) -> str:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            _require(size <= expected_size, f"file changed while hashing: {path.name}")
            digest.update(chunk)
    _require(size == expected_size, f"file size changed while hashing: {path.name}")
    return digest.hexdigest()


def _write_frame(stream: BinaryIO, header: bytes, files: list[tuple[str, Path, int]]) -> None:
    _require(len(header) <= MAX_HEADER_BYTES, "delivery frame header exceeds the limit")
    try:
        descriptors = {item["name"]: item for item in json.loads(header.decode("utf-8"))["files"]}
    except (UnicodeDecodeError, KeyError, TypeError, json.JSONDecodeError) as error:
        _fail(f"delivery frame header cannot be checked before transfer: {error}")
    stream.write(FRAME_MAGIC)
    stream.write(len(header).to_bytes(4, "big"))
    stream.write(header)
    for name, path, size in files:
        sent = 0
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                sent += len(chunk)
                _require(sent <= size, f"file changed during SSH transfer: {path.name}")
                digest.update(chunk)
                stream.write(chunk)
        _require(sent == size, f"file truncated during SSH transfer: {path.name}")
        _require(digest.hexdigest() == descriptors[name]["sha256"], f"file changed during SSH transfer: {name}")
    stream.flush()


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            _fail("delivery stream ended before the bounded frame completed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _validate_frame_header(header: Any, limits: DeliveryLimits) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    _require(isinstance(header, dict), "delivery frame header must be an object")
    _require(set(header) == {"contract", "version", "destination", "identity", "identitySha256", "files"}, "delivery frame header has unexpected fields")
    _require(header["contract"] == DELIVERY_CONTRACT and header["version"] == DELIVERY_VERSION, "delivery frame contract is unsupported")
    _require(isinstance(header["destination"], str) and header["destination"] != "" and "\x00" not in header["destination"], "delivery destination is malformed")
    identity = identity_from_json(header["identity"])
    _require(header["identitySha256"] == _identity_digest(identity), "delivery identity digest mismatch")
    files = header["files"]
    _require(isinstance(files, list) and 0 < len(files) <= limits.max_file_count, "delivery file count is out of bounds")
    names: set[str] = set()
    aggregate = 0
    for item in files:
        _require(isinstance(item, dict) and set(item) == {"name", "bytes", "sha256"}, "delivery file descriptor is malformed")
        name = item["name"]
        _require(name in ALLOWED_FILES and name not in names, "delivery file name is not allowed or is duplicated")
        _require(isinstance(item["bytes"], int) and item["bytes"] > 0, "delivery file size is malformed")
        maximum = limits.max_service_zip_bytes if name == "artifact-service.zip" else limits.max_bundle_bytes if name == "attestation-bundle.json" else limits.max_authorization_bytes
        _require(item["bytes"] <= maximum, f"delivery file {name} exceeds its limit")
        _require(isinstance(item["sha256"], str) and provenance.SHA256_RE.fullmatch(item["sha256"]), f"delivery file {name} digest is malformed")
        names.add(name)
        aggregate += item["bytes"]
    _require("artifact-service.zip" in names, "delivery frame does not contain the original artifact-service ZIP")
    _require(aggregate <= limits.max_aggregate_bytes, "delivery aggregate bytes exceed the limit")
    return _identity_payload(identity), files


def _read_frame(stream: BinaryIO, attempt_root: Path, limits: DeliveryLimits) -> tuple[dict[str, Any], dict[str, Path], str]:
    _require(_read_exact(stream, len(FRAME_MAGIC)) == FRAME_MAGIC, "delivery frame magic is invalid")
    header_size = int.from_bytes(_read_exact(stream, 4), "big")
    _require(0 < header_size <= MAX_HEADER_BYTES, "delivery frame header size is out of bounds")
    try:
        header = json.loads(_read_exact(stream, header_size).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"delivery frame header is malformed: {error}")
    identity_payload, descriptors = _validate_frame_header(header, limits)
    files: dict[str, Path] = {}
    for item in descriptors:
        name = item["name"]
        destination = attempt_root / f"{secrets.token_hex(8)}-{name}"
        digest = hashlib.sha256()
        remaining = item["bytes"]
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(destination, flags, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    _fail(f"delivery file {name} was truncated")
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            output.flush()
            os.fsync(output.fileno())
        _require(digest.hexdigest() == item["sha256"], f"delivery file {name} digest mismatch")
        files[name] = destination
    return identity_payload, files, header["destination"]


def _load_identity_file(path: Path, repository_root: Path) -> Any:
    _assert_private_input(path, repository_root, "independently expected release identity", 128 * 1024)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"independently expected release identity is malformed: {error}")
    return identity_from_json(value)


def _extract_original_entries(snapshot: provenance.ZipSnapshot, identity: Any, output_root: Path) -> tuple[Path, Path, Path]:
    """Extract only the named archive and its two validator sidecars."""
    names = {identity.archive_name, f"{identity.archive_name}.sha256", f"{identity.archive_name}.manifest.json"}
    outputs: dict[str, Path] = {}
    try:
        provenance._preflight_zip_snapshot(snapshot)
        with os.fdopen(os.dup(snapshot.fd), "rb", closefd=True) as stream, ZipFile(stream) as archive:
            infos = {info.filename: info for info in archive.infolist()}
            _require(set(names).issubset(infos), "artifact-service ZIP is missing required attestation/manifest evidence")
            for name in names:
                info = infos[name]
                _require(not info.is_dir() and ".." not in name.split("/") and not name.startswith("/"), "required ZIP entry is unsafe")
                destination = output_root / name
                with archive.open(info, "r") as source, destination.open("xb") as target:
                    remaining = info.file_size
                    digest = hashlib.sha256()
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        _require(chunk, f"required ZIP entry {name} was truncated")
                        target.write(chunk)
                        digest.update(chunk)
                        remaining -= len(chunk)
                    target.flush()
                    os.fsync(target.fileno())
                outputs[name] = destination
    except BadZipFile as error:
        _fail(f"artifact-service ZIP is malformed: {error}")
    return outputs[identity.archive_name], outputs[f"{identity.archive_name}.sha256"], outputs[f"{identity.archive_name}.manifest.json"]


def _validate_inner_archive(archive: Path, checksum: Path, manifest: Path, identity: Any, staging: Path, expected_context: dict[str, Any] | None = None) -> None:
    validator = _load_validator()
    limits = validator.Limits()
    snapshot = validator.snapshot_source(archive, limits)
    try:
        _require(snapshot.digest == identity.archive_sha256 and snapshot.size == identity.archive_bytes, "inner archive identity does not match independently expected bytes")
        validator.validate_checksum(archive, checksum, snapshot.digest)
        validator.preflight_metadata(snapshot, limits)
        entries, metadata_files, file_hashes = validator.collect_entries(snapshot, limits)
        embedded = validator.read_json_bytes(metadata_files["runtime-artifact-manifest.json"], "embedded manifest")
        external = validator.read_sidecar_json(manifest, limits, "published manifest")
        context = expected_context or {}
        expected = argparse.Namespace(
            expected_sha=identity.source_sha,
            expected_platform=identity.platform,
            expected_repository=context.get("repository", identity.repository),
            expected_workflow=context.get("workflow_name"),
            expected_run_id=str(context.get("run_id", identity.run_id)),
            expected_run_attempt=str(context.get("run_attempt", identity.run_attempt)),
            expected_event=context.get("event", identity.event),
            expected_source_ref=context.get("source_ref", identity.source_ref),
            expected_base_image=identity.image,
            expected_base_image_digest=identity.image_digest,
        )
        validator.validate_manifest(embedded, archive.name, snapshot.size, snapshot.digest, expected, embedded=True)
        validator.validate_manifest(external, archive.name, snapshot.size, snapshot.digest, expected, embedded=False)
        validator.compare_manifests(embedded, external)
        _require(validator.archive_input_hashes(metadata_files, entries) == external["inputs"], "packaged input hashes or migration inventory do not match manifest")
        validator.extract_archive(snapshot, entries, file_hashes, staging, limits, snapshot.digest)
    finally:
        validator.cleanup_snapshot(snapshot)


def _safe_publication_name(identity: Any) -> str:
    token = _identity_digest(identity)
    return f"release-{token}"


def _fsync_tree(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    for path in sorted([root, *root.rglob("*")], key=lambda p: len(p.parts), reverse=True):
        if path.is_dir():
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)


def _rename_noreplace(source: Path, destination: Path) -> None:
    if os.name != "posix":
        _fail("atomic no-replacement directory publication requires Linux")
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
        if result == 0:
            return
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(destination)
        raise OSError(error, os.strerror(error))
    except AttributeError:
        _fail("Linux renameat2 no-replacement publication is unavailable")


def _read_json_file(path: Path, maximum: int, label: str) -> Any:
    _require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum, f"{label} is missing, substituted, or oversized")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"{label} is malformed: {error}")


def _payload_matches(path: Path, identity: Any) -> bool:
    try:
        metadata = os.lstat(path)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            return False
        if os.name == "posix" and (metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
            return False
        actual = identity_from_json(_read_json_file(path / "identity.json", 128 * 1024, "published identity"))
        if actual != identity:
            return False
        service_zip = path / "artifact-service.zip"
        digest, size = provenance._sha256_file(service_zip, MAX_SERVICE_ZIP_BYTES, "published artifact-service ZIP")
        if digest != identity.artifact_service_zip_sha256 or size != identity.artifact_service_zip_bytes:
            return False
        snapshot = provenance.open_zip_snapshot(service_zip)
        try:
            provenance.verify_artifact_service_zip_snapshot(snapshot, identity.artifact_service_zip_sha256, identity.artifact_service_zip_bytes)
            provenance.inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name, identity.archive_sha256, identity.archive_bytes)
        finally:
            provenance.close_zip_snapshot(snapshot)
        return True
    except (DeliveryError, provenance.ProvenanceError, OSError):
        return False


def _publish_payload(staging: Path, publication_root: Path, identity: Any) -> tuple[Path, bool]:
    destination = publication_root / _safe_publication_name(identity)
    _fsync_tree(staging)
    try:
        _rename_noreplace(staging, destination)
        descriptor = os.open(publication_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return destination, False
    except FileExistsError:
        _require(_payload_matches(destination, identity), "conflicting existing publication or incomplete publication")
        return destination, True


def _write_snapshot(snapshot: provenance.ZipSnapshot, destination: Path) -> None:
    descriptor = os.dup(snapshot.fd)
    try:
        with os.fdopen(descriptor, "rb", closefd=True) as source, destination.open("xb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
    except OSError as error:
        destination.unlink(missing_ok=True)
        _fail(f"verified artifact snapshot copy failed: {error}")


def _publication_payload(staging: Path, identity: Any, service_zip_snapshot: provenance.ZipSnapshot, bundle: Path | None) -> None:
    (staging / "identity.json").write_text(json.dumps(_identity_payload(identity), sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    target = staging / "artifact-service.zip"
    _write_snapshot(service_zip_snapshot, target)
    if bundle is not None:
        bundle_copy = staging / "attestation-bundle.json"
        _bounded_copy(bundle, bundle_copy, MAX_BUNDLE_BYTES, "attestation bundle")


def publish_development_delivery(
    *,
    service_zip: Path,
    attestation_bundle: Path,
    expected_identity: Any,
    trusted_root: Path,
    repository_root: Path,
    receiving_root: Path,
    publication_root: Path,
    offline_expectation: dict[str, Any],
    limits: DeliveryLimits = DeliveryLimits(),
) -> DeliveryResult:
    """Verify and publish isolated development evidence; never production."""
    _validate_delivery_identity(expected_identity)
    _require(expected_identity.artifact_class == provenance.DEVELOPMENT_ARTIFACT_CLASS, "development delivery cannot accept a production artifact class")
    _assert_external_directory(receiving_root, repository_root, "receiving workspace")
    _assert_external_directory(publication_root, repository_root, "publication directory")
    _require(receiving_root != publication_root, "receiving workspace and publication directory must be separate")
    _assert_private_input(service_zip, repository_root, "received artifact-service ZIP", limits.max_service_zip_bytes)
    _assert_private_input(attestation_bundle, repository_root, "received attestation bundle", limits.max_bundle_bytes)
    _assert_private_input(trusted_root, repository_root, "independently configured trusted root", limits.max_bundle_bytes)
    snapshot = provenance.open_zip_snapshot(service_zip)
    try:
        provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
        provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
        with _receiver_lock(receiving_root), tempfile.TemporaryDirectory(prefix="clashcookies-delivery-", dir=receiving_root) as temp_name:
            attempt = Path(temp_name)
            archive, checksum, manifest = _extract_original_entries(snapshot, expected_identity, attempt)
            staging = attempt / "validated-runtime"
            staging.mkdir(mode=0o700)
            _validate_inner_archive(archive, checksum, manifest, expected_identity, staging, offline_expectation)
            # The offline verifier is called only after the received bytes have
            # been snapshotted.  The caller's API-correlation metadata is kept
            # separate and must not be reconstructed from this payload.
            verified = provenance.run_gh_attestation_verify(
                archive,
                bundle=attestation_bundle,
                repository=offline_expectation["repository"],
                signer_workflow=offline_expectation["signer_workflow"],
                signer_revision=offline_expectation["signer_revision"],
                source_ref=offline_expectation["source_ref"],
                source_sha=offline_expectation["source_sha"],
                verifier_version=offline_expectation.get("verifier_version", provenance.SUPPORTED_GH_VERSION),
                custom_trusted_root=trusted_root,
                offline=True,
            repository_root=repository_root,
            )
            provenance.validate_verified_result(verified, archive_name=expected_identity.archive_name, archive_digest=expected_identity.archive_sha256, archive_bytes=expected_identity.archive_bytes, expected=offline_expectation, run_metadata=None, require_run_metadata=False)
            payload = attempt / "payload"
            payload.mkdir(mode=0o700)
            _publication_payload(payload, expected_identity, snapshot, attestation_bundle)
            destination, retry = _publish_payload(payload, publication_root, expected_identity)
    finally:
        provenance.close_zip_snapshot(snapshot)
    return DeliveryResult("retry-success" if retry else "published", str(destination), _identity_digest(expected_identity), expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes, expected_identity.archive_sha256, expected_identity.archive_bytes, True, False)


def publish_synthetic_authorized_delivery_for_test(
    *,
    service_zip: Path,
    expected_identity: provenance.TrustedReleaseIdentity,
    authorization_envelope: Any,
    trust: provenance.AuthorizationTrustConfig,
    revision_allowlist: provenance.AuthorizationRevisionAllowlist,
    journal: provenance.AuthorizationReplayJournal,
    repository_root: Path,
    receiving_root: Path,
    publication_root: Path,
    operation: str = "forward-release",
    now: Any = None,
) -> DeliveryResult:
    """Synthetic Ed25519 delivery seam used only by isolated regression tests.

    It reserves the existing journal before publication and deliberately never
    calls ``consume``.  No CLI or production eligibility path invokes this
    helper.
    """
    _require(operation in {"forward-release", "recovery-release"}, "synthetic authorization operation is invalid")
    _require(expected_identity.artifact_class == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "synthetic authorization requires the production-shaped test identity")
    _assert_external_directory(receiving_root, repository_root, "receiving workspace")
    _assert_external_directory(publication_root, repository_root, "publication directory")
    _require(receiving_root != publication_root, "receiving workspace and publication directory must be separate")
    _assert_private_input(service_zip, repository_root, "received artifact-service ZIP", MAX_SERVICE_ZIP_BYTES)
    snapshot = provenance.open_zip_snapshot(service_zip)
    try:
        provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
        provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
        journal.reserve(authorization_envelope, expected_identity, revision_allowlist, trust, operation=operation, now=now)
        with _receiver_lock(receiving_root), tempfile.TemporaryDirectory(prefix="clashcookies-synthetic-delivery-", dir=receiving_root) as temp_name:
            attempt = Path(temp_name)
            payload = attempt / "payload"
            payload.mkdir(mode=0o700)
            _publication_payload(payload, expected_identity, snapshot, None)
            destination, retry = _publish_payload(payload, publication_root, expected_identity)
    finally:
        provenance.close_zip_snapshot(snapshot)
    return DeliveryResult("retry-success" if retry else "published", str(destination), _identity_digest(expected_identity), expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes, expected_identity.archive_sha256, expected_identity.archive_bytes, False, True)


def _ssh_stream(endpoint: SshDeliveryEndpoint, repository_root: Path, header: bytes, files: list[tuple[str, Path, int]], limits: DeliveryLimits) -> str:
    _validate_endpoint(endpoint, repository_root)
    command = [
        "ssh", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-o", "ForwardAgent=no",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={endpoint.known_hosts}",
        "-o", f"IdentityFile={endpoint.identity_file}", "-o", "IdentitiesOnly=yes", "-o", "ConnectionAttempts=1",
        "-o", f"ConnectTimeout={endpoint.connect_timeout_seconds}", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1",
        "-p", str(endpoint.port), f"{endpoint.user}@{endpoint.host}", "python3", "-m", "trusted_ssh_artifact_delivery", "receive",
        "--repository-root", endpoint.remote_repository_root,
        "--receiving-root", endpoint.remote_receiving_root,
        "--publication-root", endpoint.remote_publication_root,
        "--expected-identity", endpoint.remote_expected_identity,
        "--trusted-root", endpoint.remote_trusted_root,
        "--offline-expectation", endpoint.remote_offline_expectation,
    ]
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        _fail(f"OpenSSH transport is unavailable: {error}")
    assert process.stdin and process.stdout and process.stderr
    stdout = bytearray()
    stderr = bytearray()
    write_error: list[BaseException] = []

    def writer() -> None:
        try:
            _write_frame(process.stdin, header, files)
            process.stdin.close()
        except BaseException as error:
            write_error.append(error)
            try:
                process.stdin.close()
            except OSError:
                pass

    thread = threading.Thread(target=writer, name="trusted-ssh-artifact-writer", daemon=True)
    thread.start()
    deadline = time.monotonic() + endpoint.execution_timeout_seconds
    while process.poll() is None:
        if time.monotonic() > deadline:
            process.kill()
            process.wait(timeout=2)
            _fail("bounded SSH artifact delivery timed out")
        stdout.extend(process.stdout.read1(4096) if process.stdout.peek(1) else b"")
        stderr.extend(process.stderr.read1(4096) if process.stderr.peek(1) else b"")
        if len(stdout) > limits.max_subprocess_output_bytes or len(stderr) > limits.max_subprocess_output_bytes:
            process.kill()
            process.wait(timeout=2)
            _fail("SSH receiver output exceeds the limit")
        time.sleep(0.01)
    thread.join(timeout=2)
    stdout.extend(process.stdout.read()[: limits.max_subprocess_output_bytes + 1])
    stderr.extend(process.stderr.read()[: limits.max_subprocess_output_bytes + 1])
    _require(not write_error, f"SSH artifact stream failed: {write_error[0] if write_error else ''}")
    _require(len(stdout) <= limits.max_subprocess_output_bytes and len(stderr) <= limits.max_subprocess_output_bytes, "SSH receiver output exceeds the limit")
    _require(process.returncode == 0, f"SSH artifact receiver failed: {bytes(stderr).decode('utf-8', 'replace')[-400:]}")
    return bytes(stdout).decode("utf-8", "replace")


def deliver_exact_artifact_over_ssh(endpoint: SshDeliveryEndpoint, service_zip: Path, identity: Any, repository_root: Path, *, attestation_bundle: Path | None = None, authorization_envelope: Path | None = None, limits: DeliveryLimits = DeliveryLimits()) -> str:
    """Transfer the original ZIP and bounded evidence through fixed OpenSSH args."""
    _validate_delivery_identity(identity)
    _validate_endpoint(endpoint, repository_root)
    _assert_private_input(service_zip, repository_root, "original artifact-service ZIP", limits.max_service_zip_bytes)
    snapshot = provenance.open_zip_snapshot(service_zip)
    try:
        provenance.verify_artifact_service_zip_snapshot(snapshot, identity.artifact_service_zip_sha256, identity.artifact_service_zip_bytes)
        provenance.inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name, identity.archive_sha256, identity.archive_bytes)
    finally:
        provenance.close_zip_snapshot(snapshot)
    files: list[tuple[str, Path, int]] = [("artifact-service.zip", service_zip, snapshot.size)]
    if attestation_bundle is not None:
        _assert_private_input(attestation_bundle, repository_root, "attestation bundle", limits.max_bundle_bytes)
        files.append(("attestation-bundle.json", attestation_bundle, attestation_bundle.stat().st_size))
    if authorization_envelope is not None:
        _assert_private_input(authorization_envelope, repository_root, "authorization envelope", limits.max_authorization_bytes)
        files.append(("authorization-envelope.json", authorization_envelope, authorization_envelope.stat().st_size))
    header = _frame_header_without_destination(identity, files, endpoint.destination)
    return _ssh_stream(endpoint, repository_root, header, files, limits)


def _frame_header_without_destination(identity: provenance.TrustedReleaseIdentity, files: list[tuple[str, Path, int]], destination: str) -> bytes:
    value = {
        "contract": DELIVERY_CONTRACT,
        "version": DELIVERY_VERSION,
        "destination": destination,
        "identity": _identity_payload(identity),
        "identitySha256": _identity_digest(identity),
        "files": [{"name": name, "bytes": size, "sha256": _sha256_path(path, size)} for name, path, size in files],
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def receive_command(args: argparse.Namespace) -> int:
    repository_root = Path(args.repository_root)
    receiving_root = Path(args.receiving_root)
    publication_root = Path(args.publication_root)
    expected_identity = _load_identity_file(Path(args.expected_identity), repository_root)
    _assert_external_directory(receiving_root, repository_root, "receiving workspace")
    _assert_external_directory(publication_root, repository_root, "publication directory")
    _require(receiving_root != publication_root, "receiving workspace and publication directory must be separate")
    with _receiver_lock(receiving_root), tempfile.TemporaryDirectory(prefix="clashcookies-receive-", dir=receiving_root) as temp_name:
        attempt = Path(temp_name)
        identity_payload, files, frame_destination = _read_frame(sys.stdin.buffer, attempt, DeliveryLimits())
        _require(identity_payload == _identity_payload(expected_identity), "received identity is not the independently expected identity")
        # The destination is data, not shell syntax.  It is still bound to the
        # owner-configured receiver root before any bytes are accepted.
        _require(frame_destination == str(publication_root), "received destination is not the owner-configured publication directory")
        service_zip = files["artifact-service.zip"]
        # The operational receiver is intentionally development-evidence only.
        # Synthetic authorization publication is a direct test API and is not
        # an SSH command-line acceptance switch.
        _require(expected_identity.artifact_class == provenance.DEVELOPMENT_ARTIFACT_CLASS, "operational SSH receiver accepts development evidence only")
        _require("attestation-bundle.json" in files, "development delivery requires an attestation bundle")
        _require(args.trusted_root is not None and args.offline_expectation is not None, "receiver requires independently configured offline trust inputs")
        trusted_root = Path(args.trusted_root)
        expectation_path = Path(args.offline_expectation)
        _assert_private_input(trusted_root, repository_root, "independently configured trusted root", MAX_BUNDLE_BYTES)
        _assert_private_input(expectation_path, repository_root, "offline verification expectation", MAX_HEADER_BYTES)
        expectation = _read_json_file(expectation_path, MAX_HEADER_BYTES, "offline verification expectation")
        _require(isinstance(expectation, dict), "offline verification expectation must be an object")
        snapshot = provenance.open_zip_snapshot(service_zip)
        try:
            provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
            provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
            archive, checksum, manifest = _extract_original_entries(snapshot, expected_identity, attempt)
            staging = attempt / "validated-runtime"
            staging.mkdir(mode=0o700)
            _validate_inner_archive(archive, checksum, manifest, expected_identity, staging, expectation)
            verified = provenance.run_gh_attestation_verify(
                archive,
                bundle=files["attestation-bundle.json"],
                repository=expectation["repository"],
                signer_workflow=expectation["signer_workflow"],
                signer_revision=expectation["signer_revision"],
                source_ref=expectation["source_ref"],
                source_sha=expectation["source_sha"],
                verifier_version=expectation.get("verifier_version", provenance.SUPPORTED_GH_VERSION),
                custom_trusted_root=trusted_root,
                offline=True,
                repository_root=repository_root,
            )
            provenance.validate_verified_result(verified, archive_name=expected_identity.archive_name, archive_digest=expected_identity.archive_sha256, archive_bytes=expected_identity.archive_bytes, expected=expectation, run_metadata=None, require_run_metadata=False)
            payload = attempt / "payload"
            payload.mkdir(mode=0o700)
            _publication_payload(payload, expected_identity, snapshot, files["attestation-bundle.json"])
            destination, retry = _publish_payload(payload, publication_root, expected_identity)
            result = DeliveryResult("retry-success" if retry else "published", str(destination), _identity_digest(expected_identity), expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes, expected_identity.archive_sha256, expected_identity.archive_bytes, True, False)
            print(json.dumps(asdict(result), sort_keys=True))
            return 0
        finally:
            provenance.close_zip_snapshot(snapshot)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    receiver = subparsers.add_parser("receive")
    receiver.add_argument("--repository-root", required=True)
    receiver.add_argument("--receiving-root", required=True)
    receiver.add_argument("--publication-root", required=True)
    receiver.add_argument("--expected-identity", required=True)
    receiver.add_argument("--trusted-root")
    receiver.add_argument("--offline-expectation")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        args = parse_args()
        if args.command == "receive":
            raise SystemExit(receive_command(args))
    except (DeliveryError, provenance.ProvenanceError, OSError, ValueError, BadZipFile) as error:
        print(f"[trusted-ssh-artifact-delivery] failed: {error}", file=sys.stderr)
        raise SystemExit(1)
