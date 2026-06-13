import { Prisma, type ScheduledSyncPost } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";

export const SCHEDULED_SYNC_POST_STATUS = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  PUBLISHED: "PUBLISHED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  REPLACED: "REPLACED",
} as const;

export type ScheduledSyncPostStatus =
  (typeof SCHEDULED_SYNC_POST_STATUS)[keyof typeof SCHEDULED_SYNC_POST_STATUS];

export type ScheduledSyncPostAction = "created" | "reused" | "replaced";

export type ScheduledSyncPostScheduleResult = {
  schedule: ScheduledSyncPost;
  action: ScheduledSyncPostAction;
};

export type ScheduledSyncPostClaimResult = {
  claimed: boolean;
  claimToken: string | null;
  reason: "claimed" | "stale_recovered" | "not_due" | "busy" | "terminal";
  schedule: ScheduledSyncPostRow | null;
};

export type ScheduledSyncPostPublishRetryResult = {
  retryable: boolean;
  nextAttemptAt: Date | null;
};

export type ScheduledSyncPostRow = ScheduledSyncPost;

const SCHEDULED_SYNC_POST_STALE_CLAIM_MS = 5 * 60 * 1000;
const SCHEDULED_SYNC_POST_RETRY_BACKOFF_MS = 60 * 1000;

