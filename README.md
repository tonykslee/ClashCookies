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
- Supports leadership-focused summaries such as inactivity and clan-health snapshots, including tracked-clan full reports with Home Roster, Inactive, Unlinked, Compo, Violations, War History, and Trends drilldowns. Home Roster is a read-only account/playerTag-level view: active Home periods reserve slots even while Away, Present/Away is derived only from fresh persisted current-roster coverage, and stale or unavailable coverage remains Unknown. View Transfers is an authorized, ephemeral review panel with Keep Home and Confirm Transfer actions; every decision is revalidated transactionally against guild and Home-clan scope. Keep Home leaves the current Home unchanged and requires three fresh qualifying syncs before another candidate, while Confirm Transfer preserves the old Home history and creates the successor Home period. Mirror mode remains read-only. Current unassigned occupants do not silently become Home, and pending transfers are otherwise annotated read-only. Omitted history uses the latest 30 sync numbers; explicit windows use days. War History reads persisted ended wars from the selected historical window, while Trends reads captured sync-boundary readiness history; external active FWA clan snapshots remain persisted-data views.
- Includes telemetry reporting and scheduled report delivery in Discord.

### Operational automation
- Polls and reconciles war-related state with explicit lifecycle ownership.
- Refreshes tracked war-mail posts and applies guarded reconciliation rules for missing/stale targets.
- Uses bounded feed-sync/watch loops for external data ingestion and update timing.
- Established Home accounts can receive a randomized, persisted pre-sync return DM when authoritative Home state is AWAY; UNKNOWN is suppressed, linked accounts for one user are grouped, exact sync timing is deliberately hidden, and normal replay is restart-safe/idempotent.
- Supports mirror-mode staging via guarded prod-to-staging runtime snapshot sync.
- Includes `npm run diagnose:membership-history-backfill`, a one-time strictly read-only historical evidence audit that executes the compiled `dist/scripts/auditMembershipHistoryBackfill.js` artifact. Production deploys build `dist` normally; for a local/manual checkout, run the normal build (`npm run build` or `yarn build`) first so the diagnostic does not run against a missing or stale artifact. It classifies recoverable guild/sync boundaries from persisted canonical owners, reports ambiguity and missing mappings, and prints diagnostic-only player streak and potential Home-tenure impact without writing data or consulting current-state tables as historical evidence.
- Exposes `/livez` and `/healthz` for liveness/readiness checks.

### Clan management tooling
- Manages tracked clan configuration, mail channels/roles, and war plans.
- Supports player-linking, autorole role/nickname sync, roster-related utilities, and operational helper commands, including guild-scoped default roster display columns via `/roster show`, `/roster set`, and `/roster reset`.
- Includes `/fillers` for marking linked player accounts as filler accounts and listing filler accounts by guild, linked user, or current clan.
- Includes `/accounts` and `/link list` rep-badge rendering from persisted `TrackedClanRep` + `TrackedClan.clanBadge` data, placing the clan badge before the TH icon in `/accounts` and replacing the linked checkmark in `/link list`. `/link list` also supports a derived, read-only `Tenure` column (`C` = active Home Clan Tenure, `S` = consecutive syncs physically in the current FWA clan, `A` = consecutive monitored-alliance syncs), plus persisted `Violations (30d)` analytics. Tenure counters are not persisted; temporary Away periods do not reset Clan Tenure, lower bounds use `+`, and no active Home leaves only C unavailable when physical streak evidence exists. `visibility:public` remains a shared, channel-visible roster where any server member can use the controls.
- Includes `/sync readiness` for posting the shared FWA readiness dashboard, `/sync retrospective` for a private-by-default persisted alliance summary with explicit coverage and ephemeral per-clan drilldowns, plus `/sync time post` for immediate sync announcements that also schedule the companion readiness dashboard 2 hours before sync.
- Provides FWA-focused tooling for points, match handling, layouts, and related workflows.
- Adds persisted CWL round tracking plus `/cwl activity`, `/cwl camping`, `/cwl members`, `/cwl rotations`, and CWL sheet import/export planner flows on top of seasonal CWL clan tracking. `/cwl activity` remains independent of membership intervals; `/cwl camping` is the DB-first, read-only observed-history report over persisted CWL timing/home attribution and `AllianceClanMembershipInterval`, with partial/unavailable coverage shown explicitly.

