import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import { Commands } from "../Commands";
import { formatError } from "../helper/formatError";

const OVERVIEW_PAGE_SIZE = 4;
const HELP_TIMEOUT_MS = 10 * 60 * 1000;
const HELP_POST_BUTTON_PREFIX = "help-post-channel";
const ADMIN_DEFAULT_TARGETS = new Set<string>([
  "tracked-clan:configure",
  "tracked-clan:cwl-tags",
  "tracked-clan:remove",
  "reminders",
  "reminders:create",
  "reminders:list",
  "reminders:edit",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "sheet:refresh",
  "kick-list",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "kick-list:clear",
  "sync:time:post",
  "bot-logs",
  "notify:war",
  "link:embed",
  "link:create:admin",
  "link:delete:admin",
  "permission:add",
  "permission:remove",
  "telemetry",
  "cwl:rotations:create",
  "cwl:rotations:import",
  "cwl:rotations:export",
]);

type CommandDoc = {
  summary: string;
  details: string[];
  examples: string[];
};

type HelpOption = {
  name: string;
  type: ApplicationCommandOptionType;
  required?: boolean;
  options?: HelpOption[];
};

const COMMAND_DOCS: Record<string, CommandDoc> = {
  help: {
    summary: "Browse command docs and examples.",
    details: [
      "Use pages for a quick command overview.",
      "Select any command to drill into syntax and example flows.",
      "Set `visibility:public` to post the help response directly in channel.",
    ],
    examples: ["/help", "/help command:sheet", "/help visibility:public"],
  },
  emoji: {
    summary: "Resolve or browse bot-owned application emojis by shortcode name.",
    details: [
      "Use `/emoji name:<emoji_name>` to resolve one emoji and show rendered + raw token output.",
      "Use `/emoji name:<emoji_name> react:<message-id>` to react to a message in the current channel with that resolved emoji.",
      "Use `/emoji emoji:<emoji-token-or-url> short-code:<name>` to add one new bot application emoji (admin-only by default).",
      "Use `/emoji` with no args to browse a paginated list of all available bot application emojis.",
      "No-arg list pages are capped to ~2500 characters of emoji-entry content and shown in compact row-wise 3 columns sorted by shortcode length.",
      "For name-only resolves, `visibility:public` returns only the rendered emoji message content.",
      "`name` supports dynamic autocomplete backed by application emojis for this bot instance.",
      "Emoji resolution is environment-safe by name (application emoji IDs may differ per bot instance).",
    ],
    examples: [
      "/emoji",
      "/emoji name:arrow_arrow",
      "/emoji name::arrow_arrow:",
      "/emoji name:arrow_arrow react:123456789012345678",
      "/emoji emoji:<:arrow_arrow:123456789012345678> short-code:arrow_arrow",
    ],
  },
  lastseen: {
    summary: "Estimate when a player was last active.",
    details: [
      "Reads stored activity first, then infers from live profile stats.",
      "Includes an Activity Breakdown button with localized timestamps for tracked signals.",
      "Stores inference for faster future lookups.",
    ],
    examples: ["/lastseen tag:ABC123XYZ"],
  },
  inactive: {
    summary: "List players inactive for a given number of days.",
    details: [
      "Shows oldest inactive players first.",
      "Supports `wars` mode to list tracked members who used 0/2 attacks in each of the last X ended wars.",
      "Large results are clipped to keep replies readable.",
    ],
    examples: ["/inactive days:7", "/inactive days:30", "/inactive wars:3"],
  },
  "clan-health": {
    summary:
      "Leadership snapshot for one tracked clan using persisted data only.",
    details: [
      "Shows match rate and win rate from the last 30 ended wars.",
      "Shows inactivity counts from two signals: missed both attacks in last 3 ended FWA wars, and last-seen inactivity >= 7 days.",
      "Shows missing Discord links among observed clan members updated within the configured stale window.",
      "Command path is DB-only (no live CoC/points HTTP calls).",
    ],
    examples: [
      "/clan-health tag:2QG2C08UP",
      "/clan-health tag:2QG2C08UP visibility:public",
    ],
  },
  "role-users": {
    summary: "Show members in a role with paging controls.",
    details: [
      "Supports in-message pagination for large roles.",
      "Includes a print action to dump all pages in channel.",
    ],
    examples: ["/role-users role:@Leaders"],
  },
  layout: {
    summary: "Fetch, list, and admin-update stored FWA base layout links.",
    details: [
      "Use `/layout` with no args to browse paginated embeds (RISINGDAWN, BASIC, ICE).",
      "`th` fetches one Town Hall layout; omitted `type` defaults to `RISINGDAWN`.",
      "All returned layout links are wrapped in `< >` to suppress Discord auto-embeds.",
      "Including `edit` performs an admin-only upsert by Town Hall + type.",
      "`img-url` is optional and only valid when `edit` is also provided.",
    ],
    examples: [
      "/layout",
      "/layout th:12",
      "/layout th:12 type:ICE",
      "/layout th:12 edit:https://link.clashofclans.com/en?action=OpenLayout&id=TH12...",
      "/layout th:12 type:RISINGDAWN edit:https://link.clashofclans.com/en?action=OpenLayout&id=TH12... img-url:https://i.imgur.com/example.png",
    ],
  },
  "tracked-clan": {
    summary: "Manage tracked clans used by activity features.",
    details: [
      "Configure/remove tracked clans or list current tracked set.",
      "`configure` upserts tracked clan settings (lose-style, mail channel, log channel, clan role, clan badge emoji, short name).",
      "`cwl-tags` adds one seasonal CWL throwaway clan batch (array-style or comma-separated tags) without polluting the FWA tracked list.",
      "`list type:FWA|CWL` switches between permanent FWA tracked clans (default) and seasonal CWL registry.",
      "`remove` supports deterministic FWA/CWL deletion; when a tag exists in both registries, pass `type` explicitly.",
      "`configure`, `cwl-tags`, and `remove` are admin-only by default.",
    ],
    examples: [
      "/tracked-clan configure tag:#2QG2C08UP",
      "/tracked-clan configure tag:#2QG2C08UP lose-style:Traditional mail-channel:#war-mail",
      "/tracked-clan configure tag:#2QG2C08UP clan-badge::Logo_Gabbar:",
      "/tracked-clan configure tag:#2QG2C08UP short-name:GB",
      "/tracked-clan cwl-tags cwl-tags:[#PYLQ0289,#QGRJ2222]",
      "/tracked-clan list type:CWL",
      "/tracked-clan remove tag:#2QG2C08UP type:FWA",
      "/tracked-clan list",
    ],
  },
  sheet: {
    summary: "Link and manage Google Sheet settings.",
    details: [
      "Uses one linked Google Sheet for both ACTUAL/WAR data modes.",
      "Refresh triggers a shared Apps Script webhook and can target ACTUAL or WAR mode (disabled when POLLING_MODE=mirror).",
      "`link`, `unlink`, `show`, and `refresh` are admin-only by default.",
    ],
    examples: [
      "/sheet link sheet_id_or_url:https://docs.google.com/...",
      "/sheet show",
      "/sheet refresh mode:actual",
    ],
  },
  compo: {
    summary: "Composition tools with DB-backed WAR state and ACTUAL-backed advice/place flows.",
    details: [
      "`advice`: fetch clan-specific adjustment notes from the existing sheet-backed flow.",
      "`state`: `mode:war` renders from persisted tracked-clan feed state only, while `mode:actual` remains on the AllianceDashboard sheet path.",
      "`state` refresh: `mode:war` refreshes tracked-clan war-roster feed state only and rerenders from DB; `mode:actual` still uses the shared sheet-refresh flow.",
      "`place`: suggest placement by war weight from persisted ACTUAL FWAStats current-member state (`TrackedClan` + `FwaClanMemberCurrent` + `HeatMapRef`) with deferred-weight and WAR-effective-weight fallback only for zero-weight member rows.",
    ],
    examples: [
      "/compo advice tag:#2QG2C08UP mode:actual",
      "/compo state mode:war",
      "/compo place weight:145k",
    ],
  },
  cc: {
    summary: "Build ClashChamps URLs for clans or players.",
    details: [
      "Tag accepts values with or without `#`.",
      "`clan` subcommand supports autocomplete from tracked clans.",
    ],
    examples: ["/cc player tag:ABCD1234", "/cc clan tag:2QG2C08UP"],
  },
  notify: {
    summary: "Configure notification features.",
    details: [
      "`war` enables war-state event embeds for a clan in a selected channel.",
      "`show` lists notify routing (channel/role/status) for tracked clans, optionally filtered by tag.",
      "`toggle` turns `war embed` or `ping` on/off for an existing clan subscription.",
      "Optional `role` pings that role whenever a war event embed is posted.",
      "Works with clans outside tracked-clans table (tag must still be valid in CoC API).",
      "Posts at war start, battle day, and war end with opponent + points projection.",
    ],
    examples: [
      "/notify war clan-tag:2QG2C08UP target-channel:#war-events role:@Leaders",
      "/notify war clan-tag:2QG2C08UP target-channel:#new-war-events",
      "/notify toggle clan-tag:2QG2C08UP target:war embed toggle:off",
      "/notify toggle clan-tag:2QG2C08UP target:ping toggle:on",
      "/notify war-preview clan-tag:2QG2C08UP event:battle day start source:current",
      "/notify show",
      "/notify show clan-tag:2QG2C08UP",
    ],
  },
  war: {
    summary:
      "Query clan-level war history and export war attack payload by war ID.",
    details: [
      "`/war history` shows recent clan-level war summary rows from ClanWarHistory.",
      "`/war war-id` exports the stored WarLookup payload as a CSV file for drill-down review.",
      "Use war IDs returned from `/war history` to retrieve detailed attack rows.",
      "`clan-tag` supports autocomplete from tracked clans.",
      "After selecting a tracked `clan-tag`, `war-id` supports autocomplete for recent ended wars scoped to that clan (deterministic top 10).",
    ],
    examples: [
      "/war history clan-tag:2QG2C08UP",
      "/war history clan-tag:2QG2C08UP limit:25",
      "/war war-id clan-tag:2QG2C08UP war-id:1000001",
    ],
  },
  cwl: {
    summary: "Inspect persisted CWL roster, current round state, and planner output.",
    details: [
      "`/cwl members clan:<tag>` shows the observed current-season CWL roster for one tracked CWL clan using persisted round observations only.",
      "`/cwl members clan:<tag> inwar:true` narrows to the persisted current/prep lineup and includes current round status when available.",
      "`/cwl rotations show` renders an interactive overview of active CWL plans with status, next battle-day timing, current-clan leadership summary, and a dropdown to open the detailed clan view; the clan page supports paging and manual refresh of that clan's actual CWL state.",
      "`/cwl rotations create` is admin-only by default and only works during persisted CWL preparation state for the tracked clan.",
      "`/cwl rotations import` is admin-only by default and imports active planner tabs from one public Google Sheet after a confirmation preview and clan-by-clan row-review step. Structural rows may be skipped automatically, but player-like rows are never dropped silently. Public imports do not require Google Sheets credentials; export/write still does.",
      "`/cwl rotations export` is admin-only by default and writes the active planner data to a brand-new public Google Sheet using the canonical re-importable tabular format.",
      "The `/cwl` surface is DB-first and does not live-query broad CWL state on render when persisted state exists.",
    ],
    examples: [
      "/cwl members clan:#2QG2C08UP",
      "/cwl members clan:#2QG2C08UP inwar:true",
      "/cwl rotations show",
      "/cwl rotations show clan:#2QG2C08UP day:3",
      "/cwl rotations create clan:#2QG2C08UP exclude:#PYLQ0289,#QGRJ2222 overwrite:true",
      "/cwl rotations import sheet:https://docs.google.com/spreadsheets/d/... overwrite:true",
      "/cwl rotations export",
    ],
  },
  warplan: {
    summary: "Manage clan custom war plans and editable guild defaults.",
    details: [
      "`clan-tag` supports autocomplete from tracked clans.",
      "`set` and `set-default` now open a modal editor (pre-filled with current plan if set, otherwise default).",
      "Match-type options are explicit set selectors: `BL`, `MM`, `FWA`, `FWA_WIN`, `FWA_LOSE_TRIPLE_TOP_30`, `FWA_LOSE_TRADITIONAL`.",
      "This removes invalid option paths (no outcome/lose-style controls for BL/MM or FWA-WIN).",
      "Modal formatting tips: `**bold**`, `*italic*`, `` `code` ``, and code blocks with triple backticks.",
      "Custom/default plans support `{opponent}` placeholder and replace it with opponent clan name.",
      "Warplan modal also supports optional compliance settings: `minimum clan stars before tripling non-mirror` and `all bases open for 3 star time-left` (`H` or `Hh`, range `0..24`). These two inputs are prefilled from the effective config for the selected set (custom -> editable default -> built-in fallback defaults).",
      "These compliance settings are resolved with the same precedence (custom -> editable default -> fallback defaults) and are applied by `/fwa compliance` only for effective `FWA_WIN` checks.",
      "Precedence: clan custom -> editable guild default -> built-in fallback.",
    ],
    examples: [
      "/warplan set clan-tag:2QG2C08UP match-type:BL",
      "/warplan set clan-tag:2QG2C08UP match-type:FWA_WIN",
      "/warplan set clan-tag:2QG2C08UP match-type:FWA_LOSE_TRIPLE_TOP_30",
      "/warplan show clan-tag:2QG2C08UP",
      "/warplan reset clan-tag:2QG2C08UP",
      "/warplan set-default match-type:BL",
      "/warplan show-default",
      "/warplan reset-default match-type:FWA_LOSE_TRADITIONAL",
    ],
  },
  accounts: {
    summary: "List linked player accounts grouped by their current clan.",
    details: [
      "Default behavior lists accounts linked to your Discord account.",
      "If `discord-id` is provided, lists accounts for that user.",
      "If `tag` is provided, resolves linked Discord ID from local PlayerLink, then lists that user's accounts.",
      "Only one of `tag` or `discord-id` can be provided.",
      "Runtime link resolution is local-only from `PlayerLink`.",
      "Account display uses persisted local data only.",
      "Set `visibility:public` to post the response directly in channel.",
    ],
    examples: [
      "/accounts",
      "/accounts discord-id:143827744717799425",
      "/accounts tag:G2RG9JCRL",
      "/accounts visibility:public",
    ],
  },
  todo: {
    summary: "Show todo progress across all of your linked player tags.",
    details: [
      "Resolves all player tags linked to your Discord account from local PlayerLink data.",
      "Reads precomputed todo snapshots (background-refreshed) for fast command-time rendering.",
      "The first `/todo` use for a Discord user may take longer while their snapshots are loaded on demand.",
      "Always builds WAR, CWL, RAIDS, and GAMES pages in one response.",
      "CWL todo snapshots can include linked players outside tracked clans after the first CWL refresh hydrates their CWL context, and that first run may take a bit longer.",
      "With no `type`, opens your most recently viewed todo page; if none is remembered, defaults to WAR.",
      "`type` controls only the initial page shown; use page buttons to switch categories without rerunning.",
      "Running `/todo type:...` and switching pages via buttons updates your remembered page for future no-arg `/todo` runs.",
      "Use the refresh button to trigger a targeted snapshot rebuild for the displayed todo user and update the same message in place.",
      "WAR/CWL pages group players by shared active event context and include section headers with phase timing.",
      "WAR section headers include tracked clan badge + match-state indicator, and WAR rows show lineup position with compact used-attack detail.",
      "RAIDS page uses one shared top timer line and then lists per-player progress rows.",
      "GAMES page points come from stored activity-signal totals, with cycle baseline/total observability persisted on TodoPlayerSnapshot for DB-first reads.",
      "GAMES has three snapshot-backed views: active earning (time remaining), reward collection through the full in-game claim window (latest final points + reward time remaining), and post-reward off-cycle lifetime totals.",
      "GAMES rows use progress indicators: `🟡` (>0), `✅` (>=4000), and `🏆` (>=10000).",
      "When a page has no active context, it renders explicit inactive text instead of a blank list.",
      "Linked players outside active contexts are still shown as neutral rows when active groups exist.",
      "If you have no linked tags, the command returns a clear private error and suggests `/link create`.",
    ],
    examples: [
      "/todo",
      "/todo type:WAR",
      "/todo type:CWL",
      "/todo type:RAIDS",
      "/todo type:GAMES",
    ],
  },
  reminders: {
    summary: "Create, list, and edit scheduled reminder configs by clan scope.",
    details: [
      "`create` opens a preview-first admin panel with type, time offsets, channel, and selected clans; running with no args starts as a blank setup.",
      "`create clan:<tag>` seeds the selected clan in create-state and, when channel is unset, prefills from that tracked clan's configured `log-channel`.",
      "In create-state, the first clan-dropdown selection can auto-prefill channel from tracked clan `log-channel` when channel is empty; existing channel values are never overwritten.",
      "Clan selector combines both FWA tracked clans and current-season CWL tracked clans in one multi-select.",
      "`list` shows scan-friendly reminder rows with type/channel/offsets/target-count/enabled state.",
      "`edit clan:<tag>` resolves reminder configs targeting that normalized clan tag and opens the same panel flow.",
      "Scheduler evaluation and delivery run in background loops with fire-log dedupe safeguards.",
      "Default access is admin-only unless role policy is changed with `/permission add`.",
    ],
    examples: [
      "/reminders create",
      "/reminders create clan:#PQL0289",
      "/reminders create type:WAR_CWL time_left:1h channel:#war-reminders",
      "/reminders create type:RAIDS time_left:30m,1h channel:#raid-reminders",
      "/reminders list",
      "/reminders edit clan:#2QG2C08UP",
    ],
  },
  remindme: {
    summary:
      "Configure recurring personal activity reminders and manage recruitment reminders.",
    details: [
      "`set` creates one rule per `(type, linked player tag, method, offset)` and stores reminders durably for future event cycles.",
      "`player_tags` only accepts tags linked to your Discord account (autocomplete + server-side validation).",
      "`time_left` accepts one or more `HhMm` offsets (comma-separated), for example `12h,2h,30m`.",
      "`method` defaults to `DM`; `ping-me-here` stores the invoking channel as routing surface.",
      "`list` shows activity reminders plus recruitment reminders in separate scan-friendly sections.",
      "`remove` opens an owner-scoped multi-select panel with confirm/cancel controls for both activity and recruitment reminders.",
    ],
    examples: [
      "/remindme set type:WAR player_tags:#PYLQ0289 time_left:12h,2h",
      "/remindme set type:RAIDS player_tags:#PYLQ0289,#QGRJ2222 time_left:30m method:ping-me-here",
      "/remindme list",
      "/remindme remove",
    ],
  },
  link: {
    summary: "Manage local Discord-player links using PlayerLink.",
    details: [
      "`create` links one or more player tags to your Discord account when the tags are currently unlinked.",
      "`create` with `user` uses the Discord user picker and can create a link for another Discord user when unlinked for admins and FWA Leaders.",
      "Existing links are never implicitly reassigned; delete-first is required before relinking to another user.",
      "`delete` removes a link when run by the linked user or an admin override target.",
      "`list` renders non-zero linked/unlinked count buckets with padded inline rows: linked rows start with a resolved `yes` status emoji and show `TH ServerDisplayName Player Wt`, unlinked rows start with a resolved `no` status emoji and show `TH #PLAYER_TAG Player Wt`.",
      "Weight (`Wt`) comes from `FwaClanMemberCurrent.weight` and is shown as compact lowercase `k` text (for example `145k`), with `—` when missing.",
      "If `Wt` resolves to `0` and an open deferred weight exists for the same normalized player tag, `/link list` shows that deferred weight and appends a right-side `⏳` marker for that row.",
      "`embed` is admin-gated and posts a reusable self-service Link Account embed with button + modal flow.",
      "`list` includes a tracked-clan dropdown and a sort-cycle button (`Discord Name -> Weight Desc -> Player Tags -> Player Name`) and updates the same message in place.",
      "`list` shows active sort mode in the embed footer.",
      "`sync-clashperk` is admin-gated and imports missing local PlayerLink rows from a public Google Sheet with ClashPerk-style columns.",
    ],
    examples: [
      "/link create player-tag:#ABC123,#DEF456",
      "/link create player-tag:#ABC123 user:@SomeUser",
      "/link delete player-tag:#ABC123",
      "/link list clan-tag:2QG2C08UP",
      "/link embed channel:#link-account",
      "/link sync-clashperk sheet-url:https://docs.google.com/spreadsheets/d/...",
    ],
  },
  fwa: {
    summary: "FWA points and matchup tools.",
    details: [
      "`/fwa points` returns point balances (single clan tag or all tracked if tag omitted).",
      "`/fwa match` auto-resolves current war opponent from CoC API and evaluates win/lose/tiebreak using cached points + persisted sync state.",
      "`/fwa base-swap` posts a tracked acknowledgment message for war-base/base-error positions, includes deduped TH-specific `RISINGDAWN` layout links for listed players, and DMs the invoker copy/paste in-game ping lines (active-war + TH-grouped base errors). If the full post exceeds one Discord message, it prompts the requester to publish exactly 2 linked posts instead of truncating required lines.",
      "`/fwa compliance` runs war-plan compliance checks on demand for a tracked clan (defaults to current active war; use `war-id:current` or numeric `war-id` for historical checks).",
      "`/fwa police configure` controls automatic DM/log enforcement toggles for a tracked clan.",
      "`/fwa police send` test-delivers one rendered sample police message to your DM or the police log destination (`TrackedClan.logChannelId` first, then `/bot-logs`).",
      "`/fwa police status` is admin-only and shows stored + effective police/log resolution state (optionally clan-scoped with `clan:`) using the same runtime fallback path as live police logging.",
      "FWA compliance embeds include a `Warplan` field from the same active plan source used by war mail, show resolved FWA-WIN threshold context (`N`/`H`) from warplan config, and strict-window breach context shows clan stars before the breach attack.",
      "`/fwa weight-age` scrapes the fwastats weight page and reports last submitted weight age (single clan or all tracked clans). Uses `FWASTATS_WEIGHT_COOKIE` when configured.",
      "`/fwa weight-link` returns fwastats weight page URL(s) for one clan or all tracked clans.",
      "`/fwa weight-health` summarizes all tracked clans and flags stale weight submissions (outdated >7d, severe >=30d) using the same auth flow as `weight-age`.",
      "`/fwa weight-cookie` sets or checks fwastats auth cookies used by weight scraping. With no cookie args it shows status; with both cookie values it saves updated values (optional `antiforgery-cookie-name` override).",
      "When fwastats auth expires, weight commands return recovery steps that point to `/fwa weight-cookie`.",
      "Points fetch lock includes a global active-war runtime lock for poller/service paths: during active war, runtime paths use persisted/cache only; `/force sync data` remains the explicit direct points.fwafarm bypass.",
      "`/fwa match` only shows sync state text when validation is needed, and hides non-actionable confirmation/lifecycle debug fields when current.",
      "When available, fwastats active-war validation is used by the war poller to promote inferred FWA matches to confirmed FWA.",
      "If match type is inferred, `/fwa match` shows a warning and quick verify link, with action buttons to confirm FWA/BL/MM.",
      "Selecting the same inferred match type again counts as explicit confirmation for that active war.",
      "Final mail confirm/send persists explicit match confirmation for that same active war identity, so rerender/refresh does not regress to inferred fallback.",
      "Tracked clan mail channel is configured via `/tracked-clan configure ... mail-channel`.",
      "`/fwa mail send` opens an ephemeral war mail preview with confirm/send.",
      "War mail embed sidebar colors are state-coded: BL=black, MM=white, FWA WIN=green, FWA LOSE=red, unresolved=gray.",
      "Single-clan `/fwa match` embed sidebar color follows the same state mapping from the currently displayed effective state, including draft revisions.",
      "`/fwa match` war-changing state now shows field-specific mismatch lines (opponent, sync #, outcome, match type) against persisted points validation.",
      "When opponent points pages are missing, `/fwa match` uses `:interrobang: Clan not found on points.fwafarm`, and alliance low-confidence states still collapse to one sync warning line.",
      "MM/BL no-opponent-page validation can now reuse tracked-clan points-page fallback through the shared snapshot path (without changing confirmation semantics).",
      "Running `/fwa match tag:<clan>` and then pressing `Alliance View` restores the full alliance overview (not a one-clan scoped view).",
      "Confirm-and-send pings the tracked clan role (`TrackedClan.clanRoleId`) when pinging is enabled.",
      "The `/fwa match` single-clan `Send Mail` button uses the same permissions as `/fwa mail send`.",
      "Mail freshness is scoped to the current war identity (war/opponent/config): sent/up-to-date disables resend, sent/out-of-date re-enables resend on matchType/outcome change, and new wars reset to unsent across both `/fwa match` and `/fwa mail send`.",
      "Default access for `/fwa mail send` is FWA leader role + Administrator (or override via `/permission add command:fwa:mail:send`).",
      "Default access for `/fwa compliance` is FWA leader role + Administrator (or override via `/permission add command:fwa:compliance`).",
      "Default access for `/fwa police` is FWA leader role + Administrator (or override via `/permission add command:fwa:police`).",
      "Default access for `/fwa weight-age`, `/fwa weight-link`, `/fwa weight-health`, and `/fwa weight-cookie` is FWA leader role + Administrator (or override via `/permission add`).",
      "`/fwa leader-role` sets the default FWA leader role used by leader-only commands.",
      "Tag supports autocomplete from tracked clans.",
      "After selecting a tracked tag, `war-id` supports autocomplete for recent ended wars scoped to that clan.",
      "Set `visibility:public` to post the result directly in channel.",
    ],
    examples: [
      "/fwa points tag:2QG2C08UP",
      "/fwa points",
      "/fwa match tag:2QG2C08UP",
      "/fwa base-swap clan:2QG2C08UP war-bases:1,4 base-errors:2,3",
      "/fwa compliance tag:2QG2C08UP",
      "/fwa compliance tag:2QG2C08UP war-id:current",
      "/fwa compliance tag:2QG2C08UP war-id:12345",
      "/fwa police configure clan:2QG2C08UP enable-dm:true enable-log:true",
      "/fwa police status",
      "/fwa police status clan:2QG2C08UP",
      "/fwa police send clan:2QG2C08UP show:DM violation:LOWER20_ANY_STARS",
      "/fwa weight-age tag:2QG2C08UP",
      "/fwa weight-age",
      "/fwa weight-link tag:2QG2C08UP",
      "/fwa weight-health",
      "/fwa weight-cookie",
      "/fwa weight-cookie application-cookie:... antiforgery-cookie:...",
      "/fwa weight-cookie application-cookie:... antiforgery-cookie:... antiforgery-cookie-name:.AspNetCore.Antiforgery.custom",
      "/tracked-clan configure tag:#2QG2C08UP mail-channel:#war-mail",
      "/fwa mail send tag:2QG2C08UP",
      "/fwa leader-role role:@FWA-Leaders",
      "/fwa points tag:2QG2C08UP visibility:public",
    ],
  },
  recruitment: {
    summary: "Manage recruitment templates and per-platform posting cooldowns.",
    details: [
      "`show` renders platform-specific recruitment output for a tracked clan.",
      "`edit` now requires platform and opens a platform-specific modal (discord/band/reddit fields differ).",
      "`countdown start` begins exact platform cooldown timers; `countdown status` shows your timers.",
      "`dashboard` accepts an optional IANA `timezone`, remembers your last dashboard timezone from `/sync time post`, and opens an interactive alliance/clan dashboard with timers, scripts, optimize guidance, timezone controls, a Start countdown button, and reminder scheduling.",
    ],
    examples: [
      "/recruitment show platform:discord clan:2QG2C08UP",
      "/recruitment edit platform:reddit clan:2QG2C08UP",
      "/recruitment countdown start platform:reddit clan:2QG2C08UP",
      "/recruitment countdown status",
      "/recruitment dashboard timezone:America/Los_Angeles",
      "/recruitment dashboard",
    ],
  },
  defer: {
    summary: "Track deferred FWA weight-input tasks for prospective members.",
    details: [
      "`add` queues a player tag + known weight when FWAStats roster entry is not yet possible.",
      "`list` shows only open deferments in oldest-first order for the active scope.",
      "`remove` resolves one open deferment after weight entry is completed in FWAStats.",
      "`clear` marks all open deferments in scope as cleared.",
      "Open deferments run reminder lifecycle stages at 48h, 5d, and 7d.",
      "Default access is FWA leader role + Administrator (or override via `/permission add`).",
    ],
    examples: [
      "/defer add player-tag:#ABC123 weight:145k",
      "/defer list",
      "/defer remove player-tag:#ABC123",
      "/defer clear",
    ],
  },
  "kick-list": {
    summary: "Build and manage kick-list candidates.",
    details: [
      "`build` auto-adds tracked-clan members who are inactive (default 3 days), unlinked, or linked to users not in this server.",
      "Results prioritize players who are both inactive and link-mismatched.",
      "`add` supports manual entries with a custom reason.",
      "`show` displays reasons for each candidate with pagination.",
    ],
    examples: [
      "/kick-list build",
      "/kick-list build days:5",
      "/kick-list add tag:#ABC123 reason:Missed war hits",
      "/kick-list show",
    ],
  },
  sync: {
    summary: "Post structured messages such as sync time announcements.",
    details: [
      "`/sync time post` opens a modal to capture date/time/timezone and role ping.",
      "Optional `timezone` autocompletes IANA zones and prefills the modal timezone field while keeping the field editable.",
      "Timezone input accepts IANA names like `America/New_York` plus common US aliases such as `EST`, `EDT`, `PST`, and `PDT`.",
      "Creates and pins a sync-time message in the active channel, then adds clan badge reactions.",
      "`/sync post status` shows claimed vs unclaimed clans from the stored active sync post, or a provided message ID.",
      "`sync time` is admin-only by default.",
    ],
    examples: [
      "/sync time post role:@War timezone:America/New_York",
      "/sync post status",
      "/sync post status message-id:123456789012345678",
    ],
  },
  say: {
    summary: "Post plain text or an embed message as the bot.",
    details: [
      "Use `/say text:<message>` to post one plain text message directly in the current channel.",
      "`show-from` defaults to true and posts through the interaction response path so Discord shows the native `/say` attribution header.",
      "When `show-from:false` is used, `/say` posts via normal channel send without native slash attribution, then sends an ephemeral confirmation.",
      "Use `type:LONG_TEXT` to open a modal with one required paragraph field and post that body as a normal message.",
      "Use `type:EMBED` to open a modal with optional title, required body, and optional image URL.",
      "Modal submit delivery follows the same show-from transport rule (`interaction reply` vs `channel send + ephemeral confirmation`).",
      "Hidden-source (`show-from:false`) sends are accountability-logged to the configured `/bot-logs` channel when one is set.",
      "Embed image URL must be an absolute `http://` or `https://` URL.",
      "`/say` is available to everyone by default unless restricted with `/permission add`.",
    ],
    examples: [
      "/say text:War starts in 15 minutes.",
      "/say text:War starts in 15 minutes. show-from:false",
      "/say type:LONG_TEXT",
      "/say type:EMBED",
      "/say text:Draft body type:EMBED",
    ],
  },
  "bot-logs": {
    summary: "Set or inspect the guild channel used for important bot logs.",
    details: [
      "Use `/bot-logs set-channel:<channel>` to save the per-guild destination channel for important bot logs.",
      "Use `/bot-logs` with no arguments to view the currently configured channel mention.",
      "If a saved channel no longer exists, the command reports stale config and clears it.",
      "`/bot-logs` is admin-only by default unless role access is granted with `/permission add`.",
    ],
    examples: ["/bot-logs", "/bot-logs set-channel:#leadership-logs"],
  },
  unlinked: {
    summary: "Alert leaders when tracked-clan members are not linked to Discord, and list unresolved players.",
    details: [
      "`set-alert` stores one guild-level alert channel or thread in dedicated unlinked-alert persistence instead of `BotSetting`.",
      "If no guild-level alert channel is configured, live alerts fall back to the tracked clan `log-channel` when available.",
      "`list` resolves the current live unresolved set across tracked FWA clans and active current-season CWL clans.",
      "A player is only considered linked when `PlayerLink.discordUserId` points to a Discord user; rows without a Discord user still count as unlinked.",
      "Default access is FWA Leader role + Administrator unless role policy is changed with `/permission add`.",
    ],
    examples: [
      "/unlinked set-alert channel:#leadership-alerts",
      "/unlinked list",
      "/unlinked list clan:#2QG2C08UP",
    ],
  },
  force: {
    summary:
      "Run manual repair and refresh actions for war data, points sync, and tracked messages.",
    details: [
      "`/force sync data` refreshes live points.fwafarm data into `ClanPointsSync` for the current war when possible.",
      "`/force sync mail` validates supplied mail references against current-channel active-war identity before writing `WarMailLifecycle`, and still repairs notify references in `ClanPostedMessage`.",
      "`/force sync warid` is a DB repair tool for `CurrentWar` and `ClanWarHistory` only.",
      "`/force mail update` first reconciles active-war lifecycle tracking (marking definitively missing references as DELETED), then refreshes existing sent war-mail in place and re-attaches it to the 20-minute refresh loop when valid.",
      "`/force poll war-events` runs the real war-event poll + refresh pipeline immediately.",
      "`force` commands are admin-only by default.",
    ],
    examples: [
      "/force sync data tag:2QG2C08UP datapoint:syncNum",
      "/force sync data tag:2QG2C08UP datapoint:points",
      "/force sync mail tag:2QG2C08UP message-type:mail message-id:1234567890123456789",
      "/force sync mail tag:2QG2C08UP message-type:notify:war start message-id:1234567890123456789",
      "/force sync warid table:currentwar tag:2QG2C08UP",
      "/force sync warid table:clanwarhistory tag:2QG2C08UP set-war-id:1001274",
      "/force poll war-events",
      "/force mail update tag:2QG2C08UP",
    ],
  },
  remaining: {
    summary:
      "Show remaining war timing or CWL round timing for one tracked clan, remembered clan, or alliance-wide tracked clans.",
    details: [
      "`/remaining war tag:<tag>` returns one tracked clan's current phase end and relative remaining time.",
      "`/remaining war` (no tag) summarizes all tracked clans currently in active war using a 10-minute dominant-time cluster.",
      "Aggregate mode reports dominant-cluster mean, spread (max-min), and outlier clans with divergent remaining times.",
      "`/remaining cwl tag:<tag>` returns one tracked CWL clan's persisted round state and timing from CWL tables only.",
      "`/remaining cwl` (no tag) reuses your last CWL clan selection when available, otherwise prompts for a tag or `all:true`.",
      "`/remaining cwl all:true` lists all tracked CWL clans with persisted preparation/in-war timing or `Unknown` when unavailable.",
    ],
    examples: [
      "/remaining war",
      "/remaining war tag:2QG2C08UP",
      "/remaining cwl",
      "/remaining cwl tag:2QG2C08UP",
      "/remaining cwl all:true",
    ],
  },
  telemetry: {
    summary: "View telemetry reports and manage scheduled report posts.",
    details: [
      "`/telemetry report` shows usage, latency, failures, and API health from persisted telemetry aggregates.",
      "`/telemetry schedule set` configures cadence/channel/timezone for automated Discord report posts.",
      "`/telemetry schedule run-now` posts one report for the current completed schedule window with idempotent window guards.",
      "Telemetry/report access is admin-only by default unless overridden with `/permission add`.",
    ],
    examples: [
      "/telemetry report period:24h timezone:America/Los_Angeles",
      "/telemetry schedule set target-channel:#ops cadence-hours:24 timezone:America/Los_Angeles enabled:true",
      "/telemetry schedule show",
      "/telemetry schedule run-now",
    ],
  },
  permission: {
    summary: "Control which roles can run each command target.",
    details: [
      "Add/remove role whitelists for command targets.",
      "List current policy for one target or all targets.",
      "`/permission list` includes `fwa:mail:send`, `fwa:compliance`, `fwa:weight-*`, and `defer*` targets (default FWA leader role + Administrator).",
      "`bot-logs`, `link:embed`, `link:create:admin`, and `link:delete:admin` are admin-only by default and can be role-whitelisted.",
      "`add` and `remove` are admin-only by default.",
    ],
    examples: [
      "/permission add command:sync role:@Leaders",
      "/permission add command:fwa:mail:send role:@Leaders",
      "/permission add command:fwa:compliance role:@Leaders",
      "/permission add command:fwa:weight-health role:@Leaders",
      "/permission add command:fwa:weight-cookie role:@Leaders",
      "/permission add command:defer role:@Leaders",
      "/permission add command:link:embed role:@Leaders",
      "/permission add command:say role:@Leaders",
      "/permission add command:bot-logs role:@Leaders",
      "/permission add command:link:create:admin role:@Leaders",
      "/permission add command:link:delete:admin role:@Leaders",
      "/permission add command:fwa role:@Leaders",
      "/permission remove command:sync role:@Leaders",
      "/permission list",
    ],
  },
};

