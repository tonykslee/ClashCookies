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
import queue
import re
import secrets
import select
import shutil
import signal
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
MAX_BUNDLE_BYTES = provenance.MAX_BUNDLE_BYTES
MAX_AGGREGATE_BYTES = MAX_SERVICE_ZIP_BYTES + provenance.MAX_BUNDLE_BYTES + provenance.MAX_AUTHORIZATION_RECORD_BYTES
MAX_RECEIVING_SECONDS = 180
MAX_SSH_OUTPUT_BYTES = 64 * 1024
MAX_TEMPORARY_BYTES = MAX_SERVICE_ZIP_BYTES + provenance.MAX_BUNDLE_BYTES + provenance.MAX_ARCHIVE_BYTES
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
    max_temporary_bytes: int = MAX_TEMPORARY_BYTES


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
    # The validator declares dataclasses whose decorator resolves the module
    # through sys.modules while the module is executing.
    sys.modules[spec.name] = module
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
    _assert_safe_ancestors(path, label)
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid(), f"{label} is not owner-controlled")
        _require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private")


def _assert_safe_ancestors(path: Path, label: str) -> None:
    current = path if path.is_dir() else path.parent
    for ancestor in (current, *current.parents):
        try:
            metadata = os.lstat(ancestor)
        except OSError as error:
            _fail(f"{label} ancestor is unavailable: {error}")
        _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} ancestor is not a real directory")


def _assert_non_overlapping(paths: list[tuple[Path, str]]) -> None:
    absolute = [(path.absolute(), label) for path, label in paths]
    for index, (left, left_label) in enumerate(absolute):
        for right, right_label in absolute[index + 1:]:
            try:
                left.relative_to(right)
                overlap = True
            except ValueError:
                try:
                    right.relative_to(left)
                    overlap = True
                except ValueError:
                    overlap = False
            _require(not overlap, f"{left_label} and {right_label} overlap")


def _attempt_bytes(root: Path, maximum: int) -> int:
    total = 0
    for path in root.rglob("*"):
        _require(not path.is_symlink(), "receiving attempt contains a symlink")
        if path.is_file():
            total += path.stat().st_size
            _require(total <= maximum, "receiving temporary storage exceeds the limit")
    return total


def _assert_private_input(path: Path, repository_root: Path, label: str, maximum: int) -> None:
    provenance._require_external_path(path, repository_root, label)
    _assert_safe_ancestors(path, label)
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
    _require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,252}", endpoint.host or "") is not None, "SSH host is malformed")
    _require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", endpoint.user or "") is not None, "SSH user is malformed")
    _require(all(ord(ch) >= 0x20 and ch not in "\r\n\x7f" for ch in endpoint.host + endpoint.user), "SSH host or user contains control characters")
    _require(1 <= endpoint.port <= 65535, "SSH port is out of range")
    _require(1 <= endpoint.connect_timeout_seconds <= 60, "SSH connect timeout is out of bounds")
    _require(1 <= endpoint.execution_timeout_seconds <= MAX_RECEIVING_SECONDS, "SSH execution timeout is out of bounds")
    _assert_private_input(endpoint.known_hosts, repository_root, "trusted known_hosts", 1024 * 1024)
    _assert_private_input(endpoint.identity_file, repository_root, "disposable SSH identity", 1024 * 1024)
    _require(endpoint.destination.startswith("/") and "\x00" not in endpoint.destination and ".." not in Path(endpoint.destination).parts, "SSH destination must be an absolute normalized path")
    for value, label in ((endpoint.remote_repository_root, "remote repository root"), (endpoint.remote_receiving_root, "remote receiving root"), (endpoint.remote_publication_root, "remote publication root"), (endpoint.remote_expected_identity, "remote expected identity"), (endpoint.remote_trusted_root, "remote trusted root"), (endpoint.remote_offline_expectation, "remote offline expectation")):
        _require(value.startswith("/") and all(ch.isalnum() or ch in "_./:-" for ch in value) and ".." not in Path(value).parts, f"{label} must be an explicit normalized absolute path")
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


