import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Interaction,
} from "discord.js";
import { Commands } from "../Commands";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";

let isRegistered = false;

export default (client: Client, cocService: CoCService): void => {
  if (isRegistered) {
    console.warn("interactionCreate already registered, skipping");
    return;
  }

  isRegistered = true;

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const user = `${interaction.user.tag} (${interaction.user.id})`;
    const guild = interaction.guild
      ? `${interaction.guild.name} (${interaction.guild.id})`
      : "DM";
    const options = interaction.options.data
      .map((opt) => `${opt.name}=${String(opt.value ?? "")}`)
      .join(", ");

    console.log(
      `[cmd] user=${user} guild=${guild} command=/${interaction.commandName}` +
        (options ? ` options={${options}}` : "")
    );

    await handleSlashCommand(client, interaction, cocService);
  });
};

const handleAutocomplete = async (
  interaction: AutocompleteInteraction
): Promise<void> => {
  const slashCommand = Commands.find((c) => c.name === interaction.commandName);
  if (!slashCommand?.autocomplete) {
    try {
      await interaction.respond([]);
    } catch {
      // no-op
    }
    return;
  }

  try {
    await slashCommand.autocomplete(interaction);
  } catch (err) {
    console.error(`Autocomplete failed: ${formatError(err)}`);
    try {
      await interaction.respond([]);
    } catch {
      // no-op
    }
  }
};

const handleSlashCommand = async (
  client: Client,
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> => {
  const slashCommand = Commands.find((c) => c.name === interaction.commandName);

  if (!slashCommand) {
    try {
      await interaction.reply({
        ephemeral: true,
        content: "An error has occurred",
      });
    } catch {
      // no-op
    }
    return;
  }

  try {
    await slashCommand.run(client, interaction, cocService);
  } catch (err) {
    console.error(`Command failed: ${formatError(err)}`);
    if (!interaction.replied) {
      await interaction.reply({
        content: "Something went wrong.",
        ephemeral: true,
      });
    }
  }
};
