import { describe, expect, it } from "vitest";
import {
  calculateProfileDeviationScore,
  createCompoCalculationProfile,
  generateProfileAdviceActions,
  getCompoProfileMaximumRepresentativeWeight,
  LEGACY_COMPO_CALCULATION_PROFILE,
  projectCompoProfileCounts,
  resolveLegacyProfileTargets,
  resolveCompoProfileTargets,
  getCompoProfileRepresentativeWeight,
  validateCompoCalculationProfile,
} from "../src/helper/compoCalculationProfile";
import { evaluateCompoAdvice } from "../src/helper/compoAdviceEngine";
import { projectCompoActualStateView } from "../src/helper/compoActualStateView";
import type { CompoWarBucketCounts } from "../src/helper/compoWarBucketCounts";

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

function syntheticRuntimeProfile() {
  return createCompoCalculationProfile({
    profileId: "test-only-runtime-profile",
    policyVersion: "test-only-runtime-1",
    buckets: [
      { id: "future", order: 0, sourceBucketIds: ["TH19"], displayLabel: "Future", deviationPenalty: 9, actionPriority: 0, representativeWeight: { kind: "fixed", value: 190000 } },
      { id: "upper", order: 1, sourceBucketIds: ["TH18", "TH17"], displayLabel: "Upper", deviationPenalty: 2, actionPriority: 1, representativeWeight: { kind: "fixed", value: 160000 } },
      { id: "lower", order: 2, sourceBucketIds: ["TH16", "TH15", "TH14", "TH13", "TH12", "TH11", "TH10", "TH9", "TH8_OR_LOWER"], displayLabel: "Lower", deviationPenalty: 1, actionPriority: 2, representativeWeight: { kind: "fixed", value: 120000 } },
    ],
    unsupportedFactualBucketIds: [],
    factualToCalculationBucket: {
      TH19: "future", TH18: "upper", TH17: "upper", TH16: "lower", TH15: "lower", TH14: "lower",
      TH13: "lower", TH12: "lower", TH11: "lower", TH10: "lower", TH9: "lower", TH8_OR_LOWER: "lower",
    },
    targetMappings: [
      { calculationBucketId: "future", referenceBucketIds: ["TH18"] },
      { calculationBucketId: "upper", referenceBucketIds: ["TH17"] },
      { calculationBucketId: "lower", referenceBucketIds: ["TH16"] },
    ],
    compatibility: {
      plannerBucketByCalculationBucket: { future: "TH19", upper: "TH18", lower: "TH13" },
      displayBucketByCalculationBucket: { future: "TH19", upper: "TH18", lower: "<=TH13" },
    },
    maximumEstimatedWeightBucketId: "future",
  });
}

function syntheticReferenceContractProfile() {
  return createCompoCalculationProfile({
    profileId: "test-only-reference-contract",
    policyVersion: "test-only-reference-contract-1",
    buckets: [
      { id: "alpha", order: 0, sourceBucketIds: ["a"], displayLabel: "Alpha", deviationPenalty: 2, actionPriority: 0, representativeWeight: { kind: "fixed", value: 300 } },
      { id: "beta", order: 1, sourceBucketIds: ["b"], displayLabel: "Beta", deviationPenalty: 1, actionPriority: 1, representativeWeight: { kind: "weighted-reference-midpoint", components: [{ referenceBucketId: "future-member", midpoint: 100 }], fallback: 80 } },
    ],
    unsupportedFactualBucketIds: [],
    factualToCalculationBucket: { a: "alpha", b: "beta" },
    targetMappings: [
      { calculationBucketId: "alpha", referenceBucketIds: ["future-max"] },
      { calculationBucketId: "beta", referenceBucketIds: ["future-member"] },
    ],
    compatibility: {
      plannerBucketByCalculationBucket: { alpha: "a", beta: "b" },
      displayBucketByCalculationBucket: { alpha: "alpha", beta: "beta" },
    },
    maximumEstimatedWeightBucketId: "alpha",
  });
}

