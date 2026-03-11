IMPORTANT:
Before implementing any code changes, read:

- architecture-contract.md
- core-priorities.md

# ClashCookies – Project Brain

This file defines the architectural context for the project.
All AI tasks should read this file before making changes.

Related documents:
- docs/core-priorities.md
- docs/architecture-contract.md

---

# Project Goals

Primary goals:

1. Reliable FWA tooling for Discord clans
2. Deterministic war event handling
3. Fast command response times
4. Clear data ownership boundaries
5. Safe schema evolution

---

# System Architecture Overview

High level flow:

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
Render using CurrentWar + ClanPointsSync

---

# State Ownership

Each domain concept has a single authoritative owner.

| Concept | Owner |
|------|------|
Tracked clans | TrackedClan |
Live war state | CurrentWar |
FWA sync metadata | ClanPointsSync |
War participation history | ClanWarParticipation |
Archived war payloads | WarLookup |
Event idempotency | WarEvent |
Posted Discord messages | ClanPostedMessage |
Clan configuration | TrackedClan |
Notification routing | ClanNotifyConfig |
Custom war plans | ClanWarPlan |

Do not duplicate ownership across tables.

---

# Polling Model

War polling always starts from `TrackedClan`.

Never start polling from derived tables such as `CurrentWar`.

Derived tables must be recreatable by polling.

---

# Command Performance Expectations

Hot commands must remain fast.

Examples:
- `/fwa match`
- `/inactive`

Rules:

- Avoid external HTTP calls inside commands.
- Prefer DB reads over live API calls.
- Use bulk queries instead of per-clan queries.
- Poll loops handle expensive operations.

---

# Idempotency Guarantees

All war events must be idempotent.

Tables responsible:

WarEvent
ClanPostedMessage

These tables prevent duplicate Discord messages.

---

# Schema Evolution Rules

When changing ownership of a field:

1. Introduce the new table
2. Migrate reads
3. Backfill data
4. Remove old ownership

Never perform ownership swaps in a single step.

---

# Expected Scale

Design should support:

- 50–100 tracked clans
- thousands of wars
- years of historical data

---

# Working Style

Follow repository workflow defined in:

docs/core-priorities.md

Important expectations:

- feature branches only
- small commits
- tests required
- documentation updated

---

# If Architectural Conflict Appears

Stop and explain the conflict.

Do not implement changes that violate architecture rules without explicit approval.