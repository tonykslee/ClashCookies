import type { HeatMapRef } from "@prisma/client";
import {
  collapseCompoWarBucketCountsForDisplay,
  EMPTY_COMPO_WAR_BUCKET_COUNTS,
  EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS,
  type CompoWarBucketCounts,
  type CompoWarDisplayBucketCounts,
} from "./compoWarBucketCounts";
import type { CompoWarDisplayBucket } from "./compoWarWeightBuckets";
import {
  getCompoLegacyReferenceBucketCount,
  calculateProfileDeviationScore,
  getCompoProfileMaximumRepresentativeWeight,
  getCompoProfileRepresentativeWeight,
  LEGACY_COMPO_CALCULATION_PROFILE,
  projectCompoProfileCounts,
  resolveCompoProfileTargets,
  resolveLegacyProfileTargets,
  type CompoCalculationProfile,
  type CompoCalculationTargetStatus,
} from "./compoCalculationProfile";
import {
  findHeatMapRefForWeight,
  getHeatMapRefBandKey,
  getHeatMapRefBandMidpoint,
  listHeatMapRefsIntersectingWeightWindow,
} from "./compoHeatMap";

export const COMPO_ACTUAL_STATE_VIEWS = ["raw", "auto", "best"] as const;
export type CompoActualStateView = (typeof COMPO_ACTUAL_STATE_VIEWS)[number];

export const COMPO_ACTUAL_STATE_VIEW_LABELS: Record<
  CompoActualStateView,
  string
> = {
  raw: "Raw Data",
  auto: "Auto-Detect Band",
  best: "Best Fit",
};

export const COMPO_ACTUAL_STATE_HEALTHY_DEVIATION_THRESHOLD = 10;

export type CompoActualRosterCoverage =
  | "complete"
  | "stale"
  | "partial"
  | "contradictory"
  | "unavailable";

export type CompoActualRosterSourceStatus =
  | "IDLE"
  | "SUCCESS"
  | "FAILURE"
  | "NOOP"
  | "SKIPPED";

export function isCompoActualStateProjectionComplete(input: {
  unresolvedWeightCount: number;
}): boolean {
  return input.unresolvedWeightCount === 0;
}

export type CompoActualStateBaseMetrics = {
  resolvedTotalWeight: number;
  unresolvedWeightCount: number;
  unclassifiedWeightCount?: number;
  deferredWeightCount?: number;
  memberCount: number;
  /** Whether the persisted current-member rows establish an observed count. */
  memberCountEvidence?: "observed" | "unknown";
  /** Whether the persisted row set is authoritative enough for current-roster claims. */
  rosterCoverage?: CompoActualRosterCoverage;
  /** The CLAN_MEMBERS sync-state timestamp that establishes this row set. */
  rosterObservedAt?: Date | null;
  /** The most recent CLAN_MEMBERS sync status for this clan. */
  rosterSourceStatus?: CompoActualRosterSourceStatus | null;
  /** Bounded diagnostic explaining why current-roster claims are unavailable. */
  rosterEvidenceReason?: string | null;
  bucketCounts: CompoWarBucketCounts;
  /** Optional profile-space counts used by synthetic/profile-aware callers. */
  calculationCounts?: Readonly<Record<string, number>>;
};

export type CompoActualStateProjection = {
  view: CompoActualStateView;
  totalWeight: number;
  resolvedRosterWeight: number;
  missingWeights: number;
  memberCount: number;
  missingTo50Count: number;
  unresolvedWeightCount: number;
  deferredWeightCount: number;
  nMissing: number;
  displayCounts: CompoWarDisplayBucketCounts;
  selectedHeatMapRef: HeatMapRef | null;
  deltaByBucket: Record<CompoWarDisplayBucket, number | null>;
  deviationScore: number | null;
  /** Target evidence is independent from factual observations and never inferred from selection alone. */
  targetStatus?: CompoCalculationTargetStatus;
  calculationCounts?: Readonly<Record<string, number>>;
  targetCalculationCounts?: Readonly<Record<string, number>> | null;
};

