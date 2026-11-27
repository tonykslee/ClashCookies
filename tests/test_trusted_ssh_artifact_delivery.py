"""Focused regressions for the bounded trusted-SSH delivery boundary."""

from __future__ import annotations

from io import BytesIO
import importlib.util
import json
import getpass
import errno
import os
import pickle
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import base64
import ctypes
import hashlib
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "trusted_ssh_artifact_delivery.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("trusted_ssh_artifact_delivery", SCRIPT)
assert SPEC and SPEC.loader
delivery = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = delivery
SPEC.loader.exec_module(delivery)

PREP_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "immutable_runtime_preparation.py"
PREP_SPEC = importlib.util.spec_from_file_location("immutable_runtime_preparation_integration", PREP_SCRIPT)
assert PREP_SPEC and PREP_SPEC.loader
preparation = importlib.util.module_from_spec(PREP_SPEC)
sys.modules[PREP_SPEC.name] = preparation
PREP_SPEC.loader.exec_module(preparation)

def development_identity() -> object:
    return delivery.DevelopmentDeliveryIdentity(
        repository="tonykslee/ClashCookies",
        repository_id=668452496,
        repository_owner_id=18295450,
        source_ref="refs/heads/dev",
        source_sha="a" * 40,
        event="push",
        producer_workflow=".github/workflows/runtime-artifact.yml",
        producer_revision="b" * 40,
        signer_workflow=".github/workflows/runtime-artifact.yml",
        signer_revision="c" * 40,
        run_id=123,
        run_attempt=1,
        artifact_id=456,
        artifact_name="runtime-artifact-123-1",
        artifact_class=delivery.provenance.DEVELOPMENT_ARTIFACT_CLASS,
        artifact_service_zip_sha256="d" * 64,
        artifact_service_zip_bytes=3,
        archive_name="clashcookies-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tar.gz",
        archive_sha256="e" * 64,
        archive_bytes=4,
        platform="linux/amd64",
        image="node:20-bookworm@sha256:" + "f" * 64,
        image_digest="sha256:" + "f" * 64,
        authorization_context="ci-selection-only",
    )


def synthetic_canonical_identity() -> delivery.provenance.TrustedReleaseIdentity:
    source_sha = "1" * 40
    return delivery.provenance.TrustedReleaseIdentity(
        repository=delivery.provenance.RELEASE_REPOSITORY,
        repository_id=delivery.provenance.RELEASE_REPOSITORY_ID,
        repository_owner_id=delivery.provenance.RELEASE_REPOSITORY_OWNER_ID,
        source_ref=delivery.provenance.RELEASE_SOURCE_REF,
        source_sha=source_sha,
        event=delivery.provenance.RELEASE_EVENT,
        producer_workflow=delivery.provenance.RELEASE_PRODUCER_WORKFLOW,
        producer_revision="a" * 40,
        signer_workflow=delivery.provenance.RELEASE_SIGNER_WORKFLOW,
        signer_revision="b" * 40,
        run_id=12345,
        run_attempt=1,
        artifact_id=67890,
        artifact_name=delivery.provenance.expected_artifact_name(12345, 1),
        artifact_class=delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS,
        artifact_service_zip_sha256="c" * 64,
        artifact_service_zip_bytes=1,
        archive_name=f"clashcookies-runtime-{source_sha}.tar.gz",
        archive_sha256="d" * 64,
        archive_bytes=1,
        platform=delivery.provenance.RELEASE_PLATFORM,
        image=delivery.provenance.RELEASE_IMAGE,
        image_digest=delivery.provenance.RELEASE_IMAGE.split("@", 1)[1],
        authorization_context=delivery.provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT,
    )


CANDIDATE_WORKFLOW_DISPLAY_NAME = "Runtime Artifact Round Trip"


def candidate_run_metadata(identity: delivery.provenance.TrustedReleaseIdentity) -> dict[str, object]:
    """Return representative GitHub run metadata, including the API's display-name key."""
    owner = identity.repository.split("/", 1)[0]
    return {
        "id": identity.run_id,
        "name": CANDIDATE_WORKFLOW_DISPLAY_NAME,
        "event": identity.event,
        "run_attempt": identity.run_attempt,
        "path": identity.signer_workflow,
        "head_sha": identity.source_sha,
        "head_branch": identity.source_ref.removeprefix("refs/heads/"),
        "repository": {"full_name": identity.repository, "id": identity.repository_id, "owner": {"id": identity.repository_owner_id, "login": owner}},
        "head_repository": {"full_name": identity.repository, "id": identity.repository_id, "owner": {"id": identity.repository_owner_id, "login": owner}},
    }


def retained_candidate_context(identity: delivery.provenance.TrustedReleaseIdentity, archive_validation: dict[str, object], now: datetime) -> dict[str, object]:
    """Build retained evidence around the validator result used by owner preparation."""
    stamp = lambda value: value.isoformat().replace("+00:00", "Z")
    created = now - timedelta(minutes=7)
    started = now - timedelta(minutes=6)
    boundary = now - timedelta(minutes=2)
    updated = now - timedelta(minutes=1)
    return {
        "contract": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_CONTRACT,
        "version": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_VERSION,
        "authoritative": False,
        "independentlyCompleted": True,
        "run": {"id": identity.run_id, "attempt": identity.run_attempt, "status": "completed", "conclusion": "success", "createdAt": stamp(created), "startedAt": stamp(started), "updatedAt": stamp(updated), "jobCompletionBoundary": stamp(boundary)},
        "jobs": [{"id": index, "runId": identity.run_id, "runAttempt": identity.run_attempt, "headSha": identity.source_sha, "name": name, "status": "completed", "conclusion": "success", "startedAt": stamp(started), "completedAt": stamp(boundary), "steps": [{"name": step, "status": "completed", "conclusion": "success"} for step in steps]} for index, (name, steps) in enumerate(delivery.provenance.CANDIDATE_REQUIRED_JOBS.items(), 1)],
        "attestation": {"status": "official-verifier-authenticated", "authenticated": True, "verifier": "isolated-synthetic-verifier", "verifierVersion": delivery.provenance.SUPPORTED_GH_VERSION, "subjectDigest": identity.archive_sha256},
        "archiveValidation": archive_validation,
        "workflowIdentity": {"producerWorkflow": identity.producer_workflow, "producerRevision": identity.producer_revision, "signerWorkflow": identity.signer_workflow, "signerRevision": identity.signer_revision, "policy": "immutable-owner-allowlist"},
        "verificationCompletedAt": stamp(now),
    }


