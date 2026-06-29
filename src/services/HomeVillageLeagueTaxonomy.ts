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

type HomeVillageLeagueFamilyDefinition = {
  selector: HomeVillageLeagueFamily | "Unranked";
  tiers: readonly string[];
  legacyAliases?: readonly string[];
};

export type HomeVillageLeagueObservation = {
  source: HomeVillageLeagueSource;
  leagueTierId: number | null;
  leagueName: string | null;
  normalizedLeagueName: string | null;
  family: HomeVillageLeagueFamily | null;
};

const HOME_VILLAGE_LEAGUE_FAMILIES: readonly HomeVillageLeagueFamilyDefinition[] = [
  { selector: "Unranked", tiers: ["Unranked"] },
  { selector: "Skeleton League", tiers: ["Skeleton League 1", "Skeleton League 2", "Skeleton League 3"] },
  { selector: "Barbarian League", tiers: ["Barbarian League 4", "Barbarian League 5", "Barbarian League 6"] },
  { selector: "Archer League", tiers: ["Archer League 7", "Archer League 8", "Archer League 9"] },
  { selector: "Wizard League", tiers: ["Wizard League 10", "Wizard League 11", "Wizard League 12"] },
  { selector: "Valkyrie League", tiers: ["Valkyrie League 13", "Valkyrie League 14", "Valkyrie League 15"] },
  { selector: "Witch League", tiers: ["Witch League 16", "Witch League 17", "Witch League 18"] },
  { selector: "Golem League", tiers: ["Golem League 19", "Golem League 20", "Golem League 21"] },
  { selector: "P.E.K.K.A League", tiers: ["P.E.K.K.A League 22", "P.E.K.K.A League 23", "P.E.K.K.A League 24"] },
  { selector: "Titan League", tiers: ["Titan League 25", "Titan League 26", "Titan League 27"] },
  { selector: "Dragon League", tiers: ["Dragon League 28", "Dragon League 29", "Dragon League 30"] },
  { selector: "Electro League", tiers: ["Electro League 31", "Electro League 32", "Electro League 33"] },
  { selector: "Legend", tiers: ["Legend III", "Legend II", "Legend I"], legacyAliases: ["Legend League"] },
];

const HOME_VILLAGE_LEAGUE_EXACT_TIER_KEYS = new Map<string, HomeVillageLeagueFamily | "Unranked">();
const HOME_VILLAGE_LEAGUE_FAMILY_KEYS = new Map<string, HomeVillageLeagueFamily>();

for (const family of HOME_VILLAGE_LEAGUE_FAMILIES) {
  const familyKey = normalizeHomeVillageLeagueMatchText(family.selector);
  if (family.selector !== "Unranked") {
    HOME_VILLAGE_LEAGUE_FAMILY_KEYS.set(familyKey, family.selector);
  }

  for (const tier of family.tiers) {
    HOME_VILLAGE_LEAGUE_EXACT_TIER_KEYS.set(normalizeHomeVillageLeagueMatchText(tier), family.selector === "Unranked" ? "Unranked" : family.selector);
  }

  for (const alias of family.legacyAliases ?? []) {
    HOME_VILLAGE_LEAGUE_FAMILY_KEYS.set(
      normalizeHomeVillageLeagueMatchText(alias),
      family.selector as HomeVillageLeagueFamily,
    );
  }
}

export const HOME_VILLAGE_LEAGUE_FAMILY_LABELS = HOME_VILLAGE_LEAGUE_FAMILIES
  .filter((family) => family.selector !== "Unranked")
  .map((family) => family.selector as HomeVillageLeagueFamily);

export const HOME_VILLAGE_LEAGUE_EXACT_TIER_NAMES = HOME_VILLAGE_LEAGUE_FAMILIES.flatMap((family) => [...family.tiers]);

export const HOME_VILLAGE_LEAGUE_LEGACY_NAMES = [
  "Bronze League III",
  "Bronze League II",
  "Bronze League I",
  "Silver League III",
  "Silver League II",
  "Silver League I",
  "Gold League III",
  "Gold League II",
  "Gold League I",
  "Crystal League III",
  "Crystal League II",
  "Crystal League I",
  "Master League III",
  "Master League II",
  "Master League I",
  "Champion League III",
  "Champion League II",
  "Champion League I",
  "Titan League",
  "Legend League",
] as const;

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
  const family = normalizedLeagueName ? resolveHomeVillageLeagueFamily(normalizedLeagueName) : null;

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

  if (targetKey === leagueKey) {
    return true;
  }

  const family = resolveHomeVillageLeagueFamilySelector(targetKey);
  if (!family) {
    return false;
  }

  if (family === "Legend") {
    return LEGEND_LEAGUE_MATCH_KEYS.has(leagueKey);
  }

  const familyDefinition = HOME_VILLAGE_LEAGUE_FAMILIES.find((entry) => entry.selector === family);
  if (!familyDefinition) {
    return false;
  }

  return familyDefinition.tiers.some((tier) => normalizeHomeVillageLeagueMatchText(tier) === leagueKey);
}

function resolveHomeVillageLeagueFamily(normalizedLeagueName: string): HomeVillageLeagueFamily | null {
  if (HOME_VILLAGE_LEAGUE_EXACT_TIER_KEYS.has(normalizedLeagueName)) {
    return HOME_VILLAGE_LEAGUE_EXACT_TIER_KEYS.get(normalizedLeagueName) === "Unranked"
      ? null
      : (HOME_VILLAGE_LEAGUE_EXACT_TIER_KEYS.get(normalizedLeagueName) as HomeVillageLeagueFamily);
  }

  if (normalizedLeagueName === normalizeHomeVillageLeagueMatchText("Legend League")) {
    return "Legend";
  }

  return null;
}

function resolveHomeVillageLeagueFamilySelector(normalizedTarget: string): HomeVillageLeagueFamily | null {
  if (HOME_VILLAGE_LEAGUE_FAMILY_KEYS.has(normalizedTarget)) {
    return HOME_VILLAGE_LEAGUE_FAMILY_KEYS.get(normalizedTarget) ?? null;
  }

  return null;
}

const LEGEND_LEAGUE_MATCH_KEYS = new Set(
  [
    "Legend III",
    "Legend II",
    "Legend I",
    "Legend League",
  ].map((value) => normalizeHomeVillageLeagueMatchText(value)),
);
