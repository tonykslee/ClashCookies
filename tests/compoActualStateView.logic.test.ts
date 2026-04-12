import { describe, expect, it } from "vitest";
import type { CompoWarBucketCounts } from "../src/helper/compoWarBucketCounts";
import { projectCompoActualStateView } from "../src/helper/compoActualStateView";

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

function makeHeatMapRef(
  input: Partial<{
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
  }>,
) {
  return {
    weightMinInclusive: input.weightMinInclusive ?? 0,
    weightMaxInclusive: input.weightMaxInclusive ?? 9999999,
    th18Count: input.th18Count ?? 0,
    th17Count: input.th17Count ?? 0,
    th16Count: input.th16Count ?? 0,
    th15Count: input.th15Count ?? 0,
    th14Count: input.th14Count ?? 0,
    th13Count: input.th13Count ?? 0,
    th12Count: input.th12Count ?? 0,
    th11Count: input.th11Count ?? 0,
    th10OrLowerCount: input.th10OrLowerCount ?? 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

describe("projectCompoActualStateView", () => {
  it("keeps Raw Data faithful to resolved totals and unresolved-only missing counts", () => {
    const result = projectCompoActualStateView({
      view: "raw",
      base: {
        resolvedTotalWeight: 435000,
        unresolvedWeightCount: 1,
        memberCount: 49,
        bucketCounts: makeBucketCounts({
          TH18: 1,
          TH14: 1,
          TH12: 1,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 500000,
          th18Count: 1,
          th14Count: 1,
          th12Count: 1,
        }),
      ],
    });

    expect(result.totalWeight).toBe(435000);
    expect(result.missingWeights).toBe(1);
    expect(result.missingTo50Count).toBe(1);
    expect(result.nMissing).toBe(2);
    expect(result.deltaByBucket.TH18).toBe(0);
    expect(result.deltaByBucket.TH14).toBe(0);
    expect(result.deltaByBucket["<=TH13"]).toBe(0);
  });

  it("keeps Auto-Detect Band on the raw band when nothing is missing", () => {
    const result = projectCompoActualStateView({
      view: "auto",
      base: {
        resolvedTotalWeight: 435000,
        unresolvedWeightCount: 0,
        memberCount: 50,
        bucketCounts: makeBucketCounts({
          TH18: 1,
          TH14: 1,
          TH12: 1,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 500000,
          th18Count: 1,
          th14Count: 1,
          th12Count: 1,
        }),
      ],
    });

    expect(result.totalWeight).toBe(435000);
    expect(result.missingWeights).toBe(0);
    expect(result.selectedHeatMapRef?.weightMaxInclusive).toBe(500000);
    expect(result.deviationScore).toBeNull();
  });

  it("lets Auto-Detect Band shift upward when missing slots fill real deficits", () => {
    const result = projectCompoActualStateView({
      view: "auto",
      base: {
        resolvedTotalWeight: 175000,
        unresolvedWeightCount: 0,
        memberCount: 48,
        bucketCounts: makeBucketCounts({
          TH18: 1,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 500000,
          th18Count: 3,
        }),
        makeHeatMapRef({
          weightMinInclusive: 500001,
          weightMaxInclusive: 700000,
          th18Count: 3,
        }),
      ],
    });

    expect(result.totalWeight).toBe(525000);
    expect(result.missingWeights).toBe(2);
    expect(result.selectedHeatMapRef?.weightMinInclusive).toBe(500001);
    expect(result.displayCounts.TH18).toBe(3);
    expect(result.deltaByBucket.TH18).toBe(0);
  });

  it("uses deterministic low-bucket overflow when Auto-Detect has more missing slots than deficits", () => {
    const result = projectCompoActualStateView({
      view: "auto",
      base: {
        resolvedTotalWeight: 900000,
        unresolvedWeightCount: 0,
        memberCount: 44,
        bucketCounts: makeBucketCounts({
          TH18: 1,
          TH17: 1,
          TH16: 1,
          TH15: 1,
          TH14: 1,
          TH13: 1,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 2000000,
          th18Count: 1,
          th17Count: 1,
          th16Count: 1,
          th15Count: 1,
          th14Count: 1,
          th13Count: 1,
        }),
      ],
    });

    expect(result.totalWeight).toBe(1800000);
    expect(result.displayCounts).toEqual({
      TH18: 2,
      TH17: 2,
      TH16: 2,
      TH15: 2,
      TH14: 2,
      "<=TH13": 2,
    });
  });

  it("breaks Auto-Detect oscillation by choosing the band closest to its midpoint", () => {
    const result = projectCompoActualStateView({
      view: "auto",
      base: {
        resolvedTotalWeight: 500000,
        unresolvedWeightCount: 0,
        memberCount: 49,
        bucketCounts: makeBucketCounts(),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 500000,
          weightMaxInclusive: 649999,
          th18Count: 1,
        }),
        makeHeatMapRef({
          weightMinInclusive: 650000,
          weightMaxInclusive: 799999,
          th14Count: 1,
        }),
      ],
    });

    expect(result.selectedHeatMapRef?.weightMinInclusive).toBe(650000);
    expect(result.totalWeight).toBe(635000);
    expect(result.displayCounts.TH14).toBe(1);
  });

  it("uses weighted deviation scoring to choose the best-fit band", () => {
    const result = projectCompoActualStateView({
      view: "best",
      base: {
        resolvedTotalWeight: 175000,
        unresolvedWeightCount: 0,
        memberCount: 49,
        bucketCounts: makeBucketCounts({
          TH18: 1,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 300000,
          th18Count: 2,
        }),
        makeHeatMapRef({
          weightMinInclusive: 300001,
          weightMaxInclusive: 500000,
          th17Count: 1,
        }),
      ],
    });

    expect(result.selectedHeatMapRef?.weightMaxInclusive).toBe(300000);
    expect(result.totalWeight).toBe(350000);
    expect(result.deviationScore).toBe(0);
  });

  it("prefers the higher band when Best Fit ties on score and total distance", () => {
    const result = projectCompoActualStateView({
      view: "best",
      base: {
        resolvedTotalWeight: 0,
        unresolvedWeightCount: 0,
        memberCount: 49,
        bucketCounts: makeBucketCounts(),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 100000,
          th15Count: 1,
        }),
        makeHeatMapRef({
          weightMinInclusive: 100001,
          weightMaxInclusive: 200000,
          th15Count: 1,
        }),
      ],
    });

    expect(result.selectedHeatMapRef?.weightMinInclusive).toBe(100001);
    expect(result.totalWeight).toBe(145000);
    expect(result.deviationScore).toBe(0);
  });
});
