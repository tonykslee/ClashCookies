import { type Client } from "discord.js";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  botPollJobStatusService,
  type BotPollJobStatusService,
} from "./BotPollJobStatusService";
import {
  scheduledSyncPostService,
} from "./ScheduledSyncPostService";
import {
  scheduledSyncReadinessPublisherService,
  type SyncTimePostChannelLike,
  SyncTimePostPublishError,
} from "./SyncTimePostPublisherService";

export const DEFAULT_SCHEDULED_SYNC_POST_INTERVAL_MS = 15 * 1000;
export const SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY = "scheduled_sync_post_scheduler";
export const SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME = "Scheduled readiness post scheduler";
const MAX_PUBLISH_ATTEMPTS = 5;

export type ScheduledSyncPostSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" };

export type ScheduledSyncPostSchedulerCounts = {
  scanned: number;
  due: number;
  claimed: number;
  published: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
};

function zeroCounts(): ScheduledSyncPostSchedulerCounts {
  return {
    scanned: 0,
    due: 0,
    claimed: 0,
    published: 0,
    retried: 0,
    expired: 0,
    failed: 0,
    skipped: 0,
  };
}

function isSupportedSyncTimePostChannel(
  channel: SyncTimePostChannelLike | null | undefined,
): channel is SyncTimePostChannelLike {
  if (!channel) return false;
  if (typeof channel.isTextBased !== "function" || !channel.isTextBased()) return false;
  if (typeof channel.permissionsFor !== "function") return false;
  if (!("messages" in channel) || !("send" in channel)) return false;
  return true;
}

function computeRetryAfterMs(attemptCount: number): number {
  const base = 60_000;
  const backoff = base * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(backoff, 5 * 60_000);
}

