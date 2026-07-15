# Autorole Stale Clan Role Diagnosis

## 1. Executive Summary
- Confirmed from production data/logs: Discord user `...3710` still has the Rising Dawn tracked-clan role, but every linked Clash account now lives outside Rising Dawn.
- Confirmed from production data/logs: the linked player `#YQ...G20P` is live in `Phoenix Reborn`, while the persisted `PlayerCurrent` row still says `RISING DAWN` and the persisted `PlayerActivity` row also still says `RISING DAWN`.
- Confirmed from code: `/accounts` treats a clan as known if either `PlayerCurrent.currentClanTag` or `PlayerActivity.clanTag` exists, so stale `PlayerActivity` can keep the Rising Dawn label visible even after `PlayerCurrent` is corrected.
- Confirmed from code and production data/logs: autorole does not read `PlayerActivity`, but it *does* trust persisted `PlayerCurrent`, and the stale `PlayerCurrent` row for the affected player was never negated by a pending-removal row.
- Confirmed from production data/logs: the affected member has no `AutoRolePendingRemoval` row for the Rising Dawn role, so the role was never even put into the delayed-stale-removal path.
- Hypothesis still requiring evidence: the member-scoped `/autorole refresh user:<member>` path was not observed for this exact user in the run table, so I cannot claim that scope executed successfully for this member.

## 2. Architecture/Data-Flow Map
- Confirmed from code: live CoC player data enters `PlayerCurrentService.applyLivePlayer`, which clears `currentClanTag` and `currentClanName` when the live payload has no clan.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` preserves the previous `role` if the live payload omits role, which is a separate stale-field risk but not the clan-membership root cause here.
- Confirmed from code: `/accounts` resolves clan state from `PlayerCurrent` first, then `PlayerActivity`, and only falls back to `No Clan` when `PlayerCurrent.lastSource` proves the row was clanless.
- Confirmed from code: member-scoped autorole refresh calls `refreshCurrentPlayersFromLiveTags`, rereads successful `PlayerCurrent` rows, and evaluates with `preferCurrentClanTagForClanRules: true`.
- Confirmed from code: tracked-clan role refresh fetches live clan rosters and evaluates a positive overlay, but it does not synthesize a negative overlay for members absent from every fetched roster.
- Confirmed from code: guild-wide autorole refresh merges positive tracked-clan overlay data into persisted `PlayerCurrent` rows via `mergeTrackedClanPlayerCurrentOverlay`, which cannot clear a stale positive clan tag on its own.
- Confirmed from code: `AutoRoleApplyService` only removes stale managed roles when `removeStaleManagedRoles` is enabled, and CLAN roles may still wait behind `clanRoleRemovalDelayMinutes`.
- Confirmed from code: Discord role mutation happens only after evaluation and stale-removal policy decide the desired role set, so no removal attempt means no pending-removal row and no Discord write to inspect.

## 3. Exact Reproduction
- Confirmed from production data/logs: Discord user `...3710` currently holds the Rising Dawn role.
- Confirmed from production data/logs: all four linked accounts for that user are no longer in Rising Dawn; one is live in `Phoenix Reborn`, one is live in `Green Fox`, and two return no clan at all.
- Confirmed from production data/logs: the representative stale linked player `#YQ...G20P` has `PlayerCurrent.currentClanTag = #2YUYLJCGV`, `PlayerCurrent.currentClanName = RISING DAWN`, `PlayerActivity.clanTag = #2YUYLJCGV`, and `PlayerActivity.clanName = RISING DAWN`.
- Confirmed from production data/logs: the same linked player’s live CoC payload now reports `clanTag = #28VUPJRPU` and `clanName = Phoenix Reborn`, which proves the persisted data is stale.
- Confirmed from production data/logs: `TodoPlayerSnapshot` for that linked player is already fresh and also says `Phoenix Reborn`, which shows there is a newer non-authoritative snapshot that agrees with live data.
- Confirmed from production data/logs: `FwaClanMemberCurrent` has no row for that linked player, so FWA is not the source of this stale membership.
- Confirmed from production data/logs: `AutoRolePendingRemoval` has zero rows for this user and the Rising Dawn role, so the role did not enter delayed stale-removal.
- Confirmed from production data/logs: `AutoRoleMemberState.lastEvaluatedAt` for the member matches the latest guild refresh window, but `lastAppliedAt` did not move, which means the latest evaluation did not produce a role change.
- Confirmed from production data/logs: the latest guild refresh run on `2026-07-15 09:14:45Z` completed with `removedCount = 0`.
- Reproduced locally: existing tests for clanless rendering, `PlayerActivity` fallback, user refresh stale-removal behavior, and tracked-clan evaluation all pass with `vitest`.

