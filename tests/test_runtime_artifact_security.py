"""Import-level deterministic security regressions for validate-runtime-artifact.py."""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate-runtime-artifact.py"
SPEC = importlib.util.spec_from_file_location("validate_runtime_artifact", SCRIPT)
assert SPEC and SPEC.loader
validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = validator
SPEC.loader.exec_module(validator)


def tar_header(name: str, typeflag: int, size: int, mode: int) -> bytes:
    header = bytearray(512)
    header[0:100] = name.encode("utf-8")[:100].ljust(100, b"\0")
    header[100:108] = f"{mode:07o}".encode("ascii") + b"\0"
    header[108:116] = b"0000000\0"
    header[116:124] = b"0000000\0"
    header[124:136] = f"{size:011o}".encode("ascii") + b"\0"
    header[136:148] = b"00000000000\0"
    header[148:156] = b"        "
    header[156] = typeflag
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = sum(header)
    header[148:154] = f"{checksum:06o}".encode("ascii")
    header[154] = 0
    header[155] = 32
    return bytes(header)


def runtime_archive() -> bytes:
    content = b"validated snapshot content\n"
    blocks = [
        tar_header("dist", ord("5"), 0, 0o755),
        tar_header("dist/ClashCookies.js", ord("0"), len(content), 0o755),
        content.ljust(512, b"\0"),
        b"\0" * 1024,
    ]
    return gzip.compress(b"".join(blocks))


def collect(snapshot: object, limits: object) -> tuple[list[object], dict[str, str]]:
    entries = []
    hashes: dict[str, str] = {}
    for entry, info, tar in validator.iter_entries(snapshot, limits):
        entries.append(entry)
        if entry.kind == "file":
            stream = tar.extractfile(info)
            assert stream is not None
            digest = hashlib.sha256()
            while chunk := stream.read(64 * 1024):
                digest.update(chunk)
            hashes[entry.name] = digest.hexdigest()
    return entries, hashes


class RuntimeArtifactSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="clashcookies-runtime-security-test-"))
        self.archive = self.root / "runtime.tar.gz"
        self.archive.write_bytes(runtime_archive())
        self.limits = validator.Limits()

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def snapshot_and_collect(self):
        snapshot = validator.snapshot_source(self.archive, self.limits)
        validator.preflight_metadata(snapshot, self.limits)
        entries, hashes = collect(snapshot, self.limits)
        return snapshot, entries, hashes

    def test_original_replacement_and_same_stat_mutation_cannot_change_snapshot(self) -> None:
        original_archive = self.archive.read_bytes()
        snapshot, entries, hashes = self.snapshot_and_collect()
        try:
            replacement = self.archive.with_suffix(".replacement")
            replacement.write_bytes(b"replacement pathname")
            os.replace(replacement, self.archive)
            output = self.root / "replacement-output"
            validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertEqual((output / "dist" / "ClashCookies.js").read_bytes(), b"validated snapshot content\n")
        finally:
            validator.cleanup_snapshot(snapshot)

        self.archive.write_bytes(original_archive)
        snapshot, entries, hashes = self.snapshot_and_collect()
        try:
            metadata = self.archive.stat()
            with self.archive.open("r+b") as stream:
                stream.seek(40)
                value = stream.read(1)
                stream.seek(-1, os.SEEK_CUR)
                stream.write(bytes((value[0] ^ 0xFF,)))
                stream.flush()
            os.utime(self.archive, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
            output = self.root / "mutation-output"
            validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertEqual((output / "dist" / "ClashCookies.js").read_bytes(), b"validated snapshot content\n")
        finally:
            validator.cleanup_snapshot(snapshot)

    def test_sidecar_read_is_bounded_and_detached_from_later_path_mutation(self) -> None:
        sidecar = self.root / "sidecar"
        sidecar.write_bytes(b"old sidecar")
        value = validator.read_stable_bytes(sidecar, 1024, "sidecar")
        sidecar.write_bytes(b"new sidecar")
        self.assertEqual(value, b"old sidecar")

    def test_content_mismatch_cleans_private_workspace_without_publication(self) -> None:
        snapshot, entries, hashes = self.snapshot_and_collect()
        hashes["dist/ClashCookies.js"] = "0" * 64
        output = self.root / "content-mismatch-output"
        try:
            with self.assertRaises(validator.ArtifactError):
                validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertFalse(output.exists())
            self.assertEqual(list(self.root.glob(".runtime-artifact-extract-*")), [])
        finally:
            validator.cleanup_snapshot(snapshot)

    def test_entry_contract_mismatch_cleans_private_workspace_without_publication(self) -> None:
        snapshot, entries, hashes = self.snapshot_and_collect()
        entries[0] = validator.Entry(entries[0].name, entries[0].kind, entries[0].size + 1, entries[0].mode, entries[0].link)
        output = self.root / "entry-mismatch-output"
        try:
            with self.assertRaises(validator.ArtifactError):
                validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertFalse(output.exists())
            self.assertEqual(list(self.root.glob(".runtime-artifact-extract-*")), [])
        finally:
            validator.cleanup_snapshot(snapshot)

    def test_injected_extraction_failure_cleans_workspace(self) -> None:
        snapshot, entries, hashes = self.snapshot_and_collect()
        output = self.root / "extraction-failure-output"
        try:
            with patch.object(validator.os, "chmod", side_effect=OSError("injected extraction failure")):
                with self.assertRaises(OSError):
                    validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertFalse(output.exists())
            self.assertEqual(list(self.root.glob(".runtime-artifact-extract-*")), [])
        finally:
            validator.cleanup_snapshot(snapshot)

    def test_destination_parent_substitution_is_rejected_before_publication(self) -> None:
        if sys.platform != "linux":
            self.skipTest("descriptor-anchored parent substitution regression is Linux-specific")
        parent = self.root / "destination-parent"
        parent.mkdir()
        output = parent / "runtime"
        snapshot, entries, hashes = self.snapshot_and_collect()
        original_create = validator.create_extraction_workspace
        backup = self.root / "destination-parent-original"

        def create_and_replace(parent_path: Path, parent_fd: int):
            workspace = original_create(parent_path, parent_fd)
            parent_path.rename(backup)
            parent_path.mkdir()
            return workspace

        try:
            with patch.object(validator, "create_extraction_workspace", side_effect=create_and_replace):
                with self.assertRaises(validator.ArtifactError) as error:
                    validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertIn("destination parent changed", str(error.exception))
            self.assertFalse(output.exists())
        finally:
            if parent.exists():
                shutil.rmtree(parent)
            if backup.exists():
                backup.rename(parent)
            validator.cleanup_snapshot(snapshot)

    def test_publication_failure_and_destination_appearance_leave_no_runtime(self) -> None:
        snapshot, entries, hashes = self.snapshot_and_collect()
        output = self.root / "publication-failure-output"
        original_publish = validator.publish_without_replacement

        def appear_then_publish(workspace, destination, parent_fd):
            destination.mkdir()
            return original_publish(workspace, destination, parent_fd)

        try:
            with patch.object(validator, "publish_without_replacement", side_effect=appear_then_publish):
                with self.assertRaises(validator.ArtifactError):
                    validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertTrue(output.is_dir())
            self.assertEqual(list(self.root.glob(".runtime-artifact-extract-*")), [])
        finally:
            validator.cleanup_snapshot(snapshot)

    def test_unsupported_atomic_publication_fails_closed(self) -> None:
        snapshot, entries, hashes = self.snapshot_and_collect()
        output = self.root / "unsupported-publication-output"
        try:
            with patch.object(validator, "publish_without_replacement", side_effect=validator.ArtifactError("atomic no-replacement publication is unavailable")):
                with self.assertRaises(validator.ArtifactError):
                    validator.extract_archive(snapshot, entries, hashes, output, self.limits, snapshot.digest)
            self.assertFalse(output.exists())
            self.assertEqual(list(self.root.glob(".runtime-artifact-extract-*")), [])
        finally:
            validator.cleanup_snapshot(snapshot)


if __name__ == "__main__":
    unittest.main()