type FillPlan = {
  fillCounts: CompoWarDisplayBucketCounts;
  addedWeight: number;
  status: "supported" | "unavailable";
  calculationCounts: Readonly<Record<string, number>>;
  targetCalculationCounts: Readonly<Record<string, number>> | null;
  reason: string | null;
};

/** Purpose: identify observed TH19 composition that cannot be compared with historical HeatMapRef targets. */
export function hasUnsupportedCompoTh19Target(
  counts: Pick<CompoWarDisplayBucketCounts, "TH19">,
): boolean {
  return (counts.TH19 ?? 0) > 0;
}

function buildEmptyDisplayCounts(): CompoWarDisplayBucketCounts {
  return {
    ...EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS,
  };
}

function getProfileDisplayBucketIds(profile: CompoCalculationProfile): string[] {
  return [...new Set(profile.buckets.map((bucket) => profile.compatibility.displayBucketByCalculationBucket[bucket.id]))];
}

function buildCalculationDeltaByDisplay(input: {
  profile: CompoCalculationProfile;
  observedCounts: Readonly<Record<string, number>>;
  targetCounts: Readonly<Record<string, number>> | null;
  displayCounts: CompoWarDisplayBucketCounts;
}): Record<CompoWarDisplayBucket, number | null> {
  const result: Record<string, number | null> = {};
  for (const displayBucket of getProfileDisplayBucketIds(input.profile)) result[displayBucket] = null;
  if (!input.targetCounts) {
    if ((input.displayCounts.TH19 ?? 0) > 0) result.TH19 = null;
    return result as Record<CompoWarDisplayBucket, number | null>;
  }
  for (const bucket of input.profile.buckets) {
    const displayBucket = input.profile.compatibility.displayBucketByCalculationBucket[bucket.id];
    const delta = input.observedCounts[bucket.id]! - input.targetCounts[bucket.id]!;
    result[displayBucket] = (result[displayBucket] ?? 0) + delta;
  }
  return result as Record<CompoWarDisplayBucket, number | null>;
}

function getProfileTargetResolution(
  profile: CompoCalculationProfile,
  heatMapRef: HeatMapRef | null,
) {
  if (profile === LEGACY_COMPO_CALCULATION_PROFILE) {
    return resolveLegacyProfileTargets(heatMapRef);
  }
  return resolveCompoProfileTargets({
    profile,
    reference: heatMapRef,
    readCount: getCompoLegacyReferenceBucketCount,
  });
}

export function getSupportedCompoCalculationHeatMapRefs(
  heatMapRefs: readonly HeatMapRef[],
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): HeatMapRef[] {
  return heatMapRefs.filter(
    (ref) => getProfileTargetResolution(profile, ref).status === "supported",
  );
}

function deriveCalculationCounts(input: {
  profile: CompoCalculationProfile;
  base: CompoActualStateBaseMetrics;
}): { counts: Record<string, number>; unsupportedPositive: boolean } {
  if (input.base.calculationCounts) {
    return {
      counts: { ...input.base.calculationCounts },
      unsupportedPositive: Object.entries(input.base.bucketCounts).some(
        ([factualBucket, count]) =>
          count > 0 && input.profile.factualToCalculationBucket[factualBucket] == null,
      ),
    };
  }
  const counts: Record<string, number> = {};
  for (const bucket of input.profile.buckets) {
    counts[bucket.id] = bucket.sourceBucketIds.reduce(
      (sum, sourceBucketId) => sum + (input.base.bucketCounts[sourceBucketId as keyof CompoWarBucketCounts] ?? 0),
      0,
    );
  }
  const unsupportedPositive = Object.entries(input.base.bucketCounts).some(
    ([factualBucket, count]) =>
      count > 0 && input.profile.factualToCalculationBucket[factualBucket] === null,
  );
  return { counts, unsupportedPositive };
}

