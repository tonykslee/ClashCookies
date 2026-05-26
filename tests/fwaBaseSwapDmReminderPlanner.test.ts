import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  trackedMessageClaim: {
    findFirst: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildFwaBaseSwapDmReminderClaimKey,
  buildFwaBaseSwapDmReminderContentForTest,
  buildFwaBaseSwapReminderPostUrl,
  claimFwaBaseSwapDmReminderCandidateForTest,
  findPendingFwaBaseSwapDmReminderCandidatesForTest,
  resolveDueFwaBaseSwapDmReminderSlots,
  resolveRemainingFwaBaseSwapDmReminderSlots,
} from "../src/services/fwa/baseSwapDmReminderService";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.trackedMessage.findMany.mockResolvedValue([]);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.trackedMessageClaim.findFirst.mockResolvedValue(null);
  prismaMock.trackedMessageClaim.createMany.mockResolvedValue({ count: 1 });
});

describe("base-swap DM reminder slot helpers", () => {
  const battleDayStart = new Date("2026-05-27T12:00:00.000Z");

  it("resolves due and remaining offsets across the supported 12h/6h/3h/1h slots", () => {
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-26T22:59:59.000Z"),
        battleDayStart,
      }),
    ).toEqual([]);
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T00:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([12]);
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T05:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([12]);
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T10:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([12, 6, 3]);
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T11:30:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([12, 6, 3, 1]);
    expect(
      resolveDueFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T12:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([]);

    expect(
      resolveRemainingFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T00:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([6, 3, 1]);
    expect(
      resolveRemainingFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T10:00:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([1]);
    expect(
      resolveRemainingFwaBaseSwapDmReminderSlots({
        now: new Date("2026-05-27T11:30:00.000Z"),
        battleDayStart,
      }),
    ).toEqual([]);
  });
});

describe("base-swap DM reminder planner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("plans one candidate per user and due slot, deduping split posts and excluding acknowledged or unlinked entries", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-1",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-1",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "#2QG2C08UP",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-26T09:55:00.000Z",
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              discordUserId: "111",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
            {
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              discordUserId: "111",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
            {
              position: 3,
              playerTag: "#CCC333",
              playerName: "Charlie",
              discordUserId: "222",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: true,
            },
            {
              position: 4,
              playerTag: "#DDD444",
              playerName: "Delta",
              discordUserId: null,
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
          ],
          layoutLinks: [],
        },
      },
      {
        id: "tracked-2",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-2",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "#2QG2C08UP",
        createdAt: new Date("2026-05-26T09:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-26T09:55:00.000Z",
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              discordUserId: "111",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
            {
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              discordUserId: "111",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
          ],
          layoutLinks: [],
        },
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        startTime: new Date("2026-05-27T12:00:00.000Z"),
        state: "preparation",
      },
    ]);

    const candidates = await findPendingFwaBaseSwapDmReminderCandidatesForTest({
      guildId: "guild-1",
      now: new Date("2026-05-27T00:00:00.000Z"),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#2QG2C08UP",
        clanName: "Test Clan",
        trackedMessageId: "tracked-1",
        referenceId: "fwa-base-swap:split-key",
        channelId: "mail-1",
        messageId: "msg-1",
        discordUserId: "111",
        dueOffsetHours: 12,
        remainingOffsetHours: [6, 3, 1],
        postUrl: "https://discord.com/channels/guild-1/mail-1/msg-1",
        battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      }),
    );
    expect(candidates[0]?.entries).toEqual([
      { position: 1, playerTag: "#AAA111", playerName: "Alpha" },
      { position: 2, playerTag: "#BBB222", playerName: "Bravo" },
    ]);
    expect(prismaMock.currentWar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
        }),
      }),
    );
  });

  it("builds reminder content with the post link, entry list, time remaining, and remaining slots", () => {
    const content = buildFwaBaseSwapDmReminderContentForTest({
      postUrl: buildFwaBaseSwapReminderPostUrl({
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-1",
      }),
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T00:00:00.000Z"),
      remainingOffsetHours: [6, 3, 1],
      entries: [
        { position: 1, playerTag: "#AAA111", playerName: "Alpha" },
        { position: 2, playerTag: "#BBB222", playerName: "Bravo" },
      ],
    });

    expect(content).toContain("# Swap back to FWA base!");
    expect(content).toContain("https://discord.com/channels/guild-1/mail-1/msg-1");
    expect(content).toContain("- #1 Alpha");
    expect(content).toContain("- #2 Bravo");
    expect(content).toContain("You have 12h 0m to swap!");
    expect(content).toContain("You will get pinged at the 6h, 3h, and 1h mark");
  });

  it("claims a reminder once per reference/user/offset even across split rows", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-new",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-new",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "#2QG2C08UP",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
      },
      {
        id: "tracked-old",
        guildId: "guild-1",
        channelId: "mail-2",
        messageId: "msg-old",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "#2QG2C08UP",
        createdAt: new Date("2026-05-26T09:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedMessageClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "claim-1",
      });
    prismaMock.trackedMessageClaim.createMany.mockResolvedValue({ count: 1 });

    const first = await claimFwaBaseSwapDmReminderCandidateForTest({
      candidate: {
        guildId: "guild-1",
        clanTag: "2QG2C08UP",
        trackedMessageId: "tracked-new",
        referenceId: "fwa-base-swap:split-key",
        messageId: "msg-new",
        discordUserId: "111",
        dueOffsetHours: 12,
      },
    });
    const second = await claimFwaBaseSwapDmReminderCandidateForTest({
      candidate: {
        guildId: "guild-1",
        clanTag: "2QG2C08UP",
        trackedMessageId: "tracked-new",
        referenceId: "fwa-base-swap:split-key",
        messageId: "msg-new",
        discordUserId: "111",
        dueOffsetHours: 12,
      },
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(prismaMock.trackedMessageClaim.createMany).toHaveBeenCalledTimes(1);
    expect(buildFwaBaseSwapDmReminderClaimKey({
      trackedMessageId: "tracked-new",
      referenceId: "fwa-base-swap:split-key",
      discordUserId: "111",
      offsetHours: 12,
    })).toBe("fwa-base-swap-dm-reminder:fwa-base-swap:split-key:111:offset=12");
  });

  it("excludes acknowledged and unlinked entries from planner candidates", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-1",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-1",
        referenceId: null,
        clanTag: "#2QG2C08UP",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
        metadata: {
          clanName: "Test Clan",
          createdByUserId: "user-1",
          createdAtIso: "2026-05-26T09:55:00.000Z",
          swapReminder: true,
          entries: [
            {
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              discordUserId: "111",
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: true,
            },
            {
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              discordUserId: null,
              townhallLevel: null,
              section: "fwa_bases",
              acknowledged: false,
            },
          ],
          layoutLinks: [],
        },
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        startTime: new Date("2026-05-27T12:00:00.000Z"),
        state: "preparation",
      },
    ]);

    const candidates = await findPendingFwaBaseSwapDmReminderCandidatesForTest({
      guildId: "guild-1",
      now: new Date("2026-05-27T00:00:00.000Z"),
    });

    expect(candidates).toEqual([]);
  });
});
