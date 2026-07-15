# Stale war attacks after PRs #1685 and #1686

## Executive conclusion

The observed mismatch was **not** durable snapshot corruption in `TodoPlayerSnapshot`.

Production shows a normal propagation window:

- `TodoPlayerSnapshot` still had `warAttacksUsed = 0` when I sampled it
- the corresponding `WarAttacks.attackOrder = 0` rows later reached `attacksUsed = 2`
- the latest todo refresh I observed happened **before** that authoritative `WarAttacks` correction

So the correct diagnosis is:

- the todo snapshot was stale for a short period
- it was not proven to remain stale after `WarAttacks` recovered
- no speculative functional fix is currently justified by this evidence alone

## Production evidence

Affected sample rows, newest per player:

| Player | `WarAttacks.attackOrder=0` | `TodoPlayerSnapshot` | `CurrentWar` |
| --- | --- | --- | --- |
| `#L2JPVG2QP` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:52.824` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000618`, `warSourceUpdatedAt=2026-07-15 08:48:34.255`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:49.889` | `state=notInWar`, `warId=1000618`, `startTime=2026-07-14 18:18:27`, `endTime=2026-07-15 18:18:27`, `updatedAt=2026-07-15 19:15:52.769` |
| `#GU0QJCPQU` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:48.660` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000617`, `warSourceUpdatedAt=2026-07-15 03:28:08.513`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:48.475` | `state=notInWar`, `warId=1000617`, `startTime=2026-07-14 18:18:12`, `endTime=2026-07-15 18:18:12`, `updatedAt=2026-07-15 19:15:48.539` |
| `#YGYP00P9J` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:46.281` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000621`, `warSourceUpdatedAt=2026-07-15 17:35:49.020`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:49.643` | `state=notInWar`, `warId=1000621`, `startTime=2026-07-14 18:22:22`, `endTime=2026-07-15 18:22:22`, `updatedAt=2026-07-15 19:15:46.264` |
| `#2UYYG82V8` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:49.644` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000624`, `warSourceUpdatedAt=2026-07-15 04:48:08.630`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:49.580` | `state=notInWar`, `warId=1000624`, `startTime=2026-07-14 18:18:12`, `endTime=2026-07-15 18:18:12`, `updatedAt=2026-07-15 19:15:49.600` |
| `#G2P8829UP` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:52.779` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000618`, `warSourceUpdatedAt=2026-07-15 08:48:34.255`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:49.895` | `state=notInWar`, `warId=1000618`, `startTime=2026-07-14 18:18:27`, `endTime=2026-07-15 18:18:27`, `updatedAt=2026-07-15 19:15:52.769` |
| `#PGJYVU0UR` | `attacksUsed=2`, `updatedAt=2026-07-15 19:15:54.135` | `warAttacksUsed=0`, `warActive=true`, `warOwnerSource=LIVE_VERIFIED`, `warOwnerWarId=1000620`, `warSourceUpdatedAt=2026-07-15 13:47:11.749`, `lastUpdatedAt=2026-07-15 19:05:45.088`, `updatedAt=2026-07-15 19:12:49.528` | `state=notInWar`, `warId=1000620`, `startTime=2026-07-14 18:16:52`, `endTime=2026-07-15 18:16:52`, `updatedAt=2026-07-15 19:15:54.127` |

For every sampled player:

- `TodoPlayerSnapshot.updatedAt` is earlier than `WarAttacks.updatedAt`
- `TodoPlayerSnapshot.lastUpdatedAt` is also earlier than the authoritative `WarAttacks` correction
- there is no later todo refresh in the sampled window after `WarAttacks` reached `2`

That means the row mismatch is best explained as refresh lag, not durable corruption.

## Log evidence

The prod logs show the todo refresh cycle before the authoritative `WarAttacks` correction, and then only background queue noise afterward in the sampled window.

Relevant todo logs:

```text
[info] [todo-snapshot] event=todo_refresh_population_sources player_count=231 membership_observed_live=0 membership_fetched_live=129 membership_player_current=46 membership_fwa_member=0 membership_existing=49 membership_no_clan=4 membership_none=3 war_tracked_roster=125 war_member=0 war_live_current=0 war_none=91 missing_war_position_count=0
[warn] [todo-snapshot] event=todo_war_owner_write_suppressed player_tag=#L2JPVG2QP existing_owner=#C0CU2Q82 attempted_owner=#C0CU2Q82 existing_confidence=LIVE_VERIFIED attempted_confidence=PERSISTED_FALLBACK existing_war_id=1000618 attempted_war_id=1000618 existing_verified_at=2026-07-15T18:52:37.412Z attempted_observation_at=2026-07-15T19:05:45.088Z reason=lower_confidence
```

The important point is timing:

- todo refresh activity was still landing before the `WarAttacks` correction finished
- I did not find a later todo refresh after the authoritative `WarAttacks` rows had already reached `2`

## Reminder behavior

Reminder dispatch is already DB-first and reads `CurrentWar` plus `WarAttacks.attackOrder = 0` rows.

The relevant code path filters completed attackers out directly from persisted attack counts, so once `WarAttacks` reaches `2`, the reminder roster excludes the player without any live CoC fetch.

The existing reminder regression coverage already exercises that exclusion path.

## Classification

This should be treated as a **propagation delay**, not durable snapshot staleness.

The earlier durable-staleness interpretation is not supported by the production timestamps.

## Confidence

Confidence: **91%**

Why not 100%:

- I did not capture a later todo refresh after the `WarAttacks` correction
- the live CoC source was no longer available by inspection time

Why the conclusion is still strong:

- every sampled player shows the same ordering: todo refresh before `WarAttacks` correction
- `TodoPlayerSnapshot` and `WarAttacks` agree on the same clan tag, war ID, and player tag
- reminder dispatch already reads the corrected `WarAttacks` rows directly

