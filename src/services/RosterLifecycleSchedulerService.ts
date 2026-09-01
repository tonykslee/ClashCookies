import { type Client } from "discord.js";
import { dozzleLog } from "../helper/dozzleLogger";
import { formatError } from "../helper/formatError";
import {
  isActivePollingMode,
  resolveRuntimeEnvironment,
} from "./PollingModeService";
import {
  rosterService,
  type RosterDueClosureResult,
  type RosterPostedMessageRefreshResult,
  type RosterService,
} from "./RosterService";

export const DEFAULT_ROSTER_LIFECYCLE_SCHEDULER_INTERVAL_MS = 60 * 1000;
export const ROSTER_LIFECYCLE_SCHEDULER_JOB_KEY = "roster_lifecycle_scheduler";
export const ROSTER_LIFECYCLE_SCHEDULER_DISPLAY_NAME = "Roster lifecycle scheduler";

export type RosterLifecycleSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" | "staging" | "non_production" };

export type RosterLifecycleSchedulerCounts = {
  due: number;
  closed: number;
  closureFailed: number;
  refreshed: number;
  refreshSkipped: number;
  refreshFailed: number;
};

function zeroCounts(): RosterLifecycleSchedulerCounts {
  return {
    due: 0,
    closed: 0,
    closureFailed: 0,
    refreshed: 0,
    refreshSkipped: 0,
    refreshFailed: 0,
  };
}

function describeSkipReason(env: NodeJS.ProcessEnv): "mirror" | "staging" | "non_production" {
  if (!isActivePollingMode(env)) return "mirror";
  return resolveRuntimeEnvironment(env) === "staging" ? "staging" : "non_production";
}

/** Purpose: own the active-production cadence that reconciles expired roster lifecycles. */
export class RosterLifecycleSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly client: Client,
    private readonly rosterServicePort: Pick<RosterService, "closeDueRosters" | "refreshPostedRoster"> = rosterService,
    private readonly intervalMs: number = DEFAULT_ROSTER_LIFECYCLE_SCHEDULER_INTERVAL_MS,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  start(): RosterLifecycleSchedulerStartResult {
    const runtimeEnvironment = resolveRuntimeEnvironment(this.env);
    if (!isActivePollingMode(this.env)) {
      dozzleLog.info(
        `[polling-mode] event=poller_skipped job=${ROSTER_LIFECYCLE_SCHEDULER_JOB_KEY} mode=mirror`,
      );
      return { started: false, reason: "mirror" };
    }
    if (runtimeEnvironment !== "prod") {
      const reason = runtimeEnvironment === "staging" ? "staging" : "non_production";
      dozzleLog.info(
        `[polling-mode] event=poller_skipped job=${ROSTER_LIFECYCLE_SCHEDULER_JOB_KEY} mode=${reason}`,
      );
      return { started: false, reason };
    }
    if (this.timer) {
      return { started: false, reason: "already_started" };
    }

    void this.runCycle().catch((error) => {
      dozzleLog.error(
        `[roster-lifecycle] event=startup_cycle_failed failure_code=ROSTER_LIFECYCLE_CYCLE_FAILED error=${formatError(error)}`,
      );
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        dozzleLog.error(
          `[roster-lifecycle] event=interval_cycle_failed failure_code=ROSTER_LIFECYCLE_CYCLE_FAILED error=${formatError(error)}`,
        );
      });
    }, this.intervalMs);
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
    dozzleLog.info(
      `[roster-lifecycle] event=scheduler_started job=${ROSTER_LIFECYCLE_SCHEDULER_JOB_KEY} display_name="${ROSTER_LIFECYCLE_SCHEDULER_DISPLAY_NAME}" interval_ms=${this.intervalMs} runtime=${runtimeEnvironment}`,
    );
    return { started: true };
  }

  /** Purpose: stop the lifecycle timer so tests and controlled shutdowns do not schedule more work. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Purpose: close all due rosters first, then isolate each Discord refresh failure. */
  async runCycle(nowMs: number = Date.now()): Promise<RosterLifecycleSchedulerCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[roster-lifecycle] event=cycle_skipped reason=in_flight");
      return zeroCounts();
    }
    if (!isActivePollingMode(this.env) || resolveRuntimeEnvironment(this.env) !== "prod") {
      dozzleLog.debug(
        `[roster-lifecycle] event=cycle_skipped reason=${describeSkipReason(this.env)}`,
      );
      return zeroCounts();
    }

    this.inFlight = true;
    try {
      const closureResult: RosterDueClosureResult = await this.rosterServicePort.closeDueRosters(new Date(nowMs));
      const counts: RosterLifecycleSchedulerCounts = {
        due: closureResult.dueCount,
        closed: closureResult.closedRosters.length,
        closureFailed: closureResult.failedCount,
        refreshed: 0,
        refreshSkipped: 0,
        refreshFailed: 0,
      };

      for (const roster of closureResult.closedRosters) {
        let refreshResult: RosterPostedMessageRefreshResult;
        try {
          refreshResult = await this.rosterServicePort.refreshPostedRoster({
            rosterId: roster.id,
            client: this.client,
            // The lifecycle sweep intentionally uses DB-backed rendering only.
            cocService: null,
            emojiClient: this.client,
          });
        } catch (error) {
          counts.refreshFailed += 1;
          dozzleLog.error(
            `[roster-lifecycle] event=post_refresh_failed roster_id=${roster.id} failure_code=POST_REFRESH_FAILED error=${formatError(error)}`,
          );
          continue;
        }

        if (refreshResult.outcome === "refreshed") {
          counts.refreshed += 1;
        } else {
          counts.refreshSkipped += 1;
          dozzleLog.warn(
            `[roster-lifecycle] event=post_refresh_skipped roster_id=${roster.id} reason=${refreshResult.outcome}`,
          );
        }
      }

      dozzleLog.info(
        `[roster-lifecycle] event=cycle_complete job=${ROSTER_LIFECYCLE_SCHEDULER_JOB_KEY} due=${counts.due} closed=${counts.closed} closure_failed=${counts.closureFailed} refreshed=${counts.refreshed} refresh_skipped=${counts.refreshSkipped} refresh_failed=${counts.refreshFailed}`,
      );
      return counts;
    } finally {
      this.inFlight = false;
    }
  }
}
