import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildNativeHeatMapReferencePreview,
  classifyNativePublicationRetry,
  NATIVE_REFERENCE_POLICY_VERSION,
  validatePublishableCandidate,
} from "../src/services/NativeHeatMapReferencePublicationService";
import {
  generateNativeHeatMapRefCandidate,
  NATIVE_REFERENCE_BUCKET_REGISTRY,
  type NativeReferenceSourceRoster,
} from "../src/helper/nativeHeatMapRefCandidate";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";
import { NATIVE_PROVISIONAL_COMPOSITION_PROFILE } from "../src/helper/compoCalculationProfile";
import { parseArgs } from "../src/scripts/nativeHeatMapReference";

const eraPolicy = {
  policyId: "fwa-native-current-era",
  policyVersion: "explicit-window-v1",
  eraStartIso: "2026-11-23T00:00:00.000Z",
  eraEndIso: "2026-11-24T02:45:00.000Z",
} as const;

function roster(index: number): NativeReferenceSourceRoster {
  const clanTag = `#NATIVE${index}`;
  const members = Array.from({ length: 50 }, (_, position) => ({
    clanTag,
    playerTag: `${clanTag}-P${position + 1}`,
    position: position + 1,
    townHall: position < 10 ? 19 : 18,
    rawWeight: position < 10 ? 181000 : 171000,
    effectiveWeight: position < 10 ? 181000 : 171000,
    effectiveWeightStatus: "RAW",
  }));
  return {
    clanTag,
    rosterSize: 50,
    totalRawWeight: 8_650_000,
    totalEffectiveWeight: 8_650_000,
    observedAt: "2026-11-23T01:00:00.000Z",
    sourceUpdatedAt: "2026-11-23T01:00:00.000Z",
    sourceWarId: 1,
    sourceWarStartTime: "2026-11-23T00:30:00.000Z",
    sourceWarEndTime: "2026-11-24T00:30:00.000Z",
    sourceWarState: "warEnded",
    sourceCurrentWarUpdatedAt: "2026-11-23T01:00:00.000Z",
    sourceIdentityStatus: "VERIFIED",
    sourceMatchType: "FWA",
    sourceMemberCompletenessStatus: "VERIFIED",
    members,
  };
}

