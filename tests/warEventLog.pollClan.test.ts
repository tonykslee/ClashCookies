import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WarEventLogService } from "../src/services/WarEventLogService";

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
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.trackedClan.findMany.mockResolvedValue([]);
  prismaMock.trackedClan.findUnique.mockResolvedValue(null);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.currentWar.upsert.mockResolvedValue({});
  prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
  prismaMock.clanNotifyConfig.findUnique.mockResolvedValue(null);
});

describe("WarEventLogService.pollClan", () => {
  it("normalizes input and delegates to the same per-clan poll worker", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as any,
      {} as any,
    );
    const findSpy = vi
      .spyOn(service as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const syncSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockResolvedValue({ previousSync: 41, activeSync: 42 });
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockResolvedValue(true);
    const pollSpy = vi.spyOn(service as any, "poll");
    const refreshSpy = vi.spyOn(service as any, "refreshBattleDayPosts");
    const dispatchSpy = vi.spyOn(service as any, "dispatchDetectedEvent");

    const result = await service.pollClan({
      guildId: " guild-1 ",
      clanTag: " aaa111 ",
      sendBattleDaySwapReminders: false,
    });

    expect(result).toEqual({ processed: true, warEnded: true });
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).toHaveBeenCalledWith("guild-1", "#AAA111");
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith(
      "guild-1",
      "#AAA111",
      { previousSync: 41, activeSync: 42 },
      { sendBattleDaySwapReminders: false },
    );
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("returns a no-op when the CurrentWar row is missing", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as any,
      {} as any,
    );
    const processSpy = vi.spyOn(service as any, "processSubscription");
    const syncSpy = vi.spyOn(service as any, "buildPollSyncContext");
    const pollSpy = vi.spyOn(service as any, "poll");
    const refreshSpy = vi.spyOn(service as any, "refreshBattleDayPosts");

    const result = await service.pollClan({
      guildId: "guild-1",
      clanTag: "#aaa111",
    });

    expect(result).toEqual({ processed: false, warEnded: false });
    expect(processSpy).not.toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findMany).not.toHaveBeenCalled();
    expect(prismaMock.clanNotifyConfig.findMany).not.toHaveBeenCalled();
  });

  it("keeps duplicate-event handling inside the underlying worker", async () => {
    const service = new WarEventLogService(
      { channels: { fetch: vi.fn() } } as any,
      {} as any,
    );
    const findSpy = vi
      .spyOn(service as any, "findSubscriptionByGuildAndTag")
      .mockResolvedValue({ guildId: "guild-1", clanTag: "#AAA111" });
    const syncSpy = vi
      .spyOn(service as any, "buildPollSyncContext")
      .mockResolvedValue({ previousSync: 41, activeSync: 42 });
    const processSpy = vi
      .spyOn(service as any, "processSubscription")
      .mockResolvedValue(false);
    const pollSpy = vi.spyOn(service as any, "poll");
    const refreshSpy = vi.spyOn(service as any, "refreshBattleDayPosts");

    await service.pollClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(pollSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
