import { beforeEach, describe, expect, it, vi } from "vitest";
import { BanService } from "../src/services/BanService";

const prismaMock = vi.hoisted(() => ({
  banRecord: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  trackedClan: {
    findUnique: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  playerLink: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

const listPlayerLinksForDiscordUserMock = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/PlayerLinkService")>(
    "../src/services/PlayerLinkService",
  );
  return {
    ...actual,
    listPlayerLinksForDiscordUser: listPlayerLinksForDiscordUserMock,
  };
});

function makeBanRecord(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: overrides.id ?? `ban-${Math.random().toString(36).slice(2)}`,
    guildId: overrides.guildId ?? "guild-1",
    targetKind: overrides.targetKind ?? "PLAYER",
    playerTag: overrides.playerTag ?? "#PYLQ0289",
    discordUserId: overrides.discordUserId ?? null,
    targetDiscordUsername: overrides.targetDiscordUsername ?? null,
    targetDiscordDisplayName: overrides.targetDiscordDisplayName ?? null,
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
    targetPlayerName: overrides.targetPlayerName ?? null,
  };
}

function matchesBanWhere(row: ReturnType<typeof makeBanRecord>, where: any) {
  if (where.guildId !== undefined && row.guildId !== where.guildId) return false;
  if (where.targetKind !== undefined && row.targetKind !== where.targetKind) return false;
  if (where.playerTag !== undefined && row.playerTag !== where.playerTag) return false;
  if (where.discordUserId !== undefined && row.discordUserId !== where.discordUserId) return false;
  if (Object.prototype.hasOwnProperty.call(where, "removedAt")) {
    if (where.removedAt === null && row.removedAt !== null) return false;
    if (where.removedAt !== null && row.removedAt !== where.removedAt) return false;
  }
  if (Array.isArray(where.OR) && where.OR.length > 0) {
    const matchesOr = where.OR.some((clause: any) => {
      if (!Object.prototype.hasOwnProperty.call(clause, "expiresAt")) return true;
      if (clause.expiresAt === null) return row.expiresAt === null;
      if (clause.expiresAt?.gt instanceof Date) {
        return row.expiresAt !== null && row.expiresAt > clause.expiresAt.gt;
      }
      return true;
    });
    if (!matchesOr) return false;
  }
  return true;
}

function createBanStore(initialRows: ReturnType<typeof makeBanRecord>[] = []) {
  const rows = [...initialRows];

  prismaMock.banRecord.findFirst.mockImplementation(async ({ where }: any) => {
    return rows.find((row) => matchesBanWhere(row, where)) ?? null;
  });

  prismaMock.banRecord.findMany.mockImplementation(async ({ where }: any) => {
    return rows.filter((row) => matchesBanWhere(row, where));
  });

  prismaMock.banRecord.create.mockImplementation(async ({ data }: any) => {
    const created = makeBanRecord(data);
    rows.push(created);
    return created;
  });

  prismaMock.banRecord.update.mockImplementation(async ({ where, data }: any) => {
    const index = rows.findIndex((row) => row.id === where.id);
    if (index === -1) {
      throw new Error(`Missing ban record ${where.id}`);
    }

    const updated = {
      ...rows[index],
      ...data,
      updatedAt: data.updatedAt ?? new Date("2026-06-08T12:00:00.000Z"),
    };
    rows[index] = updated;
    return updated;
  });

  return { rows };
}

