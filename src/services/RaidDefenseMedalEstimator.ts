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

function calculateRaidDefenseHousingSpace(
  defenseLog: ClanCapitalRaidSeason["defenseLog"],
): number {
  if (!Array.isArray(defenseLog) || defenseLog.length <= 0) {
    return 0;
  }

  const firstOpponent = defenseLog[0];
  if (!firstOpponent || typeof firstOpponent !== "object") {
    return 0;
  }
  const districts = Array.isArray((firstOpponent as Record<string, unknown>).districts)
    ? ((firstOpponent as Record<string, unknown>).districts as unknown[])
    : [];

  let housingSpace = 0;
  for (const rawDistrict of districts) {
    if (!rawDistrict || typeof rawDistrict !== "object") continue;
    const district = rawDistrict as Record<string, unknown>;
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

  return housingSpace;
}

function calculateRaidDefenseDistrictWeights(
  defenseLog: ClanCapitalRaidSeason["defenseLog"],
): Map<number, number> {
  const lower = new Map<number, number>();
  const upper = new Map<number, number>();

  if (!Array.isArray(defenseLog) || defenseLog.length <= 0) {
    return new Map();
  }

  for (const opponent of defenseLog) {
    if (!opponent || typeof opponent !== "object") continue;
    const districts = Array.isArray((opponent as Record<string, unknown>).districts)
      ? ((opponent as Record<string, unknown>).districts as unknown[])
      : [];
    for (const rawDistrict of districts) {
      if (!rawDistrict || typeof rawDistrict !== "object") continue;
      const district = rawDistrict as Record<string, unknown>;
      if (getDistrictDestructionPercent(district) !== 100) {
        continue;
      }
      const districtId = getDistrictId(district);
      const totalLooted = getDistrictTotalLooted(district);
      if (districtId === null || totalLooted === null) {
        continue;
      }
      lower.set(districtId, Math.max(totalLooted - 750, lower.get(districtId) ?? 0));
      upper.set(districtId, Math.min(totalLooted, upper.get(districtId) ?? 0));
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
): number {
  if (!Array.isArray(defenseLog) || defenseLog.length <= 0) {
    return 0;
  }

  const housingSpace = calculateRaidDefenseHousingSpace(defenseLog);
  const districtWeights = calculateRaidDefenseDistrictWeights(defenseLog);
  const troopsKilled: number[] = [];

  for (const opponent of defenseLog) {
    if (!opponent || typeof opponent !== "object") continue;
    const districts = Array.isArray((opponent as Record<string, unknown>).districts)
      ? ((opponent as Record<string, unknown>).districts as unknown[])
      : [];

    troopsKilled.push(0);
    for (const rawDistrict of districts) {
      if (!rawDistrict || typeof rawDistrict !== "object") continue;
      const district = rawDistrict as Record<string, unknown>;
      const attackCount = getDistrictAttackCount(district);
      if (attackCount === null) {
        continue;
      }

      troopsKilled[troopsKilled.length - 1] += attackCount * housingSpace;

      if (getDistrictDestructionPercent(district) !== 100) {
        continue;
      }
      const districtId = getDistrictId(district);
      const totalLooted = getDistrictTotalLooted(district);
      if (districtId === null || totalLooted === null) {
        continue;
      }
      troopsKilled[troopsKilled.length - 1] -= Math.floor(
        (totalLooted - (districtWeights.get(districtId) ?? 0)) / 3,
      );
    }
  }

  if (troopsKilled.length <= 0) {
    return 0;
  }

  return Math.min(Math.floor(Math.max(...troopsKilled) / 25), 350);
}
