import { ApplicationCommandOptionType } from "discord.js";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cocServiceMock = vi.hoisted(() => ({
  getClan: vi.fn(),
}));

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
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { guildId: string };
          create: {
            guildId: string;
            link: string;
            updatedByDiscordUserId: string;
            clanInfoJson: null;
            clanInfoFetchedAt: null;
          };
          update: {
            link: string;
            updatedByDiscordUserId: string;
            clanInfoJson: null;
            clanInfoFetchedAt: null;
          };
        }) => {
          const existing = dumpLinks.get(where.guildId);
          const now = new Date("2026-04-15T00:00:00.000Z");
          const next = existing
            ? {
                ...existing,
                ...update,
                updatedAt: now,
              }
          : {
                guildId: create.guildId,
                link: create.link,
                updatedByDiscordUserId: create.updatedByDiscordUserId,
                clanInfoJson:
                  create.clanInfoJson === Prisma.DbNull ? null : create.clanInfoJson,
                clanInfoFetchedAt: null,
                createdAt: now,
                updatedAt: now,
              };

          dumpLinks.set(where.guildId, next);
          return next;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { guildId: string };
          data: {
            clanInfoJson: unknown | null;
            clanInfoFetchedAt: Date | null;
          };
        }) => {
          const existing = dumpLinks.get(where.guildId);
          if (!existing) throw new Error("missing dump link");
          const now = new Date("2026-04-15T01:00:00.000Z");
          const next = {
            ...existing,
            ...data,
            updatedAt: now,
          };
          dumpLinks.set(where.guildId, next);
          return next;
        },
      ),
    },
  };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCService", () => ({
  CoCService: class {
    getClan = cocServiceMock.getClan;
  },
}));

import { Dump } from "../src/commands/Dump";

function makeInteraction(input?: {
  guildId?: string;
  isAdmin?: boolean;
  edit?: string | null;
}) {
  return {
    inGuild: vi.fn().mockReturnValue(true),
    guildId: input?.guildId ?? "111111111111111111",
    user: { id: "222222222222222222" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(input?.isAdmin ?? true),
    },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "edit") return input?.edit ?? null;
        return null;
      }),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferred: false,
    replied: false,
  };
}

function setStoredDumpLink(input: {
  guildId: string;
  link: string;
  clanInfoJson?: unknown | null;
  clanInfoFetchedAt?: Date | null;
}) {
  prismaMock.dumpLinks.set(input.guildId, {
    guildId: input.guildId,
    link: input.link,
    updatedByDiscordUserId: "222222222222222222",
    clanInfoJson: input.clanInfoJson ?? null,
    clanInfoFetchedAt: input.clanInfoFetchedAt ?? null,
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
  });
}

function getReplyContent(interaction: { reply: { mock: { calls: unknown[][] } } }): string {
  const payload = interaction.reply.mock.calls.at(-1)?.[0] as { content?: unknown } | undefined;
  return String(payload?.content ?? "");
}

