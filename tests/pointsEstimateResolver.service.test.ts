import { describe, expect, it, vi } from "vitest";
import {
  PointsEstimateResolverService,
  type PointsEstimateReadDb,
} from "../src/services/PointsEstimateResolverService";

const activeStart = new Date("2026-09-16T12:00:00.000Z");
const previousStart = (hours: number) => new Date(activeStart.getTime() - hours * 60 * 60 * 1000);

function point(overrides: Record<string, unknown> = {}) {
  return {
    clanTag: "#HOME",
    warId: "game-war-baseline",
    warStartTime: previousStart(24),
    syncNum: 100,
    opponentTag: "#OPP",
    clanPoints: 100,
    opponentPoints: 100,
    outcome: null,
    isFwa: true,
    syncFetchedAt: previousStart(23),
    lastSuccessfulPointsApiFetchAt: previousStart(23),
    needsValidation: true,
    lastKnownPoints: 100,
    lastKnownMatchType: "FWA",
    lastKnownOutcome: null,
    lastKnownSyncNumber: 100,
    ...overrides,
  };
}

function history(overrides: Record<string, unknown> = {}) {
  const result = {
    warId: 1,
    syncNumber: 101,
    matchType: "FWA",
    clanStars: 100,
    clanDestruction: 50,
    opponentStars: 100,
    opponentDestruction: 50,
    pointsAfterWar: null,
    expectedOutcome: null,
    actualOutcome: "WIN",
    warStartTime: previousStart(24),
    warEndTime: previousStart(20),
    clanTag: "#HOME",
    opponentTag: "#OPP",
    ...overrides,
  };
  if (!("clanStars" in overrides) && !("opponentStars" in overrides) &&
    !("clanDestruction" in overrides) && !("opponentDestruction" in overrides)) {
    if (result.actualOutcome === "WIN") {
      result.clanStars = 101;
      result.opponentStars = 100;
    } else if (result.actualOutcome === "LOSE") {
      result.clanStars = 100;
      result.opponentStars = 101;
    }
  }
  return result;
}

function makeDb(points: unknown[] = [], histories: unknown[] = [], lookups: unknown[] = []) {
  return {
    clanPointsSync: { findMany: vi.fn().mockResolvedValue(points) },
    clanWarHistory: { findMany: vi.fn().mockResolvedValue(histories) },
    warLookup: { findMany: vi.fn().mockResolvedValue(lookups) },
    syncCycle: { findFirst: vi.fn() },
  } as unknown as PointsEstimateReadDb & {
    clanPointsSync: { findMany: ReturnType<typeof vi.fn> };
    clanWarHistory: { findMany: ReturnType<typeof vi.fn> };
    warLookup: { findMany: ReturnType<typeof vi.fn> };
    syncCycle: { findFirst: ReturnType<typeof vi.fn> };
  };
}

function active(overrides: Record<string, unknown> = {}) {
  return {
    warId: "active-war",
    warStartTime: activeStart,
    opponentTag: "#OPP",
    syncNumber: 102,
    matchType: "FWA",
    ...overrides,
  };
}

