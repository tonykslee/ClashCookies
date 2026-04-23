import { describe, expect, it } from "vitest";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";
import { findHeatMapRefForWeight } from "../src/helper/compoHeatMap";
import { validateHeatMapRefContinuity } from "../src/helper/heatMapRefContinuity";
import { projectCompoActualStateView } from "../src/helper/compoActualStateView";
import type { CompoWarBucketCounts } from "../src/helper/compoWarBucketCounts";

function makeBucketCounts(
  partial?: Partial<CompoWarBucketCounts>,
): CompoWarBucketCounts {
  return {
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
    ...partial,
  };
}

function makeHeatMapRef(input: Partial<{
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11Count: number;
  th10OrLowerCount: number;
}>) {
  return {
    weightMinInclusive: input.weightMinInclusive ?? 0,
    weightMaxInclusive: input.weightMaxInclusive ?? 9_999_999,
    th18Count: input.th18Count ?? 0,
    th17Count: input.th17Count ?? 0,
    th16Count: input.th16Count ?? 0,
    th15Count: input.th15Count ?? 0,
    th14Count: input.th14Count ?? 0,
    th13Count: input.th13Count ?? 0,
    th12Count: input.th12Count ?? 0,
    th11Count: input.th11Count ?? 0,
    th10OrLowerCount: input.th10OrLowerCount ?? 0,
    contributingClanCount: 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

describe("HeatMapRef continuity", () => {
  it("reports the Rocky Road-style missing span for gapped bands", () => {
    const validation = validateHeatMapRefContinuity([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 7_200_000,
      }),
      makeHeatMapRef({
        weightMinInclusive: 8_110_000,
        weightMaxInclusive: 9_999_999,
      }),
    ]);

    expect(validation.hasContinuousCoverage).toBe(false);
    expect(validation.firstGap).toEqual({
      previousBandKey: "0-7200000",
      nextBandKey: "8110000-9999999",
      startInclusive: 7_200_001,
      endInclusive: 8_109_999,
    });
    expect(validation.firstOverlap).toBeNull();
    expect(validation.duplicateBandKeys).toEqual([]);
  });

  it("treats the corrected bootstrap bands as continuous and resolves 8109000", () => {
    const validation = validateHeatMapRefContinuity(HEAT_MAP_REF_SEED_ROWS);
    const resolvedBand = findHeatMapRefForWeight(HEAT_MAP_REF_SEED_ROWS, 8_109_000);

    expect(validation.hasContinuousCoverage).toBe(true);
    expect(validation.firstGap).toBeNull();
    expect(validation.firstOverlap).toBeNull();
    expect(validation.duplicateBandKeys).toEqual([]);
    expect(resolvedBand).toMatchObject({
      weightMinInclusive: 8_100_001,
      weightMaxInclusive: 8_109_999,
    });
  });

  it("keeps Rocky Road-style ACTUAL projections on a valid band when coverage is continuous", () => {
    const result = projectCompoActualStateView({
      view: "raw",
      base: {
        resolvedTotalWeight: 8_109_000,
        unresolvedWeightCount: 0,
        memberCount: 50,
        bucketCounts: makeBucketCounts({
          TH18: 20,
          TH17: 10,
          TH16: 8,
          TH15: 6,
          TH14: 4,
          TH13: 2,
          TH12: 1,
        }),
      },
      heatMapRefs: HEAT_MAP_REF_SEED_ROWS,
    });

    expect(result.selectedHeatMapRef).not.toBeNull();
    expect(result.deltaByBucket.TH18).not.toBeNull();
    expect(result.deltaByBucket.TH17).not.toBeNull();
    expect(result.deltaByBucket.TH16).not.toBeNull();
  });
});
