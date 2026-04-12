import type { HeatMapRef } from "@prisma/client";
import {
  collapseCompoWarBucketCountsForDisplay,
  EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS,
  type CompoWarBucketCounts,
  type CompoWarDisplayBucketCounts,
} from "./compoWarBucketCounts";
import type { CompoWarDisplayBucket } from "./compoWarWeightBuckets";
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

export type CompoActualStateBaseMetrics = {
  resolvedTotalWeight: number;
  unresolvedWeightCount: number;
  memberCount: number;
  bucketCounts: CompoWarBucketCounts;
};

export type CompoActualStateProjection = {
  view: CompoActualStateView;
  totalWeight: number;
  missingWeights: number;
  memberCount: number;
  missingTo50Count: number;
  unresolvedWeightCount: number;
  nMissing: number;
  displayCounts: CompoWarDisplayBucketCounts;
  selectedHeatMapRef: HeatMapRef | null;
  deltaByBucket: Record<CompoWarDisplayBucket, number | null>;
  deviationScore: number | null;
};

const DISPLAY_BUCKETS_ASC: CompoWarDisplayBucket[] = [
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "<=TH13",
];
const DISPLAY_BUCKETS_DESC: CompoWarDisplayBucket[] = [
  "<=TH13",
  "TH14",
  "TH15",
  "TH16",
  "TH17",
  "TH18",
];
const DEVIATION_SCORE_WEIGHTS: Record<CompoWarDisplayBucket, number> = {
  TH18: 5,
  TH17: 4,
  TH16: 3,
  TH15: 2,
  TH14: 1,
  "<=TH13": 0.5,
};
const REPRESENTATIVE_WEIGHTS: Record<Exclude<CompoWarDisplayBucket, "<=TH13">, number> =
  {
    TH18: 175000,
    TH17: 165000,
    TH16: 155000,
    TH15: 145000,
    TH14: 135000,
  };
const LOW_BUCKET_COMPONENT_MIDPOINTS = {
  TH13: 125000,
  TH12: 115000,
  TH11: 100500,
  TH10_OR_LOWER: 57000,
};
const LOW_BUCKET_DEFAULT_REPRESENTATIVE_WEIGHT = Math.round(
  (LOW_BUCKET_COMPONENT_MIDPOINTS.TH13 +
    LOW_BUCKET_COMPONENT_MIDPOINTS.TH12 +
    LOW_BUCKET_COMPONENT_MIDPOINTS.TH11 +
    LOW_BUCKET_COMPONENT_MIDPOINTS.TH10_OR_LOWER) /
    4,
);
const AUTO_DETECT_ITERATION_CAP = 12;

type FillPlan = {
  fillCounts: CompoWarDisplayBucketCounts;
  addedWeight: number;
};

function buildEmptyDisplayCounts(): CompoWarDisplayBucketCounts {
  return {
    ...EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS,
  };
}

function buildTargetCounts(heatMapRef: HeatMapRef): CompoWarDisplayBucketCounts {
  return {
    TH18: heatMapRef.th18Count,
    TH17: heatMapRef.th17Count,
    TH16: heatMapRef.th16Count,
    TH15: heatMapRef.th15Count,
    TH14: heatMapRef.th14Count,
    "<=TH13":
      heatMapRef.th13Count +
      heatMapRef.th12Count +
      heatMapRef.th11Count +
      heatMapRef.th10OrLowerCount,
  };
}

function buildDeltaByBucket(
  counts: CompoWarDisplayBucketCounts,
  heatMapRef: HeatMapRef | null,
): Record<CompoWarDisplayBucket, number | null> {
  if (!heatMapRef) {
    return {
      TH18: null,
      TH17: null,
      TH16: null,
      TH15: null,
      TH14: null,
      "<=TH13": null,
    };
  }
  const targetCounts = buildTargetCounts(heatMapRef);
  return {
    TH18: counts.TH18 - targetCounts.TH18,
    TH17: counts.TH17 - targetCounts.TH17,
    TH16: counts.TH16 - targetCounts.TH16,
    TH15: counts.TH15 - targetCounts.TH15,
    TH14: counts.TH14 - targetCounts.TH14,
    "<=TH13": counts["<=TH13"] - targetCounts["<=TH13"],
  };
}

