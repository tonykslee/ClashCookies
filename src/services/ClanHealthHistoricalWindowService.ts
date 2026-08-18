import { PointsSyncService } from "./PointsSyncService";
import { normalizeClashTagBareInput } from "../helper/clashTag";
import { prisma } from "../prisma";

export const CLAN_HEALTH_DEFAULT_SYNC_COUNT = 30 as const;

export type ClanHealthHistoricalSyncWindow = {
  kind: "syncs";
  requestedSyncCount: typeof CLAN_HEALTH_DEFAULT_SYNC_COUNT;
  startSyncNumber: number;
  endSyncNumber: number;
  syncNumbers: number[];
};

export type ClanHealthHistoricalWindow =
  | ClanHealthHistoricalSyncWindow
  | {
      kind: "days";
      days: number;
      cutoff: Date;
    }
  | {
      kind: "unavailable";
      requestedSyncCount: typeof CLAN_HEALTH_DEFAULT_SYNC_COUNT;
      reason: "latest_sync_unavailable";
    };

/** Purpose: build the explicit day-based historical window without changing the supported bounds. */
export function buildClanHealthHistoricalDaysWindow(input: {
  days: number;
  now: Date;
}): Extract<ClanHealthHistoricalWindow, { kind: "days" }> {
  return {
    kind: "days",
    days: input.days,
    cutoff: new Date(input.now.getTime() - input.days * 24 * 60 * 60 * 1000),
  };
}

/** Purpose: build the contiguous latest-sync-number range from one persisted baseline. */
export function buildClanHealthHistoricalSyncWindow(
  latestSyncNumber: number | null | undefined,
): ClanHealthHistoricalWindow {
  const endSyncNumber = Math.trunc(Number(latestSyncNumber));
  if (!Number.isInteger(endSyncNumber) || endSyncNumber <= 0) {
    return {
      kind: "unavailable",
      requestedSyncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
      reason: "latest_sync_unavailable",
    };
  }

  const startSyncNumber = Math.max(1, endSyncNumber - CLAN_HEALTH_DEFAULT_SYNC_COUNT + 1);
  return {
    kind: "syncs",
    requestedSyncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
    startSyncNumber,
    endSyncNumber,
    syncNumbers: Array.from(
      { length: endSyncNumber - startSyncNumber + 1 },
      (_, index) => startSyncNumber + index,
    ),
  };
}

/** Purpose: resolve the latest persisted points sync number without querying SyncCycle or external APIs. */
export class ClanHealthHistoricalWindowService {
  public constructor(
    private readonly pointsSyncService: Pick<PointsSyncService, "findLatestSyncNum"> =
      new PointsSyncService(),
    private readonly db: {
      clanWarHistory?: {
        findFirst: (args: unknown) => Promise<unknown>;
      };
    } = prisma as never,
  ) {}

  /** Purpose: resolve the default Clan Health window as a contiguous sync-number range. */
  public async resolveLatestSyncWindow(input: {
    guildId: string;
    clanTag?: string;
  }): Promise<ClanHealthHistoricalWindow> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return buildClanHealthHistoricalSyncWindow(null);

    try {
      const latestSyncNumber = await this.pointsSyncService.findLatestSyncNum({ guildId });
      const primaryWindow = buildClanHealthHistoricalSyncWindow(latestSyncNumber);
      if (primaryWindow.kind === "syncs") return primaryWindow;
    } catch {
      // The ended-war owner below is the bounded, DB-only fallback for a missing points baseline.
    }

    const clanTag = normalizeClashTagBareInput(String(input.clanTag ?? ""));
    if (!clanTag || !this.db.clanWarHistory?.findFirst) {
      return buildClanHealthHistoricalSyncWindow(null);
    }
    try {
      const row = await this.db.clanWarHistory.findFirst({
        where: {
          OR: [
            { clanTag: { equals: `#${clanTag}`, mode: "insensitive" } },
            { clanTag: { equals: clanTag, mode: "insensitive" } },
          ],
          syncNumber: { not: null },
        },
        orderBy: { syncNumber: "desc" },
        select: { syncNumber: true },
      });
      return buildClanHealthHistoricalSyncWindow(
        Number((row as { syncNumber?: unknown } | null)?.syncNumber),
      );
    } catch {
      return buildClanHealthHistoricalSyncWindow(null);
    }
  }
}
