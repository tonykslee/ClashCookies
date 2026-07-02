import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { PlayerLinkSyncService } from "../src/services/PlayerLinkSyncService";
import { InactiveWarService } from "../src/services/InactiveWarService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";
import { WarPlanViolationHistoryService } from "../src/services/WarPlanViolationHistoryService";

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
  warPlanComplianceEvaluation: {
    findMany: vi.fn(),
  },
  trackedClanRep: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
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
  buildLinkListColumnsSelectCustomIdForTest,
  getLinkListColumnLabelForTest,
  getLinkListDefaultColumnsForSortModeForTest,
  buildLinkListRefreshButtonCustomId,
  buildLinkListSelectCustomId,
  buildLinkListSortButtonCustomId,
  isLinkListColumnsSelectCustomId,
  getLinkListSelectableColumnsForTest,
  parseLinkListColumnsSelectCustomIdForTest,
  handleReminderLinkButtonInteraction,
  handleReminderLinkCancelButtonInteraction,
  handleReminderLinkConfirmButtonInteraction,
  handleLinkEmbedButtonInteraction,
  handleLinkEmbedModalSubmit,
  handleLinkListColumnsSelectMenu,
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
import { buildDescriptionEmbeds } from "../src/commands/link/LinkListRender";
import {
  formatLinkListViolationCountLabel,
  getLinkListSortModeLabel,
  getNextLinkListSortMode,
  normalizeLinkListSortMode,
} from "../src/commands/link/LinkListRender";
import { CommandPermissionService } from "../src/services/CommandPermissionService";
import {
  buildReminderLinkButtonCustomId,
  buildReminderLinkCancelCustomId,
  buildReminderLinkConfirmCustomId,
} from "../src/services/reminders/ReminderLinkActions";

beforeEach(() => {
  emojiResolverService.invalidateCache();
});

