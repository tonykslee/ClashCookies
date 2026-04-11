<div align="center">
  <img src="assets/ClashCookies_logo_master_alpha.png" alt="Logo" width="200">
</div>

# ClashCookies
ClashCookies is a TypeScript-based Discord bot and operations tooling platform for Clash of Clans clan management. It combines command-driven workflows, persistent data models, and automation loops to support day-to-day war operations, player activity tracking, and alliance reporting.

The project is designed as a maintainable application, not a one-off bot script: it has clear service boundaries, Prisma-backed persistence, operational scripts, and a broad automated test suite. The intent is reliable ongoing iteration for real clan operations.

## Highlights
- TypeScript + Node.js application with a command-first Discord UX
- Workflow automation for war lifecycle, mail refresh, and sync flows
- Reporting and operational visibility for leaders and staff
- Prisma-backed data ownership with explicit lifecycle/state modeling
- Active production runtime plus mirror-mode staging support
- Built-in health endpoints, telemetry reports, and external observability support
- Test coverage, scripts, docs, and deployment/configuration support
- Built for maintainability, determinism, and operational reliability

## Tech Stack
- TypeScript, Node.js
- Discord API via slash commands and interactive message components
- Prisma ORM with PostgreSQL-backed persistence
- Vitest test suite + TypeScript type-checking
- Scripted local/dev workflows and droplet-oriented container deployment paths
- Self-hosted observability on the droplet via Uptime Kuma, Dozzle, and Netdata

## What It Does
### Command-driven workflows
- Runs a large slash-command surface for war operations, roster tasks, compliance checks, and admin tooling.
- Supports interactive command flows (buttons/modals/selects) for in-channel operational actions.
- Keeps command behavior deterministic with DB-first command rendering where possible.

### Reporting and visibility
- Produces matchup, sync, activity, and compliance views for tracked clans.
- Supports leadership-focused summaries such as inactivity and clan-health snapshots.
- Includes telemetry reporting and scheduled report delivery in Discord.

### Operational automation
- Polls and reconciles war-related state with explicit lifecycle ownership.
- Refreshes tracked war-mail posts and applies guarded reconciliation rules for missing/stale targets.
- Uses bounded feed-sync/watch loops for external data ingestion and update timing.
- Supports mirror-mode staging via guarded prod-to-staging runtime snapshot sync.
- Exposes `/livez` and `/healthz` for liveness/readiness checks.

### Clan management tooling
- Manages tracked clan configuration, mail channels/roles, and war plans.
- Supports player-linking, roster-related utilities, and operational helper commands.
- Provides FWA-focused tooling for points, match handling, layouts, and related workflows.
- Adds persisted CWL round tracking plus `/cwl members`, `/cwl rotations`, and CWL sheet import/export planner flows on top of seasonal CWL clan tracking.

### Reliability and maintainability support
- Uses explicit data ownership boundaries across lifecycle/persistence tables.
- Includes force/repair commands for operational recovery without bypassing core state rules.
- Includes tracked-message lifecycle handling, telemetry rollups, and reminder schedulers as first-class runtime concerns.
- Maintains contributor documentation, setup guides, and script-based workflows.

## Detailed Capability Notes
- `/fwa match` and `/fwa mail send` share active-war mail freshness gating and only treat same-war, same-outcome references as up to date.
- `/fwa police` includes canonical per-violation template management (`Custom -> Default -> Built-in`), warplan-aware applicability preview (`show`/`show-default`/`show-all`), and sample test-send (`DM`/`LOG`) through the same renderer used by live enforcement.
- Active-war mail lifecycle reconciliation handles missing/inaccessible tracked references and keeps lifecycle state aligned with usable message targets.
- `/force sync mail` validates supplied mail `message_id` against current-channel active-war identity before writing `WarMailLifecycle`.
- `/force mail update` reconciles tracked references before in-place refresh and resumes/stops refresh tracking based on validity.
- Match state rendering supports deterministic active-war inference and explicit confirmation persistence for BL/MM/FWA decisions.
- Sync validation uses war-scoped persisted snapshots (`ClanPointsSync`) with explicit force-sync paths for refresh-scrape operations.
- `/todo` renders from precomputed per-player snapshots (`TodoPlayerSnapshot`) so high-traffic reads stay fast and avoid live per-player multi-source aggregation on command execution, with grouped WAR/CWL sections, shared top timer for RAIDS, and phased GAMES rendering (active earning, latest-results reward collection through the full claim window, then post-reward lifetime totals) plus CWL context resolved from a seasonal CWL clan registry/player mapping layer instead of assuming home FWA clan.
- CWL now has parallel persisted owners for live/prep rounds, ended round history, and planner state so `/todo cwl` and `/cwl ...` commands stay DB-first when persisted state exists.
- `/reminders` now supports preview-first create/list/edit flows with FWA+CWL clan targeting, persisted reminder configs, and background scheduler dispatch with dedupe fire logs.
- Reminder deliveries now send plain-text Discord messages so inline user mentions actually notify, with whole-line overflow splitting capped at 3 messages.
- Unlinked tracked-clan member alerts use dedicated persistence instead of `BotSetting`, support one guild-level alert channel with tracked-clan log fallback, and expose `/unlinked list` for current unresolved FWA plus active CWL members.
- Staging mirror sync now includes the runtime-owned CWL round/history tables plus CWL planner tables so `/todo cwl` and `/cwl rotations` render consistently against mirrored prod data. CWL sheet import reads public published sheet URLs without Google Sheets credentials, while export uses writable Google Sheets auth.
- War-mail and match embeds use consistent effective-state color mapping for BL/MM/FWA/unresolved states.
- Notification and posting flows include operational logging controls (`/bot-logs`, `/say`, telemetry report + schedule commands).
- FWA stats and operations commands include weight-age/health tooling, compliance checks, and layout management.
- FWAStats feed ingestion is DB-backed (`FwaFeedSyncState`, `FwaClanWarsWatchState`, related current-state tables) with bounded scheduler cadence.

