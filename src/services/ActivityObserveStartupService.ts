import { formatError } from "../helper/formatError";
import { isCoCQueueSkippedError } from "./CoCRequestQueueService";

export type ActivityObserveLoopStartArgs = {
  activePollingEnabled: boolean;
  intervalMinutes: number;
  intervalMs: number;
  initialObserveDelayMs: number;
  runObservedCycle: (scheduledAtMs?: number) => Promise<void>;
};

export type ActivityObserveLoopStartResult = {
  started: boolean;
};

function scheduleObservedCycle(
  runObservedCycle: (scheduledAtMs?: number) => Promise<void>,
  trigger: "startup" | "scheduled" | "delayed",
): void {
  void runObservedCycle(Date.now()).catch((err) => {
    if (isCoCQueueSkippedError(err)) {
      console.warn(`[activity-observe] ${trigger}_run_skipped reason=${err.message}`);
      return;
    }
    console.error(`observeTrackedClans ${trigger} run failed: ${formatError(err)}`);
  });
}

export function startActivityObserveLoop(
  args: ActivityObserveLoopStartArgs,
): ActivityObserveLoopStartResult {
  if (!args.activePollingEnabled) {
    console.log("[polling-mode] event=poller_skipped job=activity_observe_cycle mode=mirror");
    return { started: false };
  }

  const registerInterval = (): void => {
    setInterval(() => {
      scheduleObservedCycle(args.runObservedCycle, "scheduled");
    }, args.intervalMs);
  };

  if (args.initialObserveDelayMs === 0) {
    registerInterval();
    scheduleObservedCycle(args.runObservedCycle, "startup");
  } else {
    const initialObserveDelayMin = Math.ceil(args.initialObserveDelayMs / 60000);
    console.log(
      `Skipping startup activity observe run; next run in ${initialObserveDelayMin} minute(s).`,
    );
    setTimeout(() => {
      scheduleObservedCycle(args.runObservedCycle, "delayed");
      registerInterval();
    }, args.initialObserveDelayMs);
  }

  console.log(`Activity observe loop enabled (every ${args.intervalMinutes} minute(s)).`);
  return { started: true };
}
