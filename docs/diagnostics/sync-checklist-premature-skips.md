# Sync Checklist Premature Skips

## Summary

On July 15, 2026, the FWA sync root for guild `1324040917602013261` was tracked by sync message `1526856991119769693` with `syncEpochSeconds=1784149200`, which is `2026-07-15T21:00:00.000Z` or `2:00 PM America/Los_Angeles`.

The Mail checklist published at `2026-07-15T21:01:45.959Z` and the Bases checklist published at `2026-07-15T21:17:46.176Z`. The Bases publish happened exactly at the fixed readiness gate expiry (`sync + 2 minutes + 15 minutes`).

This incident is not one bug. It is two overlapping behaviors:

1. The checklist scheduler correctly held Bases until the readiness window expired and then published with the rows it had.
2. The current-war ownership layer was stale for some clans during the window, so several clans rendered as unresolved or skipped rather than as exact active identities.

The Mail checklist checked state for RR and SH was current, not stale. The current message was updated by reaction events on the published Mail message, not inherited from a prior sync.

## Production Timeline

| Time (UTC) | Time (America/Los_Angeles) | Event |
| --- | --- | --- |
| `2026-07-15T20:55:43.572Z` | `1:55:43 PM` | Sync tracked row created for message `1526856991119769693` |
| `2026-07-15T21:01:45.959Z` | `2:01:45 PM` | Mail checklist claim created and Mail checklist posted as message `1527057612753867014` |
| `2026-07-15T21:02:00.000Z` | `2:02:00 PM` | Bases checklist due time (`sync + 2 minutes`) |
| `2026-07-15T21:17:00.000Z` | `2:17:00 PM` | Bases readiness gate expired (`due + 15 minutes`) |
| `2026-07-15T21:17:46.176Z` | `2:17:46 PM` | Bases checklist claim created and Bases checklist posted as message `1527061640368099328` |

## Production Evidence

### Sync root

The active sync root row is:

- `messageId`: `1526856991119769693`
- `createdAt`: `2026-07-15T07:44:34.603Z`
- `expiresAt`: `2026-07-15T22:00:00.000Z`
- `syncEpochSeconds`: `1784149200`
- configured clans: RD, ZG, DE, SE, TWC, RR, AK, SH, EB

### Publication claims

The scheduler wrote one publication claim per checklist kind:

| Kind | Claim created | Claim key |
| --- | --- | --- |
| Mail | `2026-07-15T21:01:45.959Z` | `fwa_match_checklist_publication|guild=1324040917602013261|sync=1526856991119769693|feature=FWA_MATCH_CHECKLIST|kind=mail_checklist` |
| Bases | `2026-07-15T21:17:46.176Z` | `fwa_match_checklist_publication|guild=1324040917602013261|sync=1526856991119769693|feature=FWA_MATCH_CHECKLIST|kind=bases_checklist` |

### Scheduler logs

The scheduler logs prove the exact timing and the gate math:

- `checklist_scheduled_due` for Mail at `2026-07-15T21:01:00.000Z`
- `checklist_scheduled_due` for Bases at `2026-07-15T21:02:00.000Z`
- `skipped_ready_gate` for Bases with `rowCount=9`, `skippedCount=6`, `expectedReactionCount=3`, `trackedClanCount=9`, `gateExpiresAt=2026-07-15T21:17:00.000Z`
- `ready_gate_expired` for Bases with the same counts
- `posted` for Mail message `1527057612753867014`
- `posted` for Bases message `1527061640368099328`

## Per-Clan Classification

Legend:

- A = intentionally skipped or unclaimed, correctly rendered skipped
- B = participated in the sync but was still searching or unmatched when the readiness gate expired
- C = live CoC had already moved on, but `CurrentWar` failed to roll forward or remained stale
- D = live CoC was unavailable or errored
- E = another proven condition

