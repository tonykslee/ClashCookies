# Autorole stale clan role diagnosis

## Executive conclusion

The tracked-clan role refresh bug is confirmed: when the role-holder is present in the guild but absent from `guild.members.cache`, the current role-refresh path never discovers that member and therefore never evaluates them.

In the reproduced Rising Dawn case, the uncached role holder stayed outside `currentHolderIds`, stayed outside the candidate id set, `guild.members.fetch(userId)` was never called, the member was never evaluated, no pending-removal row was created, and the role was neither removed nor queued.

This is a role-refresh candidate-discovery failure, not a generic `PlayerCurrent` failure.

Confidence: 96%.

## Reproduced case

A temporary regression test in `tests/autorole.refresh.service.test.ts` modeled the cache-absent tracked-clan role-holder scenario with:

- `removeStaleManagedRoles = true`
- Rising Dawn as the tracked clan with a `clanRoleId`
- the Discord user holding that clan role in the guild
- the user's linked player absent from the successful live Rising Dawn roster
- the user absent from the initial guild cache
- the guild fetch still able to return that member if the id were requested

Observed outcome:

- `currentHolderIds` did not contain the user id
- the candidate id set did not contain the user id
- `guild.members.fetch(userId)` was never called
- the user was never evaluated
- `candidateUserCount` was `0`
- `evaluatedCount` was `0`
- `autoRolePendingRemoval.upsert` was not called
- `autoRoleMemberState.upsert` was not called
- the role was not removed

That is the exact omission we needed to confirm.

## Why this is separate from stale `PlayerCurrent`

The stale `PlayerCurrent` explanation is real, but it applies to the latest guild-wide or scheduled refresh outcome, not to the role-scoped candidate-discovery bug.

What the current evidence supports is:

- stale `PlayerCurrent` definitively explains why the latest guild-wide or scheduled refresh preserved the Rising Dawn role
- the role-scoped outcome is governed by candidate discovery plus live roster evidence
- historical targeted-user execution remains unknown because retained logs are unavailable

So the generic statement "stale `PlayerCurrent` explains the affected user keeping the role" was too broad. It needs to be narrowed to the guild-wide/scheduled refresh path only.

## User-scope confirmation

The successful user-scope behavior is already covered by the existing test suite in pieces:

- the user-refresh path shows live clan data moving the linked account out of the old clan and updating `PlayerCurrent`
- the apply-service path shows delayed stale removal keeping the role through the delay and removing it after the delay expires

A temporary exact Rising Dawn test was also run with `clanRoleRemovalDelayMinutes = 1440`.

Observed result:

- the first refresh kept the role and created a pending-removal row
- the role remained present during the 1440-minute delay
- the later refresh, after the delay elapsed, removed the role

This confirms the intended delayed-removal behavior without claiming that the historical production command itself was rerun.

## Root cause and fix boundary

The confirmed code root cause for tracked-clan role refresh is cache-absent current-holder discovery.

The eventual fix boundary should stay in `AutoRoleRefreshService` candidate discovery for tracked-clan role refresh, where current holders need to be discovered even when the initial cache is incomplete.

The fix should not:

- change `PlayerCurrent` schema
- touch `/accounts`
- fabricate clan membership
- bypass the stale-removal delay
- bypass the opt-in gate

A permanent regression test will be required in the eventual fix for the cache-absent current-holder case.

