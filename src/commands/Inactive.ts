import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  AutocompleteInteraction,
  EmbedBuilder,
  ApplicationCommandOptionType,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { InactiveWarService, type InactiveWarSummary } from "../services/InactiveWarService";
import { formatError } from "../helper/formatError";
import { listPlayerLinksForClanMembers } from "../services/PlayerLinkService";
import { normalizeClanTag } from "../services/PlayerLinkService";

const DEFAULT_STALE_HOURS = 6;
const DEFAULT_MIN_COVERAGE = 0.8;
const MAX_LINES_PER_PAGE = 24;
const MAX_DESCRIPTION_LENGTH = 3900;

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function formatInactiveClanTag(tag: string): string {
  const normalized = normalizeClanTagInput(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function formatInactivePlayerTag(tag: string): string {
  const normalized = normalizeClanTagInput(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function buildInactiveWarRatioText(input: {
  missedWars: number;
  participationWars: number;
  requestedWars: number;
}): string | null {
  if (
    input.missedWars === input.requestedWars &&
    input.participationWars === input.requestedWars
  ) {
    return null;
  }
  return `${input.missedWars}/${input.participationWars} wars missed`;
}

function buildInactiveWarEmojiSequence(missedWarStates: { emoji: string }[]): string {
  return missedWarStates.map((state) => state.emoji).join(" ");
}

function sortInactiveWarRowsForDisplay(
  rows: InactiveWarSummary["results"],
  trackedTags: string[],
): InactiveWarSummary["results"] {
  const orderByClan = new Map(
    trackedTags.map((tag, index) => [normalizeClanTagInput(tag), index] as const),
  );
  return [...rows].sort((left, right) => {
    const clanLeft = orderByClan.get(normalizeClanTagInput(left.clanTag)) ?? Number.MAX_SAFE_INTEGER;
    const clanRight =
      orderByClan.get(normalizeClanTagInput(right.clanTag)) ?? Number.MAX_SAFE_INTEGER;
    if (clanLeft !== clanRight) return clanLeft - clanRight;
    const leftName = left.playerName.toLowerCase();
    const rightName = right.playerName.toLowerCase();
    if (left.missedWars !== right.missedWars) return right.missedWars - left.missedWars;
    if (left.participationWars !== right.participationWars) {
      return right.participationWars - left.participationWars;
    }
    if (leftName !== rightName) return leftName.localeCompare(rightName);
    return left.playerTag.localeCompare(right.playerTag);
  });
}

async function loadInactiveWarDiscordLinks(
  rows: InactiveWarSummary["results"],
): Promise<Map<string, string>> {
  const orderedTags = [...new Set(rows.map((row) => formatInactivePlayerTag(row.playerTag)))];
  const links = await listPlayerLinksForClanMembers({ memberTagsInOrder: orderedTags });
  const discordUserIdByPlayerTag = new Map<string, string>();
  for (const link of links) {
    const normalizedTag = normalizeClanTagInput(link.playerTag);
    if (!normalizedTag) continue;
    discordUserIdByPlayerTag.set(normalizedTag, link.discordUserId);
  }
  return discordUserIdByPlayerTag;
}

function buildInactiveWarPlayerDiscordText(
  discordUserIdByPlayerTag: Map<string, string>,
  playerTag: string,
): string {
  const discordUserId = discordUserIdByPlayerTag.get(normalizeClanTagInput(playerTag)) ?? null;
  return discordUserId ? `<@${discordUserId}>` : "—";
}

function buildInactiveWarClanAutocompleteChoices(query: string) {
  return prisma.trackedClan
    .findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    })
    .then((tracked) =>
      tracked
        .map((clan) => {
          const tag = normalizeClanTag(clan.tag);
          if (!tag) return null;
          const label = clan.name?.trim() ? `${clan.name.trim()} (${tag})` : tag;
          return { name: label.slice(0, 100), value: tag };
        })
        .filter((choice): choice is { name: string; value: string } => {
          if (!choice) return false;
          return (
            choice.name.toLowerCase().includes(query) ||
            choice.value.toLowerCase().includes(query)
          );
        })
        .slice(0, 25),
    );
}

function buildInactiveWarScopedEmptyMessage(input: {
  wars: number;
  clanTag: string | null | undefined;
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  diagnosticNote: string | null;
  warnings: string[];
}): string {
  const warningText =
    input.warnings.length > 0 ? `\n\nTracking note:\n- ${input.warnings.join("\n- ")}` : "";
  const diagnosticText = input.diagnosticNote ? `\n\n${input.diagnosticNote}` : "";
  const scopedClanTag = input.clanTag ? formatInactiveClanTag(input.clanTag) : null;
  const scopedClanName =
    scopedClanTag && input.trackedTags.length > 0
      ? input.trackedNameByTag.get(input.trackedTags[0]!) ?? scopedClanTag
      : null;

  if (input.clanTag && scopedClanName) {
    return `No players found in ${scopedClanName} who missed both attacks in at least one of the last ${input.wars} ended tracked war(s).${warningText}${diagnosticText}`;
  }

  if (scopedClanTag) {
    return `No players found for scoped clan ${scopedClanTag} who missed both attacks in at least one of the last ${input.wars} ended tracked war(s).${warningText}${diagnosticText}`;
  }

  return `No players found who missed both attacks in at least one of the last ${input.wars} ended tracked war(s).${warningText}${diagnosticText}`;
}

function buildInactiveWarGroupedPages(input: {
  rows: InactiveWarSummary["results"];
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  discordUserIdByPlayerTag: Map<string, string>;
  requestedWars: number;
}): string[] {
  const rowsByClan = new Map<string, InactiveWarSummary["results"]>();
  for (const row of input.rows) {
    const clanTag = normalizeClanTagInput(row.clanTag);
    const existing = rowsByClan.get(clanTag) ?? [];
    existing.push(row);
    rowsByClan.set(clanTag, existing);
  }

  const lines: string[] = [];
  for (const trackedTag of input.trackedTags) {
    const clanTag = normalizeClanTagInput(trackedTag);
    const clanRows = rowsByClan.get(clanTag) ?? [];
    if (clanRows.length === 0) continue;

    const clanName = input.trackedNameByTag.get(trackedTag) ?? input.trackedNameByTag.get(clanTag) ?? clanTag;
    lines.push(`${clanName} (${clanRows.length})`);

    const byMissedCount = new Map<number, InactiveWarSummary["results"]>();
    for (const row of clanRows) {
      const existing = byMissedCount.get(row.missedWars) ?? [];
      existing.push(row);
      byMissedCount.set(row.missedWars, existing);
    }

    for (const missedWars of [...byMissedCount.keys()].sort((a, b) => b - a)) {
      const subRows = (byMissedCount.get(missedWars) ?? []).sort((left, right) => {
        if (left.participationWars !== right.participationWars) {
          return right.participationWars - left.participationWars;
        }
        const nameCompare = left.playerName.localeCompare(right.playerName);
        if (nameCompare !== 0) return nameCompare;
        return left.playerTag.localeCompare(right.playerTag);
      });
      const label = missedWars === 1 ? "1 war missed" : `${missedWars} wars missed`;
      lines.push(`- ${label}`);
      for (const row of subRows) {
        const ratioText = buildInactiveWarRatioText({
          missedWars: row.missedWars,
          participationWars: row.participationWars,
          requestedWars: input.requestedWars,
        });
        const discordText = buildInactiveWarPlayerDiscordText(
          input.discordUserIdByPlayerTag,
          row.playerTag,
        );
        const emojiSequence = buildInactiveWarEmojiSequence(row.missedWarStates);
        const playerTag = formatInactivePlayerTag(row.playerTag);
        const rowText = ratioText
          ? `  - ${row.playerName} \`${playerTag}\` ${discordText} - ${ratioText} - ${emojiSequence}`
          : `  - ${row.playerName} \`${playerTag}\` ${discordText} - ${emojiSequence}`;
        lines.push(rowText);
      }
    }

    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const pages: string[] = [];
  let currentPage: string[] = [];
  for (const line of lines) {
    if (currentPage.length >= MAX_LINES_PER_PAGE) {
      pages.push(currentPage.join("\n"));
      currentPage = [];
    }
    currentPage.push(line);
  }
  if (currentPage.length > 0) {
    pages.push(currentPage.join("\n"));
  }
  return pages.length > 0 ? pages : [""];
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

async function getRosterSnapshot(
  cocService: CoCService,
  clanTag?: string | null
): Promise<RosterSnapshot> {
  const dbTracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  const normalizedClanFilter = normalizeClanTagInput(clanTag ?? "");
  const scopedTracked = normalizedClanFilter
    ? dbTracked.filter((c) => normalizeClanTagInput(c.tag) === normalizedClanFilter)
    : dbTracked;
  const trackedTags = scopedTracked.map((c) => c.tag);
  const trackedNameByTag = new Map(scopedTracked.map((c) => [c.tag, c.name?.trim() || c.tag]));

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

const inactiveWarService = new InactiveWarService();

async function fetchInactiveDaysEntries(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
  days: number,
  clanTag?: string | null,
): Promise<{
  entries: InactiveDaysEntry[];
  roster: RosterSnapshot | null;
  staleHours: number;
  freshObservedCount: number;
  observedRecordCount: number;
  scopeClanTag: string | null;
  scopeClanName: string | null;
}> {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server.");
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const roster = await getRosterSnapshot(cocService, clanTag);

  if (roster.trackedTags.length === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
      scopeClanTag: null,
      scopeClanName: null,
    };
  }
  if (roster.liveMemberTags.size === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
      scopeClanTag: null,
      scopeClanName: null,
    };
  }

  const normalizedClanFilter = normalizeClanTagInput(clanTag ?? "");
  const scopedTrackedTags = normalizedClanFilter
    ? roster.trackedTags.filter((tag) => normalizeClanTagInput(tag) === normalizedClanFilter)
    : roster.trackedTags;
  const scopeClanTag = scopedTrackedTags[0] ?? null;
  const scopeClanName =
    scopeClanTag !== null ? roster.trackedNameByTag.get(scopeClanTag) ?? scopeClanTag : null;

  if (normalizedClanFilter && scopedTrackedTags.length === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
      scopeClanTag: null,
      scopeClanName: null,
    };
  }

  const scopedClanTagSet = new Set(scopedTrackedTags.map((tag) => normalizeClanTagInput(tag)));
  const scopedLiveMemberTags = [...roster.liveMemberTags].filter((tag) => {
    const trackedClanTag = roster.liveMemberTrackedClanByTag.get(tag) ?? "";
    return scopedClanTagSet.has(normalizeClanTagInput(trackedClanTag));
  });
  if (scopedLiveMemberTags.length === 0) {
    return {
      entries: [],
      roster,
      staleHours: DEFAULT_STALE_HOURS,
      freshObservedCount: 0,
      observedRecordCount: 0,
      scopeClanTag,
      scopeClanName,
    };
  }

  const liveMemberTagList = scopedLiveMemberTags;
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
      scopeClanTag,
      scopeClanName,
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
      scopeClanTag,
      scopeClanName,
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
    scopeClanTag,
    scopeClanName,
  };
}

async function fetchInactiveWarEntries(
  interaction: ChatInputCommandInteraction,
  wars: number,
  clanTag?: string | null,
): Promise<InactiveWarSummary> {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server.");
  }
  return inactiveWarService.listInactiveWarPlayers({
    guildId: interaction.guildId,
    wars,
    clanTag,
  });
}

