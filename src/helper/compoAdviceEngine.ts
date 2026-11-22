import type { HeatMapRef } from "@prisma/client";
import {
  calculateCompoDeviationScore,
  getCompoActualStateDeltaByBucket,
  getSupportedCompoCalculationHeatMapRefs,
  projectCompoActualStateView,
  type CompoActualStateBaseMetrics,
  type CompoActualStateProjection,
} from "./compoActualStateView";
import {
  formatHeatMapRefBandLabel,
  getHeatMapRefBandKey,
  getHeatMapRefBandMidpoint,
  getHeatMapRefAdviceMidpoint,
} from "./compoHeatMap";
import { buildFwaWeightPageUrl } from "../services/FwaWeightCatalogService";
import type { CompoWarBucketCounts } from "./compoWarBucketCounts";
import type { CompoWarDisplayBucket } from "./compoWarWeightBuckets";
import {
  generateProfileAdviceActions,
  getCompoLegacyReferenceBucketCount,
  getCompoProfileRepresentativeWeight,
  LEGACY_COMPO_CALCULATION_PROFILE,
  compareCompoProfileAdviceEvaluations,
  rankCompoProfileAdviceEvaluations,
  resolveCompoProfileTargets,
  type CompoCalculationProfile,
  type CompoProfileAdviceEvaluation,
  type CompoProfileReferenceCountReader,
} from "./compoCalculationProfile";

export const COMPO_ADVICE_DISPLAY_BUCKETS: readonly CompoWarDisplayBucket[] =
  LEGACY_COMPO_CALCULATION_PROFILE.buckets.map(
    (bucket) => bucket.id as CompoWarDisplayBucket,
  );

export const COMPO_ADVICE_VIEWS = [
  "raw",
  "auto",
  "best",
  "custom",
] as const;
export type CompoAdviceView = (typeof COMPO_ADVICE_VIEWS)[number];

export type CompoAdviceMode = "actual" | "war";

export const COMPO_ADVICE_VIEW_LABELS: Record<CompoAdviceView, string> = {
  raw: "Raw Data",
  auto: "Auto-Detect Band",
  best: "Best Fit",
  custom: "Custom",
};

export const COMPO_ADVICE_DEVIATION_PENALTY_CONSTANT = 0.0018;

export type CompoAdviceAction =
  | {
      kind: "add";
      incomingBucket: CompoWarDisplayBucket;
    }
  | {
      kind: "swap";
      outgoingBucket: CompoWarDisplayBucket;
      incomingBucket: CompoWarDisplayBucket;
    };

type ProfileBackedCompoAdviceAction = CompoAdviceAction & {
  incomingCalculationBucketId: string;
  outgoingCalculationBucketId?: string;
};

export type CompoAdviceEvaluation = {
  action: CompoAdviceAction;
  description: string;
  beforeProjection: CompoActualStateProjection;
  afterProjection: CompoActualStateProjection;
  currentScore: number | null;
  resultingScore: number | null;
  scoreImprovement: number | null;
  bandFitDistance: number;
  totalWeightJump: number;
  incomingPriority: number;
  outgoingPriority: number;
};

export type CompoAdviceSummary = {
  mode: CompoAdviceMode;
  view: CompoAdviceView;
  viewLabel: string;
  currentProjection: CompoActualStateProjection;
  projectedProjection: CompoActualStateProjection | null;
  targetDeltaByBucket: Record<CompoWarDisplayBucket, number | null>;
  heatMapRefs: readonly HeatMapRef[];
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
  resolvedRosterWeight: number;
  currentWeight: number | null;
  targetBandMidpoint: number | null;
  currentMatchrate: number | null;
  targetBandMatchrate: number | null;
  resultingMatchrate: number | null;
  currentScore: number | null;
  currentBandLabel: string;
  targetBandLabel: string;
  targetHeatMapRef: HeatMapRef | null;
  recommendationText: string;
  resultingScore: number | null;
  resultingBandLabel: string;
  alternateTexts: string[];
  statusText: string | null;
  selectedCustomBandIndex: number | null;
  customBandCount: number;
};

function formatScore(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function formatFullWeight(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  return Math.trunc(value).toLocaleString("en-US");
}

function normalizeMatchrate(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.abs(value) > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

export function formatMatchratePercent(value: number | null | undefined): string {
  const normalized = normalizeMatchrate(value);
  return normalized === null ? "Unknown" : `${(normalized * 100).toFixed(2)}%`;
}

export function estimateMatchrateFromDeviation(input: {
  bandMatchrate: number | null | undefined;
  deviationScore: number | null | undefined;
  penaltyConstant?: number;
}): number | null {
  if (
    input.deviationScore === null ||
    input.deviationScore === undefined ||
    !Number.isFinite(input.deviationScore)
  ) {
    return null;
  }

  const bandMatchrate = normalizeMatchrate(input.bandMatchrate);
  if (bandMatchrate === null) {
    return null;
  }

  const penaltyConstant = input.penaltyConstant ?? COMPO_ADVICE_DEVIATION_PENALTY_CONSTANT;
  const estimated = bandMatchrate - input.deviationScore * penaltyConstant;
  return Math.max(0, Math.min(1, estimated));
}

function formatCompactWeight(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }

  const magnitude = Math.abs(value);
  const formatScaled = (scaled: number, suffix: string): string => {
    const text = scaled.toFixed(3).replace(/\.?0+$/, "");
    return `${text}${suffix}`;
  };

  if (magnitude >= 1_000_000_000) {
    return formatScaled(magnitude / 1_000_000_000, "b");
  }
  if (magnitude >= 1_000_000) {
    return formatScaled(magnitude / 1_000_000, "m");
  }
  if (magnitude >= 1_000) {
    return formatScaled(magnitude / 1_000, "k");
  }
  return `${magnitude}`;
}

function formatSignedCompactWeight(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }

  const normalized = Math.trunc(value);
  const sign = normalized >= 0 ? "+" : "-";
  return `${sign}${formatCompactWeight(Math.abs(normalized))}`;
}