/** Purpose: poll durable scheduled readiness rows and publish them exactly once in active mode. */
export class ScheduledSyncPostSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly client: Client,
    private readonly intervalMs: number = DEFAULT_SCHEDULED_SYNC_POST_INTERVAL_MS,
    private readonly statusService: BotPollJobStatusService = botPollJobStatusService,
  ) {}

  start(): ScheduledSyncPostSchedulerStartResult {
    dozzleLog.info(
      `[scheduled-readiness-post] scheduler_start_requested interval_ms=${this.intervalMs} has_timer=${Boolean(this.timer)}`,
    );

    if (isMirrorPollingMode(process.env)) {
      void this.statusService.markDisabled(SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY, {
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        metadata: { reason: "mirror" },
      }).catch((err) => {
        dozzleLog.warn(
          `[scheduled-readiness-post] status_update_failed job_key=${SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY} stage=disabled error=${formatError(err)}`,
        );
      });
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=scheduled_sync_post_scheduler mode=mirror",
      );
      return { started: false, reason: "mirror" };
    }

    if (this.timer) {
      dozzleLog.debug(
        `[scheduled-readiness-post] scheduler_start_skipped reason=already_started interval_ms=${this.intervalMs}`,
      );
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((err) => {
      dozzleLog.error(`[scheduled-readiness-post] immediate_cycle_failed error=${formatError(err)}`);
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        dozzleLog.error(`[scheduled-readiness-post] interval_cycle_failed error=${formatError(err)}`);
      });
    }, this.intervalMs);

    dozzleLog.info(`[scheduled-readiness-post] scheduler_started interval_ms=${this.intervalMs}`);
    return { started: true };
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(nowMs: number = Date.now()): Promise<ScheduledSyncPostSchedulerCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[scheduled-readiness-post] cycle_skipped reason=in_flight");
      return zeroCounts();
    }
    if (isMirrorPollingMode(process.env)) {
      void this.statusService.markDisabled(SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY, {
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        metadata: { reason: "mirror" },
      }).catch((err) => {
        dozzleLog.warn(
          `[scheduled-readiness-post] status_update_failed job_key=${SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY} stage=disabled error=${formatError(err)}`,
        );
      });
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=scheduled_sync_post_scheduler mode=mirror",
      );
      return zeroCounts();
    }

    this.inFlight = true;
    const now = new Date(nowMs);
    try {
      await this.statusService.markStarted(SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY, {
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        nextDueAt: new Date(nowMs + this.intervalMs),
      }).catch((err) => {
        dozzleLog.warn(
          `[scheduled-readiness-post] status_update_failed job_key=${SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY} stage=started error=${formatError(err)}`,
        );
      });

      const expiredRows = await scheduledSyncPostService.findExpiredScheduledSyncPosts(now);
      let scanned = expiredRows.length;
      let due = 0;
      let claimed = 0;
      let published = 0;
      let retried = 0;
      let expired = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of expiredRows) {
        const result = await scheduledSyncPostService.markExpired({
          scheduleId: row.id,
          now,
        });
        if (!result) {
          skipped += 1;
          continue;
        }
        expired += 1;
        dozzleLog.info(
          `[scheduled-readiness-post] expired schedule_id=${row.id} guild_id=${row.guildId} sync_epoch=${Math.floor(row.syncTime.getTime() / 1000)} publish_epoch=${Math.floor(row.publishAt.getTime() / 1000)}`,
        );
      }

      const dueRows = await scheduledSyncPostService.findDueScheduledSyncPosts(now);
      scanned += dueRows.length;
      due = dueRows.length;

      for (const row of dueRows) {
        const claim = await scheduledSyncPostService.tryClaimScheduledSyncPost({
          schedule: row,
          now,
        });
        if (!claim.claimed || !claim.schedule || !claim.claimToken) {
          skipped += 1;
          continue;
        }

        claimed += 1;
        const claimedSchedule = claim.schedule;
        dozzleLog.info(
          `[scheduled-readiness-post] claimed schedule_id=${claimedSchedule.id} guild_id=${claimedSchedule.guildId} attempt=${claimedSchedule.attemptCount} claim_reason=${claim.reason}`,
        );

        const guild = await this.client.guilds.fetch(claimedSchedule.guildId).catch(() => null);
        if (!guild) {
          failed += 1;
          dozzleLog.warn(
            `[scheduled-readiness-post] publish_failed schedule_id=${claimedSchedule.id} guild_id=${claimedSchedule.guildId} reason=missing_guild`,
          );
          await scheduledSyncPostService.markFailed({
            scheduleId: claimedSchedule.id,
            claimToken: claim.claimToken,
            failureReason: "guild missing at publish time",
            failureCode: "missing_guild",
            now,
          });
          continue;
        }

        const channel = (await guild.channels.fetch(claimedSchedule.channelId).catch(() => null)) as
          | SyncTimePostChannelLike
          | null;
        if (!isSupportedSyncTimePostChannel(channel)) {
          failed += 1;
          dozzleLog.warn(
            `[scheduled-readiness-post] publish_failed schedule_id=${claimedSchedule.id} guild_id=${claimedSchedule.guildId} channel_id=${claimedSchedule.channelId} reason=missing_channel`,
          );
          await scheduledSyncPostService.markFailed({
            scheduleId: claimedSchedule.id,
            claimToken: claim.claimToken,
            failureReason: "sync channel missing or unavailable at publish time",
            failureCode: "missing_channel",
            now,
          });
          continue;
        }

        try {
          const result = await scheduledSyncReadinessPublisherService.publishScheduledSyncReadinessPost({
            guild,
            channel,
            schedule: claimedSchedule,
            claimToken: claim.claimToken,
            publicationMode: "scheduled",
            now,
            scheduleService: scheduledSyncPostService,
          });
          published += 1;
          dozzleLog.info(
            `[scheduled-readiness-post] published schedule_id=${claimedSchedule.id} guild_id=${claimedSchedule.guildId} channel_id=${result.channelId} message_id=${result.messageId} tracked_clan_count=${result.trackedClanCount} publication_mode=${result.publicationMode} used_fallback_render=${result.usedFallbackRender}`,
          );
        } catch (err) {
          const isPublishError = err instanceof SyncTimePostPublishError;
          const retryable = isPublishError ? err.retryable : true;
          const code = isPublishError ? err.code : "publish_failed";
          const message = formatError(err);
          dozzleLog.error(
            `[scheduled-readiness-post] publish_error schedule_id=${claimedSchedule.id} guild_id=${claimedSchedule.guildId} code=${code} retryable=${retryable} error=${message}`,
          );

          if (now.getTime() >= claimedSchedule.syncTime.getTime() || !retryable) {
            failed += 1;
            await scheduledSyncPostService.markFailed({
              scheduleId: claimedSchedule.id,
              claimToken: claim.claimToken,
              failureReason: message,
              failureCode: code,
              now,
            });
            continue;
          }

          const attemptCount = claimedSchedule.attemptCount ?? 1;
          if (attemptCount >= MAX_PUBLISH_ATTEMPTS) {
            failed += 1;
            await scheduledSyncPostService.markFailed({
              scheduleId: claimedSchedule.id,
              claimToken: claim.claimToken,
              failureReason: message,
              failureCode: "retry_exhausted",
              now,
            });
            continue;
          }

          retried += 1;
          const retryAfterMs = computeRetryAfterMs(attemptCount);
          await scheduledSyncPostService.markRetryScheduled({
            scheduleId: claimedSchedule.id,
            claimToken: claim.claimToken,
            now,
            failureReason: message,
            failureCode: code,
            retryAfterMs,
          });
        }
      }

      dozzleLog.debug(
        `[scheduled-readiness-post] cycle_complete scanned=${scanned} due=${due} claimed=${claimed} published=${published} retried=${retried} expired=${expired} failed=${failed} skipped=${skipped}`,
      );
      await this.statusService.markSucceeded(SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY, {
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        nextDueAt: new Date(nowMs + this.intervalMs),
        metadata: {
          scanned,
          due,
          claimed,
          published,
          retried,
          expired,
          failed,
          skipped,
        },
      }).catch((err) => {
        dozzleLog.warn(
          `[scheduled-readiness-post] status_update_failed job_key=${SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY} stage=succeeded error=${formatError(err)}`,
        );
      });
      return { scanned, due, claimed, published, retried, expired, failed, skipped };
    } catch (err) {
      dozzleLog.error(`[scheduled-readiness-post] cycle_failed error=${formatError(err)}`);
      await this.statusService.markFailed(SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY, err, {
        displayName: SCHEDULED_SYNC_POST_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        nextDueAt: new Date(nowMs + this.intervalMs),
      }).catch((statusErr) => {
        dozzleLog.warn(
          `[scheduled-readiness-post] status_update_failed job_key=${SCHEDULED_SYNC_POST_SCHEDULER_JOB_KEY} stage=failed error=${formatError(statusErr)}`,
        );
      });
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}
