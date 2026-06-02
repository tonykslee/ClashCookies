import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "crypto";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { GoogleSheetsAuthError } from "../services/GoogleSheetsService";
import {
  parseRosterSignupButtonCustomId,
  parseRosterRemoveButtonCustomId,
  parseRosterSelectionActionButtonCustomId,
  parseRosterSelectionMenuCustomId,
  parseRosterSelectionGroupMenuCustomId,
  rosterService,
  ROSTER_LIFECYCLE_STATE,
} from "../services/RosterService";
import { showRosterMutationApplyingState } from "../services/RosterInteractionStateService";
import { syncRosterRoleAssignments } from "../services/RosterRoleSyncService";
import { cwlRotationService } from "../services/CwlRotationService";
import { emojiResolverService } from "../services/emoji/EmojiResolverService";
import {
  cwlRotationSheetService,
  rebuildCwlRotationImportTabState,
  type CwlRotationSheetImportConfirmResult,
  type CwlRotationSheetImportPreview,
  type CwlRotationImportRow,
} from "../services/CwlRotationSheetService";
import { cwlStateService } from "../services/CwlStateService";
import { normalizeClanTag, normalizePlayerTag } from "../services/PlayerLinkService";
import { normalizeSyncTimeZone, autocompleteSyncTimeZones } from "../services/syncTimeZone";
import type { CreateCwlRotationRosterPlanResult } from "../services/CwlRotationService";

const CWL_EMBED_COLOR = 0xfee75c;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const CWL_MEMBERS_SAFE_MESSAGE_CHAR_BUDGET = 5500;
const CWL_ROTATION_IMPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const CWL_ROTATION_IMPORT_SESSION_PREFIX = "cwl-rot-import";
const CWL_ROTATION_SHOW_SESSION_PREFIX = "cwl-rot-show";
const CWL_ROTATION_SHOW_OVERVIEW_MAX_OPTIONS = 25;
const CWL_ROTATION_SHOW_DAY_CHOICES = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  name: `Day ${day}`,
  value: day,
}));
type CwlRotationPlanExport = Awaited<ReturnType<typeof cwlRotationService.listActivePlanExports>>[number];
type CwlRotationRosterCreateSuccess = Extract<CreateCwlRotationRosterPlanResult, { outcome: "created" }>;

type CwlRotationImportClanSession = {
  clanKey: string;
  clanTag: string;
  clanName: string | null;
  tabTitle: string;
  tab: CwlRotationSheetImportPreview["matchedClans"][number];
  confirmed: boolean;
  readyToConfirm: boolean;
  reviewRowIds: string[];
  activeRowId: string | null;
};

type CwlRotationImportSession = {
  requestedByUserId: string;
  createdAtMs: number;
  preview: CwlRotationSheetImportPreview;
  baseWarnings: string[];
  overwrite: boolean;
  view: "preview" | "review";
  pageIndex: number;
  previewClanIndex: number;
  activeClanIndex: number;
  clanSessions: CwlRotationImportClanSession[];
};

type CwlRotationImportReviewOption = {
  playerTag: string;
  playerName: string;
  source: "suggested" | "fallback";
  score?: number;
};

type CwlRotationImportReviewOptions = {
  suggested: CwlRotationImportReviewOption[];
  fallback: CwlRotationImportReviewOption[];
  options: CwlRotationImportReviewOption[];
};

const cwlRotationImportSessions = new Map<string, CwlRotationImportSession>();

function formatRelativeTimestamp(value: Date | null): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "unknown";
  }
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

async function resolveTownHallEmojiMap(client: Client): Promise<Map<number, string>> {
  const inventory = await emojiResolverService.fetchApplicationEmojiInventory(client).catch(() => null);
  const renderedByTownHall = new Map<number, string>();
  if (!inventory?.ok) {
    return renderedByTownHall;
  }
  for (let townHall = 1; townHall <= 18; townHall += 1) {
    const rendered = resolveApplicationEmojiRendered(inventory.snapshot, `th${townHall}`);
    if (rendered) {
      renderedByTownHall.set(townHall, rendered);
    }
  }
  return renderedByTownHall;
}

async function resolveNoEntryEmoji(client: Client): Promise<string> {
  const inventory = await emojiResolverService.fetchApplicationEmojiInventory(client).catch(() => null);
  if (!inventory?.ok) {
    return "\u26d4\ufe0f";
  }
  return resolveApplicationEmojiRendered(inventory.snapshot, "no_entry") ?? "\u26d4\ufe0f";
}

function resolveApplicationEmojiRendered(
  snapshot: {
    exactByName: Map<string, { rendered: string }>;
    lowercaseByName: Map<string, { rendered: string }>;
  },
  name: string,
): string | null {
  const normalizedName = String(name ?? "").trim();
  if (!normalizedName) return null;
  const exact = snapshot.exactByName.get(normalizedName);
  if (exact?.rendered) return exact.rendered;
  const lower = snapshot.lowercaseByName.get(normalizedName.toLowerCase());
  if (lower?.rendered) return lower.rendered;
  return null;
}

type CwlRosterContext =
  | {
      kind: "none";
    }
  | {
      kind: "loaded";
      rosterId: string;
      rosterTitle: string | null;
      rosterPostedMessageUrl: string | null;
      signupTagSet: Set<string>;
    }
  | {
      kind: "unavailable";
      rosterId: string;
      rosterTitle: string | null;
      rosterPostedMessageUrl: string | null;
    };

async function resolveCwlRosterContext(input: {
  guildId: string | null;
  clanTag: string;
  season: string;
}): Promise<CwlRosterContext> {
  const guildId = String(input.guildId ?? "").trim();
  if (!guildId) {
    return { kind: "none" };
  }

  const roster = await rosterService.findCwlRosterForClan({
    guildId,
    clanTag: input.clanTag,
    season: input.season,
  });
  if (!roster) {
    return { kind: "none" };
  }

  const rosterId = roster.id;
  const rosterTitle = String(roster.title ?? "").trim() || null;
  const rosterPostedMessageUrl = String(roster.postedMessageUrl ?? "").trim() || null;
  const rosterView = await rosterService.getRosterView(roster.id);
  if (!rosterView) {
    return {
      kind: "unavailable",
      rosterId,
      rosterTitle,
      rosterPostedMessageUrl,
    };
  }

  const signupTagSet = new Set(
    rosterView.signups.map((signup) => normalizePlayerTag(signup.playerTag)).filter((tag): tag is string => Boolean(tag)),
  );

  return {
    kind: "loaded",
    rosterId,
    rosterTitle,
    rosterPostedMessageUrl,
    signupTagSet,
  };
}

function normalizeClanMemberRole(input: unknown): "leader" | "coleader" | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coleader";
  return null;
}

function compareCwlMembersListEntries(
  left: {
    playerTag: string;
    playerName: string;
    townHall: number | null;
    currentWeight?: number | null;
  },
  right: {
    playerTag: string;
    playerName: string;
    townHall: number | null;
    currentWeight?: number | null;
  },
  rosterSignupTagSet: Set<string> | null,
): number {
  const leftInRoster = rosterSignupTagSet?.has(normalizePlayerTag(left.playerTag) ?? "") ?? false;
  const rightInRoster = rosterSignupTagSet?.has(normalizePlayerTag(right.playerTag) ?? "") ?? false;
  if (leftInRoster !== rightInRoster) {
    return leftInRoster ? -1 : 1;
  }

  const leftHasWeight = left.currentWeight !== null && Number.isFinite(left.currentWeight);
  const rightHasWeight = right.currentWeight !== null && Number.isFinite(right.currentWeight);
  if (leftHasWeight !== rightHasWeight) {
    return leftHasWeight ? -1 : 1;
  }
  if (leftHasWeight && rightHasWeight && left.currentWeight !== right.currentWeight) {
    return (right.currentWeight ?? -1) - (left.currentWeight ?? -1);
  }

  const leftTownHall = left.townHall ?? -1;
  const rightTownHall = right.townHall ?? -1;
  if (leftTownHall !== rightTownHall) {
    return rightTownHall - leftTownHall;
  }

  const byName = left.playerName.localeCompare(right.playerName, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return left.playerTag.localeCompare(right.playerTag);
}

function formatCwlMembersRoleBadge(role: string | null | undefined): string {
  const normalized = normalizeClanMemberRole(role);
  return normalized ? "👑" : "";
}

function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCwlRotationOriginalRosterMembers(plan: CwlRotationPlanExport): Array<{
  playerTag: string;
  playerName: string;
}> {
  const rosterRowsValue = (plan.metadata as { rosterRows?: unknown } | null)?.rosterRows;
  if (!Array.isArray(rosterRowsValue)) {
    return [];
  }

  return rosterRowsValue
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const record = row as { playerTag?: unknown; playerName?: unknown };
      const playerTag = normalizePlayerTag(String(record.playerTag ?? ""));
      if (!playerTag) return null;
      const playerName = sanitizeDisplayText(record.playerName);
      return {
        playerTag,
        playerName: playerName || playerTag,
      };
    })
    .filter((row): row is { playerTag: string; playerName: string } => Boolean(row));
}

function buildCwlRotationPlanPlayerNameIndex(plan: CwlRotationPlanExport): Map<string, string> {
  const nameByTag = new Map<string, string>();
  const addEntry = (playerTag: string | null | undefined, playerName: string | null | undefined) => {
    const normalizedTag = normalizePlayerTag(playerTag ?? "");
    const normalizedName = sanitizeDisplayText(playerName ?? "");
    if (!normalizedTag || !normalizedName || nameByTag.has(normalizedTag)) {
      return;
    }
    nameByTag.set(normalizedTag, normalizedName);
  };

  for (const row of ((plan.metadata as { rosterRows?: unknown } | null)?.rosterRows ?? []) as Array<{
    playerTag?: unknown;
    playerName?: unknown;
  }>) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    addEntry(String(row.playerTag ?? ""), String(row.playerName ?? ""));
  }

  for (const member of buildCwlRotationOriginalRosterMembers(plan)) {
    addEntry(member.playerTag, member.playerName);
  }

  for (const day of plan.days) {
    for (const row of day.rows) {
      addEntry(row.playerTag, row.playerName);
    }
  }

  return nameByTag;
}

function sanitizeCwlRotationPlayerName(input: unknown): string {
  return sanitizeDisplayText(input).replace(/`/g, "");
}

function formatCwlRotationPlayerIdentity(input: {
  playerTag: string;
  playerName?: string | null;
}): string {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  const displayTag = normalizedTag || sanitizeDisplayText(input.playerTag);
  const wrappedTag = displayTag ? `\`${displayTag}\`` : "";
  const playerName = sanitizeCwlRotationPlayerName(input.playerName ?? "");
  if (playerName) {
    return wrappedTag ? `${playerName} ${wrappedTag}` : playerName;
  }
  return wrappedTag;
}

function formatCwlRotationExcludedPlayerLabel(input: {
  playerTag: string;
  playerNameByTag: Map<string, string>;
}): string {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  if (!normalizedTag) {
    const rawTag = sanitizeDisplayText(input.playerTag);
    return rawTag ? `\`${rawTag.replace(/`/g, "")}\`` : "";
  }
  const playerName = input.playerNameByTag.get(normalizedTag);
  return formatCwlRotationPlayerIdentity({
    playerTag: normalizedTag,
    playerName,
  });
}

function buildCwlRotationRosterTagSet(plan: CwlRotationPlanExport): Set<string> {
  return new Set(buildCwlRotationOriginalRosterMembers(plan).map((member) => member.playerTag));
}

function renderTownHallIcon(
  townHall: number | null | undefined,
  townHallEmojiByLevel: Map<number, string>,
): string {
  const normalized = Math.trunc(Number(townHall));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "TH?";
  }
  return townHallEmojiByLevel.get(normalized) ?? `TH${normalized}`;
}

function buildDescription(lines: string[]): string {
  const description = lines.join("\n");
  if (description.length <= DISCORD_DESCRIPTION_LIMIT) {
    return description;
  }
  return `${description.slice(0, DISCORD_DESCRIPTION_LIMIT - 13)}\n...truncated`;
}

function splitLinesIntoDiscordEmbedDescriptions(lines: string[]): string[] {
  const descriptions: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length === 0) {
      current = line;
      continue;
    }
    const candidate = `${current}\n${line}`;
    if (candidate.length <= DISCORD_DESCRIPTION_LIMIT) {
      current = candidate;
      continue;
    }
    descriptions.push(current);
    current = line;
  }

  if (current.length > 0) {
    descriptions.push(current);
  }

  return descriptions.length > 0 ? descriptions : [""];
}

