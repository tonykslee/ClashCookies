import { describe, expect, it, vi } from "vitest";
import {
  FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
} from "../src/services/fwa-feeds/FwaWarMembersObservationService";
import { FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION } from "../src/services/fwa-feeds/FwaWarMembersSourceEvidence";
import {
  NativeHeatMapRefCohortAuditService,
  NATIVE_COHORT_AUDIT_OWNER_POLICY_STATUS,
} from "../src/services/NativeHeatMapRefCohortAuditService";
import { NativeHeatMapRefObservationCandidateService, NATIVE_OBSERVATION_READ_LIMIT } from "../src/services/NativeHeatMapRefObservationCandidateService";

const evaluationAt = new Date("2026-11-21T00:00:00.000Z");
const eraPolicy = {
  policyId: "fwa-native-current-era",
  policyVersion: "explicit-window-v1",
  eraStartIso: "2026-11-19T00:00:00.000Z",
  eraEndIso: "2026-11-22T00:00:00.000Z",
};
const bands = [
  { weightMinInclusive: 0, weightMaxInclusive: 7_200_000 },
  { weightMinInclusive: 7_200_001, weightMaxInclusive: 9_999_999 },
];

function makeEvidence(clanTag: string, observedAt: string, fingerprint: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${clanTag}-evidence-${fingerprint}`,
    observationId: `${clanTag}-observation`,
    evidenceSchemaVersion: FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
    sourceContractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    sourceWarNo: 1,
    firstObservedAt: new Date(observedAt),
    observedAt: new Date(observedAt),
    ingestedAt: new Date(observedAt),
    sourceQualityFingerprint: fingerprint,
    structuralStatus: "VERIFIED",
    rosterCompletenessStatus: "VERIFIED",
    weightStatus: "VERIFIED",
    sourceAuthorityStatus: FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
    sourceQualityReasonCodes: ["source_authority_unknown_unverified"],
    ...overrides,
  };
}

function makeMembers(clanTag: string, rawWeight: number | null, missingCount = 0) {
  return Array.from({ length: 50 }, (_, index) => ({
    id: `${clanTag}-member-${index + 1}`,
    observationId: `${clanTag}-observation`,
    memberFingerprint: `${clanTag}-member-${index + 1}`,
    clanTag,
    playerTag: `#PLAYER${index + 1}`,
    playerName: `Player ${index + 1}`,
    position: index + 1,
    townHall: 18,
    rawWeight: index < missingCount ? null : rawWeight,
  }));
}

function makeObservation(
  clanTag: string,
  observedAt: string,
  rawWeight = 181_000,
  options: {
    evidence?: unknown[];
    missingCount?: number;
    id?: string;
    rosterFingerprint?: string;
    overrides?: Record<string, unknown>;
  } = {},
) {
  return {
    id: options.id ?? `${clanTag}-observation`,
    clanTag,
    sourceContractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    observationSchemaVersion: FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
    sourceWarNo: 1,
    firstObservedAt: new Date(observedAt),
    observedAt: new Date(observedAt),
    ingestedAt: new Date(observedAt),
    rosterFingerprint: options.rosterFingerprint ?? `${clanTag}-roster-${observedAt}`,
    members: makeMembers(clanTag, rawWeight, options.missingCount),
    qualityEvidence: options.evidence ?? [makeEvidence(clanTag, observedAt, `${clanTag}-${options.id ?? "observation"}-quality-${observedAt}`)],
    ...options.overrides,
  };
}

function makeAudit(rows: unknown[], readDeferredWeights = vi.fn().mockResolvedValue(new Map())) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const observationService = new NativeHeatMapRefObservationCandidateService({ fwaWarMembersObservation: { findMany } } as never, readDeferredWeights);
  return {
    findMany,
    readDeferredWeights,
    service: new NativeHeatMapRefCohortAuditService(observationService),
  };
}

