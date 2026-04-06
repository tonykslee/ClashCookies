import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  currentCwlRound: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  currentCwlPrepSnapshot: {
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
  currentCwlPrepSnapshot: {
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
    prismaMock.currentCwlPrepSnapshot.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findUnique.mockResolvedValue(null);
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);

    txMock.currentCwlRound.upsert.mockResolvedValue(undefined);
    txMock.currentCwlRound.deleteMany.mockResolvedValue({ count: 0 });
    txMock.currentCwlPrepSnapshot.upsert.mockResolvedValue(undefined);
    txMock.currentCwlPrepSnapshot.deleteMany.mockResolvedValue({ count: 0 });
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
    expect(txMock.currentCwlPrepSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { season: "2026-04", clanTag: "#2QG2C08UP" },
    });
  });

  it("prefers a live battle-day round over a later preparation round and persists the overlap prep snapshot", async () => {
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
        rounds: [{ warTags: ["#WAR1"] }, { warTags: ["#WAR2"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockImplementation(async (warTag: string) => {
        if (warTag === "#WAR1") {
          return {
            state: "inWar",
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
          };
        }
        return {
          state: "preparation",
          preparationStartTime: "20260403T120000.000Z",
          startTime: "20260404T120000.000Z",
          endTime: "20260405T120000.000Z",
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
                attacks: [],
              },
            ],
          },
          opponent: {
            tag: "#Q2V8P9L3",
            name: "Opponent Two",
            members: [],
          },
        };
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
      currentMemberCount: 1,
    });
    expect(txMock.currentCwlRound.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          roundDay: 1,
          roundState: "inWar",
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
            attacksUsed: 1,
            attacksAvailable: 1,
            sourceRoundState: "inWar",
          }),
        ]),
      }),
    );
    expect(txMock.currentCwlPrepSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          roundDay: 2,
          roundState: "preparation",
          opponentName: "Opponent Two",
          lineupJson: expect.arrayContaining([
            expect.objectContaining({
              playerTag: "#PYLQ0289",
              playerName: "Alpha",
              mapPosition: 1,
              townHall: 16,
              subbedIn: true,
              subbedOut: false,
            }),
          ]),
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
    expect(txMock.currentCwlPrepSnapshot.deleteMany).toHaveBeenCalledWith({
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

  it("returns the persisted current-day lineup when the current round matches the requested day", async () => {
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 2,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      preparationStartTime: new Date("2026-04-02T10:00:00.000Z"),
      startTime: new Date("2026-04-02T12:00:00.000Z"),
      endTime: new Date("2026-04-03T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        roundDay: 2,
        playerName: "Alpha",
        mapPosition: 1,
        townHall: 16,
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
        subbedOut: false,
      },
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#QGRJ2222",
        roundDay: 2,
        playerName: "Bravo",
        mapPosition: 2,
        townHall: 15,
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
        subbedOut: false,
      },
    ]);

    const actual = await cwlStateService.getActualLineupForDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 2,
    });

    expect(actual).toEqual(
      expect.objectContaining({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        roundDay: 2,
        roundState: "preparation",
        opponentTag: "#OPP1",
        opponentName: "Opponent One",
        phaseEndsAt: new Date("2026-04-02T12:00:00.000Z"),
        members: [
          expect.objectContaining({
            playerTag: "#PYLQ0289",
            playerName: "Alpha",
            mapPosition: 1,
            subbedIn: true,
          }),
          expect.objectContaining({
            playerTag: "#QGRJ2222",
            playerName: "Bravo",
            mapPosition: 2,
            subbedIn: true,
          }),
        ],
      }),
    );
    expect(prismaMock.currentCwlPrepSnapshot.findUnique).not.toHaveBeenCalled();
  });

  it("returns the persisted history lineup when the requested day is in history", async () => {
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 3,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      preparationStartTime: new Date("2026-04-03T10:00:00.000Z"),
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    prismaMock.cwlRoundHistory.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      roundDay: 1,
      clanName: "CWL Alpha",
      roundState: "warEnded",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      preparationStartTime: new Date("2026-04-01T10:00:00.000Z"),
      startTime: new Date("2026-04-01T12:00:00.000Z"),
      endTime: new Date("2026-04-02T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prismaMock.cwlRoundMemberHistory.findMany.mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        roundDay: 1,
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        mapPosition: 1,
        townHall: 16,
        attacksUsed: 1,
        attacksAvailable: 1,
        subbedIn: true,
        subbedOut: false,
      },
    ]);

    const actual = await cwlStateService.getActualLineupForDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 1,
    });

    expect(actual).toEqual(
      expect.objectContaining({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        roundDay: 1,
        roundState: "warEnded",
        opponentTag: "#OPP2",
        opponentName: "Opponent Two",
        phaseEndsAt: new Date("2026-04-02T12:00:00.000Z"),
        members: [
          expect.objectContaining({
            playerTag: "#PYLQ0289",
            playerName: "Alpha",
            subbedIn: true,
          }),
        ],
      }),
    );
    expect(prismaMock.currentCwlPrepSnapshot.findUnique).not.toHaveBeenCalled();
  });

  it("returns the persisted next-day preparation lineup from the live prep snapshot when the current round remains in war", async () => {
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      preparationStartTime: new Date("2026-04-01T10:00:00.000Z"),
      startTime: new Date("2026-04-01T12:00:00.000Z"),
      endTime: new Date("2026-04-02T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prismaMock.currentCwlPrepSnapshot.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 2,
      roundState: "preparation",
      opponentTag: "#OPP2",
      opponentName: "Opponent Two",
      preparationStartTime: new Date("2026-04-02T10:00:00.000Z"),
      startTime: new Date("2026-04-02T12:00:00.000Z"),
      endTime: new Date("2026-04-03T12:00:00.000Z"),
      lineupJson: [
        {
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          mapPosition: 1,
          townHall: 15,
          subbedIn: true,
          subbedOut: false,
        },
        {
          playerTag: "#CUV9082",
          playerName: "Charlie",
          mapPosition: 2,
          townHall: 15,
          subbedIn: true,
          subbedOut: false,
        },
      ],
      sourceUpdatedAt: new Date("2026-04-02T00:00:00.000Z"),
    });

    const actual = await cwlStateService.getActualLineupForDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 2,
    });

    expect(prismaMock.currentCwlPrepSnapshot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          season_clanTag: {
            season: "2026-04",
            clanTag: "#2QG2C08UP",
          },
        },
      }),
    );
    expect(actual).toEqual(
      expect.objectContaining({
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        roundDay: 2,
        roundState: "preparation",
        opponentTag: "#OPP2",
        opponentName: "Opponent Two",
        phaseEndsAt: new Date("2026-04-02T12:00:00.000Z"),
        members: [
          expect.objectContaining({
            playerTag: "#QGRJ2222",
            playerName: "Bravo",
            attacksUsed: 0,
            attacksAvailable: 0,
            subbedIn: true,
          }),
          expect.objectContaining({
            playerTag: "#CUV9082",
            playerName: "Charlie",
            attacksUsed: 0,
            attacksAvailable: 0,
            subbedIn: true,
          }),
        ],
      }),
    );
  });

  it("returns null for a future day that is not yet in preparation", async () => {
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "inWar",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      preparationStartTime: new Date("2026-04-01T10:00:00.000Z"),
      startTime: new Date("2026-04-01T12:00:00.000Z"),
      endTime: new Date("2026-04-02T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const actual = await cwlStateService.getActualLineupForDay({
      clanTag: "#2QG2C08UP",
      season: "2026-04",
      roundDay: 4,
    });

    expect(actual).toBeNull();
    expect(prismaMock.currentCwlPrepSnapshot.findUnique).toHaveBeenCalledTimes(1);
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
