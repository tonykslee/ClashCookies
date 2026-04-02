import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoCQueueSkippedError,
  CoCRequestQueueService,
} from "../src/services/CoCRequestQueueService";
import { TelemetryIngestService } from "../src/services/telemetry/ingest";

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
    vi.setSystemTime(new Date("2026-04-02T00:00:00.000Z"));
    process.env.COC_REQUEST_QUEUE_BASE_SPACING_MS = "100";
    process.env.COC_REQUEST_QUEUE_MAX_PENALTY_MS = "1200";
    process.env.COC_REQUEST_QUEUE_MIN_429_PENALTY_MS = "400";
    process.env.COC_REQUEST_QUEUE_RECOVERY_STEP_MS = "200";
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreQueueEnv(envSnapshot);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("dispatches interactive work ahead of queued background work while preserving FIFO within each priority", async () => {
    const queue = new CoCRequestQueueService();
    const order: string[] = [];

    const pending = [
      queue.enqueue({
        priority: "background",
        source: "poll:bg1",
        operation: "bg1",
        run: async () => {
          order.push("bg1");
          return "bg1";
        },
      }),
      queue.enqueue({
        priority: "background",
        source: "poll:bg2",
        operation: "bg2",
        run: async () => {
          order.push("bg2");
          return "bg2";
        },
      }),
      queue.enqueue({
        priority: "interactive",
        source: "slash:int1",
        operation: "int1",
        run: async () => {
          order.push("int1");
          return "int1";
        },
      }),
      queue.enqueue({
        priority: "interactive",
        source: "slash:int2",
        operation: "int2",
        run: async () => {
          order.push("int2");
          return "int2";
        },
      }),
    ];

    await vi.runAllTimersAsync();
    await expect(Promise.all(pending)).resolves.toEqual([
      "bg1",
      "bg2",
      "int1",
      "int2",
    ]);
    expect(order).toEqual(["int1", "int2", "bg1", "bg2"]);
    expect(queue.getStatus().interactiveDispatchedCount).toBe(2);
    expect(queue.getStatus().backgroundDispatchedCount).toBe(2);
  });

  it("preserves FIFO ordering within background work", async () => {
    const queue = new CoCRequestQueueService();
    const order: string[] = [];

    const pending = ["bg1", "bg2", "bg3"].map((label) =>
      queue.enqueue({
        priority: "background",
        source: `poll:${label}`,
        operation: label,
        run: async () => {
          order.push(label);
          return label;
        },
      }),
    );

    await vi.runAllTimersAsync();
    await expect(Promise.all(pending)).resolves.toEqual(["bg1", "bg2", "bg3"]);
    expect(order).toEqual(["bg1", "bg2", "bg3"]);
  });

  it("lets new interactive work repeatedly cut ahead of queued background work", async () => {
    const queue = new CoCRequestQueueService();
    const order: string[] = [];

    const bg1 = queue.enqueue({
      priority: "background",
      source: "poll:bg1",
      operation: "bg1",
      run: async () => {
        order.push("bg1");
        return "bg1";
      },
    });
    const bg2 = queue.enqueue({
      priority: "background",
      source: "poll:bg2",
      operation: "bg2",
      run: async () => {
        order.push("bg2");
        return "bg2";
      },
    });
    const int1 = queue.enqueue({
      priority: "interactive",
      source: "slash:int1",
      operation: "int1",
      run: async () => {
        order.push("int1");
        return "int1";
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    const int2 = queue.enqueue({
      priority: "interactive",
      source: "button:int2",
      operation: "int2",
      run: async () => {
        order.push("int2");
        return "int2";
      },
    });

    await vi.runAllTimersAsync();
    await expect(Promise.all([bg1, bg2, int1, int2])).resolves.toEqual([
      "bg1",
      "bg2",
      "int1",
      "int2",
    ]);
    expect(order).toEqual(["int1", "int2", "bg1", "bg2"]);
  });

  it("keeps one shared penalty/spacing owner across background and interactive work", async () => {
    const queue = new CoCRequestQueueService();
    let failureSeenAtMs = 0;

    await expect(
      queue.enqueue({
        priority: "background",
        source: "poll:429",
        operation: "poll_cycle",
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

    let interactiveStartedAtMs = 0;
    const interactivePromise = queue.enqueue({
      priority: "interactive",
      source: "slash:after_429",
      operation: "command_after_429",
      run: async () => {
        interactiveStartedAtMs = Date.now();
        return "ok";
      },
    });

    await vi.runAllTimersAsync();
    await expect(interactivePromise).resolves.toBe("ok");
    expect(interactiveStartedAtMs - failureSeenAtMs).toBeGreaterThanOrEqual(400);
    expect(queue.getStatus().penaltyMs).toBeLessThan(statusAfter429.penaltyMs);
  });

  it("skips stale background work before dispatch and logs/counts the skip", async () => {
    const queue = new CoCRequestQueueService();
    const runSpy = vi.fn();

    const stalePromise = queue.enqueue({
      priority: "background",
      source: "poll:stale",
      operation: "stale_poll",
      scheduledAtMs: Date.now() - 10 * 60 * 1000,
      nextScheduledAtMs: Date.now() - 60_000,
      run: async () => {
        runSpy();
        return "stale";
      },
    });
    void stalePromise.catch(() => undefined);
    const interactivePromise = queue.enqueue({
      priority: "interactive",
      source: "slash:fresh",
      operation: "fresh_command",
      run: async () => "fresh",
    });

    await vi.runAllTimersAsync();

    await expect(interactivePromise).resolves.toBe("fresh");
    await expect(stalePromise).rejects.toBeInstanceOf(CoCQueueSkippedError);
    expect(runSpy).not.toHaveBeenCalled();
    expect(queue.getStatus().backgroundSkippedCount).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[coc-queue] event=background_skipped"),
    );
  });

  it("reports separate interactive/background depths and last wait signals", async () => {
    const queue = new CoCRequestQueueService();
    let releaseFirst: (() => void) | null = null;
    const firstTaskGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = queue.enqueue({
      priority: "interactive",
      source: "slash:blocking",
      operation: "blocking_command",
      run: async () => {
        await firstTaskGate;
        return "interactive";
      },
    });
    const secondPromise = queue.enqueue({
      priority: "background",
      source: "poll:queued",
      operation: "queued_poll",
      run: async () => "background",
    });

    await Promise.resolve();
    const statusWhileRunning = queue.getStatus();
    expect(statusWhileRunning.inFlight).toBe(1);
    expect(statusWhileRunning.interactiveQueueDepth).toBe(0);
    expect(statusWhileRunning.backgroundQueueDepth).toBe(1);
    expect(statusWhileRunning.queueDepth).toBe(1);

    releaseFirst?.();
    await vi.runAllTimersAsync();
    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
      "interactive",
      "background",
    ]);

    const finalStatus = queue.getStatus();
    expect(finalStatus.lastInteractiveWaitMs).toBeGreaterThanOrEqual(0);
    expect(finalStatus.lastBackgroundWaitMs).toBeGreaterThanOrEqual(0);
  });

  it("records queue wait telemetry by priority and command stage timing for interactive work", async () => {
    const queue = new CoCRequestQueueService();
    const ingest = TelemetryIngestService.getInstance();
    const apiSpy = vi.spyOn(ingest, "recordApiTiming").mockImplementation(() => undefined);
    const stageSpy = vi.spyOn(ingest, "recordStageTiming").mockImplementation(() => undefined);

    const interactivePromise = queue.enqueue({
      priority: "interactive",
      source: "slash:todo",
      operation: "getClan",
      telemetryContext: {
        runId: "run-1",
        guildId: "guild-1",
        userId: "user-1",
        commandName: "todo",
        subcommand: "war",
        interactionId: "itx-1",
      },
      run: async () => "interactive",
    });
    const backgroundPromise = queue.enqueue({
      priority: "background",
      source: "poll:observe",
      operation: "getPlayerRaw",
      run: async () => "background",
    });

    await vi.runAllTimersAsync();
    await expect(Promise.all([interactivePromise, backgroundPromise])).resolves.toEqual([
      "interactive",
      "background",
    ]);

    expect(apiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "coc_queue",
        operation: "interactive_wait",
        durationMs: expect.any(Number),
      }),
    );
    expect(apiSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "coc_queue",
        operation: "background_wait",
        durationMs: expect.any(Number),
      }),
    );
    expect(stageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "coc_queue_wait",
        commandName: "todo",
        subcommand: "war",
      }),
    );
  });
});
