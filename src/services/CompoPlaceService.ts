import type { HeatMapRef } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { resolveActualCompoWeight } from "../helper/compoActualWeight";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  collapseCompoWarBucketCountsForDisplay,
} from "../helper/compoWarBucketCounts";
import { type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import {
  assessCompoActualRosterEvidence,
  hasCompoActualRosterCountEvidence,
} from "../helper/compoActualRosterEvidence";
import { prisma } from "../prisma";
import {
  loadCompoActualStateContext,
  type CompoActualStateClanContext,
} from "./CompoActualStateService";
import { normalizeTag } from "./war-events/core";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import {
  projectCompoActualStateView,
  type CompoActualStateProjection,
} from "../helper/compoActualStateView";
import {
  CompoReplacementService,
  type CompoReplacementClanSummary,
  type CompoReplacementEvaluation,
} from "./CompoReplacementService";

type PlacementCandidate = {
  clanName: string;
  clanTag: string;
  totalWeight: number;
  targetBand: number;
  missingCount: number;
  remainingToTarget: number;
  bucketDeltaByHeader: Record<string, number | null>;
  liveMemberCount: number | null;
  vacancySlots: number | null;
  hasVacancy: boolean;
};

type PlacementCandidateWithDelta = PlacementCandidate & {
  delta: number | null;
};

type FactualObservation = {
  clanName: string;
  observedBucketCount: number | null;
  memberCount: number | null;
  unresolvedWeightCount: number;
  unclassifiedWeightCount: number;
  sourceSyncedAt: Date | null;
  rosterCoverage: NonNullable<CompoActualStateClanContext["base"]["rosterCoverage"]>;
  classificationComplete: boolean;
  targetEligible: boolean;
  targetAvailabilityLabel: string;
};
export type CompoPlaceReadResult = {
  content: string;
  embeds: EmbedBuilder[];
  trackedClanTags: string[];
  eligibleClanTags: string[];
  candidateCount: number;
  recommendedCount: number;
  vacancyCount: number;
  compositionCount: number;
};

function normalizePlaceClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value).trimEnd();
  if (!normalized.endsWith("-war")) {
    return normalized;
  }
  return normalized.slice(0, -"-war".length).trimEnd();
}

function abbreviateClan(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/TM/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const map: Record<string, string> = {
    "RISING DAWN": "RD",
    "ZERO GRAVITY": "ZG",
    "DARK EMPIRE": "DE",
    "THE BADLANDS": "BL",
    "LEGENDARY ROYALS": "LR",
    "STEEL EMPIRE": "SE",
    "STEEL EMPIRE 2": "SE",
    THEWISECOWBOYS: "TWC",
    MARVELS: "MV",
    "ROCKY ROAD": "RR",
    AKATSUKI: "AK",
  };

  return map[normalized] ?? value;
}

function normalizeBucketDeltaKey(bucket: CompoWarDisplayBucket): string {
  return bucket === "<=TH13" ? "<=th13-delta" : `${bucket.toLowerCase()}-delta`;
}

function formatPlacementRows(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None";
}

type CompoPlaceField = { name: string; value: string; inline: boolean };