### Reliability and maintainability support
- Uses explicit data ownership boundaries across lifecycle/persistence tables.
- Includes force/repair commands for operational recovery without bypassing core state rules.
- Includes tracked-message lifecycle handling, telemetry rollups, and reminder schedulers as first-class runtime concerns.
- Maintains contributor documentation, setup guides, and script-based workflows.

## Detailed Capability Notes
- `/fwa match` and `/fwa mail send` share active-war mail freshness gating and only treat same-war, same-outcome references as up to date. Match parity is shown as unknown until exact same-war points evidence or unambiguous evidence-backed active-cycle evidence is available; unequal points still resolve normally while equal-point tie-breaks wait for parity. `/fwa match copy_paste:true` posts the compact copy view directly without buttons, and `/fwa match copy_paste:true checklist:true visibility:public` posts the reaction-driven checklist version.
- `/fwa police` includes canonical per-violation template management (`Custom -> Default -> Built-in`), warplan-aware applicability preview (`show`/`show-default`/`show-all`), and sample test-send (`DM`/`LOG`) through the same renderer used by live enforcement.
- `/warplan` and `/fwa compliance` share plan-aware compliance resolution: FWA WIN exposes the 3-star opening gate, FWA LOSE TRADITIONAL exposes the 2-star opening gate plus the 100-star cap, FWA LOSE TRIPLE_TOP_30 stays fixed, and BL/MM keep automated compliance disabled.
- `/fwa violations` player-history attack evidence shows each listed attack's persisted war-time remaining, and legacy or malformed evidence falls back to `unknown left`.
- Explicit Post to Channel buttons republish visible content and embeds without notifying users, roles, `@everyone`, or `@here`; copied mention tokens remain visible in the published message while notifications stay suppressed.
- `/fwa base-swap clan:<tag> [war-bases:<positions>] [base-errors:<groups>] [fwa-bases:<positions>] [swap-reminder:<true|false>]` posts the tracked base-swap acknowledgement flow. FWA posts containing `fwa-bases` show a live `## {n} / 50 war bases` progress line after the FWA-base note; it starts from the number of war bases not covered by the unique listed FWA-base positions and rises as affected members acknowledge, reaching `## 50 / 50 war bases` when all listed FWA bases are acknowledged. CWL posts and posts without `fwa-bases` do not show this line. `base-errors` can group positions with an optional note after the leading positions. Commas separate groups and cannot appear inside explanations; use semicolons or dashes instead if you need punctuation inside a note. The same note can apply to multiple positions in one group. Normal FWA affected-player DMs are automatic for linked, unacknowledged entries. `swap-reminder` controls the separate FWA battle-day reminder sent to the tracked clan's mail channel for `fwa-bases` posts, pings the tracked clan's configured `clanRoleId`, and defaults to true when `fwa-bases` is supplied for a tracked FWA clan. The original post keeps the usual TH layout links and DM copy lines, without any reminder section or custom role ping.
- Active-war mail lifecycle reconciliation handles missing/inaccessible tracked references and keeps lifecycle state aligned with usable message targets.
- `/force sync mail` validates supplied mail `message_id` against current-channel active-war identity before writing `WarMailLifecycle`.
- `/force mail update` reconciles tracked references before in-place refresh and resumes/stops refresh tracking based on validity.
- Match state rendering supports deterministic active-war inference and explicit confirmation persistence for BL/MM/FWA decisions.
- Sync validation uses war-scoped persisted snapshots (`ClanPointsSync`) with explicit force-sync paths for refresh-scrape operations.
- `/todo` renders from precomputed per-player snapshots (`TodoPlayerSnapshot`) so high-traffic reads stay fast and avoid live per-player multi-source aggregation on command execution, with grouped WAR/CWL sections, shared top timer for RAIDS, and phased GAMES rendering (active earning, latest-results reward collection through the full claim window, then post-reward lifetime totals) plus CWL context resolved from a seasonal CWL clan registry/player mapping layer instead of assuming home FWA clan. WAR battle-day FWA WIN clan headers show a DB-backed ⚠️ warning with the current clan star count while below 100★. The snapshot keeps current membership separate from event-owned WAR/RAID/CWL context, while GAMES keeps its lifecycle state but still uses current membership for clan ownership.
- CWL now has parallel persisted owners for live/prep rounds, ended round history, and planner state so `/todo cwl`, `/cwl activity`, and `/cwl ...` commands stay DB-first when persisted state exists. `/cwl activity` reads persisted activity and CWL history without external API calls; `/cwl camping` reads observed membership-duration history owned solely by `AllianceClanMembershipInterval`.
- `/reminders` now supports preview-first create/list/edit flows with FWA+CWL clan targeting, persisted reminder configs, and background scheduler dispatch with dedupe fire logs.
- Reminder deliveries now send plain-text Discord messages so inline user mentions actually notify, with whole-line overflow splitting capped at 3 messages.
- Unlinked tracked-clan member alerts use dedicated persistence instead of `BotSetting`, support one guild-level alert channel with tracked-clan log fallback, and expose `/unlinked list` for current unresolved FWA plus active CWL members.
- Staging mirror sync now includes the runtime-owned CWL round/history tables plus CWL planner tables so `/todo cwl` and `/cwl rotations` render consistently against mirrored prod data. CWL sheet import reads public published sheet URLs without Google Sheets credentials, while export uses writable Google Sheets auth.
- War-mail and match embeds use consistent effective-state color mapping for BL/MM/FWA/unresolved states.
- Notification and posting flows include operational logging controls (`/bot-logs`, `/say`, telemetry report + schedule commands).
- `/bot-logs type:clan-goals` configures live-war, canonical war-end, and scheduled-sync clan-goal notification routing with clan-log, clan-lead, generic bot-log, custom, or disabled destinations; it defaults to disabled and only uses `channel` for custom routing. Goal notifications remain non-pinging. Scheduled-sync zero-deviation eligibility is captured from immutable ACTUAL readiness snapshots at the sync boundary and delivered with sync-scoped idempotency.
- `/bot-logs type:sync-retrospective channel:<channel>` or `enable:bot-log channel` enables automatic public retrospective output after every `ClanPointsSync` participant has a canonical ended war. It is disabled by default, does not backfill syncs completed before enablement, and uses the same summary/dropdowns as manual `/sync retrospective`; `enable:false` disables it.
- FWA stats and operations commands include persisted `/fwa weight-age` and `/fwa weight-health` reads from `FwaClanCatalog.weightSubmitDate` populated by the FWAStats `Clans.json` feed, plus compliance checks and layout management. These commands no longer scrape the HTML weight page or require cookie authentication; `/fwa weight-cookie` was removed, while `/fwa weight-link` remains unchanged.
- `/potion calc type:<builder|research|pet|clocktower> time-left:<duration> num-pots:<1-100> [boost-remaining:<duration>]` statelessly estimates upgrade completion timing for builder, research, pet, and clock tower potion boosts; `boost-remaining` accounts for real-world time left on an already-active boost.
- FWAStats feed ingestion is DB-backed (`FwaFeedSyncState`, `FwaClanWarsWatchState`, related current-state tables) with bounded scheduler cadence.
- Autorole can apply Discord roles and ClashPerk-style nicknames from linked accounts, permanent FWA tracked-clan membership, and guild-managed autorole rules.

