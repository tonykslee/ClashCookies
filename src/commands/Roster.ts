import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizePlayerTag,
} from "../services/PlayerLinkService";
import { autocompleteSyncTimeZones, normalizeSyncTimeZone } from "../services/syncTimeZone";
import {
  ROSTER_LIFECYCLE_STATE,
  ROSTER_DISPLAY_COLUMNS,
  ROSTER_SORT_BY,
  parseRosterDateTimeInTimeZone,
  buildRosterPostSettingsMenuCustomId,
  isRosterPostSettingsMenuCustomId,
  parseRosterPostRefreshButtonCustomId,
  parseRosterPostSettingsButtonCustomId,
  parseRosterPostSettingsMenuCustomId,
  rosterService,
  type RosterRecord,
  type RosterSignupViewRecord,
  type RosterSummaryRecord,
} from "../services/RosterService";
import {
  parseRosterManageWeightInput,
  rosterWeightService,
} from "../services/RosterWeightService";
import { syncRosterRoleAssignments } from "../services/RosterRoleSyncService";
import { rosterExportService } from "../services/RosterExportService";

export {
  handleRosterSignupButtonInteraction,
  handleRosterRemoveButtonInteraction,
  handleRosterSelectionMenuInteraction,
  handleRosterSelectionActionButtonInteraction,
} from "./Cwl";

const rosterPermissionService = new CommandPermissionService();

type RosterMutationAction = "add" | "move" | "remove" | "set_weight" | "open" | "close" | "archive";
type RosterPostSettingsAction =
  | "export"
  | "customize"
  | "open_roster"
  | "close_roster"
  | "clear_roster"
  | "hide_buttons"
  | "archive_mode"
  | "unregistered_members"
  | "missing_members";

function parseRosterPlayerTags(input: string): string[] {
  return [
    ...new Set(
      String(input ?? "")
        .split(/[\s,]+/g)
        .map((token) => normalizePlayerTag(token))
        .filter(Boolean),
    ),
  ];
}

function formatRosterAccountIdentity(account: { playerTag: string; playerName: string | null }): string {
  return account.playerName ? `${account.playerName} \`${account.playerTag}\`` : `\`${account.playerTag}\``;
}

function formatRosterAccountIdentityList(accounts: Array<{ playerTag: string; playerName: string | null }>): string {
  return accounts.map(formatRosterAccountIdentity).join(", ");
}

function buildRosterStateLabel(state: RosterRecord["lifecycleState"]): string {
  if (state === ROSTER_LIFECYCLE_STATE.ACTIVE) return "Active";
  if (state === ROSTER_LIFECYCLE_STATE.CLOSED) return "Closed";
  if (state === ROSTER_LIFECYCLE_STATE.ARCHIVED) return "Archived";
  return "Open";
}

function buildRosterLifecycleSummary(roster: RosterRecord, lifecycleState: RosterRecord["lifecycleState"]): string {
  const label =
    lifecycleState === ROSTER_LIFECYCLE_STATE.OPEN
      ? "opened"
      : lifecycleState === ROSTER_LIFECYCLE_STATE.CLOSED
        ? "closed"
        : "archived";
  return `${roster.title} was ${label}.`;
}

function describeRosterDisplayColumns(columns: string[] | null | undefined): string {
  const resolved = (Array.isArray(columns) ? columns : []).map((column) => String(column ?? "").trim().toLowerCase());
  if (resolved.length <= 0) {
    return "default";
  }
  const labels = resolved
    .map((column) => {
      if (column === ROSTER_DISPLAY_COLUMNS.TH_LEVEL) return "TH";
      if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_NAME) return "Discord name";
      if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME) return "Discord username";
      if (column === ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID) return "Discord ID";
      if (column === ROSTER_DISPLAY_COLUMNS.PLAYER_NAME) return "Player name";
      if (column === ROSTER_DISPLAY_COLUMNS.PLAYER_TAG) return "Player tag";
      if (column === ROSTER_DISPLAY_COLUMNS.CLAN_NAME) return "Clan name";
      if (column === ROSTER_DISPLAY_COLUMNS.TROPHIES) return "Trophies";
      if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT) return "Weight";
      if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE) return "Weight Source";
      if (column === ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE) return "Weight Age";
      return null;
    })
    .filter((value) => value !== null) as string[];
  return labels.length > 0 ? labels.join(" > ") : "default";
}

function normalizeRosterCustomizeSortByChoice(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === ROSTER_SORT_BY.DISCORD_USER) return ROSTER_SORT_BY.DISCORD_USERNAME;
  if (normalized === ROSTER_SORT_BY.TOWNHALL) return ROSTER_SORT_BY.TOWNHALL_LEVEL;
  if (normalized === ROSTER_SORT_BY.SIGNED_UP_AT) return ROSTER_SORT_BY.SIGNED_UP_AT;
  if (normalized === ROSTER_SORT_BY.PLAYER_NAME) return ROSTER_SORT_BY.PLAYER_NAME;
  if (normalized === ROSTER_SORT_BY.DISCORD_NAME) return ROSTER_SORT_BY.DISCORD_NAME;
  if (normalized === ROSTER_SORT_BY.DISCORD_USERNAME) return ROSTER_SORT_BY.DISCORD_USERNAME;
  if (normalized === ROSTER_SORT_BY.TOWNHALL_LEVEL) return ROSTER_SORT_BY.TOWNHALL_LEVEL;
  if (normalized === ROSTER_SORT_BY.WEIGHT) return ROSTER_SORT_BY.WEIGHT;
  if (normalized === ROSTER_SORT_BY.CLAN_NAME) return ROSTER_SORT_BY.CLAN_NAME;
  if (normalized === ROSTER_SORT_BY.TROPHIES) return ROSTER_SORT_BY.TROPHIES;
  return null;
}

function describeRosterSortByChoice(sortBy: string | null | undefined): string {
  const normalized = normalizeRosterCustomizeSortByChoice(sortBy) ?? ROSTER_SORT_BY.SIGNED_UP_AT;
  if (normalized === ROSTER_SORT_BY.PLAYER_NAME) return "Player name";
  if (normalized === ROSTER_SORT_BY.DISCORD_NAME) return "Discord name";
  if (normalized === ROSTER_SORT_BY.DISCORD_USERNAME) return "Discord username";
  if (normalized === ROSTER_SORT_BY.TOWNHALL_LEVEL) return "Townhall level";
  if (normalized === ROSTER_SORT_BY.WEIGHT) return "Weight";
  if (normalized === ROSTER_SORT_BY.CLAN_NAME) return "Clan name";
  if (normalized === ROSTER_SORT_BY.TROPHIES) return "Trophies";
  return "Signup time";
}

function normalizeRosterCustomizeColumns(columns: string[] | null | undefined): string[] | null {
  const allowed = new Set<string>(Object.values(ROSTER_DISPLAY_COLUMNS));
  const ordered = Array.isArray(columns)
    ? columns.map((column) => String(column ?? "").trim().toLowerCase()).filter((column) => allowed.has(column))
    : [];
  const uniqueOrdered = [...new Set(ordered)];
  return uniqueOrdered.length > 0 ? uniqueOrdered : null;
}

function buildRosterDiscordDisplayNameMap(interaction: { guild?: { members?: { cache: Map<string, { displayName: string }> } | null } | null }): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const members = interaction.guild?.members?.cache;
  if (!members) return map;
  for (const [userId, member] of members.entries()) {
    if (!userId) continue;
    map.set(userId, member?.displayName ?? null);
  }
  return map;
}

function buildRosterSignupResultSummary(result: Awaited<ReturnType<typeof rosterService.addRosterSignupsForManager>>): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "roster_full") {
    return "That roster is full.";
  }
  if (result.outcome === "account_limit_exceeded") {
    return "That user has reached the maximum accounts allowed on this roster.";
  }
  if (result.outcome === "townhall_unavailable") {
    return result.blockedAccounts.length > 0
      ? `Town hall data is unavailable for: ${formatRosterAccountIdentityList(result.blockedAccounts)}.`
      : "Town hall data is unavailable for some selected accounts.";
  }
  if (result.outcome === "townhall_out_of_range") {
    return result.blockedAccounts.length > 0
      ? `Some selected accounts do not meet the town hall requirements: ${formatRosterAccountIdentityList(
          result.blockedAccounts,
        )}.`
      : "Some selected accounts do not meet the town hall requirements.";
  }
  if (result.outcome === "roster_conflict") {
    return "Some selected accounts are already signed up on another roster of this type.";
  }
  if (result.outcome === "group_not_found") {
    return "That roster group is no longer available.";
  }
  if (result.outcome === "no_linked_accounts") {
    return "No linked player accounts were found for those player tags.";
  }
  if (result.outcome === "already_signed_up" && result.createdTags.length <= 0) {
    return result.linkedTags.length > 0
      ? `Those linked accounts were already signed up for ${result.groupName}.`
      : "No linked player accounts were available for signup.";
  }

  const created = result.createdTags.length > 0 ? result.createdTags.join(", ") : "no accounts";
  const duplicateNote =
    result.duplicateTags.length > 0
      ? ` (${result.duplicateTags.length} already signed up)`
      : "";
  return `Signed up ${created} to ${result.groupName}${duplicateNote}.`;
}

