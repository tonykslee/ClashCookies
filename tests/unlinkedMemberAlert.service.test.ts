import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UNLINKED_DB_STAGE_TIMEOUT_MS,
  UnlinkedStageTimeoutError,
} from "../src/services/UnlinkedMemberAlertService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  banRecord: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  unlinkedAlertConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  bannedPlayerJoinAlert: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  unlinkedPlayer: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  botSetting: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

const todoSnapshotMock = vi.hoisted(() => ({
  loadActiveCwlWarsByClan: vi.fn(),
  buildActiveCwlClanByPlayerTag: vi.fn(),
}));

const botLogChannelServiceMock = vi.hoisted(() => ({
  getChannelId: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/TodoSnapshotService", () => todoSnapshotMock);

vi.mock("../src/services/BotLogChannelService", () => ({
  botLogChannelService: {
    getChannelId: botLogChannelServiceMock.getChannelId,
  },
}));

import {
  buildUnlinkedAlertContent,
  UnlinkedMemberAlertService,
} from "../src/services/UnlinkedMemberAlertService";

function createClient(channelMap?: Map<string, unknown>) {
  const channels =
    channelMap ??
    new Map<string, unknown>([
      [
        "111111111111111111",
        {
          id: "111111111111111111",
          send: vi.fn().mockResolvedValue(undefined),
        },
      ],
      [
        "222222222222222222",
        {
          id: "222222222222222222",
          send: vi.fn().mockResolvedValue(undefined),
        },
      ],
    ]);

  return {
    guilds: {
      cache: new Map([
        [
          "guild-1",
          {
            channels: {
              cache: channels,
              fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
            },
          },
        ],
      ]),
      fetch: vi.fn(async () => null),
    },
  } as any;
}

describe("UnlinkedMemberAlertService", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.banRecord.findMany.mockResolvedValue([]);
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue(null);
    prismaMock.unlinkedAlertConfig.upsert.mockResolvedValue(undefined);
    prismaMock.bannedPlayerJoinAlert.findMany.mockResolvedValue([]);
    prismaMock.bannedPlayerJoinAlert.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.bannedPlayerJoinAlert.upsert.mockResolvedValue(undefined);
    prismaMock.bannedPlayerJoinAlert.update.mockResolvedValue(undefined);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([]);
    prismaMock.unlinkedPlayer.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.unlinkedPlayer.upsert.mockResolvedValue(undefined);
    prismaMock.unlinkedPlayer.update.mockResolvedValue(undefined);

    todoSnapshotMock.loadActiveCwlWarsByClan.mockResolvedValue(new Map());
    todoSnapshotMock.buildActiveCwlClanByPlayerTag.mockReturnValue(new Map());
    botLogChannelServiceMock.getChannelId.mockResolvedValue(null);
  });

  it("renders the required plain-text alert copy", () => {
    expect(
      buildUnlinkedAlertContent({
        playerName: "Alpha",
        playerTag: "#PYLQ0289",
        clanName: "Clan One",
      }),
    ).toBe("An unlinked player, Alpha (`#PYLQ0289`), has joined **Clan One**.");
  });

  it("reads persisted unresolved rows without live clan fetches", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      },
    ]);
    const service = new UnlinkedMemberAlertService();

    const result = await service.listPersistedUnlinkedMembers({
      guildId: "guild-1",
    });

    expect(prismaMock.unlinkedPlayer.findMany).toHaveBeenCalledWith({
      where: { guildId: "guild-1" },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
      select: {
        playerTag: true,
        playerName: true,
        clanTag: true,
        clanName: true,
      },
    });
    expect(result).toEqual([
      {
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      },
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query status=started"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query status=completed"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[unlinked] stage=persisted_unlinked_query_summary guild=guild-1 clan=all row_count=1"),
    );
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("defaults missing routing config to clan-log mode", async () => {
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue(null);
    const service = new UnlinkedMemberAlertService();

    await expect(
      service.getAlertRoutingConfig("guild-1"),
    ).resolves.toEqual({
      routingMode: "CLAN_LOG",
      channelId: null,
    });
  });

  it("resolves a legacy custom routing row as custom mode", async () => {
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: null,
      channelId: "111111111111111111",
    });
    const service = new UnlinkedMemberAlertService();

    await expect(
      service.getAlertRoutingConfig("guild-1"),
    ).resolves.toEqual({
      routingMode: "CUSTOM",
      channelId: "111111111111111111",
    });
  });

  it("filters persisted unresolved rows by clan tag", async () => {
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      },
    ]);
    const service = new UnlinkedMemberAlertService();

    const result = await service.listPersistedUnlinkedMembers({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
    });

    expect(prismaMock.unlinkedPlayer.findMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        clanTag: "#2QG2C08UP",
      },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
      select: {
        playerTag: true,
        playerName: true,
        clanTag: true,
        clanName: true,
      },
    });
    expect(result).toEqual([
      {
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      },
    ]);
  });

  it("treats PlayerLink rows without a Discord user as unlinked", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha Clan", logChannelId: "222222222222222222" },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", discordUserId: null },
    ]);
    const service = new UnlinkedMemberAlertService();

    const result = await service.listCurrentUnlinkedMembers({
      guildId: "guild-1",
      cocService: {
        getClan: vi.fn().mockResolvedValue({
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          members: [{ tag: "#PYLQ0289", name: "One" }],
        }),
      } as any,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.playerTag).toBe("#PYLQ0289");
  });

  it("times out a stalled persisted unresolved query and logs the slow stage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
    try {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      prismaMock.unlinkedPlayer.findMany.mockImplementation(
        () =>
          new Promise(() => {
            // intentionally unresolved to exercise the bounded DB timeout
          }),
      );
      const service = new UnlinkedMemberAlertService();

      const outcomePromise = service
        .listPersistedUnlinkedMembers({
          guildId: "guild-1",
          clanTag: "#2QG2C08UP",
        })
        .then(
          () => ({ ok: true as const, error: null as null }),
          (error) => ({ ok: false as const, error }),
        );

      await vi.advanceTimersByTimeAsync(UNLINKED_DB_STAGE_TIMEOUT_MS + 1);
      const outcome = await outcomePromise;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(UnlinkedStageTimeoutError);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[unlinked] stage=persisted_unlinked_query status=started"),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[unlinked] stage=persisted_unlinked_query status=timeout"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled player-link query and logs the slow stage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
    try {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: "#2QG2C08UP", name: "Alpha Clan", logChannelId: "222222222222222222" },
      ]);
      prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
      prismaMock.playerLink.findMany.mockImplementation(
        () =>
          new Promise(() => {
            // intentionally unresolved to exercise the bounded DB timeout
          }),
      );
      const service = new UnlinkedMemberAlertService();

      const outcomePromise = service
        .listCurrentUnlinkedMembers({
        guildId: "guild-1",
        cocService: {
          getClan: vi.fn().mockResolvedValue({
            tag: "#2QG2C08UP",
            name: "Alpha Clan",
            members: [{ tag: "#PYLQ0289", name: "One" }],
          }),
        } as any,
        })
        .then(
          () => ({ ok: true as const, error: null as null }),
          (error) => ({ ok: false as const, error }),
        );

      await vi.advanceTimersByTimeAsync(UNLINKED_DB_STAGE_TIMEOUT_MS + 1);
      const outcome = await outcomePromise;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(UnlinkedStageTimeoutError);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[unlinked] stage=player_link_query status=started"),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[unlinked] stage=player_link_query status=timeout"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("posts one alert for a newly observed unresolved join", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      channelId: "111111111111111111",
    });
    const client = createClient();
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("111111111111111111").send;
    expect(send).toHaveBeenCalledWith({
      content: "An unlinked player, One (`#PYLQ0289`), has joined **Alpha Clan**.",
      allowedMentions: { parse: [] },
    });
    expect(prismaMock.unlinkedPlayer.upsert).toHaveBeenCalled();
    expect(prismaMock.unlinkedPlayer.update).toHaveBeenCalled();
    expect(result).toEqual({
      unresolvedCount: 1,
      alertedCount: 1,
      resolvedCount: 0,
    });
  });

  it("alerts once when the bot first notices an already-present unresolved player after restart", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue(null);
    const client = createClient();
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(result.alertedCount).toBe(1);
  });

  it("does not re-alert while the player remains unresolved", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        alertedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    const client = createClient();
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("222222222222222222").send;
    expect(send).not.toHaveBeenCalled();
    expect(result.alertedCount).toBe(0);
  });

  it("resolves unresolved state when the player later links", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        alertedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", discordUserId: "111111111111111111" },
    ]);
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client: createClient(),
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(prismaMock.unlinkedPlayer.deleteMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        playerTag: { in: ["#PYLQ0289"] },
      },
    });
    expect(result.resolvedCount).toBe(1);
  });

  it("resolves unresolved state when the player leaves all tracked clans", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        playerName: "One",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        alertedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client: createClient(),
      guildId: "guild-1",
      cocService: {
        getClan: vi.fn(),
      } as any,
    });

    expect(prismaMock.unlinkedPlayer.deleteMany).toHaveBeenCalled();
    expect(result.resolvedCount).toBe(1);
  });

  it("defaults missing alert config to clan-log routing", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue(null);
    const client = createClient();
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("222222222222222222").send;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resolves a legacy custom config row as custom routing", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "333333333333333333" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: null,
      channelId: "111111111111111111",
    });
    const threadSend = vi.fn().mockResolvedValue(undefined);
    const fallbackSend = vi.fn().mockResolvedValue(undefined);
    const parentSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "111111111111111111",
          {
            id: "111111111111111111",
            send: threadSend,
          },
        ],
        [
          "222222222222222222",
          {
            id: "222222222222222222",
            send: parentSend,
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: fallbackSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(threadSend).toHaveBeenCalledTimes(1);
    expect(parentSend).not.toHaveBeenCalled();
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  it("sends alerts only to tracked clan log channels when clan-log routing is selected", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "333333333333333333" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "CLAN_LOG",
      channelId: null,
    });
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "bot-log-1",
          {
            id: "bot-log-1",
            send: botLogSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(trackedSend).toHaveBeenCalledTimes(1);
    expect(botLogSend).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelId).not.toHaveBeenCalled();
    expect(result.alertedCount).toBe(1);
  });

  it("sends alerts only to tracked clan leader channels when clan-lead routing is selected", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([
        {
          tag: "#2QG2C08UP",
          logChannelId: "333333333333333333",
          leaderChannelId: "444444444444444444",
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "CLAN_LEAD",
      channelId: null,
    });
    const leaderSend = vi.fn().mockResolvedValue(undefined);
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const customSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "444444444444444444",
          {
            id: "444444444444444444",
            send: leaderSend,
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "bot-log-1",
          {
            id: "bot-log-1",
            send: botLogSend,
          },
        ],
        [
          "custom-1",
          {
            id: "custom-1",
            send: customSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    const result = await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(leaderSend).toHaveBeenCalledTimes(1);
    expect(trackedSend).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
    expect(customSend).not.toHaveBeenCalled();
    expect(botLogChannelServiceMock.getChannelId).not.toHaveBeenCalled();
    expect(result.alertedCount).toBe(1);
  });

  it("sends alerts only to /bot-logs when bot-log routing is selected", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "333333333333333333" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "BOT_LOG",
      channelId: null,
    });
    botLogChannelServiceMock.getChannelId.mockResolvedValue("444444444444444444");
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "444444444444444444",
          {
            id: "444444444444444444",
            send: botLogSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(botLogChannelServiceMock.getChannelId).toHaveBeenCalledWith("guild-1");
    expect(botLogSend).toHaveBeenCalledTimes(1);
    expect(trackedSend).not.toHaveBeenCalled();
  });

  it("sends alerts only to the saved custom destination when custom routing is selected", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "333333333333333333" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "111111111111111111",
    });
    const customSend = vi.fn().mockResolvedValue(undefined);
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "111111111111111111",
          {
            id: "111111111111111111",
            send: customSend,
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "bot-log-1",
          {
            id: "bot-log-1",
            send: botLogSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(customSend).toHaveBeenCalledTimes(1);
    expect(trackedSend).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
  });

  it("skips clan-lead alerts when the tracked clan has no leader channel configured", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([
        {
          tag: "#2QG2C08UP",
          logChannelId: "333333333333333333",
          leaderChannelId: null,
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "CLAN_LEAD",
      channelId: null,
    });
    const leaderSend = vi.fn().mockResolvedValue(undefined);
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const customSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "444444444444444444",
          {
            id: "444444444444444444",
            send: leaderSend,
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "bot-log-1",
          {
            id: "bot-log-1",
            send: botLogSend,
          },
        ],
        [
          "custom-1",
          {
            id: "custom-1",
            send: customSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(leaderSend).not.toHaveBeenCalled();
    expect(trackedSend).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
    expect(customSend).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "alert_destination_unusable guild=guild-1 player=#PYLQ0289 clan=#2QG2C08UP destination=none source=clan_lead reason=missing_leader_channel",
      ),
    );
  });

  it("sends no alerts when routing is disabled", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "333333333333333333" }])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "DISABLED",
      channelId: null,
    });
    const customSend = vi.fn().mockResolvedValue(undefined);
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "111111111111111111",
          {
            id: "111111111111111111",
            send: customSend,
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "444444444444444444",
          {
            id: "444444444444444444",
            send: botLogSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(customSend).not.toHaveBeenCalled();
    expect(trackedSend).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
  });

  it("skips clan-lead alerts when the configured leader channel is unavailable or not sendable", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([
        {
          tag: "#2QG2C08UP",
          logChannelId: "333333333333333333",
          leaderChannelId: "444444444444444444",
        },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
      routingMode: "CLAN_LEAD",
      channelId: null,
    });
    const trackedSend = vi.fn().mockResolvedValue(undefined);
    const botLogSend = vi.fn().mockResolvedValue(undefined);
    const customSend = vi.fn().mockResolvedValue(undefined);
    const client = createClient(
      new Map<string, unknown>([
        [
          "444444444444444444",
          {
            id: "444444444444444444",
          },
        ],
        [
          "333333333333333333",
          {
            id: "333333333333333333",
            send: trackedSend,
          },
        ],
        [
          "bot-log-1",
          {
            id: "bot-log-1",
            send: botLogSend,
          },
        ],
        [
          "custom-1",
          {
            id: "custom-1",
            send: customSend,
          },
        ],
      ]),
    );
    const service = new UnlinkedMemberAlertService();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "333333333333333333",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(trackedSend).not.toHaveBeenCalled();
    expect(botLogSend).not.toHaveBeenCalled();
    expect(customSend).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "alert_destination_unusable guild=guild-1 player=#PYLQ0289 clan=#2QG2C08UP destination=444444444444444444 source=clan_lead reason=unavailable_or_not_sendable",
      ),
    );
  });

  it("supports clan-scoped list filtering and includes active CWL clan members", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#QGRJ2222", name: "CWL Clan" },
    ]);
    todoSnapshotMock.loadActiveCwlWarsByClan.mockResolvedValue(
      new Map([
        [
          "#QGRJ2222",
          {
            clan: {
              tag: "#QGRJ2222",
              name: "CWL Clan",
              members: [{ tag: "#QRL2VG9JC", name: "Two" }],
            },
            opponent: {
              tag: "#PYL0289",
              name: "Opp",
              members: [],
            },
            state: "inWar",
          },
        ],
      ]),
    );
    todoSnapshotMock.buildActiveCwlClanByPlayerTag.mockReturnValue(
      new Map([["#QRL2VG9JC", "#QGRJ2222"]]),
    );
    const service = new UnlinkedMemberAlertService();

    const result = await service.listCurrentUnlinkedMembers({
      guildId: "guild-1",
      clanTag: "#QGRJ2222",
      cocService: {
        getClan: vi.fn().mockResolvedValue({
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          members: [{ tag: "#PYLQ0289", name: "One" }],
        }),
      } as any,
    });

    expect(result).toEqual([
      {
        playerTag: "#QRL2VG9JC",
        playerName: "Two",
        clanTag: "#QGRJ2222",
        clanName: "CWL Clan",
      },
    ]);
  });

  it("persists routing config and unresolved state without touching BotSetting", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    const service = new UnlinkedMemberAlertService();

    await service.setAlertRoutingConfig({
      guildId: "guild-1",
      routingMode: "CUSTOM",
      channelId: "111111111111111111",
    });
    await service.reconcileGuildAlerts({
      client: createClient(),
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "222222222222222222",
          members: [{ playerTag: "#PYLQ0289", playerName: "One" }],
        },
      ],
    });

    expect(prismaMock.unlinkedAlertConfig.upsert).toHaveBeenCalledWith({
      where: { guildId: "guild-1" },
      create: {
        guildId: "guild-1",
        routingMode: "CUSTOM",
        channelId: "111111111111111111",
      },
      update: {
        routingMode: "CUSTOM",
        channelId: "111111111111111111",
      },
    });
    expect(prismaMock.unlinkedPlayer.upsert).toHaveBeenCalled();
    expect(prismaMock.botSetting.findMany).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });
});
