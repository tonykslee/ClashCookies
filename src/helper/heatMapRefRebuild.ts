import type { HeatMapRef } from "@prisma/client";
import { createHash } from "node:crypto";
import { buildCompoWarBucketCounts } from "./compoWarBucketCounts";
import { findHeatMapRefForWeight, getHeatMapRefBandKey } from "./compoHeatMap";

export const HEAT_MAP_REF_REBUILD_TARGET_TOTAL = 50;
export const HEAT_MAP_REF_REBUILD_THRESHOLD = 10;
export const HEAT_MAP_REF_REBUILD_SOURCE_VERSION = "heatmapref-rebuild-v1";
export const HEAT_MAP_REF_REBUILD_DELAY_HOURS = 47;

export type HeatMapRefBucketCounts = {
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11Count: number;
  th10OrLowerCount: number;
};

export type HeatMapRefBandDefinition = Pick<
  HeatMapRef,
  "weightMinInclusive" | "weightMaxInclusive"
>;

export type HeatMapRefRebuildSourceMember = {
  clanTag: string;
  playerTag: string;
  position: number | null;
  townHall: number | null;
  weight: number | null;
  sourceSyncedAt: Date;
};

export type HeatMapRefRebuildSourceRoster = {
  clanTag: string;
  members: HeatMapRefRebuildSourceMember[];
};

export type HeatMapRefRebuildQualifiedRoster = {
  clanTag: string;
  rosterSize: number;
  missingWeightCount: number;
  totalEffectiveWeight: number;
  band: HeatMapRefBandDefinition;
  bucketCounts: HeatMapRefBucketCounts;
};

export type HeatMapRefRebuildExcludedRoster = {
  clanTag: string;
  rosterSize: number;
  missingWeightCount: number;
  reason: string;
};

export type HeatMapRefObservedBandAggregate = {
  band: HeatMapRefBandDefinition;
  sampleCount: number;
  averageBucketCounts: HeatMapRefBucketCounts;
};

export type HeatMapRefRebuildRow = HeatMapRefBandDefinition &
  HeatMapRefBucketCounts & {
    contributingClanCount: number;
    sourceVersion: string | null;
    refreshedAt: Date;
  };

type HeatMapRefBucketName = keyof HeatMapRefBucketCounts;

const HEAT_MAP_REF_BUCKET_ORDER: HeatMapRefBucketName[] = [
  "th18Count",
  "th17Count",
  "th16Count",
  "th15Count",
  "th14Count",
  "th13Count",
  "th12Count",
  "th11Count",
  "th10OrLowerCount",
];

function toPositiveInt(input: number | null | undefined): number | null {
  if (!Number.isFinite(input)) return null;
  const value = Math.trunc(input as number);
  return value > 0 ? value : null;
}

function getEmptyBucketCounts(): HeatMapRefBucketCounts {
  return {
    th18Count: 0,
    th17Count: 0,
    th16Count: 0,
    th15Count: 0,
    th14Count: 0,
    th13Count: 0,
    th12Count: 0,
    th11Count: 0,
    th10OrLowerCount: 0,
  };
}

function addBucketCounts(target: HeatMapRefBucketCounts, source: HeatMapRefBucketCounts): void {
  for (const bucket of HEAT_MAP_REF_BUCKET_ORDER) {
    target[bucket] += source[bucket];
  }
}

function divideBucketCounts(
  counts: HeatMapRefBucketCounts,
  divisor: number,
): HeatMapRefBucketCounts {
  const safeDivisor = divisor > 0 ? divisor : 1;
  return {
    th18Count: counts.th18Count / safeDivisor,
    th17Count: counts.th17Count / safeDivisor,
    th16Count: counts.th16Count / safeDivisor,
    th15Count: counts.th15Count / safeDivisor,
    th14Count: counts.th14Count / safeDivisor,
    th13Count: counts.th13Count / safeDivisor,
    th12Count: counts.th12Count / safeDivisor,
    th11Count: counts.th11Count / safeDivisor,
    th10OrLowerCount: counts.th10OrLowerCount / safeDivisor,
  };
}

function roundBucketCounts(rawCounts: HeatMapRefBucketCounts): HeatMapRefBucketCounts {
  return {
    th18Count: Math.round(rawCounts.th18Count),
    th17Count: Math.round(rawCounts.th17Count),
    th16Count: Math.round(rawCounts.th16Count),
    th15Count: Math.round(rawCounts.th15Count),
    th14Count: Math.round(rawCounts.th14Count),
    th13Count: Math.round(rawCounts.th13Count),
    th12Count: Math.round(rawCounts.th12Count),
    th11Count: Math.round(rawCounts.th11Count),
    th10OrLowerCount: Math.round(rawCounts.th10OrLowerCount),
  };
}

