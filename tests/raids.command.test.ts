import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshHelperMock = vi.hoisted(() => ({
  refreshRaidTrackedClanListWithQueueContext: vi.fn(),
}));

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
  },
  raidIntelDistrictLayoutMark: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

const cocQueueMock = vi.hoisted(() => {
  const state = { active: false };
  const defaultImpl = async (_context: unknown, run: () => Promise<unknown>) => {
    state.active = true;
    try {
      return await run();
    } finally {
      state.active = false;
    }
  };
  return {
    state,
    defaultImpl,
    runWithCoCQueueContext: vi.fn(defaultImpl),
  };
});

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/commands/TrackedClan", () => ({
  refreshRaidTrackedClanListWithQueueContext: refreshHelperMock.refreshRaidTrackedClanListWithQueueContext,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

import {
  handleRaidsButtonInteraction,
  handleRaidsIntelButtonInteraction,
  handleRaidsSelectMenuInteraction,
  handleRaidsIntelSelectMenuInteraction,
  Raids,
} from "../src/commands/Raids";

function makeTrackedClanRows() {
  return [
    {
      clanTag: "2QG2C08UP",
      name: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
    },
    {
      clanTag: "2RVGJYLC0",
      name: "Bravo Raid",
      upgrades: null,
      joinType: "closed",
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:30:00.000Z"),
    },
    {
      clanTag: "2XYZ12345",
      name: "Charlie Raid",
      upgrades: 400,
      joinType: "open",
      createdAt: new Date("2026-05-03T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:45:00.000Z"),
    },
  ];
}

function makeActiveSeason() {
  return {
    startTime: "2026-05-08T00:00:00.000Z",
    endTime: "2026-05-11T00:00:00.000Z",
    members: [{ attacks: 6 }, { attacks: 5 }],
    attackLog: [
      {
        defender: { name: "Defender One", tag: "#2QG2C08UQ" },
        districtCount: 2,
        districtsDestroyed: 2,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 5,
            attackCount: 3,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Wizard Valley",
            districtHallLevel: 4,
            attackCount: 2,
            destructionPercent: 100,
            stars: 3,
          },
        ],
      },
    ],
    defenseLog: [
      {
        attacker: { name: "QAZAQ TITANS", tag: "#2QG2C08UR" },
        attackCount: 30,
        districtCount: 2,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 5,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Barbarian Camp",
            districtHallLevel: 4,
            destructionPercent: 50,
            stars: 1,
          },
        ],
      },
    ],
    raidsCompleted: null,
  };
}

function makeOngoingSeason() {
  return {
    startTime: "2026-05-08T00:00:00.000Z",
    endTime: "2026-05-11T00:00:00.000Z",
    members: [{ attacks: 6 }, { attacks: 5 }],
    attackLog: [
      {
        defender: { name: "Defender One", tag: "#2QG2C08UQ" },
        attackCount: 1,
        districtCount: 2,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 5,
            attackCount: 3,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Wizard Valley",
            districtHallLevel: 4,
            attackCount: 0,
            destructionPercent: 0,
            stars: 0,
          },
        ],
      },
    ],
    defenseLog: [
      {
        attacker: { name: "Enemy Clan", tag: "#2QG2C08UR" },
        districtCount: 2,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 5,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Barbarian Camp",
            districtHallLevel: 4,
            destructionPercent: 50,
            stars: 1,
          },
        ],
      },
    ],
    raidsCompleted: null,
  };
}

function makeCompletedSeason() {
  return {
    startTime: "2026-05-08T00:00:00.000Z",
    endTime: "2026-05-11T00:00:00.000Z",
    members: [{ attacks: 6 }],
    attackLog: [
      {
        defender: { name: "Defender One", tag: "#2QG2C08UQ" },
        districtCount: 1,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 5,
            attackCount: 3,
            destructionPercent: 100,
            stars: 3,
          },
        ],
      },
    ],
    defenseLog: [],
    raidsCompleted: null,
  };
}

function makeEmptySeason() {
  return [];
}

