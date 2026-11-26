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
from unittest.mock import patch


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
        self.repo.mkdir()
        self.publication = self.root / "publication"
        self.publication.mkdir()
        self.store = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def release(self, token: str) -> tuple[dict[str, object], str]:
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        identity: dict[str, object] = {
            "repository": "tonykslee/ClashCookies", "repository_id": 668452496, "repository_owner_id": 18295450,
            "source_ref": "refs/heads/dev", "source_sha": token * 40, "event": "push",
            "producer_workflow": ".github/workflows/runtime-artifact.yml", "producer_revision": token * 40,
            "signer_workflow": ".github/workflows/runtime-artifact.yml", "signer_revision": token * 40,
            "run_id": 1, "run_attempt": 1, "artifact_id": 1, "artifact_name": "runtime-artifact-1-1",
            "artifact_class": "development-runtime-evidence", "artifact_service_zip_sha256": digest,
            "artifact_service_zip_bytes": 1024, "archive_name": f"runtime-{token * 40}.tar.gz",
            "archive_sha256": digest, "archive_bytes": 1, "platform": "linux/amd64", "image": "node:20-bookworm",
            "image_digest": digest, "authorization_context": "development",
        }
        identity_digest = retention.identity_digest(identity)
        path = self.publication / f"release-{identity_digest}"
        path.mkdir()
        (path / "identity.json").write_text(json.dumps(identity, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        (path / "artifact-service.zip").write_bytes((token.encode("ascii") * 128)[:1024])
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
        self.store.transition_active_for_test(third, health_gate=lambda: True, consume_authorization=lambda: None)
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
        executed = self.store.garbage_collect(execute=True, max_deletions=1)
        self.assertEqual(executed["deleted"], [first])
        self.assertFalse((self.publication / f"release-{first}").exists())
        self.assertTrue((self.publication / retention.LOCK_FILENAME).exists())

    def test_unknown_or_conflicting_material_is_retained(self) -> None:
        unknown = self.publication / ("release-" + "0" * 64)
        unknown.mkdir()
        (unknown / "identity.json").write_text("{}", encoding="utf-8")
        result = self.store.garbage_collect(execute=True)
        self.assertEqual(result["deleted"], [])
        self.assertTrue(unknown.exists())
        self.assertIn({"publication": unknown.name, "reason": "unknown-or-ambiguous-ownership"}, result["unknown"])

    def test_atomic_metadata_generation_and_malformed_state_fail_closed(self) -> None:
        _, digest = self.release("a")
        first = self.store.load()["generation"]
        self.store.retire(digest)
        self.assertGreater(self.store.load()["generation"], first)
        self.store.state_path.write_text("{\"contract\":\"wrong\"}", encoding="utf-8")
        with self.assertRaises(retention.RetentionError):
            self.store.load()

    def test_interrupted_atomic_replace_preserves_previous_state_and_temp_is_not_owned(self) -> None:
        _, digest = self.release("a")
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
        journal.mkdir()
        trust.write_text("trusted-root-evidence", encoding="utf-8")
        (journal / "reserved.json").write_text("replay-state", encoding="utf-8")
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
        ready = self.root / "ready"
        code = "import fcntl, pathlib, sys, time; p=pathlib.Path(sys.argv[1]); fd=open(p,'a+'); fcntl.flock(fd, fcntl.LOCK_EX); p.with_name('ready').write_text('ready'); time.sleep(.35); fcntl.flock(fd, fcntl.LOCK_UN); fd.close()"
        process = subprocess.Popen([sys.executable, "-c", code, str(self.publication / retention.LOCK_FILENAME)])
        try:
            for _ in range(100):
                if ready.exists():
                    break
                time.sleep(.01)
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
        trust = self.root / "trust"
        trust.mkdir()
        journal = self.root / "journal"
        journal.mkdir()
        legacy = self.root / "legacy"
        legacy.mkdir()
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
