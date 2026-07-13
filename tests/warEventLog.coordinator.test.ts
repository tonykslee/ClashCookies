import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WarEventLogService,
  resetWarReconciliationCoordinatorForTest,
} from "../src/services/WarEventLogService";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  trackedClan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  clanNotifyConfig: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetWarReconciliationCoordinatorForTest();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.trackedClan.findMany.mockResolvedValue([]);
  prismaMock.trackedClan.findUnique.mockResolvedValue(null);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.currentWar.upsert.mockResolvedValue({});
  prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
  prismaMock.clanNotifyConfig.findUnique.mockResolvedValue(null);
});

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeService(): WarEventLogService {
  return new WarEventLogService(
    { channels: { fetch: vi.fn() } } as any,
    {} as any,
  );
}

function stubTargetedPollBody(service: WarEventLogService, buildSyncGate?: Promise<unknown>) {
  const findSubscriptionSpy = vi
    .spyOn(service as any, "findSubscriptionByGuildAndTag")
    .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
  const buildSyncSpy = vi
    .spyOn(service as any, "buildPollSyncContext")
    .mockImplementation(async () => {
      if (buildSyncGate) {
        await buildSyncGate;
      }
      return { previousSync: 41, activeSync: 42 };
    });
  const processSpy = vi
    .spyOn(service as any, "processSubscription")
    .mockResolvedValue(true);
  return { findSubscriptionSpy, buildSyncSpy, processSpy };
}

