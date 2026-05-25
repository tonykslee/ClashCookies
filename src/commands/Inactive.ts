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
import { formatClanBadgeEmoji } from "../helper/clanBadgeEmoji";
import {
  normalizeTownHallLevel,
  renderTownHallIcon,
  resolveTownHallEmojiMap,
  type TownHallEmojiMap,
} from "../helper/townHallEmoji";
import { listPlayerLinksForClanMembers } from "../services/PlayerLinkService";
import { normalizeClanTag } from "../services/PlayerLinkService";

const DEFAULT_STALE_HOURS = 6;
const DEFAULT_MIN_COVERAGE = 0.8;
const MAX_LINES_PER_PAGE = 24;
const MAX_DESCRIPTION_LENGTH = 3900;
type InactiveDisplayMode = "tag" | "weight";

function normalizeClanTagInput(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function formatInactiveClanTag(tag: string): string {
  const normalized = normalizeClanTagInput(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function formatInactiveClanBadge(badge: string | null | undefined): string | null {
  return formatClanBadgeEmoji(badge);
}

function formatInactivePlayerTag(tag: string): string {
  const normalized = normalizeClanTagInput(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCompactWeightK(weight: number | null | undefined): string {
  const normalized = normalizePositiveInteger(weight);
  if (normalized === null) return "\u2014";
  if (normalized < 1000) return String(normalized);
  return `${Math.trunc(normalized / 1000)}k`;
}

function filterConsecutiveInactiveRows<T extends { lastSeenAt: Date }>(
  rows: T[],
  cutoff: Date,
  consecutive?: boolean,
): T[] {
  if (!consecutive) return rows;
  const cutoffMs = cutoff.getTime();
  return rows.filter((row) => row.lastSeenAt.getTime() < cutoffMs);
}

function formatInactivePlayerIdentity(input: {
  townHallIcon: string;
  playerName: string;
  displayValue: string;
  discordText: string;
}): string {
  const normalizedName = String(input.playerName ?? "").trim() || input.displayValue;
  return `${input.townHallIcon} ${normalizedName} \`${input.displayValue}\` ${input.discordText}`;
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

async function loadInactiveDisplayWeightsByTags(tags: string[]): Promise<Map<string, number>> {
  const normalizedTags = [...new Set(tags.map((tag) => normalizeClanTagInput(tag)).filter(Boolean))];
  if (normalizedTags.length === 0) return new Map();

  const [memberRows, catalogRows, currentRows] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: { playerTag: { in: normalizedTags } },
      orderBy: [{ playerTag: "asc" }, { sourceSyncedAt: "desc" }, { clanTag: "asc" }],
      select: {
        playerTag: true,
        weight: true,
        sourceSyncedAt: true,
      },
    }),
    prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: normalizedTags } },
      orderBy: [{ playerTag: "asc" }],
      select: {
        playerTag: true,
        latestKnownWeight: true,
        lastSyncedAt: true,
      },
    }),
    prisma.playerCurrent.findMany({
      where: { playerTag: { in: normalizedTags } },
      orderBy: [{ playerTag: "asc" }],
      select: {
        playerTag: true,
        currentWeight: true,
        updatedAt: true,
      },
    }),
  ]);

  const weightByTag = new Map<string, number>();
  for (const row of memberRows) {
    const playerTag = normalizeClanTagInput(row.playerTag);
    if (!playerTag || weightByTag.has(playerTag)) continue;
    const weight = normalizePositiveInteger(row.weight);
    if (weight !== null) weightByTag.set(playerTag, weight);
  }

  for (const row of catalogRows) {
    const playerTag = normalizeClanTagInput(row.playerTag);
    if (!playerTag || weightByTag.has(playerTag)) continue;
    const weight = normalizePositiveInteger(row.latestKnownWeight);
    if (weight !== null) weightByTag.set(playerTag, weight);
  }

  for (const row of currentRows) {
    const playerTag = normalizeClanTagInput(row.playerTag);
    if (!playerTag || weightByTag.has(playerTag)) continue;
    const weight = normalizePositiveInteger(row.currentWeight);
    if (weight !== null) weightByTag.set(playerTag, weight);
  }

  return weightByTag;
}

