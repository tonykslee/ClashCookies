import type { ClanCapitalRaidSeason } from "./CoCService";

function normalizePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getDistrictId(district: Record<string, unknown>): number | null {
  return normalizePositiveInteger(district.id);
}

function getDistrictHallLevel(district: Record<string, unknown>): number | null {
  return normalizePositiveInteger(
    district.districtHallLevel ?? district.districtHall ?? district.hall_level ?? district.hallLevel,
  );
}

function getDistrictAttackCount(district: Record<string, unknown>): number | null {
  return normalizeNonNegativeInteger(district.attackCount ?? district.attacks ?? district.attack_count);
}

function getDistrictDestructionPercent(district: Record<string, unknown>): number | null {
  return normalizeNonNegativeInteger(
    district.destructionPercent ?? district.destructionPercentage ?? district.destruction,
  );
}

function getDistrictTotalLooted(district: Record<string, unknown>): number | null {
  return normalizeNonNegativeInteger(district.totalLooted ?? district.looted);
}

type RaidDefenseOpponent = {
  districts: Record<string, unknown>[];
};

function normalizeUsableDefenseOpponent(opponent: unknown): RaidDefenseOpponent | null {
  if (!opponent || typeof opponent !== "object") {
    return null;
  }
  const rawDistricts = (opponent as Record<string, unknown>).districts;
  if (!Array.isArray(rawDistricts) || rawDistricts.length <= 0) {
    return null;
  }

  const districts: Record<string, unknown>[] = [];
  for (const rawDistrict of rawDistricts) {
    if (!rawDistrict || typeof rawDistrict !== "object") {
      return null;
    }
    const district = rawDistrict as Record<string, unknown>;
    if (
      getDistrictId(district) === null ||
      getDistrictHallLevel(district) === null ||
      getDistrictAttackCount(district) === null ||
      getDistrictDestructionPercent(district) === null
    ) {
      return null;
    }
    if (
      getDistrictDestructionPercent(district) === 100 &&
      (getDistrictTotalLooted(district) === null || getDistrictId(district) === null)
    ) {
      return null;
    }
    districts.push(district);
  }

  return { districts };
}

function calculateRaidDefenseHousingSpace(
  opponents: RaidDefenseOpponent[],
): number | null {
  for (const opponent of opponents) {
    let housingSpace = 0;
    const districts = opponent.districts;

    for (const district of districts) {
      const districtId = getDistrictId(district);
      const hallLevel = getDistrictHallLevel(district);
      if (districtId === 70000001 && hallLevel !== null) {
        housingSpace += 3 * (25 + 5 * hallLevel);
      } else if (districtId === 70000002 && hallLevel !== null && hallLevel > 1) {
        housingSpace += 25 + 5 * hallLevel;
      } else if (districtId === 70000005 && hallLevel !== null) {
        housingSpace += 25 + 5 * hallLevel;
      }
    }
    if (housingSpace > 0) {
      return housingSpace;
    }
  }

  return null;
}

function calculateRaidDefenseDistrictWeights(
  opponents: RaidDefenseOpponent[],
): Map<number, number> {
  const lower = new Map<number, number>();
  const upper = new Map<number, number>();

  for (const opponent of opponents) {
    for (const district of opponent.districts) {
      if (getDistrictDestructionPercent(district) !== 100) {
        continue;
      }
      const districtId = getDistrictId(district);
      const totalLooted = getDistrictTotalLooted(district);
      if (districtId === null || totalLooted === null) {
        continue;
      }
      const existingLower = lower.get(districtId);
      const existingUpper = upper.get(districtId);
      lower.set(districtId, Math.max(totalLooted - 750, existingLower ?? 0));
      upper.set(
        districtId,
        existingUpper === undefined ? totalLooted : Math.min(existingUpper, totalLooted),
      );
    }
  }

  const districtWeights = new Map<number, number>();
  for (const [districtId, lowerValue] of lower) {
    const upperValue = upper.get(districtId) ?? 0;
    districtWeights.set(districtId, Math.floor((lowerValue + upperValue) / 2));
  }
  return districtWeights;
}

export function predictRaidDefenseMedalsFromDefenseLog(
  defenseLog: ClanCapitalRaidSeason["defenseLog"],
): number | null {
  if (!Array.isArray(defenseLog) || defenseLog.length <= 0) {
    return null;
  }

  const opponents = defenseLog
    .map((opponent) => normalizeUsableDefenseOpponent(opponent))
    .filter((opponent): opponent is RaidDefenseOpponent => opponent !== null);
  if (opponents.length <= 0) {
    return null;
  }

  const housingSpace = calculateRaidDefenseHousingSpace(opponents);
  if (housingSpace === null) {
    return null;
  }
  const districtWeights = calculateRaidDefenseDistrictWeights(opponents);
  const troopsKilled: number[] = [];

  for (const opponent of opponents) {
    let opponentTroopsKilled = 0;
    for (const district of opponent.districts) {
      const attackCount = getDistrictAttackCount(district)!;

      opponentTroopsKilled += attackCount * housingSpace;

      if (getDistrictDestructionPercent(district) !== 100) {
        continue;
      }
      const districtId = getDistrictId(district);
      const totalLooted = getDistrictTotalLooted(district);
      if (districtId === null || totalLooted === null) {
        continue;
      }
      opponentTroopsKilled -= Math.floor(
        (totalLooted! - districtWeights.get(districtId)!) / 3,
      );
    }
    troopsKilled.push(opponentTroopsKilled);
  }

  if (troopsKilled.length <= 0) {
    return null;
  }

  return Math.min(Math.floor(Math.max(...troopsKilled) / 25), 350);
}
