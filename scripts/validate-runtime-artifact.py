#!/usr/bin/env python3
"""Bounded, fail-closed validation and extraction for FB-028A runtime archives."""

from __future__ import annotations

import argparse
import ctypes
import errno
import gzip
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
import time
import zlib
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
    metadata_total_bytes: int = 16 * 1024 * 1024
    metadata_headers: int = 32_768
    total_headers: int = 500_000
    extension_headers: int = 256
    pax_global_bytes: int = 4 * 1024 * 1024
    long_name_bytes: int = 64 * 1024
    manifest_bytes: int = 1024 * 1024
    file_bytes: int = 1024 * 1024 * 1024
    retained_metadata_bytes: int = 16 * 1024 * 1024


@dataclass(frozen=True)
class Entry:
    name: str
    kind: str
    size: int
    mode: int
    link: str


@dataclass(frozen=True)
class Snapshot:
    """A private, read-only byte boundary owned by this validation attempt.

    The descriptor is the source for every digest, parser pass, and extraction
    pass. The private directory and read-only mode prevent ordinary path-based
    replacement. This is not protection from a same-UID or root actor that can
    reopen the descriptor or change permissions; the trust boundary is
    documented in docs/deployment.md.
    """

    fd: int
    size: int
    digest: str
    name: str
    workspace: str

    def duplicate(self) -> BinaryIO:
        descriptor = os.dup(self.fd)
        os.lseek(descriptor, 0, os.SEEK_SET)
        return os.fdopen(descriptor, "rb", closefd=True)

    def verify(self, expected_digest: str) -> None:
        require(snapshot_digest(self) == expected_digest, "immutable archive snapshot changed during validation")

    def close(self) -> None:
        try:
            os.close(self.fd)
        except OSError:
            pass


class BoundedReader:
    def __init__(self, raw: BinaryIO, limit: int, chunk_limit: int = 64 * 1024):
        self.raw = raw
        self.limit = limit
        self.chunk_limit = chunk_limit
        self.total = 0

    def read(self, size: int = -1) -> bytes:
        remaining = self.limit - self.total
        if remaining <= 0:
            return b""
        if size < 0 or size > remaining:
            size = remaining
        size = min(size, self.chunk_limit)
        chunk = self.raw.read(size)
        self.total += len(chunk)
        return chunk

    def readable(self) -> bool:
        return True


class TrackedReader:
    def __init__(self, source: BinaryIO, limit: int):
        self.source = source
        self.limit = limit
        self.total = 0
        self.tail = bytearray()
        self.marked = False
        self.nonzero_after_mark = False

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = 64 * 1024
        chunk = self.source.read(min(size, 64 * 1024))
        if not chunk:
            return b""
        self.total += len(chunk)
        require(self.total <= self.limit, "decompressed stream exceeds the size limit")
        if self.marked and any(chunk):
            self.nonzero_after_mark = True
        self.tail.extend(chunk)
        if len(self.tail) > 1024:
            del self.tail[:-1024]
        return chunk

    def readable(self) -> bool:
        return True


def nofollow_flag() -> int:
    return getattr(os, "O_NOFOLLOW", 0)


def cloexec_flag() -> int:
    return getattr(os, "O_CLOEXEC", 0)


def binary_flag() -> int:
    return getattr(os, "O_BINARY", 0)


def nonblocking_flag() -> int:
    return getattr(os, "O_NONBLOCK", 0)


def directory_flag() -> int:
    return getattr(os, "O_DIRECTORY", 0)


def open_regular_readonly(path: Path, label: str) -> tuple[int, os.stat_result]:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        fail(f"{label} is missing: {error}")
    require(not stat.S_ISLNK(metadata.st_mode), f"{label} must not be a symlink")
    require(stat.S_ISREG(metadata.st_mode), f"{label} is not a regular file")
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | binary_flag() | cloexec_flag() | nofollow_flag() | nonblocking_flag())
        opened = os.fstat(descriptor)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        fail(f"{label} cannot be opened safely: {error}")
    if not stat.S_ISREG(opened.st_mode) or stat.S_ISLNK(opened.st_mode):
        os.close(descriptor)
        fail(f"{label} is not a regular file")
    if opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino:
        os.close(descriptor)
        fail(f"{label} changed during open")
    return descriptor, opened


