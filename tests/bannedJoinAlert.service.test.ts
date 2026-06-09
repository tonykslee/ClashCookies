import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnlinkedMemberAlertService } from "../src/services/UnlinkedMemberAlertService";

type BanRow = {
  id: string;
  guildId: string;
  targetKind: "PLAYER" | "USER";
  playerTag: string | null;
  discordUserId: string | null;
  clanTag: string | null;
  clanName: string | null;
  reason: string | null;
  bannedByDiscordUserId: string;
  createdAt: Date;
  expiresAt: Date | null;
  removedAt: Date | null;
  removedByDiscordUserId: string | null;
  removeReason: string | null;
  updatedAt: Date;
};

type AlertRow = {
  id: string;
  guildId: string;
  playerTag: string;
  clanTag: string;
  playerName: string;
  clanName: string;
  banRecordId: string | null;
  alertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

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
  },
  unlinkedAlertConfig: {
    findUnique: vi.fn(),
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
  getRoutingConfigForType: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/TodoSnapshotService", () => todoSnapshotMock);

vi.mock("../src/services/BotLogChannelService", () => ({
  botLogChannelService: {
    getChannelId: botLogChannelServiceMock.getChannelId,
    getRoutingConfigForType: botLogChannelServiceMock.getRoutingConfigForType,
  },
}));

function createClient() {
  const channels = new Map<string, unknown>([
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

function makeBanRow(overrides: Partial<BanRow> = {}): BanRow {
  return {
    id: overrides.id ?? "ban-1",
    guildId: overrides.guildId ?? "guild-1",
    targetKind: overrides.targetKind ?? "PLAYER",
    playerTag: overrides.playerTag ?? "#PYLQ0289",
    discordUserId: overrides.discordUserId ?? null,
    clanTag: overrides.clanTag ?? null,
    clanName: overrides.clanName ?? null,
    reason: overrides.reason ?? null,
    bannedByDiscordUserId: overrides.bannedByDiscordUserId ?? "111111111111111111",
    createdAt: overrides.createdAt ?? new Date("2026-06-08T12:00:00.000Z"),
    expiresAt: overrides.expiresAt ?? null,
    removedAt: overrides.removedAt ?? null,
    removedByDiscordUserId: overrides.removedByDiscordUserId ?? null,
    removeReason: overrides.removeReason ?? null,
    updatedAt: overrides.updatedAt ?? new Date("2026-06-08T12:00:00.000Z"),
  };
}

function createBanStore(initialRows: BanRow[] = []) {
  const rows = [...initialRows];
  prismaMock.banRecord.findMany.mockImplementation(async ({ where }: any) => {
    return rows.filter((row) => {
      if (where.guildId !== undefined && row.guildId !== where.guildId) return false;
      if (where.targetKind !== undefined && row.targetKind !== where.targetKind) return false;
      if (where.playerTag?.in && !where.playerTag.in.includes(row.playerTag)) return false;
      if (where.discordUserId?.in && !where.discordUserId.in.includes(row.discordUserId)) return false;
      if (where.removedAt === null && row.removedAt !== null) return false;
      if (Array.isArray(where.OR) && where.OR.length > 0) {
        const matchesExpiry = where.OR.some((clause: any) => {
          if (!Object.prototype.hasOwnProperty.call(clause, "expiresAt")) return true;
          if (clause.expiresAt === null) return row.expiresAt === null;
          if (clause.expiresAt?.gt instanceof Date) {
            return row.expiresAt !== null && row.expiresAt > clause.expiresAt.gt;
          }
          return true;
        });
        if (!matchesExpiry) return false;
      }
      return true;
    });
  });
  return { rows };
}

function createAlertStore(initialRows: AlertRow[] = []) {
  const rows = [...initialRows];
  prismaMock.bannedPlayerJoinAlert.findMany.mockImplementation(async () => rows.map((row) => ({ ...row })));
  prismaMock.bannedPlayerJoinAlert.upsert.mockImplementation(async ({ where, create, update }: any) => {
    const index = rows.findIndex(
      (row) =>
        row.guildId === where.guildId_playerTag_clanTag.guildId &&
        row.playerTag === where.guildId_playerTag_clanTag.playerTag &&
        row.clanTag === where.guildId_playerTag_clanTag.clanTag,
    );
    if (index >= 0) {
      rows[index] = {
        ...rows[index],
        ...update,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
      };
      return rows[index];
    }

    const created = {
      id: `alert-${rows.length + 1}`,
      ...create,
      createdAt: new Date("2026-06-08T12:00:00.000Z"),
      updatedAt: new Date("2026-06-08T12:00:00.000Z"),
    };
    rows.push(created);
    return created;
  });
  prismaMock.bannedPlayerJoinAlert.update.mockImplementation(async ({ where, data }: any) => {
    const index = rows.findIndex(
      (row) =>
        row.guildId === where.guildId_playerTag_clanTag.guildId &&
        row.playerTag === where.guildId_playerTag_clanTag.playerTag &&
        row.clanTag === where.guildId_playerTag_clanTag.clanTag,
    );
    if (index < 0) throw new Error("missing alert row");
    rows[index] = {
      ...rows[index],
      ...data,
      updatedAt: new Date("2026-06-08T12:00:00.000Z"),
    };
    return rows[index];
  });
  prismaMock.bannedPlayerJoinAlert.deleteMany.mockImplementation(async ({ where }: any) => {
    const clauses = Array.isArray(where.OR) ? where.OR : [];
    let count = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (where.guildId && row.guildId !== where.guildId) continue;
      const shouldDelete =
        clauses.length === 0 ||
        clauses.some((clause: any) => row.playerTag === clause.playerTag && row.clanTag === clause.clanTag);
      if (!shouldDelete) continue;
      rows.splice(index, 1);
      count += 1;
    }
    return { count };
  });
  return { rows };
}

function configureCommonMocks(input: {
  routingMode: "CLAN_LOG" | "CLAN_LEAD";
  trackedClanLogChannelId?: string;
  trackedClanLeaderChannelId?: string;
  currentDiscordUserId?: string | null;
}) {
  prismaMock.trackedClan.findMany.mockResolvedValue([
    {
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      logChannelId: input.trackedClanLogChannelId ?? "111111111111111111",
      leaderChannelId: input.trackedClanLeaderChannelId ?? "222222222222222222",
    },
  ]);
  prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
  prismaMock.unlinkedAlertConfig.findUnique.mockResolvedValue({
    routingMode: input.routingMode,
    channelId: null,
  });
  botLogChannelServiceMock.getChannelId.mockResolvedValue(null);
  botLogChannelServiceMock.getRoutingConfigForType.mockResolvedValue({
    routingMode: input.routingMode,
    channelId: null,
    legacy: false,
    configured: true,
  });
  prismaMock.playerLink.findMany.mockResolvedValue([
    {
      playerTag: "#PYLQ0289",
      discordUserId: input.currentDiscordUserId ?? "222222222222222222",
    },
  ]);
  prismaMock.unlinkedPlayer.findMany.mockResolvedValue([]);
  prismaMock.unlinkedPlayer.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.unlinkedPlayer.upsert.mockResolvedValue(undefined);
  prismaMock.unlinkedPlayer.update.mockResolvedValue(undefined);
}

describe("banned join alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.banRecord.findMany.mockReset();
    prismaMock.unlinkedAlertConfig.findUnique.mockReset();
    prismaMock.bannedPlayerJoinAlert.findMany.mockReset();
    prismaMock.bannedPlayerJoinAlert.deleteMany.mockReset();
    prismaMock.bannedPlayerJoinAlert.upsert.mockReset();
    prismaMock.bannedPlayerJoinAlert.update.mockReset();
    prismaMock.unlinkedPlayer.findMany.mockReset();
    prismaMock.unlinkedPlayer.deleteMany.mockReset();
    prismaMock.unlinkedPlayer.upsert.mockReset();
    prismaMock.unlinkedPlayer.update.mockReset();
    prismaMock.botSetting.findMany.mockReset();
    prismaMock.botSetting.findUnique.mockReset();
    prismaMock.botSetting.updateMany.mockReset();
    prismaMock.botSetting.upsert.mockReset();
    botLogChannelServiceMock.getChannelId.mockReset();
    botLogChannelServiceMock.getRoutingConfigForType.mockReset();
    todoSnapshotMock.loadActiveCwlWarsByClan.mockResolvedValue(new Map());
    todoSnapshotMock.buildActiveCwlClanByPlayerTag.mockReturnValue(new Map());
  });

  it("includes ban clan context in direct player-ban alerts", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        clanTag: "#QGRJ0289",
        clanName: "Gamma Clan",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const client = createClient();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "111111111111111111",
          members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
        },
      ],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("111111111111111111").send;
    expect(send).toHaveBeenCalledWith({
      content: [
        "A banned player, Player One (`#PYLQ0289`), has joined **Alpha Clan**.",
        "Ban target: direct player ban",
        "Ban clan: Gamma Clan (`#QGRJ0289`)",
        "Reason: direct abuse",
        "Expires: <t:1783512000:R>",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    expect(alertStore.rows).toHaveLength(1);
    expect(alertStore.rows[0]?.alertedAt).toBeInstanceOf(Date);
  });

  it("includes ban clan context in user-ban alerts and keeps the joined clan distinct", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-user",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        clanTag: "#QGRJ0289",
        clanName: "Gamma Clan",
        reason: "user abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    createAlertStore();
    configureCommonMocks({
      routingMode: "CLAN_LEAD",
      trackedClanLeaderChannelId: "222222222222222222",
      currentDiscordUserId: "222222222222222222",
    });
    const client = createClient();

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "111111111111111111",
          members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
        },
      ],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("222222222222222222").send;
    expect(send).toHaveBeenCalledWith({
      content: [
        "A banned player, Player One (`#PYLQ0289`), has joined **Alpha Clan**.",
        "Ban target: Discord user ban <@222222222222222222>",
        "Ban clan: Gamma Clan (`#QGRJ0289`)",
        "Reason: user abuse",
        "Expires: <t:1783512000:R>",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  });

  it("does not duplicate the banned-player alert on the next reconcile while the player remains in-clan", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        clanTag: "#3QG2C08UP",
        clanName: "Gamma Clan",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const client = createClient();

    const payload = {
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "111111111111111111",
          members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
        },
      ],
    };

    await service.reconcileGuildAlerts(payload);
    await service.reconcileGuildAlerts(payload);

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get("111111111111111111").send;
    expect(send).toHaveBeenCalledTimes(1);
  });
});
