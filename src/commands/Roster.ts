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
  UserSelectMenuInteraction,
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
  buildRosterReportPingButtonCustomId,
  parseRosterReportPingButtonCustomId,
  parseRosterPingActionButtonCustomId,
  parseRosterPostUsersActionButtonCustomId,
  parseRosterPostUsersGroupSelectMenuCustomId,
  parseRosterPostUsersPlayerSelectMenuCustomId,
  parseRosterPostUsersUserSelectMenuCustomId,
  buildRosterSignupRoleRequirementLines,
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

type RosterMutationAction =
  | "add"
  | "move"
  | "remove"
  | "change_roster"
  | "set_weight"
  | "open"
  | "close"
  | "archive";
type RosterPostSettingsAction =
  | "export"
  | "customize"
  | "add_user"
  | "remove_user"
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

function getAutocompleteUserOptionId(interaction: AutocompleteInteraction): string | null {
  const options = interaction.options as unknown as {
    getUser?: (name: string, required?: boolean) => { id?: string } | null;
    data?: Array<{ name?: string; value?: unknown }>;
  };
  const selectedUser = options.getUser?.("user", false);
  if (selectedUser?.id && String(selectedUser.id).trim().length > 0) {
    return String(selectedUser.id).trim();
  }
  const rawValue = options.data?.find((option) => option.name === "user")?.value;
  return typeof rawValue === "string" && rawValue.trim().length > 0 ? rawValue.trim() : null;
}

function formatRosterDiscordUserSelectionLabel(
  interaction: {
    users?: { get: (userId: string) => unknown };
    members?: { get: (userId: string) => unknown };
  },
  userId: string,
): string {
  const member = (interaction.members?.get(userId) ?? null) as { displayName?: string | null } | null;
  const user = (interaction.users?.get(userId) ?? null) as { username?: string | null } | null;
  const displayName = String(member?.displayName ?? "").trim();
  const username = String(user?.username ?? "").trim();
  const fallback = String(userId ?? "").trim();
  if (displayName) {
    return `${displayName} (@${username || fallback})`;
  }
  return `@${username || fallback}`;
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

function normalizeRosterPingOptionChoice(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "unregistered" || normalized === "missing" || normalized === "everyone") {
    return normalized;
  }
  return null;
}

