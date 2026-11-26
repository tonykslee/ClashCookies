from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import shutil
import signal
from types import SimpleNamespace
from unittest.mock import patch
from zipfile import ZipFile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


retention = load_module("durable_artifact_retention_test", "durable_artifact_retention.py")
readiness = load_module("vm_readiness_test", "vm_readiness.py")


class DurableRetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir(mode=0o700)
        self.publication = self.root / "publication"
        self.publication.mkdir(mode=0o700)
        if os.name == "posix":
            self.root.chmod(0o700)
            self.repo.chmod(0o700)
            self.publication.chmod(0o700)
        self.store = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        self.store.initialize()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def release(self, token: str) -> tuple[dict[str, object], str]:
        artifact = (token.encode("ascii") * 1024)[:1024]
        source_sha = hashlib.sha256(f"{token}:source".encode("ascii")).hexdigest()[:40]
        producer_revision = hashlib.sha256(f"{token}:producer".encode("ascii")).hexdigest()[:40]
        signer_revision = hashlib.sha256(f"{token}:signer".encode("ascii")).hexdigest()[:40]
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        artifact_digest = hashlib.sha256(artifact).hexdigest()
        identity: dict[str, object] = {
            "repository": "tonykslee/ClashCookies", "repository_id": 668452496, "repository_owner_id": 18295450,
            "source_ref": "refs/heads/dev", "source_sha": source_sha, "event": "push",
            "producer_workflow": ".github/workflows/runtime-artifact.yml", "producer_revision": producer_revision,
            "signer_workflow": ".github/workflows/runtime-artifact.yml", "signer_revision": signer_revision,
            "run_id": 1, "run_attempt": 1, "artifact_id": 1, "artifact_name": "runtime-artifact-1-1",
            "artifact_class": "development-runtime-evidence", "artifact_service_zip_sha256": artifact_digest,
            "artifact_service_zip_bytes": len(artifact), "archive_name": f"runtime-{source_sha}.tar.gz",
            "archive_sha256": digest, "archive_bytes": 1, "platform": "linux/amd64", "image": "node:20-bookworm",
            "image_digest": digest, "authorization_context": "development",
        }
        identity_digest = retention.identity_digest(identity)
        path = self.publication / f"release-{identity_digest}"
        path.mkdir(mode=0o700)
        (path / "identity.json").write_text(json.dumps(identity, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        (path / "artifact-service.zip").write_bytes(artifact)
        if os.name == "posix":
            (path / "identity.json").chmod(0o600)
            (path / "artifact-service.zip").chmod(0o600)
        self.store.register_delivery(identity, path)
        return identity, identity_digest

    def test_first_legacy_baseline_is_distinct_and_protected(self) -> None:
        state = self.store.load()
        self.assertEqual(state["previous_known_good_release"], retention.LEGACY_BASELINE_ID)
        self.assertFalse(state["legacy_baseline"]["authenticated"])
        self.assertTrue(state["legacy_baseline"]["protected"])

    def test_active_previous_pending_and_recovery_releases_are_never_gc_candidates(self) -> None:
        _, first = self.release("a")
        _, second = self.release("b")
        _, third = self.release("c")
        _, fourth = self.release("d")
        self.store.transition_active_for_test(first, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(second, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.mark_operation("recover-1", fourth, kind="delivery", recovery_required=True)
        dry_run = self.store.garbage_collect()
        self.assertNotIn(first, dry_run["candidates"])
        self.assertNotIn(second, dry_run["candidates"])
        self.assertNotIn(third, dry_run["candidates"])
        self.assertNotIn(fourth, dry_run["candidates"])
        self.assertEqual(dry_run["candidates"], [])

    def test_retired_release_is_dry_run_then_bounded_deleted(self) -> None:
        _, first = self.release("a")
        _, second = self.release("b")
        _, third = self.release("c")
        self.store.transition_active_for_test(first, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(second, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(third, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.retire(first)
        dry_run = self.store.garbage_collect()
        self.assertEqual(dry_run["candidates"], [first])
        self.assertTrue((self.publication / f"release-{first}").exists())
        if os.name != "posix":
            with self.assertRaises(retention.RetentionError):
                self.store.garbage_collect(execute=True, max_deletions=1)
            return
        executed = self.store.garbage_collect(execute=True, max_deletions=1)
        self.assertEqual(executed["deleted"], [first])
        self.assertFalse((self.publication / f"release-{first}").exists())
        self.assertTrue((self.publication / retention.LOCK_FILENAME).exists())

    def test_unknown_or_conflicting_material_is_retained(self) -> None:
        unknown = self.publication / ("release-" + "0" * 64)
        unknown.mkdir()
        (unknown / "identity.json").write_text("{}", encoding="utf-8")
        if os.name != "posix":
            with self.assertRaises(retention.RetentionError):
                self.store.garbage_collect(execute=True)
            return
        result = self.store.garbage_collect(execute=True)
        self.assertEqual(result["deleted"], [])
        self.assertTrue(unknown.exists())
        self.assertIn({"publication": unknown.name, "reason": "unknown-or-ambiguous-ownership"}, result["unknown"])

    @unittest.skipUnless(os.name == "posix", "Linux ownership and permission regression")
    def test_gc_preserves_release_with_unsafe_private_permissions(self) -> None:
        _, digest = self.release("unsafe")
        _, next_digest = self.release("unsafe-next")
        self.store.transition_active_for_test(digest, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(next_digest, health_gate=lambda: True, consume_authorization=lambda: None)
        release_path = self.publication / f"release-{digest}"
        release_path.chmod(0o755)
        result = self.store.garbage_collect(execute=True)
        self.assertNotIn(digest, result["deleted"])
        self.assertIn({"publication": release_path.name, "reason": "unknown-or-ambiguous-ownership"}, result["unknown"])
        self.assertTrue(release_path.exists())

    def test_storage_rejects_negative_admission_inputs(self) -> None:
        with self.assertRaises(retention.RetentionError):
            retention.assess_storage([self.publication], temporary_bytes=-1, persistent_bytes=0)

    def test_missing_state_requires_explicit_initialization_and_existing_material_is_not_adopted(self) -> None:
        self.store.state_path.unlink()
        with self.assertRaisesRegex(retention.RetentionError, "missing"):
            self.store.load()
        self.store.initialize()
        _, digest = self.release("adopt")
        self.store.state_path.unlink()
        restarted = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        with self.assertRaisesRegex(retention.RetentionError, "missing"):
            restarted.initialize()
        self.assertTrue((self.publication / f"release-{digest}").exists())

    def test_retirement_requires_explicit_protection_reconciliation(self) -> None:
        _, digest = self.release("reconcile")
        with self.assertRaisesRegex(retention.RetentionError, "actual authorization or recovery reconciliation"):
            self.store.retire(digest)
        self.assertEqual(self.store.load()["releases"][digest]["roles"], ["pending"])

    @unittest.skipUnless(os.name == "posix", "GC interruption recovery requires POSIX destructive-operation semantics")
    def test_interrupted_gc_is_recovery_protected_and_reconciled_after_restart(self) -> None:
        _, first = self.release("gc-a")
        _, second = self.release("gc-b")
        _, third = self.release("gc-c")
        self.store.transition_active_for_test(first, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(second, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(third, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.retire(first)
        with patch.object(self.store, "_delete_owned_release", side_effect=retention.RetentionError("simulated pre-delete interruption")):
            with self.assertRaises(retention.RetentionError):
                self.store.garbage_collect(execute=True, max_deletions=1)
        restarted = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        before_dry_run = restarted.state_path.read_bytes()
        result = restarted.garbage_collect()
        self.assertEqual(restarted.state_path.read_bytes(), before_dry_run)
        self.assertNotIn(first, result["candidates"])
        self.assertIn("recovery-protected", restarted.load()["releases"][first]["roles"])
        owner = restarted.load()["gc_transactions"][first]["owner"]
        shutil.rmtree(self.publication / f"release-{first}")
        restarted = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        restarted.garbage_collect()
        self.assertIn(first, restarted.load()["releases"])
        restarted.acknowledge_gc_deletion(first, owner)
        self.assertNotIn(first, restarted.load()["releases"])

    @unittest.skipUnless(os.name == "posix", "process termination recovery requires POSIX")
    def test_gc_process_termination_leaves_durable_recovery_state(self) -> None:
        _, first = self.release("sigkill-a")
        _, second = self.release("sigkill-b")
        _, third = self.release("sigkill-c")
        self.store.transition_active_for_test(first, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(second, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(third, health_gate=lambda: True, consume_authorization=lambda: None)
        child_code = "import os, sys; sys.path.insert(0, sys.argv[1]); import durable_artifact_retention as r; s=r.RetentionStore(__import__('pathlib').Path(sys.argv[2]), repository_root=__import__('pathlib').Path(sys.argv[3]), require_durable=False); s._delete_owned_release=lambda *args: os.kill(os.getpid(), 9); s.garbage_collect(execute=True, max_deletions=1)"
        process = subprocess.run([sys.executable, "-c", child_code, str(ROOT / "scripts"), str(self.publication), str(self.repo)], check=False)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        restarted = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        restarted.garbage_collect()
        self.assertIn("recovery-protected", restarted.load()["releases"][first]["roles"])

    @unittest.skipUnless(os.name == "posix", "inode admission regression requires POSIX statvfs")
    def test_inode_exhaustion_blocks_admission(self) -> None:
        with patch.object(retention.os, "statvfs", return_value=SimpleNamespace(f_bavail=10**9, f_frsize=1, f_favail=0)):
            assessment = retention.assess_storage([self.publication], temporary_bytes=1, persistent_bytes=1)
        self.assertEqual(assessment.status, "BLOCKED")

    def test_arbitrary_private_pass_evidence_is_not_readiness_pass(self) -> None:
        evidence = self.root / "health.json"
        evidence.write_text(json.dumps({"status": "PASS"}), encoding="utf-8")
        if os.name == "posix":
            evidence.chmod(0o600)
        finding = readiness._evidence_finding("runtime-health", str(evidence), required=False)
        self.assertEqual(finding.status, "UNKNOWN")

    def test_forged_complete_readiness_evidence_is_not_pass(self) -> None:
        evidence = self.root / "forged-health.json"
        evidence.write_text(json.dumps({"contract": "clashcookies.vm-readiness-evidence", "version": 1, "status": "PASS", "authenticated": True, "subject_sha256": "a" * 64, "observed_at": datetime.now(timezone.utc).isoformat(), "source": "clashcookies:forged"}), encoding="utf-8")
        if os.name == "posix":
            evidence.chmod(0o600)
        finding = readiness._evidence_finding("runtime-health", str(evidence), required=False)
        self.assertEqual(finding.status, "UNKNOWN")

    @unittest.skipUnless(os.environ.get("CC_REAL_RETENTION_OFFLINE") == "1", "mandatory real retained offline verification requires Linux CI evidence")
    def test_real_retained_offline_verification_after_operational_delivery(self) -> None:
        self.assertEqual(os.name, "posix")
        trusted_root = Path(os.environ["CC_RETENTION_TRUSTED_ROOT"])
        publication = Path(os.environ["CC_RETENTION_PUBLICATION_CAPTURE"])
        identity = json.loads(Path(os.environ["CC_RETENTION_EXPECTED_IDENTITY"]).read_text(encoding="utf-8"))
        identity_sha256 = retention.identity_digest(identity)
        self.assertTrue((publication / f"release-{identity_sha256}").is_dir(), "captured publication is not the operationally delivered release")
        store = retention.RetentionStore(publication, repository_root=Path(os.environ["CC_RETENTION_REPOSITORY_ROOT"]), require_durable=False)
        receipt = store.verify_retained_offline(identity_sha256, trusted_root=trusted_root, trusted_root_version=os.environ["CC_RETENTION_TRUSTED_ROOT_VERSION"])
        self.assertEqual(receipt["status"], "verified-provenance-only")
        self.assertTrue(receipt["authenticated"])

    def test_atomic_metadata_generation_and_malformed_state_fail_closed(self) -> None:
        _, digest = self.release("a")
        _, next_digest = self.release("a-next")
        _, final_digest = self.release("a-final")
        self.store.transition_active_for_test(digest, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(next_digest, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(final_digest, health_gate=lambda: True, consume_authorization=lambda: None)
        first = self.store.load()["generation"]
        self.store.retire(digest)
        self.assertGreater(self.store.load()["generation"], first)
        self.store.state_path.write_text("{\"contract\":\"wrong\"}", encoding="utf-8")
        with self.assertRaises(retention.RetentionError):
            self.store.load()

    def test_interrupted_atomic_replace_preserves_previous_state_and_temp_is_not_owned(self) -> None:
        _, digest = self.release("a")
        _, next_digest = self.release("a-next")
        _, final_digest = self.release("a-final")
        self.store.transition_active_for_test(digest, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(next_digest, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(final_digest, health_gate=lambda: True, consume_authorization=lambda: None)
        before = self.store.state_path.read_bytes()
        with patch.object(retention.os, "replace", side_effect=OSError("simulated interruption")):
            with self.assertRaises(retention.RetentionError):
                self.store.retire(digest)
        self.assertEqual(self.store.state_path.read_bytes(), before)
        self.assertFalse(any(path.name.startswith(f".{retention.STATE_FILENAME}.tmp-") for path in self.publication.iterdir()))

    def test_shared_filesystem_admission_counts_device_once(self) -> None:
        assessment = retention.assess_storage([self.publication, self.publication], temporary_bytes=1, persistent_bytes=2, temporary_inodes=1, persistent_inodes=1, headroom_inodes=1)
        self.assertEqual(len(assessment.filesystems), 1)
        self.assertEqual(assessment.filesystems[0]["paths"], 2)
        self.assertEqual(assessment.required_bytes, 3)

    def test_incremental_runtime_preservation_reserve_affects_admission_without_double_counting_retained_bytes(self) -> None:
        assessment = retention.assess_storage([self.publication], temporary_bytes=1, persistent_bytes=2, preserved_runtime_bytes=100, incremental_preservation_bytes=7)
        self.assertEqual(assessment.required_bytes, 10)
        self.assertEqual(assessment.filesystems[0]["preserved_runtime_bytes"], 100)
        self.assertEqual(assessment.filesystems[0]["incremental_preservation_bytes"], 7)

    def test_gc_does_not_touch_independent_trust_or_replay_material(self) -> None:
        _, first = self.release("a")
        _, second = self.release("b")
        _, third = self.release("c")
        self.store.transition_active_for_test(first, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(second, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.transition_active_for_test(third, health_gate=lambda: True, consume_authorization=lambda: None)
        self.store.retire(first)
        trust = self.root / "trusted-root.jsonl"
        journal = self.root / "authorization-journal"
        journal.mkdir(mode=0o700)
        trust.write_text("trusted-root-evidence", encoding="utf-8")
        (journal / "reserved.json").write_text("replay-state", encoding="utf-8")
        if os.name == "posix":
            trust.chmod(0o600)
            (journal / "reserved.json").chmod(0o600)
        if os.name != "posix":
            with self.assertRaises(retention.RetentionError):
                self.store.garbage_collect(execute=True)
            return
        self.store.garbage_collect(execute=True)
        self.assertTrue(trust.exists())
        self.assertEqual((journal / "reserved.json").read_text(encoding="utf-8"), "replay-state")

    @unittest.skipUnless(os.name == "posix", "cross-process retention concurrency requires Linux/POSIX")
    def test_concurrent_registration_and_gc_share_one_lock(self) -> None:
        releases = [self.release(token)[0] for token in ("e", "f", "g", "h")]
        errors: list[BaseException] = []

        def register(identity: dict[str, object], token: str) -> None:
            try:
                digest = retention.identity_digest(identity)
                path = self.publication / f"release-{digest}"
                # The release helper already registered this exact identity;
                # this is an idempotent concurrent retry against the same bytes.
                self.store.register_delivery(identity, path)
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=register, args=(identity, str(index))) for index, identity in enumerate(releases)]
        for thread in threads:
            thread.start()
        inventory_thread = threading.Thread(target=lambda: self.store.garbage_collect())
        inventory_thread.start()
        for thread in threads:
            thread.join()
        inventory_thread.join()
        self.assertEqual(errors, [])

    @unittest.skipUnless(os.name == "posix", "real lock contention requires Linux/POSIX")
    def test_linux_lock_contention_is_bounded_and_retryable(self) -> None:
        code = "import fcntl, os, sys, time; fd=os.open(sys.argv[1], os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600); os.fchmod(fd, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print('LOCKED', flush=True); time.sleep(2); fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)"
        process = subprocess.Popen([sys.executable, "-c", code, str(self.publication / retention.LOCK_FILENAME)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertIsNotNone(process.stdout)
            self.assertEqual(process.stdout.readline().strip(), "LOCKED", "lock-holder subprocess did not acquire the lock")
            with self.assertRaisesRegex(retention.RetentionError, "deadline exceeded"):
                with retention.activity_lock(self.publication, timeout_seconds=.05):
                    pass
            process.wait(timeout=2)
            with retention.activity_lock(self.publication, timeout_seconds=1):
                pass
        finally:
            process.kill() if process.poll() is None else None
            process.wait()

    def test_readiness_output_is_sanitized_and_fail_closed(self) -> None:
        wrapper = self.root / "deploy-prod.sh"
        wrapper.write_text("#!/bin/sh\n# PRIVATE KEY https://secret.invalid/token\nDEPLOY_ATTEMPT_ID=1\nreconcile_abandoned_resources\nassert_production_health_ready\n", encoding="utf-8")
        trust = self.root / "trust-root.jsonl"
        trust.write_text("trusted-root-evidence", encoding="utf-8")
        journal = self.root / "journal"
        journal.mkdir(mode=0o700)
        legacy = self.root / "legacy"
        legacy.mkdir(mode=0o700)
        if os.name == "posix":
            wrapper.chmod(0o700)
            trust.chmod(0o600)
            journal.chmod(0o700)
            legacy.chmod(0o700)
        config = {
            "storage_paths": [str(self.publication)],
            "temporary_bytes": 1,
            "persistent_bytes": 1,
            "wrapper_path": str(wrapper),
            "legacy_runtime_path": str(legacy),
            "trust_root": str(trust),
            "authorization_journal": str(journal),
        }
        output = readiness.collect(config)
        encoded = json.dumps(output, sort_keys=True)
        self.assertNotIn("secret.invalid", encoded)
        self.assertNotIn("PRIVATE KEY", encoded)
        self.assertIn(output["overall"], {"BLOCKED", "UNKNOWN", "PASS"})
        self.assertFalse(output["production_eligible"])


if __name__ == "__main__":
    unittest.main()
