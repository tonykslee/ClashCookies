import { describe, expect, it, vi } from "vitest";
import {
  buildPrepCluster,
  buildTenureDiagnostics,
  classifyAuditCycle,
  classifyAuditCycles,
  formatAuditSummary,
  projectMembershipStreak,
  type AuditCycleInput,
  type AuditHistoryEvidence,
  type AuditLookupEvidence,
  type AuditParticipationEvidence,
  type AuditPointEvidence,
  type AuditScheduleEvidence,
  type ReadOnlyAuditDb,
  runMembershipHistoryBackfillAudit,
} from "../src/scripts/auditMembershipHistoryBackfill";
import type { MembershipBoundaryEvidence } from "../src/services/MembershipStreakService";

const prep = new Date("2026-01-01T00:00:00.000Z");
const sync = new Date("2026-01-01T02:00:00.000Z");
const warStart = new Date("2026-01-01T03:00:00.000Z");

/** Purpose: build exact or unknown boundary evidence for shared projection tests. */
function boundaryEvidence(boundaryTime: Date, clanTag: string | null, status: "RESOLVED" | "ABSENT" | "UNKNOWN" = clanTag ? "RESOLVED" : "UNKNOWN"): MembershipBoundaryEvidence {
  const clanTags = clanTag ? [clanTag] : [];
  return {
    playerTag: "#PLAYER1",
    boundaryTime,
    fwa: {
      status,
      clanTag: status === "RESOLVED" ? clanTag : null,
      clanTags,
      source: status === "ABSENT" || status === "RESOLVED" ? "SYNC_SNAPSHOT" : null,
    },
    alliance: {
      positive: status === "RESOLVED",
      clanTags,
      ambiguous: false,
      sources: status === "RESOLVED" ? ["FWA_EVIDENCE"] : [],
    },
  };
}

/** Purpose: build a candidate report with one optional historical player fact. */
function candidateReport(syncNumber: number, candidateTime: Date, clanTag: string | null = "#HOME"): ReturnType<typeof classifyAuditCycle> {
  const historicalClanTag = clanTag ?? "#HOME";
  return classifyAuditCycle(input({
    syncNumber,
    schedules: [],
    points: [point({ syncNumber, clanTag: historicalClanTag })],
    histories: [history({ syncNumber, clanTag: historicalClanTag, prepStartTime: candidateTime })],
    participation: clanTag ? [participation({ playerTag: "#PLAYER1", clanTag })] : [],
  }));
}

/** Purpose: create a minimal persisted ClanPointsSync identity for audit fixtures. */
function point(overrides: Partial<AuditPointEvidence> = {}): AuditPointEvidence {
  return {
    guildId: "guild-1",
    syncNumber: 12,
    clanTag: "#HOME",
    warId: 42,
    warStartTime: warStart,
    opponentTag: "#OPPONENT",
    isFwa: true,
    ...overrides,
  };
}

/** Purpose: create a canonical FWA war-history fixture with deterministic timestamps. */
function history(overrides: Partial<AuditHistoryEvidence> = {}): AuditHistoryEvidence {
  return {
    warId: 42,
    syncNumber: 12,
    matchType: "FWA",
    clanTag: "#HOME",
    opponentTag: "#OPPONENT",
    warStartTime: warStart,
    prepStartTime: prep,
    warEndTime: new Date("2026-01-01T05:00:00.000Z"),
    expectedTeamSize: 2,
    ...overrides,
  };
}

/** Purpose: create one persisted historical player participation fact. */
function participation(overrides: Partial<AuditParticipationEvidence> = {}): AuditParticipationEvidence {
  return {
    guildId: "guild-1",
    warId: 42,
    clanTag: "#HOME",
    playerTag: "#PLAYER1",
    ...overrides,
  };
}

/** Purpose: create one persisted scheduled-sync correlation candidate. */
function schedule(overrides: Partial<AuditScheduleEvidence> = {}): AuditScheduleEvidence {
  return {
    id: "schedule-1",
    guildId: "guild-1",
    syncTime: sync,
    status: "SCHEDULED",
    ...overrides,
  };
}

