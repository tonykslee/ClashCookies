import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa compliance command shape", () => {
  it("registers compliance as a subcommand with required tag", () => {
    const compliance = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "compliance"
    );
    expect(compliance).toBeTruthy();
    const tagOption = compliance?.options?.find((option) => option.name === "tag");
    expect(tagOption?.required).toBe(true);
    expect(tagOption?.type).toBe(ApplicationCommandOptionType.String);
  });
});

