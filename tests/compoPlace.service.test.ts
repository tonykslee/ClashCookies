import { beforeEach, describe, expect, it, vi } from "vitest";
import * as SheetRefreshService from "../src/services/SheetRefreshService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { CompoPlaceService } from "../src/services/CompoPlaceService";

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

function makeActualLayoutRows(): string[][] {
  const rows = blankRows(8);
  rows[1] = makeRow({
    0: "Alpha Clan-actual",
    1: "#AAA111",
    3: "8,000,000",
    20: "1",
    21: "50",
    22: "0",
    23: "0",
    24: "0",
    25: "-2",
    26: "0",
    27: "0",
    49: "8,100,000",
  });
  rows[4] = makeRow({
    0: "Bravo Clan-actual",
    1: "#BBB222",
    3: "7,980,000",
    20: "2",
    21: "48",
    22: "0",
    23: "0",
    24: "0",
    25: "-1",
    26: "0",
    27: "1",
    49: "8,100,000",
  });
  return rows;
}

describe("CompoPlaceService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads ACTUAL compo rows from the linked sheet and preserves placement ranking semantics", async () => {
    vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue({
      sheetId: "sheet-1",
      range: "AllianceDashboard!A6:BE500",
      source: "guild",
    } as any);
    const readSpy = vi
      .spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues")
      .mockResolvedValueOnce(makeActualLayoutRows())
      .mockResolvedValueOnce([["1712772000"]]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15");

    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(result.trackedClanTags).toEqual(["AAA111", "BBB222"]);
    expect(result.eligibleClanTags).toEqual(["AAA111", "BBB222"]);
    expect(result.candidateCount).toBe(2);
    expect(result.recommendedCount).toBe(1);
    expect(result.vacancyCount).toBe(1);
    expect(result.compositionCount).toBe(2);
    expect(result.content).toBe("");

    const embed = result.embeds[0]?.toJSON();
    expect(embed?.description).toContain("Weight: **145,000**");
    expect(embed?.description).toContain("Bucket: **TH15**");
    expect(embed?.description).toContain("RAW Data last refreshed:");
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toContain(
      "Bravo Clan - needs 1 TH15",
    );
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toContain(
      "Bravo Clan - 48/50",
    );
    const compositionValue =
      embed?.fields?.find((field) => field.name === "Composition")?.value ?? "";
    expect(compositionValue).toContain("Alpha Clan - -2");
    expect(compositionValue).toContain("Bravo Clan - -1");
    expect(compositionValue.indexOf("Alpha Clan - -2")).toBeLessThan(
      compositionValue.indexOf("Bravo Clan - -1"),
    );
  });

  it("returns honest text when ACTUAL rows do not contain placement data", async () => {
    vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue({
      sheetId: "sheet-1",
      range: "AllianceDashboard!A6:BE500",
      source: "guild",
    } as any);
    vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues")
      .mockResolvedValueOnce(blankRows(8))
      .mockResolvedValueOnce([["1712772000"]]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15");

    expect(result.embeds).toEqual([]);
    expect(result.content).toContain(
      "No placement data found in ACTUAL rows from AllianceDashboard!A6:BE500.",
    );
    expect(result.candidateCount).toBe(0);
  });

  it("refreshes the ACTUAL sheet source before rereading placement suggestions", async () => {
    vi.spyOn(SheetRefreshService, "triggerSharedSheetRefresh").mockResolvedValue({
      refreshedAt: null,
      detail: null,
    });
    vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue({
      sheetId: "sheet-1",
      range: "AllianceDashboard!A6:BE500",
      source: "guild",
    } as any);
    vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues")
      .mockResolvedValueOnce(makeActualLayoutRows())
      .mockResolvedValueOnce([["1712772000"]]);

    await new CompoPlaceService().refreshPlace(145000, "TH15", "guild-1");

    expect(SheetRefreshService.triggerSharedSheetRefresh).toHaveBeenCalledWith({
      guildId: "guild-1",
      mode: "actual",
    });
  });
});
