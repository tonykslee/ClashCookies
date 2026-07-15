# Stale war attacks after PRs #1685 and #1686

## Executive conclusion

The sampled mismatch **predates the authoritative correction**.

I can confirm that the affected `TodoPlayerSnapshot` rows were still stale when I sampled them, and that the corresponding `WarAttacks.attackOrder = 0` rows later reached `attacksUsed = 2`. What I **cannot** confirm yet is whether a later todo refresh happened after that write.

So the diagnosis is still **unresolved**:

- propagation delay remains possible
- durable confidence-preservation staleness remains possible
- those two explanations stay indistinguishable until a post-write refresh is observed or reproduced
- I should not call this a confirmed "normal propagation window"

## Production evidence

Latest sampled rows for the six affected players:

| Player | `TodoPlayerSnapshot` | `WarAttacks.attackOrder=0` | `CurrentWar` |
| --- | --- | --- | --- |
| `#L2JPVG2QP` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000618`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:50.070` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:51.675` | `state=notInWar`, `warId=1000618`, `endTime=2026-07-15 18:18:27.000`, `updatedAt=2026-07-15 19:35:51.624` |
| `#GU0QJCPQU` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000617`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:49.040` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:49.499` | `state=notInWar`, `warId=1000617`, `endTime=2026-07-15 18:18:12.000`, `updatedAt=2026-07-15 19:35:49.462` |
| `#YGYP00P9J` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000621`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:49.872` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:46.413` | `state=notInWar`, `warId=1000621`, `endTime=2026-07-15 18:22:22.000`, `updatedAt=2026-07-15 19:35:46.264` |
| `#2UYYG82V8` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000624`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:49.811` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:49.977` | `state=notInWar`, `warId=1000624`, `endTime=2026-07-15 18:18:12.000`, `updatedAt=2026-07-15 19:35:49.956` |
| `#G2P8829UP` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000618`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:50.067` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:51.636` | `state=notInWar`, `warId=1000618`, `endTime=2026-07-15 18:18:27.000`, `updatedAt=2026-07-15 19:35:51.624` |
| `#PGJYVU0UR` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000620`, `lastUpdatedAt=2026-07-15 19:25:45.093`, `updatedAt=2026-07-15 19:32:49.750` | `attacksUsed=2`, `updatedAt=2026-07-15 19:35:54.155` | `state=notInWar`, `warId=1000620`, `endTime=2026-07-15 18:16:52.000`, `updatedAt=2026-07-15 19:35:54.146` |

For every sampled player:

- `TodoPlayerSnapshot.updatedAt` is still earlier than `WarAttacks.updatedAt`
- `TodoPlayerSnapshot.lastUpdatedAt` is also earlier than `WarAttacks.updatedAt`
- the sampled todo row is still stale relative to the authoritative attack-count write

That is enough to say the sampled mismatch predates the correction, but not enough to say whether the next todo refresh would have healed it or preserved it.

## Log evidence

The logs show the todo refresh cycle before the authoritative `WarAttacks` write, then later `todo_refresh_population_sources` activity that is still timestamped before the correction, and no post-write todo refresh for these six players in the sampled window.

Relevant lines:

```text
2026-07-15T19:32:47.203080345Z [info] [todo-snapshot] event=todo_refresh_population_sources player_count=231 membership_observed_live=0 membership_fetched_live=144 membership_player_current=34 membership_fwa_member=0 membership_existing=46 membership_no_clan=6 membership_none=1 war_tracked_roster=125 war_member=0 war_live_current=0 war_none=91 missing_war_position_count=0
2026-07-15T19:32:47.452663590Z [warn] [todo-snapshot] event=todo_war_owner_write_suppressed player_tag=#2U8GJPYQP existing_owner=#2QVGPQP0U attempted_owner=#2QVGPQP0U existing_confidence=LIVE_VERIFIED attempted_confidence=PERSISTED_FALLBACK existing_war_id=1000622 attempted_war_id=1000622 existing_verified_at=2026-07-15T18:15:45.080Z attempted_observation_at=2026-07-15T19:25:45.093Z reason=lower_confidence
2026-07-15T19:32:50.092124452Z [info] [todo-snapshot] event=todo_refresh_population_sources cadence=tracked cwl_season=2026-07 activated_player_count=512 snapshot_tracked_count=20 snapshot_war_context_count=140 snapshot_raid_context_count=0 member_tracked_count=0 war_member_tracked_count=0 roster_tracked_count=0 live_current_war_roster_tracked_count=0 selected_player_count=231
```

The important point is what is **not** in the evidence set:

- I did not observe a todo refresh after the `WarAttacks` rows reached `attacksUsed = 2`
- I did not observe a post-write refresh for any of the six sampled players

Because of that, I cannot separate propagation delay from durable confidence-preservation staleness yet.

## Reminder behavior

Reminder dispatch is already DB-first and reads `CurrentWar` plus `WarAttacks.attackOrder = 0` rows.

The existing regression test that covers the reminder exclusion path is:

- `tests/reminderDispatch.service.test.ts`: `ignores stale FwaWarMemberCurrent data when WarAttacks already has the authoritative counts`

That coverage is the right guard for the reminder side of this issue.

## Deployment boundary

Every affected war in the sample started before the `#1686` deployment.

I did **not** have any post-deployment-started war in the evidence set, so the theory that the problem is limited to a deployment-crossing war remains plausible, but it is not proven.

I should not claim the next war is safe until I either observe one or prove the transition is independent of the old legacy state.

## Classification

No A-F defect classification yet.

The current evidence does not prove a durable failure.

The focused regression test reproduces the same retained-ended same-identity path in `buildTodoWarOwnerDecision()`: the canonical tracked-roster merge preserves the live-verified row and leaves `warAttacksUsed = 0` even when the same-war `WarAttacks` row has reached `2`.

If a later production refresh is observed and it still leaves the row at `0/2`, then the defect should be classified with the original A-F scale and the exact confidence-preservation branch is `canonicalAttemptIsSameIdentity` inside `persistTodoSnapshotWrite()`.

## Confidence

Confidence: **66%**

Why not higher:

- the sampled snapshot is definitely stale
- the authoritative `WarAttacks` correction is definitely later
- but a post-write todo refresh has not been observed yet

Why not lower:

- the production rows and logs agree on the ordering
- the reminder path already uses the corrected `WarAttacks` rows directly
- the stale sample therefore cannot be called a confirmed normal propagation window
