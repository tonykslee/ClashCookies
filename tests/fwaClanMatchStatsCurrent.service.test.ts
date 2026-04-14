import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFwaClanMatchStatsCurrentRowsForTest,
  FwaClanMatchStatsCurrentSyncService,
} from "../src/services/fwa-feeds/FwaClanMatchStatsCurrentSyncService";

const txMock = vi.hoisted(() => ({
  fwaClanMatchStatsCurrent: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  fwaClanWarLogCurrent: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (callback: (tx: typeof txMock) => Promise<unknown>) =>
    callback(txMock),
  ),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("buildFwaClanMatchStatsCurrentRowsForTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates mixed classifications and ignores unexpected rows", () => {
    const now = new Date("2026-04-14T18:00:00.000Z");
    const rows = [
      { clanTag: "#AAA111", opponentInfo: "FWA" },
      { clanTag: "#AAA111", opponentInfo: "Blacklisted" },
      { clanTag: "#AAA111", opponentInfo: "Friendly" },
      { clanTag: "#AAA111", opponentInfo: "Unknown" },
      { clanTag: "#AAA111", opponentInfo: null },
      { clanTag: "#AAA111", opponentInfo: "" },
      { clanTag: "#AAA111", opponentInfo: "unexpected" },
      { clanTag: "#BBB222", opponentInfo: "Unknown" },
      { clanTag: "#BBB222", opponentInfo: "ignored" },
    ];

    const out = buildFwaClanMatchStatsCurrentRowsForTest(rows, now);

    expect(out).toEqual([
      {
        clanTag: "#AAA111",
        fwaWarCount: 1,
        blacklistedWarCount: 1,
        friendlyWarCount: 1,
        unknownWarCount: 1,
        successWarCount: 3,
        evaluatedWarCount: 4,
        matchRate: 0.75,
        lastComputedAt: now,
      },
      {
        clanTag: "#BBB222",
        fwaWarCount: 0,
        blacklistedWarCount: 0,
        friendlyWarCount: 0,
        unknownWarCount: 1,
        successWarCount: 0,
        evaluatedWarCount: 1,
        matchRate: 0,
        lastComputedAt: now,
      },
    ]);
  });

  it("returns deterministic zero matchRate when a clan has no evaluated rows", () => {
    const now = new Date("2026-04-14T18:00:00.000Z");
    const rows = [
      { clanTag: "#AAA111", opponentInfo: null },
      { clanTag: "#AAA111", opponentInfo: "" },
      { clanTag: "#AAA111", opponentInfo: "unexpected" },
    ];

    const out = buildFwaClanMatchStatsCurrentRowsForTest(rows, now);

    expect(out).toEqual([
      {
        clanTag: "#AAA111",
        fwaWarCount: 0,
        blacklistedWarCount: 0,
        friendlyWarCount: 0,
        unknownWarCount: 0,
        successWarCount: 0,
        evaluatedWarCount: 0,
        matchRate: 0,
        lastComputedAt: now,
      },
    ]);
  });
});

describe("FwaClanMatchStatsCurrentSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds the snapshot from all persisted clan-war log rows", async () => {
    const now = new Date("2026-04-14T18:00:00.000Z");
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      { clanTag: "#AAA111", opponentInfo: "FWA" },
      { clanTag: "#AAA111", opponentInfo: "Unknown" },
      { clanTag: "#BBB222", opponentInfo: "Blacklisted" },
      { clanTag: "#BBB222", opponentInfo: "Friendly" },
    ]);
    txMock.fwaClanMatchStatsCurrent.deleteMany.mockResolvedValue({ count: 2 });
    txMock.fwaClanMatchStatsCurrent.createMany.mockResolvedValue({ count: 2 });

    const service = new FwaClanMatchStatsCurrentSyncService();
    const result = await service.rebuildCurrentStats({ now });

    expect(txMock.fwaClanMatchStatsCurrent.deleteMany).toHaveBeenCalledWith({});
    expect(txMock.fwaClanMatchStatsCurrent.createMany).toHaveBeenCalledWith({
      data: [
        {
          clanTag: "#AAA111",
          fwaWarCount: 1,
          blacklistedWarCount: 0,
          friendlyWarCount: 0,
          unknownWarCount: 1,
          successWarCount: 1,
          evaluatedWarCount: 2,
          matchRate: 0.5,
          lastComputedAt: now,
        },
        {
          clanTag: "#BBB222",
          fwaWarCount: 0,
          blacklistedWarCount: 1,
          friendlyWarCount: 1,
          unknownWarCount: 0,
          successWarCount: 2,
          evaluatedWarCount: 2,
          matchRate: 1,
          lastComputedAt: now,
        },
      ],
    });
    expect(result).toEqual({
      clanCount: 2,
      sourceRowCount: 4,
      evaluatedWarCount: 4,
    });
  });
});
