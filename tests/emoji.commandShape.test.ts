import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Emoji } from "../src/commands/Emoji";

describe("/emoji command shape", () => {
  it("registers optional name autocomplete and optional react message-id options", () => {
    const nameOption = Emoji.options?.find((option) => option.name === "name");
    const reactOption = Emoji.options?.find((option) => option.name === "react");

    expect(nameOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(nameOption?.required).toBe(false);
    expect(nameOption?.autocomplete).toBe(true);

    expect(reactOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(reactOption?.required).toBe(false);
  });
});
