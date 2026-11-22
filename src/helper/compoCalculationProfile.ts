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
      components: readonly { referenceBucketId: string; midpoint: number }[];
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
  buckets: readonly CompoCalculationBucketDefinition[];
  unsupportedFactualBucketIds: readonly string[];
  factualToCalculationBucket: Readonly<Record<string, string | null>>;
  targetMappings: readonly CompoCalculationTargetMapping[];
  compatibility: Readonly<{
    plannerBucketByCalculationBucket: Readonly<Record<string, string>>;
    displayBucketByCalculationBucket: Readonly<Record<string, string>>;
  }>;
  maximumEstimatedWeightBucketId: string;
}>;

export type CompoProfileReferenceCountReader<TReference> = (
  reference: TReference,
  referenceBucketId: string,
) => unknown;

export type CompoCalculationTargetStatus =
  | "supported"
  | "missing"
  | "invalid"
  | "unavailable";

export type CompoCalculationTargetResolution = {
  status: CompoCalculationTargetStatus;
  counts: Readonly<Record<string, number>>;
  unsupportedBucketIds: readonly string[];
  reason: string | null;
};

export type CompoProfileCountValidation = {
  status: "supported" | "unavailable";
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
  reason: string | null;
};

export type CompoProfileProjection = {
  status: "supported" | "unavailable";
  counts: Readonly<Record<string, number>>;
  addedWeight: number;
  deviationScore: number | null;
  reason: string | null;
};

export type CompoProfileAdviceAction =
  | { kind: "add"; incomingBucketId: string }
  | { kind: "swap"; outgoingBucketId: string; incomingBucketId: string };

