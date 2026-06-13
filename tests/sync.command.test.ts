import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPermissionService } from "../src/services/CommandPermissionService";
import { SettingsService } from "../src/services/SettingsService";
import { trackedMessageService } from "../src/services/TrackedMessageService";
import * as syncTimeFwaClanListViewService from "../src/services/SyncTimeFwaClanListViewService";
import { SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID } from "../src/services/SyncTimeFwaClanListViewService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
}));

const syncBadgeEmojis = vi.hoisted(() => [
  { code: "RR", label: "Rocky Road", name: "rr", id: "111" },
  { code: "TWC", label: "TheWiseCowboys", name: "twc", id: "222" },
  { code: "GB", label: "Gabbar", name: "gb", id: "333" },
]);
const checklistAutoPostMock = vi.hoisted(() => ({
  postForSyncTrackedMessage: vi.fn().mockResolvedValue({
    posted: 0,
    skipped: 2,
    failed: 0,
  }),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/syncBadgeEmoji", () => ({
  findSyncBadgeEmojiForClan: vi.fn(() => null),
  getSyncBadgeEmojis: vi.fn(() => syncBadgeEmojis),
}));

vi.mock("../src/services/fwa/matchChecklistAutoPostService", () => ({
  fwaMatchChecklistAutoPostService: checklistAutoPostMock,
}));

import { Post, handlePostModalSubmit } from "../src/commands/Post";

function makeSendableChannel(input: {
  id: string;
  guildId?: string;
  type?: ChannelType;
  canSend?: boolean;
}) {
  const react = vi.fn().mockResolvedValue(undefined);
  const pin = vi.fn().mockResolvedValue(undefined);
  const fetchPinned = vi.fn().mockResolvedValue(new Map());
  const send = vi.fn().mockResolvedValue({
    id: `posted-message-${input.id}`,
    channelId: input.id,
    react,
    pin,
  });

  return {
    id: input.id,
    guildId: input.guildId ?? "guild-1",
    type: input.type ?? ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: vi.fn().mockReturnValue({
      has: vi.fn().mockReturnValue(input.canSend ?? true),
    }),
    messages: {
      fetchPinned,
    },
    send,
    react,
    pin,
    fetchPinned,
  };
}

function makeRunInteraction(input: {
  timezone: string | null;
  channel?: unknown | null;
  admin?: boolean;
  subcommandGroup?: "time" | "post" | "spin" | null;
  subcommand?: string;
  refresh?: boolean | null;
  visibility?: string | null;
}) {
  const role = {
    id: "123456789012345678",
    name: "War",
    mentionable: true,
  };
  return {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    guild: {
      id: "guild-1",
      roles: {
        fetch: vi.fn().mockResolvedValue(role),
      },
      channels: {
        cache: new Map(),
        fetch: vi.fn(),
      },
      members: {
        me: { id: "bot-1" },
      },
    },
    memberPermissions: {
      has: vi.fn().mockReturnValue(input.admin ?? true),
    },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(
        input.subcommandGroup === undefined ? "time" : input.subcommandGroup,
      ),
      getSubcommand: vi.fn().mockReturnValue(input.subcommand ?? "post"),
      getRole: vi.fn().mockReturnValue(role),
      getBoolean: vi.fn((name: string) => {
        if (name === "refresh") return input.refresh ?? null;
        return null;
      }),
      getString: vi.fn((name: string) => {
        if (name === "timezone") return input.timezone;
        if (name === "visibility") return input.visibility ?? null;
        return null;
      }),
      getChannel: vi.fn((name: string) => {
        if (name === "channel") return input.channel ?? null;
        return null;
      }),
    },
    showModal: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({
      id: "tracked-readiness-message",
      channelId: "channel-1",
    }),
  };
}

