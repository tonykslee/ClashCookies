import { prisma } from "../prisma";
import type { PointsApiFetchReason } from "./PointsFetchTypes";

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
  fetchedAt?: Date | null;
  fetchReason?: PointsApiFetchReason | null;
  matchType?: string | null;
  needsValidation?: boolean;
  confirmedByClanMail?: boolean;
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

/** Purpose: convert nullable timestamps to valid Date values or null. */
function normalizeDate(input: Date | null | undefined): Date | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input : null;
}

/** Purpose: normalize optional numeric values for lifecycle checkpoints. */
function normalizeOptionalInt(input: number | null | undefined): number | null {
  return input !== null && input !== undefined && Number.isFinite(input)
    ? Math.trunc(input)
    : null;
}

export class PointsSyncService {
  /** Purpose: upsert current-war points sync state and lifecycle metadata. */
  async upsertPointsSync(input: UpsertPointsSyncInput) {
    const clanTag = normalizeTag(input.clanTag);
    const opponentTag = normalizeTag(input.opponentTag);
    const fetchedAt = normalizeDate(input.fetchedAt) ?? new Date();
    const matchType = (input.matchType ?? "").trim().toUpperCase() || null;
    const data = {
      warId: input.warId ?? null,
      syncNum: Math.trunc(input.syncNum),
      opponentTag,
      clanPoints: Math.trunc(input.clanPoints),
      opponentPoints: Math.trunc(input.opponentPoints),
      outcome: input.outcome ?? null,
      isFwa: input.isFwa,
      syncFetchedAt: fetchedAt,
      lastSuccessfulPointsApiFetchAt: fetchedAt,
      lastFetchReason: input.fetchReason ?? null,
      lastKnownPoints: Math.trunc(input.clanPoints),
      lastKnownMatchType: matchType,
      lastKnownOutcome: input.outcome ?? null,
      lastKnownSyncNumber: Math.trunc(input.syncNum),
      needsValidation: input.needsValidation ?? false,
      ...(input.confirmedByClanMail !== undefined
        ? { confirmedByClanMail: Boolean(input.confirmedByClanMail) }
        : {}),
    };
    return prisma.clanPointsSync.upsert({
      where: {
        guildId_clanTag_warStartTime: {
          guildId: input.guildId,
          clanTag,
          warStartTime: input.warStartTime,
        },
      },
      update: data,
      create: {
        guildId: input.guildId,
        clanTag,
        ...data,
        warStartTime: input.warStartTime,
        confirmedByClanMail: Boolean(input.confirmedByClanMail ?? false),
      },
    });
  }

  /** Purpose: read best-matching ClanPointsSync row for current war context. */
  async getCurrentSyncForClan(input: FindPointsSyncInput) {
    const clanTag = normalizeTag(input.clanTag);
    const requestedWarId =
      input.warId !== null && input.warId !== undefined && String(input.warId).trim().length > 0
        ? String(input.warId)
        : null;
    const requestedWarStartTime = normalizeDate(input.warStartTime);
    if (input.warId) {
      const byWarId = await prisma.clanPointsSync.findFirst({
        where: {
          guildId: input.guildId,
          clanTag,
          warId: String(input.warId),
        },
        orderBy: [
          { syncFetchedAt: "desc" },
          { lastSuccessfulPointsApiFetchAt: "desc" },
          { updatedAt: "desc" },
        ],
      });
      if (byWarId) return byWarId;
    }
    if (input.warStartTime) {
      const byWarStartTime = await prisma.clanPointsSync.findUnique({
        where: {
          guildId_clanTag_warStartTime: {
            guildId: input.guildId,
            clanTag,
            warStartTime: input.warStartTime,
          },
        },
      });
      if (byWarStartTime) return byWarStartTime;
    }
    if (requestedWarId || requestedWarStartTime) {
      return null;
    }
    return prisma.clanPointsSync.findFirst({
      where: {
        guildId: input.guildId,
        clanTag,
      },
      orderBy: [
        { warStartTime: "desc" },
        { syncFetchedAt: "desc" },
        { lastSuccessfulPointsApiFetchAt: "desc" },
        { updatedAt: "desc" },
      ],
    });
  }

  /** Purpose: compatibility helper for older callers of sync lookup. */
  async findSyncRecord(input: FindPointsSyncInput) {
    return this.getCurrentSyncForClan(input);
  }

  /** Purpose: read the latest ClanPointsSync row when no war-scoped identity is required. */
  async getLatestSyncForClan(input: { guildId: string; clanTag: string }) {
    const clanTag = normalizeTag(input.clanTag);
    return prisma.clanPointsSync.findFirst({
      where: {
        guildId: input.guildId,
        clanTag,
      },
      orderBy: [
        { warStartTime: "desc" },
        { syncFetchedAt: "desc" },
        { lastSuccessfulPointsApiFetchAt: "desc" },
        { updatedAt: "desc" },
      ],
    });
  }

