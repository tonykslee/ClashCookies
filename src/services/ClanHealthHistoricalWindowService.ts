import { prisma } from "../prisma";

export const CLAN_HEALTH_DEFAULT_SYNC_COUNT = 30 as const;

export type ClanHealthHistoricalWindow =
  | {
      kind: "syncs";
      requestedSyncCount: typeof CLAN_HEALTH_DEFAULT_SYNC_COUNT;
      syncNumbers: number[];
      syncTimes: Date[];
    }
  | {
      kind: "days";
      days: number;
      cutoff: Date;
    };

type ClanHealthHistoricalWindowDb = {
  syncCycle?: {
    findMany: (args: unknown) => Promise<unknown[]>;
  };
};

/** Purpose: resolve the latest canonical scheduled sync boundaries for default Clan Health history. */
export class ClanHealthHistoricalWindowService {
  constructor(
    private readonly db: ClanHealthHistoricalWindowDb = prisma as unknown as ClanHealthHistoricalWindowDb,
  ) {}

  /** Purpose: read at most the latest 30 completed-or-known guild sync identities without day approximation. */
  async resolveLatestSyncWindow(input: {
    guildId: string;
    now: Date;
  }): Promise<Extract<ClanHealthHistoricalWindow, { kind: "syncs" }>> {
    const guildId = String(input.guildId ?? "").trim();
    const now = input.now instanceof Date && Number.isFinite(input.now.getTime())
      ? input.now
      : new Date();
    if (!guildId || !this.db.syncCycle?.findMany) {
      return {
        kind: "syncs",
        requestedSyncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
        syncNumbers: [],
        syncTimes: [],
      };
    }

    const rows = await this.db.syncCycle.findMany({
      where: { guildId, syncTime: { lte: now } },
      orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
      take: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
      select: { syncNumber: true, syncTime: true },
    });
    const seenNumbers = new Set<number>();
    const seenTimes = new Set<number>();
    const syncNumbers: number[] = [];
    const syncTimes: Date[] = [];
    for (const row of rows) {
      const candidate = row as Record<string, unknown> | null;
      const syncNumber = Number(candidate?.syncNumber);
      const syncTime = candidate?.syncTime instanceof Date
        ? new Date(candidate.syncTime)
        : new Date(String(candidate?.syncTime ?? ""));
      if (
        !Number.isInteger(syncNumber) ||
        syncNumber <= 0 ||
        !Number.isFinite(syncTime.getTime()) ||
        seenNumbers.has(syncNumber) ||
        seenTimes.has(syncTime.getTime())
      ) {
        continue;
      }
      seenNumbers.add(syncNumber);
      seenTimes.add(syncTime.getTime());
      syncNumbers.push(syncNumber);
      syncTimes.push(syncTime);
    }
    return {
      kind: "syncs",
      requestedSyncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
      syncNumbers,
      syncTimes,
    };
  }
}

