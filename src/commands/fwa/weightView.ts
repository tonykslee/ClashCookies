import { type FwaStatsWeightAge } from "../../services/FwaStatsWeightService";
import { type FwaStatsWeightAuthErrorCode } from "../../services/FwaStatsWeightCookieService";

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

/** Purpose: extract normalized fwastats auth error codes from one result row. */
export function getWeightAuthErrorCode(
  result: FwaStatsWeightAge
): FwaStatsWeightAuthErrorCode | null {
  return result.authErrorCode ?? null;
}

/** Purpose: build operator-facing auth troubleshooting guidance for weight command outputs. */
export function buildWeightAuthFailureNote(results: FwaStatsWeightAge[]): string | null {
  const authCodes = new Set(
    results.map((row) => getWeightAuthErrorCode(row)).filter(Boolean) as FwaStatsWeightAuthErrorCode[]
  );
  if (authCodes.size <= 0) return null;

  const detectedExpired = authCodes.has("FWASTATS_AUTH_EXPIRED");
  const detectedRequired = authCodes.has("FWASTATS_AUTH_REQUIRED");
  const detectedLoginPage = authCodes.has("FWASTATS_LOGIN_PAGE_DETECTED");
  const summary = detectedExpired
    ? "Detected: stored fwastats cookies were rejected or expired."
    : detectedRequired
      ? "Detected: fwastats cookies are missing."
      : detectedLoginPage
        ? "Detected: fwastats returned a login page."
        : "Detected: fwastats auth failed.";
  const visualGuideLine = detectedExpired
    ? "Visual guide: https://i.imgur.com/HFzGNQD.png"
    : null;

  const lines = [
    "Auth required for fwastats weight scraping.",
    summary,
    ...(visualGuideLine ? [visualGuideLine] : []),
    "Recovery steps:",
    "1. Go to https://fwastats.com and sign in.",
    "2. Press F12, open the Network tab, and refresh.",
    "3. Copy the two AspNetCore cookie values (or full name=value pairs).",
    "4. Run `/fwa weight-cookie application-cookie:<cookie-1> antiforgery-cookie:<cookie-2>`.",
  ];
  return lines.join("\n");
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
