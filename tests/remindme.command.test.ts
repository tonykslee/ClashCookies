import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";

const remindMeServiceMock = vi.hoisted(() => ({
  createUserActivityReminderRules: vi.fn(),
  listLinkedPlayerTagOptionsForRemindme: vi.fn(),
  listUserActivityReminderRuleGroups: vi.fn(),
  removeUserActivityReminderRulesByIds: vi.fn(),
}));

const recruitmentReminderServiceMock = vi.hoisted(() => ({
  listRecruitmentReminderRulesForUser: vi.fn(),
  removeRecruitmentReminderRulesByIds: vi.fn(),
}));

vi.mock("../src/services/remindme/UserActivityReminderService", async () => {
  const actual = await vi.importActual(
    "../src/services/remindme/UserActivityReminderService",
  );
  return {
    ...actual,
    createUserActivityReminderRules: remindMeServiceMock.createUserActivityReminderRules,
    listLinkedPlayerTagOptionsForRemindme:
      remindMeServiceMock.listLinkedPlayerTagOptionsForRemindme,
    listUserActivityReminderRuleGroups:
      remindMeServiceMock.listUserActivityReminderRuleGroups,
    removeUserActivityReminderRulesByIds:
      remindMeServiceMock.removeUserActivityReminderRulesByIds,
  };
});

vi.mock("../src/services/RecruitmentReminderService", async () => {
  const actual = await vi.importActual("../src/services/RecruitmentReminderService");
  return {
    ...actual,
    listRecruitmentReminderRulesForUser:
      recruitmentReminderServiceMock.listRecruitmentReminderRulesForUser,
    removeRecruitmentReminderRulesByIds:
      recruitmentReminderServiceMock.removeRecruitmentReminderRulesByIds,
  };
});

import { RemindMe } from "../src/commands/RemindMe";

function createInteraction(input: {
  subcommand: "set" | "list" | "remove";
  type?: UserActivityReminderType;
  playerTags?: string;
  timeLeft?: string;
  method?: UserActivityReminderMethod | null;
}) {
  const handlers: Record<string, any> = {};
  const interaction: any = {
    id: "itx-1",
    commandName: "remindme",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "111111111111111111" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn().mockReturnValue({
        on: vi.fn((event: string, callback: any) => {
          handlers[event] = callback;
        }),
        stop: vi.fn(),
      }),
    }),
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "player_tags") return input.playerTags ?? null;
        if (name === "time_left") return input.timeLeft ?? null;
        if (name === "method") return input.method ?? null;
        return null;
      }),
    },
  };
  interaction.__collectorHandlers = handlers;
  return interaction;
}

