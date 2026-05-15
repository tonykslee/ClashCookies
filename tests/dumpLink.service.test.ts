import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DumpLinkRow = {
  guildId: string;
  slot: number;
  link: string;
  updatedByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
  clanInfoJson: unknown | null;
  clanInfoFetchedAt: Date | null;
};

const prismaMock = vi.hoisted(() => {
  const dumpLinks = new Map<string, DumpLinkRow>();
  const dumpKey = (guildId: string, slot: number): string => `${guildId}:${slot}`;

  return {
    dumpLinks,
    dumpKey,
    dumpLink: {
      findMany: vi.fn(async ({ where }: { where?: { guildId?: string } }) => {
        const guildId = String(where?.guildId ?? "").trim();
        return [...dumpLinks.values()]
          .filter((row) => !guildId || row.guildId === guildId)
          .sort((left, right) => left.slot - right.slot);
      }),
      findUnique: vi.fn(async ({ where }: { where: { guildId_slot: { guildId: string; slot: number } } }) => {
        return dumpLinks.get(dumpKey(where.guildId_slot.guildId, where.guildId_slot.slot)) ?? null;
      }),
      upsert: vi.fn(async (input: any) => {
        const key = dumpKey(input.where.guildId_slot.guildId, input.where.guildId_slot.slot);
        const existing = dumpLinks.get(key);
        const now = new Date("2026-04-15T00:00:00.000Z");
        const next = existing
          ? {
              ...existing,
              ...input.update,
              slot: input.where.guildId_slot.slot,
              updatedAt: now,
            }
          : {
              guildId: input.create.guildId,
              slot: input.create.slot,
              link: input.create.link,
              updatedByDiscordUserId: input.create.updatedByDiscordUserId,
              clanInfoJson:
                input.create.clanInfoJson === Prisma.DbNull
                  ? null
                  : input.create.clanInfoJson ?? null,
              clanInfoFetchedAt: input.create.clanInfoFetchedAt ?? null,
              createdAt: now,
              updatedAt: now,
            };
        dumpLinks.set(key, next);
        return next;
      }),
      update: vi.fn(async (input: any) => {
        const key = dumpKey(input.where.guildId_slot.guildId, input.where.guildId_slot.slot);
        const existing = dumpLinks.get(key);
        if (!existing) throw new Error("missing dump link");
        const now = new Date("2026-04-15T01:00:00.000Z");
        const next = {
          ...existing,
          ...input.data,
          updatedAt: now,
        };
        dumpLinks.set(key, next);
        return next;
      }),
      delete: vi.fn(async (input: any) => {
        const key = dumpKey(input.where.guildId_slot.guildId, input.where.guildId_slot.slot);
        const existing = dumpLinks.get(key);
        if (!existing) throw new Error("missing dump link");
        dumpLinks.delete(key);
        return existing;
      }),
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildDumpClanInfoCacheFromClan,
  buildDumpClanInfoContent,
  buildDumpClanInfoFallbackContent,
  deleteDumpLinkForGuildSlot,
  extractDumpClanTagFromLink,
  getDumpLinkForGuild,
  getDumpLinkForGuildSlot,
  listDumpLinksForGuild,
  normalizeDumpLink,
  parseDumpClanInfoCache,
  updateDumpLinkClanInfoForGuild,
  updateDumpLinkClanInfoForGuildSlot,
  upsertDumpLinkForGuild,
  upsertDumpLinkForGuildSlot,
} from "../src/services/DumpLinkService";

describe("DumpLinkService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dumpLinks.clear();
  });

  it("normalizes links and extracts clan tags from dump URLs", () => {
    expect(normalizeDumpLink("<https://example.com/dump>")).toBe("https://example.com/dump");
    expect(
      extractDumpClanTagFromLink(
        "https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP",
      ),
    ).toBe("#2QG2C08UP");
  });

  it("treats partial or invalid cache JSON as a miss", () => {
    expect(parseDumpClanInfoCache({ clanTag: "2QG2C08UP", name: "Clan" })).toBeNull();
    expect(
      parseDumpClanInfoCache({
        clanTag: "#2QG2C08UP",
        name: "Clan",
        joinType: "open",
        minTownHall: 17,
        minLeagueLabel: "Crystal League I",
        minTrophies: 2000,
      }),
    ).toEqual({
      clanTag: "#2QG2C08UP",
      name: "Clan",
      joinType: "open",
      minTownHall: 17,
      minLeagueLabel: "Crystal League I",
      minTrophies: 2000,
    });
  });

  it("builds live cache text and fallback text deterministically", () => {
    const cache = buildDumpClanInfoCacheFromClan({
      clanTag: "#2QG2C08UP",
      clan: {
        tag: "#2QG2C08UP",
        name: "TheWiseCowboys",
        type: "inviteOnly",
        requiredTownhallLevel: 18,
        requiredTrophies: 2000,
      },
    });

    expect(cache).toEqual({
      clanTag: "#2QG2C08UP",
      name: "TheWiseCowboys",
      joinType: "inviteOnly",
      minTownHall: 18,
      minLeagueLabel: "Crystal League I",
      minTrophies: 2000,
    });
    expect(buildDumpClanInfoContent(cache!, "https://example.com/dump")).toBe(
      [
        "Name: TheWiseCowboys",
        "Join: Invite only",
        "Min TH: TH18",
        "Min Leagues: Crystal League I",
        "<https://example.com/dump>",
      ].join("\n"),
    );
    expect(buildDumpClanInfoFallbackContent("https://example.com/dump")).toBe(
      ["Clan info unavailable", "<https://example.com/dump>"].join("\n"),
    );
  });

  it("lists and updates dump links by slot independently", async () => {
    prismaMock.dumpLinks.set(prismaMock.dumpKey("111111111111111111", 1), {
      guildId: "111111111111111111",
      slot: 1,
      link: "https://example.com/one",
      updatedByDiscordUserId: "222222222222222222",
      clanInfoJson: null,
      clanInfoFetchedAt: null,
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    });
    prismaMock.dumpLinks.set(prismaMock.dumpKey("111111111111111111", 3), {
      guildId: "111111111111111111",
      slot: 3,
      link: "https://example.com/three",
      updatedByDiscordUserId: "333333333333333333",
      clanInfoJson: null,
      clanInfoFetchedAt: null,
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    });

    const listed = await listDumpLinksForGuild("111111111111111111");
    expect(listed.map((row) => row.slot)).toEqual([1, 3]);

    const loaded = await getDumpLinkForGuildSlot({
      guildId: "111111111111111111",
      slot: 3,
    });
    expect(loaded?.link).toBe("https://example.com/three");
    await expect(getDumpLinkForGuild("111111111111111111")).resolves.toMatchObject({
      slot: 1,
      link: "https://example.com/one",
    });

    await upsertDumpLinkForGuildSlot({
      guildId: "111111111111111111",
      slot: 2,
      link: "https://example.com/two",
      updatedByDiscordUserId: "222222222222222222",
    });
    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId_slot: {
            guildId: "111111111111111111",
            slot: 2,
          },
        },
        create: expect.objectContaining({
          slot: 2,
          clanInfoJson: Prisma.DbNull,
          clanInfoFetchedAt: null,
        }),
        update: expect.objectContaining({
          clanInfoJson: Prisma.DbNull,
          clanInfoFetchedAt: null,
        }),
      }),
    );

    await updateDumpLinkClanInfoForGuildSlot({
      guildId: "111111111111111111",
      slot: 2,
      clanInfoJson: {
        clanTag: "#2QG2C08UP",
        name: "TheWiseCowboys",
        joinType: "inviteOnly",
        minTownHall: 18,
        minLeagueLabel: "Crystal League I",
        minTrophies: 2000,
      },
      clanInfoFetchedAt: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = prismaMock.dumpLinks.get(prismaMock.dumpKey("111111111111111111", 2));
    expect(updated?.clanInfoJson).toEqual({
      clanTag: "#2QG2C08UP",
      name: "TheWiseCowboys",
      joinType: "inviteOnly",
      minTownHall: 18,
      minLeagueLabel: "Crystal League I",
      minTrophies: 2000,
    });
    expect(updated?.clanInfoFetchedAt).toEqual(new Date("2026-04-15T01:00:00.000Z"));

    const deleted = await deleteDumpLinkForGuildSlot({
      guildId: "111111111111111111",
      slot: 3,
    });
    expect(deleted?.slot).toBe(3);
    expect(prismaMock.dumpLinks.has(prismaMock.dumpKey("111111111111111111", 3))).toBe(false);
  });

  it("preserves legacy slot 1 wrapper helpers", async () => {
    prismaMock.dumpLinks.set(prismaMock.dumpKey("111111111111111111", 1), {
      guildId: "111111111111111111",
      slot: 1,
      link: "https://example.com/legacy",
      updatedByDiscordUserId: "222222222222222222",
      clanInfoJson: null,
      clanInfoFetchedAt: null,
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    });

    const loaded = await getDumpLinkForGuild("111111111111111111");
    expect(loaded?.slot).toBe(1);

    await upsertDumpLinkForGuild({
      guildId: "111111111111111111",
      link: "https://example.com/updated",
      updatedByDiscordUserId: "222222222222222222",
    });
    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId_slot: {
            guildId: "111111111111111111",
            slot: 1,
          },
        },
      }),
    );

    await updateDumpLinkClanInfoForGuild({
      guildId: "111111111111111111",
      clanInfoJson: {
        clanTag: "#2QG2C08UP",
        name: "TheWiseCowboys",
        joinType: "inviteOnly",
        minTownHall: 18,
        minLeagueLabel: "Crystal League I",
        minTrophies: 2000,
      },
      clanInfoFetchedAt: new Date("2026-04-15T01:00:00.000Z"),
    });
    expect(prismaMock.dumpLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId_slot: {
            guildId: "111111111111111111",
            slot: 1,
          },
        },
      }),
    );
  });
});