export function buildCompoActualDeltaLines(input: {
  deltaByBucket: Record<CompoWarDisplayBucket, number | null>;
}): string[] {
  const lines = COMPO_ADVICE_DISPLAY_BUCKETS.flatMap((bucket) => {
    const delta = input.deltaByBucket[bucket];
    if (
      delta === null ||
      delta === undefined ||
      !Number.isFinite(delta) ||
      Math.trunc(delta) === 0
    ) {
      return [] as string[];
    }

    const normalized = Math.trunc(delta);
    const sign = normalized > 0 ? "+" : "";
    return [`${bucket}: ${sign}${normalized}`];
  });

  if (input.deltaByBucket.TH19 === null) {
    lines.unshift("TH19: unknown (historical target unavailable)");
  }
  return lines.length > 0 ? lines : ["No raw roster deficits detected."];
}

function formatBandMidpointLine(input: {
  currentWeight: number | null | undefined;
  targetBandMidpoint: number | null | undefined;
  selectedHeatMapRef: HeatMapRef | null;
}): string {
  if (
    input.currentWeight === null ||
    input.currentWeight === undefined ||
    input.targetBandMidpoint === null ||
    input.targetBandMidpoint === undefined ||
    input.selectedHeatMapRef === null ||
    !Number.isFinite(input.currentWeight) ||
    !Number.isFinite(input.targetBandMidpoint)
  ) {
    return "unknown";
  }

  const withinDisplayedBand =
    input.currentWeight >= input.selectedHeatMapRef.weightMinInclusive &&
    input.currentWeight <= input.selectedHeatMapRef.weightMaxInclusive;
  const warning = withinDisplayedBand ? "" : ":warning: ";
  return `${warning}${formatSignedCompactWeight(input.targetBandMidpoint - input.currentWeight)}`;
}

export function formatSignedCompoAdviceDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) {
    return "unknown";
  }

  const normalized = Number(delta);
  if (Math.abs(normalized) < Number.EPSILON) {
    return "-> +0";
  }

  const arrow =
    normalized > 0 ? ":small_red_triangle:" : ":small_red_triangle_down:";
  const sign = normalized > 0 ? "+" : "-";
  return `${arrow} ${sign}${formatCompactWeight(Math.abs(normalized))}`;
}

function getBandLabel(ref: HeatMapRef | null): string {
  return ref ? formatHeatMapRefBandLabel(ref) : "(no band)";
}

export function getAdjacentHeatMapRefs(input: {
  heatMapRefs: readonly HeatMapRef[];
  selectedHeatMapRef: HeatMapRef | null;
}): {
  lower: HeatMapRef | null;
  higher: HeatMapRef | null;
} {
  if (!input.selectedHeatMapRef || input.heatMapRefs.length === 0) {
    return { lower: null, higher: null };
  }

  const selectedKey = getHeatMapRefBandKey(input.selectedHeatMapRef);
  const index = input.heatMapRefs.findIndex(
    (ref) => getHeatMapRefBandKey(ref) === selectedKey,
  );
  if (index < 0) {
    return { lower: null, higher: null };
  }

  return {
    lower: index > 0 ? input.heatMapRefs[index - 1] ?? null : null,
    higher: index < input.heatMapRefs.length - 1 ? input.heatMapRefs[index + 1] ?? null : null,
  };
}

function getBandMatchrate(input: {
  summary: Pick<CompoAdviceSummary, "currentProjection" | "bandMatchRatesByBandKey">;
  heatMapRef: HeatMapRef | null;
}): number | null {
  if (!input.heatMapRef) {
    return null;
  }
  const bandKey = getHeatMapRefBandKey(input.heatMapRef);
  return input.summary.bandMatchRatesByBandKey?.get(bandKey) ?? null;
}

function getProfileDisplayBucket(profile: CompoCalculationProfile, calculationBucketId: string): CompoWarDisplayBucket | null {
  const displayBucket = profile.compatibility.displayBucketByCalculationBucket[calculationBucketId];
  return displayBucket as CompoWarDisplayBucket | null;
}

