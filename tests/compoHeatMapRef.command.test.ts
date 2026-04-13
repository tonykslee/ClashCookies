import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Compo, buildCompoHeatMapRefRowsForTest } from "../src/commands/Compo";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import * as HeatMapRefService from "../src/services/HeatMapRefService";

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

    const heatMapRefs = [
      {
        weightMinInclusive: 0,
        weightMaxInclusive: 7_200_000,
        th18Count: 3,
        th17Count: 6,
        th16Count: 7,
        th15Count: 9,
        th14Count: 9,
        th13Count: 8,
        th12Count: 5,
        th11Count: 2,
        th10OrLowerCount: 0,
        contributingClanCount: 4,
        sourceVersion: "bootstrap-2026-03-17",
        refreshedAt: new Date("2026-04-13T00:00:00.000Z"),
      },
    ];
    vi.spyOn(HeatMapRefService, "getAllHeatMapRefs").mockResolvedValue(heatMapRefs as never);

    const interaction = makeInteraction();
    await Compo.run({} as any, interaction as any, {} as any);

    expect(GoogleSheetsService.prototype.getCompoLinkedSheet).not.toHaveBeenCalled();
    expect(GoogleSheetsService.prototype.readCompoLinkedValues).not.toHaveBeenCalled();
    expect(HeatMapRefService.getAllHeatMapRefs).toHaveBeenCalledTimes(1);
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.files)).toBe(true);
    expect(payload?.files?.[0]?.name).toBe("compo-heatmapref.png");
    expect(Object.prototype.hasOwnProperty.call(payload, "components")).toBe(false);
  });

  it("formats the HeatMapRef table rows with a Clans column", () => {
    const rows = buildCompoHeatMapRefRowsForTest([
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
    ]);

    expect(rows[0]).toEqual([
      "Band",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "TH13",
      "TH12",
      "TH11",
      "<=TH10",
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
      "8",
      "9",
      "11",
    ]);
  });
});
