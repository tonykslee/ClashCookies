# Sync Checklist Premature Skips

## Summary

The July 15, 2026 incident mixes three different timestamps that should not be conflated:

1. The Discord message snowflake creation time for the sync root message `1526856991119769693` is `2026-07-15T07:44:34.314Z`.
2. The database `TrackedMessage.createdAt` for that same sync-root row is `2026-07-15T07:44:34.603Z`.
3. A later, separate `SYNC_TIME_POST` tracked-message row exists at `2026-07-15T20:55:43.572Z` and is the source of the 20:55 contradiction.

The important production boundary is this:

- The scheduler recorded the Bases readiness gate expiring at `2026-07-15T21:17:00.000Z`.
- The Bases publication claim was created later, at `2026-07-15T21:17:46.176Z`.
- The published Bases tracked-message row was then created at `2026-07-15T21:17:46.618Z`.

So the right interpretation is not "the checklist was published exactly at gate expiry". It is "publication happened after the gate had already expired".

## What Is Proven

### Sync root and publication claims

The sync-root tracked row for `1526856991119769693` is the authoritative root row for this incident. Its metadata includes `syncEpochSeconds=1784149200`, which corresponds to `2026-07-15T21:00:00.000Z`.

The scheduler created two publication claims on that sync root:

- Mail: `2026-07-15T21:01:45.959Z`
- Bases: `2026-07-15T21:17:46.176Z`

### Persisted publication snapshots

The persisted publication row for Mail is distinct from the gate-time state. Its metadata contains the exact 9 published rows, and the later checked state on that message is a separate reaction-driven update.

The persisted publication row for Bases is also distinct from the gate-time state. Its metadata contains 9 exact rows, with 6 marked `not checked` and 3 marked `checked and all good`.

Those persisted Bases rows are the snapshot the message content was built from. They are not the same thing as the gate-time classification used to decide whether to apply badge reactions.

### Gate-time decision logic

`shouldApplyFwaMatchChecklistBadgeReaction(row, viewType)` returns `false` only when `viewType === "Bases"` and `row.basesStatus === "skipped"`.

That means the reaction count is controlled by the gate-time row status, not by the later published text snapshot.

The production log confirms the gate math:

- `rowCount=9`
- `skippedCount=6`
- `expectedReactionCount=3`
- `trackedClanCount=9`
- `gateExpiresAt=2026-07-15T21:17:00.000Z`

So the checklists are doing what the code says: six rows were treated as skipped at gate time, and three rows were reaction-eligible.

## Why The 07:44 vs 20:55 Contradiction Exists

The contradiction disappears once the rows are separated:

- `2026-07-15T07:44:34.314Z` is the Discord creation time for the sync root message.
- `2026-07-15T07:44:34.603Z` is the database `TrackedMessage.createdAt` for that same sync-root row.
- `2026-07-15T20:55:43.365Z` / `2026-07-15T20:55:43.572Z` belong to a different `SYNC_TIME_POST` tracked-message row.

Those are not competing timestamps for the same record. They are different records with different roles.

## What The Logs Do And Do Not Prove

### Mail

The Mail checklist was published at `2026-07-15T21:01:45.959Z` and the message row was created at `2026-07-15T21:01:46.334Z`.

The current `checkedClanTags` on that Mail tracked row include RR and SH, but that is later reaction state, not the original publication snapshot.

### Bases

The Bases checklist was published at `2026-07-15T21:17:46.176Z` and the message row was created at `2026-07-15T21:17:46.618Z`.

The first retained readiness-gate log is:

- `event=ready_gate_expired guild=1324040917602013261 syncMessageId=1526856991119769693 kind=bases_checklist rowCount=9 skippedCount=6 expectedReactionCount=3 trackedClanCount=9 reason=bases_ready_gate_expired gateExpiresAt=2026-07-15T21:17:00.000Z`

That log proves the gate expired before publication and explains why only three reactions were expected.

### Refresh behavior

The captured logs do not include a retained failure line such as `FWA match checklist refresh button failed`, `refresh failed message=...`, or `This checklist post can no longer be refreshed.`

What we do have are later `fwa_checklist_bases_refresh_state` logs that show the state builder running again with `rowCount=9`. Those are later refresh-state observations, not evidence of the original gate-time snapshot.

## Per-Clan Characterization

The safest read is to separate what is directly proven from what is still unknown.

| Clan | Tag | What is directly proven | Characterization |
| --- | --- | --- | --- |
| RD | `#2YUYLJCGV` | Appears in the published Bases snapshot as `checked and all good` | Not part of the six skipped rows in the publication snapshot |
| ZG | `#LQQ99UV8` | Appears in the published Bases snapshot as `not checked` | The gate-time cause is not directly proven in the captured evidence |
| DE | `#R80L8VYG` | Appears in the published Bases snapshot as `not checked` | The gate-time cause is not directly proven in the captured evidence |
| SE | `#82YLR9Q2` | Reaction-eligible at gate time; also appears in later live refresh evidence | Directly supported as one of the three reaction-eligible clans |
| TWC | `#29PCQGUV0` | Appears in the published Bases snapshot as `not checked` | The gate-time cause is not directly proven in the captured evidence |
| RR | `#2RYGLU2UY` | Reaction-eligible at gate time; later logs show `persist_current_war result=missing_row` for a retained sync-assignment failure | Directly supported, but the retained log is the first retained failed stage, not necessarily the first failure |
| AK | `#2RVV0L0VP` | Reaction-eligible at gate time; later logs show a live matched war | Directly supported as one of the three reaction-eligible clans |
| SH | `#C0CU2Q82` | Appears in the published Bases snapshot as `checked and all good` | Not part of the six skipped rows in the publication snapshot |
| EB | `#2QVGPQP0U` | Appears in the published Bases snapshot as `checked and all good` | Not part of the six skipped rows in the publication snapshot |

The key constraint is that we do not have a retained per-clan gate-time snapshot for every one of the six skipped rows. Because of that, the evidence supports a conservative label of "unknown gate-time cause" rather than a stronger claim like "participated but unmatched" for every clan.

## Root Cause Boundary

The evidence supports this narrower diagnosis:

- the scheduler published after the readiness gate had already expired
- the gate-time row classification produced six skipped rows and three reaction-eligible rows
- the persisted publication snapshots are not the same thing as the gate-time reaction decision
- later refresh logs are not a substitute for the original gate-time snapshot

This document intentionally stops at diagnosis and does not implement the behavior change.
