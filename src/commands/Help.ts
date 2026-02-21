import { CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { Commands } from "../Commands";

export const Help: Command = {
  name: "help",
  description: "List all available commands",
  run: async (
    _client: Client,
    interaction: CommandInteraction
  ) => {
    const commandList = Commands.map(
      (cmd) => `- **/${cmd.name}**: ${cmd.description}`
    ).join("\n");

    const permissionNotes = [
      "**Permission notes:**",
      "- `/sheet` subcommands require Administrator.",
      "- `/tracked-clan add` and `/tracked-clan remove` require Administrator.",
      "- `/tracked-clan list` is available to non-admin users.",
    ].join("\n");

    await interaction.reply({
      ephemeral: true,
      content: `Here are all available commands:\n\n${commandList}\n\n${permissionNotes}`,
    });
  },
};
