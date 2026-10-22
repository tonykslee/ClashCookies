# Missing Sync Spin Status: Production Investigation

Investigation date: 2026-10-22 UTC. This is an investigation-only report. No production rows, Discord messages, scheduler state, or migrations were changed.

## Executive Summary

The two reported symptoms have a confirmed shared lifecycle failure in the affected production case:

- `/sync post status` without `message-id` started at `2026-10-22T04:37:51.633Z` in guild `1324040917602013261`.
- The latest sync-time root, message `1562520744922193962`, was updated to `DELETED` at `2026-10-22T04:37:51.999Z`.
- That root was due for its five-minute reminder at `2026-10-22T04:55:00Z`, so it was already excluded when the reminder scheduler became due.
- No child Sync Spin Status row was created, and the root metadata has no `reminderSentAt` or `statusPostedAt`.

Therefore, the missing automatic Sync Spin Status is explained by the root being `DELETED` before the due sweep. The one-hour expiration was not the cause: the root's `expiresAt` was `2026-10-22T06:00:00Z`.

The production evidence confirms the destructive state transition and its scheduler consequence. The exact Discord fetch result that caused the transition is not recoverable from the old code path because it swallowed fetch errors and emitted no lookup classification. The leading explanation is the old automatic lookup in `src/commands/Post.ts`: it fetched the selected active root, treated every unsuccessful fetch or format check as unavailable, called `markMessageDeleted()`, and returned. That attribution is highly consistent with the command timestamp, but the original API response is an inferred detail rather than a confirmed fact.

## Confirmed Findings

### Production root state

The newest root `SYNC_TIME_POST` row for the affected guild was:

| Field | Value |
| --- | --- |
| Guild | `1324040917602013261` |
| Source channel | `1510493487106363462` |
| Root message | `1562520744922193962` |
| Status | `DELETED` |
| `createdAt` | `2026-10-21T17:39:36.250Z` |
| `updatedAt` | `2026-10-22T04:37:51.999Z` |
| `syncTimeIso` | `2026-10-22T05:00:00.000Z` |
| `remindAt` | `2026-10-22T04:55:00.000Z` |
| `expiresAt` | `2026-10-22T06:00:00.000Z` |

The row had no `referenceId` and was the authoritative root shape. A query for the root and all rows referencing it returned only the root; there was no status child. Its metadata contained the sync identity and clan data but no `reminderSentAt` or `statusPostedAt`.

### Lookup and scheduler behavior

The current code establishes the relevant state machine:

1. `resolveLatestActiveSyncPost()` selects only the guild-scoped root with `referenceId = null`, `featureType = SYNC_TIME_POST`, and `status = ACTIVE` (`src/services/TrackedMessageService.ts`).
2. The old automatic resolver in `src/commands/Post.ts` fetched that root from Discord. Any rejected fetch, unavailable channel, non-text channel, non-bot message, or format mismatch returned `null`.
3. For every such `null` result, the old resolver called `markMessageDeleted()` and stopped before using the saved pointer fallback.
4. `markMessageDeleted()` changes the tracked row to `DELETED`; for a root it also changes active child rows referencing that root to `DELETED`.
5. `processDueSyncReminders()` selects only active root rows whose `remindAt` is due. A deleted, expired, or replaced root is excluded before Discord delivery is attempted.
6. The ready listener runs expiration processing and then Sync Spin Status reminder processing every minute.

The explicit `message-id` path is separate: it scans the interaction guild's channel cache and fetches the supplied message directly. It does not require a tracked root, which explains why explicit lookup continued to work for an untracked or damaged announcement.

### Saved pointer comparison

The publisher log for the affected root recorded `active_settings_pointer_succeeded=true` when the announcement was published. At investigation time, a read-only query found no current `active_sync_post:<guildId>` `BotSetting` row. This means the pointer could not be used as current corroboration; the DB root was the authoritative evidence. The old resolver would not have consulted the pointer while an active root row existed, so pointer state did not protect the root from the failed active-root fetch.

## Production Evidence

The following evidence was collected read-only from the production host and database:

- The publication log recorded root message `1562520744922193962` in the affected guild and channel, with the active settings pointer write reporting success.
- Checklist diagnostics still identified that message as `active_sync_post` at `2026-10-22T04:37:42.874Z`, shortly before the status command.
- The command log recorded `/sync post status` for the same guild at `2026-10-22T04:37:51.632Z`; command lifecycle telemetry started at `04:37:51.633Z`.
- The tracked root's `updatedAt` is `04:37:51.999Z`, 366 milliseconds after command lifecycle start and 17 minutes 8 seconds before `remindAt`.
- No status-child row exists for the root. The absence of `statusPostedAt` is consistent with the scheduler never selecting the root.
- The current `tracked_message_sweep` poll row was healthy when inspected (`idle`, `failureCount = 0`, recent success). The scheduler's selection query independently proves that a `DELETED` root cannot be processed, so a reminder delivery failure is not needed to explain this incident.

The production log does not contain the old automatic-lookup error classification or a successful command-completion record that identifies whether Discord returned Unknown Message, Forbidden, a transient API error, or a format mismatch. The old implementation did not retain that distinction.

## Reproduction/Test Evidence

### Deterministic code-path reproduction