function countTotalBuckets(counts: HeatMapRefBucketCounts): number {
  return HEAT_MAP_REF_BUCKET_ORDER.reduce((sum, bucket) => sum + counts[bucket], 0);
}

function getBucketDeltaFromRawAndRounded(
  rawCounts: HeatMapRefBucketCounts,
  roundedCounts: HeatMapRefBucketCounts,
): Record<HeatMapRefBucketName, number> {
  return {
    th18Count: rawCounts.th18Count - roundedCounts.th18Count,
    th17Count: rawCounts.th17Count - roundedCounts.th17Count,
    th16Count: rawCounts.th16Count - roundedCounts.th16Count,
    th15Count: rawCounts.th15Count - roundedCounts.th15Count,
    th14Count: rawCounts.th14Count - roundedCounts.th14Count,
    th13Count: rawCounts.th13Count - roundedCounts.th13Count,
    th12Count: rawCounts.th12Count - roundedCounts.th12Count,
    th11Count: rawCounts.th11Count - roundedCounts.th11Count,
    th10OrLowerCount: rawCounts.th10OrLowerCount - roundedCounts.th10OrLowerCount,
  };
}

function normalizeRoundedBucketCounts(input: {
  rawCounts: HeatMapRefBucketCounts;
  targetTotal: number;
}): HeatMapRefBucketCounts {
  const counts = roundBucketCounts(input.rawCounts);
  let diff = input.targetTotal - countTotalBuckets(counts);
  if (diff === 0) return counts;

  const deltas = getBucketDeltaFromRawAndRounded(input.rawCounts, counts);
  const orderedBuckets = [...HEAT_MAP_REF_BUCKET_ORDER].sort((left, right) => {
    const leftDelta = deltas[left];
    const rightDelta = deltas[right];
    if (diff > 0) {
      if (rightDelta !== leftDelta) return rightDelta - leftDelta;
    } else if (leftDelta !== rightDelta) {
      return leftDelta - rightDelta;
    }
    return HEAT_MAP_REF_BUCKET_ORDER.indexOf(left) - HEAT_MAP_REF_BUCKET_ORDER.indexOf(right);
  });

  while (diff !== 0) {
    let changed = false;
    for (const bucket of orderedBuckets) {
      if (diff < 0 && counts[bucket] <= 0) {
        continue;
      }
      counts[bucket] += diff > 0 ? 1 : -1;
      diff += diff > 0 ? -1 : 1;
      changed = true;
      if (diff === 0) break;
    }
    if (!changed) {
      break;
    }
  }

  if (countTotalBuckets(counts) !== input.targetTotal) {
    const fallback = { ...counts };
    let fallbackDiff = input.targetTotal - countTotalBuckets(fallback);
    const cycleBuckets = [...HEAT_MAP_REF_BUCKET_ORDER];
    let cursor = 0;
    while (fallbackDiff !== 0 && cycleBuckets.length > 0) {
      const bucket = cycleBuckets[cursor % cycleBuckets.length]!;
      if (fallbackDiff > 0 || fallback[bucket] > 0) {
        fallback[bucket] += fallbackDiff > 0 ? 1 : -1;
        fallbackDiff += fallbackDiff > 0 ? -1 : 1;
      }
      cursor += 1;
      if (cursor > cycleBuckets.length * 8) break;
    }
    return fallback;
  }

  return counts;
}

function toHeatMapRefBucketCountsFromGranularCounts(input: {
  th18: number;
  th17: number;
  th16: number;
  th15: number;
  th14: number;
  th13: number;
  th12: number;
  th11: number;
  th10: number;
  th9: number;
  th8OrLower: number;
}): HeatMapRefBucketCounts {
  return {
    th18Count: input.th18,
    th17Count: input.th17,
    th16Count: input.th16,
    th15Count: input.th15,
    th14Count: input.th14,
    th13Count: input.th13,
    th12Count: input.th12,
    th11Count: input.th11,
    th10OrLowerCount: input.th10 + input.th9 + input.th8OrLower,
  };
}

