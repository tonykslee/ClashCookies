import { prisma } from "../prisma";
import { normalizeRaidTrackedClanTag } from "./RaidTrackedClanService";
import {
  buildRaidIntelDistrictKey,
  buildRaidIntelLayoutGradeLabel,
  type RaidIntelLayoutGrade,
  type RaidIntelLayoutGradeLabel,
} from "./RaidDashboardService";

export type RaidIntelDistrictLayoutMarkRecord = {
  id: number;
  guildId: string;
  sourceClanTag: string;
  raidSeasonStartTime: Date;
  defenderTag: string;
  districtName: string;
  districtHallLevel: number | null;
  layoutGrade: RaidIntelLayoutGrade;
  markedByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

function normalizeRaidIntelDistrictName(name: unknown): string | null {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRaidIntelSeasonStartTime(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeRaidIntelLayoutGrade(
  value: unknown,
): RaidIntelLayoutGrade | null {
  const raw = String(value ?? "").trim();
  if (
    raw === "DEFAULT" ||
    raw === "CUSTOM_HARD" ||
    raw === "CUSTOM_MEDIUM" ||
    raw === "CUSTOM_EASY"
  ) {
    return raw;
  }
  return null;
}

export function buildRaidIntelLayoutGradeLookup(
  rows: RaidIntelDistrictLayoutMarkRecord[],
): Map<string, RaidIntelLayoutGradeLabel> {
  const lookup = new Map<string, RaidIntelLayoutGradeLabel>();
  for (const row of rows) {
    const defenderTag = normalizeRaidTrackedClanTag(row.defenderTag);
    const districtName = normalizeRaidIntelDistrictName(row.districtName);
    if (!defenderTag || !districtName) continue;
    const grade = normalizeRaidIntelLayoutGrade(row.layoutGrade);
    if (!grade) continue;
    lookup.set(
      buildRaidIntelDistrictKey({
        defenderTag,
        districtName,
      }),
      buildRaidIntelLayoutGradeLabel(grade),
    );
  }
  return lookup;
}

export async function loadRaidIntelLayoutMarksForSeason(input: {
  guildId: string | null;
  sourceClanTag: string;
  raidSeasonStartTime: Date | null;
}): Promise<RaidIntelDistrictLayoutMarkRecord[]> {
  const guildId = String(input.guildId ?? "").trim();
  const sourceClanTag = normalizeRaidTrackedClanTag(input.sourceClanTag);
  const raidSeasonStartTime = normalizeRaidIntelSeasonStartTime(input.raidSeasonStartTime);
  if (!guildId || !sourceClanTag || !raidSeasonStartTime) {
    return [];
  }

  const rows = await prisma.raidIntelDistrictLayoutMark.findMany({
    where: {
      guildId,
      sourceClanTag,
      raidSeasonStartTime,
    },
    orderBy: [{ defenderTag: "asc" }, { districtName: "asc" }],
    select: {
      id: true,
      guildId: true,
      sourceClanTag: true,
      raidSeasonStartTime: true,
      defenderTag: true,
      districtName: true,
      districtHallLevel: true,
      layoutGrade: true,
      markedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    guildId: row.guildId,
    sourceClanTag: row.sourceClanTag,
    raidSeasonStartTime: row.raidSeasonStartTime,
    defenderTag: row.defenderTag,
    districtName: row.districtName,
    districtHallLevel: row.districtHallLevel,
    layoutGrade: row.layoutGrade as RaidIntelLayoutGrade,
    markedByDiscordUserId: row.markedByDiscordUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function loadRaidIntelLayoutGradeLookupForSeason(input: {
  guildId: string | null;
  sourceClanTag: string;
  raidSeasonStartTime: Date | null;
}): Promise<Map<string, RaidIntelLayoutGradeLabel>> {
  const rows = await loadRaidIntelLayoutMarksForSeason(input);
  return buildRaidIntelLayoutGradeLookup(rows);
}

export async function upsertRaidIntelDistrictLayoutMark(input: {
  guildId: string | null;
  sourceClanTag: string;
  raidSeasonStartTime: Date | null;
  defenderTag: string;
  districtName: string;
  districtHallLevel: number | null;
  layoutGrade: RaidIntelLayoutGrade;
  markedByDiscordUserId: string;
}): Promise<RaidIntelDistrictLayoutMarkRecord | null> {
  const guildId = String(input.guildId ?? "").trim();
  const sourceClanTag = normalizeRaidTrackedClanTag(input.sourceClanTag);
  const raidSeasonStartTime = normalizeRaidIntelSeasonStartTime(input.raidSeasonStartTime);
  const defenderTag = normalizeRaidTrackedClanTag(input.defenderTag);
  const districtName = normalizeRaidIntelDistrictName(input.districtName);
  const layoutGrade = normalizeRaidIntelLayoutGrade(input.layoutGrade);
  const markedByDiscordUserId = String(input.markedByDiscordUserId ?? "").trim();

  if (!guildId || !sourceClanTag || !raidSeasonStartTime || !defenderTag || !districtName || !layoutGrade || !markedByDiscordUserId) {
    throw new Error("Invalid raid intel layout mark input.");
  }

  const row = await prisma.raidIntelDistrictLayoutMark.upsert({
    where: {
      guildId_sourceClanTag_raidSeasonStartTime_defenderTag_districtName: {
        guildId,
        sourceClanTag,
        raidSeasonStartTime,
        defenderTag,
        districtName,
      },
    },
    create: {
      guildId,
      sourceClanTag,
      raidSeasonStartTime,
      defenderTag,
      districtName,
      districtHallLevel:
        input.districtHallLevel !== null && Number.isFinite(input.districtHallLevel)
          ? Math.trunc(input.districtHallLevel)
          : null,
      layoutGrade,
      markedByDiscordUserId,
    },
    update: {
      districtHallLevel:
        input.districtHallLevel !== null && Number.isFinite(input.districtHallLevel)
          ? Math.trunc(input.districtHallLevel)
          : null,
      layoutGrade,
      markedByDiscordUserId,
    },
    select: {
      id: true,
      guildId: true,
      sourceClanTag: true,
      raidSeasonStartTime: true,
      defenderTag: true,
      districtName: true,
      districtHallLevel: true,
      layoutGrade: true,
      markedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    id: row.id,
    guildId: row.guildId,
    sourceClanTag: row.sourceClanTag,
    raidSeasonStartTime: row.raidSeasonStartTime,
    defenderTag: row.defenderTag,
    districtName: row.districtName,
    districtHallLevel: row.districtHallLevel,
    layoutGrade: row.layoutGrade as RaidIntelLayoutGrade,
    markedByDiscordUserId: row.markedByDiscordUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
