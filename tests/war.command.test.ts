import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { War } from "../src/commands/War";

describe("/war command shape", () => {
  it("registers war-id as a subcommand with required clan-tag and autocompleted war-id", () => {
    const warIdSubcommand = War.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "war-id"
    );
    expect(warIdSubcommand).toBeTruthy();

    const clanTagOption = warIdSubcommand?.options?.find(
      (option) => option.name === "clan-tag"
    );
    expect(clanTagOption?.required).toBe(true);
    expect(clanTagOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(clanTagOption?.autocomplete).toBe(true);

    const warIdOption = warIdSubcommand?.options?.find((option) => option.name === "war-id");
    expect(warIdOption?.required).toBe(true);
    expect(warIdOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(warIdOption?.autocomplete).toBe(true);
  });
});