describe("PointsEstimateResolverService", () => {
  it("prefers a validated same-war balance", async () => {
    const db = makeDb([
      point({
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 102,
        opponentTag: "#OPP",
        clanPoints: 123,
        lastKnownPoints: 123,
        needsValidation: false,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ trackedClanTag: "#HOME" }),
    });

    expect(result).toMatchObject({
      balance: 123,
      source: "validated_same_war",
      isEstimate: false,
      isValidatedCurrentMatchupEvidence: true,
      reason: "validated_same_war_points_sync",
    });
  });

  it("does not confirm same-war evidence from a different sync", async () => {
    const db = makeDb([
      point({
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        needsValidation: false,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102, trackedClanTag: "#HOME" }),
    });

    expect(result.isValidatedCurrentMatchupEvidence).toBe(false);
    expect(result.source).not.toBe("validated_same_war");
  });

  it("does not confirm a same-war opponent observation from a different sync", async () => {
    const db = makeDb([
      point({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentPoints: 177,
        needsValidation: false,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#OPP",
      activeWar: active({ syncNumber: 102, trackedClanTag: "#HOME" }),
    });

    expect(result.isValidatedCurrentMatchupEvidence).toBe(false);
    expect(result.source).not.toBe("validated_same_war_opponent_observation");
  });

  it("rejects a future-dated points row even when its sync number is older", async () => {
    const db = makeDb([
      point({
        warId: "active-war",
        warStartTime: new Date(activeStart.getTime() + 60 * 60 * 1000),
        syncNum: 101,
        lastKnownSyncNumber: 101,
        needsValidation: false,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: null,
      source: "unavailable",
      coverage: "no_usable_balance",
    });
  });

  it("excludes null-sync history before the baseline but stops on null-sync history after it", async () => {
    const db = makeDb(
      [point({ warStartTime: previousStart(48) })],
      [
        history({ warId: 0, syncNumber: null, warStartTime: previousStart(72), warEndTime: previousStart(70) }),
        history({ warId: 1, syncNumber: null, warStartTime: previousStart(24), warEndTime: previousStart(20) }),
      ],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result).toMatchObject({
      balance: 100,
      appliedWarIds: [],
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_sync_number_missing",
    });
  });

  it("does not let a last-known sync beyond the active sync become a baseline", async () => {
    const db = makeDb([point({ syncNum: 100, lastKnownSyncNumber: 103 })]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: null,
      source: "unavailable",
      coverage: "no_usable_balance",
    });
  });

  it("reconstructs a useful estimate while the website is still on the previous matchup", async () => {
    const db = makeDb([point()], [history()]);
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result).toMatchObject({
      balance: 99,
      source: "history_reconstruction",
      isEstimate: true,
      isValidatedCurrentMatchupEvidence: false,
      coverage: "complete_reconstruction",
      projectionSafe: true,
      syncNumber: 102,
      appliedWarIds: [1],
      reason: "completed_history_deltas_applied",
    });
    expect(result.provenance?.syncNumber).toBe(101);
  });

  it.each([
    ["FWA WIN", { matchType: "FWA", actualOutcome: "WIN" }, -1],
    ["FWA LOSE", { matchType: "FWA", actualOutcome: "LOSE" }, 1],
    ["MM", { matchType: "MM", actualOutcome: null }, 0],
    ["BL over 60 destruction", { matchType: "BL", actualOutcome: "LOSE", clanDestruction: 61, opponentDestruction: 70 }, 2],
    ["BL ordinary", { matchType: "BL", actualOutcome: "LOSE", clanDestruction: 60, opponentDestruction: 70 }, 1],
    ["BL perfect 50", { matchType: "BL", actualOutcome: "LOSE", clanStars: 150, opponentStars: 150, opponentDestruction: 61 }, 3],
  ])("uses the existing %s point rule", async (_label, row, delta) => {
    const db = makeDb(
      [point()],
      [history(row)],
      row.matchType === "BL" && row.clanStars === 150
        ? [{ warId: "1", payload: { warMeta: { teamSize: 50 } } }]
        : [],
    );
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result.balance).toBe(100 + delta);
  });

  it("uses a safe persisted BL checkpoint when rule inputs are incomplete", async () => {
    const db = makeDb(
      [point()],
      [history({ matchType: "BL", actualOutcome: "LOSE", clanDestruction: null, pointsAfterWar: 105 })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result).toMatchObject({
      balance: 105,
      appliedWarIds: [1],
      coverage: "complete_reconstruction",
      projectionSafe: true,
    });
  });

  it("does not infer a BL award when missing team size could change a perfect-war result", async () => {
    const db = makeDb(
      [point()],
      [history({ matchType: "BL", actualOutcome: "LOSE", clanStars: 150, clanDestruction: null, pointsAfterWar: 106 })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result.balance).toBe(106);
    expect(result.projectionSafe).toBe(true);
  });

  it("stops BL reconstruction when missing inputs have no safe persisted checkpoint", async () => {
    const db = makeDb(
      [point()],
      [history({ matchType: "BL", actualOutcome: "LOSE", clanDestruction: null, pointsAfterWar: null })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result).toMatchObject({
      balance: 100,
      source: "last_known_observed",
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_delta_input_incomplete",
    });
  });

  it("applies multiple completed wars once and does not double-apply persisted checkpoints", async () => {
    const db = makeDb(
      [point()],
      [
        history({ warId: 1, syncNumber: 101, actualOutcome: "WIN", pointsAfterWar: 99 }),
        history({ warId: 2, syncNumber: 102, actualOutcome: "LOSE", pointsAfterWar: 100, warStartTime: previousStart(12), warEndTime: previousStart(10) }),
      ],
    );
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 103 }),
    });

    expect(result.balance).toBe(100);
    expect(result.appliedWarIds).toEqual([1, 2]);
  });

  it("stops at unknown results and preserves the last safe observed balance", async () => {
    const db = makeDb([point()], [history({ actualOutcome: null })]);
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result).toMatchObject({
      balance: 100,
      source: "last_known_observed",
      isEstimate: true,
      appliedWarIds: [],
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_actual_result_unconfirmed",
    });
  });

  it("uses an attributed opponent observation without crossing clan identities", async () => {
    const db = makeDb([
      point({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 102,
        clanPoints: 200,
        opponentPoints: 177,
        needsValidation: false,
      }),
      point({
        clanTag: "#OTHER",
        opponentTag: "#OPP",
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 102,
        clanPoints: 999,
        opponentPoints: 188,
        needsValidation: false,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#OPP",
      activeWar: active({ trackedClanTag: "#HOME" }),
    });

    expect(result).toMatchObject({
      balance: 177,
      source: "validated_same_war_opponent_observation",
      isValidatedCurrentMatchupEvidence: true,
    });
    expect(result.provenance?.sourceClanTag).toBe("#HOME");
  });

  it("returns unavailable rather than crossing a sync gap or inventing an outcome", async () => {
    const db = makeDb([point({ warStartTime: previousStart(48) })], [history({ syncNumber: 103, actualOutcome: "WIN" })]);
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 104 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      source: "last_known_observed",
      reason: "history_sync_gap",
    });
    expect(result.projectionSafe).toBe(false);
  });

  it("is DB-first and read-only: it performs no writes, web calls, or sync allocation", async () => {
    const db = makeDb([point()], []);
    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active(),
    });

    expect(result.isEstimate).toBe(true);
    expect(db.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
    expect(db.clanWarHistory.findMany).toHaveBeenCalledTimes(1);
    expect(db.syncCycle.findFirst).not.toHaveBeenCalled();
    expect(db.warLookup.findMany).not.toHaveBeenCalled();
    expect(db.clanPointsSync.findMany.mock.calls[0][0].where).toMatchObject({
      guildId: "guild-1",
      OR: [
        { clanTag: "#H0ME" },
        { clanTag: "#0PP", opponentTag: "#H0ME" },
      ],
    });
    expect(db.clanWarHistory.findMany.mock.calls[0][0].where).toMatchObject({
      clanTag: "#H0ME",
      warEndTime: { not: null },
      warStartTime: { lt: activeStart },
    });
    expect(db.clanWarHistory.findMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect((db as Record<string, unknown>).create).toBeUndefined();
    expect((db as Record<string, unknown>).update).toBeUndefined();
  });

  it("can read a sync candidate through the active-war resolver without persisting it", async () => {
    const db = makeDb([point()], []);
    const activeWarResolver = {
      resolveActiveWarSyncFromCanonicalCycle: vi.fn().mockResolvedValue({
        syncNumber: 102,
        source: "active_war_schedule_candidate",
      }),
    };
    const result = await new PointsEstimateResolverService(db, activeWarResolver as any).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: null, prepStartTime: activeStart, matchType: "FWA" }),
    });

    expect(result.syncNumber).toBe(102);
    expect(result.syncNumberSource).toBe("active_war_schedule_candidate");
    expect(activeWarResolver.resolveActiveWarSyncFromCanonicalCycle).toHaveBeenCalledWith(
      expect.objectContaining({ persistCanonical: false, shareDerivedCandidate: false }),
    );
  });

  it("applies a pre-war observed baseline's canonical result exactly once", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-101",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 50101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        pointsAfterWar: 99,
        actualOutcome: "WIN",
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 99,
      coverage: "complete_reconstruction",
      projectionSafe: true,
      appliedWarIds: [50101],
    });
  });

  it("keeps a pre-war baseline diagnostic but refuses projection without a confirmed result", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-101",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 50101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        pointsAfterWar: null,
        actualOutcome: null,
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_actual_result_unconfirmed",
    });
  });

  it("does not reapply a baseline war when the observed checkpoint is post-war", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-101",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        clanPoints: 99,
        lastKnownPoints: 99,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(12),
        lastSuccessfulPointsApiFetchAt: previousStart(12),
      })],
      [history({
        warId: 50101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        pointsAfterWar: 99,
        actualOutcome: "WIN",
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({ balance: 99, projectionSafe: true, appliedWarIds: [] });
  });

  it("does not invent an opponent projection without the opponent's baseline history", async () => {
    const db = makeDb([
      point({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        warId: "old-war",
        warStartTime: previousStart(48),
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentPoints: 177,
      }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#OPP",
      activeWar: active({ syncNumber: 102, trackedClanTag: "#HOME" }),
    });

    expect(result).toMatchObject({
      balance: 177,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "baseline_war_history_unavailable",
    });
  });

  it("retains an observed balance diagnostically when its baseline war history is absent", async () => {
    const db = makeDb([
      point({
        warId: "game-war-missing",
        warStartTime: previousStart(48),
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "baseline_war_history_unavailable",
    });
  });

  it("uses the opponent's own canonical history when reconciling an opponent observation", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        clanTag: "#HOME",
        opponentTag: "#OPP",
        warId: "game-war-101",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentPoints: 177,
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 50101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        clanTag: "#OPP",
        opponentTag: "#HOME",
        pointsAfterWar: 176,
        actualOutcome: "WIN",
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#OPP",
      activeWar: active({ syncNumber: 102, trackedClanTag: "#HOME" }),
    });

    expect(result).toMatchObject({ balance: 176, projectionSafe: true, appliedWarIds: [50101] });
  });

  it("rejects canonical history with a conflicting opponent identity", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-conflict",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 51101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        opponentTag: "#OTHER",
        pointsAfterWar: 99,
        actualOutcome: "WIN",
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "baseline_war_history_unavailable",
    });
  });

  it("uses canonical SyncCycle authority before stale same-war points evidence", async () => {
    const syncTime = new Date("2026-09-16T11:59:00.000Z");
    const db = makeDb([
      point({
        warId: "active-war",
        warStartTime: activeStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        needsValidation: true,
      }),
    ]);
    db.syncCycle.findFirst.mockResolvedValue({ syncNumber: 102 });

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: null, syncTime }),
    });

    expect(result.syncNumber).toBe(102);
    expect(result.syncNumberSource).toBe("canonical_sync_cycle");
    expect(result.isValidatedCurrentMatchupEvidence).toBe(false);
    expect(db.syncCycle.findFirst.mock.invocationCallOrder[0])
      .toBeLessThan(db.clanWarHistory.findMany.mock.invocationCallOrder[0]);
  });

  it("does not choose the first of conflicting validated same-war sync rows", async () => {
    const db = makeDb([
      point({ warId: "active-war", warStartTime: activeStart, syncNum: 101, needsValidation: false }),
      point({ warId: "active-war", warStartTime: activeStart, syncNum: 102, needsValidation: false }),
    ]);

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: null }),
    });

    expect(result.syncNumber).toBeNull();
    expect(result.isValidatedCurrentMatchupEvidence).toBe(false);
    expect(result.reason).toBe("sync_evidence_conflict");
  });

  it("stops BL reconstruction when stars are missing even if destruction is known", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-101",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 50101,
        syncNumber: 101,
        matchType: "BL",
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        actualOutcome: "LOSE",
        clanStars: null,
        clanDestruction: 61,
        pointsAfterWar: null,
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_delta_input_incomplete",
    });
    expect(db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("stops BL reconstruction when perfect-war stars have unknown team size and no checkpoint", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-bl-perfect",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 60101,
        syncNumber: 101,
        matchType: "BL",
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        actualOutcome: "LOSE",
        clanStars: 150,
        clanDestruction: 61,
        opponentStars: 150,
        opponentDestruction: 70,
        pointsAfterWar: null,
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_delta_input_incomplete",
    });
    expect(db.warLookup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { warId: { in: ["60101"] } },
    }));
  });

  it("does not turn an expected-outcome fallback into a point change", async () => {
    const baselineStart = previousStart(48);
    const db = makeDb(
      [point({
        warId: "game-war-expected",
        warStartTime: baselineStart,
        syncNum: 101,
        lastKnownSyncNumber: 101,
        opponentTag: "#OPP",
        syncFetchedAt: previousStart(36),
        lastSuccessfulPointsApiFetchAt: previousStart(36),
      })],
      [history({
        warId: 70101,
        syncNumber: 101,
        warStartTime: baselineStart,
        warEndTime: previousStart(24),
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        actualOutcome: "WIN",
        expectedOutcome: "WIN",
        pointsAfterWar: null,
      })],
    );

    const result = await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    expect(result).toMatchObject({
      balance: 100,
      coverage: "last_known_unresolved_history",
      projectionSafe: false,
      reason: "history_actual_result_unconfirmed",
    });
  });

  it("bounds history at the selected baseline and loads lookup data only for relevant BL rows", async () => {
    const selectedStart = previousStart(48);
    const db = makeDb(
      [
        point({ warStartTime: previousStart(100), syncNum: 90, lastKnownSyncNumber: 90 }),
        point({ warStartTime: selectedStart, syncNum: 100, lastKnownSyncNumber: 100 }),
      ],
      [
        history({ warId: 1, syncNumber: 101, matchType: "FWA" }),
        history({ warId: 2, syncNumber: 101, matchType: "BL", actualOutcome: "LOSE", clanStars: 100, clanDestruction: 60 }),
      ],
      [{ warId: "2", payload: { warMeta: { teamSize: 50 } } }],
    );

    await new PointsEstimateResolverService(db).resolveForClan({
      guildId: "guild-1",
      clanTag: "#HOME",
      activeWar: active({ syncNumber: 102 }),
    });

    const historyWhere = db.clanWarHistory.findMany.mock.calls[0][0].where;
    expect(historyWhere).toMatchObject({
      clanTag: "#H0ME",
      warStartTime: { gte: selectedStart, lt: activeStart },
    });
    expect(historyWhere.OR).toBeUndefined();
    expect(db.warLookup.findMany.mock.calls[0][0].where).toEqual({ warId: { in: ["2"] } });
  });
});
