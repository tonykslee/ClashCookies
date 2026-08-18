import { describe, expect, it, vi } from "vitest";
import { ClanHealthTrendService } from "../src/services/ClanHealthTrendService";

const syncTime = (day: number): Date => new Date(`2026-03-${String(day).padStart(2, "0")}T12:00:00.000Z`);

function snapshot(day: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `snapshot-${day}`,
    guildId: "guild-1",
    syncTime: syncTime(day),
    clanTag: "#AAA111",
    clanName: "Rocky Road",
    memberCount: 50,
    unresolvedWeightCount: 0,
    deviationScore: 5,
    projectionComplete: true,
    algorithmVersion: "actual-v1",
    fillerCaptureComplete: true,
    fillerPlayerTags: ["#PAAA"],
    ...overrides,
  };
}

function makeDb(rows: unknown[] = [], cycles: unknown[] = []) {
  return {
    syncClanReadinessSnapshot: { findMany: vi.fn().mockResolvedValue(rows) },
    syncCycle: { findMany: vi.fn().mockResolvedValue(cycles) },
  };
}

describe("ClanHealthTrendService", () => {
  it("reads the selected guild/clan window once and bulk maps sync cycles", async () => {
    const rows = [
      snapshot(10, { memberCount: 50, unresolvedWeightCount: 0, deviationScore: 5, fillerPlayerTags: ["#PAAA"] }),
      snapshot(5, { memberCount: 49, unresolvedWeightCount: 2, projectionComplete: false, deviationScore: 99, fillerCaptureComplete: false, fillerPlayerTags: [] }),
      snapshot(1, { memberCount: 47, unresolvedWeightCount: 4, deviationScore: 12, algorithmVersion: "actual-v0", fillerPlayerTags: ["#PAAA", "#PBBB"] }),
    ];
    const db = makeDb(rows, [
      { syncNumber: 545, syncTime: syncTime(10) },
      { syncNumber: 543, syncTime: syncTime(1) },
    ]);
    const cutoff = syncTime(1);
    const now = syncTime(10);

    const report = await new ClanHealthTrendService(db).getTrend({
      guildId: "guild-1",
      clanTag: "AAA111",
      cutoff,
      now,
    });

    expect(db.syncClanReadinessSnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        guildId: "guild-1",
        clanTag: "#AAA111",
        syncTime: { gte: cutoff, lte: now },
      },
      orderBy: [{ syncTime: "desc" }, { id: "desc" }],
    }));
    expect(db.syncClanReadinessSnapshot.findMany.mock.calls[0][0]).not.toHaveProperty("take");
    expect(db.syncCycle.findMany).toHaveBeenCalledTimes(1);
    expect(db.syncCycle.findMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        syncTime: { in: [syncTime(10), syncTime(5), syncTime(1)] },
      },
      select: { syncNumber: true, syncTime: true },
    });
    expect(report.snapshots.map((row) => row.syncNumber)).toEqual([545, null, 543]);
    expect(report.coverage).toEqual({
      total: 3,
      oldestSyncTime: syncTime(1),
      newestSyncTime: syncTime(10),
    });
    expect(report.deviation).toEqual({
      validCount: 2,
      oldest: 12,
      latest: 5,
      change: -7,
      direction: "improved",
      average: 8.5,
      best: 5,
      worst: 12,
    });
    expect(report.roster).toEqual({
      oldest: 47,
      latest: 50,
      delta: 3,
      average: 48.666666666666664,
      fullCount: 1,
    });
    expect(report.unresolved).toEqual({ oldest: 4, latest: 0, average: 2 });
    expect(report.fillers).toEqual({
      knownOldest: 2,
      knownLatest: 1,
      averageKnown: 1.5,
      knownCount: 2,
    });
    expect(report.algorithmVersions).toEqual(["actual-v0", "actual-v1"]);
  });

  it("keeps all summary snapshots while capping only the rendered recent list", async () => {
    const rows = Array.from({ length: 24 }, (_, index) => snapshot(24 - index));
    const db = makeDb(rows);
    const report = await new ClanHealthTrendService(db).getTrend({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: syncTime(1),
      now: syncTime(24),
    });

    expect(report.snapshots).toHaveLength(24);
    expect(report.displayedSnapshots).toHaveLength(10);
    expect(report.coverage.total).toBe(24);
    expect(report.displayedSnapshots[0].syncTime).toEqual(syncTime(24));
  });

  it("preserves an unmapped snapshot and returns a useful empty state without cycle work", async () => {
    const db = makeDb([]);
    const empty = await new ClanHealthTrendService(db).getTrend({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: syncTime(1),
      now: syncTime(10),
    });
    expect(empty.clanTag).toBe("#AAA111");
    expect(empty.coverage.total).toBe(0);
    expect(db.syncCycle.findMany).not.toHaveBeenCalled();

    const withUnmapped = makeDb([snapshot(10)]);
    const report = await new ClanHealthTrendService(withUnmapped).getTrend({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: syncTime(10),
      now: syncTime(10),
    });
    expect(report.snapshots).toHaveLength(1);
    expect(report.snapshots[0].syncNumber).toBeNull();
  });

  it("requires two valid complete deviations before classifying a trend", async () => {
    const db = makeDb([
      snapshot(10, { projectionComplete: true, deviationScore: 4 }),
      snapshot(5, { projectionComplete: false, deviationScore: 9 }),
      snapshot(1, { projectionComplete: true, deviationScore: null }),
    ]);
    const report = await new ClanHealthTrendService(db).getTrend({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: syncTime(1),
      now: syncTime(10),
    });
    expect(report.deviation.validCount).toBe(1);
    expect(report.deviation.latest).toBe(4);
    expect(report.deviation.change).toBeNull();
    expect(report.deviation.direction).toBeNull();
  });

  it("uses captured filler completeness only and does not depend on current filler state", async () => {
    const db = makeDb([
      snapshot(10, { fillerCaptureComplete: false, fillerPlayerTags: ["#PAAA", "#PBBB"] }),
      snapshot(1, { fillerCaptureComplete: true, fillerPlayerTags: [] }),
    ]);
    const report = await new ClanHealthTrendService(db).getTrend({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: syncTime(1),
      now: syncTime(10),
    });
    expect(report.fillers).toEqual({
      knownOldest: 0,
      knownLatest: 0,
      averageKnown: 0,
      knownCount: 1,
    });
    expect(db).not.toHaveProperty("fillerAccount");
  });
});