def snapshot_source(path: Path, limits: Limits) -> Snapshot:
    descriptor, source_stat = open_regular_readonly(path, "archive")
    workspace: str | None = None
    immutable_fd: int | None = None
    try:
        require(source_stat.st_size <= limits.compressed_bytes, "compressed archive exceeds the size limit")
        workspace = tempfile.mkdtemp(prefix=".runtime-artifact-validation-")
        os.chmod(workspace, 0o700)
        snapshot_path = Path(workspace) / "archive.bin"
        snapshot_fd = os.open(snapshot_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | binary_flag() | cloexec_flag(), 0o600)
        digest = hashlib.sha256()
        copied = 0
        try:
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, limits.compressed_bytes - copied + 1))
                if not chunk:
                    break
                copied += len(chunk)
                require(copied <= limits.compressed_bytes and copied <= source_stat.st_size, f"archive changed while creating immutable snapshot (copied={copied}, sourceSize={source_stat.st_size})")
                digest.update(chunk)
                written = 0
                while written < len(chunk):
                    written += os.write(snapshot_fd, chunk[written:])
            require(copied == source_stat.st_size, f"archive changed while creating immutable snapshot (copied={copied}, sourceSize={source_stat.st_size})")
            after = os.fstat(descriptor)
            require(after.st_dev == source_stat.st_dev and after.st_ino == source_stat.st_ino and after.st_size == source_stat.st_size, "archive changed while creating immutable snapshot")
            os.fsync(snapshot_fd)
        finally:
            os.close(snapshot_fd)
        os.chmod(snapshot_path, 0o400)
        immutable_fd = os.open(snapshot_path, os.O_RDONLY | binary_flag() | cloexec_flag() | nofollow_flag())
        immutable_stat = os.fstat(immutable_fd)
        require(stat.S_ISREG(immutable_stat.st_mode) and immutable_stat.st_size == copied, "immutable archive snapshot is invalid")
        return Snapshot(immutable_fd, copied, digest.hexdigest(), path.name, workspace)
    except Exception:
        if immutable_fd is not None:
            try:
                os.close(immutable_fd)
            except OSError:
                pass
        if workspace is not None:
            shutil.rmtree(workspace, ignore_errors=True)
        raise
    finally:
        os.close(descriptor)


def snapshot_digest(snapshot: Snapshot) -> str:
    digest = hashlib.sha256()
    with snapshot.duplicate() as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cleanup_snapshot(snapshot: Snapshot) -> None:
    snapshot.close()
    shutil.rmtree(snapshot.workspace, ignore_errors=True)


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


def validate_link_text(name: str, link: str, limits: Limits) -> None:
    require(isinstance(link, str) and link, f"empty symlink target: {name}")
    require(len(link.encode("utf-8", "strict")) <= limits.link_bytes, f"symlink target exceeds the link limit: {name}")
    require(not link.startswith("/") and "\\" not in link and not re.match(r"^[A-Za-z]:", link), f"escaping symlink: {name} -> {link}")


def resolve_link_target(name: str, link: str, by_name: dict[str, Entry], limits: Limits, stack: tuple[str, ...] = ()) -> str:
    validate_link_text(name, link, limits)
    pending = posixpath.dirname(name).split("/") + link.split("/")
    resolved: list[str] = []
    while pending:
        component = pending.pop(0)
        if component in ("", "."):
            continue
        if component == "..":
            require(resolved, f"symlink traversal escapes archive root: {name} -> {link}")
            resolved.pop()
            continue
        resolved.append(component)
        current = "/".join(resolved)
        intermediate = by_name.get(current)
        if intermediate is not None and intermediate.kind == "symlink":
            require(current not in stack, f"cyclic symlink traversal: {' -> '.join(stack + (current,))}")
            validate_link_text(current, intermediate.link, limits)
            resolved.pop()
            pending = intermediate.link.split("/") + pending
            stack = stack + (current,)
    target = "/".join(resolved)
    require(target in by_name, f"symlink target is not present: {name} -> {link}")
    require(target == "dist" or target.startswith("dist/") or target == "node_modules" or target.startswith("node_modules/") or target == "prisma" or target.startswith("prisma/"), f"symlink traversal escapes runtime roots: {name} -> {link}")
    return target


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
    require(not mode & 0o7000, f"unsafe special permission bits: {name}")
    require(not mode & 0o022, f"group/world-writable archive entry: {name}")
    require(mode & 0o400, f"archive entry is not owner-readable: {name}")
    return mode


