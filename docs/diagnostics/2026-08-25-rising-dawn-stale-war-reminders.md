# 2026-08-25 RISING DAWN stale WAR reminders

## Executive conclusion

ROOT CAUSE INCONCLUSIVE

The evidence confirms the incident symptom and strongly supports stale or unavailable `WarAttacks` state at reminder time, but the incident-time production application logs were not retained. `CurrentWar.warId=1000817` and the ended-war `ClanWarHistory`/`WarLookup.warId=1000767` are not inconsistent lineage: they are live-war and archive-war identities owned by different lifecycle stores. `persistWarEndHistory` inserts or updates `ClanWarHistory` without supplying `CurrentWar.warId`, receives the archive row's persisted ID, and the archive lifecycle rewrites and deletes the operational `WarAttacks` rows. `CurrentWar` is assigned that persisted ID only when its existing ID is null, so the numeric difference is expected and is not incident evidence. The clan still had no `ClanPointsSync` row for sync 552, but no retained `[sync-assignment] active_cycle_conflict` line proves that branch executed or that it was the sole reason attack synchronization did not run. The supplied external battle-feed chronology and feed-backed DB state prove attacks existed before the 02:01Z reminder, while the reminder fire records prove both sends completed normally.

## Incident timeline

All database timestamps are UTC-style `timestamp without time zone` values and are interpreted as UTC, consistent with the application timestamps. PDT is UTC-7.

| UTC | PDT | Evidence |
|---|---|---|
| 2026-08-25 03:00:47Z | Aug 24 20:00:47 PDT | RISING DAWN war start for clan `#2YUYLJCGV` versus `#2QQQUQQRV`, represented in the live `CurrentWar` state and later in the canonical archive. |
| 2026-08-25 21:00:48Z | Aug 25 14:00:48 PDT | Reminder fire log created and later marked `SENT` for the 6h offset; event identity `WAR:war-id:1000817`. |
| 2026-08-26 01:29:21Z | Aug 25 18:29:21 PDT | `FwaWarMemberCurrent` snapshot for this clan/opponent: 50 members, 32 with attacks, 30 with two attacks, 62 total; this is feed-backed current-state evidence, not `WarAttacks` history. |
| 2026-08-26 02:01:26Z | Aug 25 19:01:26 PDT | Reminder fire log created and later marked `SENT` for the 1h offset; event identity `WAR:war-id:1000817`. |
| 2026-08-26 03:00:48Z | Aug 25 20:00:48 PDT | War end in `ClanWarHistory` / `WarLookup`; archive war ID `1000767`; 133–80 WIN. |
| 2026-08-26 03:04:29–03:04:30Z | Aug 25 20:04:29–20:04:30 PDT | Archive/recovery finalized `WarLookup` and `ClanWarParticipation`: 72 attacks, 37 attacking members, 35 members with two attacks. `WarEvent` has `war_ended` and `clan_goal:FWA_NO_VIOLATIONS` for archive war ID 1000767, but no retained `war_started` or `battle_day` event for that archive ID. |
| 2026-08-26 03:14:35Z | Aug 25 20:14:35 PDT | Later poll/recovery created the surviving current `WarAttacks` rows: 50 roster rows plus 72 attack rows. Because the archive lifecycle first rewrites and deletes prior operational rows, this `createdAt` value cannot establish whether rows existed before either reminder or what their reminder-time values were. |
| 2026-08-26 05:17:13Z | Aug 25 22:17:13 PDT | Docker records an `clashcookies-app-replacement` network join. |
| 2026-08-26 05:23:33–05:23:35Z | Aug 25 22:23:33–22:23:35 PDT | Old app task deleted and replacement app task joined the production network; current `clashcookies-app` started at `05:23:34.716Z`. |
| 2026-08-26 05:29:28Z | Aug 25 22:29:28 PDT | Replacement process performed a post-restart ended-war poll; it logged `already_recorded`, then current rows were updated. |

The user-supplied battle-feed timestamps add independent attack chronology: attacks began by approximately 15:14Z, several members had one or two attacks by 15:18–17:01Z, Bettay-family accounts had attacked by 18:34Z, and Octacles attacked as late as 01:45Z. Those times are external evidence supplied for this investigation, not retained app-log lines.

## Production log evidence

The requested Docker log query for `clashcookies-app`, from `2026-08-25T14:00:00Z` through `2026-08-26T03:15:00Z`, returned zero lines because the current container started at `2026-08-26T05:23:34Z`. `docker ps -a` showed no retained predecessor application container. The Dozzle data volume contained only its profile and users file, not application log history. Therefore there are no retained incident-time `[war-events]`, `[sync-assignment]`, CoC failure, queue, or `[reminders]` lines to quote.

