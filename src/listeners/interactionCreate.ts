import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Interaction,
  ModalSubmitInteraction,
} from "discord.js";
import { Commands } from "../Commands";
import { truncateDiscordContent } from "../helper/discordContent";
import { formatError } from "../helper/formatError";
import { CoCService } from "../services/CoCService";
import { handlePostModalSubmit, isPostModalCustomId } from "../commands/Post";
import {
  handleRecruitmentModalSubmit,
  isRecruitmentModalCustomId,
} from "../commands/Recruitment";
import {
  handlePointsPostButton,
  isPointsPostButtonCustomId,
} from "../commands/Points";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../services/CommandPermissionService";

const commandPermissionService = new CommandPermissionService();

let isRegistered = false;

function isMissingBotPermissionsError(err: unknown): boolean {
  const code = (err as { code?: number } | null | undefined)?.code;
  return code === 50013 || code === 50001;
}

function missingPermissionMessage(context: string): string {
  return `I couldn't complete ${context} because I'm missing one or more required Discord permissions. Please update my role permissions/channel overrides and retry.`;
}

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

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
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

const handleButtonInteraction = async (interaction: Interaction): Promise<void> => {
  if (!interaction.isButton()) return;

  if (isPointsPostButtonCustomId(interaction.customId)) {
    try {
      await handlePointsPostButton(interaction);
    } catch (err) {
      console.error(`Points post button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to post points message to channel.",
        });
      }
    }
  }
};

const handleModalSubmit = async (
  interaction: ModalSubmitInteraction
): Promise<void> => {
  const isPostModal = isPostModalCustomId(interaction.customId);
  const isRecruitmentModal = isRecruitmentModalCustomId(interaction.customId);
  if (!isPostModal && !isRecruitmentModal) return;

  try {
    const targets = isPostModal
      ? ["post:sync:time", "post"]
      : ["recruitment:edit", "recruitment"];
    const allowed = await commandPermissionService.canUseAnyTarget(targets, interaction);
    if (!allowed) {
      await interaction.reply({
        content: isPostModal
          ? "You do not have permission to use /post."
          : "You do not have permission to use /recruitment.",
        ephemeral: true,
      });
      return;
    }

    if (isPostModal) {
      await handlePostModalSubmit(interaction);
      return;
    }
    await handleRecruitmentModalSubmit(interaction);
  } catch (err) {
    console.error(`Modal submit failed: ${formatError(err)}`);
    const message = isMissingBotPermissionsError(err)
      ? missingPermissionMessage("that modal action")
      : "Something went wrong.";

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: truncateDiscordContent(message),
        ephemeral: true,
      });
      return;
    }

    if (interaction.deferred) {
      await interaction.editReply(truncateDiscordContent(message));
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
        content: truncateDiscordContent("An error has occurred"),
      });
    } catch {
      // no-op
    }
    return;
  }

  try {
    const targets = getCommandTargetsFromInteraction(interaction);
    const allowed = await commandPermissionService.canUseAnyTarget(
      targets,
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
    const message = isMissingBotPermissionsError(err)
      ? missingPermissionMessage(`/${interaction.commandName}`)
      : "Something went wrong.";

    if (interaction.deferred) {
      await interaction.editReply(truncateDiscordContent(message)).catch(() => undefined);
      return;
    }

    if (!interaction.replied) {
      await interaction.reply({
        content: truncateDiscordContent(message),
        ephemeral: true,
      });
    }
  }
};
