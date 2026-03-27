import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  createPlayerLinkFromEmbed,
  backfillMissingDiscordUsernamesForClanMembers,
  listCurrentWeightsForClanMembers,
  listPlayerLinksForClanMembers,
  listPlayerLinksForDiscordUser,
  sanitizeDiscordUsernameForPersistence,
  normalizePersistedDiscordUsername,
  normalizePersistedPlayerName,
} from "../src/services/PlayerLinkService";

describe("PlayerLinkService link identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
  });

  it("normalizes persisted discord username text deterministically", () => {
    expect(normalizePersistedDiscordUsername("  a   b  ")).toBe("a b");
    expect(normalizePersistedDiscordUsername("\n\t")).toBeNull();
    expect(normalizePersistedDiscordUsername(null)).toBeNull();
    expect(sanitizeDiscordUsernameForPersistence("\n\t")).toBe("unknown");
  });

  it("normalizes persisted player name text deterministically", () => {
    expect(normalizePersistedPlayerName("  a   b  ")).toBe("a b");
    expect(normalizePersistedPlayerName("\n\t")).toBeNull();
    expect(normalizePersistedPlayerName(null)).toBeNull();
  });

  it("returns user-scoped links with linkedName from persisted playerName", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "  Alpha One  ",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: " ",
        createdAt: new Date("2026-03-15T09:08:00.000Z"),
      },
    ]);

    const links = await listPlayerLinksForDiscordUser({
      discordUserId: "111111111111111111",
    });

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      where: { discordUserId: "111111111111111111" },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
      select: { playerTag: true, playerName: true, createdAt: true },
    });
    expect(links).toEqual([
      {
        playerTag: "#PYLQ0289",
        linkedAt: new Date("2026-03-15T09:07:00.000Z"),
        linkedName: "Alpha One",
      },
      {
        playerTag: "#QGRJ2222",
        linkedAt: new Date("2026-03-15T09:08:00.000Z"),
        linkedName: null,
      },
    ]);
  });

  it("returns clan-scoped links with persisted discordUsername", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "  Persisted User  ",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);

    const links = await listPlayerLinksForClanMembers({
      memberTagsInOrder: ["#PYLQ0289"],
    });

    expect(links).toEqual([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted User",
        linkedAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
  });

  it("backfills only empty discordUsername rows and does not overwrite existing values", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: null,
      },
      {
        playerTag: "#QGRJ2222",
        discordUserId: "111111111111111111",
        discordUsername: "",
      },
      {
        playerTag: "#G2RC8899",
        discordUserId: "222222222222222222",
        discordUsername: null,
      },
    ]);
    prismaMock.playerLink.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const resolveDiscordUsername = vi.fn(async (discordUserId: string) => {
      if (discordUserId === "111111111111111111") return "  PersistedOne  ";
      return null;
    });

    const result = await backfillMissingDiscordUsernamesForClanMembers({
      memberTagsInOrder: ["#PYLQ0289", "#QGRJ2222", "#G2RC8899"],
      resolveDiscordUsername,
    });

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith({
      where: {
        playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#G2RC8899"] },
        OR: [{ discordUsername: null }, { discordUsername: "" }],
      },
      select: {
        playerTag: true,
        discordUserId: true,
        discordUsername: true,
      },
    });

    expect(resolveDiscordUsername).toHaveBeenCalledTimes(2);
    expect(prismaMock.playerLink.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.playerLink.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        playerTag: "#PYLQ0289",
        OR: [{ discordUsername: null }, { discordUsername: "" }],
      },
      data: {
        discordUsername: "PersistedOne",
      },
    });
    expect(prismaMock.playerLink.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        playerTag: "#QGRJ2222",
        OR: [{ discordUsername: null }, { discordUsername: "" }],
      },
      data: {
        discordUsername: "PersistedOne",
      },
    });

    expect(result).toEqual({
      candidateLinks: 3,
      uniqueUsers: 2,
      resolvedUsers: 1,
      updatedLinks: 2,
    });
  });

  it("creates player link from embed flow with sanitized username", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({});

    const result = await createPlayerLinkFromEmbed({
      playerTag: "pyl0289",
      submittingDiscordUserId: "111111111111111111",
      submittingDiscordUsername: "  test   user  ",
    });

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "test user",
      },
    });
    expect(result).toEqual({
      outcome: "created",
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
    });
  });

  it("maps uniqueness races to deterministic already_linked outcome", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ discordUserId: "222222222222222222" });
    prismaMock.playerLink.create.mockRejectedValue({ code: "P2002" });

    const result = await createPlayerLinkFromEmbed({
      playerTag: "#PYL0289",
      submittingDiscordUserId: "111111111111111111",
      submittingDiscordUsername: "test user",
    });

    expect(result).toEqual({
      outcome: "already_linked",
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
      existingDiscordUserId: "222222222222222222",
    });
  });

  it("returns current clan member weights by player tag in deterministic order", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        weight: 98000,
        sourceSyncedAt: new Date("2026-03-21T11:00:00.000Z"),
      },
      {
        playerTag: "#PYLQ0289",
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-20T10:00:00.000Z"),
      },
    ]);

    const weights = await listCurrentWeightsForClanMembers({
      memberTagsInOrder: ["#PYLQ0289", "#QGRJ2222"],
    });

    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith({
      where: { playerTag: { in: ["#PYLQ0289", "#QGRJ2222"] } },
      select: { playerTag: true, weight: true, sourceSyncedAt: true },
    });
    expect(Array.from(weights.entries())).toEqual([
      ["#PYLQ0289", 145000],
      ["#QGRJ2222", 98000],
    ]);
  });

  it("keeps the latest weight per player tag when duplicate rows exist", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 144000,
        sourceSyncedAt: new Date("2026-03-20T09:00:00.000Z"),
      },
      {
        playerTag: "#PYLQ0289",
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-20T11:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: null,
        sourceSyncedAt: new Date("2026-03-20T11:00:00.000Z"),
      },
    ]);

    const weights = await listCurrentWeightsForClanMembers({
      memberTagsInOrder: ["#PYLQ0289", "#QGRJ2222"],
    });

    expect(Array.from(weights.entries())).toEqual([["#PYLQ0289", 145000]]);
  });
});
