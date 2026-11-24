import { describe, expect, it, vi } from "vitest";
import {
  FWA_WAR_MEMBERS_EVIDENCE_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_OBSERVATION_SCHEMA_VERSION,
  FWA_WAR_MEMBERS_UNKNOWN_SOURCE_AUTHORITY,
} from "../src/services/fwa-feeds/FwaWarMembersObservationService";
import {
  computeNativeReferenceCandidateContentFingerprint,
  validateNativeReferenceCandidateArtifact,
} from "../src/helper/nativeHeatMapRefCandidate";
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

function makeMembers(clanTag: string, rawWeight = 181_000, observationId = `${clanTag}-observation`) {
  return Array.from({ length: 50 }, (_, index) => ({
    id: `${clanTag}-${index + 1}`,
    observationId,
    memberFingerprint: `${clanTag}-member-${index + 1}`,
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

function makeObservation(clanTag: string, observedAt: string, rosterFingerprint = `${clanTag}-roster`, evidence = [makeEvidence(clanTag, observedAt, `${clanTag}-quality`)], overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === "string" ? overrides.id : `${clanTag}-observation`;
  return {
    id,
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
    members: makeMembers(clanTag, 181_000, typeof overrides.id === "string" ? overrides.id : `${clanTag}-observation`),
    qualityEvidence: evidence.map((row) => ({ ...row, observationId: id })),
    ...overrides,
  };
}

function serviceWithRows(rows: unknown[], readDeferredWeights = vi.fn().mockResolvedValue(new Map())) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    findMany,
    readDeferredWeights,
    service: new NativeHeatMapRefObservationCandidateService({ fwaWarMembersObservation: { findMany } } as never, readDeferredWeights),
  };
}

describe("NativeHeatMapRefObservationCandidateService", () => {
  it("maps the exact Prisma member shape and qualifies a valid TH19 roster", async () => {
    const observation = makeObservation("#PRISMA-SHAPE", "2026-11-19T01:00:00.000Z");
    observation.members[0]!.townHall = 19;
    const { service } = serviceWithRows([observation]);

    const context = await service.generateWithContext({ evaluationAt, eraPolicy, sampleThreshold: 1 });

    expect(context.sourceRosters).toHaveLength(1);
    expect(context.sourceRosters[0]?.clanTag).toBe("#PRISMA-SHAPE");
    expect(context.sourceRosters[0]?.members[0]?.clanTag).toBe("#PRISMA-SHAPE");
    expect(context.sourceRosters[0]?.members[0]?.townHall).toBe(19);
    expect(context.artifact.diagnostics.some((diagnostic) => diagnostic.th19ContainingRosterCount === 1)).toBe(true);
  });

  it("rejects a member whose observationId does not belong to the parent observation", async () => {
    const observation = makeObservation("#OWNERSHIP", "2026-11-19T01:00:00.000Z");
    observation.members[0]!.observationId = "#OTHER-observation";
    const { service } = serviceWithRows([observation]);

    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });

    expect(artifact.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("member_ownership_mismatch");
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);
  });

  it("distinguishes an incorrect member count from ownership mismatch", async () => {
    const observation = makeObservation("#COUNT", "2026-11-19T01:00:00.000Z");
    observation.members = observation.members.slice(0, 49);
    const { service } = serviceWithRows([observation]);

    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });

    expect(artifact.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("member_count_mismatch");
  });

  it("selects one semantic observation per clan and preserves superseded lineage", async () => {
    const first = makeObservation("#CLAN", "2026-11-19T01:00:00.000Z");
    const secondEvidence = { ...makeEvidence("#CLAN", "2026-11-20T01:00:00.000Z", "#CLAN-quality-2"), id: "#CLAN-evidence-2", observationId: "#CLAN-observation-2" };
    const second = { ...makeObservation("#CLAN", "2026-11-20T01:00:00.000Z", "#CLAN-new-roster", [secondEvidence]), id: "#CLAN-observation-2" };
    second.members = second.members.map((member) => ({ ...member, observationId: second.id }));
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

  it("validates equal-time quality ambiguity as fail-closed coverage", async () => {
    const first = makeEvidence("#QUALITY-TIE", "2026-11-19T02:00:00.000Z", "tie-a");
    const second = { ...makeEvidence("#QUALITY-TIE", "2026-11-19T02:00:00.000Z", "tie-b"), id: "#QUALITY-TIE-evidence-b" };
    const artifact = await serviceWithRows([makeObservation("#QUALITY-TIE", "2026-11-19T01:00:00.000Z", "tie-roster", [first, second])]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.coverageStatus).toBe("AMBIGUOUS");
    expect(artifact.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("quality_evidence_ambiguous");
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
  });

  it("validates mixed semantic ambiguity across clans while keeping every band UNKNOWN", async () => {
    const ambiguousA = makeObservation("#AMBIGUOUS-A", "2026-11-19T01:00:00.000Z", "ambiguous-a");
    const ambiguousBEvidence = { ...makeEvidence("#AMBIGUOUS-A", "2026-11-19T01:00:00.000Z", "ambiguous-b-quality"), id: "#AMBIGUOUS-A-evidence-b", observationId: "#AMBIGUOUS-A-observation-b" };
    const ambiguousB = { ...makeObservation("#AMBIGUOUS-A", "2026-11-19T01:00:00.000Z", "ambiguous-b", [ambiguousBEvidence]), id: "#AMBIGUOUS-A-observation-b" };
    ambiguousB.members = ambiguousB.members.map((member) => ({ ...member, observationId: ambiguousB.id }));
    const unambiguous = makeObservation("#PYPY", "2026-11-19T02:00:00.000Z");
    const artifact = await serviceWithRows([ambiguousA, ambiguousB, unambiguous]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.coverageStatus).toBe("AMBIGUOUS");
    expect(artifact.observationAggregation?.selectedObservations.some((row) => row.clanTag === "#PYPY")).toBe(true);
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
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

  it("excludes parent observations ingested after the retrospective cutoff", async () => {
    const late = makeObservation("#LATE", "2026-11-19T01:00:00.000Z", "#LATE-roster", undefined, {
      ingestedAt: new Date("2026-11-22T01:00:00.000Z"),
    });
    const { service } = serviceWithRows([late]);
    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.selectedObservationCount).toBe(0);
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.observedCandidateCount === 0)).toBe(true);
  });

  it("excludes quality evidence ingested after the cutoff and fails closed on contradictory timestamps", async () => {
    const lateEvidence = makeEvidence("#QUALITY-LATE", "2026-11-20T01:00:00.000Z", "late", {
      ingestedAt: new Date("2026-11-22T01:00:00.000Z"),
    });
    const contradictoryEvidence = makeEvidence("#QUALITY-BAD", "2026-11-20T02:00:00.000Z", "contradictory", {
      ingestedAt: new Date("2026-11-20T01:00:00.000Z"),
    });
    const lateArtifact = await serviceWithRows([makeObservation("#QUALITY-LATE", "2026-11-19T01:00:00.000Z", "late-roster", [lateEvidence])]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    const contradictoryArtifact = await serviceWithRows([makeObservation("#QUALITY-BAD", "2026-11-19T01:00:00.000Z", "bad-roster", [contradictoryEvidence])]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(lateArtifact.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("quality_evidence_unavailable");
    expect(contradictoryArtifact.observationAggregation?.selectedObservations[0]?.reasonCode).toBe("quality_evidence_unavailable");
  });

  it("aggregates multiple clans while retaining first-seen semantic identity and no latest-invalid fallback", async () => {
    const cleanA = makeObservation("#CLAN-A", "2026-11-19T01:00:00.000Z");
    const cleanB = makeObservation("#CLAN-B", "2026-11-19T02:00:00.000Z");
    const invalidLatest = makeObservation("#CLAN-A", "2026-11-20T01:00:00.000Z", "#CLAN-A-new", [
      makeEvidence("#CLAN-A", "2026-11-20T01:00:00.000Z", "invalid", { structuralStatus: "CONFLICTING", sourceQualityReasonCodes: ["parser_rejected"] }),
    ]);
    invalidLatest.id = "#CLAN-A-observation-2";
    invalidLatest.members = invalidLatest.members.map((member) => ({ ...member, observationId: invalidLatest.id }));
    const { service } = serviceWithRows([cleanA, cleanB, invalidLatest]);
    const artifact = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.selectedObservationCount).toBe(2);
    expect(artifact.observationAggregation?.selectedObservations.find((row) => row.clanTag === "#CLAN-A")?.status).toBe("EXCLUDED");
    expect(artifact.observationAggregation?.selectedObservations.find((row) => row.clanTag === "#CLAN-A")?.reasonCode).toBe("quality_conflict");
    expect(artifact.observationAggregation?.selectedObservations.find((row) => row.clanTag === "#CLAN-B")?.status).toBe("QUALIFYING");
  });

  it("passes the retrospective deferment window before scope precedence", async () => {
    const readDeferredWeights = vi.fn().mockResolvedValue(new Map([
      ["#DEFER", new Map([["#PLAYER1", { deferredWeight: 181_000, createdAt: new Date("2026-11-20T01:00:00.000Z") }]])],
    ]));
    const { service } = serviceWithRows([makeObservation("#DEFER", "2026-11-19T01:00:00.000Z")], readDeferredWeights);
    await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1, defermentScope: { guildId: "guild-1", clanTag: "#DEFER" } });
    expect(readDeferredWeights).toHaveBeenCalledWith(expect.objectContaining({
      createdAtWindow: { from: new Date(eraPolicy.eraStartIso), through: evaluationAt },
    }));
  });

  it("rejects tampered retained aggregation metadata even after checksum recomputation", async () => {
    const artifact = await serviceWithRows([makeObservation("#TAMPER", "2026-11-19T01:00:00.000Z")]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    const { contentFingerprint: _fingerprint, ...payload } = artifact;
    const missingMetadata = { ...payload, observationAggregation: undefined };
    expect(validateNativeReferenceCandidateArtifact({ ...missingMetadata, contentFingerprint: computeNativeReferenceCandidateContentFingerprint(missingMetadata as never) })).toBe(false);
    const malformedMetadata = {
      ...artifact,
      observationAggregation: {
        ...artifact.observationAggregation!,
        selectedObservationCount: 99,
      },
    };
    const { contentFingerprint: _malformedFingerprint, ...malformedPayload } = malformedMetadata;
    expect(validateNativeReferenceCandidateArtifact({ ...malformedPayload, contentFingerprint: computeNativeReferenceCandidateContentFingerprint(malformedPayload as never) })).toBe(false);

    const tamperedEvidence = { ...makeEvidence("#TAMPER-AMBIGUOUS", "2026-11-19T01:00:00.000Z", "b-quality"), id: "#TAMPER-AMBIGUOUS-evidence-b", observationId: "#TAMPER-AMBIGUOUS-observation-2" };
    const ambiguous = await serviceWithRows([makeObservation("#TAMPER-AMBIGUOUS", "2026-11-19T01:00:00.000Z", "a"), { ...makeObservation("#TAMPER-AMBIGUOUS", "2026-11-19T01:00:00.000Z", "b", [tamperedEvidence]), id: "#TAMPER-AMBIGUOUS-observation-2" }]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    const tamperedAmbiguity = {
      ...ambiguous,
      observationAggregation: {
        ...ambiguous.observationAggregation!,
        coverageStatus: "VERIFIED" as const,
      },
    };
    const { contentFingerprint: _tamperedAmbiguityFingerprint, ...tamperedAmbiguityPayload } = tamperedAmbiguity;
    expect(validateNativeReferenceCandidateArtifact({ ...tamperedAmbiguityPayload, contentFingerprint: computeNativeReferenceCandidateContentFingerprint(tamperedAmbiguityPayload as never) })).toBe(false);
  });

  it("keeps future-ingested quality revisions out of earlier lineage and fingerprints", async () => {
    const current = makeEvidence("#AS-OF", "2026-11-19T02:00:00.000Z", "current");
    const future = { ...makeEvidence("#AS-OF", "2026-11-20T02:00:00.000Z", "future"), ingestedAt: new Date("2026-11-22T01:00:00.000Z"), id: "#AS-OF-evidence-future" };
    const base = await serviceWithRows([makeObservation("#AS-OF", "2026-11-19T01:00:00.000Z", "as-of-roster", [current])]).service.generate({ evaluationAt: "2026-11-21T00:00:00.000Z", eraPolicy, sampleThreshold: 1 });
    const withFuture = await serviceWithRows([makeObservation("#AS-OF", "2026-11-19T01:00:00.000Z", "as-of-roster", [current, future])]).service.generate({ evaluationAt: "2026-11-21T00:00:00.000Z", eraPolicy, sampleThreshold: 1 });
    expect(withFuture).toEqual(base);
  });

  it("fails closed instead of falling back to an older roster behind an available malformed observation", async () => {
    const older = makeObservation("#MALFORMED", "2026-11-19T01:00:00.000Z", "older");
    const malformed = {
      ...makeObservation("#MALFORMED", "2026-11-20T01:00:00.000Z", "newer-malformed"),
      id: "#MALFORMED-observation-2",
      firstObservedAt: new Date("2026-11-20T02:00:00.000Z"),
      observedAt: new Date("2026-11-22T01:00:00.000Z"),
      ingestedAt: new Date("2026-11-20T03:00:00.000Z"),
    };
    const artifact = await serviceWithRows([older, malformed]).service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(artifact.observationAggregation?.coverageStatus).toBe("AMBIGUOUS");
    expect(artifact.observationAggregation?.selectedObservationCount).toBe(0);
    expect(artifact.observationAggregation?.authorityLimitations).toContain("malformed_observation_available_as_of_cutoff");
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
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