/** Purpose: preserve the existing `/compo place` embed structure while swapping the source to persisted ACTUAL data. */
function buildCompoPlaceFields(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  modeLabel?: string;
  deltaLabel?: string;
  recommended: PlacementCandidateWithDelta[];
  factualObservations?: FactualObservation[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
  replacementEvaluationLabel?: string;
  targetComparisonAvailable?: boolean;
}): CompoPlaceField[] {
  const targetComparisonAvailable = params.targetComparisonAvailable !== false;
  const recommendedRows = targetComparisonAvailable
    ? params.recommended.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - needs ${candidate.delta === null ? "UNKNOWN" : Math.abs(candidate.delta)} ${params.bucket}`,
      )
    : ["UNKNOWN — target comparison unavailable"];
  const vacancyRows = params.vacancyList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${
        candidate.liveMemberCount !== null
          ? `${candidate.liveMemberCount}/50`
          : "unknown/50"
      }`,
  );
  const compositionRows = targetComparisonAvailable
    ? params.compositionList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${candidate.delta}`,
      )
    : ["UNKNOWN — target comparison unavailable"];
  const factualRows = (params.factualObservations ?? []).map((observation) => {
    const memberCount = observation.memberCount === null
      ? "unknown/50"
      : observation.rosterCoverage === "complete"
        ? `${observation.memberCount}/50`
        : observation.rosterCoverage === "stale"
          ? `stale observed ${observation.memberCount} rows · current total UNKNOWN`
          : `observed ${observation.memberCount} rows · current total UNKNOWN`;
    const bucketCount = observation.observedBucketCount === null
      ? "UNKNOWN"
      : observation.rosterCoverage === "complete" && observation.classificationComplete
        ? `observed ${observation.observedBucketCount} ${params.bucket}`
        : `observed ${observation.observedBucketCount} ${params.bucket} (coverage not complete)`;
    const coverage = [
      `coverage ${observation.rosterCoverage}`,
      !observation.classificationComplete ? "classification partial" : null,
      observation.unresolvedWeightCount > 0
        ? `unresolved ${observation.unresolvedWeightCount}`
        : null,
      observation.unclassifiedWeightCount > 0
        ? `unclassified ${observation.unclassifiedWeightCount}`
        : null,
      observation.targetAvailabilityLabel,
      `source ${observation.sourceSyncedAt
        ? `<t:${Math.floor(observation.sourceSyncedAt.getTime() / 1000)}:R>`
        : "unavailable"}`,
    ].filter((value): value is string => Boolean(value));
    return `${abbreviateClan(normalizePlaceClanDisplayName(observation.clanName))} - ${bucketCount} · ${memberCount}${coverage.length > 0 ? ` · ${coverage.join(" · ")}` : ""}`;
  });

  const fields = [
    ...(factualRows.length > 0
      ? [{
          name: "Factual observations",
          value: formatPlacementRows(factualRows),
          inline: false,
        }]
      : []),
    {
      name: "Recommended",
      value: formatPlacementRows(recommendedRows),
      inline: false,
    },
    {
      name: "Vacancy",
      value: formatPlacementRows(vacancyRows),
      inline: false,
    },
    {
      name: "Composition",
      value: formatPlacementRows(compositionRows),
      inline: false,
    },
  ];

  return fields;
}

function buildCompoPlaceEmbed(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  modeLabel?: string;
  deltaLabel?: string;
  recommended: PlacementCandidateWithDelta[];
  factualObservations?: FactualObservation[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
  replacementEvaluationLabel?: string;
  targetComparisonAvailable?: boolean;
}): EmbedBuilder {
  const fields = buildCompoPlaceFields(params);
  return new EmbedBuilder()
    .setTitle("Compo Placement Suggestions")
    .setDescription(
      `Mode: **${params.modeLabel ?? buildCompoPlaceModeLabel()}**\n` +
        `Deltas: **${params.deltaLabel ?? buildCompoPlaceDeltaLabel()}**\n` +
      `Weight: **${params.inputWeight.toLocaleString("en-US")}**\n` +
        `Bucket: **${params.bucket}**\n` +
        params.refreshLine,
    )
    .addFields(fields);
}

const COMPO_PLACE_FIELD_VALUE_LIMIT = 1024;
const COMPO_PLACE_EMBED_TOTAL_LIMIT = 5800;
const COMPO_PLACE_MAX_EMBEDS = 10;

function splitCompoPlaceFieldValue(value: string): string[] {
  const lines = value.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const boundedLine = line.length <= COMPO_PLACE_FIELD_VALUE_LIMIT
      ? line
      : line.slice(0, COMPO_PLACE_FIELD_VALUE_LIMIT - 1) + "…";
    const candidate = current ? `${current}\n${boundedLine}` : boundedLine;
    if (candidate.length <= COMPO_PLACE_FIELD_VALUE_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = boundedLine;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** Purpose: keep every placement fact/status while respecting Discord field/embed limits. */
function buildBoundedCompoPlaceEmbeds(
  params: Parameters<typeof buildCompoPlaceEmbed>[0],
  replacementField: CompoPlaceField | null,
): EmbedBuilder[] {
  const description = [
    `Mode: **${params.modeLabel ?? buildCompoPlaceModeLabel()}**`,
    `Deltas: **${params.deltaLabel ?? buildCompoPlaceDeltaLabel()}**`,
    `Weight: **${params.inputWeight.toLocaleString("en-US")}**`,
    `Bucket: **${params.bucket}**`,
    params.refreshLine,
  ].join("\n");
  const sourceFields = [
    ...buildCompoPlaceFields(params),
    ...(replacementField ? [replacementField] : []),
  ];
  const boundedFields: CompoPlaceField[] = [];
  for (const field of sourceFields) {
    const parts = splitCompoPlaceFieldValue(field.value);
    for (const [index, value] of parts.entries()) {
      boundedFields.push({
        name: parts.length === 1 ? field.name : `${field.name} ${index + 1}/${parts.length}`,
        value,
        inline: Boolean(field.inline),
      });
    }
  }

  const embeds: EmbedBuilder[] = [];
  let fields: CompoPlaceField[] = [];
  let estimatedSize = description.length + 64;
  const flush = () => {
    if (fields.length === 0) return;
    embeds.push(
      new EmbedBuilder()
        .setTitle("Compo Placement Suggestions")
        .setDescription(description)
        .addFields(fields),
    );
    fields = [];
    estimatedSize = description.length + 64;
  };
  for (const field of boundedFields) {
    const fieldSize = field.name.length + field.value.length + 16;
    if (
      fields.length >= 25 ||
      (fields.length > 0 && estimatedSize + fieldSize > COMPO_PLACE_EMBED_TOTAL_LIMIT)
    ) {
      flush();
    }
    fields.push(field);
    estimatedSize += fieldSize;
  }
  flush();

  if (embeds.length > COMPO_PLACE_MAX_EMBEDS) {
    throw new Error("Placement result exceeds Discord embed limits; use a smaller tracked-clan cohort.");
  }
  return embeds;
}

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function buildCompoPlaceModeLabel(): string {
  return "ACTUAL Auto-Detect";
}

function buildCompoPlaceDeltaLabel(): string {
  return "resolved roster vs HeatMapRef";
}

function buildBucketDeltaByHeader(
  heatMapRef: HeatMapRef,
  counts: ReturnType<typeof collapseCompoWarBucketCountsForDisplay>,
): Record<string, number> {
  return {
    "th18-delta": counts.TH18 - heatMapRef.th18Count,
    "th17-delta": counts.TH17 - heatMapRef.th17Count,
    "th16-delta": counts.TH16 - heatMapRef.th16Count,
    "th15-delta": counts.TH15 - heatMapRef.th15Count,
    "th14-delta": counts.TH14 - heatMapRef.th14Count,
    "<=th13-delta":
      counts["<=TH13"] -
      (heatMapRef.th13Count +
        heatMapRef.th12Count +
        heatMapRef.th11Count +
        heatMapRef.th10OrLowerCount),
  };
}

function buildBucketDeltaByHeaderFromProjection(
  projection: CompoActualStateProjection,
): Record<string, number | null> {
  return {
    "th18-delta": projection.deltaByBucket.TH18,
    "th17-delta": projection.deltaByBucket.TH17,
    "th16-delta": projection.deltaByBucket.TH16,
    "th15-delta": projection.deltaByBucket.TH15,
    "th14-delta": projection.deltaByBucket.TH14,
    "<=th13-delta": projection.deltaByBucket["<=TH13"],
  };
}

function buildFactualObservations(input: {
  clans: CompoActualStateClanContext[];
  bucket: CompoWarDisplayBucket;
  targetComparisonAvailable: boolean;
  eligibleTargetClanTags: ReadonlySet<string>;
}): FactualObservation[] {
  return input.clans.map((clan) => {
    const displayCounts = collapseCompoWarBucketCountsForDisplay(clan.base.bucketCounts);
    const evidence = assessCompoActualRosterEvidence({ clan });
    const coverage = clan.base.rosterCoverage ?? (evidence === "complete" ? "complete" : "unavailable");
    const hasPersistedRows = clan.members.length > 0;
    const observedBucketCount = coverage === "complete" || hasPersistedRows
      ? displayCounts[input.bucket] ?? 0
      : null;
    const targetEligible = input.targetComparisonAvailable && input.eligibleTargetClanTags.has(clan.clanTag);
    const targetUnavailableReason = input.bucket === "TH19"
      ? "target UNKNOWN (unsupported TH19)"
      : evidence !== "complete"
        ? "target UNKNOWN (roster evidence unavailable)"
        : "target UNKNOWN (no applicable validated reference)";
    return {
      clanName: clan.clanName,
      observedBucketCount,
      memberCount: hasCompoActualRosterCountEvidence(clan) ? clan.base.memberCount : null,
      unresolvedWeightCount: clan.base.unresolvedWeightCount,
      unclassifiedWeightCount: clan.base.unclassifiedWeightCount ?? 0,
      sourceSyncedAt: clan.base.rosterObservedAt ?? clan.sourceSyncedAt ?? null,
      rosterCoverage: coverage,
      classificationComplete: evidence === "complete",
      targetEligible,
      targetAvailabilityLabel: targetEligible
        ? "target eligible"
        : targetUnavailableReason,
    };
  });
}

function buildFactualVacancyList(
  clans: CompoActualStateClanContext[],
): PlacementCandidate[] {
  return clans
    .map((clan) => {
      const countEvidence = hasCompoActualRosterCountEvidence(clan);
      const liveMemberCount = countEvidence
        ? Math.max(0, Math.min(50, Math.trunc(clan.base.memberCount)))
        : null;
      const vacancySlots = liveMemberCount === null ? null : Math.max(0, 50 - liveMemberCount);
      return {
        clanName: normalizePlaceClanDisplayName(clan.clanName),
        clanTag: clan.clanTag,
        totalWeight: clan.base.resolvedTotalWeight,
        targetBand: 0,
        missingCount: clan.base.unresolvedWeightCount,
        remainingToTarget: 0,
        bucketDeltaByHeader: {},
        liveMemberCount,
        vacancySlots,
        hasVacancy: vacancySlots !== null && vacancySlots > 0,
      };
    })
    .filter((candidate) => candidate.hasVacancy || candidate.liveMemberCount === null)
    .sort((left, right) => {
      if (left.vacancySlots !== null && right.vacancySlots !== null && left.vacancySlots !== right.vacancySlots) {
        return right.vacancySlots - left.vacancySlots;
      }
      if (left.vacancySlots === null && right.vacancySlots !== null) return 1;
      if (left.vacancySlots !== null && right.vacancySlots === null) return -1;
      return normalizePlaceClanDisplayName(left.clanName).localeCompare(
        normalizePlaceClanDisplayName(right.clanName),
      );
    });
}

function buildPlacementCandidates(input: {
  clans: CompoActualStateClanContext[];
  heatMapRefs: HeatMapRef[];
  targetComparisonAvailable: boolean;
}): {
  candidates: PlacementCandidate[];
  latestSourceSyncedAt: Date | null;
} {
  const candidates: PlacementCandidate[] = [];
  if (!input.targetComparisonAvailable) {
    return { candidates, latestSourceSyncedAt: null };
  }
  for (const clan of input.clans) {
    if (assessCompoActualRosterEvidence({ clan }) !== "complete") {
      continue;
    }
    if (clan.base.resolvedTotalWeight <= 0 || (clan.base.bucketCounts.TH19 ?? 0) > 0) {
      continue;
    }
    const projection = projectCompoActualStateView({
      view: "auto",
      base: clan.base,
      heatMapRefs: input.heatMapRefs,
    });
    const selectedHeatMapRef = projection.selectedHeatMapRef;
    if (!selectedHeatMapRef) {
      continue;
    }

    const liveMemberCount = Math.max(0, Math.min(50, Math.trunc(clan.base.memberCount)));
    candidates.push({
      clanName: normalizePlaceClanDisplayName(clan.clanName),
      clanTag: clan.clanTag,
      totalWeight: projection.totalWeight,
      targetBand: selectedHeatMapRef.weightMaxInclusive,
      missingCount: clan.base.unresolvedWeightCount + (clan.base.unclassifiedWeightCount ?? 0),
      remainingToTarget: selectedHeatMapRef.weightMaxInclusive - projection.totalWeight,
      bucketDeltaByHeader: buildBucketDeltaByHeaderFromProjection(projection),
      liveMemberCount,
      vacancySlots: Math.max(0, 50 - liveMemberCount),
      hasVacancy: liveMemberCount < 50,
    });
  }

  return { candidates, latestSourceSyncedAt: null };
}

function buildReplacementSummaryLabel(clan: CompoActualStateClanContext): string {
  const shortName = clan.shortName?.trim() || "";
  if (shortName) {
    return shortName;
  }
  return abbreviateClan(normalizePlaceClanDisplayName(clan.clanName));
}

function buildPossibleReplacementsValue(input: {
  clansInDisplayOrder: CompoActualStateClanContext[];
  summaryByClan: CompoReplacementClanSummary[];
  evaluation: CompoReplacementEvaluation;
}): string {
  const summaryByClan = new Map(
    input.summaryByClan.map((summary) => [summary.clanTag, summary] as const),
  );

  const rows = input.clansInDisplayOrder.map((clan) => {
    const label = buildReplacementSummaryLabel(clan);
    const summary = summaryByClan.get(clan.clanTag);
    if (summary?.evaluationStatus === "unavailable") {
      return `${label}: UNKNOWN — replacement evaluation unavailable`;
    }
    if (!summary || summary.uniqueCandidateCount <= 0) {
      return `${label}: none`;
    }

    const reasonCounts: string[] = [];
    if (summary.fillerCount > 0) {
      reasonCounts.push(`🧍${summary.fillerCount}`);
    }
    if (summary.inactiveCount > 0) {
      reasonCounts.push(`😴${summary.inactiveCount}`);
    }
    if (summary.unlinkedCount > 0) {
      reasonCounts.push(`📵${summary.unlinkedCount}`);
    }
    if (summary.surplusCount > 0) {
      reasonCounts.push(`📈${summary.surplusCount}`);
    }

    const candidateLabel =
      summary.uniqueCandidateCount === 1 ? "candidate" : "candidates";
    const reasonSuffix =
      reasonCounts.length > 0 ? ` · ${reasonCounts.join(" ")}` : "";

    return `${label}: ${summary.uniqueCandidateCount} ${candidateLabel}${reasonSuffix}`;
  });

  return [
    "Legend: 🧍 fillers · 😴 inactive · 📵 unlinked · 📈 surplus bucket",
    `Evaluation: ${input.evaluation.status === "unavailable" ? "UNKNOWN" : input.evaluation.status === "partial" ? "PARTIAL" : "evaluated"}`,
    "",
    ...rows,
  ].join("\n");
}

function buildPossibleReplacementsField(input: {
  clansInDisplayOrder: CompoActualStateClanContext[];
  summaryByClan: CompoReplacementClanSummary[];
  evaluation: CompoReplacementEvaluation;
}): { name: string; value: string; inline: boolean } | null {
  if (input.clansInDisplayOrder.length === 0) {
    return null;
  }

  return {
    name: "Possible replacements",
    value: buildPossibleReplacementsValue(input),
    inline: false,
  };
}

/** Purpose: derive `/compo place` suggestions from persisted ACTUAL feed-backed current-member state. */
export class CompoPlaceService {
  private readonly clanMembersSync = new FwaClanMembersSyncService();
  private readonly replacementService = new CompoReplacementService();

  /** Purpose: load ACTUAL placement suggestions using one persisted tracked-clan/member snapshot read plus deterministic weight fallbacks. */
  async readPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
  ): Promise<CompoPlaceReadResult> {
    const context = await loadCompoActualStateContext(guildId ?? null);
    if (context.trackedClanTags.length === 0) {
      const unknownEmbed = new EmbedBuilder()
        .setTitle("Compo Placement Suggestions")
        .setDescription(
          `Mode: **${buildCompoPlaceModeLabel()}**\n` +
          "Deltas: **UNKNOWN target comparison**\n" +
          `Weight: **${inputWeight.toLocaleString("en-US")}**\n` +
          `Bucket: **${bucket}**\n` +
          "RAW Data last refreshed: (not available)",
        )
        .addFields(
          { name: "Factual observations", value: "UNKNOWN — no tracked clans configured", inline: false },
          { name: "Recommended", value: "UNKNOWN — target comparison unavailable", inline: false },
          { name: "Vacancy", value: "UNKNOWN — roster observations unavailable", inline: false },
          { name: "Composition", value: "UNKNOWN — target comparison unavailable", inline: false },
        );
      return {
        content:
          `Input weight: **${inputWeight.toLocaleString("en-US")}**\n` +
          `Bucket: **${bucket}**\n` +
          "Factual roster observations: **UNKNOWN — no tracked clans configured**\n" +
          "Target comparison: **UNKNOWN** — placement rankings and replacement suggestions are withheld.",
        embeds: [unknownEmbed],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      };
    }

    const referenceComparisonAvailable =
      bucket !== "TH19" && context.referenceAvailability?.status === "validated";
    const factualVacancyList = buildFactualVacancyList(context.clans);

    const { candidates } = buildPlacementCandidates({
      clans: context.clans,
      heatMapRefs: context.heatMapRefs,
      targetComparisonAvailable: referenceComparisonAvailable,
    });

    const compositionNeeds = candidates
      .map((candidate) => ({
        ...candidate,
        delta: candidate.bucketDeltaByHeader[normalizeBucketDeltaKey(bucket)] ?? null,
      }))
      .filter((candidate): candidate is PlacementCandidateWithDelta =>
        typeof candidate.delta === "number" && candidate.delta < 0,
      )
      .sort((a, b) => {
        if (a.delta === null || b.delta === null) return a.delta === b.delta ? 0 : a.delta === null ? 1 : -1;
        if (a.delta !== b.delta) return a.delta - b.delta;
        if (b.missingCount !== a.missingCount) return b.missingCount - a.missingCount;
        return normalizePlaceClanDisplayName(a.clanName).localeCompare(
          normalizePlaceClanDisplayName(b.clanName),
        );
      });

    const vacancyList = factualVacancyList;

    const recommended = compositionNeeds.filter(
      (candidate) => candidate.hasVacancy,
    );
    const replacementResolution = await this.replacementService.resolveReplacementCandidates({
      guildId: guildId ?? null,
      weight: inputWeight,
      bucket,
      context,
    });
    const eligiblePlacementTags = new Set(candidates.map((candidate) => candidate.clanTag));
    const eligibleReplacementTags = new Set(replacementResolution.evaluation.eligibleClanTags);
    const eligibleTargetClanTags = new Set(
      [...eligiblePlacementTags].filter((tag) => eligibleReplacementTags.has(tag)),
    );
    const targetComparisonAvailable =
      referenceComparisonAvailable && eligibleTargetClanTags.size > 0;
    const factualObservations = buildFactualObservations({
      clans: context.clans,
      bucket,
      targetComparisonAvailable: referenceComparisonAvailable,
      eligibleTargetClanTags,
    });
    const possibleReplacementsField = buildPossibleReplacementsField({
      clansInDisplayOrder: context.clans,
      summaryByClan: replacementResolution.summaryByClan,
      evaluation: replacementResolution.evaluation,
    });

    const noEligiblePlacementMessage = "No eligible placement data found in persisted ACTUAL current-member state.";
    const targetWarning = targetComparisonAvailable
      ? null
      : bucket === "TH19"
        ? `Target comparison is UNKNOWN for TH19; placement rankings and replacement suggestions are withheld.\n${noEligiblePlacementMessage}`
        : !referenceComparisonAvailable
          ? `${context.referenceAvailability?.warning ?? "HeatMapRef validation is unavailable."} Target-derived placement and replacement recommendations are withheld.\n${noEligiblePlacementMessage}`
          : `Target comparison is UNKNOWN because no tracked clan has an applicable validated target; placement rankings and replacement suggestions are withheld.\n${noEligiblePlacementMessage}`;

    const embeds = buildBoundedCompoPlaceEmbeds(
      {
        inputWeight,
        bucket,
        recommended,
        factualObservations,
        vacancyList,
        compositionList: compositionNeeds,
        refreshLine: buildPersistedRefreshLine(context.latestSourceSyncedAt),
        modeLabel: buildCompoPlaceModeLabel(),
        deltaLabel: targetComparisonAvailable
          ? buildCompoPlaceDeltaLabel()
          : "UNKNOWN target comparison",
        targetComparisonAvailable,
      },
      possibleReplacementsField,
    );

    return {
      content: targetWarning ?? (candidates.length === 0
        ? "No eligible placement data found in persisted ACTUAL current-member state."
        : ""),
      embeds,
      trackedClanTags: context.trackedClanTags,
      eligibleClanTags: candidates.map((candidate) => candidate.clanTag),
      candidateCount: candidates.length,
      recommendedCount: recommended.length,
      vacancyCount: factualVacancyList.filter((candidate) => candidate.hasVacancy).length,
      compositionCount: compositionNeeds.length,
    };
  }

  /** Purpose: explicitly refresh ACTUAL current-member weights plus live member counts for tracked clans, then rerender `/compo place` from persisted state. */
  async refreshPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
  ): Promise<CompoPlaceReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedClanTags = tracked
      .map((clan) => normalizeTag(clan.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedClanTags.length > 0) {
      await this.clanMembersSync.syncAllTrackedClans({
        force: true,
      });
      await this.clanMembersSync.refreshCurrentClanMembersForClanTags(
        trackedClanTags,
      );
    }
    return this.readPlace(inputWeight, bucket, guildId);
  }
}

export const buildCompoPlaceEmbedForTest = buildCompoPlaceEmbed;
export const buildBucketDeltaByHeaderForTest = buildBucketDeltaByHeader;
export const resolvePlacementWeightForTest = resolveActualCompoWeight;
