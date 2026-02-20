
import { CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";
import { Commands } from "../Commands";


export const Help: Command = {
  name: "help",
  description: "List all available commands",
  run: async (
    client: Client,
    interaction: CommandInteraction
  ) => {
    const commandList = Commands.map(cmd => `• **/${cmd.name}**: ${cmd.description}`).join("\n");
    await interaction.reply({
      ephemeral: true,
      content: `Here are all available commands:\n\n${commandList}`,
    });
  },
};