export function getHelpDocumentedCommandNames(): string[] {
  return Object.keys(COMMAND_DOCS).sort((a, b) => a.localeCompare(b));
}

type RenderState = {
  page: number;
  selectedCommand: string;
  detailView: boolean;
};

function getAllCommands(): Command[] {
  return [...Commands].sort((a, b) => a.name.localeCompare(b.name));
}

function getAdminDefaultTargetsForCommand(commandName: string): string[] {
  return [...ADMIN_DEFAULT_TARGETS]
    .filter(
      (target) =>
        target === commandName || target.startsWith(`${commandName}:`),
    )
    .map((target) => `/${target.replaceAll(":", " ")}`);
}

function toOptionLabel(option: HelpOption): string {
  switch (option.type) {
    case ApplicationCommandOptionType.String:
      return "text";
    case ApplicationCommandOptionType.Integer:
      return "number";
    case ApplicationCommandOptionType.Number:
      return "decimal";
    case ApplicationCommandOptionType.Boolean:
      return "true|false";
    case ApplicationCommandOptionType.User:
      return "@user";
    case ApplicationCommandOptionType.Channel:
      return "#channel";
    case ApplicationCommandOptionType.Role:
      return "@role";
    case ApplicationCommandOptionType.Mentionable:
      return "@mention";
    case ApplicationCommandOptionType.Attachment:
      return "file";
    default:
      return "value";
  }
}