function getProfileCalculationBucket(profile: CompoCalculationProfile, displayBucket: CompoWarDisplayBucket): string | null {
  return profile.buckets.find(
    (bucket) => profile.compatibility.displayBucketByCalculationBucket[bucket.id] === displayBucket,
  )?.id ?? null;
}

function getProfileDisplayBucketPriority(profile: CompoCalculationProfile, displayBucket: CompoWarDisplayBucket): number {
  const calculationBucket = getProfileCalculationBucket(profile, displayBucket);
  return calculationBucket
    ? profile.buckets.find((bucket) => bucket.id === calculationBucket)?.actionPriority ?? Number.POSITIVE_INFINITY
    : Number.POSITIVE_INFINITY;
}

function getCalculationBucketPriority(profile: CompoCalculationProfile, calculationBucketId: string): number {
  return profile.buckets.find((bucket) => bucket.id === calculationBucketId)?.actionPriority ?? Number.POSITIVE_INFINITY;
}

function compareEvaluations(
  left: CompoAdviceEvaluation,
  right: CompoAdviceEvaluation,
): number {
  return compareCompoProfileAdviceEvaluations(left, right);
}

function buildAdviceActionDescription(action: CompoAdviceAction): string {
  if (action.kind === "add") {
    return `Add ${action.incomingBucket}`;
  }
  return `Replace one ${action.outgoingBucket} with one ${action.incomingBucket}`;
}

function cloneBucketCounts(
  counts: CompoWarBucketCounts,
): CompoWarBucketCounts {
  return { ...counts };
}

function sortHeatMapRefs(refs: readonly HeatMapRef[]): HeatMapRef[] {
  return [...refs].sort((left, right) => {
    if (left.weightMinInclusive !== right.weightMinInclusive) {
      return left.weightMinInclusive - right.weightMinInclusive;
    }
    if (left.weightMaxInclusive !== right.weightMaxInclusive) {
      return left.weightMaxInclusive - right.weightMaxInclusive;
    }
    return getHeatMapRefBandKey(left).localeCompare(getHeatMapRefBandKey(right));
  });
}

function getHeatMapRefIndex(
  refs: readonly HeatMapRef[],
  target: HeatMapRef | null,
): number | null {
  if (!target) return null;
  const targetKey = getHeatMapRefBandKey(target);
  const index = refs.findIndex(
    (ref) => getHeatMapRefBandKey(ref) === targetKey,
  );
  return index >= 0 ? index : null;
}

function clampHeatMapRefIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(length - 1, Math.trunc(index)));
}

function resolveCustomHeatMapRef(input: {
  heatMapRefs: readonly HeatMapRef[];
  currentProjection: CompoActualStateProjection;
  customBandIndex?: number | null;
}): {
  heatMapRefs: HeatMapRef[];
  selectedHeatMapRef: HeatMapRef | null;
  selectedCustomBandIndex: number | null;
} {
  const heatMapRefs = sortHeatMapRefs(input.heatMapRefs);
  if (heatMapRefs.length === 0) {
    return {
      heatMapRefs,
      selectedHeatMapRef: null,
      selectedCustomBandIndex: null,
    };
  }

  const defaultIndex =
    getHeatMapRefIndex(heatMapRefs, input.currentProjection.selectedHeatMapRef) ??
    0;
  const selectedCustomBandIndex = clampHeatMapRefIndex(
    input.customBandIndex ?? defaultIndex,
    heatMapRefs.length,
  );
  return {
    heatMapRefs,
    selectedHeatMapRef: heatMapRefs[selectedCustomBandIndex] ?? null,
    selectedCustomBandIndex,
  };
}

