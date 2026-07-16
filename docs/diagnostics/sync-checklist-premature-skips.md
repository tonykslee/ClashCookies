# Sync Checklist Premature Skips

## Summary

The July 15, 2026 incident now has four separate facts that must stay separate:

1. The initial public Bases checklist had six skipped rows and three reaction-eligible rows.
2. The current refresh path already has a narrow skipped->eligible reaction recovery branch when it receives newly resolved rows through `options.rows`.
3. A reaction-driven refresh can still persist the resolved Bases rows without surfacing that transition to the recovery branch.
4. The later terminal state can therefore show the correct content while Discord still displays only the original three badge reactions.

That is the confirmed boundary: the refresh path can update content and metadata without reconciling the complete bot reaction set.

## Initial Publication

For the initial publication, the same row array was used for all of the following:

- visible content
- persisted initial tracked-message metadata
- skipped vs reaction-eligible counts
- the initial badge reactions added at publication/finalization

The user-captured initial Bases post was:

```text
RD | ?? | Skipped this sync ??
ZG | ?? | Skipped this sync ??
DE | ?? | Skipped this sync ??
SE | ?? | ? Bases not checked
TWC | ?? | Skipped this sync ??
RR | ?? | ? Bases not checked
AK | ?? | ? Bases not checked
SH | ?? | Skipped this sync ??
EB | ?? | Skipped this sync ??
```

Exactly three clans were reaction-eligible in that initial state:

- SE `#82YLR9Q2`
- RR `#2RYGLU2UY`
- AK `#2RVV0L0VP`

## Current Narrow Recovery

`TrackedMessageService.refreshFwaMatchChecklistMessage` already performs a narrow skipped->eligible transition recovery when `options.rows` contains newly resolved rows.

That branch:

- compares the incoming rows against the previous tracked metadata
- detects rows that moved from `basesStatus="skipped"` to a reaction-eligible state
- arms those newly eligible badge reactions with `message.react(...)`

`handleFwaMatchChecklistRefreshButton` passes the current checklist rows through `options.rows`, so the button path can still use that narrow recovery when metadata has not already advanced past the skipped state.

## Reaction-Driven Path

The Discord reaction listeners call the same refresh service with a reaction change and no `options.rows`.

In that path:

- `sourceRows` come from the old tracked metadata snapshot
- skipped->eligible transitions are not visible to the narrow recovery branch
- the service still rebuilds the current Bases state
- it edits the Discord content in place
- it persists the refreshed tracked metadata

That is the ordering gap: a listener-driven refresh can consume the old skipped snapshot before a later button refresh has a chance to recover the missing reaction set.

## Later Retained State

The current retained tracked-message rows are mutable state after one or more refreshes. They are not guaranteed to be the initial publication snapshot.

The later retained Bases state for the same incident is:

```text
RD | ?? | ? Bases checked and all good
ZG | ?? | ? Bases not checked
DE | ?? | ? Bases not checked
SE | ?? | ? Bases not checked
TWC | ?? | ? Bases not checked
RR | ?? | ? Bases not checked
AK | ?? | ? Bases not checked
SH | ?? | ? Bases checked and all good
EB | ?? | ? Bases checked and all good
```

That later state shows the content converging to the correct matches, but it does not imply the reaction set was reconciled.

## Production Result

The user-confirmed production observation is now clear:

- the checklist content eventually updated to the correct matches
- Discord still showed only three clan badge reactions after the content was correct

That is direct confirmation of a real production defect:

- `content/state refresh succeeds while reaction set remains stale`

Retained logs support the listener-driven refresh sequence, but they do not prove the exact user-action ordering end to end. The logs show the relevant reaction and refresh markers on the affected checklist message, but they do not include a distinct button-specific marker that would distinguish a later refresh click from a reaction-triggered refresh with certainty.

## What This Is Not

This is not yet a proven latency root cause.

The slower time-to-correct content is a separate investigation:

- Reaction bug root cause: proven.
- Match-detection latency root cause: not yet proven.
- Do not attribute the latency to PR #1682 without timing evidence.

## Follow-Up Fixes

The right follow-up fixes are separate:

A. Add idempotent reaction reconciliation whenever a public checklist is refreshed, and reconcile from the final effective rows rather than only from a remembered transition.

B. Investigate why current-war identities now converge more slowly.

Recommended reconciliation behavior for A:

- add any newly eligible bot badge reactions
- do not remove legitimate user reactions
- do not duplicate existing reactions
- handle missing or invalid configured emojis per clan without failing the entire refresh
- keep the content refresh successful even if one reaction fails
- emit bounded structured telemetry for expected, existing, added, failed, and ineligible reaction counts

## Notes On Timing

The publication still happened after the readiness gate expired, so the timing regression remains part of the timeline. But the confirmed, separate production defect is the stale reaction set after content refresh.

The retained logs are useful for reconstructing the listener-triggered refresh sequence, but they are not sufficient to prove the exact sequence of user actions around the button refresh.

This document intentionally stops at diagnosis and does not implement the fix.
