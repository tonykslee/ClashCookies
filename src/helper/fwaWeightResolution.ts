export type FwaResolvedWeightStatus = "RAW" | "DEFERRED" | "ESTIMATED" | "UNRESOLVED";

export type FwaWeightResolutionInput = {
  rawWeight: number | null | undefined;
  deferredWeight?: number | null;
};

export type FwaWeightResolution = {
  effectiveWeight: number | null;
  effectiveWeightStatus: FwaResolvedWeightStatus;
};

function positiveInteger(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

/** Purpose: apply the single agreed RAW/defer/rank-inference precedence to a war roster. */
export function resolveFwaWeightRows<T extends FwaWeightResolutionInput>(
  rows: readonly T[],
): Array<T & FwaWeightResolution> {
  const direct = rows.map((row) => ({
    row,
    rawWeight: positiveInteger(row.rawWeight),
    deferredWeight: positiveInteger(row.deferredWeight),
  }));
  const resolved: Array<T & FwaWeightResolution> = [];

  for (let index = 0; index < direct.length; index += 1) {
    const current = direct[index]!;
    if (current.rawWeight !== null) {
      resolved.push({ ...current.row, effectiveWeight: current.rawWeight, effectiveWeightStatus: "RAW" });
      continue;
    }
    if (current.deferredWeight !== null) {
      resolved.push({ ...current.row, effectiveWeight: current.deferredWeight, effectiveWeightStatus: "DEFERRED" });
      continue;
    }

    let blockEndExclusive = index + 1;
    while (
      blockEndExclusive < direct.length &&
      direct[blockEndExclusive]!.rawWeight === null &&
      direct[blockEndExclusive]!.deferredWeight === null
    ) {
      blockEndExclusive += 1;
    }
    const nextKnownWeight = direct[blockEndExclusive]?.rawWeight ?? direct[blockEndExclusive]?.deferredWeight ?? null;
    const lowestResolvedWeightAbove = resolved.reduce<number | null>((lowest, row) => {
      if (row.effectiveWeight === null) return lowest;
      return lowest === null ? row.effectiveWeight : Math.min(lowest, row.effectiveWeight);
    }, null);
    const fillWeight = nextKnownWeight ?? lowestResolvedWeightAbove;
    for (let zeroIndex = index; zeroIndex < blockEndExclusive; zeroIndex += 1) {
      const row = direct[zeroIndex]!.row;
      resolved.push({
        ...row,
        effectiveWeight: fillWeight,
        effectiveWeightStatus: fillWeight === null ? "UNRESOLVED" : "ESTIMATED",
      });
    }
    index = blockEndExclusive - 1;
  }

  return resolved;
}