## Quick Start
```bash
npm install
npx prisma migrate deploy
npm run build
npm start
```

## Deployment Model
Production and staging currently run on a droplet-based container deployment.

Production uses `POLLING_MODE=active` and owns upstream pollers/schedulers. Staging uses `POLLING_MODE=mirror` with guarded prod-to-staging runtime snapshot sync so it can stay operational without duplicating upstream polling. Health endpoints are built into the app, and the droplet observability stack is documented in [Observability](docs/observability.md).

## Documentation
- [Setup and Environment](docs/setup.md)
- [Commands Reference](docs/commands.md)
- [Command Access and Permissions](docs/permissions.md)
- [Deployment and Install Links](docs/deployment.md)
- [Observability](docs/observability.md)

## Development
See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and architecture documentation.
FWA command internals are split under `src/commands/fwa/` helper modules to keep `Fwa.ts` orchestration-focused and unit-testable.
Run `npm run seed:fwa-layouts` after migrations when you want to upsert the canonical layout seed rows.
Droplet deploys use cached Yarn dependency volumes and only rerun locked installs when `package.json` or `yarn.lock` changes. The current container path uses `ops/deploy/container-start.sh`, which runs the dependency guard, builds, and then starts the app.

## FWAStats Feed Ingestion (Phase 1)
Endpoints wired:
- `https://fwastats.com/Clans.json`
- `https://fwastats.com/Clan/<clan-tag>/Members.json`
- `https://fwastats.com/Clan/<clan-tag>/WarMembers.json?warNo=1`
- `https://fwastats.com/Clan/<clan-tag>/Wars.json`

Intentionally omitted:
- `https://fwastats.com/Weights.json` (not part of this ingestion phase)

Current-state tables:
- `FwaClanCatalog`
- `FwaPlayerCatalog`
- `FwaClanMemberCurrent`
- `FwaWarMemberCurrent`
- `FwaClanWarLogCurrent`
- `FwaFeedSyncState`
- `FwaClanWarsWatchState`
- `FwaFeedCursor` (distributed sweep cursor state)

Cadence defaults and cost controls:
- `Clans.json`: every 6 hours
- tracked-clan `Members.json`: every 15 minutes (minimum source freshness respected)
- `WarMembers.json`: distributed sweep ticks every 15 minutes with bounded chunk size/concurrency
- tracked-clan `Wars.json` watch: 5-minute cadence only inside active per-clan windows, starts 5 minutes before sync time, stops once update is acquired
- optional global `Wars.json` sweep: disabled by default, configurable and chunked
- command paths remain DB-first; `/compo state mode:war` and `/compo place` now read persisted feed-backed state, while `/compo state mode:actual` remains sheet-backed in this phase
- `/compo place` now includes an explicit in-message refresh button that refreshes ACTUAL tracked-clan current-member/weight state plus live CoC member counts before rerendering from persisted data

Manual/dev operations (script tooling):
```bash
npm run sync:fwa-feeds -- status
npm run sync:fwa-feeds -- run --feed=clan-members --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run --feed=clan-wars --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run-global --feed=clans
npm run sync:fwa-feeds -- run-global --feed=war-members
npm run sync:fwa-feeds -- watch-status --tag=#2QG2C08UP
```
