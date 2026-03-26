import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { PlayerLinkSyncService } from "../src/services/PlayerLinkSyncService";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn().mockResolvedValue([]),
  $executeRaw: vi.fn().mockResolvedValue(0),
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
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildLinkEmbedAccountButtonCustomId,
  buildLinkEmbedSetupModalCustomId,
  buildLinkEmbedTagModalCustomId,
  buildLinkListSelectCustomId,
  buildLinkListSortButtonCustomId,
  handleLinkEmbedButtonInteraction,
  handleLinkEmbedModalSubmit,
  handleLinkListSelectMenu,
  handleLinkListSortButton,
  isLinkEmbedAccountButtonCustomId,
  isLinkEmbedModalCustomId,
  Link,
} from "../src/commands/Link";
import { CommandPermissionService } from "../src/services/CommandPermissionService";

type InteractionInput = {
  subcommand: "create" | "delete" | "list" | "embed" | "sync-clashperk";
  sheetUrl?: string | null;
  playerTag?: string | null;
  userOverride?: string | null;
  clanTag?: string | null;
  channel?: any;
  userId?: string;
  isAdmin?: boolean;
  guildMemberNames?: Record<string, string>;
  cachedUserNames?: Record<string, string>;
  clientApplication?: any;
};

function makeInteraction(input: InteractionInput) {
  const guildMemberCache = new Map(
    Object.entries(input.guildMemberNames ?? {}).map(([id, displayName]) => [
      id,
      { displayName },
    ]),
  );
  const userCache = new Map(
    Object.entries(input.cachedUserNames ?? {}).map(([id, username]) => [
      id,
      { username },
    ]),
  );

  return {
    guildId: "guild-1",
    inGuild: vi.fn().mockReturnValue(true),
    guild: { members: { cache: guildMemberCache } },
    client: {
      users: { cache: userCache },
      ...(input.clientApplication
        ? { application: input.clientApplication }
        : {}),
    },
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
        if (name === "sheet-url") return input.sheetUrl ?? null;
        return null;
      }),
      getChannel: vi.fn((name: string) => {
        if (name === "channel") return input.channel ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  };
}

function makeValidTag(index: number): string {
  const alphabet = "PYLQGRJCUV0289";
  const a = alphabet[Math.floor(index / alphabet.length) % alphabet.length];
  const b = alphabet[index % alphabet.length];
  return `#PY${a}${b}${a}${b}`;
}

function getInlineRowSegments(row: string): {
  statusKind: "linked" | "unlinked" | "";
  statusToken: string;
  th: string;
  weight: string;
  player: string;
  third: string;
} {
  const normalized = String(row ?? "");
  const prefixMatch = normalized.match(/^(\S+)\s/);
  const statusToken = String(prefixMatch?.[1] ?? "");
  const statusKind = /:yes:\d+>$/i.test(statusToken) || statusToken === "✅"
    ? "linked"
    : /:no:\d+>$/i.test(statusToken) || statusToken === "❌"
      ? "unlinked"
      : "";
  const codeStart = normalized.indexOf("`");
  const codeEnd = normalized.lastIndexOf("`");
  const codeText =
    codeStart >= 0 && codeEnd > codeStart
      ? normalized.slice(codeStart + 1, codeEnd)
      : "";
  const [th = "", third = "", player = "", weight = ""] = codeText
    .split(/\s{2,}/)
    .map((part) => part)
    .filter((part) => part.length > 0);
  return {
    statusKind,
    statusToken,
    th: th.trim(),
    weight,
    player,
    third,
  };
}

