import {
  Client,
  ChatInputCommandInteraction,
  ApplicationCommandOptionType,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { safeReply } from "../helper/safeReply";

export const GetClanName: Command = {
  name: "clan-name",
  description: "Get the name of a Clash of Clans clan by tag",
  options: [
    {
      name: "tag",
      description: "Clan tag (example: #2QG2C08UP)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    try {
      const clanTag = interaction.options.getString("tag", true);
      const clanName = await cocService.getClanName(clanTag);

      await safeReply(interaction, {
        ephemeral: true,
        content: `🏰 **Clan Name:** ${clanName}`,
      });
    } catch (err) {
      console.error("GetClanName error:", err);

      await safeReply(interaction, {
        ephemeral: true,
        content: "❌ Failed to fetch clan name. Please check the clan tag.",
      });
    }
  },
};
