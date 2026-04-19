import type { HeatMapRef } from "@prisma/client";
import {
  calculateCompoDeviationScore,
  getCompoActualStateDeltaByBucket,
  getCompoDisplayBucketRepresentativeWeight,
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
import { buildFwaWeightPageUrl } from "../services/FwaStatsWeightService";
import type { CompoWarBucketCounts } from "./compoWarBucketCounts";
import type { CompoWarDisplayBucket } from "./compoWarWeightBuckets";

export const COMPO_ADVICE_DISPLAY_BUCKETS: readonly CompoWarDisplayBucket[] = [
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "<=TH13",
];

const COMPO_ADVICE_BUCKET_PRIORITY: Record<CompoWarDisplayBucket, number> = {
  TH18: 0,
  TH17: 1,
  TH16: 2,
  TH15: 3,
  TH14: 4,
  "<=TH13": 5,
};

const DISPLAY_BUCKET_TO_GRANULAR_BUCKET: Record<
  CompoWarDisplayBucket,
  keyof CompoWarBucketCounts
> = {
  TH18: "TH18",
  TH17: "TH17",
  TH16: "TH16",
  TH15: "TH15",
  TH14: "TH14",
  "<=TH13": "TH13",
};

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
  heatMapRefs: readonly HeatMapRef[];
  bandMatchRatesByBandKey?: ReadonlyMap<string, number | null>;
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

function normalizeScore(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

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

function getDisplayBucketPriority(bucket: CompoWarDisplayBucket): number {
  return COMPO_ADVICE_BUCKET_PRIORITY[bucket];
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
  });
  const selection = resolveCustomHeatMapRef({
    heatMapRefs: input.heatMapRefs,
    currentProjection: rawProjection,
    customBandIndex: input.customBandIndex,
  });

  if (!selection.selectedHeatMapRef) {
    return {
      currentProjection: rawProjection,
      targetProjection: rawProjection,
      selectedCustomBandIndex: null,
      heatMapRefs: selection.heatMapRefs,
    };
  }

  const deltaByBucket = getCompoActualStateDeltaByBucket(
    rawProjection.displayCounts,
    selection.selectedHeatMapRef,
  );

  return {
    currentProjection: rawProjection,
    targetProjection: {
      ...rawProjection,
      selectedHeatMapRef: selection.selectedHeatMapRef,
      deltaByBucket,
      deviationScore: calculateCompoDeviationScore({
        displayCounts: rawProjection.displayCounts,
        heatMapRef: selection.selectedHeatMapRef,
      }),
    },
    selectedCustomBandIndex: selection.selectedCustomBandIndex,
    heatMapRefs: selection.heatMapRefs,
  };
}

function applyAdviceActionToBase(input: {
  base: CompoActualStateBaseMetrics;
  action: CompoAdviceAction;
  referenceHeatMapRef: HeatMapRef | null;
}): CompoActualStateBaseMetrics {
  const bucketCounts = cloneBucketCounts(input.base.bucketCounts);
  let resolvedTotalWeight = input.base.resolvedTotalWeight;
  let memberCount = input.base.memberCount;

  const incomingGranularBucket =
    DISPLAY_BUCKET_TO_GRANULAR_BUCKET[input.action.incomingBucket];
  const outgoingGranularBucket =
    input.action.kind === "swap"
      ? DISPLAY_BUCKET_TO_GRANULAR_BUCKET[input.action.outgoingBucket]
      : null;

  if (input.action.kind === "add") {
    bucketCounts[incomingGranularBucket] += 1;
    resolvedTotalWeight += getCompoDisplayBucketRepresentativeWeight(
      input.action.incomingBucket,
      input.referenceHeatMapRef,
    );
    memberCount += 1;
  } else {
    bucketCounts[outgoingGranularBucket!] -= 1;
    bucketCounts[incomingGranularBucket] += 1;
    resolvedTotalWeight +=
      getCompoDisplayBucketRepresentativeWeight(
        input.action.incomingBucket,
        input.referenceHeatMapRef,
      ) -
      getCompoDisplayBucketRepresentativeWeight(
        input.action.outgoingBucket,
        input.referenceHeatMapRef,
      );
  }

  return {
    resolvedTotalWeight,
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    memberCount,
    bucketCounts,
  };
}

function projectAdviceState(input: {
  view: CompoAdviceView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  customBandIndex?: number | null;
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
    });
  }

  const projection = projectCompoActualStateView({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
  });
  if (projection.deviationScore === null && projection.selectedHeatMapRef) {
    return {
      currentProjection: {
        ...projection,
        deviationScore: calculateCompoDeviationScore({
          displayCounts: projection.displayCounts,
          heatMapRef: projection.selectedHeatMapRef,
        }),
      },
      targetProjection: {
        ...projection,
        deviationScore: calculateCompoDeviationScore({
          displayCounts: projection.displayCounts,
          heatMapRef: projection.selectedHeatMapRef,
        }),
      },
      selectedCustomBandIndex:
        getHeatMapRefIndex(
          sortHeatMapRefs(input.heatMapRefs),
          projection.selectedHeatMapRef,
        ) ??
        (input.heatMapRefs.length > 0 ? 0 : null),
      heatMapRefs: sortHeatMapRefs(input.heatMapRefs),
    };
  }
  return {
    currentProjection: projection,
    targetProjection: projection,
    selectedCustomBandIndex:
      getHeatMapRefIndex(sortHeatMapRefs(input.heatMapRefs), projection.selectedHeatMapRef) ??
      (input.heatMapRefs.length > 0 ? 0 : null),
    heatMapRefs: sortHeatMapRefs(input.heatMapRefs),
  };
}