export type CompoProfileAdviceEvaluation = {
  scoreImprovement: number | null;
  resultingScore: number | null;
  bandFitDistance: number;
  totalWeightJump: number;
  incomingPriority: number;
  outgoingPriority: number;
  description: string;
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

function isValidCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUsableProfile(profile: CompoCalculationProfile): boolean {
  return Boolean(
    profile &&
      typeof profile === "object" &&
      Object.isFrozen(profile) &&
      validateCompoCalculationProfile(profile) === null,
  );
}

function readReferenceCountSafely<TReference>(
  reader: CompoProfileReferenceCountReader<TReference>,
  reference: TReference,
  referenceBucketId: string,
): unknown {
  try {
    return reader(reference, referenceBucketId);
  } catch {
    return null;
  }
}

/** Validate profile structure before it can be used by a calculation path. */
export function validateCompoCalculationProfile(
  profile: CompoCalculationProfile,
): string | null {
  if (!profile || typeof profile !== "object") return "profile is required";
  if (
    typeof profile.profileId !== "string" ||
    typeof profile.policyVersion !== "string" ||
    !profile.profileId.trim() ||
    !profile.policyVersion.trim()
  ) {
    return "profile identity and policy version are required";
  }
  if (
    !Array.isArray(profile.buckets) ||
    !Array.isArray(profile.unsupportedFactualBucketIds) ||
    !profile.factualToCalculationBucket ||
    !Array.isArray(profile.targetMappings) ||
    !profile.compatibility ||
    !profile.compatibility.plannerBucketByCalculationBucket ||
    !profile.compatibility.displayBucketByCalculationBucket ||
    profile.buckets.length === 0
  ) {
    return "profile must define at least one calculation bucket";
  }

  const bucketIds = new Set<string>();
  const sourceOwners = new Map<string, string>();
  for (const [index, bucket] of profile.buckets.entries()) {
    if (
      !bucket ||
      typeof bucket.id !== "string" ||
      !bucket.id.trim() ||
      bucketIds.has(bucket.id)
    ) {
      return `duplicate or empty calculation bucket id (${bucket?.id ?? ""})`;
    }
    bucketIds.add(bucket.id);
    if (bucket.order !== index) {
      return `calculation bucket ordering is not contiguous at ${bucket.id}`;
    }
    if (
      typeof bucket.displayLabel !== "string" ||
      !bucket.displayLabel.trim() ||
      !isFiniteNonnegative(bucket.deviationPenalty) ||
      !Number.isSafeInteger(bucket.actionPriority) ||
      bucket.actionPriority < 0
    ) {
      return `invalid calculation policy values (${bucket.id})`;
    }
    if (!Array.isArray(bucket.sourceBucketIds)) return `missing source coverage (${bucket.id})`;
    const sourceIds = new Set<string>();
    for (const sourceId of bucket.sourceBucketIds) {
      if (typeof sourceId !== "string" || !sourceId.trim() || sourceIds.has(sourceId)) {
        return `duplicate or empty source bucket id (${bucket.id})`;
      }
      const previousOwner = sourceOwners.get(sourceId);
      if (previousOwner) {
        return `source bucket belongs to multiple calculation buckets (${sourceId})`;
      }
      sourceIds.add(sourceId);
      sourceOwners.set(sourceId, bucket.id);
    }
    if (sourceIds.size === 0) {
      return `calculation bucket has no factual source coverage (${bucket.id})`;
    }

    const representative = bucket.representativeWeight;
    if (!representative || typeof representative !== "object") {
      return `missing representative policy (${bucket.id})`;
    }
    if (representative.kind === "fixed") {
      if (!isFiniteNonnegative(representative.value)) {
        return `invalid representative weight (${bucket.id})`;
      }
    } else if (representative.kind === "weighted-reference-midpoint") {
      if (
        !Array.isArray(representative.components) ||
        !isFiniteNonnegative(representative.fallback) ||
        representative.components.length === 0
      ) {
        return `invalid representative fallback (${bucket.id})`;
      }
      const componentIds = new Set<string>();
      for (const component of representative.components) {
        if (
          !component ||
          typeof component.referenceBucketId !== "string" ||
          !component.referenceBucketId.trim() ||
          componentIds.has(component.referenceBucketId) ||
          !isFiniteNonnegative(component.midpoint)
        ) {
          return `invalid representative component (${bucket.id})`;
        }
        componentIds.add(component.referenceBucketId);
      }
    } else {
      return `invalid representative policy kind (${bucket.id})`;
    }
  }

  const unsupported = new Set<string>();
  for (const factualId of profile.unsupportedFactualBucketIds) {
    if (typeof factualId !== "string" || !factualId.trim() || unsupported.has(factualId)) {
      return `duplicate or empty unsupported factual bucket id (${factualId})`;
    }
    unsupported.add(factualId);
  }

  const factualMappings = profile.factualToCalculationBucket;
  for (const sourceId of sourceOwners.keys()) {
    if (!Object.prototype.hasOwnProperty.call(factualMappings, sourceId)) {
      return `missing factual coverage mapping (${sourceId})`;
    }
    const mappedId = factualMappings[sourceId];
    if (mappedId === null || mappedId !== sourceOwners.get(sourceId)) {
      return `contradictory factual coverage mapping (${sourceId})`;
    }
  }
  for (const unsupportedId of unsupported) {
    if (!Object.prototype.hasOwnProperty.call(factualMappings, unsupportedId)) {
      return `missing unsupported factual mapping (${unsupportedId})`;
    }
    if (factualMappings[unsupportedId] !== null) {
      return `unsupported factual bucket maps to a supported target (${unsupportedId})`;
    }
  }
  for (const [factualId, mappedId] of Object.entries(factualMappings)) {
    if (!factualId.trim() || (!sourceOwners.has(factualId) && !unsupported.has(factualId))) {
      return `factual mapping is outside declared source coverage (${factualId})`;
    }
    if (mappedId !== null && !bucketIds.has(mappedId)) {
      return `invalid factual bucket mapping (${factualId})`;
    }
    if (mappedId === null && !unsupported.has(factualId)) {
      return `null factual mapping is not declared unsupported (${factualId})`;
    }
  }

  const targetMappingByBucket = new Map<string, CompoCalculationTargetMapping>();
  const mappedReferenceIds = new Set<string>();
  for (const mapping of profile.targetMappings) {
    if (
      !mapping ||
      typeof mapping.calculationBucketId !== "string" ||
      !Array.isArray(mapping.referenceBucketIds) ||
      !bucketIds.has(mapping.calculationBucketId) ||
      targetMappingByBucket.has(mapping.calculationBucketId)
    ) {
      return `ambiguous target mapping (${mapping.calculationBucketId})`;
    }
    if (mapping.referenceBucketIds.length === 0) {
      return `target mapping has no reference buckets (${mapping.calculationBucketId})`;
    }
    targetMappingByBucket.set(mapping.calculationBucketId, mapping);
    for (const referenceId of mapping.referenceBucketIds) {
      if (typeof referenceId !== "string" || !referenceId.trim() || mappedReferenceIds.has(referenceId)) {
        return `ambiguous reference target mapping (${referenceId})`;
      }
      mappedReferenceIds.add(referenceId);
    }
  }
  if (targetMappingByBucket.size !== bucketIds.size) {
    return "target mappings do not cover every calculation bucket";
  }

  for (const bucket of profile.buckets) {
    const representative = bucket.representativeWeight;
    if (representative.kind !== "weighted-reference-midpoint") continue;
    for (const component of representative.components) {
      const targetMapping = targetMappingByBucket.get(bucket.id);
      if (!targetMapping?.referenceBucketIds.includes(component.referenceBucketId)) {
        return `representative component is not covered by target mappings (${bucket.id})`;
      }
    }
  }

  const plannerCompatibility = profile.compatibility.plannerBucketByCalculationBucket;
  const displayCompatibility = profile.compatibility.displayBucketByCalculationBucket;
  const displayOwners = new Set<string>();
  const plannerOwners = new Set<string>();
  for (const bucket of profile.buckets) {
    if (
      typeof plannerCompatibility[bucket.id] !== "string" ||
      !plannerCompatibility[bucket.id].trim() ||
      typeof displayCompatibility[bucket.id] !== "string" ||
      !displayCompatibility[bucket.id].trim()
    ) {
      return `incomplete compatibility mapping (${bucket.id})`;
    }
    if (!bucket.sourceBucketIds.includes(plannerCompatibility[bucket.id])) {
      return `planner compatibility is outside factual source group (${bucket.id})`;
    }
    if (plannerOwners.has(plannerCompatibility[bucket.id])) {
      return `planner compatibility is ambiguous (${plannerCompatibility[bucket.id]})`;
    }
    plannerOwners.add(plannerCompatibility[bucket.id]);
    if (displayOwners.has(displayCompatibility[bucket.id])) {
      return `display compatibility is ambiguous (${displayCompatibility[bucket.id]})`;
    }
    displayOwners.add(displayCompatibility[bucket.id]);
  }
  if (
    Object.keys(plannerCompatibility).some((id) => !bucketIds.has(id)) ||
    Object.keys(displayCompatibility).some((id) => !bucketIds.has(id))
  ) {
    return "compatibility mapping references an unknown bucket";
  }
  if (!bucketIds.has(profile.maximumEstimatedWeightBucketId)) {
    return "maximum estimated-weight bucket is not defined";
  }
  const maximumBucket = profile.buckets.find(
    (bucket) => bucket.id === profile.maximumEstimatedWeightBucketId,
  );
  if (!maximumBucket) return "maximum estimated-weight bucket must have a fixed upper bound";
  const maximumWeight = maximumBucket.representativeWeight.kind === "fixed"
    ? maximumBucket.representativeWeight.value
    : Math.max(
        maximumBucket.representativeWeight.fallback,
        ...maximumBucket.representativeWeight.components.map((component: { midpoint: number }) => component.midpoint),
      );
  for (const bucket of profile.buckets) {
    const representative = bucket.representativeWeight;
    if (representative.kind === "fixed" && representative.value > maximumWeight) {
      return "maximum estimated-weight bound is insufficient";
    }
    if (
      representative.kind === "weighted-reference-midpoint" &&
      (representative.fallback > maximumWeight ||
        representative.components.some((component: { midpoint: number }) => component.midpoint > maximumWeight))
    ) {
      return "maximum estimated-weight bound is insufficient";
    }
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
  if (error) throw new Error(`Invalid composition calculation profile: ${error}`);
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
      representativeWeight: { kind: "weighted-reference-midpoint", components: LEGACY_LOW_COMPONENTS, fallback: Math.round((125000 + 115000 + 100500 + 57000) / 4) },
    },
  ],
  unsupportedFactualBucketIds: ["TH19"],
  factualToCalculationBucket: {
    TH19: null, TH18: "TH18", TH17: "TH17", TH16: "TH16", TH15: "TH15", TH14: "TH14",
    TH13: "<=TH13", TH12: "<=TH13", TH11: "<=TH13", TH10: "<=TH13", TH9: "<=TH13", TH8_OR_LOWER: "<=TH13",
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
    plannerBucketByCalculationBucket: { TH18: "TH18", TH17: "TH17", TH16: "TH16", TH15: "TH15", TH14: "TH14", "<=TH13": "TH13" },
    displayBucketByCalculationBucket: { TH18: "TH18", TH17: "TH17", TH16: "TH16", TH15: "TH15", TH14: "TH14", "<=TH13": "<=TH13" },
  },
  maximumEstimatedWeightBucketId: "TH18",
});

