import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AutoRoleRefreshResult } from "../src/services/AutoRoleRefreshService";
import { AutoRoleSchedulerService } from "../src/services/AutoRoleSchedulerService";
import { getCoCQueueContext } from "../src/services/CoCQueueContext";

const prismaMock = vi.hoisted(() => ({
  autoRoleGuildConfig: {
    findMany: vi.fn(),
  },
  autoRoleSyncRun: {
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
}));

const refreshServiceMock = vi.hoisted(() => ({
  refreshGuild: vi.fn(),
}));

const statusServiceMock = vi.hoisted(() => ({
  markStarted: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  markSkipped: vi.fn(),
  markDisabled: vi.fn(),
  listStatuses: vi.fn(),
  getStatus: vi.fn(),
}));

const pollingModeMock = vi.hoisted(() => ({
  isMirrorPollingMode: vi.fn(),
}));

const dozzleLogMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/AutoRoleRefreshService", () => ({
  autoRoleRefreshService: refreshServiceMock,
}));

vi.mock("../src/services/BotPollJobStatusService", () => ({
  botPollJobStatusService: statusServiceMock,
}));

vi.mock("../src/services/PollingModeService", () => pollingModeMock);

vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
}));

type GuildLike = {
  id: string;
  members: {
    fetch: ReturnType<typeof vi.fn>;
  };
};

function makeGuild(id = "111111111111111111"): GuildLike {
  return {
    id,
    members: {
      fetch: vi.fn(),
    },
  };
}

