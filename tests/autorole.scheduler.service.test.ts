import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AutoRoleRefreshResult } from "../src/services/AutoRoleRefreshService";
import { AutoRoleSchedulerService } from "../src/services/AutoRoleSchedulerService";

const prismaMock = vi.hoisted(() => ({
  autoRoleGuildConfig: {
    findMany: vi.fn(),
  },
  autoRoleSyncRun: {
    findMany: vi.fn(),
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

    const result = scheduler.start();

    expect(result).toEqual({ started: true });
    expect(runCycleSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
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

    prismaMock.autoRoleSyncRun.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        startedAt: new Date("2026-05-18T11:01:00.000Z"),
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

    prismaMock.autoRoleSyncRun.findMany.mockResolvedValue([
      {
        guildId: guild.id,
        startedAt: new Date("2026-05-18T10:59:00.000Z"),
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
    prismaMock.autoRoleSyncRun.findMany.mockResolvedValue([]);

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
    prismaMock.autoRoleSyncRun.findMany.mockResolvedValue([]);
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