export function getCompoLegacyReferenceBucketCount(ref: HeatMapRef, bucketId: string): number | null {
  const values: Record<string, unknown> = {
    TH18: ref.th18Count, TH17: ref.th17Count, TH16: ref.th16Count, TH15: ref.th15Count,
    TH14: ref.th14Count, TH13: ref.th13Count, TH12: ref.th12Count, TH11: ref.th11Count,
    TH10_OR_LOWER: ref.th10OrLowerCount,
  };
  return isValidCount(values[bucketId]) ? values[bucketId] as number : null;
}

export function resolveCompoProfileTargets<TReference>(input: {
  profile: CompoCalculationProfile;
  reference: TReference | null;
  readCount: CompoProfileReferenceCountReader<TReference>;
}): CompoCalculationTargetResolution {
  if (!isUsableProfile(input.profile)) {
    return {
      status: "invalid",
      counts: {},
      unsupportedBucketIds: [],
      reason: "profile is not validated and immutable",
    };
  }
  if (!input.reference) {
    return { status: "missing", counts: {}, unsupportedBucketIds: input.profile.unsupportedFactualBucketIds, reason: "reference band is missing" };
  }
  const counts: Record<string, number> = {};
  for (const mapping of input.profile.targetMappings) {
    let total = 0;
    for (const referenceBucketId of mapping.referenceBucketIds) {
      const count = readReferenceCountSafely(input.readCount, input.reference, referenceBucketId);
      if (!isValidCount(count)) {
        return { status: "invalid", counts: {}, unsupportedBucketIds: input.profile.unsupportedFactualBucketIds, reason: `invalid reference count (${referenceBucketId})` };
      }
      if (total > Number.MAX_SAFE_INTEGER - count) {
        return { status: "invalid", counts: {}, unsupportedBucketIds: input.profile.unsupportedFactualBucketIds, reason: `reference count overflow (${referenceBucketId})` };
      }
      total += count;
    }
    counts[mapping.calculationBucketId] = total;
  }
  return { status: "supported", counts, unsupportedBucketIds: input.profile.unsupportedFactualBucketIds, reason: null };
}

