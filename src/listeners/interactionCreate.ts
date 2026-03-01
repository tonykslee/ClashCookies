import {
  ActionRowBuilder,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Interaction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
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
  handleFwaMatchCopyButton,
  handleFwaMatchSelectMenu,
  handleFwaMatchAllianceButton,
  handleFwaMatchTypeEditButton,
  handleFwaOutcomeActionButton,
  handleFwaMatchTypeActionButton,
  handleFwaMatchSyncActionButton,
  handleFwaMailConfirmButton,
  handleFwaMailRefreshButton,
  handleFwaMatchSendMailButton,
  isFwaMatchAllianceButtonCustomId,
  isFwaMatchSyncActionButtonCustomId,
  isFwaMailConfirmButtonCustomId,
  isFwaMailRefreshButtonCustomId,
  isFwaMatchSendMailButtonCustomId,
  isFwaMatchTypeEditButtonCustomId,
  isFwaOutcomeActionButtonCustomId,
  isFwaMatchSelectCustomId,
  isFwaMatchTypeActionButtonCustomId,
  handlePointsPostButton,
  isFwaMatchCopyButtonCustomId,
  isPointsPostButtonCustomId,
} from "../commands/Fwa";
import {
  CommandPermissionService,
  getCommandTargetsFromInteraction,
} from "../services/CommandPermissionService";

const commandPermissionService = new CommandPermissionService();
const GLOBAL_POST_BUTTON_PREFIX = "post-channel";
const COMMANDS_WITH_CUSTOM_VISIBILITY = new Set(["help", "fwa"]);

let isRegistered = false;

function isMissingBotPermissionsError(err: unknown): boolean {
  const code = (err as { code?: number } | null | undefined)?.code;
  return code === 50013 || code === 50001;
}

function getDiscordErrorCode(err: unknown): number | null {
  const code = (err as { code?: number } | null | undefined)?.code;
  return typeof code === "number" ? code : null;
}

function missingPermissionMessage(context: string): string {
  return `I couldn't complete ${context} because I'm missing one or more required Discord permissions. Please update my role permissions/channel overrides and retry.`;
}

function getRequestedVisibility(interaction: ChatInputCommandInteraction): "private" | "public" {
  try {
    const visibility = interaction.options.getString("visibility", false);
    return visibility === "public" ? "public" : "private";
  } catch {
    return "private";
  }
}

function buildGlobalPostButton(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${GLOBAL_POST_BUTTON_PREFIX}:${userId}`)
      .setLabel("Post to Channel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function maybeAttachPostButton(
  payload: unknown,
  userId: string,
  isPublic: boolean
): unknown {
  if (isPublic) return payload;

  const normalized =
    typeof payload === "string"
      ? { content: payload }
      : payload && typeof payload === "object"
        ? { ...(payload as Record<string, unknown>) }
        : payload;

  if (!normalized || typeof normalized !== "object") return normalized;

  const currentComponents = Array.isArray((normalized as { components?: unknown[] }).components)
    ? ([...(normalized as { components: unknown[] }).components] as unknown[])
    : [];

  if (currentComponents.length >= 5) {
    return normalized;
  }

  currentComponents.push(buildGlobalPostButton(userId));
  return {
    ...normalized,
    components: currentComponents,
  };
}

function coerceInteractionResponseVisibility(payload: unknown, isPublic: boolean): unknown {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    ephemeral: !isPublic,
  };
}

function isGlobalPostButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${GLOBAL_POST_BUTTON_PREFIX}:`);
}

