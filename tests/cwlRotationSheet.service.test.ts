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
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlRotationSheetService } from "../src/services/CwlRotationSheetService";

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
  });

  it("builds a preview from a public sheet, matches clan-name containment, and skips unmatched tabs", async () => {
    vi.spyOn(GoogleSheetsService.prototype, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "Imported CWL Planner",
      sheets: [
        { sheetId: 1, title: "CWL Alpha roster", index: 0, hidden: false },
        { sheetId: 2, title: "Unmatched tab", index: 1, hidden: false },
      ],
    });
    vi.spyOn(GoogleSheetsService.prototype, "readValues").mockImplementation(async (_sheetId, range) => {
      if (String(range).includes("CWL Alpha roster")) {
        return [
          ["Day 1"],
          [":black_circle: Alpha (#PYLQ0289)"],
          [":x: Bravo (#QGRJ2222)"],
          ["Day 2"],
          [":black_circle: Alpha (#PYLQ0289)"],
        ];
      }
      return [];
    });

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      overwrite: false,
    });

    expect(preview.sourceSheetId).toBe("sheet-1");
    expect(preview.matchedClans).toHaveLength(1);
    expect(preview.matchedClans[0]?.clanTag).toBe("#2QG2C08UP");
    expect(preview.matchedClans[0]?.importable).toBe(true);
    expect(preview.matchedClans[0]?.days[0]?.members[1]?.subbedOut).toBe(true);
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
      sheets: [{ sheetId: 1, title: "CWL Alpha roster", index: 0, hidden: false }],
    });
    vi.spyOn(GoogleSheetsService.prototype, "readValues").mockResolvedValue([
      ["Day 1"],
      [":black_circle: Alpha (#PYLQ0289)"],
    ]);

    const preview = await cwlRotationSheetService.buildImportPreview({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      overwrite: false,
    });

    expect(preview.matchedClans[0]?.importable).toBe(false);
    expect(preview.matchedClans[0]?.importBlockedReason).toContain("overwrite:true");
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

  it("exports active planner data to a new sheet payload", async () => {
    vi.spyOn(cwlRotationService, "listActivePlanExports").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
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
      tabNames: ["CWL Alpha #2QG2C08UP"],
    });
    expect(writeTabs).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-new",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            tabName: "CWL Alpha #2QG2C08UP",
          }),
        ]),
      }),
    );
    expect(publicSpy).toHaveBeenCalledWith("sheet-new");
    expect(result).toEqual({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      tabCount: 1,
    });
  });
});
