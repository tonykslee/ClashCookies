const SYNC_TIMEZONE_ALIAS_MAP = new Map<string, string>([
  ["ET", "America/New_York"],
  ["EST", "America/New_York"],
  ["EDT", "America/New_York"],
  ["CT", "America/Chicago"],
  ["CST", "America/Chicago"],
  ["CDT", "America/Chicago"],
  ["MT", "America/Denver"],
  ["MST", "America/Denver"],
  ["MDT", "America/Denver"],
  ["PT", "America/Los_Angeles"],
  ["PST", "America/Los_Angeles"],
  ["PDT", "America/Los_Angeles"],
]);

function canonicalizeTimeZone(value: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function isSupportedSyncTimeZone(timeZone: string): boolean {
  if (timeZone === "UTC") return true;
  return timeZone.includes("/") && !timeZone.startsWith("Etc/");
}

/** Purpose: normalize sync-time timezone input into a canonical region timezone or UTC. */
export function normalizeSyncTimeZone(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const aliased = SYNC_TIMEZONE_ALIAS_MAP.get(trimmed.toUpperCase()) ?? trimmed;
  const canonical = canonicalizeTimeZone(aliased);
  if (!canonical) return null;

  return isSupportedSyncTimeZone(canonical) ? canonical : null;
}
