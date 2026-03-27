import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa police command shape", () => {
  it("registers police as a subcommand with required clan-tag and toggle booleans", () => {
    const police = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "police",
    );
    expect(police).toBeTruthy();

    const clanTagOption = police?.options?.find(
      (option: { name: string }) => option.name === "clan-tag",
    );
    expect(clanTagOption?.required).toBe(true);
    expect(clanTagOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(clanTagOption?.autocomplete).toBe(true);

    const enableDmOption = police?.options?.find(
      (option: { name: string }) => option.name === "enable-dm",
    );
    expect(enableDmOption?.required).toBe(true);
    expect(enableDmOption?.type).toBe(ApplicationCommandOptionType.Boolean);

    const enableLogOption = police?.options?.find(
      (option: { name: string }) => option.name === "enable-log",
    );
    expect(enableLogOption?.required).toBe(true);
    expect(enableLogOption?.type).toBe(ApplicationCommandOptionType.Boolean);
  });
});

