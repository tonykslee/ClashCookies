import type { Prisma, WarMatchType } from "@prisma/client";
import { normalizeClashTagBareInput } from "../helper/clashTag";
import { prisma } from "../prisma";

export type ClanWarHistoryRow = {
  warId: number;
  syncNumber: number | null;
  matchType: WarMatchType | null;
  clanStars: number | null;
  clanDestruction: number | null;
  opponentStars: number | null;
  opponentDestruction: number | null;
  pointsAfterWar: number | null;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  clanName: string | null;
  clanTag: string;
  opponentName: string | null;
  opponentTag: string | null;
};

const CLAN_WAR_HISTORY_SELECT = {
  warId: true,
  syncNumber: true,
  matchType: true,
  clanStars: true,
  clanDestruction: true,
  opponentStars: true,
  opponentDestruction: true,
  pointsAfterWar: true,
  expectedOutcome: true,
  actualOutcome: true,
  warStartTime: true,
  warEndTime: true,
  clanName: true,
  clanTag: true,
  opponentName: true,
  opponentTag: true,
} satisfies Prisma.ClanWarHistorySelect;

function buildClanTagWhere(clanTag: string): Prisma.ClanWarHistoryWhereInput | null {
  const bareTag = normalizeClashTagBareInput(clanTag);
  if (!bareTag) return null;

  return {
    OR: [
      { clanTag: { equals: `#${bareTag}`, mode: "insensitive" } },
      { clanTag: { equals: bareTag, mode: "insensitive" } },
    ],
  };
}

export function normalizeWarHistoryLimit(input: number | null | undefined): number {
  const value = Number.isFinite(input) ? Math.trunc(input as number) : 10;
  return Math.max(1, Math.min(50, value));
}

export class ClanWarHistoryService {
  public constructor(private readonly db = prisma) {}

  public async listRecentByClan(input: {
    clanTag: string;
    limit?: number | null;
  }): Promise<ClanWarHistoryRow[]> {
    const tagWhere = buildClanTagWhere(input.clanTag);
    if (!tagWhere) return [];

    return this.db.clanWarHistory.findMany({
      where: tagWhere,
      orderBy: [{ warStartTime: "desc" }, { warId: "desc" }],
      take: normalizeWarHistoryLimit(input.limit),
      select: CLAN_WAR_HISTORY_SELECT,
    }) as Promise<ClanWarHistoryRow[]>;
  }

  public async listEndedByClanSince(input: {
    clanTag: string;
    cutoff: Date;
  }): Promise<ClanWarHistoryRow[]> {
    const tagWhere = buildClanTagWhere(input.clanTag);
    if (!tagWhere || !(input.cutoff instanceof Date) || !Number.isFinite(input.cutoff.getTime())) {
      return [];
    }

    return this.db.clanWarHistory.findMany({
      where: {
        ...tagWhere,
        warEndTime: { not: null, gte: input.cutoff },
      },
      orderBy: [
        { warEndTime: "desc" },
        { warStartTime: "desc" },
        { warId: "desc" },
      ],
      select: CLAN_WAR_HISTORY_SELECT,
    }) as Promise<ClanWarHistoryRow[]>;
  }
}
