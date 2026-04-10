# Setup

## Base Setup
1. Create a `.env` with required Discord, CoC API, and database values.
2. Install dependencies.
3. Run migrations.
4. Build and start.

```bash
npm install
npx prisma migrate deploy
npm run seed:fwa-layouts
npm run seed:heatmap-ref
npm run build
npm start
```

## Optional Owner Bypass
- `OWNER_DISCORD_USER_ID` - single Discord user ID with full command access override in all guilds.
- `OWNER_DISCORD_USER_IDS` - comma-separated list of Discord user IDs with full override.

## Optional ClashKing Link Lookup
- `CLASHKING_LINKS_URL_TEMPLATE` - ClashKing links endpoint URL (supports either fixed `POST /discord_links` or a `{tag}` URL template).
- `CLASHKING_API_TOKEN` - bearer token for private ClashKing API (if required).

Behavior:
- `/accounts` resolves linked accounts from persisted `PlayerLink` and local player activity only.
- Activity observe loop checks unresolved tracked-member links via ClashKing at most once every 6 hours and caches matches in `PlayerLink`.

## Optional War Event Poll Setting
- `WAR_EVENT_LOG_POLL_INTERVAL_MINUTES` - interval for war-state event listener polling (default: `15` minutes).
  - A longer cadence reduces repeated full-cycle queue pressure while the war-event producer now staggers linked-player refreshes internally.

## Polling Ownership Mode (Prod Polls, Staging Mirrors)
- `POLLING_MODE` - `active` (default) or `mirror`.
  - `active`: runs normal external pollers/schedulers.
  - `mirror`: disables duplicated upstream pollers and runs prod->staging snapshot sync.
- `MIRROR_SOURCE_DATABASE_URL` - required in `mirror` mode; source/prod DB URL used for one-way sync.
- `MIRROR_SYNC_INTERVAL_MINUTES` - mirror scheduled sync cadence (default: `15` minutes).
- `MIRROR_SYNC_BATCH_SIZE` - createMany batch size for mirrored table writes (default: `500`).
- `POLLING_ENV` (or `DEPLOY_ENV` / `APP_ENV`) - set to `staging` for mirror instances; mirror sync is safety-blocked in `prod`.

Mirror mode behavior:
- Disables duplicated external polling owners (activity observe, war-event poll, FWA feed scheduler, user-activity reminder scheduler).
- Runs scheduled full-overwrite sync for mirrored runtime tables:
  - `TrackedClan`
  - `CurrentWar`
  - `WarAttacks`
  - `ClanPointsSync`
  - `ClanWarHistory`
  - `ClanWarParticipation`
  - `WarLookup`
- Sync direction is always source/prod -> target/current DATABASE_URL.

Manual sync now:
```bash
npm run sync:mirror
```

## Optional Optimized Points Polling
- `FWA_OPTIMIZED_POINTS_POLLING` - enable lifecycle-based routine fetch gating for points checks (default: `true`).
- `FWA_POST_WAR_CHECK_WINDOW_MINUTES` - how long post-war delayed-update checks may run after war end (default: `240`).
- `FWA_POST_WAR_CHECK_INTERVAL_MINUTES` - minimum interval between post-war delayed-update checks (default: `30`).
- `FWA_ADMIN_ADJUSTMENT_CHECK_INTERVAL_MINUTES` - routine recheck interval for possible manual admin adjustments (default: `360`).
- `FWA_PRE_FWA_VALIDATION_WINDOW_MINUTES` - preparation-window size for pre-FWA validation checks (default: `90`).
- `FWA_PRE_FWA_VALIDATION_INTERVAL_MINUTES` - minimum interval between pre-FWA validation checks while in the window (default: `20`).

Notes:
- The FWA-vs-FWA auto-adjust timing is still treated as unverified; the default policy keeps conservative periodic validation checks.

## Optional FWA Stats Weight Auth
- `FWASTATS_WEIGHT_COOKIE` - optional fallback cookie header used for scraping `https://fwastats.com/Clan/<tag>/Weight` in `/fwa weight-age` and `/fwa weight-health`.

