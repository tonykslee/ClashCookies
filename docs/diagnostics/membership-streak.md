# Membership streak diagnosis: `C54+/S1/A1`

Date of investigation: 2026-11-11 (database timestamps below are UTC)

Scope: read-only production investigation for guild `1324040917602013261`, using the configured guild and a bounded sample of five affected players plus one control. No backfill, migration, or persisted-state mutation was run.

## Executive diagnosis

The observed result is reproducible and is not caused by a missing player row in the latest war, a recent `SyncCycle` gap, a duplicate sync identity, or a CWL exemption failure.

At canonical sync `#587`, the affected Home clan `#82YLR9Q2` was recorded as a canonical `BL` war, not an `FWA` war. The five affected players are present in the complete 50-player canonical `BL` participation roster for that war. The same sync has five complete 50-player `FWA` rosters in other clans, and the affected players are absent from those FWA rosters. `MembershipStreakService` intentionally admits only `FWA` history for historical S/A evidence, so it derives `ABSENT` at `#587`. `ABSENT` is an exact negative, not `UNKNOWN`, and the consecutive algorithm stops both S and A at that boundary.

Therefore:

- `C` remains high because it is a nonconsecutive count of prior resolved FWA observations in the current Home clan.
- `S1/A1` means the latest FWA boundary is current sync `#588`, and the immediately preceding canonical boundary `#587` is an authoritative absence from the FWA roster axis.
- The current behavior is consistent with the documented FWA-roster definition of S/A. If the intended product meaning is “continuous alliance residence across BL/MM excursions,” that is a policy gap requiring a new bounded non-FWA excursion exemption, not a repair to the existing FWA evidence or a WarLookup fallback.

Classification: primary semantic/policy mismatch if BL should be continuity-neutral; not a proven calculation bug. The full history also contains one older missing sync number and eight negative-coverage-uncertain boundaries, which explain lower-bound `C+` markers but do not cause the first S/A stop at `#587`.

## Command-to-database path

1. `src/commands/Link.ts:704-779` reads the persisted current roster from `FwaClanMemberCurrent`. When Tenure is selected, it calls `HomeMembershipAnalyticsService.getAnalyticsForPlayers` once for the current player tags.
2. `src/services/HomeMembershipAnalyticsService.ts:155-161` loads active `ClanHomeMembershipPeriod` rows and one bounded `MembershipStreakService` batch.
3. `src/services/MembershipStreakService.ts:732-759` loads guild-scoped `SyncCycle` boundaries and canonical `(syncNumber, syncTime)` identities.
4. The same service resolves:
   - active FWA evidence from exact current-war identity plus `WarAttacks.attackOrder = 0` (`:776-829`, `:1005-1048`);
   - ended FWA evidence from `ClanWarHistory` rows with `matchType = FWA`, canonically associated by sync number and exact tuple, then `ClanWarParticipation` (`:831-957`, `:967-1081`);
   - bounded CWL continuity evidence (`:761-774`, `CwlContinuityEvidenceService.ts:98-192`).
5. `computeMembershipStreaksFromEvidence` (`MembershipStreakService.ts:410-585`) derives S/A. `HomeMembershipAnalyticsService.resolveClanTenure` (`HomeMembershipAnalyticsService.ts:57-91`) counts C from resolved FWA observations matching the active Home clan; Home `startedAtSyncTime` is not the C floor.
6. `src/commands/Link.ts:942-987` carries the derived values into the row model. `src/commands/link/LinkListRender.ts:630-650` formats them as `Cx/Sy/Az`, adding `+` for lower bounds. Rendering does not calculate or alter the values.

## Consecutive-boundary algorithm: every stop condition

Boundaries are newest-first. For each adjacent pair, the newer sync number must equal the older sync number plus one (`MembershipStreakService.ts:443-447`). A missing/duplicate/ambiguous canonical identity makes the pair nonconsecutive and stops the scan as a lower bound.

