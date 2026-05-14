import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  type APIActionRowComponent,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  addWeightInputDefermentWithPlayerProfile,
  clearDeferRoutingChannelOverride,
  buildDeferScopeKey,
  clearOpenWeightInputDeferments,
  checkOpenWeightInputDefermentsForClan,
  getDeferRoutingConfig,
  formatPendingAge,
  listOpenWeightInputDeferments,
  normalizePlayerTag,
  parseDeferWeightInput,
  removeOpenWeightInputDeferment,
  updateDeferRoutingConfig,
} from "../services/WeightInputDefermentService";
import { normalizeTag } from "../services/war-events/core";
import { formatError } from "../helper/formatError";

function renderScopeLabel(scope: { clanTag: string | null; scopeKey: string }): string {
  if (scope.clanTag) return scope.clanTag;
  return scope.scopeKey;
}

function parseRequiredPlayerTag(raw: string): string | null {
  const normalized = normalizePlayerTag(raw);
  if (!normalized) return null;
  return normalized;
}

function renderDeferListScopeMarker(scopeKey: string, guildId: string): string | null {
  if (scopeKey === buildDeferScopeKey(guildId, null)) return "scope guild";
  const prefix = `guild:${guildId}|clan:`;
  if (scopeKey.startsWith(prefix)) return "scope clan";
  return null;
}

const DEFER_CONFIG_RESET_CHANNEL_BUTTON_PREFIX = "defer-config:reset-channel";
const DEFER_CONFIG_SUPPORTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

type GuildChannelLike = {
  id: string;
  guildId?: string;
  type?: number;
  isThread?: () => boolean;
  parentId?: string | null;
  parent?: {
    id?: string | null;
  } | null;
};

type GuildRoleLike = {
  id: string;
  guildId?: string;
  guild?: {
    id?: string | null;
  } | null;
};

function isGuildScopedChannel(channel: GuildChannelLike, guildId: string): boolean {
  return String(channel.guildId ?? "").trim() === guildId;
}

function isSupportedDeferConfigChannel(channel: GuildChannelLike): boolean {
  if (typeof channel.type !== "number") return false;
  return DEFER_CONFIG_SUPPORTED_CHANNEL_TYPES.includes(
    channel.type as (typeof DEFER_CONFIG_SUPPORTED_CHANNEL_TYPES)[number],
  );
}

function isGuildScopedRole(role: GuildRoleLike, guildId: string): boolean {
  return String(role.guildId ?? role.guild?.id ?? "").trim() === guildId;
}

function deferConfigResetChannelCustomId(input: {
  guildId: string;
  userId: string;
}): string {
  return `${DEFER_CONFIG_RESET_CHANNEL_BUTTON_PREFIX}:${input.guildId}:${input.userId}`;
}

function parseDeferConfigResetChannelCustomId(
  customId: string,
): { guildId: string; userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== "defer-config" || parts[1] !== "reset-channel") return null;
  const guildId = parts[2]?.trim() ?? "";
  const userId = parts[3]?.trim() ?? "";
  if (!guildId || !userId) return null;
  return { guildId, userId };
}

