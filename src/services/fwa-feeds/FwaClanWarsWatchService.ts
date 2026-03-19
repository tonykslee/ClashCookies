import { prisma } from "../../prisma";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  parseSyncTimeMetadata,
} from "../TrackedMessageService";
import { normalizeFwaTag } from "./normalize";
import { FwaClanWarsSyncService } from "./FwaClanWarsSyncService";
import { mapWithConcurrency } from "./concurrency";

type SyncSchedule = {
  syncTimeSourceMessageId: string;
  nextSyncTimeAt: Date;
  pollWindowStartAt: Date;
  cycleKey: string;
};

/** Purpose: compute the next daily sync timestamp from a base epoch while preserving hour/minute cadence. */
function computeNextDailySyncTime(baseMs: number, nowMs: number): number | null {
  if (!Number.isFinite(baseMs) || !Number.isFinite(nowMs)) return null;
  let nextSyncMs = Math.trunc(baseMs);
  while (nextSyncMs <= nowMs) {
    nextSyncMs += 24 * 60 * 60 * 1000;
  }
  return nextSyncMs;
}

/** Purpose: derive the tracked-clan wars watch window from the next sync timestamp. */
function buildWatchWindow(nextSyncMs: number): { nextSyncTimeAt: Date; pollWindowStartAt: Date } {
  return {
    nextSyncTimeAt: new Date(nextSyncMs),
    pollWindowStartAt: new Date(nextSyncMs - 5 * 60 * 1000),
  };
}

/** Purpose: coordinate per-clan tracked Wars.json watch windows tied to sync-time source data. */
export class FwaClanWarsWatchService {
  /** Purpose: initialize tracked wars watch dependencies. */
  constructor(private readonly clanWarsSync = new FwaClanWarsSyncService()) {}

  /** Purpose: execute one watch tick, activating/deactivating per-clan windows and polling active clans. */
  async runWatchTick(params?: { now?: Date; concurrency?: number }): Promise<{
    trackedClanCount: number;
    activeClanCount: number;
    polledClanCount: number;
    updateAcquiredCount: number;
  }> {
    const now = params?.now ?? new Date();
    const nowMs = now.getTime();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedTags = [...new Set(tracked.map((row) => normalizeFwaTag(row.tag)).filter(Boolean))];
    if (trackedTags.length === 0) {
      return {
        trackedClanCount: 0,
        activeClanCount: 0,
        polledClanCount: 0,
        updateAcquiredCount: 0,
      };
    }

    const schedules = await this.resolveSyncSchedules(now);
    const existingStates = await prisma.fwaClanWarsWatchState.findMany({
      where: { clanTag: { in: trackedTags } },
    });
    const existingByTag = new Map(existingStates.map((row) => [normalizeFwaTag(row.clanTag), row]));

    const watchUpserts = trackedTags.map(async (clanTag) => {
      const schedule = schedules.get(clanTag) ?? null;
      const existing = existingByTag.get(clanTag) ?? null;
      const cycleKey = schedule?.cycleKey ?? null;
      const cycleChanged = Boolean(cycleKey && existing?.currentWarCycleKey !== cycleKey);
      const alreadyAcquired =
        !cycleChanged &&
        existing?.currentWarCycleKey === cycleKey &&
        existing?.stopReason === "update_acquired";
      const withinWatchWindow =
        Boolean(schedule) &&
        nowMs >= schedule!.pollWindowStartAt.getTime() &&
        nowMs <= schedule!.nextSyncTimeAt.getTime() + 12 * 60 * 60 * 1000;
      const pollingActive = Boolean(withinWatchWindow && !alreadyAcquired);
      const stopReason = !schedule
        ? "missing_sync_time"
        : alreadyAcquired
          ? "update_acquired"
          : withinWatchWindow
            ? null
            : nowMs < schedule.pollWindowStartAt.getTime()
              ? "waiting_for_window"
              : "window_expired";
      const lastObservedContentHash = cycleChanged ? null : existing?.lastObservedContentHash ?? null;

      if (!existing?.pollingActive && pollingActive) {
        console.info(
          `[fwa-feed] watch_activate clan=${clanTag} cycle=${cycleKey ?? "none"} window_start=${schedule?.pollWindowStartAt?.toISOString() ?? "none"} next_sync=${schedule?.nextSyncTimeAt?.toISOString() ?? "none"}`,
        );
      } else if (existing?.pollingActive && !pollingActive) {
        console.info(
          `[fwa-feed] watch_stop clan=${clanTag} cycle=${cycleKey ?? "none"} reason=${stopReason ?? "none"}`,
        );
      }

      await prisma.fwaClanWarsWatchState.upsert({
        where: { clanTag },
        update: {
          syncTimeSourceMessageId: schedule?.syncTimeSourceMessageId ?? null,
          nextSyncTimeAt: schedule?.nextSyncTimeAt ?? null,
          pollWindowStartAt: schedule?.pollWindowStartAt ?? null,
          pollingActive,
          currentWarCycleKey: cycleKey,
          stopReason,
          ...(cycleChanged ? { lastDetectedWarEndAt: null, lastAcquiredUpdateAt: null } : {}),
          lastObservedContentHash,
        },
        create: {
          clanTag,
          syncTimeSourceMessageId: schedule?.syncTimeSourceMessageId ?? null,
          nextSyncTimeAt: schedule?.nextSyncTimeAt ?? null,
          pollWindowStartAt: schedule?.pollWindowStartAt ?? null,
          pollingActive,
          currentWarCycleKey: cycleKey,
          stopReason,
          lastObservedContentHash,
        },
      });
    });
    await Promise.all(watchUpserts);

    const activeStates = await prisma.fwaClanWarsWatchState.findMany({
      where: {
        clanTag: { in: trackedTags },
        pollingActive: true,
      },
      orderBy: { clanTag: "asc" },
    });

    const concurrency = Math.max(1, Math.trunc(params?.concurrency ?? 3));
    const pollOutcomes = await mapWithConcurrency(activeStates, concurrency, async (state) => {
      const syncResult = await this.clanWarsSync.syncClan(state.clanTag, {
        force: true,
        minimumIntervalMs: 0,
        now,
      });
      const previousHash = state.lastObservedContentHash ?? null;
      const nextHash = syncResult.contentHash ?? null;
      const updateAcquired = Boolean(previousHash && nextHash && previousHash !== nextHash);
      const latestWarRow = await prisma.fwaClanWarLogCurrent.findFirst({
        where: { clanTag: state.clanTag },
        orderBy: { endTime: "desc" },
        select: { endTime: true },
      });
      await prisma.fwaClanWarsWatchState.update({
        where: { clanTag: state.clanTag },
        data: {
          lastObservedContentHash: nextHash,
          lastDetectedWarEndAt: latestWarRow?.endTime ?? null,
          ...(updateAcquired
            ? {
                pollingActive: false,
                lastAcquiredUpdateAt: now,
                stopReason: "update_acquired",
              }
            : {}),
        },
      });
      if (updateAcquired) {
        console.info(
          `[fwa-feed] watch_update_acquired clan=${state.clanTag} cycle=${state.currentWarCycleKey ?? "none"} latest_end_time=${latestWarRow?.endTime?.toISOString() ?? "none"}`,
        );
      }
      return {
        clanTag: state.clanTag,
        updateAcquired,
      };
    });

    return {
      trackedClanCount: trackedTags.length,
      activeClanCount: activeStates.length,
      polledClanCount: pollOutcomes.length,
      updateAcquiredCount: pollOutcomes.filter((row) => row.updateAcquired).length,
    };
  }