The minimum relevant retained surrounding evidence is:

```text
2026-08-26T05:17:13.817390078Z dockerd: ... ep=clashcookies-app-replacement ...
2026-08-26T05:23:33.034283818Z dockerd: received task-delete event from containerd ...
2026-08-26T05:23:35.246052789Z dockerd: ... ep=clashcookies-app ...
2026-08-26T05:29:19.844653076Z [debug] [reminders] ready_start begin
2026-08-26T05:29:20.137523299Z [info] [reminders] catchup_skip reason=stale_no_active_event reminder_id=cmo0bw2cn0zq5na54ngpl85n9 clan=#2YUYLJCGV type=WAR_CWL
2026-08-26T05:29:28.268523734Z [info] [war-events] war_ended suppressed guild=1324040917602013261 clan=#2YUYLJCGV reason=already_recorded warStart=2026-08-25T03:00:47.000Z
2026-08-26T05:29:28.279903536Z [info] [points-sync] guild=1324040917602013261 clan=#2YUYLJCGV war_id=1000817 war_start=2026-08-25T03:00:47.000Z resolution=missed_war_start_time
```

The retained lines establish restart/recovery ordering only. They do not establish the assignment result during the affected battle-day cycles. No retained line showed `active_cycle_conflict`, `exact_same_war_reconcile`, `revision_not_owned`, `identity_changed`, a CoC 429, a poll skip, or a reminder dispatch error for the incident window.

## Database evidence

Read-only production queries identified the exact ended war as follows:

| Owner | War ID | Clan | Opponent | Start | End | Result |
|---|---:|---|---|---|---|---|
| `ClanWarHistory` | `1000767` | `#2YUYLJCGV` | `#2QQQUQQRV` | `2026-08-25 03:00:47Z` | `2026-08-26 03:00:48Z` | 133–80 WIN |
| `WarLookup` | `1000767` | `#2YUYLJCGV` | `#2QQQUQQRV` | `2026-08-25 03:00:47Z` | `2026-08-26 03:00:48Z` | `win` |

The archived payload contains 72 attack objects, 37 distinct attackers, and final participation rows show 50 roster members, 37 members with attacks, 35 members with two attacks, and 72 total attacks. The archived `attackSeenAt` values are the archive-observation time (`03:04:29Z`), so they must not be interpreted as the real attack times.

The live and archive stores use different ownership/lifecycle identities for the same war:

- `CurrentWar` owns live operational state: clan `#2YUYLJCGV`, opponent `#2QQQUQQRV`, `warId=1000817`, `syncNumber=550`, `state=notInWar`, `updatedAt=2026-08-26 05:29:28.281Z`. The 6h and 1h reminder fire logs correctly use that live identity and are `SENT`.
- `ClanWarHistory` owns canonical ended-war history and `WarLookup`/`ClanWarParticipation` use its persisted archive ID, `warId=1000767`, for the finalized record.
- In `persistWarEndHistory`, the `ClanWarHistory` insert/upsert does not supply `CurrentWar.warId`; it returns the archive row's `persistedWarId` (`src/services/war-events/history.ts:591-625`). The lifecycle then rewrites same-war `WarAttacks` to that ID and deletes the operational rows (`:862-925`). `CurrentWar` is backfilled to the persisted ID only where its existing ID is null (`:867-870`). Therefore an existing live `CurrentWar.warId` can legitimately differ from the archive ID; the numeric difference is not evidence of wrong lineage, a wrong reminder query, or the incident cause.
- `WarAttacks` currently contains 122 rows for live `warId=1000817` and the same war start: 50 `attackOrder=0` roster rows and 72 attack rows. Those surviving rows were created at `03:14:35Z`, after both reminders. They may be newly created current rows after archive/recovery; their `createdAt` does not prove that `WarAttacks` was absent before `03:14Z`, and their current `attacksUsed` values cannot establish the exact values at 21:00Z or 02:01Z.
- There is no `ClanPointsSync` row for `#2YUYLJCGV` at the incident war start with sync 552. The clan's latest persisted points row is the prior war, `warId=1000800`, `syncNum=550`. Other same-guild clans have sync-552 rows created around `03:04Z`.
- The ended-war archive records `syncNumber=552` for its own archive war ID 1000767.

This is strong evidence of a missing/stale current-war sync ownership result, but it is not proof of which branch caused it. The archive transition and later poll/recovery also make incident-time `WarAttacks` contents unrecoverable: surviving operational rows cannot show whether rows existed before 03:14Z, nor can they reconstruct the exact `attacksUsed` values consumed at 21:00Z or 02:01Z.

## Code-path correlation

The current code maps the incident mechanics as follows:

