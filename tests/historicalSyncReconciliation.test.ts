import { describe, expect, it } from "vitest";
import {
  associateCanonicalHistories,
  classifyAnchoredSequenceInterval,
  classifyHistorySyncClaim,
  classifyPointsSyncClaim,
  planAnchoredSequenceIntervals,
  type ReconciliationAnchor,
  type ReconciliationCycle,
  type ReconciliationHistory,
  type ReconciliationPoint,
  type ReconciliationSchedule,
} from "../src/services/historicalSyncReconciliation";
import {
  parseHistoricalSyncReconciliationArgs,
  runHistoricalSyncReconciliation,
} from "../src/scripts/auditHistoricalSyncReconciliation";

const guildId = "guild-1";
const otherGuildId = "guild-2";
const base = new Date("2026-06-16T00:20:00.000Z");

function anchor(syncNumber: number, offsetHours: number, guild = guildId): ReconciliationAnchor {
  return { guildId: guild, syncNumber, syncTime: new Date(base.getTime() + offsetHours * 60 * 60 * 1000), source: "ENDED_WAR_CANONICAL" };
}

function schedule(id: string, offsetHours: number, guild = guildId, status = "PUBLISHED"): ReconciliationSchedule {
  return { id, guildId: guild, syncTime: new Date(base.getTime() + offsetHours * 60 * 60 * 1000), status };
}

function history(overrides: Partial<ReconciliationHistory> = {}): ReconciliationHistory {
  return {
    warId: 100,
    syncNumber: 521,
    matchType: "FWA",
    clanTag: "#HOME",
    opponentTag: "#OPPONENT",
    warStartTime: new Date("2026-06-17T04:00:00.000Z"),
    prepStartTime: new Date("2026-06-17T01:00:00.000Z"),
    warEndTime: new Date("2026-06-17T08:00:00.000Z"),
    ...overrides,
  };
}

function point(overrides: Partial<ReconciliationPoint> = {}): ReconciliationPoint {
  return {
    guildId,
    syncNumber: 521,
    warId: 100,
    clanTag: "#HOME",
    warStartTime: new Date("2026-06-17T04:00:00.000Z"),
    opponentTag: "#OPPONENT",
    isFwa: true,
    ...overrides,
  };
}

function exactInterval(overrides: Partial<Parameters<typeof classifyAnchoredSequenceInterval>[0]> = {}) {
  return classifyAnchoredSequenceInterval({
    lower: anchor(520, 0),
    upper: anchor(522, 48),
    schedules: [schedule("s-521", 24)],
    existingCycles: [],
    ...overrides,
  });
}

