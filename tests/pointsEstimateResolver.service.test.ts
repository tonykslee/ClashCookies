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
    warId: "old-war",
    warStartTime: previousStart(48),
    syncNum: 100,
    opponentTag: "#OLDOPP",
    clanPoints: 100,
    opponentPoints: 100,
    outcome: null,
    isFwa: true,
    syncFetchedAt: previousStart(47),
    lastSuccessfulPointsApiFetchAt: previousStart(47),
    needsValidation: true,
    lastKnownPoints: 100,
    lastKnownMatchType: "FWA",
    lastKnownOutcome: null,
    lastKnownSyncNumber: 100,
    ...overrides,
  };
}

function history(overrides: Record<string, unknown> = {}) {
  return {
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
      syncNumber: 102,
      appliedWarIds: [1],
      reason: "completed_history_deltas_applied",
    });
    expect(result.provenance?.syncNumber).toBe(100);
  });

  it.each([
    ["FWA WIN", { matchType: "FWA", actualOutcome: "WIN" }, -1],
    ["FWA LOSE", { matchType: "FWA", actualOutcome: "LOSE" }, 1],
    ["MM", { matchType: "MM", actualOutcome: null }, 0],
    ["BL over 60 destruction", { matchType: "BL", actualOutcome: "LOSE", clanDestruction: 61 }, 2],
    ["BL ordinary", { matchType: "BL", actualOutcome: "LOSE", clanDestruction: 60 }, 1],
    ["BL perfect 50", { matchType: "BL", actualOutcome: "LOSE", clanStars: 150 }, 3],
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

  it("applies multiple completed wars once and does not double-apply persisted checkpoints", async () => {
    const db = makeDb(
      [point()],
      [
        history({ warId: 1, syncNumber: 101, actualOutcome: "WIN", pointsAfterWar: 99 }),
        history({ warId: 2, syncNumber: 102, actualOutcome: "LOSE", pointsAfterWar: 100 }),
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
    const db = makeDb([point()], [history({ syncNumber: 103, actualOutcome: "WIN" })]);
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
});
