import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";

function normalizeTag(input: string): string {
  return input.trim().replace(/^#/, "");
}

export const CC: Command = {
  name: "cc",
  description: "Build ClashChamps URLs for player or clan tags",
  options: [
    {
      name: "player",
      description: "Build player URL by tag",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "clan",
      description: "Build clan URL by tag",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    try {
      const subcommand = interaction.options.getSubcommand(true);
      const rawTag = interaction.options.getString("tag", true);
      const tag = normalizeTag(rawTag);

      if (!tag) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Please provide a valid tag.",
        });
        return;
      }

      const url =
        subcommand === "player"
          ? `https://cc.fwafarm.com/cc_n/member.php?tag=${tag}`
          : `https://cc.fwafarm.com/cc_n/clan.php?tag=${tag}`;

      await safeReply(interaction, {
        ephemeral: true,
        content: url,
      });
    } catch (err) {
      console.error(`cc command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to build CC URL. Check the tag and try again.",
      });
    }
  },
};

