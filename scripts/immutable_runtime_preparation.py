"""Prepare immutable candidate and legacy runtime material without activation.

This module is intentionally a consumer of the existing provenance, replay,
retention, and hardened archive-validation contracts.  It does not select an
artifact, issue or consume authorization, move active pointers, start Docker,
run Prisma, or decide production eligibility.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time
from typing import Any, Iterator

import durable_artifact_retention as retention
import runtime_artifact_provenance as provenance


PREPARATION_CONTRACT = "clashcookies.immutable-runtime-preparation"
PREPARATION_VERSION = 1
LEGACY_SOURCE_CONTRACT = "clashcookies.legacy-runtime-source"
LEGACY_SOURCE_VERSION = 1
MAX_SOURCE_METADATA_BYTES = 256 * 1024
MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024
MAX_RUNTIME_ENTRIES = 500_000
MAX_LEGACY_BYTES = 2 * 1024 * 1024 * 1024
MAX_LEGACY_ENTRIES = 500_000
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class PreparationError(RuntimeError):
    """Raised when preparation cannot safely establish durable custody."""


def _fail(message: str) -> None:
    raise PreparationError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _canonical(value: Any) -> bytes:
    try:
        return provenance._canonical_json(value)
    except (TypeError, ValueError) as error:
        _fail(f"preparation metadata is not canonical JSON: {error}")


def _read_json(path: Path, maximum: int, label: str, *, newline: bool = False) -> Any:
    try:
        raw = provenance._read_bounded_bytes(path, maximum, label)
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, provenance.ProvenanceError) as error:
        _fail(f"{label} is malformed: {error}")
    if newline:
        _require(raw == _canonical(value) + b"\n", f"{label} is not canonical")
    else:
        _require(raw in {_canonical(value), _canonical(value) + b"\n"}, f"{label} is not canonical")
    return value


def _private_dir(path: Path, label: str, *, create: bool = False) -> None:
    _require(path.is_absolute(), f"{label} must be absolute")
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        metadata = os.lstat(path)
    except OSError as error:
        _fail(f"{label} is unavailable: {error}")
    _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a real directory")
    if os.name == "posix":
        _require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private or owner-controlled")


def _external_dir(path: Path, repository_root: Path, label: str, *, create: bool = False) -> None:
    _private_dir(path, label, create=create)
    try:
        path.resolve().relative_to(repository_root.resolve())
    except ValueError:
        return
    _fail(f"{label} must be outside the mutable checkout")


def _stable_file(path: Path, maximum: int, label: str) -> tuple[bytes, os.stat_result]:
    try:
        before = os.lstat(path)
        _require(stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode), f"{label} must be a regular file")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        try:
            opened = os.fstat(descriptor)
            _require((opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size), f"{label} changed during open")
            _require(opened.st_size <= maximum, f"{label} exceeds its bound")
            chunks: list[bytes] = []
            remaining = opened.st_size
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                _require(chunk, f"{label} was truncated during read")
                chunks.append(chunk)
                remaining -= len(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        _require((after.st_dev, after.st_ino, after.st_size) == (opened.st_dev, opened.st_ino, opened.st_size), f"{label} changed during read")
        return b"".join(chunks), before
    except OSError as error:
        _fail(f"{label} cannot be read safely: {error}")


def _stream_file(path: Path, maximum: int, label: str, *, output: Any = None) -> tuple[str, int, os.stat_result]:
    """Hash a stable regular file without retaining its contents in memory."""
    try:
        before = os.lstat(path)
        _require(stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode), f"{label} must be a regular file")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        digest = hashlib.sha256()
        total = 0
        try:
            opened = os.fstat(descriptor)
            _require((opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size), f"{label} changed during open")
            _require(opened.st_size <= maximum, f"{label} exceeds its bound")
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, maximum - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                _require(total <= maximum, f"{label} exceeds its bound")
                digest.update(chunk)
                if output is not None:
                    output.write(chunk)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        _require((after.st_dev, after.st_ino, after.st_size) == (opened.st_dev, opened.st_ino, opened.st_size) and total == opened.st_size, f"{label} changed during read")
        return digest.hexdigest(), total, before
    except OSError as error:
        _fail(f"{label} cannot be read safely: {error}")


def _fsync_directory(path: Path, *, required: bool) -> None:
    if os.name != "posix":
        if required:
            _fail("directory durability is unavailable on this platform")
        return
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        os.fsync(descriptor)
    except OSError as error:
        if required:
            _fail(f"directory fsync failed: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _fsync_tree(path: Path, *, required: bool) -> None:
    def visit(current: Path) -> None:
        for entry in sorted(current.iterdir(), key=lambda item: item.name):
            metadata = os.lstat(entry)
            if stat.S_ISDIR(metadata.st_mode):
                visit(entry)
            elif stat.S_ISREG(metadata.st_mode):
                if os.name == "posix":
                    descriptor = os.open(entry, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
            elif stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(entry)
                _require(target and not os.path.isabs(target) and "\\" not in target, f"runtime symlink target is unsafe: {entry}")
            else:
                _fail(f"runtime tree contains an unsupported entry type: {entry}")
        _fsync_directory(current, required=required)
    visit(path)


def _runtime_rows(root: Path, *, maximum_bytes: int, maximum_entries: int) -> tuple[list[dict[str, Any]], int]:
    _private_dir(root, "runtime material")
    rows: list[dict[str, Any]] = []
    total_bytes = 0
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(directories)
        files[:] = sorted(files)
        for name in directories + files:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            metadata = os.lstat(path)
            if stat.S_ISDIR(metadata.st_mode):
                rows.append({"path": relative, "kind": "directory", "mode": stat.S_IMODE(metadata.st_mode)})
            elif stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(path)
                _require(target and not os.path.isabs(target) and "\\" not in target, f"runtime symlink target is unsafe: {relative}")
                resolved = (path.parent / target).resolve()
                try:
                    resolved.relative_to(root.resolve())
                except ValueError:
                    _fail(f"runtime symlink escapes its root: {relative}")
                rows.append({"path": relative, "kind": "symlink", "mode": stat.S_IMODE(metadata.st_mode), "target": target})
            elif stat.S_ISREG(metadata.st_mode):
                digest, size, opened = _stream_file(path, maximum_bytes - total_bytes, f"runtime file {relative}")
                total_bytes += size
                rows.append({"path": relative, "kind": "file", "mode": stat.S_IMODE(opened.st_mode), "bytes": size, "sha256": digest})
            else:
                _fail(f"runtime material contains an unsupported entry type: {relative}")
            _require(len(rows) <= maximum_entries, "runtime material exceeds the entry bound")
            _require(total_bytes <= maximum_bytes, "runtime material exceeds the byte bound")
    rows.sort(key=lambda item: item["path"])
    return rows, total_bytes


def _integrity(root: Path, *, maximum_bytes: int = MAX_RUNTIME_BYTES, maximum_entries: int = MAX_RUNTIME_ENTRIES) -> dict[str, Any]:
    rows, total_bytes = _runtime_rows(root, maximum_bytes=maximum_bytes, maximum_entries=maximum_entries)
    return {"tree_sha256": hashlib.sha256(_canonical(rows)).hexdigest(), "bytes": total_bytes, "entries": len(rows)}


def _validate_legacy_runtime_contents(root: Path, startup: dict[str, Any]) -> None:
    """Require the concrete restart inputs, not a caller's file-presence claim."""
    required_files = (
        "dist/ClashCookies.js",
        "node_modules/@prisma/client/default.js",
        "node_modules/.prisma/client/index.js",
        "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
        "node_modules/prisma/build/index.js",
        "prisma/schema.prisma",
        "package.json",
        "yarn.lock",
        "startup/container-start.sh",
    )
    for relative in required_files:
        path = root / relative
        _require(path.is_file() and not path.is_symlink(), f"legacy runtime is missing required regular input: {relative}")
        _require(path.stat().st_size > 0, f"legacy runtime required input is empty: {relative}")
    package_raw, _ = _stable_file(root / "package.json", 4 * 1024 * 1024, "legacy package.json")
    try:
        package = json.loads(package_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"legacy package.json is malformed: {error}")
    _require(isinstance(package, dict) and isinstance(package.get("scripts"), dict) and isinstance(package["scripts"].get("start:runtime"), str) and package["scripts"]["start:runtime"], "legacy package/startup contract is incomplete")
    startup_path = root / "startup/container-start.sh"
    _require(stat.S_IMODE(startup_path.stat().st_mode) & 0o111, "legacy startup input is not executable")
    migrations = root / "prisma/migrations"
    _require(migrations.is_dir() and any(path.is_file() and path.name == "migration.sql" for path in migrations.rglob("migration.sql")), "legacy runtime has no Prisma migration material")
    prisma_link = root / "node_modules/.bin/prisma"
    _require(prisma_link.is_symlink(), "legacy runtime Prisma CLI entry is not a symlink")
    target = prisma_link.resolve()
    _require(target.is_file() and stat.S_IMODE(target.stat().st_mode) & 0o111, "legacy runtime Prisma CLI symlink target is not executable")
    _require(startup.get("entrypoint") == "startup/container-start.sh" or startup.get("entrypoint") == "ops/deploy/container-start.sh", "legacy startup entrypoint is not the repository runtime wrapper")


