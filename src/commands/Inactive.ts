import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  CommandInteraction,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";

const DEFAULT_STALE_HOURS = 6;
const DEFAULT_MIN_COVERAGE = 0.8;
const MAX_LINES_PER_PAGE = 24;
const MAX_DESCRIPTION_LENGTH = 3900;

function buildPaginationRow(customIdPrefix: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

export const Inactive: Command = {
  name: "inactive",
  description: "List players inactive for N days",
  options: [
    {
      name: "days",
      description: "Number of days inactive",
      type: 4, // INTEGER
      required: true,
    },
  ],

  run: async (
    _client: Client,
    interaction: CommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const days = interaction.options.get("days", true).value as number;
    if (days <= 0) {
      await interaction.editReply("Days must be greater than 0.");
      return;
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const dbTracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedTags = dbTracked.map((c) => c.tag);

    if (trackedTags.length === 0) {
      await interaction.editReply(
        "No tracked clans configured. Configure at least one clan with `/tracked-clan add` before using `/inactive`."
      );
      return;
    }

    const liveMemberTags = new Set<string>();
    const liveMemberClanByTag = new Map<string, string>();
    for (const trackedTag of trackedTags) {
      try {
        const clan = await cocService.getClan(trackedTag);
        const clanName = String(clan.name ?? trackedTag).trim() || trackedTag;
        for (const member of clan.members ?? []) {
          const memberTag = String(member?.tag ?? "").trim();
          if (memberTag) {
            liveMemberTags.add(memberTag);
            liveMemberClanByTag.set(memberTag, clanName);
          }
        }
      } catch (err) {
        console.error(
          `inactive: failed to fetch live roster for ${trackedTag}: ${formatError(err)}`
        );
      }
    }

    if (liveMemberTags.size === 0) {
      await interaction.editReply(
        "Tracked clans are configured, but live rosters could not be read from CoC API. Try again shortly."
      );
      return;
    }

    const liveMemberTagList = [...liveMemberTags];

    const activitySnapshot = await prisma.playerActivity.aggregate({
      where: {
        tag: { in: liveMemberTagList },
      },
      _max: { updatedAt: true },
      _count: { tag: true },
    });

    const staleHoursRaw = Number(process.env.INACTIVE_STALE_HOURS ?? DEFAULT_STALE_HOURS);
    const staleHours =
      Number.isFinite(staleHoursRaw) && staleHoursRaw > 0
        ? staleHoursRaw
        : DEFAULT_STALE_HOURS;
    const latestObservedAt = activitySnapshot._max.updatedAt ?? null;
    const staleCutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    if (!latestObservedAt || latestObservedAt < staleCutoff) {
      const snapshotAge = latestObservedAt
        ? `<t:${Math.floor(latestObservedAt.getTime() / 1000)}:R>`
        : "unavailable";
      await interaction.editReply(
        `Inactive data is stale (latest observation: ${snapshotAge}). Wait for observation refresh and retry.`
      );
      return;
    }

    const freshObservedCount = await prisma.playerActivity.count({
      where: {
        tag: { in: liveMemberTagList },
        updatedAt: { gte: staleCutoff },
      },
    });

    const minCoverageRaw = Number(
      process.env.INACTIVE_MIN_OBSERVATION_COVERAGE ?? DEFAULT_MIN_COVERAGE
    );
    const minCoverage =
      Number.isFinite(minCoverageRaw) && minCoverageRaw > 0 && minCoverageRaw <= 1
        ? minCoverageRaw
        : DEFAULT_MIN_COVERAGE;
    const observationCoverage = freshObservedCount / liveMemberTagList.length;

    if (observationCoverage < minCoverage) {
      await interaction.editReply(
        `Inactive data is incomplete: only ${freshObservedCount}/${liveMemberTagList.length} live members were observed in the last ${staleHours}h (${Math.floor(
          observationCoverage * 100
        )}% coverage). Wait for observation refresh and retry.`
      );
      return;
    }

    const inactivePlayers = await prisma.playerActivity.findMany({
      where: {
        lastSeenAt: { lt: cutoff },
        updatedAt: { gte: staleCutoff },
        tag: { in: liveMemberTagList },
      },
      orderBy: { lastSeenAt: "asc" },
    });

    if (inactivePlayers.length === 0) {
      await interaction.editReply(`No inactive players for ${days}+ days.`);
      return;
    }

    const inactiveWithClan = inactivePlayers.map((p) => ({
      player: p,
      clan: liveMemberClanByTag.get(p.tag) ?? p.clanTag ?? "Unknown Clan",
    }));

    const clanCounts = new Map<string, number>();
    for (const entry of inactiveWithClan) {
      clanCounts.set(entry.clan, (clanCounts.get(entry.clan) ?? 0) + 1);
    }

    const clanOrder = new Map<string, number>();
    let index = 0;
    for (const tag of trackedTags) {
      const clanName =
        inactiveWithClan.find((entry) => entry.player.clanTag === tag)?.clan ??
        tag;
      if (!clanOrder.has(clanName)) {
        clanOrder.set(clanName, index++);
      }
    }

    inactiveWithClan.sort((a, b) => {
      const orderA = clanOrder.get(a.clan) ?? Number.MAX_SAFE_INTEGER;
      const orderB = clanOrder.get(b.clan) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      if (a.clan !== b.clan) return a.clan.localeCompare(b.clan);
      return a.player.lastSeenAt.getTime() - b.player.lastSeenAt.getTime();
    });

    const pages: string[] = [];
    let currentLines: string[] = [];
    let currentClan: string | null = null;
    const clanPageCounts = new Map<string, number>();

    for (const entry of inactiveWithClan) {
      const isNewClan = currentClan !== entry.clan;
      if (isNewClan) {
        const continuationCount = clanPageCounts.get(entry.clan) ?? 0;
        const header =
          continuationCount === 0
            ? `**${entry.clan} (${clanCounts.get(entry.clan) ?? 0})**`
            : `**${entry.clan} (${clanCounts.get(entry.clan) ?? 0}) (cont.)**`;
        const projectedLines = currentLines.length + (currentLines.length > 0 ? 2 : 1);
        if (projectedLines > MAX_LINES_PER_PAGE) {
          pages.push(currentLines.join("\n"));
          currentLines = [];
        }
        if (currentLines.length > 0) currentLines.push("");
        currentLines.push(header);
        currentClan = entry.clan;
        clanPageCounts.set(entry.clan, continuationCount + 1);
      }

      const daysAgo = Math.floor(
        (Date.now() - entry.player.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)
      );
      const playerLine = `- **${entry.player.name}** (${entry.player.tag}) - ${daysAgo}d`;

      if (currentLines.length + 1 > MAX_LINES_PER_PAGE) {
        pages.push(currentLines.join("\n"));
        currentLines = [
          `**${entry.clan} (${clanCounts.get(entry.clan) ?? 0}) (cont.)**`,
          playerLine,
        ];
        currentClan = entry.clan;
        clanPageCounts.set(entry.clan, (clanPageCounts.get(entry.clan) ?? 0) + 1);
      } else {
        currentLines.push(playerLine);
      }
    }

    if (currentLines.length > 0) {
      pages.push(currentLines.join("\n"));
    }

    const summary =
      `Scope: ${trackedTags.length} tracked clan(s), ` +
      `${liveMemberTags.size} live member tag(s), ` +
      `${activitySnapshot._count.tag} observed player record(s), ` +
      `${freshObservedCount} fresh in last ${staleHours}h.`;

    const embeds = pages.map((content, pageIdx) => {
      let description = content;
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        description = `${description.slice(0, MAX_DESCRIPTION_LENGTH - 20)}\n...truncated`;
      }

      return new EmbedBuilder()
        .setTitle(`Inactive for ${days}+ days (${inactivePlayers.length})`)
        .setDescription(description)
        .setFooter({
          text: `Page ${pageIdx + 1}/${pages.length} • ${summary}`,
        });
    });

    let page = 0;
    const customIdPrefix = `inactive:${interaction.id}`;
    const usePagination = embeds.length > 1;
    const reply = await interaction.editReply({
      embeds: [embeds[page]],
      components: usePagination ? [buildPaginationRow(customIdPrefix, page, embeds.length)] : [],
    });

    if (!usePagination) {
      return;
    }

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (btn) =>
        btn.user.id === interaction.user.id &&
        (btn.customId === `${customIdPrefix}:prev` || btn.customId === `${customIdPrefix}:next`),
    });

    collector.on("collect", async (btn) => {
      if (btn.customId.endsWith(":prev")) {
        page = Math.max(0, page - 1);
      } else if (btn.customId.endsWith(":next")) {
        page = Math.min(embeds.length - 1, page + 1);
      }

      await btn.update({
        embeds: [embeds[page]],
        components: [buildPaginationRow(customIdPrefix, page, embeds.length)],
      });
    });

    collector.on("end", async () => {
      await interaction
        .editReply({
          embeds: [embeds[page]],
          components: [],
        })
        .catch(() => undefined);
    });
  },
};
