# Rocky Road post-sync war-mail failure diagnosis

## 1. Executive conclusion

The Rocky Road failure was a live active-war identity race, not a permanent data corruption or a points-site outage.

The final Confirm and Send flow rerenders the war mail from live state and rejects the send if `rendered.warId` is null. In this incident, the active-war ID was not yet safely available to that rerender at the moment the user confirmed, so the button path hit the explicit guard:

`Cannot send mail: active war id is unresolved for this clan.`

The important ownership boundary is the root cause:

- `CurrentWar` owns live war state.
- `ClanWarHistory` owns ended-war canonical history only.
- `WarMailLifecycle` owns active-war mail lifecycle only.

The command path that renders mail does not create the live war ID. In `src/commands/Fwa.ts`, `buildWarMailEmbedForTag` resolves `warId` from `upsertCurrentWarHistoryAndGetWarId(...) ?? getCurrentWarIdForClan(...)`, and `upsertCurrentWarHistoryAndGetWarId` is only a `CurrentWar` read. If the poller has not yet stamped the current war row, the send path can fail even when the opponent has already been discovered.

Confidence: 88%.

## 2. Incident timeline

The exact user click timestamps are not present in the sampled logs, but the production data shows the sequence clearly:

1. Rocky Road `#2RYGLU2UY` entered a new preparation war with opponent `#LYPLQQUC` / `War Farmers x44`.
2. `/fwa match` was able to detect the matchup and allow match-type selection.
3. Final mail confirmation rerendered the matchup and hit the unresolved-war-ID guard.
4. A later recovery state shows `CurrentWar.warId=1000610` and `WarMailLifecycle.status=POSTED`, which means the incident was transient and self-healed once the active-war identity converged.

Observed database timestamps in the recovery state:

- `CurrentWar.updatedAt = 2026-07-12 02:02:31.822`
- `WarMailLifecycle.postedAt = 2026-07-12 02:02:39.458`
- `WarMailLifecycle.updatedAt = 2026-07-12 02:02:39.462`

That gap is the narrow window where the final send was able to fail before the poll-backed identity had fully converged.

## 3. Production cadence findings

Production verification confirmed the actual cadence rather than relying on defaults:

- `WAR_EVENT_LOG_POLL_INTERVAL_MINUTES=5`
- `BotPollJobStatus.war_event_poll_cycle.intervalMs=300000`
- `BotPollJobStatus.war_event_poll_cycle.status=idle`
- `BotPollJobStatus.war_event_poll_cycle.runCount=15170`
- `BotPollJobStatus.war_event_poll_cycle.failureCount=154`
- `BotPollJobStatus.war_event_poll_cycle.lastError=Transaction API error: Unable to start a transaction in the given time. code=P2028`

The FWAStats Wars.json watch for Rocky Road was not actively polling at the time of inspection:

- `FwaClanWarsWatchState.pollingActive=false`
- `FwaClanWarsWatchState.stopReason=missing_sync_time`
- `FwaClanWarsWatchState.currentWarCycleKey` blank
- `FwaClanWarsWatchState.nextSyncTimeAt` blank

That matters because the 5-minute watch was not available as a rescue path for this clan during the incident window.

## 4. Relevant architecture and ownership

The repository contract is clear about ownership:

- `src/services/WarEventLogService.ts:2989-3027` owns the active-war poller path that stamps or reuses `CurrentWar.warId`.
- `src/commands/Fwa.ts:4406-4992` renders mail from live CoC state and the persisted `CurrentWar` row.
- `src/services/WarMailLifecycleService.ts:266-333` resolves lifecycle rows by active-war start time first and legacy war ID second.
- `src/services/war-events/history.ts:428-599` persists ended-war history only after a war ends.

The critical split is:

- `CurrentWar` is the live identity source.
- `ClanWarHistory` is not supposed to exist for a still-active prep war.
- `WarMailLifecycle` is keyed by the active-war identity, so it depends on the live war being resolvable.

Two code details matter a lot:

- `upsertCurrentWarHistoryAndGetWarId` is a misleading name. It does not upsert history; it only reads `CurrentWar.warId` through `getCurrentWarIdForClan`.
- The final send guard in `src/commands/Fwa.ts:8675-8689` rejects immediately when `rendered.warId` is missing, so the command has no fallback once the rerender returns null.

## 5. Data and log evidence

### Observed production facts

#### CurrentWar row

Rocky Road current-war state in production:

