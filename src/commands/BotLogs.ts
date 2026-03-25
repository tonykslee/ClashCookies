import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { BotLogChannelService } from "../services/BotLogChannelService";

const BOT_LOGS_SET_CHANNEL_OPTION = "set-channel";
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

      await botLogChannelService.setChannelId(interaction.guildId, requestedChannel.id);
      await interaction.reply({
        ephemeral: true,
        content: `Bot-log channel saved: <#${requestedChannel.id}>.`,
      });
      return;
    }

    const configuredChannelId = await botLogChannelService.getChannelId(interaction.guildId);
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
