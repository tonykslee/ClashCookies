import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Say, handleSayModalSubmit, isSayModalCustomId } from "../src/commands/Say";

beforeEach(() => {
  vi.restoreAllMocks();
});

function createChatInteraction(input: {
  userId?: string;
  text?: string | null;
  type?: string | null;
  showFrom?: boolean | null;
  isAdmin?: boolean;
  send?: ReturnType<typeof vi.fn>;
  reply?: ReturnType<typeof vi.fn>;
  showModal?: ReturnType<typeof vi.fn>;
}) {
  const send = input.send ?? vi.fn().mockResolvedValue({});
  const reply = input.reply ?? vi.fn().mockResolvedValue(undefined);
  const showModal = input.showModal ?? vi.fn().mockResolvedValue(undefined);
  const optionMap = new Map<string, string | null>([
    ["text", input.text ?? null],
    ["type", input.type ?? null],
  ]);
  const showFrom = input.showFrom ?? null;
  const isAdmin = input.isAdmin ?? false;

  return {
    inGuild: vi.fn(() => true),
    user: { id: input.userId ?? "user-1" },
    memberPermissions: {
      has: vi.fn(() => isAdmin),
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
  isAdmin?: boolean;
  values?: Record<string, string>;
  send?: ReturnType<typeof vi.fn>;
  deferReply?: ReturnType<typeof vi.fn>;
  editReply?: ReturnType<typeof vi.fn>;
  reply?: ReturnType<typeof vi.fn>;
}) {
  const values = input.values ?? {};
  const send = input.send ?? vi.fn().mockResolvedValue({});
  const deferReply = input.deferReply ?? vi.fn().mockResolvedValue(undefined);
  const editReply = input.editReply ?? vi.fn().mockResolvedValue(undefined);
  const reply = input.reply ?? vi.fn().mockResolvedValue(undefined);
  const isAdmin = input.isAdmin ?? false;

  return {
    customId: input.customId,
    user: { id: input.userId ?? "user-1" },
    memberPermissions: {
      has: vi.fn(() => isAdmin),
    },
    fields: {
      getTextInputValue: vi.fn((fieldId: string) => values[fieldId] ?? ""),
    },
    channel: {
      isTextBased: vi.fn(() => true),
      send,
    },
    deferReply,
    editReply,
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
  it("posts plain text with attribution by default", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "<@user-1> used `/say`\nHello alliance",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted message to channel.",
    });
  });

  it("allows admins to suppress attribution with show-from false", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
      showFrom: false,
      isAdmin: true,
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

  it("rejects non-admin show-from false attempts", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
      showFrom: false,
      isAdmin: false,
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only administrators can set `show-from:false`.",
    });
  });

  it("opens long-text modal when LONG_TEXT type is selected", async () => {
    const interaction = createChatInteraction({
      text: "prefill",
      type: "LONG_TEXT",
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.title).toBe("Say Long Text");
    expect(modal.components).toHaveLength(1);
    expect(modal.custom_id).toBe("say-modal:LONG_TEXT:user-1:1");
  });

  it("opens embed modal when EMBED type is selected", async () => {
    const interaction = createChatInteraction({
      text: "prefill body",
      type: "EMBED",
    });

    await Say.run({} as any, interaction as any, {} as any);

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.title).toBe("Say Embed");
    expect(modal.components).toHaveLength(3);
    expect(modal.custom_id).toBe("say-modal:EMBED:user-1:1");
  });

  it("encodes show-from false in modal custom IDs for admins", async () => {
    const interaction = createChatInteraction({
      text: "prefill body",
      type: "EMBED",
      showFrom: false,
      isAdmin: true,
    });

    await Say.run({} as any, interaction as any, {} as any);

    const modal = interaction.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal.custom_id).toBe("say-modal:EMBED:user-1:0");
  });
});

describe("/say modal submit", () => {
  it("posts long-text modal body with attribution when enabled", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1:1",
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "<@user-1> used `/say`\nLong text body content",
    });
    expect(interaction.editReply).toHaveBeenCalledWith("Posted message to channel.");
  });

  it("posts embed mode with attribution in message content", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1:1",
      values: {
        "say-embed-title": "Status",
        "say-embed-body": "Body",
        "say-embed-image-url": "",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    const payload = interaction.channel.send.mock.calls[0]?.[0] ?? {};
    expect(payload.content).toBe("<@user-1> used `/say`");
    expect(Array.isArray(payload.embeds)).toBe(true);
    expect(payload.embeds).toHaveLength(1);
  });

  it("suppresses attribution in modal submit when admin uses show-from false", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1:0",
      isAdmin: true,
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "Long text body content",
    });
  });

  it("rejects non-admin modal attempts to suppress attribution", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1:0",
      isAdmin: false,
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only administrators can set `show-from:false`.",
    });
  });

  it("rejects invalid embed image URL with an ephemeral modal error", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1:1",
      values: {
        "say-embed-title": "Status",
        "say-embed-body": "Body",
        "say-embed-image-url": "not-a-url",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Invalid image URL. Provide an absolute http:// or https:// URL."
    );
  });

  it("matches say modal custom ID prefixes", () => {
    expect(isSayModalCustomId("say-modal:LONG_TEXT:user-1:1")).toBe(true);
    expect(isSayModalCustomId("say-modal:EMBED:user-1:0")).toBe(true);
    expect(isSayModalCustomId("other-modal:EMBED:user-1")).toBe(false);
  });
});
