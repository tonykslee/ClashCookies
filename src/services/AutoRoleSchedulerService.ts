import { type Client } from "discord.js";
import { AutoRoleRunScope, AutoRoleRunTrigger } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import { type CoCService } from "./CoCService";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  botPollJobStatusService,
  type BotPollJobStatusService,
} from "./BotPollJobStatusService";
import {
  autoRoleRefreshService,
  type AutoRoleRefreshResult,
  type AutoRoleRefreshService,
} from "./AutoRoleRefreshService";

export const DEFAULT_AUTOROLE_SCHEDULER_INTERVAL_MS = 60 * 1000;
export const DEFAULT_AUTOROLE_SYNC_INTERVAL_MINUTES = 60;
const AUTOROLE_SCHEDULER_JOB_KEY = "autorole_scheduler";
const AUTOROLE_SCHEDULER_DISPLAY_NAME = "Autorole scheduler";

export type AutoRoleSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" };

export type AutoRoleSchedulerCounts = {
  scanned: number;
  due: number;
  started: number;
  completed: number;
  skipped: number;
  failed: number;
};

type AutoRoleSchedulerGuildConfigRow = {
  guildId: string;
  syncIntervalMinutes: number | null;
};

type AutoRoleSchedulerGuildRunRow = {
  guildId: string;
  _max: {
    finishedAt: Date | null;
  };
};

type AutoRoleScheduledGuildWork = {
  guildId: string;
  intervalMinutes: number;
  intervalMs: number;
  nextDueAtMs: number;
};

type AutoRoleGuildRunOutcome =
  | { completed: true; failed: false; skipped: false }
  | { completed: false; failed: true; skipped: false }
  | { completed: false; failed: false; skipped: true };

function isFulfilledResult<T>(
  result: PromiseSettledResult<T>,
): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function normalizeIntervalMinutes(input: number | null | undefined): number {
  const value = typeof input === "number" && Number.isFinite(input) ? Math.trunc(input) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_AUTOROLE_SYNC_INTERVAL_MINUTES;
  }
  return value;
}

function normalizeNowMs(input: number | null | undefined): number {
  if (!Number.isFinite(input ?? NaN)) {
    return Date.now();
  }
  return Math.trunc(Number(input));
}

