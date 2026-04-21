import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Roster } from "../src/commands/Roster";

describe("/roster command shape", () => {
  it("registers create, manager controls, and no legacy cwl roster ownership", () => {
    const create = Roster.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "create",
    );
    const report = Roster.options?.find((option) => option.name === "report");
    const readiness = Roster.options?.find((option) => option.name === "readiness");
    const refresh = Roster.options?.find((option) => option.name === "refresh");
    const open = Roster.options?.find((option) => option.name === "open");
    const close = Roster.options?.find((option) => option.name === "close");
    const archive = Roster.options?.find((option) => option.name === "archive");
    const add = Roster.options?.find((option) => option.name === "add");
    const move = Roster.options?.find((option) => option.name === "move");
    const remove = Roster.options?.find((option) => option.name === "remove");

    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(report?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(readiness?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(refresh?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(open?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(close?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(archive?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(add?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(move?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(remove?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(create?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "timezone")?.autocomplete).toBe(
      true,
    );
    expect(add?.options?.find((option: any) => option.name === "group")?.required).toBe(true);
    expect(add?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
    expect(move?.options?.find((option: any) => option.name === "group")?.required).toBe(true);
    expect(move?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
    expect(remove?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
  });
});
