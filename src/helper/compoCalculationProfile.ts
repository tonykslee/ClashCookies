import type { HeatMapRef } from "@prisma/client";

/**
 * Calculation profiles describe policy, not reference authority. A profile can
 * say how a validated reference would be interpreted, but it cannot make an
 * unavailable or unvalidated reference usable.
 */
export type CompoCalculationRepresentativePolicy =
  | { kind: "fixed"; value: number }
  | {
      kind: "weighted-reference-midpoint";
      components: readonly {
        referenceBucketId: string;
        midpoint: number;
      }[];
      fallback: number;
    };

export type CompoCalculationBucketDefinition = {
  id: string;
  order: number;
  sourceBucketIds: readonly string[];
  displayLabel: string;
  deviationPenalty: number;
  actionPriority: number;
  representativeWeight: CompoCalculationRepresentativePolicy;
};

export type CompoCalculationTargetMapping = {
  calculationBucketId: string;
  referenceBucketIds: readonly string[];
};

export type CompoCalculationProfile = Readonly<{
  profileId: string;
  policyVersion: string;
  /** Ordered buckets used by deviation, projection, and action generation. */
  buckets: readonly CompoCalculationBucketDefinition[];
  /** Factual buckets that the active profile intentionally cannot compare. */
  unsupportedFactualBucketIds: readonly string[];
  factualToCalculationBucket: Readonly<Record<string, string | null>>;
  targetMappings: readonly CompoCalculationTargetMapping[];
  /** Historical compatibility mappings, kept out of factual classification. */
  compatibility: Readonly<{
    plannerBucketByCalculationBucket: Readonly<Record<string, string>>;
    displayBucketByCalculationBucket: Readonly<Record<string, string>>;
  }>;
  maximumEstimatedWeightBucketId: string;
}>;

