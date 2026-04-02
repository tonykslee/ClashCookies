import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  warAttacks: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findMany: vi.fn(),
  },
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  botSetting: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  resolveClanGamesWindowForTest,
  resetTodoSnapshotServiceForTest,
  todoSnapshotService,
} from "../src/services/TodoSnapshotService";

function buildSnapshotRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    playerTag: "#PYLQ0289",
    playerName: "Alpha",
    clanTag: "#PQL0289",
    clanName: "Clan One",
    cwlClanTag: null,
    cwlClanName: null,
    warActive: false,
    warAttacksUsed: 0,
    warAttacksMax: 2,
    warPhase: null,
    warEndsAt: null,
    cwlActive: false,
    cwlAttacksUsed: 0,
    cwlAttacksMax: 1,
    cwlPhase: null,
    cwlEndsAt: null,
    raidActive: false,
    raidAttacksUsed: 0,
    raidAttacksMax: 6,
    raidEndsAt: null,
    gamesActive: false,
    gamesPoints: null,
    gamesTarget: null,
    gamesChampionTotal: null,
    gamesSeasonBaseline: null,
    gamesCycleKey: null,
    gamesEndsAt: null,
    lastUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
    updatedAt: new Date("2026-03-26T00:00:00.000Z"),
    ...overrides,
  };
}

