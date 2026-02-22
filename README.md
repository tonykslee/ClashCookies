# ClashCookies
Discord bot for Clash of Clans activity tooling.

## What It Does
- Tracks configured clans and updates player activity records.
- Supports last seen and inactivity queries.
- Manages tracked clans at runtime (`/tracked-clan ...`).
- Links to a Google Sheet at runtime (`/sheet ...`).
- Supports mode-specific sheet links for `actual` and `war` roster workflows.

## Setup
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

Optional owner bypass:
- `OWNER_DISCORD_USER_ID` - single Discord user ID with full command access override in all guilds.
- `OWNER_DISCORD_USER_IDS` - comma-separated list of Discord user IDs with full override.

## Google Sheets (OAuth)
This project is currently set up to use OAuth refresh token auth.

Required env vars:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

Notes:
- The refresh token should be minted with scope: `https://www.googleapis.com/auth/spreadsheets.readonly`.
- The Google account tied to the refresh token must have access to the sheet.
- Viewer access is enough.

Optional fallback auth (not required for your current setup):
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## Commands
- `/help` - List available commands.
- `/permission add command:<name> role:<discordRole> [role2] [role3] [role4] [role5]` - Allow one or more roles to use a command.
- `/permission remove command:<name> role:<discordRole>` - Remove a role from a command whitelist.
- `/permission list [command:<name>]` - List role policy for one command target, or all if omitted.
- `/clan-name tag:<tag>` - Get clan name by tag.
- `/lastseen tag:<playerTag>` - Show a player's last seen activity.
- `/inactive days:<number>` - List players inactive for N days.
- `/role-users role:<discordRole>` - List users in a role with pagination.
- `/tracked-clan add tag:<tag>` - Add tracked clan.
- `/tracked-clan remove tag:<tag>` - Remove tracked clan.
- `/tracked-clan list` - List tracked clans.
- `/sheet link sheet_id_or_url:<id-or-url> [tab:<tab-name>] [mode:actual|war]` - Link or relink sheet; mode is optional.
- `/sheet show [mode:actual|war]` - Show linked sheet settings (single mode or all).
- `/sheet unlink [mode:actual|war]` - Remove one mode link or all links.
- `/sheet refresh mode:actual|war` - Trigger mode-specific Apps Script raw feed refresh.
- `/compo advice clan:<tracked-clan> [mode:actual|war]` - Pull advice using mode-specific sheet link.
- `/compo state [mode:actual|war]` - Render AllianceDashboard state as an attached PNG image with mode label.
- `/compo place weight:<value>` - Suggest placement options from ACTUAL state (vacancy + composition fit). Accepts formats like `145000`, `145,000`, or `145k` and maps to TH weight buckets.
- `/cc player tag:<tag>` - Build `https://cc.fwafarm.com/cc_n/member.php?tag=<tag>`.
- `/cc clan tag:<tag>` - Build `https://cc.fwafarm.com/cc_n/clan.php?tag=<tag>`.
- `/post sync time [role:<discordRole>]` - Open modal, compose sync-time message, post it, and pin it.

## Command Access Control
- By default, commands are usable by everyone.
- Default Administrator-only targets:
  - `/tracked-clan add`, `/tracked-clan remove`
  - `/permission add`, `/permission remove`
  - `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
  - `/post sync time`
- You can whitelist roles per command with `/permission add`.
- Administrator users can always use commands regardless of role whitelist.
- To lock `/post` to role X, run:
  - `/permission add command:post role:@RoleX`

## Deployment Notes
- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.

## Install Links
Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
