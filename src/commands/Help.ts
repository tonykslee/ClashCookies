import {
  ActionRowBuilder,
  type APIEmbed,
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
  "tracked-clan:raid-tags",
  "tracked-clan:remove",
  "reminders",
  "reminders:create",
  "reminders:list",
  "reminders:reconcile-cwl",
  "reminders:audit-cwl",
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
  "autorole",
  "autorole:config",
  "autorole:rules",
  "autorole:exclusions",
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
  "cwl:rotations:delete",
  "cwl:rotations:import",
  "cwl:rotations:export",
  "roster:create",
  "roster:post",
  "roster:manage",
  "roster:edit",
  "roster:delete",
  "roster:report",
  "roster:refresh",
  "autorole",
  "autorole:config",
  "autorole:rules",
  "autorole:exclusions",
  "autorole:refresh:user",
  "autorole:refresh:role",
]);

const FWA_LEADER_DEFAULT_TARGETS = new Set<string>([
  "autorole:refresh",
]);

type CommandDoc = {
  summary: string;
  details: string[];
  examples: string[];
};

type HelpField = {
  name: string;
  value: string;
  inline: boolean;
};

type HelpEmbedPage = {
  description?: string;
  fields: HelpField[];
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
      "Use `/emoji name:<emoji_name> react:<message-id>` to react to a message in the current channel with that resolved emoji; successful reacts confirm privately and are logged to `/bot-logs` when configured.",
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
    summary: "List players inactive for a given number of days or missed wars.",
    details: [
      "Shows oldest inactive players first.",
      "Supports `clan` autocomplete to scope days mode, wars mode, and the combined days+wars mode to one tracked clan.",
      "Wars mode groups results by clan and missed-war count, then shows the linked Discord user, player tag, and missed-war emoji sequence.",
      "When wars mode finds no rows, the bot includes a short diagnostic note about ended-war and participation-row coverage.",
      "Large results are clipped to keep replies readable.",
    ],
    examples: [
      "/inactive days:7",
      "/inactive days:30",
      "/inactive days:7 clan:#AAA111",
      "/inactive wars:3",
      "/inactive wars:3 clan:#AAA111",
    ],
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
  dump: {
    summary: "Show or update the stored dump link with a short clan summary.",
    details: [
      "Use `/dump` to show a short clan summary plus the configured guild link, all as plain text.",
      "The link is wrapped in `< >` to prevent Discord from building an embed preview.",
      "If live clan data is unavailable, `/dump` falls back to the cached clan summary when present.",
      "`edit` is admin-only and stores one link per guild/server.",
    ],
    examples: ["/dump", "/dump edit:https://example.com/dump"],
  },
  "tracked-clan": {
    summary: "Manage tracked clans used by activity features.",
    details: [
      "Configure/remove tracked clans or list current tracked set.",
      "`configure` upserts tracked clan settings (lose-style, mail channel, log channel, clan role, clan badge emoji, short name).",
      "`cwl-tags` adds one seasonal CWL throwaway clan batch (array-style or comma-separated tags) without polluting the FWA tracked list.",
      "`raid-tags` adds or updates the RAIDS registry with optional manual upgrades for one tag, stores the clan name from the clan profile API on write, and caches the clan join status from the clan profile API on write.",
      "`list` without `type` shows one embed grouped by FWA/CWL/RAIDS; `type:FWA|CWL|RAIDS` switches to the per-registry view. RAIDS list rows use the stored clan name, show join status with 🔒/🔓, and include an inline refresh button to re-sync missing names or join status.",
      "`remove` supports deterministic FWA/CWL/RAIDS deletion; when a tag exists in more than one registry, pass `type` explicitly.",
      "`configure`, `cwl-tags`, `raid-tags`, and `remove` are admin-only by default.",
    ],
    examples: [
      "/tracked-clan configure tag:#2QG2C08UP",
      "/tracked-clan configure tag:#2QG2C08UP lose-style:Traditional mail-channel:#war-mail",
      "/tracked-clan configure tag:#2QG2C08UP clan-badge::Logo_Gabbar:",
      "/tracked-clan configure tag:#2QG2C08UP short-name:GB",
      "/tracked-clan cwl-tags cwl-tags:[#PYLQ0289,#QGRJ2222]",
      "/tracked-clan raid-tags raid-tags:[#2RVGJYLC0] upgrades:3331",
      "/tracked-clan list",
      "/tracked-clan list type:RAIDS",
      "/tracked-clan list type:CWL",
      "/tracked-clan remove tag:#2QG2C08UP type:FWA",
      "/tracked-clan remove tag:#2RVGJYLC0 type:RAIDS",
    ],
  },
  raids: {
    summary: "View tracked RAID clans with live open-attacker metadata when available.",
    details: [
      "Shows an overview of tracked RAIDS clans with clickable clan names and open defending-clan rows when the live defense log can resolve them. The single-clan view adds attack and defense detail sections, and open attacking clans include a requirements sub-line when their live clan metadata is available.",
      "`/raids overview` focuses on raid status and sort order; the overview includes a tracked-clan dropdown, refresh button, status emojis (`⚔️` for ongoing/incomplete raids, `🌄` for completed raids), clickable clan titles, and open defending-clan rows when the live defense log can resolve them. Rows sort by ongoing raid, raids completed, and raid-intel grade score before falling back to the tracked display order. `clan` opens a single-clan view with attack and defense detail sections when the live raid-season source can resolve them, and both views keep the same refresh button so the message updates in place. `/raids overview clan:<tag>` keeps the detailed attack/completed stats. `/raids intel` opens a raid-intel view for one tracked clan with defender/district details, saved layout grades, optional district pre-mark args such as `capital_peak:Custom - Hard`, and the same interactive district controls after the embed opens.",
    ],
    examples: [
      "/raids overview",
      "/raids overview clan:#2RVGJYLC0",
      "/raids intel clan:#2RVGJYLC0",
      "/raids intel clan:#2RVGJYLC0 upgrades:2299",
      "/raids intel clan:#2RVGJYLC0 capital_peak:\"Custom - Hard\" skeleton_park:\"Custom - Easy\"",
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
    summary: "Composition tools with DB-backed WAR state plus DB-backed ACTUAL state/place flows.",
    details: [
      "`advice`: simulate bucket-level compo moves from DB-backed ACTUAL or WAR state and recommend the best improvement.",
      "`advice` renders as an embed. ACTUAL mode defaults to `Auto-Detect Band` and can be switched between `Raw Data`, `Auto-Detect Band`, `Best Fit`, and `Custom` with inline buttons. In ACTUAL `auto`/`best` views, the embed now labels the resolved roster weight separately from the projected 50-player scoring weight so the score basis is explicit. `Custom` also exposes `-` / `+` band-step controls.",
      "`state`: `mode:war` renders from persisted tracked-clan feed state only, while `mode:actual` now renders from persisted ACTUAL current-member state (`TrackedClan` + `FwaClanMemberCurrent` + `HeatMapRef`) with deferred-weight and WAR-effective-weight fallback when member weight is zero. ACTUAL state defaults to `Auto-Detect Band`, and the inline buttons now only switch between `Raw Data` and `Auto-Detect Band`. Raw Data shows current resolved composition counts instead of HeatMapRef deltas.",
      "`state` refresh: `mode:war` refreshes tracked-clan war-roster feed state only and rerenders from DB; `mode:actual` now refreshes ACTUAL current-member/weight state plus live CoC member counts for all tracked clans, then rerenders from DB.",
      "`heatmapref`: renders the persisted HeatMapRef table as an attached PNG image with `TH11+`, `Match%`, and `Clans` columns, plus an inline `Copy Table` button that returns a formatted CSV text block with `WeightMin`, `WeightMax`, `TH11+`, `Match%`, and `# Clans` without triggering any rebuild/update work.",
      "`place`: suggest placement by war weight from persisted ACTUAL FWAStats current-member state (`TrackedClan` + `FwaClanMemberCurrent` + `HeatMapRef`) with deferred-weight and WAR-effective-weight fallback only for zero-weight member rows.",
      "`place` refresh: every response includes an inline refresh button that explicitly refreshes ACTUAL current-member/weight state plus live CoC member counts for all tracked clans, then rerenders from persisted DB state.",
    ],
    examples: [
      "/compo advice tag:#2QG2C08UP mode:actual",
      "/compo advice tag:#2QG2C08UP mode:war",
      "/compo state mode:war",
      "/compo heatmapref",
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
      "Roster signup, lifecycle, and manager controls now live under `/roster` so `/cwl` can stay focused on persisted CWL observations and rotation tooling.",
      "`/cwl rotations show` renders an interactive overview of active CWL plans with status, next battle-day timing, current-clan leadership summary, and a dropdown to open the detailed clan view; the clan page supports paging and manual refresh of that clan's actual CWL state. The clan autocomplete only lists tracked clans with an active current-season rotation.",
      "`/cwl rotations create` is admin-only by default and only works during persisted CWL preparation state for the tracked clan. Optional `size:15|30` selects the CWL lineup size. When seeded from a roster, only players that are both confirmed on that roster and present in the clan's current CWL participation data are eligible, with persisted weight data used when available.",
      "`/cwl rotations delete` is admin-only by default and deactivates the active CWL rotation plan for one tracked clan in the current season. The clan autocomplete only lists tracked clans with an active current-season rotation.",
      "`/cwl rotations import` is admin-only by default and imports active planner tabs from one public Google Sheet after a confirmation preview and clan-by-clan row-review step. Structural rows may be skipped automatically, but player-like rows are never dropped silently. Public imports do not require Google Sheets credentials; export/write still does.",
      "`/cwl rotations export [new:true|false]` is admin-only by default and writes the active planner data to a public Google Sheet using the canonical re-importable tabular format. When `new:false` or omitted, unchanged payloads reuse the previous same-season export link instead of creating a new sheet.",
      "The `/cwl` surface is DB-first and does not live-query broad CWL state on render when persisted state exists.",
    ],
    examples: [
      "/cwl members clan:#2QG2C08UP",
      "/cwl members clan:#2QG2C08UP inwar:true",
      "/cwl rotations show",
      "/cwl rotations show clan:#2QG2C08UP day:3",
      "/cwl rotations create clan:#2QG2C08UP size:30 exclude:#PYLQ0289,#QGRJ2222 overwrite:true",
      "/cwl rotations create clan:#2QG2C08UP size:15 roster:roster-123 overwrite:true",
      "/cwl rotations delete clan:#2QG2C08UP",
      "/cwl rotations import sheet:https://docs.google.com/spreadsheets/d/... overwrite:true",
      "/cwl rotations export",
      "/cwl rotations export new:true",
    ],
  },
  autorole: {
    summary: "Manage durable autorole config, rules, exclusions, manual refresh, and nickname templates.",
    details: [
      "`refresh` manually evaluates the guild, one user, or one managed role and applies autorole role and nickname changes immediately; the no-arg guild refresh uses tracked FWA clan member data for its guild-wide evaluation, so FWA Leaders can run it without admin access, while the `user` and `role` scoped refreshes stay admin-only.",
      "`config show` displays the current guild autorole policy snapshot, including nickname sync status and template.",
      "`config set` updates guild config fields such as `enabled`, `kill_switch_enabled`, stale-role removal, link trust policy, sync policy, `apply_nicknames`, and `nickname_template`.",
      "`config set` can also set/clear the generic CWL clan role used for users with an eligible linked account in a tracked current-season CWL clan, and it can configure a stale CLAN-role removal delay in minutes.",
      "Enable nickname sync with `apply_nicknames:true` and set a template such as `{player} | {trackedClans}` for ClashPerk-style names like `Elrond ♣️ | RR | GB | RD`.",
      "Nickname template tokens: `{player}`, `{tag}`, `{th}`, `{clan}`, `{clanTag}`, `{clanShort}`, `{trackedClans}`, `{discord}`, `{username}`, and `{role}`.",
      "`{trackedClans}` lists distinct permanent FWA tracked-clan short names across the member's eligible linked accounts, de-dupes duplicate clans, puts the primary account clan first, and joins labels with ` | `.",
      "The primary account for `{player}`, `{th}`, `{clan}`, and related tokens prefers eligible linked accounts in permanent FWA tracked clans, then highest Town Hall, then trust tier, then oldest link, then player tag.",
      "Nickname output is cleaned up when tokens are missing and capped to Discord's 32-character nickname limit; long multi-clan names are truncated without leaving dangling separators.",
      "Unicode emoji can be used in player names and templates, but custom Discord emoji markup does not render inside nicknames.",
      "The bot needs Manage Nicknames and must be higher in the role hierarchy than the target member to change nicknames; it also needs Manage Roles and hierarchy above managed roles to apply/remove roles.",
      "`rules list/add/edit/remove` manage persisted rule mappings for verified, family, clan, clan-rank, league, town-hall, and label targets.",
      "`config set` can also set/clear the generic CWL clan role used for users with an eligible linked account in a tracked current-season CWL clan.",
      "`config set` can also set/clear a stale CLAN-role removal delay in minutes.",
      "`exclusions list/add-user/remove-user/add-role/remove-role` manage guild-level user and role exclusions.",
      "`config`, `rules`, and `exclusions` stay admin-only by default; `refresh` is FWA Leader role + Administrator by default.",
    ],
    examples: [
      "/autorole refresh",
      "/autorole refresh user:@SomeUser",
      "/autorole refresh role:@SomeRole",
      "/autorole config show",
      "/autorole config set enabled:true trusted_links_allowed:true",
      "/autorole config set cwl_clan_role:@InCwlClan",
      "/autorole config set clear_cwl_clan_role:true",
      "/autorole config set clan_role_removal_delay_minutes:60",
      "/autorole config set clear_clan_role_removal_delay:true",
      "/autorole config set apply_nicknames:true nickname_template:\"{player} | {trackedClans}\"",
      "/autorole rules list",
      "/autorole rules add type:CLAN role:@Rocky Road target_value:#2RYGLU2UY",
      "/autorole rules add type:League role:@Legend target_value:\"Legend League\"",
      "/autorole rules add type:TOWN_HALL role:@TH18 target_value:18",
      "/autorole exclusions list",
    ],
  },
  roster: {
    summary: "Create, list, post, and manage persisted rosters.",
    details: [
      "`/roster create category:<CWL|FWA> clan:<trackedClanTag> [name:<text>] [title:<text>] [timezone:<ianaTz>] [start_time:YYYY-MM-DD HH:mm] [end_time:YYYY-MM-DD HH:mm] [max_members:<n>] [max_accounts_per_user:<n>] [min_townhall:<n>] [max_townhall:<n>] [required-role:<discordRole>] [no-role-signup-limit:<n>] [roster_role:<role>] [allow_multi_signup:<bool>] [sort_by:<signed_up_at|player_name|player_tag|discord_user|townhall>] [import_members:<bool>]` creates a roster object without posting it yet. `name` is the preferred field and `title` is a compatibility alias.",
      "`/roster list [name:<text>] [user:<discordId>] [player:<playerTagOrName>] [clan:<clanTag>]` shows roster title, type, clan scope, lifecycle state, and posted status for the guild; when `user` is provided, it shows that user's linked accounts signed up for current rosters grouped by roster and roster group.",
      "`/roster list` is public by default; create/post/manage/edit/delete/report/refresh are admin-only by default unless you whitelist roles.",
      "`/roster post roster:<roster>` posts the roster signup message or refreshes the existing post if it already exists. The published board uses a compact Player / Discord / Clan table by default plus `Refresh`, `Signup`, `Opt-out`, and `Settings` controls. `Settings` includes `Customize` for saved column-order and sort-mode overrides, `Add User` and `Remove User` roster member panels, and optional `Townhall Icons`, `Index`, `Weight Source`, and `Weight Age` columns can be enabled from there.",
      "`/roster manage roster:<roster> action:<add|move|remove|change_roster|set_weight|open|close|archive> [user:<discordUser>] ...` is the roster-keyed manager surface for mutation, manual fallback weight entry, and lifecycle changes. For add/move/remove/change_roster/set_weight, selecting a user opens the interactive account picker; resolved roster weights prefer `FwaPlayerCatalog.latestKnownWeight` first, then `ExternalPlayerWeightCurrent` as the fallback owner when needed.",
      "`/roster edit roster:<roster>` edits roster metadata such as name, category, clan scope, limits, town-hall gates, signup role requirement, roster role, sort order, and timezone fields. `name` is the supported label for edit.",
      "`/roster` settings actions currently include export, customize, close roster, clear roster, hide buttons, archive mode, unregistered members, and missing members; destructive actions require confirmation where applicable. Export opens a Google Sheet from the ephemeral roster settings flow.",
      "`/roster delete roster:<roster>` removes the posted Discord message first when one exists, then hard-deletes the roster and its persisted signup data. If the message cannot be removed, the roster stays intact so you can retry safely.",
      "`/roster report` shows the richer roster status view, and `/roster refresh` rerenders the posted board from refreshed DB truth.",
      "`/roster refresh roster:<roster>` refreshes rostered players' current-clan state through the service layer before rerendering the posted roster message from DB truth.",
    ],
    examples: [
      "/roster create category:CWL clan:#2QG2C08UP name:CWL Alpha Signup timezone:America/Los_Angeles required-role:@Leaders no-role-signup-limit:0 import_members:true",
      "/roster list",
      "/roster post roster:roster_123",
      "/roster manage roster:roster_123 action:add user:@RosterUser",
      "/roster manage roster:roster_123 action:move user:@RosterUser",
      "/roster manage roster:roster_123 action:remove user:@RosterUser",
      "/roster manage roster:roster_123 action:change_roster user:@RosterUser",
      "/roster manage roster:roster_123 action:set_weight user:@RosterUser",
      "/roster manage roster:roster_123 action:open",
      "/roster edit roster:roster_123 name:CWL Alpha Signup required-role:@Leaders no-role-signup-limit:0 timezone:America/New_York",
      "/roster delete roster:roster_123",
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
    summary: "List linked player accounts grouped by their current clan, with tracked FWA clans first.",
    details: [
      "Default behavior lists accounts linked to your Discord account.",
      "If `discord-id` is provided, lists accounts for that Discord user.",
      "If `tag` is provided, resolves linked Discord ID from local PlayerLink, then lists that user's accounts and shows `Linked Discord: <@id>` under the title.",
      "Only one of `tag` or `discord-id` can be provided.",
      "Runtime link resolution is local-only from `PlayerLink`.",
      "Account display uses persisted local data only, with TH badges, crowns for leaders/co-leaders, and compact FWA weights when available. Weight (`Wt`) comes from `FwaClanMemberCurrent.weight` first, then `FwaPlayerCatalog.latestKnownWeight`, then `PlayerCurrent.currentWeight`, then `ExternalPlayerWeightCurrent.weight`, then open `WeightInputDeferment.deferredWeight`, with `—` when no resolved positive weight exists.",
      "Set `visibility:public` to post the response directly in channel.",
    ],
    examples: [
      "/accounts",
      "/accounts discord-id:@user",
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
      "`reconcile-cwl` backfills missing current-season CWL reminder targets for one reminder without removing existing targets; `audit-cwl` reports CWL target coverage, missing clans, and stale clans without mutating anything.",
      "`list` shows scan-friendly reminder rows with type/channel/offsets/target clan names/enabled state.",
      "`edit id:<reminder_id>` opens the edit panel directly for one reminder within the current guild.",
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
      "/reminders reconcile-cwl reminder:reminder_1234abcd",
      "/reminders audit-cwl reminder:reminder_1234abcd",
      "/reminders edit id:reminder_1234abcd",
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
      "`verify` checks ownership with the player's API token and marks the link verified when the token matches.",
      "`status` shows the persisted trust state for one or more of your linked player tags, including source, verification status, verification method, and verified timestamps.",
      "`list` renders non-zero linked/unlinked count buckets with padded inline rows: linked rows start with a resolved `yes` status emoji and show `TH ServerDisplayName Player Wt`, unlinked rows start with a resolved `no` status emoji and show `TH #PLAYER_TAG Player Wt`.",
      "Weight (`Wt`) comes from `FwaClanMemberCurrent.weight` first, then `FwaPlayerCatalog.latestKnownWeight`, then `PlayerCurrent.currentWeight`, and is shown as compact lowercase `k` text (for example `145k`), with `—` when no resolved positive weight exists.",
      "`embed` is admin-gated and posts a reusable self-service Link Account embed with button + modal flow.",
      "`list` includes a tracked-clan dropdown and a sort-cycle button (`Discord Name -> Weight Desc -> Player Tags -> Player Name`) and updates the same message in place.",
      "`list` shows active sort mode in the embed footer.",
      "`sync-clashperk` is admin-gated and imports missing local PlayerLink rows from a public Google Sheet with ClashPerk-style columns.",
    ],
    examples: [
      "/link create player-tag:#ABC123,#DEF456",
      "/link create player-tag:#ABC123 user:@SomeUser",
      "/link delete player-tag:#ABC123",
      "/link verify player-tag:#ABC123 token:****",
      "/link status",
      "/link status player-tag:#ABC123",
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
      "`/fwa base-swap` posts a tracked acknowledgment message for war-base, FWA-base, and base-error positions, includes deduped TH-specific `RISINGDAWN` layout links for listed players, and DMs the invoker copy/paste in-game ping lines (active-war, blacklist-war swap, and TH-grouped base errors). FWA tracked clans resolve positions from the active war roster source, while current-season CWL tracked clans resolve positions from the persisted CWL lineup source. Optional `swap-reminder:true|false` applies to `fwa-bases` flows and defaults to `true`. If the full post exceeds one Discord message, it prompts the requester to publish exactly 2 linked posts instead of truncating required lines.",
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
      "`/fwa match` opens an ephemeral war mail preview; inferred matches can preview, but send stays blocked until the current active war is confirmed.",
      "`/fwa match` copy/paste view now collapses to one compact line per clan in alliance overview and one compact line in single-clan view, with opponent name/tag sanitized for mobile copy.",
      "War mail embed sidebar colors are state-coded: BL=black, MM=white, FWA WIN=green, FWA LOSE=red, unresolved=gray.",
      "Single-clan `/fwa match` embed sidebar color follows the same state mapping from the currently displayed effective state, including draft revisions.",
      "`/fwa match` war-changing state now shows field-specific mismatch lines (opponent, sync #, outcome, match type) against persisted points validation.",
      "When opponent points pages are missing, `/fwa match` uses `:interrobang: Clan not found on points.fwafarm`, and alliance low-confidence states still collapse to one sync warning line.",
      "MM/BL no-opponent-page validation can now reuse tracked-clan points-page fallback through the shared snapshot path (without changing confirmation semantics).",
      "Running `/fwa match tag:<clan>` and then pressing `Alliance View` restores the full alliance overview (not a one-clan scoped view).",
      "Confirm-and-send pings the tracked clan role (`TrackedClan.clanRoleId`) when pinging is enabled.",
      "The `/fwa match` single-clan `Send Mail` button uses the same permissions and role-ping behavior as the underlying mail-send flow.",
      "Mail freshness is scoped to the current war identity (war start time/opponent/config): sent/up-to-date disables resend, sent/out-of-date re-enables resend on matchType/outcome change, and new wars reset to unsent across the `/fwa match` preview/send flow.",
      "Default access for the `/fwa match` single-clan `Send Mail` button is FWA leader role + Administrator.",
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
      "/fwa base-swap clan:2QG2C08UP war-bases:1,4 fwa-bases:5,6 swap-reminder:false base-errors:2,3",
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
      "/fwa match tag:2QG2C08UP",
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
      "`add` queues a player tag + known weight when FWAStats roster entry is not yet possible and upserts the same deferred weight into `PlayerCurrent.currentWeight` after fetching the live player profile.",
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
  "copy-channel": {
    summary: "Export recent messages from the current channel as copy-friendly text.",
    details: [
      "Reads up to `messages:200` recent messages from the current server text or announcement channel.",
      "`after` and `before` anchor exports relative to one Discord message id and exclude the anchor itself.",
      "Each row is formatted as `[YYYY-MM-DD HH:mm] DisplayName: content` using UTC timestamps.",
      "Short exports are returned in a formatted code block; longer exports are returned as a `.txt` attachment.",
      "Non-text messages are annotated with safe placeholders for attachments, embeds, stickers, or empty content.",
      "The response is ephemeral.",
    ],
    examples: [
      "/copy-channel messages:10",
      "/copy-channel messages:200 after:123456789012345678",
      "/copy-channel messages:50 before:123456789012345678",
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
      "`set-alert` stores explicit unlinked-alert routing in dedicated feature-owned persistence instead of `BotSetting`.",
      "Use `enable:clan-log channel`, `enable:bot-log channel`, `enable:custom`, or `enable:false`; `channel` is only used with `enable:custom`.",
      "Clan-log mode sends to the tracked clan `log-channel`, bot-log mode sends to `/bot-logs`, custom mode sends to the saved guild channel or thread, and `false` disables delivery.",
      "`list` resolves the current live unresolved set across tracked FWA clans and active current-season CWL clans.",
      "A player is only considered linked when `PlayerLink.discordUserId` points to a Discord user; rows without a Discord user still count as unlinked.",
      "Default access is FWA Leader role + Administrator unless role policy is changed with `/permission add`.",
    ],
    examples: [
      "/unlinked set-alert enable:custom channel:#leadership-alerts",
      "/unlinked set-alert enable:clan-log channel",
      "/unlinked list",
      "/unlinked list clan:#2QG2C08UP",
    ],
  },
  force: {
    summary:
      "Run manual repair and refresh actions for war data, points sync, and tracked messages.",
    details: [
      "`/force sync data` refreshes live points.fwafarm data into `ClanPointsSync` for the current war when possible.",
      "`/force sync mail` validates supplied mail references against the current-channel active-war identity before writing `WarMailLifecycle`, and still repairs notify references in `ClanPostedMessage`. Lifecycle ownership follows the full active-war identity (war start time + opponent when available), not `warId` alone.",
      "`/force sync warid` is a DB repair tool for `CurrentWar` and `ClanWarHistory` only.",
      "`/force refresh heatmapref` rebuilds `HeatMapRef` from persisted FWA WarMembers data, and is the manual repair path for the automatic cycle job.",
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
      "/force refresh heatmapref",
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
      "`/permission list` includes `fwa:compliance`, `fwa:weight-*`, and `defer*` targets (default FWA leader role + Administrator).",
      "`bot-logs`, `link:embed`, `link:create:admin`, and `link:delete:admin` are admin-only by default and can be role-whitelisted.",
      "`add` and `remove` are admin-only by default.",
    ],
    examples: [
      "/permission add command:sync role:@Leaders",
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

const DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fieldsPerEmbed: 25,
  totalChars: 5800,
} as const;

const HELP_DETAIL_MAX_EMBEDS = 10;
const HELP_DETAIL_SOFT_PAGE_TARGET = 3500;
const HELP_DETAIL_HARD_PAGE_LIMIT = 4000;
const HELP_DETAIL_FOOTER_RESERVE = 240;

function truncateForDiscord(text: string, maxLength: number): string {
  const suffix = "…";
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= suffix.length) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

function splitTextByLength(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    parts.push(text.slice(start, start + maxLength));
  }
  return parts;
}

function chunkFormattedLines(lines: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const lineParts = splitTextByLength(line, maxLength);
    for (const part of lineParts) {
      if (!current) {
        current = part;
        continue;
      }

      if (current.length + 1 + part.length <= maxLength) {
        current = `${current}\n${part}`;
      } else {
        chunks.push(current);
        current = part;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function buildSectionFields(
  sectionName: string,
  lines: string[],
  formatter: (line: string) => string,
): HelpField[] {
  const formattedLines = lines.map(formatter);
  const chunks = chunkFormattedLines(
    formattedLines.length > 0 ? formattedLines : [""],
    DISCORD_EMBED_LIMITS.fieldValue,
  );

  return chunks.map((chunk, index) => ({
    name: truncateForDiscord(
      chunks.length > 1
        ? `${sectionName} (${index + 1}/${chunks.length})`
        : sectionName,
      DISCORD_EMBED_LIMITS.fieldName,
    ),
    value: truncateForDiscord(chunk || " ", DISCORD_EMBED_LIMITS.fieldValue),
    inline: false,
  }));
}

function createPage(description?: string): HelpEmbedPage {
  return {
    description,
    fields: [],
  };
}

function pageCharCount(
  page: HelpEmbedPage,
  title: string,
  footerReserve: number,
): number {
  return (
    title.length +
    (page.description?.length ?? 0) +
    page.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) +
    footerReserve
  );
}

export function getHelpEmbedCharacterCount(embed: APIEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    (embed.fields?.reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    ) ?? 0)
  );
}

function toEmbed(
  page: HelpEmbedPage,
  title: string,
  footer: string,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(
    truncateForDiscord(title, DISCORD_EMBED_LIMITS.title),
  );

  embed.setColor(0x57f287);

  if (page.description) {
    embed.setDescription(truncateForDiscord(page.description, DISCORD_EMBED_LIMITS.description));
  }

  for (const field of page.fields) {
    embed.addFields(field);
  }

  embed.setFooter({ text: footer });
  return embed;
}

function buildHelpDetailFooter(
  baseFooter: string,
  omittedPages: number,
  trimmedFields: number,
): string {
  const suffixParts: string[] = [];
  if (omittedPages > 0) {
    suffixParts.push(
      `Continued/truncated: ${omittedPages} additional page(s) omitted to stay within Discord's 10-embed limit.`,
    );
  }
  if (trimmedFields > 0) {
    suffixParts.push(
      `${trimmedFields} field(s) trimmed to fit Discord's 6000-char embed limit.`,
    );
  }

  return suffixParts.length > 0
    ? `${baseFooter} ${suffixParts.join(" ")}`
    : baseFooter;
}

function finalizeHelpDetailPage(
  page: HelpEmbedPage,
  title: string,
  baseFooter: string,
): EmbedBuilder {
  const workingPage: HelpEmbedPage = {
    description: page.description,
    fields: [...page.fields],
  };
  let omittedFields = 0;
  let footer = baseFooter;
  let embed = toEmbed(workingPage, title, footer);

  while (getHelpEmbedCharacterCount(embed.toJSON()) > HELP_DETAIL_HARD_PAGE_LIMIT) {
    if (workingPage.fields.length > 0) {
      workingPage.fields.pop();
      omittedFields += 1;
      footer = buildHelpDetailFooter(baseFooter, 0, omittedFields);
      embed = toEmbed(workingPage, title, footer);
      continue;
    }

    if (workingPage.description) {
      const fixedSize = getHelpEmbedCharacterCount({
        title: title.length > 0 ? title : undefined,
        description: undefined,
        footer: footer.length > 0 ? { text: footer } : undefined,
        fields: workingPage.fields.map((field) => ({
          name: field.name,
          value: field.value,
          inline: field.inline,
        })),
      });
      const remaining = Math.max(0, HELP_DETAIL_HARD_PAGE_LIMIT - fixedSize);
      const nextDescription = truncateForDiscord(
        workingPage.description,
        remaining,
      );
      if (nextDescription === workingPage.description) {
        break;
      }
      workingPage.description = nextDescription;
      footer = buildHelpDetailFooter(baseFooter, 0, omittedFields);
      embed = toEmbed(workingPage, title, footer);
      continue;
    }

    break;
  }

  return embed;
}

export function buildHelpDetailEmbeds(
  command: Pick<Command, "name" | "description" | "options">,
  docOverride?: CommandDoc,
): EmbedBuilder[] {
  const usageLines = buildUsageLines(command as Command);
  const doc = docOverride ?? COMMAND_DOCS[command.name];
  const adminDefaults = getAdminDefaultTargetsForCommand(command.name);
  const fwaLeaderDefaults = getFwaLeaderDefaultTargetsForCommand(command.name);

  const detailLines = doc?.details ?? [
    "Use this command to run the described operation.",
    "If this command has subcommands, use one of the syntax lines below.",
  ];

  const exampleLines = doc?.examples?.length
    ? doc.examples
    : [usageLines[0] ?? `/${command.name}`];

  const accessTextLines: string[] = [];
  if (fwaLeaderDefaults.length > 0) {
    accessTextLines.push(
      `FWA Leader role + Administrator by default: ${fwaLeaderDefaults.map((t) => `\`${t}\``).join(", ")}`,
    );
  }
  if (adminDefaults.length > 0) {
    accessTextLines.push(
      `Admin-only by default: ${adminDefaults.map((t) => `\`${t}\``).join(", ")}`,
    );
  }
  const accessText =
    accessTextLines.length > 0
      ? accessTextLines.join("\n")
      : "Default access: everyone (unless restricted with `/permission`).";

  const allFields = [
    ...buildSectionFields("What It Does", detailLines, (line) => `- ${line}`),
    ...buildSectionFields("Syntax", usageLines, (line) => `\`${line}\``),
    ...buildSectionFields("Examples", exampleLines, (line) => `\`${line}\``),
    ...buildSectionFields("Access", [accessText, "Use `/permission add` to whitelist roles."], (line) => line),
  ];

  const baseTitle = `/${command.name}`;
  const pages: HelpEmbedPage[] = [];
  let current = createPage(
    truncateForDiscord(doc?.summary ?? command.description, DISCORD_EMBED_LIMITS.description),
  );

  for (const field of allFields) {
    const projectedCharCount = pageCharCount(
      current,
      baseTitle,
      HELP_DETAIL_FOOTER_RESERVE,
    );
    const fieldCharCount = field.name.length + field.value.length;
    const exceedsFieldCount = current.fields.length >= DISCORD_EMBED_LIMITS.fieldsPerEmbed;
    const exceedsPageChars =
      projectedCharCount + fieldCharCount > HELP_DETAIL_SOFT_PAGE_TARGET;

    if (current.fields.length > 0 && (exceedsFieldCount || exceedsPageChars)) {
      pages.push(current);
      current = createPage(undefined);
    }

    current.fields.push(field);
  }

  pages.push(current);

  const cappedPages = pages.slice(0, HELP_DETAIL_MAX_EMBEDS);
  const truncatedPages = pages.length - cappedPages.length;
  const totalPages = cappedPages.length;

  return cappedPages.map((page, index) => {
    const isLastCappedPage = index === cappedPages.length - 1;
    const footer =
      totalPages === 1
        ? "Select another command or click Back to overview."
        : `Help details page ${index + 1}/${totalPages}. Select another command or click Back to overview.`;
    const pageFooter =
      truncatedPages > 0 && isLastCappedPage
        ? buildHelpDetailFooter(footer, truncatedPages, 0)
        : footer;
    return finalizeHelpDetailPage(page, baseTitle, pageFooter);
  });
}

export type HelpRenderState = {
  page: number;
  selectedCommand: string;
  detailView: boolean;
  detailPage: number;
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

function getFwaLeaderDefaultTargetsForCommand(commandName: string): string[] {
  return [...FWA_LEADER_DEFAULT_TARGETS]
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
  state: HelpRenderState,
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
    const exampleLine = `\nExample: \`${usage}\``;
    const descriptionLimit = Math.max(
      0,
      DISCORD_EMBED_LIMITS.fieldValue - exampleLine.length,
    );
    const fieldValue = truncateForDiscord(
      `${truncateForDiscord(cmd.description, descriptionLimit)}${exampleLine}`,
      DISCORD_EMBED_LIMITS.fieldValue,
    );
    embed.addFields({
      name: `/${cmd.name}`,
      value: fieldValue,
      inline: false,
    });
  }

  return embed;
}

function getControls(
  commands: Command[],
  state: HelpRenderState,
  interactionId: string,
  allowPostToChannel: boolean,
  detailPageCount: number,
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
    if (detailPageCount > 1) {
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId(prevId)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(state.detailPage <= 0),
        new ButtonBuilder()
          .setCustomId(nextId)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(state.detailPage >= detailPageCount - 1),
      );
    }
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
  state: HelpRenderState,
  interactionId: string,
  allowPostToChannel: boolean,
) {
  const selected =
    commands.find((cmd) => cmd.name === state.selectedCommand) ?? commands[0];
  const detailEmbeds = state.detailView ? buildHelpDetailEmbeds(selected) : [];
  const selectedDetailPage = Math.max(
    0,
    Math.min(state.detailPage, Math.max(0, detailEmbeds.length - 1)),
  );
  const embeds = state.detailView
    ? [detailEmbeds[selectedDetailPage] ?? detailEmbeds[0] ?? getOverviewEmbed(commands, state)]
    : [getOverviewEmbed(commands, state)];
  const components = getControls(
    commands,
    state,
    interactionId,
    allowPostToChannel,
    detailEmbeds.length,
  );
  return { embeds, components };
}

export function setHelpSelectedCommand(
  state: HelpRenderState,
  commands: Command[],
  commandName: string,
): void {
  const match = commands.find((cmd) => cmd.name === commandName);
  if (!match) return;
  state.selectedCommand = match.name;
  state.detailView = true;
  state.detailPage = 0;
  state.page = Math.floor(
    commands.findIndex((cmd) => cmd.name === match.name) / OVERVIEW_PAGE_SIZE,
  );
}

export function moveHelpDetailPage(
  state: HelpRenderState,
  delta: number,
  pageCount: number,
): void {
  if (pageCount <= 0) {
    state.detailPage = 0;
    return;
  }

  state.detailPage = Math.max(
    0,
    Math.min(state.detailPage + delta, pageCount - 1),
  );
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

    const state: HelpRenderState = {
      page: 0,
      selectedCommand: commands[0]?.name ?? "help",
      detailView: false,
      detailPage: 0,
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
      setHelpSelectedCommand(state, commands, match.name);
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
            const selectedCommand =
              commands.find((cmd) => cmd.name === state.selectedCommand) ??
              commands[0];
            const selectedCommandPageCount = buildHelpDetailEmbeds(
              selectedCommand ?? commands[0],
            ).length;

            if (component.customId === `help-prev:${interaction.id}`) {
              moveHelpDetailPage(
                state,
                -1,
                selectedCommandPageCount,
              );
            } else if (
              component.customId === `help-next:${interaction.id}`
            ) {
              moveHelpDetailPage(
                state,
                1,
                selectedCommandPageCount,
              );
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
              setHelpSelectedCommand(state, commands, found.name);
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


