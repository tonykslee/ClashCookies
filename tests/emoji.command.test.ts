import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import {
  Emoji,
  applyEmojiPageActionForTest,
  resetEmojiResolverForTest,
  setEmojiResolverForTest,
} from "../src/commands/Emoji";

type EmojiResolverStub = {
  resolveByName: ReturnType<typeof vi.fn>;
  listApplicationEmojis: ReturnType<typeof vi.fn>;
};

function buildInteraction(input?: {
  name?: string | null;
}): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  fetchReply: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const fetchReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: vi.fn(),
  });
  const interaction = {
    id: "interaction-1",
    user: { id: "user-1" },
    client: {} as Client,
    options: {
      getString: vi.fn((name: string) => (name === "name" ? (input?.name ?? null) : null)),
    },
    deferReply,
    editReply,
    fetchReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply, fetchReply };
}

function buildResolverStub(): EmojiResolverStub {
  return {
    resolveByName: vi.fn(),
    listApplicationEmojis: vi.fn(),
  };
}

describe("/emoji command", () => {
  afterEach(() => {
    resetEmojiResolverForTest();
    vi.restoreAllMocks();
  });

  it("supports name mode success", async () => {
    const resolver = buildResolverStub();
    resolver.resolveByName.mockResolvedValue({
      id: "1",
      name: "arrow_arrow",
      shortcode: ":arrow_arrow:",
      rendered: "<:arrow_arrow:1>",
      animated: false,
    });
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction({ name: "arrow_arrow" });

    await Emoji.run({} as Client, interaction, {} as any);

    expect(resolver.resolveByName).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(String(json.description ?? "")).toContain(":arrow_arrow:");
  });

  it("supports name mode not found", async () => {
    const resolver = buildResolverStub();
    resolver.resolveByName.mockResolvedValue(null);
    resolver.listApplicationEmojis.mockResolvedValue([
      {
        id: "1",
        name: "arrow_arrow",
        shortcode: ":arrow_arrow:",
        rendered: "<:arrow_arrow:1>",
        animated: false,
      },
    ]);
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction({ name: "not_real" });

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("No application emoji found");
  });

  it("renders list mode first page", async () => {
    const resolver = buildResolverStub();
    resolver.listApplicationEmojis.mockResolvedValue([
      {
        id: "1",
        name: "alpha",
        shortcode: ":alpha:",
        rendered: "<:alpha:1>",
        animated: false,
      },
      {
        id: "2",
        name: "bravo",
        shortcode: ":bravo:",
        rendered: "<:bravo:2>",
        animated: false,
      },
    ]);
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply, fetchReply } = buildInteraction();

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(json.title).toBe("Bot Application Emojis");
    expect(String(json.description ?? "")).toContain(":alpha:");
    expect(fetchReply).not.toHaveBeenCalled();
  });

  it("supports pagination next/previous behavior", () => {
    expect(
      applyEmojiPageActionForTest({
        action: "next",
        page: 0,
        totalPages: 3,
      }),
    ).toBe(1);
    expect(
      applyEmojiPageActionForTest({
        action: "prev",
        page: 1,
        totalPages: 3,
      }),
    ).toBe(0);
    expect(
      applyEmojiPageActionForTest({
        action: "next",
        page: 2,
        totalPages: 3,
      }),
    ).toBe(2);
  });

  it("renders list mode empty state when no emojis are available", async () => {
    const resolver = buildResolverStub();
    resolver.listApplicationEmojis.mockResolvedValue([]);
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction();

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(String(json.description ?? "")).toContain(
      "No application emojis are currently available",
    );
    expect(payload.components ?? []).toEqual([]);
  });
});