function parseGlobalPostButtonCustomId(customId: string): { userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== GLOBAL_POST_BUTTON_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  if (!userId) return null;
  return { userId };
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

  if (interaction.isStringSelectMenu()) {
    await handleSelectMenuInteraction(interaction);
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

const handleSelectMenuInteraction = async (
  interaction: StringSelectMenuInteraction
): Promise<void> => {
  if (isFwaMatchSelectCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSelectMenu(interaction);
    } catch (err) {
      console.error(`FWA match select menu failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open clan match view.",
        });
      }
    }
  }
};

const handleButtonInteraction = async (interaction: Interaction): Promise<void> => {
  if (!interaction.isButton()) return;

  if (isGlobalPostButtonCustomId(interaction.customId)) {
    const parsed = parseGlobalPostButtonCustomId(interaction.customId);
    if (!parsed) return;

    if (interaction.user.id !== parsed.userId) {
      await interaction.reply({
        ephemeral: true,
        content: "Only the command requester can use this button.",
      });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isTextBased() || !("send" in channel)) {
      await interaction.reply({
        ephemeral: true,
        content: "Could not post to this channel.",
      });
      return;
    }

    try {
      await channel.send({
        content: truncateDiscordContent(interaction.message.content || ""),
        embeds: interaction.message.embeds.map((embed) => embed.toJSON()),
      });
      await interaction.reply({
        ephemeral: true,
        content: "Posted to channel.",
      });
    } catch (err) {
      console.error(`Global post button failed: ${formatError(err)}`);
      await interaction.reply({
        ephemeral: true,
        content: "Failed to post to channel. Check bot permissions and try again.",
      });
    }
    return;
  }

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

  if (isFwaMatchCopyButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchCopyButton(interaction);
    } catch (err) {
      console.error(`FWA match copy button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to toggle match view.",
        });
      }
    }
  }

  if (isFwaMatchTypeActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchTypeActionButton(interaction);
    } catch (err) {
      console.error(`FWA match type action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to apply match type update.",
        });
      }
    }
  }

  if (isFwaMatchTypeEditButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchTypeEditButton(interaction);
    } catch (err) {
      console.error(`FWA match type edit button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open match type options.",
        });
      }
    }
  }

  if (isFwaOutcomeActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaOutcomeActionButton(interaction);
    } catch (err) {
      console.error(`FWA outcome action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to reverse expected outcome.",
        });
      }
    }
  }

  if (isFwaMatchAllianceButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchAllianceButton(interaction);
    } catch (err) {
      console.error(`FWA match alliance button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open alliance view.",
        });
      }
    }
  }

  if (isFwaMatchSyncActionButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSyncActionButton(interaction);
    } catch (err) {
      console.error(`FWA match sync action button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to sync points-site data.",
        });
      }
    }
  }

  if (isFwaMatchSendMailButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMatchSendMailButton(interaction);
    } catch (err) {
      console.error(`FWA match send-mail button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to open war mail preview.",
        });
      }
    }
  }

  if (isFwaMailConfirmButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailConfirmButton(interaction);
    } catch (err) {
      console.error(`FWA mail confirm button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to send war mail.",
        });
      }
    }
  }

  if (isFwaMailRefreshButtonCustomId(interaction.customId)) {
    try {
      await handleFwaMailRefreshButton(interaction);
    } catch (err) {
      console.error(`FWA mail refresh button failed: ${formatError(err)}`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Failed to refresh war mail.",
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
      ? ["sync:time:post", "sync"]
      : ["recruitment:edit", "recruitment"];
    const allowed = await commandPermissionService.canUseAnyTarget(targets, interaction);
    if (!allowed) {
      await interaction.reply({
        content: isPostModal
          ? "You do not have permission to use /sync."
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

    const autoVisibilityEnabled = !COMMANDS_WITH_CUSTOM_VISIBILITY.has(
      interaction.commandName
    );
    if (autoVisibilityEnabled) {
      const visibility = getRequestedVisibility(interaction);
      const isPublic = visibility === "public";
      const originalDeferReply = interaction.deferReply.bind(interaction);
      const originalReply = interaction.reply.bind(interaction);
      const originalEditReply = interaction.editReply.bind(interaction);
      const originalFollowUp = interaction.followUp.bind(interaction);

      (interaction as any).deferReply = async (options?: Record<string, unknown>) =>
        originalDeferReply({
          ...(options ?? {}),
          ephemeral: !isPublic,
        });

      (interaction as any).reply = async (options: unknown) =>
        originalReply(
          maybeAttachPostButton(
            coerceInteractionResponseVisibility(options, isPublic),
            interaction.user.id,
            isPublic
          ) as
            | string
            | Record<string, unknown>
        );

      (interaction as any).editReply = async (options: unknown) =>
        originalEditReply(
          maybeAttachPostButton(options, interaction.user.id, isPublic) as
            | string
            | Record<string, unknown>
        );

      (interaction as any).followUp = async (options: unknown) =>
        originalFollowUp(
          maybeAttachPostButton(
            coerceInteractionResponseVisibility(options, isPublic),
            interaction.user.id,
            isPublic
          ) as
            | string
            | Record<string, unknown>
        );
    }

    await slashCommand.run(client, interaction, cocService);
  } catch (err) {
    console.error(`Command failed: ${formatError(err)}`);
    const message = isMissingBotPermissionsError(err)
      ? missingPermissionMessage(`/${interaction.commandName}`)
      : "Something went wrong.";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(truncateDiscordContent(message));
        return;
      }

      await interaction.reply({
        content: truncateDiscordContent(message),
        ephemeral: true,
      });
    } catch (responseErr) {
      const code = getDiscordErrorCode(responseErr);
      // 10062 Unknown interaction: token expired/invalid; cannot recover.
      if (code === 10062) {
        console.warn(
          `Failed to send error response for /${interaction.commandName}: interaction expired (10062).`
        );
        return;
      }
      // 40060 already acknowledged: try editReply as final fallback.
      if (code === 40060) {
        await interaction
          .editReply(truncateDiscordContent(message))
          .catch(() => undefined);
        return;
      }

      console.error(
        `Failed to send error response for /${interaction.commandName}: ${formatError(responseErr)}`
      );
    }
  }
};
