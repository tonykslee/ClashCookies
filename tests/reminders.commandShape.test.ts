import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Reminders } from "../src/commands/Reminders";

describe("/reminders command shape", () => {
  it("registers create/list/edit with expected options", () => {
    const create = Reminders.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "create",
    );
    const list = Reminders.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "list",
    );
    const edit = Reminders.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "edit",
    );

    expect(create).toBeTruthy();
    expect(list).toBeTruthy();
    expect(edit).toBeTruthy();

    expect(create?.options?.find((o: any) => o.name === "type")?.required).toBe(true);
    expect(create?.options?.find((o: any) => o.name === "type")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(create?.options?.find((o: any) => o.name === "time_left")?.required).toBe(true);
    expect(create?.options?.find((o: any) => o.name === "time_left")?.type).toBe(
      ApplicationCommandOptionType.String,
    );
    expect(create?.options?.find((o: any) => o.name === "channel")?.type).toBe(
      ApplicationCommandOptionType.Channel,
    );
    expect(create?.options?.find((o: any) => o.name === "channel")?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]);

    expect(edit?.options?.find((o: any) => o.name === "clan")?.required).toBe(true);
    expect(edit?.options?.find((o: any) => o.name === "clan")?.autocomplete).toBe(true);
  });
});
