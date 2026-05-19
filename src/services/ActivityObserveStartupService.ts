import { formatError } from "../helper/formatError";
import { isCoCQueueSkippedError } from "./CoCRequestQueueService";
import {
  botPollJobStatusService,
  type BotPollJobStatusService,
} from "./BotPollJobStatusService";

export type ActivityObserveLoopStartArgs = {
  activePollingEnabled: boolean;
  intervalMinutes: number;
  intervalMs: number;
  initialObserveDelayMs: number;
  runObservedCycle: (scheduledAtMs?: number) => Promise<void>;
  statusService?: BotPollJobStatusService;
};

export type ActivityObserveLoopStartResult = {
  started: boolean;
};

const ACTIVITY_OBSERVE_JOB_KEY = "activity_observe_cycle";
const ACTIVITY_OBSERVE_DISPLAY_NAME = "Activity observe";

function scheduleObservedCycle(
  runObservedCycle: (scheduledAtMs?: number) => Promise<void>,
  statusService: BotPollJobStatusService,
  intervalMs: number,
  trigger: "startup" | "scheduled" | "delayed",
): void {
  const startedAtMs = Date.now();
  const nextDueAt = new Date(startedAtMs + intervalMs);
  void (async () => {
    await statusService.markStarted(ACTIVITY_OBSERVE_JOB_KEY, {
      displayName: ACTIVITY_OBSERVE_DISPLAY_NAME,
      intervalMs,
      nextDueAt,
      metadata: {
        trigger,
      },
    }).catch((err) => {
      console.warn(
        `[activity-observe] status_update_failed job_key=${ACTIVITY_OBSERVE_JOB_KEY} stage=started error=${formatError(err)}`,
      );
    });

    try {
      await runObservedCycle(startedAtMs);
      await statusService.markSucceeded(ACTIVITY_OBSERVE_JOB_KEY, {
        displayName: ACTIVITY_OBSERVE_DISPLAY_NAME,
        intervalMs,
        nextDueAt,
        metadata: {
          trigger,
        },
      }).catch((err) => {
        console.warn(
          `[activity-observe] status_update_failed job_key=${ACTIVITY_OBSERVE_JOB_KEY} stage=succeeded error=${formatError(err)}`,
        );
      });
    } catch (err) {
      if (isCoCQueueSkippedError(err)) {
        console.warn(`[activity-observe] ${trigger}_run_skipped reason=${err.message}`);
        await statusService.markSkipped(ACTIVITY_OBSERVE_JOB_KEY, {
          displayName: ACTIVITY_OBSERVE_DISPLAY_NAME,
          intervalMs,
          nextDueAt,
          metadata: {
            trigger,
            reason: err.message,
          },
        }).catch((statusErr) => {
          console.warn(
            `[activity-observe] status_update_failed job_key=${ACTIVITY_OBSERVE_JOB_KEY} stage=skipped error=${formatError(statusErr)}`,
          );
        });
        return;
      }

      console.error(`observeTrackedClans ${trigger} run failed: ${formatError(err)}`);
      await statusService.markFailed(ACTIVITY_OBSERVE_JOB_KEY, err, {
        displayName: ACTIVITY_OBSERVE_DISPLAY_NAME,
        intervalMs,
        nextDueAt,
        metadata: {
          trigger,
        },
      }).catch((statusErr) => {
        console.warn(
          `[activity-observe] status_update_failed job_key=${ACTIVITY_OBSERVE_JOB_KEY} stage=failed error=${formatError(statusErr)}`,
        );
      });
    }
  })().catch((err) => {
    console.error(
      `observeTrackedClans ${trigger} status wrapper failed: ${formatError(err)}`,
    );
  });
}

export function startActivityObserveLoop(
  args: ActivityObserveLoopStartArgs,
): ActivityObserveLoopStartResult {
  const statusService = args.statusService ?? botPollJobStatusService;
  if (!args.activePollingEnabled) {
    void statusService.markDisabled(ACTIVITY_OBSERVE_JOB_KEY, {
      displayName: ACTIVITY_OBSERVE_DISPLAY_NAME,
      intervalMs: args.intervalMs,
      metadata: { reason: "mirror" },
    }).catch((err) => {
      console.warn(
        `[activity-observe] status_update_failed job_key=${ACTIVITY_OBSERVE_JOB_KEY} stage=disabled error=${formatError(err)}`,
      );
    });
    console.log("[polling-mode] event=poller_skipped job=activity_observe_cycle mode=mirror");
    return { started: false };
  }

  const registerInterval = (): void => {
    setInterval(() => {
      scheduleObservedCycle(args.runObservedCycle, statusService, args.intervalMs, "scheduled");
    }, args.intervalMs);
  };

  if (args.initialObserveDelayMs === 0) {
    registerInterval();
    scheduleObservedCycle(args.runObservedCycle, statusService, args.intervalMs, "startup");
  } else {
    const initialObserveDelayMin = Math.ceil(args.initialObserveDelayMs / 60000);
    console.log(
      `Skipping startup activity observe run; next run in ${initialObserveDelayMin} minute(s).`,
    );
    setTimeout(() => {
      scheduleObservedCycle(args.runObservedCycle, statusService, args.intervalMs, "delayed");
      registerInterval();
    }, args.initialObserveDelayMs);
  }

  console.log(`Activity observe loop enabled (every ${args.intervalMinutes} minute(s)).`);
  return { started: true };
}