Operational notes:
- Preferred runtime path is `/fwa weight-cookie application-cookie:<value-or-name=value> antiforgery-cookie:<value-or-name=value> [antiforgery-cookie-name:<name>]` (saved in `BotSetting`), with `FWASTATS_WEIGHT_COOKIE` kept as env fallback. If no antiforgery name is provided, default is `.AspNetCore.Antiforgery.oBHtDLr47-0`.
- `/fwa weight-cookie` (no cookie args) shows status, runtime source, and expiry metadata when parseable.
- Store cookie values only in your secret manager or bot settings, never in git-tracked files.
- Rotate cookies when telemetry reports `FWASTATS_AUTH_EXPIRED` or `FWASTATS_LOGIN_PAGE_DETECTED`.
- If telemetry reports `FWASTATS_AUTH_REQUIRED`, no usable cookie is configured.
- Auth failures are intentionally not cached for long so recovery is fast after cookie updates.

## Google Sheets (OAuth)
This project is currently set up to use OAuth refresh token auth.

Required env vars:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

Notes:
- Refresh token scope: `https://www.googleapis.com/auth/spreadsheets.readonly` for read-only flows, or `https://www.googleapis.com/auth/spreadsheets` + `https://www.googleapis.com/auth/drive.file` when you need sheet export/write support.
- The Google account tied to the refresh token must have access to the source sheet for imports.
- Viewer access is enough for `/cwl rotations import`; `/cwl rotations export` requires writable Sheets auth.

Optional fallback auth (not required for current setup):
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

When using the service-account path, make sure the token scopes include writable Sheets and Drive file permissions so the CWL planner export can create and publish a brand-new sheet.

## Optional FWAStats Feed Ingestion Scheduler
These control the JSON-feed ingestion foundation for future DB-backed `/compo` migration.

Feed toggles:
- `FWA_CLANS_SYNC_ENABLED` (default `true`)
- `FWA_CLAN_MEMBERS_SYNC_ENABLED` (default `true`)
- `FWA_WAR_MEMBERS_SWEEP_ENABLED` (default `true`)
- `FWA_TRACKED_CLAN_WARS_WATCH_ENABLED` (default `true`)
- `FWA_GLOBAL_CLAN_WARS_SWEEP_ENABLED` (default `false`)

Cadence controls:
- `FWA_CLANS_SYNC_CRON_OR_MINUTES` (default `360`; clamped to minimum 15 minutes)
- `FWA_CLAN_MEMBERS_SYNC_MINUTES` (default `15`; minimum 15)
- `FWA_SWEEP_TICK_MINUTES` (default `15`; minimum 15)
- `FWA_TRACKED_CLAN_WARS_WATCH_TICK_MINUTES` (default `5`; minimum 5)

Sweep chunk controls:
- `FWA_WAR_MEMBERS_SWEEP_CHUNK_SIZE` (default `6`)
- `FWA_GLOBAL_CLAN_WARS_SWEEP_CHUNK_SIZE` (default `20`)

Request/concurrency controls:
- `FWA_FEED_REQUEST_TIMEOUT_MS` (default `5000`)
- `FWA_FEED_RETRY_COUNT` (default `1`)
- `FWA_FEED_MAX_CONCURRENCY` (default `4`)
- `FWA_FEED_JOB_JITTER_MS` (default `30000`)

Operational notes:
- Normal feed polling is bounded by source freshness (minimum 15 minutes).
- Tracked-clan `Wars.json` watch is the only 5-minute exception and only runs inside active watch windows.
- During tracked watch windows, tracked-clan `WarMembers.json?warNo=1` sync also refreshes the latest-only `FwaTrackedClanWarRosterCurrent` / `FwaTrackedClanWarRosterMemberCurrent` owners.
- Members polling uses tracked clans only.
- Global WarMembers / optional global Wars use cursor-based distributed sweeps from `FwaClanCatalog`.
- `HeatMapRef` is an explicit seed/import owner and is not refreshed by per-clan watch jobs.
- `/compo state mode:war` now reads persisted feed-backed tracked-clan roster state only; `/compo state mode:actual` and `/compo place` remain sheet-backed in this phase.

Manual/dev feed operations:
```bash
npm run sync:fwa-feeds -- status
npm run sync:fwa-feeds -- run --feed=clan-members --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run --feed=war-roster --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run-global --feed=clans
npm run sync:fwa-feeds -- watch-status --tag=#2QG2C08UP
npm run seed:heatmap-ref
```
