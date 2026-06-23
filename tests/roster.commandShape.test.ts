import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Roster } from "../src/commands/Roster";

describe("/roster command shape", () => {
  it("registers create, list, show, set, reset, delayed-signup-role, post, ping, manage, edit, delete, report, and refresh without flat manager drift", () => {
    const create = Roster.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "create",
    );
    const list = Roster.options?.find((option) => option.name === "list");
    const show = Roster.options?.find((option) => option.name === "show");
    const set = Roster.options?.find((option) => option.name === "set");
    const reset = Roster.options?.find((option) => option.name === "reset");
    const delayedSignupRole = Roster.options?.find((option) => option.name === "delayed-signup-role");
    const post = Roster.options?.find((option) => option.name === "post");
    const ping = Roster.options?.find((option) => option.name === "ping");
    const manage = Roster.options?.find((option) => option.name === "manage");
    const edit = Roster.options?.find((option) => option.name === "edit");
    const deleteOption = Roster.options?.find((option) => option.name === "delete");
    const report = Roster.options?.find((option) => option.name === "report");
    const refresh = Roster.options?.find((option) => option.name === "refresh");

    expect(create?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(list?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(list?.options?.map((option: any) => option.name)).toEqual(["name", "user", "player", "clan"]);
    expect(show?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(set?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(reset?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(delayedSignupRole?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(post?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(ping?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(manage?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(edit?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(deleteOption?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(report?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(refresh?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(Roster.options?.find((option) => option.name === "open")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "close")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "archive")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "add")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "move")).toBeUndefined();
    expect(Roster.options?.find((option) => option.name === "remove")).toBeUndefined();

    expect(delayedSignupRole?.options?.map((option: any) => option.name)).toEqual([
      "add",
      "remove",
      "list",
      "clear",
    ]);
    expect(delayedSignupRole?.options?.find((option: any) => option.name === "add")?.options?.find((option: any) => option.name === "role")?.required).toBe(true);
    expect(delayedSignupRole?.options?.find((option: any) => option.name === "remove")?.options?.find((option: any) => option.name === "role")?.required).toBe(true);

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
    expect(create?.options?.find((option: any) => option.name === "visitor_signup_open_time")?.required).toBe(false);
    expect(create?.options?.find((option: any) => option.name === "max_members")?.type).toBe(
      ApplicationCommandOptionType.Integer,
    );
    expect(create?.options?.find((option: any) => option.name === "minimum_weight")?.type).toBe(
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

    expect(set?.options?.find((option: any) => option.name === "columns")?.required).toBe(true);

    expect(post?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(ping?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(ping?.options?.find((option: any) => option.name === "message")?.required).toBe(false);
    expect(ping?.options?.find((option: any) => option.name === "ping_option")?.choices?.map((choice: any) => choice.value)).toEqual([
      "unregistered",
      "missing",
      "everyone",
    ]);
    expect(ping?.options?.find((option: any) => option.name === "group")?.autocomplete).toBe(true);
    expect(report?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(refresh?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(deleteOption?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);

    const manageRoster = manage?.options?.find((option: any) => option.name === "roster");
    const manageAction = manage?.options?.find((option: any) => option.name === "action");
    const manageTargetRoster = manage?.options?.find((option: any) => option.name === "target_roster");
    const manageTargetGroup = manage?.options?.find((option: any) => option.name === "target_group");
    const manageUser = manage?.options?.find((option: any) => option.name === "user");
    const manageGroup = manage?.options?.find((option: any) => option.name === "group");
    const managePlayers = manage?.options?.find((option: any) => option.name === "players");

    expect(manageRoster?.required).toBe(true);
    expect(manageAction?.required).toBe(true);
    expect(manageTargetRoster?.autocomplete).toBe(true);
    expect(manageTargetGroup?.autocomplete).toBe(true);
    expect(manageUser?.type).toBe(ApplicationCommandOptionType.User);
    expect(manageUser?.autocomplete).not.toBe(true);
    expect(manageGroup?.required).toBe(false);
    expect(managePlayers?.required).toBe(false);
    expect(manageGroup?.autocomplete).toBe(true);
    expect(managePlayers?.autocomplete).toBe(true);
    expect(manageAction?.choices?.map((choice: any) => choice.value)).toEqual([
      "add",
      "move",
      "remove",
      "change_roster",
      "set_weight",
      "open",
      "close",
      "archive",
    ]);
    expect(manageAction?.choices?.map((choice: any) => choice.name)).toEqual([
      "Add players",
      "Change Group",
      "Remove players",
      "Change roster",
      "Set weight",
      "Open roster",
      "Close roster",
      "Archive roster",
    ]);

    expect(edit?.options?.find((option: any) => option.name === "roster")?.required).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "name")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "title")).toBeUndefined();
    expect(edit?.options?.find((option: any) => option.name === "category")?.choices?.map((choice: any) => choice.value)).toEqual([
      "CWL",
      "FWA",
    ]);
    expect(edit?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "timezone")?.autocomplete).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "start_time")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "visitor_signup_open_time")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "clear_visitor_signup_open_time")?.type).toBe(
      ApplicationCommandOptionType.Boolean,
    );
    expect(edit?.options?.find((option: any) => option.name === "roster_role")?.required).toBe(false);
    expect(edit?.options?.find((option: any) => option.name === "minimum_weight")?.type).toBe(
      ApplicationCommandOptionType.Integer,
    );
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

  it("uses a native Discord user selector for roster list user and autocompletes clan selectors", () => {
    const create = Roster.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "create",
    );
    const list = Roster.options?.find((option) => option.name === "list");
    const edit = Roster.options?.find((option) => option.name === "edit");
    expect(list?.options?.find((option: any) => option.name === "user")?.type).toBe(
      ApplicationCommandOptionType.User,
    );
    expect(list?.options?.find((option: any) => option.name === "user")?.autocomplete).not.toBe(true);
    expect(list?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
    expect(create?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
    expect(edit?.options?.find((option: any) => option.name === "clan")?.autocomplete).toBe(true);
  });
});