function buildCustomProjection(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  customBandIndex?: number | null;
  profile: CompoCalculationProfile;
}): {
  currentProjection: CompoActualStateProjection;
  targetProjection: CompoActualStateProjection;
  selectedCustomBandIndex: number | null;
  heatMapRefs: HeatMapRef[];
} {
  const rawProjection = projectCompoActualStateView({
    view: "raw",
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    profile: input.profile,
  });
  const applicableRefs = getSupportedCompoCalculationHeatMapRefs(
    input.heatMapRefs,
    input.profile,
    input.base.profileReferenceCountReader,
  );
  if (rawProjection.targetStatus === "unavailable") {
    return {
      currentProjection: rawProjection,
      targetProjection: rawProjection,
      selectedCustomBandIndex: null,
      heatMapRefs: sortHeatMapRefs(input.heatMapRefs),
    };
  }
  if (
    applicableRefs.length === 0 ||
    (rawProjection.displayCounts.TH19 ?? 0) > 0 && input.profile.factualToCalculationBucket.TH19 == null
  ) {
    return {
      currentProjection: scoreProjectionIfNeeded(rawProjection, input.profile, input.base.profileReferenceCountReader),
      targetProjection: scoreProjectionIfNeeded(rawProjection, input.profile, input.base.profileReferenceCountReader),
      selectedCustomBandIndex: null,
      heatMapRefs: sortHeatMapRefs(input.heatMapRefs),
    };
  }
  const selection = resolveCustomHeatMapRef({
    heatMapRefs: applicableRefs,
    currentProjection: rawProjection,
    customBandIndex: input.customBandIndex,
  });

  if (!selection.selectedHeatMapRef) {
    return {
      currentProjection: scoreProjectionIfNeeded(rawProjection, input.profile, input.base.profileReferenceCountReader),
      targetProjection: scoreProjectionIfNeeded(rawProjection, input.profile, input.base.profileReferenceCountReader),
      selectedCustomBandIndex: null,
      heatMapRefs: selection.heatMapRefs,
    };
  }

  const deltaByBucket = getCompoActualStateDeltaByBucket(
    rawProjection.displayCounts,
    selection.selectedHeatMapRef,
    input.profile,
    input.base.profileReferenceCountReader,
    rawProjection.calculationCounts,
  );
  const targetResolution = resolveCompoProfileTargets({
    profile: input.profile,
    reference: selection.selectedHeatMapRef,
    readCount: input.base.profileReferenceCountReader ?? getCompoLegacyReferenceBucketCount,
  });

  return {
    currentProjection: scoreProjectionIfNeeded(rawProjection, input.profile, input.base.profileReferenceCountReader),
    targetProjection: {
      ...rawProjection,
      selectedHeatMapRef: selection.selectedHeatMapRef,
      deltaByBucket,
      deviationScore: calculateCompoDeviationScore({
        displayCounts: rawProjection.displayCounts,
        heatMapRef: selection.selectedHeatMapRef,
        profile: input.profile,
        calculationCounts: rawProjection.calculationCounts,
        profileReferenceCountReader: input.base.profileReferenceCountReader,
      }),
      targetStatus: targetResolution.status,
      targetCalculationCounts:
        targetResolution.status === "supported" ? targetResolution.counts : null,
    },
    selectedCustomBandIndex: selection.selectedCustomBandIndex,
    heatMapRefs: selection.heatMapRefs,
  };
}

function applyAdviceActionToBase(input: {
  base: CompoActualStateBaseMetrics;
  action: CompoAdviceAction;
  referenceHeatMapRef: HeatMapRef | null;
  profile: CompoCalculationProfile;
  calculationAction?: ProfileBackedCompoAdviceAction;
}): CompoActualStateBaseMetrics | null {
  const bucketCounts = cloneBucketCounts(input.base.bucketCounts);
  let resolvedTotalWeight = input.base.resolvedTotalWeight;
  let memberCount = input.base.memberCount;

  const incomingCalculationBucket = input.calculationAction?.incomingCalculationBucketId ??
    getProfileCalculationBucket(input.profile, input.action.incomingBucket);
  const incomingGranularBucket = incomingCalculationBucket
    ? input.profile.compatibility.plannerBucketByCalculationBucket[incomingCalculationBucket]
    : null;
  const outgoingCalculationBucket = input.action.kind === "swap"
    ? input.calculationAction?.outgoingCalculationBucketId ?? getProfileCalculationBucket(input.profile, input.action.outgoingBucket)
    : null;
  const outgoingDefinition = outgoingCalculationBucket
    ? input.profile.buckets.find((bucket) => bucket.id === outgoingCalculationBucket)
    : null;
  if (!incomingCalculationBucket || !incomingGranularBucket || (input.action.kind === "swap" && (!outgoingCalculationBucket || !outgoingDefinition))) {
    return null;
  }
  const incomingRepresentative = getCompoProfileRepresentativeWeight(
    input.profile,
    incomingCalculationBucket,
    input.referenceHeatMapRef,
    input.base.profileReferenceCountReader,
  );
  const outgoingRepresentative = outgoingCalculationBucket
    ? getCompoProfileRepresentativeWeight(input.profile, outgoingCalculationBucket, input.referenceHeatMapRef, input.base.profileReferenceCountReader)
    : 0;
  if (incomingRepresentative === null || outgoingRepresentative === null) return null;

  if (input.action.kind === "add") {
    const incomingKey = incomingGranularBucket as keyof CompoWarBucketCounts;
    const nextCount = (bucketCounts[incomingKey] ?? 0) + 1;
    if (!Number.isSafeInteger(nextCount) || nextCount < 0) return null;
    bucketCounts[incomingKey] = nextCount;
    resolvedTotalWeight += incomingRepresentative;
    memberCount += 1;
  } else {
    const outgoingKey = outgoingDefinition?.sourceBucketIds.find(
      (sourceBucketId) => (bucketCounts[sourceBucketId as keyof CompoWarBucketCounts] ?? 0) > 0,
    ) as keyof CompoWarBucketCounts | undefined;
    const incomingKey = incomingGranularBucket as keyof CompoWarBucketCounts;
    if (!outgoingKey || (bucketCounts[outgoingKey] ?? 0) <= 0) return null;
    bucketCounts[outgoingKey] -= 1;
    const nextIncomingCount = (bucketCounts[incomingKey] ?? 0) + 1;
    if (!Number.isSafeInteger(nextIncomingCount) || nextIncomingCount < 0) return null;
    bucketCounts[incomingKey] = nextIncomingCount;
    resolvedTotalWeight += incomingRepresentative - outgoingRepresentative;
  }

  if (
    !Number.isSafeInteger(memberCount) ||
    memberCount < 0 ||
    !Number.isFinite(resolvedTotalWeight) ||
    Math.abs(resolvedTotalWeight) > Number.MAX_SAFE_INTEGER
  ) return null;

  return {
    resolvedTotalWeight,
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    memberCount,
    bucketCounts,
    profileReferenceCountReader: input.base.profileReferenceCountReader,
  };
}

