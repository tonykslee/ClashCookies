import type { FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";
import { computeFeedContentHash } from "./hash";
import { FwaStatsClient } from "./FwaStatsClient";
import { FwaFeedSyncStateService } from "./FwaFeedSyncStateService";
import type { FwaSyncResult } from "./types";

type SyncOptions = {
  force?: boolean;
  minimumIntervalMs?: number;
  now?: Date;
};

/** Purpose: sync global active-fwa clan catalog from Clans.json into current-state storage. */
export class FwaClansCatalogSyncService {
  private static readonly FEED_TYPE: FwaFeedType = "CLANS";
  private readonly syncState = new FwaFeedSyncStateService();

  /** Purpose: initialize clan-catalog sync dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: execute one idempotent global catalog sync run with sync-state tracking. */
  async syncGlobalCatalog(options?: SyncOptions): Promise<FwaSyncResult> {
    const now = options?.now ?? new Date();
    const minimumIntervalMs = Math.max(0, Math.trunc(options?.minimumIntervalMs ?? 0));
    const scope = {
      feedType: FwaClansCatalogSyncService.FEED_TYPE,
      scopeType: "GLOBAL" as const,
      scopeKey: null,
    };
    const nextEligibleAt =
      minimumIntervalMs > 0 ? new Date(now.getTime() + minimumIntervalMs) : null;
    if (!options?.force && minimumIntervalMs > 0) {
      const eligible = await this.syncState.isEligible(scope, minimumIntervalMs, now);
      if (!eligible) {
        return {
          rowCount: 0,
          changedRowCount: 0,
          contentHash: null,
          status: "SKIPPED",
        };
      }
    }

    await this.syncState.recordAttempt(scope, nextEligibleAt, now);
    try {
      const rows = await this.client.fetchClans();
      const contentHash = computeFeedContentHash(
        [...rows].sort((a, b) => a.clanTag.localeCompare(b.clanTag)),
      );
      const previousState = await this.syncState.getState(scope);
      if (previousState?.lastContentHash === contentHash) {
        const result: FwaSyncResult = {
          rowCount: rows.length,
          changedRowCount: 0,
          contentHash,
          status: "NOOP",
        };
        await this.syncState.recordSuccess(
          {
            ...scope,
            ...result,
            nextEligibleAt,
          },
          now,
        );
        return result;
      }

      await prisma.$transaction(async (tx) => {
        for (const row of rows) {
          await tx.fwaClanCatalog.upsert({
            where: { clanTag: row.clanTag },
            update: {
              name: row.name,
              level: row.level,
              points: row.points,
              type: row.type,
              location: row.location,
              requiredTrophies: row.requiredTrophies,
              warFrequency: row.warFrequency,
              winStreak: row.winStreak,
              wins: row.wins,
              ties: row.ties,
              losses: row.losses,
              isWarLogPublic: row.isWarLogPublic,
              imageUrl: row.imageUrl,
              description: row.description,
              th18Count: row.th18Count,
              th17Count: row.th17Count,
              th16Count: row.th16Count,
              th15Count: row.th15Count,
              th14Count: row.th14Count,
              th13Count: row.th13Count,
              th12Count: row.th12Count,
              th11Count: row.th11Count,
              th10Count: row.th10Count,
              th9Count: row.th9Count,
              th8Count: row.th8Count,
              thLowCount: row.thLowCount,
              estimatedWeight: row.estimatedWeight,
              lastSeenAt: now,
              lastSyncedAt: now,
            },
            create: {
              clanTag: row.clanTag,
              name: row.name,
              level: row.level,
              points: row.points,
              type: row.type,
              location: row.location,
              requiredTrophies: row.requiredTrophies,
              warFrequency: row.warFrequency,
              winStreak: row.winStreak,
              wins: row.wins,
              ties: row.ties,
              losses: row.losses,
              isWarLogPublic: row.isWarLogPublic,
              imageUrl: row.imageUrl,
              description: row.description,
              th18Count: row.th18Count,
              th17Count: row.th17Count,
              th16Count: row.th16Count,
              th15Count: row.th15Count,
              th14Count: row.th14Count,
              th13Count: row.th13Count,
              th12Count: row.th12Count,
              th11Count: row.th11Count,
              th10Count: row.th10Count,
              th9Count: row.th9Count,
              th8Count: row.th8Count,
              thLowCount: row.thLowCount,
              estimatedWeight: row.estimatedWeight,
              firstSeenAt: now,
              lastSeenAt: now,
              lastSyncedAt: now,
            },
          });
        }
      });

      const result: FwaSyncResult = {
        rowCount: rows.length,
        changedRowCount: rows.length,
        contentHash,
        status: "SUCCESS",
      };
      await this.syncState.recordSuccess(
        {
          ...scope,
          ...result,
          nextEligibleAt,
        },
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