function describeRosterDisplayColumns(columns: string[] | null | undefined): string {
  const resolved = (Array.isArray(columns) ? columns : []).map((column) => String(column ?? "").trim().toLowerCase());
  if (resolved.length <= 0) {
    return "default";
  }
  const labels = resolved
    .map((column) => {
      if (column === ROSTER_DISPLAY_COLUMNS.TH_LEVEL) return "TH";
      if (column === ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS) return "Townhall Icons";
      if (column === ROSTER_DISPLAY_COLUMNS.INDEX) return "Index";
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

function buildRosterChangeResultSummary(
  result: Awaited<ReturnType<typeof rosterService.changeRosterSignups>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That source roster is no longer available.";
  }
  if (result.outcome === "target_roster_not_found") {
    return "That target roster is no longer available.";
  }
  if (result.outcome === "same_roster") {
    return "Source and target rosters must be different.";
  }
  if (result.outcome === "source_roster_archived") {
    return "That source roster is archived and can no longer be modified.";
  }
  if (result.outcome === "target_roster_archived") {
    return "That target roster is archived and can no longer be modified.";
  }
  if (result.outcome === "target_group_not_found") {
    return "That target roster group is no longer available.";
  }

  const destinationForAccount = (account: { targetGroupName: string | null; targetGroupKey: string }) =>
    account.targetGroupName ?? account.targetGroupKey;
  const lines = result.movedAccounts.map((account) => {
    const destination = destinationForAccount(account);
    const destinationLabel = destination ? `${result.targetRosterTitle} - ${destination}` : result.targetRosterTitle;
    return `Moved ${formatRosterAccountIdentity(account)} to ${destinationLabel}.`;
  });

  if (result.duplicateTags.length > 0) {
    lines.push(`Already on the target roster: ${result.duplicateTags.join(", ")}.`);
  }
  if (result.missingTags.length > 0) {
    lines.push(`Not found on the source roster: ${result.missingTags.join(", ")}.`);
  }
  if (result.blockedAccounts.length > 0) {
    const reason =
      result.outcome === "roster_full"
        ? "Roster full"
        : result.outcome === "account_limit_exceeded"
          ? "Account limit exceeded"
          : result.outcome === "townhall_unavailable"
            ? "Town hall data unavailable"
            : result.outcome === "townhall_out_of_range"
              ? "Town hall out of range"
              : result.outcome === "roster_conflict"
                ? "Roster conflict"
                : "Blocked";
    lines.push(`${reason}: ${formatRosterAccountIdentityList(result.blockedAccounts)}.`);
  }

  return lines.length > 0 ? lines.join("\n") : "No roster signups were changed.";
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

function normalizeRosterMutationLabel(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function buildRosterMutationConfirmationLine(
  action: "add" | "remove",
  account: { playerTag: string; playerName: string | null },
  rosterName: string,
  clanName: string,
): string {
  const verb = action === "add" ? "Added" : "Removed";
  const direction = action === "add" ? "to" : "from";
  const playerName = normalizeRosterMutationLabel(account.playerName, account.playerTag);
  return `${verb} ${playerName} (${account.playerTag}) ${direction} ${rosterName} - ${clanName}`;
}

async function buildRosterMutationConfirmationContent(
  action: "add" | "remove",
  result: Awaited<ReturnType<typeof rosterService.addRosterSignupsForManager>> | Awaited<ReturnType<typeof rosterService.removeRosterSignupsAsManager>>,
): Promise<string> {
  const addResult = result as Awaited<ReturnType<typeof rosterService.addRosterSignupsForManager>>;
  const removeResult = result as Awaited<ReturnType<typeof rosterService.removeRosterSignupsAsManager>>;
  const summary =
    action === "add"
      ? buildRosterSignupResultSummary(addResult)
      : buildRosterRemoveResultSummary(removeResult);
  const rosterView = await rosterService.getRosterView(result.rosterId).catch(() => null);
  if (!rosterView) {
    return summary;
  }

  const rosterName = normalizeRosterMutationLabel(rosterView.roster.title, "Roster");
  const clanName = normalizeRosterMutationLabel(
    rosterView.clanDisplayName ?? normalizeClanTag(rosterView.roster.clanTag ?? "") ?? null,
    "Unknown Clan",
  );
  const accounts =
    action === "add"
      ? addResult.createdAccounts
      : removeResult.removedAccounts;
  if (accounts.length <= 0) {
    return summary;
  }

  const lines = accounts.map((account) =>
    buildRosterMutationConfirmationLine(action, account, rosterName, clanName),
  );
  const hasMixedFailure =
    action === "add" ? addResult.duplicateTags.length > 0 : removeResult.notOwnedTags.length > 0;
  if (!hasMixedFailure) {
    return lines.join("\n");
  }

  return `${lines.join("\n")}\n\n${summary}`;
}

function formatRosterListClanLine(clanName: string | null, clanTag: string | null): string {
  const normalizedClanName = String(clanName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedClanTag = normalizeClanTag(clanTag ?? "");
  if (normalizedClanName && normalizedClanTag) {
    return `${normalizedClanName} (\`${normalizedClanTag}\`)`;
  }
  if (normalizedClanName) {
    return normalizedClanName;
  }
  if (normalizedClanTag) {
    return `\`${normalizedClanTag}\``;
  }
  return "none";
}

async function buildRosterListEmbed(rosters: RosterSummaryRecord[]): Promise<EmbedBuilder> {
  const clanNameByTag = await buildRosterAutocompleteClanNameMap(rosters);
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("Guild Rosters")
    .setDescription(
      rosters.length > 0
        ? "Select a roster in `/roster post`, `/roster manage`, `/roster edit`, or `/roster delete`."
        : "No rosters have been created in this guild yet.",
    );

  for (const roster of rosters.slice(0, 25)) {
    const clanTag = normalizeClanTag(roster.clanTag ?? "") || null;
    const clanName = clanTag ? clanNameByTag.get(clanTag) ?? null : null;
    embed.addFields({
      name: roster.title.slice(0, 100),
      value: [
        `Type: ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""}`,
        `Clan: ${formatRosterListClanLine(clanName, clanTag)}`,
        `State: ${buildRosterStateLabel(roster.lifecycleState)}`,
        `Posted: ${
          roster.postedMessageUrl
            ? `Yes ([Open posted roster](${roster.postedMessageUrl}))`
            : roster.postedMessageId
              ? `Yes${roster.postedChannelId ? ` in <#${roster.postedChannelId}>` : ""}`
              : "No"
        }`,
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

function buildRosterReportEmbed(title: string, body: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${title} Report`)
    .setDescription(body);
}

function buildRosterReportPingButtonRow(rosterId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildRosterReportPingButtonCustomId(rosterId))
      .setLabel("Ping roster")
      .setStyle(ButtonStyle.Primary),
  );
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

function parseRosterNonNegativeIntegerOption(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

  const loadingPayload = await rosterService.buildRosterSignupPayload(rosterId, null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
    emojiClient: interaction.client,
    refreshButtonDisabled: true,
  });
  if (!loadingPayload) {
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
    embeds: [loadingPayload.embed],
    components: loadingPayload.components,
  }).catch(() => undefined);

  const payload = await rosterService.refreshRosterSignupPayload(rosterId, cocService ?? null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
    emojiClient: interaction.client,
    refreshButtonDisabled: false,
  });
  if (!payload) {
    const restoredPayload = await rosterService.buildRosterSignupPayload(rosterId, null, {
      discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
      emojiClient: interaction.client,
      refreshButtonDisabled: false,
    });
    if (restoredPayload) {
      await message.edit({
        embeds: [restoredPayload.embed],
        components: restoredPayload.components,
      }).catch(() => undefined);
    }
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
): Promise<
  | { outcome: "posted"; postedMessageUrl: string | null }
  | { outcome: "refreshed"; postedMessageUrl: string | null }
  | { outcome: "no_payload"; postedMessageUrl: string | null }
  | { outcome: "no_channel"; postedMessageUrl: string | null }
  | { outcome: "failed"; postedMessageUrl: string | null }
> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView) {
    return { outcome: "failed", postedMessageUrl: null };
  }

  const payload = await rosterService.buildRosterSignupPayload(rosterId, cocService ?? null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
    emojiClient: interaction.client,
  });
  if (!payload) {
    return { outcome: "no_payload", postedMessageUrl: rosterView.roster.postedMessageUrl ?? null };
  }

  if (rosterView.roster.postedChannelId && rosterView.roster.postedMessageId) {
    const refreshed = await refreshExistingRosterPost(interaction, rosterId, cocService);
    if (refreshed) {
      return { outcome: "refreshed", postedMessageUrl: rosterView.roster.postedMessageUrl ?? null };
    }
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    return { outcome: "no_channel", postedMessageUrl: rosterView.roster.postedMessageUrl ?? null };
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
    return { outcome: "failed", postedMessageUrl: rosterView.roster.postedMessageUrl ?? null };
  }

  await rosterService.recordRosterPostedMessage({
    rosterId,
    channelId: postedMessage.channelId,
    messageId: postedMessage.id,
    messageUrl: postedMessage.url,
    postedByDiscordUserId: interaction.user.id,
  });
  await syncRosterRolesForRoster(interaction.client, rosterId);
  return { outcome: "posted", postedMessageUrl: postedMessage.url };
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
    { label: "Add User", value: "add_user", description: "Add linked players through an interactive panel" },
    { label: "Remove User", value: "remove_user", description: "Remove linked players through an interactive panel" },
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
    ...buildRosterSignupRoleRequirementLines({
      requiredSignupRoleId: roster.requiredSignupRoleId,
      noRoleSignupLimit: roster.noRoleSignupLimit,
    }),
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
    { label: "Townhall Icons", value: ROSTER_DISPLAY_COLUMNS.TOWNHALL_ICONS },
    { label: "Index", value: ROSTER_DISPLAY_COLUMNS.INDEX },
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

  const loadingPayload = await rosterService.buildRosterSignupPayload(parsed.rosterId, null, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
    emojiClient: interaction.client,
    refreshButtonDisabled: true,
  });
  if (!loadingPayload) {
    await interaction.editReply("That roster is no longer available.");
    return;
  }

  await interaction.editReply({
    embeds: [loadingPayload.embed],
    components: loadingPayload.components,
  });

  const payload = await rosterService.refreshRosterSignupPayload(parsed.rosterId, cocService, {
    discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
    emojiClient: interaction.client,
    refreshButtonDisabled: false,
  });
  if (!payload) {
    const restoredPayload = await rosterService.buildRosterSignupPayload(parsed.rosterId, null, {
      discordDisplayNamesByUserId: buildRosterDiscordDisplayNameMap(interaction),
      emojiClient: interaction.client,
      refreshButtonDisabled: false,
    });
    if (restoredPayload) {
      await interaction.editReply({
        embeds: [restoredPayload.embed],
        components: restoredPayload.components,
      });
    }
    await interaction.followUp({
      content: "That roster is no longer available.",
      ephemeral: true,
    }).catch(() => undefined);
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

  if (choice === "add_user" || choice === "remove_user") {
    const panel = await rosterService.createRosterManagerUserSelectionPanel({
      rosterId: roster.id,
      discordUserId: interaction.user.id,
      mode: choice,
    });
    if (panel.outcome !== "ready") {
      const message =
        panel.outcome === "roster_not_found"
          ? "That roster is no longer available."
          : "That roster can no longer be modified.";
      await interaction.reply({
        content: message,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [panel.panel.embed],
      components: panel.panel.components,
      ephemeral: true,
    });
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
      cocService,
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

async function replyRosterUserPanelStateChange(
  interaction:
    | UserSelectMenuInteraction
    | StringSelectMenuInteraction
    | ButtonInteraction,
  payload: {
    content?: string | null;
    embeds?: EmbedBuilder[];
    components?: any[];
  },
): Promise<void> {
  await interaction.update({
    content: payload.content ?? undefined,
    embeds: payload.embeds ?? [],
    components: payload.components ?? [],
  });
}

export async function handleRosterPostSettingsUserSelectInteraction(
  interaction: UserSelectMenuInteraction,
): Promise<void> {
  const parsed = parseRosterPostUsersUserSelectMenuCustomId(interaction.customId);
  if (!parsed) return;

  const selectedUserId = interaction.values[0] ?? "";
  if (!selectedUserId) {
    await interaction.reply({
      content: "Select a Discord user to continue.",
      ephemeral: true,
    });
    return;
  }

  const result = await rosterService.updateRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    selectedDiscordUserId: selectedUserId,
    selectedDiscordUserLabel: formatRosterDiscordUserSelectionLabel(interaction, selectedUserId),
  });

  if (result.outcome === "session_not_found") {
    await interaction.reply({
      content: "That roster selection has expired. Please start again.",
      ephemeral: true,
    });
    return;
  }
  if (result.outcome === "forbidden") {
    await interaction.reply({
      content: "Only the original requester can use this roster selection.",
      ephemeral: true,
    });
    return;
  }

  await replyRosterUserPanelStateChange(interaction, {
    embeds: [result.panel.embed],
    components: result.panel.components,
  });
}

export async function handleRosterPostSettingsPlayerSelectInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseRosterPostUsersPlayerSelectMenuCustomId(interaction.customId);
  if (!parsed) return;

  const result = await rosterService.updateRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    selectedPlayerTags: interaction.values,
    playerPageIndex: parsed.pageIndex,
  });

  if (result.outcome === "session_not_found") {
    await interaction.reply({
      content: "That roster selection has expired. Please start again.",
      ephemeral: true,
    });
    return;
  }
  if (result.outcome === "forbidden") {
    await interaction.reply({
      content: "Only the original requester can use this roster selection.",
      ephemeral: true,
    });
    return;
  }

  await replyRosterUserPanelStateChange(interaction, {
    embeds: [result.panel.embed],
    components: result.panel.components,
  });
}

export async function handleRosterPostSettingsGroupSelectInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseRosterPostUsersGroupSelectMenuCustomId(interaction.customId);
  if (!parsed) return;

  const result = await rosterService.updateRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    selectedGroupKey: interaction.values[0] ?? null,
  });

  if (result.outcome === "session_not_found") {
    await interaction.reply({
      content: "That roster selection has expired. Please start again.",
      ephemeral: true,
    });
    return;
  }
  if (result.outcome === "forbidden") {
    await interaction.reply({
      content: "Only the original requester can use this roster selection.",
      ephemeral: true,
    });
    return;
  }

  await replyRosterUserPanelStateChange(interaction, {
    embeds: [result.panel.embed],
    components: result.panel.components,
  });
}

export async function handleRosterPostSettingsActionButtonInteraction(
  interaction: ButtonInteraction,
  cocService?: CoCService | null,
): Promise<void> {
  const parsed = parseRosterPostUsersActionButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.action === "cancel") {
    const result = await rosterService.cancelRosterSelectionPanel({
      sessionId: parsed.sessionId,
      discordUserId: interaction.user.id,
    });
    if (result.outcome === "session_not_found") {
      await interaction.reply({
        content: "That roster selection has expired. Please start again.",
        ephemeral: true,
      });
      return;
    }
    if (result.outcome === "forbidden") {
      await interaction.reply({
        content: "Only the original requester can use this roster selection.",
        ephemeral: true,
      });
      return;
    }

    await interaction.update({
      content: "Roster selection cancelled.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (parsed.action === "select_group") {
    const result = await rosterService.updateRosterSelectionPanel({
      sessionId: parsed.sessionId,
      discordUserId: interaction.user.id,
      groupPickerVisible: true,
    });
    if (result.outcome === "session_not_found") {
      await interaction.reply({
        content: "That roster selection has expired. Please start again.",
        ephemeral: true,
      });
      return;
    }
    if (result.outcome === "forbidden") {
      await interaction.reply({
        content: "Only the original requester can use this roster selection.",
        ephemeral: true,
      });
      return;
    }

    await interaction.update({
      embeds: [result.panel.embed],
      components: result.panel.components,
    });
    return;
  }

  if (parsed.action === "previous_page" || parsed.action === "next_page") {
    const result = await rosterService.updateRosterSelectionPanel({
      sessionId: parsed.sessionId,
      discordUserId: interaction.user.id,
      playerPageWindowDelta: parsed.action === "previous_page" ? -1 : 1,
    });
    if (result.outcome === "session_not_found") {
      await interaction.reply({
        content: "That roster selection has expired. Please start again.",
        ephemeral: true,
      });
      return;
    }
    if (result.outcome === "forbidden") {
      await interaction.reply({
        content: "Only the original requester can use this roster selection.",
        ephemeral: true,
      });
      return;
    }

    await interaction.update({
      embeds: [result.panel.embed],
      components: result.panel.components,
    });
    return;
  }

  await interaction.deferUpdate().catch(() => undefined);
  const result = await rosterService.confirmRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    cocService: cocService ?? null,
  });
  if (result.outcome === "session_not_found") {
    await interaction.followUp({
      content: "That roster selection has expired. Please start again.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }
  if (result.outcome === "forbidden") {
    await interaction.followUp({
      content: "Only the original requester can use this roster selection.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }
  if (result.outcome === "missing_user") {
    await interaction.followUp({
      content: "Select a Discord user first.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }
  if (result.outcome === "missing_players") {
    await interaction.followUp({
      content: "Select at least one linked player.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }
  if (result.outcome === "missing_group") {
    await interaction.followUp({
      content: "Select a roster group first.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }

  if (result.outcome === "add_user") {
    await syncRosterRoleAssignments(interaction.client, result.result.rosterId).catch(() => undefined);
    await refreshExistingRosterPost(interaction as unknown as ChatInputCommandInteraction, result.result.rosterId, cocService ?? null).catch(() => undefined);
    const confirmationContent = await buildRosterMutationConfirmationContent("add", result.result);
    await interaction.editReply({
      content: confirmationContent,
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.outcome === "remove_user") {
    await syncRosterRoleAssignments(interaction.client, result.result.rosterId).catch(() => undefined);
    await refreshExistingRosterPost(interaction as unknown as ChatInputCommandInteraction, result.result.rosterId, cocService ?? null).catch(() => undefined);
    const confirmationContent = await buildRosterMutationConfirmationContent("remove", result.result);
    await interaction.editReply({
      content: confirmationContent,
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.outcome === "signup") {
    await syncRosterRoleAssignments(interaction.client, result.result.rosterId).catch(() => undefined);
    await refreshExistingRosterPost(interaction as unknown as ChatInputCommandInteraction, result.result.rosterId, cocService).catch(() => undefined);
    await interaction.update({
      content: buildRosterSignupResultSummary(result.result),
      embeds: [],
      components: [],
    });
    return;
  }

  await refreshExistingRosterPost(interaction as unknown as ChatInputCommandInteraction, result.result.rosterId, cocService).catch(() => undefined);
  await interaction.update({
    content: buildRosterRemoveResultSummary(result.result),
    embeds: [],
    components: [],
  });
}

export async function handleRosterPingActionButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseRosterPingActionButtonCustomId(interaction.customId);
  if (!parsed) return;

  await interaction.deferUpdate().catch(() => undefined);
  const result = await rosterService.confirmRosterPingSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
  });

  if (result.outcome === "session_not_found") {
    await interaction.followUp({
      content: "That roster ping preview has expired. Please start again.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }
  if (result.outcome === "forbidden") {
    await interaction.followUp({
      content: "Only the original requester can use this roster ping preview.",
      ephemeral: true,
    }).catch(() => undefined);
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    await interaction.editReply({
      content: "Could not post the ping to this channel.",
      embeds: [],
      components: [],
    }).catch(() => undefined);
    return;
  }

  try {
    for (const content of result.messageContents) {
      await channel.send({
        content,
      });
    }
    await interaction.editReply({
      content: `Posted ping for ${result.targetCount} player${result.targetCount === 1 ? "" : "s"}.`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    console.error(`[roster] ping_post_failed error=${formatError(error)}`);
    await interaction.editReply({
      content: "Failed to post the ping to the channel.",
      embeds: [],
      components: [],
    }).catch(() => undefined);
  }
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

  const parsed = parseRosterPostCustomizeMenuCustomId(interaction.customId);
  if (!parsed) {
    return;
  }

  const deferred = await interaction.deferUpdate().then(() => true).catch(() => false);

  const sendCustomizeError = async (content: string): Promise<void> => {
    if (deferred || interaction.replied) {
      await interaction.followUp({
        content,
        ephemeral: true,
      }).catch(() => undefined);
      return;
    }

    await interaction.reply({
      content,
      ephemeral: true,
    }).catch(() => undefined);
  };

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await sendCustomizeError("You don't have permission to manage this roster.");
    return;
  }

  if (!interaction.inGuild() || !interaction.guildId) {
    await sendCustomizeError("This command can only be used in a server.");
    return;
  }

  const roster = await rosterService.findGuildRosterById({
    guildId: interaction.guildId,
    rosterId: parsed.rosterId,
  });
  if (!roster) {
    await sendCustomizeError("That roster is no longer available.");
    return;
  }

  if (parsed.kind === "columns") {
    const selectedColumns = normalizeRosterCustomizeColumns(interaction.values) ?? [];
    if (selectedColumns.length <= 0) {
      await sendCustomizeError("Choose at least one column to customize.");
      return;
    }

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

  const normalizedSortBy = normalizeRosterCustomizeSortByChoice(interaction.values[0] ?? "");
  const updated = await rosterService.updateRoster({
    rosterId: roster.id,
    updatedByDiscordUserId: interaction.user.id,
    sortBy: normalizedSortBy === ROSTER_SORT_BY.SIGNED_UP_AT ? null : normalizedSortBy,
  });

  if (!updated) {
    await sendCustomizeError("That roster is no longer available.");
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
  const requiredSignupRoleId = interaction.options.getRole("required-role", false)?.id ?? null;
  const noRoleSignupLimitRaw = interaction.options.getInteger("no-role-signup-limit", false);
  const noRoleSignupLimit = parseRosterNonNegativeIntegerOption(noRoleSignupLimitRaw);
  if (noRoleSignupLimitRaw !== null && noRoleSignupLimit === null) {
    await interaction.editReply("Use a non-negative integer for no-role-signup-limit.");
    return;
  }
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
    requiredSignupRoleId,
    noRoleSignupLimit: noRoleSignupLimit ?? 0,
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
    user: interaction.options.getUser("user", false)?.id ?? null,
    player: interaction.options.getString("player", false),
    clan: interaction.options.getString("clan", false),
  });
  await interaction.editReply({
    embeds: [await buildRosterListEmbed(rosters)],
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
  if (result.outcome === "no_channel") {
    await interaction.editReply("This command can only post to a text channel.");
    return;
  }
  if (result.outcome === "no_payload") {
    await interaction.editReply("Failed to build that roster post.");
    return;
  }
  if (result.outcome === "failed") {
    await interaction.editReply("Failed to post that roster.");
    return;
  }

  if (result.outcome === "posted") {
    await interaction.editReply(`Posted roster ${roster.title} in the current channel.`);
    return;
  }

  await interaction.editReply(
    result.postedMessageUrl
      ? `Refreshed roster ${roster.title}. Original post: [Open posted roster](${result.postedMessageUrl})`
      : `Refreshed roster ${roster.title}.`,
  );
}

async function handleRosterReportSubcommand(
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

  const reportText = await rosterService.buildRosterManagerReadinessText({
    rosterId: roster.id,
    cocService,
    emojiClient: interaction.client,
  });
  if (!reportText) {
    await interaction.editReply("Failed to build the roster report.");
    return;
  }

  await interaction.editReply({
    embeds: [buildRosterReportEmbed(roster.title, reportText)],
    components: [buildRosterReportPingButtonRow(roster.id)],
  });
}

export async function handleRosterReportPingButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRosterReportPingButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.reply({
      content: "You do not have permission to manage this roster.",
      ephemeral: true,
    });
    return;
  }

  const panel = await rosterService.createRosterPingSelectionPanel({
    rosterId: parsed.rosterId,
    discordUserId: interaction.user.id,
    pingOption: "everyone",
    cocService,
  });

  if (panel.outcome === "roster_not_found") {
    await interaction.reply({
      content: "That roster is no longer available.",
      ephemeral: true,
    });
    return;
  }
  if (panel.outcome === "group_not_found") {
    await interaction.reply({
      content: "That roster group is no longer available.",
      ephemeral: true,
    });
    return;
  }
  if (panel.outcome === "no_targets") {
    await interaction.reply({
      content: "No linked roster members matched that ping selection.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [panel.panel.embed],
    components: panel.panel.components,
    ephemeral: true,
  });
}

async function handleRosterPingSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  if (!(await canUseRosterPostTarget(interaction, "roster:manage"))) {
    await interaction.editReply("You do not have permission to manage this roster.");
    return;
  }

  const roster = await resolveRosterForGuild(interaction, interaction.options.getString("roster", true));
  if (!roster) {
    return;
  }

  const pingOption = normalizeRosterPingOptionChoice(interaction.options.getString("ping_option", false)) ?? "everyone";
  const message = interaction.options.getString("message", false)?.trim() ?? null;
  const groupKey = interaction.options.getString("group", false);
  const panel = await rosterService.createRosterPingSelectionPanel({
    rosterId: roster.id,
    discordUserId: interaction.user.id,
    pingOption,
    groupKey,
    message,
    cocService,
  });

  if (panel.outcome === "roster_not_found") {
    await interaction.editReply("That roster is no longer available.");
    return;
  }
  if (panel.outcome === "group_not_found") {
    await interaction.editReply("That roster group is no longer available.");
    return;
  }
  if (panel.outcome === "no_targets") {
    await interaction.editReply("No linked roster members matched that ping selection.");
    return;
  }

  await interaction.editReply({
    embeds: [panel.panel.embed],
    components: panel.panel.components,
  });
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
  const targetRosterId = interaction.options.getString("target_roster", false)?.trim() ?? "";
  const targetGroupKey = interaction.options.getString("target_group", false)?.trim() ?? null;
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

  if (action === "change_roster") {
    if (!targetRosterId) {
      await interaction.editReply("Provide a target roster for this action.");
      return;
    }

    const targetRoster = await rosterService.findGuildRosterById({
      guildId: interaction.guildId,
      rosterId: targetRosterId,
    });
    if (!targetRoster) {
      await interaction.editReply("That target roster is no longer available.");
      return;
    }

      const result = await rosterService.changeRosterSignups({
        sourceRosterId: roster.id,
        targetRosterId: targetRoster.id,
        targetGroupKey,
        playerTags,
        updatedByDiscordUserId: interaction.user.id,
        bypassEligibility: true,
        cocService,
      });

    if (
      result.outcome === "changed" ||
      result.outcome === "nothing_changed" ||
      result.outcome === "roster_conflict" ||
      result.outcome === "townhall_unavailable" ||
      result.outcome === "townhall_out_of_range" ||
      result.outcome === "roster_full" ||
      result.outcome === "account_limit_exceeded"
    ) {
      if (result.movedTags.length > 0) {
        await syncRosterRolesForRoster(interaction.client, roster.id).catch(() => undefined);
        await syncRosterRolesForRoster(interaction.client, targetRoster.id).catch(() => undefined);
        await refreshExistingRosterPost(interaction, roster.id, cocService).catch(() => undefined);
        await refreshExistingRosterPost(interaction, targetRoster.id, cocService).catch(() => undefined);
      }
      await interaction.editReply(buildRosterChangeResultSummary(result));
      return;
    }

    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That source roster is no longer available.");
      return;
    }
    if (result.outcome === "target_roster_not_found") {
      await interaction.editReply("That target roster is no longer available.");
      return;
    }
    if (result.outcome === "same_roster") {
      await interaction.editReply("Source and target rosters must be different.");
      return;
    }
    if (result.outcome === "source_roster_archived") {
      await interaction.editReply("That source roster is archived and can no longer be modified.");
      return;
    }
    if (result.outcome === "target_roster_archived") {
      await interaction.editReply("That target roster is archived and can no longer be modified.");
      return;
    }
    if (result.outcome === "target_group_not_found") {
      await interaction.editReply("That target roster group is no longer available.");
      return;
    }
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
        bypassEligibility: true,
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
  const requiredSignupRoleOption = interaction.options.getRole("required-role", false);
  const requiredSignupRoleId = requiredSignupRoleOption?.id ?? null;
  const clearRequiredSignupRole = interaction.options.getBoolean("clear-required-role", false) ?? false;
  const noRoleSignupLimitRaw = interaction.options.getInteger("no-role-signup-limit", false);
  const noRoleSignupLimit = parseRosterNonNegativeIntegerOption(noRoleSignupLimitRaw);
  if (noRoleSignupLimitRaw !== null && noRoleSignupLimit === null) {
    await interaction.editReply("Use a non-negative integer for no-role-signup-limit.");
    return;
  }
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
    !requiredSignupRoleId &&
    !clearRequiredSignupRole &&
    noRoleSignupLimit === null &&
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
  if (clearRequiredSignupRole && requiredSignupRoleId) {
    await interaction.editReply("Choose either required-role or clear-required-role, not both.");
    return;
  }
  if (clearRequiredSignupRole && noRoleSignupLimitRaw !== null && noRoleSignupLimit === null) {
    await interaction.editReply("Use a non-negative integer for no-role-signup-limit.");
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
    requiredSignupRoleId: clearRequiredSignupRole ? null : requiredSignupRoleId ?? undefined,
    noRoleSignupLimit:
      noRoleSignupLimit !== null
        ? noRoleSignupLimit
        : requiredSignupRoleId
          ? 0
          : undefined,
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

async function autocompleteRosterOption(
  interaction: AutocompleteInteraction,
  excludeRosterId: string | null = null,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options.getFocused(true).value ?? "").trim();
  const rosters = await rosterService.listGuildRosters({
    guildId: interaction.guildId,
    name: focused,
  });
  const filteredRosters =
    excludeRosterId && excludeRosterId.length > 0
      ? rosters.filter((roster) => roster.id !== excludeRosterId)
      : rosters;

  const clanNameByTag = await buildRosterAutocompleteClanNameMap(filteredRosters);

  await interaction.respond(
    filteredRosters.slice(0, 25).map((roster) => {
      const clanTag = normalizeClanTag(roster.clanTag ?? "") || null;
      const clanName = clanTag ? clanNameByTag.get(clanTag) ?? null : null;
      const labelParts = [roster.title];
      if (clanName) {
        labelParts.push(clanName);
      }
      if (clanTag) {
        labelParts.push(clanTag);
      }
      labelParts.push(buildRosterStateLabel(roster.lifecycleState));
      return {
        name: labelParts.join(" • ").slice(0, 100),
        value: roster.id,
        description: `Type ${roster.rosterType}${roster.rosterCategory ? ` / ${roster.rosterCategory}` : ""} • ${roster.postedMessageId ? "posted" : "unposted"} • ${roster.signupCount} signups`.slice(0, 100),
      };
    }),
  );
}

async function buildRosterAutocompleteClanNameMap(
  rosters: Array<Pick<RosterSummaryRecord, "clanTag">>,
): Promise<Map<string, string>> {
  const rosterTags = [...new Set(rosters.map((roster) => normalizeClanTag(roster.clanTag ?? "")).filter(Boolean))];
  if (rosterTags.length <= 0) {
    return new Map();
  }

  const season = resolveCurrentCwlSeasonKey();
  const [trackedRows, raidRows, cwlRows] = await Promise.all([
    prisma.trackedClan.findMany({
      where: { tag: { in: rosterTags } },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { tag: true, name: true },
    }),
    prisma.raidTrackedClan.findMany({
      where: {
        clanTag: {
          in: rosterTags.map((tag) => tag.replace(/^#/, "")),
        },
      },
      orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
      select: { clanTag: true, name: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: { season, tag: { in: rosterTags } },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { tag: true, name: true },
    }),
  ]);

  const clanNameByTag = new Map<string, string>();
  for (const row of trackedRows) {
    const tag = normalizeClanTag(row.tag);
    const name = normalizeRosterTrackedClanAutocompleteName(row.name);
    if (tag && name && !clanNameByTag.has(tag)) {
      clanNameByTag.set(tag, name);
    }
  }
  for (const row of raidRows) {
    const tag = normalizeClanTag(row.clanTag);
    const name = normalizeRosterTrackedClanAutocompleteName(row.name);
    if (tag && name && !clanNameByTag.has(tag)) {
      clanNameByTag.set(tag, name);
    }
  }
  for (const row of cwlRows) {
    const tag = normalizeClanTag(row.tag);
    const name = normalizeRosterTrackedClanAutocompleteName(row.name);
    if (tag && name && !clanNameByTag.has(tag)) {
      clanNameByTag.set(tag, name);
    }
  }

  return clanNameByTag;
}

function normalizeRosterTrackedClanAutocompleteName(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildRosterTrackedClanChoiceLabel(clan: { name: string | null; tag: string }): string {
  const tag = normalizeClanTag(clan.tag);
  const name = normalizeRosterTrackedClanAutocompleteName(clan.name);
  return name ? `${name} (${tag})` : tag;
}

function upsertRosterTrackedClanAutocompleteChoice(
  choiceByTag: Map<string, { tag: string; name: string | null }>,
  tagInput: string,
  nameInput: string | null | undefined,
): void {
  const tag = normalizeClanTag(tagInput);
  if (!tag) return;

  const name = normalizeRosterTrackedClanAutocompleteName(nameInput);
  const existing = choiceByTag.get(tag);
  if (!existing) {
    choiceByTag.set(tag, { tag, name });
    return;
  }

  if (!existing.name && name) {
    choiceByTag.set(tag, { tag, name });
  }
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
  const season = resolveCurrentCwlSeasonKey();
  const [trackedRows, raidRows, cwlRows] = await Promise.all([
    prisma.trackedClan.findMany({
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    }),
    prisma.raidTrackedClan.findMany({
      orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
      select: { name: true, clanTag: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: { season },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    }),
  ]);

  const choiceByTag = new Map<string, { tag: string; name: string | null }>();
  for (const clan of trackedRows) {
    upsertRosterTrackedClanAutocompleteChoice(choiceByTag, clan.tag, clan.name);
  }
  for (const clan of raidRows) {
    upsertRosterTrackedClanAutocompleteChoice(choiceByTag, clan.clanTag, clan.name);
  }
  for (const clan of cwlRows) {
    upsertRosterTrackedClanAutocompleteChoice(choiceByTag, clan.tag, clan.name);
  }

  const choices = [...choiceByTag.values()]
    .map((clan) => {
      const name = buildRosterTrackedClanChoiceLabel(clan).slice(0, 100);
      return { name, value: clan.tag };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
    .filter(
      (choice) =>
        choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
    )
    .slice(0, 25);

  await interaction.respond(choices);
}

async function autocompleteRosterGroup(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "group" && focused.name !== "target_group") {
    await interaction.respond([]);
    return;
  }

  const rosterId = interaction.options
    .getString(focused.name === "target_group" ? "target_roster" : "roster", false)
    ?.trim();
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

async function autocompleteRosterManagePlayers(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "players") {
    await interaction.respond([]);
    return;
  }

  const rosterId = interaction.options.getString("roster", false)?.trim();
  const action = interaction.options.getString("action", false)?.trim().toLowerCase();
  if (
    !rosterId ||
    !action ||
    (action !== "add" && action !== "move" && action !== "remove" && action !== "change_roster")
  ) {
    await interaction.respond([]);
    return;
  }

  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView || rosterView.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.ARCHIVED) {
    await interaction.respond([]);
    return;
  }

  const groupKey = interaction.options.getString("group", false)?.trim() ?? "";
  if (action === "move" && !groupKey) {
    await interaction.respond([]);
    return;
  }
  const normalizedGroupKey = String(groupKey ?? "").trim().toLowerCase();
  const rosterGroups = Array.isArray((rosterView as { groups?: Array<{ key: string }> }).groups)
    ? (rosterView as { groups: Array<{ key: string }> }).groups
    : [];
  if (
    action === "move" &&
    !rosterGroups.some((group) => String(group.key ?? "").trim().toLowerCase() === normalizedGroupKey)
  ) {
    await interaction.respond([]);
    return;
  }

  const query = String(focused.value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "");
  const existingTags = new Set(
    rosterView.signups.map((signup) => normalizePlayerTag(signup.playerTag)).filter(Boolean),
  );
  const selectedUserId = getAutocompleteUserOptionId(interaction);
  const targetRosterId = interaction.options.getString("target_roster", false)?.trim() ?? "";
  const targetRosterView =
    action === "change_roster" && targetRosterId ? await rosterService.getRosterView(targetRosterId) : null;
  if (action === "change_roster") {
    if (!targetRosterId || !targetRosterView) {
      await interaction.respond([]);
      return;
    }
    if (
      targetRosterView.roster.id === rosterView.roster.id ||
      targetRosterView.roster.lifecycleState === ROSTER_LIFECYCLE_STATE.ARCHIVED
    ) {
      await interaction.respond([]);
      return;
    }
  }
  const targetExistingTags =
    action === "change_roster" && targetRosterView
      ? new Set(targetRosterView.signups.map((signup) => normalizePlayerTag(signup.playerTag)).filter(Boolean))
      : new Set<string>();

  const choices =
    action === "add"
      ? (
          await listPlayerLinksForDiscordUser({ discordUserId: interaction.user.id })
        )
          .filter((link) => !existingTags.has(normalizePlayerTag(link.playerTag)))
          .map((link) => {
            const value = normalizePlayerTag(link.playerTag);
            const label = link.linkedName ? `${link.linkedName} (${value})` : value;
            return { name: label.slice(0, 100), value };
          })
      : rosterView.signups
          .filter((signup) => {
            const signupTag = normalizePlayerTag(signup.playerTag);
            if (action === "move") {
              const signupGroupKey = String(signup.group?.key ?? "").trim().toLowerCase();
              return signupGroupKey !== normalizedGroupKey;
            }
            if (action === "change_roster") {
              if (selectedUserId && String(signup.discordUserId ?? "").trim() !== selectedUserId) {
                return false;
              }
              if (targetExistingTags.has(signupTag)) {
                return false;
              }
              return true;
            }
            return true;
          })
          .map((signup) => {
            const value = normalizePlayerTag(signup.playerTag);
            const label = signup.playerName ? `${signup.playerName} (${value})` : value;
            return { name: label.slice(0, 100), value };
          });

  await interaction.respond(
    choices
      .filter((choice) => {
        const searchable = `${choice.name} ${choice.value}`.toLowerCase();
        return searchable.includes(query);
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
      .slice(0, 25),
  );
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
          name: "required-role",
          description: "Discord role required for signup",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "no-role-signup-limit",
          description: "Maximum signups without the required role",
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
          description: "Filter by Discord user",
          type: ApplicationCommandOptionType.User,
          required: false,
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
      name: "ping",
      description: "Preview and ping roster-related members",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "roster",
          description: "Roster to ping from",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "message",
          description: "Optional custom ping message",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "ping_option",
          description: "Who to ping",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Unregistered", value: "unregistered" },
            { name: "Missing", value: "missing" },
            { name: "Everyone", value: "everyone" },
          ],
        },
        {
          name: "group",
          description: "Restrict to a roster group",
          type: ApplicationCommandOptionType.String,
          required: false,
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
            { name: "Change roster", value: "change_roster" },
            { name: "Set weight", value: "set_weight" },
            { name: "Open roster", value: "open" },
            { name: "Close roster", value: "close" },
            { name: "Archive roster", value: "archive" },
          ],
        },
        {
          name: "target_roster",
          description: "Target roster for change roster",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "target_group",
          description: "Target roster group key",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "user",
          description: "Filter source players by Discord user",
          type: ApplicationCommandOptionType.User,
          required: false,
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
          name: "required-role",
          description: "Discord role required for signup",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "no-role-signup-limit",
          description: "Maximum signups without the required role",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
        {
          name: "clear-required-role",
          description: "Clear the required signup role",
          type: ApplicationCommandOptionType.Boolean,
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
      description: "Show a roster report for one roster",
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
      if (subcommand === "ping") {
        await handleRosterPingSubcommand(interaction, cocService);
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
        await handleRosterReportSubcommand(interaction, cocService);
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
    if (focused.name === "target_roster") {
      const sourceRosterId = interaction.options.getString("roster", false)?.trim() ?? null;
      await autocompleteRosterOption(interaction, sourceRosterId);
      return;
    }
    if (focused.name === "group") {
      await autocompleteRosterGroup(interaction);
      return;
    }
    if (focused.name === "target_group") {
      await autocompleteRosterGroup(interaction);
      return;
    }
    if (focused.name === "players") {
      if (interaction.options.getSubcommand(false) === "manage") {
        await autocompleteRosterManagePlayers(interaction);
      } else {
        await interaction.respond([]);
      }
      return;
    }
    if (focused.name === "roster") {
      await autocompleteRosterOption(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
