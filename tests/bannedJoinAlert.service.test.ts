import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnlinkedMemberAlertService } from "../src/services/UnlinkedMemberAlertService";

type BanRow = {
  id: string;
  guildId: string;
  targetKind: "PLAYER" | "USER";
  playerTag: string | null;
  discordUserId: string | null;
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
}));

const botLogChannelServiceMock = vi.hoisted(() => ({
  getChannelId: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/BotLogChannelService", () => ({
  botLogChannelService: {
    getChannelId: botLogChannelServiceMock.getChannelId,
  },
}));

vi.mock("../src/services/TodoSnapshotService", () => ({
  loadActiveCwlWarsByClan: vi.fn().mockResolvedValue(new Map()),
  buildActiveCwlClanByPlayerTag: vi.fn().mockReturnValue(new Map()),
}));

function makeBanRow(overrides: Partial<BanRow> = {}): BanRow {
  return {
    id: overrides.id ?? `ban-${Math.random().toString(36).slice(2)}`,
    guildId: overrides.guildId ?? "guild-1",
    targetKind: overrides.targetKind ?? "PLAYER",
    playerTag: overrides.playerTag ?? "#PYLQ0289",
    discordUserId: overrides.discordUserId ?? null,
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

function makeAlertRow(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: overrides.id ?? `alert-${Math.random().toString(36).slice(2)}`,
    guildId: overrides.guildId ?? "guild-1",
    playerTag: overrides.playerTag ?? "#PYLQ0289",
    clanTag: overrides.clanTag ?? "#2QG2C08UP",
    playerName: overrides.playerName ?? "Player One",
    clanName: overrides.clanName ?? "Alpha Clan",
    banRecordId: overrides.banRecordId ?? null,
    alertedAt: overrides.alertedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-06-08T11:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-06-08T11:00:00.000Z"),
  };
}

function matchesActiveBanWhere(row: BanRow, where: any): boolean {
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
}

function createBanStore(initialRows: BanRow[] = []) {
  const rows = [...initialRows];
  prismaMock.banRecord.findMany.mockImplementation(async ({ where }: any) => {
    return rows.filter((row) => matchesActiveBanWhere(row, where));
  });
  prismaMock.banRecord.findFirst.mockResolvedValue(null);
  return {
    rows,
    setRows(nextRows: BanRow[]) {
      rows.splice(0, rows.length, ...nextRows);
    },
  };
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
      const updated = {
        ...rows[index],
        ...update,
        updatedAt: new Date("2026-06-08T12:00:00.000Z"),
      };
      rows[index] = updated;
      return updated;
    }

    const created = {
      id: `alert-${Math.random().toString(36).slice(2)}`,
      ...create,
      createdAt: new Date("2026-06-08T11:00:00.000Z"),
      updatedAt: new Date("2026-06-08T11:00:00.000Z"),
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
    const updated = {
      ...rows[index],
      ...data,
      updatedAt: new Date("2026-06-08T12:00:00.000Z"),
    };
    rows[index] = updated;
    return updated;
  });
  prismaMock.bannedPlayerJoinAlert.deleteMany.mockImplementation(async ({ where }: any) => {
    const clauses = Array.isArray(where.OR) ? where.OR : [];
    let count = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (where.guildId && row.guildId !== where.guildId) continue;
      const shouldDelete =
        clauses.length === 0 ||
        clauses.some(
          (clause: any) => row.playerTag === clause.playerTag && row.clanTag === clause.clanTag,
        );
      if (!shouldDelete) continue;
      rows.splice(i, 1);
      count += 1;
    }
    return { count };
  });
  return {
    rows,
  };
}

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
      [
        "333333333333333333",
        {
          id: "333333333333333333",
          send: vi.fn().mockResolvedValue(undefined),
        },
      ],
      [
        "444444444444444444",
        {
          id: "444444444444444444",
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

function createEmptyCocService() {
  return {
    getClan: vi.fn(async () => ({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      members: [],
    })),
  } as any;
}

function configureCommonMocks(input: {
  routingMode: "CLAN_LOG" | "CLAN_LEAD" | "BOT_LOG" | "CUSTOM" | "DISABLED";
  channelId?: string | null;
  trackedClanLogChannelId?: string | null;
  trackedClanLeaderChannelId?: string | null;
  botLogChannelId?: string | null;
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
    channelId: input.channelId ?? null,
  });
  botLogChannelServiceMock.getChannelId.mockResolvedValue(input.botLogChannelId ?? null);
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
  prismaMock.playerLink.findMany.mockClear();
}

describe("banned join alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.banRecord.findMany.mockReset();
    prismaMock.banRecord.findFirst.mockReset();
    prismaMock.unlinkedAlertConfig.findUnique.mockReset();
    prismaMock.unlinkedAlertConfig.upsert.mockReset();
    prismaMock.bannedPlayerJoinAlert.findMany.mockReset();
    prismaMock.bannedPlayerJoinAlert.deleteMany.mockReset();
    prismaMock.bannedPlayerJoinAlert.upsert.mockReset();
    prismaMock.bannedPlayerJoinAlert.update.mockReset();
    prismaMock.unlinkedPlayer.findMany.mockReset();
    prismaMock.unlinkedPlayer.deleteMany.mockReset();
    prismaMock.unlinkedPlayer.upsert.mockReset();
    prismaMock.unlinkedPlayer.update.mockReset();
    botLogChannelServiceMock.getChannelId.mockReset();
  });

  it("sends a direct player-ban alert once and keeps allowedMentions disabled", async () => {
    const service = new UnlinkedMemberAlertService();
    const banStore = createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const client = createClient();

    const result = await service.reconcileGuildAlerts({
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

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "111111111111111111",
    ).send;
    expect(send).toHaveBeenCalledWith({
      content: [
        "A banned player, Player One (`#PYLQ0289`), has joined **Alpha Clan**.",
        "Ban: direct player ban",
        "Reason: direct abuse",
        "Expires: <t:1783512000:R>",
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
    expect(result.unresolvedCount).toBe(0);
    expect(alertStore.rows).toHaveLength(1);
    expect(alertStore.rows[0]?.alertedAt).toBeInstanceOf(Date);
    expect(banStore.rows).toHaveLength(1);
  });

  it("sends a user-ban alert through the linked Discord user", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-user",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        reason: "user abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
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

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "222222222222222222",
    ).send;
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Discord user ban <@222222222222222222>"),
        allowedMentions: { parse: [] },
      }),
    );
    expect(alertStore.rows).toHaveLength(1);
  });

  it("does not duplicate the alert on the next reconcile while the player remains banned in-clan", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
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

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "111111111111111111",
    ).send;
    expect(send).toHaveBeenCalledTimes(1);
    expect(alertStore.rows).toHaveLength(1);
  });

  it("clears alert state when the banned player leaves the tracked clan", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
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
      cocService: createEmptyCocService(),
      observedFwaClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "Alpha Clan",
          logChannelId: "111111111111111111",
          members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
        },
      ],
    });

    prismaMock.trackedClan.findMany.mockResolvedValueOnce([]);
    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: createEmptyCocService(),
      observedFwaClans: [],
    });

    expect(alertStore.rows).toHaveLength(0);
  });

  it("re-alerts after the banned player leaves and later rejoins", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const client = createClient();

    const member = {
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      logChannelId: "111111111111111111",
      members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
    };
    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: createEmptyCocService(),
      observedFwaClans: [member],
    });
    prismaMock.trackedClan.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          logChannelId: "111111111111111111",
          leaderChannelId: "222222222222222222",
        },
      ]);
    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: createEmptyCocService(),
      observedFwaClans: [],
    });
    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: createEmptyCocService(),
      observedFwaClans: [member],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "111111111111111111",
    ).send;
    expect(send).toHaveBeenCalledTimes(2);
    expect(alertStore.rows).toHaveLength(1);
  });

  it("clears alert state and stops alerting after the ban expires", async () => {
    const service = new UnlinkedMemberAlertService();
    const banStore = createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const client = createClient();
    const member = {
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      logChannelId: "111111111111111111",
      members: [{ playerTag: "#PYLQ0289", playerName: "Player One" }],
    };

    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [member],
    });

    banStore.setRows([]);
    await service.reconcileGuildAlerts({
      client,
      guildId: "guild-1",
      cocService: {} as any,
      observedFwaClans: [member],
    });

    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "111111111111111111",
    ).send;
    expect(send).toHaveBeenCalledTimes(1);
    expect(alertStore.rows).toHaveLength(0);
  });

  it.each([
    ["CLAN_LOG", undefined, "111111111111111111"],
    ["CLAN_LEAD", undefined, "222222222222222222"],
    ["BOT_LOG", undefined, "333333333333333333"],
    ["CUSTOM", "444444444444444444", "444444444444444444"],
  ] as const)(
    "supports %s routing for banned join alerts",
    async (routingMode, customChannelId, expectedChannelId) => {
      const service = new UnlinkedMemberAlertService();
      createBanStore([
        makeBanRow({
          id: "ban-player",
          targetKind: "PLAYER",
          playerTag: "#PYLQ0289",
          reason: "direct abuse",
          expiresAt: new Date("2026-07-08T12:00:00.000Z"),
        }),
      ]);
      createAlertStore();
      configureCommonMocks({
        routingMode: routingMode as any,
        channelId: customChannelId ?? null,
        botLogChannelId: routingMode === "BOT_LOG" ? "333333333333333333" : null,
        trackedClanLogChannelId: "111111111111111111",
        trackedClanLeaderChannelId: "222222222222222222",
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

      const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
        expectedChannelId,
      ).send;
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("skips alert delivery when routing is disabled", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "DISABLED" });
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

    expect(alertStore.rows[0]?.alertedAt).toBeNull();
    const send = (client.guilds.cache.get("guild-1") as any).channels.cache.get(
      "111111111111111111",
    ).send;
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps reconcile running when alert send fails", async () => {
    const service = new UnlinkedMemberAlertService();
    createBanStore([
      makeBanRow({
        id: "ban-player",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "direct abuse",
        expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      }),
    ]);
    const alertStore = createAlertStore();
    configureCommonMocks({ routingMode: "CLAN_LOG" });
    const failingSend = vi.fn().mockRejectedValue(new Error("channel send failed"));
    const client = createClient(
      new Map([
        [
          "111111111111111111",
          {
            id: "111111111111111111",
            send: failingSend,
          },
        ],
      ]),
    );

    await expect(
      service.reconcileGuildAlerts({
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
      }),
    ).resolves.toMatchObject({
      unresolvedCount: 0,
    });
    expect(failingSend).toHaveBeenCalledTimes(1);
    expect(alertStore.rows[0]?.alertedAt).toBeNull();
  });
});
