import { beforeEach, describe, expect, it, vi } from "vitest";

const inactiveWarServiceMock = vi.hoisted(() => ({
  listInactiveWarPlayers: vi.fn(),
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForClanMembers: vi.fn(),
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

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerLinkService")>(
    "../src/services/PlayerLinkService",
  );
  return {
    ...actual,
    listPlayerLinksForClanMembers: playerLinkServiceMock.listPlayerLinksForClanMembers,
  };
});

import { Inactive } from "../src/commands/Inactive";

function makeInteraction(values: {
  days?: number | null;
  wars?: number | null;
  clan?: string | null;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: "guild-1",
    deferReply,
    editReply,
    options: {
      getInteger: vi.fn((name: string) => {
        if (name === "wars") return values.wars ?? null;
        if (name === "days") return values.days ?? null;
        return null;
      }),
      getString: vi.fn((name: string) => {
        if (name === "clan") return values.clan ?? null;
        return null;
      }),
    },
  };
}

describe("/inactive command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes clanTag to the inactive war service for wars mode", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      warnings: [],
      diagnosticNote: null,
    });

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(inactiveWarServiceMock.listInactiveWarPlayers).toHaveBeenCalledWith({
      guildId: "guild-1",
      wars: 3,
      clanTag: "#AAA111",
    });
  });

  it("renders grouped wars output with linked Discord users, ratios, and missed-war emojis", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "A1",
          playerName: "Alpha One",
          missedWars: 3,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: 47.5,
          lateAttacks: 1,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "WIN", emoji: "🟢" },
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "LOSE", emoji: "🔴" },
            { warId: "501", warStartTime: null, warEndTime: null, matchType: "BL", outcome: null, emoji: "⚫" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "A2",
          playerName: "Alpha Two",
          missedWars: 2,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: 12,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "UNKNOWN", outcome: null, emoji: "🔘" },
          ],
        },
        {
          clanTag: "BBB222",
          playerTag: "B1",
          playerName: "Beta One",
          missedWars: 1,
          participationWars: 2,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 2,
          missedWarStates: [
            { warId: "402", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
          ],
        },
      ],
      trackedTags: ["AAA111", "BBB222"],
      trackedNameByTag: new Map([
        ["AAA111", "Alpha"],
        ["BBB222", "Beta"],
      ]),
      warnings: [],
      diagnosticNote: null,
    });

    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([
      { playerTag: "#A1", discordUserId: "111111111111111111" },
      { playerTag: "#B1", discordUserId: "222222222222222222" },
    ]);

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(playerLinkServiceMock.listPlayerLinksForClanMembers).toHaveBeenCalledWith({
      memberTagsInOrder: ["#A1", "#A2", "#B1"],
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
      }),
    );
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Missed Both Attacks - Last 3 War(s) (3)");
    expect(embed.description).toContain("Alpha (2)");
    expect(embed.description).toContain("2 wars missed");
    expect(embed.description).toContain("Beta (1)");
    expect(embed.description).toContain("1 war missed");
    expect(embed.description).toContain("Alpha One `#A1` <@111111111111111111> - 🟢 🔴 ⚫");
    expect(embed.description).toContain("Alpha Two `#A2` — - 2/3 wars missed - ⚪ 🔘");
    expect(embed.description).toContain("Beta One `#B1` <@222222222222222222> - 1/2 wars missed - ⚪");
    expect(embed.description).not.toContain("true stars");
    expect(embed.description).not.toContain("avg delay");
    expect(embed.description).not.toContain("late attacks");
    expect(embed.description).not.toContain("3/3 wars missed");
  });

  it("shows ratios for other missed-war count combinations", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [
        {
          clanTag: "AAA111",
          playerTag: "C1",
          playerName: "Charlie One",
          missedWars: 2,
          participationWars: 2,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 2,
          missedWarStates: [
            { warId: "502", warStartTime: null, warEndTime: null, matchType: "BL", outcome: null, emoji: "⚫" },
            { warId: "501", warStartTime: null, warEndTime: null, matchType: "MM", outcome: null, emoji: "⚪" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "C2",
          playerName: "Charlie Two",
          missedWars: 1,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [
            { warId: "503", warStartTime: null, warEndTime: null, matchType: "UNKNOWN", outcome: null, emoji: "🔘" },
          ],
        },
        {
          clanTag: "AAA111",
          playerTag: "C3",
          playerName: "Charlie Three",
          missedWars: 1,
          participationWars: 1,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 1,
          missedWarStates: [
            { warId: "504", warStartTime: null, warEndTime: null, matchType: "FWA", outcome: "LOSE", emoji: "🔴" },
          ],
        },
      ],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      warnings: [],
      diagnosticNote: null,
    });
    playerLinkServiceMock.listPlayerLinksForClanMembers.mockResolvedValue([]);

    const interaction = makeInteraction({ wars: 3 });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain("2/2 wars missed");
    expect(embed.description).toContain("1/3 wars missed");
    expect(embed.description).toContain("1/1 wars missed");
  });

  it("includes the scoped diagnostic note when the selected clan has no wars results", async () => {
    inactiveWarServiceMock.listInactiveWarPlayers.mockResolvedValue({
      results: [],
      trackedTags: ["AAA111"],
      trackedNameByTag: new Map([["AAA111", "Alpha"]]),
      warnings: [],
      diagnosticNote: "Diagnostic: ended wars found yes (3), participation rows found yes (6).",
    });

    const interaction = makeInteraction({ wars: 3, clan: "#AAA111" });
    const cocService = {} as any;

    await Inactive.run({} as any, interaction as any, cocService);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("No players found in Alpha who missed both attacks in at least one of the last 3 ended war(s)."),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Diagnostic: ended wars found yes (3), participation rows found yes (6)."),
    );
  });
});
