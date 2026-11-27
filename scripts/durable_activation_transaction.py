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


def activation_binding(*, operation_id: str, retry_key: str, candidate_release: str, preparation_metadata_sha256: str, incumbent_release: str | None, previous_known_good_release: str | None, rollback_target: str | None) -> dict[str, Any]:
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

    def __init__(self, store: retention.RetentionStore, *, prepared_root: Path, journal: provenance.AuthorizationReplayJournal, trust: provenance.AuthorizationTrustConfig, revision_allowlist: provenance.AuthorizationRevisionAllowlist):
        self.store = store
        self.prepared_root = prepared_root
        self.journal = journal
        self.trust = trust
        self.revision_allowlist = revision_allowlist
        _require(prepared_root.is_absolute() and prepared_root.is_dir() and not prepared_root.is_symlink(), "prepared runtime root is unavailable")
        _require(prepared_root.resolve() != store.root.resolve(), "prepared runtime root must be separate from retention publication")

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

    def verify_prepared_candidate(self, identity_sha256: str, preparation_metadata_sha256: str, *, run_metadata: dict[str, Any] | None = None) -> PreparedCandidateEvidence:
        """Revalidate the committed preparation record and runtime tree only."""
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
        # When the exact immutable run correlation is supplied, reuse the
        # preparation module's archive-bound validator.  There is no second
        # archive parser here.  The metadata-only form remains useful for
        # restart inspection, but cannot be treated as fresh provenance.
        _require(candidate.get("archive_validation") is not None, "preparation archive validation evidence is missing")
        if run_metadata is not None:
            preparation._verify_existing_preparation(candidate_dir, identity, identity_sha256, release_path / "artifact-service.zip", run_metadata, expected_metadata_sha256=preparation_metadata_sha256, durable=False)
        return PreparedCandidateEvidence(identity_sha256, preparation_metadata_sha256, metadata_path, actual_runtime, baseline["integrity"])

    def _verify_activation_authorization(self, envelope: dict[str, Any], identity: dict[str, Any], *, operation: str, binding: dict[str, Any], now: datetime | None = None) -> provenance.IndependentReleaseAuthorization:
        _require(operation in {ACTIVATION_AUTHORIZATION_FORWARD, ACTIVATION_AUTHORIZATION_RECOVERY}, "activation authorization operation is invalid")
        authorization = provenance.verify_signed_authorization_record(envelope, self.trust, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, now=now)
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

    def begin(self, *, operation_id: str, retry_key: str, identity_sha256: str, preparation_metadata_sha256: str, envelope: dict[str, Any], rollback_target: str | None, now: datetime | None = None, run_metadata: dict[str, Any] | None = None, delivery_envelope: dict[str, Any] | None = None, delivery_journal: provenance.AuthorizationReplayJournal | None = None) -> dict[str, Any]:
        evidence = self.verify_prepared_candidate(identity_sha256, preparation_metadata_sha256, run_metadata=run_metadata)
        _require((delivery_envelope is None) == (delivery_journal is None), "delivery reservation inputs must be supplied together")
        identity, release_path, _ = self._candidate(identity_sha256)
        if delivery_envelope is not None and delivery_journal is not None:
            self._verify_delivery_reservation(identity, release_path, delivery_envelope, delivery_journal, now=now)
        state = self.store.load()
        binding = activation_binding(operation_id=operation_id, retry_key=retry_key, candidate_release=identity_sha256, preparation_metadata_sha256=preparation_metadata_sha256, incumbent_release=state["active_release"], previous_known_good_release=state["previous_known_good_release"], rollback_target=rollback_target)
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now)
        self.journal.assert_reserved(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, now=now)
        return self.store.begin_activation(operation_id=operation_id, retry_key=retry_key, candidate_release=evidence.identity_sha256, preparation_metadata_sha256=evidence.preparation_metadata_sha256, authorization_record_sha256=authorization.verification.record_sha256, authorization_id=authorization.authorization_id, authorization_scope=authorization.scope, rollback_target=rollback_target, expected_pointer_generation=state["pointer_generation"])

    def consume(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        _require(operation["phase"] in {"validated-intent", "authorization-consumption-pending"}, "activation authorization cannot be consumed from the current phase")
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = activation_binding(operation_id=operation_id, retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["authorization_record_sha256"] and authorization.retry_key == operation["retry_key"], "activation authorization does not match durable intent")
        if operation["phase"] == "validated-intent":
            self.store.transition_activation(operation_id, phase="authorization-consumption-pending", expected_phase="validated-intent")
        self.journal.consume(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, now=now)
        return self.store.transition_activation(operation_id, phase="authorization-consumed", expected_phase="authorization-consumption-pending")

    def reconcile(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        if operation["phase"] != "authorization-consumption-pending":
            return operation
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = activation_binding(operation_id=operation_id, retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_FORWARD, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["authorization_record_sha256"], "reconciliation authorization digest conflicts with durable intent")
        observed = self.journal.inspect(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_FORWARD, allow_consumed=True, now=now)
        if observed["state"] == "consumed":
            return self.store.transition_activation(operation_id, phase="authorization-consumed", expected_phase="authorization-consumption-pending")
        _require(observed["state"] == "reserved", "activation replay state is malformed or conflicting")
        return operation

    def observe(self, operation_id: str, *, phase: str, outcome: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
        _require(phase in retention.ACTIVATION_OBSERVED_PHASES, "activation observation phase is invalid")
        evidence = {"contract": "clashcookies.activation-observation", "version": 1, "source": "isolated-test-harness", "phase": phase, "outcome": outcome, "details": details or {}}
        return self.store.transition_activation(operation_id, phase=phase, observation=evidence)

    def advance(self, operation_id: str, phase: str) -> dict[str, Any]:
        return self.store.transition_activation(operation_id, phase=phase)

    def begin_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        """Bind and persist a separately authorized compensating recovery."""
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None and operation["phase"] == "successful-activation", "rollback requires a successful activation")
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = activation_binding(operation_id=operation_id, retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now)
        self.journal.assert_reserved(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, now=now)
        return self.store.start_activation_rollback(operation_id, authorization_record_sha256=authorization.verification.record_sha256, authorization_id=authorization.authorization_id, retry_key=authorization.retry_key)

    def consume_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None and operation["phase"] == "rollback-intent", "rollback authorization cannot be consumed from the current phase")
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = activation_binding(operation_id=operation_id, retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["rollback_authorization_record_sha256"] and authorization.retry_key == operation["rollback_retry_key"], "rollback authorization does not match durable intent")
        self.journal.consume(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, now=now)
        return operation

    def reconcile_rollback(self, operation_id: str, envelope: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
        state = self.store.load()
        operation = state["activation_operations"].get(operation_id)
        _require(operation is not None, "activation operation is unknown")
        if operation["phase"] != "rollback-intent":
            return operation
        identity, _, _ = self._candidate(operation["candidate_release"])
        binding = activation_binding(operation_id=operation_id, retry_key=operation["retry_key"], candidate_release=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], incumbent_release=operation["incumbent_release"], previous_known_good_release=operation["previous_known_good_release"], rollback_target=operation["rollback_target"])
        authorization = self._verify_activation_authorization(envelope, identity, operation=ACTIVATION_AUTHORIZATION_RECOVERY, binding=binding, now=now)
        _require(authorization.verification.record_sha256 == operation["rollback_authorization_record_sha256"], "rollback reconciliation authorization digest conflicts with durable intent")
        observed = self.journal.inspect(envelope, provenance.TrustedReleaseIdentity(**identity), self.revision_allowlist, self.trust, operation=ACTIVATION_AUTHORIZATION_RECOVERY, allow_consumed=True, now=now)
        _require(observed["state"] in {"reserved", "consumed"}, "rollback replay state is malformed or conflicting")
        return operation