def _publish_directory_no_replace(source: Path, destination: Path, *, durable: bool) -> None:
    _require(not destination.exists() and not destination.is_symlink(), f"publication destination already exists: {destination}")
    if os.name == "posix" and hasattr(ctypes.CDLL(None), "syscall"):
        libc = ctypes.CDLL(None, use_errno=True)
        syscall = libc.syscall
        syscall.restype = ctypes.c_long
        # Linux x86_64 and arm64 both use these stable syscall numbers.
        number = 316 if os.uname().machine in {"x86_64", "amd64"} else 276
        result = syscall(number, ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(source)), ctypes.c_int(-100), ctypes.c_char_p(os.fsencode(destination)), ctypes.c_uint(1))
        if result != 0:
            error = ctypes.get_errno()
            if error == errno.EEXIST:
                _fail("immutable publication destination appeared during no-replacement publication")
            _fail(f"immutable directory publication failed: {os.strerror(error)}")
    else:
        _require(not durable, "descriptor-safe no-replacement publication is unavailable on this platform")
        try:
            os.rename(source, destination)
        except OSError as error:
            _fail(f"immutable directory publication failed: {error}")
    _fsync_directory(destination, required=durable)
    _fsync_directory(destination.parent, required=durable)


def _write_private(path: Path, value: Any, *, durable: bool) -> None:
    payload = _canonical(value) + b"\n"
    temporary = path.parent / f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}"
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.write(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.link(temporary, path)
        temporary.unlink(missing_ok=True)
        _fsync_directory(path.parent, required=durable)
    except FileExistsError:
        _fail(f"metadata destination already exists: {path}")
    except OSError as error:
        _fail(f"metadata publication failed: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _safe_component(path: Path, label: str) -> None:
    _require(path.is_absolute(), f"{label} must be absolute")
    metadata = os.lstat(path)
    _require(not stat.S_ISLNK(metadata.st_mode), f"{label} must not be a symlink")
    _require(stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode), f"{label} must be a directory or regular file")


def _copy_entry(source: Path, destination: Path, *, max_bytes: int, counters: dict[str, int], source_root: Path) -> None:
    metadata = os.lstat(source)
    _require(not stat.S_ISLNK(metadata.st_mode) or source != source_root, f"legacy source root is a symlink: {source}")
    if stat.S_ISDIR(metadata.st_mode):
        destination.mkdir(mode=stat.S_IMODE(metadata.st_mode), parents=False, exist_ok=False)
        for child in sorted(source.iterdir(), key=lambda item: item.name):
            _copy_entry(child, destination / child.name, max_bytes=max_bytes, counters=counters, source_root=source_root)
        os.chmod(destination, stat.S_IMODE(metadata.st_mode))
    elif stat.S_ISREG(metadata.st_mode):
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(metadata.st_mode))
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as output:
                digest, size, opened = _stream_file(source, max_bytes - counters["bytes"], f"legacy source {source}", output=output)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.chmod(destination, stat.S_IMODE(opened.st_mode))
        counters["bytes"] += size
    elif stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(source)
        _require(target and not os.path.isabs(target) and "\\" not in target, f"legacy source symlink is unsafe: {source}")
        resolved = (source.parent / target).resolve()
        try:
            resolved.relative_to(source_root.resolve())
        except ValueError:
            _fail(f"legacy source symlink escapes its source root: {source}")
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.symlink(target, destination)
    else:
        _fail(f"legacy source contains an unsupported entry type: {source}")
    counters["entries"] += 1
    _require(counters["entries"] <= MAX_LEGACY_ENTRIES and counters["bytes"] <= max_bytes, "legacy source exceeds bounded preservation limits")


