import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { CopyChannel } from "../src/commands/CopyChannel";

describe("/copy-channel command shape", () => {
  it("registers a required bounded integer messages option", () => {
    expect(CopyChannel.name).toBe("copy-channel");
    expect(CopyChannel.options).toHaveLength(1);

    const messages = CopyChannel.options?.find((option) => option.name === "messages");
    expect(messages?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(messages?.required).toBe(true);
    expect(messages?.minValue).toBe(1);
    expect(messages?.maxValue).toBe(100);
  });
});
