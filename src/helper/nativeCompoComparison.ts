import {
  calculateProfileDeviationScore,
  NATIVE_PROVISIONAL_COMPOSITION_PROFILE,
} from "./compoCalculationProfile";

type NativeReferenceRead = {
  status: "CURRENT" | "UNKNOWN";
  generationId: string | null;
  profileVersion: string;
  policyVersion: string;
  sampleThreshold: number | null;
  bands: readonly { weightMinInclusive: number; weightMaxInclusive: number }[];
  targets: readonly {
    bandOrdinal: number;
    bucketId: string;
    status: "SUPPORTED" | "UNKNOWN";
    targetCount: number | null;
  }[];
};

export type NativeCompoComparison = {
  status: "SUPPORTED" | "UNKNOWN";
  bandOrdinal: number | null;
  score: number | null;
  reason: string | null;
  deltaByBucket: Readonly<Record<string, number | null>>;
};

/** The compact state-table columns shared by ACTUAL and WAR displays. */
export const NATIVE_COMPO_DISPLAY_BUCKETS = [
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "<=TH13",
] as const;

/**
 * Collapse native TH13-and-below targets into the same display bucket used by
 * the legacy state table. Unknown native targets stay unknown; they are never
 * treated as zero while aggregating the lower bucket.
 */
export function getNativeCompoDisplayDeltas(
  comparison: NativeCompoComparison,
): Readonly<Record<(typeof NATIVE_COMPO_DISPLAY_BUCKETS)[number], number | null>> {
  const lowerBucketIds = ["TH13", "TH12", "TH11", "TH10_OR_LOWER"] as const;
  const lowerDeltas = lowerBucketIds.map((bucketId) => comparison.deltaByBucket[bucketId]);
  return {
    TH18: comparison.deltaByBucket.TH18 ?? null,
    TH17: comparison.deltaByBucket.TH17 ?? null,
    TH16: comparison.deltaByBucket.TH16 ?? null,
    TH15: comparison.deltaByBucket.TH15 ?? null,
    TH14: comparison.deltaByBucket.TH14 ?? null,
    "<=TH13": lowerDeltas.every((value): value is number => typeof value === "number")
      ? lowerDeltas.reduce((sum, value) => sum + value, 0)
      : null,
  };
}

/** Build the profile-owned comparison used only for informational state rendering. */
export function calculateNativeCompoComparison(input: {
  native: NativeReferenceRead;
  totalWeight: number;
  sourceCounts: Readonly<Record<string, number | null | undefined>>;
}): NativeCompoComparison {
  const unknown = (reason: string, bandOrdinal: number | null = null): NativeCompoComparison => ({
    status: "UNKNOWN",
    bandOrdinal,
    score: null,
    reason,
    deltaByBucket: Object.fromEntries(
      NATIVE_PROVISIONAL_COMPOSITION_PROFILE.buckets.map((bucket) => [bucket.id, null]),
    ),
  });

  if (input.native.status !== "CURRENT") return unknown("native generation unavailable");
  const bandOrdinal = input.native.bands.findIndex(
    (band) => input.totalWeight >= band.weightMinInclusive && input.totalWeight <= band.weightMaxInclusive,
  );
  if (bandOrdinal < 0) return unknown("band unavailable");

  const targets = new Map(
    input.native.targets
      .filter((target) => target.bandOrdinal === bandOrdinal)
      .map((target) => [target.bucketId, target]),
  );
  const observedCounts: Record<string, number> = {};
  const targetCounts: Record<string, number> = {};
  const deltaByBucket: Record<string, number | null> = {};
  for (const bucket of NATIVE_PROVISIONAL_COMPOSITION_PROFILE.buckets) {
    observedCounts[bucket.id] = bucket.sourceBucketIds.reduce(
      (sum, sourceId) => sum + (input.sourceCounts[sourceId] ?? 0),
      0,
    );
    const mapping = NATIVE_PROVISIONAL_COMPOSITION_PROFILE.targetMappings.find(
      (candidate) => candidate.calculationBucketId === bucket.id,
    );
    const mapped = mapping?.referenceBucketIds.map((id) => targets.get(id));
    if (!mapped?.length || mapped.some((target) => target?.status !== "SUPPORTED" || target.targetCount === null)) {
      return unknown("target unavailable", bandOrdinal);
    }
    targetCounts[bucket.id] = mapped.reduce((sum, target) => sum + (target?.targetCount ?? 0), 0);
    deltaByBucket[bucket.id] = observedCounts[bucket.id] - targetCounts[bucket.id];
  }
  const score = calculateProfileDeviationScore({
    profile: NATIVE_PROVISIONAL_COMPOSITION_PROFILE,
    observedCounts,
    targetCounts,
  });
  if (score === null) return unknown("profile calculation unavailable", bandOrdinal);
  return { status: "SUPPORTED", bandOrdinal, score, reason: null, deltaByBucket };
}

export const NATIVE_COMPO_COMPARISON_BUCKETS = NATIVE_PROVISIONAL_COMPOSITION_PROFILE.buckets.map(
  (bucket) => bucket.id,
);
