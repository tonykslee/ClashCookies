import { describe, expect, it } from "vitest";
import { readPlacementCandidatesForTest } from "../src/commands/Compo";

function blankRows(count: number, cols: number): string[][] {
  return Array.from({ length: count }, () => Array.from({ length: cols }, () => ""));
}

describe("/compo place candidate parsing", () => {
  it("detects delta headers when the right-block header row is not the first row", () => {
    const clanCol = [["Clan"], ["Red Riders"], ...blankRows(7, 1)];
    const totalCol = [["TotalWeight"], ["1,500,000"], ...blankRows(7, 1)];
    const targetBandCol = [["Target"], ["1,520,000"], ...blankRows(7, 1)];
    const rightBlock = [
      ["", "", "", "", "", "", ""],
      [
        "Missing Weights",
        "TH18-delta",
        "TH17-delta",
        "TH16-delta",
        "TH15-delta",
        "TH14-delta",
        "<=TH13-delta",
      ],
      ["0", "0", "-1", "-2", "0", "0", "-3"],
      ...blankRows(6, 7),
    ];

    const candidates = readPlacementCandidatesForTest(
      clanCol,
      totalCol,
      targetBandCol,
      rightBlock
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].missingCount).toBe(0);
    expect(candidates[0].bucketDeltaByHeader["th16-delta"]).toBe(-2);
    expect(candidates[0].bucketDeltaByHeader["<=th13-delta"]).toBe(-3);
  });

  it("keeps existing behavior when headers are already on the first row", () => {
    const clanCol = [["Clan"], ["Zero Gravity"], ...blankRows(7, 1)];
    const totalCol = [["TotalWeight"], ["1,430,000"], ...blankRows(7, 1)];
    const targetBandCol = [["Target"], ["1,470,000"], ...blankRows(7, 1)];
    const rightBlock = [
      [
        "Missing Weights",
        "TH18-delta",
        "TH17-delta",
        "TH16-delta",
        "TH15-delta",
        "TH14-delta",
        "<=TH13-delta",
      ],
      ["2", "0", "0", "-1", "-2", "0", "0"],
      ...blankRows(7, 7),
    ];

    const candidates = readPlacementCandidatesForTest(
      clanCol,
      totalCol,
      targetBandCol,
      rightBlock
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].missingCount).toBe(2);
    expect(candidates[0].bucketDeltaByHeader["th16-delta"]).toBe(-1);
    expect(candidates[0].bucketDeltaByHeader["th15-delta"]).toBe(-2);
  });
});