function makeSubmitInteraction(input: {
  timezone: string;
  role: string;
  currentChannel?: ReturnType<typeof makeSendableChannel>;
  destinationChannel?: ReturnType<typeof makeSendableChannel> | null;
}) {
  const currentChannel =
    input.currentChannel ??
    makeSendableChannel({
      id: "channel-1",
      guildId: "guild-1",
      type: ChannelType.GuildText,
    });
  const destinationChannel = input.destinationChannel ?? currentChannel;
  const guildChannels = new Map<string, unknown>([[currentChannel.id, currentChannel]]);
  if (destinationChannel && destinationChannel.id !== currentChannel.id) {
    guildChannels.set(destinationChannel.id, destinationChannel);
  }

  return {
    customId: "post-sync-time:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    channelId: currentChannel.id,
    user: { id: "user-1" },
    client: { user: { id: "bot-1" } },
    guild: {
      id: "guild-1",
      channels: {
        cache: guildChannels,
        fetch: vi.fn(async (channelId: string) => guildChannels.get(channelId) ?? null),
      },
      roles: {
        fetch: vi.fn().mockResolvedValue({
          id: input.role.replace(/^<@&|>$/g, ""),
          name: "War",
          mentionable: true,
        }),
      },
      members: {
        me: { id: "bot-1" },
      },
    },
    channel: currentChannel,
    fields: {
      getTextInputValue: vi.fn((name: string) => {
        if (name === "date") return "2026-04-08";
        if (name === "time") return "20:30";
        if (name === "timezone") return input.timezone;
        if (name === "role") return input.role;
        return "";
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStatusMember(input: {
  admin?: boolean;
  roleIds?: string[];
}) {
  const roleIds = input.roleIds ?? [];
  return {
    permissions: {
      has: vi.fn().mockReturnValue(Boolean(input.admin)),
    },
    roles: {
      cache: {
        has: (roleId: string) => roleIds.includes(roleId),
      },
    },
  } as any;
}

function makeStatusReaction(
  emoji: { id: string | null; name: string | null },
  userIds: string[],
) {
  return {
    emoji,
    users: {
      fetch: vi.fn().mockResolvedValue(
        new Map(
          userIds.map((userId) => [
            userId,
            { id: userId, bot: false, username: `User-${userId}` },
          ]),
        ),
      ),
    },
  } as any;
}

function makeStatusInteraction(input: {
  group: "post" | "spin";
  messageId: string;
  message: any;
  membersById: Record<string, any>;
}) {
  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: vi.fn().mockResolvedValue(input.message),
    },
  };
  const channelCache = new Map([["channel-1", channel]]) as any;
  channelCache.filter = (fn: (value: any) => boolean) =>
    new Map([...channelCache.entries()].filter(([, value]) => fn(value)));

  return {
    inGuild: () => true,
    guildId: "guild-1",
    guild: {
      id: "guild-1",
      channels: {
        cache: channelCache,
      },
      members: {
        fetch: vi.fn(async (userId: string) => input.membersById[userId] ?? null),
      },
    },
    client: { user: { id: "bot-1" } },
    user: { id: "user-1" },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input.group),
      getSubcommand: vi.fn().mockReturnValue("status"),
      getString: vi.fn((name: string) => (name === "message-id" ? input.messageId : null)),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/sync time post command shape", () => {
  it("registers role and timezone but no destination channel on the post subcommand", () => {
    const timeGroup = Post.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "time",
    );
    const postSubcommand = timeGroup?.options?.find(
      (option: { name: string }) => option.name === "post",
    );
    const roleOption = postSubcommand?.options?.find(
      (option: { name: string }) => option.name === "role",
    );
    const channelOption = postSubcommand?.options?.find(
      (option: { name: string }) => option.name === "channel",
    );
    const timezoneOption = postSubcommand?.options?.find(
      (option: { name: string }) => option.name === "timezone",
    );

    expect(channelOption).toBeUndefined();
    expect(roleOption?.required).toBe(false);
    expect(timezoneOption?.required).toBe(false);
    expect(timezoneOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(timezoneOption?.autocomplete).toBe(true);
  });
});

describe("/sync readiness command shape", () => {
  it("registers refresh and visibility options on the direct readiness subcommand", () => {
    const readiness = Post.options?.find(
      (option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "readiness",
    );
    const refreshOption = readiness?.options?.find((option: { name: string }) => option.name === "refresh");
    const visibilityOption = readiness?.options?.find((option: { name: string }) => option.name === "visibility");

    expect(refreshOption?.required).toBe(false);
    expect(refreshOption?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(visibilityOption?.required).toBe(false);
    expect(visibilityOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(visibilityOption?.choices?.map((choice: { value: string }) => choice.value)).toEqual([
      "private",
      "public",
    ]);
  });
});

describe("/sync time post autocomplete", () => {
  it("returns IANA-only zones with curated common zones first", async () => {
    const interaction = {
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue("time"),
        getSubcommand: vi.fn().mockReturnValue("post"),
        getFocused: vi.fn().mockReturnValue({ name: "timezone", value: "America" }),
      },
      respond: vi.fn().mockResolvedValue(undefined),
    };

    await Post.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledTimes(1);
    const choices = interaction.respond.mock.calls[0]?.[0] ?? [];
    expect(choices.slice(0, 4).map((choice: { value: string }) => choice.value)).toEqual([
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
    ]);
    expect(
      choices.every(
        (choice: { value: string }) => choice.value.includes("/") && !choice.value.startsWith("Etc/"),
      ),
    ).toBe(true);
  });
});

describe("/sync post status reaction scan", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    checklistAutoPostMock.postForSyncTrackedMessage.mockResolvedValue({
      posted: 0,
      skipped: 2,
      failed: 0,
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key === "fwa_leader_role:guild-1") return "123456789012345678";
      if (key === "command_roles:post") return null;
      if (key === "command_roles:post:sync:time") return null;
      return null;
    });
    vi.spyOn(trackedMessageService, "fetchSyncTrackedMessageWithClaims").mockResolvedValue(null);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null);
  });

  it("scans live reactions without tracked metadata and classifies claimed, unclaimed, and unavailable users", async () => {
    const message = {
      id: "123456789012345678",
      channelId: "channel-1",
      author: { bot: true },
      content: "# Sync time :gem: <t:1742407800:F> (<t:1742407800:R>)",
      reactions: {
        cache: new Map([
          [
            "rr",
            makeStatusReaction({ id: "111", name: "rr" }, ["admin-user", "nonleader-user"]),
          ],
          ["twc", makeStatusReaction({ id: "222", name: "twc" }, ["leader-user"])],
          ["gb", makeStatusReaction({ id: "333", name: "gb" }, ["only-nonleader-user"])],
          ["zzz", makeStatusReaction({ id: null, name: "💤" }, ["unavailable-user"])],
        ]),
      },
    };
    const membersById = {
      "admin-user": makeStatusMember({ admin: true }),
      "leader-user": makeStatusMember({ roleIds: ["123456789012345678"] }),
      "nonleader-user": makeStatusMember({}),
      "only-nonleader-user": makeStatusMember({}),
    };
    const interaction = makeStatusInteraction({
      group: "post",
      messageId: message.id,
      message,
      membersById,
    });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.fetchSyncTrackedMessageWithClaims).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls
      .map((call) => call[0])
      .find((value) => value && typeof value === "object" && "embeds" in value) as any;
    expect(payload).toBeTruthy();
    const embed = payload.embeds[0].toJSON() as any;
    expect(embed.title).toBe("Sync Claim Status");
    expect(embed.description).toContain("Claimed: **2/3**");
    expect(embed.description).toContain("Unavailable (\u{1F4A4}): **1**");
    expect(embed.description).toContain("\u{1F4A4} <@unavailable-user>");
    expect(embed.description).toContain("- <:rr:111> **RR** (Rocky Road) - <@admin-user> | non-leader: <@nonleader-user>");
    expect(embed.description).toContain("- <:twc:222> **TWC** (TheWiseCowboys) - <@leader-user>");
    expect(embed.description).toContain(
      "- <:gb:333> **GB** (Gabbar) (only non-leader: <@only-nonleader-user>)",
    );
    expect(embed.description).toContain("**Claimed Clans**");
    expect(embed.description).toContain("**Unclaimed Clans**");
    expect(embed.footer.text).toContain("Leader eligibility:");
  });
});