function buildTargetCounts(
  heatMapRef: HeatMapRef,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): { displayCounts: CompoWarDisplayBucketCounts; calculationCounts: Readonly<Record<string, number>> } | null {
  const resolved = getProfileTargetResolution(profile, heatMapRef);
  if (resolved.status !== "supported") return null;
  const displayCounts: CompoWarDisplayBucketCounts = { ...EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS };
  for (const bucket of profile.buckets) {
    const displayBucket = profile.compatibility.displayBucketByCalculationBucket[bucket.id] as CompoWarDisplayBucket;
    displayCounts[displayBucket] = (displayCounts[displayBucket] ?? 0) + (resolved.counts[bucket.id] ?? 0);
  }
  return { displayCounts, calculationCounts: resolved.counts };
}

/** Purpose: expose the exact target display counts implied by one HeatMapRef. */
export function getCompoActualStateTargetDisplayCounts(
  heatMapRef: HeatMapRef | null,
): CompoWarDisplayBucketCounts | null {
  return heatMapRef ? buildTargetCounts(heatMapRef)?.displayCounts ?? null : null;
}

/** Purpose: expose planner-friendly target bucket counts for one HeatMapRef, collapsing the low display band into TH13. */
export function getCompoActualStateTargetBucketCounts(
  heatMapRef: HeatMapRef | null,
): CompoWarBucketCounts | null {
  if (!heatMapRef) {
    return null;
  }

  const resolved = resolveLegacyProfileTargets(heatMapRef);
  if (resolved.status !== "supported") return null;
  const counts: CompoWarBucketCounts = { ...EMPTY_COMPO_WAR_BUCKET_COUNTS };
  for (const bucket of LEGACY_COMPO_CALCULATION_PROFILE.buckets) {
    const plannerBucket = bucket.id === "<=TH13"
      ? "TH13"
      : bucket.id;
    counts[plannerBucket as keyof CompoWarBucketCounts] = resolved.counts[bucket.id]!;
  }
  return counts;
}

export function getCompoActualStateDeltaByBucket(
  counts: CompoWarDisplayBucketCounts,
  heatMapRef: HeatMapRef | null,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): Record<CompoWarDisplayBucket, number | null> {
  const result: Record<string, number | null> = {};
  const target = heatMapRef ? buildTargetCounts(heatMapRef, profile) : null;
  for (const displayBucket of getProfileDisplayBucketIds(profile)) result[displayBucket] = null;
  const malformedCounts = Object.values(counts).some(
    (value) => !Number.isSafeInteger(value) || value < 0,
  );
  const unsupportedObserved =
    (counts.TH19 ?? 0) > 0 && profile.factualToCalculationBucket.TH19 == null;
  if (!target || malformedCounts || unsupportedObserved) {
    if ((counts.TH19 ?? 0) > 0) result.TH19 = null;
    return result as Record<CompoWarDisplayBucket, number | null>;
  }
  for (const bucket of profile.buckets) {
    const displayBucket = profile.compatibility.displayBucketByCalculationBucket[bucket.id];
    const observed = counts[displayBucket as keyof CompoWarDisplayBucketCounts] ?? 0;
    const delta = observed - target.displayCounts[displayBucket as keyof CompoWarDisplayBucketCounts]!;
    result[displayBucket] = (result[displayBucket] ?? 0) + delta;
  }
  return result as Record<CompoWarDisplayBucket, number | null>;
}

