import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotLogs } from "../src/commands/BotLogs";
import { BotLogChannelService } from "../src/services/BotLogChannelService";
import { SettingsService } from "../src/services/SettingsService";

type TestInteractionInput = {
  guildId?: string;
  isAdmin?: boolean;
  type?: string | null;
  enable?: string | null;
  channel?: { id: string; guildId?: string; type?: number } | null;
  cacheChannelId?: string | null;
  fetchChannel?: unknown;
  fetchError?: unknown;
};

/** Purpose: build a mock chat interaction for /bot-logs command tests. */
function createInteraction(input: TestInteractionInput = {}) {
  const guildId = input.guildId ?? "100";
  const reply = vi.fn().mockResolvedValue(undefined);
  const fetch = input.fetchError
    ? vi.fn().mockRejectedValue(input.fetchError)
    : vi.fn().mockResolvedValue(input.fetchChannel ?? null);
  const channelCache = new Map<string, unknown>();
  if (input.cacheChannelId) {
    channelCache.set(input.cacheChannelId, { id: input.cacheChannelId });
  }

  return {
    inGuild: vi.fn().mockReturnValue(true),
    guildId,
    guild: {
      channels: {
        cache: channelCache,
        fetch,
      },
    },
    memberPermissions: {
      has: vi.fn().mockReturnValue(input.isAdmin ?? true),
    },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "enable") return input.enable ?? null;
        return null;
      }),
      getChannel: vi.fn((name: string) => {
        if (name === "channel") return input.channel ?? null;
        return null;
      }),
    },
    reply,
  };
}

