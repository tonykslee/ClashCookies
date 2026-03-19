import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  PermissionResolvable,
} from "discord.js";
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

/** Purpose: build minimal fake chat-input interaction for command unit tests. */
function buildInteraction(input?: {
  name?: string | null;
  react?: string | null;
  messageFetchError?: unknown;
  reactionError?: unknown;
  appPermissionHas?: (permission: PermissionResolvable) => boolean;
}): {
  interaction: ChatInputCommandInteraction;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  fetchReply: ReturnType<typeof vi.fn>;
  messageFetch: ReturnType<typeof vi.fn>;
  messageReact: ReturnType<typeof vi.fn>;
} {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const fetchReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: vi.fn(),
  });

  const messageReact = vi.fn();
  if (input?.reactionError) {
    messageReact.mockRejectedValue(input.reactionError);
  } else {
    messageReact.mockResolvedValue(undefined);
  }

  const messageFetch = vi.fn();
  if (input?.messageFetchError) {
    messageFetch.mockRejectedValue(input.messageFetchError);
  } else {
    messageFetch.mockResolvedValue({ react: messageReact });
  }

  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    client: {} as Client,
    appPermissions: {
      has: vi.fn((permission: PermissionResolvable) =>
        input?.appPermissionHas ? input.appPermissionHas(permission) : true,
      ),
    },
    channel: {
      isTextBased: () => true,
      messages: {
        fetch: messageFetch,
      },
    },
    options: {
      getString: vi.fn((name: string) => {
        if (name === "name") return input?.name ?? null;
        if (name === "react") return input?.react ?? null;
        return null;
      }),
    },
    deferReply,
    editReply,
    fetchReply,
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    deferReply,
    editReply,
    fetchReply,
    messageFetch,
    messageReact,
  };
}

/** Purpose: build minimal autocomplete interaction for command autocomplete tests. */
function buildAutocompleteInteraction(input?: {
  focusedName?: string;
  focusedValue?: string;
}): {
  interaction: AutocompleteInteraction;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    client: {} as Client,
    options: {
      getFocused: vi.fn(() => ({
        name: input?.focusedName ?? "name",
        value: input?.focusedValue ?? "",
      })),
    },
    respond,
  } as unknown as AutocompleteInteraction;
  return { interaction, respond };
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

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(String(json.description ?? "")).toContain(":arrow_arrow:");
  });

  it("supports name mode with colon-wrapped input", async () => {
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
    const { interaction, editReply } = buildInteraction({ name: ":arrow_arrow:" });

    await Emoji.run({} as Client, interaction, {} as any);

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
    expect(String(payload.content ?? "")).toContain(
      "Could not find an application emoji named",
    );
  });

  it("rejects invalid empty name input", async () => {
    const resolver = buildResolverStub();
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply } = buildInteraction({ name: "   " });

    await Emoji.run({} as Client, interaction, {} as any);

    expect(resolver.fetchApplicationEmojiInventory).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("Please provide a valid emoji name");
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

  it("ignores react when name is omitted and keeps list mode", async () => {
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
      ]),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, editReply, messageFetch } = buildInteraction({
      react: "123456789012345678",
    });

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    const embed = payload.embeds?.[0];
    const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed?.data ?? {};
    expect(json.title).toBe("Bot Application Emojis");
    expect(messageFetch).not.toHaveBeenCalled();
  });

  it("supports react mode success", async () => {
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
    const { interaction, editReply, messageFetch, messageReact } = buildInteraction({
      name: "arrow_arrow",
      react: "123456789012345678",
    });

    await Emoji.run({} as Client, interaction, {} as any);

    expect(messageFetch).toHaveBeenCalledWith("123456789012345678");
    expect(messageReact).toHaveBeenCalledWith("<:arrow_arrow:1>");
    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("Reacted to message");
  });

  it("rejects invalid message id before fetch", async () => {
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
    const { interaction, editReply, messageFetch } = buildInteraction({
      name: "arrow_arrow",
      react: "abc",
    });

    await Emoji.run({} as Client, interaction, {} as any);

    expect(messageFetch).not.toHaveBeenCalled();
    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("Please provide a valid message ID");
  });

  it("shows message-not-found error when current-channel fetch fails", async () => {
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
    const { interaction, editReply } = buildInteraction({
      name: "arrow_arrow",
      react: "123456789012345678",
      messageFetchError: new Error("missing"),
    });

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain("Could not find message");
  });

  it("shows permission error when reaction is denied", async () => {
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
    const { interaction, editReply } = buildInteraction({
      name: "arrow_arrow",
      react: "123456789012345678",
      reactionError: { code: 50013 },
    });

    await Emoji.run({} as Client, interaction, {} as any);

    const payload = editReply.mock.calls[0]?.[0] ?? {};
    expect(String(payload.content ?? "")).toContain(
      "I do not have permission to add that reaction",
    );
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
      "Could not load application emojis right now",
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
      "Could not fetch application emojis right now",
    );
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
});

