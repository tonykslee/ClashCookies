# Autorole Stale Clan Role Diagnosis

## 1. Executive Summary
- Confirmed from production data/logs: Discord user `...3710` still has the Rising Dawn tracked-clan role, while every linked Clash account is now outside Rising Dawn.
- Confirmed from production data/logs: one linked player `#YQ...G20P` is live in `Phoenix Reborn`, but the persisted `PlayerCurrent` row still says Rising Dawn and the persisted `PlayerActivity` row also still says Rising Dawn.
- Confirmed from code: `/accounts` treats clan membership as known if either `PlayerCurrent.currentClanTag` or `PlayerActivity.clanTag` exists, so stale `PlayerActivity` can keep `/accounts` wrong even if `PlayerCurrent` is repaired later.
- Confirmed from code and production data/logs: stale-role removal is enabled, and there is no pending-removal row for the affected user and Rising Dawn role.
- Hypothesis still requiring evidence: the targeted `/autorole refresh user:<member>` command is not present in the retained logs I could search, so I cannot claim that path actually ran for this user.
- Hypothesis still requiring evidence: the tracked-clan role refresh may have omitted the affected holder from its candidate set, but the retained logs do not prove that omission for the affected user.

## 2. Architecture/Data-Flow Map
- Confirmed from code: live CoC player data enters `PlayerCurrentService.applyLivePlayer`, which clears `currentClanTag` and `currentClanName` when the live response has no clan.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` preserves the previous `role` value if the live payload omits role, which is a separate stale-field risk but not the clan-membership issue here.
- Confirmed from code: `/accounts` is a read path over the current persisted player state plus `PlayerActivity` fallback, not a live membership oracle.
- Confirmed from code: member-scoped autorole refresh re-fetches linked players through `refreshCurrentPlayersFromLiveTags`, rereads successful `PlayerCurrent` rows, and evaluates with `preferCurrentClanTagForClanRules: true`.
- Confirmed from code: tracked-clan role refresh does not load stale persisted `PlayerCurrent` for departed players. It builds current role-holder candidates from cached Discord members, current-member candidates from successful live clan roster members, a roster-backed membership index, and roster-backed `PlayerCurrent`-like observations for those current clan members.
- Confirmed from code: a stale holder absent from the cached guild member set and absent from the live-roster-linked set can be omitted from role-refresh candidates entirely.
- Confirmed from code: guild-wide refresh merges positive tracked-clan overlay data onto persisted player-current rows, which can preserve a stale positive unless a later live refresh overwrites it.
- Confirmed from code: `AutoRoleApplyService` only removes stale managed roles when `removeStaleManagedRoles` is enabled, and CLAN roles may still wait behind `clanRoleRemovalDelayMinutes`.

## 3. Production And Runtime Evidence
- Confirmed from production data/logs: the affected member currently has the Rising Dawn Discord role.
- Confirmed from production data/logs: the affected member has no `AutoRolePendingRemoval` row for the Rising Dawn role.
- Confirmed from production data/logs: `AutoRoleMemberState` for the affected member shows a recent guild refresh evaluation, but the last applied timestamp did not move with it.
- Confirmed from production data/logs: `PlayerCurrent` for the representative stale linked player still says Rising Dawn, while live CoC and `TodoPlayerSnapshot` now say `Phoenix Reborn`.
- Confirmed from production data/logs: `PlayerActivity` for that same linked player also still says Rising Dawn, so `/accounts` has two stale sources to trip over for this member.
- Confirmed from production data/logs: I searched retained logs since `2026-07-01` for command lifecycle lines and the requested autorole events, including `/autorole`, `event=autorole_run_start`, `event=user_live_reconcile_summary`, `event=refresh_start`, `event=evaluate`, `event=autorole_run_complete`, `event=autorole_run_failed`, and `[player-current] event=live_refresh_summary`, plus `run_scope=USER`, the affected user id, the affected player tag, the relevant role run id, and the linked player tag. Those searches returned no retained lines.
- Confirmed from production data/logs: I did find retained guild-refresh logs for `2026-07-15 09:14 UTC`, including `candidate_members=1524`, `linked_users=768`, and `autorole_run_complete`.
- Hypothesis still requiring evidence: the absence of retained user-scoped and role-scoped log lines is a retention boundary, not proof that those commands never ran.

## 4. Exact Reproduction
- Reproduced locally: the existing `accounts` tests cover the clanless `PlayerCurrent` case, the `PlayerActivity` fallback case, and the tracked-clan fallback-name case.
- Reproduced locally: the existing user-refresh tests cover stale CLAN removal when live current-clan data moves and the delayed stale-removal path when `removeStaleManagedRoles = true`.
- Reproduced locally: the existing tracked-clan role-refresh tests cover the case where a stale holder is present in the guild member cache and absent from the live roster, and that case is removed or queued according to policy.
- Hypothesis still requiring evidence: I did not complete a faithful local reproduction of the cache-absent tracked-clan holder omission in this pass.

## 5. Scope Conclusions
- `/accounts`: Confirmed from code and production data/logs that stale `PlayerCurrent` plus stale `PlayerActivity` explains the incorrect Rising Dawn rendering for the affected member.
- Targeted user refresh: Hypothesis still requiring evidence that the command executed for the affected member at all. If it does execute successfully, code and tests indicate it refreshes `PlayerCurrent` from live data and then enters the normal stale-removal delay path, which would create pending removal first and remove later after the delay.
- Tracked-clan role refresh: Confirmed from code that it should not trust stale persisted `PlayerCurrent` directly. For a stale holder in the candidate set, live-roster absence should make the role undesired and it should then be removed or queued according to policy. Hypothesis still requiring evidence: the affected holder may have been omitted from the candidate set because current-holder discovery starts from cached guild members only.
- Guild-wide refresh: Confirmed from code and production data/logs that the guild-scope path is positive-overlay based, so a stale positive persisted `PlayerCurrent` can survive and keep the role desired unless a later live refresh overwrites the row.
- Scheduled guild refresh: Confirmed from production data/logs that the latest scheduled guild refresh completed with 1271 evaluated members and 0 removals, so it preserved the stale positive state rather than clearing it.

## 6. Confirmed Root Causes
- Confirmed from production data/logs: the affected user keeps the Rising Dawn role because at least one linked player still has stale persisted `PlayerCurrent` pointing at Rising Dawn even though live data has moved on.
- Confirmed from code: `/accounts` is wrong for the same member because it falls back to stale `PlayerActivity` when `PlayerCurrent` is clanless or incomplete.
- Confirmed from code and production data/logs: guild-wide refresh keeps the role because it uses positive tracked-clan overlay and does not perform negative reconciliation against live player membership for every linked account.
- Hypothesis still requiring evidence: the tracked-clan role-refresh miss may be a candidate omission caused by cache-only current-holder discovery, but I do not yet have retained runtime evidence that this happened for the affected member.
- Hypothesis still requiring evidence: the targeted-user refresh failure mode is still unknown because I could not find retained logs for that scope and user.

## 7. Contributing Conditions
- Confirmed from code: `PlayerActivity.clanTag` is non-nullable, so it cannot directly represent a clanless state.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` already knows how to clear a clanless live response, so the stale clan value is not coming from that mapper refusing to null it.
- Confirmed from production data/logs: the stale linked player's `PlayerCurrent.lastFetchedAt` is far older than the live mismatch observed on `2026-07-15`, which means the row is simply stale.
- Confirmed from repo docs: the architecture contract does not explicitly document `PlayerCurrent` ownership; I am treating it as the current persisted source consumed by autorole, not as a globally authoritative owner. That gap is architectural debt.
- Confirmed from code: the relevant scope-specific candidate lists are built from live or cached observations, not from a global negative membership source.

