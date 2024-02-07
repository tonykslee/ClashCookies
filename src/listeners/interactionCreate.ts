import { CommandInteraction, Client, Interaction } from "discord.js";
import { Commands } from "../Commands";
import { Client as ClashClient } from 'clashofclans.js';

export default (client: Client, clashClient: ko.Observable): void => {
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isCommand() || interaction.isContextMenuCommand()) {
      await handleSlashCommand(client, interaction, clashClient);
    }
  });
};

const handleSlashCommand = async (
  client: Client,
  interaction: CommandInteraction,
  clashClient: ko.Observable
): Promise<void> => {
  const slashCommand = Commands.find((c) => c.name === interaction.commandName);
  if (!slashCommand) {
    interaction.followUp({ content: "An error has occurred" });
    return;
  }
  await interaction.deferReply();

  slashCommand.run(client, interaction, clashClient);
};