## 4. Production Configuration Findings
- Confirmed from production data/logs: the guild config has `removeStaleManagedRoles = true`.
- Confirmed from production data/logs: the guild config has `clanRoleRemovalDelayMinutes = 1440`, so stale CLAN roles can remain for 24 hours after they first become missing.
- Confirmed from production data/logs: Rising Dawn’s `TrackedClan.clanRoleId` is the same Discord role id used by the CLAN autorole rule for `#2YUYLJCGV`.
- Confirmed from production data/logs: the affected member has no user exclusion and no role exclusion.
- Confirmed from production data/logs: the Rising Dawn role is managed by the tracked-clan path, not just by a one-off manual Discord role assignment.

## 5. Production Row-by-Row Evidence
- Confirmed from production data/logs: `PlayerCurrent` for `#YQ...G20P` says `RISING DAWN`, `admin`, `lastSource = live_refresh`, `lastFetchedAt = 2026-04-30 17:26:42.957`, and `updatedAt = 2026-04-30 19:35:01.539`.
- Confirmed from production data/logs: `PlayerActivity` for `#YQ...G20P` says `RISING DAWN`, with `updatedAt = 2026-05-29 17:50:15.595` and `lastSeenAt = 2026-05-29 10:50:13.42`.
- Confirmed from production data/logs: `TodoPlayerSnapshot` for `#YQ...G20P` says `Phoenix Reborn`, with `clanMembershipObservedAt = 2026-07-15 08:46:32.981` and `updatedAt = 2026-07-15 09:21:33.238`.
- Confirmed from production data/logs: `AutoRoleMemberState` for Discord user `...3710` has `lastEvaluatedAt = 2026-07-15 09:14:45.628`, `lastAppliedAt = 2026-07-14 04:07:03.222`, and an empty `lastError`.
- Confirmed from production data/logs: `AutoRolePendingRemoval` count for Discord user `...3710` and the Rising Dawn role is `0`.
- Confirmed from production data/logs: `AutoRoleSyncRun` has a scheduled guild run starting at `2026-07-15 09:14:45.628` that completed with `evaluatedCount = 1271`, `removedCount = 0`, and `skippedCount = 1271`.
- Confirmed from production data/logs: the latest tracked-clan role run for Rising Dawn started at `2026-07-14 04:02:05.062` and completed with `removedCount = 60`, but the affected member was not removed and never entered pending-removal state.

## 6. Runtime/Log Evidence
- Confirmed from production data/logs: the latest guild refresh evaluation did run after the stale live mismatch was already present, which means this is not simply a forgotten member that never got re-evaluated.
- Confirmed from production data/logs: the runtime state shows evaluation without application for the affected member, which is consistent with the autorole engine still believing the role is desired.
- Hypothesis still requiring evidence: I did not extract raw Dozzle container logs in this pass, so the strongest runtime proof here comes from `AutoRoleSyncRun`, `AutoRoleMemberState`, and `AutoRolePendingRemoval` rather than line-by-line app logs.

