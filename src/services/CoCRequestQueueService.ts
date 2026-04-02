import { formatError } from "../helper/formatError";
import type { CoCQueuePriority } from "./CoCQueueContext";
import type { TelemetryCommandContext } from "./telemetry/context";
import { TelemetryIngestService } from "./telemetry/ingest";

type CoCQueueTask<T> = {
  operation: string;
  detail?: string;
  priority: CoCQueuePriority;
  source: string;
  scheduledAtMs?: number | null;
  nextScheduledAtMs?: number | null;
  freshnessDeadlineMs?: number | null;
  telemetryContext?: TelemetryCommandContext | null;
  run: () => Promise<T>;
};

type PendingCoCQueueTask<T> = CoCQueueTask<T> & {
  id: number;
  enqueuedAtMs: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type CoCQueueStatus = {
  queueDepth: number;
  interactiveQueueDepth: number;
  backgroundQueueDepth: number;
  inFlight: number;
  penaltyMs: number;
  spacingMs: number;
  degraded: boolean;
  lastInteractiveWaitMs: number;
  lastBackgroundWaitMs: number;
  backgroundSkippedCount: number;
  interactiveDispatchedCount: number;
  backgroundDispatchedCount: number;
};

type BackgroundStaleness = {
  stale: boolean;
  reason: string;
  deadlineMs: number | null;
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeOptionalTimestamp(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  return Math.max(0, Math.trunc(Number(value)));
}

function resolveHttpStatus(err: unknown): number | null {
  const asAny = err as any;
  const responseStatus = Number(asAny?.response?.status);
  if (Number.isFinite(responseStatus) && responseStatus > 0) {
    return Math.trunc(responseStatus);
  }
  const status = Number(asAny?.status);
  if (Number.isFinite(status) && status > 0) {
    return Math.trunc(status);
  }
  const message = String(asAny?.message ?? "");
  const cocStatus = message.match(/CoC API error\s+(\d{3})/i);
  if (cocStatus) return Math.trunc(Number(cocStatus[1]));
  const genericStatus = message.match(/HTTP[_\s](\d{3})/i);
  if (genericStatus) return Math.trunc(Number(genericStatus[1]));
  return null;
}

/** Purpose: signal one background queue task was intentionally skipped after becoming stale. */
export class CoCQueueSkippedError extends Error {
  readonly priority: CoCQueuePriority;
  readonly source: string;
  readonly operation: string;
  readonly waitMs: number;

  constructor(input: {
    priority: CoCQueuePriority;
    source: string;
    operation: string;
    waitMs: number;
    reason: string;
  }) {
    super(
      `CoC queue skipped ${input.priority} task ${input.operation} source=${input.source} reason=${input.reason} wait_ms=${input.waitMs}`,
    );
    this.name = "CoCQueueSkippedError";
    this.priority = input.priority;
    this.source = input.source;
    this.operation = input.operation;
    this.waitMs = input.waitMs;
  }
}

/** Purpose: identify one queue-skip error without leaking implementation details to callers. */
export function isCoCQueueSkippedError(err: unknown): err is CoCQueueSkippedError {
  return err instanceof CoCQueueSkippedError;
}

/** Purpose: provide one shared paced dispatcher for CoC API requests with strict interactive priority. */
export class CoCRequestQueueService {
  private interactiveQueue: Array<PendingCoCQueueTask<unknown>> = [];
  private backgroundQueue: Array<PendingCoCQueueTask<unknown>> = [];
  private nextAllowedAtMs = 0;
  private inFlight = 0;
  private penaltyMs = 0;
  private lastRateLimitLogAtMs = 0;
  private lastDegradedDelayLogAtMs = 0;
  private lastRecoveredLogAtMs = 0;
  private dispatchLoop: Promise<void> | null = null;
  private nextTaskId = 1;
  private lastInteractiveWaitMs = 0;
  private lastBackgroundWaitMs = 0;
  private backgroundSkippedCount = 0;
  private interactiveDispatchedCount = 0;
  private backgroundDispatchedCount = 0;
  private readonly telemetryIngest = TelemetryIngestService.getInstance();

  private readonly baseSpacingMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_BASE_SPACING_MS,
    120,
  );
  private readonly maxPenaltyMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_MAX_PENALTY_MS,
    8000,
  );
  private readonly min429PenaltyMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_MIN_429_PENALTY_MS,
    1000,
  );
  private readonly recoveryStepMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_RECOVERY_STEP_MS,
    100,
  );
  private readonly degradedDelayLogIntervalMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_DEGRADED_DELAY_LOG_INTERVAL_MS,
    15_000,
  );
  private readonly rateLimitLogIntervalMs = toPositiveInt(
    process.env.COC_REQUEST_QUEUE_RATE_LIMIT_LOG_INTERVAL_MS,
    10_000,
  );

  /** Purpose: enqueue one CoC-bound request under strict interactive-first dispatch and shared pacing. */
  async enqueue<T>(task: CoCQueueTask<T>): Promise<T> {
    const priority = task.priority;
    const source = String(task.source ?? "").trim();
    if (priority !== "interactive" && priority !== "background") {
      throw new Error(`COC_QUEUE_PRIORITY_INVALID:${String(task.priority)}`);
    }
    if (!source) {
      throw new Error(`COC_QUEUE_SOURCE_REQUIRED:${task.operation}`);
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingCoCQueueTask<T> = {
        ...task,
        source,
        scheduledAtMs: normalizeOptionalTimestamp(task.scheduledAtMs),
        nextScheduledAtMs: normalizeOptionalTimestamp(task.nextScheduledAtMs),
        freshnessDeadlineMs: normalizeOptionalTimestamp(task.freshnessDeadlineMs),
        id: this.nextTaskId++,
        enqueuedAtMs: Date.now(),
        resolve,
        reject,
      };

      if (priority === "interactive") {
        this.interactiveQueue.push(pending as PendingCoCQueueTask<unknown>);
      } else {
        this.backgroundQueue.push(pending as PendingCoCQueueTask<unknown>);
      }

      console.info(
        `[coc-queue] event=enqueue priority=${priority} source=${source} operation=${task.operation} detail=${task.detail ?? "none"} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length} in_flight=${this.inFlight}`,
      );
      this.ensureDispatchLoop();
    });
  }

  /** Purpose: expose queue health for guarded command/poller behavior during upstream throttling. */
  getStatus(): CoCQueueStatus {
    const interactiveQueueDepth = this.interactiveQueue.length;
    const backgroundQueueDepth = this.backgroundQueue.length;
    return {
      queueDepth: interactiveQueueDepth + backgroundQueueDepth,
      interactiveQueueDepth,
      backgroundQueueDepth,
      inFlight: this.inFlight,
      penaltyMs: this.penaltyMs,
      spacingMs: this.currentSpacingMs(),
      degraded: this.penaltyMs > 0,
      lastInteractiveWaitMs: this.lastInteractiveWaitMs,
      lastBackgroundWaitMs: this.lastBackgroundWaitMs,
      backgroundSkippedCount: this.backgroundSkippedCount,
      interactiveDispatchedCount: this.interactiveDispatchedCount,
      backgroundDispatchedCount: this.backgroundDispatchedCount,
    };
  }

  /** Purpose: provide deterministic reset hook for queue-focused tests. */
  resetForTest(): void {
    this.interactiveQueue = [];
    this.backgroundQueue = [];
    this.nextAllowedAtMs = 0;
    this.inFlight = 0;
    this.penaltyMs = 0;
    this.lastRateLimitLogAtMs = 0;
    this.lastDegradedDelayLogAtMs = 0;
    this.lastRecoveredLogAtMs = 0;
    this.dispatchLoop = null;
    this.nextTaskId = 1;
    this.lastInteractiveWaitMs = 0;
    this.lastBackgroundWaitMs = 0;
    this.backgroundSkippedCount = 0;
    this.interactiveDispatchedCount = 0;
    this.backgroundDispatchedCount = 0;
  }

  private ensureDispatchLoop(): void {
    if (this.dispatchLoop) return;
    this.dispatchLoop = this.runDispatchLoop()
      .catch((err) => {
        console.error(`[coc-queue] event=dispatcher_failed error=${formatError(err)}`);
      })
      .finally(() => {
        this.dispatchLoop = null;
        if (this.hasQueuedTasks()) {
          this.ensureDispatchLoop();
        }
      });
  }

  private async runDispatchLoop(): Promise<void> {
    while (this.hasQueuedTasks()) {
      await this.waitForDispatchTurn();
      const nextTask = this.pickNextDispatchableTask();
      if (!nextTask) {
        continue;
      }
      await this.executeTask(nextTask);
    }
  }

  private hasQueuedTasks(): boolean {
    return this.interactiveQueue.length > 0 || this.backgroundQueue.length > 0;
  }

  private currentSpacingMs(): number {
    return this.baseSpacingMs + this.penaltyMs;
  }

  private async waitForDispatchTurn(): Promise<void> {
    const now = Date.now();
    const delayMs = Math.max(0, this.nextAllowedAtMs - now);
    if (delayMs <= 0) return;
    if (this.penaltyMs > 0) {
      this.logDegradedDelay(delayMs);
    }
    await sleep(delayMs);
  }

  private pickNextDispatchableTask(): PendingCoCQueueTask<unknown> | null {
    if (this.interactiveQueue.length > 0) {
      return this.interactiveQueue.shift() ?? null;
    }

    while (this.backgroundQueue.length > 0) {
      const next = this.backgroundQueue[0];
      const staleness = this.resolveBackgroundStaleness(next);
      if (!staleness.stale) {
        return this.backgroundQueue.shift() ?? null;
      }

      this.backgroundQueue.shift();
      this.noteBackgroundSkipped(next, staleness);
    }

    return null;
  }

  private resolveBackgroundStaleness(task: PendingCoCQueueTask<unknown>): BackgroundStaleness {
    if (task.priority !== "background") {
      return { stale: false, reason: "not_background", deadlineMs: null };
    }

    const deadlineMs =
      normalizeOptionalTimestamp(task.freshnessDeadlineMs) ??
      normalizeOptionalTimestamp(task.nextScheduledAtMs);
    if (deadlineMs === null) {
      return { stale: false, reason: "no_deadline", deadlineMs: null };
    }
    if (Date.now() < deadlineMs) {
      return { stale: false, reason: "fresh", deadlineMs };
    }
    return {
      stale: true,
      reason:
        normalizeOptionalTimestamp(task.freshnessDeadlineMs) !== null
          ? "freshness_deadline_elapsed"
          : "next_scheduled_run_due",
      deadlineMs,
    };
  }

  private async executeTask(task: PendingCoCQueueTask<unknown>): Promise<void> {
    this.inFlight += 1;
    try {
      const waitMs = Math.max(0, Date.now() - task.enqueuedAtMs);
      this.noteDispatched(task, waitMs);
      try {
        const result = await task.run();
        this.noteSuccess();
        task.resolve(result);
      } catch (err) {
        this.noteFailure(err, task);
        task.reject(err);
      } finally {
        this.nextAllowedAtMs =
          Math.max(this.nextAllowedAtMs, Date.now()) + this.currentSpacingMs();
      }
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private noteDispatched(task: PendingCoCQueueTask<unknown>, waitMs: number): void {
    if (task.priority === "interactive") {
      this.interactiveDispatchedCount += 1;
      this.lastInteractiveWaitMs = waitMs;
    } else {
      this.backgroundDispatchedCount += 1;
      this.lastBackgroundWaitMs = waitMs;
    }

    console.info(
      `[coc-queue] event=dispatch priority=${task.priority} source=${task.source} operation=${task.operation} detail=${task.detail ?? "none"} wait_ms=${waitMs} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length} in_flight=${this.inFlight} penalty_ms=${this.penaltyMs} spacing_ms=${this.currentSpacingMs()}`,
    );
    this.recordDispatchTelemetry(task, waitMs);
  }

  private noteBackgroundSkipped(
    task: PendingCoCQueueTask<unknown>,
    staleness: BackgroundStaleness,
  ): void {
    const waitMs = Math.max(0, Date.now() - task.enqueuedAtMs);
    this.backgroundSkippedCount += 1;
    this.lastBackgroundWaitMs = waitMs;

    console.warn(
      `[coc-queue] event=background_skipped source=${task.source} operation=${task.operation} detail=${task.detail ?? "none"} wait_ms=${waitMs} reason=${staleness.reason} scheduled_at_ms=${task.scheduledAtMs ?? "none"} next_scheduled_at_ms=${task.nextScheduledAtMs ?? "none"} freshness_deadline_ms=${task.freshnessDeadlineMs ?? "none"} stale_deadline_ms=${staleness.deadlineMs ?? "none"} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length}`,
    );
    this.telemetryIngest.recordApiTiming({
      namespace: "coc_queue",
      operation: "background_skipped",
      source: "api",
      status: "failure",
      durationMs: waitMs,
      errorCategory: "stale",
      errorCode: "BACKGROUND_STALE_SKIPPED",
    });
    task.reject(
      new CoCQueueSkippedError({
        priority: task.priority,
        source: task.source,
        operation: task.operation,
        waitMs,
        reason: staleness.reason,
      }),
    );
  }

  private noteSuccess(): void {
    if (this.penaltyMs <= 0) return;
    const previousPenalty = this.penaltyMs;
    this.penaltyMs = Math.max(0, this.penaltyMs - this.recoveryStepMs);
    if (previousPenalty > 0 && this.penaltyMs === 0) {
      const now = Date.now();
      if (now - this.lastRecoveredLogAtMs >= this.rateLimitLogIntervalMs) {
        this.lastRecoveredLogAtMs = now;
        console.info(
          `[coc-queue] event=recovered penalty_ms=0 spacing_ms=${this.currentSpacingMs()} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length}`,
        );
        this.telemetryIngest.recordApiTiming({
          namespace: "coc_queue",
          operation: "recovered",
          source: "api",
          status: "success",
          durationMs: 0,
        });
      }
    }
  }

  private noteFailure(err: unknown, task: PendingCoCQueueTask<unknown>): void {
    const status = resolveHttpStatus(err);
    if (status !== 429) return;

    const previousPenalty = this.penaltyMs;
    const raisedPenalty =
      previousPenalty <= 0
        ? this.min429PenaltyMs
        : Math.max(this.min429PenaltyMs, previousPenalty * 2);
    this.penaltyMs = Math.min(this.maxPenaltyMs, raisedPenalty);
    this.nextAllowedAtMs = Math.max(
      this.nextAllowedAtMs,
      Date.now() + this.penaltyMs,
    );

    const now = Date.now();
    if (
      this.penaltyMs !== previousPenalty ||
      now - this.lastRateLimitLogAtMs >= this.rateLimitLogIntervalMs
    ) {
      this.lastRateLimitLogAtMs = now;
      console.warn(
        `[coc-queue] event=rate_limited status=429 priority=${task.priority} source=${task.source} operation=${task.operation} detail=${task.detail ?? "none"} penalty_ms=${this.penaltyMs} spacing_ms=${this.currentSpacingMs()} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length} in_flight=${this.inFlight} error=${formatError(err)}`,
      );
      this.telemetryIngest.recordApiTiming({
        namespace: "coc_queue",
        operation: "rate_limited",
        source: "api",
        status: "failure",
        durationMs: this.penaltyMs,
        errorCategory: "rate_limit",
        errorCode: "HTTP_429",
      });
    }
  }

  private logDegradedDelay(delayMs: number): void {
    const now = Date.now();
    if (now - this.lastDegradedDelayLogAtMs < this.degradedDelayLogIntervalMs) {
      return;
    }
    this.lastDegradedDelayLogAtMs = now;
    const interactivePresent = this.interactiveQueue.length > 0;
    console.warn(
      `[coc-queue] event=degraded_delay delay_ms=${delayMs} penalty_ms=${this.penaltyMs} spacing_ms=${this.currentSpacingMs()} interactive_depth=${this.interactiveQueue.length} background_depth=${this.backgroundQueue.length} in_flight=${this.inFlight} interactive_present=${interactivePresent}`,
    );
    this.telemetryIngest.recordApiTiming({
      namespace: "coc_queue",
      operation: interactivePresent ? "interactive_degraded_wait" : "background_degraded_wait",
      source: "api",
      status: "failure",
      durationMs: delayMs,
      timeout: false,
    });
  }

  private recordDispatchTelemetry(task: PendingCoCQueueTask<unknown>, waitMs: number): void {
    const telemetry = task.telemetryContext ?? null;
    this.telemetryIngest.recordApiTiming({
      namespace: "coc_queue",
      operation: task.priority === "interactive" ? "interactive_wait" : "background_wait",
      source: "api",
      status: "success",
      guildId: telemetry?.guildId ?? null,
      commandName: telemetry?.commandName ?? null,
      durationMs: waitMs,
    });

    if (!telemetry || task.priority !== "interactive") {
      return;
    }
    this.telemetryIngest.recordStageTiming({
      stage: "coc_queue_wait",
      status: "success",
      guildId: telemetry.guildId,
      commandName: telemetry.commandName,
      subcommand: telemetry.subcommand,
      runId: telemetry.runId,
      durationMs: waitMs,
    });
  }
}

export const cocRequestQueueService = new CoCRequestQueueService();
