import type { FwaFeedType } from "@prisma/client";
import { prisma } from "../../prisma";
import { normalizeFwaTag } from "./normalize";
import { CoCService } from "../CoCService";
import { FwaStatsClient } from "./FwaStatsClient";
import { FwaFeedSyncStateService } from "./FwaFeedSyncStateService";
import { mapWithConcurrency } from "./concurrency";
import { normalizePersistedPlayerName, normalizePlayerTag } from "../PlayerLinkService";
import type { FwaSyncResult } from "./types";
import {
  computeClanMembersSnapshotHash,
  normalizeClanMembersOptionalInteger,
  normalizeClanMembersOptionalText,
  toPersistedClanMembersSnapshotRow,
  toClanMembersSnapshotRow,
} from "./clanMembersSnapshot";

const CLAN_MEMBER_SNAPSHOT_SELECT = {
  clanTag: true,
  playerTag: true,
  playerName: true,
  role: true,
  level: true,
  donated: true,
  received: true,
  rank: true,
  trophies: true,
  league: true,
  townHall: true,
  weight: true,
  inWar: true,
} as const;

class SupersededClanMembersSyncError extends Error {
  constructor() {
    super("CLAN_MEMBERS sync was superseded by a newer attempt");
    this.name = "SupersededClanMembersSyncError";
  }
}

function isSameSyncAttempt(value: unknown, expected: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() === expected.getTime();
}

function normalizeCoCMemberRow(clanTag: string, row: Record<string, unknown>) {
  const playerTag = normalizePlayerTag(String(row.tag ?? ""));
  const playerName = normalizePersistedPlayerName(String(row.name ?? "")) ?? "";
  const townHallValue = row.townHallLevel ?? row.townhallLevel ?? row.townHall;
  return {
    clanTag,
    playerTag: playerTag ?? "",
    playerName,
    role: normalizeClanMembersOptionalText(row.role),
    level: normalizeClanMembersOptionalInteger(row.expLevel),
    donated: normalizeClanMembersOptionalInteger(row.donations),
    received: normalizeClanMembersOptionalInteger(row.donationsReceived),
    rank: normalizeClanMembersOptionalInteger(row.clanRank),
    trophies: normalizeClanMembersOptionalInteger(row.trophies),
    league: normalizeClanMembersOptionalText((row.league as { name?: unknown } | null)?.name),
    townHall: normalizeClanMembersOptionalInteger(townHallValue),
    weight: null,
    inWar: null,
  };
}

type SyncOptions = {
  force?: boolean;
  minimumIntervalMs?: number;
  now?: Date;
};

/** Purpose: sync tracked-clan authoritative ACTUAL rosters from Members.json into current-state tables. */
export class FwaClanMembersSyncService {
  private static readonly FEED_TYPE: FwaFeedType = "CLAN_MEMBERS";
  private readonly syncState = new FwaFeedSyncStateService();
  private readonly inFlightByClanTag = new Map<string, Promise<unknown>>();

