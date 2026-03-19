import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { EmojiResolverService } from "../src/services/emoji/EmojiResolverService";

type FakeAppEmoji = {
  id: string;
  name: string;
  animated: boolean;
  toString: () => string;
};

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
    toString: () =>
      `<${animated ? "a" : ""}:${input.name}:${input.id}>`,
  };
}

function buildClientWithApplicationEmojis(
  emojis: FakeAppEmoji[],
): {
  client: Client;
  fetchApplication: ReturnType<typeof vi.fn>;
  fetchEmojis: ReturnType<typeof vi.fn>;
} {
  const fetchEmojis = vi.fn().mockResolvedValue(
    new Map(emojis.map((emoji) => [emoji.id, emoji])),
  );
  const fetchApplication = vi.fn().mockResolvedValue(undefined);
  const client = {
    application: {
      fetch: fetchApplication,
      emojis: {
        fetch: fetchEmojis,
      },
    },
  } as unknown as Client;
  return { client, fetchApplication, fetchEmojis };
}

describe("EmojiResolverService", () => {
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

  it("handles empty emoji collections", async () => {
    const resolver = new EmojiResolverService(0);
    const { client } = buildClientWithApplicationEmojis([]);

    const list = await resolver.listApplicationEmojis(client);
    const resolved = await resolver.resolveByName(client, "arrow_arrow");
    const replaced = await resolver.replaceShortcodes(client, "Plan :arrow_arrow:");

    expect(list).toEqual([]);
    expect(resolved).toBeNull();
    expect(replaced).toBe("Plan :arrow_arrow:");
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
