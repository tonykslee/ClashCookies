import { beforeEach, describe, expect, it, vi } from "vitest";

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
  unlinkedAlertConfig: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
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

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/TodoSnapshotService", () => todoSnapshotMock);

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
    prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue(null);
    prismaMock.unlinkedAlertConfig.upsert.mockResolvedValue(undefined);
    prismaMock.unlinkedPlayer.findMany.mockResolvedValue([]);
    prismaMock.unlinkedPlayer.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.unlinkedPlayer.upsert.mockResolvedValue(undefined);
    prismaMock.unlinkedPlayer.update.mockResolvedValue(undefined);

    todoSnapshotMock.loadActiveCwlWarsByClan.mockResolvedValue(new Map());
    todoSnapshotMock.buildActiveCwlClanByPlayerTag.mockReturnValue(new Map());
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

  it("treats members with no PlayerLink row as unlinked", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha Clan", logChannelId: "222222222222222222" },
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

  it("falls back to the tracked clan log channel when no guild alert channel is configured", async () => {
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

  it("stores config and unresolved state without touching BotSetting", async () => {
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#2QG2C08UP", logChannelId: "222222222222222222" }])
      .mockResolvedValueOnce([]);
    const service = new UnlinkedMemberAlertService();

    await service.setAlertChannelId({
      guildId: "guild-1",
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

    expect(prismaMock.unlinkedAlertConfig.upsert).toHaveBeenCalled();
    expect(prismaMock.unlinkedPlayer.upsert).toHaveBeenCalled();
    expect(prismaMock.botSetting.findMany).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.botSetting.upsert).not.toHaveBeenCalled();
  });
});