  /** Purpose: initialize members-sync dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: refresh current clan-member rows from CoC for one or more clan tags. */
  async refreshCurrentClanMembersForClanTags(
    clanTags: string[],
    options?: { cocService?: CoCService; concurrency?: number; now?: Date },
  ): Promise<{
    clanCount: number;
    rowCount: number;
    changedRowCount: number;
    failedClans: string[];
  }> {
    const normalizedClanTags = [...new Set(clanTags.map((tag) => normalizeFwaTag(tag)).filter(Boolean))];
    const concurrency = Math.max(1, Math.trunc(options?.concurrency ?? 4));
    const cocService = options?.cocService ?? new CoCService();
    const now = options?.now ?? new Date();
    console.info(
      `[fwa-feed] cwl_overview_current_members_refresh requested clan_count=${normalizedClanTags.length}`,
    );
    const results = await mapWithConcurrency(normalizedClanTags, concurrency, async (clanTag) => {
      const scope = {
        feedType: FwaClanMembersSyncService.FEED_TYPE,
        scopeType: "CLAN_TAG" as const,
        scopeKey: clanTag,
      };
      try {
        const previousState = await this.syncState.getState(scope);
        const attemptAccepted = await this.syncState.recordAttempt(
          scope,
          previousState?.nextEligibleAt ?? null,
          now,
        );
        if (!attemptAccepted) {
          return { clanTag, failed: false, rowCount: 0, changedRowCount: 0 };
        }
        const clan = await cocService.getClan(clanTag);
        if (clan?.memberListPresent !== true || !Array.isArray(clan?.members)) {
          throw new Error("CLAN_MEMBERS response did not include an authoritative member list");
        }
        if (normalizeFwaTag(clan?.tag) !== clanTag) {
          throw new Error("CLAN_MEMBERS response clan identity did not match the requested tag");
        }
        if (
          clan?.declaredMemberCountPresent === true &&
          (clan?.declaredMemberCountValid !== true ||
          clan?.declaredMemberCount === null ||
          !Number.isInteger(clan.declaredMemberCount) ||
            clan.declaredMemberCount < 0 ||
            clan.declaredMemberCount > 50 ||
            clan.declaredMemberCount !== clan.members.length)
        ) {
          throw new Error("CLAN_MEMBERS response declared member count was incomplete or contradictory");
        }
        if (clan.members.length > 50) {
          throw new Error("CLAN_MEMBERS response exceeded clan capacity");
        }
        const members = clan.members as Array<Record<string, unknown>>;
        const normalizedMembers = members.map((row) => normalizeCoCMemberRow(clanTag, row));
        const playerTags: Array<string | null> = normalizedMembers.map((row) =>
          row.playerTag || null,
        );
        if (
          playerTags.some((tag) => !tag) ||
          new Set(playerTags).size !== playerTags.length ||
          normalizedMembers.some((row) => !row.playerName)
        ) {
          throw new Error("CLAN_MEMBERS response contained malformed, missing, or duplicate member data");
        }
        const validPlayerTags = playerTags.filter((tag): tag is string => Boolean(tag));
        const result = await prisma.$transaction(async (tx) => {
          await this.syncState.lockScope(scope, tx);
          const currentState = await this.syncState.getState(scope, tx);
          if (!currentState || !isSameSyncAttempt(currentState.lastAttemptAt, now)) {
            throw new SupersededClanMembersSyncError();
          }
          const staleDelete = await tx.fwaClanMemberCurrent.deleteMany({
            where: {
              clanTag,
              ...(validPlayerTags.length > 0 ? { playerTag: { notIn: validPlayerTags } } : {}),
            },
          });
          for (const row of normalizedMembers) {
            const playerTag = row.playerTag;
            await tx.fwaClanMemberCurrent.upsert({
              where: {
                clanTag_playerTag: {
                  clanTag,
                  playerTag,
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
                sourceSyncedAt: now,
              },
              create: {
                clanTag,
                playerTag,
                playerName: row.playerName,
                role: row.role,
                level: row.level,
                donated: row.donated,
                received: row.received,
                rank: row.rank,
                trophies: row.trophies,
                league: row.league,
                townHall: row.townHall,
                sourceSyncedAt: now,
              },
            });
          }
          const persistedRows = await tx.fwaClanMemberCurrent.findMany({
            where: { clanTag },
            select: CLAN_MEMBER_SNAPSHOT_SELECT,
            orderBy: { playerTag: "asc" },
          });
          const contentHash = computeClanMembersSnapshotHash(
            persistedRows.map((row) => toPersistedClanMembersSnapshotRow(row)),
          );
          const result = {
            rowCount: persistedRows.length,
            changedRowCount: staleDelete.count + normalizedMembers.length,
            contentHash,
            status: "SUCCESS" as const,
          };
          const recorded = await this.syncState.recordSuccess(
            { ...scope, ...result, nextEligibleAt: currentState.nextEligibleAt ?? null },
            now,
            tx,
            now,
          );
          if (!recorded) {
            throw new SupersededClanMembersSyncError();
          }
          return {
            ...result,
          };
        });
        console.info(
          `[fwa-feed] cwl_overview_current_members_refresh clan=${clanTag} status=SUCCESS rows=${result.rowCount} persisted=${result.rowCount}`,
        );
        return { clanTag, failed: false, ...result };
      } catch (error) {
        if (error instanceof SupersededClanMembersSyncError) {
          return { clanTag, failed: false, rowCount: 0, changedRowCount: 0 };
        }
        try {
          const currentState = await this.syncState.getState(scope).catch(() => null);
          await this.syncState.recordFailure(
            {
              ...scope,
              errorCode: "COC_REFRESH_FAILED",
              errorSummary: String(
                (error as { message?: unknown })?.message ?? error,
              ).slice(0, 200),
              nextEligibleAt: currentState?.nextEligibleAt ?? null,
            },
            now,
            now,
          );
        } catch {
          // Preserve the bounded per-clan failure result if diagnostics cannot persist.
        }
        console.warn(
          `[fwa-feed] cwl_overview_current_members_refresh clan=${clanTag} status=FAILURE error=${String(
            (error as { message?: unknown })?.message ?? error,
          ).slice(0, 200)}`,
        );
        return { clanTag, failed: true, rowCount: 0, changedRowCount: 0 };
      }
    });
    return results.reduce(
      (acc, row) => {
        if (row.failed) {
          acc.failedClans.push(row.clanTag);
          return acc;
        }
        acc.rowCount += row.rowCount;
        acc.changedRowCount += row.changedRowCount;
        return acc;
      },
      {
        clanCount: normalizedClanTags.length,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: [] as string[],
      },
    );
  }

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
    const previous = this.inFlightByClanTag.get(normalizedClanTag) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.syncTrackedClanUnlocked(normalizedClanTag, options));
    this.inFlightByClanTag.set(normalizedClanTag, queued);
    try {
      return await queued;
    } finally {
      if (this.inFlightByClanTag.get(normalizedClanTag) === queued) {
        this.inFlightByClanTag.delete(normalizedClanTag);
      }
    }
  }

  private async syncTrackedClanUnlocked(clanTag: string, options?: SyncOptions): Promise<FwaSyncResult> {
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

    const attemptAccepted = await this.syncState.recordAttempt(scope, nextEligibleAt, now);
    if (!attemptAccepted) {
      return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
    }
    try {
      const rows = await this.client.fetchClanMembers(normalizedClanTag);
      const contentHash = computeClanMembersSnapshotHash(rows.map(toClanMembersSnapshotRow));
      return await prisma.$transaction(async (tx) => {
        await this.syncState.lockScope(scope, tx);
        const currentState = await this.syncState.getState(scope, tx);
        if (!currentState || !isSameSyncAttempt(currentState.lastAttemptAt, now)) {
          throw new SupersededClanMembersSyncError();
        }

        const persistedBefore = await tx.fwaClanMemberCurrent.findMany({
          where: { clanTag: normalizedClanTag },
          select: CLAN_MEMBER_SNAPSHOT_SELECT,
          orderBy: { playerTag: "asc" },
        });
        const persistedBeforeHash = computeClanMembersSnapshotHash(
          persistedBefore.map((row) => toPersistedClanMembersSnapshotRow(row)),
        );
        if (
          currentState.lastContentHash === contentHash &&
          persistedBefore.length === rows.length &&
          persistedBeforeHash === contentHash
        ) {
          const result: FwaSyncResult = {
            rowCount: rows.length,
            changedRowCount: 0,
            contentHash: persistedBeforeHash,
            status: "NOOP",
          };
          await this.syncState.recordSuccess(
            { ...scope, ...result, nextEligibleAt },
            now,
            tx,
          );
          return result;
        }

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
        const persistedAfter = await tx.fwaClanMemberCurrent.findMany({
          where: { clanTag: normalizedClanTag },
          select: CLAN_MEMBER_SNAPSHOT_SELECT,
          orderBy: { playerTag: "asc" },
        });
        const persistedAfterHash = computeClanMembersSnapshotHash(
          persistedAfter.map((row) => toPersistedClanMembersSnapshotRow(row)),
        );
        if (persistedAfter.length !== rows.length || persistedAfterHash !== contentHash) {
          throw new Error("CLAN_MEMBERS persisted snapshot did not match the authoritative feed");
        }
        const result: FwaSyncResult = {
          rowCount: rows.length,
          changedRowCount: staleDelete.count + rows.length,
          contentHash: persistedAfterHash,
          status: "SUCCESS",
        };
        const recorded = await this.syncState.recordSuccess(
          { ...scope, ...result, nextEligibleAt },
          now,
          tx,
          now,
        );
        if (!recorded) {
          throw new SupersededClanMembersSyncError();
        }
        return result;
      });
    } catch (error) {
      if (error instanceof SupersededClanMembersSyncError) {
        return { rowCount: 0, changedRowCount: 0, contentHash: null, status: "SKIPPED" };
      }
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
        now,
      );
      throw error;
    }
  }
}
