# Stale war attacks after PRs #1685 and #1686

## Executive conclusion

The production evidence does **not** support the unsupported PR #1690 explanation that this was still the old canonical sync ownership guard.

The durable stale state was in `TodoPlayerSnapshot`, not in the current `WarAttacks` writer path.

What happened in production:

- the affected wars crossed the `#1685/#1686` deployment boundary
- `TodoSnapshotService` kept preserving an earlier `LIVE_VERIFIED` war snapshot with `warAttacksUsed = 0`
- later refresh attempts degraded to `PERSISTED_FALLBACK` once the war was no longer exposed as live current-war state
- that lower-confidence attempt was intentionally suppressed, so `/todo` stayed stale even though the authoritative attack rows later recovered to `2/2`

I could not directly verify a persistent reminder-side defect after the catch-up, because the current `WarAttacks` rows now show the completed attackers correctly. The directly verified durable stale artifact is the todo snapshot layer.

## Deployment timeline

Relevant source revisions:

- PR `#1685` merge revision: `498d8649cec59f8054e257cd802003b838e030ac`
- PR `#1686` merge revision: `698dbcf87de17fc36c2b871cf815b2444c7bee0c`

Observed production deployment marker:

- current prod container `clashcookies-app` started at `2026-07-15T16:28:08.88404622Z`
- deployed revision inside the container was `698dbcf87de17fc36c2b871cf815b2444c7bee0c`

The relevant wars all started before those deployment markers:

- `#2RYGLU2UY` war start: `2026-07-14 18:18:12`
- `#2YUYLJCGV` war start: `2026-07-14 18:18:12`
- `#C0CU2Q82` war start: `2026-07-14 18:18:27`
- `#LQQ99UV8` war start: `2026-07-14 18:18:54`
- `#R80L8VYG` war start: `2026-07-14 18:16:52`
- `#29PCQGUV0` war start: `2026-07-14 18:22:22`

Querying the recent `CurrentWar` sample showed `started_after_1686_merge = 0` and `started_before_1686_merge = 9`, so the incident is limited to wars that crossed the deployment boundary.

## Production evidence

`BotPollJobStatus.war_event_poll_cycle` was healthy when inspected:

- `enabled = true`
- `status = idle`
- `intervalMs = 300000`
- `lastStartedAt = 2026-07-15 18:50:45.093`
- `lastFinishedAt = 2026-07-15 18:52:37.443`
- `lastSuccessAt = 2026-07-15 18:52:37.443`
- `runCount = 16230`
- `failureCount = 154`
- `metadata = {"mode":"active"}`

That means the scheduler was alive, but it does **not** prove every clan reached the writer path in time.

The prod logs did show the todo refresh path preserving existing live-verified WAR state and suppressing lower-confidence re-writes:

```text
[info] [todo-snapshot] event=todo_refresh_population_sources player_count=231 membership_observed_live=0 membership_fetched_live=143 membership_player_current=34 membership_fwa_member=0 membership_existing=47 membership_no_clan=6 membership_none=1 war_tracked_roster=125 war_member=0 war_live_current=0 war_none=91 missing_war_position_count=0
[warn] [todo-snapshot] event=todo_war_owner_write_suppressed player_tag=#2U8GJPYQP existing_owner=#2QVGPQP0U attempted_owner=#2QVGPQP0U existing_confidence=LIVE_VERIFIED attempted_confidence=PERSISTED_FALLBACK existing_war_id=1000622 attempted_war_id=1000622 existing_verified_at=2026-07-15T18:15:45.080Z attempted_observation_at=2026-07-15T18:35:45.082Z reason=lower_confidence
```

That log shape is the key reason `/todo` stayed stale after the war fell out of live current-war state.

## Affected-player evidence

I found several concrete players whose todo snapshot stayed at `0` while the authoritative war-attacks rows reached `2`:

- `#L2JPVG2QP` `God Usopp`
- `#GU0QJCPQU` `babyboD`
- `#YGYP00P9J` `Yume 夢`

The same pattern also appears on several other players in the same war sets, including `#2UYYG82V8`, `#G2P8829UP`, and `#PGJYVU0UR`.

## Live / persisted / todo comparison

Live CoC was no longer directly available when I inspected the incident, so I reconstructed the state from the persisted rows and logs.

