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
} from "discord.js";
import { randomUUID } from "crypto";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { cwlRotationService } from "../services/CwlRotationService";
import {
  cwlRotationSheetService,
  type CwlRotationSheetImportConfirmResult,
  type CwlRotationSheetImportPreview,
} from "../services/CwlRotationSheetService";
import { cwlStateService } from "../services/CwlStateService";
import { normalizeClanTag } from "../services/PlayerLinkService";

const CWL_EMBED_COLOR = 0xfee75c;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const CWL_ROTATION_IMPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const CWL_ROTATION_IMPORT_SESSION_PREFIX = "cwl-rot-import";
const CWL_ROTATION_SHOW_SESSION_PREFIX = "cwl-rot-show";
type CwlRotationPlanExport = Awaited<ReturnType<typeof cwlRotationService.listActivePlanExports>>[number];

type CwlRotationImportSession = {
  requestedByUserId: string;
  createdAtMs: number;
  preview: CwlRotationSheetImportPreview;
  overwrite: boolean;
};

const cwlRotationImportSessions = new Map<string, CwlRotationImportSession>();

function formatRelativeTimestamp(value: Date | null): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "unknown";
  }
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

function buildDescription(lines: string[]): string {
  const description = lines.join("\n");
  if (description.length <= DISCORD_DESCRIPTION_LIMIT) {
    return description;
  }
  return `${description.slice(0, DISCORD_DESCRIPTION_LIMIT - 13)}\n...truncated`;
}

