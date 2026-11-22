import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { computeClanMembersSnapshotHash, toClanMembersSnapshotRow } from "../src/services/fwa-feeds/clanMembersSnapshot";

const txMock = vi.hoisted(() => ({
  fwaClanMemberCurrent: {
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    upsert: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $executeRaw: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaClanMembersSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    txMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
  });

  it("refreshes only the requested clan tags from CoC into the current-member owner", async () => {
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        tag: "#AAA111",
        memberListPresent: true,
        declaredMemberCountPresent: true,
        declaredMemberCountValid: true,
        declaredMemberCount: 2,
        members: [
        {
          tag: "#PYLQ0289",
          name: "Alpha",
          role: "leader",
          townHallLevel: 18,
          expLevel: 10,
          clanRank: 1,
          donations: 3,
            donationsReceived: 4,
            trophies: 5000,
            league: { name: "Gold I" },
          },
        {
          tag: "#QGRJ2222",
          name: "Bravo",
          role: "coLeader",
          townHallLevel: 17,
          expLevel: 9,
          clanRank: 2,
          donations: 1,
            donationsReceived: 2,
            trophies: 4800,
            league: { name: "Gold II" },
          },
        ],
      }),
    } as any;

    txMock.fwaClanMemberCurrent.deleteMany.mockResolvedValue({ count: 1 });
    txMock.fwaClanMemberCurrent.upsert.mockResolvedValue({});
    txMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        role: "leader",
        level: 10,
        donated: 3,
        received: 4,
        rank: 1,
        trophies: 5000,
        league: "Gold I",
        townHall: 18,
        weight: 120000,
        inWar: true,
      },
      {
        clanTag: "#AAA111",
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        role: "coLeader",
        level: 9,
        donated: 1,
        received: 2,
        rank: 2,
        trophies: 4800,
        league: "Gold II",
        townHall: 17,
        weight: 110000,
        inWar: false,
      },
    ]);
    const now = new Date("2026-11-21T22:00:00.000Z");
    txMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      lastAttemptAt: now,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    });

    const service = new FwaClanMembersSyncService();
    const result = await service.refreshCurrentClanMembersForClanTags(["#aaa111", "#AAA111"], {
      cocService,
      now,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(cocService.getClan).toHaveBeenCalledWith("#AAA111");
    expect(txMock.fwaClanMemberCurrent.deleteMany).toHaveBeenCalledWith({
      where: {
        clanTag: "#AAA111",
        playerTag: { notIn: ["#PYLQ0289", "#QGRJ2222"] },
      },
    });
    expect(txMock.fwaClanMemberCurrent.upsert).toHaveBeenCalledTimes(2);
    expect(txMock.fwaClanMemberCurrent.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: expect.objectContaining({ townHall: 18 }),
        create: expect.objectContaining({ townHall: 18 }),
      }),
    );
    expect(txMock.fwaClanMemberCurrent.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.objectContaining({ townHall: 17 }),
        create: expect.objectContaining({ townHall: 17 }),
      }),
    );
    expect(txMock.fwaClanMemberCurrent.upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("weight");
    expect(txMock.fwaClanMemberCurrent.upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("inWar");
    expect(result).toEqual({
      clanCount: 1,
      rowCount: 2,
      changedRowCount: 3,
      failedClans: [],
    });
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
    txMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111", playerTag: "#P1", playerName: "One", role: "leader", level: 10,
        donated: 1, received: 2, rank: 1, trophies: 1000, league: "Gold", townHall: 14,
        weight: 120000, inWar: true,
      },
      {
        clanTag: "#AAA111", playerTag: "#P2", playerName: "Two", role: null, level: 9,
        donated: 3, received: 4, rank: 2, trophies: 900, league: null, townHall: 13,
        weight: 110000, inWar: false,
      },
    ]);
    txMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P1", playerName: null },
      { playerTag: "#P2", playerName: "Two" },
    ]);
    txMock.playerLink.updateMany.mockResolvedValue({ count: 1 });

    const service = new FwaClanMembersSyncService(client);
    const now = new Date("2026-11-21T22:00:00.000Z");
    txMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      lastAttemptAt: now,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    });
    const result = await service.syncTrackedClan("#aaa111", { force: true, now });

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
    expect(txMock.playerLink.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#P1", "#P2"] } },
      select: { playerTag: true, playerName: true },
    });
    expect(txMock.playerLink.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#P1" },
      data: { playerName: "One" },
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.rowCount).toBe(2);
    expect(result.changedRowCount).toBe(3);
  });

  it("fails closed when CoC omits the member list or declares contradictory coverage", async () => {
    const missingListService = new FwaClanMembersSyncService();
    const missing = await missingListService.refreshCurrentClanMembersForClanTags(["#AAA111"], {
      cocService: { getClan: vi.fn().mockResolvedValue({ tag: "#AAA111", members: [] }) } as any,
    });
    expect(missing.failedClans).toEqual(["#AAA111"]);
    expect(txMock.fwaClanMemberCurrent.upsert).not.toHaveBeenCalled();

    const contradictory = await missingListService.refreshCurrentClanMembersForClanTags(["#AAA111"], {
      cocService: {
        getClan: vi.fn().mockResolvedValue({
          tag: "#AAA111",
          memberListPresent: true,
          declaredMemberCountPresent: true,
          declaredMemberCountValid: true,
          declaredMemberCount: 2,
          members: [{ tag: "#PYLQ0289", name: "Only one" }],
        }),
      } as any,
    });
    expect(contradictory.failedClans).toEqual(["#AAA111"]);
    expect(txMock.fwaClanMemberCurrent.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["malformed", "one"],
  ])("rejects an explicitly malformed CoC declared count (%s) before writes", async (_label, count) => {
    const service = new FwaClanMembersSyncService();
    const result = await service.refreshCurrentClanMembersForClanTags(["#AAA111"], {
      cocService: {
        getClan: vi.fn().mockResolvedValue({
          tag: "#AAA111",
          memberListPresent: true,
          declaredMemberCountPresent: true,
          declaredMemberCountValid: false,
          declaredMemberCount: count,
          members: [{ tag: "#PYLQ0289", name: "One" }],
        }),
      } as any,
    });
    expect(result.failedClans).toEqual(["#AAA111"]);
    expect(txMock.fwaClanMemberCurrent.deleteMany).not.toHaveBeenCalled();
    expect(txMock.fwaClanMemberCurrent.upsert).not.toHaveBeenCalled();
  });

  it("updates linked playerName when observed name changes", async () => {
    const client = {
      fetchClanMembers: vi.fn().mockResolvedValue([
        {
          clanTag: "#AAA111",
          playerTag: "#P1",
          playerName: "One Renamed",
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
      ]),
    } as any;

    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    txMock.fwaClanMemberCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.fwaClanMemberCurrent.findMany.mockResolvedValue([{
      clanTag: "#AAA111", playerTag: "#P1", playerName: "One Renamed", role: "leader", level: 10,
      donated: 1, received: 2, rank: 1, trophies: 1000, league: "Gold", townHall: 14,
      weight: 120000, inWar: true,
    }]);
    txMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P1", playerName: "One" },
    ]);
    txMock.playerLink.updateMany.mockResolvedValue({ count: 1 });

    const service = new FwaClanMembersSyncService(client);
    const now = new Date("2026-11-21T22:01:00.000Z");
    txMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      lastAttemptAt: now,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    });
    const result = await service.syncTrackedClan("#AAA111", { force: true, now });

    expect(txMock.playerLink.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#P1" },
      data: { playerName: "One Renamed" },
    });
    expect(result.status).toBe("SUCCESS");
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
    const hash = computeClanMembersSnapshotHash(rows.map(toClanMembersSnapshotRow));
    const client = {
      fetchClanMembers: vi.fn().mockResolvedValue(rows),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({ lastContentHash: hash });
    txMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);
    const now = new Date("2026-11-21T22:02:00.000Z");
    txMock.fwaFeedSyncState.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastStatus: "SUCCESS",
      lastRowCount: rows.length,
      lastChangedRowCount: rows.length,
      lastContentHash: hash,
      nextEligibleAt: null,
    });

    const service = new FwaClanMembersSyncService(client);
    const result = await service.syncTrackedClan("#AAA111", { force: true, now });

    expect(result.status).toBe("NOOP");
    expect(result.changedRowCount).toBe(0);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it("repairs divergent persisted rows and publishes coherent add/remove/empty snapshots", async () => {
    let persistedRows: any[] = [{
      clanTag: "#AAA111",
      playerTag: "#P1",
      playerName: "Stale",
      role: "member",
      level: 10,
      donated: 1,
      received: 1,
      rank: 1,
      trophies: 1000,
      league: "Gold",
      townHall: 14,
      weight: 120000,
      inWar: true,
    }];
    const firstRows = [{
      clanTag: "#AAA111", playerTag: "#P1", playerName: "Fresh", role: "member", level: 10,
      donated: 1, received: 1, rank: 1, trophies: 1000, league: "Gold", townHall: 14,
      weight: 120000, inWar: true,
    }];
    const secondRows = [...firstRows, {
      clanTag: "#AAA111", playerTag: "#P2", playerName: "Added", role: null, level: 9,
      donated: 0, received: 0, rank: 2, trophies: 900, league: null, townHall: 13,
      weight: 110000, inWar: false,
    }];
    const payloads = [firstRows, secondRows, []];
    let payloadIndex = 0;
    const state: any = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: computeClanMembersSnapshotHash(firstRows.map(toClanMembersSnapshotRow)),
      nextEligibleAt: null,
    };
    const applyStateUpsert = (args: any) => {
      Object.assign(state, args.update ?? args.create ?? {});
      return undefined;
    };
    const applyMemberUpsert = (args: any) => {
      const tag = args.where.clanTag_playerTag.playerTag;
      const existing = persistedRows.find((row) => row.clanTag === "#AAA111" && row.playerTag === tag);
      if (existing) Object.assign(existing, args.update);
      else persistedRows.push({ ...args.create });
      return {};
    };
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => state);
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaFeedSyncState.findUnique.mockImplementation(async () => state);
    txMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaClanMemberCurrent.findMany.mockImplementation(async () => [...persistedRows]);
    txMock.fwaClanMemberCurrent.deleteMany.mockImplementation(async (args: any) => {
      const before = persistedRows.length;
      const notIn = args.where.playerTag?.notIn as string[] | undefined;
      persistedRows = notIn
        ? persistedRows.filter((row) => notIn.includes(row.playerTag))
        : [];
      return { count: before - persistedRows.length };
    });
    txMock.fwaClanMemberCurrent.upsert.mockImplementation(applyMemberUpsert);

    const client = {
      fetchClanMembers: vi.fn(async () => payloads[payloadIndex++]),
    } as any;
    const service = new FwaClanMembersSyncService(client);
    const first = await service.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:10:00.000Z"),
    });
    expect(first.status).toBe("SUCCESS");
    expect(firstRows[0]?.playerName).toBe("Fresh");
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows[0]?.playerName).toBe("Fresh");

    const second = await service.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:11:00.000Z"),
    });
    expect(second.status).toBe("SUCCESS");
    expect(persistedRows.map((row) => row.playerTag)).toEqual(["#P1", "#P2"]);

    const empty = await service.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:12:00.000Z"),
    });
    expect(empty.status).toBe("SUCCESS");
    expect(empty.rowCount).toBe(0);
    expect(persistedRows).toEqual([]);
    expect(state.lastContentHash).toBe(computeClanMembersSnapshotHash([]));
  });

  it("does not let an older competing refresh publish after a newer attempt", async () => {
    let persistedRows: any[] = [];
    const state: any = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    };
    const applyStateUpsert = (args: any) => {
      Object.assign(state, args.update ?? args.create ?? {});
      return undefined;
    };
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => state);
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaFeedSyncState.findUnique.mockImplementation(async () => state);
    txMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaClanMemberCurrent.findMany.mockImplementation(async () => [...persistedRows]);
    txMock.fwaClanMemberCurrent.deleteMany.mockImplementation(async () => {
      const count = persistedRows.length;
      persistedRows = [];
      return { count };
    });
    txMock.fwaClanMemberCurrent.upsert.mockImplementation(async (args: any) => {
      persistedRows = [{ ...args.create, ...args.update }];
      return {};
    });

    let releaseOlder!: () => void;
    const olderPayload = new Promise<unknown[]>((resolve) => { releaseOlder = () => resolve([{
      clanTag: "#AAA111", playerTag: "#OLD", playerName: "Older", role: null, level: 10,
      donated: 0, received: 0, rank: 1, trophies: 1000, league: null, townHall: 14,
      weight: 120000, inWar: true,
    }]); });
    const newerRows = [{
      clanTag: "#AAA111", playerTag: "#NEW", playerName: "Newer", role: null, level: 10,
      donated: 0, received: 0, rank: 1, trophies: 1000, league: null, townHall: 14,
      weight: 120000, inWar: true,
    }];
    const olderService = new FwaClanMembersSyncService({ fetchClanMembers: vi.fn(() => olderPayload) } as any);
    const newerService = new FwaClanMembersSyncService({ fetchClanMembers: vi.fn().mockResolvedValue(newerRows) } as any);
    const olderPromise = olderService.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:20:00.000Z"),
    });
    await Promise.resolve();
    const newer = await newerService.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:21:00.000Z"),
    });
    releaseOlder();
    const older = await olderPromise;

    expect(newer.status).toBe("SUCCESS");
    expect(older.status).toBe("SKIPPED");
    expect(persistedRows[0]?.playerTag).toBe("#NEW");
    expect(state.lastContentHash).toBe(computeClanMembersSnapshotHash(newerRows.map(toClanMembersSnapshotRow)));
  });

  it("fences an older transaction from overwriting a newer publication after its fence read", async () => {
    let persistedRows: any[] = [];
    const state: any = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastErrorCode: null,
      lastErrorSummary: null,
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    };
    let resolveOldFenceRead!: () => void;
    const oldFenceRead = new Promise<void>((resolve) => { resolveOldFenceRead = resolve; });
    let releaseOldTransaction!: () => void;
    const oldTransactionRelease = new Promise<void>((resolve) => { releaseOldTransaction = resolve; });
    let transactionFenceReads = 0;
    const applyStateUpsert = (args: any) => {
      Object.assign(state, args.update ?? args.create ?? {});
      return undefined;
    };
    let transactionQueue = Promise.resolve();
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => Promise<unknown>) => {
      const previous = transactionQueue;
      let release!: () => void;
      transactionQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(txMock);
      } finally {
        release();
      }
    });
    const rowFor = (playerTag: string, playerName: string) => ({
      clanTag: "#AAA111", playerTag, playerName, role: null, level: 10,
      donated: 0, received: 0, rank: 1, trophies: 1000, league: null, townHall: 14,
      weight: 120000, inWar: true,
    });
    const applyMemberUpsert = async (args: any) => {
      const row = { ...args.create, ...args.update };
      const index = persistedRows.findIndex((candidate) => candidate.playerTag === row.playerTag);
      if (index >= 0) persistedRows[index] = row;
      else persistedRows.push(row);
      return {};
    };
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => ({ ...state }));
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaFeedSyncState.findUnique.mockImplementation(async () => {
      const snapshot = { ...state };
      transactionFenceReads += 1;
      if (transactionFenceReads === 2) {
        resolveOldFenceRead();
        await oldTransactionRelease;
      }
      return snapshot;
    });
    txMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    txMock.fwaClanMemberCurrent.findMany.mockImplementation(async () => persistedRows.map((row) => ({ ...row })));
    txMock.fwaClanMemberCurrent.deleteMany.mockImplementation(async (args: any) => {
      const before = persistedRows.length;
      const notIn = args.where.playerTag?.notIn as string[] | undefined;
      persistedRows = notIn
        ? persistedRows.filter((row) => notIn.includes(row.playerTag))
        : [];
      return { count: before - persistedRows.length };
    });
    txMock.fwaClanMemberCurrent.upsert.mockImplementation(applyMemberUpsert);
    txMock.fwaPlayerCatalog.upsert.mockResolvedValue({});
    txMock.playerLink.findMany.mockResolvedValue([]);

    const olderRows = [rowFor("#OLD", "Older")];
    const newerRows = [rowFor("#NEW", "Newer")];
    const olderService = new FwaClanMembersSyncService({
      fetchClanMembers: vi.fn().mockResolvedValue(olderRows),
    } as any);
    const newerService = new FwaClanMembersSyncService({
      fetchClanMembers: vi.fn().mockResolvedValue(newerRows),
    } as any);
    const olderPromise = olderService.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:30:00.000Z"),
    });
    await oldFenceRead;

    const newerPromise = newerService.syncTrackedClan("#AAA111", {
      force: true,
      now: new Date("2026-11-21T22:31:00.000Z"),
    });
    releaseOldTransaction();
    const older = await olderPromise;
    const newer = await newerPromise;

    expect(newer.status).toBe("SUCCESS");
    expect(older.status).toBe("SUCCESS");
    expect(persistedRows[0]?.playerTag).toBe("#NEW");
    expect(state.lastAttemptAt).toEqual(new Date("2026-11-21T22:31:00.000Z"));
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