describe("/sync status command shape", () => {
  it("registers post and spin status subcommands with message-id options", () => {
    const postGroup = Post.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "post",
    );
    const spinGroup = Post.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "spin",
    );
    const postStatusSubcommand = postGroup?.options?.find(
      (option: { name: string }) => option.name === "status",
    );
    const spinStatusSubcommand = spinGroup?.options?.find(
      (option: { name: string }) => option.name === "status",
    );

    expect(postStatusSubcommand?.options?.find((option: { name: string }) => option.name === "message-id")?.required).toBe(false);
    expect(spinStatusSubcommand?.options?.find((option: { name: string }) => option.name === "message-id")?.required).toBe(false);
  });
});

describe("/sync time post modal seed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    vi.spyOn(CommandPermissionService.prototype, "getFwaLeaderRoleId").mockResolvedValue(null);
    vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockResolvedValue(undefined);
  });

  it("prefills timezone from the slash arg when provided", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key.startsWith("user_timezone:")) return null;
      if (key.startsWith("guild_sync_role:")) return null;
      if (key.startsWith("fwa_leader_role:")) return null;
      return null;
    });

    const interaction = makeRunInteraction({ timezone: "America/Los_Angeles" });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON() as any;
    expect(modal.components[2].components[0].value).toBe("America/Los_Angeles");
  });

  it("keeps the remembered timezone when the slash arg is omitted", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key.startsWith("user_timezone:")) return "America/Chicago";
      if (key.startsWith("guild_sync_role:")) return null;
      if (key.startsWith("fwa_leader_role:")) return null;
      return null;
    });

    const interaction = makeRunInteraction({ timezone: null });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON() as any;
    expect(modal.components[2].components[0].value).toBe("America/Chicago");
  });

  it("does not read a destination channel option before opening the modal", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);
    const interaction = makeRunInteraction({ timezone: null });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.options.getChannel).not.toHaveBeenCalled();
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });
});