1. `WarEventLogService.getCurrentWarSnapshot()` calls CoC and returns `{ war, observation: { kind: "success" } }` on a successful response (`src/services/WarEventLogService.ts:3733-3765`). `processSubscription()` calls this before state/identity and sync resolution (`:4265-4271`).
2. For an active FWA war, `ActiveWarSyncResolutionService.resolveOrAllocateActiveSyncNumber()` first checks same-war points evidence, then persisted active-cycle evidence. A conflicting active-cycle candidate returns `source=active_cycle_conflict`, `usable=false`, `syncNumber=null` (`src/services/ActiveWarSyncResolutionService.ts:759-772`), and the logger emits a warning (`:473-510`).
3. `processSubscription()` treats an unusable assignment with `conflict`, `revision_changed`, `identity_changed`, or `active_cycle_conflict` as an ownership failure and returns before finalization (`src/services/WarEventLogService.ts:5147-5162`). The `syncWarAttacksFromWarSnapshot()` call is later at `:5369`; therefore that return is exactly the suspected return-before-attack-sync path.
4. `syncWarAttacksFromWarSnapshot()` writes `attackOrder=0` roster rows with `attacksUsed=attacks.length`, and writes positive-order attack rows (`src/services/WarEventLogService.ts:5567-5689`).
5. The WAR reminder renderer selects the latest active `CurrentWar`, queries `WarAttacks` by that `warId` and `attackOrder=0`, then computes `attacksRemaining = max(0, 2 - attacksUsed)` (`src/services/reminders/ReminderDispatchService.ts:341-395`). The display formatter emits `${attacksRemaining} / ${attacksMax}` (`:576-589`). Thus a zero-valued roster row renders as `2 / 2` attacks remaining.
6. `ReminderSchedulerService` creates/claims the fire log, calls `dispatchReminder()`, and records `SENT` when Discord accepts the send (`src/services/reminders/ReminderSchedulerService.ts:363-440`). The production fire logs show this normal completion for both affected offsets.

The suspected return branch is therefore valid in the current code, but it was not directly observed in production. The missing incident log stream means the report cannot state that RISING DAWN actually reached that branch.

## Competing hypotheses

| # | Hypothesis | Classification | Evidence |
|---:|---|---|---|
| 1 | `active_cycle_conflict` aborted processing before attack refresh | inconclusive | No retained conflict line; missing sync-552 row, stale current sync 550, absent active-war event records, and later post-end attack rows strongly support a missing assignment, but do not identify the branch. |
| 2 | Another sync persistence/CAS conflict aborted processing | inconclusive | No retained `conflict`, `revision_changed`, or `identity_changed` assignment line; the missing sync-552 row is compatible with this alternative. |
| 3 | Current-war physical identity/revision checks rejected the poll | unsupported | Current persisted start/opponent identity is stable. The live ID and canonical archive ID differ as expected under the ownership transition described above, so that difference is not rejection evidence; no retained `stale_before_finalize`, `revision_not_owned`, or `identity_changed` line proves rejection. |
| 4 | CoC API polling failed or was stale | inconclusive | No incident CoC error/429 lines survived. External/feed evidence shows attacks were available elsewhere before the 02:01Z reminder, but does not prove the CoC `getCurrentWar` response path. |
| 5 | Poll overlap/queue pressure prevented timely refresh | inconclusive | No incident `poll_skipped`, overlap, queue-freshness, or degraded-delay lines survived. The current job status has historical P2028 failures, last recorded on Aug 24, not this incident window. |
| 6 | Maintenance/outage recovery suppressed updates | unsupported | Persisted maintenance state is inactive and last observed on Aug 6; no incident maintenance transition or suppression line survived. This cannot be treated as a definitive historical exclusion because the incident logs are gone. |
| 7 | `WarAttacks` refreshed correctly but reminder queried the wrong war/rows | unsupported as an ID-mismatch explanation | The reminder identity `1000817` matches the live `CurrentWar` owner and current `WarAttacks` rows. Archive ID `1000767` belongs to the separate canonical ended-war store and is not evidence that the reminder selected a different current-war row. The later surviving rows do not prove whether the current rows were fresh at reminder time because the archive lifecycle removed prior operational rows. |
| 8 | `ReminderDispatch` had a separate calculation/filtering problem | ruled out for the current code | The current code explicitly computes `2 - attacksUsed`, filters positive remaining counts, and has no fallback/error in the fire-log records. The observed `2 / 2` is exactly the output of zero-valued `WarAttacks` roster rows. |
| 9 | Deployment/restart occurred mid-war and affected state ownership | confirmed as an operational event, not as the reminder cause | Docker records an app replacement at 05:17–05:23Z, after both reminders and after war end. It explains loss of the incident-time app container/logs; it cannot by itself explain reminders sent earlier. |