/** Purpose: compute the spreadsheet-style weighted deviation score for one projected ACTUAL or WAR display state. */
export function calculateCompoDeviationScore(input: {
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRef: HeatMapRef | null;
  profile?: CompoCalculationProfile;
  calculationCounts?: Readonly<Record<string, number>>;
}): number | null {
  const profile = input.profile ?? LEGACY_COMPO_CALCULATION_PROFILE;
  const unsupportedObserved =
    (input.displayCounts.TH19 ?? 0) > 0 && profile.factualToCalculationBucket.TH19 == null;
  if (!input.heatMapRef || unsupportedObserved) {
    return null;
  }

  const target = buildTargetCounts(input.heatMapRef, profile);
  if (!target) {
    return null;
  }
  const observedCounts = input.calculationCounts ?? Object.fromEntries(
    profile.buckets.map((bucket) => {
      const displayBucket = profile.compatibility.displayBucketByCalculationBucket[bucket.id] as keyof CompoWarDisplayBucketCounts;
      return [bucket.id, input.displayCounts[displayBucket] ?? 0];
    }),
  );
  return calculateProfileDeviationScore({
    profile,
    observedCounts,
    targetCounts: target.calculationCounts,
  });
}

/** Purpose: classify ACTUAL compo deviation scores using the shared readiness threshold. */
export function isCompoActualStateDeviationHealthy(
  deviationScore: number | null | undefined,
): boolean {
  return (
    deviationScore !== null &&
    deviationScore !== undefined &&
    Number.isFinite(deviationScore) &&
    deviationScore <= COMPO_ACTUAL_STATE_HEALTHY_DEVIATION_THRESHOLD
  );
}

function getRepresentativeWeight(
  bucket: CompoWarDisplayBucket,
  heatMapRef: HeatMapRef | null,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): number {
  const calculationBucket = profile.buckets.find(
    (candidate) => profile.compatibility.displayBucketByCalculationBucket[candidate.id] === bucket,
  )?.id;
  if (!calculationBucket) throw new Error(`${bucket} representative weight is unavailable`);
  const representative = getCompoProfileRepresentativeWeight(profile, calculationBucket, heatMapRef);
  if (representative === null) throw new Error(`${bucket} representative weight is unavailable`);
  return representative;
}

/** Purpose: estimate one representative total-weight delta for a displayed ACTUAL/WAR bucket. */
export function getCompoDisplayBucketRepresentativeWeight(
  bucket: CompoWarDisplayBucket,
  heatMapRef: HeatMapRef | null,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): number {
  return getRepresentativeWeight(bucket, heatMapRef, profile);
}

function addDisplayCounts(
  base: CompoWarDisplayBucketCounts,
  fillCounts: CompoWarDisplayBucketCounts,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
): CompoWarDisplayBucketCounts {
  const result = Object.fromEntries(
    Object.keys(EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS).map((bucket) => [
      bucket,
      (base[bucket as keyof CompoWarDisplayBucketCounts] ?? 0) +
        (fillCounts[bucket as keyof CompoWarDisplayBucketCounts] ?? 0),
    ]),
  ) as CompoWarDisplayBucketCounts;
  const th19 = (base.TH19 ?? 0) + (fillCounts.TH19 ?? 0);
  if (th19 > 0 || getProfileDisplayBucketIds(profile).includes("TH19")) result.TH19 = th19;
  return result;
}

function buildFillPlan(input: {
  displayCounts: CompoWarDisplayBucketCounts;
  nMissing: number;
  heatMapRef: HeatMapRef | null;
  calculationCounts: Readonly<Record<string, number>>;
  profile: CompoCalculationProfile;
}): FillPlan {
  const fillCounts = buildEmptyDisplayCounts();
  const target = getProfileTargetResolution(input.profile, input.heatMapRef);
  if (!input.heatMapRef || target.status !== "supported") {
    return {
      fillCounts,
      addedWeight: 0,
      status: "unavailable",
      calculationCounts: input.calculationCounts,
      targetCalculationCounts: target.status === "supported" ? target.counts : null,
      reason: target.reason ?? "target evidence is unavailable",
    };
  }
  const projected = projectCompoProfileCounts({
    profile: input.profile,
    observedCounts: input.calculationCounts,
    targetCounts: target.counts,
    missingCount: input.nMissing,
    reference: input.heatMapRef,
  });
  if (projected.status !== "supported") {
    return {
      fillCounts,
      addedWeight: 0,
      status: "unavailable",
      calculationCounts: input.calculationCounts,
      targetCalculationCounts: target.counts,
      reason: projected.reason,
    };
  }
  for (const bucket of input.profile.buckets) {
    const displayBucket = input.profile.compatibility.displayBucketByCalculationBucket[bucket.id] as keyof CompoWarDisplayBucketCounts;
    const fill = Math.max(0, projected.counts[bucket.id]! - input.calculationCounts[bucket.id]!);
    if (displayBucket in fillCounts) fillCounts[displayBucket] = (fillCounts[displayBucket] ?? 0) + fill;
  }
  return {
    fillCounts,
    addedWeight: projected.addedWeight,
    status: "supported",
    calculationCounts: projected.counts,
    targetCalculationCounts: target.counts,
    reason: null,
  };
}

