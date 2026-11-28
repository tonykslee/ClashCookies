from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from collections.abc import Callable
from pathlib import Path
import shutil
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


import durable_artifact_retention as retention
import runtime_artifact_provenance as provenance
import immutable_runtime_preparation as preparation
import durable_activation_transaction as activation


_DELIVERY_SPEC = importlib.util.spec_from_file_location("activation_integration_delivery_tests", ROOT / "tests" / "test_trusted_ssh_artifact_delivery.py")
assert _DELIVERY_SPEC and _DELIVERY_SPEC.loader
DELIVERY_TESTS = importlib.util.module_from_spec(_DELIVERY_SPEC)
sys.modules[_DELIVERY_SPEC.name] = DELIVERY_TESTS
_DELIVERY_SPEC.loader.exec_module(DELIVERY_TESTS)


def _stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _phase_selective_retention_fsync_fault(
    real_fsync_directory: Callable[..., None],
    retention_root: Path,
    state_path: Path,
    operation_id: str,
) -> tuple[Callable[..., None], dict[str, object]]:
    """Inject one directory-fsync failure only after the target phase is published."""
    observed_phases: list[str] = []
    delegated_calls: list[tuple[Path, bool]] = []
    state: dict[str, object] = {
        "fault_triggered": 0,
        "observed_phases": observed_phases,
        "delegated_calls": delegated_calls,
    }
    expected_root = retention_root.resolve()

    def phase_selective_fsync(path: Path, *, required: bool = True) -> None:
        if Path(path).resolve() == expected_root and state_path.exists():
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            operations = persisted.get("activation_operations")
            operation = operations.get(operation_id) if isinstance(operations, dict) else None
            phase = operation.get("phase") if isinstance(operation, dict) else None
            if isinstance(phase, str):
                observed_phases.append(phase)
                if phase == "authorization-consumed" and not state["fault_triggered"]:
                    state["fault_triggered"] = int(state["fault_triggered"]) + 1
                    raise retention.RetentionError("authorization-consumed rename-before-directory-fsync")
        real_fsync_directory(path, required=required)
        delegated_calls.append((Path(path), required))

    return phase_selective_fsync, state


def _sign_record(root: Path, record: dict[str, object], key_id: str, *, repository_root: Path) -> tuple[dict[str, object], provenance.AuthorizationTrustConfig]:
    private_key = root / f"{key_id}-private.pem"
    public_key = root / f"{key_id}-public.pem"
    record_path = root / f"{key_id}-record.json"
    signature_path = root / f"{key_id}-record.sig"
    der_path = root / f"{key_id}-public.der"
    if not private_key.exists():
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private_key)], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(private_key), "-pubout", "-out", str(public_key)], check=True, capture_output=True)
        public_key.chmod(0o600)
    record_path.write_bytes(provenance._canonical_json(record))
    subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-in", str(record_path), "-out", str(signature_path)], check=True, capture_output=True)
    subprocess.run(["openssl", "pkey", "-pubin", "-in", str(public_key), "-outform", "DER", "-out", str(der_path)], check=True, capture_output=True)
    trust = provenance.AuthorizationTrustConfig(public_key, key_id, hashlib.sha256(der_path.read_bytes()).hexdigest(), repository_root)
    return provenance.assemble_owner_authorization_envelope(record, signature_path.read_bytes(), key_id), trust


def _attestation_result(identity: provenance.TrustedReleaseIdentity, expectation: dict[str, object], verified_at: datetime) -> dict[str, object]:
    repository_uri = f"https://github.com/{identity.repository}"
    owner_uri = f"https://github.com/{identity.repository.split('/', 1)[0]}"
    workflow_uri = f"{repository_uri}/{identity.signer_workflow}"
    run_uri = f"{repository_uri}/actions/runs/{identity.run_id}/attempts/{identity.run_attempt}"
    return {"verificationResult": {
        "mediaType": "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        "statement": {
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": provenance.SLSA_PROVENANCE_V1,
            "subject": [{"name": identity.archive_name, "digest": {"sha256": identity.archive_sha256}}],
            "predicate": {
                "buildDefinition": {
                    "buildType": provenance.ACTIONS_WORKFLOW_BUILD_TYPE,
                    "externalParameters": {"workflow": {"path": identity.signer_workflow, "ref": identity.source_ref, "repository": repository_uri}},
                    "internalParameters": {"github": {"event_name": identity.event, "repository_id": identity.repository_id, "repository_owner_id": identity.repository_owner_id, "runner_environment": provenance.GITHUB_HOSTED_RUNNER}},
                    "resolvedDependencies": [{"uri": f"git+{repository_uri}@{identity.source_ref}", "digest": {"gitCommit": identity.source_sha}}],
                },
                "runDetails": {"builder": {"id": f"{workflow_uri}@{identity.source_ref}"}, "metadata": {"invocationId": run_uri}},
            },
        },
        "signature": {"certificate": {
            "certificateIssuer": "CN=sigstore-intermediate,O=sigstore.dev",
            "sourceRepositoryURI": repository_uri,
            "sourceRepositoryIdentifier": str(identity.repository_id),
            "sourceRepositoryOwnerIdentifier": str(identity.repository_owner_id),
            "sourceRepositoryOwnerURI": owner_uri,
            "sourceRepositoryRef": identity.source_ref,
            "sourceRepositoryDigest": identity.source_sha,
            "githubWorkflowTrigger": identity.event,
            "githubWorkflowSHA": identity.signer_revision,
            "githubWorkflowName": expectation["workflow_name"],
            "githubWorkflowRepository": identity.repository,
            "githubWorkflowRef": identity.source_ref,
            "buildTrigger": identity.event,
            "buildSignerURI": f"{workflow_uri}@{identity.source_ref}",
            "buildSignerDigest": identity.signer_revision,
            "buildConfigURI": f"{workflow_uri}@{identity.source_ref}",
            "buildConfigDigest": identity.signer_revision,
            "runInvocationURI": run_uri,
            "runnerEnvironment": provenance.GITHUB_HOSTED_RUNNER,
            "issuer": provenance.GITHUB_OIDC_ISSUER,
            "sourceRepositoryVisibilityAtSigning": expectation["repository_visibility"],
            "subjectAlternativeName": f"{workflow_uri}@{identity.source_ref}",
        }},
        "verifiedTimestamps": [_stamp(verified_at)],
    }, "_verifierVersion": provenance.SUPPORTED_GH_VERSION}


class PhaseSelectiveRetentionFsyncTests(unittest.TestCase):
    def test_phase_selective_retention_fsync_fault_only_interrupts_target_phase(self) -> None:
        with TemporaryDirectory() as directory_name:
            retention_root = Path(directory_name) / "publication"
            retention_root.mkdir()
            other_root = Path(directory_name) / "other"
            other_root.mkdir()
            state_path = retention_root / retention.STATE_FILENAME
            operation_id = "phase-selective-test"
            state_path.write_text(json.dumps({"activation_operations": {operation_id: {"phase": "authorization-consumption-pending"}}}), encoding="utf-8")

            def real_fsync_directory(path: Path, *, required: bool = True) -> None:
                return None

            fault, state = _phase_selective_retention_fsync_fault(real_fsync_directory, retention_root, state_path, operation_id)
            fault(retention_root, required=True)
            fault(other_root, required=True)
            self.assertEqual(state["fault_triggered"], 0)
            self.assertEqual(state["observed_phases"], ["authorization-consumption-pending"])
            self.assertEqual(len(state["delegated_calls"]), 2)

            state_path.write_text(json.dumps({"activation_operations": {"other-operation": {"phase": "authorization-consumed"}}}), encoding="utf-8")
            fault(retention_root, required=True)
            self.assertEqual(state["fault_triggered"], 0)
            self.assertEqual(len(state["delegated_calls"]), 3)

            state_path.write_text(json.dumps({"activation_operations": {operation_id: {"phase": "authorization-consumed"}}}), encoding="utf-8")
            with self.assertRaisesRegex(retention.RetentionError, "^authorization-consumed rename-before-directory-fsync$"):
                fault(retention_root, required=True)
            self.assertEqual(state["fault_triggered"], 1)
            self.assertEqual(len(state["delegated_calls"]), 3)

            # The callback is one-shot; subsequent calls still delegate and do
            # not create a second simulated interruption.
            fault(retention_root, required=True)
            self.assertEqual(state["fault_triggered"], 1)
            self.assertEqual(len(state["delegated_calls"]), 4)