def tar_number(field: bytes, label: str) -> int:
    require(len(field) > 0, f"malformed tar {label}")
    if field[0] & 0x80:
        value = int.from_bytes(field, "big", signed=True)
        require(value >= 0, f"negative tar {label}")
        return value
    raw = field.rstrip(b"\0 ")
    require(raw and all(byte in b"01234567" for byte in raw), f"malformed tar {label}")
    return int(raw, 8)


def padded_size(size: int) -> int:
    require(size >= 0, "negative tar size")
    return ((size + 511) // 512) * 512


def validate_tar_header_checksum(header: bytes) -> None:
    try:
        encoded = header[148:156].rstrip(b"\0 ")
        require(encoded and all(byte in b"01234567" for byte in encoded), "malformed tar header checksum")
        expected = int(encoded, 8)
    except ValueError:
        fail("malformed tar header checksum")
    actual = sum(32 if 148 <= index < 156 else byte for index, byte in enumerate(header))
    require(actual == expected, "invalid tar header checksum")


SUPPORTED_PHYSICAL_TYPES = frozenset((0, ord("0"), ord("2"), ord("5"), ord("x"), ord("g"), ord("L"), ord("K")))


def validate_pax_records(payload: bytes, label: str, limits: Limits) -> None:
    offset = 0
    while offset < len(payload):
        space = payload.find(b" ", offset)
        require(space > offset, f"malformed {label} PAX record length")
        length_bytes = payload[offset:space]
        require(length_bytes.isdigit(), f"malformed {label} PAX record length")
        record_length = int(length_bytes)
        require(record_length >= space - offset + 2, f"malformed {label} PAX record length")
        end = offset + record_length
        require(end <= len(payload), f"truncated {label} PAX record")
        record = payload[space + 1:end]
        equals = record.find(b"=")
        require(equals > 0 and record.endswith(b"\n"), f"malformed {label} PAX record")
        key = record[:equals].decode("utf-8", "strict")
        value = record[equals + 1:-1]
        require(key and not key.startswith("GNU.sparse."), f"unsupported sparse PAX metadata: {key}")
        require(len(value) <= limits.metadata_bytes, f"{label} PAX value exceeds the limit: {key}")
        if key == "size":
            fail("PAX size overrides are unsupported")
        elif key == "path":
            require(len(value) <= limits.path_bytes, f"{label} PAX path exceeds the limit")
        elif key == "linkpath":
            require(len(value) <= limits.link_bytes, f"{label} PAX link exceeds the limit")
        offset = end
    require(offset == len(payload), f"malformed {label} PAX metadata")


def preflight_metadata(snapshot: Snapshot, limits: Limits) -> dict[str, int]:
    """Bound physical tar metadata before tarfile sees any extension payload."""
    raw = snapshot.duplicate()
    bounded = BoundedReader(raw, limits.compressed_bytes)
    gzip_stream = gzip.GzipFile(fileobj=bounded, mode="rb")
    stream = TrackedReader(gzip_stream, limits.expanded_bytes + limits.total_headers * 1024 + limits.metadata_total_bytes + 1024)
    total_headers = 0
    metadata_headers = 0
    metadata_total = 0
    global_pax_total = 0
    consecutive_extensions = 0

    def read_exact(size: int, label: str) -> bytes:
        require(size >= 0, f"invalid {label} size")
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = stream.read(min(64 * 1024, remaining))
            require(chunk, f"truncated {label}")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def skip(size: int, label: str) -> None:
        remaining = size
        while remaining:
            chunk = stream.read(min(64 * 1024, remaining))
            require(chunk, f"truncated {label}")
            remaining -= len(chunk)

    try:
        while True:
            header = read_exact(512, "tar header")
            if header == b"\0" * 512:
                require(read_exact(512, "tar end-of-archive block") == b"\0" * 512, "invalid tar termination header")
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    require(not any(chunk), "unexpected data follows tar end-of-archive blocks")
                require(bounded.total == snapshot.size, "gzip stream did not consume the complete archive")
                return {"totalHeaders": total_headers, "metadataHeaders": metadata_headers, "physicalMetadataBytes": metadata_total, "globalPaxBytes": global_pax_total}

            total_headers += 1
            require(total_headers <= limits.total_headers, "total tar header count exceeds the limit")
            validate_tar_header_checksum(header)
            typeflag = header[156]
            require(typeflag in SUPPORTED_PHYSICAL_TYPES, f"unsupported physical tar header type: {chr(typeflag)!r}")
            try:
                size = tar_number(header[124:136], "size")
            except ArtifactError:
                fail("invalid tar termination header")
            padded = padded_size(size)
            extension = typeflag in (ord("x"), ord("g"), ord("L"), ord("K"))
            if extension:
                consecutive_extensions += 1
                require(consecutive_extensions <= limits.extension_headers, "consecutive extension headers exceed the limit")
                metadata_headers += 1
                require(metadata_headers <= limits.metadata_headers, "physical metadata-header count exceeds the limit")
                record_limit = limits.metadata_bytes if typeflag in (ord("x"), ord("g")) else limits.long_name_bytes
                require(size <= record_limit, "extension metadata record exceeds the limit")
                metadata_total += 512 + padded
                require(metadata_total <= limits.metadata_total_bytes, "aggregate physical metadata exceeds the limit")
                payload = read_exact(size, "extension metadata")
                if padded > size:
                    skip(padded - size, "extension metadata padding")
                if typeflag in (ord("x"), ord("g")):
                    validate_pax_records(payload, "global" if typeflag == ord("g") else "local", limits)
                    if typeflag == ord("g"):
                        global_pax_total += len(payload)
                        require(global_pax_total <= limits.pax_global_bytes, "cumulative global PAX metadata exceeds the limit")
                else:
                    require(b"\0" not in payload.rstrip(b"\0"), "malformed GNU long-name metadata")
                continue

            consecutive_extensions = 0
            require(typeflag in (0, ord("0"), ord("2"), ord("5")), f"unsupported physical tar header type: {chr(typeflag)!r}")
            require(size <= limits.file_bytes, "archive entry size exceeds the limit")
            require(typeflag in (0, ord("0")) or size == 0, "non-regular tar entry has a payload")
            if typeflag in (0, ord("0")):
                require(size <= limits.expanded_bytes, "expanded archive exceeds the size limit")
            skip(padded, "archive entry payload")
    except (gzip.BadGzipFile, EOFError, OSError, tarfile.TarError, UnicodeError, ValueError, zlib.error) as error:
        fail(f"malformed archive metadata: {error}")
    finally:
        gzip_stream.close()
        raw.close()


def iter_entries(snapshot: Snapshot, limits: Limits) -> Iterable[tuple[Entry, tarfile.TarInfo, tarfile.TarFile]]:
    raw = snapshot.duplicate()
    bounded = BoundedReader(raw, limits.compressed_bytes)
    gzip_stream = gzip.GzipFile(fileobj=bounded, mode="rb")
    stream = TrackedReader(gzip_stream, limits.expanded_bytes + limits.total_headers * 1024 + limits.metadata_total_bytes + 1024)
    try:
        with tarfile.open(fileobj=stream, mode="r|", bufsize=512, errorlevel=2) as tar:
            count = 0
            expanded = 0
            while True:
                try:
                    info = tar.next()
                except (tarfile.TarError, EOFError, OSError) as error:
                    fail(f"malformed archive: {error}")
                if info is None:
                    require(len(stream.tail) >= 512 and bytes(stream.tail[-512:]) == b"\0" * 512, "invalid tar termination header")
                    stream.marked = True
                    while stream.read(64 * 1024):
                        pass
                    require(not stream.nonzero_after_mark, "unexpected data follows tar end-of-archive blocks")
                    require(stream.total >= 1024 and bytes(stream.tail[-1024:]) == b"\0" * 1024, "invalid tar end-of-archive termination")
                    require(bounded.total == snapshot.size, "gzip stream did not consume the complete archive")
                    break
                count += 1
                require(count <= limits.entry_count, "archive entry count exceeds the limit")
                kind = classify(info)
                require(not getattr(info, "sparse", None), f"sparse archive entries are unsupported: {info.name!r}")
                name = normalized_name(info.name, kind == "directory", limits)
                require(info.name == name or (kind == "directory" and info.name.rstrip("/") == name), f"archive path normalization mismatch: {info.name!r}")
                link = info.linkname if kind == "symlink" else ""
                if kind == "symlink":
                    validate_link_text(name, link, limits)
                metadata_size = sum(len(str(key).encode()) + len(str(value).encode()) for key, value in info.pax_headers.items())
                metadata_size += sum(len(str(key).encode()) + len(str(value).encode()) for key, value in tar.pax_headers.items())
                require(metadata_size <= limits.metadata_bytes, f"archive metadata exceeds the limit: {name}")
                mode = validate_mode(info.mode, name, kind)
                size = int(info.size)
                require(size >= 0 and size <= limits.file_bytes, f"archive file exceeds the per-file limit: {name}")
                if kind == "file":
                    expanded += size
                    require(expanded <= limits.expanded_bytes, "expanded archive exceeds the size limit")
                yield Entry(name, kind, size, mode, link), info, tar
                tar.members.clear()
    except (tarfile.TarError, EOFError, OSError) as error:
        fail(f"malformed archive: {error}")
    finally:
        gzip_stream.close()
        raw.close()


def read_entry(tar: tarfile.TarFile, info: tarfile.TarInfo, limit: int | None = None, retain: bool = True) -> tuple[bytes, str]:
    if limit is not None:
        require(info.size <= limit, "metadata file exceeds the limit")
    extracted = tar.extractfile(info)
    require(extracted is not None, "regular archive entry could not be read")
    chunks: list[bytes] = []
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = extracted.read(min(1024 * 1024, (limit - total + 1) if limit is not None else 1024 * 1024))
        if not chunk:
            break
        total += len(chunk)
        if limit is not None:
            require(total <= limit, f"metadata file exceeds the limit: {info.name}")
            if retain:
                chunks.append(chunk)
        digest.update(chunk)
    require(total == info.size, f"archive entry has unexpected content length: {info.name}")
    return b"".join(chunks), digest.hexdigest()


def read_json_bytes(data: bytes, label: str) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is missing or malformed: {error}")
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def read_stable_bytes(path: Path, limit: int, label: str) -> bytes:
    descriptor, before = open_regular_readonly(path, label)
    try:
        require(before.st_size <= limit, f"{label} exceeds the metadata limit")
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        require(after.st_dev == before.st_dev and after.st_ino == before.st_ino and after.st_size == before.st_size, f"{label} changed during read")
    except OSError as error:
        fail(f"{label} could not be read: {error}")
    finally:
        os.close(descriptor)
    require(len(data) <= limit, f"{label} exceeds the metadata limit")
    return data


def read_sidecar_json(path: Path, limits: Limits, label: str) -> dict:
    return read_json_bytes(read_stable_bytes(path, limits.manifest_bytes, label), label)


def validate_checksum(archive_path: Path, checksum_path: Path, digest: str) -> None:
    data = read_stable_bytes(checksum_path, 512, "checksum metadata")
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


def collect_entries(snapshot: Snapshot, limits: Limits) -> tuple[list[Entry], dict[str, bytes], dict[str, str]]:
    entries: list[Entry] = []
    metadata_files: dict[str, bytes] = {}
    file_hashes: dict[str, str] = {}
    seen: set[str] = set()
    retained_metadata = 0
    for entry, info, tar in iter_entries(snapshot, limits):
        require(entry.name not in seen, f"duplicate archive path: {entry.name}")
        seen.add(entry.name)
        require(entry.name in ALLOWED_ROOTS or entry.name.startswith(tuple(root + "/" for root in ALLOWED_ROOTS)) or entry.name in ("package.json", "yarn.lock", "runtime-artifact-manifest.json"), f"unexpected archive root: {entry.name}")
        if entry.kind == "symlink":
            validate_link_text(entry.name, entry.link, limits)
        retained_metadata += len(entry.name.encode("utf-8")) + len(entry.link.encode("utf-8"))
        require(retained_metadata <= limits.retained_metadata_bytes, "aggregate retained archive metadata exceeds the limit")
        if entry.kind == "file":
            retain = entry.name in {"package.json", "yarn.lock", "prisma/schema.prisma", "runtime-artifact-manifest.json"} or (entry.name.startswith("prisma/migrations/") and entry.name.endswith("/migration.sql"))
            content, file_hashes[entry.name] = read_entry(tar, info, limits.manifest_bytes if retain else None)
            if retain:
                metadata_files[entry.name] = content
                retained_metadata += len(content)
                require(retained_metadata <= limits.retained_metadata_bytes, "aggregate retained input metadata exceeds the limit")
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
            resolve_link_target(entry.name, entry.link, by_name, limits)
    resolve_symlinks(by_name, limits)
    for required in REQUIRED_PATHS:
        require(required in by_name, f"missing required runtime file: {required}")
    for required in REQUIRED_REGULAR_FILES + ("runtime-artifact-manifest.json",):
        require(by_name[required].kind == "file" and by_name[required].size > 0, f"required runtime file is not a non-empty regular file: {required}")
    prisma_link = by_name["node_modules/.bin/prisma"]
    require(prisma_link.kind == "symlink", "Prisma CLI entry is not a symlink")
    prisma_target = by_name[resolve_link_target(prisma_link.name, prisma_link.link, by_name, limits)]
    require(prisma_target.kind == "file" and prisma_target.size > 0 and prisma_target.mode & 0o111, "Prisma CLI symlink does not resolve to an executable file")
    return entries, metadata_files, file_hashes


def resolve_symlinks(by_name: dict[str, Entry], limits: Limits) -> None:
    for name, entry in by_name.items():
        if entry.kind == "symlink":
            target = resolve_link_target(name, entry.link, by_name, limits)
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


def safe_destination(destination: Path) -> Path:
    destination = Path(os.path.abspath(destination))
    require(not os.path.lexists(destination), "extraction destination already exists")
    parent = destination.parent
    require(parent.exists(), "extraction destination parent does not exist")
    current = Path(parent.anchor)
    for component in parent.parts:
        if component in (parent.anchor, ""):
            continue
        current /= component
        metadata = os.lstat(current)
        require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), "extraction destination parent is unsafe")
    return destination


