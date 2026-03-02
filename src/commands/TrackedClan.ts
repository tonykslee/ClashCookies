import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { ActivityService } from "../services/ActivityService";
import { CoCService } from "../services/CoCService";

function normalizeClanTag(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/^#/, "");
  return `#${cleaned}`;
}

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/;
const SHORTCODE_EMOJI_PATTERN = /^:([A-Za-z0-9_]+):$/;

function normalizeClanShortNameInput(input: string): string | null {
  const normalized = input.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

async function normalizeClanBadgeInput(
  interaction: ChatInputCommandInteraction,
  input: string
): Promise<string | null> {
  const value = input.trim();
  if (!value) return null;

  const customMatch = value.match(CUSTOM_EMOJI_PATTERN);
  if (customMatch) {
    const animated = customMatch[1] === "a";
    const name = customMatch[2];
    const id = customMatch[3];
    return `<${animated ? "a" : ""}:${name}:${id}>`;
  }

  const shortcodeMatch = value.match(SHORTCODE_EMOJI_PATTERN);
  if (shortcodeMatch) {
    const guild = interaction.guild;
    if (!guild) {
      throw new Error("CLAN_BADGE_GUILD_REQUIRED");
    }

    const shortcodeName = shortcodeMatch[1];
    let emoji = guild.emojis.cache.find((e) => e.name === shortcodeName);
    if (!emoji) {
      await guild.emojis.fetch();
      emoji = guild.emojis.cache.find((e) => e.name === shortcodeName);
    }
    if (!emoji) {
      throw new Error("CLAN_BADGE_SHORTCODE_NOT_FOUND");
    }

    return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
  }

  return value;
}

export const TrackedClan: Command = {
  name: "tracked-clan",
  description: "Configure, remove, or list tracked clans",
  options: [
    {
      name: "configure",
      description: "Add or update a tracked clan configuration",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag (example: #2QG2C08UP)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "lose-style",
          description: "FWA lose-war plan style for this clan",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Triple-top-30", value: "TRIPLE_TOP_30" },
            { name: "Traditional", value: "TRADITIONAL" },
          ],
        },
        {
          name: "mail-channel",
          description: "Discord channel to receive tracked clan war mail",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "log-channel",
          description: "Discord channel for tracked clan logs",
          type: ApplicationCommandOptionType.Channel,
          required: false,
        },
        {
          name: "clan-role",
          description: "Discord role associated with this tracked clan",
          type: ApplicationCommandOptionType.Role,
          required: false,
        },
        {
          name: "clan-badge",
          description: "Emoji badge for this tracked clan",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "short-name",
          description: "Short name/abbreviation for this tracked clan",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a clan from tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Clan tag to remove",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "list",
      description: "List tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    try {
      await interaction.deferReply({ ephemeral: true });
      const subcommand = interaction.options.getSubcommand(true);

      if (subcommand === "list") {
        const tracked = await prisma.trackedClan.findMany({
          orderBy: { createdAt: "asc" },
        });

        if (tracked.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "No tracked clans in the database. You can still set TRACKED_CLANS in .env as fallback.",
          });
          return;
        }

        const lines = tracked.map((clan) => {
          const label = clan.name ? `${clan.tag} (${clan.name})` : clan.tag;
          const mailChannel = clan.mailChannelId ? `<#${clan.mailChannelId}>` : "not set";
          const logChannel = clan.logChannelId ? `<#${clan.logChannelId}>` : "not set";
          const clanRole = clan.clanRoleId ? `<@&${clan.clanRoleId}>` : "not set";
          const clanBadge = clan.clanBadge ?? "not set";
          const shortName = clan.shortName ?? "not set";
          return `- ${label} | shortName: ${shortName} | lose-style: ${clan.loseStyle} | mailChannel: ${mailChannel} | logChannel: ${logChannel} | clanRole: ${clanRole} | clanBadge: ${clanBadge}`;
        });
        await safeReply(interaction, {
          ephemeral: true,
          content: `Tracked clans (${tracked.length}):\n${lines.join("\n")}`,
        });
        return;
      }

      const tagInput = interaction.options.getString("tag", true);
      const tag = normalizeClanTag(tagInput);

      if (subcommand === "configure") {
        const loseStyle = interaction.options.getString("lose-style", false) as
          | "TRIPLE_TOP_30"
          | "TRADITIONAL"
          | null;
        const mailChannel = interaction.options.getChannel("mail-channel", false);
        const logChannel = interaction.options.getChannel("log-channel", false);
        const clanRole = interaction.options.getRole("clan-role", false);
        const clanBadgeInput = interaction.options.getString("clan-badge", false);
        const shortNameInput = interaction.options.getString("short-name", false);
        let clanBadge: string | null = null;
        const shortName = shortNameInput ? normalizeClanShortNameInput(shortNameInput) : null;
        if (mailChannel && (!("isTextBased" in mailChannel) || !(mailChannel as any).isTextBased())) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Mail channel must be a text-based channel.",
          });
          return;
        }
        if (logChannel && (!("isTextBased" in logChannel) || !(logChannel as any).isTextBased())) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Log channel must be a text-based channel.",
          });
          return;
        }
        if (clanRole && !("id" in clanRole)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid clan role selected.",
          });
          return;
        }
        if (clanBadgeInput) {
          try {
            clanBadge = await normalizeClanBadgeInput(interaction, clanBadgeInput);
          } catch (badgeErr) {
            const badgeCode = formatError(badgeErr);
            const badgeHint =
              badgeCode === "CLAN_BADGE_GUILD_REQUIRED"
                ? "Custom clan-badge shortcodes can only be resolved in a server."
                : badgeCode === "CLAN_BADGE_SHORTCODE_NOT_FOUND"
                  ? "Could not find that emoji in this server. Use an existing server emoji, unicode emoji, or full custom emoji format like `<:Logo_Gabbar:123456789012345678>`."
                  : "Invalid clan-badge value. Use unicode emoji, `:emoji_name:` from this server, or full custom emoji format.";
            await safeReply(interaction, {
              ephemeral: true,
              content: badgeHint,
            });
            return;
          }
        }
        const existing = await prisma.trackedClan.findUnique({
          where: { tag },
        });
        const clan = await cocService.getClan(tag);
        const activityService = new ActivityService(cocService);
        const createLoseStyle = loseStyle ?? "TRIPLE_TOP_30";
        const saved = await prisma.trackedClan.upsert({
          where: { tag },
          create: {
            tag,
            name: clan.name ?? null,
            loseStyle: createLoseStyle,
            mailChannelId: mailChannel?.id ?? null,
            logChannelId: logChannel?.id ?? null,
            clanRoleId: clanRole?.id ?? null,
            clanBadge,
            shortName,
          },
          update: {
            name: clan.name ?? null,
            ...(loseStyle ? { loseStyle } : {}),
            ...(mailChannel ? { mailChannelId: mailChannel.id } : {}),
            ...(logChannel ? { logChannelId: logChannel.id } : {}),
            ...(clanRole ? { clanRoleId: clanRole.id } : {}),
            ...(clanBadge ? { clanBadge } : {}),
            ...(shortName ? { shortName } : {}),
          },
        });

        if (!existing) {
          try {
            await activityService.observeClan(tag);
          } catch (observeErr) {
            console.error(
              `tracked-clan configure observe failed for ${tag}: ${formatError(observeErr)}`
            );
          }
        }

        const summary = [
          `lose-style: ${saved.loseStyle}`,
          `mailChannel: ${saved.mailChannelId ? `<#${saved.mailChannelId}>` : "not set"}`,
          `logChannel: ${saved.logChannelId ? `<#${saved.logChannelId}>` : "not set"}`,
          `clanRole: ${saved.clanRoleId ? `<@&${saved.clanRoleId}>` : "not set"}`,
          `clanBadge: ${saved.clanBadge ?? "not set"}`,
          `shortName: ${saved.shortName ?? "not set"}`,
        ].join(" | ");

        await safeReply(interaction, {
          ephemeral: true,
          content: existing
            ? `Updated tracked clan ${saved.name ?? "Unknown Clan"} (${saved.tag}) | ${summary}`
            : `Now tracking ${saved.name ?? "Unknown Clan"} (${saved.tag}) | ${summary}`,
        });
        return;
      }

      if (subcommand === "remove") {
        const deleted = await prisma.trackedClan.deleteMany({
          where: { tag },
        });

        if (deleted.count === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: `${tag} is not currently tracked.`,
          });
          return;
        }

        await safeReply(interaction, {
          ephemeral: true,
          content: `Removed tracked clan ${tag}.`,
        });
      }
    } catch (err) {
      console.error(`tracked-clan command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: "Failed to update tracked clans. Check the clan tag and try again.",
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });
    const choices = tracked
      .map((clan) => {
        const tag = normalizeClanTag(clan.tag);
        const label = clan.name?.trim() ? `${clan.name.trim()} (${tag})` : tag;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
