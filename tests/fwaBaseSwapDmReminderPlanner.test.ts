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

function buildEntry(input: {
  position: number;
  playerTag: string;
  playerName: string;
  section: "war_bases" | "base_errors" | "fwa_bases";
  discordUserId?: string | null;
  acknowledged?: boolean;
}) {
  return {
    position: input.position,
    playerTag: input.playerTag,
    playerName: input.playerName,
    discordUserId: input.discordUserId ?? null,
    section: input.section,
    acknowledged: input.acknowledged ?? false,
  };
}

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

  it("plans one grouped candidate per user/reference and keeps only the latest due slot", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-new",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-2",
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
            buildEntry({
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              section: "war_bases",
              discordUserId: "111",
            }),
          ],
          layoutLinks: [],
        },
      },
      {
        id: "tracked-old",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-1",
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
            buildEntry({
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              section: "fwa_bases",
              discordUserId: "111",
            }),
            buildEntry({
              position: 3,
              playerTag: "#CCC333",
              playerName: "Charlie",
              section: "base_errors",
              discordUserId: "111",
            }),
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
        matchType: "BL",
      },
    ]);

    const candidates = await findPendingFwaBaseSwapDmReminderCandidatesForTest({
      guildId: "guild-1",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(prismaMock.currentWar.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          clanTag: true,
          startTime: true,
          state: true,
          matchType: true,
        }),
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#2QG2C08UP",
        clanName: "Test Clan",
        matchType: "BL",
        trackedMessageId: "tracked-new",
        referenceId: "fwa-base-swap:split-key",
        channelId: "mail-1",
        messageId: "msg-2",
        discordUserId: "111",
        dueOffsetHours: 3,
        remainingOffsetHours: [1],
        postUrl: "https://discord.com/channels/guild-1/mail-1/msg-2",
        battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      }),
    );
    expect(candidates[0]?.entries).toEqual([
      {
        position: 2,
        playerTag: "#BBB222",
        playerName: "Bravo",
        section: "war_bases",
      },
      {
        position: 1,
        playerTag: "#AAA111",
        playerName: "Alpha",
        section: "fwa_bases",
      },
      {
        position: 3,
        playerTag: "#CCC333",
        playerName: "Charlie",
        section: "base_errors",
      },
    ]);
  });

  it("renders grouped reminder content with section-specific sections and future slots", () => {
    const content = buildFwaBaseSwapDmReminderContentForTest({
      postUrl: buildFwaBaseSwapReminderPostUrl({
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-1",
      }),
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T06:00:00.000Z"),
      remainingOffsetHours: [3, 1],
      matchType: "BL",
      entries: [
        buildEntry({
          position: 12,
          playerTag: "#BBB222",
          playerName: "Bravo",
          section: "fwa_bases",
        }),
        buildEntry({
          position: 4,
          playerTag: "#AAA111",
          playerName: "Alpha",
          section: "war_bases",
        }),
        buildEntry({
          position: 23,
          playerTag: "#CCC333",
          playerName: "Charlie",
          section: "base_errors",
        }),
      ],
    });

    expect(content).toContain("# Base swap reminder");
    expect(content).toContain(
      "Since you have not yet reacted to the base-swap post https://discord.com/channels/guild-1/mail-1/msg-1, you are getting pinged for:",
    );
    expect(content).toContain("## Swap back to FWA base!");
    expect(content).toContain(
      "You have not yet reacted and need to swap the listed account(s) from war base back to FWA base.",
    );
    expect(content).toContain("- #4 Alpha");
    expect(content).toContain("## Swap to WAR base!");
    expect(content).toContain(
      "You have not yet reacted and need to swap the listed account(s) from FWA base to war base.",
    );
    expect(content).toContain("- #12 Bravo");
    expect(content).toContain("## Fix your war base!");
    expect(content).toContain(
      "You have not yet reacted and need to fix the listed account(s)' base errors.",
    );
    expect(content).toContain("- #23 Charlie");
    expect(content).toContain("## You have 6h 0m until battle day starts");
    expect(content).toContain(
      "You will get pinged at the 3h and 1h mark until you react to the base-swap post https://discord.com/channels/guild-1/mail-1/msg-1",
    );
  });

  it("renders section-specific copy for fwa-bases, war-bases, and FWA base errors", () => {
    const postUrl = buildFwaBaseSwapReminderPostUrl({
      guildId: "guild-1",
      channelId: "mail-1",
      messageId: "msg-1",
    });

    const swapToWar = buildFwaBaseSwapDmReminderContentForTest({
      postUrl,
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T06:00:00.000Z"),
      remainingOffsetHours: [3, 1],
      matchType: "BL",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A1",
          playerName: "Alpha",
          section: "fwa_bases",
        }),
      ],
    });
    expect(swapToWar).toContain("## Swap to WAR base!");
    expect(swapToWar).toContain(
      "swap the listed account(s) from FWA base to war base",
    );

    const swapBack = buildFwaBaseSwapDmReminderContentForTest({
      postUrl,
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T06:00:00.000Z"),
      remainingOffsetHours: [3, 1],
      matchType: "FWA",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A2",
          playerName: "Bravo",
          section: "war_bases",
        }),
      ],
    });
    expect(swapBack).toContain("## Swap back to FWA base!");
    expect(swapBack).toContain(
      "swap the listed account(s) from war base back to FWA base",
    );

    const fixFwaBase = buildFwaBaseSwapDmReminderContentForTest({
      postUrl,
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T06:00:00.000Z"),
      remainingOffsetHours: [3, 1],
      matchType: "FWA",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A3",
          playerName: "Charlie",
          section: "base_errors",
        }),
      ],
    });
    expect(fixFwaBase).toContain("## Fix your FWA base!");
    expect(fixFwaBase).toContain("fix the listed account(s)' base errors");

    const fixWarBase = buildFwaBaseSwapDmReminderContentForTest({
      postUrl,
      battleDayStart: new Date("2026-05-27T12:00:00.000Z"),
      now: new Date("2026-05-27T06:00:00.000Z"),
      remainingOffsetHours: [3, 1],
      matchType: "BL",
      entries: [
        buildEntry({
          position: 1,
          playerTag: "#A4",
          playerName: "Delta",
          section: "base_errors",
        }),
      ],
    });
    expect(fixWarBase).toContain("## Fix your war base!");
  });

  it("claims a reminder once per reference/user/offset even across split rows", async () => {
    prismaMock.trackedMessage.findMany.mockResolvedValue([
      {
        id: "tracked-new",
        guildId: "guild-1",
        channelId: "mail-1",
        messageId: "msg-new",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
        createdAt: new Date("2026-05-26T10:00:00.000Z"),
        expiresAt: new Date("2026-05-28T00:00:00.000Z"),
      },
      {
        id: "tracked-old",
        guildId: "guild-1",
        channelId: "mail-2",
        messageId: "msg-old",
        referenceId: "fwa-base-swap:split-key",
        clanTag: "2QG2C08UP",
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
        dueOffsetHours: 3,
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
        dueOffsetHours: 3,
      },
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(prismaMock.trackedMessageClaim.createMany).toHaveBeenCalledTimes(1);
    expect(buildFwaBaseSwapDmReminderClaimKey({
      trackedMessageId: "tracked-new",
      referenceId: "fwa-base-swap:split-key",
      discordUserId: "111",
      offsetHours: 3,
    })).toBe("fwa-base-swap-dm-reminder:fwa-base-swap:split-key:111:offset=3");
  });

  it("excludes acknowledged and unlinked entries from planner candidates across all sections", async () => {
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
            buildEntry({
              position: 1,
              playerTag: "#AAA111",
              playerName: "Alpha",
              section: "war_bases",
              discordUserId: "111",
              acknowledged: true,
            }),
            buildEntry({
              position: 2,
              playerTag: "#BBB222",
              playerName: "Bravo",
              section: "base_errors",
              discordUserId: null,
            }),
            buildEntry({
              position: 3,
              playerTag: "#CCC333",
              playerName: "Charlie",
              section: "fwa_bases",
              discordUserId: "333",
              acknowledged: true,
            }),
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
        matchType: "BL",
      },
    ]);

    const candidates = await findPendingFwaBaseSwapDmReminderCandidatesForTest({
      guildId: "guild-1",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(candidates).toEqual([]);
  });
});