async function renderEmbedsWithPager(
  interaction: ChatInputCommandInteraction,
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
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
  days: number,
  clanTag?: string | null,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const roster = await getRosterSnapshot(cocService, clanTag);

  const scopeClanTag = roster.trackedTags[0] ?? null;
  const scopeClanName = scopeClanTag
    ? roster.trackedNameByTag.get(scopeClanTag) ?? scopeClanTag
    : null;

  if (roster.trackedTags.length === 0) {
    if (clanTag) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag)}. Configure at least one tracked clan with \`/tracked-clan configure\` before using \`/inactive\` in wars or days mode.`
      );
      return;
    }
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
    );
    return;
  }
  if (roster.liveMemberTags.size === 0) {
    await interaction.editReply(
      clanTag && scopeClanName
        ? `Tracked clan ${scopeClanName} is configured, but live rosters could not be read from CoC API. Try again shortly.`
        : "Tracked clans are configured, but live rosters could not be read from CoC API. Try again shortly."
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
      clanTag && scopeClanName
        ? `Inactive data for ${scopeClanName} is stale (latest observation: ${snapshotAge}). Wait for observation refresh and retry.`
        : `Inactive data is stale (latest observation: ${snapshotAge}). Wait for observation refresh and retry.`
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
      clanTag && scopeClanName
        ? `Inactive data for ${scopeClanName} is incomplete: only ${freshObservedCount}/${liveMemberTagList.length} live members were observed in the last ${staleHours}h (${Math.floor(
            observationCoverage * 100
          )}% coverage). Wait for observation refresh and retry.`
        : `Inactive data is incomplete: only ${freshObservedCount}/${liveMemberTagList.length} live members were observed in the last ${staleHours}h (${Math.floor(
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
    await interaction.editReply(
      clanTag && scopeClanName
        ? `No inactive players for ${days}+ days in ${scopeClanName}.`
        : `No inactive players for ${days}+ days.`
    );
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
  interaction: ChatInputCommandInteraction,
  wars: number,
  clanTag?: string | null,
): Promise<void> {
  const { results, trackedTags, trackedNameByTag, warnings, diagnosticNote } =
    await fetchInactiveWarEntries(interaction, wars, clanTag);

  if (trackedTags.length === 0) {
    if (diagnosticNote || warnings.length > 0) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag ?? "")}.${
          diagnosticNote ? `\n\n${diagnosticNote}` : ""
        }`
      );
    } else {
      await interaction.editReply(
        "No tracked clans configured. Configure at least one clan with `/tracked-clan configure` before using `/inactive`."
      );
    }
    return;
  }

  if (results.length === 0) {
    await interaction.editReply(
      buildInactiveWarScopedEmptyMessage({
        wars,
        clanTag,
        trackedTags,
        trackedNameByTag,
        diagnosticNote,
        warnings,
      }),
    );
    return;
  }

  const sortedResults = sortInactiveWarRowsForDisplay(results, trackedTags);
  const discordUserIdByPlayerTag = await loadInactiveWarDiscordLinks(sortedResults);
  const pages = buildInactiveWarGroupedPages({
    rows: sortedResults,
    trackedTags,
    trackedNameByTag,
    discordUserIdByPlayerTag,
    requestedWars: wars,
  });

  const footerSuffix = warnings.length > 0 ? ` • Partial data: ${warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Missed Both Attacks - Last ${wars} War(s) (${results.length})`,
    pages,
    footerSuffix
  );
}

