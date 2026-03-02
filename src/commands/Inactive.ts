import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  CommandInteraction,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { formatError } from "../helper/formatError";

const DEFAULT_STALE_HOURS = 6;
const DEFAULT_MIN_COVERAGE = 0.8;
const MAX_LINES_PER_PAGE = 24;
const MAX_DESCRIPTION_LENGTH = 3900;

type RosterSnapshot = {
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  liveMemberTags: Set<string>;
  liveMembersByClan: Map<string, Set<string>>;
  liveMemberClanByTag: Map<string, string>;
};

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

async function getRosterSnapshot(cocService: CoCService): Promise<RosterSnapshot> {
  const dbTracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  const trackedTags = dbTracked.map((c) => c.tag);
  const trackedNameByTag = new Map(dbTracked.map((c) => [c.tag, c.name?.trim() || c.tag]));

  const liveMemberTags = new Set<string>();
  const liveMembersByClan = new Map<string, Set<string>>();
  const liveMemberClanByTag = new Map<string, string>();
  for (const trackedTag of trackedTags) {
    try {
      const clan = await cocService.getClan(trackedTag);
      const clanName =
        String(clan.name ?? trackedNameByTag.get(trackedTag) ?? trackedTag).trim() || trackedTag;
      const memberSet = new Set<string>();
      for (const member of clan.members ?? []) {
        const memberTag = String(member?.tag ?? "").trim();
        if (!memberTag) continue;
        memberSet.add(memberTag);
        liveMemberTags.add(memberTag);
        liveMemberClanByTag.set(memberTag, clanName);
      }
      liveMembersByClan.set(trackedTag, memberSet);
    } catch (err) {
      console.error(`inactive: failed to fetch live roster for ${trackedTag}: ${formatError(err)}`);
    }
  }

  return {
    trackedTags,
    trackedNameByTag,
    liveMemberTags,
    liveMembersByClan,
    liveMemberClanByTag,
  };
}