function buildRosterMoveResultSummary(result: Awaited<ReturnType<typeof rosterService.moveRosterSignups>>): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "group_not_found") {
    return "That roster group is no longer available.";
  }
  if (result.outcome === "nothing_moved" && result.movedTags.length <= 0) {
    return result.missingTags.length > 0
      ? "None of the selected signups were found on that roster."
      : "No roster signups were moved.";
  }

  const moved = result.movedTags.length > 0 ? result.movedTags.join(", ") : "no signups";
  const duplicate =
    result.duplicateTags.length > 0 ? ` (${result.duplicateTags.length} already in ${result.groupKey})` : "";
  const missing =
    result.missingTags.length > 0 ? ` (${result.missingTags.length} not found on that roster)` : "";
  return `Moved ${moved} to ${result.groupKey}${duplicate}${missing}.`;
}

function buildRosterRemoveResultSummary(
  result: Awaited<ReturnType<typeof rosterService.removeRosterSignupsAsManager>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That roster is no longer available.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }
  if (result.outcome === "nothing_removed" && result.removedTags.length <= 0) {
    return result.notOwnedTags.length > 0
      ? "None of the selected signups were found on that roster."
      : "No roster signups were removed.";
  }

  const removed = result.removedTags.length > 0 ? result.removedTags.join(", ") : "no signups";
  const ignored =
    result.notOwnedTags.length > 0
      ? ` (${result.notOwnedTags.length} not found on that roster)`
      : "";
  return `Removed ${removed}${ignored}.`;
}

function buildRosterListEmbed(rosters: RosterSummaryRecord[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("Guild Rosters")
    .setDescription(
      rosters.length > 0
        ? "Select a roster in `/roster post`, `/roster manage`, `/roster edit`, or `/roster delete`."
        : "No rosters have been created in this guild yet.",
    );

  for (const roster of rosters.slice(0, 25)) {
    embed.addFields({
      name: roster.title.slice(0, 100),
      value: [
        `Type: ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""}`,
        `Clan: ${roster.clanTag ?? "none"}`,
        `State: ${buildRosterStateLabel(roster.lifecycleState)}`,
        `Posted: ${roster.postedMessageId ? `yes${roster.postedChannelId ? ` in <#${roster.postedChannelId}>` : ""}` : "no"}`,
        `Groups: ${roster.groupCount} | Signups: ${roster.signupCount}`,
        `ID: \`${roster.id}\``,
      ].join("\n"),
      inline: false,
    });
  }

  if (rosters.length > 25) {
    embed.setFooter({ text: `Showing first 25 of ${rosters.length} rosters.` });
  }

  return embed;
}

function buildRosterReadinessEmbed(title: string, body: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${title} roster readiness`)
    .setDescription(body);
}

function normalizeRosterCategoryChoice(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase();
  return normalized === "CWL" || normalized === "FWA" ? normalized : null;
}

function normalizeRosterSortByChoice(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    normalized === ROSTER_SORT_BY.SIGNED_UP_AT ||
    normalized === ROSTER_SORT_BY.PLAYER_NAME ||
    normalized === ROSTER_SORT_BY.PLAYER_TAG ||
    normalized === ROSTER_SORT_BY.DISCORD_USER ||
    normalized === ROSTER_SORT_BY.TOWNHALL
  ) {
    return normalized;
  }
  return null;
}

function normalizeRosterRoleIdInput(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const raw = trimmed
    .replace(/^<@&/, "")
    .replace(/>$/, "")
    .trim();
  return /^\d{15,22}$/.test(raw) ? raw : null;
}

function parseRosterIntegerOption(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRosterNameOption(interaction: ChatInputCommandInteraction): {
  name: string | null;
  title: string | null;
  conflict: boolean;
} {
  const name = interaction.options.getString("name", false)?.trim() ?? null;
  const title = interaction.options.getString("title", false)?.trim() ?? null;
  return {
    name,
    title,
    conflict: Boolean(name && title),
  };
}

async function syncRosterRolesForRoster(client: Client, rosterId: string): Promise<void> {
  await syncRosterRoleAssignments(client, rosterId).catch((error) => {
    console.error(`[roster] role_sync_failed rosterId=${rosterId} error=${formatError(error)}`);
  });
}

async function canUseRosterPostTarget(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  target: "roster:manage" | "roster:refresh" | "roster:report",
): Promise<boolean> {
  return rosterPermissionService.canUseAnyTarget([target], interaction as any);
}

async function refreshExistingRosterPost(
  interaction: {
    client: Client;
    guild?: { members?: { cache: Map<string, { displayName: string }> } | null } | null;
  },
  rosterId: string,
  cocService?: CoCService | null,
): Promise<boolean> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView?.roster.postedChannelId || !rosterView.roster.postedMessageId) {
    return false;
  }

  const payload = await rosterService.refreshRosterSignupPayload(rosterId, cocService ?? null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
  });
  if (!payload) {
    return false;
  }

  const channel = await interaction.client.channels.fetch(rosterView.roster.postedChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return false;
  }

  const message = await channel.messages.fetch(rosterView.roster.postedMessageId).catch(() => null);
  if (!message) {
    return false;
  }

  await message.edit({
    embeds: [payload.embed],
    components: payload.components,
  });
  await syncRosterRolesForRoster(interaction.client, rosterId);
  return true;
}

async function postRosterSignupMessage(
  interaction: ChatInputCommandInteraction,
  rosterId: string,
  cocService?: CoCService | null,
): Promise<"posted" | "refreshed" | "no_payload" | "no_channel" | "failed"> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView) {
    return "failed";
  }

  const payload = await rosterService.buildRosterSignupPayload(rosterId, cocService ?? null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
  });
  if (!payload) {
    return "no_payload";
  }

  if (rosterView.roster.postedChannelId && rosterView.roster.postedMessageId) {
    const refreshed = await refreshExistingRosterPost(interaction, rosterId, cocService);
    if (refreshed) {
      return "refreshed";
    }
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    return "no_channel";
  }

  const postedMessage = await channel
    .send({
      embeds: [payload.embed],
      components: payload.components,
    })
    .catch((err) => {
      console.error(`[roster] post_failed error=${formatError(err)}`);
      return null;
    });
  if (!postedMessage) {
    return "failed";
  }

  await rosterService.recordRosterPostedMessage({
    rosterId,
    channelId: postedMessage.channelId,
    messageId: postedMessage.id,
    messageUrl: postedMessage.url,
    postedByDiscordUserId: interaction.user.id,
  });
  await syncRosterRolesForRoster(interaction.client, rosterId);
  return "posted";
}

async function deletePostedRosterMessage(
  interaction: ChatInputCommandInteraction,
  roster: RosterRecord,
): Promise<boolean> {
  if (!roster.postedChannelId || !roster.postedMessageId) {
    return true;
  }

  const channel = await interaction.client.channels.fetch(roster.postedChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return false;
  }

  const message = await channel.messages.fetch(roster.postedMessageId).catch(() => null);
  if (!message) {
    return false;
  }

  try {
    await message.delete();
    return true;
  } catch {
    return false;
  }
}

function buildRosterPostSettingsActions(lifecycleState: RosterRecord["lifecycleState"]) {
  const lifecycleAction =
    lifecycleState === ROSTER_LIFECYCLE_STATE.CLOSED
      ? { label: "Open roster", value: "open_roster", description: "Reopen the roster for signups" }
      : { label: "Close roster", value: "close_roster", description: "Prevent new signups" };

  return [
    { label: "Export", value: "export", description: "Create a Google Sheet export" },
    { label: "Customize", value: "customize", description: "Change board columns and sort order" },
    lifecycleAction,
    { label: "Clear roster", value: "clear_roster", description: "Remove all roster signups" },
    { label: "Hide buttons", value: "hide_buttons", description: "Hide member buttons" },
    { label: "Archive mode", value: "archive_mode", description: "Disable the post actions" },
    {
      label: "Unregistered members",
      value: "unregistered_members",
      description: "List clan members who did not sign up",
    },
    { label: "Missing members", value: "missing_members", description: "List signups not currently in clan" },
  ] as const;
}

function buildRosterPostSettingsMenu(
  rosterId: string,
  lifecycleState: RosterRecord["lifecycleState"],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildRosterPostSettingsMenuCustomId(rosterId))
      .setPlaceholder("Choose a roster action")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        buildRosterPostSettingsActions(lifecycleState).map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description,
        })),
      ),
  );
}

async function resolveRosterForGuild(
  interaction: ChatInputCommandInteraction,
  rosterId: string,
): Promise<RosterRecord | null> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return null;
  }

  const roster = await rosterService.findGuildRosterById({
    guildId: interaction.guildId,
    rosterId,
  });
  if (!roster) {
    await interaction.editReply("That roster is no longer available.");
    return null;
  }
  return roster;
}

async function buildRosterInfoText(rosterId: string): Promise<string | null> {
  const view = await rosterService.getRosterView(rosterId);
  if (!view) return null;

  const roster = view.roster;
  const lines = [
    `${roster.title}${roster.rosterCategory ? ` (${roster.rosterCategory})` : ""}`,
    `Clan: ${roster.clanTag ?? "-"}`,
    `State: ${roster.lifecycleState}`,
    `Posted: ${roster.postedMessageUrl ? "yes" : "no"}`,
    `Groups: ${view.groups.length}`,
    `Signups: ${view.totalSignupCount}`,
    `Min. TH: ${roster.minTownhall ?? "-"}`,
    `Max. TH: ${roster.maxTownhall ?? "-"}`,
    `Roster role: ${roster.rosterRoleId ? `<@&${roster.rosterRoleId}>` : "-"}`,
    `Post buttons: ${roster.postButtonMode}`,
    `Columns: ${describeRosterDisplayColumns(roster.displayColumns)}`,
    `Sort: ${describeRosterSortByChoice(roster.sortBy)}`,
  ];
  return lines.join("\n");
}

async function buildRosterSettingsPanel(rosterId: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
} | null> {
  const view = await rosterService.getRosterView(rosterId);
  if (!view) return null;
  const info = await buildRosterInfoText(rosterId);
  if (!info) return null;

  return {
    embed: new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Roster settings")
      .setDescription(info),
    components: [buildRosterPostSettingsMenu(rosterId, view.roster.lifecycleState)],
  };
}

function buildRosterExportLinkRow(spreadsheetUrl: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open Google Sheet")
      .setStyle(ButtonStyle.Link)
      .setURL(spreadsheetUrl),
  );
}

const ROSTER_POST_CUSTOMIZE_PREFIX = "roster-post-customize";

export function buildRosterPostCustomizeColumnsMenuCustomId(rosterId: string): string {
  return `${ROSTER_POST_CUSTOMIZE_PREFIX}:columns:${String(rosterId ?? "").trim()}`;
}

export function buildRosterPostCustomizeSortMenuCustomId(rosterId: string): string {
  return `${ROSTER_POST_CUSTOMIZE_PREFIX}:sort:${String(rosterId ?? "").trim()}`;
}

export function isRosterPostCustomizeColumnsMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_CUSTOMIZE_PREFIX}:columns:`);
}

export function isRosterPostCustomizeSortMenuCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${ROSTER_POST_CUSTOMIZE_PREFIX}:sort:`);
}

function parseRosterPostCustomizeMenuCustomId(
  customId: string,
): { kind: "columns" | "sort"; rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ROSTER_POST_CUSTOMIZE_PREFIX) {
    return null;
  }
  const kind = parts[1];
  if (kind !== "columns" && kind !== "sort") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { kind, rosterId } : null;
}

function buildRosterCustomizeColumnsMenu(roster: RosterRecord): StringSelectMenuBuilder {
  const selectedColumns =
    normalizeRosterCustomizeColumns(roster.displayColumns) ?? [
      ROSTER_DISPLAY_COLUMNS.TH_LEVEL,
      ROSTER_DISPLAY_COLUMNS.PLAYER_NAME,
      ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME,
      ROSTER_DISPLAY_COLUMNS.CLAN_NAME,
    ];
  const options = [
    { label: "TH level", value: ROSTER_DISPLAY_COLUMNS.TH_LEVEL },
    { label: "Discord name", value: ROSTER_DISPLAY_COLUMNS.DISCORD_NAME },
    { label: "Discord username", value: ROSTER_DISPLAY_COLUMNS.DISCORD_USERNAME },
    { label: "Discord User ID", value: ROSTER_DISPLAY_COLUMNS.DISCORD_USER_ID },
    { label: "Player name", value: ROSTER_DISPLAY_COLUMNS.PLAYER_NAME },
    { label: "Player tag", value: ROSTER_DISPLAY_COLUMNS.PLAYER_TAG },
    { label: "Clan name", value: ROSTER_DISPLAY_COLUMNS.CLAN_NAME },
    { label: "Trophies", value: ROSTER_DISPLAY_COLUMNS.TROPHIES },
    { label: "Weight", value: ROSTER_DISPLAY_COLUMNS.WEIGHT },
    { label: "Weight Source", value: ROSTER_DISPLAY_COLUMNS.WEIGHT_SOURCE },
    { label: "Weight Age", value: ROSTER_DISPLAY_COLUMNS.WEIGHT_AGE },
  ] as const;

  return new StringSelectMenuBuilder()
    .setCustomId(buildRosterPostCustomizeColumnsMenuCustomId(roster.id))
    .setPlaceholder("Choose visible columns")
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(
      options.map((option) => ({
        label: option.label,
        value: option.value,
        default: selectedColumns.includes(option.value),
      })),
    );
}

function buildRosterCustomizeSortMenu(roster: RosterRecord): StringSelectMenuBuilder {
  const selectedSort = normalizeRosterCustomizeSortByChoice(roster.sortBy) ?? ROSTER_SORT_BY.SIGNED_UP_AT;
  return new StringSelectMenuBuilder()
    .setCustomId(buildRosterPostCustomizeSortMenuCustomId(roster.id))
    .setPlaceholder("Choose sort mode")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions([
      { label: "Player name", value: ROSTER_SORT_BY.PLAYER_NAME, default: selectedSort === ROSTER_SORT_BY.PLAYER_NAME },
      { label: "Discord name", value: ROSTER_SORT_BY.DISCORD_NAME, default: selectedSort === ROSTER_SORT_BY.DISCORD_NAME },
      { label: "Discord username", value: ROSTER_SORT_BY.DISCORD_USERNAME, default: selectedSort === ROSTER_SORT_BY.DISCORD_USERNAME },
      {
        label: "Townhall level",
        value: ROSTER_SORT_BY.TOWNHALL_LEVEL,
        default: selectedSort === ROSTER_SORT_BY.TOWNHALL_LEVEL || selectedSort === ROSTER_SORT_BY.TOWNHALL,
      },
      { label: "Weight", value: ROSTER_SORT_BY.WEIGHT, default: selectedSort === ROSTER_SORT_BY.WEIGHT },
      { label: "Clan name", value: ROSTER_SORT_BY.CLAN_NAME, default: selectedSort === ROSTER_SORT_BY.CLAN_NAME },
      {
        label: "Signup time",
        value: ROSTER_SORT_BY.SIGNED_UP_AT,
        default: selectedSort === ROSTER_SORT_BY.SIGNED_UP_AT,
      },
      { label: "Trophies", value: ROSTER_SORT_BY.TROPHIES, default: selectedSort === ROSTER_SORT_BY.TROPHIES },
    ]);
}

async function buildRosterCustomizePanel(rosterId: string): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
} | null> {
  const view = await rosterService.getRosterView(rosterId);
  if (!view) return null;

  const columns = describeRosterDisplayColumns(view.roster.displayColumns);
  const sortBy = describeRosterSortByChoice(view.roster.sortBy);
  return {
    embed: new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Roster customization")
      .setDescription(
        [
          `Configure the posted roster board for **${view.roster.title}**.`,
          `Current columns: ${columns}`,
          `Current sort: ${sortBy}`,
          "",
          "Choose visible columns and sort mode from the menus below.",
          "Changes save immediately after the select menu is submitted.",
        ].join("\n"),
      ),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildRosterCustomizeColumnsMenu(view.roster)),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildRosterCustomizeSortMenu(view.roster)),
    ],
  };
}

const ROSTER_MANAGE_WEIGHT_PREFIX = "roster-manage-weight";

function buildRosterManageWeightOpenButtonCustomId(rosterId: string, playerTag: string): string {
  return `${ROSTER_MANAGE_WEIGHT_PREFIX}:open:${String(rosterId ?? "").trim()}:${normalizePlayerTag(playerTag)}`;
}

function buildRosterManageWeightSubmitModalCustomId(rosterId: string, playerTag: string): string {
  return `${ROSTER_MANAGE_WEIGHT_PREFIX}:submit:${String(rosterId ?? "").trim()}:${normalizePlayerTag(playerTag)}`;
}

function parseRosterManageWeightCustomId(
  customId: string,
): { action: "open" | "submit"; rosterId: string; playerTag: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== ROSTER_MANAGE_WEIGHT_PREFIX) {
    return null;
  }
  const action = parts[1];
  if (action !== "open" && action !== "submit") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  const playerTag = normalizePlayerTag(parts[3] ?? "");
  if (!rosterId || !playerTag) {
    return null;
  }
  return { action, rosterId, playerTag };
}

export function isRosterManageWeightOpenButtonCustomId(customId: string): boolean {
  const parsed = parseRosterManageWeightCustomId(customId);
  return parsed?.action === "open";
}

export function isRosterManageWeightModalCustomId(customId: string): boolean {
  const parsed = parseRosterManageWeightCustomId(customId);
  return parsed?.action === "submit";
}

function buildRosterManageWeightInstructionsPanel(input: {
  roster: RosterRecord;
  signup: RosterSignupViewRecord;
}): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const playerLabel = input.signup.playerName ?? input.signup.playerTag;
  const playerTag = input.signup.playerTag;
  return {
    embed: new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Set weight")
      .setDescription(
        [
          `Set a fallback manual weight for **${input.roster.title}**.`,
          `Player: **${playerLabel}** \`${playerTag}\``,
          "",
          "## How to calculate war weights",
          "1. Post a Friendly Challenge in chat. Scout your base. Click on the gold storage.",
          '2. Tap on "info" button and note the total amount of gold it has.',
          "3. Multiply the amount of gold by 5. That is your war weight.",
          "- Ex: If you have 31,800 gold in your storage, you would do 31,800 × 5 = 159,000. Your war weight would be 159,000.",
          "",
          "All values must end with 000. If they don't, you're doing it wrong.",
          "https://cdn.discordapp.com/attachments/1325245045690863776/1366514475263463434/War_Weight.mp4?ex=68113947&is=680fe7c7&hm=7bec1925bfe7f4c0867942176d29ec291403bb4fb3e5c63d723bf1d9c868179a&",
          "",
          "Click **Set weight** to open the modal.",
        ].join("\n"),
      ),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildRosterManageWeightOpenButtonCustomId(input.roster.id, input.signup.playerTag))
          .setLabel("Set weight")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function buildRosterManageWeightModal(input: {
  roster: RosterRecord;
  signup: RosterSignupViewRecord;
}): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(buildRosterManageWeightSubmitModalCustomId(input.roster.id, input.signup.playerTag))
    .setTitle("Set Weight");
  const weightInput = new TextInputBuilder()
    .setCustomId("weight")
    .setLabel("Weight")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(16)
    .setPlaceholder("145000, 145,000, 145k, or 0 to delete");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(weightInput));
  return modal;
}

