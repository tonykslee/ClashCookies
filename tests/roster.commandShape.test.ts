import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Roster } from "../src/commands/Roster";

describe("/roster command shape", () => {
  it("registers create, list, post, manage, edit, delete, report, readiness, and refresh without flat manager drift", () => {
    const create = Roster.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "create",
    );
    const list = Roster.options?.find((option) => option.name === "list");
    const post = Roster.options?.find((option) => option.name === "post");
    const manage = Roster.options?.find((option) => option.name === "manage");
    const edit = Roster.options?.find((option) => option.name === "edit");
    const deleteOption = Roster.options?.find((option) => option.name === "delete");
    const report = Roster.options?.find((option) => option.name === "report");
    const readiness = Roster.options?.find((option) => option.name === "readiness");
    const refresh = Roster.options?.find((option) => option.name === "refresh");

    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(list?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(list?.options?.map((option: any) => option.name)).toEqual(["name", "user", "player", "clan"]);
    expect(post?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(manage?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(edit?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(deleteOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(report?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(readiness?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(refresh?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(Roster.options?.find((option) => option.name === "open")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "close")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "archive")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "add")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "move")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "remove")).toBeUndefined();

    expect(create?.options?.find((option: any) => option.name === "category")?.choices?.map((choice: any) => choice.value)).toEqual([
      "CWL",
      "FWA",
    ]);
    expect(create?.options?.slice(0, 2)?.map((option: any) => option.name)).toEqual(["clan", "category"]);
    expect(create?.options?.find((option: any) => option.name === "name")?.required).toBe(false);
    expect(create?.options?.find((option: any) => option.name === "title")?.required).toBe(false);
    expect(create?.options?.find((option: any) => option.name === "clan")?.required).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "timezone")?.autocomplete).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "start_time")?.required).toBe(false);
    expect(create?.options?.find((option: any) => option.name === "max_members")?.type).toBe(
      ApplicationCommandOptionType.Integer,
    );
    expect(create?.options?.find((option: any) => option.name === "roster_role")?.required).toBe(false);
    expect(create?.options?.find((option: any) => option.name === "allow_multi_signup")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(create?.options?.find((option: any) => option.name === "sort_by")?.choices?.map((choice: any) => choice.value)).toEqual([
      "signed_up_at",
      "player_name",
      "player_tag",
      "discord_user",
      "townhall",
    ]);
    expect(create?.options?.find((option: any) => option.name === "import_members")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );

    expect(post?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(report?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(readiness?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(refresh?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(deleteOption?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);

    const manageRoster = manage?.options?.find((option: any) => option.name === "roster");
    const manageAction = manage?.options?.find((option: any) => option.name === "action");
    const manageGroup = manage?.options?.find((option: any) => option.name === "group");
    const managePlayers = manage?.options?.find((option: any) => option.name === "players");

    expect(manageRoster?.required).toBe(true);
    expect(manageAction?.required).toBe(true);
    expect(manageGroup?.required).toBe(false);
    expect(managePlayers?.required).toBe(false);
    expect(manageAction?.choices?.map((choice: any) => choice.value)).toEqual([
      "add",
      "move",
      "remove",
      "open",
      "close",
      "archive",
    ]);

    expect(edit?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "name")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "title")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "category")?.choices?.map((choice: any) => choice.value)).toEqual([
      "CWL",
      "FWA",
    ]);
    expect(edit?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "timezone")?.autocomplete).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "start_time")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "roster_role")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "delete_role")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(edit?.options?.find((option: any) => option.name === "allow_multi_signup")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(edit?.options?.find((option: any) => option.name === "sort_by")?.choices?.map((choice: any) => choice.value)).toEqual([
      "signed_up_at",
      "player_name",
      "player_tag",
      "discord_user",
      "townhall",
    ]);
    expect(edit?.options?.find((option: any) => option.name === "import_members")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(edit?.options?.find((option: any) => option.name === "display-timezone")?.autocomplete).toBe(true);
  });

  it("keeps required options before optional options in every /roster subcommand", () => {
    for (const subcommand of Roster.options ?? []) {
      if (subcommand.type !== ApplicationCommandOptionType.Subcommand) continue;
      const optionNames = (subcommand.options ?? []).map((option: any) => option.name);
      const requiredFlags = (subcommand.options ?? []).map((option: any) => Boolean(option.required));
      const firstOptionalIndex = requiredFlags.findIndex((required: boolean) => !required);
      if (firstOptionalIndex === -1) continue;
      expect(requiredFlags.slice(firstOptionalIndex).every((required: boolean) => !required)).toBe(true);
      if (subcommand.name === "create") {
        expect(optionNames.slice(0, 2)).toEqual(["clan", "category"]);
      }
      if (subcommand.name === "edit") {
        expect(optionNames[0]).toBe("roster");
      }
      if (subcommand.name === "manage") {
        expect(optionNames.slice(0, 2)).toEqual(["roster", "action"]);
      }
    }
  });
});