async function renderEmbedsWithPager(
  interaction: CommandInteraction,
  title: string,
  pages: string[],
  footerSuffix = ""
): Promise<void> {
  const embeds = pages.map((content, idx) =>
    new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        content.length > MAX_DESCRIPTION_LENGTH
          ? `${content.slice(0, MAX_DESCRIPTION_LENGTH - 20)}\n...truncated`
          : content
      )
      .setFooter({ text: `Page ${idx + 1}/${pages.length}${footerSuffix}` })
  );

  let page = 0;
  const customIdPrefix = `inactive:${interaction.id}`;
  const usePagination = embeds.length > 1;
  const reply = await interaction.editReply({
    embeds: [embeds[page]],
    components: usePagination ? [buildPaginationRow(customIdPrefix, page, embeds.length)] : [],
  });

  if (!usePagination) return;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000,
    filter: (btn) =>
      btn.user.id === interaction.user.id &&
      (btn.customId === `${customIdPrefix}:prev` || btn.customId === `${customIdPrefix}:next`),
  });

  collector.on("collect", async (btn) => {
    if (btn.customId.endsWith(":prev")) page = Math.max(0, page - 1);
    if (btn.customId.endsWith(":next")) page = Math.min(embeds.length - 1, page + 1);

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
}

function buildGroupedPages<T>(
  entries: T[],
  getClanName: (entry: T) => string,
  renderLine: (entry: T) => string
): string[] {
  const clanCounts = new Map<string, number>();
  for (const entry of entries) {
    const clanName = getClanName(entry);
    clanCounts.set(clanName, (clanCounts.get(clanName) ?? 0) + 1);
  }

  const pages: string[] = [];
  let currentLines: string[] = [];
  let currentClan: string | null = null;
  const clanPageCounts = new Map<string, number>();

  for (const entry of entries) {
    const clanName = getClanName(entry);
    const isNewClan = currentClan !== clanName;
    if (isNewClan) {
      const continuationCount = clanPageCounts.get(clanName) ?? 0;
      const header =
        continuationCount === 0
          ? `**${clanName} (${clanCounts.get(clanName) ?? 0})**`
          : `**${clanName} (${clanCounts.get(clanName) ?? 0}) (cont.)**`;

      const projectedLines = currentLines.length + (currentLines.length > 0 ? 2 : 1);
      if (projectedLines > MAX_LINES_PER_PAGE) {
        pages.push(currentLines.join("\n"));
        currentLines = [];
      }

      if (currentLines.length > 0) currentLines.push("");
      currentLines.push(header);
      currentClan = clanName;
      clanPageCounts.set(clanName, continuationCount + 1);
    }

    const line = renderLine(entry);
    if (currentLines.length + 1 > MAX_LINES_PER_PAGE) {
      pages.push(currentLines.join("\n"));
      currentLines = [
        `**${clanName} (${clanCounts.get(clanName) ?? 0}) (cont.)**`,
        line,
      ];
      currentClan = clanName;
      clanPageCounts.set(clanName, (clanPageCounts.get(clanName) ?? 0) + 1);
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    pages.push(currentLines.join("\n"));
  }
  return pages;
}

async function runDaysMode(
  interaction: CommandInteraction,
  cocService: CoCService,
  days: number
): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const roster = await getRosterSnapshot(cocService);

  if (roster.trackedTags.length === 0) {
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
    );
    return;
  }
  if (roster.liveMemberTags.size === 0) {
    await interaction.editReply(
      "Tracked clans are configured, but live rosters could not be read from CoC API. Try again shortly."
    );
    return;
  }

  const liveMemberTagList = [...roster.liveMemberTags];
  const activitySnapshot = await prisma.playerActivity.aggregate({
    where: {
      tag: { in: liveMemberTagList },
    },
    _max: { updatedAt: true },
    _count: { tag: true },
  });

  const staleHoursRaw = Number(process.env.INACTIVE_STALE_HOURS ?? DEFAULT_STALE_HOURS);
  const staleHours =
    Number.isFinite(staleHoursRaw) && staleHoursRaw > 0 ? staleHoursRaw : DEFAULT_STALE_HOURS;
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

  const clanOrder = new Map<string, number>();
  let index = 0;
  for (const tag of roster.trackedTags) {
    const clanName = roster.trackedNameByTag.get(tag) ?? tag;
    if (!clanOrder.has(clanName)) clanOrder.set(clanName, index++);
  }

  const inactiveWithClan = inactivePlayers.map((p) => ({
    player: p,
    clan: roster.liveMemberClanByTag.get(p.tag) ?? p.clanTag ?? "Unknown Clan",
  }));
  inactiveWithClan.sort((a, b) => {
    const orderA = clanOrder.get(a.clan) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(b.clan) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.clan !== b.clan) return a.clan.localeCompare(b.clan);
    return a.player.lastSeenAt.getTime() - b.player.lastSeenAt.getTime();
  });

  const pages = buildGroupedPages(
    inactiveWithClan,
    (e) => e.clan,
    (e) => {
      const daysAgo = Math.floor((Date.now() - e.player.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000));
      return `- **${e.player.name}** (${e.player.tag}) - ${daysAgo}d`;
    }
  );

  const summary =
    ` • Scope: ${roster.trackedTags.length} tracked clan(s), ${roster.liveMemberTags.size} live member(s), ` +
    `${activitySnapshot._count.tag} observed record(s), ${freshObservedCount} fresh in last ${staleHours}h`;
  await renderEmbedsWithPager(
    interaction,
    `Inactive for ${days}+ days (${inactivePlayers.length})`,
    pages,
    summary
  );
}