function buildRosterClearConfirmationCustomId(action: "confirm" | "cancel", rosterId: string): string {
  return `roster-post-clear:${action}:${rosterId}`;
}

export function isRosterPostClearButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith("roster-post-clear:");
}

export function parseRosterPostClearButtonCustomId(customId: string): { action: "confirm" | "cancel"; rosterId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "roster-post-clear") {
    return null;
  }
  const action = parts[1];
  if (action !== "confirm" && action !== "cancel") {
    return null;
  }
  const rosterId = parts[2]?.trim() ?? "";
  return rosterId ? { action, rosterId } : null;
}

function buildRosterClearConfirmationPanel(rosterId: string): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    embed: new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("Clear roster")
      .setDescription("This will remove every signup from the roster. Confirm only if you want to clear it completely."),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildRosterClearConfirmationCustomId("confirm", rosterId))
          .setLabel("Confirm clear")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(buildRosterClearConfirmationCustomId("cancel", rosterId))
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export async function handleRosterPostRefreshButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRosterPostRefreshButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:refresh"))) {
    await interaction.reply({
      content: "You don't have permission to refresh this roster.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  const payload = await rosterService.refreshRosterSignupPayload(parsed.rosterId, cocService, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
  });
  if (!payload) {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await interaction.editReply({
    embeds: [payload.embed],
    components: payload.components,
  });
}

