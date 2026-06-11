import { toPositiveCompoWeight } from "./compoActualWeight";

export type EffectiveWeightCandidate<TSource extends string> = {
  source: TSource;
  weight: number | null | undefined;
};

export type EffectiveWeightResolution<TSource extends string> = {
  resolvedWeight: number | null;
  resolvedWeightSource: TSource | null;
};

function resolveBestPositiveWeight<TSource extends string>(
  candidates: Array<EffectiveWeightCandidate<TSource>>,
): EffectiveWeightResolution<TSource> {
  let bestSource: TSource | null = null;
  let bestWeight: number | null = null;

  for (const candidate of candidates) {
    const normalized = toPositiveCompoWeight(candidate.weight);
    if (normalized === null) continue;
    if (bestWeight === null || normalized > bestWeight) {
      bestWeight = normalized;
      bestSource = candidate.source;
    }
  }

  return {
    resolvedWeight: bestWeight,
    resolvedWeightSource: bestSource,
  };
}

function resolveFirstPositiveWeight<TSource extends string>(
  candidates: Array<EffectiveWeightCandidate<TSource>>,
): EffectiveWeightResolution<TSource> {
  for (const candidate of candidates) {
    const normalized = toPositiveCompoWeight(candidate.weight);
    if (normalized === null) continue;
    return {
      resolvedWeight: normalized,
      resolvedWeightSource: candidate.source,
    };
  }

  return {
    resolvedWeight: null,
    resolvedWeightSource: null,
  };
}

/** Purpose: resolve the highest-confidence player weight while preserving existing fallback-only sources. */
export function resolveEffectivePlayerWeight<TPrimary extends string, TOverride extends string, TFallback extends string>(
  input: {
    primaryCandidates: Array<EffectiveWeightCandidate<TPrimary>>;
    overrideCandidates?: Array<EffectiveWeightCandidate<TOverride>>;
    fallbackCandidates?: Array<EffectiveWeightCandidate<TFallback>>;
  },
): EffectiveWeightResolution<TPrimary | TOverride | TFallback> {
  const primary = resolveBestPositiveWeight(input.primaryCandidates);
  const override = resolveBestPositiveWeight(input.overrideCandidates ?? []);

  if (primary.resolvedWeight !== null || override.resolvedWeight !== null) {
    if (primary.resolvedWeight === null) {
      return override;
    }
    if (override.resolvedWeight === null) {
      return primary;
    }
    if (override.resolvedWeight > primary.resolvedWeight) {
      return override;
    }
    return primary;
  }

  return resolveFirstPositiveWeight(input.fallbackCandidates ?? []);
}