  /** Purpose: fetch persistent watch-state rows for operational status reporting. */
  async getWatchStatus(clanTag?: string) {
    const normalized = clanTag ? normalizeFwaTag(clanTag) : null;
    return prisma.fwaClanWarsWatchState.findMany({
      where: normalized ? { clanTag: normalized } : undefined,
      orderBy: { clanTag: "asc" },
    });
  }

  /** Purpose: resolve per-clan sync schedules from the active sync-time tracked-message source of truth. */
  private async resolveSyncSchedules(now: Date): Promise<Map<string, SyncSchedule>> {
    const rows = await prisma.trackedMessage.findMany({
      where: {
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        messageId: true,
        metadata: true,
      },
    });
    const schedules = new Map<string, SyncSchedule>();
    for (const row of rows) {
      const metadata = parseSyncTimeMetadata(row.metadata);
      if (!metadata) continue;
      const baseMs =
        Number.isFinite(metadata.syncEpochSeconds) && metadata.syncEpochSeconds > 0
          ? metadata.syncEpochSeconds * 1000
          : Date.parse(metadata.syncTimeIso);
      const nowMs = now.getTime();
      const nextSyncMs = computeNextDailySyncTime(baseMs, nowMs);
      if (nextSyncMs === null) continue;
      const { nextSyncTimeAt, pollWindowStartAt } = buildWatchWindow(nextSyncMs);
      for (const clan of metadata.clans) {
        const clanTag = normalizeFwaTag(clan.clanTag);
        if (!clanTag || schedules.has(clanTag)) continue;
        schedules.set(clanTag, {
          syncTimeSourceMessageId: row.messageId,
          nextSyncTimeAt,
          pollWindowStartAt,
          cycleKey: `${clanTag}:${nextSyncTimeAt.toISOString()}`,
        });
      }
    }
    return schedules;
  }
}

export const computeNextDailySyncTimeForTest = computeNextDailySyncTime;
export const buildWatchWindowForTest = buildWatchWindow;
