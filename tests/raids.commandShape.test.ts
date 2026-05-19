import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Raids } from "../src/commands/Raids";

describe("/raids command shape", () => {
  it("registers overview, roster, and intel subcommands with expected options", () => {
    expect(Raids.name).toBe("raids");
    expect(Raids.options).toHaveLength(3);

    const overview = Raids.options?.find((option) => option.name === "overview");
    expect(overview?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const type = overview?.options?.find((option) => option.name === "type");
    expect(type?.type).toBe(ApplicationCommandOptionType.String);
    expect(type?.required).toBe(false);
    expect(type?.choices).toEqual([
      { name: "raids", value: "raids" },
      { name: "fwa", value: "fwa" },
      { name: "custom", value: "custom" },
    ]);
    const clan = overview?.options?.find((option) => option.name === "clan");
    expect(clan?.type).toBe(ApplicationCommandOptionType.String);
    expect(clan?.required).toBe(false);
    expect(clan?.autocomplete).toBe(true);

    const roster = Raids.options?.find((option) => option.name === "roster");
    expect(roster?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(roster?.options?.map((option) => option.name)).toEqual(["add"]);
    const rosterAdd = roster?.options?.find((option) => option.name === "add");
    expect(rosterAdd?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const rosterAddTag = rosterAdd?.options?.find((option) => option.name === "tag");
    expect(rosterAddTag?.type).toBe(ApplicationCommandOptionType.String);
    expect(rosterAddTag?.required).toBe(true);

    const intel = Raids.options?.find((option) => option.name === "intel");
    expect(intel?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const intelClan = intel?.options?.find((option) => option.name === "clan");
    expect(intelClan?.type).toBe(ApplicationCommandOptionType.String);
    expect(intelClan?.required).toBe(false);
    expect(intelClan?.autocomplete).toBe(true);
    const districtOptionNames = [
      "capital_peak",
      "barbarian_camp",
      "wizard_valley",
      "balloon_lagoon",
      "builders_workshop",
      "dragon_cliffs",
      "golem_quarry",
      "skeleton_park",
      "goblin_mines",
    ];
    expect(intel?.options?.map((option) => option.name)).toEqual([
      "clan",
      ...districtOptionNames,
      "upgrades",
    ]);
    for (const optionName of districtOptionNames) {
      const option = intel?.options?.find((entry) => entry.name === optionName);
      expect(option?.type).toBe(ApplicationCommandOptionType.String);
      expect(option?.required).toBe(false);
      expect(option?.autocomplete).toBeUndefined();
      expect(option?.choices).toEqual([
        { name: "Default", value: "DEFAULT" },
        { name: "Custom - Hard", value: "CUSTOM_HARD" },
        { name: "Custom - Medium", value: "CUSTOM_MEDIUM" },
        { name: "Custom - Easy", value: "CUSTOM_EASY" },
      ]);
    }
    const upgrades = intel?.options?.find((option) => option.name === "upgrades");
    expect(upgrades?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(upgrades?.minValue).toBe(1000);
    expect(upgrades?.maxValue).toBe(3331);
  });
});
