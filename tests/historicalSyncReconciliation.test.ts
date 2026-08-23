import { describe, expect, it } from "vitest";
import {
  associateCanonicalHistories,
  buildRealizedFwaClusters,
  classifyAnchoredSequenceInterval,
  classifyHistorySyncClaim,
  classifyPointsSyncClaim,
  classifyReconciliationHistoryScope,
  planAnchoredSequenceIntervals,
  corroborateRealizedFwaSequence,
  type ReconciliationAnchor,
  type ReconciliationCycle,
  type ReconciliationHistory,
  type ReconciliationPoint,
  type ReconciliationSchedule,
} from "../src/services/historicalSyncReconciliation";
import {
  classifyDirectHistoryOwnership,
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
  evaluations?: any[];
  snapshots?: any[];
  capture?: (name: string, args: any) => void;
}) {
  const read = (name: string, rows: any[]) => ({
    findMany: async (args: any) => {
      overrides.capture?.(name, args);
      return rows;
    },
  });
  const cycleRows = overrides.cycles ?? [
    { guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
    { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
  ];
  const syncCycle = {
    findMany: async (args: any) => {
      overrides.capture?.("syncCycle", args);
      const numberWhere = args?.where?.syncNumber ?? {};
      let rows = cycleRows.filter((row) =>
        (numberWhere.gte === undefined || row.syncNumber >= numberWhere.gte) &&
        (numberWhere.lte === undefined || row.syncNumber <= numberWhere.lte));
      if (args?.orderBy?.[0]?.syncNumber === "desc") rows = [...rows].sort((left, right) => right.syncNumber - left.syncNumber);
      else rows = [...rows].sort((left, right) => left.syncNumber - right.syncNumber);
      return args?.take ? rows.slice(0, args.take) : rows;
    },
  };
  return {
    syncCycle,
    scheduledSyncPost: read("scheduledSyncPost", overrides.schedules ?? [{ id: "s-521", guildId, syncTime: new Date(base.getTime() + 24 * 3600000), status: "PUBLISHED" }]),
    clanPointsSync: read("clanPointsSync", overrides.points ?? []),
    clanWarHistory: read("clanWarHistory", overrides.histories ?? []),
    clanWarParticipation: read("clanWarParticipation", overrides.participation ?? []),
    warPlanComplianceEvaluation: read("warPlanComplianceEvaluation", overrides.evaluations ?? []),
    syncClanReadinessSnapshot: read("syncClanReadinessSnapshot", overrides.snapshots ?? []),
  };
}

function aggregateSection(output: string): string {
  const start = output.indexOf("AGGREGATE");
  const end = output.indexOf("ERROR PATTERNS");
  return output.slice(start, end);
}

function longGapFixture() {
  const cycles = [
    { guildId, syncNumber: 526, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
    { guildId, syncNumber: 548, syncTime: new Date(base.getTime() + 22 * 24 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
  ];
  const schedules = Array.from({ length: 21 }, (_unused, index) => ({
    id: `s-${index + 527}`,
    guildId,
    syncTime: new Date(base.getTime() + (index + 1) * 24 * 3600000),
    status: "PUBLISHED",
  }));
  return { cycles, schedules };
}

function realizedFixture() {
  const cycles = [
    { guildId, syncNumber: 100, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
    { guildId, syncNumber: 104, syncTime: new Date(base.getTime() + 96 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
  ];
  const schedules = [1, 10, 40].map((hours, index) => ({
    id: `s-${101 + index}`,
    guildId,
    syncTime: new Date(base.getTime() + hours * 3600000),
    status: "PUBLISHED",
  }));
  const histories = [1, 13, 30, 60].map((hours, index) => history({
    warId: 999 + index,
    syncNumber: 100 + index,
    clanTag: `#REALIZED_${index}`,
    opponentTag: `#OPPONENT_${index}`,
    prepStartTime: new Date(base.getTime() + hours * 3600000),
    warStartTime: new Date(base.getTime() + (hours + 4) * 3600000),
    warEndTime: new Date(base.getTime() + (hours + 8) * 3600000),
  }));
  const points = histories.map((row) => ({
    guildId,
    syncNum: row.syncNumber,
    warId: String(row.warId),
    clanTag: row.clanTag,
    warStartTime: row.warStartTime,
    opponentTag: row.opponentTag,
    isFwa: true,
  }));
  const participation = histories.map((row, index) => ({
    guildId,
    warId: String(row.warId),
    clanTag: row.clanTag,
    playerTag: `#REALIZED_PLAYER_${index}`,
    matchType: "FWA",
  }));
  return { cycles, schedules, histories, points, participation };
}

function productionRealizedFixture() {
  const productionBase = new Date("2026-08-05T12:00:00.000Z");
  const at = (days: number, hours = 0, minutes = 0) => new Date(productionBase.getTime() + ((days * 24 + hours) * 60 + minutes) * 60000);
  const cycles = [
    { guildId, syncNumber: 543, syncTime: productionBase, resolutionSource: "ENDED_WAR_CANONICAL" },
    { guildId, syncNumber: 548, syncTime: at(10, 8, 20), resolutionSource: "ENDED_WAR_CANONICAL" },
  ];
  const schedules = [
    { id: "s-545", guildId, syncTime: at(4, 2, 40), status: "PUBLISHED" },
    { id: "s-546", guildId, syncTime: at(6, 4, 50), status: "PUBLISHED" },
    { id: "s-unused", guildId, syncTime: at(7, 4, 50), status: "PUBLISHED" },
    { id: "s-547", guildId, syncTime: at(8, 6), status: "PUBLISHED" },
  ];
  const histories = [
    history({ warId: 5430, syncNumber: 543, clanTag: "#ANCHOR", opponentTag: "#ANCHOR_OPP", prepStartTime: at(0, 1), warStartTime: at(0, 5), warEndTime: at(0, 9) }),
    history({ warId: 5440, syncNumber: 544, clanTag: "#C544", opponentTag: "#OPP544", prepStartTime: at(2), warStartTime: at(2, 4), warEndTime: at(2, 8) }),
    history({ warId: 5450, syncNumber: 545, clanTag: "#C545", opponentTag: "#OPP545", prepStartTime: at(4, 4), warStartTime: at(4, 8), warEndTime: at(4, 12) }),
    history({ warId: 5460, syncNumber: 546, clanTag: "#C546", opponentTag: "#OPP546", prepStartTime: at(6, 6), warStartTime: at(6, 10), warEndTime: at(6, 14) }),
    history({ warId: 5470, syncNumber: 547, clanTag: "#C547", opponentTag: "#OPP547", prepStartTime: at(8, 8), warStartTime: at(8, 12), warEndTime: at(8, 16) }),
  ];
  const points = histories.map((row) => ({
    guildId,
    syncNum: row.syncNumber,
    warId: String(row.warId),
    clanTag: row.clanTag,
    warStartTime: row.warStartTime,
    opponentTag: row.opponentTag,
    isFwa: true,
  }));
  const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#P${row.syncNumber}`, matchType: "FWA" }));
  return { cycles, schedules, histories, points, participation };
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
    expect(calls).toHaveLength(5);
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
      syncNumber: 530,
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

  it("keeps an in-window history with missing prep time visible as ambiguous", async () => {
    const missingPrepHistory = history({
      warId: 200,
      syncNumber: 521,
      prepStartTime: null,
      warStartTime: new Date(base.getTime() + 28 * 3600000),
    });
    const points = [{ guildId, syncNum: 521, warId: "200", clanTag: "#HOME", warStartTime: missingPrepHistory.warStartTime, opponentTag: "#OPPONENT", isFwa: true }];
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      points,
      histories: [missingPrepHistory],
      participation: [{ guildId, warId: "200", clanTag: "#HOME", playerTag: "#AMBIGUOUS", matchType: "FWA" }],
    }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=0");
    expect(output).toContain("ClanWarHistory_SYNC_CORRECTABLE=0");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=1");
    expect(output).toContain("UNMAPPED IN-SCOPE AMBIGUITIES");
    expect(output).toContain("war_id=200 reasons=missing_prep_start_time,no_unique_reconstructed_schedule stored_history_sync=521 points_sync_claims=521 participation_rows=1");
    expect(output).not.toContain("ambiguous_war_ids=200");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=0");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=0");
    expect(classifyReconciliationHistoryScope({ history: missingPrepHistory, boundaries: [], intervals: [exactInterval()] })).toBe("IN_SCOPE");
  });

  it("keeps in-window prep timing with no safe schedule candidate visible as ambiguous", async () => {
    const cycles = [
      { guildId, syncNumber: 519, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 523, syncTime: new Date(base.getTime() + 72 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ];
    const schedules = [12, 24, 36].map((hours, index) => ({ id: `s-${520 + index}`, guildId, syncTime: new Date(base.getTime() + hours * 3600000), status: "PUBLISHED" }));
    const unmappableHistory = history({
      warId: 201,
      syncNumber: 521,
      prepStartTime: new Date(base.getTime() + 61 * 3600000),
      warStartTime: new Date(base.getTime() + 65 * 3600000),
    });
    const points = [{ guildId, syncNum: 521, warId: "201", clanTag: "#HOME", warStartTime: unmappableHistory.warStartTime, opponentTag: "#OPPONENT", isFwa: true }];
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points, histories: [unmappableHistory] }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=1");
    expect(output).toContain("war_id=201 reasons=no_unique_reconstructed_schedule stored_history_sync=521 points_sync_claims=521 participation_rows=0");
    expect(output).not.toContain("ambiguous_war_ids=201");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=0");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=0");
  });

  it("excludes lower and upper anchor histories from missing-cycle reconciliation scope", async () => {
    const cycles = [
      { guildId, syncNumber: 526, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 548, syncTime: new Date(base.getTime() + 22 * 24 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ];
    const schedules = Array.from({ length: 21 }, (_unused, index) => ({
      id: `s-${index + 527}`,
      guildId,
      syncTime: new Date(base.getTime() + (index + 1) * 24 * 3600000),
      status: "PUBLISHED",
    }));
    const lowerHistory = history({
      warId: 526,
      syncNumber: 526,
      prepStartTime: new Date(base.getTime() + 12 * 3600000),
      warStartTime: new Date(base.getTime() + 16 * 3600000),
    });
    const upperHistory = history({
      warId: 548,
      syncNumber: 548,
      prepStartTime: new Date(base.getTime() + 22 * 24 * 3600000),
      warStartTime: new Date(base.getTime() + 22 * 24 * 3600000 + 4 * 3600000),
    });
    const points = [lowerHistory, upperHistory].map((row) => ({ guildId, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points, histories: [lowerHistory, upperHistory] }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=0");
    expect(classifyReconciliationHistoryScope({ history: lowerHistory, boundaries: [], intervals: [classifyAnchoredSequenceInterval({ lower: anchor(526, 0), upper: anchor(548, 22 * 24), schedules: schedules.map((row) => ({ id: row.id, guildId: row.guildId, syncTime: row.syncTime, status: row.status })), existingCycles: [] })] })).toBe("IN_SCOPE");
    expect(classifyReconciliationHistoryScope({ history: upperHistory, boundaries: [], intervals: [classifyAnchoredSequenceInterval({ lower: anchor(526, 0), upper: anchor(548, 22 * 24), schedules: schedules.map((row) => ({ id: row.id, guildId: row.guildId, syncTime: row.syncTime, status: row.status })), existingCycles: [] })] })).toBe("OUT_OF_SCOPE");
  });

  it("counts eight histories at one reconstructed sync as one recoverable historical cycle", async () => {
    const histories = Array.from({ length: 8 }, (_unused, index) => history({ warId: 100 + index, clanTag: `#C${index}`, syncNumber: 521 }));
    const points = histories.map((row) => ({ guildId, syncNum: 521, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#P${row.warId}`, matchType: "FWA" }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ points, histories, participation }));
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=1");
  });

  it("deduplicates duplicate player evidence by reconstructed sync and player", async () => {
    const histories = [history({ warId: 100, clanTag: "#C1" })];
    const points = histories.map((row) => ({ guildId, syncNum: 521, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = [1, 2].map(() => ({ guildId, warId: "100", clanTag: "#C1", playerTag: "#SAME_PLAYER", matchType: "FWA" }));
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
    const cycleCalls = calls.filter((call) => call.name === "syncCycle");
    const cycleArgs = cycleCalls[2]?.args;
    const scheduleArgs = calls.find((call) => call.name === "scheduledSyncPost")?.args;
    const pointsArgs = calls.find((call) => call.name === "clanPointsSync" && call.args.where?.guildId)?.args;
    const historyArgs = calls.find((call) => call.name === "clanWarHistory")?.args;
    const collisionArgs = calls.find((call) => call.name === "clanPointsSync" && !call.args.where?.guildId)?.args;
    const participationArgs = calls.find((call) => call.name === "clanWarParticipation")?.args;
    expect(cycleCalls).toHaveLength(3);
    expect(cycleCalls[0].args.where).toMatchObject({ guildId, syncNumber: { lte: 521 } });
    expect(cycleCalls[1].args.where).toMatchObject({ guildId, syncNumber: { gte: 521 } });
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
      history({ warId: 99, syncNumber: 519, clanTag: "#LOWER", opponentTag: "#OL", prepStartTime: new Date(base.getTime() + 1 * 3600000), warStartTime: new Date(base.getTime() + 5 * 3600000) }),
      history({ warId: 100, syncNumber: 520, clanTag: "#A", opponentTag: "#OA", prepStartTime: new Date(base.getTime() + 20 * 3600000), warStartTime: new Date(base.getTime() + 24 * 3600000) }),
      history({ warId: 101, syncNumber: 521, clanTag: "#B", opponentTag: "#OB", prepStartTime: new Date(base.getTime() + 40 * 3600000), warStartTime: new Date(base.getTime() + 44 * 3600000) }),
      history({ warId: 102, syncNumber: 522, clanTag: "#C", opponentTag: "#OC", prepStartTime: new Date(base.getTime() + 60 * 3600000), warStartTime: new Date(base.getTime() + 64 * 3600000) }),
      history({ warId: 103, syncNumber: 523, clanTag: "#UPPER", opponentTag: "#OU", prepStartTime: new Date(base.getTime() + 80 * 3600000), warStartTime: new Date(base.getTime() + 84 * 3600000) }),
    ];
    const points = histories.map((row) => ({ guildId, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#PLAYER_${row.warId}`, matchType: "FWA" }));
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points, histories, participation }));
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=3");
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
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
    expect(output).toContain("REALIZED FWA CYCLES");
    expect(output).toContain("action=REALIZED_NUMBER_CONFLICT");
    expect(output).toContain("schedule_candidates=s-530@");
    expect(output).toContain("s-531@");
    expect(output).toContain("UNMAPPED IN-SCOPE AMBIGUITIES");
  });

  it("uses full proof context for bounded claims while keeping reports selected", async () => {
    const cycles = [
      { guildId, syncNumber: 528, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
      { guildId, syncNumber: 532, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
    ];
    const schedules = [12, 20, 36].map((hours, index) => ({ id: `s-${529 + index}`, guildId, syncTime: new Date(base.getTime() + hours * 3600000), status: "PUBLISHED" }));
    const ambiguousHistory = history({
      warId: 301,
      syncNumber: 530,
      prepStartTime: new Date(base.getTime() + 20 * 3600000),
      warStartTime: new Date(base.getTime() + 24 * 3600000),
    });
    const pointRow = { guildId, syncNum: 530, warId: "301", clanTag: ambiguousHistory.clanTag, warStartTime: ambiguousHistory.warStartTime, opponentTag: ambiguousHistory.opponentTag, isFwa: true };
    const db = runDb({ cycles, schedules, points: [pointRow], histories: [ambiguousHistory], participation: [{ guildId, warId: "301", clanTag: ambiguousHistory.clanTag, playerTag: "#PLAYER_301", matchType: "FWA" }] });
    const bounded = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 530 }, db);

    expect(bounded).toContain("ClanWarHistory_SYNC_MATCH=0");
    expect(bounded).toContain("ClanWarHistory_SYNC_CORRECTABLE=0");
    expect(bounded).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(bounded).toContain("ClanPointsSync_POINTS_AMBIGUOUS=0");
    expect(bounded).toContain("analysis_scope=SUPPRESSED_AMBIGUOUS_INTERVAL_SCOPE");
    expect(bounded).toContain("REALIZED FWA CYCLES");
    expect(bounded).not.toContain("safe_realized_boundary=#529");
    expect(bounded).toContain("number_classification=HISTORY_SYNC_MATCH");
    expect(bounded).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=0");
    expect(bounded).toContain("player_boundary_membership_facts_potentially_unlocked=0");

    const unbounded = await runHistoricalSyncReconciliation({ guildId }, runDb({ cycles, schedules, points: [pointRow], histories: [ambiguousHistory] }));
    expect(unbounded).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(unbounded).toContain("number_classification=HISTORY_SYNC_MATCH");
  });

  it("keeps a history with one global candidate normally correctable", () => {
    const associated = { history: history({ syncNumber: 529, prepStartTime: new Date(base.getTime() + 40 * 3600000) }), points: [], hasEvaluation: false, ambiguousReasons: [] };
    const claim = classifyHistorySyncClaim({
      history: associated.history,
      associated,
      boundaries: [
        { guildId, syncNumber: 529, syncTime: new Date(base.getTime() + 12 * 3600000), scheduledSyncPostId: "s-529", lowerSyncNumber: 528, upperSyncNumber: 532 },
        { guildId, syncNumber: 530, syncTime: new Date(base.getTime() + 20 * 3600000), scheduledSyncPostId: "s-530", lowerSyncNumber: 528, upperSyncNumber: 532 },
        { guildId, syncNumber: 531, syncTime: new Date(base.getTime() + 60 * 3600000), scheduledSyncPostId: "s-531", lowerSyncNumber: 528, upperSyncNumber: 532 },
      ],
    });
    expect(claim.classification).toBe("SYNC_CORRECTABLE");
    expect(claim.expectedSyncNumber).toBe(530);
  });

  it("proves the full #526 to #548 gap before displaying only #530 to #540", async () => {
    const { cycles, schedules } = longGapFixture();
    const output = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 540 }, runDb({ cycles, schedules }));
    expect(output).toContain("lower=#526@");
    expect(output).toContain("upper=#548@");
    expect(output).toContain("expected_missing=21 eligible_schedules=21 classification=ANCHORED_SEQUENCE_EXACT");
    expect(output).toContain("selected_safe_realized_boundaries=0");
    expect(output).toContain("REALIZED_SEQUENCE_AMBIGUOUS=1");
    expect(output).toContain("unresolved_missing_sync_numbers=530,531,532,533,534,535,536,537,538,539,540");
  });

  it("fails the bounded #530 to #540 request when any full-gap schedule is missing", async () => {
    const { cycles, schedules } = longGapFixture();
    const output = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 540 }, runDb({
      cycles,
      schedules: schedules.filter((row) => row.id !== "s-535"),
    }));
    expect(output).toContain("classification=AMBIGUOUS_SEQUENCE");
    expect(output).toContain("schedule_count_does_not_match_numeric_gap");
    expect(output).toContain("selected_safe_realized_boundaries=0");
  });

  it("keeps full-gap proof context while excluding histories outside the requested display range", async () => {
    const { cycles, schedules } = longGapFixture();
    const included = history({
      warId: 535,
      syncNumber: 535,
      clanTag: "#INCLUDED",
      opponentTag: "#OPPONENT_535",
      prepStartTime: new Date(base.getTime() + 9 * 24 * 3600000 + 3600000),
      warStartTime: new Date(base.getTime() + 9 * 24 * 3600000 + 4 * 3600000),
    });
    const excluded = history({
      warId: 541,
      syncNumber: 541,
      clanTag: "#EXCLUDED",
      opponentTag: "#OPPONENT_541",
      prepStartTime: new Date(base.getTime() + 15 * 24 * 3600000 + 3600000),
      warStartTime: new Date(base.getTime() + 15 * 24 * 3600000 + 4 * 3600000),
    });
    const points = [included, excluded].map((row) => ({ guildId, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }));
    const participation = [{ guildId, warId: "535", clanTag: "#INCLUDED", playerTag: "#PLAYER_535", matchType: "FWA" }];
    const output = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 540 }, runDb({ cycles, schedules, points, histories: [included, excluded], participation }));
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=0");
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(output).toContain("analysis_scope=SUPPRESSED_AMBIGUOUS_INTERVAL_SCOPE");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=0");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=0");
  });

  it("preserves the surrounding proof anchors for one-sided bounded requests", async () => {
    const { cycles, schedules } = longGapFixture();
    const fromOnly = await runHistoricalSyncReconciliation({ guildId, fromSync: 530 }, runDb({ cycles, schedules }));
    const toOnly = await runHistoricalSyncReconciliation({ guildId, toSync: 540 }, runDb({ cycles, schedules }));
    for (const output of [fromOnly, toOnly]) {
      expect(output).toContain("lower=#526@");
      expect(output).toContain("upper=#548@");
      expect(output).toContain("expected_missing=21 eligible_schedules=21 classification=ANCHORED_SEQUENCE_EXACT");
    }
    expect(fromOnly).toContain("unresolved_missing_sync_numbers=530,531,532,533,534,535,536,537,538,539,540,541,542,543,544,545,546,547");
    expect(toOnly).toContain("unresolved_missing_sync_numbers=527,528,529,530,531,532,533,534,535,536,537,538,539,540");
  });

  it("fails closed when a bounded request lacks a required surrounding anchor", async () => {
    const output = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 540 }, runDb({
      cycles: [{ guildId, syncNumber: 548, syncTime: new Date(base.getTime() + 22 * 24 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }],
      schedules: [],
    }));
    expect(output).toContain("PROPOSED BOUNDARIES\nnone");
    expect(output).toContain("selected_safe_realized_boundaries=0");
  });

  it("clusters realized ended FWA histories with deterministic diagnostics", () => {
    const first = history({ warId: 700, syncNumber: 11, clanTag: "#A", prepStartTime: new Date(base.getTime() + 12 * 3600000) });
    const second = history({ warId: 701, syncNumber: 11, clanTag: "#B", prepStartTime: new Date(base.getTime() + 13 * 3600000) });
    const third = history({ warId: 702, syncNumber: 12, clanTag: "#C", prepStartTime: new Date(base.getTime() + 40 * 3600000) });
    const result = buildRealizedFwaClusters({ histories: [third, second, first], participation: [
      { guildId, warId: 700, clanTag: "#A", playerTag: "#P1", matchType: "FWA" },
      { guildId, warId: 701, clanTag: "#B", playerTag: "#P2", matchType: "FWA" },
    ] });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]).toMatchObject({ canonicalHistoryCount: 2, distinctClanCount: 2, participationRowCount: 2, distinctPlayerCount: 2, unanimousPersistedSyncNumber: 11, historySyncClassification: "HISTORY_SYNC_MATCH" });
    expect(result.clusters[0].spreadMinutes).toBe(60);
    expect(result.clusters[0].canonicalWarIds).toEqual([700, 701]);
  });

  it("corroborates realized cycles independently of points and keeps A ambiguous while B/C retain their numbers", () => {
    const fixture = realizedFixture();
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(100, 0),
      upper: anchor(104, 96),
      histories: fixture.histories,
      participation: fixture.participation.map((row) => ({ ...row, warId: Number(row.warId) })),
      schedules: fixture.schedules.map((row) => ({ ...row, syncTime: new Date(row.syncTime) })),
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_CORROBORATED");
    expect(sequence.cycles.map((cycle) => [cycle.expectedSyncNumber, cycle.action])).toEqual([
      [101, "REALIZED_AMBIGUOUS_SCHEDULE"],
      [102, "EXACT_SYNC_CYCLE_CANDIDATE"],
      [103, "EXACT_SYNC_CYCLE_CANDIDATE"],
    ]);
    expect(sequence.cycles[1].selectedSchedule?.id).toBe("s-102");
    expect(sequence.cycles[2].selectedSchedule?.id).toBe("s-103");
    expect(sequence.ambiguousScheduleCandidates.map((row) => row.id)).toEqual(["s-101"]);
    expect(sequence.unusedEligibleSchedules).toEqual([]);
  });

  it("reports direct realized history evidence even when points and evaluations do not discover it", async () => {
    const fixture = realizedFixture();
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: fixture.cycles,
      schedules: fixture.schedules,
      histories: fixture.histories,
      participation: fixture.participation,
    }));
    expect(output).toContain("REALIZED FWA SEQUENCES");
    expect(output).toContain("REALIZED FWA CYCLES");
    expect(output).toContain("history_count=1 distinct_clans=1");
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=3");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=3");
    expect(output).toContain("EXACT_SYNC_CYCLE_CANDIDATE=2");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=2");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=2");
  });

  it("uses realized cycles as authoritative identity across a production-shaped long gap", async () => {
    const fixture = productionRealizedFixture();
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb(fixture));
    expect(output).toContain("lower=#543@");
    expect(output).toContain("upper=#548@");
    expect(output).toContain("classification=REALIZED_SEQUENCE_CORROBORATED");
    expect(output).toContain("expected_sync=#544");
    expect(output).toContain("action=REALIZED_MISSING_EXACT_SCHEDULE parent_sequence=REALIZED_SEQUENCE_CORROBORATED safe_for_apply=false already_present=false writer_actionable=false");
    expect(output).toContain("#545 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(output).toContain("#546 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(output).toContain("#547 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(output).toContain("schedule_id=s-unused");
    expect(output).toContain("reason=SCHEDULE_WITHOUT_REALIZED_FWA_CLUSTER");
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=4");
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(output).toContain("ClanPointsSync_POINTS_MATCH=4");
    expect(output).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=3");
    expect(output).toContain("player_boundary_membership_facts_potentially_unlocked=3");
    expect(output).toContain("longest_newly_contiguous_canonical_sync_run=#545..#548 length=4");
    expect(output).not.toContain("#543..#548");

    const boundedMissing = await runHistoricalSyncReconciliation({ guildId, fromSync: 544, toSync: 544 }, runDb(fixture));
    expect(boundedMissing).toContain("#544 action=REALIZED_MISSING_EXACT_SCHEDULE");
    expect(boundedMissing).toContain("ClanWarHistory_SYNC_MATCH=1");
    expect(boundedMissing).toContain("additional_historical_FWA_cycles_with_uniquely_assignable_participation=0");

    const boundedExact = await runHistoricalSyncReconciliation({ guildId, fromSync: 545, toSync: 546 }, runDb(fixture));
    expect(boundedExact).toContain("lower=#543@");
    expect(boundedExact).toContain("upper=#548@");
    expect(boundedExact).toContain("#545 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(boundedExact).toContain("#546 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(boundedExact).not.toContain("#544 action=REALIZED_MISSING_EXACT_SCHEDULE");
    expect(boundedExact).not.toContain("#547 action=EXACT_SYNC_CYCLE_CANDIDATE");
  });

  it("reports exact readiness snapshot sources per realized cycle and deduplicates them", async () => {
    const fixture = productionRealizedFixture();
    const snapshotTime = new Date("2026-08-09T14:40:00.000Z");
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      ...fixture,
      snapshots: [
        { guildId, syncTime: snapshotTime, scheduledSyncPostId: "s-545" },
        { guildId, syncTime: snapshotTime, scheduledSyncPostId: "s-545" },
        { guildId, syncTime: new Date("2026-08-11T16:50:00.000Z"), scheduledSyncPostId: null },
      ],
    }));
    expect(output).toContain("#545 action=EXACT_SYNC_CYCLE_CANDIDATE");
    expect(output).toContain("exact_source_candidates=SYNC_CLAN_READINESS_SNAPSHOT: time=2026-08-09T14:40:00.000Z scheduledSyncPostId=s-545");
    expect(output).toContain("exact_source_candidates=SYNC_CLAN_READINESS_SNAPSHOT: time=2026-08-11T16:50:00.000Z scheduledSyncPostId=none");
    expect(output.match(/scheduledSyncPostId=s-545/g)?.length).toBe(1);
  });

  it("keeps ambiguous realized schedule candidates out of the unused-schedule bucket", () => {
    const fixture = realizedFixture();
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(100, 0),
      upper: anchor(104, 96),
      histories: fixture.histories,
      participation: fixture.participation.map((row) => ({ ...row, warId: Number(row.warId) })),
      schedules: fixture.schedules.map((row) => ({ ...row, syncTime: new Date(row.syncTime) })),
      existingCycles: [],
    });
    expect(sequence.ambiguousScheduleCandidates.map((row) => row.id)).toEqual(["s-101"]);
    expect(sequence.unusedEligibleSchedules).toEqual([]);
  });

  it("keeps a realized cluster unresolved when no exact persisted schedule satisfies the live relationship", () => {
    const lower = anchor(10, 0);
    const upper = anchor(13, 72);
    const missingScheduleHistory = history({
      warId: 800,
      syncNumber: 12,
      prepStartTime: new Date(base.getTime() + 60 * 3600000),
      warStartTime: new Date(base.getTime() + 64 * 3600000),
    });
    const sequence = corroborateRealizedFwaSequence({
      lower,
      upper,
      histories: [
        history({ warId: 798, syncNumber: 10, prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        history({ warId: 799, syncNumber: 11, prepStartTime: new Date(base.getTime() + 12 * 3600000) }),
        missingScheduleHistory,
        history({ warId: 801, syncNumber: 13, prepStartTime: new Date(base.getTime() + 80 * 3600000) }),
      ],
      schedules: [schedule("s-11", 1)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_CORROBORATED");
    expect(sequence.cycles[1].action).toBe("REALIZED_MISSING_EXACT_SCHEDULE");
    expect(sequence.cycles[1].reasons).toContain("no_exact_persisted_schedule");
  });

  it("blocks every realized child when the parent sequence has an intra-cluster identity conflict", () => {
    const lower = anchor(100, 0);
    const upper = anchor(104, 96);
    const histories = [
      history({ warId: 900, syncNumber: 100, clanTag: "#LOWER", prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
      history({ warId: 901, syncNumber: 101, clanTag: "#CLAN", prepStartTime: new Date(base.getTime() + 13 * 3600000) }),
      history({ warId: 902, syncNumber: 101, clanTag: "#CLAN", prepStartTime: new Date(base.getTime() + 14 * 3600000), warStartTime: new Date(base.getTime() + 18 * 3600000) }),
      history({ warId: 903, syncNumber: 102, clanTag: "#THIRD2", prepStartTime: new Date(base.getTime() + 36 * 3600000) }),
      history({ warId: 904, syncNumber: 103, clanTag: "#THIRD", prepStartTime: new Date(base.getTime() + 60 * 3600000) }),
      history({ warId: 905, syncNumber: 104, clanTag: "#UPPER", prepStartTime: new Date(base.getTime() + 100 * 3600000) }),
    ];
    const sequence = corroborateRealizedFwaSequence({
      lower,
      upper,
      histories,
      schedules: [schedule("s-101", 13), schedule("s-102", 14), schedule("s-103", 60)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_AMBIGUOUS");
    expect(sequence.reasons).toContain("multiple_wars_for_clan_in_realized_cluster");
    expect(sequence.cycles.some((cycle) => cycle.action === "EXACT_SYNC_CYCLE_CANDIDATE")).toBe(true);
  });

  it("fails closed for a compatible lower-anchor cluster with only the next stored sync number", () => {
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(526, 0),
      upper: anchor(528, 48),
      histories: [
        history({ warId: 910, syncNumber: 527, prepStartTime: new Date(base.getTime() + 12 * 3600000) }),
        history({ warId: 911, syncNumber: 528, prepStartTime: new Date(base.getTime() + 50 * 3600000) }),
      ],
      schedules: [schedule("s-527", 12)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_AMBIGUOUS");
    expect(sequence.reasons).toContain("lower_anchor_context_ambiguous");
  });

  it("accepts a legitimate next-sync cluster alongside a uniquely identified anchor context", () => {
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(100, 0),
      upper: anchor(104, 96),
      histories: [
        history({ warId: 920, syncNumber: 100, clanTag: "#LOWER", prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        history({ warId: 921, syncNumber: 101, clanTag: "#NEXT", prepStartTime: new Date(base.getTime() + 13 * 3600000) }),
        history({ warId: 922, syncNumber: 102, clanTag: "#NEXT2", prepStartTime: new Date(base.getTime() + 36 * 3600000) }),
        history({ warId: 923, syncNumber: 103, clanTag: "#NEXT3", prepStartTime: new Date(base.getTime() + 60 * 3600000) }),
        history({ warId: 924, syncNumber: 104, clanTag: "#UPPER", prepStartTime: new Date(base.getTime() + 100 * 3600000) }),
      ],
      schedules: [schedule("s-101", 13), schedule("s-102", 36), schedule("s-103", 60)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_CORROBORATED");
    expect(sequence.lowerAnchorContextClusters).toHaveLength(1);
    expect(sequence.cycles.map((cycle) => cycle.expectedSyncNumber)).toEqual([101, 102, 103]);
  });

  it("establishes direct-history ownership only from target-guild persisted evidence", () => {
    const row = history({ warId: 930, clanTag: "#OWNED", opponentTag: "#OPP" });
    const targetPoint = point({ warId: 930, clanTag: "#OWNED", opponentTag: "#OPP" });
    const otherPoint = { ...targetPoint, guildId: otherGuildId };
    expect(classifyDirectHistoryOwnership({ history: row, targetGuildId: guildId, participation: [], points: [otherPoint], evaluations: [] })).toBe("UNOWNED_DIRECT_HISTORY");
    expect(classifyDirectHistoryOwnership({ history: row, targetGuildId: guildId, participation: [{ guildId, warId: 930, clanTag: "#OWNED", playerTag: "#P", matchType: "FWA" }], points: [], evaluations: [] })).toBe("OWNED");
    expect(classifyDirectHistoryOwnership({ history: row, targetGuildId: guildId, participation: [], points: [targetPoint], evaluations: [] })).toBe("OWNED");
    expect(classifyDirectHistoryOwnership({ history: row, targetGuildId: guildId, participation: [], points: [targetPoint, otherPoint], evaluations: [] })).toBe("CONFLICTING_OWNERSHIP");
  });

  it("keeps an in-window history with missing prep time as ambiguous", async () => {
    const missingPrep = history({
      warId: 940,
      syncNumber: 521,
      prepStartTime: null,
      warStartTime: new Date(base.getTime() + 28 * 3600000),
    });
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: [
        { guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
        { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
      ],
      schedules: [schedule("s-521", 24)],
      histories: [missingPrep],
      points: [{ guildId, syncNum: 521, warId: "940", clanTag: missingPrep.clanTag, warStartTime: missingPrep.warStartTime, opponentTag: missingPrep.opponentTag, isFwa: true }],
    }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=1");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=1");
    expect(output).toContain("missing_prep_start_time");
  });

  it("retains realized identity when the exact schedule is absent", async () => {
    const missingSchedule = history({
      warId: 941,
      syncNumber: 521,
      prepStartTime: new Date(base.getTime() + 23 * 3600000),
      warStartTime: new Date(base.getTime() + 27 * 3600000),
    });
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: [
        { guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" },
        { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" },
      ],
      schedules: [schedule("s-521", 24)],
      histories: [
        history({ warId: 939, syncNumber: 520, prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        missingSchedule,
        history({ warId: 942, syncNumber: 522, prepStartTime: new Date(base.getTime() + 60 * 3600000) }),
      ],
      points: [939, 941, 942].map((warId) => {
        const row = warId === 939 ? history({ warId, syncNumber: 520, prepStartTime: new Date(base.getTime() + 1 * 3600000) }) : warId === 941 ? missingSchedule : history({ warId, syncNumber: 522, prepStartTime: new Date(base.getTime() + 60 * 3600000) });
        return { guildId, syncNum: row.syncNumber, warId: String(warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true };
      }),
    }));
    expect(output).toContain("#521 action=REALIZED_MISSING_EXACT_SCHEDULE");
    expect(output).toContain("ClanWarHistory_SYNC_MATCH=1");
    expect(output).toContain("ClanPointsSync_POINTS_MATCH=1");
  });

  it("does not scope a requested subrange to realized histories from later proof context", async () => {
    const later = history({
      warId: 943,
      syncNumber: 547,
      prepStartTime: new Date(base.getTime() + 21 * 24 * 3600000),
      warStartTime: new Date(base.getTime() + 21 * 24 * 3600000 + 4 * 3600000),
    });
    const output = await runHistoricalSyncReconciliation({ guildId, fromSync: 530, toSync: 540 }, runDb({
      ...longGapFixture(),
      histories: [later],
      points: [{ guildId, syncNum: 547, warId: "943", clanTag: later.clanTag, warStartTime: later.warStartTime, opponentTag: later.opponentTag, isFwa: true }],
      participation: [{ guildId, warId: "943", clanTag: later.clanTag, playerTag: "#LATER", matchType: "FWA" }],
    }));
    expect(output).toContain("ClanWarHistory_SYNC_AMBIGUOUS=0");
    expect(output).toContain("ClanPointsSync_POINTS_AMBIGUOUS=0");
  });

  it("keeps post-upper lookahead clusters out of the missing-cycle sequence", () => {
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(520, 0),
      upper: anchor(522, 48),
      histories: [
        history({ warId: 950, syncNumber: 520, clanTag: "#LOWER950", prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        history({ warId: 951, syncNumber: 521, clanTag: "#POST951", prepStartTime: new Date(base.getTime() + 49 * 3600000) }),
        history({ warId: 952, syncNumber: 522, clanTag: "#UPPER952", prepStartTime: new Date(base.getTime() + 60 * 3600000) }),
      ],
      schedules: [schedule("s-521", 24)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_AMBIGUOUS");
    expect(sequence.postUpperContextClusters.flatMap((cluster) => cluster.canonicalWarIds)).toEqual([951]);
    expect(sequence.reasons).toContain("post_upper_cluster_claims_non_future_sync");
    expect(sequence.cycles).toHaveLength(0);
  });

  it("corroborates a legitimate between-anchor cluster and ignores future context", () => {
    const sequence = corroborateRealizedFwaSequence({
      lower: anchor(520, 0),
      upper: anchor(522, 48),
      histories: [
        history({ warId: 953, syncNumber: 520, clanTag: "#LOWER953", prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        history({ warId: 954, syncNumber: 521, clanTag: "#BETWEEN954", prepStartTime: new Date(base.getTime() + 24 * 3600000) }),
        history({ warId: 955, syncNumber: 522, clanTag: "#UPPER955", prepStartTime: new Date(base.getTime() + 60 * 3600000) }),
        history({ warId: 956, syncNumber: 523, clanTag: "#FUTURE956", prepStartTime: new Date(base.getTime() + 72 * 3600000) }),
      ],
      schedules: [schedule("s-521", 24)],
      existingCycles: [],
    });
    expect(sequence.classification).toBe("REALIZED_SEQUENCE_CORROBORATED");
    expect(sequence.cycles.map((cycle) => cycle.expectedSyncNumber)).toEqual([521]);
    expect(sequence.postUpperContextClusters.flatMap((cluster) => cluster.canonicalWarIds)).toEqual([956]);
    expect(sequence.reasons).not.toContain("post_upper_cluster_claims_non_future_sync");
  });

  it("poisons a realized interval for conflicting direct ownership but not merely unowned evidence", async () => {
    const lower = history({ warId: 960, syncNumber: 520, clanTag: "#LOWER960", prepStartTime: new Date(base.getTime() + 1 * 3600000) });
    const valid = history({ warId: 961, syncNumber: 521, clanTag: "#VALID961", prepStartTime: new Date(base.getTime() + 24 * 3600000) });
    const upper = history({ warId: 962, syncNumber: 522, clanTag: "#UPPER962", prepStartTime: new Date(base.getTime() + 60 * 3600000) });
    const conflicting = history({ warId: 963, syncNumber: 521, clanTag: "#CONFLICT963", prepStartTime: new Date(base.getTime() + 25 * 3600000) });
    const baseRows = [lower, valid, upper];
    const pointsFor = (row: ReconciliationHistory, owner = guildId) => ({ guildId: owner, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true });
    const poisoned = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: [{ guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" }, { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }],
      schedules: [schedule("s-521", 24)],
      histories: [...baseRows, conflicting],
      points: [...baseRows.map((row) => pointsFor(row)), pointsFor(conflicting), pointsFor(conflicting, otherGuildId)],
      participation: baseRows.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#P${row.warId}`, matchType: "FWA" })),
    }));
    expect(poisoned).toContain("war_id=963 ownership=CONFLICTING_OWNERSHIP");
    expect(poisoned).toContain("REALIZED_SEQUENCE_AMBIGUOUS=1");
    expect(poisoned).toContain("conflicting_direct_history_ownership");
    expect(poisoned).toContain("selected_safe_realized_boundaries=0");
    expect(poisoned).toContain("player_boundary_membership_facts_potentially_unlocked=0");

    const unowned = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: [{ guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" }, { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }],
      schedules: [schedule("s-521", 24)],
      histories: [...baseRows, conflicting],
      points: [...baseRows.map((row) => pointsFor(row)), pointsFor(conflicting, otherGuildId)],
    }));
    expect(unowned).toContain("war_id=963 ownership=UNOWNED_DIRECT_HISTORY");
    expect(unowned).toContain("REALIZED_SEQUENCE_CORROBORATED=1");
    expect(unowned).not.toContain("conflicting_direct_history_ownership");
  });

  it("detects cross-guild compliance ownership conflicts", async () => {
    const lower = history({ warId: 970, syncNumber: 520, clanTag: "#LOWER970", prepStartTime: new Date(base.getTime() + 1 * 3600000) });
    const missing = history({ warId: 971, syncNumber: 521, clanTag: "#MISSING971", prepStartTime: new Date(base.getTime() + 24 * 3600000) });
    const upper = history({ warId: 972, syncNumber: 522, clanTag: "#UPPER972", prepStartTime: new Date(base.getTime() + 60 * 3600000) });
    const evaluations = [guildId, otherGuildId].map((owner) => ({ guildId: owner, warId: 971, matchType: "FWA", warHistory: { clanTag: missing.clanTag, matchType: "FWA" } }));
    const evaluationCalls: any[] = [];
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb({
      cycles: [{ guildId, syncNumber: 520, syncTime: base, resolutionSource: "ENDED_WAR_CANONICAL" }, { guildId, syncNumber: 522, syncTime: new Date(base.getTime() + 48 * 3600000), resolutionSource: "ENDED_WAR_CANONICAL" }],
      schedules: [schedule("s-521", 24)],
      histories: [lower, missing, upper],
      points: [lower, upper].map((row) => ({ guildId, syncNum: row.syncNumber, warId: String(row.warId), clanTag: row.clanTag, warStartTime: row.warStartTime, opponentTag: row.opponentTag, isFwa: true }))
        .concat([{ guildId, syncNum: missing.syncNumber, warId: "999999", clanTag: missing.clanTag, warStartTime: missing.warStartTime, opponentTag: missing.opponentTag, isFwa: true }]),
      evaluations,
      capture: (name, args) => { if (name === "warPlanComplianceEvaluation") evaluationCalls.push(args); },
    }));
    expect(evaluationCalls.at(-1)?.where).toEqual({ warId: { in: [970, 971, 972] } });
    expect(output).toContain("war_id=971 ownership=CONFLICTING_OWNERSHIP");
    expect(output).toContain("conflicting_direct_history_ownership");
    expect(output).toContain("selected_safe_realized_boundaries=0");
  });

  it("detects compliance conflict independently of raw points when participation owns the canonical history", () => {
    const row = history({ warId: 974, clanTag: "#PARTICIPATION974" });
    expect(classifyDirectHistoryOwnership({
      history: row,
      targetGuildId: guildId,
      participation: [{ guildId, warId: 974, clanTag: row.clanTag, playerTag: "#PLAYER974", matchType: "FWA" }],
      points: [],
      evaluations: [{ guildId: otherGuildId, warId: 974, clanTag: row.clanTag, matchType: "FWA" }],
    })).toBe("CONFLICTING_OWNERSHIP");
  });

  it("labels writer safety from the exact cycle action, not only the parent sequence", async () => {
    const fixture = realizedFixture();
    const output = await runHistoricalSyncReconciliation({ guildId }, runDb(fixture));
    expect(output).toContain("#101");
    expect(output).toContain("action=REALIZED_AMBIGUOUS_SCHEDULE parent_sequence=REALIZED_SEQUENCE_CORROBORATED safe_for_apply=false already_present=false writer_actionable=false");
    expect(output).toContain("#102");
    expect(output).toContain("action=EXACT_SYNC_CYCLE_CANDIDATE parent_sequence=REALIZED_SEQUENCE_CORROBORATED safe_for_apply=true already_present=false writer_actionable=true");

    const ambiguousParent = corroborateRealizedFwaSequence({
      lower: anchor(100, 0),
      upper: anchor(102, 48),
      histories: [
        history({ warId: 980, syncNumber: 100, clanTag: "#LOWER980", prepStartTime: new Date(base.getTime() + 1 * 3600000) }),
        history({ warId: 981, syncNumber: 101, clanTag: "#CHILD981", prepStartTime: new Date(base.getTime() + 24 * 3600000) }),
      ],
      conflictingHistories: [history({ warId: 982, syncNumber: 101, clanTag: "#CONFLICT982", prepStartTime: new Date(base.getTime() + 25 * 3600000) })],
      schedules: [schedule("s-101", 24)],
      existingCycles: [],
    });
    expect(ambiguousParent.classification).toBe("REALIZED_SEQUENCE_AMBIGUOUS");
    expect(ambiguousParent.cycles[0].action).toBe("EXACT_SYNC_CYCLE_CANDIDATE");
  });
});
