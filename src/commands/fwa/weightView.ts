import { type FwaStatsWeightAge } from "../../services/FwaStatsWeightService";

export const WEIGHT_STALE_DAYS = 7;
export const WEIGHT_SEVERE_STALE_DAYS = 30;

type WeightHealthState = "recent" | "outdated" | "severely_outdated" | "unknown";

/** Purpose: map numeric age values into health-state buckets for leadership display. */
export function getWeightHealthState(
  ageDays: number | null,
  staleThresholdDays = WEIGHT_STALE_DAYS,
  severeThresholdDays = WEIGHT_SEVERE_STALE_DAYS
): WeightHealthState {
  if (ageDays === null || !Number.isFinite(ageDays)) return "unknown";
  if (ageDays >= severeThresholdDays) return "severely_outdated";
  if (ageDays > staleThresholdDays) return "outdated";
  return "recent";
}

/** Purpose: render one clan row for `/fwa weight-age` list output. */
export function formatWeightAgeLine(input: {
  clanName: string;
  clanTag: string;
  result: FwaStatsWeightAge;
}): string {
  if (input.result.status === "ok") {
    return `${input.clanName} (#${input.clanTag}) — ${input.result.ageText ?? "unknown"}`;
  }

  const errorText =
    input.result.status === "login_required_no_cookie"
      ? "auth cookie missing"
      : input.result.status === "login_required_cookie_rejected"
        ? "auth cookie rejected/expired"
        : input.result.status === "timeout"
          ? "timeout"
          : input.result.status === "parse_error"
            ? "parse failed"
            : input.result.status === "http_error"
              ? `http ${input.result.httpStatus ?? "error"}`
              : "network error";
  return `${input.clanName} (#${input.clanTag}) — unavailable (${errorText})`;
}

/** Purpose: identify auth-specific fwastats failure statuses. */
export function isWeightAuthFailureStatus(status: FwaStatsWeightAge["status"]): boolean {
  return status === "login_required_no_cookie" || status === "login_required_cookie_rejected";
}

/** Purpose: build operator-facing auth troubleshooting note for weight command outputs. */
export function buildWeightAuthFailureNote(results: FwaStatsWeightAge[]): string | null {
  const noCookieCount = results.filter((row) => row.status === "login_required_no_cookie").length;
  const rejectedCookieCount = results.filter(
    (row) => row.status === "login_required_cookie_rejected"
  ).length;
  if (noCookieCount <= 0 && rejectedCookieCount <= 0) return null;
  if (rejectedCookieCount > 0) {
    return "Auth required: fwastats rejected `FWASTATS_WEIGHT_COOKIE`. Rotate/check secret and retry.";
  }
  return "Auth required: set `FWASTATS_WEIGHT_COOKIE` in secrets, then retry.";
}

/** Purpose: render one clan row for `/fwa weight-health` output including status emoji. */
export function formatWeightHealthLine(input: {
  clanName: string;
  clanTag: string;
  result: FwaStatsWeightAge;
  staleThresholdDays?: number;
  severeThresholdDays?: number;
}): string {
  const staleThresholdDays = input.staleThresholdDays ?? WEIGHT_STALE_DAYS;
  const severeThresholdDays = input.severeThresholdDays ?? WEIGHT_SEVERE_STALE_DAYS;

  if (input.result.status !== "ok") {
    return `${input.clanName} (#${input.clanTag}) — unavailable ❓`;
  }

  const state = getWeightHealthState(
    input.result.ageDays,
    staleThresholdDays,
    severeThresholdDays
  );
  if (state === "recent") {
    return `${input.clanName} (#${input.clanTag}) — ${input.result.ageText ?? "unknown"} ✅`;
  }
  if (state === "outdated") {
    return `${input.clanName} (#${input.clanTag}) — ${input.result.ageText ?? "unknown"} ⚠️`;
  }
  if (state === "severely_outdated") {
    return `${input.clanName} (#${input.clanTag}) — ${input.result.ageText ?? "unknown"} ❌`;
  }
  return `${input.clanName} (#${input.clanTag}) — ${input.result.ageText ?? "unknown"} ❓`;
}