export function resolveLegacyProfileTargets(ref: HeatMapRef | null): CompoCalculationTargetResolution {
  return resolveCompoProfileTargets({ profile: LEGACY_COMPO_CALCULATION_PROFILE, reference: ref, readCount: getCompoLegacyReferenceBucketCount });
}

export function getCompoCalculationBucket(profile: CompoCalculationProfile, factualBucketId: string | null | undefined): string | null {
  if (!isUsableProfile(profile) || !factualBucketId) return null;
  return profile.factualToCalculationBucket[factualBucketId] ?? null;
}

export function getCompoProfileSourceBucketIds(profile: CompoCalculationProfile): readonly string[] {
  return isUsableProfile(profile) ? profile.buckets.flatMap((bucket) => bucket.sourceBucketIds) : [];
}

export function validateCompoProfileFactualCounts(
  profile: CompoCalculationProfile,
  counts: Readonly<Record<string, number | undefined>> | null | undefined,
): { status: "supported" | "unavailable"; reason: string | null } {
  if (!isUsableProfile(profile)) {
    return { status: "unavailable", reason: "profile is not validated and immutable" };
  }
  if (!counts) return { status: "unavailable", reason: "factual count evidence is missing" };
  const sourceIds = new Set(getCompoProfileSourceBucketIds(profile));
  for (const sourceId of sourceIds) {
    if (!Object.prototype.hasOwnProperty.call(counts, sourceId)) return { status: "unavailable", reason: `missing factual count (${sourceId})` };
    if (!isValidCount(counts[sourceId])) return { status: "unavailable", reason: `invalid factual count (${sourceId})` };
  }
  for (const [id, value] of Object.entries(counts)) {
    if (!isValidCount(value)) return { status: "unavailable", reason: `invalid factual count (${id})` };
    if (!sourceIds.has(id) && value > 0) return { status: "unavailable", reason: `unsupported factual observation (${id})` };
  }
  return { status: "supported", reason: null };
}