  /** Purpose: find latest observed sync number from points-sync records. */
  async findLatestSyncNum(input?: {
    guildId?: string | null;
    clanTag?: string | null;
  }): Promise<number | null> {
    const row = await prisma.clanPointsSync.findFirst({
      where: {
        ...(input?.guildId ? { guildId: input.guildId } : {}),
        ...(input?.clanTag ? { clanTag: normalizeTag(input.clanTag) } : {}),
      },
      orderBy: [
        { warStartTime: "desc" },
        { syncFetchedAt: "desc" },
        { lastSuccessfulPointsApiFetchAt: "desc" },
      ],
      select: { syncNum: true },
    });
    const syncNum = Number(row?.syncNum ?? NaN);
    return Number.isFinite(syncNum) ? Math.trunc(syncNum) : null;
  }

  /** Purpose: attach resolved war IDs without mutating API-fetch timestamps. */
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
      },
    });
  }

  /** Purpose: mark lifecycle as needing a revalidation fetch for a targeted war row. */
  async markNeedsValidation(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
  }): Promise<boolean> {
    const clanTag = normalizeTag(params.clanTag);
    if (params.warStartTime) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warStartTime: params.warStartTime,
        },
        data: { needsValidation: true },
      });
      return updated.count > 0;
    }
    if (params.warId !== null && params.warId !== undefined) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warId: String(params.warId),
        },
        data: { needsValidation: true },
      });
      return updated.count > 0;
    }
    const latest = await prisma.clanPointsSync.findFirst({
      where: { guildId: params.guildId, clanTag },
      orderBy: [{ warStartTime: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    });
    if (!latest?.id) return false;
    await prisma.clanPointsSync.update({
      where: { id: latest.id },
      data: { needsValidation: true },
    });
    return true;
  }

  /** Purpose: checkpoint a trusted current-war sync number without rewriting full points fields. */
  async checkpointCurrentWarSync(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    syncNum: number;
    fetchedAt?: Date | null;
    fetchReason?: PointsApiFetchReason | null;
  }): Promise<boolean> {
    const clanTag = normalizeTag(params.clanTag);
    const warStartTime = normalizeDate(params.warStartTime);
    const syncNum = normalizeOptionalInt(params.syncNum);
    if (syncNum === null) return false;
    const payload = {
      lastKnownSyncNumber: syncNum,
      lastSuccessfulPointsApiFetchAt: normalizeDate(params.fetchedAt) ?? new Date(),
      lastFetchReason: params.fetchReason ?? null,
    };
    if (warStartTime) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warStartTime,
        },
        data: payload,
      });
      return updated.count > 0;
    }
    if (params.warId !== null && params.warId !== undefined) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warId: String(params.warId),
        },
        data: payload,
      });
      return updated.count > 0;
    }
    return false;
  }

  /** Purpose: checkpoint clan-mail confirmation and freeze routine polling by default. */
  async markConfirmedByClanMail(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    matchType?: string | null;
    outcome?: string | null;
    syncNum?: number | null;
    points?: number | null;
  }): Promise<boolean> {
    const clanTag = normalizeTag(params.clanTag);
    const matchType = (params.matchType ?? "").trim().toUpperCase() || null;
    const payload = {
      confirmedByClanMail: true,
      needsValidation: false,
      ...(matchType ? { lastKnownMatchType: matchType } : {}),
      ...(params.outcome !== undefined ? { lastKnownOutcome: params.outcome ?? null } : {}),
      ...(normalizeOptionalInt(params.syncNum) !== null
        ? { lastKnownSyncNumber: normalizeOptionalInt(params.syncNum) }
        : {}),
      ...(normalizeOptionalInt(params.points) !== null
        ? { lastKnownPoints: normalizeOptionalInt(params.points) }
        : {}),
    };
    if (params.warStartTime) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warStartTime: params.warStartTime,
        },
        data: payload,
      });
      return updated.count > 0;
    }
    if (params.warId !== null && params.warId !== undefined) {
      const updated = await prisma.clanPointsSync.updateMany({
        where: {
          guildId: params.guildId,
          clanTag,
          warId: String(params.warId),
        },
        data: payload,
      });
      return updated.count > 0;
    }
    const latest = await prisma.clanPointsSync.findFirst({
      where: { guildId: params.guildId, clanTag },
      orderBy: [{ warStartTime: "desc" }, { updatedAt: "desc" }],
      select: { id: true },
    });
    if (!latest?.id) return false;
    await prisma.clanPointsSync.update({
      where: { id: latest.id },
      data: payload,
    });
    return true;
  }
}
