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
