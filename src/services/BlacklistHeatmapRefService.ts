import { prisma } from "../prisma";
import {
  buildBlacklistHeatMapRefCopyText,
  buildBlacklistHeatMapRefDisplayRows,
} from "../helper/heatMapRefDisplay";
import {
  normalizeHeatMapRefRoundedBucketCounts,
  type HeatMapRefBucketCounts,
} from "../helper/heatMapRefRebuild";

export type BlacklistHeatmapRefConfidenceLabel = "low" | "medium" | "high";

export type BlacklistHeatmapRefRebuildResult = {
  status: "success" | "noop" | "skipped";
  reason: string | null;
  usableSampleCount: number;
  bandCount: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  summaryLines: string[];
};

type BandAggregate = {
  weightMinInclusive: number;
  weightMaxInclusive: number;
  sampleCount: number;
  uniqueSourceClanTags: Set<string>;
  uniqueOpponentTags: Set<string>;
  totalMissingWeightCount: number;
  sumCounts: HeatMapRefBucketCounts & { th11PlusCount: number };
};

type BlacklistHeatmapRefRow = {
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
  sampleCount: number;
  uniqueSourceClanCount: number;
  uniqueOpponentCount: number;
  totalMissingWeightCount: number;
  confidenceLabel: BlacklistHeatmapRefConfidenceLabel;
  confidenceScore: number;
  generatedAt: Date;
};

const BLACKLIST_PROFILE_BAND_WIDTH = 100_000;
const BLACKLIST_PROFILE_USABLE_CONFIDENCE = new Set(["high", "medium"]);
const BLACKLIST_PROFILE_MIN_CONFIDENCE_SCORE_FOR_MEDIUM = 40;
const BLACKLIST_PROFILE_MIN_CONFIDENCE_SCORE_FOR_HIGH = 75;
const BLACKLIST_SAMPLE_ROSTER_SIZE = 50;

type BlacklistSampleValidationReason = "roster_size" | "invalid_counts" | "bucket_sum";

function normalizeTag(input: string | null | undefined): string {
  const value = String(input ?? "").trim().toUpperCase();
  if (!value) return "";
  const prefixed = value.startsWith("#") ? value : `#${value}`;
  return prefixed;
}

function buildBandRange(totalRosterWeight: number): {
  weightMinInclusive: number;
  weightMaxInclusive: number;
} {
  const normalized = Math.max(0, Math.trunc(totalRosterWeight));
  const weightMinInclusive =
    Math.floor(normalized / BLACKLIST_PROFILE_BAND_WIDTH) * BLACKLIST_PROFILE_BAND_WIDTH;
  return {
    weightMinInclusive,
    weightMaxInclusive: weightMinInclusive + BLACKLIST_PROFILE_BAND_WIDTH - 1,
  };
}

function createEmptyBandAggregate(input: {
  weightMinInclusive: number;
  weightMaxInclusive: number;
}): BandAggregate {
  return {
    weightMinInclusive: input.weightMinInclusive,
    weightMaxInclusive: input.weightMaxInclusive,
    sampleCount: 0,
    uniqueSourceClanTags: new Set(),
    uniqueOpponentTags: new Set(),
    totalMissingWeightCount: 0,
    sumCounts: {
      th18Count: 0,
      th17Count: 0,
      th16Count: 0,
      th15Count: 0,
      th14Count: 0,
      th13Count: 0,
      th12Count: 0,
      th11Count: 0,
      th10OrLowerCount: 0,
      th11PlusCount: 0,
    },
  };
}

function confidenceScoreToLabel(score: number): BlacklistHeatmapRefConfidenceLabel {
  if (score >= BLACKLIST_PROFILE_MIN_CONFIDENCE_SCORE_FOR_HIGH) return "high";
  if (score >= BLACKLIST_PROFILE_MIN_CONFIDENCE_SCORE_FOR_MEDIUM) return "medium";
  return "low";
}

