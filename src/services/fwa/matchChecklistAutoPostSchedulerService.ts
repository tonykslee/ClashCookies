import { type Client } from "discord.js";
import { prisma } from "../../prisma";
import { dozzleLog } from "../../helper/dozzleLogger";
import { formatError } from "../../helper/formatError";
import {
  isMirrorPollingMode,
  resolveRuntimeEnvironment,
} from "../PollingModeService";
import {
  parseSyncTimeMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
} from "../TrackedMessageService";
import { fwaMatchChecklistAutoPostService } from "./matchChecklistAutoPostService";

export const DEFAULT_FWA_MATCH_CHECKLIST_AUTO_POST_INTERVAL_MS = 60 * 1000;
export const FWA_MATCH_CHECKLIST_AUTO_POST_SCHEDULER_JOB_KEY =
  "fwa_match_checklist_auto_post_scheduler";
export const FWA_MATCH_CHECKLIST_AUTO_POST_SCHEDULER_DISPLAY_NAME =
  "FWA match checklist auto-post scheduler";

type ChecklistViewType = "Mail" | "Bases";

export type FwaMatchChecklistAutoPostSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" | "staging" };

export type FwaMatchChecklistAutoPostSchedulerCounts = {
  evaluated: number;
  due: number;
  posted: number;
  skipped: number;
  failed: number;
};

function createZeroCounts(): FwaMatchChecklistAutoPostSchedulerCounts {
  return {
    evaluated: 0,
    due: 0,
    posted: 0,
    skipped: 0,
    failed: 0,
  };
}

function resolveChecklistDueAt(syncEpochSeconds: number, viewType: ChecklistViewType): Date {
  const offsetMs = viewType === "Bases" ? 2 * 60 * 1000 : 60 * 1000;
  return new Date(syncEpochSeconds * 1000 + offsetMs);
}

function resolveChecklistFallbackExpiresAt(syncEpochSeconds: number): Date {
  return new Date(syncEpochSeconds * 1000 + 48 * 60 * 60 * 1000);
}

function isValidFutureExpiry(expiresAt: Date | null | undefined, nowMs: number): boolean {
  return (
    expiresAt instanceof Date &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > nowMs
  );
}