function formatOptionToken(option: HelpOption): string {
  const token = `${option.name}:${toOptionLabel(option)}`;
  return option.required ? `<${token}>` : `[${token}]`;
}

function buildUsageLines(command: Command): string[] {
  const options = (command.options ?? []) as HelpOption[];
  if (options.length === 0) return [`/${command.name}`];

  const lines: string[] = [];

  for (const option of options) {
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      const subcommands = (option.options ?? []) as HelpOption[];
      for (const subcommand of subcommands) {
        const subOptions = (subcommand.options ?? []) as HelpOption[];
        const argTokens = subOptions.map(formatOptionToken).join(" ");
        lines.push(
          `/${command.name} ${option.name} ${subcommand.name}${argTokens ? ` ${argTokens}` : ""}`,
        );
      }
      continue;
    }

    if (option.type === ApplicationCommandOptionType.Subcommand) {
      const subOptions = (option.options ?? []) as HelpOption[];
      const argTokens = subOptions.map(formatOptionToken).join(" ");
      lines.push(
        `/${command.name} ${option.name}${argTokens ? ` ${argTokens}` : ""}`,
      );
      continue;
    }
  }

  if (lines.length > 0) return lines;

  const topLevelTokens = options.map(formatOptionToken).join(" ");
  return [`/${command.name}${topLevelTokens ? ` ${topLevelTokens}` : ""}`];
}

