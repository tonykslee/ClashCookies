import { PointsSyncService } from "./PointsSyncService";

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
  ) {}

  /** Purpose: resolve the default Clan Health window as a contiguous sync-number range. */
  public async resolveLatestSyncWindow(input: {
    guildId: string;
  }): Promise<ClanHealthHistoricalWindow> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return buildClanHealthHistoricalSyncWindow(null);

    try {
      const latestSyncNumber = await this.pointsSyncService.findLatestSyncNum({ guildId });
      return buildClanHealthHistoricalSyncWindow(latestSyncNumber);
    } catch {
      return buildClanHealthHistoricalSyncWindow(null);
    }
  }
}