describe("native provisional publication boundary", () => {
  it("persists TH19 and preserves unsupported bands as UNKNOWN in the preview contract", () => {
    const candidate = generateNativeHeatMapRefCandidate({
      sourceRosters: Array.from({ length: 5 }, (_, index) => roster(index + 1)),
      eraPolicy,
      evaluationAt: eraPolicy.eraEndIso,
      bandDefinitions: HEAT_MAP_REF_SEED_ROWS.map((row) => ({ weightMinInclusive: row.weightMinInclusive, weightMaxInclusive: row.weightMaxInclusive })),
      sampleThreshold: 5,
      bucketRegistry: NATIVE_REFERENCE_BUCKET_REGISTRY,
      sourceCategory: "synthetic_fixture",
      evidenceTrust: "synthetic_untrusted",
    });
    const preview = buildNativeHeatMapReferencePreview(candidate, { requestKey: "test-request" });
    expect(preview.policyVersion).toBe(NATIVE_REFERENCE_POLICY_VERSION);
    expect(preview.sampleThreshold).toBe(5);
    expect(preview.buckets.map((bucket) => bucket.bucketId)).toContain("TH19");
    expect(preview.targets.some((target) => target.status === "SUPPORTED" && target.bucketId === "TH19")).toBe(true);
    expect(preview.targets.some((target) => target.status === "UNKNOWN" && target.targetCount === null)).toBe(true);
    expect(preview.lineage).toHaveLength(0);
  });

  it("keeps the migration additive and excludes P4e activation", () => {
    const migration = readFileSync("prisma/migrations/20261124030000_add_native_heatmap_reference_publication/migration.sql", "utf8");
    expect(migration).toContain("NativeHeatMapReferenceGeneration");
    expect(migration).toContain("NativeHeatMapReferenceHead");
    expect(migration).toContain("NativeHeatMapReferencePublicationEvent");
    expect(migration).toContain("NativeHeatMapReferenceTarget_count_check");
    expect(migration).not.toContain("UPDATE \"HeatMapRef\"");
    expect(migration).not.toContain("NativeHeatMapReferenceActivation");
  });

  it("rejects a candidate generated under a different provisional threshold", () => {
    const candidate = generateNativeHeatMapRefCandidate({
      sourceRosters: [roster(1)],
      eraPolicy,
      evaluationAt: eraPolicy.eraEndIso,
      bandDefinitions: HEAT_MAP_REF_SEED_ROWS.map((row) => ({ weightMinInclusive: row.weightMinInclusive, weightMaxInclusive: row.weightMaxInclusive })),
      sampleThreshold: 10,
      bucketRegistry: NATIVE_REFERENCE_BUCKET_REGISTRY,
      sourceCategory: "synthetic_fixture",
      evidenceTrust: "synthetic_untrusted",
    });
    expect(() => buildNativeHeatMapReferencePreview(candidate)).toThrow(/2-anchor\/5-clan/);
  });

  it("keeps synthetic previews non-publishable and owns TH19 in the native calculation profile", () => {
    const candidate = generateNativeHeatMapRefCandidate({
      sourceRosters: Array.from({ length: 5 }, (_, index) => roster(index + 1)),
      eraPolicy,
      evaluationAt: eraPolicy.eraEndIso,
      bandDefinitions: HEAT_MAP_REF_SEED_ROWS.map((row) => ({ weightMinInclusive: row.weightMinInclusive, weightMaxInclusive: row.weightMaxInclusive })),
      sampleThreshold: 5,
      bucketRegistry: NATIVE_REFERENCE_BUCKET_REGISTRY,
      sourceCategory: "synthetic_fixture",
      evidenceTrust: "synthetic_untrusted",
    });
    expect(validatePublishableCandidate(candidate)).toBe("publication_requires_retained_observation_source");
    expect(NATIVE_PROVISIONAL_COMPOSITION_PROFILE.buckets[0]?.id).toBe("TH19");
    expect(Object.isFrozen(NATIVE_PROVISIONAL_COMPOSITION_PROFILE)).toBe(true);
  });

  it("enforces canonical profile and band policy independently of candidate metadata", () => {
    const candidate = generateNativeHeatMapRefCandidate({
      sourceRosters: Array.from({ length: 5 }, (_, index) => roster(index + 1)),
      eraPolicy,
      evaluationAt: eraPolicy.eraEndIso,
      bandDefinitions: HEAT_MAP_REF_SEED_ROWS.map((row) => ({ weightMinInclusive: row.weightMinInclusive, weightMaxInclusive: row.weightMaxInclusive })),
      sampleThreshold: 5,
      bucketRegistry: NATIVE_REFERENCE_BUCKET_REGISTRY,
      sourceCategory: "synthetic_fixture",
      evidenceTrust: "synthetic_untrusted",
    });
    expect(validatePublishableCandidate({ ...candidate, profileId: "caller-controlled-profile" })).toBe("publication_requires_canonical_profile");
    expect(validatePublishableCandidate({ ...candidate, bandDefinitions: candidate.bandDefinitions.slice(1) })).toBe("publication_requires_canonical_band_definitions");
  });

  it("rejects unknown CLI flags, duplicate flags, and valued confirmations", () => {
    expect(() => parseArgs(["verify", "--unexpected"])).toThrow(/unknown --unexpected/);
    expect(() => parseArgs(["preview", "--candidate", "a", "--candidate", "b"])).toThrow(/duplicate --candidate/);
    expect(() => parseArgs(["publish", "--confirm", "true"])).toThrow(/does not accept a value/);
    expect(parseArgs(["publish", "--candidate", "a", "--request-key", "r", "--expected-generation-id", "none", "--expected-fence-token", "0", "--confirm"]).args.confirm).toBe(true);
  });

  it("classifies original-parameter retries, superseded generations, stale writers, and conflicts", () => {
    expect(classifyNativePublicationRetry({ contentMatches: true, generationStillCurrent: true, originalParametersMatch: true })).toEqual({ eventType: "PUBLISHED", reasonCode: "exact_retry", idempotent: true });
    expect(classifyNativePublicationRetry({ contentMatches: true, generationStillCurrent: false, originalParametersMatch: true })).toMatchObject({ eventType: "REJECTED_STALE", reasonCode: "request_generation_superseded", idempotent: false });
    expect(classifyNativePublicationRetry({ contentMatches: true, generationStillCurrent: true, originalParametersMatch: false })).toMatchObject({ eventType: "REJECTED_STALE", reasonCode: "request_original_parameters_mismatch", idempotent: false });
    expect(classifyNativePublicationRetry({ contentMatches: false, generationStillCurrent: true, originalParametersMatch: true })).toMatchObject({ eventType: "REJECTED_CONFLICT", reasonCode: "request_key_content_conflict", idempotent: false });
  });
});
