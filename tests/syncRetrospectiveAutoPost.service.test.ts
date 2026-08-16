import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SyncRetrospectiveAutoPostService,
  SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE,
} from "../src/services/SyncRetrospectiveAutoPostService";

const syncTime = new Date("2026-08-15T11:00:00.000Z");
const enabledAt = new Date("2026-08-15T12:00:00.000Z");
const completedAt = new Date("2026-08-16T12:00:00.000Z");

function makeResult() {
  return {
    identity: { guildId: "guild-1", syncNumber: 545, syncTime, cycleMapped: true },
    warSummary: { clanWarCount: 1, totalStarsKnown: 3, starsCoverage: { known: 1, total: 1 } },
    missedAttacks: { missedAttacksKnownTotal: 0, coverage: { completeClans: 1, warClans: 1 } },
    fwaViolations: { violationKnownTotal: 0, coverage: { completedFwaEvaluations: 1, fwaWars: 1 } },
    readiness: { averageDeviation: 0, deviationCoverage: { valid: 1, totalSnapshots: 1 } },
    fillers: { fillerKnownTotal: 0, fillerCoverage: { complete: 1, totalSnapshots: 1 } },
    clans: [{
      identity: {
        clanTag: "#AAA111", clanName: "Alpha", warId: 1, matchType: "FWA",
        expectedOutcome: "WIN", actualOutcome: "WIN",
      },
      war: { stars: 3 },
      missedAttacks: { total: 0, coverageComplete: true, players: [] },
      violations: { total: 0, evaluationComplete: true, applicable: true, details: [] },
      readiness: { memberCount: 50, deviationScore: 0, projectionComplete: true, dataAvailable: true },
      fillers: { fillerCount: 0, fillerPlayerTags: [], fillerCaptureComplete: true },
    }],
  };
}

function makeEventDb(
  candidates = [{ guildId: "guild-1", syncNumber: 545, syncTime }],
  initialEvents: Array<{ guildId: string; syncTime: Date; payload: any; createdAt?: Date }> = [],
) {
  const events = new Map<string, any>();
  const key = (input: { guildId: string; syncTime: Date; clanTag: string; eventType: string }) =>
    `${input.guildId}|${input.syncTime.toISOString()}|${input.clanTag}|${input.eventType}`;
  const eventModel = {
    events,
    findMany: vi.fn(async () => [...events.values()]),
    findFirst: vi.fn(async ({ where }: any) => events.get(key(where)) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const eventKey = key(data);
      if (events.has(eventKey)) throw new Error("unique constraint");
      const row = { ...data, createdAt: new Date("2026-08-16T12:05:00.000Z") };
      events.set(eventKey, row);
      return { id: "event-1", createdAt: row.createdAt };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = events.get(key(where));
      if (!row || row.createdAt.getTime() !== where.createdAt.getTime()) return { count: 0 };
      row.payload = data.payload;
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const eventKey = key(where);
      const row = events.get(eventKey);
      if (!row || (where.createdAt && row.createdAt.getTime() !== where.createdAt.getTime())) return { count: 0 };
      events.delete(eventKey);
      return { count: 1 };
    }),
  };
  for (const initial of initialEvents) {
    const row = {
      guildId: initial.guildId,
      syncTime: initial.syncTime,
      clanTag: "",
      eventType: SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE,
      payload: initial.payload,
      createdAt: initial.createdAt ?? new Date("2026-08-16T12:05:00.000Z"),
    };
    events.set(key(row), row);
  }
  return {
    syncCycle: { findMany: vi.fn(async () => candidates) },
    syncEvent: eventModel,
  };
}

