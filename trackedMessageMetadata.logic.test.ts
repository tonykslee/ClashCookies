import { describe, expect, it, vi } from "vitest";

vi.mock("../src/prisma", () => ({
  prisma: {},
}));

import {
  parseFwaBaseSwapMetadata,
  parseSyncTimeMetadata,
} from "../src/services/TrackedMessageService";

describe("tracked message metadata parsing", () => {
  it("parses fwa base-swap metadata and normalizes optional fields", () => {
    const parsed = parseFwaBaseSwapMetadata({
      clanName: " Rocky Road ",
      createdByUserId: " 123456 ",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      phaseTimingLine: "  ## Battle Day ends <t:1740003600:F> (<t:1740003600:R>)  ",
      alertEmoji: "  <a:alert:1> ",
      layoutBulletEmoji: "  <a:arrow_arrow:2> ",
      entries: [
        {
          position: "1",
          playerTag: " #AAA111 ",
          playerName: " Alpha ",
          discordUserId: " 999 ",
          townhallLevel: "18",
          section: "base_errors",
          acknowledged: 1,
        },
        {
          position: 0,
          playerTag: "#DROP",
          playerName: "Drop",
          acknowledged: false,
        },
      ],
      layoutLinks: [
        {
          townhall: "18",
          layoutLink: " https://link.clashofclans.com/en?action=OpenLayout&id=TH18 ",
        },
        {
          townhall: 0,
          layoutLink: "https://invalid.example",
        },
      ],
    });

    expect(parsed).toEqual({
      clanName: "Rocky Road",
      createdByUserId: "123456",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      phaseTimingLine: "## Battle Day ends <t:1740003600:F> (<t:1740003600:R>)",
      alertEmoji: "<a:alert:1>",
      layoutBulletEmoji: "<a:arrow_arrow:2>",
      entries: [
        {
          position: 1,
          playerTag: "#AAA111",
          playerName: "Alpha",
          discordUserId: "999",
          townhallLevel: 18,
          section: "base_errors",
          acknowledged: true,
        },
      ],
      layoutLinks: [
        {
          townhall: 18,
          layoutLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18",
        },
      ],
    });
  });

  it("defaults fwa entry section to war_bases and nulls blank optional values", () => {
    const parsed = parseFwaBaseSwapMetadata({
      clanName: "Clan",
      createdByUserId: "123",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      phaseTimingLine: "   ",
      alertEmoji: "",
      layoutBulletEmoji: " ",
      entries: [
        {
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          discordUserId: " ",
          townhallLevel: "0",
          section: "unexpected_section",
          acknowledged: false,
        },
      ],
    });

    expect(parsed).toEqual({
      clanName: "Clan",
      createdByUserId: "123",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      phaseTimingLine: null,
      alertEmoji: null,
      layoutBulletEmoji: null,
      entries: [
        {
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          discordUserId: null,
          townhallLevel: null,
          section: "war_bases",
          acknowledged: false,
        },
      ],
      layoutLinks: undefined,
    });
  });

  it("rejects fwa base-swap metadata without required top-level fields or valid entries", () => {
    expect(parseFwaBaseSwapMetadata(null)).toBeNull();
    expect(
      parseFwaBaseSwapMetadata({
        clanName: "Clan",
        createdByUserId: "123",
        createdAtIso: "2026-03-19T12:00:00.000Z",
        entries: [],
      })
    ).toBeNull();
    expect(
      parseFwaBaseSwapMetadata({
        clanName: "Clan",
        createdByUserId: "123",
        createdAtIso: "",
        entries: [{ position: 1, playerTag: "#A", playerName: "Alpha" }],
      })
    ).toBeNull();
  });

  it("parses sync-time metadata and keeps reminderSentAt only when it is a string", () => {
    const parsed = parseSyncTimeMetadata({
      syncTimeIso: "2026-03-19T15:30:00.000Z",
      syncEpochSeconds: "1742407800",
      roleId: "456",
      reminderSentAt: "2026-03-19T15:25:00.000Z",
      clans: [
        {
          clanTag: "#AAA111",
          clanName: "Rocky Road",
          emojiId: " 111 ",
          emojiName: " rr ",
          emojiInline: " <:rr:111> ",
        },
        {
          clanTag: "",
          clanName: "Ignored",
          emojiInline: "<:bad:999>",
        },
      ],
    });

    expect(parsed).toEqual({
      syncTimeIso: "2026-03-19T15:30:00.000Z",
      syncEpochSeconds: 1742407800,
      roleId: "456",
      reminderSentAt: "2026-03-19T15:25:00.000Z",
      clans: [
        {
          clanTag: "#AAA111",
          clanName: "Rocky Road",
          emojiId: "111",
          emojiName: "rr",
          emojiInline: "<:rr:111>",
        },
      ],
    });
  });

  it("rejects sync-time metadata when required fields are missing or no clans survive parsing", () => {
    expect(parseSyncTimeMetadata(undefined)).toBeNull();
    expect(
      parseSyncTimeMetadata({
        syncTimeIso: "2026-03-19T15:30:00.000Z",
        syncEpochSeconds: "not-a-number",
        roleId: "456",
        clans: [{ clanTag: "#AAA111", clanName: "Clan", emojiInline: "<:x:1>" }],
      })
    ).toBeNull();
    expect(
      parseSyncTimeMetadata({
        syncTimeIso: "2026-03-19T15:30:00.000Z",
        syncEpochSeconds: 1742407800,
        roleId: "456",
        reminderSentAt: 0,
        clans: [{ clanTag: "", clanName: "Clan", emojiInline: "" }],
      })
    ).toBeNull();
  });
});
