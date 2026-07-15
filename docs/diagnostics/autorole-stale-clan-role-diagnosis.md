# Autorole Stale Clan Role Diagnosis

## 1. Executive Summary
- Confirmed from production data/logs: Discord user `...3710` still has the Rising Dawn tracked-clan role, while every linked Clash account is now outside Rising Dawn.
- Confirmed from production data/logs: one linked player `#YQ...G20P` is live in `Phoenix Reborn`, but the persisted `PlayerCurrent` row still says Rising Dawn and the persisted `PlayerActivity` row also still says Rising Dawn.
- Confirmed from code: `/accounts` treats clan membership as known if either `PlayerCurrent.currentClanTag` or `PlayerActivity.clanTag` exists, so stale `PlayerActivity` can keep `/accounts` wrong even if `PlayerCurrent` is repaired later.
- Confirmed from code and production data/logs: stale-role removal is enabled, and there is no pending-removal row for the affected user and Rising Dawn role.
- Hypothesis still requiring evidence: the targeted `/autorole refresh user:<member>` command is not present in the retained logs I could search, so I cannot claim that path actually ran for this user.
- Confirmed from local reproduction: a cache-absent tracked-clan role holder is omitted from `currentHolderIds` and from the candidate set, is never fetched or evaluated, and does not create pending removal.

