# FB-028B-3d-1 — Durable activation transaction

Status: implemented as a non-operational repository foundation; production remains **NO-GO**.

## Retrospective P0 corrections

The post-merge review of PR #2198 identified three narrow defects, corrected on
the follow-up feature branch before any operational 3d-2 work:

- Rollback reconciliation now reopens the canonical deployment and retention
  locks, reloads the exact retention state, and re-fsyncs both the state file
  and publication directory before returning an already-terminal result.
  Persistent file or directory fsync failure remains an error; a fresh retry
  must complete the durability check before reporting success.
- `ActivationTransaction.advance()` now derives and validates the actual
  forward/recovery replay authority before it can reconcile or consume the
  retained delivery reservation. Missing, conflicting, or substituted forward
  journal evidence therefore leaves delivery authority reserved.
- Retention validation now checks every stored observation, including
  historical observations in terminal records, for exact contract, phase,
  outcome, operation, runtime identity, subject, subject release, and bound
  detail fields. It also enforces phase prerequisite chains, recovery resume
  coherence, rollback binding, and per-transaction pointer-generation rules
  without requiring historical terminal records to match the current
  generation.

The regressions are covered by the activation boundary tests and the retained
state mutation test. Genuine Linux coordinator coverage remains authoritative
for descriptor durability, process interruption, lock ordering, replay
reconciliation, and Docker/filesystem behavior; Windows skips do not count as
Linux evidence. Synthetic attestation seams remain explicitly non-authoritative.

## Ownership and contract

`durable_artifact_retention.py` remains the single owner of `retention-state.json`, release custody, active/previous-known-good pointers, pointer generation, and garbage-collection protection. State version 2 accepts an existing version-1 document only through an exact validated compatibility upgrade; missing, malformed, or material-bearing state is never initialized over. Activation operations are stored inside this retention state, not in a competing active-release store.

Each activation operation binds the candidate/runtime identity digest, completed preparation metadata digest, signed activation record digest, authorization ID and retry identity, operation ID, incumbent, previous-known-good release, actual rollback target, destination, exact pointer generation, and forward/recovery kind. Forward, delivery, and rollback replay consumption proofs are persisted in the retention record. At most one operation may be unresolved; the bounded operation table fails closed when full and requires explicit history retirement rather than silently evicting terminal evidence. Candidate and recovery-referenced non-pointer releases receive `recovery-protected`; active, previous, and historically referenced releases remain protected. GC has no path to delete a transaction-protected or ambiguous publication.

## Authority boundary

The existing canonical Ed25519 verifier and replay journal now support the separate `owner-approved-production-activation-v1` context with `activation-forward` and `activation-recovery` scopes. A signed activation context digest binds the exact transaction tuple. The existing `owner-approved-production-candidate-delivery-v1` authorization remains delivery-only and cannot be reinterpreted as activation approval. Forward and recovery authorizations are separate replay records; a forward authorization, including an expired one, cannot grant a new rollback. Disposable keys and isolated fixtures are the only permitted test material.

## Preparation and reconciliation

Activation admission requires one exact completed immutable-preparation operation and its committed metadata digest, archive-bound runtime verification under independently trusted inputs, the exact retained delivery reservation, canonical FB-027 lock ownership, and bounded resource/inode headroom. Bounded resource admission is performed from trusted retained identity and committed preparation measurements before the archive validator may allocate a retry workspace or re-extract the archive, then rechecked after validation under the canonical locks. Historical inspection is separate from fresh activation admission. It rechecks retained release ownership, production-candidate identity, preparation contract/status, pinned image/platform, runtime tree integrity, preserved legacy baseline integrity, and archive-validation evidence through the existing preparation/provenance helpers. It does not require the original legacy checkout after a valid baseline capture and does not add an archive parser.

The intent is committed before authorization consumption. Both delivery and activation replay records must be durably consumed or exactly reconciled before incumbent-stop-intent; an illegal transition is checked before either journal can be consumed. The replay journal is then consumed under its existing lock and durability rules. If the process ends after journal consumption but before retention publication, reconciliation inspects the exact signed record and accepts only the matching consumed entry, including after expiry. Missing, malformed, conflicting, or substituted journal state fails closed; consumed authority is never reset to reserved and another authorization is never substituted. A terminal operation cannot be restarted as a fresh deployment.

