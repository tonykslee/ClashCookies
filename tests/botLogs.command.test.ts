import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotLogs } from "../src/commands/BotLogs";
import { BotLogChannelService } from "../src/services/BotLogChannelService";

type TestInteractionInput = {
  guildId?: string;
  isAdmin?: boolean;
  type?: string | null;
  setChannel?: { id: string; guildId?: string; type?: number } | null;
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
      getString: vi.fn((name: string) =>
        name === "type" ? (input.type ?? null) : null
      ),
      getChannel: vi.fn((name: string) =>
        name === "set-channel" ? (input.setChannel ?? null) : null
      ),
    },
    reply,
  };
}

describe("/bot-logs command shape", () => {
  it("registers optional type and set-channel options", () => {
    const typeOption = BotLogs.options?.find((option) => option.name === "type");
    const setChannelOption = BotLogs.options?.find(
      (option) => option.name === "set-channel"
    );

    expect(typeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(typeOption?.required).toBe(false);
    expect(typeOption?.choices).toEqual([
      { name: "base-swap", value: "base-swap" },
      { name: "maintenance", value: "maintenance" },
    ]);
    expect(setChannelOption?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(setChannelOption?.required).toBe(false);
    expect(setChannelOption?.channel_types).toEqual([
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
  });

  it("saves provided channel for the current guild and confirms ephemerally", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(null);
    const interaction = createInteraction({
      guildId: "111",
      setChannel: {
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
    const interaction = createInteraction({
      guildId: "111",
      type: "base-swap",
      setChannel: {
        id: "222222222222222222",
        guildId: "111",
        type: ChannelType.GuildText,
      },
      isAdmin: true,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelIdForType).toHaveBeenCalledWith(
      "111",
      "base-swap",
      "222222222222222222",
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Base-swap bot-log channel saved: <#222222222222222222>.",
    });
  });

  it("saves maintenance typed channel when type is provided", async () => {
    const setChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "setChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      guildId: "111",
      type: "maintenance",
      setChannel: {
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

  it("returns the configured channel mention when no set-channel is provided", async () => {
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

  it("returns the configured base-swap channel mention when no set-channel is provided", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "333333333333333333",
    );
    const interaction = createInteraction({
      type: "base-swap",
      cacheChannelId: "333333333333333333",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Current base-swap bot-log channel: <#333333333333333333>.",
    });
  });

  it("returns the configured maintenance channel mention when no set-channel is provided", async () => {
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
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(null);
    const interaction = createInteraction({
      type: "base-swap",
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No base-swap bot-log channel is configured yet.",
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
        "I cleared the saved setting. Set a new one with `/bot-logs set-channel`.",
    });
  });

  it("clears stale base-swap config when saved channel no longer exists", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "444444444444444444",
    );
    const clearChannelIdForType = vi
      .spyOn(BotLogChannelService.prototype, "clearChannelIdForType")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      type: "base-swap",
      fetchChannel: null,
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(clearChannelIdForType).toHaveBeenCalledWith("100", "base-swap");
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Configured base-swap bot-log channel <#444444444444444444> no longer exists. " +
        "I cleared the saved setting. Set a new one with `/bot-logs type:base-swap set-channel`.",
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
        "I cleared the saved setting. Set a new one with `/bot-logs type:maintenance set-channel`.",
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
        "Set a new one with `/bot-logs set-channel`.",
    });
  });

  it("reports inaccessible configured base-swap channels without crashing", async () => {
    vi.mocked(BotLogChannelService.prototype.getChannelIdForType).mockResolvedValue(
      "555555555555555555",
    );
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
        "Configured base-swap bot-log channel <#555555555555555555> is no longer accessible. " +
        "Set a new one with `/bot-logs type:base-swap set-channel`.",
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
        "Set a new one with `/bot-logs type:maintenance set-channel`.",
    });
  });

  it("blocks non-admin users", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      isAdmin: false,
      setChannel: {
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

  it("rejects set-channel from another guild", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      guildId: "100",
      setChannel: {
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

  it("rejects unsupported channel types for set-channel", async () => {
    const setChannelId = vi
      .spyOn(BotLogChannelService.prototype, "setChannelId")
      .mockResolvedValue(undefined);
    const interaction = createInteraction({
      setChannel: {
        id: "888888888888888888",
        guildId: "100",
        type: ChannelType.GuildVoice,
      },
    });

    await BotLogs.run({} as any, interaction as any, {} as any);

    expect(setChannelId).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Selected channel must be a server text, announcement, or thread channel.",
    });
  });
});
