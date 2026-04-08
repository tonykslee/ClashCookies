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

const CURATED_SYNC_TIME_ZONES = [
  {
    timeZone: "America/New_York",
    aliases: ["ET", "EST", "EDT", "Eastern"],
  },
  {
    timeZone: "America/Chicago",
    aliases: ["CT", "CST", "CDT", "Central"],
  },
  {
    timeZone: "America/Denver",
    aliases: ["MT", "MST", "MDT", "Mountain"],
  },
  {
    timeZone: "America/Los_Angeles",
    aliases: ["PT", "PST", "PDT", "Pacific"],
  },
  {
    timeZone: "America/Phoenix",
    aliases: ["Arizona"],
  },
  {
    timeZone: "America/Anchorage",
    aliases: ["Alaska"],
  },
  {
    timeZone: "America/Honolulu",
    aliases: ["Hawaii"],
  },
  {
    timeZone: "Europe/London",
    aliases: ["UK", "GMT", "BST", "Britain"],
  },
  {
    timeZone: "Europe/Paris",
    aliases: ["CET", "CEST", "France"],
  },
  {
    timeZone: "Asia/Tokyo",
    aliases: ["Japan", "JST"],
  },
  {
    timeZone: "Australia/Sydney",
    aliases: ["AEST", "AEDT", "Australia"],
  },
  {
    timeZone: "America/Toronto",
    aliases: ["Canada"],
  },
] as const;

type SyncTimeZoneAutocompleteChoice = {
  name: string;
  value: string;
};

type RankedSyncTimeZoneChoice = SyncTimeZoneAutocompleteChoice & {
  rank: number;
};

type CuratedSyncTimeZoneChoice = RankedSyncTimeZoneChoice & {
  curatedIndex: number;
};

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

function getSupportedIanaTimeZones(): string[] {
  const supportedValuesOf = (globalThis.Intl as typeof globalThis.Intl & {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  if (typeof supportedValuesOf !== "function") return [];
  try {
    return supportedValuesOf("timeZone").filter(
      (timeZone) => timeZone.includes("/") && !timeZone.startsWith("Etc/")
    );
  } catch {
    return [];
  }
}

function compactTimeZoneSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildTimeZoneSearchText(timeZone: string, aliases: readonly string[]): string {
  return [timeZone, ...aliases].join(" ").toLowerCase();
}

function rankSyncTimeZoneChoice(
  timeZone: string,
  aliases: readonly string[],
  query: string
): number | null {
  const compactQuery = compactTimeZoneSearchText(query);
  if (!compactQuery) return 0;

  const searchText = buildTimeZoneSearchText(timeZone, aliases);
  const compactSearchText = compactTimeZoneSearchText(searchText);
  const exactMatch = searchText === query.toLowerCase() || compactSearchText === compactQuery;
  if (exactMatch) return 0;
  if (searchText.startsWith(query.toLowerCase()) || compactSearchText.startsWith(compactQuery)) {
    return 1;
  }
  if (searchText.includes(query.toLowerCase()) || compactSearchText.includes(compactQuery)) {
    return 2;
  }
  return null;
}

function buildAutocompleteChoices(
  timeZones: string[],
  query: string
): SyncTimeZoneAutocompleteChoice[] {
  const curatedTimeZones = new Set<string>(CURATED_SYNC_TIME_ZONES.map((entry) => entry.timeZone));
  const normalizedQuery = query.trim();
  const curatedChoices: CuratedSyncTimeZoneChoice[] = [];
  for (const [index, entry] of CURATED_SYNC_TIME_ZONES.entries()) {
    const rank = rankSyncTimeZoneChoice(entry.timeZone, entry.aliases, normalizedQuery);
    if (rank === null) continue;
    curatedChoices.push({
      name: entry.timeZone,
      value: entry.timeZone,
      rank,
      curatedIndex: index,
    });
  }

  const broadChoices: RankedSyncTimeZoneChoice[] = [];
  for (const timeZone of timeZones) {
    if (curatedTimeZones.has(timeZone)) continue;
    const rank = rankSyncTimeZoneChoice(timeZone, [], normalizedQuery);
    if (rank === null) continue;
    broadChoices.push({
      name: timeZone,
      value: timeZone,
      rank,
    });
  }

  curatedChoices.sort((left, right) => left.rank - right.rank || left.curatedIndex - right.curatedIndex);
  broadChoices.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));

  return [...curatedChoices, ...broadChoices].slice(0, 25).map(({ name, value }) => ({ name, value }));
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

/** Purpose: build bounded IANA-only autocomplete choices for sync-time timezone inputs. */
export function autocompleteSyncTimeZones(input: string | null | undefined): SyncTimeZoneAutocompleteChoice[] {
  return buildAutocompleteChoices(getSupportedIanaTimeZones(), String(input ?? ""));
}

function getTimeZoneOffsetMinutes(timeZone: string, referenceDate: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const token =
    formatter.formatToParts(referenceDate).find((part) => part.type === "timeZoneName")?.value ??
    "GMT+00";
  const normalized = token.replace("UTC", "GMT");
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}

/** Purpose: return supported canonical IANA zones in stable current-offset order for timezone stepping. */
export function getSupportedSyncTimeZones(referenceDate = new Date()): string[] {
  const supported = ["UTC", ...getSupportedIanaTimeZones()];
  return [...new Set(supported)].sort(
    (left, right) =>
      getTimeZoneOffsetMinutes(left, referenceDate) - getTimeZoneOffsetMinutes(right, referenceDate) ||
      left.localeCompare(right)
  );
}
