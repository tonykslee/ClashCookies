import { describe, expect, it, vi } from "vitest";
import {
  FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
} from "../src/services/fwa-feeds/FwaWarMembersObservationService";
import { validateNativeReferenceCandidateArtifact } from "../src/helper/nativeHeatMapRefCandidate";
import { FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION } from "../src/services/fwa-feeds/FwaWarMembersSourceEvidence";
import {
  NativeHeatMapRefObservationCandidateService,
  NATIVE_OBSERVATION_READ_LIMIT,
} from "../src/services/NativeHeatMapRefObservationCandidateService";

const evaluationAt = new Date("2026-11-21T00:00:00.000Z");
const eraPolicy = {
  policyId: "fwa-native-current-era",
  policyVersion: "explicit-window-v1",
  eraStartIso: "2026-11-19T00:00:00.000Z",
  eraEndIso: "2026-11-22T00:00:00.000Z",
};

function makeMembers(clanTag: string, rawWeight = 181_000) {
  return Array.from({ length: 50 }, (_, index) => ({
    id: `${clanTag}-${index + 1}`,
    observationId: `${clanTag}-observation`,
    memberFingerprint: `${clanTag}-member-${index + 1}`,
    clanTag,
    playerTag: `#PLAYER${index + 1}`,
    playerName: `Player ${index + 1}`,
    position: index + 1,
    townHall: 18,
    rawWeight,
  }));
}