describe("/link run", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.delete.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
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
    expect(interaction.editReply).toHaveBeenCalledWith(
      "created: #PYL0289 linked to you.",
    );
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
      "already_linked_to_other_user: #PYL0289 is linked to <@999999999999999999>. delete-first is required.",
    );
  });

  it("rejects create-for-other when admin override permission is denied", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(false);
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userOverride: "222222222222222222",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_allowed: only admins can create links for another Discord user.",
    );
    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
  });

  it("rejects /link embed when permission check fails", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(false);
    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      type: ChannelType.GuildText,
      send: vi.fn(),
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
    };
    const interaction = makeInteraction({
      subcommand: "embed",
      channel,
      isAdmin: false,
    }) as any;
    interaction.guild = {
      members: {
        cache: new Map(),
        me: { id: "bot-1" },
      },
    };

    await Link.run({} as any, interaction, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "not_allowed: only admins can use /link embed.",
    });
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it("opens /link embed setup modal for authorized users with valid target channel", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(true);
    const permissionHas = vi
      .fn()
      .mockImplementation((bit: bigint) =>
        [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ].includes(bit),
      );
    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      type: ChannelType.GuildText,
      send: vi.fn(),
      permissionsFor: vi.fn().mockReturnValue({
        has: permissionHas,
      }),
    };
    const interaction = makeInteraction({
      subcommand: "embed",
      channel,
      isAdmin: false,
    }) as any;
    interaction.guild = {
      members: {
        cache: new Map(),
        me: { id: "bot-1" },
      },
    };

    await Link.run({} as any, interaction, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.title).toBe("Link Account Embed");
    expect(modal.components).toHaveLength(4);
    expect(interaction.deferReply).not.toHaveBeenCalled();
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
      isAdmin: true,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.delete).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith("deleted: #PYL0289.");
  });

  it("renders /link list with linked/unlinked count buckets and inline padded rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted Sin",
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 98000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
      guildMemberNames: { "111111111111111111": "Sin Display" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Tilonius",
            townHallLevel: 18,
            mapPosition: 1,
          },
          {
            tag: "#QGRJ2222",
            name: "Unlinked Guy",
            townHallLevel: 15,
            mapPosition: 2,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstEmbed = payload.embeds[0].toJSON();

    expect(firstEmbed.title).toBe("<:badge:1> Alpha Clan #PQL0289");
    expect(firstEmbed.footer?.text).toBe("Sort: Discord Name");
    const description = String(firstEmbed.description ?? "");
    expect(description).toContain("Linked Users: 1");
    expect(description).toContain("Unlinked users: 1");
    expect(description).not.toContain("(111111111111111111)");
    expect(firstEmbed.fields ?? []).toHaveLength(0);

    const rows = description
      .split("\n")
      .filter(
        (line: string) =>
          /^(?:✅|❌|<a?:yes:\d+>|<a?:no:\d+>) `/.test(line) &&
          line.endsWith("`"),
      );
    expect(rows).toHaveLength(2);

    const linkedRow = rows.find((line: string) => line.includes("Tilonius"));
    const unlinkedRow = rows.find((line: string) => line.includes("#QGRJ2222"));
    expect(linkedRow).toBeTruthy();
    expect(unlinkedRow).toBeTruthy();
    expect(description).not.toContain("<@111111111111111111>");
    expect(description).not.toContain("|");

    const linkedParts = getInlineRowSegments(linkedRow as string);
    const unlinkedParts = getInlineRowSegments(unlinkedRow as string);
    expect(linkedParts.statusKind).toBe("linked");
    expect(unlinkedParts.statusKind).toBe("unlinked");
    expect(linkedParts.th).toBe("18");
    expect(unlinkedParts.th).toBe("15");
    expect(linkedParts.weight.trim()).toBe("145k");
    expect(unlinkedParts.weight.trim()).toBe("98k");
    expect(linkedRow).toMatch(/^(?:✅|<a?:yes:\d+>) `/);
    expect(unlinkedRow).toMatch(/^(?:❌|<a?:no:\d+>) `/);
    expect(linkedRow).toMatch(/^(?:✅|<a?:yes:\d+>) `\S/);
    expect(unlinkedRow).toMatch(/^(?:❌|<a?:no:\d+>) `\S/);

    const sortButton = payload.components[0].components[0].toJSON();
    expect(sortButton.label).toBe("Sort: Discord Name");

    const select = payload.components[1].components[0].toJSON();
    expect(select.options).toHaveLength(2);
    expect(
      select.options.some(
        (opt: any) => opt.default && opt.value === "#PQL0289",
      ),
    ).toBe(true);
  });

  it("renders custom yes/no application emojis in /link list rows when available", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted Sin",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    const application = {
      fetch: vi.fn().mockResolvedValue(undefined),
      emojis: {
        fetch: vi.fn().mockResolvedValue(
          new Map([
            [
              "1",
              {
                id: "1",
                name: "yes",
                animated: false,
                toString: () => "<:yes:1>",
              },
            ],
            [
              "2",
              {
                id: "2",
                name: "no",
                animated: false,
                toString: () => "<:no:2>",
              },
            ],
          ]),
        ),
      },
    };
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
      clientApplication: application,
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Tilonius",
            townHallLevel: 18,
            mapPosition: 1,
          },
          {
            tag: "#QGRJ2222",
            name: "Unlinked Guy",
            townHallLevel: 15,
            mapPosition: 2,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("<:yes:1> `");
    expect(description).toContain("<:no:2> `");
    expect(description).not.toContain("✅ `");
    expect(description).not.toContain("❌ `");
  });

  it("falls back to persisted discord username when guild display name is unavailable", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "persisted_username",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Tilonius",
            townHallLevel: 18,
            mapPosition: 1,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("persisted_username");
    expect(description).not.toContain("<@111111111111111111>");
  });

  it("falls back to deterministic placeholder when user cannot be resolved", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: null,
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Tilonius",
            townHallLevel: 18,
            mapPosition: 1,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Unknown User");
    expect(description).not.toContain("<@111111111111111111>");
  });

  it("renders only unlinked bucket when there are no linked users", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#QGRJ2222",
            name: "Player Two",
            townHallLevel: 15,
            mapPosition: 1,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Unlinked users: 1");
    expect(description).not.toContain("Linked Users:");
    expect(description).toMatch(/(?:❌|<a?:no:\d+>) `15/);
    expect(description).toContain("—`");
    expect(description).not.toContain("|");
    expect(description).toContain("#QGRJ2222");
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
      "empty_list: no current clan members for #PQL0289.",
    );
  });

  it("runs /link sync-clashperk and reports inserted rows", async () => {
    vi.spyOn(
      PlayerLinkSyncService.prototype,
      "syncFromPublicGoogleSheet",
    ).mockResolvedValue({
      totalRowCount: 5,
      eligibleRowCount: 4,
      insertedCount: 3,
      updatedCount: 1,
      unchangedCount: 0,
      duplicateTagCount: 0,
      missingRequiredCount: 1,
      invalidTagCount: 0,
      invalidDiscordUserIdCount: 0,
    });

    const interaction = makeInteraction({
      subcommand: "sync-clashperk",
      sheetUrl:
        "https://docs.google.com/spreadsheets/d/test-sheet-id/edit?gid=0#gid=0",
      userId: "111111111111111111",
      isAdmin: true,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "sync_complete: inserted 3 new link(s).",
        "updated existing links: 1",
        "unchanged existing links skipped: 0",
        "eligible rows: 4",
        "duplicate sheet tags skipped: 0",
        "rows missing Tag, ID, or Username skipped: 1",
        "invalid tags skipped: 0",
        "invalid discord ids skipped: 0",
      ].join("\n"),
    );
  });

  it("rejects /link sync-clashperk when permission check fails", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(false);

    const interaction = makeInteraction({
      subcommand: "sync-clashperk",
      sheetUrl:
        "https://docs.google.com/spreadsheets/d/test-sheet-id/edit?gid=0#gid=0",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_allowed: only admins can use /link sync-clashperk.",
    );
  });

  it("limits dropdown to 25 options and includes currently viewed clan", async () => {
    const tags = Array.from({ length: 30 }, (_, idx) => makeValidTag(idx));
    const currentTag = tags[29];
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: currentTag,
        discordUserId: "111111111111111111",
        discordUsername: "current_user",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue(
      tags.map((tag) => ({ clanTag: tag })),
    );
    prismaMock.trackedClan.findMany.mockResolvedValue(
      tags.map((tag, idx) => ({
        tag,
        name: `Clan ${String(idx + 1).padStart(2, "0")}`,
        clanBadge: null,
        mailConfig: { displayOrder: idx === 29 ? 999 : idx + 1 },
      })),
    );

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: currentTag,
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Current Clan",
        members: [
          {
            tag: currentTag,
            name: "Current Player",
            townHallLevel: 16,
            mapPosition: 1,
          },
        ],
      }),
    };

    await Link.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const select = payload.components[1].components[0].toJSON();

    expect(select.options).toHaveLength(25);
    expect(select.options.map((opt: any) => opt.value)).toContain(currentTag);
    expect(
      select.options.some(
        (opt: any) => opt.default && opt.value === currentTag,
      ),
    ).toBe(true);
  });
});

