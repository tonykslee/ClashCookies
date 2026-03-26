import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { TrackedClan } from "../src/commands/TrackedClan";

describe("/tracked-clan command shape", () => {
  it("registers CWL and type-aware tracked-clan options without changing existing subcommands", () => {
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

    expect(configure).toBeTruthy();
    expect(remove).toBeTruthy();
    expect(list).toBeTruthy();
    expect(cwlTags).toBeTruthy();

    expect(remove?.options?.find((o: any) => o.name === "type")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(remove?.options?.find((o: any) => o.name === "type")?.required).toBe(false);
    expect(list?.options?.find((o: any) => o.name === "type")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(list?.options?.find((o: any) => o.name === "type")?.required).toBe(false);
    expect(cwlTags?.options?.find((o: any) => o.name === "cwl-tags")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(cwlTags?.options?.find((o: any) => o.name === "cwl-tags")?.required).toBe(true);
  });
});