function buildCwlRotationMemberLines(input: {
  members: Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
  }>;
  emptyMessage: string;
}): string[] {
  if (input.members.length <= 0) {
    return [input.emptyMessage];
  }

  return input.members.map((member) => {
    const prefix = member.subbedOut ? ":x:" : ":black_circle:";
    return `${prefix} ${member.playerName} (${member.playerTag})`;
  });
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
}) {
  const lines: string[] = [
    `Season: ${input.season}`,
    `Clan: ${input.clanName ? `${input.clanName} (${input.clanTag})` : input.clanTag}`,
    "",
  ];
  for (const entry of input.entries) {
    const linkLabel = entry.linkedDiscordUserId
      ? `<@${entry.linkedDiscordUserId}>`
      : "unlinked";
    const currentLabel = entry.currentRound
      ? entry.currentRound.inCurrentLineup
        ? `${entry.currentRound.roundState} ${entry.currentRound.attacksUsed}/${entry.currentRound.attacksAvailable}`
        : "not in current lineup"
      : "no current round";
    lines.push(
      `${entry.playerName} \`${entry.playerTag}\` - days ${entry.daysParticipated} - ${linkLabel} - ${currentLabel}`,
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

function renderValidationSummary(input: {
  missingExpectedPlayerTags: string[];
  extraActualPlayerTags: string[];
  actualAvailable: boolean;
  complete: boolean;
}): string {
  if (!input.actualAvailable) return "actual lineup unavailable";
  if (input.complete) return "complete";
  const parts: string[] = [];
  if (input.missingExpectedPlayerTags.length > 0) {
    parts.push(`missing ${input.missingExpectedPlayerTags.join(", ")}`);
  }
  if (input.extraActualPlayerTags.length > 0) {
    parts.push(`extra ${input.extraActualPlayerTags.join(", ")}`);
  }
  return parts.join(" | ");
}

function pruneExpiredCwlRotationImportSessions(nowMs = Date.now()): void {
  for (const [sessionId, session] of cwlRotationImportSessions.entries()) {
    if (session.createdAtMs + CWL_ROTATION_IMPORT_SESSION_TTL_MS <= nowMs) {
      cwlRotationImportSessions.delete(sessionId);
    }
  }
}

function createCwlRotationImportSession(
  preview: CwlRotationSheetImportPreview,
  overwrite: boolean,
  requestedByUserId: string,
): string {
  pruneExpiredCwlRotationImportSessions();
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 18);
  cwlRotationImportSessions.set(sessionId, {
    requestedByUserId,
    createdAtMs: Date.now(),
    preview,
    overwrite,
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

function parseCwlRotationImportButtonCustomId(
  customId: string,
): { action: "page" | "confirm" | "cancel"; sessionId: string; pageIndex: number | null } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 3 || parts[0] !== CWL_ROTATION_IMPORT_SESSION_PREFIX) return null;
  const action = parts[1];
  if (action !== "page" && action !== "confirm" && action !== "cancel") return null;
  const sessionId = String(parts[2] ?? "").trim();
  if (!sessionId) return null;
  const pageIndex =
    action === "page"
      ? Math.max(0, Math.trunc(Number(parts[3] ?? "0") || 0))
      : null;
  return {
    action,
    sessionId,
    pageIndex,
  };
}

function buildCwlRotationImportPreviewPageLines(input: {
  preview: CwlRotationSheetImportPreview;
  pageIndex: number;
}): string[] {
  const roundDay = Math.max(1, Math.min(7, Math.trunc(input.pageIndex) + 1));
  const lines: string[] = [
    `Season: ${input.preview.season}`,
    `Source: ${input.preview.sourceSheetTitle || input.preview.sourceSheetId}`,
    `Page: ${roundDay} / 7`,
    `Importable clans: ${input.preview.matchedClans.filter((clan) => clan.importable).length} / ${input.preview.matchedClans.length}`,
    "",
  ];

  if (input.preview.skippedTrackedClans.length > 0) {
    lines.push(
      `Skipped tracked clans: ${input.preview.skippedTrackedClans
        .map((entry) => `${entry.clanName || entry.clanTag} (${entry.reason})`)
        .join(" | ")}`,
    );
    lines.push("");
  }
  if (input.preview.skippedTabs.length > 0) {
    lines.push(
      `Skipped tabs: ${input.preview.skippedTabs
        .map((entry) => `${entry.tabTitle} (${entry.reason})`)
        .join(" | ")}`,
    );
    lines.push("");
  }

  for (const clan of input.preview.matchedClans) {
    const day = clan.days.find((entry) => entry.roundDay === roundDay);
    const clanLabel = clan.clanName || clan.clanTag;
    const statusLabel = clan.importable
      ? ""
      : ` - blocked${clan.importBlockedReason ? ` (${clan.importBlockedReason})` : ""}`;
    lines.push(`**${clanLabel}**${statusLabel}`);
    if (clan.warnings.length > 0) {
      lines.push(`Warnings: ${clan.warnings.join(" | ")}`);
    }
    if (!day || day.members.length <= 0) {
      lines.push("No rows parsed.");
    } else {
      lines.push(
        ...buildCwlRotationMemberLines({
          members: day.members,
          emptyMessage: "No rows parsed.",
        }),
      );
    }
    lines.push("");
  }

  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function buildCwlRotationImportPreviewEmbed(input: {
  preview: CwlRotationSheetImportPreview;
  pageIndex: number;
  sessionId: string;
}): EmbedBuilder {
  const roundDay = Math.max(1, Math.min(7, Math.trunc(input.pageIndex) + 1));
  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle(`/cwl rotations import preview - day ${roundDay}`)
    .setDescription(
      buildDescription(
        buildCwlRotationImportPreviewPageLines({
          preview: input.preview,
          pageIndex: input.pageIndex,
        }),
      ),
    )
    .setFooter({
      text: `Session ${input.sessionId.slice(0, 8)} - page ${roundDay}/7`,
    });
}

function buildCwlRotationImportActionRows(input: {
  sessionId: string;
  pageIndex: number;
  hasImportableClans: boolean;
}): ActionRowBuilder<ButtonBuilder>[] {
  const prevButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:page:${input.sessionId}:${Math.max(0, input.pageIndex - 1)}`)
    .setLabel("Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.pageIndex <= 0);
  const nextButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:page:${input.sessionId}:${Math.min(6, input.pageIndex + 1)}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.pageIndex >= 6);
  const confirmButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:confirm:${input.sessionId}`)
    .setLabel("Save Import")
    .setStyle(ButtonStyle.Success)
    .setDisabled(!input.hasImportableClans);
  const cancelButton = new ButtonBuilder()
    .setCustomId(`${CWL_ROTATION_IMPORT_SESSION_PREFIX}:cancel:${input.sessionId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton, confirmButton, cancelButton)];
}

function buildCwlRotationShowButtonCustomId(input: {
  userId: string;
  clanTag: string;
  season: string;
  pageIndex: number;
}): string {
  return `${CWL_ROTATION_SHOW_SESSION_PREFIX}:page:${input.userId}:${input.clanTag}:${input.season}:${input.pageIndex}`;
}

function parseCwlRotationShowButtonCustomId(
  customId: string,
): { userId: string; clanTag: string; season: string; pageIndex: number } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 6 || parts[0] !== CWL_ROTATION_SHOW_SESSION_PREFIX || parts[1] !== "page") return null;
  const userId = String(parts[2] ?? "").trim();
  const clanTag = normalizeClanTag(parts[3] ?? "");
  const season = String(parts[4] ?? "").trim();
  const pageIndex = Math.max(0, Math.trunc(Number(parts[5] ?? "0") || 0));
  if (!userId || !clanTag || !season) return null;
  return { userId, clanTag, season, pageIndex };
}

export function isCwlRotationShowButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${CWL_ROTATION_SHOW_SESSION_PREFIX}:page:`);
}

function buildCwlRotationShowActionRows(input: {
  userId: string;
  clanTag: string;
  season: string;
  pageIndex: number;
  totalPages: number;
}): ActionRowBuilder<ButtonBuilder>[] {
  const prevButton = new ButtonBuilder()
    .setCustomId(
      buildCwlRotationShowButtonCustomId({
        userId: input.userId,
        clanTag: input.clanTag,
        season: input.season,
        pageIndex: Math.max(0, input.pageIndex - 1),
      }),
    )
    .setLabel("Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.pageIndex <= 0);
  const nextButton = new ButtonBuilder()
    .setCustomId(
      buildCwlRotationShowButtonCustomId({
        userId: input.userId,
        clanTag: input.clanTag,
        season: input.season,
        pageIndex: Math.min(Math.max(0, input.totalPages - 1), input.pageIndex + 1),
      }),
    )
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(input.pageIndex >= input.totalPages - 1);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(prevButton, nextButton)];
}

function buildCwlRotationShowPageLines(input: {
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ playerTag: string; playerName: string }>;
  } | null;
}): string[] {
  const lines: string[] = [
    `Season: ${input.plan.season}`,
    `Clan: ${input.plan.clanName || input.plan.clanTag}`,
    `Version: ${input.plan.version}`,
  ];
  if (input.plan.warningSummary) {
    lines.push(`Warnings: ${input.plan.warningSummary}`);
  }
  if (input.plan.excludedPlayerTags.length > 0) {
    lines.push(`Excluded: ${input.plan.excludedPlayerTags.join(", ")}`);
  }
  lines.push(`Page: ${input.pageIndex + 1} / ${input.pageCount}`);
  lines.push("");
  lines.push(`Day ${input.day.roundDay}`);
  lines.push(
    ...buildCwlRotationMemberLines({
      members: input.day.rows,
      emptyMessage: "No planned members.",
    }),
  );
  lines.push("");

  if (input.validation) {
    lines.push("Actual:");
    lines.push(
      ...buildCwlRotationMemberLines({
        members: input.validation.actualPlayerRows.map((member) => ({
          playerTag: member.playerTag,
          playerName: member.playerName,
          subbedOut: false,
        })),
        emptyMessage: input.validation.actualAvailable ? "none" : "unavailable",
      }),
    );
    lines.push(
      `Status: ${renderValidationSummary({
        missingExpectedPlayerTags: input.validation.missingExpectedPlayerTags,
        extraActualPlayerTags: input.validation.extraActualPlayerTags,
        actualAvailable: input.validation.actualAvailable,
        complete: input.validation.complete,
      })}`,
    );
  }

  return lines;
}

function buildCwlRotationShowPageEmbed(input: {
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ playerTag: string; playerName: string }>;
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
          validation: input.validation,
        }),
      ),
    )
    .setFooter({
      text: `Page ${input.pageIndex + 1}/${input.pageCount}`,
    });
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

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return new EmbedBuilder()
    .setColor(CWL_EMBED_COLOR)
    .setTitle("/cwl rotations import")
    .setDescription(buildDescription(lines));
}