function chunkLinesForDiscordMessages(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const candidateLength = currentLength + (currentChunk.length > 0 ? 1 : 0) + line.length;
    if (currentChunk.length > 0 && candidateLength > CWL_MEMBERS_SAFE_MESSAGE_CHAR_BUDGET) {
      chunks.push(currentChunk);
      currentChunk = [line];
      currentLength = line.length;
      continue;
    }
    currentChunk.push(line);
    currentLength = candidateLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function buildCwlMembersMessageEmbeds(input: {
  clanTag: string;
  chunkLines: string[];
  chunkIndex: number;
  chunkCount: number;
}): EmbedBuilder[] {
  const descriptions = splitLinesIntoDiscordEmbedDescriptions(input.chunkLines);
  return descriptions.map((description, descriptionIndex) => {
    const embed = new EmbedBuilder().setColor(CWL_EMBED_COLOR).setDescription(description);
    if (input.chunkIndex === 0 && descriptionIndex === 0) {
      embed.setTitle(`/cwl members ${input.clanTag}`);
    } else if (descriptionIndex === 0) {
      embed.setTitle(`/cwl members ${input.clanTag} (continued ${input.chunkIndex + 1}/${input.chunkCount})`);
    } else {
      embed.setTitle(`/cwl members ${input.clanTag} (continued)`);
    }
    if (input.chunkCount > 1 || descriptions.length > 1) {
      embed.setFooter({
        text:
          input.chunkCount > 1
            ? `Part ${descriptionIndex + 1}/${descriptions.length} | Message ${input.chunkIndex + 1}/${input.chunkCount}`
            : `Part ${descriptionIndex + 1}/${descriptions.length}`,
      });
    }
    return embed;
  });
}

function buildCwlMembersRosterLine(input: CwlRosterContext): string {
  if (input.kind === "none") {
    return "Roster: none found";
  }
  const rosterTitle = String(input.rosterTitle ?? "").trim() || "Roster";
  const postedMessageUrl = String(input.rosterPostedMessageUrl ?? "").trim();
  const rosterLabel = postedMessageUrl ? `[${rosterTitle}](<${postedMessageUrl}>)` : rosterTitle;
  if (input.kind === "unavailable") {
    return `Roster: ${rosterLabel} (signups unavailable)`;
  }
  return `Roster: ${rosterLabel}`;
}

function buildCwlMembersSignedUpCountLabel(context: CwlRosterContext, count: number | null): string {
  return context.kind === "loaded" && count !== null ? String(count) : "unavailable";
}

function buildCwlMembersExclusionCopyText(context: CwlRosterContext, tags: string[]): string {
  if (context.kind === "none") {
    return "none";
  }
  if (context.kind === "unavailable") {
    return "unavailable";
  }
  return tags.length > 0 ? `\`${tags.join(" ")}\`` : "none";
}

function formatCwlRotationClanLabel(clanName: string | null, clanTag: string): string {
  return clanName ? `${clanName} (${clanTag})` : clanTag;
}

function formatCwlRotationCreateExcludedPlayerLabel(account: { playerTag: string; playerName: string | null }): string {
  return formatRosterConflictAccountIdentity(account);
}

function buildCwlRotationCreateSourceLine(input: {
  rosterId: string | null;
  rosterTitle: string | null;
  rosterPostedMessageUrl: string | null;
}): string {
  if (!input.rosterId) {
    return "Source: observed CWL roster";
  }
  const rosterTitle = String(input.rosterTitle ?? "").trim() || "Roster";
  const rosterPostedMessageUrl = String(input.rosterPostedMessageUrl ?? "").trim();
  if (rosterPostedMessageUrl) {
    return `Roster: [${rosterTitle}](<${rosterPostedMessageUrl}>)`;
  }
  return `Roster: ${rosterTitle} (not posted)`;
}

function buildCwlRotationCreateExcludedSectionLines(excludedPlayers: Array<{ playerTag: string; playerName: string | null }>): string[] {
  if (excludedPlayers.length <= 0) {
    return ["Players excluded: 0", "Excluded members: none"];
  }
  return [
    `Players excluded: ${excludedPlayers.length}`,
    "Excluded members:",
    ...excludedPlayers.map((player) => `- ${formatCwlRotationCreateExcludedPlayerLabel(player)}`),
  ];
}

function buildCwlRotationCreateMessageEmbeds(input: {
  clanTag: string;
  chunkLines: string[];
  chunkIndex: number;
  chunkCount: number;
}): EmbedBuilder[] {
  const descriptions = splitLinesIntoDiscordEmbedDescriptions(input.chunkLines);
  return descriptions.map((description, descriptionIndex) => {
    const embed = new EmbedBuilder().setColor(CWL_EMBED_COLOR).setDescription(description);
    if (input.chunkIndex === 0 && descriptionIndex === 0) {
      embed.setTitle(`/cwl rotations create ${input.clanTag}`);
    } else if (descriptionIndex === 0) {
      embed.setTitle(`/cwl rotations create ${input.clanTag} (continued ${input.chunkIndex + 1}/${input.chunkCount})`);
    } else {
      embed.setTitle(`/cwl rotations create ${input.clanTag} (continued)`);
    }
    if (input.chunkCount > 1 || descriptions.length > 1) {
      embed.setFooter({
        text:
          input.chunkCount > 1
            ? `Part ${descriptionIndex + 1}/${descriptions.length} | Message ${input.chunkIndex + 1}/${input.chunkCount}`
            : `Part ${descriptionIndex + 1}/${descriptions.length}`,
      });
    }
    return embed;
  });
}

function formatRosterAccountIdentity(account: { playerTag: string; playerName: string | null }): string {
  return account.playerName ? `${account.playerName} \`${account.playerTag}\`` : `\`${account.playerTag}\``;
}

function formatRosterConflictAccountIdentity(account: { playerTag: string; playerName: string | null }): string {
  const playerName = String(account.playerName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return playerName ? `${playerName} (${account.playerTag})` : account.playerTag;
}

function formatRosterAccountIdentityList(accounts: Array<{ playerTag: string; playerName: string | null }>): string {
  return accounts.map(formatRosterAccountIdentity).join(", ");
}

function formatRosterSignupResultSummary(result: Awaited<ReturnType<typeof rosterService.signupLinkedAccounts>>): string {
  const warnings = result.warnings ?? [];
  const issueWarning = warnings.find((warning) => warning.startsWith("Unable to sign up some accounts:")) ?? null;
  if (issueWarning) {
    const summary =
      result.createdTags.length > 0
        ? `Signed up ${result.createdTags.join(", ")} to ${result.groupName}${
            result.duplicateTags.length > 0 ? ` (${result.duplicateTags.length} already signed up)` : ""
          }.`
        : issueWarning;
    const extraWarnings = warnings.filter((warning) => warning !== issueWarning);
    return extraWarnings.length > 0 ? `${summary}\n${extraWarnings.join("\n")}` : summary;
  }

  let summary = "";
  if (result.outcome === "roster_not_found") {
    summary = "That roster no longer exists.";
  } else if (result.outcome === "roster_closed") {
    summary = "Signups are closed for that roster.";
  } else if (result.outcome === "roster_archived") {
    summary = "That roster is archived.";
  } else if (result.outcome === "roster_full") {
    summary = "That roster is full.";
  } else if (result.outcome === "account_limit_exceeded") {
    summary = "You have reached the maximum accounts allowed on that roster.";
  } else if (result.outcome === "townhall_unavailable") {
    summary =
      result.blockedAccounts.length > 0
        ? `Town hall data is unavailable for: ${formatRosterAccountIdentityList(result.blockedAccounts)}.`
        : "Town hall data is unavailable for some selected accounts.";
  } else if (result.outcome === "townhall_out_of_range") {
    summary =
      result.blockedAccounts.length > 0
        ? `Some selected accounts do not meet the town hall requirements: ${formatRosterAccountIdentityList(
            result.blockedAccounts,
          )}.`
        : "Some selected accounts do not meet the town hall requirements.";
  } else if (result.outcome === "minimum_weight_unavailable") {
    summary =
      result.blockedAccounts.length > 0
        ? `Minimum weight could not be determined for: ${formatRosterAccountIdentityList(result.blockedAccounts)}.`
        : "Minimum weight could not be determined for some selected accounts.";
  } else if (result.outcome === "minimum_weight_below_minimum") {
    summary =
      result.blockedAccounts.length > 0
        ? `Some selected accounts do not meet the minimum weight requirement: ${formatRosterAccountIdentityList(
            result.blockedAccounts,
          )}.`
        : "Some selected accounts do not meet the minimum weight requirement.";
  } else if (result.outcome === "signup_role_required") {
    summary = `This roster requires <@&${result.requiredSignupRoleId}>. The no-role signup allowance has already been used.`;
  } else if (result.outcome === "cwl_roster_conflict") {
    const lines =
      result.conflictingAccounts.length > 0
        ? result.conflictingAccounts.map(
            (account) => `- ${formatRosterConflictAccountIdentity(account)} → ${account.conflictingRosterTitle}`,
          )
        : [];
    summary =
      lines.length > 0
        ? `These accounts are already signed up on another CWL roster:\n${lines.join("\n")}`
        : "Some selected accounts are already signed up on another CWL roster.";
  } else if (result.outcome === "roster_conflict") {
    summary = "Some selected accounts are already signed up on another roster of this type.";
  } else if (result.outcome === "group_not_found") {
    summary = "That roster group is no longer available.";
  } else if (result.outcome === "no_linked_accounts") {
    summary = "No linked player accounts were found for your Discord user.";
  } else if (result.outcome === "already_signed_up" && result.createdTags.length <= 0) {
    summary = result.linkedTags.length > 0
      ? `Those linked accounts were already signed up for ${result.groupName}.`
      : "No linked player accounts were available for signup.";
  } else {
    const created = result.createdTags.length > 0 ? result.createdTags.join(", ") : "no accounts";
    const duplicateNote =
      result.duplicateTags.length > 0
        ? ` (${result.duplicateTags.length} already signed up)`
        : "";
    summary = `Signed up ${created} to ${result.groupName}${duplicateNote}.`;
  }
  return result.warnings && result.warnings.length > 0 ? `${summary}\n${result.warnings.join("\n")}` : summary;
}

function formatCwlRotationNotEnoughPlayersResult(result: {
  clanTag: string;
  lineupSize: number;
  availablePlayers: number;
  diagnostics?:
    | {
        sourceMode: "manual_observed_season_roster" | "explicit_signup_roster";
        observedSeasonRosterCount: number;
        correspondingSignupRosterCount: number | null;
        currentRoundMemberCount: number | null;
        excludedCount: number;
        eligibleAfterExclusionsCount: number;
      }
    | null;
}): string {
  const lines = [
    `Not enough CWL roster members remain after exclusions for ${result.clanTag}. Need ${result.lineupSize}, have ${result.availablePlayers}.`,
  ];
  if (result.diagnostics) {
    const diagnostics = result.diagnostics;
    lines.push(`Source: ${diagnostics.sourceMode}`);
    lines.push(`Observed season roster: ${diagnostics.observedSeasonRosterCount}`);
    if (diagnostics.correspondingSignupRosterCount !== null) {
      lines.push(`Confirmed signup roster: ${diagnostics.correspondingSignupRosterCount}`);
    }
    if (diagnostics.currentRoundMemberCount !== null) {
      lines.push(`Current round members: ${diagnostics.currentRoundMemberCount}`);
    }
    lines.push(`Excluded: ${diagnostics.excludedCount}`);
    lines.push(`Eligible after exclusions: ${diagnostics.eligibleAfterExclusionsCount}`);
  }
  return lines.join("\n");
}

function formatRosterRemoveResultSummary(
  result: Awaited<ReturnType<typeof rosterService.removeRosterSignups>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That roster no longer exists.";
  }
  if (result.outcome === "roster_archived") {
    return "That roster is archived and can no longer be modified.";
  }

  if (result.outcome === "nothing_removed" && result.removedTags.length <= 0) {
    return result.notOwnedTags.length > 0
      ? "None of the selected signups were yours to remove."
      : "No roster signups were removed.";
  }

  const removed = result.removedTags.length > 0 ? result.removedTags.join(", ") : "no signups";
  const ignored =
    result.notOwnedTags.length > 0
      ? ` (${result.notOwnedTags.length} not owned by you)`
      : "";
  return `Removed ${removed}${ignored}.`;
}

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

function formatRosterManagerRemoveResultSummary(
  result: Awaited<ReturnType<typeof rosterService.removeRosterSignupsAsManager>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That roster no longer exists.";
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

function formatRosterManagerMoveResultSummary(
  result: Awaited<ReturnType<typeof rosterService.moveRosterSignups>>,
): string {
  if (result.outcome === "roster_not_found") {
    return "That roster no longer exists.";
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

function buildRosterManagerLifecycleSummary(
  rosterTitle: string,
  lifecycleState: "OPEN" | "CLOSED" | "ARCHIVED",
): string {
  const label =
    lifecycleState === "OPEN" ? "opened" : lifecycleState === "CLOSED" ? "closed" : "archived";
  return `${rosterTitle} was ${label}.`;
}

async function refreshRosterSignupPost(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  rosterId: string,
  cocService?: CoCService | null,
): Promise<void> {
  const rosterView = await rosterService.getRosterView(rosterId);
  if (!rosterView?.roster.postedChannelId || !rosterView.roster.postedMessageId) {
    return;
  }

  const loadingPayload = await rosterService.buildRosterSignupPayload(rosterId, null, {
    emojiClient: interaction.client,
    refreshButtonDisabled: true,
  });
  if (!loadingPayload) {
    return;
  }

  const channel = await interaction.client.channels.fetch(rosterView.roster.postedChannelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) {
    return;
  }

  const message = await channel.messages.fetch(rosterView.roster.postedMessageId).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [loadingPayload.embed],
    components: loadingPayload.components,
  }).catch(() => undefined);

  const payload = cocService
    ? await rosterService.refreshRosterSignupPayload(rosterId, cocService, {
        emojiClient: interaction.client,
        refreshButtonDisabled: false,
      })
    : await rosterService.buildRosterSignupPayload(rosterId, null, {
        emojiClient: interaction.client,
        refreshButtonDisabled: false,
      });
  if (!payload) {
    const restoredPayload = await rosterService.buildRosterSignupPayload(rosterId, null, {
      emojiClient: interaction.client,
      refreshButtonDisabled: false,
    });
    if (restoredPayload) {
      await message.edit({
        embeds: [restoredPayload.embed],
        components: restoredPayload.components,
      }).catch(() => undefined);
    }
    return;
  }

  await message.edit({
    embeds: [payload.embed],
    components: payload.components,
  }).catch(() => undefined);
  await syncRosterRoleAssignments(interaction.client, rosterId).catch(() => undefined);
}

async function resolveCwlRotationOverviewStatusIcons(client: Client): Promise<{ yes: string; no: string }> {
  const fallback = { yes: ":yes:", no: ":no:" };
  try {
    const result = await emojiResolverService.fetchApplicationEmojiInventory(client);
    if (!result.ok) return fallback;
    return {
      yes: result.snapshot.exactByName.get("yes")?.rendered ?? result.snapshot.lowercaseByName.get("yes")?.rendered ?? fallback.yes,
      no: result.snapshot.exactByName.get("no")?.rendered ?? result.snapshot.lowercaseByName.get("no")?.rendered ?? fallback.no,
    };
  } catch {
    return fallback;
  }
}

function formatCwlRotationOverviewStatusLabel(status: string): string {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "complete" || normalized === "completed") return "✅";
  if (normalized === "mismatch") return "⚠️";
  if (normalized === "no_active_round") return "no active round";
  if (normalized === "no_plan_day") return "no plan day";
  return normalized.replace(/_/g, " ");
}

function buildCwlRotationOverviewLines(input: {
  overview: Awaited<ReturnType<typeof cwlRotationService.listOverview>>;
  statusIcons: { yes: string; no: string };
}): string[] {
  if (input.overview.length <= 0) {
    return ["No active CWL rotation plans found."];
  }

  const lines: string[] = [];
  for (const entry of input.overview) {
    const clanName = entry.clanName || entry.clanTag;
    const clanLabel = `${clanName} (\`${entry.clanTag}\`)`;
    const statusEmoji = entry.status === "complete" ? input.statusIcons.yes : input.statusIcons.no;
    const battleDayStart = formatRelativeTimestamp(entry.battleDayStartAt);
    lines.push(`${statusEmoji} ${clanLabel} - day ${entry.roundDay ?? "unknown"} - Next Battle Day ${battleDayStart}`);
    lines.push(
      `- Leaders/Co-leaders: ${entry.leaderNames.length > 0 ? entry.leaderNames.join(", ") : "unknown"}`,
    );
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function getCwlRotationWarCount(input: {
  playerTag: string;
  warCountByPlayerTag: Map<string, number>;
}): number {
  const playerTag = normalizePlayerTag(input.playerTag);
  if (!playerTag) return 0;
  return input.warCountByPlayerTag.get(playerTag) ?? 0;
}

function renderCurrentRoundSummary(input: {
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  phaseEndsAt: Date | null;
}): string {
  const clanLabel = input.clanName ? `${input.clanName} (${input.clanTag})` : input.clanTag;
  const opponentLabel =
    input.opponentName && input.opponentTag
      ? `${input.opponentName} (${input.opponentTag})`
      : input.opponentTag ?? input.opponentName ?? "unknown opponent";
  const state = input.roundState.toLowerCase().includes("preparation")
    ? "Preparation"
    : input.roundState.toLowerCase().includes("inwar")
      ? "In war"
      : input.roundState;
  return `${clanLabel} - Day ${input.roundDay} ${state} vs ${opponentLabel} - ${formatRelativeTimestamp(input.phaseEndsAt)}`;
}

function renderMembersListLines(input: {
  season: string;
  clanTag: string;
  clanName: string | null;
  entries: Awaited<ReturnType<typeof cwlStateService.listSeasonRosterForClan>>;
  inWarOnly: boolean;
  townHallEmojiByLevel: Map<number, string>;
  rosterSignupTagSet: Set<string> | null;
}) {
  const sortedEntries = [...input.entries].sort((left, right) =>
    compareCwlMembersListEntries(left, right, input.rosterSignupTagSet),
  );
  const lines: string[] = [
    `Season: ${input.season}`,
    `Clan: ${input.clanName ? `${input.clanName} (${input.clanTag})` : input.clanTag}`,
    "",
  ];
  for (const entry of sortedEntries) {
    const normalizedPlayerTag = normalizePlayerTag(entry.playerTag);
    const linkLabel = entry.linkedDiscordUserId
      ? `<@${entry.linkedDiscordUserId}>`
      : "unlinked";
    const currentLabel = entry.currentRound
      ? entry.currentRound.inCurrentLineup
        ? `${entry.currentRound.attacksUsed}/${entry.currentRound.attacksAvailable}`
        : "not in current lineup"
      : "no current round";
    const rosterWarning =
      input.rosterSignupTagSet && normalizedPlayerTag && !input.rosterSignupTagSet.has(normalizedPlayerTag)
        ? " :warning:"
        : "";
    const badgeParts = [formatCwlMembersRoleBadge(entry.role), rosterWarning ? ":warning:" : ""].filter(Boolean);
    lines.push(
      `${renderTownHallIcon(entry.townHall, input.townHallEmojiByLevel)} ${entry.playerName} \`${
        entry.playerTag
      }\`${badgeParts.length > 0 ? ` ${badgeParts.join(" ")}` : ""} - days ${entry.daysParticipated} - ${linkLabel} - ${currentLabel}`,
    );
  }
  if (input.entries.length <= 0) {
    lines.push(
      input.inWarOnly
        ? "No persisted current/prep lineup is available for this CWL clan."
        : "No observed CWL roster members are available for this clan yet.",
    );
  }
  return lines;
}

function buildCwlRotationMergedRosterLines(input: {
  warCountByPlayerTag: Map<string, number>;
  plannedMembers: Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
  }>;
  actualPlayerRows: Array<{
    position: number;
    playerTag: string;
    playerName: string;
  }>;
  actualAvailable: boolean;
  rosterTagSet: Set<string>;
  excludedTagSet: Set<string>;
  noEntryEmoji: string;
}): {
  lines: string[];
  hasMismatchWarning: boolean;
  hasBlockedWarning: boolean;
} {
  const actualTagSet = new Set(
    input.actualPlayerRows.map((member) => normalizePlayerTag(member.playerTag)).filter(Boolean),
  );
  const plannedBenchMembers = input.plannedMembers
    .filter((member) => member.subbedOut)
    .filter((member) => {
      const normalizedTag = normalizePlayerTag(member.playerTag);
      return !normalizedTag || !actualTagSet.has(normalizedTag);
    })
    .map((member) => ({
      playerTag: member.playerTag,
      playerName: member.playerName,
      warCount: getCwlRotationWarCount({
        playerTag: member.playerTag,
        warCountByPlayerTag: input.warCountByPlayerTag,
      }),
    }));

  if (!input.actualAvailable) {
    return {
      lines: [
        'Actual lineup unavailable',
        ...plannedBenchMembers.map(
          (member) =>
            `:x: ${formatCwlRotationPlayerIdentity({
              playerTag: member.playerTag,
              playerName: member.playerName,
            })} | War count: ${member.warCount}`,
        ),
      ],
      hasMismatchWarning: false,
      hasBlockedWarning: false,
    };
  }

  const expectedMembers = input.plannedMembers.filter((member) => !member.subbedOut);
  const expectedByTag = new Map<string, { playerTag: string; playerName: string }>();
  for (const member of expectedMembers) {
    const normalizedTag = normalizePlayerTag(member.playerTag);
    if (!normalizedTag || expectedByTag.has(normalizedTag)) {
      continue;
    }
    expectedByTag.set(normalizedTag, { playerTag: member.playerTag, playerName: member.playerName });
  }

  const actualRows = input.actualPlayerRows.map((member) => ({
    normalizedTag: normalizePlayerTag(member.playerTag),
    playerTag: member.playerTag,
    playerName: member.playerName,
    warCount: getCwlRotationWarCount({
      playerTag: member.playerTag,
      warCountByPlayerTag: input.warCountByPlayerTag,
    }),
  }));
  const missingExpectedRows = expectedMembers.filter((member) => {
    const normalizedTag = normalizePlayerTag(member.playerTag);
    return !normalizedTag || !actualTagSet.has(normalizedTag);
  });

  const lines: string[] = [];
  let hasMismatchWarning = false;
  let hasBlockedWarning = false;
  const hasRosterTagSet = input.rosterTagSet.size > 0;
  const matchedActualRows: Array<(typeof actualRows)[number]> = [];
  const unexpectedActualRows: Array<(typeof actualRows)[number] & { isBlocked: boolean }> = [];

  for (const actual of actualRows) {
    if (actual.normalizedTag && expectedByTag.has(actual.normalizedTag)) {
      matchedActualRows.push(actual);
      continue;
    }

    const isBlocked =
      Boolean(actual.normalizedTag) &&
      (input.excludedTagSet.has(actual.normalizedTag) ||
        (hasRosterTagSet && !input.rosterTagSet.has(actual.normalizedTag)));
    if (isBlocked) {
      hasBlockedWarning = true;
    }
    unexpectedActualRows.push({
      ...actual,
      isBlocked,
    });
  }

  for (const actual of matchedActualRows) {
    lines.push(
      `:white_check_mark: ${formatCwlRotationPlayerIdentity({
        playerTag: actual.playerTag,
        playerName: actual.playerName,
      })} | War count: ${actual.warCount}`,
    );
  }

  if (unexpectedActualRows.length > 0) {
    hasMismatchWarning = true;
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Unexpected actual players');
    for (const actual of unexpectedActualRows) {
      const icon = actual.isBlocked ? input.noEntryEmoji : ':warning:';
      lines.push(
        `${icon} ${formatCwlRotationPlayerIdentity({
          playerTag: actual.playerTag,
          playerName: actual.playerName,
        })} | War count: ${actual.warCount}`,
      );
    }
  }

  if (missingExpectedRows.length > 0) {
    hasMismatchWarning = true;
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('Missing expected players');
    lines.push(
      ...missingExpectedRows.map((member) => {
        const expectedWarCount = getCwlRotationWarCount({
          playerTag: member.playerTag,
          warCountByPlayerTag: input.warCountByPlayerTag,
        });
        return `:x: ${formatCwlRotationPlayerIdentity({
          playerTag: member.playerTag,
          playerName: member.playerName,
        })} | War count: ${expectedWarCount}`;
      }),
    );
  }

  if (plannedBenchMembers.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(
      ...plannedBenchMembers.map(
        (member) =>
          `:x: ${formatCwlRotationPlayerIdentity({
            playerTag: member.playerTag,
            playerName: member.playerName,
          })} | War count: ${member.warCount}`,
      ),
    );
  }

  if (lines.length <= 0) {
    lines.push('No actual lineup members.');
  }

  return {
    lines,
    hasMismatchWarning,
    hasBlockedWarning,
  };
}
function pruneExpiredCwlRotationImportSessions(nowMs = Date.now()): void {
  for (const [sessionId, session] of cwlRotationImportSessions.entries()) {
    if (session.createdAtMs + CWL_ROTATION_IMPORT_SESSION_TTL_MS <= nowMs) {
      cwlRotationImportSessions.delete(sessionId);
    }
  }
}

function cloneCwlRotationImportPreview(preview: CwlRotationSheetImportPreview): CwlRotationSheetImportPreview {
  return {
    ...preview,
    matchedClans: preview.matchedClans.map((clan) => cloneCwlRotationImportTab(clan)),
    skippedTrackedClans: preview.skippedTrackedClans.map((entry) => ({ ...entry })),
    skippedTabs: preview.skippedTabs.map((entry) => ({ ...entry })),
    warnings: [...preview.warnings],
  };
}

function cloneCwlRotationImportTab(tab: CwlRotationImportSession["clanSessions"][number]["tab"]): CwlRotationImportSession["clanSessions"][number]["tab"] {
  return {
    ...tab,
    warnings: [...tab.warnings],
    days: tab.days.map((day) => ({
      ...day,
      rows: day.rows.map((row) => ({ ...row })),
      members: day.members.map((member) => ({ ...member })),
    })),
    parsedRows: tab.parsedRows.map((row) => ({
      ...row,
      suggestions: row.suggestions.map((suggestion) => ({ ...suggestion })),
      dayRows: row.dayRows.map((dayRow) => ({ ...dayRow })),
    })),
    trackedRosterRows: tab.trackedRosterRows?.map((row) => ({ ...row })),
    rosterRows: tab.rosterRows.map((row) => ({ ...row })),
  };
}

function buildCwlRotationImportClanKey(input: { clanTag: string; tabTitle: string }): string {
  return `${normalizeClanTag(input.clanTag)}::${String(input.tabTitle ?? "").trim().toLowerCase()}`;
}

function isCwlRotationImportRowPendingReview(row: CwlRotationImportRow): boolean {
  return row.classification !== "exact_match" && !row.ignored && !row.resolvedPlayerTag;
}

function createCwlRotationImportClanSession(
  clan: CwlRotationSheetImportPreview["matchedClans"][number],
): CwlRotationImportClanSession {
  const tab = cloneCwlRotationImportTab(clan);
  const reviewRowIds = tab.parsedRows.filter(isCwlRotationImportRowPendingReview).map((row) => row.rowId);
  return {
    clanKey: buildCwlRotationImportClanKey({ clanTag: tab.clanTag, tabTitle: tab.tabTitle }),
    clanTag: tab.clanTag,
    clanName: tab.clanName,
    tabTitle: tab.tabTitle,
    tab,
    confirmed: reviewRowIds.length <= 0,
    readyToConfirm: false,
    reviewRowIds,
    activeRowId: reviewRowIds[0] ?? null,
  };
}

function createCwlRotationImportSession(
  preview: CwlRotationSheetImportPreview,
  overwrite: boolean,
  requestedByUserId: string,
): string {
  pruneExpiredCwlRotationImportSessions();
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 18);
  const clanSessions = preview.matchedClans.map((clan) => createCwlRotationImportClanSession(clan));
  const previewClanIndex = Math.max(
    0,
    clanSessions.findIndex((clan) => clan.tab.parsedRows.length > 0),
  );
  cwlRotationImportSessions.set(sessionId, {
    requestedByUserId,
    createdAtMs: Date.now(),
    preview: cloneCwlRotationImportPreview(preview),
    baseWarnings: [...preview.warnings],
    overwrite,
    view: "preview",
    pageIndex: 0,
    previewClanIndex,
    activeClanIndex: Math.max(0, clanSessions.findIndex((clan) => !clan.confirmed && clan.reviewRowIds.length > 0)),
    clanSessions,
  });
  return sessionId;
}

function getCwlRotationImportSession(
  sessionId: string,
  userId: string,
): CwlRotationImportSession | null {
  pruneExpiredCwlRotationImportSessions();
  const session = cwlRotationImportSessions.get(sessionId) ?? null;
  if (!session) return null;
  if (session.requestedByUserId !== userId) return null;
  return session;
}

function deleteCwlRotationImportSession(sessionId: string): void {
  cwlRotationImportSessions.delete(sessionId);
}

export function isCwlRotationImportButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:`);
}

export function isCwlRotationImportSelectMenuCustomId(customId: string): boolean {
  return (
    String(customId ?? "").startsWith(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:resolve:`) ||
    String(customId ?? "").startsWith(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:preview-clan:`)
  );
}

function parseCwlRotationImportButtonCustomId(
  customId: string,
): {
  action: "page" | "review" | "review-page" | "preview" | "preview-day" | "confirm" | "cancel";
  sessionId: string;
  pageIndex: number | null;
} | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 3 || parts[0] !== CWL_ROTATION_IMPORT_SESSION_PREFIX) return null;
  const action = parts[1];
  if (
    action !== "page" &&
    action !== "review" &&
    action !== "review-page" &&
    action !== "preview" &&
    action !== "preview-day" &&
    action !== "confirm" &&
    action !== "cancel"
  ) {
    return null;
  }
  const hasDirectionalIndex = (action === "review-page" || action === "preview-day") && (parts[2] === "prev" || parts[2] === "next");
  const sessionId = String(hasDirectionalIndex ? parts[3] ?? "" : parts[2] ?? "").trim();
  if (!sessionId) return null;
  const pageIndex =
    action === "page" || action === "review-page" || action === "preview" || action === "preview-day"
      ? Math.max(
          0,
          Math.trunc(Number(hasDirectionalIndex ? parts[4] ?? "0" : parts[3] ?? "0") || 0),
        )
      : null;
  return {
    action,
    sessionId,
    pageIndex,
  };
}

function parseCwlRotationImportSelectMenuCustomId(
  customId: string,
): { action: "resolve"; sessionId: string; rowId: string } | { action: "preview-clan"; sessionId: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 3 || parts[0] !== CWL_ROTATION_IMPORT_SESSION_PREFIX) return null;
  const action = parts[1];
  if (action === "preview-clan") {
    const sessionId = String(parts[2] ?? "").trim();
    if (!sessionId) return null;
    return {
      action,
      sessionId,
    };
  }
  if (action !== "resolve" || parts.length < 4) return null;
  const sessionId = String(parts[2] ?? "").trim();
  const rowId = String(parts.slice(3).join(":") ?? "").trim();
  if (!sessionId || !rowId) return null;
  return {
    action: "resolve",
    sessionId,
    rowId,
  };
}

function buildCwlRotationImportPreviewPlayerLine(input: {
  row: CwlRotationImportRow;
  dayIndex: number;
  includeRawSnippet: boolean;
}): string {
  const dayNumber = Math.max(1, Math.min(7, Math.trunc(input.dayIndex) + 1));
  const dayRow = input.row.dayRows.find((entry) => entry.roundDay === dayNumber) ?? null;
  const statusEmoji = input.row.ignored
    ? ":no_entry:"
    : isCwlRotationImportRowPendingReview(input.row)
      ? ":warning:"
      : dayRow?.subbedOut
        ? ":x:"
        : ":black_circle:";
  const playerName = input.row.resolvedPlayerName ?? input.row.parsedPlayerName;
  const playerTag = input.row.resolvedPlayerTag ?? input.row.parsedPlayerTag ?? "unmapped";
  const rawSnippet = input.includeRawSnippet && input.row.rawPlayerNameSnippet ? ` | ${input.row.rawPlayerNameSnippet}` : "";
  return `${statusEmoji} ${playerName} ${playerTag}${rawSnippet}`;
}

function buildCwlRotationImportPreviewPageLines(input: {
  preview: CwlRotationSheetImportPreview;
  clanSession: CwlRotationImportClanSession | null;
  dayIndex: number;
}): string[] {
  const dayNumber = Math.max(1, Math.min(7, Math.trunc(input.dayIndex) + 1));
  const clanLabel = input.clanSession?.clanName
    ? `${input.clanSession.clanName} (${input.clanSession.clanTag})`
    : input.clanSession?.clanTag ?? "unknown clan";
  const totalRows = input.clanSession?.tab.parsedRows.length ?? 0;
  const mappedRows = input.clanSession
    ? input.clanSession.tab.parsedRows.filter((row) => !isCwlRotationImportRowPendingReview(row)).length
    : 0;
  const reviewRows = input.clanSession
    ? input.clanSession.tab.parsedRows.filter(isCwlRotationImportRowPendingReview).length
    : 0;
  const lines: string[] = [
    `Season: ${input.preview.season}`,
    `Source: ${input.preview.sourceSheetTitle || input.preview.sourceSheetId}`,
    `Importable clans: ${input.preview.matchedClans.filter((clan) => clan.importable).length} / ${input.preview.matchedClans.length}`,
    `Clan: ${clanLabel}`,
    `Day: Day ${dayNumber}`,
    `Rows: ${mappedRows} mapped / ${totalRows} total ${reviewRows > 0 ? "⚠️" : "✅"}`,
  ];

  if (input.preview.skippedTrackedClans.length > 0) {
    lines.push(
      `Skipped tracked clans: ${input.preview.skippedTrackedClans
        .map((entry) => `${entry.clanName || entry.clanTag} (${entry.reason})`)
        .join(" | ")}`,
    );
  }
  if (input.preview.skippedTabs.length > 0) {
    lines.push(
      `Skipped tabs: ${input.preview.skippedTabs
        .map((entry) => `${entry.tabTitle} (${entry.reason})`)
        .join(" | ")}`,
    );
  }
  const clanWarnings = input.clanSession?.tab.warnings ?? [];
  if (clanWarnings.length > 0) {
    lines.push(`Warnings: ${clanWarnings.join(" | ")}`);
  }

  lines.push("");

  const rows = input.clanSession?.tab.parsedRows ?? [];
  if (rows.length <= 0) {
    lines.push("No player rows were parsed for this clan.");
    return lines;
  }

  const renderRows = (includeRawSnippet: boolean): string[] => [
    ...lines,
    ...rows.map((row) => buildCwlRotationImportPreviewPlayerLine({ row, dayIndex: input.dayIndex, includeRawSnippet })),
  ];

  const withRawSnippets = renderRows(true);
  if (withRawSnippets.join("\n").length <= DISCORD_DESCRIPTION_LIMIT) {
    return withRawSnippets;
  }

  return renderRows(false);
}

function buildCwlRotationImportPreviewEmbed(input: {
  preview: CwlRotationSheetImportPreview;
  clanSession: CwlRotationImportClanSession | null;
  dayIndex: number;
  sessionId: string;
}): EmbedBuilder {
  const dayNumber = Math.max(1, Math.min(7, Math.trunc(input.dayIndex) + 1));
  const clanLabel = input.clanSession?.clanName || input.clanSession?.clanTag || "unknown clan";
  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle(`/cwl rotations import preview - ${clanLabel} - day ${dayNumber}`)
    .setDescription(
      buildDescription(
        buildCwlRotationImportPreviewPageLines({
          preview: input.preview,
          clanSession: input.clanSession,
          dayIndex: input.dayIndex,
        }),
      ),
    )
    .setFooter({
      text: `Session ${input.sessionId.slice(0, 8)} - ${clanLabel} day ${dayNumber}/7`,
    });
}

function buildCwlRotationImportReviewPageLines(input: {
  preview: CwlRotationSheetImportPreview;
  clanSession: CwlRotationImportClanSession | null;
  reviewRow: CwlRotationImportRow | null;
  reviewIndex: number;
  reviewCount: number;
  clanLabel: string;
  clanConfirmed: boolean;
  clanReadyToConfirm: boolean;
  clanHasPendingRows: boolean;
}): string[] {
  const reviewOptions = input.reviewRow
    ? buildCwlRotationImportReviewOptions({
        clanSession: input.clanSession,
        reviewRow: input.reviewRow,
      })
    : null;
  const lines: string[] = [
    `Season: ${input.preview.season}`,
    `Source: ${input.preview.sourceSheetTitle || input.preview.sourceSheetId}`,
    `Clan: ${input.clanLabel}${input.clanConfirmed ? " (confirmed)" : ""}`,
    `Review rows: ${input.reviewCount}`,
    "",
  ];

  if (!input.reviewRow) {
    lines.push(
      input.clanConfirmed
        ? "This clan is confirmed and ready to move on."
        : input.clanReadyToConfirm
          ? "All rows in this clan are resolved. Confirm this clan to continue."
          : "This clan is waiting on row review.",
    );
    return lines;
  }

  lines.push(`Row ${input.reviewIndex + 1} / ${input.reviewCount}`);
  lines.push(`Sheet row: ${input.reviewRow.sheetRowNumber}`);
  lines.push(`Raw: ${input.reviewRow.rawText}`);
  lines.push(`Parsed tag: ${input.reviewRow.parsedPlayerTag || "none"}`);
  lines.push(`Parsed player: ${input.reviewRow.parsedPlayerName}`);
  lines.push(`Reason: ${input.reviewRow.reason || "Review required."}`);

  if (reviewOptions) {
    lines.push("");
    if (reviewOptions.suggested.length > 0) {
      lines.push("Suggested matches:");
      for (const suggestion of reviewOptions.suggested.slice(0, 5)) {
        lines.push(
          `${suggestion.playerName} (${suggestion.playerTag}) - ${((suggestion.score ?? 0) * 100).toFixed(0)}%`,
        );
      }
    }
    if (reviewOptions.fallback.length > 0) {
      lines.push("");
      lines.push("Remaining tracked players:");
      for (const fallback of reviewOptions.fallback.slice(0, 5)) {
        lines.push(`${fallback.playerName} (${fallback.playerTag})`);
      }
    }
    lines.push("");
    lines.push(
      reviewOptions.options.length > 0
        ? `Selectable mappings: ${reviewOptions.options.length} available.`
        : "No tracked players remain; ignore is the only available action.",
    );
  }

  if (!input.clanHasPendingRows) {
    lines.push("");
    lines.push(
      input.clanConfirmed
        ? "This clan is already confirmed."
        : "This clan is ready to confirm before moving to the next clan.",
    );
  }

  return lines;
}

function buildCwlRotationImportReviewEmbed(input: {
  preview: CwlRotationSheetImportPreview;
  clanSession: CwlRotationImportClanSession | null;
  reviewRow: CwlRotationImportRow | null;
  reviewIndex: number;
  reviewCount: number;
  sessionId: string;
  clanLabel: string;
  clanConfirmed: boolean;
  clanReadyToConfirm: boolean;
  clanHasPendingRows: boolean;
}): EmbedBuilder {
  const titleSuffix = input.reviewRow ? `${input.clanLabel} - row ${input.reviewIndex + 1}` : `${input.clanLabel} - complete`;
  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle(`/cwl rotations import review - ${titleSuffix}`)
    .setDescription(
      buildDescription(
        buildCwlRotationImportReviewPageLines({
          preview: input.preview,
          clanSession: input.clanSession,
          reviewRow: input.reviewRow,
          reviewIndex: input.reviewIndex,
          reviewCount: input.reviewCount,
          clanLabel: input.clanLabel,
          clanConfirmed: input.clanConfirmed,
          clanReadyToConfirm: input.clanReadyToConfirm,
          clanHasPendingRows: input.clanHasPendingRows,
        }),
      ),
    )
    .setFooter({
      text: `Session ${input.sessionId.slice(0, 8)} - ${input.clanLabel} review ${Math.max(0, input.reviewIndex + 1)}/${Math.max(1, input.reviewCount)}`,
    });
}

function buildCwlRotationImportPreviewClanSelectMenu(input: {
  sessionId: string;
  session: CwlRotationImportSession;
  selectedClanIndex: number;
  dayIndex: number;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (input.session.clanSessions.length <= 0) return null;
  const selectedDay = Math.max(1, Math.min(7, Math.trunc(input.dayIndex) + 1));
  const selectedClanIndex = Math.max(0, Math.min(input.session.clanSessions.length - 1, input.selectedClanIndex));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:preview-clan:${input.sessionId}`)
    .setPlaceholder("Select a clan to preview")
    .setMinValues(1)
    .setMaxValues(1);
  const options = input.session.clanSessions.map((clanSession, clanIndex) => {
    const totalRows = clanSession.tab.parsedRows.length;
    const mappedRows = clanSession.tab.parsedRows.filter((row) => !isCwlRotationImportRowPendingReview(row)).length;
    const reviewRows = clanSession.tab.parsedRows.filter(isCwlRotationImportRowPendingReview).length;
    const hasUsableData = totalRows > 0;
    return {
      label: `${(clanSession.clanName || clanSession.clanTag).slice(0, 100)} - ${mappedRows}/${totalRows} ${reviewRows > 0 ? "⚠️" : "✅"}`.slice(0, 100),
      value: clanSession.clanTag,
      description: hasUsableData ? `Preview Day ${selectedDay}` : `No usable rows for Day ${selectedDay}`,
      default: clanIndex === selectedClanIndex,
      emoji: hasUsableData ? (reviewRows > 0 ? "⚠️" : "✅") : "🚫",
    };
  });
  menu.addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildCwlRotationImportPreviewActionRows(input: {
  sessionId: string;
  session: CwlRotationImportSession;
  clanSession: CwlRotationImportClanSession | null;
  dayIndex: number;
  hasImportableClans: boolean;
  hasReviewRows: boolean;
}): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const dayIndex = Math.max(0, Math.min(6, Math.trunc(input.dayIndex)));
  const clanSelectMenu = buildCwlRotationImportPreviewClanSelectMenu({
    sessionId: input.sessionId,
    session: input.session,
    selectedClanIndex: input.session.previewClanIndex,
    dayIndex,
  });
  const prevButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:preview-day:prev:${input.sessionId}:${Math.max(0, dayIndex - 1)}`)
    .setLabel("Prev Day")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(dayIndex <= 0);
  const nextButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:preview-day:next:${input.sessionId}:${Math.min(6, dayIndex + 1)}`)
    .setLabel("Next Day")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(dayIndex >= 6);
  const reviewButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:review:${input.sessionId}`)
    .setLabel(input.hasReviewRows ? "Continue to Review" : "Review Complete")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!input.hasReviewRows);
  const confirmButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:confirm:${input.sessionId}`)
    .setLabel("Save Import")
    .setStyle(ButtonStyle.Success)
    .setDisabled(!input.hasImportableClans || input.hasReviewRows);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:cancel:${input.sessionId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  return [
    ...(clanSelectMenu ? [clanSelectMenu] : []),
    new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton, reviewButton, confirmButton, cancelButton),
  ];
}