function projectAdviceState(input: {
  view: CompoAdviceView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  customBandIndex?: number | null;
  profile: CompoCalculationProfile;
}): {
  currentProjection: CompoActualStateProjection;
  targetProjection: CompoActualStateProjection;
  selectedCustomBandIndex: number | null;
  heatMapRefs: HeatMapRef[];
} {
  if (input.view === "custom") {
    return buildCustomProjection({
      base: input.base,
      heatMapRefs: input.heatMapRefs,
      customBandIndex: input.customBandIndex,
      profile: input.profile,
    });
  }

  const projection = scoreProjectionIfNeeded(projectCompoActualStateView({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    profile: input.profile,
  }), input.profile, input.base.profileReferenceCountReader);
  return {
    currentProjection: projection,
    targetProjection: projection,
    selectedCustomBandIndex:
      getHeatMapRefIndex(sortHeatMapRefs(input.heatMapRefs), projection.selectedHeatMapRef) ??
      (input.heatMapRefs.length > 0 ? 0 : null),
    heatMapRefs: sortHeatMapRefs(input.heatMapRefs),
  };
}

function scoreProjectionIfNeeded(
  projection: CompoActualStateProjection,
  profile: CompoCalculationProfile = LEGACY_COMPO_CALCULATION_PROFILE,
  profileReferenceCountReader?: CompoProfileReferenceCountReader<HeatMapRef>,
): CompoActualStateProjection {
  if (projection.deviationScore !== null || projection.selectedHeatMapRef === null) {
    return projection;
  }
  return {
    ...projection,
    deviationScore: calculateCompoDeviationScore({
      displayCounts: projection.displayCounts,
      heatMapRef: projection.selectedHeatMapRef,
      profile,
      calculationCounts: projection.calculationCounts,
      profileReferenceCountReader,
    }),
  };
}

function evaluateAdviceAction(input: {
  view: CompoAdviceView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  currentProjection: CompoActualStateProjection;
  currentScore: number | null;
  action: CompoAdviceAction;
  profile: CompoCalculationProfile;
  customBandIndex?: number | null;
  calculationAction?: ProfileBackedCompoAdviceAction;
}): CompoAdviceEvaluation | null {
  const nextBase = applyAdviceActionToBase({
    base: input.base,
    action: input.action,
    referenceHeatMapRef: input.currentProjection.selectedHeatMapRef,
    profile: input.profile,
    calculationAction: input.calculationAction,
  });
  if (!nextBase) return null;
  const afterProjection = projectAdviceState({
    view: input.view,
    base: nextBase,
    heatMapRefs: input.heatMapRefs,
    profile: input.profile,
    // Preserve the legacy evaluator: a custom action is evaluated against the
    // resulting auto-selected band, while the initial custom target remains pinned.
    customBandIndex: undefined,
  }).targetProjection;
  const resultingScore = afterProjection.deviationScore;
  if (
    afterProjection.targetStatus !== "supported" ||
    resultingScore === null ||
    !Number.isFinite(resultingScore)
  ) {
    return null;
  }
  const scoreImprovement =
    input.currentScore !== null && resultingScore !== null
      ? input.currentScore - resultingScore
      : null;
  const bandFitDistance = afterProjection.selectedHeatMapRef
    ? Math.abs(
        afterProjection.totalWeight -
          getHeatMapRefBandMidpoint(afterProjection.selectedHeatMapRef),
      )
    : Number.POSITIVE_INFINITY;

  return {
    action: input.action,
    description: buildAdviceActionDescription(input.action),
    beforeProjection: input.currentProjection,
    afterProjection,
    currentScore: input.currentScore,
    resultingScore,
    scoreImprovement,
    bandFitDistance,
    totalWeightJump: Math.abs(
      afterProjection.totalWeight - input.currentProjection.totalWeight,
    ),
    incomingPriority: input.calculationAction
      ? getCalculationBucketPriority(input.profile, input.calculationAction.incomingCalculationBucketId)
      : getProfileDisplayBucketPriority(input.profile, input.action.incomingBucket),
    outgoingPriority:
      input.action.kind === "swap"
        ? input.calculationAction?.outgoingCalculationBucketId
          ? getCalculationBucketPriority(input.profile, input.calculationAction.outgoingCalculationBucketId)
          : getProfileDisplayBucketPriority(input.profile, input.action.outgoingBucket)
        : Number.POSITIVE_INFINITY,
  };
}

