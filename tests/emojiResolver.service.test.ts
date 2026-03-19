import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import {
  EmojiResolverService,
  isValidEmojiShortcodeName,
  normalizeEmojiShortcodeName,
  parseEmojiImageSource,
} from "../src/services/emoji/EmojiResolverService";

type FakeAppEmoji = {
  id: string;
  name: string;
  animated: boolean;
  toString: () => string;
};

type FakeApplication = {
  fetch: ReturnType<typeof vi.fn>;
  emojis?: {
    fetch?: ReturnType<typeof vi.fn>;
  };
};

/** Purpose: build deterministic fake app emoji objects with Discord-like string rendering. */
function buildFakeEmoji(input: {
  id: string;
  name: string;
  animated?: boolean;
}): FakeAppEmoji {
  const animated = Boolean(input.animated);
  return {
    id: input.id,
    name: input.name,
    animated,
    toString: () => `<${animated ? "a" : ""}:${input.name}:${input.id}>`,
  };
}

/** Purpose: create a minimal fake client with configurable application + emoji fetch behavior. */
function buildClient(input: { application: FakeApplication | null }): Client {
  return {
    application: input.application,
  } as unknown as Client;
}

/** Purpose: build fake client/application that returns an emoji collection successfully. */
function buildClientWithApplicationEmojis(
  emojis: FakeAppEmoji[],
): {
  client: Client;
  fetchApplication: ReturnType<typeof vi.fn>;
  fetchEmojis: ReturnType<typeof vi.fn>;
} {
  const fetchEmojis = vi
    .fn()
    .mockResolvedValue(new Map(emojis.map((emoji) => [emoji.id, emoji])));
  const fetchApplication = vi.fn().mockResolvedValue(undefined);
  const application: FakeApplication = {
    fetch: fetchApplication,
    emojis: {
      fetch: fetchEmojis,
    },
  };
  return {
    client: buildClient({ application }),
    fetchApplication,
    fetchEmojis,
  };
}

