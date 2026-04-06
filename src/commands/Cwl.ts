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
import { resolveCurrentCwlSeasonKey } from "../services/CwlRegistryService";
import { cwlRotationService } from "../services/CwlRotationService";
import {
  cwlRotationSheetService,
  rebuildCwlRotationImportTabState,
  type CwlRotationSheetImportConfirmResult,
  type CwlRotationSheetImportPreview,
  type CwlRotationImportRow,
} from "../services/CwlRotationSheetService";
import { cwlStateService } from "../services/CwlStateService";
import { normalizeClanTag, normalizePlayerTag } from "../services/PlayerLinkService";

const CWL_EMBED_COLOR = 0xfee75c;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const CWL_ROTATION_IMPORT_SESSION_TTL_MS = 15 * 60 * 1000;
const CWL_ROTATION_IMPORT_SESSION_PREFIX = "cwl-rot-import";
const CWL_ROTATION_SHOW_SESSION_PREFIX = "cwl-rot-show";
const CWL_ROTATION_SHOW_DAY_CHOICES = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  name: `Day ${day}`,
  value: day,
}));
type CwlRotationPlanExport = Awaited<ReturnType<typeof cwlRotationService.listActivePlanExports>>[number];

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

function buildCwlRotationMergedRosterLines(input: {
  warCountByPlayerTag: Map<string, number>;
  plannedMembers: Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
  }>;
  actualPlayerRows: Array<{
    playerTag: string;
    playerName: string;
  }>;
  actualAvailable: boolean;
}): string[] {
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
    return [
      "Actual lineup unavailable",
      ...plannedBenchMembers.map(
        (member) => `:x: ${member.playerName} (${member.playerTag}) | War count: ${member.warCount}`,
      ),
    ];
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
  let missingExpectedIndex = 0;
  for (const actual of actualRows) {
    if (actual.normalizedTag && expectedByTag.has(actual.normalizedTag)) {
      lines.push(`:white_check_mark: ${actual.playerName} (${actual.playerTag}) | War count: ${actual.warCount}`);
      continue;
    }

    const expected = missingExpectedRows[missingExpectedIndex] ?? null;
    if (expected) {
      missingExpectedIndex += 1;
      lines.push(
        `:warning: ${actual.playerName} (${actual.playerTag}) | War count: ${actual.warCount} - Expected ${expected.playerName} (${expected.playerTag})`,
      );
      continue;
    }

    lines.push(`:warning: ${actual.playerName} (${actual.playerTag}) | War count: ${actual.warCount}`);
  }

  lines.push(
    ...missingExpectedRows.map((member) => {
      const expectedWarCount = getCwlRotationWarCount({
        playerTag: member.playerTag,
        warCountByPlayerTag: input.warCountByPlayerTag,
      });
      return `:x: ${member.playerName} (${member.playerTag}) | War count: ${expectedWarCount}`;
    }),
  );

  lines.push(
    ...plannedBenchMembers.map(
      (member) => `:x: ${member.playerName} (${member.playerTag}) | War count: ${member.warCount}`,
    ),
  );

  if (lines.length <= 0) {
    lines.push("No actual lineup members.");
  }

  return lines;
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
  battleDayStartAt: Date | null;
  warCountByPlayerTag: Map<string, number>;
  validation: {
    actualAvailable: boolean;
    complete: boolean;
    missingExpectedPlayerTags: string[];
    extraActualPlayerTags: string[];
    actualPlayerRows: Array<{ playerTag: string; playerName: string }>;
  } | null;
}): string[] {
  const visibleDayRows = cwlRotationService.getVisibleRotationShowDayRows({
    excludedPlayerTags: input.plan.excludedPlayerTags,
    days: input.plan.days,
    day: input.day,
  });
  const lines: string[] = [
    `Season: ${input.plan.season}`,
    `Clan: ${input.plan.clanName || input.plan.clanTag}`,
    `Version: ${input.plan.version}`,
  ];
  lines.push(`Battle day start: ${formatRelativeTimestamp(input.battleDayStartAt)}`);
  if (input.plan.excludedPlayerTags.length > 0) {
    lines.push(`Excluded: ${input.plan.excludedPlayerTags.join(", ")}`);
  }
  lines.push(`Page: ${input.pageIndex + 1} / ${input.pageCount}`);
  lines.push("");
  lines.push(`Day ${input.day.roundDay}`);
  lines.push("");
  if (!input.validation || !input.validation.actualAvailable) {
    lines.push("Actual lineup unavailable");
    lines.push(
      ...buildCwlRotationMergedRosterLines({
        warCountByPlayerTag: input.warCountByPlayerTag,
        plannedMembers: visibleDayRows,
        actualPlayerRows: [],
        actualAvailable: false,
      }).slice(1),
    );
  } else {
    lines.push(
      ...buildCwlRotationMergedRosterLines({
        warCountByPlayerTag: input.warCountByPlayerTag,
        plannedMembers: visibleDayRows,
        actualPlayerRows: input.validation.actualPlayerRows,
        actualAvailable: input.validation.actualAvailable,
      }),
    );
  }

  return lines;
}

function buildCwlRotationShowPageEmbed(input: {
  plan: CwlRotationPlanExport;
  day: CwlRotationPlanExport["days"][number];
  pageIndex: number;
  pageCount: number;
  battleDayStartAt: Date | null;
  warCountByPlayerTag: Map<string, number>;
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
            battleDayStartAt: input.battleDayStartAt,
            warCountByPlayerTag: input.warCountByPlayerTag,
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
    const battleDayStartAt = await cwlStateService.getBattleDayStartForClanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      roundDay: dayEntry.roundDay,
    });
    const warCountByPlayerTag = await cwlStateService.getParticipationCountsForClanDay({
      clanTag: planView.clanTag,
      season: planView.season,
      throughRoundDay: dayEntry.roundDay,
    });
    return buildCwlRotationShowPageEmbed({
      plan: planView,
      day: dayEntry,
      pageIndex,
      pageCount: relevantDays.length,
      battleDayStartAt,
      warCountByPlayerTag,
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

  const preferredDay = day
    ? day
    : await cwlRotationService.getPreferredDisplayDay({
        clanTag: planView.clanTag,
        season: planView.season,
      });
  const pageIndex = Math.max(
    0,
    preferredDay
      ? relevantDays.findIndex((entry) => entry.roundDay === preferredDay)
      : 0,
  );
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
  const session = getCwlRotationImportSession(sessionId, interaction.user.id);
  if (!session) {
    await interaction.editReply("Failed to create the CWL rotation import preview.");
    return;
  }
  const rendered = buildCwlRotationImportSessionMessage(sessionId, session);
  await interaction.editReply(rendered);
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
  const battleDayStartAt = await cwlStateService.getBattleDayStartForClanDay({
    clanTag: planView.clanTag,
    season: planView.season,
    roundDay: dayEntry.roundDay,
  });
  const warCountByPlayerTag = await cwlStateService.getParticipationCountsForClanDay({
    clanTag: planView.clanTag,
    season: planView.season,
    throughRoundDay: dayEntry.roundDay,
  });

  await interaction.update({
    embeds: [
      buildCwlRotationShowPageEmbed({
        plan: planView,
        day: dayEntry,
        pageIndex,
        pageCount: relevantDays.length,
        battleDayStartAt,
        warCountByPlayerTag,
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
    if (focused.name === "day") {
      await autocompleteCwlRotationShowDay(interaction);
      return;
    }
    if (focused.name === "clan") {
      await autocompleteCwlTrackedClan(interaction);
      return;
    }
    await interaction.respond([]);
  },
};