describe("/emoji autocomplete", () => {
  afterEach(() => {
    resetEmojiResolverForTest();
    vi.restoreAllMocks();
  });

  it("returns prefix matches from application emoji inventory", async () => {
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
        {
          id: "2",
          name: "shield",
          shortcode: ":shield:",
          rendered: "<:shield:2>",
          animated: false,
        },
      ]),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedValue: "arr",
    });

    await Emoji.autocomplete?.(interaction);

    const payload = respond.mock.calls[0]?.[0] ?? [];
    expect(payload).toEqual([
      { name: "<:arrow_arrow:1> :arrow_arrow:", value: "arrow_arrow" },
    ]);
  });

  it("supports colon-prefixed autocomplete input", async () => {
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
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedValue: ":arr",
    });

    await Emoji.autocomplete?.(interaction);

    const payload = respond.mock.calls[0]?.[0] ?? [];
    expect(payload[0]).toEqual({
      name: "<:arrow_arrow:1> :arrow_arrow:",
      value: "arrow_arrow",
    });
  });

  it("orders autocomplete by exact, then prefix, then contains", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildSuccessResult([
        {
          id: "1",
          name: "xarrz",
          shortcode: ":xarrz:",
          rendered: "<:xarrz:1>",
          animated: false,
        },
        {
          id: "2",
          name: "arr",
          shortcode: ":arr:",
          rendered: "<:arr:2>",
          animated: false,
        },
        {
          id: "3",
          name: "arrow_arrow",
          shortcode: ":arrow_arrow:",
          rendered: "<:arrow_arrow:3>",
          animated: false,
        },
      ]),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedValue: "arr",
    });

    await Emoji.autocomplete?.(interaction);

    const payload = respond.mock.calls[0]?.[0] ?? [];
    expect(payload.map((entry: { value: string }) => entry.value)).toEqual([
      "arr",
      "arrow_arrow",
      "xarrz",
    ]);
  });

  it("caps autocomplete results to Discord max choices", async () => {
    const resolver = buildResolverStub();
    const emojis: ResolvedApplicationEmoji[] = [];
    for (let i = 0; i < 40; i += 1) {
      emojis.push({
        id: String(i + 1),
        name: `arrow_${String(i + 1).padStart(2, "0")}`,
        shortcode: `:arrow_${String(i + 1).padStart(2, "0")}:`,
        rendered: `<:arrow_${String(i + 1).padStart(2, "0")}:${i + 1}>`,
        animated: false,
      });
    }
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(buildSuccessResult(emojis));
    setEmojiResolverForTest(resolver as any);
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedValue: "arrow_",
    });

    await Emoji.autocomplete?.(interaction);

    const payload = respond.mock.calls[0]?.[0] ?? [];
    expect(payload).toHaveLength(25);
  });

  it("returns empty suggestions when inventory is unavailable", async () => {
    const resolver = buildResolverStub();
    resolver.fetchApplicationEmojiInventory.mockResolvedValue(
      buildFailureResult("application_emoji_manager_unavailable"),
    );
    setEmojiResolverForTest(resolver as any);
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedValue: "arr",
    });

    await Emoji.autocomplete?.(interaction);

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("returns empty suggestions for non-name focused option", async () => {
    const resolver = buildResolverStub();
    setEmojiResolverForTest(resolver as any);
    const { interaction, respond } = buildAutocompleteInteraction({
      focusedName: "react",
      focusedValue: "123",
    });

    await Emoji.autocomplete?.(interaction);

    expect(resolver.fetchApplicationEmojiInventory).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith([]);
  });
});