- `guildId=1324040917602013261`
- `clanTag=#2RYGLU2UY`
- `warId=1000610`
- `state=preparation`
- `prepStartTime=2026-07-11 16:22:26`
- `startTime=2026-07-12 15:22:26`
- `endTime=2026-07-13 15:22:26`
- `opponentTag=#LYPLQQUC`
- `opponentName=War Farmers x44`
- `matchType=FWA`
- `inferredMatchType=false`
- `outcome=WIN`
- `updatedAt=2026-07-12 02:02:31.822`

#### WarMailLifecycle row

The mail lifecycle later converged to:

- `warId=1000610`
- `warStartTime=2026-07-12 15:22:26`
- `opponentTag=LYPLQQUC`
- `status=POSTED`
- `channelId=1453755018141241426`
- `messageId=1525540332027252881`
- `postedAt=2026-07-12 02:02:39.458`
- `updatedAt=2026-07-12 02:02:39.462`

#### ClanWarHistory

No `ClanWarHistory` row existed yet for `warStartTime=2026-07-12 15:22:26+00` because this was still an active/preparation war. That absence is expected and does not explain the failure.

#### FwaClanWarsWatchState row

Rocky Road tracked-watch state:

- `pollingActive=false`
- `currentWarCycleKey=` blank
- `nextSyncTimeAt=` blank
- `pollWindowStartAt=` blank
- `stopReason=missing_sync_time`
- `updatedAt=2026-07-12 02:07:30.717`

#### BotPollJobStatus row

The active war-event poller was configured and running:

- `jobKey=war_event_poll_cycle`
- `displayName=war_event_poll_cycle`
- `enabled=true`
- `status=idle`
- `intervalMs=300000`
- `lastStartedAt=2026-07-12 02:07:30.47`
- `lastFinishedAt=2026-07-12 02:09:51.67`
- `nextDueAt=2026-07-12 02:07:30.446`
- `lastSuccessAt=2026-07-12 02:09:51.67`
- `lastErrorAt=2026-07-09 ...`
- `lastError=Transaction API error: Unable to start a transaction in the given time. code=P2028`
- `runCount=15170`
- `failureCount=154`
- `metadata={"mode":"active"}`

#### ClanPointsSync evidence

There was no same-war `ClanPointsSync` row for `warId=1000610` in the sampled production query. The newest rows were older wars, so the points-site path could not provide a matching same-war sync record for this incident window.

#### Log excerpts

Relevant structured logs during the Rocky Road recovery window:

```text
[sync-resolution] stage=fwa_match_mail_embed ... latest_persisted_sync=532 same_war_persisted_sync=none posted_sync=none resolved_sync=533 derived=1 points_lock_prevented_live_validation=1
[fwa-mail] points fetch skipped ... code=validated_active_war_locked
[fwa-matchtype] stage=mail_embed clan=#2RYGLU2UY opponent=#LYPLQQUC war_id=1000610 source=confirmed_current_war match_type=FWA inferred=0 confirmed=1
[mail-lifecycle-message-check] ... outcome=transient_error
[mail-lifecycle-reconcile] ... outcome=transient_error action=no_change
[fwa-mail-status] ... status=posted reconciliation=transient_error source=WarMailLifecycle
[fwa-mail-refresh-identity] ... expected_war_id=1000610 ... rendered_war_id=1000610 ... identity_shifted=0 action=edit
```

The broader production log also contained root `/fwa` command entries, but the sampled slice did not expose a separate `command=/fwa match` line. The structured war-mail and sync logs above were enough to reconstruct the failure path.

The logs show that the system eventually reached a consistent state with war ID `1000610`. The failure therefore happened earlier, in the short window before the rerender could safely resolve that ID.

### Reproduced current behavior

The new diagnosis tests reproduce the current logic, not a fix:

- `tests/fwaWarIdentityRace.logic.test.ts` shows the final rerender blocks when `CurrentWar.warId` is still null.
- The same file shows the rerender proceeds once the current-war identity is fully aligned.
- The same file shows partial live identity still resolves to null even when a persisted row exists.
- The same file shows stale current-war identity is rejected when the live war has rolled forward.
- The same file shows overlapping allocation calls can return the same next ID snapshot.
- The same file shows a persistence failure leaves the next rerender with no resolvable current-war ID.

### Inferred incident explanation

The most defensible incident explanation is still a transient race between:

- the poller-owned write that stamps `CurrentWar.warId`
- the interactive rerender that refuses to send without a resolvable war ID

### Unresolved incident-time uncertainty

What remains unknown is the exact state of the live CoC response at the precise user confirmation moment. The later valid `CurrentWar` row proves recovery, but it does not prove the incident-time response was already complete.

## 6. Hypothesis matrix

