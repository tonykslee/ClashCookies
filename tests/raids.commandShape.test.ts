import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Raids } from "../src/commands/Raids";

describe("/raids command shape", () => {
  it("registers overview and intel subcommands with expected options", () => {
    expect(Raids.name).toBe("raids");
    expect(Raids.options).toHaveLength(2);

    const overview = Raids.options?.find((option) => option.name === "overview");
    expect(overview?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const clan = overview?.options?.find((option) => option.name === "clan");
    expect(clan?.type).toBe(ApplicationCommandOptionType.String);
    expect(clan?.required).toBe(false);
    expect(clan?.autocomplete).toBe(true);

    const intel = Raids.options?.find((option) => option.name === "intel");
    expect(intel?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const intelClan = intel?.options?.find((option) => option.name === "clan");
    expect(intelClan?.type).toBe(ApplicationCommandOptionType.String);
    expect(intelClan?.required).toBe(false);
    expect(intelClan?.autocomplete).toBe(true);
    const upgrades = intel?.options?.find((option) => option.name === "upgrades");
    expect(upgrades?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(upgrades?.minValue).toBe(1000);
    expect(upgrades?.maxValue).toBe(3331);
  });
});
