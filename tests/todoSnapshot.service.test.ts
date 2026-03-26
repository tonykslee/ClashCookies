import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cwlSeasonUpsertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    findMany: vi.fn(),
    aggregate: vi.fn(),
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
  },
  $transaction: vi.fn(async (arg: any) => {
    if (typeof arg === "function") {
      return arg({
        todoPlayerSnapshot: {
          upsert: upsertMock,
        },
        cwlPlayerClanSeason: {
          upsert: cwlSeasonUpsertMock,
        },
      });
    }
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  }),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { todoSnapshotService } from "../src/services/TodoSnapshotService";

describe("TodoSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMock.mockClear();
    cwlSeasonUpsertMock.mockClear();

    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
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
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(cwlSeasonUpsertMock).toHaveBeenCalledTimes(2);
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
    expect(upsertMock).toHaveBeenCalledWith(
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
});
