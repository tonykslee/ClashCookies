import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Defer } from "../src/commands/Defer";

describe("/defer command shape", () => {
  it("registers required subcommands and option types", () => {
    const add = Defer.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "add"
    );
    expect(add).toBeTruthy();
    expect(add?.options?.find((option: any) => option.name === "player-tag")?.required).toBe(true);
    expect(add?.options?.find((option: any) => option.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(add?.options?.find((option: any) => option.name === "weight")?.required).toBe(true);
    expect(add?.options?.find((option: any) => option.name === "weight")?.type).toBe(
      ApplicationCommandOptionType.String
    );

    const list = Defer.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "list"
    );
    const config = Defer.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "config"
    );
    const remove = Defer.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "remove"
    );
    const clear = Defer.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "clear"
    );

    expect(list).toBeTruthy();
    expect(config).toBeTruthy();
    expect(remove).toBeTruthy();
    expect(clear).toBeTruthy();
    expect(config?.options?.find((option: any) => option.name === "channel")?.type).toBe(
      ApplicationCommandOptionType.Channel
    );
    expect(config?.options?.find((option: any) => option.name === "ping_role")?.type).toBe(
      ApplicationCommandOptionType.Role
    );
    expect(config?.options?.find((option: any) => option.name === "enable_ping")?.type).toBe(
      ApplicationCommandOptionType.Boolean
    );
    expect(config?.options?.find((option: any) => option.name === "enable")?.type).toBe(
      ApplicationCommandOptionType.Boolean
    );
  });
});
