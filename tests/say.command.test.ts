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

  return {
    inGuild: vi.fn(() => true),
    user: { id: input.userId ?? "user-1" },
    channel: {
      isTextBased: vi.fn(() => true),
      send,
    },
    options: {
      getString: vi.fn((name: string) => optionMap.get(name) ?? null),
    },
    reply,
    showModal,
  };
}

function createModalInteraction(input: {
  customId: string;
  userId?: string;
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

  return {
    customId: input.customId,
    user: { id: input.userId ?? "user-1" },
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
  it("registers text and type options", () => {
    const text = Say.options?.find((option) => option.name === "text");
    const type = Say.options?.find((option) => option.name === "type");

    expect(text?.type).toBe(ApplicationCommandOptionType.String);
    expect(text?.required).toBe(false);

    expect(type?.type).toBe(ApplicationCommandOptionType.String);
    expect(type?.required).toBe(false);
    expect(type?.choices).toEqual([
      { name: "LONG_TEXT", value: "LONG_TEXT" },
      { name: "EMBED", value: "EMBED" },
    ]);
  });
});

describe("/say behavior", () => {
  it("posts plain text immediately when only text is provided", async () => {
    const interaction = createChatInteraction({
      text: "Hello alliance",
      type: null,
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
    expect(modal.custom_id).toBe("say-modal:LONG_TEXT:user-1");
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
    expect(modal.custom_id).toBe("say-modal:EMBED:user-1");
  });
});

describe("/say modal submit", () => {
  it("posts long-text modal body as a channel message", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:LONG_TEXT:user-1",
      values: {
        "say-long-text-body": "Long text body content",
      },
    });

    await handleSayModalSubmit(interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: "Long text body content",
    });
    expect(interaction.editReply).toHaveBeenCalledWith("Posted message to channel.");
  });

  it("rejects invalid embed image URL with an ephemeral modal error", async () => {
    const interaction = createModalInteraction({
      customId: "say-modal:EMBED:user-1",
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
    expect(isSayModalCustomId("say-modal:LONG_TEXT:user-1")).toBe(true);
    expect(isSayModalCustomId("say-modal:EMBED:user-1")).toBe(true);
    expect(isSayModalCustomId("other-modal:EMBED:user-1")).toBe(false);
  });
});
