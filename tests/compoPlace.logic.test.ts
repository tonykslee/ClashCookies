import { describe, expect, it } from "vitest";
import {
  buildCompoStateRowsForTest,
  getAbsoluteSheetRowNumberForTest,
  getModeRowsForTest,
  parseWeightInputForTest,
} from "../src/commands/Compo";
import { buildCompoPlaceEmbedForTest } from "../src/services/CompoPlaceService";

function blankRows(count: number, cols = 57): string[][] {
  return Array.from({ length: count }, () =>
    Array.from({ length: cols }, () => ""),
  );
}

function makeRow(cells: Record<number, string>, cols = 57): string[] {
  const row = Array.from({ length: cols }, () => "");
  for (const [col, value] of Object.entries(cells)) {
    row[Number(col)] = value;
  }
  return row;
}

describe("/compo helpers", () => {
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
    expect(actualRows.map((entry) => entry.row[0])).toEqual([
      "row-7",
      "row-10",
    ]);
    expect(warRows.map((entry) => entry.sheetRowNumber)).toEqual([8, 11]);
  });

  it("keeps /compo place weight normalization unchanged", () => {
    expect(parseWeightInputForTest("145000")).toBe(145000);
    expect(parseWeightInputForTest("145,000")).toBe(145000);
    expect(parseWeightInputForTest("145k")).toBe(145000);
    expect(parseWeightInputForTest("145.5k")).toBe(145500);
    expect(parseWeightInputForTest("")).toBeNull();
    expect(parseWeightInputForTest("abc")).toBeNull();
  });

  it("builds a placement embed with stable section names", () => {
    const embed = buildCompoPlaceEmbedForTest({
      inputWeight: 145000,
      bucket: "TH15",
      recommended: [
        {
          clanName: "Red Riders-war",
          clanTag: "#R8R8",
          totalWeight: 8100000,
          targetBand: 8100000,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 50,
          vacancySlots: 0,
          hasVacancy: false,
          delta: -2,
        },
      ],
      vacancyList: [
        {
          clanName: "Zero Gravity-war",
          clanTag: "#ZG99",
          totalWeight: 8100000,
          targetBand: 8100000,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 50,
          vacancySlots: 0,
          hasVacancy: false,
        },
      ],
      compositionList: [
        {
          clanName: "The Winners Club-war",
          clanTag: "#TWC1",
          totalWeight: 8100000,
          targetBand: 8100000,
          missingCount: 0,
          remainingToTarget: 0,
          bucketDeltaByHeader: {},
          liveMemberCount: 50,
          vacancySlots: 0,
          hasVacancy: false,
          delta: -4,
        },
      ],
      refreshLine: "Persisted WAR data last refreshed: (not available)",
    }).toJSON();

    expect(embed.title).toBe("Compo Placement Suggestions");
    expect(embed.description).toContain("Weight: **145,000**");
    expect(embed.description).toContain("Bucket: **TH15**");
    expect(embed.fields?.map((field) => field.name)).toEqual([
      "Recommended",
      "Vacancy",
      "Composition",
    ]);
    expect(embed.fields?.[0]?.value).toContain("Red Riders");
    expect(embed.fields?.[0]?.value).not.toContain("-war");
    expect(embed.fields?.[0]?.value).toContain("needs 2 TH15");
    expect(embed.fields?.[1]?.value).toContain("ZG");
    expect(embed.fields?.[1]?.value).toContain("50/50");
    expect(embed.fields?.[2]?.value).toContain("The Winners Club");
    expect(embed.fields?.[2]?.value).not.toContain("-war");
    expect(embed.fields?.[2]?.value).toContain("-4");
  });

  it("sanitizes clan names in state table rows for display-only rendering", () => {
    const modeRows = [
      {
        row: makeRow({
          0: "Dark Empire-actual",
          3: "1,470,000",
          20: "1",
          21: "49",
          22: "0",
          23: "0",
          24: "-1",
          25: "0",
          26: "0",
          27: "0",
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
          21: "48",
          22: "1",
          23: "0",
          24: "0",
          25: "-1",
          26: "0",
          27: "0",
        }),
        sheetRowNumber: 7,
      },
      {
        row: makeRow({
          0: "Bravo Clan",
          3: "1,480,000",
          20: "1",
          21: "50",
          22: "0",
          23: "1",
          24: "0",
          25: "0",
          26: "-1",
          27: "0",
        }),
        sheetRowNumber: 13,
      },
      {
        row: makeRow({
          0: "   ",
          3: "1,470,000",
          20: "4",
          21: "44",
          22: "0",
          23: "0",
          24: "0",
          25: "0",
          26: "0",
          27: "-4",
        }),
        sheetRowNumber: 16,
      },
    ];

    const stateRows = buildCompoStateRowsForTest(modeRows);

    expect(stateRows).toHaveLength(3);
    expect(stateRows[0]).toEqual([
      "Clan",
      "Total",
      "Missing",
      "Players",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(stateRows[1][0]).toBe("Alpha Clan");
    expect(stateRows[1][1]).toBe("1,500,000");
    expect(stateRows[2][0]).toBe("Bravo Clan");
    expect(stateRows[2][1]).toBe("1,480,000");
    expect(stateRows[1][3]).toBe("48");
    expect(stateRows[2][3]).toBe("50");
  });
});
