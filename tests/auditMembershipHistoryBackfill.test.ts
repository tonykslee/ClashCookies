import { describe, expect, it, vi } from "vitest";
import {
  buildPrepCluster,
  buildTenureDiagnostics,
  classifyAuditCycle,
  classifyAuditCycles,
  type AuditCycleInput,
  type AuditHistoryEvidence,
  type AuditLookupEvidence,
  type AuditParticipationEvidence,
  type AuditPointEvidence,
  type AuditScheduleEvidence,
  type ReadOnlyAuditDb,
  runMembershipHistoryBackfillAudit,
} from "../src/scripts/auditMembershipHistoryBackfill";

const prep = new Date("2026-01-01T00:00:00.000Z");
const sync = new Date("2026-01-01T02:00:00.000Z");
const warStart = new Date("2026-01-01T03:00:00.000Z");

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

function participation(overrides: Partial<AuditParticipationEvidence> = {}): AuditParticipationEvidence {
  return {
    guildId: "guild-1",
    warId: 42,
    clanTag: "#HOME",
    playerTag: "#PLAYER1",
    ...overrides,
  };
}

function schedule(overrides: Partial<AuditScheduleEvidence> = {}): AuditScheduleEvidence {
  return {
    id: "schedule-1",
    guildId: "guild-1",
    syncTime: sync,
    status: "SCHEDULED",
    ...overrides,
  };
}

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
