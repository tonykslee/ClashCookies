import { prisma } from "../prisma";

type UpsertPointsSyncInput = {
  guildId: string;
  clanTag: string;
  warId?: string | null;
  warStartTime: Date;
  syncNum: number;
  opponentTag: string;
  clanPoints: number;
  opponentPoints: number;
  outcome?: string | null;
  isFwa: boolean;
};

type FindPointsSyncInput = {
  guildId: string;
  clanTag: string;
  warId?: string | null;
  warStartTime?: Date | null;
};

function normalizeTag(input: string): string {
  return `#${input.trim().toUpperCase().replace(/^#/, "")}`;
}

export class PointsSyncService {
  async upsertPointsSync(input: UpsertPointsSyncInput) {
    const clanTag = normalizeTag(input.clanTag);
    const opponentTag = normalizeTag(input.opponentTag);
    return prisma.clanPointsSync.upsert({
      where: {
        guildId_clanTag_warStartTime: {
          guildId: input.guildId,
          clanTag,
          warStartTime: input.warStartTime,
        },
      },
      update: {
        warId: input.warId ?? null,
        syncNum: Math.trunc(input.syncNum),
        opponentTag,
        clanPoints: Math.trunc(input.clanPoints),
        opponentPoints: Math.trunc(input.opponentPoints),
        outcome: input.outcome ?? null,
        isFwa: input.isFwa,
        syncedAt: new Date(),
      },
      create: {
        guildId: input.guildId,
        clanTag,
        warId: input.warId ?? null,
        warStartTime: input.warStartTime,
        syncNum: Math.trunc(input.syncNum),
        opponentTag,
        clanPoints: Math.trunc(input.clanPoints),
        opponentPoints: Math.trunc(input.opponentPoints),
        outcome: input.outcome ?? null,
        isFwa: input.isFwa,
      },
    });
  }

  async findSyncRecord(input: FindPointsSyncInput) {
    const clanTag = normalizeTag(input.clanTag);
    if (input.warId) {
      const byWarId = await prisma.clanPointsSync.findFirst({
        where: {
          guildId: input.guildId,
          clanTag,
          warId: String(input.warId),
        },
        orderBy: [{ syncedAt: "desc" }, { updatedAt: "desc" }],
      });
      if (byWarId) return byWarId;
    }
    if (!input.warStartTime) return null;
    return prisma.clanPointsSync.findUnique({
      where: {
        guildId_clanTag_warStartTime: {
          guildId: input.guildId,
          clanTag,
          warStartTime: input.warStartTime,
        },
      },
    });
  }

  async findLatestSyncNum(input?: {
    guildId?: string | null;
    clanTag?: string | null;
  }): Promise<number | null> {
    const row = await prisma.clanPointsSync.findFirst({
      where: {
        ...(input?.guildId ? { guildId: input.guildId } : {}),
        ...(input?.clanTag ? { clanTag: normalizeTag(input.clanTag) } : {}),
      },
      orderBy: [{ warStartTime: "desc" }, { syncedAt: "desc" }],
      select: { syncNum: true },
    });
    const syncNum = Number(row?.syncNum ?? NaN);
    return Number.isFinite(syncNum) ? Math.trunc(syncNum) : null;
  }

  async attachWarId(params: {
    clanTag: string;
    warStartTime: Date;
    warId: string;
    guildId?: string | null;
  }) {
    return prisma.clanPointsSync.updateMany({
      where: {
        clanTag: normalizeTag(params.clanTag),
        warStartTime: params.warStartTime,
        warId: null,
        ...(params.guildId ? { guildId: params.guildId } : {}),
      },
      data: {
        warId: String(params.warId),
        syncedAt: new Date(),
      },
    });
  }
}