export function validateCompoProfilePlannerCounts(
  profile: CompoCalculationProfile,
  counts: Readonly<Record<string, number | undefined>> | null | undefined,
): { status: "supported" | "unavailable"; reason: string | null } {
  if (!isUsableProfile(profile)) {
    return { status: "unavailable", reason: "profile is not validated and immutable" };
  }
  if (!counts) return { status: "unavailable", reason: "planner target evidence is missing" };
  const plannerIds = new Set(
    profile.buckets.map((bucket) => profile.compatibility.plannerBucketByCalculationBucket[bucket.id]),
  );
  for (const plannerId of plannerIds) {
    if (!Object.prototype.hasOwnProperty.call(counts, plannerId)) {
      return { status: "unavailable", reason: `missing planner target count (${plannerId})` };
    }
    if (!isValidCount(counts[plannerId])) {
      return { status: "unavailable", reason: `invalid planner target count (${plannerId})` };
    }
  }
  for (const [id, value] of Object.entries(counts)) {
    if (!isValidCount(value) || (!plannerIds.has(id) && value > 0)) {
      return { status: "unavailable", reason: `unexpected or invalid planner target count (${id})` };
    }
  }
  return { status: "supported", reason: null };
}

function validateProfileCountEvidence(input: {
  profile: CompoCalculationProfile;
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
}): CompoProfileCountValidation {
  const bucketIds = new Set(input.profile.buckets.map((bucket) => bucket.id));
  for (const bucket of input.profile.buckets) {
    if (!Object.prototype.hasOwnProperty.call(input.observedCounts, bucket.id)) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: input.targetCounts, reason: `missing observed count (${bucket.id})` };
    if (!isValidCount(input.observedCounts[bucket.id])) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: input.targetCounts, reason: `invalid observed count (${bucket.id})` };
  }
  for (const [id, value] of Object.entries(input.observedCounts)) {
    if (!isValidCount(value)) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: input.targetCounts, reason: `invalid observed count (${id})` };
    if (!bucketIds.has(id) && value > 0) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: input.targetCounts, reason: `unsupported positive observed count (${id})` };
  }
  if (input.targetCounts === null) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: null, reason: "target evidence is missing" };
  for (const bucket of input.profile.buckets) {
    if (!Object.prototype.hasOwnProperty.call(input.targetCounts, bucket.id)) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: { ...input.targetCounts }, reason: `missing target count (${bucket.id})` };
    if (!isValidCount(input.targetCounts[bucket.id])) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: { ...input.targetCounts }, reason: `invalid target count (${bucket.id})` };
  }
  for (const [id, value] of Object.entries(input.targetCounts)) {
    if (!bucketIds.has(id) || !isValidCount(value)) return { status: "unavailable", observedCounts: { ...input.observedCounts }, targetCounts: { ...input.targetCounts }, reason: `unexpected or invalid target count (${id})` };
  }
  return { status: "supported", observedCounts: { ...input.observedCounts }, targetCounts: { ...input.targetCounts }, reason: null };
}

export function validateCompoProfileCalculationCounts(
  profile: CompoCalculationProfile,
  counts: Readonly<Record<string, number>> | null | undefined,
): { status: "supported" | "unavailable"; reason: string | null } {
  if (!isUsableProfile(profile)) {
    return { status: "unavailable", reason: "profile is not validated and immutable" };
  }
  const validation = validateProfileCountEvidence({
    profile,
    observedCounts: counts ?? {},
    targetCounts: Object.fromEntries(profile.buckets.map((bucket) => [bucket.id, 0])),
  });
  return { status: validation.status, reason: validation.reason };
}

