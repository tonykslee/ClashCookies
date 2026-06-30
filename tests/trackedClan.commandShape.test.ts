import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { TrackedClan } from "../src/commands/TrackedClan";

describe("/clan command shape", () => {
  it("registers CWL and type-aware clan options without changing existing subcommands", () => {
    const configure = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "configure",
    );
    const remove = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "remove",
    );
    const repGroup = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "rep",
    );
    const list = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "list",
    );
    const cwlTags = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "cwl-tags",
    );
    const raidTags = TrackedClan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "raid-tags",
    );

    expect(configure).toBeTruthy();
    expect(remove).toBeTruthy();
    expect(repGroup).toBeTruthy();
    expect(list).toBeTruthy();
    expect(cwlTags).toBeTruthy();
    expect(raidTags).toBeTruthy();
    expect(TrackedClan.name).toBe("clan");

    expect(configure?.options?.find((o: any) => o.name === "leader-channel")?.type).toBe(
      ApplicationCommandOptionType.Channel,
    );
    expect(configure?.options?.find((o: any) => o.name === "leader-channel")?.required).toBe(
      false,
    );
    expect(configure?.options?.find((o: any) => o.name === "lead-role")?.type).toBe(
      ApplicationCommandOptionType.Role,
    );
    expect(configure?.options?.find((o: any) => o.name === "lead-role")?.required).toBe(false);
    expect(configure?.options?.find((o: any) => o.name === "reps")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(configure?.options?.find((o: any) => o.name === "reps")?.required).toBe(false);

    expect(remove?.options?.find((o: any) => o.name === "type")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(remove?.options?.find((o: any) => o.name === "type")?.required).toBe(false);
    expect(
      remove?.options?.find((o: any) => o.name === "type")?.choices?.map((choice: any) => choice.value)
    ).toEqual(expect.arrayContaining(["FWA", "CWL", "RAIDS"]));
    expect(repGroup?.options?.find((o: any) => o.name === "add")?.type).toBe(
      ApplicationCommandOptionType.Subcommand,
    );
    expect(repGroup?.options?.find((o: any) => o.name === "remove")?.type).toBe(
      ApplicationCommandOptionType.Subcommand,
    );
    expect(repGroup?.options?.find((o: any) => o.name === "list")?.type).toBe(
      ApplicationCommandOptionType.Subcommand,
    );
    const repAdd = repGroup?.options?.find((o: any) => o.name === "add");
    const repRemove = repGroup?.options?.find((o: any) => o.name === "remove");
    const repList = repGroup?.options?.find((o: any) => o.name === "list");
    expect(repAdd?.options?.find((o: any) => o.name === "clan")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(repAdd?.options?.find((o: any) => o.name === "clan")?.required).toBe(true);
    expect(repAdd?.options?.find((o: any) => o.name === "player")?.autocomplete).toBe(true);
    expect(repRemove?.options?.find((o: any) => o.name === "clan")?.autocomplete).toBe(true);
    expect(repRemove?.options?.find((o: any) => o.name === "player")?.required).toBe(true);
    expect(repList?.options?.find((o: any) => o.name === "clan")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(repList?.options?.find((o: any) => o.name === "clan")?.required).toBe(false);
    expect(repList?.options?.find((o: any) => o.name === "clan")?.autocomplete).toBe(true);
    expect(list?.options?.find((o: any) => o.name === "type")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(list?.options?.find((o: any) => o.name === "type")?.required).toBe(false);
    expect(
      list?.options?.find((o: any) => o.name === "type")?.choices?.map((choice: any) => choice.value)
    ).toEqual(expect.arrayContaining(["FWA", "CWL", "RAIDS"]));
    expect(list?.options?.find((o: any) => o.name === "display")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(list?.options?.find((o: any) => o.name === "display")?.required).toBe(false);
    expect(
      list?.options?.find((o: any) => o.name === "display")?.choices?.map((choice: any) => choice.value)
    ).toEqual(expect.arrayContaining(["minimal", "detailed"]));
    expect(cwlTags?.options?.find((o: any) => o.name === "cwl-tags")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(cwlTags?.options?.find((o: any) => o.name === "cwl-tags")?.required).toBe(true);
    expect(raidTags?.options?.find((o: any) => o.name === "raid-tags")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(raidTags?.options?.find((o: any) => o.name === "raid-tags")?.required).toBe(true);
    expect(raidTags?.options?.find((o: any) => o.name === "upgrades")?.type).toBe(
      ApplicationCommandOptionType.Integer,
    );
    expect(raidTags?.options?.find((o: any) => o.name === "upgrades")?.required).toBe(false);
  });
});