The scan can then behave as follows:

- Latest `RESOLVED` evidence starts S at the newest boundary; latest `ABSENT` gives an exact zero; latest `UNKNOWN` may reuse the prior value only when the prior evidence is usable and the latest row is pending.
- A leading CWL-neutral `UNKNOWN` or `ABSENT` boundary is skipped only when player-specific CWL roster, alliance interval, tracked-clan, and event-lifecycle proof all qualify. It does not change the FWA status.
- For S, a resolved observation in the same physical clan increments; a resolved observation in another clan or `ABSENT` ends the exact streak; `UNKNOWN` or `AMBIGUOUS` ends the scan as a lower bound.
- For A, any positive FWA observation (including ambiguous positive FWA evidence) increments; `ABSENT` ends the exact streak; `UNKNOWN` or unresolved coverage ends the scan as a lower bound.
- A nonconsecutive adjacent canonical pair stops either metric as a lower bound; it does not bridge the gap.
- If the bounded history window is exhausted while the scan remains continuous, the result is marked lower-bound. C is also marked lower-bound for any unknown/ambiguous boundary, missing canonical identity, nonconsecutive identity, or truncated history (`HomeMembershipAnalyticsService.ts:74-90`).

This explains why the actual stop at `#587` has no `+`: it is `ABSENT`, not `UNKNOWN`, and all adjacent sync identities in the recent window are consecutive.

## Production reproduction

Affected sample from the live `/link list Tenure` calculation:

| Player | Current Home | C | S | A |
|---|---|---:|---:|---:|
| `#20PRJ8JC8` | `#82YLR9Q2` | 56+ | 1 | 1 |
| `#2C0YJJ9PG` | `#82YLR9Q2` | 53+ | 1 | 1 |
| `#2CY92CUJ2` | `#82YLR9Q2` | 54+ | 1 | 1 |
| `#2L0JQ9QRP` | `#82YLR9Q2` | 57+ | 1 | 1 |
| `#2PQVGR2YP` | `#82YLR9Q2` | 57+ | 1 | 1 |
| Control `#29V22JYGG` | `#2QVGPQP0U` | 43+ | 28 | 28 |

The batch read covered 750 current players and 68 canonical boundaries. The service emitted `validated_points=423`, `dirty_points_ignored=10`, `points_canonicalized=365`, `unmatched_validated_points=56`, `ambiguous_tuple_points=0`, `canonical_histories_used=469`, and `negative_coverage_uncertain_boundaries=8`.

### Last 20 canonical boundaries

The table uses `#20PRJ8JC8` as the representative affected player. The other four affected players have the same first S/A stop at `#587`; their older boundary absences differ slightly. `consecutive` is the canonical sync-number test, not wall-clock spacing.

| Sync | Timestamp | Affected FWA evidence | Control FWA evidence | CWL exemption | Consecutive | Result |
|---:|---|---|---|---|---|---|
| 588 | 2026-11-11 16:30 | RESOLVED / ACTIVE / `#82YLR9Q2` | RESOLVED / ACTIVE / `#2QVGPQP0U` | no | start | current anchor |
| 587 | 2026-11-09 15:00 | ABSENT / participation | RESOLVED / participation / `#2QVGPQP0U` | no | yes | **first S/A stop: authoritative FWA absence** |
| 586 | 2026-11-07 13:30 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 585 | 2026-11-05 12:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 584 | 2026-11-03 09:20 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 583 | 2026-10-30 15:30 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 582 | 2026-10-28 08:20 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 581 | 2026-10-26 06:40 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 580 | 2026-10-24 05:50 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 579 | 2026-10-22 05:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 578 | 2026-10-20 02:10 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 577 | 2026-10-18 00:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 576 | 2026-10-15 21:50 | ABSENT / participation | RESOLVED / participation | no | yes | older possible stop if reached |
| 575 | 2026-10-13 20:20 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 574 | 2026-10-11 18:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 573 | 2026-10-09 16:00 | ABSENT / participation | RESOLVED / participation | no | yes | older possible stop if reached |
| 572 | 2026-10-07 14:50 | ABSENT / participation | RESOLVED / participation | **yes for this player** | yes | CWL-neutral for `#20PRJ8JC8`; not a general fix |
| 571 | 2026-10-05 12:10 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 570 | 2026-10-03 10:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |
| 569 | 2026-09-30 17:00 | RESOLVED / participation / `#82YLR9Q2` | RESOLVED / participation | no | yes | older evidence |

