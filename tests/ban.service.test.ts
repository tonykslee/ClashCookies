import { beforeEach, describe, expect, it, vi } from "vitest";
import { BanService } from "../src/services/BanService";

const prismaMock = vi.hoisted(() => ({
  banRecord: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  playerLink: {
    findUnique: vi.fn(),
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

describe("BanService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.banRecord.findFirst.mockReset();
    prismaMock.banRecord.findMany.mockReset();
    prismaMock.banRecord.create.mockReset();
    prismaMock.banRecord.update.mockReset();
    prismaMock.playerLink.findUnique.mockReset();
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
    expect(prismaMock.banRecord.create).toHaveBeenCalledWith({
      data: {
        guildId: "guild-1",
        targetKind: "USER",
        playerTag: null,
        discordUserId: "222222222222222222",
        reason: "Alt abuse",
        bannedByDiscordUserId: "111111111111111111",
        expiresAt: null,
      },
    });
    expect(result.outcome).toBe("created");
    expect(result.record?.discordUserId).toBe("222222222222222222");
  });

  it("lists active bans and resolves linked player tags for active user bans", async () => {
    const service = new BanService();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const activePlayer = makeBanRecord({
      id: "player-1",
      targetKind: "PLAYER",
      playerTag: "#PYLQ0289",
      reason: null,
      expiresAt: null,
      createdAt: new Date("2026-06-08T10:00:00.000Z"),
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    const activeUser = makeBanRecord({
      id: "user-1",
      targetKind: "USER",
      playerTag: null,
      discordUserId: "222222222222222222",
      reason: "Alt abuse",
      expiresAt: new Date("2026-07-08T12:00:00.000Z"),
      createdAt: new Date("2026-06-08T09:00:00.000Z"),
      updatedAt: new Date("2026-06-08T09:00:00.000Z"),
    });
    const expiredPlayer = makeBanRecord({
      id: "expired-1",
      targetKind: "PLAYER",
      playerTag: "#QGRJ0222",
      expiresAt: new Date("2026-06-08T11:59:59.000Z"),
      createdAt: new Date("2026-06-08T08:00:00.000Z"),
      updatedAt: new Date("2026-06-08T08:00:00.000Z"),
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

    const dataset = [activePlayer, activeUser, expiredPlayer, removedUser];
    prismaMock.banRecord.findMany.mockImplementation(async ({ where }: any) => {
      expect(where.guildId).toBe("guild-1");
      return dataset.filter(
        (row) =>
          row.guildId === where.guildId &&
          row.removedAt === null &&
          (row.expiresAt === null || row.expiresAt > now),
      );
    });
    listPlayerLinksForDiscordUserMock.mockResolvedValue([
      { playerTag: "#PYLQ0289", linkedAt: new Date("2026-06-01T00:00:00.000Z"), linkedName: null },
      { playerTag: "#QGRJ0222", linkedAt: new Date("2026-06-02T00:00:00.000Z"), linkedName: null },
    ]);

    const rows = await service.listActiveBans({ guildId: "guild-1", now });

    expect(rows).toEqual([
      {
        ...activePlayer,
        linkedPlayerTags: [],
      },
      {
        ...activeUser,
        linkedPlayerTags: ["#PYLQ0289", "#QGRJ0222"],
      },
    ]);
    expect(listPlayerLinksForDiscordUserMock).toHaveBeenCalledWith({
      discordUserId: "222222222222222222",
    });
    expect(rows.some((row) => row.playerTag === "#QGRJ0222" && row.targetKind === "PLAYER")).toBe(false);
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
