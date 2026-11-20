export type CompoWarWeightBucket =
  | "TH19"
  | "TH18"
  | "TH17"
  | "TH16"
  | "TH15"
  | "TH14"
  | "TH13"
  | "TH12"
  | "TH11"
  | "TH10"
  | "TH9"
  | "TH8_OR_LOWER";

export type CompoWarDisplayBucket =
  | "TH19"
  | "TH18"
  | "TH17"
  | "TH16"
  | "TH15"
  | "TH14"
  | "<=TH13";

export type CompoWarWeightBand = {
  bucket: CompoWarWeightBucket;
  minInclusive: number;
  maxInclusive: number;
};

/** Purpose: provide the single ordered weight-band definition shared by ACTUAL, WAR, placement, and filler flows. */
export const COMPO_WAR_WEIGHT_BANDS: readonly CompoWarWeightBand[] = [
  { bucket: "TH19", minInclusive: 181000, maxInclusive: 190000 },
  { bucket: "TH18", minInclusive: 171000, maxInclusive: 180000 },
  { bucket: "TH17", minInclusive: 161000, maxInclusive: 170000 },
  { bucket: "TH16", minInclusive: 151000, maxInclusive: 160000 },
  { bucket: "TH15", minInclusive: 141000, maxInclusive: 150000 },
  { bucket: "TH14", minInclusive: 131000, maxInclusive: 140000 },
  { bucket: "TH13", minInclusive: 121000, maxInclusive: 130000 },
  { bucket: "TH12", minInclusive: 111000, maxInclusive: 120000 },
  { bucket: "TH11", minInclusive: 91000, maxInclusive: 110000 },
  { bucket: "TH10", minInclusive: 71000, maxInclusive: 90000 },
  { bucket: "TH9", minInclusive: 56000, maxInclusive: 70000 },
  { bucket: "TH8_OR_LOWER", minInclusive: 0, maxInclusive: 55000 },
] as const;

/** Purpose: classify one persisted effective roster weight into the WAR compo bucket ranges used for sheet parity. */
export function getCompoWarWeightBucket(
  effectiveWeight: number | null,
): CompoWarWeightBucket | null {
  if (
    effectiveWeight === null ||
    !Number.isFinite(effectiveWeight) ||
    !Number.isInteger(effectiveWeight) ||
    effectiveWeight < 0
  ) {
    return null;
  }
  return (
    COMPO_WAR_WEIGHT_BANDS.find(
      (band) =>
        effectiveWeight >= band.minInclusive && effectiveWeight <= band.maxInclusive,
    )?.bucket ?? null
  );
}

/** Purpose: collapse one granular WAR compo weight bucket into the stable display columns used by `/compo`. */
export function collapseCompoWarWeightBucketForDisplay(
  bucket: CompoWarWeightBucket,
): CompoWarDisplayBucket {
  if (
    bucket === "TH13" ||
    bucket === "TH12" ||
    bucket === "TH11" ||
    bucket === "TH10" ||
    bucket === "TH9" ||
    bucket === "TH8_OR_LOWER"
  ) {
    return "<=TH13";
  }
  return bucket;
}

/** Purpose: map one raw input or effective weight into the stable `/compo place` display bucket set. */
export function getCompoWarDisplayBucket(
  weight: number | null,
): CompoWarDisplayBucket | null {
  const granular = getCompoWarWeightBucket(weight);
  return granular ? collapseCompoWarWeightBucketForDisplay(granular) : null;
}