## Quick Start
```bash
npm install
npx prisma migrate deploy
npm run build
npm start
```

## Deployment Model
Production and staging currently run on a droplet-based container deployment.

Production uses `POLLING_MODE=active` and owns upstream pollers/schedulers. Staging uses `POLLING_MODE=mirror` with guarded prod-to-staging runtime snapshot sync so it can stay operational without duplicating upstream polling. Near-zero-downtime deploy behavior, Prisma migration downtime handling, and health-gated promotion are documented in [Deployment and Install Links](docs/deployment.md). Health endpoints are built into the app, and the droplet observability stack is documented in [Observability](docs/observability.md).

## Documentation
- [Setup and Environment](docs/setup.md)
- [Commands Reference](docs/commands.md)
- [Command Access and Permissions](docs/permissions.md)
- [Deployment and Install Links](docs/deployment.md)
- [Observability](docs/observability.md)

## Autorole Nickname Templates
Autorole nickname sync can render Discord nicknames from linked Clash accounts during `/autorole refresh`. The recommended ClashPerk-style template is:

```text
{player} | {trackedClans}
```

Example rendered nicknames:

```text
Elrond ♣️ | RR
Elrond ♣️ | RR | GB | RD | SE | TWC
```

Enable it with:

```text
/autorole config set apply_nicknames:true nickname_template:"{player} | {trackedClans}"
```