function getOverviewEmbed(
  commands: Command[],
  state: RenderState,
): EmbedBuilder {
  const pageCount = Math.max(
    1,
    Math.ceil(commands.length / OVERVIEW_PAGE_SIZE),
  );
  const safePage = Math.max(0, Math.min(state.page, pageCount - 1));
  const start = safePage * OVERVIEW_PAGE_SIZE;
  const slice = commands.slice(start, start + OVERVIEW_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle("Help Center")
    .setColor(0x5865f2)
    .setDescription(
      "Use **Previous/Next** to browse pages, then pick a command from the dropdown for details.",
    )
    .setFooter({ text: `Overview page ${safePage + 1}/${pageCount}` });

  for (const cmd of slice) {
    const usage = buildUsageLines(cmd)[0] ?? `/${cmd.name}`;
    embed.addFields({
      name: `/${cmd.name}`,
      value: `${cmd.description}\nExample: \`${usage}\``,
      inline: false,
    });
  }

  return embed;
}

function getDetailEmbed(command: Command): EmbedBuilder {
  const usageLines = buildUsageLines(command);
  const doc = COMMAND_DOCS[command.name];
  const adminDefaults = getAdminDefaultTargetsForCommand(command.name);

  const detailLines = doc?.details ?? [
    "Use this command to run the described operation.",
    "If this command has subcommands, use one of the syntax lines below.",
  ];

  const exampleLines = doc?.examples?.length
    ? doc.examples
    : [usageLines[0] ?? `/${command.name}`];

  const accessText =
    adminDefaults.length === 0
      ? "Default access: everyone (unless restricted with `/permission`)."
      : `Admin-only by default: ${adminDefaults.map((t) => `\`${t}\``).join(", ")}`;

  return new EmbedBuilder()
    .setTitle(`/${command.name}`)
    .setColor(0x57f287)
    .setDescription(doc?.summary ?? command.description)
    .addFields(
      {
        name: "What It Does",
        value: detailLines.map((line) => `- ${line}`).join("\n"),
        inline: false,
      },
      {
        name: "Syntax",
        value: usageLines.map((line) => `\`${line}\``).join("\n"),
        inline: false,
      },
      {
        name: "Examples",
        value: exampleLines.map((line) => `\`${line}\``).join("\n"),
        inline: false,
      },
      {
        name: "Access",
        value: `${accessText}\nUse \`/permission add\` to whitelist roles.`,
        inline: false,
      },
    )
    .setFooter({ text: "Select another command or click Back to overview." });
}

