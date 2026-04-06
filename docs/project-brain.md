IMPORTANT:
Before implementing any code changes, read:

- architecture-contract.md
- core-priorities.md

# ClashCookies - Project Brain

This file defines the architectural context for the project.
All AI tasks should read this file before making changes.

Related documents:
- docs/core-priorities.md
- docs/architecture-contract.md
- docs/deployment.md
- docs/observability.md

---

# Project Goals

Primary goals:

1. Reliable FWA and CWL tooling for Discord clans
2. Deterministic war, mail, and notify handling
3. Fast DB-first command response times
4. Clear state ownership boundaries
5. Safe schema and platform evolution
6. Strong operational visibility for production and staging

---

# System Architecture Overview

High-level runtime model:

- The Discord command surface renders primarily from persisted state.
- Active runtime instances own upstream pollers, schedulers, and refresh loops.
- Mirror runtime instances do not own upstream polling; they mirror a guarded runtime-table allowlist from production for staging-safe reads.
- The app exposes health endpoints and emits internal telemetry in addition to the external droplet observability stack.

Core subsystems:

- War state: `TrackedClan -> WarEventLogService/poll loops -> CurrentWar -> ClanWarHistory / ClanWarParticipation / WarAttacks / WarLookup / WarEvent / WarMailLifecycle / ClanPostedMessage`
- Points sync: `points.fwafarm -> PointsSyncService -> ClanPointsSync`
- Feed-backed current state: `FWAStats JSON feeds -> FwaFeedSchedulerService -> FwaClanCatalog / FwaPlayerCatalog / FwaClanMemberCurrent / FwaWarMemberCurrent / FwaClanWarLogCurrent`
- Snapshot-backed todo: `PlayerLink + TodoUserUsage + CurrentWar + CurrentCwlRound/CwlRoundMemberCurrent + activity signals -> TodoSnapshotService -> TodoPlayerSnapshot`
- Persisted CWL state: `CwlTrackedClan -> CwlStateService -> CurrentCwlRound / CwlRoundMemberCurrent / CurrentCwlPrepSnapshot / CwlRoundHistory / CwlRoundMemberHistory / CwlPlayerClanSeason`
- CWL planner state: `CurrentCwlRound + CwlRoundMemberCurrent + CurrentCwlPrepSnapshot + CwlPlayerClanSeason -> CwlRotationService -> CwlRotationPlan / CwlRotationPlanDay / CwlRotationPlanMember`, with sheet import/export orchestration layered on top for admin-only planner exchange flows.
- Reminder delivery: `Reminder/UserActivityReminder config + snapshots/current war -> reminder schedulers -> delivery logs`
- Operational state: `TrackedMessage`, unlinked-alert persistence, telemetry aggregates, report schedules

---

# State Ownership

Each domain concept has a single authoritative owner.

Important owners:

| Concept | Owner |
| --- | --- |
| Tracked FWA clans | TrackedClan |
| Seasonal CWL tracked clans | CwlTrackedClan |
| Live battle-day CWL round identity and timing | CurrentCwlRound |
| Live battle-day CWL round member summaries | CwlRoundMemberCurrent |
| Live overlapping prep-day CWL snapshot | CurrentCwlPrepSnapshot |
| Ended CWL round history | CwlRoundHistory |
| Ended CWL round member history | CwlRoundMemberHistory |
| Derived observed CWL season roster | CwlPlayerClanSeason |
| CWL planner artifacts | CwlRotationPlan* tables |
| Player-to-Discord links | PlayerLink |
| Live war state | CurrentWar |
| Ended-war canonical record | ClanWarHistory |
| Ended-war participation | ClanWarParticipation |
| Points sync metadata | ClanPointsSync |
| Posted notify/mail messages | ClanPostedMessage |
| Active-war mail lifecycle | WarMailLifecycle |
| Todo activation gate | TodoUserUsage |
| Todo render snapshots | TodoPlayerSnapshot |
| Guild reminders | Reminder* tables |
| Personal reminders | UserActivityReminder* tables |
| Tracked long-lived posts | TrackedMessage* tables |
| FWA feed current-state tables | Fwa* current-state tables |
| Telemetry rollups and report schedules | Telemetry* tables |

Do not duplicate ownership across tables.

---

# Polling Model

- Active mode owns external pollers and schedulers.
- Mirror mode is read-oriented and only runs guarded prod-to-staging snapshot sync for the runtime allowlist.
- Expensive upstream fetches should happen in background services, not in user-facing commands.
- Derived tables and snapshots must be recreatable by their owning service.
- Mirror runtime should include runtime-owned CWL round/history tables, and planner tables when staging needs consistent `/cwl` rendering against mirrored prod data.

---

# Command Performance Expectations

Hot commands must remain fast.

Examples:

- `/fwa match`
- `/todo`
- `/inactive`

Rules:

- Avoid external HTTP calls inside hot command render paths when persisted state already exists.
- Prefer DB reads over live API calls.
- Use bulk reads instead of per-clan or per-player fan-out.
- Keep schedulers and poll loops bounded by tracked scope.

---

# Deployment Model

Current production and staging deployments are droplet-based.

- Production runs in active polling mode.
- Staging runs in mirror mode against production runtime data.
- The app exposes `/livez` and `/healthz`.
- External observability on the droplet is documented separately in `docs/observability.md`.

When deployment assumptions change, update:

- `README.md`
- `docs/deployment.md`
- `docs/observability.md`

---

# Schema Evolution Rules

When changing ownership of a field:

1. Introduce the new table.
2. Migrate reads.
3. Backfill data.
4. Remove old ownership.

Never perform ownership swaps in a single step.

---

# Expected Scale

Design should support:

- 50-100 tracked FWA clans
- seasonal CWL registries
- thousands of wars and participation rows
- growing reminder, telemetry, tracked-message, and feed-state tables
- years of historical data

---

# Working Style

Follow repository workflow defined in:

docs/core-priorities.md

Important expectations:

- feature branches only
- small commits
- tests required when behavior changes
- documentation updated for user-facing, architectural, runtime, or platform changes

---

# If Architectural Conflict Appears

Stop and explain the conflict.

Do not implement changes that violate architecture rules without explicit approval.