function buildEstimatedProjectionForBand(input: {
  view: "auto" | "best";
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRef: HeatMapRef;
  profile: CompoCalculationProfile;
  calculationCounts: Readonly<Record<string, number>>;
}): CompoActualStateProjection {
  const missingTo50Count = Math.max(0, 50 - input.base.memberCount);
  const nMissing = missingTo50Count + input.base.unresolvedWeightCount;
  const deferredWeightCount = input.base.deferredWeightCount ?? 0;
  const fillPlan = buildFillPlan({
    displayCounts: input.displayCounts,
    nMissing,
    heatMapRef: input.heatMapRef,
    calculationCounts: input.calculationCounts,
    profile: input.profile,
  });
  if (fillPlan.status !== "supported") {
    return {
      view: input.view,
      totalWeight: input.base.resolvedTotalWeight,
      resolvedRosterWeight: input.base.resolvedTotalWeight,
      missingWeights: nMissing,
      memberCount: input.base.memberCount,
      missingTo50Count,
      unresolvedWeightCount: input.base.unresolvedWeightCount,
      deferredWeightCount,
      nMissing,
      displayCounts: input.displayCounts,
      selectedHeatMapRef: null,
      deltaByBucket: buildCalculationDeltaByDisplay({ profile: input.profile, observedCounts: input.calculationCounts, targetCounts: null, displayCounts: input.displayCounts }),
      deviationScore: null,
      targetStatus: "unavailable",
      calculationCounts: input.calculationCounts,
      targetCalculationCounts: null,
    };
  }
  const estimatedDisplayCounts = addDisplayCounts(
    input.displayCounts,
    fillPlan.fillCounts,
    input.profile,
  );
  const deltaByBucket = buildCalculationDeltaByDisplay({
    profile: input.profile,
    observedCounts: fillPlan.calculationCounts,
    targetCounts: fillPlan.targetCalculationCounts,
    displayCounts: estimatedDisplayCounts,
  });
  const deviationScore = calculateProfileDeviationScore({
    profile: input.profile,
    observedCounts: fillPlan.calculationCounts,
    targetCounts: fillPlan.targetCalculationCounts,
  });

  return {
    view: input.view,
    totalWeight: input.base.resolvedTotalWeight + fillPlan.addedWeight,
    resolvedRosterWeight: input.base.resolvedTotalWeight,
    missingWeights: nMissing,
    memberCount: input.base.memberCount,
    missingTo50Count,
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    deferredWeightCount,
    nMissing,
    displayCounts: estimatedDisplayCounts,
    selectedHeatMapRef: input.heatMapRef,
    deltaByBucket,
    deviationScore,
    targetStatus: "supported",
    calculationCounts: fillPlan.calculationCounts,
    targetCalculationCounts: fillPlan.targetCalculationCounts,
  };
}