def open_destination_parent(destination: Path) -> int:
    parent = destination.parent
    metadata = os.lstat(parent)
    require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), "extraction destination parent is unsafe")
    descriptor: int | None = None
    try:
        descriptor = os.open(parent, os.O_RDONLY | binary_flag() | cloexec_flag() | nofollow_flag() | nonblocking_flag() | directory_flag())
        opened = os.fstat(descriptor)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        fail(f"extraction destination parent cannot be opened safely: {error}")
    if not stat.S_ISDIR(opened.st_mode) or stat.S_ISLNK(opened.st_mode):
        os.close(descriptor)
        fail("extraction destination parent is unsafe")
    if opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino:
        os.close(descriptor)
        fail("extraction destination parent changed during open")
    return descriptor


def publish_without_replacement(source: Path, destination: Path) -> None:
    """Atomically publish only through a trusted parent and no-replace primitive."""
    require(source.parent == destination.parent, "temporary extraction is outside the destination parent")
    parent_fd = open_destination_parent(destination)
    try:
        if sys.platform == "linux":
            if os.environ.get("RUNTIME_ARTIFACT_TEST_DISABLE_ATOMIC_PUBLISH") == "1":
                fail("atomic no-replacement publication is unavailable")
            try:
                libc = ctypes.CDLL(None, use_errno=True)
                renameat2 = libc.renameat2
            except AttributeError:
                fail("atomic no-replacement publication is unavailable")
            renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            renameat2.restype = ctypes.c_int
            result = renameat2(parent_fd, os.fsencode(source.name), parent_fd, os.fsencode(destination.name), 1)  # RENAME_NOREPLACE
            if result == 0:
                return
            error_number = ctypes.get_errno()
            if error_number == errno.EEXIST:
                fail("extraction destination appeared during validation")
            fail("atomic no-replacement publication is unavailable" if error_number in (errno.ENOSYS, errno.EINVAL) else os.strerror(error_number))
        if os.name == "nt":
            require(not os.path.lexists(destination), "extraction destination appeared during validation")
            os.rename(source, destination)
            return
        fail("atomic no-replacement publication is unavailable")
    finally:
        try:
            os.close(parent_fd)
        except OSError:
            pass