function normalizeString(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

function isTerminalStatus(status: ScheduledSyncPostStatus): boolean {
  return (
    status === SCHEDULED_SYNC_POST_STATUS.PUBLISHED ||
    status === SCHEDULED_SYNC_POST_STATUS.FAILED ||
    status === SCHEDULED_SYNC_POST_STATUS.CANCELLED ||
    status === SCHEDULED_SYNC_POST_STATUS.REPLACED
  );
}

function isDueForPublish(row: ScheduledSyncPostRow, now: Date): boolean {
  if (row.publishAt.getTime() > now.getTime()) return false;
  if (row.syncTime.getTime() <= now.getTime()) return false;
  if (row.status === SCHEDULED_SYNC_POST_STATUS.PENDING) {
    return !row.nextAttemptAt || row.nextAttemptAt.getTime() <= now.getTime();
  }
  if (row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED) {
    const claimedAt = row.claimedAt?.getTime() ?? 0;
    return claimedAt > 0 && now.getTime() - claimedAt >= SCHEDULED_SYNC_POST_STALE_CLAIM_MS;
  }
  return false;
}

/** Purpose: own durable scheduled sync-time post rows and the atomic guild-scoped replacement lifecycle. */
export class ScheduledSyncPostService {
  /** Purpose: persist or reuse one scheduled sync post per guild+syncTime under a guild-scoped DB lock. */
  async scheduleSyncTimePost(input: {
    guildId: string;
    channelId: string;
    createdByUserId: string;
    roleId: string;
    syncTime: Date;
    publishAt: Date;
    timezone?: string | null;
  }): Promise<ScheduledSyncPostScheduleResult> {
    const guildId = normalizeString(input.guildId);
    const channelId = normalizeString(input.channelId);
    const createdByUserId = normalizeString(input.createdByUserId);
    const roleId = normalizeString(input.roleId);
    const timezone = normalizeString(input.timezone ?? null) || null;
    const syncTime = new Date(input.syncTime);
    const publishAt = new Date(input.publishAt);
    if (!guildId || !channelId || !createdByUserId || !roleId) {
      throw new Error("Missing required sync schedule fields.");
    }

    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${guildId})::bigint)
      `);

      const existing = await tx.scheduledSyncPost.findUnique({
        where: {
          guildId_syncTime: {
            guildId,
            syncTime,
          },
        },
      });
      if (existing) {
        console.info(
          `[sync-schedule] schedule_reused schedule_id=${existing.id} guild_id=${guildId} channel_id=${existing.channelId} sync_epoch=${Math.floor(syncTime.getTime() / 1000)} publish_epoch=${Math.floor(publishAt.getTime() / 1000)} status=${existing.status}`,
        );
        return { schedule: existing, action: "reused" };
      }

      const priorPending = await tx.scheduledSyncPost.findMany({
        where: {
          guildId,
          status: SCHEDULED_SYNC_POST_STATUS.PENDING as any,
        },
        orderBy: [{ createdAt: "asc" }],
      });

      if (priorPending.length > 0) {
        await tx.scheduledSyncPost.updateMany({
          where: {
            id: { in: priorPending.map((row) => row.id) },
            status: SCHEDULED_SYNC_POST_STATUS.PENDING as any,
          },
          data: {
            status: SCHEDULED_SYNC_POST_STATUS.REPLACED as any,
            failureReason: "replaced_by_new_schedule",
            failureCode: "replaced",
            claimToken: null,
            claimedAt: null,
            publishedMessageId: null,
            publishedAt: null,
            nextAttemptAt: null,
          },
        });
      }

      const schedule = await tx.scheduledSyncPost.create({
        data: {
          guildId,
          channelId,
          createdByUserId,
          roleId,
          syncTime,
          publishAt,
          timezone,
          status: SCHEDULED_SYNC_POST_STATUS.PENDING as any,
        },
      });

      console.info(
        `[sync-schedule] schedule_created schedule_id=${schedule.id} guild_id=${guildId} channel_id=${channelId} sync_epoch=${Math.floor(syncTime.getTime() / 1000)} publish_epoch=${Math.floor(publishAt.getTime() / 1000)} role_id=${roleId} replaced_count=${priorPending.length}`,
      );

      return {
        schedule,
        action: priorPending.length > 0 ? "replaced" : "created",
      };
    });
  }

  /** Purpose: fetch sync posts due for publication in publish order. */
  async findDueScheduledSyncPosts(now: Date): Promise<ScheduledSyncPostRow[]> {
    const rows = await prisma.scheduledSyncPost.findMany({
      where: {
        status: {
          in: [SCHEDULED_SYNC_POST_STATUS.PENDING, SCHEDULED_SYNC_POST_STATUS.CLAIMED] as any,
        },
        publishAt: { lte: now },
        syncTime: { gt: now },
      },
      orderBy: [{ publishAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.filter((row) => isDueForPublish(row, now));
  }

  /** Purpose: fetch sync posts that expired before they could be published. */
  async findExpiredScheduledSyncPosts(now: Date): Promise<ScheduledSyncPostRow[]> {
    return prisma.scheduledSyncPost.findMany({
      where: {
        status: {
          in: [SCHEDULED_SYNC_POST_STATUS.PENDING, SCHEDULED_SYNC_POST_STATUS.CLAIMED] as any,
        },
        publishAt: { lte: now },
        syncTime: { lte: now },
      },
      orderBy: [{ publishAt: "asc" }, { createdAt: "asc" }],
    });
  }

  /** Purpose: claim one due sync post with a unique token, or detect stale/retryable states. */
  async tryClaimScheduledSyncPost(input: {
    schedule: ScheduledSyncPostRow;
    now: Date;
  }): Promise<ScheduledSyncPostClaimResult> {
    const row = input.schedule;
    const now = new Date(input.now);
    const claimToken = randomUUID();
    const staleCutoff = new Date(now.getTime() - SCHEDULED_SYNC_POST_STALE_CLAIM_MS);

    const shouldClaimPending =
      row.status === SCHEDULED_SYNC_POST_STATUS.PENDING &&
      row.publishAt.getTime() <= now.getTime() &&
      row.syncTime.getTime() > now.getTime() &&
      (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= now.getTime());
    const shouldClaimStaleClaimed =
      row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED &&
      row.publishAt.getTime() <= now.getTime() &&
      row.syncTime.getTime() > now.getTime() &&
      row.claimedAt !== null &&
      row.claimedAt.getTime() <= staleCutoff.getTime();

    if (!shouldClaimPending && !shouldClaimStaleClaimed) {
      return {
        claimed: false,
        claimToken: null,
        reason:
          row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED
            ? "busy"
            : isTerminalStatus(row.status)
              ? "terminal"
              : "not_due",
        schedule: null,
      };
    }

    const claimResult = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: row.id,
        status:
          row.status === SCHEDULED_SYNC_POST_STATUS.PENDING
            ? (SCHEDULED_SYNC_POST_STATUS.PENDING as any)
            : (SCHEDULED_SYNC_POST_STATUS.CLAIMED as any),
        ...(row.status === SCHEDULED_SYNC_POST_STATUS.PENDING
          ? {
              OR: [
                { nextAttemptAt: null },
                { nextAttemptAt: { lte: now } },
              ],
            }
          : {
              claimedAt: { lte: staleCutoff },
            }),
      } as any,
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED as any,
        claimToken,
        claimedAt: now,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
        failureReason: null,
        failureCode: null,
        nextAttemptAt: null,
      },
    });

    if (claimResult.count !== 1) {
      return {
        claimed: false,
        claimToken: null,
        reason: row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED ? "busy" : "not_due",
        schedule: null,
      };
    }

    const claimed = await prisma.scheduledSyncPost.findUnique({
      where: { id: row.id },
    });
    if (!claimed) {
      return {
        claimed: false,
        claimToken: null,
        reason: "not_due",
        schedule: null,
      };
    }

    console.info(
      `[sync-schedule] claim_acquired schedule_id=${claimed.id} guild_id=${claimed.guildId} channel_id=${claimed.channelId} sync_epoch=${Math.floor(claimed.syncTime.getTime() / 1000)} publish_epoch=${Math.floor(claimed.publishAt.getTime() / 1000)} attempt=${claimed.attemptCount} claim_token=${claimToken} reason=${row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED ? "stale_recovered" : "claimed"}`,
    );

    return {
      claimed: true,
      claimToken,
      reason: row.status === SCHEDULED_SYNC_POST_STATUS.CLAIMED ? "stale_recovered" : "claimed",
      schedule: claimed,
    };
  }

  /** Purpose: record that a claimed schedule should retry later without duplicating a Discord post. */
  async markRetryScheduled(input: {
    scheduleId: string;
    claimToken: string;
    now: Date;
    failureReason: string;
    failureCode: string;
    retryAfterMs: number;
  }): Promise<ScheduledSyncPostRow | null> {
    const nextAttemptAt = new Date(input.now.getTime() + Math.max(1, Math.trunc(input.retryAfterMs)));
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: input.scheduleId,
        claimToken: input.claimToken,
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED as any,
      },
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.PENDING as any,
        claimToken: null,
        claimedAt: null,
        nextAttemptAt,
        failureReason: input.failureReason,
        failureCode: input.failureCode,
      },
    });
    if (result.count !== 1) return null;
    return prisma.scheduledSyncPost.findUnique({ where: { id: input.scheduleId } });
  }

  /** Purpose: record a terminal schedule failure without deleting the durable row. */
  async markFailed(input: {
    scheduleId: string;
    claimToken: string | null;
    failureReason: string;
    failureCode: string;
    now: Date;
  }): Promise<ScheduledSyncPostRow | null> {
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: input.scheduleId,
        ...(input.claimToken ? { claimToken: input.claimToken } : {}),
      },
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.FAILED as any,
        claimToken: null,
        claimedAt: null,
        publishedMessageId: null,
        publishedAt: null,
        nextAttemptAt: null,
        failureReason: input.failureReason,
        failureCode: input.failureCode,
      },
    });
    if (result.count !== 1) return null;
    return prisma.scheduledSyncPost.findUnique({ where: { id: input.scheduleId } });
  }

  /** Purpose: persist the Discord message id immediately after send so retries can resume finalization. */
  async markPublishedMessageId(input: {
    scheduleId: string;
    claimToken: string;
    messageId: string;
  }): Promise<ScheduledSyncPostRow | null> {
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: input.scheduleId,
        claimToken: input.claimToken,
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED as any,
      },
      data: {
        publishedMessageId: input.messageId,
      },
    });
    if (result.count !== 1) return null;
    return prisma.scheduledSyncPost.findUnique({ where: { id: input.scheduleId } });
  }

  /** Purpose: mark a schedule fully published only after tracked-message registration succeeds. */
  async markPublished(input: {
    scheduleId: string;
    claimToken: string;
    now: Date;
  }): Promise<ScheduledSyncPostRow | null> {
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: input.scheduleId,
        claimToken: input.claimToken,
        status: SCHEDULED_SYNC_POST_STATUS.CLAIMED as any,
      },
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.PUBLISHED as any,
        claimToken: null,
        claimedAt: null,
        publishedAt: input.now,
        nextAttemptAt: null,
        failureReason: null,
        failureCode: null,
      },
    });
    if (result.count !== 1) return null;
    return prisma.scheduledSyncPost.findUnique({ where: { id: input.scheduleId } });
  }

  /** Purpose: mark a schedule as replaced by a later request without touching published sync-time messages. */
  async markReplacedSchedules(input: {
    guildId: string;
    keepSyncTime: Date;
  }): Promise<number> {
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        guildId: normalizeString(input.guildId),
        syncTime: { not: input.keepSyncTime },
        status: SCHEDULED_SYNC_POST_STATUS.PENDING as any,
      },
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.REPLACED as any,
        failureReason: "replaced_by_new_schedule",
        failureCode: "replaced",
        claimToken: null,
        claimedAt: null,
        publishedMessageId: null,
        publishedAt: null,
        nextAttemptAt: null,
      },
    });
    return result.count;
  }

  /** Purpose: mark overdue pending/claimed rows as expired once their sync time has passed. */
  async markExpired(input: {
    scheduleId: string;
    now: Date;
  }): Promise<ScheduledSyncPostRow | null> {
    const result = await prisma.scheduledSyncPost.updateMany({
      where: {
        id: input.scheduleId,
        status: {
          in: [SCHEDULED_SYNC_POST_STATUS.PENDING, SCHEDULED_SYNC_POST_STATUS.CLAIMED] as any,
        },
      },
      data: {
        status: SCHEDULED_SYNC_POST_STATUS.FAILED as any,
        claimToken: null,
        claimedAt: null,
        publishedMessageId: null,
        publishedAt: null,
        nextAttemptAt: null,
        failureReason: "sync_time_passed",
        failureCode: "sync_time_passed",
      },
    });
    if (result.count !== 1) return null;
    return prisma.scheduledSyncPost.findUnique({ where: { id: input.scheduleId } });
  }
}

export const scheduledSyncPostService = new ScheduledSyncPostService();
