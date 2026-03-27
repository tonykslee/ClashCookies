import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { RemindMe } from "../src/commands/RemindMe";

describe("/remindme command shape", () => {
  it("registers set/list/remove with expected options", () => {
    const set = RemindMe.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "set",
    );
    const list = RemindMe.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "list",
    );
    const remove = RemindMe.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "remove",
    );

    expect(set).toBeTruthy();
    expect(list).toBeTruthy();
    expect(remove).toBeTruthy();

    expect(set?.options?.find((o: any) => o.name === "type")?.required).toBe(true);
    expect(set?.options?.find((o: any) => o.name === "player_tags")?.required).toBe(
      true,
    );
    expect(set?.options?.find((o: any) => o.name === "player_tags")?.autocomplete).toBe(
      true,
    );
    expect(set?.options?.find((o: any) => o.name === "time_left")?.required).toBe(true);
    expect(set?.options?.find((o: any) => o.name === "method")?.required).toBe(false);
    expect(set?.options?.find((o: any) => o.name === "method")?.choices).toEqual([
      { name: "DM", value: "DM" },
      { name: "ping-me-here", value: "PING_HERE" },
    ]);
  });
});
