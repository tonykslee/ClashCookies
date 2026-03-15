import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  backfillMissingDiscordUsernamesForClanMembers,
  listPlayerLinksForClanMembers,
  normalizePersistedDiscordUsername,
} from "../src/services/PlayerLinkService";

describe("PlayerLinkService discordUsername", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
  });

  it("normalizes persisted discord username text deterministically", () => {
    expect(normalizePersistedDiscordUsername("  a   b  ")).toBe("a b");
    expect(normalizePersistedDiscordUsername("\n\t")).toBeNull();
    expect(normalizePersistedDiscordUsername(null)).toBeNull();
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
});
