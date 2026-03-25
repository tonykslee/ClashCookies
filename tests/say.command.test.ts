import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Say, handleSayModalSubmit, isSayModalCustomId } from "../src/commands/Say";
import { BotLogChannelService } from "../src/services/BotLogChannelService";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue(null);
  vi.spyOn(BotLogChannelService.prototype, "clearChannelId").mockResolvedValue(undefined);
});

function createChatInteraction(input: {
  userId?: string;
  guildId?: string;
  channelId?: string;
  text?: string | null;
  type?: string | null;
  showFrom?: boolean | null;
  send?: ReturnType<typeof vi.fn>;
  channelFetch?: ReturnType<typeof vi.fn>;
  reply?: ReturnType<typeof vi.fn>;
  showModal?: ReturnType<typeof vi.fn>;
}) {
  const send = input.send ?? vi.fn().mockResolvedValue({});
  const channelFetch = input.channelFetch ?? vi.fn().mockResolvedValue(null);
  const reply = input.reply ?? vi.fn().mockResolvedValue(undefined);
  const showModal = input.showModal ?? vi.fn().mockResolvedValue(undefined);
  const optionMap = new Map<string, string | null>([
    ["text", input.text ?? null],
    ["type", input.type ?? null],
  ]);
  const showFrom = input.showFrom ?? null;

  return {
    inGuild: vi.fn(() => true),
    guildId: input.guildId ?? "guild-1",
    channelId: input.channelId ?? "source-channel-1",
    user: { id: input.userId ?? "user-1" },
    client: {
      channels: {
        fetch: channelFetch,
      },
    },
    channel: {
      isTextBased: vi.fn(() => true),
      send,
    },
    options: {
      getString: vi.fn((name: string) => optionMap.get(name) ?? null),
      getBoolean: vi.fn((name: string) => (name === "show-from" ? showFrom : null)),
    },
    reply,
    showModal,
  };
}

function createModalInteraction(input: {
  customId: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
  values?: Record<string, string>;
  send?: ReturnType<typeof vi.fn>;
  channelFetch?: ReturnType<typeof vi.fn>;
  reply?: ReturnType<typeof vi.fn>;
}) {
  const values = input.values ?? {};
  const send = input.send ?? vi.fn().mockResolvedValue({});
  const channelFetch = input.channelFetch ?? vi.fn().mockResolvedValue(null);
  const reply = input.reply ?? vi.fn().mockResolvedValue(undefined);

  return {
    customId: input.customId,
    guildId: input.guildId ?? "guild-1",
    channelId: input.channelId ?? "source-channel-1",
    user: { id: input.userId ?? "user-1" },
    client: {
      channels: {
        fetch: channelFetch,
      },
    },
    fields: {
      getTextInputValue: vi.fn((fieldId: string) => values[fieldId] ?? ""),
    },
    channel: {
      isTextBased: vi.fn(() => true),
      send,
    },
    reply,
  };
}

describe("/say command shape", () => {
  it("registers text, type, and show-from options", () => {
    const text = Say.options?.find((option) => option.name === "text");
    const type = Say.options?.find((option) => option.name === "type");
    const showFrom = Say.options?.find((option) => option.name === "show-from");

    expect(text?.type).toBe(ApplicationCommandOptionType.String);
    expect(text?.required).toBe(false);

    expect(type?.type).toBe(ApplicationCommandOptionType.String);
    expect(type?.required).toBe(false);
    expect(type?.choices).toEqual([
      { name: "LONG_TEXT", value: "LONG_TEXT" },
      { name: "EMBED", value: "EMBED" },
    ]);

    expect(showFrom?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(showFrom?.required).toBe(false);
  });
});

describe("/say behavior", () => {
  it("uses interaction response path for show-from=true plain text", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
      showFrom: null,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Hello alliance",
    });
  });

  it("uses channel-send + ephemeral confirmation for show-from=false", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
      showFrom: false,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "Hello alliance",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted message to channel.",
    });
  });

  it("logs hidden-source plain text posts when a bot-log channel is configured", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue("log-channel-1");
    const botLogSend = vi.fn().mockResolvedValue({});
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
      showFrom: false,
      channelFetch: vi.fn().mockResolvedValue({
        guildId: "guild-1",
        isTextBased: () => true,
        send: botLogSend,
      }),
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "Hello alliance",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted message to channel.",
    });
    expect(botLogSend).toHaveBeenCalledTimes(1);
    const payload = botLogSend.mock.calls[0]?.[0] ?? {};
    expect(payload.content).toContain("Hidden `/say` post");
    expect(payload.content).toContain("Mode: TEXT");
    expect(payload.content).toContain("Hello alliance");
  });

  it("opens long-text modal with show-from=true state", async () => {
    const interaction = createChatInteraction({
      text: "prefill",
      type: "LONG_TEXT",
      showFrom: null,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.custom_id).toBe("say-modal:LONG_TEXT:user-1:1");
  });

  it("opens embed modal with show-from=false state", async () => {
    const interaction = createChatInteraction({
      text: "prefill body",
      type: "EMBED",
      showFrom: false,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.custom_id).toBe("say-modal:EMBED:user-1:0");
  });
});

describe("/say modal submit", () => {
  it("uses interaction response path for show-from=true LONG_TEXT", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1:1",
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Long text body content",
    });
  });

  it("uses interaction response path for show-from=true EMBED", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1:1",
      values: {
        "say-embed-title": "Status",
        "say-embed-body": "Body",
        "say-embed-image-url": "",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0]?.[0] ?? {};
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.ephemeral).toBeUndefined();
  });

  it("uses channel-send + ephemeral confirmation for show-from=false modal", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1:0",
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "Long text body content",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted message to channel.",
    });
  });

  it("logs hidden-source embed modal posts when a bot-log channel is configured", async () => {
    vi.spyOn(BotLogChannelService.prototype, "getChannelId").mockResolvedValue("log-channel-1");
    const botLogSend = vi.fn().mockResolvedValue({});
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1:0",
      values: {
        "say-embed-title": "Status",
        "say-embed-body": "Body",
        "say-embed-image-url": "https://img.example.com/a.png",
      },
      channelFetch: vi.fn().mockResolvedValue({
        guildId: "guild-1",
        isTextBased: () => true,
        send: botLogSend,
      }),
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted message to channel.",
    });
    const payload = botLogSend.mock.calls[0]?.[0] ?? {};
    expect(payload.content).toContain("Mode: EMBED");
    expect(payload.content).toContain("Status");
    expect(payload.content).toContain("Body");
    expect(payload.content).toContain("https://img.example.com/a.png");
  });

  it("rejects invalid embed image URL with ephemeral error", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1:1",
      values: {
        "say-embed-title": "Status",
        "say-embed-body": "Body",
        "say-embed-image-url": "not-a-url",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Invalid image URL. Provide an absolute http:// or https:// URL.",
    });
  });

  it("matches say modal custom ID prefixes", () => {
    expect(isSayModalCustomId("say-modal:LONG_TEXT:user-1:1")).toBe(true);
    expect(isSayModalCustomId("say-modal:EMBED:user-1:0")).toBe(true);
    expect(isSayModalCustomId("other-modal:EMBED:user-1")).toBe(false);
  });
});
