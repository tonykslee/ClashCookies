import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let previousPollingMode: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousPollingMode = process.env.POLLING_MODE;
    delete process.env.POLLING_MODE;
  });

  afterEach(() => {
    if (previousPollingMode === undefined) {
      delete process.env.POLLING_MODE;
    } else {
      process.env.POLLING_MODE = previousPollingMode;
    }
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

  it("persists successful clan-wars sync results in active mode", async () => {
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
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue({});
    txMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
    txMock.fwaClanWarLogCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.fwaClanWarLogCurrent.upsert.mockResolvedValue({});

    const service = new FwaClanWarsSyncService(client);
    const result = await service.syncClan("#aaa111", { force: true });

    expect(result.status).toBe("SUCCESS");
    expect(result.rowCount).toBe(1);
    expect(result.changedRowCount).toBe(1);
    expect(client.fetchClanWars).toHaveBeenCalledWith("#AAA111");
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledTimes(2);
  });

  it("returns NOOP when the fetched clan-wars content hash is unchanged", async () => {
    const row = {
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
    } as any;
    const client = {
      fetchClanWars: vi.fn().mockResolvedValue(row ? [row] : []),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce(null);
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue({});
    txMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
    txMock.fwaClanWarLogCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.fwaClanWarLogCurrent.upsert.mockResolvedValue({});

    const service = new FwaClanWarsSyncService(client);
    const successResult = await service.syncClan("#aaa111", { force: true });
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce({
      lastContentHash: successResult.contentHash,
    });
    const noopResult = await service.syncClan("#aaa111", { force: true });

    expect(successResult.status).toBe("SUCCESS");
    expect(noopResult).toMatchObject({
      status: "NOOP",
      rowCount: 1,
      changedRowCount: 0,
      contentHash: successResult.contentHash,
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("skips clan sync when the interval guard says the clan is not yet eligible", async () => {
    const client = {
      fetchClanWars: vi.fn(),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      nextEligibleAt: new Date("2026-04-14T19:00:00.000Z"),
      lastAttemptAt: new Date("2026-04-14T18:30:00.000Z"),
    });
    const service = new FwaClanWarsSyncService(client);
    const result = await service.syncClan("#aaa111", {
      minimumIntervalMs: 15 * 60 * 1000,
      now: new Date("2026-04-14T18:45:00.000Z"),
    });

    expect(result.status).toBe("SKIPPED");
    expect(client.fetchClanWars).not.toHaveBeenCalled();
    expect(prismaMock.fwaFeedSyncState.upsert).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("records a failure when the clan-wars fetch throws", async () => {
    const client = {
      fetchClanWars: vi.fn().mockRejectedValue(new Error("boom")),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue({});
    const service = new FwaClanWarsSyncService(client);

    await expect(service.syncClan("#aaa111", { force: true })).rejects.toThrow("boom");
    expect(client.fetchClanWars).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("skips clan sync in mirror polling mode without HTTP or database writes", async () => {
    process.env.POLLING_MODE = "mirror";
    const client = {
      fetchClanWars: vi.fn(),
    } as any;
    const service = new FwaClanWarsSyncService(client);

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = await service.syncClan("#aaa111");

    expect(result).toEqual({
      rowCount: 0,
      changedRowCount: 0,
      contentHash: null,
      status: "SKIPPED",
    });
    expect(client.fetchClanWars).not.toHaveBeenCalled();
    expect(prismaMock.fwaFeedSyncState.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.fwaFeedSyncState.upsert).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[fwa-feed] job=clan_wars clan=#AAA111 status=SKIPPED reason=mirror_mode",
    );
    infoSpy.mockRestore();
  });
});
