import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderTargetClanType, ReminderType } from "@prisma/client";

const reminderServiceMock = vi.hoisted(() => ({
  listSelectableClanOptions: vi.fn(),
  findSelectableClanOptionByTag: vi.fn(),
  createReminderDraft: vi.fn(),
  getReminderWithDetails: vi.fn(),
  listReminderSummariesForGuild: vi.fn(),
  findReminderSummariesByClan: vi.fn(),
  replaceReminderTargetsFromEncodedValues: vi.fn(),
  replaceReminderOffsets: vi.fn(),
  setReminderType: vi.fn(),
  setReminderEnabled: vi.fn(),
  setReminderChannel: vi.fn(),
  tryPrefillReminderChannelFromTrackedClanLog: vi.fn(),
  deleteReminder: vi.fn(),
}));

vi.mock("../src/services/reminders/ReminderService", async () => {
  const actual = await vi.importActual("../src/services/reminders/ReminderService");
  return {
    ...actual,
    reminderService: reminderServiceMock,
  };
});

import { Reminders } from "../src/commands/Reminders";

function buildCollector() {
  return {
    on: vi.fn(),
    stop: vi.fn(),
  };
}

function createInteraction(input: {
  subcommand: "create" | "list" | "edit";
  type?: ReminderType;
  timeLeft?: string;
  channelId?: string;
  clan?: string;
}) {
  const collector = buildCollector();
  const fetchReply = vi.fn().mockResolvedValue({
    createMessageComponentCollector: vi.fn().mockReturnValue(collector),
    awaitMessageComponent: vi.fn(),
  });
  const interaction: any = {
    id: "itx-1",
    commandName: "reminders",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "time_left") return input.timeLeft ?? null;
        if (name === "clan") return input.clan ?? null;
        return null;
      }),
      getChannel: vi.fn((name: string) => {
        if (name !== "channel") return null;
        if (!input.channelId) return null;
        return { id: input.channelId };
      }),
    },
    __collector: collector,
  };
  return interaction;
}

