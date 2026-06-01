import { prisma } from "../prisma";
import { normalizeRaidTrackedClanTag } from "./RaidTrackedClanService";

const RAID_HIT_STATS_WINDOW_DAYS = 30;
const RAID_HIT_STATS_WINDOW_MS = RAID_HIT_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type RaidHitStats = {
  attackerTag: string;
  totalHits: number;
  oneShots: number;
  twoShots: number;
  threeShots: number;
  averageDestructionPercent: number | null;
  perfectHits: number;
  lastHitAt: Date | null;
};

export type BuildRaidHitStatsInput = {
  guildId?: string | null;
  now?: Date;
};

type RaidDistrictHitHistoryRow = {
  sourceClanTag: string;
  attackerTag: string;
  destructionPercent: number | null;
  districtFinalAttackCount: number | null;
  districtFinalDestructionPercent: number | null;
  districtFinalStars: number | null;
  observedAt: Date;
};

function normalizeGuildId(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStatsDate(input: Date | null | undefined): Date {
  return input instanceof Date && Number.isFinite(input.getTime()) ? input : new Date();
}

function isCompletedRaidDistrict(row: RaidDistrictHitHistoryRow): boolean {
  return (row.districtFinalDestructionPercent ?? 0) >= 100 || (row.districtFinalStars ?? 0) >= 3;
}

function createEmptyRaidHitStats(attackerTag: string): RaidHitStats & {
  destructionPercentSum: number;
  destructionPercentCount: number;
} {
  return {
    attackerTag,
    totalHits: 0,
    oneShots: 0,
    twoShots: 0,
    threeShots: 0,
    averageDestructionPercent: null,
    perfectHits: 0,
    lastHitAt: null,
    destructionPercentSum: 0,
    destructionPercentCount: 0,
  };
}

function buildTrackedRaidClanSourceTagFilter(tags: string[]): string[] {
  const normalizedTags = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeRaidTrackedClanTag(tag);
    if (!normalized) continue;
    normalizedTags.add(normalized);
    normalizedTags.add(`#${normalized}`);
  }
  return [...normalizedTags];
}

export async function buildRaidHitStatsByAttackerTag(
  input: BuildRaidHitStatsInput = {},
): Promise<Map<string, RaidHitStats>> {
  const now = normalizeStatsDate(input.now);
  const cutoff = new Date(now.getTime() - RAID_HIT_STATS_WINDOW_MS);
  const guildId = normalizeGuildId(input.guildId);

  const trackedClanRows = await prisma.raidTrackedClan.findMany({
    select: { clanTag: true },
  });
  const trackedSourceTags = buildTrackedRaidClanSourceTagFilter(
    trackedClanRows.map((row) => row.clanTag),
  );

  if (trackedSourceTags.length <= 0) {
    return new Map();
  }

  const hitRows = await prisma.raidDistrictHitHistory.findMany({
    where: {
      ...(guildId ? { guildId } : {}),
      sourceClanTag: { in: trackedSourceTags },
      observedAt: { gte: cutoff },
    },
    select: {
      sourceClanTag: true,
      attackerTag: true,
      destructionPercent: true,
      districtFinalAttackCount: true,
      districtFinalDestructionPercent: true,
      districtFinalStars: true,
      observedAt: true,
    },
  });

  const statsByAttackerTag = new Map<
    string,
    RaidHitStats & { destructionPercentSum: number; destructionPercentCount: number }
  >();

  for (const row of hitRows as RaidDistrictHitHistoryRow[]) {
    const sourceClanTag = normalizeRaidTrackedClanTag(row.sourceClanTag);
    if (!sourceClanTag || !trackedSourceTags.includes(sourceClanTag)) continue;

    const attackerTag = normalizeRaidTrackedClanTag(row.attackerTag);
    if (!attackerTag) continue;

    const stats = statsByAttackerTag.get(attackerTag) ?? createEmptyRaidHitStats(attackerTag);
    stats.totalHits += 1;
    if (row.observedAt instanceof Date && Number.isFinite(row.observedAt.getTime())) {
      if (!stats.lastHitAt || row.observedAt.getTime() > stats.lastHitAt.getTime()) {
        stats.lastHitAt = row.observedAt;
      }
    }

    if (row.destructionPercent !== null && row.destructionPercent !== undefined) {
      const destructionPercent = Math.max(0, Math.min(100, Math.trunc(row.destructionPercent)));
      stats.destructionPercentSum += destructionPercent;
      stats.destructionPercentCount += 1;
      if (destructionPercent >= 100) {
        stats.perfectHits += 1;
      }
    }

    if (isCompletedRaidDistrict(row)) {
      const finalAttackCount = row.districtFinalAttackCount ?? null;
      if (finalAttackCount === 1 && (row.destructionPercent ?? 0) >= 100) {
        stats.oneShots += 1;
      } else if (finalAttackCount === 2) {
        stats.twoShots += 1;
      } else if (finalAttackCount === 3) {
        stats.threeShots += 1;
      }
    }

    statsByAttackerTag.set(attackerTag, stats);
  }

  const result = new Map<string, RaidHitStats>();
  for (const [attackerTag, stats] of statsByAttackerTag.entries()) {
    result.set(attackerTag, {
      attackerTag,
      totalHits: stats.totalHits,
      oneShots: stats.oneShots,
      twoShots: stats.twoShots,
      threeShots: stats.threeShots,
      averageDestructionPercent:
        stats.destructionPercentCount > 0
          ? stats.destructionPercentSum / stats.destructionPercentCount
          : null,
      perfectHits: stats.perfectHits,
      lastHitAt: stats.lastHitAt,
    });
  }

  return result;
}