describe("WarEventLogService reconciliation coordinator", () => {
  it("skips targeted reconciliation while a global poll is waiting and logs the skip", async () => {
    const service = makeService();
    const buildSyncGate = makeDeferred<void>();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const buildSyncSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockImplementation(async () => {
        await buildSyncGate.promise;
        return { previousSync: 41, activeSync: 42 };
      });
    const listTargetsSpy = vi
      .spyOn(service as any, "listPollTargets")
      .mockResolvedValue([]);
    const reconcileSpy = vi
      .spyOn((service as any).warPlanViolations, "reconcileDueEvaluations")
      .mockResolvedValue({
        requestedLimit: 20,
        processedCount: 0,
        completedCount: 0,
        insufficientDataCount: 0,
        failedCount: 0,
        skippedCount: 0,
        durationMs: 0,
      });
    const findSubscriptionSpy = vi.spyOn(
      service as any,
      "findSubscriptionByGuildAndTag",
    );
    const processSpy = vi.spyOn(service as any, "processSubscription");

    const globalPoll = service.poll();
    await flushTick();

    const targetedResult = await service.pollClan({
      guildId: " guild-1 ",
      clanTag: " aaa111 ",
    });

    expect(targetedResult).toEqual({
      processed: false,
      warEnded: false,
      skippedReason: "reconciliation_in_flight",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[war-events] event=reconciliation_skipped source=poll_clan reason=in_flight guild=guild-1 clan=#AAA111",
    );
    expect(findSubscriptionSpy).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();

    buildSyncGate.resolve();
    await globalPoll;
    expect(buildSyncSpy).toHaveBeenCalledTimes(1);
    expect(listTargetsSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("skips a second targeted reconciliation while one targeted worker is active", async () => {
    const service = makeService();
    const buildSyncGate = makeDeferred<void>();
    const { findSubscriptionSpy, buildSyncSpy, processSpy } =
      stubTargetedPollBody(service, buildSyncGate.promise);

    const firstTargeted = service.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });
    await Promise.resolve();

    const secondTargeted = await service.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    expect(secondTargeted).toEqual({
      processed: false,
      warEnded: false,
      skippedReason: "reconciliation_in_flight",
    });
    expect(findSubscriptionSpy).toHaveBeenCalledTimes(1);
    expect(buildSyncSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).not.toHaveBeenCalled();

    buildSyncGate.resolve();
    await expect(firstTargeted).resolves.toEqual({
      processed: true,
      warEnded: true,
    });
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("makes a global poll wait for an active targeted reconciliation", async () => {
    const service = makeService();
    const buildSyncGate = makeDeferred<void>();
    const targetedBuildSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockImplementation(async () => {
        await buildSyncGate.promise;
        return { previousSync: 41, activeSync: 42 };
      });
    const findSubscriptionSpy = vi
      .spyOn(service as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockResolvedValue(true);
    const listTargetsSpy = vi
      .spyOn(service as any, "listPollTargets")
      .mockResolvedValue([]);
    const reconcileSpy = vi
      .spyOn((service as any).warPlanViolations, "reconcileDueEvaluations")
      .mockResolvedValue({
        requestedLimit: 20,
        processedCount: 0,
        completedCount: 0,
        insufficientDataCount: 0,
        failedCount: 0,
        skippedCount: 0,
        durationMs: 0,
      });

    const targetedPoll = service.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });
    await flushTick();

    const globalPoll = service.poll();
    await flushTick();

    expect(targetedBuildSpy).toHaveBeenCalledTimes(1);
    expect(findSubscriptionSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).not.toHaveBeenCalled();
    expect(listTargetsSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();

    buildSyncGate.resolve();
    await expect(targetedPoll).resolves.toEqual({
      processed: true,
      warEnded: true,
    });

    await globalPoll;
    expect(targetedBuildSpy).toHaveBeenCalledTimes(2);
    expect(listTargetsSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the coordinator after a targeted reconciliation throws", async () => {
    const service = makeService();
    const findSubscriptionSpy = vi
      .spyOn(service as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const buildSyncSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockRejectedValueOnce(new Error("targeted boom"))
      .mockResolvedValueOnce({ previousSync: 41, activeSync: 42 });
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockResolvedValue(true);

    await expect(
      service.pollClan({
        guildId: "guild-1",
        clanTag: "#AAA111",
      }),
    ).rejects.toThrow("targeted boom");

    await expect(
      service.pollClan({
        guildId: "guild-1",
        clanTag: "#AAA111",
      }),
    ).resolves.toEqual({
      processed: true,
      warEnded: true,
    });
    expect(findSubscriptionSpy).toHaveBeenCalledTimes(2);
    expect(buildSyncSpy).toHaveBeenCalledTimes(2);
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the coordinator after a global reconciliation throws", async () => {
    const service = makeService();
    const buildSyncSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockRejectedValueOnce(new Error("global boom"))
      .mockResolvedValueOnce({ previousSync: 41, activeSync: 42 });
    const findSubscriptionSpy = vi
      .spyOn(service as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockResolvedValue(true);

    await expect(service.poll()).rejects.toThrow("global boom");
    await expect(
      service.pollClan({
        guildId: "guild-1",
        clanTag: "#AAA111",
      }),
    ).resolves.toEqual({
      processed: true,
      warEnded: true,
    });

    expect(buildSyncSpy).toHaveBeenCalledTimes(2);
    expect(findSubscriptionSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it("shares the same coordinator across separate service instances", async () => {
    const serviceA = makeService();
    const serviceB = makeService();
    const buildSyncGate = makeDeferred<void>();
    const targetedA = stubTargetedPollBody(serviceA, buildSyncGate.promise);
    const targetedBFindSpy = vi
      .spyOn(serviceB as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const targetedBBuildSpy = vi.spyOn(serviceB as any, "buildPollSyncContext");
    const targetedBProcessSpy = vi.spyOn(serviceB as any, "processSubscription");

    const inFlight = serviceA.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });
    await flushTick();

    const skipped = await serviceB.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    expect(skipped).toEqual({
      processed: false,
      warEnded: false,
      skippedReason: "reconciliation_in_flight",
    });
    expect(targetedA.findSubscriptionSpy).toHaveBeenCalledTimes(1);
    expect(targetedA.buildSyncSpy).toHaveBeenCalledTimes(1);
    expect(targetedA.processSpy).not.toHaveBeenCalled();
    expect(targetedBFindSpy).not.toHaveBeenCalled();
    expect(targetedBBuildSpy).not.toHaveBeenCalled();
    expect(targetedBProcessSpy).not.toHaveBeenCalled();

    buildSyncGate.resolve();
    await expect(inFlight).resolves.toEqual({
      processed: true,
      warEnded: true,
    });
  });
});
