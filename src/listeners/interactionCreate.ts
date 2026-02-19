import {
  Client,
  Interaction,
  ChatInputCommandInteraction,
} from "discord.js";
import { Commands } from "../Commands";
import { CoCService } from "../services/CoCService";

let isRegistered = false;

export default (client: Client, cocService: CoCService): void => {
  if (isRegistered) {
    console.warn("interactionCreate already registered, skipping");
    return;
  }

  isRegistered = true;
  
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    console.log("Received interaction:", interaction.commandName, interaction.options);

    await handleSlashCommand(client, interaction, cocService);
  });
};

const handleSlashCommand = async (
  client: Client,
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> => {
  const slashCommand = Commands.find(
    (c) => c.name === interaction.commandName
  );

  if (!slashCommand) {
    try {
      await interaction.reply({
        ephemeral: true,
        content: "An error has occurred",
      });
    } catch {}
    return;
  }

  try {
    await slashCommand.run(client, interaction, cocService);
  } catch (err) {
    console.error("Command failed:", err);
    if (!interaction.replied) {
      await interaction.reply({
        content: "⚠️ Something went wrong.",
        ephemeral: true,
      });
    }
  }
  
};
