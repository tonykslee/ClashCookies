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

function buildWarRowKey(input: { endTime: Date; opponentTag: string; teamSize: number }): string {
  return `${input.endTime.toISOString()}|${input.opponentTag}|${input.teamSize}`;
}

/** Purpose: sync Wars.json rows into bounded current-war-log snapshots per clan scope. */
export class FwaClanWarsSyncService {
  private static readonly FEED_TYPE: FwaFeedType = "CLAN_WARS";
  private readonly syncState = new FwaFeedSyncStateService();
  private readonly cursor = new FwaFeedCursorService();

  /** Purpose: initialize clan-wars sync dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: sync one clan war-log scope with bounded stale-row cleanup and content-hash gating. */
  async syncClan(clanTag: string, options?: SyncOptions): Promise<FwaSyncResult> {
    const normalizedClanTag = normalizeFwaTag(clanTag);
    if (!normalizedClanTag) {
      return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
    }
    const now = options?.now ?? new Date();
    const minimumIntervalMs = Math.max(0, Math.trunc(options?.minimumIntervalMs ?? 0));
    const scope = {
      feedType: FwaClanWarsSyncService.FEED_TYPE,
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
      const rows = await this.client.fetchClanWars(normalizedClanTag);
      const sortedRows = [...rows].sort((a, b) => {
        const byEnd = b.endTime.getTime() - a.endTime.getTime();
        if (byEnd !== 0) return byEnd;
        return a.opponentTag.localeCompare(b.opponentTag);
      });
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
        const incomingKeySet = new Set(
          rows.map((row) =>
            buildWarRowKey({
              endTime: row.endTime,
              opponentTag: row.opponentTag,
              teamSize: row.teamSize,
            }),
          ),
        );

        const existing = await tx.fwaClanWarLogCurrent.findMany({
          where: { clanTag: normalizedClanTag },
          select: { id: true, endTime: true, opponentTag: true, teamSize: true },
        });
        const staleIds = existing
          .filter(
            (row) =>
              !incomingKeySet.has(
                buildWarRowKey({
                  endTime: row.endTime,
                  opponentTag: row.opponentTag,
                  teamSize: row.teamSize,
                }),
              ),
          )
          .map((row) => row.id);
        if (staleIds.length > 0) {
          await tx.fwaClanWarLogCurrent.deleteMany({
            where: { id: { in: staleIds } },
          });
        }

        for (const row of rows) {
          await tx.fwaClanWarLogCurrent.upsert({
            where: {
              clanTag_endTime_opponentTag_teamSize: {
                clanTag: normalizedClanTag,
                endTime: row.endTime,
                opponentTag: row.opponentTag,
                teamSize: row.teamSize,
              },
            },
            update: {
              searchTime: row.searchTime,
              result: row.result,
              clanName: row.clanName,
              clanLevel: row.clanLevel,
              clanStars: row.clanStars,
              clanDestructionPercentage: row.clanDestructionPercentage,
              clanAttacks: row.clanAttacks,
              clanExpEarned: row.clanExpEarned,
              opponentName: row.opponentName,
              opponentLevel: row.opponentLevel,
              opponentStars: row.opponentStars,
              opponentDestructionPercentage: row.opponentDestructionPercentage,
              opponentInfo: row.opponentInfo,
              synced: row.synced,
              matched: row.matched,
              sourceSyncedAt: now,
            },
            create: {
              clanTag: normalizedClanTag,
              endTime: row.endTime,
              searchTime: row.searchTime,
              result: row.result,
              teamSize: row.teamSize,
              clanName: row.clanName,
              clanLevel: row.clanLevel,
              clanStars: row.clanStars,
              clanDestructionPercentage: row.clanDestructionPercentage,
              clanAttacks: row.clanAttacks,
              clanExpEarned: row.clanExpEarned,
              opponentTag: row.opponentTag,
              opponentName: row.opponentName,
              opponentLevel: row.opponentLevel,
              opponentStars: row.opponentStars,
              opponentDestructionPercentage: row.opponentDestructionPercentage,
              opponentInfo: row.opponentInfo,
              synced: row.synced,
              matched: row.matched,
              sourceSyncedAt: now,
            },
          });
        }
        return staleIds.length + rows.length;
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

  /** Purpose: process one bounded cursor-based global clan-wars sweep chunk from catalog tags. */
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

    const cursor = await this.cursor.getCursor(FwaClanWarsSyncService.FEED_TYPE);
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
      feedType: FwaClanWarsSyncService.FEED_TYPE,
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