function generateAdviceActions(input: {
  base: CompoActualStateBaseMetrics;
  currentProjection: CompoActualStateProjection;
  profile: CompoCalculationProfile;
}): ProfileBackedCompoAdviceAction[] {
  if (!input.currentProjection.selectedHeatMapRef || input.currentProjection.deviationScore === null) {
    return [];
  }
  if (!input.currentProjection.calculationCounts || !input.currentProjection.targetCalculationCounts) return [];
  return generateProfileAdviceActions({
    profile: input.profile,
    observedCounts: input.currentProjection.calculationCounts,
    targetCounts: input.currentProjection.targetCalculationCounts,
    memberCount: input.base.memberCount,
  }).flatMap((action): ProfileBackedCompoAdviceAction[] => {
    const incomingBucket = getProfileDisplayBucket(input.profile, action.incomingBucketId);
    if (!incomingBucket) return [];
    if (action.kind === "add") {
      return [{ kind: "add", incomingBucket, incomingCalculationBucketId: action.incomingBucketId }];
    }
    const outgoingBucket = getProfileDisplayBucket(input.profile, action.outgoingBucketId);
    return outgoingBucket && outgoingBucket !== incomingBucket
      ? [{
          kind: "swap",
          outgoingBucket,
          incomingBucket,
          outgoingCalculationBucketId: action.outgoingBucketId,
          incomingCalculationBucketId: action.incomingBucketId,
        }]
      : [];
  });
}

function resolveCurrentProjectionBandIndex(input: {
  heatMapRefs: readonly HeatMapRef[];
  currentProjection: CompoActualStateProjection;
  customBandIndex?: number | null;
}): {
  heatMapRefs: HeatMapRef[];
  selectedCustomBandIndex: number | null;
} {
  const heatMapRefs = sortHeatMapRefs(input.heatMapRefs);
  if (heatMapRefs.length === 0) {
    return {
      heatMapRefs,
      selectedCustomBandIndex: null,
    };
  }

  const defaultIndex =
    getHeatMapRefIndex(heatMapRefs, input.currentProjection.selectedHeatMapRef) ??
    0;
  return {
    heatMapRefs,
    selectedCustomBandIndex: clampHeatMapRefIndex(
      input.customBandIndex ?? defaultIndex,
      heatMapRefs.length,
    ),
  };
}

function resolveAdviceTargetBandMidpoint(input: {
  heatMapRefs: readonly HeatMapRef[];
  selectedHeatMapRef: HeatMapRef | null;
}): number | null {
  return getHeatMapRefAdviceMidpoint(input.heatMapRefs, input.selectedHeatMapRef);
}

export function stepCompoAdviceCustomBandIndex(input: {
  heatMapRefs: readonly HeatMapRef[];
  currentBandIndex: number;
  direction: "prev" | "next";
}): number {
  return stepCompoAdviceCustomBandIndexByCount({
    currentBandIndex: input.currentBandIndex,
    bandCount: input.heatMapRefs.length,
    direction: input.direction,
  });
}

export function stepCompoAdviceCustomBandIndexByCount(input: {
  currentBandIndex: number;
  bandCount: number;
  direction: "prev" | "next";
}): number {
  if (input.bandCount <= 0) {
    return 0;
  }
  const delta = input.direction === "prev" ? -1 : 1;
  return clampHeatMapRefIndex(input.currentBandIndex + delta, input.bandCount);
}

export function getCompoAdviceCustomBandSelection(input: {
  heatMapRefs: readonly HeatMapRef[];
  currentProjection: CompoActualStateProjection;
  customBandIndex?: number | null;
}): {
  heatMapRefs: HeatMapRef[];
  selectedHeatMapRef: HeatMapRef | null;
  selectedCustomBandIndex: number | null;
} {
  const resolved = resolveCurrentProjectionBandIndex(input);
  return {
    heatMapRefs: resolved.heatMapRefs,
    selectedHeatMapRef:
      resolved.selectedCustomBandIndex === null
        ? null
        : resolved.heatMapRefs[resolved.selectedCustomBandIndex] ?? null,
    selectedCustomBandIndex: resolved.selectedCustomBandIndex,
  };
}

