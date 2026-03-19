import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { computeFeedContentHash } from "../src/services/fwa-feeds/hash";

const txMock = vi.hoisted(() => ({
  fwaClanMemberCurrent: {
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    upsert: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaClanMembersSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs one tracked clan and removes stale current rows", async () => {
    const client = {
      fetchClanMembers: vi.fn().mockResolvedValue([
        {
          clanTag: "#AAA111",
          playerTag: "#P1",
          playerName: "One",
          role: "leader",
          level: 10,
          donated: 1,
          received: 2,
          rank: 1,
          trophies: 1000,
          league: "Gold",
          townHall: 14,
          weight: 120000,
          inWar: true,
        },
        {
          clanTag: "#AAA111",
          playerTag: "#P2",
          playerName: "Two",
          role: null,
          level: 9,
          donated: 3,
          received: 4,
          rank: 2,
          trophies: 900,
          league: null,
          townHall: 13,
          weight: 110000,
          inWar: false,
        },
      ]),
    } as any;

    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    txMock.fwaClanMemberCurrent.deleteMany.mockResolvedValue({ count: 1 });

    const service = new FwaClanMembersSyncService(client);
    const result = await service.syncTrackedClan("#aaa111", { force: true });

    expect(client.fetchClanMembers).toHaveBeenCalledWith("#AAA111");
    expect(txMock.fwaClanMemberCurrent.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clanTag: "#AAA111",
          playerTag: { notIn: ["#P1", "#P2"] },
        }),
      }),
    );
    expect(txMock.fwaClanMemberCurrent.upsert).toHaveBeenCalledTimes(2);
    expect(txMock.fwaPlayerCatalog.upsert).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("SUCCESS");
    expect(result.rowCount).toBe(2);
    expect(result.changedRowCount).toBe(3);
  });

  it("returns NOOP when payload hash is unchanged", async () => {
    const rows = [
      {
        clanTag: "#AAA111",
        playerTag: "#P1",
        playerName: "One",
        role: "leader",
        level: 10,
        donated: 1,
        received: 2,
        rank: 1,
        trophies: 1000,
        league: "Gold",
        townHall: 14,
        weight: 120000,
        inWar: true,
      },
    ];
    const hash = computeFeedContentHash(rows);
    const client = {
      fetchClanMembers: vi.fn().mockResolvedValue(rows),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({ lastContentHash: hash });

    const service = new FwaClanMembersSyncService(client);
    const result = await service.syncTrackedClan("#AAA111", { force: true });

    expect(result.status).toBe("NOOP");
    expect(result.changedRowCount).toBe(0);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("builds all-tracked sync targets from TrackedClan", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#aaa111" }, { tag: "#bbb222" }]);
    const service = new FwaClanMembersSyncService({ fetchClanMembers: vi.fn() } as any);
    const spy = vi
      .spyOn(service, "syncTrackedClan")
      .mockResolvedValue({ rowCount: 0, changedRowCount: 0, contentHash: null, status: "SUCCESS" });

    await service.syncAllTrackedClans({ concurrency: 2, force: true });

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("#AAA111", expect.any(Object));
    expect(spy).toHaveBeenCalledWith("#BBB222", expect.any(Object));
  });
});