describe("AutoRoleSchedulerService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T12:00:00.000Z"));
    vi.clearAllMocks();
    pollingModeMock.isMirrorPollingMode.mockReturnValue(false);
    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([]);
    prismaMock.autoRoleSyncRun.findMany.mockResolvedValue([]);
    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValue([]);
    statusServiceMock.markStarted.mockResolvedValue({});
    statusServiceMock.markSucceeded.mockResolvedValue({});
    statusServiceMock.markFailed.mockResolvedValue({});
    statusServiceMock.markSkipped.mockResolvedValue({});
    statusServiceMock.markDisabled.mockResolvedValue({});
    refreshServiceMock.refreshGuild.mockResolvedValue({
      guildId: "111111111111111111",
      scope: { kind: "guild" },
      runId: "run-1",
      evaluatedCount: 0,
      addedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      memberResults: [],
    } satisfies AutoRoleRefreshResult);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("starts an immediate cycle and registers the interval in active mode", async () => {
    const client = {
      guilds: {
        fetch: vi.fn(),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);
    const runCycleSpy = vi.spyOn(scheduler, "runCycle").mockResolvedValue({
      scanned: 0,
      due: 0,
      started: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    });
    let intervalHandler: TimerHandler | null = null;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      intervalHandler = handler;
      expect(timeout).toBe(12_345);
      return 1 as any;
    }) as any);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    const result = scheduler.start();

    expect(result).toEqual({ started: true });
    expect(intervalHandler).toEqual(expect.any(Function));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(runCycleSpy).toHaveBeenCalledTimes(1);
    intervalHandler?.();
    expect(runCycleSpy).toHaveBeenCalledTimes(2);

    scheduler.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("skips startup entirely in mirror mode", () => {
    pollingModeMock.isMirrorPollingMode.mockReturnValue(true);

    const client = {
      guilds: {
        fetch: vi.fn(),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);
    const runCycleSpy = vi.spyOn(scheduler, "runCycle").mockResolvedValue({
      scanned: 0,
      due: 0,
      started: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    });

    const result = scheduler.start();

    expect(result).toEqual({ started: false, reason: "mirror" });
    expect(runCycleSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(statusServiceMock.markDisabled).toHaveBeenCalledWith(
      "autorole_scheduler",
      expect.objectContaining({
        displayName: "Autorole scheduler",
      }),
    );
  });

  it("uses the default interval when syncIntervalMinutes is null", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: null,
      },
    ]);

    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValueOnce([
      {
        guildId: guild.id,
        _max: {
          startedAt: new Date("2026-05-18T11:01:00.000Z"),
        },
      },
    ]);

    const first = await scheduler.runCycle();
    expect(first).toMatchObject({
      scanned: 1,
      due: 0,
      started: 0,
      completed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).not.toHaveBeenCalled();

    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValueOnce([
      {
        guildId: guild.id,
        _max: {
          startedAt: new Date("2026-05-18T10:59:00.000Z"),
        },
      },
    ]);

    const second = await scheduler.runCycle();
    expect(second).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(client.guilds.fetch).toHaveBeenCalledTimes(1);
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        guild,
        guildId: guild.id,
        trigger: "SCHEDULED",
        now: new Date("2026-05-18T12:00:00.000Z"),
        telemetry: expect.objectContaining({
          refreshId: expect.stringContaining(`autorole_refresh:${guild.id}:`),
          refreshStartedAtMs: new Date("2026-05-18T12:00:00.000Z").getTime(),
          schedulerSource: "autorole_scheduler",
        }),
      }),
    );
    expect(statusServiceMock.markStarted).toHaveBeenCalled();
    expect(statusServiceMock.markSucceeded).toHaveBeenCalledWith(
      "autorole_scheduler",
      expect.objectContaining({
        displayName: "Autorole scheduler",
        intervalMs: 12345,
        metadata: expect.objectContaining({
          scanned: 1,
          due: 1,
          started: 1,
          completed: 1,
          skipped: 0,
          failed: 0,
        }),
      }),
    );
  });

  it("anchors cadence only on completed scheduled guild runs and ignores manual, failed, running, and non-guild rows", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn(),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    const completedStarts = [
      new Date("2026-05-18T11:46:00.000Z"),
      new Date("2026-05-18T11:44:00.000Z"),
    ];
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        const startedAt = completedStarts.shift();
        return startedAt
          ? [
              {
                guildId: guild.id,
                _max: {
                  startedAt,
                },
              },
            ]
          : [];
      }
      return [];
    });

    const firstResult = await scheduler.runCycle();
    const secondResult = await scheduler.runCycle();

    expect(prismaMock.autoRoleSyncRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["guildId"],
        where: {
          guildId: { in: [guild.id] },
          scope: "GUILD",
          trigger: "SCHEDULED",
          status: "COMPLETED",
        },
        _max: {
          startedAt: true,
        },
      }),
    );
    expect(firstResult).toMatchObject({
      scanned: 1,
      due: 0,
      started: 0,
      completed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(secondResult).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(client.guilds.fetch).toHaveBeenCalledTimes(1);
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=interval_not_elapsed"),
    );
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=due_after_completed_scheduled_run"),
    );
  });

  it("treats a newer failed scheduled attempt as a retry when it follows an older completed run", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:40:00.000Z"),
            },
          },
        ];
      }
      if (where?.status === "FAILED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:55:00.000Z"),
            },
          },
        ];
      }
      return [];
    });

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=retry_after_failed_scheduled_run"),
    );
  });

  it("keeps a failed attempt older than the latest completed run from producing the retry reason", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:40:00.000Z"),
            },
          },
        ];
      }
      if (where?.status === "FAILED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:35:00.000Z"),
            },
          },
        ];
      }
      return [];
    });

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=due_after_completed_scheduled_run"),
    );
    expect(dozzleLogMock.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=retry_after_failed_scheduled_run"),
    );
  });

  it("keeps a newer failure from overriding interval_not_elapsed before the completed anchor boundary", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn(),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:50:00.000Z"),
            },
          },
        ];
      }
      if (where?.status === "FAILED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:55:00.000Z"),
            },
          },
        ];
      }
      return [];
    });

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 0,
      started: 0,
      completed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).not.toHaveBeenCalled();
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=interval_not_elapsed"),
    );
    expect(dozzleLogMock.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=retry_after_failed_scheduled_run"),
    );
  });

  it("treats a failed attempt as the retry reason when no completed scheduled run exists", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        return [];
      }
      if (where?.status === "FAILED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:58:00.000Z"),
            },
          },
        ];
      }
      return [];
    });

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("cadence_reason=retry_after_failed_scheduled_run"),
    );
  });

  it("treats the absence of a completed scheduled guild run as immediately due", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 30,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValue([]);

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "SCHEDULED",
      }),
    );
  });

  it("uses the current scheduler time for CoC freshness when an overdue scheduled run executes", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);
    const now = new Date("2026-05-18T12:00:00.000Z");
    const nowMs = now.getTime();
    const intervalMs = 15 * 60_000;

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 15,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockImplementation(async ({ where }: any) => {
      if (where?.status === "COMPLETED") {
        return [
          {
            guildId: guild.id,
            _max: {
              startedAt: new Date("2026-05-18T11:25:00.000Z"),
            },
          },
        ];
      }
      if (where?.status === "FAILED") {
        return [];
      }
      return [];
    });
    refreshServiceMock.refreshGuild.mockImplementation(async () => {
      expect(getCoCQueueContext()).toMatchObject({
        priority: "background",
        source: "autorole_scheduler_guild_refresh",
        scheduledAtMs: nowMs,
        nextScheduledAtMs: nowMs + intervalMs,
      });
      return {
        guildId: guild.id,
        scope: { kind: "guild" },
        runId: "run-1",
        evaluatedCount: 0,
        addedCount: 0,
        removedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        memberResults: [],
      } satisfies AutoRoleRefreshResult;
    });

    const result = await scheduler.runCycle(nowMs);

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it("skips a guild while its previous scheduled run is still in flight", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 1,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValue([]);

    let resolveRefresh: (value: AutoRoleRefreshResult) => void = () => undefined;
    refreshServiceMock.refreshGuild.mockImplementation(
      () =>
        new Promise<AutoRoleRefreshResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const firstRun = scheduler.runCycle();
    await vi.advanceTimersByTimeAsync(61_000);
    const secondRun = scheduler.runCycle();

    await expect(secondRun).resolves.toMatchObject({
      scanned: 1,
      due: 1,
      started: 0,
      completed: 0,
      skipped: 1,
      failed: 0,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledTimes(1);

    resolveRefresh({
      guildId: guild.id,
      scope: { kind: "guild" },
      runId: "run-1",
      evaluatedCount: 0,
      addedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      memberResults: [],
    });

    await expect(firstRun).resolves.toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("marks the scheduler failed when cycle setup throws", async () => {
    const client = {
      guilds: {
        fetch: vi.fn(),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockRejectedValueOnce(new Error("cycle boom"));

    await expect(scheduler.runCycle()).rejects.toThrow("cycle boom");
    expect(statusServiceMock.markFailed).toHaveBeenCalledWith(
      "autorole_scheduler",
      expect.any(Error),
      expect.objectContaining({
        displayName: "Autorole scheduler",
        intervalMs: 12_345,
      }),
    );
  });

  it("counts a guild refresh failure as a failed scheduled run", async () => {
    const guild = makeGuild();
    const client = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(guild),
      },
    } as any;
    const scheduler = new AutoRoleSchedulerService(client, null, refreshServiceMock as any, 12_345);

    prismaMock.autoRoleGuildConfig.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        syncIntervalMinutes: 1,
      },
    ]);
    prismaMock.autoRoleSyncRun.groupBy.mockResolvedValue([]);
    refreshServiceMock.refreshGuild.mockRejectedValueOnce(new Error("Tracked clan fetch failed"));

    const result = await scheduler.runCycle();

    expect(result).toMatchObject({
      scanned: 1,
      due: 1,
      started: 1,
      completed: 0,
      skipped: 0,
      failed: 1,
    });
    expect(refreshServiceMock.refreshGuild).toHaveBeenCalledWith(
      expect.objectContaining({
        guild,
        guildId: guild.id,
        trigger: "SCHEDULED",
      }),
    );
    expect(statusServiceMock.markSucceeded).toHaveBeenCalledWith(
      "autorole_scheduler",
      expect.objectContaining({
        displayName: "Autorole scheduler",
        intervalMs: 12_345,
        metadata: expect.objectContaining({
          scanned: 1,
          due: 1,
          started: 1,
          completed: 0,
          skipped: 0,
          failed: 1,
        }),
      }),
    );
  });
});