describe("TodoSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTodoSnapshotServiceForTest();

    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.upsert.mockResolvedValue(undefined);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        playerName: "Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        attacks: 1,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#PQL0289",
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    prismaMock.botSetting.upsert.mockResolvedValue(undefined);
  });

  it("reads persisted CWL round state once per clan when refreshing multiple player tags", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        clanName: "Clan One",
        roundState: "preparation",
        startTime: new Date("2026-03-30T12:00:00.000Z"),
        endTime: new Date("2026-03-31T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
      },
      {
        season: "2026-03",
        clanTag: "#PQL0289",
        playerTag: "#QGRJ2222",
        attacksUsed: 0,
        attacksAvailable: 0,
        subbedIn: true,
      },
    ]);
    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(prismaMock.currentCwlRound.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cwlRoundMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledTimes(2);
  });

  it("skips live non-tracked CWL hydration unless explicitly enabled", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#NONT" },
      }),
      getClanWarLeagueGroup: vi.fn(),
      getClanWarLeagueWar: vi.fn(),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueWar).not.toHaveBeenCalled();
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: null,
          cwlClanName: null,
          cwlActive: false,
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("hydrates one live non-tracked CWL clan once and fans out the snapshot to multiple linked players", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        clanTag: "#QGRJ",
        playerName: "Bravo",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#QGRJ" },
      })),
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-03",
        state: "preparation",
        clans: [{ tag: "#QGRJ", name: "Nontracked Clan" }],
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        attacksPerMember: 1,
        startTime: "20260330T120000.000Z",
        endTime: "20260331T120000.000Z",
        clan: {
          tag: "#QGRJ",
          name: "Nontracked Clan",
          members: [
            {
              tag: "#PYLQ0289",
              name: "Alpha",
              townhallLevel: 15,
              attacks: [],
            },
            {
              tag: "#QGRJ2222",
              name: "Bravo",
              townhallLevel: 14,
              attacks: [],
            },
          ],
        },
        opponent: { tag: "#OPP", name: "Opponent", members: [] },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      includeNonTrackedCwlRefresh: true,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(1);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          cwlClanTag: "#QGRJ",
          cwlClanName: "Nontracked Clan",
          cwlActive: true,
          cwlPhase: "preparation",
          cwlEndsAt: new Date("2026-03-30T12:00:00.000Z"),
          cwlAttacksUsed: 0,
          cwlAttacksMax: 0,
        }),
      }),
    );
  });

  it("sources active raid attacks from live clan raid members even for untracked clans", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        raidActive: true,
        raidAttacksUsed: 0,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#P2YLC8R0" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#PYLQ0289", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledWith("#P2YLC8R0", 2);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#P2YLC8R0",
          raidActive: true,
          raidAttacksUsed: 6,
        }),
      }),
    );
  });

  it("fetches raid-season data once per clan and fans out attacks across same-clan linked players", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockImplementation(async (tag: string) => ({
        tag,
        clan: { tag: "#P2YLC8R0" },
      })),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [
            { tag: "#PYLQ0289", attacks: 4 },
            { tag: "#QGRJ2222", attacks: 2 },
          ],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(cocService.getClanCapitalRaidSeasons).toHaveBeenCalledTimes(1);
    const upsertByTag = new Map(
      prismaMock.todoPlayerSnapshot.upsert.mock.calls.map((call: any[]) => [
        call?.[0]?.where?.playerTag,
        call?.[0]?.update?.raidAttacksUsed,
      ]),
    );
    expect(upsertByTag.get("#PYLQ0289")).toBe(4);
    expect(upsertByTag.get("#QGRJ2222")).toBe(2);
  });

  it("writes raid attacks as zero when player is absent from live raid member list", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        raidActive: true,
        raidAttacksUsed: 5,
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    const cocService = {
      getPlayerRaw: vi.fn().mockResolvedValue({
        tag: "#PYLQ0289",
        clan: { tag: "#P2YLC8R0" },
      }),
      getClanCapitalRaidSeasons: vi.fn().mockResolvedValue([
        {
          startTime: "20260327T070000.000Z",
          endTime: "20260330T070000.000Z",
          members: [{ tag: "#QGRJ2222", attacks: 6 }],
        },
      ]),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 27, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          raidActive: true,
          raidAttacksUsed: 0,
        }),
      }),
    );
  });

  it("resolves CWL context from seasonal CWL registry mapping instead of home clan tag", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Home Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Clan" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Clan",
        roundState: "inWar",
        startTime: new Date("2026-03-29T12:00:00.000Z"),
        endTime: new Date("2026-03-30T12:00:00.000Z"),
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        season: "2026-03",
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        attacksUsed: 1,
        attacksAvailable: 1,
        subbedIn: true,
      },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", cwlClanTag: "#2QG2C08UP" },
    ]);
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          clanTag: "#PQL0289",
          clanName: "Home Clan",
          cwlClanTag: "#2QG2C08UP",
          cwlClanName: "CWL Clan",
          cwlAttacksUsed: 1,
        }),
      }),
    );
  });

  it("writes zero war attacks during preparation even when member attack state is non-zero", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "preparation",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warActive: true,
          warPhase: "preparation",
          warAttacksUsed: 0,
        }),
      }),
    );
  });

  it("derives tracked inWar attacks from WarAttacks instead of stale feed attack counters", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 1001,
        state: "inWar",
        startTime: new Date("2026-03-26T12:00:00.000Z"),
        endTime: new Date("2026-03-27T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 1,
        attackOrder: 1,
        attackNumber: 1,
        defenderPosition: 8,
        stars: 3,
        attackSeenAt: new Date("2026-03-26T00:10:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warActive: true,
          warPhase: "battle day",
          warAttacksUsed: 1,
        }),
      }),
    );
  });

  it("does not leak stale previous-war feed attacks into tracked current-war snapshots", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        position: 8,
        attacks: 2,
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        warId: 2002,
        state: "inWar",
        startTime: new Date("2026-03-28T12:00:00.000Z"),
        endTime: new Date("2026-03-29T12:00:00.000Z"),
        updatedAt: new Date("2026-03-28T00:00:00.000Z"),
      },
    ]);
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        warId: 1001,
        clanTag: "#PQL0289",
        warStartTime: new Date("2026-03-26T12:00:00.000Z"),
        playerTag: "#PYLQ0289",
        playerPosition: 8,
        attacksUsed: 2,
        attackOrder: 0,
        attackNumber: 0,
        defenderPosition: null,
        stars: 0,
        attackSeenAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 28, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warActive: true,
          warPhase: "battle day",
          warAttacksUsed: 0,
        }),
      }),
    );
  });

  it("marks WAR inactive for players missing from active-war membership", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        state: "inWar",
        startTime: new Date("2026-03-25T12:00:00.000Z"),
        endTime: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          warActive: false,
          warPhase: null,
          warAttacksUsed: 0,
        }),
      }),
    );
  });

  it("derives active Clan Games points from stored signal totals and cycle baseline", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 12000,
        gamesSeasonBaseline: 12000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 13450 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 1450,
          gamesTarget: 4000,
          gamesChampionTotal: 13450,
          gamesSeasonBaseline: 12000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("initializes active-cycle baseline when missing and writes zero points for first observation", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 20000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 20000,
          gamesSeasonBaseline: 20000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("derives active-cycle points from initialized baseline on later observations", async () => {
    prismaMock.todoPlayerSnapshot.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        buildSnapshotRow({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 20000,
          gamesSeasonBaseline: 20000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany
      .mockResolvedValueOnce([
        {
          key: "player_signal_state:#PYLQ0289",
          value: JSON.stringify({ counters: { gamesChampion: 20000 } }),
        },
      ])
      .mockResolvedValueOnce([
        {
          key: "player_signal_state:#PYLQ0289",
          value: JSON.stringify({ counters: { gamesChampion: 20350 } }),
        },
      ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });
    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 5, 0, 0),
    });

    const firstSnapshotCall = prismaMock.todoPlayerSnapshot.upsert.mock.calls[0]?.[0];
    const secondSnapshotCall = prismaMock.todoPlayerSnapshot.upsert.mock.calls[1]?.[0];
    expect(firstSnapshotCall?.update.gamesPoints).toBe(0);
    expect(secondSnapshotCall?.update.gamesPoints).toBe(350);
    expect(secondSnapshotCall?.update.gamesSeasonBaseline).toBe(20000);
    expect(secondSnapshotCall?.update.gamesChampionTotal).toBe(20350);
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("resets baseline when observed total drops below stored baseline without inflating points", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 12000,
        gamesSeasonBaseline: 12000,
        gamesCycleKey: "1774166400000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 11900 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 11900,
          gamesSeasonBaseline: 11900,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("caps derived active-cycle points at the completion target only after baseline subtraction", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 0,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 15000,
        gamesCycleKey: "1774166400000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 19050 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 4000,
          gamesTarget: 4000,
          gamesChampionTotal: 19050,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("resets games cycle baseline on cycle rollover using current observed total", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 900,
        gamesTarget: null,
        gamesChampionTotal: 13000,
        gamesSeasonBaseline: 12100,
        gamesCycleKey: "1771747200000",
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 13150 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 26, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: true,
          gamesPoints: 0,
          gamesTarget: 4000,
          gamesChampionTotal: 13150,
          gamesSeasonBaseline: 13150,
          gamesCycleKey: "1774166400000",
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("stores upcoming-cycle baseline and clears games points/target when games is not active", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 999,
        gamesTarget: 4000,
        gamesChampionTotal: 14999,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1771747200000",
        gamesEndsAt: new Date("2026-02-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-02-28T08:00:00.000Z"),
        updatedAt: new Date("2026-02-28T08:00:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-10T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 10, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: null,
          gamesTarget: null,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("keeps latest-season points through reward collection for the ended cycle", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: true,
        gamesPoints: 1300,
        gamesTarget: 4000,
        gamesChampionTotal: 14999,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-03-28T08:05:00.000Z"),
        updatedAt: new Date("2026-03-28T08:05:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-03-29T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 2, 29, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: 1000,
          gamesTarget: 4000,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 14000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("keeps latest-season points through the extended reward claim window after April 1", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 1000,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-01T11:55:00.000Z"),
        updatedAt: new Date("2026-04-01T11:55:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 3, 1, 12, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: 1000,
          gamesTarget: 4000,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 14000,
          gamesCycleKey: "1774166400000",
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("clears latest-season games points once reward collection fully ends", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      buildSnapshotRow({
        gamesActive: false,
        gamesPoints: 1000,
        gamesTarget: 4000,
        gamesChampionTotal: 15000,
        gamesSeasonBaseline: 14000,
        gamesCycleKey: "1774166400000",
        gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-04-04T07:55:00.000Z"),
        updatedAt: new Date("2026-04-04T07:55:00.000Z"),
      }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        clanTag: "#PQL0289",
        playerName: "Alpha",
        sourceSyncedAt: new Date("2026-04-04T09:00:00.000Z"),
      },
    ]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.botSetting.findMany.mockResolvedValue([
      {
        key: "player_signal_state:#PYLQ0289",
        value: JSON.stringify({ counters: { gamesChampion: 15000 } }),
      },
    ]);

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      nowMs: Date.UTC(2026, 3, 4, 9, 0, 0, 0),
    });

    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          gamesActive: false,
          gamesPoints: null,
          gamesTarget: null,
          gamesChampionTotal: 15000,
          gamesSeasonBaseline: 15000,
          gamesCycleKey: "1776844800000",
          gamesEndsAt: new Date("2026-04-28T08:00:00.000Z"),
        }),
      }),
    );
  });

  it("switches Clan Games windows at the exact earning and reward-claim cutoffs", () => {
    const beforeEarningCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 2, 28, 7, 59, 59, 999),
    );
    const atEarningCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 2, 28, 8, 0, 0, 0),
    );
    const beforeClaimCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 3, 4, 7, 59, 59, 999),
    );
    const atClaimCutoff = resolveClanGamesWindowForTest(
      Date.UTC(2026, 3, 4, 8, 0, 0, 0),
    );

    expect(beforeEarningCutoff.active).toBe(true);
    expect(beforeEarningCutoff.rewardCollectionActive).toBe(false);

    expect(atEarningCutoff.active).toBe(false);
    expect(atEarningCutoff.rewardCollectionActive).toBe(true);
    expect(atEarningCutoff.rewardCollectionEndsMs).toBe(
      Date.UTC(2026, 3, 4, 8, 0, 0, 0),
    );

    expect(beforeClaimCutoff.active).toBe(false);
    expect(beforeClaimCutoff.rewardCollectionActive).toBe(true);

    expect(atClaimCutoff.active).toBe(false);
    expect(atClaimCutoff.rewardCollectionActive).toBe(false);
  });
});
