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
- `/fwa match` and `/fwa mail send` now share active-war mail freshness gating: sent state is scoped to current war identity, shows explicit up-to-date/out-of-date status, disables resend when matchType/outcome are unchanged, and re-enables resend when those fields change.
- Supports configurable war plans by match type/outcome via `/warplan set|show|reset`; these templates are used in posted war mail content (including line breaks, emoji, and media links).
- Optimized points polling now tracks lifecycle state in `ClanPointsSync` (`confirmedByClanMail`, `needsValidation`, last-known values) and reduces routine `points.fwafarm` calls after clan-mail confirmation.
- Poller-side points fetches now use a shared gate that enforces an active-war mail-confirmed lock (`confirmedByClanMail=true`, `needsValidation=false`, matching war identity), blocking routine `post_war_reconciliation`/`mail_refresh` calls until an explicit unlock trigger.
- `/fwa match` now shows actionable sync status only when validation is needed, keeps single-clan sync/fetch timing details, and hides non-actionable lifecycle/debug lines from user-facing output.
- `/fwa match` now reuses war-scoped verified points snapshots from persisted sync data for the active war, and `/force sync data` remains the explicit refresh-scrape path.
- `/fwa match` now applies deterministic active-war opponent inference (`Active FWA: No` -> BL, `Active FWA: Yes` -> inferred FWA, opponent-missing non-FWA wars resolve BL/MM only from owned active-war evidence or explicit confirmation), keeps active-war sync lookup war-scoped, keeps inferred states visibly flagged until confirmed, and still allows war-mail preview/send while that warning is present.
- Final `Send Mail` confirmation now persists explicit match confirmation for the same active war identity, so rerender/refresh does not regress confirmed BL/MM/FWA back to inference fallback.
- In `/fwa match` war-changing state, mismatch output now shows field-specific differences (opponent, sync #, outcome, match type) against persisted validation, uses `:interrobang: Clan not found on points.fwafarm` for opponent-page-missing validation, and supports MM/BL no-opponent-page sync advancement via tracked-clan page fallback in the shared points snapshot path.
- Direct `/fwa match tag:<clan>` cards now return to the full alliance overview when `Alliance View` is pressed, while keeping fast initial single-clan render behavior.
- Prisma client bootstrap is now lazy and test-safe: importing persistence-backed modules no longer initializes the Prisma engine until first real DB use, which keeps CI/unit tests independent from live DB runtime.
- War-mail embeds now use state-coded sidebars (BL=black, MM=white, FWA WIN=green, FWA LOSE=red, unresolved=gray) and refresh/update paths keep color aligned with current match type/outcome.
- Single-clan `/fwa match` embeds now use the same state-coded sidebar mapping from the currently displayed effective state (including draft revisions), without changing confirmation/persistence semantics.
- `/remaining war` now supports alliance-wide aggregate mode (no tag) with dominant-cluster mean remaining time, spread, and outlier clan reporting.
- Telemetry now records command lifecycle/API/stage aggregates and supports `/telemetry report` plus scheduled Discord report posting.
- `/bot-logs` now lets admins set or inspect the guild-scoped destination channel for important bot log posts, with stale channel handling.
- `/say` now allows anyone to use `show-from:false`, keeps the normal channel-send path for shortcode rendering, and logs hidden-source sends to `/bot-logs` when configured.
- `/clan-health` now provides a DB-only leadership snapshot per tracked clan (last-30 match/win rates, inactivity counts, and missing Discord links).
- `/fwa weight-age`, `/fwa weight-link`, `/fwa weight-health`, and `/fwa weight-cookie` now provide FWA Stats weight monitoring with cached scraping, stale-weight flags, auth-expiry recovery guidance, and secure cookie status/update flows.
- `/fwa compliance` now runs the shared war-end compliance engine on demand for a tracked clan (latest ended war by default, optional `war-id` override).
- `/layout` now supports FWA base layout listing/fetch by Town Hall and admin-only link upserts (with optional `img-url` preview updates), backed by the new `FwaLayouts` table.
- FWAStats JSON feed ingestion foundation is now DB-backed with dedicated current-state tables, feed-sync metadata ownership (`FwaFeedSyncState`), tracked-clan wars watch state (`FwaClanWarsWatchState`), and bounded scheduler loops.

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
Run `npm run seed:fwa-layouts` after migrations when you want to upsert the canonical layout seed rows.

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
- command paths remain DB-first; `/compo` is still sheet-backed in this phase

Manual/dev operations (script tooling):
```bash
npm run sync:fwa-feeds -- status
npm run sync:fwa-feeds -- run --feed=clan-members --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run --feed=clan-wars --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run-global --feed=clans
npm run sync:fwa-feeds -- run-global --feed=war-members
npm run sync:fwa-feeds -- watch-status --tag=#2QG2C08UP
```
