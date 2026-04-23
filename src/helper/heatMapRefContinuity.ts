import type { HeatMapRef } from "@prisma/client";
import { getHeatMapRefBandKey } from "./compoHeatMap";

export type HeatMapRefBandDefinition = Pick<
  HeatMapRef,
  "weightMinInclusive" | "weightMaxInclusive"
>;

export type HeatMapRefContinuityGap = {
  previousBandKey: string;
  nextBandKey: string;
  startInclusive: number;
  endInclusive: number;
};

export type HeatMapRefContinuityOverlap = {
  previousBandKey: string;
  nextBandKey: string;
  startInclusive: number;
  endInclusive: number;
};

export type HeatMapRefContinuityInvalidRange = {
  bandKey: string;
  rowIndex: number;
  weightMinInclusive: number;
  weightMaxInclusive: number;
};

export type HeatMapRefContinuityUnsortedPair = {
  previousBandKey: string;
  nextBandKey: string;
  previousIndex: number;
  nextIndex: number;
};

export type HeatMapRefContinuityValidationResult = {
  bandCount: number;
  minBandKey: string | null;
  maxBandKey: string | null;
  isSortedAscending: boolean;
  hasContinuousCoverage: boolean;
  firstGap: HeatMapRefContinuityGap | null;
  firstOverlap: HeatMapRefContinuityOverlap | null;
  duplicateBandKeys: string[];
  firstInvalidRange: HeatMapRefContinuityInvalidRange | null;
  firstUnsortedPair: HeatMapRefContinuityUnsortedPair | null;
};

