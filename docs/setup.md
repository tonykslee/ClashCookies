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
