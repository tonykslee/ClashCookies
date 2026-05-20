import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { PlayerLinkSyncService } from "../src/services/PlayerLinkSyncService";
import { InactiveWarService } from "../src/services/InactiveWarService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn().mockResolvedValue([]),
  $executeRaw: vi.fn().mockResolvedValue(0),
  playerLink: {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
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
  fillerAccount: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  playerActivity: {
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
  buildLinkListDescriptionLinesForTest,
  buildLinkListRefreshButtonCustomId,
  buildLinkListSelectCustomId,
  buildLinkListSortButtonCustomId,
  handleReminderLinkButtonInteraction,
  handleReminderLinkCancelButtonInteraction,
  handleReminderLinkConfirmButtonInteraction,
  handleLinkEmbedButtonInteraction,
  handleLinkEmbedModalSubmit,
  handleLinkListRefreshButton,
  handleLinkListSelectMenu,
  handleLinkListSortButton,
  isLinkEmbedAccountButtonCustomId,
  isLinkEmbedModalCustomId,
  isReminderLinkButtonCustomId,
  isReminderLinkCancelButtonCustomId,
  isReminderLinkConfirmButtonCustomId,
  Link,
} from "../src/commands/Link";
import { CommandPermissionService } from "../src/services/CommandPermissionService";
import {
  buildReminderLinkButtonCustomId,
  buildReminderLinkCancelCustomId,
  buildReminderLinkConfirmCustomId,
} from "../src/services/reminders/ReminderLinkActions";

beforeEach(() => {
  emojiResolverService.invalidateCache();
});

type InteractionInput = {
  subcommand: "create" | "delete" | "verify" | "status" | "list" | "embed" | "sync-clashperk";
  sheetUrl?: string | null;
  playerTag?: string | null;
  token?: string | null;
  userOverride?: string | null;
  memberRoleIds?: string[];
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
    member: {
      roles: {
        cache: new Map(
          (input.memberRoleIds ?? []).map((roleId) => [roleId, { id: roleId }]),
        ),
      },
    },
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
        if (name === "clan-tag") return input.clanTag ?? null;
        if (name === "sheet-url") return input.sheetUrl ?? null;
        if (name === "token") return input.token ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name === "user" && input.userOverride) {
          return { id: input.userOverride };
        }
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

function getInlineRowSegments(
  row: string,
  mode: "default" | "player-tags" | "inactivity" = "default",
): {
  statusKind: "linked" | "unlinked" | "";
  statusToken: string;
  townHallIcon: string;
  identity: string;
  left: string;
  tag: string;
  player: string;
  weight: string;
  metric: string;
  marker: string;
} {
  const normalized = String(row ?? "");
  const prefixMatch = normalized.match(/^(\S+)\s/);
  const statusToken = String(prefixMatch?.[1] ?? "");
  const statusKind = statusToken.startsWith("<:yes:") || statusToken === "✅"
    ? "linked"
    : statusToken.startsWith("<:no:") || statusToken === "❌"
      ? "unlinked"
      : "";
  const match =
    normalized.match(
      /^(?<status>\S+)\s+(?<icon>\S+)\s+`(?<left>[^`]*)`(?:\s+`(?<tag>[^`]*)`)?\s+`(?<player>[^`]*)`(?:\s+(?<marker>.*))?$/,
    );
  const playerBlock = String(match?.groups?.player ?? "");
  const [player = "", weight = ""] = playerBlock
    .split(/\s{2,}/)
    .map((part) => part)
    .filter((part) => part.length > 0);
  return {
    statusKind,
    statusToken,
    townHallIcon: String(match?.groups?.icon ?? "").trim(),
    identity:
      mode === "inactivity"
        ? String(match?.groups?.left ?? "").trim()
        : String(match?.groups?.left ?? "").trim(),
    left: String(match?.groups?.left ?? "").trim(),
    tag: String(match?.groups?.tag ?? "").trim(),
    player: player.trim(),
    weight: weight.trim(),
    metric:
      mode === "inactivity"
        ? weight.trim()
        : String(match?.groups?.metric ?? "").trim(),
    marker: String(match?.groups?.marker ?? "").trim(),
  };
}

function getInlineRows(description: string): string[] {
  return String(description ?? "")
    .split("\n")
    .filter((line) => /^\S+\s+\S+\s+`/.test(line));
}