Supported tokens are `{player}`, `{tag}`, `{th}`, `{clan}`, `{clanTag}`, `{clanShort}`, `{trackedClans}`, `{discord}`, `{username}`, and `{role}`. `{trackedClans}` includes distinct permanent FWA tracked-clan short names from eligible linked accounts, de-duped with the primary account clan first. Nicknames are cleaned up when tokens are missing and capped to Discord's 32-character nickname limit. Unicode emoji can render in nicknames; custom Discord emoji markup does not render in nicknames.

Nickname exclusion roles are configured with `/autorole config set nickname_exclude_role:"<@&123456789012345678>, 234567890123456789"`. The list is replaced each time, and `none` or `clear` as the sole value removes every saved exclusion role. Members with a nickname exclusion role keep normal autorole role reconciliation, but nickname template rendering is skipped; stale tracked-clan suffixes are cleaned on the next scheduled or manual `/autorole refresh`.

The bot needs Discord **Manage Nicknames** and must be above the target member in role hierarchy to change nicknames. Role application still requires **Manage Roles** and role hierarchy above the managed roles. Tracked clan roles imply the family role, and either a clan role or the family role suppresses the visitor/non-member role.

## Development
See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and architecture documentation.
FWA command internals are split under `src/commands/fwa/` helper modules to keep `Fwa.ts` orchestration-focused and unit-testable.
Run `npm run seed:fwa-layouts` after migrations when you want to upsert the canonical layout seed rows.
Droplet deploys use cached Yarn dependency volumes and only rerun locked installs when `package.json` or `yarn.lock` changes. The current container path uses `ops/deploy/container-start.sh`, which runs the dependency guard and then starts the app, while `yarn start` rebuilds from `src` before launching the compiled app.

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
- The active 30-minute activity-observe cycle reconciles linked-player `PlayerCurrent` state: tracked-clan departures are immediate, stale external/clanless/unknown rows use a 60-minute freshness gate, and no more than 100 extra linked-player refreshes run per cycle; current tracked members are not fetched twice.
- tracked-clan `Wars.json` watch: 5-minute cadence only inside active per-clan windows, starts 5 minutes before sync time, stops once update is acquired
- optional global `Wars.json` sweep: disabled by default, configurable and chunked
- command paths remain DB-first; `/compo state mode:war`, `/compo state mode:actual`, and `/compo place` now read persisted feed-backed state instead of relying on hot-path sheet reads
- `/compo place` now includes an explicit in-message refresh button that refreshes ACTUAL tracked-clan current-member/weight state plus live CoC member counts before rerendering from persisted data
- `/compo place` replacement suggestions include active, linked, non-filler accounts from surplus ACTUAL Auto-Detect display buckets, with the surplus bucket and delta shown in the drill-down; `Show replacements` defaults to a prioritized shortlist and can filter by clan, replacement type, or 30-day violation count, while `All` exposes healthy surplus/unlinked candidates
- `/compo state mode:actual` keeps its in-message refresh button and now refreshes ACTUAL tracked-clan current-member/weight state plus live CoC member counts before rerendering from persisted data

Manual/dev operations (script tooling):
```bash
npm run sync:fwa-feeds -- status
npm run sync:fwa-feeds -- run --feed=clan-members --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run --feed=clan-wars --tag=#2QG2C08UP
npm run sync:fwa-feeds -- run-global --feed=clans
npm run sync:fwa-feeds -- run-global --feed=war-members
npm run sync:fwa-feeds -- watch-status --tag=#2QG2C08UP
```