function normalizeSourceMembers(
  members: readonly HeatMapRefRebuildSourceMember[],
): HeatMapRefRebuildSourceMember[] {
  return [...members]
    .filter((member) => Number.isInteger(member.position) && (member.position ?? 0) > 0)
    .sort((left, right) => {
      const positionDelta = (left.position ?? 0) - (right.position ?? 0);
      if (positionDelta !== 0) return positionDelta;
      return left.playerTag.localeCompare(right.playerTag);
    });
}

function deriveEffectiveWeights(
  members: readonly HeatMapRefRebuildSourceMember[],
): Array<HeatMapRefRebuildSourceMember & { effectiveWeight: number | null }> {
  const normalized = normalizeSourceMembers(members);
  const derived: Array<HeatMapRefRebuildSourceMember & { effectiveWeight: number | null }> = [];
  let index = 0;

  while (index < normalized.length) {
    const current = normalized[index]!;
    const currentWeight = toPositiveInt(current.weight);
    if (currentWeight !== null) {
      derived.push({ ...current, effectiveWeight: currentWeight });
      index += 1;
      continue;
    }

    let zeroBlockEndExclusive = index + 1;
    while (
      zeroBlockEndExclusive < normalized.length &&
      toPositiveInt(normalized[zeroBlockEndExclusive]!.weight) === null
    ) {
      zeroBlockEndExclusive += 1;
    }

    const fillSource = normalized[zeroBlockEndExclusive] ?? null;
    const lowestResolvedWeightAbove = derived.reduce<number | null>((lowest, row) => {
      if (row.effectiveWeight === null || row.effectiveWeight <= 0) {
        return lowest;
      }
      if (lowest === null || row.effectiveWeight < lowest) {
        return row.effectiveWeight;
      }
      return lowest;
    }, null);
    const fillWeight =
      toPositiveInt(fillSource?.weight) ?? lowestResolvedWeightAbove ?? null;

    for (let zeroIndex = index; zeroIndex < zeroBlockEndExclusive; zeroIndex += 1) {
      const row = normalized[zeroIndex]!;
      derived.push({ ...row, effectiveWeight: fillWeight });
    }
    index = zeroBlockEndExclusive;
  }

  return derived;
}

function resolveRosterBucketCounts(
  members: readonly (HeatMapRefRebuildSourceMember & { effectiveWeight: number | null })[],
): HeatMapRefBucketCounts | null {
  const granular = buildCompoWarBucketCounts(
    members.map((member) => ({
      effectiveWeight: member.effectiveWeight,
    })),
  );
  if (!granular) return null;
  return toHeatMapRefBucketCountsFromGranularCounts({
    th18: granular.TH18,
    th17: granular.TH17,
    th16: granular.TH16,
    th15: granular.TH15,
    th14: granular.TH14,
    th13: granular.TH13,
    th12: granular.TH12,
    th11: granular.TH11,
    th10: granular.TH10,
    th9: granular.TH9,
    th8OrLower: granular.TH8_OR_LOWER,
  });
}

