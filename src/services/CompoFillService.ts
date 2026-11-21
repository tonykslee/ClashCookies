import type { HeatMapRef } from "@prisma/client";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { formatClanBadgeEmoji } from "../helper/clanBadgeEmoji";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { formatError } from "../helper/formatError";
import { type CompoWarBucketCounts } from "../helper/compoWarBucketCounts";
import { getCompoWarWeightBucket } from "../helper/compoWarWeightBuckets";
import {
  getCompoActualStateTargetBucketCounts,
  projectCompoActualStateView,
} from "../helper/compoActualStateView";
import type { CompoActualStateContext } from "./CompoActualStateService";
import {
  listFillerAccountsForGuild,
  type FillerAccountViewRow,
} from "./FillerAccountService";
import { CoCService } from "./CoCService";
import {
  buildCompoFillPlan,
  type CompoFillAvailableFiller,
  type CompoFillPlanResult,
  type CompoFillTrackedClanState,
  type CompoFillDestinationPlan,
  type CompoFillRemainingSlot,
  type CompoFillPlannedMove,
} from "./CompoFillPlanner";
import { loadCompoActualStateContext } from "./CompoActualStateService";
import { prisma } from "../prisma";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import { playerCurrentService } from "./PlayerCurrentService";

type FillEmbedField = {
  name: string;
  value: string;
  inline: false;
};

type FillSectionSource = {
  sectionName: string;
  lines: string[];
};

type FillClanHeaderContext = {
  clanTag: string;
  clanName: string;
  currentMemberCount: number;
  clanBadge: string | null;
};

export type CompoFillReadResult = {
  content: string;
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder>>;
  trackedClanTags: string[];
  destinationClanCount: number;
  plannedMoveCount: number;
  availableFillerCount: number;
  pageIndex: number;
  pageCount: number;
};

export type CompoFillRefreshResult = CompoFillReadResult & {
  warningText: string | null;
  failedTrackedClanTags: string[];
  failedFillerTags: string[];
};

const FILL_EMBED_TITLE = "Compo Fill Planner";
const FILL_PAGE_DESCRIPTION_LIMIT = 4096;
const FILL_PAGE_FIELD_LIMIT = 25;
const FILL_TOTAL_EMBED_TEXT_BUDGET = 5500;
const FILL_PAGE_RENDER_BUDGET = FILL_TOTAL_EMBED_TEXT_BUDGET - 100;
const FILL_REFRESH_LABEL = "Refresh Data";
const FILL_REFRESH_LOADING_LABEL = "Refreshing...";
const COMPO_FILL_PAGE_PREFIX = "compo-fill-page";

type FillStageDetail = Record<string, string | number | boolean | null | undefined>;

function logFillStage(stage: string, detail: FillStageDetail = {}): void {
  const serialized = Object.entries({ stage, ...detail })
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join(" ");
  console.log(`[compo-fill] ${serialized}`);
}

async function measureFillStage<T>(input: {
  stage: string;
  startDetail?: FillStageDetail;
  work: () => Promise<T>;
  completeDetail?: (result: T, durationMs: number) => FillStageDetail;
  errorDetail?: (error: unknown, durationMs: number) => FillStageDetail;
}): Promise<T> {
  logFillStage(`${input.stage}_start`, input.startDetail ?? {});
  const startedAt = Date.now();
  try {
    const result = await input.work();
    const durationMs = Math.max(0, Date.now() - startedAt);
    logFillStage(`${input.stage}_complete`, {
      duration_ms: durationMs,
      ...(input.completeDetail ? input.completeDetail(result, durationMs) : {}),
    });
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAt);
    logFillStage(`${input.stage}_error`, {
      duration_ms: durationMs,
      error: formatError(error),
      ...(input.errorDetail ? input.errorDetail(error, durationMs) : {}),
    });
    throw error;
  }
}

