import type { HeatMapRef } from "@prisma/client";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { formatError } from "../helper/formatError";
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
import { CoCService } from "./CoCService";
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
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import { playerCurrentService } from "./PlayerCurrentService";

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
  components: Array<ActionRowBuilder<ButtonBuilder>>;
  trackedClanTags: string[];
  destinationClanCount: number;
  plannedMoveCount: number;
  availableFillerCount: number;
};

export type CompoFillRefreshResult = CompoFillReadResult & {
  warningText: string | null;
  failedTrackedClanTags: string[];
  failedFillerTags: string[];
};

const FILL_EMBED_TITLE = "Compo Fill Planner";
const FILL_PAGE_DESCRIPTION_LIMIT = 4096;
const FILL_PAGE_FIELD_LIMIT = 25;
const FILL_PAGE_CHAR_LIMIT = 4000;
const FILL_MAX_EMBEDS = 10;
const FILL_REFRESH_LABEL = "Refresh Data";
const FILL_REFRESH_LOADING_LABEL = "Refreshing...";

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

function buildFillRefreshComponents(input: {
  userId?: string | null;
  loading?: boolean;
}): Array<ActionRowBuilder<ButtonBuilder>> {
  const userId = String(input.userId ?? "").trim();
  if (!userId) {
    return [];
  }
  const loading = input.loading ?? false;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    options?: { userId?: string | null },
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

    const plannedMoveCount = result.destinationPlans.reduce(
      (sum, plan) => sum + plan.plannedMoves.length,
      0,
    );
    const availableFillerCount =
      plannedMoveCount + result.unusedAvailableFillers.length;

    const render = await measureFillStage({
      stage: "build_render",
      startDetail: {
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        destinationPlans: result.destinationPlans.length,
        plannedMoveCount,
      },
      work: async () => {
        const fields = buildSectionFieldList({
          result,
        });
        const summaryDescription = buildSummaryDescription({
          destinationPlans: result.destinationPlans,
          remainingUnfilledClanSlots: result.remainingUnfilledClanSlots,
          unusedAvailableFillers: result.unusedAvailableFillers,
          plannedMoveCount,
        });
        const embeds = buildEmbeds({
          summaryDescription,
          fields,
        });
        const components = buildFillRefreshComponents({ userId });
        return {
          content: "",
          embeds,
          components,
        };
      },
      completeDetail: (renderResult) => ({
        trackedClanTags: context.trackedClanTags.length,
        contextClans: context.clans.length,
        heatMapRefs: context.heatMapRefs.length,
        fillerRows: fillers.length,
        destinationPlans: result.destinationPlans.length,
        plannedMoveCount,
        embedCount: renderResult.embeds.length,
        componentRows: renderResult.components.length,
      }),
    });

    return {
      content: render.content,
      embeds: render.embeds,
      components: render.components,
      trackedClanTags: context.trackedClanTags,
      destinationClanCount: result.destinationPlans.length,
      plannedMoveCount,
      availableFillerCount,
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
    });

    return {
      ...render,
      warningText,
      failedTrackedClanTags,
      failedFillerTags,
    };
  }
}