function buildCwlRotationImportReviewActionRows(input: {
  sessionId: string;
  reviewIndex: number;
  reviewCount: number;
  hasImportableClans: boolean;
  hasPendingRows: boolean;
  previewPageIndex: number;
  canConfirmClan: boolean;
  currentClanLabel: string;
}): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const prevPageIndex = Math.max(0, input.reviewIndex - 1);
  const nextPageIndex = Math.min(Math.max(0, input.reviewCount - 1), input.reviewIndex + 1);
  const prevButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:review-page:prev:${input.sessionId}:${prevPageIndex}`)
    .setLabel("Prev Row")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.reviewIndex <= 0);
  const nextButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:review-page:next:${input.sessionId}:${nextPageIndex}`)
    .setLabel("Next Row")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.reviewIndex >= input.reviewCount - 1);
  const backButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:preview:${input.sessionId}:${input.previewPageIndex}`)
    .setLabel("Back to Preview")
    .setStyle(ButtonStyle.Primary);
  const confirmButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:confirm:${input.sessionId}`)
    .setLabel("Confirm Clan")
    .setStyle(ButtonStyle.Success)
    .setDisabled(!input.canConfirmClan);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:cancel:${input.sessionId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton, backButton, confirmButton, cancelButton),
  ];
}

