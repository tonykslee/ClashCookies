#!/usr/bin/env python3
"""Bounded, fail-closed validation and extraction for FB-028A runtime archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_ROOTS = ("dist", "node_modules", "prisma")
REQUIRED_REGULAR_FILES = (
    "dist/ClashCookies.js",
    "node_modules/@prisma/client/default.js",
    "node_modules/.prisma/client/index.js",
    "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
    "node_modules/prisma/build/index.js",
    "prisma/schema.prisma",
    "package.json",
    "yarn.lock",
)
REQUIRED_PATHS = REQUIRED_REGULAR_FILES + ("node_modules/.bin/prisma", "runtime-artifact-manifest.json")


class ArtifactError(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    compressed_bytes: int = 512 * 1024 * 1024
    expanded_bytes: int = 2 * 1024 * 1024 * 1024
    entry_count: int = 500_000
    path_bytes: int = 4096
    link_bytes: int = 4096
    metadata_bytes: int = 64 * 1024
    manifest_bytes: int = 1024 * 1024
    file_bytes: int = 1024 * 1024 * 1024


@dataclass(frozen=True)
class Entry:
    name: str
    kind: str
    size: int
    mode: int
    link: str


class BoundedReader:
    def __init__(self, raw: BinaryIO, limit: int):
        self.raw = raw
        self.limit = limit
        self.total = 0

    def read(self, size: int = -1) -> bytes:
        remaining = self.limit - self.total
        if remaining <= 0:
            return b""
        if size < 0 or size > remaining:
            size = remaining
        chunk = self.raw.read(size)
        self.total += len(chunk)
        return chunk

    def readable(self) -> bool:
        return True


def fail(message: str) -> None:
    raise ArtifactError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def require_string(value: object, path: str) -> str:
    require(isinstance(value, str) and value != "", f"manifest field {path} must be a non-empty string")
    return value


def require_bool(value: object, path: str) -> bool:
    require(type(value) is bool, f"manifest field {path} must be boolean")
    return value


def require_int(value: object, path: str, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"manifest field {path} must be an integer >= {minimum}")
    return value


def require_digest(value: object, path: str) -> str:
    value = require_string(value, path).lower()
    require(bool(SHA256_RE.fullmatch(value)), f"manifest field {path} must be a SHA-256 digest")
    return value


def normalized_name(raw_name: str, is_directory: bool, limits: Limits) -> str:
    require(isinstance(raw_name, str), "archive entry name is not text")
    require(len(raw_name.encode("utf-8", "strict")) <= limits.path_bytes, "archive path exceeds the path limit")
    name = raw_name.rstrip("/") if is_directory else raw_name
    require(name and not name.startswith("/") and "\\" not in name, f"unsafe archive path: {raw_name!r}")
    require(not re.match(r"^[A-Za-z]:", name), f"unsafe archive path: {raw_name!r}")
    parts = name.split("/")
    require(all(part not in ("", ".", "..") for part in parts), f"unsafe archive path: {raw_name!r}")
    return name


def safe_link(name: str, link: str, limits: Limits) -> str:
    require(isinstance(link, str) and link, f"empty symlink target: {name}")
    require(len(link.encode("utf-8", "strict")) <= limits.link_bytes, f"symlink target exceeds the link limit: {name}")
    require(not link.startswith("/") and "\\" not in link and not re.match(r"^[A-Za-z]:", link), f"escaping symlink: {name} -> {link}")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
    require(resolved not in ("", ".") and not resolved.startswith("../") and resolved != "..", f"escaping symlink: {name} -> {link}")
    require(resolved == "dist" or resolved.startswith("dist/") or resolved == "node_modules" or resolved.startswith("node_modules/") or resolved == "prisma" or resolved.startswith("prisma/"), f"symlink escapes runtime roots: {name} -> {link}")
    return resolved


def classify(info: tarfile.TarInfo) -> str:
    if info.isreg():
        return "file"
    if info.isdir():
        return "directory"
    if info.issym():
        return "symlink"
    fail(f"unsupported archive entry type: {info.name!r}")


def validate_mode(mode: int, name: str, kind: str) -> int:
    mode &= 0o7777
    if kind == "symlink":
        return mode
    require(not mode & 0o6000, f"unsafe special permission bits: {name}")
    require(not mode & 0o022, f"group/world-writable archive entry: {name}")
    require(mode & 0o400, f"archive entry is not owner-readable: {name}")
    return mode


def iter_entries(archive_path: Path, limits: Limits) -> Iterable[tuple[Entry, tarfile.TarInfo, tarfile.TarFile]]:
    require(stat.S_ISREG(archive_path.stat().st_mode), f"archive is not a regular file: {archive_path}")
    require(archive_path.stat().st_size <= limits.compressed_bytes, "compressed archive exceeds the size limit")
    raw = archive_path.open("rb")
    bounded = BoundedReader(raw, limits.compressed_bytes)
    try:
        with tarfile.open(fileobj=bounded, mode="r|gz", errorlevel=2) as tar:
            count = 0
            expanded = 0
            while True:
                try:
                    info = tar.next()
                except (tarfile.TarError, EOFError, OSError) as error:
                    fail(f"malformed archive: {error}")
                if info is None:
                    break
                count += 1
                require(count <= limits.entry_count, "archive entry count exceeds the limit")
                kind = classify(info)
                name = normalized_name(info.name, kind == "directory", limits)
                require(info.name == name or (kind == "directory" and info.name.rstrip("/") == name), f"archive path normalization mismatch: {info.name!r}")
                link = info.linkname if kind == "symlink" else ""
                if kind == "symlink":
                    safe_link(name, link, limits)
                metadata_size = sum(len(str(key).encode()) + len(str(value).encode()) for key, value in info.pax_headers.items())
                require(metadata_size <= limits.metadata_bytes, f"archive metadata exceeds the limit: {name}")
                mode = validate_mode(info.mode, name, kind)
                size = int(info.size)
                require(size >= 0 and size <= limits.file_bytes, f"archive file exceeds the per-file limit: {name}")
                if kind == "file":
                    expanded += size
                    require(expanded <= limits.expanded_bytes, "expanded archive exceeds the size limit")
                yield Entry(name, kind, size, mode, link), info, tar
    except (tarfile.TarError, EOFError, OSError) as error:
        fail(f"malformed archive: {error}")
    finally:
        raw.close()


def read_entry(tar: tarfile.TarFile, info: tarfile.TarInfo, limit: int) -> bytes:
    require(info.size <= limit, "metadata file exceeds the limit")
    extracted = tar.extractfile(info)
    require(extracted is not None, "regular archive entry could not be read")
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = extracted.read(min(1024 * 1024, limit - total + 1))
        if not chunk:
            break
        total += len(chunk)
        require(total <= limit, f"metadata file exceeds the limit: {info.name}")
        chunks.append(chunk)
    require(total == info.size, f"archive entry has unexpected content length: {info.name}")
    return b"".join(chunks)


def read_json_bytes(data: bytes, label: str) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is missing or malformed: {error}")
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def read_sidecar_json(path: Path, limits: Limits, label: str) -> dict:
    try:
        require(stat.S_ISREG(path.stat().st_mode), f"{label} is not a regular file")
        require(path.stat().st_size <= limits.manifest_bytes, f"{label} exceeds the metadata limit")
        with path.open("rb") as stream:
            data = stream.read(limits.manifest_bytes + 1)
    except OSError as error:
        fail(f"{label} is missing: {error}")
    require(len(data) <= limits.manifest_bytes, f"{label} exceeds the metadata limit")
    return read_json_bytes(data, label)


def validate_checksum(archive_path: Path, checksum_path: Path, digest: str) -> None:
    try:
        require(stat.S_ISREG(checksum_path.stat().st_mode), "checksum metadata is not a regular file")
        require(checksum_path.stat().st_size <= 512, "checksum metadata exceeds the limit")
        with checksum_path.open("rb") as stream:
            data = stream.read(513)
    except OSError as error:
        fail(f"checksum metadata is missing: {error}")
    require(len(data) <= 512, "checksum metadata exceeds the limit")
    try:
        line = data.decode("ascii").strip()
    except UnicodeDecodeError:
        fail("checksum metadata is not ASCII")
    match = re.fullmatch(r"([0-9a-fA-F]{64})\s+(\S+)", line)
    require(match is not None, "checksum metadata is malformed")
    require(match.group(1).lower() == digest, "checksum metadata does not match archive bytes")
    require(match.group(2) == archive_path.name, "checksum metadata names a different archive")


def validate_manifest(manifest: dict, archive_name: str, archive_size: int, digest: str, expected: argparse.Namespace, embedded: bool = False) -> None:
    require(manifest.get("schemaVersion") == 1, "unsupported manifest schema")
    artifact = manifest.get("artifact")
    require(isinstance(artifact, dict), "manifest artifact section is missing")
    require(require_string(artifact.get("name"), "artifact.name") == archive_name, "manifest archive name does not match archive")
    require(artifact.get("format") == "tar.gz", "manifest artifact format is invalid")
    require(artifact.get("contents") == ["dist", "node_modules", "prisma", "package.json", "yarn.lock"], "manifest artifact contents are invalid")
    require_bool(artifact.get("nonProductionEvidence"), "artifact.nonProductionEvidence")
    require(artifact.get("nonProductionEvidence") is True, "artifact is not marked as non-production evidence")
    source = manifest.get("source")
    require(isinstance(source, dict), "manifest source section is missing")
    git_sha = require_string(source.get("gitSha"), "source.gitSha").lower()
    require(bool(GIT_SHA_RE.fullmatch(git_sha)), "manifest source.gitSha is not a full Git SHA")
    require(source.get("context") == "git-archive", "manifest source context is invalid")
    require_bool(source.get("untrackedFilesExcluded"), "source.untrackedFilesExcluded")
    require_bool(source.get("localEnvironmentFilesExcluded"), "source.localEnvironmentFilesExcluded")
    require_bool(source.get("cleanSourceContext"), "source.cleanSourceContext")
    require(source.get("untrackedFilesExcluded") and source.get("localEnvironmentFilesExcluded") and source.get("cleanSourceContext"), "manifest source context is not clean")
    require(git_sha == expected.expected_sha.lower(), "manifest Git SHA does not match expected revision")

    identity = manifest.get("identity")
    require(isinstance(identity, dict), "manifest identity section is missing")
    require_string(identity.get("kind"), "identity.kind")
    require_string(identity.get("event"), "identity.event")
    require_bool(identity.get("deployableRelease"), "identity.deployableRelease")
    require(identity.get("deployableRelease") is False, "artifact is marked deployable")

    provenance = manifest.get("provenance")
    require(isinstance(provenance, dict), "manifest provenance section is missing")
    require_string(provenance.get("integrity"), "provenance.integrity")
    require_bool(provenance.get("authenticated"), "provenance.authenticated")
    require_string(provenance.get("note"), "provenance.note")
    require(provenance.get("authenticated") is False, "artifact provenance must not claim authentication")

    workflow = manifest.get("workflow")
    require(isinstance(workflow, dict), "manifest workflow section is missing")
    for key in ("name", "runId", "runAttempt", "ref", "repository"):
        require_string(workflow.get(key), f"workflow.{key}")
    for key, expected_value in (("repository", expected.expected_repository), ("name", expected.expected_workflow), ("runId", expected.expected_run_id), ("runAttempt", expected.expected_run_attempt)):
        if expected_value is not None:
            require(workflow.get(key) == expected_value, f"manifest workflow.{key} does not match independent CI context")

    build = manifest.get("build")
    require(isinstance(build, dict), "manifest build section is missing")
    for key in ("platform", "architecture", "nodeVersion", "yarnVersion", "compiler", "baseImage", "baseImageDigest"):
        require_string(build.get(key), f"build.{key}")
    require(build.get("platform") == expected.expected_platform, "manifest platform is incompatible")
    require(build.get("architecture") == expected.expected_platform.split("/", 1)[1], "manifest architecture is incompatible")
    require(build.get("compiler") == "npm run build", "manifest compiler is invalid")
    base_image_digest = build.get("baseImageDigest")
    require(base_image_digest.startswith("sha256:"), "manifest base image digest must include sha256 prefix")
    require_digest(base_image_digest.removeprefix("sha256:"), "build.baseImageDigest")
    require("@" in build.get("baseImage") and build["baseImage"].rsplit("@", 1)[1] == base_image_digest, "manifest base image and digest do not agree")
    if expected.expected_base_image is not None:
        require(build.get("baseImage") == expected.expected_base_image, "manifest base image does not match independent CI context")
    if expected.expected_base_image_digest is not None:
        require(build.get("baseImageDigest") == expected.expected_base_image_digest, "manifest base image digest does not match independent CI context")
    native = build.get("nativeLibraryCompatibility")
    require(isinstance(native, dict), "manifest native-library compatibility is missing")
    for key in ("libc", "distribution", "openssl", "liveVmCompatibility"):
        require_string(native.get(key), f"build.nativeLibraryCompatibility.{key}")
    require_int(build.get("durationMs"), "build.durationMs")
    require_string(build.get("startedAt"), "build.startedAt")
    require_string(build.get("completedAt"), "build.completedAt")

    inputs = manifest.get("inputs")
    require(isinstance(inputs, dict), "manifest inputs section is missing")
    for key in ("packageJsonSha256", "yarnLockSha256", "prismaSchemaSha256"):
        require_digest(inputs.get(key), f"inputs.{key}")
    migrations = inputs.get("prismaMigrations")
    require(isinstance(migrations, list), "inputs.prismaMigrations must be a list")
    migration_paths = []
    for index, migration in enumerate(migrations):
        require(isinstance(migration, dict), f"inputs.prismaMigrations[{index}] must be an object")
        path = require_string(migration.get("path"), f"inputs.prismaMigrations[{index}].path")
        require(path.startswith("prisma/migrations/") and path.endswith("/migration.sql"), f"invalid migration path: {path}")
        require_digest(migration.get("sha256"), f"inputs.prismaMigrations[{index}].sha256")
        migration_paths.append(path)
    require(migration_paths == sorted(set(migration_paths)), "migration inventory is not unique and sorted")

    integrity = manifest.get("integrity")
    require(isinstance(integrity, dict), "manifest integrity section is missing")
    require(require_string(integrity.get("checksumFile"), "integrity.checksumFile") == f"{archive_name}.sha256", "manifest checksum filename is invalid")
    require_digest(integrity.get("sha256"), "integrity.sha256") if not embedded else None
    if not embedded:
        require(integrity.get("sha256") == digest, "manifest digest does not match archive")

    measurements = manifest.get("measurements")
    require(isinstance(measurements, dict), "manifest measurements section is missing")
    if not embedded:
        require_int(measurements.get("archiveBytes"), "measurements.archiveBytes")
        require_int(measurements.get("extractedFootprintBytes"), "measurements.extractedFootprintBytes")
        require(measurements.get("archiveBytes") == archive_size, "manifest archive size does not match archive")

    runtime = manifest.get("runtimeValidation")
    require(isinstance(runtime, dict), "manifest runtimeValidation section is missing")
    required_files = runtime.get("requiredFiles")
    require(isinstance(required_files, list) and all(isinstance(value, str) for value in required_files), "manifest runtimeValidation.requiredFiles is invalid")
    require(set(REQUIRED_REGULAR_FILES).issubset(set(required_files)), "manifest runtimeValidation.requiredFiles omits a required runtime file")
    require("node_modules/.bin/prisma" in required_files, "manifest runtimeValidation.requiredFiles omits Prisma CLI")
    prohibited = runtime.get("prohibitedActions")
    require(isinstance(prohibited, list) and all(isinstance(value, str) for value in prohibited), "manifest runtimeValidation.prohibitedActions is invalid")

    if not embedded:
        require_digest(artifact.get("archiveSha256"), "artifact.archiveSha256")
        require(artifact.get("archiveSha256") == digest, "artifact archive digest does not match archive")
        require_int(artifact.get("archiveBytes"), "artifact.archiveBytes")
        require(artifact.get("archiveBytes") == archive_size, "artifact archive size does not match archive")


def compare_manifests(embedded: dict, external: dict) -> None:
    def comparable(value: dict) -> dict:
        value = json.loads(json.dumps(value))
        value["artifact"].pop("archiveSha256", None)
        value["artifact"].pop("archiveBytes", None)
        value["integrity"].pop("sha256", None)
        value["measurements"].pop("archiveBytes", None)
        value["measurements"].pop("extractedFootprintBytes", None)
        return value
    require(comparable(embedded) == comparable(external), "published manifest does not match embedded manifest")


def collect_entries(archive_path: Path, limits: Limits) -> tuple[list[Entry], dict[str, bytes]]:
    entries: list[Entry] = []
    metadata_files: dict[str, bytes] = {}
    seen: set[str] = set()
    for entry, info, tar in iter_entries(archive_path, limits):
        require(entry.name not in seen, f"duplicate archive path: {entry.name}")
        seen.add(entry.name)
        require(entry.name in ALLOWED_ROOTS or entry.name.startswith(tuple(root + "/" for root in ALLOWED_ROOTS)) or entry.name in ("package.json", "yarn.lock", "runtime-artifact-manifest.json"), f"unexpected archive root: {entry.name}")
        if entry.kind == "symlink":
            safe_link(entry.name, entry.link, limits)
        if entry.kind == "file" and (entry.name in {"package.json", "yarn.lock", "prisma/schema.prisma", "runtime-artifact-manifest.json"} or (entry.name.startswith("prisma/migrations/") and entry.name.endswith("/migration.sql"))):
            metadata_files[entry.name] = read_entry(tar, info, limits.manifest_bytes)
        entries.append(entry)
    require("runtime-artifact-manifest.json" in metadata_files, "embedded manifest is missing")
    require(len(entries) > 0, "archive is empty")
    by_name = {entry.name: entry for entry in entries}
    for entry in entries:
        if entry.name in ("dist", "node_modules", "prisma"):
            require(entry.kind == "directory", f"runtime root is not a directory: {entry.name}")
        for parent in PurePosixPath(entry.name).parents:
            parent_name = str(parent)
            if parent_name == ".":
                continue
            require(parent_name in by_name and by_name[parent_name].kind == "directory", f"file/directory conflict or missing parent: {entry.name}")
    for entry in entries:
        if entry.kind == "symlink":
            target = safe_link(entry.name, entry.link, limits)
            require(target in by_name, f"symlink target is not present: {entry.name} -> {entry.link}")
    resolve_symlinks(by_name, limits)
    for required in REQUIRED_PATHS:
        require(required in by_name, f"missing required runtime file: {required}")
    for required in REQUIRED_REGULAR_FILES + ("runtime-artifact-manifest.json",):
        require(by_name[required].kind == "file" and by_name[required].size > 0, f"required runtime file is not a non-empty regular file: {required}")
    prisma_link = by_name["node_modules/.bin/prisma"]
    require(prisma_link.kind == "symlink", "Prisma CLI entry is not a symlink")
    prisma_target = by_name[safe_link(prisma_link.name, prisma_link.link, limits)]
    require(prisma_target.kind == "file" and prisma_target.size > 0 and prisma_target.mode & 0o111, "Prisma CLI symlink does not resolve to an executable file")
    return entries, metadata_files


def resolve_symlinks(by_name: dict[str, Entry], limits: Limits) -> None:
    def resolve(name: str, stack: tuple[str, ...]) -> str:
        require(name in by_name, f"symlink target is not present: {name}")
        entry = by_name[name]
        if entry.kind != "symlink":
            return name
        require(name not in stack, f"cyclic symlink: {' -> '.join(stack + (name,))}")
        return resolve(safe_link(name, entry.link, limits), stack + (name,))
    for name, entry in by_name.items():
        if entry.kind == "symlink":
            target = resolve(name, ())
            require(by_name[target].kind in ("file", "directory"), f"invalid symlink target: {name}")


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive_input_hashes(metadata_files: dict[str, bytes], entries: list[Entry]) -> dict[str, object]:
    migrations = sorted(entry.name for entry in entries if entry.kind == "file" and entry.name.startswith("prisma/migrations/") and entry.name.endswith("/migration.sql"))
    return {
        "packageJsonSha256": hash_bytes(metadata_files["package.json"]),
        "yarnLockSha256": hash_bytes(metadata_files["yarn.lock"]),
        "prismaSchemaSha256": hash_bytes(metadata_files["prisma/schema.prisma"]),
        "prismaMigrations": [{"path": path, "sha256": hash_bytes(read_migration_from_archive(path, metadata_files))} for path in migrations],
    }


def read_migration_from_archive(path: str, metadata_files: dict[str, bytes]) -> bytes:
    # Migration files are collected during the second archive pass below.
    return metadata_files[path]


def source_input_hashes(source_root: Path) -> dict[str, object]:
    def digest(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    migration_paths = sorted(str(path.relative_to(source_root)).replace(os.sep, "/") for path in (source_root / "prisma" / "migrations").rglob("migration.sql"))
    return {"packageJsonSha256": digest(source_root / "package.json"), "yarnLockSha256": digest(source_root / "yarn.lock"), "prismaSchemaSha256": digest(source_root / "prisma" / "schema.prisma"), "prismaMigrations": [{"path": path, "sha256": digest(source_root / path)} for path in migration_paths]}


def collect_input_files(archive_path: Path, limits: Limits) -> dict[str, bytes]:
    values: dict[str, bytes] = {}
    wanted = {"package.json", "yarn.lock", "prisma/schema.prisma"}
    for entry, info, tar in iter_entries(archive_path, limits):
        if entry.kind == "file" and (entry.name in wanted or (entry.name.startswith("prisma/migrations/") and entry.name.endswith("/migration.sql"))):
            values[entry.name] = read_entry(tar, info, limits.manifest_bytes)
    return values


def extract_archive(archive_path: Path, entries: list[Entry], destination: Path, limits: Limits) -> None:
    require(not os.path.lexists(destination), "extraction destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".runtime-artifact-extract-", dir=destination.parent))
    try:
        by_name = {entry.name: entry for entry in entries}
        directory_modes = {entry.name: entry.mode for entry in entries if entry.kind == "directory"}
        symlinks: list[Entry] = []
        for entry, info, tar in iter_entries(archive_path, limits):
            target = temporary / Path(*entry.name.split("/"))
            if entry.kind == "directory":
                target.mkdir(parents=True, exist_ok=True)
            elif entry.kind == "file":
                target.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, entry.mode & 0o7777)
                try:
                    extracted = tar.extractfile(info)
                    require(extracted is not None, f"cannot read archive entry: {entry.name}")
                    total = 0
                    digest = hashlib.sha256()
                    with os.fdopen(fd, "wb") as output:
                        while True:
                            chunk = extracted.read(1024 * 1024)
                            if not chunk:
                                break
                            total += len(chunk)
                            require(total <= entry.size and total <= limits.file_bytes, f"file exceeds extraction limit: {entry.name}")
                            digest.update(chunk)
                            output.write(chunk)
                    require(total == entry.size, f"archive entry has unexpected content length: {entry.name}")
                except Exception:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                    raise
                os.chmod(target, entry.mode & 0o7777)
            else:
                symlinks.append(entry)
        for entry in symlinks:
            os.symlink(entry.link, temporary / Path(*entry.name.split("/")))
        for name, mode in sorted(directory_modes.items(), key=lambda item: item[0].count("/"), reverse=True):
            os.chmod(temporary / Path(*name.split("/")), mode & 0o7777)
        os.replace(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--checksum")
    parser.add_argument("--manifest")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--expected-platform", "--platform", dest="expected_platform", default="linux/amd64")
    parser.add_argument("--expected-repository")
    parser.add_argument("--expected-workflow")
    parser.add_argument("--expected-run-id")
    parser.add_argument("--expected-run-attempt")
    parser.add_argument("--expected-base-image")
    parser.add_argument("--expected-base-image-digest")
    parser.add_argument("--source-root")
    parser.add_argument("--extract")
    parser.add_argument("--max-compressed-bytes", type=int, default=Limits.compressed_bytes)
    parser.add_argument("--max-expanded-bytes", type=int, default=Limits.expanded_bytes)
    parser.add_argument("--max-entries", type=int, default=Limits.entry_count)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    limits = Limits(compressed_bytes=args.max_compressed_bytes, expanded_bytes=args.max_expanded_bytes, entry_count=args.max_entries)
    archive_path = Path(args.archive).resolve()
    checksum_path = Path(args.checksum or f"{archive_path}.sha256")
    manifest_path = Path(args.manifest or f"{archive_path}.manifest.json")
    digest_hasher = hashlib.sha256()
    with archive_path.open("rb") as archive_stream:
        for chunk in iter(lambda: archive_stream.read(1024 * 1024), b""):
            digest_hasher.update(chunk)
    digest = digest_hasher.hexdigest()
    validate_checksum(archive_path, checksum_path, digest)
    entries, metadata_files = collect_entries(archive_path, limits)
    embedded = read_json_bytes(metadata_files["runtime-artifact-manifest.json"], "embedded manifest")
    external = read_sidecar_json(manifest_path, limits, "published manifest")
    validate_manifest(embedded, archive_path.name, archive_path.stat().st_size, digest, args, embedded=True)
    validate_manifest(external, archive_path.name, archive_path.stat().st_size, digest, args, embedded=False)
    compare_manifests(embedded, external)
    packaged_inputs = collect_input_files(archive_path, limits)
    manifest_inputs = external["inputs"]
    require(archive_input_hashes(packaged_inputs, entries) == manifest_inputs, "packaged input hashes or migration inventory do not match manifest")
    if args.source_root:
        source_root = Path(args.source_root).resolve()
        try:
            source_revision = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            fail(f"source revision cannot be verified: {error}")
        require(source_revision.lower() == args.expected_sha.lower(), "source checkout does not match expected revision")
        require(source_input_hashes(source_root) == manifest_inputs, "manifest inputs do not match the exact source revision")
    footprint = sum(entry.size for entry in entries if entry.kind == "file" and (entry.name == "package.json" or entry.name == "dist" or entry.name.startswith("dist/") or entry.name.startswith("node_modules/") or entry.name == "prisma" or entry.name.startswith("prisma/")))
    require(external["measurements"]["extractedFootprintBytes"] == footprint, "manifest extracted footprint does not match archive")
    if args.extract:
        extract_archive(archive_path, entries, Path(args.extract).resolve(), limits)
    print(json.dumps({"archive": str(archive_path), "sha256": digest, "entries": len(entries), "sourceSha": external["source"]["gitSha"], "archiveBytes": archive_path.stat().st_size, "extractedFootprintBytes": footprint}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ArtifactError as error:
        print(f"[runtime-artifact] validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, tarfile.TarError, ValueError, KeyError) as error:
        print(f"[runtime-artifact] validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
