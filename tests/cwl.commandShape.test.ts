import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Cwl } from "../src/commands/Cwl";

describe("/cwl command shape", () => {
  it("registers members, signup, roster manager controls, and rotations show/create/import/export without drift", () => {
    const members = Cwl.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "members",
    );
    const signup = Cwl.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "signup",
    );
    const roster = Cwl.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "roster",
    );
    const rotations = Cwl.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "rotations",
    );
    const report = roster?.options?.find((option: any) => option.name === "report");
    const readiness = roster?.options?.find((option: any) => option.name === "readiness");
    const refresh = roster?.options?.find((option: any) => option.name === "refresh");
    const open = roster?.options?.find((option: any) => option.name === "open");
    const close = roster?.options?.find((option: any) => option.name === "close");
    const archive = roster?.options?.find((option: any) => option.name === "archive");
    const add = roster?.options?.find((option: any) => option.name === "add");
    const move = roster?.options?.find((option: any) => option.name === "move");
    const remove = roster?.options?.find((option: any) => option.name === "remove");
    const show = rotations?.options?.find((option: any) => option.name === "show");
    const create = rotations?.options?.find((option: any) => option.name === "create");
    const importOption = rotations?.options?.find((option: any) => option.name === "import");
    const exportOption = rotations?.options?.find((option: any) => option.name === "export");

    expect(members).toBeTruthy();
    expect(signup).toBeTruthy();
    expect(roster).toBeTruthy();
    expect(rotations).toBeTruthy();
    expect(report?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(readiness?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(refresh?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(open?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(close?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(archive?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(add?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(move?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(remove?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(show?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(importOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(exportOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(members?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    expect(signup?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    expect(signup?.options?.find((option: any) => option.name === "timezone")?.autocomplete).toBe(
      true,
    );
    expect(add?.options?.find((option: any) => option.name === "group")?.required).toBe(true);
    expect(add?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
    expect(move?.options?.find((option: any) => option.name === "group")?.required).toBe(true);
    expect(move?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
    expect(remove?.options?.find((option: any) => option.name === "players")?.required).toBe(true);
    const showDay = show?.options?.find((option: any) => option.name === "day");
    expect(showDay?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(showDay?.minValue).toBe(1);
    expect(showDay?.maxValue).toBe(7);
    expect(showDay?.autocomplete).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "overwrite")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
  });
});