function truncateForDiscord(text: string, maxLength: number): string {
  const suffix = "...";
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

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function formatClanName(value: string): string {
  return normalizeCompoClanDisplayName(value).trim() || value.trim();
}

function normalizeLinkTag(tag: string): string {
  return String(tag ?? "").trim().replace(/^#+/, "");
}

function formatDiscordMarkdownLink(label: string, url: string): string {
  return `[${label}](<${url}>)`;
}

function buildInGamePlayerProfileUrl(playerTag: string): string {
  return `https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${encodeURIComponent(
    normalizeLinkTag(playerTag),
  )}`;
}

function buildInGameClanProfileUrl(clanTag: string): string {
  return `https://link.clashofclans.com/en/?action=OpenClanProfile&tag=${encodeURIComponent(
    normalizeLinkTag(clanTag),
  )}`;
}

function formatShortWeight(weight: number): string {
  if (!Number.isFinite(weight) || weight <= 0) {
    return "0";
  }
  if (weight < 1000) {
    return `${Math.trunc(weight)}`;
  }
  return `${Math.round(weight / 1000)}k`;
}

function formatRecommendedMovesClanHeader(input: FillClanHeaderContext): string {
  const clanTag = String(input.clanTag ?? "").trim();
  const clanName = formatClanName(String(input.clanName ?? "").trim());
  const headerLabel = clanName || clanTag || "Unknown Clan";
  const badge = formatClanBadgeEmoji(input.clanBadge);
  const badgePrefix = badge ? `${badge} ` : "";
  return `**${badgePrefix}${formatDiscordMarkdownLink(
    headerLabel,
    buildInGameClanProfileUrl(clanTag),
  )} \`${clanTag || "?"}\` ${Math.trunc(input.currentMemberCount)}/50**`;
}

function formatSlotHeader(slot: CompoFillRemainingSlot): string {
  const clanName = formatClanName(String(slot.clanName ?? "").trim());
  const clanTag = String(slot.clanTag ?? "").trim();
  const headerLabel = clanName || clanTag || "Unknown Clan";
  return `${formatDiscordMarkdownLink(headerLabel, buildInGameClanProfileUrl(clanTag))} \`${clanTag || "?"}\` ${slot.currentMemberCount}/50`;
}

function formatSourceLabel(sourceClanTag: string | null, sourceClanName: string | null): string {
  const clanTag = String(sourceClanTag ?? "").trim();
  if (!clanTag) {
    return "outside tracked clans";
  }
  const clanName = formatClanName(String(sourceClanName ?? "").trim());
  const label = clanName || clanTag;
  return `${formatDiscordMarkdownLink(label, buildInGameClanProfileUrl(clanTag))}`;
}

function formatFillerLabel(input: {
  playerTag: string;
  playerName: string;
  discordUserId?: string | null;
}): string {
  const playerTag = String(input.playerTag ?? "").trim();
  const displayTag = playerTag.startsWith("#") ? playerTag : `#${playerTag}`;
  const playerLink = formatDiscordMarkdownLink(
    input.playerName,
    buildInGamePlayerProfileUrl(playerTag),
  );
  const userMention = String(input.discordUserId ?? "").trim()
    ? `<@${String(input.discordUserId).trim()}>`
    : "—";
  return `${userMention} | ${playerLink} (\`${displayTag}\`)`;
}

function formatMoveLine(input: {
  move: CompoFillPlannedMove;
  linkedDiscordUserId: string | null;
}): string {
  const sourceLabel = formatSourceLabel(input.move.sourceClanTag, input.move.sourceClanName);
  return [
    formatFillerLabel({
      playerTag: input.move.filler.playerTag,
      playerName: input.move.filler.playerName,
      discordUserId: input.linkedDiscordUserId,
    }),
    formatShortWeight(input.move.filler.resolvedWeight),
    `⚜️ ${sourceLabel}`,
  ].join(" | ");
}

function buildSectionFields(input: {
  sectionName: string;
  lines: string[];
}): FillEmbedField[] {
  const formattedLines = input.lines.length > 0 ? input.lines : ["None"];
  const chunks = chunkFormattedLines(
    formattedLines.map((line) => truncateForDiscord(line, 1024)),
    1024,
  );

  return chunks.map((chunk, index) => ({
    name: truncateForDiscord(
      chunks.length > 1 ? `${input.sectionName} (${index + 1}/${chunks.length})` : input.sectionName,
      256,
    ),
    value: truncateForDiscord(chunk || " ", 1024),
    inline: false,
  }));
}

function estimateFillEmbedTextLength(input: {
  title?: string | null;
  description?: string | null;
  fields?: readonly FillEmbedField[] | null;
  footerText?: string | null;
  footer?: { text?: string | null } | null;
}): number {
  return (
    (input.title?.length ?? 0) +
    (input.description?.length ?? 0) +
    (input.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0) +
    (input.footerText?.length ?? 0) +
    (input.footer?.text?.length ?? 0)
  );
}

function buildFillerSummaryField(input: {
  unusedAvailableFillers: number;
  unavailableFillers: number;
  excludedFillers: number;
}): FillEmbedField | null {
  const lines: string[] = [];
  if (input.unusedAvailableFillers > 0) {
    lines.push(`Unused Available Fillers: ${input.unusedAvailableFillers}`);
  }
  if (input.unavailableFillers > 0) {
    lines.push(`Unavailable Fillers: ${input.unavailableFillers}`);
  }
  if (input.excludedFillers > 0) {
    lines.push(`Excluded / Missing Weight: ${input.excludedFillers}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    name: "Filler Summary",
    value: lines.join("\n"),
    inline: false,
  };
}

function buildFillSectionSources(input: {
  result: CompoFillPlanResult;
  fillerAccountsByTag: Map<string, FillerAccountViewRow>;
  clanHeadersByTag: Map<string, FillClanHeaderContext>;
}): FillSectionSource[] {
  const sections: FillSectionSource[] = [];

  for (const plan of input.result.destinationPlans) {
    if (plan.plannedMoves.length === 0) {
      continue;
    }
    const headerContext =
      input.clanHeadersByTag.get(normalizeLinkTag(String(plan.clanTag ?? ""))) ??
      input.clanHeadersByTag.get(String(plan.clanTag ?? "").trim()) ??
      {
        clanTag: plan.clanTag,
        clanName: plan.clanName,
        currentMemberCount: plan.initialMemberCount,
        clanBadge: null,
      };
    const lines = plan.plannedMoves.map((move) =>
      formatMoveLine({
        move,
        linkedDiscordUserId:
          input.fillerAccountsByTag.get(
            normalizeLinkTag(String(move.filler.playerTag ?? "")),
          )?.discordUserId ?? null,
      }),
    );
    sections.push({
      sectionName: "Recommended Moves",
      lines: [formatRecommendedMovesClanHeader(headerContext), ...lines],
    });
  }

  if (input.result.remainingUnfilledClanSlots.length > 0) {
    sections.push({
      sectionName: "Remaining Open Slots",
      lines: input.result.remainingUnfilledClanSlots.map(
        (slot) =>
          `${formatSlotHeader(slot)} | ${slot.remainingSlots} open slot${slot.remainingSlots === 1 ? "" : "s"} | ${slot.currentMemberCount}/${slot.targetMemberCount}`,
      ),
    });
  }

  const summaryField = buildFillerSummaryField({
    unusedAvailableFillers: input.result.unusedAvailableFillers.length,
    unavailableFillers: input.result.unavailableFillers.length,
    excludedFillers: input.result.excludedFillers.length,
  });
  if (summaryField) {
    sections.push({
      sectionName: summaryField.name,
      lines: summaryField.value.split("\n"),
    });
  }

  return sections;
}

function splitFillSectionIntoPageChunks(input: {
  sectionName: string;
  lines: string[];
  description: string;
}): string[][] {
  if (input.lines.length === 0) {
    return [];
  }

  const chunks: string[][] = [];
  let current: string[] = [];

  for (const line of input.lines) {
    const candidateLines = [...current, line];
    const candidateFields = buildSectionFields({
      sectionName: input.sectionName,
      lines: candidateLines,
    });
    const candidateLength = estimateFillEmbedTextLength({
      title: FILL_EMBED_TITLE,
      description: input.description,
      fields: candidateFields,
      footerText: "Page 999/999",
    });
    if (
      candidateLength <= FILL_PAGE_RENDER_BUDGET &&
      candidateFields.length <= FILL_PAGE_FIELD_LIMIT
    ) {
      current = candidateLines;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    current = [line];
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildFillPageEmbeds(input: {
  summaryDescription: string;
  sections: FillSectionSource[];
}): {
  pages: Array<{ fields: FillEmbedField[] }>;
  description: string;
} {
  const description = truncateForDiscord(
    input.summaryDescription,
    FILL_PAGE_DESCRIPTION_LIMIT,
  );

  const sectionChunks: Array<{
    sectionName: string;
    lines: string[];
  }> = [];

  for (const section of input.sections) {
    const chunks = splitFillSectionIntoPageChunks({
      sectionName: section.sectionName,
      lines: section.lines,
      description,
    });
    if (chunks.length === 0) {
      continue;
    }
    for (const lines of chunks) {
      sectionChunks.push({
        sectionName: section.sectionName,
        lines,
      });
    }
  }

  const pages: Array<{ fields: FillEmbedField[] }> = [];
  let currentFields: FillEmbedField[] = [];

  for (const chunk of sectionChunks) {
    const chunkFields = buildSectionFields({
      sectionName: chunk.sectionName,
      lines: chunk.lines,
    });
    const candidateFields = [...currentFields, ...chunkFields];
    const candidateLength = estimateFillEmbedTextLength({
      title: FILL_EMBED_TITLE,
      description,
      fields: candidateFields,
      footerText: "Page 999/999",
    });
    if (
      candidateLength <= FILL_PAGE_RENDER_BUDGET &&
      candidateFields.length <= FILL_PAGE_FIELD_LIMIT
    ) {
      currentFields = candidateFields;
      continue;
    }

    if (currentFields.length > 0) {
      pages.push({ fields: currentFields });
    }
    currentFields = chunkFields;
  }

  if (currentFields.length > 0 || pages.length === 0) {
    pages.push({ fields: currentFields });
  }

  return {
    pages,
    description,
  };
}

export function buildCompoFillPageCustomId(input: {
  userId: string;
  pageIndex: number;
}): string {
  return `${COMPO_FILL_PAGE_PREFIX}:${input.userId}:${Math.trunc(input.pageIndex)}`;
}

export function parseCompoFillPageCustomId(
  customId: string,
): { userId: string; pageIndex: number } | null {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== COMPO_FILL_PAGE_PREFIX || parts.length !== 3) {
    return null;
  }
  const userId = parts[1];
  const pageIndex = Number(parts[2]);
  if (!userId || !Number.isFinite(pageIndex)) {
    return null;
  }
  return {
    userId,
    pageIndex: Math.trunc(pageIndex),
  };
}

export function isCompoFillPageButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${COMPO_FILL_PAGE_PREFIX}:`);
}

function cloneBucketCounts(counts: CompoWarBucketCounts): CompoWarBucketCounts {
  return {
    ...counts,
  };
}

function sumBucketCounts(counts: CompoWarBucketCounts): number {
  return Object.values(counts).reduce((sum, count) => {
    return sum + (Number.isFinite(count) && count >= 0 ? count : 0);
  }, 0);
}

function assessActualRosterEvidence(input: {
  clan: CompoActualStateContext["clans"][number];
}): "complete" | "actual_roster_incomplete" | "actual_roster_inconsistent" {
  const { base, members } = input.clan;
  const memberCount = base.memberCount;
  const bucketCountTotal = sumBucketCounts(base.bucketCounts);
  const memberTags = members.map((member) => String(member.playerTag ?? "").trim().toUpperCase());
  const hasDuplicateOrMissingMemberTags =
    memberTags.some((tag) => !tag) || new Set(memberTags).size !== memberTags.length;
  const memberCountIsCoherent =
    Number.isInteger(memberCount) &&
    memberCount >= 0 &&
    members.length === memberCount &&
    bucketCountTotal === memberCount &&
    !hasDuplicateOrMissingMemberTags;
  const bucketCountsMatchMembers = members.reduce<CompoWarBucketCounts | null>(
    (counts, member) => {
      const bucket = getCompoWarWeightBucket(member.resolvedWeight);
      if (
        !counts ||
        !bucket ||
        member.resolvedBucket !== bucket ||
        member.resolvedWeightSource === null ||
        // PlayerCurrent and war fallbacks are lower-confidence evidence; do not
        // let a valid-looking bucket derived from either source authorize fills.
        member.resolvedWeightSource === "current" ||
        member.resolvedWeightSource === "war"
      ) {
        return null;
      }
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      return counts;
    }, {
      TH18: 0,
      TH17: 0,
      TH16: 0,
      TH15: 0,
      TH14: 0,
      TH13: 0,
      TH12: 0,
      TH11: 0,
      TH10: 0,
      TH9: 0,
      TH8_OR_LOWER: 0,
    },
  );

  if (!memberCountIsCoherent) {
    return members.length < memberCount || base.unresolvedWeightCount > 0
      ? "actual_roster_incomplete"
      : "actual_roster_inconsistent";
  }
  if (
    base.unresolvedWeightCount > 0 ||
    !bucketCountsMatchMembers ||
    Object.entries(base.bucketCounts).some(([bucket, count]) => {
      return count !== (bucketCountsMatchMembers[bucket as keyof CompoWarBucketCounts] ?? 0);
    })
  ) {
    return "actual_roster_incomplete";
  }
  return "complete";
}

function buildTrackedClanState(input: {
  clan: CompoActualStateContext["clans"][number];
  heatMapRefs: readonly HeatMapRef[];
  referenceValidated?: boolean;
}): CompoFillTrackedClanState {
  const projection = projectCompoActualStateView({
    view: "auto",
    base: input.clan.base,
    heatMapRefs: input.heatMapRefs,
  });
  const hasUnsupportedTh19 = (input.clan.base.bucketCounts.TH19 ?? 0) > 0;
  const referenceValidated = input.referenceValidated === true;
  const actualRosterEvidence = assessActualRosterEvidence({ clan: input.clan });
  const hasValidatedTarget =
    referenceValidated &&
    !hasUnsupportedTh19 &&
    actualRosterEvidence === "complete" &&
    projection.selectedHeatMapRef !== null;
  const targetEvidenceReason = hasValidatedTarget
    ? undefined
    : !referenceValidated
      ? "reference_unavailable"
      : hasUnsupportedTh19
        ? "th19_integrity"
        : actualRosterEvidence !== "complete"
          ? actualRosterEvidence
          : "no_selected_reference";

  return {
    clanTag: input.clan.clanTag,
    clanName: input.clan.clanName,
    shortName: input.clan.shortName,
    memberCount: input.clan.base.memberCount,
    currentBucketCounts: cloneBucketCounts(input.clan.base.bucketCounts),
    targetBucketCounts: hasValidatedTarget
      ? getCompoActualStateTargetBucketCounts(projection.selectedHeatMapRef)
      : null,
    targetEvidence: hasValidatedTarget ? "validated" : "unavailable",
    targetEvidenceReason,
    targetSupportsTh19: false,
    memberEvidence: input.clan.members.map((member) => ({
      playerTag: member.playerTag,
      resolvedWeight: member.resolvedWeight,
      resolvedWeightBucket: member.resolvedBucket,
    })),
  };
}

function buildFillerCandidate(row: FillerAccountViewRow): {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
} {
  return {
    playerTag: row.tag,
    playerName: row.name,
    resolvedWeight: row.weight,
    currentClanTag: row.clanTag,
    currentClanName: row.clanName,
    clanState: row.clanState,
  };
}

function buildSummaryDescription(input: {
  destinationPlans: CompoFillDestinationPlan[];
  remainingUnfilledClanSlots: CompoFillRemainingSlot[];
  unusedAvailableFillers: CompoFillAvailableFiller[];
  plannedMoveCount: number;
  underfilledClanCount: number;
  unsupportedTh19ClanNames?: readonly string[];
  unknownTargetClanNames?: readonly string[];
  referenceAvailabilityWarning?: string | null;
}): string {
  const totalOpenSlots = input.remainingUnfilledClanSlots.reduce(
    (sum, slot) => sum + slot.remainingSlots,
    0,
  );
  const availableFillerCount =
    input.plannedMoveCount + input.unusedAvailableFillers.length;
  return [
    `Clans under 50: ${input.underfilledClanCount}`,
    `Open slots: ${totalOpenSlots}`,
    `Available fillers: ${availableFillerCount}`,
    `Recommended moves: ${input.plannedMoveCount}`,
    ...(input.referenceAvailabilityWarning
      ? [`Reference integrity: ${input.referenceAvailabilityWarning}`]
      : []),
    ...(input.unknownTargetClanNames && input.unknownTargetClanNames.length > 0
      ? [
          `Target comparison: UNKNOWN for ${input.unknownTargetClanNames.join(", ")}; no target-dependent moves are planned for those clans.`,
        ]
      : []),
    ...(input.unsupportedTh19ClanNames && input.unsupportedTh19ClanNames.length > 0
      ? [
          `TH19 target comparison: UNKNOWN for ${input.unsupportedTh19ClanNames.join(", ")}; no fill moves are planned for those clans.`,
        ]
      : []),
  ].join(" | ");
}

function buildFillRefreshComponents(input: {
  userId?: string | null;
  pageIndex?: number;
  pageCount?: number;
  loading?: boolean;
}): Array<ActionRowBuilder<ButtonBuilder>> {
  const userId = String(input.userId ?? "").trim();
  if (!userId) {
    return [];
  }
  const loading = input.loading ?? false;
  const pageCount = Math.max(1, Math.trunc(input.pageCount ?? 1));
  const pageIndex = Math.min(
    pageCount - 1,
    Math.max(0, Math.trunc(input.pageIndex ?? 0)),
  );
  const buttons: ButtonBuilder[] = [];
  if (pageCount > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(
          buildCompoFillPageCustomId({
            userId,
            pageIndex: Math.max(0, pageIndex - 1),
          }),
        )
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(loading || pageIndex <= 0),
      new ButtonBuilder()
        .setCustomId(
          buildCompoFillPageCustomId({
            userId,
            pageIndex: Math.min(pageCount - 1, pageIndex + 1),
          }),
        )
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(loading || pageIndex >= pageCount - 1),
    );
  }
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...buttons,
      new ButtonBuilder()
        .setCustomId(`compo-refresh:fill:${userId}`)
        .setLabel(loading ? FILL_REFRESH_LOADING_LABEL : FILL_REFRESH_LABEL)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(loading),
    ),
  ];
}