function formatDeferRoutingYesNo(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function buildDeferConfigSummaryEmbed(input: {
  config: Awaited<ReturnType<typeof getDeferRoutingConfig>>;
}): EmbedBuilder {
  const effectiveChannel = input.config.channelOverrideId
    ? `<#${input.config.channelOverrideId}>`
    : "default tracked clan log channel";
  const effectivePingRole = input.config.enablePing
    ? input.config.pingRoleOverrideId
      ? `<@&${input.config.pingRoleOverrideId}>`
      : input.config.defaultPingRoleId
        ? `<@&${input.config.defaultPingRoleId}>`
        : "none configured"
    : "disabled";
  const storedChannelOverride = input.config.channelOverrideId
    ? `<#${input.config.channelOverrideId}>`
    : "default";
  const storedPingRoleOverride = input.config.pingRoleOverrideId
    ? `<@&${input.config.pingRoleOverrideId}>`
    : "default";
  const storedEnablePingOverride =
    input.config.enablePingOverride === null
      ? "default"
      : String(input.config.enablePingOverride);
  const storedEnabledOverride =
    input.config.enabledOverride === null
      ? "default"
      : String(input.config.enabledOverride);

  return new EmbedBuilder()
    .setTitle("Defer Routing Config")
    .setDescription(
      "Effective routing uses stored overrides when present, otherwise the current tracked clan log channel and configured FWA Leader role.",
    )
    .addFields(
      {
        name: "Effective",
        value: [
          `Delivery: ${formatDeferRoutingYesNo(input.config.enabled)}`,
          `Channel: ${effectiveChannel}`,
          `Ping: ${formatDeferRoutingYesNo(input.config.enablePing)}`,
          `Ping role: ${effectivePingRole}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Stored Overrides",
        value: [
          `Channel override: ${storedChannelOverride}`,
          `Ping role override: ${storedPingRoleOverride}`,
          `enable_ping override: ${storedEnablePingOverride}`,
          `enable override: ${storedEnabledOverride}`,
        ].join("\n"),
        inline: false,
      },
    );
}

function buildDeferConfigSummaryComponents(input: {
  guildId: string;
  userId: string;
  config: Awaited<ReturnType<typeof getDeferRoutingConfig>>;
}): APIActionRowComponent<any>[] {
  if (!input.config.channelOverrideId) return [];
  const button = new ButtonBuilder()
    .setCustomId(
      deferConfigResetChannelCustomId({
        guildId: input.guildId,
        userId: input.userId,
      }),
    )
    .setLabel("Reset channel override")
    .setStyle(ButtonStyle.Secondary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON()];
}

async function renderDeferConfigSummary(input: {
  guildId: string;
  userId: string;
  pingRole: GuildRoleLike | null;
  channel: GuildChannelLike | null;
  enablePing: boolean | null;
  enabled: boolean | null;
}): Promise<{
  embeds: EmbedBuilder[];
  components: APIActionRowComponent<any>[];
}> {
  await updateDeferRoutingConfig(input.guildId, {
    channelOverrideId: input.channel?.id ?? undefined,
    pingRoleOverrideId: input.pingRole?.id ?? undefined,
    enablePing: input.enablePing,
    enabled: input.enabled,
  });
  const config = await getDeferRoutingConfig(input.guildId);
  return {
    embeds: [buildDeferConfigSummaryEmbed({ config })],
    components: buildDeferConfigSummaryComponents({
      guildId: input.guildId,
      userId: input.userId,
      config,
    }),
  };
}

export const Defer: Command = {
  name: "defer",
  description: "Manage deferred FWA weight-input tasks for prospective members",
  options: [
    {
      name: "add",
      description: "Add one deferred weight-input task",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "weight",
          description: "Deferred war weight (e.g. 145000, 145,000, 145k)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List open deferred weight-input tasks",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked clan to scope the list by current membership",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "config",
      description: "Configure defer reminder routing and ping behavior",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Custom channel for defer reminders and logs",
          type: ApplicationCommandOptionType.Channel,
          required: false,
          channel_types: [...DEFER_CONFIG_SUPPORTED_CHANNEL_TYPES],
        },
        {
          name: "ping_role",
          description: "Override role to ping for defer reminders",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "enable_ping",
          description: "Enable or disable role pinging",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
        {
          name: "enable",
          description: "Enable or disable defer reminder delivery",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Resolve one deferred task after weight is entered in FWAStats",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "check",
      description: "Check open deferred tasks against current FWAStats clan weights",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked clan to check current membership against FWAStats weights",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "clear",
      description: "Clear all open deferred tasks in the active scope",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }
    const channelId = interaction.channelId ?? null;
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "add") {
      const playerInput = interaction.options.getString("player-tag", true);
      const weightInput = interaction.options.getString("weight", true);
      const playerTag = parseRequiredPlayerTag(playerInput);
      if (!playerTag) {
        await interaction.editReply(
          "not_found: invalid player tag. Use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      const deferredWeight = parseDeferWeightInput(weightInput);
      if (!deferredWeight) {
        await interaction.editReply(
          "not_found: invalid weight. Use `145000`, `145,000`, or `145k`."
        );
        return;
      }
      try {
        const result = await addWeightInputDefermentWithPlayerProfile({
          guildId,
          channelId,
          playerTag,
          deferredWeight,
          cocService,
        });
        switch (result.outcome) {
          case "player_profile_not_found":
            await interaction.editReply(
              `not_found: player profile for ${playerTag} could not be resolved.`
            );
            return;
          case "player_profile_lookup_failed":
            await interaction.editReply(
              `failed: player profile lookup failed for ${playerTag}. Check bot logs.`
            );
            return;
          case "player_current_upsert_failed":
          case "deferment_write_failed":
            await interaction.editReply(
              `failed: unable to save deferment for ${playerTag}. Check bot logs.`
            );
            return;
          case "created":
            await interaction.editReply(
              `created: ${playerTag} queued at ${deferredWeight} in ${renderScopeLabel(result.record)}.`
            );
            return;
          case "updated":
            await interaction.editReply(
              `updated: ${playerTag} queued at ${deferredWeight} in ${renderScopeLabel(result.record)}.`
            );
            return;
        }
      } catch (error) {
        console.error(
          `[defer] command=/defer add stage=run guild=${guildId} channel=${channelId ?? "none"} player=${playerTag} deferredWeight=${deferredWeight} error=${formatError(error)}`,
        );
        await interaction.editReply(
          `failed: unexpected deferment error for ${playerTag}. Check bot logs.`
        );
        return;
      }
    }

    if (subcommand === "list") {
      const requestedClan = interaction.options.getString("clan", false);
      let resolvedClanTag: string | null = null;
      if (requestedClan) {
        const normalizedClanTag = normalizeTag(requestedClan);
        if (!normalizedClanTag) {
          await interaction.editReply("invalid_clan: use a tracked clan tag with or without #.");
          return;
        }
        const trackedClan = await prisma.trackedClan.findFirst({
          where: {
            OR: [
              { tag: { equals: normalizedClanTag, mode: "insensitive" } },
              { tag: { equals: normalizedClanTag.replace(/^#/, ""), mode: "insensitive" } },
            ],
          },
          select: { tag: true },
        });
        if (!trackedClan) {
          await interaction.editReply(`Clan ${normalizedClanTag} is not in tracked clans.`);
          return;
        }
        resolvedClanTag = normalizeTag(trackedClan.tag);
      }

      const listed = await listOpenWeightInputDeferments({
        guildId,
        channelId,
        clanTag: resolvedClanTag,
      });
      if (listed.rows.length === 0) {
        await interaction.editReply(
          resolvedClanTag
            ? `empty_list: no open deferments in ${resolvedClanTag}.`
            : `empty_list: no open deferments in ${renderScopeLabel(listed.scope)}.`
        );
        return;
      }
      const lines = listed.rows.map((row) => {
        const age = formatPendingAge(row.createdAt);
        if (resolvedClanTag) {
          const scopeMarker = renderDeferListScopeMarker(row.scopeKey, guildId);
          const scopeSuffix = scopeMarker ? ` | ${scopeMarker}` : "";
          return `- ${row.playerTag} | weight ${row.deferredWeight} | age ${age}${scopeSuffix}`;
        }
        return `- ${row.playerTag} | weight ${row.deferredWeight} | age ${age}`;
      });
      await interaction.editReply(
        [
          `open_deferments: ${listed.rows.length} in ${resolvedClanTag ?? renderScopeLabel(listed.scope)}`,
          ...lines,
        ].join("\n")
      );
      return;
    }

    if (subcommand === "config") {
      const requestedChannel = interaction.options.getChannel(
        "channel",
        false,
      ) as GuildChannelLike | null;
      const requestedRole = interaction.options.getRole(
        "ping_role",
        false,
      ) as GuildRoleLike | null;
      const enablePing = interaction.options.getBoolean("enable_ping", false);
      const enabled = interaction.options.getBoolean("enable", false);

      if (requestedChannel) {
        if (!isGuildScopedChannel(requestedChannel, guildId)) {
          await interaction.editReply("Selected channel must belong to this server.");
          return;
        }
        if (!isSupportedDeferConfigChannel(requestedChannel)) {
          await interaction.editReply(
            "Selected channel must be a server text, announcement, or thread channel.",
          );
          return;
        }
      }

      if (requestedRole && !isGuildScopedRole(requestedRole, guildId)) {
        await interaction.editReply("Selected role must belong to this server.");
        return;
      }

      const summary = await renderDeferConfigSummary({
        guildId,
        userId: interaction.user.id,
        channel: requestedChannel,
        pingRole: requestedRole,
        enablePing,
        enabled,
      });
      await interaction.editReply({
        embeds: summary.embeds,
        components: summary.components as any,
      });
      return;
    }

    if (subcommand === "remove") {
      const playerInput = interaction.options.getString("player-tag", true);
      const playerTag = parseRequiredPlayerTag(playerInput);
      if (!playerTag) {
        await interaction.editReply(
          "not_found: invalid player tag. Use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      const result = await removeOpenWeightInputDeferment({
        guildId,
        channelId,
        playerTag,
      });
      if (!result.removed) {
        await interaction.editReply(
          `not_found: no open deferment for ${playerTag} in ${renderScopeLabel(result.scope)}.`
        );
        return;
      }
      await interaction.editReply(
        `removed: ${playerTag} resolved in ${renderScopeLabel(result.scope)}.`
      );
      return;
    }

    if (subcommand === "check") {
      const requestedClan = interaction.options.getString("clan", true);
      const normalizedClanTag = normalizeTag(requestedClan);
      if (!normalizedClanTag) {
        await interaction.editReply("invalid_clan: use a tracked clan tag with or without #.");
        return;
      }
      const trackedClan = await prisma.trackedClan.findFirst({
        where: {
          OR: [
            { tag: { equals: normalizedClanTag, mode: "insensitive" } },
            { tag: { equals: normalizedClanTag.replace(/^#/, ""), mode: "insensitive" } },
          ],
        },
        select: { tag: true },
      });
      if (!trackedClan) {
        await interaction.editReply(`Clan ${normalizedClanTag} is not in tracked clans.`);
        return;
      }
      const resolvedClanTag = normalizeTag(trackedClan.tag);
      const result = await checkOpenWeightInputDefermentsForClan({
        guildId,
        clanTag: resolvedClanTag,
      });
      await interaction.editReply(
        [
          `checked_deferments: ${result.checkedCount} in ${resolvedClanTag}`,
          `resolved_deferments: ${result.resolvedCount}`,
          `still_open_missing_weight: ${result.stillOpenMissingWeightCount}`,
        ].join("\n"),
      );
      return;
    }

    const cleared = await clearOpenWeightInputDeferments({ guildId, channelId });
    await interaction.editReply(
      `cleared_count: ${cleared.clearedCount} in ${renderScopeLabel(cleared.scope)}.`
    );
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const choices = tracked
      .map((clan) => {
        const tag = normalizeTag(clan.tag);
        if (!tag) return null;
        const label = clan.name?.trim() ? `${clan.name.trim()} (${tag})` : tag;
        return {
          name: label.slice(0, 100),
          value: tag,
        };
      })
      .filter(
        (choice): choice is { name: string; value: string } =>
          choice !== null &&
          (choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)),
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};

/** Purpose: detect defer config reset-channel buttons. */
export function isDeferConfigResetChannelButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${DEFER_CONFIG_RESET_CHANNEL_BUTTON_PREFIX}:`);
}

/** Purpose: clear one defer config channel override from the reset button. */
export async function handleDeferConfigResetChannelButtonInteraction(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseDeferConfigResetChannelCustomId(interaction.customId);
  if (!parsed) return;

  if (!interaction.inGuild() || interaction.guildId !== parsed.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This defer config button no longer applies to this server.",
    });
    return;
  }

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  await clearDeferRoutingChannelOverride(parsed.guildId);
  const config = await getDeferRoutingConfig(parsed.guildId);
  await interaction.update({
    embeds: [buildDeferConfigSummaryEmbed({ config })],
    components: buildDeferConfigSummaryComponents({
      guildId: parsed.guildId,
      userId: parsed.userId,
      config,
    }),
  });
}
