# ClashCookies
Discord bot for Clash of Clans activity tooling.

## What It Does
- Tracks configured clans and updates player activity records.
- Supports last seen and inactivity queries.
- Manages tracked clans and roster/sheet integrations.
- Provides FWA points and matchup tooling.
- Uses cached `/fwa match` rendering with processing indicators for faster button interactions.
- Supports tracked-clan mail channel config via `/tracked-clan configure` and send-preview flow via `/fwa mail send`.
- War mail send paths now mention the tracked clan role (`TrackedClan.clanRoleId`) when pinging is enabled.
- `/fwa match` mail status now scopes "already sent" to the current war identity (war/opponent/config), so new wars start unsent and old posts stop refreshing into new wars.
- Supports configurable war plans by match type/outcome via `/warplan set|show|reset`; these templates are used in posted war mail content (including line breaks, emoji, and media links).
- Optimized points polling now tracks lifecycle state in `ClanPointsSync` (`confirmedByClanMail`, `needsValidation`, last-known values) and reduces routine `points.fwafarm` calls after clan-mail confirmation.
- Poller-side points fetches now use a shared gate that enforces an active-war mail-confirmed lock (`confirmedByClanMail=true`, `needsValidation=false`, matching war identity), blocking routine `post_war_reconciliation`/`mail_refresh` calls until an explicit unlock trigger.
- `/fwa match` now shows actionable sync status only when validation is needed, keeps single-clan sync/fetch timing details, and hides non-actionable lifecycle/debug lines from user-facing output.
- `/fwa match` now reuses war-scoped verified points snapshots from persisted sync data for the active war, and `/force sync data` remains the explicit refresh-scrape path.
- `/fwa match` now applies deterministic opponent signal inference (`Clan not found` -> MM, `Active FWA: No` -> BL, `Active FWA: Yes` -> inferred FWA), persists the inferred Active FWA signal for sync fallback, and requires explicit match-type confirmation before Send Mail for all inferred match types.
- War-mail embeds now use state-coded sidebars (BL=black, MM=white, FWA WIN=green, FWA LOSE=red, unresolved=gray) and refresh/update paths keep color aligned with current match type/outcome.
- `/remaining war` now supports alliance-wide aggregate mode (no tag) with dominant-cluster mean remaining time, spread, and outlier clan reporting.
- Telemetry now records command lifecycle/API/stage aggregates and supports `/telemetry report` plus scheduled Discord report posting.
- `/clan-health` now provides a DB-only leadership snapshot per tracked clan (last-30 match/win rates, inactivity counts, and missing Discord links).
- `/fwa weight-age`, `/fwa weight-link`, `/fwa weight-health`, and `/fwa weight-cookie` now provide FWA Stats weight monitoring with cached scraping, stale-weight flags, auth-expiry recovery guidance, and secure cookie status/update flows.
- `/fwa compliance` now runs the shared war-end compliance engine on demand for a tracked clan (latest ended war by default, optional `war-id` override).

## Quick Start
```bash
npm install
npx prisma migrate deploy
npm run build
npm start
```
## Documentation
- [Setup and Environment](docs/setup.md)
- [Commands Reference](docs/commands.md)
- [Command Access and Permissions](docs/permissions.md)
- [Deployment and Install Links](docs/deployment.md)

## Development
See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and architecture documentation.
FWA command internals are split under `src/commands/fwa/` helper modules to keep `Fwa.ts` orchestration-focused and unit-testable.