async function autocompleteCwlTrackedClan(
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

  if (inWarOnly && !currentRound) {
    await interaction.editReply(`No active CWL round is persisted for ${clanTag}.`);
    return;
  }

  const entries = inWarOnly
    ? roster.filter((entry) => entry.currentRound?.inCurrentLineup)
    : roster;
  const lines = renderMembersListLines({
    season,
    clanTag,
    clanName: trackedClan.name,
    entries,
    inWarOnly,
  });
  if (currentRound) {
    lines.splice(
      2,
      0,
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
      "",
    );
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl members ${clanTag}`)
        .setDescription(buildDescription(lines)),
    ],
  });
}

async function handleRotationCreateSubcommand(interaction: ChatInputCommandInteraction) {
  const clanTag = interaction.options.getString("clan", true);
  const exclude = interaction.options.getString("exclude", false);
  const overwrite = interaction.options.getBoolean("overwrite", false) ?? false;
  const result = await cwlRotationService.createPlan({
    clanTag,
    excludeTagsRaw: exclude,
    overwrite,
  });

  if (result.outcome === "not_tracked") {
    await interaction.editReply(`No tracked CWL clan found for ${result.clanTag || clanTag}.`);
    return;
  }
  if (result.outcome === "not_preparation") {
    await interaction.editReply(
      `CWL rotations can only be created during persisted CWL preparation day for ${result.clanTag}.`,
    );
    return;
  }
  if (result.outcome === "blocked_existing") {
    await interaction.editReply(
      `An active CWL rotation plan already exists for ${result.clanTag} in ${result.season} (version ${result.existingVersion}). Re-run with overwrite:true to replace it.`,
    );
    return;
  }
  if (result.outcome === "invalid_excludes") {
    await interaction.editReply(
      `These exclude tags are not in the observed ${result.season} CWL roster for ${result.clanTag}: ${result.invalidTags.join(", ")}`,
    );
    return;
  }
  if (result.outcome === "not_enough_players") {
    await interaction.editReply(
      `Not enough CWL roster members remain after exclusions for ${result.clanTag}. Need ${result.lineupSize}, have ${result.availablePlayers}.`,
    );
    return;
  }

  const lines = [
    `Created CWL rotation plan for ${result.clanTag}.`,
    `Season: ${result.season}`,
    `Version: ${result.version}`,
    `Lineup size: ${result.lineupSize}`,
  ];
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(...result.warnings);
  }
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle(`/cwl rotations create ${result.clanTag}`)
        .setDescription(buildDescription(lines)),
    ],
  });
}

async function handleRotationShowSubcommand(interaction: ChatInputCommandInteraction) {
  const season = resolveCurrentCwlSeasonKey();
  const clanTag = normalizeClanTag(interaction.options.getString("clan", false) ?? "");
  const day = interaction.options.getInteger("day", false);

  if (!clanTag) {
    const overview = await cwlRotationService.listOverview({ season });
    const lines = [
      `Season: ${season}`,
      "",
      ...overview.map((entry) => {
        const clanLabel = entry.clanName ? `${entry.clanName} (${entry.clanTag})` : entry.clanTag;
        if (entry.status === "complete") {
          return `${clanLabel} - day ${entry.roundDay} complete`;
        }
        if (entry.status === "mismatch") {
          return `${clanLabel} - day ${entry.roundDay} mismatch - missing ${entry.missingExpectedPlayerTags.join(", ") || "none"} - extra ${entry.extraActualPlayerTags.join(", ") || "none"}`;
        }
        if (entry.status === "no_plan_day") {
          return `${clanLabel} - no planned lineup for day ${entry.roundDay}`;
        }
        return `${clanLabel} - no active CWL round`;
      }),
    ];
    if (overview.length <= 0) {
      lines.push("No active CWL rotation plans found.");
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(CWL_EMBED_COLOR)
          .setTitle("/cwl rotations show")
          .setDescription(buildDescription(lines)),
      ],
    });
    return;
  }

  const [planView] = await cwlRotationService.listActivePlanExports({
    season,
    clanTags: [clanTag],
  });
  if (!planView) {
    await interaction.editReply(`No active CWL rotation plan exists for ${clanTag} in ${season}.`);
    return;
  }

  const relevantDays = day
    ? planView.days.filter((entry) => entry.roundDay === day)
    : planView.days;
  if (day && relevantDays.length <= 0) {
    await interaction.editReply(`No planned CWL rotation day ${day} exists for ${clanTag}.`);
    return;
  }

  const renderPage = async (pageIndex: number) => {
    const dayEntry = relevantDays[pageIndex];
    if (!dayEntry) return null;
    const validation = await cwlRotationService.validatePlanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      roundDay: dayEntry.roundDay,
    });
    return buildCwlRotationShowPageEmbed({
      plan: planView,
      day: dayEntry,
      pageIndex,
      pageCount: relevantDays.length,
      validation: validation
        ? {
            actualAvailable: validation.actualAvailable,
            complete: validation.complete,
            missingExpectedPlayerTags: validation.missingExpectedPlayerTags,
            extraActualPlayerTags: validation.extraActualPlayerTags,
            actualPlayerRows: validation.actualPlayerTags.map((playerTag, index) => ({
              playerTag,
              playerName: validation.actualPlayerNames[index] ?? playerTag,
            })),
          }
        : null,
    });
  };

  const pageIndex = 0;
  const embed = await renderPage(pageIndex);
  if (!embed) {
    await interaction.editReply(`No planned CWL rotation day ${day ?? 1} exists for ${clanTag}.`);
    return;
  }

  const components =
    day || relevantDays.length <= 1
      ? []
      : buildCwlRotationShowActionRows({
          userId: interaction.user.id,
          clanTag: planView.clanTag,
          season: planView.season,
          pageIndex,
          totalPages: relevantDays.length,
        });

  await interaction.editReply({
    embeds: [embed],
    components,
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
  const pageIndex = 0;
  await interaction.editReply({
    embeds: [
      buildCwlRotationImportPreviewEmbed({
        preview,
        pageIndex,
        sessionId,
      }),
    ],
    components: buildCwlRotationImportActionRows({
      sessionId,
      pageIndex,
      hasImportableClans: preview.matchedClans.some((clan) => clan.importable),
    }),
  });
}

async function handleRotationExportSubcommand(interaction: ChatInputCommandInteraction) {
  const result = await cwlRotationSheetService.exportActivePlans();
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CWL_EMBED_COLOR)
        .setTitle("/cwl rotations export")
        .setDescription(
          buildDescription([
            `Created a new public Google Sheet with ${result.tabCount} active CWL planner tab${result.tabCount === 1 ? "" : "s"}.`,
            `Link: ${result.spreadsheetUrl}`,
          ]),
        ),
    ],
  });
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

  if (parsed.action === "page") {
    const pageIndex = Math.max(0, Math.min(6, parsed.pageIndex ?? 0));
    await interaction.update({
      embeds: [
        buildCwlRotationImportPreviewEmbed({
          preview: session.preview,
          pageIndex,
          sessionId: parsed.sessionId,
        }),
      ],
      components: buildCwlRotationImportActionRows({
        sessionId: parsed.sessionId,
        pageIndex,
        hasImportableClans: session.preview.matchedClans.some((clan) => clan.importable),
      }),
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

export async function handleCwlRotationShowButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseCwlRotationShowButtonCustomId(interaction.customId);
  if (!parsed) return;
  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the command requester can use these buttons.",
      ephemeral: true,
    });
    return;
  }

  const [planView] = await cwlRotationService.listActivePlanExports({
    season: parsed.season,
    clanTags: [parsed.clanTag],
  });
  if (!planView) {
    await interaction.reply({
      content: `No active CWL rotation plan exists for ${parsed.clanTag} in ${parsed.season}.`,
      ephemeral: true,
    });
    return;
  }

  const relevantDays = planView.days;
  const pageIndex = Math.max(0, Math.min(relevantDays.length - 1, parsed.pageIndex));
  const dayEntry = relevantDays[pageIndex];
  if (!dayEntry) {
    await interaction.reply({
      content: `No planned CWL rotation day exists for ${parsed.clanTag}.`,
      ephemeral: true,
    });
    return;
  }

  const validation = await cwlRotationService.validatePlanDay({
    clanTag: planView.clanTag,
    season: planView.season,
    roundDay: dayEntry.roundDay,
  });

  await interaction.update({
    embeds: [
      buildCwlRotationShowPageEmbed({
        plan: planView,
        day: dayEntry,
        pageIndex,
        pageCount: relevantDays.length,
        validation: validation
          ? {
              actualAvailable: validation.actualAvailable,
              complete: validation.complete,
              missingExpectedPlayerTags: validation.missingExpectedPlayerTags,
              extraActualPlayerTags: validation.extraActualPlayerTags,
              actualPlayerRows: validation.actualPlayerTags.map((playerTag, index) => ({
                playerTag,
                playerName: validation.actualPlayerNames[index] ?? playerTag,
              })),
            }
          : null,
      }),
    ],
    components: relevantDays.length > 1
      ? buildCwlRotationShowActionRows({
          userId: interaction.user.id,
          clanTag: planView.clanTag,
          season: planView.season,
          pageIndex,
          totalPages: relevantDays.length,
        })
      : [],
  });
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
          description: "Show active CWL rotation status or one clan plan, one CWL day per page",
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
              name: "exclude",
              description: "Comma-separated player tags to exclude from planning",
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
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
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
      if (group === "rotations" && subcommand === "show") {
        await handleRotationShowSubcommand(interaction);
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
    if (focused.name === "clan") {
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
