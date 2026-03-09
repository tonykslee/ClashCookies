import { describe, expect, it } from "vitest";
import {
  buildCompoPlaceEmbedForTest,
  readPlacementCandidatesForTest,
} from "../src/commands/Compo";

function blankRows(count: number, cols: number): string[][] {
  return Array.from({ length: count }, () => Array.from({ length: cols }, () => ""));
}

describe("/compo place candidate parsing", () => {
  it("detects delta headers when the right-block header row is not the first row", () => {
    const clanCol = [["Clan"], ["Red Riders"], ...blankRows(7, 1)];
    const clanTagCol = [["Clan Tag"], ["#R8R8"], ...blankRows(7, 1)];
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
      clanTagCol,
      totalCol,
      targetBandCol,
      rightBlock
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].clanTag).toBe("R8R8");
    expect(candidates[0].missingCount).toBe(0);
    expect(candidates[0].bucketDeltaByHeader["th16-delta"]).toBe(-2);
    expect(candidates[0].bucketDeltaByHeader["<=th13-delta"]).toBe(-3);
  });

  it("keeps existing behavior when headers are already on the first row", () => {
    const clanCol = [["Clan"], ["Zero Gravity"], ...blankRows(7, 1)];
    const clanTagCol = [["Clan Tag"], ["#ZG99"], ...blankRows(7, 1)];
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
      clanTagCol,
      totalCol,
      targetBandCol,
      rightBlock
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].missingCount).toBe(2);
    expect(candidates[0].bucketDeltaByHeader["th16-delta"]).toBe(-1);
    expect(candidates[0].bucketDeltaByHeader["th15-delta"]).toBe(-2);
  });

  it("builds an embed with recommended, vacancy, and composition sections", () => {
    const embed = buildCompoPlaceEmbedForTest({
      inputWeight: 151000,
      bucket: "TH16",
      recommended: [
        {
          clanName: "Red Riders",
          clanTag: "R8R8",
          totalWeight: 0,
          targetBand: 0,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 47,
          vacancySlots: 3,
          hasVacancy: true,
          delta: -2,
        },
      ],
      vacancyList: [
        {
          clanName: "Zero Gravity",
          clanTag: "ZG99",
          totalWeight: 0,
          targetBand: 0,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 47,
          vacancySlots: 3,
          hasVacancy: true,
        },
      ],
      compositionList: [
        {
          clanName: "The Winners Club",
          clanTag: "TWC1",
          totalWeight: 0,
          targetBand: 0,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 50,
          vacancySlots: 0,
          hasVacancy: false,
          delta: -4,
        },
      ],
      refreshLine: "RAW Data last refreshed: (not available)",
    }).toJSON();

    expect(embed.title).toBe("Compo Placement Suggestions");
    expect(embed.description).toContain("Weight: **151,000**");
    expect(embed.description).toContain("Bucket: **TH16**");
    expect(embed.fields?.map((f) => f.name)).toEqual([
      "Recommended",
      "Vacancy",
      "Composition",
    ]);
    expect(embed.fields?.[0]?.value).toContain("Red Riders");
    expect(embed.fields?.[0]?.value).toContain("needs 2 TH16");
    expect(embed.fields?.[1]?.value).toContain("ZG");
    expect(embed.fields?.[1]?.value).toContain("47/50");
    expect(embed.fields?.[2]?.value).toContain("The Winners Club");
    expect(embed.fields?.[2]?.value).toContain("-4");
  });
});