| Layer | Example evidence |
| --- | --- |
| Live CoC | Not directly verifiable after the war ended; the live war had already rolled off by inspection time. |
| `CurrentWar` | `#C0CU2Q82`, `warId=1000618`, `state=notInWar`, `startTime=2026-07-14 18:18:27`, `endTime=2026-07-15 18:18:27`, `updatedAt=2026-07-15 18:55:59.142` |
| `WarAttacks` | `#L2JPVG2QP` roster row `attackOrder=0`, `attacksUsed=2`, `detail_row_count=2`, `max_attack_order=134`, `warId=1000618`, `warStartTime=2026-07-14 18:18:27`, `updatedAt=2026-07-15 18:55:59.362`, `attackSeenAt=2026-07-15 18:35:51.716` |
| `TodoPlayerSnapshot` | `#L2JPVG2QP`, `warOwnerWarId=1000618`, `warOwnerSource=LIVE_VERIFIED`, `warActive=true`, `warAttacksUsed=0`, `warAttacksMax=2`, `warPhase=battle day`, `warEndsAt=2026-07-15 18:18:27`, `warSourceUpdatedAt=2026-07-15 08:48:34.255`, `updatedAt=2026-07-15 18:52:37.412` |

That is the precise mismatch: authoritative war attacks had completed, but the todo snapshot still displayed the earlier `0/2` state.

## Exact stages

First failing stage:

- `todo_refresh_population_sources` at `2026-07-15 18:35:45` and `2026-07-15 18:45:45`
- the todo writer attempted a `PERSISTED_FALLBACK` observation and suppressed it as `reason=lower_confidence`
- the result was a preserved `LIVE_VERIFIED` todo snapshot with `warAttacksUsed = 0`

Final successful stage:

- `CurrentWar` flipped to `notInWar` for the affected clans by `2026-07-15 18:55:57` through `2026-07-15 18:56:01`
- matching `WarAttacks` rows were refreshed to `attacksUsed = 2`
- that fixed the authoritative attack rows, but it did not retroactively repair the already-preserved todo snapshot

## Classification

I classify this as **C**:

- **C**: `TodoSnapshotService` preserved an older live-verified war snapshot after the war degraded to lower-confidence persisted fallback, leaving `/todo` stale even though the authoritative war-attacks rows later recovered.

Why the other buckets do not fit:

- **A**: not supported, because the completed attack rows do exist in production now
- **B**: not supported, because the writer did eventually produce `attacksUsed=2`
- **D**: not supported, because `ReminderDispatchService` reads `WarAttacks` directly and the current data would exclude these completed players
- **E**: not supported, because the affected wars started before the deployment boundary, not after it
- **F**: not needed, because the evidence already points cleanly to **C**

## Why PR #1685 did not resolve it

PR `#1685` addressed the active-war writer path, but it did not change the todo snapshot preservation rule.

Once the war stopped presenting as a live current-war source, `TodoSnapshotService` continued to prefer the existing `LIVE_VERIFIED` snapshot over a lower-confidence `PERSISTED_FALLBACK` attempt. That preserved the stale `0/2` display in `/todo`.

## Root-cause confidence

Confidence: **87%**

Why not higher:

- live CoC was no longer available by the time of inspection
- reminder recipients were not recoverable from a direct structured delivery log in the sampled window

Why it is still strong:

- the `CurrentWar`, `WarAttacks`, and `TodoPlayerSnapshot` rows line up on the same clan tags, war IDs, and player tags
- the logs show the todo writer suppressing the lower-confidence update
- the war start times clearly predate both `#1685` and `#1686`

## Minimal recommended fix

Keep the architecture intact, but change the todo refresh path so completed war attack counts do not get frozen from an older live-verified snapshot once the authoritative war state has already completed.

The smallest safe direction is:

- prefer authoritative `WarAttacks` counts when the war has completed
- do not let a later `PERSISTED_FALLBACK` observation preserve an older `warAttacksUsed=0` value for the same war identity
- keep reminder-side reads DB-first and do not add a live CoC fetch there

## Required regression coverage

Add a real persistence regression test that:

- exercises the actual writer or a narrowly factored helper, not a mock of the writer
- persists an active war with a member who has two attacks
- verifies the authoritative `WarAttacks.attackOrder=0` row ends at `attacksUsed=2`
- verifies the matching `TodoPlayerSnapshot` no longer stays pinned at `warAttacksUsed=0`
- verifies `/todo`-style war-state derivation resolves the player as completed
- verifies reminder roster resolution excludes the completed player
- reproduces the deployment-crossing war shape, not a synthetic unrelated war

