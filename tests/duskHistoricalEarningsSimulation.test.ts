import { describe, expect, it } from "vitest";
import {
  formatHistoricalDuskitsSimulationReport,
  simulateHistoricalDuskits,
  validateHistoricalSimulationScope,
  type HistoricalEarningsSimulationInput,
  type HistoricalEvaluationRow,
  type HistoricalParticipationRow,
  type HistoricalPlayerLinkRow,
  type HistoricalRepWorkEventRow,
  type HistoricalWarRow,
} from "../src/services/duskHistoricalEarningsSimulation";
import {
  parseDuskHistoricalSimulationArgs,
  validateSimulationDatabaseConfig,
} from "../src/scripts/duskHistoricalEarningsSimulation";

const guildId = "guild-1";
const scope = {
  guildId,
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-19T00:00:00.000Z"),
  snapshotAt: new Date("2026-01-20T00:00:00.000Z"),
};

function war(warId: number, end = "2026-01-07T12:00:00.000Z", overrides: Partial<HistoricalWarRow> = {}): HistoricalWarRow {
  return {
    warId,
    matchType: "FWA",
    clanTag: "#HOME",
    opponentTag: "#OPPONENT",
    warStartTime: new Date("2026-01-06T12:00:00.000Z"),
    warEndTime: new Date(end),
    createdAt: new Date("2026-01-07T13:00:00.000Z"),
    updatedAt: new Date("2026-01-07T13:00:00.000Z"),
    participationCompleteness: "COMPLETE",
    ...overrides,
  };
}

function participation(warId: number, playerTag = "#ALPHA", overrides: Partial<HistoricalParticipationRow> = {}): HistoricalParticipationRow {
  return {
    guildId,
    warId: String(warId),
    clanTag: "#HOME",
    opponentTag: "#OPPONENT",
    playerTag,
    attacksUsed: 1,
    attacksMissed: 0,
    matchType: "FWA",
    warStartTime: new Date("2026-01-06T12:00:00.000Z"),
    warEndTime: new Date("2026-01-07T12:00:00.000Z"),
    createdAt: new Date("2026-01-07T13:00:00.000Z"),
    ...overrides,
  };
}

function evaluation(warId: number, overrides: Partial<HistoricalEvaluationRow> = {}): HistoricalEvaluationRow {
  return {
    guildId,
    warId,
    status: "COMPLETED",
    completedAt: new Date("2026-01-08T00:00:00.000Z"),
    createdAt: new Date("2026-01-07T13:00:00.000Z"),
    updatedAt: new Date("2026-01-08T00:00:00.000Z"),
    violations: [],
    ...overrides,
  };
}

