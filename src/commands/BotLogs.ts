import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import {
  BOT_LOG_CHANNEL_TYPES,
  BotLogChannelService,
  type BotLogChannelType,
} from "../services/BotLogChannelService";

const BOT_LOGS_SET_CHANNEL_OPTION = "set-channel";
const BOT_LOGS_TYPE_OPTION = "type";
const BOT_LOGS_BASE_SWAP_TYPE: BotLogChannelType = "base-swap";
const BOT_LOGS_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

type BotLogsChannel = {
  id: string;
  guildId?: string;
  type?: number;
};

/** Purpose: enforce strict admin-only access for bot-log channel config. */
function hasAdministratorPermission(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

/** Purpose: ensure selected channel belongs to current guild scope. */
function isGuildScopedChannel(channel: BotLogsChannel, guildId: string): boolean {
  const channelGuildId = String(channel.guildId ?? "").trim();
  return Boolean(channelGuildId) && channelGuildId === guildId;
}

/** Purpose: validate selected channel can be used as a bot-log destination. */
function isSupportedBotLogsChannel(channel: BotLogsChannel): boolean {
  if (typeof channel.type !== "number") return false;
  return BOT_LOGS_SUPPORTED_CHANNEL_TYPES.includes(
    channel.type as (typeof BOT_LOGS_SUPPORTED_CHANNEL_TYPES)[number]
  );
}

/** Purpose: classify configured channel state for clear user-facing status responses. */
async function resolveConfiguredChannelState(
  interaction: ChatInputCommandInteraction,
  channelId: string
): Promise<"found" | "missing" | "inaccessible"> {
  const guild = interaction.guild;
  if (!guild) return "inaccessible";

  const cached = guild.channels.cache.get(channelId);
  if (cached) return "found";

  try {
    const fetched = await guild.channels.fetch(channelId);
    return fetched ? "found" : "missing";
  } catch (error) {
    const code = (error as { code?: number } | null | undefined)?.code;
    if (code === 10003) return "missing";
    return "inaccessible";
  }
}

export const BotLogs: Command = {
  name: "bot-logs",
  description: "Set or view the guild channel used for important bot logs",
  options: [
    {
      name: BOT_LOGS_TYPE_OPTION,
      description: "Type of bot log destination to view or update",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: BOT_LOG_CHANNEL_TYPES.map((type) => ({
        name: type,
        value: type,
      })),
    },
    {
      name: BOT_LOGS_SET_CHANNEL_OPTION,
      description: "Channel used for important bot log posts",
      type: ApplicationCommandOptionType.Channel,
      required: false,
      channel_types: [...BOT_LOGS_SUPPORTED_CHANNEL_TYPES],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    if (!hasAdministratorPermission(interaction)) {
      await interaction.reply({
        ephemeral: true,
        content: "You do not have permission to use /bot-logs.",
      });
      return;
    }

    const botLogChannelService = new BotLogChannelService();
    const requestedType = interaction.options.getString(
      BOT_LOGS_TYPE_OPTION,
      false,
    ) as BotLogChannelType | null;
    const requestedChannel = interaction.options.getChannel(
      BOT_LOGS_SET_CHANNEL_OPTION,
      false
    ) as BotLogsChannel | null;

    if (requestedChannel) {
      if (!isGuildScopedChannel(requestedChannel, interaction.guildId)) {
        await interaction.reply({
          ephemeral: true,
          content: "Selected channel must belong to this server.",
        });
        return;
      }

      if (!isSupportedBotLogsChannel(requestedChannel)) {
        await interaction.reply({
          ephemeral: true,
          content:
            "Selected channel must be a server text, announcement, or thread channel.",
        });
        return;
      }

      if (requestedType === BOT_LOGS_BASE_SWAP_TYPE) {
        await botLogChannelService.setChannelIdForType(
          interaction.guildId,
          requestedType,
          requestedChannel.id,
        );
        await interaction.reply({
          ephemeral: true,
          content: `Base-swap bot-log channel saved: <#${requestedChannel.id}>.`,
        });
        return;
      }

      await botLogChannelService.setChannelId(
        interaction.guildId,
        requestedChannel.id,
      );
      await interaction.reply({
        ephemeral: true,
        content: `Bot-log channel saved: <#${requestedChannel.id}>.`,
      });
      return;
    }

    if (requestedType === BOT_LOGS_BASE_SWAP_TYPE) {
      const configuredChannelId = await botLogChannelService.getChannelIdForType(
        interaction.guildId,
        requestedType,
      );
      if (!configuredChannelId) {
        await interaction.reply({
          ephemeral: true,
          content: "No base-swap bot-log channel is configured yet.",
        });
        return;
      }

      const channelState = await resolveConfiguredChannelState(
        interaction,
        configuredChannelId,
      );
      if (channelState === "found") {
        await interaction.reply({
          ephemeral: true,
          content: `Current base-swap bot-log channel: <#${configuredChannelId}>.`,
        });
        return;
      }

      if (channelState === "missing") {
        await botLogChannelService.clearChannelIdForType(
          interaction.guildId,
          requestedType,
        );
        await interaction.reply({
          ephemeral: true,
          content:
            `Configured base-swap bot-log channel <#${configuredChannelId}> no longer exists. ` +
            "I cleared the saved setting. Set a new one with `/bot-logs type:base-swap set-channel`.",
        });
        return;
      }

      await interaction.reply({
        ephemeral: true,
        content:
          `Configured base-swap bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
          "Set a new one with `/bot-logs type:base-swap set-channel`.",
      });
      return;
    }

    const configuredChannelId = await botLogChannelService.getChannelId(
      interaction.guildId,
    );
    if (!configuredChannelId) {
      await interaction.reply({
        ephemeral: true,
        content: "No bot-log channel is configured yet.",
      });
      return;
    }

    const channelState = await resolveConfiguredChannelState(interaction, configuredChannelId);
    if (channelState === "found") {
      await interaction.reply({
        ephemeral: true,
        content: `Current bot-log channel: <#${configuredChannelId}>.`,
      });
      return;
    }

    if (channelState === "missing") {
      await botLogChannelService.clearChannelId(interaction.guildId);
      await interaction.reply({
        ephemeral: true,
        content:
          `Configured bot-log channel <#${configuredChannelId}> no longer exists. ` +
          "I cleared the saved setting. Set a new one with `/bot-logs set-channel`.",
      });
      return;
    }

    await interaction.reply({
      ephemeral: true,
      content:
        `Configured bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
        "Set a new one with `/bot-logs set-channel`.",
    });
  },
};
