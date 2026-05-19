import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Bot } from "../src/commands/Bot";

describe("/bot command shape", () => {
  it("registers the status and poll status subcommands", () => {
    expect(Bot.name).toBe("bot");

    const status = Bot.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "status",
    );
    expect(status).toBeTruthy();
    expect(status?.description).toContain("bot status overview");

    const poll = Bot.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "poll",
    );
    expect(poll).toBeTruthy();
    expect(poll?.options?.some((option: any) => option.name === "status")).toBe(true);

    const pollStatus = poll?.options?.find((option: any) => option.name === "status");
    expect(pollStatus?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(pollStatus?.description).toContain("background poll job status");
  });
});