function getRepresentativeWeight(
  bucket: CompoWarDisplayBucket,
  heatMapRef: HeatMapRef | null,
): number {
  if (bucket !== "<=TH13") {
    return REPRESENTATIVE_WEIGHTS[bucket];
  }
  if (!heatMapRef) {
    return LOW_BUCKET_DEFAULT_REPRESENTATIVE_WEIGHT;
  }
  const weightTotal =
    heatMapRef.th13Count * LOW_BUCKET_COMPONENT_MIDPOINTS.TH13 +
    heatMapRef.th12Count * LOW_BUCKET_COMPONENT_MIDPOINTS.TH12 +
    heatMapRef.th11Count * LOW_BUCKET_COMPONENT_MIDPOINTS.TH11 +
    heatMapRef.th10OrLowerCount * LOW_BUCKET_COMPONENT_MIDPOINTS.TH10_OR_LOWER;
  const countTotal =
    heatMapRef.th13Count +
    heatMapRef.th12Count +
    heatMapRef.th11Count +
    heatMapRef.th10OrLowerCount;
  return countTotal > 0
    ? Math.round(weightTotal / countTotal)
    : LOW_BUCKET_DEFAULT_REPRESENTATIVE_WEIGHT;
}

function addDisplayCounts(
  base: CompoWarDisplayBucketCounts,
  fillCounts: CompoWarDisplayBucketCounts,
): CompoWarDisplayBucketCounts {
  return {
    TH18: base.TH18 + fillCounts.TH18,
    TH17: base.TH17 + fillCounts.TH17,
    TH16: base.TH16 + fillCounts.TH16,
    TH15: base.TH15 + fillCounts.TH15,
    TH14: base.TH14 + fillCounts.TH14,
    "<=TH13": base["<=TH13"] + fillCounts["<=TH13"],
  };
}

function buildFillPlan(input: {
  displayCounts: CompoWarDisplayBucketCounts;
  nMissing: number;
  heatMapRef: HeatMapRef | null;
}): FillPlan {
  const fillCounts = buildEmptyDisplayCounts();
  if (!input.heatMapRef || input.nMissing <= 0) {
    return {
      fillCounts,
      addedWeight: 0,
    };
  }

  const deltas = buildDeltaByBucket(input.displayCounts, input.heatMapRef);
  let remaining = input.nMissing;

  for (const bucket of DISPLAY_BUCKETS_ASC) {
    const delta = deltas[bucket];
    const deficitSlots =
      typeof delta === "number" && delta < 0
        ? Math.min(remaining, Math.abs(delta))
        : 0;
    if (deficitSlots <= 0) continue;
    fillCounts[bucket] += deficitSlots;
    remaining -= deficitSlots;
    if (remaining <= 0) {
      break;
    }
  }

  // When all sheet deficits are already filled, keep overflow deterministic by
  // choosing the display bucket with the smallest non-negative post-fill delta,
  // breaking ties toward the lower Town Hall buckets first.
  while (remaining > 0) {
    const nextBucket = DISPLAY_BUCKETS_DESC.reduce<CompoWarDisplayBucket>(
      (best, bucket) => {
        const bestDistance = Math.abs(
          (deltas[best] ?? 0) + fillCounts[best],
        );
        const candidateDistance = Math.abs(
          (deltas[bucket] ?? 0) + fillCounts[bucket],
        );
        if (candidateDistance !== bestDistance) {
          return candidateDistance < bestDistance ? bucket : best;
        }
        return DISPLAY_BUCKETS_DESC.indexOf(bucket) <
          DISPLAY_BUCKETS_DESC.indexOf(best)
          ? bucket
          : best;
      },
      DISPLAY_BUCKETS_DESC[0],
    );
    fillCounts[nextBucket] += 1;
    remaining -= 1;
  }

  const addedWeight = DISPLAY_BUCKETS_ASC.reduce(
    (sum, bucket) =>
      sum +
      fillCounts[bucket] * getRepresentativeWeight(bucket, input.heatMapRef),
    0,
  );

  return {
    fillCounts,
    addedWeight,
  };
}

