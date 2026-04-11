import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  fwaTrackedClanWarRosterCurrent: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  applyEffectiveWeightRulesForTest,
  deriveTrackedClanWarRosterSnapshotForTest,
  FwaTrackedClanWarRosterSyncService,
} from "../src/services/fwa-feeds/FwaTrackedClanWarRosterSyncService";

function makeSourceRow(input: {
  playerTag: string;
  playerName: string;
  position: number;
  townHall?: number | null;
  weight: number;
  opponentTag?: string | null;
  opponentName?: string | null;
  sourceSyncedAt?: Date;
}) {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    position: input.position,
    townHall: input.townHall ?? 16,
    weight: input.weight,
    opponentTag: input.opponentTag ?? "#OPP",
    opponentName: input.opponentName ?? "Opponent",
    sourceSyncedAt: input.sourceSyncedAt ?? new Date("2026-04-10T12:00:00.000Z"),
  };
}

describe("FwaTrackedClanWarRosterSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fills contiguous zero blocks from the next lower non-zero raw weight", () => {
    const rows = [
      makeSourceRow({ playerTag: "#P1", playerName: "One", position: 1, weight: 160000 }),
      makeSourceRow({ playerTag: "#P2", playerName: "Two", position: 2, weight: 0 }),
      makeSourceRow({ playerTag: "#P3", playerName: "Three", position: 3, weight: 0 }),
      makeSourceRow({ playerTag: "#P4", playerName: "Four", position: 4, weight: 154000 }),
    ];

    const derived = applyEffectiveWeightRulesForTest(
      rows.map((row) => ({
        playerTag: row.playerTag,
        playerName: row.playerName,
        position: row.position ?? 0,
        townHall: row.townHall ?? 0,
        rawWeight: row.weight ?? 0,
        opponentTag: row.opponentTag ?? null,
        opponentName: row.opponentName ?? null,
        sourceSyncedAt: row.sourceSyncedAt,
      })),
    );

    expect(derived.map((row) => [row.position, row.effectiveWeight, row.effectiveWeightStatus])).toEqual([
      [1, 160000, "RAW"],
      [2, 154000, "FILLED_FROM_LOWER_BLOCK"],
      [3, 154000, "FILLED_FROM_LOWER_BLOCK"],
      [4, 154000, "RAW"],
    ]);
  });

  it("fills a trailing zero block from the lowest resolved non-zero weight above it", () => {
    const snapshot = deriveTrackedClanWarRosterSnapshotForTest({
      clanTag: "#AAA111",
      clanName: "Tracked Clan",
      observedAt: new Date("2026-04-10T15:00:00.000Z"),
      rows: [
        makeSourceRow({ playerTag: "#P1", playerName: "One", position: 1, weight: 151000 }),
        makeSourceRow({ playerTag: "#P2", playerName: "Two", position: 2, weight: 0 }),
        makeSourceRow({ playerTag: "#P3", playerName: "Three", position: 3, weight: 145000 }),
        makeSourceRow({ playerTag: "#P4", playerName: "Four", position: 4, weight: 0 }),
        makeSourceRow({ playerTag: "#P5", playerName: "Five", position: 5, weight: 0 }),
      ],
    });

    expect(snapshot?.hasUnresolvedWeights).toBe(false);
    expect(snapshot?.totalEffectiveWeight).toBeNull();
    expect(snapshot?.members.map((row) => [row.position, row.effectiveWeight, row.effectiveWeightStatus])).toEqual([
      [1, 151000, "RAW"],
      [2, 145000, "FILLED_FROM_LOWER_BLOCK"],
      [3, 145000, "RAW"],
      [4, 145000, "FILLED_FROM_LOWER_BLOCK"],
      [5, 145000, "FILLED_FROM_LOWER_BLOCK"],
    ]);
  });

  it("copies the same lowest resolved non-zero weight through multiple trailing zero rows", () => {
    const derived = applyEffectiveWeightRulesForTest([
      {
        playerTag: "#P1",
        playerName: "One",
        position: 1,
        townHall: 16,
        rawWeight: 170000,
        opponentTag: "#OPP",
        opponentName: "Opponent",
        sourceSyncedAt: new Date("2026-04-10T12:00:00.000Z"),
      },
      {
        playerTag: "#P2",
        playerName: "Two",
        position: 2,
        townHall: 16,
        rawWeight: 155000,
        opponentTag: "#OPP",
        opponentName: "Opponent",
        sourceSyncedAt: new Date("2026-04-10T12:00:00.000Z"),
      },
      {
        playerTag: "#P3",
        playerName: "Three",
        position: 3,
        townHall: 16,
        rawWeight: 0,
        opponentTag: "#OPP",
        opponentName: "Opponent",
        sourceSyncedAt: new Date("2026-04-10T12:00:00.000Z"),
      },
      {
        playerTag: "#P4",
        playerName: "Four",
        position: 4,
        townHall: 16,
        rawWeight: 0,
        opponentTag: "#OPP",
        opponentName: "Opponent",
        sourceSyncedAt: new Date("2026-04-10T12:00:00.000Z"),
      },
    ]);

    expect(derived.map((row) => [row.position, row.effectiveWeight, row.effectiveWeightStatus])).toEqual([
      [1, 170000, "RAW"],
      [2, 155000, "RAW"],
      [3, 155000, "FILLED_FROM_LOWER_BLOCK"],
      [4, 155000, "FILLED_FROM_LOWER_BLOCK"],
    ]);
  });

  it("keeps pathological all-zero rosters explicitly unresolved", () => {
    const snapshot = deriveTrackedClanWarRosterSnapshotForTest({
      clanTag: "#AAA111",
      clanName: "Tracked Clan",
      observedAt: new Date("2026-04-10T15:00:00.000Z"),
      rows: [
        makeSourceRow({ playerTag: "#P1", playerName: "One", position: 1, weight: 0 }),
        makeSourceRow({ playerTag: "#P2", playerName: "Two", position: 2, weight: 0 }),
        makeSourceRow({ playerTag: "#P3", playerName: "Three", position: 3, weight: 0 }),
      ],
    });

    expect(snapshot?.hasUnresolvedWeights).toBe(true);
    expect(snapshot?.totalEffectiveWeight).toBeNull();
    expect(snapshot?.members.map((row) => [row.position, row.effectiveWeight, row.effectiveWeightStatus])).toEqual([
      [1, null, "UNRESOLVED_TRAILING_ZERO"],
      [2, null, "UNRESOLVED_TRAILING_ZERO"],
      [3, null, "UNRESOLVED_TRAILING_ZERO"],
    ]);
  });

  it("writes parent and child current-state rows with totals and unresolved flags", async () => {
    const now = new Date("2026-04-10T16:00:00.000Z");
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([
      makeSourceRow({ playerTag: "#P1", playerName: "One", position: 1, weight: 160000 }),
      makeSourceRow({ playerTag: "#P2", playerName: "Two", position: 2, weight: 0 }),
      makeSourceRow({ playerTag: "#P3", playerName: "Three", position: 3, weight: 150000 }),
    ]);
    prismaMock.fwaClanCatalog.findUnique.mockResolvedValue({ name: "Tracked Clan" });

    const service = new FwaTrackedClanWarRosterSyncService();
    const result = await service.syncClan("#aaa111", { now });

    expect(txMock.fwaTrackedClanWarRosterMemberCurrent.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#AAA111" },
    });
    expect(txMock.fwaTrackedClanWarRosterCurrent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clanTag: "#AAA111" },
        create: expect.objectContaining({
          clanName: "Tracked Clan",
          rosterSize: 3,
          totalRawWeight: 310000,
          totalEffectiveWeight: null,
          hasUnresolvedWeights: false,
          observedAt: now,
        }),
      }),
    );
    expect(txMock.fwaTrackedClanWarRosterMemberCurrent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          clanTag: "#AAA111",
          position: 1,
          playerTag: "#P1",
          effectiveWeight: 160000,
          effectiveWeightStatus: "RAW",
        }),
        expect.objectContaining({
          clanTag: "#AAA111",
          position: 2,
          playerTag: "#P2",
          effectiveWeight: 150000,
          effectiveWeightStatus: "FILLED_FROM_LOWER_BLOCK",
        }),
        expect.objectContaining({
          clanTag: "#AAA111",
          position: 3,
          playerTag: "#P3",
          effectiveWeight: 150000,
          effectiveWeightStatus: "RAW",
        }),
      ],
    });
    expect(result).toEqual({
      clanTag: "#AAA111",
      rowCount: 3,
      memberRowCount: 3,
      hasSnapshot: true,
      hasUnresolvedWeights: false,
      totalEffectiveWeight: null,
    });
  });

  it("clears current-state rows when no eligible source rows exist", async () => {
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanCatalog.findUnique.mockResolvedValue(null);

    const service = new FwaTrackedClanWarRosterSyncService();
    const result = await service.syncClan("#AAA111");

    expect(txMock.fwaTrackedClanWarRosterCurrent.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#AAA111" },
    });
    expect(txMock.fwaTrackedClanWarRosterMemberCurrent.createMany).not.toHaveBeenCalled();
    expect(result.hasSnapshot).toBe(false);
  });
});