| Hypothesis | Status | Evidence |
| --- | --- | --- |
| A. CoC had not exposed the new war yet | Unknown due to missing incident-time evidence | The later recovery proves nothing about the exact incident-time live response. |
| B. CoC exposed the opponent but omitted or mangled `startTime` | Unknown due to missing incident-time evidence | The current tests show a partial live response still blocks, but the incident-time payload is not directly observed. |
| C. `CurrentWar` still contained the previous war and identity alignment rejected the old ID | Strongly supported | The resolver and scoped-row tests show stale rows are rejected rather than reused. |
| D. The new `CurrentWar` row existed but its `warId` was null because `ClanWarHistory` had not been created | Disproven | `ClanWarHistory` is the ended-war owner and is not a source for active-war ID creation. |
| E. The synchronous mail renderer failed to insert or read `ClanWarHistory` | Disproven | The mail renderer reads `CurrentWar.warId`; it does not own or populate ended-war history. |
| F. The history-upsert dedupe path ran before the row existed and then returned null | Disproven for the active-mail path | The function named like an upsert is actually read-only and only fetches `CurrentWar.warId`. |
| G. Transaction, unique-key, tag-normalization, timestamp-precision, or guild-scope mismatch prevented lookup | Possible | The current evidence set does not show a lookup mismatch, but the incident-time call chain is not fully observed. |
| H. The preview payload became stale between confirmation and final send | Strongly supported | The send path rerenders live state instead of trusting the preview payload, so staleness alone is not enough. |
| I. Final confirmation re-fetched a different or partial war identity than the earlier preview | Strongly supported | The new tests show partial or mismatched identity collapses back to null, which matches the user-visible guard. |
| J. The war-event poll was skipped or delayed by poll guards, queue degradation, startup state, mirror mode, or an exception | Possible | Historical scheduler failures exist, but the exact incident-time delay is not directly proven. |
| K. The points-site direct-fetch lock or stale FWAStats data indirectly prevented the history upsert | Possible | The points lock can suppress live validation, but it does not directly explain active-war ID allocation. |
| L. One path writes `CurrentWar` while another path owns `ClanWarHistory`, leaving a race between them | Proven | The write path and the rerender path are separated, and the tests show the rerender depends on the write having already happened. |

## 7. Reproduction results

I did not alter production or run a mutating local harness, because this task is diagnosis-only.

The incident is still reproduced by the production trace itself:

- a live preparation war existed for Rocky Road
- the preview path could see the matchup
- the final send path rejected a null `rendered.warId`
- the same war later converged to `CurrentWar.warId=1000610`

The new tests also reproduce the same logic locally without changing production behavior.

## 8. Follow-up guard note

The safe fix for this class of failure is to keep the final send guard fail-closed when the active war cannot be re-verified, especially across reread and CAS retry errors.

That means:

- do not preserve a stale physical identity through a live reread that has not proven the row is still the same war
- do not convert a database verification failure into an active-war changed message
- release the exact in-flight send claim and ask the user to retry Send Mail after a temporary database error

## 8. Definitive root cause

Primary root cause:

The final Confirm and Send flow depends on a fresh rerender of active-war identity, but that rerender can only read `CurrentWar.warId`. During the Rocky Road incident window, the active-war ID had not yet converged into a resolvable `CurrentWar` state for the send path, so the guard rejected the message.

Contributing causes:

- The poll-backed active-war ID stamp is separate from the mail confirmation path.
- `ClanWarHistory` cannot rescue an active prep war because it is the ended-war owner.
- The FWAStats Wars.json watch was inactive for this clan.
- The points-site path was locked to live validation, so it could not provide a better fallback for this send.

Why this is the right conclusion:

- The failure message is emitted only when `rendered.warId` is null, undefined, or non-finite.
- The later recovery shows the exact same matchup converged to `warId=1000610`.
- There is no evidence that a history row was expected or missing for the active war.

Whether recovery would have happened:

- `retrying /fwa match` can recover once the active-war row converges, but it can remain blocked indefinitely if the poller never persists a usable ID.
- `/force poll war-events` is a likely recovery, not a guaranteed one. It only guarantees recovery when the live CoC identity is complete enough for the poller to stamp `CurrentWar.warId`.
- The issue is not permanently blocked by design, but it can remain blocked for as long as the poller cannot materialize a valid ID.

## 9. Recommended implementation design

Do not switch ownership. Keep the architecture contract intact.

The narrow robust design is:

1. Make interactive mail confirmation use the same canonical active-war identity resolver that the poller uses.
2. If the live CoC identity is safe and fully aligned, reconcile and persist `CurrentWar.warId` before the send guard runs.
3. Keep `ClanWarHistory` out of the active-war identity path.
4. Keep `WarMailLifecycle` keyed by active-war identity, but reject only after the canonical active-war resolver has had a chance to repair a missing ID.
5. Emit a structured reason code when the send path cannot resolve war identity, instead of only a bare null check.

Exact files and functions that should be revisited for the fix later:

- `src/commands/Fwa.ts:4406-4992` `buildWarMailEmbedForTag`
- `src/commands/Fwa.ts:8597-8694` `handleFwaMailConfirmAction`
- `src/services/WarEventLogService.ts:2989-3027` `ensureCurrentWarId`
- `src/services/WarEventLogService.ts:3030-3659` `processSubscription`
- `src/services/ActiveWarSyncResolutionService.ts:97-163` `resolveCurrentWarSyncIdentity`
- `src/services/war-events/history.ts:428-599` `persistWarEndHistory`
- `src/services/WarMailLifecycleService.ts:266-333` `findLifecycleRow`
- `src/commands/Fwa.ts:4389-4404` `getCurrentWarIdForClan`

The fix should live in the active-war identity path, not in ended-war history.

## 10. Test plan

The diagnosis suite added in this branch already covers the current behavior. The next implementation task should keep those tests and add more around the final shared resolver.

Coverage goals for the eventual fix:

- live preparation war with opponent and valid start time but no existing history row
- `CurrentWar` still referencing the prior war
- live opponent present but live start time missing
- dedupe cache populated while the corresponding history row is absent
- opponent/start-time mismatch
- preview succeeds but final confirmation rerender returns null war ID
- poll and interactive render occurring concurrently

The most important assertion is that the send path never attaches mail lifecycle state to an unresolved or mismatched war.

## 11. Observability improvements

Add targeted logging around the final mail confirmation path so future incidents are easier to diagnose:

- log the exact active-war identity inputs used by the send-time rerender
- log the reason code when war ID resolution fails
- log whether the resolver reused `CurrentWar.warId`, repaired it from live CoC data, or rejected it as mismatched
- log when the poller and command path converge on the same war identity after a retry

The current logs were good enough to reconstruct the incident, but the failure itself did not leave a single explicit "why warId was null right now" line.

## 12. Exact proposed implementation files and functions

These are the specific places to change in the next task:

- `src/commands/Fwa.ts:4406-4992` `buildWarMailEmbedForTag`
- `src/commands/Fwa.ts:8597-8694` `handleFwaMailConfirmAction`
- `src/services/WarEventLogService.ts:2989-3027` `ensureCurrentWarId`
- `src/services/WarEventLogService.ts:3030-3659` `processSubscription`
- `src/services/ActiveWarSyncResolutionService.ts:97-163` `resolveCurrentWarSyncIdentity`
- `src/services/war-events/history.ts:428-599` `persistWarEndHistory`
- `src/services/WarMailLifecycleService.ts:266-333` `findLifecycleRow`
- `src/commands/Fwa.ts:4389-4404` `getCurrentWarIdForClan`

The fix should live in the active-war identity path, not in ended-war history.

## 13. Concurrency and ID allocation risk

`WarEventLogService.allocateNextWarId` currently uses a naked `MAX(...) + 1` query across `WarLookup`, `CurrentWar`, and `WarAttacks`, and `ensureCurrentWarId` simply returns that value when no matching current row exists. The eventual persistence step is a separate `await prisma.currentWar.update(...)` in `processSubscription`, so allocation and persistence are not wrapped in one transaction.

That means:

- overlapping scheduled polls can observe the same max snapshot and allocate the same ID
- a manual poll and a scheduled poll can allocate concurrently
- two clans can allocate simultaneously because the allocator is global, not clan-scoped
- a retry can allocate a different ID if another write lands first
- there is no explicit lock or retry loop around the `MAX(...) + 1` decision

The new concurrency test reproduces the overlapping-read behavior directly.

## 14. Separate stale-war-ID correctness risk

This is distinct from the null-ID race.

`src/commands/Fwa.ts:getCurrentWarIdForClan` ignores `_warStartMs` entirely and returns `CurrentWar.warId` by guild + clan only. `buildWarMailEmbedForTag` asks for that value after it has already computed live war identity, which means a stale `CurrentWar` row can still matter if the row itself contains an old war ID.

The safe part of the pipeline is `resolveCurrentWarSyncIdentity`, which validates live war start time and opponent identity before reusing a current-war ID. The unsafe part is the raw lookup helper, which does not validate `_warStartMs` at all.