function buildInactivePlayerDisplayValue(
  mode: InactiveDisplayMode,
  playerTag: string,
  weightByTag: Map<string, number>,
): string {
  if (mode === "tag") return formatInactivePlayerTag(playerTag);
  const normalizedTag = normalizeClanTagInput(playerTag);
  return formatCompactWeightK(weightByTag.get(normalizedTag) ?? null);
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

async function loadInactiveDiscordLinksForTags(tags: string[]): Promise<Map<string, string>> {
  const orderedTags = [...new Set(tags.map((tag) => formatInactivePlayerTag(tag)))];
  const links = await listPlayerLinksForClanMembers({ memberTagsInOrder: orderedTags });
  const discordUserIdByPlayerTag = new Map<string, string>();
  for (const link of links ?? []) {
    const normalizedTag = normalizeClanTagInput(link.playerTag);
    if (!normalizedTag) continue;
    discordUserIdByPlayerTag.set(normalizedTag, link.discordUserId);
  }
  return discordUserIdByPlayerTag;
}

function buildInactivePlayerDiscordText(
  discordUserIdByPlayerTag: Map<string, string>,
  playerTag: string,
): string {
  const discordUserId = discordUserIdByPlayerTag.get(normalizeClanTagInput(playerTag)) ?? null;
  return discordUserId ? `<@${discordUserId}>` : "\u2014";
}

async function loadInactiveWarDiscordLinks(
  rows: InactiveWarSummary["results"],
): Promise<Map<string, string>> {
  return loadInactiveDiscordLinksForTags(rows.map((row) => row.playerTag));
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
  trackedBadgeByTag: Map<string, string | null>;
  discordUserIdByPlayerTag: Map<string, string>;
  townHallEmojiByLevel: TownHallEmojiMap;
  requestedWars: number;
  displayMode: InactiveDisplayMode;
  weightByPlayerTag: Map<string, number>;
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
    const clanBadge = formatInactiveClanBadge(
      input.trackedBadgeByTag.get(clanTag) ?? input.trackedBadgeByTag.get(trackedTag) ?? null,
    );
    lines.push(`${clanBadge ? `${clanBadge} ` : ""}${clanName} (${clanRows.length})`);

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
        const discordText = buildInactivePlayerDiscordText(
          input.discordUserIdByPlayerTag,
          row.playerTag,
        );
        const emojiSequence = buildInactiveWarEmojiSequence(row.missedWarStates);
        const townHallIcon = renderTownHallIcon(row.townHall, input.townHallEmojiByLevel);
        const displayValue = buildInactivePlayerDisplayValue(
          input.displayMode,
          row.playerTag,
          input.weightByPlayerTag,
        );
        const rowText = ratioText
          ? `  - ${formatInactivePlayerIdentity({
              townHallIcon,
              playerName: row.playerName,
              displayValue,
              discordText,
            })} - ${ratioText} - ${emojiSequence}`
          : `  - ${formatInactivePlayerIdentity({
              townHallIcon,
              playerName: row.playerName,
              displayValue,
              discordText,
            })} - ${emojiSequence}`;
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
  trackedBadgeByTag: Map<string, string | null>;
  liveMemberTags: Set<string>;
  liveMembersByClan: Map<string, Set<string>>;
  liveMemberClanByTag: Map<string, string>;
  liveMemberTrackedClanByTag: Map<string, string>;
  liveMemberTownHallByTag: Map<string, number | null>;
};

type InactiveCurrentMembershipSnapshot = {
  trackedTags: string[];
  trackedNameByTag: Map<string, string>;
  trackedBadgeByTag: Map<string, string | null>;
  currentSnapshotAvailableClanTags: Set<string>;
  currentMemberPlayerTagsByClanTag: Map<string, Set<string>>;
  currentMemberNameByClanAndPlayerTag: Map<string, string>;
  currentMemberTownHallByClanAndPlayerTag: Map<string, number | null>;
};

function buildPaginationRow(
  customIdPrefix: string,
  displayMode: InactiveDisplayMode,
  page: number,
  totalPages: number,
) {
  const toggleLabel = displayMode === "tag" ? "Show weights" : "Show tags";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:toggle`)
      .setLabel(toggleLabel)
      .setStyle(ButtonStyle.Secondary),
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
    select: { tag: true, name: true, clanBadge: true },
  });
  const normalizedClanFilter = normalizeClanTagInput(clanTag ?? "");
  const scopedTracked = normalizedClanFilter
    ? dbTracked.filter((c) => normalizeClanTagInput(c.tag) === normalizedClanFilter)
    : dbTracked;
  const trackedTags = scopedTracked.map((c) => c.tag);
  const trackedNameByTag = new Map(scopedTracked.map((c) => [c.tag, c.name?.trim() || c.tag]));
  const trackedBadgeByTag = new Map(
    scopedTracked.map((c) => [c.tag, formatInactiveClanBadge(c.clanBadge)] as const),
  );

  const liveMemberTags = new Set<string>();
  const liveMembersByClan = new Map<string, Set<string>>();
  const liveMemberClanByTag = new Map<string, string>();
  const liveMemberTrackedClanByTag = new Map<string, string>();
  const liveMemberTownHallByTag = new Map<string, number | null>();
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
        const townHall = normalizeTownHallLevel(
          member?.townHall ?? member?.townHallLevel ?? member?.townhallLevel,
        );
        liveMemberTownHallByTag.set(memberTag, townHall);
      }
      liveMembersByClan.set(trackedTag, memberSet);
    } catch (err) {
      console.error(`inactive: failed to fetch live roster for ${trackedTag}: ${formatError(err)}`);
    }
  }

  return {
    trackedTags,
    trackedNameByTag,
    trackedBadgeByTag,
    liveMemberTags,
    liveMembersByClan,
    liveMemberClanByTag,
    liveMemberTrackedClanByTag,
    liveMemberTownHallByTag,
  };
}

function buildTrackedClanTagQueryValues(trackedTags: string[]): string[] {
  return [...new Set(trackedTags.flatMap((tag) => [tag, `#${tag}`]))];
}

async function loadInactiveCurrentMembershipSnapshot(
  clanTag?: string | null,
): Promise<InactiveCurrentMembershipSnapshot> {
  const dbTracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, clanBadge: true },
  });
  const normalizedClanFilter = normalizeClanTagInput(clanTag ?? "");
  const scopedTracked = normalizedClanFilter
    ? dbTracked.filter((c) => normalizeClanTagInput(c.tag) === normalizedClanFilter)
    : dbTracked;
  const trackedTags = scopedTracked.map((c) => c.tag);
  const trackedNameByTag = new Map<string, string>();
  const trackedBadgeByTag = new Map<string, string | null>();
  for (const clan of scopedTracked) {
    const clanTag = normalizeClanTagInput(clan.tag);
    if (!clanTag) continue;
    const clanName = clan.name?.trim() || clanTag;
    const clanBadge = formatInactiveClanBadge(clan.clanBadge);
    trackedNameByTag.set(clan.tag, clanName);
    trackedNameByTag.set(clanTag, clanName);
    trackedNameByTag.set(`#${clanTag}`, clanName);
    trackedBadgeByTag.set(clan.tag, clanBadge);
    trackedBadgeByTag.set(clanTag, clanBadge);
    trackedBadgeByTag.set(`#${clanTag}`, clanBadge);
  }

  if (trackedTags.length === 0) {
    return {
      trackedTags: [],
      trackedNameByTag,
      trackedBadgeByTag,
      currentSnapshotAvailableClanTags: new Set(),
      currentMemberPlayerTagsByClanTag: new Map(),
      currentMemberNameByClanAndPlayerTag: new Map(),
      currentMemberTownHallByClanAndPlayerTag: new Map(),
    };
  }

  const currentMemberRows = await prisma.fwaClanMemberCurrent.findMany({
    where: {
      clanTag: { in: buildTrackedClanTagQueryValues(trackedTags) },
    },
    orderBy: [{ clanTag: "asc" }, { sourceSyncedAt: "desc" }, { playerTag: "asc" }],
    select: {
      clanTag: true,
      playerTag: true,
      playerName: true,
      townHall: true,
      sourceSyncedAt: true,
    },
  });

  const currentSnapshotAvailableClanTags = new Set<string>();
  const currentMemberPlayerTagsByClanTag = new Map<string, Set<string>>();
  const currentMemberNameByClanAndPlayerTag = new Map<string, string>();
  const currentMemberTownHallByClanAndPlayerTag = new Map<string, number | null>();
  const latestSourceByClanAndPlayer = new Map<string, Date>();

  for (const row of currentMemberRows as Array<{
    clanTag: string;
    playerTag: string;
    playerName: string | null;
    townHall: number | null;
    sourceSyncedAt: Date;
  }>) {
    const clanTagValue = normalizeClanTagInput(row.clanTag);
    const playerTagValue = normalizeClanTagInput(row.playerTag);
    if (!clanTagValue || !playerTagValue) continue;
    currentSnapshotAvailableClanTags.add(clanTagValue);
    const key = `${clanTagValue}:${playerTagValue}`;
    const existingSource = latestSourceByClanAndPlayer.get(key) ?? null;
    if (existingSource && existingSource >= row.sourceSyncedAt) continue;
    latestSourceByClanAndPlayer.set(key, row.sourceSyncedAt);
    const currentPlayerTags = currentMemberPlayerTagsByClanTag.get(clanTagValue) ?? new Set<string>();
    currentPlayerTags.add(playerTagValue);
    currentMemberPlayerTagsByClanTag.set(clanTagValue, currentPlayerTags);
    currentMemberNameByClanAndPlayerTag.set(
      key,
      String(row.playerName ?? "").trim() || playerTagValue,
    );
    currentMemberTownHallByClanAndPlayerTag.set(
      key,
      Number.isFinite(Number(row.townHall)) ? Math.trunc(Number(row.townHall)) : null,
    );
  }

  return {
    trackedTags,
    trackedNameByTag,
    trackedBadgeByTag,
    currentSnapshotAvailableClanTags,
    currentMemberPlayerTagsByClanTag,
    currentMemberNameByClanAndPlayerTag,
    currentMemberTownHallByClanAndPlayerTag,
  };
}