export async function handleRosterPostSettingsButtonInteraction(
  interaction: ButtonInteraction,
  _cocService?: CoCService | null,
): Promise<void> {
  const parsed = parseRosterPostSettingsButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You don't have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  const panel = await buildRosterSettingsPanel(parsed.rosterId);
  if (!panel) {
    await interaction.reply({
      content: "That roster is no longer available.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [panel.embed],
    components: panel.components,
    ephemeral: true,
  });
}

export async function handleRosterPostSettingsMenuInteraction(
  interaction: StringSelectMenuInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!isRosterPostSettingsMenuCustomId(interaction.customId)) return;
  const parsed = parseRosterPostSettingsMenuCustomId(interaction.customId);
  if (!parsed) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You don't have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  const choice = (interaction.values[0] ?? "") as RosterPostSettingsAction | "";
  const roster = await resolveRosterForGuild(
    interaction as unknown as ChatInputCommandInteraction,
    parsed.rosterId,
  );
  if (!roster) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "That roster is no longer available.",
        ephemeral: true,
      });
    }
    return;
  }

  if (choice === "customize") {
    const panel = await buildRosterCustomizePanel(roster.id);
    if (!panel) {
      await interaction.reply({
        content: "That roster is no longer available.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [panel.embed],
      components: panel.components,
      ephemeral: true,
    });
    return;
  }

  if (choice === "export") {
    await interaction.deferReply({ ephemeral: true }).catch(() => undefined);

    try {
      const exportResult = await rosterExportService.createRosterExport({
        rosterId: roster.id,
      });
      if (!exportResult) {
        await interaction.editReply({
          content: "That roster is no longer available.",
          embeds: [],
          components: [],
        });
        return;
      }

      const panel = await buildRosterSettingsPanel(roster.id);
      if (!panel) {
        await interaction.editReply({
          content: "That roster is no longer available.",
          embeds: [],
          components: [],
        });
        return;
      }

      await interaction.editReply({
        content: "Roster export ready.",
        embeds: [panel.embed],
        components: [...panel.components, buildRosterExportLinkRow(exportResult.spreadsheetUrl)],
      });
    } catch (error) {
      console.error(`[roster] export_failed rosterId=${roster.id} error=${formatError(error)}`);
      await interaction.editReply({
        content: "Unable to create the Google Sheet export right now.",
      });
    }
    return;
  }

  if (choice === "open_roster" || choice === "close_roster") {
    const lifecycleState =
      choice === "open_roster" ? ROSTER_LIFECYCLE_STATE.OPEN : ROSTER_LIFECYCLE_STATE.CLOSED;
    await rosterService.updateRosterLifecycleState({
      rosterId: roster.id,
      lifecycleState,
      updatedByDiscordUserId: interaction.user.id,
    });
    const refreshed = await refreshExistingRosterPost(
      interaction as unknown as ChatInputCommandInteraction,
      roster.id,
      cocService,
    );
    await interaction.update({
      content: lifecycleState === ROSTER_LIFECYCLE_STATE.OPEN ? "Roster opened." : "Roster closed.",
      embeds: [],
      components: [],
    });
    if (!refreshed) {
      await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
    }
    return;
  }

  if (choice === "hide_buttons") {
    await rosterService.updateRosterPostButtonMode({
      rosterId: roster.id,
      postButtonMode: "hidden",
      updatedByDiscordUserId: interaction.user.id,
    });
    await refreshExistingRosterPost(
      interaction as unknown as ChatInputCommandInteraction,
      roster.id,
      cocService,
    ).catch(() => undefined);
    await interaction.update({
      content: "Roster buttons hidden.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (choice === "archive_mode") {
    await rosterService.updateRosterLifecycleState({
      rosterId: roster.id,
      lifecycleState: ROSTER_LIFECYCLE_STATE.ARCHIVED,
      updatedByDiscordUserId: interaction.user.id,
    });
    await rosterService.updateRosterPostButtonMode({
      rosterId: roster.id,
      postButtonMode: "archived",
      updatedByDiscordUserId: interaction.user.id,
    });
    await refreshExistingRosterPost(
      interaction as unknown as ChatInputCommandInteraction,
      roster.id,
      cocService,
    ).catch(() => undefined);
    await interaction.update({
      content: "Roster archived.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (choice === "unregistered_members" || choice === "missing_members") {
    const readiness = await rosterService.buildRosterManagerReadinessView({
      rosterId: roster.id,
    });
    const lines = !readiness
      ? ["That roster is no longer available."]
      : choice === "unregistered_members"
        ? [
            `Unregistered members for ${readiness.roster.title}:`,
            ...(readiness.unsignedTrackedMembers.length > 0
              ? readiness.unsignedTrackedMembers.map((entry) => `- ${entry.playerName} ${entry.playerTag}`)
              : ["- None"]),
          ]
        : [
            `Missing members for ${readiness.roster.title}:`,
            ...(readiness.signedUpButUntracked.length > 0
              ? readiness.signedUpButUntracked.map((entry) => `- ${entry.playerName ?? entry.playerTag} ${entry.playerTag}`)
              : ["- None"]),
          ];
    await interaction.reply({
      content: lines.join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (choice === "clear_roster") {
    const panel = buildRosterClearConfirmationPanel(roster.id);
    await interaction.reply({
      embeds: [panel.embed],
      components: panel.components,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Unsupported roster settings action.",
    ephemeral: true,
  });
}

function formatRosterManageWeightK(weight: number): string {
  return `${Math.trunc(weight / 1000)}k`;
}

export async function handleRosterManageWeightOpenButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isRosterManageWeightOpenButtonCustomId(interaction.customId)) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You do not have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  const parsed = parseRosterManageWeightCustomId(interaction.customId);
  if (!parsed || parsed.action !== "open") {
    return;
  }

  const rosterView = await rosterService.getRosterView(parsed.rosterId);
  const targetSignup = rosterView?.signups.find(
    (signup) => normalizePlayerTag(signup.playerTag) === parsed.playerTag,
  );
  if (!rosterView || !targetSignup) {
    await interaction.reply({
      content: "That player is no longer on this roster.",
      ephemeral: true,
    });
    return;
  }

  await interaction.showModal(
    buildRosterManageWeightModal({
      roster: rosterView.roster,
      signup: targetSignup,
    }),
  );
}

export async function handleRosterManageWeightModalSubmit(
  interaction: ModalSubmitInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!isRosterManageWeightModalCustomId(interaction.customId)) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You do not have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const parsed = parseRosterManageWeightCustomId(interaction.customId);
  if (!parsed || parsed.action !== "submit") {
    return;
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => undefined);

  const rosterView = await rosterService.getRosterView(parsed.rosterId);
  const targetSignup = rosterView?.signups.find(
    (signup) => normalizePlayerTag(signup.playerTag) === parsed.playerTag,
  );
  if (!rosterView || !targetSignup) {
    await interaction.editReply("That player is no longer on this roster.");
    return;
  }

  const rawWeight = interaction.fields.getTextInputValue("weight");
  const parsedWeight = parseRosterManageWeightInput(rawWeight);
  if (parsedWeight === null) {
    await interaction.editReply("Invalid weight. Use formats like `145000`, `145,000`, `145k`, or `0`.");
    return;
  }

  const result = await rosterWeightService.setManualWeightForRoster({
    rosterId: rosterView.roster.id,
    playerTag: targetSignup.playerTag,
    weight: parsedWeight,
    updatedByUserId: interaction.user.id,
  });

  if (result.outcome === "roster_not_found") {
    await interaction.editReply("That roster is no longer available.");
    return;
  }
  if (result.outcome === "player_not_on_roster") {
    await interaction.editReply("That player is no longer on this roster.");
    return;
  }

  await refreshExistingRosterPost(
    interaction as unknown as ChatInputCommandInteraction,
    rosterView.roster.id,
    cocService,
  ).catch(() => undefined);

  if (result.outcome === "deleted") {
    await interaction.editReply(`Removed the manual weight for ${targetSignup.playerName ?? targetSignup.playerTag}.`);
    return;
  }

  await interaction.editReply(
    `Saved manual weight ${formatRosterManageWeightK(result.weight)} for ${
      targetSignup.playerName ?? targetSignup.playerTag
    }.`,
  );
}

export async function handleRosterPostCustomizeMenuInteraction(
  interaction: StringSelectMenuInteraction,
  cocService: CoCService,
): Promise<void> {
  if (
    !isRosterPostCustomizeColumnsMenuCustomId(interaction.customId) &&
    !isRosterPostCustomizeSortMenuCustomId(interaction.customId)
  ) {
    return;
  }

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You don't have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const parsed = parseRosterPostCustomizeMenuCustomId(interaction.customId);
  if (!parsed) {
    return;
  }

  const roster = await rosterService.findGuildRosterById({
    guildId: interaction.guildId,
    rosterId: parsed.rosterId,
  });
  if (!roster) {
    await interaction.reply({
      content: "That roster is no longer available.",
      ephemeral: true,
    });
    return;
  }

  if (parsed.kind === "columns") {
    const selectedColumns = normalizeRosterCustomizeColumns(interaction.values) ?? [];
    if (selectedColumns.length <= 0) {
      await interaction.reply({
        content: "Choose at least one column to customize.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate().catch(() => undefined);

    const updated = await rosterService.updateRoster({
      rosterId: roster.id,
      updatedByDiscordUserId: interaction.user.id,
      displayColumns: selectedColumns,
    });
    if (!updated) {
      await interaction.editReply({
        content: "That roster is no longer available.",
        embeds: [],
        components: [],
      });
      return;
    }

    await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
    const panel = await buildRosterCustomizePanel(roster.id);
    if (!panel) {
      await interaction.editReply({
        content: "That roster is no longer available.",
        embeds: [],
        components: [],
      });
      return;
    }

    await interaction.editReply({
      embeds: [panel.embed],
      components: panel.components,
      content: "Roster columns updated.",
    });
    return;
  }

  await interaction.deferUpdate().catch(() => undefined);

  const normalizedSortBy = normalizeRosterCustomizeSortByChoice(interaction.values[0] ?? "");
  const updated = await rosterService.updateRoster({
    rosterId: roster.id,
    updatedByDiscordUserId: interaction.user.id,
    sortBy: normalizedSortBy === ROSTER_SORT_BY.SIGNED_UP_AT ? null : normalizedSortBy,
  });

  if (!updated) {
    await interaction.editReply({
      content: "That roster is no longer available.",
      embeds: [],
      components: [],
    });
    return;
  }

  await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
  const panel = await buildRosterCustomizePanel(roster.id);
  if (!panel) {
    await interaction.editReply({
      content: "That roster is no longer available.",
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.editReply({
    embeds: [panel.embed],
    components: panel.components,
  });
}

export async function handleRosterPostClearButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRosterPostClearButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You don't have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  const roster = await resolveRosterForGuild(
    interaction as unknown as ChatInputCommandInteraction,
    parsed.rosterId,
  );
  if (!roster) {
    return;
  }

  if (parsed.action === "cancel") {
    await interaction.update({
      content: "Roster clear cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  const result = await rosterService.clearRosterSignups({
    rosterId: roster.id,
    updatedByDiscordUserId: interaction.user.id,
  });
  if (result.outcome === "roster_not_found") {
    await interaction.reply({
      content: "That roster is no longer available.",
      ephemeral: true,
    });
    return;
  }

  await refreshExistingRosterPost(interaction as unknown as ChatInputCommandInteraction, roster.id, cocService).catch(
    () => undefined,
  );
  await interaction.update({
    content:
      result.outcome === "cleared"
        ? `Cleared ${result.removedCount} roster signup${result.removedCount === 1 ? "" : "s"}.`
        : "No roster signups needed clearing.",
    embeds: [],
    components: [],
  });
}

async function handleRosterCreateSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const rosterType = normalizeRosterCategoryChoice(interaction.options.getString("category", false) ?? "CWL");
  if (!rosterType) {
    await interaction.editReply("Use a supported roster category: CWL or FWA.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Use a valid clan tag.");
    return;
  }

  const { name: nameSeed, title: titleSeed, conflict: nameConflict } = resolveRosterNameOption(interaction);
  if (nameConflict) {
    await interaction.editReply("Choose either name or title, not both.");
    return;
  }
  const timezoneSeed = interaction.options.getString("timezone", false);
  const timezone = timezoneSeed ? normalizeSyncTimeZone(timezoneSeed) : "UTC";
  if (timezoneSeed && !timezone) {
    await interaction.editReply(
      "Invalid timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }
  const targetTimezone = timezone ?? "UTC";

  const startsAtSeed = interaction.options.getString("start_time", false);
  const endsAtSeed = interaction.options.getString("end_time", false);
  const startsAt = startsAtSeed ? parseRosterDateTimeInTimeZone(startsAtSeed, targetTimezone) : null;
  if (startsAtSeed && !startsAt) {
    await interaction.editReply("Invalid start_time. Use YYYY-MM-DD HH:mm with a valid timezone.");
    return;
  }
  const endsAt = endsAtSeed ? parseRosterDateTimeInTimeZone(endsAtSeed, targetTimezone) : null;
  if (endsAtSeed && !endsAt) {
    await interaction.editReply("Invalid end_time. Use YYYY-MM-DD HH:mm with a valid timezone.");
    return;
  }

  let defaultName = nameSeed?.trim() ?? "";
  if (rosterType === "CWL") {
    const season = resolveCurrentCwlSeasonKey();
    const trackedClan = await prisma.cwlTrackedClan.findFirst({
      where: {
        season,
        tag: clanTag,
      },
      select: {
        tag: true,
        name: true,
      },
    });
    if (!trackedClan) {
      await interaction.editReply(`No tracked CWL clan found for ${clanTag} in ${season}.`);
      return;
    }
    if (!defaultName) {
      defaultName = `${trackedClan.name?.trim() || trackedClan.tag} CWL Signup (${season})`;
    }
  } else {
    const fwaClan = await prisma.fwaClanMemberCurrent.findFirst({
      where: {
        clanTag,
      },
      select: {
        clanTag: true,
      },
    });
    if (!fwaClan) {
      await interaction.editReply(`No current FWA clan data was found for ${clanTag}.`);
      return;
    }
    if (!defaultName) {
      defaultName = `${clanTag} FWA Roster`;
    }
  }

  const maxMembers = parseRosterIntegerOption(interaction.options.getInteger("max_members", false));
  const maxAccountsPerUser = parseRosterIntegerOption(interaction.options.getInteger("max_accounts_per_user", false));
  const minTownhall = parseRosterIntegerOption(interaction.options.getInteger("min_townhall", false));
  const maxTownhall = parseRosterIntegerOption(interaction.options.getInteger("max_townhall", false));
  const rosterRoleRaw = interaction.options.getString("roster_role", false);
  const rosterRoleId = normalizeRosterRoleIdInput(rosterRoleRaw);
  if (rosterRoleRaw && !rosterRoleId) {
    await interaction.editReply("Use a valid Discord role mention or role ID for roster_role.");
    return;
  }
  const allowMultiSignup = interaction.options.getBoolean("allow_multi_signup", false);
  const sortBy = normalizeRosterSortByChoice(interaction.options.getString("sort_by", false));
  if (interaction.options.getString("sort_by", false) && !sortBy) {
    await interaction.editReply("Use a supported sort_by value.");
    return;
  }
  const importMembers = interaction.options.getBoolean("import_members", false) ?? false;

  const roster = await rosterService.createRoster({
    guildId: interaction.guildId,
    rosterType,
    rosterCategory: "signup",
    name: nameSeed ?? titleSeed ?? defaultName,
    clanTag,
    startsAt: startsAt ?? new Date(),
    endsAt,
    timezone,
    displayTimezone: timezone,
    maxMembers,
    maxAccountsPerUser,
    minTownhall,
    maxTownhall,
    rosterRoleId,
    allowMultiSignup,
    sortBy,
    importMembers,
    lifecycleState: ROSTER_LIFECYCLE_STATE.OPEN,
    createdByDiscordUserId: interaction.user.id,
    updatedByDiscordUserId: interaction.user.id,
    cocService,
  });
  if (importMembers) {
    await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
  }

  await interaction.editReply(
    `Created ${rosterType} roster for ${clanTag}. Use /roster post roster:${roster.id} to publish it.`,
  );
}

async function handleRosterListSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const rosters = await rosterService.listGuildRosters({
    guildId: interaction.guildId,
    name: interaction.options.getString("name", false),
    user: interaction.options.getString("user", false),
    player: interaction.options.getString("player", false),
    clan: interaction.options.getString("clan", false),
  });
  await interaction.editReply({
    embeds: [buildRosterListEmbed(rosters)],
  });
}

async function handleRosterPostSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const rosterId = interaction.options.getString("roster", true);
  const roster = await resolveRosterForGuild(interaction, rosterId);
  if (!roster) {
    return;
  }

  const result = await postRosterSignupMessage(interaction, roster.id, cocService);
  if (result === "no_channel") {
    await interaction.editReply("This command can only post to a text channel.");
    return;
  }
  if (result === "no_payload") {
    await interaction.editReply("Failed to build that roster post.");
    return;
  }
  if (result === "failed") {
    await interaction.editReply("Failed to post that roster.");
    return;
  }

  await interaction.editReply(
    result === "posted"
      ? `Posted roster ${roster.title} in the current channel.`
      : `Refreshed roster ${roster.title}.`,
  );
}

async function handleRosterReportSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const reportText = await rosterService.buildRosterManagerReadinessText({ rosterId: roster.id });
  if (!reportText) {
    await interaction.editReply("Failed to build the roster readiness report.");
    return;
  }

  await interaction.editReply({
    embeds: [buildRosterReadinessEmbed(roster.title, reportText)],
  });
}

async function handleRosterReadinessSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleRosterReportSubcommand(interaction);
}

async function handleRosterRefreshSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const refreshed = await refreshExistingRosterPost(interaction, roster.id, cocService);
  if (!refreshed) {
    await interaction.editReply("That roster has not been posted yet.");
    return;
  }

  await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
  await interaction.editReply(`Refreshed the posted roster for ${roster.title}.`);
}

async function handleRosterManageSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const action = interaction.options.getString("action", true) as RosterMutationAction;
  const playersInput = interaction.options.getString("players", false) ?? "";
  const playerTags = parseRosterPlayerTags(playersInput);

  if (action === "set_weight") {
    if (playerTags.length !== 1) {
      await interaction.editReply("Provide exactly one player tag for set weight.");
      return;
    }

    const rosterView = await rosterService.getRosterView(roster.id);
    const targetSignup = rosterView?.signups.find(
      (signup) => normalizePlayerTag(signup.playerTag) === playerTags[0],
    );
    if (!rosterView || !targetSignup) {
      await interaction.editReply("That player is not signed up on this roster.");
      return;
    }

    const panel = buildRosterManageWeightInstructionsPanel({
      roster: rosterView.roster,
      signup: targetSignup,
    });
    await interaction.editReply({
      embeds: [panel.embed],
      components: panel.components,
    });
    return;
  }

  if (action === "open" || action === "close" || action === "archive") {
    const lifecycleState =
      action === "open"
        ? ROSTER_LIFECYCLE_STATE.OPEN
        : action === "close"
          ? ROSTER_LIFECYCLE_STATE.CLOSED
          : ROSTER_LIFECYCLE_STATE.ARCHIVED;
    const result = await rosterService.updateRosterLifecycleState({
      rosterId: roster.id,
      lifecycleState,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster is no longer available.");
      return;
    }
    await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
    await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(buildRosterLifecycleSummary(roster, lifecycleState));
    return;
  }

  if (playerTags.length <= 0) {
    await interaction.editReply("Provide one or more player tags to update.");
    return;
  }

  if (action === "add" || action === "move") {
    const groupKey = interaction.options.getString("group", false);
    if (!groupKey) {
      await interaction.editReply("Provide a roster group for this action.");
      return;
    }

    if (action === "add") {
      const result = await rosterService.addRosterSignupsForManager({
        rosterId: roster.id,
        groupKey,
        playerTags,
        updatedByDiscordUserId: interaction.user.id,
        cocService,
      });
      await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
      await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
      await interaction.editReply(buildRosterSignupResultSummary(result));
      return;
    }

    const result = await rosterService.moveRosterSignups({
      rosterId: roster.id,
      groupKey,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "group_not_found") {
      await interaction.editReply("That roster group is no longer available.");
      return;
    }
    await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
    await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(buildRosterMoveResultSummary(result));
    return;
  }

  if (action === "remove") {
    const result = await rosterService.removeRosterSignupsAsManager({
      rosterId: roster.id,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
    await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(buildRosterRemoveResultSummary(result));
    return;
  }

  await interaction.editReply("Unsupported roster manage action.");
}

async function handleRosterEditSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const nameSeed = interaction.options.getString("name", false)?.trim() ?? null;
  const categorySeed = normalizeRosterCategoryChoice(interaction.options.getString("category", false));
  if (interaction.options.getString("category", false) && !categorySeed) {
    await interaction.editReply("Use a supported roster category: CWL or FWA.");
    return;
  }

  const clanSeed = interaction.options.getString("clan", false);
  const timezoneSeed = interaction.options.getString("timezone", false);
  const displayTimezoneSeed = interaction.options.getString("display-timezone", false);
  const startsAtSeed = interaction.options.getString("start_time", false);
  const endsAtSeed = interaction.options.getString("end_time", false);
  const rosterRoleRaw = interaction.options.getString("roster_role", false);
  const rosterRoleSeed = normalizeRosterRoleIdInput(rosterRoleRaw);
  if (rosterRoleRaw && !rosterRoleSeed) {
    await interaction.editReply("Use a valid Discord role mention or role ID for roster_role.");
    return;
  }
  const deleteRole = interaction.options.getBoolean("delete_role", false) ?? false;
  const maxMembers = parseRosterIntegerOption(interaction.options.getInteger("max_members", false));
  const maxAccountsPerUser = parseRosterIntegerOption(
    interaction.options.getInteger("max_accounts_per_user", false),
  );
  const minTownhall = parseRosterIntegerOption(interaction.options.getInteger("min_townhall", false));
  const maxTownhall = parseRosterIntegerOption(interaction.options.getInteger("max_townhall", false));
  const allowMultiSignup = interaction.options.getBoolean("allow_multi_signup", false);
  const sortBySeed = interaction.options.getString("sort_by", false);
  const sortBy = sortBySeed ? normalizeRosterSortByChoice(sortBySeed) : null;
  if (sortBySeed && !sortBy) {
    await interaction.editReply("Use a supported sort_by value.");
    return;
  }
  const importMembers = interaction.options.getBoolean("import_members", false);

  if (
    !nameSeed &&
    !categorySeed &&
    !clanSeed &&
    !timezoneSeed &&
    !displayTimezoneSeed &&
    !startsAtSeed &&
    !endsAtSeed &&
    !rosterRoleSeed &&
    !deleteRole &&
    maxMembers === null &&
    maxAccountsPerUser === null &&
    minTownhall === null &&
    maxTownhall === null &&
    allowMultiSignup === null &&
    sortBy === null &&
    importMembers === null
  ) {
    await interaction.editReply("Provide at least one roster field to edit.");
    return;
  }

  if (clanSeed) {
    const normalizedClan = normalizeClanTag(clanSeed);
    if (!normalizedClan) {
      await interaction.editReply("Use a valid tracked CWL clan tag.");
      return;
    }

    const season = resolveCurrentCwlSeasonKey();
    const trackedClan = await prisma.cwlTrackedClan.findFirst({
      where: {
        season,
        tag: normalizedClan,
      },
      select: {
        tag: true,
      },
    });
    if (!trackedClan) {
      await interaction.editReply(`No tracked CWL clan found for ${normalizedClan} in ${season}.`);
      return;
    }
  }

  const timezone = timezoneSeed ? normalizeSyncTimeZone(timezoneSeed) : null;
  if (timezoneSeed && !timezone) {
    await interaction.editReply(
      "Invalid timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }
  const displayTimezone = displayTimezoneSeed ? normalizeSyncTimeZone(displayTimezoneSeed) : null;
  if (displayTimezoneSeed && !displayTimezone) {
    await interaction.editReply(
      "Invalid display timezone. Use a valid IANA timezone like America/New_York, or a supported US alias like EST, EDT, PST, or PDT.",
    );
    return;
  }

  const targetTimezone = timezone ?? roster.timezone;
  const startsAt = startsAtSeed ? parseRosterDateTimeInTimeZone(startsAtSeed, targetTimezone) : undefined;
  if (startsAtSeed && !startsAt) {
    await interaction.editReply("Invalid start_time. Use YYYY-MM-DD HH:mm with a valid timezone.");
    return;
  }
  const endsAt = endsAtSeed ? parseRosterDateTimeInTimeZone(endsAtSeed, targetTimezone) : undefined;
  if (endsAtSeed && !endsAt) {
    await interaction.editReply("Invalid end_time. Use YYYY-MM-DD HH:mm with a valid timezone.");
    return;
  }

  if (deleteRole && rosterRoleSeed) {
    await interaction.editReply("Choose either roster_role or delete_role, not both.");
    return;
  }

  let resolvedRosterType = categorySeed ?? roster.rosterType;
  if (categorySeed || clanSeed) {
    if (resolvedRosterType === "CWL") {
      const season = resolveCurrentCwlSeasonKey();
      const trackedClan = await prisma.cwlTrackedClan.findFirst({
        where: {
          season,
          tag: normalizeClanTag(clanSeed ?? roster.clanTag ?? ""),
        },
        select: {
          tag: true,
        },
      });
      if (!trackedClan) {
        await interaction.editReply(
          `No tracked CWL clan found for ${normalizeClanTag(clanSeed ?? roster.clanTag ?? "") ?? "that tag"} in ${season}.`,
        );
        return;
      }
    } else if (resolvedRosterType === "FWA") {
      const clanTag = normalizeClanTag(clanSeed ?? roster.clanTag ?? "");
      const fwaClan = clanTag
        ? await prisma.fwaClanMemberCurrent.findFirst({
            where: {
              clanTag,
            },
            select: {
              clanTag: true,
            },
          })
        : null;
      if (!fwaClan) {
        await interaction.editReply(
          `No current FWA clan data was found for ${normalizeClanTag(clanSeed ?? roster.clanTag ?? "") ?? "that tag"}.`,
        );
        return;
      }
    }
  }

  const updated = await rosterService.updateRoster({
    rosterId: roster.id,
    name: nameSeed ?? undefined,
    rosterType: categorySeed ?? undefined,
    clanTag: clanSeed ?? undefined,
    timezone: timezone ?? undefined,
    displayTimezone: displayTimezone ?? undefined,
    startsAt,
    endsAt,
    maxMembers,
    maxAccountsPerUser,
    minTownhall,
    maxTownhall,
    rosterRoleId: deleteRole ? null : rosterRoleSeed ?? undefined,
    allowMultiSignup,
    sortBy,
    importMembers,
    updatedByDiscordUserId: interaction.user.id,
  });
  if (!updated) {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
  await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
  await interaction.editReply(`Updated roster ${updated.title}.`);
}

async function handleRosterDeleteSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const postedMessageDeleted = await deletePostedRosterMessage(interaction, roster);
  if (!postedMessageDeleted) {
    await interaction.editReply(
      "I couldn't remove the posted Discord message, so the roster was left intact. Try the delete again once the message cleanup issue is resolved.",
    );
    return;
  }

  const deleted = await rosterService.deleteRoster({
    rosterId: roster.id,
  });
  if (deleted.outcome === "roster_not_found") {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await interaction.editReply(
    deleted.roster.postedMessageId
      ? `Deleted roster ${deleted.roster.title} after removing its posted Discord message and persisted signup data.`
      : `Deleted roster ${deleted.roster.title} and its persisted signup data.`,
  );
}

async function autocompleteRosterOption(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options.getFocused(true).value ?? "").trim();
  const rosters = await rosterService.listGuildRosters({
    guildId: interaction.guildId,
    name: focused,
  });

  await interaction.respond(
    rosters.slice(0, 25).map((roster) => ({
      name: `${roster.title} • ${roster.clanTag ?? "no clan"} • ${buildRosterStateLabel(roster.lifecycleState)}`.slice(0, 100),
      value: roster.id,
      description: `Type ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""} • ${roster.postedMessageId ? "posted" : "unposted"} • ${roster.signupCount} signups`.slice(0, 100),
    })),
  );
}

function buildRosterTrackedClanChoiceLabel(clan: { name: string | null; tag: string }): string {
  const tag = normalizeClanTag(clan.tag);
  const name = clan.name?.trim();
  return name ? `${name} (${tag})` : tag;
}

async function autocompleteRosterTrackedClan(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "clan") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "")
    .trim()
    .toLowerCase();
  const tracked = await prisma.trackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: { name: true, tag: true },
  });

  await interaction.respond(
    tracked
      .map((clan) => {
        const value = normalizeClanTag(clan.tag);
        const name = buildRosterTrackedClanChoiceLabel(clan);
        return { name: name.slice(0, 100), value };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25),
  );
}

async function autocompleteRosterGroup(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "group") {
    await interaction.respond([]);
    return;
  }

  const rosterId = interaction.options.getString("roster", false)?.trim();
  if (!rosterId) {
    await interaction.respond([]);
    return;
  }

  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView) {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "")
    .trim()
    .toLowerCase();
  const groups = [...rosterView.groups].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key) || a.name.localeCompare(b.name),
  );

  await interaction.respond(
    groups
      .map((group) => {
        const label = `${group.name} (${group.key})`;
        return { name: label.slice(0, 100), value: group.key };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25),
  );
}

async function autocompleteRosterPlayers(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "players") {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "");
  const links = await listPlayerLinksForDiscordUser({ discordUserId: interaction.user.id });

  await interaction.respond(
    links
      .map((link) => {
        const value = normalizePlayerTag(link.playerTag);
        const label = link.linkedName ? `${link.linkedName} (${value})` : value;
        return { name: label.slice(0, 100), value };
      })
      .filter((choice) => {
        const searchable = `${choice.name} ${choice.value}`.toLowerCase();
        return searchable.includes(query);
      })
      .slice(0, 25),
  );
}

async function autocompleteRosterUsers(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "user") {
    await interaction.respond([]);
    return;
  }

  const members = interaction.guild?.members?.cache;
  if (!members) {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "")
    .trim()
    .toLowerCase();

  const choices = [...members.values()]
    .filter((member) => Boolean(member?.id) && !member.user?.bot)
    .map((member) => {
      const displayName = String(member.displayName ?? "").trim();
      const username = String(member.user?.username ?? "").trim();
      const value = String(member.id ?? "").trim();
      const label = displayName ? `${displayName} (@${username || value})` : `@${username || value}`;
      const searchable = `${displayName} ${username} ${value}`.toLowerCase();
      return { name: label.slice(0, 100), value, searchable };
    })
    .filter((choice) => choice.searchable.includes(query))
    .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
    .slice(0, 25)
    .map(({ searchable: _searchable, ...choice }) => choice);

  await interaction.respond(choices);
}

export const Roster: Command = {
  name: "roster",
  description: "Create, list, post, and manage persisted rosters",
  options: [
    {
      name: "create",
      description: "Create a CWL or FWA roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "category",
          description: "Roster category",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "CWL", value: "CWL" },
            { name: "FWA", value: "FWA" },
          ],
        },
        {
          name: "name",
          description: "Roster name",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "title",
          description: "Backwards-compatible alias for roster name",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "timezone",
          description: "Timezone to show on the roster",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "start_time",
          description: "Roster start time in YYYY-MM-DD HH:mm",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "end_time",
          description: "Roster end time in YYYY-MM-DD HH:mm",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "max_members",
          description: "Maximum number of signups",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "max_accounts_per_user",
          description: "Maximum accounts per Discord user",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "min_townhall",
          description: "Minimum town hall",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "max_townhall",
          description: "Maximum town hall",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "roster_role",
          description: "Role to apply to roster signups",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "allow_multi_signup",
          description: "Allow multiple linked accounts from one user",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "sort_by",
          description: "Roster signup sort order",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Signed up at", value: ROSTER_SORT_BY.SIGNED_UP_AT },
            { name: "Player name", value: ROSTER_SORT_BY.PLAYER_NAME },
            { name: "Player tag", value: ROSTER_SORT_BY.PLAYER_TAG },
            { name: "Discord user", value: ROSTER_SORT_BY.DISCORD_USER },
            { name: "Town hall", value: ROSTER_SORT_BY.TOWNHALL },
          ],
        },
        {
          name: "import_members",
          description: "Import current clan members into the roster",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "list",
      description: "List guild rosters and their posting status",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "name",
          description: "Filter by roster name",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "user",
          description: "Filter by Discord user ID",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "player",
          description: "Filter by player tag or name",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "clan",
          description: "Filter by clan tag",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "post",
      description: "Post or refresh the signup message for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to post",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "manage",
      description: "Mutate roster signups or lifecycle state",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to manage",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "action",
          description: "Action to perform",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "Add players", value: "add" },
            { name: "Move players", value: "move" },
            { name: "Remove players", value: "remove" },
            { name: "Set weight", value: "set_weight" },
            { name: "Open roster", value: "open" },
            { name: "Close roster", value: "close" },
            { name: "Archive roster", value: "archive" },
          ],
        },
        {
          name: "group",
          description: "Roster group key",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "players",
          description: "Comma or space separated player tags",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "edit",
      description: "Edit roster metadata",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to edit",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "name",
          description: "Roster name",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "category",
          description: "Roster category",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "CWL", value: "CWL" },
            { name: "FWA", value: "FWA" },
          ],
        },
        {
          name: "clan",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "timezone",
          description: "Storage/display timezone",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "start_time",
          description: "Roster start time in YYYY-MM-DD HH:mm",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "end_time",
          description: "Roster end time in YYYY-MM-DD HH:mm",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "max_members",
          description: "Maximum number of signups",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "max_accounts_per_user",
          description: "Maximum accounts per Discord user",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "min_townhall",
          description: "Minimum town hall",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "max_townhall",
          description: "Maximum town hall",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "roster_role",
          description: "Role to apply to roster signups",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "delete_role",
          description: "Detach the configured roster role",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "allow_multi_signup",
          description: "Allow multiple linked accounts from one user",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "sort_by",
          description: "Roster signup sort order",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Signed up at", value: ROSTER_SORT_BY.SIGNED_UP_AT },
            { name: "Player name", value: ROSTER_SORT_BY.PLAYER_NAME },
            { name: "Player tag", value: ROSTER_SORT_BY.PLAYER_TAG },
            { name: "Discord user", value: ROSTER_SORT_BY.DISCORD_USER },
            { name: "Town hall", value: ROSTER_SORT_BY.TOWNHALL },
          ],
        },
        {
          name: "import_members",
          description: "Import current clan members into the roster",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "display-timezone",
          description: "Display timezone override",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "delete",
      description: "Delete a roster and its persisted signup data",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to delete",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "report",
      description: "Show a manager readiness report for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to inspect",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "readiness",
      description: "Show the export-friendly readiness report for one roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to inspect",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "refresh",
      description: "Re-render the posted roster from DB truth",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to refresh",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction, cocService: CoCService) => {
    await interaction.deferReply({ ephemeral: true });

    try {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === "create") {
        await handleRosterCreateSubcommand(interaction, cocService);
        return;
      }
      if (subcommand === "list") {
        await handleRosterListSubcommand(interaction);
        return;
      }
      if (subcommand === "post") {
        await handleRosterPostSubcommand(interaction, cocService);
        return;
      }
      if (subcommand === "manage") {
        await handleRosterManageSubcommand(interaction, cocService);
        return;
      }
      if (subcommand === "edit") {
        await handleRosterEditSubcommand(interaction, cocService);
        return;
      }
      if (subcommand === "delete") {
        await handleRosterDeleteSubcommand(interaction);
        return;
      }
      if (subcommand === "report") {
        await handleRosterReportSubcommand(interaction);
        return;
      }
      if (subcommand === "readiness") {
        await handleRosterReadinessSubcommand(interaction);
        return;
      }
      if (subcommand === "refresh") {
        await handleRosterRefreshSubcommand(interaction, cocService);
        return;
      }

      await interaction.editReply("Unsupported roster subcommand.");
    } catch (err) {
      console.error(`[roster] command_failed error=${formatError(err)}`);
      await interaction.editReply("Failed to load roster data.");
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "timezone" || focused.name === "display-timezone") {
      await interaction.respond(autocompleteSyncTimeZones(focused.value));
      return;
    }
    if (focused.name === "clan") {
      await autocompleteRosterTrackedClan(interaction);
      return;
    }
    if (focused.name === "group") {
      await autocompleteRosterGroup(interaction);
      return;
    }
    if (focused.name === "players") {
      await autocompleteRosterPlayers(interaction);
      return;
    }
    if (focused.name === "user") {
      await autocompleteRosterUsers(interaction);
      return;
    }
    if (focused.name === "roster") {
      await autocompleteRosterOption(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
