import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  trackedMessage: {
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildFwaMatchChecklistRowContextKey,
  buildFwaMatchChecklistScopeKey,
  findLatestFwaMatchChecklistCheckedClanTags,
  parseFwaBaseSwapMetadata,
  parseFwaMatchChecklistMetadata,
  parseSyncTimeMetadata,
  trackedMessageService,
} from "../src/services/TrackedMessageService";

describe("tracked message metadata parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findMany.mockResolvedValue([]);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback({
        trackedMessage: {
          findMany: prismaMock.trackedMessage.findMany,
          update: prismaMock.trackedMessage.update,
          upsert: prismaMock.trackedMessage.upsert,
        },
      }),
    );
  });

  it("parses fwa base-swap metadata and normalizes optional fields", () => {
    const parsed = parseFwaBaseSwapMetadata({
      clanName: " Rocky Road ",
      createdByUserId: " 123456 ",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      swapReminder: true,
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
          position: "2",
          playerTag: " #BBB222 ",
          playerName: " Bravo ",
          discordUserId: " 888 ",
          townhallLevel: "17",
          section: "fwa_bases",
          acknowledged: false,
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
      clanKind: "FWA",
      clanName: "Rocky Road",
      createdByUserId: "123456",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      syncMessageId: null,
      clanRoleId: null,
      pingRoleId: null,
      renderVariant: "single",
      phaseTimingLine: "## Battle Day ends <t:1740003600:F> (<t:1740003600:R>)",
      alertEmoji: "<a:alert:1>",
      fwaAlertEmoji: null,
      layoutBulletEmoji: "<a:arrow_arrow:2>",
      swapReminder: true,
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
        {
          position: 2,
          playerTag: "#BBB222",
          playerName: "Bravo",
          discordUserId: "888",
          townhallLevel: 17,
          section: "fwa_bases",
          acknowledged: false,
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

  it("parses checklist metadata with persisted scope and checked clan tags", () => {
    const parsed = parseFwaMatchChecklistMetadata({
      createdByUserId: " user-1 ",
      createdAtIso: "2026-05-13T00:00:00.000Z",
      scopeKey: " scope-1 ",
      checkedClanTags: ["#RR", " rr ", "#TWC"],
      rows: [
        {
          clanTag: "RR",
          compactCopyLine: "row-1",
          badgeEmojiInline: "<:rr:111>",
          contextKey: "ctx-1",
          detailLines: null,
        },
      ],
    });

    expect(parsed).toMatchObject({
      createdByUserId: "user-1",
      createdAtIso: "2026-05-13T00:00:00.000Z",
      scopeKey: "scope-1",
      referenceId: null,
      checkedClanTags: ["RR", "TWC"],
      rows: [
        {
          clanTag: "RR",
          compactCopyLine: "row-1",
          badgeEmojiId: null,
          badgeEmojiName: null,
          badgeEmojiInline: "<:rr:111>",
          contextKey: "ctx-1",
          detailLines: null,
          warId: null,
          opponentTag: null,
          warStartTimeIso: null,
        },
      ],
    });
  });

  it("builds scoped checklist keys and loads only matching persisted state", async () => {
    const contextA = buildFwaMatchChecklistRowContextKey({
      clanTag: "RR",
      warId: "1234",
      opponentTag: "#OPP1",
    });
    const contextB = buildFwaMatchChecklistRowContextKey({
      clanTag: "TWC",
      warId: "5678",
      opponentTag: "#OPP2",
    });
    const rowsA = [
      {
        clanTag: "RR",
        compactCopyLine: "row-rr",
        badgeEmojiId: null,
        badgeEmojiName: null,
        badgeEmojiInline: "<:rr:111>",
        contextKey: contextA,
      },
      {
        clanTag: "TWC",
        compactCopyLine: "row-twc",
        badgeEmojiId: null,
        badgeEmojiName: null,
        badgeEmojiInline: "<:twc:222>",
        contextKey: contextB,
      },
    ];
    const scopeKey = buildFwaMatchChecklistScopeKey({
      guildId: "guild-1",
      clanTag: null,
      rows: rowsA,
    });

    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        metadata: {
          createdByUserId: "user-1",
          createdAtIso: "2026-05-13T00:00:00.000Z",
          scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=other",
          checkedClanTags: ["RR"],
          rows: rowsA,
        },
      },
      {
        metadata: {
          createdByUserId: "user-1",
          createdAtIso: "2026-05-12T00:00:00.000Z",
          scopeKey,
          checkedClanTags: ["RR", "TWC"],
          rows: rowsA,
        },
      },
      {
        metadata: {
          createdByUserId: "user-2",
          createdAtIso: "2026-05-11T00:00:00.000Z",
          scopeKey,
          checkedClanTags: ["TWC"],
          rows: rowsA,
        },
      },
    ]);

    await expect(
      findLatestFwaMatchChecklistCheckedClanTags({
        guildId: "guild-1",
        clanTag: null,
        scopeKey,
      }),
    ).resolves.toEqual(["RR", "TWC"]);
    await expect(
      findLatestFwaMatchChecklistCheckedClanTags({
        guildId: "guild-1",
        clanTag: null,
        scopeKey: "fwa_match_checklist|guild=guild-1|clan=all|rows=missing",
      }),
    ).resolves.toEqual([]);
    expect(prismaMock.trackedMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
        }),
      }),
    );
  });

  it("defaults fwa entry section to war_bases and nulls blank optional values", () => {
    const parsed = parseFwaBaseSwapMetadata({
      clanName: "Clan",
      createdByUserId: "123",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      swapReminder: "",
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
      clanKind: "FWA",
      clanName: "Clan",
      createdByUserId: "123",
      createdAtIso: "2026-03-19T12:00:00.000Z",
      syncMessageId: null,
      clanRoleId: null,
      pingRoleId: null,
      renderVariant: "single",
      phaseTimingLine: null,
      alertEmoji: null,
      fwaAlertEmoji: null,
      layoutBulletEmoji: null,
      swapReminder: false,
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
          code: "RR",
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
          code: "RR",
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

describe("sync readiness tracked message writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        messageId: "old-1",
        metadata: {
          readinessEnabled: true,
          createdAtIso: "2026-06-10T10:00:00.000Z",
        },
      },
    ]);
    prismaMock.trackedMessage.update.mockResolvedValue(undefined);
    prismaMock.trackedMessage.upsert.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback({
        trackedMessage: {
          findMany: prismaMock.trackedMessage.findMany,
          update: prismaMock.trackedMessage.update,
          upsert: prismaMock.trackedMessage.upsert,
        },
      }),
    );
  });

  it("replaces prior readiness posts and creates the active post in one transaction", async () => {
    const replacedCount = await trackedMessageService.replacePriorSyncReadinessTrackedMessagesForGuildAndCreate({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "current-1",
      referenceId: "current-1",
      metadata: {
        readinessEnabled: true,
        createdAtIso: "2026-06-10T12:00:00.000Z",
        lastRefreshedAtIso: "2026-06-10T12:00:00.000Z",
      },
    });

    expect(replacedCount).toBe(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedMessage.upsert.mock.calls[0]?.[0]).toMatchObject({
      where: { messageId: "current-1" },
      create: {
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "current-1",
      },
    });
  });
});
