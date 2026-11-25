"""Focused regressions for the bounded trusted-SSH delivery boundary."""

from __future__ import annotations

from io import BytesIO
import importlib.util
import json
import getpass
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
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


class TrustedSshDeliveryTests(unittest.TestCase):
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

    def test_acknowledgment_is_identity_and_publication_bound(self) -> None:
        identity = development_identity()
        endpoint = delivery.SshDeliveryEndpoint(
            host="receiver", user="owner", known_hosts=Path("/tmp/known_hosts"), identity_file=Path("/tmp/id"),
            destination="/srv/evidence", remote_repository_root="/srv/repo", remote_receiving_root="/srv/receive",
            remote_publication_root="/srv/evidence", remote_expected_identity="/srv/identity.json",
            remote_trusted_root="/srv/root.jsonl", remote_offline_expectation="/srv/expectation.json",
        )
        acknowledgment = {
            "status": "published", "publication": "/srv/evidence/release-" + "0" * 64,
            "identity_sha256": delivery._identity_digest(identity),
            "artifact_service_zip_sha256": identity.artifact_service_zip_sha256,
            "artifact_service_zip_bytes": identity.artifact_service_zip_bytes,
            "archive_sha256": identity.archive_sha256, "archive_bytes": identity.archive_bytes,
            "offline_attestation": True, "authorization_reserved": False,
        }
        acknowledgment["archive_sha256"] = "0" * 64
        with self.assertRaises(delivery.DeliveryError):
            delivery._validate_acknowledgment(acknowledgment, identity, endpoint)

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
            )
            with self.assertRaises(delivery.DeliveryError):
                delivery._validate_endpoint(endpoint, root)

    def test_offline_gh_verification_uses_external_root_and_no_auth_environment(self) -> None:
        with TemporaryDirectory() as root_name:
            base = Path(root_name)
            root = base / "checkout"
            root.mkdir()
            archive = base / "archive"
            bundle = base / "bundle.json"
            trusted_root = base / "trusted-root.pem"
            archive.write_bytes(b"archive")
            bundle.write_text("{}", encoding="utf-8")
            trusted_root.write_text("root", encoding="utf-8")
            calls = []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                if command[1] == "version":
                    return delivery.provenance.subprocess.CompletedProcess(command, 0, "gh version 2.89.0\n", "")
                return delivery.provenance.subprocess.CompletedProcess(command, 0, "[{}]", "")

            with patch.dict(delivery.provenance.os.environ, {"GH_TOKEN": "must-not-leak", "GH_CONFIG_DIR": str(root / "cached")}, clear=False), patch.object(delivery.provenance, "run_bounded", side_effect=fake_run):
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

    @unittest.skipUnless(os.name == "posix" and shutil.which("ssh") and shutil.which("sshd") and os.environ.get("CC_REAL_RECEIVER") == "1", "real receiver integration is enabled only by mandatory Linux CI")
    def test_real_openssh_receiver_and_exclusive_host_pinning(self) -> None:
        with TemporaryDirectory() as root_name:
            root = Path(root_name)
            checkout = Path(os.environ["CC_RECEIVER_REPOSITORY_ROOT"])
            service_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
            bundle = Path(os.environ["CC_RECEIVER_BUNDLE"])
            identity_path = Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"])
            trusted_root = Path(os.environ["CC_RECEIVER_TRUSTED_ROOT"])
            expectation = Path(os.environ["CC_RECEIVER_OFFLINE_EXPECTATION"])
            receiving = root / "receiving"
            publication = root / "publication"
            remote_files = root / "remote-files"
            receiving.mkdir(mode=0o700)
            publication.mkdir(mode=0o700)
            remote_files.mkdir(mode=0o700)
            server_key = root / "server_key"
            client_key = root / "client_key"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(server_key)], check=True, capture_output=True)
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(client_key)], check=True, capture_output=True)
            authorized = root / "authorized_keys"
            authorized.write_text(client_key.with_suffix(".pub").read_text(encoding="utf-8"), encoding="utf-8")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            server_pub = server_key.with_suffix(".pub").read_text(encoding="utf-8").split()
            known_hosts = root / "known_hosts"
            config = root / "sshd_config"
            config.write_text("\n".join([
                f"Port {port}", "ListenAddress 127.0.0.1", f"HostKey {server_key}",
                f"AuthorizedKeysFile {authorized}", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
                "PubkeyAuthentication yes", "UsePAM no", "UsePrivilegeSeparation no", "StrictModes no", "LogLevel QUIET",
                "PermitUserEnvironment no", f"SetEnv PYTHONPATH={SCRIPT.parent}", f"SetEnv GH_ATTESTATION_CLI={os.environ['CC_RECEIVER_GH']}",
            ]) + "\n", encoding="utf-8")
            user = getpass.getuser()
            server_command = [shutil.which("sshd"), "-D", "-e", "-f", str(config)]
            if os.environ.get("CC_RECEIVER_NETWORK_DISABLED") == "1":
                server_command = ["sudo", "-n", "unshare", "--net", "--mount-proc", "--fork", "runuser", "-u", user, "--", *server_command]

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
                    remote_trusted_root=str(trusted_root), remote_offline_expectation=str(expectation), port=port,
                    execution_timeout_seconds=delivery.MAX_RECEIVING_SECONDS,
                )

            def deliver() -> delivery.DeliveryResult:
                return delivery.deliver_exact_artifact_over_ssh(endpoint(), service_zip, json_identity, checkout, attestation_bundle=bundle)

            json_identity = delivery.identity_from_json(json.loads(identity_path.read_text(encoding="utf-8")))
            known_hosts.write_text("", encoding="utf-8")
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
                with self.assertRaises(delivery.DeliveryError):
                    deliver()
                wrong = client_key.with_suffix(".pub").read_text(encoding="utf-8").split()
                known_hosts.write_text(f"[127.0.0.1]:{port} {wrong[0]} {wrong[1]}\n", encoding="utf-8")
                with self.assertRaises(delivery.DeliveryError):
                    deliver()
                known_hosts.write_text(f"[127.0.0.1]:{port} {server_pub[0]} {server_pub[1]}\n", encoding="utf-8")
                result = deliver()
                self.assertEqual(result.status, "published")
                self.assertEqual(Path(result.publication, "artifact-service.zip").read_bytes(), service_zip.read_bytes())
                self.assertEqual(json.loads(Path(result.publication, "identity.json").read_text(encoding="utf-8")), json.loads(identity_path.read_text(encoding="utf-8")))
                retry = deliver()
                self.assertEqual(retry.status, "retry-success")
                self.assertEqual(retry.publication, result.publication)

                stop_server(server)
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / "changed_server_key")], check=True, capture_output=True)
                changed_key = root / "changed_server_key"
                config.write_text(config.read_text(encoding="utf-8").replace(str(server_key), str(changed_key)), encoding="utf-8")
                server = start_server()
                wait_for_server()
                with self.assertRaises(delivery.DeliveryError):
                    deliver()
            finally:
                stop_server(server)


if __name__ == "__main__":
    unittest.main()
