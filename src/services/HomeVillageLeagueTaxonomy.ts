export type HomeVillageLeagueSource = "leagueTier" | "league" | "missing";

export type HomeVillageLeagueFamily =
  | "Skeleton League"
  | "Barbarian League"
  | "Archer League"
  | "Wizard League"
  | "Valkyrie League"
  | "Witch League"
  | "Golem League"
  | "P.E.K.K.A League"
  | "Titan League"
  | "Dragon League"
  | "Electro League"
  | "Legend";

export type HomeVillageLeagueRecord = Readonly<{
  id: number;
  name: string;
  family: HomeVillageLeagueFamily | null;
  compatibilityAliasFor?: HomeVillageLeagueFamily;
}>;

export type HomeVillageLeagueObservation = {
  source: HomeVillageLeagueSource;
  leagueTierId: number | null;
  leagueName: string | null;
  normalizedLeagueName: string | null;
  family: HomeVillageLeagueFamily | null;
};

export const HOME_VILLAGE_LEAGUE_TIER_RECORDS: readonly HomeVillageLeagueRecord[] = [
  { id: 105000000, name: "Unranked", family: null },
  { id: 105000001, name: "Skeleton League 1", family: "Skeleton League" },
  { id: 105000002, name: "Skeleton League 2", family: "Skeleton League" },
  { id: 105000003, name: "Skeleton League 3", family: "Skeleton League" },
  { id: 105000004, name: "Barbarian League 4", family: "Barbarian League" },
  { id: 105000005, name: "Barbarian League 5", family: "Barbarian League" },
  { id: 105000006, name: "Barbarian League 6", family: "Barbarian League" },
  { id: 105000007, name: "Archer League 7", family: "Archer League" },
  { id: 105000008, name: "Archer League 8", family: "Archer League" },
  { id: 105000009, name: "Archer League 9", family: "Archer League" },
  { id: 105000010, name: "Wizard League 10", family: "Wizard League" },
  { id: 105000011, name: "Wizard League 11", family: "Wizard League" },
  { id: 105000012, name: "Wizard League 12", family: "Wizard League" },
  { id: 105000013, name: "Valkyrie League 13", family: "Valkyrie League" },
  { id: 105000014, name: "Valkyrie League 14", family: "Valkyrie League" },
  { id: 105000015, name: "Valkyrie League 15", family: "Valkyrie League" },
  { id: 105000016, name: "Witch League 16", family: "Witch League" },
  { id: 105000017, name: "Witch League 17", family: "Witch League" },
  { id: 105000018, name: "Witch League 18", family: "Witch League" },
  { id: 105000019, name: "Golem League 19", family: "Golem League" },
  { id: 105000020, name: "Golem League 20", family: "Golem League" },
  { id: 105000021, name: "Golem League 21", family: "Golem League" },
  { id: 105000022, name: "P.E.K.K.A League 22", family: "P.E.K.K.A League" },
  { id: 105000023, name: "P.E.K.K.A League 23", family: "P.E.K.K.A League" },
  { id: 105000024, name: "P.E.K.K.A League 24", family: "P.E.K.K.A League" },
  { id: 105000025, name: "Titan League 25", family: "Titan League" },
  { id: 105000026, name: "Titan League 26", family: "Titan League" },
  { id: 105000027, name: "Titan League 27", family: "Titan League" },
  { id: 105000028, name: "Dragon League 28", family: "Dragon League" },
  { id: 105000029, name: "Dragon League 29", family: "Dragon League" },
  { id: 105000030, name: "Dragon League 30", family: "Dragon League" },
  { id: 105000031, name: "Electro League 31", family: "Electro League" },
  { id: 105000032, name: "Electro League 32", family: "Electro League" },
  { id: 105000033, name: "Electro League 33", family: "Electro League" },
  { id: 105000034, name: "Legend III", family: "Legend" },
  { id: 105000035, name: "Legend II", family: "Legend" },
  { id: 105000036, name: "Legend I", family: "Legend" },
] as const;

export const HOME_VILLAGE_LEAGUE_LEGACY_RECORDS: readonly HomeVillageLeagueRecord[] = [
  { id: 29000000, name: "Unranked", family: null },
  { id: 29000001, name: "Bronze League III", family: null },
  { id: 29000002, name: "Bronze League II", family: null },
  { id: 29000003, name: "Bronze League I", family: null },
  { id: 29000004, name: "Silver League III", family: null },
  { id: 29000005, name: "Silver League II", family: null },
  { id: 29000006, name: "Silver League I", family: null },
  { id: 29000007, name: "Gold League III", family: null },
  { id: 29000008, name: "Gold League II", family: null },
  { id: 29000009, name: "Gold League I", family: null },
  { id: 29000010, name: "Crystal League III", family: null },
  { id: 29000011, name: "Crystal League II", family: null },
  { id: 29000012, name: "Crystal League I", family: null },
  { id: 29000013, name: "Master League III", family: null },
  { id: 29000014, name: "Master League II", family: null },
  { id: 29000015, name: "Master League I", family: null },
  { id: 29000016, name: "Champion League III", family: null },
  { id: 29000017, name: "Champion League II", family: null },
  { id: 29000018, name: "Champion League I", family: null },
  { id: 29000019, name: "Titan League III", family: null },
  { id: 29000020, name: "Titan League II", family: null },
  { id: 29000021, name: "Titan League I", family: null },
  { id: 29000022, name: "Legend League", family: "Legend", compatibilityAliasFor: "Legend" },
] as const;

