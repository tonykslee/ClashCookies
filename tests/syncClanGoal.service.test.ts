import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSyncZeroDeviationGoal,
} from "../src/services/ClanGoalService";

const loadContextMock = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  scheduledSyncPost: { findMany: vi.fn() },
  syncClanReadinessSnapshot: { findMany: vi.fn(), createMany: vi.fn() },
  syncEvent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  trackedClan: { findMany: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));
vi.mock("../src/services/CompoActualStateService", () => ({
  loadCompoActualStateContext: loadContextMock,
}));
vi.mock("../src/helper/compoActualStateView", () => ({
  isCompoActualStateProjectionComplete: vi.fn().mockReturnValue(true),
  projectCompoActualStateView: vi.fn().mockReturnValue({
    memberCount: 50,
    unresolvedWeightCount: 0,
    deviationScore: 0,
    selectedHeatMapRef: { id: 1 },
  }),
}));

import {
  SYNC_BOUNDARY_CAPTURE_GRACE_MS,
  SyncClanGoalService,
} from "../src/services/SyncClanGoalService";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const SYNC_TIME = new Date(NOW.getTime() - 15_000);

function makeContext() {
  return {
    trackedClanTags: ["#CLAN"],
    renderableClanTags: ["#CLAN"],
    latestSourceSyncedAt: new Date(NOW.getTime() - 1_000),
    heatMapRefs: [{ id: 1 }],
    clans: [
      {
        clanTag: "#CLAN",
        clanName: "Clan",
        shortName: null,
        base: {
          resolvedTotalWeight: 1,
          unresolvedWeightCount: 0,
          deferredWeightCount: 0,
          memberCount: 50,
          bucketCounts: {
            TH18: 0,
            TH17: 0,
            TH16: 0,
            TH15: 0,
            TH14: 0,
            TH13_OR_LOWER: 0,
          },
        },
        members: [],
      },
    ],
  };
}

function makeSnapshot() {
  return {
    id: "snapshot-1",
    guildId: "guild-1",
    syncTime: SYNC_TIME,
    clanTag: "#CLAN",
    clanName: "Clan",
    memberCount: 50,
    unresolvedWeightCount: 0,
    deviationScore: 0,
    projectionComplete: true,
    sourceSyncedAt: new Date(NOW.getTime() - 1_000),
  };
}

function makeChannel() {
  return {
    id: "channel-1",
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: "message-1" }),
  };
}

describe("SYNC_ZERO_DEVIATION", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadContextMock.mockResolvedValue(makeContext());
    prismaMock.scheduledSyncPost.findMany.mockResolvedValue([
      { id: "schedule-1", guildId: "guild-1", syncTime: SYNC_TIME, status: "PUBLISHED" },
    ]);
    prismaMock.syncClanReadinessSnapshot.createMany.mockResolvedValue({ count: 1 });
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([makeSnapshot()]);
    prismaMock.syncEvent.findMany.mockResolvedValue([]);
    prismaMock.syncEvent.findFirst.mockResolvedValue(null);
    prismaMock.syncEvent.create.mockResolvedValue({ createdAt: NOW });
    prismaMock.syncEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.syncEvent.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CLAN", logChannelId: "123", leaderChannelId: null },
    ]);
  });

  it("fails closed unless the immutable snapshot is a complete 50-player zero", () => {
    expect(evaluateSyncZeroDeviationGoal({
      memberCount: 49,
      projectionComplete: true,
      deviationScore: 0,
    }).qualified).toBe(false);
    expect(evaluateSyncZeroDeviationGoal({
      memberCount: 50,
      projectionComplete: false,
      deviationScore: 0,
    }).qualified).toBe(false);
    expect(evaluateSyncZeroDeviationGoal({
      memberCount: 50,
      projectionComplete: true,
      deviationScore: null,
    }).qualified).toBe(false);
    expect(evaluateSyncZeroDeviationGoal({
      memberCount: 50,
      projectionComplete: true,
      deviationScore: 0.1,
    }).qualified).toBe(false);
    expect(evaluateSyncZeroDeviationGoal({
      memberCount: 50,
      projectionComplete: true,
      deviationScore: 0,
    }).qualified).toBe(true);
  });

  it("captures a boundary once and posts through the routed non-pinging destination", async () => {
    const channel = makeChannel();
    const service = new SyncClanGoalService(
      { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any,
      {
        getRoutingConfigForType: vi.fn().mockResolvedValue({
          routingMode: "CLAN_LOG",
          channelId: null,
          legacy: false,
          configured: true,
        }),
        getChannelId: vi.fn(),
      } as any,
    );

    const first = await service.runCycle(NOW);

    expect(first.captured).toBe(1);
    expect(first.qualified).toBe(1);
    expect(first.delivered).toBe(1);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
    }));
  });

  it("does not fetch Discord again after a delivered SyncEvent", async () => {
    const channel = makeChannel();
    const fetch = vi.fn().mockResolvedValue(channel);
    const service = new SyncClanGoalService(
      { channels: { fetch } } as any,
      {
        getRoutingConfigForType: vi.fn().mockResolvedValue({
          routingMode: "CUSTOM",
          channelId: "123",
          legacy: false,
          configured: true,
        }),
        getChannelId: vi.fn(),
      } as any,
    );

    await service.runCycle(NOW);
    prismaMock.syncEvent.findMany.mockResolvedValue([{
      guildId: "guild-1",
      syncTime: SYNC_TIME,
      clanTag: "#CLAN",
      eventType: "clan_goal:SYNC_ZERO_DEVIATION",
      createdAt: NOW,
      payload: { status: "delivered" },
    }]);
    const second = await service.runCycle(NOW);

    expect(second.delivered).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled routing unclaimed and skips stale boundaries", async () => {
    const service = new SyncClanGoalService({ channels: { fetch: vi.fn() } } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "DISABLED",
        channelId: null,
        legacy: false,
        configured: false,
      }),
      getChannelId: vi.fn(),
    } as any);
    prismaMock.scheduledSyncPost.findMany.mockResolvedValue([
      {
        id: "old",
        guildId: "guild-1",
        syncTime: new Date(NOW.getTime() - SYNC_BOUNDARY_CAPTURE_GRACE_MS - 1),
        status: "FAILED",
      },
    ]);

    const result = await service.runCycle(NOW);

    expect(result.stale).toBe(1);
    expect(result.captured).toBe(0);
    expect(prismaMock.syncEvent.create).not.toHaveBeenCalled();
  });
});