export function buildHeatMapRefRebuildRows(input: {
  sourceRosters: readonly HeatMapRefRebuildSourceRoster[];
  seedBands: readonly HeatMapRefBandDefinition[];
  seedRowsByBandKey: ReadonlyMap<string, HeatMapRefBucketCounts>;
  now?: Date;
  threshold?: number;
  sourceVersion?: string;
}): {
  rows: HeatMapRefRebuildRow[];
  qualifyingRosters: HeatMapRefRebuildQualifiedRoster[];
  excludedRosters: HeatMapRefRebuildExcludedRoster[];
} {
  const now = input.now ?? new Date();
  const threshold = Math.max(1, Math.trunc(input.threshold ?? HEAT_MAP_REF_REBUILD_THRESHOLD));
  const qualifyingRosters: HeatMapRefRebuildQualifiedRoster[] = [];
  const excludedRosters: HeatMapRefRebuildExcludedRoster[] = [];

  for (const roster of input.sourceRosters) {
    const members = deriveEffectiveWeights(roster.members);
    const rosterSize = members.length;
    const missingWeightCount = members.filter(
      (member) => toPositiveInt(member.weight) === null,
    ).length;
    if (rosterSize !== HEAT_MAP_REF_REBUILD_TARGET_TOTAL) {
      excludedRosters.push({
        clanTag: roster.clanTag,
        rosterSize,
        missingWeightCount,
        reason: `roster size ${rosterSize}/50`,
      });
      continue;
    }
    if (missingWeightCount > HEAT_MAP_REF_REBUILD_THRESHOLD) {
      excludedRosters.push({
        clanTag: roster.clanTag,
        rosterSize,
        missingWeightCount,
        reason: `missing weights ${missingWeightCount}/50`,
      });
      continue;
    }

    const totalEffectiveWeight = members.reduce(
      (sum, member) => sum + (member.effectiveWeight ?? 0),
      0,
    );
    const band = findHeatMapRefForWeight(
      input.seedBands as HeatMapRef[],
      totalEffectiveWeight,
    );
    if (!band) {
      excludedRosters.push({
        clanTag: roster.clanTag,
        rosterSize,
        missingWeightCount,
        reason: `no HeatMapRef band for total weight ${totalEffectiveWeight}`,
      });
      continue;
    }

    const bucketCounts = resolveRosterBucketCounts(members);
    if (!bucketCounts) {
      excludedRosters.push({
        clanTag: roster.clanTag,
        rosterSize,
        missingWeightCount,
        reason: "unresolved effective weights",
      });
      continue;
    }

    qualifyingRosters.push({
      clanTag: roster.clanTag,
      rosterSize,
      missingWeightCount,
      totalEffectiveWeight,
      band,
      bucketCounts,
    });
  }

  const aggregates = aggregateHeatMapRefObservedBands({
    rosters: qualifyingRosters,
    seedBands: input.seedBands,
  });
  const rows = blendHeatMapRefBandRows({
    aggregates,
    seedBands: input.seedBands,
    seedRowsByBandKey: input.seedRowsByBandKey,
    now,
    sourceVersion: input.sourceVersion ?? HEAT_MAP_REF_REBUILD_SOURCE_VERSION,
    threshold,
  });

  return {
    rows,
    qualifyingRosters,
    excludedRosters,
  };
}

export function aggregateHeatMapRefObservedBands(input: {
  rosters: readonly HeatMapRefRebuildQualifiedRoster[];
  seedBands: readonly HeatMapRefBandDefinition[];
}): HeatMapRefObservedBandAggregate[] {
  const totalsByBandKey = new Map<
    string,
    {
      sampleCount: number;
      bucketCounts: HeatMapRefBucketCounts;
    }
  >();
  for (const band of input.seedBands) {
    totalsByBandKey.set(getHeatMapRefBandKey(band), {
      sampleCount: 0,
      bucketCounts: getEmptyBucketCounts(),
    });
  }

  for (const roster of input.rosters) {
    const key = getHeatMapRefBandKey(roster.band);
    const current = totalsByBandKey.get(key);
    if (!current) continue;
    current.sampleCount += 1;
    addBucketCounts(current.bucketCounts, roster.bucketCounts);
  }

  return input.seedBands.map((band) => {
    const aggregate = totalsByBandKey.get(getHeatMapRefBandKey(band)) ?? {
      sampleCount: 0,
      bucketCounts: getEmptyBucketCounts(),
    };
    return {
      band,
      sampleCount: aggregate.sampleCount,
      averageBucketCounts:
        aggregate.sampleCount > 0
          ? divideBucketCounts(aggregate.bucketCounts, aggregate.sampleCount)
          : getEmptyBucketCounts(),
    };
  });
}