function getControls(
  commands: Command[],
  state: RenderState,
  interactionId: string,
  allowPostToChannel: boolean,
) {
  const pageCount = Math.max(
    1,
    Math.ceil(commands.length / OVERVIEW_PAGE_SIZE),
  );
  const prevId = `help-prev:${interactionId}`;
  const nextId = `help-next:${interactionId}`;
  const backId = `help-back:${interactionId}`;
  const closeId = `help-close:${interactionId}`;
  const postId = `${HELP_POST_BUTTON_PREFIX}:${interactionId}`;
  const selectId = `help-select:${interactionId}`;

  const buttonRow = new ActionRowBuilder<ButtonBuilder>();
  if (state.detailView) {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(backId)
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(closeId)
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger),
    );
    if (allowPostToChannel) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(postId)
          .setLabel("Post to Channel")
          .setStyle(ButtonStyle.Primary),
      );
    }
  } else {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page <= 0),
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.page >= pageCount - 1),
      new ButtonBuilder()
        .setCustomId(closeId)
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger),
    );
    if (allowPostToChannel) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(postId)
          .setLabel("Post to Channel")
          .setStyle(ButtonStyle.Primary),
      );
    }
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder("Drill down into a command")
    .addOptions(
      commands.slice(0, 25).map((cmd) => ({
        label: `/${cmd.name}`.slice(0, 100),
        description: cmd.description.slice(0, 100),
        value: cmd.name,
        default: cmd.name === state.selectedCommand,
      })),
    );

  const selectRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return [buttonRow, selectRow];
}