/** Purpose: schedule enabled autorole guild syncs on a bounded interval while reusing refreshGuild. */
export class AutoRoleSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightGuildIds = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly cocService: CoCService | null = null,
    private readonly refreshService: AutoRoleRefreshService = autoRoleRefreshService,
    private readonly intervalMs: number = DEFAULT_AUTOROLE_SCHEDULER_INTERVAL_MS,
    private readonly statusService: BotPollJobStatusService = botPollJobStatusService,
  ) {}

  /** Purpose: start the autorole scheduler loop once in active polling mode. */
  start(): AutoRoleSchedulerStartResult {
    dozzleLog.info(
      `[autorole-scheduler] scheduler_start_requested interval_ms=${this.intervalMs} has_timer=${Boolean(this.timer)}`,
    );

    if (isMirrorPollingMode(process.env)) {
      void this.statusService.markDisabled(AUTOROLE_SCHEDULER_JOB_KEY, {
        displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        metadata: { reason: "mirror" },
      }).catch((err) => {
        dozzleLog.warn(
          `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=disabled error=${formatError(err)}`,
        );
      });
      dozzleLog.info("[polling-mode] event=poller_skipped job=autorole_scheduler mode=mirror");
      return { started: false, reason: "mirror" };
    }

    if (this.timer) {
      dozzleLog.debug(
        `[autorole-scheduler] scheduler_start_skipped reason=already_started interval_ms=${this.intervalMs}`,
      );
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((err) => {
      dozzleLog.error(`[autorole-scheduler] immediate_cycle_failed error=${formatError(err)}`);
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        dozzleLog.error(`[autorole-scheduler] interval_cycle_failed error=${formatError(err)}`);
      });
    }, this.intervalMs);

    dozzleLog.info(`[autorole-scheduler] scheduler_started interval_ms=${this.intervalMs}`);
    return { started: true };
  }

  /** Purpose: stop autorole scheduling for shutdowns and isolated tests. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Purpose: evaluate due autorole guilds and dispatch refreshGuild on the shared refresh path. */
  async runCycle(nowMs: number = Date.now()): Promise<AutoRoleSchedulerCounts> {
    if (isMirrorPollingMode(process.env)) {
      void this.statusService.markDisabled(AUTOROLE_SCHEDULER_JOB_KEY, {
        displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        metadata: { reason: "mirror" },
      }).catch((err) => {
        dozzleLog.warn(
          `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=disabled error=${formatError(err)}`,
        );
      });
      dozzleLog.info("[polling-mode] event=poller_skipped job=autorole_scheduler mode=mirror");
      return {
        scanned: 0,
        due: 0,
        started: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
      };
    }

    const normalizedNowMs = normalizeNowMs(nowMs);
    await this.statusService.markStarted(AUTOROLE_SCHEDULER_JOB_KEY, {
      displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
      intervalMs: this.intervalMs,
      nextDueAt: new Date(normalizedNowMs + this.intervalMs),
    }).catch((err) => {
      dozzleLog.warn(
        `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=started error=${formatError(err)}`,
      );
    });
    try {
      const configs = await prisma.autoRoleGuildConfig.findMany({
        where: {
          enabled: true,
          syncEnabled: true,
          killSwitchEnabled: false,
        },
        select: {
          guildId: true,
          syncIntervalMinutes: true,
        },
        orderBy: [{ guildId: "asc" }],
      });
      const configRows = configs as AutoRoleSchedulerGuildConfigRow[];

      if (configRows.length === 0) {
        dozzleLog.debug("[autorole-scheduler] cycle_complete scanned=0 due=0 started=0 completed=0 skipped=0 failed=0");
        await this.statusService.markSucceeded(AUTOROLE_SCHEDULER_JOB_KEY, {
          displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
          intervalMs: this.intervalMs,
          nextDueAt: new Date(normalizedNowMs + this.intervalMs),
          metadata: {
            scanned: 0,
            due: 0,
            started: 0,
            completed: 0,
            skipped: 0,
            failed: 0,
          },
        }).catch((err) => {
          dozzleLog.warn(
            `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=succeeded error=${formatError(err)}`,
          );
        });
        return {
          scanned: 0,
          due: 0,
          started: 0,
          completed: 0,
          skipped: 0,
          failed: 0,
        };
      }

      const lastCompletedRuns = await prisma.autoRoleSyncRun.groupBy({
        by: ["guildId"],
        where: {
          guildId: { in: configRows.map((row) => row.guildId) },
          scope: AutoRoleRunScope.GUILD,
          trigger: AutoRoleRunTrigger.SCHEDULED,
          status: "COMPLETED",
        },
        _max: {
          finishedAt: true,
        },
      });
      const lastCompletedRunByGuildId = new Map<string, Date>();
      for (const run of lastCompletedRuns as AutoRoleSchedulerGuildRunRow[]) {
        const lastCompletedAt = run._max?.finishedAt ?? null;
        if (lastCompletedAt) {
          lastCompletedRunByGuildId.set(run.guildId, lastCompletedAt);
        }
      }

      const dueWork: AutoRoleScheduledGuildWork[] = [];
      let skipped = 0;
      for (const row of configRows) {
        const intervalMinutes = normalizeIntervalMinutes(row.syncIntervalMinutes);
        const intervalMs = intervalMinutes * 60_000;
        const lastCompletedRunAt = lastCompletedRunByGuildId.get(row.guildId) ?? null;
        const nextDueAtMs = lastCompletedRunAt ? lastCompletedRunAt.getTime() + intervalMs : normalizedNowMs;
        if (lastCompletedRunAt && normalizedNowMs < nextDueAtMs) {
          skipped += 1;
          continue;
        }

        dueWork.push({
          guildId: row.guildId,
          intervalMinutes,
          intervalMs,
          nextDueAtMs,
        });
      }

      const results = await Promise.allSettled(
        dueWork.map((work) => this.runGuildRefresh(work, normalizedNowMs)),
      );
      const fulfilledResults = results.filter(isFulfilledResult);
      const skippedByLock = fulfilledResults.filter((result) => result.value.skipped).length;
      const completed = fulfilledResults.filter((result) => result.value.completed).length;
      const failed = fulfilledResults.filter((result) => result.value.failed).length;
      skipped += skippedByLock;

      dozzleLog.debug(
        `[autorole-scheduler] cycle_complete scanned=${configRows.length} due=${dueWork.length} started=${dueWork.length - skippedByLock} completed=${completed} skipped=${skipped} failed=${failed}`,
      );
      await this.statusService.markSucceeded(AUTOROLE_SCHEDULER_JOB_KEY, {
        displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        nextDueAt: new Date(normalizedNowMs + this.intervalMs),
        metadata: {
          scanned: configRows.length,
          due: dueWork.length,
          started: dueWork.length - skippedByLock,
          completed,
          skipped,
          failed,
        },
      }).catch((err) => {
        dozzleLog.warn(
          `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=succeeded error=${formatError(err)}`,
        );
      });

      return {
        scanned: configRows.length,
        due: dueWork.length,
        started: dueWork.length - skippedByLock,
        completed,
        skipped,
        failed,
      };
    } catch (err) {
      await this.statusService.markFailed(AUTOROLE_SCHEDULER_JOB_KEY, err, {
        displayName: AUTOROLE_SCHEDULER_DISPLAY_NAME,
        intervalMs: this.intervalMs,
        nextDueAt: new Date(normalizedNowMs + this.intervalMs),
      }).catch((statusErr) => {
        dozzleLog.warn(
          `[autorole-scheduler] status_update_failed job_key=${AUTOROLE_SCHEDULER_JOB_KEY} stage=failed error=${formatError(statusErr)}`,
        );
      });
      throw err;
    }
  }

  private async runGuildRefresh(
    work: AutoRoleScheduledGuildWork,
    nowMs: number,
  ): Promise<AutoRoleGuildRunOutcome> {
    const autoroleRefreshId = `autorole_refresh:${work.guildId}:${nowMs}`;
    if (this.inFlightGuildIds.has(work.guildId)) {
      dozzleLog.debug(
        `[autorole-scheduler] guild_run_skipped guild_id=${work.guildId} reason=in_flight interval_minutes=${work.intervalMinutes}`,
      );
      return { completed: false, failed: false, skipped: true };
    }

    this.inFlightGuildIds.add(work.guildId);
    dozzleLog.info(
      `[autorole-scheduler] guild_run_start guild_id=${work.guildId} run_scope=guild run_trigger=scheduled autorole_refresh_id=${autoroleRefreshId} interval_minutes=${work.intervalMinutes} next_due_at=${new Date(work.nextDueAtMs).toISOString()}`,
    );

    try {
      const result = await runWithCoCQueueContext(
        {
          priority: "background",
          source: "autorole_scheduler_guild_refresh",
          scheduledAtMs: work.nextDueAtMs,
          nextScheduledAtMs: work.nextDueAtMs + work.intervalMs,
        },
        async () => {
          const guild = await this.client.guilds.fetch(work.guildId);
          return this.refreshService.refreshGuild({
            guild,
            guildId: work.guildId,
            cocService: this.cocService ?? null,
            now: new Date(nowMs),
            trigger: AutoRoleRunTrigger.SCHEDULED,
            telemetry: {
              refreshId: autoroleRefreshId,
              refreshStartedAtMs: nowMs,
              schedulerSource: "autorole_scheduler",
            },
          });
        },
      );

      this.logGuildCompletion(work.guildId, result);
      return { completed: true, failed: false, skipped: false };
    } catch (err) {
      dozzleLog.error(
        `[autorole-scheduler] guild_run_failed guild_id=${work.guildId} error=${formatError(err)}`,
      );
      return { completed: false, failed: true, skipped: false };
    } finally {
      this.inFlightGuildIds.delete(work.guildId);
    }
  }

  private logGuildCompletion(guildId: string, result: AutoRoleRefreshResult): void {
    dozzleLog.info(
      `[autorole-scheduler] guild_run_complete guild_id=${guildId} run_id=${result.runId} evaluated=${result.evaluatedCount} added=${result.addedCount} removed=${result.removedCount} skipped=${result.skippedCount} failed=${result.failedCount}`,
    );
  }
}