export function getCompoProfileRepresentativeWeight<TReference = HeatMapRef>(
  profile: CompoCalculationProfile,
  calculationBucketId: string,
  reference: TReference | null,
  readCount: CompoProfileReferenceCountReader<TReference> = getCompoLegacyReferenceBucketCount as CompoProfileReferenceCountReader<TReference>,
): number | null {
  if (!isUsableProfile(profile)) return null;
  const bucket = profile.buckets.find((candidate) => candidate.id === calculationBucketId);
  if (!bucket) return null;
  if (bucket.representativeWeight.kind === "fixed") return bucket.representativeWeight.value;
  if (!reference) return bucket.representativeWeight.fallback;
  let total = 0;
  let count = 0;
  for (const component of bucket.representativeWeight.components) {
    const componentCount = readReferenceCountSafely(readCount, reference, component.referenceBucketId);
    if (!isValidCount(componentCount)) return null;
    if (componentCount > 0 && component.midpoint > Number.MAX_SAFE_INTEGER / componentCount) return null;
    total += componentCount * component.midpoint;
    count += componentCount;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(count)) return null;
  }
  return count > 0 ? Math.round(total / count) : bucket.representativeWeight.fallback;
}

export function getCompoProfileMaximumRepresentativeWeight<TReference = HeatMapRef>(
  profile: CompoCalculationProfile,
  reference: TReference | null,
  readCount?: CompoProfileReferenceCountReader<TReference>,
): number | null {
  return getCompoProfileRepresentativeWeight(
    profile,
    profile.maximumEstimatedWeightBucketId,
    reference,
    readCount,
  );
}

export function getCompoProfileMaximumEstimatedWeightBound(
  profile: CompoCalculationProfile,
): number | null {
  if (!isUsableProfile(profile)) return null;
  const bucket = profile.buckets.find(
    (candidate) => candidate.id === profile.maximumEstimatedWeightBucketId,
  );
  if (!bucket) return null;
  return bucket.representativeWeight.kind === "fixed"
    ? bucket.representativeWeight.value
    : Math.max(
        bucket.representativeWeight.fallback,
        ...bucket.representativeWeight.components.map((component: { midpoint: number }) => component.midpoint),
      );
}

export function calculateProfileDeviationScore(input: { profile: CompoCalculationProfile; observedCounts: Readonly<Record<string, number>>; targetCounts: Readonly<Record<string, number>> | null }): number | null {
  if (!isUsableProfile(input.profile)) return null;
  const validation = validateProfileCountEvidence(input);
  if (validation.status !== "supported" || !validation.targetCounts) return null;
  return input.profile.buckets.reduce((sum, bucket) => sum + Math.abs(validation.observedCounts[bucket.id]! - validation.targetCounts![bucket.id]!) * bucket.deviationPenalty, 0);
}