function compareHeatMapRefResolvedFit(
  left: HeatMapRef,
  right: HeatMapRef,
  input: {
    displayCounts: CompoWarDisplayBucketCounts;
    resolvedTotalWeight: number;
    profile: CompoCalculationProfile;
    calculationCounts: Readonly<Record<string, number>>;
  },
): number {
  const leftScore = calculateCompoDeviationScore({
    displayCounts: input.displayCounts,
    heatMapRef: left,
    profile: input.profile,
    calculationCounts: input.calculationCounts,
  });
  const rightScore = calculateCompoDeviationScore({
    displayCounts: input.displayCounts,
    heatMapRef: right,
    profile: input.profile,
    calculationCounts: input.calculationCounts,
  });
  const leftNormalizedScore = leftScore ?? Number.POSITIVE_INFINITY;
  const rightNormalizedScore = rightScore ?? Number.POSITIVE_INFINITY;
  if (leftNormalizedScore !== rightNormalizedScore) {
    return leftNormalizedScore - rightNormalizedScore;
  }

  const leftContainsWeight =
    input.resolvedTotalWeight >= left.weightMinInclusive &&
    input.resolvedTotalWeight <= left.weightMaxInclusive;
  const rightContainsWeight =
    input.resolvedTotalWeight >= right.weightMinInclusive &&
    input.resolvedTotalWeight <= right.weightMaxInclusive;
  if (leftContainsWeight !== rightContainsWeight) {
    return leftContainsWeight ? -1 : 1;
  }

  const leftMidpointDistance = Math.abs(
    getHeatMapRefBandMidpoint(left) - input.resolvedTotalWeight,
  );
  const rightMidpointDistance = Math.abs(
    getHeatMapRefBandMidpoint(right) - input.resolvedTotalWeight,
  );
  if (leftMidpointDistance !== rightMidpointDistance) {
    return leftMidpointDistance - rightMidpointDistance;
  }

  if (left.weightMaxInclusive !== right.weightMaxInclusive) {
    return left.weightMaxInclusive - right.weightMaxInclusive;
  }
  if (left.weightMinInclusive !== right.weightMinInclusive) {
    return left.weightMinInclusive - right.weightMinInclusive;
  }
  return getHeatMapRefBandKey(left).localeCompare(getHeatMapRefBandKey(right));
}

function selectBestFitHeatMapRefForResolvedCounts(input: {
  heatMapRefs: readonly HeatMapRef[];
  displayCounts: CompoWarDisplayBucketCounts;
  resolvedTotalWeight: number;
  profile: CompoCalculationProfile;
  calculationCounts: Readonly<Record<string, number>>;
}): HeatMapRef | null {
  if (input.heatMapRefs.length === 0) {
    return null;
  }

  return [...input.heatMapRefs].sort((left, right) =>
    compareHeatMapRefResolvedFit(left, right, input),
  )[0] ?? null;
}

function compareProjectionByBandFit(
  left: CompoActualStateProjection,
  right: CompoActualStateProjection,
): CompoActualStateProjection {
  const leftBandMidpoint = left.selectedHeatMapRef
    ? getHeatMapRefBandMidpoint(left.selectedHeatMapRef)
    : Number.POSITIVE_INFINITY;
  const rightBandMidpoint = right.selectedHeatMapRef
    ? getHeatMapRefBandMidpoint(right.selectedHeatMapRef)
    : Number.POSITIVE_INFINITY;
  const leftDistance = Math.abs(left.totalWeight - leftBandMidpoint);
  const rightDistance = Math.abs(right.totalWeight - rightBandMidpoint);
  if (leftDistance !== rightDistance) {
    return leftDistance < rightDistance ? left : right;
  }
  const leftBandMax = left.selectedHeatMapRef?.weightMaxInclusive ?? -1;
  const rightBandMax = right.selectedHeatMapRef?.weightMaxInclusive ?? -1;
  return rightBandMax > leftBandMax ? right : left;
}

