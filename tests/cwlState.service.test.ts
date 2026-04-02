import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  currentCwlRound: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  cwlRoundHistory: {
    upsert: vi.fn(),
  },
  cwlRoundMemberHistory: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    upsert: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findUnique: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlRoundHistory: {
    findUnique: vi.fn(),
  },
  cwlRoundMemberHistory: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { cwlStateService } from "../src/services/CwlStateService";

describe("CwlStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);

    txMock.currentCwlRound.upsert.mockResolvedValue(undefined);
    txMock.currentCwlRound.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlRoundMemberCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlRoundMemberCurrent.createMany.mockResolvedValue({ count: 0 });
    txMock.cwlRoundHistory.upsert.mockResolvedValue(undefined);
    txMock.cwlRoundMemberHistory.deleteMany.mockResolvedValue({ count: 0 });
    txMock.cwlRoundMemberHistory.createMany.mockResolvedValue({ count: 0 });
    txMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
  });

  it("persists a current preparation round and current-member summaries for tracked clans", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP" },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-04",
        state: "preparation",
        clans: [
          {
            tag: "#2QG2C08UP",
            members: [
              { tag: "#PYLQ0289", name: "Alpha", townHallLevel: 16 },
              { tag: "#QGRJ2222", name: "Bravo", townHallLevel: 15 },
            ],
          },
        ],
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        preparationStartTime: "20260402T120000.000Z",
        startTime: "20260403T120000.000Z",
        endTime: "20260404T120000.000Z",
        attacksPerMember: 1,
        teamSize: 15,
        clan: {
          tag: "#2QG2C08UP",
          name: "CWL Alpha",
          members: [
            { tag: "#PYLQ0289", name: "Alpha", mapPosition: 1, townhallLevel: 16, attacks: [] },
            { tag: "#QGRJ2222", name: "Bravo", mapPosition: 2, townhallLevel: 15, attacks: [] },
          ],
        },
        opponent: {
          tag: "#Q2V8P9L2",
          name: "Opponent One",
          members: [],
        },
      }),
    };

    const result = await cwlStateService.refreshTrackedCwlState({
      cocService: cocService as any,
      season: "2026-04",
    });

    expect(result).toMatchObject({
      season: "2026-04",
      trackedClanCount: 1,
      refreshedClanCount: 1,
      currentRoundCount: 1,
      currentMemberCount: 2,
      historyRoundCount: 0,
      historyMemberCount: 0,
    });
    expect(txMock.currentCwlRound.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          roundDay: 1,
          clanName: "CWL Alpha",
          opponentTag: "#Q2V8P9L2",
          opponentName: "Opponent One",
          roundState: "preparation",
        }),
      }),
    );
    expect(txMock.cwlRoundMemberCurrent.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            season: "2026-04",
            clanTag: "#2QG2C08UP",
            playerTag: "#PYLQ0289",
            roundDay: 1,
            playerName: "Alpha",
            attacksAvailable: 0,
          }),
        ]),
      }),
    );
    expect(txMock.cwlPlayerClanSeason.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          playerTag: "#PYLQ0289",
          cwlClanTag: "#2QG2C08UP",
          daysParticipated: 1,
          lastRoundDay: 1,
        }),
      }),
    );
  });

  it("archives ended rounds into history and clears the current-round owner when no live/prep round remains", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP" },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-04",
        state: "inWar",
        clans: [
          {
            tag: "#2QG2C08UP",
            members: [{ tag: "#PYLQ0289", name: "Alpha", townHallLevel: 16 }],
          },
        ],
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "warEnded",
        preparationStartTime: "20260401T120000.000Z",
        startTime: "20260402T120000.000Z",
        endTime: "20260403T120000.000Z",
        attacksPerMember: 1,
        teamSize: 15,
        clan: {
          tag: "#2QG2C08UP",
          name: "CWL Alpha",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              mapPosition: 1,
              townhallLevel: 16,
              attacks: [{ stars: 3, destructionPercentage: 100 }],
            },
          ],
        },
        opponent: {
          tag: "#Q2V8P9L2",
          name: "Opponent One",
          members: [],
        },
      }),
    };

    const result = await cwlStateService.refreshTrackedCwlState({
      cocService: cocService as any,
      season: "2026-04",
    });

    expect(result.currentRoundCount).toBe(0);
    expect(result.historyRoundCount).toBe(1);
    expect(result.historyMemberCount).toBe(1);
    expect(txMock.currentCwlRound.deleteMany).toHaveBeenCalledWith({
      where: { season: "2026-04", clanTag: "#2QG2C08UP" },
    });
    expect(txMock.cwlRoundHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          roundDay: 1,
          roundState: "warEnded",
        }),
      }),
    );
    expect(txMock.cwlRoundMemberHistory.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            season: "2026-04",
            clanTag: "#2QG2C08UP",
            roundDay: 1,
            playerTag: "#PYLQ0289",
            playerName: "Alpha",
            attacksUsed: 1,
            stars: 3,
          }),
        ]),
      }),
    );
  });

  it("builds a DB-first season roster view with linked-user and current-round context", async () => {
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      {
        season: "2026-04",
        cwlClanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Stored Alpha",
        townHall: 16,
        daysParticipated: 2,
        lastRoundDay: 2,
      },
      {
        season: "2026-04",
        cwlClanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        playerName: "Stored Bravo",
        townHall: 15,
        daysParticipated: 1,
        lastRoundDay: 1,
      },
    ]);
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      roundDay: 3,
      clanName: "CWL Alpha",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      roundState: "preparation",
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
    });
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Round Alpha",
        townHall: 16,
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
      },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Linked Alpha",
        discordUserId: "111111111111111111",
        discordUsername: "alpha-user",
      },
    ]);

    const roster = await cwlStateService.listSeasonRosterForClan({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
    });

    expect(roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          playerTag: "#QGRJ2222",
          playerName: "Stored Bravo",
          linkedDiscordUserId: null,
          daysParticipated: 1,
          currentRound: expect.objectContaining({
            roundDay: 3,
            inCurrentLineup: false,
            opponentTag: "#OPP1",
          }),
        }),
        expect.objectContaining({
          playerTag: "#PYLQ0289",
          playerName: "Linked Alpha",
          linkedDiscordUserId: "111111111111111111",
          linkedDiscordUsername: "alpha-user",
          daysParticipated: 2,
          currentRound: expect.objectContaining({
            roundDay: 3,
            inCurrentLineup: true,
            attacksUsed: 0,
            attacksAvailable: 0,
          }),
        }),
      ]),
    );
  });
});
