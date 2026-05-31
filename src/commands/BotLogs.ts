import {
  ApplicationCommandOptionType,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";
import {
  BOT_LOG_CHANNEL_TYPES,
  BotLogChannelService,
  type BaseSwapBotLogRoutingMode,
  type BotLogChannelType,
} from "../services/BotLogChannelService";

const BOT_LOGS_SET_CHANNEL_OPTION = "set-channel";
const BOT_LOGS_TYPE_OPTION = "type";
const BOT_LOGS_ENABLE_OPTION = "enable";
const BOT_LOGS_CHANNEL_OPTION = "channel";
const BOT_LOGS_BASE_SWAP_TYPE: BotLogChannelType = "base-swap";
const BOT_LOGS_MAINTENANCE_TYPE: BotLogChannelType = "maintenance";
const BOT_LOGS_SYNC_TYPE: BotLogChannelType = "sync";
const LEGACY_SYNC_POST_CHANNEL_SETTING_PREFIX = "guild_sync_post_channel";
const BOT_LOGS_BASE_SWAP_ENABLE_CHOICES = [
  "clan-log channel",
  "clan-lead channel",
  "bot-log channel",
  "custom",
  "false",
] as const;
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

function parseBaseSwapRoutingMode(
  value: string | null,
): BaseSwapBotLogRoutingMode | null {
  if (value === "clan-log channel") return "CLAN_LOG";
  if (value === "clan-lead channel") return "CLAN_LEAD";
  if (value === "bot-log channel") return "BOT_LOG";
  if (value === "custom") return "CUSTOM";
  if (value === "false") return "DISABLED";
  return null;
}

function formatBaseSwapRoutingMode(mode: BaseSwapBotLogRoutingMode): string {
  if (mode === "CLAN_LOG") return "clan-log channel";
  if (mode === "CLAN_LEAD") return "clan-lead channel";
  if (mode === "BOT_LOG") return "bot-log channel";
  if (mode === "CUSTOM") return "custom";
  return "false";
}

function legacySyncPostChannelKey(guildId: string): string {
  return `${LEGACY_SYNC_POST_CHANNEL_SETTING_PREFIX}:${guildId}`;
}

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

function isSupportedSyncBotLogsChannel(channel: BotLogsChannel): boolean {
  if (typeof channel.type !== "number") return false;
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
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
    {
      name: BOT_LOGS_ENABLE_OPTION,
      description: "Base-swap audit-log routing mode",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: BOT_LOGS_BASE_SWAP_ENABLE_CHOICES.map((choice) => ({
        name: choice,
        value: choice,
      })),
    },
    {
      name: BOT_LOGS_CHANNEL_OPTION,
      description: "Custom base-swap audit-log channel/thread, or sync destination channel",
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
    const enableRaw = interaction.options.getString(BOT_LOGS_ENABLE_OPTION, false);
    const requestedChannel = interaction.options.getChannel(
      BOT_LOGS_SET_CHANNEL_OPTION,
      false
    ) as BotLogsChannel | null;
    const customRoutingChannel = interaction.options.getChannel(
      BOT_LOGS_CHANNEL_OPTION,
      false,
    ) as BotLogsChannel | null;

    if (enableRaw && requestedType !== BOT_LOGS_BASE_SWAP_TYPE) {
      await interaction.reply({
        ephemeral: true,
        content: "`enable` is only supported with `type:base-swap`.",
      });
      return;
    }

    if (
      customRoutingChannel &&
      requestedType !== BOT_LOGS_BASE_SWAP_TYPE &&
      requestedType !== BOT_LOGS_SYNC_TYPE
    ) {
      await interaction.reply({
        ephemeral: true,
        content:
          "`channel` is only supported with `type:base-swap enable:custom` or `type:sync`.",
      });
      return;
    }

    if (enableRaw) {
      const routingMode = parseBaseSwapRoutingMode(enableRaw);
      if (!routingMode) {
        await interaction.reply({
          ephemeral: true,
          content: "Invalid base-swap routing mode.",
        });
        return;
      }

      if (customRoutingChannel && routingMode !== "CUSTOM") {
        await interaction.reply({
          ephemeral: true,
          content: "`channel` is only valid with `type:base-swap enable:custom`.",
        });
        return;
      }

      if (routingMode === "CUSTOM" && !customRoutingChannel) {
        await interaction.reply({
          ephemeral: true,
          content: "`enable:custom` requires `channel`.",
        });
        return;
      }

      if (customRoutingChannel) {
        if (!isGuildScopedChannel(customRoutingChannel, interaction.guildId)) {
          await interaction.reply({
            ephemeral: true,
            content: "Selected channel must belong to this server.",
          });
          return;
        }

        if (!isSupportedBotLogsChannel(customRoutingChannel)) {
          await interaction.reply({
            ephemeral: true,
            content:
              "Selected channel must be a server text, announcement, or thread channel.",
          });
          return;
        }
      }

      await botLogChannelService.setBaseSwapRoutingConfig({
        guildId: interaction.guildId,
        routingMode,
        channelId: routingMode === "CUSTOM" ? customRoutingChannel?.id : null,
      });
      await interaction.reply({
        ephemeral: true,
        content:
          routingMode === "CUSTOM"
            ? `Base-swap audit-log routing saved: custom <#${customRoutingChannel?.id}>.`
            : `Base-swap audit-log routing saved: ${formatBaseSwapRoutingMode(routingMode)}.`,
      });
      return;
    }

    if (customRoutingChannel) {
      if (requestedType === BOT_LOGS_SYNC_TYPE) {
        if (!isGuildScopedChannel(customRoutingChannel, interaction.guildId)) {
          await interaction.reply({
            ephemeral: true,
            content: "Selected channel must belong to this server.",
          });
          return;
        }

        if (!isSupportedSyncBotLogsChannel(customRoutingChannel)) {
          await interaction.reply({
            ephemeral: true,
            content: "Selected channel must be a server text or announcement channel.",
          });
          return;
        }

        await botLogChannelService.setChannelIdForType(
          interaction.guildId,
          requestedType,
          customRoutingChannel.id,
        );
        await new SettingsService().delete(legacySyncPostChannelKey(interaction.guildId));
        await interaction.reply({
          ephemeral: true,
          content: `Sync bot-log channel saved: <#${customRoutingChannel.id}>.`,
        });
        return;
      }

      await interaction.reply({
        ephemeral: true,
        content: "`channel` is only valid with `type:base-swap enable:custom`.",
      });
      return;
    }

    if (requestedChannel) {
      if (!isGuildScopedChannel(requestedChannel, interaction.guildId)) {
        await interaction.reply({
          ephemeral: true,
          content: "Selected channel must belong to this server.",
        });
        return;
      }

      const channelSupported =
        requestedType === BOT_LOGS_SYNC_TYPE
          ? isSupportedSyncBotLogsChannel(requestedChannel)
          : isSupportedBotLogsChannel(requestedChannel);
      if (!channelSupported) {
        await interaction.reply({
          ephemeral: true,
          content:
            requestedType === BOT_LOGS_SYNC_TYPE
              ? "Selected channel must be a server text or announcement channel."
              : "Selected channel must be a server text, announcement, or thread channel.",
        });
        return;
      }

      if (requestedType === BOT_LOGS_BASE_SWAP_TYPE) {
        await botLogChannelService.setBaseSwapRoutingConfig({
          guildId: interaction.guildId,
          routingMode: "CUSTOM",
          channelId: requestedChannel.id,
        });
        await botLogChannelService.setChannelIdForType(
          interaction.guildId,
          requestedType,
          requestedChannel.id,
        );
        await interaction.reply({
          ephemeral: true,
          content: `Base-swap audit-log routing saved: custom <#${requestedChannel.id}>.`,
        });
        return;
      }

      if (
        requestedType === BOT_LOGS_MAINTENANCE_TYPE ||
        requestedType === BOT_LOGS_SYNC_TYPE
      ) {
        await botLogChannelService.setChannelIdForType(
          interaction.guildId,
          requestedType,
          requestedChannel.id,
        );
        if (requestedType === BOT_LOGS_SYNC_TYPE) {
          await new SettingsService().delete(legacySyncPostChannelKey(interaction.guildId));
        }
        await interaction.reply({
          ephemeral: true,
          content:
            requestedType === BOT_LOGS_SYNC_TYPE
              ? `Sync bot-log channel saved: <#${requestedChannel.id}>.`
              : `Maintenance bot-log channel saved: <#${requestedChannel.id}>.`,
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
      const routingConfig =
        await botLogChannelService.getBaseSwapRoutingConfig(interaction.guildId);
      if (!routingConfig) {
        await interaction.reply({
          ephemeral: true,
          content:
            "Base-swap audit-log routing is using the default: typed base-swap bot-log channel if configured, otherwise generic bot-log channel.",
        });
        return;
      }

      if (routingConfig.routingMode !== "CUSTOM") {
        await interaction.reply({
          ephemeral: true,
          content: `Current base-swap audit-log routing: ${formatBaseSwapRoutingMode(
            routingConfig.routingMode,
          )}.`,
        });
        return;
      }

      const configuredChannelId = routingConfig.channelId;
      if (!configuredChannelId) {
        await interaction.reply({
          ephemeral: true,
          content: "No base-swap custom audit-log channel is configured yet.",
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
          content: `Current base-swap audit-log routing: custom <#${configuredChannelId}>.`,
        });
        return;
      }

      if (channelState === "missing") {
        await botLogChannelService.clearBaseSwapRoutingConfig(interaction.guildId);
        await botLogChannelService.clearChannelIdForType(
          interaction.guildId,
          requestedType,
        );
        await interaction.reply({
          ephemeral: true,
          content:
            `Configured base-swap audit-log channel <#${configuredChannelId}> no longer exists. ` +
            "Set a new one with `/bot-logs type:base-swap enable:custom channel:<channel>`.",
        });
        return;
      }

      await interaction.reply({
        ephemeral: true,
        content:
          `Configured base-swap audit-log channel <#${configuredChannelId}> is no longer accessible. ` +
          "Set a new one with `/bot-logs type:base-swap enable:custom channel:<channel>`.",
      });
      return;
    }

    if (
      requestedType === BOT_LOGS_MAINTENANCE_TYPE ||
      requestedType === BOT_LOGS_SYNC_TYPE
    ) {
      const configuredChannelId = await botLogChannelService.getChannelIdForType(
        interaction.guildId,
        requestedType,
      );
      if (!configuredChannelId) {
        await interaction.reply({
          ephemeral: true,
          content:
            requestedType === BOT_LOGS_SYNC_TYPE
              ? "No sync bot-log channel is configured yet."
              : "No maintenance bot-log channel is configured yet.",
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
          content:
            requestedType === BOT_LOGS_SYNC_TYPE
              ? `Current sync bot-log channel: <#${configuredChannelId}>.`
              : `Current maintenance bot-log channel: <#${configuredChannelId}>.`,
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
            requestedType === BOT_LOGS_SYNC_TYPE
              ? `Configured sync bot-log channel <#${configuredChannelId}> no longer exists. ` +
                "I cleared the saved setting. Set a new one with `/bot-logs type:sync channel:<channel>`."
              : `Configured maintenance bot-log channel <#${configuredChannelId}> no longer exists. ` +
                "I cleared the saved setting. Set a new one with `/bot-logs type:maintenance set-channel`.",
        });
        return;
      }

      await interaction.reply({
        ephemeral: true,
        content:
          requestedType === BOT_LOGS_SYNC_TYPE
            ? `Configured sync bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
              "Set a new one with `/bot-logs type:sync channel:<channel>`."
            : `Configured maintenance bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
              "Set a new one with `/bot-logs type:maintenance set-channel`.",
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