function buildRawProjection(input: {
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRefs: readonly HeatMapRef[];
  profile: CompoCalculationProfile;
}): CompoActualStateProjection {
  const calculationState = deriveCalculationCounts({ profile: input.profile, base: input.base });
  const validRefs = getSupportedCompoCalculationHeatMapRefs(input.heatMapRefs, input.profile);
  const matchedHeatMapRef = findHeatMapRefForWeight(
    validRefs,
    input.base.resolvedTotalWeight,
  );
  const heatMapRef = calculationState.unsupportedPositive
    ? null
    : matchedHeatMapRef;
  const target = getProfileTargetResolution(input.profile, heatMapRef);
  const deferredWeightCount = input.base.deferredWeightCount ?? 0;
  return {
    view: "raw",
    totalWeight: input.base.resolvedTotalWeight,
    resolvedRosterWeight: input.base.resolvedTotalWeight,
    missingWeights: input.base.unresolvedWeightCount,
    memberCount: input.base.memberCount,
    missingTo50Count: Math.max(0, 50 - input.base.memberCount),
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    deferredWeightCount,
    nMissing:
      Math.max(0, 50 - input.base.memberCount) + input.base.unresolvedWeightCount,
    displayCounts: input.displayCounts,
    selectedHeatMapRef: heatMapRef,
    deltaByBucket: buildCalculationDeltaByDisplay({
      profile: input.profile,
      observedCounts: calculationState.counts,
      targetCounts: target.status === "supported" ? target.counts : null,
      displayCounts: input.displayCounts,
    }),
    deviationScore: null,
    targetStatus:
      calculationState.unsupportedPositive
        ? "unavailable"
        : target.status === "missing" && validRefs.length === 0 && input.heatMapRefs.length > 0
          ? "invalid"
          : target.status,
    calculationCounts: calculationState.counts,
    targetCalculationCounts: target.status === "supported" ? target.counts : null,
  };
}

function buildAutoProjection(input: {
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRefs: readonly HeatMapRef[];
  profile: CompoCalculationProfile;
}): CompoActualStateProjection {
  const rawProjection = buildRawProjection(input);
  if (!rawProjection.selectedHeatMapRef) {
    return {
      ...rawProjection,
      view: "auto",
      missingWeights: rawProjection.nMissing,
    };
  }

  if (rawProjection.nMissing <= 0) {
    return {
      ...rawProjection,
      view: "auto",
      missingWeights: rawProjection.nMissing,
      deviationScore: calculateCompoDeviationScore({
        displayCounts: rawProjection.displayCounts,
        heatMapRef: rawProjection.selectedHeatMapRef,
        profile: input.profile,
        calculationCounts: rawProjection.calculationCounts,
      }),
    };
  }

  const selectedHeatMapRef =
    selectBestFitHeatMapRefForResolvedCounts({
      heatMapRefs: input.heatMapRefs,
      displayCounts: input.displayCounts,
      resolvedTotalWeight: rawProjection.totalWeight,
      profile: input.profile,
      calculationCounts: rawProjection.calculationCounts ?? {},
    }) ?? rawProjection.selectedHeatMapRef;
  const fillPlan = buildFillPlan({
    displayCounts: input.displayCounts,
    nMissing: rawProjection.nMissing,
    heatMapRef: selectedHeatMapRef,
    calculationCounts: rawProjection.calculationCounts ?? {},
    profile: input.profile,
  });
  if (fillPlan.status !== "supported") {
    return { ...rawProjection, view: "auto", selectedHeatMapRef: null, targetStatus: "unavailable", targetCalculationCounts: null };
  }
  const targetDelta = buildCalculationDeltaByDisplay({
    profile: input.profile,
    observedCounts: rawProjection.calculationCounts ?? {},
    targetCounts: fillPlan.targetCalculationCounts,
    displayCounts: input.displayCounts,
  });

  return {
    view: "auto",
    totalWeight: rawProjection.totalWeight + fillPlan.addedWeight,
    resolvedRosterWeight: rawProjection.resolvedRosterWeight,
    missingWeights: rawProjection.nMissing,
    memberCount: rawProjection.memberCount,
    missingTo50Count: rawProjection.missingTo50Count,
    unresolvedWeightCount: rawProjection.unresolvedWeightCount,
    deferredWeightCount: rawProjection.deferredWeightCount,
    nMissing: rawProjection.nMissing,
    displayCounts: input.displayCounts,
    selectedHeatMapRef,
    deltaByBucket: targetDelta,
    deviationScore: calculateCompoDeviationScore({
      displayCounts: input.displayCounts,
      heatMapRef: selectedHeatMapRef,
      profile: input.profile,
      calculationCounts: rawProjection.calculationCounts,
    }),
    targetStatus: "supported",
    calculationCounts: rawProjection.calculationCounts,
    targetCalculationCounts: fillPlan.targetCalculationCounts,
  };
}

