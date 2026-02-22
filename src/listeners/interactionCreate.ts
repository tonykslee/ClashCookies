import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Interaction,
  ModalSubmitInteraction,
} from "discord.js";
import { Commands } from "../Commands";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import { handlePostModalSubmit, isPostModalCustomId } from "../commands/Post";
import { CommandPermissionService } from "../services/CommandPermissionService";

const commandPermissionService = new CommandPermissionService();

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

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
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

const handleModalSubmit = async (
  interaction: ModalSubmitInteraction
): Promise<void> => {
  if (!isPostModalCustomId(interaction.customId)) return;

  try {
    const allowed = await commandPermissionService.canUseCommand("post", interaction);
    if (!allowed) {
      await interaction.reply({
        content: "You do not have permission to use /post.",
        ephemeral: true,
      });
      return;
    }

    await handlePostModalSubmit(interaction);
  } catch (err) {
    console.error(`Modal submit failed: ${formatError(err)}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.deferred) {
      await interaction.editReply("Something went wrong.");
    }
  }
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
    const allowed = await commandPermissionService.canUseCommand(
      interaction.commandName,
      interaction
    );
    if (!allowed) {
      await interaction.reply({
        content: `You do not have permission to use /${interaction.commandName}.`,
        ephemeral: true,
      });
      return;
    }

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
