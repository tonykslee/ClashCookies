import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";

const DEFAULT_DAYS = 3;
const MAX_LINES_PER_PAGE = 18;

type KickRecord = {
  playerTag: string;
  playerName: string;
  clanName: string;
  reasons: string[];
};

function normalizePlayerTag(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function buildPaginationRow(prefix: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

async function getLinkReason(
  guild: ChatInputCommandInteraction["guild"],
  playerTag: string,
  linksByTag: Map<string, { discordUserId: string }>
): Promise<string | null> {
  const link = linksByTag.get(playerTag);
  if (!link) {
    return "Tag not linked to a Discord profile";
  }
  if (!guild) {
    return "Linked Discord profile cannot be validated outside a guild";
  }

  try {
    await guild.members.fetch(link.discordUserId);
    return null;
  } catch {
    return "Linked Discord profile is not in this server";
  }
}

function mapReasons(record: {
  reason: string;
  source: "AUTO_INACTIVE" | "MANUAL";
  daysThreshold: number | null;
}): string {
  if (record.source === "AUTO_INACTIVE") {
    const days = record.daysThreshold ?? DEFAULT_DAYS;
    if (record.reason.includes("+")) {
      const detail = record.reason.split("+").slice(1).join("+").trim();
      return `Inactive for ${days}+ day(s) | ${detail}`;
    }
    return `Inactive for ${days}+ day(s)`;
  }
  return record.reason || "Manual";
}

function buildPages(records: KickRecord[]): string[] {
  const lines = records.map((r) => {
    const reasonText = r.reasons.join(" | ");
    return `- **${r.playerName}** (${r.playerTag}) • ${r.clanName}\n  Reason: ${reasonText}`;
  });

  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + MAX_LINES_PER_PAGE).join("\n"));
  }
  return pages;
}

