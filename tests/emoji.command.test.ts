import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, Client } from "discord.js";
import {
  Emoji,
  applyEmojiPageActionForTest,
  resetEmojiResolverForTest,
  setEmojiResolverForTest,
} from "../src/commands/Emoji";
import type {
  EmojiInventoryFetchResult,
  ResolvedApplicationEmoji,
} from "../src/services/emoji/EmojiResolverService";

type EmojiResolverStub = {
  fetchApplicationEmojiInventory: ReturnType<typeof vi.fn>;
};

/** Purpose: build minimal fake chat-input interaction for command unit tests. */
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
    guildId: "guild-1",
    user: { id: "user-1" },
    client: {} as Client,
    options: {
      getString: vi.fn((name: string) =>
        name === "name" ? (input?.name ?? null) : null,
      ),
    },
    deferReply,
    editReply,
    fetchReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply, fetchReply };
}

/** Purpose: build resolver stub for deterministic command behavior assertions. */
function buildResolverStub(): EmojiResolverStub {
  return {
    fetchApplicationEmojiInventory: vi.fn(),
  };
}

/** Purpose: create a successful inventory result from emoji entries for tests. */
function buildSuccessResult(
  emojis: ResolvedApplicationEmoji[],
): EmojiInventoryFetchResult {
  const exactByName = new Map<string, ResolvedApplicationEmoji>();
  const lowercaseByName = new Map<string, ResolvedApplicationEmoji>();
  for (const emoji of emojis) {
    if (!exactByName.has(emoji.name)) {
      exactByName.set(emoji.name, emoji);
    }
    const lower = emoji.name.toLowerCase();
    if (!lowercaseByName.has(lower)) {
      lowercaseByName.set(lower, emoji);
    }
  }
  return {
    ok: true,
    diagnostics: {
      applicationExistedBeforeFetch: true,
      applicationFetchAttempted: true,
      applicationEmojiFetchAvailable: true,
      emojiFetchSucceeded: true,
      fetchedEmojiCount: emojis.length,
    },
    snapshot: {
      fetchedAtMs: Date.now(),
      entries: emojis,
      exactByName,
      lowercaseByName,
    },
  };
}

/** Purpose: create a failed inventory result with resolver diagnostics for tests. */
function buildFailureResult(
  code: "application_emoji_manager_unavailable" | "application_emoji_fetch_failed",
): EmojiInventoryFetchResult {
  return {
    ok: false,
    code,
    diagnostics: {
      applicationExistedBeforeFetch: true,
      applicationFetchAttempted: true,
      applicationEmojiFetchAvailable: code !== "application_emoji_manager_unavailable",
      emojiFetchSucceeded: false,
      fetchedEmojiCount: 0,
    },
  };
}

describe("/emoji command", () => {
  afterEach(() => {
    resetEmojiResolverForTest();
    vi.restoreAllMocks();
  });

  it("supports name mode success", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildSuccessResult([
        {
          id: "1",
          name: "arrow_arrow",
          shortcode: ":arrow_arrow:",
          rendered: "<:arrow_arrow:1>",
          animated: false,
        },
      ]),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction({ name: "arrow_arrow" });

    await Emoji.run({} as Client, interaction, {} as any);

    expect(resolver.fetchApplicationEmojiInventory).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(String(json.description ?? "")).toContain(":arrow_arrow:");
  });

  it("supports name mode not found", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildSuccessResult([
        {
          id: "1",
          name: "arrow_arrow",
          shortcode: ":arrow_arrow:",
          rendered: "<:arrow_arrow:1>",
          animated: false,
        },
      ]),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction({ name: "not_real" });

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("No application emoji found");
  });

  it("renders list mode first page", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildSuccessResult([
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
      ]),
    );
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
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(buildSuccessResult([]));
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

  it("shows runtime-unavailable message when resolver reports manager unavailable", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildFailureResult("application_emoji_manager_unavailable"),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction();

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain(
      "Could not load bot application emojis in this runtime",
    );
  });

  it("shows retry message when resolver reports fetch failure", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildFailureResult("application_emoji_fetch_failed"),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction();

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain(
      "Could not fetch bot application emojis right now",
    );
  });
});