function makeDependencies(overrides: {
  routingMode?: "CUSTOM" | "BOT_LOG" | "DISABLED";
  enabledAtValue?: Date | null;
  completion?: { complete: boolean; completedAt: Date | null; reason: string; participantClanCount: number; endedParticipantClanCount: number };
  send?: ReturnType<typeof vi.fn>;
  candidates?: Array<{ guildId: string; syncNumber: number; syncTime: Date }>;
  initialEvents?: Array<{ guildId: string; syncTime: Date; payload: any; createdAt?: Date }>;
} = {}) {
  const db = makeEventDb(overrides.candidates, overrides.initialEvents);
  const send = overrides.send ?? vi.fn().mockResolvedValue({ id: "message-1" });
  const channel = {
    id: "channel-1",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: vi.fn().mockReturnValue({ has: vi.fn().mockReturnValue(true) }),
    send,
  };
  const guild = {
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  };
  const client = { user: { id: "bot-1" }, guilds: { fetch: vi.fn().mockResolvedValue(guild) } } as any;
  const completion = overrides.completion ?? {
    complete: true,
    completedAt,
    reason: "complete",
    participantClanCount: 1,
    endedParticipantClanCount: 1,
  };
  const retrospectiveService = {
    getCompletionState: vi.fn().mockResolvedValue(completion),
    getBySyncNumber: vi.fn().mockResolvedValue(makeResult()),
  };
  const routing = {
    getRoutingConfigForType: vi.fn().mockResolvedValue({
      configured: overrides.routingMode !== "DISABLED",
      routingMode: overrides.routingMode ?? "CUSTOM",
      channelId: "channel-1",
      legacy: false,
    }),
    getSyncRetrospectiveEnabledAt: vi.fn().mockResolvedValue(
      overrides.enabledAtValue === undefined ? enabledAt : overrides.enabledAtValue,
    ),
    getChannelId: vi.fn().mockResolvedValue("channel-1"),
  };
  return { db, client, channel, send, retrospectiveService, routing };
}

afterEach(() => {
  delete process.env.POLLING_MODE;
});

