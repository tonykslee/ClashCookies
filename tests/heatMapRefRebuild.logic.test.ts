import { describe, expect, it } from "vitest";
import {
  aggregateHeatMapRefObservedBands,
  blendHeatMapRefBandRows,
  buildHeatMapRefRebuildComparisonRows,
  buildHeatMapRefRebuildCycleKey,
  buildHeatMapRefRebuildRows,
  computeHeatMapRefRebuildContentHash,
  computeHeatMapRefRebuildDueAt,
  getHeatMapRefBucketCountsForTest,
  isHeatMapRefRebuildDue,
  normalizeHeatMapRefRoundedBucketCountsForTest,
  type HeatMapRefBandDefinition,
  type HeatMapRefBucketCounts,
  type HeatMapRefRebuildQualifiedRoster,
  type HeatMapRefRebuildRow,
  type HeatMapRefRebuildSourceRoster,
} from "../src/helper/heatMapRefRebuild";
import { getHeatMapRefBandKey } from "../src/helper/compoHeatMap";

function makeMember(input: {
  clanTag: string;
  playerTag: string;
  position: number;
  weight: number | null;
  townHall?: number;
}): {
  clanTag: string;
  playerTag: string;
  position: number;
  townHall: number;
  weight: number | null;
  sourceSyncedAt: Date;
} {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    position: input.position,
    townHall: input.townHall ?? 16,
    weight: input.weight,
    sourceSyncedAt: new Date("2026-04-13T00:00:00.000Z"),
  };
}

function makeRoster(input: {
  clanTag: string;
  weights: Array<number | null>;
  townHall?: number;
}): HeatMapRefRebuildSourceRoster {
  return {
    clanTag: input.clanTag,
    members: input.weights.map((weight, index) =>
      makeMember({
        clanTag: input.clanTag,
        playerTag: `#P${String(index + 1).padStart(3, "0")}`,
        position: index + 1,
        weight,
        townHall: input.townHall ?? 16,
      }),
    ),
  };
}

function makeBand(min: number, max: number): HeatMapRefBandDefinition {
  return {
    weightMinInclusive: min,
    weightMaxInclusive: max,
  };
}

function makeCounts(input?: Partial<HeatMapRefBucketCounts>): HeatMapRefBucketCounts {
  return {
    th18Count: input?.th18Count ?? 0,
    th17Count: input?.th17Count ?? 0,
    th16Count: input?.th16Count ?? 0,
    th15Count: input?.th15Count ?? 0,
    th14Count: input?.th14Count ?? 0,
    th13Count: input?.th13Count ?? 0,
    th12Count: input?.th12Count ?? 0,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
  };
}