type InactiveDaysEntry = {
  clanTag: string;
  clanName: string;
  clanBadge: string | null;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  daysAgo: number;
};

const inactiveWarService = new InactiveWarService();

async function fetchInactiveDaysEntries(
  interaction: ChatInputCommandInteraction,
  days: number,
  clanTag?: string | null,
  consecutive?: boolean,
  inClan?: boolean,
): Promise<{
  entries: InactiveDaysEntry[];
  roster: InactiveCurrentMembershipSnapshot;
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
  const roster = await loadInactiveCurrentMembershipSnapshot(clanTag);

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

  const scopedClanTagValues = buildTrackedClanTagQueryValues(scopedTrackedTags);
  const currentMemberTagList = [...new Set(
    [...roster.currentMemberPlayerTagsByClanTag.values()].flatMap((set) => [...set])
  )];
  const activitySnapshot = await prisma.playerActivity.aggregate({
    where: {
      guildId: interaction.guildId,
      tag: { in: currentMemberTagList },
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
      tag: { in: currentMemberTagList },
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
  const currentMemberCount = [...roster.currentMemberPlayerTagsByClanTag.values()].reduce(
    (total, set) => total + set.size,
    0,
  );
  const observationCoverage = currentMemberCount > 0 ? freshObservedCount / currentMemberCount : 0;
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
      clanTag: { in: scopedClanTagValues },
    },
    orderBy: [{ clanTag: "asc" }, { lastSeenAt: "asc" }, { tag: "asc" }],
  });
  const filteredInactivePlayers = filterConsecutiveInactiveRows(
    inactivePlayers,
    cutoff,
    consecutive,
  );
  const currentMemberNameByClanAndPlayerTag = roster.currentMemberNameByClanAndPlayerTag;
  const currentMemberTownHallByClanAndPlayerTag = roster.currentMemberTownHallByClanAndPlayerTag;

  const entries = filteredInactivePlayers
    .map((p) => {
      const clanTag = normalizeClanTagInput(p.clanTag ?? "");
      const normalizedClanTag = clanTag ? `#${normalizeClanTagInput(clanTag)}` : "Unknown Clan";
      const playerTag = normalizeClanTagInput(p.tag);
      const membershipKey = `${clanTag}:${playerTag}`;
      const snapshotAvailable = roster.currentSnapshotAvailableClanTags.has(clanTag);
      const isCurrentMember =
        snapshotAvailable &&
        (roster.currentMemberPlayerTagsByClanTag.get(clanTag)?.has(playerTag) ?? false);
      const shouldInclude = inClan === false ? snapshotAvailable && !isCurrentMember : isCurrentMember;
      if (!shouldInclude) return null;
      return {
        clanTag: normalizedClanTag,
        clanName:
          roster.trackedNameByTag.get(normalizedClanTag) ?? p.clanName ?? p.clanTag ?? "Unknown Clan",
        clanBadge: roster.trackedBadgeByTag.get(normalizedClanTag) ?? null,
        playerTag: p.tag,
        playerName: currentMemberNameByClanAndPlayerTag.get(membershipKey) ?? p.name ?? p.tag,
        townHall: currentMemberTownHallByClanAndPlayerTag.get(membershipKey) ?? null,
        daysAgo: Math.floor((Date.now() - p.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)),
      };
    })
    .filter((entry): entry is InactiveDaysEntry => entry !== null);

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
  consecutive?: boolean,
  inClan?: boolean,
): Promise<InactiveWarSummary> {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server.");
  }
  const summary = await inactiveWarService.listInactiveWarPlayers({
    guildId: interaction.guildId,
    wars,
    clanTag,
    consecutive,
  });
  const membership = await loadInactiveCurrentMembershipSnapshot(clanTag);
  if (summary.results.length === 0) {
    return summary;
  }

  const filteredResults = summary.results.filter((row) => {
    const clanTagValue = normalizeClanTagInput(row.clanTag);
    const playerTagValue = normalizeClanTagInput(row.playerTag);
    const snapshotAvailable = membership.currentSnapshotAvailableClanTags.has(clanTagValue);
    const isCurrentMember =
      snapshotAvailable &&
      (membership.currentMemberPlayerTagsByClanTag.get(clanTagValue)?.has(playerTagValue) ?? false);
    return inClan === false ? snapshotAvailable && !isCurrentMember : isCurrentMember;
  });

  return {
    ...summary,
    results: filteredResults,
  };
}