function makeEvidence(clanTag: string, observedAt: string, fingerprint: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${clanTag}-evidence-${fingerprint}`,
    observationId: `${clanTag}-observation`,
    evidenceSchemaVersion: FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
    sourceContractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    sourceUrl: "https://example.invalid/WarMembers.json?warNo=1",
    sourceWarNo: 1,
    firstObservedAt: new Date(observedAt),
    observedAt: new Date(observedAt),
    ingestedAt: new Date(observedAt),
    rawRowCount: 50,
    acceptedRowCount: 50,
    discardedRowCount: 0,
    parserAcceptedRowCount: 50,
    parserRejectedRowCount: 0,
    evidenceEligibleRowCount: 50,
    evidenceIneligibleRowCount: 0,
    rawWeightPresentCount: 50,
    rawWeightMissingCount: 0,
    rawWeightInvalidCount: 0,
    canonicalSourceFingerprint: `${fingerprint}-raw`,
    sourceQualityFingerprint: fingerprint,
    structuralStatus: "VERIFIED",
    rosterCompletenessStatus: "VERIFIED",
    weightStatus: "VERIFIED",
    sourceAuthorityStatus: FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
    sourceQualityReasonCodes: ["exact_war_binding_unavailable", "source_authority_unknown_unverified", "source_generation_unbound"],
    ...overrides,
  };
}

function makeObservation(clanTag: string, observedAt: string, rosterFingerprint = `${clanTag}-roster`, evidence = [makeEvidence(clanTag, observedAt, `${clanTag}-quality`)]) {
  return {
    id: `${clanTag}-observation`,
    clanTag,
    sourceContractVersion: FWA_WAR_MEMBERS_SOURCE_CONTRACT_VERSION,
    observationSchemaVersion: FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
    sourceUrl: "https://example.invalid/WarMembers.json?warNo=1",
    sourceWarNo: 1,
    firstObservedAt: new Date(observedAt),
    observedAt: new Date(observedAt),
    ingestedAt: new Date(observedAt),
    rawRowCount: 50,
    acceptedRowCount: 50,
    discardedRowCount: 0,
    parserAcceptedRowCount: 50,
    parserRejectedRowCount: 0,
    evidenceEligibleRowCount: 50,
    evidenceIneligibleRowCount: 0,
    rawWeightPresentCount: 50,
    rawWeightMissingCount: 0,
    rawWeightInvalidCount: 0,
    canonicalSourceFingerprint: `${clanTag}-source`,
    rosterFingerprint,
    structuralStatus: "COMPLETE",
    rosterCompletenessStatus: "COMPLETE",
    weightStatus: "DIRECT_PRESENT",
    sourceAuthorityStatus: FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
    sourceQualityReasonCodes: [],
    members: makeMembers(clanTag),
    qualityEvidence: evidence,
  };
}

function serviceWithRows(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    findMany,
    service: new NativeHeatMapRefObservationCandidateService({ fwaWarMembersObservation: { findMany } } as never),
  };
}

describe("NativeHeatMapRefObservationCandidateService", () => {
  it("selects one semantic observation per clan and preserves superseded lineage", async () => {
    const first = makeObservation("#CLAN", "2026-11-19T01:00:00.000Z");
    const second = makeObservation("#CLAN", "2026-11-20T01:00:00.000Z", "#CLAN-new-roster");
    const { service } = serviceWithRows([first, second]);
    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation).toMatchObject({
      coverageStatus: "VERIFIED",
      selectedObservationCount: 1,
      supersededObservationCount: 1,
      excludedObservationCount: 0,
    });
    expect(artifact.observationAggregation?.selectedObservations[0]?.observationId).toBe(second.id);
    expect(artifact.observationAggregation?.lineage.map((row) => row.selectionStatus)).toEqual(["SUPERSEDED", "SELECTED"]);
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
  });

  it("uses the quality revision as-of the cutoff and never falls back after a later contradiction", async () => {
    const observation = makeObservation("#QUALITY", "2026-11-19T01:00:00.000Z", "#QUALITY-roster", [
      makeEvidence("#QUALITY", "2026-11-19T02:00:00.000Z", "bad", { structuralStatus: "CONFLICTING", sourceQualityReasonCodes: ["parser_rejected"] }),
      makeEvidence("#QUALITY", "2026-11-20T02:00:00.000Z", "clean"),
    ]);
    const { service } = serviceWithRows([observation]);
    const beforeCorrection = await service.generate({ evaluationAt: "2026-11-19T12:00:00.000Z", eraPolicy, sampleThreshold: 1 });
    expect(beforeCorrection.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("quality_conflict");
    expect(beforeCorrection.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);

    const afterCorrection = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(afterCorrection.observationAggregation?.selectedObservations[0]?.status).toBe("QUALIFYING");
    expect(afterCorrection.observationAggregation?.selectedObservations[0]?.qualityFingerprint).toBe("clean");
  });

  it("retains parser-rejected-row quality evidence without multiplying the semantic sample", async () => {
    const observation = makeObservation("#PARSER", "2026-11-19T01:00:00.000Z", "#PARSER-roster", [
      makeEvidence("#PARSER", "2026-11-19T02:00:00.000Z", "extra-row", { parserRejectedRowCount: 1, discardedRowCount: 1, structuralStatus: "CONFLICTING", rosterCompletenessStatus: "CONFLICTING", weightStatus: "CONFLICTING", sourceQualityReasonCodes: ["discarded_row", "parser_rejected"] }),
      makeEvidence("#PARSER", "2026-11-20T02:00:00.000Z", "clean"),
    ]);
    const { service } = serviceWithRows([observation]);
    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.selectedObservationCount).toBe(1);
    expect(artifact.observationAggregation?.qualityEvidenceRevisionCount).toBe(2);
    expect(artifact.observationAggregation?.selectedObservations[0]?.qualityFingerprint).toBe("clean");
  });

  it("accepts zero weights as missing evidence and uses shared inference", async () => {
    const observation = makeObservation("#ZERO", "2026-11-19T01:00:00.000Z");
    observation.members[0]!.rawWeight = 0;
    observation.qualityEvidence[0]!.weightStatus = "UNAVAILABLE";
    observation.qualityEvidence[0]!.sourceQualityReasonCodes = ["exact_war_binding_unavailable", "source_generation_unbound"];
    const { service } = serviceWithRows([observation]);
    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    const supported = artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED");
    expect(supported?.resolvedWeightCounts).toEqual({ RAW: 49, DEFERRED: 0, ESTIMATED: 1, UNRESOLVED: 0 });
  });

  it("fails closed on equal-time semantic ambiguity and bounded read truncation", async () => {
    const equalA = makeObservation("#AMBIGUOUS", "2026-11-19T01:00:00.000Z", "a");
    const equalB = { ...makeObservation("#AMBIGUOUS", "2026-11-19T01:00:00.000Z", "b"), id: "#AMBIGUOUS-observation-b" };
    const ambiguous = await serviceWithRows([equalA, equalB]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(ambiguous.observationAggregation?.coverageStatus).toBe("AMBIGUOUS");
    expect(ambiguous.diagnostics.every((diagnostic) => diagnostic.observedCandidateCount === 0)).toBe(true);

    const repeated = Array.from({ length: NATIVE_OBSERVATION_READ_LIMIT + 1 }, (_, index) => ({
      ...makeObservation(`#TRUNCATED${index}`, "2026-11-19T01:00:00.000Z"),
      id: `truncated-${index}`,
    }));
    const truncated = await serviceWithRows(repeated).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(truncated.observationAggregation?.coverageStatus).toBe("TRUNCATED");
    expect(truncated.diagnostics.every((diagnostic) => diagnostic.observedCandidateCount === 0)).toBe(true);
  });

  it("is read-only and issues one bounded observation query", async () => {
    const { service, findMany } = serviceWithRows([]);
    const artifact = await service.generate({ evaluationAt, eraPolicy });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: NATIVE_OBSERVATION_READ_LIMIT + 1,
      where: expect.objectContaining({ sourceWarNo: 1 }),
    }));
    expect(artifact.sourceCategory).toBe("retained_fwa_observations");
  });
});