function buildMinBandKey(rows: readonly HeatMapRefBandDefinition[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const minRow = rows.reduce((best, current) => {
    if (current.weightMinInclusive !== best.weightMinInclusive) {
      return current.weightMinInclusive < best.weightMinInclusive ? current : best;
    }
    if (current.weightMaxInclusive !== best.weightMaxInclusive) {
      return current.weightMaxInclusive < best.weightMaxInclusive ? current : best;
    }
    return best;
  });
  return getHeatMapRefBandKey(minRow);
}

function buildMaxBandKey(rows: readonly HeatMapRefBandDefinition[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const maxRow = rows.reduce((best, current) => {
    if (current.weightMaxInclusive !== best.weightMaxInclusive) {
      return current.weightMaxInclusive > best.weightMaxInclusive ? current : best;
    }
    if (current.weightMinInclusive !== best.weightMinInclusive) {
      return current.weightMinInclusive > best.weightMinInclusive ? current : best;
    }
    return best;
  });
  return getHeatMapRefBandKey(maxRow);
}

/** Purpose: validate HeatMapRef band continuity and report the first gap/overlap details. */
export function validateHeatMapRefContinuity(
  rows: readonly HeatMapRefBandDefinition[],
): HeatMapRefContinuityValidationResult {
  const bandCounts = new Map<string, number>();
  let isSortedAscending = true;
  let firstGap: HeatMapRefContinuityGap | null = null;
  let firstOverlap: HeatMapRefContinuityOverlap | null = null;
  let firstInvalidRange: HeatMapRefContinuityInvalidRange | null = null;
  let firstUnsortedPair: HeatMapRefContinuityUnsortedPair | null = null;

  rows.forEach((row, rowIndex) => {
    const bandKey = getHeatMapRefBandKey(row);
    bandCounts.set(bandKey, (bandCounts.get(bandKey) ?? 0) + 1);

    if (firstInvalidRange === null && row.weightMinInclusive > row.weightMaxInclusive) {
      firstInvalidRange = {
        bandKey,
        rowIndex,
        weightMinInclusive: row.weightMinInclusive,
        weightMaxInclusive: row.weightMaxInclusive,
      };
    }

    const previous = rowIndex > 0 ? rows[rowIndex - 1] ?? null : null;
    if (!previous) {
      return;
    }

    const previousBandKey = getHeatMapRefBandKey(previous);
    if (
      row.weightMinInclusive < previous.weightMinInclusive ||
      (row.weightMinInclusive === previous.weightMinInclusive &&
        row.weightMaxInclusive < previous.weightMaxInclusive)
    ) {
      isSortedAscending = false;
      if (!firstUnsortedPair) {
        firstUnsortedPair = {
          previousBandKey,
          nextBandKey: bandKey,
          previousIndex: rowIndex - 1,
          nextIndex: rowIndex,
        };
      }
    }

    if (firstInvalidRange !== null) {
      return;
    }

    if (row.weightMinInclusive <= previous.weightMaxInclusive) {
      if (!firstOverlap) {
        firstOverlap = {
          previousBandKey,
          nextBandKey: bandKey,
          startInclusive: row.weightMinInclusive,
          endInclusive: Math.min(previous.weightMaxInclusive, row.weightMaxInclusive),
        };
      }
      return;
    }

    if (row.weightMinInclusive !== previous.weightMaxInclusive + 1) {
      if (!firstGap) {
        firstGap = {
          previousBandKey,
          nextBandKey: bandKey,
          startInclusive: previous.weightMaxInclusive + 1,
          endInclusive: row.weightMinInclusive - 1,
        };
      }
    }
  });

  const duplicateBandKeys = [...bandCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([bandKey]) => bandKey)
    .sort((left, right) => left.localeCompare(right));

  const hasContinuousCoverage =
    isSortedAscending &&
    firstInvalidRange === null &&
    firstUnsortedPair === null &&
    firstGap === null &&
    firstOverlap === null &&
    duplicateBandKeys.length === 0;

  return {
    bandCount: rows.length,
    minBandKey: buildMinBandKey(rows),
    maxBandKey: buildMaxBandKey(rows),
    isSortedAscending,
    hasContinuousCoverage,
    firstGap,
    firstOverlap,
    duplicateBandKeys,
    firstInvalidRange,
    firstUnsortedPair,
  };
}

function buildContinuityIssueSummary(validation: HeatMapRefContinuityValidationResult): string {
  if (validation.firstInvalidRange) {
    return `invalid_range:${validation.firstInvalidRange.bandKey}@${validation.firstInvalidRange.weightMinInclusive}-${validation.firstInvalidRange.weightMaxInclusive}`;
  }
  if (validation.firstUnsortedPair) {
    return `unsorted:${validation.firstUnsortedPair.previousBandKey}>${validation.firstUnsortedPair.nextBandKey}`;
  }
  if (validation.firstOverlap) {
    return `overlap:${validation.firstOverlap.previousBandKey}>${validation.firstOverlap.nextBandKey}@${validation.firstOverlap.startInclusive}-${validation.firstOverlap.endInclusive}`;
  }
  if (validation.firstGap) {
    return `gap:${validation.firstGap.previousBandKey}>${validation.firstGap.nextBandKey}@${validation.firstGap.startInclusive}-${validation.firstGap.endInclusive}`;
  }
  if (validation.duplicateBandKeys.length > 0) {
    return `duplicate:${validation.duplicateBandKeys.join(",")}`;
  }
  return "none";
}

/** Purpose: render a narrow operator log line for HeatMapRef rebuild/write continuity checks. */
export function buildHeatMapRefContinuityLogLine(input: {
  operation: string;
  validation: HeatMapRefContinuityValidationResult;
}): string {
  const status = input.validation.hasContinuousCoverage ? "ok" : "invalid";
  const parts = [
    "[heatmapref-continuity]",
    `operation=${input.operation}`,
    `band_count=${input.validation.bandCount}`,
    `min_band=${input.validation.minBandKey ?? "none"}`,
    `max_band=${input.validation.maxBandKey ?? "none"}`,
    `sorted=${input.validation.isSortedAscending ? "yes" : "no"}`,
    `continuity=${status}`,
    `issue=${buildContinuityIssueSummary(input.validation)}`,
  ];
  if (input.validation.firstGap) {
    parts.push(
      `first_gap=${input.validation.firstGap.startInclusive}-${input.validation.firstGap.endInclusive}`,
    );
  }
  if (input.validation.firstOverlap) {
    parts.push(
      `first_overlap=${input.validation.firstOverlap.startInclusive}-${input.validation.firstOverlap.endInclusive}`,
    );
  }
  if (input.validation.firstInvalidRange) {
    parts.push(
      `first_invalid_range=${input.validation.firstInvalidRange.weightMinInclusive}-${input.validation.firstInvalidRange.weightMaxInclusive}`,
    );
  }
  if (input.validation.duplicateBandKeys.length > 0) {
    parts.push(`duplicate_keys=${input.validation.duplicateBandKeys.join(",")}`);
  }
  return parts.join(" ");
}

/** Purpose: validate continuity and throw a descriptive error before invalid HeatMapRef rows are written. */
export function assertHeatMapRefContinuityOrThrow(input: {
  operation: string;
  rows: readonly HeatMapRefBandDefinition[];
}): HeatMapRefContinuityValidationResult {
  const validation = validateHeatMapRefContinuity(input.rows);
  const logLine = buildHeatMapRefContinuityLogLine({
    operation: input.operation,
    validation,
  });
  if (validation.hasContinuousCoverage) {
    console.log(logLine);
    return validation;
  }

  console.warn(logLine);
  throw new Error(`HeatMapRef continuity validation failed: ${logLine}`);
}