const HOME_VILLAGE_LEAGUE_ALL_RECORDS = [...HOME_VILLAGE_LEAGUE_TIER_RECORDS, ...HOME_VILLAGE_LEAGUE_LEGACY_RECORDS];

const HOME_VILLAGE_LEAGUE_EXACT_NAME_TO_RECORD = new Map<string, HomeVillageLeagueRecord>();
const HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES = new Map<HomeVillageLeagueFamily, readonly string[]>();
const HOME_VILLAGE_LEAGUE_SELECTOR_TARGETS = new Map<string, HomeVillageLeagueFamily>();
const HOME_VILLAGE_LEAGUE_COMPATIBILITY_ALIAS_TARGETS = new Map<string, HomeVillageLeagueFamily>();

for (const record of HOME_VILLAGE_LEAGUE_ALL_RECORDS) {
  HOME_VILLAGE_LEAGUE_EXACT_NAME_TO_RECORD.set(normalizeHomeVillageLeagueMatchText(record.name), record);
}

for (const family of HOME_VILLAGE_LEAGUE_TIER_RECORDS) {
  if (!family.family) {
    continue;
  }

  const familyName = family.family;
  const existingNames = HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES.get(familyName);
  const nextNames = existingNames ? [...existingNames, family.name] : [family.name];
  HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES.set(familyName, Object.freeze(nextNames));
  HOME_VILLAGE_LEAGUE_SELECTOR_TARGETS.set(normalizeHomeVillageLeagueMatchText(familyName), familyName);
}

for (const record of HOME_VILLAGE_LEAGUE_LEGACY_RECORDS) {
  if (record.compatibilityAliasFor) {
    HOME_VILLAGE_LEAGUE_COMPATIBILITY_ALIAS_TARGETS.set(
      normalizeHomeVillageLeagueMatchText(record.name),
      record.compatibilityAliasFor,
    );
  }
}

export const HOME_VILLAGE_LEAGUE_FAMILY_LABELS = [...HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES.keys()];

export const HOME_VILLAGE_LEAGUE_EXACT_TIER_NAMES = HOME_VILLAGE_LEAGUE_TIER_RECORDS.map((record) => record.name);

export const HOME_VILLAGE_LEAGUE_LEGACY_NAMES = HOME_VILLAGE_LEAGUE_LEGACY_RECORDS.map((record) => record.name);

/** Purpose: collapse repeated whitespace and trim league text while preserving display casing. */
export function normalizeHomeVillageLeagueText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

/** Purpose: convert league text into a case-insensitive comparison key. */
export function normalizeHomeVillageLeagueMatchText(input: unknown): string {
  return normalizeHomeVillageLeagueText(input).toLowerCase();
}

/** Purpose: resolve one home-village league payload into its canonical family and source metadata. */
export function resolveHomeVillageLeagueObservation(input: {
  leagueTier?: { id?: number | null; name?: string | null } | null;
  league?: { name?: string | null } | null;
}): HomeVillageLeagueObservation {
  const leagueTierName = normalizeHomeVillageLeagueText(input.leagueTier?.name ?? null);
  const legacyLeagueName = normalizeHomeVillageLeagueText(input.league?.name ?? null);
  const resolvedLeagueName = leagueTierName || legacyLeagueName || null;
  const source: HomeVillageLeagueSource = leagueTierName
    ? "leagueTier"
    : legacyLeagueName
      ? "league"
      : "missing";
  const normalizedLeagueName = resolvedLeagueName ? normalizeHomeVillageLeagueMatchText(resolvedLeagueName) : null;
  const family = normalizedLeagueName ? resolveObservedLeagueFamily(normalizedLeagueName) : null;

  return {
    source,
    leagueTierId: input.leagueTier?.id ?? null,
    leagueName: resolvedLeagueName,
    normalizedLeagueName,
    family,
  };
}

/** Purpose: determine whether one target value should match one observed league name. */
export function matchesHomeVillageLeagueTarget(targetValue: unknown, leagueName: unknown): boolean {
  const targetKey = normalizeHomeVillageLeagueMatchText(targetValue);
  const leagueKey = normalizeHomeVillageLeagueMatchText(leagueName);
  if (!targetKey || !leagueKey) {
    return false;
  }

  const familySelector = HOME_VILLAGE_LEAGUE_SELECTOR_TARGETS.get(targetKey);
  if (familySelector) {
    return (HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES.get(familySelector) ?? []).some(
      (name) => normalizeHomeVillageLeagueMatchText(name) === leagueKey,
    );
  }

  const compatibilityAlias = HOME_VILLAGE_LEAGUE_COMPATIBILITY_ALIAS_TARGETS.get(targetKey);
  if (compatibilityAlias) {
    const observedNames = [
      ...(HOME_VILLAGE_LEAGUE_FAMILY_SELECTOR_TO_NAMES.get(compatibilityAlias) ?? []),
      ...HOME_VILLAGE_LEAGUE_LEGACY_RECORDS.filter(
        (record) => record.compatibilityAliasFor === compatibilityAlias,
      ).map((record) => record.name),
    ];
    return observedNames.some((name) => normalizeHomeVillageLeagueMatchText(name) === leagueKey);
  }

  return targetKey === leagueKey;
}

function resolveObservedLeagueFamily(normalizedLeagueName: string): HomeVillageLeagueFamily | null {
  return HOME_VILLAGE_LEAGUE_EXACT_NAME_TO_RECORD.get(normalizedLeagueName)?.family ?? null;
}
