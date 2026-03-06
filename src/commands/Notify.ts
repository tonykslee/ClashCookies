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
  Role,
} from "discord.js";
import { randomUUID } from "crypto";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { WarEventLogService } from "../services/WarEventLogService";

function normalizeClanTag(input: string): string {
  const raw = input.trim().toUpperCase().replace(/^#/, "");
  return raw ? `#${raw}` : "";
}

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

const NOTIFY_WAR_PREVIEW_POST_PREFIX = "notify-war-preview-post";
const notifyWarPreviewRequests = new Map<
  string,
  {
    userId: string;
    guildId: string;
    clanTag: string;
    eventType: "war_started" | "battle_day" | "war_ended";
    source: "current" | "last";
    channelId: string;
    clanName: string;
    createdAt: number;
  }
>();

function buildNotifyWarPreviewPostCustomId(key: string): string {
  return `${NOTIFY_WAR_PREVIEW_POST_PREFIX}:${key}`;
}

function parseNotifyWarPreviewPostCustomId(
  customId: string
): { key: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== NOTIFY_WAR_PREVIEW_POST_PREFIX) return null;
  const key = parts[1]?.trim() ?? "";
  if (!key) return null;
  return { key };
}

export function isNotifyWarPreviewPostButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_PREVIEW_POST_PREFIX}:`);
}

export async function handleNotifyWarPreviewPostButton(
  interaction: ButtonInteraction,
  cocService: CoCService
): Promise<void> {
  const parsed = parseNotifyWarPreviewPostCustomId(interaction.customId);
  if (!parsed) return;

  const request = notifyWarPreviewRequests.get(parsed.key);
  if (!request) {
    await interaction.reply({
      ephemeral: true,
      content: "This preview has expired. Run `/notify preview` again.",
    });
    return;
  }
  if (request.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the user who generated this preview can confirm posting.",
    });
    return;
  }
  if (request.guildId !== interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This preview is from a different server.",
    });
    return;
  }
  if (Date.now() - request.createdAt > 30 * 60 * 1000) {
    notifyWarPreviewRequests.delete(parsed.key);
    await interaction.reply({
      ephemeral: true,
      content: "This preview has expired. Run `/notify preview` again.",
    });
    return;
  }

  await interaction.deferUpdate();
  const warEventService = new WarEventLogService(interaction.client, cocService);
  const result = await warEventService.emitTestEventForClan({
    guildId: request.guildId,
    clanTag: request.clanTag,
    eventType: request.eventType,
    source: request.source,
  });
  if (!result.ok) {
    await interaction.followUp({
      ephemeral: true,
      content:
      `Failed to post preview publicly for ${request.clanName} (${request.clanTag}): ${result.reason ?? "unknown reason"}`
    });
    return;
  }

  notifyWarPreviewRequests.delete(parsed.key);
  await interaction.deleteReply().catch(async () => {
    await interaction.editReply({
      content: "Preview cleared.",
      embeds: [],
      components: [],
    });
  });
  await interaction.followUp({
    ephemeral: true,
    content: `Posted ${request.eventType} for **${request.clanName}** (${request.clanTag}) to <#${request.channelId}>.`,
  });
}

