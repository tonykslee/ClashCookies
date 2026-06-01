export const RAID_DISTRICT_HALL_OFFENSIVE_MEDAL_VALUES = {
  1: 135,
  2: 225,
  3: 350,
  4: 405,
  5: 460,
} as const;

export const RAID_CAPITAL_HALL_OFFENSIVE_MEDAL_VALUES = {
  2: 180,
  3: 360,
  4: 585,
  5: 810,
  6: 1115,
  7: 1240,
  8: 1260,
  9: 1375,
  10: 1450,
} as const;

export type RaidMedalEstimatorInput = {
  destroyedDistrictHallLevels: number[];
  destroyedCapitalHallLevels: number[];
  totalClanOffensiveAttacksUsed: number;
  defensiveMedals?: number | null;
};

export type RaidMedalEstimate = {
  offensiveBaseValue: number;
  offensiveMedalsPerAttack: number | null;
  offensiveMedalsForSixAttacks: number | null;
  defensiveMedals: number | null;
  totalEstimatedMedals: number | null;
  confidence: "complete" | "partial" | "insufficient_offense";
  sourceNotes: string[];
};

function normalizePositiveInteger(input: number): number | null {
  const value = Math.trunc(Number(input));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeNonNegativeInteger(input: number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const value = Math.trunc(Number(input));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getRaidDistrictHallOffensiveMedalValue(level: number): number | null {
  const normalized = normalizePositiveInteger(level);
  if (normalized === null) return null;
  return RAID_DISTRICT_HALL_OFFENSIVE_MEDAL_VALUES[
    normalized as keyof typeof RAID_DISTRICT_HALL_OFFENSIVE_MEDAL_VALUES
  ] ?? null;
}

export function getRaidCapitalHallOffensiveMedalValue(level: number): number | null {
  const normalized = normalizePositiveInteger(level);
  if (normalized === null) return null;
  return RAID_CAPITAL_HALL_OFFENSIVE_MEDAL_VALUES[
    normalized as keyof typeof RAID_CAPITAL_HALL_OFFENSIVE_MEDAL_VALUES
  ] ?? null;
}

function sumKnownValues(
  levels: number[],
  resolveValue: (level: number) => number | null,
): {
  total: number;
  unknownLevels: number[];
} {
  let total = 0;
  const unknownLevels: number[] = [];
  for (const level of levels) {
    const normalized = normalizePositiveInteger(level);
    const value = normalized === null ? null : resolveValue(normalized);
    if (value === null) {
      if (normalized !== null) unknownLevels.push(normalized);
      continue;
    }
    total += value;
  }
  return { total, unknownLevels };
}

export function estimateRaidMedals(input: RaidMedalEstimatorInput): RaidMedalEstimate {
  const districtValues = sumKnownValues(
    input.destroyedDistrictHallLevels,
    getRaidDistrictHallOffensiveMedalValue,
  );
  const capitalValues = sumKnownValues(
    input.destroyedCapitalHallLevels,
    getRaidCapitalHallOffensiveMedalValue,
  );
  const offensiveBaseValue = districtValues.total + capitalValues.total;
  const attacksUsed = normalizePositiveInteger(input.totalClanOffensiveAttacksUsed);
  const defensiveMedals = normalizeNonNegativeInteger(input.defensiveMedals);
  const sourceNotes: string[] = [
    "offensive_base_value=sum_destroyed_district_hall_values+destroyed_capital_peak_values",
    "offensive_medals_per_attack=ceil(offensive_base_value/total_clan_offensive_attacks_used)",
    defensiveMedals === null
      ? "defensive_medals=unknown_not_guessed"
      : "defensive_medals=provided_source_value",
  ];

  if (districtValues.unknownLevels.length > 0) {
    sourceNotes.push(`unknown_district_hall_levels=${districtValues.unknownLevels.join(",")}`);
  }
  if (capitalValues.unknownLevels.length > 0) {
    sourceNotes.push(`unknown_capital_hall_levels=${capitalValues.unknownLevels.join(",")}`);
  }

  if (attacksUsed === null) {
    sourceNotes.push("offensive_medals_unavailable=no_positive_attack_count");
    return {
      offensiveBaseValue,
      offensiveMedalsPerAttack: null,
      offensiveMedalsForSixAttacks: null,
      defensiveMedals,
      totalEstimatedMedals: null,
      confidence: "insufficient_offense",
      sourceNotes,
    };
  }

  const offensiveMedalsPerAttack = Math.ceil(offensiveBaseValue / attacksUsed);
  const offensiveMedalsForSixAttacks = offensiveMedalsPerAttack * 6;
  const totalEstimatedMedals =
    defensiveMedals === null
      ? null
      : offensiveMedalsForSixAttacks + defensiveMedals;

  return {
    offensiveBaseValue,
    offensiveMedalsPerAttack,
    offensiveMedalsForSixAttacks,
    defensiveMedals,
    totalEstimatedMedals,
    confidence: defensiveMedals === null ? "partial" : "complete",
    sourceNotes,
  };
}