describe("heatMapRefRebuild helpers", () => {
  it("filters qualifying rosters and excludes oversparse or undersized rosters", () => {
    const band = makeBand(0, 9_999_999);
    const seedRowsByBandKey = new Map([[getHeatMapRefBandKey(band), makeCounts({ th18Count: 50 })]]);
    const sourceRosters: HeatMapRefRebuildSourceRoster[] = [
      makeRoster({
        clanTag: "#GOOD",
        weights: Array.from({ length: 50 }, (_, index) => (index < 11 ? null : 175_000)),
      }),
      makeRoster({
        clanTag: "#SHORT",
        weights: Array.from({ length: 49 }, () => 175_000),
      }),
      makeRoster({
        clanTag: "#KEEP",
        weights: Array.from({ length: 50 }, () => 135_000),
      }),
    ];

    const result = buildHeatMapRefRebuildRows({
      sourceRosters,
      seedBands: [band],
      seedRowsByBandKey,
      now: new Date("2026-04-13T00:00:00.000Z"),
    });

    expect(result.qualifyingRosters).toHaveLength(1);
    expect(result.qualifyingRosters[0]?.clanTag).toBe("#KEEP");
    expect(result.excludedRosters).toHaveLength(2);
    expect(result.excludedRosters.map((row) => row.reason)).toEqual([
      "missing weights 11/50",
      "roster size 49/50",
    ]);
    expect(result.rows[0]?.contributingClanCount).toBe(1);
  });

  it("aggregates observed averages per band and blends them against the seed baseline", () => {
    const band = makeBand(0, 9_999_999);
    const qualified: HeatMapRefRebuildQualifiedRoster[] = [
      {
        clanTag: "#A",
        rosterSize: 50,
        missingWeightCount: 0,
        totalEffectiveWeight: 8_750_000,
        band,
        bucketCounts: makeCounts({ th18Count: 50 }),
      },
      {
        clanTag: "#B",
        rosterSize: 50,
        missingWeightCount: 0,
        totalEffectiveWeight: 6_750_000,
        band,
        bucketCounts: makeCounts({ th14Count: 50 }),
      },
    ];
    const aggregates = aggregateHeatMapRefObservedBands({
      rosters: qualified,
      seedBands: [band],
    });

    expect(aggregates[0]?.sampleCount).toBe(2);
    expect(aggregates[0]?.averageBucketCounts).toMatchObject({
      th18Count: 25,
      th14Count: 25,
    });

    const blended = blendHeatMapRefBandRows({
      aggregates,
      seedBands: [band],
      seedRowsByBandKey: new Map([
        [
          getHeatMapRefBandKey(band),
          makeCounts({
            th18Count: 50,
          }),
        ],
      ]),
      now: new Date("2026-04-13T00:00:00.000Z"),
      threshold: 10,
      sourceVersion: "test-version",
    });

    expect(blended[0]).toMatchObject({
      weightMinInclusive: 0,
      weightMaxInclusive: 9_999_999,
      th18Count: 45,
      th14Count: 5,
      contributingClanCount: 2,
      sourceVersion: "test-version",
    });
    expect(
      (blended[0]?.th18Count ?? 0) +
        (blended[0]?.th17Count ?? 0) +
        (blended[0]?.th16Count ?? 0) +
        (blended[0]?.th15Count ?? 0) +
        (blended[0]?.th14Count ?? 0) +
        (blended[0]?.th13Count ?? 0) +
        (blended[0]?.th12Count ?? 0) +
        (blended[0]?.th11Count ?? 0) +
        (blended[0]?.th10OrLowerCount ?? 0),
    ).toBe(50);
  });

  it("normalizes rounded bucket counts back to exactly 50 and keeps hashes deterministic", () => {
    const normalized = normalizeHeatMapRefRoundedBucketCountsForTest({
      rawCounts: makeCounts({
        th18Count: 10.8,
        th17Count: 20.8,
        th16Count: 19.4,
      }),
      targetTotal: 50,
    });

    expect(
      normalized.th18Count +
        normalized.th17Count +
        normalized.th16Count +
        normalized.th15Count +
        normalized.th14Count +
        normalized.th13Count +
        normalized.th12Count +
        normalized.th11Count +
        normalized.th10OrLowerCount,
    ).toBe(50);
    expect(normalized.th18Count).toBe(10);

    const rows: HeatMapRefRebuildRow[] = [
      {
        weightMinInclusive: 0,
        weightMaxInclusive: 9_999_999,
        ...makeCounts({ th18Count: 50 }),
        contributingClanCount: 0,
        sourceVersion: "first",
        refreshedAt: new Date("2026-04-13T00:00:00.000Z"),
      },
    ];
    const sameRowsDifferentMetadata: HeatMapRefRebuildRow[] = [
      {
        weightMinInclusive: 0,
        weightMaxInclusive: 9_999_999,
        ...makeCounts({ th18Count: 50 }),
        contributingClanCount: 0,
        sourceVersion: "second",
        refreshedAt: new Date("2026-04-14T00:00:00.000Z"),
      },
    ];
    expect(computeHeatMapRefRebuildContentHash(rows)).toBe(
      computeHeatMapRefRebuildContentHash(sameRowsDifferentMetadata),
    );
    expect(computeHeatMapRefRebuildContentHash(rows)).toBe(
      computeHeatMapRefRebuildContentHash([
        ...sameRowsDifferentMetadata,
      ]),
    );
    expect(buildHeatMapRefRebuildComparisonRows(rows)).toEqual(
      buildHeatMapRefRebuildComparisonRows(sameRowsDifferentMetadata),
    );
  });

  it("computes cycle due timing at 47 hours after sync time", () => {
    const syncEpochSeconds = Math.floor(new Date("2026-04-13T00:00:00.000Z").getTime() / 1000);
    const dueAt = computeHeatMapRefRebuildDueAt(syncEpochSeconds);
    expect(dueAt.toISOString()).toBe("2026-04-14T23:00:00.000Z");
    expect(isHeatMapRefRebuildDue({ now: new Date("2026-04-14T22:59:59.000Z"), syncEpochSeconds })).toBe(false);
    expect(isHeatMapRefRebuildDue({ now: dueAt, syncEpochSeconds })).toBe(true);
    expect(
      buildHeatMapRefRebuildCycleKey({
        messageId: "123456789012345678",
        syncEpochSeconds,
      }),
    ).toBe("123456789012345678:1776038400");
  });
});