describe("NativeHeatMapRefCohortAuditService", () => {
  it("reports independent clans, superseded samples, quality exclusions, and mixed resolution without member output", async () => {
    const qualityExcluded = makeObservation("#QUALITY", "2026-11-19T01:00:00.000Z", 140_000, {
      evidence: [makeEvidence("#QUALITY", "2026-11-19T01:00:00.000Z", "conflict", { structuralStatus: "CONFLICTING" })],
    });
    const oneAnchor = makeObservation("#ANCHOR", "2026-11-19T02:00:00.000Z", 181_000, { missingCount: 49 });
    const estimated = makeObservation("#ESTIMATED", "2026-11-19T03:00:00.000Z", 181_000, { missingCount: 1 });
    const deferred = makeObservation("#DEFERRED", "2026-11-19T04:00:00.000Z", 181_000, { missingCount: 1 });
    const deferredRead = vi.fn().mockResolvedValue(new Map([
      ["#DEFERRED", new Map([["#PLAYER1", { deferredWeight: 180_000, createdAt: new Date("2026-11-19T05:00:00.000Z") }]])],
    ]));
    const older = makeObservation("#DUPLICATE", "2026-11-19T05:00:00.000Z", 140_000, { rosterFingerprint: "old" });
    const newer = makeObservation("#DUPLICATE", "2026-11-20T05:00:00.000Z", 140_000, { id: "#DUPLICATE-observation-new", rosterFingerprint: "new" });
    const { service } = makeAudit([qualityExcluded, oneAnchor, estimated, deferred, older, newer], deferredRead);
    const audit = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands, defermentScope: { guildId: "guild-1", clanTag: "#DEFERRED" } });

    expect(audit.ownerPolicyStatus).toBe(NATIVE_COHORT_AUDIT_OWNER_POLICY_STATUS);
    expect(audit.aggregate.observedSemanticSampleCount).toBe(6);
    expect(audit.aggregate.selectedIndependentClanCount).toBe(5);
    expect(audit.aggregate.supersededSemanticSampleCount).toBe(1);
    expect(audit.aggregate.qualityRevisionCount).toBe(6);
    expect(audit.aggregate.structurallyOrQualityExcludedSelectionCount).toBe(1);
    expect(audit.aggregate.fullyResolvedRosterCount).toBe(2);
    expect(audit.aggregate.inferenceDependentRosterCount).toBe(2);
    expect(audit.aggregate.unresolvedRosterCount).toBe(0);
    expect(audit.selectionStageExclusions.reasonCounts).toEqual({ quality_conflict: 1 });
    expect(audit.bands).toHaveLength(2);
    expect(audit.bands[1]?.resolvedWeightCounts.DEFERRED).toBeGreaterThan(0);
    expect(audit.bands[1]?.calculationOutcomeDistribution).toMatchObject({ CALCULATION_QUALIFIED: 2, "CALCULATION_EXCLUDED:insufficient_weight_support": 1 });
    expect(audit.bands[1]?.retainedEvidenceQualityDistribution).toEqual({ QUALITY_ELIGIBLE: 2 });
    expect(JSON.stringify(audit)).not.toContain("PLAYER1");
  });

  it("reports unresolved cohorts and does not invent independent band attribution", async () => {
    const unresolved = makeObservation("#UNRESOLVED", "2026-11-19T01:00:00.000Z", null);
    const malformed = makeObservation("#MALFORMED", "2026-11-19T02:00:00.000Z", 181_000, {
      overrides: { members: [{ ...makeMembers("#MALFORMED", 181_000)[0], position: null }] },
    });
    const { service } = makeAudit([unresolved, malformed]);
    const audit = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(audit.aggregate.unresolvedRosterCount).toBe(1);
    expect(audit.aggregate.unattributedCalculationExclusionCount).toBeGreaterThan(0);
    expect(audit.bands.every((band) => band.status === "UNKNOWN")).toBe(true);
    expect(audit.bands.every((band) => band.excludedCount === 0)).toBe(true);
  });

  it("keeps threshold sensitivity diagnostic and includes the proposed 2-anchor/10-clan scenario", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => makeObservation(`#CLAN${index + 1}`, `2026-11-19T0${index + 1}:00:00.000Z`, 140_000));
    const { service } = makeAudit(rows);
    const audit = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    const proposed = audit.sensitivity.find((scenario) => scenario.minimumDirectWeightAnchors === 2 && scenario.minimumDistinctClansPerBand === 10);
    const relaxed = audit.sensitivity.find((scenario) => scenario.minimumDirectWeightAnchors === 1 && scenario.minimumDistinctClansPerBand === 1);
    expect(proposed?.bands[0]?.status).toBe("UNKNOWN");
    expect(relaxed?.bands[0]?.status).toBe("SUPPORTED");
    expect(audit.policyProposals).toEqual({ minimumDirectWeightAnchors: 2, minimumDistinctClansPerBand: 10, effectiveSampleThreshold: 10, alternativesAreDiagnosticOnly: true });
    const customThreshold = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands, sampleThreshold: 5 });
    expect(customThreshold.policyProposals.effectiveSampleThreshold).toBe(5);
  });

  it("preserves as-of correction differences, deduplicates repeats, and is deterministic without writes", async () => {
    const bad = makeEvidence("#CUTOFF", "2026-11-19T02:00:00.000Z", "bad", { structuralStatus: "CONFLICTING" });
    const clean = makeEvidence("#CUTOFF", "2026-11-20T02:00:00.000Z", "clean");
    const observation = makeObservation("#CUTOFF", "2026-11-19T01:00:00.000Z", 181_000, { evidence: [bad, clean] });
    const repeatedOld = makeObservation("#REPEAT", "2026-11-19T03:00:00.000Z", 181_000, { id: "repeat-old", rosterFingerprint: "same" });
    const repeatedNew = makeObservation("#REPEAT", "2026-11-20T03:00:00.000Z", 181_000, { id: "repeat-new", rosterFingerprint: "same" });
    const { service, findMany, readDeferredWeights } = makeAudit([observation, repeatedOld, repeatedNew]);
    const early = await service.generate({ evaluationAt: "2026-11-19T12:00:00.000Z", eraPolicy, bandDefinitions: bands });
    const late = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    const lateAgain = await service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(early.selectionStageExclusions.reasonCounts).toEqual({ quality_conflict: 1 });
    expect(late.aggregate.qualityRevisionCount).toBe(4);
    expect(late.aggregate.supersededSemanticSampleCount).toBe(1);
    expect(late).toEqual(lateAgain);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(readDeferredWeights).toHaveBeenCalledTimes(0);
  });

  it("fails closed for global ambiguity and bounded truncation", async () => {
    const equalA = makeObservation("#AMBIGUOUS", "2026-11-19T01:00:00.000Z", 181_000, { id: "ambiguous-a" });
    const equalB = makeObservation("#AMBIGUOUS", "2026-11-19T01:00:00.000Z", 181_000, { id: "ambiguous-b" });
    const ambiguous = await makeAudit([equalA, equalB]).service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(ambiguous.coverageStatus).toBe("AMBIGUOUS");
    expect(ambiguous.globalAmbiguityStatus).toBe("AMBIGUOUS");
    expect(ambiguous.bands.every((band) => band.status === "UNKNOWN")).toBe(true);

    const rows = Array.from({ length: NATIVE_OBSERVATION_READ_LIMIT + 1 }, (_, index) => makeObservation(`#TRUNCATED${index}`, "2026-11-19T01:00:00.000Z", 181_000));
    const truncated = await makeAudit(rows).service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(truncated.coverageStatus).toBe("TRUNCATED");
    expect(truncated.bands.every((band) => band.status === "UNKNOWN")).toBe(true);
    expect(truncated.aggregate.boundedReadRowCount).toBe(NATIVE_OBSERVATION_READ_LIMIT + 1);
    expect(truncated.aggregate.readLimited).toBe(true);
  });

  it("separates malformed available observations from eligible semantic lineage", async () => {
    const valid = makeObservation("#VALID", "2026-11-19T01:00:00.000Z");
    const malformed = makeObservation("#MALFORMED", "2026-11-19T02:00:00.000Z", 181_000, {
      overrides: {
        observedAt: new Date("2026-11-19T03:00:00.000Z"),
        ingestedAt: new Date("2026-11-19T02:30:00.000Z"),
      },
    });
    const audit = await makeAudit([valid, malformed]).service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(audit.aggregate.boundedReadRowCount).toBe(2);
    expect(audit.aggregate.readLimited).toBe(false);
    expect(audit.aggregate.eligibleSemanticLineageCount).toBe(1);
    expect(audit.aggregate.malformedAvailableObservationCount).toBe(1);
    expect(audit.coverageStatus).toBe("AMBIGUOUS");
    expect(audit.bands.every((band) => band.status === "UNKNOWN")).toBe(true);
  });

  it("binds the aggregate fingerprint to retained quality lineage", async () => {
    const first = makeObservation("#LINEAGE", "2026-11-19T01:00:00.000Z", 181_000, {
      evidence: [makeEvidence("#LINEAGE", "2026-11-19T01:00:00.000Z", "quality-a")],
    });
    const second = makeObservation("#LINEAGE", "2026-11-19T01:00:00.000Z", 181_000, {
      evidence: [makeEvidence("#LINEAGE", "2026-11-19T01:00:00.000Z", "quality-b")],
    });
    const left = await makeAudit([first]).service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    const right = await makeAudit([second]).service.generate({ evaluationAt, eraPolicy, bandDefinitions: bands });
    expect(left.aggregate.observedSemanticSampleCount).toBe(right.aggregate.observedSemanticSampleCount);
    expect(left.aggregate.selectedIndependentClanCount).toBe(right.aggregate.selectedIndependentClanCount);
    expect(left.candidateContentFingerprint).not.toBe(right.candidateContentFingerprint);
    expect(left.contentFingerprint).not.toBe(right.contentFingerprint);
  });
});
