import { describe, expect, it } from "vitest";
import {
  compareEvaluationsForTest,
  evaluateCompoAdvice,
  stepCompoAdviceCustomBandIndexByCount,
  type CompoAdviceEvaluation,
} from "../src/helper/compoAdviceEngine";
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

describe("CompoAdviceEngine", () => {
  it("recommends adding the highest-priority negative bucket when the clan is not full", () => {
    const summary = evaluateCompoAdvice({
      mode: "actual",
      view: "raw",
      base: {
        resolvedTotalWeight: 135000 * 49,
        unresolvedWeightCount: 0,
        memberCount: 49,
        bucketCounts: makeBucketCounts({
          TH14: 49,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 6_000_000,
          weightMaxInclusive: 7_000_000,
          th17Count: 1,
          th14Count: 49,
        }),
      ],
    });

    expect(summary.viewLabel).toBe("Raw Data");
    expect(summary.recommendationText).toBe("Add TH17");
    expect(summary.currentScore).toBe(4);
    expect(summary.resultingScore).toBe(0);
    expect(summary.statusText).toBeNull();
  });

  it("recommends the best swap when the clan is full", () => {
    const summary = evaluateCompoAdvice({
      mode: "actual",
      view: "raw",
      base: {
        resolvedTotalWeight: 48 * 135000 + 2 * 145000,
        unresolvedWeightCount: 0,
        memberCount: 50,
        bucketCounts: makeBucketCounts({
          TH14: 48,
          TH15: 2,
        }),
      },
      heatMapRefs: [
        makeHeatMapRef({
          weightMinInclusive: 6_000_000,
          weightMaxInclusive: 7_000_000,
          th17Count: 1,
          th16Count: 1,
          th15Count: 1,
          th14Count: 47,
        }),
      ],
    });

    expect(summary.recommendationText).toBe("Replace one TH15 with one TH17");
    expect(summary.currentScore).toBe(10);
    expect(summary.resultingScore).toBe(4);
    expect(summary.alternateTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("distinguishes Raw Data, Auto-Detect Band, and Best Fit advice views", () => {
    const base = {
      resolvedTotalWeight: 175000,
      unresolvedWeightCount: 0,
      memberCount: 49,
      bucketCounts: makeBucketCounts({
        TH18: 1,
      }),
    };
    const heatMapRefs = [
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
    ];

    const raw = evaluateCompoAdvice({
      mode: "actual",
      view: "raw",
      base,
      heatMapRefs,
    });
    const auto = evaluateCompoAdvice({
      mode: "actual",
      view: "auto",
      base,
      heatMapRefs,
    });
    const best = evaluateCompoAdvice({
      mode: "actual",
      view: "best",
      base,
      heatMapRefs,
    });

    expect(raw.viewLabel).toBe("Raw Data");
    expect(auto.viewLabel).toBe("Auto-Detect Band");
    expect(best.viewLabel).toBe("Best Fit");
    expect(raw.currentBandLabel).not.toBe(auto.currentBandLabel);
    expect(auto.currentBandLabel).not.toBe(best.currentBandLabel);
  });

  it("changes Custom advice when the target band changes", () => {
    const base = {
      resolvedTotalWeight: 49 * 135000 + 145000,
      unresolvedWeightCount: 0,
      memberCount: 50,
      bucketCounts: makeBucketCounts({
        TH14: 49,
        TH15: 1,
      }),
    };
    const heatMapRefs = [
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 299999,
        th14Count: 50,
      }),
      makeHeatMapRef({
        weightMinInclusive: 300000,
        weightMaxInclusive: 599999,
        th15Count: 50,
      }),
    ];

    const first = evaluateCompoAdvice({
      mode: "actual",
      view: "custom",
      customBandIndex: 0,
      base,
      heatMapRefs,
    });
    const second = evaluateCompoAdvice({
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
      base,
      heatMapRefs,
    });

    expect(first.viewLabel).toBe("Custom");
    expect(second.viewLabel).toBe("Custom");
    expect(first.currentBandLabel).not.toBe(second.currentBandLabel);
    expect(first.recommendationText).not.toBe(second.recommendationText);
    expect(first.currentScore).not.toBe(second.currentScore);
  });

  it("steps Custom band indices deterministically and respects bounds", () => {
    expect(
      stepCompoAdviceCustomBandIndexByCount({
        currentBandIndex: 0,
        bandCount: 2,
        direction: "prev",
      }),
    ).toBe(0);
    expect(
      stepCompoAdviceCustomBandIndexByCount({
        currentBandIndex: 0,
        bandCount: 2,
        direction: "next",
      }),
    ).toBe(1);
    expect(
      stepCompoAdviceCustomBandIndexByCount({
        currentBandIndex: 1,
        bandCount: 2,
        direction: "next",
      }),
    ).toBe(1);
  });

  it("orders equal candidates deterministically by incoming bucket priority", () => {
    const better = {
      action: { kind: "swap", outgoingBucket: "TH14", incomingBucket: "TH17" },
      description: "Replace one TH14 with one TH17",
      beforeProjection: {} as never,
      afterProjection: {} as never,
      currentScore: 5,
      resultingScore: 1,
      scoreImprovement: 4,
      bandFitDistance: 100,
      totalWeightJump: 1000,
      incomingPriority: 1,
      outgoingPriority: 4,
    } as CompoAdviceEvaluation;
    const worse = {
      action: { kind: "swap", outgoingBucket: "TH14", incomingBucket: "TH16" },
      description: "Replace one TH14 with one TH16",
      beforeProjection: {} as never,
      afterProjection: {} as never,
      currentScore: 5,
      resultingScore: 1,
      scoreImprovement: 4,
      bandFitDistance: 100,
      totalWeightJump: 1000,
      incomingPriority: 2,
      outgoingPriority: 4,
    } as CompoAdviceEvaluation;

    expect(compareEvaluationsForTest(better, worse)).toBeLessThan(0);
    expect(compareEvaluationsForTest(worse, better)).toBeGreaterThan(0);
  });
});