## 8. Causes Ruled Out
- Confirmed from production data/logs: `removeStaleManagedRoles = true`, so stale role retention is not caused by the global stale-removal switch being disabled.
- Confirmed from production data/logs: `clanRoleRemovalDelayMinutes = 1440`, but there is no pending-removal row for the affected user and Rising Dawn role, so the 24-hour delay is not the current blocker.
- Confirmed from production data/logs: there are no user or role exclusions for the affected member or the Rising Dawn role.
- Confirmed from code: `PlayerActivity` is not the autorole membership source, so it is not what keeps the Discord role on its own.
- Hypothesis still requiring evidence: Discord permission or hierarchy failure is not proven, because no removal attempt for the affected member is present in the retained logs I could search.

## 9. Recommended Fix Boundary
- Hypothesis still requiring evidence: do not clear `PlayerCurrent.currentClanTag` just because a player is absent from one tracked-clan roster. Absence from one clan proves non-membership in that clan, not membership in a different clan.
- Hypothesis still requiring evidence: separate evaluation-only negative evidence for a specific tracked-clan role from authoritative live-player persistence, which should still come from live CoC data.
- Hypothesis still requiring evidence: fix `/accounts` by correcting read-path precedence between confirmed `PlayerCurrent` and stale `PlayerActivity`, not by inventing a new membership source.
- Hypothesis still requiring evidence: if the role-candidate omission remains confirmed, the fix belongs in `AutoRoleRefreshService.ts` candidate selection, not in `PlayerCurrentService.ts` or `AutoRoleApplyService.ts`.

## 10. Likely File Scope
- Hypothesis still requiring evidence: `src/services/AccountRowsService.ts`.
- Hypothesis still requiring evidence: `src/services/AutoRoleRefreshService.ts`.
- Hypothesis still requiring evidence: `tests/accounts.command.test.ts`.
- Hypothesis still requiring evidence: `tests/autorole.refresh.service.test.ts`.
- Hypothesis still requiring evidence: `tests/autoroleEvaluation.service.test.ts`.
- Hypothesis still requiring evidence: `PlayerCurrentService.ts` should stay out of the change list unless new evidence shows its live-clan clearing behavior is broken.
- Hypothesis still requiring evidence: `AutoRoleApplyService.ts` should stay out of the change list unless new evidence shows the stale-removal gate itself is wrong.

## 11. Regression Test Matrix
- Reproduced locally: existing tests already cover clanless `PlayerCurrent` rendering, `PlayerActivity` fallback rendering, delayed stale removal, and stale-role preservation when removal is disabled.
- Reproduced locally: existing tracked-clan role-refresh tests already cover stale-holder removal when the holder is present in the guild cache.
- Hypothesis still requiring evidence: add a test for tracked-clan role refresh when the stale holder is absent from `guild.members.cache` and absent from the live-roster-linked set.
- Hypothesis still requiring evidence: add a test that keeps `PlayerActivity` stale while confirming `/accounts` still renders the repaired `PlayerCurrent` state correctly.

## 12. Confidence
- Confirmed from code and production data/logs: `/accounts` is stale because of the `PlayerCurrent` plus `PlayerActivity` combination, confidence `97%`.
- Confirmed from code and production data/logs: guild-wide refresh preserves the stale positive state, confidence `88%`.
- Hypothesis still requiring evidence: tracked-clan role refresh missed the affected holder via candidate omission, confidence `55%`.
- Hypothesis still requiring evidence: targeted user refresh was executed and failed in some way that is no longer retained, confidence `35%`.
- Confirmed from code and local tests: the code paths and existing test suite match the general behavior described above, confidence `95%`.