function computeConfidenceScore(input: {
  sampleCount: number;
  uniqueSourceClanCount: number;
  uniqueOpponentCount: number;
  totalMissingWeightCount: number;
}): number {
  const sampleScore = Math.min(100, input.sampleCount * 25);
  const diversityScore =
    Math.min(15, Math.max(0, input.uniqueSourceClanCount - 1) * 5) +
    Math.min(10, Math.max(0, input.uniqueOpponentCount - 1) * 5);
  const missingPenalty = Math.min(
    30,
    Math.round(input.totalMissingWeightCount / Math.max(1, input.sampleCount)),
  );
  return Math.max(0, Math.min(100, sampleScore + diversityScore - missingPenalty));
}

function buildNormalizedCountsFromAverages(input: {
  sampleCount: number;
  sumCounts: BandAggregate["sumCounts"];
}): {
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
} {
  const divisor = Math.max(1, input.sampleCount);
  const normalized = normalizeHeatMapRefRoundedBucketCounts({
    rawCounts: {
      th18Count: input.sumCounts.th18Count / divisor,
      th17Count: input.sumCounts.th17Count / divisor,
      th16Count: input.sumCounts.th16Count / divisor,
      th15Count: input.sumCounts.th15Count / divisor,
      th14Count: input.sumCounts.th14Count / divisor,
      th13Count: input.sumCounts.th13Count / divisor,
      th12Count: input.sumCounts.th12Count / divisor,
      th11Count: input.sumCounts.th11PlusCount / divisor,
      th10OrLowerCount: 0,
    },
    targetTotal: 50,
  });
  return {
    th18Count: normalized.th18Count,
    th17Count: normalized.th17Count,
    th16Count: normalized.th16Count,
    th15Count: normalized.th15Count,
    th14Count: normalized.th14Count,
    th13Count: normalized.th13Count,
    th12Count: normalized.th12Count,
    th11PlusCount: normalized.th11Count + normalized.th10OrLowerCount,
  };
}

function countSampleBuckets(input: {
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
}): number {
  return [
    input.th18Count,
    input.th17Count,
    input.th16Count,
    input.th15Count,
    input.th14Count,
    input.th13Count,
    input.th12Count,
    input.th11PlusCount,
  ].reduce((sum, count) => sum + count, 0);
}

function getBlacklistSampleValidationReason(row: {
  rosterSize: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11PlusCount: number;
}): BlacklistSampleValidationReason | null {
  if (row.rosterSize !== BLACKLIST_SAMPLE_ROSTER_SIZE) {
    return "roster_size";
  }
  const counts = [
    row.th18Count,
    row.th17Count,
    row.th16Count,
    row.th15Count,
    row.th14Count,
    row.th13Count,
    row.th12Count,
    row.th11PlusCount,
  ];
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
    return "invalid_counts";
  }
  return countSampleBuckets(row) === BLACKLIST_SAMPLE_ROSTER_SIZE ? null : "bucket_sum";
}

function buildSummaryLines(input: {
  usableSampleCount: number;
  bandCount: number;
  addedCount: number;
  updatedCount: number;
  removedCount: number;
  invalidSampleReasonCounts?: Readonly<Record<string, number>>;
  status: BlacklistHeatmapRefRebuildResult["status"];
  reason: string | null;
}): string[] {
  const lines = [
    `usable samples: ${input.usableSampleCount}`,
    `bands written: ${input.bandCount}`,
    `rows added: ${input.addedCount}`,
    `rows updated: ${input.updatedCount}`,
    `rows removed: ${input.removedCount}`,
    `result: ${input.status}`,
  ];
  if (input.reason) {
    lines.push(`reason: ${input.reason}`);
  }
  if (input.invalidSampleReasonCounts && Object.keys(input.invalidSampleReasonCounts).length > 0) {
    lines.push(
      `rejected sample reasons: ${Object.entries(input.invalidSampleReasonCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reasonCode, count]) => `${reasonCode}=${count}`)
        .join(", ")}`,
    );
  }
  return lines;
}

