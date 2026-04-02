import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Unlinked } from "../src/commands/Unlinked";

describe("/unlinked command shape", () => {
  it("registers set-alert and list subcommands with the expected options", () => {
    const setAlert = Unlinked.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "set-alert",
    );
    const list = Unlinked.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "list",
    );

    expect(setAlert).toBeTruthy();
    expect(list).toBeTruthy();
    expect(setAlert?.options?.find((option: any) => option.name === "channel")).toMatchObject({
      type: ApplicationCommandOptionType.Channel,
      description: "Channel or thread for unlinked-player alerts",
      required: true,
      channel_types: [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
      ],
    });
    expect(list?.options?.find((option: any) => option.name === "clan")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    });
  });
});
