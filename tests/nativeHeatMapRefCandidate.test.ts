import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  generateNativeHeatMapRefCandidate,
  computeNativeReferenceBucketDefinitionFingerprint,
  computeNativeReferenceCandidateContentFingerprint,
  NATIVE_REFERENCE_BUCKET_REGISTRY,
  normalizeNativeReferenceAverageCountsForTest,
  validateNativeReferenceCandidateArtifact,
  type NativeReferenceSourceRoster,
} from "../src/helper/nativeHeatMapRefCandidate";
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

  it("requires independently verified FWA identity and rejects stale, future, mixed, or unsupported source evidence", () => {
    const unavailable = makeRoster({ clanTag: "#UNAVAILABLE", weightForPosition: () => 181_000 });
    expect(generate([{ ...unavailable, sourceIdentityStatus: "UNAVAILABLE" }]).unknownReason).toBe("rejected_source_evidence");

    const nonFwa = makeRoster({ clanTag: "#BLMM", weightForPosition: () => 181_000 });
    expect(generate([{ ...nonFwa, sourceMatchType: "CLAN_WAR_LEAGUE" }]).exclusionCounts.source_metadata).toBe(1);

    const future = makeRoster({ clanTag: "#FUTURETIME", weightForPosition: () => 181_000 });
    future.sourceUpdatedAt = "2026-11-21T01:00:00.000Z";
    expect(generate([future]).exclusionCounts.source_metadata).toBe(1);

    const unsupportedState = makeRoster({ clanTag: "#UNSUPPORTEDSTATE", weightForPosition: () => 181_000 });
    unsupportedState.sourceWarState = "cancelled";
    expect(generate([unsupportedState]).exclusionCounts.source_metadata).toBe(1);

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
    expect(rejectedArtifact.unknownReason).toBe("rejected_source_evidence");
    expect(rejectedArtifact.diagnostics.find((diagnostic) => diagnostic.sourceObservationCount > 0)?.reasonCode).toBe("invalid_evidence");
    expect(generate([makeRoster({ clanTag: "#SHORT", weightForPosition: () => 181_000 })]).unknownReason).toBe("insufficient_source_support");
  });

  it("honors the cutoff and rejects an explicitly invalid threshold", () => {
    const rosters = Array.from({ length: 9 }, (_, index) => makeRoster({ clanTag: `#CUTOFF${index}`, weightForPosition: () => 181_000 }));
    expect(generate(rosters).overallStatus).toBe("UNKNOWN");
    expect(generate(rosters, 9).diagnostics.some((diagnostic) => diagnostic.status === "SUPPORTED")).toBe(true);
    expect(generate(rosters, 0).unknownReason).toBe("invalid_sample_threshold");
  });

  it("rejects imputation, malformed weights, duplicate identities, and duplicate positions", () => {
    const imputed = generate([makeRoster({
      clanTag: "#IMPUTED",
      weightForPosition: () => 181_000,
      effectiveWeightStatus: "FILLED_FROM_LOWER_BLOCK",
    })]);
    expect(imputed.exclusionCounts.imputed_weight).toBe(1);

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

  it("rejects incomplete, contradictory, stale, and repeated source evidence", () => {
    const incomplete = makeRoster({ clanTag: "#INCOMPLETE", weightForPosition: () => 181_000 });
    (incomplete as { members: NativeReferenceSourceRoster["members"] }).members = incomplete.members.slice(0, 49);
    expect(generate([incomplete]).exclusionCounts.roster_size).toBe(1);

    const wrongClan = makeRoster({ clanTag: "#ROSTER", weightForPosition: () => 181_000 });
    (wrongClan.members[0] as { clanTag: string }).clanTag = "#OTHER";
    expect(generate([wrongClan]).exclusionCounts.member_roster_mismatch).toBe(1);

    const stale = makeRoster({
      clanTag: "#STALE",
      weightForPosition: () => 181_000,
      sourceWarStartTime: "2026-10-20T00:00:00.000Z",
    });
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
    expect(Object.keys(service)).toEqual(["db"]);
  });

  it("runs the fixture diagnostic CLI without touching the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "native-ref-cli-"));
    const fixturePath = join(directory, "empty.json");
    writeFileSync(fixturePath, JSON.stringify({ rosters: [] }), "utf8");
    const scriptPath = join(process.cwd(), "src", "scripts", "diagnoseNativeHeatMapRef.ts");
    try {
      const valid = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), scriptPath, "--fixture", fixturePath, "--evaluation-at", evaluationAt, "--era-start", eraPolicy.eraStartIso, "--era-end", eraPolicy.eraEndIso], { encoding: "utf8" });
      expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);
      expect(valid.stdout).toContain('"sourceCategory": "synthetic_fixture"');
      expect(valid.stdout).toContain('"evidenceTrust": "synthetic_untrusted"');

      const strict = spawnSync(process.execPath, ["-r", require.resolve("ts-node/register"), scriptPath, "--fixture", fixturePath, "--evaluation-at", evaluationAt, "--era-start", eraPolicy.eraStartIso, "--era-end", eraPolicy.eraEndIso, "--not-an-option"], { encoding: "utf8" });
      expect(strict.status).not.toBe(0);
      expect(`${strict.stdout}\n${strict.stderr}`).not.toContain("Can't reach database");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