describe("/link list select menu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();

    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted Select User",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: null,
        mailConfig: null,
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
  });

  it("updates same message in place for valid selection", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111", "weight"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: {
        members: {
          cache: new Map([
            ["111111111111111111", { displayName: "Select Display Name" }],
          ]),
        },
      },
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
        members: [
          {
            tag: "#PQL0289",
            name: "Player One",
            townHallLevel: 15,
            mapPosition: 1,
          },
        ],
      }),
    };

    await handleLinkListSelectMenu(interaction as any, cocService as any);

    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0]?.[0] as any;
    expect(Array.isArray(payload.embeds)).toBe(true);
    const firstEmbed = payload.embeds[0].toJSON();
    const description = firstEmbed.description as string;
    expect(description).toContain("Linked Users: 1");
    expect(description).toMatch(/(?:✅|<a?:yes:\d+>) `15/);
    expect(description).toContain("Persisted Select User");
    expect(description).not.toContain("<@111111111111111111>");
    expect(description).not.toContain("Unlinked users:");
    expect(description).not.toContain("|");
    expect(firstEmbed.footer?.text).toBe("Sort: Weight Desc");
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Sort: Weight Desc",
    );
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

describe("/link list sort button", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();

    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "ZedUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        discordUserId: "222222222222222222",
        discordUsername: "AmyUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        discordUserId: "333333333333333333",
        discordUsername: "BobUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: null,
        mailConfig: null,
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 98000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
  });

  it("cycles sort mode in stable order and rerenders rows", async () => {
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Charlie",
            townHallLevel: 16,
            mapPosition: 1,
          },
          {
            tag: "#QGRJ2222",
            name: "Alpha",
            townHallLevel: 15,
            mapPosition: 2,
          },
          {
            tag: "#LCUV0289",
            name: "Bravo",
            townHallLevel: 14,
            mapPosition: 3,
          },
        ],
      }),
    };

    const runSortClick = async (mode: "discord" | "weight" | "player") => {
      const update = vi.fn().mockResolvedValue(undefined);
      const reply = vi.fn().mockResolvedValue(undefined);
      const interaction = {
        customId: buildLinkListSortButtonCustomId(
          "111111111111111111",
          "#PQL0289",
          mode,
        ),
        user: { id: "111111111111111111" },
        guildId: "guild-1",
        guild: { members: { cache: new Map() } },
        client: { users: { cache: new Map() } },
        update,
        reply,
        deferred: false,
        replied: false,
      };

      await handleLinkListSortButton(interaction as any, cocService as any);
      return { update, reply };
    };

    const fromDiscord = await runSortClick("discord");
    const payloadWeight = fromDiscord.update.mock.calls[0]?.[0] as any;
    const embedWeight = payloadWeight.embeds[0].toJSON();
    const descriptionWeight = String(embedWeight.description ?? "");
    expect(embedWeight.footer?.text).toBe("Sort: Weight Desc");
    expect(descriptionWeight.indexOf("AmyUser")).toBeLessThan(
      descriptionWeight.indexOf("ZedUser"),
    );
    expect(descriptionWeight.indexOf("ZedUser")).toBeLessThan(
      descriptionWeight.indexOf("BobUser"),
    );
    expect(payloadWeight.components[0].components[0].toJSON().label).toBe(
      "Sort: Weight Desc",
    );
    expect(fromDiscord.reply).not.toHaveBeenCalled();

    const fromWeight = await runSortClick("weight");
    const payloadPlayer = fromWeight.update.mock.calls[0]?.[0] as any;
    const embedPlayer = payloadPlayer.embeds[0].toJSON();
    const descriptionPlayer = String(embedPlayer.description ?? "");
    expect(embedPlayer.footer?.text).toBe("Sort: Player Name");
    expect(descriptionPlayer.indexOf("Alpha")).toBeLessThan(
      descriptionPlayer.indexOf("Bravo"),
    );
    expect(descriptionPlayer.indexOf("Bravo")).toBeLessThan(
      descriptionPlayer.indexOf("Charlie"),
    );

    const fromPlayer = await runSortClick("player");
    const payloadDiscord = fromPlayer.update.mock.calls[0]?.[0] as any;
    const embedDiscord = payloadDiscord.embeds[0].toJSON();
    expect(embedDiscord.footer?.text).toBe("Sort: Discord Name");
    expect(payloadDiscord.components[0].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
  });

  it("rejects sort-button interaction from non-requesting user", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListSortButton(interaction as any, {} as any);

    expect(reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("/link embed interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(true);
    prismaMock.$queryRaw.mockReset();
    prismaMock.$executeRaw.mockReset();
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
  });

  it("opens player-tag modal from Link Account button", async () => {
    const showModal = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkEmbedAccountButtonCustomId("guild-1"),
      guildId: "guild-1",
      showModal,
      reply,
    };

    await handleLinkEmbedButtonInteraction(interaction as any);

    expect(showModal).toHaveBeenCalledTimes(1);
    const modal = showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.title).toBe("Link Account");
    expect(modal.components).toHaveLength(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("returns context error when link button guild does not match", async () => {
    const showModal = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkEmbedAccountButtonCustomId("guild-1"),
      guildId: "guild-2",
      showModal,
      reply,
    };

    await handleLinkEmbedButtonInteraction(interaction as any);

    expect(reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "invalid_context: this link button can only be used in its original server.",
    });
    expect(showModal).not.toHaveBeenCalled();
  });

  it("handles embed setup modal submit and posts embed with button", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(true);
    const send = vi.fn().mockResolvedValue({
      url: "https://discord.com/channels/1/2/3",
    });
    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      type: ChannelType.GuildText,
      send,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
    };
    const interaction = {
      customId: buildLinkEmbedSetupModalCustomId(
        "111111111111111111",
        "channel-1",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: {
        channels: {
          cache: new Map([["channel-1", channel]]),
          fetch: vi.fn().mockResolvedValue(channel),
        },
        members: {
          me: { id: "bot-1" },
        },
      },
      fields: {
        getTextInputValue: vi.fn((field: string) => {
          if (field === "embed_title") return "Link Your Account";
          if (field === "embed_description") return "Submit your player tag.";
          if (field === "embed_image_url")
            return "https://example.com/image.png";
          if (field === "embed_thumbnail_url") return "";
          return "";
        }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleLinkEmbedModalSubmit(interaction as any);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0];
    expect(payload.embeds[0].toJSON().title).toBe("Link Your Account");
    expect(payload.components[0].toJSON().components[0].label).toBe(
      "Link Account",
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
      }),
    );
  });

  it("rejects invalid image url in embed setup modal", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(true);
    const channel = {
      id: "channel-1",
      guildId: "guild-1",
      type: ChannelType.GuildText,
      send: vi.fn(),
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
    };
    const interaction = {
      customId: buildLinkEmbedSetupModalCustomId(
        "111111111111111111",
        "channel-1",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: {
        channels: {
          cache: new Map([["channel-1", channel]]),
          fetch: vi.fn().mockResolvedValue(channel),
        },
        members: {
          me: { id: "bot-1" },
        },
      },
      fields: {
        getTextInputValue: vi.fn((field: string) => {
          if (field === "embed_title") return "Title";
          if (field === "embed_description") return "Description";
          if (field === "embed_image_url") return "ftp://example.com/image.png";
          if (field === "embed_thumbnail_url") return "";
          return "";
        }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleLinkEmbedModalSubmit(interaction as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "invalid_image_url: provide an absolute http:// or https:// URL.",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("creates link from tag modal when tag is unlinked", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({});

    const interaction = {
      customId: buildLinkEmbedTagModalCustomId("guild-1"),
      guildId: "guild-1",
      user: {
        id: "111111111111111111",
        username: "  test  username  ",
      },
      fields: {
        getTextInputValue: vi.fn().mockReturnValue("pyl0289"),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleLinkEmbedModalSubmit(interaction as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "test username",
      },
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "created: #PYL0289 linked to you.",
    });
  });

  it("returns delete-first conflict for existing normalized tag from modal", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });

    const interaction = {
      customId: buildLinkEmbedTagModalCustomId("guild-1"),
      guildId: "guild-1",
      user: {
        id: "111111111111111111",
        username: "test_username",
      },
      fields: {
        getTextInputValue: vi.fn().mockReturnValue("#pyl0289"),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleLinkEmbedModalSubmit(interaction as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "already_linked: #PYL0289 already has a link. run `/link delete player-tag:#PYL0289` first.",
    });
  });

  it("exposes stable custom-id guards for link embed interactions", () => {
    expect(
      isLinkEmbedAccountButtonCustomId(
        buildLinkEmbedAccountButtonCustomId("guild-1"),
      ),
    ).toBe(true);
    expect(
      isLinkEmbedModalCustomId(buildLinkEmbedSetupModalCustomId("u", "c")),
    ).toBe(true);
    expect(
      isLinkEmbedModalCustomId(buildLinkEmbedTagModalCustomId("guild-1")),
    ).toBe(true);
    expect(isLinkEmbedModalCustomId("other:modal")).toBe(false);
  });
});
