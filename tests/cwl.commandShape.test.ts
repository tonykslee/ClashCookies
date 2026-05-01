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
    const rotations = Cwl.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "rotations",
    );
    const show = rotations?.options?.find((option: any) => option.name === "show");
    const create = rotations?.options?.find((option: any) => option.name === "create");
    const importOption = rotations?.options?.find((option: any) => option.name === "import");
    const exportOption = rotations?.options?.find((option: any) => option.name === "export");

    expect(members).toBeTruthy();
    expect(Cwl.options?.find((option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === "signup")).toBeUndefined();
    expect(Cwl.options?.find((option) => option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === "roster")).toBeUndefined();
    expect(rotations).toBeTruthy();
    expect(show?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(importOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(exportOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(members?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    const showDay = show?.options?.find((option: any) => option.name === "day");
    expect(showDay?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(showDay?.minValue).toBe(1);
    expect(showDay?.maxValue).toBe(7);
    expect(showDay?.autocomplete).toBe(true);
    expect(show?.options?.find((option: any) => option.name === "roster")).toBeUndefined();
    expect(importOption?.options?.find((option: any) => option.name === "roster")).toBeUndefined();
    expect(exportOption?.options?.find((option: any) => option.name === "roster")).toBeUndefined();
    const size = create?.options?.find((option: any) => option.name === "size");
    expect(size?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(size?.required).toBe(false);
    expect(size?.choices?.map((choice: any) => choice.value)).toEqual([15, 30]);
    const roster = create?.options?.find((option: any) => option.name === "roster");
    expect(roster?.type).toBe(ApplicationCommandOptionType.String);
    expect(roster?.autocomplete).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "overwrite")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(exportOption?.options?.find((option: any) => option.name === "new")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
  });
});
