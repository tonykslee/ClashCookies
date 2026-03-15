import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildLinkListSelectCustomId,
  handleLinkListSelectMenu,
  Link,
} from "../src/commands/Link";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

type InteractionInput = {
  subcommand: "create" | "delete" | "list";
  playerTag?: string | null;
  userOverride?: string | null;
  clanTag?: string | null;
  userId?: string;
  isAdmin?: boolean;
  guildMemberNames?: Record<string, string>;
  cachedUserNames?: Record<string, string>;
};

function makeInteraction(input: InteractionInput) {
  const memberCache = new Map(
    Object.entries(input.guildMemberNames ?? {}).map(([id, displayName]) => [id, { displayName }])
  );
  const userCache = new Map(
    Object.entries(input.cachedUserNames ?? {}).map(([id, username]) => [id, { username }])
  );

  return {
    guildId: "guild-1",
    guild: { members: { cache: memberCache } },
    client: { users: { cache: userCache } },
    user: { id: input.userId ?? "111111111111111111" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(Boolean(input.isAdmin)),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "player-tag") return input.playerTag ?? null;
        if (name === "user") return input.userOverride ?? null;
        if (name === "clan-tag") return input.clanTag ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeValidTag(index: number): string {
  const alphabet = "PYLQGRJCUV0289";
  const a = alphabet[Math.floor(index / alphabet.length) % alphabet.length];
  const b = alphabet[index % alphabet.length];
  return `#PY${a}${b}${a}${b}`;
}

describe("/link run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.delete.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
  });

  it("creates a self-link when tag is unlinked", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
    });
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: { playerTag: "#PYL0289", discordUserId: "111111111111111111" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("created: #PYL0289 linked to you.");
  });

  it("returns conflict when already linked to another user", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "999999999999999999",
    });
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "already_linked_to_other_user: #PYL0289 is linked to <@999999999999999999>. delete-first is required."
    );
  });

  it("rejects create-for-other when admin override permission is denied", async () => {
    vi.spyOn(CommandPermissionService.prototype, "canUseAnyTarget").mockResolvedValue(false);
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userOverride: "222222222222222222",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_allowed: only admins can create links for another Discord user."
    );
    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
  });

  it("deletes link when invoked by owner", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.delete.mockResolvedValue({});
    const interaction = makeInteraction({
      subcommand: "delete",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.delete).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("deleted: #PYL0289.");
  });

  it("renders /link list as embed with linked/unlinked sections and clan dropdown", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      clanBadge: "<:badge:1>",
      name: "Tracked Alpha",
    });
    prismaMock.currentWar.findMany.mockResolvedValue([
      { clanTag: "#PQL0289" },
      { clanTag: "#QGRJ2222" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: "<:badge:1>",
        mailConfig: { displayOrder: 1 },
      },
      {
        tag: "#QGRJ2222",
        name: "Beta Clan",
        clanBadge: null,
        mailConfig: { displayOrder: 2 },
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
      guildMemberNames: { "111111111111111111": "sin" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          { tag: "#PYLQ0289", name: "Player One", townHallLevel: 16, mapPosition: 1 },
          { tag: "#QGRJ2222", name: "Player Two", townHallLevel: 15, mapPosition: 2 },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstEmbed = payload.embeds[0].toJSON();

    expect(firstEmbed.title).toBe("<:badge:1> Alpha Clan #PQL0289");
    expect(firstEmbed.fields.some((f: any) => f.name === "Players linked")).toBe(true);
    expect(firstEmbed.fields.some((f: any) => f.name === "Unlinked Players")).toBe(true);

    const linkedField = firstEmbed.fields.find((f: any) => f.name === "Players linked");
    const unlinkedField = firstEmbed.fields.find((f: any) => f.name === "Unlinked Players");
    expect(linkedField.value).toContain("TH");
    expect(linkedField.value).toContain("sin");
    expect(unlinkedField.value).toContain("#QGRJ2222");

    const select = payload.components[0].components[0].toJSON();
    expect(select.options).toHaveLength(2);
    expect(select.options.some((opt: any) => opt.default && opt.value === "#PQL0289")).toBe(true);
  });

  it("renders deterministic empty linked table with -- none -- placeholder", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: null,
        mailConfig: null,
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [{ tag: "#QGRJ2222", name: "Player Two", townHallLevel: 15, mapPosition: 1 }],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstEmbed = payload.embeds[0].toJSON();
    const linkedField = firstEmbed.fields.find((f: any) => f.name === "Players linked");
    const unlinkedField = firstEmbed.fields.find((f: any) => f.name === "Unlinked Players");

    expect(linkedField.value).toContain("-- none --");
    expect(unlinkedField.value).toContain("#QGRJ2222");
  });

  it("returns deterministic empty-member response when clan has no members", async () => {
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "empty_list: no current clan members for #PQL0289."
    );
  });

  it("limits dropdown to 25 options and includes currently viewed clan", async () => {
    const tags = Array.from({ length: 30 }, (_, idx) => makeValidTag(idx));
    const currentTag = tags[29];
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue(tags.map((tag) => ({ clanTag: tag })));
    prismaMock.trackedClan.findMany.mockResolvedValue(
      tags.map((tag, idx) => ({
        tag,
        name: `Clan ${String(idx + 1).padStart(2, "0")}`,
        clanBadge: null,
        mailConfig: { displayOrder: idx === 29 ? 999 : idx + 1 },
      }))
    );

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: currentTag,
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Current Clan",
        members: [{ tag: currentTag, name: "Current Player", townHallLevel: 16, mapPosition: 1 }],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const select = payload.components[0].components[0].toJSON();

    expect(select.options).toHaveLength(25);
    expect(select.options.map((opt: any) => opt.value)).toContain(currentTag);
    expect(select.options.some((opt: any) => opt.default && opt.value === currentTag)).toBe(true);
  });
});

describe("/link list select menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();

    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PQL0289", name: "Alpha Clan", clanBadge: null, mailConfig: null }]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
  });

  it("updates same message in place for valid selection", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["#PQL0289"],
      update,
      reply,
      deferred: false,
      replied: false,
    };

    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [{ tag: "#PQL0289", name: "Player One", townHallLevel: 15, mapPosition: 1 }],
      }),
    };

    await handleLinkListSelectMenu(interaction as any, cocService as any);

    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0]?.[0] as any;
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds[0].toJSON().title).toContain("Alpha Clan");
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects menu interaction from non-requesting user", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111"),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["#PQL0289"],
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListSelectMenu(interaction as any, {} as any);

    expect(reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this menu.",
    });
    expect(update).not.toHaveBeenCalled();
  });
});