describe("/sync readiness direct post", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);
    vi.spyOn(
      trackedMessageService,
      "replacePriorSyncReadinessTrackedMessagesForGuildAndCreate",
    ).mockResolvedValue(0);
    vi.spyOn(syncTimeFwaClanListViewService, "refreshTrackedClanReadinessState").mockResolvedValue({
      trackedClanCount: 0,
      syncAllFailedClanTags: [],
      currentMemberFailedClanTags: [],
    });
  });

  it("posts a private readiness dashboard without a tracked message row or refresh button", async () => {
    const interaction = makeRunInteraction({
      timezone: null,
      subcommandGroup: null,
      subcommand: "readiness",
      refresh: false,
      visibility: "private",
    });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(String(payload.content ?? "")).toBe("# FWA readiness");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toHaveLength(0);
    expect(
      trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate,
    ).not.toHaveBeenCalled();
  });

  it("posts a public readiness dashboard with a public response", async () => {
    const interaction = makeRunInteraction({
      timezone: null,
      subcommandGroup: null,
      subcommand: "readiness",
      refresh: false,
      visibility: "public",
    });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(payload.components).toHaveLength(1);
    expect(
      trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate,
    ).toHaveBeenCalledTimes(1);
  });

  it("forces a readiness refresh before rendering when refresh:true is supplied", async () => {
    const refreshSpy = vi.spyOn(
      syncTimeFwaClanListViewService,
      "refreshTrackedClanReadinessState",
    );
    const interaction = makeRunInteraction({
      timezone: null,
      subcommandGroup: null,
      subcommand: "readiness",
      refresh: true,
      visibility: "private",
    });

    await Post.run({} as any, interaction as any, {} as any);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith({ guildId: "guild-1" });
  });

  it("returns a clear error when a forced readiness refresh fails", async () => {
    vi.spyOn(syncTimeFwaClanListViewService, "refreshTrackedClanReadinessState").mockRejectedValueOnce(
      new Error("boom"),
    );
    const interaction = makeRunInteraction({
      timezone: null,
      subcommandGroup: null,
      subcommand: "readiness",
      refresh: true,
      visibility: "private",
    });

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[0]?.[0] ?? "")).toContain(
      "Failed to refresh the readiness dashboard",
    );
    expect(
      trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate,
    ).not.toHaveBeenCalled();
  });

  it("shows a concise warning when a forced readiness refresh has partial clan failures", async () => {
    vi.spyOn(syncTimeFwaClanListViewService, "refreshTrackedClanReadinessState").mockResolvedValueOnce({
      trackedClanCount: 3,
      syncAllFailedClanTags: ["#AAAAAA"],
      currentMemberFailedClanTags: ["#BBBBBB"],
    });
    const interaction = makeRunInteraction({
      timezone: null,
      subcommandGroup: null,
      subcommand: "readiness",
      refresh: true,
      visibility: "private",
    });

    await Post.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(String(payload.content ?? "")).toContain("⚠️ Refresh completed with 2 clan refresh failures.");
    expect(
      trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate,
    ).not.toHaveBeenCalled();
  });
});

