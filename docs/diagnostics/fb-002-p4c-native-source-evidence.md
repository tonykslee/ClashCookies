# FB-002 P4c — Native source evidence boundary

Status: implemented fail-closed foundation on `feature/compo-native-source-evidence`; not production-verified and not an activation decision.

## Decision

Native reference candidates remain diagnostic-only. The persisted `FwaTrackedClanWarRosterCurrent` path remains `UNKNOWN` because it has no independently retained proof that its latest member rows belong to one exact FWA war, no raw-payload completeness record, no per-member source batch binding, and no historical observation owner. A complete-looking 50-row current snapshot is therefore an observation, not authoritative native evidence.

Synthetic fixtures may still exercise the candidate algorithm. Their artifact now carries a separate `sourceAuthority` decision whose publication status is `UNAVAILABLE`; synthetic counts do not become runtime targets.

## Implemented contract

`FwaStatsClient.fetchWarMembersEvidence` evaluates the raw `WarMembers.json?warNo=1` payload through the same shared parser used by factual WarMembers consumers. It records one row evaluation for every raw row, so ordinary parser acceptance, parser rejection, and native-evidence eligibility cannot drift. Any caller-supplied accepted-row projection is only a compatibility assertion; it can produce `accepted_rows_mismatch`, but it cannot establish evidence.

It records:

- raw, parser-accepted, parser-rejected/discarded, evidence-eligible, and evidence-ineligible row counts and indexes;
- per-row raw/normalized fingerprints, parser status/reasons, evidence status/reasons, and normalized identity/position/weight;
- structural validity, duplicate player/position checks, exact position coverage when a declared roster size exists;
- direct positive-integer weight checks and declared total comparison when a source total exists;
- normalized opponent identity observations and conflicts;
- local observation/ingestion timestamps, deterministic order-independent raw and accepted-row fingerprints, and a contract version;
- explicit `VERIFIED`, `UNAVAILABLE`, or `CONFLICTING` status for structural, completeness, weight, exact-war binding, source-generation, and candidate-eligibility dimensions;
- deterministic reason codes.

The live FWAStats payload currently does not declare roster size or total weight, does not provide a documented exact upstream war identifier for `warNo=1`, and does not bind a durable source generation across concurrent writers or restarts. Missing declared size/total is therefore `UNAVAILABLE`, not a contradiction. An actual declared-size/total mismatch, malformed parser row, invalid direct weight/position, duplicate identity/position, contradictory opponent, or raw-to-normalized correspondence mismatch is `CONFLICTING`. Whole-source weight proof also requires zero parser-rejected rows; a declared total that matches only parser-accepted rows cannot produce `VERIFIED`. Completeness requires distinct player identities, distinct positions, and no discarded rows. Consequently, even a structurally clean payload reports exact-war binding and source generation as `UNAVAILABLE`, and cannot authorize native evidence.

The existing normalized row consumers remain available. Invalid or partial rows are not silently treated as qualifying native source evidence. The sync diagnostic log reports the bounded evidence statuses/reasons without changing scheduler cadence or feed ownership.

The candidate artifact separately records diagnostic candidate eligibility and reference-publication authority. A SHA-256 fingerprint detects changed content but is not authentication or source identity proof.

## Authority decision matrix

| Evidence dimension | Current implementation | Native authority |
| --- | --- | --- |
| Source facts and normalized rows | Observed by FWAStats client | Factual only |
| Raw payload structure/discarded rows | Evaluated in `FwaWarMembersSourceEvidence` | Required, not sufficient |
| Exact `1..N` roster coverage | Verified only if the source declares `N`; live source does not | Required |
| Direct weights and declared totals | Evaluated; imputed/effective-only values are not direct proof | Required |
| Exact FWA war identity | No current upstream proof path | `UNAVAILABLE` |
| FWA classification / opponent | Observed tags are diagnostic; matching tags/timestamps are not proof | `UNAVAILABLE` unless independently attested |
| Source generation / replay / contradiction history | Fingerprint is diagnostic; current state has no durable history owner | `UNAVAILABLE` |
| Persisted current roster | Latest-only derived rows from separate owners | `UNKNOWN` |
| Synthetic fixture | Explicitly non-production diagnostic input | Never publishable |
| Reference publication | Owned by later approved milestone | Forbidden in P4c |

## Schema and concurrency gate

No migration is included or authorized. The current schema cannot durably preserve the required immutable evidence across process restarts and distinct wars. A future owner-approved migration would need an immutable source-observation table with a unique `(clan, exact upstream war identity, source batch/content fingerprint)` key, raw/accepted counts, declared roster and totals, exact FWA classification provenance, immutable member observations with direct-weight provenance, and a durable source-generation/fencing token. Writers would need to publish the observation and any derived projection under the same per-clan transaction/advisory-lock boundary; duplicate observations would be idempotent, contradictory repeats would be retained as conflicts, and stale generations would be rejected. Existing current-state rows could remain readable for factual consumers but would not be backfilled as `VERIFIED`.

Until that migration and the upstream proof contract are approved, a transaction-scoped lock around a current-state write would not be sufficient to prove that an older in-flight fetch did not overwrite a newer source generation. The implementation therefore does not claim live PostgreSQL contention verification or historical replay protection for the current feed tables; native authority remains unavailable.

## Validation boundary

The diagnostic CLI remains read-only. P3 threshold `10` remains an engineering diagnostic threshold, not a production confidence policy. `validateFwaWarMembersSourceEvidence` checks the full count/index/row/status/fingerprint schema, cross-field array/count/eligibility/identity/position/declared-total invariants, and requires exact-war binding and source generation to remain `UNAVAILABLE`; a recomputed SHA-256 is only an internal consistency check, never authenticity. TH19 targets remain inactive, the legacy-v1 profile remains active, and no HeatMapRef rows or provenance are replaced.
