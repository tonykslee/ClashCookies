import { type Client } from "discord.js";
import { dozzleLog } from "../helper/dozzleLogger";
import {
  LayoutAlertDeliveryService,
  layoutAlertDeliveryService,
  type LayoutAlertDeliveryCounts,
} from "./LayoutAlertDeliveryService";
import { isActivePollingMode, resolvePollingMode, resolveRuntimeEnvironment } from "./PollingModeService";

export const DEFAULT_LAYOUT_ALERT_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
export const LAYOUT_ALERT_SCHEDULER_JOB_KEY = "layout_alert_scheduler";
export const LAYOUT_ALERT_SCHEDULER_DISPLAY_NAME = "Layout expiration-alert scheduler";

export type LayoutAlertSchedulerStartResult =
  | { started: true }
  | { started: false; reason: "already_started" | "mirror" | "staging" | "non_production" };

function zeroCounts(): LayoutAlertDeliveryCounts {
  return {
    configs: 0,
    eligibleLayouts: 0,
    eligibleTargets: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    deduped: 0,
    retryDeferred: 0,
    recentClaims: 0,
    superseded: 0,
    unknownFreshness: 0,
    notDue: 0,
    missingRouting: 0,
    skipped: 0,
  };
}

/** Purpose: own the active-runtime hourly loop for durable per-layout expiration alerts. */
export class LayoutAlertSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly client: Client,
    private readonly deliveryService: Pick<LayoutAlertDeliveryService, "evaluateAndDeliver"> = layoutAlertDeliveryService,
    private readonly intervalMs: number = DEFAULT_LAYOUT_ALERT_SCHEDULER_INTERVAL_MS,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  start(): LayoutAlertSchedulerStartResult {
    const pollingMode = resolvePollingMode(this.env);
    const runtimeEnvironment = resolveRuntimeEnvironment(this.env);
    if (pollingMode !== "active") {
      dozzleLog.info(`[polling-mode] event=poller_skipped job=${LAYOUT_ALERT_SCHEDULER_JOB_KEY} mode=mirror`);
      return { started: false, reason: "mirror" };
    }
    if (runtimeEnvironment !== "prod") {
      const reason = runtimeEnvironment === "staging" ? "staging" : "non_production";
      dozzleLog.info(`[polling-mode] event=poller_skipped job=${LAYOUT_ALERT_SCHEDULER_JOB_KEY} mode=${reason}`);
      return { started: false, reason };
    }
    if (this.timer) return { started: false, reason: "already_started" };

    void this.runCycle().catch((error) => {
      dozzleLog.warn(`[layout-alert] scheduler_cycle_failed failure_code=${String((error as { code?: unknown })?.code ?? "CYCLE_FAILED").slice(0, 100)}`);
    });
    this.timer = setInterval(() => {
      void this.runCycle().catch((error) => {
        dozzleLog.warn(`[layout-alert] scheduler_cycle_failed failure_code=${String((error as { code?: unknown })?.code ?? "CYCLE_FAILED").slice(0, 100)}`);
      });
    }, this.intervalMs);
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
    dozzleLog.info(`[layout-alert] scheduler_started interval_ms=${this.intervalMs}`);
    return { started: true };
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(now?: Date): Promise<LayoutAlertDeliveryCounts> {
    if (this.inFlight) {
      dozzleLog.debug("[layout-alert] cycle_skipped reason=in_flight");
      return zeroCounts();
    }
    if (!isActivePollingMode(this.env) || resolveRuntimeEnvironment(this.env) !== "prod") {
      const runtimeEnvironment = resolveRuntimeEnvironment(this.env);
      dozzleLog.debug(
        `[layout-alert] cycle_skipped reason=${!isActivePollingMode(this.env) ? "mirror" : runtimeEnvironment === "staging" ? "staging" : "non_production"}`,
      );
      return zeroCounts();
    }
    this.inFlight = true;
    try {
      const result = await this.deliveryService.evaluateAndDeliver({
        client: this.client,
        now,
        pollingMode: "active",
        runtimeEnvironment: resolveRuntimeEnvironment(this.env),
      });
      return result.counts;
    } catch (error) {
      const code = String((error as { code?: unknown } | null | undefined)?.code ?? "CYCLE_FAILED").slice(0, 100);
      dozzleLog.warn(`[layout-alert] scheduler_cycle_failed failure_code=${code}`);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}