export function blendHeatMapRefBandRows(input: {
  aggregates: readonly HeatMapRefObservedBandAggregate[];
  seedBands: readonly HeatMapRefBandDefinition[];
  seedRowsByBandKey: ReadonlyMap<string, HeatMapRefBucketCounts>;
  now: Date;
  threshold: number;
  sourceVersion: string | null;
}): HeatMapRefRebuildRow[] {
  return input.seedBands.map((band) => {
    const key = getHeatMapRefBandKey(band);
    const seedCounts = input.seedRowsByBandKey.get(key) ?? getEmptyBucketCounts();
    const aggregate =
      input.aggregates.find((entry) => getHeatMapRefBandKey(entry.band) === key) ?? null;
    const observedWeight = Math.min(
      1,
      Math.max(0, (aggregate?.sampleCount ?? 0) / Math.max(1, input.threshold)),
    );
    const seedWeight = 1 - observedWeight;
    const rawCounts: HeatMapRefBucketCounts = {
      th18Count:
        seedCounts.th18Count * seedWeight + (aggregate?.averageBucketCounts.th18Count ?? 0) * observedWeight,
      th17Count:
        seedCounts.th17Count * seedWeight + (aggregate?.averageBucketCounts.th17Count ?? 0) * observedWeight,
      th16Count:
        seedCounts.th16Count * seedWeight + (aggregate?.averageBucketCounts.th16Count ?? 0) * observedWeight,
      th15Count:
        seedCounts.th15Count * seedWeight + (aggregate?.averageBucketCounts.th15Count ?? 0) * observedWeight,
      th14Count:
        seedCounts.th14Count * seedWeight + (aggregate?.averageBucketCounts.th14Count ?? 0) * observedWeight,
      th13Count:
        seedCounts.th13Count * seedWeight + (aggregate?.averageBucketCounts.th13Count ?? 0) * observedWeight,
      th12Count:
        seedCounts.th12Count * seedWeight + (aggregate?.averageBucketCounts.th12Count ?? 0) * observedWeight,
      th11Count:
        seedCounts.th11Count * seedWeight + (aggregate?.averageBucketCounts.th11Count ?? 0) * observedWeight,
      th10OrLowerCount:
        seedCounts.th10OrLowerCount * seedWeight +
        (aggregate?.averageBucketCounts.th10OrLowerCount ?? 0) * observedWeight,
    };
    const normalizedCounts = normalizeRoundedBucketCounts({
      rawCounts,
      targetTotal: HEAT_MAP_REF_REBUILD_TARGET_TOTAL,
    });

    return {
      weightMinInclusive: band.weightMinInclusive,
      weightMaxInclusive: band.weightMaxInclusive,
      ...normalizedCounts,
      contributingClanCount: aggregate?.sampleCount ?? 0,
      sourceVersion: input.sourceVersion,
      refreshedAt: input.now,
    };
  });
}

export function buildHeatMapRefRebuildComparisonRows(
  rows: readonly HeatMapRefRebuildRow[],
): Array<HeatMapRefBandDefinition & HeatMapRefBucketCounts & { contributingClanCount: number }> {
  return [...rows]
    .map((row) => ({
      weightMinInclusive: row.weightMinInclusive,
      weightMaxInclusive: row.weightMaxInclusive,
      th18Count: row.th18Count,
      th17Count: row.th17Count,
      th16Count: row.th16Count,
      th15Count: row.th15Count,
      th14Count: row.th14Count,
      th13Count: row.th13Count,
      th12Count: row.th12Count,
      th11Count: row.th11Count,
      th10OrLowerCount: row.th10OrLowerCount,
      contributingClanCount: row.contributingClanCount,
    }))
    .sort((left, right) => {
      const minDelta = left.weightMinInclusive - right.weightMinInclusive;
      if (minDelta !== 0) return minDelta;
      return left.weightMaxInclusive - right.weightMaxInclusive;
    });
}

export function computeHeatMapRefRebuildContentHash(
  rows: readonly HeatMapRefRebuildRow[],
): string {
  const normalized = buildHeatMapRefRebuildComparisonRows(rows);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function computeHeatMapRefRebuildDueAt(syncEpochSeconds: number): Date {
  return new Date(syncEpochSeconds * 1000 + HEAT_MAP_REF_REBUILD_DELAY_HOURS * 60 * 60 * 1000);
}

export function buildHeatMapRefRebuildCycleKey(input: {
  messageId: string;
  syncEpochSeconds: number;
}): string {
  return `${input.messageId}:${input.syncEpochSeconds}`;
}

export function isHeatMapRefRebuildDue(input: {
  now: Date;
  syncEpochSeconds: number;
}): boolean {
  return input.now.getTime() >= computeHeatMapRefRebuildDueAt(input.syncEpochSeconds).getTime();
}

export function getHeatMapRefSeedRowCountsByBandKey(
  seedRows: readonly HeatMapRefBandDefinition[],
  sourceRows: readonly HeatMapRefBucketCounts[],
): ReadonlyMap<string, HeatMapRefBucketCounts> {
  const rows = new Map<string, HeatMapRefBucketCounts>();
  seedRows.forEach((band, index) => {
    rows.set(getHeatMapRefBandKey(band), sourceRows[index] ?? getEmptyBucketCounts());
  });
  return rows;
}

export const getHeatMapRefBucketCountsForTest = getEmptyBucketCounts;
export const normalizeHeatMapRefRoundedBucketCountsForTest = normalizeRoundedBucketCounts;
export const deriveHeatMapRefEffectiveWeightsForTest = deriveEffectiveWeights;
export const normalizeHeatMapRefSourceMembersForTest = normalizeSourceMembers;
