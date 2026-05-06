import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
  currentCwlRound: {
    findUnique: vi.fn(),
  },
  currentCwlPrepSnapshot: {
    findUnique: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildBaseSwapClanAutocompleteChoices,
  resolveBaseSwapRosterForClan,
} from "../src/services/BaseSwapRosterService";

const fwaClanTag = "#2QG2C08UP";
const fwaSecondClanTag = "#QG2CU8UP8";
const cwlSecondClanTag = "#LQ2G8U2P";
const playerAlphaTag = "#PQLQ2Q8U";
const playerBravoTag = "#C2QG8UP8";
const opponentTag = "#QG2CUP9";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.trackedClan.findFirst.mockResolvedValue(null);
  prismaMock.trackedClan.findMany.mockResolvedValue([]);
  prismaMock.cwlTrackedClan.findFirst.mockResolvedValue(null);
  prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentCwlRound.findUnique.mockResolvedValue(null);
  prismaMock.currentCwlPrepSnapshot.findUnique.mockResolvedValue(null);
  prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
  prismaMock.playerLink.findMany.mockResolvedValue([]);
});

describe("BaseSwapRosterService", () => {
  it("resolves FWA tracked clans from the active war roster", async () => {
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        clan: {
          tag: fwaClanTag,
          name: "Alpha FWA",
          members: [
            { tag: playerBravoTag, name: "Bravo", mapPosition: 2, townhallLevel: 17 },
            { tag: playerAlphaTag, name: "Alpha", mapPosition: 1, townhallLevel: 18 },
          ],
        },
        opponent: {
          tag: opponentTag,
          name: "Opponent",
          members: [],
        },
      }),
    };

    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha FWA",
    });
    prismaMock.currentWar.findFirst.mockResolvedValue({
      state: "inWar",
      startTime: new Date("2026-05-01T12:00:00.000Z"),
      endTime: new Date("2026-05-01T13:00:00.000Z"),
    });
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: playerAlphaTag, discordUserId: "100" },
      { playerTag: playerBravoTag, discordUserId: "200" },
    ]);

    const result = await resolveBaseSwapRosterForClan({
      clanRef: `fwa:${fwaClanTag}`,
      guildId: "guild-1",
      cocService: cocService as any,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roster.clanKind).toBe("FWA");
    expect(result.roster.clanTag).toBe("2QG2C08UP");
    expect(result.roster.clanName).toBe("Alpha FWA");
    expect(result.roster.rosterMembers).toHaveLength(2);
    expect(result.roster.rosterMembers).toMatchObject([
      {
        position: 1,
        playerTag: playerAlphaTag,
        playerName: "Alpha",
        townhallLevel: 18,
      },
      {
        position: 2,
        playerTag: playerBravoTag,
        playerName: "Bravo",
        townhallLevel: 17,
      },
    ]);
    expect(cocService.getCurrentWar).toHaveBeenCalledWith("2QG2C08UP");
  });

  it("resolves CWL tracked clans from the persisted active lineup without calling live CoC", async () => {
    const cocService = {
      getCurrentWar: vi.fn(),
    };

    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha FWA",
    });
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha CWL",
    });
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-05",
      clanTag: fwaClanTag,
      clanName: "Alpha CWL",
      roundDay: 3,
      roundState: "inWar",
      opponentTag,
      opponentName: "Opponent",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: new Date("2026-05-02T11:00:00.000Z"),
      startTime: new Date("2026-05-02T12:00:00.000Z"),
      endTime: new Date("2026-05-02T13:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-05-02T12:15:00.000Z"),
    });
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: playerAlphaTag,
        playerName: "Alpha",
        mapPosition: 1,
        townHall: 18,
        attacksUsed: 0,
        attacksAvailable: 2,
        stars: 0,
        destruction: 0,
        subbedIn: true,
        subbedOut: false,
      },
      {
        playerTag: playerBravoTag,
        playerName: "Bravo",
        mapPosition: 2,
        townHall: 17,
        attacksUsed: 0,
        attacksAvailable: 2,
        stars: 0,
        destruction: 0,
        subbedIn: true,
        subbedOut: false,
      },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: playerAlphaTag, discordUserId: "100" },
      { playerTag: playerBravoTag, discordUserId: "200" },
    ]);

    const result = await resolveBaseSwapRosterForClan({
      clanRef: `cwl:${fwaClanTag}`,
      guildId: "guild-1",
      season: "2026-05",
      cocService: cocService as any,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roster.clanKind).toBe("CWL");
    expect(result.roster.clanTag).toBe("2QG2C08UP");
    expect(result.roster.clanName).toBe("Alpha CWL");
    expect(result.roster.rosterMembers).toHaveLength(2);
    expect(result.roster.rosterMembers).toMatchObject([
      {
        position: 1,
        playerTag: playerAlphaTag,
        playerName: "Alpha",
        townhallLevel: 18,
      },
      {
        position: 2,
        playerTag: playerBravoTag,
        playerName: "Bravo",
        townhallLevel: 17,
      },
    ]);
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
  });

  it("returns a clear error when a tracked CWL clan has no active lineup", async () => {
    const result = await resolveBaseSwapRosterForClan({
      clanRef: fwaClanTag,
      guildId: "guild-1",
      season: "2026-05",
      cocService: {
        getCurrentWar: vi.fn(),
      } as any,
    });

    expect(result).toEqual({
      ok: false,
      error: "Clan #2QG2C08UP is not in tracked FWA or current-season CWL clans.",
    });

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha CWL",
    });
    const noLineupResult = await resolveBaseSwapRosterForClan({
      clanRef: `cwl:${fwaClanTag}`,
      guildId: "guild-1",
      season: "2026-05",
      cocService: {
        getCurrentWar: vi.fn(),
      } as any,
    });

    expect(noLineupResult).toEqual({
      ok: false,
      error: "No active CWL lineup found for this tracked CWL clan.",
    });
  });

  it("returns a disambiguation error when the same tag exists in both registries without a source prefix", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha FWA",
    });
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: fwaClanTag,
      name: "Alpha CWL",
    });

    const result = await resolveBaseSwapRosterForClan({
      clanRef: fwaClanTag,
      guildId: "guild-1",
      season: "2026-05",
      cocService: {
        getCurrentWar: vi.fn(),
      } as any,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("both FWA and current-season CWL tracked clans");
  });

  it("includes both FWA and CWL clans in autocomplete choices with source labels when needed", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: fwaClanTag, name: "Alpha FWA" },
      { tag: fwaSecondClanTag, name: "Bravo FWA" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: fwaClanTag, name: "Alpha CWL" },
      { tag: cwlSecondClanTag, name: "Charlie CWL" },
    ]);

    const choices = await buildBaseSwapClanAutocompleteChoices({
      query: "",
      season: "2026-05",
    });

    expect(choices).toEqual(
      expect.arrayContaining([
        { name: "Alpha FWA (#2QG2C08UP) [FWA]", value: "fwa:#2QG2C08UP" },
        { name: "Bravo FWA (#QG2CU8UP8)", value: "fwa:#QG2CU8UP8" },
        { name: "Alpha CWL (#2QG2C08UP) [CWL 2026-05]", value: "cwl:#2QG2C08UP" },
        { name: "Charlie CWL (#LQ2G8U2P) [CWL 2026-05]", value: "cwl:#LQ2G8U2P" },
      ]),
    );
    expect(choices).toHaveLength(4);
  });
});
