import { afterEach, describe, expect, it, vi } from "vitest";

const rosterServiceMock = vi.hoisted(() => ({
  closeDueRosters: vi.fn(),
  refreshPostedRoster: vi.fn(),
}));

vi.mock("../src/services/RosterService", () => ({
  rosterService: rosterServiceMock,
}));

import {
  DEFAULT_ROSTER_LIFECYCLE_SCHEDULER_INTERVAL_MS,
  RosterLifecycleSchedulerService,
} from "../src/services/RosterLifecycleSchedulerService";

const rosterOne = { id: "roster-1" } as any;
const rosterTwo = { id: "roster-2" } as any;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rosterServiceMock.closeDueRosters.mockReset();
  rosterServiceMock.refreshPostedRoster.mockReset();
});

describe("RosterLifecycleSchedulerService", () => {
  it("closes due rosters and isolates a failed post refresh", async () => {
    rosterServiceMock.closeDueRosters.mockResolvedValue({
      dueCount: 2,
      closedRosters: [rosterOne, rosterTwo],
      failedCount: 0,
    });
    rosterServiceMock.refreshPostedRoster
      .mockResolvedValueOnce({ outcome: "refreshed", rosterId: "roster-1" })
      .mockRejectedValueOnce(new Error("message deleted"));
    const scheduler = new RosterLifecycleSchedulerService(
      {} as any,
      rosterServiceMock as any,
      DEFAULT_ROSTER_LIFECYCLE_SCHEDULER_INTERVAL_MS,
      { POLLING_MODE: "active", POLLING_ENV: "prod" },
    );

    await expect(scheduler.runCycle(Date.parse("2026-09-01T12:00:00.000Z"))).resolves.toEqual({
      due: 2,
      closed: 2,
      closureFailed: 0,
      refreshed: 1,
      refreshSkipped: 0,
      refreshFailed: 1,
    });
    expect(rosterServiceMock.refreshPostedRoster).toHaveBeenCalledTimes(2);
    expect(rosterServiceMock.refreshPostedRoster).toHaveBeenCalledWith(
      expect.objectContaining({ rosterId: "roster-2", cocService: null }),
    );
  });

  it("does not write or edit outside active production", async () => {
    for (const env of [
      { POLLING_MODE: "mirror", POLLING_ENV: "prod" },
      { POLLING_MODE: "active", POLLING_ENV: "staging" },
      { POLLING_MODE: "active", POLLING_ENV: "dev" },
    ]) {
      const scheduler = new RosterLifecycleSchedulerService({} as any, rosterServiceMock as any, 100, env);
      expect(scheduler.start()).toMatchObject({ started: false });
      await expect(scheduler.runCycle()).resolves.toEqual({
        due: 0,
        closed: 0,
        closureFailed: 0,
        refreshed: 0,
        refreshSkipped: 0,
        refreshFailed: 0,
      });
    }
    expect(rosterServiceMock.closeDueRosters).not.toHaveBeenCalled();
    expect(rosterServiceMock.refreshPostedRoster).not.toHaveBeenCalled();
  });

  it("runs immediately, then on cadence, and stops cleanly", async () => {
    vi.useFakeTimers();
    rosterServiceMock.closeDueRosters.mockResolvedValue({
      dueCount: 0,
      closedRosters: [],
      failedCount: 0,
    });
    const scheduler = new RosterLifecycleSchedulerService(
      {} as any,
      rosterServiceMock as any,
      100,
      { POLLING_MODE: "active", POLLING_ENV: "prod" },
    );

    expect(scheduler.start()).toEqual({ started: true });
    await Promise.resolve();
    expect(rosterServiceMock.closeDueRosters).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(rosterServiceMock.closeDueRosters).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(rosterServiceMock.closeDueRosters).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly mutate already closed rosters when the sweep is empty", async () => {
    rosterServiceMock.closeDueRosters
      .mockResolvedValueOnce({ dueCount: 1, closedRosters: [rosterOne], failedCount: 0 })
      .mockResolvedValueOnce({ dueCount: 0, closedRosters: [], failedCount: 0 });
    rosterServiceMock.refreshPostedRoster.mockResolvedValue({ outcome: "refreshed", rosterId: "roster-1" });
    const scheduler = new RosterLifecycleSchedulerService(
      {} as any,
      rosterServiceMock as any,
      100,
      { POLLING_MODE: "active", POLLING_ENV: "prod" },
    );

    await scheduler.runCycle(1);
    await scheduler.runCycle(2);

    expect(rosterServiceMock.closeDueRosters).toHaveBeenCalledTimes(2);
    expect(rosterServiceMock.refreshPostedRoster).toHaveBeenCalledTimes(1);
  });
});