function makeReminderButtonInteraction(input: {
  customId: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
  userId?: string;
  messageContent?: string;
  messageComponents?: Array<{ toJSON: () => unknown }>;
}) {
  const edit = vi.fn().mockResolvedValue(undefined);
  const channel = {
    id: input.channelId ?? "channel-1",
    guildId: input.guildId ?? "guild-1",
    isTextBased: () => true,
    messages: {
      fetch: vi.fn().mockResolvedValue({
        id: input.messageId ?? "message-1",
        components: input.messageComponents ?? [],
        edit,
      }),
    },
  };
  const interaction: any = {
    customId: input.customId,
    guildId: input.guildId ?? "guild-1",
    channelId: input.channelId ?? "channel-1",
    user: { id: input.userId ?? "user-1" },
    message: {
      id: input.messageId ?? "message-1",
      content: input.messageContent ?? "",
      components: input.messageComponents ?? [],
    },
    client: {
      channels: {
        fetch: vi.fn().mockResolvedValue(channel),
      },
    },
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    update: vi.fn(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

describe("/link run", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.delete.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
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
      data: {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        linkSource: "SELF_SERVICE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
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

  it("links multiple tags while trimming whitespace and reporting invalid entries individually", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.playerLink.create.mockResolvedValue({});

    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "  pyl0289 , not-a-tag , ,  #qgrj2222  ",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).toHaveBeenNthCalledWith(1, {
      data: {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        linkSource: "SELF_SERVICE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
    });
    expect(prismaMock.playerLink.create).toHaveBeenNthCalledWith(2, {
      data: {
        playerTag: "#QGRJ2222",
        discordUserId: "111111111111111111",
        linkSource: "SELF_SERVICE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "created: #PYL0289 linked to you.",
        "invalid_tag: not-a-tag is not a valid Clash tag.",
        "invalid_tag: empty entry.",
        "created: #QGRJ2222 linked to you.",
      ].join("\n"),
    );
  });

  it("links multiple tags for an admin override target and reports per-tag conflicts", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        discordUserId: "999999999999999999",
      });
    prismaMock.playerLink.create.mockResolvedValue({});

    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289, #qgrj2222",
      userOverride: "222222222222222222",
      userId: "111111111111111111",
      isAdmin: true,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYL0289",
        discordUserId: "222222222222222222",
        linkSource: "ADMIN_CREATE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "created: #PYL0289 linked to <@222222222222222222>.",
        "already_linked_to_other_user: #QGRJ2222 is linked to <@999999999999999999>. delete-first is required.",
      ].join("\n"),
    );
  });

  it("allows FWA Leaders to create links for another Discord user", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "getAllowedRoleIds",
    ).mockResolvedValue([]);
    vi.spyOn(
      CommandPermissionService.prototype,
      "getFwaLeaderRoleId",
    ).mockResolvedValue("leader-role-1");
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({});
    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289",
      userOverride: "222222222222222222",
      userId: "111111111111111111",
      memberRoleIds: ["leader-role-1"],
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYL0289",
        discordUserId: "222222222222222222",
        linkSource: "ADMIN_CREATE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "created: #PYL0289 linked to <@222222222222222222>.",
    );
  });

  it("verifies an owned link with a player API token", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.updateMany.mockResolvedValue({ count: 1 });
    const verifyPlayerToken = vi.fn().mockResolvedValue({
      tag: "#PYL0289",
      status: "ok",
    });
    const interaction = makeInteraction({
      subcommand: "verify",
      playerTag: "#pyl0289",
      token: "TOKEN-123",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {
      verifyPlayerToken,
    } as any);

    expect(verifyPlayerToken).toHaveBeenCalledWith("#PYL0289", "TOKEN-123");
    expect(prismaMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
      data: {
        verificationStatus: "VERIFIED",
        verificationMethod: "PLAYER_API_TOKEN",
        verifiedAt: expect.any(Date),
        verifiedByDiscordUserId: "111111111111111111",
        lastVerifiedAt: expect.any(Date),
        verificationFailureReason: null,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "verified: #PYL0289 now has verified ownership state.",
    );
  });

  it("rejects verify when the linked tag belongs to another Discord user", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });
    const interaction = makeInteraction({
      subcommand: "verify",
      playerTag: "#pyl0289",
      token: "TOKEN-123",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {
      verifyPlayerToken: vi.fn(),
    } as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "not_owner: #PYL0289 is linked to another Discord user.",
    );
  });

  it("shows trust state for a selected linked player tag", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYL0289",
        discordUserId: "111111111111111111",
        discordUsername: "discord-user",
        playerName: "Player One",
        linkSource: "SELF_SERVICE",
        verificationStatus: "VERIFIED",
        verificationMethod: "PLAYER_API_TOKEN",
        verifiedAt: new Date("2026-04-30T12:34:00.000Z"),
        verifiedByDiscordUserId: "111111111111111111",
        lastVerifiedAt: new Date("2026-04-30T12:34:00.000Z"),
        verificationFailureReason: null,
        importBatchKey: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-30T12:34:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "status",
      playerTag: "#pyl0289",
      userId: "111111111111111111",
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Link trust state:"),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("verification: verified"),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("trusted for autorole: yes"),
    );
  });

  it("rejects create-for-other when non-admin and non-FWA-leader permission is denied", async () => {
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
      "not_allowed: only admins or FWA Leaders can create links for another Discord user.",
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

  it("renders /link list with layered fallback weights and inline padded rows", async () => {
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
        playerName: "Tilonius",
        townHall: null,
        rank: 18,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Unlinked Guy",
        townHall: null,
        rank: 17,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        playerName: "Mystery Zero",
        townHall: null,
        rank: 16,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    prismaMock.fillerAccount.findMany.mockImplementation(async () => [
      {
        playerTag: "#LCUV0289",
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestKnownWeight: 145000,
        latestTownHall: 18,
      },
      {
        playerTag: "#QGRJ2222",
        latestKnownWeight: 0,
        latestTownHall: null,
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        currentWeight: 166000,
        townHall: 15,
      },
      {
        playerTag: "#LCUV0289",
        currentWeight: null,
        townHall: null,
      },
    ]);
    const application = {
      fetch: vi.fn().mockResolvedValue(undefined),
      emojis: {
        fetch: vi.fn().mockResolvedValue(
          new Map([
            [
              "18",
              {
                id: "18",
                name: "th18",
                animated: false,
                toString: () => "<:th18:18>",
              },
            ],
            [
              "15",
              {
                id: "15",
                name: "th15",
                animated: false,
                toString: () => "<:th15:15>",
              },
            ],
            [
              "14",
              {
                id: "14",
                name: "th14",
                animated: false,
                toString: () => "<:th14:14>",
              },
            ],
          ]),
        ),
      },
    };

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
      guildMemberNames: { "111111111111111111": "Sin Display" },
      clientApplication: application,
    });
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstEmbed = payload.embeds[0].toJSON();

    expect(firstEmbed.title).toBe("<:badge:1> Tracked Alpha #PQL0289");
    expect(firstEmbed.footer?.text).toBe("Sort: Discord Name");
    const description = String(firstEmbed.description ?? "");
    expect(description).toContain("Linked Users: 1");
    expect(description).toContain("Unlinked users: 2");
    expect(description).not.toContain("(111111111111111111)");
    expect(firstEmbed.fields ?? []).toHaveLength(0);

    const rows = description
      .split("\n")
      .filter(
        (line: string) =>
          /^\S+\s+\S+\s+`/.test(line) &&
          (line.endsWith("`") || line.endsWith(":person_standing:")),
      );
    expect(rows).toHaveLength(3);

    const linkedRow = rows.find((line: string) => line.includes("Tilonius"));
    const currentFallbackRow = rows.find((line: string) =>
      line.includes("Unlinked Guy"),
    );
    const emptyFallbackRow = rows.find((line: string) =>
      line.includes("Mystery Zero"),
    );
    expect(linkedRow).toBeTruthy();
    expect(currentFallbackRow).toBeTruthy();
    expect(emptyFallbackRow).toBeTruthy();
    expect(description).not.toContain("<@111111111111111111>");
    expect(description).not.toContain("|");

    const linkedParts = getInlineRowSegments(linkedRow as string);
    const currentFallbackParts = getInlineRowSegments(
      currentFallbackRow as string,
    );
    const emptyFallbackParts = getInlineRowSegments(emptyFallbackRow as string);
    expect(linkedParts.statusKind).toBe("linked");
    expect(currentFallbackParts.statusKind).toBe("unlinked");
    expect(emptyFallbackParts.statusKind).toBe("unlinked");
    expect(linkedParts.townHallIcon.length).toBeGreaterThan(0);
    expect(currentFallbackParts.townHallIcon.length).toBeGreaterThan(0);
    expect(emptyFallbackParts.townHallIcon.length).toBeGreaterThan(0);
    expect(linkedParts.townHallIcon).toBe("<:th18:18>");
    expect(currentFallbackParts.townHallIcon).toBe("<:th15:15>");
    expect(emptyFallbackParts.townHallIcon).toBe("❔");
    expect(linkedParts.left).toBe("Persisted Sin");
    expect(currentFallbackParts.left).toBe("—");
    expect(emptyFallbackParts.left).toBe("—");
    expect(linkedParts.tag).toBe("");
    expect(currentFallbackParts.tag).toBe("");
    expect(emptyFallbackParts.tag).toBe("");
    expect(linkedParts.player).toBe("Tilonius");
    expect(currentFallbackParts.player).toBe("Unlinked Guy");
    expect(emptyFallbackParts.player).toBe("Mystery Zero");
    expect(linkedParts.weight.trim()).toBe("145k");
    expect(currentFallbackParts.weight.trim()).toBe("166k");
    expect(emptyFallbackParts.weight.trim()).toBe("—");
    expect(linkedParts.marker).toBe("");
    expect(currentFallbackParts.marker).toBe("");
    expect(emptyFallbackParts.marker).toBe(":person_standing:");
    expect(linkedRow).toMatch(/^.+ \S+ `/);
    expect(currentFallbackRow).toMatch(/^.+ \S+ `/);
    expect(emptyFallbackRow).toMatch(/^.+ \S+ `/);
    expect(linkedRow).not.toContain("`#PYLQ0289`");
    expect(currentFallbackRow).not.toContain("`#QGRJ2222`");
    expect(emptyFallbackRow).not.toContain("`#LCUV0289`");
    expect(currentFallbackRow).not.toContain("``");
    expect(emptyFallbackRow).not.toContain("``");
    const refreshButton = payload.components[0].components[0].toJSON();
    const sortButton = payload.components[1].components[0].toJSON();
    expect(refreshButton.label).toBe("Refresh Data");
    expect(sortButton.label).toBe("Sort: Discord Name");

    const select = payload.components[2].components[0].toJSON();
    expect(select.options).toHaveLength(2);
    expect(
      select.options.some(
        (opt: any) => opt.default && opt.value === "#PQL0289",
      ),
    ).toBe(true);
  });

  it("renders an empty DB-backed roster with refresh and clan dropdown controls", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: "<:badge:1>",
        mailConfig: { displayOrder: 1 },
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      clanBadge: "<:badge:1>",
      name: "Tracked Alpha",
    });

    const cocService = { getClan: vi.fn() };
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });

    await Link.run({} as any, interaction as any, cocService as any);

    expect(cocService.getClan).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(String(embed.description ?? "")).toContain(
      "empty_list: no saved current clan members for #PQL0289. Use Refresh Data or wait for sync.",
    );
    expect(payload.components).toHaveLength(2);
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().placeholder).toBe(
      "Select tracked clan",
    );
  });

  it("refreshes the selected clan from live CoC and rerenders from DB", async () => {
    const oldRows = [
      {
        playerTag: "#PYLQ0289",
        playerName: "Old Player",
        townHall: 15,
        rank: 15,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-20T09:07:00.000Z"),
      },
    ];
    const refreshedRows = [
      {
        playerTag: "#PYLQ0289",
        playerName: "Refreshed Player",
        townHall: 18,
        rank: 18,
        weight: 140000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "New Unlinked",
        townHall: 16,
        rank: 17,
        weight: 132000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ];
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "RefreshUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(oldRows as any);
    const refreshSync = vi
      .spyOn(
        FwaClanMembersSyncService.prototype,
        "refreshCurrentClanMembersForClanTags",
      )
      .mockImplementation(async () => {
        prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
          refreshedRows as any,
        );
        return {
          clanCount: 1,
          rowCount: refreshedRows.length,
          changedRowCount: refreshedRows.length,
          failedClans: [],
        };
      });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Refreshed Player",
            townHallLevel: 18,
            clanRank: 18,
          },
          {
            tag: "#QGRJ2222",
            name: "New Unlinked",
            townHallLevel: 16,
            clanRank: 17,
          },
        ],
      }),
    };
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferUpdate,
      editReply,
      followUp,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListRefreshButton(interaction as any, cocService as any);

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(cocService.getClan).toHaveBeenCalledWith("#PQL0289");
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    const description = String(embed.description ?? "");
    expect(description).toContain("Refreshed Player");
    expect(description).toContain("New Unlinked");
    expect(description).not.toContain("Old Player");
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
    refreshSync.mockRestore();
  });

  it("keeps the DB-backed roster visible when refresh fetch fails", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "RefreshUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Saved Player",
        townHall: 18,
        rank: 18,
        weight: 140000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const cocService = {
      getClan: vi.fn().mockRejectedValue({
        message: "rate limited",
        status: 429,
        code: "429",
      }),
    };
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferUpdate,
      editReply,
      followUp,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListRefreshButton(interaction as any, cocService as any);

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "refresh_failed: CoC API failed for #PQL0289. Showing last saved roster.",
    });
  });

  it("treats sync-service failed clans as refresh failures", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "RefreshUser",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Saved Player",
        townHall: 18,
        rank: 18,
        weight: 140000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const refreshSync = vi
      .spyOn(
        FwaClanMembersSyncService.prototype,
        "refreshCurrentClanMembersForClanTags",
      )
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 0,
        changedRowCount: 0,
        failedClans: ["#PQL0289"],
      });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Saved Player",
            townHallLevel: 18,
            clanRank: 18,
          },
        ],
      }),
    };
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      deferUpdate,
      editReply,
      followUp,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListRefreshButton(interaction as any, cocService as any);

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(refreshSync).toHaveBeenCalledTimes(1);
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "refresh_failed: CoC API failed for #PQL0289. Showing last saved roster.",
    });
    refreshSync.mockRestore();
  });

  it("falls back to question-mark Town Hall icons when application emojis cannot be loaded", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Fallback User",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Fallback One",
        townHall: 18,
        rank: 18,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Fallback Two",
        townHall: 15,
        rank: 17,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("Fallback One");
    expect(description).toContain("Fallback Two");
    expect(description).toContain("❔");
    expect(description).not.toContain("<:th18:18>");
    expect(description).not.toContain("<:th15:15>");
  });

  it("renders TH icons, keeps tags only in Player Tags mode, and places filler markers at the far right", () => {
    const defaultLines = buildLinkListDescriptionLinesForTest({
      linkedRows: [
        {
          townHall: 18,
          leftLabel: "Sin Display",
          playerTag: "#QR9R0LGJ9",
          playerName: "Player One",
          weight: "145k",
          rightMarker: ":person_standing:",
        },
      ],
      unlinkedRows: [
        {
          townHall: 14,
          leftLabel: "",
          playerTag: "#LCUV0289",
          playerName: "Mystery Zero",
          weight: "—",
        },
      ],
      statusIcons: {
        linked: "✅",
        unlinked: "❌",
      },
      townHallEmojiByLevel: new Map([[18, "<:th18:1>"]]),
    });
    const playerTagLines = buildLinkListDescriptionLinesForTest({
      linkedRows: [
      {
        townHall: 18,
        leftLabel: "Sin Display",
        playerTag: "#QR9R0LGJ9",
        playerName: "Player One",
        weight: "145k",
        rightMarker: ":person_standing:",
        rowMode: "player-tags",
      },
      ],
      unlinkedRows: [
        {
          townHall: 14,
          leftLabel: "",
          playerTag: "#LCUV0289",
          playerName: "Mystery Zero",
          weight: "—",
          rowMode: "player-tags",
        },
      ],
      statusIcons: {
        linked: "✅",
        unlinked: "❌",
      },
      townHallEmojiByLevel: new Map([[18, "<:th18:1>"]]),
      sortMode: "player-tags",
    });

    const linkedDefaultRow = defaultLines.find((line) => line.includes("Player One"));
    const unlinkedDefaultRow = defaultLines.find((line) => line.includes("Mystery Zero"));
    const linkedTagRow = playerTagLines.find((line) => line.includes("#QR9R0LGJ9"));
    const unlinkedTagRow = playerTagLines.find((line) => line.includes("#LCUV0289"));

    const linkedDefaultParts = getInlineRowSegments(linkedDefaultRow ?? "");
    const unlinkedDefaultParts = getInlineRowSegments(unlinkedDefaultRow ?? "");
    expect(linkedDefaultParts.townHallIcon).toBe("<:th18:1>");
    expect(linkedDefaultParts.tag).toBe("");
    expect(linkedDefaultParts.player).toBe("Player One");
    expect(linkedDefaultParts.weight.trim()).toBe("145k");
    expect(linkedDefaultRow).toContain(":person_standing:");
    expect(unlinkedDefaultParts.statusKind).toBe("unlinked");
    expect(unlinkedDefaultParts.townHallIcon).toBe("❔");
    expect(unlinkedDefaultParts.tag).toBe("");
    expect(unlinkedDefaultParts.player).toBe("Mystery Zero");
    expect(unlinkedDefaultParts.weight.trim()).toBe("—");
    expect(unlinkedDefaultRow).not.toContain("`#LCUV0289`");

    const linkedTagParts = getInlineRowSegments(linkedTagRow ?? "");
    const unlinkedTagParts = getInlineRowSegments(unlinkedTagRow ?? "");
    expect(linkedTagParts.tag).toBe("#QR9R0LGJ9");
    expect(linkedTagParts.player).toBe("Player One");
    expect(linkedTagParts.weight.trim()).toBe("145k");
    expect(linkedTagParts.townHallIcon).toBe("<:th18:1>");
    expect(linkedTagRow).toContain(":person_standing:");
    expect(unlinkedTagParts.tag).toBe("#LCUV0289");
    expect(unlinkedTagParts.player).toBe("Mystery Zero");
    expect(unlinkedTagParts.weight.trim()).toBe("—");
    expect(unlinkedTagParts.townHallIcon).toBe("❔");
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Persisted Sin",
        townHall: 18,
        rank: 18,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Unlinked Example",
        townHall: 17,
        rank: 17,
        weight: 132000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
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
    const cocService = { getClan: vi.fn() };

    await Link.run({} as any, interaction as any, cocService as any);

    expect(cocService.getClan).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("Persisted Sin");
    expect(description).toContain("Unlinked Example");
    expect(description).not.toContain("`#PYLQ0289`");
    expect(description).not.toContain("`#QGRJ2222`");
    expect(description).not.toContain("``");
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Alpha Player",
        townHall: 18,
        rank: 18,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    await Link.run({} as any, interaction as any, {} as any);

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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Alpha Player",
        townHall: 18,
        rank: 18,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Unknown User");
    expect(description).not.toContain("<@111111111111111111>");
  });

  it("renders only unlinked bucket when there are no linked users", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        playerName: "Player Two",
        townHall: 15,
        rank: 17,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Unlinked users: 1");
    expect(description).not.toContain("Linked Users:");
    expect(description).toContain("`—`");
    expect(description).toContain("Player Two");
    expect(description).toContain("❔");
    expect(description).not.toContain("``");
    expect(description).not.toContain("|");
    expect(description).not.toContain("#QGRJ2222");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(1);
    const row = getInlineRowSegments(rows[0] ?? "");
    expect(row.tag).toBe("");
    expect(row.player).toBe("Player Two");
  });

  it("returns deterministic empty-member response when clan has no members", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag: "#PQL0289" }]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha Clan",
        clanBadge: "<:badge:1>",
        mailConfig: { displayOrder: 1 },
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      clanBadge: "<:badge:1>",
      name: "Tracked Alpha",
    });
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(String(embed.description ?? "")).toContain(
      "empty_list: no saved current clan members for #PQL0289. Use Refresh Data or wait for sync.",
    );
    expect(payload.components).toHaveLength(2);
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: currentTag,
        playerName: "Current Player",
        townHall: 16,
        rank: 1,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
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

    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const select = payload.components[2].components[0].toJSON();

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
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();

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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha Select",
        townHall: 18,
        rank: 18,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
  });

  it("updates same message in place for valid selection", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
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
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    const cocService = { getClan: vi.fn() };
    await handleLinkListSelectMenu(interaction as any, cocService as any);

    expect(cocService.getClan).not.toHaveBeenCalled();

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      editReply.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(update).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(Array.isArray(payload.embeds)).toBe(true);
    const firstEmbed = payload.embeds[0].toJSON();
    const description = firstEmbed.description as string;
    expect(description).toContain("Linked Users: 1");
    expect(description).toContain("Persisted Select User");
    expect(description).not.toContain("`#PQL0289`");
    expect(description).not.toContain("<@111111111111111111>");
    expect(description).not.toContain("Unlinked users:");
    expect(description).not.toContain("|");
    expect(firstEmbed.footer?.text).toBe("Sort: Weight Desc");
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().label).toBe(
      "Sort: Weight Desc",
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects menu interaction from non-requesting user", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111"),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["#PQL0289"],
      deferUpdate,
      editReply,
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
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("/link list sort button", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    emojiResolverService.invalidateCache();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findUnique.mockReset();
    prismaMock.currentWar.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();

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
        playerName: "Charlie",
        townHall: 18,
        rank: 18,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Alpha",
        townHall: 17,
        rank: 17,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        playerName: "Bravo",
        townHall: 16,
        rank: 16,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestKnownWeight: 120000,
      },
      {
        playerTag: "#QGRJ2222",
        latestKnownWeight: 145000,
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#LCUV0289",
        currentWeight: 166000,
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
  });

  it("cycles sort mode in stable order and rerenders rows", async () => {
    const runSortClick = async (
      mode:
        | "discord"
        | "weight"
        | "player-tags"
        | "player"
        | "clan-rank"
        | "inactivity",
    ) => {
      const deferUpdate = vi.fn().mockResolvedValue(undefined);
      const editReply = vi.fn().mockResolvedValue(undefined);
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
        deferUpdate,
        editReply,
        update,
        reply,
        deferred: false,
        replied: false,
      };

      const cocService = { getClan: vi.fn() };
      await handleLinkListSortButton(interaction as any, cocService as any);
      expect(cocService.getClan).not.toHaveBeenCalled();
      return { deferUpdate, editReply, update, reply };
    };

    const fromDiscord = await runSortClick("discord");
    expect(fromDiscord.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromDiscord.editReply).toHaveBeenCalledTimes(1);
    expect(fromDiscord.update).not.toHaveBeenCalled();
    const payloadWeight = fromDiscord.editReply.mock.calls[0]?.[0] as any;
    const embedWeight = payloadWeight.embeds[0].toJSON();
    const descriptionWeight = String(embedWeight.description ?? "");
    expect(embedWeight.footer?.text).toBe("Sort: Weight Desc");
    expect(descriptionWeight.indexOf("BobUser")).toBeLessThan(
      descriptionWeight.indexOf("AmyUser"),
    );
    expect(descriptionWeight.indexOf("AmyUser")).toBeLessThan(
      descriptionWeight.indexOf("ZedUser"),
    );
    expect(payloadWeight.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadWeight.components[1].components[0].toJSON().label).toBe(
      "Sort: Weight Desc",
    );
    expect(fromDiscord.reply).not.toHaveBeenCalled();

    const fromWeight = await runSortClick("weight");
    expect(fromWeight.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromWeight.editReply).toHaveBeenCalledTimes(1);
    expect(fromWeight.update).not.toHaveBeenCalled();
    const payloadPlayerTags = fromWeight.editReply.mock.calls[0]?.[0] as any;
    const embedPlayerTags = payloadPlayerTags.embeds[0].toJSON();
    const descriptionPlayerTags = String(embedPlayerTags.description ?? "");
    expect(embedPlayerTags.footer?.text).toBe("Sort: Player Tags");
    expect(descriptionPlayerTags.indexOf("#LCUV0289")).toBeLessThan(
      descriptionPlayerTags.indexOf("#QGRJ2222"),
    );
    expect(descriptionPlayerTags.indexOf("#QGRJ2222")).toBeLessThan(
      descriptionPlayerTags.indexOf("#PYLQ0289"),
    );
    expect(payloadPlayerTags.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadPlayerTags.components[1].components[0].toJSON().label).toBe(
      "Sort: Player Tags",
    );

    const fromPlayerTags = await runSortClick("player-tags");
    expect(fromPlayerTags.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromPlayerTags.editReply).toHaveBeenCalledTimes(1);
    expect(fromPlayerTags.update).not.toHaveBeenCalled();
    const payloadPlayer = fromPlayerTags.editReply.mock.calls[0]?.[0] as any;
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
    expect(fromPlayer.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromPlayer.editReply).toHaveBeenCalledTimes(1);
    expect(fromPlayer.update).not.toHaveBeenCalled();
    const payloadDiscord = fromPlayer.editReply.mock.calls[0]?.[0] as any;
    const embedDiscord = payloadDiscord.embeds[0].toJSON();
    expect(embedDiscord.footer?.text).toBe("Sort: Clan Rank Desc");
    expect(payloadDiscord.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadDiscord.components[1].components[0].toJSON().label).toBe(
      "Sort: Clan Rank Desc",
    );
    const descriptionClanRank = String(embedDiscord.description ?? "");
    expect(descriptionClanRank.indexOf("ZedUser")).toBeLessThan(
      descriptionClanRank.indexOf("AmyUser"),
    );
    expect(descriptionClanRank.indexOf("AmyUser")).toBeLessThan(
      descriptionClanRank.indexOf("BobUser"),
    );
    const clanRankRows = getInlineRows(descriptionClanRank);
    expect(clanRankRows).toHaveLength(3);
    expect(getInlineRowSegments(clanRankRows[0] ?? "").weight).toBe("#18");
    expect(getInlineRowSegments(clanRankRows[1] ?? "").weight).toBe("#17");
    expect(getInlineRowSegments(clanRankRows[2] ?? "").weight).toBe("#16");

    const nowMs = Date.now();
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        lastSeenAt: new Date(nowMs - 7 * 24 * 60 * 60 * 1000),
      },
      {
        tag: "#QGRJ2222",
        lastSeenAt: new Date(nowMs - 7 * 24 * 60 * 60 * 1000),
      },
      {
        tag: "#LCUV0289",
        lastSeenAt: new Date(nowMs - 9 * 24 * 60 * 60 * 1000),
      },
    ]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [
        { playerTag: "#PYLQ0289", missedWars: 1 },
        { playerTag: "#QGRJ2222", missedWars: 3 },
      ],
      trackedTags: [],
      trackedNameByTag: new Map(),
      trackedBadgeByTag: new Map(),
      warnings: [],
      diagnosticNote: null,
    } as any);

    const fromClanRank = await runSortClick("clan-rank");
    expect(fromClanRank.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromClanRank.editReply).toHaveBeenCalledTimes(1);
    expect(fromClanRank.update).not.toHaveBeenCalled();
    const payloadClanRank = fromClanRank.editReply.mock.calls[0]?.[0] as any;
    const embedClanRank = payloadClanRank.embeds[0].toJSON();
    expect(embedClanRank.footer?.text).toBe("Sort: Inactivity");
    expect(payloadClanRank.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadClanRank.components[1].components[0].toJSON().label).toBe(
      "Sort: Inactivity",
    );
    const descriptionInactivity = String(embedClanRank.description ?? "");
    expect(descriptionInactivity.indexOf("BobUser")).toBeLessThan(
      descriptionInactivity.indexOf("AmyUser"),
    );
    expect(descriptionInactivity.indexOf("AmyUser")).toBeLessThan(
      descriptionInactivity.indexOf("ZedUser"),
    );
    const inactivityRows = getInlineRows(descriptionInactivity);
    expect(inactivityRows).toHaveLength(3);
    expect(getInlineRowSegments(inactivityRows[0] ?? "", "inactivity").metric).toBe(
      "9d —",
    );
    expect(getInlineRowSegments(inactivityRows[1] ?? "", "inactivity").metric).toBe(
      "7d 3w",
    );
    expect(getInlineRowSegments(inactivityRows[2] ?? "", "inactivity").metric).toBe(
      "7d 1w",
    );

    const fromInactivity = await runSortClick("inactivity");
    expect(fromInactivity.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromInactivity.editReply).toHaveBeenCalledTimes(1);
    expect(fromInactivity.update).not.toHaveBeenCalled();
    const payloadInactivity = fromInactivity.editReply.mock.calls[0]?.[0] as any;
    const embedInactivity = payloadInactivity.embeds[0].toJSON();
    expect(embedInactivity.footer?.text).toBe("Sort: Discord Name");
    expect(payloadInactivity.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadInactivity.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
  });

  it("keeps deterministic tie ordering in Player Tags mode", async () => {
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Charlie",
        townHall: 16,
        rank: 18,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Alpha",
        townHall: 15,
        rank: 17,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        playerName: "Bravo",
        townHall: 14,
        rank: 16,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListSortButton(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    const description = String(embed.description ?? "");
    expect(embed.footer?.text).toBe("Sort: Player Tags");
    expect(description.indexOf("#LCUV0289")).toBeLessThan(
      description.indexOf("#PYLQ0289"),
    );
    expect(description.indexOf("#PYLQ0289")).toBeLessThan(
      description.indexOf("#QGRJ2222"),
    );
  });

  it("rejects sort-button interaction from non-requesting user", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
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
      deferUpdate,
      editReply,
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
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
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
        linkSource: "EMBED_SELF_SERVICE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
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

describe("/reminder link interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.create.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
  });

  it("opens an ephemeral confirmation for the clicked reminder player", async () => {
    const interaction = makeReminderButtonInteraction({
      customId: buildReminderLinkButtonCustomId({
        guildId: "guild-1",
        reminderId: "rem-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "111111111111111111",
      messageContent: "#12 - ❌ RASEL RAJ `#PYLQ0289` - 1 / 2\nIs this you?",
    });

    await handleReminderLinkButtonInteraction(interaction as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Link RASEL RAJ #PYLQ0289 to your Discord account?",
      components: expect.any(Array),
    });
    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    expect(payload.components[0].toJSON().components.map((button: any) => button.label)).toEqual([
      "Confirm",
      "Cancel",
    ]);
  });

  it("confirms a reminder link and disables the original reminder button", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.create.mockResolvedValue({});
    const messageEdit = vi.fn().mockResolvedValue(undefined);
    const originalMessage = {
      id: "message-1",
      components: [
        {
          toJSON: () => ({
            type: 1,
            components: [
              {
                type: 2,
                style: 1,
                label: "Link player",
                custom_id: buildReminderLinkButtonCustomId({
                  guildId: "guild-1",
                  reminderId: "rem-1",
                  playerTag: "#PYLQ0289",
                }),
                disabled: false,
              },
            ],
          }),
        },
      ],
      edit: messageEdit,
    };
    const interaction = makeReminderButtonInteraction({
      customId: buildReminderLinkConfirmCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "111111111111111111",
    });
    interaction.client.channels.fetch.mockResolvedValue({
      id: "channel-1",
      guildId: "guild-1",
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(originalMessage),
      },
    });

    await handleReminderLinkConfirmButtonInteraction(interaction as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledWith({
      data: {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        linkSource: "SELF_SERVICE",
        verificationStatus: "UNVERIFIED",
        verificationMethod: null,
        verifiedAt: null,
        verifiedByDiscordUserId: null,
        lastVerifiedAt: null,
        verificationFailureReason: null,
        importBatchKey: null,
      },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "created: #PYLQ0289 linked to you.",
    );
    expect(messageEdit).toHaveBeenCalledWith({
      components: [
        {
          type: 1,
          components: [
            expect.objectContaining({
              custom_id: buildReminderLinkButtonCustomId({
                guildId: "guild-1",
                reminderId: "rem-1",
                playerTag: "#PYLQ0289",
              }),
              disabled: true,
            }),
          ],
        },
      ],
    });
  });

  it("cancels a reminder link confirmation without changing state", async () => {
    const interaction = makeReminderButtonInteraction({
      customId: buildReminderLinkCancelCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "111111111111111111",
    });

    await handleReminderLinkCancelButtonInteraction(interaction as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: "Canceled.",
      components: [],
    });
  });

  it("rejects stale reminder confirmations when the channel context no longer matches", async () => {
    const interaction = makeReminderButtonInteraction({
      customId: buildReminderLinkConfirmCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-2",
      guildId: "guild-1",
      userId: "111111111111111111",
    });

    await handleReminderLinkConfirmButtonInteraction(interaction as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "invalid_context: this reminder link confirmation can only be used in its original channel.",
    });
  });

  it("rejects stale reminder confirmations when the player is already linked", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });
    const interaction = makeReminderButtonInteraction({
      customId: buildReminderLinkConfirmCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "111111111111111111",
    });

    await handleReminderLinkConfirmButtonInteraction(interaction as any);

    expect(prismaMock.playerLink.create).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "already_linked_to_other_user: #PYLQ0289 is linked to <@222222222222222222>. delete-first is required.",
    );
  });

  it("allows only one user to claim the same unlinked reminder player", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ discordUserId: "111111111111111111" });
    prismaMock.playerLink.create.mockResolvedValue({});
    const first = makeReminderButtonInteraction({
      customId: buildReminderLinkConfirmCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "111111111111111111",
    });
    const second = makeReminderButtonInteraction({
      customId: buildReminderLinkConfirmCustomId({
        channelId: "channel-1",
        messageId: "message-1",
        playerTag: "#PYLQ0289",
      }),
      messageId: "message-1",
      channelId: "channel-1",
      guildId: "guild-1",
      userId: "222222222222222222",
    });

    await handleReminderLinkConfirmButtonInteraction(first as any);
    await handleReminderLinkConfirmButtonInteraction(second as any);

    expect(prismaMock.playerLink.create).toHaveBeenCalledTimes(1);
    expect(first.editReply).toHaveBeenCalledWith(
      "created: #PYLQ0289 linked to you.",
    );
    expect(second.editReply).toHaveBeenCalledWith(
      "already_linked_to_other_user: #PYLQ0289 is linked to <@111111111111111111>. delete-first is required.",
    );
  });

  it("treats reminder link custom ids as stable guards", () => {
    expect(
      isReminderLinkButtonCustomId(
        buildReminderLinkButtonCustomId({
          guildId: "guild-1",
          reminderId: "rem-1",
          playerTag: "#PYLQ0289",
        }),
      ),
    ).toBe(true);
    expect(
      isReminderLinkConfirmButtonCustomId(
        buildReminderLinkConfirmCustomId({
          channelId: "channel-1",
          messageId: "message-1",
          playerTag: "#PYLQ0289",
        }),
      ),
    ).toBe(true);
    expect(
      isReminderLinkCancelButtonCustomId(
        buildReminderLinkCancelCustomId({
          channelId: "channel-1",
          messageId: "message-1",
          playerTag: "#PYLQ0289",
        }),
      ),
    ).toBe(true);
  });
});

