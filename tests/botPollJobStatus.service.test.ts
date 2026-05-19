import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  botPollJobStatus: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { BotPollJobStatusService } from "../src/services/BotPollJobStatusService";

describe("BotPollJobStatusService", () => {
  const service = new BotPollJobStatusService();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    prismaMock.botPollJobStatus.upsert.mockImplementation(async (args: any) => ({
      jobKey: args.where.jobKey,
      ...args.create,
      ...args.update,
    }));
    prismaMock.botPollJobStatus.findMany.mockResolvedValue([]);
    prismaMock.botPollJobStatus.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a job started and increments the run count", async () => {
    const startedAt = new Date("2026-05-19T12:00:00.000Z");
    vi.setSystemTime(startedAt);

    await service.markStarted("autorole_scheduler", {
      displayName: "Autorole scheduler",
      intervalMs: 3_600_000,
      nextDueAt: new Date("2026-05-19T13:00:00.000Z"),
      metadata: { trigger: "startup" },
    });

    expect(prismaMock.botPollJobStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobKey: "autorole_scheduler" },
        create: expect.objectContaining({
          jobKey: "autorole_scheduler",
          displayName: "Autorole scheduler",
          status: "running",
          runCount: 1,
          failureCount: 0,
        }),
        update: expect.objectContaining({
          status: "running",
          runCount: { increment: 1 },
        }),
      }),
    );
  });

  it("marks a job succeeded and stores the finish timestamps", async () => {
    const now = new Date("2026-05-19T12:00:00.000Z");
    vi.setSystemTime(now);

    await service.markSucceeded("activity_observe_cycle", {
      displayName: "Activity observe",
      intervalMs: 1_800_000,
      nextDueAt: new Date("2026-05-19T12:30:00.000Z"),
    });

    const call = prismaMock.botPollJobStatus.upsert.mock.calls[0]?.[0] as any;
    expect(call.create).toEqual(
      expect.objectContaining({
        status: "idle",
        lastFinishedAt: now,
        lastSuccessAt: now,
      }),
    );
    expect(call.update).toEqual(
      expect.objectContaining({
        status: "idle",
        lastFinishedAt: now,
        lastSuccessAt: now,
      }),
    );
  });

  it("marks a job failed and truncates long errors", async () => {
    const longError = new Error("x".repeat(2_000));

    await service.markFailed("autorole_scheduler", longError, {
      displayName: "Autorole scheduler",
      intervalMs: 3_600_000,
      nextDueAt: new Date("2026-05-19T13:00:00.000Z"),
    });

    const call = prismaMock.botPollJobStatus.upsert.mock.calls[0]?.[0] as any;
    expect(String(call.create.lastError)).toContain("truncated");
    expect(String(call.create.lastError).length).toBeLessThanOrEqual(900);
    expect(call.update.failureCount).toEqual({ increment: 1 });
  });

  it("marks skipped and disabled jobs", async () => {
    await service.markSkipped("activity_observe_cycle", {
      displayName: "Activity observe",
      intervalMs: 1_800_000,
      nextDueAt: new Date("2026-05-19T12:30:00.000Z"),
      metadata: { reason: "queue" },
    });
    await service.markDisabled("autorole_scheduler", {
      displayName: "Autorole scheduler",
      intervalMs: 3_600_000,
      metadata: { reason: "mirror" },
    });

    expect(prismaMock.botPollJobStatus.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.botPollJobStatus.upsert.mock.calls[0]?.[0].update.status).toBe("skipped");
    expect(prismaMock.botPollJobStatus.upsert.mock.calls[1]?.[0].update.status).toBe("disabled");
  });

  it("lists and loads a single job row", async () => {
    prismaMock.botPollJobStatus.findMany.mockResolvedValueOnce([{ jobKey: "job-1" }]);
    prismaMock.botPollJobStatus.findUnique.mockResolvedValueOnce({ jobKey: "job-2" });

    await expect(service.listStatuses()).resolves.toEqual([{ jobKey: "job-1" }]);
    await expect(service.getStatus("job-2")).resolves.toEqual({ jobKey: "job-2" });
  });
});
