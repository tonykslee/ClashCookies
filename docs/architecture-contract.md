# Architecture Contract (Do Not Violate Without Explicit Approval)

You must preserve these system flows unless I explicitly approve a redesign.

## System Flow diagram

TrackedClan
    │
    ▼
WarEventPoller
    │
    ▼
CurrentWar
    │
    ├── ClanWarParticipation
    ├── WarLookup
    └── WarEvent

points.fwafarm
    │
    ▼
PointsSyncService
    │
    ▼
ClanPointsSync

Commands
    │
    ▼
read from CurrentWar + ClanPointsSync

## 0) State ownership map (single source of truth)

Each domain concept must have exactly one authoritative owner.

| Concept                   | Owner                |
| ------------------------- | -------------------- |
| Tracked clans             | TrackedClan          |
| Live war state            | CurrentWar           |
| FWA sync metadata         | ClanPointsSync       |
| War participation history | ClanWarParticipation |
| Archived war payloads     | WarLookup            |
| Event idempotency         | WarEvent             |
| Posted Discord messages   | ClanPostedMessage    |
| Clan metadata/config      | TrackedClan          |
| Notification routing      | ClanNotifyConfig     |
| Custom war plans          | ClanWarPlan          |

Rules:

- Do not duplicate ownership fields across tables.
- Do not store derived data where it can be queried from the owner.
- If a field appears in two tables, one must be explicitly marked as derived.

## 1) War polling ownership

- Polling starts from `TrackedClan` (authoritative set), not `CurrentWar`.
- `CurrentWar` is derived runtime state created/updated by poll.
- Empty `CurrentWar` must be bootstrappable by poll/force poll.
- Polling services must always start from authoritative sources
  - (e.g. TrackedClan) rather than derived runtime state.
- Derived tables must be recreatable by pollers.

## 2) CurrentWar role

- `CurrentWar` stores live war state only.
- Do not treat `CurrentWar.syncNum` as authoritative sync source.

## 3) Points sync ownership

- `ClanPointsSync` is the single source of truth for points.fwafarm sync metadata.
- `/fwa match` validation must read from `ClanPointsSync` (warId first, then warStart fallback).
- Do not reintroduce `TrackedClan.pointsScrape` validation logic.

## 4) War history ownership

- `WarAttacks` is current-war operational data only.
- At war end, archive participation into `ClanWarParticipation`.
- `/inactive` must query `ClanWarParticipation` (SQL/window logic), not historical `WarAttacks`.

## 5) Idempotent messaging

- `WarEvent` is the event guard (dedupe/idempotency).
- `ClanPostedMessage` is message tracking for mail/notify updates and edits.
- Do not reintroduce message tracking in `TrackedClan.mailConfig.messages[]`.

## 6) TrackedClan scope

- `TrackedClan` holds clan metadata/config only.
- Keep runtime/posted-message/sync-history ownership in dedicated tables/services above.

## 7) Change safety rule

- If a requested change appears to conflict with any rule above:
  1. Stop.
  2. Explain the conflict.
  3. Ask for explicit approval before implementing.

## 8) Performance invariants

Hot command paths must remain fast.

Rules:

- `/fwa match` must execute without external HTTP calls.
- Poll loops must avoid N+1 queries.
- Database queries should prefer bulk reads over per-clan queries.
- Poll loops must remain bounded by the number of tracked clans.

Preferred pattern:

1 query → in-memory map → command rendering

Avoid patterns like:

for each clan:
database query

## 9) Schema evolution safety

When changing table ownership:

1. Introduce the new owner table.
2. Migrate reads to the new table.
3. Backfill data if necessary.
4. Remove the old ownership field.

Never switch ownership in a single step.

## 10) Command determinism

Commands should not rely on unstable external systems.

Preferred hierarchy:

Database → cache → external API

Expensive or unreliable operations must be handled by polling jobs,
not user commands.

## Expected scale

The system should remain stable with:

- 50–100 tracked clans
- thousands of war participation rows
- years of historical data

Design decisions should prefer long-term clarity over short-term convenience.