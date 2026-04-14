import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Compo,
  buildCompoHeatMapRefCopyCustomIdForTest,
  buildCompoHeatMapRefRowsForTest,
  toGlyphSafeTextForTest,
} from "../src/commands/Compo";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";

function makeInteraction() {
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
      getSubcommand: vi.fn(() => "heatmapref"),
      getString: vi.fn(() => null),
    },
  };
  return interaction;
}

function collectButtonCustomIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  return rows.flatMap((row) => {
    const normalized =
      row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
        ? (row as { toJSON: () => unknown }).toJSON()
        : row;
    if (!normalized || typeof normalized !== "object") return [];
    const components = Array.isArray((normalized as { components?: unknown[] }).components)
      ? ((normalized as { components: unknown[] }).components as unknown[])
      : [];
    return components
      .map((component) =>
        String(
          (component as { custom_id?: unknown; customId?: unknown }).custom_id ??
            (component as { custom_id?: unknown; customId?: unknown }).customId ??
            "",
        ),
      )
      .filter((value) => value.length > 0);
  });
}

describe("/compo heatmapref command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the heatmapref subcommand", () => {
    const heatmapref = Compo.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "heatmapref",
    );

    expect(heatmapref?.description).toContain("HeatMapRef");
  });

  it("reads persisted HeatMapRef rows and renders an attached PNG image", async () => {
    vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue(null as never);
    vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues").mockResolvedValue([] as never);
    vi.spyOn(HeatMapRefDisplayService.prototype, "readHeatMapRefDisplayTable").mockResolvedValue({
      rows: [
        [
          "Band",
          "TH18",
          "TH17",
          "TH16",
          "TH15",
          "TH14",
          "TH13",
          "TH12",
          "TH11+",
          "Match%",
          "Clans",
        ],
        ["0 - 100", "3", "6", "7", "9", "9", "8", "5", "2", "83.42%", "4"],
      ],
      copyText:
        "Band\tTH18\tTH17\tTH16\tTH15\tTH14\tTH13\tTH12\tTH11+\tMatch%\tClans\n" +
        "0 - 100\t3\t6\t7\t9\t9\t8\t5\t2\t83.42%\t4",
    } as never);

    const interaction = makeInteraction();
    await Compo.run({} as any, interaction as any, {} as any);

    expect(GoogleSheetsService.prototype.getCompoLinkedSheet).not.toHaveBeenCalled();
    expect(GoogleSheetsService.prototype.readCompoLinkedValues).not.toHaveBeenCalled();
    expect(HeatMapRefDisplayService.prototype.readHeatMapRefDisplayTable).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(payload?.files?.[0]?.name).toBe("compo-heatmapref.png");
    expect(collectButtonCustomIds(payload)).toEqual([
      buildCompoHeatMapRefCopyCustomIdForTest("user-1"),
    ]);
  });

  it("formats the HeatMapRef table rows with Match% and TH11+", () => {
    const rows = buildCompoHeatMapRefRowsForTest(
      [
      {
        weightMinInclusive: 0,
        weightMaxInclusive: 100,
        th18Count: 1,
        th17Count: 2,
        th16Count: 3,
        th15Count: 4,
        th14Count: 5,
        th13Count: 6,
        th12Count: 7,
        th11Count: 8,
        th10OrLowerCount: 9,
        contributingClanCount: 11,
        sourceVersion: null,
        refreshedAt: new Date("2026-04-13T00:00:00.000Z"),
      } as never,
      ],
      new Map([["0-100", "83.42%"]]),
    );

    expect(rows[0]).toEqual([
      "Band",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "TH13",
      "TH12",
      "TH11+",
      "Match%",
      "Clans",
    ]);
    expect(rows[1]).toEqual([
      "0 - 100",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "17",
      "83.42%",
      "11",
    ]);
  });

  it("keeps glyph-safe renderer text literal for plus and percent characters", () => {
    expect(toGlyphSafeTextForTest("TH11+")).toBe("TH11+");
    expect(toGlyphSafeTextForTest("Match%")).toBe("MATCH%");
    expect(toGlyphSafeTextForTest("0%")).toBe("0%");
    expect(toGlyphSafeTextForTest("83.42%")).toBe("83.42%");
  });
});
