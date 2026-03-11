import { describe, expect, it } from "vitest";
import {
  buildCompoPlaceEmbedForTest,
  buildCompoStateRowsForTest,
  getAbsoluteSheetRowNumberForTest,
  getModeRowsForTest,
  readPlacementCandidatesForTest,
} from "../src/commands/Compo";

function blankRows(count: number, cols = 56): string[][] {
  return Array.from({ length: count }, () => Array.from({ length: cols }, () => ""));
}

function makeRow(cells: Record<number, string>, cols = 56): string[] {
  const row = Array.from({ length: cols }, () => "");
  for (const [col, value] of Object.entries(cells)) {
    row[Number(col)] = value;
  }
  return row;
}

describe("/compo place candidate parsing", () => {
  it("maps fixed-range indexes to absolute sheet rows and selects ACTUAL rows from layout", () => {
    expect(getAbsoluteSheetRowNumberForTest(0)).toBe(6);
    expect(getAbsoluteSheetRowNumberForTest(1)).toBe(7);
    expect(getAbsoluteSheetRowNumberForTest(4)).toBe(10);

    const rows = blankRows(7).map((row, index) => {
      row[0] = `row-${getAbsoluteSheetRowNumberForTest(index)}`;
      return row;
    });

    const actualRows = getModeRowsForTest(rows, "actual");
    const warRows = getModeRowsForTest(rows, "war");

    expect(actualRows.map((entry) => entry.sheetRowNumber)).toEqual([7, 10]);
    expect(actualRows.map((entry) => entry.row[0])).toEqual(["row-7", "row-10"]);
    expect(warRows.map((entry) => entry.sheetRowNumber)).toEqual([8, 11]);
  });

  it("builds ACTUAL placement candidates only from ACTUAL rows and prevents duplicate clans", () => {
    const rows = blankRows(8);
    rows[1] = makeRow({
      0: "RISING DAWN",
      1: "#RD111",
      3: "1,500,000",
      20: "2",
      21: "0",
      22: "0",
      23: "-1",
      24: "-2",
      25: "0",
      26: "0",
      48: "1,520,000",
      55: "WAR",
    });
    rows[2] = makeRow({
      0: "RISING DAWN-war",
      1: "#RDWAR",
      3: "1,490,000",
      20: "3",
      23: "-9",
      48: "1,520,000",
      55: "ACTUAL",
    });
    rows[4] = makeRow({
      0: "RISING DAWN",
      1: "#RD111",
      3: "1,510,000",
      20: "5",
      23: "-7",
      48: "1,520,000",
    });
    rows[7] = makeRow({
      0: "DARK EMPIRE\u2122!-actual",
      1: "#DE222",
      3: "1,470,000",
      20: "1",
      24: "-3",
      48: "1,500,000",
    });

    const actualRows = getModeRowsForTest(rows, "actual");
    const candidates = readPlacementCandidatesForTest(actualRows);

    expect(actualRows.map((entry) => entry.sheetRowNumber)).toEqual([7, 10, 13]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.clanTag)).toEqual(["RD111", "DE222"]);
    expect(candidates.map((candidate) => candidate.clanName)).not.toContain("RISING DAWN-war");

    const rd = candidates.find((candidate) => candidate.clanTag === "RD111");
    expect(rd).toBeDefined();
    expect(rd?.missingCount).toBe(2);
    expect(rd?.bucketDeltaByHeader["th16-delta"]).toBe(-1);
    expect(rd?.bucketDeltaByHeader["th15-delta"]).toBe(-2);

    const uniqueTags = new Set(candidates.map((candidate) => candidate.clanTag));
    expect(uniqueTags.size).toBe(candidates.length);
  });

  it("builds an embed with recommended, vacancy, and composition sections", () => {
    const embed = buildCompoPlaceEmbedForTest({
      inputWeight: 151000,
      bucket: "TH16",
      recommended: [
        {
          clanName: "Red Riders-actual",
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
          clanName: "Zero Gravity-actual",
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
          clanName: "The Winners Club-actual",
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
    expect(embed.fields?.[0]?.value).not.toContain("-actual");
    expect(embed.fields?.[0]?.value).toContain("needs 2 TH16");
    expect(embed.fields?.[1]?.value).toContain("ZG");
    expect(embed.fields?.[1]?.value).toContain("47/50");
    expect(embed.fields?.[2]?.value).toContain("The Winners Club");
    expect(embed.fields?.[2]?.value).not.toContain("-actual");
    expect(embed.fields?.[2]?.value).toContain("-4");
  });

  it("sanitizes clan names in state table rows for display-only rendering", () => {
    const modeRows = [
      {
        row: makeRow({
          0: "Dark Empire-actual",
          3: "1,470,000",
          20: "1",
          21: "0",
          22: "0",
          23: "-1",
          24: "0",
          25: "0",
          26: "0",
        }),
        sheetRowNumber: 7,
      },
    ];

    const stateRows = buildCompoStateRowsForTest(modeRows);
    expect(stateRows[0][0]).toBe("Clan");
    expect(stateRows[1][0]).toBe("Dark Empire");
    expect(stateRows[1][0]).not.toContain("-actual");
  });

  it("omits blank fixed-grid slots and keeps clan row order in /compo state output", () => {
    const modeRows = [
      {
        row: makeRow({
          0: "Alpha Clan-actual",
          3: "1,500,000",
          20: "2",
          21: "1",
          22: "0",
          23: "0",
          24: "-1",
          25: "0",
          26: "0",
        }),
        sheetRowNumber: 7,
      },
      {
        row: makeRow({
          0: "",
          3: "1,490,000",
          20: "5",
          21: "0",
          22: "0",
          23: "-3",
          24: "0",
          25: "0",
          26: "0",
        }),
        sheetRowNumber: 10,
      },
      {
        row: makeRow({
          0: "Bravo Clan",
          3: "1,480,000",
          20: "1",
          21: "0",
          22: "1",
          23: "0",
          24: "0",
          25: "-1",
          26: "0",
        }),
        sheetRowNumber: 13,
      },
      {
        row: makeRow({
          0: "   ",
          3: "1,470,000",
          20: "4",
          21: "0",
          22: "0",
          23: "0",
          24: "0",
          25: "0",
          26: "-4",
        }),
        sheetRowNumber: 16,
      },
    ];

    const stateRows = buildCompoStateRowsForTest(modeRows);

    expect(stateRows).toHaveLength(3);
    expect(stateRows[0]).toEqual(["Clan", "Total", "Missing", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"]);
    expect(stateRows[1][0]).toBe("Alpha Clan");
    expect(stateRows[1][1]).toBe("1,500,000");
    expect(stateRows[2][0]).toBe("Bravo Clan");
    expect(stateRows[2][1]).toBe("1,480,000");
  });
});

