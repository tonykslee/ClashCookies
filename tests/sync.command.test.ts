import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPermissionService } from "../src/services/CommandPermissionService";
import { SettingsService } from "../src/services/SettingsService";
import { trackedMessageService } from "../src/services/TrackedMessageService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/helper/syncBadgeEmoji", () => ({
  findSyncBadgeEmojiForClan: vi.fn(() => null),
  getSyncBadgeEmojis: vi.fn(() => []),
}));

import { Post, handlePostModalSubmit } from "../src/commands/Post";

function makeRunInteraction(input: { timezone: string | null }) {
  return {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue("time"),
      getSubcommand: vi.fn().mockReturnValue("post"),
      getRole: vi.fn().mockReturnValue(null),
      getString: vi.fn((name: string) => {
        if (name === "timezone") return input.timezone;
        return null;
      }),
    },
    showModal: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSubmitInteraction(input: { timezone: string; role: string }) {
  const react = vi.fn().mockResolvedValue(undefined);
  const pin = vi.fn().mockResolvedValue(undefined);
  const fetchPinned = vi.fn().mockResolvedValue(new Map());
  const send = vi.fn().mockResolvedValue({
    id: "posted-message-1",
    channelId: "channel-1",
    react,
    pin,
  });

  return {
    customId: "post-sync-time:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    client: { user: { id: "bot-1" } },
    guild: {
      id: "guild-1",
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
      channels: {
        fetch: vi.fn(),
      },
    },
    channel: {
      isTextBased: () => true,
      permissionsFor: vi.fn().mockReturnValue({
        has: vi.fn().mockReturnValue(true),
      }),
      messages: {
        fetchPinned,
      },
      send,
    },
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

describe("/sync time post command shape", () => {
  it("registers optional timezone autocomplete on the post subcommand", () => {
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
    const timezoneOption = postSubcommand?.options?.find(
      (option: { name: string }) => option.name === "timezone",
    );

    expect(roleOption?.required).toBe(false);
    expect(timezoneOption?.required).toBe(false);
    expect(timezoneOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(timezoneOption?.autocomplete).toBe(true);
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
});

describe("/sync time post modal submit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
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
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("America/Chicago"),
    );
  });

  it("renders sync post status with the shared spin-status renderer", async () => {
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
        getSubcommandGroup: vi.fn().mockReturnValue("post"),
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