afterEach(() => {
  vi.useRealTimers();
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
  guildMembers?: Record<string, any>;
  cachedUserNames?: Record<string, string>;
  clientApplication?: any;
};

function makeInteraction(input: InteractionInput) {
  const guildMemberCache = new Map([
    ...Object.entries(input.guildMemberNames ?? {}).map(([id, displayName]) => [
      id,
      { displayName },
    ]),
    ...Object.entries(input.guildMembers ?? {}),
  ]);
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

function makeLongValidTag(index: number): string {
  const alphabet = "PYLQGRJCUV0289";
  let suffix = "";
  for (let offset = 0; offset < 15; offset += 1) {
    suffix += alphabet[(index + offset) % alphabet.length];
  }
  return `#${suffix}`;
}

function makeLinkListClanMembers(input: {
  clanTag: string;
  count: number;
  playerNamePrefix?: string;
  playerTagStartIndex?: number;
  townHall?: number;
  role?: string | ((index: number) => string);
}) {
  return Array.from({ length: input.count }, (_, index) => {
    const playerTag = makeValidTag((input.playerTagStartIndex ?? 1) + index);
    return {
      playerTag,
      playerName: `${input.playerNamePrefix ?? "Player"} ${index + 1}`,
      townHall: input.townHall ?? 18,
      role:
        typeof input.role === "function"
          ? input.role(index)
          : input.role ?? "member",
      rank: index + 1,
      weight: 145000,
      sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
    };
  });
}

function getInlineRowSegments(row: string): {
  status: string;
  townHall: string;
  playerName: string;
  value: string;
  marker: string;
  cells: string[];
} {
  const normalized = String(row ?? "").trimEnd();
  const statusMatch = normalized.match(
    /^(?<status>[\u2705\u274C]|<a?:[A-Za-z0-9_~]+:\d+>|[\p{Emoji_Presentation}\p{Extended_Pictographic}])/u,
  );
  const cellMatches = [...normalized.matchAll(/`(?<cell>[^`]*)`/gu)];
  const cells = cellMatches.map((match) => String(match.groups?.cell ?? ""));
  const markerMatch = normalized.match(/(?<marker>\u{1F9CD})$/u);
  if (!statusMatch?.groups || cells.length < 2) {
    return { status: "", townHall: "", playerName: "", value: "", marker: "", cells: [] };
  }
  const [townHall = "", playerName = "", ...rest] = cells;
  const value = rest.length > 0 ? rest[rest.length - 1] : "";
  return {
    status: String(statusMatch.groups.status ?? ""),
    townHall,
    playerName,
    value: String(value).trim(),
    marker: String(markerMatch?.groups?.marker ?? "").trim(),
    cells,
  };
}

const LINK_LIST_ROW_LINE_RE =
  /^(?:[\u2705\u274C]|<a?:[A-Za-z0-9_~]+:\d+>|[\p{Emoji_Presentation}\p{Extended_Pictographic}])(?:\s+`[^`]+`)+(?:\s+\u{1F9CD})?$/u;

function getInlineRows(description: string): string[] {
  return String(description ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => LINK_LIST_ROW_LINE_RE.test(line));
}

function makePublicLinkListMessage() {
  return {
    flags: {
      has: vi.fn().mockReturnValue(false),
    },
  };
}

function makeMissingFlagsLinkListMessage() {
  return {};
}

function getComponentCustomId(component: any): string {
  return String(
    component?.custom_id ??
      component?.customId ??
      component?.data?.custom_id ??
      component?.data?.customId ??
      "",
  );
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
    prismaMock.warPlanComplianceEvaluation.findMany.mockReset();
    prismaMock.trackedClanRep.findMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.warPlanComplianceEvaluation.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
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

  it("links space-separated tags while trimming whitespace and reporting invalid entries individually", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.playerLink.create.mockResolvedValue({});

    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "  pyl0289 not-a-tag   #qgrj2222  ",
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
        "created: #QGRJ2222 linked to you.",
        "invalid_tag: not-a-tag is not a valid Clash tag.",
      ].join("\n"),
    );
  });

  it("links mixed-separated tags once per unique tag and keeps the first-seen order", async () => {
    prismaMock.playerLink.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.playerLink.create.mockResolvedValue({});

    const interaction = makeInteraction({
      subcommand: "create",
      playerTag: "#pyl0289, not-a-tag #qgrj2222 #pyl0289",
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
    expect(prismaMock.playerLink.create).toHaveBeenCalledTimes(2);
    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "created: #PYL0289 linked to you.",
        "created: #QGRJ2222 linked to you.",
        "invalid_tag: not-a-tag is not a valid Clash tag.",
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
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(false);
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

  it("deletes multiple links and reports invalid, not linked, and unauthorized buckets", async () => {
    vi.spyOn(
      CommandPermissionService.prototype,
      "canUseAnyTarget",
    ).mockResolvedValue(false);
    prismaMock.playerLink.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.playerTag === "#PYL0289") {
        return { discordUserId: "111111111111111111" };
      }
      if (where.playerTag === "#QGRJ2222") {
        return { discordUserId: "222222222222222222" };
      }
      if (where.playerTag === "#LCUV0289") {
        return null;
      }
      return null;
    });
    prismaMock.playerLink.delete.mockResolvedValue({});
    const interaction = makeInteraction({
      subcommand: "delete",
      playerTag: "#pyl0289 qgrj2222 badtag, lcuv0289 #pyl0289",
      userId: "111111111111111111",
      isAdmin: false,
    });

    await Link.run({} as any, interaction as any, {} as any);

    expect(prismaMock.playerLink.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.playerLink.delete).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      [
        "deleted: #PYL0289.",
        "not linked: #LCUV0289.",
        "invalid: badtag.",
        "unauthorized: #QGRJ2222.",
      ].join("\n"),
    );
  });

  it("renders /link list with layered fallback weights and inline padded rows", async () => {
    const violationSpy = vi
      .spyOn(
        WarPlanViolationHistoryService.prototype,
        "getClanPlayerViolationCounts",
      )
      .mockResolvedValue({
        period: "30d",
        cutoff: new Date("2026-06-01T00:00:00.000Z"),
        clanTag: "#PQL0289",
        hasCompletedEvaluations: false,
        evaluatedWarCount: 0,
        violationCountByPlayerTag: new Map(),
      } as any);
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

    expect(description).not.toContain("<@111111111111111111>");
    expect(description).not.toContain("|");
    expect(violationSpy).not.toHaveBeenCalled();
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(3);
    const linkedRow = getInlineRowSegments(rows[0] ?? "");
    const currentFallbackRow = getInlineRowSegments(rows[1] ?? "");
    const currentWeightFallbackRow = getInlineRowSegments(rows[2] ?? "");
    expect(linkedRow).toMatchObject({
      status: "✅",
      townHall: "18",
      value: "Sin Display",
    });
    expect(linkedRow.playerName.trim()).toBe("Tilonius");
    expect(currentFallbackRow).toMatchObject({
      status: "❌",
      townHall: " ?",
      value: "—",
    });
    expect(currentFallbackRow.townHall.trim()).toBe("?");
    expect(currentFallbackRow.playerName.trim()).toBe("Mystery Zero");
    expect(currentWeightFallbackRow).toMatchObject({
      status: "❌",
      townHall: "15",
      value: "—",
    });
    expect(currentWeightFallbackRow.playerName.trim()).toBe("Unlinked Guy");
    expect(rows[0] ?? "").not.toContain("`#PYLQ0289`");
    expect(rows[1] ?? "").not.toContain("`#QGRJ2222`");
    expect(rows[1] ?? "").not.toContain("``");
    const refreshButton = payload.components[0].components[0].toJSON();
    const sortButton = payload.components[1].components[0].toJSON();
    const columnsSelect = payload.components[2].components[0].toJSON();
    expect(refreshButton.label).toBe("Refresh Data");
    expect(sortButton.label).toBe("Sort: Discord Name");
    expect(columnsSelect.placeholder).toBe("Columns");

    const select = payload.components[3].components[0].toJSON();
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
    expect(payload.components).toHaveLength(3);
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().placeholder).toBe(
      "Columns",
    );
    expect(payload.components[2].components[0].toJSON().placeholder).toBe(
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
        playerName: "Refreshed",
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
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_refresh:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
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
            name: "Refreshed",
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
    expect(description).toContain("RefreshUser");
    expect(description).toContain("Unlinked users: 1");
    expect(description).not.toContain("Old Player");
    expect(description).toContain("Refreshed");
    expect(description).toContain("New Unlinked");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(2);
    expect(getInlineRowSegments(rows[0] ?? "")).toMatchObject({
      status: "<:badge_refresh:1>",
      townHall: "18",
      value: "RefreshUser",
    });
    expect(getInlineRowSegments(rows[0] ?? "").playerName.trim()).toBe("Refreshed");
    expect(getInlineRowSegments(rows[1] ?? "")).toMatchObject({
      status: "❌",
      townHall: "16",
      value: "—",
    });
    expect(getInlineRowSegments(rows[1] ?? "").playerName.trim()).toBe(
      "New Unlinked",
    );
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledTimes(1);
    refreshSync.mockRestore();
  });

  it("allows a different user to refresh a public link list and logs both the command owner and actor", async () => {
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
        playerName: "Refreshed",
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
    prismaMock.trackedClanRep.findMany.mockResolvedValue([  
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_refresh_public:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
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
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Refreshed",
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
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      message: makePublicLinkListMessage(),
      deferUpdate,
      editReply,
      followUp,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListRefreshButton(interaction as any, cocService as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
    );
    expect(infoSpy.mock.calls.some((call) =>
      String(call[0] ?? "").includes("event=refresh_success") &&
      String(call[0] ?? "").includes("command_user_id=111111111111111111") &&
      String(call[0] ?? "").includes("interaction_user_id=222222222222222222"),
    )).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    refreshSync.mockRestore();
  });

  it("preserves selected columns when refreshing the selected clan", async () => {
    const refreshedRows = [
      {
        playerTag: "#PYLQ0289",
        playerName: "Refreshed",
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
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(refreshedRows as any);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_columns:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    const refreshSync = vi
      .spyOn(
        FwaClanMembersSyncService.prototype,
        "refreshCurrentClanMembersForClanTags",
      )
      .mockResolvedValue({
        clanCount: 1,
        rowCount: refreshedRows.length,
        changedRowCount: refreshedRows.length,
        failedClans: [],
      } as any);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        members: [
          {
            tag: "#PYLQ0289",
            name: "Refreshed",
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
        ["player-name", "weight"],
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

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    const description = String(embed.description ?? "");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^<:badge_columns:1>\s+`\s*Refreshed`\s+`140k`$/u);
    expect(rows[1]).toMatch(/^\u274C\s+`\s*New Unlinked`\s+`132k`$/u);
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledTimes(1);
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
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

  it("renders compact Town Hall labels when application emojis cannot be loaded", async () => {
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
    expect(description).toContain("Fallback User");
    expect(description).toContain("18");
    expect(description).toContain("15");
    expect(description).not.toContain("<:th18:18>");
    expect(description).not.toContain("<:th15:15>");
  });

  it("renders compact values, keeps tags only in Player Tags mode, and places filler markers at the far right", () => {
    const linkedRepRow = {
      townHallLabel: "18",
      playerName: "Persisted Sin",
      discordDisplayName: "Persisted Sin",
      discordUsername: "Persisted Sin",
      weightLabel: "166k",
      inactivityLabel: "—",
      clanRoleLabel: "lead",
      playerTag: "#QR9R0LGJ9",
      violationsLabel: "0",
      linkedStatusMarkerOverride: "<:badge:1>",
      rightMarker: "ðŸ§",
      isLinked: true,
    };
    const linkedNonRepRow = {
      townHallLabel: "17",
      playerName: "Linked Two",
      discordDisplayName: "Linked Two",
      discordUsername: "Linked Two",
      weightLabel: "145k",
      inactivityLabel: "—",
      clanRoleLabel: "co",
      playerTag: "#LCUV0289",
      violationsLabel: "0",
      rightMarker: null,
      isLinked: true,
    };
    const unlinkedRow = {
      townHallLabel: "14",
      playerName: "Unlinked Player",
      discordDisplayName: "—",
      discordUsername: "—",
      weightLabel: "—",
      inactivityLabel: "—",
      clanRoleLabel: "—",
      playerTag: "#PQL0289",
      violationsLabel: "—",
      linkedStatusMarkerOverride: "<:badge:2>",
      isLinked: false,
    };
    const defaultRows = buildLinkListDescriptionLinesForTest({
      linkedRows: [linkedRepRow, linkedNonRepRow],
      unlinkedRows: [unlinkedRow],
      statusIcons: {
        linked: "✅",
        unlinked: "❌",
      },
    });
    const playerTagRows = buildLinkListDescriptionLinesForTest({
      linkedRows: [linkedRepRow, linkedNonRepRow],
      unlinkedRows: [unlinkedRow],
      statusIcons: {
        linked: "✅",
        unlinked: "❌",
      },
      sortMode: "player-tags",
    });

    const defaultRowsOnly = getInlineRows(defaultRows.join("\n"));
    const defaultRowsText = defaultRows.join("\n");
    const playerTagRowsText = playerTagRows.join("\n");
    expect(getInlineRows(defaultRowsText).length).toBeGreaterThanOrEqual(2);
    expect(getInlineRows(playerTagRowsText).length).toBeGreaterThanOrEqual(2);
    expect(defaultRowsText).toContain("<:badge:1>");
    expect(defaultRowsText).toContain("Persisted Sin");
    expect(defaultRowsText).toContain("Linked Two");
    expect(defaultRowsText).toContain("Unlinked Player");
    expect(defaultRowsText).toContain("❌");
    expect(playerTagRowsText).toContain("<:badge:1>");
    expect(playerTagRowsText).toContain("Persisted Sin");
    expect(playerTagRowsText).toContain("Linked Two");
    expect(playerTagRowsText).toContain("Unlinked Player");
    expect(playerTagRowsText).toContain("❌");
    expect(getLinkListDefaultColumnsForSortModeForTest("discord")).toEqual([
      "townhall",
      "player-name",
      "discord-display-name",
    ]);
    expect(getLinkListDefaultColumnsForSortModeForTest("player-tags")).toEqual([
      "townhall",
      "player-name",
      "player-tag",
    ]);
    expect(getLinkListDefaultColumnsForSortModeForTest("violations")).toEqual([
      "townhall",
      "player-name",
      "violations",
    ]);
    expect(getLinkListSelectableColumnsForTest()).toContain("player-tag");
    expect(getLinkListSelectableColumnsForTest()).toContain("violations");
    expect(getLinkListColumnLabelForTest("player-tag")).toBe("Player Tag");
    expect(getLinkListColumnLabelForTest("violations")).toBe("Violations (30d)");
  });

  it("recognizes rows with up to five inline-code cells for chunking", () => {
    const rows = getInlineRows(
      [
        "<:badge:1> `18` `Tilonius` `Persisted Sin` `166k` `lead` \u{1F9CD}",
        "\u274C `15` `Mystery Zero` `\u2014` `\u2014` \u{1F9CD}",
        "<a:badge:2> `18` `Tilonius`",
        "\u2705",
      ].join("\n"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(
      "<:badge:1> `18` `Tilonius` `Persisted Sin` `166k` `lead` \u{1F9CD}",
    );
    expect(rows[1]).toBe("\u274C `15` `Mystery Zero` `\u2014` `\u2014` \u{1F9CD}");
    expect(rows[2]).toBe("<a:badge:2> `18` `Tilonius`");
    expect(rows[0]).toMatch(LINK_LIST_ROW_LINE_RE);
    expect(rows[1]).toMatch(LINK_LIST_ROW_LINE_RE);
    expect(rows[2]).toMatch(LINK_LIST_ROW_LINE_RE);
    expect(getInlineRows("\u2705")).toHaveLength(0);
  });

  it("counts badge-led rows while chunking and trimming", () => {
    const lines = [
      "Linked Users: 1",
      "<:badge_trim:1> `18` `Badge Row`",
      ...Array.from({ length: 120 }, (_, index) =>
        `✅ \`18\` \`Long Row ${String(index + 1).padStart(3, "0")}\` \`Linked ${index + 1}\``,
      ),
    ];

    const result = buildDescriptionEmbeds("Tracked Alpha #PQL0289", lines, "weight");
    const description = result.embeds
      .map((embed: { toJSON: () => any }) => String(embed.toJSON().description ?? ""))
      .join("\n");
    const renderedRows = getInlineRows(description);

    expect(result.trimmed).toBe(true);
    expect(result.hiddenRows).toBeGreaterThan(0);
    expect(result.renderedRows + result.hiddenRows).toBe(121);
    expect(description).toContain("<:badge_trim:1>");
    expect(
      renderedRows.some((row) => getInlineRowSegments(row).status === "<:badge_trim:1>"),
    ).toBe(true);
  });

  it("builds and parses compact columns select custom ids", () => {
    const customId = buildLinkListColumnsSelectCustomIdForTest(
      "111111111111111111",
      "#PQL0289",
      "weight",
      ["townhall", "player-name", "weight", "clan-role", "violations"],
    );
    expect(isLinkListColumnsSelectCustomId(customId)).toBe(true);
    const parsed = parseLinkListColumnsSelectCustomIdForTest(customId);
    expect(parsed).toMatchObject({
      userId: "111111111111111111",
      clanTag: "#PQL0289",
      sortMode: "weight",
      columns: [
        "townhall",
        "player-name",
        "weight",
        "clan-role",
        "violations",
      ],
    });
    expect(customId).toContain("v30");
    expect(customId.length).toBeLessThan(100);
  });

  it("normalizes the violations sort mode and keeps the cycle stable", () => {
    expect(normalizeLinkListSortMode("violations")).toBe("violations");
    expect(getLinkListSortModeLabel("violations")).toBe("Violations (30d)");
    expect(getNextLinkListSortMode("inactivity")).toBe("violations");
    expect(getNextLinkListSortMode("violations")).toBe("discord");
  });

  it("renders violation counts with known zeros and unavailable values", () => {
    expect(formatLinkListViolationCountLabel(4)).toBe("4");
    expect(formatLinkListViolationCountLabel(0)).toBe("0");
    expect(formatLinkListViolationCountLabel(null)).toBe("—");
  });

  it("normalizes duplicate and unknown columns while keeping at most five", () => {
    const parsed = parseLinkListColumnsSelectCustomIdForTest(
      "link-list-columns:111111111111111111:#PQL0289:discord:th.pn.pn.zz.wt.ia.cr.v30.pt",
    );
    expect(parsed).toMatchObject({
      userId: "111111111111111111",
      clanTag: "#PQL0289",
      sortMode: "discord",
      columns: [
        "townhall",
        "player-name",
        "weight",
        "inactivity",
        "clan-role",
      ],
    });
  });

  it("renders selected columns in the requested order", () => {
    const lines = buildLinkListDescriptionLinesForTest({
      linkedRows: [
        {
          townHallLabel: "18",
          playerName: "Tilonius",
          displayValue: null,
          discordDisplayName: "teewizz",
          discordUsername: "teewizz",
          weightLabel: "166k",
          inactivityLabel: "\u2014 2WAR",
          clanRoleLabel: "lead",
          playerTag: "#QR9R0LGJ9",
          violationsLabel: "2",
          rightMarker: "\u{1F9CD}",
          isLinked: true,
        },
      ],
      unlinkedRows: [],
      statusIcons: {
        linked: "\u2705",
        unlinked: "\u274C",
      },
      sortMode: "weight",
      columns: ["townhall", "player-name", "weight", "clan-role", "player-tag"],
    });
    expect(lines).toContain("Linked Users: 1");
    const row = lines.find((line) => line.startsWith("\u2705")) ?? "";
    expect(row).toMatch(
      /^\u2705\s+`18`\s+`Tilonius`\s+`166k`\s+`lead`\s+`#QR9R0LGJ9`\s+\u{1F9CD}$/u,
    );
  });

  it("renders unicode yes/no markers in /link list rows", async () => {
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
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_a:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
      {
        clanTag: "#PQL0289",
        playerTag: "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_b:2>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 2 },
        },
      },
      {
        clanTag: "#PQL0289",
        playerTag: "#QGRJ2222",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_c:3>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });
    const cocService = { getClan: vi.fn() };

    await Link.run({} as any, interaction as any, {} as any);

    expect(cocService.getClan).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(description).toContain("Linked Users: 1");
    expect(description).toContain("Unlinked users: 1");
    expect(description).toContain("Persisted Sin");
    expect(description).toContain("❌");
    expect(description).not.toContain("✅");
    expect(description).not.toContain("`#PYLQ0289`");
    expect(description).not.toContain("`#QGRJ2222`");
    expect(description).not.toContain("``");
    expect(description).toContain("<:badge_a:1>");
    expect(description).not.toContain("<:badge_b:2>");
    expect(description).not.toContain("<:badge_c:3>");
    expect(prismaMock.trackedClanRep.findMany).toHaveBeenCalledTimes(1);
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(2);
    expect(getInlineRowSegments(rows[0] ?? "")).toMatchObject({
      status: "<:badge_a:1>",
      townHall: "18",
      value: "Persisted Sin",
    });
    expect(getInlineRowSegments(rows[0] ?? "").playerName.trim()).toBe("Persisted Sin");
    expect(rows[0]).toContain("<:badge_a:1>");
    expect(rows[0]).not.toContain("✅");
    expect(getInlineRowSegments(rows[1] ?? "")).toMatchObject({
      status: "❌",
      townHall: "17",
      value: "—",
    });
    expect(getInlineRowSegments(rows[1] ?? "").playerName.trim()).toBe(
      "Unlinked Exa...",
    );
    expect(rows[1]).toContain("❌");
    expect(rows[1]).not.toContain("<:badge_c:3>");
    expect(description).not.toContain("``");
  });
  it("escapes backticks in /link list inline-code cells", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Discord ` Nick",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "WIZEX`",
        townHall: 18,
        rank: 18,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Plain Member",
        townHall: 17,
        rank: 17,
        weight: 132000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
    });

    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    const rows = getInlineRows(description);

    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row).not.toMatch(/^[\u2705\u274C]\s+`?\d+`?\s*$/u);
      const segments = getInlineRowSegments(row);
      expect(segments.playerName).not.toContain("`");
      expect(segments.value).not.toContain("`");
    });
    expect(description).toContain("WIZEXʼ");
    expect(description).toContain("Discord ʼ Nick");
    expect(description).toContain("Plain Member");
    expect(description).not.toContain("`WIZEX`");
    expect(description).not.toContain("`Discord ` Nick`");
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
    expect(description).toContain("persisted");
    expect(description).not.toContain("<@111111111111111111>");
  });

  it("renders Discord display and username as different columns when both are available", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "persistedname",
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

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: {
        members: {
          cache: new Map([
            [
              "111111111111111111",
              {
                displayName: "Nickname",
                user: {
                  username: "realusername",
                  globalName: "Global Nick",
                },
              },
            ],
          ]),
        },
      },
      client: { users: { cache: new Map() } },
      values: ["discord-display-name", "discord-username"],
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    const row = getInlineRowSegments(getInlineRows(description)[0] ?? "");

    expect(row.cells).toEqual(["Nickname", "realusername"]);
    expect(description).toContain("Nickname");
    expect(description).toContain("realusername");
    expect(description).not.toContain("persistedname");
  });

  it("falls back to persisted discord username for both display and username when guild cache is missing", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "persistedname",
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

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["discord-display-name", "discord-username"],
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    const row = getInlineRowSegments(getInlineRows(description)[0] ?? "");

    expect(row.cells).toEqual(["persistedname", "persistedname"]);
    expect(description).toContain("persistedname");
  });

  it("renders real inactivity days when Inactivity is selected as a visible column", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "persistedname",
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
        role: "leader",
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        lastSeenAt: new Date(now.getTime() - 7 * 86400000),
      },
    ]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [
        {
          playerTag: "#PYLQ0289",
          playerName: "Alpha Player",
          missedWars: 3,
          participationWars: 4,
        },
      ],
      trackedTags: [],
      trackedNameByTag: new Map(),
      trackedBadgeByTag: new Map(),
      warnings: [],
      diagnosticNote: null,
    } as any);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["townhall", "player-name", "inactivity"],
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);
    expect(prismaMock.playerActivity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          tag: { in: ["#PYLQ0289"] },
        }),
      }),
    );

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(1);
    const row = getInlineRowSegments(rows[0] ?? "");
    expect(row.cells).toEqual(["18", "Alpha Player", "7d 3WAR"]);
    expect(row.value).toBe("7d 3WAR");
    expect(description).toContain("7d 3WAR");
    expect(description).not.toMatch(/^[\u2705\u274C]\s+`?\d+`?\s*$/um);
  });

  it("truncates displayed Discord and player names to 15 characters in /link list rows", async () => {
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted Discord Username Is Very Long",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        playerName: "Player Name Is Also Much Longer Than Limit",
        townHall: 18,
        rank: 18,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
      clanTag: "#PQL0289",
      guildMemberNames: {
        "111111111111111111": "Discord Display Name Is Extremely Long",
      },
    });
    await Link.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload.embeds[0].toJSON().description ?? "");
    const row = getInlineRowSegments(getInlineRows(description)[0] ?? "");
    const expectedDiscordDisplay = "Discord Display Name Is Extremely Long".slice(0, 12) + "...";
    const expectedPlayerName = "Player Name Is Also Much Longer Than Limit".slice(0, 12) + "...";
    expect(row.status).toBe("✅");
    expect(row.townHall).toBe("18");
    expect(row.playerName.trim()).toBe(expectedPlayerName);
    expect(row.playerName.trim()).toHaveLength(15);
    expect(row.value).toBe(expectedDiscordDisplay);
    expect(row.value).toHaveLength(15);
    expect(description).not.toContain("Discord Display Name Is Extremely Long");
    expect(description).not.toContain("Player Name Is Also Much Longer Than Limit");
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
    expect(description).toContain("Player Two");
    expect(description).toContain("15");
    expect(description).not.toContain("``");
    expect(description).not.toContain("|");
    expect(description).not.toContain("#QGRJ2222");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(1);
    const row = getInlineRowSegments(rows[0] ?? "");
    expect(row.status).toBe("❌");
    expect(row.townHall).toBe("15");
    expect(row.value).toBe("—");
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
    expect(payload.components).toHaveLength(3);
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().placeholder).toBe(
      "Columns",
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
    const select = payload.components[3].components[0].toJSON();

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
    prismaMock.trackedClanRep.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();

    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUserId: "111111111111111111",
        discordUsername: "Persisted Sel",
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
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#PQL0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_select:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
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
    expect(description).toContain("120k");
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

  it("preserves selected columns when switching clans", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId(
        "111111111111111111",
        "discord",
        ["player-name", "weight"],
      ),
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

    await handleLinkListSelectMenu(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[3].components[0])).toBe(
      buildLinkListSelectCustomId(
        "111111111111111111",
        "discord",
        ["player-name", "weight"],
      ),
    );
    const description = String(payload.embeds[0].toJSON().description ?? "");
    expect(getInlineRowSegments(getInlineRows(description)[0] ?? "").status).toBe(
      "<:badge_select:1>",
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it("updates same message in place for valid column selection", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
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
      values: ["weight", "clan-role", "player-tag"],
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    const firstEmbed = payload.embeds[0].toJSON();
    const description = String(firstEmbed.description ?? "");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(
      /^<:badge_select:1>\s+`120k`\s+`—`\s+`#PQL0289`$/u,
    );
    expect(firstEmbed.footer?.text).toBe("Sort: Discord Name");
    expect(payload.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payload.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
    expect(payload.components[2].components[0].toJSON().placeholder).toBe(
      "Columns",
    );
    expect(payload.components[3].components[0].toJSON().placeholder).toBe(
      "Select tracked clan",
    );
    const columnsSelect = payload.components[2].components[0].toJSON();
    expect(columnsSelect.options.filter((opt: any) => opt.default)).toHaveLength(3);
    expect(
      columnsSelect.options.filter((opt: any) => opt.default).map((opt: any) => opt.value),
    ).toEqual(["weight", "clan-role", "player-tag"]);
    expect(reply).not.toHaveBeenCalled();
  });

  it("loads persisted violations once when the violations column is selected and renders known zeroes", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha Select",
        townHall: 18,
        rank: 18,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Beta Select",
        townHall: 17,
        rank: 17,
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
    ]);
    const violationSpy = vi
      .spyOn(
        WarPlanViolationHistoryService.prototype,
        "getClanPlayerViolationCounts",
      )
      .mockResolvedValue({
        period: "30d",
        cutoff: new Date("2026-06-01T00:00:00.000Z"),
        clanTag: "#PQL0289",
        hasCompletedEvaluations: true,
        evaluatedWarCount: 2,
        violationCountByPlayerTag: new Map([["#PQL0289", 2]]),
      } as any);

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name", "discord-display-name"],
      ),
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
      values: ["violations"],
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(violationSpy).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    const rows = getInlineRows(String(payload.embeds[0].toJSON().description ?? ""));
    expect(rows).toHaveLength(2);
    expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("`2`");
    expect(String(payload.embeds[0].toJSON().description ?? "")).toContain("`0`");
    expect(payload.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
  });

  it("keeps previously selected columns ahead of new selections", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
      ),
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
      values: ["player-name", "weight", "clan-role"],
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    const rows = getInlineRows(String(payload.embeds[0].toJSON().description ?? ""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(
      /^<:badge_select:1>\s+`Alpha Select`\s+`120k`\s+`—`$/u,
    );
    expect(payload.components[2].components[0].toJSON().placeholder).toBe(
      "Columns",
    );
    const columnsSelect = payload.components[2].components[0].toJSON();
    expect(columnsSelect.options.filter((opt: any) => opt.default).map((opt: any) => opt.value)).toEqual([
      "player-name",
      "weight",
      "clan-role",
    ]);
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

  it("rejects column menu interaction from non-requesting user", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["weight"],
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this menu.",
    });
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("allows a different user to change a public columns menu and keeps the owner custom IDs", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["townhall", "player-name"],
      ),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: {
        members: {
          cache: new Map([
            ["111111111111111111", { displayName: "Select Display Name" }],
          ]),
        },
      },
      client: { users: { cache: new Map() } },
      values: ["weight", "clan-role"],
      message: makePublicLinkListMessage(),
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListColumnsSelectMenu(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["weight", "clan-role"],
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["weight", "clan-role"],
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["weight", "clan-role"],
      ),
    );
    expect(getComponentCustomId(payload.components[3].components[0])).toBe(
      buildLinkListSelectCustomId(
        "111111111111111111",
        "discord",
        ["weight", "clan-role"],
      ),
    );
  });

  it("allows a different user to change a public select menu and keeps the owner custom IDs", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111", "weight"),
      user: { id: "222222222222222222" },
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
      message: makePublicLinkListMessage(),
      deferUpdate,
      editReply,
      update,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListSelectMenu(interaction as any, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[3].components[0])).toBe(
      buildLinkListSelectCustomId("111111111111111111", "weight"),
    );
  });

  it("fails closed when select menu message flags are unavailable", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    const interaction = {
      customId: buildLinkListSelectCustomId("111111111111111111", "weight"),
      user: { id: "222222222222222222" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      values: ["#PQL0289"],
      message: makeMissingFlagsLinkListMessage(),
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
    prismaMock.trackedClanRep.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();

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
        role: "leader",
        rank: 18,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Alpha",
        townHall: 17,
        role: "co",
        rank: 17,
        weight: 0,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        playerName: "Bravo",
        townHall: 16,
        role: "elder",
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
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: "#LCUV0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_sort:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
  });

  it("cycles sort mode in stable order and rerenders rows", async () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const runSortClick = async (
      mode:
        | "discord"
        | "weight"
        | "player-tags"
        | "player"
        | "clan-rank"
        | "inactivity"
        | "violations",
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

    const violationSpy = vi
      .spyOn(
        WarPlanViolationHistoryService.prototype,
        "getClanPlayerViolationCounts",
      )
      .mockResolvedValue({
        period: "30d",
        cutoff: now,
        clanTag: "#PQL0289",
        hasCompletedEvaluations: true,
        evaluatedWarCount: 3,
        violationCountByPlayerTag: new Map([
          ["#QGRJ2222", 3],
          ["#PYLQ0289", 2],
        ]),
      } as any);

    prismaMock.playerActivity.findMany.mockResolvedValue([
      {
        tag: "#PYLQ0289",
        lastSeenAt: new Date(now.getTime() - 7 * 86400000),
      },
      {
        tag: "#QGRJ2222",
        lastSeenAt: new Date(now.getTime() - 7 * 86400000),
      },
    ]);

    const fromDiscord = await runSortClick("discord");
    expect(fromDiscord.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromDiscord.editReply).toHaveBeenCalledTimes(1);
    expect(fromDiscord.update).not.toHaveBeenCalled();
    const payloadWeight = fromDiscord.editReply.mock.calls[0]?.[0] as any;
    const embedWeight = payloadWeight.embeds[0].toJSON();
    const descriptionWeight = String(embedWeight.description ?? "");
    expect(embedWeight.footer?.text).toBe("Sort: Weight Desc");
    const weightRows = getInlineRows(descriptionWeight);
    expect(weightRows).toHaveLength(3);
    expect(getInlineRowSegments(weightRows[0] ?? "").status).toBe("<:badge_sort:1>");
    expect(weightRows.map((row) => getInlineRowSegments(row).value.trim())).toEqual([
      "166k",
      "145k",
      "120k",
    ]);
    expect(weightRows.map((row) => getInlineRowSegments(row).playerName.trim())).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);
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
    const playerTagRows = getInlineRows(descriptionPlayerTags);
    expect(playerTagRows).toHaveLength(3);
    expect(playerTagRows.map((row) => getInlineRowSegments(row).value.trim())).toEqual([
      "#LCUV0289",
      "#QGRJ2222",
      "#PYLQ0289",
    ]);
    expect(playerTagRows.map((row) => getInlineRowSegments(row).playerName.trim())).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);
    expect(payloadPlayerTags.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadPlayerTags.components[1].components[0].toJSON().label).toBe(
      "Sort: Player Tags",
    );
    expect(violationSpy).not.toHaveBeenCalled();

    const fromPlayerTags = await runSortClick("player-tags");
    expect(fromPlayerTags.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromPlayerTags.editReply).toHaveBeenCalledTimes(1);
    expect(fromPlayerTags.update).not.toHaveBeenCalled();
    const payloadPlayer = fromPlayerTags.editReply.mock.calls[0]?.[0] as any;
    const embedPlayer = payloadPlayer.embeds[0].toJSON();
    const descriptionPlayer = String(embedPlayer.description ?? "");
    expect(embedPlayer.footer?.text).toBe("Sort: Player Name");
    const playerRows = getInlineRows(descriptionPlayer);
    expect(playerRows).toHaveLength(3);
    expect(playerRows.map((row) => getInlineRowSegments(row).playerName.trim())).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(playerRows.every((row) => getInlineRowSegments(row).value.trim().length === 0)).toBe(true);

    const fromPlayer = await runSortClick("player");
    expect(fromPlayer.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromPlayer.editReply).toHaveBeenCalledTimes(1);
    expect(fromPlayer.update).not.toHaveBeenCalled();
    const payloadDiscord = fromPlayer.editReply.mock.calls[0]?.[0] as any;
    const embedDiscord = payloadDiscord.embeds[0].toJSON();
    expect(embedDiscord.footer?.text).toBe("Sort: Clan Role");
    expect(payloadDiscord.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadDiscord.components[1].components[0].toJSON().label).toBe(
      "Sort: Clan Role",
    );
    const descriptionClanRank = String(embedDiscord.description ?? "");
    const clanRoleRows = getInlineRows(descriptionClanRank);
    expect(clanRoleRows).toHaveLength(3);
    expect(descriptionClanRank).not.toContain("#17");
    expect(clanRoleRows.map((row) => getInlineRowSegments(row).value.trim())).toEqual([
      "lead",
      "co",
      "eld",
    ]);
    expect(clanRoleRows.map((row) => getInlineRowSegments(row).playerName.trim())).toEqual([
      "Charlie",
      "Alpha",
      "Bravo",
    ]);

    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [
        { playerTag: "#PYLQ0289", playerName: "Charlie", missedWars: 1, participationWars: 3 },
        { playerTag: "#QGRJ2222", playerName: "Alpha", missedWars: 3, participationWars: 4 },
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
    const inactivityRows = getInlineRows(descriptionInactivity);
    expect(inactivityRows).toHaveLength(3);
    expect(prismaMock.playerActivity.findMany).toHaveBeenCalledTimes(1);
    expect(inactivityRows.map((row) => getInlineRowSegments(row).value.trim())).toEqual([
      "7d 3WAR",
      "7d 1WAR",
      "\u2014",
    ]);
    const fromInactivity = await runSortClick("inactivity");
    expect(fromInactivity.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromInactivity.editReply).toHaveBeenCalledTimes(1);
    expect(fromInactivity.update).not.toHaveBeenCalled();
    const payloadViolations = fromInactivity.editReply.mock.calls[0]?.[0] as any;
    const embedViolations = payloadViolations.embeds[0].toJSON();
    expect(embedViolations.footer?.text).toBe("Sort: Violations (30d)");
    expect(payloadViolations.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadViolations.components[1].components[0].toJSON().label).toBe(
      "Sort: Violations (30d)",
    );
    const violationRows = getInlineRows(String(embedViolations.description ?? ""));
    expect(violationRows).toHaveLength(3);
    expect(violationRows.map((row) => getInlineRowSegments(row).value.trim())).toEqual([
      "3",
      "2",
      "0",
    ]);
    expect(violationRows.map((row) => getInlineRowSegments(row).playerName.trim())).toEqual([
      "Alpha",
      "Charlie",
      "Bravo",
    ]);

    const fromViolations = await runSortClick("violations");
    expect(fromViolations.deferUpdate).toHaveBeenCalledTimes(1);
    expect(fromViolations.editReply).toHaveBeenCalledTimes(1);
    expect(fromViolations.update).not.toHaveBeenCalled();
    const payloadDiscordAgain = fromViolations.editReply.mock.calls[0]?.[0] as any;
    const embedDiscordAgain = payloadDiscordAgain.embeds[0].toJSON();
    expect(embedDiscordAgain.footer?.text).toBe("Sort: Discord Name");
    expect(payloadDiscordAgain.components[0].components[0].toJSON().label).toBe(
      "Refresh Data",
    );
    expect(payloadDiscordAgain.components[1].components[0].toJSON().label).toBe(
      "Sort: Discord Name",
    );
    expect(violationSpy).toHaveBeenCalled();
  });

  it("preserves selected columns when cycling sort mode", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
        ["player-name", "weight"],
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
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "weight",
        ["player-name", "weight"],
      ),
    );
    expect(getComponentCustomId(payload.components[3].components[0])).toBe(
      buildLinkListSelectCustomId(
        "111111111111111111",
        "weight",
        ["player-name", "weight"],
      ),
    );
  });

  it("renders the higher of FWA and deferred weights in the weight view", async () => {
    const clanTag = "#PQL0289";
    prismaMock.currentWar.findMany.mockResolvedValue([{ clanTag }]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: clanTag,
        name: "Tracked Alpha",
        clanBadge: null,
        mailConfig: null,
      },
    ]);
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: clanTag,
      name: "Tracked Alpha",
      clanBadge: null,
    });
    prismaMock.playerLink.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        discordUserId: "111111111111111111",
        discordUsername: "Alpha Discord",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        discordUserId: "222222222222222222",
        discordUsername: "Bravo Discord",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        discordUserId: "333333333333333333",
        discordUsername: "Charlie Discord",
        createdAt: new Date("2026-03-15T09:07:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        playerName: "Alpha",
        townHall: 18,
        role: "member",
        rank: 1,
        weight: 145000,
        sourceSyncedAt: new Date("2026-03-21T09:07:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        playerName: "Bravo",
        townHall: 18,
        role: "member",
        rank: 2,
        weight: 150000,
        sourceSyncedAt: new Date("2026-03-21T09:08:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        playerName: "Charlie",
        townHall: 18,
        role: "member",
        rank: 3,
        weight: 150000,
        sourceSyncedAt: new Date("2026-03-21T09:09:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      {
        scopeKey: "guild:guild-1|clan:PQL0289",
        playerTag: "#PQL0289",
        deferredWeight: 150000,
        createdAt: new Date("2026-04-20T02:00:00.000Z"),
      },
      {
        scopeKey: "guild:guild-1|clan:PQL0289",
        playerTag: "#QGRJ2222",
        deferredWeight: 145000,
        createdAt: new Date("2026-04-20T02:00:00.000Z"),
      },
      {
        scopeKey: "guild:guild-1|clan:PQL0289",
        playerTag: "#LCUV0289",
        deferredWeight: 150000,
        createdAt: new Date("2026-04-20T02:00:00.000Z"),
      },
    ]);

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        clanTag,
        "discord",
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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(prismaMock.weightInputDeferment.findMany).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds[0].toJSON().footer?.text).toBe("Sort: Weight Desc");
    const description = payload.embeds
      .map((embed: { toJSON: () => any }) => String(embed.toJSON().description ?? ""))
      .join("\n");
    const rows = getInlineRows(description);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => getInlineRowSegments(row).value)).toEqual([
      "150k",
      "150k",
      "150k",
    ]);
  });

  it("renders a realistic 50-member Player Tags view without aggressively trimming", async () => {
    const rows = makeLinkListClanMembers({
      clanTag: "#PQL0289",
      count: 50,
      playerNamePrefix: "Player With A Moderately Long Name For Chunking",
    });
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#PQL0289",
      name: "Tracked Alpha",
      clanBadge: null,
    });
    prismaMock.playerLink.findMany.mockResolvedValue(
      rows.slice(0, 40).map((row, index) => ({
        playerTag: row.playerTag,
        discordUserId: String(300000000000000000n + BigInt(index)),
        discordUsername: `Linked ${index + 1}`,
      })),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: rows[0]?.playerTag ?? "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_weight:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: rows[0]?.playerTag ?? "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_paginate:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds.length).toBeGreaterThanOrEqual(1);
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    expect(payload.embeds[0].toJSON().title).toBe(
      "Tracked Alpha #PQL0289",
    );
    expect(payload.embeds[1]?.toJSON().title).toBeUndefined();
    const description = payload.embeds
      .map((embed: { toJSON: () => any }) => embed.toJSON().description ?? "")
      .join("\n");
    const renderedRows = getInlineRows(description);
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    expect(description).toContain("Linked Users: 40");
    expect(description).toContain("Unlinked users: 10");
    expect(renderedRows).toHaveLength(50);
    expect(description).not.toMatch(/^[\u2705\u274C]\s+`?\d+`?\s*$/um);
    expect(
      renderedRows.some(
        (row) => getInlineRowSegments(row).status === "<:badge_paginate:1>",
      ),
    ).toBe(true);
    expect(getInlineRowSegments(renderedRows[0] ?? "").playerName.trim()).toHaveLength(15);
    expect(getInlineRowSegments(renderedRows[0] ?? "").value).toMatch(/^#[A-Z0-9]+$/u);
    expect(
      getInlineRows(payload.embeds.at(-1)?.toJSON().description ?? "")[0] ?? "",
    ).toMatch(LINK_LIST_ROW_LINE_RE);
    expect(
      payload.embeds.reduce(
        (sum: number, embed: { toJSON: () => any }) =>
          sum + String(embed.toJSON().description ?? "").length,
        0,
      ),
    ).toBeLessThanOrEqual(5200);
    expect(description).not.toContain("...and");
    const lastRow = getInlineRowSegments(renderedRows[renderedRows.length - 1] ?? "");
    expect(lastRow.playerName.trim()).toHaveLength(15);
    expect(lastRow.value.trim()).toMatch(/^#[A-Z0-9]+$/u);
  }, 30000);

  it("renders a realistic 50-member Discord Name view without aggressively trimming", async () => {
    const rows = makeLinkListClanMembers({
      clanTag: "#PQL0289",
      count: 50,
      playerNamePrefix: "Player With A Moderately Long Name For Chunking",
    });
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#PQL0289",
      name: "Tracked Alpha",
      clanBadge: null,
    });
    prismaMock.playerLink.findMany.mockResolvedValue(
      rows.slice(0, 40).map((row, index) => ({
        playerTag: row.playerTag,
        discordUserId: String(300000000000000000n + BigInt(index)),
        discordUsername: `Linked ${index + 1}`,
      })),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);

    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "inactivity",
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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds.length).toBeGreaterThanOrEqual(1);
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    expect(payload.embeds[0].toJSON().title).toBe(
      "Tracked Alpha #PQL0289",
    );
    expect(payload.embeds[1]?.toJSON().title).toBeUndefined();
    const description = payload.embeds
      .map((embed: { toJSON: () => any }) => embed.toJSON().description ?? "")
      .join("\n");
    const renderedRows = getInlineRows(description);
    expect(renderedRows).toHaveLength(50);
    expect(description).not.toMatch(/^[\u2705\u274C]\s+`?\d+`?\s*$/um);
    expect(description).toContain("Linked Users: 40");
    expect(description).toContain("Unlinked users: 10");
    expect(payload.embeds.at(-1)?.toJSON().footer?.text).toBe("Sort: Violations (30d)");
    expect(getInlineRowSegments(renderedRows[0] ?? "").playerName.trim()).toHaveLength(15);
    expect(getInlineRowSegments(renderedRows[0] ?? "").value).toBeTruthy();
    expect(
      getInlineRows(payload.embeds.at(-1)?.toJSON().description ?? "")[0] ?? "",
    ).toMatch(LINK_LIST_ROW_LINE_RE);
    const lastRow = getInlineRowSegments(renderedRows[renderedRows.length - 1] ?? "");
    expect(lastRow.playerName.trim()).toHaveLength(15);
    expect(lastRow.value.length).toBeGreaterThan(0);
  }, 30000);

  it("renders a realistic 50-member Weight view without aggressively trimming", async () => {
    const rows = makeLinkListClanMembers({
      clanTag: "#PQL0289",
      count: 50,
      playerNamePrefix: "Player With A Moderately Long Name For Chunking",
    });
    prismaMock.trackedClan.findUnique.mockResolvedValue({
      tag: "#PQL0289",
      name: "Tracked Alpha",
      clanBadge: null,
    });
    prismaMock.playerLink.findMany.mockResolvedValue(
      rows.slice(0, 40).map((row, index) => ({
        playerTag: row.playerTag,
        discordUserId: String(300000000000000000n + BigInt(index)),
        discordUsername: `Linked ${index + 1}`,
      })),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);

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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds.length).toBeGreaterThanOrEqual(1);
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    expect(payload.embeds[0].toJSON().title).toBe(
      "Tracked Alpha #PQL0289",
    );
    expect(payload.embeds[1]?.toJSON().title).toBeUndefined();
    const description = payload.embeds
      .map((embed: { toJSON: () => any }) => embed.toJSON().description ?? "")
      .join("\n");
    const renderedRows = getInlineRows(description);
    expect(renderedRows).toHaveLength(50);
    expect(description).not.toMatch(/^[\u2705\u274C]\s+`?\d+`?\s*$/um);
    expect(description).toContain("Linked Users: 40");
    expect(description).toContain("Unlinked users: 10");
    expect(payload.embeds.at(-1)?.toJSON().footer?.text).toBe("Sort: Weight Desc");
    expect(getInlineRowSegments(renderedRows[0] ?? "").playerName.trim()).toHaveLength(15);
    expect(getInlineRowSegments(renderedRows[0] ?? "").value).not.toBe("");
    expect(
      String(payload.embeds.at(-1)?.toJSON().description ?? "").length === 0 ||
        LINK_LIST_ROW_LINE_RE.test(
          getInlineRows(payload.embeds.at(-1)?.toJSON().description ?? "")[0] ?? "",
        ),
    ).toBe(true);
    const lastRow = getInlineRowSegments(renderedRows[renderedRows.length - 1] ?? "");
    expect(lastRow.playerName.trim()).toHaveLength(15);
    expect(lastRow.value.length).toBeGreaterThan(0);
  }, 30000);

  it("trims oversized Player Tags views instead of throwing", async () => {
    const rows = makeLinkListClanMembers({
      clanTag: "#PQL0289",
      count: 300,
      playerNamePrefix: "Player With An Exceptionally Long Name For Trimming That Pushes The Payload Over The Budget",
    }).map((row, index) => ({
      ...row,
      playerTag: makeLongValidTag(index),
    }));
    prismaMock.playerLink.findMany.mockResolvedValue(
      rows.map((row, index) => ({
        playerTag: row.playerTag,
        discordUserId: String(100000000000000000n + BigInt(index)),
        discordUsername: `User ${index + 1}`,
      })),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);
    prismaMock.trackedClanRep.findMany.mockResolvedValue([
      {
        clanTag: "#PQL0289",
        playerTag: rows[0]?.playerTag ?? "#PYLQ0289",
        clan: {
          tag: "#PQL0289",
          clanBadge: "<:badge_trim:1>",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          mailConfig: { displayOrder: 1 },
        },
      },
    ]);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    const description = payload.embeds.map((embed: { toJSON: () => any }) => embed.toJSON().description ?? "").join("\n");
    expect(description).toContain("more rows hidden");
    expect(description).toContain("rows hidden");
    expect(description).toContain("Refresh Data");
    expect(infoSpy.mock.calls.some((call) =>
      String(call[0] ?? "").includes("event=link_list_payload_trimmed") &&
      String(call[0] ?? "").includes("sortMode=player-tags") &&
      String(call[0] ?? "").includes("hiddenRows="),
    )).toBe(true);
  }, 30000);

  it("trims oversized Inactivity views instead of throwing", async () => {
    const rows = makeLinkListClanMembers({
      clanTag: "#PQL0289",
      count: 300,
      playerNamePrefix: "Inactive Player With An Exceptionally Long Name For Trimming That Pushes The Payload Over The Budget",
    }).map((row, index) => ({
      ...row,
      playerTag: makeLongValidTag(index),
    }));
    prismaMock.playerLink.findMany.mockResolvedValue(
      rows.map((row, index) => ({
        playerTag: row.playerTag,
        discordUserId: String(200000000000000000n + BigInt(index)),
        discordUsername: `User ${index + 1}`,
      })),
    );
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(rows);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: rows.map((row, index) => ({
        clanTag: "#PQL0289",
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHall: row.townHall,
        missedWars: 12345 - index,
        participationWars: 12345 - index,
        totalTrueStars: 0,
        avgAttackDelay: null,
        lateAttacks: 0,
        warsAvailable: 12345,
        missedWarStates: [],
      })),
      trackedTags: ["#PQL0289"],
      trackedNameByTag: new Map([["#PQL0289", "Test Clan"]]),
      trackedBadgeByTag: new Map([["#PQL0289", null]]),
      warnings: [],
      diagnosticNote: null,
    } as any);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "clan-rank",
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

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(payload.embeds.length).toBeLessThanOrEqual(2);
    const description = payload.embeds.map((embed: { toJSON: () => any }) => embed.toJSON().description ?? "").join("\n");
    expect(description).toContain("more rows hidden");
    expect(description).toContain("rows hidden");
    expect(description).not.toContain("`#");
    expect(infoSpy.mock.calls.some((call) =>
      String(call[0] ?? "").includes("event=link_list_payload_trimmed") &&
      String(call[0] ?? "").includes("sortMode=inactivity"),
    )).toBe(true);
  }, 30000);

  it("surfaces editReply failures after deferUpdate with an ephemeral follow-up", async () => {
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockRejectedValue({
      code: 50013,
      message: "Missing Permissions",
    });
    const followUp = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const interaction = {
      customId: buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "discord",
      ),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      guild: { members: { cache: new Map() } },
      client: { users: { cache: new Map() } },
      deferUpdate,
      editReply,
      followUp,
      reply,
      deferred: false,
      replied: false,
    };

    await handleLinkListSortButton(interaction as any, { getClan: vi.fn() } as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "link_list_too_large: this view was too large to render. Trimmed output will be used after rerun.",
    });
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0] ?? "").includes("event=link_list_edit_failed") &&
        String(call[0] ?? "").includes("code=50013") &&
        String(call[0] ?? "").includes("Missing Permissions"),
      ),
    ).toBe(true);
  }, 30000);

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
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);

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

  it("allows a different user to cycle sort on a public message and keeps the owner custom IDs", async () => {
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
      message: makePublicLinkListMessage(),
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
    expect(reply).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] as any;
    expect(getComponentCustomId(payload.components[0].components[0])).toBe(
      buildLinkListRefreshButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[1].components[0])).toBe(
      buildLinkListSortButtonCustomId(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[2].components[0])).toBe(
      buildLinkListColumnsSelectCustomIdForTest(
        "111111111111111111",
        "#PQL0289",
        "weight",
      ),
    );
    expect(getComponentCustomId(payload.components[3].components[0])).toBe(
      buildLinkListSelectCustomId("111111111111111111", "weight"),
    );
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