describe("/sync time post modal submit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    checklistAutoPostMock.postForSyncTrackedMessage.mockResolvedValue({
      posted: 0,
      skipped: 2,
      failed: 0,
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(CommandPermissionService.prototype, "getFwaLeaderRoleId").mockResolvedValue(null);
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);
    vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);
    vi.spyOn(trackedMessageService, "createSyncTimeTrackedMessage").mockResolvedValue(undefined);
    vi.spyOn(trackedMessageService, "fetchSyncTrackedMessageWithClaims").mockResolvedValue(null);
    vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost").mockResolvedValue(null);
  });

  it("uses the submitted modal timezone even when the slash arg had a different seed", async () => {
    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
    });

    await handlePostModalSubmit(interaction as any);

    expect(SettingsService.prototype.set).toHaveBeenCalledWith(
      "user_timezone:user-1",
      "America/Chicago",
    );
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel-1",
        metadata: expect.objectContaining({
          syncEpochSeconds: expect.any(Number),
        }),
      }),
    );
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("America/Chicago"),
    );
  });

  it("posts to the typed sync bot-log destination channel when configured", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key === "bot_logs_channel:guild-1:sync") return "222222222222222222";
      if (key.startsWith("active_sync_post:")) return null;
      return null;
    });

    const destinationChannel = makeSendableChannel({
      id: "222222222222222222",
      guildId: "guild-1",
      type: ChannelType.GuildText,
    });
    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
      destinationChannel,
    });

    await handlePostModalSubmit(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(destinationChannel.send).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "222222222222222222",
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Posted in <#222222222222222222>."),
    );
  });

  it("attaches the shared FWA readiness embed and refresh button to the sync-time post", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        shortName: "AC",
      },
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValueOnce([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
        playerName: "Player One",
        townHall: 16,
        weight: 150000,
        sourceSyncedAt: new Date("2026-06-10T11:55:00.000Z"),
      },
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValueOnce([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValueOnce([]);
    prismaMock.playerCurrent.findMany.mockResolvedValueOnce([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValueOnce([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValueOnce([]);

    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
    });

    await handlePostModalSubmit(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    const payload = interaction.channel.send.mock.calls[0]?.[0] as any;
    expect(String(payload.content ?? "")).toContain("# Sync time :gem:");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].toJSON().title).toBe("FWA Readiness (1)");
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0].toJSON().components[0].custom_id).toBe(
      SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID,
    );
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          fwaClanListEnabled: true,
          fwaClanListRefreshExpiresAtIso: expect.any(String),
          fwaClanListLastRefreshedAtIso: expect.any(String),
        }),
      }),
    );
  });

  it("posts the sync-time message normally if the clan-list render fails", async () => {
    const renderSpy = vi
      .spyOn(syncTimeFwaClanListViewService, "buildSyncTimeFwaClanListMessagePayload")
      .mockRejectedValueOnce(new Error("render blew up"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
    });

    await handlePostModalSubmit(interaction as any);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    const payload = interaction.channel.send.mock.calls[0]?.[0] as any;
    expect(String(payload.content ?? "")).toContain("# Sync time :gem:");
    expect(payload.embeds ?? []).toHaveLength(0);
    expect(payload.components ?? []).toHaveLength(0);
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          syncTimeIso: expect.any(String),
          syncEpochSeconds: expect.any(Number),
          roleId: "123456789012345678",
          clans: expect.any(Array),
        }),
      }),
    );
    const metadata = (trackedMessageService.createSyncTimeTrackedMessage as any).mock.calls[0]?.[0]
      ?.metadata;
    expect(metadata.fwaClanListEnabled).toBeUndefined();
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).toContain("[sync-time-fwa-list] render_failed");
    renderSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("falls back to the legacy saved destination channel when typed sync is not configured", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key === "bot_logs_channel:guild-1:sync") return null;
      if (key === "guild_sync_post_channel:guild-1") return "channel-2";
      if (key.startsWith("active_sync_post:")) return null;
      return null;
    });

    const destinationChannel = makeSendableChannel({
      id: "channel-2",
      guildId: "guild-1",
      type: ChannelType.GuildText,
    });
    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
      destinationChannel,
    });

    await handlePostModalSubmit(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(destinationChannel.send).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel-2",
      }),
    );
  });

  it("falls back to the current channel when the typed sync destination channel is unavailable", async () => {
    const deleteSpy = vi.spyOn(SettingsService.prototype, "delete").mockResolvedValue(undefined);
    vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
      if (key === "bot_logs_channel:guild-1:sync") return "222222222222222222";
      if (key.startsWith("active_sync_post:")) return null;
      return null;
    });

    const missingChannel = makeSendableChannel({
      id: "222222222222222222",
      guildId: "guild-1",
      type: ChannelType.GuildText,
    });
    const interaction = makeSubmitInteraction({
      timezone: "America/Chicago",
      role: "<@&123456789012345678>",
      destinationChannel: missingChannel,
    });
    interaction.guild.channels.cache.delete("222222222222222222");
    interaction.guild.channels.fetch = vi.fn(async () => null);

    await handlePostModalSubmit(interaction as any);

    expect(deleteSpy).toHaveBeenCalledWith("bot_logs_channel:guild-1:sync");
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(trackedMessageService.createSyncTimeTrackedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel-1",
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("Configured sync bot-log channel <#222222222222222222> is unavailable"),
    );
  });

  it("renders sync spin status with the shared spin-status renderer", async () => {
    const syncMessage = {
      id: "123456789012345678",
      channelId: "channel-1",
      author: { bot: true },
      content: "# Sync time :gem: <t:1742407800:F> (<t:1742407800:R>)",
    };
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(syncMessage),
      },
    };
    const channelCache = new Map([["channel-1", channel]]) as any;
    channelCache.filter = (fn: (value: any) => boolean) =>
      new Map([...channelCache.entries()].filter(([, value]) => fn(value)));

    vi.mocked(trackedMessageService.fetchSyncTrackedMessageWithClaims).mockResolvedValue({
      id: "tracked-1",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: syncMessage.id,
      featureType: "SYNC_TIME_POST",
      status: "ACTIVE",
      referenceId: null,
      remindAt: null,
      expiresAt: new Date("2026-04-10T02:00:00.000Z"),
      metadata: {
        syncTimeIso: "2026-03-19T15:30:00.000Z",
        syncEpochSeconds: 1742407800,
        roleId: "456",
        reminderSentAt: null,
        clans: [
          {
            code: "RR",
            clanTag: "#PYLQ",
            clanName: "Rocky Road",
            emojiId: "111",
            emojiName: "rr",
            emojiInline: "<:rr:111>",
          },
          {
            code: "TWC",
            clanTag: "#PYLG",
            clanName: "TheWiseCowboys",
            emojiId: "222",
            emojiName: "twc",
            emojiInline: "<:twc:222>",
          },
        ],
      },
      claims: [{ clanTag: "#PYLQ" }],
    } as any);

    const interaction = {
      inGuild: () => true,
      guildId: "guild-1",
      guild: {
        id: "guild-1",
        channels: {
          cache: channelCache,
        },
      },
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue("spin"),
        getSubcommand: vi.fn().mockReturnValue("status"),
        getString: vi.fn((name: string) => (name === "message-id" ? syncMessage.id : null)),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: { user: { id: "bot-1" } },
      user: { id: "user-1" },
    };

    await Post.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls
      .map((call) => call[0])
      .find((value) => value && typeof value === "object" && "embeds" in value) as any;
    expect(payload).toBeTruthy();
    const embed = payload.embeds[0].toJSON() as any;
    expect(embed.title).toBe("Sync Spin Status");
    expect(embed.description).toContain("Claimed: **1/2**");
    expect(embed.description).toContain("✅ <:rr:111> **RR** (Rocky Road)");
    expect(embed.description).toContain("- <:twc:222> **TWC** (TheWiseCowboys)");
  });
});