The first stop is identical for all five affected players: `#587`, `ABSENT`, with no CWL exemption. Their current `#588` active FWA roster contains all five again, which is why the rendered streak is exactly one rather than zero or pending.

## FWA, history, and identity evidence

At `#587`, the canonical ended-war rows are:

- FWA: `#2QVGPQP0U`, `#2RVV0L0VP`, `#2RYGLU2UY`, `#2YUYLJCGV`, and `#C0CU2Q82`; each has a complete 50-player `ClanWarParticipation` roster.
- `#82YLR9Q2`: canonical `ClanWarHistory` exists only as `BL` (`warId=1001046`, start `2026-11-10 14:08:30Z`). Its 50-player canonical `BL` participation roster contains all five affected players.
- There is no canonical `FWA` `ClanWarHistory` or `ClanPointsSync` row for `#82YLR9Q2` at `#587`.

The archived `WarLookup` payload for `#82YLR9Q2`/`1001046` also reports a 50-player ended BL war and contains the five players, but it is diagnostic only. It is not the source used for the streak and does not convert the BL war into FWA evidence.

At `#586`, `#82YLR9Q2` has an FWA canonical history with a complete 50-player participation roster containing all five affected players. The same is true for the earlier resolved FWA boundaries shown above. At current active `#588`, `WarAttacks` has an exact persisted FWA identity for `#82YLR9Q2`, 50 attack-order-zero roster rows, and all five affected players.

Canonical sync inspection for the full guild history found:

- 68 rows, `#520..#588`;
- one numeric gap: `#543 -> #545` (missing `#544`);
- no duplicate sync numbers;
- no duplicate sync times;
- no timestamp order violations;
- no gap in the affected recent window `#569..#588`.

The bounded historical-sync audit for `#569..#588` reported 20 canonical anchors, a contiguous `#569..#588` run, and no sync-number/time conflict or recoverable sync-cycle candidate. Full-history canonicalization has 56 unmatched validated points and eight negative-coverage-uncertain boundaries, so older data remains conservative/lower-bounded, but those conditions do not explain the exact `#587` stop.

## CWL continuity findings

Persisted CWL roster records exist for some sample players, and event lifecycle timing is resolved for the relevant 2026-10 and 2026-11 event instances. The service accepted exactly one sampled neutral pair: `#20PRJ8JC8` at boundary `#572`, where a persisted CWL roster, tracked CWL clan, alliance interval covering the boundary, and event-owned lifecycle timing all qualified.

The other affected players were not exempted at `#572` because their player-specific interval did not cover that boundary, despite some having a CWL roster row. `#587` is not exempted for any affected player: the current November CWL event had ended before the boundary for the relevant interval proof, and these players were back in the FWA Home clan. No CWL evidence explains the `#587` stop.

This is consistent with `CwlContinuityEvidenceService.ts:64-90`: event registry timestamps, fetch timestamps, current clan state, and WarLookup are insufficient; the exemption requires an exact player/event roster plus a bounded membership interval and event-owned lifecycle coverage.

## Confirmed findings vs hypotheses

Confirmed:

- The live output is reproducible for five affected players and one control.
- `C` is computed in `HomeMembershipAnalyticsService.resolveClanTenure` from resolved FWA observations matching the active Home clan; it is not consecutive.
- S/A stop at `#587` because the affected players are absent from the complete FWA cohort at that boundary.
- The affected Home clan is in a canonical BL war at `#587`, and all five players are present in that BL roster.
- The recent canonical sync identities are consecutive and unambiguous.
- CWL continuity is working for the one qualifying sample pair and does not qualify the `#587` boundary.
- Rendering only formats already-derived values.

Unverified or product-dependent:

- Whether the intended business meaning of “Alliance Streak” includes BL/MM roster residence. The current architecture explicitly defines S/A as canonical-sync FWA war-roster statistics, so treating BL as continuity-neutral would be a behavior change requiring product confirmation.
- Whether all older `unmatched_validated_points` and negative-coverage-uncertain boundaries are repairable. They are not involved in the proven recent failure path and were not mutated.

## Root cause classification

- A. Calculation bug: not proven. The algorithm’s `ABSENT` handling matches its tests and the stated FWA-only contract.
- B. Missing historical data: not the immediate cause. The `#587` BL roster and the complete FWA cohort are present. Older gaps/uncertainty exist and explain `C+`, not the `S1/A1` boundary.
- C. Incorrect canonical identity resolution: not proven. Recent tuple matching is unambiguous; the service correctly keeps BL out of FWA history.
- D. CWL continuity failure: no for this incident. CWL exemption succeeds where its evidence qualifies and does not apply at `#587`.
- E. Combination: yes only as a semantic mismatch plus unrelated conservative historical lower bounds—BL is real canonical roster evidence, but outside the current FWA-only S/A metric.

## Recommended minimal fix

First decide the metric contract:

1. If S/A intentionally mean consecutive FWA-roster participation, make no calculation change. The observed `C56+/S1/A1` family is expected for players who were in a BL war at the preceding sync. Improve operator-facing diagnostics to expose “non-FWA excursion at sync” if desired; do not use it to alter S/A.
2. If alliance/physical continuity should survive a BL or MM excursion, add a separate bounded, read-only, player-specific non-FWA continuity evidence service. It should use canonical `ClanWarHistory` plus complete canonical `ClanWarParticipation`, exact `SyncCycle` identity, explicit match type, and the same adjacent-boundary checks as CWL. It must be an exemption for S/A only; it must not change FWA status, C, Home ownership, canonical gaps, or WarLookup authority. This is the smallest safe policy extension.

Do not repair `#587` participation: the existing canonical BL roster is complete. Do not backfill or synthesize an FWA row for `#82`; that would corrupt historical war tracking.

## Historical repair and risk assessment

No safe historical repair is necessary for the proven failure. A separate future review may investigate missing sync `#544` and the 56 unmatched points, but any repair must use the existing exact scheduled-sync and canonical-war evidence rules and remain dry-run first.

Risks:

- Changing S/A to include BL/MM could increase visible streaks for players who were intentionally outside the FWA roster axis; the change must be explicit and player/event bounded.
- Reusing `WarLookup`, current clan membership, snapshots, or current-state FWA tables for historical streaks would create false positives and violate state ownership.
- Changing C or Home logic to compensate would incorrectly alter Home tenure and transfer semantics. The current Home periods for the affected sample are valid and remain untouched.
- Existing war tracking is safest when BL remains a canonical war fact used only by a future explicit excursion policy, never relabeled as FWA.

## Read-only tooling used

Existing tooling was inspected first. The guild-scoped historical-sync audit was run only for `#569..#588`:

```text
docker exec clashcookies-app node dist/scripts/auditHistoricalSyncReconciliation.js \
  --guild <guild-id> --from-sync 569 --to-sync 588
```

The membership-history audit and both backfill utilities were not run because the audit entry point is not guild-bounded and the backfill utilities are mutation-capable even though they default to dry-run. No new diagnostic script was needed: the existing bounded service batch plus direct read-only database projections exposed the required per-boundary evidence.