describe("/dump command shape", () => {
  it("registers an optional string edit option without autocomplete", () => {
    const editOption = Dump.options?.find((option) => option.name === "edit");

    expect(editOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(editOption?.required).toBe(false);
    expect(editOption?.autocomplete).toBeUndefined();
  });
});

describe("/dump command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dumpLinks.clear();
  });

  it("returns a no-config message when the guild has no stored link", async () => {
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

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
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No dump link configured for this server.",
    });
  });

  it("renders live clan info, persists the derived cache, and wraps the link", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      link: "https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP",
    });
    cocServiceMock.getClan.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "TheWiseCowboys",
      type: "inviteOnly",
      requiredTownhallLevel: 17,
      requiredTrophies: 2_000,
    });
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.update).toHaveBeenCalledWith({
            where: { guildId: "111111111111111111" },
      data: {
        clanInfoJson: {
          clanTag: "#2QG2C08UP",
          name: "TheWiseCowboys",
          joinType: "inviteOnly",
          minTownHall: 17,
          minLeagueLabel: "Crystal League I",
          minTrophies: 2000,
        },
        clanInfoFetchedAt: expect.any(Date),
      },
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
    expect(getReplyContent(interaction)).toBe(
      [
        "Name: TheWiseCowboys",
        "Join: Invite only",
        "Min TH: TH17",
        "Min Leagues: Crystal League I",
        "<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP>",
      ].join("\n"),
    );
  });

  it("falls back to cached clan info when live fetch fails", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      link: "https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP",
      clanInfoJson: {
        clanTag: "2QG2C08UP",
        name: "Cached Clan",
        joinType: "closed",
        minTownHall: null,
        minLeagueLabel: "Gold League II",
        minTrophies: 1600,
      },
      clanInfoFetchedAt: new Date("2026-04-15T00:00:00.000Z"),
    });
    cocServiceMock.getClan.mockRejectedValue(new Error("boom"));
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.update).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toBe(
      [
        "Name: Cached Clan",
        "Join: Closed",
        "Min TH: Unknown",
        "Min Leagues: Gold League II",
        "<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP>",
      ].join("\n"),
    );
  });

  it("returns the wrapped link with a short notice when no cache is available and live fetch fails", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      link: "https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP",
    });
    cocServiceMock.getClan.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "TheWiseCowboys",
      type: "inviteOnly",
      requiredTownhallLevel: 17,
      requiredTrophies: 2_000,
    });
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(getReplyContent(interaction)).toBe(
      [
        "Name: TheWiseCowboys",
        "Join: Invite only",
        "Min TH: TH17",
        "Min Leagues: Crystal League I",
        "<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP>",
      ].join("\n"),
    );
  });

  it("upserts a valid edit link for admins and confirms with wrapped text", async () => {
    const interaction = makeInteraction({
      edit: "https://example.com/dump",
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith({
      where: { guildId: "111111111111111111" },
      create: {
        guildId: "111111111111111111",
        link: "https://example.com/dump",
        updatedByDiscordUserId: "222222222222222222",
        clanInfoJson: Prisma.DbNull,
        clanInfoFetchedAt: null,
      },
      update: {
        link: "https://example.com/dump",
        updatedByDiscordUserId: "222222222222222222",
        clanInfoJson: Prisma.DbNull,
        clanInfoFetchedAt: null,
      },
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
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "<https://example.com/dump>",
    });
  });

  it("rejects edits from non-admin users", async () => {
    const interaction = makeInteraction({
      edit: "https://example.com/dump",
      isAdmin: false,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.upsert).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "not_allowed: only admins can edit the dump link.",
    });
  });

  it("rejects invalid edit URLs", async () => {
    const interaction = makeInteraction({
      edit: "notaurl",
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.upsert).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Invalid URL. Provide a valid http or https link.",
    });
  });

  it("stores guild links independently per guild", async () => {
    const guildA = makeInteraction({
      guildId: "111111111111111111",
      edit: "https://example.com/a",
      isAdmin: true,
    });
    const guildB = makeInteraction({
      guildId: "222222222222222222",
      edit: "https://example.com/b",
      isAdmin: true,
    });

    await Dump.run({} as any, guildA as any, {} as any);
    await Dump.run({} as any, guildB as any, {} as any);

    const readA = makeInteraction({ guildId: "111111111111111111" });
    const readB = makeInteraction({ guildId: "222222222222222222" });

    cocServiceMock.getClan.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "TheWiseCowboys",
      type: "inviteOnly",
      requiredTownhallLevel: 17,
      requiredTrophies: 2_000,
    });

    await Dump.run({} as any, readA as any, {} as any);
    await Dump.run({} as any, readB as any, {} as any);

    expect(getReplyContent(readA)).toContain("<https://example.com/a>");
    expect(getReplyContent(readB)).toContain("<https://example.com/b>");
  });
});
