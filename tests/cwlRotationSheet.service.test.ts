import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  cwlRotationPlan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  cwlRotationPlanDay: {
    findMany: vi.fn(),
  },
  cwlRotationExport: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlRotationSheetService } from "../src/services/CwlRotationSheetService";
import { cwlStateService } from "../src/services/CwlStateService";
import { PublicGoogleSheetsService } from "../src/services/PublicGoogleSheetsService";

describe("CwlRotationSheetService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Alpha" },
      { tag: "#9GLGQCCU", name: "CWL Beta" },
    ]);
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue(null);
    prismaMock.cwlRotationPlan.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationPlanDay.findMany.mockResolvedValue([]);
    prismaMock.cwlRotationExport.findFirst.mockResolvedValue(null);
    prismaMock.cwlRotationExport.upsert.mockResolvedValue({});
    vi.spyOn(GoogleSheetsService.prototype, "formatSpreadsheetTabs").mockResolvedValue(undefined);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "\u{1F525} Lethargic Yunan",
        townHall: 16,
        linkedDiscordUserId: "111111111111111111",
        linkedDiscordUsername: "Alpha",
        daysParticipated: 0,
        currentRound: null,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Second Player",
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ] as any);
  });

  it("builds a preview from a public sheet, matches clan-name containment, and skips unmatched tabs", async () => {
    const publicWorkbookSpy = vi
      .spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook")
      .mockResolvedValue({
        title: "Imported CWL Planner",
        tabs: [
          {
            title: "CWL Alpha roster",
            pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
            gid: "0",
          },
          {
            title: "Unmatched tab",
            pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=1",
            gid: "1",
          },
        ],
      });
    const publicValuesSpy = vi
      .spyOn(PublicGoogleSheetsService.prototype, "readPublishedSheetValues")
      .mockImplementation(async (pageUrl) => {
        if (String(pageUrl).includes("gid=0")) {
          return [
            ["Season: 2026-04"],
            ["Clan: CWL Alpha"],
            ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["\u{1F525} Lethargic Yunan", "12", "IN", "", "IN", "", "", "", ""],
            ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["Second Player", "8", "", "IN", "", "", "", "", ""],
            ["", "", "", "", "", "", "", "", ""],
          ];
        }
        return [];
      });
    const authMetadataSpy = vi.spyOn(GoogleSheetsService.prototype, "getSpreadsheetMetadata");
    const authValuesSpy = vi.spyOn(GoogleSheetsService.prototype, "readValues");

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
      overwrite: false,
    });

    expect(preview.sourceSheetId).toBe("published-id");
    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.clanTag).toBe("#2QG2C08UP");
    expect(preview.matchedClans[0]?.importable).toBe(true);
    expect(preview.matchedClans[0]?.days[0]?.members[0]?.playerName).toBe("\u{1F525} Lethargic Yunan");
    expect(preview.matchedClans[0]?.days[0]?.members[0]?.subbedOut).toBe(false);
    expect(preview.matchedClans[0]?.days[1]?.members[1]?.playerName).toBe("Second Player");
    expect(preview.matchedClans[0]?.days[1]?.members[1]?.subbedOut).toBe(false);
    expect(preview.matchedClans[0]?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Skipped 5 structural rows.")]),
    );
    expect(preview.skippedTrackedClans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clanTag: "#9GLGQCCU",
        }),
      ]),
    );
    expect(preview.skippedTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabTitle: "Unmatched tab",
        }),
      ]),
    );
    expect(publicWorkbookSpy).toHaveBeenCalledWith(
      "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml",
    );
    expect(publicValuesSpy).toHaveBeenCalled();
    expect(authMetadataSpy).not.toHaveBeenCalled();
    expect(authValuesSpy).not.toHaveBeenCalled();
    expect(String(preview.warnings.join(" "))).not.toContain("could not parse member line");
  });

  it("auto-skips title, meta, header, and blank rows before review", async () => {
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook").mockResolvedValue({
      title: "Imported CWL Planner",
      tabs: [
        {
          title: "CWL Alpha roster",
          pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
          gid: "0",
        },
      ],
    });
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedSheetValues").mockResolvedValue([
      ["Imported CWL Planner"],
      ["Season: 2026-04"],
      ["Clan: CWL Alpha"],
      ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      ["1", "\u{1F525} Lethargic Yunan", "IN", "", "", "", "", "", "", "7"],
      ["", "", "", "", "", "", "", "", "", ""],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
      overwrite: false,
    });

    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.structuralRowCount).toBe(5);
    expect(preview.matchedClans[0]?.parsedRows).toHaveLength(1);
    expect(preview.matchedClans[0]?.parsedRows[0]?.parsedPlayerName).toBe("\u{1F525} Lethargic Yunan");
    expect(preview.matchedClans[0]?.parsedRows[0]?.classification).toBe("exact_match");
    expect(preview.matchedClans[0]?.reviewRequiredRowCount).toBe(0);
  });

  it("matches imported names against normalized tracked-player names even when the tracked label includes a tag", async () => {
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook").mockResolvedValue({
      title: "Imported CWL Planner",
      tabs: [
        {
          title: "CWL Alpha roster",
          pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
          gid: "0",
        },
      ],
    });
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Alpha (#PYLQ0289)",
        townHall: 16,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      },
    ] as any);
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedSheetValues").mockResolvedValue([
      ["Season: 2026-04"],
      ["Clan: CWL Alpha"],
      ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      ["1", "Alpha", "IN", "", "", "", "", "", "", "7"],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
      overwrite: false,
    });

    expect(preview.matchedClans[0]?.parsedRows[0]?.resolvedPlayerTag).toBe("#PYLQ0289");
    expect(preview.matchedClans[0]?.parsedRows[0]?.classification).toBe("exact_match");
    expect(preview.matchedClans[0]?.reviewRequiredRowCount).toBe(0);
  });

  it("parses legacy public table rows as roster-index plus player-name columns", async () => {
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook").mockResolvedValue({
      title: "Imported CWL Planner",
      tabs: [
        {
          title: "CWL Alpha roster",
          pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
          gid: "0",
        },
      ],
    });
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedSheetValues").mockResolvedValue([
      ["Season: 2026-04"],
      ["Clan: CWL Alpha"],
      ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      [
        "8",
        "\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}",
        "IN",
        "IN",
        "IN",
        "IN",
        "IN",
        "IN",
        "IN",
        "7",
      ],
      ["", "", "", "", "", "", "", "", "", ""],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
      overwrite: false,
    });

    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.parsedRows).toHaveLength(1);
    expect(preview.matchedClans[0]?.parsedRows[0]?.parsedPlayerName).toBe(
      "\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}",
    );
    expect(preview.matchedClans[0]?.parsedRows[0]?.rawPlayerNameSnippet).toBe(
      "\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}\u{2606}\u{2605}",
    );
    expect(preview.matchedClans[0]?.parsedRows[0]?.parsedPlayerTag).toBeNull();
    expect(preview.matchedClans[0]?.parsedRows[0]?.classification).toBe("unresolved_needs_review");
    expect(preview.matchedClans[0]?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("1 row need review")]),
    );
  });

  it("still requires credentials for non-public Google Sheets links", async () => {
    const publicWorkbookSpy = vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook");
    const interactionLink = "https://docs.google.com/spreadsheets/d/standard-sheet-id/edit";

    await expect(
      cwlRotationSheetService.buildImportPreview({
        sheetLink: interactionLink,
        overwrite: false,
      }),
    ).rejects.toThrow("Google Sheets credentials missing");

    expect(publicWorkbookSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed or incomplete Google Sheets links with a clear error", async () => {
    await expect(
      cwlRotationSheetService.buildImportPreview({
        sheetLink: "not-a-valid-link",
        overwrite: false,
      }),
    ).rejects.toThrow("Unsupported Google Sheets link format");

    await expect(
      cwlRotationSheetService.buildImportPreview({
        sheetLink: "https://docs.google.com/spreadsheets/d/",
        overwrite: false,
      }),
    ).rejects.toThrow("No spreadsheet ID could be extracted");
  });

  it("blocks clans that already have an active plan unless overwrite is requested", async () => {
    prismaMock.cwlRotationPlan.findFirst.mockResolvedValue({
      id: "plan-1",
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      version: 2,
      isActive: true,
      metadata: null,
      rosterSize: 2,
      generatedFromRoundDay: 1,
      excludedPlayerTags: [],
      warningSummary: null,
    });
    vi.spyOn(GoogleSheetsService.prototype, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "Imported CWL Planner",
      sheets: [{ sheetId: 1, title: "CWL Alpha roster", index: 0, hidden: false, tables: [] }],
    });
    vi.spyOn(GoogleSheetsService.prototype, "readValues").mockResolvedValue([
      ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      [":black_circle: Alpha (#PYLQ0289)", "12", "IN", "", "", "", "", "", ""],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      overwrite: false,
    });

    expect(preview.matchedClans[0]?.importable).toBe(false);
    expect(preview.matchedClans[0]?.importBlockedReason).toContain("overwrite:true");
  });

  it("surfaces a public-sheet-specific error when the anonymous import path fails", async () => {
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook").mockRejectedValueOnce(
      new Error(
        "Unable to read the public Google Sheet import. Failed to fetch the published Google Sheet.",
      ),
    );

    await expect(
      cwlRotationSheetService.buildImportPreview({
        sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
        overwrite: false,
      }),
    ).rejects.toThrow("Unable to read the public Google Sheet import");
  });

  it("sends malformed player-like rows into review with a compact format warning instead of cell spam", async () => {
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedWorkbook").mockResolvedValue({
      title: "Imported CWL Planner",
      tabs: [
        {
          title: "CWL Alpha roster",
          pageUrl: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
          gid: "0",
        },
      ],
    });
    vi.spyOn(PublicGoogleSheetsService.prototype, "readPublishedSheetValues").mockResolvedValue([
      ["Member", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      ["IN", "12", "IN", "", "", "", "", "", ""],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml#gid=123456789",
      overwrite: false,
    });

    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.importable).toBe(false);
    expect(preview.matchedClans[0]?.reviewRequiredRowCount).toBe(1);
    expect(preview.matchedClans[0]?.parsedRows[0]?.rawPlayerNameSnippet).toBeNull();
    expect(preview.matchedClans[0]?.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("1 row need review")]),
    );
    expect(preview.skippedTrackedClans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clanTag: "#9GLGQCCU",
        }),
      ]),
    );
    expect(String(preview.warnings.join(" "))).not.toContain("could not parse member line");
  });

  it("persists confirmed imports into the planner service only after confirmation", async () => {
    const persistSpy = vi.spyOn(cwlRotationService, "persistImportedPlan").mockResolvedValue({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      version: 3,
      dayCount: 1,
      warnings: [],
      sourceTabName: "CWL Alpha roster",
    });

    const result = await cwlRotationSheetService.confirmImport({
      overwrite: true,
      preview: {
        sourceSheetId: "sheet-1",
        sourceSheetTitle: "Imported CWL Planner",
        season: "2026-04",
        matchedClans: [
          {
            clanTag: "#2QG2C08UP",
            clanName: "CWL Alpha",
            tabTitle: "CWL Alpha roster",
            existingVersion: null,
            importable: true,
            importBlockedReason: null,
            warnings: ["Tab was loosely formatted."],
            structuralRowCount: 0,
            reviewRequiredRowCount: 0,
            ignoredRowCount: 0,
            rosterRows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha" },
            ],
            days: [
              {
                roundDay: 1,
                lineupSize: 1,
                rows: [
                  {
                    playerTag: "#PYLQ0289",
                    playerName: "Alpha",
                    subbedOut: false,
                    assignmentOrder: 0,
                  },
                ],
                members: [
                  {
                    playerTag: "#PYLQ0289",
                    playerName: "Alpha",
                    subbedOut: false,
                    assignmentOrder: 0,
                  },
                ],
              },
            ],
            parsedRows: [
              {
                rowId: "cwl-alpha-roster:3",
                sheetRowNumber: 3,
                tabTitle: "CWL Alpha roster",
                clanTag: "#2QG2C08UP",
                clanName: "CWL Alpha",
                rawText: "Alpha | #PYLQ0289 | 12 | IN",
                parsedPlayerTag: "#PYLQ0289",
                parsedPlayerName: "Alpha",
                classification: "exact_match",
                reason: null,
                suggestions: [],
                dayRows: [
                  {
                    roundDay: 1,
                    subbedOut: false,
                    assignmentOrder: 0,
                  },
                ],
                resolvedPlayerTag: "#PYLQ0289",
                resolvedPlayerName: "Alpha",
                ignored: false,
              },
            ],
          },
        ],
        skippedTrackedClans: [],
        skippedTabs: [],
        warnings: [],
      },
    });

    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        sourceSheetId: "sheet-1",
        sourceTabName: "CWL Alpha roster",
        overwrite: true,
        days: expect.arrayContaining([
          expect.objectContaining({
            roundDay: 1,
            lineupSize: 1,
          }),
        ]),
      }),
    );
    expect(result.saved[0]).toMatchObject({
      outcome: "created",
      clanTag: "#2QG2C08UP",
      version: 3,
    });
  });

  it("lists ignored rows explicitly during confirmation and still persists resolved rows", async () => {
    const persistSpy = vi.spyOn(cwlRotationService, "persistImportedPlan").mockResolvedValue({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      version: 4,
      dayCount: 1,
      warnings: [],
      sourceTabName: "CWL Alpha roster",
    });

    const result = await cwlRotationSheetService.confirmImport({
      overwrite: true,
      preview: {
        sourceSheetId: "sheet-1",
        sourceSheetTitle: "Imported CWL Planner",
        season: "2026-04",
        matchedClans: [
          {
            clanTag: "#2QG2C08UP",
            clanName: "CWL Alpha",
            tabTitle: "CWL Alpha roster",
            existingVersion: null,
            importable: true,
            importBlockedReason: null,
            warnings: [],
            structuralRowCount: 1,
            reviewRequiredRowCount: 0,
            ignoredRowCount: 1,
            rosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
            days: [
              {
                roundDay: 1,
                lineupSize: 1,
                rows: [
                  {
                    playerTag: "#PYLQ0289",
                    playerName: "Alpha",
                    subbedOut: false,
                    assignmentOrder: 0,
                  },
                ],
                members: [
                  {
                    playerTag: "#PYLQ0289",
                    playerName: "Alpha",
                    subbedOut: false,
                    assignmentOrder: 0,
                  },
                ],
              },
            ],
            parsedRows: [
              {
                rowId: "cwl-alpha-roster:3",
                sheetRowNumber: 3,
                tabTitle: "CWL Alpha roster",
                clanTag: "#2QG2C08UP",
                clanName: "CWL Alpha",
                rawText: "Alpha | #PYLQ0289 | 1 | IN",
                parsedPlayerTag: "#PYLQ0289",
                parsedPlayerName: "Alpha",
                classification: "exact_match",
                reason: null,
                suggestions: [],
                dayRows: [
                  { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
                ],
                resolvedPlayerTag: "#PYLQ0289",
                resolvedPlayerName: "Alpha",
                ignored: false,
              },
              {
                rowId: "cwl-alpha-roster:4",
                sheetRowNumber: 4,
                tabTitle: "CWL Alpha roster",
                clanTag: "#2QG2C08UP",
                clanName: "CWL Alpha",
                rawText: "Bravo | 12 | ",
                parsedPlayerTag: null,
                parsedPlayerName: "Bravo",
                classification: "explicitly_ignored",
                reason: "Explicitly ignored by the importing admin.",
                suggestions: [],
                dayRows: [
                  { roundDay: 1, subbedOut: true, assignmentOrder: 0 },
                ],
                resolvedPlayerTag: null,
                resolvedPlayerName: null,
                ignored: true,
              },
            ],
          },
        ],
        skippedTrackedClans: [],
        skippedTabs: [],
        warnings: [],
      },
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(result.ignoredRows).toEqual([
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        tabTitle: "CWL Alpha roster",
        sheetRowNumber: 4,
      }),
    ]);
  });

  it("exports active planner data to a canonical tabular sheet payload", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        rosterId: "roster-1",
        rosterTitle: "Masters 1 [A] | 175k+ WW",
        rosterShortName: "M1 [A]",
        clanDisplayName: "Rising Thrones",
        sourceLabel: "CWL roster - Masters 1 [A] | 175k+ WW",
        version: 3,
        rosterSize: 2,
        generatedFromRoundDay: 2,
        excludedPlayerTags: ["#QGRJ2222"],
        warningSummary: "Watch coverage",
        metadata: { source: "sheet-import" },
        days: [
          {
            roundDay: 1,
            lineupSize: 2,
            locked: false,
            metadata: { source: "sheet-import" },
            rows: [
              {
                playerTag: "#PYLQ0289",
                playerName: "Alpha",
                subbedOut: false,
                assignmentOrder: 0,
              },
              {
                playerTag: "#QGRJ2222",
                playerName: "Bravo",
                subbedOut: true,
                assignmentOrder: 1,
              },
            ],
          },
        ],
      },
    ]);
    const createSpreadsheet = vi
      .spyOn(GoogleSheetsService.prototype, "createSpreadsheet")
      .mockResolvedValue({
        spreadsheetId: "sheet-new",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      });
    const writeTabs = vi
      .spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs")
      .mockResolvedValue(undefined);
    const publicSpy = vi
      .spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic")
      .mockResolvedValue(undefined);

    const result = await cwlRotationSheetService.exportActivePlans({
      season: "2026-04",
    });

    expect(createSpreadsheet).toHaveBeenCalledWith({
      title: "ClashCookies CWL Rotation Export 2026-04",
      tabNames: ["M1 [A] | Rising Thrones"],
    });
    expect(writeTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-new",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabName: "M1 [A] | Rising Thrones",
          }),
        ]),
      }),
    );
    expect(GoogleSheetsService.prototype.formatSpreadsheetTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-new",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabName: "M1 [A] | Rising Thrones",
            tableRanges: [
              {
                startRowIndex: 6,
                endRowIndex: 9,
                startColumnIndex: 0,
                endColumnIndex: 10,
                headerRowIndex: 6,
              },
            ],
          }),
        ]),
      }),
    );
    const exportedTabValues = (writeTabs.mock.calls[0]?.[0] as any)?.tabs?.[0]?.values as string[][] | undefined;
    expect(exportedTabValues).toEqual([
      ["Season: 2026-04"],
      ["Roster: Masters 1 [A] | 175k+ WW"],
      ["Clan: Rising Thrones"],
      ["Clan Tag: #2QG2C08UP"],
      ["Warnings: Watch coverage"],
      [],
      ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
      ["Bravo", "#QGRJ2222", "0", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
    ]);
    expect(publicSpy).toHaveBeenCalledWith("sheet-new");
    expect(result).toEqual({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      tabCount: 1,
      reused: false,
    });
  });

  it("keeps live/manual export rows ordered by stored source position rather than assignment order", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        rosterId: null,
        rosterTitle: null,
        rosterShortName: null,
        clanDisplayName: "Rising Thrones",
        sourceLabel: "manual",
        version: 5,
        rosterSize: 3,
        generatedFromRoundDay: 2,
        excludedPlayerTags: [],
        warningSummary: null,
        metadata: { source: "manual" },
        days: [
          {
            roundDay: 1,
            lineupSize: 3,
            locked: false,
            metadata: { source: "manual" },
            rows: [
              {
                playerTag: "#PYLQ0289",
                playerName: "Alpha",
                subbedOut: false,
                assignmentOrder: 2,
                sourcePosition: 30,
              },
              {
                playerTag: "#QGRJ2222",
                playerName: "Bravo",
                subbedOut: false,
                assignmentOrder: 0,
                sourcePosition: 10,
              },
              {
                playerTag: "#CUV9082",
                playerName: "Charlie",
                subbedOut: false,
                assignmentOrder: 1,
                sourcePosition: 20,
              },
            ],
          },
        ],
      },
    ]);
    const createSpreadsheet = vi
      .spyOn(GoogleSheetsService.prototype, "createSpreadsheet")
      .mockResolvedValue({
        spreadsheetId: "sheet-live",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-live/edit?usp=sharing",
      });
    const writeTabs = vi
      .spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs")
      .mockResolvedValue(undefined);
    const publicSpy = vi
      .spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic")
      .mockResolvedValue(undefined);

    const result = await cwlRotationSheetService.exportActivePlans({
      season: "2026-04",
    });

    expect(createSpreadsheet).toHaveBeenCalledWith(
      expect.objectContaining({
        tabNames: ["manual | Rising Thrones"],
      }),
    );
    const exportedTabValues = (writeTabs.mock.calls[0]?.[0] as any)?.tabs?.[0]?.values as string[][] | undefined;
    expect(exportedTabValues).toEqual([
      ["Season: 2026-04"],
      ["Roster: manual"],
      ["Clan: Rising Thrones"],
      ["Clan Tag: #2QG2C08UP"],
      [],
      ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
      ["Bravo", "#QGRJ2222", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
      ["Charlie", "#CUV9082", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
      ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
    ]);
    expect(result).toEqual({
      spreadsheetId: "sheet-live",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-live/edit?usp=sharing",
      tabCount: 1,
      reused: false,
    });
    expect(GoogleSheetsService.prototype.formatSpreadsheetTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-live",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabName: "manual | Rising Thrones",
            tableRanges: [
              {
                startRowIndex: 5,
                endRowIndex: 9,
                startColumnIndex: 0,
                endColumnIndex: 10,
                headerRowIndex: 5,
              },
            ],
          }),
        ]),
      }),
    );
    expect(publicSpy).toHaveBeenCalledWith("sheet-live");
  });

  it("reuses the same-season export link when the export fingerprint has not changed", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        rosterId: "roster-1",
        rosterTitle: "Masters 1 [A] | 175k+ WW",
        rosterShortName: "M1 [A]",
        clanDisplayName: "Rising Thrones",
        sourceLabel: "CWL roster - Masters 1 [A] | 175k+ WW",
        version: 3,
        rosterSize: 2,
        generatedFromRoundDay: 2,
        excludedPlayerTags: ["#QGRJ2222"],
        warningSummary: "Watch coverage",
        metadata: { source: "sheet-import" },
        days: [
          {
            roundDay: 1,
            lineupSize: 2,
            locked: false,
            metadata: { source: "sheet-import" },
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 1 },
            ],
          },
        ],
      },
    ]);
    prismaMock.cwlRotationExport.findFirst.mockResolvedValue({
      spreadsheetId: "sheet-old",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-old/edit?usp=sharing",
      tabCount: 1,
    });
    const createSpreadsheet = vi.spyOn(GoogleSheetsService.prototype, "createSpreadsheet");
    const writeTabs = vi.spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs");
    const publicSpy = vi.spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic");

    const result = await cwlRotationSheetService.exportActivePlans({
      season: "2026-04",
      new: false,
    });

    expect(result).toEqual({
      spreadsheetId: "sheet-old",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-old/edit?usp=sharing",
      tabCount: 1,
      reused: true,
    });
    expect(createSpreadsheet).not.toHaveBeenCalled();
    expect(writeTabs).not.toHaveBeenCalled();
    expect(GoogleSheetsService.prototype.formatSpreadsheetTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-old",
      }),
    );
    expect(publicSpy).not.toHaveBeenCalled();
    expect(prismaMock.cwlRotationExport.upsert).not.toHaveBeenCalled();
  });

  it("creates a new export when forced even if the fingerprint matches an existing cache row", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "Rising Thrones",
        rosterId: "roster-1",
        rosterTitle: "Masters 1 [A] | 175k+ WW",
        rosterShortName: "M1 [A]",
        clanDisplayName: "Rising Thrones",
        sourceLabel: "CWL roster - Masters 1 [A] | 175k+ WW",
        version: 3,
        rosterSize: 2,
        generatedFromRoundDay: 2,
        excludedPlayerTags: ["#QGRJ2222"],
        warningSummary: "Watch coverage",
        metadata: { source: "sheet-import" },
        days: [
          {
            roundDay: 1,
            lineupSize: 2,
            locked: false,
            metadata: { source: "sheet-import" },
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 1 },
            ],
          },
        ],
      },
    ]);
    prismaMock.cwlRotationExport.findFirst.mockResolvedValue({
      spreadsheetId: "sheet-old",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-old/edit?usp=sharing",
      tabCount: 1,
    });
    const createSpreadsheet = vi
      .spyOn(GoogleSheetsService.prototype, "createSpreadsheet")
      .mockResolvedValue({
        spreadsheetId: "sheet-new",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      });
    const writeTabs = vi
      .spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs")
      .mockResolvedValue(undefined);
    const publicSpy = vi
      .spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic")
      .mockResolvedValue(undefined);

    const result = await cwlRotationSheetService.exportActivePlans({
      season: "2026-04",
      new: true,
      createdByDiscordUserId: "111111111111111111",
    });

    expect(createSpreadsheet).toHaveBeenCalledTimes(1);
    expect(writeTabs).toHaveBeenCalledTimes(1);
    expect(publicSpy).toHaveBeenCalledWith("sheet-new");
    expect(prismaMock.cwlRotationExport.upsert).toHaveBeenCalledWith({
      where: {
        season_fingerprint: expect.any(Object),
      },
      create: expect.objectContaining({
        season: "2026-04",
        spreadsheetId: "sheet-new",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
        tabCount: 1,
        createdByDiscordUserId: "111111111111111111",
      }),
      update: expect.objectContaining({
        spreadsheetId: "sheet-new",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
        tabCount: 1,
        createdByDiscordUserId: "111111111111111111",
      }),
    });
    expect(result).toEqual({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      tabCount: 1,
      reused: false,
    });
  });

  it("changes the export fingerprint when exported tab content changes", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports")
      .mockResolvedValueOnce([
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Thrones",
          rosterId: "roster-1",
          rosterTitle: "Masters 1 [A] | 175k+ WW",
          rosterShortName: "M1 [A]",
          clanDisplayName: "Rising Thrones",
          sourceLabel: "CWL roster - Masters 1 [A] | 175k+ WW",
          version: 3,
          rosterSize: 2,
          generatedFromRoundDay: 2,
          excludedPlayerTags: ["#QGRJ2222"],
          warningSummary: "Watch coverage",
          metadata: { source: "sheet-import" },
          days: [
            {
              roundDay: 1,
              lineupSize: 2,
              locked: false,
              metadata: { source: "sheet-import" },
              rows: [
                { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
                { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 1 },
              ],
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "Rising Knights",
          rosterId: "roster-1",
          rosterTitle: "Masters 2 [B] | TH18 & 17",
          rosterShortName: "M2 [B]",
          clanDisplayName: "Rising Knights",
          sourceLabel: "CWL roster - Masters 2 [B] | TH18 & 17",
          version: 3,
          rosterSize: 2,
          generatedFromRoundDay: 2,
          excludedPlayerTags: ["#QGRJ2222"],
          warningSummary: "Watch coverage",
          metadata: { source: "sheet-import" },
          days: [
            {
              roundDay: 1,
              lineupSize: 2,
              locked: false,
              metadata: { source: "sheet-import" },
              rows: [
                { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
                { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 1 },
              ],
            },
          ],
        },
      ]);
    const createSpreadsheet = vi
      .spyOn(GoogleSheetsService.prototype, "createSpreadsheet")
      .mockResolvedValue({
        spreadsheetId: "sheet-new",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      });
    vi.spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs").mockResolvedValue(undefined);
    vi.spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic").mockResolvedValue(undefined);

    await cwlRotationSheetService.exportActivePlans({ season: "2026-04", new: false });
    await cwlRotationSheetService.exportActivePlans({ season: "2026-04", new: false });

    expect(createSpreadsheet).toHaveBeenCalledTimes(2);
    const firstFingerprint = prismaMock.cwlRotationExport.findFirst.mock.calls[0]?.[0]?.where?.fingerprint;
    const secondFingerprint = prismaMock.cwlRotationExport.findFirst.mock.calls[1]?.[0]?.where?.fingerprint;
    expect(firstFingerprint).not.toBe(secondFingerprint);
  });

  it("reimports canonical exported planner data with exact tag-based parity and no review", async () => {
    const lineupRows = Array.from({ length: 11 }, (_value, index) => ({
      playerTag: `#PYLQ${String(index + 1).padStart(4, "0")}`,
      playerName: `Player ${index + 1}`,
      subbedOut: false,
      assignmentOrder: index,
    }));
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 3,
        rosterSize: 11,
        generatedFromRoundDay: 2,
        excludedPlayerTags: [],
        warningSummary: null,
        metadata: { source: "sheet-import" },
        days: [
          {
            roundDay: 1,
            lineupSize: 11,
            locked: false,
            metadata: { source: "sheet-import" },
            rows: lineupRows,
          },
        ],
      },
    ]);
    vi.spyOn(GoogleSheetsService.prototype, "createSpreadsheet").mockResolvedValue({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
    });
    const writeTabs = vi
      .spyOn(GoogleSheetsService.prototype, "writeSpreadsheetTabs")
      .mockResolvedValue(undefined);
    vi.spyOn(GoogleSheetsService.prototype, "makeSpreadsheetPublic").mockResolvedValue(undefined);
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue(
      lineupRows.map((row) => ({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHall: 15,
        linkedDiscordUserId: null,
        linkedDiscordUsername: null,
        daysParticipated: 0,
        currentRound: null,
      })) as any,
    );

    await cwlRotationSheetService.exportActivePlans({
      season: "2026-04",
    });

    const exportedValues = (writeTabs.mock.calls[0]?.[0] as any)?.tabs?.[0]?.values as string[][];
    vi.spyOn(GoogleSheetsService.prototype, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-new",
      title: "Canonical CWL Export",
      sheets: [{ sheetId: 1, title: "CWL Alpha #2QG2C08UP", index: 0, hidden: false, tables: [] }],
    });
    vi.spyOn(GoogleSheetsService.prototype, "readValues").mockResolvedValue(exportedValues);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-new/edit",
      overwrite: false,
    });

    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.importable).toBe(true);
    expect(preview.matchedClans[0]?.reviewRequiredRowCount).toBe(0);
    expect(preview.matchedClans[0]?.parsedRows.every((row) => row.classification === "exact_match")).toBe(true);
    expect(preview.matchedClans[0]?.days[0]?.lineupSize).toBe(11);
    expect(preview.matchedClans[0]?.days[0]?.members).toHaveLength(11);
    expect(preview.matchedClans[0]?.parsedRows).toHaveLength(11);
    expect(preview.matchedClans[0]?.days[0]?.members?.map((member) => member.playerTag)).toContain("#PYLQ0001");
    expect(preview.matchedClans[0]?.days[0]?.members?.map((member) => member.playerTag)).toContain("#PYLQ0011");
  });
});
