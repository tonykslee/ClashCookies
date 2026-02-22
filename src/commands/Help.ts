import { CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { Commands } from "../Commands";

export const Help: Command = {
  name: "help",
  description: "List all available commands",
  run: async (_client: Client, interaction: CommandInteraction) => {
    const commandList = Commands.map(
      (cmd) => `- **/${cmd.name}**: ${cmd.description}`
    ).join("\n");

    const permissionNotes = [
      "**Permission notes:**",
      "- Administrator-only by default: `/tracked-clan add|remove`, `/permission add|remove`, `/sheet link|unlink|show`, `/post sync time`.",
      "- Other commands default to everyone unless restricted with `/permission`.",
    ].join("\n");

    await interaction.reply({
      ephemeral: true,
      content: `Here are all available commands:\n\n${commandList}\n\n${permissionNotes}`,
    });
  },
};
