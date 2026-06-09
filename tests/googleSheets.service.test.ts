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

  it("formats exported CWL tables with a header, filter, trimmed bounds, and exact IN/OUT fills", async () => {
    const service = new GoogleSheetsService({} as any);
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("test-token");
    vi.spyOn(service, "getSpreadsheetMetadata").mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "CWL Export",
      sheets: [{ sheetId: 123, title: "Tab 1", index: 0, hidden: false }],
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
    expect(postSpy).toHaveBeenCalledWith(
      "https://sheets.googleapis.com/v4/spreadsheets/sheet-1:batchUpdate",
      expect.objectContaining({
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
            setBasicFilter: expect.objectContaining({
              filter: expect.objectContaining({
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
                sheetId: 123,
                startRowIndex: 5,
                endRowIndex: 6,
                startColumnIndex: 0,
                endColumnIndex: 10,
              }),
              cell: expect.objectContaining({
                userEnteredFormat: expect.objectContaining({
                  textFormat: expect.objectContaining({
                    bold: true,
                  }),
                }),
              }),
            }),
          }),
          expect.objectContaining({
            repeatCell: expect.objectContaining({
              range: expect.objectContaining({
                sheetId: 123,
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
                sheetId: 123,
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
                sheetId: 123,
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
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });
});
