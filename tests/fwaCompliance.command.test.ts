import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa compliance command shape", () => {
  it("registers compliance as a subcommand with required tag and autocompleted string war-id", () => {
    const compliance = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "compliance",
    );
    expect(compliance).toBeTruthy();

    const tagOption = compliance?.options?.find(
      (option: { name: string }) => option.name === "tag",
    );
    expect(tagOption?.required).toBe(true);
    expect(tagOption?.type).toBe(ApplicationCommandOptionType.String);

    const warIdOption = compliance?.options?.find(
      (option: { name: string }) => option.name === "war-id",
    );
    expect(warIdOption?.required).toBe(true);
    expect(warIdOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(warIdOption?.autocomplete).toBe(true);
    expect(warIdOption?.description).toContain("Ongoing");
  });
});
