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

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

type RosterSnapshot = {
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  liveMemberTags: Set<string>;
  liveMembersByClan: Map<string, Set<string>>;
  liveMemberClanByTag: Map<string, string>;
  liveMemberTrackedClanByTag: Map<string, string>;
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
  const liveMemberTrackedClanByTag = new Map<string, string>();
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
        liveMemberTrackedClanByTag.set(memberTag, trackedTag);
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
    liveMemberTrackedClanByTag,
  };
}

type InactiveDaysEntry = {
  clanTag: string;
  clanName: string;
  playerTag: string;
  playerName: string;
  daysAgo: number;
};

type InactiveWarRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  missedWars: number;
  totalTrueStars: number;
  avgAttackDelay: number | null;
  lateAttacks: number;
  warsAvailable: number;
};

async function fetchInactiveDaysEntries(
  interaction: CommandInteraction,
  cocService: CoCService,
  days: number
): Promise<{
  entries: InactiveDaysEntry[];
  roster: RosterSnapshot | null;
  staleHours: number;
  freshObservedCount: number;
  observedRecordCount: number;
}> {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server.");
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const roster = await getRosterSnapshot(cocService);

  if (roster.trackedTags.length === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
    };
  }
  if (roster.liveMemberTags.size === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
    };
  }

  const liveMemberTagList = [...roster.liveMemberTags];
  const activitySnapshot = await prisma.playerActivity.aggregate({
    where: {
      guildId: interaction.guildId,
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
    return {
      entries: [],
      roster,
      staleHours,
      freshObservedCount: 0,
      observedRecordCount: activitySnapshot._count.tag,
    };
  }

  const freshObservedCount = await prisma.playerActivity.count({
    where: {
      guildId: interaction.guildId,
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
    return {
      entries: [],
      roster,
      staleHours,
      freshObservedCount,
      observedRecordCount: activitySnapshot._count.tag,
    };
  }

  const inactivePlayers = await prisma.playerActivity.findMany({
    where: {
      guildId: interaction.guildId,
      lastSeenAt: { lt: cutoff },
      updatedAt: { gte: staleCutoff },
      tag: { in: liveMemberTagList },
    },
    orderBy: { lastSeenAt: "asc" },
  });

  const entries = inactivePlayers.map((p) => {
    const clanTag =
      roster.liveMemberTrackedClanByTag.get(p.tag) ?? normalizeClanTagInput(p.clanTag ?? "");
    const normalizedClanTag = clanTag ? `#${normalizeClanTagInput(clanTag)}` : "Unknown Clan";
    return {
      clanTag: normalizedClanTag,
      clanName:
        roster.trackedNameByTag.get(normalizedClanTag) ??
        roster.liveMemberClanByTag.get(p.tag) ??
        p.clanTag ??
        "Unknown Clan",
      playerTag: p.tag,
      playerName: p.name,
      daysAgo: Math.floor((Date.now() - p.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)),
    };
  });

  return {
    entries,
    roster,
    staleHours,
    freshObservedCount,
    observedRecordCount: activitySnapshot._count.tag,
  };
}

async function fetchInactiveWarEntries(
  interaction: CommandInteraction,
  wars: number
): Promise<{
  results: InactiveWarRow[];
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  warnings: string[];
}> {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server.");
  }

  const trackedClans = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  const trackedTags = trackedClans.map((c) => c.tag);
  const trackedNameByTag = new Map(trackedClans.map((c) => [c.tag, c.name?.trim() || c.tag]));
  if (trackedTags.length === 0) {
    return { results: [], trackedTags, trackedNameByTag, warnings: [] };
  }

  const results = await prisma.$queryRaw<InactiveWarRow[]>(
    Prisma.sql`
      WITH available AS (
        SELECT
          ended_wars."clanTag",
          COUNT(*)::int AS "warsAvailable"
        FROM (
          SELECT DISTINCT "clanTag", "warId"
          FROM "ClanWarParticipation"
          WHERE "guildId" = ${interaction.guildId}
            AND "clanTag" IN (${Prisma.join(trackedTags)})
            AND "matchType" = 'FWA'
        ) ended_wars
        GROUP BY ended_wars."clanTag"
      ),
      ranked AS (
        SELECT
          cwp."clanTag",
          cwp."playerTag",
          FIRST_VALUE(COALESCE(NULLIF(BTRIM(cwp."playerName"), ''), cwp."playerTag"))
            OVER (
              PARTITION BY cwp."clanTag", cwp."playerTag"
              ORDER BY cwp."warStartTime" DESC, cwp."createdAt" DESC
            ) AS "playerName",
          cwp."missedBoth",
          cwp."trueStars",
          cwp."attackDelayMinutes",
          cwp."attackWindowMissed",
          ROW_NUMBER() OVER (
            PARTITION BY cwp."clanTag", cwp."playerTag"
            ORDER BY cwp."warStartTime" DESC, cwp."createdAt" DESC
          ) AS rn
        FROM "ClanWarParticipation" cwp
        WHERE cwp."guildId" = ${interaction.guildId}
          AND cwp."clanTag" IN (${Prisma.join(trackedTags)})
          AND cwp."matchType" = 'FWA'
      ),
      selected AS (
        SELECT *
        FROM ranked
        WHERE rn <= ${wars}
      )
      SELECT
        s."clanTag",
        s."playerTag",
        MAX(s."playerName") AS "playerName",
        COUNT(*) FILTER (WHERE s."missedBoth" = true)::int AS "missedWars",
        COALESCE(SUM(s."trueStars"), 0)::int AS "totalTrueStars",
        AVG(s."attackDelayMinutes")::float8 AS "avgAttackDelay",
        COUNT(*) FILTER (WHERE s."attackWindowMissed" = true)::int AS "lateAttacks",
        COALESCE(MAX(a."warsAvailable"), 0)::int AS "warsAvailable"
      FROM selected s
      LEFT JOIN available a
        ON a."clanTag" = s."clanTag"
      GROUP BY s."clanTag", s."playerTag"
      HAVING COUNT(*) FILTER (WHERE s."missedBoth" = true) > 0
      ORDER BY s."clanTag" ASC, "missedWars" DESC, MAX(s."playerName") ASC
    `
  );

  const availableRows = await prisma.$queryRaw<Array<{ clanTag: string; warsAvailable: number }>>(
    Prisma.sql`
      SELECT
        ended_wars."clanTag",
        COUNT(*)::int AS "warsAvailable"
      FROM (
        SELECT DISTINCT "clanTag", "warId"
        FROM "ClanWarParticipation"
        WHERE "guildId" = ${interaction.guildId}
          AND "clanTag" IN (${Prisma.join(trackedTags)})
          AND "matchType" = 'FWA'
      ) ended_wars
      GROUP BY ended_wars."clanTag"
    `
  );
  const availableByClan = new Map<string, number>(
    availableRows.map((row) => [row.clanTag, row.warsAvailable])
  );
  const warnings = trackedTags
    .map((clanTag) => {
      const warsAvailable = availableByClan.get(clanTag) ?? 0;
      return warsAvailable < wars
        ? `${trackedNameByTag.get(clanTag) ?? clanTag}: only ${warsAvailable}/${wars} ended FWA wars tracked`
        : null;
    })
    .filter((value): value is string => value !== null);

  return { results, trackedTags, trackedNameByTag, warnings };
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
  if (!interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }
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
      guildId: interaction.guildId,
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
      guildId: interaction.guildId,
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
      guildId: interaction.guildId,
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
  wars: number
): Promise<void> {
  const { results, trackedTags, trackedNameByTag, warnings } = await fetchInactiveWarEntries(
    interaction,
    wars
  );

  if (trackedTags.length === 0) {
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
    );
    return;
  }

  if (results.length === 0) {
    const warningText = warnings.length > 0 ? `\n\nTracking note:\n- ${warnings.join("\n- ")}` : "";
    await interaction.editReply(
      `No players found who missed both attacks in the last ${wars} FWA war(s).${warningText}`
    );
    return;
  }

  const clanOrder = new Map<string, number>();
  trackedTags.forEach((tag, i) => clanOrder.set(tag, i));
  results.sort((a, b) => {
    const orderA = clanOrder.get(a.clanTag) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(b.clanTag) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.missedWars !== b.missedWars) return b.missedWars - a.missedWars;
    return a.playerName.localeCompare(b.playerName);
  });

  const pages = buildGroupedPages(
    results,
    (e) => trackedNameByTag.get(e.clanTag) ?? e.clanTag,
    (e) =>
      `- **${e.playerName}** (${e.playerTag}) - missed both in ${e.missedWars}/${Math.min(wars, e.warsAvailable)} war(s), true stars ${e.totalTrueStars}, avg delay ${e.avgAttackDelay !== null ? `${Math.round(e.avgAttackDelay)}m` : "n/a"}, late attacks ${e.lateAttacks}`
  );

  const footerSuffix = warnings.length > 0 ? ` • Partial data: ${warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Missed Both Attacks - Last ${wars} War(s) (${results.length})`,
    pages,
    footerSuffix
  );
}

