import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  recruitmentTemplate: {
    findMany: vi.fn(),
  },
  recruitmentCooldown: {
    findMany: vi.fn(),
  },
  recruitmentReminderRule: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Recruitment } from "../src/commands/Recruitment";
import * as recruitmentServiceModule from "../src/services/RecruitmentService";
import { recruitmentReminderService } from "../src/services/RecruitmentReminderService";

type CollectorHandlers = {
  collect?: (component: any) => Promise<void>;
  end?: () => Promise<void>;
};

function createCollector() {
  const handlers: CollectorHandlers = {};
  return {
    handlers,
    collector: {
      on: vi.fn((event: "collect" | "end", callback: any) => {
        handlers[event] = callback;
      }),
      stop: vi.fn(),
    },
  };
}

function createDashboardInteraction(timezone = "America/Los_Angeles") {
  const { handlers, collector } = createCollector();
  const interaction: any = {
    id: "dashboard-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("dashboard"),
      getString: vi.fn((name: string) => {
        if (name === "timezone") return timezone;
        return null;
      }),
    },
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
    fetchReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn().mockReturnValue(collector),
    }),
    reply: vi.fn().mockImplementation(async () => {
      interaction.replied = true;
    }),
  };

  return { interaction, handlers };
}

function createButtonComponent(customId: string, userId = "user-1") {
  return {
    customId,
    user: { id: userId },
    isButton: () => true,
    isStringSelectMenu: () => false,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function createSelectComponent(customId: string, values: string[], userId = "user-1") {
  return {
    customId,
    user: { id: userId },
    values,
    isButton: () => false,
    isStringSelectMenu: () => true,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function getLastPayload(interaction: any): any {
  return interaction.editReply.mock.calls.at(-1)?.[0] ?? {};
}

function getComponentJson(payload: any): Array<any> {
  return Array.isArray(payload?.components)
    ? payload.components.map((row: any) => (typeof row?.toJSON === "function" ? row.toJSON() : row))
    : [];
}

function getButtonLabels(payload: any): string[] {
  return getComponentJson(payload).flatMap((row) =>
    Array.isArray(row?.components)
      ? row.components
          .map((component: any) => (typeof component?.toJSON === "function" ? component.toJSON() : component))
          .filter((component: any) => typeof component?.label === "string")
          .map((component: any) => String(component.label))
      : [],
  );
}

function getSelectMenus(payload: any): Array<any> {
  return getComponentJson(payload).flatMap((row) =>
    Array.isArray(row?.components)
      ? row.components
          .map((component: any) => (typeof component?.toJSON === "function" ? component.toJSON() : component))
          .filter((component: any) => Array.isArray(component?.options))
      : [],
  );
}

describe("/recruitment dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T17:45:00-07:00"));
    vi.clearAllMocks();
    vi.spyOn(recruitmentServiceModule, "getRecruitmentTemplate").mockResolvedValue({
      subject: "Alpha Subject",
      body: "Alpha body",
      imageUrls: ["https://img.example/alpha.png"],
    } as any);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha" },
      { tag: "#BBB222", name: "Beta" },
    ]);
    prismaMock.recruitmentTemplate.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        platform: "discord",
        subject: "Alpha Subject",
        body: "Alpha body",
        imageUrls: ["https://img.example/alpha.png"],
      },
      {
        clanTag: "#AAA111",
        platform: "reddit",
        subject: "Alpha Reddit",
        body: "Alpha reddit body",
        imageUrls: [],
      },
    ]);
    prismaMock.recruitmentCooldown.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        platform: "discord",
        expiresAt: new Date("2026-04-08T18:30:00-07:00"),
      },
    ]);
    prismaMock.recruitmentReminderRule.findFirst.mockResolvedValue(null);
    prismaMock.recruitmentReminderRule.create.mockResolvedValue({ id: "rule-1" });
    prismaMock.recruitmentReminderRule.update.mockResolvedValue({ id: "rule-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("wires timezone autocomplete and renders the alliance overview controls", async () => {
    const autocompleteInteraction: any = {
      user: { id: "user-1" },
      options: {
        getFocused: vi.fn().mockReturnValue({
          name: "timezone",
          value: "pac",
        }),
      },
      respond: vi.fn().mockResolvedValue(undefined),
    };

    await Recruitment.autocomplete?.(autocompleteInteraction);

    expect(autocompleteInteraction.respond).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ value: "America/Los_Angeles" }),
      ]),
    );

    const { interaction, handlers } = createDashboardInteraction();
    await Recruitment.run({} as any, interaction as any, {} as any);

    const payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Alliance Overview");
    expect(String(payload.embeds[0].toJSON().description)).toContain("Active recruitment timers");
    expect(getButtonLabels(payload)).toEqual(["Timers", "Scripts", "Optimize"]);
    const scopeMenu = getSelectMenus(payload)[0];
    expect(scopeMenu?.options?.[0]?.label).toBe("Alliance Overview");
    expect(scopeMenu?.options?.some((option: any) => String(option.label).includes("Alpha"))).toBe(true);
    expect(handlers.collect).toBeTypeOf("function");
  });

  it("switches between alliance overview, clan templates, empty states, and reminder scheduling", async () => {
    const { interaction, handlers } = createDashboardInteraction();
    const reminderUpsertSpy = vi
      .spyOn(recruitmentReminderService, "upsertRecruitmentReminderRule")
      .mockResolvedValue({
        id: "rule-1",
      } as any);

    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:overview:scripts"));
    expect(String(getLastPayload(interaction).embeds[0].toJSON().description)).toContain(
      "Stored template coverage",
    );
    expect(String(getLastPayload(interaction).embeds[0].toJSON().description)).toContain(
      "Discord=stored",
    );

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:overview:optimize"));
    let payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Optimization guide:");
    expect(String(payload.embeds[0].toJSON().description)).not.toContain("PST");
    expect(String(payload.embeds[0].toJSON().description)).toContain("Next:");

    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:scope", ["#AAA111"]));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Scope: Alpha (#AAA111)");
    expect(getButtonLabels(payload)).toEqual(["Discord", "Reddit", "Band", "Remind"]);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:band"));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain(
      "No stored template for this platform.",
    );
    const bandButtons = getButtonLabels(payload);
    expect(bandButtons).toContain("Remind");
    const bandButtonRow = getComponentJson(payload)[0];
    const remindButton = bandButtonRow?.components?.find((component: any) => component.label === "Remind");
    expect(remindButton?.disabled).toBe(true);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:discord"));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Recruitment Contents");
    expect(String(payload.embeds[0].toJSON().description)).toContain("Suggested Image URLs");
    const remindButtonRow = getComponentJson(payload)[0];
    const discordRemind = remindButtonRow?.components?.find((component: any) => component.label === "Remind");
    expect(discordRemind?.disabled).toBe(false);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:remind"));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Scheduling reminder for");
    expect(String(payload.embeds[0].toJSON().description)).toContain("Recommended:");
    expect(String(payload.embeds[0].toJSON().footer?.text)).toContain("Reminder Scheduling");
    expect(getSelectMenus(payload)).toHaveLength(3);

    const dayMenu = getSelectMenus(payload)[0];
    const dayValue = dayMenu?.options?.[0]?.value;
    expect(dayValue).toBeTypeOf("string");
    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:schedule:day", [dayValue]));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Select a day and time in 30-minute increments");
    expect(String(payload.embeds[0].toJSON().description)).toContain("Day choice:");
    const timeMenu = getSelectMenus(payload)[1];
    const selectedTimeValue = timeMenu?.options?.[0]?.value;
    expect(selectedTimeValue).toBeTypeOf("string");
    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:schedule:time", [selectedTimeValue]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:schedule:confirm"));

    expect(reminderUpsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        discordUserId: "user-1",
        clanTag: "AAA111",
        platform: "discord",
        timezone: "America/Los_Angeles",
        isActive: true,
        nextReminderAt: expect.any(Date),
        clanNameSnapshot: "Alpha",
        templateSubject: "Alpha Subject",
        templateBody: "Alpha body",
        templateImageUrls: ["https://img.example/alpha.png"],
      }),
    );
    expect(String(getLastPayload(interaction).content)).toContain("Reminder saved for Alpha (#AAA111).");
  });
});
