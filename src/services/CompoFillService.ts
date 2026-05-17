import type { HeatMapRef } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { type CompoWarBucketCounts } from "../helper/compoWarBucketCounts";
import {
  getCompoActualStateTargetBucketCounts,
  projectCompoActualStateView,
} from "../helper/compoActualStateView";
import type { CompoActualStateContext } from "./CompoActualStateService";
import {
  listFillerAccountsForGuild,
  type FillerAccountViewRow,
} from "./FillerAccountService";
import {
  buildCompoFillPlan,
  type CompoFillAvailableFiller,
  type CompoFillPlanResult,
  type CompoFillTrackedClanState,
  type CompoFillUnavailableFiller,
  type CompoFillExcludedFiller,
  type CompoFillDestinationPlan,
  type CompoFillRemainingSlot,
  type CompoFillPlannedMove,
} from "./CompoFillPlanner";
import { loadCompoActualStateContext } from "./CompoActualStateService";

type FillEmbedField = {
  name: string;
  value: string;
  inline: false;
};

type FillEmbedPage = {
  description?: string;
  fields: FillEmbedField[];
};

export type CompoFillReadResult = {
  content: string;
  embeds: EmbedBuilder[];
  trackedClanTags: string[];
  destinationClanCount: number;
  plannedMoveCount: number;
  availableFillerCount: number;
};

const FILL_EMBED_TITLE = "Compo Fill Planner";
const FILL_PAGE_DESCRIPTION_LIMIT = 4096;
const FILL_PAGE_FIELD_LIMIT = 25;
const FILL_PAGE_CHAR_LIMIT = 4000;
const FILL_MAX_EMBEDS = 10;

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

function formatClanReference(input: {
  clanTag: string | null;
  clanName: string | null;
  shortName?: string | null;
}): string {
  const shortName = String(input.shortName ?? "").trim();
  const clanName = formatClanName(String(input.clanName ?? "").trim());
  const clanTag = String(input.clanTag ?? "").trim();
  if (shortName && clanName) {
    return `${shortName} | ${clanName} (${clanTag || "?"})`;
  }
  if (clanName) {
    return `${clanName} (${clanTag || "?"})`;
  }
  if (shortName) {
    return `${shortName} (${clanTag || "?"})`;
  }
  return clanTag || "Unknown Clan";
}

function formatClanFieldHeader(plan: CompoFillDestinationPlan): string {
  const clanReference = formatClanReference({
    clanTag: plan.clanTag,
    clanName: plan.clanName,
    shortName: plan.shortName,
  });
  return `${clanReference} | ${plan.initialMemberCount}/50 -> ${plan.targetMemberCount}/50`;
}

function formatSlotHeader(slot: CompoFillRemainingSlot): string {
  return formatClanReference({
    clanTag: slot.clanTag,
    clanName: slot.clanName,
    shortName: slot.shortName,
  });
}

function formatSourceLabel(sourceClanTag: string | null, sourceClanName: string | null): string {
  if (!sourceClanTag) {
    return "outside tracked clans";
  }
  return formatClanReference({
    clanTag: sourceClanTag,
    clanName: sourceClanName,
  });
}

function formatFillerLabel(input: {
  playerTag: string;
  playerName: string;
}): string {
  return `${input.playerName} (${input.playerTag})`;
}

function formatMoveLine(move: CompoFillPlannedMove): string {
  const sourceLabel = formatSourceLabel(move.sourceClanTag, move.sourceClanName);
  const matchedLabel = move.matchedBucket ? `matched ${move.matchedBucket}` : "generic open slot";
  return [
    `${move.sequence}. ${formatFillerLabel(move.filler)}`,
    `${move.filler.resolvedWeight.toLocaleString("en-US")}`,
    `${move.filler.resolvedWeightBucket}`,
    `from ${sourceLabel}`,
    matchedLabel,
  ].join(" | ");
}

function formatAvailableLine(filler: CompoFillAvailableFiller): string {
  return [
    formatFillerLabel(filler),
    `${filler.resolvedWeight.toLocaleString("en-US")}`,
    `${filler.resolvedWeightBucket}`,
    `from ${formatSourceLabel(filler.sourceClanTag, filler.sourceClanName)}`,
  ].join(" | ");
}

function formatUnavailableLine(filler: CompoFillUnavailableFiller): string {
  return [
    formatFillerLabel(filler),
    `${filler.resolvedWeight.toLocaleString("en-US")}`,
    `${filler.resolvedWeightBucket}`,
    `from ${formatSourceLabel(filler.sourceClanTag, filler.sourceClanName)}`,
    `reason: ${filler.reasonCodes.join(", ")}`,
  ].join(" | ");
}

