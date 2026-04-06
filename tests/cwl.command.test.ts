import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Cwl } from "../src/commands/Cwl";
import { handleCwlRotationImportButtonInteraction } from "../src/commands/Cwl";
import { handleCwlRotationImportSelectMenuInteraction } from "../src/commands/Cwl";
import { handleCwlRotationShowButtonInteraction } from "../src/commands/Cwl";
import {
  cwlRotationSheetService,
  type CwlRotationSheetImportPreview,
} from "../src/services/CwlRotationSheetService";
import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlStateService } from "../src/services/CwlStateService";

function makeInteraction(input: {
  group?: "rotations" | null;
  subcommand: "members" | "show" | "create" | "import" | "export";
  clan?: string | null;
  inwar?: boolean | null;
  day?: number | null;
  exclude?: string | null;
  overwrite?: boolean | null;
}) {
  return {
    user: { id: "111111111111111111" },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "exclude") return input.exclude ?? null;
        if (name === "visibility") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "inwar") return input.inwar ?? null;
        if (name === "overwrite") return input.overwrite ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === "day") return input.day ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAutocompleteInteraction(value: string, name: "clan" | "day" = "clan") {
  return {
    options: {
      getFocused: vi.fn(() => ({ name, value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function getDescription(interaction: any): string {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getUpdatedDescription(interaction: any): string {
  const payload = interaction.update.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getComponentButtonCustomIds(interaction: any): string[] {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  const ids: string[] = [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const button of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const buttonJson = typeof button?.toJSON === "function" ? button.toJSON() : button;
      const id =
        buttonJson?.custom_id ??
        buttonJson?.customId ??
        buttonJson?.data?.custom_id ??
        buttonJson?.data?.customId ??
        null;
      if (typeof id === "string" && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function getComponentSelectMenuCustomIds(interaction: any): string[] {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  const ids: string[] = [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const menu of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const menuJson = typeof menu?.toJSON === "function" ? menu.toJSON() : menu;
      const options = menuJson?.options ?? menuJson?.data?.options ?? [];
      if (!Array.isArray(options) || options.length <= 0) {
        continue;
      }
      const id =
        menuJson?.custom_id ??
        menuJson?.customId ??
        menuJson?.data?.custom_id ??
        menuJson?.data?.customId ??
        null;
      if (typeof id === "string" && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function getComponentCustomIds(interaction: any): string[] {
  return [...new Set([...getComponentButtonCustomIds(interaction), ...getComponentSelectMenuCustomIds(interaction)])];
}

function getComponentSelectMenuOptions(interaction: any): Array<{ label: string; value: string; description?: string }> {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const menu of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const menuJson = typeof menu?.toJSON === "function" ? menu.toJSON() : menu;
      const options = menuJson?.options ?? menuJson?.data?.options ?? [];
      if (Array.isArray(options) && options.length > 0) {
        return options.map((option: any) => ({
          label: String(option?.label ?? ""),
          value: String(option?.value ?? ""),
          description: option?.description ? String(option.description) : undefined,
        }));
      }
    }
  }
  return [];
}

function makeParticipationCounts(entries: Array<[string, number]>): Map<string, number> {
  return new Map(entries);
}

describe("/cwl command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    vi.spyOn(cwlRotationSheetService, "buildImportPreview");
    vi.spyOn(cwlRotationSheetService, "confirmImport");
    vi.spyOn(cwlRotationSheetService, "exportActivePlans");
    vi.spyOn(cwlRotationService, "listActivePlanExports");
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockResolvedValue(null);
    vi.spyOn(cwlRotationService, "validatePlanDay");
    vi.spyOn(cwlStateService, "getParticipationCountsForClanDay").mockResolvedValue(new Map());
  });

  it("renders the persisted season roster with current round summary for /cwl members", async () => {
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#P1",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: "111111111111111111",
        linkedDiscordUsername: "alpha-user",
        daysParticipated: 2,
        currentRound: {
          roundDay: 1,
          roundState: "preparation",
          inCurrentLineup: true,
          attacksUsed: 0,
          attacksAvailable: 0,
          opponentTag: "#OPP1",
          opponentName: "Opponent One",
          phaseEndsAt: new Date("2026-04-03T12:00:00.000Z"),
        },
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: null,
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-02T00:00:00.000Z"),
      members: [],
    });
    const interaction = makeInteraction({
      subcommand: "members",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(getDescription(interaction)).toContain("Season: 2026-04");
    expect(getDescription(interaction)).toContain("CWL Alpha (#2QG2C08UP) - Day 1 Preparation vs Opponent One (#OPP1)");
    expect(getDescription(interaction)).toContain("Alpha `#P1` - days 2 - <@111111111111111111> - preparation 0/0");
  });

  it("returns a clear message when /cwl members inwar:true has no active persisted round", async () => {
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(null);
    const interaction = makeInteraction({
      subcommand: "members",
      clan: "#2QG2C08UP",
      inwar: true,
    });

    await Cwl.run({} as any, interaction as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "No active CWL round is persisted for #2QG2C08UP.",
    );
  });

  it("renders created-plan output with warnings for /cwl rotations create", async () => {
    vi.spyOn(cwlRotationService, "createPlan").mockResolvedValue({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      version: 2,
      lineupSize: 15,
      warnings: ["Could not reach 5 planned CWL days for: Alpha (#P1) -> 4/5"],
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      exclude: "#P9",
      overwrite: true,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlan).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      excludeTagsRaw: "#P9",
      overwrite: true,
    });
    expect(getDescription(interaction)).toContain("Created CWL rotation plan for #2QG2C08UP.");
    expect(getDescription(interaction)).toContain("Version: 2");
    expect(getDescription(interaction)).toContain("Could not reach 5 planned CWL days");
  });

  it("renders overview status lines for /cwl rotations show with no clan filter", async () => {
    vi.spyOn(cwlRotationService, "listOverview").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        roundDay: 3,
        status: "mismatch",
        missingExpectedPlayerTags: ["#P2"],
        extraActualPlayerTags: ["#P3"],
      },
      {
        season: "2026-04",
        clanTag: "#9GLGQCCU",
        clanName: "CWL Beta",
        version: 1,
        roundDay: 3,
        status: "complete",
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
      },
    ]);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("CWL Alpha (#2QG2C08UP) - day 3 mismatch - missing #P2 - extra #P3");
    expect(getDescription(interaction)).toContain("CWL Beta (#9GLGQCCU) - day 3 complete");
  });

  it("renders one merged CWL day per page for /cwl rotations show", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: "1 warning",
        excludedPlayerTags: ["#P9"],
        days: [
          {
            roundDay: 1,
            lineupSize: 3,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: false, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 2 },
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 3 },
            ],
            actual: null,
          },
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(1);
    vi.mocked(cwlRotationService.validatePlanDay)
      .mockResolvedValueOnce({
        actualAvailable: true,
        complete: false,
        missingExpectedPlayerTags: ["#QGRJ2222", "#CUV02898"],
        extraActualPlayerTags: ["#VJQ28888"],
        actualPlayerTags: ["#PYLQ0289", "#VJQ28888"],
        actualPlayerNames: ["Alpha", "Charlie"],
      } as any)
      .mockResolvedValueOnce({
        actualAvailable: true,
        complete: true,
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
        actualPlayerTags: ["#VJQ28888", "#CUV02898"],
        actualPlayerNames: ["Charlie", "Delta"],
      } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockImplementation(async ({ throughRoundDay }) => {
      if (throughRoundDay === 1) {
        return makeParticipationCounts([
          ["#PYLQ0289", 1],
          ["#VJQ28888", 1],
          ["#QGRJ2222", 0],
          ["#CUV02898", 0],
        ]);
      }
      if (throughRoundDay === 2) {
        return makeParticipationCounts([
          ["#PYLQ0289", 1],
          ["#VJQ28888", 2],
          ["#QGRJ2222", 0],
          ["#CUV02898", 1],
        ]);
      }
      return new Map();
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(vi.mocked(cwlRotationService.listActivePlanExports)).toHaveBeenCalledWith({
      season: "2026-04",
      clanTags: ["#2QG2C08UP"],
    });
    expect(getDescription(interaction)).toContain("Warnings: 1 warning");
    expect(getDescription(interaction)).toContain("Excluded: #P9");
    expect(getDescription(interaction)).toContain("Day 1");
    expect(getDescription(interaction)).toContain(":white_check_mark: Alpha (#PYLQ0289) | War count: 1");
    expect(getDescription(interaction)).toContain(
      ":warning: Charlie (#VJQ28888) | War count: 1 - Expected Bravo (#QGRJ2222)",
    );
    expect(getDescription(interaction)).toContain(":x: Bravo (#QGRJ2222) | War count: 0");
    expect(getDescription(interaction)).toContain(":x: Delta (#CUV02898) | War count: 0");
    expect(getDescription(interaction)).not.toContain(":x: Hotel (#JQJQ2222)");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
    expect(getComponentButtonCustomIds(interaction)).toHaveLength(2);

    const nextButtonId = getComponentButtonCustomIds(interaction).find((id) => id.endsWith(":1"));
    expect(nextButtonId).toBeTruthy();
    const buttonInteraction = {
      customId: nextButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationShowButtonInteraction(buttonInteraction as any);

    expect(getUpdatedDescription(buttonInteraction)).toContain("Day 2");
    expect(getUpdatedDescription(buttonInteraction)).toContain(
      ":white_check_mark: Charlie (#VJQ28888) | War count: 2",
    );
    expect(getUpdatedDescription(buttonInteraction)).toContain(
      ":white_check_mark: Delta (#CUV02898) | War count: 1",
    );
    expect(getUpdatedDescription(buttonInteraction)).not.toContain("Actual:");
    expect(getUpdatedDescription(buttonInteraction)).not.toContain("Status:");
  });

  it("renders the prep-day page with merged check marks during overlap", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 3,
            lineupSize: 2,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
          {
            roundDay: 4,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(4);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 4");
    expect(getDescription(interaction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getDescription(interaction)).toContain(":white_check_mark: Delta (#CUV02898) | War count: 1");
    expect(getDescription(interaction)).not.toContain("Day 3");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("renders only the requested day when /cwl rotations show is day-filtered", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 2,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 2");
    expect(getDescription(interaction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getDescription(interaction)).toContain(":white_check_mark: Delta (#CUV02898) | War count: 1");
    expect(getDescription(interaction)).not.toContain("Day 1");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
    expect(getComponentButtonCustomIds(interaction)).toHaveLength(0);
  });

  it("keeps actual lineup unavailable for far-future /cwl rotations show days", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 7,
            lineupSize: 2,
            rows: [
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 0 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: false,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: [],
      actualPlayerNames: [],
    } as any);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 7,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 7");
    expect(getDescription(interaction)).toContain("Actual lineup unavailable");
    expect(getDescription(interaction)).toContain(":x: Hotel (#JQJQ2222) | War count: 0");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("shows zero war count for a day-2 benched member who has not actually participated yet", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2C0UURLQU",
        clanName: "Rising Crowns",
        version: 2,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#2JVRPVGLQ", playerName: "ChipsAreTasty", subbedOut: true, assignmentOrder: 0 },
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: false,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: [],
      actualPlayerNames: [],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#2JVRPVGLQ", 0],
        ["#PYLQ0289", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2C0UURLQU",
      day: 2,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 2");
    expect(getDescription(interaction)).toContain("Actual lineup unavailable");
    expect(getDescription(interaction)).toContain(":x: ChipsAreTasty (#2JVRPVGLQ) | War count: 0");
    expect(getDescription(interaction)).not.toContain("War count: 1");
  });

  it("appends trailing missing expected rows when actual lineup runs short", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 3,
            lineupSize: 3,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Echo", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Foxtrot", subbedOut: false, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Golf", subbedOut: false, assignmentOrder: 2 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: false,
      missingExpectedPlayerTags: ["#QGRJ2222", "#CUV02898"],
      extraActualPlayerTags: ["#VJQ28888"],
      actualPlayerTags: ["#PYLQ0289", "#VJQ28888"],
      actualPlayerNames: ["Echo", "Zulu"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#PYLQ0289", 1],
        ["#VJQ28888", 0],
        ["#QGRJ2222", 0],
        ["#CUV02898", 0],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 3,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain(":white_check_mark: Echo (#PYLQ0289)");
    expect(getDescription(interaction)).toContain(
      ":warning: Zulu (#VJQ28888) | War count: 0 - Expected Foxtrot (#QGRJ2222)",
    );
    expect(getDescription(interaction)).toContain(":x: Foxtrot (#QGRJ2222) | War count: 0");
    expect(getDescription(interaction)).toContain(":x: Golf (#CUV02898) | War count: 0");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("shows unexpected actual members with zero war count when they are absent from the plan", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 5,
            lineupSize: 1,
            rows: [
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 0 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: ["#VJQ28888"],
      actualPlayerTags: ["#VJQ28888"],
      actualPlayerNames: ["Visitor"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([["#VJQ28888", 0]]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 5,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain(":warning: Visitor (#VJQ28888) | War count: 0");
    expect(getDescription(interaction)).not.toContain(":x: Hotel (#JQJQ2222)");
  });

  it("renders an import preview before save and confirms only after a button interaction", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [
                {
                  playerTag: "#PYLQ0289",
                  playerName: "Alpha",
                  subbedOut: false,
                  assignmentOrder: 0,
                },
                {
                  playerTag: "#QGRJ2222",
                  playerName: "Bravo",
                  subbedOut: true,
                  assignmentOrder: 1,
                },
              ],
              members: [
                {
                  playerTag: "#PYLQ0289",
                  playerName: "Alpha",
                  subbedOut: false,
                  assignmentOrder: 0,
                },
                {
                  playerTag: "#QGRJ2222",
                  playerName: "Bravo",
                  subbedOut: true,
                  assignmentOrder: 1,
                },
              ],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha | #PYLQ0289 | 12 | IN",
              rawPlayerNameSnippet: "Alpha",
              parsedPlayerTag: "#PYLQ0289",
              parsedPlayerName: "Alpha",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: true, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#PYLQ0289",
              resolvedPlayerName: "Alpha",
              ignored: false,
            },
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravo | #QGRJ2222 | 8 | ",
              rawPlayerNameSnippet: "Bravo",
              parsedPlayerTag: "#QGRJ2222",
              parsedPlayerName: "Bravo",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: true, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: false, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#QGRJ2222",
              resolvedPlayerName: "Bravo",
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: [],
    };
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationSheetService.buildImportPreview).toHaveBeenCalledWith({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      overwrite: false,
    });
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();
    expect(getDescription(interaction)).toContain("Importable clans: 1 / 1");
    expect(getDescription(interaction)).toContain("Clan: CWL Alpha (#2QG2C08UP)");
    expect(getDescription(interaction)).toContain("Day: Day 1");
    expect(getDescription(interaction)).toContain(":black_circle: Alpha #PYLQ0289 | Alpha");
    expect(getDescription(interaction)).toContain(":x: Bravo #QGRJ2222 | Bravo");
    expect(getDescription(interaction)).not.toContain("Alpha | #PYLQ0289 | 12 | IN");
    expect(getDescription(interaction)).not.toContain("Bravo | #QGRJ2222 | 8 |");

    expect(new Set(getComponentCustomIds(interaction)).size).toBe(getComponentCustomIds(interaction).length);
    expect(getComponentSelectMenuCustomIds(interaction)).toHaveLength(1);
    expect(getComponentSelectMenuOptions(interaction).map((option) => option.label)).toEqual(
      expect.arrayContaining([expect.stringContaining("CWL Alpha - 2/2")]),
    );

    const nextDayId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":preview-day:next:"));
    expect(nextDayId).toBeTruthy();
    const nextDayInteraction = {
      customId: nextDayId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(nextDayInteraction as any);
    expect(getUpdatedDescription(nextDayInteraction)).toContain("Day: Day 2");
    expect(getUpdatedDescription(nextDayInteraction)).toContain(":x: Alpha #PYLQ0289");
    expect(getUpdatedDescription(nextDayInteraction)).toContain(":black_circle: Bravo #QGRJ2222");

    const customIds = getComponentButtonCustomIds(nextDayInteraction);
    expect(customIds.some((id) => id.includes(":confirm:"))).toBe(true);

    const confirmId = customIds.find((id) => id.includes(":confirm:"));
    expect(confirmId).toBeTruthy();
    const confirmInteraction = {
      customId: confirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(confirmInteraction as any);

    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(confirmInteraction.deferUpdate).toHaveBeenCalled();
    expect(confirmInteraction.editReply).toHaveBeenCalled();
  });

  it("switches preview clans directly, preserves the selected day, and surfaces unavailable clans for that day", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [{ playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 }],
              members: [{ playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 }],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha | #PYLQ0289 | IN",
              parsedPlayerTag: "#PYLQ0289",
              parsedPlayerName: "Alpha",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: true, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#PYLQ0289",
              resolvedPlayerName: "Alpha",
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          tabTitle: "CWL Beta roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [{ playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 0 }],
              members: [{ playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 0 }],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-beta-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Beta roster",
              clanTag: "#9GLGQCCU",
              clanName: "CWL Beta",
              rawText: "Bravo | #QGRJ2222 | OUT",
              rawPlayerNameSnippet: null,
              parsedPlayerTag: "#QGRJ2222",
              parsedPlayerName: "Bravo",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: true, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: false, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#QGRJ2222",
              resolvedPlayerName: "Bravo",
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#7X7X7X7X",
          clanName: "CWL Gamma",
          tabTitle: "CWL Gamma roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "No parsed rows",
          warnings: ["No parsed rows."],
          structuralRowCount: 2,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [],
          days: [],
          parsedRows: [],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["No parsed rows."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Clan: CWL Alpha (#2QG2C08UP)");
    expect(getDescription(interaction)).toContain("Day: Day 1");

    const clanOptions = getComponentSelectMenuOptions(interaction);
    expect(clanOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CWL Alpha - 1/1"),
        expect.stringContaining("CWL Beta - 1/1"),
        expect.stringContaining("CWL Gamma - 0/0"),
      ]),
    );
    expect(clanOptions.find((option) => option.label.includes("CWL Gamma"))?.description).toContain(
      "No usable rows for Day 1",
    );

    const clanSelectId = getComponentSelectMenuCustomIds(interaction).find((id) => id.includes(":preview-clan:"));
    expect(clanSelectId).toBeTruthy();
    const unavailableClanInteraction = {
      customId: clanSelectId,
      values: ["#7X7X7X7X"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(unavailableClanInteraction as any);
    expect(unavailableClanInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no usable rows for Day 1"),
        ephemeral: true,
      }),
    );

    const betaClanInteraction = {
      customId: clanSelectId,
      values: ["#9GLGQCCU"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(betaClanInteraction as any);
    expect(getUpdatedDescription(betaClanInteraction)).toContain("Clan: CWL Beta (#9GLGQCCU)");
    expect(getUpdatedDescription(betaClanInteraction)).toContain("Day: Day 1");
    expect(getUpdatedDescription(betaClanInteraction)).toContain(":x: Bravo #QGRJ2222");
    expect(getUpdatedDescription(betaClanInteraction)).not.toContain("Bravo | #QGRJ2222 | OUT");

    const betaNextDayId = getComponentButtonCustomIds(betaClanInteraction).find((id) => id.includes(":preview-day:next:"));
    expect(betaNextDayId).toBeTruthy();
    const betaNextDayInteraction = {
      customId: betaNextDayId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportButtonInteraction(betaNextDayInteraction as any);
    expect(getUpdatedDescription(betaNextDayInteraction)).toContain("Clan: CWL Beta (#9GLGQCCU)");
    expect(getUpdatedDescription(betaNextDayInteraction)).toContain("Day: Day 2");
  });

  it("forces unresolved import rows through review before save and allows inline remap", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravoo | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravoo",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#QGRJ2222", playerName: "Bravo", score: 0.87 },
              ],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
              ],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["1 row need review."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(getComponentButtonCustomIds(interaction)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":review:"),
        expect.stringContaining(":confirm:"),
      ]),
    );
    expect(getDescription(interaction)).toContain(":warning: Bravoo");

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);

    expect(getUpdatedDescription(reviewInteraction)).toContain("Review rows: 1");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Sheet row: 4");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Raw: Bravoo | 12 | IN");
    expect(new Set(getComponentButtonCustomIds(reviewInteraction)).size).toBe(getComponentButtonCustomIds(reviewInteraction).length);

    const reviewButtonIds = getComponentButtonCustomIds(reviewInteraction);
    const legacyReviewPageId = reviewButtonIds.find((id) => id.includes(":review-page:"));
    expect(legacyReviewPageId).toBeTruthy();
    const legacyReviewInteraction = {
      customId: String(legacyReviewPageId).replace(":review-page:prev:", ":review-page:").replace(":review-page:next:", ":review-page:"),
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(legacyReviewInteraction as any);
    expect(getUpdatedDescription(legacyReviewInteraction)).toContain("Sheet row: 4");

    const selectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(selectId).toBeTruthy();
    const selectInteraction = {
      customId: selectId,
      values: ["tag:#QGRJ2222"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(selectInteraction as any);

    expect(getUpdatedDescription(selectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(selectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();

    const confirmId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":confirm:"));
    expect(confirmId).toBeTruthy();
    const confirmClanInteraction = {
      customId: confirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(confirmClanInteraction as any);

    expect(getUpdatedDescription(confirmClanInteraction)).toContain("Importable clans: 1 / 1");
    expect(getUpdatedDescription(confirmClanInteraction)).toContain("CWL Alpha");
    expect(getUpdatedDescription(confirmClanInteraction)).not.toContain(":warning:");
    expect(getUpdatedDescription(confirmClanInteraction)).toContain(":black_circle: Bravo #QGRJ2222");
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();

    const saveId = getComponentButtonCustomIds(confirmClanInteraction).find((id) => id.includes(":confirm:"));
    expect(saveId).toBeTruthy();
    const saveInteraction = {
      customId: saveId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(saveInteraction as any);

    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(saveInteraction.deferUpdate).toHaveBeenCalled();
    expect(saveInteraction.editReply).toHaveBeenCalled();
  });

  it("keeps review state isolated per clan and requires a clan confirmation boundary", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          trackedRosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Alpha-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#PYLQ0289", playerName: "Alpha", score: 0.9 },
              ],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          tabTitle: "CWL Beta roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          trackedRosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-beta-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Beta roster",
              clanTag: "#9GLGQCCU",
              clanName: "CWL Beta",
              rawText: "Bravo-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravo-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#QGRJ2222", playerName: "Bravo", score: 0.9 },
              ],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["2 rows need review."],
    };
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 2,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Beta roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);
    expect(getUpdatedDescription(reviewInteraction)).toContain("Clan: CWL Alpha");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Review rows: 1");

    const alphaOptions = getComponentSelectMenuOptions(reviewInteraction).map((option) => option.label);
    expect(alphaOptions).toEqual(expect.arrayContaining(["Alpha", "Ignore this row"]));
    expect(alphaOptions).not.toContain("Bravo");

    const alphaSelectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(alphaSelectId).toBeTruthy();
    const alphaSelectInteraction = {
      customId: alphaSelectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(alphaSelectInteraction as any);
    expect(getUpdatedDescription(alphaSelectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(alphaSelectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );

    const alphaConfirmId = getComponentButtonCustomIds(alphaSelectInteraction).find((id) => id.includes(":confirm:"));
    expect(alphaConfirmId).toBeTruthy();
    const alphaConfirmInteraction = {
      customId: alphaConfirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(alphaConfirmInteraction as any);
    expect(getUpdatedDescription(alphaConfirmInteraction)).toContain("Clan: CWL Beta");

    const betaOptions = getComponentSelectMenuOptions(alphaConfirmInteraction).map((option) => option.label);
    expect(betaOptions).toEqual(expect.arrayContaining(["Bravo", "Ignore this row"]));
    expect(betaOptions).not.toContain("Alpha");

    const staleAlphaInteraction = {
      customId: alphaSelectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(staleAlphaInteraction as any);
    expect(staleAlphaInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("expired"),
        ephemeral: true,
      }),
    );

    const betaSelectId = getComponentSelectMenuCustomIds(alphaConfirmInteraction).find((id) => id.includes(":resolve:"));
    expect(betaSelectId).toBeTruthy();
    const betaSelectInteraction = {
      customId: betaSelectId,
      values: ["tag:#QGRJ2222"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(betaSelectInteraction as any);
    expect(getUpdatedDescription(betaSelectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(betaSelectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );

    const betaConfirmId = getComponentButtonCustomIds(betaSelectInteraction).find((id) => id.includes(":confirm:"));
    expect(betaConfirmId).toBeTruthy();
    const betaConfirmInteraction = {
      customId: betaConfirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(betaConfirmInteraction as any);
    expect(getUpdatedDescription(betaConfirmInteraction)).toContain("Importable clans: 2 / 2");

    const saveId = getComponentButtonCustomIds(betaConfirmInteraction).find((id) => id.includes(":confirm:"));
    expect(saveId).toBeTruthy();
    const saveInteraction = {
      customId: saveId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(saveInteraction as any);
    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(saveInteraction.deferUpdate).toHaveBeenCalled();
    expect(saveInteraction.editReply).toHaveBeenCalled();
  });

  it("offers remaining tracked players as fallback mappings and prevents duplicate row mappings", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "2 rows need review before save.",
          warnings: ["2 rows need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 2,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          trackedRosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Alpha-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
            {
              rowId: "cwl-alpha-roster:5",
              sheetRowNumber: 5,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravo-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravo-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["2 rows need review."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue({
      season: "2026-04",
      saved: [],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);

    const initialOptions = getComponentSelectMenuOptions(reviewInteraction);
    expect(initialOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining(["Alpha", "Bravo", "Ignore this row"]),
    );
    expect(new Set(getComponentButtonCustomIds(reviewInteraction)).size).toBe(getComponentButtonCustomIds(reviewInteraction).length);

    const selectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(selectId).toBeTruthy();
    const firstSelectInteraction = {
      customId: selectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(firstSelectInteraction as any);
    const secondOptions = getComponentSelectMenuOptions(firstSelectInteraction);
    expect(secondOptions.map((option) => option.label)).not.toContain("Alpha");
    expect(secondOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining(["Bravo", "Ignore this row"]),
    );
    expect(new Set(getComponentButtonCustomIds(firstSelectInteraction)).size).toBe(getComponentButtonCustomIds(firstSelectInteraction).length);

    const nextReviewButtonId = getComponentButtonCustomIds(reviewInteraction).find((id) => id.includes(":review-page:next:"));
    expect(nextReviewButtonId).toBeTruthy();
    const nextReviewInteraction = {
      customId: nextReviewButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(nextReviewInteraction as any);
    expect(getUpdatedDescription(nextReviewInteraction)).toContain("Sheet row: 5");
    expect(getUpdatedDescription(nextReviewInteraction)).toContain("Raw: Bravo-ish | 12 | IN");
    expect(new Set(getComponentButtonCustomIds(nextReviewInteraction)).size).toBe(getComponentButtonCustomIds(nextReviewInteraction).length);

    const legacyPrevButtonId = getComponentButtonCustomIds(nextReviewInteraction)
      .find((id) => id.includes(":review-page:prev:"))
      ?.replace(":review-page:prev:", ":review-page:");
    expect(legacyPrevButtonId).toBeTruthy();
    const legacyPrevInteraction = {
      customId: legacyPrevButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(legacyPrevInteraction as any);
    expect(getUpdatedDescription(legacyPrevInteraction)).toContain("Sheet row: 5");
  });

  it("omits raw snippets when the preview would otherwise exceed Discord limits", async () => {
    const rosterRows = Array.from({ length: 110 }, (_, index) => {
      const playerTag = `#PX${String(index).padStart(4, "0")}`;
      const playerName = `Player ${index + 1}`;
      return { playerTag, playerName };
    });
    const parsedRows = rosterRows.map((row, index) => ({
      rowId: `cwl-alpha-roster:${index + 3}`,
      sheetRowNumber: index + 3,
      tabTitle: "CWL Alpha roster",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      rawText: `${row.playerName} | ${row.playerTag} | IN | THIS RAW SNIPPET SHOULD BE OMITTED ${String(index).padStart(3, "0")}`,
      rawPlayerNameSnippet: row.playerName,
      parsedPlayerTag: row.playerTag,
      parsedPlayerName: row.playerName,
      classification: "exact_match" as const,
      reason: null,
      suggestions: [],
      dayRows: [
        { roundDay: 1, subbedOut: false, assignmentOrder: index },
        { roundDay: 2, subbedOut: true, assignmentOrder: index },
        { roundDay: 3, subbedOut: true, assignmentOrder: index },
        { roundDay: 4, subbedOut: true, assignmentOrder: index },
        { roundDay: 5, subbedOut: true, assignmentOrder: index },
        { roundDay: 6, subbedOut: true, assignmentOrder: index },
        { roundDay: 7, subbedOut: true, assignmentOrder: index },
      ],
      resolvedPlayerTag: row.playerTag,
      resolvedPlayerName: row.playerName,
      ignored: false,
    }));
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows,
          days: [
            {
              roundDay: 1,
              lineupSize: rosterRows.length,
              rows: rosterRows.map((row, index) => ({
                playerTag: row.playerTag,
                playerName: row.playerName,
                subbedOut: false,
                assignmentOrder: index,
              })),
              members: rosterRows.map((row, index) => ({
                playerTag: row.playerTag,
                playerName: row.playerName,
                subbedOut: false,
                assignmentOrder: index,
              })),
            },
          ],
          parsedRows,
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: [],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const description = getDescription(interaction);
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain("Day: Day 1");
    expect(description).toContain("Player 1 #PX0000");
    expect(description).toContain(`Player ${rosterRows.length} #PX${String(rosterRows.length - 1).padStart(4, "0")}`);
    expect(description).not.toContain("THIS RAW SNIPPET SHOULD BE OMITTED");
  });

  it("surfaces a clear message when the import sheet link format is unsupported", async () => {
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockRejectedValueOnce(
      new Error(
        "Unsupported Google Sheets link format. Use a standard /spreadsheets/d/<id> link or a published /spreadsheets/d/e/<published-id>/pubhtml link.",
      ),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "not-a-valid-link";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls[0]?.[0] ?? "")).toContain(
      "Unsupported Google Sheets link format",
    );
  });

  it("exports active CWL planner data to a new public sheet", async () => {
    vi.mocked(cwlRotationSheetService.exportActivePlans).mockResolvedValue({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      tabCount: 1,
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "export",
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationSheetService.exportActivePlans).toHaveBeenCalled();
    expect(getDescription(interaction)).toContain("Created a new public Google Sheet");
    expect(getDescription(interaction)).toContain("https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing");
  });

  it("autocompletes /cwl rotations show day choices 1 through 7", async () => {
    const allDaysInteraction = makeAutocompleteInteraction("", "day");

    await Cwl.autocomplete(allDaysInteraction as any);

    expect(allDaysInteraction.respond).toHaveBeenCalledWith([
      { name: "Day 1", value: 1 },
      { name: "Day 2", value: 2 },
      { name: "Day 3", value: 3 },
      { name: "Day 4", value: 4 },
      { name: "Day 5", value: 5 },
      { name: "Day 6", value: 6 },
      { name: "Day 7", value: 7 },
    ]);

    const filteredInteraction = makeAutocompleteInteraction("2", "day");

    await Cwl.autocomplete(filteredInteraction as any);

    expect(filteredInteraction.respond).toHaveBeenCalledWith([{ name: "Day 2", value: 2 }]);
  });

  it("autocompletes tracked CWL clans from the persisted seasonal registry", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Alpha", createdAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: "#9GLGQCCU", name: "CWL Beta", createdAt: new Date("2026-04-02T00:00:00.000Z") },
    ]);
    const interaction = makeAutocompleteInteraction("alpha");

    await Cwl.autocomplete(interaction as any);

    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "CWL Alpha (#2QG2C08UP)", value: "#2QG2C08UP" },
    ]);
  });
});
