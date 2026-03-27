import type { FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";
import { computeFeedContentHash } from "./hash";
import { normalizeFwaTag } from "./normalize";
import { FwaStatsClient } from "./FwaStatsClient";
import { FwaFeedSyncStateService } from "./FwaFeedSyncStateService";
import { mapWithConcurrency } from "./concurrency";
import { normalizePersistedPlayerName } from "../PlayerLinkService";
import type { FwaSyncResult } from "./types";

type SyncOptions = {
  force?: boolean;
  minimumIntervalMs?: number;
  now?: Date;
};

/** Purpose: sync tracked-clan authoritative ACTUAL rosters from Members.json into current-state tables. */
export class FwaClanMembersSyncService {
  private static readonly FEED_TYPE: FwaFeedType = "CLAN_MEMBERS";
  private readonly syncState = new FwaFeedSyncStateService();

  /** Purpose: initialize members-sync dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: sync all tracked clans using bounded concurrency and tracked-clan authoritative source list. */
  async syncAllTrackedClans(params?: SyncOptions & { concurrency?: number }): Promise<{
    clanCount: number;
    rowCount: number;
    changedRowCount: number;
    failedClans: string[];
  }> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const clanTags = tracked.map((row) => normalizeFwaTag(row.tag)).filter(Boolean);
    const concurrency = Math.max(1, Math.trunc(params?.concurrency ?? 4));
    const results = await mapWithConcurrency(clanTags, concurrency, async (clanTag) => {
      try {
        const result = await this.syncTrackedClan(clanTag, params);
        return { clanTag, result, failed: false };
      } catch {
        return { clanTag, result: null, failed: true };
      }
    });

    return results.reduce(
      (acc, row) => {
        if (row.failed || !row.result) {
          acc.failedClans.push(row.clanTag);
          return acc;
        }
        acc.rowCount += row.result.rowCount;
        acc.changedRowCount += row.result.changedRowCount;
        return acc;
      },
      {
        clanCount: clanTags.length,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: [] as string[],
      },
    );
  }

  /** Purpose: sync one tracked clan members scope with stale-row cleanup and player-catalog upserts. */
  async syncTrackedClan(clanTag: string, options?: SyncOptions): Promise<FwaSyncResult> {
    const normalizedClanTag = normalizeFwaTag(clanTag);
    if (!normalizedClanTag) {
      return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
    }
    const now = options?.now ?? new Date();
    const minimumIntervalMs = Math.max(0, Math.trunc(options?.minimumIntervalMs ?? 0));
    const scope = {
      feedType: FwaClanMembersSyncService.FEED_TYPE,
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
      const rows = await this.client.fetchClanMembers(normalizedClanTag);
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
        await this.syncState.recordSuccess(
          { ...scope, ...result, nextEligibleAt },
          now,
        );
        return result;
      }

      const changedRowCount = await prisma.$transaction(async (tx) => {
        const playerTags = rows.map((row) => row.playerTag);
        const linkedPlayerRows =
          playerTags.length > 0
            ? await tx.playerLink.findMany({
                where: { playerTag: { in: playerTags } },
                select: { playerTag: true, playerName: true },
              })
            : [];
        const linkedPlayerNameByTag = new Map(
          linkedPlayerRows.map((row) => [
            row.playerTag,
            normalizePersistedPlayerName(row.playerName),
          ]),
        );
        const staleDelete = await tx.fwaClanMemberCurrent.deleteMany({
          where: {
            clanTag: normalizedClanTag,
            ...(playerTags.length > 0 ? { playerTag: { notIn: playerTags } } : {}),
          },
        });

        for (const row of rows) {
          await tx.fwaClanMemberCurrent.upsert({
            where: {
              clanTag_playerTag: {
                clanTag: normalizedClanTag,
                playerTag: row.playerTag,
              },
            },
            update: {
              playerName: row.playerName,
              role: row.role,
              level: row.level,
              donated: row.donated,
              received: row.received,
              rank: row.rank,
              trophies: row.trophies,
              league: row.league,
              townHall: row.townHall,
              weight: row.weight,
              inWar: row.inWar,
              sourceSyncedAt: now,
            },
            create: {
              clanTag: normalizedClanTag,
              playerTag: row.playerTag,
              playerName: row.playerName,
              role: row.role,
              level: row.level,
              donated: row.donated,
              received: row.received,
              rank: row.rank,
              trophies: row.trophies,
              league: row.league,
              townHall: row.townHall,
              weight: row.weight,
              inWar: row.inWar,
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

          if (linkedPlayerNameByTag.has(row.playerTag)) {
            const observedPlayerName = normalizePersistedPlayerName(row.playerName);
            const existingLinkedName =
              linkedPlayerNameByTag.get(row.playerTag) ?? null;
            if (observedPlayerName && observedPlayerName !== existingLinkedName) {
              const updated = await tx.playerLink.updateMany({
                where: { playerTag: row.playerTag },
                data: { playerName: observedPlayerName },
              });
              if (updated.count > 0) {
                linkedPlayerNameByTag.set(row.playerTag, observedPlayerName);
              }
            }
          }
        }
        return staleDelete.count + rows.length;
      });

      const result: FwaSyncResult = {
        rowCount: rows.length,
        changedRowCount,
        contentHash,
        status: "SUCCESS",
      };
      await this.syncState.recordSuccess(
        { ...scope, ...result, nextEligibleAt },
        now,
      );
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
}
