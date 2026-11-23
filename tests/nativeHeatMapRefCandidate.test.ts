import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  generateNativeHeatMapRefCandidate,
  computeNativeReferenceBucketDefinitionFingerprint,
  computeNativeReferenceCandidateContentFingerprint,
  NativeReferenceCandidateConfigurationError,
  NATIVE_REFERENCE_BUCKET_REGISTRY,
  normalizeNativeReferenceAverageCountsForTest,
  validateNativeReferenceCandidateArtifact,
  type NativeReferenceSourceRoster,
} from "../src/helper/nativeHeatMapRefCandidate";
import { resolveFwaWeightRows } from "../src/helper/fwaWeightResolution";
import { NativeHeatMapRefCandidateService } from "../src/services/NativeHeatMapRefCandidateService";
import { getCompoWarWeightBucket } from "../src/helper/compoWarWeightBuckets";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";

const evaluationAt = "2026-11-21T00:00:00.000Z";
const eraPolicy = {
  policyId: "fixture-current-era",
  policyVersion: "explicit-window-v1",
  eraStartIso: "2026-11-01T00:00:00.000Z",
  eraEndIso: "2026-11-30T23:59:59.999Z",
};
const bands = HEAT_MAP_REF_SEED_ROWS.map((row) => ({
  weightMinInclusive: row.weightMinInclusive,
  weightMaxInclusive: row.weightMaxInclusive,
}));

function makeRoster(input: {
  clanTag: string;
  weightForPosition: (position: number) => number;
  effectiveWeightStatus?: string;
  playerTagForPosition?: (position: number) => string;
  positionForPosition?: (position: number) => number;
  sourceWarStartTime?: string;
}): NativeReferenceSourceRoster {
  const members = Array.from({ length: 50 }, (_, index) => {
    const position = index + 1;
    const weight = input.weightForPosition(position);
    return {
      clanTag: input.clanTag,
      playerTag: input.playerTagForPosition?.(position) ?? `#PLAYER${position}`,
      position: input.positionForPosition?.(position) ?? position,
      townHall: 12,
      rawWeight: weight,
      effectiveWeight: weight,
      effectiveWeightStatus: input.effectiveWeightStatus ?? "RAW",
    };
  });
  const totalWeight = members.reduce((sum, member) => sum + (member.effectiveWeight ?? 0), 0);
  return {
    clanTag: input.clanTag,
    rosterSize: 50,
    totalRawWeight: totalWeight,
    totalEffectiveWeight: totalWeight,
    observedAt: "2026-11-21T00:00:00.000Z",
    sourceUpdatedAt: "2026-11-20T23:00:00.000Z",
    sourceWarId: 100,
    sourceWarStartTime: input.sourceWarStartTime ?? "2026-11-20T00:00:00.000Z",
    sourceWarEndTime: "2026-11-21T00:00:00.000Z",
    sourceWarState: "warEnded",
    sourceCurrentWarUpdatedAt: "2026-11-20T23:30:00.000Z",
    sourceIdentityStatus: "VERIFIED",
    sourceMatchType: "FWA",
    sourceMemberCompletenessStatus: "VERIFIED",
    members,
  };
}

function generate(rosters: readonly NativeReferenceSourceRoster[], threshold = 10) {
  return generateNativeHeatMapRefCandidate({
    sourceRosters: rosters,
    bandDefinitions: bands,
    eraPolicy,
    evaluationAt,
    sampleThreshold: threshold,
  });
}

function makeRosterFromRawWeights(input: {
  clanTag: string;
  rawWeights: number[];
  deferredWeights?: Record<number, number>;
}): NativeReferenceSourceRoster {
  const base = makeRoster({ clanTag: input.clanTag, weightForPosition: () => 181_000 });
  const members = base.members.map((member, index) => ({
    ...member,
    rawWeight: input.rawWeights[index] ?? 0,
    deferredWeight: input.deferredWeights?.[index + 1] ?? null,
  }));
  const resolved = resolveFwaWeightRows(members);
  return {
    ...base,
    totalRawWeight: members.reduce((sum, member) => sum + (member.rawWeight > 0 ? member.rawWeight : 0), 0),
    totalEffectiveWeight: resolved.every((member) => member.effectiveWeight !== null)
      ? resolved.reduce((sum, member) => sum + (member.effectiveWeight ?? 0), 0)
      : null,
    members: resolved.map((member) => ({
      ...member,
      effectiveWeight: member.effectiveWeight,
      effectiveWeightStatus: member.effectiveWeightStatus,
    })),
  };
}

function roundTripArtifact(artifact: unknown) {
  return JSON.parse(JSON.stringify(artifact)) as unknown;
}

