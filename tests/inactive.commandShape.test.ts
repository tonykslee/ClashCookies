import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Inactive } from "../src/commands/Inactive";

describe("/inactive command shape", () => {
  it("registers an autocompleted clan option alongside days and wars", () => {
    const daysOption = Inactive.options?.find((option) => option.name === "days");
    const warsOption = Inactive.options?.find((option) => option.name === "wars");
    const consecutiveOption = Inactive.options?.find((option) => option.name === "consecutive");
    const clanOption = Inactive.options?.find((option) => option.name === "clan");

    expect(daysOption?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(warsOption?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(consecutiveOption?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(clanOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(consecutiveOption?.required).toBe(false);
    expect(clanOption?.autocomplete).toBe(true);
    expect(clanOption?.required).toBe(false);
  });
});
