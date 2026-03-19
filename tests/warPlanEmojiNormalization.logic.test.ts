import { describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import { resolveWarPlanEmojiShortcodesForTest } from "../src/commands/WarPlan";
import { EmojiResolverService } from "../src/services/emoji/EmojiResolverService";

describe("warplan emoji shortcode normalization", () => {
  it("uses shared emoji resolver service for shortcode replacement", async () => {
    const replaceShortcodes = vi
      .fn()
      .mockResolvedValue("Plan <:arrow_arrow:123>");
    const client = {} as Client;
    const out = await resolveWarPlanEmojiShortcodesForTest({
      text: "Plan :arrow_arrow:",
      client,
      resolver: { replaceShortcodes } as any,
    });

    expect(replaceShortcodes).toHaveBeenCalledWith(
      client,
      "Plan :arrow_arrow:",
    );
    expect(out).toBe("Plan <:arrow_arrow:123>");
  });

  it("preserves unknown shortcodes", async () => {
    const resolver = new EmojiResolverService(0);
    const client = {
      application: {
        fetch: vi.fn().mockResolvedValue(undefined),
        emojis: {
          fetch: vi.fn().mockResolvedValue(new Map()),
        },
      },
    } as unknown as Client;

    const out = await resolveWarPlanEmojiShortcodesForTest({
      text: "Unknown stays :not_real:",
      client,
      resolver,
    });

    expect(out).toBe("Unknown stays :not_real:");
  });
});
