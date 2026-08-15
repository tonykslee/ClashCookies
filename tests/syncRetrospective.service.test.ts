import { describe, expect, it, vi } from "vitest";
import { SyncRetrospectiveService } from "../src/services/SyncRetrospectiveService";

const syncTime = new Date("2026-08-15T11:00:00.000Z");

function makeDb(overrides: Record<string, unknown[]> = {}) {
  const data = {
    cycles: [{ syncNumber: 42, syncTime }],
    histories: [],
    pointsSync: [],
    snapshots: [],
    participation: [],
    lookups: [],
    evaluations: [],
    violations: [],
    ...overrides,
  };
  const db = {
    syncCycle: {
      findUnique: vi.fn(async () => ({ syncTime })),
      findMany: vi.fn(async () => data.cycles),
    },
    clanPointsSync: { findMany: vi.fn(async () => data.pointsSync) },
    clanWarHistory: {
      findMany: vi.fn(async ({ where }: any) => {
        const candidates = (where?.OR ?? []).flatMap((candidate: any) => {
          if (candidate.warId?.in) return data.histories.filter((row: any) => candidate.warId.in.includes(row.warId));
          return data.histories.filter((row: any) =>
            row.clanTag === candidate.clanTag &&
            row.opponentTag === candidate.opponentTag &&
            row.warStartTime?.getTime() === candidate.warStartTime?.getTime(),
          );
        });
        return candidates.filter((row: any) => row.syncNumber === where?.syncNumber);
      }),
    },
    syncClanReadinessSnapshot: { findMany: vi.fn(async () => data.snapshots) },
    clanWarParticipation: { findMany: vi.fn(async () => data.participation) },
    warLookup: { findMany: vi.fn(async () => data.lookups) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => data.evaluations) },
    warPlanViolation: { findMany: vi.fn(async () => data.violations) },
  };
  return db;
}

function history(overrides: Record<string, unknown> = {}) {
  return {
    warId: 101,
    syncNumber: 42,
    matchType: "FWA",
    clanStars: 100,
    expectedOutcome: "WIN",
    actualOutcome: "WIN",
    prepStartTime: new Date("2026-08-10T00:00:00.000Z"),
    warStartTime: new Date("2026-08-10T00:00:00.000Z"),
    opponentTag: "#OPP111",
    clanName: "Alpha",
    clanTag: "#AAA111",
    ...overrides,
  };
}

function pointsBridge(row: Record<string, any>, warId: number | null = row.warId) {
  return {
    clanTag: row.clanTag,
    warId: warId === null ? null : String(warId),
    warStartTime: row.warStartTime,
    opponentTag: row.opponentTag,
    syncNum: 42,
  };
}