export function evaluateCompoAdvice(input: {
  mode: CompoAdviceMode;
  view: CompoAdviceView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
  customBandIndex?: number | null;
  profile?: CompoCalculationProfile;
}): CompoAdviceSummary {
  const profile = input.profile ?? LEGACY_COMPO_CALCULATION_PROFILE;
  const projectionState = projectAdviceState({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    customBandIndex: input.customBandIndex,
    profile,
  });
  const currentProjection = projectionState.currentProjection;
  const targetProjection = projectionState.targetProjection;
  const currentScore = currentProjection.deviationScore;
  const targetScore = targetProjection.deviationScore;
  const currentBandLabel = getBandLabel(currentProjection.selectedHeatMapRef);
  const targetBandLabel = getBandLabel(targetProjection.selectedHeatMapRef);
  const currentWeight = Number.isFinite(currentProjection.totalWeight)
    ? currentProjection.totalWeight
    : null;
  const projectedProjection =
    input.mode === "actual" &&
    input.view === "raw" &&
    currentProjection.memberCount < 50
      ? projectCompoActualStateView({
          view: "auto",
          base: input.base,
          heatMapRefs: input.heatMapRefs,
          profile,
        })
      : null;
  const currentBandMatchrate = getBandMatchrate({
    summary: {
      currentProjection,
      bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
    },
    heatMapRef: currentProjection.selectedHeatMapRef,
  });
  const targetBandMatchrate = getBandMatchrate({
    summary: {
      currentProjection: targetProjection,
      bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
    },
    heatMapRef: targetProjection.selectedHeatMapRef,
  });
  const currentMatchrate = estimateMatchrateFromDeviation({
    bandMatchrate: currentBandMatchrate,
    deviationScore: currentScore,
  });
  const targetBandMidpoint = resolveAdviceTargetBandMidpoint({
    heatMapRefs: projectionState.heatMapRefs,
    selectedHeatMapRef: targetProjection.selectedHeatMapRef,
  });
  const actions = generateAdviceActions({
    base: input.base,
    currentProjection: targetProjection,
    profile,
  });
  const evaluations = actions
    .map((action) =>
      evaluateAdviceAction({
        view: input.view,
        base: input.base,
        heatMapRefs: input.heatMapRefs,
        currentProjection: targetProjection,
        currentScore: targetScore,
        action,
        profile,
        customBandIndex: projectionState.selectedCustomBandIndex,
        calculationAction: action,
      }),
    )
    .filter((evaluation): evaluation is CompoAdviceEvaluation => evaluation !== null);
  const rankedEvaluations = rankCompoProfileAdviceEvaluations(
    evaluations as Array<CompoAdviceEvaluation & CompoProfileAdviceEvaluation>,
  );

  const best = rankedEvaluations[0] ?? null;
  const isImproving = (best?.scoreImprovement ?? Number.NEGATIVE_INFINITY) > 0;
  const isNeutral = (best?.scoreImprovement ?? Number.NEGATIVE_INFINITY) === 0;
  const recommendationText =
    best && (isImproving || isNeutral)
      ? best.description
      : "No improvement found.";
  const resultingScore =
    best && (isImproving || isNeutral) ? best.resultingScore : null;
  const resultingBandLabel =
    best && (isImproving || isNeutral)
      ? getBandLabel(best.afterProjection.selectedHeatMapRef)
      : "(no band)";
  const alternateTexts =
    best && (isImproving || isNeutral)
      ? rankedEvaluations.slice(1, 3).map((evaluation) => evaluation.description)
      : [];

  return {
    mode: input.mode,
    view: input.view,
    viewLabel: COMPO_ADVICE_VIEW_LABELS[input.view],
    currentProjection,
    projectedProjection,
    targetDeltaByBucket: targetProjection.deltaByBucket,
    heatMapRefs: projectionState.heatMapRefs,
    bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
    resolvedRosterWeight: input.base.resolvedTotalWeight,
    currentWeight,
    targetBandMidpoint,
    currentMatchrate,
    targetBandMatchrate,
    resultingMatchrate: estimateMatchrateFromDeviation({
      bandMatchrate: targetBandMatchrate,
      deviationScore: resultingScore,
    }),
    currentScore,
    currentBandLabel,
    targetBandLabel,
    targetHeatMapRef: targetProjection.selectedHeatMapRef,
    recommendationText,
    resultingScore,
    resultingBandLabel,
    alternateTexts,
    statusText:
      best && (isImproving || isNeutral)
        ? isNeutral
          ? "No improvement found."
          : null
        : "No improvement found.",
    selectedCustomBandIndex: projectionState.selectedCustomBandIndex,
    customBandCount: projectionState.heatMapRefs.length,
  };
}

