import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderTargetClanType, ReminderType } from "@prisma/client";

const reminderServiceMock = vi.hoisted(() => ({
  listSelectableClanOptions: vi.fn(),
  createReminderDraft: vi.fn(),
  getReminderWithDetails: vi.fn(),
  listReminderSummariesForGuild: vi.fn(),
  findReminderSummariesByClan: vi.fn(),
  replaceReminderTargetsFromEncodedValues: vi.fn(),
  replaceReminderOffsets: vi.fn(),
  setReminderType: vi.fn(),
  setReminderEnabled: vi.fn(),
  setReminderChannel: vi.fn(),
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
        return { id: input.channelId ?? "channel-1" };
      }),
    },
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
    reminderServiceMock.getReminderWithDetails.mockResolvedValue({
      id: "reminder-1",
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "channel-1",
      isEnabled: false,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-03-26T00:00:00.000Z"),
      updatedAt: new Date("2026-03-26T00:00:00.000Z"),
      offsetsSeconds: [3600],
      targets: [],
    });
    reminderServiceMock.listReminderSummariesForGuild.mockResolvedValue([]);
    reminderServiceMock.findReminderSummariesByClan.mockResolvedValue([]);
  });

  it("initializes create flow with preview panel and no selected clans plus FWA/CWL multi-select options", async () => {
    const interaction = createInteraction({
      subcommand: "create",
      type: ReminderType.WAR_CWL,
      timeLeft: "1h",
      channelId: "channel-1",
    });

    await Reminders.run({} as any, interaction as any, {} as any);

    expect(reminderServiceMock.createReminderDraft).toHaveBeenCalledWith({
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "channel-1",
      offsetSeconds: 3600,
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
