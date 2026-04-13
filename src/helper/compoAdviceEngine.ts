import type { HeatMapRef } from "@prisma/client";
import {
  calculateCompoDeviationScore,
  getCompoActualStateViewLabel,
  getCompoDisplayBucketRepresentativeWeight,
  projectCompoActualStateView,
  type CompoActualStateBaseMetrics,
  type CompoActualStateProjection,
  type CompoActualStateView,
} from "./compoActualStateView";
import {
  formatHeatMapRefBandLabel,
  getHeatMapRefBandMidpoint,
} from "./compoHeatMap";
import {
  type CompoWarBucketCounts,
} from "./compoWarBucketCounts";
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

export type CompoAdviceMode = "actual" | "war";

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
  view: CompoActualStateView;
  viewLabel: string;
  currentProjection: CompoActualStateProjection;
  currentScore: number | null;
  currentBandLabel: string;
  recommendationText: string;
  resultingScore: number | null;
  resultingBandLabel: string;
  alternateTexts: string[];
  statusText: string | null;
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

function getBandLabel(ref: HeatMapRef | null): string {
  return ref ? formatHeatMapRefBandLabel(ref) : "(no band)";
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
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
}): CompoActualStateProjection {
  const projection = projectCompoActualStateView({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
  });

  if (projection.deviationScore !== null || !projection.selectedHeatMapRef) {
    return projection;
  }

  return {
    ...projection,
    deviationScore: calculateCompoDeviationScore({
      displayCounts: projection.displayCounts,
      heatMapRef: projection.selectedHeatMapRef,
    }),
  };
}

function evaluateAdviceAction(input: {
  view: CompoActualStateView;
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
  });
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

export function evaluateCompoAdvice(input: {
  mode: CompoAdviceMode;
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
}): CompoAdviceSummary {
  const currentProjection = projectAdviceState({
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
  });
  const currentScore = currentProjection.deviationScore;
  const currentBandLabel = getBandLabel(currentProjection.selectedHeatMapRef);
  const actions = generateAdviceActions({
    base: input.base,
    currentProjection,
  });
  const evaluations = actions
    .map((action) =>
      evaluateAdviceAction({
        view: input.view,
        base: input.base,
        heatMapRefs: input.heatMapRefs,
        currentProjection,
        currentScore,
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
    viewLabel: getCompoActualStateViewLabel(input.view),
    currentProjection,
    currentScore,
    currentBandLabel,
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
  };
}

export function buildCompoAdviceContentLines(input: {
  summary: CompoAdviceSummary;
  modeLabel: string;
  refreshLine: string | null;
}): string[] {
  const lines: string[] = [];
  if (input.refreshLine) {
    lines.push(input.refreshLine);
  }
  lines.push(`Mode: **${input.modeLabel}**`);
  lines.push(`Advice View: **${input.summary.viewLabel}**`);
  lines.push(`Current Score: **${formatScore(input.summary.currentScore)}**`);
  lines.push(`Current Band: **${input.summary.currentBandLabel}**`);
  lines.push(`Recommendation: **${input.summary.recommendationText}**`);
  lines.push(`Resulting Score: **${formatScore(input.summary.resultingScore)}**`);
  lines.push(`Resulting Band: **${input.summary.resultingBandLabel}**`);
  if (input.summary.statusText) {
    lines.push(input.summary.statusText);
  }
  if (input.summary.alternateTexts.length > 0) {
    lines.push("Alternates:");
    for (const alternate of input.summary.alternateTexts) {
      lines.push(`- ${alternate}`);
    }
  }
  return lines;
}

export function buildWarAdviceSummary(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
}): CompoAdviceSummary {
  return evaluateCompoAdvice({
    mode: "war",
    view: "raw",
    base: input.base,
    heatMapRefs: input.heatMapRefs,
  });
}

export function buildActualAdviceSummary(input: {
  base: CompoActualStateBaseMetrics;
  heatMapRefs: readonly HeatMapRef[];
  view: CompoActualStateView;
}): CompoAdviceSummary {
  return evaluateCompoAdvice({
    mode: "actual",
    view: input.view,
    base: input.base,
    heatMapRefs: input.heatMapRefs,
  });
}

export const getCompoAdviceActionLabelForTest = buildAdviceActionDescription;
export const applyAdviceActionToBaseForTest = applyAdviceActionToBase;
export const evaluateAdviceActionForTest = evaluateAdviceAction;
export const compareEvaluationsForTest = compareEvaluations;