describe("/reminders command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reminderServiceMock.listSelectableClanOptions.mockResolvedValue([
      {
        value: `${ReminderTargetClanType.FWA}|#PQL0289`,
        clanTag: "#PQL0289",
        clanType: ReminderTargetClanType.FWA,
        name: "FWA One",
        description: "FWA tracked clan",
      },
      {
        value: `${ReminderTargetClanType.CWL}|#2QG2C08UP`,
        clanTag: "#2QG2C08UP",
        clanType: ReminderTargetClanType.CWL,
        name: "CWL One",
        description: "CWL tracked clan (2026-03)",
      },
    ]);
    reminderServiceMock.createReminderDraft.mockResolvedValue({
      id: "reminder-1",
    });
    reminderServiceMock.findSelectableClanOptionByTag.mockResolvedValue(null);
    reminderServiceMock.getReminderWithDetails.mockResolvedValue({
      id: "reminder-1",
      guildId: "guild-1",
      type: ReminderType.EVENT,
      channelId: "",
      isEnabled: false,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-03-26T00:00:00.000Z"),
      updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      offsetsSeconds: [],
      targets: [],
    });
    reminderServiceMock.tryPrefillReminderChannelFromTrackedClanLog.mockResolvedValue(null);
    reminderServiceMock.listReminderSummariesForGuild.mockResolvedValue([]);
    reminderServiceMock.findReminderSummariesByClan.mockResolvedValue([]);
  });

  it("initializes create flow with a blank preview panel when no create args are supplied", async () => {
    const interaction = createInteraction({ subcommand: "create" });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.createReminderDraft).toHaveBeenCalledWith({
      guildId: "guild-1",
      type: null,
      channelId: null,
      offsetsSeconds: [],
      actorUserId: "user-1",
    });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Reminders - Create");
    expect(String(embed.description)).toContain("Type: _not set_");
    expect(String(embed.description)).toContain("Times: **not set**");
    expect(String(embed.description)).toContain("Channel: _not set_");
    expect(String(embed.description)).toContain("Selected clans:");
    expect(String(embed.description)).toContain("none selected");
  });

  it("seeds create flow from optional slash args and keeps FWA/CWL multi-select options", async () => {
    const interaction = createInteraction({
      subcommand: "create",
      type: ReminderType.WAR_CWL,
      timeLeft: "1h,30m",
      channelId: "channel-1",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.createReminderDraft).toHaveBeenCalledWith({
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "channel-1",
      offsetsSeconds: [1800, 3600],
      actorUserId: "user-1",
    });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Reminders - Create");
    expect(String(embed.description)).toContain("Selected clans:");
    expect(String(embed.description)).toContain("none selected");
    const clanMenu = payload.components[0].components[0].toJSON();
    const descriptions = clanMenu.options.map((option: any) => option.description);
    expect(descriptions).toContain("FWA tracked clan");
    expect(
      descriptions.some((description: string) => description.includes("CWL tracked clan")),
    ).toBe(true);
  });

  it("seeds create clan from optional slash arg and prefills channel from tracked-clan log when channel is unset", async () => {
    reminderServiceMock.findSelectableClanOptionByTag.mockResolvedValue({
      value: `${ReminderTargetClanType.FWA}|#PQL0289`,
      clanTag: "#PQL0289",
      clanType: ReminderTargetClanType.FWA,
      name: "FWA One",
      description: "FWA tracked clan",
    });
    const interaction = createInteraction({
      subcommand: "create",
      clan: "#PQL0289",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.findSelectableClanOptionByTag).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PQL0289",
    });
    expect(reminderServiceMock.replaceReminderTargetsFromEncodedValues).toHaveBeenCalledWith({
      reminderId: "reminder-1",
      guildId: "guild-1",
      encodedValues: [`${ReminderTargetClanType.FWA}|#PQL0289`],
      actorUserId: "user-1",
    });
    expect(reminderServiceMock.tryPrefillReminderChannelFromTrackedClanLog).toHaveBeenCalledWith({
      reminderId: "reminder-1",
      guildId: "guild-1",
      clanTag: "#PQL0289",
      actorUserId: "user-1",
    });
  });

  it("shows a clear error when create clan arg is not tracked/selectable", async () => {
    reminderServiceMock.findSelectableClanOptionByTag.mockResolvedValue(null);
    const interaction = createInteraction({
      subcommand: "create",
      clan: "#PQL0288",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.createReminderDraft).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Clan #PQL0288 is not in tracked clans.",
      }),
    );
  });

  it("only attempts clan-log channel autofill on the first create-panel clan selection", async () => {
    const interaction = createInteraction({ subcommand: "create" });
    await Reminders.run({} as any, interaction as any, {} as any);

    const collectHandler = interaction.__collector.on.mock.calls.find(
      ([eventName]: [string]) => eventName === "collect",
    )?.[1];
    expect(collectHandler).toBeTypeOf("function");

    const firstSelect: any = {
      isButton: () => false,
      isStringSelectMenu: () => true,
      user: { id: "user-1" },
      customId: "reminders:clans:reminder-1",
      values: [`${ReminderTargetClanType.FWA}|#PQL0289`],
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await collectHandler(firstSelect);

    const secondSelect: any = {
      ...firstSelect,
      values: [`${ReminderTargetClanType.CWL}|#2QG2C08UP`],
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    };
    await collectHandler(secondSelect);

    expect(reminderServiceMock.tryPrefillReminderChannelFromTrackedClanLog).toHaveBeenCalledTimes(
      1,
    );
    expect(reminderServiceMock.tryPrefillReminderChannelFromTrackedClanLog).toHaveBeenCalledWith({
      reminderId: "reminder-1",
      guildId: "guild-1",
      clanTag: "#PQL0289",
      actorUserId: "user-1",
    });
  });

  it("acknowledges save via deferred ephemeral response and updates panel into saved state", async () => {
    reminderServiceMock.getReminderWithDetails
      .mockResolvedValueOnce({
        id: "reminder-1",
        guildId: "guild-1",
        type: ReminderType.EVENT,
        channelId: "",
        isEnabled: false,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        offsetsSeconds: [],
        targets: [],
      })
      .mockResolvedValueOnce({
        id: "reminder-1",
        guildId: "guild-1",
        type: ReminderType.WAR_CWL,
        channelId: "123456789012345678",
        isEnabled: false,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        offsetsSeconds: [1800],
        targets: [
          {
            clanTag: "#PQL0289",
            clanType: ReminderTargetClanType.FWA,
            name: "FWA One",
            label: "FWA One (#PQL0289) [FWA]",
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "reminder-1",
        guildId: "guild-1",
        type: ReminderType.WAR_CWL,
        channelId: "123456789012345678",
        isEnabled: true,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
        offsetsSeconds: [1800],
        targets: [
          {
            clanTag: "#PQL0289",
            clanType: ReminderTargetClanType.FWA,
            name: "FWA One",
            label: "FWA One (#PQL0289) [FWA]",
          },
        ],
      });

    const interaction = createInteraction({ subcommand: "create" });
    await Reminders.run({} as any, interaction as any, {} as any);

    const collectHandler = interaction.__collector.on.mock.calls.find(
      ([eventName]: [string]) => eventName === "collect",
    )?.[1];
    const endHandler = interaction.__collector.on.mock.calls.find(
      ([eventName]: [string]) => eventName === "end",
    )?.[1];

    const saveButton: any = {
      isButton: () => true,
      isStringSelectMenu: () => false,
      user: { id: "user-1" },
      customId: "reminders:save:reminder-1",
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: false,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await collectHandler(saveButton);
    await endHandler([], "saved");

    expect(saveButton.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(reminderServiceMock.setReminderEnabled).toHaveBeenCalledWith({
      reminderId: "reminder-1",
      guildId: "guild-1",
      isEnabled: true,
      actorUserId: "user-1",
    });
    expect(saveButton.editReply).toHaveBeenCalledWith({
      content: "Reminder saved and enabled: reminder-1",
    });
    expect(interaction.__collector.stop).toHaveBeenCalledWith("saved");
    const finalEdit = interaction.editReply.mock.calls.at(-1)?.[0] as any;
    const savedEmbed = finalEdit?.embeds?.[0]?.toJSON?.() ?? finalEdit?.embeds?.[0];
    expect(finalEdit?.content).toBe("Reminder saved and enabled: reminder-1");
    expect(String(savedEmbed?.title)).toContain("Reminders - Saved");
    expect(finalEdit?.components).toEqual([]);
  });

  it("returns a clear validation error when optional create time_left is provided but invalid", async () => {
    const interaction = createInteraction({
      subcommand: "create",
      timeLeft: "bad-input",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.createReminderDraft).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Invalid `time_left`. Use positive `HhMm` input, for example `1h`, `45m`, or `1h30m`.",
      }),
    );
  });

  it("shows clear empty-state for list when no reminders exist", async () => {
    const interaction = createInteraction({ subcommand: "list" });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "No reminder configs found for this server.",
      }),
    );
  });

  it("renders populated list rows in scan-friendly output", async () => {
    reminderServiceMock.listReminderSummariesForGuild.mockResolvedValue([
      {
        id: "reminder-1234",
        type: ReminderType.RAIDS,
        channelId: "channel-55",
        isEnabled: true,
        offsetsSeconds: [1800, 3600],
        targetCount: 3,
        createdAt: new Date("2026-03-26T00:00:00.000Z"),
        updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      },
    ]);
    const interaction = createInteraction({ subcommand: "list" });

    await Reminders.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toContain("Reminders (1)");
    expect(String(embed.description)).toContain("RAIDS");
    expect(String(embed.description)).toContain("<#channel-55>");
    expect(String(embed.description)).toContain("targets: 3");
  });

  it("normalizes edit clan tag input with/without # during reminder lookup", async () => {
    const interaction = createInteraction({
      subcommand: "edit",
      clan: "pql0289",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.findReminderSummariesByClan).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#PQL0289",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "No reminders found targeting #PQL0289.",
      }),
    );
  });
});
