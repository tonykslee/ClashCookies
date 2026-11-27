#!/usr/bin/env python3
"""Non-operational, durable activation transaction contract.

This module owns no runtime process and performs no Docker action.  It binds an
exact retained candidate, completed immutable preparation, independently
signed activation authority, and the retention owner's pointer transaction.
External runtime results are accepted only as explicitly marked isolated-test
evidence until the later operational activation milestone exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any

import durable_artifact_retention as retention
import immutable_runtime_preparation as preparation
import runtime_artifact_provenance as provenance


ACTIVATION_CONTRACT = "clashcookies.durable-activation-transaction"
ACTIVATION_VERSION = 1
ACTIVATION_AUTHORIZATION_FORWARD = "activation-forward"
ACTIVATION_AUTHORIZATION_RECOVERY = "activation-recovery"


class ActivationError(RuntimeError):
    """Raised when activation evidence, authority, or durable state is unsafe."""


def _fail(message: str) -> None:
    raise ActivationError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        _fail(f"activation binding is not canonical JSON: {error}")


def activation_binding(*, operation_id: str, retry_key: str, candidate_release: str, preparation_metadata_sha256: str, incumbent_release: str | None, previous_known_good_release: str | None, rollback_target: str | None, expected_pointer_generation: int, destination: str, recovery_kind: str | None = None, authorization_retry_key: str | None = None) -> dict[str, Any]:
    """Build the exact signed context that makes activation authority operation-specific."""
    value = {
        "contract": ACTIVATION_CONTRACT,
        "version": ACTIVATION_VERSION,
        "operation_id": operation_id,
        "retry_key": retry_key,
        "candidate_release": candidate_release,
        "preparation_metadata_sha256": preparation_metadata_sha256,
        "incumbent_release": incumbent_release,
        "previous_known_good_release": previous_known_good_release,
        "rollback_target": rollback_target,
        "expected_pointer_generation": expected_pointer_generation,
        "destination": destination,
        "recovery_kind": recovery_kind,
        "authorization_retry_key": retry_key if authorization_retry_key is None else authorization_retry_key,
    }
    _require(len(_canonical(value)) <= 64 * 1024, "activation binding exceeds its size limit")
    return value


def activation_binding_digest(binding: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(binding)).hexdigest()


def authorization_record_digest(envelope: dict[str, Any]) -> str:
    _require(isinstance(envelope, dict) and isinstance(envelope.get("record"), dict), "activation authorization envelope is malformed")
    return hashlib.sha256(provenance._canonical_json(envelope["record"])).hexdigest()


@dataclass(frozen=True)
class PreparedCandidateEvidence:
    identity_sha256: str
    preparation_metadata_sha256: str
    preparation_path: Path
    runtime_integrity: dict[str, Any]
    legacy_integrity: dict[str, Any]


class ActivationTransaction:
    """Coordinate authority and the retention-owned activation state machine."""

    def __init__(self, store: retention.RetentionStore, *, prepared_root: Path, deployment_lock_file: Path, journal: provenance.AuthorizationReplayJournal, delivery_journal: provenance.AuthorizationReplayJournal, delivery_envelope: dict[str, Any], trust: provenance.AuthorizationTrustConfig, revision_allowlist: provenance.AuthorizationRevisionAllowlist, authorization_allowlist_path: Path, trusted_root: Path, trusted_root_version: str, run_metadata: dict[str, Any], resource_paths: tuple[Path, ...], temporary_bytes: int, persistent_bytes: int, temporary_inodes: int, persistent_inodes: int, headroom_inodes: int = 128):
        self.store = store
        self.prepared_root = prepared_root
        self.journal = journal
        self.delivery_journal = delivery_journal
        self.delivery_envelope = delivery_envelope
        self.trust = trust
        self.revision_allowlist = revision_allowlist
        self.authorization_allowlist_path = authorization_allowlist_path
        self.deployment_lock_file = deployment_lock_file
        self.trusted_root = trusted_root
        self.trusted_root_version = trusted_root_version
        self.run_metadata = run_metadata
        self.resource_paths = resource_paths
        self.temporary_bytes = temporary_bytes
        self.persistent_bytes = persistent_bytes
        self.temporary_inodes = temporary_inodes
        self.persistent_inodes = persistent_inodes
        self.headroom_inodes = headroom_inodes
        _require(prepared_root.is_absolute() and prepared_root.is_dir() and not prepared_root.is_symlink(), "prepared runtime root is unavailable")
        _require(prepared_root.resolve() != store.root.resolve(), "prepared runtime root must be separate from retention publication")
        _require(deployment_lock_file.is_absolute(), "canonical FB-027 deployment lock is required")
        _require(isinstance(delivery_envelope, dict), "exact retained delivery authorization is required")
        _require(isinstance(run_metadata, dict) and run_metadata, "exact archive-verification run metadata is required")
        _require(resource_paths and all(isinstance(path, Path) and path.is_absolute() for path in resource_paths), "bounded activation resource paths are required")
        for path, label in ((trusted_root, "independent trusted root"), (deployment_lock_file, "FB-027 deployment lock")):
            _require(path.is_absolute(), f"{label} must be absolute")
        for sensitive_root, label in ((store.root, "retention"), (store.repository_root, "checkout"), (prepared_root, "prepared runtime"), (trusted_root, "independent trusted root")):
            for other_root, other_label in ((trusted_root, "independent trusted root"), (prepared_root, "prepared runtime"), (store.root, "retention"), (store.repository_root, "checkout")):
                if label != other_label:
                    try:
                        other_root.resolve().relative_to(sensitive_root.resolve())
                    except ValueError:
                        continue
                    _fail(f"{other_label} must be disjoint from {label}")

    @contextmanager
    def _locked(self):
        with preparation._operation_lock(self.deployment_lock_file), retention.activity_lock(self.store.root):
            yield

    def _admit_resources(self) -> None:
        assessment = retention.assess_storage(list(self.resource_paths), temporary_bytes=self.temporary_bytes, persistent_bytes=self.persistent_bytes, preserved_runtime_bytes=retention.retained_bytes(self.store.root), incremental_preservation_bytes=self.persistent_bytes, temporary_inodes=self.temporary_inodes, persistent_inodes=self.persistent_inodes, headroom_inodes=self.headroom_inodes)
        _require(assessment.status == "PASS", "activation resource admission is insufficient")

    def _candidate(self, identity_sha256: str) -> tuple[dict[str, Any], Path, dict[str, Any]]:
        _require(provenance.SHA256_RE.fullmatch(identity_sha256 or "") is not None, "candidate identity digest is malformed")
        state = self.store.load()
        record = state["releases"].get(identity_sha256)
        _require(record is not None, "exact retained candidate is unknown")
        _require(record["identity"]["artifact_class"] == provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "development artifact cannot enter activation")
        identity = provenance.TrustedReleaseIdentity(**record["identity"])
        provenance.validate_trusted_release_identity(identity)
        release_path = self.store.root / record["publication_name"]
        self.store._verify_owned_release(release_path, record)
        return record["identity"], release_path, record

    def verify_prepared_candidate(self, identity_sha256: str, preparation_metadata_sha256: str) -> PreparedCandidateEvidence:
        """Historical inspection of one exact committed preparation."""
        identity, release_path, _ = self._candidate(identity_sha256)
        _require(provenance.SHA256_RE.fullmatch(preparation_metadata_sha256 or "") is not None, "preparation metadata digest is malformed")
        state = self.store.load()
        prep_ops = [item for item in state["operations"].values() if item["release_sha256"] == identity_sha256 and item["kind"] == "immutable-runtime-preparation" and item.get("phase") == "completed" and item.get("metadata_sha256") == preparation_metadata_sha256]
        _require(len(prep_ops) == 1, "exact completed preparation record is missing or ambiguous")
        candidate_dir = self.prepared_root / f"candidate-{identity_sha256}"
        _require(candidate_dir.is_dir() and not candidate_dir.is_symlink(), "prepared candidate material is missing")
        metadata_path = candidate_dir / "preparation.json"
        metadata_raw = provenance._read_bounded_bytes(metadata_path, 4 * 1024 * 1024, "preparation metadata")
        _require(metadata_raw == preparation._canonical(metadata := json.loads(metadata_raw.decode("utf-8"))) + b"\n", "preparation metadata is not canonical")
        _require(hashlib.sha256(metadata_raw).hexdigest() == preparation_metadata_sha256, "preparation metadata digest changed")
        parsed = preparation._read_preparation(metadata_path)
        candidate = parsed.get("candidate")
        _require(isinstance(candidate, dict) and candidate.get("identity_sha256") == identity_sha256 and candidate.get("identity") == identity, "preparation candidate identity changed")
        _require(parsed.get("status") == "prepared-not-activated", "preparation is not a completed non-activated record")
        _require(candidate.get("image") == identity["image"] and candidate.get("image_digest") == identity["image_digest"] and candidate.get("platform") == identity["platform"], "prepared pinned image identity changed")
        runtime = candidate_dir / "runtime"
        actual_runtime = preparation._integrity(runtime)
        _require(actual_runtime == candidate.get("runtime_integrity"), "prepared runtime integrity changed")
        baseline = self.store.legacy_baseline_status()
        _require(baseline.get("status") == "preserved-verified", "preserved legacy baseline is unavailable")
        legacy = parsed.get("legacy")
        _require(isinstance(legacy, dict) and legacy.get("integrity") == baseline.get("integrity"), "preparation legacy binding changed")
        legacy_runtime = Path(baseline["runtime_path"])
        _require(preparation._integrity(legacy_runtime, maximum_bytes=preparation.MAX_LEGACY_BYTES, maximum_entries=preparation.MAX_LEGACY_ENTRIES) == baseline["integrity"], "preserved legacy runtime integrity changed")
        _require(candidate.get("archive_validation") is not None, "preparation archive validation evidence is missing")
        preparation._verify_existing_preparation(candidate_dir, identity, identity_sha256, release_path / "artifact-service.zip", self.run_metadata, expected_metadata_sha256=preparation_metadata_sha256, durable=self.store.require_durable)
        return PreparedCandidateEvidence(identity_sha256, preparation_metadata_sha256, metadata_path, actual_runtime, baseline["integrity"])

    def _activation_admission(self, identity_sha256: str, preparation_metadata_sha256: str) -> PreparedCandidateEvidence:
        """Fresh, current admission; historical inspection is not authority."""
        self._admit_resources()
        evidence = self.verify_prepared_candidate(identity_sha256, preparation_metadata_sha256)
        identity, _, _ = self._candidate(identity_sha256)
        self.store.verify_retained_offline(identity_sha256, trusted_root=self.trusted_root, trusted_root_version=self.trusted_root_version, authorization_public_key=self.trust.public_key_path, authorization_key_id=self.trust.expected_key_id, authorization_key_fingerprint=self.trust.expected_public_key_sha256, authorization_allowlist=self._allowlist_path())
        self._verify_delivery_reservation(identity, self.store.root / f"release-{identity_sha256}", self.delivery_envelope, self.delivery_journal)
        return evidence

    def _allowlist_path(self) -> Path:
        value = getattr(self, "authorization_allowlist_path", None)
        _require(isinstance(value, Path), "independent authorization allowlist path is required")
        return value

    def _operation_binding(self, operation: dict[str, Any], *, generation: int | None = None, recovery_kind: str | None = None, authorization_retry_key: str | None = None) -> dict[str, Any]:
        return activation_binding(operation_id=operation["operation_id"], retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"], expected_pointer_generation=operation["expected_pointer_generation"] if generation is None else generation, destination=str(self.prepared_root), recovery_kind=recovery_kind, authorization_retry_key=authorization_retry_key)

    @staticmethod
    def _authorization_retry_key(envelope: dict[str, Any]) -> str:
        record = envelope.get("record") if isinstance(envelope, dict) else None
        authorization = record.get("authorization") if isinstance(record, dict) else None
        retry_key = authorization.get("retry_key") if isinstance(authorization, dict) else None
        _require(isinstance(retry_key, str) and retry_key != "", "authorization retry identity is missing")
        return retry_key

    def _proof(self, operation_id: str, authorization: provenance.IndependentReleaseAuthorization, candidate_release: str, preparation_metadata_sha256: str, pointer_generation: int, state: str) -> dict[str, Any]:
        return {"operation_id": operation_id, "candidate_release": candidate_release, "preparation_metadata_sha256": preparation_metadata_sha256, "record_sha256": authorization.verification.record_sha256, "authorization_id": authorization.authorization_id, "retry_key": authorization.retry_key, "scope": authorization.scope, "state": state, "pointer_generation": pointer_generation, "observed_at": provenance._now_utc().isoformat().replace("+00:00", "Z")}

    def _verify_activation_authorization(self, envelope: dict[str, Any], identity: dict[str, Any], *, operation: str, binding: dict[str, Any], now: datetime | None = None, historical: bool = False) -> provenance.IndependentReleaseAuthorization:
        _require(operation in {ACTIVATION_AUTHORIZATION_FORWARD, ACTIVATION_AUTHORIZATION_RECOVERY}, "activation authorization operation is invalid")
        authorization = provenance.verify_signed_authorization_record(envelope, self.trust, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, now=now, historical=historical)
        _require(authorization.context == provenance.OWNER_APPROVED_ACTIVATION_AUTHORIZATION_CONTEXT, "delivery-only authorization cannot establish activation permission")
        _require(authorization.scope == operation, "activation authorization scope does not match the requested operation")
        _require(authorization.verification_context_sha256 == activation_binding_digest(binding), "activation authorization is not bound to the exact operation")
        return authorization

    def _verify_delivery_reservation(self, identity: dict[str, Any], release_path: Path, envelope: dict[str, Any], journal: provenance.AuthorizationReplayJournal, *, now: datetime | None = None) -> None:
        retained_path = release_path / "authorization-envelope.json"
        retained_raw = provenance._read_bounded_bytes(retained_path, provenance.MAX_AUTHORIZATION_RECORD_BYTES, "retained delivery authorization")
        _require(retained_raw == provenance._canonical_json(envelope) + b"\n", "delivery authorization does not match retained evidence")
        candidate = provenance.TrustedReleaseIdentity(**identity)
        delivery = provenance.verify_signed_authorization_record(envelope, self.trust, candidate, self.revision_allowlist, now=now)
        _require(delivery.context == provenance.OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT and delivery.scope == "forward-release" and delivery.delivery_destination == str(self.store.root), "retained delivery authority is not the exact candidate-delivery contract")
        journal.assert_reserved(envelope, candidate, self.revision_allowlist, self.trust, operation="forward-release", now=now)

    def begin(self, *, operation_id: str, retry_key: str, identity_sha256: str, preparation_metadata_sha256: str, envelope: dict[str, Any], rollback_target: str | None, now: datetime | None = None) -> dict[str, Any]:
        evidence = self._activation_admission(identity_sha256, preparation_metadata_sha256)
        with self._locked():
            identity, _, _ = self._candidate(identity_sha256)
            retained_path = self.store.root / f"release-{identity_sha256}"
            self._verify_delivery_reservation(identity, retained_path, self.delivery_envelope, self.delivery_journal, now=now)
            state = self.store.load()
            binding = activation_binding(operation_id=operation_id, retry_key=retry_key, candidate_release=identity_sha256, preparation_metadata_sha256=preparation_metadata_sha256, incumbent_release=state["active_release"], previous_known_good_release=state["previous_known_good_release"], rollback_target=rollback_target, expected_pointer_generation=state["pointer_generation"], destination=str(self.prepared_root))
            authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now)
            self.journal.assert_reserved(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, now=now)
            proof = self._proof(operation_id, authorization, identity_sha256, preparation_metadata_sha256, state["pointer_generation"], "reserved")
            return self.store.begin_activation(operation_id=operation_id, retry_key=retry_key, candidate_release=evidence.identity_sha256, preparation_metadata_sha256=evidence.preparation_metadata_sha256, authorization_record_sha256=authorization.verification.record_sha256, authorization_id=authorization.authorization_id, authorization_scope=authorization.scope, rollback_target=rollback_target, expected_pointer_generation=state["pointer_generation"], authority_proof=proof, assume_locked=True)

    def consume(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        _require(operation["phase"] in {"validated-intent", "authorization-consumption-pending"}, "activation authorization cannot be consumed from the current phase")
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = self._operation_binding(operation)
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["authorization_record_sha256"] and authorization.retry_key == operation["retry_key"], "activation authorization does not match durable intent")
        with self._locked():
            if operation["phase"] == "validated-intent":
                pending_proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], operation["expected_pointer_generation"], "reserved")
                self.store.transition_activation(operation_id, phase="authorization-consumption-pending", expected_phase="validated-intent", authority_proof=pending_proof, assume_locked=True)
            self.journal.consume(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, now=now)
            consumed_proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], operation["expected_pointer_generation"], "consumed")
            return self.store.transition_activation(operation_id, phase="authorization-consumed", expected_phase="authorization-consumption-pending", authority_proof=consumed_proof, assume_locked=True)

    def reconcile(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        if operation["phase"] not in {"validated-intent", "authorization-consumption-pending"}:
            return operation
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = self._operation_binding(operation)
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now, historical=True)
        _require(authorization.verification.record_sha256 == operation["authorization_record_sha256"], "reconciliation authorization digest conflicts with durable intent")
        observed = self.journal.inspect(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, allow_consumed=True, now=now)
        if observed["state"] == "consumed":
            consumed_proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], operation["expected_pointer_generation"], "consumed")
            with self._locked():
                if operation["phase"] == "validated-intent":
                    self.store.transition_activation(operation_id, phase="authorization-consumption-pending", expected_phase="validated-intent", authority_proof=consumed_proof, assume_locked=True)
                return self.store.transition_activation(operation_id, phase="authorization-consumed", expected_phase="authorization-consumption-pending", authority_proof=consumed_proof, assume_locked=True)
        _require(observed["state"] == "reserved", "activation replay state is malformed or conflicting")
        return operation

    def observe(self, operation_id: str, *, phase: str, outcome: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
        _require(phase in retention.ACTIVATION_OBSERVED_PHASES, "activation observation phase is invalid")
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        proof = operation["rollback_consumption"] or operation["forward_consumption"]
        _require(proof is not None, "activation observation requires durable replay consumption")
        evidence = {"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": phase, "outcome": outcome, "operation_id": operation_id, "candidate_release": operation["candidate_release"], "runtime_identity_sha256": operation["runtime_identity_sha256"], "details": details or {}}
        with self._locked():
            return self.store.transition_activation(operation_id, phase=phase, observation=evidence, authority_proof=proof, assume_locked=True)

    def advance(self, operation_id: str, phase: str) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        proof = operation["rollback_consumption"] or operation["forward_consumption"]
        _require(proof is not None, "activation transition requires durable replay consumption")
        with self._locked():
            return self.store.transition_activation(operation_id, phase=phase, authority_proof=proof, assume_locked=True)

    def begin_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        """Bind and persist a separately authorized compensating recovery."""
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None and operation["phase"] in {"successful-activation", "candidate-start-observed", "candidate-health-verified"}, "rollback requires a failed candidate or successful activation")
        identity, _, _ = self._candidate(operation["candidate_release"])
        recovery_kind = "post-activation" if operation["phase"] == "successful-activation" else "compensation"
        state = self.store.load()
        recovery_retry_key = self._authorization_retry_key(envelope)
        binding = self._operation_binding(operation, generation=state["pointer_generation"], recovery_kind=recovery_kind, authorization_retry_key=recovery_retry_key)
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now)
        self.journal.assert_reserved(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, now=now)
        proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], state["pointer_generation"], "reserved")
        with self._locked():
            return self.store.start_activation_rollback(operation_id, authorization_record_sha256=authorization.verification.record_sha256, authorization_id=authorization.authorization_id, retry_key=authorization.retry_key, rollback_kind=recovery_kind, authority_proof=proof, assume_locked=True)

    def consume_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None and operation["phase"] == "compensation-authorization-consumption-pending", "rollback authorization cannot be consumed from the current phase")
        identity, _, _ = self._candidate(operation["candidate_release"])
        recovery_kind = operation["rollback_kind"]
        _require(recovery_kind in {"compensation", "post-activation"}, "rollback recovery kind is missing")
        binding = self._operation_binding(operation, generation=operation["rollback_expected_pointer_generation"], recovery_kind=recovery_kind, authorization_retry_key=operation["rollback_retry_key"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["rollback_authorization_record_sha256"] and authorization.retry_key == operation["rollback_retry_key"], "rollback authorization does not match durable intent")
        with self._locked():
            self.journal.consume(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, now=now)
            proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], operation["rollback_expected_pointer_generation"], "consumed")
            return self.store.transition_activation(operation_id, phase="rollback-intent", expected_phase="compensation-authorization-consumption-pending", authority_proof=proof, assume_locked=True)

    def reconcile_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        if operation["phase"] != "compensation-authorization-consumption-pending":
            return operation
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = self._operation_binding(operation, generation=operation["rollback_expected_pointer_generation"], recovery_kind=operation["rollback_kind"], authorization_retry_key=operation["rollback_retry_key"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now, historical=True)
        _require(authorization.verification.record_sha256 == operation["rollback_authorization_record_sha256"], "rollback reconciliation authorization digest conflicts with durable intent")
        observed = self.journal.inspect(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, allow_consumed=True, now=now)
        _require(observed["state"] in {"reserved", "consumed"}, "rollback replay state is malformed or conflicting")
        if observed["state"] == "consumed":
            proof = self._proof(operation_id, authorization, operation["candidate_release"], operation["preparation_metadata_sha256"], operation["rollback_expected_pointer_generation"], "consumed")
            with self._locked():
                return self.store.transition_activation(operation_id, phase="rollback-intent", expected_phase="compensation-authorization-consumption-pending", authority_proof=proof, assume_locked=True)
        return operation

