import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo, mapCompoSheetErrorToMessageForTest } from "../src/commands/Compo";
import {
  GoogleSheetReadError,
  GoogleSheetReadErrorCode,
  GoogleSheetsService,
} from "../src/services/GoogleSheetsService";

const FIXED_LAYOUT_RANGE = "AllianceDashboard!A6:BD500";
const LOOKUP_REFRESH_RANGE = "Lookup!B10:B10";

function makeRows(): string[][] {
  const rows = Array.from({ length: 8 }, () => Array.from({ length: 56 }, () => ""));
  const actualRow = rows[1];
  actualRow[0] = "DARK EMPIRE";
  actualRow[1] = "#LQQ99UV8";
  actualRow[3] = "1,470,000";
  actualRow[20] = "1";
  actualRow[21] = "0";
  actualRow[22] = "0";
  actualRow[23] = "-1";
  actualRow[24] = "0";
  actualRow[25] = "0";
  actualRow[26] = "0";
  actualRow[48] = "1,500,000";
  actualRow[53] = "Add 1x TH16";
  return rows;
}

function makeInteraction(params: {
  subcommand: "advice" | "state" | "place";
  tag?: string;
  mode?: string | null;
  weight?: string;
}) {
  const interaction: any = {
    commandName: "compo",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => params.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag ?? null;
        if (name === "mode") return params.mode ?? null;
        if (name === "weight") return params.weight ?? null;
        return null;
      }),
    },
  };
  return interaction;
}

function makeReadError(code: GoogleSheetReadErrorCode): GoogleSheetReadError {
  return new GoogleSheetReadError(code, code, {
    action: "readValues",
    range: FIXED_LAYOUT_RANGE,
    resolutionSource: "google_sheet_id",
    source: "proxy",
    httpStatus: 403,
  });
}

describe("/compo strict sheet read path", () => {
  const linkedSheet = {
    sheetId: "sheet-1",
    tabName: "AllianceDashboard",
    source: "google_sheet_id" as const,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      subcommand: "advice" as const,
      tag: "#LQQ99UV8",
      expectedRanges: [FIXED_LAYOUT_RANGE],
    },
    {
      subcommand: "state" as const,
      expectedRanges: [FIXED_LAYOUT_RANGE, LOOKUP_REFRESH_RANGE],
    },
    {
      subcommand: "place" as const,
      weight: "151k",
      expectedRanges: [FIXED_LAYOUT_RANGE, LOOKUP_REFRESH_RANGE],
    },
  ])("uses strict canonical resolver for /compo $subcommand", async (testCase) => {
    const getCompoLinkedSheetSpy = vi
      .spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet")
      .mockResolvedValue(linkedSheet);
    const readCompoLinkedValuesSpy = vi
      .spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues")
      .mockImplementation(async (range: string) => {
        if (range === LOOKUP_REFRESH_RANGE) return [["1709900000"]];
        return makeRows();
      });

    const interaction = makeInteraction(testCase);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        memberList: Array.from({ length: 49 }, () => ({ tag: "#P" })),
      }),
    };

    await Compo.run({} as any, interaction as any, cocService as any);

    expect(getCompoLinkedSheetSpy).toHaveBeenCalledTimes(1);
    expect(getCompoLinkedSheetSpy).toHaveBeenCalledWith(FIXED_LAYOUT_RANGE);
    const ranges = readCompoLinkedValuesSpy.mock.calls.map((call) => String(call[0] ?? ""));
    expect(ranges).toEqual(testCase.expectedRanges);
    for (const call of readCompoLinkedValuesSpy.mock.calls) {
      expect(call[1]).toBe(linkedSheet);
    }
  });

  it.each([
    { subcommand: "advice" as const, tag: "#LQQ99UV8" },
    { subcommand: "state" as const },
    { subcommand: "place" as const, weight: "151k" },
  ])(
    "maps normalized sheet errors consistently for /compo $subcommand",
    async (testCase) => {
      vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue(
        linkedSheet
      );
      vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues").mockRejectedValue(
        makeReadError("SHEET_PROXY_UNAUTHORIZED")
      );

      const interaction = makeInteraction(testCase);
      const cocService = { getClan: vi.fn() };

      await Compo.run({} as any, interaction as any, cocService as any);

      const payload = interaction.editReply.mock.calls.at(-1)?.[0];
      expect(String(payload?.content ?? "")).toBe(
        "The linked compo sheet could not be accessed because the sheet proxy is not authorized."
      );
    }
  );
});

describe("/compo error message mapping", () => {
  it("maps all normalized sheet codes to stable user messages", () => {
    const cases: Array<{ code: GoogleSheetReadErrorCode; message: string }> = [
      {
        code: "SHEET_LINK_MISSING",
        message: "No compo sheet is linked for this server.",
      },
      {
        code: "SHEET_PROXY_UNAUTHORIZED",
        message:
          "The linked compo sheet could not be accessed because the sheet proxy is not authorized.",
      },
      {
        code: "SHEET_ACCESS_DENIED",
        message:
          "The linked compo sheet exists, but this bot does not currently have access to read it.",
      },
      {
        code: "SHEET_RANGE_INVALID",
        message:
          "The linked compo sheet does not contain the expected AllianceDashboard layout.",
      },
      {
        code: "SHEET_READ_FAILURE",
        message: "The compo sheet could not be read due to a sheet service error.",
      },
    ];

    for (const testCase of cases) {
      const err = makeReadError(testCase.code);
      expect(mapCompoSheetErrorToMessageForTest(err)).toBe(testCase.message);
    }

    expect(mapCompoSheetErrorToMessageForTest(new Error("boom"))).toBe(
      "The compo sheet could not be read due to a sheet service error."
    );
  });
});