async function renderEmbedsWithPager(
  interaction: ChatInputCommandInteraction,
  title: string,
  pagesByMode: Record<InactiveDisplayMode, string[]>,
  footerSuffix = ""
): Promise<void> {
  const embedsByMode = {
    tag: pagesByMode.tag.map(
      (content, idx) =>
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(
            content.length > MAX_DESCRIPTION_LENGTH
              ? `${content.slice(0, MAX_DESCRIPTION_LENGTH - 20)}\n...truncated`
              : content,
          )
          .setFooter({ text: `Page ${idx + 1}/${pagesByMode.tag.length}${footerSuffix}` }),
    ),
    weight: pagesByMode.weight.map(
      (content, idx) =>
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(
            content.length > MAX_DESCRIPTION_LENGTH
              ? `${content.slice(0, MAX_DESCRIPTION_LENGTH - 20)}\n...truncated`
              : content,
          )
          .setFooter({ text: `Page ${idx + 1}/${pagesByMode.weight.length}${footerSuffix}` }),
    ),
  };

  let displayMode: InactiveDisplayMode = "tag";
  const pageByMode: Record<InactiveDisplayMode, number> = { tag: 0, weight: 0 };
  const customIdPrefix = `inactive:${interaction.id}`;
  const usePagination = pagesByMode.tag.length > 1 || pagesByMode.weight.length > 1;
  const getCurrentPages = () => pagesByMode[displayMode];
  const getCurrentPage = () =>
    Math.min(pageByMode[displayMode], Math.max(0, getCurrentPages().length - 1));
  const buildComponents = () =>
    usePagination ? [buildPaginationRow(customIdPrefix, displayMode, getCurrentPage(), getCurrentPages().length)] : [];
  const reply = await interaction.editReply({
    embeds: [embedsByMode[displayMode][getCurrentPage()]],
    components: buildComponents(),
  });

  if (!usePagination) return;

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 5 * 60 * 1000,
    filter: (btn) =>
      btn.user.id === interaction.user.id &&
      [
        `${customIdPrefix}:prev`,
        `${customIdPrefix}:next`,
        `${customIdPrefix}:toggle`,
      ].includes(btn.customId),
  });

  collector.on("collect", async (btn) => {
    if (btn.customId.endsWith(":toggle")) {
      displayMode = displayMode === "tag" ? "weight" : "tag";
      pageByMode[displayMode] = Math.min(
        pageByMode[displayMode],
        Math.max(0, getCurrentPages().length - 1),
      );
    } else if (btn.customId.endsWith(":prev")) {
      pageByMode[displayMode] = Math.max(0, getCurrentPage() - 1);
    } else if (btn.customId.endsWith(":next")) {
      pageByMode[displayMode] = Math.min(getCurrentPages().length - 1, getCurrentPage() + 1);
    }

    await btn.update({
      embeds: [embedsByMode[displayMode][getCurrentPage()]],
      components: buildComponents(),
    });
  });

  collector.on("end", async () => {
    await interaction
      .editReply({
        embeds: [embedsByMode[displayMode][getCurrentPage()]],
        components: [],
      })
      .catch(() => undefined);
  });
}

