import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { CopyChannel } from "../src/commands/CopyChannel";

describe("/copy-channel command shape", () => {
  it("registers a required bounded integer messages option", () => {
    expect(CopyChannel.name).toBe("copy-channel");
    expect(CopyChannel.options).toHaveLength(3);

    const messages = CopyChannel.options?.find((option) => option.name === "messages");
    expect(messages?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(messages?.required).toBe(true);
    expect(messages?.minValue).toBe(1);
    expect(messages?.maxValue).toBe(200);

    const after = CopyChannel.options?.find((option) => option.name === "after");
    const before = CopyChannel.options?.find((option) => option.name === "before");
    expect(after?.type).toBe(ApplicationCommandOptionType.String);
    expect(before?.type).toBe(ApplicationCommandOptionType.String);
    expect(after?.required).toBe(false);
    expect(before?.required).toBe(false);
  });
});