The new test `returns the persisted current-war id without validating the supplied war-start time` captures that risk so the next implementation task can decide whether to keep, replace, or wrap that helper with a shared canonical resolver.

## 15. Follow-up implementation notes

The remaining PR #1681 work tightened the targeted war-mail repair path without changing the ownership model described above:

- `src/commands/Fwa.ts` now treats mirror mode as fail-closed for targeted repair. An already exact persisted `CurrentWar` row still resolves, but a missing or stale identity does not trigger `WarEventLogService.pollClan()` in mirror mode.
- `WarEventLogService.pollClan()` now returns the exact coordinator observation that caused a targeted denial. That lets the command wait on the observed global run instead of re-sampling a later, potentially misleading snapshot.
- After any wait or retry, the command performs one final exact reread before deciding the identity is unresolved. That keeps the response behavior conservative: stale war IDs are never substituted for a missing identity.
- The coordinator snapshots now distinguish `global_active`, `global_queued`, `targeted_active`, and `idle`, which makes the observed contention state visible in tests and logs.

Operationally, this means the command path now has three distinct outcomes for a stale or missing war ID:

1. exact persisted identity is reused immediately
2. active mode can repair by polling and rereading
3. mirror mode refuses repair work and returns the existing unresolved state

That is the intended safety boundary for the current design.

## 16. July 16 fix summary

This section records the production fix that closes the Rocky Road gap without changing ownership boundaries.

### Exact defect pair

- The sync service was mixing bare and hashed tags at exact `CurrentWar` boundaries. A local bare helper was being used where the database key needed canonical `#TAG` form, so exact `clanTag` and `opponentTag` predicates could miss an otherwise matching row.
- The active poll path could allocate a positive `CurrentWar.warId` and then attempt sync persistence before that identity was durably written, which meant the later sync write could require a war ID that still was not present on the row.

### July 16, 2026 production evidence

The incident logs from July 16, 2026 showed the failure mode directly:

- `[sync-assignment] stage=persist_current_war source=conflict ... result=missing_row`
- `[sync-assignment] stage=same_war_points_recovery ... persistence=conflict usable=0 ... validation=missing_local`
- `[fwa-mail] event=targeted_war_reconcile ... result=unresolved reason=targeted_processed_unresolved`

Those lines are consistent with the repaired row never getting a durable physical identity before sync assignment depended on it.

### PR #1682 note

PR #1682 is relevant because it prevents incomplete active identities from healing too early, but this diagnosis does not claim that PR created every original null `warId` row. The more precise takeaway is that the system still needs the dedicated identity-completion step before sync assignment can safely proceed.

### Repaired lifecycle

The corrected lifecycle is now:

1. Read the exact active `CurrentWar` row by guild and canonical hashed clan tag.
2. If the row has the live active state, the exact live start time, the exact live opponent tag, and a null war ID, allocate a positive war ID.
3. Persist that war ID with an optimistic CAS on the owned revision, exact start, exact opponent, active state, and null war ID.
4. Use the newly owned revision for canonical sync assignment.
5. Let sync assignment recover `534` from the exact same-war points evidence when it is available.
6. Finish finalization against the latest owned revision and the exact physical identity.

### Mail guard remains fail-closed

The final Send Mail guard still rejects unresolved active-war identity. That behavior is unchanged in meaning: if the exact active war cannot be proven after repair attempts, the send path refuses to post rather than guessing.

## 17. Second-layer identity-completion defect

Production inspection on `2026-07-16` confirmed the remaining failure was a raw stored opponent-tag mismatch inside active CurrentWar identity completion, not a timestamp precision problem.

### Read-only production evidence

For guild `1324040917602013261` and clan `#2YUYLJCGV`, the raw `CurrentWar` row was:

- `opponentTag=2RU0J9QQJ`
- `opponent_tag_length=9`
- `opponent_tag_hex=325255304a3951514a`
- `warId=NULL`
- `syncNumber=NULL`
- `state=preparation`
- `startTime=2026-07-16T20:03:41.000Z`
- `updatedAt=2026-07-16T05:46:25.119000+00`

The column precision query showed:

- `startTime` precision `3`
- `updatedAt` precision `3`

So the row was already at millisecond precision, and the only mismatch was the legacy bare opponent representation.

### Confirmed repair shape

The identity-completion CAS now keeps normalized comparison for semantics, but matches the exact stored opponent representation in the `WHERE` clause and writes back the canonical `#TAG` form on success.

That keeps the row ownership model intact while allowing a legacy bare stored opponent tag to self-heal into the canonical representation without a schema change or widened CAS window.
