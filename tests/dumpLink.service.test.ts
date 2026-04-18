import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const prismaMock = vi.hoisted(() => {
  const dumpLinks = new Map<
    string,
    {
      guildId: string;
      link: string;
      updatedByDiscordUserId: string;
      createdAt: Date;
      updatedAt: Date;
      clanInfoJson: unknown | null;
      clanInfoFetchedAt: Date | null;
    }
  >();

  return {
    dumpLinks,
    dumpLink: {
      findUnique: vi.fn(async ({ where }: { where: { guildId: string } }) => {
        return dumpLinks.get(where.guildId) ?? null;
      }),
      upsert: vi.fn(async (input: any) => {
        const existing = dumpLinks.get(input.where.guildId);
        const now = new Date("2026-04-15T00:00:00.000Z");
        const next = existing
          ? {
              ...existing,
              ...input.update,
              updatedAt: now,
            }
          : {
              guildId: input.create.guildId,
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
        dumpLinks.set(input.where.guildId, next);
        return next;
      }),
      update: vi.fn(async (input: any) => {
        const existing = dumpLinks.get(input.where.guildId);
        if (!existing) throw new Error("missing dump link");
        const now = new Date("2026-04-15T01:00:00.000Z");
        const next = {
          ...existing,
          ...input.data,
          updatedAt: now,
        };
        dumpLinks.set(input.where.guildId, next);
        return next;
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
  extractDumpClanTagFromLink,
  getDumpLinkForGuild,
  normalizeDumpLink,
  parseDumpClanInfoCache,
  updateDumpLinkClanInfoForGuild,
  upsertDumpLinkForGuild,
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

  it("reads and updates the derived clan cache on the existing DumpLink row", async () => {
    prismaMock.dumpLinks.set("111111111111111111", {
      guildId: "111111111111111111",
      link: "https://example.com/dump",
      updatedByDiscordUserId: "222222222222222222",
      clanInfoJson: null,
      clanInfoFetchedAt: null,
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    });

    const loaded = await getDumpLinkForGuild("111111111111111111");
    expect(prismaMock.dumpLink.findUnique).toHaveBeenCalledWith({
      where: { guildId: "111111111111111111" },
      select: {
        guildId: true,
        link: true,
        updatedByDiscordUserId: true,
        createdAt: true,
        updatedAt: true,
        clanInfoJson: true,
        clanInfoFetchedAt: true,
      },
    });
    expect(loaded?.clanInfoJson).toBeNull();

    await upsertDumpLinkForGuild({
      guildId: "111111111111111111",
      link: "https://example.com/updated",
      updatedByDiscordUserId: "222222222222222222",
    });
    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          clanInfoJson: Prisma.DbNull,
          clanInfoFetchedAt: null,
        }),
        update: expect.objectContaining({
          clanInfoJson: Prisma.DbNull,
          clanInfoFetchedAt: null,
        }),
      }),
    );

    await updateDumpLinkClanInfoForGuild({
      guildId: "111111111111111111",
      clanInfoJson: {
        clanTag: "2QG2C08UP",
        name: "TheWiseCowboys",
        joinType: "inviteOnly",
        minTownHall: 18,
        minLeagueLabel: "Crystal League I",
        minTrophies: 2000,
      },
      clanInfoFetchedAt: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = prismaMock.dumpLinks.get("111111111111111111");
    expect(updated?.clanInfoJson).toEqual({
      clanTag: "2QG2C08UP",
      name: "TheWiseCowboys",
      joinType: "inviteOnly",
      minTownHall: 18,
      minLeagueLabel: "Crystal League I",
      minTrophies: 2000,
    });
    expect(updated?.clanInfoFetchedAt).toEqual(new Date("2026-04-15T01:00:00.000Z"));
  });
});
