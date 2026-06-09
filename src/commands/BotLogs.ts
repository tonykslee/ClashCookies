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
  type RoutedBotLogChannelType,
  type SimpleBotLogChannelType,
} from "../services/BotLogChannelService";

const BOT_LOGS_TYPE_OPTION = "type";
const BOT_LOGS_ENABLE_OPTION = "enable";
const BOT_LOGS_CHANNEL_OPTION = "channel";
const BOT_LOGS_BASE_SWAP_TYPE: SimpleBotLogChannelType = "base-swap";
const BOT_LOGS_MAINTENANCE_TYPE: SimpleBotLogChannelType = "maintenance";
const BOT_LOGS_SYNC_TYPE: SimpleBotLogChannelType = "sync";
const BOT_LOGS_CHECKLIST_TYPE: SimpleBotLogChannelType = "checklist";
const BOT_LOGS_BAN_LOG_TYPE: RoutedBotLogChannelType = "ban-log";
const BOT_LOGS_BAN_JOIN_ALERT_TYPE: RoutedBotLogChannelType = "ban-join-alert";
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

function isRoutedBotLogType(
  type: BotLogChannelType | null,
): type is RoutedBotLogChannelType {
  return type === BOT_LOGS_BAN_LOG_TYPE || type === BOT_LOGS_BAN_JOIN_ALERT_TYPE;
}

function formatRoutedBotLogLabel(type: RoutedBotLogChannelType): string {
  return type === BOT_LOGS_BAN_LOG_TYPE ? "Ban log" : "Ban join alert";
}

function formatRoutedBotLogCommandHint(type: RoutedBotLogChannelType): string {
  return `/bot-logs type:${type} channel:<channel>`;
}

function formatRoutedBotLogModeLabel(mode: BaseSwapBotLogRoutingMode): string {
  if (mode === "CLAN_LOG") return "clan-log channel";
  if (mode === "CLAN_LEAD") return "clan-lead channel";
  if (mode === "BOT_LOG") return "bot-log channel";
  if (mode === "CUSTOM") return "custom";
  return "disabled";
}

function parseRoutedBotLogRoutingMode(
  type: RoutedBotLogChannelType,
  value: string | null,
): BaseSwapBotLogRoutingMode | null {
  if (value === "bot-log channel") return "BOT_LOG";
  if (value === "custom") return "CUSTOM";
  if (value === "false") return "DISABLED";
  if (type === BOT_LOGS_BAN_JOIN_ALERT_TYPE) {
    if (value === "clan-log channel") return "CLAN_LOG";
    if (value === "clan-lead channel") return "CLAN_LEAD";
  }
  return null;
}

