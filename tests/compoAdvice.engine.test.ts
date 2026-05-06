import { describe, expect, it } from "vitest";
import {
  compareEvaluationsForTest,
  buildCompoAdviceContentLinesForTest,
  evaluateCompoAdvice,
  formatFullWeightForTest,
  formatMatchratePercentForTest,
  estimateMatchrateFromDeviationForTest,
  formatSignedCompoAdviceDeltaForTest,
  resolveAdviceTargetBandMidpointForTest,
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
      resolvedTotalWeight: 350_000,
      unresolvedWeightCount: 0,
      memberCount: 50,
      bucketCounts: makeBucketCounts({
        TH15: 50,
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
    const bandMatchRatesByBandKey = new Map([
      ["0-299999", 0.7025],
      ["300000-599999", 0.7412],
    ]);

    const first = evaluateCompoAdvice({
      mode: "actual",
      view: "custom",
      customBandIndex: 0,
      base,
      heatMapRefs,
      bandMatchRatesByBandKey,
    });
    const second = evaluateCompoAdvice({
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
      base,
      heatMapRefs,
      bandMatchRatesByBandKey,
    });

    expect(first.viewLabel).toBe("Custom");
    expect(second.viewLabel).toBe("Custom");
    expect(first.currentBandLabel).toBe(second.currentBandLabel);
    expect(first.currentBandLabel).not.toBe("(no band)");
    expect(first.targetBandLabel).not.toBe(second.targetBandLabel);
    expect(first.currentMatchrate).toBeCloseTo(second.currentMatchrate ?? 0, 6);
    expect(first.targetBandMatchrate).not.toBe(second.targetBandMatchrate);
    expect(first.resultingMatchrate).not.toBe(second.resultingMatchrate);
    expect(first.recommendationText).not.toBe(second.recommendationText);
    expect(first.currentScore).toBe(second.currentScore);
    expect(first.currentScore).not.toBeNull();
  });

  it("computes midpoint advice using middle-band arithmetic and end-band offsets", () => {
    const refs = [
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 99_999,
      }),
      makeHeatMapRef({
        weightMinInclusive: 1_000_000,
        weightMaxInclusive: 1_199_998,
      }),
      makeHeatMapRef({
        weightMinInclusive: 2_000_000,
        weightMaxInclusive: 2_099_999,
      }),
    ];

    expect(
      resolveAdviceTargetBandMidpointForTest({
        heatMapRefs: refs,
        selectedHeatMapRef: refs[1] ?? null,
      }),
    ).toBe(1_099_999);
    expect(
      resolveAdviceTargetBandMidpointForTest({
        heatMapRefs: refs,
        selectedHeatMapRef: refs[0] ?? null,
      }),
    ).toBe(49_999);
    expect(
      resolveAdviceTargetBandMidpointForTest({
        heatMapRefs: refs,
        selectedHeatMapRef: refs[2] ?? null,
      }),
    ).toBe(2_050_000);
  });

  it("formats current weight and midpoint distances for advice summaries", () => {
    expect(formatFullWeightForTest(7_245_000)).toBe("7,245,000");
    expect(formatFullWeightForTest(null)).toBe("unknown");
    expect(formatSignedCompoAdviceDeltaForTest(125_000)).toBe(":small_red_triangle: +125k");
    expect(formatSignedCompoAdviceDeltaForTest(-80_000)).toBe(":small_red_triangle_down: -80k");
    expect(formatSignedCompoAdviceDeltaForTest(0)).toBe("-> +0");
    expect(formatSignedCompoAdviceDeltaForTest(null)).toBe("unknown");
  });

  it("formats and estimates matchrates using the shared compo advice helper", () => {
    expect(formatMatchratePercentForTest(0.7214)).toBe("72.14%");
    expect(formatMatchratePercentForTest(72.14)).toBe("72.14%");
    expect(formatMatchratePercentForTest(null)).toBe("Unknown");
    const currentMatchrate = estimateMatchrateFromDeviationForTest({
      bandMatchrate: 0.7214,
      deviationScore: 23,
    });
    const resultingMatchrate = estimateMatchrateFromDeviationForTest({
      bandMatchrate: 0.7214,
      deviationScore: 15,
    });
    expect(currentMatchrate).toBeCloseTo(0.68, 4);
    expect(resultingMatchrate).toBeCloseTo(0.6944, 4);
    expect(resultingMatchrate).toBeGreaterThan(currentMatchrate ?? 0);
    expect(resultingMatchrate).not.toBe(currentMatchrate);
    expect(
      estimateMatchrateFromDeviationForTest({
        bandMatchrate: 0.7214,
        deviationScore: 0,
      }),
    ).toBe(0.7214);
    expect(
      estimateMatchrateFromDeviationForTest({
        bandMatchrate: 0.7214,
        deviationScore: 32.5,
      }),
    ).toBeCloseTo(0.6629, 4);
    expect(
      estimateMatchrateFromDeviationForTest({
        bandMatchrate: null,
        deviationScore: 32.5,
      }),
    ).toBeNull();
  });

  it("renders unknown fallback lines when current weight or midpoint is missing", () => {
    const lines = buildCompoAdviceContentLinesForTest({
      modeLabel: "ACTUAL",
      refreshLine: null,
      summary: {
        viewLabel: "Raw Data",
        currentScore: null,
        currentBandLabel: "(no band)",
        targetBandLabel: "(no band)",
        currentProjection: {
          view: "raw",
          totalWeight: NaN,
          missingWeights: 0,
          unresolvedWeightCount: 0,
          missingTo50Count: 0,
          selectedHeatMapRef: null,
        } as any,
        heatMapRefs: [],
        bandMatchRatesByBandKey: new Map(),
        currentMatchrate: null,
        targetBandMatchrate: null,
        resultingMatchrate: null,
        currentWeight: null,
        resolvedRosterWeight: null,
        targetBandMidpoint: null,
        targetHeatMapRef: null,
        recommendationText: "No improvement found.",
        resultingScore: null,
        resultingBandLabel: "(no band)",
        alternateTexts: [],
        statusText: null,
      } as any,
    });

    expect(lines).toContain("Resolved roster weight: unknown");
    expect(lines).toContain("Scoring basis: resolved roster");
    expect(lines).toContain("Unresolved weights: 0");
    expect(lines).toContain("Missing-to-50 fills: 0");
    expect(lines).toContain("Displayed missing weights: 0");
    expect(lines).toContain("Band midpoint: unknown");
    expect(lines).toContain("Target band source: resolved roster total");
    expect(lines).toContain("Matchrate: Unknown");
  });

  it("shows raw ACTUAL roster deficits before projected planning when the roster is underfilled", () => {
    const lines = buildCompoAdviceContentLinesForTest({
      modeLabel: "ACTUAL",
      refreshLine: null,
      clanTag: "#2QVGPQP0U",
      summary: {
        mode: "actual",
        view: "raw",
        viewLabel: "Raw Data",
        currentScore: 17.5,
        currentBandLabel: "0 - 7,200,000",
        targetBandLabel: "0 - 7,200,000",
        currentProjection: {
          view: "raw",
          totalWeight: 2_439_000,
          missingWeights: 16,
          unresolvedWeightCount: 16,
          missingTo50Count: 17,
          memberCount: 33,
          selectedHeatMapRef: makeHeatMapRef({
            weightMinInclusive: 0,
            weightMaxInclusive: 7_200_000,
            th18Count: 6,
            th17Count: 5,
            th16Count: 6,
            th15Count: 8,
            th14Count: 8,
            th13Count: 7,
            th12Count: 5,
            th11Count: 3,
            th10OrLowerCount: 2,
          }),
          deltaByBucket: {
            TH18: -3,
            TH17: -4,
            TH16: -4,
            TH15: -5,
            TH14: -6,
            "<=TH13": -11,
          },
        } as any,
        projectedProjection: {
          view: "auto",
          totalWeight: 6_986_085,
          missingWeights: 33,
          unresolvedWeightCount: 16,
          missingTo50Count: 17,
          memberCount: 33,
          selectedHeatMapRef: makeHeatMapRef({
            weightMinInclusive: 0,
            weightMaxInclusive: 7_200_000,
            th18Count: 6,
            th17Count: 5,
            th16Count: 6,
            th15Count: 8,
            th14Count: 8,
            th13Count: 7,
            th12Count: 5,
            th11Count: 3,
            th10OrLowerCount: 2,
          }),
          deltaByBucket: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 0,
            "<=TH13": 0,
          },
        } as any,
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 0,
            weightMaxInclusive: 7_200_000,
            th18Count: 6,
            th17Count: 5,
            th16Count: 6,
            th15Count: 8,
            th14Count: 8,
            th13Count: 7,
            th12Count: 5,
            th11Count: 3,
            th10OrLowerCount: 2,
          }),
        ],
        bandMatchRatesByBandKey: new Map([["0-7200000", 0.4]]),
        currentMatchrate: 0.35,
        targetBandMatchrate: 0.4,
        resultingMatchrate: 0.4,
        currentWeight: 2_439_000,
        resolvedRosterWeight: 2_439_000,
        targetBandMidpoint: 3_600_000,
        targetHeatMapRef: makeHeatMapRef({
          weightMinInclusive: 0,
          weightMaxInclusive: 7_200_000,
          th18Count: 6,
          th17Count: 5,
          th16Count: 6,
          th15Count: 8,
          th14Count: 8,
          th13Count: 7,
          th12Count: 5,
          th11Count: 3,
          th10OrLowerCount: 2,
        }),
        recommendationText: "Add TH18",
        resultingScore: 0,
        resultingBandLabel: "0 - 7,200,000",
        alternateTexts: [],
        statusText: "Projected planning is shown separately below.",
        selectedCustomBandIndex: 0,
        customBandCount: 1,
      } as any,
    });

    expect(lines).toContain("Raw roster deficits:");
    expect(lines).toContain("TH18: -3");
    expect(lines).toContain("TH17: -4");
    expect(lines).toContain("TH16: -4");
    expect(lines).toContain("TH15: -5");
    expect(lines).toContain("TH14: -6");
    expect(lines).toContain("<=TH13: -11");
    expect(lines).toContain("Projected planning is shown separately below.");
  });

  it("renders current, target, and adjacent matchrate lines from band rates and deviation penalties", () => {
    const refs = [
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 999_999 }),
      makeHeatMapRef({ weightMinInclusive: 1_000_000, weightMaxInclusive: 2_000_000 }),
      makeHeatMapRef({ weightMinInclusive: 2_000_001, weightMaxInclusive: 3_000_000 }),
    ];
    const lines = buildCompoAdviceContentLinesForTest({
      modeLabel: "ACTUAL",
      refreshLine: null,
      clanTag: "#AAA111",
      summary: {
        viewLabel: "Auto-Detect Band",
        currentScore: 32.5,
        currentBandLabel: "1,000,000 - 2,000,000",
        targetBandLabel: "1,000,000 - 2,000,000",
        currentProjection: {
          view: "auto",
          totalWeight: 1_500_000,
          missingWeights: 2,
          unresolvedWeightCount: 1,
          missingTo50Count: 1,
          selectedHeatMapRef: refs[1],
        } as any,
        heatMapRefs: refs,
        bandMatchRatesByBandKey: new Map([
          ["0-999999", 0.7],
          ["1000000-2000000", 0.7214],
          ["2000001-3000000", 0.74],
        ]),
        currentMatchrate: 0.6629,
        targetBandMatchrate: 0.7214,
        resultingMatchrate: 0.6989,
        currentWeight: 1_500_000,
        resolvedRosterWeight: 1_250_000,
        targetBandMidpoint: 1_500_000,
        targetHeatMapRef: refs[1],
        recommendationText: "Add TH17",
        resultingScore: 12.5,
        resultingBandLabel: "1,000,000 - 2,000,000",
        alternateTexts: [],
        statusText: null,
      } as any,
    });

    expect(lines).toContain("Current Deviation Score: **32.5**");
    expect(lines).toContain(
      "Displayed missing weights: 2 [FWA Stats](https://fwastats.com/Clan/AAA111/Weight)",
    );
    expect(lines).toContain("Resolved roster weight: 1,250,000");
    expect(lines).toContain("Projected 50-player weight: 1,500,000");
    expect(lines).toContain("Scoring basis: projected 50-player roster");
    expect(lines).toContain("Unresolved weights: 1");
    expect(lines).toContain("Missing-to-50 fills: 1");
    expect(lines).toContain("Matchrate: 66.29%");
    expect(lines).toContain("Band matchrate: 72.14%");
    expect(lines).toContain("Band midpoint: +0");
    expect(lines).toContain("Target band source: projected total");
    expect(lines).toContain("Deviation Score: **12.5**");
    expect(lines).toContain("Matchrate: 69.89%");
    expect(lines).toContain("Lower band: **0 - 999,999**");
    expect(lines).toContain("Higher band: **2,000,001 - 3,000,000**");
    expect(lines).toContain("Matchrate: 70.00%");
    expect(lines).toContain("Matchrate: 74.00%");
  });

  it("prefixes the midpoint line with a warning when the current weight is outside the selected band", () => {
    const lines = buildCompoAdviceContentLinesForTest({
      modeLabel: "ACTUAL",
      refreshLine: null,
      clanTag: "#AAA111",
      summary: {
        view: "custom",
        viewLabel: "Custom",
        currentScore: 5,
        currentBandLabel: "1,000,000 - 1,499,999",
        targetBandLabel: "2,000,000 - 2,500,000",
        currentProjection: {
          view: "raw",
          totalWeight: 1_500_000,
          missingWeights: 1,
          unresolvedWeightCount: 1,
          missingTo50Count: 0,
          selectedHeatMapRef: makeHeatMapRef({
            weightMinInclusive: 1_000_000,
            weightMaxInclusive: 1_499_999,
          }),
        } as any,
        heatMapRefs: [
          makeHeatMapRef({ weightMinInclusive: 1_000_000, weightMaxInclusive: 1_499_999 }),
          makeHeatMapRef({ weightMinInclusive: 2_000_000, weightMaxInclusive: 2_500_000 }),
        ],
        bandMatchRatesByBandKey: new Map([
          ["1000000-1499999", 0.72],
          ["2000000-2500000", 0.6],
        ]),
        currentMatchrate: 0.7,
        targetBandMatchrate: 0.6,
        resultingMatchrate: 0.59,
        currentWeight: 1_500_000,
        resolvedRosterWeight: 1_500_000,
        targetBandMidpoint: 1_420_000,
        targetHeatMapRef: makeHeatMapRef({
          weightMinInclusive: 2_000_000,
          weightMaxInclusive: 2_500_000,
        }),
        recommendationText: "Add TH17",
        resultingScore: 4,
        resultingBandLabel: "2,000,000 - 2,500,000",
        alternateTexts: [],
        statusText: null,
      } as any,
    });

    expect(lines).toContain("Band midpoint: :warning: -80k");
    expect(lines).toContain("Target band source: custom-selected band");
    expect(lines.join("\n")).not.toContain(":small_red_triangle");
    expect(lines.join("\n")).not.toContain(":small_red_triangle_down");
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