describe("native HeatMapRef candidate generation", () => {
  it("keeps TH19 boundaries and distinguishes actual Town Hall from weight bucket", () => {
    expect(getCompoWarWeightBucket(181_000)).toBe("TH19");
    expect(getCompoWarWeightBucket(190_000)).toBe("TH19");
    const artifact = generate(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#MIX${index}`,
      weightForPosition: (position) => position <= 10 ? 181_000 : 171_000,
    })));
    const supported = artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED");
    expect(supported?.th19ContainingRosterCount).toBe(10);
    expect(supported?.normalizedTargets.find((target) => target.bucketId === "TH19")?.targetCount).toBe(10);
    expect(supported?.normalizedTargets.find((target) => target.bucketId === "TH18")?.targetCount).toBe(40);
  });

  it("returns explicit zero for a supported band without manufacturing TH19", () => {
    const artifact = generate(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#TH18${index}`,
      weightForPosition: () => 171_000,
    })));
    const target = artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.normalizedTargets
      .find((candidate) => candidate.bucketId === "TH19");
    expect(target).toMatchObject({ status: "SUPPORTED", countStatus: "EXPLICIT_ZERO", targetCount: 0 });
  });

  it("marks observed-but-rounded-away counts separately from factual zero", () => {
    const rosters = [makeRoster({
      clanTag: "#ROUNDED0",
      weightForPosition: (position) => position === 1 ? 181_000 : 171_000,
    }), ...Array.from({ length: 9 }, (_, index) => makeRoster({
      clanTag: `#ROUNDED${index + 1}`,
      weightForPosition: () => 171_000,
    }))];
    const target = generate(rosters).diagnostics
      .find((diagnostic) => diagnostic.status === "SUPPORTED")?.normalizedTargets
      .find((candidate) => candidate.bucketId === "TH19");
    expect(target).toMatchObject({ status: "SUPPORTED", countStatus: "ROUNDED_ZERO", observedTotal: 1, targetCount: 0 });
  });

  it("does not make unsupported TH19 or insufficient bands actionable", () => {
    const artifact = generate([makeRoster({ clanTag: "#ONE", weightForPosition: () => 181_000 })]);
    expect(artifact.overallStatus).toBe("UNKNOWN");
    expect(artifact.unknownReason).toBe("insufficient_source_support");
    expect(artifact.diagnostics.every((diagnostic) => diagnostic.status === "UNKNOWN")).toBe(true);
    expect(artifact.diagnostics.flatMap((diagnostic) => diagnostic.normalizedTargets)
      .every((target) => target.targetCount === null)).toBe(true);
  });

  it("accepts absent source attestation but rejects explicit non-FWA and malformed WarMembers evidence", () => {
    const unavailable = makeRoster({ clanTag: "#UNAVAILABLE", weightForPosition: () => 181_000 });
    expect(generate([{ ...unavailable, sourceIdentityStatus: "UNAVAILABLE" }]).unknownReason).toBe("insufficient_source_support");

    const nonFwa = makeRoster({ clanTag: "#BLMM", weightForPosition: () => 181_000 });
    const nonFwaArtifact = generate([{ ...nonFwa, sourceMatchType: "CLAN_WAR_LEAGUE" }], 1);
    expect(nonFwaArtifact.exclusionCounts.non_fwa_source).toBe(1);
    expect(nonFwaArtifact.diagnostics.find((diagnostic) => diagnostic.observedCandidateCount > 0)).toMatchObject({
      observedCandidateCount: 1,
      qualifyingRosterCount: 0,
      usableRosterCount: 0,
      excludedRosterCount: 1,
    });
    expect(validateNativeReferenceCandidateArtifact(nonFwaArtifact)).toBe(true);

    const future = makeRoster({ clanTag: "#FUTURETIME", weightForPosition: () => 181_000 });
    future.sourceUpdatedAt = "2026-11-21T01:00:00.000Z";
    const staleArtifact = generate([future], 1);
    expect(staleArtifact.exclusionCounts.source_metadata).toBe(1);
    expect(staleArtifact.diagnostics.find((diagnostic) => diagnostic.observedCandidateCount > 0)).toMatchObject({
      observedCandidateCount: 1,
      qualifyingRosterCount: 0,
      usableRosterCount: 0,
      excludedRosterCount: 1,
    });
    expect(validateNativeReferenceCandidateArtifact(staleArtifact)).toBe(true);

    const outOfEra = makeRoster({ clanTag: "#STALEOBSERVATION", weightForPosition: () => 181_000 });
    outOfEra.observedAt = "2026-10-20T00:00:00.000Z";
    outOfEra.sourceUpdatedAt = "2026-10-19T23:00:00.000Z";
    const outOfEraArtifact = generate([outOfEra], 1);
    expect(outOfEraArtifact.exclusionCounts.era_policy).toBe(1);
    expect(outOfEraArtifact.diagnostics.find((diagnostic) => diagnostic.observedCandidateCount > 0)).toMatchObject({
      observedCandidateCount: 1,
      qualifyingRosterCount: 0,
      usableRosterCount: 0,
      excludedRosterCount: 1,
    });
    expect(validateNativeReferenceCandidateArtifact(outOfEraArtifact)).toBe(true);

    const unsupportedState = makeRoster({ clanTag: "#UNSUPPORTEDSTATE", weightForPosition: () => 181_000 });
    unsupportedState.sourceWarState = "cancelled";
    expect(generate([unsupportedState], 1).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);

    const mixed = makeRoster({ clanTag: "#MIXEDTIME", weightForPosition: () => 181_000 });
    mixed.members = mixed.members.map((member, index) => ({
      ...member,
      sourceSyncedAt: index === 0 ? "2026-11-20T22:00:00.000Z" : "2026-11-20T23:00:00.000Z",
    }));
    expect(generate([mixed]).exclusionCounts.source_metadata).toBe(1);
  });

  it("distinguishes no source, rejected source, and insufficient source support", () => {
    expect(generate([]).unknownReason).toBe("no_source_evidence");
    const rejected = makeRoster({ clanTag: "#REJECTED", weightForPosition: () => 181_000 });
    rejected.sourceIdentityStatus = "UNAVAILABLE";
    const rejectedArtifact = generate([rejected]);
    expect(rejectedArtifact.unknownReason).toBe("insufficient_source_support");
    expect(rejectedArtifact.diagnostics.find((diagnostic) => diagnostic.observedCandidateCount > 0)?.reasonCode).toBe("insufficient_source");
    expect(generate([makeRoster({ clanTag: "#SHORT", weightForPosition: () => 181_000 })]).unknownReason).toBe("insufficient_source_support");
  });

  it("honors the cutoff and rejects an explicitly invalid threshold", () => {
    const rosters = Array.from({ length: 9 }, (_, index) => makeRoster({ clanTag: `#CUTOFF${index}`, weightForPosition: () => 181_000 }));
    expect(generate(rosters).overallStatus).toBe("UNKNOWN");
    expect(generate(rosters, 9).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    expect(() => generate(rosters, 0)).toThrowError(NativeReferenceCandidateConfigurationError);
  });

  it("qualifies one-zero, middle-zero, trailing-zero, and leading-zero rosters using shared inference", () => {
    const rawWeights = Array.from({ length: 50 }, () => 181_000);
    rawWeights[0] = 0;
    rawWeights[9] = 0;
    rawWeights[10] = 0;
    rawWeights[11] = 0;
    rawWeights[48] = 0;
    rawWeights[49] = 0;
    const artifact = generate([makeRosterFromRawWeights({ clanTag: "#ZEROBLOCKS", rawWeights })], 1);
    const diagnostic = artifact.diagnostics.find((candidate) => candidate.status === "SUPPORTED");
    expect(diagnostic?.resolvedWeightCounts).toEqual({ RAW: 44, DEFERRED: 0, ESTIMATED: 6, UNRESOLVED: 0 });
    expect(diagnostic?.qualifyingRosterCount).toBe(1);
  });

  it("keeps one-anchor/49-estimated evidence diagnostic-only and accepts the two-anchor boundary", () => {
    const oneAnchor = makeRosterFromRawWeights({
      clanTag: "#ONEANCHOR",
      rawWeights: [181_000, ...Array.from({ length: 49 }, () => 0)],
    });
    const rejected = generate([oneAnchor], 1);
    expect(rejected.exclusionCounts.insufficient_weight_support).toBe(1);
    const rejectedDiagnostic = rejected.diagnostics.find((diagnostic) => diagnostic.observedCandidateCount > 0);
    expect(rejectedDiagnostic).toMatchObject({ usableRosterCount: 1, qualifyingRosterCount: 0, excludedRosterCount: 1 });
    expect(validateNativeReferenceCandidateArtifact(rejected)).toBe(true);

    const twoAnchors = makeRosterFromRawWeights({
      clanTag: "#TWOANCHORS",
      rawWeights: [181_000, ...Array.from({ length: 48 }, () => 0), 171_000],
    });
    const accepted = generate([twoAnchors], 1);
    expect(accepted.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 2, DEFERRED: 0, ESTIMATED: 48, UNRESOLVED: 0 });
  });

  it("uses RAW before defer, then defer before rank inference, and exposes provenance counts", () => {
    const rawWeights = Array.from({ length: 50 }, () => 181_000);
    rawWeights[0] = 0;
    rawWeights[1] = 0;
    const artifact = generate([makeRosterFromRawWeights({
      clanTag: "#MIXEDPROVENANCE",
      rawWeights,
      deferredWeights: { 1: 190_000, 2: 170_000 },
    })], 1);
    const diagnostic = artifact.diagnostics.find((candidate) => candidate.status === "SUPPORTED");
    expect(diagnostic?.resolvedWeightCounts).toEqual({ RAW: 48, DEFERRED: 2, ESTIMATED: 0, UNRESOLVED: 0 });

    const rawWins = makeRosterFromRawWeights({
      clanTag: "#RAWWINS",
      rawWeights: Array.from({ length: 50 }, () => 181_000),
      deferredWeights: { 1: 170_000 },
    });
    expect(generate([rawWins], 1).diagnostics.find((candidate) => candidate.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 50, DEFERRED: 0, ESTIMATED: 0, UNRESOLVED: 0 });
  });

  it("excludes all-zero/unresolvable and unsupported effective rosters with truthful reasons", () => {
    const unresolved = makeRosterFromRawWeights({ clanTag: "#ALLZERO", rawWeights: Array.from({ length: 50 }, () => 0) });
    const unresolvedArtifact = generate([unresolved], 1);
    expect(unresolvedArtifact.exclusionCounts.unresolved_weight).toBe(1);

    const unsupportedWeights = Array.from({ length: 50 }, () => 181_000);
    unsupportedWeights[49] = 999_999;
    const unsupported = makeRosterFromRawWeights({ clanTag: "#UNSUPPORTED", rawWeights: unsupportedWeights });
    expect(generate([unsupported], 1).exclusionCounts.unsupported_weight).toBe(1);
  });

  it("rejects imputation, malformed weights, duplicate identities, and duplicate positions", () => {
    const imputed = generate([makeRoster({
      clanTag: "#IMPUTED",
      weightForPosition: () => 181_000,
      effectiveWeightStatus: "FILLED_FROM_LOWER_BLOCK",
    })]);
    expect(imputed.diagnostics.find((diagnostic) => diagnostic.qualifyingRosterCount === 1)?.resolvedWeightCounts)
      .toEqual({ RAW: 50, DEFERRED: 0, ESTIMATED: 0, UNRESOLVED: 0 });

    const fractional = makeRoster({ clanTag: "#FRACTION", weightForPosition: () => 181_000 });
    (fractional.members[0] as { rawWeight: number }).rawWeight = 181_000.5;
    const malformed = generate([fractional]);
    expect(malformed.exclusionCounts.invalid_weight).toBe(1);

    const duplicatePlayer = generate([makeRoster({
      clanTag: "#DUPPLAYER",
      weightForPosition: () => 181_000,
      playerTagForPosition: (position) => position === 50 ? "#PLAYER1" : `#PLAYER${position}`,
    })]);
    expect(duplicatePlayer.exclusionCounts.duplicate_player_identity).toBe(1);

    const duplicatePosition = generate([makeRoster({
      clanTag: "#DUPPOSITION",
      weightForPosition: () => 181_000,
      positionForPosition: (position) => position === 50 ? 49 : position,
    })]);
    expect(duplicatePosition.exclusionCounts.duplicate_position).toBe(1);
  });

  it("rejects incomplete, contradictory WarMembers evidence and repeated observations", () => {
    const incomplete = makeRoster({ clanTag: "#INCOMPLETE", weightForPosition: () => 181_000 });
    (incomplete as { members: NativeReferenceSourceRoster["members"] }).members = incomplete.members.slice(0, 49);
    expect(generate([incomplete]).exclusionCounts.roster_size).toBe(1);

    const wrongClan = makeRoster({ clanTag: "#ROSTER", weightForPosition: () => 181_000 });
    (wrongClan.members[0] as { clanTag: string }).clanTag = "#OTHER";
    expect(generate([wrongClan]).exclusionCounts.member_roster_mismatch).toBe(1);

    const stale = makeRoster({
      clanTag: "#STALE",
      weightForPosition: () => 181_000,
    });
    stale.sourceUpdatedAt = "2026-10-20T00:00:00.000Z";
    expect(generate([stale]).exclusionCounts.era_policy).toBe(1);

    const repeated = makeRoster({ clanTag: "#REPEATED", weightForPosition: () => 181_000 });
    expect(generate([repeated, repeated]).exclusionCounts.duplicate_clan_observation).toBe(2);
  });

  it("keeps each band independent and preserves deterministic normalized totals", () => {
    const th18 = Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#BAND18${index}`,
      weightForPosition: () => 161_000,
    }));
    const th19 = Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#BAND19${index}`,
      weightForPosition: () => 181_000,
    }));
    const first = generate([...th18, ...th19]);
    const second = generate([...th19].reverse().concat([...th18].reverse()));
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
    for (const diagnostic of first.diagnostics) {
      if (diagnostic.status !== "SUPPORTED") continue;
      expect(diagnostic.normalizedTargets.reduce((sum, target) => sum + (target.targetCount ?? 0), 0)).toBe(50);
    }
    const supportedBands = first.diagnostics.filter((diagnostic) => diagnostic.status === "SUPPORTED");
    expect(supportedBands).toHaveLength(2);
  });

  it("supports future generic bucket groupings without changing the algorithm", () => {
    const futureRegistry = [
      { id: "TH19_TO_TH18", sourceBuckets: ["TH19", "TH18"] as const },
      ...NATIVE_REFERENCE_BUCKET_REGISTRY.slice(2),
    ];
    const artifact = generateNativeHeatMapRefCandidate({
      sourceRosters: Array.from({ length: 10 }, (_, index) => makeRoster({
        clanTag: `#FUTURE${index}`,
        weightForPosition: (position) => position <= 10 ? 181_000 : 171_000,
      })),
      bandDefinitions: bands,
      eraPolicy,
      evaluationAt,
      sampleThreshold: 10,
      bucketRegistry: futureRegistry,
    });
    expect(artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.th19ContainingRosterCount).toBe(10);
    expect(artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.normalizedTargets)
      .toEqual(expect.arrayContaining([expect.objectContaining({ bucketId: "TH19_TO_TH18", targetCount: 50 })]));
    expect(computeNativeReferenceBucketDefinitionFingerprint(NATIVE_REFERENCE_BUCKET_REGISTRY)).not.toBe(
      computeNativeReferenceBucketDefinitionFingerprint([...NATIVE_REFERENCE_BUCKET_REGISTRY].reverse()),
    );
  });

  it("uses largest-remainder rounding with ordered tie breaking and rejects incomplete counts", () => {
    const rounded = normalizeNativeReferenceAverageCountsForTest({
      averages: { A: 10.5, B: 10.5, C: 10.5, D: 10.5, E: 8 },
      registry: [
        { id: "A", sourceBuckets: ["TH19"] },
        { id: "B", sourceBuckets: ["TH18"] },
        { id: "C", sourceBuckets: ["TH17"] },
        { id: "D", sourceBuckets: ["TH16"] },
        { id: "E", sourceBuckets: ["TH15"] },
      ],
      targetTotal: 50,
    });
    expect(rounded.counts).toEqual({ A: 11, B: 11, C: 10, D: 10, E: 8 });
    expect(normalizeNativeReferenceAverageCountsForTest({
      averages: { A: 10, B: 10 },
      registry: [
        { id: "A", sourceBuckets: ["TH19"] },
        { id: "B", sourceBuckets: ["TH18"] },
      ],
      targetTotal: 50,
    }).invalidReason).toContain("incomplete");
  });

  it("fails closed for malformed candidate versions and keeps the service read-only", async () => {
    const artifact = generate(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#VALIDATE${index}`,
      weightForPosition: () => 181_000,
    })));
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
    expect(validateNativeReferenceCandidateArtifact({ ...artifact, profileVersion: "native-reference-v0" })).toBe(false);
    expect(validateNativeReferenceCandidateArtifact({ ...artifact, diagnostics: [] })).toBe(false);

    const { contentFingerprint: _contentFingerprint, ...missingDiagnostics } = { ...artifact, diagnostics: [] };
    expect(validateNativeReferenceCandidateArtifact({
      ...missingDiagnostics,
      contentFingerprint: computeNativeReferenceCandidateContentFingerprint(missingDiagnostics),
    })).toBe(false);

    const contradictoryDiagnostics = artifact.diagnostics.map((diagnostic) => diagnostic.status === "SUPPORTED"
      ? {
          ...diagnostic,
          normalizedTargets: diagnostic.normalizedTargets.map((target, index) => index === 0
            ? { ...target, targetCount: (target.targetCount ?? 0) + 1 }
            : target),
        }
      : diagnostic);
    const { contentFingerprint: _validContentFingerprint, ...contradictoryPayload } = { ...artifact, diagnostics: contradictoryDiagnostics };
    expect(validateNativeReferenceCandidateArtifact({
      ...contradictoryPayload,
      contentFingerprint: computeNativeReferenceCandidateContentFingerprint(contradictoryPayload),
    })).toBe(false);

    expect(computeNativeReferenceBucketDefinitionFingerprint()).not.toBe(
      computeNativeReferenceBucketDefinitionFingerprint(undefined, [{ bucket: "TH19", minInclusive: 181001, maxInclusive: 190000 }]),
    );

    const findMany = vi.fn().mockResolvedValue([]);
    const service = new NativeHeatMapRefCandidateService({
      fwaTrackedClanWarRosterCurrent: { findMany },
    } as never);
    const report = await service.generate({ evaluationAt, eraPolicy });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(report.overallStatus).toBe("UNKNOWN");
    expect(Object.keys(service)).toEqual(["db", "readDeferredWeights"]);
  });

  it("rejects rehashed semantic contradictions and persisted-unverified support", () => {
    const artifact = generate(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#SEMANTIC${index}`,
      weightForPosition: (position) => position <= 5 ? 181_000 : 171_000,
    })));
    expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
    const rehash = (value: Record<string, unknown>) => {
      const { contentFingerprint: _old, ...payload } = value;
      return { ...payload, contentFingerprint: computeNativeReferenceCandidateContentFingerprint(payload as never) };
    };
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      sourceCategory: "persisted_fwa_snapshot",
      evidenceTrust: "persisted_unverified_source_binding",
    }))).toBe(false);
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      sourceAuthority: {
        ...artifact.sourceAuthority,
        referencePublicationStatus: "VERIFIED",
      },
    }))).toBe(false);

    const supportedDiagnostic = artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED");
    expect(supportedDiagnostic).toBeDefined();
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic === supportedDiagnostic
        ? { ...diagnostic, qualifyingRosterCount: 0, distinctQualifyingClanCount: 0 }
        : diagnostic),
    }))).toBe(false);
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic === supportedDiagnostic
        ? {
            ...diagnostic,
            resolvedWeightCounts: {
              ...diagnostic.resolvedWeightCounts,
              RAW: diagnostic.resolvedWeightCounts.RAW - 1,
              UNRESOLVED: diagnostic.resolvedWeightCounts.UNRESOLVED + 1,
            },
          }
        : diagnostic),
    }))).toBe(false);
    const oneAnchorArtifact = generate([makeRosterFromRawWeights({
      clanTag: "#SEMANTICONEANCHOR",
      rawWeights: [181_000, ...Array.from({ length: 49 }, () => 0)],
    })], 1);
    expect(validateNativeReferenceCandidateArtifact(oneAnchorArtifact)).toBe(true);
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...oneAnchorArtifact,
      diagnostics: oneAnchorArtifact.diagnostics.map((diagnostic) => diagnostic.usableRosterCount > 0
        ? { ...diagnostic, usableRosterCount: 0 }
        : diagnostic),
    }))).toBe(false);

    const contradictoryTargets = artifact.diagnostics.map((diagnostic) => {
      if (diagnostic.status !== "SUPPORTED") return diagnostic;
      const positive = diagnostic.normalizedTargets
        .map((target, index) => ({ target, index }))
        .filter(({ target }) => (target.targetCount ?? 0) > 0);
      const first = positive[0];
      const second = positive[1];
      if (!first || !second) return diagnostic;
      return {
        ...diagnostic,
        normalizedTargets: diagnostic.normalizedTargets.map((target, index) =>
          index === first.index ? { ...target, targetCount: (target.targetCount ?? 0) + 1 }
            : index === second.index ? { ...target, targetCount: (target.targetCount ?? 0) - 1 }
              : target),
      };
    });
    expect(validateNativeReferenceCandidateArtifact(rehash({ ...artifact, diagnostics: contradictoryTargets }))).toBe(false);
    expect(validateNativeReferenceCandidateArtifact(rehash({ ...artifact, overallStatus: "UNKNOWN" }))).toBe(false);
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic.status === "SUPPORTED"
        ? { ...diagnostic, observedBucketTotals: { ...diagnostic.observedBucketTotals, EXTRA: 0 } }
        : diagnostic),
    }))).toBe(false);
    expect(() => validateNativeReferenceCandidateArtifact({ ...artifact, bucketRegistry: null })).not.toThrow();
    expect(validateNativeReferenceCandidateArtifact({ ...artifact, bucketRegistry: null })).toBe(false);
    const nullTarget = artifact.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      normalizedTargets: [null, ...diagnostic.normalizedTargets.slice(1)],
    }));
    expect(() => validateNativeReferenceCandidateArtifact({ ...artifact, diagnostics: nullTarget })).not.toThrow();
    expect(validateNativeReferenceCandidateArtifact({ ...artifact, diagnostics: nullTarget })).toBe(false);
  });

  it("round-trips every generator evidence state through JSON and validates its own output", () => {
    const rejected = makeRoster({ clanTag: "#ROUNDREJECTED", weightForPosition: () => 181_000 });
    rejected.sourceIdentityStatus = "UNAVAILABLE";
    const stale = makeRoster({ clanTag: "#ROUNDSTALE", weightForPosition: () => 181_000, sourceWarStartTime: "2026-10-20T00:00:00.000Z" });
    const future = makeRoster({ clanTag: "#ROUNDFUTURE", weightForPosition: () => 181_000 });
    future.sourceUpdatedAt = "2026-11-21T01:00:00.000Z";
    const valid = makeRoster({ clanTag: "#ROUNDVALID", weightForPosition: () => 181_000 });
    const supported = Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#ROUNDSUPPORTED${index}`,
      weightForPosition: () => 181_000,
    }));
    const partial = [
      ...Array.from({ length: 10 }, (_, index) => makeRoster({
        clanTag: `#ROUNDPARTIAL${index}`,
        weightForPosition: () => 181_000,
      })),
      makeRoster({ clanTag: "#ROUNDPARTIALSTALE", weightForPosition: () => 181_000, sourceWarStartTime: "2026-10-20T00:00:00.000Z" }),
    ];
    const persistedRosters = Array.from({ length: 10 }, (_, index) => {
      const roster = makeRoster({ clanTag: `#ROUNDPERSISTED${index}`, weightForPosition: () => 181_000 });
      roster.sourceIdentityStatus = "UNAVAILABLE";
      return roster;
    });
    const artifacts = [
      generate([]),
      generate([rejected]),
      generate([stale]),
      generate([future]),
      generate([valid]),
      generate(supported),
      generate(partial),
      generateNativeHeatMapRefCandidate({
        sourceRosters: persistedRosters,
        bandDefinitions: bands,
        eraPolicy,
        evaluationAt,
        sourceCategory: "persisted_fwa_snapshot",
        evidenceTrust: "persisted_unverified_source_binding",
      }),
    ];
    for (const artifact of artifacts) {
      expect(validateNativeReferenceCandidateArtifact(artifact)).toBe(true);
      expect(validateNativeReferenceCandidateArtifact(roundTripArtifact(artifact))).toBe(true);
    }
    expect(artifacts[0]?.unknownReason).toBe("no_source_evidence");
    expect(artifacts[1]?.unknownReason).toBe("insufficient_source_support");
    expect(artifacts[2]?.unknownReason).toBe("insufficient_source_support");
    expect(artifacts[3]?.unknownReason).toBe("rejected_source_evidence");
    expect(artifacts[4]?.unknownReason).toBe("insufficient_source_support");
    expect(artifacts[5]?.overallStatus).toBe("PARTIAL");
    expect(artifacts[6]?.overallStatus).toBe("PARTIAL");
    expect(artifacts[7]?.overallStatus).toBe("PARTIAL");
  });

  it("rejects rehashed accounting and derived-reason contradictions", () => {
    const artifact = generate(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#ACCOUNTING${index}`,
      weightForPosition: () => 181_000,
    })));
    const rehash = (value: Record<string, unknown>) => {
      const { contentFingerprint: _old, ...payload } = value;
      return { ...payload, contentFingerprint: computeNativeReferenceCandidateContentFingerprint(payload as never) };
    };
    const supported = artifact.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED");
    expect(supported).toBeDefined();
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic === supported
        ? { ...diagnostic, observedCandidateCount: diagnostic.qualifyingRosterCount + 1 }
        : diagnostic),
    }))).toBe(false);
    expect(validateNativeReferenceCandidateArtifact(rehash({
      ...artifact,
      diagnostics: artifact.diagnostics.map((diagnostic) => diagnostic === supported
        ? { ...diagnostic, status: "UNKNOWN", reasonCode: "insufficient_source" }
        : diagnostic),
    }))).toBe(false);
  });

  it("canonicalizes conflicting duplicate rosters and members independent of input order", () => {
    const first = makeRoster({ clanTag: "#CONFLICT", weightForPosition: () => 181_000 });
    const second = makeRoster({ clanTag: "#CONFLICT", weightForPosition: (position) => position === 1 ? 171_000 : 181_000 });
    const firstReversed = { ...first, members: [...first.members].reverse() };
    const secondReversed = { ...second, members: [...second.members].reverse() };
    const left = generate([first, secondReversed]);
    const right = generate([second, firstReversed]);
    expect(left.sourceEvidenceFingerprint).toBe(right.sourceEvidenceFingerprint);
    expect(left.contentFingerprint).toBe(right.contentFingerprint);
    expect(left.exclusions).toEqual(right.exclusions);
  });

  it("ignores unrelated CurrentWar metadata but checks WarMembers observation timing", () => {
    const notInWar = makeRoster({ clanTag: "#NOTINWAR", weightForPosition: () => 181_000 });
    notInWar.sourceWarState = "notInWar";
    const fullyQualifying = generate([notInWar], 1);
    expect(fullyQualifying.diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    expect(fullyQualifying.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")).toMatchObject({
      observedCandidateCount: 1,
      qualifyingRosterCount: 1,
      usableRosterCount: 1,
      excludedRosterCount: 0,
    });
    const activeWithEnd = makeRoster({ clanTag: "#ACTIVEEND", weightForPosition: () => 181_000 });
    activeWithEnd.sourceWarState = "inWar";
    expect(generate([activeWithEnd], 1).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    activeWithEnd.sourceWarEndTime = "2026-11-21T01:00:00.000Z";
    expect(generate([activeWithEnd], 1).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    const missingCurrentWarTimestamp = makeRoster({ clanTag: "#MISSINGCURRENT", weightForPosition: () => 181_000 });
    missingCurrentWarTimestamp.sourceCurrentWarUpdatedAt = null;
    missingCurrentWarTimestamp.sourceWarStartTime = "2025-01-01T00:00:00.000Z";
    expect(generate([missingCurrentWarTimestamp], 1).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    const partialMemberTiming = makeRoster({ clanTag: "#PARTIALMEMBERTIME", weightForPosition: () => 181_000 });
    partialMemberTiming.members = partialMemberTiming.members.map((member, index) => index === 0
      ? { ...member, sourceSyncedAt: "2026-11-20T23:00:00.000Z" }
      : member);
    expect(generate([partialMemberTiming]).exclusionCounts.source_metadata).toBe(1);
    const futureEnd = makeRoster({ clanTag: "#FUTUREEND", weightForPosition: () => 181_000 });
    futureEnd.sourceWarEndTime = "2026-11-22T00:00:00.000Z";
    expect(generate([futureEnd], 1).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    const nonFwa = makeRoster({ clanTag: "#NONFWA", weightForPosition: () => 181_000 });
    nonFwa.sourceMatchType = "CLAN_WAR_LEAGUE";
    expect(generate([nonFwa]).exclusionCounts.non_fwa_source).toBe(1);
  });

  it("keeps persisted candidates fail-closed without CurrentWar or WarMembers reads", async () => {
    const findMany = vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, index) => makeRoster({
      clanTag: `#PERSISTED${index}`,
      weightForPosition: () => 181_000,
    })));
    const service = new NativeHeatMapRefCandidateService({ fwaTrackedClanWarRosterCurrent: { findMany } } as never);
    const report = await service.generate({ evaluationAt, eraPolicy });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(report.sourceCategory).toBe("persisted_fwa_snapshot");
    expect(report.evidenceTrust).toBe("persisted_unverified_source_binding");
    expect(report.overallStatus).toBe("PARTIAL");
    expect(report.diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    expect(report.sourceAuthority.referencePublicationStatus).toBe("UNAVAILABLE");
  });

  it("applies only scoped open defer fallback to an existing persisted roster player", async () => {
    const row = makeRoster({ clanTag: "#DEFERCLAN", weightForPosition: () => 181_000 });
    const firstMember = row.members[0] as { rawWeight: number; effectiveWeight: number; effectiveWeightStatus: string };
    firstMember.rawWeight = 0;
    row.totalRawWeight = (row.totalRawWeight ?? 0) - 181_000;
    const findMany = vi.fn().mockResolvedValue([row]);
    const readDeferredWeights = vi.fn().mockResolvedValue(new Map([
      ["#DEFERCLAN", new Map([["#PLAYER1", { deferredWeight: 190_000, createdAt: new Date(evaluationAt) }]])],
    ]));
    const service = new NativeHeatMapRefCandidateService(
      { fwaTrackedClanWarRosterCurrent: { findMany } } as never,
      readDeferredWeights,
    );
    const report = await service.generate({
      evaluationAt,
      eraPolicy,
      sampleThreshold: 1,
      defermentScope: { guildId: "guild-1", clanTag: "#DEFERCLAN" },
    });
    expect(readDeferredWeights).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild-1",
      clanPlayerTags: [{ clanTag: "#DEFERCLAN", playerTags: expect.arrayContaining(["#PLAYER1"]) }],
    }));
    expect(report.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 49, DEFERRED: 1, ESTIMATED: 0, UNRESOLVED: 0 });
    const boundaryFingerprint = report.sourceEvidenceFingerprint;

    const noScopeReport = await service.generate({ evaluationAt, eraPolicy, sampleThreshold: 1 });
    expect(noScopeReport.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 49, DEFERRED: 0, ESTIMATED: 1, UNRESOLVED: 0 });
    expect(boundaryFingerprint).not.toBe(noScopeReport.sourceEvidenceFingerprint);

    readDeferredWeights.mockResolvedValue(new Map([
      ["#DEFERCLAN", new Map([[
        "#PLAYER1",
        { deferredWeight: 190_000, createdAt: new Date("2026-11-21T00:00:00.001Z") },
      ]])],
    ]));
    const futureReport = await service.generate({
      evaluationAt,
      eraPolicy,
      sampleThreshold: 1,
      defermentScope: { guildId: "guild-1", clanTag: "#DEFERCLAN" },
    });
    expect(futureReport.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 49, DEFERRED: 0, ESTIMATED: 1, UNRESOLVED: 0 });
    expect(futureReport.sourceEvidenceFingerprint).toBe(noScopeReport.sourceEvidenceFingerprint);

    readDeferredWeights.mockResolvedValue(new Map([
      ["#DEFERCLAN", new Map([[
        "#PLAYER1",
        { deferredWeight: 190_000, createdAt: new Date("2026-11-20T23:59:59.999Z") },
      ]])],
    ]));
    const earlierEligibleReport = await service.generate({
      evaluationAt,
      eraPolicy,
      sampleThreshold: 1,
      defermentScope: { guildId: "guild-1", clanTag: "#DEFERCLAN" },
    });
    expect(earlierEligibleReport.diagnostics.find((diagnostic) => diagnostic.status === "SUPPORTED")?.resolvedWeightCounts)
      .toEqual({ RAW: 49, DEFERRED: 1, ESTIMATED: 0, UNRESOLVED: 0 });
    expect(earlierEligibleReport.sourceEvidenceFingerprint).not.toBe(boundaryFingerprint);
    expect(readDeferredWeights).toHaveBeenCalledTimes(3);
  });

  it("runs the fixture diagnostic CLI without touching the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "native-ref-cli-"));
    const fixturePath = join(directory, "empty.json");
    const representativeFixturePath = join(directory, "representative.json");
    writeFileSync(fixturePath, JSON.stringify({ rosters: [] }), "utf8");
    const representative = makeRosterFromRawWeights({
      clanTag: "#CLIREPRESENTATIVE",
      rawWeights: [0, ...Array.from({ length: 49 }, () => 181_000)],
    });
    writeFileSync(representativeFixturePath, JSON.stringify({ rosters: Array.from({ length: 10 }, (_, index) => ({ ...representative, clanTag: `#CLIREPRESENTATIVE${index}`, members: representative.members.map((member) => ({ ...member, clanTag: `#CLIREPRESENTATIVE${index}` })) })) }), "utf8");
    const scriptPath = join(process.cwd(), "src", "scripts", "diagnoseNativeHeatMapRef.ts");
    try {
      const valid = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), scriptPath, "--fixture", fixturePath, "--evaluation-at", evaluationAt, "--era-start", eraPolicy.eraStartIso, "--era-end", eraPolicy.eraEndIso], { encoding: "utf8" });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);
      expect(valid.stdout).toContain('"sourceCategory": "synthetic_fixture"');
      expect(valid.stdout).toContain('"evidenceTrust": "synthetic_untrusted"');

      const representativeRun = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), scriptPath, "--fixture", representativeFixturePath, "--evaluation-at", evaluationAt, "--era-start", eraPolicy.eraStartIso, "--era-end", eraPolicy.eraEndIso, "--threshold", "10"], { encoding: "utf8" });
      expect(representativeRun.status, `${representativeRun.stdout}\n${representativeRun.stderr}`).toBe(0);
      expect(representativeRun.stdout).toContain('"resolvedWeightCounts"');
      expect(representativeRun.stdout).toContain('"ESTIMATED": 10');

      const strict = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), scriptPath, "--fixture", fixturePath, "--evaluation-at", evaluationAt, "--era-start", eraPolicy.eraStartIso, "--era-end", eraPolicy.eraEndIso, "--not-an-option"], { encoding: "utf8" });
      expect(strict.status).not.toBe(0);
      expect(`${strict.stdout}\n${strict.stderr}`).not.toContain("Can't reach database");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