def extract_archive(snapshot: Snapshot, entries: list[Entry], file_hashes: dict[str, str], destination: Path, limits: Limits, validated_digest: str) -> None:
    destination = safe_destination(destination)
    temporary = Path(tempfile.mkdtemp(prefix=".runtime-artifact-extract-", dir=destination.parent))
    os.chmod(temporary, 0o700)
    try:
        if os.environ.get("RUNTIME_ARTIFACT_TEST_ENTRY_MISMATCH") == "1":
            entries[0] = Entry(entries[0].name, entries[0].kind, entries[0].size + 1, entries[0].mode, entries[0].link)
        elif os.environ.get("RUNTIME_ARTIFACT_TEST_CONTENT_MISMATCH") == "1":
            file_hashes["dist/ClashCookies.js"] = "0" * 64
        by_name = {entry.name: entry for entry in entries}
        directory_modes = {entry.name: entry.mode for entry in entries if entry.kind == "directory"}
        symlinks: list[Entry] = []
        seen: set[str] = set()
        for entry, info, tar in iter_entries(snapshot, limits):
            expected = by_name.get(entry.name)
            require(expected is not None and expected == entry, f"archive entry changed between validation and extraction: {entry.name}")
            seen.add(entry.name)
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
                    require(digest.hexdigest() == file_hashes.get(entry.name), f"archive entry content changed between validation and extraction: {entry.name}")
                    if os.environ.get("RUNTIME_ARTIFACT_TEST_FAIL_EXTRACTION") == "1":
                        fail("injected extraction-stage failure")
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
        require(seen == set(by_name), "archive entry set changed between validation and extraction")
        snapshot.verify(validated_digest)
        require(not os.path.lexists(destination), "extraction destination appeared during validation")
        if os.environ.get("RUNTIME_ARTIFACT_TEST_DESTINATION_APPEARS") == "1":
            destination.mkdir()
        publish_without_replacement(temporary, destination)
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
    parser.add_argument("--max-metadata-bytes", type=int, default=Limits.metadata_bytes)
    parser.add_argument("--max-metadata-total-bytes", type=int, default=Limits.metadata_total_bytes)
    parser.add_argument("--max-metadata-headers", type=int, default=Limits.metadata_headers)
    parser.add_argument("--max-total-headers", type=int, default=Limits.total_headers)
    parser.add_argument("--max-extension-headers", type=int, default=Limits.extension_headers)
    parser.add_argument("--max-global-pax-bytes", type=int, default=Limits.pax_global_bytes)
    parser.add_argument("--max-long-name-bytes", type=int, default=Limits.long_name_bytes)
    parser.add_argument("--max-retained-metadata-bytes", type=int, default=Limits.retained_metadata_bytes)
    return parser.parse_args()


