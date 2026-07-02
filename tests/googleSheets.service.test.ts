import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { GoogleSheetsService } from "../src/services/GoogleSheetsService";

describe("GoogleSheetsService formatting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("creates Google-safe native table names for titles that previously failed validation", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "CWL Export",
      sheets: [{ sheetId: 1397220354, title: "Champions 3 | Serious CWL (Invite-only) | Rising Uncs", index: 0, hidden: false, tables: [] }],
    });
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });

    await service.formatSpreadsheetTabs({
      spreadsheetId: "sheet-1",
      tabs: [
        {
          tabName: "Champions 3 | Serious CWL (Invite-only) | Rising Uncs",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Alpha"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 7,
              startColumnIndex: 0,
              endColumnIndex: 10,
              headerRowIndex: 5,
            },
          ],
        },
      ],
    });

    const addTable = ((postSpy.mock.calls[0]?.[1] as any)?.requests as Array<Record<string, any>>).find(
      (request) => "addTable" in request,
    );
    const tableName = addTable?.addTable?.table?.name as string | undefined;

    expect(tableName).toBeDefined();
    expect(tableName).toBe("CWL_Rotation_Export_1397220354_1");
    expect(tableName).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/u);
    expect(tableName).not.toMatch(/[- ()|']/);
    expect(tableName).toContain("CWL_Rotation_Export_");
  });

  it("assigns distinct native table names when multiple tabs normalize to the same textual token", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "CWL Export",
      sheets: [
        { sheetId: 101, title: "Alpha/Beta", index: 0, hidden: false, tables: [] },
        { sheetId: 202, title: "Alpha Beta", index: 1, hidden: false, tables: [] },
      ],
    });
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });

    await service.formatSpreadsheetTabs({
      spreadsheetId: "sheet-1",
      tabs: [
        {
          tabName: "Alpha/Beta",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Alpha"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2"],
            ["Alpha", "#PYLQ0289", "1", "IN", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 7,
              startColumnIndex: 0,
              endColumnIndex: 5,
              headerRowIndex: 5,
            },
          ],
        },
        {
          tabName: "Alpha Beta",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Bravo"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2"],
            ["Bravo", "#QGRJ2222", "0", "OUT", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 7,
              startColumnIndex: 0,
              endColumnIndex: 5,
              headerRowIndex: 5,
            },
          ],
        },
      ],
    });

    const addTables = ((postSpy.mock.calls[0]?.[1] as any)?.requests as Array<Record<string, any>>).filter(
      (request) => "addTable" in request,
    );
    const tableNames = addTables.map((request) => request.addTable.table.name as string);

    expect(tableNames).toEqual(["CWL_Rotation_Export_101_1", "CWL_Rotation_Export_202_1"]);
    expect(new Set(tableNames).size).toBe(2);
  });

  it("creates native Google Sheets tables with trimmed bounds and exact IN/OUT fills", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "CWL Export",
      sheets: [{ sheetId: 123, title: "Tab 1", index: 0, hidden: false, tables: [] }],
    });
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });

    await service.formatSpreadsheetTabs({
      spreadsheetId: "sheet-1",
      tabs: [
        {
          tabName: "Tab 1",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Alpha"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
            ["Bravo", "#QGRJ2222", "0", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 8,
              startColumnIndex: 0,
              endColumnIndex: 10,
              headerRowIndex: 5,
            },
          ],
        },
      ],
    });

    expect(postSpy).toHaveBeenCalledTimes(1);
    const requestBody = postSpy.mock.calls[0]?.[1] as any;
    const requestConfig = postSpy.mock.calls[0]?.[2] as any;
    expect(requestBody).toMatchObject({
      requests: expect.arrayContaining([
        expect.objectContaining({
          updateSheetProperties: expect.objectContaining({
            properties: expect.objectContaining({
              sheetId: 123,
              gridProperties: {
                rowCount: 8,
                columnCount: 10,
              },
            }),
          }),
        }),
        expect.objectContaining({
          addTable: expect.objectContaining({
            table: expect.objectContaining({
              tableId: "cwl_Tab_1_1_123_5_8_0_10",
              name: "CWL_Rotation_Export_123_1",
              range: expect.objectContaining({
                sheetId: 123,
                startRowIndex: 5,
                endRowIndex: 8,
                startColumnIndex: 0,
                endColumnIndex: 10,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          repeatCell: expect.objectContaining({
            range: expect.objectContaining({
              startRowIndex: 6,
              endRowIndex: 7,
              startColumnIndex: 3,
              endColumnIndex: 4,
            }),
            cell: expect.objectContaining({
              userEnteredFormat: expect.objectContaining({
                backgroundColor: expect.objectContaining({
                  red: 0.7176470588,
                  green: 0.8823529412,
                  blue: 0.8039215686,
                }),
              }),
            }),
          }),
        }),
        expect.objectContaining({
          repeatCell: expect.objectContaining({
            range: expect.objectContaining({
              startRowIndex: 6,
              endRowIndex: 7,
              startColumnIndex: 4,
              endColumnIndex: 10,
            }),
            cell: expect.objectContaining({
              userEnteredFormat: expect.objectContaining({
                backgroundColor: expect.objectContaining({
                  red: 0.9568627451,
                  green: 0.7803921569,
                  blue: 0.7647058824,
                }),
              }),
            }),
          }),
        }),
        expect.objectContaining({
          repeatCell: expect.objectContaining({
            range: expect.objectContaining({
              startRowIndex: 7,
              endRowIndex: 8,
              startColumnIndex: 3,
              endColumnIndex: 10,
            }),
            cell: expect.objectContaining({
              userEnteredFormat: expect.objectContaining({
                backgroundColor: expect.objectContaining({
                  red: 0.9568627451,
                  green: 0.7803921569,
                  blue: 0.7647058824,
                }),
              }),
            }),
          }),
        }),
      ]),
    });
    expect(requestConfig).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer test-token",
      }),
    });

    const requests = (postSpy.mock.calls[0]?.[1] as any)?.requests as Array<Record<string, unknown>>;
    expect(requests.some((request) => "setBasicFilter" in request)).toBe(false);
  });

  it("recreates cached export tables without leaving duplicate native table state behind", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata")
      .mockResolvedValueOnce({
        spreadsheetId: "sheet-1",
        title: "CWL Export",
        sheets: [{ sheetId: 123, title: "Tab 1", index: 0, hidden: false, tables: [] }],
      })
      .mockResolvedValueOnce({
        spreadsheetId: "sheet-1",
        title: "CWL Export",
        sheets: [
          {
            sheetId: 123,
            title: "Tab 1",
            index: 0,
            hidden: false,
            tables: [
              {
                tableId: "existing-table",
                name: "CWL_Rotation_Export_123_1",
                range: {
                  sheetId: 123,
                  startRowIndex: 5,
                  endRowIndex: 8,
                  startColumnIndex: 0,
                  endColumnIndex: 10,
                },
              },
            ],
          },
        ],
      });
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });

    const payload = {
      spreadsheetId: "sheet-1",
      tabs: [
        {
          tabName: "Tab 1",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Alpha"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
            ["Bravo", "#QGRJ2222", "0", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 8,
              startColumnIndex: 0,
              endColumnIndex: 10,
              headerRowIndex: 5,
            },
          ],
        },
      ],
    } as const;

    await service.formatSpreadsheetTabs(payload);
    await service.formatSpreadsheetTabs(payload);

    expect(postSpy).toHaveBeenCalledTimes(3);
    expect(postSpy.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        requests: [
          expect.objectContaining({
            deleteTable: {
              tableId: "existing-table",
            },
          }),
        ],
      }),
    );
    expect(postSpy.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        requests: expect.arrayContaining([
          expect.objectContaining({
            addTable: expect.objectContaining({
              table: expect.objectContaining({
                tableId: "cwl_Tab_1_1_123_5_8_0_10",
                name: "CWL_Rotation_Export_123_1",
              }),
            }),
          }),
        ]),
      }),
    );
  });

  it("recognizes both legacy and new bot-owned native tables while leaving unrelated tables alone", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "CWL Export",
      sheets: [
        {
          sheetId: 123,
          title: "Tab 1",
          index: 0,
          hidden: false,
          tables: [
            {
              tableId: "legacy-export-table",
              name: "CWL Rotation Export Tab_1 1",
              range: {
                sheetId: 123,
                startRowIndex: 5,
                endRowIndex: 8,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
            },
            {
              tableId: "new-export-table",
              name: "CWL_Rotation_Export_123_1",
              range: {
                sheetId: 123,
                startRowIndex: 5,
                endRowIndex: 8,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
            },
            {
              tableId: "user-table",
              name: "User Created Table",
              range: {
                sheetId: 123,
                startRowIndex: 1,
                endRowIndex: 3,
                startColumnIndex: 0,
                endColumnIndex: 2,
              },
            },
          ],
        },
      ],
    });
    const postSpy = vi.spyOn(axios, "post").mockResolvedValue({ data: {} });

    await service.formatSpreadsheetTabs({
      spreadsheetId: "sheet-1",
      tabs: [
        {
          tabName: "Tab 1",
          values: [
            ["Season: 2026-04"],
            ["Roster: Master Roster"],
            ["Clan: CWL Alpha"],
            ["Clan Tag: #2QG2C08UP"],
            [],
            ["Member", "Player Tag", "Total Wars", "Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"],
            ["Alpha", "#PYLQ0289", "1", "IN", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
            ["Bravo", "#QGRJ2222", "0", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT", "OUT"],
          ],
          tableRanges: [
            {
              startRowIndex: 5,
              endRowIndex: 8,
              startColumnIndex: 0,
              endColumnIndex: 10,
              headerRowIndex: 5,
            },
          ],
        },
      ],
    });

    const deleteRequestBodies = postSpy.mock.calls
      .map((call) => call[1] as any)
      .filter(
        (body) =>
          Array.isArray(body?.requests) &&
          body.requests.some((request: any) => "deleteTable" in request),
      );
    const deleteTableIds = deleteRequestBodies
      .flatMap((body) => body.requests as Array<Record<string, unknown>>)
      .filter((request) => "deleteTable" in request)
      .map((request) => (request as any).deleteTable.tableId as string);

    expect(deleteTableIds).toEqual(["legacy-export-table", "new-export-table"]);
    expect(deleteTableIds).not.toContain("user-table");
  });
});
