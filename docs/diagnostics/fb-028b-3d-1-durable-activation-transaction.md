# FB-028B-3d-1 — Durable activation transaction

Status: implemented as a non-operational repository foundation; production remains **NO-GO**.

## Ownership and contract

`durable_artifact_retention.py` remains the single owner of `retention-state.json`, release custody, active/previous-known-good pointers, pointer generation, and garbage-collection protection. State version 2 accepts an existing version-1 document only through an exact validated compatibility upgrade; missing, malformed, or material-bearing state is never initialized over. Activation operations are stored inside this retention state, not in a competing active-release store.

Each activation operation binds the candidate/runtime identity digest, completed preparation metadata digest, signed activation record digest, authorization ID and retry identity, operation ID, incumbent, previous-known-good release, actual rollback target, destination, exact pointer generation, and forward/recovery kind. Forward and rollback replay consumption proofs are persisted in the retention record. At most one operation may be unresolved; terminal history is bounded and oldest terminal records are retired from the operation table only after the transaction is complete. Candidate and recovery-referenced non-pointer releases receive `recovery-protected`; active and previous pointers remain inherently protected. GC has no path to delete a transaction-protected or ambiguous publication.

## Authority boundary

The existing canonical Ed25519 verifier and replay journal now support the separate `owner-approved-production-activation-v1` context with `activation-forward` and `activation-recovery` scopes. A signed activation context digest binds the exact transaction tuple. The existing `owner-approved-production-candidate-delivery-v1` authorization remains delivery-only and cannot be reinterpreted as activation approval. Forward and recovery authorizations are separate replay records; a forward authorization, including an expired one, cannot grant a new rollback. Disposable keys and isolated fixtures are the only permitted test material.

## Preparation and reconciliation

Activation admission requires one exact completed immutable-preparation operation and its committed metadata digest, archive-bound runtime verification under independently trusted inputs, the exact retained delivery reservation, canonical FB-027 lock ownership, and bounded resource/inode headroom. Historical inspection is separate from fresh activation admission. It rechecks retained release ownership, production-candidate identity, preparation contract/status, pinned image/platform, runtime tree integrity, preserved legacy baseline integrity, and archive-validation evidence through the existing preparation/provenance helpers. It does not require the original legacy checkout after a valid baseline capture and does not add an archive parser.

The intent is committed before authorization consumption. The replay journal is then consumed under its existing lock and durability rules. If the process ends after journal consumption but before retention publication, reconciliation inspects the exact signed record and accepts only the matching consumed entry. Missing, malformed, conflicting, or substituted journal state fails closed; consumed authority is never reset to reserved and another authorization is never substituted. A terminal operation cannot be restarted as a fresh deployment.

## State machine and pointers

Legal phases are `validated-intent`, `authorization-consumption-pending`, `authorization-consumed`, `incumbent-stop-intent`, `incumbent-stop-observed`, `candidate-start-intent`, `candidate-start-observed`, `candidate-health-verified`, `successful-activation`, `rollback-intent`, `rollback-observed`, `successful-rollback`, and `recovery-required`. Intent and observed outcomes are separate durable fields. Observed outcomes require the explicit `isolated-test-harness` boundary in this slice, so caller-supplied health booleans cannot enter an operational activation path.

Active and previous-known-good pointers are published together in one retention-state update only after exact healthy candidate evidence. The incumbent remains known-good until that commit. The first promotion keeps the unauthenticated protected legacy baseline as previous-known-good; later promotions use the actual prior active release. Failed-candidate compensation is separately authorized and fenced to the actual incumbent without changing pointers; post-activation recovery is separately authorized and may publish a distinct incumbent target. Rollback fences use the generation at recovery authorization, and compensation does not manufacture a pointer-generation change. No Docker image, prepared runtime, or live deployment material is deleted.

## Locking, tests, and limits

Later wrapper integration must retain the order `FB-027 deployment lock → retention activity lock → authorization replay journal` and must hand off ownership explicitly without reacquiring a non-reentrant lock. This slice uses the existing retention activity lock and journal lock; it does not create a deployment lock or operational executor.

The regression suite uses disposable Ed25519-signed activation authority, a real retention publication fixture, durable replay reservation/consumption, failed-candidate compensation, three successive pointer transitions, and exact proof fencing. Linux CI additionally runs this suite alongside the genuine OpenSSH, Docker lifecycle, native Prisma, Runtime Artifact Round Trip, and process-interruption requirements. Windows skips do not claim Linux directory-fsync, descriptor, subprocess-termination, or lock-contention guarantees. The transaction slice remains non-operational: live VM access, production eligibility, migration, deployment, promotion, and merge are not implemented. Remaining blockers for 3d-2, 3d-3, and 3e are the owner-approved operational runtime boundary, VM/native/resource/readiness evidence, migration policy, singleton/health integration, wrapper handoff, production authorization issuance, and live Linux end-to-end interruption evidence.