export class BlacklistHeatmapRefService {
  async readBlacklistHeatMapRefDisplayTable(): Promise<{
    rows: string[][];
    copyText: string;
  }> {
    const heatMapRefs = await prisma.blacklistHeatMapRef.findMany({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    });
    return {
      rows: buildBlacklistHeatMapRefDisplayRows({ heatMapRefs }),
      copyText: buildBlacklistHeatMapRefCopyText({ heatMapRefs }),
    };
  }

  async rebuildBlacklistHeatmapRef(input?: {
    now?: Date;
  }): Promise<BlacklistHeatmapRefRebuildResult> {
    const generatedAt = input?.now ?? new Date();
    const sampleRows = await prisma.blacklistMatchSample.findMany({
      where: {
        confidence: { in: [...BLACKLIST_PROFILE_USABLE_CONFIDENCE] },
      },
      orderBy: [
        { totalRosterWeight: "asc" },
        { sourceClanTag: "asc" },
        { opponentBlacklistTag: "asc" },
        { warId: "asc" },
      ],
      select: {
        sourceClanTag: true,
        opponentBlacklistTag: true,
        totalRosterWeight: true,
        rosterSize: true,
        missingWeightCount: true,
        th18Count: true,
        th17Count: true,
        th16Count: true,
        th15Count: true,
        th14Count: true,
        th13Count: true,
        th12Count: true,
        th11PlusCount: true,
        sampleQuality: true,
        confidence: true,
      },
    });

    const invalidSampleReasonCounts: Record<string, number> = {};
    const completeSampleRows = sampleRows.filter((row) => {
      const reason = getBlacklistSampleValidationReason(row);
      if (reason) {
        invalidSampleReasonCounts[reason] = (invalidSampleReasonCounts[reason] ?? 0) + 1;
      }
      return reason === null;
    });
    const incompleteSampleCount = sampleRows.length - completeSampleRows.length;

    if (completeSampleRows.length === 0) {
      const reason =
        sampleRows.length === 0
          ? "no usable blacklist samples are available; existing rows were preserved"
          : `all ${incompleteSampleCount} blacklist samples were rejected as incomplete or malformed; existing rows were preserved`;
      return {
        status: "skipped",
        reason,
        usableSampleCount: 0,
        bandCount: 0,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        summaryLines: buildSummaryLines({
          usableSampleCount: 0,
          bandCount: 0,
          addedCount: 0,
          updatedCount: 0,
          removedCount: 0,
          status: "skipped",
          reason,
          invalidSampleReasonCounts,
        }),
      };
    }

    const aggregates = new Map<string, BandAggregate>();
    for (const row of completeSampleRows) {
      const band = buildBandRange(row.totalRosterWeight);
      const key = `${band.weightMinInclusive}:${band.weightMaxInclusive}`;
      const aggregate = aggregates.get(key) ?? createEmptyBandAggregate(band);
      aggregate.sampleCount += 1;
      aggregate.uniqueSourceClanTags.add(normalizeTag(row.sourceClanTag));
      aggregate.uniqueOpponentTags.add(normalizeTag(row.opponentBlacklistTag));
      aggregate.totalMissingWeightCount += Math.max(0, Math.trunc(row.missingWeightCount ?? 0));
      aggregate.sumCounts.th18Count += row.th18Count;
      aggregate.sumCounts.th17Count += row.th17Count;
      aggregate.sumCounts.th16Count += row.th16Count;
      aggregate.sumCounts.th15Count += row.th15Count;
      aggregate.sumCounts.th14Count += row.th14Count;
      aggregate.sumCounts.th13Count += row.th13Count;
      aggregate.sumCounts.th12Count += row.th12Count;
      aggregate.sumCounts.th11PlusCount += row.th11PlusCount;
      aggregates.set(key, aggregate);
    }

    const desiredRows = [...aggregates.values()]
      .sort((left, right) => {
        const minDelta = left.weightMinInclusive - right.weightMinInclusive;
        if (minDelta !== 0) return minDelta;
        return left.weightMaxInclusive - right.weightMaxInclusive;
      })
      .map<BlacklistHeatmapRefRow>((aggregate) => {
        const normalizedCounts = buildNormalizedCountsFromAverages({
          sampleCount: aggregate.sampleCount,
          sumCounts: aggregate.sumCounts,
        });
        const confidenceScore = computeConfidenceScore({
          sampleCount: aggregate.sampleCount,
          uniqueSourceClanCount: aggregate.uniqueSourceClanTags.size,
          uniqueOpponentCount: aggregate.uniqueOpponentTags.size,
          totalMissingWeightCount: aggregate.totalMissingWeightCount,
        });
        return {
          weightMinInclusive: aggregate.weightMinInclusive,
          weightMaxInclusive: aggregate.weightMaxInclusive,
          ...normalizedCounts,
          sampleCount: aggregate.sampleCount,
          uniqueSourceClanCount: aggregate.uniqueSourceClanTags.size,
          uniqueOpponentCount: aggregate.uniqueOpponentTags.size,
          totalMissingWeightCount: aggregate.totalMissingWeightCount,
          confidenceLabel: confidenceScoreToLabel(confidenceScore),
          confidenceScore,
          generatedAt,
        };
      });

    const desiredKeySet = new Set(
      desiredRows.map((row) => `${row.weightMinInclusive}:${row.weightMaxInclusive}`),
    );
    const existingRows = await prisma.blacklistHeatMapRef.findMany({
      select: {
        weightMinInclusive: true,
        weightMaxInclusive: true,
      },
    });

    let addedCount = 0;
    let updatedCount = 0;
    for (const row of desiredRows) {
      const existing = existingRows.find(
        (entry) =>
          entry.weightMinInclusive === row.weightMinInclusive &&
          entry.weightMaxInclusive === row.weightMaxInclusive,
      );
      await prisma.blacklistHeatMapRef.upsert({
        where: {
          weightMinInclusive_weightMaxInclusive: {
            weightMinInclusive: row.weightMinInclusive,
            weightMaxInclusive: row.weightMaxInclusive,
          },
        },
        create: row,
        update: {
          th18Count: row.th18Count,
          th17Count: row.th17Count,
          th16Count: row.th16Count,
          th15Count: row.th15Count,
          th14Count: row.th14Count,
          th13Count: row.th13Count,
          th12Count: row.th12Count,
          th11PlusCount: row.th11PlusCount,
          sampleCount: row.sampleCount,
          uniqueSourceClanCount: row.uniqueSourceClanCount,
          uniqueOpponentCount: row.uniqueOpponentCount,
          totalMissingWeightCount: row.totalMissingWeightCount,
          confidenceLabel: row.confidenceLabel,
          confidenceScore: row.confidenceScore,
          generatedAt: row.generatedAt,
        },
      });
      if (existing) {
        updatedCount += 1;
      } else {
        addedCount += 1;
      }
    }

    let removedCount = 0;
    for (const row of existingRows) {
      const key = `${row.weightMinInclusive}:${row.weightMaxInclusive}`;
      if (desiredKeySet.has(key)) continue;
      await prisma.blacklistHeatMapRef.delete({
        where: {
          weightMinInclusive_weightMaxInclusive: {
            weightMinInclusive: row.weightMinInclusive,
            weightMaxInclusive: row.weightMaxInclusive,
          },
        },
      });
      removedCount += 1;
    }

    const status: BlacklistHeatmapRefRebuildResult["status"] =
      desiredRows.length > 0 ? "success" : "noop";
    const baseReason =
      desiredRows.length > 0
        ? null
        : "no blacklist profile bands qualified from the usable samples";
    const reason =
      baseReason ??
      (incompleteSampleCount > 0
        ? `excluded ${incompleteSampleCount} incomplete blacklist sample(s)`
        : null);

    return {
      status,
      reason,
      usableSampleCount: completeSampleRows.length,
      bandCount: desiredRows.length,
      addedCount,
      updatedCount,
      removedCount,
      summaryLines: buildSummaryLines({
        usableSampleCount: completeSampleRows.length,
        bandCount: desiredRows.length,
        addedCount,
        updatedCount,
        removedCount,
        status,
        reason,
        invalidSampleReasonCounts,
      }),
    };
  }
}

export const blacklistHeatmapRefService = new BlacklistHeatmapRefService();
