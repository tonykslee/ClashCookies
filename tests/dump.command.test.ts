import { Prisma } from "@prisma/client";
import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cocServiceMock = vi.hoisted(() => ({
  getClan: vi.fn(),
}));

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
        const key = dumpKey(where.guildId_slot.guildId, where.guildId_slot.slot);
        return dumpLinks.get(key) ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { guildId_slot: { guildId: string; slot: number } };
          create: {
            guildId: string;
            slot: number;
            link: string;
            updatedByDiscordUserId: string;
            clanInfoJson: typeof Prisma.DbNull;
            clanInfoFetchedAt: null;
          };
          update: {
            link: string;
            updatedByDiscordUserId: string;
            clanInfoJson: typeof Prisma.DbNull;
            clanInfoFetchedAt: null;
          };
        }) => {
          const key = dumpKey(where.guildId_slot.guildId, where.guildId_slot.slot);
          const existing = dumpLinks.get(key);
          const now = new Date("2026-04-15T00:00:00.000Z");
          const next: DumpLinkRow = existing
            ? {
                ...existing,
                ...update,
                slot: where.guildId_slot.slot,
                clanInfoJson:
                  update.clanInfoJson === Prisma.DbNull ? null : update.clanInfoJson,
                updatedAt: now,
              }
            : {
                guildId: create.guildId,
                slot: create.slot,
                link: create.link,
                updatedByDiscordUserId: create.updatedByDiscordUserId,
                clanInfoJson:
                  create.clanInfoJson === Prisma.DbNull ? null : create.clanInfoJson,
                clanInfoFetchedAt: create.clanInfoFetchedAt ?? null,
                createdAt: now,
                updatedAt: now,
              };

          dumpLinks.set(key, next);
          return next;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { guildId_slot: { guildId: string; slot: number } };
          data: {
            clanInfoJson: unknown | null;
            clanInfoFetchedAt: Date | null;
          };
        }) => {
          const key = dumpKey(where.guildId_slot.guildId, where.guildId_slot.slot);
          const existing = dumpLinks.get(key);
          if (!existing) throw new Error("missing dump link");
          const now = new Date("2026-04-15T01:00:00.000Z");
          const next: DumpLinkRow = {
            ...existing,
            ...data,
            updatedAt: now,
          };
          dumpLinks.set(key, next);
          return next;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { guildId_slot: { guildId: string; slot: number } } }) => {
        const key = dumpKey(where.guildId_slot.guildId, where.guildId_slot.slot);
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
  slot?: number | null;
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
      getInteger: vi.fn((name: string) => {
        if (name === "slot") return input?.slot ?? null;
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
  slot?: number;
  link: string;
  clanInfoJson?: unknown | null;
  clanInfoFetchedAt?: Date | null;
}) {
  const slot = input.slot ?? 1;
  prismaMock.dumpLinks.set(prismaMock.dumpKey(input.guildId, slot), {
    guildId: input.guildId,
    slot,
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
  it("registers optional edit and slot options with slot choices 1 to 3", () => {
    const editOption = Dump.options?.find((option) => option.name === "edit");
    const slotOption = Dump.options?.find((option) => option.name === "slot");

    expect(editOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(editOption?.required).toBe(false);
    expect(editOption?.autocomplete).toBeUndefined();

    expect(slotOption?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(slotOption?.required).toBe(false);
    expect(slotOption?.choices).toEqual([
      { name: "1", value: 1 },
      { name: "2", value: 2 },
      { name: "3", value: 3 },
    ]);
  });
});

describe("/dump command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.dumpLinks.clear();
  });

  it("returns a no-config message when the guild has no stored links", async () => {
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.findMany).toHaveBeenCalledWith({
      where: { guildId: "111111111111111111" },
      orderBy: [{ slot: "asc" }],
      select: {
        guildId: true,
        slot: true,
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

  it("renders live clan info for slot 1, persists the derived cache, and wraps the link", async () => {
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
      where: {
        guildId_slot: {
          guildId: "111111111111111111",
          slot: 1,
        },
      },
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
        slot: true,
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
        clanTag: "#2QG2C08UP",
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

  it("returns a fallback block when no cache is available and live fetch fails", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      link: "https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP",
    });
    cocServiceMock.getClan.mockRejectedValue(new Error("boom"));
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(getReplyContent(interaction)).toBe(
      ["Clan info unavailable", "<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP>"].join("\n"),
    );
  });

  it("shows multiple dump blocks in slot order separated by the divider", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      slot: 3,
      link: "https://example.com/c",
      clanInfoJson: {
        clanTag: "#C",
        name: "Clan C",
        joinType: "open",
        minTownHall: 15,
        minLeagueLabel: "Gold League I",
        minTrophies: 1700,
      },
    });
    setStoredDumpLink({
      guildId: "111111111111111111",
      slot: 1,
      link: "https://example.com/a",
      clanInfoJson: {
        clanTag: "#A",
        name: "Clan A",
        joinType: "inviteOnly",
        minTownHall: 16,
        minLeagueLabel: "Crystal League II",
        minTrophies: 2100,
      },
    });
    cocServiceMock.getClan.mockRejectedValue(new Error("boom"));
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    const output = getReplyContent(interaction);
    expect(output).toBe(
      [
        "Name: Clan A",
        "Join: Invite only",
        "Min TH: TH16",
        "Min Leagues: Crystal League II",
        "<https://example.com/a>",
        "------------",
        "Name: Clan C",
        "Join: Anyone can join",
        "Min TH: TH15",
        "Min Leagues: Gold League I",
        "<https://example.com/c>",
      ].join("\n"),
    );
    expect(output).toContain("------------");
  });

  it("upserts slot 1 by default for admins and confirms with wrapped text", async () => {
    const interaction = makeInteraction({
      edit: "https://example.com/dump",
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith({
      where: {
        guildId_slot: {
          guildId: "111111111111111111",
          slot: 1,
        },
      },
      create: {
        guildId: "111111111111111111",
        slot: 1,
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
        slot: true,
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

  it("upserts the requested slot and clears stale cached clan info for that slot only", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      slot: 2,
      link: "https://example.com/old",
      clanInfoJson: {
        clanTag: "#OLD",
        name: "Old Clan",
        joinType: "open",
        minTownHall: 14,
        minLeagueLabel: "Gold League III",
        minTrophies: 1200,
      },
    });
    const interaction = makeInteraction({
      edit: "https://example.com/new",
      slot: 2,
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId_slot: {
            guildId: "111111111111111111",
            slot: 2,
          },
        },
        update: {
          link: "https://example.com/new",
          updatedByDiscordUserId: "222222222222222222",
          clanInfoJson: Prisma.DbNull,
          clanInfoFetchedAt: null,
        },
      }),
    );
    const slot2 = prismaMock.dumpLinks.get("111111111111111111:2");
    expect(slot2?.link).toBe("https://example.com/new");
    expect(slot2?.clanInfoJson).toBeNull();
    expect(prismaMock.dumpLinks.get("111111111111111111:1")).toBeUndefined();
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

  it("deletes a slot for admins and leaves other slots untouched", async () => {
    setStoredDumpLink({
      guildId: "111111111111111111",
      slot: 1,
      link: "https://example.com/a",
    });
    setStoredDumpLink({
      guildId: "111111111111111111",
      slot: 2,
      link: "https://example.com/b",
    });
    const interaction = makeInteraction({
      slot: 2,
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.delete).toHaveBeenCalledWith({
      where: {
        guildId_slot: {
          guildId: "111111111111111111",
          slot: 2,
        },
      },
    });
    expect(prismaMock.dumpLinks.has("111111111111111111:2")).toBe(false);
    expect(prismaMock.dumpLinks.has("111111111111111111:1")).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Deleted dump link in slot 2.",
    });
  });

  it("rejects deleting an empty slot with a clear message", async () => {
    const interaction = makeInteraction({
      slot: 2,
      isAdmin: true,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.delete).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No dump link configured in slot 2.",
    });
  });

  it("rejects slot edits and deletes from non-admin users", async () => {
    const interaction = makeInteraction({
      slot: 3,
      isAdmin: false,
    });

    await Dump.run({} as any, interaction as any, {} as any);

    expect(prismaMock.dumpLink.delete).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "not_allowed: only admins can delete dump slots.",
    });
  });

  it("stores guild links independently per slot and lists them in slot order", async () => {
    const guildA1 = makeInteraction({
      guildId: "111111111111111111",
      edit: "https://example.com/a1",
      isAdmin: true,
      slot: 1,
    });
    const guildA3 = makeInteraction({
      guildId: "111111111111111111",
      edit: "https://example.com/a3",
      isAdmin: true,
      slot: 3,
    });

    await Dump.run({} as any, guildA1 as any, {} as any);
    await Dump.run({} as any, guildA3 as any, {} as any);

    const read = makeInteraction({ guildId: "111111111111111111" });
    cocServiceMock.getClan.mockRejectedValue(new Error("boom"));

    await Dump.run({} as any, read as any, {} as any);

    const output = getReplyContent(read);
    expect(output).toContain("<https://example.com/a1>");
    expect(output).toContain("<https://example.com/a3>");
    expect(output).toContain("------------");
    expect(output.indexOf("<https://example.com/a1>")).toBeLessThan(
      output.indexOf("<https://example.com/a3>"),
    );
  });
});