def _legacy_components(source: dict[str, Any], repository_root: Path) -> dict[str, Path]:
    _require(set(source) >= {"contract", "version", "container_id", "checkout_revision", "image", "image_digest", "platform", "startup", "components"}, "legacy source evidence is incomplete")
    _require(source["contract"] == LEGACY_SOURCE_CONTRACT and source["version"] == LEGACY_SOURCE_VERSION, "legacy source evidence contract is unsupported")
    _require(isinstance(source["container_id"], str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", source["container_id"]), "legacy container identity is malformed")
    _require(isinstance(source["checkout_revision"], str) and GIT_SHA_RE.fullmatch(source["checkout_revision"]), "legacy checkout revision is not an exact SHA")
    _require(isinstance(source["platform"], str) and source["platform"] == "linux/amd64", "legacy runtime platform is unsupported")
    _require(isinstance(source["image"], str) and "@sha256:" in source["image"], "legacy image identity must be digest-pinned")
    image_digest = source["image"].rsplit("@", 1)[1]
    _require(source["image_digest"] == image_digest and bool(re.fullmatch(r"sha256:[0-9a-f]{64}", image_digest)), "legacy image digest does not match the exact image identity")
    startup = source["startup"]
    _require(isinstance(startup, dict) and startup.get("prebuilt") is True and startup.get("migrations") == "deferred" and isinstance(startup.get("entrypoint"), str) and startup["entrypoint"], "legacy startup contract is incomplete")
    components = source["components"]
    _require(isinstance(components, dict), "legacy runtime components are missing")
    aliases = {"package_json": "package.json", "yarn_lock": "yarn.lock", "container_start": "startup/container-start.sh"}
    required = {"dist", "node_modules", "prisma", "package.json", "yarn.lock", "startup"}
    normalized: dict[str, Path] = {}
    for raw_name, value in components.items():
        name = aliases.get(raw_name, raw_name)
        destination = "startup/container-start.sh" if name == "startup" else name
        if isinstance(value, dict):
            _require(set(value) == {"source", "destination"}, f"legacy component {raw_name} is malformed")
            destination = value["destination"]
            value = value["source"]
        _require(isinstance(value, str) and isinstance(destination, str) and destination and ".." not in Path(destination).parts and not Path(destination).is_absolute(), f"legacy component {raw_name} is malformed")
        path = Path(value)
        _safe_component(path, f"legacy component {raw_name}")
        _require(destination not in normalized, f"legacy source has an ambiguous component destination: {destination}")
        normalized[destination] = path
    allowed = {"dist", "node_modules", "prisma", "package.json", "yarn.lock", "startup/container-start.sh"}
    _require(set(normalized) >= allowed and set(normalized) <= allowed, "legacy source does not describe exactly the bounded restartable runtime")
    return normalized


def _mapped_integrity(components: dict[str, Path]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    total_bytes = 0
    total_entries = 0

    def visit(source: Path, destination: str, source_root: Path) -> None:
        nonlocal total_bytes, total_entries
        metadata = os.lstat(source)
        if stat.S_ISDIR(metadata.st_mode):
            rows.append({"path": destination, "kind": "directory", "mode": stat.S_IMODE(metadata.st_mode)})
            for child in sorted(source.iterdir(), key=lambda item: item.name):
                visit(child, f"{destination}/{child.name}", source_root)
        elif stat.S_ISREG(metadata.st_mode):
            digest, size, opened = _stream_file(source, MAX_LEGACY_BYTES - total_bytes, f"legacy source {source}")
            total_bytes += size
            rows.append({"path": destination, "kind": "file", "mode": stat.S_IMODE(opened.st_mode), "bytes": size, "sha256": digest})
        elif stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(source)
            _require(target and not os.path.isabs(target) and "\\" not in target, f"legacy source symlink is unsafe: {source}")
            resolved = (source.parent / target).resolve()
            try:
                resolved.relative_to(source_root.resolve())
            except ValueError:
                _fail(f"legacy source symlink escapes its source root: {source}")
            rows.append({"path": destination, "kind": "symlink", "mode": stat.S_IMODE(metadata.st_mode), "target": target})
        else:
            _fail(f"legacy source contains an unsupported entry type: {source}")
        total_entries += 1
        _require(total_entries <= MAX_LEGACY_ENTRIES and total_bytes <= MAX_LEGACY_BYTES, "legacy source exceeds bounded inventory limits")

    for destination, source in sorted(components.items()):
        visit(source, destination, source if source.is_dir() else source.parent)
    rows.sort(key=lambda item: item["path"])
    return {"tree_sha256": hashlib.sha256(_canonical(rows)).hexdigest(), "bytes": total_bytes, "entries": total_entries}


def _mapped_bounds(components: dict[str, Path]) -> dict[str, int]:
    """Bound source allocation needs without copying or hashing source bytes."""
    total_bytes = 0
    total_entries = 0

    def visit(source: Path, source_root: Path) -> None:
        nonlocal total_bytes, total_entries
        metadata = os.lstat(source)
        if stat.S_ISDIR(metadata.st_mode):
            for child in sorted(source.iterdir(), key=lambda item: item.name):
                visit(child, source_root)
        elif stat.S_ISREG(metadata.st_mode):
            total_bytes += metadata.st_size
        elif stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(source)
            _require(target and not os.path.isabs(target) and "\\" not in target, f"legacy source symlink is unsafe: {source}")
            try:
                (source.parent / target).resolve().relative_to(source_root.resolve())
            except ValueError:
                _fail(f"legacy source symlink escapes its source root: {source}")
        else:
            _fail(f"legacy source contains an unsupported entry type: {source}")
        total_entries += 1
        _require(total_entries <= MAX_LEGACY_ENTRIES and total_bytes <= MAX_LEGACY_BYTES, "legacy source exceeds bounded admission limits")

    for source in components.values():
        visit(source, source if source.is_dir() else source.parent)
    return {"bytes": total_bytes, "entries": total_entries}


def _copy_legacy_runtime(source: dict[str, Any], destination: Path, repository_root: Path, *, durable: bool, verify_docker: bool = True) -> dict[str, Any]:
    components = _legacy_components(source, repository_root)
    if verify_docker:
        _verify_legacy_container(source, components, repository_root)
    before = _mapped_integrity(components)
    stage = Path(tempfile.mkdtemp(prefix=".legacy-runtime-", dir=destination.parent))
    try:
        counters = {"bytes": 0, "entries": 0}
        for name, component in sorted(components.items()):
            target = stage / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _copy_entry(component, target, max_bytes=MAX_LEGACY_BYTES, counters=counters, source_root=component if component.is_dir() else component.parent)
        after = _mapped_integrity(components)
        _require(before == after, "legacy source changed during bounded preservation")
        _validate_legacy_runtime_contents(stage, source["startup"])
        actual = _integrity(stage, maximum_bytes=MAX_LEGACY_BYTES, maximum_entries=MAX_LEGACY_ENTRIES)
        _require(actual == before, "legacy preserved runtime does not match the read-only source snapshot")
        marker_values: list[str] = []
        for marker in (stage / "dist/.clashcookies-artifact", stage / "node_modules/.clashcookies-artifact"):
            if marker.is_file() and not marker.is_symlink():
                raw, _ = _stable_file(marker, 64 * 1024, "legacy runtime identity marker")
                match = re.search(rb"(?:^|\n)revision=([0-9a-f]{40})(?:\n|$)", raw)
                if match:
                    marker_values.append(match.group(1).decode("ascii"))
        if marker_values:
            _require(len(set(marker_values)) == 1 and marker_values[0] == source["checkout_revision"], "legacy runtime marker identity conflicts with the observed checkout revision")
        else:
            _require(source.get("runtime_revision") == source["checkout_revision"], "legacy runtime has no independently observed revision marker")
        _fsync_tree(stage, required=durable)
        _publish_directory_no_replace(stage, destination, durable=durable)
        return {"tree_sha256": actual["tree_sha256"], "bytes": actual["bytes"], "entries": actual["entries"]}
    except BaseException:
        if stage.exists():
            # Keep the staging directory on interruption or publication failure
            # for explicit recovery classification; ordinary validation errors
            # are also fail-closed and never remove protected material.
            pass
        raise


RECEIVER_AUTHORIZATION_POLICY_ENV = "CC_RECEIVER_AUTHORIZATION_POLICY"


def _load_policy(path: Path, repository_root: Path, publication_root: Path, prepared_root: Path, trusted_root: Path) -> tuple[provenance.AuthorizationTrustConfig, provenance.AuthorizationRevisionAllowlist, Path, Path]:
    configured_policy = os.environ.get(RECEIVER_AUTHORIZATION_POLICY_ENV)
    _require(configured_policy == str(path), f"authorization policy must be selected by receiver-owned {RECEIVER_AUTHORIZATION_POLICY_ENV}")
    policy = _read_json(path, 256 * 1024, "authorization policy")
    fields = {"contract", "version", "repository", "destination", "artifact_class", "authorization_context", "public_key_path", "key_id", "key_fingerprint", "allowlist_path", "journal_path"}
    _require(isinstance(policy, dict) and set(policy) == fields and policy["version"] == 1, "authorization policy is malformed")
    _require(policy["contract"] == "clashcookies.receiver-authorization-policy", "authorization policy contract is unsupported")
    _require(policy["repository"] == provenance.RELEASE_REPOSITORY and policy["destination"] == str(publication_root) and policy["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS and policy["authorization_context"] == provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT, "authorization policy is bound to the wrong domain")
    paths = {key: Path(policy[key]) for key in ("public_key_path", "allowlist_path", "journal_path")}
    forbidden_roots = {
        "mutable checkout": repository_root,
        "retained-evidence root": publication_root,
        "prepared-runtime root": prepared_root,
        "trusted-root parent": trusted_root.parent,
        "policy file": path.parent,
    }
    for label, candidate in paths.items():
        _require(candidate.is_absolute(), f"authorization {label} must be absolute")
        for root_label, root in forbidden_roots.items():
            try:
                candidate.resolve().relative_to(root.resolve())
            except ValueError:
                continue
            _fail(f"authorization {label} overlaps the {root_label}")
    public_key_raw, _ = _stable_file(paths["public_key_path"], provenance.MAX_AUTHORIZATION_PUBLIC_KEY_BYTES, "authorization public key")
    _require(public_key_raw, "authorization public key is empty")
    allowlist_value = _read_json(paths["allowlist_path"], 256 * 1024, "authorization revision allowlist")
    try:
        allowlist = provenance.authorization_revision_allowlist_from_json(allowlist_value)
        provenance.validate_authorization_revision_allowlist(allowlist)
    except (TypeError, provenance.ProvenanceError) as error:
        _fail(f"authorization revision allowlist is invalid: {error}")
    _private_dir(paths["journal_path"], "authorization replay journal")
    _require(bool(re.fullmatch(r"[A-Za-z0-9._:+@-]{1,128}", policy["key_id"])), "authorization key ID is malformed")
    _require(bool(SHA256_RE.fullmatch(policy["key_fingerprint"])), "authorization key fingerprint is malformed")
    trust = provenance.AuthorizationTrustConfig(paths["public_key_path"], policy["key_id"], policy["key_fingerprint"], repository_root)
    return trust, allowlist, paths["allowlist_path"], paths["journal_path"]


def _verify_legacy_container(source: dict[str, Any], components: dict[str, Path], repository_root: Path) -> dict[str, Any]:
    """Correlate caller metadata with Docker, mounts, and the observed checkout."""
    checkout_path = Path(source.get("checkout_path", ""))
    _safe_component(checkout_path, "legacy checkout path")
    mount_destinations = source.get("mount_destinations")
    _require(isinstance(mount_destinations, dict), "legacy source is missing Docker mount correlation")
    _require(set(mount_destinations) == set(components), "legacy Docker mount claims do not exactly cover the bounded runtime components")
    try:
        revision = subprocess.run(["git", "-C", str(checkout_path), "rev-parse", "--verify", "HEAD"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        _fail(f"legacy checkout revision inspection failed: {error}")
    _require(revision.returncode == 0 and revision.stdout.strip() == source["checkout_revision"], "legacy source checkout revision is not observed from the checkout")
    try:
        image_result = subprocess.run(["docker", "image", "inspect", "--platform", source["platform"], "--format", "{{json .}}", source["image"]], capture_output=True, text=True, timeout=20, check=False)
        container_result = subprocess.run(["docker", "container", "inspect", "--format", "{{json .}}", source["container_id"]], capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        _fail(f"legacy Docker inspection failed: {error}")
    _require(image_result.returncode == 0 and container_result.returncode == 0, "legacy Docker container or image is unavailable")
    try:
        image = json.loads(image_result.stdout)
        container = json.loads(container_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"legacy Docker inspection is malformed: {error}")
    _require(isinstance(image, dict) and isinstance(container, dict), "legacy Docker inspection is malformed")
    digest = source["image_digest"]
    _require(isinstance(image.get("RepoDigests"), list) and any(isinstance(item, str) and item.endswith("@" + digest) for item in image["RepoDigests"]), "legacy Docker image digest is not the observed image")
    _require(image.get("Architecture") == "amd64" and image.get("Os") == "linux", "legacy Docker image platform is incompatible")
    _require(type(image.get("Size")) is int and image["Size"] > 0, "legacy Docker image size is unavailable")
    config = container.get("Config")
    _require(isinstance(config, dict) and config.get("Image") in {source["image"], source["image"].split("@", 1)[0], digest}, "legacy container config is not bound to the digest-pinned image")
    _require(container.get("Image") == image.get("Id"), "legacy container image ID is not bound to the inspected image")
    _require(container.get("Id") == source["container_id"] or str(container.get("Id", "")).startswith(source["container_id"]), "legacy container identity is not observed")
    _require(container.get("Os") in {None, "linux"} and container.get("Architecture") in {None, "amd64"}, "legacy container platform is incompatible")
    mounts = container.get("Mounts")
    _require(isinstance(mounts, list), "legacy container mount inventory is unavailable")
    observed: dict[str, dict[str, Any]] = {}
    for mount in mounts:
        if isinstance(mount, dict) and isinstance(mount.get("Destination"), str):
            observed[mount["Destination"]] = mount
    for destination, component in components.items():
        mount = observed.get(destination if destination.startswith("/") else "/app/" + destination)
        claim = mount_destinations.get(destination)
        _require(isinstance(claim, dict) and claim.get("type") in {"bind", "volume"} and isinstance(claim.get("destination"), str) and isinstance(claim.get("source"), str), f"legacy mount claim is incomplete for {destination}")
        _require(mount is not None and mount.get("Destination") == claim["destination"], f"legacy Docker mount is missing for {destination}")
        _require(mount.get("Type") == claim["type"], f"legacy Docker mount type is not bound to {destination}")
        _require(Path(claim["source"]).resolve() == component.resolve() and Path(str(mount.get("Source", ""))).resolve() == component.resolve(), f"legacy Docker mount source is not bound to {destination}")
        if claim["type"] == "volume":
            _require(isinstance(claim.get("name"), str) and mount.get("Name") == claim["name"], f"legacy named volume identity is not bound to {destination}")
    return {"container_id": source["container_id"], "image": source["image"], "image_digest": digest, "checkout_revision": source["checkout_revision"], "mounts": sorted(observed)}


def _verify_pinned_image(image: str, platform: str) -> dict[str, Any]:
    """Verify the actual local image store, never mutable tag equivalence."""
    _require(image == provenance.RELEASE_IMAGE and platform == provenance.RELEASE_PLATFORM, "candidate image or platform is not the approved pinned contract")
    try:
        completed = subprocess.run(
            ["docker", "image", "inspect", "--platform", platform, "--format", "{{json .}}", image],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        _fail(f"pinned runtime image inspection failed: {error}")
    _require(completed.returncode == 0, "pinned runtime image is not durably available in the Docker image store")
    try:
        inspected = json.loads(completed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        _fail(f"pinned runtime image inspection is malformed: {error}")
    _require(isinstance(inspected, dict), "pinned runtime image inspection is malformed")
    digest = provenance.RELEASE_IMAGE.split("@", 1)[1]
    repo_digests = inspected.get("RepoDigests")
    _require(isinstance(repo_digests, list) and any(isinstance(value, str) and value.endswith("@" + digest) for value in repo_digests), "Docker image store does not expose the approved pinned digest")
    _require(inspected.get("Architecture") == "amd64" and inspected.get("Os") == "linux", "pinned runtime image platform is incompatible")
    size = inspected.get("Size", 0)
    _require(type(size) is int and size > 0, "pinned runtime image size is unavailable")
    return {"image": image, "platform": platform, "digest": digest, "bytes": size, "architecture": inspected["Architecture"], "os": inspected["Os"]}


def _candidate_record(store: retention.RetentionStore, identity_sha256: str, identity_file: Path | None, *, verify_publication: bool = True) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    _require(bool(SHA256_RE.fullmatch(identity_sha256)), "candidate identity digest is malformed")
    state = store.load()
    record = state["releases"].get(identity_sha256)
    _require(record is not None, "exact retained candidate identity is unknown")
    identity = record["identity"]
    _require(identity["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "development artifacts cannot enter immutable candidate preparation")
    candidate = provenance.TrustedReleaseIdentity(**identity)
    provenance.validate_trusted_release_identity(candidate)
    _require(retention.identity_digest(identity) == identity_sha256, "retained candidate identity digest is contradictory")
    if identity_file is not None:
        supplied = _read_json(identity_file, retention.MAX_IDENTITY_BYTES, "candidate identity", newline=True)
        _require(supplied == identity, "candidate identity file conflicts with retained identity evidence")
    release_path = store.root / record["publication_name"]
    if verify_publication:
        store._verify_owned_release(release_path, record)
    required = {"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"}
    _require(required.issubset(record["evidence"]), "retained candidate evidence is incomplete")
    return identity, release_path, record


def _verify_current_candidate_authorization(release_path: Path, identity: dict[str, Any], trust: provenance.AuthorizationTrustConfig, allowlist: provenance.AuthorizationRevisionAllowlist, journal_path: Path, publication_root: Path, *, now: datetime) -> None:
    envelope_path = release_path / "authorization-envelope.json"
    envelope = _read_json(envelope_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "retained authorization envelope", newline=True)
    context_path = release_path / "independent-verification-context.json"
    context_raw, _ = _stable_file(context_path, provenance.MAX_BUNDLE_BYTES, "retained candidate verification context")
    context = _read_json(context_path, provenance.MAX_BUNDLE_BYTES, "retained candidate verification context", newline=True)
    candidate = provenance.TrustedReleaseIdentity(**identity)
    provenance.validate_candidate_verification_context(context, candidate)
    context_digest = hashlib.sha256(context_raw).hexdigest()
    authorization = provenance.verify_signed_authorization_record(envelope, trust, candidate, allowlist, now=now)
    _require(authorization.context == provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT and authorization.scope == "forward-release", "candidate authorization is not a current forward authorization")
    _require(authorization.verification_context_sha256 == context_digest and authorization.delivery_destination == str(publication_root), "candidate authorization is not bound to the retained context and delivery destination")
    journal = provenance.AuthorizationReplayJournal(journal_path, repository_root=trust.repository_root)
    try:
        journal.assert_reserved(envelope, candidate, allowlist, trust, operation="forward-release", now=now)
    finally:
        journal.close()


def _read_preparation(path: Path) -> dict[str, Any]:
    value = _read_json(path, 4 * 1024 * 1024, "preparation metadata", newline=True)
    _require(isinstance(value, dict) and value.get("contract") == PREPARATION_CONTRACT and value.get("version") == PREPARATION_VERSION, "preparation metadata contract is unsupported")
    return value


def _verify_existing_preparation(candidate_dir: Path, identity: dict[str, Any], identity_sha256: str, service_zip: Path, run_metadata: dict[str, Any], *, expected_metadata_sha256: str | None = None) -> dict[str, Any]:
    metadata_path = candidate_dir / "preparation.json"
    _require(metadata_path.is_file() and not metadata_path.is_symlink(), "existing candidate material has no durable preparation metadata; recovery is required")
    metadata_raw, _ = _stable_file(metadata_path, 4 * 1024 * 1024, "preparation metadata")
    if expected_metadata_sha256 is not None:
        _require(hashlib.sha256(metadata_raw).hexdigest() == expected_metadata_sha256, "existing preparation metadata digest changed")
    metadata = _read_preparation(metadata_path)
    _require(metadata.get("candidate", {}).get("identity_sha256") == identity_sha256 and metadata.get("candidate", {}).get("identity") == identity, "existing candidate preparation metadata conflicts with the exact identity")
    runtime = candidate_dir / "runtime"
    actual = _integrity(runtime)
    _require(actual == metadata["candidate"]["runtime_integrity"], "existing prepared candidate runtime integrity changed")
    _require(metadata["candidate"].get("image") == identity["image"] and metadata["candidate"].get("image_digest") == identity["image_digest"] and metadata["candidate"].get("platform") == identity["platform"], "existing preparation image or platform metadata conflicts with the authenticated identity")
    with tempfile.TemporaryDirectory(prefix=".retry-", dir=str(candidate_dir.parent)) as retry_name:
        validation = provenance.validate_candidate_archive_contents(service_zip, provenance.TrustedReleaseIdentity(**identity), run_metadata, workspace=Path(retry_name))
        extracted = Path(retry_name) / "extracted-runtime"
        _require(_integrity(extracted) == actual, "existing prepared runtime does not match the retained authenticated archive contents")
        _require(validation == metadata["candidate"].get("archive_validation"), "existing preparation archive-validation evidence changed")
    _require(metadata.get("status") == "prepared-not-activated", "existing candidate preparation is not a preparation-only result")
    return metadata


@contextmanager
def _operation_lock(deployment_lock_file: Path | None, *, timeout_seconds: float = 5.0) -> Iterator[None]:
    """Acquire FB-027's outer deployment lock before retention activity."""
    if deployment_lock_file is None:
        yield
        return
    _require(deployment_lock_file.is_absolute(), "deployment lock file must be absolute")
    descriptor = os.open(deployment_lock_file, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name == "posix":
            import fcntl
            deadline = time.monotonic() + timeout_seconds
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        _fail("FB-027 deployment lock acquisition deadline exceeded")
                    time.sleep(0.01)
        yield
    finally:
        if os.name == "posix":
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def prepare_immutable_runtime(*, publication_root: Path, prepared_root: Path, repository_root: Path, identity_sha256: str, identity_file: Path | None, authorization_policy: Path, trusted_root: Path, trusted_root_version: str, legacy_source: Path, deployment_lock_file: Path | None = None, require_durable: bool | None = None) -> dict[str, Any]:
    """Prepare one exact retained candidate and the first legacy baseline."""
    durable = os.name == "posix" if require_durable is None else require_durable
    _external_dir(publication_root, repository_root, "publication root")
    _external_dir(prepared_root, repository_root, "prepared runtime root", create=True)
    _require(publication_root.resolve() != prepared_root.resolve(), "publication and prepared runtime roots must be distinct")
    _private_dir(publication_root, "publication root")
    _private_dir(prepared_root, "prepared runtime root")
    store = retention.RetentionStore(publication_root, repository_root=repository_root, require_durable=durable)
    store.initialize()
    identity, release_path, retained_record = _candidate_record(store, identity_sha256, identity_file, verify_publication=False)
    trust, allowlist, allowlist_path, journal_path = _load_policy(authorization_policy, repository_root, publication_root, prepared_root, trusted_root)
    image_observation = _verify_pinned_image(identity["image"], identity["platform"])
    candidate_dir = prepared_root / f"candidate-{identity_sha256}"
    legacy_dir = prepared_root / "legacy-runtime-baseline"
    expectation = _read_json(release_path / "verification-expectation.json", retention.MAX_EVIDENCE_BYTES, "retained verification expectation")
    run_metadata = {"name": expectation.get("workflow_name", "")}
    _require(run_metadata["name"], "retained verification expectation omits the exact workflow name")
    existing_baseline = store.legacy_baseline_status()
    source_value: dict[str, Any] | None = None
    components: dict[str, Path] = {}
    if existing_baseline.get("status") == "preserved-verified":
        _require(Path(existing_baseline["runtime_path"]).resolve() == legacy_dir.resolve(), "existing legacy baseline points to a different runtime")
        _validate_legacy_runtime_contents(legacy_dir, existing_baseline["identity"].get("startup", {}))
        _require(_integrity(legacy_dir, maximum_bytes=MAX_LEGACY_BYTES, maximum_entries=MAX_LEGACY_ENTRIES) == existing_baseline["integrity"], "existing legacy baseline runtime integrity changed")
        legacy_integrity = existing_baseline["integrity"]
        legacy_identity = existing_baseline["identity"]
    else:
        _require(deployment_lock_file is not None, "first legacy runtime capture requires the canonical FB-027 deployment lock file")
        source_value = _read_json(legacy_source, MAX_SOURCE_METADATA_BYTES, "legacy source evidence", newline=True)
        components = _legacy_components(source_value, repository_root)
        legacy_integrity = None
        legacy_identity = None
    source_estimate = _mapped_bounds(components) if components else {"bytes": 0, "entries": 0}
    candidate_bound = MAX_RUNTIME_BYTES
    initial_assessment = retention.assess_storage(
        [publication_root, prepared_root, *components.values(), trusted_root, trust.public_key_path, allowlist_path, journal_path],
        temporary_bytes=identity["artifact_service_zip_bytes"] + identity["archive_bytes"] + candidate_bound + source_estimate["bytes"],
        persistent_bytes=candidate_bound + source_estimate["bytes"] + image_observation["bytes"] + 4 * 1024 * 1024,
        preserved_runtime_bytes=retention.retained_bytes(publication_root),
        incremental_preservation_bytes=candidate_bound + source_estimate["bytes"] + image_observation["bytes"],
        temporary_inodes=retention.DEFAULT_TEMP_INODES + min(MAX_RUNTIME_ENTRIES, 500_000) + source_estimate["entries"],
        persistent_inodes=retention.DEFAULT_PERSISTENT_INODES + min(MAX_RUNTIME_ENTRIES, 500_000) + source_estimate["entries"],
    )
    _require(initial_assessment.status == "PASS", "simultaneous candidate and legacy storage/inode admission is insufficient")
    # Historical evidence is explicitly reverified through the existing official
    # verifier after the cheap admission check and before publication. It is not
    # authority; current authority is checked again under the retention lock.
    store.verify_retained_offline(identity_sha256, trusted_root=trusted_root, trusted_root_version=trusted_root_version, authorization_public_key=trust.public_key_path, authorization_key_id=trust.expected_key_id, authorization_key_fingerprint=trust.expected_public_key_sha256, authorization_allowlist=allowlist_path)
    with _operation_lock(deployment_lock_file), retention.activity_lock(publication_root):
        # Retained state, evidence, and admission are revalidated under the
        # lock before any materialization. Replay verification is inside the retention lock so the preparation
        # order is FB-027 deployment lock -> retention lock -> replay journal,
        # matching delivery and avoiding a retention/journal lock inversion.
        state = store.load()
        current_record = state["releases"].get(identity_sha256)
        _require(current_record == retained_record, "retained candidate state changed during preparation")
        store._verify_owned_release(release_path, current_record)
        locked_baseline = store.legacy_baseline_status()
        _require(locked_baseline == existing_baseline, "legacy baseline state changed during preparation")
        _verify_current_candidate_authorization(release_path, identity, trust, allowlist, journal_path, publication_root, now=provenance._now_utc())
        source_estimate = _mapped_bounds(components) if components else {"bytes": 0, "entries": 0}
        assessment = retention.assess_storage(
            [publication_root, prepared_root, *components.values(), trusted_root, trust.public_key_path, allowlist_path, journal_path],
            temporary_bytes=identity["artifact_service_zip_bytes"] + identity["archive_bytes"] + candidate_bound + source_estimate["bytes"],
            persistent_bytes=candidate_bound + source_estimate["bytes"] + image_observation["bytes"] + 4 * 1024 * 1024,
            preserved_runtime_bytes=retention.retained_bytes(publication_root),
            incremental_preservation_bytes=candidate_bound + source_estimate["bytes"] + image_observation["bytes"],
            temporary_inodes=retention.DEFAULT_TEMP_INODES + min(MAX_RUNTIME_ENTRIES, 500_000) + source_estimate["entries"],
            persistent_inodes=retention.DEFAULT_PERSISTENT_INODES + min(MAX_RUNTIME_ENTRIES, 500_000) + source_estimate["entries"],
        )
        _require(assessment.status == "PASS", "simultaneous candidate and legacy storage/inode admission is insufficient")
        operation_id = f"prepare-{identity_sha256}"
        previous_operation = state["operations"].get(operation_id)
        expected_metadata_sha256 = previous_operation.get("metadata_sha256") if isinstance(previous_operation, dict) else None
        store.mark_operation(operation_id, identity_sha256, kind="immutable-runtime-preparation", phase="admission-approved", recovery_required=False, assume_locked=True)
        if candidate_dir.exists() or candidate_dir.is_symlink():
            try:
                candidate_metadata = _verify_existing_preparation(candidate_dir, identity, identity_sha256, release_path / "artifact-service.zip", run_metadata, expected_metadata_sha256=expected_metadata_sha256)
            except BaseException:
                store.update_operation(operation_id, phase="recovery-required", assume_locked=True)
                raise
            _require(existing_baseline.get("status") == "preserved-verified", "existing candidate preparation has no durable legacy baseline; recovery is required")
            _require(candidate_metadata.get("legacy", {}).get("integrity") == existing_baseline["integrity"], "existing candidate preparation is not bound to the preserved legacy baseline")
            metadata_digest = hashlib.sha256(_stable_file(candidate_dir / "preparation.json", 4 * 1024 * 1024, "preparation metadata")[0]).hexdigest()
            store.update_operation(operation_id, phase="completed", metadata_sha256=metadata_digest, assume_locked=True)
        else:
            _require(not any(path.name.startswith(".prepare-") or path.name.startswith(".legacy-runtime-") for path in prepared_root.iterdir()), "interrupted preparation workspace requires explicit recovery")
            legacy_metadata = None
            if legacy_integrity is None:
                _require(source_value is not None, "legacy source evidence is unavailable for the first baseline capture")
                if legacy_dir.exists() or legacy_dir.is_symlink():
                    _require(legacy_dir.is_dir() and not legacy_dir.is_symlink(), "interrupted legacy publication is not a real directory")
                    try:
                        _verify_legacy_container(source_value, components, repository_root)
                        source_integrity = _mapped_integrity(components)
                        _validate_legacy_runtime_contents(legacy_dir, source_value["startup"])
                        legacy_integrity = _integrity(legacy_dir, maximum_bytes=MAX_LEGACY_BYTES, maximum_entries=MAX_LEGACY_ENTRIES)
                        _require(legacy_integrity == source_integrity, "interrupted legacy publication does not match the observed source")
                    except BaseException:
                        store.update_operation(operation_id, phase="recovery-required", assume_locked=True)
                        raise
                    store.update_operation(operation_id, phase="legacy-published", assume_locked=True)
                else:
                    try:
                        legacy_integrity = _copy_legacy_runtime(source_value, legacy_dir, repository_root, durable=durable)
                    except BaseException:
                        store.update_operation(operation_id, phase="recovery-required", assume_locked=True)
                        raise
                    store.update_operation(operation_id, phase="legacy-published", assume_locked=True)
                legacy_identity = {"container_id": source_value["container_id"], "checkout_revision": source_value["checkout_revision"], "image": source_value["image"], "image_digest": source_value["image_digest"], "platform": source_value["platform"], "startup": source_value["startup"]}
                legacy_record = {"contract": "clashcookies.legacy-runtime-baseline", "version": 1, "id": retention.LEGACY_BASELINE_ID, "authenticated": False, "protected": True, "status": "preserved-verified", "runtime_path": str(legacy_dir), "integrity": legacy_integrity, "identity": legacy_identity}
                try:
                    store.register_legacy_baseline(legacy_record, assume_locked=True)
                except BaseException:
                    store.update_operation(operation_id, phase="recovery-required", assume_locked=True)
                    raise
                store.update_operation(operation_id, phase="legacy-registered", assume_locked=True)
            stage = Path(tempfile.mkdtemp(prefix=".prepare-", dir=prepared_root))
            try:
                validation = provenance.validate_candidate_archive_contents(release_path / "artifact-service.zip", provenance.TrustedReleaseIdentity(**identity), run_metadata, workspace=stage)
                runtime = stage / "extracted-runtime"
                runtime_integrity = _integrity(runtime)
                store.update_operation(operation_id, phase="candidate-extracted", assume_locked=True)
                _fsync_tree(runtime, required=durable)
                metadata = {
                    "contract": PREPARATION_CONTRACT,
                    "version": PREPARATION_VERSION,
                    "status": "prepared-not-activated",
                    "candidate": {"identity_sha256": identity_sha256, "identity": identity, "runtime_integrity": runtime_integrity, "runtime_layout": "runtime", "image": identity["image"], "image_digest": identity["image_digest"], "platform": identity["platform"], "archive_validation": validation},
                    "legacy": {"status": "preserved-verified", "authenticated": False, "baseline_id": retention.LEGACY_BASELINE_ID, "runtime_layout": "legacy-runtime-baseline", "identity": legacy_identity, "integrity": legacy_integrity},
                    "retention": {"publication": str(release_path), "operation_id": f"prepare-{identity_sha256}", "registered": True, "active_pointer_changed": False, "previous_pointer_changed": False},
                    "recovery": {"state": "none", "protected": True},
                    "resource_measurements": {"candidate_archive_bytes": identity["archive_bytes"], "retained_evidence_bytes": retention.retained_bytes(publication_root), "image": image_observation, "storage": {"status": assessment.status, "required_bytes": assessment.required_bytes, "required_inodes": assessment.required_inodes, "filesystems": list(assessment.filesystems)}},
                }
                final_runtime = stage / "runtime"
                os.rename(runtime, final_runtime)
                for child in list(stage.iterdir()):
                    if child == final_runtime:
                        continue
                    _require(child.is_file() and not child.is_symlink(), "candidate staging workspace contains unexpected material")
                    child.unlink()
                _write_private(stage / "preparation.json", {**metadata, "candidate": {**metadata["candidate"], "runtime_path": str(candidate_dir / "runtime")}, "legacy": {**metadata["legacy"], "runtime_path": str(legacy_dir)}, "resource_measurements": {**metadata["resource_measurements"], "prepared_runtime_root": str(prepared_root)}}, durable=durable)
                _fsync_tree(stage, required=durable)
                _publish_directory_no_replace(stage, candidate_dir, durable=durable)
                candidate_metadata = _read_preparation(candidate_dir / "preparation.json")
                store.update_operation(operation_id, phase="candidate-published", assume_locked=True)
                metadata_digest = hashlib.sha256(_stable_file(candidate_dir / "preparation.json", 4 * 1024 * 1024, "preparation metadata")[0]).hexdigest()
                store.update_operation(operation_id, phase="completed", metadata_sha256=metadata_digest, assume_locked=True)
            except BaseException:
                store.update_operation(operation_id, phase="recovery-required", assume_locked=True)
                raise
            finally:
                if stage.exists():
                    shutil.rmtree(stage, ignore_errors=True)
        return candidate_metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="prepare an exact retained runtime without activation")
    parser.add_argument("prepare", nargs="?")
    parser.add_argument("--publication-root", required=True)
    parser.add_argument("--prepared-root", required=True)
    parser.add_argument("--repository-root", required=True)
    parser.add_argument("--identity-sha256", required=True)
    parser.add_argument("--identity-file")
    parser.add_argument("--authorization-policy", required=True)
    parser.add_argument("--trusted-root", required=True)
    parser.add_argument("--trusted-root-version", required=True)
    parser.add_argument("--legacy-source", required=True)
    parser.add_argument("--deployment-lock-file")
    args = parser.parse_args()
    result = prepare_immutable_runtime(publication_root=Path(args.publication_root), prepared_root=Path(args.prepared_root), repository_root=Path(args.repository_root), identity_sha256=args.identity_sha256, identity_file=Path(args.identity_file) if args.identity_file else None, authorization_policy=Path(args.authorization_policy), trusted_root=Path(args.trusted_root), trusted_root_version=args.trusted_root_version, legacy_source=Path(args.legacy_source), deployment_lock_file=Path(args.deployment_lock_file) if args.deployment_lock_file else None)
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PreparationError, retention.RetentionError, provenance.ProvenanceError, OSError, ValueError) as error:
        print(f"[immutable-runtime-preparation] blocked: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
