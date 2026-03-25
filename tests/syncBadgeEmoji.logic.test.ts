import { describe, expect, it } from "vitest";
import {
  findSyncBadgeEmojiForClan,
  getSyncBadgeEmojiIdentifiers,
  getSyncBadgeEmojis,
} from "../src/helper/syncBadgeEmoji";

const STAGING_BOT_ID = "1474193888146358393";
const PROD_BOT_ID = "1131335782016237749";

describe("sync badge emoji resolution", () => {
  it("returns the configured emoji ids for each environment", () => {
    expect(getSyncBadgeEmojis(STAGING_BOT_ID)).toHaveLength(9);
    expect(getSyncBadgeEmojis(PROD_BOT_ID)).toHaveLength(9);
    expect(getSyncBadgeEmojis("unknown")).toEqual([]);
  });

  it("builds name:id identifiers for sync badge reactions", () => {
    expect(getSyncBadgeEmojiIdentifiers(STAGING_BOT_ID)).toContain(
      "rr:1476279632729866242"
    );
    expect(getSyncBadgeEmojiIdentifiers(PROD_BOT_ID)).toContain(
      "rr:1476279773243379762"
    );
  });

  it("prefers an explicit clan code hint when available", () => {
    const emoji = findSyncBadgeEmojiForClan(STAGING_BOT_ID, "Some Unknown Clan", "rr");
    expect(emoji?.code).toBe("RR");
    expect(emoji?.name).toBe("rr");
  });

  it("matches clan labels despite punctuation and unicode variants", () => {
    expect(findSyncBadgeEmojiForClan(STAGING_BOT_ID, "DARK EMPIRE™!")?.code).toBe("DE");
    expect(findSyncBadgeEmojiForClan(STAGING_BOT_ID, "ＡＫＡＴＳＵＫＩ")?.code).toBe("AK");
  });

  it("falls back to normalized clan-name to code mapping", () => {
    expect(findSyncBadgeEmojiForClan(STAGING_BOT_ID, "TheWiseCowboys")?.code).toBe("TWC");
    expect(findSyncBadgeEmojiForClan(STAGING_BOT_ID, "Rocky Road")?.code).toBe("RR");
  });

  it("returns null when there is no known environment or no mapping match", () => {
    expect(findSyncBadgeEmojiForClan(undefined, "Rocky Road")).toBeNull();
    expect(findSyncBadgeEmojiForClan(STAGING_BOT_ID, "Completely New Clan")).toBeNull();
  });
});
