import { beforeEach, describe, expect, it, vi } from "vitest";

const inactiveWarServiceMock = vi.hoisted(() => ({
  listInactiveWarPlayers: vi.fn(),
}));

vi.mock("../src/services/InactiveWarService", async () => {
  const actual = await vi.importActual("../src/services/InactiveWarService");
  return {
    ...actual,
    InactiveWarService: class {
      listInactiveWarPlayers = inactiveWarServiceMock.listInactiveWarPlayers;
    },
  };
});

import { Inactive } from "../src/commands/Inactive";

function makeInteraction(warsValue: number | null) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: "guild-1",
    deferReply,
    editReply,
    options: {
      getInteger: vi.fn((name: string) => {
        if (name === "wars") return warsValue;
        if (name === "days") return null;
        return null;
      }),
    },
  };
}

describe("/inactive command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders wars mode output from the inactive war service", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "#AAA111",
          playerTag: "#B",
          playerName: "Bravo",
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: 47.5,
          lateAttacks: 1,
          warsAvailable: 3,
        },
      ],
      trackedTags: ["#AAA111"],
      trackedNameByTag: new Map([["#AAA111", "Alpha"]]),
      warnings: [],
    });

    const interaction = makeInteraction(3);
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
      })
    );
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Missed Both Attacks - Last 3 War(s) (1)");
    expect(embed.description).toContain("Bravo");
    expect(embed.description).toContain("missed both in 3/3 war(s)");
  });
});
