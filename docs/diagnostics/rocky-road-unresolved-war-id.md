# Rocky Road post-sync war-mail failure diagnosis

## 1. Completed conclusion

The Rocky Road failure was a transient active-war identity race, and the branch now contains the completed fix.

The final Confirm and Send path still rerenders the mail from live state before sending, but it now uses the shared active-war resolver and returns a reason-coded failure message when identity resolution is not safe enough to proceed. The old single-point null guard is still present, but it is now reached only after the resolver has had a chance to repair, preserve, or reject the identity.

The implemented fix covers:

- canonical post-war points staging from the resolver-owned identity tuple;
- reason-coded final-send blocking when the send-time rerender is unsafe;
- pre-resolution observability that preserves the original persisted row in logs;
- handler-level regression coverage for the actual Confirm and Send buttons;
- operator guidance for retryable versus administrator-only recovery paths.

## 2. Original behavior

Before the fix, the mail send path could fail when the live rerender had not yet converged on a safe active-war identity.

Key characteristics of the original behavior:

- the mail renderer read live CoC state and the `CurrentWar` row, then refused to send if the rerendered `warId` was null;
- the send path treated that null result as a hard stop instead of surfacing the resolver reason that led there;
- the post-war points staging path still depended on a candidate live-field dependency after identity resolution;
- observability summarized the post-write row in places where the pre-resolution target row was the more important diagnostic signal.

The incident evidence still matters, but the implementation now reflects the completed architecture rather than an open recommendation.

## 3. Implemented fix

### Active-war identity policies

`ActiveWarIdentityService.resolveCurrentWarId()` now acts as the canonical owner of active-war identity resolution.

The resolver policies are:

- `poll_reconcile`
  - authoritative poller transition owner;
  - may allocate or transition a trusted complete identity.
- `interactive_materialize`
  - may repair a missing ID only for an exact persisted physical identity;
  - cannot rotate a stale non-null identity;
  - cannot own a new-war transition.
- `preserve_persisted`
  - reuses the trusted persisted identity during outage recovery or ended-war handling;
  - does not allocate or overwrite from degraded data.

### Row ownership and locking

The resolver keeps the row-owner and physical-war locking boundaries intact:

- the target `CurrentWar` row is locked first;
- the exact physical identity is then guarded with the existing advisory lock;
- same-war cross-guild ID reuse is allowed only when the physical identity matches and the global exact-ID lookup is conflict-free;
- conflicting global exact IDs remain fail-closed.

### Sequence allocation

The existing sequence allocation behavior remains in place:

- `poll_reconcile` may allocate a new ID for a trusted complete identity;
- `interactive_materialize` may allocate only when the persisted row is an exact physical match and the ID is missing;
- `preserve_persisted` does not allocate.

### Final confirmation rerender

The final mail confirmation handlers now depend on the latest rerender, not on the preview snapshot.

Behavior now is:

- if the rerender returns a blocked active-war identity reason, the handler returns the mapped user-facing error and stops before any send-side effects;
- if the rerender returns a resolved identity, the normal send path proceeds;
- confirm-with-ping and confirm-without-ping both use the same identity guard;
- mention semantics remain unchanged.

### Reason-coded user errors

The blocked reasons now surface actionable messages instead of a generic unresolved-ID stop:

- `partial_live_identity`
- `missing_current_row`
- `persisted_identity_mismatch`
- `missing_preserved_id`
- `conflicting_global_identity_ids`
- `persistence_failure`

### Exact downstream guards

The send path still keeps the existing downstream protections:

- channel fetch validation;
- war ID validation;
- mail revision gating;
- lifecycle persistence;
- posted-message bookkeeping;
- points confirmation tracking;
- notify refresh after send.

## 4. Current operator recovery

### Retryable through `/force poll war-events`

These can succeed on retry when CoC supplies a complete trustworthy identity and persistence succeeds:

- `partial_live_identity`
- `missing_current_row`
- `persisted_identity_mismatch`
- `missing_preserved_id`
- transient `persistence_failure`

### Administrator repair required

These remain fail-closed and need bot-admin intervention:

- `conflicting_global_identity_ids`
- repeated persistence failure after successful polling
- structurally missing or invalid tracking configuration

Mail should not be manually attached to an unverified ID.

## 5. Evidence and incident record

### What happened

Rocky Road entered a new preparation war, `/fwa match` rendered the matchup, and the final confirmation rerender briefly observed a non-safely-resolved active-war identity. The later recovery state shows the same war converged successfully once the resolver and poller aligned.

### Why that was enough to fail

The send path requires a safe active-war identity before it can persist a posted mail lifecycle. When the rerender cannot prove that identity, the send is blocked.

### Why the implementation is correct now

The resolver now owns the active-war identity semantics, the send-time rerender uses that resolver, and the diagnostics preserve both the pre-resolution target row and the post-write row separately.

## 6. Validation and observability

The resolver emits bounded structured observability under the `active_war_identity_resolution` stage:

- telemetry stage name: `active_war_identity_resolution`
- structured log prefix: `[active-war-identity]`
- event kind: `active_war_identity_resolution`
- caller and policy
- candidate identity
- pre-resolution persisted identity
- resolved ID and source
- reason code
- allocation, preservation, persistence, and validation flags
- duration and correlation IDs

Steady-state logging works as follows:

- the first or changed `existing_exact_row` signature logs at `info`;
- unchanged repeats are downgraded to `debug` by `SteadyStateLogGate`;
- blocked and mutating outcomes remain `warn`, `error`, or `info` as appropriate and are not hidden by the gate;
- stage timing still records every attempt.

In Dozzle, look for the `active-war-identity` log prefix. In telemetry rollups, the stage is `active_war_identity_resolution`.

## 7. Production evidence retained

The original production facts are still useful:

- the tracked clan was Rocky Road `#2RYGLU2UY`;
- the failure was transient and later recovered to the same active-war identity;
- the active-war poller and the mail confirmation path were operating on slightly different timing windows;
- the FWA watch and points-side cadence were not the rescue path for this incident.

Those facts explain the race, but they no longer define the implementation direction. The fix is implemented and covered by regression tests.
