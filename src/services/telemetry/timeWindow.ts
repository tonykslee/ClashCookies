const MIN_CADENCE_HOURS = 1;
const MAX_CADENCE_HOURS = 24 * 30;

/** Purpose: parse timezone offset from Intl shortOffset tokens such as GMT+09 or GMT-08:30. */
function parseOffsetMinutes(offsetToken: string): number {
  const normalized = offsetToken.replace("UTC", "GMT");
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

/** Purpose: resolve timezone offset minutes for a UTC date using Intl metadata. */
function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const token =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "GMT+00";
  return parseOffsetMinutes(token);
}

/** Purpose: normalize cadence hour config into a bounded integer. */
export function normalizeCadenceHours(input: number): number {
  if (!Number.isFinite(input)) return 24;
  const value = Math.trunc(input);
  if (value < MIN_CADENCE_HOURS) return MIN_CADENCE_HOURS;
  if (value > MAX_CADENCE_HOURS) return MAX_CADENCE_HOURS;
  return value;
}

/** Purpose: validate an IANA timezone identifier. */
export function isValidIanaTimeZone(value: string): boolean {
  const candidate = String(value ?? "").trim();
  if (!candidate) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Purpose: compute previous completed cadence window start/end in UTC for a configured timezone. */
export function getPreviousCompletedWindow(
  now: Date,
  cadenceHours: number,
  timeZone: string
): { start: Date; end: Date } {
  const cadenceMs = normalizeCadenceHours(cadenceHours) * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const offsetNowMs = getTimeZoneOffsetMinutes(now, timeZone) * 60 * 1000;
  const zonedNowMs = nowMs + offsetNowMs;
  const currentWindowStartZoned = Math.floor(zonedNowMs / cadenceMs) * cadenceMs;
  const previousWindowStartZoned = currentWindowStartZoned - cadenceMs;
  const previousWindowEndZoned = currentWindowStartZoned;

  // Iteratively refine UTC conversion around DST transitions.
  let startUtcMs = previousWindowStartZoned - offsetNowMs;
  let endUtcMs = previousWindowEndZoned - offsetNowMs;
  for (let i = 0; i < 2; i += 1) {
    const startOffsetMs = getTimeZoneOffsetMinutes(new Date(startUtcMs), timeZone) * 60 * 1000;
    const endOffsetMs = getTimeZoneOffsetMinutes(new Date(endUtcMs), timeZone) * 60 * 1000;
    startUtcMs = previousWindowStartZoned - startOffsetMs;
    endUtcMs = previousWindowEndZoned - endOffsetMs;
  }

  return {
    start: new Date(startUtcMs),
    end: new Date(endUtcMs),
  };
}

/** Purpose: format a UTC date in a report-friendly style for a configured timezone. */
export function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
