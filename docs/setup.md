# Setup

## Base Setup
1. Create a `.env` with required Discord, CoC API, and database values.
2. Install dependencies.
3. Run migrations.
4. Build and start.

```bash
npm install
npx prisma migrate deploy
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
- `/accounts` backfills `PlayerLink` from ClashKing when local links are missing for the target user.
- Activity observe loop checks unresolved tracked-member links via ClashKing at most once every 6 hours and caches matches in `PlayerLink`.

## Optional War Event Poll Setting
- `WAR_EVENT_LOG_POLL_INTERVAL_MINUTES` - interval for war-state event listener polling (default: `5` minutes).

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
- Refresh token scope: `https://www.googleapis.com/auth/spreadsheets.readonly`.
- The Google account tied to the refresh token must have access to the sheet.
- Viewer access is enough.

Optional fallback auth (not required for current setup):
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
