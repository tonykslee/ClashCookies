import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Bot } from "../src/commands/Bot";

describe("/bot command shape", () => {
  it("registers the poll status subcommand", () => {
    expect(Bot.name).toBe("bot");

    const poll = Bot.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "poll",
    );
    expect(poll).toBeTruthy();
    expect(poll?.options?.some((option: any) => option.name === "status")).toBe(true);

    const status = poll?.options?.find((option: any) => option.name === "status");
    expect(status?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(status?.description).toContain("background poll job status");
  });
});
