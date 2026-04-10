import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import { Compo } from "../src/commands/Compo";
import { CompoPlaceService } from "../src/services/CompoPlaceService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";

function makeInteraction(weight: string) {
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
      getSubcommand: vi.fn(() => "place"),
      getString: vi.fn((name: string) => {
        if (name === "weight") return weight;
        return null;
      }),
    },
  };
  return interaction;
}

function getComponentCustomIds(payload: unknown): string[] {
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

describe("/compo place command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the place service and keeps sheet access out of the command layer", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: ["#AAA111"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const interaction = makeInteraction("145k");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(145000, "TH15");
    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(
      getComponentCustomIds(payload).some((id) =>
        id.startsWith("compo-refresh:place:"),
      ),
    ).toBe(true);
  });

  it("maps lower persisted weight buckets into the stable <=TH13 place bucket", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "Mode Displayed: **PLACE**",
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      });

    const interaction = makeInteraction("100000");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(100000, "<=TH13");
  });
});