function _buildCwlRotationImportReviewSelectMenu(input: {
  sessionId: string;
  reviewRow: CwlRotationImportRow;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (input.reviewRow.ignored || input.reviewRow.resolvedPlayerTag) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:resolve:${input.sessionId}:${input.reviewRow.rowId}`)
    .setPlaceholder("Choose a tracked player mapping or ignore this row");

  const options = input.reviewRow.suggestions.slice(0, 25).map((suggestion) => ({
    label: `${suggestion.playerName}`.slice(0, 100),
    value: `tag:${suggestion.playerTag}`,
    description: `${suggestion.playerTag} • ${(suggestion.score * 100).toFixed(0)}%`.slice(0, 100),
  }));
  options.push({
    label: "Ignore this row",
    value: "ignore",
    description: "Leave this row out of the imported plan.",
  });
  menu.addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildCwlRotationImportReviewSelectMenuV2(input: {
  sessionId: string;
  clanSession: CwlRotationImportClanSession;
  reviewRow: CwlRotationImportRow;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (input.reviewRow.ignored || input.reviewRow.resolvedPlayerTag) return null;
  const reviewOptions = buildCwlRotationImportReviewOptions({
    clanSession: input.clanSession,
    reviewRow: input.reviewRow,
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:resolve:${input.sessionId}:${input.reviewRow.rowId}`)
    .setPlaceholder("Choose a suggested or remaining tracked player, or ignore this row");

  const options = reviewOptions.options.slice(0, 24).map((option) => ({
    label: `${option.playerName}`.slice(0, 100),
    value: `tag:${option.playerTag}`,
    description:
      option.source === "suggested"
        ? `${option.playerTag} - ${((option.score ?? 0) * 100).toFixed(0)}% suggested`.slice(0, 100)
        : `${option.playerTag} - remaining tracked player`.slice(0, 100),
  }));
  options.push({
    label: "Ignore this row",
    value: "ignore",
    description: "Leave this row out of the imported plan.",
  });
  menu.addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildCwlRotationImportReviewOptions(input: {
  clanSession: CwlRotationImportClanSession | null;
  reviewRow: CwlRotationImportRow;
}): CwlRotationImportReviewOptions {
  const clanSession = input.clanSession;
  const resolvedTags = getCwlRotationImportResolvedPlayerTagSetForClan(clanSession);
  const seenTags = new Set<string>();

  const suggested = input.reviewRow.suggestions
    .filter((suggestion) => !resolvedTags.has(normalizePlayerTag(suggestion.playerTag)))
    .map((suggestion) => ({
      playerTag: normalizePlayerTag(suggestion.playerTag),
      playerName: suggestion.playerName,
      score: suggestion.score,
      source: "suggested" as const,
    }))
    .filter((suggestion) => {
      if (!suggestion.playerTag || seenTags.has(suggestion.playerTag)) return false;
      seenTags.add(suggestion.playerTag);
      return true;
    });

  const fallback = (clanSession?.tab.trackedRosterRows ?? [])
    .map((entry) => ({
      playerTag: normalizePlayerTag(entry.playerTag),
      playerName: entry.playerName,
      source: "fallback" as const,
    }))
    .filter((entry) => {
      if (!entry.playerTag) return false;
      if (resolvedTags.has(entry.playerTag)) return false;
      if (seenTags.has(entry.playerTag)) return false;
      seenTags.add(entry.playerTag);
      return true;
    });

  return {
    suggested,
    fallback,
    options: [...suggested, ...fallback],
  };
}

function getCwlRotationImportResolvedPlayerTagSetForClan(
  clanSession: CwlRotationImportClanSession | null,
): Set<string> {
  const resolvedTags = new Set<string>();
  if (!clanSession) return resolvedTags;
  for (const row of clanSession.tab.parsedRows) {
    const resolvedPlayerTag = normalizePlayerTag(row.resolvedPlayerTag ?? "");
    if (resolvedPlayerTag && !row.ignored) {
      resolvedTags.add(resolvedPlayerTag);
    }
  }
  return resolvedTags;
}

function getCwlRotationImportPendingRows(preview: CwlRotationSheetImportPreview): CwlRotationImportRow[] {
  return preview.matchedClans.flatMap((clan) =>
    clan.parsedRows.filter((row) => row.classification !== "exact_match" && !row.ignored && !row.resolvedPlayerTag),
  );
}

function getCwlRotationImportIgnoredRows(preview: CwlRotationSheetImportPreview): CwlRotationImportRow[] {
  return preview.matchedClans.flatMap((clan) => clan.parsedRows.filter((row) => row.ignored));
}

function getCwlRotationImportReviewRows(preview: CwlRotationSheetImportPreview): CwlRotationImportRow[] {
  return preview.matchedClans.flatMap((clan) =>
    clan.parsedRows.filter((row) => row.classification !== "exact_match" && !row.ignored && !row.resolvedPlayerTag),
  );
}

function buildCwlRotationImportWarnings(preview: CwlRotationSheetImportPreview): string[] {
  const warnings: string[] = [];
  const structuralCount = preview.matchedClans.reduce((total, clan) => total + clan.structuralRowCount, 0);
  const pendingCount = getCwlRotationImportPendingRows(preview).length;
  const ignoredCount = getCwlRotationImportIgnoredRows(preview).length;
  if (structuralCount > 0) warnings.push(`Skipped ${structuralCount} structural rows.`);
  if (pendingCount > 0) warnings.push(`${pendingCount} row${pendingCount === 1 ? "" : "s"} need review.`);
  if (ignoredCount > 0) warnings.push(`${ignoredCount} row${ignoredCount === 1 ? "" : "s"} explicitly ignored.`);
  return warnings;
}

function stripCwlRotationImportSummaryWarnings(warnings: string[]): string[] {
  return warnings.filter(
    (warning) =>
      !/^Skipped \d+ structural rows\.$/i.test(warning) &&
      !/^\d+ row(?:s)? need review\.$/i.test(warning) &&
      !/^\d+ row(?:s)? explicitly ignored\.$/i.test(warning),
  );
}

function buildCwlRotationShowPageCustomId(input: {
  userId: string;
  clanTag: string;
  season: string;
  pageIndex: number;
}): string {
  return `${CWL_ROTATION_SHOW_SESSION_PREFIX}:page:${input.userId}:${input.clanTag}:${input.season}:${input.pageIndex}`;
}

function buildCwlRotationShowBackButtonCustomId(input: {
  userId: string;
  season: string;
}): string {
  return `${CWL_ROTATION_SHOW_SESSION_PREFIX}:back:${input.userId}:${input.season}`;
}

function buildCwlRotationShowRefreshButtonCustomId(input: {
  userId: string;
  clanTag: string;
  season: string;
  pageIndex: number;
  showBackButton: boolean;
}): string {
  return `${CWL_ROTATION_SHOW_SESSION_PREFIX}:refresh:${input.userId}:${input.clanTag}:${input.season}:${input.pageIndex}:${input.showBackButton ? "1" : "0"}`;
}

function buildCwlRotationShowSelectMenuCustomId(input: {
  userId: string;
  season: string;
  selectedDay?: number | null;
}): string {
  const selectedDay =
    typeof input.selectedDay === "number" && Number.isFinite(input.selectedDay) && input.selectedDay > 0
      ? `:${Math.max(1, Math.trunc(input.selectedDay))}`
      : "";
  return `${CWL_ROTATION_SHOW_SESSION_PREFIX}:select:${input.userId}:${input.season}${selectedDay}`;
}

type CwlRotationShowCustomId =
  | { action: "page"; userId: string; clanTag: string; season: string; pageIndex: number }
  | { action: "back"; userId: string; season: string }
  | {
      action: "refresh";
      userId: string;
      clanTag: string;
      season: string;
      pageIndex: number;
      showBackButton: boolean;
    }
  | { action: "select"; userId: string; season: string; selectedDay: number | null };

function parseCwlRotationShowCustomId(customId: string): CwlRotationShowCustomId | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 4 || parts[0] !== CWL_ROTATION_SHOW_SESSION_PREFIX) return null;
  const action = parts[1];
  const userId = String(parts[2] ?? "").trim();
  if (action === "page") {
    if (parts.length < 6) return null;
    const clanTag = normalizeClanTag(parts[3] ?? "");
    const season = String(parts[4] ?? "").trim();
    const pageIndex = Math.max(0, Math.trunc(Number(parts[5] ?? "0") || 0));
    if (!userId || !clanTag || !season) return null;
    return { action, userId, clanTag, season, pageIndex };
  }
  if (action === "refresh") {
    if (parts.length < 7) return null;
    const clanTag = normalizeClanTag(parts[3] ?? "");
    const season = String(parts[4] ?? "").trim();
    const pageIndex = Math.max(0, Math.trunc(Number(parts[5] ?? "0") || 0));
    const showBackButton = String(parts[6] ?? "").trim() === "1";
    if (!userId || !clanTag || !season) return null;
    return { action, userId, clanTag, season, pageIndex, showBackButton };
  }
  if (action === "back" || action === "select") {
    const season = String(parts[3] ?? "").trim();
    if (!userId || !season) return null;
    const selectedDay = action === "select" && parts.length >= 5 ? Math.max(0, Math.trunc(Number(parts[4] ?? "0") || 0)) : null;
    return { action, userId, season, selectedDay };
  }
  return null;
}

export function isCwlRotationShowButtonCustomId(customId: string): boolean {
  const parsed = parseCwlRotationShowCustomId(customId);
  return parsed?.action === "page" || parsed?.action === "back" || parsed?.action === "refresh";
}

export function isCwlRotationShowSelectMenuCustomId(customId: string): boolean {
  return parseCwlRotationShowCustomId(customId)?.action === "select";
}

