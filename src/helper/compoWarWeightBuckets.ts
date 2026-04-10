export type CompoWarWeightBucket =
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

/** Purpose: classify one persisted effective roster weight into the WAR compo bucket ranges used for sheet parity. */
export function getCompoWarWeightBucket(
  effectiveWeight: number | null,
): CompoWarWeightBucket | null {
  if (effectiveWeight === null || !Number.isFinite(effectiveWeight) || effectiveWeight < 0) {
    return null;
  }
  if (effectiveWeight >= 171000 && effectiveWeight <= 180000) return "TH18";
  if (effectiveWeight >= 161000 && effectiveWeight <= 170000) return "TH17";
  if (effectiveWeight >= 151000 && effectiveWeight <= 160000) return "TH16";
  if (effectiveWeight >= 141000 && effectiveWeight <= 150000) return "TH15";
  if (effectiveWeight >= 131000 && effectiveWeight <= 140000) return "TH14";
  if (effectiveWeight >= 121000 && effectiveWeight <= 130000) return "TH13";
  if (effectiveWeight >= 111000 && effectiveWeight <= 120000) return "TH12";
  if (effectiveWeight >= 91000 && effectiveWeight <= 110000) return "TH11";
  if (effectiveWeight >= 71000 && effectiveWeight <= 90000) return "TH10";
  if (effectiveWeight >= 56000 && effectiveWeight <= 70000) return "TH9";
  if (effectiveWeight <= 55000) return "TH8_OR_LOWER";
  return null;
}