describe("EmojiResolverService", () => {
  it("normalizes shortcode names by trimming and stripping surrounding colons", () => {
    expect(normalizeEmojiShortcodeName("arrow_arrow")).toBe("arrow_arrow");
    expect(normalizeEmojiShortcodeName(":arrow_arrow:")).toBe("arrow_arrow");
    expect(normalizeEmojiShortcodeName("::arrow_arrow::")).toBe("arrow_arrow");
  });

  it("validates shortcode names using Discord-safe constraints", () => {
    expect(isValidEmojiShortcodeName("arrow_arrow")).toBe(true);
    expect(isValidEmojiShortcodeName("a")).toBe(false);
    expect(isValidEmojiShortcodeName("bad-name")).toBe(false);
  });

  it("parses static custom emoji tokens into discord CDN image urls", () => {
    const parsed = parseEmojiImageSource("<:arrow_arrow:123456789012345678>");

    expect(parsed).toEqual({
      ok: true,
      sourceType: "custom_emoji_token",
      imageUrl:
        "https://cdn.discordapp.com/emojis/123456789012345678.png?quality=lossless",
      customEmojiId: "123456789012345678",
      animated: false,
    });
  });

  it("parses animated custom emoji tokens into gif CDN image urls", () => {
    const parsed = parseEmojiImageSource("<a:arrow_arrow:123456789012345678>");

    expect(parsed).toEqual({
      ok: true,
      sourceType: "custom_emoji_token",
      imageUrl:
        "https://cdn.discordapp.com/emojis/123456789012345678.gif?quality=lossless",
      customEmojiId: "123456789012345678",
      animated: true,
    });
  });

  it("parses direct image urls", () => {
    const parsed = parseEmojiImageSource("https://example.com/icon.webp");

    expect(parsed).toEqual({
      ok: true,
      sourceType: "direct_image_url",
      imageUrl: "https://example.com/icon.webp",
      customEmojiId: null,
      animated: false,
    });
  });

  it("rejects unsupported unicode emoji input for add-flow source parsing", () => {
    const parsed = parseEmojiImageSource("🔥");

    expect(parsed).toEqual({
      ok: false,
      sourceType: "unicode_emoji_unsupported",
      code: "unsupported_unicode_emoji",
    });
  });

  it("rejects random invalid image-source input", () => {
    const parsed = parseEmojiImageSource("definitely-not-an-image-source");

    expect(parsed).toEqual({
      ok: false,
      sourceType: "invalid_input",
      code: "invalid_emoji_input",
    });
  });

  it("fetchApplicationEmojiInventory returns success with emojis", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "2", name: "bravo" }),
      buildFakeEmoji({ id: "1", name: "alpha" }),
    ]);

    const result = await resolver.fetchApplicationEmojiInventory(client, {
      forceRefresh: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.entries.map((entry) => entry.name)).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(result.snapshot.exactByName.get("alpha")?.rendered).toBe("<:alpha:1>");
    expect(result.snapshot.lowercaseByName.get("bravo")?.rendered).toBe(
      "<:bravo:2>",
    );
  });

  it("fetchApplicationEmojiInventory returns success with zero emojis", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([]);

    const result = await resolver.fetchApplicationEmojiInventory(client, {
      forceRefresh: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.entries).toEqual([]);
    expect(result.diagnostics.emojiFetchSucceeded).toBe(true);
  });

  it("fetchApplicationEmojiInventory returns manager-unavailable failure", async () => {
    const resolver = new EmojiResolverService(0);
    const fetchApplication = vi.fn().mockResolvedValue(undefined);
    const client = buildClient({
      application: {
        fetch: fetchApplication,
        emojis: {},
      },
    });

    const result = await resolver.fetchApplicationEmojiInventory(client, {
      forceRefresh: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("application_emoji_manager_unavailable");
  });

  it("fetchApplicationEmojiInventory returns fetch-failed failure", async () => {
    const resolver = new EmojiResolverService(0);
    const fetchApplication = vi.fn().mockResolvedValue(undefined);
    const fetchEmojis = vi.fn().mockRejectedValue(new Error("boom"));
    const client = buildClient({
      application: {
        fetch: fetchApplication,
        emojis: {
          fetch: fetchEmojis,
        },
      },
    });

    const result = await resolver.fetchApplicationEmojiInventory(client, {
      forceRefresh: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("application_emoji_fetch_failed");
  });

  it("resolves exact-name match", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
    ]);

    const resolved = await resolver.resolveByName(client, "arrow_arrow");

    expect(resolved?.shortcode).toBe(":arrow_arrow:");
    expect(resolved?.rendered).toBe("<:arrow_arrow:1>");
  });

  it("resolves case-insensitive match", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
    ]);

    const resolved = await resolver.resolveByName(client, "ArRoW_ArRoW");

    expect(resolved?.rendered).toBe("<:arrow_arrow:1>");
  });

  it("normalizes colon-wrapped lookup names", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
    ]);

    const resolved = await resolver.resolveByName(client, ":arrow_arrow:");

    expect(resolved?.rendered).toBe("<:arrow_arrow:1>");
  });

  it("returns null for not-found names while keeping failures distinct", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
    ]);

    await expect(resolver.resolveByName(client, "missing_name")).resolves.toBeNull();
  });

  it("throws a typed runtime error when emoji inventory is unavailable", async () => {
    const resolver = new EmojiResolverService(0);
    const fetchApplication = vi.fn().mockResolvedValue(undefined);
    const client = buildClient({
      application: {
        fetch: fetchApplication,
        emojis: {},
      },
    });

    await expect(resolver.resolveByName(client, "arrow_arrow")).rejects.toMatchObject({
      name: "EmojiResolverRuntimeError",
      code: "application_emoji_manager_unavailable",
    });
  });

  it("replaces multiple shortcodes in one text body", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
      buildFakeEmoji({ id: "2", name: "check_mark" }),
    ]);

    const out = await resolver.replaceShortcodes(
      client,
      "Top :arrow_arrow: and :check_mark: done",
    );

    expect(out).toBe("Top <:arrow_arrow:1> and <:check_mark:2> done");
  });

  it("leaves unknown shortcodes unchanged", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "arrow_arrow" }),
    ]);

    const out = await resolver.replaceShortcodes(
      client,
      "Known :arrow_arrow: unknown :not_real:",
    );

    expect(out).toBe("Known <:arrow_arrow:1> unknown :not_real:");
  });

  it("keeps static and animated emoji render tokens as returned by Discord", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([
      buildFakeEmoji({ id: "1", name: "static_icon", animated: false }),
      buildFakeEmoji({ id: "2", name: "animated_icon", animated: true }),
    ]);

    const staticResolved = await resolver.resolveByName(client, "static_icon");
    const animatedResolved = await resolver.resolveByName(client, "animated_icon");

    expect(staticResolved?.rendered).toBe("<:static_icon:1>");
    expect(animatedResolved?.rendered).toBe("<a:animated_icon:2>");
  });
});
