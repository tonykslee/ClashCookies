import { CommandInteraction, Client } from "discord.js";
import { Command } from "../Command";

export const Hello: Command = {
  name: "hello",
  description: "Returns a greeting",
  run: async (
    client: Client,
    interaction: CommandInteraction
  ) => {
    await interaction.reply({
      ephemeral: true,
      content: "Hello world! 👋",
    });
  },
};