function makeRuntimeRef(input: { min: number; max: number; future: number; upper: number; lower: number }) {
  return {
    weightMinInclusive: input.min,
    weightMaxInclusive: input.max,
    th18Count: input.future,
    th17Count: input.upper,
    th16Count: input.lower,
    th15Count: 0,
    th14Count: 0,
    th13Count: 0,
    th12Count: 0,
    th11Count: 0,
    th10OrLowerCount: 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

function makeRuntimeCounts(partial?: Partial<CompoWarBucketCounts>): CompoWarBucketCounts {
  return {
    TH19: 0,
    TH18: 0,
    TH17: 0,
    TH16: 0,
    TH15: 0,
    TH14: 0,
    TH13: 0,
    TH12: 0,
    TH11: 0,
    TH10: 0,
    TH9: 0,
    TH8_OR_LOWER: 0,
    ...partial,
  };
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

  it("uses the same profile-parameterized runtime projection for reordered synthetic buckets", () => {
    const profile = syntheticRuntimeProfile();
    const refs = [
      makeRuntimeRef({ min: 0, max: 399999, future: 2, upper: 0, lower: 48 }),
      makeRuntimeRef({ min: 400000, max: 700000, future: 0, upper: 50, lower: 0 }),
    ];
    const base = {
      resolvedTotalWeight: 300000,
      unresolvedWeightCount: 0,
      memberCount: 50,
      bucketCounts: makeRuntimeCounts({ TH18: 2, TH13: 48 }),
    };
    const first = projectCompoActualStateView({ view: "best", base, heatMapRefs: refs, profile });
    const second = projectCompoActualStateView({ view: "best", base, heatMapRefs: [...refs].reverse(), profile });
    expect(first.targetStatus).toBe("supported");
    expect(first.selectedHeatMapRef?.weightMinInclusive).toBe(0);
    expect(first.selectedHeatMapRef?.weightMinInclusive).toBe(second.selectedHeatMapRef?.weightMinInclusive);
    expect(first.calculationCounts).toEqual({ future: 0, upper: 2, lower: 48 });
    expect(first.targetCalculationCounts).toEqual({ future: 2, upper: 0, lower: 48 });
    expect(first.deviationScore).toBe(22);
    expect(getCompoProfileMaximumRepresentativeWeight(profile, null)).toBe(190000);
  });

  it("uses the same runtime advice and ranking path for a synthetic supported bucket", () => {
    const profile = syntheticRuntimeProfile();
    const base = {
      resolvedTotalWeight: 300000,
      unresolvedWeightCount: 0,
      memberCount: 50,
      bucketCounts: makeRuntimeCounts({ TH18: 2, TH13: 48 }),
    };
    const summary = evaluateCompoAdvice({
      mode: "actual",
      view: "raw",
      base,
      heatMapRefs: [makeRuntimeRef({ min: 0, max: 700000, future: 2, upper: 0, lower: 48 })],
      profile,
    });
    expect(summary.recommendationText).toBe("Replace one TH18 with one TH19");
    expect(summary.resultingScore).toBe(11);
    expect(summary.alternateTexts).toEqual([]);
  });

  it("supports a genuinely new reference contract and weighted representative reader", () => {
    const profile = syntheticReferenceContractProfile();
    const reference = { counts: { "future-max": 1, "future-member": 2 } };
    const readCount = (value: typeof reference, id: string) => value.counts[id];
    expect(resolveCompoProfileTargets({ profile, reference, readCount })).toMatchObject({
      status: "supported",
      counts: { alpha: 1, beta: 2 },
    });
    expect(getCompoProfileRepresentativeWeight(profile, "beta", reference, readCount)).toBe(100);
  });

  it("simulates a grouped synthetic swap from a non-representative populated source", () => {
    const profile = syntheticRuntimeProfile();
    const summary = evaluateCompoAdvice({
      mode: "actual",
      view: "raw",
      base: {
        resolvedTotalWeight: 300000,
        unresolvedWeightCount: 0,
        memberCount: 50,
        bucketCounts: makeRuntimeCounts({ TH17: 2, TH13: 48 }),
      },
      heatMapRefs: [makeRuntimeRef({ min: 0, max: 700000, future: 2, upper: 0, lower: 48 })],
      profile,
    });
    expect(summary.recommendationText).toBe("Replace one TH18 with one TH19");
    expect(summary.resultingScore).toBe(11);
  });

  it("rejects malformed count evidence without dropping factual observations", () => {
    const profile = syntheticProfile();
    expect(calculateProfileDeviationScore({
      profile,
      observedCounts: { alpha: 1, beta: -1, gamma: 0 },
      targetCounts: { alpha: 1, beta: 0, gamma: 0 },
    })).toBeNull();
    const projection = projectCompoProfileCounts({
      profile,
      observedCounts: { alpha: 1, beta: 0, gamma: 0, future: 1 },
      targetCounts: { alpha: 1, beta: 0, gamma: 0 },
      missingCount: 0,
      reference: null,
    });
    expect(projection.status).toBe("unavailable");
    expect(projection.counts.future).toBe(1);
    expect(generateProfileAdviceActions({
      profile,
      observedCounts: { alpha: 1, beta: 0, gamma: 0 },
      targetCounts: { alpha: 1, beta: 0, gamma: 0, extra: 0 },
      memberCount: 50,
    })).toEqual([]);
  });

  it("keeps invalid references and representative evidence unavailable", () => {
    const invalidReference = makeRuntimeRef({ min: 0, max: 700000, future: 2, upper: 0, lower: 48 });
    (invalidReference as { th18Count: number }).th18Count = -1;
    const projection = projectCompoActualStateView({
      view: "raw",
      base: {
        resolvedTotalWeight: 300000,
        unresolvedWeightCount: 0,
        memberCount: 50,
        bucketCounts: makeRuntimeCounts({ TH18: 2, TH13: 48 }),
      },
      heatMapRefs: [invalidReference],
    });
    expect(projection.selectedHeatMapRef).toBeNull();
    expect(projection.targetStatus).toBe("invalid");
    expect(projection.deviationScore).toBeNull();

    const baseProfile = syntheticProfile();
    const weightedProfile = createCompoCalculationProfile({
      ...baseProfile,
      buckets: baseProfile.buckets.map((bucket, index) => index === 0
        ? {
            ...bucket,
            representativeWeight: {
              kind: "weighted-reference-midpoint" as const,
              components: [{ referenceBucketId: "TH18", midpoint: 300 }],
              fallback: 300,
            },
          }
        : bucket),
      targetMappings: [
        { calculationBucketId: "alpha", referenceBucketIds: ["TH18"] },
        ...baseProfile.targetMappings.slice(1),
      ],
    });
    const weightedProjection = projectCompoProfileCounts({
      profile: weightedProfile,
      observedCounts: { alpha: 0, beta: 1, gamma: 0 },
      targetCounts: { alpha: 1, beta: 1, gamma: 0 },
      missingCount: 1,
      reference: {} as never,
    });
    expect(weightedProjection.status).toBe("unavailable");
    expect(weightedProjection.reason).toContain("representative weight");
  });

  it("rejects contradictory and incomplete profile coverage", () => {
    const profile = syntheticProfile();
    expect(validateCompoCalculationProfile({
      ...profile,
      buckets: [
        { ...profile.buckets[0]!, sourceBucketIds: ["a", "b"] },
        { ...profile.buckets[1]!, sourceBucketIds: ["b"] },
        profile.buckets[2]!,
      ],
    })).toContain("multiple calculation buckets");
    expect(validateCompoCalculationProfile({
      ...profile,
      targetMappings: profile.targetMappings.slice(0, 2),
    })).toContain("cover every calculation bucket");
    expect(validateCompoCalculationProfile({
      ...profile,
      unsupportedFactualBucketIds: ["future"],
      factualToCalculationBucket: { ...profile.factualToCalculationBucket, future: "alpha" },
    })).toContain("unsupported factual bucket maps");
    expect(validateCompoCalculationProfile({
      ...profile,
      factualToCalculationBucket: { ...profile.factualToCalculationBucket, extra: "alpha" },
    })).toContain("outside declared source coverage");
    expect(validateCompoCalculationProfile({
      ...profile,
      buckets: profile.buckets.map((bucket, index) => index === 0
        ? {
            ...bucket,
            representativeWeight: {
              kind: "weighted-reference-midpoint" as const,
              components: [{ referenceBucketId: "beta", midpoint: 300 }],
              fallback: 300,
            },
          }
        : bucket),
    })).toContain("not covered by target mappings");
    expect(validateCompoCalculationProfile({
      ...profile,
      compatibility: {
        ...profile.compatibility,
        plannerBucketByCalculationBucket: { ...profile.compatibility.plannerBucketByCalculationBucket, alpha: "b" },
      },
    })).toContain("outside factual source group");
    expect(validateCompoCalculationProfile({
      ...profile,
      buckets: profile.buckets.map((bucket, index) => index === 0
        ? { ...bucket, representativeWeight: { kind: "fixed" as const, value: 50 } }
        : bucket),
    })).toContain("maximum estimated-weight bound is insufficient");
  });

  it("rejects malformed generic reference-reader results", () => {
    const profile = syntheticReferenceContractProfile();
    const reference = { counts: { "future-max": 1, "future-member": -1 } };
    expect(resolveCompoProfileTargets({
      profile,
      reference,
      readCount: (value, id) => value.counts[id],
    }).status).toBe("invalid");
    expect(resolveCompoProfileTargets({
      profile,
      reference: { counts: { "future-max": 1, "future-member": 0.5 } },
      readCount: (value, id) => value.counts[id],
    }).status).toBe("invalid");
  });
});