export const Notify: Command = {
  name: "notify",
  description: "Configure notification features",
  options: [
    {
      name: "set",
      description: "Creates or updates notification routing",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Clan tag (tracked or non-tracked)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "channel",
          description: "Channel to post war event logs",
          type: ApplicationCommandOptionType.Channel,
          required: true,
        },
        {
          name: "role",
          description: "Optional role to ping when war events are posted",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "ping",
          description: "Whether to ping the configured role (default: true)",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "toggle",
      description: "Toggle embed or ping on/off for an existing notification",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Clan tag already configured with /notify set",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "target",
          description: "What setting to toggle",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "embed", value: "embed" },
            { name: "ping", value: "ping" },
          ],
        },
        {
          name: "state",
          description: "Enable or disable the selected target",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ],
        },
      ],
    },
    {
      name: "preview",
      description: "Preview a war event embed, then confirm posting publicly",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Clan tag (must already be configured with /notify set)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "event",
          description: "Event embed type to test",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "prep day start", value: "war_started" },
            { name: "battle day start", value: "battle_day" },
            { name: "war end", value: "war_ended" },
          ],
        },
        {
          name: "source",
          description: "Data source for test content",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "current war", value: "current" },
            { name: "last war", value: "last" },
          ],
        },
      ],
    },
    {
      name: "show",
      description: "Show war notify routing for tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Optional clan tag to show a single clan config",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    if (sub === "show") {
      const rawTag = interaction.options.getString("clan", false);
      const normalizedFilter = rawTag ? normalizeClanTag(rawTag) : "";

      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });
      const configs = await prisma.clanNotifyConfig.findMany({
        where: normalizedFilter ? { clanTag: normalizedFilter, guildId: interaction.guildId } : { guildId: interaction.guildId },
        orderBy: { updatedAt: "asc" },
      });

      const configByTag = new Map(
        configs.map((c) => [normalizeClanTag(c.clanTag), c])
      );

      const rows = tracked
        .map((clan) => {
          const clanTag = normalizeClanTag(clan.tag);
          const config = configByTag.get(clanTag);
          return {
            clanName: clan.name?.trim() || clanTag,
            clanTag,
            channelId: config?.channelId ?? null,
            roleId: config?.roleId ?? null,
            embedEnabled: config?.embedEnabled ?? false,
            pingEnabled: config?.pingEnabled ?? true,
          };
        })
        .filter((r) => (normalizedFilter ? r.clanTag === normalizedFilter : true));

      if (rows.length === 0) {
        await interaction.editReply(
          normalizedFilter
            ? `No tracked clan found for ${normalizedFilter}.`
            : "No tracked clans configured."
        );
        return;
      }

      const lines = rows.map((r) => {
        const channelText = r.channelId ? `<#${r.channelId}>` : "not configured";
        const roleText = r.roleId ? `<@&${r.roleId}>` : "none";
        const embedStatus = r.embedEnabled ? "enabled" : "disabled";
        const pingStatus = r.pingEnabled ? "enabled" : "disabled";
        return `- **${r.clanName}** (${r.clanTag})\n  Channel: ${channelText}\n  Role: ${roleText}\n  Embed: ${embedStatus}\n  Ping: ${pingStatus}`;
      });

      await interaction.editReply(lines.join("\n"));
      return;
    }

    if (sub === "toggle") {
      const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
      const target = interaction.options.getString("target", true);
      const state = interaction.options.getString("state", true);
      const enabled = state === "on";
      if (target !== "embed" && target !== "ping") {
        await interaction.editReply("Invalid target. Use `embed` or `ping`.");
        return;
      }
      const updated =
        target === "embed"
          ? await prisma.clanNotifyConfig.updateMany({
              where: {
                guildId: interaction.guildId,
                clanTag: normalizeClanTagInput(clanTag),
              },
              data: { embedEnabled: enabled, updatedAt: new Date() },
            })
          : await prisma.clanNotifyConfig.updateMany({
              where: {
                guildId: interaction.guildId,
                clanTag: normalizeClanTagInput(clanTag),
              },
              data: { pingEnabled: enabled, updatedAt: new Date() },
            });
      if (updated.count === 0) {
        await interaction.editReply(`No /notify set configuration found for ${clanTag}.`);
        return;
      }

      const targetLabel = target === "embed" ? "Embed" : "Ping";
      await interaction.editReply(`${targetLabel} is now **${enabled ? "on" : "off"}** for ${clanTag}.`);
      return;
    }

    if (sub === "preview") {
      const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
      const eventType = interaction.options.getString("event", true) as
        | "war_started"
        | "battle_day"
        | "war_ended";
      const source = (interaction.options.getString("source", false) ?? "current") as
        | "current"
        | "last";

      // Check if clan is configured
      const config = await prisma.clanNotifyConfig.findUnique({
        where: {
          guildId_clanTag: {
            guildId: interaction.guildId,
            clanTag: normalizeClanTagInput(clanTag),
          },
        },
      });
      if (!config) {
        await interaction.editReply(`No notification configuration found for ${clanTag}. Use /notify set first.`);
        return;
      }

      const warEventService = new WarEventLogService(_client, cocService);
      const result = await warEventService.buildTestEventPreviewForClan({
        guildId: interaction.guildId,
        clanTag,
        eventType,
        source,
      });

      if (!result.ok) {
        await interaction.editReply(`Failed to build preview: ${result.reason ?? "unknown reason"}`);
        return;
      }
      if (!result.channelId || !result.clanName || !result.embeds || result.embeds.length === 0) {
        await interaction.editReply("Failed to build preview: incomplete preview payload.");
        return;
      }

      const previewKey = randomUUID();
      notifyWarPreviewRequests.set(previewKey, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        clanTag,
        eventType,
        source,
        channelId: result.channelId,
        clanName: result.clanName,
        createdAt: Date.now(),
      });

      await interaction.editReply({
        content:
          `Preview ready for **${result.clanName}** (${clanTag}).\n` +
          `Target channel: <#${result.channelId}>.\n` +
          "Click **Confirm Post** to publish this embed publicly.",
        embeds: result.embeds ?? [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildNotifyWarPreviewPostCustomId(previewKey))
              .setLabel("Confirm Post")
              .setStyle(ButtonStyle.Success)
          ),
        ],
      });
      return;
    }

    if (sub !== "set") {
      await interaction.editReply("Unknown notify option.");
      return;
    }

    const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
    if (!clanTag) {
      await interaction.editReply("Invalid clan tag.");
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    const role = interaction.options.getRole("role", false) as Role | null;
    const pingEnabled = interaction.options.getBoolean("ping", false) ?? true;

    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      await interaction.editReply("Target channel must be a server text or announcement channel.");
      return;
    }

    await prisma.clanNotifyConfig.upsert({
      where: {
        guildId_clanTag: {
          guildId: interaction.guildId,
          clanTag: normalizeClanTagInput(clanTag),
        },
      },
      create: {
        guildId: interaction.guildId,
        clanTag: normalizeClanTagInput(clanTag),
        channelId: channel.id,
        roleId: role?.id ?? null,
        pingEnabled,
        embedEnabled: true,
      },
      update: {
        channelId: channel.id,
        roleId: role?.id ?? null,
        pingEnabled,
        embedEnabled: true,
        updatedAt: new Date(),
      },
    });

    await interaction.editReply(
      `Notification routing set for ${clanTag} in <#${channel.id}>.\n` +
        `Role: ${role ? `<@&${role.id}>` : "none"}\n` +
        `Ping: ${pingEnabled ? "enabled" : "disabled"}`
    );
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = normalizeClanTagInput(String(focused.value ?? "")).toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((clan) => {
        const normalizedTag = normalizeClanTagInput(clan.tag);
        const label = clan.name?.trim()
          ? `${clan.name.trim()} (#${normalizedTag})`
          : `#${normalizedTag}`;
        return {
          name: label.slice(0, 100),
          value: normalizedTag,
        };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) ||
          choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
