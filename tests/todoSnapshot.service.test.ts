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
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
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

import { todoSnapshotService } from "../src/services/TodoSnapshotService";

describe("TodoSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

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
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#PQL0289", name: "Clan One" },
    ]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.upsert.mockResolvedValue(undefined);
    prismaMock.botSetting.findMany.mockResolvedValue([]);
    prismaMock.botSetting.upsert.mockResolvedValue(undefined);
  });

  it("fans out grouped CWL source fetches once per clan when refreshing multiple player tags", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        state: "inWar",
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        startTime: "20260330T120000.000Z",
        clan: {
          tag: "#PQL0289",
          members: [
            { tag: "#PYLQ0289", attacks: [{ order: 1 }] },
            { tag: "#QGRJ2222", attacks: [] },
          ],
        },
        opponent: {
          tag: "#2QG2C08UP",
          members: [],
        },
      }),
    };

    const result = await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289", "#QGRJ2222"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(result.playerCount).toBe(2);
    expect(result.updatedCount).toBe(2);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(1);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(1);
    expect(prismaMock.todoPlayerSnapshot.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.cwlPlayerClanSeason.upsert).toHaveBeenCalledTimes(2);
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
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", cwlClanTag: "#2QG2C08UP" },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        state: "inWar",
        rounds: [{ warTags: ["#WAR1"] }],
      }),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "inWar",
        endTime: "20260330T120000.000Z",
        clan: {
          tag: "#2QG2C08UP",
          members: [{ tag: "#PYLQ0289", attacks: [{ order: 1 }] }],
        },
        opponent: {
          tag: "#PQL0289",
          members: [],
        },
      }),
    };

    await todoSnapshotService.refreshSnapshotsForPlayerTags({
      playerTags: ["#PYLQ0289"],
      cocService: cocService as any,
      nowMs: Date.UTC(2026, 2, 26, 0, 0, 0, 0),
    });

    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledWith("#2QG2C08UP");
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

  it("derives active Clan Games points from stored signal totals and cycle baseline", async () => {
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
      {
        key: "todo_games_baseline:1774166400000:#PYLQ0289",
        value: "12000",
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
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });

  it("initializes active-cycle baseline when missing and keeps points bounded", async () => {
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
          gamesPoints: 4000,
          gamesTarget: 4000,
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).toHaveBeenCalledWith({
      where: { key: "todo_games_baseline:1774166400000:#PYLQ0289" },
      update: { value: "0" },
      create: { key: "todo_games_baseline:1774166400000:#PYLQ0289", value: "0" },
    });
  });

  it("stores upcoming-cycle baseline and clears games points/target when games is not active", async () => {
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([
      {
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
        gamesActive: true,
        gamesPoints: 999,
        gamesTarget: 4000,
        gamesEndsAt: new Date("2026-02-28T08:00:00.000Z"),
        lastUpdatedAt: new Date("2026-02-28T08:00:00.000Z"),
        updatedAt: new Date("2026-02-28T08:00:00.000Z"),
      },
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
          gamesEndsAt: new Date("2026-03-28T08:00:00.000Z"),
        }),
      }),
    );
    expect(prismaMock.botSetting.upsert).toHaveBeenCalledWith({
      where: { key: "todo_games_baseline:1774166400000:#PYLQ0289" },
      update: { value: "15000" },
      create: { key: "todo_games_baseline:1774166400000:#PYLQ0289", value: "15000" },
    });
  });
});