async function runCombinedMode(
  interaction: CommandInteraction,
  cocService: CoCService,
  days: number,
  wars: number
): Promise<void> {
  const daysResult = await fetchInactiveDaysEntries(interaction, cocService, days);
  const warsResult = await fetchInactiveWarEntries(interaction, wars);

  if (!daysResult.roster || daysResult.roster.trackedTags.length === 0 || warsResult.trackedTags.length === 0) {
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
    );
    return;
  }

  const combined = new Map<
    string,
    {
      clanTag: string;
      clanName: string;
      playerTag: string;
      playerName: string;
      daysAgo: number | null;
      missedWars: number | null;
      warsAvailable: number | null;
      totalTrueStars: number | null;
      avgAttackDelay: number | null;
      lateAttacks: number | null;
    }
  >();

  for (const entry of daysResult.entries) {
    combined.set(entry.playerTag, {
      clanTag: entry.clanTag,
      clanName: entry.clanName,
      playerTag: entry.playerTag,
      playerName: entry.playerName,
      daysAgo: entry.daysAgo,
      missedWars: null,
      warsAvailable: null,
      totalTrueStars: null,
      avgAttackDelay: null,
      lateAttacks: null,
    });
  }

  for (const entry of warsResult.results) {
    const existing = combined.get(entry.playerTag);
    const clanName = warsResult.trackedNameByTag.get(entry.clanTag) ?? entry.clanTag;
    combined.set(entry.playerTag, {
      clanTag: entry.clanTag,
      clanName,
      playerTag: entry.playerTag,
      playerName: existing?.playerName ?? entry.playerName,
      daysAgo: existing?.daysAgo ?? null,
      missedWars: entry.missedWars,
      warsAvailable: entry.warsAvailable,
      totalTrueStars: entry.totalTrueStars,
      avgAttackDelay: entry.avgAttackDelay,
      lateAttacks: entry.lateAttacks,
    });
  }

  const rows = [...combined.values()];
  if (rows.length === 0) {
    const warningText =
      warsResult.warnings.length > 0 ? `\n\nTracking note:\n- ${warsResult.warnings.join("\n- ")}` : "";
    await interaction.editReply(
      `No players matched \`days:${days}\` or \`wars:${wars}\`.${warningText}`
    );
    return;
  }

  const clanOrder = new Map<string, number>();
  daysResult.roster.trackedTags.forEach((tag, i) => clanOrder.set(tag, i));
  rows.sort((a, b) => {
    const orderA = clanOrder.get(a.clanTag) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(b.clanTag) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    const daysA = a.daysAgo ?? -1;
    const daysB = b.daysAgo ?? -1;
    if (daysA !== daysB) return daysB - daysA;
    const missedA = a.missedWars ?? -1;
    const missedB = b.missedWars ?? -1;
    if (missedA !== missedB) return missedB - missedA;
    return a.playerName.localeCompare(b.playerName);
  });

  const pages = buildGroupedPages(
    rows,
    (e) => e.clanName,
    (e) => {
      const reasons: string[] = [];
      if (e.daysAgo !== null) reasons.push(`${e.daysAgo}d inactive`);
      if (e.missedWars !== null) {
        reasons.push(
          `missed both in ${e.missedWars}/${Math.min(wars, e.warsAvailable ?? wars)} war(s)`
        );
      }
      const metrics =
        e.missedWars !== null
          ? `, true stars ${e.totalTrueStars ?? 0}, avg delay ${
              e.avgAttackDelay !== null ? `${Math.round(e.avgAttackDelay)}m` : "n/a"
            }, late attacks ${e.lateAttacks ?? 0}`
          : "";
      return `- **${e.playerName}** (${e.playerTag}) - ${reasons.join(" | ")}${metrics}`;
    }
  );

  const footerSuffix =
    warsResult.warnings.length > 0 ? ` • Partial war data: ${warsResult.warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Inactive Players - Days ${days} + Wars ${wars} (${rows.length})`,
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

    if (!daysValue && !warsValue) {
      await interaction.editReply("Provide at least one filter: `days` and/or `wars`.");
      return;
    }

    if (daysValue && daysValue <= 0) {
      await interaction.editReply("Days must be greater than 0.");
      return;
    }
    if (warsValue && warsValue <= 0) {
      await interaction.editReply("Wars must be greater than 0.");
      return;
    }

    if (daysValue && warsValue) {
      await runCombinedMode(interaction, cocService, daysValue, warsValue);
      return;
    }
    if (daysValue) {
      await runDaysMode(interaction, cocService, daysValue);
      return;
    }
    await runWarsMode(interaction, warsValue!);
  },
};


