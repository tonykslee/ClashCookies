import { describe, expect, it } from "vitest";
import {
  calculateProfileDeviationScore,
  createCompoCalculationProfile,
  generateProfileAdviceActions,
  LEGACY_COMPO_CALCULATION_PROFILE,
  projectCompoProfileCounts,
  resolveLegacyProfileTargets,
  validateCompoCalculationProfile,
} from "../src/helper/compoCalculationProfile";

function syntheticProfile() {
  return createCompoCalculationProfile({
    profileId: "test-only-three-band",
    policyVersion: "test-only-1",
    buckets: [
      { id: "alpha", order: 0, sourceBucketIds: ["a"], displayLabel: "Alpha", deviationPenalty: 7, actionPriority: 2, representativeWeight: { kind: "fixed", value: 300 } },
      { id: "beta", order: 1, sourceBucketIds: ["b"], displayLabel: "Beta", deviationPenalty: 1, actionPriority: 0, representativeWeight: { kind: "fixed", value: 200 } },
      { id: "gamma", order: 2, sourceBucketIds: ["c"], displayLabel: "Gamma", deviationPenalty: 3, actionPriority: 1, representativeWeight: { kind: "fixed", value: 100 } },
    ],
    unsupportedFactualBucketIds: ["future"],
    factualToCalculationBucket: { a: "alpha", b: "beta", c: "gamma", future: null },
    targetMappings: [
      { calculationBucketId: "alpha", referenceBucketIds: ["alpha"] },
      { calculationBucketId: "beta", referenceBucketIds: ["beta"] },
      { calculationBucketId: "gamma", referenceBucketIds: ["gamma"] },
    ],
    compatibility: {
      plannerBucketByCalculationBucket: { alpha: "a", beta: "b", gamma: "c" },
      displayBucketByCalculationBucket: { alpha: "alpha", beta: "beta", gamma: "gamma" },
    },
    maximumEstimatedWeightBucketId: "alpha",
  });
}

describe("composition calculation profiles", () => {
  it("keeps the active legacy profile immutable and preserves v1 policy", () => {
    expect(Object.isFrozen(LEGACY_COMPO_CALCULATION_PROFILE)).toBe(true);
    expect(LEGACY_COMPO_CALCULATION_PROFILE.unsupportedFactualBucketIds).toEqual(["TH19"]);
    expect(LEGACY_COMPO_CALCULATION_PROFILE.buckets.map((bucket) => bucket.id)).toEqual([
      "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13",
    ]);
    expect(LEGACY_COMPO_CALCULATION_PROFILE.buckets.map((bucket) => bucket.deviationPenalty)).toEqual([
      5, 4, 3, 2, 1, 0.5,
    ]);
  });

  it("rejects ambiguous profile definitions instead of silently dropping policy", () => {
    const profile = syntheticProfile();
    expect(validateCompoCalculationProfile({
      ...profile,
      buckets: [profile.buckets[0]!, { ...profile.buckets[0]!, order: 1 }],
    })).toContain("duplicate");
  });

  it("uses synthetic ordering, penalties, projection, and recommendation policy", () => {
    const profile = syntheticProfile();
    const target = { alpha: 1, beta: 2, gamma: 0 };
    expect(calculateProfileDeviationScore({
      profile,
      observedCounts: { alpha: 0, beta: 1, gamma: 1 },
      targetCounts: target,
    })).toBe(11);

    const projection = projectCompoProfileCounts({
      profile,
      observedCounts: { alpha: 0, beta: 1, gamma: 1 },
      targetCounts: target,
      missingCount: 2,
      reference: null,
    });
    expect(projection.status).toBe("supported");
    expect(projection.counts).toEqual({ alpha: 1, beta: 2, gamma: 1 });
    expect(projection.addedWeight).toBe(500);

    expect(generateProfileAdviceActions({
      profile,
      observedCounts: { alpha: 0, beta: 3, gamma: 0 },
      targetCounts: { alpha: 1, beta: 1, gamma: 1 },
      memberCount: 50,
    })).toEqual([
      { kind: "swap", outgoingBucketId: "beta", incomingBucketId: "alpha" },
      { kind: "swap", outgoingBucketId: "beta", incomingBucketId: "gamma" },
    ]);
  });

  it("distinguishes explicit zero targets from missing target evidence", () => {
    const profile = syntheticProfile();
    expect(generateProfileAdviceActions({
      profile,
      observedCounts: { alpha: 0, beta: 1, gamma: 0 },
      targetCounts: { alpha: 0, beta: 1, gamma: 0 },
      memberCount: 50,
    })).toEqual([]);
    expect(generateProfileAdviceActions({
      profile,
      observedCounts: { alpha: 0, beta: 1, gamma: 0 },
      targetCounts: null,
      memberCount: 49,
    })).toEqual([]);
  });

  it("keeps legacy lower totals and non-50 totals exact", () => {
    const ref = {
      th18Count: 1, th17Count: 2, th16Count: 3, th15Count: 4, th14Count: 5,
      th13Count: 6, th12Count: 7, th11Count: 8, th10OrLowerCount: 0,
    } as any;
    const resolved = resolveLegacyProfileTargets(ref);
    expect(resolved.status).toBe("supported");
    expect(resolved.counts["<=TH13"]).toBe(21);
    expect(Object.prototype.hasOwnProperty.call(resolved.counts, "TH19")).toBe(false);
  });
});