/** Project missing slots once using the selected profile's ordered policy. */
export function projectCompoProfileCounts<TReference = HeatMapRef>(input: { profile: CompoCalculationProfile; observedCounts: Readonly<Record<string, number>>; targetCounts: Readonly<Record<string, number>> | null; missingCount: number; reference: TReference | null; readReferenceCount?: CompoProfileReferenceCountReader<TReference> }): CompoProfileProjection {
  if (!isUsableProfile(input.profile)) {
    return { status: "unavailable", counts: { ...input.observedCounts }, addedWeight: 0, deviationScore: null, reason: "profile is not validated and immutable" };
  }
  const validation = validateProfileCountEvidence(input);
  if (validation.status !== "supported" || !Number.isSafeInteger(input.missingCount) || input.missingCount < 0) {
    return { status: "unavailable", counts: { ...input.observedCounts }, addedWeight: 0, deviationScore: null, reason: validation.reason ?? "missing or invalid missing-slot evidence" };
  }
  const counts: Record<string, number> = { ...validation.observedCounts };
  let remaining = input.missingCount;
  for (const bucket of input.profile.buckets) {
    if (remaining <= 0) break;
    const deficit = Math.max(0, validation.targetCounts![bucket.id]! - counts[bucket.id]!);
    const fill = Math.min(remaining, deficit);
    counts[bucket.id] += fill;
    remaining -= fill;
  }
  const reverseBuckets = [...input.profile.buckets].reverse();
  while (remaining > 0) {
    const next = reverseBuckets.reduce((best, bucket) => {
      const bestDistance = Math.abs(counts[best.id]! - validation.targetCounts![best.id]!);
      const candidateDistance = Math.abs(counts[bucket.id]! - validation.targetCounts![bucket.id]!);
      return candidateDistance < bestDistance ? bucket : best;
    }, reverseBuckets[0]!);
    counts[next.id] += 1;
    remaining -= 1;
  }
  let addedWeight = 0;
  for (const bucket of input.profile.buckets) {
    const representative = getCompoProfileRepresentativeWeight(
      input.profile,
      bucket.id,
      input.reference,
      input.readReferenceCount,
    );
    if (representative === null) return { status: "unavailable", counts, addedWeight: 0, deviationScore: null, reason: `representative weight is unavailable (${bucket.id})` };
    addedWeight += Math.max(0, counts[bucket.id]! - validation.observedCounts[bucket.id]!) * representative;
  }
  return { status: "supported", counts, addedWeight, deviationScore: calculateProfileDeviationScore({ profile: input.profile, observedCounts: counts, targetCounts: validation.targetCounts }), reason: null };
}

/** Generate only actions for buckets with complete, explicit profile targets. */
export function generateProfileAdviceActions(input: { profile: CompoCalculationProfile; observedCounts: Readonly<Record<string, number>>; targetCounts: Readonly<Record<string, number>> | null; memberCount: number }): CompoProfileAdviceAction[] {
  if (!isUsableProfile(input.profile)) return [];
  const validation = validateProfileCountEvidence(input);
  if (validation.status !== "supported" || !Number.isSafeInteger(input.memberCount) || input.memberCount < 0) return [];
  if (input.memberCount < 50) return input.profile.buckets.map((bucket) => ({ kind: "add" as const, incomingBucketId: bucket.id }));
  const positive = input.profile.buckets.filter((bucket) => validation.observedCounts[bucket.id]! > validation.targetCounts![bucket.id]!);
  const negative = input.profile.buckets.filter((bucket) => validation.observedCounts[bucket.id]! < validation.targetCounts![bucket.id]!);
  return positive.flatMap((outgoing) => negative.map((incoming) => ({ kind: "swap" as const, outgoingBucketId: outgoing.id, incomingBucketId: incoming.id })));
}

export function rankCompoProfileAdviceEvaluations<T extends CompoProfileAdviceEvaluation>(evaluations: readonly T[]): T[] {
  return [...evaluations].sort(compareCompoProfileAdviceEvaluations);
}

export function compareCompoProfileAdviceEvaluations(
  left: CompoProfileAdviceEvaluation,
  right: CompoProfileAdviceEvaluation,
): number {
  const normalizeScore = (value: number | null): number => value === null ? Number.POSITIVE_INFINITY : value;
  const leftImprovement = left.scoreImprovement ?? Number.NEGATIVE_INFINITY;
  const rightImprovement = right.scoreImprovement ?? Number.NEGATIVE_INFINITY;
  if (leftImprovement !== rightImprovement) return rightImprovement - leftImprovement;
  const leftResultingScore = normalizeScore(left.resultingScore);
  const rightResultingScore = normalizeScore(right.resultingScore);
  if (leftResultingScore !== rightResultingScore) return leftResultingScore - rightResultingScore;
  if (left.bandFitDistance !== right.bandFitDistance) return left.bandFitDistance - right.bandFitDistance;
  if (left.incomingPriority !== right.incomingPriority) return left.incomingPriority - right.incomingPriority;
  if (left.totalWeightJump !== right.totalWeightJump) return left.totalWeightJump - right.totalWeightJump;
  if (left.outgoingPriority !== right.outgoingPriority) return left.outgoingPriority - right.outgoingPriority;
  return left.description.localeCompare(right.description);
}
