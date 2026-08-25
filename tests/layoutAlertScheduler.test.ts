import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LayoutAlertSchedulerService,
  DEFAULT_LAYOUT_ALERT_SCHEDULER_INTERVAL_MS,
} from "../src/services/LayoutAlertSchedulerService";

const counts = {
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LayoutAlertSchedulerService", () => {
  it("starts one immediate cycle and rejects duplicate starts", async () => {
    vi.useFakeTimers();
    const evaluateAndDeliver = vi.fn(async () => ({ counts, durationMs: 1 }));
    const scheduler = new LayoutAlertSchedulerService(
      {} as any,
      { evaluateAndDeliver },
      DEFAULT_LAYOUT_ALERT_SCHEDULER_INTERVAL_MS,
      { POLLING_MODE: "active", NODE_ENV: "production" },
    );

    expect(scheduler.start()).toEqual({ started: true });
    expect(scheduler.start()).toEqual({ started: false, reason: "already_started" });
    await Promise.resolve();
    expect(evaluateAndDeliver).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not start timers in mirror or staging mode", () => {
    const delivery = { evaluateAndDeliver: vi.fn() };
    const mirror = new LayoutAlertSchedulerService({} as any, delivery, 100, { POLLING_MODE: "mirror" });
    const staging = new LayoutAlertSchedulerService({} as any, delivery, 100, { POLLING_MODE: "active", NODE_ENV: "staging" });
    const development = new LayoutAlertSchedulerService({} as any, delivery, 100, { POLLING_MODE: "active", NODE_ENV: "development" });
    const unknown = new LayoutAlertSchedulerService({} as any, delivery, 100, { POLLING_MODE: "active" });

    expect(mirror.start()).toEqual({ started: false, reason: "mirror" });
    expect(staging.start()).toEqual({ started: false, reason: "staging" });
    expect(development.start()).toEqual({ started: false, reason: "non_production" });
    expect(unknown.start()).toEqual({ started: false, reason: "non_production" });
    expect(delivery.evaluateAndDeliver).not.toHaveBeenCalled();
  });

  it("runs an hourly follow-up cycle and stop prevents future cycles", async () => {
    vi.useFakeTimers();
    const evaluateAndDeliver = vi.fn(async () => ({ counts, durationMs: 1 }));
    const scheduler = new LayoutAlertSchedulerService(
      {} as any,
      { evaluateAndDeliver },
      100,
      { POLLING_MODE: "active", NODE_ENV: "production" },
    );

    scheduler.start();
    await Promise.resolve();
    expect(evaluateAndDeliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(evaluateAndDeliver).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(evaluateAndDeliver).toHaveBeenCalledTimes(2);
  });

  it("skips overlapping runCycle calls", async () => {
    let resolveCycle!: (value: { counts: typeof counts; durationMs: number }) => void;
    const pending = new Promise<{ counts: typeof counts; durationMs: number }>((resolve) => {
      resolveCycle = resolve;
    });
    const evaluateAndDeliver = vi.fn(() => pending);
    const scheduler = new LayoutAlertSchedulerService(
      {} as any,
      { evaluateAndDeliver },
      100,
      { POLLING_MODE: "active", NODE_ENV: "production" },
    );

    const first = scheduler.runCycle();
    const second = await scheduler.runCycle();
    resolveCycle({ counts, durationMs: 1 });

    expect(second).toMatchObject({ sent: 0, skipped: 0 });
    await first;
    expect(evaluateAndDeliver).toHaveBeenCalledTimes(1);
  });
});
