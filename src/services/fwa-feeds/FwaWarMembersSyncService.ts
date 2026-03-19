import type { FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";
import { computeFeedContentHash } from "./hash";
import { normalizeFwaTag } from "./normalize";
import { FwaStatsClient } from "./FwaStatsClient";
import { FwaFeedCursorService } from "./FwaFeedCursorService";
import { FwaFeedSyncStateService } from "./FwaFeedSyncStateService";
import { mapWithConcurrency } from "./concurrency";
import { selectDistributedSweepChunk } from "./sweep";
import type { FwaSyncResult } from "./types";

type SyncOptions = {
  force?: boolean;
  minimumIntervalMs?: number;
  now?: Date;
};

/** Purpose: sync distributed WarMembers.json sweeps into authoritative current-war roster snapshots. */
export class FwaWarMembersSyncService {
  private static readonly FEED_TYPE: FwaFeedType = "WAR_MEMBERS";
  private readonly syncState = new FwaFeedSyncStateService();
  private readonly cursor = new FwaFeedCursorService();

  /** Purpose: initialize war-members sync dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: sync one clan war-members scope with stale-row cleanup and player-catalog updates. */
  async syncClan(clanTag: string, options?: SyncOptions): Promise<FwaSyncResult> {
    const normalizedClanTag = normalizeFwaTag(clanTag);
    if (!normalizedClanTag) {
      return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
    }
    const now = options?.now ?? new Date();
    const minimumIntervalMs = Math.max(0, Math.trunc(options?.minimumIntervalMs ?? 0));
    const scope = {
      feedType: FwaWarMembersSyncService.FEED_TYPE,
      scopeType: "CLAN_TAG" as const,
      scopeKey: normalizedClanTag,
    };
    const nextEligibleAt =
      minimumIntervalMs > 0 ? new Date(now.getTime() + minimumIntervalMs) : null;
    if (!options?.force && minimumIntervalMs > 0) {
      const eligible = await this.syncState.isEligible(scope, minimumIntervalMs, now);
      if (!eligible) {
        return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
      }
    }

    await this.syncState.recordAttempt(scope, nextEligibleAt, now);
    try {
      const rows = await this.client.fetchWarMembers(normalizedClanTag);
      const sortedRows = [...rows].sort((a, b) => a.playerTag.localeCompare(b.playerTag));
      const contentHash = computeFeedContentHash(sortedRows);
      const previousState = await this.syncState.getState(scope);
      if (previousState?.lastContentHash === contentHash) {
        const result: FwaSyncResult = {
          rowCount: rows.length,
          changedRowCount: 0,
          contentHash,
          status: "NOOP",
        };
        await this.syncState.recordSuccess({ ...scope, ...result, nextEligibleAt }, now);
        return result;
      }

      const changedRowCount = await prisma.$transaction(async (tx) => {
        const playerTags = rows.map((row) => row.playerTag);
        const staleDelete = await tx.fwaWarMemberCurrent.deleteMany({
          where: {
            clanTag: normalizedClanTag,
            ...(playerTags.length > 0 ? { playerTag: { notIn: playerTags } } : {}),
          },
        });
        for (const row of rows) {
          await tx.fwaWarMemberCurrent.upsert({
            where: {
              clanTag_playerTag: {
                clanTag: normalizedClanTag,
                playerTag: row.playerTag,
              },
            },
            update: {
              playerName: row.playerName,
              position: row.position,
              townHall: row.townHall,
              weight: row.weight,
              opponentTag: row.opponentTag,
              opponentName: row.opponentName,
              attacks: row.attacks,
              defender1Tag: row.defender1Tag,
              defender1Name: row.defender1Name,
              defender1TownHall: row.defender1TownHall,
              defender1Position: row.defender1Position,
              stars1: row.stars1,
              destructionPercentage1: row.destructionPercentage1,
              defender2Tag: row.defender2Tag,
              defender2Name: row.defender2Name,
              defender2TownHall: row.defender2TownHall,
              defender2Position: row.defender2Position,
              stars2: row.stars2,
              destructionPercentage2: row.destructionPercentage2,
              sourceSyncedAt: now,
            },
            create: {
              clanTag: normalizedClanTag,
              playerTag: row.playerTag,
              playerName: row.playerName,
              position: row.position,
              townHall: row.townHall,
              weight: row.weight,
              opponentTag: row.opponentTag,
              opponentName: row.opponentName,
              attacks: row.attacks,
              defender1Tag: row.defender1Tag,
              defender1Name: row.defender1Name,
              defender1TownHall: row.defender1TownHall,
              defender1Position: row.defender1Position,
              stars1: row.stars1,
              destructionPercentage1: row.destructionPercentage1,
              defender2Tag: row.defender2Tag,
              defender2Name: row.defender2Name,
              defender2TownHall: row.defender2TownHall,
              defender2Position: row.defender2Position,
              stars2: row.stars2,
              destructionPercentage2: row.destructionPercentage2,
              sourceSyncedAt: now,
            },
          });

          await tx.fwaPlayerCatalog.upsert({
            where: { playerTag: row.playerTag },
            update: {
              latestName: row.playerName,
              latestTownHall: row.townHall,
              latestKnownWeight: row.weight,
              lastSeenAt: now,
              lastSyncedAt: now,
            },
            create: {
              playerTag: row.playerTag,
              latestName: row.playerName,
              latestTownHall: row.townHall,
              latestKnownWeight: row.weight,
              firstSeenAt: now,
              lastSeenAt: now,
              lastSyncedAt: now,
            },
          });
        }
        return staleDelete.count + rows.length;
      });

      const result: FwaSyncResult = {
        rowCount: rows.length,
        changedRowCount,
        contentHash,
        status: "SUCCESS",
      };
      await this.syncState.recordSuccess({ ...scope, ...result, nextEligibleAt }, now);
      return result;
    } catch (error) {
      const errorSummary = String((error as { message?: string })?.message ?? "unknown error").slice(
        0,
        200,
      );
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SYNC_FAILED",
          errorSummary,
          nextEligibleAt,
        },
        now,
      );
      throw error;
    }
  }

  /** Purpose: process one bounded cursor-based global sweep chunk from FwaClanCatalog. */
  async runDistributedSweep(params: {
    chunkSize: number;
    concurrency: number;
    force?: boolean;
    minimumIntervalMs?: number;
    now?: Date;
  }): Promise<{
    attemptedClans: number;
    rowCount: number;
    changedRowCount: number;
    failedClans: string[];
    nextCursor: string | null;
  }> {
    const now = params.now ?? new Date();
    const chunkSize = Math.max(1, Math.trunc(params.chunkSize));
    const concurrency = Math.max(1, Math.trunc(params.concurrency));
    const catalog = await prisma.fwaClanCatalog.findMany({
      orderBy: { clanTag: "asc" },
      select: { clanTag: true },
    });
    const tags = catalog.map((row) => normalizeFwaTag(row.clanTag)).filter(Boolean);
    if (tags.length === 0) {
      return {
        attemptedClans: 0,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: [],
        nextCursor: null,
      };
    }

    const cursor = await this.cursor.getCursor(FwaWarMembersSyncService.FEED_TYPE);
    const currentCursor = cursor?.lastScopeKey ? normalizeFwaTag(cursor.lastScopeKey) : null;
    const selected = selectDistributedSweepChunk(tags, currentCursor, chunkSize);

    const outcomes = await mapWithConcurrency(selected, concurrency, async (tag) => {
      try {
        const result = await this.syncClan(tag, {
          force: params.force,
          minimumIntervalMs: params.minimumIntervalMs,
          now,
        });
        return { tag, result, failed: false };
      } catch {
        return { tag, result: null, failed: true };
      }
    });

    const summary = outcomes.reduce(
      (acc, row) => {
        if (row.failed || !row.result) {
          acc.failedClans.push(row.tag);
          return acc;
        }
        acc.rowCount += row.result.rowCount;
        acc.changedRowCount += row.result.changedRowCount;
        return acc;
      },
      {
        attemptedClans: selected.length,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: [] as string[],
      },
    );

    const nextCursor = selected[selected.length - 1] ?? null;
    await this.cursor.saveCursor({
      feedType: FwaWarMembersSyncService.FEED_TYPE,
      lastScopeKey: nextCursor,
      lastRunAt: now,
    });

    return {
      ...summary,
      nextCursor,
    };
  }
}

export const selectDistributedSweepChunkForTest = selectDistributedSweepChunk;