An idempotent retry or reconciliation of a visible state update revalidates the complete state and re-fsyncs both the exact state file and its parent directory while holding the canonical lock. Persistent fsync failure remains an error; a cleared fault must complete the durability step before the transaction can proceed. The retention transition boundary independently requires the recorded delivery proof, exact retained delivery-record identity, and consumed forward activation proof before any incumbent-disruption phase.

## State machine and pointers

Legal phases are `validated-intent`, `authorization-consumption-pending`, `authorization-consumed`, `incumbent-stop-intent`, `incumbent-stop-observed`, `candidate-start-intent`, `candidate-start-observed`, `candidate-health-verified`, `successful-activation`, `rollback-intent`, `rollback-observed`, `successful-rollback`, and `recovery-required`. Intent and observed outcomes are separate durable fields. Observed outcomes require the explicit `isolated-test-harness` boundary in this slice, so caller-supplied health booleans cannot enter an operational activation path.

Active and previous-known-good pointers are published together in one retention-state update only after exact healthy candidate evidence. The incumbent remains known-good until that commit. The first promotion keeps the unauthenticated protected legacy baseline as previous-known-good; later promotions use the actual prior active release. Failed-candidate compensation is separately authorized and fenced to the actual incumbent without changing pointers; post-activation recovery is separately authorized and may publish a distinct incumbent target. Recovery-required persistence never adds a conflicting role to an active or previous pointer, and an interrupted recovery can resume only with its already-bound authority or exact consumed-record reconciliation. Rollback fences use the generation at recovery authorization, and compensation does not manufacture a pointer-generation change. No Docker image, prepared runtime, or live deployment material is deleted.

## Locking, tests, and limits

Later wrapper integration must retain the order `FB-027 deployment lock → retention activity lock → authorization replay journal` and must hand off ownership explicitly without reacquiring a non-reentrant lock. This slice uses the existing retention activity lock and journal lock; it does not create a deployment lock or operational executor.

The activation-specific Linux integration suite instantiates `ActivationTransaction` against retained/prepared fixtures and disposable Ed25519 keys. Its named coverage is `test_real_coordinator_first_activation_and_first_rollback`, `test_real_coordinator_three_successive_activations_and_subsequent_rollback`, `test_real_coordinator_failed_runtime_observations_compensate`, `test_real_coordinator_reconciliation_and_interrupted_rollback`, `test_real_coordinator_subprocess_termination_at_journal_boundaries`, `test_real_coordinator_lock_durability_and_gc_boundaries`, `test_real_coordinator_fsync_failure_requires_durable_retry`, `test_real_coordinator_delivery_proof_is_required_before_disruption`, and `test_real_coordinator_rejects_semantically_incomplete_persisted_activation` (nine coordinator tests). The fixtures use a synthetic GitHub-attestation verifier seam; they do not independently prove GitHub-native attestation. Genuine attestation verification remains covered by the separate runtime-artifact workflow. The coordinator tests exercise real Ed25519 signatures, replay journals, retained/prepared material, durable retention publication, exact delivery reservation, lock order, pre-extraction resource denial, failed stop/health compensation, subsequent authenticated-release rollback, same-authority expiry reconciliation, coordinator process termination, persistent and cleared fsync faults, delivery-gate enforcement, phase-level persisted-state validation, malformed evidence, and executed GC protection. Windows skips do not claim Linux directory-fsync, descriptor, subprocess-termination, or lock-contention guarantees. The bounded activation-history fail-closed policy is an explicit production release blocker for 3e and must be retired or replaced before any operational eligibility decision. The transaction slice remains non-operational: live VM access, production eligibility, migration, deployment, promotion, and merge are not implemented. Remaining blockers for 3d-2, 3d-3, and 3e are the owner-approved operational runtime boundary, VM/native/resource/readiness evidence, migration policy, singleton/health integration, wrapper handoff, production authorization issuance, bounded-history retirement, and live Linux end-to-end interruption evidence.
