from __future__ import annotations

import hashlib
import importlib.util
import json
from datetime import datetime, timedelta, timezone
import os
import shutil
import subprocess
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
        release_dir = self.publication / f"release-{digest}"
        release_dir.mkdir(mode=0o700)
        for name in evidence:
            path = release_dir / name
            path.write_bytes(b"fixture\n")
            path.chmod(0o600)
        (release_dir / "identity.json").write_bytes(provenance._canonical_json(identity) + b"\n")
        retention.RetentionStore._record(state, identity, f"release-{digest}", evidence, ["prepared"])
        self.store._save(state)
        self.store.mark_operation(f"prepare-{digest}", digest, kind="immutable-runtime-preparation", phase="admission-approved")
        self.store.update_operation(f"prepare-{digest}", phase="completed", metadata_sha256="a" * 64)
        return identity, digest

    @staticmethod
    def proof(operation_id: str, candidate: str, *, record: str, authorization_id: str, retry_key: str, scope: str, generation: int, state: str) -> dict[str, object]:
        return {"operation_id": operation_id, "candidate_release": candidate, "preparation_metadata_sha256": "a" * 64, "record_sha256": record, "authorization_id": authorization_id, "retry_key": retry_key, "scope": scope, "state": state, "pointer_generation": generation, "observed_at": "2026-11-26T00:00:00Z"}

    def signed_activation(self, identity: dict[str, object], *, journal_root: Path, authorization_id: str) -> tuple[dict[str, object], provenance.AuthorizationTrustConfig, provenance.AuthorizationRevisionAllowlist, provenance.AuthorizationReplayJournal, provenance.IndependentReleaseAuthorization]:
        openssl = shutil.which("openssl")
        self.assertIsNotNone(openssl)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        record = provenance.prepare_owner_authorization_record(provenance.TrustedReleaseIdentity(**identity), authorization_id=authorization_id, issued_at=(now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"), expires_at=(now + timedelta(hours=23, minutes=59)).isoformat().replace("+00:00", "Z"), signing_key_id="activation-test-key", scope="activation-forward", verification_context_sha256="3" * 64)
        material = Path(self.temp.name) / f"signing-{authorization_id}"
        material.mkdir(mode=0o700)
        private_key, public_key, record_path, signature_path, der_path = (material / name for name in ("private.pem", "public.pem", "record.json", "record.sig", "public.der"))
        subprocess.run([openssl, "genpkey", "-algorithm", "ED25519", "-out", str(private_key)], check=True, capture_output=True)
        subprocess.run([openssl, "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)], check=True, capture_output=True)
        public_key.chmod(0o600)
        record_path.write_bytes(provenance._canonical_json(record))
        subprocess.run([openssl, "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(record_path), "-out", str(signature_path)], check=True, capture_output=True)
        subprocess.run([openssl, "pkey", "-pubin", "-in", str(public_key), "-outform", "DER", "-out", str(der_path)], check=True, capture_output=True)
        trust = provenance.AuthorizationTrustConfig(public_key, "activation-test-key", hashlib.sha256(der_path.read_bytes()).hexdigest(), self.repo)
        allowlist = provenance.AuthorizationRevisionAllowlist(identity["producer_workflow"], (identity["producer_revision"],), identity["signer_workflow"], (identity["signer_revision"],))
        envelope = provenance.assemble_owner_authorization_envelope(record, signature_path.read_bytes(), "activation-test-key")
        journal_root.mkdir(mode=0o700)
        journal = provenance.AuthorizationReplayJournal(journal_root, repository_root=self.repo, development_mode=(os.name == "nt"))
        verified = provenance.verify_signed_authorization_record(envelope, trust, provenance.TrustedReleaseIdentity(**identity), allowlist, now=now)
        journal.reserve(envelope, provenance.TrustedReleaseIdentity(**identity), allowlist, trust, operation="activation-forward", now=now)
        return envelope, trust, allowlist, journal, verified

    def test_exact_transaction_commits_pointers_only_after_health_evidence(self) -> None:
        _, candidate = self.candidate("first")
        generation = self.store.load()["pointer_generation"]
        reserved = self.proof("activate-first", candidate, record="b" * 64, authorization_id="auth-first", retry_key="retry-first", scope="activation-forward", generation=generation, state="reserved")
        consumed = {**reserved, "state": "consumed"}
        operation = self.store.begin_activation(operation_id="activate-first", retry_key="retry-first", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-first", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=generation, authority_proof=reserved)
        self.assertEqual(operation["phase"], "validated-intent")
        self.assertIn("recovery-protected", self.store.load()["releases"][candidate]["roles"])
        self.store.transition_activation("activate-first", phase="authorization-consumption-pending", authority_proof=reserved)
        self.store.transition_activation("activate-first", phase="authorization-consumed", authority_proof=consumed)
        self.store.transition_activation("activate-first", phase="incumbent-stop-intent", authority_proof=consumed)
        for phase, outcome in (("incumbent-stop-observed", "stopped"), ("candidate-start-observed", "started"), ("candidate-health-verified", "healthy")):
            next_phase = "candidate-start-intent" if phase == "candidate-start-observed" else phase
            if phase == "candidate-start-observed":
                self.store.transition_activation("activate-first", phase="incumbent-stop-observed", authority_proof=consumed, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "incumbent-stop-observed", "outcome": "stopped", "operation_id": "activate-first", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}})
                self.store.transition_activation("activate-first", phase="candidate-start-intent", authority_proof=consumed)
            observation = {"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": phase, "outcome": outcome, "operation_id": "activate-first", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}}
            self.store.transition_activation("activate-first", phase=phase, authority_proof=consumed, observation=observation)
        self.assertEqual(self.store.load()["active_release"], None)
        self.store.transition_activation("activate-first", phase="successful-activation", authority_proof=consumed)
        state = self.store.load()
        self.assertEqual(state["active_release"], candidate)
        self.assertEqual(state["previous_known_good_release"], retention.LEGACY_BASELINE_ID)
        self.assertEqual(state["releases"][candidate]["roles"], [])
        self.assertEqual(state["activation_operations"]["activate-first"]["phase"], "successful-activation")

    def test_competing_and_stale_transactions_fail_closed(self) -> None:
        _, first = self.candidate("competing")
        pointer_generation = self.store.load()["pointer_generation"]
        stale = self.proof("activate-stale", first, record="d" * 64, authorization_id="auth-stale", retry_key="retry-stale", scope="activation-forward", generation=pointer_generation + 1, state="reserved")
        with self.assertRaisesRegex(retention.RetentionError, "stale"):
            self.store.begin_activation(operation_id="activate-stale", retry_key="retry-stale", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="d" * 64, authorization_id="auth-stale", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation + 1, authority_proof=stale)
        proof = self.proof("activate-one", first, record="b" * 64, authorization_id="auth-one", retry_key="retry-one", scope="activation-forward", generation=pointer_generation, state="reserved")
        self.store.begin_activation(operation_id="activate-one", retry_key="retry-one", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-one", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation, authority_proof=proof)
        with self.assertRaisesRegex(retention.RetentionError, "another activation transaction"):
            self.store.begin_activation(operation_id="activate-two", retry_key="retry-two", candidate_release=first, preparation_metadata_sha256="a" * 64, authorization_record_sha256="c" * 64, authorization_id="auth-two", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=pointer_generation, authority_proof={**proof, "operation_id": "activate-two", "record_sha256": "c" * 64, "authorization_id": "auth-two", "retry_key": "retry-two"})

    def test_illegal_phase_and_ambiguous_health_do_not_change_pointers(self) -> None:
        _, candidate = self.candidate("phase")
        proof = self.proof("activate-phase", candidate, record="b" * 64, authorization_id="auth-phase", retry_key="retry-phase", scope="activation-forward", generation=0, state="reserved")
        self.store.begin_activation(operation_id="activate-phase", retry_key="retry-phase", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-phase", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=0, authority_proof=proof)
        with self.assertRaisesRegex(retention.RetentionError, "illegal activation phase"):
            self.store.transition_activation("activate-phase", phase="candidate-health-verified", authority_proof={**proof, "state": "consumed"}, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "candidate-health-verified", "outcome": "healthy", "operation_id": "activate-phase", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}})
        before = self.store.load()["active_release"]
        self.assertIsNone(before)

    @unittest.skipUnless(shutil.which("openssl"), "OpenSSL Ed25519 regression requires OpenSSL")
    def test_signed_replay_consumption_is_required_by_the_real_transaction_boundary(self) -> None:
        identity, candidate = self.candidate("signed")
        envelope, trust, allowlist, journal, authorization = self.signed_activation(identity, journal_root=Path(self.temp.name) / "activation-journal", authorization_id="activation-signed")
        generation = self.store.load()["pointer_generation"]
        proof = {"operation_id": "activate-signed", "candidate_release": candidate, "preparation_metadata_sha256": "a" * 64, "record_sha256": authorization.verification.record_sha256, "authorization_id": authorization.authorization_id, "retry_key": authorization.retry_key, "scope": authorization.scope, "state": "reserved", "pointer_generation": generation, "observed_at": "2026-11-26T00:00:00Z"}
        self.store.begin_activation(operation_id="activate-signed", retry_key=authorization.retry_key, candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256=authorization.verification.record_sha256, authorization_id=authorization.authorization_id, authorization_scope=authorization.scope, rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=generation, authority_proof=proof)
        with self.assertRaisesRegex(retention.RetentionError, "state"):
            self.store.transition_activation("activate-signed", phase="authorization-consumed", authority_proof=proof)
        journal.consume(envelope, provenance.TrustedReleaseIdentity(**identity), allowlist, trust, operation="activation-forward")
        consumed = {**proof, "state": "consumed"}
        self.store.transition_activation("activate-signed", phase="authorization-consumption-pending", authority_proof=proof)
        operation = self.store.transition_activation("activate-signed", phase="authorization-consumed", authority_proof=consumed)
        self.assertEqual(operation["forward_consumption"]["record_sha256"], authorization.verification.record_sha256)
        self.assertEqual(journal.inspect(envelope, provenance.TrustedReleaseIdentity(**identity), allowlist, trust, operation="activation-forward", allow_consumed=True)["state"], "consumed")
        journal.close()

    def test_failed_candidate_uses_separate_compensation_and_preserves_incumbent(self) -> None:
        _, candidate = self.candidate("compensation")
        generation = self.store.load()["pointer_generation"]
        forward = self.proof("activate-compensation", candidate, record="b" * 64, authorization_id="auth-forward", retry_key="retry-forward", scope="activation-forward", generation=generation, state="reserved")
        consumed = {**forward, "state": "consumed"}
        self.store.begin_activation(operation_id="activate-compensation", retry_key="retry-forward", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256="b" * 64, authorization_id="auth-forward", authorization_scope="activation-forward", rollback_target=retention.LEGACY_BASELINE_ID, expected_pointer_generation=generation, authority_proof=forward)
        self.store.transition_activation("activate-compensation", phase="authorization-consumption-pending", authority_proof=forward)
        self.store.transition_activation("activate-compensation", phase="authorization-consumed", authority_proof=consumed)
        self.store.transition_activation("activate-compensation", phase="incumbent-stop-intent", authority_proof=consumed)
        self.store.transition_activation("activate-compensation", phase="incumbent-stop-observed", authority_proof=consumed, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "incumbent-stop-observed", "outcome": "stopped", "operation_id": "activate-compensation", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}})
        self.store.transition_activation("activate-compensation", phase="candidate-start-intent", authority_proof=consumed)
        self.store.transition_activation("activate-compensation", phase="candidate-start-observed", authority_proof=consumed, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "candidate-start-observed", "outcome": "failed", "operation_id": "activate-compensation", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}})
        recovery = self.proof("activate-compensation", candidate, record="c" * 64, authorization_id="auth-recovery", retry_key="retry-recovery", scope="activation-recovery", generation=generation, state="reserved")
        self.store.start_activation_rollback("activate-compensation", authorization_record_sha256="c" * 64, authorization_id="auth-recovery", retry_key="retry-recovery", rollback_kind="compensation", authority_proof=recovery)
        self.store.transition_activation("activate-compensation", phase="rollback-intent", authority_proof={**recovery, "state": "consumed"})
        self.store.transition_activation("activate-compensation", phase="rollback-observed", authority_proof={**recovery, "state": "consumed"}, observation={"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": "rollback-observed", "outcome": "healthy", "operation_id": "activate-compensation", "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}})
        self.store.transition_activation("activate-compensation", phase="successful-rollback", authority_proof={**recovery, "state": "consumed"})
        state = self.store.load()
        self.assertIsNone(state["active_release"])
        self.assertEqual(state["previous_known_good_release"], retention.LEGACY_BASELINE_ID)
        self.assertIn("prepared", state["releases"][candidate]["roles"])

    def test_three_successive_activations_rotate_known_good_and_retire_history(self) -> None:
        activated: list[str] = []
        for index in range(3):
            _, candidate = self.candidate(f"successive-{index}")
            activated.append(candidate)
            operation_id = f"activate-successive-{index}"
            generation = self.store.load()["pointer_generation"]
            record = f"{index + 4:x}" * 64
            forward = self.proof(operation_id, candidate, record=record, authorization_id=f"auth-{index}", retry_key=f"retry-{index}", scope="activation-forward", generation=generation, state="reserved")
            consumed = {**forward, "state": "consumed"}
            target = self.store.load()["active_release"] or retention.LEGACY_BASELINE_ID
            self.store.begin_activation(operation_id=operation_id, retry_key=f"retry-{index}", candidate_release=candidate, preparation_metadata_sha256="a" * 64, authorization_record_sha256=record, authorization_id=f"auth-{index}", authorization_scope="activation-forward", rollback_target=target, expected_pointer_generation=generation, authority_proof=forward)
            self.store.transition_activation(operation_id, phase="authorization-consumption-pending", authority_proof=forward)
            self.store.transition_activation(operation_id, phase="authorization-consumed", authority_proof=consumed)
            self.store.transition_activation(operation_id, phase="incumbent-stop-intent", authority_proof=consumed)
            for phase, outcome in (("incumbent-stop-observed", "stopped"), ("candidate-start-observed", "started"), ("candidate-health-verified", "healthy")):
                if phase == "candidate-start-observed":
                    self.store.transition_activation(operation_id, phase="candidate-start-intent", authority_proof=consumed)
                observation = {"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": phase, "outcome": outcome, "operation_id": operation_id, "candidate_release": candidate, "runtime_identity_sha256": candidate, "details": {}}
                self.store.transition_activation(operation_id, phase=phase, authority_proof=consumed, observation=observation)
            self.store.transition_activation(operation_id, phase="successful-activation", authority_proof=consumed)
        state = self.store.load()
        self.assertEqual(state["active_release"], activated[-1])
        self.assertEqual(state["previous_known_good_release"], activated[-2])
        self.assertEqual(state["releases"][activated[0]]["roles"], ["retired"])
        self.assertEqual(len(state["activation_operations"]), 3)


if __name__ == "__main__":
    unittest.main()
