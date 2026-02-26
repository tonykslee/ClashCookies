# ClashCookies
Discord bot for Clash of Clans activity tooling.

## What It Does
- Tracks configured clans and updates player activity records.
- Supports last seen and inactivity queries.
- Manages tracked clans at runtime (`/tracked-clan ...`).
- Links to a Google Sheet at runtime (`/sheet ...`).
- Supports mode-specific sheet links for `actual` and `war` roster workflows.
- Fetches FWA points balances and matchup projections (`/fwa ...`).

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

Optional ClashKing link lookup (kick-list fallback when local links are missing):
- `CLASHKING_LINKS_URL_TEMPLATE` - ClashKing links endpoint URL (supports either fixed `POST /discord_links` or a `{tag}` URL template).
- `CLASHKING_API_TOKEN` - bearer token for private ClashKing API (if required).
- Bot behavior:
  - `/accounts` backfills `PlayerLink` from ClashKing when local links are missing for the target user.
  - Activity observe loop checks unresolved tracked-member links via ClashKing at most once every 6 hours and caches matches in `PlayerLink`.

Optional war event log poll setting:
- `WAR_EVENT_LOG_POLL_INTERVAL_MINUTES` - interval for war-state event listener polling (default: `5` minutes).

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
- `/help [command:<name>] [visibility:private|public]` - List command docs/examples. Default visibility is private.
- `/permission add command:<name> role:<discordRole> [role2] [role3] [role4] [role5]` - Allow one or more roles to use a command.
- `/permission remove command:<name> role:<discordRole>` - Remove a role from a command whitelist.
- `/permission list [command:<name>]` - List role policy for one command target, or all if omitted.
- `/lastseen tag:<playerTag>` - Show a player's last seen activity, with drill-down button for tracked signal timestamps.
- `/inactive days:<number>` - List players inactive for N days.
- `/inactive wars:<number>` - List tracked-clan members who used 0/2 attacks in each of the last N ended wars (requires war-history tracking window).
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
- `/opponent tag:<tag>` - Get current war opponent clan tag from CoC API (without `#`).
- `/enable event logs clan:<tag> target-channel:<channel>` - Enable war-state event logs (war start, battle day, war end) for a clan in a selected channel.
- `/accounts [visibility:private|public] [tag:<playerTag>] [discord-id:<snowflake>]` - List linked player accounts grouped by current clan. Default is your own account; provide exactly one of `tag` or `discord-id` to inspect a different linked user.
- `/fwa points [visibility:private|public] [tag:<tag>]` - Fetch current point balance from `https://points.fwafarm.com/clan?tag=<tag-without-#>`. If `tag` is omitted, fetches all tracked clans.
- `/fwa match [visibility:private|public] tag:<tag>` - Resolve current war opponent from CoC API, then return projected win/lose by points (or sync-based tiebreak on tie).
- `/recruitment show platform:discord|reddit|band clan:<tag>` - Render platform-specific recruitment template output for a tracked clan.
- `/recruitment edit platform:discord|reddit|band clan:<tag>` - Open platform-specific modal:
  - Discord: clan tag, body (max 1024), optional image URL(s)
  - Band: body, optional image URL(s)
  - Reddit: subject (`[Recruiting] Name of Clan | #ClanTag | Required TH/Level | Clan Level | FWA | Discord`) auto-prefilled from in-game TH minimum and clan level, body (markdown), optional image URL(s)
- `/recruitment countdown start platform:discord|reddit|band clan:<tag>` - Start exact cooldown timer for your account on that platform+clan pair.
- `/recruitment countdown status` - Show your current recruitment cooldown timers.
- `/recruitment dashboard` - Show readiness across all tracked clans/platforms for your account.
- `/kick-list build [days:<number>]` - Auto-build kick-list candidates from tracked-clan members who are inactive (`days` threshold, default `3`), unlinked, or linked to users not in this server. Players matching both inactivity and link issues are shown first.
- `/kick-list add tag:<playerTag> reason:<text>` - Manually add a kick-list candidate with reason.
- `/kick-list remove tag:<playerTag>` - Remove a player from kick list.
- `/kick-list show` - Show current kick-list with reasons.
- `/kick-list clear [mode:all|auto|manual]` - Clear kick-list entries.
- `/post sync time [role:<discordRole>]` - Open modal, compose sync-time message, post it, and pin it.
- `/post sync status [message-id:<id>]` - Show claimed vs unclaimed clan badge reactions for the active sync-time post, or for a specific message in the channel.

## Command Access Control
- By default, commands are usable by everyone.
- Default Administrator-only targets:
  - `/tracked-clan add`, `/tracked-clan remove`
  - `/permission add`, `/permission remove`
  - `/sheet link`, `/sheet unlink`, `/sheet show`, `/sheet refresh`
  - `/kick-list build`, `/kick-list add`, `/kick-list remove`, `/kick-list show`, `/kick-list clear`
  - `/post sync time`
  - `/enable event logs`
- You can whitelist roles per command with `/permission add`.
- Administrator users can always use commands regardless of role whitelist.
- To lock `/post` to role X, run:
  - `/permission add command:post role:@RoleX`
- To lock `/fwa` to role X, run:
  - `/permission add command:fwa role:@RoleX`
- To lock `/recruitment` to role X, run:
  - `/permission add command:recruitment role:@RoleX`
- To lock `/enable` to role X, run:
  - `/permission add command:enable role:@RoleX`

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
