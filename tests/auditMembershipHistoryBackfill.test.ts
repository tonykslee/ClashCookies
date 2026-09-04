import { describe, expect, it, vi } from "vitest";
import {
  buildPrepCluster,
  buildCycleInputs,
  buildTenureDiagnostics,
  classifyAuditCycle,
  classifyAuditCycles,
  formatAggregatePerClanCoverage,
  formatAuditSummary,
  formatCycleRow,
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
function candidateReport(syncNumber: number, candidateTime: Date, clanTag: string | null = "#HOME", syncCycleTime: Date | null = null): ReturnType<typeof classifyAuditCycle> {
  const historicalClanTag = clanTag ?? "#HOME";
  return classifyAuditCycle(input({
    syncNumber,
    syncCycleTime,
    schedules: [],
    points: [point({ syncNumber, clanTag: historicalClanTag })],
    histories: [history({ syncNumber, clanTag: historicalClanTag, prepStartTime: candidateTime })],
    participation: clanTag ? [participation({ playerTag: "#PLAYER1", clanTag })] : [],
  }));
}

/** Purpose: create an ambiguous historical report that retains a canonical candidate time. */
function ambiguousReport(syncNumber: number, candidateTime: Date): ReturnType<typeof classifyAuditCycle> {
  return classifyAuditCycle(input({
    syncNumber,
    schedules: [schedule({ syncTime: candidateTime })],
    points: [point({ syncNumber }), point({ syncNumber, warId: 43 })],
    histories: [history({ syncNumber }), history({ syncNumber, warId: 43 })],
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
    ...overrides,
  };
}

/** Purpose: build the real persisted WarLookup team-size and canonical participant shape. */
function lookup(overrides: Partial<AuditLookupEvidence> = {}): AuditLookupEvidence {
  return {
    warId: 42,
    clanTag: "#HOME",
    startTime: warStart,
    payload: {
      warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" },
      canonical: { participants: ["#PLAYER1", "#PLAYER2"] },
    },
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
    expect(classifyAuditCycle(input({ syncCycleTime: sync, participation: [], lookups: [lookup()] })).classification)
      .toBe("EXISTING_CYCLE_FALLBACK");
    expect(classifyAuditCycle(input({ syncCycleTime: sync, participation: [], lookups: [], schedules: [] })).classification)
      .toBe("UNRECOVERABLE");
    expect(formatAuditSummary([classifyAuditCycle(input({ syncCycleTime: sync, participation: [], lookups: [lookup()] }))]))
      .toContain("Potential additional canonical boundaries: 0");
  });

  it("classifies scheduled, prep-cluster, and legacy candidates deterministically", () => {
    expect(classifyAuditCycle(input()).classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(classifyAuditCycle(input({ schedules: [] })).classification).toBe("PREP_CLUSTER_CANDIDATE");
    expect(classifyAuditCycle(input({
      histories: [history({ prepStartTime: null })],
      participation: [],
      schedules: [],
      lookups: [{
        warId: 42,
        clanTag: "#HOME",
        startTime: warStart,
        payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" }, canonical: { participants: ["#PLAYER1", { tag: "#PLAYER2" }] } },
      } satisfies AuditLookupEvidence],
    })).classification).toBe("LEGACY_WARLOOKUP_CANDIDATE");
    const summary = formatAuditSummary([classifyAuditCycle(input({
      histories: [history({ prepStartTime: null })],
      participation: [],
      schedules: [],
      lookups: [{
        warId: 42,
        clanTag: "#HOME",
        startTime: warStart,
        payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" }, canonical: { participants: ["#PLAYER1"] } },
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

  it("merges a null ClanPointsSync warId with a matching compliance warId", () => {
    const report = classifyAuditCycle(input({
      points: [point({ warId: null })],
      histories: [history()],
      participation: [participation()],
    }));
    expect(report.classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(report.conflicts).not.toContain("conflicting_war_identities");
  });

  it("fails closed for incompatible null-war tuples and conflicting persisted sizes", () => {
    const nullTupleConflict = classifyAuditCycle(input({
      points: [point({ warId: null }), point({ warId: null, opponentTag: "#OTHER" })],
      histories: [history()],
      participation: [participation()],
    }));
    expect(nullTupleConflict.classification).toBe("AMBIGUOUS");
    expect(nullTupleConflict.conflicts).toContain("conflicting_war_identities");

    const sizeConflict = classifyAuditCycle(input({
      participation: [],
      lookups: [
        lookup({ payload: { warMeta: { teamSize: 50, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [] } } }),
        lookup({ payload: { warMeta: { teamSize: 40, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [] } } }),
      ],
    }));
    expect(sizeConflict.classification).toBe("AMBIGUOUS");
    expect(sizeConflict.conflicts).toContain("conflicting_expected_team_sizes:#H0ME");
  });

  it("propagates partial war identity conflicts across sync buckets", () => {
    const cycles = [
      { guildId: "guild-1", syncNumber: 499, syncTime: new Date("2026-02-01T00:00:00.000Z") },
      { guildId: "guild-1", syncNumber: 500, syncTime: new Date("2026-02-02T00:00:00.000Z") },
    ];
    const reports = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 499, warId: null }), point({ syncNumber: 500 })],
      [history({ syncNumber: 500 })],
      [],
      [],
      [],
      [],
      cycles,
    ));
    expect(reports.map((report) => report.classification)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(reports.every((report) => report.conflicts.includes("conflicting_partial_war_identity_across_sync_buckets"))).toBe(true);

    const sameSync = classifyAuditCycles(buildCycleInputs(
      [point({ warId: null }), point()],
      [history()],
      [],
      [],
      [],
      [],
      [{ guildId: "guild-1", syncNumber: 12, syncTime: sync }],
    ));
    expect(sameSync[0].classification).not.toBe("AMBIGUOUS");

    const twoNullOwners = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 499, warId: null }), point({ syncNumber: 500, warId: null })],
      [],
      [],
      [],
      [],
      [],
      cycles,
    ));
    expect(twoNullOwners.map((report) => report.classification)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
  });

  it("recovers WarLookup through canonical history instead of raw point warId", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const cycles = [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }];
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: 900001 })],
      [canonical],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123 })],
      cycles,
    ));
    expect(report[0].classification).toBe("EXISTING_CYCLE_FALLBACK");
    expect(report[0].conflicts).not.toContain("warlookup_clan_identity_mismatch");
    expect(report[0].conflicts).not.toContain("persisted_sync_number_disagreement");
    expect(report[0].playerClanFacts).toEqual([
      { playerTag: "#PLAYER1", clanTag: "#H0ME", source: "WarLookup.canonical.participants" },
      { playerTag: "#PLAYER2", clanTag: "#H0ME", source: "WarLookup.canonical.participants" },
    ]);
  });

  it("ignores an unrelated lookup whose ID equals a stale raw point ID", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: 900001 })],
      [canonical],
      [participation({ warId: 100123 })],
      [schedule()],
      [],
      [lookup({ warId: 900001, clanTag: "#OTHER" })],
      [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }],
    ));
    expect(report[0].classification).toBe("EXISTING_CYCLE_FALLBACK");
    expect(report[0].conflicts).not.toContain("warlookup_clan_identity_mismatch");
    expect(report[0].conflicts).not.toContain("persisted_sync_number_disagreement");
  });

  it("preserves persisted sync disagreement before dropping the conflicting history", () => {
    const conflictingHistory = history({
      warId: 42,
      syncNumber: 499,
      prepStartTime: new Date("2026-01-01T10:00:00.000Z"),
    });
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: 42 })],
      [conflictingHistory, canonical],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123 })],
      [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }],
    ));
    expect(report[0].classification).toBe("AMBIGUOUS");
    expect(report[0].conflicts).toContain("persisted_sync_number_disagreement");
    expect(report[0].canonicalHistoryCount).toBe(1);
    expect(report[0].prepCluster.min?.getTime()).toBe(prep.getTime());
    expect(report[0].prepCluster.max?.getTime()).toBe(prep.getTime());
  });

  it("does not treat a stale raw ID history owned by another clan as disagreement", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const unrelatedClanHistory = history({ warId: 900001, syncNumber: 499, clanTag: "#OTHER" });
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: 900001 })],
      [canonical, unrelatedClanHistory],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123 })],
      [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }],
    ));
    expect(report[0].classification).toBe("EXISTING_CYCLE_FALLBACK");
    expect(report[0].conflicts).not.toContain("persisted_sync_number_disagreement");
    expect(report[0].canonicalHistoryCount).toBe(1);
  });

  it("fails closed when a canonical history lookup has the wrong clan", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: 900001 })],
      [canonical],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123, clanTag: "#OTHER" })],
      [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }],
    ));
    expect(report[0].classification).toBe("AMBIGUOUS");
    expect(report[0].conflicts).toContain("warlookup_clan_identity_mismatch");
    expect(formatAuditSummary(report)).toContain("warlookup_clan_identity_mismatch: 1");
  });

  it("recovers a matching lookup from a tuple-resolved null raw point ID", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const report = classifyAuditCycles(buildCycleInputs(
      [point({ syncNumber: 500, warId: null })],
      [canonical],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123 })],
      [{ guildId: "guild-1", syncNumber: 500, syncTime: sync }],
    ));
    expect(report[0].classification).toBe("EXISTING_CYCLE_FALLBACK");
    expect(report[0].conflicts).not.toContain("warlookup_clan_identity_mismatch");
  });

  it("preserves ambiguity when one canonical history maps to multiple owners", () => {
    const canonical = history({ warId: 100123, syncNumber: 500 });
    const report = classifyAuditCycles(buildCycleInputs(
      [
        point({ guildId: "guild-1", syncNumber: 500, warId: 900001 }),
        point({ guildId: "guild-2", syncNumber: 500, warId: 900002 }),
      ],
      [canonical],
      [],
      [schedule()],
      [],
      [lookup({ warId: 100123 })],
      [
        { guildId: "guild-1", syncNumber: 500, syncTime: sync },
        { guildId: "guild-2", syncNumber: 500, syncTime: sync },
      ],
    ));
    expect(report).toHaveLength(2);
    expect(report.every((row) => row.classification === "AMBIGUOUS")).toBe(true);
    expect(report.every((row) => row.conflicts.includes("history_maps_to_multiple_guild_sync_owners"))).toBe(true);
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
    const scheduledSpread = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [
        history({ prepStartTime: new Date("2026-01-01T00:00:00.000Z") }),
        history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2", prepStartTime: new Date("2026-01-01T05:00:00.000Z") }),
      ],
      participation: [participation(), participation({ clanTag: "#HOME2", warId: 43 })],
      schedules: [schedule({ syncTime: new Date("2026-01-01T02:30:00.000Z") })],
    }));
    expect(scheduledSpread.classification).toBe("AMBIGUOUS");
    expect(scheduledSpread.conflicts).toContain("excessive_prep_start_spread");
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

  it("marks a persisted canonical participation roster complete without team-size gating", () => {
    const report = classifyAuditCycle(input({ participation: [participation()], lookups: [lookup()] }));
    expect(report.expectedTeamSize).toBe(2);
    expect(report.rosterCompleteness).toBe("COMPLETE");
    expect(report.participationDistinctPlayerCount).toBe(1);
  });

  it("evaluates roster completeness independently for mixed historical team sizes", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const secondHistory = history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const firstRoster = Array.from({ length: 50 }, (_, index) => participation({ playerTag: `#A${String(index).padStart(3, "0")}` }));
    const secondRoster = Array.from({ length: 40 }, (_, index) => participation({
      playerTag: `#B${String(index).padStart(3, "0")}`,
      clanTag: "#HOME2",
      warId: 43,
    }));
    const report = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [history(), secondHistory],
      lookups: [
        lookup({ payload: { warMeta: { teamSize: 50, teamSizeSource: "war_event_snapshot" }, canonical: { participants: firstRoster.map((row) => row.playerTag) } } }),
        lookup({ warId: 43, clanTag: "#HOME2", payload: { warMeta: { teamSize: 40, teamSizeSource: "war_event_snapshot" }, canonical: { participants: secondRoster.map((row) => row.playerTag) } } }),
      ],
      participation: [],
    }));
    expect(report.expectedTeamSize).toBeNull();
    expect(report.expectedTeamSizesByClan).toEqual({ "#H0ME": 50, "#H0ME2": 40 });
    expect(report.perClanRosterCompleteness).toEqual({ "#H0ME": "COMPLETE", "#H0ME2": "COMPLETE" });
    expect(report.rosterCompleteness).toBe("COMPLETE");
  });

  it("reports per-clan completeness and retains zero-row unknown clans", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const report = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" })],
      participation: [
        participation({ playerTag: "#A1" }),
        participation({ playerTag: "#A2" }),
        participation({ playerTag: "#B1", clanTag: "#HOME2", warId: 43 }),
      ],
      lookups: [
        lookup({ payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [] } } }),
        lookup({ warId: 43, clanTag: "#HOME2", payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [] } } }),
      ],
    }));
    expect(report.perClanRosterCompleteness).toEqual({ "#H0ME": "COMPLETE", "#H0ME2": "COMPLETE" });
    expect(formatCycleRow(report)).toContain("#H0ME=2/2:COMPLETE,#H0ME2=1/2:COMPLETE");

    const unknownReport = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" })],
      participation: [participation({ playerTag: "#A1" })],
      lookups: [lookup({ payload: { warMeta: { teamSize: 1, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [] } } })],
    }));
    expect(unknownReport.perClanRosterCounts["#H0ME2"]).toBeUndefined();
    expect(unknownReport.perClanRosterCompleteness["#H0ME2"]).toBe("UNKNOWN");
    expect(formatAggregatePerClanCoverage([unknownReport])).toEqual([
      "clan=#H0ME first_recoverable_sync=12 last_recoverable_sync=12 candidate_cycles=1 complete_roster_cycles=1 partial_roster_cycles=0 unknown_roster_cycles=0",
      "clan=#H0ME2 first_recoverable_sync=12 last_recoverable_sync=12 candidate_cycles=1 complete_roster_cycles=0 partial_roster_cycles=0 unknown_roster_cycles=1",
    ]);
  });

  it("keeps persisted participation complete when WarLookup has no authoritative team size", () => {
    const report = classifyAuditCycle(input({
      participation: [participation(), participation({ playerTag: "#PLAYER2" })],
      lookups: [lookup({ payload: { canonical: { participants: ["#PLAYER1", "#PLAYER2"] } } })],
    }));
    expect(report.expectedTeamSizesByClan).toEqual({ "#H0ME": null });
    expect(report.perClanRosterCompleteness).toEqual({ "#H0ME": "COMPLETE" });
  });

  it("uses normalized participation for one clan and WarLookup fallback for another", () => {
    const secondPoint = point({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" });
    const report = classifyAuditCycle(input({
      points: [point(), secondPoint],
      histories: [history(), history({ clanTag: "#HOME2", warId: 43, opponentTag: "#OPPONENT2" })],
      participation: [participation({ playerTag: "#PLAYER1" })],
      lookups: [lookup({ warId: 43, clanTag: "#HOME2", payload: { canonical: { participants: ["#PLAYER2"] } } })],
    }));
    expect(report.playerClanFacts).toEqual([
      { playerTag: "#PLAYER1", clanTag: "#H0ME", source: "ClanWarParticipation" },
      { playerTag: "#PLAYER2", clanTag: "#H0ME2", source: "WarLookup.canonical.participants" },
    ]);
    expect(report.classification).toBe("SCHEDULED_SYNC_CANDIDATE");
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
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-03T00:00:00.000Z"), syncNumber: 12 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-02T00:00:00.000Z"))]);
    expect(projected.clanStreakSyncs).toBe(2);
  });

  it("does not count candidate presence across unknown or authoritative absence", () => {
    const unknownGap = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z")],
      boundaryIdentities: [
        { boundaryTime: new Date("2026-03-03T00:00:00.000Z"), syncNumber: 12 },
        { boundaryTime: new Date("2026-03-02T00:00:00.000Z"), syncNumber: 11 },
      ],
      evidenceRows: [
        boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME"),
        boundaryEvidence(new Date("2026-03-02T00:00:00.000Z"), null),
      ],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-01T00:00:00.000Z"))]);
    expect(unknownGap.clanStreakSyncs).toBe(1);
    const absence = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-02T00:00:00.000Z")],
      boundaryIdentities: [
        { boundaryTime: new Date("2026-03-03T00:00:00.000Z"), syncNumber: 12 },
        { boundaryTime: new Date("2026-03-02T00:00:00.000Z"), syncNumber: 11 },
      ],
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
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-03T00:00:00.000Z"), syncNumber: 12 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-03T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [candidateReport(11, new Date("2026-03-02T00:00:00.000Z"), "#OTHER")]);
    expect(projected.clanStreakSyncs).toBe(1);
    expect(projected.allianceStreakSyncs).toBe(2);
  });

  it("does not inflate a projection across a noncontiguous candidate run", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-04T00:00:00.000Z")],
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-04T00:00:00.000Z"), syncNumber: 13 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-04T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [
      candidateReport(12, new Date("2026-03-03T00:00:00.000Z")),
      candidateReport(11, new Date("2026-03-02T00:00:00.000Z"), null),
      candidateReport(10, new Date("2026-03-01T00:00:00.000Z")),
    ]);
    expect(projected.clanStreakSyncs).toBe(2);
  });

  it("does not bridge an ambiguous intervening sync", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-04T00:00:00.000Z")],
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-04T00:00:00.000Z"), syncNumber: 451 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-04T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [
      ambiguousReport(450, new Date("2026-03-03T00:00:00.000Z")),
      candidateReport(449, new Date("2026-03-02T00:00:00.000Z")),
    ]);
    expect(projected.clanStreakSyncs).toBe(1);
    expect(projected.clanStreakIsLowerBound).toBe(true);
  });

  it("does not bridge a missing intervening sync number", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-04T00:00:00.000Z")],
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-04T00:00:00.000Z"), syncNumber: 451 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-04T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [candidateReport(449, new Date("2026-03-02T00:00:00.000Z"))]);
    expect(projected.clanStreakSyncs).toBe(1);
    expect(projected.clanStreakIsLowerBound).toBe(true);
  });

  it("extends normally when every intervening sync is safe", () => {
    const projected = projectMembershipStreak("#PLAYER1", {
      boundaryTimes: [new Date("2026-03-04T00:00:00.000Z")],
      boundaryIdentities: [{ boundaryTime: new Date("2026-03-04T00:00:00.000Z"), syncNumber: 451 }],
      evidenceRows: [boundaryEvidence(new Date("2026-03-04T00:00:00.000Z"), "#H0ME")],
      boundaryHistoryTruncated: false,
    }, [
      candidateReport(450, new Date("2026-03-03T00:00:00.000Z")),
      candidateReport(449, new Date("2026-03-02T00:00:00.000Z")),
    ]);
    expect(projected.clanStreakSyncs).toBe(3);
    expect(projected.clanStreakIsLowerBound).toBe(false);
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
    const anchor = classifyAuditCycle(input({ syncNumber: 20, syncCycleTime: new Date("2026-01-02T00:00:00.000Z") }));
    const before = classifyAuditCycle(input({ syncNumber: 19, schedules: [], points: [point({ syncNumber: 19 })], histories: [history({ syncNumber: 19, prepStartTime: new Date("2026-01-01T00:00:00.000Z") })] }));
    const after = classifyAuditCycle(input({ syncNumber: 21, syncCycleTime: new Date("2026-01-03T00:00:00.000Z"), schedules: [], points: [point({ syncNumber: 21 })], histories: [history({ syncNumber: 21, prepStartTime: new Date("2026-01-03T00:00:00.000Z") })] }));
    const tenure = buildTenureDiagnostics([anchor, before, after], [{
      guildId: "guild-1",
      playerTag: "#PLAYER1",
      clanTag: "#HOME",
      startedAtSyncTime: new Date("2026-01-02T00:00:00.000Z"),
    }]);
    expect(tenure.join("\n")).toContain("theoretical_extension_boundaries=1");
    expect(tenure.join("\n")).not.toContain("theoretical_extension_boundaries=2");
  });

  it("anchors theoretical Home backdate continuity to the persisted start sync", () => {
    const startTime = new Date("2026-05-01T00:00:00.000Z");
    const make = (syncNumber: number, candidateTime: Date, syncCycleTime: Date | null = null, clanTag: string | null = "#HOME") =>
      candidateReport(syncNumber, candidateTime, clanTag, syncCycleTime);
    const anchor = classifyAuditCycle(input({ syncNumber: 500, syncCycleTime: startTime }));
    const sync499 = make(499, new Date("2026-04-30T00:00:00.000Z"));
    const sync498 = make(498, new Date("2026-04-29T00:00:00.000Z"));
    const home = { guildId: "guild-1", playerTag: "#PLAYER1", clanTag: "#HOME", startedAtSyncTime: startTime };

    const two = buildTenureDiagnostics([anchor, sync499, sync498], [home]).join("\n");
    expect(two).toContain("home_start_sync=500");
    expect(two).toContain("theoretical_extension_boundaries=2");

    const only498 = buildTenureDiagnostics([anchor, sync498], [home]).join("\n");
    expect(only498).toContain("theoretical_extension_boundaries=0");
    expect(only498).toContain("stop_reason=GAP");

    const unresolved499 = buildTenureDiagnostics([anchor, ambiguousReport(499, new Date("2026-04-30T00:00:00.000Z")), sync498], [home]).join("\n");
    expect(unresolved499).toContain("theoretical_extension_boundaries=0");
    expect(unresolved499).toContain("stop_reason=CONFLICT");

    const unknownAnchor = buildTenureDiagnostics([sync499], [home]).join("\n");
    expect(unknownAnchor).toContain("home_start_sync=unknown");
    expect(unknownAnchor).toContain("stop_reason=START_ANCHOR_UNKNOWN");
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

  it("stages participation and WarLookup reads by canonical history IDs", async () => {
    const rawHistory = {
      warId: 100123,
      syncNumber: 77,
      matchType: "FWA",
      clanTag: "#HOME",
      opponentTag: "#OPPONENT",
      warStartTime: warStart,
      prepStartTime: prep,
      warEndTime: new Date("2026-01-01T05:00:00.000Z"),
    };
    const participationArgs: any[] = [];
    const lookupArgs: any[] = [];
    const reads = {
      syncCycle: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      syncClanMemberSnapshot: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) },
      scheduledSyncPost: { findMany: vi.fn(async () => [{ id: "schedule-1", guildId: "guild-1", syncTime: sync, status: "SCHEDULED" }]) },
      clanPointsSync: { findMany: vi.fn(async () => [{ guildId: "guild-1", syncNum: 77, clanTag: "#HOME", warId: "900001", warStartTime: warStart, opponentTag: "#OPPONENT", isFwa: true }]) },
      clanWarHistory: { findMany: vi.fn(async () => [rawHistory]) },
      clanWarParticipation: { findMany: vi.fn(async (args) => {
        participationArgs.push(args);
        return [{ guildId: "guild-1", warId: "100123", clanTag: "#HOME", playerTag: "#PLAYER1", matchType: "FWA" }, { guildId: "guild-1", warId: "999999", clanTag: "#OTHER", playerTag: "#UNRELATED", matchType: "FWA" }];
      }) },
      warLookup: { findMany: vi.fn(async (args) => {
        lookupArgs.push(args);
        return [
          { warId: "100123", clanTag: "#HOME", startTime: warStart, payload: { warMeta: { teamSize: 2, teamSizeSource: "war_event_snapshot" }, canonical: { participants: ["#PLAYER1", "#PLAYER2"] } } },
          { warId: "999999", clanTag: "#OTHER", startTime: warStart, payload: { canonical: { participants: ["#UNRELATED"] } } },
        ];
      }) },
      clanHomeMembershipPeriod: { findMany: vi.fn(async () => []) },
      syncClanReadinessSnapshot: { groupBy: vi.fn(async () => []) },
      allianceClanMembershipInterval: { findMany: vi.fn(async () => []) },
      warPlanComplianceEvaluation: { findMany: vi.fn(async () => []) },
    } satisfies ReadOnlyAuditDb;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reports = await runMembershipHistoryBackfillAudit(reads);
    log.mockRestore();

    expect(reports).toHaveLength(1);
    expect(reports[0].classification).toBe("SCHEDULED_SYNC_CANDIDATE");
    expect(participationArgs).toHaveLength(1);
    expect(participationArgs[0].where.warId.in).toEqual(["100123"]);
    expect(lookupArgs).toHaveLength(1);
    expect(lookupArgs[0].where.warId.in).toEqual(["100123"]);
    expect((reads as unknown as Record<string, unknown>).create).toBeUndefined();
    expect((reads as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((reads as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it("reports prep cluster spread in seconds and minutes", () => {
    const result = buildPrepCluster([prep, new Date(prep.getTime() + 90_000)]);
    expect(result.spreadSeconds).toBe(90);
    expect(result.spreadMinutes).toBe(2);
  });
});