async function runCombinedMode(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
  days: number,
  wars: number,
  clanTag?: string | null,
): Promise<void> {
  const daysResult = await fetchInactiveDaysEntries(interaction, cocService, days, clanTag);
  const warsResult = await fetchInactiveWarEntries(interaction, wars, clanTag);

  if (!daysResult.roster || daysResult.roster.trackedTags.length === 0 || warsResult.trackedTags.length === 0) {
    if (clanTag && warsResult.diagnosticNote) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag)}.\n\n${warsResult.diagnosticNote}`
      );
      return;
    }
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
      participationWars: number | null;
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
      participationWars: null,
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
      participationWars: entry.participationWars,
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
    const diagnosticText = warsResult.diagnosticNote ? `\n\n${warsResult.diagnosticNote}` : "";
    const scopedClanName = clanTag ? formatInactiveClanTag(clanTag) : null;
    const scopedPrefix = scopedClanName ? ` in ${scopedClanName}` : "";
    await interaction.editReply(
      `No players matched \`days:${days}\` or \`wars:${wars}\`${scopedPrefix}.${warningText}${diagnosticText}`
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
    const participationA = a.participationWars ?? -1;
    const participationB = b.participationWars ?? -1;
    if (participationA !== participationB) return participationB - participationA;
    const nameCompare = a.playerName.localeCompare(b.playerName);
    if (nameCompare !== 0) return nameCompare;
    return a.playerTag.localeCompare(b.playerTag);
  });

  const warsDiscordUserIdByPlayerTag = await loadInactiveWarDiscordLinks(warsResult.results);
  const pages = buildGroupedPages(
    rows,
    (e) => e.clanName,
    (e) => {
      const reasons: string[] = [];
      if (e.daysAgo !== null) reasons.push(`${e.daysAgo}d inactive`);
      if (e.missedWars !== null) {
        reasons.push(`missed both in ${e.missedWars}/${e.participationWars ?? 0} war(s)`);
      }
      const warsRow = warsResult.results.find(
        (row) => normalizeClanTagInput(row.playerTag) === normalizeClanTagInput(e.playerTag),
      );
      const discordText = warsRow
        ? buildInactiveWarPlayerDiscordText(warsDiscordUserIdByPlayerTag, warsRow.playerTag)
        : "—";
      const emojiSequence = warsRow ? buildInactiveWarEmojiSequence(warsRow.missedWarStates) : "";
      const playerTag = formatInactivePlayerTag(e.playerTag);
      const reasonText = reasons.length > 0 ? ` - ${reasons.join(" | ")}` : "";
      const emojiText = warsRow ? ` - ${emojiSequence}` : "";
      return `- ${e.playerName} \`${playerTag}\` ${discordText}${reasonText}${emojiText}`;
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
      description: "Players who missed both attacks in at least one of the last X ended wars",
      type: 4, // INTEGER
      required: false,
    },
    {
      name: "clan",
      description: "Filter inactive players to one tracked clan",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
  ],

  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });

    const daysValue = interaction.options.getInteger("days", false) ?? undefined;
    const warsValue = interaction.options.getInteger("wars", false) ?? undefined;
    const clanValue = interaction.options.getString("clan", false) ?? undefined;

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
      await runCombinedMode(interaction, cocService, daysValue, warsValue, clanValue);
      return;
    }
    if (daysValue) {
      await runDaysMode(interaction, cocService, daysValue, clanValue);
      return;
    }
    await runWarsMode(interaction, warsValue!, clanValue);
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const choices = await buildInactiveWarClanAutocompleteChoices(query);
    await interaction.respond(choices);
  },
};