function buildCwlRotationShowActionRows(input: {
  userId: string;
  clanTag: string;
  season: string;
  pageIndex: number;
  totalPages: number;
  showBackButton: boolean;
  loading?: boolean;
}): ActionRowBuilder<ButtonBuilder>[] {
  const components: ButtonBuilder[] = [];
  const loading = input.loading ?? false;
  if (input.showBackButton) {
    components.push(
      new ButtonBuilder()
        .setCustomId(
          buildCwlRotationShowBackButtonCustomId({
            userId: input.userId,
            season: input.season,
          }),
        )
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  components.push(
    new ButtonBuilder()
      .setCustomId(
        buildCwlRotationShowPageCustomId({
          userId: input.userId,
          clanTag: input.clanTag,
          season: input.season,
          pageIndex: Math.max(0, input.pageIndex - 1),
        }),
      )
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(loading || input.pageIndex <= 0),
    new ButtonBuilder()
      .setCustomId(
        buildCwlRotationShowPageCustomId({
          userId: input.userId,
          clanTag: input.clanTag,
          season: input.season,
          pageIndex: Math.min(Math.max(0, input.totalPages - 1), input.pageIndex + 1),
        }),
      )
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(loading || input.pageIndex >= input.totalPages - 1),
    new ButtonBuilder()
      .setCustomId(
        buildCwlRotationShowRefreshButtonCustomId({
          userId: input.userId,
          clanTag: input.clanTag,
          season: input.season,
          pageIndex: input.pageIndex,
          showBackButton: input.showBackButton,
        }),
      )
      .setLabel(loading ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(loading),
  );

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(components)];
}

function buildCwlRotationShowOverviewActionRows(input: {
  userId: string;
  season: string;
  overview: Awaited<ReturnType<typeof cwlRotationService.listOverview>>;
  selectedDay?: number | null;
}): ActionRowBuilder<StringSelectMenuBuilder>[] {
  if (input.overview.length <= 0) {
    return [];
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      buildCwlRotationShowSelectMenuCustomId({
        userId: input.userId,
        season: input.season,
        selectedDay: input.selectedDay ?? null,
      }),
    )
    .setPlaceholder("Select a clan to open")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      input.overview.slice(0, CWL_ROTATION_SHOW_OVERVIEW_MAX_OPTIONS).map((entry) => ({
        label: (entry.clanName || entry.clanTag).slice(0, 100),
        value: entry.clanTag,
        description: `day ${entry.roundDay ?? "unknown"} - ${formatCwlRotationOverviewStatusLabel(entry.status)}`,
      })),
  );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

function buildCwlRotationShowClanActionRows(input: {
  userId: string;
  season: string;
  overview: Awaited<ReturnType<typeof cwlRotationService.listOverview>>;
  selectedDay?: number | null;
  clanTag: string;
  pageIndex: number;
  totalPages: number;
  showBackButton: boolean;
  loading?: boolean;
}): Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> {
  return [
    ...buildCwlRotationShowOverviewActionRows({
      userId: input.userId,
      season: input.season,
      overview: input.overview,
      selectedDay: input.selectedDay ?? null,
    }),
    ...buildCwlRotationShowActionRows({
      userId: input.userId,
      clanTag: input.clanTag,
      season: input.season,
      pageIndex: input.pageIndex,
      totalPages: input.totalPages,
      showBackButton: input.showBackButton,
      loading: input.loading ?? false,
    }),
  ];
}

function buildCwlRotationShowPageLines(input: {
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  battleDayStartAt: Date | null;
  leaderNames: string[];
  excludedPlayerLabels: string[];
  warCountByPlayerTag: Map<string, number>;
  noEntryEmoji: string;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ position: number; playerTag: string; playerName: string }>;
  } | null;
}): string[] {
  const visibleDayRows = cwlRotationService.getVisibleRotationShowDayRows({
    excludedPlayerTags: input.plan.excludedPlayerTags,
    days: input.plan.days,
    day: input.day,
  });
  const rosterTagSet = buildCwlRotationRosterTagSet(input.plan);
  const excludedTagSet = new Set(
    input.plan.excludedPlayerTags.map((tag) => normalizePlayerTag(tag)).filter((tag): tag is string => Boolean(tag)),
  );
  const lines: string[] = [
    `Season: ${input.plan.season}`,
    `Clan: ${input.plan.clanName || input.plan.clanTag}`,
    `Version: ${input.plan.version}`,
  ];
  lines.push(`Battle day start: ${formatRelativeTimestamp(input.battleDayStartAt)}`);
  if (input.excludedPlayerLabels.length > 0) {
    lines.push(`Excluded: ${input.excludedPlayerLabels.join(", ")}`);
  }
  lines.push(`Leaders/Co-leaders: ${input.leaderNames.length > 0 ? input.leaderNames.join(", ") : "unknown"}`);
  lines.push(`Page: ${input.pageIndex + 1} / ${input.pageCount}`);
  lines.push("");
  lines.push(`Day ${input.day.roundDay}`);
  lines.push("");
  if (!input.validation || !input.validation.actualAvailable) {
    lines.push("Actual lineup unavailable");
    const merged = buildCwlRotationMergedRosterLines({
      warCountByPlayerTag: input.warCountByPlayerTag,
      plannedMembers: visibleDayRows,
      actualPlayerRows: [],
      actualAvailable: false,
      rosterTagSet,
      excludedTagSet,
      noEntryEmoji: input.noEntryEmoji,
    });
    lines.push(...merged.lines.slice(1));
  } else {
    const merged = buildCwlRotationMergedRosterLines({
      warCountByPlayerTag: input.warCountByPlayerTag,
      plannedMembers: visibleDayRows,
      actualPlayerRows: input.validation.actualPlayerRows,
      actualAvailable: input.validation.actualAvailable,
      rosterTagSet,
      excludedTagSet,
      noEntryEmoji: input.noEntryEmoji,
    });
    if (merged.hasMismatchWarning) {
      lines.push("\u26a0\ufe0f Actual lineup differs from the rotation plan.");
    }
    if (merged.hasBlockedWarning) {
      lines.push(`${input.noEntryEmoji} Not on roster / excluded from rotation.`);
    }
    lines.push(...merged.lines);
  }

  return lines;
}

function buildCwlRotationShowPageEmbed(input: {
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  battleDayStartAt: Date | null;
  leaderNames: string[];
  excludedPlayerLabels: string[];
  warCountByPlayerTag: Map<string, number>;
  noEntryEmoji: string;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ position: number; playerTag: string; playerName: string }>;
  } | null;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle(`/cwl rotations show ${input.plan.clanTag}`)
    .setDescription(
      buildDescription(
          buildCwlRotationShowPageLines({
            plan: input.plan,
            day: input.day,
            pageIndex: input.pageIndex,
            pageCount: input.pageCount,
            battleDayStartAt: input.battleDayStartAt,
            leaderNames: input.leaderNames,
            excludedPlayerLabels: input.excludedPlayerLabels,
            warCountByPlayerTag: input.warCountByPlayerTag,
            noEntryEmoji: input.noEntryEmoji,
            validation: input.validation,
          }),
      ),
    )
    .setFooter({
      text: `Page ${input.pageIndex + 1}/${input.pageCount}`,
    });
}

async function buildCwlRotationShowOverviewPayload(input: {
  client: Client;
  userId: string;
  season: string;
  overview: Awaited<ReturnType<typeof cwlRotationService.listOverview>>;
}): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
  const statusIcons = await resolveCwlRotationOverviewStatusIcons(input.client);
  return {
    embed: new EmbedBuilder()
      .setColor(CWL_EMBED_COLOR)
      .setTitle("/cwl rotations show")
      .setDescription(
        buildDescription(
          buildCwlRotationOverviewLines({
            overview: input.overview,
            statusIcons,
          }),
        ),
    ),
    components: buildCwlRotationShowOverviewActionRows({
      userId: input.userId,
      season: input.season,
      overview: input.overview,
    }),
  };
}

async function loadCwlRotationShowOverviewPayload(input: {
  client: Client;
  userId: string;
  season: string;
  refreshLeadershipMembers?: boolean;
}): Promise<{
  embed: EmbedBuilder;
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
}> {
  const overview = await cwlRotationService.listOverview(
    input.refreshLeadershipMembers
      ? {
          season: input.season,
          refreshLeadershipMembers: true,
        }
      : {
          season: input.season,
        },
  );
  return buildCwlRotationShowOverviewPayload({
    client: input.client,
    userId: input.userId,
    season: input.season,
    overview,
  });
}

async function loadCwlRotationShowClanPayload(input: {
  client: Client;
  userId: string;
  season: string;
  clanTag: string;
  showBackButton: boolean;
  explicitDay?: number | null;
  pageIndex?: number | null;
  loading?: boolean;
}): Promise<{
  payload: {
    embed: EmbedBuilder;
    components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  };
  planView: CwlRotationPlanExport;
  dayEntry: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
} | null> {
  const [overview, planExports, preferredDay, noEntryEmoji] = await Promise.all([
    cwlRotationService.listOverview({ season: input.season }),
    cwlRotationService.listActivePlanExports({
      season: input.season,
      clanTags: [input.clanTag],
    }),
    cwlRotationService.getPreferredDisplayDay({
      clanTag: input.clanTag,
      season: input.season,
    }),
    resolveNoEntryEmoji(input.client),
  ]);
  const [planView] = planExports;
  if (!planView) {
    return null;
  }

  const hasExplicitDay =
    typeof input.explicitDay === "number" && Number.isFinite(input.explicitDay) && input.explicitDay > 0;
  if (planView.days.length <= 0) {
    return null;
  }

  const explicitRoundDay = hasExplicitDay ? Math.max(1, Math.trunc(Number(input.explicitDay) || 0)) : null;
  const explicitDayEntry =
    explicitRoundDay !== null ? planView.days.find((entry) => entry.roundDay === explicitRoundDay) ?? null : null;
  const preferredDayEntry = preferredDay
    ? planView.days.find((entry) => entry.roundDay === preferredDay) ?? null
    : null;
  const selectedDay =
    explicitDayEntry ??
    (typeof input.pageIndex === "number" && !hasExplicitDay
      ? planView.days[Math.max(0, Math.min(Math.max(0, planView.days.length - 1), input.pageIndex))] ?? null
      : preferredDayEntry ?? planView.days[0] ?? null);
  if (!selectedDay) {
    return null;
  }
  const pageIndex = Math.max(0, planView.days.findIndex((entry) => entry.roundDay === selectedDay.roundDay));

  const [validation, battleDayStartAt, warCountByPlayerTag] = await Promise.all([
    cwlRotationService.validatePlanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      roundDay: selectedDay.roundDay,
    }),
    cwlStateService.getBattleDayStartForClanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      roundDay: selectedDay.roundDay,
    }),
    cwlStateService.getParticipationCountsForClanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      throughRoundDay: selectedDay.roundDay,
    }),
  ]);
  const leaderNames = await cwlRotationService.listClanLeadershipNames({
    clanTag: planView.clanTag,
  });
  const playerNameByTag = buildCwlRotationPlanPlayerNameIndex(planView);
  const excludedPlayerLabels = planView.excludedPlayerTags.map((playerTag) =>
    formatCwlRotationExcludedPlayerLabel({
      playerTag,
      playerNameByTag,
    }),
  );

  return {
    payload: await buildCwlRotationShowClanPayload({
      userId: input.userId,
      showBackButton: input.showBackButton,
      overview,
      plan: planView,
      day: selectedDay,
      pageIndex,
      pageCount: planView.days.length,
      battleDayStartAt,
      leaderNames,
      excludedPlayerLabels,
      warCountByPlayerTag,
      noEntryEmoji,
      validation: validation
        ? {
          actualAvailable: validation.actualAvailable,
            complete: validation.complete,
            missingExpectedPlayerTags: validation.missingExpectedPlayerTags,
            extraActualPlayerTags: validation.extraActualPlayerTags,
            actualPlayerRows: validation.actualPlayerTags.map((playerTag, index) => ({
              position: index + 1,
              playerTag,
              playerName: validation.actualPlayerNames[index] ?? playerTag,
            })),
          }
        : null,
      loading: input.loading ?? false,
    }),
    planView,
    dayEntry: selectedDay,
    pageIndex,
    pageCount: planView.days.length,
  };
}

async function buildCwlRotationShowClanPayload(input: {
  userId: string;
  showBackButton: boolean;
  overview: Awaited<ReturnType<typeof cwlRotationService.listOverview>>;
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  battleDayStartAt: Date | null;
  leaderNames: string[];
  excludedPlayerLabels: string[];
  warCountByPlayerTag: Map<string, number>;
  noEntryEmoji: string;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ position: number; playerTag: string; playerName: string }>;
  } | null;
  loading?: boolean;
}): Promise<{
  embed: EmbedBuilder;
  components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
}> {
  return {
    embed: buildCwlRotationShowPageEmbed({
      plan: input.plan,
      day: input.day,
      pageIndex: input.pageIndex,
      pageCount: input.pageCount,
      battleDayStartAt: input.battleDayStartAt,
      leaderNames: input.leaderNames,
      excludedPlayerLabels: input.excludedPlayerLabels,
      warCountByPlayerTag: input.warCountByPlayerTag,
      noEntryEmoji: input.noEntryEmoji,
      validation: input.validation,
    }),
    components: buildCwlRotationShowClanActionRows({
      userId: input.userId,
      season: input.plan.season,
      overview: input.overview,
      selectedDay: input.day.roundDay,
      clanTag: input.plan.clanTag,
      pageIndex: input.pageIndex,
      totalPages: input.pageCount,
      showBackButton: input.showBackButton,
      loading: input.loading ?? false,
    }),
  };
}

