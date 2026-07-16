# Sync Checklist Premature Skips

## Summary

The July 15, 2026 incident now has two separate facts that must stay separate:

1. The initial public Bases checklist was published after the readiness gate had already expired.
2. The later refreshed Bases content became correct, but the Discord badge reaction set stayed at three reactions.

That is the confirmed defect boundary: content/state refresh succeeded, but reaction reconciliation did not.

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

## Refresh Flow

`handleFwaMatchChecklistRefreshButton` rebuilds the current checklist state and then calls `refreshFwaMatchChecklistMessage`.

That refresh path:

- edits the message content in place
- updates the tracked metadata snapshot
- does not run the publication/finalization reaction helper again
- does not idempotently reconcile the full Discord badge set to match the refreshed rows

`addFwaMatchChecklistReactions` is used during publication/finalization, not as the general refresh reconciliation mechanism.

## Production Result

The user-confirmed production observation is now clear:

- the checklist content eventually updated to the correct matches
- Discord still showed only three clan badge reactions after the content was correct

That is direct confirmation of a real production defect:

- `content/state refresh succeeds while reaction set remains stale`

## What This Is Not

This is not yet a proven latency root cause.

The slower time-to-correct content is a separate investigation:

- Reaction bug root cause: proven.
- Match-detection latency root cause: not yet proven.
- Do not attribute the latency to PR #1682 without timing evidence.

## Follow-Up Fixes

The right follow-up fixes are separate:

A. Add idempotent reaction reconciliation whenever a public checklist is refreshed.

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

This document intentionally stops at diagnosis and does not implement the fix.