| Clan | Tag | Mail at 2:01 | Bases at 2:17 | Latest refresh after 2:17 | Classification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| RD | `#2YUYLJCGV` | `vs -` | `Skipped this sync` | current war still unresolved at the gate; later refresh showed a preparation row for the next cycle | B | Participated, but no exact active identity at gate expiry |
| ZG | `#LQQ99UV8` | `vs -` | `Skipped this sync` | later refresh showed a preparation row with `DARK EMPIRE™!` | B | Same shape as RD |
| DE | `#R80L8VYG` | `vs -` | `Skipped this sync` | later refresh showed a preparation row with `ZERO GRAVITY` | B | Same shape as RD |
| SE | `#82YLR9Q2` | active identity rendered | active row selected for reaction | latest refresh kept an active matched war with `Téam Pokémon` | E | Active matched war; three Bases reactions included it |
| TWC | `#29PCQGUV0` | `vs -` | `Skipped this sync` | later refresh showed a preparation row with `Tribal Chaos` | B | Still unmatched at gate expiry |
| RR | `#2RYGLU2UY` | active identity rendered | active row selected for reaction | `CurrentWar` remained partially stale: `warId`/`syncNumber` were missing and sync assignment hit `persist_current_war source=conflict result=missing_row` | C | The exact first failed stage we captured is `sync-assignment` / `persist_current_war` |
| AK | `#2RVV0L0VP` | active identity rendered | active row selected for reaction | latest refresh kept an active matched war with `REQ N LEAVE` | E | Active matched war; three Bases reactions included it |
| SH | `#C0CU2Q82` | `vs -` | `Skipped this sync` | current mail reaction state was later updated on the live message, but gate-time row was still unresolved | B | RR and SH checked states were current reactions, not stale carry-over |
| EB | `#2QVGPQP0U` | `vs -` | `Skipped this sync` | later refresh showed a preparation row with `outlander club` | B | Still unmatched at gate expiry |

## RR and SH Checked State

The Mail checklist message `1527057612753867014` now has `checkedClanTags` that include RR and SH, and the app logged current reaction events on that same message:

- `fwa_checklist_reaction_received ... messageId=1527057612753867014 ... emojiName=Logo_RockyRoad reactionCount=2`
- `fwa_checklist_reaction_matched ... clanTag=#2RYGLU2UY matched=true`
- `fwa_checklist_reaction_received ... messageId=1527057612753867014 ... emojiName=Logo_StrawHats reactionCount=2`
- `fwa_checklist_reaction_matched ... clanTag=#C0CU2Q82 matched=true`

That is current-state evidence, not a stale-sync leak.

## Why Only Three Bases Reactions Appeared

The scheduler computed:

- `trackedClanCount=9`
- `skippedCount=6`
- `expectedReactionCount=3`

The Bases renderer skips badge reactions for rows whose authoritative `CurrentWar` state is `notInWar`. That leaves the three active rows selected for reactions, which matches the production observation.

## Why Refreshing Did Not Repair the Post

The checklist post was created from the persisted current-war snapshot that existed when the scheduler ran. Later refreshes updated the tracked rows and reaction state, but they did not change the fact that the original Bases publication was emitted after the readiness gate expired with six unresolved rows.

Mail also protects against identity drift by requiring an exact active identity. When `CurrentWar` and live CoC do not agree on a real active identity, Mail intentionally renders `vs -` instead of inventing an opponent.

## First Incorrect Architectural Layer

For RR, the first incorrect layer was `sync-assignment` inside `ActiveWarSyncResolutionService`, specifically `persist_current_war` failing with `result=missing_row`. There were no later `current_war_rollover` or `current_war_finalization` CAS logs for that clan in the captured window.

For the six unresolved clans, the checklist layer itself behaved as designed: it treated `notInWar` as skipped and withheld reactions. The unresolved rows were the result of stale or unavailable current-war evidence at the gate, not of the reaction code inventing state.

## Root Cause Confidence

High confidence:

- the gate timing is proven by logs and tracked rows
- the publication claims are present and match the two checklist kinds
- the three reaction count is explained by the persisted row counts
- RR and SH checked state is current, not leaked
- RR has a distinct sync-assignment persistence failure

Moderate confidence:

- the six unresolved clans were still unmatched at gate expiry rather than intentionally skipped

Low confidence:

- any claim that the later refresh state is the same as the 2:01 or 2:17 snapshot without a captured Discord message snapshot from that exact moment

## Recommended Fix Boundary

The smallest safe fix boundary is:

- keep Mail exact-identity suppression intact
- keep Bases from inventing fallback opponents
- distinguish `intentionally skipped`, `participating but unresolved`, `active matched war`, and `temporarily unavailable/stale data`
- only map `notInWar` to `Skipped this sync` when `CurrentWar` is authoritative and stable for that clan at the render moment

This document intentionally stops at diagnosis and does not implement the behavior change.