export const KickList: Command = {
  name: "kick-list",
  description: "Build and manage kick-list candidates",
  options: [
    {
      name: "build",
      description: "Auto-build from inactive players in tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "days",
          description: "Inactive days threshold (default 3)",
          type: ApplicationCommandOptionType.Integer,
          required: false,
        },
      ],
    },
    {
      name: "add",
      description: "Manually add a player to the kick list",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "reason",
          description: "Reason for kick list",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a player from the kick list",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "show",
      description: "Show the current kick list",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "clear",
      description: "Clear kick-list entries",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Which entries to clear",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "all", value: "all" },
            { name: "auto", value: "auto" },
            { name: "manual", value: "manual" },
          ],
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
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "build") {
      const days = interaction.options.getInteger("days", false) ?? DEFAULT_DAYS;
      if (days <= 0) {
        await interaction.editReply("`days` must be greater than 0.");
        return;
      }

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { tag: true, name: true },
      });

      if (tracked.length === 0) {
        await interaction.editReply(
          "No tracked clans configured. Add at least one tracked clan first."
        );
        return;
      }

      const clanByMemberTag = new Map<string, { clanTag: string; clanName: string; playerName: string }>();
      for (const tc of tracked) {
        try {
          const clan = await cocService.getClan(tc.tag);
          const clanName = String(tc.name ?? clan.name ?? tc.tag).trim() || tc.tag;
          for (const member of clan.members ?? []) {
            const tag = normalizePlayerTag(String(member?.tag ?? ""));
            if (!tag) continue;
            clanByMemberTag.set(tag, {
              clanTag: String(clan.tag ?? tc.tag),
              clanName,
              playerName: String(member?.name ?? "Unknown"),
            });
          }
        } catch (err) {
          console.error(`kick-list build: failed clan ${tc.tag}: ${formatError(err)}`);
        }
      }

      const memberTags = [...clanByMemberTag.keys()];
      if (memberTags.length === 0) {
        await interaction.editReply("Tracked clans have no readable live members right now.");
        return;
      }

      const [activities, links] = await Promise.all([
        prisma.playerActivity.findMany({
          where: {
            tag: { in: memberTags },
            lastSeenAt: { lt: cutoff },
          },
          select: { tag: true, lastSeenAt: true },
        }),
        prisma.playerLink.findMany({
          where: { playerTag: { in: memberTags } },
          select: { playerTag: true, discordUserId: true },
        }),
      ]);

      const linksByTag = new Map(
        links.map((l) => [normalizePlayerTag(l.playerTag), { discordUserId: l.discordUserId }])
      );

      await prisma.kickListEntry.deleteMany({
        where: {
          guildId,
          source: "AUTO_INACTIVE",
        },
      });

      let created = 0;
      for (const activity of activities) {
        const tag = normalizePlayerTag(activity.tag);
        const clan = clanByMemberTag.get(tag);
        const linkReason = await getLinkReason(interaction.guild, tag, linksByTag);
        const reason = linkReason ? `inactive + ${linkReason}` : "inactive";

        await prisma.kickListEntry.upsert({
          where: {
            guildId_playerTag_source: {
              guildId,
              playerTag: tag,
              source: "AUTO_INACTIVE",
            },
          },
          update: {
            playerName: clan?.playerName ?? null,
            clanTag: clan?.clanTag ?? null,
            clanName: clan?.clanName ?? null,
            reason,
            daysThreshold: days,
          },
          create: {
            guildId,
            playerTag: tag,
            playerName: clan?.playerName ?? null,
            clanTag: clan?.clanTag ?? null,
            clanName: clan?.clanName ?? null,
            reason,
            source: "AUTO_INACTIVE",
            daysThreshold: days,
          },
        });
        created += 1;
      }

      await interaction.editReply(
        `Kick list auto-build complete: ${created} inactive player(s) added/updated at ${days}+ day(s).`
      );
      return;
    }

    if (subcommand === "add") {
      const tag = normalizePlayerTag(interaction.options.getString("tag", true));
      const reason = interaction.options.getString("reason", true).trim();
      if (!tag) {
        await interaction.editReply("Provide a valid player tag.");
        return;
      }
      if (!reason) {
        await interaction.editReply("Provide a non-empty reason.");
        return;
      }

      const [player, link] = await Promise.all([
        cocService.getPlayerRaw(tag).catch(() => null),
        prisma.playerLink.findUnique({ where: { playerTag: tag } }),
      ]);
      const linkReason = await getLinkReason(
        interaction.guild,
        tag,
        new Map(link ? [[tag, { discordUserId: link.discordUserId }]] : [])
      );
      const finalReason = linkReason ? `${reason} | ${linkReason}` : reason;

      await prisma.kickListEntry.upsert({
        where: {
          guildId_playerTag_source: {
            guildId,
            playerTag: tag,
            source: "MANUAL",
          },
        },
        update: {
          playerName: player?.name ?? null,
          clanTag: player?.clan?.tag ?? null,
          clanName: player?.clan?.name ?? null,
          reason: finalReason,
          daysThreshold: null,
        },
        create: {
          guildId,
          playerTag: tag,
          playerName: player?.name ?? null,
          clanTag: player?.clan?.tag ?? null,
          clanName: player?.clan?.name ?? null,
          reason: finalReason,
          source: "MANUAL",
        },
      });

      await interaction.editReply(`Added ${tag} to kick list (manual).`);
      return;
    }

    if (subcommand === "remove") {
      const tag = normalizePlayerTag(interaction.options.getString("tag", true));
      const deleted = await prisma.kickListEntry.deleteMany({
        where: { guildId, playerTag: tag },
      });
      await interaction.editReply(
        deleted.count > 0
          ? `Removed ${tag} from kick list (${deleted.count} entry/entries).`
          : `${tag} was not on the kick list.`
      );
      return;
    }

    if (subcommand === "clear") {
      const mode = interaction.options.getString("mode", false) ?? "all";
      const where =
        mode === "auto"
          ? { guildId, source: "AUTO_INACTIVE" as const }
          : mode === "manual"
            ? { guildId, source: "MANUAL" as const }
            : { guildId };
      const deleted = await prisma.kickListEntry.deleteMany({ where });
      await interaction.editReply(`Cleared ${deleted.count} kick-list entry/entries (${mode}).`);
      return;
    }

    const rows = await prisma.kickListEntry.findMany({
      where: { guildId },
      orderBy: [{ clanName: "asc" }, { playerName: "asc" }, { createdAt: "asc" }],
    });

    if (rows.length === 0) {
      await interaction.editReply("Kick list is empty.");
      return;
    }

    const grouped = new Map<string, KickRecord>();
    for (const row of rows) {
      const key = normalizePlayerTag(row.playerTag);
      const existing = grouped.get(key);
      const reason = mapReasons({
        reason: row.reason,
        source: row.source,
        daysThreshold: row.daysThreshold,
      });
      if (!existing) {
        grouped.set(key, {
          playerTag: key,
          playerName: row.playerName?.trim() || "Unknown",
          clanName: row.clanName?.trim() || row.clanTag?.trim() || "Unknown Clan",
          reasons: [reason],
        });
      } else if (!existing.reasons.includes(reason)) {
        existing.reasons.push(reason);
      }
    }

    const records = [...grouped.values()].sort((a, b) => {
      if (a.clanName !== b.clanName) return a.clanName.localeCompare(b.clanName);
      return a.playerName.localeCompare(b.playerName);
    });
    const pages = buildPages(records);
    const embeds = pages.map((description, i) =>
      new EmbedBuilder()
        .setTitle(`Kick List (${records.length})`)
        .setDescription(description)
        .setFooter({ text: `Page ${i + 1}/${pages.length}` })
    );

    let page = 0;
    const prefix = `kick-list:${interaction.id}`;
    const reply = await interaction.editReply({
      embeds: [embeds[page]],
      components: embeds.length > 1 ? [buildPaginationRow(prefix, page, embeds.length)] : [],
    });

    if (embeds.length <= 1) return;

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (btn) =>
        btn.user.id === interaction.user.id &&
        (btn.customId === `${prefix}:prev` || btn.customId === `${prefix}:next`),
    });

    collector.on("collect", async (btn) => {
      if (btn.customId.endsWith(":prev")) page = Math.max(0, page - 1);
      if (btn.customId.endsWith(":next")) page = Math.min(embeds.length - 1, page + 1);
      await btn.update({
        embeds: [embeds[page]],
        components: [buildPaginationRow(prefix, page, embeds.length)],
      });
    });

    collector.on("end", async () => {
      await interaction.editReply({ embeds: [embeds[page]], components: [] }).catch(() => undefined);
    });
  },
};
