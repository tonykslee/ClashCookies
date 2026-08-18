import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";

const historyMock = vi.hoisted(() => ({ listRecentByClan: vi.fn() }));
vi.mock("../src/services/ClanWarHistoryService", () => ({
  ClanWarHistoryService: class {
    listRecentByClan = historyMock.listRecentByClan;
  },
}));

import { War } from "../src/commands/War";

describe("/war command shape", () => {
  it("registers war-id as a subcommand with required clan-tag and autocompleted war-id", () => {
    const warIdSubcommand = War.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "war-id"
    );
    expect(warIdSubcommand).toBeTruthy();

    const clanTagOption = warIdSubcommand?.options?.find(
      (option) => option.name === "clan-tag"
    );
    expect(clanTagOption?.required).toBe(true);
    expect(clanTagOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(clanTagOption?.autocomplete).toBe(true);

    const warIdOption = warIdSubcommand?.options?.find((option) => option.name === "war-id");
    expect(warIdOption?.required).toBe(true);
    expect(warIdOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(warIdOption?.autocomplete).toBe(true);
  });

  it("keeps /war history latest-N querying and ten-field rendering behavior", async () => {
    historyMock.listRecentByClan.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        warId: index + 1,
        syncNumber: index + 1,
        matchType: "FWA",
        clanStars: 30,
        clanDestruction: 100,
        opponentStars: 28,
        opponentDestruction: 95,
        pointsAfterWar: 1500,
        expectedOutcome: "WIN",
        actualOutcome: "WIN",
        warStartTime: new Date("2026-03-01T00:00:00.000Z"),
        warEndTime: new Date("2026-03-01T02:00:00.000Z"),
        clanName: "Alpha",
        clanTag: "#AAA111",
        opponentName: "Opponent",
        opponentTag: "#BBB222",
      })),
    );
    const interaction = {
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      options: {
        getSubcommand: vi.fn().mockReturnValue("history"),
        getString: vi.fn().mockReturnValue("pylq02"),
        getInteger: vi.fn().mockReturnValue(50),
      },
    };

    await War.run({} as any, interaction as any, {} as any);

    expect(historyMock.listRecentByClan).toHaveBeenCalledWith({
      clanTag: "#PYLQ02",
      limit: 50,
    });
    const payload = interaction.editReply.mock.calls[0][0];
    expect(payload.embeds[0].data.description).toBe("Showing latest 12 war(s).");
    expect(payload.embeds[0].data.fields).toHaveLength(10);
  });
});