## 7. Confirmed Root Cause(s)
- Confirmed from production data/logs: the affected user retains the Rising Dawn role because one linked player’s persisted `PlayerCurrent` row still says Rising Dawn even though live CoC and `TodoPlayerSnapshot` now say `Phoenix Reborn`.
- Confirmed from code: autorole evaluation uses `PlayerCurrent`, not `PlayerActivity`, so the stale `PlayerCurrent` row is sufficient to keep the role desired.
- Confirmed from code: `/accounts` is independently wrong because it falls back to `PlayerActivity`, and that row also still says Rising Dawn.
- Confirmed from code and production data/logs: guild refresh only overlays positive tracked-clan membership and does not clear a missing player from persisted current state, so a departed member can remain stale forever if no later live refresh overwrites the row.
- Confirmed from production data/logs: stale removal did not start, so the role was not merely delayed by the 24-hour cleanup gate.

## 8. Contributing Conditions
- Confirmed from code: `PlayerActivity.clanTag` is non-nullable, which makes it structurally unsuitable as a clanless source of truth.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` already knows how to clear a clanless live response, so the bug is not in that mapper’s null-clearing logic.
- Confirmed from production data/logs: the stale linked player’s `PlayerCurrent.lastFetchedAt` is more than two months older than the live mismatch observed on `2026-07-15`, so the row is simply stale.
- Confirmed from code: tracked-clan role refresh and guild refresh both prefer positive evidence, which means they can keep old positive state alive when the player disappears from every fetched roster.

## 9. Causes Explicitly Ruled Out
- Confirmed from production data/logs: `removeStaleManagedRoles` is enabled, so the issue is not caused by stale removal being globally disabled.
- Confirmed from production data/logs: there is no `AutoRolePendingRemoval` row for this user and role, so the issue is not a 24-hour delay still waiting to expire.
- Confirmed from production data/logs: there are no user or role exclusion rows for this member or the Rising Dawn role.
- Confirmed from code: autorole does not use `PlayerActivity` as its membership source, so `PlayerActivity` alone is not the reason the Discord role remains.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` would have cleared the clan if it had been invoked with a clanless live payload; the stale row persisted because the row was not refreshed, not because the mapper refused to clear it.
- Hypothesis still requiring evidence: Discord permission or hierarchy failure is not proven here, because no removal attempt was recorded for this member in the available run history.

## 10. `/accounts` and Autorole Root Cause Relationship
- Confirmed from code: `/accounts` has an extra `PlayerActivity` fallback that autorole does not have.
- Confirmed from production data/logs: the affected user’s `PlayerActivity` is stale in the same direction as `PlayerCurrent`, so `/accounts` is doubly wrong for this member.
- Confirmed from production data/logs: autorole is wrong because `PlayerCurrent` is stale, not because `PlayerActivity` exists.
- Conclusion: the two symptoms share a stale-state foundation, but they are still separate defects in the read paths.

## 11. Scope Differences
- Confirmed from code: member-scoped refresh is the only scope that directly re-fetches linked player tags through `refreshCurrentPlayersFromLiveTags`.
- Confirmed from code: tracked-clan role refresh uses live clan rosters and positive overlay data for the target role.
- Confirmed from code: guild-wide refresh merges positive overlay into persisted current rows, which can preserve stale positives when a player disappears from live rosters.
- Confirmed from production data/logs: the latest guild refresh did not remove the affected member’s role.
- Hypothesis still requiring evidence: I did not verify a recent user-scoped refresh for this exact member in the run table, so I cannot claim that scope executed successfully on this user.

## 12. Blast Radius
- Confirmed from code: any user with a stale positive `PlayerCurrent.currentClanTag` for a tracked clan can keep the corresponding Discord role.
- Confirmed from code: any user with stale `PlayerActivity` can also keep stale `/accounts` clan labeling even if `PlayerCurrent` is repaired later.
- Confirmed from production data/logs: the production instance already has at least one live member in this exact state, so the issue is not hypothetical.