function buildCompoFillRefreshWarning(input: {
  failedTrackedClanTags: string[];
  failedFillerTags: string[];
}): string | null {
  const trackedClanCount = input.failedTrackedClanTags.length;
  const fillerCount = input.failedFillerTags.length;
  if (trackedClanCount <= 0 && fillerCount <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (trackedClanCount > 0) {
    parts.push(
      `${trackedClanCount} tracked clan${trackedClanCount === 1 ? "" : "s"}`,
    );
  }
  if (fillerCount > 0) {
    parts.push(`${fillerCount} filler${fillerCount === 1 ? "" : "s"}`);
  }

  return `Refresh warning: ${parts.join(" and ")} failed to update.`;
}

/** Purpose: read and render DB-backed compo fill recommendations without any live CoC API calls. */
export class CompoFillService {
  async readFill(
    guildId?: string | null,
    options?: { userId?: string | null; pageIndex?: number | null },
  ): Promise<CompoFillReadResult> {
    const userId = options?.userId ?? null;
    const guild = guildId ?? null;
    const context = await measureFillStage({
      stage: "load_context",
      startDetail: {
        guildId: guild ?? "DM",
      },
      work: () => loadCompoActualStateContext(guild),
      completeDetail: (loadedContext) => ({
        trackedClanTags: loadedContext.trackedClanTags.length,
        contextClans: loadedContext.clans.length,
        heatMapRefs: loadedContext.heatMapRefs.length,
      }),
    });

    if (context.trackedClanTags.length === 0) {
      const emptyRender = await measureFillStage({
        stage: "build_render",
        startDetail: {
          trackedClanTags: 0,
          contextClans: context.clans.length,
          heatMapRefs: context.heatMapRefs.length,
          fillerRows: 0,
          destinationPlans: 0,
          plannedMoveCount: 0,
        },
        work: async () => ({
          content: "No tracked FWA clans are configured for DB-backed compo fill recommendations.",
          embeds: [] as EmbedBuilder[],
          components: buildFillRefreshComponents({ userId }),
        }),
        completeDetail: (render) => ({
          trackedClanTags: 0,
          contextClans: context.clans.length,
          heatMapRefs: context.heatMapRefs.length,
          fillerRows: 0,
          destinationPlans: 0,
          plannedMoveCount: 0,
          embedCount: render.embeds.length,
          pageCount: 1,
        }),
      });
      return {
        content: emptyRender.content,
        embeds: emptyRender.embeds,
        components: emptyRender.components,
        trackedClanTags: [],
        destinationClanCount: 0,
        plannedMoveCount: 0,
        availableFillerCount: 0,
        pageIndex: 0,
        pageCount: 1,
      };
    }

    const fillers = await measureFillStage({
      stage: "list_fillers",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
      },
      work: async () =>
        guild && guild.trim().length > 0
          ? listFillerAccountsForGuild({ guildId: guild })
          : [],
      completeDetail: (fillerRows) => ({
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillerRows.length,
      }),
    });

    const referenceValidated = context.referenceAvailability?.status === "validated";
    const trackedClans = await measureFillStage({
      stage: "build_tracked_clans",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
      },
      work: async () =>
        context.clans.map((clan) =>
          buildTrackedClanState({
            clan,
            heatMapRefs: context.heatMapRefs,
            referenceValidated,
          }),
        ),
      completeDetail: (plannedClans) => ({
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        trackedClans: plannedClans.length,
      }),
    });

    const clanHeaderRows = await measureFillStage({
      stage: "load_clan_badges",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        trackedClans: trackedClans.length,
      },
      work: async () =>
        context.trackedClanTags.length > 0
          ? prisma.trackedClan.findMany({
              where: {
                tag: {
                  in: context.trackedClanTags,
                },
              },
              select: {
                tag: true,
                clanBadge: true,
              },
            })
          : [],
      completeDetail: (rows) => ({
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        trackedClans: trackedClans.length,
        badgeRows: rows.length,
      }),
    });
    const clanHeadersByTag = new Map<string, FillClanHeaderContext>();
    for (const clan of trackedClans) {
      clanHeadersByTag.set(normalizeLinkTag(clan.clanTag), {
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        currentMemberCount: clan.memberCount,
        clanBadge: null,
      });
    }
    for (const row of clanHeaderRows as Array<{ tag: string; clanBadge: string | null }>) {
      const clanTag = normalizeLinkTag(String(row.tag ?? ""));
      if (!clanTag) continue;
      const current = clanHeadersByTag.get(clanTag);
      if (current) {
        current.clanBadge = formatClanBadgeEmoji(row.clanBadge);
      }
    }

    const result = await measureFillStage({
      stage: "build_plan",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        trackedClans: trackedClans.length,
      },
      work: async () =>
        buildCompoFillPlan({
          trackedClans,
          trackedClanTags: context.trackedClanTags,
          fillers: fillers.map(buildFillerCandidate),
        }),
      completeDetail: (planResult) => {
        const plannedMoveCount = planResult.destinationPlans.reduce(
          (sum, plan) => sum + plan.plannedMoves.length,
          0,
        );
        return {
          trackedClanTags: context.trackedClanTags.length,
          contextClans: context.clans.length,
          heatMapRefs: context.heatMapRefs.length,
          fillerRows: fillers.length,
          destinationPlans: planResult.destinationPlans.length,
          plannedMoveCount,
        };
      },
    });

    const renderResult = referenceValidated
      ? result
      : {
          ...result,
          remainingUnfilledClanSlots: context.clans
            .filter((clan) => clan.base.memberCount < 50)
            .map((clan) => ({
              clanTag: clan.clanTag,
              clanName: clan.clanName,
              shortName: clan.shortName,
              remainingSlots: Math.max(0, 50 - clan.base.memberCount),
              currentMemberCount: clan.base.memberCount,
              targetMemberCount: 50,
            })),
        };

    const plannedMoveCount = renderResult.destinationPlans.reduce(
      (sum, plan) => sum + plan.plannedMoves.length,
      0,
    );
    const availableFillerCount =
      plannedMoveCount + renderResult.unusedAvailableFillers.length;

    const render = await measureFillStage({
      stage: "build_render",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        destinationPlans: renderResult.destinationPlans.length,
        plannedMoveCount,
      },
      work: async () => {
        const underfilledClanCount = context.clans.filter(
          (clan) => Number.isFinite(clan.base.memberCount) && clan.base.memberCount < 50,
        ).length;
        const summaryDescription = buildSummaryDescription({
          destinationPlans: renderResult.destinationPlans,
          remainingUnfilledClanSlots: renderResult.remainingUnfilledClanSlots,
          unusedAvailableFillers: renderResult.unusedAvailableFillers,
          plannedMoveCount,
          underfilledClanCount,
          referenceAvailabilityWarning: referenceValidated
            ? null
            : context.referenceAvailability?.warning ??
              "Reference validation is unavailable; no target-dependent fill moves are planned.",
          unknownTargetClanNames: trackedClans
            .filter(
              (clan) =>
                clan.targetEvidenceReason === "no_selected_reference" ||
                clan.targetEvidenceReason === "actual_roster_incomplete" ||
                clan.targetEvidenceReason === "actual_roster_inconsistent",
            )
            .map((clan) => clan.clanName),
          unsupportedTh19ClanNames: context.clans
            .filter((clan) => (clan.base.bucketCounts.TH19 ?? 0) > 0)
            .map((clan) => clan.clanName),
        });
        const sectionSources = buildFillSectionSources({
          result: renderResult,
          fillerAccountsByTag: new Map(
            fillers.map((filler) => [
              normalizeLinkTag(String(filler.tag ?? "")),
              filler,
            ] as const),
          ),
          clanHeadersByTag,
        });
        const pages = buildFillPageEmbeds({
          summaryDescription,
          sections: sectionSources,
        });
        const requestedPageIndex = Math.max(
          0,
          Math.trunc(options?.pageIndex ?? 0),
        );
        const pageIndex = Math.min(
          pages.pages.length - 1,
          requestedPageIndex,
        );
        const embedPage = pages.pages[pageIndex] ?? { fields: [] };
        const embed = new EmbedBuilder()
          .setTitle(truncateForDiscord(FILL_EMBED_TITLE, 256))
          .setColor(0x57f287)
          .setDescription(pages.description)
          .setFooter({
            text: `Page ${pageIndex + 1}/${Math.max(1, pages.pages.length)}`,
          });
        for (const field of embedPage.fields.slice(0, FILL_PAGE_FIELD_LIMIT)) {
          embed.addFields(field);
        }
        const embeds = [embed];
        const components = buildFillRefreshComponents({
          userId,
          pageIndex,
          pageCount: pages.pages.length,
        });
        return {
          content: "",
          embeds,
          components,
          pageIndex,
          pageCount: pages.pages.length,
        };
      },
      completeDetail: (rendered) => ({
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        destinationPlans: renderResult.destinationPlans.length,
        plannedMoveCount,
        embedCount: rendered.embeds.length,
        componentRows: rendered.components.length,
        pageCount: rendered.pageCount,
      }),
    });

    return {
      content: render.content,
      embeds: render.embeds,
      components: render.components,
      trackedClanTags: context.trackedClanTags,
      destinationClanCount:
        context.clans.filter(
          (clan) => Number.isFinite(clan.base.memberCount) && clan.base.memberCount < 50,
        ).length,
      plannedMoveCount,
      availableFillerCount,
      pageIndex: render.pageIndex,
      pageCount: render.pageCount,
    };
  }

  async refreshFill(
    guildId?: string | null,
    options?: {
      userId?: string | null;
      cocService?: CoCService | null;
      clanConcurrency?: number;
      fillerConcurrency?: number;
      now?: Date;
    },
  ): Promise<CompoFillRefreshResult> {
    const guild = guildId ?? null;
    const cocService = options?.cocService ?? null;
    const context = await loadCompoActualStateContext(guild);
    const fillerRows =
      guild && guild.trim().length > 0
        ? await listFillerAccountsForGuild({ guildId: guild })
        : [];

    const clanSync = new FwaClanMembersSyncService();
    const trackedClanTags = context.trackedClanTags;
    const clanRefreshPromise =
      trackedClanTags.length > 0
        ? clanSync.refreshCurrentClanMembersForClanTags(trackedClanTags, {
            cocService: cocService ?? undefined,
            concurrency: Math.max(1, Math.trunc(options?.clanConcurrency ?? 4)),
            now: options?.now,
          })
        : Promise.resolve({
            clanCount: 0,
            rowCount: 0,
            changedRowCount: 0,
            failedClans: [] as string[],
          });

    const fillerTags = [
      ...new Set(
        fillerRows
          .map((row) => row.tag)
          .filter((tag) => String(tag ?? "").trim().length > 0),
      ),
    ];
    const fillerRefreshPromise =
      fillerTags.length > 0
        ? playerCurrentService.refreshCurrentPlayersFromLiveTags({
            playerTags: fillerTags,
            cocService,
            concurrency: Math.max(1, Math.trunc(options?.fillerConcurrency ?? 4)),
            source: "live_refresh",
            now: options?.now,
          })
        : Promise.resolve({
            playerCount: 0,
            successCount: 0,
            failedPlayerTags: [] as string[],
          });

    const [clanRefresh, fillerRefresh] = await Promise.all([
      clanRefreshPromise,
      fillerRefreshPromise,
    ]);

    const failedTrackedClanTags = [...new Set(clanRefresh.failedClans)].sort((left, right) =>
      left.localeCompare(right),
    );
    const failedFillerTags = [...new Set(fillerRefresh.failedPlayerTags)].sort((left, right) =>
      left.localeCompare(right),
    );
    const warningText = buildCompoFillRefreshWarning({
      failedTrackedClanTags,
      failedFillerTags,
    });

    if (warningText) {
      console.warn(
        `[compo-fill] refresh partial failure guild=${guild ?? "DM"} trackedClanCount=${trackedClanTags.length} fillerCount=${fillerTags.length} failedTrackedClans=${failedTrackedClanTags.join(",") || "none"} failedFillers=${failedFillerTags.join(",") || "none"}`,
      );
    }

    const render = await this.readFill(guild, {
      userId: options?.userId ?? null,
      pageIndex: 0,
    });

    return {
      ...render,
      warningText,
      failedTrackedClanTags,
      failedFillerTags,
    };
  }
}

export const estimateFillEmbedTextLengthForTest = estimateFillEmbedTextLength;
export const buildInGamePlayerProfileUrlForTest = buildInGamePlayerProfileUrl;
export const buildInGameClanProfileUrlForTest = buildInGameClanProfileUrl;
export const formatDiscordMarkdownLinkForTest = formatDiscordMarkdownLink;
export const formatShortWeightForTest = formatShortWeight;
export const normalizeLinkTagForTest = normalizeLinkTag;
