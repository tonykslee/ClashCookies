import { type FwaCatalogWeightAge } from "../../services/FwaWeightCatalogService";

export const WEIGHT_STALE_DAYS = 7;
export const WEIGHT_SEVERE_STALE_DAYS = 30;

export type WeightHealthState = "recent" | "outdated" | "severely_outdated" | "unknown";

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

/** Purpose: render one persisted-catalog row for `/fwa weight-age` list output. */
export function formatWeightAgeLine(input: {
  clanName: string;
  clanTag: string;
  result: FwaCatalogWeightAge;
}): string {
  return `${input.clanName} (#${input.clanTag}) \u2014 ${input.result.ageText ?? "unavailable (unknown)"}`;
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