def apply_test_hook(archive_path: Path, checksum_path: Path) -> None:
    """Deterministic negative-test seam; hooks fail closed or mutate only the original input."""
    hook = os.environ.get("RUNTIME_ARTIFACT_TEST_HOOK")
    if hook == "replace-source":
        replacement = archive_path.with_name(f"{archive_path.name}.replacement")
        replacement.write_bytes(b"replacement source")
        os.replace(replacement, archive_path)
    elif hook == "mutate-source-preserve-stat":
        metadata = os.stat(archive_path)
        with archive_path.open("r+b") as stream:
            stream.seek(40 if metadata.st_size > 40 else 0)
            original = stream.read(1)
            stream.seek(-1, os.SEEK_CUR)
            stream.write(bytes((original[0] ^ 0xFF,)))
            stream.flush()
        os.utime(archive_path, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
    elif hook == "mutate-checksum":
        checksum_path.write_text(f"{'0' * 64}  {archive_path.name}\n", encoding="ascii")


def peak_memory_bytes() -> int | None:
    try:
        import resource
        value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        return value if sys.platform == "darwin" else value * 1024
    except (ImportError, AttributeError, OSError, ValueError):
        return None


def main() -> int:
    args = parse_args()
    limits = Limits(
        compressed_bytes=args.max_compressed_bytes,
        expanded_bytes=args.max_expanded_bytes,
        entry_count=args.max_entries,
        metadata_bytes=args.max_metadata_bytes,
        metadata_total_bytes=args.max_metadata_total_bytes,
        metadata_headers=args.max_metadata_headers,
        total_headers=args.max_total_headers,
        extension_headers=args.max_extension_headers,
        pax_global_bytes=args.max_global_pax_bytes,
        long_name_bytes=args.max_long_name_bytes,
        retained_metadata_bytes=args.max_retained_metadata_bytes,
    )
    for value, label in ((limits.compressed_bytes, "compressed"), (limits.expanded_bytes, "expanded"), (limits.entry_count, "entry"), (limits.metadata_bytes, "metadata"), (limits.metadata_total_bytes, "aggregate metadata"), (limits.metadata_headers, "metadata header"), (limits.total_headers, "total header"), (limits.extension_headers, "extension header"), (limits.pax_global_bytes, "global PAX"), (limits.long_name_bytes, "long-name"), (limits.retained_metadata_bytes, "retained metadata")):
        require(value > 0, f"{label} limit must be positive")
    archive_path = Path(args.archive)
    checksum_path = Path(args.checksum or f"{archive_path}.sha256")
    manifest_path = Path(args.manifest or f"{archive_path}.manifest.json")
    started = time.monotonic()
    snapshot = snapshot_source(archive_path, limits)
    try:
        digest = snapshot.digest
        apply_test_hook(archive_path, checksum_path)
        validate_checksum(archive_path, checksum_path, digest)
        preflight = preflight_metadata(snapshot, limits)
        entries, metadata_files, file_hashes = collect_entries(snapshot, limits)
        snapshot.verify(digest)
        embedded = read_json_bytes(metadata_files["runtime-artifact-manifest.json"], "embedded manifest")
        external = read_sidecar_json(manifest_path, limits, "published manifest")
        validate_manifest(embedded, snapshot.name, snapshot.size, digest, args, embedded=True)
        validate_manifest(external, snapshot.name, snapshot.size, digest, args, embedded=False)
        compare_manifests(embedded, external)
        manifest_inputs = external["inputs"]
        require(archive_input_hashes(metadata_files, entries) == manifest_inputs, "packaged input hashes or migration inventory do not match manifest")
        if args.source_root:
            source_root = Path(args.source_root).resolve()
            try:
                source_revision = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()
            except (OSError, subprocess.CalledProcessError) as error:
                fail(f"source revision cannot be verified: {error}")
            require(source_revision.lower() == args.expected_sha.lower(), "source checkout does not match expected revision")
            require(source_input_hashes(source_root) == manifest_inputs, "manifest inputs do not match the exact source revision")
        footprint = sum(entry.size for entry in entries if entry.kind == "file" and (entry.name in ("package.json", "yarn.lock", "runtime-artifact-manifest.json") or entry.name.startswith("dist/") or entry.name.startswith("node_modules/") or entry.name.startswith("prisma/")))
        require(external["measurements"]["extractedFootprintBytes"] == footprint, "manifest extracted footprint does not match archive")
        if args.extract:
            extract_archive(snapshot, entries, file_hashes, Path(args.extract), limits, digest)
        print(json.dumps({
            "archive": str(archive_path),
            "sha256": digest,
            "entries": len(entries),
            "sourceSha": external["source"]["gitSha"],
            "archiveBytes": snapshot.size,
            "extractedFootprintBytes": footprint,
            "measurements": {
                "elapsedMs": round((time.monotonic() - started) * 1000, 3),
                "temporaryDiskBytesRequired": snapshot.size + footprint,
                "peakMemoryBytes": peak_memory_bytes(),
                "headers": preflight,
                "limits": {"compressedBytes": limits.compressed_bytes, "expandedBytes": limits.expanded_bytes, "metadataBytes": limits.metadata_bytes, "metadataTotalBytes": limits.metadata_total_bytes, "metadataHeaders": limits.metadata_headers, "totalHeaders": limits.total_headers, "extensionHeaders": limits.extension_headers},
            },
        }, indent=2))
        return 0
    finally:
        cleanup_snapshot(snapshot)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ArtifactError as error:
        print(f"[runtime-artifact] validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, tarfile.TarError, ValueError, KeyError) as error:
        print(f"[runtime-artifact] validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