describe("/remindme command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remindMeServiceMock.listLinkedPlayerTagOptionsForRemindme.mockResolvedValue([]);
    remindMeServiceMock.listUserActivityReminderRuleGroups.mockResolvedValue([]);
    remindMeServiceMock.removeUserActivityReminderRulesByIds.mockResolvedValue(0);
    recruitmentReminderServiceMock.listRecruitmentReminderRulesForUser.mockResolvedValue([]);
    recruitmentReminderServiceMock.removeRecruitmentReminderRulesByIds.mockResolvedValue(0);
  });

  it("defaults set method to DM when omitted", async () => {
    remindMeServiceMock.createUserActivityReminderRules.mockResolvedValue({
      outcome: "ok",
      parsed: {
        normalizedMinutes: [120],
        invalidTokens: [],
        outOfWindowTokens: [],
      },
      result: {
        linkedTags: ["#PYLQ0289"],
        rejectedNonLinkedTags: [],
        createdRuleCount: 1,
        existingRuleCount: 0,
        groups: [
          {
            key: "WAR|#PYLQ0289|DM",
            type: UserActivityReminderType.WAR,
            playerTag: "#PYLQ0289",
            playerName: "Alpha",
            method: UserActivityReminderMethod.DM,
            offsetMinutes: [120],
            ruleIds: ["rule-1"],
            surfaceGuildId: null,
            surfaceChannelId: null,
          },
        ],
      },
    });

    const interaction = createInteraction({
      subcommand: "set",
      type: UserActivityReminderType.WAR,
      playerTags: "#PYLQ0289",
      timeLeft: "2h",
      method: null,
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    expect(remindMeServiceMock.createUserActivityReminderRules).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
      type: UserActivityReminderType.WAR,
      rawPlayerTags: "#PYLQ0289",
      rawOffsets: "2h",
      method: UserActivityReminderMethod.DM,
      surfaceGuildId: "guild-1",
      surfaceChannelId: null,
    });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(String(payload.content)).toContain("Method: **DM**");
  });

  it("rejects non-linked tags server-side", async () => {
    remindMeServiceMock.createUserActivityReminderRules.mockResolvedValue({
      outcome: "non_linked_tags",
      parsed: {
        normalizedMinutes: [120],
        invalidTokens: [],
        outOfWindowTokens: [],
      },
      linkedTags: [],
      rejectedNonLinkedTags: ["#QGRJ2222"],
    });

    const interaction = createInteraction({
      subcommand: "set",
      type: UserActivityReminderType.WAR,
      playerTags: "#QGRJ2222",
      timeLeft: "2h",
      method: UserActivityReminderMethod.DM,
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Only your linked tags are allowed. Non-linked tags rejected: #QGRJ2222",
      }),
    );
  });

  it("renders list embed rows in deterministic grouped output", async () => {
    remindMeServiceMock.listUserActivityReminderRuleGroups.mockResolvedValue([
      {
        key: "WAR|#PYLQ0289|DM",
        type: UserActivityReminderType.WAR,
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: [120, 720],
        ruleIds: ["rule-1", "rule-2"],
        surfaceGuildId: null,
        surfaceChannelId: null,
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe("Your Reminders");
    expect(String(embed.description)).toContain("**WAR** | Alpha #PYLQ0289 | DM | 2h, 12h");
  });

  it("includes recruitment reminders in the combined list output", async () => {
    remindMeServiceMock.listUserActivityReminderRuleGroups.mockResolvedValue([
      {
        key: "WAR|#PYLQ0289|DM",
        type: UserActivityReminderType.WAR,
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: [120],
        ruleIds: ["rule-1"],
        surfaceGuildId: null,
        surfaceChannelId: null,
      },
    ]);
    recruitmentReminderServiceMock.listRecruitmentReminderRulesForUser.mockResolvedValue([
      {
        id: "recruitment-1",
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "#AAA111",
        platform: "discord",
        timezone: "America/Los_Angeles",
        nextReminderAt: new Date("2026-04-08T18:30:00.000Z"),
        isActive: true,
        lastSentAt: null,
        clanNameSnapshot: "Alpha",
        templateSubject: "Subject",
        templateBody: "Body",
        templateImageUrls: [],
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(String(embed.description)).toContain("Activity reminders:");
    expect(String(embed.description)).toContain("Recruitment reminders:");
    expect(String(embed.description)).toContain("Recruitment");
    expect(String(embed.description)).toContain("#AAA111");
  });

  it("returns clear remove empty-state when user has no reminders", async () => {
    remindMeServiceMock.listUserActivityReminderRuleGroups.mockResolvedValue([]);
    const interaction = createInteraction({
      subcommand: "remove",
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
      content: "You do not have any active reminders to remove.",
    }),
    );
  });

  it("shows recruitment reminders in remove options and removes them when selected", async () => {
    remindMeServiceMock.listUserActivityReminderRuleGroups.mockResolvedValue([
      {
        key: "WAR|#PYLQ0289|DM",
        type: UserActivityReminderType.WAR,
        playerTag: "#PYLQ0289",
        playerName: "Alpha",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: [120],
        ruleIds: ["activity-rule-1"],
        surfaceGuildId: null,
        surfaceChannelId: null,
      },
    ]);
    recruitmentReminderServiceMock.listRecruitmentReminderRulesForUser.mockResolvedValue([
      {
        id: "recruitment-1",
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "#AAA111",
        platform: "discord",
        timezone: "America/Los_Angeles",
        nextReminderAt: new Date("2026-04-08T18:30:00.000Z"),
        isActive: true,
        lastSentAt: null,
        clanNameSnapshot: "Alpha",
        templateSubject: "Subject",
        templateBody: "Body",
        templateImageUrls: [],
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    recruitmentReminderServiceMock.removeRecruitmentReminderRulesByIds.mockResolvedValue(1);

    const interaction = createInteraction({
      subcommand: "remove",
    });

    await RemindMe.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const options =
      payload.components[0].toJSON().components[0].options.map((option: any) => option.value);
    expect(options).toContain("activity|WAR|#PYLQ0289|DM");
    expect(options).toContain("recruitment|recruitment-1");

    await interaction.__collectorHandlers.collect({
      customId: "remindme:remove:select:itx-1",
      user: { id: "111111111111111111" },
      values: ["recruitment|recruitment-1"],
      isStringSelectMenu: () => true,
      isButton: () => false,
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    });

    await interaction.__collectorHandlers.collect({
      customId: "remindme:remove:confirm:itx-1",
      user: { id: "111111111111111111" },
      values: [],
      isStringSelectMenu: () => false,
      isButton: () => true,
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    });

    expect(recruitmentReminderServiceMock.removeRecruitmentReminderRulesByIds).toHaveBeenCalledWith({
      guildId: "guild-1",
      discordUserId: "111111111111111111",
      ruleIds: ["recruitment-1"],
    });
  });

  it("autocomplete suggests only linked tags and preserves comma-prefix input", async () => {
    remindMeServiceMock.listLinkedPlayerTagOptionsForRemindme.mockResolvedValue([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
      { name: "Beta (#QGRJ2222)", value: "#QGRJ2222" },
    ]);
    const interaction: any = {
      user: { id: "111111111111111111" },
      options: {
        getFocused: vi.fn().mockReturnValue({
          name: "player_tags",
          value: "#OLDTAG, #Q",
        }),
      },
      respond: vi.fn().mockResolvedValue(undefined),
    };

    await RemindMe.autocomplete?.(interaction);

    expect(remindMeServiceMock.listLinkedPlayerTagOptionsForRemindme).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
      query: " #Q",
      limit: 25,
    });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#OLDTAG, #PYLQ0289" },
      { name: "Beta (#QGRJ2222)", value: "#OLDTAG, #QGRJ2222" },
    ]);
  });
});