describe("SyncRetrospectiveAutoPostService", () => {
  it.each(["delivered", "suppressed"] as const)(
    "filters 100 %s candidates before any routing or completion lookup",
    async (status) => {
      const candidates = Array.from({ length: 100 }, (_, index) => ({
        guildId: "guild-1",
        syncNumber: 545 + index,
        syncTime: new Date(syncTime.getTime() + index * 1_000),
      }));
      const deps = makeDependencies({
        candidates,
        initialEvents: candidates.map((candidate) => ({
          guildId: candidate.guildId,
          syncTime: candidate.syncTime,
          payload: { status },
        })),
      });
      const service = new SyncRetrospectiveAutoPostService(
        deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
      );

      await service.runCycle(completedAt);

      expect(deps.db.syncEvent.findMany).toHaveBeenCalledTimes(1);
      expect(deps.routing.getRoutingConfigForType).not.toHaveBeenCalled();
      expect(deps.routing.getSyncRetrospectiveEnabledAt).not.toHaveBeenCalled();
      expect(deps.retrospectiveService.getCompletionState).not.toHaveBeenCalled();
      expect(deps.client.guilds.fetch).not.toHaveBeenCalled();
      expect(deps.send).not.toHaveBeenCalled();
    },
  );

  it("resolves a disabled guild once before skipping all pending candidates", async () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      guildId: "guild-1",
      syncNumber: 545 + index,
      syncTime: new Date(syncTime.getTime() + index * 1_000),
    }));
    const deps = makeDependencies({ candidates, routingMode: "DISABLED" });

    await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(deps.routing.getRoutingConfigForType).toHaveBeenCalledTimes(1);
    expect(deps.routing.getSyncRetrospectiveEnabledAt).not.toHaveBeenCalled();
    expect(deps.retrospectiveService.getCompletionState).not.toHaveBeenCalled();
  });

  it("deduplicates enabledAt and channel lookups per enabled guild", async () => {
    const candidates = [545, 546, 547].map((syncNumber, index) => ({
      guildId: "guild-1", syncNumber, syncTime: new Date(syncTime.getTime() + index * 1_000),
    }));
    const custom = makeDependencies({ candidates, routingMode: "CUSTOM" });
    await new SyncRetrospectiveAutoPostService(
      custom.client, custom.routing as any, custom.retrospectiveService as any, custom.db as any,
    ).runCycle(completedAt);
    expect(custom.routing.getRoutingConfigForType).toHaveBeenCalledTimes(1);
    expect(custom.routing.getSyncRetrospectiveEnabledAt).toHaveBeenCalledTimes(1);
    expect(custom.routing.getChannelId).not.toHaveBeenCalled();
    expect(custom.retrospectiveService.getCompletionState).toHaveBeenCalledTimes(3);

    const botLog = makeDependencies({ candidates, routingMode: "BOT_LOG" });
    await new SyncRetrospectiveAutoPostService(
      botLog.client, botLog.routing as any, botLog.retrospectiveService as any, botLog.db as any,
    ).runCycle(completedAt);
    expect(botLog.routing.getRoutingConfigForType).toHaveBeenCalledTimes(1);
    expect(botLog.routing.getSyncRetrospectiveEnabledAt).toHaveBeenCalledTimes(1);
    expect(botLog.routing.getChannelId).toHaveBeenCalledTimes(1);
  });

  it("resolves routing once per guild", async () => {
    const candidates = [
      { guildId: "guild-1", syncNumber: 545, syncTime },
      { guildId: "guild-2", syncNumber: 546, syncTime: new Date(syncTime.getTime() + 1_000) },
    ];
    const deps = makeDependencies({ candidates, routingMode: "CUSTOM" });

    await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(deps.routing.getRoutingConfigForType).toHaveBeenCalledTimes(2);
    expect(deps.routing.getSyncRetrospectiveEnabledAt).toHaveBeenCalledTimes(2);
  });

  it("counts one routing failure per affected guild after deduplication", async () => {
    const candidates = [545, 546, 547].map((syncNumber, index) => ({
      guildId: "guild-1", syncNumber, syncTime: new Date(syncTime.getTime() + index * 1_000),
    }));
    const deps = makeDependencies({ candidates });
    deps.routing.getRoutingConfigForType.mockRejectedValue(new Error("routing database unavailable"));

    const summary = await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(summary.failed).toBe(1);
    expect(deps.routing.getRoutingConfigForType).toHaveBeenCalledTimes(1);
    expect(deps.retrospectiveService.getCompletionState).not.toHaveBeenCalled();
  });

  it("does not read completion, claim, or send when disabled", async () => {
    const deps = makeDependencies({ routingMode: "DISABLED" });
    const summary = await new SyncRetrospectiveAutoPostService(
      deps.client,
      deps.routing as any,
      deps.retrospectiveService as any,
      deps.db as any,
    ).runCycle(completedAt);

    expect(summary.delivered).toBe(0);
    expect(deps.retrospectiveService.getCompletionState).not.toHaveBeenCalled();
    expect(deps.db.syncEvent.create).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("waits for every participant to have canonical ended history", async () => {
    const deps = makeDependencies({ completion: {
      complete: false, completedAt: null, reason: "incomplete_history",
      participantClanCount: 2, endedParticipantClanCount: 1,
    } });
    const summary = await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(summary.delivered).toBe(0);
    expect(deps.db.syncEvent.create).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("claims, renders the manual output, sends once, and marks delivered", async () => {
    const deps = makeDependencies();
    const service = new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    );
    const summary = await service.runCycle(completedAt);

    expect(summary.delivered).toBe(1);
    expect(deps.retrospectiveService.getBySyncNumber).toHaveBeenCalledWith({ guildId: "guild-1", syncNumber: 545 });
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
    expect(deps.db.syncEvent.events.get(`guild-1|${syncTime.toISOString()}||${SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE}`).payload).toMatchObject({
      status: "delivered", syncNumber: 545, channelId: "channel-1", messageId: "message-1",
    });

    await service.runCycle(completedAt);
    expect(deps.retrospectiveService.getCompletionState).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("allows completion exactly at enabledAt and when enabled during the active sync", async () => {
    const equal = makeDependencies({ enabledAtValue: completedAt });
    await new SyncRetrospectiveAutoPostService(equal.client, equal.routing as any, equal.retrospectiveService as any, equal.db as any)
      .runCycle(completedAt);
    expect(equal.send).toHaveBeenCalledTimes(1);

    const active = makeDependencies({ enabledAtValue: new Date("2026-08-16T11:00:00.000Z") });
    await new SyncRetrospectiveAutoPostService(active.client, active.routing as any, active.retrospectiveService as any, active.db as any)
      .runCycle(completedAt);
    expect(active.send).toHaveBeenCalledTimes(1);
  });

  it("suppresses completed-before-enabled syncs durably", async () => {
    const deps = makeDependencies({ enabledAtValue: new Date("2026-08-17T00:00:00.000Z") });
    const service = new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    );
    await service.runCycle(completedAt);
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.db.syncEvent.events.values().next().value.payload).toMatchObject({ status: "suppressed", reason: "completed_before_enabled" });
    await service.runCycle(completedAt);
    expect(deps.retrospectiveService.getCompletionState).toHaveBeenCalledTimes(1);
  });

  it("does not steal a fresh claimed reservation while suppressing", async () => {
    const deps = makeDependencies({
      enabledAtValue: new Date("2026-08-17T00:00:00.000Z"),
      initialEvents: [{
        guildId: "guild-1", syncTime, payload: { status: "claimed" }, createdAt: completedAt,
      }],
    });
    await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(deps.db.syncEvent.events.get(`guild-1|${syncTime.toISOString()}||${SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE}`).payload)
      .toMatchObject({ status: "claimed" });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("reclaims an expired claimed reservation and suppresses it", async () => {
    const deps = makeDependencies({
      enabledAtValue: new Date("2026-08-17T00:00:00.000Z"),
      initialEvents: [{
        guildId: "guild-1", syncTime, payload: { status: "claimed" }, createdAt: new Date("2026-08-15T00:00:00.000Z"),
      }],
    });
    await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);
    expect(deps.db.syncEvent.events.get(`guild-1|${syncTime.toISOString()}||${SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE}`).payload)
      .toMatchObject({ status: "suppressed" });

    await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);
    expect(deps.retrospectiveService.getCompletionState).toHaveBeenCalledTimes(1);
  });

  it("counts claim and suppression database failures as failures", async () => {
    const claimFailure = makeDependencies();
    claimFailure.db.syncEvent.findFirst.mockRejectedValueOnce(new Error("claim database unavailable"));
    const claimSummary = await new SyncRetrospectiveAutoPostService(
      claimFailure.client, claimFailure.routing as any, claimFailure.retrospectiveService as any, claimFailure.db as any,
    ).runCycle(completedAt);
    expect(claimSummary.failed).toBe(1);
    expect(claimFailure.send).not.toHaveBeenCalled();

    const suppressionFailure = makeDependencies({
      enabledAtValue: new Date("2026-08-17T00:00:00.000Z"),
    });
    suppressionFailure.db.syncEvent.create.mockRejectedValueOnce(new Error("suppression database unavailable"));
    const suppressionSummary = await new SyncRetrospectiveAutoPostService(
      suppressionFailure.client, suppressionFailure.routing as any, suppressionFailure.retrospectiveService as any, suppressionFailure.db as any,
    ).runCycle(completedAt);
    expect(suppressionSummary.failed).toBe(1);
    expect(suppressionSummary.suppressed).toBe(0);
  });

  it("releases a failed send so a later reconciliation can retry", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("discord unavailable"))
      .mockResolvedValueOnce({ id: "message-2" });
    const deps = makeDependencies({ send });
    const service = new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    );
    await service.runCycle(completedAt);
    expect(deps.db.syncEvent.events.size).toBe(0);
    await service.runCycle(completedAt);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is read-only and sends nothing in mirror mode", async () => {
    process.env.POLLING_MODE = "mirror";
    const deps = makeDependencies();
    const summary = await new SyncRetrospectiveAutoPostService(
      deps.client, deps.routing as any, deps.retrospectiveService as any, deps.db as any,
    ).runCycle(completedAt);

    expect(summary).toEqual({ candidates: 0, complete: 0, suppressed: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(deps.db.syncCycle.findMany).not.toHaveBeenCalled();
    expect(deps.db.syncEvent.create).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
});
