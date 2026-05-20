import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Compo,
  buildCompoHeatMapRefCopyCustomIdForTest,
  buildCompoHeatMapRefCopyTextForTest,
  buildCompoHeatMapRefRowsForTest,
  toGlyphSafeTextForTest,
} from "../src/commands/Compo";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { BlacklistHeatmapRefService } from "../src/services/BlacklistHeatmapRefService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";
import {
  BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS,
  buildBlacklistHeatMapRefCopyText,
  buildBlacklistHeatMapRefDisplayRows,
} from "../src/helper/heatMapRefDisplay";

function makeInteraction(mode: string | null = null) {
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
      getString: vi.fn((name: string) => (name === "mode" ? mode : null)),
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
    expect(
      heatmapref?.options?.some((option) => option.name === "mode"),
    ).toBe(true);
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
        "WeightMin,WeightMax,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Match%,# Clans\n" +
        "0,100,3,6,7,9,9,8,5,2,83.42%,4",
    } as never);

    const interaction = makeInteraction();
    await Compo.run({} as any, interaction as any, {} as any);

    expect(GoogleSheetsService.prototype.getCompoLinkedSheet).not.toHaveBeenCalled();
    expect(GoogleSheetsService.prototype.readCompoLinkedValues).not.toHaveBeenCalled();
    expect(HeatMapRefDisplayService.prototype.readHeatMapRefDisplayTable).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(payload?.files?.[0]?.name).toBe("compo-heatmapref.png");
    expect(collectButtonCustomIds(payload)).toEqual([
      buildCompoHeatMapRefCopyCustomIdForTest("user-1"),
    ]);
  });

  it("treats mode:fwa as the default HeatMapRef view", async () => {
    vi.spyOn(GoogleSheetsService.prototype, "getCompoLinkedSheet").mockResolvedValue(null as never);
    vi.spyOn(GoogleSheetsService.prototype, "readCompoLinkedValues").mockResolvedValue([] as never);
    const blacklistSpy = vi
      .spyOn(BlacklistHeatmapRefService.prototype, "readBlacklistHeatMapRefDisplayTable")
      .mockResolvedValue({
        rows: [],
        copyText: "",
      } as never);
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
        "WeightMin,WeightMax,TH18,TH17,TH16,TH15,TH14,TH13,TH12,TH11+,Match%,# Clans\n" +
        "0,100,3,6,7,9,9,8,5,2,83.42%,4",
    } as never);

    const interaction = makeInteraction("fwa");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(HeatMapRefDisplayService.prototype.readHeatMapRefDisplayTable).toHaveBeenCalledTimes(1);
    expect(blacklistSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(payload?.files?.[0]?.name).toBe("compo-heatmapref.png");
    expect(collectButtonCustomIds(payload)).toEqual([
      buildCompoHeatMapRefCopyCustomIdForTest("user-1"),
    ]);
  });

  it("renders persisted blacklist HeatMapRef rows and a mode-aware copy button", async () => {
    vi.spyOn(BlacklistHeatmapRefService.prototype, "readBlacklistHeatMapRefDisplayTable").mockResolvedValue({
      rows: [
        BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS,
        [
          "0 - 100000",
          "10",
          "9",
          "8",
          "7",
          "6",
          "5",
          "4",
          "1",
          "3",
          "2",
          "4",
          "high (92)",
          "2026-05-20 12:34Z",
        ],
      ],
      copyText:
        buildBlacklistHeatMapRefCopyText({
          heatMapRefs: [
            {
              weightMinInclusive: 0,
              weightMaxInclusive: 100000,
              th18Count: 10,
              th17Count: 9,
              th16Count: 8,
              th15Count: 7,
              th14Count: 6,
              th13Count: 5,
              th12Count: 4,
              th11PlusCount: 1,
              sampleCount: 3,
              uniqueSourceClanCount: 2,
              uniqueOpponentCount: 4,
              confidenceLabel: "high",
              confidenceScore: 92,
              generatedAt: new Date("2026-05-20T12:34:00.000Z"),
            } as never,
          ],
        }),
    } as never);

    const interaction = makeInteraction("blacklist");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(BlacklistHeatmapRefService.prototype.readBlacklistHeatMapRefDisplayTable).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(payload?.files?.[0]?.name).toBe("compo-heatmapref-blacklist.png");
    expect(payload?.components).toBeDefined();
    expect(collectButtonCustomIds(payload)).toEqual([
      buildCompoHeatMapRefCopyCustomIdForTest("user-1", "blacklist"),
    ]);
  });

  it("shows an actionable empty state when the blacklist profile has no rows", async () => {
    vi.spyOn(BlacklistHeatmapRefService.prototype, "readBlacklistHeatMapRefDisplayTable").mockResolvedValue({
      rows: [BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS],
      copyText: "",
    } as never);

    const interaction = makeInteraction("blacklist");
    await Compo.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(payload?.content).toContain("/fwa blacklist-profile rebuild");
    expect(payload?.files).toBeUndefined();
    expect(payload?.components).toEqual([]);
  });

  it("formats blacklist HeatMapRef rows with metadata columns", () => {
    const rows = buildBlacklistHeatMapRefDisplayRows({
      heatMapRefs: [
        {
          weightMinInclusive: 0,
          weightMaxInclusive: 100000,
          th18Count: 10,
          th17Count: 9,
          th16Count: 8,
          th15Count: 7,
          th14Count: 6,
          th13Count: 5,
          th12Count: 4,
          th11PlusCount: 3,
          sampleCount: 12,
          uniqueSourceClanCount: 4,
          uniqueOpponentCount: 5,
          confidenceLabel: "medium",
          confidenceScore: 68,
          generatedAt: new Date("2026-05-20T12:34:00.000Z"),
        } as never,
      ],
    });

    expect(rows[0]).toEqual(BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS);
    expect(rows[1]).toEqual([
      "0 - 100,000",
      "10",
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "12",
      "4",
      "5",
      "medium (68)",
      "2026-05-20 12:34Z",
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

  it("wraps heatmapref copy text in a formatted text block", () => {
    expect(
      buildCompoHeatMapRefCopyTextForTest(
        "WeightMin,WeightMax,TH18,TH17\n0,100,3,6",
      ),
    ).toBe("```text\nWeightMin,WeightMax,TH18,TH17\n0,100,3,6\n```");
  });

  it("keeps glyph-safe renderer text literal for plus and percent characters", () => {
    expect(toGlyphSafeTextForTest("TH11+")).toBe("TH11+");
    expect(toGlyphSafeTextForTest("Match%")).toBe("MATCH%");
    expect(toGlyphSafeTextForTest("0%")).toBe("0%");
    expect(toGlyphSafeTextForTest("83.42%")).toBe("83.42%");
  });
});
