import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClanMatchStatsCurrentSyncService } from "../src/services/fwa-feeds/FwaClanMatchStatsCurrentSyncService";
import { FwaClanWarsSyncService } from "../src/services/fwa-feeds/FwaClanWarsSyncService";

const txMock = vi.hoisted(() => ({
  fwaClanWarLogCurrent: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaFeedCursor: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) =>
    callback(txMock),
  ),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaClanWarsSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers the derived clan-match rebuild after a global clan-wars sweep changes source rows", async () => {
    const now = new Date("2026-04-14T18:00:00.000Z");
    const client = {
      fetchClanWars: vi.fn().mockResolvedValue([
        {
          clanTag: "#AAA111",
          endTime: new Date("2026-04-14T17:00:00.000Z"),
          searchTime: null,
          result: "WIN",
          teamSize: 50,
          clanName: "Clan A",
          clanLevel: 30,
          clanStars: 95,
          clanDestructionPercentage: 98.5,
          clanAttacks: 100,
          clanExpEarned: 300,
          opponentTag: "#BBB222",
          opponentName: "Enemy",
          opponentLevel: 25,
          opponentStars: 80,
          opponentDestructionPercentage: 88.1,
          opponentInfo: "FWA",
          synced: true,
          matched: true,
        },
      ]),
    } as any;
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }]);
    prismaMock.fwaFeedCursor.findUnique.mockResolvedValue({ lastScopeKey: null });
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    txMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
    txMock.fwaClanWarLogCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.fwaClanWarLogCurrent.upsert.mockResolvedValue({});
    prismaMock.fwaFeedCursor.upsert.mockResolvedValue({});

    const rebuildSpy = vi
      .spyOn(FwaClanMatchStatsCurrentSyncService.prototype, "rebuildCurrentStats")
      .mockResolvedValue({ clanCount: 1, sourceRowCount: 1, evaluatedWarCount: 1 } as any);

    const service = new FwaClanWarsSyncService(client);
    const result = await service.runDistributedSweep({
      chunkSize: 1,
      concurrency: 1,
      force: true,
      now,
    });

    expect(result.changedRowCount).toBe(1);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith({ now });
  });
});