def build_candidate_validator_fixture(root: Path, source_service_zip: Path, source_identity: delivery.provenance.TrustedReleaseIdentity, candidate_nonce: str = "default") -> dict[str, object]:
    """Build an explicitly synthetic candidate archive from the real dev artifact shape."""
    with ZipFile(source_service_zip) as source_service:
        source_archive_bytes = source_service.read(source_identity.archive_name)
        source_manifest = json.loads(source_service.read(f"{source_identity.archive_name}.manifest.json"))
    nonce_digest = hashlib.sha256(candidate_nonce.encode("utf-8")).hexdigest()
    source_sha = nonce_digest[:40]
    run_id = 2987654321 + int(nonce_digest[:6], 16)
    run_attempt = 1
    signer_revision = hashlib.sha256((candidate_nonce + ":signer").encode("utf-8")).hexdigest()[:40]
    producer_revision = hashlib.sha256((candidate_nonce + ":producer").encode("utf-8")).hexdigest()[:40]
    archive_name = f"clashcookies-runtime-{source_sha}.tar.gz"
    candidate_manifest = json.loads(json.dumps(source_manifest))
    candidate_manifest["artifact"].update({"name": archive_name, "artifactClass": delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "profile": delivery.provenance.PRODUCTION_CANDIDATE_PROFILE, "nonProductionEvidence": True})
    candidate_manifest["source"]["gitSha"] = source_sha
    candidate_manifest["identity"].update({"event": "push", "kind": "production_candidate_main_push", "authorizationContext": delivery.provenance.CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT, "deployableRelease": False})
    candidate_manifest["workflow"].update({"name": CANDIDATE_WORKFLOW_DISPLAY_NAME, "runId": str(run_id), "runAttempt": str(run_attempt), "ref": delivery.provenance.RELEASE_SOURCE_REF, "repository": delivery.provenance.RELEASE_REPOSITORY, "repositoryId": str(delivery.provenance.RELEASE_REPOSITORY_ID), "repositoryOwnerId": str(delivery.provenance.RELEASE_REPOSITORY_OWNER_ID), "sourceRef": delivery.provenance.RELEASE_SOURCE_REF, "workflowPath": delivery.provenance.RELEASE_SIGNER_WORKFLOW, "signerWorkflow": delivery.provenance.RELEASE_SIGNER_WORKFLOW, "signerRevision": signer_revision})
    candidate_manifest["build"].update({"platform": delivery.provenance.RELEASE_PLATFORM, "architecture": "amd64", "baseImage": delivery.provenance.RELEASE_IMAGE, "baseImageDigest": delivery.provenance.RELEASE_IMAGE.split("@", 1)[1]})
    candidate_manifest["integrity"]["checksumFile"] = f"{archive_name}.sha256"
    with tarfile.open(fileobj=BytesIO(source_archive_bytes), mode="r:gz") as source_tar:
        tar_members: list[tuple[tarfile.TarInfo, bytes | None]] = []
        for member in source_tar.getmembers():
            payload = source_tar.extractfile(member).read() if member.isfile() else None
            if member.name == "runtime-artifact-manifest.json":
                payload = json.dumps(candidate_manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
                member.size = len(payload)
            member.pax_headers = {}
            tar_members.append((member, payload))
    archive_buffer = BytesIO()
    with tarfile.open(fileobj=archive_buffer, mode="w:gz", format=tarfile.GNU_FORMAT) as candidate_tar:
        for member, payload in tar_members:
            candidate_tar.addfile(member, BytesIO(payload) if payload is not None else None)
    candidate_archive_bytes = archive_buffer.getvalue()
    archive_digest = hashlib.sha256(candidate_archive_bytes).hexdigest()
    footprint = sum(member.size for member, _payload in tar_members if member.isfile() and (member.name in {"package.json", "yarn.lock", "runtime-artifact-manifest.json"} or member.name.startswith(("dist/", "node_modules/", "prisma/"))))
    external_manifest = json.loads(json.dumps(candidate_manifest))
    external_manifest["artifact"].update({"archiveSha256": archive_digest, "archiveBytes": len(candidate_archive_bytes)})
    external_manifest["integrity"]["sha256"] = archive_digest
    external_manifest["measurements"].update({"archiveBytes": len(candidate_archive_bytes), "extractedFootprintBytes": footprint})
    candidate_identity = delivery.provenance.TrustedReleaseIdentity(
        repository=delivery.provenance.RELEASE_REPOSITORY, repository_id=delivery.provenance.RELEASE_REPOSITORY_ID, repository_owner_id=delivery.provenance.RELEASE_REPOSITORY_OWNER_ID,
        source_ref=delivery.provenance.RELEASE_SOURCE_REF, source_sha=source_sha, event="push", producer_workflow=delivery.provenance.RELEASE_PRODUCER_WORKFLOW, producer_revision=producer_revision,
        signer_workflow=delivery.provenance.RELEASE_SIGNER_WORKFLOW, signer_revision=signer_revision, run_id=run_id, run_attempt=run_attempt, artifact_id=987654,
        artifact_name=f"runtime-artifact-{run_id}-{run_attempt}", artifact_class=delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS,
        artifact_service_zip_sha256="0" * 64, artifact_service_zip_bytes=1, archive_name=archive_name, archive_sha256=archive_digest, archive_bytes=len(candidate_archive_bytes),
        platform=delivery.provenance.RELEASE_PLATFORM, image=delivery.provenance.RELEASE_IMAGE, image_digest=delivery.provenance.RELEASE_IMAGE.split("@", 1)[1], authorization_context=delivery.provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT,
    )
    archive_path = root / archive_name
    archive_path.write_bytes(candidate_archive_bytes)
    service_zip = root / "candidate-artifact-service.zip"
    with ZipFile(service_zip, "w") as candidate_service:
        candidate_service.writestr(archive_name, candidate_archive_bytes)
        candidate_service.writestr(f"{archive_name}.sha256", f"{archive_digest}  {archive_name}\n")
        candidate_service.writestr(f"{archive_name}.manifest.json", json.dumps(external_manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    service_digest = hashlib.sha256(service_zip.read_bytes()).hexdigest()
    candidate_identity = replace(candidate_identity, artifact_service_zip_sha256=service_digest, artifact_service_zip_bytes=service_zip.stat().st_size)
    run_metadata = candidate_run_metadata(candidate_identity)
    receiver_context = {
        "repository": candidate_identity.repository,
        "workflow_name": CANDIDATE_WORKFLOW_DISPLAY_NAME,
        "run_id": candidate_identity.run_id,
        "run_attempt": candidate_identity.run_attempt,
        "event": candidate_identity.event,
        "source_ref": candidate_identity.source_ref,
    }
    return {"identity": candidate_identity, "service_zip": service_zip, "context": run_metadata, "receiver_context": receiver_context, "external_manifest": external_manifest, "archive_digest": archive_digest, "archive_bytes": len(candidate_archive_bytes)}


def sshd_setenv(assignments: dict[str, object]) -> str:
    """Emit one quoted SetEnv directive so every receiver-owned value reaches the session."""
    encoded = []
    for name, value in assignments.items():
        text = str(value).replace("\\", "\\\\").replace('"', '\\"')
        encoded.append(f'{name}="{text}"')
    return "SetEnv " + " ".join(encoded)


class TrustedSshDeliveryTests(unittest.TestCase):
    def test_rename_noreplace_collision_preserves_destination_error_cross_platform(self) -> None:
        class FakeLibc:
            def __init__(self) -> None:
                self.renameat2 = lambda *_args: -1

        fake_libc = FakeLibc()
        with patch.object(ctypes, "CDLL", return_value=fake_libc), patch.object(ctypes, "get_errno", return_value=errno.EEXIST), patch.object(delivery.os, "name", "posix"):
            with self.assertRaises(FileExistsError) as context:
                delivery._rename_noreplace(7, "staging-directory", "accepted-directory")
        self.assertEqual(context.exception.args, ("accepted-directory",))

    @unittest.skipUnless(os.name == "posix", "retained publication retry filesystem verification requires POSIX")
    def test_retry_matches_and_fsynchronizes_retained_verification_evidence(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            checkout = root / "checkout"
            publication = root / "publication"
            checkout.mkdir(mode=0o700)
            publication.mkdir(mode=0o700)
            if os.name == "posix":
                root.chmod(0o700)
                checkout.chmod(0o700)
                publication.chmod(0o700)
            archive_name = development_identity().archive_name
            archive_bytes = b"test"
            service_zip = root / "artifact-service.zip"
            with ZipFile(service_zip, "w") as archive:
                archive.writestr(archive_name, archive_bytes)
            digest = hashlib.sha256(service_zip.read_bytes()).hexdigest()
            identity = replace(development_identity(), artifact_service_zip_sha256=digest, artifact_service_zip_bytes=service_zip.stat().st_size, archive_sha256=hashlib.sha256(archive_bytes).hexdigest())
            destination = publication / "release"
            destination.mkdir(mode=0o700)
            (destination / "identity.json").write_text(json.dumps(delivery._identity_payload(identity), sort_keys=True, separators=(",", ":")), encoding="utf-8")
            (destination / "artifact-service.zip").write_bytes(service_zip.read_bytes())
            expected_verification = {}
            for name, payload in (("verification-expectation.json", b"expectation\n"), ("verification-receipt.json", b"receipt\n"), ("trusted-root.jsonl", b"root\n")):
                (destination / name).write_bytes(payload)
                expected_verification[name] = (hashlib.sha256(payload).hexdigest(), len(payload))
            for path in destination.iterdir():
                if os.name == "posix":
                    path.chmod(0o600)
            self.assertEqual(delivery.identity_from_json(json.loads((destination / "identity.json").read_text(encoding="utf-8"))), identity)
            self.assertEqual(delivery.provenance._sha256_file(destination / "artifact-service.zip", delivery.MAX_SERVICE_ZIP_BYTES, "test service")[0], identity.artifact_service_zip_sha256)
            self.assertEqual({path.name for path in destination.iterdir()}, {"identity.json", "artifact-service.zip", *expected_verification})
            self.assertTrue(delivery._payload_matches(destination, identity, expected_verification=expected_verification))
            delivery._fsync_existing_publication(destination, None, None, expected_verification)
            (destination / "verification-receipt.json").write_bytes(b"substituted\n")
            self.assertFalse(delivery._payload_matches(destination, identity, expected_verification=expected_verification))

    def test_synthetic_authorization_fixture_uses_delivery_provenance_module(self) -> None:
        identity = synthetic_canonical_identity()
        self.assertIs(type(identity), delivery.provenance.TrustedReleaseIdentity)
        delivery.provenance.validate_trusted_release_identity(identity)

    def test_development_receiver_passes_explicit_class_to_manifest_validator(self) -> None:
        identity = development_identity()

        class FakeValidator:
            class Limits:
                pass

            def __init__(self) -> None:
                self.expected = []

            def make_manifest_expectation(self, **kwargs: object) -> object:
                return SimpleNamespace(**kwargs)

            def snapshot_source(self, _archive: Path, _limits: object, workspace_root: Path | None = None) -> object:
                return SimpleNamespace(digest=getattr(self, "archive_digest", identity.archive_sha256), size=getattr(self, "archive_size", identity.archive_bytes))

            def validate_checksum(self, *_args: object) -> None:
                return None

            def preflight_metadata(self, *_args: object) -> None:
                return None

            def collect_entries(self, *_args: object) -> tuple[list[object], dict[str, Path], dict[str, str]]:
                return [], {"runtime-artifact-manifest.json": Path("embedded-manifest")}, {}

            def read_json_bytes(self, *_args: object) -> dict:
                return {"artifact": {"artifactClass": getattr(self, "artifact_class", delivery.provenance.DEVELOPMENT_ARTIFACT_CLASS)}}

            def read_sidecar_json(self, *_args: object) -> dict:
                return {"inputs": {"fixture": "hash"}}

            def validate_manifest(self, _manifest: dict, _archive_name: str, _size: int, _digest: str, expected: object, embedded: bool = False) -> None:
                self.expected.append(expected)

            def compare_manifests(self, *_args: object) -> None:
                return None

            def archive_input_hashes(self, *_args: object) -> dict[str, str]:
                return {"fixture": "hash"}

            def extract_archive(self, *_args: object) -> None:
                return None

            def cleanup_snapshot(self, *_args: object) -> None:
                return None

        validator = FakeValidator()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            archive = root / identity.archive_name
            checksum = root / f"{identity.archive_name}.sha256"
            manifest = root / f"{identity.archive_name}.manifest.json"
            staging = root / "staging"
            archive.write_bytes(b"test")
            checksum.write_text("checksum", encoding="utf-8")
            manifest.write_text("{}", encoding="utf-8")
            staging.mkdir()
            with patch.object(delivery, "_load_validator", return_value=validator):
                delivery._validate_inner_archive(archive, checksum, manifest, identity, staging)

        self.assertEqual(len(validator.expected), 2)
        self.assertTrue(all(getattr(expected, "expected_artifact_class") == delivery.provenance.DEVELOPMENT_ARTIFACT_CLASS for expected in validator.expected))

        candidate = replace(synthetic_canonical_identity(), archive_sha256=hashlib.sha256(b"test").hexdigest(), archive_bytes=4)
        validator.expected.clear()
        validator.artifact_class = candidate.artifact_class
        validator.archive_digest = candidate.archive_sha256
        validator.archive_size = candidate.archive_bytes
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            archive = root / candidate.archive_name
            checksum = root / f"{candidate.archive_name}.sha256"
            manifest = root / f"{candidate.archive_name}.manifest.json"
            staging = root / "staging"
            archive.write_bytes(b"test")
            checksum.write_text("checksum", encoding="utf-8")
            manifest.write_text("{}", encoding="utf-8")
            staging.mkdir()
            with patch.object(delivery, "_load_validator", return_value=validator):
                delivery._validate_inner_archive(archive, checksum, manifest, candidate, staging)
        self.assertTrue(all(getattr(expected, "expected_artifact_class") == delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS for expected in validator.expected))

    def test_candidate_receiver_requires_explicit_authorization_custody(self) -> None:
        identity = synthetic_canonical_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            checkout = root / "checkout"
            checkout.mkdir(mode=0o700)
            expected = root / "expected-identity.json"
            expected.write_bytes(delivery.provenance._canonical_json(delivery._identity_payload(identity)) + b"\n")
            expected.chmod(0o600)
            args = SimpleNamespace(
                repository_root=str(checkout), receiving_root=str(root / "receiving"), publication_root=str(root / "publication"), expected_identity=str(expected),
                authorization_policy=None,
            )
            with self.assertRaisesRegex(delivery.DeliveryError, "receiver-side authorization policy"):
                delivery.receive_command(args)

    def test_delivery_storage_admission_includes_candidate_context_and_journal_bounds(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            receiving = root / "receiving"
            publication = root / "publication"
            journal = root / "journal"
            for path in (receiving, publication, journal):
                path.mkdir(mode=0o700)
            captured: dict[str, object] = {}

            def observe(paths: list[Path], **kwargs: object) -> delivery.retention.StorageAssessment:
                captured["paths"] = paths
                captured.update(kwargs)
                return delivery.retention.StorageAssessment("PASS", (), 0, 0)

            with patch.object(delivery.shutil, "disk_usage", return_value=SimpleNamespace(free=10**18)), patch.object(delivery.retention, "assess_storage", side_effect=observe):
                delivery._assert_delivery_storage(receiving, delivery.DeliveryLimits(max_temporary_bytes=123), publication, additional_paths=(journal,))
            self.assertIn(journal, captured["paths"])
            self.assertEqual(captured["persistent_bytes"], delivery.MAX_SERVICE_ZIP_BYTES + (4 * delivery.MAX_BUNDLE_BYTES) + delivery.provenance.MAX_AUTHORIZATION_RECORD_BYTES + delivery.MAX_REPLAY_RECORD_BYTES)
            self.assertGreater(captured["temporary_inodes"], delivery.retention.DEFAULT_TEMP_INODES)
            self.assertGreater(captured["persistent_inodes"], delivery.retention.DEFAULT_PERSISTENT_INODES)

    @unittest.skipUnless(os.name == "posix", "journal filesystem admission regression requires POSIX statvfs")
    def test_delivery_storage_admission_blocks_insufficient_journal_bytes_and_inodes(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            receiving = root / "receiving"
            publication = root / "publication"
            journal = root / "journal"
            for path in (receiving, publication, journal):
                path.mkdir(mode=0o700)
            real_stat = delivery.retention.os.stat
            real_statvfs = delivery.retention.os.statvfs

            def fake_stat(path: object, *args: object, **kwargs: object) -> object:
                return SimpleNamespace(st_dev=2 if Path(path).resolve() == journal.resolve() else 1)

            def fake_statvfs(path: object) -> object:
                constrained = Path(path).resolve() == journal.resolve()
                return SimpleNamespace(f_bavail=0 if constrained else 10**9, f_frsize=1, f_favail=0 if constrained else 10**9)

            with patch.object(delivery.shutil, "disk_usage", return_value=SimpleNamespace(free=10**18)), patch.object(delivery.retention.os, "stat", side_effect=fake_stat), patch.object(delivery.retention.os, "statvfs", side_effect=fake_statvfs):
                with self.assertRaisesRegex(delivery.DeliveryError, "storage admission"):
                    delivery._assert_delivery_storage(receiving, delivery.DeliveryLimits(max_temporary_bytes=1), publication, additional_paths=(journal,))

    def test_snapshot_copy_uses_the_zip_snapshot_sha256_contract(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            source = root / "source.zip"
            destination = root / "copied.zip"
            source.write_bytes(b"snapshot bytes")
            snapshot = delivery.provenance.open_zip_snapshot(source)
            try:
                delivery._write_snapshot(snapshot, destination)
            finally:
                delivery.provenance.close_zip_snapshot(snapshot)
            self.assertEqual(destination.read_bytes(), source.read_bytes())

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink regression requires symlink support")
    def test_attempt_bytes_accounts_for_validated_relative_symlinks_without_following(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            (root / "target").write_bytes(b"target")
            try:
                (root / "link").symlink_to("target")
            except OSError as error:
                self.skipTest(f"symlink creation unavailable: {error}")
            self.assertGreaterEqual(delivery._attempt_bytes(root, 64), len(b"target") + len(b"target"))
            (root / "escape").symlink_to("../outside")
            with self.assertRaises(delivery.DeliveryError):
                delivery._attempt_bytes(root, 64)

    @unittest.skipUnless(os.name == "posix", "attempt identity regression requires POSIX descriptors")
    def test_owned_attempt_directory_substitution_is_not_deleted(self) -> None:
        with TemporaryDirectory() as root_name:
            parent = Path(root_name)
            parent.chmod(0o700)
            replacement = None
            original = None
            with self.assertRaisesRegex(delivery.DeliveryError, "temporary directory was substituted"):
                with delivery._owned_temp_directory(parent, "identity-test-") as attempt_owner:
                    attempt = attempt_owner.path
                    assert attempt is not None
                    original = attempt.with_name(attempt.name + "-original")
                    attempt.rename(original)
                    attempt.mkdir(mode=0o700)
                    replacement = attempt
            self.assertIsNotNone(original)
            self.assertIsNotNone(replacement)
            self.assertTrue(original.is_dir())
            self.assertTrue(replacement.is_dir())

    @unittest.skipUnless(os.name == "posix", "attempt disappearance regression requires POSIX descriptors")
    def test_owned_attempt_directory_disappearance_fails_closed(self) -> None:
        with TemporaryDirectory() as root_name:
            parent = Path(root_name)
            parent.chmod(0o700)
            with self.assertRaisesRegex(delivery.DeliveryError, "temporary directory disappeared"):
                with delivery._owned_temp_directory(parent, "disappearance-test-") as attempt_owner:
                    attempt = attempt_owner.path
                    assert attempt is not None
                    shutil.rmtree(attempt)

    @unittest.skipUnless(sys.platform.startswith("linux"), "publication handoff regression requires Linux renameat2")
    def test_publication_handoff_preserves_content_after_post_rename_failure(self) -> None:
        identity = development_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            root.chmod(0o700)
            publication = root / "publication"
            publication.mkdir(mode=0o700)
            with self.assertRaisesRegex(delivery.DeliveryError, "post-rename failure"):
                with delivery._owned_temp_directory(publication, "handoff-test-") as staging_owner:
                    staging = staging_owner.path
                    assert staging is not None
                    (staging / "marker").write_bytes(b"accepted")
                    with patch.object(delivery, "_payload_matches", side_effect=delivery.DeliveryError("post-rename failure")):
                        delivery._publish_payload(staging, publication, identity, staging_owner=staging_owner)
            destination = publication / delivery._safe_publication_name(identity)
            self.assertEqual((destination / "marker").read_bytes(), b"accepted")
            self.assertFalse(staging.exists())

    def test_frame_round_trip_is_bounded_and_exact(self) -> None:
        identity = development_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            artifact = root / "artifact.zip"
            artifact.write_bytes(b"zip")
            header = delivery._frame_header_without_destination(identity, [("artifact-service.zip", artifact, 3)], "/srv/evidence")
            stream = BytesIO()
            delivery._write_frame(stream, header, [("artifact-service.zip", artifact, 3)])
            stream.seek(0)
            attempt = root / "attempt"
            attempt.mkdir()
            payload, files, destination = delivery._read_frame(stream, attempt, delivery.DeliveryLimits())
            self.assertEqual(payload, delivery._identity_payload(identity))
            self.assertEqual(destination, "/srv/evidence")
            self.assertEqual(files["artifact-service.zip"].read_bytes(), b"zip")

    def test_truncated_frame_and_unsafe_file_name_fail_closed(self) -> None:
        identity = development_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            artifact = root / "artifact.zip"
            artifact.write_bytes(b"zip")
            header = json.loads(delivery._frame_header_without_destination(identity, [("artifact-service.zip", artifact, 3)], "/srv/evidence"))
            header["files"][0]["name"] = "../artifact-service.zip"
            encoded = json.dumps(header, separators=(",", ":")).encode()
            truncated = delivery.FRAME_MAGIC + len(encoded).to_bytes(4, "big") + encoded + b"zi"
            with self.assertRaises(delivery.DeliveryError):
                delivery._read_frame(BytesIO(truncated), root, delivery.DeliveryLimits())

    def test_frame_rejects_trailing_data(self) -> None:
        identity = development_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            artifact = root / "artifact.zip"
            artifact.write_bytes(b"zip")
            header = delivery._frame_header_without_destination(identity, [("artifact-service.zip", artifact, 3)], "/srv/evidence")
            stream = BytesIO()
            delivery._write_frame(stream, header, [("artifact-service.zip", artifact, 3)])
            stream.write(b"unexpected")
            stream.seek(0)
            attempt = root / "attempt"
            attempt.mkdir()
            with self.assertRaises(delivery.DeliveryError):
                delivery._read_frame(stream, attempt, delivery.DeliveryLimits())

    def test_checksum_sidecar_limit_is_enforced_before_extraction(self) -> None:
        base_identity = development_identity()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            source = root / "artifact-service.zip"
            output = root / "attempt"
            output.mkdir(mode=0o700)
            archive_buffer = BytesIO()
            with tarfile.open(fileobj=archive_buffer, mode="w:gz") as tar:
                content = b"{}"
                member = tarfile.TarInfo("package.json")
                member.size = len(content)
                tar.addfile(member, BytesIO(content))
            inner_archive = archive_buffer.getvalue()
            identity = replace(base_identity, archive_sha256=hashlib.sha256(inner_archive).hexdigest(), archive_bytes=len(inner_archive))
            with ZipFile(source, "w") as archive:
                archive.writestr(identity.archive_name, inner_archive)
                archive.writestr(f"{identity.archive_name}.sha256", b"x" * (delivery.MAX_CHECKSUM_BYTES + 1))
                archive.writestr(f"{identity.archive_name}.manifest.json", b"{}")
            snapshot = delivery.provenance.open_zip_snapshot(source, directory=output)
            try:
                with self.assertRaisesRegex(delivery.DeliveryError, r"required ZIP entry .*\.sha256 exceeds its limit"):
                    delivery._extract_original_entries(snapshot, identity, output)
            finally:
                delivery.provenance.close_zip_snapshot(snapshot)

    def test_acknowledgment_is_identity_and_publication_bound(self) -> None:
        identity = development_identity()
        endpoint = delivery.SshDeliveryEndpoint(
            host="receiver", user="owner", known_hosts=Path("/tmp/known_hosts"), identity_file=Path("/tmp/id"),
            destination="/srv/evidence", remote_repository_root="/srv/repo", remote_receiving_root="/srv/receive",
            remote_publication_root="/srv/evidence", remote_expected_identity="/srv/identity.json",
            remote_trusted_root="/srv/root.jsonl", remote_offline_expectation="/srv/expectation.json", remote_attestation_cli="/srv/gh-network-disabled",
        )
        acknowledgment = {
            "status": "published", "publication": "/srv/evidence/release-" + "0" * 64,
            "identity_sha256": delivery._identity_digest(identity),
            "artifact_service_zip_sha256": identity.artifact_service_zip_sha256,
            "artifact_service_zip_bytes": identity.artifact_service_zip_bytes,
            "archive_sha256": identity.archive_sha256, "archive_bytes": identity.archive_bytes,
            "offline_attestation": True, "authorization_reserved": False,
        }
        acknowledgment["publication"] = "/srv/evidence/release-" + "1" * 64
        with self.assertRaisesRegex(delivery.DeliveryError, "requested identity directory"):
            delivery._validate_acknowledgment(acknowledgment, identity, endpoint)
        acknowledgment["publication"] = "/srv/evidence/release-" + delivery._identity_digest(identity)
        acknowledgment["archive_sha256"] = "0" * 64
        with self.assertRaises(delivery.DeliveryError):
            delivery._validate_acknowledgment(acknowledgment, identity, endpoint)

    def test_provenance_binding_rejects_overlapping_identity_mismatch(self) -> None:
        identity = development_identity()
        expectation = {
            "repository": identity.repository, "repository_id": str(identity.repository_id), "repository_owner_id": str(identity.repository_owner_id),
            "source_ref": identity.source_ref, "source_sha": identity.source_sha, "event": identity.event,
            "producer_workflow": identity.producer_workflow, "producer_revision": identity.producer_revision,
            "signer_workflow": identity.signer_workflow, "signer_revision": identity.signer_revision,
            "run_id": identity.run_id, "run_attempt": identity.run_attempt, "artifact_class": identity.artifact_class,
            "platform": identity.platform, "image": identity.image, "image_digest": identity.image_digest,
            "archive_name": identity.archive_name, "archive_sha256": identity.archive_sha256, "archive_bytes": identity.archive_bytes,
        }
        verified = delivery.provenance.AuthenticatedProvenance(
            archive_name=identity.archive_name,
            archive_sha256=identity.archive_sha256,
            archive_bytes=identity.archive_bytes,
            artifact_class=identity.artifact_class,
            repository=identity.repository,
            repository_id=str(identity.repository_id),
            source_ref=identity.source_ref,
            source_sha=identity.source_sha,
            event=identity.event,
            signer_workflow=identity.signer_workflow,
            signer_revision=identity.signer_revision,
            run_id=identity.run_id,
            run_attempt=identity.run_attempt,
            platform=identity.platform,
            image=identity.image,
            image_digest=identity.image_digest,
            pull_request=None,
            receipt=delivery.provenance.VerificationReceipt(
                tool="gh attestation verify",
                version=delivery.provenance.SUPPORTED_GH_VERSION,
                subject_digest=identity.archive_sha256,
                certificate_verified=True,
                certificate_identity="https://github.com/tonykslee/ClashCookies/.github/workflows/runtime-artifact.yml@" + identity.signer_revision,
                run_invocation_uri=f"https://github.com/{identity.repository}/actions/runs/{identity.run_id}/attempts/{identity.run_attempt}",
            ),
        )
        delivery._validate_provenance_binding(identity, expectation, verified)
        expectation["source_sha"] = "0" * 40
        with self.assertRaisesRegex(delivery.DeliveryError, "source_sha"):
            delivery._validate_provenance_binding(identity, expectation, verified)
        expectation["source_sha"] = identity.source_sha
        expectation["archive_bytes"] = identity.archive_bytes + 1
        with self.assertRaisesRegex(delivery.DeliveryError, "archive_bytes"):
            delivery._validate_provenance_binding(identity, expectation, verified)

    @unittest.skipUnless(os.name == "posix", "stalled input regression requires POSIX pipes")
    def test_stalled_receiver_input_hits_deadline_and_lock_releases(self) -> None:
        read_fd, write_fd = os.pipe()
        stream = os.fdopen(read_fd, "rb", closefd=True)
        try:
            with self.assertRaisesRegex(delivery.DeliveryError, "deadline"):
                delivery._read_exact(stream, 1, deadline=delivery.time.monotonic() + 0.05)
        finally:
            os.close(write_fd)
            stream.close()
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            root.mkdir(exist_ok=True)
            root.chmod(0o700)
            with self.assertRaises(delivery.DeliveryError):
                with delivery._receiver_lock(root):
                    raise delivery.DeliveryError("simulated receiver failure")
            with delivery._receiver_lock(root):
                pass

    def test_receiver_lock_preserves_protected_oserror_and_can_be_reacquired(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            root.mkdir(exist_ok=True)
            root.chmod(0o700)
            with self.assertRaises(OSError) as context:
                with delivery._receiver_lock(root):
                    raise OSError("protected operation failure")
            self.assertEqual(str(context.exception), "protected operation failure")
            with delivery._receiver_lock(root):
                pass

    @unittest.skipUnless(os.name == "posix", "lock contention regression requires POSIX file locks")
    def test_receiver_lock_contention_is_bounded_and_retryable(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            root.chmod(0o700)
            ready = root / "holder-ready"
            holder_code = (
                "import fcntl, os, pathlib, sys, time; "
                "fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT, 0o600); "
                "fcntl.flock(fd, fcntl.LOCK_EX); pathlib.Path(sys.argv[2]).write_text('ready'); "
                "time.sleep(0.35); fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)"
            )
            holder = subprocess.Popen([sys.executable, "-c", holder_code, str(root / ".receiver.lock"), str(ready)])
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "lock holder did not establish deterministic contention")
                with self.assertRaisesRegex(delivery.DeliveryError, "lock acquisition deadline exceeded"):
                    with delivery._receiver_lock(root, timeout_seconds=0.05):
                        pass
                holder.wait(timeout=2)
                with delivery._receiver_lock(root, timeout_seconds=1):
                    pass
            finally:
                if holder.poll() is None:
                    holder.kill()
                    holder.wait(timeout=2)

    @unittest.skipUnless(os.name == "posix", "transport worker regressions require POSIX process pipes")
    def test_transport_silent_blocked_and_excessive_peers_are_bounded(self) -> None:
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            checkout = root / "checkout"
            checkout.mkdir(mode=0o700)
            known_hosts = root / "known_hosts"
            identity_file = root / "id_ed25519"
            known_hosts.write_text("host ssh-ed25519 AAAA\n", encoding="utf-8")
            identity_file.write_text("private", encoding="utf-8")
            known_hosts.chmod(0o600)
            identity_file.chmod(0o600)
            fake_ssh = root / "ssh"
            fake_ssh.write_text("#!/bin/sh\ncase \"$FAKE_SSH_MODE\" in\n  silent) sleep 5 ;;\n  excessive) cat >/dev/null; head -c 200000 /dev/zero ;;\n  disconnect) exit 0 ;;\n  hostkey) echo 'Host key verification failed.' >&2; exit 255 ;;\nesac\n", encoding="utf-8")
            fake_ssh.chmod(0o700)
            artifact = root / "artifact.bin"
            artifact.write_bytes(b"x" * (8 * 1024 * 1024))
            header = json.dumps({"files": [{"name": "artifact-service.zip", "bytes": artifact.stat().st_size, "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}]}).encode()
            endpoint = delivery.SshDeliveryEndpoint("127.0.0.1", getpass.getuser(), known_hosts, identity_file, str(root / "publication"), "/tmp/repo", "/tmp/receiving", str(root / "publication"), "/tmp/identity.json", "/tmp/trusted-root", "/tmp/expectation", remote_attestation_cli="/tmp/gh-network-disabled", port=22, execution_timeout_seconds=1)
            old_path = os.environ.get("PATH", "")
            with patch.dict(os.environ, {"PATH": str(root) + os.pathsep + old_path}):
                for mode, expected_error in (("silent", "timed out"), ("excessive", "output exceeds"), ("disconnect", "stream failed"), ("hostkey", "Host key verification failed")):
                    with self.subTest(mode=mode), patch.dict(os.environ, {"FAKE_SSH_MODE": mode}):
                        with self.assertRaisesRegex(delivery.DeliveryError, expected_error):
                            delivery._ssh_stream(endpoint, checkout, header, [("artifact-service.zip", artifact, artifact.stat().st_size)], delivery.DeliveryLimits(max_subprocess_output_bytes=1024))

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux authorization-delivery composition regression")
    def test_synthetic_authorized_delivery_composes_reservation_publication_and_durable_retry(self) -> None:
        self.assertEqual(os.name, "posix", "synthetic durable delivery regression requires Linux/POSIX")
        openssl = shutil.which("openssl")
        self.assertIsNotNone(openssl, "synthetic durable delivery regression requires OpenSSL")
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            root.chmod(0o700)
            checkout = root / "checkout"
            checkout.mkdir(mode=0o700)
            canonical_identity = synthetic_canonical_identity()
            inner_name = canonical_identity.archive_name
            inner = b"synthetic archive bytes"
            service_zip = root / "artifact-service.zip"
            with ZipFile(service_zip, "w") as archive:
                archive.writestr(inner_name, inner)
            service_zip.chmod(0o600)
            service_digest, service_bytes = delivery.provenance._sha256_file(service_zip, delivery.MAX_SERVICE_ZIP_BYTES, "synthetic service ZIP")
            identity = replace(
                canonical_identity,
                artifact_service_zip_sha256=service_digest,
                artifact_service_zip_bytes=service_bytes,
                archive_sha256=hashlib.sha256(inner).hexdigest(),
                archive_bytes=len(inner),
            )
            delivery.provenance.validate_trusted_release_identity(identity)
            context = {
                "contract": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_CONTRACT,
                "version": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_VERSION,
                "authoritative": False,
                "independentlyCompleted": True,
                "identitySha256": delivery.provenance._identity_fingerprint(identity),
                "sourceSha": identity.source_sha,
                "artifactClass": identity.artifact_class,
                "run": {"id": identity.run_id, "attempt": identity.run_attempt, "status": "completed", "conclusion": "success", "createdAt": "2026-11-25T19:45:14Z", "startedAt": "2026-11-25T19:45:15Z", "updatedAt": "2026-11-25T19:48:13Z", "jobCompletionBoundary": "2026-11-25T19:48:12Z"},
                "jobs": [
                    {"id": index, "runId": identity.run_id, "runAttempt": identity.run_attempt, "headSha": identity.source_sha, "name": name, "status": "completed", "conclusion": "success", "startedAt": "2026-11-25T19:45:16Z", "completedAt": "2026-11-25T19:48:12Z", "steps": [{"name": step, "status": "completed", "conclusion": "success"} for step in steps]}
                    for index, (name, steps) in enumerate(delivery.provenance.CANDIDATE_REQUIRED_JOBS.items(), 1)
                ],
            }
            delivery.provenance.validate_candidate_verification_context(context, identity)
            context_path = root / "independent-verification-context.json"
            context_path.write_bytes(delivery.provenance._canonical_json(context) + b"\n")
            context_path.chmod(0o600)
            context_digest = hashlib.sha256(context_path.read_bytes()).hexdigest()
            receiving = root / "receiving"
            publication = root / "publication"
            journal_root = root / "journal"
            now = datetime.now(timezone.utc).replace(microsecond=0)
            authorization_issued_at = now - timedelta(minutes=30)
            authorization_issued = authorization_issued_at.isoformat().replace("+00:00", "Z")
            authorization_expires = (authorization_issued_at + timedelta(hours=24)).isoformat().replace("+00:00", "Z")
            authorization = delivery.provenance.IndependentReleaseAuthorization(
                authorization_id="delivery-test-auth", context=identity.authorization_context, scope="forward-release",
                repository=identity.repository, repository_id=identity.repository_id, repository_owner_id=identity.repository_owner_id,
                source_ref=identity.source_ref, source_sha=identity.source_sha, event=identity.event,
                producer_workflow=identity.producer_workflow, producer_revision=identity.producer_revision,
                signer_workflow=identity.signer_workflow, signer_revision=identity.signer_revision,
                run_id=identity.run_id, run_attempt=identity.run_attempt, artifact_id=identity.artifact_id,
                artifact_name=identity.artifact_name, artifact_class=identity.artifact_class,
                artifact_service_zip_sha256=identity.artifact_service_zip_sha256, artifact_service_zip_bytes=identity.artifact_service_zip_bytes,
                archive_name=identity.archive_name, archive_sha256=identity.archive_sha256, archive_bytes=identity.archive_bytes,
                platform=identity.platform, image=identity.image, image_digest=identity.image_digest,
                issued_at=authorization_issued, expires_at=authorization_expires, retry_key="delivery-test-auth",
                recovery_context=None, signing_key_id="test-key",
                verification=delivery.provenance.AuthorizationVerificationReceipt("test", "f" * 64, authorization_issued, "test-key", key_fingerprint="1" * 64), verification_context_sha256=context_digest, delivery_destination=str(publication),
            )
            material = root / "key-material"
            material.mkdir(mode=0o700)
            private_key = material / "private.pem"
            public_key = material / "public.pem"
            record = material / "record.json"
            signature = material / "record.sig"
            subprocess.run([openssl, "genpkey", "-algorithm", "ED25519", "-out", str(private_key)], check=True, capture_output=True)
            subprocess.run([openssl, "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)], check=True, capture_output=True)
            public_key.chmod(0o600)
            der = material / "public.der"
            subprocess.run([openssl, "pkey", "-pubin", "-in", str(public_key), "-outform", "DER", "-out", str(der)], check=True, capture_output=True)
            trust = delivery.provenance.AuthorizationTrustConfig(public_key, "test-key", hashlib.sha256(der.read_bytes()).hexdigest(), checkout)
            def signed_envelope(record_value: object) -> dict[str, object]:
                record.write_bytes(delivery.provenance.canonical_authorization_record(record_value))
                subprocess.run([openssl, "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(record), "-out", str(signature)], check=True, capture_output=True)
                return delivery.provenance.authorization_record_envelope(record_value, signature.read_bytes())

            envelope = signed_envelope(authorization)
            allowlist = delivery.provenance.AuthorizationRevisionAllowlist(identity.producer_workflow, (identity.producer_revision,), identity.signer_workflow, (identity.signer_revision,))
            for path in (receiving, publication, journal_root):
                path.mkdir(mode=0o700)
            journal = delivery.provenance.AuthorizationReplayJournal(journal_root, repository_root=checkout)
            attestation_bundle = root / "attestation-bundle.json"
            attestation_bundle.write_text(json.dumps({"synthetic": True}), encoding="utf-8")
            attestation_bundle.chmod(0o600)
            trusted_root = root / "trusted-root.jsonl"
            trusted_root.write_text("synthetic trusted root\n", encoding="utf-8")
            trusted_root.chmod(0o600)
            trusted_root_digest, trusted_root_bytes = delivery.provenance._sha256_file(trusted_root, delivery.provenance.MAX_BUNDLE_BYTES, "synthetic trusted root")
            verification_expectation = {"contract": "clashcookies.retained-verification-expectation", "version": 1, "identity_sha256": delivery._identity_digest(identity), "repository": identity.repository, "repository_id": str(identity.repository_id), "repository_owner_id": str(identity.repository_owner_id), "source_ref": identity.source_ref, "source_sha": identity.source_sha, "event": identity.event, "producer_workflow": identity.producer_workflow, "producer_revision": identity.producer_revision, "signer_workflow": identity.signer_workflow, "signer_revision": identity.signer_revision, "run_id": identity.run_id, "run_attempt": identity.run_attempt, "artifact_class": identity.artifact_class, "platform": identity.platform, "image": identity.image, "image_digest": identity.image_digest, "archive_name": identity.archive_name, "archive_sha256": identity.archive_sha256, "archive_bytes": identity.archive_bytes, "trusted_root_sha256": trusted_root_digest, "trusted_root_bytes": trusted_root_bytes, "trusted_root_version": trusted_root_digest[:16], "verifier_version": delivery.provenance.SUPPORTED_GH_VERSION}
            verification_receipt = {"status": "verified-provenance-only", "authenticated": True, "synthetic": True, "source": "isolated-test-harness"}
            (material / "revision-allowlist.json").write_bytes(delivery.provenance._canonical_json({"producer_workflow": identity.producer_workflow, "producer_revisions": [identity.producer_revision], "signer_workflow": identity.signer_workflow, "signer_revisions": [identity.signer_revision]}) + b"\n")
            (material / "revision-allowlist.json").chmod(0o600)
            delivery_kwargs = {"attestation_bundle": attestation_bundle, "candidate_verification_context": context_path, "verification_expectation": verification_expectation, "verification_receipt": verification_receipt, "trusted_root": trusted_root, "trusted_root_expected": (trusted_root_digest, trusted_root_bytes)}
            interruption_child = """
import os
import pickle
import sys

sys.path.insert(0, sys.argv[1])
import trusted_ssh_artifact_delivery as delivery

with open(sys.argv[2], "rb") as stream:
    data = pickle.load(stream)
journal = delivery.provenance.AuthorizationReplayJournal(data["journal"], repository_root=data["repository_root"])
stage = data["stage"]
if stage == "reservation":
    original = journal.reserve
    def crash(*args, **kwargs):
        original(*args, **kwargs)
        os._exit(75)
    journal.reserve = crash
elif stage == "publication":
    original = delivery._publish_payload
    def crash(*args, **kwargs):
        result = original(*args, **kwargs)
        os._exit(75)
    delivery._publish_payload = crash
else:
    original = delivery._register_retained_delivery
    def crash(*args, **kwargs):
        original(*args, **kwargs)
        os._exit(75)
    delivery._register_retained_delivery = crash

delivery.publish_synthetic_authorized_delivery_for_test(
    service_zip=data["service_zip"],
    expected_identity=data["identity"],
    authorization_envelope=data["envelope"],
    trust=data["trust"],
    revision_allowlist=data["allowlist"],
    journal=journal,
    repository_root=data["repository_root"],
    receiving_root=data["receiving_root"],
    publication_root=data["publication_root"],
    now=data["now"],
    **data["delivery_kwargs"],
)
"""
            for stage in ("reservation", "publication", "registration"):
                with self.subTest(interruption_stage=stage):
                    stage_root = root / f"interrupted-{stage}"
                    stage_root.mkdir(mode=0o700)
                    stage_receiving = stage_root / "receiving"
                    stage_publication = stage_root / "publication"
                    stage_journal_root = stage_root / "journal"
                    for stage_path in (stage_receiving, stage_publication, stage_journal_root):
                        stage_path.mkdir(mode=0o700)
                    stage_authorization = replace(
                        authorization,
                        authorization_id=f"delivery-test-{stage}",
                        retry_key=f"delivery-test-{stage}",
                        delivery_destination=str(stage_publication),
                    )
                    stage_envelope = signed_envelope(stage_authorization)
                    stage_input = stage_root / "input.pkl"
                    with stage_input.open("wb") as stream:
                        pickle.dump(
                            {
                                "stage": stage,
                                "service_zip": service_zip,
                                "identity": identity,
                                "envelope": stage_envelope,
                                "trust": trust,
                                "allowlist": allowlist,
                                "journal": stage_journal_root,
                                "repository_root": checkout,
                                "receiving_root": stage_receiving,
                                "publication_root": stage_publication,
                                "now": now,
                                "delivery_kwargs": delivery_kwargs,
                            },
                            stream,
                        )
                    interrupted = subprocess.run(
                        [sys.executable, "-c", interruption_child, str(SCRIPT.parent), str(stage_input)],
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(interrupted.returncode, 75, interrupted.stderr or interrupted.stdout)
                    recovered = delivery.publish_synthetic_authorized_delivery_for_test(
                        service_zip=service_zip,
                        expected_identity=identity,
                        authorization_envelope=stage_envelope,
                        trust=trust,
                        revision_allowlist=allowlist,
                        journal=delivery.provenance.AuthorizationReplayJournal(stage_journal_root, repository_root=checkout),
                        repository_root=checkout,
                        receiving_root=stage_receiving,
                        publication_root=stage_publication,
                        now=now,
                        **delivery_kwargs,
                    )
                    self.assertIn(recovered.status, {"published", "retry-success"})
            with patch.object(delivery, "_publish_payload", side_effect=delivery.DeliveryError("interrupted after reservation")), self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            result = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            self.assertEqual(result.status, "published")
            retry = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            self.assertEqual(retry.status, "retry-success")
            store = delivery.retention.RetentionStore(publication, repository_root=checkout, require_durable=False)
            synthetic_authenticated = SimpleNamespace(diagnostic_json=lambda: verification_receipt)
            with patch.object(delivery.provenance, "run_gh_attestation_verify", return_value={"_trustedRootSha256": trusted_root_digest, "_trustedRootBytes": trusted_root_bytes}), patch.object(delivery.provenance, "validate_verified_result", return_value=synthetic_authenticated):
                offline = store.verify_retained_offline(result.identity_sha256, trusted_root=trusted_root, trusted_root_version=trusted_root_digest[:16], authorization_public_key=public_key, authorization_key_id="test-key", authorization_key_fingerprint=trust.expected_public_key_sha256, authorization_allowlist=material / "revision-allowlist.json", excluded_roots=(receiving,))
            self.assertEqual(offline["authorizationDiagnostic"], {"historicalSignatureValid": True, "historicalLifecycleValidAtIssuedAt": True, "deliveryTimeValidity": "not-evaluated", "replayStatus": "not-evaluated", "replayMutation": "none"})
            destination = Path(result.publication)
            original_zip = (destination / "artifact-service.zip").read_bytes()
            (destination / "artifact-service.zip").write_bytes(b"tampered")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            (destination / "artifact-service.zip").write_bytes(original_zip)
            identity_bytes = (destination / "identity.json").read_bytes()
            (destination / "identity.json").write_bytes(b"{}")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            (destination / "identity.json").write_bytes(identity_bytes)
            authorization_bytes = (destination / "authorization-envelope.json").read_bytes()
            (destination / "authorization-envelope.json").write_bytes(b"tampered")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            (destination / "authorization-envelope.json").write_bytes(authorization_bytes)
            with patch.object(delivery, "_fsync_existing_publication", side_effect=OSError("directory fsync failure")), self.assertRaisesRegex(delivery.retention.RetentionError, "directory fsync failure"):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            durable_retry = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            self.assertEqual(durable_retry.status, "retry-success")
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(lambda _index: delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs), range(2)))
            self.assertEqual({item.status for item in outcomes}, {"retry-success"})
            expired_journal_root = root / "expired-journal"
            expired_journal_root.mkdir(mode=0o700)
            expired_journal = delivery.provenance.AuthorizationReplayJournal(expired_journal_root, repository_root=checkout)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=expired_journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now + timedelta(hours=25), **delivery_kwargs)
            conflicting_authorization = replace(authorization, scope="recovery-release", recovery_context="synthetic-conflict")
            conflicting = signed_envelope(conflicting_authorization)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=conflicting, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, operation="recovery-release", now=now, **delivery_kwargs)
            tampered = {"contract": envelope["contract"], "version": envelope["version"], "record": envelope["record"], "signature": dict(envelope["signature"])}
            tampered["signature"]["value"] = base64.b64encode(b"\0" * 64).decode("ascii")
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=tampered, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)
            store.consume_reserved_authorization(result.identity_sha256, envelope, allowlist, trust, journal, operation="forward-release", now=now)
            record = store.load()["releases"][result.identity_sha256]
            self.assertEqual(record["reconciliation"]["authorization"], "consumed")
            self.assertIn("recovery-protected", record["roles"])
            self.assertNotIn(result.identity_sha256, store.garbage_collect()["candidates"])
            with self.assertRaises(delivery.provenance.ProvenanceError):
                journal.consume(envelope, identity, allowlist, trust, operation="forward-release", now=now)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, **delivery_kwargs)

    def test_endpoint_rejects_destination_and_remote_command_injection(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name) / "checkout"
            root.mkdir()
            external = root.parent
            known_hosts = root / "known_hosts"
            known_hosts = external / "known_hosts"
            identity = external / "id_ed25519"
            known_hosts.write_text("host ssh-ed25519 AAAA\n", encoding="utf-8")
            identity.write_text("private-test-key", encoding="utf-8")
            known_hosts.chmod(0o600)
            identity.chmod(0o600)
            endpoint = delivery.SshDeliveryEndpoint(
                host="receiver",
                user="owner",
                known_hosts=known_hosts,
                identity_file=identity,
                destination="/srv/evidence",
                remote_repository_root="/srv/repo",
                remote_receiving_root="/srv/receive",
                remote_publication_root="/srv/other",
                remote_expected_identity="/srv/identity.json",
                remote_trusted_root="/srv/root.pem",
                remote_offline_expectation="/srv/expectation.json",
                remote_attestation_cli="/srv/gh-network-disabled",
            )
            with self.assertRaises(delivery.DeliveryError):
                delivery._validate_endpoint(endpoint, root)
            valid = replace(endpoint, remote_publication_root="/srv/evidence")
            for field in ("remote_repository_root", "remote_receiving_root", "remote_publication_root", "remote_expected_identity", "remote_trusted_root", "remote_offline_expectation", "remote_attestation_cli"):
                with self.subTest(field=field):
                    unsafe = replace(valid, **{field: "/srv/ok;echo-pwned"})
                    with self.assertRaisesRegex(delivery.DeliveryError, "normalized absolute path"):
                        delivery._validate_endpoint(unsafe, root)

    def test_offline_gh_verification_uses_external_root_and_no_auth_environment(self) -> None:
        with TemporaryDirectory() as root_name:
            base = Path(root_name)
            root = base / "checkout"
            root.mkdir()
            archive = base / "archive"
            bundle = base / "bundle.json"
            trusted_root = base / "trusted-root.pem"
            base.chmod(0o700)
            archive.write_bytes(b"archive")
            bundle.write_text("{}", encoding="utf-8")
            trusted_root.write_text("root", encoding="utf-8")
            archive.chmod(0o600)
            bundle.chmod(0o600)
            trusted_root.chmod(0o600)
            calls = []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                if command[1] == "version":
                    return delivery.provenance.subprocess.CompletedProcess(command, 0, "gh version 2.89.0\n", "")
                return delivery.provenance.subprocess.CompletedProcess(command, 0, "[{}]", "")

            with patch.dict(delivery.provenance.os.environ, {"GH_TOKEN": "must-not-leak", "GH_CONFIG_DIR": str(root / "cached"), "GH_ATTESTATION_CLI": str(base / "pinned-gh")}, clear=False), patch.object(delivery.provenance, "run_bounded", side_effect=fake_run):
                delivery.provenance.run_gh_attestation_verify(
                    archive,
                    bundle=bundle,
                    repository="tonykslee/ClashCookies",
                    signer_workflow=".github/workflows/runtime-artifact.yml",
                    signer_revision="a" * 40,
                    source_ref="refs/heads/dev",
                    source_sha="b" * 40,
                    custom_trusted_root=trusted_root,
                    offline=True,
                    repository_root=root,
                )
            self.assertNotIn("GH_TOKEN", calls[0][1]["environment"])
            verify_command = calls[1][0]
            self.assertIn("--bundle", verify_command)
            self.assertIn("--custom-trusted-root", verify_command)
            self.assertNotIn(str(trusted_root), verify_command)

    def test_offline_verifier_requires_explicit_configuration_and_reports_observed_version(self) -> None:
        with self.assertRaisesRegex(delivery.provenance.ProvenanceError, "executable is missing"):
            delivery.provenance.verify_gh_version(environment={"GH_ATTESTATION_CLI": ""})
        configured = str(Path.cwd() / "pinned-gh")
        observed = delivery.provenance.subprocess.CompletedProcess([], 0, "gh version 2.88.0\n", "")
        with patch.object(delivery.provenance, "run_bounded", return_value=observed):
            with self.assertRaises(delivery.provenance.ProvenanceError) as context:
                delivery.provenance.verify_gh_version(environment={"GH_ATTESTATION_CLI": configured})
        self.assertIn(f"expected 2.89.0, observed 2.88.0, executable {configured}", str(context.exception))

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "real receiver integration is enabled only by mandatory Linux CI")
    def test_real_openssh_receiver_and_exclusive_host_pinning(self) -> None:
        with TemporaryDirectory() as root_name:
            self.assertEqual(os.name, "posix", "mandatory receiver integration requires Linux/POSIX")
            self.assertIsNotNone(shutil.which("ssh"), "mandatory receiver integration requires ssh")
            self.assertIsNotNone(shutil.which("sshd"), "mandatory receiver integration requires sshd")
            self.assertIsNotNone(shutil.which("sudo"), "mandatory receiver integration requires sudo for verifier isolation")
            self.assertIsNotNone(shutil.which("unshare"), "mandatory receiver integration requires unshare for verifier isolation")
            self.assertIsNotNone(shutil.which("runuser"), "mandatory receiver integration requires runuser for verifier isolation")
            root = Path(root_name)
            checkout = Path(os.environ["CC_RECEIVER_REPOSITORY_ROOT"])
            service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            bundle = Path(os.environ["CC_RECEIVER_BUNDLE"])
            identity_path = Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"])
            trusted_root = Path(os.environ["CC_RECEIVER_TRUSTED_ROOT"])
            expectation = Path(os.environ["CC_RECEIVER_OFFLINE_EXPECTATION"])
            receiving = root / "receiving"
            publication = root / "publication"
            receiving.mkdir(mode=0o700)
            publication.mkdir(mode=0o700)
            if os.name == "posix":
                root.chmod(0o700)
                receiving.chmod(0o700)
                publication.chmod(0o700)
            server_key = root / "server_key"
            client_key = root / "client_key"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(server_key)], check=True, capture_output=True)
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client_key)], check=True, capture_output=True)
            authorized = root / "authorized_keys"
            authorized.write_text(client_key.with_suffix(".pub").read_text(encoding="utf-8"), encoding="utf-8")
            authorized.chmod(0o600)
            user = getpass.getuser()
            gh_cli = Path(os.environ["CC_RECEIVER_GH"])
            self.assertTrue(gh_cli.is_file(), "mandatory receiver integration requires the pinned gh executable")
            gh_wrapper = root / "gh-network-disabled"
            gh_wrapper.write_text("#!/bin/sh\nexec sudo -n --preserve-env=GH_CONFIG_DIR,GH_PROMPT_DISABLED unshare --net --mount-proc --fork runuser -u " + shlex.quote(user) + " -- env GH_CONFIG_DIR=\"${GH_CONFIG_DIR:-}\" GH_PROMPT_DISABLED=\"${GH_PROMPT_DISABLED:-true}\" " + shlex.quote(str(gh_cli)) + " \"$@\"\n", encoding="utf-8")
            gh_wrapper.chmod(0o700)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            server_pub = server_key.with_suffix(".pub").read_text(encoding="utf-8").split()
            known_hosts = root / "known_hosts"
            known_hosts.touch(mode=0o600)
            known_hosts.chmod(0o600)
            config = root / "sshd_config"
            receiver_env = sshd_setenv({"PYTHONPATH": SCRIPT.parent, "CC_RECEIVER_REPOSITORY_ROOT": checkout, "CC_RECEIVER_RECEIVING_ROOT": receiving, "CC_RECEIVER_PUBLICATION_ROOT": publication, "CC_RECEIVER_EXPECTED_IDENTITY": identity_path, "CC_RECEIVER_TRUSTED_ROOT": trusted_root, "CC_RECEIVER_OFFLINE_EXPECTATION": expectation, "CC_RECEIVER_ATTESTATION_CLI": gh_wrapper})
            config.write_text("\n".join([
                f"Port {port}", "ListenAddress 127.0.0.1", f"HostKey {server_key}",
                f"AuthorizedKeysFile {authorized}", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
                "PubkeyAuthentication yes", "UsePAM no", "StrictModes no", "LogLevel QUIET",
                "PermitUserEnvironment no", receiver_env,
            ]) + "\n", encoding="utf-8")
            config.chmod(0o600)
            server_command = [shutil.which("sshd"), "-D", "-e", "-f", str(config)]

            def start_server() -> subprocess.Popen:
                return subprocess.Popen(server_command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def stop_server(server: subprocess.Popen) -> None:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=2)

            def endpoint() -> delivery.SshDeliveryEndpoint:
                return delivery.SshDeliveryEndpoint(
                    host="127.0.0.1", user=user, known_hosts=known_hosts, identity_file=client_key,
                    destination=str(publication), remote_repository_root=str(checkout), remote_receiving_root=str(receiving),
                    remote_publication_root=str(publication), remote_expected_identity=str(identity_path),
                    remote_trusted_root=str(trusted_root), remote_offline_expectation=str(expectation), remote_attestation_cli=str(gh_wrapper), port=port,
                    execution_timeout_seconds=delivery.MAX_RECEIVING_SECONDS,
                )

            def deliver() -> delivery.DeliveryResult:
                return delivery.deliver_exact_artifact_over_ssh(endpoint(), service_zip, json_identity, checkout, attestation_bundle=bundle)

            def assert_no_receiver_activity() -> None:
                self.assertFalse((receiving / ".receiver.lock").exists(), "host-key rejection reached the receiver lock")
                self.assertEqual(list(publication.iterdir()), [], "host-key rejection reached publication activity")

            def custody_state(path: Path) -> list[tuple[str, int, int, str]]:
                state = []
                for child in sorted(path.rglob("*")):
                    metadata = os.lstat(child)
                    digest = hashlib.sha256(child.read_bytes()).hexdigest() if stat.S_ISREG(metadata.st_mode) else ""
                    state.append((child.relative_to(path).as_posix(), metadata.st_mode, metadata.st_size, digest))
                return state

            json_identity = delivery.identity_from_json(json.loads(identity_path.read_text(encoding="utf-8")))
            for private_path in (service_zip, bundle, identity_path, trusted_root, expectation):
                self.assertTrue(private_path.is_file(), f"missing integration input: {private_path}")
                self.assertFalse(private_path.is_symlink(), f"integration input is symlinked: {private_path}")
                if os.name == "posix":
                    self.assertEqual(private_path.stat().st_uid, os.geteuid(), f"integration input owner is wrong: {private_path}")
                    self.assertEqual(private_path.stat().st_mode & 0o077, 0, f"integration input is not private: {private_path}")
            known_hosts.write_text("", encoding="utf-8")
            known_hosts.chmod(0o600)
            server = start_server()
            try:
                def wait_for_server() -> None:
                    for _ in range(60):
                        probe = subprocess.run(["ssh", "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", f"IdentityFile={client_key}", "-o", "IdentitiesOnly=yes", "-p", str(port), f"{user}@127.0.0.1", "true"], capture_output=True, text=True)
                        if probe.returncode == 0:
                            return
                        time.sleep(0.1)
                    self.fail("disposable sshd did not become ready")

                wait_for_server()
                with self.assertRaisesRegex(delivery.DeliveryError, "[Hh]ost key"):
                    deliver()
                assert_no_receiver_activity()
                wrong = client_key.with_suffix(".pub").read_text(encoding="utf-8").split()
                known_hosts.write_text(f"[127.0.0.1]:{port} {wrong[0]} {wrong[1]}\n", encoding="utf-8")
                known_hosts.chmod(0o600)
                with self.assertRaisesRegex(delivery.DeliveryError, "[Hh]ost key"):
                    deliver()
                assert_no_receiver_activity()
                known_hosts.write_text(f"[127.0.0.1]:{port} {server_pub[0]} {server_pub[1]}\n", encoding="utf-8")
                known_hosts.chmod(0o600)
                local_version = subprocess.run([str(gh_cli), "version"], check=False, capture_output=True, text=True)
                self.assertEqual(local_version.returncode, 0, local_version.stderr)
                self.assertIn("gh version " + delivery.provenance.SUPPORTED_GH_VERSION, local_version.stdout)
                remote_version = subprocess.run([
                    "ssh", "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no",
                    "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
                    "-o", f"IdentityFile={client_key}", "-o", "IdentitiesOnly=yes", "-o", f"Port={port}",
                    f"{user}@127.0.0.1", shlex.quote(str(gh_wrapper)) + " version",
                ], check=False, capture_output=True, text=True)
                self.assertEqual(remote_version.returncode, 0, remote_version.stderr)
                self.assertIn("gh version " + delivery.provenance.SUPPORTED_GH_VERSION, remote_version.stdout)
                receiver_environment_names = ["PYTHONPATH", *delivery.RECEIVER_CONFIG_ENV.values()]
                environment_probe = "import json,os; print(json.dumps({key: os.environ.get(key) for key in " + repr(receiver_environment_names) + "}, sort_keys=True))"
                remote_environment = subprocess.run([
                    "ssh", "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no",
                    "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
                    "-o", f"IdentityFile={client_key}", "-o", "IdentitiesOnly=yes", "-o", f"Port={port}",
                    f"{user}@127.0.0.1", "python3", "-c", shlex.quote(environment_probe),
                ], check=False, capture_output=True, text=True)
                self.assertEqual(remote_environment.returncode, 0, remote_environment.stderr)
                self.assertEqual(json.loads(remote_environment.stdout), {variable: expected for variable, expected in {
                    "PYTHONPATH": str(SCRIPT.parent),
                    "CC_RECEIVER_REPOSITORY_ROOT": str(checkout), "CC_RECEIVER_RECEIVING_ROOT": str(receiving), "CC_RECEIVER_PUBLICATION_ROOT": str(publication),
                    "CC_RECEIVER_EXPECTED_IDENTITY": str(identity_path), "CC_RECEIVER_TRUSTED_ROOT": str(trusted_root), "CC_RECEIVER_OFFLINE_EXPECTATION": str(expectation), "CC_RECEIVER_ATTESTATION_CLI": str(gh_wrapper),
                }.items()})
                result = deliver()
                self.assertEqual(result.status, "published")
                self.assertEqual(Path(result.publication, "artifact-service.zip").read_bytes(), service_zip.read_bytes())
                self.assertEqual(json.loads(Path(result.publication, "identity.json").read_text(encoding="utf-8")), json.loads(identity_path.read_text(encoding="utf-8")))
                retry = deliver()
                self.assertEqual(retry.status, "retry-success")
                self.assertEqual(retry.publication, result.publication)
                bundle_bytes = bundle.read_bytes()
                bundle.write_bytes(bundle_bytes + b"tampered")
                bundle.chmod(0o600)
                with self.assertRaises(delivery.DeliveryError):
                    deliver()
                bundle.write_bytes(bundle_bytes)
                bundle.chmod(0o600)
                trusted_bytes = trusted_root.read_bytes()
                trusted_root.write_bytes(b"tampered trusted root")
                trusted_root.chmod(0o600)
                with self.assertRaises(delivery.DeliveryError):
                    deliver()
                trusted_root.write_bytes(trusted_bytes)
                trusted_root.chmod(0o600)

                changed_before = (custody_state(receiving), custody_state(publication))
                stop_server(server)
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / "changed_server_key")], check=True, capture_output=True)
                changed_key = root / "changed_server_key"
                config.write_text(config.read_text(encoding="utf-8").replace(str(server_key), str(changed_key)), encoding="utf-8")
                server = start_server()
                wait_for_server()
                with self.assertRaisesRegex(delivery.DeliveryError, "[Hh]ost key"):
                    deliver()
                self.assertEqual((custody_state(receiving), custody_state(publication)), changed_before, "changed-host-key rejection mutated receiver or publication custody")
                capture = Path(os.environ["CC_RECEIVER_PUBLICATION_CAPTURE"])
                self.assertTrue(capture.is_absolute(), "publication capture path must be absolute")
                self.assertFalse(capture.exists(), "publication capture path must be exclusive")
                shutil.copytree(publication, capture)
                self.assertTrue((capture / "retention-state.json").is_file(), "operational publication did not retain durable metadata")
            finally:
                stop_server(server)

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "candidate validator integration is enabled only by mandatory Linux CI")
    def test_owner_local_candidate_archive_validation_uses_real_hardened_validator(self) -> None:
        self.assertEqual(os.name, "posix", "candidate validator integration requires Linux/POSIX")
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            root.chmod(0o700)
            source_service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            source_identity = delivery.identity_from_json(json.loads(Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"]).read_text(encoding="utf-8")))
            fixture = build_candidate_validator_fixture(root, source_service_zip, source_identity)
            identity = fixture["identity"]
            self.assertIsInstance(identity, delivery.provenance.TrustedReleaseIdentity)
            delivery.provenance.validate_trusted_release_identity(identity)
            workspace = root / "owner-validation"
            workspace.mkdir(mode=0o700)
            result = delivery.provenance.validate_candidate_archive_contents(
                fixture["service_zip"],
                identity,
                fixture["context"],
                workspace=workspace,
            )
            self.assertEqual(result["status"], "hardened-validated")
            self.assertTrue(result["extracted"])
            self.assertTrue((workspace / "extracted-runtime" / "dist" / "ClashCookies.js").is_file())
            now = datetime.now(timezone.utc).replace(microsecond=0)
            context, context_digest = delivery.provenance.independent_candidate_verification_context(retained_candidate_context(identity, result, now), identity)
            context_path = root / "owner-candidate-context.json"
            context_path.write_bytes(delivery.provenance._canonical_json(context) + b"\n")
            retained, retained_digest, verification_completed_at = delivery.provenance.load_owner_approval_context(context_path, identity)
            self.assertEqual(retained["archiveValidation"], result)
            self.assertEqual(retained_digest, context_digest)
            record = delivery.provenance.prepare_owner_authorization_record(
                identity,
                authorization_id="owner-local-composed",
                issued_at=verification_completed_at,
                expires_at=(now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
                signing_key_id="isolated-test-owner",
                verification_context_sha256=retained_digest,
                delivery_destination="/srv/candidate",
                verification_completed_at=verification_completed_at,
            )
            self.assertEqual(record["authorization"]["verification_context_sha256"], retained_digest)
            self.assertEqual(record["release"]["archive_name"], identity.archive_name)

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "candidate validator integration is enabled only by mandatory Linux CI")
    def test_receiver_candidate_archive_validation_uses_real_hardened_validator(self) -> None:
        self.assertEqual(os.name, "posix", "candidate validator integration requires Linux/POSIX")
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            root.chmod(0o700)
            source_service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            source_identity = delivery.identity_from_json(json.loads(Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"]).read_text(encoding="utf-8")))
            fixture = build_candidate_validator_fixture(root, source_service_zip, source_identity)
            identity = fixture["identity"]
            workspace = root / "receiver-validation"
            workspace.mkdir(mode=0o700)
            archive, checksum, manifest = delivery.provenance._extract_candidate_service_entries(fixture["service_zip"], identity, workspace)
            staging = root / "receiver-extracted"
            delivery._validate_inner_archive(archive, checksum, manifest, identity, staging, fixture["receiver_context"], snapshot_root=workspace)
            self.assertTrue((staging / "dist" / "ClashCookies.js").is_file())

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "candidate validator integration is enabled only by mandatory Linux CI")
    def test_candidate_manifest_expectation_rejects_repository_owner_and_signer_mismatches(self) -> None:
        self.assertEqual(os.name, "posix", "candidate validator integration requires Linux/POSIX")
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            root.chmod(0o700)
            source_service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            source_identity = delivery.identity_from_json(json.loads(Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"]).read_text(encoding="utf-8")))
            fixture = build_candidate_validator_fixture(root, source_service_zip, source_identity)
            identity = fixture["identity"]
            validator = delivery._load_validator()
            expected = validator.make_manifest_expectation(
                expected_sha=identity.source_sha,
                expected_platform=identity.platform,
                expected_repository=identity.repository,
                expected_repository_id=str(identity.repository_id),
                expected_repository_owner_id=str(identity.repository_owner_id),
                expected_workflow=fixture["context"]["name"],
                expected_run_id=str(identity.run_id),
                expected_run_attempt=str(identity.run_attempt),
                expected_event=identity.event,
                expected_source_ref=identity.source_ref,
                expected_artifact_class=identity.artifact_class,
                expected_signer_workflow=identity.signer_workflow,
                expected_signer_revision=identity.signer_revision,
                expected_base_image=identity.image,
                expected_base_image_digest=identity.image_digest,
            )
            for field, value, message in (
                ("expected_repository_id", "1", "repository ID is not approved"),
                ("expected_repository_owner_id", "2", "owner ID is not approved"),
                ("expected_signer_revision", "4" * 40, "signer revision does not match"),
            ):
                with self.subTest(field=field), self.assertRaisesRegex(validator.ArtifactError, message):
                    validator.validate_manifest(
                        fixture["external_manifest"],
                        identity.archive_name,
                        fixture["archive_bytes"],
                        fixture["archive_digest"],
                        replace(expected, **{field: value}),
                        embedded=False,
                    )

    @unittest.skipUnless(os.environ.get("CC_REAL_RECEIVER") == "1", "candidate OpenSSH integration is enabled only by mandatory Linux CI")
    def test_real_openssh_candidate_receiver_uses_hardened_validator_and_authorization_custody(self) -> None:
        """Exercise the candidate frame over OpenSSH with only the verifier seam synthetic."""
        self.assertEqual(os.name, "posix", "candidate receiver integration requires Linux/POSIX")
        for executable in ("ssh", "sshd", "ssh-keygen", "openssl"):
            self.assertIsNotNone(shutil.which(executable), f"candidate receiver integration requires {executable}")
        with TemporaryDirectory() as directory_name:
            root = Path(directory_name)
            root.chmod(0o700)
            checkout = Path(os.environ["CC_RECEIVER_REPOSITORY_ROOT"])
            source_service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            source_identity = delivery.identity_from_json(json.loads(Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"]).read_text(encoding="utf-8")))
            with ZipFile(source_service_zip) as source_service:
                source_archive_bytes = source_service.read(source_identity.archive_name)
                source_manifest = json.loads(source_service.read(f"{source_identity.archive_name}.manifest.json"))

            source_sha = "1" * 40
            run_id = 2987654321
            run_attempt = 1
            signer_revision = "3" * 40
            producer_revision = "2" * 40
            archive_name = f"clashcookies-runtime-{source_sha}.tar.gz"
            candidate_manifest = json.loads(json.dumps(source_manifest))
            candidate_manifest["artifact"].update({"name": archive_name, "artifactClass": delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "profile": delivery.provenance.PRODUCTION_CANDIDATE_PROFILE, "nonProductionEvidence": True})
            candidate_manifest["source"]["gitSha"] = source_sha
            candidate_manifest["identity"].update({"event": "push", "kind": "production_candidate_main_push", "authorizationContext": delivery.provenance.CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT, "deployableRelease": False})
            candidate_manifest["workflow"].update({"name": CANDIDATE_WORKFLOW_DISPLAY_NAME, "runId": str(run_id), "runAttempt": str(run_attempt), "ref": delivery.provenance.RELEASE_SOURCE_REF, "repository": delivery.provenance.RELEASE_REPOSITORY, "repositoryId": str(delivery.provenance.RELEASE_REPOSITORY_ID), "repositoryOwnerId": str(delivery.provenance.RELEASE_REPOSITORY_OWNER_ID), "sourceRef": delivery.provenance.RELEASE_SOURCE_REF, "workflowPath": delivery.provenance.RELEASE_SIGNER_WORKFLOW, "signerWorkflow": delivery.provenance.RELEASE_SIGNER_WORKFLOW, "signerRevision": signer_revision})
            candidate_manifest["integrity"]["checksumFile"] = f"{archive_name}.sha256"
            candidate_manifest["build"].update({"platform": delivery.provenance.RELEASE_PLATFORM, "architecture": "amd64", "baseImage": delivery.provenance.RELEASE_IMAGE, "baseImageDigest": delivery.provenance.RELEASE_IMAGE.split("@", 1)[1]})
            with tarfile.open(fileobj=BytesIO(source_archive_bytes), mode="r:gz") as source_tar:
                tar_members: list[tuple[tarfile.TarInfo, bytes | None]] = []
                for member in source_tar.getmembers():
                    payload = source_tar.extractfile(member).read() if member.isfile() else None
                    if member.name == "runtime-artifact-manifest.json":
                        payload = json.dumps(candidate_manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
                        member.size = len(payload)
                    member.pax_headers = {}
                    tar_members.append((member, payload))
            archive_buffer = BytesIO()
            with tarfile.open(fileobj=archive_buffer, mode="w:gz", format=tarfile.GNU_FORMAT) as candidate_tar:
                for member, payload in tar_members:
                    candidate_tar.addfile(member, BytesIO(payload) if payload is not None else None)
            candidate_archive_bytes = archive_buffer.getvalue()
            archive_digest = hashlib.sha256(candidate_archive_bytes).hexdigest()
            footprint = sum(member.size for member, _payload in tar_members if member.isfile() and (member.name in {"package.json", "yarn.lock", "runtime-artifact-manifest.json"} or member.name.startswith(("dist/", "node_modules/", "prisma/"))))
            external_manifest = json.loads(json.dumps(candidate_manifest))
            external_manifest["artifact"].update({"archiveSha256": archive_digest, "archiveBytes": len(candidate_archive_bytes)})
            external_manifest["integrity"]["sha256"] = archive_digest
            external_manifest["measurements"].update({"archiveBytes": len(candidate_archive_bytes), "extractedFootprintBytes": footprint})

            candidate_identity = delivery.provenance.TrustedReleaseIdentity(
                repository=delivery.provenance.RELEASE_REPOSITORY, repository_id=delivery.provenance.RELEASE_REPOSITORY_ID, repository_owner_id=delivery.provenance.RELEASE_REPOSITORY_OWNER_ID,
                source_ref=delivery.provenance.RELEASE_SOURCE_REF, source_sha=source_sha, event="push", producer_workflow=delivery.provenance.RELEASE_PRODUCER_WORKFLOW, producer_revision=producer_revision,
                signer_workflow=delivery.provenance.RELEASE_SIGNER_WORKFLOW, signer_revision=signer_revision, run_id=run_id, run_attempt=run_attempt, artifact_id=987654,
                artifact_name=f"runtime-artifact-{run_id}-{run_attempt}", artifact_class=delivery.provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS,
                artifact_service_zip_sha256="0" * 64, artifact_service_zip_bytes=1, archive_name=archive_name, archive_sha256=archive_digest, archive_bytes=len(candidate_archive_bytes),
                platform=delivery.provenance.RELEASE_PLATFORM, image=delivery.provenance.RELEASE_IMAGE, image_digest=delivery.provenance.RELEASE_IMAGE.split("@", 1)[1], authorization_context=delivery.provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT,
            )
            archive_path = root / archive_name
            archive_path.write_bytes(candidate_archive_bytes)
            service_zip = root / "candidate-artifact-service.zip"
            with ZipFile(service_zip, "w") as candidate_service:
                candidate_service.writestr(archive_name, candidate_archive_bytes)
                candidate_service.writestr(f"{archive_name}.sha256", f"{archive_digest}  {archive_name}\n")
                candidate_service.writestr(f"{archive_name}.manifest.json", json.dumps(external_manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
            service_digest = hashlib.sha256(service_zip.read_bytes()).hexdigest()
            candidate_identity = replace(candidate_identity, artifact_service_zip_sha256=service_digest, artifact_service_zip_bytes=service_zip.stat().st_size)
            delivery.provenance.validate_trusted_release_identity(candidate_identity)

            now = datetime.now(timezone.utc).replace(microsecond=0)
            completion_boundary = (now - timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
            verification_completed = (now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
            context = {
                "contract": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_CONTRACT, "version": delivery.provenance.CANDIDATE_VERIFICATION_CONTEXT_VERSION, "authoritative": False, "independentlyCompleted": True,
                "identitySha256": delivery.provenance._identity_fingerprint(candidate_identity), "sourceSha": source_sha, "artifactClass": candidate_identity.artifact_class,
                "run": {"id": run_id, "attempt": run_attempt, "status": "completed", "conclusion": "success", "createdAt": (now - timedelta(minutes=7)).isoformat().replace("+00:00", "Z"), "startedAt": (now - timedelta(minutes=6)).isoformat().replace("+00:00", "Z"), "updatedAt": verification_completed, "jobCompletionBoundary": completion_boundary},
                "jobs": [{"id": index, "runId": run_id, "runAttempt": run_attempt, "headSha": source_sha, "name": name, "status": "completed", "conclusion": "success", "startedAt": (now - timedelta(minutes=6)).isoformat().replace("+00:00", "Z"), "completedAt": completion_boundary, "steps": [{"name": step, "status": "completed", "conclusion": "success"} for step in steps]} for index, (name, steps) in enumerate(delivery.provenance.CANDIDATE_REQUIRED_JOBS.items(), 1)],
                "attestation": {"status": "official-verifier-authenticated", "authenticated": True, "verifier": "synthetic-harness", "verifierVersion": delivery.provenance.SUPPORTED_GH_VERSION, "subjectDigest": archive_digest},
                "archiveValidation": {"status": "hardened-validated", "archiveName": candidate_identity.archive_name, "archiveSha256": archive_digest, "archiveBytes": len(candidate_archive_bytes), "extracted": True},
                "workflowIdentity": {"producerWorkflow": candidate_identity.producer_workflow, "producerRevision": producer_revision, "signerWorkflow": candidate_identity.signer_workflow, "signerRevision": signer_revision, "policy": "immutable-owner-allowlist"},
                "verificationCompletedAt": verification_completed,
            }
            context_path = root / "independent-verification-context.json"
            context_path.write_bytes(delivery.provenance._canonical_json(context) + b"\n")

            expectation = {"repository": candidate_identity.repository, "repository_id": str(candidate_identity.repository_id), "repository_owner_id": str(candidate_identity.repository_owner_id), "repository_visibility": "public", "producer_workflow": candidate_identity.producer_workflow, "producer_revision": candidate_identity.producer_revision, "signer_workflow": candidate_identity.signer_workflow, "signer_revision": candidate_identity.signer_revision, "source_ref": candidate_identity.source_ref, "source_sha": candidate_identity.source_sha, "event": candidate_identity.event, "workflow_name": CANDIDATE_WORKFLOW_DISPLAY_NAME, "run_id": candidate_identity.run_id, "run_attempt": candidate_identity.run_attempt, "artifact_class": candidate_identity.artifact_class, "platform": candidate_identity.platform, "image": candidate_identity.image, "image_digest": candidate_identity.image_digest, "archive_name": candidate_identity.archive_name, "archive_sha256": candidate_identity.archive_sha256, "archive_bytes": candidate_identity.archive_bytes, "verifier_version": delivery.provenance.SUPPORTED_GH_VERSION}
            verifier_output = root / "synthetic-verifier-output.json"
            repository_uri = f"https://github.com/{candidate_identity.repository}"
            workflow_uri = f"{repository_uri}/{candidate_identity.signer_workflow}"
            run_uri = f"{repository_uri}/actions/runs/{run_id}/attempts/{run_attempt}"
            verifier_document = [{"verificationResult": {
                "mediaType": "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
                "statement": {
                    "_type": "https://in-toto.io/Statement/v1",
                    "predicateType": delivery.provenance.SLSA_PROVENANCE_V1,
                    "subject": [{"name": archive_name, "digest": {"sha256": archive_digest}}],
                    "predicate": {
                        "buildDefinition": {
                            "buildType": delivery.provenance.ACTIONS_WORKFLOW_BUILD_TYPE,
                            "externalParameters": {"workflow": {"path": candidate_identity.signer_workflow, "ref": candidate_identity.source_ref, "repository": repository_uri}},
                            "internalParameters": {"github": {"event_name": "push", "repository_id": candidate_identity.repository_id, "repository_owner_id": candidate_identity.repository_owner_id, "runner_environment": delivery.provenance.GITHUB_HOSTED_RUNNER}},
                            "resolvedDependencies": [{"uri": f"git+{repository_uri}@{candidate_identity.source_ref}", "digest": {"gitCommit": source_sha}}],
                        },
                        "runDetails": {"builder": {"id": f"{workflow_uri}@{candidate_identity.source_ref}"}, "metadata": {"invocationId": run_uri}},
                    },
                },
                "signature": {"certificate": {
                    "certificateIssuer": "CN=sigstore-intermediate,O=sigstore.dev", "sourceRepositoryURI": repository_uri,
                    "sourceRepositoryIdentifier": str(candidate_identity.repository_id), "sourceRepositoryOwnerIdentifier": str(candidate_identity.repository_owner_id),
                    "sourceRepositoryOwnerURI": "https://github.com/tonykslee", "sourceRepositoryRef": candidate_identity.source_ref, "sourceRepositoryDigest": source_sha,
                    "githubWorkflowTrigger": "push", "githubWorkflowSHA": signer_revision, "githubWorkflowName": CANDIDATE_WORKFLOW_DISPLAY_NAME,
                    "githubWorkflowRepository": candidate_identity.repository, "githubWorkflowRef": candidate_identity.source_ref, "buildTrigger": "push",
                    "buildSignerURI": f"{workflow_uri}@{candidate_identity.source_ref}", "buildSignerDigest": signer_revision,
                    "buildConfigURI": f"{workflow_uri}@{candidate_identity.source_ref}", "buildConfigDigest": signer_revision,
                    "runInvocationURI": run_uri, "runnerEnvironment": delivery.provenance.GITHUB_HOSTED_RUNNER, "issuer": delivery.provenance.GITHUB_OIDC_ISSUER,
                    "sourceRepositoryVisibilityAtSigning": "public", "subjectAlternativeName": f"{workflow_uri}@{candidate_identity.source_ref}",
                }},
                "verifiedTimestamps": [verification_completed],
            }}]
            verifier_output.write_text(json.dumps(verifier_document), encoding="utf-8")
            parsed_provenance = delivery.provenance.validate_verified_result(
                verifier_document[0],
                archive_name=candidate_identity.archive_name,
                archive_digest=candidate_identity.archive_sha256,
                archive_bytes=candidate_identity.archive_bytes,
                expected=expectation,
                run_metadata=candidate_run_metadata(candidate_identity),
            )
            self.assertEqual(parsed_provenance.signer_workflow, candidate_identity.signer_workflow)
            self.assertEqual(parsed_provenance.run_id, candidate_identity.run_id)

            material = root / "authorization-custody"
            material.mkdir(mode=0o700)
            private_key = material / "owner-private.pem"
            public_key = material / "owner-public.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private_key)], check=True, capture_output=True)
            subprocess.run(["openssl", "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)], check=True, capture_output=True)
            public_key.chmod(0o600)
            der = material / "owner-public.der"
            subprocess.run(["openssl", "pkey", "-pubin", "-in", str(public_key), "-outform", "DER", "-out", str(der)], check=True, capture_output=True)
            key_fingerprint = hashlib.sha256(der.read_bytes()).hexdigest()
            allowlist = material / "revision-allowlist.json"
            allowlist.write_bytes(delivery.provenance._canonical_json({"producer_workflow": candidate_identity.producer_workflow, "producer_revisions": [producer_revision], "signer_workflow": candidate_identity.signer_workflow, "signer_revisions": [signer_revision]}) + b"\n")
            authorization_record = delivery.provenance.prepare_owner_authorization_record(candidate_identity, authorization_id="candidate-ssh-test", issued_at=now.isoformat().replace("+00:00", "Z"), expires_at=(now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"), signing_key_id="candidate-test-key", verification_context_sha256=hashlib.sha256(context_path.read_bytes()).hexdigest(), delivery_destination=str(root / "publication"), verification_completed_at=verification_completed)
            record_path = material / "authorization-record.json"
            signature_path = material / "authorization-record.sig"
            record_path.write_bytes(delivery.provenance._canonical_json(authorization_record))
            subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(record_path), "-out", str(signature_path)], check=True, capture_output=True)
            envelope = delivery.provenance.assemble_owner_authorization_envelope(authorization_record, signature_path.read_bytes(), "candidate-test-key")
            envelope_path = root / "authorization-envelope.json"
            envelope_path.write_bytes(delivery.provenance._canonical_json(envelope) + b"\n")
            journal = root / "authorization-journal"
            journal.mkdir(mode=0o700)
            candidate_trust = delivery.provenance.AuthorizationTrustConfig(public_key, "candidate-test-key", key_fingerprint, checkout)
            candidate_allowlist = delivery.provenance.AuthorizationRevisionAllowlist(candidate_identity.producer_workflow, (producer_revision,), candidate_identity.signer_workflow, (signer_revision,))
            policy_path = root / "receiver-authorization-policy.json"
            policy_path.write_bytes(delivery.provenance._canonical_json({"contract": "clashcookies.receiver-authorization-policy", "version": 1, "repository": candidate_identity.repository, "destination": str(root / "publication"), "artifact_class": candidate_identity.artifact_class, "authorization_context": delivery.provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT, "public_key_path": str(public_key), "key_id": "candidate-test-key", "key_fingerprint": key_fingerprint, "allowlist_path": str(allowlist), "journal_path": str(journal)}))

            identity_path = root / "candidate-identity.json"
            identity_path.write_bytes(delivery.provenance._canonical_json(delivery._identity_payload(candidate_identity)) + b"\n")
            trusted_root = root / "trusted-root.jsonl"
            trusted_root.write_text("synthetic candidate trust root\n", encoding="utf-8")
            bundle = root / "attestation-bundle.json"
            bundle.write_text("{\"synthetic\":true}\n", encoding="utf-8")
            gh_wrapper = root / "synthetic-gh"
            gh_wrapper.write_text("#!/bin/sh\nif [ \"$1\" = version ]; then echo 'gh version 2.89.0'; else cat \"$CC_SYNTHETIC_VERIFIER_OUTPUT\"; fi\n", encoding="utf-8")
            gh_wrapper.chmod(0o700)
            receiving = root / "receiving"
            publication = root / "publication"
            receiving.mkdir(mode=0o700)
            publication.mkdir(mode=0o700)
            server_key = root / "server_key"
            client_key = root / "client_key"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(server_key)], check=True, capture_output=True)
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client_key)], check=True, capture_output=True)
            authorized = root / "authorized_keys"
            authorized.write_text(client_key.with_suffix(".pub").read_text(encoding="utf-8"), encoding="utf-8")
            authorized.chmod(0o600)
            server_pub = server_key.with_suffix(".pub").read_text(encoding="utf-8").split()
            known_hosts = root / "known_hosts"
            known_hosts.touch(mode=0o600)
            port = socket.socket()
            port.bind(("127.0.0.1", 0))
            port_number = port.getsockname()[1]
            port.close()
            user = getpass.getuser()
            config = root / "sshd_config"
            set_env = sshd_setenv({"PYTHONPATH": SCRIPT.parent, "CC_RECEIVER_REPOSITORY_ROOT": checkout, "CC_RECEIVER_RECEIVING_ROOT": receiving, "CC_RECEIVER_PUBLICATION_ROOT": publication, "CC_RECEIVER_EXPECTED_IDENTITY": identity_path, "CC_RECEIVER_TRUSTED_ROOT": trusted_root, "CC_RECEIVER_OFFLINE_EXPECTATION": root / "expectation.json", "CC_RECEIVER_ATTESTATION_CLI": gh_wrapper, "CC_RECEIVER_AUTHORIZATION_POLICY": policy_path, "CC_SYNTHETIC_VERIFIER_OUTPUT": verifier_output})
            (root / "expectation.json").write_bytes(json.dumps(expectation, sort_keys=True, separators=(",", ":")).encode())
            for private_input in (service_zip, context_path, envelope_path, identity_path, trusted_root, bundle, verifier_output, policy_path, allowlist, root / "expectation.json"):
                private_input.chmod(0o600)
            config.write_text("\n".join([f"Port {port_number}", "ListenAddress 127.0.0.1", f"HostKey {server_key}", f"AuthorizedKeysFile {authorized}", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "UsePAM no", "StrictModes no", "LogLevel QUIET", "PermitUserEnvironment no", set_env]) + "\n", encoding="utf-8")
            config.chmod(0o600)
            server = subprocess.Popen([shutil.which("sshd"), "-D", "-e", "-f", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                def wait_for_candidate_server() -> None:
                    for _ in range(60):
                        probe = subprocess.run(["ssh", "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", f"IdentityFile={client_key}", "-o", "IdentitiesOnly=yes", "-p", str(port_number), f"{user}@127.0.0.1", "true"], capture_output=True)
                        if probe.returncode == 0:
                            return
                        time.sleep(0.1)
                    self.fail("candidate disposable sshd did not become ready")

                def assert_receiver_environment(expected_paths: dict[str, Path]) -> None:
                    environment_names = ["PYTHONPATH", *delivery.RECEIVER_CONFIG_ENV.values(), delivery.RECEIVER_AUTHORIZATION_POLICY_ENV, "CC_SYNTHETIC_VERIFIER_OUTPUT"]
                    environment_probe = "import json,os; print(json.dumps({key: os.environ.get(key) for key in " + repr(environment_names) + "}, sort_keys=True))"
                    remote_environment = subprocess.run([
                        "ssh", "-F", "none", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no",
                        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}",
                        "-o", f"IdentityFile={client_key}", "-o", "IdentitiesOnly=yes", "-o", f"Port={port_number}",
                        f"{user}@127.0.0.1", "python3", "-c", shlex.quote(environment_probe),
                    ], check=False, capture_output=True, text=True)
                    self.assertEqual(remote_environment.returncode, 0, remote_environment.stderr)
                    expected_environment = {
                        "PYTHONPATH": str(SCRIPT.parent),
                        "CC_RECEIVER_REPOSITORY_ROOT": str(checkout),
                        "CC_RECEIVER_RECEIVING_ROOT": str(expected_paths["receiving"]),
                        "CC_RECEIVER_PUBLICATION_ROOT": str(expected_paths["publication"]),
                        "CC_RECEIVER_EXPECTED_IDENTITY": str(identity_path),
                        "CC_RECEIVER_TRUSTED_ROOT": str(trusted_root),
                        "CC_RECEIVER_OFFLINE_EXPECTATION": str(root / "expectation.json"),
                        "CC_RECEIVER_ATTESTATION_CLI": str(gh_wrapper),
                        "CC_RECEIVER_AUTHORIZATION_POLICY": str(expected_paths["policy"]),
                        "CC_SYNTHETIC_VERIFIER_OUTPUT": str(verifier_output),
                    }
                    self.assertEqual(json.loads(remote_environment.stdout), expected_environment)

                wait_for_candidate_server()
                known_hosts.write_text(f"[127.0.0.1]:{port_number} {server_pub[0]} {server_pub[1]}\n", encoding="utf-8")
                known_hosts.chmod(0o600)
                assert_receiver_environment({"receiving": receiving, "publication": publication, "policy": policy_path})
                endpoint = delivery.SshDeliveryEndpoint(host="127.0.0.1", user=user, known_hosts=known_hosts, identity_file=client_key, destination=str(publication), remote_repository_root=str(checkout), remote_receiving_root=str(receiving), remote_publication_root=str(publication), remote_expected_identity=str(identity_path), remote_trusted_root=str(trusted_root), remote_offline_expectation=str(root / "expectation.json"), remote_attestation_cli=str(gh_wrapper), remote_authorization_policy=str(policy_path), port=port_number, execution_timeout_seconds=delivery.MAX_RECEIVING_SECONDS)
                deliver = lambda: delivery.deliver_exact_artifact_over_ssh(endpoint, service_zip, candidate_identity, checkout, attestation_bundle=bundle, authorization_envelope=envelope_path, candidate_verification_context=context_path)
                normal = deliver()
                self.assertEqual(normal.status, "published")
                publication_path = publication / f"release-{delivery._identity_digest(candidate_identity)}"
                self.assertTrue(publication_path.is_dir(), "normal candidate delivery did not publish")
                store = delivery.retention.RetentionStore(publication, repository_root=checkout, require_durable=False)
                retained_state = store.load()
                retained_record = retained_state["releases"][normal.identity_sha256]
                self.assertEqual(retained_record["identity"], delivery._identity_payload(candidate_identity))
                self.assertEqual(set(retained_record["evidence"]), {"artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl"})
                self.assertEqual(retained_record["roles"], ["pending", "reserved"])
                delivery.provenance.AuthorizationReplayJournal(journal, repository_root=checkout).assert_reserved(envelope, candidate_identity, candidate_allowlist, candidate_trust, operation="forward-release")

                # Full preparation integration: reuse this real retained
                # candidate, signed reservation, hardened validator, and only
                # the explicitly isolated verifier seam above.
                self.assertIsNotNone(shutil.which("docker"), "preparation integration requires Docker")
                candidate_database_url = os.environ.get("CC_PREPARED_CANDIDATE_DATABASE_URL")
                candidate_docker_network = os.environ.get("CC_PREPARED_CANDIDATE_DOCKER_NETWORK")
                self.assertTrue(candidate_database_url, "mandatory prepared-candidate PostgreSQL URL is not configured")
                self.assertTrue(candidate_docker_network, "mandatory prepared-candidate Docker network is not configured")
                image = candidate_identity.image
                subprocess.run(["docker", "image", "inspect", image], check=True, capture_output=True)
                legacy_app = root / "legacy-parent-checkout"
                legacy_app.mkdir(mode=0o700)
                legacy_extract = root / "legacy-candidate-extract"
                legacy_extract.mkdir(mode=0o700)
                delivery.provenance.validate_candidate_archive_contents(service_zip, candidate_identity, candidate_run_metadata(candidate_identity), workspace=legacy_extract)
                extracted_runtime = legacy_extract / "extracted-runtime"
                shutil.copytree(extracted_runtime / "prisma", legacy_app / "prisma")
                shutil.copy2(extracted_runtime / "package.json", legacy_app / "package.json")
                shutil.copy2(extracted_runtime / "yarn.lock", legacy_app / "yarn.lock")
                startup_destination = legacy_app / "ops" / "deploy" / "container-start.sh"
                startup_destination.parent.mkdir(parents=True)
                shutil.copy2(checkout / "ops" / "deploy" / "container-start.sh", startup_destination)
                package = json.loads((legacy_app / "package.json").read_text(encoding="utf-8"))
                package.setdefault("scripts", {})["start:runtime"] = "node -e \"require('http').createServer((_req,res)=>res.end('legacy-runtime')).listen(0,'127.0.0.1')\""
                (legacy_app / "package.json").write_bytes(delivery.provenance._canonical_json(package) + b"\n")
                subprocess.run(["git", "-C", str(legacy_app), "init", "--quiet"], check=True, capture_output=True)
                subprocess.run(["git", "-C", str(legacy_app), "config", "user.email", "fixture@example.invalid"], check=True)
                subprocess.run(["git", "-C", str(legacy_app), "config", "user.name", "fixture"], check=True)
                subprocess.run(["git", "-C", str(legacy_app), "add", "."], check=True)
                subprocess.run(["git", "-C", str(legacy_app), "commit", "--quiet", "-m", "fixture"], check=True, capture_output=True)
                legacy_revision = subprocess.run(["git", "-C", str(legacy_app), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
                dist_overlay = root / "legacy-dist-overlay"
                node_overlay = root / "legacy-node-overlay"
                shutil.copytree(extracted_runtime / "dist", dist_overlay, symlinks=True)
                shutil.copytree(extracted_runtime / "node_modules", node_overlay, symlinks=True)
                dist_volume = f"clashcookies-preparation-legacy-dist-{os.getpid()}"
                node_volume = f"clashcookies-preparation-legacy-node-{os.getpid()}"
                for volume_name, device in ((dist_volume, dist_overlay), (node_volume, node_overlay)):
                    subprocess.run(["docker", "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", f"device={device}", "--opt", "o=bind", volume_name], check=True, capture_output=True, text=True)
                container_name = f"clashcookies-preparation-legacy-{os.getpid()}"
                marker = f"revision={legacy_revision}\ndist_digest={preparation._wrapper_tree_digest(dist_overlay)}\nnode_modules_digest={preparation._wrapper_tree_digest(node_overlay)}\n"
                (dist_overlay / ".clashcookies-artifact").write_text(marker, encoding="ascii")
                (node_overlay / ".clashcookies-artifact").write_text(marker, encoding="ascii")
                container_id = subprocess.run(["docker", "run", "--detach", "--name", container_name, "--platform", "linux/amd64", "--network", "none", "--env", f"BUILD_SHA={legacy_revision}", "--env", "CLASHCOOKIES_PREBUILT=1", "--workdir", "/app", "--volume", f"{legacy_app}:/app", "--volume", f"{dist_volume}:/app/dist", "--volume", f"{node_volume}:/app/node_modules", image, "bash", "./ops/deploy/container-start.sh"], check=True, capture_output=True, text=True).stdout.strip()
                source_path = root / "legacy-source.json"
                legacy_source = {"contract": preparation.LEGACY_SOURCE_CONTRACT, "version": preparation.LEGACY_SOURCE_VERSION, "container_id": container_id, "checkout_path": str(legacy_app), "checkout_revision": legacy_revision, "image": image, "image_digest": candidate_identity.image_digest, "platform": candidate_identity.platform, "startup": {"entrypoint": "ops/deploy/container-start.sh", "prebuilt": True, "migrations": "deferred"}, "components": {"dist": str(dist_overlay), "node_modules": str(node_overlay), "prisma": str(legacy_app / "prisma"), "package.json": str(legacy_app / "package.json"), "yarn.lock": str(legacy_app / "yarn.lock"), "ops/deploy/container-start.sh": str(startup_destination)}, "mount_destinations": {"dist": {"type": "volume", "name": dist_volume, "source": str(dist_overlay), "destination": "/app/dist"}, "node_modules": {"type": "volume", "name": node_volume, "source": str(node_overlay), "destination": "/app/node_modules"}, "prisma": {"type": "bind", "source": str(legacy_app / "prisma"), "destination": "/app"}, "package.json": {"type": "bind", "source": str(legacy_app / "package.json"), "destination": "/app"}, "yarn.lock": {"type": "bind", "source": str(legacy_app / "yarn.lock"), "destination": "/app"}, "ops/deploy/container-start.sh": {"type": "bind", "source": str(startup_destination), "destination": "/app"}}}
                source_path.write_bytes(delivery.provenance._canonical_json(legacy_source) + b"\n")
                source_path.chmod(0o600)
                prepared_root = root / "prepared-runtime"
                prepared_root.mkdir(mode=0o700)
                deployment_lock = root / "fb027-deploy.lock.flock"
                prepare_kwargs = {
                    "publication_root": publication,
                    "prepared_root": prepared_root,
                    "repository_root": checkout,
                    "identity_sha256": normal.identity_sha256,
                    "identity_file": identity_path,
                    "authorization_policy": policy_path,
                    "trusted_root": trusted_root,
                    "trusted_root_version": hashlib.sha256(trusted_root.read_bytes()).hexdigest()[:16],
                    "legacy_source": source_path,
                    "deployment_lock_file": deployment_lock,
                    "database_headroom_bytes": 1024 * 1024,
                    "host_headroom_bytes": 1024 * 1024,
                    "require_durable": True,
                }
                protected_ref = preparation._legacy_custody_ref(candidate_identity.image_digest)
                protected_name = f"clashcookies-legacy-custody-{candidate_identity.image_digest.split(':', 1)[1][:32]}"

                def assert_no_legacy_custody_mutation() -> None:
                    tag_state = subprocess.run(["docker", "image", "inspect", protected_ref], check=False, capture_output=True, text=True)
                    anchor_state = subprocess.run(["docker", "container", "inspect", protected_name], check=False, capture_output=True, text=True)
                    self.assertNotEqual(tag_state.returncode, 0, "pre-admission path created a protected legacy image tag")
                    self.assertNotEqual(anchor_state.returncode, 0, "pre-admission path created a legacy custody anchor")

                invalid_policy = root / "invalid-receiver-policy.json"
                with patch.dict(os.environ, {"CC_RECEIVER_AUTHORIZATION_POLICY": str(invalid_policy)}, clear=False):
                    with self.assertRaises(preparation.PreparationError):
                        preparation.prepare_immutable_runtime(**{**prepare_kwargs, "authorization_policy": invalid_policy})
                assert_no_legacy_custody_mutation()

                lock_holder = subprocess.Popen([
                    sys.executable,
                    "-c",
                    "import fcntl,os,sys,time; handle=open(sys.argv[1],'a+'); os.chmod(sys.argv[1],0o600); fcntl.flock(handle,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(8)",
                    str(deployment_lock),
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(lock_holder.stdout.readline().strip(), "ready")
                    with patch.dict(os.environ, {"CC_RECEIVER_AUTHORIZATION_POLICY": str(policy_path), "DEPLOY_LOCK_FILE": str(deployment_lock), "GH_ATTESTATION_CLI": str(gh_wrapper), "CC_SYNTHETIC_VERIFIER_OUTPUT": str(verifier_output)}, clear=False):
                        with self.assertRaisesRegex(preparation.PreparationError, "deadline exceeded"):
                            preparation.prepare_immutable_runtime(**prepare_kwargs)
                    assert_no_legacy_custody_mutation()
                finally:
                    lock_holder.terminate()
                    lock_holder.wait(timeout=10)

                with patch.dict(os.environ, {"CC_RECEIVER_AUTHORIZATION_POLICY": str(policy_path), "DEPLOY_LOCK_FILE": str(deployment_lock), "GH_ATTESTATION_CLI": str(gh_wrapper), "CC_SYNTHETIC_VERIFIER_OUTPUT": str(verifier_output)}, clear=False), patch.object(preparation.retention, "assess_storage", return_value=SimpleNamespace(status="FAIL")):
                    with self.assertRaisesRegex(preparation.PreparationError, "storage/inode admission"):
                        preparation.prepare_immutable_runtime(**prepare_kwargs)
                assert_no_legacy_custody_mutation()

                with patch.dict(os.environ, {"CC_RECEIVER_AUTHORIZATION_POLICY": str(policy_path), "CC_SYNTHETIC_VERIFIER_OUTPUT": str(verifier_output), "GH_ATTESTATION_CLI": str(gh_wrapper), "DEPLOY_LOCK_FILE": str(deployment_lock)}, clear=False):
                    prep_args = root / "prepare-subprocess-args.json"
                    prep_args.write_bytes(delivery.provenance._canonical_json({key: str(value) if isinstance(value, Path) else value for key, value in prepare_kwargs.items()}) + b"\n")
                    prep_child = """
import importlib.util, json, os, signal, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('immutable_runtime_preparation_subprocess', Path(sys.argv[1]) / 'immutable_runtime_preparation.py')
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
args = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
for key in ('publication_root', 'prepared_root', 'repository_root', 'identity_file', 'authorization_policy', 'trusted_root', 'legacy_source', 'deployment_lock_file'):
    args[key] = Path(args[key])
original_fsync = module._fsync_tree
def interrupted_fsync(path, *, required):
    if path.name == 'extracted-runtime':
        os.kill(os.getpid(), signal.SIGKILL)
    return original_fsync(path, required=required)
module._fsync_tree = interrupted_fsync
module.prepare_immutable_runtime(**args)
"""
                    interrupted_process = subprocess.run([sys.executable, "-c", prep_child, str(PREP_SCRIPT.parent), str(prep_args)], check=False)
                    self.assertEqual(interrupted_process.returncode, -signal.SIGKILL)
                    self.assertTrue(any(path.name.startswith(".prepare-") for path in prepared_root.iterdir()))
                    prepared = preparation.prepare_immutable_runtime(**prepare_kwargs)
                    self.assertEqual(prepared["status"], "prepared-not-activated")
                    candidate_runtime = prepared_root / f"candidate-{normal.identity_sha256}" / "runtime"
                    self.assertTrue(candidate_runtime.is_dir())
                    state_after_prepare = store.load()
                    self.assertEqual(state_after_prepare["active_release"], None)
                    self.assertEqual(state_after_prepare["previous_known_good_release"], delivery.retention.LEGACY_BASELINE_ID)
                    self.assertIn("prepared", state_after_prepare["releases"][normal.identity_sha256]["roles"])
                    delivery.provenance.AuthorizationReplayJournal(journal, repository_root=checkout).assert_reserved(envelope, candidate_identity, candidate_allowlist, candidate_trust, operation="forward-release")
                    subprocess.run(["docker", "rm", "--force", container_name], check=True, capture_output=True)
                    subprocess.run(["docker", "volume", "rm", "--force", dist_volume, node_volume], check=True, capture_output=True)
                    shutil.rmtree(legacy_app)
                    shutil.rmtree(dist_overlay)
                    shutil.rmtree(node_overlay)
                    subprocess.run(["docker", "image", "prune", "--all", "--force"], check=True, capture_output=True, text=True)
                    retry = preparation.prepare_immutable_runtime(**prepare_kwargs)
                    self.assertEqual(retry["status"], "prepared-not-activated")
                    self.assertEqual(retry["legacy"]["identity"]["image_observation"]["protected_image_ref"], retry["legacy"]["identity"]["container_observation"]["protected_image_ref"])
                    probe = subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", candidate_docker_network, "--env", f"DATABASE_URL={candidate_database_url}", "--volume", f"{candidate_runtime}:/runtime:ro", image, "bash", "-euo", "pipefail", "-c", "cd /runtime && test -x node_modules/.bin/prisma && node_modules/.bin/prisma --version && node_modules/.bin/prisma validate --schema prisma/schema.prisma && node -e \"const {PrismaClient}=require('/runtime/node_modules/@prisma/client'); const prisma=new PrismaClient(); prisma.\\$queryRawUnsafe('SELECT 1').then(rows=>{if(!Array.isArray(rows)||rows.length!==1) process.exit(1)}).catch(error=>{console.error(error);process.exit(1)}).finally(()=>prisma.\\$disconnect())\""], check=False, capture_output=True, text=True, timeout=60)
                    self.assertEqual(probe.returncode, 0, probe.stderr)
                legacy_runtime = prepared_root / "legacy-runtime-baseline"
                protected_image = retry["legacy"]["identity"]["image_observation"]["protected_image_ref"]
                legacy_probe_command = "set +e; timeout 5 bash ./ops/deploy/container-start.sh; status=$?; set -e; test $status -eq 124"
                legacy_probe = subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64", "--network", candidate_docker_network, "--env", f"DATABASE_URL={candidate_database_url}", "--env", f"BUILD_SHA={legacy_revision}", "--env", "CLASHCOOKIES_PREBUILT=1", "--workdir", "/app", "--volume", f"{legacy_runtime}:/app:ro", protected_image, "bash", "-euo", "pipefail", "-c", f"node --check /app/dist/ClashCookies.js && node -e \"const {{PrismaClient}}=require('/app/node_modules/@prisma/client'); const prisma=new PrismaClient(); prisma.\\$queryRawUnsafe('SELECT 1').then(rows=>{{if(!Array.isArray(rows)||rows.length!==1) process.exit(1)}}).catch(error=>{{console.error(error);process.exit(1)}}).finally(()=>prisma.\\$disconnect())\" && {legacy_probe_command}"], check=False, capture_output=True, text=True, timeout=60)
                self.assertEqual(legacy_probe.returncode, 0, legacy_probe.stderr)
                self.assertIn("action=skip-build", legacy_probe.stdout)
                shutil.rmtree(candidate_runtime.parent)
                with patch.dict(os.environ, {"CC_RECEIVER_AUTHORIZATION_POLICY": str(policy_path)}, clear=False):
                    with self.assertRaisesRegex(preparation.PreparationError, "committed preparation metadata"):
                        preparation.prepare_immutable_runtime(**prepare_kwargs)
                subprocess.run(["docker", "rm", "--force", retry["legacy"]["identity"]["image_observation"]["protected_container_id"]], check=True, capture_output=True)

                lost_root = root / "lost-ack-custody"
                lost_receiving = lost_root / "receiving"
                lost_publication = lost_root / "publication"
                lost_journal = lost_root / "authorization-journal"
                lost_root.mkdir(mode=0o700)
                for path in (lost_receiving, lost_publication, lost_journal):
                    path.mkdir(parents=True, mode=0o700)
                lost_record = json.loads(json.dumps(authorization_record))
                lost_record["authorization"]["authorization_id"] = "candidate-ssh-lost-ack"
                lost_record["authorization"]["retry_key"] = "candidate-ssh-lost-ack"
                lost_record["authorization"]["destination"] = str(lost_publication)
                lost_record_path = material / "lost-ack-record.json"
                lost_signature_path = material / "lost-ack-record.sig"
                lost_record_path.write_bytes(delivery.provenance._canonical_json(lost_record))
                subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(lost_record_path), "-out", str(lost_signature_path)], check=True, capture_output=True)
                lost_envelope = delivery.provenance.assemble_owner_authorization_envelope(lost_record, lost_signature_path.read_bytes(), "candidate-test-key")
                lost_envelope_path = lost_root / "authorization-envelope.json"
                lost_envelope_path.write_bytes(delivery.provenance._canonical_json(lost_envelope) + b"\n")
                lost_envelope_path.chmod(0o600)
                lost_policy_path = lost_root / "receiver-authorization-policy.json"
                lost_policy_path.write_bytes(delivery.provenance._canonical_json({"contract": "clashcookies.receiver-authorization-policy", "version": 1, "repository": candidate_identity.repository, "destination": str(lost_publication), "artifact_class": candidate_identity.artifact_class, "authorization_context": delivery.provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT, "public_key_path": str(public_key), "key_id": "candidate-test-key", "key_fingerprint": key_fingerprint, "allowlist_path": str(allowlist), "journal_path": str(lost_journal)}))
                lost_policy_path.chmod(0o600)
                lost_receiver_env = sshd_setenv({"PYTHONPATH": SCRIPT.parent, "CC_RECEIVER_REPOSITORY_ROOT": checkout, "CC_RECEIVER_RECEIVING_ROOT": lost_receiving, "CC_RECEIVER_PUBLICATION_ROOT": lost_publication, "CC_RECEIVER_EXPECTED_IDENTITY": identity_path, "CC_RECEIVER_TRUSTED_ROOT": trusted_root, "CC_RECEIVER_OFFLINE_EXPECTATION": root / "expectation.json", "CC_RECEIVER_ATTESTATION_CLI": gh_wrapper, "CC_RECEIVER_AUTHORIZATION_POLICY": lost_policy_path, "CC_SYNTHETIC_VERIFIER_OUTPUT": verifier_output})
                config.write_text("\n".join([f"Port {port_number}", "ListenAddress 127.0.0.1", f"HostKey {server_key}", f"AuthorizedKeysFile {authorized}", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "UsePAM no", "StrictModes no", "LogLevel QUIET", "PermitUserEnvironment no", lost_receiver_env]) + "\n", encoding="utf-8")
                config.chmod(0o600)
                server.terminate()
                server.wait(timeout=5)
                server = subprocess.Popen([shutil.which("sshd"), "-D", "-e", "-f", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                wait_for_candidate_server()
                assert_receiver_environment({"receiving": lost_receiving, "publication": lost_publication, "policy": lost_policy_path})
                lost_endpoint = delivery.SshDeliveryEndpoint(host="127.0.0.1", user=user, known_hosts=known_hosts, identity_file=client_key, destination=str(lost_publication), remote_repository_root=str(checkout), remote_receiving_root=str(lost_receiving), remote_publication_root=str(lost_publication), remote_expected_identity=str(identity_path), remote_trusted_root=str(trusted_root), remote_offline_expectation=str(root / "expectation.json"), remote_attestation_cli=str(gh_wrapper), remote_authorization_policy=str(lost_policy_path), port=port_number, execution_timeout_seconds=delivery.MAX_RECEIVING_SECONDS)
                lost_deliver = lambda: delivery.deliver_exact_artifact_over_ssh(lost_endpoint, service_zip, candidate_identity, checkout, attestation_bundle=bundle, authorization_envelope=lost_envelope_path, candidate_verification_context=context_path)
                delivery._assert_private_input(lost_envelope_path, checkout, "lost-ack authorization envelope", delivery.provenance.MAX_AUTHORIZATION_RECORD_BYTES)
                delivery._assert_private_input(lost_policy_path, checkout, "lost-ack receiver authorization policy", delivery.MAX_HEADER_BYTES)
                drop_directory = root / "ssh-drop-ack"
                drop_directory.mkdir(mode=0o700)
                drop_ssh = drop_directory / "ssh"
                real_ssh = shutil.which("ssh")
                drop_ssh.write_text(f"#!/bin/sh\n{shlex.quote(real_ssh)} \"$@\" >/dev/null\nstatus=$?\nif [ \"$status\" -eq 0 ]; then\n  printf '%s\\n' 'synthetic acknowledgment loss after successful receiver execution' >&2\n  exit 75\nfi\nexit \"$status\"\n", encoding="utf-8")
                drop_ssh.chmod(0o700)
                with patch.dict(os.environ, {"PATH": str(drop_directory) + os.pathsep + os.environ["PATH"]}):
                    with self.assertRaisesRegex(delivery.DeliveryError, "synthetic acknowledgment loss after successful receiver execution"):
                        lost_deliver()
                lost_publication_path = lost_publication / f"release-{delivery._identity_digest(candidate_identity)}"
                self.assertTrue(lost_publication_path.is_dir(), "receiver did not complete publication before the acknowledgment was lost")
                lost_store = delivery.retention.RetentionStore(lost_publication, repository_root=checkout, require_durable=False)
                lost_state = lost_store.load()
                lost_record_state = lost_state["releases"][delivery._identity_digest(candidate_identity)]
                self.assertEqual(lost_record_state["identity"], delivery._identity_payload(candidate_identity))
                self.assertEqual(lost_record_state["roles"], ["pending", "reserved"])
                self.assertIsNone(lost_record_state["reconciliation"]["authorization"])
                delivery.provenance.AuthorizationReplayJournal(lost_journal, repository_root=checkout).assert_reserved(lost_envelope, candidate_identity, candidate_allowlist, candidate_trust, operation="forward-release")
                final = lost_deliver()
                self.assertEqual(final.status, "retry-success")
                trusted_root_digest = hashlib.sha256(trusted_root.read_bytes()).hexdigest()
                with patch.dict(os.environ, {"GH_ATTESTATION_CLI": str(gh_wrapper), "CC_SYNTHETIC_VERIFIER_OUTPUT": str(verifier_output)}, clear=False):
                    historical = lost_store.verify_retained_offline(
                        final.identity_sha256,
                        trusted_root=trusted_root,
                        trusted_root_version=trusted_root_digest[:16],
                        verifier_version=delivery.provenance.SUPPORTED_GH_VERSION,
                        authorization_public_key=public_key,
                        authorization_key_id="candidate-test-key",
                        authorization_key_fingerprint=key_fingerprint,
                        authorization_allowlist=allowlist,
                        excluded_roots=(lost_receiving,),
                    )
                self.assertEqual(historical["authorizationDiagnostic"]["replayMutation"], "none")
                self.assertEqual(lost_store.load(), lost_state)
                delivery.provenance.AuthorizationReplayJournal(lost_journal, repository_root=checkout).assert_reserved(lost_envelope, candidate_identity, candidate_allowlist, candidate_trust, operation="forward-release")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
