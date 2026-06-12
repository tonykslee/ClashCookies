import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findMany: vi.fn(),
  },
  trackedClanRep: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";
import { resolveRepWorkRenderedClanBadgesByUserId } from "../src/services/RepWorkBadgeService";

describe("RepWorkBadgeService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClanRep.findMany.mockReset();
  });

  it("renders full custom emoji clan badges inline as-is", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#AAA111" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        playerTag: "#AAA111",
        clanTag: "#CLAN1",
        clan: {
          tag: "#CLAN1",
          clanBadge: "<:rockyroad:123>",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
    ]);

    const badges = await resolveRepWorkRenderedClanBadgesByUserId({
      client: {} as any,
      userIds: ["111111111111111111"],
    });

    expect(badges.get("111111111111111111")).toEqual(["<:rockyroad:123>"]);
  });

  it("resolves shortcode clan badges through the emoji resolver", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#AAA111" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        playerTag: "#AAA111",
        clanTag: "#CLAN1",
        clan: {
          tag: "#CLAN1",
          clanBadge: ":rockyroad:",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
    ]);
    const resolveByNameSpy = vi
      .spyOn(emojiResolverService, "resolveByName")
      .mockResolvedValueOnce({
        rendered: "<:rockyroad:555>",
      } as any);

    const badges = await resolveRepWorkRenderedClanBadgesByUserId({
      client: { id: "bot" } as any,
      userIds: ["111111111111111111"],
    });

    expect(resolveByNameSpy).toHaveBeenCalledWith({ id: "bot" } as any, "rockyroad");
    expect(badges.get("111111111111111111")).toEqual(["<:rockyroad:555>"]);
  });

  it("fails soft when badge resolution fails", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#AAA111" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        playerTag: "#AAA111",
        clanTag: "#CLAN1",
        clan: {
          tag: "#CLAN1",
          clanBadge: "missing-badge",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
    ]);
    vi.spyOn(emojiResolverService, "resolveByName").mockRejectedValueOnce(new Error("missing"));

    const badges = await resolveRepWorkRenderedClanBadgesByUserId({
      client: { id: "bot" } as any,
      userIds: ["111111111111111111"],
    });

    expect(badges.get("111111111111111111")).toBeUndefined();
  });

  it("dedupes rendered badges per user while preserving tracked-clan order", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      { discordUserId: "111111111111111111", playerTag: "#AAA111" },
      { discordUserId: "111111111111111111", playerTag: "#BBB222" },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        playerTag: "#AAA111",
        clanTag: "#CLAN1",
        clan: {
          tag: "#CLAN1",
          clanBadge: ":badge:",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      },
      {
        playerTag: "#BBB222",
        clanTag: "#CLAN2",
        clan: {
          tag: "#CLAN2",
          clanBadge: ":badge:",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      },
      {
        playerTag: "#BBB222",
        clanTag: "#CLAN3",
        clan: {
          tag: "#CLAN3",
          clanBadge: ":other:",
          createdAt: new Date("2026-06-03T00:00:00.000Z"),
        },
      },
    ]);
    const resolveByNameSpy = vi
      .spyOn(emojiResolverService, "resolveByName")
      .mockResolvedValueOnce({ rendered: "<:badge:111>" } as any)
      .mockResolvedValueOnce({ rendered: "<:other:333>" } as any);

    const badges = await resolveRepWorkRenderedClanBadgesByUserId({
      client: {} as any,
      userIds: ["111111111111111111"],
    });

    expect(resolveByNameSpy).toHaveBeenCalledTimes(2);
    expect(badges.get("111111111111111111")).toEqual(["<:badge:111>", "<:other:333>"]);
  });
});