class DurableActivationIntegrationTests(unittest.TestCase):
    """Real coordinator integration; Linux CI is authoritative.

    Ed25519 authorization, replay journals, retained archives, preparation
    material, retention publication, locks, and process boundaries are real.
    The GitHub attestation verifier is intentionally a synthetic seam here;
    the separate runtime-artifact workflow remains the evidence for genuine
    GitHub-native attestation verification.
    """

    @classmethod
    def setUpClass(cls) -> None:
        if os.name != "posix" or os.environ.get("CC_REAL_RECEIVER") != "1":
            raise unittest.SkipTest("real activation integration requires the mandatory Linux 3b/3c fixture")
        if shutil.which("openssl") is None:
            raise unittest.SkipTest("OpenSSL Ed25519 is required")

    def _fixture(self, root: Path, *, candidate_nonce: str = "default") -> dict[str, object]:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        checkout = root / "checkout"
        publication = root / "publication"
        prepared = root / "prepared"
        receiving = root / "receiving"
        delivery_journal_root = root / "delivery-journal"
        activation_journal_root = root / "activation-journal"
        custody = root / "custody"
        legacy_root = root / "legacy-runtime"
        for path in (checkout, publication, prepared, receiving, delivery_journal_root, activation_journal_root, custody, legacy_root):
            path.mkdir(mode=0o700)
        source_zip = Path(os.environ["CC_RECEIVER_SERVICE_ZIP"])
        source_identity = provenance.TrustedReleaseIdentity(**json.loads(Path(os.environ["CC_RECEIVER_EXPECTED_IDENTITY"]).read_text(encoding="utf-8")))
        candidate_source = root / "candidate-source"
        candidate_source.mkdir(mode=0o700)
        candidate = DELIVERY_TESTS.build_candidate_validator_fixture(candidate_source, source_zip, source_identity, candidate_nonce=candidate_nonce)
        identity = candidate["identity"]
        assert isinstance(identity, provenance.TrustedReleaseIdentity)
        candidate["service_zip"].chmod(0o600)
        validation_workspace = root / "archive-validation"
        validation_workspace.mkdir(mode=0o700)
        archive_validation = provenance.validate_candidate_archive_contents(candidate["service_zip"], identity, candidate["context"], workspace=validation_workspace)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        context, context_digest = provenance.independent_candidate_verification_context(DELIVERY_TESTS.retained_candidate_context(identity, archive_validation, now - timedelta(minutes=5)), identity)
        context_path = custody / "independent-verification-context.json"
        context_path.write_bytes(provenance._canonical_json(context) + b"\n")
        context_path.chmod(0o600)

        trusted_root = custody / "trusted-root.jsonl"
        trusted_root.write_text("integration trusted root\n", encoding="utf-8")
        trusted_root.chmod(0o600)
        trusted_root_digest, trusted_root_bytes = provenance._sha256_file(trusted_root, provenance.MAX_BUNDLE_BYTES, "integration trusted root")
        expectation = {
            "contract": "clashcookies.retained-verification-expectation", "version": 1,
            "identity_sha256": retention.identity_digest(identity.__dict__), "repository": identity.repository,
            "repository_id": str(identity.repository_id), "repository_owner_id": str(identity.repository_owner_id),
            "source_ref": identity.source_ref, "source_sha": identity.source_sha, "event": identity.event,
            "producer_workflow": identity.producer_workflow, "producer_revision": identity.producer_revision,
            "signer_workflow": identity.signer_workflow, "signer_revision": identity.signer_revision,
            "workflow_name": DELIVERY_TESTS.CANDIDATE_WORKFLOW_DISPLAY_NAME, "repository_visibility": "public",
            "run_id": identity.run_id, "run_attempt": identity.run_attempt, "artifact_class": identity.artifact_class,
            "platform": identity.platform, "image": identity.image, "image_digest": identity.image_digest,
            "archive_name": identity.archive_name, "archive_sha256": identity.archive_sha256, "archive_bytes": identity.archive_bytes,
            "trusted_root_sha256": trusted_root_digest, "trusted_root_bytes": trusted_root_bytes,
            "trusted_root_version": trusted_root_digest[:16], "verifier_version": provenance.SUPPORTED_GH_VERSION,
        }
        verifier_output = _attestation_result(identity, expectation, now)
        authenticated = provenance.validate_verified_result(verifier_output, archive_name=identity.archive_name, archive_digest=identity.archive_sha256, archive_bytes=identity.archive_bytes, expected=expectation, run_metadata=None, require_run_metadata=False)
        verifier_output_path = custody / "verifier-output.json"
        verifier_output_path.write_bytes(provenance._canonical_json(verifier_output) + b"\n")
        gh_wrapper = custody / "gh-integration-wrapper"
        gh_wrapper.write_text(
            '#!/bin/sh\n'
            'if [ "$1" = version ]; then echo "gh version 2.89.0"; '
            'else printf "[%s]\\n" "$(cat "$CC_SYNTHETIC_VERIFIER_OUTPUT")"; fi\n',
            encoding="utf-8",
        )
        gh_wrapper.chmod(0o700)

        allowlist_path = custody / "revision-allowlist.json"
        allowlist_path.write_bytes(provenance._canonical_json({"producer_workflow": identity.producer_workflow, "producer_revisions": [identity.producer_revision], "signer_workflow": identity.signer_workflow, "signer_revisions": [identity.signer_revision]}) + b"\n")
        allowlist_path.chmod(0o600)
        allowlist = provenance.AuthorizationRevisionAllowlist(identity.producer_workflow, (identity.producer_revision,), identity.signer_workflow, (identity.signer_revision,))
        delivery_record = provenance.prepare_owner_authorization_record(identity, authorization_id="integration-delivery", issued_at=_stamp(now - timedelta(minutes=4)), expires_at=_stamp(now + timedelta(hours=23, minutes=56)), signing_key_id="integration-key", verification_context_sha256=context_digest, delivery_destination=str(publication), verification_completed_at=context["verificationCompletedAt"])
        delivery_envelope, trust = _sign_record(custody, delivery_record, "integration-key", repository_root=checkout)
        delivery_journal = provenance.AuthorizationReplayJournal(delivery_journal_root, repository_root=checkout)
        bundle = custody / "attestation-bundle.json"
        bundle.write_text("{\"integration\":true}\n", encoding="utf-8")
        bundle.chmod(0o600)
        DELIVERY_TESTS.delivery.publish_synthetic_authorized_delivery_for_test(service_zip=candidate["service_zip"], expected_identity=identity, authorization_envelope=delivery_envelope, trust=trust, revision_allowlist=allowlist, journal=delivery_journal, repository_root=checkout, receiving_root=receiving, publication_root=publication, now=now, attestation_bundle=bundle, candidate_verification_context=context_path, verification_expectation=expectation, verification_receipt=authenticated.diagnostic_json(), trusted_root=trusted_root, trusted_root_expected=(trusted_root_digest, trusted_root_bytes))

        store = retention.RetentionStore(publication, repository_root=checkout, require_durable=True)
        prepared_candidate = prepared / f"candidate-{retention.identity_digest(identity.__dict__)}"
        prepared_candidate.mkdir(mode=0o700)
        shutil.copytree(validation_workspace / "extracted-runtime", prepared_candidate / "runtime", symlinks=True)
        legacy_runtime = legacy_root / "runtime"
        legacy_runtime.mkdir(mode=0o700)
        (legacy_runtime / "legacy.txt").write_text("legacy\n", encoding="utf-8")
        legacy_integrity = preparation._integrity(legacy_runtime, maximum_bytes=preparation.MAX_LEGACY_BYTES, maximum_entries=preparation.MAX_LEGACY_ENTRIES)
        store.register_legacy_baseline({"contract": "clashcookies.legacy-runtime-baseline", "version": 1, "id": retention.LEGACY_BASELINE_ID, "authenticated": False, "protected": True, "status": "preserved-verified", "runtime_path": str(legacy_runtime), "integrity": legacy_integrity, "identity": {"fixture": "real-activation-integration"}})
        candidate_integrity = preparation._integrity(prepared_candidate / "runtime")
        metadata = {"contract": preparation.PREPARATION_CONTRACT, "version": preparation.PREPARATION_VERSION, "status": "prepared-not-activated", "candidate": {"identity_sha256": retention.identity_digest(identity.__dict__), "identity": identity.__dict__, "runtime_integrity": candidate_integrity, "runtime_layout": "runtime", "runtime_path": str(prepared_candidate / "runtime"), "image": identity.image, "image_digest": identity.image_digest, "platform": identity.platform, "archive_validation": archive_validation}, "legacy": {"status": "preserved-verified", "authenticated": False, "baseline_id": retention.LEGACY_BASELINE_ID, "runtime_layout": "legacy-runtime-baseline", "identity": {"fixture": "real-activation-integration"}, "integrity": legacy_integrity, "runtime_path": str(legacy_runtime)}, "retention": {"publication": str(publication / f"release-{retention.identity_digest(identity.__dict__)}"), "operation_id": f"prepare-{retention.identity_digest(identity.__dict__)}", "registered": True, "active_pointer_changed": False, "previous_pointer_changed": False}, "recovery": {"state": "none", "protected": True}, "resource_measurements": {"fixture": "real-activation-integration"}}
        metadata_path = prepared_candidate / "preparation.json"
        metadata_path.write_bytes(preparation._canonical(metadata) + b"\n")
        metadata_path.chmod(0o600)
        metadata_digest = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
        identity_digest = retention.identity_digest(identity.__dict__)
        store.mark_operation(f"prepare-{identity_digest}", identity_digest, kind="immutable-runtime-preparation", phase="admission-approved")
        store.update_operation(f"prepare-{identity_digest}", phase="completed", metadata_sha256=metadata_digest)
        activation_journal = provenance.AuthorizationReplayJournal(activation_journal_root, repository_root=checkout)
        deployment_lock = root / "fb027-deploy.lock.flock"
        os.environ["DEPLOY_LOCK_FILE"] = str(deployment_lock)
        return {"root": root, "checkout": checkout, "publication": publication, "prepared": prepared, "custody": custody, "trusted_root": trusted_root, "allowlist_path": allowlist_path, "allowlist": allowlist, "trust": trust, "delivery_envelope": delivery_envelope, "delivery_journal": delivery_journal, "activation_journal": activation_journal, "identity": identity, "identity_digest": identity_digest, "metadata_digest": metadata_digest, "run_metadata": candidate["context"], "deployment_lock": deployment_lock, "gh_wrapper": gh_wrapper, "verifier_output": verifier_output_path}

    def _activation_authorization(self, fixture: dict[str, object], operation_id: str, retry_key: str, generation: int, rollback_target: str | None, recovery_kind: str | None, scope: str) -> tuple[dict[str, object], provenance.IndependentReleaseAuthorization]:
        identity = fixture["identity"]
        assert isinstance(identity, provenance.TrustedReleaseIdentity)
        binding = activation.activation_binding(operation_id=operation_id, retry_key=fixture.get("forward_retry_key", retry_key) if recovery_kind else retry_key, candidate_release=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], incumbent_release=fixture.get("incumbent_release"), previous_known_good_release=fixture.get("previous_known_good_release", retention.LEGACY_BASELINE_ID), rollback_target=rollback_target, expected_pointer_generation=generation, destination=str(fixture["prepared"]), recovery_kind=recovery_kind, authorization_retry_key=retry_key)
        now = datetime.now(timezone.utc).replace(microsecond=0)
        record = provenance.prepare_owner_authorization_record(identity, authorization_id=retry_key, issued_at=_stamp(now - timedelta(minutes=1)), expires_at=_stamp(now + timedelta(hours=23, minutes=59)), signing_key_id="integration-key", scope=scope, recovery_context=("integration-recovery" if recovery_kind else None), verification_context_sha256=activation.activation_binding_digest(binding))
        envelope, _ = _sign_record(fixture["custody"], record, "integration-key", repository_root=fixture["checkout"])
        verified = provenance.verify_signed_authorization_record(envelope, fixture["trust"], identity, fixture["allowlist"], now=now)
        return envelope, verified

    def _transaction(self, fixture: dict[str, object]) -> activation.ActivationTransaction:
        os.environ["GH_ATTESTATION_CLI"] = str(fixture["gh_wrapper"])
        os.environ["CC_SYNTHETIC_VERIFIER_OUTPUT"] = str(fixture["verifier_output"])
        os.environ["DEPLOY_LOCK_FILE"] = str(fixture["deployment_lock"])
        return activation.ActivationTransaction(retention.RetentionStore(fixture["publication"], repository_root=fixture["checkout"], require_durable=True), prepared_root=fixture["prepared"], deployment_lock_file=fixture["deployment_lock"], journal=fixture["activation_journal"], delivery_journal=fixture["delivery_journal"], delivery_envelope=fixture["delivery_envelope"], trust=fixture["trust"], revision_allowlist=fixture["allowlist"], authorization_allowlist_path=fixture["allowlist_path"], trusted_root=fixture["trusted_root"], trusted_root_version=hashlib.sha256(fixture["trusted_root"].read_bytes()).hexdigest()[:16], run_metadata=fixture["run_metadata"])

    def _import_candidate_into_store(self, base: dict[str, object], candidate: dict[str, object]) -> dict[str, object]:
        identity = candidate["identity"]
        assert isinstance(identity, provenance.TrustedReleaseIdentity)
        digest = candidate["identity_digest"]
        release_name = f"release-{digest}"
        release_path = Path(base["publication"]) / release_name
        shutil.copytree(Path(candidate["publication"]) / release_name, release_path)
        shutil.copytree(Path(candidate["prepared"]) / f"candidate-{digest}", Path(base["prepared"]) / f"candidate-{digest}", symlinks=True)
        context_path = release_path / "independent-verification-context.json"
        context_digest = hashlib.sha256(context_path.read_bytes()).hexdigest()
        context = json.loads(context_path.read_text(encoding="utf-8"))
        now = datetime.now(timezone.utc).replace(microsecond=0)
        delivery_record = provenance.prepare_owner_authorization_record(identity, authorization_id=f"integration-delivery-{digest[:12]}", issued_at=_stamp(now - timedelta(minutes=4)), expires_at=_stamp(now + timedelta(hours=23, minutes=56)), signing_key_id="integration-key", verification_context_sha256=context_digest, delivery_destination=str(base["publication"]), verification_completed_at=context["verificationCompletedAt"])
        delivery_envelope, trust = _sign_record(Path(candidate["custody"]), delivery_record, "integration-key", repository_root=Path(base["checkout"]))
        (release_path / "authorization-envelope.json").write_bytes(provenance._canonical_json(delivery_envelope) + b"\n")
        (release_path / "authorization-envelope.json").chmod(0o600)
        delivery_journal = candidate["delivery_journal"]
        assert isinstance(delivery_journal, provenance.AuthorizationReplayJournal)
        delivery_journal.reserve(delivery_envelope, identity, candidate["allowlist"], trust, operation="forward-release")
        store = retention.RetentionStore(base["publication"], repository_root=base["checkout"], require_durable=True)
        store.register_delivery(identity.__dict__, release_path, authorization_envelope=delivery_envelope, authorization_journal=delivery_journal, authorization_revision_allowlist=candidate["allowlist"], authorization_trust=trust, authorization_operation="forward-release")
        store.mark_operation(f"prepare-{digest}", digest, kind="immutable-runtime-preparation", phase="admission-approved")
        store.update_operation(f"prepare-{digest}", phase="completed", metadata_sha256=candidate["metadata_digest"])
        merged = dict(candidate)
        merged.update({"delivery_envelope": delivery_envelope, "delivery_journal": delivery_journal, "trust": trust})
        for key in ("publication", "prepared", "checkout", "deployment_lock", "activation_journal"):
            merged[key] = base[key]
        return merged

    def _forward_to_health(self, tx: activation.ActivationTransaction, fixture: dict[str, object], operation_id: str, retry_key: str, *, health_outcome: str = "healthy", stop_outcome: str = "stopped", start_outcome: str = "started", consume_forward: bool = True) -> dict[str, object]:
        state = tx.store.load()
        fixture.update({"forward_retry_key": retry_key, "incumbent_release": state["active_release"], "previous_known_good_release": state["previous_known_good_release"]})
        target = state["active_release"] or retention.LEGACY_BASELINE_ID
        envelope, _ = self._activation_authorization(fixture, operation_id, retry_key, state["pointer_generation"], target, None, "activation-forward")
        fixture["activation_journal"].reserve(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")
        tx.begin(operation_id=operation_id, retry_key=retry_key, identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=target)
        if not consume_forward:
            return {"envelope": envelope, "operation": tx.store.load()["activation_operations"][operation_id]}
        tx.consume(operation_id, envelope)
        tx.advance(operation_id, "incumbent-stop-intent")
        tx.observe(operation_id, phase="incumbent-stop-observed", outcome=stop_outcome, details={"subject": "incumbent", "subject_release": target})
        if stop_outcome != "stopped":
            return {"envelope": envelope, "operation": tx.store.load()["activation_operations"][operation_id]}
        tx.advance(operation_id, "candidate-start-intent")
        tx.observe(operation_id, phase="candidate-start-observed", outcome=start_outcome, details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
        if start_outcome != "started":
            return {"envelope": envelope, "operation": tx.store.load()["activation_operations"][operation_id]}
        tx.observe(operation_id, phase="candidate-health-verified", outcome=health_outcome, details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
        return {"envelope": envelope, "operation": tx.store.load()["activation_operations"][operation_id]}

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_first_activation_and_first_rollback(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            identity = fixture["identity"]
            assert isinstance(identity, provenance.TrustedReleaseIdentity)
            tx = self._transaction(fixture)
            operation_id = "integration-first-activation"
            generation = tx.store.load()["pointer_generation"]
            fixture.update({"forward_retry_key": "integration-forward", "incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            forward, _ = self._activation_authorization(fixture, operation_id, "integration-forward", generation, retention.LEGACY_BASELINE_ID, None, "activation-forward")
            fixture["activation_journal"].reserve(forward, identity, fixture["allowlist"], fixture["trust"], operation="activation-forward")
            tx.begin(operation_id=operation_id, retry_key="integration-forward", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=forward, rollback_target=retention.LEGACY_BASELINE_ID)
            tx.consume(operation_id, forward)
            tx.advance(operation_id, "incumbent-stop-intent")
            tx.observe(operation_id, phase="incumbent-stop-observed", outcome="stopped", details={"subject": "incumbent", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "candidate-start-intent")
            tx.observe(operation_id, phase="candidate-start-observed", outcome="started", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.observe(operation_id, phase="candidate-health-verified", outcome="healthy", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.advance(operation_id, "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, operation_id, "integration-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, identity, fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback(operation_id, recovery)
            tx.consume_rollback(operation_id, recovery)
            tx.observe(operation_id, phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "successful-rollback")
            final = tx.store.load()
            self.assertIsNone(final["active_release"])
            self.assertEqual(final["previous_known_good_release"], retention.LEGACY_BASELINE_ID)
            self.assertEqual(final["releases"][fixture["identity_digest"]]["roles"], ["retired"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_three_successive_activations_and_subsequent_rollback(self) -> None:
        """Drive three generations, then rollback the authenticated incumbent."""
        with TemporaryDirectory() as directory_name:
            base = self._fixture(Path(directory_name) / "successive-0", candidate_nonce="successive-0")
            fixture = base
            candidates = [base]
            for index in (1, 2):
                imported = self._import_candidate_into_store(base, self._fixture(Path(directory_name) / f"successive-{index}", candidate_nonce=f"successive-{index}"))
                candidates.append(imported)
            for index, fixture in enumerate(candidates):
                tx = self._transaction(fixture)
                result = self._forward_to_health(tx, fixture, f"integration-successive-{index}", f"integration-successive-retry-{index}")
                tx.advance(f"integration-successive-{index}", "successful-activation")
                self.assertEqual(tx.store.load()["active_release"], fixture["identity_digest"])
                self.assertEqual(result["operation"]["candidate_release"], fixture["identity_digest"])
            state = tx.store.load()
            self.assertEqual(state["active_release"], candidates[-1]["identity_digest"])
            self.assertEqual(state["previous_known_good_release"], candidates[-2]["identity_digest"])
            self.assertEqual(state["releases"][candidates[0]["identity_digest"]]["roles"], ["retired"])
            operation = state["activation_operations"]["integration-successive-2"]
            fixture.update({"incumbent_release": operation["incumbent_release"], "previous_known_good_release": operation["previous_known_good_release"]})
            recovery, _ = self._activation_authorization(fixture, "integration-successive-2", "integration-successive-recovery", state["pointer_generation"], operation["rollback_target"], "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback("integration-successive-2", recovery)
            tx.consume_rollback("integration-successive-2", recovery)
            tx.observe("integration-successive-2", phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": operation["rollback_target"]})
            tx.advance("integration-successive-2", "successful-rollback")
            final = tx.store.load()
            self.assertEqual(final["active_release"], operation["rollback_target"])
            self.assertEqual(final["releases"][candidates[-1]["identity_digest"]]["roles"], ["retired"])
            inventory = tx.store.inventory()
            retired = next(item for item in inventory["known"] if item["identity_sha256"] == candidates[-1]["identity_digest"])
            self.assertFalse(retired["eligible"])
            gc = tx.store.garbage_collect(execute=True)
            self.assertNotIn(candidates[-1]["identity_digest"], gc["deleted"])
            self.assertIn(candidates[-1]["identity_digest"], gc["protected"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_failed_runtime_observations_compensate(self) -> None:
        """Compensate both failed incumbent stop and failed candidate health."""
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            operation_id = "integration-failed-start"
            result = self._forward_to_health(tx, fixture, operation_id, "integration-failed-forward", stop_outcome="failed")
            operation = result["operation"]
            state = tx.store.load()
            fixture.update({"incumbent_release": operation["incumbent_release"], "previous_known_good_release": operation["previous_known_good_release"]})
            recovery, _ = self._activation_authorization(fixture, operation_id, "integration-failed-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "compensation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback(operation_id, recovery)
            tx.consume_rollback(operation_id, recovery)
            tx.observe(operation_id, phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "successful-rollback")
            final = tx.store.load()
            self.assertIsNone(final["active_release"])
            self.assertEqual(final["releases"][fixture["identity_digest"]]["roles"], ["retired"])

            health_base = self._fixture(Path(directory_name) / "failed-health-incumbent", candidate_nonce="failed-health-incumbent")
            health_tx = self._transaction(health_base)
            self._forward_to_health(health_tx, health_base, "integration-authenticated-incumbent", "integration-authenticated-incumbent-forward")
            health_tx.advance("integration-authenticated-incumbent", "successful-activation")
            health_fixture = self._import_candidate_into_store(health_base, self._fixture(Path(directory_name) / "failed-health-candidate", candidate_nonce="failed-health-candidate"))
            health_tx = self._transaction(health_fixture)
            health_operation_id = "integration-failed-health"
            health_result = self._forward_to_health(health_tx, health_fixture, health_operation_id, "integration-failed-health-forward", health_outcome="failed")
            health_operation = health_result["operation"]
            health_state = health_tx.store.load()
            health_fixture.update({"incumbent_release": health_operation["incumbent_release"], "previous_known_good_release": health_operation["previous_known_good_release"]})
            health_tx.advance(health_operation_id, "recovery-required")
            health_recovery, _ = self._activation_authorization(health_fixture, health_operation_id, "integration-failed-health-recovery", health_state["pointer_generation"], health_operation["rollback_target"], "compensation", "activation-recovery")
            health_fixture["activation_journal"].reserve(health_recovery, health_fixture["identity"], health_fixture["allowlist"], health_fixture["trust"], operation="activation-recovery")
            health_tx.begin_rollback(health_operation_id, health_recovery)
            health_tx.consume_rollback(health_operation_id, health_recovery)
            health_tx.observe(health_operation_id, phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": health_operation["rollback_target"]})
            health_tx.advance(health_operation_id, "successful-rollback")
            self.assertEqual(health_tx.store.load()["active_release"], health_operation["rollback_target"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_reconciliation_and_interrupted_rollback(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            operation_id = "integration-reconcile-forward"
            result = self._forward_to_health(tx, fixture, operation_id, "integration-reconcile-forward", consume_forward=False)
            envelope = result["envelope"]
            # Kill the actual coordinator after its replay-journal commit but
            # before retention transition publication.
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(read_fd)
                original_transition = tx.store.transition_activation
                def kill_after_journal(*args, **kwargs):
                    if kwargs.get("phase") == "authorization-consumed":
                        os.kill(os.getpid(), 9)
                    return original_transition(*args, **kwargs)
                tx.store.transition_activation = kill_after_journal  # type: ignore[method-assign]
                try:
                    tx.consume(operation_id, envelope)
                except BaseException:
                    os._exit(6)
            os.close(write_fd)
            _, status = os.waitpid(child, 0)
            os.close(read_fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), -9)
            tx.reconcile(operation_id, envelope, now=datetime.now(timezone.utc) + timedelta(days=2))
            self.assertEqual(tx.store.load()["activation_operations"][operation_id]["phase"], "authorization-consumed")
            tx.advance(operation_id, "incumbent-stop-intent")
            tx.observe(operation_id, phase="incumbent-stop-observed", outcome="stopped", details={"subject": "incumbent", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "candidate-start-intent")
            tx.observe(operation_id, phase="candidate-start-observed", outcome="started", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.observe(operation_id, phase="candidate-health-verified", outcome="healthy", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.advance(operation_id, "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, operation_id, "integration-reconcile-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback(operation_id, recovery)
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(read_fd)
                tx.store.transition_activation = lambda *args, **kwargs: os.kill(os.getpid(), 9)  # type: ignore[method-assign]
                try:
                    tx.consume_rollback(operation_id, recovery)
                except BaseException:
                    os._exit(7)
            os.close(write_fd)
            _, status = os.waitpid(child, 0)
            os.close(read_fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), -9)
            tx.reconcile_rollback(operation_id, recovery, now=datetime.now(timezone.utc) + timedelta(days=2))
            tx.observe(operation_id, phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "successful-rollback")
            self.assertIsNone(tx.store.load()["active_release"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_forward_authority_failure_leaves_delivery_reserved(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-ordering", "integration-ordering", consume_forward=False)
            envelope = result["envelope"]
            tx.consume("integration-ordering", envelope)
            activation_entries = [path for path in fixture["activation_journal"].root.glob("*.json")]
            self.assertEqual(len(activation_entries), 1)
            activation_entries[0].unlink()

            with self.assertRaisesRegex(provenance.ProvenanceError, "authorization replay entry is missing"):
                tx.advance("integration-ordering", "incumbent-stop-intent")

            self.assertEqual(fixture["delivery_journal"].inspect(fixture["delivery_envelope"], fixture["identity"], fixture["allowlist"], fixture["trust"], operation="forward-release")["state"], "reserved")
            self.assertIsNone(tx.store.load()["activation_operations"]["integration-ordering"]["delivery_consumption"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_terminal_rollback_reconciliation_requires_durable_retry(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-terminal-retry", "integration-terminal-forward")
            tx.advance("integration-terminal-retry", "successful-activation")
            state = tx.store.load()
            pointer_generation = state["pointer_generation"]
            delivery_evidence = state["activation_operations"]["integration-terminal-retry"]["delivery_consumption"]
            retried_activation = tx.advance("integration-terminal-retry", "successful-activation")
            self.assertEqual(retried_activation["phase"], "successful-activation")
            self.assertEqual(tx.store.load()["pointer_generation"], pointer_generation)
            self.assertEqual(tx.store.load()["activation_operations"]["integration-terminal-retry"]["delivery_consumption"], delivery_evidence)
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-terminal-retry", "integration-terminal-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback("integration-terminal-retry", recovery)
            tx.consume_rollback("integration-terminal-retry", recovery)
            tx.observe("integration-terminal-retry", phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance("integration-terminal-retry", "successful-rollback")

            with patch.object(tx.store, "_fsync_state_file", side_effect=retention.RetentionError("persistent state-file fsync failure")) as state_fsync:
                with self.assertRaises(retention.RetentionError):
                    tx.reconcile_rollback("integration-terminal-retry", recovery)
                state_fsync.assert_called_once_with()
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent state-directory fsync failure")) as directory_fsync:
                with self.assertRaises(retention.RetentionError):
                    tx.reconcile_rollback("integration-terminal-retry", recovery)
                directory_fsync.assert_called_once_with(tx.store.root, required=True)

            fresh = self._transaction(fixture)
            fresh.reconcile_rollback("integration-terminal-retry", recovery)
            with patch.object(fresh.store, "_fsync_state_file", side_effect=retention.RetentionError("persistent terminal retry fsync failure")) as state_fsync:
                with self.assertRaises(retention.RetentionError):
                    fresh.advance("integration-terminal-retry", "successful-rollback")
                state_fsync.assert_called_once_with()
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent terminal retry directory failure")) as directory_fsync:
                with self.assertRaises(retention.RetentionError):
                    fresh.advance("integration-terminal-retry", "successful-rollback")
                directory_fsync.assert_called_once_with(fresh.store.root, required=True)
            self._transaction(fixture).advance("integration-terminal-retry", "successful-rollback")

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_pending_rollback_authorization_retries_durably_after_rename(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-pending-rollback", "integration-pending-forward")
            tx.advance("integration-pending-rollback", "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-pending-rollback", "integration-pending-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")

            # os.replace has already published the pending authorization when
            # the directory durability boundary fails.  The exact retry must
            # re-fsync that existing record without rebinding authority.
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("rename-before-directory-fsync interruption")):
                with self.assertRaises(retention.RetentionError):
                    tx.begin_rollback("integration-pending-rollback", recovery)
            pending = tx.store.load()["activation_operations"]["integration-pending-rollback"]
            self.assertEqual(pending["phase"], "compensation-authorization-consumption-pending")
            bound_retry = pending["rollback_retry_key"]
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent pending rollback directory failure")):
                with self.assertRaises(retention.RetentionError):
                    tx.begin_rollback("integration-pending-rollback", recovery)
            retried = self._transaction(fixture).begin_rollback("integration-pending-rollback", recovery)
            self.assertEqual(retried["phase"], "compensation-authorization-consumption-pending")
            self.assertEqual(retried["rollback_retry_key"], bound_retry)

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_failed_rollback_recovers_with_same_authority(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-failed-rollback", "integration-failed-forward")
            tx.advance("integration-failed-rollback", "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-failed-rollback", "integration-failed-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback("integration-failed-rollback", recovery)
            tx.consume_rollback("integration-failed-rollback", recovery)
            tx.observe("integration-failed-rollback", phase="rollback-observed", outcome="failed", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance("integration-failed-rollback", "recovery-required")
            failed = tx.store.load()["activation_operations"]["integration-failed-rollback"]
            self.assertEqual(failed["phase"], "recovery-required")
            self.assertEqual(failed["intent"]["recovery_phase"], "rollback-observed")

            resumed = tx.begin_rollback("integration-failed-rollback", recovery)
            self.assertEqual(resumed["phase"], "rollback-intent")
            self.assertEqual(resumed["rollback_authorization_id"], failed["rollback_authorization_id"])
            tx.observe("integration-failed-rollback", phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance("integration-failed-rollback", "successful-rollback")
            self.assertIsNone(tx.store.load()["active_release"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_direct_consumption_requires_durable_intent_and_reconciles_delivery(self) -> None:
        # A visible intent after os.replace is not enough for a fresh
        # coordinator to burn replay authority while its directory fsync is
        # still failing.
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "forward")
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-direct-forward", "integration-direct-forward", consume_forward=False)
            envelope = result["envelope"]
            before = tx.store.load()
            pointers = (before["active_release"], before["previous_known_good_release"], before["pointer_generation"])
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("forward intent rename-before-directory-fsync")):
                with self.assertRaises(retention.RetentionError):
                    tx.consume("integration-direct-forward", envelope)
            self.assertEqual(tx.store.load()["activation_operations"]["integration-direct-forward"]["phase"], "authorization-consumption-pending")
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent forward intent durability failure")):
                with self.assertRaises(retention.RetentionError):
                    self._transaction(fixture).consume("integration-direct-forward", envelope)
            self.assertEqual(fixture["activation_journal"].inspect(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")["state"], "reserved")
            state = tx.store.load()
            self.assertEqual((state["active_release"], state["previous_known_good_release"], state["pointer_generation"]), pointers)
            consumed = self._transaction(fixture).consume("integration-direct-forward", envelope)
            self.assertEqual(consumed["phase"], "authorization-consumed")

        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "rollback")
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-direct-rollback", "integration-direct-rollback-forward")
            tx.advance("integration-direct-rollback", "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-direct-rollback", "integration-direct-rollback-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("rollback intent rename-before-directory-fsync")):
                with self.assertRaises(retention.RetentionError):
                    tx.begin_rollback("integration-direct-rollback", recovery)
            pending = tx.store.load()["activation_operations"]["integration-direct-rollback"]
            self.assertEqual(pending["phase"], "compensation-authorization-consumption-pending")
            pointers = (tx.store.load()["active_release"], tx.store.load()["previous_known_good_release"], tx.store.load()["pointer_generation"])
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent rollback intent durability failure")):
                with self.assertRaises(retention.RetentionError):
                    self._transaction(fixture).consume_rollback("integration-direct-rollback", recovery)
            self.assertEqual(fixture["activation_journal"].inspect(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")["state"], "reserved")
            state = tx.store.load()
            self.assertEqual((state["active_release"], state["previous_known_good_release"], state["pointer_generation"]), pointers)
            consumed = self._transaction(fixture).consume_rollback("integration-direct-rollback", recovery)
            self.assertEqual(consumed["phase"], "rollback-intent")

        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "delivery")
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-direct-delivery", "integration-direct-delivery-forward", consume_forward=False)
            envelope = result["envelope"]
            before = tx.store.load()
            pointers = (before["active_release"], before["previous_known_good_release"], before["pointer_generation"])
            # The original authorization-consumed publication is visible
            # after os.replace, but its parent-directory fsync fails.  A
            # fresh coordinator must not use that visible record to consume
            # delivery authority while the fault persists.
            real_fsync_directory = retention._fsync_directory
            state_path = fixture["publication"] / retention.STATE_FILENAME
            phase_fault, phase_fault_state = _phase_selective_retention_fsync_fault(real_fsync_directory, fixture["publication"], state_path, "integration-direct-delivery")
            with patch.object(retention, "_fsync_directory", side_effect=phase_fault):
                with self.assertRaises(retention.RetentionError):
                    tx.consume("integration-direct-delivery", envelope)
            interrupted_activation = tx.store.load()["activation_operations"]["integration-direct-delivery"]
            self.assertEqual(phase_fault_state["fault_triggered"], 1)
            self.assertIn("authorization-consumption-pending", phase_fault_state["observed_phases"])
            self.assertIn("authorization-consumed", phase_fault_state["observed_phases"])
            self.assertEqual(interrupted_activation["phase"], "authorization-consumed")
            self.assertEqual(fixture["activation_journal"].inspect(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward", allow_consumed=True)["state"], "consumed")
            self.assertEqual(fixture["delivery_journal"].inspect(fixture["delivery_envelope"], fixture["identity"], fixture["allowlist"], fixture["trust"], operation="forward-release")["state"], "reserved")
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent delivery intent durability failure")):
                with self.assertRaises(retention.RetentionError):
                    self._transaction(fixture).advance("integration-direct-delivery", "incumbent-stop-intent")
            self.assertEqual(fixture["delivery_journal"].inspect(fixture["delivery_envelope"], fixture["identity"], fixture["allowlist"], fixture["trust"], operation="forward-release")["state"], "reserved")
            state = tx.store.load()
            self.assertEqual((state["active_release"], state["previous_known_good_release"], state["pointer_generation"]), pointers)
            advanced = self._transaction(fixture).advance("integration-direct-delivery", "incumbent-stop-intent")
            self.assertEqual(advanced["phase"], "incumbent-stop-intent")
            self.assertIsNotNone(advanced["delivery_consumption"])

        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "delivery-reconcile")
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-delivery-reconcile", "integration-delivery-reconcile-forward", consume_forward=False)
            envelope = result["envelope"]
            tx.consume("integration-delivery-reconcile", envelope)
            with patch.object(tx.store, "record_delivery_consumption", side_effect=activation.ActivationError("interrupted before retention delivery proof publication")):
                with self.assertRaises(activation.ActivationError):
                    tx.advance("integration-delivery-reconcile", "incumbent-stop-intent")
            self.assertEqual(fixture["delivery_journal"].inspect(fixture["delivery_envelope"], fixture["identity"], fixture["allowlist"], fixture["trust"], operation="forward-release", allow_consumed=True)["state"], "consumed")
            interrupted = tx.store.load()["activation_operations"]["integration-delivery-reconcile"]
            self.assertIsNone(interrupted["delivery_consumption"])
            reconciled = self._transaction(fixture).advance("integration-delivery-reconcile", "incumbent-stop-intent")
            self.assertEqual(reconciled["phase"], "incumbent-stop-intent")
            self.assertIsNotNone(reconciled["delivery_consumption"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_rejects_substituted_historical_terminal_observations(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-terminal-validation", "integration-terminal-validation-forward")
            tx.advance("integration-terminal-validation", "successful-activation")
            state_path = fixture["publication"] / retention.STATE_FILENAME
            original = state_path.read_bytes()
            mutations = (
                ("wrong subject", lambda operation: operation["observations"]["incumbent-stop-observed"].update({"subject": "candidate", "subject_release": fixture["identity_digest"], "details": {"subject": "candidate", "subject_release": fixture["identity_digest"]}})),
                ("wrong release", lambda operation: operation["observations"]["candidate-start-observed"].update({"subject_release": retention.LEGACY_BASELINE_ID, "details": {"subject": "candidate", "subject_release": retention.LEGACY_BASELINE_ID}})),
                ("wrong operation", lambda operation: operation["observations"]["candidate-health-verified"].update({"operation_id": "other-operation"})),
                ("wrong runtime identity", lambda operation: operation["observations"]["candidate-health-verified"].update({"runtime_identity_sha256": "f" * 64})),
                ("wrong observation phase", lambda operation: operation["observations"]["candidate-health-verified"].update({"phase": "candidate-start-observed"})),
                ("missing prerequisite", lambda operation: operation["observations"].pop("candidate-start-observed")),
            )
            for label, mutate in mutations:
                with self.subTest(label):
                    state = json.loads(original.decode("utf-8"))
                    mutate(state["activation_operations"]["integration-terminal-validation"])
                    state_path.write_bytes(retention._canonical(state) + b"\n")
                    with self.assertRaises(retention.RetentionError):
                        retention.RetentionStore(fixture["publication"], repository_root=fixture["checkout"], require_durable=True).load()
            state_path.write_bytes(original)

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_rejects_mutated_terminal_rollback_and_recovery_records(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "terminal")
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-rollback-validation", "integration-rollback-validation-forward")
            tx.advance("integration-rollback-validation", "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-rollback-validation", "integration-rollback-validation-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback("integration-rollback-validation", recovery)
            tx.consume_rollback("integration-rollback-validation", recovery)
            tx.observe("integration-rollback-validation", phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance("integration-rollback-validation", "successful-rollback")
            state_path = fixture["publication"] / retention.STATE_FILENAME
            terminal_original = state_path.read_bytes()
            terminal_mutations = (
                ("missing forward evidence", lambda operation: operation.update({"forward_consumption": None})),
                ("mutated rollback binding", lambda operation: operation.update({"rollback_retry_key": "wrong-retry"})),
                ("mutated rollback observation", lambda operation: operation["observations"]["rollback-observed"].update({"subject_release": fixture["identity_digest"], "details": {"subject": "rollback-target", "subject_release": fixture["identity_digest"]}})),
            )
            for label, mutate in terminal_mutations:
                with self.subTest(record="terminal rollback", label=label):
                    state = json.loads(terminal_original.decode("utf-8"))
                    mutate(state["activation_operations"]["integration-rollback-validation"])
                    state_path.write_bytes(retention._canonical(state) + b"\n")
                    with self.assertRaises(retention.RetentionError):
                        retention.RetentionStore(fixture["publication"], repository_root=fixture["checkout"], require_durable=True).load()
            state_path.write_bytes(terminal_original)

        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name) / "recovery")
            tx = self._transaction(fixture)
            self._forward_to_health(tx, fixture, "integration-recovery-validation", "integration-recovery-validation-forward")
            tx.advance("integration-recovery-validation", "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, "integration-recovery-validation", "integration-recovery-validation-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback("integration-recovery-validation", recovery)
            tx.consume_rollback("integration-recovery-validation", recovery)
            tx.observe("integration-recovery-validation", phase="rollback-observed", outcome="failed", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance("integration-recovery-validation", "recovery-required")
            state_path = fixture["publication"] / retention.STATE_FILENAME
            recovery_original = state_path.read_bytes()
            recovery_mutations = (
                ("changed resume phase", lambda operation: operation["intent"].update({"recovery_phase": "candidate-health-verified"})),
                ("removed failed rollback evidence", lambda operation: operation["observations"].pop("rollback-observed")),
            )
            for label, mutate in recovery_mutations:
                with self.subTest(record="recovery-required", label=label):
                    state = json.loads(recovery_original.decode("utf-8"))
                    mutate(state["activation_operations"]["integration-recovery-validation"])
                    state_path.write_bytes(retention._canonical(state) + b"\n")
                    with self.assertRaises(retention.RetentionError):
                        retention.RetentionStore(fixture["publication"], repository_root=fixture["checkout"], require_durable=True).load()
            state_path.write_bytes(recovery_original)

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_subprocess_termination_at_journal_boundaries(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            operation_id = "integration-process-forward"
            state = tx.store.load()
            fixture.update({"forward_retry_key": "integration-process-forward", "incumbent_release": state["active_release"], "previous_known_good_release": state["previous_known_good_release"]})
            forward, _ = self._activation_authorization(fixture, operation_id, "integration-process-forward", state["pointer_generation"], retention.LEGACY_BASELINE_ID, None, "activation-forward")
            fixture["activation_journal"].reserve(forward, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(read_fd)
                try:
                    tx.begin(operation_id=operation_id, retry_key="integration-process-forward", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=forward, rollback_target=retention.LEGACY_BASELINE_ID)
                    os.write(write_fd, b"begun")
                    os._exit(0)
                except BaseException:
                    os._exit(2)
            os.close(write_fd)
            self.assertEqual(os.read(read_fd, 5), b"begun")
            _, status = os.waitpid(child, 0)
            os.close(read_fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            tx.consume(operation_id, forward)
            tx.advance(operation_id, "incumbent-stop-intent")
            tx.observe(operation_id, phase="incumbent-stop-observed", outcome="stopped", details={"subject": "incumbent", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "candidate-start-intent")
            tx.observe(operation_id, phase="candidate-start-observed", outcome="started", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.observe(operation_id, phase="candidate-health-verified", outcome="healthy", details={"subject": "candidate", "subject_release": fixture["identity_digest"]})
            tx.advance(operation_id, "successful-activation")
            state = tx.store.load()
            fixture.update({"incumbent_release": None, "previous_known_good_release": retention.LEGACY_BASELINE_ID})
            recovery, _ = self._activation_authorization(fixture, operation_id, "integration-process-recovery", state["pointer_generation"], retention.LEGACY_BASELINE_ID, "post-activation", "activation-recovery")
            fixture["activation_journal"].reserve(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
            tx.begin_rollback(operation_id, recovery)
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(read_fd)
                try:
                    tx.journal.consume(recovery, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-recovery")
                    os.write(write_fd, b"consumed")
                    os._exit(0)
                except BaseException:
                    os._exit(3)
            os.close(write_fd)
            self.assertEqual(os.read(read_fd, 8), b"consumed")
            _, status = os.waitpid(child, 0)
            os.close(read_fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            tx.reconcile_rollback(operation_id, recovery)
            tx.observe(operation_id, phase="rollback-observed", outcome="healthy", details={"subject": "rollback-target", "subject_release": retention.LEGACY_BASELINE_ID})
            tx.advance(operation_id, "successful-rollback")
            self.assertIsNone(tx.store.load()["active_release"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_lock_durability_and_gc_boundaries(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            state = tx.store.load()
            fixture.update({"forward_retry_key": "integration-fsync-forward", "incumbent_release": state["active_release"], "previous_known_good_release": state["previous_known_good_release"]})
            envelope, _ = self._activation_authorization(fixture, "integration-fsync", "integration-fsync-forward", state["pointer_generation"], retention.LEGACY_BASELINE_ID, None, "activation-forward")
            fixture["activation_journal"].reserve(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")
            retry_workspaces_before = {path.name for path in fixture["prepared"].glob(".retry-*")}
            with patch.object(retention, "assess_storage", return_value=SimpleNamespace(status="FAIL")):
                with self.assertRaises(activation.ActivationError):
                    tx.begin(operation_id="integration-resource-denial", retry_key="integration-resource-denial", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
            self.assertEqual(retry_workspaces_before, {path.name for path in fixture["prepared"].glob(".retry-*")})
            self.assertEqual(fixture["activation_journal"].inspect(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")["state"], "reserved")
            read_fd, write_fd = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(read_fd)
                try:
                    with preparation._operation_lock(fixture["deployment_lock"]):
                        os.write(write_fd, b"locked")
                        time.sleep(0.25)
                    os._exit(0)
                except BaseException:
                    os._exit(4)
            os.close(write_fd)
            self.assertEqual(os.read(read_fd, 6), b"locked")
            with tx._locked():
                pass
            _, status = os.waitpid(child, 0)
            os.close(read_fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            with patch.object(retention, "_fsync_directory", side_effect=OSError("injected filesystem durability failure")):
                with self.assertRaises(retention.RetentionError):
                    tx.begin(operation_id="integration-fsync", retry_key="integration-fsync-forward", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
            state = tx.store.load()
            self.assertEqual(state["active_release"], None)
            self.assertEqual(state["activation_operations"]["integration-fsync"]["phase"], "validated-intent")
            self.assertIn("recovery-protected", state["releases"][fixture["identity_digest"]]["roles"])
            with self.assertRaises(activation.ActivationError):
                tx.advance("integration-fsync", "successful-activation")
            self.assertEqual(fixture["activation_journal"].inspect(envelope, fixture["identity"], fixture["allowlist"], fixture["trust"], operation="activation-forward")["state"], "reserved")
            retried = tx.begin(operation_id="integration-fsync", retry_key="integration-fsync-forward", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
            self.assertEqual(retried["phase"], "validated-intent")

            state_bytes = tx.store.state_path.read_bytes()
            malformed = json.loads(state_bytes.decode("utf-8"))
            malformed["activation_operations"]["integration-fsync"]["delivery_consumption"] = {"operation_id": "wrong"}
            tx.store.state_path.write_bytes(retention._canonical(malformed) + b"\n")
            with self.assertRaises(retention.RetentionError):
                tx.store.load()
            tx.store.state_path.write_bytes(state_bytes)
            malformed = json.loads(state_bytes.decode("utf-8"))
            malformed["activation_operations"]["integration-fsync"]["phase"] = "incumbent-stop-observed"
            malformed["activation_operations"]["integration-fsync"]["observations"]["incumbent-stop-observed"] = {"contract": "clashcookies.activation-observation", "version": 1, "subject": "candidate", "subject_release": fixture["identity_digest"]}
            tx.store.state_path.write_bytes(retention._canonical(malformed) + b"\n")
            with self.assertRaises(retention.RetentionError):
                tx.store.load()
            tx.store.state_path.write_bytes(state_bytes)
            gc = tx.store.garbage_collect(execute=True)
            self.assertEqual(gc["deleted"], [])
            self.assertIn(fixture["identity_digest"], gc["protected"])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_fsync_failure_requires_durable_retry(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-fsync-retry", "integration-fsync-retry", consume_forward=False)
            envelope = result["envelope"]
            original_fsync = retention._fsync_directory
            with patch.object(retention, "_fsync_directory", side_effect=retention.RetentionError("persistent directory fsync failure")):
                with self.assertRaises(retention.RetentionError):
                    tx.begin(operation_id="integration-fsync-retry", retry_key="integration-fsync-retry", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
                with self.assertRaises(retention.RetentionError):
                    tx.begin(operation_id="integration-fsync-retry", retry_key="integration-fsync-retry", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
            with patch.object(retention, "_fsync_directory", wraps=original_fsync) as fsync:
                tx.begin(operation_id="integration-fsync-retry", retry_key="integration-fsync-retry", identity_sha256=fixture["identity_digest"], preparation_metadata_sha256=fixture["metadata_digest"], envelope=envelope, rollback_target=retention.LEGACY_BASELINE_ID)
                self.assertGreaterEqual(fsync.call_count, 1)

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_delivery_proof_is_required_before_disruption(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-delivery-gate", "integration-delivery-gate", consume_forward=False)
            envelope = result["envelope"]
            tx.consume("integration-delivery-gate", envelope)
            operation = tx.store.load()["activation_operations"]["integration-delivery-gate"]
            authority = tx._consumed_authority(operation, recovery=False)
            with self.assertRaises(retention.RetentionError):
                tx.store.transition_activation("integration-delivery-gate", phase="incumbent-stop-intent", expected_phase="authorization-consumed", authority=authority)
            identity = fixture["identity"]
            self.assertEqual(fixture["delivery_journal"].inspect(fixture["delivery_envelope"], identity, fixture["allowlist"], fixture["trust"], operation="forward-release")["state"], "reserved")

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RECEIVER") == "1", "mandatory Linux coordinator integration")
    def test_real_coordinator_rejects_semantically_incomplete_persisted_activation(self) -> None:
        with TemporaryDirectory() as directory_name:
            fixture = self._fixture(Path(directory_name))
            tx = self._transaction(fixture)
            result = self._forward_to_health(tx, fixture, "integration-state-validation", "integration-state-validation", consume_forward=False)
            tx.consume("integration-state-validation", result["envelope"])
            state_path = fixture["publication"] / retention.STATE_FILENAME
            original = json.loads(state_path.read_text(encoding="utf-8"))
            mutations = (
                ("wrong retry identity", lambda operation: operation["forward_consumption"].update({"retry_key": "wrong-retry"})),
                ("wrong scope", lambda operation: operation["forward_consumption"].update({"scope": "activation-recovery"})),
                ("missing health prerequisite", lambda operation: operation.update({"phase": "successful-activation", "observations": {}})),
            )
            for label, mutate in mutations:
                with self.subTest(label=label):
                    state = json.loads(json.dumps(original))
                    mutate(state["activation_operations"]["integration-state-validation"])
                    state_path.write_bytes(retention._canonical(state) + b"\n")
                    with self.assertRaises(retention.RetentionError):
                        retention.RetentionStore(fixture["publication"], repository_root=fixture["checkout"], require_durable=True).load()


if __name__ == "__main__":
    unittest.main()
