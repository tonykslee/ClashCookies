# Autorole stale clan role diagnosis

## Executive summary

This document is the replacement baseline for the autorole stale-clan-role diagnosis work that was split across earlier PRs.

Three separate behaviors are involved:

- `/accounts` is a read-path issue caused by stale persisted player state and stale activity fallback.
- Targeted user refresh is a live-refresh / delay-flow issue whose historical production execution cannot be proven from retained logs.
- Tracked-clan role refresh is a candidate-discovery issue for cache-absent current holders.
- Guild-wide and scheduled refresh preserve a stale positive tracked-clan role because they merge live positive evidence over persisted player state and do not treat roster absence as authoritative negative evidence for a specific clan.

Confidence:

- `/accounts` stale read-path diagnosis: ~97%
- guild-wide stale-positive preservation: ~92%
- tracked-clan role candidate omission: ~96%
- historical targeted-user execution: unresolved / low confidence

## `/accounts`

`PlayerCurrent` is the persisted player-current source consumed by autorole.

`/accounts` also falls back to `PlayerActivity`.

That fallback matters because stale `PlayerActivity` can still show an old clan even after `PlayerCurrent` has been corrected.

This is an independent read-path defect. It explains why `/accounts` can still render Rising Dawn after the persisted current-player row is repaired, but it is not the same thing as the autorole refresh bug.

Important architecture note:

- the architecture contract does not explicitly document `PlayerCurrent` ownership
- treat `PlayerCurrent` as the current persisted player source consumed by autorole, not as a globally authoritative owner
- the missing ownership documentation is architectural debt, not a schema-redesign prompt

## Targeted user refresh

Historical execution for the affected user cannot be proven because retained logs are unavailable.

What is confirmed:

- a successful targeted-user refresh live-fetches linked players
- it updates `PlayerCurrent`
- with `clanRoleRemovalDelayMinutes = 1440`, the first refresh creates pending removal and retains the role during the delay
- a later refresh after the delay removes the role

This confirms the intended user-scope behavior without claiming that the historical production command successfully ran.

## Tracked-clan role refresh

Tracked-clan role refresh does not rely on stale persisted `PlayerCurrent` for departed players.

Current role-holder discovery currently begins from `guild.members.cache`.

That means a role holder who is absent from the initial cache and absent from the current live roster is never discovered.

The confirmed temporary reproduction showed:

- the user was absent from `currentHolderIds`
- the user was absent from candidate ids
- `guild.members.fetch(userId)` was never called
- the user was never evaluated
- no pending-removal row was created
- the role was neither removed nor queued

This is a candidate-discovery defect in role-scoped refresh.

## Guild-wide and scheduled refresh

Guild refresh loads persisted `PlayerCurrent`.

It merges positive live tracked-clan roster observations over that persisted state.

It does not use live roster absence as authoritative negative evidence for a specific tracked clan.

A stale positive `PlayerCurrent.currentClanTag` can therefore survive.

That is why the latest guild-wide or scheduled refresh preserved the affected Rising Dawn role.

## Architecture and ownership

The architecture contract does not explicitly document `PlayerCurrent` ownership.

The current working assumption is:

- `PlayerCurrent` is the persisted player source autorole consumes
- it is not a globally authoritative owner

That gap should be treated as architectural debt only.

## Safety boundary

The eventual implementation must:

- distinguish role-scoped candidate discovery from guild-scope membership evaluation
- use successful complete live clan rosters as evaluation-only negative evidence
- never persist `currentClanTag = null` merely because a player is absent from one clan roster
- retain existing stale-removal delays
- retain the `removeStaleManagedRoles` opt-in gate
- abort before role writes when required clan or guild-member data is incomplete
- leave `PlayerCurrentService` and `AutoRoleApplyService` unchanged unless tests prove otherwise

## Reproduced outcomes

Temporary exact tests confirmed the intended behavior for the two important scopes:

- user-scope refresh updated `PlayerCurrent`, created pending removal at the configured delay, kept the role during the delay, and removed it after the delay elapsed
- role-scope refresh reproduced the cache-absent tracked-clan holder omission exactly as described above

These results document the diagnosis baseline without claiming the historical production command itself was rerun.
