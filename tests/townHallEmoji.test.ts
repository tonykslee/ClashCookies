import { beforeEach, describe, expect, it, vi } from "vitest";

const emojiResolverServiceMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

vi.mock("../src/services/emoji/EmojiResolverService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/emoji/EmojiResolverService")>(
    "../src/services/emoji/EmojiResolverService",
  );
  return {
    ...actual,
    emojiResolverService: emojiResolverServiceMock,
  };
});

import {
  renderTownHallIcon,
  resolveTownHallEmojiMap,
} from "../src/helper/townHallEmoji";

describe("townHallEmoji", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves TH1-TH18 and the canonical TH19 application emoji", async () => {
    emojiResolverServiceMock.fetchApplicationEmojiInventory.mockResolvedValue({
      ok: true,
      snapshot: {
        exactByName: new Map([
          ["th1", { rendered: "<:th1:101>" }],
          ["th18", { rendered: "<:th18:118>" }],
          ["TH19", { rendered: "<:th19:1572442203844902932>" }],
        ]),
        lowercaseByName: new Map([
          ["th1", { rendered: "<:th1:101>" }],
          ["th18", { rendered: "<:th18:118>" }],
          ["th19", { rendered: "<:th19:1572442203844902932>" }],
        ]),
      },
    });

    const map = await resolveTownHallEmojiMap({} as any);

    expect(map.get(1)).toBe("<:th1:101>");
    expect(map.get(18)).toBe("<:th18:118>");
    expect(map.get(19)).toBe("<:th19:1572442203844902932>");
  });

  it("preserves the safe fallback for unknown and unsupported levels", () => {
    const map = new Map([[19, "<:th19:1572442203844902932>"]]);

    expect(renderTownHallIcon(null, map)).toBe("❔");
    expect(renderTownHallIcon(0, map)).toBe("❔");
    expect(renderTownHallIcon(20, map)).toBe("❔");
  });
});
