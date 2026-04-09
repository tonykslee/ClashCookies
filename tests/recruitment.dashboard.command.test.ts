import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsStore = new Map<string, string>();
const cooldownRows: Array<{
  clanTag: string;
  platform: "discord" | "reddit" | "band";
  expiresAt: Date;
}> = [];

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

vi.mock("../src/services/SettingsService", () => ({
  SettingsService: class {
    async get(key: string): Promise<string | null> {
      return settingsStore.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
      settingsStore.set(key, value);
    }

    async delete(key: string): Promise<void> {
      settingsStore.delete(key);
    }
  },
}));

vi.mock("../src/services/RecruitmentService", async () => {
  const actual = await vi.importActual("../src/services/RecruitmentService");
  return {
    ...actual,
    getRecruitmentTemplate: vi.fn(),
    startOrResetRecruitmentCooldown: vi.fn(async (input: { clanTag: string; platform: string; expiresAt: Date }) => {
      const normalizedTag = String(input.clanTag).trim().toUpperCase().replace(/^#/, "");
      const existingIndex = cooldownRows.findIndex(
        (row) => row.clanTag === normalizedTag && row.platform === input.platform,
      );
      const nextRow = {
        clanTag: normalizedTag,
        platform: input.platform,
        expiresAt: input.expiresAt,
      } as const;
      if (existingIndex >= 0) {
        cooldownRows[existingIndex] = nextRow;
      } else {
        cooldownRows.push(nextRow);
      }
    }),
  };
});

import { Recruitment, decorateRecruitmentDashboardTimeOptions } from "../src/commands/Recruitment";
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

function createDashboardInteraction(timezone: string | null = null) {
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

function getRowComponents(payload: any): Array<any> {
  return Array.isArray(payload?.components)
    ? payload.components.map((row: any) => (typeof row?.toJSON === "function" ? row.toJSON() : row))
    : [];
}

function getButtonLabels(payload: any): string[] {
  return getRowComponents(payload).flatMap((row) =>
    Array.isArray(row?.components)
      ? row.components
          .map((component: any) => (typeof component?.toJSON === "function" ? component.toJSON() : component))
          .filter((component: any) => typeof component?.label === "string")
          .map((component: any) => String(component.label))
      : [],
  );
}

function getSelectMenus(payload: any): Array<any> {
  return getRowComponents(payload).flatMap((row) =>
    Array.isArray(row?.components)
      ? row.components
          .map((component: any) => (typeof component?.toJSON === "function" ? component.toJSON() : component))
          .filter((component: any) => Array.isArray(component?.options))
      : [],
  );
}

describe("/recruitment dashboard", () => {
  it("registers an optional timezone argument on the dashboard subcommand", () => {
    const dashboardOption = Recruitment.options.find((option) => option.name === "dashboard");
    const timezoneOption = dashboardOption?.options?.find((option) => option.name === "timezone");
    expect(timezoneOption?.required).toBe(false);
    expect(timezoneOption?.autocomplete).toBe(true);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T17:45:00-07:00"));
    vi.clearAllMocks();
    settingsStore.clear();
    cooldownRows.length = 0;

    vi.mocked(recruitmentServiceModule.getRecruitmentTemplate).mockImplementation(
      async (guildId: string, clanTag: string, platform: string) => {
        if (guildId !== "guild-1") return null;
        const normalized = String(clanTag).trim().toUpperCase().replace(/^#/, "");
        if (normalized !== "AAA111") return null;
        if (platform === "discord") {
          return {
            subject: "Alpha Subject",
            body: "Alpha body",
            imageUrls: ["https://img.example/alpha.png"],
          } as any;
        }
        if (platform === "reddit") {
          return {
            subject: "Alpha Reddit",
            body: "Alpha reddit body",
            imageUrls: [],
          } as any;
        }
        if (platform === "band") {
          return {
            subject: null,
            body: "Alpha band body",
            imageUrls: [],
          } as any;
        }
        return null;
      },
    );

    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha", shortName: "ALP" },
      { tag: "#BBB222", name: "Beta", shortName: "BET" },
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
      {
        clanTag: "#AAA111",
        platform: "band",
        subject: null,
        body: "Alpha band body",
        imageUrls: [],
      },
    ]);
    prismaMock.recruitmentCooldown.findMany.mockImplementation(async () => [...cooldownRows]);
    prismaMock.recruitmentReminderRule.findFirst.mockResolvedValue(null);
    prismaMock.recruitmentReminderRule.create.mockResolvedValue({ id: "rule-1" });
    prismaMock.recruitmentReminderRule.update.mockResolvedValue({ id: "rule-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses UTC when timezone is omitted and no remembered timezone exists", async () => {
    const { interaction } = createDashboardInteraction();
    await Recruitment.run({} as any, interaction as any, {} as any);

    const payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Timezone: `UTC`");
    expect(settingsStore.get("user_timezone:user-1")).toBe("UTC");
    expect(getButtonLabels(payload)).toEqual(
      expect.arrayContaining(["TZ -", "TZ +", "Timers", "Scripts", "Optimize"]),
    );
  });

  it("falls back to the stored sync timezone when available", async () => {
    settingsStore.set("user_timezone:user-1", "America/Chicago");
    const { interaction } = createDashboardInteraction();

    await Recruitment.run({} as any, interaction as any, {} as any);

    const payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Timezone: `America/Chicago`");
    expect(settingsStore.get("user_timezone:user-1")).toBe("America/Chicago");
  });

  it("timezone buttons update the dashboard timezone and persist it", async () => {
    const { interaction, handlers } = createDashboardInteraction();
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:timezone:next"));
    let payload = getLastPayload(interaction);
    const nextTimezone = settingsStore.get("user_timezone:user-1");
    expect(nextTimezone).toBeTruthy();
    expect(nextTimezone).not.toBe("UTC");
    expect(String(payload.embeds[0].toJSON().description)).toContain(`Timezone: \`${nextTimezone}\``);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:timezone:prev"));
    payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain(
      `Timezone: \`${settingsStore.get("user_timezone:user-1")}\``,
    );
  });

  it("shows timezone only once in the reminder scheduling view", async () => {
    const { interaction, handlers } = createDashboardInteraction("America/Los_Angeles");
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:scope", ["AAA111"]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:discord"));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:remind"));

    const description = String(getLastPayload(interaction).embeds[0].toJSON().description);
    expect(description.match(/Timezone:/g)?.length).toBe(1);
  });

  it("renders scripts as a table and optimize as bullets", async () => {
    settingsStore.set("user_timezone:user-1", "UTC");
    const { interaction, handlers } = createDashboardInteraction();
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:overview:scripts"));
    let payload = getLastPayload(interaction);
    const scriptsDescription = String(payload.embeds[0].toJSON().description);
    const scriptsLines = scriptsDescription
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("```"));
    const headerLine = scriptsLines.find(
      (line) => line.includes("Clan") && line.includes("Discord") && line.includes("Reddit") && line.includes("Band"),
    );
    const alphaLine = scriptsLines.find((line) => line.trimStart().startsWith("ALP"));
    const betaLine = scriptsLines.find((line) => line.trimStart().startsWith("BET"));
    expect(headerLine).toBeTruthy();
    expect(alphaLine).toBeTruthy();
    expect(betaLine).toBeTruthy();
    const discordIndex = headerLine!.indexOf("Discord");
    const redditIndex = headerLine!.indexOf("Reddit");
    const bandIndex = headerLine!.indexOf("Band");
    expect(alphaLine!.length).toBe(headerLine!.length);
    expect(betaLine!.length).toBe(headerLine!.length);
    expect(alphaLine![discordIndex]).toBe("✓");
    expect(alphaLine![redditIndex]).toBe("✓");
    expect(alphaLine![bandIndex]).toBe("✓");
    expect(betaLine![discordIndex]).toBe(" ");
    expect(betaLine![redditIndex]).toBe(" ");
    expect(betaLine![bandIndex]).toBe(" ");
    expect(scriptsDescription).not.toContain(":white_check_mark:");
    expect(scriptsDescription).not.toContain("Alpha (#AAA111)");
    expect(scriptsDescription).not.toContain("Beta (#BBB222)");

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:overview:optimize"));
    payload = getLastPayload(interaction);
    const optimizeDescription = String(payload.embeds[0].toJSON().description);
    expect(optimizeDescription).toContain("- Discord");
    expect(optimizeDescription).toContain("  - Best windows:");
    expect(optimizeDescription).toContain("  - Rhythm:");
    expect(optimizeDescription).toContain("  - Next recommended slots:");
  });

  it("shows platform links and double-backtick body wrapping on clan views", async () => {
    const { interaction, handlers } = createDashboardInteraction("America/Los_Angeles");
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:scope", ["AAA111"]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:reddit"));
    let payload = getLastPayload(interaction);
    const redditDescription = String(payload.embeds[0].toJSON().description);
    expect(redditDescription).toContain("https://www.reddit.com/r/ClashOfClansRecruit/");
    expect(redditDescription).toContain("``Alpha reddit body``");

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:band"));
    payload = getLastPayload(interaction);
    const bandDescription = String(payload.embeds[0].toJSON().description);
    expect(bandDescription).toContain("https://www.band.us/band/67130116/post");
    expect(bandDescription).toContain("``Alpha band body``");
  });

  it("starts cooldowns from the dashboard and reflects them in timers", async () => {
    const { interaction, handlers } = createDashboardInteraction("UTC");
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:scope", ["AAA111"]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:discord"));
    const clanButtons = getButtonLabels(getLastPayload(interaction));
    expect(clanButtons).toEqual(
      expect.arrayContaining(["Discord", "Reddit", "Band", "Remind", "Start countdown"]),
    );
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:start-countdown"));

    const startCall = vi.mocked(recruitmentServiceModule.startOrResetRecruitmentCooldown).mock.calls[0]?.[0];
    expect(startCall).toEqual(
      expect.objectContaining({
        guildId: "guild-1",
        userId: "user-1",
        clanTag: "AAA111",
        platform: "discord",
      }),
    );
    expect(cooldownRows).toHaveLength(1);

    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:scope", ["overview"]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:overview:timers"));
    const payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Alpha (#AAA111)");
    expect(String(payload.embeds[0].toJSON().description)).toContain("<t:");
  });

  it("supports reminder scheduling from the clan view", async () => {
    const reminderUpsertSpy = vi
      .spyOn(recruitmentReminderService, "upsertRecruitmentReminderRule")
      .mockResolvedValue({
        id: "rule-1",
      } as any);
    const { interaction, handlers } = createDashboardInteraction("America/Los_Angeles");
    await Recruitment.run({} as any, interaction as any, {} as any);

    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:scope", ["AAA111"]));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:discord"));
    await handlers.collect?.(createButtonComponent("recruitment-dashboard:dashboard-1:clan:remind"));

    let payload = getLastPayload(interaction);
    expect(String(payload.embeds[0].toJSON().footer?.text)).toContain("Reminder Scheduling");
    expect(getSelectMenus(payload)).toHaveLength(3);
    expect(String(payload.embeds[0].toJSON().description)).toContain("Timezone: `America/Los_Angeles`");

    const dayMenu = getSelectMenus(payload)[0];
    expect(dayMenu?.options?.length).toBeGreaterThan(1);
    const dayValue = dayMenu?.options?.[1]?.value;
    expect(dayValue).toBeTypeOf("string");
    await handlers.collect?.(createSelectComponent("recruitment-dashboard:dashboard-1:schedule:day", [dayValue]));

    payload = getLastPayload(interaction);
    const timeMenu = getSelectMenus(payload)[1];
    const timeLabels = (timeMenu?.options ?? []).map((option: any) => String(option.label));
    expect(timeLabels.filter((label: string) => label.endsWith("🔥🔥"))).toHaveLength(2);
    expect(
      timeLabels.filter((label: string) => label.endsWith("🔥") && !label.endsWith("🔥🔥")),
    ).toHaveLength(2);
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
  });

  it("decorates reminder slot labels around multiple primary options without stacking markers", () => {
    const options = [
      { label: "Slot 1 🔥", value: "1", description: "" },
      { label: "Slot 2", value: "2", description: "" },
      { label: "Slot 3", value: "3", description: "" },
      { label: "Slot 4 🔥🔥", value: "4", description: "" },
      { label: "Slot 5", value: "5", description: "" },
      { label: "Slot 6", value: "6", description: "" },
      { label: "Slot 7", value: "7", description: "" },
    ];

    const decorated = decorateRecruitmentDashboardTimeOptions(options as any, [1, 4]);
    const labels = decorated.map((option) => option.label);
    expect(labels).toEqual([
      "Slot 1 🔥",
      "Slot 2 🔥🔥",
      "Slot 3 🔥",
      "Slot 4 🔥",
      "Slot 5 🔥🔥",
      "Slot 6 🔥",
      "Slot 7",
    ]);

    const rerendered = decorateRecruitmentDashboardTimeOptions(decorated, [1, 4]);
    expect(rerendered.map((option) => option.label)).toEqual(labels);
    expect(rerendered.map((option) => option.value)).toEqual(options.map((option) => option.value));
  });

  it("handles fire markers near the top and bottom of the option list", () => {
    const options = [
      { label: "Slot A", value: "A", description: "" },
      { label: "Slot B", value: "B", description: "" },
      { label: "Slot C", value: "C", description: "" },
    ];

    const topDecorated = decorateRecruitmentDashboardTimeOptions(options as any, [0]);
    expect(topDecorated.map((option) => option.label)).toEqual([
      "Slot A 🔥🔥",
      "Slot B 🔥",
      "Slot C",
    ]);

    const bottomDecorated = decorateRecruitmentDashboardTimeOptions(options as any, [2]);
    expect(bottomDecorated.map((option) => option.label)).toEqual([
      "Slot A",
      "Slot B 🔥",
      "Slot C 🔥🔥",
    ]);
  });
});
