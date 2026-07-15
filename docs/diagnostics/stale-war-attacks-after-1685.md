# Stale war attacks after PR #1683

## Executive conclusion

The stale `/todo` war-attacks were caused by an ownership guard in `WarEventLogService.processSubscription()` that was introduced with merge PR `#1683` (`765bbd53`).

That guard treated an intentionally unused legacy `CurrentWar.syncNum` on a confirmed non-FWA active war as if the service had lost ownership of the row. When the canonical `CurrentWar.syncNumber` was still `null` and the legacy `syncNum` was populated, the sync allocator returned:

- `source = existing_current_war`
- `usable = false`
- `persistence = not_needed`

for BL/MM rows.

The downstream `assignmentNeedsOwnership` check then returned early anyway, which aborted:

- current-war finalization
- `syncWarAttacksFromWarSnapshot()`

As a result, `WarAttacks.attackOrder = 0` rows were never refreshed from the live war snapshot, so completed attackers remained stuck at stale `attacksUsed` values and were still eligible for reminder pings.

Reminder dispatch itself was not the bug. `ReminderDispatchService` only reads persisted `WarAttacks` `attackOrder = 0` rows and filters by `attacksUsed < 2`, so it simply consumed the stale writer output.

## Production evidence

- The deployed revision in production at diagnosis time was `698dbcf87de17fc36c2b871cf815b2444c7bee0c`.
- The production container started at `2026-07-15T16:28:08.88404622Z`.
- `BotPollJobStatus.war_event_poll_cycle` was healthy at the time of inspection:
  - `enabled = true`
  - `status = idle`
  - `intervalMs = 300000`
  - `lastSuccessAt = 2026-07-15 18:33:10.596`
  - `runCount = 16226`
  - `failureCount = 154`
  - `metadata = {"mode":"active"}`

That means the poll loop itself was still operating. The failure was specific to the write/finalization handoff for active wars.

I also sampled production for the exact live signature that would prove the stale state directly:

- active `CurrentWar` rows with `syncNumber IS NULL`
- legacy `syncNum IS NOT NULL`
- `matchType IN ('BL', 'MM')`

At the time of sampling, there were no rows left matching that exact signature, which indicates the incident had already moved on or self-healed by the time of inspection. The root cause is therefore established from the deployed code path and incident trace, not from a still-live stale row.

## Exact root cause

PR `#1683` made `CurrentWar.syncNumber` nullable while preserving the legacy `syncNum` field on existing active rows.

In the deployed code path, `WarEventLogService` resolved a BL/MM active war with the legacy sync number into an `existing_current_war` assignment that was intentionally unusable for canonical persistence. That should have been treated as a safe, non-owning legacy read.

Instead, the `assignmentNeedsOwnership` guard conflated that safe legacy state with actual ownership loss. The guard only needed to fail closed for real persistence or identity failures:

- `conflict`
- `revision_changed`
- `identity_changed`
- `active_cycle_conflict`

But it also returned early for the legacy non-FWA path, which prevented the current-war row from reaching finalization and prevented the war-attack snapshot refresh from running.

That is the regression mechanism.

## Why reminders went stale

`ReminderDispatchService.resolveWarReminderRoster()` does not fetch live CoC data. It trusts the persisted `CurrentWar.warId` plus the `WarAttacks` roster rows with `attackOrder = 0`.

If the writer never refreshes those rows, a player who already spent both attacks can still appear as if they have attacks remaining. That is why the reminder system pinged completed attackers.

## What this was not

- Not a reminder-dispatch live-fetch omission.
- Not a schema migration problem.
- Not a need to backfill `CurrentWar.syncNumber` for BL/MM.
- Not a `WarAttacks` read bug.

The stale reminders were a downstream symptom of the upstream early return in the active-war reconciliation path.

## Status

A later code change narrowed the ownership guard so the intentional legacy non-FWA case can continue through finalization and attack refresh. No production data was modified during this diagnosis.