function makeIntelDistrictSeason() {
  return {
    startTime: "2026-05-08T00:00:00.000Z",
    endTime: "2026-05-11T00:00:00.000Z",
    members: [{ attacks: 6 }, { attacks: 5 }],
    attackLog: [
      {
        defender: { name: "Defender One", tag: "#2QG2C08UQ" },
        districtCount: 2,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Peak",
            districtHallLevel: 10,
            attackCount: 2,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Barbarian Camp",
            districtHallLevel: 5,
            attackCount: 0,
            destructionPercent: 0,
            stars: 0,
          },
        ],
      },
      {
        defender: { name: "Defender Two", tag: "#2QG2C08UR" },
        districtCount: 2,
        districtsDestroyed: 1,
        districts: [
          {
            name: "Capital Hall",
            districtHallLevel: 10,
            attackCount: 1,
            destructionPercent: 100,
            stars: 3,
          },
          {
            name: "Skeleton Park",
            districtHallLevel: 4,
            attackCount: 0,
            destructionPercent: 0,
            stars: 0,
          },
        ],
      },
    ],
    defenseLog: [],
    raidsCompleted: null,
  };
}

function makeChatInteraction(options?: {
  clan?: string | null;
  focused?: string;
  subcommand?: string;
  upgrades?: number | null;
  districtArgs?: Record<string, string | null | undefined>;
}) {
  const clan = options?.clan ?? null;
  const focused = options?.focused ?? "";
  const subcommand = options?.subcommand ?? "overview";
  const upgrades = options?.upgrades ?? null;
  const districtArgs = options?.districtArgs ?? {};
  const interaction: any = {
    id: "raids-itx-1",
    commandName: "raids",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return clan;
        return Object.prototype.hasOwnProperty.call(districtArgs, name) ? districtArgs[name] ?? null : null;
      }),
      getInteger: vi.fn((name: string) => (name === "upgrades" ? upgrades : null)),
      getFocused: vi.fn().mockReturnValue({ name: "clan", value: focused }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
  return interaction;
}