async function runWarsMode(
  interaction: CommandInteraction,
  cocService: CoCService,
  wars: number
): Promise<void> {
  type WarParticipantRow = {
    clanTag: string;
    warStartTime: Date;
    playerTag: string;
    playerName: string | null;
    playerPosition: number | null;
    attacksUsed: number;
  };

  const roster = await getRosterSnapshot(cocService);
  if (roster.trackedTags.length === 0) {
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
    );
    return;
  }

  const results: Array<{
    clanTag: string;
    clanName: string;
    playerTag: string;
    playerName: string;
    playerPosition: number | null;
  }> = [];
  const warnings: string[] = [];

  for (const clanTag of roster.trackedTags) {
    const selectedWars = await prisma.$queryRaw<Array<{ warStartTime: Date }>>(
      Prisma.sql`
        SELECT DISTINCT "warStartTime"
        FROM "WarHistoryParticipant"
        WHERE
          "clanTag" = ${clanTag}
          AND (
            "warState" = 'warEnded'
            OR ("warEndTime" IS NOT NULL AND "warEndTime" <= NOW())
          )
        ORDER BY "warStartTime" DESC
        LIMIT ${wars}
      `
    );

    if (selectedWars.length < wars) {
      warnings.push(
        `${roster.trackedNameByTag.get(clanTag) ?? clanTag}: only ${selectedWars.length}/${wars} ended wars tracked`
      );
      continue;
    }

    const selectedStartTimes = selectedWars.map((w) => w.warStartTime);
    const participants = await prisma.$queryRaw<WarParticipantRow[]>(
      Prisma.sql`
        SELECT
          "clanTag",
          "warStartTime",
          "playerTag",
          "playerName",
          "playerPosition",
          "attacksUsed"
        FROM "WarHistoryParticipant"
        WHERE
          "clanTag" = ${clanTag}
          AND "warStartTime" IN (${Prisma.join(selectedStartTimes)})
      `
    );

    const statsByPlayer = new Map<
      string,
      { participated: number; missed: number; playerName: string; playerPosition: number | null }
    >();
    for (const row of participants) {
      const stat = statsByPlayer.get(row.playerTag) ?? {
        participated: 0,
        missed: 0,
        playerName: row.playerName?.trim() || row.playerTag,
        playerPosition: row.playerPosition ?? null,
      };
      stat.participated += 1;
      if (row.attacksUsed === 0) stat.missed += 1;
      stat.playerName = row.playerName?.trim() || stat.playerName;
      stat.playerPosition = row.playerPosition ?? stat.playerPosition;
      statsByPlayer.set(row.playerTag, stat);
    }

    const clanName = roster.trackedNameByTag.get(clanTag) ?? clanTag;
    const currentMembers = roster.liveMembersByClan.get(clanTag) ?? new Set<string>();
    for (const memberTag of currentMembers) {
      const stat = statsByPlayer.get(memberTag);
      if (!stat) continue;
      if (stat.participated === wars && stat.missed === wars) {
        results.push({
          clanTag,
          clanName,
          playerTag: memberTag,
          playerName: stat.playerName,
          playerPosition: stat.playerPosition,
        });
      }
    }
  }

  if (results.length === 0) {
    const warningText = warnings.length > 0 ? `\n\nTracking note:\n- ${warnings.join("\n- ")}` : "";
    await interaction.editReply(
      `No tracked members found with 0/2 attacks across the last ${wars} ended war(s).${warningText}`
    );
    return;
  }

  const clanOrder = new Map<string, number>();
  roster.trackedTags.forEach((tag, i) => clanOrder.set(tag, i));
  results.sort((a, b) => {
    const orderA = clanOrder.get(a.clanTag) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(b.clanTag) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.playerPosition !== null && b.playerPosition !== null && a.playerPosition !== b.playerPosition) {
      return a.playerPosition - b.playerPosition;
    }
    return a.playerName.localeCompare(b.playerName);
  });

  const pages = buildGroupedPages(
    results,
    (e) => e.clanName,
    (e) =>
      `- **${e.playerName}** (${e.playerTag}) - 0/2 in last ${wars} war(s)${
        e.playerPosition ? `, pos ${e.playerPosition}` : ""
      }`
  );

  const footerSuffix = warnings.length > 0 ? ` • Partial data: ${warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Missed Both Attacks - Last ${wars} War(s) (${results.length})`,
    pages,
    footerSuffix
  );
}

export const Inactive: Command = {
  name: "inactive",
  description: "List players inactive by days or missed wars",
  options: [
    {
      name: "days",
      description: "Number of days inactive",
      type: 4, // INTEGER
      required: false,
    },
    {
      name: "wars",
      description: "Missed both attacks for the last X wars",
      type: 4, // INTEGER
      required: false,
    },
  ],

  run: async (
    _client: Client,
    interaction: CommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const daysValue = interaction.options.get("days")?.value as number | undefined;
    const warsValue = interaction.options.get("wars")?.value as number | undefined;

    if ((!daysValue && !warsValue) || (daysValue && warsValue)) {
      await interaction.editReply("Provide exactly one filter: `days` or `wars`.");
      return;
    }

    if (daysValue) {
      if (daysValue <= 0) {
        await interaction.editReply("Days must be greater than 0.");
        return;
      }
      await runDaysMode(interaction, cocService, daysValue);
      return;
    }

    if (!warsValue || warsValue <= 0) {
      await interaction.editReply("Wars must be greater than 0.");
      return;
    }
    await runWarsMode(interaction, cocService, warsValue);
  },
};