function evaluateAdviceAction(input: {
  view: CompoAdviceView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  currentProjection: CompoActualStateProjection;
  currentScore: number | null;
  action: CompoAdviceAction;
}): CompoAdviceEvaluation {
  const nextBase = applyAdviceActionToBase({
    base: input.base,
    action: input.action,
    referenceHeatMapRef: input.currentProjection.selectedHeatMapRef,
  });
  const afterProjection = projectAdviceState({
    view: input.view,
    base: nextBase,
    heatMapRefs: input.heatMapRefs,
  }).targetProjection;
  const resultingScore = afterProjection.deviationScore;
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
    incomingPriority: getDisplayBucketPriority(input.action.incomingBucket),
    outgoingPriority:
      input.action.kind === "swap"
        ? getDisplayBucketPriority(input.action.outgoingBucket)
        : Number.POSITIVE_INFINITY,
  };
}

function compareEvaluations(
  left: CompoAdviceEvaluation,
  right: CompoAdviceEvaluation,
): number {
  const leftImprovement = left.scoreImprovement ?? Number.NEGATIVE_INFINITY;
  const rightImprovement = right.scoreImprovement ?? Number.NEGATIVE_INFINITY;
  if (leftImprovement !== rightImprovement) {
    return rightImprovement - leftImprovement;
  }

  const leftResultingScore = normalizeScore(left.resultingScore);
  const rightResultingScore = normalizeScore(right.resultingScore);
  if (leftResultingScore !== rightResultingScore) {
    return leftResultingScore - rightResultingScore;
  }

  if (left.bandFitDistance !== right.bandFitDistance) {
    return left.bandFitDistance - right.bandFitDistance;
  }

  if (left.incomingPriority !== right.incomingPriority) {
    return left.incomingPriority - right.incomingPriority;
  }

  if (left.totalWeightJump !== right.totalWeightJump) {
    return left.totalWeightJump - right.totalWeightJump;
  }

  if (left.outgoingPriority !== right.outgoingPriority) {
    return left.outgoingPriority - right.outgoingPriority;
  }

  return left.description.localeCompare(right.description);
}

function generateAdviceActions(input: {
  base: CompoActualStateBaseMetrics;
  currentProjection: CompoActualStateProjection;
}): CompoAdviceAction[] {
  if (input.base.memberCount < 50) {
    return [...COMPO_ADVICE_DISPLAY_BUCKETS].map((incomingBucket) => ({
      kind: "add" as const,
      incomingBucket,
    }));
  }

  const positiveBuckets = COMPO_ADVICE_DISPLAY_BUCKETS.filter(
    (bucket) => (input.currentProjection.deltaByBucket[bucket] ?? 0) > 0,
  );
  const negativeBuckets = COMPO_ADVICE_DISPLAY_BUCKETS.filter(
    (bucket) => (input.currentProjection.deltaByBucket[bucket] ?? 0) < 0,
  );

  const actions: CompoAdviceAction[] = [];
  for (const outgoingBucket of positiveBuckets) {
    for (const incomingBucket of negativeBuckets) {
      actions.push({
        kind: "swap",
        outgoingBucket,
        incomingBucket,
      });
    }
  }
  return actions;
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
}): CompoAdviceSummary {
  const projectionState = projectAdviceState({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
    customBandIndex: input.customBandIndex,
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
  const targetMatchrate = estimateMatchrateFromDeviation({
    bandMatchrate: targetBandMatchrate,
    deviationScore: targetScore,
  });
  const targetBandMidpoint = resolveAdviceTargetBandMidpoint({
    heatMapRefs: projectionState.heatMapRefs,
    selectedHeatMapRef: targetProjection.selectedHeatMapRef,
  });
  const actions = generateAdviceActions({
    base: input.base,
    currentProjection: targetProjection,
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
      }),
    )
    .sort(compareEvaluations);

  const best = evaluations[0] ?? null;
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
      ? evaluations.slice(1, 3).map((evaluation) => evaluation.description)
      : [];

  return {
    mode: input.mode,
    view: input.view,
    viewLabel: COMPO_ADVICE_VIEW_LABELS[input.view],
    currentProjection,
    heatMapRefs: projectionState.heatMapRefs,
    bandMatchRatesByBandKey: input.bandMatchRatesByBandKey,
    currentWeight,
    targetBandMidpoint,
    currentMatchrate,
    targetBandMatchrate,
    resultingMatchrate: targetMatchrate,
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
  lines.push(`Current Weight: ${formatFullWeight(input.summary.currentWeight)}`);
  lines.push(
    `Missing weights: ${input.summary.currentProjection.missingWeights}${
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
  lines.push(`Recommendation: :arrow_arrow: __${input.summary.recommendationText}__`);
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
  if (input.summary.statusText) {
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