function buildGroupedPages<T>(
  entries: T[],
  getClanKey: (entry: T) => string,
  getClanName: (entry: T) => string,
  getClanBadge: (entry: T) => string | null,
  renderLine: (entry: T) => string,
): string[] {
  const clanCounts = new Map<string, number>();
  const clanFirstEntry = new Map<string, T>();
  for (const entry of entries) {
    const clanKey = normalizeClanTagInput(getClanKey(entry));
    clanCounts.set(clanKey, (clanCounts.get(clanKey) ?? 0) + 1);
    if (!clanFirstEntry.has(clanKey)) clanFirstEntry.set(clanKey, entry);
  }

  const pages: string[] = [];
  let currentLines: string[] = [];
  let currentClan: string | null = null;
  const clanPageCounts = new Map<string, number>();

  for (const entry of entries) {
    const clanKey = normalizeClanTagInput(getClanKey(entry));
    const clanName = getClanName(entry);
    const isNewClan = currentClan !== clanKey;
    if (isNewClan) {
      const continuationCount = clanPageCounts.get(clanKey) ?? 0;
      const clanBadge = getClanBadge(clanFirstEntry.get(clanKey) ?? entry);
      const header =
        continuationCount === 0
          ? `**${clanBadge ? `${clanBadge} ` : ""}${clanName} (${clanCounts.get(clanKey) ?? 0})**`
          : `**${clanBadge ? `${clanBadge} ` : ""}${clanName} (${clanCounts.get(clanKey) ?? 0}) (cont.)**`;

      const projectedLines = currentLines.length + (currentLines.length > 0 ? 2 : 1);
      if (projectedLines > MAX_LINES_PER_PAGE) {
        pages.push(currentLines.join("\n"));
        currentLines = [];
      }

      if (currentLines.length > 0) currentLines.push("");
      currentLines.push(header);
      currentClan = clanKey;
      clanPageCounts.set(clanKey, continuationCount + 1);
    }

    const line = renderLine(entry);
    if (currentLines.length + 1 > MAX_LINES_PER_PAGE) {
      pages.push(currentLines.join("\n"));
      currentLines = [
        `**${getClanBadge(entry) ? `${getClanBadge(entry)} ` : ""}${clanName} (${clanCounts.get(clanKey) ?? 0}) (cont.)**`,
        line,
      ];
      currentClan = clanKey;
      clanPageCounts.set(clanKey, (clanPageCounts.get(clanKey) ?? 0) + 1);
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
  townHallEmojiByLevel: TownHallEmojiMap,
  days: number,
  clanTag?: string | null,
  consecutive?: boolean,
  inClan?: boolean,
): Promise<void> {
  const daysResult = await fetchInactiveDaysEntries(interaction, days, clanTag, consecutive, inClan);
  const { entries, roster } = daysResult;
  if (roster.trackedTags.length === 0) {
    if (clanTag) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag)}. Configure at least one tracked clan with \`/clan configure\` before using \`/inactive\` in wars or days mode.`
      );
      return;
    }
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/clan configure` before using `/inactive`."
    );
    return;
  }

  if (entries.length === 0) {
    await interaction.editReply(
      clanTag && daysResult.scopeClanName
        ? `No inactive players for ${days}+ days in ${daysResult.scopeClanName}.`
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

  const sortedEntries = [...entries].sort((a, b) => {
    const orderA = clanOrder.get(a.clanName) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(b.clanName) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    if (a.clanName !== b.clanName) return a.clanName.localeCompare(b.clanName);
    return a.daysAgo - b.daysAgo;
  });

  const daysDiscordUserIdByPlayerTag = await loadInactiveDiscordLinksForTags(
    sortedEntries.map((player) => player.playerTag)
  );
  const daysDisplayWeightByPlayerTag = await loadInactiveDisplayWeightsByTags(
    sortedEntries.map((player) => player.playerTag),
  );
  const tagPages = buildGroupedPages(
    sortedEntries,
    (e) => e.clanTag,
    (e) => e.clanName,
    (e) => e.clanBadge,
    (e) => {
      const discordText = buildInactivePlayerDiscordText(daysDiscordUserIdByPlayerTag, e.playerTag);
      const townHallIcon = renderTownHallIcon(e.townHall, townHallEmojiByLevel);
      return `- ${formatInactivePlayerIdentity({
        townHallIcon,
        playerName: e.playerName,
        displayValue: buildInactivePlayerDisplayValue("tag", e.playerTag, daysDisplayWeightByPlayerTag),
        discordText,
      })} - ${e.daysAgo}d`;
    }
  );
  const weightPages = buildGroupedPages(
    sortedEntries,
    (e) => e.clanTag,
    (e) => e.clanName,
    (e) => e.clanBadge,
    (e) => {
      const discordText = buildInactivePlayerDiscordText(daysDiscordUserIdByPlayerTag, e.playerTag);
      const townHallIcon = renderTownHallIcon(e.townHall, townHallEmojiByLevel);
      return `- ${formatInactivePlayerIdentity({
        townHallIcon,
        playerName: e.playerName,
        displayValue: buildInactivePlayerDisplayValue("weight", e.playerTag, daysDisplayWeightByPlayerTag),
        discordText,
      })} - ${e.daysAgo}d`;
    }
  );

  const currentMemberCount = [...roster.currentMemberPlayerTagsByClanTag.values()].reduce(
    (total, set) => total + set.size,
    0,
  );
  const summary = ` • Scope: ${roster.trackedTags.length} tracked clan(s), ${currentMemberCount} current member(s), ${daysResult.observedRecordCount} observed record(s), ${daysResult.freshObservedCount} fresh in last ${daysResult.staleHours}h`;
  await renderEmbedsWithPager(
    interaction,
    `Inactive for ${days}+ days (${entries.length})`,
    { tag: tagPages, weight: weightPages },
    summary
  );
}

async function runWarsMode(
  interaction: ChatInputCommandInteraction,
  townHallEmojiByLevel: TownHallEmojiMap,
  wars: number,
  clanTag?: string | null,
  consecutive?: boolean,
  inClan?: boolean,
): Promise<void> {
  const { results, trackedTags, trackedNameByTag, trackedBadgeByTag, warnings, diagnosticNote } =
    await fetchInactiveWarEntries(interaction, wars, clanTag, consecutive, inClan);

  if (trackedTags.length === 0) {
    if (diagnosticNote || warnings.length > 0) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag ?? "")}.${
          diagnosticNote ? `\n\n${diagnosticNote}` : ""
        }`
      );
    } else {
      await interaction.editReply(
        "No tracked clans configured. Configure at least one clan with `/clan configure` before using `/inactive`."
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
  const weightByPlayerTag = await loadInactiveDisplayWeightsByTags(
    sortedResults.map((row) => row.playerTag),
  );
  const tagPages = buildInactiveWarGroupedPages({
    rows: sortedResults,
    trackedTags,
    trackedNameByTag,
    trackedBadgeByTag,
    discordUserIdByPlayerTag,
    townHallEmojiByLevel,
    requestedWars: wars,
    displayMode: "tag",
    weightByPlayerTag,
  });
  const weightPages = buildInactiveWarGroupedPages({
    rows: sortedResults,
    trackedTags,
    trackedNameByTag,
    trackedBadgeByTag,
    discordUserIdByPlayerTag,
    townHallEmojiByLevel,
    requestedWars: wars,
    displayMode: "weight",
    weightByPlayerTag,
  });

  const footerSuffix = warnings.length > 0 ? ` � Partial data: ${warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Missed Both Attacks - Last ${wars} War(s) (${results.length})`,
    { tag: tagPages, weight: weightPages },
    footerSuffix
  );
}

