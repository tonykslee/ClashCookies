import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaTrackedClanWarRosterSyncService } from "../src/services/fwa-feeds/FwaTrackedClanWarRosterSyncService";
import { FwaWarMembersSyncService } from "../src/services/fwa-feeds/FwaWarMembersSyncService";
import { computeFeedContentHash } from "../src/services/fwa-feeds/hash";

const txMock = vi.hoisted(() => ({
  fwaWarMemberCurrent: {
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    upsert: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  trackedClan: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeWarRow(input: {
  clanTag: string;
  playerTag: string;
  playerName: string;
  position: number;
  attacks: number;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName,
    position: input.position,
    townHall: 14,
    weight: 120000,
    opponentTag: null,
    opponentName: null,
    attacks: input.attacks,
    defender1Tag: null,
    defender1Name: null,
    defender1TownHall: null,
    defender1Position: null,
    stars1: null,
    destructionPercentage1: null,
    defender2Tag: null,
    defender2Name: null,
    defender2TownHall: null,
    defender2Position: null,
    stars2: null,
    destructionPercentage2: null,
  };
}

describe("FwaWarMembersSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs one clan and updates missing linked playerName from observed war roster names", async () => {
    const client = {
      fetchWarMembers: vi.fn().mockResolvedValue([
        makeWarRow({ clanTag: "#AAA111", playerTag: "#P1", playerName: "One", position: 1, attacks: 0 }),
        makeWarRow({ clanTag: "#AAA111", playerTag: "#P2", playerName: "Two", position: 2, attacks: 1 }),
      ]),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.findUnique.mockResolvedValue({ tag: "#AAA111" });
    txMock.fwaWarMemberCurrent.deleteMany.mockResolvedValue({ count: 1 });
    txMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#P1", playerName: null },
      { playerTag: "#P2", playerName: "Two" },
    ]);
    txMock.playerLink.updateMany.mockResolvedValue({ count: 1 });
    const trackedRosterSyncSpy = vi
      .spyOn(FwaTrackedClanWarRosterSyncService.prototype, "syncClan")
      .mockResolvedValue({
        clanTag: "#AAA111",
        rowCount: 2,
        memberRowCount: 2,
        hasSnapshot: true,
        hasUnresolvedWeights: false,
        totalEffectiveWeight: 240000,
        sourceWarId: 1001,
        sourceWarStartTime: new Date("2026-03-26T00:00:00.000Z"),
        sourceWarEndTime: new Date("2026-03-26T01:00:00.000Z"),
        sourceWarState: "inWar",
        sourceCurrentWarUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
      });

    const service = new FwaWarMembersSyncService(client);
    const result = await service.syncClan("#aaa111", { force: true });

    expect(client.fetchWarMembers).toHaveBeenCalledWith("#AAA111");
    expect(txMock.fwaWarMemberCurrent.upsert).toHaveBeenCalledTimes(2);
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
    expect(trackedRosterSyncSpy).toHaveBeenCalledTimes(1);
    expect(trackedRosterSyncSpy).toHaveBeenCalledWith("#AAA111", { now: expect.any(Date) });
    expect(result.status).toBe("SUCCESS");
    expect(result.rowCount).toBe(2);
    expect(result.changedRowCount).toBe(3);
  });

  it("updates linked playerName when observed war roster name changed", async () => {
    const client = {
      fetchWarMembers: vi.fn().mockResolvedValue([
        makeWarRow({
          clanTag: "#AAA111",
          playerTag: "#P1",
          playerName: "One Renamed",
          position: 1,
          attacks: 0,
        }),
      ]),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.findUnique.mockResolvedValue({ tag: "#AAA111" });
    txMock.fwaWarMemberCurrent.deleteMany.mockResolvedValue({ count: 0 });
    txMock.playerLink.findMany.mockResolvedValue([{ playerTag: "#P1", playerName: "One" }]);
    txMock.playerLink.updateMany.mockResolvedValue({ count: 1 });
    vi.spyOn(FwaTrackedClanWarRosterSyncService.prototype, "syncClan").mockResolvedValue({
      clanTag: "#AAA111",
      rowCount: 1,
      memberRowCount: 1,
      hasSnapshot: true,
      hasUnresolvedWeights: false,
      totalEffectiveWeight: 120000,
      sourceWarId: 1001,
      sourceWarStartTime: new Date("2026-03-26T00:00:00.000Z"),
      sourceWarEndTime: new Date("2026-03-26T01:00:00.000Z"),
      sourceWarState: "inWar",
      sourceCurrentWarUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
    });

    const service = new FwaWarMembersSyncService(client);
    const result = await service.syncClan("#AAA111", { force: true });

    expect(txMock.playerLink.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#P1" },
      data: { playerName: "One Renamed" },
    });
    expect(result.status).toBe("SUCCESS");
  });

  it("returns NOOP when payload hash is unchanged", async () => {
    const rows = [makeWarRow({ clanTag: "#AAA111", playerTag: "#P1", playerName: "One", position: 1, attacks: 0 })];
    const hash = computeFeedContentHash(rows);
    const client = {
      fetchWarMembers: vi.fn().mockResolvedValue(rows),
    } as any;
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({ lastContentHash: hash });
    prismaMock.trackedClan.findUnique.mockResolvedValue({ tag: "#AAA111" });
    const trackedRosterSyncSpy = vi
      .spyOn(FwaTrackedClanWarRosterSyncService.prototype, "syncClan")
      .mockResolvedValue({
        clanTag: "#AAA111",
        rowCount: 1,
        memberRowCount: 1,
        hasSnapshot: true,
        hasUnresolvedWeights: false,
        totalEffectiveWeight: 120000,
        sourceWarId: 1001,
        sourceWarStartTime: new Date("2026-03-26T00:00:00.000Z"),
        sourceWarEndTime: new Date("2026-03-26T01:00:00.000Z"),
        sourceWarState: "inWar",
        sourceCurrentWarUpdatedAt: new Date("2026-03-26T00:00:00.000Z"),
      });

    const service = new FwaWarMembersSyncService(client);
    const result = await service.syncClan("#AAA111", { force: true });

    expect(result.status).toBe("NOOP");
    expect(result.changedRowCount).toBe(0);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(trackedRosterSyncSpy).toHaveBeenCalledTimes(1);
  });
});