describe("/bot-logs command shape", () => {
  it("registers optional type, base-swap enable, and a single channel option", () => {
    const typeOption = BotLogs.options?.find((option) => option.name === "type");
    const setChannelOption = BotLogs.options?.find(
      (option) => option.name === "set-channel"
    );
    const enableOption = BotLogs.options?.find((option) => option.name === "enable");
    const channelOption = BotLogs.options?.find((option) => option.name === "channel");

    expect(typeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(typeOption?.required).toBe(false);
    expect(typeOption?.choices).toEqual([
      { name: "base-swap", value: "base-swap" },
      { name: "maintenance", value: "maintenance" },
      { name: "sync", value: "sync" },
      { name: "checklist", value: "checklist" },
    ]);
    expect(setChannelOption).toBeUndefined();
    expect(enableOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(enableOption?.required).toBe(false);
    expect(enableOption?.choices).toEqual([
      { name: "clan-log channel", value: "clan-log channel" },
      { name: "clan-lead channel", value: "clan-lead channel" },
      { name: "bot-log channel", value: "bot-log channel" },
      { name: "custom", value: "custom" },
      { name: "false", value: "false" },
    ]);
    expect(channelOption?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(channelOption?.required).toBe(false);
    expect(channelOption?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
    ]);
  });
});

describe("/bot-logs behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(BotLogChannelService.prototype, "getChannelIdForType").mockResolvedValue(null);
    vi.spyOn(BotLogChannelService.prototype, "getBaseSwapRoutingConfig").mockResolvedValue(null);
    vi.spyOn(BotLogChannelService.prototype, "setBaseSwapRoutingConfig").mockResolvedValue(undefined);
    vi.spyOn(SettingsService.prototype, "delete").mockResolvedValue(undefined);
  });

  it("saves provided channel for the current guild and confirms ephemerally", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(null);
    const interaction = createInteraction({
      guildId: "111",
      channel: {
        id: "222222222222222222",
        guildId: "111",
        type: ChannelType.GuildText,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelId).toHaveBeenCalledWith("111", "222222222222222222");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Bot-log channel saved: <#222222222222222222>.",
    });
  });

  it("saves base-swap typed channel when type is provided", async () => {
    const setChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "setChannelIdForType")
      .mockResolvedValue(undefined);
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      guildId: "111",
      type: "base-swap",
      channel: {
        id: "222222222222222222",
        guildId: "111",
        type: ChannelType.GuildText,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).toHaveBeenCalledWith({
      guildId: "111",
      routingMode: "CUSTOM",
      channelId: "222222222222222222",
    });
    expect(setChannelIdForType).toHaveBeenCalledWith(
      "111",
      "base-swap",
      "222222222222222222",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Base-swap audit-log routing saved: custom <#222222222222222222>.",
    });
  });

  it("saves base-swap audit routing from enable choices", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      guildId: "111",
      type: "base-swap",
      enable: "clan-lead channel",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).toHaveBeenCalledWith({
      guildId: "111",
      routingMode: "CLAN_LEAD",
      channelId: null,
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Base-swap audit-log routing saved: clan-lead channel.",
    });
  });

  it("saves disabled base-swap audit routing", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      guildId: "111",
      type: "base-swap",
      enable: "false",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).toHaveBeenCalledWith({
      guildId: "111",
      routingMode: "DISABLED",
      channelId: null,
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Base-swap audit-log routing saved: false.",
    });
  });

  it("saves custom base-swap audit routing only when a channel is provided", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      guildId: "111",
      type: "base-swap",
      enable: "custom",
      channel: {
        id: "555555555555555555",
        guildId: "111",
        type: ChannelType.GuildText,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).toHaveBeenCalledWith({
      guildId: "111",
      routingMode: "CUSTOM",
      channelId: "555555555555555555",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Base-swap audit-log routing saved: custom <#555555555555555555>.",
    });
  });

  it("rejects custom base-swap audit routing without a channel", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      type: "base-swap",
      enable: "custom",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "`enable:custom` requires `channel`.",
    });
  });

  it("rejects base-swap custom channel unless enable is custom", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      type: "base-swap",
      enable: "bot-log channel",
      channel: {
        id: "555555555555555555",
        guildId: "100",
        type: ChannelType.GuildText,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "`channel` is only valid with `type:base-swap enable:custom`.",
    });
  });

  it("rejects enable outside type:base-swap", async () => {
    const setBaseSwapRoutingConfig = vi.mocked(
      BotLogChannelService.prototype.setBaseSwapRoutingConfig,
    );
    const interaction = createInteraction({
      type: "maintenance",
      enable: "false",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setBaseSwapRoutingConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "`enable` is only supported with `type:base-swap`.",
    });
  });

  it("saves maintenance typed channel when type is provided", async () => {
    const setChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "setChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      guildId: "111",
      type: "maintenance",
      channel: {
        id: "333333333333333333",
        guildId: "111",
        type: ChannelType.GuildText,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelIdForType).toHaveBeenCalledWith(
      "111",
      "maintenance",
      "333333333333333333",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Maintenance bot-log channel saved: <#333333333333333333>.",
    });
  });

  it("saves sync typed channel with the preferred channel option", async () => {
    const setChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "setChannelIdForType")
      .mockResolvedValue(undefined);
    const deleteLegacy = vi.mocked(SettingsService.prototype.delete);
    const interaction = createInteraction({
      guildId: "111",
      type: "sync",
      channel: {
        id: "444444444444444444",
        guildId: "111",
        type: ChannelType.GuildText,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelIdForType).toHaveBeenCalledWith(
      "111",
      "sync",
      "444444444444444444",
    );
    expect(deleteLegacy).toHaveBeenCalledWith("guild_sync_post_channel:111");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Sync bot-log channel saved: <#444444444444444444>.",
    });
  });

  it("saves checklist typed channel with the channel option", async () => {
    const setChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "setChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      guildId: "111",
      type: "checklist",
      channel: {
        id: "555555555555555555",
        guildId: "111",
        type: ChannelType.GuildAnnouncement,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelIdForType).toHaveBeenCalledWith(
      "111",
      "checklist",
      "555555555555555555",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Checklist bot-log channel saved: <#555555555555555555>.",
    });
  });

  it("returns the configured channel mention when no update args are provided", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "333333333333333333"
    );
    const interaction = createInteraction({
      cacheChannelId: "333333333333333333",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current bot-log channel: <#333333333333333333>.",
    });
  });

  it("returns the configured base-swap channel mention when no update args are provided", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "333333333333333333",
      legacy: false,
    });
    const interaction = createInteraction({
      type: "base-swap",
      cacheChannelId: "333333333333333333",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current base-swap audit-log routing: custom <#333333333333333333>.",
    });
  });

  it("returns non-custom base-swap audit routing when configured", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CLAN_LOG",
      channelId: null,
      legacy: false,
    });
    const interaction = createInteraction({
      type: "base-swap",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current base-swap audit-log routing: clan-log channel.",
    });
  });

  it("returns the configured maintenance channel mention when no update args are provided", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "444444444444444444",
    );
    const interaction = createInteraction({
      type: "maintenance",
      cacheChannelId: "444444444444444444",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current maintenance bot-log channel: <#444444444444444444>.",
    });
  });

  it("returns the configured sync channel mention when no update args are provided", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "444444444444444444",
    );
    const interaction = createInteraction({
      type: "sync",
      cacheChannelId: "444444444444444444",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current sync bot-log channel: <#444444444444444444>.",
    });
  });

  it("returns the configured checklist channel mention when no update args are provided", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "555555555555555555",
    );
    const interaction = createInteraction({
      type: "checklist",
      cacheChannelId: "555555555555555555",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current checklist bot-log channel: <#555555555555555555>.",
    });
  });

  it("returns no-config message when no channel is configured", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(null);
    const interaction = createInteraction();

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No bot-log channel is configured yet.",
    });
  });

  it("returns no-config message when no base-swap channel is configured", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue(null);
    const interaction = createInteraction({
      type: "base-swap",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Base-swap audit-log routing is using the default: typed base-swap bot-log channel if configured, otherwise generic bot-log channel.",
    });
  });

  it("returns no-config message when no maintenance channel is configured", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(null);
    const interaction = createInteraction({
      type: "maintenance",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No maintenance bot-log channel is configured yet.",
    });
  });

  it("returns no-config message when no sync channel is configured", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(null);
    const interaction = createInteraction({
      type: "sync",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No sync bot-log channel is configured yet.",
    });
  });

  it("returns no-config message when no checklist channel is configured", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(null);
    const interaction = createInteraction({
      type: "checklist",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No checklist bot-log channel is configured yet.",
    });
  });

  it("clears stale config when saved channel no longer exists", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "444444444444444444"
    );
    const clearChannelId = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelId).toHaveBeenCalledWith("100");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured bot-log channel <#444444444444444444> no longer exists. " +
        "I cleared the saved setting. Set a new one with `/bot-logs channel:<channel>`.",
    });
  });

  it("clears stale base-swap config when saved channel no longer exists", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "444444444444444444",
      legacy: false,
    });
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const clearBaseSwapRoutingConfig = vi
      .spyOn(BotLogChannelService.prototype, "clearBaseSwapRoutingConfig")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "base-swap",
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearBaseSwapRoutingConfig).toHaveBeenCalledWith("100");
    expect(clearChannelIdForType).toHaveBeenCalledWith("100", "base-swap");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured base-swap audit-log channel <#444444444444444444> no longer exists. " +
        "Set a new one with `/bot-logs type:base-swap enable:custom channel:<channel>`.",
    });
  });

  it("clears stale maintenance config when saved channel no longer exists", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "444444444444444444",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "maintenance",
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).toHaveBeenCalledWith("100", "maintenance");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured maintenance bot-log channel <#444444444444444444> no longer exists. " +
        "I cleared the saved setting. Set a new one with `/bot-logs type:maintenance channel:<channel>`.",
    });
  });

  it("clears stale sync config without touching other typed settings", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "444444444444444444",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "sync",
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).toHaveBeenCalledWith("100", "sync");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "maintenance");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "base-swap");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "checklist");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured sync bot-log channel <#444444444444444444> no longer exists. " +
        "I cleared the saved setting. Set a new one with `/bot-logs type:sync channel:<channel>`.",
    });
  });

  it("clears stale checklist config without touching other typed settings", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "555555555555555555",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "checklist",
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).toHaveBeenCalledWith("100", "checklist");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "maintenance");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "sync");
    expect(clearChannelIdForType).not.toHaveBeenCalledWith("100", "base-swap");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured checklist bot-log channel <#555555555555555555> no longer exists. " +
        "I cleared the saved setting. Set a new one with `/bot-logs type:checklist channel:<channel>`.",
    });
  });

  it("reports inaccessible configured channels without crashing", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(
      "555555555555555555"
    );
    const clearChannelId = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      fetchError: { code: 50013 },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured bot-log channel <#555555555555555555> is no longer accessible. " +
        "Set a new one with `/bot-logs channel:<channel>`.",
    });
  });

  it("reports inaccessible configured base-swap channels without crashing", async () => {
    vi.mocked(BotLogChannelService.prototype.getBaseSwapRoutingConfig).mockResolvedValue({
      routingMode: "CUSTOM",
      channelId: "555555555555555555",
      legacy: false,
    });
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "base-swap",
      fetchError: { code: 50013 },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured base-swap audit-log channel <#555555555555555555> is no longer accessible. " +
        "Set a new one with `/bot-logs type:base-swap enable:custom channel:<channel>`.",
    });
  });

  it("reports inaccessible configured maintenance channels without crashing", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "555555555555555555",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "maintenance",
      fetchError: { code: 50013 },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured maintenance bot-log channel <#555555555555555555> is no longer accessible. " +
        "Set a new one with `/bot-logs type:maintenance channel:<channel>`.",
    });
  });

  it("reports inaccessible configured checklist channels without crashing", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "666666666666666666",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "checklist",
      fetchError: { code: 50013 },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured checklist bot-log channel <#666666666666666666> is no longer accessible. " +
        "Set a new one with `/bot-logs type:checklist channel:<channel>`.",
    });
  });

  it("blocks non-admin users", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      isAdmin: false,
      channel: {
        id: "666666666666666666",
        guildId: "100",
        type: ChannelType.GuildText,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "You do not have permission to use /bot-logs.",
    });
  });

  it("rejects channel from another guild", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      guildId: "100",
      channel: {
        id: "777777777777777777",
        guildId: "999",
        type: ChannelType.GuildText,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Selected channel must belong to this server.",
    });
  });

  it("rejects unsupported channel types for generic channel", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      channel: {
        id: "888888888888888888",
        guildId: "100",
        type: ChannelType.GuildVoice,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Selected channel must be a server text or announcement channel.",
    });
  });
});