## Root cause

No single root cause is stated because the decisive production assignment log was lost. The supported failure boundary is the active-war synchronization/ownership handoff: by the time the reminder lineage was recorded, RISING DAWN had no persisted sync-552 points row and its live current sync was stale at 550. The separate archive ID is the expected result of the live-to-ended-war ownership transition and is not causal evidence. The specific choice between `active_cycle_conflict`, another persistence/CAS conflict, or an unobserved upstream/overlap condition remains unresolved.

The full supplied causal chain is only partially established:

1. A conflict for RISING DAWN: not directly observed; strongly suggested, not proven.
2. Return before `syncWarAttacksFromWarSnapshot()`: code branch exists; production execution not observed.
3. Attack state stopped advancing/remained stale: strongly supported by the symptom and by the absence of incident-time `WarAttacks` history, but not directly reconstructed from the mutable table.
4. Reminder scheduler fired: confirmed by two `ReminderFireLog` rows, both `SENT`.
5. `ReminderDispatch` read the live current-war `WarAttacks` source: the current code path is confirmed, but the rows at the exact send times were not retained.
6. The stale rows explain `2 / 2`: `2 / 2` is consistent with the current renderer's `attacksUsed=0` arithmetic; exact incident-time row contents remain unobserved.

## Evidence classification

CONFIRMED:

- Actual attacks occurred before both reminders, based on the supplied battle-feed chronology and the 01:29Z feed-backed `FwaWarMemberCurrent` snapshot.
- Both reminder sends succeeded; their fire logs are `SENT`.
- The current reminder code renders attacks remaining from `WarAttacks` `attackOrder=0` `attacksUsed`.
- `2 / 2` is consistent with `attacksUsed=0` under that renderer.
- Surviving operational `WarAttacks` rows cannot reconstruct reminder-time state because the archive lifecycle rewrites/deletes prior rows and later polling/recovery can create new current rows.

PLAUSIBLE BUT UNCONFIRMED:

- `active_cycle_conflict` occurred in production.
- `WarEventLogService` returned on that branch before `syncWarAttacksFromWarSnapshot()`.
- That branch caused `WarAttacks` to become stale for the reminders.

The confirmed facts do not elevate the specific causal chain to ROOT CAUSE CONFIRMED because the incident-time assignment, attack-refresh, and reminder-source snapshots are unavailable.

## Confidence

Confidence: **60%** that the incident involved a stale/missing current-war attack-state refresh at the active-war ownership boundary; **25%** that the specific cause was `active_cycle_conflict`.

Reasons for the bounded confidence:

- High-confidence facts: final archived attack counts; attacks before reminders; both reminder sends; the current renderer's `WarAttacks` query and arithmetic; the missing sync-552 points row for this clan; and the app replacement that removed the original container. The live/archive ID difference is excluded from this causal evidence because it is an expected ownership transition.
- Limiting facts: no incident-time app logs, no historical `WarAttacks` versions, and no persisted per-reminder snapshot of the rendered roster.
- The external attack chronology and `FwaWarMemberCurrent` snapshot disprove “no attacks happened,” but they do not identify the failing `WarEventLogService` branch. The post-03:14Z `WarAttacks.createdAt` values also cannot be used to infer absence before that time or exact reminder-time `attacksUsed`.
- The specific `active_cycle_conflict` percentage is lower because the production conflict line, return outcome, and pre-reminder attack rows were not retained; alternative poll, persistence, or upstream explanations remain viable.

## Recommended fix boundary

NO CODE.

If the hypothesis is confirmed later, change the ownership/orchestration boundary between active sync assignment and current-war attack refresh so an assignment-resolution conflict cannot silently leave the reminder source stale without a durable, retryable outcome. The boundary should preserve exact-war identity, make the attack-refresh obligation explicit, and expose whether the poll was refreshed, deferred, or aborted before reminder consumers run. This report does not recommend a specific implementation or production repair.

## Observability gap

The incident would have been unambiguous with one structured per-clan poll-cycle record carrying: `poll_cycle_id`, `guild_id`, clan tag, CoC fetch outcome/status, observed war identity, pre/post CurrentWar revision, sync-assignment source/persistence/usable result, explicit `attack_sync_started`/`attack_sync_completed` with roster and attack-row counts, and a terminal `processSubscription` outcome/reason. Reminder dispatch additionally needed a bounded record of `currentWar.warId`, `WarAttacks` row count, minimum/maximum `updatedAt`, zero/one/two attack-count buckets, and the fire-log ID—without logging message bodies, tokens, or secrets. Finally, the production deployment should retain or ship app logs beyond container replacement; Dozzle's current volume contained no historical app lines.