describe("BanService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.banRecord.findFirst.mockReset();
    prismaMock.banRecord.findMany.mockReset();
    prismaMock.banRecord.create.mockReset();
    prismaMock.banRecord.update.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    listPlayerLinksForDiscordUserMock.mockReset();
  });

  it("adds a player ban with normalized tag, reason, expiresAt, and bannedBy fields", async () => {
    const service = new BanService();
    const expiresAt = new Date("2026-07-08T12:00:00.000Z");
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.banRecord.create.mockResolvedValue(
      makeBanRecord({
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        reason: "spam abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt,
      }),
    );

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "  pylq0289  ",
      reason: "  spam   abuse  ",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt,
    });

    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: {
        guildId: "guild-1",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        discordUserId: null,
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: null,
        clanName: null,
        reason: "spam abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt,
      },
    });
    expect(result.outcome).toBe("created");
    expect(result.record?.playerTag).toBe("#PYLQ0289");
    expect(result.record?.reason).toBe("spam abuse");
    expect(result.record?.expiresAt).toEqual(expiresAt);
    expect(result.record?.bannedByDiscordUserId).toBe("111111111111111111");
  });

  it("adds a player ban with clan context when a tracked clan is provided", async () => {
    const service = new BanService();
    const expiresAt = new Date("2026-07-08T12:00:00.000Z");
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.banRecord.create.mockResolvedValue(
      makeBanRecord({
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        reason: "spam abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt,
      }),
    );

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "  pylq0289  ",
      clanTag: "2qg2c08up",
      reason: "  spam   abuse  ",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt,
    });

    expect(prismaMock.trackedClan.findUnique).toHaveBeenCalledWith({
      where: { tag: "#2QG2C08UP" },
      select: { tag: true, name: true },
    });
    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: {
        guildId: "guild-1",
        targetKind: "PLAYER",
        playerTag: "#PYLQ0289",
        discordUserId: null,
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        reason: "spam abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt,
      },
    });
    expect(result.outcome).toBe("created");
    expect(result.record?.clanTag).toBe("#2QG2C08UP");
    expect(result.record?.clanName).toBe("Alpha Clan");
  });

  it("adds a user ban without touching PlayerLink ownership rows", async () => {
    const service = new BanService();
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.banRecord.create.mockResolvedValue(
      makeBanRecord({
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        bannedByDiscordUserId: "111111111111111111",
      }),
    );

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      reason: "Alt abuse",
      bannedByDiscordUserId: "111111111111111111",
    });

    expect(listPlayerLinksForDiscordUserMock).not.toHaveBeenCalled();
    expect(prismaMock.playerCurrent.findMany).not.toHaveBeenCalled();
    expect(prismaMock.playerLink.findMany).not.toHaveBeenCalled();
    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: {
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: null,
        clanName: null,
        reason: "Alt abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt: null,
      },
    });
    expect(result.outcome).toBe("created");
    expect(result.record?.discordUserId).toBe("222222222222222222");
  });

  it("persists the Discord username and guild display name snapshot when adding a user ban", async () => {
    const service = new BanService();
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.banRecord.create.mockResolvedValue(
      makeBanRecord({
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
        bannedByDiscordUserId: "111111111111111111",
      }),
    );

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      targetDiscordUsername: "someuser",
      targetDiscordDisplayName: "Some Display Name",
      reason: "Alt abuse",
      bannedByDiscordUserId: "111111111111111111",
    });

    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: "someuser",
        targetDiscordDisplayName: "Some Display Name",
      }),
    });
    expect(result.record?.targetDiscordUsername).toBe("someuser");
    expect(result.record?.targetDiscordDisplayName).toBe("Some Display Name");
  });

  it("adds a user ban with clan context when a tracked clan is provided", async () => {
    const service = new BanService();
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });
    prismaMock.banRecord.findFirst.mockResolvedValue(null);
    prismaMock.banRecord.create.mockResolvedValue(
      makeBanRecord({
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        bannedByDiscordUserId: "111111111111111111",
      }),
    );

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      clanTag: " 2qg2c08up ",
      reason: "Alt abuse",
      bannedByDiscordUserId: "111111111111111111",
    });

    expect(prismaMock.trackedClan.findUnique).toHaveBeenCalledWith({
      where: { tag: "#2QG2C08UP" },
      select: { tag: true, name: true },
    });
    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: {
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        targetDiscordUsername: null,
        targetDiscordDisplayName: null,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
        reason: "Alt abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt: null,
      },
    });
    expect(result.outcome).toBe("created");
    expect(result.record?.clanTag).toBe("#2QG2C08UP");
    expect(result.record?.clanName).toBe("Alpha Clan");
  });

  it("returns an invalid_clan outcome when the provided clan is not tracked", async () => {
    const service = new BanService();
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.banRecord.findFirst.mockResolvedValue(null);

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "#PYLQ0289",
      clanTag: "#ZZZ999999",
      reason: "spam abuse",
      bannedByDiscordUserId: "111111111111111111",
    });

    expect(result.outcome).toBe("invalid_clan");
    expect(prismaMock.banRecord.create).not.toHaveBeenCalled();
    expect(prismaMock.banRecord.update).not.toHaveBeenCalled();
  });

  it("re-bans a player when only an expired player ban exists and keeps the expired row for history", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const expiredPlayer = makeBanRecord({
      id: "player-expired",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      expiresAt: new Date("2026-06-08T11:00:00.000Z"),
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });
    const store = createBanStore([expiredPlayer]);

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "#pylq0289",
      reason: "repeat abuse",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.update).not.toHaveBeenCalled();
    expect(result.outcome).toBe("created");
    expect(store.rows).toHaveLength(2);
    expect(store.rows.some((row) => row.id === "player-expired")).toBe(true);

    const activeRows = await service.listActiveBans({ guildId: "guild-1", now });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].playerTag).toBe("#PYLQ0289");
    expect(activeRows[0].reason).toBe("repeat abuse");
    expect(activeRows[0].linkedPlayerTags).toEqual([]);
  });

  it("replaces clan context when updating an active player ban", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activePlayer = makeBanRecord({
      id: "player-active",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      clanTag: "#OLD123456",
      clanName: "Old Clan",
      reason: "old reason",
      expiresAt: new Date("2026-06-08T13:00:00.000Z"),
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const store = createBanStore([activePlayer]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
    });

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "#pylq0289",
      clanTag: "#2qg2c08up",
      reason: "extended reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-08-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.update).toHaveBeenCalledWith({
      where: { id: "player-active" },
      data: expect.objectContaining({
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Clan",
      }),
    });
    expect(result.outcome).toBe("updated");
    expect(store.rows.find((row) => row.id === "player-active")?.clanTag).toBe("#2QG2C08UP");
    expect(store.rows.find((row) => row.id === "player-active")?.clanName).toBe("Alpha Clan");
  });

  it("clears clan context when updating an active user ban without a clan", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activeUser = makeBanRecord({
      id: "user-active",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Clan",
      reason: "old reason",
      expiresAt: new Date("2026-06-08T13:00:00.000Z"),
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const store = createBanStore([activeUser]);

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      reason: "extended reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-08-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.update).toHaveBeenCalledWith({
      where: { id: "user-active" },
      data: expect.objectContaining({
        clanTag: null,
        clanName: null,
      }),
    });
    expect(result.outcome).toBe("updated");
    expect(store.rows.find((row) => row.id === "user-active")?.clanTag).toBeNull();
    expect(store.rows.find((row) => row.id === "user-active")?.clanName).toBeNull();
  });

  it("re-bans a user when only an expired user ban exists and keeps the expired row for history", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const expiredUser = makeBanRecord({
      id: "user-expired",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      expiresAt: new Date("2026-06-08T11:00:00.000Z"),
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });
    const store = createBanStore([expiredUser]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "222222222222222222",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ0222",
        discordUserId: "222222222222222222",
        playerName: "Linked Bravo",
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      reason: "ban evasion",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.update).not.toHaveBeenCalled();
    expect(result.outcome).toBe("created");
    expect(store.rows).toHaveLength(2);
    expect(store.rows.some((row) => row.id === "user-expired")).toBe(true);

    const activeRows = await service.listActiveBans({ guildId: "guild-1", now });
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].discordUserId).toBe("222222222222222222");
    expect(activeRows[0].linkedPlayerTags).toEqual(["#PYLQ0289", "#QGRJ0222"]);
    expect(activeRows[0].clanTag).toBeNull();
  });

  it("updates an active player ban instead of creating a duplicate row", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activePlayer = makeBanRecord({
      id: "player-active",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      reason: "old reason",
      expiresAt: new Date("2026-06-08T13:00:00.000Z"),
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const expiredPlayer = makeBanRecord({
      id: "player-expired",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      reason: "history",
      expiresAt: new Date("2026-06-08T09:00:00.000Z"),
      createdAt: new Date("2026-06-08T08:00:00.000Z"),
      updatedAt: new Date("2026-06-08T08:00:00.000Z"),
    });
    const store = createBanStore([expiredPlayer, activePlayer]);

    const result = await service.addPlayerBan({
      guildId: "guild-1",
      playerTag: "#pylq0289",
      reason: "extended reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-08-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.create).not.toHaveBeenCalled();
    expect(result.outcome).toBe("updated");
    expect(result.record?.id).toBe("player-active");
    expect(store.rows).toHaveLength(2);
    expect(store.rows.find((row) => row.id === "player-active")?.reason).toBe("extended reason");
    expect(store.rows.find((row) => row.id === "player-expired")?.reason).toBe("history");
  });

  it("updates an active user ban instead of creating a duplicate row", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activeUser = makeBanRecord({
      id: "user-active",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      reason: "old reason",
      expiresAt: new Date("2026-06-08T13:00:00.000Z"),
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const expiredUser = makeBanRecord({
      id: "user-expired",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      reason: "history",
      expiresAt: new Date("2026-06-08T09:00:00.000Z"),
      createdAt: new Date("2026-06-08T08:00:00.000Z"),
      updatedAt: new Date("2026-06-08T08:00:00.000Z"),
    });
    const store = createBanStore([expiredUser, activeUser]);

    const result = await service.addUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      reason: "extended reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-08-08T12:00:00.000Z"),
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.banRecord.create).not.toHaveBeenCalled();
    expect(result.outcome).toBe("updated");
    expect(result.record?.id).toBe("user-active");
    expect(store.rows).toHaveLength(2);
    expect(store.rows.find((row) => row.id === "user-active")?.reason).toBe("extended reason");
    expect(store.rows.find((row) => row.id === "user-expired")?.reason).toBe("history");
  });

  it("finds a direct active ban for a player before checking linked user bans", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const directBan = makeBanRecord({
      id: "direct-ban",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      reason: "direct reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
    });
    createBanStore([directBan]);

    const result = await service.findActiveBanForPlayer({
      guildId: "guild-1",
      playerTag: "#pylq0289",
      now,
    });

    expect(result?.id).toBe("direct-ban");
    expect(result?.targetKind).toBe("PLAYER");
    expect(prismaMock.playerLink.findUnique).not.toHaveBeenCalled();
  });

  it("finds an active user ban through the linked Discord user when no direct ban exists", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const userBan = makeBanRecord({
      id: "user-ban",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      reason: "user reason",
      bannedByDiscordUserId: "111111111111111111",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
    });
    createBanStore([userBan]);
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });

    const result = await service.findActiveBanForPlayer({
      guildId: "guild-1",
      playerTag: "#PYLQ0289",
      now,
    });

    expect(prismaMock.playerLink.findUnique).toHaveBeenCalledWith({
      where: { playerTag: "#PYLQ0289" },
      select: { discordUserId: true },
    });
    expect(result?.id).toBe("user-ban");
    expect(result?.targetKind).toBe("USER");
    expect(result?.discordUserId).toBe("222222222222222222");
  });

  it("lists active bans and resolves player names in bulk with current-name and link fallbacks", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activePlayer = makeBanRecord({
      id: "player-1",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      reason: null,
      targetPlayerName: "Current Alpha",
      expiresAt: null,
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const fallbackPlayer = makeBanRecord({
      id: "player-2",
      targetKind: "PLAYER",
      playerTag: "#QGRJ0222",
      reason: null,
      expiresAt: null,
      createdAt: new Date("2026-06-08T09:30:00.000Z"),
      updatedAt: new Date("2026-06-08T09:30:00.000Z"),
    });
    const activeUser = makeBanRecord({
      id: "user-1",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      targetDiscordUsername: "someuser",
      targetDiscordDisplayName: "Some Display Name",
      reason: "Alt abuse",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });
    const removedUser = makeBanRecord({
      id: "removed-1",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "333333333333333333",
      removedAt: new Date("2026-06-08T11:00:00.000Z"),
      createdAt: new Date("2026-06-08T07:00:00.000Z"),
      updatedAt: new Date("2026-06-08T11:00:00.000Z"),
    });

    const dataset = [activePlayer, fallbackPlayer, activeUser, removedUser];
    prismaMock.banRecord.findMany.mockImplementation(async ({ where }: any) => {
      expect(where.guildId).toBe("guild-1");
      return dataset.filter(
        (row) =>
          row.guildId === where.guildId &&
          row.removedAt === null &&
          (row.expiresAt === null || row.expiresAt > now),
      );
    });
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      { playerTag: "#PYLQ0289", playerName: "Current Alpha" },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "222222222222222222",
        playerName: "Linked Alpha",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ0222",
        discordUserId: "222222222222222222",
        playerName: "Linked Bravo",
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);

    const rows = await service.listActiveBans({ guildId: "guild-1", now });

    expect(rows).toEqual([
      {
        ...activePlayer,
        linkedPlayerTags: [],
        targetPlayerName: "Current Alpha",
      },
      {
        ...fallbackPlayer,
        linkedPlayerTags: [],
        targetPlayerName: "Linked Bravo",
      },
      {
        ...activeUser,
        linkedPlayerTags: ["#PYLQ0289", "#QGRJ0222"],
        targetPlayerName: null,
      },
    ]);
    expect(prismaMock.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerLink.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { playerTag: { in: ["#PYLQ0289", "#QGRJ0222"] } },
            { discordUserId: { in: ["222222222222222222"] } },
          ],
        }),
      }),
    );
    expect(rows.some((row) => row.playerTag === "#QGRJ0222" && row.targetKind === "PLAYER")).toBe(true);
    expect(rows.some((row) => row.discordUserId === "333333333333333333")).toBe(false);
  });

  it("removes an active player ban with a soft delete", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activePlayer = makeBanRecord({
      id: "player-1",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    prismaMock.banRecord.findFirst.mockResolvedValue(activePlayer);
    prismaMock.banRecord.update.mockResolvedValue({
      ...activePlayer,
      removedAt: now,
      removedByDiscordUserId: "444444444444444444",
      updatedAt: now,
    });

    const result = await service.removePlayerBan({
      guildId: "guild-1",
      playerTag: "pylq0289",
      removedByDiscordUserId: "444444444444444444",
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledWith({
      where: { id: "player-1" },
      data: {
        removedAt: now,
        removedByDiscordUserId: "444444444444444444",
        removeReason: null,
      },
    });
    expect(result.outcome).toBe("removed");
    expect(result.record?.removedAt).toEqual(now);
  });

  it("removes an active user ban with a soft delete", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activeUser = makeBanRecord({
      id: "user-1",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });
    prismaMock.banRecord.findFirst.mockResolvedValue(activeUser);
    prismaMock.banRecord.update.mockResolvedValue({
      ...activeUser,
      removedAt: now,
      removedByDiscordUserId: "444444444444444444",
      updatedAt: now,
    });

    const result = await service.removeUserBan({
      guildId: "guild-1",
      discordUserId: "222222222222222222",
      removedByDiscordUserId: "444444444444444444",
      now,
    });

    expect(prismaMock.banRecord.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        removedAt: now,
        removedByDiscordUserId: "444444444444444444",
        removeReason: null,
      },
    });
    expect(result.outcome).toBe("removed");
    expect(result.record?.removedAt).toEqual(now);
  });

  it("returns a not_found result when no active ban exists", async () => {
    const service = new BanService();
    prismaMock.banRecord.findFirst.mockResolvedValue(null);

    const result = await service.removePlayerBan({
      guildId: "guild-1",
      playerTag: "#PYLQ0289",
      removedByDiscordUserId: "444444444444444444",
    });

    expect(result.outcome).toBe("not_found");
    expect(result.record).toBeNull();
  });
});
