import { type FwaCatalogWeightAge } from "../../services/FwaWeightCatalogService";

export const WEIGHT_STALE_DAYS = 7;
export const WEIGHT_SEVERE_STALE_DAYS = 30;
export const FWA_WEIGHT_YELLOW_DAYS = 28;
export const FWA_WEIGHT_RED_DAYS = 42;

export type WeightHealthState = "recent" | "outdated" | "severely_outdated" | "unknown";
export type WeightSubmissionZone = "current" | "yellow" | "red" | "unknown";

/** Purpose: map numeric age values into health-state buckets for leadership display. */
export function getWeightHealthState(
  ageDays: number | null,
  staleThresholdDays = WEIGHT_STALE_DAYS,
  severeThresholdDays = WEIGHT_SEVERE_STALE_DAYS,
): WeightHealthState {
  if (ageDays === null || !Number.isFinite(ageDays)) return "unknown";
  if (ageDays >= severeThresholdDays) return "severely_outdated";
  if (ageDays > staleThresholdDays) return "outdated";
  return "recent";
}

/** Purpose: map a persisted weight age into the FWA submission timing zones. */
export function getWeightSubmissionZone(
  ageDays: number | null,
): WeightSubmissionZone {
  if (ageDays === null || !Number.isFinite(ageDays)) return "unknown";
  if (ageDays >= FWA_WEIGHT_RED_DAYS) return "red";
  if (ageDays >= FWA_WEIGHT_YELLOW_DAYS) return "yellow";
  return "current";
}

/** Purpose: render one persisted-catalog row for `/fwa weight-health` output. */
export function formatWeightHealthLine(input: {
  clanName: string;
  clanTag: string;
  result: FwaCatalogWeightAge;
  staleThresholdDays?: number;
  severeThresholdDays?: number;
}): string {
  const staleThresholdDays = input.staleThresholdDays ?? WEIGHT_STALE_DAYS;
  const severeThresholdDays = input.severeThresholdDays ?? WEIGHT_SEVERE_STALE_DAYS;
  const state = getWeightHealthState(
    input.result.ageDays,
    staleThresholdDays,
    severeThresholdDays,
  );
  const ageText = input.result.ageText ?? "unavailable";
  if (state === "recent") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \u2705`;
  }
  if (state === "outdated") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \u26a0\ufe0f`;
  }
  if (state === "severely_outdated") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \u274c`;
  }
  return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \u2753`;
}

/** Purpose: render one persisted-catalog row for the FWA submission zones view. */
export function formatWeightSubmissionZoneLine(input: {
  clanName: string;
  clanTag: string;
  result: FwaCatalogWeightAge;
}): string {
  const ageText = input.result.ageText ?? "unavailable";
  const zone = getWeightSubmissionZone(input.result.ageDays);
  if (zone === "current") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \ud83d\udfe2 Current`;
  }
  if (zone === "yellow") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \ud83d\udfe1 Yellow Zone`;
  }
  if (zone === "red") {
    return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \ud83d\udd34 Red Zone`;
  }
  return `${input.clanName} (#${input.clanTag}) \u2014 ${ageText} \u2753 Unknown`;
}