/** Purpose: run the active-mode FWA checklist auto-post loop without owning checklist state. */
export class FwaMatchChecklistAutoPostSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly client: Client,
    private readonly intervalMs: number = DEFAULT_FWA_MATCH_CHECKLIST_AUTO_POST_INTERVAL_MS,
  ) {}

  start(): FwaMatchChecklistAutoPostSchedulerStartResult {
    const pollingMode = isMirrorPollingMode(process.env) ? "mirror" : "active";
    const runtimeEnvironment = resolveRuntimeEnvironment(process.env);
    dozzleLog.info(
      `[fwa match checklist auto-post] scheduler_start_requested interval_ms=${this.intervalMs} has_timer=${Boolean(this.timer)} polling_mode=${pollingMode} runtime=${runtimeEnvironment}`,
    );

    if (isMirrorPollingMode(process.env)) {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_match_checklist_auto_post_scheduler mode=mirror",
      );
      return { started: false, reason: "mirror" };
    }
    if (runtimeEnvironment === "staging") {
      dozzleLog.info(
        "[polling-mode] event=poller_skipped job=fwa_match_checklist_auto_post_scheduler mode=staging",
      );
      return { started: false, reason: "staging" };
    }
    if (this.timer) {
      dozzleLog.debug(
        `[fwa match checklist auto-post] scheduler_start_skipped reason=already_started interval_ms=${this.intervalMs}`,
      );
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((err) => {
      dozzleLog.error(
        `[fwa match checklist auto-post] immediate_cycle_failed error=${formatError(err)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((err) => {
        dozzleLog.error(
          `[fwa match checklist auto-post] interval_cycle_failed error=${formatError(err)}`,
        );
      });
    }, this.intervalMs);

    dozzleLog.info(
      `[fwa match checklist auto-post] scheduler_started interval_ms=${this.intervalMs}`,
    );
    return { started: true };
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(nowMs: number = Date.now()): Promise<FwaMatchChecklistAutoPostSchedulerCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[fwa match checklist auto-post] cycle_skipped reason=in_flight");
      return createZeroCounts();
    }
    if (isMirrorPollingMode(process.env) || resolveRuntimeEnvironment(process.env) === "staging") {
      dozzleLog.debug(
        `[fwa match checklist auto-post] cycle_skipped reason=${isMirrorPollingMode(process.env) ? "mirror" : "staging"}`,
      );
      return createZeroCounts();
    }

    this.inFlight = true;
    try {
      const syncPosts = await prisma.trackedMessage.findMany({
        where: {
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST as any,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          referenceId: null,
          expiresAt: {
            gt: new Date(nowMs),
          },
        },
        orderBy: [{ createdAt: "asc" }],
        select: {
          guildId: true,
          channelId: true,
          messageId: true,
          expiresAt: true,
          metadata: true,
          createdAt: true,
        },
      });

      let evaluated = 0;
      let due = 0;
      let posted = 0;
      let skipped = 0;
      let failed = 0;

      for (const tracked of syncPosts) {
        if (!isValidFutureExpiry(tracked.expiresAt, nowMs)) {
          const expiresAtText =
            tracked.expiresAt instanceof Date && Number.isFinite(tracked.expiresAt.getTime())
              ? tracked.expiresAt.toISOString()
              : "missing";
          skipped += 1;
          dozzleLog.info(
            `[fwa match checklist auto-post] event=skipped_expired_or_outside_window guild=${tracked.guildId} sync_message=${tracked.messageId} expires_at=${expiresAtText} now=${new Date(nowMs).toISOString()}`,
          );
          continue;
        }
        const metadata = parseSyncTimeMetadata(tracked.metadata);
        if (!metadata) {
          skipped += 1;
          dozzleLog.warn(
            `[fwa match checklist auto-post] event=skipped_invalid_sync_metadata guild=${tracked.guildId} sync_message=${tracked.messageId}`,
          );
          continue;
        }
        evaluated += 1;

        for (const viewType of ["Mail", "Bases"] as const) {
          const dueAt = resolveChecklistDueAt(metadata.syncEpochSeconds, viewType);
          if (nowMs < dueAt.getTime()) continue;
          const fallbackExpiresAt = resolveChecklistFallbackExpiresAt(metadata.syncEpochSeconds);

          due += 1;
          dozzleLog.info(
            `[fwa match checklist auto-post] event=checklist_scheduled_due guild=${tracked.guildId} sync_message=${tracked.messageId} kind=${viewType.toLowerCase()} due_at=${dueAt.toISOString()} sync_epoch_seconds=${metadata.syncEpochSeconds}`,
          );

          const result = await fwaMatchChecklistAutoPostService
            .postForSyncTrackedMessage({
              client: this.client,
              tracked: {
                guildId: tracked.guildId,
                channelId: tracked.channelId,
                messageId: tracked.messageId,
                expiresAt: tracked.expiresAt ?? null,
                fallbackExpiresAt,
              },
              createdByUserId: "system",
              viewType,
            })
            .catch((err) => {
              failed += 1;
              dozzleLog.error(
                `[fwa match checklist auto-post] event=post_cycle_failed guild=${tracked.guildId} sync_message=${tracked.messageId} kind=${viewType.toLowerCase()} error=${formatError(err)}`,
              );
              return null;
            });
          if (!result) continue;
          posted += result.posted;
          skipped += result.skipped;
          failed += result.failed;
        }
      }

      dozzleLog.debug(
        `[fwa match checklist auto-post] cycle_complete evaluated=${evaluated} due=${due} posted=${posted} skipped=${skipped} failed=${failed}`,
      );
      return { evaluated, due, posted, skipped, failed };
    } catch (err) {
      dozzleLog.error(
        `[fwa match checklist auto-post] cycle_failed error=${formatError(err)}`,
      );
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}