describe("SyncRetrospectiveService", () => {
  it("selects the newest cycle with guild-owned evidence or a mapped snapshot", async () => {
    const db = makeDb({
      cycles: [
        { syncNumber: 43, syncTime: new Date("2026-08-16T11:00:00.000Z") },
        { syncNumber: 42, syncTime },
      ],
      pointsSync: [{ syncNum: 42 }],
    });

    await expect(new SyncRetrospectiveService(db).getLatestAvailableSyncNumber({ guildId: "guild-1" }))
      .resolves.toBe(42);
    expect(db.syncCycle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: "guild-1" },
      orderBy: { syncNumber: "desc" },
      take: 100,
    }));
  });

  it("does not select an empty cycle as the latest retrospective", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 43, syncTime: new Date("2026-08-16T11:00:00.000Z") }],
    });
    await expect(new SyncRetrospectiveService(db).getLatestAvailableSyncNumber({ guildId: "guild-1" }))
      .resolves.toBeNull();
  });

  it("selects a snapshot-only cycle when no guild-owned war evidence exists", async () => {
    const snapshotOnlyTime = new Date("2026-08-17T11:00:00.000Z");
    const db = makeDb({
      cycles: [{ syncNumber: 44, syncTime: snapshotOnlyTime }],
      snapshots: [{ guildId: "guild-1", syncTime: snapshotOnlyTime }],
    });
    await expect(new SyncRetrospectiveService(db).getLatestAvailableSyncNumber({ guildId: "guild-1" }))
      .resolves.toBe(44);
  });

  it("builds typed summaries from mapped persisted evidence and preserves exact zero", async () => {
    const db = makeDb({
      histories: [
        history(),
        history({
          warId: 102,
          clanTag: "#BBB222",
          clanName: "Bravo",
          matchType: "BL",
          clanStars: null,
          expectedOutcome: null,
          actualOutcome: null,
        }),
      ],
      snapshots: [
        {
          guildId: "guild-1", syncTime, clanTag: "#AAA111", clanName: "Alpha", memberCount: 50,
          deviationScore: 0, projectionComplete: true, fillerCaptureComplete: true, fillerPlayerTags: [],
        },
        {
          guildId: "guild-1", syncTime, clanTag: "#BBB222", clanName: "Bravo", memberCount: 49,
          deviationScore: 2, projectionComplete: false, fillerCaptureComplete: false, fillerPlayerTags: [],
        },
        {
          guildId: "guild-1", syncTime, clanTag: "#CCC333", clanName: "Charlie", memberCount: 50,
          deviationScore: 4, projectionComplete: true, fillerCaptureComplete: true, fillerPlayerTags: ["#F1", "#F2"],
        },
      ],
      participation: [
        { warId: "101", clanTag: "#AAA111", playerTag: "#P1", playerName: "One", attacksUsed: 2, attacksMissed: 0, starsEarned: 3 },
        { warId: "101", clanTag: "#AAA111", playerTag: "#P2", playerName: "Two", attacksUsed: 1, attacksMissed: 1, starsEarned: 2 },
        { warId: "102", clanTag: "#BBB222", playerTag: "#P3", playerName: "Three", attacksUsed: 2, attacksMissed: 0, starsEarned: 3 },
      ],
      lookups: [
        { warId: "101", payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" } } },
        { warId: "102", payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" } } },
      ],
      evaluations: [
        { id: "eval-101", guildId: "guild-1", warId: 101, status: "COMPLETED", matchType: "FWA", expectedOutcome: "WIN" },
        { id: "eval-102", guildId: "guild-1", warId: 102, status: "COMPLETED", matchType: "BL", expectedOutcome: null },
      ],
      violations: [
        {
          evaluationId: "eval-101", violationType: "MISSED_BOTH", playerTag: "#P2",
          playerNameSnapshot: "Two", reasonLabel: "missed both", expectedBehavior: "Attack", actualBehavior: "None",
        },
      ],
    });

    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(result.identity).toEqual({ guildId: "guild-1", syncNumber: 42, syncTime, cycleMapped: true });
    expect(result.warSummary).toEqual({ clanWarCount: 2, totalStarsKnown: 100, starsCoverage: { known: 1, total: 2 } });
    expect(result.missedAttacks).toEqual({ missedAttacksKnownTotal: 1, coverage: { completeClans: 1, warClans: 2 } });
    expect(result.fwaViolations).toEqual({ violationKnownTotal: 1, coverage: { completedFwaEvaluations: 1, fwaWars: 1 } });
    expect(result.readiness).toEqual({ averageDeviation: 2, deviationCoverage: { valid: 2, totalSnapshots: 3 } });
    expect(result.fillers).toEqual({ fillerKnownTotal: 2, fillerCoverage: { complete: 2, totalSnapshots: 3 } });

    const alpha = result.clans.find((clan) => clan.identity.clanTag === "#AAA111")!;
    const bravo = result.clans.find((clan) => clan.identity.clanTag === "#BBB222")!;
    const charlie = result.clans.find((clan) => clan.identity.clanTag === "#CCC333")!;
    expect(alpha.missedAttacks.coverageComplete).toBe(true);
    expect(alpha.missedAttacks.players).toHaveLength(2);
    expect(alpha.violations).toMatchObject({ total: 1, evaluationComplete: true, applicable: true });
    expect(alpha.fillers).toEqual({ fillerCount: 0, fillerPlayerTags: [], fillerCaptureComplete: true });
    expect(bravo).toMatchObject({
      missedAttacks: { total: null, coverageComplete: false },
      violations: { total: null, evaluationComplete: false, applicable: false },
      readiness: { deviationScore: null, projectionComplete: false },
      fillers: { fillerCount: null, fillerCaptureComplete: false },
    });
    expect(charlie.identity.warId).toBeNull();
    expect(charlie.fillers.fillerPlayerTags).toEqual(["#F1", "#F2"]);

    expect(db.clanWarParticipation.findMany).toHaveBeenCalledTimes(1);
    expect(db.warLookup.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(1);
  });

  it("marks participation incomplete for missing, duplicate, or non-authoritative roster evidence", async () => {
    const db = makeDb({
      histories: [history()],
      pointsSync: [{
        clanTag: "#AAA111", warId: "101", warStartTime: history().prepStartTime,
        opponentTag: "#OPP111", syncNum: 42,
      }],
      participation: [
        { warId: "101", clanTag: "#AAA111", playerTag: "#P1", attacksUsed: 2, attacksMissed: 0, starsEarned: 3 },
      ],
      lookups: [{ warId: "101", payload: { warMeta: { teamSize: 2, teamSizeSource: "inferred" } } }],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });
    expect(result.missedAttacks).toEqual({ missedAttacksKnownTotal: null, coverage: { completeClans: 0, warClans: 1 } });
    expect(result.clans[0].missedAttacks).toEqual({ total: null, coverageComplete: false, players: [] });
  });

  it("does not turn an incomplete FWA evaluation or invalid readiness into zero", async () => {
    const db = makeDb({
      histories: [history()],
      evaluations: [{ id: "eval-101", guildId: "guild-1", warId: 101, status: "PENDING", matchType: "FWA", expectedOutcome: "WIN" }],
      snapshots: [{
        guildId: "guild-1", syncTime, clanTag: "#AAA111", clanName: "Alpha", memberCount: "unknown",
        deviationScore: Number.NaN, projectionComplete: true, fillerCaptureComplete: false, fillerPlayerTags: [],
      }],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });
    expect(result.fwaViolations.violationKnownTotal).toBeNull();
    expect(result.fwaViolations.coverage).toEqual({ completedFwaEvaluations: 0, fwaWars: 1 });
    expect(result.readiness).toEqual({ averageDeviation: null, deviationCoverage: { valid: 0, totalSnapshots: 1 } });
    expect(result.clans[0].readiness.memberCount).toBeNull();
  });

  it("isolates same-sync histories by guild-owned persisted evidence", async () => {
    const guildOneHistory = history({ warId: 201, clanTag: "#2QG2C08UP", clanStars: 101 });
    const guildTwoHistory = history({ warId: 202, clanTag: "#2QG2C08UQ", clanStars: 202 });
    const db = makeDb({ histories: [guildOneHistory, guildTwoHistory], pointsSync: [pointsBridge(guildOneHistory)] });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(result.warSummary).toEqual({ clanWarCount: 1, totalStarsKnown: 101, starsCoverage: { known: 1, total: 1 } });
    expect(result.missedAttacks.coverage.warClans).toBe(1);
    expect(result.fwaViolations.coverage.fwaWars).toBe(1);
    expect(result.clans.map((clan) => clan.identity.clanTag)).toEqual(["#2QG2C08UP"]);
  });

  it("admits an FWA history through a guild evaluation even without ClanPointsSync", async () => {
    const fwaHistory = history({ warId: 301, clanTag: "#2QG2C08UR" });
    const db = makeDb({
      histories: [fwaHistory],
      evaluations: [{ id: "eval-301", guildId: "guild-1", warId: 301, status: "PENDING", matchType: "FWA", expectedOutcome: "WIN" }],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(result.warSummary.clanWarCount).toBe(1);
    expect(result.fwaViolations.coverage).toEqual({ completedFwaEvaluations: 0, fwaWars: 1 });
    expect(result.clans[0].identity.clanTag).toBe("#2QG2C08UR");
  });

  it("admits BL/MM only through exact guild-scoped points identity", async () => {
    const blHistory = history({ warId: 401, clanTag: "#2QG2C08US", matchType: "BL", clanStars: 99 });
    const mmHistory = history({ warId: 402, clanTag: "#2QG2C08UT", matchType: "MM", clanStars: 88 });
    const db = makeDb({ histories: [blHistory, mmHistory], pointsSync: [pointsBridge(blHistory)] });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(result.clans.map((clan) => clan.identity.clanTag)).toEqual(["#2QG2C08US"]);
    expect(result.clans[0].violations).toMatchObject({ applicable: false, evaluationComplete: false, total: null });
  });

  it("uses the exact points identity when ClanPointsSync has no war ID", async () => {
    const bridgedHistory = history({ warId: 451, clanTag: "#2QG2C08UU", matchType: "BL" });
    const unrelatedHistory = history({ warId: 452, clanTag: "#2QG2C08UV", matchType: "BL" });
    const db = makeDb({
      histories: [bridgedHistory, unrelatedHistory],
      pointsSync: [pointsBridge(bridgedHistory, null)],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });
    expect(result.clans.map((clan) => clan.identity.clanTag)).toEqual(["#2QG2C08UU"]);
  });

  it("keeps war-only and snapshot-only clans while excluding histories with no guild evidence", async () => {
    const warOnly = history({ warId: 501, clanTag: "#2QG2C08UW" });
    const unknown = history({ warId: 502, clanTag: "#2QG2C08UX" });
    const db = makeDb({
      histories: [warOnly, unknown],
      pointsSync: [pointsBridge(warOnly)],
      snapshots: [{
        guildId: "guild-1", syncTime, clanTag: "#2QG2C08UY", clanName: "Snapshot", memberCount: 50,
        deviationScore: 0, projectionComplete: true, fillerCaptureComplete: true, fillerPlayerTags: [],
      }],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(result.warSummary.clanWarCount).toBe(1);
    expect(result.clans.map((clan) => clan.identity.clanTag)).toEqual(["#2QG2C08UW", "#2QG2C08UY"]);
  });

  it("uses bounded bulk reads and never performs an unscoped history scan", async () => {
    const owned = history({ warId: 701, clanTag: "#2QG2C08UZ" });
    const db = makeDb({ histories: [owned], pointsSync: [pointsBridge(owned)] });
    await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });

    expect(db.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
    expect(db.clanWarHistory.findMany).toHaveBeenCalledTimes(1);
    expect(db.clanWarHistory.findMany.mock.calls[0][0].where).toEqual({
      syncNumber: 42,
      OR: [{ warId: { in: [701] } }],
    });
    expect(db.clanWarParticipation.findMany).toHaveBeenCalledTimes(1);
    expect(db.warLookup.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanViolation.findMany).not.toHaveBeenCalled();
  });

  it("returns no history for a global same-sync row without guild-owned evidence", async () => {
    const db = makeDb({ histories: [history({ warId: 801, clanTag: "#2QG2C08UA" })] });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });
    expect(result.warSummary.clanWarCount).toBe(0);
    expect(result.clans).toEqual([]);
    expect(db.clanWarHistory.findMany).not.toHaveBeenCalled();
  });

  it("keeps stale completed compliance unknown when persisted facts disagree with history", async () => {
    const fwaHistory = history({ warId: 901, clanTag: "#2QG2C08UB", expectedOutcome: "WIN", matchType: "FWA" });
    const db = makeDb({
      histories: [fwaHistory],
      evaluations: [{ id: "eval-901", guildId: "guild-1", warId: 901, status: "COMPLETED", matchType: "FWA", expectedOutcome: "LOSE" }],
      violations: [{ evaluationId: "eval-901", violationType: "PLAN", playerTag: "#P1" }],
    });
    const result = await new SyncRetrospectiveService(db).getBySyncNumber({ guildId: "guild-1", syncNumber: 42 });
    expect(result.fwaViolations).toEqual({
      violationKnownTotal: null,
      coverage: { completedFwaEvaluations: 0, fwaWars: 1 },
    });
    expect(result.clans[0].violations).toMatchObject({ total: null, evaluationComplete: false, applicable: true });
  });
});
