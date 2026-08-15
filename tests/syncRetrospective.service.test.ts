import { describe, expect, it, vi } from "vitest";
import { SyncRetrospectiveService } from "../src/services/SyncRetrospectiveService";

const syncTime = new Date("2026-08-15T11:00:00.000Z");

function makeDb(overrides: Record<string, unknown[]> = {}) {
  const data = {
    histories: [],
    snapshots: [],
    participation: [],
    lookups: [],
    evaluations: [],
    violations: [],
    ...overrides,
  };
  const db = {
    syncCycle: { findUnique: vi.fn(async () => ({ syncTime })) },
    clanWarHistory: { findMany: vi.fn(async () => data.histories) },
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
    clanName: "Alpha",
    clanTag: "#AAA111",
    ...overrides,
  };
}

describe("SyncRetrospectiveService", () => {
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
});
