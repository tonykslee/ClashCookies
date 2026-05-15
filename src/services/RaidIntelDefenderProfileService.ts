import { prisma } from "../prisma";
import { normalizeRaidTrackedClanTag } from "./RaidTrackedClanService";

export type RaidIntelDefenderProfileRow = {
  guildId: string;
  defenderTag: string;
  upgrades: number;
  createdAt: Date;
  updatedAt: Date;
};

function normalizeRaidIntelDefenderProfileUpgrades(value: unknown): number | null {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.trunc(raw) : null;
}

export async function loadRaidIntelDefenderProfileUpgradesForTags(input: {
  guildId: string | null;
  defenderTags: string[];
}): Promise<Map<string, number>> {
  const guildId = String(input.guildId ?? "").trim();
  if (!guildId || !Array.isArray(input.defenderTags) || input.defenderTags.length <= 0) {
    return new Map();
  }

  const normalizedTags = [
    ...new Set(
      input.defenderTags
        .map((tag) => normalizeRaidTrackedClanTag(tag))
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  if (normalizedTags.length <= 0) {
    return new Map();
  }

  const rows = await prisma.raidIntelDefenderProfile.findMany({
    where: {
      guildId,
      defenderTag: { in: normalizedTags },
    },
    select: {
      defenderTag: true,
      upgrades: true,
    },
  });

  const upgradesByTag = new Map<string, number>();
  for (const row of rows) {
    const defenderTag = normalizeRaidTrackedClanTag(row.defenderTag);
    const upgrades = normalizeRaidIntelDefenderProfileUpgrades(row.upgrades);
    if (!defenderTag || upgrades === null) continue;
    upgradesByTag.set(defenderTag, upgrades);
  }

  return upgradesByTag;
}

export async function upsertRaidIntelDefenderProfileUpgrades(input: {
  guildId: string | null;
  defenderTag: string;
  upgrades: number;
}): Promise<RaidIntelDefenderProfileRow | null> {
  const guildId = String(input.guildId ?? "").trim();
  const defenderTag = normalizeRaidTrackedClanTag(input.defenderTag);
  const upgrades = normalizeRaidIntelDefenderProfileUpgrades(input.upgrades);
  if (!guildId || !defenderTag || upgrades === null) {
    return null;
  }

  const row = await prisma.raidIntelDefenderProfile.upsert({
    where: {
      guildId_defenderTag: {
        guildId,
        defenderTag,
      },
    },
    create: {
      guildId,
      defenderTag,
      upgrades,
    },
    update: {
      upgrades,
    },
    select: {
      guildId: true,
      defenderTag: true,
      upgrades: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    guildId: row.guildId,
    defenderTag: normalizeRaidTrackedClanTag(row.defenderTag) ?? row.defenderTag,
    upgrades: Math.trunc(row.upgrades),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