async function runCombinedMode(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
  townHallEmojiByLevel: TownHallEmojiMap,
  days: number,
  wars: number,
  clanTag?: string | null,
  consecutive?: boolean,
  inClan?: boolean,
): Promise<void> {
  const daysResult = await fetchInactiveDaysEntries(interaction, days, clanTag, consecutive, inClan);
  const warsResult = await fetchInactiveWarEntries(interaction, wars, clanTag, consecutive, inClan);

  if (!daysResult.roster || daysResult.roster.trackedTags.length === 0 || warsResult.trackedTags.length === 0) {
    if (clanTag && warsResult.diagnosticNote) {
      await interaction.editReply(
        `No tracked clan matched ${formatInactiveClanTag(clanTag)}.\n\n${warsResult.diagnosticNote}`
      );
      return;
    }
    await interaction.editReply(
      "No tracked clans configured. Configure at least one clan with `/clan configure` before using `/inactive`."
    );
    return;
  }

  const combined = new Map<
    string,
    {
      clanTag: string;
      clanName: string;
      clanBadge: string | null;
      playerTag: string;
      playerName: string;
      townHall: number | null;
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
      clanBadge: entry.clanBadge,
      playerTag: entry.playerTag,
      playerName: entry.playerName,
      townHall: entry.townHall,
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
      clanBadge: warsResult.trackedBadgeByTag.get(entry.clanTag) ?? null,
      playerTag: entry.playerTag,
      playerName: existing?.playerName ?? entry.playerName,
      townHall: entry.townHall ?? existing?.townHall ?? null,
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
  daysResult.roster.trackedTags.forEach((tag, i) => clanOrder.set(normalizeClanTagInput(tag), i));
  rows.sort((a, b) => {
    const orderA = clanOrder.get(normalizeClanTagInput(a.clanTag)) ?? Number.MAX_SAFE_INTEGER;
    const orderB = clanOrder.get(normalizeClanTagInput(b.clanTag)) ?? Number.MAX_SAFE_INTEGER;
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

  const warsDiscordUserIdByPlayerTag = await loadInactiveDiscordLinksForTags(
    rows.map((row) => row.playerTag)
  );
  const displayWeightByPlayerTag = await loadInactiveDisplayWeightsByTags(
    rows.map((row) => row.playerTag),
  );
  const tagPages = buildGroupedPages(
    rows,
    (e) => e.clanTag,
    (e) => e.clanName,
    (e) => e.clanBadge,
    (e) => {
      const reasons: string[] = [];
      if (e.daysAgo !== null) reasons.push(`${e.daysAgo}d inactive`);
      if (e.missedWars !== null) {
        reasons.push(`missed both in ${e.missedWars}/${e.participationWars ?? 0} war(s)`);
      }
      const warsRow = warsResult.results.find(
        (row) => normalizeClanTagInput(row.playerTag) === normalizeClanTagInput(e.playerTag),
      );
      const discordText = buildInactivePlayerDiscordText(
        warsDiscordUserIdByPlayerTag,
        e.playerTag
      );
      const emojiSequence = warsRow ? buildInactiveWarEmojiSequence(warsRow.missedWarStates) : "";
      const townHallIcon = renderTownHallIcon(e.townHall, townHallEmojiByLevel);
      const reasonText = reasons.length > 0 ? ` - ${reasons.join(" | ")}` : "";
      const emojiText = warsRow ? ` - ${emojiSequence}` : "";
      return `- ${formatInactivePlayerIdentity({
        townHallIcon,
        playerName: e.playerName,
        displayValue: buildInactivePlayerDisplayValue("tag", e.playerTag, displayWeightByPlayerTag),
        discordText,
      })}${reasonText}${emojiText}`;
    }
  );
  const weightPages = buildGroupedPages(
    rows,
    (e) => e.clanTag,
    (e) => e.clanName,
    (e) => e.clanBadge,
    (e) => {
      const reasons: string[] = [];
      if (e.daysAgo !== null) reasons.push(`${e.daysAgo}d inactive`);
      if (e.missedWars !== null) {
        reasons.push(`missed both in ${e.missedWars}/${e.participationWars ?? 0} war(s)`);
      }
      const warsRow = warsResult.results.find(
        (row) => normalizeClanTagInput(row.playerTag) === normalizeClanTagInput(e.playerTag),
      );
      const discordText = buildInactivePlayerDiscordText(
        warsDiscordUserIdByPlayerTag,
        e.playerTag
      );
      const emojiSequence = warsRow ? ` - ${buildInactiveWarEmojiSequence(warsRow.missedWarStates)}` : "";
      const townHallIcon = renderTownHallIcon(e.townHall, townHallEmojiByLevel);
      const reasonText = reasons.length > 0 ? ` - ${reasons.join(" | ")}` : "";
      const weightDisplayValue = buildInactivePlayerDisplayValue(
        "weight",
        e.playerTag,
        displayWeightByPlayerTag,
      );
      return `- ${formatInactivePlayerIdentity({
        townHallIcon,
        playerName: e.playerName,
        displayValue: weightDisplayValue,
        discordText,
      })}${reasonText}${emojiSequence}`;
    }
  );

  const footerSuffix = warsResult.warnings.length > 0 ? ` • Partial war data: ${warsResult.warnings.length} clan(s)` : "";
  await renderEmbedsWithPager(
    interaction,
    `Inactive Players - Days ${days} + Wars ${wars} (${rows.length})`,
    { tag: tagPages, weight: weightPages },
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
      name: "consecutive",
      description: "Only include players inactive across the full requested window",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
    {
      name: "in-clan",
      description: "Only include players currently in the tracked clan",
      type: ApplicationCommandOptionType.Boolean,
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
    client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    const townHallEmojiByLevel = await resolveTownHallEmojiMap(client);

    const daysValue = interaction.options.getInteger("days", false) ?? undefined;
    const warsValue = interaction.options.getInteger("wars", false) ?? undefined;
    const consecutiveValue = interaction.options.getBoolean("consecutive", false) ?? undefined;
    const inClanValue = interaction.options.getBoolean("in-clan", false);
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
      await runCombinedMode(
        interaction,
        cocService,
        townHallEmojiByLevel,
        daysValue,
        warsValue,
        clanValue,
        consecutiveValue,
        inClanValue ?? true,
      );
      return;
    }
    if (daysValue) {
      await runDaysMode(
        interaction,
        cocService,
        townHallEmojiByLevel,
        daysValue,
        clanValue,
        consecutiveValue,
        inClanValue ?? true,
      );
      return;
    }
    await runWarsMode(
      interaction,
      townHallEmojiByLevel,
      warsValue!,
      clanValue,
      consecutiveValue,
      inClanValue ?? true,
    );
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