function buildBestFitProjection(input: {
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRefs: readonly HeatMapRef[];
  profile: CompoCalculationProfile;
}): CompoActualStateProjection {
  const rawProjection = buildRawProjection(input);
  if (!rawProjection.selectedHeatMapRef) {
    return {
      ...rawProjection,
      view: "best",
      missingWeights: rawProjection.nMissing,
    };
  }

  const maximumRepresentativeWeight = getCompoProfileMaximumRepresentativeWeight(
    input.profile,
    rawProjection.selectedHeatMapRef,
  );
  if (maximumRepresentativeWeight === null) {
    return {
      ...rawProjection,
      view: "best",
      missingWeights: rawProjection.nMissing,
      selectedHeatMapRef: null,
      deltaByBucket: getCompoActualStateDeltaByBucket(input.displayCounts, null, input.profile),
      targetStatus: "unavailable",
    };
  }
  const maxEstimatedTotal =
    input.base.resolvedTotalWeight + rawProjection.nMissing * maximumRepresentativeWeight;
  const validRefs = getSupportedCompoCalculationHeatMapRefs(input.heatMapRefs, input.profile);
  const candidates = listHeatMapRefsIntersectingWeightWindow(
    validRefs,
    input.base.resolvedTotalWeight,
    maxEstimatedTotal,
  );
  const candidateRefs = candidates.length > 0 ? candidates : [rawProjection.selectedHeatMapRef];

  return candidateRefs
    .map((heatMapRef) =>
      buildEstimatedProjectionForBand({
        view: "best",
        base: input.base,
        displayCounts: input.displayCounts,
        heatMapRef,
        profile: input.profile,
        calculationCounts: rawProjection.calculationCounts ?? {},
      }),
    )
    .sort((left, right) => {
      const leftScore = left.deviationScore ?? Number.POSITIVE_INFINITY;
      const rightScore = right.deviationScore ?? Number.POSITIVE_INFINITY;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      const totalDistance =
        Math.abs(left.totalWeight - input.base.resolvedTotalWeight) -
        Math.abs(right.totalWeight - input.base.resolvedTotalWeight);
      if (totalDistance !== 0) {
        return totalDistance;
      }
      return (
        (right.selectedHeatMapRef?.weightMaxInclusive ?? -1) -
        (left.selectedHeatMapRef?.weightMaxInclusive ?? -1)
      );
    })[0];
}

export function projectCompoActualStateView(input: {
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  profile?: CompoCalculationProfile;
}): CompoActualStateProjection {
  const profile = input.profile ?? LEGACY_COMPO_CALCULATION_PROFILE;
  const displayCounts = collapseCompoWarBucketCountsForDisplay(input.base.bucketCounts);

  if (input.view === "raw") {
    return buildRawProjection({
      base: input.base,
      displayCounts,
      heatMapRefs: input.heatMapRefs,
      profile,
    });
  }
  if (input.view === "auto") {
    return buildAutoProjection({
      base: input.base,
      displayCounts,
      heatMapRefs: input.heatMapRefs,
      profile,
    });
  }
  return buildBestFitProjection({
    base: input.base,
    displayCounts,
    heatMapRefs: input.heatMapRefs,
    profile,
  });
}

export const getCompoActualStateViewLabel = (
  view: CompoActualStateView,
): string => COMPO_ACTUAL_STATE_VIEW_LABELS[view];