function runDb(overrides: {
  cycles?: any[];
  schedules?: any[];
  points?: any[];
  histories?: any[];
  participation?: any[];
  capture?: (name: string, args: any) => void;
}) {
  const read = (name: string, rows: any[]) => ({
    findMany: async (args: any) => {
      overrides.capture?.(name, args);
      return rows;
    },
  });
  return {
    syncCycle: read("syncCycle", overrides.cycles ?? [
      { guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ]),
    scheduledSyncPost: read("scheduledSyncPost", overrides.schedules ?? [{ id: "s-521", guildId, syncTime: new Date(base.getTime() + 24 * 3600000), status: "PUBLISHED" }]),
    clanPointsSync: read("clanPointsSync", overrides.points ?? []),
    clanWarHistory: read("clanWarHistory", overrides.histories ?? []),
    clanWarParticipation: read("clanWarParticipation", overrides.participation ?? []),
    warPlanComplianceEvaluation: read("warPlanComplianceEvaluation", []),
  };
}

function aggregateSection(output: string): string {
  const start = output.indexOf("AGGREGATE");
  const end = output.indexOf("ERROR PATTERNS");
  return output.slice(start, end);
}

describe("historical sync-number reconciliation", () => {
  it("uniquely assigns #521 from #520/#522 and one valid schedule", () => {
    const result = exactInterval();
    expect(result.classification).toBe("ANCHORED_SEQUENCE_EXACT");
    expect(result.mappings.map((row) => row.syncNumber)).toEqual([521]);
  });

  it("uniquely assigns #527..#547 from #526/#548 and exactly 21 schedules", () => {
    const schedules = Array.from({ length: 21 }, (_unused, index) => schedule(`s-${index + 527}`, index + 1));
    const result = classifyAnchoredSequenceInterval({ lower: anchor(526, 0), upper: anchor(548, 22 * 24), schedules, existingCycles: [] });
    expect(result.classification).toBe("ANCHORED_SEQUENCE_EXACT");
    expect(result.mappings.map((row) => row.syncNumber)).toEqual(Array.from({ length: 21 }, (_unused, index) => index + 527));
  });

  it("fails the whole interval closed for a missing schedule", () => {
    const result = exactInterval({ schedules: [] });
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
    expect(result.reasons).toContain("schedule_count_does_not_match_numeric_gap");
  });

  it("fails the whole interval closed for an extra eligible schedule", () => {
    const result = exactInterval({ schedules: [schedule("s-521", 24), schedule("s-extra", 36)] });
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
  });

  it("fails for duplicate eligible schedule times", () => {
    const result = exactInterval({ schedules: [schedule("s-1", 24), schedule("s-2", 24)] });
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
    expect(result.reasons).toContain("duplicate_eligible_schedule_time");
  });

  it("does not count CANCELLED or REPLACED schedules", () => {
    const result = exactInterval({ schedules: [schedule("cancelled", 24, guildId, "CANCELLED"), schedule("replaced", 30, guildId, "REPLACED")] });
    expect(result.eligibleScheduleCount).toBe(0);
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
  });

  it("fails when a schedule collides with a contradictory SyncCycle", () => {
    const cycles: ReconciliationCycle[] = [{ guildId, syncNumber: 999, syncTime: schedule("s-521", 24).syncTime }];
    const result = exactInterval({ existingCycles: cycles });
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
    expect(result.reasons).toContain("schedule_collides_with_contradictory_sync_cycle");
  });

  it("classifies a wrong stored history number as SYNC_CORRECTABLE", () => {
    const associated = { history: history({ syncNumber: 520 }), points: [point({ syncNumber: 520 })], hasEvaluation: false, ambiguousReasons: [] };
    const result = classifyHistorySyncClaim({ history: associated.history, associated, boundaries: [{ guildId, syncNumber: 521, syncTime: schedule("s-521", 24).syncTime, scheduledSyncPostId: "s-521", lowerSyncNumber: 520, upperSyncNumber: 522 }] });
    expect(result.classification).toBe("SYNC_CORRECTABLE");
  });

  it("classifies a null stored history number as SYNC_CORRECTABLE", () => {
    const associated = { history: history({ syncNumber: null }), points: [], hasEvaluation: false, ambiguousReasons: [] };
    const result = classifyHistorySyncClaim({ history: associated.history, associated, boundaries: [{ guildId, syncNumber: 521, syncTime: schedule("s-521", 24).syncTime, scheduledSyncPostId: "s-521", lowerSyncNumber: 520, upperSyncNumber: 522 }] });
    expect(result.classification).toBe("SYNC_CORRECTABLE");
  });

  it("keeps ambiguous war timing fail-closed", () => {
    const associated = { history: history(), points: [], hasEvaluation: false, ambiguousReasons: [] };
    const boundaries = [20, 24].map((hours) => ({ guildId, syncNumber: hours === 20 ? 521 : 522, syncTime: schedule(`s-${hours}`, hours).syncTime, scheduledSyncPostId: `s-${hours}`, lowerSyncNumber: 520, upperSyncNumber: 523 }));
    const result = classifyHistorySyncClaim({ history: associated.history, associated, boundaries });
    expect(result.classification).toBe("SYNC_AMBIGUOUS");
  });

  it("does not let stale points claims override canonical schedule mapping", () => {
    const associated = { history: history({ syncNumber: 521 }), points: [point({ syncNumber: 520 })], hasEvaluation: false, ambiguousReasons: [] };
    const historyClaim = classifyHistorySyncClaim({ history: associated.history, associated, boundaries: [{ guildId, syncNumber: 521, syncTime: schedule("s-521", 24).syncTime, scheduledSyncPostId: "s-521", lowerSyncNumber: 520, upperSyncNumber: 522 }] });
    const pointsClaim = classifyPointsSyncClaim({ expectedSyncNumber: historyClaim.expectedSyncNumber, associated });
    expect(historyClaim.classification).toBe("SYNC_MATCH");
    expect(pointsClaim.classification).toBe("POINTS_CORRECTABLE");
  });

  it("preserves raw war-id collision fail-closed behavior", () => {
    const result = associateCanonicalHistories({
      guildId,
      histories: [history()],
      points: [point(), point({ guildId: otherGuildId, syncNumber: 77 })],
      evaluations: [],
    });
    expect(result[0].ambiguousReasons).toContain("raw_war_identity_claimed_by_multiple_sync_owners");
  });

  it("does not associate a stale raw war ID with the wrong canonical history", () => {
    const canonicalA = history({ warId: 100, opponentTag: "#A" });
    const canonicalB = history({ warId: 200, opponentTag: "#B" });
    const collidingPoint = point({ warId: 100, syncNumber: 521, opponentTag: "#B" });
    const result = associateCanonicalHistories({ guildId, histories: [canonicalA, canonicalB], points: [collidingPoint], evaluations: [] });
    expect(result.map((row) => row.history.warId)).toEqual([200]);
  });

  it("uses the exact semantic tuple to associate a wrong-sync points claim for correction analysis", () => {
    const canonical = history({ warId: 200, syncNumber: 520, opponentTag: "#B" });
    const associated = associateCanonicalHistories({
      guildId,
      histories: [canonical],
      points: [point({ warId: 100, syncNumber: 520, opponentTag: "#B" })],
      evaluations: [],
    })[0];
    expect(associated.history.warId).toBe(200);
    const claim = classifyHistorySyncClaim({
      history: associated.history,
      associated,
      boundaries: [{ guildId, syncNumber: 521, syncTime: schedule("s-521", 24).syncTime, scheduledSyncPostId: "s-521", lowerSyncNumber: 520, upperSyncNumber: 522 }],
    });
    expect(claim.classification).toBe("SYNC_CORRECTABLE");
  });

  it("cannot establish a target-guild mapping from cross-guild schedules", () => {
    const result = exactInterval({ schedules: [schedule("other", 24, otherGuildId)] });
    expect(result.classification).toBe("AMBIGUOUS_SEQUENCE");
    expect(result.eligibleScheduleCount).toBe(0);
  });

  it("plans intervals in canonical-number order", () => {
    const result = planAnchoredSequenceIntervals({ guildId, anchors: [anchor(522, 48), anchor(520, 0)], schedules: [schedule("s-521", 24)], existingCycles: [] });
    expect(result[0].mappings[0].syncNumber).toBe(521);
  });

  it("parses the bounded diagnostic command", () => {
    expect(parseHistoricalSyncReconciliationArgs(["--guild", guildId, "--from-sync", "520", "--to-sync", "548"])).toEqual({ guildId, fromSync: 520, toSync: 548 });
  });

  it("executes without exposing or calling any mutation delegate", async () => {
    const calls: string[] = [];
    const read = (name: string, rows: any[]) => ({ findMany: async () => { calls.push(name); return rows; } });
    const db = {
      syncCycle: read("syncCycle", [{ guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" }, { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }]),
      scheduledSyncPost: read("scheduledSyncPost", [{ id: "s-521", guildId, syncTime: new Date(base.getTime() + 24 * 3600000), status: "PUBLISHED" }]),
      clanPointsSync: read("clanPointsSync", []),
      clanWarHistory: read("clanWarHistory", []),
      clanWarParticipation: read("clanWarParticipation", []),
      warPlanComplianceEvaluation: read("warPlanComplianceEvaluation", []),
    };
    const output = await runHistoricalSyncReconciliation({ guildId }, db);
    expect(output).toContain("READ ONLY — no database mutations will be performed.");
    expect(calls).toHaveLength(4);
    expect((db as any).create).toBeUndefined();
    expect((db as any).update).toBeUndefined();
    expect((db as any).delete).toBeUndefined();
  });

  it("produces identical output when database rows arrive in another order", async () => {
    const rows = {
      cycles: [{ guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }, { guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" }],
      schedules: [{ id: "s-521", guildId, syncTime: new Date(base.getTime() + 24 * 3600000), status: "PUBLISHED" }],
    };
    const makeDb = (reverse: boolean) => {
      const read = (data: any[]) => ({ findMany: async () => reverse ? [...data].reverse() : data });
      return { syncCycle: read(rows.cycles), scheduledSyncPost: read(rows.schedules), clanPointsSync: read([]), clanWarHistory: read([]), clanWarParticipation: read([]), warPlanComplianceEvaluation: read([]) };
    };
    expect(await runHistoricalSyncReconciliation({ guildId }, makeDb(false))).toBe(await runHistoricalSyncReconciliation({ guildId }, makeDb(true)));
  });

  it("excludes unrelated target-guild history and points from reconciliation aggregates", async () => {
    const inScopeHistory = history({ warId: 100, syncNumber: 521 });
    const unrelatedHistory = history({
      warId: 999,
      syncNumber: null,
      prepStartTime: new Date("2028-01-01T00:00:00.000Z"),
      warStartTime: new Date("2028-01-01T04:00:00.000Z"),
    });
    const inScopePoint = { guildId, syncNum: 521, warId: "100", clanTag: "#HOME", warStartTime: inScopeHistory.warStartTime, opponentTag: "#OPPONENT", isFwa: true };
    const unrelatedPoint = { guildId, syncNum: 521, warId: "999", clanTag: "#HOME", warStartTime: unrelatedHistory.warStartTime, opponentTag: "#OPPONENT", isFwa: true };
    const baseline = await runHistoricalSyncReconciliation({ guildId }, runDb({ points: [inScopePoint], histories: [inScopeHistory] }));
    const withUnrelated = await runHistoricalSyncReconciliation({ guildId }, runDb({ points: [inScopePoint, unrelatedPoint], histories: [inScopeHistory, unrelatedHistory] }));
    expect(aggregateSection(withUnrelated)).toBe(aggregateSection(baseline));
    expect(withUnrelated).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(withUnrelated).toContain("ClanPointsSync_POINTS_AMBIGUOUS=0");
  });

  it("counts eight histories at one reconstructed sync as one recoverable historical cycle", async () => {
    const histories = Array.from({ length: 8 }, (_unused, index) => history({ warId: 100 + index, clanTag: `#C${index}`, syncNumber: 521 }));
    const points = histories.map((row) => ({ guildId, syncNum: 521, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#P${row.warId}`, matchType: "FWA" }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ points, histories, participation }));
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=1");
  });

  it("deduplicates duplicate player evidence by reconstructed sync and player", async () => {
    const histories = [history({ warId: 100, clanTag: "#C1" }), history({ warId: 101, clanTag: "#C2" })];
    const points = histories.map((row) => ({ guildId, syncNum: 521, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: "#SAME_PLAYER", matchType: "FWA" }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ points, histories, participation }));
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=1");
  });

  it("uses target-scoped and bounded evidence queries, with narrow raw-ID collision reads", async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const pointRow = { guildId, syncNum: 521, warId: "100", clanTag: "#HOME", warStartTime: new Date("2026-06-17T04:00:00.000Z"), opponentTag: "#OPPONENT", isFwa: true };
    await runHistoricalSyncReconciliation({ guildId, fromSync: 521, toSync: 521 }, runDb({
      points: [pointRow],
      histories: [history()],
      participation: [{ guildId, warId: "100", clanTag: "#HOME", playerTag: "#PLAYER", matchType: "FWA" }],
      capture: (name, args) => calls.push({ name, args }),
    }));
    const cycleArgs = calls.find((call) => call.name === "syncCycle")?.args;
    const scheduleArgs = calls.find((call) => call.name === "scheduledSyncPost")?.args;
    const pointsArgs = calls.find((call) => call.name === "clanPointsSync" && call.args.where?.guildId)?.args;
    const historyArgs = calls.find((call) => call.name === "clanWarHistory")?.args;
    const collisionArgs = calls.find((call) => call.name === "clanPointsSync" && !call.args.where?.guildId)?.args;
    const participationArgs = calls.find((call) => call.name === "clanWarParticipation")?.args;
    expect(cycleArgs.where).toMatchObject({ guildId, syncNumber: { gte: 520, lte: 522 } });
    expect(scheduleArgs.where.guildId).toBe(guildId);
    expect(scheduleArgs.where.syncTime).toEqual({ gte: expect.any(Date), lte: expect.any(Date) });
    expect(pointsArgs.where.guildId).toBe(guildId);
    expect(pointsArgs.where.OR).toEqual(expect.arrayContaining([{ syncNum: { in: [520, 521, 522] } }]));
    expect(historyArgs.where.OR).toEqual(expect.arrayContaining([{ warId: { in: [100] } }]));
    expect(collisionArgs.where).toEqual({ warId: { in: ["100"] } });
    expect(participationArgs.where).toEqual({ guildId, warId: { in: ["100"] } });
  });

  it("keeps paired claims aligned after an ambiguous row is filtered from impact simulation", async () => {
    const cycles = [
      { guildId, syncNumber: 519, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 523, syncTime: new Date(base.getTime() + 72 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ];
    const schedules = [12, 20, 48].map((hours, index) => ({ id: `s-${520 + index}`, guildId, syncTime: new Date(base.getTime() + hours * 3600000), status: "PUBLISHED" }));
    const histories = [
      history({ warId: 100, syncNumber: 520, clanTag: "#A", opponentTag: "#OA", prepStartTime: new Date(base.getTime() + 20 * 3600000), warStartTime: new Date(base.getTime() + 24 * 3600000) }),
      history({ warId: 101, syncNumber: 521, clanTag: "#B", opponentTag: "#OB", prepStartTime: new Date(base.getTime() + 40 * 3600000), warStartTime: new Date(base.getTime() + 44 * 3600000) }),
      history({ warId: 102, syncNumber: 522, clanTag: "#C", opponentTag: "#OC", prepStartTime: new Date(base.getTime() + 60 * 3600000), warStartTime: new Date(base.getTime() + 64 * 3600000) }),
    ];
    const points = histories.map((row) => ({ guildId, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#PLAYER_${row.warId}`, matchType: "FWA" }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points, histories, participation }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=2");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=2");
  });

  it("uses global uniqueness in every boundary report and preserves ambiguous candidates", async () => {
    const cycles = [
      { guildId, syncNumber: 529, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 532, syncTime: new Date(base.getTime() + 36 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ];
    const schedules = [12, 20].map((hours, index) => ({ id: `s-${530 + index}`, guildId, syncTime: new Date(base.getTime() + hours * 3600000), status: "PUBLISHED" }));
    const ambiguousHistory = history({
      warId: 300,
      syncNumber: 530,
      prepStartTime: new Date(base.getTime() + 20 * 3600000),
      warStartTime: new Date(base.getTime() + 24 * 3600000),
    });
    const pointRow = { guildId, syncNum: 530, warId: "300", clanTag: ambiguousHistory.clanTag, warStartTime: ambiguousHistory.warStartTime, opponentTag: ambiguousHistory.opponentTag, isFwa: true };
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points: [pointRow], histories: [ambiguousHistory] }));
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=0");
    expect(output).toContain("ClanWarHistory_SYNC_CORRECTABLE=0");
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(output).toContain("ClanPointsSync_POINTS_MATCH=0");
    expect(output).toContain("ClanPointsSync_POINTS_CORRECTABLE=0");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=1");
    expect(output).toContain("#530 scheduledSyncPost=s-530");
    expect(output).toContain("#531 scheduledSyncPost=s-531");
    expect(output).toContain("ambiguous_war_ids=300 ambiguous_candidate_syncs=300=>#530,#531");
    expect(output).not.toContain("sync_match=1 sync_correctable=0");
    expect(output).not.toContain("sync_match=0 sync_correctable=1");
  });
});