## 13. Data Repair and Backfill Requirements
- Confirmed from code: the authoritative data to repair is `PlayerCurrent`, not `PlayerActivity`.
- Confirmed from production data/logs: the stale linked player needs a live refresh that writes the current `Phoenix Reborn` clan back into `PlayerCurrent`.
- Hypothesis still requiring evidence: `PlayerActivity` cannot be made clanless without a schema change, so code must stop trusting it for clanless rendering instead of trying to backfill it into a truthful null state.
- Confirmed from code: after the read-path fix lands, the smallest operational repair is to re-run the member-scoped live refresh and then re-run autorole evaluation for the affected member.

## 14. Minimal Recommended Implementation
- Hypothesis still requiring evidence: make `/accounts` prefer confirmed clanless `PlayerCurrent` over stale `PlayerActivity` when `PlayerCurrent.lastSource` indicates a real live refresh or accounts refresh.
- Hypothesis still requiring evidence: add a negative reconciliation step for tracked-clan refresh so that a member absent from every fetched roster can clear stale positive clan membership before autorole evaluation.
- Hypothesis still requiring evidence: keep the existing stale-removal and delay gates intact, because they are safety controls rather than the source of the bug.

## 15. Exact Files Likely Required
- Hypothesis still requiring evidence: `src/services/AccountRowsService.ts`.
- Hypothesis still requiring evidence: `src/services/AutoRoleRefreshService.ts`.
- Hypothesis still requiring evidence: `src/services/AutoRoleApplyService.ts`.
- Hypothesis still requiring evidence: `src/services/PlayerCurrentService.ts`.
- Hypothesis still requiring evidence: `tests/accounts.command.test.ts`.
- Hypothesis still requiring evidence: `tests/autorole.refresh.service.test.ts`.
- Hypothesis still requiring evidence: `tests/autorole.apply.service.test.ts`.
- Hypothesis still requiring evidence: `tests/autoroleEvaluation.service.test.ts`.

## 16. Regression Test Matrix
- Reproduced locally: the existing `accounts` tests already cover clanless `PlayerCurrent` rendering and the `PlayerActivity` fallback cases.
- Reproduced locally: the existing autorole refresh and apply tests already cover stale CLAN removal, delayed stale removal, and the disabled-removal path.
- Reproduced locally: the existing autorole evaluation tests already cover the `preferCurrentClanTagForClanRules` behavior.
- Hypothesis still requiring evidence: add a regression test that simulates a tracked-clan member disappearing from every fetched roster while persisted `PlayerCurrent` remains positive.
- Hypothesis still requiring evidence: add a regression test that keeps `PlayerActivity` stale but confirms `/accounts` no longer labels a confirmed clanless `PlayerCurrent` as Rising Dawn.

## 17. Observability Improvements
- Hypothesis still requiring evidence: log when a tracked-clan candidate disappears from all live rosters but still has positive persisted `PlayerCurrent`.
- Hypothesis still requiring evidence: include the evaluated live-clan source and the persisted-clan source in autorole summaries so stale-positive decisions are obvious in one line.
- Hypothesis still requiring evidence: emit a per-member “negative reconciliation skipped” counter for guild refresh so missing-roster cases are measurable.

## 18. Confidence
- Confirmed from code: `/accounts` stale rendering through `PlayerActivity` fallback, confidence `99%`.
- Confirmed from production data/logs: stale persisted `PlayerCurrent` is the direct reason the affected member keeps the Rising Dawn role, confidence `92%`.
- Confirmed from production data/logs: the affected member is not being held by `AutoRolePendingRemoval` delay, confidence `99%`.
- Hypothesis still requiring evidence: the exact missing user-scoped refresh history for this member, confidence `55%`.
- Confirmed from code and local tests: the current code paths and existing test suite already match the behavior described above, confidence `98%`.