function formatExcludedLine(filler: CompoFillExcludedFiller): string {
  const weightLabel =
    filler.resolvedWeight === null ? "missing weight" : `${filler.resolvedWeight.toLocaleString("en-US")}`;
  const bucketLabel = filler.resolvedWeightBucket ?? "unresolved";
  return [
    formatFillerLabel(filler),
    weightLabel,
    bucketLabel,
    `reason: ${filler.reasonCodes.join(", ")}`,
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

function pageCharCount(
  page: FillEmbedPage,
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

function buildPageFooter(input: {
  pageIndex: number;
  pageCount: number;
  omittedPages: number;
}): string {
  const base = `Page ${input.pageIndex + 1}/${input.pageCount}`;
  if (input.omittedPages <= 0) {
    return base;
  }
  return `${base} | Truncated ${input.omittedPages} additional page(s) to stay within Discord limits.`;
}

function finalizePage(page: FillEmbedPage, title: string, footer: string): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(truncateForDiscord(title, 256)).setColor(0x57f287);
  if (page.description) {
    embed.setDescription(truncateForDiscord(page.description, FILL_PAGE_DESCRIPTION_LIMIT));
  }
  for (const field of page.fields) {
    embed.addFields(field);
  }
  embed.setFooter({ text: footer });
  return embed;
}

function buildEmbeds(input: {
  summaryDescription: string;
  fields: FillEmbedField[];
}): EmbedBuilder[] {
  const pages: FillEmbedPage[] = [];
  let current: FillEmbedPage = {
    description: truncateForDiscord(input.summaryDescription, FILL_PAGE_DESCRIPTION_LIMIT),
    fields: [],
  };

  for (const field of input.fields) {
    const projectedCharCount = pageCharCount(current, FILL_EMBED_TITLE, 240);
    const fieldCharCount = field.name.length + field.value.length;
    const exceedsFieldCount = current.fields.length >= FILL_PAGE_FIELD_LIMIT;
    const exceedsCharLimit = projectedCharCount + fieldCharCount > FILL_PAGE_CHAR_LIMIT;

    if (current.fields.length > 0 && (exceedsFieldCount || exceedsCharLimit)) {
      pages.push(current);
      current = {
        description: undefined,
        fields: [],
      };
    }

    current.fields.push(field);
  }

  pages.push(current);

  const cappedPages = pages.slice(0, FILL_MAX_EMBEDS);
  const omittedPages = pages.length - cappedPages.length;
  const totalPages = cappedPages.length;

  return cappedPages.map((page, index) =>
    finalizePage(
      page,
      FILL_EMBED_TITLE,
      buildPageFooter({
        pageIndex: index,
        pageCount: totalPages,
        omittedPages: index === cappedPages.length - 1 ? omittedPages : 0,
      }),
    ),
  );
}

function cloneBucketCounts(counts: CompoWarBucketCounts): CompoWarBucketCounts {
  return {
    ...counts,
  };
}

function buildFallbackTargetBucketCounts(input: {
  baseBucketCounts: CompoWarBucketCounts;
  memberCount: number;
}): CompoWarBucketCounts {
  const bucketCounts = cloneBucketCounts(input.baseBucketCounts);
  const missingSlots = Math.max(0, 50 - Math.trunc(input.memberCount));
  bucketCounts.TH13 += missingSlots;
  return bucketCounts;
}

function buildTrackedClanState(input: {
  clan: CompoActualStateContext["clans"][number];
  heatMapRefs: readonly HeatMapRef[];
}): CompoFillTrackedClanState {
  const projection = projectCompoActualStateView({
    view: "auto",
    base: input.clan.base,
    heatMapRefs: input.heatMapRefs,
  });

  return {
    clanTag: input.clan.clanTag,
    clanName: input.clan.clanName,
    shortName: input.clan.shortName,
    memberCount: input.clan.base.memberCount,
    currentBucketCounts: cloneBucketCounts(input.clan.base.bucketCounts),
    targetBucketCounts: projection.selectedHeatMapRef
      ? getCompoActualStateTargetBucketCounts(projection.selectedHeatMapRef)
      : buildFallbackTargetBucketCounts({
          baseBucketCounts: input.clan.base.bucketCounts,
          memberCount: input.clan.base.memberCount,
        }),
  };
}

function buildFillerCandidate(row: FillerAccountViewRow): {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
} {
  return {
    playerTag: row.tag,
    playerName: row.name,
    resolvedWeight: row.weight,
    currentClanTag: row.clanTag,
    currentClanName: row.clanName,
  };
}

function buildSummaryDescription(input: {
  destinationPlans: CompoFillDestinationPlan[];
  remainingUnfilledClanSlots: CompoFillRemainingSlot[];
  unusedAvailableFillers: CompoFillAvailableFiller[];
  plannedMoveCount: number;
}): string {
  const totalOpenSlots = input.remainingUnfilledClanSlots.reduce(
    (sum, slot) => sum + slot.remainingSlots,
    0,
  );
  const availableFillerCount =
    input.plannedMoveCount + input.unusedAvailableFillers.length;
  return [
    `Clans under 50: ${input.destinationPlans.length}`,
    `Open slots: ${totalOpenSlots}`,
    `Available fillers: ${availableFillerCount}`,
    `Recommended moves: ${input.plannedMoveCount}`,
  ].join(" | ");
}

function buildSectionFieldList(input: {
  result: CompoFillPlanResult;
}): FillEmbedField[] {
  const fields: FillEmbedField[] = [];

  for (const plan of input.result.destinationPlans) {
    if (plan.plannedMoves.length === 0) {
      continue;
    }
    const header = formatClanFieldHeader(plan);
    const lines = plan.plannedMoves.map((move) => formatMoveLine(move));
    fields.push(
      ...buildSectionFields({
        sectionName: `Recommended Moves - ${header}`,
        lines,
      }),
    );
  }

  if (input.result.remainingUnfilledClanSlots.length > 0) {
    fields.push(
      ...buildSectionFields({
        sectionName: "Remaining Open Slots",
        lines: input.result.remainingUnfilledClanSlots.map(
          (slot) =>
            `${formatSlotHeader(slot)} | ${slot.remainingSlots} open slot${slot.remainingSlots === 1 ? "" : "s"} | ${slot.currentMemberCount}/${slot.targetMemberCount}`,
        ),
      }),
    );
  }

  if (input.result.unusedAvailableFillers.length > 0) {
    fields.push(
      ...buildSectionFields({
        sectionName: "Unused Available Fillers",
        lines: input.result.unusedAvailableFillers.map((filler) => formatAvailableLine(filler)),
      }),
    );
  }

  if (input.result.unavailableFillers.length > 0) {
    fields.push(
      ...buildSectionFields({
        sectionName: "Unavailable Fillers",
        lines: input.result.unavailableFillers.map((filler) => formatUnavailableLine(filler)),
      }),
    );
  }

  if (input.result.excludedFillers.length > 0) {
    fields.push(
      ...buildSectionFields({
        sectionName: "Excluded / Missing Weight",
        lines: input.result.excludedFillers.map((filler) => formatExcludedLine(filler)),
      }),
    );
  }

  return fields;
}

/** Purpose: read and render DB-backed compo fill recommendations without any live CoC API calls. */
export class CompoFillService {
  async readFill(guildId?: string | null): Promise<CompoFillReadResult> {
    const context = await loadCompoActualStateContext(guildId ?? null);
    if (context.trackedClanTags.length === 0) {
      return {
        content: "No tracked FWA clans are configured for DB-backed compo fill recommendations.",
        embeds: [],
        trackedClanTags: [],
        destinationClanCount: 0,
        plannedMoveCount: 0,
        availableFillerCount: 0,
      };
    }

    const fillers =
      guildId && guildId.trim().length > 0
        ? await listFillerAccountsForGuild({ guildId })
        : [];

    const trackedClans = context.clans.map((clan) =>
      buildTrackedClanState({
        clan,
        heatMapRefs: context.heatMapRefs,
      }),
    );

    const result = buildCompoFillPlan({
      trackedClans,
      fillers: fillers.map(buildFillerCandidate),
    });

    const plannedMoveCount = result.destinationPlans.reduce(
      (sum, plan) => sum + plan.plannedMoves.length,
      0,
    );
    const availableFillerCount =
      plannedMoveCount + result.unusedAvailableFillers.length;

    const fields = buildSectionFieldList({
      result,
    });
    const summaryDescription = buildSummaryDescription({
      destinationPlans: result.destinationPlans,
      remainingUnfilledClanSlots: result.remainingUnfilledClanSlots,
      unusedAvailableFillers: result.unusedAvailableFillers,
      plannedMoveCount,
    });

    return {
      content: "",
      embeds: buildEmbeds({
        summaryDescription,
        fields,
      }),
      trackedClanTags: context.trackedClanTags,
      destinationClanCount: result.destinationPlans.length,
      plannedMoveCount,
      availableFillerCount,
    };
  }
}
