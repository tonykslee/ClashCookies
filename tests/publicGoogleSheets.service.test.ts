import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

type AxiosMock = {
  get: ReturnType<typeof vi.fn>;
};

import { PublicGoogleSheetsService } from "../src/services/PublicGoogleSheetsService";

describe("PublicGoogleSheetsService", () => {
  const mockedAxios = axios as unknown as AxiosMock;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockedAxios.get.mockReset();
  });

  it("parses published workbook tabs without auth", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: `
        <html>
          <head><title>Imported CWL Planner - Google Sheets</title></head>
          <body>
            <script>
              var items = [];
              items.push({name: "CWL Alpha roster", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/e\\/published-id\\/pubhtml\\/sheet?headers\\x3dfalse&gid=0", gid: "0",initialSheet: ("0" == gid)});
              items.push({name: "Unmatched tab", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/e\\/published-id\\/pubhtml\\/sheet?headers\\x3dfalse&gid=1", gid: "1",initialSheet: ("1" == gid)});
            </script>
          </body>
        </html>
      `,
    });
    const service = new PublicGoogleSheetsService();

    const workbook = await service.readPublishedWorkbook(
      "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml",
    );

    expect(workbook.title).toBe("Imported CWL Planner");
    expect(workbook.tabs).toEqual([
      {
        title: "CWL Alpha roster",
        pageUrl:
          "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
        gid: "0",
      },
      {
        title: "Unmatched tab",
        pageUrl:
          "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=1",
        gid: "1",
      },
    ]);
  });

  it("parses published sheet values from the anonymous tab page", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: `
        <html>
          <body>
            <table class="waffle">
              <tbody>
                <tr><th>1</th><td class="s0">Day 1</td></tr>
                <tr><th>2</th><td class="s0">:black_circle: Alpha (#PYLQ0289)</td><td class="s0">Bravo &amp; Co</td></tr>
              </tbody>
            </table>
          </body>
        </html>
      `,
    });
    const service = new PublicGoogleSheetsService();

    const values = await service.readPublishedSheetValues(
      "https://docs.google.com/spreadsheets/d/e/published-id/pubhtml/sheet?headers=false&gid=0",
    );

    expect(values).toEqual([
      ["Day 1"],
      [":black_circle: Alpha (#PYLQ0289)", "Bravo & Co"],
    ]);
  });

  it("surfaces a public-sheet-specific error when the workbook cannot be fetched", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"));
    const service = new PublicGoogleSheetsService();

    await expect(
      service.readPublishedWorkbook("https://docs.google.com/spreadsheets/d/e/published-id/pubhtml"),
    ).rejects.toThrow("Unable to read the public Google Sheet import");
  });
});
