import { formatError } from "../helper/formatError";

type CoCQueueTask<T> = {
  operation: string;
  detail?: string;
  run: () => Promise<T>;
};

type CoCQueueStatus = {
  queueDepth: number;
  inFlight: number;
  penaltyMs: number;
  spacingMs: number;
  degraded: boolean;
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

/** Purpose: provide one shared serialized pacing queue for CoC API requests with bounded 429 backoff. */
export class CoCRequestQueueService {
  private tail: Promise<void> = Promise.resolve();
  private nextAllowedAtMs = 0;
  private queueDepth = 0;
  private inFlight = 0;
  private penaltyMs = 0;
  private lastRateLimitLogAtMs = 0;
  private lastDegradedDelayLogAtMs = 0;
  private lastRecoveredLogAtMs = 0;

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

  /** Purpose: enqueue one CoC-bound request and execute it under shared pacing guarantees. */
  async enqueue<T>(task: CoCQueueTask<T>): Promise<T> {
    this.queueDepth += 1;
    return new Promise<T>((resolve, reject) => {
      const runQueued = async () => {
        this.queueDepth = Math.max(0, this.queueDepth - 1);
        this.inFlight += 1;
        try {
          await this.waitForTurn(task.operation, task.detail);
          try {
            const result = await task.run();
            this.noteSuccess();
            resolve(result);
          } catch (err) {
            this.noteFailure(err, task.operation, task.detail);
            reject(err);
          } finally {
            this.nextAllowedAtMs =
              Math.max(this.nextAllowedAtMs, Date.now()) +
              this.currentSpacingMs();
          }
        } finally {
          this.inFlight = Math.max(0, this.inFlight - 1);
        }
      };
      this.tail = this.tail.then(runQueued, runQueued).then(
        () => undefined,
        () => undefined,
      );
    });
  }

  /** Purpose: expose queue health for guarded command/poller behavior during upstream throttling. */
  getStatus(): CoCQueueStatus {
    return {
      queueDepth: this.queueDepth,
      inFlight: this.inFlight,
      penaltyMs: this.penaltyMs,
      spacingMs: this.currentSpacingMs(),
      degraded: this.penaltyMs > 0,
    };
  }

  /** Purpose: provide deterministic reset hook for queue-focused tests. */
  resetForTest(): void {
    this.tail = Promise.resolve();
    this.nextAllowedAtMs = 0;
    this.queueDepth = 0;
    this.inFlight = 0;
    this.penaltyMs = 0;
    this.lastRateLimitLogAtMs = 0;
    this.lastDegradedDelayLogAtMs = 0;
    this.lastRecoveredLogAtMs = 0;
  }

  private currentSpacingMs(): number {
    return this.baseSpacingMs + this.penaltyMs;
  }

  private async waitForTurn(operation: string, detail?: string): Promise<void> {
    const now = Date.now();
    const delayMs = Math.max(0, this.nextAllowedAtMs - now);
    if (delayMs <= 0) return;
    if (this.penaltyMs > 0) {
      this.logDegradedDelay({
        operation,
        detail,
        delayMs,
      });
    }
    await sleep(delayMs);
  }

  private noteSuccess(): void {
    if (this.penaltyMs <= 0) return;
    const previousPenalty = this.penaltyMs;
    this.penaltyMs = Math.max(0, this.penaltyMs - this.recoveryStepMs);
    if (previousPenalty > 0 && this.penaltyMs === 0) {
      const now = Date.now();
      if (now - this.lastRecoveredLogAtMs >= this.rateLimitLogIntervalMs) {
        this.lastRecoveredLogAtMs = now;
        console.info("[coc-queue] event=recovered penalty_ms=0 spacing_ms=" + this.currentSpacingMs());
      }
    }
  }

  private noteFailure(err: unknown, operation: string, detail?: string): void {
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
        `[coc-queue] event=rate_limited status=429 operation=${operation} detail=${detail ?? "none"} penalty_ms=${this.penaltyMs} spacing_ms=${this.currentSpacingMs()} queue_depth=${this.queueDepth} in_flight=${this.inFlight} error=${formatError(err)}`,
      );
    }
  }

  private logDegradedDelay(input: {
    operation: string;
    detail?: string;
    delayMs: number;
  }): void {
    const now = Date.now();
    if (now - this.lastDegradedDelayLogAtMs < this.degradedDelayLogIntervalMs) {
      return;
    }
    this.lastDegradedDelayLogAtMs = now;
    console.warn(
      `[coc-queue] event=degraded_delay operation=${input.operation} detail=${input.detail ?? "none"} delay_ms=${input.delayMs} penalty_ms=${this.penaltyMs} spacing_ms=${this.currentSpacingMs()} queue_depth=${this.queueDepth} in_flight=${this.inFlight}`,
    );
  }
}

export const cocRequestQueueService = new CoCRequestQueueService();

