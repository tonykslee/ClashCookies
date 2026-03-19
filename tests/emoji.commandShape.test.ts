import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Emoji } from "../src/commands/Emoji";

describe("/emoji command shape", () => {
  it("registers optional resolve/react options plus add-flow emoji source + shortcode options", () => {
    const nameOption = Emoji.options?.find((option) => option.name === "name");
    const reactOption = Emoji.options?.find((option) => option.name === "react");
    const emojiOption = Emoji.options?.find((option) => option.name === "emoji");
    const shortCodeOption = Emoji.options?.find((option) => option.name === "short-code");

    expect(nameOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(nameOption?.required).toBe(false);
    expect(nameOption?.autocomplete).toBe(true);

    expect(reactOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(reactOption?.required).toBe(false);

    expect(emojiOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(emojiOption?.required).toBe(false);

    expect(shortCodeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(shortCodeOption?.required).toBe(false);
  });
});
