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