function buildCwlRotationImportSummaryEmbed(input: {
  result: CwlRotationSheetImportConfirmResult;
}): EmbedBuilder {
  const lines: string[] = [
    `Season: ${input.result.season}`,
    "",
  ];
  for (const saved of input.result.saved) {
    if (saved.outcome === "created") {
      lines.push(
        `Saved ${saved.clanName || saved.clanTag} from ${saved.sourceTabName} as version ${saved.version}.`,
      );
      if (saved.warnings.length > 0) {
        lines.push(`Warnings: ${saved.warnings.join(" | ")}`);
      }
    } else if (saved.outcome === "blocked_existing") {
      lines.push(
        `Blocked ${saved.clanName || saved.clanTag} from ${saved.sourceTabName}: active version ${saved.existingVersion}.`,
      );
    } else {
      lines.push(`Skipped ${saved.clanName || saved.clanTag} from ${saved.sourceTabName}.`);
    }
    lines.push("");
  }

  if (input.result.skippedTrackedClans.length > 0) {
    lines.push(
      `Skipped tracked clans: ${input.result.skippedTrackedClans
        .map((entry) => `${entry.clanName || entry.clanTag} (${entry.reason})`)
        .join(" | ")}`,
    );
    lines.push("");
  }
  if (input.result.skippedTabs.length > 0) {
    lines.push(
      `Skipped tabs: ${input.result.skippedTabs
        .map((entry) => `${entry.tabTitle} (${entry.reason})`)
        .join(" | ")}`,
    );
  }
  if (input.result.ignoredRows.length > 0) {
    lines.push("");
    lines.push(
      `Ignored rows: ${input.result.ignoredRows
        .map(
          (entry) =>
            `${entry.clanName || entry.clanTag} ${entry.tabTitle} row ${entry.sheetRowNumber} (${entry.rawText})`,
        )
        .join(" | ")}`,
    );
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle("/cwl rotations import")
    .setDescription(buildDescription(lines));
}

function getCwlRotationImportActiveClanSession(
  session: CwlRotationImportSession,
): CwlRotationImportClanSession | null {
  return session.clanSessions[session.activeClanIndex] ?? null;
}

function getCwlRotationImportPreviewClanSession(
  session: CwlRotationImportSession,
): CwlRotationImportClanSession | null {
  const previewClanIndex = Math.max(0, Math.min(session.clanSessions.length - 1, session.previewClanIndex));
  return session.clanSessions[previewClanIndex] ?? null;
}

function getCwlRotationImportClanReviewRows(
  clanSession: CwlRotationImportClanSession,
): CwlRotationImportRow[] {
  return clanSession.tab.parsedRows.filter(isCwlRotationImportRowPendingReview);
}

function getCwlRotationImportClanReviewIndex(
  clanSession: CwlRotationImportClanSession,
): number {
  if (!clanSession.activeRowId) return 0;
  const reviewRows = getCwlRotationImportClanReviewRows(clanSession);
  const index = reviewRows.findIndex((row) => row.rowId === clanSession.activeRowId);
  return index >= 0 ? index : 0;
}

function getCwlRotationImportNextReviewRowId(
  clanSession: CwlRotationImportClanSession,
  currentRowId: string | null,
): string | null {
  const reviewRows = getCwlRotationImportClanReviewRows(clanSession);
  if (reviewRows.length <= 0) return null;
  const currentIndex = currentRowId ? reviewRows.findIndex((row) => row.rowId === currentRowId) : -1;
  for (let index = Math.max(0, currentIndex + 1); index < reviewRows.length; index += 1) {
    const row = reviewRows[index];
    if (row) return row.rowId;
  }
  return null;
}

function getCwlRotationImportNextClanIndex(
  session: CwlRotationImportSession,
  startIndex: number,
): number {
  for (let index = Math.max(0, startIndex); index < session.clanSessions.length; index += 1) {
    const clanSession = session.clanSessions[index];
    if (!clanSession) continue;
    if (!clanSession.confirmed && getCwlRotationImportClanReviewRows(clanSession).length > 0) {
      return index;
    }
  }
  return -1;
}

function activateCwlRotationImportClan(session: CwlRotationImportSession, clanIndex: number): void {
  const clanSession = session.clanSessions[clanIndex];
  if (!clanSession) return;
  session.activeClanIndex = clanIndex;
  clanSession.activeRowId = clanSession.reviewRowIds[0] ?? null;
}

function syncCwlRotationImportClanState(session: CwlRotationImportSession, clanIndex: number): void {
  const clanSession = session.clanSessions[clanIndex];
  if (!clanSession) return;
  clanSession.reviewRowIds = clanSession.tab.parsedRows.filter(isCwlRotationImportRowPendingReview).map((row) => row.rowId);
  if (clanSession.reviewRowIds.length <= 0) {
    clanSession.activeRowId = null;
    clanSession.readyToConfirm = !clanSession.confirmed;
    return;
  }
  clanSession.readyToConfirm = false;
  if (!clanSession.activeRowId || !clanSession.reviewRowIds.includes(clanSession.activeRowId)) {
    clanSession.activeRowId = clanSession.reviewRowIds[0] ?? null;
  }
}

function rebuildImportPreviewSessionState(session: CwlRotationImportSession): void {
  session.clanSessions = session.clanSessions.map((clanSession) => {
    const rebuiltTab = rebuildCwlRotationImportTabState(clanSession.tab, session.overwrite);
    return {
      ...clanSession,
      tab: rebuiltTab,
      reviewRowIds: rebuiltTab.parsedRows.filter(isCwlRotationImportRowPendingReview).map((row) => row.rowId),
      activeRowId:
        rebuiltTab.parsedRows.some((row) => row.rowId === clanSession.activeRowId && isCwlRotationImportRowPendingReview(row))
          ? clanSession.activeRowId
          : getCwlRotationImportNextReviewRowId(
              {
                ...clanSession,
                tab: rebuiltTab,
              },
              clanSession.activeRowId,
            ),
    };
  });

  if (session.view === "review") {
    const activeClan = getCwlRotationImportActiveClanSession(session);
    if (activeClan && !activeClan.confirmed && getCwlRotationImportClanReviewRows(activeClan).length <= 0) {
      activeClan.activeRowId = null;
    }
  }

  session.preview = {
    ...session.preview,
    matchedClans: session.clanSessions.map((clanSession) => clanSession.tab),
    warnings: [
      ...stripCwlRotationImportSummaryWarnings(session.baseWarnings),
      ...buildCwlRotationImportWarnings({
        ...session.preview,
        matchedClans: session.clanSessions.map((clanSession) => clanSession.tab),
      }),
    ],
  };
}

function buildCwlRotationImportSessionMessage(
  sessionId: string,
  session: CwlRotationImportSession,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} {
  const hasImportableClans = session.preview.matchedClans.some((clan) => clan.importable);
  const hasReviewRows = getCwlRotationImportReviewRows(session.preview).length > 0;
  if (session.view === "review") {
    const activeClan = getCwlRotationImportActiveClanSession(session);
    const reviewRows = activeClan ? getCwlRotationImportClanReviewRows(activeClan) : [];
    const reviewIndex = activeClan ? getCwlRotationImportClanReviewIndex(activeClan) : 0;
    const reviewRow = activeClan?.activeRowId
      ? reviewRows.find((row) => row.rowId === activeClan.activeRowId) ?? null
      : reviewRows[0] ?? null;
    const reviewCount = reviewRows.length;
    const hasCurrentClanPendingRows = reviewCount > 0;
    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
      ...buildCwlRotationImportReviewActionRows({
        sessionId,
        reviewIndex,
        reviewCount,
        hasImportableClans,
        hasPendingRows: hasCurrentClanPendingRows,
        previewPageIndex: session.pageIndex,
        canConfirmClan: Boolean(activeClan?.readyToConfirm),
        currentClanLabel: activeClan?.clanName || activeClan?.clanTag || "unknown clan",
      }),
    ];
    if (reviewRow) {
      const menu = activeClan
        ? buildCwlRotationImportReviewSelectMenuV2({
            sessionId,
            clanSession: activeClan,
            reviewRow,
          })
        : null;
      if (menu) components.push(menu);
    }
    return {
      embeds: [
        buildCwlRotationImportReviewEmbed({
          preview: session.preview,
          clanSession: activeClan,
          reviewRow,
          reviewIndex,
          reviewCount,
          sessionId,
          clanLabel: activeClan?.clanName || activeClan?.clanTag || "unknown clan",
          clanConfirmed: Boolean(activeClan?.confirmed),
          clanReadyToConfirm: Boolean(activeClan?.readyToConfirm),
          clanHasPendingRows: hasCurrentClanPendingRows,
        }),
      ],
      components,
    };
  }

  const previewClan = getCwlRotationImportPreviewClanSession(session);

  return {
    embeds: [
      buildCwlRotationImportPreviewEmbed({
        preview: session.preview,
        clanSession: previewClan,
        dayIndex: session.pageIndex,
        sessionId,
      }),
    ],
    components: buildCwlRotationImportPreviewActionRows({
      sessionId,
      session,
      clanSession: previewClan,
      dayIndex: session.pageIndex,
      hasImportableClans,
      hasReviewRows,
    }),
  };
}

export async function autocompleteCwlTrackedClan(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const season = resolveCurrentCwlSeasonKey();
  const query = String(interaction.options.getFocused(true).value ?? "")
    .trim()
    .toLowerCase();
  const rows = await prisma.cwlTrackedClan.findMany({
    where: { season },
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: { tag: true, name: true },
  });
  await interaction.respond(
    rows
      .map((row) => {
        const tag = normalizeClanTag(row.tag);
        const label = row.name?.trim() ? `${row.name.trim()} (${tag})` : tag;
        return {
          name: label.slice(0, 100),
          value: tag,
        };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) ||
          choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25),
  );
}

async function autocompleteCwlRotationShowDay(interaction: AutocompleteInteraction): Promise<void> {
  const query = String(interaction.options.getFocused(true).value ?? "")
    .trim()
    .toLowerCase();
  await interaction.respond(
    CWL_ROTATION_SHOW_DAY_CHOICES.filter((choice) => {
      if (!query) return true;
      const label = choice.name.toLowerCase();
      const value = String(choice.value).toLowerCase();
      return label.includes(query) || value.includes(query);
    }),
  );
}

async function autocompleteCwlRotationCreateRoster(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "roster") {
    await interaction.respond([]);
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", false) ?? "");
  if (!clanTag) {
    await interaction.respond([]);
    return;
  }

  const rosters = await rosterService.listCwlRostersForClan({
    guildId: interaction.guildId,
    clanTag,
    query: String(focused.value ?? ""),
    limit: 25,
  });
  await interaction.respond(
    rosters
      .map((roster) => {
        const label = String(roster.title ?? "").trim().replace(/\s+/g, " ") || roster.id;
        return {
          name: label.slice(0, 100),
          value: roster.id,
        };
      })
      .filter((choice) => {
        const query = String(focused.value ?? "")
          .trim()
          .toLowerCase();
        if (!query) return true;
        return choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query);
      })
      .slice(0, 25),
  );
}

async function autocompleteCwlRotationActiveClan(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.respond([]);
    return;
  }

  const query = String(interaction.options.getFocused(true).value ?? "").trim().toLowerCase();
  const season = resolveCurrentCwlSeasonKey();
  const [activePlans, trackedClans] = await Promise.all([
    cwlRotationService.listActivePlanExports({ season }),
    prisma.cwlTrackedClan.findMany({
      where: { season },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    }),
  ]);
  const trackedByTag = new Map(
    trackedClans
      .map((clan) => {
        const tag = normalizeClanTag(clan.tag);
        return tag ? ([tag, clan] as const) : null;
      })
      .filter((entry): entry is readonly [string, { name: string | null; tag: string }] => Boolean(entry)),
  );

  await interaction.respond(
    activePlans
      .map((plan) => {
        const trackedClan = trackedByTag.get(plan.clanTag);
        if (!trackedClan) return null;
        const clanName = String(trackedClan.name ?? "").trim() || String(plan.clanName ?? "").trim() || null;
        const label = clanName ? `${clanName} (${plan.clanTag})` : plan.clanTag;
        return {
          name: label.slice(0, 100),
          value: plan.clanTag,
        };
      })
      .filter((choice): choice is { name: string; value: string } => Boolean(choice))
      .filter(
        (choice) =>
          !query ||
          choice.name.toLowerCase().includes(query) ||
          choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25),
  );
}

async function autocompleteCwlRotationShowClan(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteCwlRotationActiveClan(interaction);
}

async function autocompleteCwlRotationDeleteClan(interaction: AutocompleteInteraction): Promise<void> {
  await autocompleteCwlRotationActiveClan(interaction);
}

async function handleMembersSubcommand(interaction: ChatInputCommandInteraction) {
  const season = resolveCurrentCwlSeasonKey();
  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  const inWarOnly = interaction.options.getBoolean("inwar", false) ?? false;
  if (!clanTag) {
    await interaction.editReply("Invalid CWL clan tag.");
    return;
  }

  const [trackedClan, roster, currentRound] = await Promise.all([
    prisma.cwlTrackedClan.findFirst({
      where: { season, tag: clanTag },
      select: { tag: true, name: true },
    }),
    cwlStateService.listSeasonRosterForClan({ clanTag, season }),
    cwlStateService.getCurrentRoundForClan({ clanTag, season }),
  ]);
  if (!trackedClan) {
    await interaction.editReply(`No tracked CWL clan found for ${clanTag} in season ${season}.`);
    return;
  }
  const [townHallEmojiByLevel, rosterContext] = await Promise.all([
    resolveTownHallEmojiMap(interaction.client),
    resolveCwlRosterContext({
      guildId: interaction.guildId ?? null,
      clanTag,
      season,
    }),
  ]);

  if (inWarOnly && !currentRound) {
    await interaction.editReply(`No active CWL round is persisted for ${clanTag}.`);
    return;
  }

  const entries = inWarOnly
    ? roster.filter((entry) => entry.currentRound?.inCurrentLineup)
    : roster;
  const rosterSignupTagSet = rosterContext.kind === "loaded" ? rosterContext.signupTagSet : null;
  const signedUpAndSpunCount = rosterContext.kind === "loaded"
    ? entries.filter((entry) => {
        const normalizedPlayerTag = normalizePlayerTag(entry.playerTag);
        return Boolean(normalizedPlayerTag) && rosterSignupTagSet?.has(normalizedPlayerTag) === true;
      }).length
    : null;
  const notSignedUpIncludedTags = rosterContext.kind === "loaded"
    ? entries
        .filter((entry) => {
          const normalizedPlayerTag = normalizePlayerTag(entry.playerTag);
          return Boolean(normalizedPlayerTag) && rosterSignupTagSet?.has(normalizedPlayerTag) !== true;
        })
        .map((entry) => normalizePlayerTag(entry.playerTag)?.replace(/^#/, ""))
        .filter((tag): tag is string => Boolean(tag))
    : [];
  const topInfoLines = [
    `Season: ${season}`,
    `Clan: ${trackedClan.name ? `${trackedClan.name} (${clanTag})` : clanTag}`,
  ];
  if (currentRound) {
    topInfoLines.push(
      renderCurrentRoundSummary({
        clanTag,
        clanName: currentRound.clanName,
        roundDay: currentRound.roundDay,
        roundState: currentRound.roundState,
        opponentTag: currentRound.opponentTag,
        opponentName: currentRound.opponentName,
        phaseEndsAt: currentRound.roundState.toLowerCase().includes("preparation")
          ? currentRound.startTime
          : currentRound.endTime,
      }),
    );
  }
  topInfoLines.push(
    buildCwlMembersRosterLine(rosterContext),
    `Members spun in CWL: ${entries.length}`,
    `Signed up + spun in CWL: ${buildCwlMembersSignedUpCountLabel(rosterContext, signedUpAndSpunCount)}`,
    "",
  );
  const memberListLines = renderMembersListLines({
    season,
    clanTag,
    clanName: trackedClan.name,
    entries,
    inWarOnly,
    townHallEmojiByLevel,
    rosterSignupTagSet,
  });
  const fullLines = [
    ...topInfoLines,
    ...memberListLines.slice(3),
    "",
    "Not signed up but included in CWL",
    buildCwlMembersExclusionCopyText(rosterContext, notSignedUpIncludedTags),
  ];
  const messageChunks = chunkLinesForDiscordMessages(fullLines);
  const payloads = messageChunks.map((chunkLines, chunkIndex) => ({
    embeds: buildCwlMembersMessageEmbeds({
      clanTag,
      chunkLines,
      chunkIndex,
      chunkCount: messageChunks.length,
    }),
  }));
  await interaction.editReply(payloads[0]);
  for (const payload of payloads.slice(1)) {
    await interaction.followUp({
      ...payload,
      ephemeral: true,
    });
  }
}

async function handleRotationCreateSubcommand(interaction: ChatInputCommandInteraction) {
  const clanTag = interaction.options.getString("clan", true);
  const rosterId = interaction.options.getString("roster", false);
  const size = interaction.options.getInteger("size", false);
  const exclude = interaction.options.getString("exclude", false);
  const overwrite = interaction.options.getBoolean("overwrite", false) ?? false;
  if (rosterId && (!interaction.inGuild() || !interaction.guildId)) {
    await interaction.editReply("Roster-backed CWL rotations can only be created in a server.");
    return;
  }
  const result = rosterId
      ? await cwlRotationService.createPlanFromRoster({
        clanTag,
        rosterId,
        guildId: interaction.guildId ?? null,
        lineupSize: size,
        overwrite,
      })
    : await cwlRotationService.createPlan({
        clanTag,
        excludeTagsRaw: exclude,
        lineupSize: size,
        overwrite,
        guildId: interaction.guildId ?? null,
      });

  if (result.outcome === "not_tracked") {
    await interaction.editReply(`No tracked CWL clan found for ${result.clanTag || clanTag}.`);
    return;
  }
  if (result.outcome === "invalid_size") {
    await interaction.editReply("CWL rotation lineup size must be 15 or 30.");
    return;
  }
  if (!rosterId && result.outcome === "not_preparation") {
    await interaction.editReply(
      `CWL rotations can only be created during persisted CWL preparation day for ${result.clanTag}.`,
    );
    return;
  }
  if (result.outcome === "blocked_existing") {
    await interaction.editReply(
      `A CWL rotation plan already exists for ${result.clanTag} this season. Use overwrite:true to replace version ${result.existingVersion}.`,
    );
    return;
  }
  if (!rosterId && result.outcome === "invalid_exclude_input") {
    await interaction.editReply(
      `These exclude values are not valid player tags: ${result.invalidTokens.join(", ")}. Use player tags separated by spaces or commas.`,
    );
    return;
  }
  if (!rosterId && result.outcome === "invalid_excludes") {
    await interaction.editReply(
      `These exclude tags are not in the observed ${result.season} CWL roster for ${result.clanTag}: ${result.invalidTags.join(", ")}`,
    );
    return;
  }
  if (result.outcome === "not_enough_players") {
    await interaction.editReply(formatCwlRotationNotEnoughPlayersResult(result));
    return;
  }

  if (rosterId) {
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster no longer exists.");
      return;
    }
    if (result.outcome === "roster_not_cwl") {
      await interaction.editReply("That roster is not a CWL roster.");
      return;
    }
    if (result.outcome === "roster_archived") {
      await interaction.editReply("That roster is archived.");
      return;
    }
    if (result.outcome === "roster_not_open_or_closed") {
      await interaction.editReply(
        `That CWL roster must be open or closed before it can be used for rotation creation.`,
      );
      return;
    }
    if (result.outcome === "roster_clan_mismatch") {
      await interaction.editReply(
        `That roster belongs to ${result.rosterClanTag || "another clan"}, not ${clanTag}.`,
      );
      return;
    }
    if (result.outcome === "no_confirmed_players") {
      await interaction.editReply("That roster has no confirmed signed-up accounts.");
      return;
    }
  }

  const createdResult = result.outcome === "created" ? result : null;
  const rosterCreatedResult =
    rosterId && createdResult && "rosterTitle" in createdResult
      ? (createdResult as CwlRotationRosterCreateSuccess)
      : null;
  const clanLabel = createdResult ? formatCwlRotationClanLabel(createdResult.clanName, createdResult.clanTag) : result.clanTag;
  const lines = [
    `Created CWL rotation plan for ${clanLabel}.`,
    `Clan: ${clanLabel}`,
    buildCwlRotationCreateSourceLine({
      rosterId: rosterCreatedResult?.rosterId ?? null,
      rosterTitle: rosterCreatedResult?.rosterTitle ?? null,
      rosterPostedMessageUrl: rosterCreatedResult?.rosterPostedMessageUrl ?? null,
    }),
    `Players included in rotation: ${createdResult?.playersIncludedCount ?? 0}`,
    ...buildCwlRotationCreateExcludedSectionLines(createdResult?.excludedPlayers ?? []),
    `Season: ${createdResult?.season ?? result.season}`,
    `Version: ${createdResult?.version ?? 0}`,
    `Lineup size: ${createdResult?.lineupSize ?? 0}`,
  ];
  if (createdResult && createdResult.warnings.length > 0) {
    lines.push("");
    lines.push(...createdResult.warnings);
  }
  const messageChunks = chunkLinesForDiscordMessages(lines);
  const payloads = messageChunks.map((chunkLines, chunkIndex) => ({
    embeds: buildCwlRotationCreateMessageEmbeds({
      clanTag: result.clanTag,
      chunkLines,
      chunkIndex,
      chunkCount: messageChunks.length,
    }),
  }));
  await interaction.editReply(payloads[0]);
  for (const payload of payloads.slice(1)) {
    await interaction.followUp({
      ...payload,
      ephemeral: true,
    });
  }
}

async function handleRotationShowSubcommand(client: Client, interaction: ChatInputCommandInteraction) {
  const season = resolveCurrentCwlSeasonKey();
  const clanTag = normalizeClanTag(interaction.options.getString("clan", false) ?? "");
  const day = interaction.options.getInteger("day", false);

  if (!clanTag) {
    const { embed, components } = await loadCwlRotationShowOverviewPayload({
      client,
      userId: interaction.user.id,
      season,
      refreshLeadershipMembers: true,
    });
    await interaction.editReply({
      embeds: [embed],
      components,
    });
    return;
  }

  const payload = await loadCwlRotationShowClanPayload({
    client,
    userId: interaction.user.id,
    season,
    clanTag,
    showBackButton: !day,
    explicitDay: day,
  });
  if (!payload) {
    const message = day
      ? `No planned CWL rotation day ${day} exists for ${clanTag}.`
      : `No active CWL rotation plan exists for ${clanTag} in ${season}.`;
    await interaction.editReply(message);
    return;
  }

  await interaction.editReply({
    embeds: [payload.payload.embed],
    components: payload.payload.components,
  });
}

async function handleRotationDeleteSubcommand(interaction: ChatInputCommandInteraction) {
  const clanTag = interaction.options.getString("clan", true);
  const result = await cwlRotationService.deleteActivePlan({ clanTag });

  if (result.outcome === "invalid_clan") {
    await interaction.editReply("Invalid CWL clan tag.");
    return;
  }
  if (result.outcome === "not_found") {
    await interaction.editReply(`No active CWL rotation exists for ${result.clanTag} in season ${result.season}.`);
    return;
  }

  const clanLabel = result.clanName ? `${result.clanName} (${result.clanTag})` : result.clanTag;
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl rotations delete ${result.clanTag}`)
        .setDescription(
          buildDescription([
            `Deleted active CWL rotation plan for ${clanLabel}.`,
            `Season: ${result.season}`,
            `Version: ${result.version}`,
          ]),
        ),
    ],
  });
}

async function handleRotationImportSubcommand(interaction: ChatInputCommandInteraction) {
  const sheetLink = interaction.options.getString("sheet", true);
  const overwrite = interaction.options.getBoolean("overwrite", false) ?? false;
  let preview;
  try {
    preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink,
      overwrite,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse the Google Sheets link.";
    await interaction.editReply(message);
    return;
  }
  const sessionId = createCwlRotationImportSession(
    preview,
    overwrite,
    interaction.user.id,
  );
  const session = getCwlRotationImportSession(sessionId, interaction.user.id);
  if (!session) {
    await interaction.editReply("Failed to create the CWL rotation import preview.");
    return;
  }
  const rendered = buildCwlRotationImportSessionMessage(sessionId, session);
  await interaction.editReply(rendered);
}

async function handleRotationExportSubcommand(interaction: ChatInputCommandInteraction) {
  const forceNew = interaction.options.getBoolean("new", false) ?? false;
  try {
    const result = await cwlRotationSheetService.exportActivePlans({
      new: forceNew,
      createdByDiscordUserId: interaction.user.id,
    });
    const messagePrefix = result.reused
      ? "Reused the existing public Google Sheet because no rotation updates were detected."
      : forceNew
        ? "Created a new public Google Sheet with the current CWL planner tabs."
        : "Created a new public Google Sheet with the current CWL planner tabs.";
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(CWL_EMBED_COLOR)
          .setTitle("/cwl rotations export")
          .setDescription(
            buildDescription([
              `${messagePrefix} ${result.tabCount} active CWL planner tab${result.tabCount === 1 ? "" : "s"}.`,
              `Link: ${result.spreadsheetUrl}`,
            ]),
          ),
      ],
    });
  } catch (err) {
    if (err instanceof GoogleSheetsAuthError && err.meta.grantType === "refresh_token") {
      console.error(
        `[cwl] rotation_export_failed namespace=${err.meta.namespace} operation=${err.meta.operation} status=${err.meta.status} errorCode=${err.meta.errorCode} reason=${err.meta.reason} grantType=${err.meta.grantType} error=${formatError(err)}`,
      );
      await interaction.editReply(
        "Google Sheets export auth failed. The configured Google OAuth refresh token is invalid or expired. Regenerate GOOGLE_OAUTH_REFRESH_TOKEN with Sheets write + Drive file scopes, redeploy, then retry.",
      );
      return;
    }
    throw err;
  }
}

export async function handleRosterSignupSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Use a valid tracked CWL clan tag.");
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

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.editReply("This command can only post to a text channel.");
    return;
  }
  if (!("send" in channel)) {
    await interaction.editReply("This command can only post in a server text channel.");
    return;
  }

  const roster = await rosterService.createRoster({
    guildId: interaction.guildId,
    rosterType: "CWL",
    rosterCategory: "signup",
    title: `${trackedClan.name?.trim() || trackedClan.tag} CWL Signup (${season})`,
    clanTag: trackedClan.tag,
    startsAt: new Date(),
    timezone,
    displayTimezone: timezone,
    lifecycleState: ROSTER_LIFECYCLE_STATE.OPEN,
    createdByDiscordUserId: interaction.user.id,
    updatedByDiscordUserId: interaction.user.id,
    cocService,
  });

  const payload = await rosterService.buildRosterSignupPayload(roster.id, null, {
    emojiClient: interaction.client,
  });
  if (!payload) {
    await interaction.editReply("Failed to build the CWL signup post.");
    return;
  }

  const postedMessage = await channel
    .send({
      embeds: [payload.embed],
      components: payload.components,
    })
    .catch(async (err) => {
      console.error(`[cwl] roster signup post_failed error=${formatError(err)}`);
      await interaction.editReply("Failed to post the CWL signup roster.");
      return null;
    });
  if (!postedMessage) return;

  await rosterService.recordRosterPostedMessage({
    rosterId: roster.id,
    channelId: postedMessage.channelId,
    messageId: postedMessage.id,
    messageUrl: postedMessage.url,
    postedByDiscordUserId: interaction.user.id,
  });

  await interaction.editReply(
    `Posted CWL signup roster for ${trackedClan.name?.trim() || trackedClan.tag} in <#${postedMessage.channelId}>.`,
  );
}