export function buildCompoAdviceContentLines(input: {
  summary: CompoAdviceSummary;
  modeLabel: string;
  refreshLine: string | null;
  clanTag?: string | null;
}): string[] {
  const lines: string[] = [];
  void input.refreshLine;
  lines.push(`Mode: **${input.modeLabel}**`);
  lines.push(`Advice View: **${input.summary.viewLabel}**`);
  lines.push(`Current Deviation Score: **${formatScore(input.summary.currentScore)}**`);
  lines.push(`Target Band: **${input.summary.targetBandLabel}**`);
  lines.push(`Resolved roster weight: ${formatFullWeight(input.summary.resolvedRosterWeight)}`);
  if (
    input.summary.projectedProjection &&
    input.summary.projectedProjection.totalWeight !== input.summary.currentWeight
  ) {
    lines.push(
      `Projected 50-player weight: ${formatFullWeight(
        input.summary.projectedProjection.totalWeight,
      )}`,
    );
  }
  if (
    input.summary.currentProjection.view !== "raw" ||
    input.summary.currentWeight !== input.summary.resolvedRosterWeight
  ) {
    lines.push(`Projected 50-player weight: ${formatFullWeight(input.summary.currentWeight)}`);
  }
  lines.push(
    `Scoring basis: ${
      input.summary.currentProjection.view === "raw"
        ? "resolved roster"
        : "projected 50-player roster"
    }`,
  );
  if (input.summary.projectedProjection) {
    lines.push("Projected planning basis: projected 50-player roster");
  }
  lines.push(`Unresolved weights: ${input.summary.currentProjection.unresolvedWeightCount}`);
  if (input.summary.mode === "actual") {
    lines.push(`Deferred: ${input.summary.currentProjection.deferredWeightCount}`);
  }
  lines.push(`Missing-to-50 fills: ${input.summary.currentProjection.missingTo50Count}`);
  lines.push(
    `Displayed missing weights: ${input.summary.currentProjection.missingWeights}${
      input.summary.currentProjection.missingWeights > 0 && input.clanTag
        ? ` [FWA Stats](${buildFwaWeightPageUrl(input.clanTag)})`
        : ""
    }`,
  );
  lines.push(`Matchrate: ${formatMatchratePercent(input.summary.currentMatchrate)}`);
  lines.push(`Band matchrate: ${formatMatchratePercent(input.summary.targetBandMatchrate)}`);
  lines.push(
    `Band midpoint: ${formatBandMidpointLine({
      currentWeight: input.summary.currentWeight,
      targetBandMidpoint: input.summary.targetBandMidpoint,
      selectedHeatMapRef: input.summary.targetHeatMapRef,
    })}`,
  );
  if (
    input.summary.mode === "actual" &&
    input.summary.view === "raw" &&
    input.summary.currentProjection.memberCount < 50
  ) {
    lines.push("Raw roster deficits:");
    lines.push(
      ...buildCompoActualDeltaLines({
        deltaByBucket: input.summary.currentProjection.deltaByBucket,
      }),
    );
    if (input.summary.projectedProjection) {
      lines.push("Projected planning is shown separately below.");
    }
  } else {
    lines.push(`Recommendation: :arrow_arrow: __${input.summary.recommendationText}__`);
  }
  lines.push(
    `Target band source: ${
      input.summary.view === "custom"
        ? "custom-selected band"
        : input.summary.currentProjection.view === "raw"
          ? "resolved roster total"
          : "projected total"
    }`,
  );
  lines.push(`Deviation Score: **${formatScore(input.summary.resultingScore)}**`);
  lines.push(`Matchrate: ${formatMatchratePercent(input.summary.resultingMatchrate)}`);
  const adjacent = getAdjacentHeatMapRefs({
    heatMapRefs: input.summary.heatMapRefs,
    selectedHeatMapRef: input.summary.targetHeatMapRef,
  });
  lines.push(
    `Lower band: ${
      adjacent.lower ? `**${formatHeatMapRefBandLabel(adjacent.lower)}**` : "N/A"
    }`,
  );
  lines.push(
    `Matchrate: ${formatMatchratePercent(
      getBandMatchrate({ summary: input.summary, heatMapRef: adjacent.lower }),
    )}`,
  );
  lines.push(
    `Higher band: ${
      adjacent.higher ? `**${formatHeatMapRefBandLabel(adjacent.higher)}**` : "N/A"
    }`,
  );
  lines.push(
    `Matchrate: ${formatMatchratePercent(
      getBandMatchrate({ summary: input.summary, heatMapRef: adjacent.higher }),
    )}`,
  );
  if (
    input.summary.statusText &&
    !(
      input.summary.mode === "actual" &&
      input.summary.view === "raw" &&
      input.summary.currentProjection.memberCount < 50
    )
  ) {
    lines.push(input.summary.statusText);
  }
  return lines;
}

export function buildWarAdviceSummary(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
}): CompoAdviceSummary {
  return evaluateCompoAdvice({
    mode: "war",
    view: "raw",
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
  });
}

export function buildActualAdviceSummary(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  view: Exclude<CompoAdviceView, "custom">;
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
}): CompoAdviceSummary {
  return evaluateCompoAdvice({
    mode: "actual",
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
  });
}

export function buildCustomAdviceSummary(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
  customBandIndex?: number | null;
}): CompoAdviceSummary {
  return evaluateCompoAdvice({
    mode: "actual",
    view: "custom",
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
    customBandIndex: input.customBandIndex,
  });
}

export const getCompoAdviceActionLabelForTest = buildAdviceActionDescription;
export const applyAdviceActionToBaseForTest = applyAdviceActionToBase;
export const evaluateAdviceActionForTest = evaluateAdviceAction;
export const compareEvaluationsForTest = compareEvaluations;
export const sortHeatMapRefsForTest = sortHeatMapRefs;
export const resolveCustomHeatMapRefForTest = resolveCustomHeatMapRef;
export const buildCompoAdviceContentLinesForTest = buildCompoAdviceContentLines;
export const formatFullWeightForTest = formatFullWeight;
export const formatSignedCompoAdviceDeltaForTest = formatSignedCompoAdviceDelta;
export const formatMatchratePercentForTest = formatMatchratePercent;
export const estimateMatchrateFromDeviationForTest = estimateMatchrateFromDeviation;
export const getAdjacentHeatMapRefsForTest = getAdjacentHeatMapRefs;
export const resolveAdviceTargetBandMidpointForTest = resolveAdviceTargetBandMidpoint;
