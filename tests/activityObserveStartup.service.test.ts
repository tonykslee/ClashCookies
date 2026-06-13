import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { startActivityObserveLoop } from "../src/services/ActivityObserveStartupService";

const statusServiceMock = vi.hoisted(() => ({
  markStarted: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markDisabled: vi.fn(),
  listStatuses: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("../src/services/BotPollJobStatusService", () => ({
  botPollJobStatusService: statusServiceMock,
}));

describe("ActivityObserveStartupService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    vi.clearAllMocks();
    statusServiceMock.markStarted.mockResolvedValue({});
    statusServiceMock.markSucceeded.mockResolvedValue({});
    statusServiceMock.markFailed.mockResolvedValue({});
    statusServiceMock.markSkipped.mockResolvedValue({});
    statusServiceMock.markDisabled.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts the observe cycle in the background without blocking startup", async () => {
    const runObservedCycle = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = startActivityObserveLoop({
      activePollingEnabled: true,
      intervalMinutes: 30,
      intervalMs: 30 * 60 * 1000,
      initialObserveDelayMs: 0,
      runObservedCycle,
    });

    expect(result).toEqual({ started: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statusServiceMock.markStarted).toHaveBeenCalledTimes(1);
    expect(runObservedCycle).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("Activity observe loop enabled (every 30 minute(s)).");
  });

  it("delays the initial observe run but still returns immediately", async () => {
    const runObservedCycle = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = startActivityObserveLoop({
      activePollingEnabled: true,
      intervalMinutes: 30,
      intervalMs: 30 * 60 * 1000,
      initialObserveDelayMs: 60_000,
      runObservedCycle,
    });

    expect(result).toEqual({ started: true });
    expect(runObservedCycle).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "Skipping startup activity observe run; next run in 1 minute(s).",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runObservedCycle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("logs and swallows observe failures", async () => {
    const runObservedCycle = vi.fn().mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    startActivityObserveLoop({
      activePollingEnabled: true,
      intervalMinutes: 30,
      intervalMs: 30 * 60 * 1000,
      initialObserveDelayMs: 0,
      runObservedCycle,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(statusServiceMock.markStarted).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("observeTrackedClans startup run failed: boom");
  });

  it("skips mirror mode without registering timers", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runObservedCycle = vi.fn();

    const result = startActivityObserveLoop({
      activePollingEnabled: false,
      intervalMinutes: 30,
      intervalMs: 30 * 60 * 1000,
      initialObserveDelayMs: 0,
      runObservedCycle,
    });

    expect(result).toEqual({ started: false });
    expect(runObservedCycle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      "[polling-mode] event=poller_skipped job=activity_observe_cycle mode=mirror",
    );
  });
});