export type CompoCalculationTargetResolution = {
  status: "supported" | "missing" | "invalid" | "unavailable";
  counts: Readonly<Record<string, number>>;
  unsupportedBucketIds: readonly string[];
  reason: string | null;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Validate profile structure before it can be used by a calculation path. */
export function validateCompoCalculationProfile(
  profile: CompoCalculationProfile,
): string | null {
  if (!profile.profileId.trim() || !profile.policyVersion.trim()) {
    return "profile identity and policy version are required";
  }
  if (profile.buckets.length === 0) {
    return "profile must define at least one calculation bucket";
  }

  const bucketIds = new Set<string>();
  for (const [index, bucket] of profile.buckets.entries()) {
    if (!bucket.id.trim() || bucketIds.has(bucket.id)) {
      return `duplicate or empty calculation bucket id (${bucket.id})`;
    }
    bucketIds.add(bucket.id);
    if (bucket.order !== index) {
      return `calculation bucket ordering is not contiguous at ${bucket.id}`;
    }
    if (!bucket.displayLabel.trim() || !isFiniteNonnegative(bucket.deviationPenalty)) {
      return `invalid calculation policy values (${bucket.id})`;
    }
    if (!Number.isSafeInteger(bucket.actionPriority) || bucket.actionPriority < 0) {
      return `invalid action priority (${bucket.id})`;
    }
    const sourceIds = new Set<string>();
    for (const sourceId of bucket.sourceBucketIds) {
      if (!sourceId.trim() || sourceIds.has(sourceId)) {
        return `duplicate or empty source bucket id (${bucket.id})`;
      }
      sourceIds.add(sourceId);
    }
    const representative = bucket.representativeWeight;
    if (representative.kind === "fixed") {
      if (!isFiniteNonnegative(representative.value)) {
        return `invalid representative weight (${bucket.id})`;
      }
    } else {
      if (!isFiniteNonnegative(representative.fallback)) {
        return `invalid representative fallback (${bucket.id})`;
      }
      for (const component of representative.components) {
        if (!component.referenceBucketId.trim() || !Number.isFinite(component.midpoint)) {
          return `invalid representative component (${bucket.id})`;
        }
      }
    }
  }

  const unsupported = new Set<string>();
  for (const factualId of profile.unsupportedFactualBucketIds) {
    if (!factualId.trim() || unsupported.has(factualId)) {
      return `duplicate or empty unsupported factual bucket id (${factualId})`;
    }
    unsupported.add(factualId);
  }
  for (const [factualId, calculationId] of Object.entries(profile.factualToCalculationBucket)) {
    if (!factualId.trim() || (calculationId !== null && !bucketIds.has(calculationId))) {
      return `invalid factual bucket mapping (${factualId})`;
    }
  }

  const mappedCalculationIds = new Set<string>();
  const mappedReferenceIds = new Set<string>();
  for (const mapping of profile.targetMappings) {
    if (!bucketIds.has(mapping.calculationBucketId) || mappedCalculationIds.has(mapping.calculationBucketId)) {
      return `ambiguous target mapping (${mapping.calculationBucketId})`;
    }
    mappedCalculationIds.add(mapping.calculationBucketId);
    if (mapping.referenceBucketIds.length === 0) {
      return `target mapping has no reference buckets (${mapping.calculationBucketId})`;
    }
    for (const referenceId of mapping.referenceBucketIds) {
      if (!referenceId.trim() || mappedReferenceIds.has(referenceId)) {
        return `ambiguous reference target mapping (${referenceId})`;
      }
      mappedReferenceIds.add(referenceId);
    }
  }
  if (!bucketIds.has(profile.maximumEstimatedWeightBucketId)) {
    return "maximum estimated-weight bucket is not defined";
  }
  if (Object.keys(profile.compatibility.plannerBucketByCalculationBucket).some((id) => !bucketIds.has(id))) {
    return "planner compatibility mapping references an unknown bucket";
  }
  if (Object.keys(profile.compatibility.displayBucketByCalculationBucket).some((id) => !bucketIds.has(id))) {
    return "display compatibility mapping references an unknown bucket";
  }
  return null;
}

/** Create a validated, immutable profile with no shared mutable policy state. */
export function createCompoCalculationProfile(
  profile: CompoCalculationProfile,
): CompoCalculationProfile {
  const normalized = {
    ...profile,
    buckets: profile.buckets.map((bucket) => ({
      ...bucket,
      sourceBucketIds: [...bucket.sourceBucketIds],
      representativeWeight:
        bucket.representativeWeight.kind === "fixed"
          ? { ...bucket.representativeWeight }
          : {
              ...bucket.representativeWeight,
              components: bucket.representativeWeight.components.map((component) => ({ ...component })),
            },
    })),
    unsupportedFactualBucketIds: [...profile.unsupportedFactualBucketIds],
    factualToCalculationBucket: { ...profile.factualToCalculationBucket },
    targetMappings: profile.targetMappings.map((mapping) => ({
      ...mapping,
      referenceBucketIds: [...mapping.referenceBucketIds],
    })),
    compatibility: {
      plannerBucketByCalculationBucket: { ...profile.compatibility.plannerBucketByCalculationBucket },
      displayBucketByCalculationBucket: { ...profile.compatibility.displayBucketByCalculationBucket },
    },
  };
  const error = validateCompoCalculationProfile(normalized);
  if (error) {
    throw new Error(`Invalid composition calculation profile: ${error}`);
  }
  return deepFreeze(normalized);
}

const LEGACY_LOW_COMPONENTS = [
  { referenceBucketId: "TH13", midpoint: 125000 },
  { referenceBucketId: "TH12", midpoint: 115000 },
  { referenceBucketId: "TH11", midpoint: 100500 },
  { referenceBucketId: "TH10_OR_LOWER", midpoint: 57000 },
] as const;

/** The only calculation profile active in production paths during P4b. */
export const LEGACY_COMPO_CALCULATION_PROFILE = createCompoCalculationProfile({
  profileId: "legacy-v1",
  policyVersion: "legacy-v1-calculation-1",
  buckets: [
    { id: "TH18", order: 0, sourceBucketIds: ["TH18"], displayLabel: "TH18", deviationPenalty: 5, actionPriority: 0, representativeWeight: { kind: "fixed", value: 175000 } },
    { id: "TH17", order: 1, sourceBucketIds: ["TH17"], displayLabel: "TH17", deviationPenalty: 4, actionPriority: 1, representativeWeight: { kind: "fixed", value: 165000 } },
    { id: "TH16", order: 2, sourceBucketIds: ["TH16"], displayLabel: "TH16", deviationPenalty: 3, actionPriority: 2, representativeWeight: { kind: "fixed", value: 155000 } },
    { id: "TH15", order: 3, sourceBucketIds: ["TH15"], displayLabel: "TH15", deviationPenalty: 2, actionPriority: 3, representativeWeight: { kind: "fixed", value: 145000 } },
    { id: "TH14", order: 4, sourceBucketIds: ["TH14"], displayLabel: "TH14", deviationPenalty: 1, actionPriority: 4, representativeWeight: { kind: "fixed", value: 135000 } },
    {
      id: "<=TH13",
      order: 5,
      sourceBucketIds: ["TH13", "TH12", "TH11", "TH10", "TH9", "TH8_OR_LOWER"],
      displayLabel: "<=TH13",
      deviationPenalty: 0.5,
      actionPriority: 5,
      representativeWeight: {
        kind: "weighted-reference-midpoint",
        components: LEGACY_LOW_COMPONENTS,
        fallback: Math.round((125000 + 115000 + 100500 + 57000) / 4),
      },
    },
  ],
  unsupportedFactualBucketIds: ["TH19"],
  factualToCalculationBucket: {
    TH19: null,
    TH18: "TH18",
    TH17: "TH17",
    TH16: "TH16",
    TH15: "TH15",
    TH14: "TH14",
    TH13: "<=TH13",
    TH12: "<=TH13",
    TH11: "<=TH13",
    TH10: "<=TH13",
    TH9: "<=TH13",
    TH8_OR_LOWER: "<=TH13",
  },
  targetMappings: [
    { calculationBucketId: "TH18", referenceBucketIds: ["TH18"] },
    { calculationBucketId: "TH17", referenceBucketIds: ["TH17"] },
    { calculationBucketId: "TH16", referenceBucketIds: ["TH16"] },
    { calculationBucketId: "TH15", referenceBucketIds: ["TH15"] },
    { calculationBucketId: "TH14", referenceBucketIds: ["TH14"] },
    { calculationBucketId: "<=TH13", referenceBucketIds: ["TH13", "TH12", "TH11", "TH10_OR_LOWER"] },
  ],
  compatibility: {
    plannerBucketByCalculationBucket: {
      TH18: "TH18", TH17: "TH17", TH16: "TH16", TH15: "TH15", TH14: "TH14", "<=TH13": "TH13",
    },
    displayBucketByCalculationBucket: {
      TH18: "TH18", TH17: "TH17", TH16: "TH16", TH15: "TH15", TH14: "TH14", "<=TH13": "<=TH13",
    },
  },
  maximumEstimatedWeightBucketId: "TH18",
});

function getReferenceBucketCount(ref: HeatMapRef, bucketId: string): number | null {
  const values: Record<string, unknown> = {
    TH18: ref.th18Count,
    TH17: ref.th17Count,
    TH16: ref.th16Count,
    TH15: ref.th15Count,
    TH14: ref.th14Count,
    TH13: ref.th13Count,
    TH12: ref.th12Count,
    TH11: ref.th11Count,
    TH10_OR_LOWER: ref.th10OrLowerCount,
  };
  const value = values[bucketId];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Adapt a validated legacy HeatMapRef parent into the active profile's buckets. */
export function resolveLegacyProfileTargets(
  ref: HeatMapRef | null,
): CompoCalculationTargetResolution {
  if (!ref) {
    return { status: "missing", counts: {}, unsupportedBucketIds: ["TH19"], reason: "reference band is missing" };
  }
  const counts: Record<string, number> = {};
  for (const mapping of LEGACY_COMPO_CALCULATION_PROFILE.targetMappings) {
    let total = 0;
    for (const referenceBucketId of mapping.referenceBucketIds) {
      const count = getReferenceBucketCount(ref, referenceBucketId);
      if (count === null) {
        return { status: "invalid", counts: {}, unsupportedBucketIds: ["TH19"], reason: `invalid reference count (${referenceBucketId})` };
      }
      total += count;
    }
    counts[mapping.calculationBucketId] = total;
  }
  return { status: "supported", counts, unsupportedBucketIds: ["TH19"], reason: null };
}

export function getCompoCalculationBucket(
  profile: CompoCalculationProfile,
  factualBucketId: string,
): string | null {
  return profile.factualToCalculationBucket[factualBucketId] ?? null;
}

export function getCompoProfileRepresentativeWeight(
  profile: CompoCalculationProfile,
  calculationBucketId: string,
  reference: HeatMapRef | null,
): number | null {
  const bucket = profile.buckets.find((candidate) => candidate.id === calculationBucketId);
  if (!bucket) return null;
  if (bucket.representativeWeight.kind === "fixed") return bucket.representativeWeight.value;
  if (!reference) return bucket.representativeWeight.fallback;
  let total = 0;
  let count = 0;
  for (const component of bucket.representativeWeight.components) {
    const componentCount = getReferenceBucketCount(reference, component.referenceBucketId);
    if (componentCount === null) return bucket.representativeWeight.fallback;
    total += componentCount * component.midpoint;
    count += componentCount;
  }
  return count > 0 ? Math.round(total / count) : bucket.representativeWeight.fallback;
}

export function getCompoProfileMaximumRepresentativeWeight(
  profile: CompoCalculationProfile,
  reference: HeatMapRef | null,
): number | null {
  return getCompoProfileRepresentativeWeight(profile, profile.maximumEstimatedWeightBucketId, reference);
}

export function calculateProfileDeviationScore(input: {
  profile: CompoCalculationProfile;
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
}): number | null {
  if (!input.targetCounts) return null;
  const targetCounts = input.targetCounts;
  for (const bucket of input.profile.buckets) {
    if (!Number.isFinite(input.observedCounts[bucket.id]) || !Number.isFinite(targetCounts[bucket.id])) {
      return null;
    }
  }
  return input.profile.buckets.reduce(
    (sum, bucket) => sum + Math.abs(input.observedCounts[bucket.id]! - targetCounts[bucket.id]!) * bucket.deviationPenalty,
    0,
  );
}

export type CompoProfileProjection = {
  status: "supported" | "unavailable";
  counts: Readonly<Record<string, number>>;
  addedWeight: number;
  deviationScore: number | null;
  reason: string | null;
};

/** Project missing slots once using only the selected profile's ordered policy. */
export function projectCompoProfileCounts(input: {
  profile: CompoCalculationProfile;
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
  missingCount: number;
  reference: HeatMapRef | null;
}): CompoProfileProjection {
  if (input.targetCounts === null || !Number.isSafeInteger(input.missingCount) || input.missingCount < 0) {
    return {
      status: "unavailable",
      counts: { ...input.observedCounts },
      addedWeight: 0,
      deviationScore: null,
      reason: "target or missing-slot evidence is unavailable",
    };
  }
  const counts: Record<string, number> = {};
  for (const bucket of input.profile.buckets) {
    const observed = input.observedCounts[bucket.id];
    const target = input.targetCounts[bucket.id];
    if (!Number.isSafeInteger(observed) || observed < 0 || !Number.isSafeInteger(target) || target < 0) {
      return {
        status: "unavailable",
        counts: { ...input.observedCounts },
        addedWeight: 0,
        deviationScore: null,
        reason: `invalid count evidence (${bucket.id})`,
      };
    }
    counts[bucket.id] = observed;
  }

  let remaining = input.missingCount;
  for (const bucket of input.profile.buckets) {
    if (remaining <= 0) break;
    const deficit = Math.max(0, input.targetCounts[bucket.id]! - counts[bucket.id]!);
    const fill = Math.min(remaining, deficit);
    counts[bucket.id] += fill;
    remaining -= fill;
  }
  const reverseBuckets = [...input.profile.buckets].reverse();
  while (remaining > 0) {
    const next = reverseBuckets.reduce((best, bucket) => {
      const bestDistance = Math.abs(counts[best.id] - (input.targetCounts![best.id] ?? 0));
      const candidateDistance = Math.abs(counts[bucket.id] - (input.targetCounts![bucket.id] ?? 0));
      return candidateDistance < bestDistance ? bucket : best;
    }, reverseBuckets[0]!);
    counts[next.id] += 1;
    remaining -= 1;
  }

  let addedWeight = 0;
  for (const bucket of input.profile.buckets) {
    const observed = input.observedCounts[bucket.id]!;
    const projected = counts[bucket.id];
    const representative = getCompoProfileRepresentativeWeight(input.profile, bucket.id, input.reference);
    if (representative === null) {
      return {
        status: "unavailable",
        counts,
        addedWeight: 0,
        deviationScore: null,
        reason: `representative weight is unavailable (${bucket.id})`,
      };
    }
    addedWeight += Math.max(0, projected - observed) * representative;
  }
  return {
    status: "supported",
    counts,
    addedWeight,
    deviationScore: calculateProfileDeviationScore({
      profile: input.profile,
      observedCounts: counts,
      targetCounts: input.targetCounts,
    }),
    reason: null,
  };
}

export type CompoProfileAdviceAction =
  | { kind: "add"; incomingBucketId: string }
  | { kind: "swap"; outgoingBucketId: string; incomingBucketId: string };

/** Generate only actions for buckets with explicit profile target policy. */
export function generateProfileAdviceActions(input: {
  profile: CompoCalculationProfile;
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
  memberCount: number;
}): CompoProfileAdviceAction[] {
  if (input.targetCounts === null || input.profile.buckets.some((bucket) =>
    !Number.isSafeInteger(input.observedCounts[bucket.id]) ||
    !Number.isSafeInteger(input.targetCounts?.[bucket.id]),
  )) {
    return [];
  }
  if (input.memberCount < 50) {
    return input.profile.buckets.map((bucket) => ({ kind: "add", incomingBucketId: bucket.id }));
  }
  const positive = input.profile.buckets.filter((bucket) => input.observedCounts[bucket.id]! > input.targetCounts![bucket.id]!);
  const negative = input.profile.buckets.filter((bucket) => input.observedCounts[bucket.id]! < input.targetCounts![bucket.id]!);
  return positive.flatMap((outgoing) => negative.map((incoming) => ({
    kind: "swap" as const,
    outgoingBucketId: outgoing.id,
    incomingBucketId: incoming.id,
  })));
}
