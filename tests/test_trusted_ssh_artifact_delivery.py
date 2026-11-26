"""Focused regressions for the bounded trusted-SSH delivery boundary."""

from __future__ import annotations

from io import BytesIO
import importlib.util
import json
import getpass
import errno
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
import base64
import ctypes
import hashlib
import shlex
import shutil
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
        authorization_context="owner-approved-main-release",
    )


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

    def test_synthetic_authorization_fixture_uses_delivery_provenance_module(self) -> None:
        identity = synthetic_canonical_identity()
        self.assertIs(type(identity), delivery.provenance.TrustedReleaseIdentity)
        delivery.provenance.validate_trusted_release_identity(identity)

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
        verified = type("Verified", (), {field: getattr(identity, field) for field in ("repository", "source_ref", "source_sha", "event", "signer_workflow", "signer_revision", "run_id", "run_attempt", "artifact_class", "platform", "image", "image_digest", "archive_name", "archive_sha256", "archive_bytes")})()
        delivery._validate_provenance_binding(identity, expectation, verified)
        expectation["source_sha"] = "0" * 40
        with self.assertRaisesRegex(delivery.DeliveryError, "source_sha"):
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
                issued_at="2026-11-25T12:00:00Z", expires_at="2026-11-26T12:00:00Z", retry_key="delivery-test-auth",
                recovery_context=None, signing_key_id="test-key",
                verification=delivery.provenance.AuthorizationVerificationReceipt("test", "f" * 64, "2026-11-25T12:00:00Z", "test-key", key_fingerprint="1" * 64),
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
            receiving = root / "receiving"
            publication = root / "publication"
            journal_root = root / "journal"
            for path in (receiving, publication, journal_root):
                path.mkdir(mode=0o700)
            journal = delivery.provenance.AuthorizationReplayJournal(journal_root, repository_root=checkout)
            now = datetime(2026, 11, 25, 12, 30, tzinfo=timezone.utc)
            with patch.object(delivery, "_publish_payload", side_effect=delivery.DeliveryError("interrupted after reservation")), self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            result = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            self.assertEqual(result.status, "published")
            retry = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            self.assertEqual(retry.status, "retry-success")
            destination = Path(result.publication)
            original_zip = (destination / "artifact-service.zip").read_bytes()
            (destination / "artifact-service.zip").write_bytes(b"tampered")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            (destination / "artifact-service.zip").write_bytes(original_zip)
            identity_bytes = (destination / "identity.json").read_bytes()
            (destination / "identity.json").write_bytes(b"{}")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            (destination / "identity.json").write_bytes(identity_bytes)
            authorization_bytes = (destination / "authorization-envelope.json").read_bytes()
            (destination / "authorization-envelope.json").write_bytes(b"tampered")
            with self.assertRaises(delivery.DeliveryError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            (destination / "authorization-envelope.json").write_bytes(authorization_bytes)
            with patch.object(delivery, "_fsync_existing_publication", side_effect=OSError("directory fsync failure")), self.assertRaises(OSError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            durable_retry = delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            self.assertEqual(durable_retry.status, "retry-success")
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(lambda _index: delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now), range(2)))
            self.assertEqual({item.status for item in outcomes}, {"retry-success"})
            expired_journal_root = root / "expired-journal"
            expired_journal_root.mkdir(mode=0o700)
            expired_journal = delivery.provenance.AuthorizationReplayJournal(expired_journal_root, repository_root=checkout)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=expired_journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc))
            conflicting_authorization = replace(authorization, scope="recovery-release", recovery_context="synthetic-conflict")
            conflicting = signed_envelope(conflicting_authorization)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=conflicting, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, operation="recovery-release", now=now)
            tampered = {"contract": envelope["contract"], "version": envelope["version"], "record": envelope["record"], "signature": dict(envelope["signature"])}
            tampered["signature"]["value"] = base64.b64encode(b"\0" * 64).decode("ascii")
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=tampered, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)
            journal.consume(envelope, identity, allowlist, trust, operation="forward-release", now=now)
            with self.assertRaises(delivery.provenance.ProvenanceError):
                delivery.publish_synthetic_authorized_delivery_for_test(service_zip=service_zip, expected_identity=identity, authorization_envelope=envelope, trust=trust, revision_allowlist=allowlist, journal=journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now)

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
            config.write_text("\n".join([
                f"Port {port}", "ListenAddress 127.0.0.1", f"HostKey {server_key}",
                f"AuthorizedKeysFile {authorized}", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
                "PubkeyAuthentication yes", "UsePAM no", "StrictModes no", "LogLevel QUIET",
                "PermitUserEnvironment no", f"SetEnv PYTHONPATH={SCRIPT.parent}",
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
            finally:
                stop_server(server)


if __name__ == "__main__":
    unittest.main()