## 2. Architecture/Data-Flow Map
- Confirmed from code: live CoC player data enters `PlayerCurrentService.applyLivePlayer`, which clears `currentClanTag` and `currentClanName` when the live response has no clan.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` preserves the previous `role` value if the live payload omits role, which is a separate stale-field risk but not the clan-membership issue here.
- Confirmed from code: `/accounts` is a read path over the current persisted player state plus `PlayerActivity` fallback, not a live membership oracle.
- Confirmed from code: member-scoped autorole refresh re-fetches linked players through `refreshCurrentPlayersFromLiveTags`, rereads successful `PlayerCurrent` rows, and evaluates with `preferCurrentClanTagForClanRules: true`.
- Confirmed from code: tracked-clan role refresh does not load stale persisted `PlayerCurrent` for departed players. It builds current role-holder candidates from cached Discord members, current-member candidates from successful live clan roster members, a roster-backed membership index, and roster-backed `PlayerCurrent`-like observations for those current clan members.
- Confirmed from code and local reproduction: a stale holder absent from the cached guild member set and absent from the live-roster-linked set is omitted from role-refresh candidates entirely.
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
- Reproduced locally: a temporary exact user-refresh regression test confirmed the full stale-removal delay flow when `removeStaleManagedRoles = true` and `clanRoleRemovalDelayMinutes = 1440`: stale `PlayerCurrent` still said Rising Dawn, the live response moved the linked account to another clan, `PlayerCurrent` was updated, the first refresh created pending removal, the role stayed during the delay, and the refresh after the elapsed delay removed the role.
- Reproduced locally: a temporary exact tracked-clan role-refresh regression test confirmed the cache-absent holder case. The affected user was absent from `guild.members.cache`, absent from `currentHolderIds`, absent from candidate ids, never fetched by `guild.members.fetch(userId)`, never evaluated, created no pending-removal row, and the role was neither removed nor queued for that user.

## 5. Scope Conclusions
- `/accounts`: Confirmed from code and production data/logs that stale `PlayerCurrent` plus stale `PlayerActivity` explains the incorrect Rising Dawn rendering for the affected member.
- Targeted user refresh: the historical command execution remains unknown because retained logs are unavailable. The temporary exact user-scope repro confirms the intended behavior when that path does run: refresh the player from live data, create pending removal at the configured delay, preserve the role during the delay, and remove it after the delay expires.
- Tracked-clan role refresh: confirmed from code and local reproduction that role-scoped outcome is governed by candidate discovery plus live roster evidence. A cache-absent current holder can be omitted before evaluation begins, so the role is neither removed nor queued for that user.
- Guild-wide refresh: confirmed from code and production data/logs that the guild-scope path is positive-overlay based, so stale `PlayerCurrent` definitively explains why the latest guild-wide/scheduled refresh preserved the Rising Dawn role.
- Scheduled guild refresh: Confirmed from production data/logs that the latest scheduled guild refresh completed with 1271 evaluated members and 0 removals, so it preserved the stale positive state rather than clearing it.

## 6. Confirmed Root Causes
- Confirmed from production data/logs: the affected user keeps the Rising Dawn role because at least one linked player still has stale persisted `PlayerCurrent` pointing at Rising Dawn even though live data has moved on.
- Confirmed from code: `/accounts` is wrong for the same member because it falls back to stale `PlayerActivity` when `PlayerCurrent` is clanless or incomplete.
- Confirmed from code and production data/logs: stale `PlayerCurrent` definitively explains why the latest guild-wide/scheduled refresh preserved the Rising Dawn role, because that path is positive-overlay based and does not perform negative reconciliation against live player membership for every linked account.
- Confirmed from code and local reproduction: the tracked-clan role-refresh miss is a candidate omission caused by cache-only current-holder discovery. A cache-absent holder is omitted before live evaluation, so the role-scoped outcome is separate from stale `PlayerCurrent` in guild refresh.
- Hypothesis still requiring evidence: the targeted-user refresh failure mode is still unknown because I could not find retained logs for that scope and user.

## 7. Contributing Conditions
- Confirmed from code: `PlayerActivity.clanTag` is non-nullable, so it cannot directly represent a clanless state.
- Confirmed from code: `PlayerCurrentService.applyLivePlayer` already knows how to clear a clanless live response, so the stale clan value is not coming from that mapper refusing to null it.
- Confirmed from production data/logs: the stale linked player's `PlayerCurrent.lastFetchedAt` is far older than the live mismatch observed on `2026-07-15`, which means the row is simply stale.
- Confirmed from repo docs: the architecture contract does not explicitly document `PlayerCurrent` ownership; I am treating it as the current persisted source consumed by autorole, not as a globally authoritative owner. That gap is architectural debt.
- Confirmed from code: the relevant scope-specific candidate lists are built from live or cached observations, not from a global negative membership source.

## 8. Causes Ruled Out
- Confirmed from production data/logs: `removeStaleManagedRoles = true`, so stale role retention is not caused by the global stale-removal switch being disabled.
- Confirmed from production data/logs: `clanRoleRemovalDelayMinutes = 1440`, and the temporary user-scope repro shows that delay works as intended; for the affected user, there is still no pending-removal row, so the blocker is earlier than the delay gate.
- Confirmed from production data/logs: there are no user or role exclusions for the affected member or the Rising Dawn role.
- Confirmed from code: `PlayerActivity` is not the autorole membership source, so it is not what keeps the Discord role on its own.
- Hypothesis still requiring evidence: Discord permission or hierarchy failure is not proven, because no removal attempt for the affected member is present in the retained logs I could search.

## 9. Recommended Fix Boundary
- Hypothesis still requiring evidence: do not clear `PlayerCurrent.currentClanTag` just because a player is absent from one tracked-clan roster. Absence from one clan proves non-membership in that clan, not membership in a different clan.
- Hypothesis still requiring evidence: separate evaluation-only negative evidence for a specific tracked-clan role from authoritative live-player persistence, which should still come from live CoC data.
- Hypothesis still requiring evidence: fix `/accounts` by correcting read-path precedence between confirmed `PlayerCurrent` and stale `PlayerActivity`, not by inventing a new membership source.
- Confirmed from local reproduction: if the role-candidate omission is the bug, the fix belongs in `AutoRoleRefreshService.ts` candidate selection, not in `PlayerCurrentService.ts` or `AutoRoleApplyService.ts`, and it needs a permanent regression test.

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
- Reproduced locally: the temporary tracked-clan regression test confirmed the cache-absent stale-holder omission case and should be promoted to a permanent regression test in the eventual fix.
- Reproduced locally: the temporary user-scope regression test confirmed the exact stale-removal delay behavior and documents the verified sequence without claiming the historical production command ran.

## 12. Confidence
- Confirmed from code and production data/logs: `/accounts` is stale because of the `PlayerCurrent` plus `PlayerActivity` combination, confidence `97%`.
- Confirmed from code and production data/logs: stale `PlayerCurrent` preserves the role through guild-wide/scheduled refreshes, confidence `92%`.
- Confirmed from code and local reproduction: tracked-clan role refresh missed the affected holder via cache-only candidate omission, confidence `96%`.
- Hypothesis still requiring evidence: targeted user refresh was executed and failed in some way that is no longer retained, confidence `35%`.
- Confirmed from code and local tests: the code paths and existing test suite match the general behavior described above, confidence `95%`.
