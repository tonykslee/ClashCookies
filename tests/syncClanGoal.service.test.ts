import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSyncZeroDeviationGoal,
} from "../src/services/ClanGoalService";

const loadContextMock = vi.hoisted(() => vi.fn());
const fillerTagsMock = vi.hoisted(() => vi.fn());
const projectionMock = vi.hoisted(() => vi.fn());
const dozzleLogMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
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
vi.mock("../src/services/FillerAccountService", () => ({
  listFillerAccountTagsForGuild: fillerTagsMock,
}));
vi.mock("../src/helper/compoActualStateView", () => ({
  isCompoActualStateProjectionComplete: vi.fn().mockReturnValue(true),
  projectCompoActualStateView: projectionMock,
}));
vi.mock("../src/helper/dozzleLogger", () => ({
  dozzleLog: dozzleLogMock,
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

function makeService(
  client: any,
  botLogChannels: any,
  clock: () => Date = () => new Date(NOW),
) {
  return new SyncClanGoalService(client, botLogChannels, clock);
}

describe("SYNC_ZERO_DEVIATION", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectionMock.mockReturnValue({
      memberCount: 50,
      unresolvedWeightCount: 0,
      deviationScore: 0,
      selectedHeatMapRef: { id: 1 },
    });
    loadContextMock.mockResolvedValue(makeContext());
    fillerTagsMock.mockResolvedValue([]);
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

  afterEach(() => {
    vi.restoreAllMocks();
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
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = makeService(
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
    expect(dozzleLogMock.info).toHaveBeenCalledWith(expect.stringContaining(
      "event=readiness_capture outcome=success tracked=1 captured=1",
    ));
    expect(dozzleLogMock.info).toHaveBeenCalledWith(expect.stringContaining(
      "event=reconciliation outcome=summary candidates=1 qualified=1 delivered=1",
    ));
    expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining(
      "[clan-goals] event=sync_goal_delivery outcome=success",
    ));
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      allowedMentions: { parse: [] },
    }));
  });

  it("captures the exact sorted filler intersection from the ACTUAL roster", async () => {
    loadContextMock.mockResolvedValueOnce({
      ...makeContext(),
      clans: [{
        ...makeContext().clans[0],
        members: [
          { playerTag: "#PJJJ", clanTag: "#CLAN", playerName: "C", townHall: 18, resolvedWeight: 1, resolvedBucket: null, resolvedWeightSource: null },
          { playerTag: "#PYYY", clanTag: "#CLAN", playerName: "A", townHall: 18, resolvedWeight: 1, resolvedBucket: null, resolvedWeightSource: null },
          { playerTag: "#PQQQ", clanTag: "#CLAN", playerName: "B", townHall: 18, resolvedWeight: 1, resolvedBucket: null, resolvedWeightSource: null },
        ],
      }],
    });
    fillerTagsMock.mockResolvedValueOnce(["#PJJJ", "#PQQQ", "#P888"]);

    const service = makeService(
      { channels: { fetch: vi.fn().mockResolvedValue(makeChannel()) } } as any,
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

    expect(fillerTagsMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({
          fillerCaptureComplete: true,
          fillerPlayerTags: ["#PJJJ", "#PQQQ"],
        })],
      }),
    );
  });

  it("distinguishes exact zero fillers from an unavailable filler registry", async () => {
    fillerTagsMock.mockResolvedValueOnce(["#P888"]);
    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
    );

    await service.runCycle(NOW);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({
          fillerCaptureComplete: true,
          fillerPlayerTags: [],
        })],
      }),
    );

    prismaMock.syncClanReadinessSnapshot.createMany.mockClear();
    fillerTagsMock.mockRejectedValueOnce(new Error("registry unavailable"));
    await service.runCycle(NOW);

    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({
          fillerCaptureComplete: false,
          fillerPlayerTags: [],
          memberCount: 50,
        })],
      }),
    );
    expect(dozzleLogMock.error).toHaveBeenCalledWith(expect.stringContaining(
      "event=filler_registry_capture outcome=failure guild_id=guild-1",
    ));
  });

  it("partitions filler tags by the actual roster of each clan", async () => {
    const baseContext = makeContext();
    loadContextMock.mockResolvedValueOnce({
      ...baseContext,
      clans: [
        {
          ...baseContext.clans[0],
          members: [{
            playerTag: "#PJJJ",
            clanTag: "#CLAN",
            playerName: "J",
            townHall: 18,
            resolvedWeight: 1,
            resolvedBucket: null,
            resolvedWeightSource: null,
          }],
        },
        {
          ...baseContext.clans[0],
          clanTag: "#SEC0ND",
          clanName: "Second",
          members: [{
            playerTag: "#PQQQ",
            clanTag: "#SEC0ND",
            playerName: "Q",
            townHall: 18,
            resolvedWeight: 1,
            resolvedBucket: null,
            resolvedWeightSource: null,
          }],
        },
      ],
    });
    fillerTagsMock.mockResolvedValueOnce(["#PQQQ", "#PJJJ"]);
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([
      makeSnapshot(),
      { ...makeSnapshot(), id: "snapshot-2", clanTag: "#SEC0ND", clanName: "Second" },
    ]);

    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
    );

    await service.runCycle(NOW);

    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ clanTag: "#CLAN", fillerPlayerTags: ["#PJJJ"] }),
          expect.objectContaining({ clanTag: "#SEC0ND", fillerPlayerTags: ["#PQQQ"] }),
        ]),
      }),
    );
  });

  it("does not overwrite immutable filler facts when the registry later changes", async () => {
    loadContextMock.mockResolvedValueOnce({
      ...makeContext(),
      clans: [{
        ...makeContext().clans[0],
        members: [{
          playerTag: "#PJJJ",
          clanTag: "#CLAN",
          playerName: "J",
          townHall: 18,
          resolvedWeight: 1,
          resolvedBucket: null,
          resolvedWeightSource: null,
        }],
      }],
    });
    loadContextMock.mockResolvedValueOnce({
      ...makeContext(),
      clans: [{
        ...makeContext().clans[0],
        members: [{
          playerTag: "#PJJJ",
          clanTag: "#CLAN",
          playerName: "J",
          townHall: 18,
          resolvedWeight: 1,
          resolvedBucket: null,
          resolvedWeightSource: null,
        }],
      }],
    });
    const createdRows: any[] = [];
    prismaMock.syncClanReadinessSnapshot.createMany.mockImplementation(async ({ data }: any) => {
      for (const row of data) {
        if (!createdRows.some((existing) =>
          existing.guildId === row.guildId &&
          existing.syncTime.getTime() === row.syncTime.getTime() &&
          existing.clanTag === row.clanTag,
        )) {
          createdRows.push({ ...row, fillerPlayerTags: [...row.fillerPlayerTags] });
        }
      }
      return { count: data.length === 0 ? 0 : 1 };
    });
    fillerTagsMock.mockResolvedValueOnce(["#PJJJ"]);

    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
    );
    await service.runCycle(NOW);

    fillerTagsMock.mockResolvedValueOnce(["#PQQQ"]);
    await service.runCycle(NOW);

    expect(createdRows[0]?.fillerPlayerTags).toEqual(["#PJJJ"]);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledTimes(2);
  });

  it("captures a FAILED readiness publication while it remains inside the boundary grace window", async () => {
    prismaMock.scheduledSyncPost.findMany.mockResolvedValue([
      { id: "failed-schedule", guildId: "guild-1", syncTime: SYNC_TIME, status: "FAILED" },
    ]);
    const service = makeService(
      { channels: { fetch: vi.fn().mockResolvedValue(makeChannel()) } } as any,
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

    const result = await service.runCycle(NOW);

    expect(result.captured).toBe(1);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledTimes(1);
  });

  it("does not fetch Discord again after a delivered SyncEvent", async () => {
    const channel = makeChannel();
    const fetch = vi.fn().mockResolvedValue(channel);
    const service = makeService(
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
    dozzleLogMock.info.mockClear();
    dozzleLogMock.debug.mockClear();
    prismaMock.syncClanReadinessSnapshot.createMany.mockResolvedValue({ count: 0 });
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
    expect(dozzleLogMock.info).not.toHaveBeenCalled();
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(expect.stringContaining(
      "event=reconciliation outcome=summary candidates=1 qualified=1 delivered=0",
    ));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("keeps an idempotent capture pass out of info logs", async () => {
    prismaMock.syncClanReadinessSnapshot.createMany.mockResolvedValue({ count: 0 });
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([]);
    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
    );

    const result = await service.runCycle(NOW);

    expect(result.captured).toBe(0);
    expect(dozzleLogMock.info).not.toHaveBeenCalledWith(expect.stringContaining(
      "event=readiness_capture outcome=success",
    ));
    expect(dozzleLogMock.debug).toHaveBeenCalledWith(expect.stringContaining(
      "event=readiness_capture outcome=success tracked=1 captured=0",
    ));
  });

  it.each([
    ["CLAN_LOG", "missing_clan_log_channel"],
    ["CLAN_LEAD", "missing_clan_lead_channel"],
    ["BOT_LOG", "missing_bot_log_channel"],
    ["CUSTOM", "missing_custom_channel"],
  ] as const)(
    "keeps %s destination skips quiet and retryable",
    async (routingMode, skipReason) => {
      let destinationRepaired = false;
      let delivered = false;
      const channel = makeChannel();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
      const service = makeService(
        { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as any,
        {
          getRoutingConfigForType: vi.fn().mockImplementation(async () => ({
            routingMode,
            channelId: routingMode === "CUSTOM" && destinationRepaired ? "123" : null,
            legacy: false,
            configured: true,
          })),
          getChannelId: vi.fn().mockImplementation(async () => (
            destinationRepaired ? "123" : null
          )),
        } as any,
      );
      prismaMock.trackedClan.findMany.mockImplementation(async () => ([
        {
          tag: "#CLAN",
          logChannelId: destinationRepaired ? "123" : null,
          leaderChannelId: destinationRepaired ? "123" : null,
        },
      ]));
      prismaMock.syncEvent.findMany.mockImplementation(async () => (
        delivered
          ? [{
              guildId: "guild-1",
              syncTime: SYNC_TIME,
              clanTag: "#CLAN",
              eventType: "clan_goal:SYNC_ZERO_DEVIATION",
              createdAt: NOW,
              payload: { status: "delivered" },
            }]
          : []
      ));
      prismaMock.syncEvent.create.mockImplementation(async () => {
        delivered = true;
        return { createdAt: NOW };
      });

      const first = await service.runCycle(NOW);

      expect(first.delivered).toBe(0);
      expect(prismaMock.syncEvent.create).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(
        `reason=${skipReason}`,
      ));
      expect(channel.send).not.toHaveBeenCalled();

      destinationRepaired = true;
      const second = await service.runCycle(NOW);
      const third = await service.runCycle(NOW);

      expect(second.delivered).toBe(1);
      expect(third.delivered).toBe(0);
      expect(prismaMock.syncEvent.create).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves disabled goals unclaimed and delivers the persisted snapshot after enabling routing", async () => {
    const channel = makeChannel();
    const disabled = makeService({ channels: { fetch: vi.fn() } } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "DISABLED",
        channelId: null,
        legacy: false,
        configured: false,
      }),
      getChannelId: vi.fn(),
    } as any);

    const first = await disabled.runCycle(NOW);

    const enabled = makeService({
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "CUSTOM",
        channelId: "123",
        legacy: false,
        configured: true,
      }),
      getChannelId: vi.fn(),
    } as any);
    const second = await enabled.runCycle(NOW);

    expect(first.delivered).toBe(0);
    expect(prismaMock.syncEvent.create).toHaveBeenCalledTimes(1);
    expect(second.delivered).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("releases a delivery claim after Discord failure so a later cycle can retry", async () => {
    const channel = makeChannel();
    channel.send
      .mockRejectedValueOnce(new Error("discord unavailable"))
      .mockResolvedValueOnce({ id: "message-2" });
    const service = makeService({
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "CUSTOM",
        channelId: "123",
        legacy: false,
        configured: true,
      }),
      getChannelId: vi.fn(),
    } as any);

    const first = await service.runCycle(NOW);
    const second = await service.runCycle(NOW);

    expect(first.failed).toBe(1);
    expect(prismaMock.syncEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(second.delivered).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted zero-deviation snapshot for retry eligibility after ACTUAL changes", async () => {
    const channel = makeChannel();
    channel.send.mockRejectedValueOnce(new Error("temporary discord failure"))
      .mockResolvedValueOnce({ id: "message-2" });
    const service = makeService({
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "CUSTOM",
        channelId: "123",
        legacy: false,
        configured: true,
      }),
      getChannelId: vi.fn(),
    } as any);

    await service.runCycle(NOW);
    projectionMock.mockReturnValue({
      memberCount: 50,
      unresolvedWeightCount: 0,
      deviationScore: 0.5,
      selectedHeatMapRef: { id: 1 },
    });
    const retry = await service.runCycle(NOW);

    expect(retry.delivered).toBe(1);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("keeps two tracked clans independent at one sync boundary", async () => {
    loadContextMock.mockResolvedValueOnce({
      ...makeContext(),
      clans: [
        ...makeContext().clans,
        { ...makeContext().clans[0], clanTag: "#SECOND", clanName: "Second" },
      ],
    });
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([
      makeSnapshot(),
      { ...makeSnapshot(), id: "snapshot-2", clanTag: "#SECOND", clanName: "Second" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#CLAN", logChannelId: "123", leaderChannelId: null },
      { tag: "#SECOND", logChannelId: "456", leaderChannelId: null },
    ]);
    const channelFetch = vi.fn().mockImplementation(async (id: string) => ({
      ...makeChannel(),
      id,
    }));
    const service = makeService({ channels: { fetch: channelFetch } } as any, {
      getRoutingConfigForType: vi.fn().mockResolvedValue({
        routingMode: "CLAN_LOG",
        channelId: null,
        legacy: false,
        configured: true,
      }),
      getChannelId: vi.fn(),
    } as any);

    const result = await service.runCycle(NOW);

    expect(result.delivered).toBe(2);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.arrayContaining([
        expect.objectContaining({ clanTag: "#CLAN" }),
        expect.objectContaining({ clanTag: "#SEC0ND" }),
      ]) }),
    );
    expect(channelFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps disabled routing unclaimed and skips stale boundaries", async () => {
    const service = makeService({ channels: { fetch: vi.fn() } } as any, {
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

  it("rechecks boundary freshness after ACTUAL context loading and persists nothing when delayed", async () => {
    let clockNow = new Date(NOW);
    loadContextMock.mockImplementationOnce(async () => {
      clockNow = new Date(SYNC_TIME.getTime() + SYNC_BOUNDARY_CAPTURE_GRACE_MS + 1);
      return makeContext();
    });
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([]);
    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
      () => new Date(clockNow),
    );

    const result = await service.runCycle(NOW);

    expect(result.stale).toBe(1);
    expect(result.captured).toBe(0);
    expect(prismaMock.syncClanReadinessSnapshot.createMany).not.toHaveBeenCalled();
  });

  it("does not capture cancelled or replaced schedules even if a stale query result includes them", async () => {
    prismaMock.scheduledSyncPost.findMany.mockResolvedValue([
      { id: "cancelled", guildId: "guild-1", syncTime: SYNC_TIME, status: "CANCELLED" },
      { id: "replaced", guildId: "guild-1", syncTime: SYNC_TIME, status: "REPLACED" },
    ]);
    prismaMock.syncClanReadinessSnapshot.findMany.mockResolvedValue([]);
    const service = makeService(
      { channels: { fetch: vi.fn() } } as any,
      { getRoutingConfigForType: vi.fn(), getChannelId: vi.fn() } as any,
      () => new Date(NOW),
    );

    const result = await service.runCycle(NOW);

    expect(result.tracked).toBe(0);
    expect(result.captured).toBe(0);
    expect(loadContextMock).not.toHaveBeenCalled();
    expect(prismaMock.syncClanReadinessSnapshot.createMany).not.toHaveBeenCalled();
  });
});