export async function handleRosterManagerSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Use a valid tracked CWL clan tag.");
    return;
  }

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

  const roster = await rosterService.findCwlRosterForClan({
    guildId: interaction.guildId,
    clanTag: trackedClan.tag,
    season,
  });
  if (!roster) {
    await interaction.editReply(`No CWL signup roster found for ${trackedClan.name?.trim() || trackedClan.tag}.`);
    return;
  }

  const rosterLabel = trackedClan.name?.trim() || trackedClan.tag;
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "report" || subcommand === "readiness") {
    // Report and readiness intentionally share the same manager-facing roster view in Phase 2.
    const reportText = await rosterService.buildRosterManagerReadinessText({
      rosterId: roster.id,
      cocService,
    });
    if (!reportText) {
      await interaction.editReply("Failed to build the roster readiness report.");
      return;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(CWL_EMBED_COLOR)
          .setTitle(`${rosterLabel} CWL readiness`)
          .setDescription(reportText),
      ],
    });
    return;
  }

  if (subcommand === "refresh") {
    await refreshRosterSignupPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(`Refreshed the posted CWL roster for ${rosterLabel}.`);
    return;
  }

  if (subcommand === "open" || subcommand === "close" || subcommand === "archive") {
    const lifecycleState =
      subcommand === "open"
        ? "OPEN"
        : subcommand === "close"
          ? "CLOSED"
          : "ARCHIVED";
    const result = await rosterService.updateRosterLifecycleState({
      rosterId: roster.id,
      lifecycleState,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster is no longer available.");
      return;
    }
    await refreshRosterSignupPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(buildRosterManagerLifecycleSummary(rosterLabel, lifecycleState));
    return;
  }

  const playersInput = interaction.options.getString("players", false) ?? "";
  const playerTags = parseRosterPlayerTags(playersInput);
  if (playerTags.length <= 0) {
    await interaction.editReply("Provide one or more player tags to update.");
    return;
  }

  if (subcommand === "add" || subcommand === "move") {
    const groupKey = interaction.options.getString("group", false);
    if (!groupKey) {
      await interaction.editReply("Provide a roster group for this action.");
      return;
    }

    if (subcommand === "add") {
      const result = await rosterService.addRosterSignupsForManager({
        rosterId: roster.id,
        groupKey,
        playerTags,
        updatedByDiscordUserId: interaction.user.id,
        bypassEligibility: true,
        cocService,
      });
      if (result.outcome === "roster_not_found") {
        await interaction.editReply("That roster is no longer available.");
        return;
      }
      await refreshRosterSignupPost(interaction, roster.id, cocService).catch(() => undefined);
      await interaction.editReply(formatRosterSignupResultSummary(result));
      return;
    }

    const result = await rosterService.moveRosterSignups({
      rosterId: roster.id,
      groupKey,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster is no longer available.");
      return;
    }
    if (result.outcome === "group_not_found") {
      await interaction.editReply("That roster group is no longer available.");
      return;
    }
    await refreshRosterSignupPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(formatRosterManagerMoveResultSummary(result));
    return;
  }

  if (subcommand === "remove") {
    const result = await rosterService.removeRosterSignupsAsManager({
      rosterId: roster.id,
      playerTags,
      updatedByDiscordUserId: interaction.user.id,
    });
    if (result.outcome === "roster_not_found") {
      await interaction.editReply("That roster is no longer available.");
      return;
    }
    await refreshRosterSignupPost(interaction, roster.id, cocService).catch(() => undefined);
    await interaction.editReply(formatRosterManagerRemoveResultSummary(result));
    return;
  }

  await interaction.editReply("Unsupported CWL roster subcommand.");
}

export async function handleCwlRotationImportButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseCwlRotationImportButtonCustomId(interaction.customId);
  if (!parsed) return;
  const session = getCwlRotationImportSession(parsed.sessionId, interaction.user.id);
  if (!session) {
    await interaction.reply({
      content: "That CWL rotation import preview has expired or is no longer available.",
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === "cancel") {
    deleteCwlRotationImportSession(parsed.sessionId);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(CWL_EMBED_COLOR)
          .setTitle("/cwl rotations import")
          .setDescription("CWL rotation import cancelled."),
      ],
      components: [],
    });
    return;
  }

  if (parsed.action === "page" || parsed.action === "preview-day") {
    session.view = "preview";
    session.pageIndex = Math.max(0, Math.min(6, parsed.pageIndex ?? 0));
    rebuildImportPreviewSessionState(session);
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  if (parsed.action === "preview") {
    session.view = "preview";
    session.pageIndex = Math.max(0, Math.min(6, parsed.pageIndex ?? session.pageIndex));
    rebuildImportPreviewSessionState(session);
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  if (parsed.action === "review") {
    session.view = "review";
    const firstClanIndex = getCwlRotationImportNextClanIndex(session, 0);
    if (firstClanIndex < 0) {
      session.view = "preview";
    } else {
      activateCwlRotationImportClan(session, firstClanIndex);
    }
    rebuildImportPreviewSessionState(session);
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  if (parsed.action === "review-page") {
    session.view = "review";
    const activeClan = getCwlRotationImportActiveClanSession(session);
    if (!activeClan) {
      await interaction.reply({
        content: "That CWL rotation import review session has expired. Please restart the import.",
        ephemeral: true,
      });
      return;
    }
    syncCwlRotationImportClanState(session, session.activeClanIndex);
    const reviewRows = getCwlRotationImportClanReviewRows(activeClan);
    const reviewIndex = Math.max(0, Math.min(reviewRows.length - 1, parsed.pageIndex ?? 0));
    activeClan.activeRowId = reviewRows[reviewIndex]?.rowId ?? null;
    rebuildImportPreviewSessionState(session);
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  if (session.view === "review") {
    const activeClan = getCwlRotationImportActiveClanSession(session);
    if (!activeClan) {
      await interaction.reply({
        content: "That CWL rotation import review session has expired. Please restart the import.",
        ephemeral: true,
      });
      return;
    }

    syncCwlRotationImportClanState(session, session.activeClanIndex);
    if (!activeClan.readyToConfirm) {
      await interaction.reply({
        ephemeral: true,
        content: `Confirm ${activeClan.clanName || activeClan.clanTag} after its remaining review rows are resolved.`,
      });
      return;
    }
    const pendingRows = getCwlRotationImportClanReviewRows(activeClan);
    if (pendingRows.length > 0) {
      await interaction.reply({
        ephemeral: true,
        content: `Cannot confirm ${activeClan.clanName || activeClan.clanTag} while ${pendingRows.length} row${pendingRows.length === 1 ? "" : "s"} still need review.`,
      });
      return;
    }

    activeClan.confirmed = true;
    activeClan.readyToConfirm = false;
    activeClan.activeRowId = null;
    const nextClanIndex = getCwlRotationImportNextClanIndex(session, session.activeClanIndex + 1);
    if (nextClanIndex >= 0) {
      session.view = "review";
      activateCwlRotationImportClan(session, nextClanIndex);
    } else {
      session.view = "preview";
    }

    rebuildImportPreviewSessionState(session);
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  const pendingRows = getCwlRotationImportPendingRows(session.preview);
  if (pendingRows.length > 0) {
    await interaction.reply({
      ephemeral: true,
      content: `Cannot save the CWL rotation import while ${pendingRows.length} row${pendingRows.length === 1 ? "" : "s"} still need review.`,
    });
    return;
  }

  await interaction.deferUpdate();
  try {
    const result = await cwlRotationSheetService.confirmImport({
      preview: session.preview,
      overwrite: session.overwrite,
    });
    deleteCwlRotationImportSession(parsed.sessionId);
    await interaction.editReply({
      embeds: [buildCwlRotationImportSummaryEmbed({ result })],
      components: [],
    });
  } catch (err) {
    console.error(`CWL rotation import confirmation failed: ${formatError(err)}`);
    await interaction.editReply({
      content: "Failed to save the CWL rotation import.",
      embeds: [],
      components: [],
    });
  }
}

export async function handleCwlRotationImportSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseCwlRotationImportSelectMenuCustomId(interaction.customId);
  if (!parsed) return;
  const session = getCwlRotationImportSession(parsed.sessionId, interaction.user.id);
  if (!session) {
    await interaction.reply({
      content: "That CWL rotation import preview has expired or is no longer available.",
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === "preview-clan") {
    if (session.view !== "preview") {
      await interaction.reply({
        content: "That CWL rotation import preview has expired. Please restart the import.",
        ephemeral: true,
      });
      return;
    }

    const selectedClanTag = normalizeClanTag(String(interaction.values[0] ?? ""));
    const selectedClanIndex = session.clanSessions.findIndex(
      (clanSession) => normalizeClanTag(clanSession.clanTag) === selectedClanTag,
    );
    if (selectedClanIndex < 0) {
      await interaction.reply({
        content: "That CWL rotation import clan selection is no longer available. Please restart the import.",
        ephemeral: true,
      });
      return;
    }

    const selectedClan = session.clanSessions[selectedClanIndex] ?? null;
    const selectedDay = Math.max(1, Math.min(7, Math.trunc(session.pageIndex) + 1));
    const hasUsableRows = Boolean(selectedClan?.tab.parsedRows.length > 0);
    if (!hasUsableRows) {
      await interaction.reply({
        content: `That clan has no usable rows for Day ${selectedDay}. Select a different clan or day.`,
        ephemeral: true,
      });
      return;
    }

    session.previewClanIndex = selectedClanIndex;
    session.view = "preview";
    await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
    return;
  }

  const activeClan = getCwlRotationImportActiveClanSession(session);
  if (!activeClan) {
    await interaction.reply({
      content: "That CWL rotation import review session has expired. Please restart the import.",
      ephemeral: true,
    });
    return;
  }

  syncCwlRotationImportClanState(session, session.activeClanIndex);
  if (activeClan.confirmed) {
    await interaction.reply({
      content: "That CWL rotation import review session has already advanced. Please restart the import if you need to change earlier rows.",
      ephemeral: true,
    });
    return;
  }

  const targetRow = activeClan.tab.parsedRows.find((row) => row.rowId === parsed.rowId);
  if (!targetRow || targetRow.rowId !== activeClan.activeRowId) {
    await interaction.reply({
      content: "That CWL rotation import review session has expired. Please restart the import.",
      ephemeral: true,
    });
    return;
  }

  const choice = String(interaction.values[0] ?? "");
  if (choice === "ignore") {
    targetRow.ignored = true;
    targetRow.classification = "explicitly_ignored";
    targetRow.reason = "Explicitly ignored by the importing admin.";
    targetRow.resolvedPlayerTag = null;
    targetRow.resolvedPlayerName = null;
  } else if (choice.startsWith("tag:")) {
    const playerTag = normalizePlayerTag(choice.slice(4));
    const availableOptions = buildCwlRotationImportReviewOptions({
      clanSession: activeClan,
      reviewRow: targetRow,
    });
    const resolvedTags = getCwlRotationImportResolvedPlayerTagSetForClan(activeClan);
    if (resolvedTags.has(playerTag)) {
      await interaction.reply({
        content: "That tracked player is already mapped to another row in this clan review session.",
        ephemeral: true,
      });
      return;
    }
    const option = availableOptions.options.find((entry) => normalizePlayerTag(entry.playerTag) === playerTag) ?? null;
    if (!option) {
      await interaction.reply({
        content: "That CWL rotation import review session has expired. Please restart the import.",
        ephemeral: true,
      });
      return;
    }
    targetRow.resolvedPlayerTag = option.playerTag;
    targetRow.resolvedPlayerName = option.playerName;
    targetRow.ignored = false;
    if (targetRow.classification === "unresolved_needs_review" || targetRow.classification === "ambiguous_match_needs_review" || targetRow.classification === "fuzzy_match_needs_review") {
      targetRow.reason = null;
    }
  } else {
    await interaction.reply({
      content: "Unsupported CWL rotation import selection.",
      ephemeral: true,
    });
    return;
  }

  activeClan.activeRowId = getCwlRotationImportNextReviewRowId(activeClan, targetRow.rowId);
  syncCwlRotationImportClanState(session, session.activeClanIndex);
  rebuildImportPreviewSessionState(session);
  const activeClanAfterUpdate = getCwlRotationImportActiveClanSession(session);
  if (!activeClanAfterUpdate) {
    session.view = "preview";
  } else {
    session.view = "review";
  }

  await interaction.update(buildCwlRotationImportSessionMessage(parsed.sessionId, session));
}

export async function handleCwlRotationShowButtonInteraction(
  interaction: ButtonInteraction,
  cocService?: CoCService,
): Promise<void> {
  const parsed = parseCwlRotationShowCustomId(interaction.customId);
  if (!parsed) return;
  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the command requester can use these buttons.",
      ephemeral: true,
    });
    return;
  }

  if (parsed.action === "back") {
    try {
      await interaction.deferUpdate();
      const { embed, components } = await loadCwlRotationShowOverviewPayload({
        client: interaction.client,
        userId: interaction.user.id,
        season: parsed.season,
      });
      await interaction.editReply({
        embeds: [embed],
        components,
      });
    } catch (error) {
      console.error(`CWL rotation show back failed: ${formatError(error)}`);
      const failurePayload = {
        content: "Unable to load the CWL overview right now.",
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(failurePayload);
      } else {
        await interaction.reply(failurePayload);
      }
    }
    return;
  }

  if (parsed.action === "refresh") {
    const currentView = await loadCwlRotationShowClanPayload({
      client: interaction.client,
      userId: interaction.user.id,
      season: parsed.season,
      clanTag: parsed.clanTag,
      pageIndex: parsed.pageIndex,
      showBackButton: parsed.showBackButton,
      loading: true,
    });
    if (!currentView) {
      await interaction.reply({
        content: `No active CWL rotation plan exists for ${parsed.clanTag} in ${parsed.season}.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.update({
      embeds: [currentView.payload.embed],
      components: currentView.payload.components,
    });

    try {
      await cwlStateService.refreshTrackedCwlStateForClan({
        cocService: cocService ?? new CoCService(),
        clanTag: parsed.clanTag,
        season: parsed.season,
      });
      const refreshedView = await loadCwlRotationShowClanPayload({
        client: interaction.client,
        userId: interaction.user.id,
        season: parsed.season,
        clanTag: parsed.clanTag,
        pageIndex: parsed.pageIndex,
        showBackButton: parsed.showBackButton,
      });
      if (!refreshedView) {
        await interaction.editReply({
          embeds: [currentView.payload.embed],
          components: currentView.payload.components,
        });
        return;
      }
      await interaction.editReply({
        embeds: [refreshedView.payload.embed],
        components: refreshedView.payload.components,
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [currentView.payload.embed],
        components: currentView.payload.components,
      });
      await interaction.followUp({
        ephemeral: true,
        content: "Failed to refresh the CWL rotation view.",
      });
    }
    return;
  }

  if (parsed.action !== "page") {
    return;
  }

  const payload = await loadCwlRotationShowClanPayload({
    client: interaction.client,
    userId: interaction.user.id,
    season: parsed.season,
    clanTag: parsed.clanTag,
    pageIndex: parsed.pageIndex,
    showBackButton: true,
  });
  if (!payload) {
    await interaction.reply({
      content: `No active CWL rotation plan exists for ${parsed.clanTag} in ${parsed.season}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    embeds: [payload.payload.embed],
    components: payload.payload.components,
  });
}

function getDiscordErrorCode(err: unknown): number | null {
  const code = (err as { code?: number } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

async function respondBestEffortToCwlRotationShowFailure(
  interaction: StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  const payload = {
    ephemeral: true,
    content,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (responseError) {
    const code = getDiscordErrorCode(responseError);
    if (code === 10062) {
      console.warn("CWL rotation show fallback response expired before response (10062).");
      return;
    }

    console.error(`CWL rotation show fallback response failed: ${formatError(responseError)}`);
  }
}

export async function handleCwlRotationShowSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseCwlRotationShowCustomId(interaction.customId);
  if (!parsed || parsed.action !== "select") return;
  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the command requester can use these buttons.",
      ephemeral: true,
    });
    return;
  }

  const season = parsed.season;
  const clanTag = normalizeClanTag(String(interaction.values[0] ?? ""));
  if (!clanTag) {
    await interaction.reply({
      content: "That CWL clan selection is not valid.",
      ephemeral: true,
    });
    return;
  }

  const renderPayload = await loadCwlRotationShowClanPayload({
    client: interaction.client,
    userId: interaction.user.id,
    season,
    clanTag,
    showBackButton: true,
    explicitDay: parsed.selectedDay,
  });
  if (!renderPayload) {
    await interaction.reply({
      content: `No active CWL rotation plan exists for ${clanTag} in ${season}.`,
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.update({
      embeds: [renderPayload.payload.embed],
      components: renderPayload.payload.components,
    });
  } catch (err) {
    const code = getDiscordErrorCode(err);
    if (code === 10062) {
      console.warn("CWL rotation show select menu expired before update (10062).");
      return;
    }

    console.error(`CWL rotation show select menu failed: ${formatError(err)}`);
    await respondBestEffortToCwlRotationShowFailure(
      interaction,
      "Failed to update the CWL rotation show overview.",
    );
  }
}

export async function handleRosterSignupButtonInteraction(
  interaction: ButtonInteraction,
  cocService?: CoCService | null,
): Promise<void> {
  const parsed = parseRosterSignupButtonCustomId(interaction.customId);
  if (!parsed) return;

  const deferred = await interaction.deferReply({ ephemeral: true }).then(() => true).catch(() => false);
  const sendSignupResponse = async (payload: { content?: string; embeds?: any[]; components?: any[] }): Promise<void> => {
    if (deferred) {
      await interaction
        .editReply({
          ...payload,
          embeds: payload.embeds ?? [],
          components: payload.components ?? [],
        })
        .catch(() => undefined);
      return;
    }

    await interaction
      .reply({
        ...payload,
        ephemeral: true,
      })
      .catch(() => undefined);
  };

  const result = await rosterService.createRosterSignupSelectionPanel({
    rosterId: parsed.rosterId,
    discordUserId: interaction.user.id,
    discordClient: interaction.client,
    cocService: cocService ?? null,
  });

  if (result.outcome === "roster_not_found") {
    await sendSignupResponse({
      content: "That roster is no longer available.",
    });
    return;
  }

  if (result.outcome === "roster_closed") {
    await sendSignupResponse({
      content: "Signups are closed for that roster.",
    });
    return;
  }

  if (result.outcome === "group_not_found") {
    await sendSignupResponse({
      content: "That roster group is no longer available.",
    });
    return;
  }

  if (result.outcome === "no_linked_accounts") {
    await sendSignupResponse({
      content: "No linked player accounts were found for your Discord user.",
    });
    return;
  }

  if (result.outcome !== "ready") {
    return;
  }

  await sendSignupResponse({
    embeds: [result.panel.embed],
    components: result.panel.components,
  });
}

export async function handleRosterRemoveButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseRosterRemoveButtonCustomId(interaction.customId);
  if (!parsed) return;

  const result = await rosterService.createRosterRemoveSelectionPanel({
    rosterId: parsed.rosterId,
    discordUserId: interaction.user.id,
  });

  if (result.outcome === "roster_not_found") {
    await interaction.reply({
      content: "That roster is no longer available.",
      ephemeral: true,
    });
    return;
  }

  if (result.outcome === "no_owned_entries") {
    await interaction.reply({
      content: "You do not have any roster signups to remove.",
      ephemeral: true,
    });
    return;
  }

  if (result.outcome !== "ready") {
    return;
  }

  await interaction.reply({
    embeds: [result.panel.embed],
    components: result.panel.components,
    ephemeral: true,
  });
}

export async function handleRosterSelectionMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const accountParsed = parseRosterSelectionMenuCustomId(interaction.customId);
  const groupParsed = accountParsed ? null : parseRosterSelectionGroupMenuCustomId(interaction.customId);
  const parsed = accountParsed ?? groupParsed;
  if (!parsed) return;

  const result = await rosterService.updateRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    selectedTags: accountParsed ? interaction.values : undefined,
    selectedGroupKey: groupParsed ? interaction.values[0] ?? null : undefined,
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
}

export async function handleRosterSelectionActionButtonInteraction(
  interaction: ButtonInteraction,
  cocService?: CoCService | null,
): Promise<void> {
  const parsed = parseRosterSelectionActionButtonCustomId(interaction.customId);
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

  const sendSelectionResponse = async (content: string): Promise<void> => {
    if (interaction.replied || interaction.deferred) {
      await interaction
        .editReply({
          content,
          embeds: [],
          components: [],
        })
        .catch(() => undefined);
      return;
    }

    await interaction
      .reply({
        content,
        ephemeral: true,
      })
      .catch(() => undefined);
  };

  await showRosterMutationApplyingState(interaction);
  const result = await rosterService.confirmRosterSelectionPanel({
    sessionId: parsed.sessionId,
    discordUserId: interaction.user.id,
    discordClient: interaction.client,
    cocService: cocService ?? null,
  });
  if (result.outcome === "session_not_found") {
    await sendSelectionResponse("That roster selection has expired. Please start again.");
    return;
  }
  if (result.outcome === "forbidden") {
    await sendSelectionResponse("Only the original requester can use this roster selection.");
    return;
  }

  if (result.outcome === "missing_user") {
    await sendSelectionResponse("Select a Discord user first.");
    return;
  }
  if (result.outcome === "missing_players") {
    await sendSelectionResponse("Select at least one linked player.");
    return;
  }
  if (result.outcome === "missing_group") {
    await sendSelectionResponse("Select a roster group first.");
    return;
  }

  if (result.outcome === "add_user") {
    await syncRosterRoleAssignments(interaction.client, result.result.rosterId).catch(() => undefined);
    await refreshRosterSignupPost(interaction, result.result.rosterId, cocService).catch(() => undefined);
    await sendSelectionResponse(formatRosterSignupResultSummary(result.result));
    return;
  }

  if (result.outcome === "remove_user") {
    await refreshRosterSignupPost(interaction, result.result.rosterId, cocService).catch(() => undefined);
    await sendSelectionResponse(formatRosterRemoveResultSummary(result.result));
    return;
  }

  if (result.outcome === "signup") {
    await syncRosterRoleAssignments(interaction.client, result.result.rosterId).catch(() => undefined);
    await refreshRosterSignupPost(interaction, result.result.rosterId, cocService).catch(() => undefined);
    await sendSelectionResponse(formatRosterSignupResultSummary(result.result));
    return;
  }

  await refreshRosterSignupPost(interaction, result.result.rosterId, cocService).catch(() => undefined);
  await sendSelectionResponse(formatRosterRemoveResultSummary(result.result));
}

export const Cwl: Command = {
  name: "cwl",
  description: "Inspect persisted CWL rosters, day-paged rotation plans, and planner sheet imports/exports",
  options: [
    {
      name: "members",
      description: "Show the observed current-season CWL roster for one tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked CWL clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "inwar",
          description: "Only show the persisted current/prep lineup",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "rotations",
      description: "Show or create current-season CWL rotation plans",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "show",
          description: "Show the CWL overview or one clan plan, one CWL day per page",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "clan",
              description: "Tracked CWL clan tag",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
            {
              name: "day",
              description: "Specific CWL day to inspect",
              type: ApplicationCommandOptionType.Integer,
              required: false,
              minValue: 1,
              maxValue: 7,
              autocomplete: true,
            },
          ],
        },
        {
          name: "create",
          description: "Create or replace the active CWL rotation plan for one tracked clan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "clan",
              description: "Tracked CWL clan tag",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
            {
              name: "size",
              description: "CWL lineup size",
              type: ApplicationCommandOptionType.Integer,
              required: false,
              choices: [
                { name: "15", value: 15 },
                { name: "30", value: 30 },
              ],
            },
            {
              name: "roster",
              description: "Optional CWL roster id to seed rotation players from",
              type: ApplicationCommandOptionType.String,
              required: false,
              autocomplete: true,
            },
            {
              name: "exclude",
              description: "Player tags to exclude from planning, separated by spaces or commas",
              type: ApplicationCommandOptionType.String,
              required: false,
            },
            {
              name: "overwrite",
              description: "Replace the active current-season plan",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "import",
          description: "Import active CWL planner tabs from one public Google Sheet",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "sheet",
              description: "Public Google Sheet link with CWL planner tabs",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
            {
              name: "overwrite",
              description: "Replace the active current-season plan when it already exists",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "export",
          description: "Export the active CWL planner data to a brand-new public Google Sheet",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "new",
              description: "Always create a new spreadsheet instead of reusing an unchanged export",
              type: ApplicationCommandOptionType.Boolean,
              required: false,
            },
          ],
        },
        {
          name: "delete",
          description: "Delete the active CWL rotation plan for one tracked clan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "clan",
              description: "Tracked CWL clan tag",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    await interaction.deferReply({ ephemeral: !isPublic });

    try {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand(true);
      if (!group && subcommand === "members") {
        await handleMembersSubcommand(interaction);
        return;
      }
      if (!group && subcommand === "signup") {
        await handleRosterSignupSubcommand(interaction, cocService);
        return;
      }
      if (group === "roster") {
        await handleRosterManagerSubcommand(interaction, cocService);
        return;
      }
      if (group === "rotations" && subcommand === "create") {
        await handleRotationCreateSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "import") {
        await handleRotationImportSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "export") {
        await handleRotationExportSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "delete") {
        await handleRotationDeleteSubcommand(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "show") {
        await handleRotationShowSubcommand(client, interaction);
        return;
      }
      await interaction.editReply("Unsupported CWL subcommand.");
    } catch (err) {
      console.error(`[cwl] command_failed error=${formatError(err)}`);
      await interaction.editReply("Failed to load CWL data.");
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "day") {
      await autocompleteCwlRotationShowDay(interaction);
      return;
    }
    if (focused.name === "timezone") {
      await interaction.respond(autocompleteSyncTimeZones(focused.value));
      return;
    }
    if (focused.name === "clan") {
      let group = "";
      let subcommand = "";
      try {
        group = interaction.options.getSubcommandGroup(false) ?? "";
      } catch {
        group = "";
      }
      try {
        subcommand = interaction.options.getSubcommand(false) ?? "";
      } catch {
        subcommand = "";
      }
      if (group === "rotations" && subcommand === "show") {
        await autocompleteCwlRotationShowClan(interaction);
        return;
      }
      if (group === "rotations" && subcommand === "delete") {
        await autocompleteCwlRotationDeleteClan(interaction);
        return;
      }
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    if (focused.name === "roster") {
      await autocompleteCwlRotationCreateRoster(interaction);
      return;
    }
    await interaction.respond([]);
  },
};