@contextmanager
def _receiver_deadline(seconds: int) -> Iterator[float]:
    deadline = time.monotonic() + seconds
    old_handler = None
    old_timer = (0.0, 0.0)
    enabled = os.name == "posix" and threading.current_thread() is threading.main_thread() and hasattr(signal, "setitimer")
    if enabled:
        def timeout_handler(_signum: int, _frame: Any) -> None:
            _fail("receiver elapsed-time deadline exceeded")
        old_handler = signal.signal(signal.SIGALRM, timeout_handler)
        old_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield deadline
    finally:
        if enabled:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
            if old_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, old_timer[0], old_timer[1])


def _read_exact(stream: BinaryIO, size: int, deadline: float | None = None) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        if deadline is not None:
            remaining_time = deadline - time.monotonic()
            _require(remaining_time > 0, "delivery stream read deadline exceeded")
            try:
                fileno = stream.fileno()
            except (AttributeError, OSError):
                fileno = None
            if fileno is not None:
                readable, _, _ = select.select([fileno], [], [], remaining_time)
                _require(readable, "delivery stream read deadline exceeded")
        chunk = stream.read(remaining)
        if not chunk:
            _fail("delivery stream ended before the bounded frame completed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_optional_byte(stream: BinaryIO, deadline: float | None = None) -> bytes:
    if deadline is not None:
        remaining_time = deadline - time.monotonic()
        _require(remaining_time > 0, "delivery stream end-of-frame deadline exceeded")
        try:
            fileno = stream.fileno()
        except (AttributeError, OSError):
            fileno = None
        if fileno is not None:
            readable, _, _ = select.select([fileno], [], [], remaining_time)
            _require(readable, "delivery stream end-of-frame deadline exceeded")
    return stream.read(1)


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


def _read_frame(stream: BinaryIO, attempt_root: Path, limits: DeliveryLimits, deadline: float | None = None) -> tuple[dict[str, Any], dict[str, Path], str]:
    _require(_read_exact(stream, len(FRAME_MAGIC), deadline) == FRAME_MAGIC, "delivery frame magic is invalid")
    header_size = int.from_bytes(_read_exact(stream, 4, deadline), "big")
    _require(0 < header_size <= MAX_HEADER_BYTES, "delivery frame header size is out of bounds")
    try:
        header = json.loads(_read_exact(stream, header_size, deadline).decode("utf-8"))
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
                chunk = _read_exact(stream, min(1024 * 1024, remaining), deadline)
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            output.flush()
            os.fsync(output.fileno())
        _require(digest.hexdigest() == item["sha256"], f"delivery file {name} digest mismatch")
        files[name] = destination
        _attempt_bytes(attempt_root, limits.max_temporary_bytes)
    # The sender must close its input after exactly the declared frame.  This
    # rejects appended frames, padding, and unexpected control data.
    _require(_read_optional_byte(stream, deadline) == b"", "delivery frame contains trailing data")
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
        duplicate = os.dup(snapshot.fd)
        os.lseek(duplicate, 0, os.SEEK_SET)
        with os.fdopen(duplicate, "rb", closefd=True) as stream, ZipFile(stream) as archive:
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
        _require(not path.is_symlink(), "publication staging contains a symlink")
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


def _rename_noreplace(directory_fd: int, source_name: str, destination_name: str) -> None:
    if os.name != "posix":
        _fail("atomic no-replacement directory publication requires Linux")
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2")
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(directory_fd, os.fsencode(source_name), directory_fd, os.fsencode(destination_name), 1)
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


def _payload_matches(path: Path, identity: Any, expected_bundle: tuple[str, int] | None = None, expected_authorization: tuple[str, int] | None = None) -> bool:
    try:
        metadata = os.lstat(path)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            return False
        if os.name == "posix" and (metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
            return False
        expected_names = {"identity.json", "artifact-service.zip"} | ({"attestation-bundle.json"} if expected_bundle is not None else set()) | ({"authorization-envelope.json"} if expected_authorization is not None else set())
        if {child.name for child in path.iterdir()} != expected_names:
            return False
        actual = identity_from_json(_read_json_file(path / "identity.json", 128 * 1024, "published identity"))
        if actual != identity:
            return False
        service_zip = path / "artifact-service.zip"
        digest, size = provenance._sha256_file(service_zip, MAX_SERVICE_ZIP_BYTES, "published artifact-service ZIP")
        if digest != identity.artifact_service_zip_sha256 or size != identity.artifact_service_zip_bytes:
            return False
        if expected_bundle is not None:
            bundle_digest, bundle_size = provenance._sha256_file(path / "attestation-bundle.json", MAX_BUNDLE_BYTES, "published attestation bundle")
            if (bundle_digest, bundle_size) != expected_bundle:
                return False
        if expected_authorization is not None:
            authorization_digest, authorization_size = provenance._sha256_file(path / "authorization-envelope.json", provenance.MAX_AUTHORIZATION_RECORD_BYTES, "published authorization envelope")
            if (authorization_digest, authorization_size) != expected_authorization:
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


def _fsync_existing_publication(path: Path, expected_bundle: tuple[str, int] | None, expected_authorization: tuple[str, int] | None) -> None:
    for name in ("identity.json", "artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json"):
        candidate = path / name
        if candidate.exists():
            descriptor = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    if expected_bundle is not None:
        _require((provenance._sha256_file(path / "attestation-bundle.json", MAX_BUNDLE_BYTES, "published attestation bundle")) == expected_bundle, "published attestation bundle changed before retry acknowledgment")
    if expected_authorization is not None:
        _require((provenance._sha256_file(path / "authorization-envelope.json", provenance.MAX_AUTHORIZATION_RECORD_BYTES, "published authorization envelope")) == expected_authorization, "published authorization evidence changed before retry acknowledgment")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish_payload(staging: Path, publication_root: Path, identity: Any, expected_bundle: tuple[str, int] | None = None, expected_authorization: tuple[str, int] | None = None) -> tuple[Path, bool]:
    destination = publication_root / _safe_publication_name(identity)
    _require(staging.parent.absolute() == publication_root.absolute(), "publication staging must be directly inside the configured publication directory")
    _fsync_tree(staging)
    root_metadata = os.lstat(publication_root)
    root_descriptor = os.open(publication_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened_metadata = os.fstat(root_descriptor)
        _require((opened_metadata.st_dev, opened_metadata.st_ino) == (root_metadata.st_dev, root_metadata.st_ino), "publication directory changed during open")
        _rename_noreplace(root_descriptor, staging.name, destination.name)
        os.fsync(root_descriptor)
        current_metadata = os.lstat(publication_root)
        _require((current_metadata.st_dev, current_metadata.st_ino) == (root_metadata.st_dev, root_metadata.st_ino), "publication directory changed during publication")
        _require(_payload_matches(destination, identity, expected_bundle, expected_authorization), "new publication failed retained-content verification")
        return destination, False
    except FileExistsError:
        _require(_payload_matches(destination, identity, expected_bundle, expected_authorization), "conflicting existing publication or incomplete publication")
        _fsync_existing_publication(destination, expected_bundle, expected_authorization)
        os.fsync(root_descriptor)
        return destination, True
    finally:
        os.close(root_descriptor)


def _write_snapshot(snapshot: provenance.ZipSnapshot, destination: Path) -> None:
    descriptor = os.dup(snapshot.fd)
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(descriptor, "rb", closefd=True) as source, destination.open("xb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            _require(size == snapshot.size and digest.hexdigest() == snapshot.digest, "verified artifact snapshot changed while copying")
            target.flush()
            os.fsync(target.fileno())
    except OSError as error:
        destination.unlink(missing_ok=True)
        _fail(f"verified artifact snapshot copy failed: {error}")


def _publication_payload(staging: Path, identity: Any, service_zip_snapshot: provenance.ZipSnapshot, bundle: Path | None, authorization_envelope: Any | None = None) -> tuple[tuple[str, int] | None, tuple[str, int] | None]:
    (staging / "identity.json").write_text(json.dumps(_identity_payload(identity), sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    target = staging / "artifact-service.zip"
    _write_snapshot(service_zip_snapshot, target)
    if bundle is not None:
        bundle_copy = staging / "attestation-bundle.json"
        bundle_result = _bounded_copy(bundle, bundle_copy, MAX_BUNDLE_BYTES, "attestation bundle")
    else:
        bundle_result = None
    if authorization_envelope is not None:
        authorization_copy = staging / "authorization-envelope.json"
        payload = provenance._canonical_json(authorization_envelope) + b"\n"
        authorization_copy.write_bytes(payload)
        descriptor = os.open(authorization_copy, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        authorization_result = hashlib.sha256(payload).hexdigest(), len(payload)
    else:
        authorization_result = None
    return bundle_result, authorization_result


def _assert_delivery_storage(receiving_root: Path, limits: DeliveryLimits) -> None:
    try:
        free = shutil.disk_usage(receiving_root).free
    except OSError as error:
        _fail(f"receiving storage availability cannot be checked: {error}")
    _require(free >= limits.max_temporary_bytes, "receiving storage does not have enough bounded temporary capacity")


@contextmanager
def _owned_temp_directory(parent: Path, prefix: str) -> Iterator[Path]:
    """Allocate and remove one attempt-owned directory under a stable parent."""
    parent_metadata = os.lstat(parent)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    parent_descriptor = os.open(parent, flags)
    temporary: Path | None = None
    try:
        opened = os.fstat(parent_descriptor)
        _require((opened.st_dev, opened.st_ino) == (parent_metadata.st_dev, parent_metadata.st_ino), "temporary directory parent changed during open")
        temporary = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
        current = os.lstat(parent)
        _require((current.st_dev, current.st_ino) == (parent_metadata.st_dev, parent_metadata.st_ino), "temporary directory parent changed during allocation")
        yield temporary
    finally:
        try:
            current = os.lstat(parent)
            opened = os.fstat(parent_descriptor)
            _require((current.st_dev, current.st_ino) == (parent_metadata.st_dev, parent_metadata.st_ino), "temporary directory parent changed during cleanup")
            _require((opened.st_dev, opened.st_ino) == (parent_metadata.st_dev, parent_metadata.st_ino), "temporary directory parent descriptor changed during cleanup")
            if temporary is not None and temporary.exists():
                metadata = os.lstat(temporary)
                _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), "attempt-owned temporary directory was substituted")
                shutil.rmtree(temporary)
        finally:
            os.close(parent_descriptor)


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
    _assert_non_overlapping([(receiving_root, "receiving workspace"), (publication_root, "publication directory"), (trusted_root, "trusted root")])
    _assert_delivery_storage(receiving_root, limits)
    _assert_private_input(service_zip, repository_root, "received artifact-service ZIP", limits.max_service_zip_bytes)
    _assert_private_input(attestation_bundle, repository_root, "received attestation bundle", limits.max_bundle_bytes)
    _assert_private_input(trusted_root, repository_root, "independently configured trusted root", limits.max_bundle_bytes)
    snapshot = provenance.open_zip_snapshot(service_zip)
    try:
        provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
        provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
        with _receiver_lock(receiving_root), _owned_temp_directory(receiving_root, "clashcookies-delivery-") as attempt:
            archive, checksum, manifest = _extract_original_entries(snapshot, expected_identity, attempt)
            staging = attempt / "validated-runtime"
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
                excluded_roots=(receiving_root, publication_root),
            )
            provenance.validate_verified_result(verified, archive_name=expected_identity.archive_name, archive_digest=expected_identity.archive_sha256, archive_bytes=expected_identity.archive_bytes, expected=offline_expectation, run_metadata=None, require_run_metadata=False)
            _attempt_bytes(attempt, limits.max_temporary_bytes)
            with _owned_temp_directory(publication_root, "clashcookies-publication-") as payload:
                expected_bundle, _ = _publication_payload(payload, expected_identity, snapshot, attestation_bundle)
                destination, retry = _publish_payload(payload, publication_root, expected_identity, expected_bundle)
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
    _assert_non_overlapping([(receiving_root, "receiving workspace"), (publication_root, "publication directory")])
    _assert_delivery_storage(receiving_root, DeliveryLimits())
    _assert_private_input(service_zip, repository_root, "received artifact-service ZIP", MAX_SERVICE_ZIP_BYTES)
    snapshot = provenance.open_zip_snapshot(service_zip)
    try:
        provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
        provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
        journal.reserve(authorization_envelope, expected_identity, revision_allowlist, trust, operation=operation, now=now)
        with _receiver_lock(receiving_root), _owned_temp_directory(receiving_root, "clashcookies-synthetic-delivery-") as attempt:
            with _owned_temp_directory(publication_root, "clashcookies-publication-") as payload:
                _, expected_authorization = _publication_payload(payload, expected_identity, snapshot, None, authorization_envelope)
                destination, retry = _publish_payload(payload, publication_root, expected_identity, expected_authorization=expected_authorization)
    finally:
        provenance.close_zip_snapshot(snapshot)
    return DeliveryResult("retry-success" if retry else "published", str(destination), _identity_digest(expected_identity), expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes, expected_identity.archive_sha256, expected_identity.archive_bytes, False, True)


def _ssh_stream(endpoint: SshDeliveryEndpoint, repository_root: Path, header: bytes, files: list[tuple[str, Path, int]], limits: DeliveryLimits) -> dict[str, Any]:
    _validate_endpoint(endpoint, repository_root)
    command = [
        "ssh", "-T", "-F", "none", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-o", "ForwardAgent=no",
        "-o", "ClearAllForwardings=yes", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "ControlMaster=no",
        "-o", "PermitLocalCommand=no", "-o", "GlobalKnownHostsFile=/dev/null",
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
    output_queues: dict[str, queue.Queue[bytes | None]] = {"stdout": queue.Queue(maxsize=32), "stderr": queue.Queue(maxsize=32)}
    output_done = {"stdout": False, "stderr": False}
    output_errors: list[BaseException] = []
    write_error: list[BaseException] = []
    stop = threading.Event()

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

    def drain(label: str, stream: BinaryIO) -> None:
        output_queue = output_queues[label]
        try:
            while not stop.is_set():
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                while not stop.is_set():
                    try:
                        output_queue.put(chunk, timeout=0.05)
                        break
                    except queue.Full:
                        continue
        except BaseException as error:
            output_errors.append(error)
        finally:
            while True:
                try:
                    output_queue.put_nowait(None)
                    break
                except queue.Full:
                    if stop.is_set():
                        break
                    time.sleep(0.01)

    writer_thread = threading.Thread(target=writer, name="trusted-ssh-artifact-writer", daemon=True)
    reader_threads = [threading.Thread(target=drain, args=(label, stream), name=f"trusted-ssh-artifact-{label}", daemon=True) for label, stream in (("stdout", process.stdout), ("stderr", process.stderr))]
    writer_thread.start()
    for reader_thread in reader_threads:
        reader_thread.start()
    deadline = time.monotonic() + endpoint.execution_timeout_seconds
    collected = {"stdout": bytearray(), "stderr": bytearray()}
    cleanup_error: BaseException | None = None
    try:
        while not all(output_done.values()):
            remaining = deadline - time.monotonic()
            _require(remaining > 0, "bounded SSH artifact delivery timed out")
            if write_error:
                _fail(f"SSH artifact stream failed: {write_error[0]}")
            if output_errors:
                _fail(f"SSH receiver output drain failed: {output_errors[0]}")
            for label in ("stdout", "stderr"):
                if output_done[label]:
                    continue
                try:
                    item = output_queues[label].get(timeout=min(0.05, remaining))
                except queue.Empty:
                    continue
                if item is None:
                    output_done[label] = True
                    continue
                collected[label].extend(item)
                _require(len(collected[label]) <= limits.max_subprocess_output_bytes, "SSH receiver output exceeds the limit")
        writer_thread.join(timeout=max(0.0, min(1.0, deadline - time.monotonic())))
        _require(not writer_thread.is_alive(), "SSH artifact writer did not terminate within the transport deadline")
        _require(not write_error, f"SSH artifact stream failed: {write_error[0] if write_error else ''}")
        process.wait(timeout=max(0.1, min(1.0, deadline - time.monotonic())))
        _require(process.returncode == 0, f"SSH artifact receiver failed: {bytes(collected['stderr']).decode('utf-8', 'replace')[-400:]}")
        try:
            acknowledgment = json.loads(bytes(collected["stdout"]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            _fail(f"SSH receiver acknowledgment is not structured JSON: {error}")
        _require(isinstance(acknowledgment, dict), "SSH receiver acknowledgment must be an object")
        return acknowledgment
    finally:
        stop.set()
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except OSError as error:
                cleanup_error = cleanup_error or error
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired) as error:
            cleanup_error = cleanup_error or error
        writer_thread.join(timeout=1)
        for reader_thread in reader_threads:
            reader_thread.join(timeout=1)
        if writer_thread.is_alive() or any(reader_thread.is_alive() for reader_thread in reader_threads):
            cleanup_error = cleanup_error or DeliveryError("SSH transport worker cleanup exceeded its bound")
        if cleanup_error is not None:
            _fail(f"SSH transport cleanup failed: {cleanup_error}")


def _validate_acknowledgment(acknowledgment: dict[str, Any], identity: Any, endpoint: SshDeliveryEndpoint) -> DeliveryResult:
    expected_fields = set(DeliveryResult.__dataclass_fields__)
    _require(set(acknowledgment) == expected_fields, "SSH receiver acknowledgment has unexpected fields")
    _require(acknowledgment["status"] in {"published", "retry-success"}, "SSH receiver acknowledgment status is not a successful publication result")
    _require(acknowledgment["identity_sha256"] == _identity_digest(identity), "SSH receiver acknowledgment identity does not match the request")
    _require(acknowledgment["artifact_service_zip_sha256"] == identity.artifact_service_zip_sha256 and acknowledgment["artifact_service_zip_bytes"] == identity.artifact_service_zip_bytes, "SSH receiver acknowledgment ZIP identity does not match the request")
    _require(acknowledgment["archive_sha256"] == identity.archive_sha256 and acknowledgment["archive_bytes"] == identity.archive_bytes, "SSH receiver acknowledgment archive identity does not match the request")
    _require(acknowledgment["offline_attestation"] is True and acknowledgment["authorization_reserved"] is False, "SSH receiver acknowledgment does not prove the required verification boundary")
    _require(isinstance(acknowledgment["publication"], str) and re.fullmatch(re.escape(endpoint.destination.rstrip("/")) + r"/release-[0-9a-f]{64}", acknowledgment["publication"]) is not None, "SSH receiver acknowledgment publication is outside the requested destination")
    try:
        return DeliveryResult(**acknowledgment)
    except TypeError as error:
        _fail(f"SSH receiver acknowledgment is malformed: {error}")


def deliver_exact_artifact_over_ssh(endpoint: SshDeliveryEndpoint, service_zip: Path, identity: Any, repository_root: Path, *, attestation_bundle: Path | None = None, authorization_envelope: Path | None = None, limits: DeliveryLimits = DeliveryLimits()) -> DeliveryResult:
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
    acknowledgment = _ssh_stream(endpoint, repository_root, header, files, limits)
    return _validate_acknowledgment(acknowledgment, identity, endpoint)


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
    _assert_non_overlapping([(receiving_root, "receiving workspace"), (publication_root, "publication directory")])
    limits = DeliveryLimits()
    _assert_delivery_storage(receiving_root, limits)
    with _receiver_deadline(limits.max_elapsed_seconds) as deadline, _receiver_lock(receiving_root), _owned_temp_directory(receiving_root, "clashcookies-receive-") as attempt:
        identity_payload, files, frame_destination = _read_frame(sys.stdin.buffer, attempt, limits, deadline)
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
        _assert_non_overlapping([(receiving_root, "receiving workspace"), (publication_root, "publication directory"), (trusted_root, "trusted root"), (expectation_path, "offline expectation")])
        expectation = _read_json_file(expectation_path, MAX_HEADER_BYTES, "offline verification expectation")
        _require(isinstance(expectation, dict), "offline verification expectation must be an object")
        snapshot = provenance.open_zip_snapshot(service_zip)
        try:
            provenance.verify_artifact_service_zip_snapshot(snapshot, expected_identity.artifact_service_zip_sha256, expected_identity.artifact_service_zip_bytes)
            provenance.inspect_artifact_service_zip_snapshot(snapshot, expected_identity.archive_name, expected_identity.archive_sha256, expected_identity.archive_bytes)
            archive, checksum, manifest = _extract_original_entries(snapshot, expected_identity, attempt)
            staging = attempt / "validated-runtime"
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
                excluded_roots=(receiving_root, publication_root),
            )
            provenance.validate_verified_result(verified, archive_name=expected_identity.archive_name, archive_digest=expected_identity.archive_sha256, archive_bytes=expected_identity.archive_bytes, expected=expectation, run_metadata=None, require_run_metadata=False)
            _attempt_bytes(attempt, limits.max_temporary_bytes)
            with tempfile.TemporaryDirectory(prefix="clashcookies-publication-", dir=publication_root) as publication_name:
                payload = Path(publication_name)
                expected_bundle, _ = _publication_payload(payload, expected_identity, snapshot, files["attestation-bundle.json"])
                destination, retry = _publish_payload(payload, publication_root, expected_identity, expected_bundle)
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