function makeButtonInteraction(customId: string) {
  const interaction: any = {
    customId,
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    message: {
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
  return interaction;
}

function makeSelectInteraction(customId: string, value: string) {
  const interaction: any = {
    customId,
    values: [value],
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    deferUpdate: vi.fn().mockImplementation(async () => {
      interaction.deferred = true;
    }),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    message: {
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
  return interaction;
}

describe("/raids command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cocQueueMock.state.active = false;
    cocQueueMock.runWithCoCQueueContext.mockImplementation(cocQueueMock.defaultImpl);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    prismaMock.raidTrackedClan.findMany.mockResolvedValue(makeTrackedClanRows());
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValue([]);
    prismaMock.raidIntelDistrictLayoutMark.upsert.mockResolvedValue({
      id: 1,
      guildId: "guild-1",
      sourceClanTag: "2RVGJYLC0",
      raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
      defenderTag: "2QG2C08UQ",
      districtName: "Capital Hall",
      districtHallLevel: 5,
      layoutGrade: "CUSTOM_HARD",
      markedByDiscordUserId: "user-1",
      createdAt: new Date("2026-05-08T01:00:00.000Z"),
      updatedAt: new Date("2026-05-08T01:00:00.000Z"),
    });
    refreshHelperMock.refreshRaidTrackedClanListWithQueueContext.mockResolvedValue({
      refreshed: ["#AAA111"],
      joinTypeRefreshFailures: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the overview shell with dropdown and refresh button", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        if (tag === "#2QG2C08UP") {
          return [makeOngoingSeason()];
        }
        if (tag === "#2RVGJYLC0") {
          return [makeActiveSeason()];
        }
        return makeEmptySeason();
      }),
      getClan: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UR");
        return {
          type: "open",
          requiredTownhallLevel: 16,
          requiredBuilderBaseTrophies: 2600,
          requiredTrophies: 5000,
        };
      }),
    };
    const interaction = makeChatInteraction();

    await Raids.run({} as any, interaction as any, cocService as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("## Raid Clans");
    expect(description).toContain("\u2694\ufe0f [Alpha Raid]");
    expect(description).toContain("\ud83c\udf04 [Bravo Raid]");
    expect(description).toContain(`#2QG2C08UP`);
    expect(description).not.toContain("\ud83d\udd13 [Alpha Raid]");
    const alphaIndex = description.indexOf("\u2694\ufe0f [Alpha Raid]");
    const bravoIndex = description.indexOf("\ud83c\udf04 [Bravo Raid]");
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(bravoIndex).toBeGreaterThan(alphaIndex);
    const enemyLine = description
      .split("\n")
      .find((line: string) => line.includes("[QAZAQ TITANS]"));
    expect(enemyLine).toBeDefined();
    expect(enemyLine?.startsWith("- 🛡️ [QAZAQ TITANS]")).toBe(true);
    expect(enemyLine).toContain(`#2QG2C08UR`);
    expect(enemyLine).toContain("\u2014 1 districts remaining");
    expect(enemyLine?.startsWith("  -")).toBe(false);
    expect(description).not.toContain("  -");
    expect(description).not.toContain("Attacks:");
    expect(description).not.toContain("attacks used");
    expect(description).not.toContain("Raids completed:");
    expect(description).not.toContain("Requirements:");
    expect(cocService.getClan).toHaveBeenCalledTimes(1);

    const selectRow = payload.components[0]?.toJSON?.().components[0];
    expect(selectRow?.custom_id).toBe("raids:raids-itx-1:select");
    expect(selectRow?.options?.[0]?.label).toContain("Alpha Raid");
    expect(selectRow?.options?.[0]?.value).toBe("2QG2C08UP");
    expect(selectRow?.options?.[1]?.label).toContain("Bravo Raid");
    expect(selectRow?.options?.[1]?.value).toBe("2RVGJYLC0");
    expect(selectRow?.options?.[2]?.label).toContain("Charlie Raid");
    expect(selectRow?.options?.[2]?.value).toBe("2XYZ12345");

    const buttonIds = payload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toEqual(["raids:raids-itx-1:refresh"]);
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview",
      }),
      expect.any(Function),
    );
  });

  it("orders completed overview clans by intel grade score before stable fallback", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2QG2C08UP",
        name: "Alpha Raid",
        upgrades: 2210,
        joinType: "open",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:00:00.000Z"),
      },
      {
        clanTag: "2QG2C08UQ",
        name: "Bravo Raid",
        upgrades: null,
        joinType: "closed",
        createdAt: new Date("2026-05-02T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:30:00.000Z"),
      },
      {
        clanTag: "2QG2C08UR",
        name: "Charlie Raid",
        upgrades: 400,
        joinType: "open",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-08T11:45:00.000Z"),
      },
    ]);
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([
      {
        sourceClanTag: "2QG2C08UQ",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        layoutGrade: "CUSTOM_HARD",
      },
      {
        sourceClanTag: "2QG2C08UR",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        layoutGrade: "CUSTOM_MEDIUM",
      },
    ]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeCompletedSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction();

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    const bravoIndex = description.indexOf("\ud83c\udf04 [Bravo Raid]");
    const charlieIndex = description.indexOf("\ud83c\udf04 [Charlie Raid]");
    const alphaIndex = description.indexOf("\ud83c\udf04 [Alpha Raid]");
    expect(bravoIndex).toBeGreaterThanOrEqual(0);
    expect(charlieIndex).toBeGreaterThan(bravoIndex);
    expect(alphaIndex).toBeGreaterThan(charlieIndex);

    const selectRow = payload.components[0]?.toJSON?.().components[0];
    expect(selectRow?.options?.map((option: any) => option.value)).toEqual([
      "2QG2C08UQ",
      "2QG2C08UR",
      "2QG2C08UP",
    ]);
  });

  it("renders a read-only intel view for a tracked clan", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(tag).toBe("#2QG2C08UP");
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
      upgrades: 2299,
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("## Raid Intel");
    expect(description).toContain("Tracked clan: [Alpha Raid]");
    expect(description).toContain("`#2QG2C08UP`");
    expect(description).toContain("Upgrades: 2299");
    expect(description).toContain("Raid weekend: Active");
    expect(description).toContain("Select a district below, then choose a layout grade.");
    expect(description).toContain("### [Defender One]");
    expect(description).toContain("Capital Hall DH5 \u2014 Grade: Unmarked");
    expect(description).toContain("Wizard Valley DH4 \u2014 Grade: Unmarked");
    expect(payload.components).toHaveLength(2);
    const selectRow = payload.components[0]?.toJSON?.().components[0];
    expect(selectRow?.custom_id).toBe("raids:intel:raids-itx-1:select");
    expect(selectRow?.options?.[0]?.label).toContain("Defender One / Capital Hall");
    expect(selectRow?.options?.[0]?.description).toContain("Current: Unmarked");
    const refreshButton = payload.components[1]?.toJSON?.().components[0];
    expect(refreshButton?.custom_id).toBe("raids:intel:raids-itx-1:refresh");
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:intel",
      }),
      expect.any(Function),
    );
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).not.toHaveBeenCalled();
  });

  it("loads saved intel marks on the initial embed", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([
      {
        id: 1,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Peak",
        districtHallLevel: 10,
        layoutGrade: "CUSTOM_MEDIUM",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
      {
        id: 2,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UR",
        districtName: "Capital Hall",
        districtHallLevel: 10,
        layoutGrade: "CUSTOM_MEDIUM",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
      {
        id: 3,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Barbarian Camp",
        districtHallLevel: 5,
        layoutGrade: "DEFAULT",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeIntelDistrictSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Capital Peak DH10 — Grade: Custom - Medium");
    expect(description).toContain("Capital Hall DH10 — Grade: Custom - Medium");
    expect(description).toContain("Barbarian Camp DH5 — Grade: Default");
  });

  it("pre-marks district grades from slash args before rendering", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValueOnce([
      {
        id: 1,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Peak",
        districtHallLevel: 10,
        layoutGrade: "CUSTOM_HARD",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
      {
        id: 2,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UR",
        districtName: "Capital Hall",
        districtHallLevel: 10,
        layoutGrade: "CUSTOM_HARD",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
      {
        id: 3,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Barbarian Camp",
        districtHallLevel: 5,
        layoutGrade: "DEFAULT",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeIntelDistrictSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
      districtArgs: {
        capital_peak: "CUSTOM_HARD",
        barbarian_camp: "DEFAULT",
      },
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    const upsertDistrictNames = prismaMock.raidIntelDistrictLayoutMark.upsert.mock.calls
      .map(([input]: any[]) => input.create.districtName)
      .sort();
    expect(upsertDistrictNames).toEqual(["Barbarian Camp", "Capital Hall", "Capital Peak"]);

    const upsertGrades = prismaMock.raidIntelDistrictLayoutMark.upsert.mock.calls
      .map(([input]: any[]) => input.create.layoutGrade)
      .sort();
    expect(upsertGrades).toEqual(["CUSTOM_HARD", "CUSTOM_HARD", "DEFAULT"]);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Capital Peak DH10 — Grade: Custom - Hard");
    expect(description).toContain("Capital Hall DH10 — Grade: Custom - Hard");
    expect(description).toContain("Barbarian Camp DH5 — Grade: Default");
  });

  it("returns a clear failure message when a slash-arg district mark save fails", async () => {
    prismaMock.raidIntelDistrictLayoutMark.upsert.mockResolvedValueOnce(null);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeIntelDistrictSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
      districtArgs: {
        capital_peak: "CUSTOM_HARD",
      },
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Failed to save raid intel layout marks.",
    });
    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).toHaveBeenCalled();
    const responsePayload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(responsePayload.embeds).toBeUndefined();
    expect(responsePayload.components).toBeUndefined();
  });

  it("shows a skipped note when a slash arg district is missing from the current intel data", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeIntelDistrictSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
      districtArgs: {
        dragon_cliffs: "CUSTOM_EASY",
      },
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Skipped: Dragon Cliffs was not found in current intel data.");
  });

  it("does not attempt slash-arg writes when there is no active raid weekend", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => []),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
      districtArgs: {
        capital_peak: "CUSTOM_HARD",
      },
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toBe("No active raid weekend data available.");
  });

  it("shows district controls and reveals the selected district grade buttons", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValue([]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeActiveSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);
    const initialPayload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstDistrictKey = initialPayload.components[0]?.toJSON?.().components[0]?.options?.[0]?.value as string;
    expect(firstDistrictKey).toBeTruthy();

    const selectInteraction = makeSelectInteraction(
      "raids:intel:raids-itx-1:select",
      firstDistrictKey,
    );
    await handleRaidsIntelSelectMenuInteraction(selectInteraction as any, cocService as any);

    expect(selectInteraction.deferUpdate).toHaveBeenCalled();
    expect(selectInteraction.editReply).toHaveBeenCalled();
    expect(selectInteraction.message.edit).not.toHaveBeenCalled();
    const selectedPayload = selectInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const selectedDescription = selectedPayload.embeds[0].toJSON().description as string;
    expect(selectedDescription).toContain("Selected: [Defender One]");
    expect(selectedDescription).toContain("Select a district below, then choose a layout grade.");
    expect(selectedPayload.components).toHaveLength(3);
    const gradeButtons = selectedPayload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(gradeButtons).toEqual([
      "raids:intel:raids-itx-1:grade:DEFAULT",
      "raids:intel:raids-itx-1:grade:CUSTOM_HARD",
      "raids:intel:raids-itx-1:grade:CUSTOM_MEDIUM",
      "raids:intel:raids-itx-1:grade:CUSTOM_EASY",
    ]);
  });

  it("saves a selected district grade and rerenders the updated label", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 1,
          guildId: "guild-1",
          sourceClanTag: "2QG2C08UP",
          raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
          defenderTag: "2QG2C08UQ",
          districtName: "Capital Hall",
          districtHallLevel: 5,
          layoutGrade: "CUSTOM_HARD",
          markedByDiscordUserId: "user-1",
          createdAt: new Date("2026-05-08T01:00:00.000Z"),
          updatedAt: new Date("2026-05-08T01:00:00.000Z"),
        },
      ]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeActiveSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);
    const initialPayload = interaction.editReply.mock.calls[0]?.[0] as any;
    const firstDistrictKey = initialPayload.components[0]?.toJSON?.().components[0]?.options?.[0]?.value as string;

    const selectInteraction = makeSelectInteraction(
      "raids:intel:raids-itx-1:select",
      firstDistrictKey,
    );
    await handleRaidsIntelSelectMenuInteraction(selectInteraction as any, cocService as any);

    const gradeInteraction = makeButtonInteraction("raids:intel:raids-itx-1:grade:CUSTOM_HARD");
    const selectPayload = selectInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const selectedButtons = selectPayload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(selectedButtons).toContain("raids:intel:raids-itx-1:grade:CUSTOM_HARD");

    await handleRaidsIntelButtonInteraction(gradeInteraction as any, cocService as any);

    expect(prismaMock.raidIntelDistrictLayoutMark.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId_sourceClanTag_raidSeasonStartTime_defenderTag_districtName: expect.objectContaining({
            guildId: "guild-1",
            sourceClanTag: "2QG2C08UP",
            defenderTag: "2QG2C08UQ",
            districtName: "Capital Hall",
          }),
        }),
        create: expect.objectContaining({
          layoutGrade: "CUSTOM_HARD",
        }),
        update: expect.objectContaining({
          layoutGrade: "CUSTOM_HARD",
        }),
      }),
    );
    expect(gradeInteraction.deferUpdate).toHaveBeenCalled();
    expect(gradeInteraction.editReply).toHaveBeenCalled();
    expect(gradeInteraction.message.edit).not.toHaveBeenCalled();
    const gradePayload = gradeInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const gradeDescription = gradePayload.embeds[0].toJSON().description as string;
    expect(gradeDescription).toContain("Grade: Custom - Hard");
  });

  it("refreshes the raid intel view in place with queue-backed live detail loading", async () => {
    prismaMock.raidIntelDistrictLayoutMark.findMany.mockResolvedValue([
      {
        id: 1,
        guildId: "guild-1",
        sourceClanTag: "2QG2C08UP",
        raidSeasonStartTime: new Date("2026-05-08T00:00:00.000Z"),
        defenderTag: "2QG2C08UQ",
        districtName: "Capital Hall",
        districtHallLevel: 5,
        layoutGrade: "CUSTOM_MEDIUM",
        markedByDiscordUserId: "user-1",
        createdAt: new Date("2026-05-08T01:00:00.000Z"),
        updatedAt: new Date("2026-05-08T01:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(tag).toBe("#2QG2C08UP");
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(async () => ({ type: "open" })),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);
    const refreshInteraction = makeButtonInteraction("raids:intel:raids-itx-1:refresh");
    await handleRaidsIntelButtonInteraction(refreshInteraction as any, cocService as any);

    expect(refreshInteraction.deferUpdate).toHaveBeenCalled();
    expect(refreshInteraction.editReply).toHaveBeenCalled();
    expect(refreshInteraction.message.edit).not.toHaveBeenCalled();
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:intel:refresh",
      }),
      expect.any(Function),
    );
    const refreshedPayload = refreshInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const refreshedDescription = refreshedPayload.embeds[0].toJSON().description as string;
    expect(refreshedDescription).toContain("Grade: Custom - Medium");
  });

  it("rejects intel controls from another user and expires missing sessions safely", async () => {
    const strangerSelect = makeSelectInteraction("raids:intel:missing-session:select", "district-1");
    await handleRaidsIntelSelectMenuInteraction(strangerSelect as any, {
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    } as any);
    expect(strangerSelect.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "This raid intel view expired. Run /raids intel again.",
    });

    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [makeActiveSeason()]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });
    await Raids.run({} as any, interaction as any, cocService as any);
    const button = makeButtonInteraction("raids:intel:raids-itx-1:grade:CUSTOM_EASY");
    button.user.id = "someone-else";
    await handleRaidsIntelButtonInteraction(button as any, cocService as any);
    expect(button.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command user can control this raid intel view.",
    });
  });

  it("renders the clean no-active-season intel message", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(tag).toBe("#2QG2C08UP");
        return [];
      }),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toBe("No active raid weekend data available.");
  });

  it("renders the no-defender-intel message when the active season has no attack log", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async () => [
        {
          ...makeActiveSeason(),
          attackLog: [],
        },
      ]),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({
      clan: "2QG2C08UP",
      subcommand: "intel",
    });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("Raid weekend: Active");
    expect(description).toContain("No defender intel available yet.");
  });

  it("renders a single clan view with raid detail sections and back/refresh buttons", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(["#2QG2C08UP", "#2RVGJYLC0"]).toContain(tag);
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UR");
        return {
          type: "open",
          requiredTownhallLevel: 16,
          requiredBuilderBaseTrophies: 2600,
          requiredTrophies: 5000,
        };
      }),
    };
    const interaction = makeChatInteraction({ clan: "2RVGJYLC0" });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("## Raid Clan");
    expect(description).toContain("Join type: Closed");
    expect(description).not.toContain("Updated:");
    expect(description).toContain("Upgrades: —");
    expect(payload.embeds[0].toJSON().title).toBeUndefined();
    expect(description).toContain("Bravo Raid");
    expect(description).toContain("## Attacking");
    expect(description).toContain("### [Defender One]");
    expect(description).toContain("Capital Hall DH5 — 3 attacks");
    expect(description).toContain("## Defending");
    expect(description).toContain("🔓 [QAZAQ TITANS]");
    expect(description).toContain("`#2QG2C08UR`");
    expect(description).toContain("30 attacks used");
    expect(description).toContain("1 district remaining");
    expect(description).toContain("Requirements: TH16, Builder Base: 2600+ trophies, Ranked: 5000+ trophies");
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview:detail",
      }),
      expect.any(Function),
    );

    const buttonIds = payload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toEqual([
      "raids:raids-itx-1:back",
      "raids:raids-itx-1:refresh",
    ]);
  });

  it("renders a clean empty message when the selected clan has no active raid weekend", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#2RVGJYLC0") {
          return makeEmptySeason();
        }
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(),
    };
    const interaction = makeChatInteraction({ clan: "2RVGJYLC0" });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toBe("No active raid weekend data available.");
  });

  it("shows the no-tracked-clans message when intel has no configured raid clans", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([]);
    const interaction = makeChatInteraction({ subcommand: "intel" });

    await Raids.run({} as any, interaction as any, {
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    } as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No RAIDS tracked clans in the database. Use `/tracked-clan raid-tags` first.",
    });
  });

  it("prompts for a tracked clan when intel is missing the clan argument", async () => {
    const interaction = makeChatInteraction({ subcommand: "intel" });

    await Raids.run({} as any, interaction as any, {
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    } as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.options.getSubcommand).toHaveBeenCalledWith(false);
    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Choose a tracked RAID clan with `/raids intel clan:<tag>`.",
    });
  });

  it("returns a safe not-found message for an unknown intel clan", async () => {
    const interaction = makeChatInteraction({ subcommand: "intel", clan: "2PYLQGRJ" });

    await Raids.run({} as any, interaction as any, {
      getClanCapitalRaidSeasons: vi.fn(),
      getClan: vi.fn(),
    } as any);

    expect(interaction.editReply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "No tracked RAID clan matched #2PYLQGRJ.",
    });
  });

  it("supports raid clan autocomplete", async () => {
    const interaction = makeChatInteraction({ focused: "alp" });

    await Raids.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha Raid (#2QG2C08UP)", value: "2QG2C08UP" },
    ]);
  });

  it("switches to a single-clan view from the dropdown and can return to overview", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(["#2QG2C08UP", "#2RVGJYLC0"]).toContain(tag);
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(async (tag: string) => {
        expect(tag).toBe("#2QG2C08UR");
        return { type: "open" };
      }),
    };
    const interaction = makeChatInteraction();
    await Raids.run({} as any, interaction as any, cocService as any);

    const selectInteraction = makeSelectInteraction("raids:raids-itx-1:select", "2RVGJYLC0");
    await handleRaidsSelectMenuInteraction(selectInteraction as any, cocService as any);

    expect(selectInteraction.deferUpdate).toHaveBeenCalled();
    expect(selectInteraction.editReply).toHaveBeenCalled();
    expect(selectInteraction.message.edit).not.toHaveBeenCalled();
    const selectedPayload = selectInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const selectedDescription = selectedPayload.embeds[0].toJSON().description as string;
    expect(selectedDescription).toContain("## Raid Clan");
    expect(selectedDescription).toContain("## Attacking");
    expect(selectedDescription).toContain("## Defending");
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview:detail",
      }),
      expect.any(Function),
    );

    const backButton = makeButtonInteraction("raids:raids-itx-1:back");
    await handleRaidsButtonInteraction(backButton as any, cocService as any);

    expect(backButton.deferUpdate).toHaveBeenCalled();
    expect(backButton.editReply).toHaveBeenCalled();
    expect(backButton.message.edit).not.toHaveBeenCalled();
    const backPayload = backButton.editReply.mock.calls.at(-1)?.[0] as any;
    const backDescription = backPayload.embeds[0].toJSON().description as string;
    expect(backDescription).toContain("## Raid Clans");
  });

  it("refreshes the current raids view in place", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        expect(cocQueueMock.state.active).toBe(true);
        expect(["#2QG2C08UP", "#2RVGJYLC0"]).toContain(tag);
        return [makeActiveSeason()];
      }),
      getClan: vi.fn(async () => ({ type: "open" })),
    };
    const interaction = makeChatInteraction({ clan: "2RVGJYLC0" });
    await Raids.run({} as any, interaction as any, cocService as any);

    const refreshInteraction = makeButtonInteraction("raids:raids-itx-1:refresh");
    await handleRaidsButtonInteraction(refreshInteraction as any, cocService as any);

    expect(refreshHelperMock.refreshRaidTrackedClanListWithQueueContext).toHaveBeenCalled();
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "raids:overview:detail:refresh",
      }),
      expect.any(Function),
    );
    expect(refreshInteraction.editReply).toHaveBeenCalled();
    expect(refreshInteraction.message.edit).not.toHaveBeenCalled();
    const refreshedPayload = refreshInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    const refreshedDescription = refreshedPayload.embeds[0].toJSON().description as string;
    expect(refreshedDescription).toContain("## Attacking");
    expect(refreshedDescription).toContain("## Defending");
  });
});
