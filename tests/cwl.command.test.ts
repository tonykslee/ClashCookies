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
import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlStateService } from "../src/services/CwlStateService";

function makeInteraction(input: {
  group?: "rotations" | null;
  subcommand: "members" | "show" | "create";
  clan?: string | null;
  inwar?: boolean | null;
  day?: number | null;
  exclude?: string | null;
  overwrite?: boolean | null;
}) {
  return {
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

function makeAutocompleteInteraction(value: string) {
  return {
    options: {
      getFocused: vi.fn(() => ({ name: "clan", value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function getDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

describe("/cwl command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
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