The incident is reproducible from the old control flow without contacting Discord:

1. Start with an `ACTIVE` root having `referenceId = null` and a future `remindAt`.
2. Make the automatic channel/message fetch resolve to `null` (the old code used the same result for missing, permission, temporary API, and format failures).
3. The resolver calls `markMessageDeleted(rootMessageId)`.
4. Advance to `remindAt` and run `processDueSyncReminders()`.
5. The root is not in the `status = ACTIVE` due query, so no Sync Spin Status child is sent.

This is a deterministic source-level reproduction, not a replay against production. The explicit-ID branch remains independent of this state transition.

### Local verification

On the clean investigation branch:

```text
npx vitest run tests/sync.command.test.ts tests/trackedMessage.syncStatus.test.ts tests/trackedMessage.syncRootOwnership.test.ts tests/ready.listener.test.ts
4 files passed, 57 tests passed

npx tsc --noEmit
passed
```

The existing tracked-message tests cover successful due posting, destination fallback, child deduplication, and related failure isolation. The PR #1898 test diff reviewed locally adds targeted command cases for normal automatic lookup, expired-root exclusion, temporary fetch errors, missing permissions, invalid format, stale saved pointers, definitive missing messages, and guild isolation. Those new cases were reviewed as part of the PR analysis; they were not applied to or executed from this documentation-only branch.

## Root Cause

### Confirmed production cause

The affected root was `DELETED` before its scheduled reminder. Because the reminder scheduler requires an `ACTIVE` root, the root was excluded and no automatic Sync Spin Status post could be created. The one-hour expiration policy was not involved.

The same root state explains why automatic `/sync post status` failed while an explicit message ID could still work: automatic lookup depends on the active tracked root and validates the Discord message; explicit lookup directly fetches the supplied message and does not require tracking.

### Confirmed versus inferred details

Confirmed:

- The status command ran in the affected guild immediately before the root was marked deleted.
- The root changed to `DELETED` before `remindAt`.
- The reminder selection excludes that root state.
- No scheduler delivery attempt or child row is required to explain the missing reminder.

Inferred but not directly recoverable:

- The command's automatic fetch most likely caused the state transition through the old `markMessageDeleted()` call, because the command and update timestamps align and the old resolver had exactly this destructive behavior.
- The original Discord result was one of: definitive missing message, missing permission, temporary API failure, unavailable channel, or format mismatch. The old code discarded the distinction.

The evidence does not justify claiming that the root had definitely been deleted by Discord rather than marked deleted by the command. A Discord `messageDelete` event is another existing caller of `markMessageDeleted()`, but no retained event log identifies that as the writer for this transition.

## Relationship to PR #1898

PR #1898 corresponds locally to commit `e1b5fa60` (`fix(sync): harden automatic sync status resolution`). It is directly relevant and preventive:

- It keeps the DB-first active-root lookup.
- It classifies tracked-message state and Discord fetch outcomes separately.
- It only calls `markMessageDeleted()` for a definitively missing Discord response.
- It preserves tracking for permissions, temporary API failures, unavailable channels, and format mismatches.
- It validates the saved pointer against tracked ownership and status instead of reviving a stale or replaced row.
- It emits bounded automatic-lookup diagnostics and gives users a message-ID fallback.

The PR does not restore this already-deleted production root, create a status child retroactively, alter scheduler ownership, or extend the one-hour lifecycle. It prevents the same class of future automatic lookup failure from destroying an otherwise usable root. Its tests are command-level mocks; the existing scheduler tests separately cover active-root delivery and idempotence. No scheduler or publisher defect was found that requires a change in this investigation.

## Recommended Fixes

1. Merge PR #1898 as the scoped prevention for unsafe automatic lookup cleanup.
2. Do not reset the affected production root to `ACTIVE`, recreate its child, or mutate its lifecycle. That would violate tracked-message ownership and could revive a replaced or genuinely deleted announcement.
3. Keep the existing `remindAt = sync time - 5 minutes` and `expiresAt = sync time + 1 hour` policy. If a root is already deleted before the reminder boundary, the current lifecycle correctly prevents automatic status delivery; this investigation does not recommend extending that lifecycle.
4. For a still-existing historical message, use the explicit `message-id` path as the user-facing recovery route. A new sync announcement will establish a fresh authoritative root through the existing publisher transaction.
5. As a separate observability follow-up, add a bounded event identifying the writer/reason for `markMessageDeleted()` and a per-root scheduler decision reason. That would distinguish a Discord delete event from command lookup cleanup without changing ownership or behavior.

## Remaining Unknowns

- The exact Discord/API error or response for the `04:37:51Z` automatic lookup is not present in the old logs.
- The command lifecycle record has a start event, but the retained evidence does not provide a completion event that records the lookup result or response text.
- The saved `active_sync_post:<guildId>` pointer was absent when inspected; its exact state at the time of the command cannot be reconstructed from the current database snapshot.
- The direct writer of the `DELETED` update cannot be proven from the row alone because both the old command resolver and the Discord `messageDelete` listener can call `markMessageDeleted()`.
- There is no evidence that the typed destination channel, source channel send, reaction handling, or reminder scheduler failed for this root: the root was excluded before those delivery steps.