/** Purpose: compose a deterministic single-cycle audit fixture. */
function input(overrides: Partial<AuditCycleInput> = {}): AuditCycleInput {
  return {
    guildId: "guild-1",
    syncNumber: 12,
    syncCycleTime: null,
    points: [point()],
    histories: [history()],
    participation: [participation(), participation({ playerTag: "#PLAYER2" })],
    schedules: [schedule()],
    exactSnapshots: [],
    lookups: [],
    ...overrides,
  };
}

describe("auditMembershipHistoryBackfill", () => {
  it("classifies exact and cycle fallback evidence without using current-state tables", () => {
    expect(classifyAuditCycle(input({ syncCycleTime: sync, exactSnapshots: [
      { guildId: "guild-1", syncTime: sync, clanTag: "#HOME", playerTag: "#PLAYER1" },
    ] })).classification).toBe("EXISTING_EXACT");
    expect(classifyAuditCycle(input({ syncCycleTime: sync })).classification).toBe("EXISTING_CYCLE_FALLBACK");
  });

  it("classifies scheduled, prep-cluster, and legacy candidates deterministically", () => {
    expect(classifyAuditCycle(input()).classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(classifyAuditCycle(input({ schedules: [] })).classification).toBe("PREP_CLUSTER_CANDIDATE");
    expect(classifyAuditCycle(input({
      histories: [],
      participation: [],
      schedules: [],
      lookups: [{
        warId: 42,
        clanTag: "#HOME",
        startTime: warStart,
        payload: { canonical: { participants: ["#PLAYER1", { tag: "#PLAYER2" }], teamSize: 2 } },
      } satisfies AuditLookupEvidence],
    })).classification).toBe("LEGACY_WARLOOKUP_CANDIDATE");
    const summary = formatAuditSummary([classifyAuditCycle(input({
      histories: [],
      participation: [],
      schedules: [],
      lookups: [{
        warId: 42,
        clanTag: "#HOME",
        startTime: warStart,
        payload: { canonical: { participants: ["#PLAYER1"] } },
      }],
    }))]);
    expect(summary).toContain("Potential additional canonical boundaries: 0");
    expect(summary).toContain("Potential player-boundary membership facts: 1");
  });

  it("accepts distinct war identities across alliance clans for scheduled and prep candidates", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const secondHistory = history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const secondParticipation = participation({ clanTag: "#HOME2", warId: 43, playerTag: "#PLAYER2" });
    const multiClan = input({
      points: [point(), secondPoint],
      histories: [history(), secondHistory],
      participation: [participation(), secondParticipation],
    });
    expect(classifyAuditCycle(multiClan).classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(classifyAuditCycle({ ...multiClan, schedules: [] }).classification).toBe("PREP_CLUSTER_CANDIDATE");
    expect(classifyAuditCycle(multiClan).conflicts).not.toContain("conflicting_war_identities");
  });

  it("rejects incompatible war identities for one clan and persisted sync disagreement", () => {
    const conflictingWar = classifyAuditCycle(input({
      points: [point(), point({ warId: 43 })],
      histories: [history(), history({ warId: 43 })],
    }));
    expect(conflictingWar.classification).toBe("AMBIGUOUS");
    expect(conflictingWar.conflicts).toContain("conflicting_war_identities");
    const conflictingSync = classifyAuditCycle(input({
      histories: [history({ syncNumber: 13 })],
      schedules: [],
    }));
    expect(conflictingSync.classification).toBe("AMBIGUOUS");
    expect(conflictingSync.conflicts).toContain("persisted_sync_number_disagreement");
  });

  it("marks multiple schedules and excessive prep spread ambiguous", () => {
    expect(classifyAuditCycle(input({ schedules: [schedule(), schedule({ id: "schedule-2", syncTime: new Date("2026-01-01T04:00:00.000Z") })] })).classification)
      .toBe("AMBIGUOUS");
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    expect(classifyAuditCycle(input({
      schedules: [],
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2", prepStartTime: new Date("2026-01-01T04:00:01.000Z") })],
    })).classification).toBe("AMBIGUOUS");
    expect(classifyAuditCycle(input({
      schedules: [],
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2", prepStartTime: new Date("2026-01-01T04:00:01.000Z") })],
    })).conflicts).toContain("excessive_prep_start_spread");
  });

  it("marks a player observed in incompatible clans for one boundary ambiguous", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const report = classifyAuditCycle(input({
      schedules: [],
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" })],
      participation: [
        participation(),
        participation({ clanTag: "#HOME2", warId: 43 }),
      ],
    }));
    expect(report.classification).toBe("AMBIGUOUS");
    expect(report.conflicts).toContain("player_in_multiple_clans:#PLAYER1");
  });

  it("keeps missing participant mappings visible without converting a candidate to ambiguous", () => {
    const report = classifyAuditCycle(input({ missingParticipantWarMappings: ["missing_participation:#HOME:42"] }));
    expect(report.classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(report.missingParticipantWarMappings).toEqual(["missing_participation:#HOME:42"]);
  });

  it("marks participation partial when persisted team-size evidence exceeds observed players", () => {
    const report = classifyAuditCycle(input({ participation: [participation()] }));
    expect(report.expectedTeamSize).toBe(2);
    expect(report.rosterCompleteness).toBe("PARTIAL");
    expect(report.participationDistinctPlayerCount).toBe(1);
  });

  it("evaluates roster completeness independently for mixed historical team sizes", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const secondHistory = history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2", expectedTeamSize: 40 });
    const firstRoster = Array.from({ length: 50 }, (_, index) => participation({ playerTag: `#A${String(index).padStart(3, "0")}` }));
    const secondRoster = Array.from({ length: 40 }, (_, index) => participation({
      playerTag: `#B${String(index).padStart(3, "0")}`,
      clanTag: "#HOME2",
      warId: 43,
    }));
    const report = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [history({ expectedTeamSize: 50 }), secondHistory],
      participation: [...firstRoster, ...secondRoster],
    }));
    expect(report.expectedTeamSize).toBeNull();
    expect(report.expectedTeamSizesByClan).toEqual({ "#H0ME": 50, "#H0ME2": 40 });
    expect(report.perClanRosterCompleteness).toEqual({ "#H0ME": "COMPLETE", "#H0ME2": "COMPLETE" });
    expect(report.rosterCompleteness).toBe("COMPLETE");
  });

  it("does not treat an empty or malformed legacy payload as roster evidence", () => {
    const report = classifyAuditCycle(input({
      histories: [],
      participation: [],
      schedules: [],
      lookups: [{ warId: 42, clanTag: "#HOME", startTime: warStart, payload: { canonical: { participants: [] } } }],
    }));
    expect(report.classification).toBe("UNRECOVERABLE");
    expect(report.playerClanFacts).toEqual([]);
    expect(formatAuditSummary([report])).toContain("Potential additional canonical boundaries: 0");
  });

  it("uses an unambiguous compliance evaluation when ClanPointsSync is absent", async () => {
    const rawHistory = {
      warId: 501,
      syncNumber: 77,
      matchType: "FWA",
      clanTag: "#HOME",
      opponentTag: "#OPPONENT",
      warStartTime: new Date("2026-02-01T03:00:00.000Z"),
      prepStartTime: new Date("2026-02-01T00:00:00.000Z"),
      warEndTime: new Date("2026-02-01T05:00:00.000Z"),
    };
    const reads = {
      syncCycle: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      syncClanMemberSnapshot: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      scheduledSyncPost: { findMany: vi.fn(async () => []) },
      clanPointsSync: { findMany: vi.fn(async () => []) },
      clanWarHistory: { findMany: vi.fn(async () => [rawHistory]) },
      clanWarParticipation: { findMany: vi.fn(async () => [{ guildId: "guild-1", warId: 501, clanTag: "#HOME", playerTag: "#PLAYER1", matchType: "FWA" }]) },
      warLookup: { findMany: vi.fn(async () => []) },
      warPlanComplianceEvaluation: { findMany: vi.fn(async () => [{
        guildId: "guild-1",
        warId: 501,
        warHistory: rawHistory,
      }]) },
      clanHomeMembershipPeriod: { findMany: vi.fn(async () => []) },
      syncClanReadinessSnapshot: { groupBy: vi.fn(async () => []) },
      allianceClanMembershipInterval: { findMany: vi.fn(async () => []) },
    } satisfies ReadOnlyAuditDb;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reports = await runMembershipHistoryBackfillAudit(reads);
    log.mockRestore();
    expect(reports).toHaveLength(1);
    expect(reports[0].syncNumber).toBe(77);
    expect(reports[0].classification).toBe("PREP_CLUSTER_CANDIDATE");
  });

  it("fails closed when ClanPointsSync and compliance identity disagree", async () => {
    const rawHistory = {
      warId: 502,
      syncNumber: 78,
      matchType: "FWA",
      clanTag: "#HOME",
      opponentTag: "#OPPONENT",
      warStartTime: new Date("2026-02-02T03:00:00.000Z"),
      prepStartTime: new Date("2026-02-02T00:00:00.000Z"),
      warEndTime: new Date("2026-02-02T05:00:00.000Z"),
    };
    const reads = {
      syncCycle: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      syncClanMemberSnapshot: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      scheduledSyncPost: { findMany: vi.fn(async () => []) },
      clanPointsSync: { findMany: vi.fn(async () => [{ guildId: "guild-1", syncNum: 77, clanTag: "#HOME", warId: 502, warStartTime: rawHistory.warStartTime, opponentTag: "#OPPONENT", isFwa: true }]) },
      clanWarHistory: { findMany: vi.fn(async () => [rawHistory]) },
      clanWarParticipation: { findMany: vi.fn(async () => [{ guildId: "guild-1", warId: 502, clanTag: "#HOME", playerTag: "#PLAYER1", matchType: "FWA" }]) },
      warLookup: { findMany: vi.fn(async () => []) },
      warPlanComplianceEvaluation: { findMany: vi.fn(async () => [{ guildId: "guild-1", warId: 502, warHistory: rawHistory }]) },
      clanHomeMembershipPeriod: { findMany: vi.fn(async () => []) },
      syncClanReadinessSnapshot: { groupBy: vi.fn(async () => []) },
      allianceClanMembershipInterval: { findMany: vi.fn(async () => []) },
    } satisfies ReadOnlyAuditDb;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reports = await runMembershipHistoryBackfillAudit(reads);
    log.mockRestore();
    expect(reports.every((report) => report.classification === "AMBIGUOUS")).toBe(true);
    expect(reports.every((report) => report.conflicts.includes("conflicting_persisted_identity_sources"))).toBe(true);
  });

  it("replays candidate presence through contiguous shared streak semantics", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z")],
      evidenceRows: [boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-02T00:00:00.000Z"))]);
    expect(projected.clanStreakSyncs).toBe(2);
  });

  it("does not count candidate presence across unknown or authoritative absence", () => {
    const unknownGap = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z")],
      evidenceRows: [
        boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME"),
        boundaryEvidence(new Date("2026-03-02T00:00:00.000Z"), null),
      ],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-01T00:00:00.000Z"))]);
    expect(unknownGap.clanStreakSyncs).toBe(1);
    const absence = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z")],
      evidenceRows: [
        boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME"),
        boundaryEvidence(new Date("2026-03-02T00:00:00.000Z"), null, "ABSENT"),
      ],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-01T00:00:00.000Z"))]);
    expect(absence.clanStreakSyncs).toBe(1);
  });

  it("extends only the alliance streak when candidate presence is in another clan", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z")],
      evidenceRows: [boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-02T00:00:00.000Z"), "#OTHER")]);
    expect(projected.clanStreakSyncs).toBe(1);
    expect(projected.allianceStreakSyncs).toBe(2);
  });

  it("does not inflate a projection across a noncontiguous candidate run", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-04T00:00:00.000Z")],
      evidenceRows: [boundaryEvidence(new Date("2026-03-04T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [
      candidateReport(12, new Date("2026-03-03T00:00:00.000Z")),
      candidateReport(11, new Date("2026-03-02T00:00:00.000Z"), null),
      candidateReport(10, new Date("2026-03-01T00:00:00.000Z")),
    ]);
    expect(projected.clanStreakSyncs).toBe(2);
  });

  it("does not accept an unambiguously unmapped WarLookup clan identity", () => {
    const report = classifyAuditCycle(input({
      histories: [],
      participation: [],
      schedules: [],
      lookups: [{
        warId: 42,
        clanTag: "#OTHER",
        startTime: warStart,
        payload: { canonical: { participants: ["#PLAYER1"] } },
      }],
      explicitConflicts: ["warlookup_clan_identity_mismatch"],
    }));
    expect(report.classification).toBe("AMBIGUOUS");
    expect(report.conflicts).toContain("warlookup_clan_identity_mismatch");
  });

  it("orders reports by guild and sync number and labels tenure as theoretical only", () => {
    const reports = classifyAuditCycles([
      input({ guildId: "guild-2", syncNumber: 2 }),
      input({ guildId: "guild-1", syncNumber: 3 }),
      input({ guildId: "guild-1", syncNumber: 1 }),
    ]);
    expect(reports.map((report) => `${report.guildId}:${report.syncNumber}`)).toEqual([
      "guild-1:1", "guild-1:3", "guild-2:2",
    ]);
    const tenure = buildTenureDiagnostics(reports, [{
      guildId: "guild-1",
      playerTag: "#PLAYER1",
      clanTag: "#HOME",
      startedAtSyncTime: new Date("2026-01-02T00:00:00.000Z"),
    }]);
    expect(tenure.join("\n")).toContain("NOT SAFE TO APPLY AUTOMATICALLY");
  });

  it("does not include post-Home-start evidence in theoretical backdate boundaries", () => {
    const before = classifyAuditCycle(input({ syncNumber: 20, schedules: [], points: [point({ syncNumber: 20 })], histories: [history({ syncNumber: 20, prepStartTime: new Date("2026-01-01T00:00:00.000Z") })] }));
    const after = classifyAuditCycle(input({ syncNumber: 21, schedules: [], points: [point({ syncNumber: 21 })], histories: [history({ syncNumber: 21, prepStartTime: new Date("2026-01-03T00:00:00.000Z") })] }));
    const tenure = buildTenureDiagnostics([before, after], [{
      guildId: "guild-1",
      playerTag: "#PLAYER1",
      clanTag: "#HOME",
      startedAtSyncTime: new Date("2026-01-02T00:00:00.000Z"),
    }]);
    expect(tenure.join("\n")).toContain("theoretical_extension_boundaries=1");
    expect(tenure.join("\n")).not.toContain("theoretical_extension_boundaries=2");
  });

  it("uses only read delegates when executing the audit", async () => {
    const reads = {
      syncCycle: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      syncClanMemberSnapshot: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      scheduledSyncPost: { findMany: vi.fn(async () => []) },
      clanPointsSync: { findMany: vi.fn(async () => []) },
      clanWarHistory: { findMany: vi.fn(async () => []) },
      clanWarParticipation: { findMany: vi.fn(async () => []) },
      warLookup: { findMany: vi.fn(async () => []) },
      clanHomeMembershipPeriod: { findMany: vi.fn(async () => []) },
      syncClanReadinessSnapshot: { groupBy: vi.fn(async () => []) },
      allianceClanMembershipInterval: { findMany: vi.fn(async () => []) },
      warPlanComplianceEvaluation: { findMany: vi.fn(async () => []) },
    } satisfies ReadOnlyAuditDb;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runMembershipHistoryBackfillAudit(reads)).resolves.toEqual([]);
    expect(reads.syncCycle.findMany).toHaveBeenCalledOnce();
    expect(reads.syncClanMemberSnapshot.findMany).toHaveBeenCalledOnce();
    expect((reads as unknown as Record<string, unknown>).create).toBeUndefined();
    expect((reads as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((reads as unknown as Record<string, unknown>).delete).toBeUndefined();
    log.mockRestore();
  });

  it("reports prep cluster spread in seconds and minutes", () => {
    const result = buildPrepCluster([prep, new Date(prep.getTime() + 90_000)]);
    expect(result.spreadSeconds).toBe(90);
    expect(result.spreadMinutes).toBe(2);
  });
});
