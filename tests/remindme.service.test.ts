import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  userActivityReminderRule: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const playerLinkServiceMock = vi.hoisted(() => ({
  listPlayerLinksForDiscordUser: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerLinkService", async () => {
  const actual = await vi.importActual("../src/services/PlayerLinkService");
  return {
    ...actual,
    listPlayerLinksForDiscordUser:
      playerLinkServiceMock.listPlayerLinksForDiscordUser,
  };
});

import {
  createUserActivityReminderRules,
  listUserActivityReminderRuleGroups,
  parsePlayerTagsInput,
  parseReminderOffsetMinutesInput,
  parseReminderOffsetTokenToMinutes,
  removeUserActivityReminderRulesByIds,
} from "../src/services/remindme/UserActivityReminderService";

describe("UserActivityReminderService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.userActivityReminderRule.findMany.mockResolvedValue([]);
    prismaMock.userActivityReminderRule.createMany.mockResolvedValue({ count: 0 });
    prismaMock.userActivityReminderRule.deleteMany.mockResolvedValue({ count: 0 });
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([]);
  });

  it("parses one HhMm token to minutes with strict positive validation", () => {
    expect(parseReminderOffsetTokenToMinutes("12h")).toBe(720);
    expect(parseReminderOffsetTokenToMinutes("2h30m")).toBe(150);
    expect(parseReminderOffsetTokenToMinutes("45m")).toBe(45);
    expect(parseReminderOffsetTokenToMinutes("0h")).toBeNull();
    expect(parseReminderOffsetTokenToMinutes("abc")).toBeNull();
  });

  it("parses comma-separated offsets with dedupe and out-of-window buckets", () => {
    const parsed = parseReminderOffsetMinutesInput({
      rawOffsets: "12h, 2h, 2h, abc, 25h",
      type: UserActivityReminderType.WAR,
    });

    expect(parsed.normalizedMinutes).toEqual([120, 720]);
    expect(parsed.invalidTokens).toEqual(["abc"]);
    expect(parsed.outOfWindowTokens).toEqual(["25h"]);
  });

  it("parses and normalizes player tags deterministically", () => {
    expect(parsePlayerTagsInput("#pylq0289 qgrj2222 #PYLQ0289")).toEqual([
      "#PYLQ0289",
      "#QGRJ2222",
    ]);
  });

  it("rejects non-linked tags in set flow", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        linkedAt: new Date("2026-03-27T00:00:00.000Z"),
        linkedName: "Alpha",
      },
    ]);

    const result = await createUserActivityReminderRules({
      discordUserId: "111111111111111111",
      type: UserActivityReminderType.WAR,
      rawPlayerTags: "#PYLQ0289,#QGRJ2222",
      rawOffsets: "2h",
      method: UserActivityReminderMethod.DM,
      surfaceGuildId: "guild-1",
      surfaceChannelId: null,
    });

    expect(result.outcome).toBe("non_linked_tags");
    if (result.outcome !== "non_linked_tags") return;
    expect(result.rejectedNonLinkedTags).toEqual(["#QGRJ2222"]);
  });

  it("creates one row per linked tag and offset without duplicates", async () => {
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        linkedAt: new Date("2026-03-27T00:00:00.000Z"),
        linkedName: "Alpha",
      },
      {
        playerTag: "#QGRJ2222",
        linkedAt: new Date("2026-03-27T00:01:00.000Z"),
        linkedName: "Beta",
      },
    ]);
    prismaMock.userActivityReminderRule.findMany
      .mockResolvedValueOnce([
        { playerTag: "#PYLQ0289", offsetMinutes: 120 },
      ])
      .mockResolvedValueOnce([
        {
          id: "rule-1",
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#PYLQ0289",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 120,
          surfaceGuildId: null,
          surfaceChannelId: null,
          isActive: true,
        },
        {
          id: "rule-2",
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#PYLQ0289",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 720,
          surfaceGuildId: null,
          surfaceChannelId: null,
          isActive: true,
        },
        {
          id: "rule-3",
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#QGRJ2222",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 120,
          surfaceGuildId: null,
          surfaceChannelId: null,
          isActive: true,
        },
      ]);

    const result = await createUserActivityReminderRules({
      discordUserId: "111111111111111111",
      type: UserActivityReminderType.WAR,
      rawPlayerTags: "#PYLQ0289,#QGRJ2222",
      rawOffsets: "2h,12h",
      method: UserActivityReminderMethod.DM,
      surfaceGuildId: "guild-1",
      surfaceChannelId: null,
    });

    expect(prismaMock.userActivityReminderRule.createMany).toHaveBeenCalledWith({
      data: [
        {
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#PYLQ0289",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 720,
          isActive: true,
          surfaceGuildId: null,
          surfaceChannelId: null,
        },
        {
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#QGRJ2222",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 120,
          isActive: true,
          surfaceGuildId: null,
          surfaceChannelId: null,
        },
        {
          discordUserId: "111111111111111111",
          type: UserActivityReminderType.WAR,
          playerTag: "#QGRJ2222",
          method: UserActivityReminderMethod.DM,
          offsetMinutes: 720,
          isActive: true,
          surfaceGuildId: null,
          surfaceChannelId: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.result.existingRuleCount).toBe(1);
    expect(result.result.createdRuleCount).toBe(3);
  });

  it("groups active rules deterministically for list/remove embeds", async () => {
    prismaMock.userActivityReminderRule.findMany.mockResolvedValue([
      {
        id: "rule-2",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.RAIDS,
        playerTag: "#QGRJ2222",
        method: UserActivityReminderMethod.PING_HERE,
        offsetMinutes: 30,
        surfaceGuildId: "guild-1",
        surfaceChannelId: "channel-1",
        isActive: true,
      },
      {
        id: "rule-1",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.RAIDS,
        playerTag: "#QGRJ2222",
        method: UserActivityReminderMethod.PING_HERE,
        offsetMinutes: 60,
        surfaceGuildId: "guild-1",
        surfaceChannelId: "channel-1",
        isActive: true,
      },
    ]);
    playerLinkServiceMock.listPlayerLinksForDiscordUser.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        linkedAt: new Date("2026-03-27T00:01:00.000Z"),
        linkedName: "Beta",
      },
    ]);

    const groups = await listUserActivityReminderRuleGroups({
      discordUserId: "111111111111111111",
    });

    expect(groups).toEqual([
      {
        key: "RAIDS|#QGRJ2222|PING_HERE",
        type: UserActivityReminderType.RAIDS,
        playerTag: "#QGRJ2222",
        playerName: "Beta",
        method: UserActivityReminderMethod.PING_HERE,
        offsetMinutes: [30, 60],
        ruleIds: ["rule-2", "rule-1"],
        surfaceGuildId: "guild-1",
        surfaceChannelId: "channel-1",
      },
    ]);
  });

  it("removes only user-owned rule ids", async () => {
    prismaMock.userActivityReminderRule.deleteMany.mockResolvedValue({ count: 2 });

    const count = await removeUserActivityReminderRulesByIds({
      discordUserId: "111111111111111111",
      ruleIds: ["rule-1", "rule-1", "", "rule-2"],
    });

    expect(prismaMock.userActivityReminderRule.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["rule-1", "rule-2"] },
        discordUserId: "111111111111111111",
      },
    });
    expect(count).toBe(2);
  });
});