function getResponsePayload(
  commands: Command[],
  state: RenderState,
  interactionId: string,
  allowPostToChannel: boolean,
) {
  const selected =
    commands.find((cmd) => cmd.name === state.selectedCommand) ?? commands[0];
  const embed = state.detailView
    ? getDetailEmbed(selected)
    : getOverviewEmbed(commands, state);
  const components = getControls(
    commands,
    state,
    interactionId,
    allowPostToChannel,
  );
  return { embeds: [embed], components };
}

export const Help: Command = {
  name: "help",
  description: "Browse commands, examples, and usage details",
  options: [
    {
      name: "command",
      description: "Jump directly to one command",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "visibility",
      description: "Response visibility",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "private", value: "private" },
        { name: "public", value: "public" },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction) => {
    const commands = getAllCommands();
    const requestedCommand = interaction.options
      .getString("command", false)
      ?.trim()
      .toLowerCase();
    const visibility =
      interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    const allowPostToChannel = !isPublic;

    const state: RenderState = {
      page: 0,
      selectedCommand: commands[0]?.name ?? "help",
      detailView: false,
    };

    if (requestedCommand) {
      const match = commands.find((cmd) => cmd.name === requestedCommand);
      if (!match) {
        await interaction.reply({
          ephemeral: true,
          content: `Unknown command \`${requestedCommand}\`. Try \`/help\` and select from the list.`,
        });
        return;
      }

      state.detailView = true;
      state.selectedCommand = match.name;
      state.page = Math.floor(
        commands.findIndex((cmd) => cmd.name === match.name) /
          OVERVIEW_PAGE_SIZE,
      );
    }

    await interaction.reply({
      ephemeral: !isPublic,
      ...getResponsePayload(
        commands,
        state,
        interaction.id,
        allowPostToChannel,
      ),
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: HELP_TIMEOUT_MS,
    });

    collector.on(
      "collect",
      async (component: ButtonInteraction | StringSelectMenuInteraction) => {
        try {
          if (component.user.id !== interaction.user.id) {
            await component.reply({
              ephemeral: true,
              content: "Only the user who opened this help menu can use it.",
            });
            return;
          }

          if (component.isButton()) {
            if (
              component.customId === `help-prev:${interaction.id}` &&
              state.page > 0
            ) {
              state.page -= 1;
              state.detailView = false;
            } else if (
              component.customId === `help-next:${interaction.id}` &&
              state.page < Math.ceil(commands.length / OVERVIEW_PAGE_SIZE) - 1
            ) {
              state.page += 1;
              state.detailView = false;
            } else if (component.customId === `help-back:${interaction.id}`) {
              state.detailView = false;
            } else if (component.customId === `help-close:${interaction.id}`) {
              await component.update({
                content: "Help closed.",
                embeds: [],
                components: [],
              });
              collector.stop("closed");
              return;
            } else if (
              component.customId ===
              `${HELP_POST_BUTTON_PREFIX}:${interaction.id}`
            ) {
              const payload = getResponsePayload(
                commands,
                state,
                interaction.id,
                allowPostToChannel,
              );
              const postChannel = interaction.channel as
                | { send?: (input: { embeds: EmbedBuilder[] }) => Promise<unknown> }
                | null;
              if (!postChannel || typeof postChannel.send !== "function") {
                await component.reply({
                  ephemeral: true,
                  content: "Could not post help in this channel.",
                });
                return;
              }
              await postChannel.send({
                embeds: payload.embeds,
              });
              await component.reply({
                ephemeral: true,
                content: "Posted to channel.",
              });
              return;
            }
          } else if (component.isStringSelectMenu()) {
            const picked = component.values[0];
            const found = commands.find((cmd) => cmd.name === picked);
            if (found) {
              state.selectedCommand = found.name;
              state.detailView = true;
              state.page = Math.floor(
                commands.findIndex((cmd) => cmd.name === found.name) /
                  OVERVIEW_PAGE_SIZE,
              );
            }
          }

          await component.update(
            getResponsePayload(
              commands,
              state,
              interaction.id,
              allowPostToChannel,
            ),
          );
        } catch (err) {
          console.error(`help component handler failed: ${formatError(err)}`);
          try {
            if (!component.replied && !component.deferred) {
              await component.reply({
                ephemeral: true,
                content: "Failed to update help menu.",
              });
            }
          } catch {
            // no-op
          }
        }
      },
    );

    collector.on("end", async (_collected, reason) => {
      if (reason === "closed") return;

      try {
        await interaction.editReply({ components: [] });
      } catch {
        // no-op
      }
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "command") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "")
      .trim()
      .toLowerCase();
    const names = getAllCommands().map((cmd) => cmd.name);
    const starts = names.filter((name) => name.startsWith(query));
    const contains = names.filter(
      (name) => !name.startsWith(query) && name.includes(query),
    );

    await interaction.respond(
      [...starts, ...contains].slice(0, 25).map((name) => ({
        name,
        value: name,
      })),
    );
  },
};
