import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoCRequestQueueService } from "../src/services/CoCRequestQueueService";

function snapshotQueueEnv() {
  return {
    base: process.env.COC_REQUEST_QUEUE_BASE_SPACING_MS,
    maxPenalty: process.env.COC_REQUEST_QUEUE_MAX_PENALTY_MS,
    min429Penalty: process.env.COC_REQUEST_QUEUE_MIN_429_PENALTY_MS,
    recoveryStep: process.env.COC_REQUEST_QUEUE_RECOVERY_STEP_MS,
  };
}

function restoreQueueEnv(snapshot: ReturnType<typeof snapshotQueueEnv>): void {
  process.env.COC_REQUEST_QUEUE_BASE_SPACING_MS = snapshot.base;
  process.env.COC_REQUEST_QUEUE_MAX_PENALTY_MS = snapshot.maxPenalty;
  process.env.COC_REQUEST_QUEUE_MIN_429_PENALTY_MS = snapshot.min429Penalty;
  process.env.COC_REQUEST_QUEUE_RECOVERY_STEP_MS = snapshot.recoveryStep;
}

describe("CoCRequestQueueService", () => {
  const envSnapshot = snapshotQueueEnv();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
    process.env.COC_REQUEST_QUEUE_BASE_SPACING_MS = "100";
    process.env.COC_REQUEST_QUEUE_MAX_PENALTY_MS = "1200";
    process.env.COC_REQUEST_QUEUE_MIN_429_PENALTY_MS = "400";
    process.env.COC_REQUEST_QUEUE_RECOVERY_STEP_MS = "200";
  });

  afterEach(() => {
    restoreQueueEnv(envSnapshot);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("enforces paced execution for queued work", async () => {
    const queue = new CoCRequestQueueService();
    const startedAtMs: number[] = [];

    const enqueueCall = () =>
      queue.enqueue({
        operation: "test",
        detail: "paced",
        run: async () => {
          startedAtMs.push(Date.now());
          return startedAtMs.length;
        },
      });

    const pending = [enqueueCall(), enqueueCall(), enqueueCall()];
    await vi.runAllTimersAsync();
    const results = await Promise.all(pending);

    expect(results).toEqual([1, 2, 3]);
    expect(startedAtMs).toHaveLength(3);
    expect(startedAtMs[1] - startedAtMs[0]).toBeGreaterThanOrEqual(100);
    expect(startedAtMs[2] - startedAtMs[1]).toBeGreaterThanOrEqual(100);
  });

  it("raises penalty and reduces pace when a 429 response is observed", async () => {
    const queue = new CoCRequestQueueService();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failureSeenAtMs = 0;

    await expect(
      queue.enqueue({
        operation: "test",
        detail: "429",
        run: async () => {
          failureSeenAtMs = Date.now();
          throw {
            response: { status: 429 },
            message: "Request throttling limits exceeded",
          };
        },
      }),
    ).rejects.toBeTruthy();

    const statusAfter429 = queue.getStatus();
    expect(statusAfter429.degraded).toBe(true);
    expect(statusAfter429.penaltyMs).toBeGreaterThanOrEqual(400);

    let nextStartedAtMs = 0;
    const successPromise = queue.enqueue({
      operation: "test",
      detail: "after_429",
      run: async () => {
        nextStartedAtMs = Date.now();
        return "ok";
      },
    });
    await vi.runAllTimersAsync();
    await expect(successPromise).resolves.toBe("ok");

    expect(nextStartedAtMs - failureSeenAtMs).toBeGreaterThanOrEqual(400);
    expect(queue.getStatus().penaltyMs).toBeLessThan(statusAfter429.penaltyMs);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[coc-queue] event=rate_limited status=429"),
    );
  });
});

