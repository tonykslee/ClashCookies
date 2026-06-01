import { prisma } from "../prisma";
import { normalizeRaidTrackedClanTag } from "./RaidTrackedClanService";
import type { RaidDashboardAttackSection } from "./RaidDashboardService";

export type PersistRaidDistrictHitHistoryInput = {
  guildId: string | null | undefined;
  sourceClanTag: string;
  raidSeasonStartTime: Date | null;
  attackSections: RaidDashboardAttackSection[];
  observedAt?: Date;
};

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeNullableInt(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = Math.trunc(Number(input));
  return Number.isFinite(value) ? value : null;
}

export async function persistRaidDistrictHitHistoryFromAttackSections(
  input: PersistRaidDistrictHitHistoryInput,
): Promise<{ upsertedCount: number; skippedCount: number }> {
  const guildId = String(input.guildId ?? "").trim();
  const sourceClanTag = normalizeRaidTrackedClanTag(input.sourceClanTag);
  if (!guildId || !sourceClanTag || !(input.raidSeasonStartTime instanceof Date)) {
    return { upsertedCount: 0, skippedCount: 0 };
  }

  const observedAt = input.observedAt ?? new Date();
  let upsertedCount = 0;
  let skippedCount = 0;
  const operations: Array<Promise<unknown>> = [];

  for (const section of input.attackSections) {
    const defenderTag = normalizeRaidTrackedClanTag(section.defenderTag ?? "");
    if (!defenderTag) {
      skippedCount += section.districts.reduce(
        (sum, district) => sum + (district.attacks?.length ?? 0),
        0,
      );
      continue;
    }

    for (const district of section.districts) {
      const districtName = normalizeText(district.name);
      if (!districtName) {
        skippedCount += district.attacks?.length ?? 0;
        continue;
      }

      for (const [index, attack] of (district.attacks ?? []).entries()) {
        const attackerTag = normalizeRaidTrackedClanTag(attack.attackerTag ?? "");
        if (!attackerTag) {
          skippedCount += 1;
          continue;
        }
        const attackOrder = attack.order ?? index + 1;
        const row = {
          guildId,
          sourceClanTag,
          raidSeasonStartTime: input.raidSeasonStartTime,
          defenderTag,
          defenderName: normalizeText(section.defenderName),
          districtName,
          districtHallLevel: normalizeNullableInt(district.districtHallLevel),
          attackOrder,
          attackerTag,
          attackerName: normalizeText(attack.attackerName),
          destructionPercent: normalizeNullableInt(attack.destructionPercent),
          stars: normalizeNullableInt(attack.stars),
          districtFinalAttackCount: normalizeNullableInt(district.attackCount),
          districtFinalDestructionPercent: normalizeNullableInt(district.destructionPercent),
          districtFinalStars: normalizeNullableInt(district.stars),
          observedAt,
        };
        operations.push(
          prisma.raidDistrictHitHistory.upsert({
            where: {
              guildId_sourceClanTag_raidSeasonStartTime_defenderTag_districtName_attackOrder_attackerTag: {
                guildId,
                sourceClanTag,
                raidSeasonStartTime: input.raidSeasonStartTime,
                defenderTag,
                districtName,
                attackOrder,
                attackerTag,
              },
            },
            create: row,
            update: row,
          }),
        );
        upsertedCount += 1;
      }
    }
  }

  if (operations.length > 0) {
    await Promise.all(operations);
  }

  return { upsertedCount, skippedCount };
}