function buildEstimatedProjectionForBand(input: {
  view: "auto" | "best";
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRef: HeatMapRef;
}): CompoActualStateProjection {
  const missingTo50Count = Math.max(0, 50 - input.base.memberCount);
  const nMissing = missingTo50Count + input.base.unresolvedWeightCount;
  const fillPlan = buildFillPlan({
    displayCounts: input.displayCounts,
    nMissing,
    heatMapRef: input.heatMapRef,
  });
  const estimatedDisplayCounts = addDisplayCounts(
    input.displayCounts,
    fillPlan.fillCounts,
  );
  const deltaByBucket = buildDeltaByBucket(
    estimatedDisplayCounts,
    input.heatMapRef,
  );
  const deviationScore = DISPLAY_BUCKETS_ASC.reduce((sum, bucket) => {
    const delta = deltaByBucket[bucket];
    return sum + Math.abs(delta ?? 0) * DEVIATION_SCORE_WEIGHTS[bucket];
  }, 0);

  return {
    view: input.view,
    totalWeight: input.base.resolvedTotalWeight + fillPlan.addedWeight,
    missingWeights: nMissing,
    memberCount: input.base.memberCount,
    missingTo50Count,
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    nMissing,
    displayCounts: estimatedDisplayCounts,
    selectedHeatMapRef: input.heatMapRef,
    deltaByBucket,
    deviationScore,
  };
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
}): CompoActualStateProjection {
  const heatMapRef = findHeatMapRefForWeight(
    input.heatMapRefs,
    input.base.resolvedTotalWeight,
  );
  return {
    view: "raw",
    totalWeight: input.base.resolvedTotalWeight,
    missingWeights: input.base.unresolvedWeightCount,
    memberCount: input.base.memberCount,
    missingTo50Count: Math.max(0, 50 - input.base.memberCount),
    unresolvedWeightCount: input.base.unresolvedWeightCount,
    nMissing:
      Math.max(0, 50 - input.base.memberCount) + input.base.unresolvedWeightCount,
    displayCounts: input.displayCounts,
    selectedHeatMapRef: heatMapRef,
    deltaByBucket: buildDeltaByBucket(input.displayCounts, heatMapRef),
    deviationScore: null,
  };
}

function buildAutoProjection(input: {
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRefs: readonly HeatMapRef[];
}): CompoActualStateProjection {
  const rawProjection = buildRawProjection(input);
  if (!rawProjection.selectedHeatMapRef || rawProjection.nMissing <= 0) {
    return {
      ...rawProjection,
      view: "auto",
      missingWeights: rawProjection.nMissing,
    };
  }

  let currentRef = rawProjection.selectedHeatMapRef;
  const visitedBandKeys: string[] = [];
  let lastProjection = buildEstimatedProjectionForBand({
    view: "auto",
    base: input.base,
    displayCounts: input.displayCounts,
    heatMapRef: currentRef,
  });

  for (let index = 0; index < AUTO_DETECT_ITERATION_CAP; index += 1) {
    const nextRef =
      findHeatMapRefForWeight(input.heatMapRefs, lastProjection.totalWeight) ??
      currentRef;
    const currentBandKey = getHeatMapRefBandKey(currentRef);

    if (getHeatMapRefBandKey(nextRef) === currentBandKey) {
      return lastProjection;
    }

    if (
      visitedBandKeys.length >= 2 &&
      currentBandKey === visitedBandKeys[visitedBandKeys.length - 2] &&
      getHeatMapRefBandKey(nextRef) ===
        visitedBandKeys[visitedBandKeys.length - 1]
    ) {
      const nextProjection = buildEstimatedProjectionForBand({
        view: "auto",
        base: input.base,
        displayCounts: input.displayCounts,
        heatMapRef: nextRef,
      });
      return compareProjectionByBandFit(lastProjection, nextProjection);
    }

    visitedBandKeys.push(currentBandKey);
    currentRef = nextRef;
    lastProjection = buildEstimatedProjectionForBand({
      view: "auto",
      base: input.base,
      displayCounts: input.displayCounts,
      heatMapRef: currentRef,
    });
  }

  return lastProjection;
}

function buildBestFitProjection(input: {
  base: CompoActualStateBaseMetrics;
  displayCounts: CompoWarDisplayBucketCounts;
  heatMapRefs: readonly HeatMapRef[];
}): CompoActualStateProjection {
  const rawProjection = buildRawProjection(input);
  if (!rawProjection.selectedHeatMapRef) {
    return {
      ...rawProjection,
      view: "best",
      missingWeights: rawProjection.nMissing,
    };
  }

  const maxEstimatedTotal =
    input.base.resolvedTotalWeight +
    rawProjection.nMissing * REPRESENTATIVE_WEIGHTS.TH18;
  const candidates = listHeatMapRefsIntersectingWeightWindow(
    input.heatMapRefs,
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
}): CompoActualStateProjection {
  const displayCounts = collapseCompoWarBucketCountsForDisplay(input.base.bucketCounts);

  if (input.view === "raw") {
    return buildRawProjection({
      base: input.base,
      displayCounts,
      heatMapRefs: input.heatMapRefs,
    });
  }
  if (input.view === "auto") {
    return buildAutoProjection({
      base: input.base,
      displayCounts,
      heatMapRefs: input.heatMapRefs,
    });
  }
  return buildBestFitProjection({
    base: input.base,
    displayCounts,
    heatMapRefs: input.heatMapRefs,
  });
}

export const getCompoActualStateViewLabel = (
  view: CompoActualStateView,
): string => COMPO_ACTUAL_STATE_VIEW_LABELS[view];
