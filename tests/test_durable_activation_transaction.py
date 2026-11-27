from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


retention = load("activation_retention_test", "durable_artifact_retention.py")
provenance = load("activation_provenance_test", "runtime_artifact_provenance.py")
activation = load("activation_transaction_test", "durable_activation_transaction.py")


class DurableActivationTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.repo = root / "checkout"
        self.repo.mkdir(mode=0o700)
        self.publication = root / "publication"
        self.publication.mkdir(mode=0o700)
        self.prepared = root / "prepared"
        self.prepared.mkdir(mode=0o700)
        self.store = retention.RetentionStore(self.publication, repository_root=self.repo, require_durable=False)
        self.store.initialize()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def candidate(self, token: str) -> tuple[dict[str, object], str]:
        source = hashlib.sha256((token + ":source").encode()).hexdigest()[:40]
        producer = hashlib.sha256((token + ":producer").encode()).hexdigest()[:40]
        signer = hashlib.sha256((token + ":signer").encode()).hexdigest()[:40]
        identity: dict[str, object] = {
            "repository": provenance.RELEASE_REPOSITORY,
            "repository_id": provenance.RELEASE_REPOSITORY_ID,
            "repository_owner_id": provenance.RELEASE_REPOSITORY_OWNER_ID,
            "source_ref": provenance.RELEASE_SOURCE_REF,
            "source_sha": source,
            "event": "push",
            "producer_workflow": provenance.RELEASE_PRODUCER_WORKFLOW,
            "producer_revision": producer,
            "signer_workflow": provenance.RELEASE_SIGNER_WORKFLOW,
            "signer_revision": signer,
            "run_id": 1,
            "run_attempt": 1,
            "artifact_id": 1,
            "artifact_name": "runtime-artifact-1-1",
            "artifact_class": provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS,
            "artifact_service_zip_sha256": "1" * 64,
            "artifact_service_zip_bytes": 1,
            "archive_name": f"clashcookies-runtime-{source}.tar.gz",
            "archive_sha256": "2" * 64,
            "archive_bytes": 1,
            "platform": provenance.RELEASE_PLATFORM,
            "image": provenance.RELEASE_IMAGE,
            "image_digest": provenance.RELEASE_IMAGE.split("@", 1)[1],
            "authorization_context": provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT,
        }
        digest = retention.identity_digest(identity)
        evidence = {name: {"sha256": hashlib.sha256(name.encode()).hexdigest(), "bytes": 1} for name in ("artifact-service.zip", "attestation-bundle.json", "authorization-envelope.json", "independent-verification-context.json", "verification-expectation.json", "verification-receipt.json", "trusted-root.jsonl")}
        state = self.store.load()
        retention.RetentionStore._record(state, identity, f"release-{digest}", evidence, ["pending", "reserved"])
        self.store._save(state)
        self.store.mark_operation(f"prepare-{digest}", digest, kind="immutable-runtime-preparation", phase="admission-approved")
        self.store.update_operation(f"prepare-{digest}", phase="completed", metadata_sha256="a" * 64)
        return identity, digest

    def test_exact_transaction_commits_pointers_only_after_health_evidence(self) -> None:
        _, candidate = self.candidate("first")
        operation = self.store.begin_activation(operation_id="activate-first", retry_key="retry-first", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-first", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=self.store.load()["pointer_generation"])
        self.assertEqual(operation["phase"], "validated-intent")
        self.assertIn("recovery-protected", self.store.load()["releases"][candidate]["roles"])
        self.store.transition_activation("activate-first", phase="authorization-consumption-pending")
        self.store.transition_activation("activate-first", phase="authorization-consumed")
        self.store.transition_activation("activate-first", phase="incumbent-stop-intent")
        for phase, outcome in (("incumbent-stop-observed", "stopped"), ("candidate-start-observed", "started"), ("candidate-health-verified", "healthy")):
            previous = self.store.load()["activation_operations"]["activate-first"]["phase"]
            next_phase = "candidate-start-intent" if phase == "candidate-start-observed" else phase
            if phase == "candidate-start-observed":
                self.store.transition_activation("activate-first", phase="candidate-start-intent")
            self.store.transition_activation("activate-first", phase=phase, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": phase, "outcome": outcome, "details": {}})
        self.assertEqual(self.store.load()["active_release"], None)
        self.store.transition_activation("activate-first", phase="successful-activation")
        state = self.store.load()
        self.assertEqual(state["active_release"], candidate)
        self.assertEqual(state["previous_known_good_release"], retention.LEGACY_BASELINE_ID)
        self.assertEqual(state["releases"][candidate]["roles"], [])
        self.assertEqual(state["activation_operations"]["activate-first"]["phase"], "successful-activation")

    def test_competing_and_stale_transactions_fail_closed(self) -> None:
        _, first = self.candidate("competing")
        pointer_generation = self.store.load()["pointer_generation"]
        with self.assertRaisesRegex(retention.RetentionError, "stale"):
            self.store.begin_activation(operation_id="activate-stale", retry_key="retry-stale", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="d" * 64, authorization_id="auth-stale", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation + 1)
        self.store.begin_activation(operation_id="activate-one", retry_key="retry-one", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-one", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation)
        with self.assertRaisesRegex(retention.RetentionError, "another activation transaction"):
            self.store.begin_activation(operation_id="activate-two", retry_key="retry-two", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="c" * 64, authorization_id="auth-two", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation)

    def test_illegal_phase_and_ambiguous_health_do_not_change_pointers(self) -> None:
        _, candidate = self.candidate("phase")
        self.store.begin_activation(operation_id="activate-phase", retry_key="retry-phase", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-phase", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=0)
        with self.assertRaisesRegex(retention.RetentionError, "illegal activation phase"):
            self.store.transition_activation("activate-phase", phase="candidate-health-verified", observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "candidate-health-verified", "outcome": "healthy", "details": {}})
        before = self.store.load()["active_release"]
        self.assertIsNone(before)


if __name__ == "__main__":
    unittest.main()
