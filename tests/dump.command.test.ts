import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const dumpLinks = new Map<
    string,
    {
      guildId: string;
      link: string;
      updatedByDiscordUserId: string;
      createdAt: Date;
      updatedAt: Date;
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
          };
          update: {
            link: string;
            updatedByDiscordUserId: string;
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
                createdAt: now,
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
      },
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No dump link configured for this server.",
    });
  });

  it("returns the stored link wrapped in angle brackets", async () => {
    prismaMock.dumpLinks.set("111111111111111111", {
      guildId: "111111111111111111",
      link: "https://example.com/dump",
      updatedByDiscordUserId: "222222222222222222",
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    });
    const interaction = makeInteraction();

    await Dump.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "<https://example.com/dump>",
    });
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
      },
      update: {
        link: "https://example.com/dump",
        updatedByDiscordUserId: "222222222222222222",
      },
      select: {
        guildId: true,
        link: true,
        updatedByDiscordUserId: true,
        createdAt: true,
        updatedAt: true,
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

    await Dump.run({} as any, readA as any, {} as any);
    await Dump.run({} as any, readB as any, {} as any);

    expect(readA.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "<https://example.com/a>",
    });
    expect(readB.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "<https://example.com/b>",
    });
  });
});