function formatRoutedBotLogSummary(
  type: RoutedBotLogChannelType,
  config: {
    configured: boolean;
    routingMode: BaseSwapBotLogRoutingMode;
    channelId: string | null;
  },
): string {
  const label = formatRoutedBotLogLabel(type);
  if (!config.configured) {
    return type === BOT_LOGS_BAN_JOIN_ALERT_TYPE
      ? `${label}: Default clan-lead channel`
      : `${label}: Disabled`;
  }

  if (config.routingMode === "DISABLED") {
    return `${label}: Disabled`;
  }
  if (config.routingMode === "CLAN_LOG") {
    return `${label}: clan-log channel`;
  }
  if (config.routingMode === "CLAN_LEAD") {
    return `${label}: clan-lead channel`;
  }
  if (config.routingMode === "BOT_LOG") {
    return `${label}: bot-log channel`;
  }
  if (!config.channelId) {
    return `${label}: custom (no channel)`;
  }
  return `${label}: custom ${formatChannelMention(config.channelId)}`;
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

function isSimpleTypedDestination(type: BotLogChannelType | null): type is SimpleBotLogChannelType {
  return (
    type === BOT_LOGS_MAINTENANCE_TYPE ||
    type === BOT_LOGS_SYNC_TYPE ||
    type === BOT_LOGS_CHECKLIST_TYPE
  );
}

function formatSimpleTypedDestinationLabel(type: SimpleBotLogChannelType): string {
  if (type === BOT_LOGS_SYNC_TYPE) return "Sync";
  if (type === BOT_LOGS_CHECKLIST_TYPE) return "Checklist";
  return "Maintenance";
}

function formatSimpleTypedCommandHint(type: SimpleBotLogChannelType): string {
  if (type === BOT_LOGS_SYNC_TYPE) return "/bot-logs type:sync channel:<channel>";
  if (type === BOT_LOGS_CHECKLIST_TYPE) {
    return "/bot-logs type:checklist channel:<channel>";
  }
  return "/bot-logs type:maintenance channel:<channel>";
}

function formatChannelMention(channelId: string): string {
  return `<#${channelId}>`;
}

function formatStaleChannelRowLabel(label: string, channelId: string): string {
  return `${label}: Stale ${formatChannelMention(channelId)} (cleared)`;
}

function formatInaccessibleChannelRowLabel(label: string, channelId: string): string {
  return `${label}: Inaccessible ${formatChannelMention(channelId)}`;
}

async function renderSimpleTypedBotLogRow(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
  type: "maintenance" | "sync" | "checklist",
): Promise<string> {
  const label = formatSimpleTypedDestinationLabel(type);
  const configuredChannelId = await botLogChannelService.getChannelIdForType(
    guildId,
    type,
  );
  if (!configuredChannelId) {
    return `${label}: Not configured`;
  }

  const channelState = await resolveConfiguredChannelState(
    interaction,
    configuredChannelId,
  );
  if (channelState === "found") {
    return `${label}: ${formatChannelMention(configuredChannelId)}`;
  }

  if (channelState === "missing") {
    await botLogChannelService.clearChannelIdForType(guildId, type);
    return formatStaleChannelRowLabel(label, configuredChannelId);
  }

  return formatInaccessibleChannelRowLabel(label, configuredChannelId);
}

async function renderGenericBotLogRow(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
): Promise<string> {
  const configuredChannelId = await botLogChannelService.getChannelId(
    guildId,
  );
  if (!configuredChannelId) {
    return "Generic: Not configured";
  }

  const channelState = await resolveConfiguredChannelState(
    interaction,
    configuredChannelId,
  );
  if (channelState === "found") {
    return `Generic: ${formatChannelMention(configuredChannelId)}`;
  }

  if (channelState === "missing") {
    await botLogChannelService.clearChannelId(guildId);
    return formatStaleChannelRowLabel("Generic", configuredChannelId);
  }

  return formatInaccessibleChannelRowLabel("Generic", configuredChannelId);
}

async function renderBaseSwapBotLogRow(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
): Promise<string> {
  const routingConfig =
    await botLogChannelService.getBaseSwapRoutingConfig(guildId);
  if (!routingConfig) {
    return "Base-swap: Default";
  }

  if (routingConfig.routingMode !== "CUSTOM") {
    return `Base-swap: ${formatBaseSwapRoutingMode(routingConfig.routingMode)}`;
  }

  const configuredChannelId = routingConfig.channelId;
  if (!configuredChannelId) {
    return "Base-swap: custom (no channel)";
  }

  const channelState = await resolveConfiguredChannelState(
    interaction,
    configuredChannelId,
  );
  if (channelState === "found") {
    return `Base-swap: custom ${formatChannelMention(configuredChannelId)}`;
  }

  if (channelState === "missing") {
    await botLogChannelService.clearBaseSwapRoutingConfig(guildId);
    await botLogChannelService.clearChannelIdForType(
      guildId,
      BOT_LOGS_BASE_SWAP_TYPE,
    );
    return `Base-swap: Stale custom ${formatChannelMention(configuredChannelId)} (cleared)`;
  }

  return `Base-swap: Inaccessible custom ${formatChannelMention(configuredChannelId)}`;
}

async function renderRoutedBotLogRow(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
  type: RoutedBotLogChannelType,
): Promise<string> {
  const routingConfig = await botLogChannelService.getRoutingConfigForType(
    guildId,
    type,
  );
  const label = formatRoutedBotLogLabel(type);

  if (!routingConfig.configured) {
    return formatRoutedBotLogSummary(type, routingConfig);
  }

  if (routingConfig.routingMode === "DISABLED") {
    return `${label}: Disabled`;
  }
  if (routingConfig.routingMode === "CLAN_LOG") {
    return `${label}: clan-log channel`;
  }
  if (routingConfig.routingMode === "CLAN_LEAD") {
    return `${label}: clan-lead channel`;
  }
  if (routingConfig.routingMode === "BOT_LOG") {
    const configuredChannelId = await botLogChannelService.getChannelId(
      guildId,
    );
    if (!configuredChannelId) {
      return `${label}: bot-log channel unavailable`;
    }

    const channelState = await resolveConfiguredChannelState(
      interaction,
      configuredChannelId,
    );
    if (channelState === "found") {
      return `${label}: bot-log ${formatChannelMention(configuredChannelId)}`;
    }

    if (channelState === "missing") {
      await botLogChannelService.clearChannelId(guildId);
      return `${label}: bot-log channel ${formatChannelMention(configuredChannelId)} no longer exists (cleared)`;
    }

    return `${label}: bot-log channel ${formatChannelMention(configuredChannelId)} is no longer accessible`;
  }

  const configuredChannelId = routingConfig.channelId;
  if (!configuredChannelId) {
    return `${label}: custom (no channel)`;
  }

  const channelState = await resolveConfiguredChannelState(
    interaction,
    configuredChannelId,
  );
  if (channelState === "found") {
    return `${label}: custom ${formatChannelMention(configuredChannelId)}`;
  }

  if (channelState === "missing") {
    await botLogChannelService.clearRoutingConfigForType(guildId, type);
    return `${label}: Stale custom ${formatChannelMention(configuredChannelId)} (cleared)`;
  }

  return `${label}: Inaccessible custom ${formatChannelMention(configuredChannelId)}`;
}

async function formatRoutedBotLogInspectResponse(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
  type: RoutedBotLogChannelType,
): Promise<string> {
  const label = formatRoutedBotLogLabel(type);
  const routingConfig = await botLogChannelService.getRoutingConfigForType(
    guildId,
    type,
  );

  if (!routingConfig.configured) {
    return type === BOT_LOGS_BAN_JOIN_ALERT_TYPE
      ? `${label} routing defaults to clan-lead channel.`
      : `${label} routing is disabled.`;
  }

  if (routingConfig.routingMode === "DISABLED") {
    return `${label} routing is disabled.`;
  }
  if (routingConfig.routingMode === "CLAN_LOG") {
    return `Current ${label.toLowerCase()} routing: clan-log channel.`;
  }
  if (routingConfig.routingMode === "CLAN_LEAD") {
    return `Current ${label.toLowerCase()} routing: clan-lead channel.`;
  }
  if (routingConfig.routingMode === "BOT_LOG") {
    const configuredChannelId = await botLogChannelService.getChannelId(
      guildId,
    );
    if (!configuredChannelId) {
      return `${label} routing points at the generic /bot-logs channel, but no bot-log channel is configured yet.`;
    }

    const channelState = await resolveConfiguredChannelState(
      interaction,
      configuredChannelId,
    );
    if (channelState === "found") {
      return `Current ${label.toLowerCase()} routing: bot-log ${formatChannelMention(configuredChannelId)}.`;
    }

    if (channelState === "missing") {
      await botLogChannelService.clearChannelId(guildId);
      return `Configured /bot-logs channel <#${configuredChannelId}> no longer exists. I cleared the saved setting. Set a new one with \`/bot-logs channel:<channel>\`.`;
    }

    return `Configured /bot-logs channel <#${configuredChannelId}> is no longer accessible. Set a new one with \`/bot-logs channel:<channel>\`.`;
  }

  const configuredChannelId = routingConfig.channelId;
  if (!configuredChannelId) {
    return `${label} routing is custom, but no channel is configured yet.`;
  }

  const channelState = await resolveConfiguredChannelState(
    interaction,
    configuredChannelId,
  );
  if (channelState === "found") {
    return `Current ${label.toLowerCase()} routing: custom ${formatChannelMention(configuredChannelId)}.`;
  }

  if (channelState === "missing") {
    await botLogChannelService.clearRoutingConfigForType(guildId, type);
    return `Configured ${label.toLowerCase()} custom channel <#${configuredChannelId}> no longer exists. I cleared the saved setting. Set a new one with \`${formatRoutedBotLogCommandHint(type)}\`.`;
  }

  return `Configured ${label.toLowerCase()} custom channel <#${configuredChannelId}> is no longer accessible. Set a new one with \`${formatRoutedBotLogCommandHint(type)}\`.`;
}

async function renderBotLogConfigurationSummary(
  interaction: ChatInputCommandInteraction,
  botLogChannelService: BotLogChannelService,
  guildId: string,
): Promise<string> {
  const rows = [
    await renderGenericBotLogRow(interaction, botLogChannelService, guildId),
    await renderBaseSwapBotLogRow(interaction, botLogChannelService, guildId),
    await renderSimpleTypedBotLogRow(
      interaction,
      botLogChannelService,
      guildId,
      "maintenance",
    ),
    await renderSimpleTypedBotLogRow(
      interaction,
      botLogChannelService,
      guildId,
      "sync",
    ),
    await renderSimpleTypedBotLogRow(
      interaction,
      botLogChannelService,
      guildId,
      "checklist",
    ),
    await renderRoutedBotLogRow(
      interaction,
      botLogChannelService,
      guildId,
      BOT_LOGS_BAN_LOG_TYPE,
    ),
    await renderRoutedBotLogRow(
      interaction,
      botLogChannelService,
      guildId,
      BOT_LOGS_BAN_JOIN_ALERT_TYPE,
    ),
  ];
  return ["Bot-log configurations", ...rows].join("\n");
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
      description: "Destination channel for bot-log posts or custom base-swap routing",
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
      BOT_LOGS_CHANNEL_OPTION,
      false,
    ) as BotLogsChannel | null;

    const isRoutingConfigType =
      requestedType === BOT_LOGS_BASE_SWAP_TYPE ||
      isRoutedBotLogType(requestedType);

    if (enableRaw && !isRoutingConfigType) {
      await interaction.reply({
        ephemeral: true,
        content: "`enable` is only supported with `type:base-swap`, `type:ban-log`, or `type:ban-join-alert`.",
      });
      return;
    }

    if (
      requestedChannel &&
      requestedType !== BOT_LOGS_BASE_SWAP_TYPE &&
      requestedType !== BOT_LOGS_SYNC_TYPE &&
      requestedType !== BOT_LOGS_MAINTENANCE_TYPE &&
      requestedType !== BOT_LOGS_CHECKLIST_TYPE &&
      requestedType !== BOT_LOGS_BAN_LOG_TYPE &&
      requestedType !== BOT_LOGS_BAN_JOIN_ALERT_TYPE &&
      requestedType !== null
    ) {
      await interaction.reply({
        ephemeral: true,
        content:
          "`channel` is only supported for generic, maintenance, sync, checklist, base-swap custom routing, or ban-log/ban-join-alert custom routing.",
      });
      return;
    }

    if (enableRaw) {
      const routingMode = isRoutedBotLogType(requestedType)
        ? parseRoutedBotLogRoutingMode(requestedType, enableRaw)
        : parseBaseSwapRoutingMode(enableRaw);
      if (!routingMode) {
        await interaction.reply({
          ephemeral: true,
          content:
            requestedType === BOT_LOGS_BAN_LOG_TYPE
              ? "Invalid ban-log routing mode. Use bot-log channel, custom, or false."
              : requestedType === BOT_LOGS_BAN_JOIN_ALERT_TYPE
                ? "Invalid ban-join alert routing mode. Use clan-log channel, clan-lead channel, bot-log channel, custom, or false."
                : "Invalid base-swap routing mode.",
        });
        return;
      }

      if (requestedChannel && routingMode !== "CUSTOM") {
        await interaction.reply({
          ephemeral: true,
          content: requestedType === BOT_LOGS_BAN_LOG_TYPE || requestedType === BOT_LOGS_BAN_JOIN_ALERT_TYPE
            ? `\`channel\` is only valid with \`type:${requestedType} enable:custom\`.`
            : "`channel` is only valid with `type:base-swap enable:custom`.",
        });
        return;
      }

      if (routingMode === "CUSTOM" && !requestedChannel) {
        await interaction.reply({
          ephemeral: true,
          content: requestedType === BOT_LOGS_BAN_LOG_TYPE || requestedType === BOT_LOGS_BAN_JOIN_ALERT_TYPE
            ? "`enable:custom` requires `channel`."
            : "`enable:custom` requires `channel`.",
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

        if (!isSupportedBotLogsChannel(requestedChannel)) {
          await interaction.reply({
            ephemeral: true,
            content:
              "Selected channel must be a server text, announcement, or thread channel.",
          });
          return;
        }
      }

      if (requestedType === BOT_LOGS_BAN_LOG_TYPE || requestedType === BOT_LOGS_BAN_JOIN_ALERT_TYPE) {
        await botLogChannelService.setRoutingConfigForType({
          guildId: interaction.guildId,
          type: requestedType,
          routingMode,
          channelId: routingMode === "CUSTOM" ? requestedChannel?.id : null,
        });
      } else {
        await botLogChannelService.setBaseSwapRoutingConfig({
          guildId: interaction.guildId,
          routingMode,
          channelId: routingMode === "CUSTOM" ? requestedChannel?.id : null,
        });
      }
      await interaction.reply({
        ephemeral: true,
        content: requestedType === BOT_LOGS_BAN_LOG_TYPE || requestedType === BOT_LOGS_BAN_JOIN_ALERT_TYPE
          ? `${formatRoutedBotLogLabel(requestedType)} routing saved: ${
              routingMode === "CUSTOM"
                ? `custom <#${requestedChannel?.id}>`
                : formatRoutedBotLogModeLabel(routingMode)
            }.`
          : routingMode === "CUSTOM"
            ? `Base-swap audit-log routing saved: custom <#${requestedChannel?.id}>.`
            : `Base-swap audit-log routing saved: ${formatBaseSwapRoutingMode(routingMode)}.`,
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

      if (
        requestedType === BOT_LOGS_BASE_SWAP_TYPE ||
        isRoutedBotLogType(requestedType)
      ) {
        if (!isSupportedBotLogsChannel(requestedChannel)) {
          await interaction.reply({
            ephemeral: true,
            content:
              "Selected channel must be a server text, announcement, or thread channel.",
          });
          return;
        }
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

      if (isRoutedBotLogType(requestedType)) {
        await botLogChannelService.setRoutingConfigForType({
          guildId: interaction.guildId,
          type: requestedType,
          routingMode: "CUSTOM",
          channelId: requestedChannel.id,
        });
        await interaction.reply({
          ephemeral: true,
          content: `${formatRoutedBotLogLabel(requestedType)} routing saved: custom <#${requestedChannel.id}>.`,
        });
        return;
      }

      const channelSupported =
        requestedType === BOT_LOGS_SYNC_TYPE ||
        requestedType === BOT_LOGS_MAINTENANCE_TYPE ||
        requestedType === BOT_LOGS_CHECKLIST_TYPE ||
        requestedType === null
          ? isSupportedSyncBotLogsChannel(requestedChannel)
          : isSupportedBotLogsChannel(requestedChannel);
      if (!channelSupported) {
        await interaction.reply({
          ephemeral: true,
          content:
          requestedType === BOT_LOGS_SYNC_TYPE
          || requestedType === BOT_LOGS_MAINTENANCE_TYPE
          || requestedType === BOT_LOGS_CHECKLIST_TYPE
          || requestedType === null
            ? "Selected channel must be a server text or announcement channel."
              : "Selected channel must be a server text, announcement, or thread channel.",
        });
        return;
      }

      if (
        requestedType &&
        isSimpleTypedDestination(requestedType)
      ) {
        await botLogChannelService.setChannelIdForType(
          interaction.guildId,
          requestedType,
          requestedChannel.id,
        );
        if (requestedType === BOT_LOGS_SYNC_TYPE) {
          await new SettingsService().delete(legacySyncPostChannelKey(interaction.guildId));
        }
        const label = formatSimpleTypedDestinationLabel(requestedType);
        await interaction.reply({
          ephemeral: true,
          content:
            `${label} bot-log channel saved: <#${requestedChannel.id}>.`,
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

    const requestedNoArgs =
      requestedType === null && !enableRaw && !requestedChannel;

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
      requestedType &&
      isSimpleTypedDestination(requestedType)
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
            : requestedType === BOT_LOGS_CHECKLIST_TYPE
              ? "No checklist bot-log channel is configured yet."
              : "No maintenance bot-log channel is configured yet.",
        });
        return;
      }

      const channelState = await resolveConfiguredChannelState(
        interaction,
        configuredChannelId,
      );
      if (channelState === "found") {
        const label = formatSimpleTypedDestinationLabel(requestedType).toLowerCase();
        await interaction.reply({
          ephemeral: true,
          content:
            `Current ${label} bot-log channel: <#${configuredChannelId}>.`,
        });
        return;
      }

      if (channelState === "missing") {
        await botLogChannelService.clearChannelIdForType(
          interaction.guildId,
          requestedType,
        );
        const label = formatSimpleTypedDestinationLabel(requestedType).toLowerCase();
        const hint = formatSimpleTypedCommandHint(requestedType);
        await interaction.reply({
          ephemeral: true,
          content:
            `Configured ${label} bot-log channel <#${configuredChannelId}> no longer exists. ` +
            `I cleared the saved setting. Set a new one with \`${hint}\`.`,
        });
        return;
      }

      const label = formatSimpleTypedDestinationLabel(requestedType).toLowerCase();
      const hint = formatSimpleTypedCommandHint(requestedType);
      await interaction.reply({
        ephemeral: true,
        content:
          `Configured ${label} bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
          `Set a new one with \`${hint}\`.`,
      });
      return;
    }

    if (requestedType && isRoutedBotLogType(requestedType)) {
      const response = await formatRoutedBotLogInspectResponse(
        interaction,
        botLogChannelService,
        interaction.guildId,
        requestedType,
      );
      await interaction.reply({
        ephemeral: true,
        content: response,
      });
      return;
    }

    if (requestedNoArgs) {
      const summary = await renderBotLogConfigurationSummary(
        interaction,
        botLogChannelService,
        interaction.guildId,
      );
      await interaction.reply({
        ephemeral: true,
        content: summary,
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
          "I cleared the saved setting. Set a new one with `/bot-logs channel:<channel>`.",
      });
      return;
    }

    await interaction.reply({
      ephemeral: true,
      content:
        `Configured bot-log channel <#${configuredChannelId}> is no longer accessible. ` +
        "Set a new one with `/bot-logs channel:<channel>`.",
    });
  },
};
