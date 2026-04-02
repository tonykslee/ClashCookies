import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Cwl } from "../src/commands/Cwl";

describe("/cwl command shape", () => {
  it("registers members plus rotations show/create without drift", () => {
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

    expect(members).toBeTruthy();
    expect(rotations).toBeTruthy();
    expect(show?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(members?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    expect(show?.options?.find((option: any) => option.name === "day")?.type).toBe(
      ApplicationCommandOptionType.Integer,
    );
    expect(create?.options?.find((option: any) => option.name === "overwrite")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
  });
});