function link(playerTag = "#ALPHA", userId = "111111111111111", overrides: Partial<HistoricalPlayerLinkRow> = {}): HistoricalPlayerLinkRow {
  return {
    playerTag,
    discordUserId: userId,
    linkSource: "VERIFIED",
    verificationStatus: "VERIFIED",
    verificationMethod: "API",
    verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function repEvent(dedupeKey: string, overrides: Partial<HistoricalRepWorkEventRow> = {}): HistoricalRepWorkEventRow {
  return {
    guildId,
    activityType: "BASES_CHECKED",
    discordUserId: "111111111111111",
    clanTag: "#HOME",
    syncMessageId: "sync-1",
    sourceMessageId: "message-1",
    warId: "100",
    warStartTime: new Date("2026-01-06T12:00:00.000Z"),
    eventAt: new Date("2026-01-07T10:00:00.000Z"),
    dedupeKey,
    metadata: {
      activityType: "BASES_CHECKED",
      source: "base_swap",
      sourceVariant: "single",
      clanKind: "FWA",
      syncMessageId: "sync-1",
      sourceMessageId: "message-1",
      sourceTrackedMessageId: null,
      warId: "100",
      warStartTimeIso: "2026-01-06T12:00:00.000Z",
      opponentTag: "#OPPONENT",
      eventAtIso: "2026-01-07T10:00:00.000Z",
      prepTimeLeftSeconds: 7200,
    },
    createdAt: new Date("2026-01-07T10:00:01.000Z"),
    updatedAt: new Date("2026-01-07T10:00:01.000Z"),
    ...overrides,
  };
}

function input(overrides: Partial<HistoricalEarningsSimulationInput> = {}): HistoricalEarningsSimulationInput {
  return {
    scope,
    wars: [war(100)],
    participation: [participation(100)],
    evaluations: [evaluation(100)],
    playerLinks: [link()],
    repEvents: [],
    ...overrides,
  };
}

describe("historical Duskits earnings simulation", () => {
  it("joins exact ended-war identity and applies the clean FWA rate once per user/war", () => {
    const report = simulateHistoricalDuskits(input({
      participation: [participation(100), participation(100, "#BETA")],
      playerLinks: [link("#ALPHA", "111111111111111"), link("#BETA", "111111111111111")],
    }));
    expect(report.cleanFwa.verifiedEvents).toBe(1);
    expect(report.cleanFwa.duplicateEvents).toBe(1);
    expect(report.cleanFwa.strictDuskits).toBe(4);
    expect(report.weekly[0].strict.totalCappedDuskits).toBe(4);
  });

  it("keeps roster, evaluation, violation, and identity gaps explicit", () => {
    const report = simulateHistoricalDuskits(input({
      wars: [war(100), war(101, "2026-01-14T12:00:00.000Z")],
      participation: [participation(100), participation(101, "#BETA", { opponentTag: "#WRONG" })],
      evaluations: [evaluation(100, { violations: [{ id: "violation-1", playerTag: "#ALPHA" }] })],
      playerLinks: [link(), link("#BETA", "222222222222222", { createdAt: new Date("2026-01-15T00:00:00.000Z") })],
    }));
    expect(report.coverage.canonicalRosterComplete).toBe(2);
    expect(report.coverage.incompleteOrMissingEvaluations).toBe(1);
    expect(report.coverage.playerViolationRows).toBe(1);
    expect(report.cleanFwa.ineligibleEvents).toBe(1);
    expect(report.cleanFwa.unknownEvents).toBeGreaterThanOrEqual(1);
    expect(report.unknownReasons.WAR_IDENTITY_CONFLICT).toBe(1);
    expect(report.unknownReasons.PLAYER_LINK_CREATED_AFTER_EVENT).toBeUndefined();
  });

  it("does not treat late or revoked current links as verified historical ownership", () => {
    const report = simulateHistoricalDuskits(input({
      participation: [participation(100, "#LATE"), participation(100, "#REVOKED")],
      playerLinks: [
        link("#LATE", "111111111111111", { createdAt: new Date("2026-01-08T00:00:00.000Z") }),
        link("#REVOKED", "222222222222222", { verificationStatus: "REVOKED" }),
      ],
    }));
    expect(report.cleanFwa.strictDuskits).toBe(0);
    expect(report.cleanFwa.provisionalDuskits).toBe(0);
    expect(report.unknownReasons.PLAYER_LINK_CREATED_AFTER_EVENT).toBe(1);
    expect(report.unknownReasons.PLAYER_LINK_REVOKED).toBe(1);
  });

  it("does not infer a complete roster from non-empty participation rows", () => {
    const report = simulateHistoricalDuskits(input({
      wars: [war(100, "2026-01-07T12:00:00.000Z", { participationCompleteness: "UNKNOWN" })],
    }));
    expect(report.coverage.canonicalRosterComplete).toBe(0);
    expect(report.coverage.canonicalRosterUnknown).toBe(1);
    expect(report.cleanFwa.strictDuskits).toBe(0);
    expect(report.cleanFwa.unknownEvents).toBe(1);
    expect(report.unknownReasons.WAR_ROSTER_COMPLETENESS_UNPROVEN).toBe(1);
  });

  it("deduplicates rep work by persisted dedupeKey and excludes CWL sources", () => {
    const report = simulateHistoricalDuskits(input({
      repEvents: [
        repEvent("rep|1"),
        repEvent("rep|1", { sourceMessageId: "message-2" }),
        repEvent("rep|bases-checklist", { metadata: { activityType: "BASES_CHECKED", source: "bases_checklist", viewType: "Bases", scopeKey: "scope-1", rowContextKey: "row-1" } }),
        repEvent("rep|mail-checklist", { metadata: { activityType: "MAIL_CHECKED", source: "mail_checklist", viewType: "Mail", scopeKey: "scope-1", rowContextKey: "row-1" }, activityType: "MAIL_CHECKED" }),
        repEvent("rep|mail-sent", { metadata: { activityType: "MAIL_SENT", source: "fwa_match_mail_send", mailChannelId: "mail-channel-1", mailMessageId: "mail-message-1" }, activityType: "MAIL_SENT" }),
        repEvent("rep|cwl", { metadata: { activityType: "BASES_CHECKED", source: "base_swap", sourceVariant: "single", clanKind: "CWL" } }),
        repEvent("rep|missing-clan-kind", { metadata: { activityType: "BASES_CHECKED", source: "base_swap", sourceVariant: "single" } }),
        repEvent("rep|invalid-clan-kind", { metadata: { activityType: "BASES_CHECKED", source: "base_swap", sourceVariant: "single", clanKind: "UNKNOWN" } }),
      ],
    }));
    expect(report.coverage.recognizedFwaRepEvents).toBe(4);
    expect(report.coverage.duplicateRepEvents).toBe(1);
    expect(report.repWork.strictDuskits).toBe(8);
    expect(report.repWork.baseSwapPublisherEvents).toBe(1);
    expect(report.unknownReasons.REP_EVENT_CWL_SOURCE).toBe(1);
    expect(report.unknownReasons.REP_EVENT_SOURCE_UNKNOWN).toBe(2);
  });

  it("uses UTC Monday buckets, a 30-Duskit weekly cap, and deterministic repeated output", () => {
    const wars = Array.from({ length: 8 }, (_, index) => war(100 + index));
    const participationRows = wars.map((row, index) => participation(row.warId, `#P${index}`));
    const evaluations = wars.map((row) => evaluation(row.warId));
    const links = wars.map((_, index) => link(`#P${index}`, "111111111111111"));
    const repEvents = Array.from({ length: 8 }, (_, index) => repEvent(`rep|${index}`, { eventAt: new Date(`2026-01-07T${String(10 + index).padStart(2, "0")}:00:00.000Z`) }));
    const report = simulateHistoricalDuskits(input({ wars, participation: participationRows, evaluations, playerLinks: links, repEvents }));
    expect(report.weekly[0].strict.totalUncappedDuskits).toBe(48);
    expect(report.weekly[0].strict.totalCappedDuskits).toBe(30);
    expect(report.weekly[0].strict.userCount).toBe(1);
    expect(simulateHistoricalDuskits(input({ wars, participation: participationRows, evaluations, playerLinks: links, repEvents }))).toEqual(report);
    expect(formatHistoricalDuskitsSimulationReport(report)).not.toContain("#P0");
  });

  it("validates complete UTC weeks and fails closed for unsafe database configuration", () => {
    expect(() => validateHistoricalSimulationScope({ ...scope, from: new Date("2026-01-06T00:00:00.000Z") })).toThrow(/Monday/);
    expect(() => parseDuskHistoricalSimulationArgs(["--guild", guildId, "--from", "2026-01-05T00:00:00.000Z", "--to", "2026-01-19T00:00:00.000Z"])).not.toThrow();
    expect(() => validateSimulationDatabaseConfig({ DATABASE_URL: "postgresql://prod", DUSK_SIMULATION_DATABASE_URL: "postgresql://prod", DUSK_SIMULATION_READ_ONLY: "1", DUSK_SIMULATION_READ_ONLY_ROLE: "readonly" })).toThrow(/must not equal/);
    expect(() => validateSimulationDatabaseConfig({ DUSK_SIMULATION_DATABASE_URL: "postgresql://readonly", DUSK_SIMULATION_READ_ONLY: "0", DUSK_SIMULATION_READ_ONLY_ROLE: "readonly" })).toThrow(/READ_ONLY=1/);
  });
});
