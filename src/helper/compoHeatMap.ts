import type { HeatMapRef } from "@prisma/client";

/** Purpose: resolve the matching persisted HeatMapRef band for one total effective roster weight. */
export function findHeatMapRefForWeight(
  refs: readonly HeatMapRef[],
  totalEffectiveWeight: number,
): HeatMapRef | null {
  return (
    refs.find(
      (row) =>
        totalEffectiveWeight >= row.weightMinInclusive &&
        totalEffectiveWeight <= row.weightMaxInclusive,
    ) ?? null
  );
}

/** Purpose: expose one stable key for deterministic HeatMapRef band comparisons. */
export function getHeatMapRefBandKey(ref: Pick<HeatMapRef, "weightMinInclusive" | "weightMaxInclusive">): string {
  return `${ref.weightMinInclusive}-${ref.weightMaxInclusive}`;
}

/** Purpose: compute the midpoint of one HeatMapRef band for tie-break comparisons. */
export function getHeatMapRefBandMidpoint(
  ref: Pick<HeatMapRef, "weightMinInclusive" | "weightMaxInclusive">,
): number {
  return (ref.weightMinInclusive + ref.weightMaxInclusive) / 2;
}

/** Purpose: compute the advice-display midpoint for one HeatMapRef band using edge-band special cases. */
export function getHeatMapRefAdviceMidpoint(
  refs: readonly HeatMapRef[],
  target: Pick<HeatMapRef, "weightMinInclusive" | "weightMaxInclusive"> | null,
): number | null {
  if (!target) return null;
  if (refs.length <= 1) {
    return getHeatMapRefBandMidpoint(target);
  }

  const sortedRefs = [...refs].sort((left, right) => {
    if (left.weightMinInclusive !== right.weightMinInclusive) {
      return left.weightMinInclusive - right.weightMinInclusive;
    }
    if (left.weightMaxInclusive !== right.weightMaxInclusive) {
      return left.weightMaxInclusive - right.weightMaxInclusive;
    }
    return `${left.weightMinInclusive}-${left.weightMaxInclusive}`.localeCompare(
      `${right.weightMinInclusive}-${right.weightMaxInclusive}`,
    );
  });
  const targetIndex = sortedRefs.findIndex(
    (ref) =>
      ref.weightMinInclusive === target.weightMinInclusive &&
      ref.weightMaxInclusive === target.weightMaxInclusive,
  );
  if (targetIndex < 0) {
    return getHeatMapRefBandMidpoint(target);
  }
  if (targetIndex === 0) {
    return target.weightMaxInclusive - 50_000;
  }
  if (targetIndex === sortedRefs.length - 1) {
    return target.weightMinInclusive + 50_000;
  }
  return getHeatMapRefBandMidpoint(target);
}

/** Purpose: render one HeatMapRef band in a compact, user-facing range format. */
export function formatHeatMapRefBandLabel(
  ref: Pick<HeatMapRef, "weightMinInclusive" | "weightMaxInclusive">,
): string {
  return `${ref.weightMinInclusive.toLocaleString("en-US")} - ${ref.weightMaxInclusive.toLocaleString("en-US")}`;
}

/** Purpose: bound HeatMapRef candidate scans to bands that intersect one possible total-weight window. */
export function listHeatMapRefsIntersectingWeightWindow(
  refs: readonly HeatMapRef[],
  minWeightInclusive: number,
  maxWeightInclusive: number,
): HeatMapRef[] {
  return refs.filter(
    (row) =>
      row.weightMaxInclusive >= minWeightInclusive &&
      row.weightMinInclusive <= maxWeightInclusive,
  );
}
