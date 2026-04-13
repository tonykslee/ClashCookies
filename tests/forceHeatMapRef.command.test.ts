import { ApplicationCommandOptionType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rebuildSpy = vi.fn();

vi.mock("../src/services/HeatMapRefRebuildService", () => ({
  HeatMapRefRebuildService: vi.fn().mockImplementation(() => ({
    runManualRepair: rebuildSpy,
  })),
}));

import { Force } from "../src/commands/Force";

const previousPollingMode = process.env.POLLING_MODE;

function makeInteraction() {
  return {
    guildId: "guild-1",
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue("refresh"),
      getSubcommand: vi.fn().mockReturnValue("heatmapref"),
    },
  } as any;
}

describe("Force /force refresh heatmapref", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.POLLING_MODE = "active";
    rebuildSpy.mockResolvedValue({
      status: "success",
      reason: null,
      trackedClanCount: 1,
      sourceRosterCount: 1,
      qualifyingRosterCount: 1,
      excludedRosterCount: 0,
      rowCount: 11,
      changedRowCount: 11,
      contentHash: "hash-1",
      alertSent: false,
      summaryLines: ["ok"],
      cycleKey: null,
      dueAt: null,
    });
  });

  afterEach(() => {
    process.env.POLLING_MODE = previousPollingMode;
  });

  it("registers the refresh heatmapref subcommand", () => {
    const refreshGroup = Force.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "refresh",
    );
    const heatMapRefSubcommand = refreshGroup?.options?.find(
      (option: { name: string }) => option.name === "heatmapref",
    );

    expect(heatMapRefSubcommand?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(heatMapRefSubcommand?.description).toContain("HeatMapRef");
  });

  it("runs the HeatMapRef rebuild repair command and reports the result", async () => {
    const interaction = makeInteraction();

    await Force.run({} as any, interaction as any, {} as any);

    expect(rebuildSpy).toHaveBeenCalledWith({
      guildId: "guild-1",
      now: expect.any(Date),
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("HeatMapRef refresh success."),
    );
  });
});
