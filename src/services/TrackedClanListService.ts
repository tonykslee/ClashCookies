import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
} from "discord.js";
import { formatError } from "../helper/formatError";
import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { prisma } from "../prisma";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import { emojiResolverService } from "./emoji/EmojiResolverService";
import {
  refreshCwlTrackedClanMetadataForSeason,
  resolveCurrentCwlSeasonKey,
} from "./CwlRegistryService";
import { cwlEventResolutionService } from "./CwlEventResolutionService";
import { listTrackedClanRepTagsForClanTags } from "./TrackedClanRepService";

export type FwaTrackedClanDisplayRow = {
  tag: string;
  name: string | null;
  loseStyle: string;
  mailChannelId: string | null;
  logChannelId: string | null;
  leaderChannelId: string | null;
  clanRoleId: string | null;
  leadRoleId: string | null;
  clanBadge: string | null;
  shortName: string | null;
  repPlayerTags?: string[];
  createdAt: Date;
};

export type FwaTrackedClanMinimalListState = {
  trackedClans: FwaTrackedClanDisplayRow[];
  refreshTags: string[];
  memberCountByTag: Map<string, number>;
};

export type FwaTrackedClanMinimalListRenderInput = {
  refreshPrefix: string;
  trackedClans: FwaTrackedClanDisplayRow[];
  memberCountByTag: Map<string, number>;
  refreshing: boolean;
};

export type FwaTrackedClanMinimalListRender = {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
};

export type CwlTrackedClanSpinStatus = "idle" | "searching" | "matched";

export type CwlTrackedClanDetailedDisplayRow = {
  season: string;
  tag: string;
  name: string | null;
  leagueLabel: string | null;
  spinStatus: CwlTrackedClanSpinStatus;
  observedCwlRosterCount: number;
  currentClanMemberCount: number | null;
  rosterTitle: string | null;
  rosterPostedMessageUrl: string | null;
};

export type RefreshCwlTrackedClanDetailedDisplayResult = {
  season: string;
  displayedClanCount: number;
  failedClanCount: number;
  failedClanTags: string[];
  metadataHydratedCount: number;
  metadataSkippedCount: number;
  matchedCount: number;
  searchingCount: number;
  idleCount: number;
  rows: CwlTrackedClanDetailedDisplayRow[];
};

type CwlTrackedClanRosterLifecycleState = "OPEN" | "ACTIVE" | "CLOSED";

type CwlTrackedClanRosterRow = {
  id: string;
  title: string;
  clanTag: string | null;
  lifecycleState: CwlTrackedClanRosterLifecycleState | "ARCHIVED";
  postedMessageUrl: string | null;
  postedAt: Date | null;
  createdAt: Date;
};

const CWL_LEAGUE_EMOJI_BY_LABEL = new Map<string, string>([
  ["BRONZE LEAGUE III", "<:CWL_Bronze_3:1511515164216660078>"],
  ["BRONZE LEAGUE II", "<:CWL_Bronze_2:1511515163126268074>"],
  ["BRONZE LEAGUE I", "<:CWL_Bronze_1:1511515161934954566>"],
  ["SILVER LEAGUE III", "<:CWL_Silver_3:1511515184915808256>"],
  ["SILVER LEAGUE II", "<:CWL_Silver_2:1511515183804055753>"],
  ["SILVER LEAGUE I", "<:CWL_Silver_1:1511515182872924340>"],
  ["GOLD LEAGUE III", "<:CWL_Gold_3:1511515177789427842>"],
  ["GOLD LEAGUE II", "<:CWL_Gold_2:1511515176640188556>"],
  ["GOLD LEAGUE I", "<:CWL_Gold_1:1511515175478628413>"],
  ["CRYSTAL LEAGUE III", "<:CWL_Crystal_3:1511515174505287860>"],
  ["CRYSTAL LEAGUE II", "<:CWL_Crystal_2:1511515173012111451>"],
  ["CRYSTAL LEAGUE I", "<:CWL_Crystal_1:1511515171393241222>"],
  ["MASTER LEAGUE III", "<:CWL_Master_3:1511515181396791301>"],
  ["MASTER LEAGUE II", "<:CWL_Master_2:1511515180809453691>"],
  ["MASTER LEAGUE I", "<:CWL_Master_1:1511515179236593674>"],
  ["CHAMPION LEAGUE III", "<:CWL_Champion_3:1511515170218971146>"],
  ["CHAMPION LEAGUE II", "<:CWL_Champion_2:1511515169015205929>"],
  ["CHAMPION LEAGUE I", "<:CWL_Champion_1:1511515166313939116>"],
]);

const CWL_LEAGUE_EMOJI_NAME_BY_LABEL = new Map<string, string>([
  ["BRONZE LEAGUE III", "CWL_Bronze_3"],
  ["BRONZE LEAGUE II", "CWL_Bronze_2"],
  ["BRONZE LEAGUE I", "CWL_Bronze_1"],
  ["SILVER LEAGUE III", "CWL_Silver_3"],
  ["SILVER LEAGUE II", "CWL_Silver_2"],
  ["SILVER LEAGUE I", "CWL_Silver_1"],
  ["GOLD LEAGUE III", "CWL_Gold_3"],
  ["GOLD LEAGUE II", "CWL_Gold_2"],
  ["GOLD LEAGUE I", "CWL_Gold_1"],
  ["CRYSTAL LEAGUE III", "CWL_Crystal_3"],
  ["CRYSTAL LEAGUE II", "CWL_Crystal_2"],
  ["CRYSTAL LEAGUE I", "CWL_Crystal_1"],
  ["MASTER LEAGUE III", "CWL_Master_3"],
  ["MASTER LEAGUE II", "CWL_Master_2"],
  ["MASTER LEAGUE I", "CWL_Master_1"],
  ["CHAMPION LEAGUE III", "CWL_Champion_3"],
  ["CHAMPION LEAGUE II", "CWL_Champion_2"],
  ["CHAMPION LEAGUE I", "CWL_Champion_1"],
]);

const CWL_SEARCHING_EMOJI_NAME = "a_search_2";
const CWL_SEARCHING_EMOJI_FALLBACK = "<a:a_search_2:1511522352356397179>";
const CWL_UNRANKED_EMOJI_NAME = "unranked";

export type CwlTrackedClanEmojiTokens = {
  leagueEmojiByLabel: Map<string, string>;
  unrankedEmoji: string;
  searchingEmoji: string;
};

function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCwlLeagueLabel(input: string | null): string {
  return String(input ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function formatCwlLeagueEmoji(label: string | null): string | null {
  const normalized = normalizeCwlLeagueLabel(label);
  if (!normalized) return null;
  if (normalized === "UNRANKED" || normalized === "UNKNOWN") return null;
  return CWL_LEAGUE_EMOJI_BY_LABEL.get(normalized) ?? null;
}

export function formatCwlLeagueAbbreviation(label: string | null): string {
  const normalized = normalizeCwlLeagueLabel(label);
  if (!normalized || normalized === "UNRANKED" || normalized === "UNKNOWN") {
    return "UNK";
  }

  const cleaned = normalized.replace(/\bLEAGUE\b/g, "").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(LEGEND|CHAMPION|MASTER|CRYSTAL|GOLD|SILVER|BRONZE)(?:\s+(.+))?$/);
  if (!match) return "UNK";

  const tier = match[1] ?? "";
  const suffix = match[2]?.trim() ?? "";
  if (tier === "LEGEND") return "LEG";

  const ordinal = suffix ? parseRomanNumeral(suffix) : null;
  if (ordinal === null) return "UNK";

  const prefixByTier = new Map([
    ["CHAMPION", "CH"],
    ["MASTER", "M"],
    ["CRYSTAL", "C"],
    ["GOLD", "G"],
    ["SILVER", "S"],
    ["BRONZE", "B"],
  ]);
  const prefix = prefixByTier.get(tier);
  if (!prefix) return "UNK";
  return `${prefix}${ordinal}`;
}

export function formatCwlSpinStatusEmoji(status: CwlTrackedClanSpinStatus): string {
  if (status === "matched") return "⚔️";
  if (status === "searching") return "<a:a_search_2:1511522352356397179>";
  return "💤";
}

/** Purpose: resolve bot-owned CWL league and spin emojis by application emoji name when available. */
export async function resolveCwlTrackedClanEmojiTokens(
  client: Client,
): Promise<CwlTrackedClanEmojiTokens> {
  const leagueEmojiByLabel = new Map<string, string>();
  for (const [label, emojiName] of CWL_LEAGUE_EMOJI_NAME_BY_LABEL.entries()) {
    const resolved = await emojiResolverService.resolveByName(client, emojiName).catch(() => null);
    leagueEmojiByLabel.set(label, resolved?.rendered ?? CWL_LEAGUE_EMOJI_BY_LABEL.get(label) ?? "-");
  }

  const unrankedResolved = await emojiResolverService.resolveByName(client, CWL_UNRANKED_EMOJI_NAME).catch(() => null);
  const searchingResolved = await emojiResolverService
    .resolveByName(client, CWL_SEARCHING_EMOJI_NAME)
    .catch(() => null);

  return {
    leagueEmojiByLabel,
    unrankedEmoji: unrankedResolved?.rendered ?? "-",
    searchingEmoji: searchingResolved?.rendered ?? CWL_SEARCHING_EMOJI_FALLBACK,
  };
}

export function formatCwlLeagueMinimalDisplayResolved(
  label: string | null,
  emojiTokens?: CwlTrackedClanEmojiTokens | null,
): string {
  const abbreviation = formatCwlLeagueAbbreviation(label);
  const fallbackEmoji = emojiTokens?.unrankedEmoji ?? "-";
  if (abbreviation === "UNK") {
    return fallbackEmoji;
  }

  const emoji = formatCwlLeagueEmojiResolved(label, emojiTokens) ?? fallbackEmoji;
  return `${emoji} ${abbreviation}`;
}

export function formatCwlLeagueEmojiResolved(
  label: string | null,
  emojiTokens?: CwlTrackedClanEmojiTokens | null,
): string | null {
  const normalized = normalizeCwlLeagueLabel(label);
  if (!normalized) return null;
  if (normalized === "UNRANKED" || normalized === "UNKNOWN") return null;
  return (
    emojiTokens?.leagueEmojiByLabel.get(normalized) ??
    CWL_LEAGUE_EMOJI_BY_LABEL.get(normalized) ??
    null
  );
}

export function formatCwlSpinStatusEmojiResolved(
  status: CwlTrackedClanSpinStatus,
  emojiTokens?: CwlTrackedClanEmojiTokens | null,
): string {
  if (status === "matched") return "⚔️";
  if (status === "searching") return emojiTokens?.searchingEmoji ?? CWL_SEARCHING_EMOJI_FALLBACK;
  return "💤";
}

function formatFwaTrackedClanMemberCount(memberCount: number | null): string {
  return memberCount === null ? "— 👥" : `${memberCount} 👥`;
}

function buildFwaTrackedClanMinimalListLine(clan: {
  name: string | null;
  tag: string;
  memberCount: number | null;
}): string {
  const title = buildClanProfileMarkdownLink(clan.name, clan.tag);
  const clanTag = normalizeClanTag(clan.tag);
  const memberCountText = formatFwaTrackedClanMemberCount(clan.memberCount);
  return clan.name && clanTag
    ? `- ${title} \`${clanTag}\` | ${memberCountText}`
    : `- ${title} | ${memberCountText}`;
}

function buildFwaTrackedClanMinimalListSummaryDescription(lines: string[]): string {
  return ["**FWA**", ...lines].join("\n");
}

function buildFwaTrackedClanMinimalListRefreshRow(
  prefix: string,
  refreshing: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:refresh`)
      .setEmoji("🔄")
      .setLabel(refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(refreshing),
  );
}

function parseRomanNumeral(input: string): number | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const value = Math.trunc(Number(normalized));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const numerals = new Map([
    ["M", 1000],
    ["CM", 900],
    ["D", 500],
    ["CD", 400],
    ["C", 100],
    ["XC", 90],
    ["L", 50],
    ["XL", 40],
    ["X", 10],
    ["IX", 9],
    ["V", 5],
    ["IV", 4],
    ["I", 1],
  ]);
  let total = 0;
  let index = 0;
  while (index < normalized.length) {
    const pair = normalized.slice(index, index + 2);
    if (numerals.has(pair)) {
      total += numerals.get(pair) ?? 0;
      index += 2;
      continue;
    }
    const single = normalized[index] ?? "";
    if (!numerals.has(single)) return null;
    total += numerals.get(single) ?? 0;
    index += 1;
  }
  return total > 0 ? total : null;
}

const CWL_PLANNED_ROSTER_FAMILY_RANK = new Map<string, number>([
  ["LEGEND", 7],
  ["CHAMPION", 6],
  ["MASTER", 5],
  ["CRYSTAL", 4],
  ["GOLD", 3],
  ["SILVER", 2],
  ["BRONZE", 1],
]);

const CWL_PLANNED_ROSTER_LEGEND_PATTERN = /^legend(?:\s+league)?$/i;
const CWL_PLANNED_ROSTER_STANDARD_PATTERN =
  /^(?<family>champion(?:s)?|master(?:s)?|crystal(?:s)?|gold(?:s)?|silver(?:s)?|bronze(?:s)?)(?:\s+league)?\s+(?<division>\d+|[ivxlcdm]+)(?:\s*\[\s*(?<bracket>[a-e])\s*\])?$/i;

type CwlPlannedRosterSortKey = {
  familyRank: number;
  divisionRank: number;
  bracketRank: number;
};

function normalizeCwlPlannedRosterSortText(input: string | null | undefined): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function parseCwlPlannedRosterSortKey(input: string | null): CwlPlannedRosterSortKey | null {
  const normalized = normalizeCwlPlannedRosterSortText(input);
  if (!normalized) return null;

  const titleSegment = normalized.split("|", 1)[0]?.trim() ?? "";
  if (CWL_PLANNED_ROSTER_LEGEND_PATTERN.test(titleSegment)) {
    return {
      familyRank: CWL_PLANNED_ROSTER_FAMILY_RANK.get("LEGEND") ?? -1,
      divisionRank: 0,
      bracketRank: 0,
    };
  }

  const match = titleSegment.match(CWL_PLANNED_ROSTER_STANDARD_PATTERN);
  const familyToken = match?.groups?.family?.toUpperCase().replace(/S$/, "") ?? "";
  const familyRank = CWL_PLANNED_ROSTER_FAMILY_RANK.get(familyToken) ?? -1;
  if (familyRank < 0) return null;

  const divisionToken = match?.groups?.division?.trim() ?? "";
  const divisionRank = parseRomanNumeral(divisionToken);
  if (divisionRank === null || divisionRank < 1 || divisionRank > 3) return null;

  const bracketToken = match?.groups?.bracket?.trim().toUpperCase() ?? "";
  const bracketRank = bracketToken ? bracketToken.charCodeAt(0) - 64 : 0;
  if (bracketRank < 0 || bracketRank > 5) return null;

  return {
    familyRank,
    divisionRank,
    bracketRank,
  };
}

function compareCwlPlannedRosterSortKeys(
  left: CwlPlannedRosterSortKey | null,
  right: CwlPlannedRosterSortKey | null,
): number {
  const leftRank = left?.familyRank ?? -1;
  const rightRank = right?.familyRank ?? -1;
  if (leftRank !== rightRank) return rightRank - leftRank;

  const leftDivision = left?.divisionRank ?? Number.MAX_SAFE_INTEGER;
  const rightDivision = right?.divisionRank ?? Number.MAX_SAFE_INTEGER;
  if (leftDivision !== rightDivision) return leftDivision - rightDivision;

  const leftBracket = left?.bracketRank ?? Number.MAX_SAFE_INTEGER;
  const rightBracket = right?.bracketRank ?? Number.MAX_SAFE_INTEGER;
  if (leftBracket !== rightBracket) return leftBracket - rightBracket;

  return 0;
}

function compareCwlTrackedClanDetailedRows(
  left: CwlTrackedClanDetailedDisplayRow,
  right: CwlTrackedClanDetailedDisplayRow,
): number {
  const leftPlannedSortKey =
    parseCwlPlannedRosterSortKey(left.rosterTitle) ??
    parseCwlPlannedRosterSortKey(left.leagueLabel);
  const rightPlannedSortKey =
    parseCwlPlannedRosterSortKey(right.rosterTitle) ??
    parseCwlPlannedRosterSortKey(right.leagueLabel);

  const plannedCompare = compareCwlPlannedRosterSortKeys(leftPlannedSortKey, rightPlannedSortKey);
  if (plannedCompare !== 0) return plannedCompare;

  const leftRosterTitle = normalizeCwlPlannedRosterSortText(left.rosterTitle);
  const rightRosterTitle = normalizeCwlPlannedRosterSortText(right.rosterTitle);
  const rosterTitleCompare = leftRosterTitle.localeCompare(rightRosterTitle, undefined, {
    sensitivity: "base",
  });
  if (rosterTitleCompare !== 0) return rosterTitleCompare;

  const leftName = sanitizeDisplayText(left.name) ?? "";
  const rightName = sanitizeDisplayText(right.name) ?? "";
  const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
  if (nameCompare !== 0) return nameCompare;

  return left.tag.localeCompare(right.tag, undefined, { sensitivity: "base" });
}

function chooseBestCwlTrackedClanRoster(rows: CwlTrackedClanRosterRow[]): CwlTrackedClanRosterRow | null {
  if (rows.length <= 0) return null;
  return [...rows].sort((left, right) => {
    const lifecycleRank = (value: string): number => {
      if (value === "OPEN") return 3;
      if (value === "ACTIVE") return 2;
      if (value === "CLOSED") return 1;
      return 0;
    };
    const leftRank = lifecycleRank(left.lifecycleState);
    const rightRank = lifecycleRank(right.lifecycleState);
    if (leftRank !== rightRank) return rightRank - leftRank;

    const leftPosted = left.postedMessageUrl ? 1 : 0;
    const rightPosted = right.postedMessageUrl ? 1 : 0;
    if (leftPosted !== rightPosted) return rightPosted - leftPosted;

    const leftPostedAt = left.postedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
    const rightPostedAt = right.postedAt?.getTime() ?? Number.MIN_SAFE_INTEGER;
    if (leftPostedAt !== rightPostedAt) return rightPostedAt - leftPostedAt;

    const createdAtCompare = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtCompare !== 0) return createdAtCompare;

    return right.title.localeCompare(left.title, undefined, { sensitivity: "base" });
  })[0] ?? null;
}

async function loadCwlTrackedClanDetailedRows(input: {
  season?: string;
  guildId?: string | null;
  liveSpinStatusByTag?: Map<string, CwlTrackedClanSpinStatus>;
}): Promise<CwlTrackedClanDetailedDisplayRow[]> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const guildId = String(input.guildId ?? "").trim() || null;

  const trackedClans = await prisma.cwlTrackedClan.findMany({
    where: { season },
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: {
      season: true,
      tag: true,
      name: true,
      leagueLabel: true,
    },
  });
  const trackedTags = trackedClans.map((row) => normalizeClanTag(row.tag)).filter((tag): tag is string => Boolean(tag));
  if (trackedTags.length <= 0) {
    return [];
  }
  const currentCwlEvents = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
    clanTags: trackedTags,
    season,
  });
  const currentCwlEventIds = [...new Set([...currentCwlEvents.values()].map((event) => event.id))];

  const [observedRosterRows, memberCountRows, activeRosterRows, currentRoundRows, prepRows, historyRows] = await Promise.all([
    currentCwlEventIds.length > 0
      ? prisma.cwlPlayerClanSeason.findMany({
          where: {
            eventInstanceId: { in: currentCwlEventIds },
            cwlClanTag: { in: trackedTags },
          },
          select: {
            cwlClanTag: true,
            playerTag: true,
          },
        })
      : Promise.resolve([]),
    guildId
      ? prisma.fwaClanMemberCurrent.groupBy({
          by: ["clanTag"],
          where: {
            clanTag: { in: trackedTags },
          },
          _count: {
            clanTag: true,
          },
        })
      : Promise.resolve([]),
    guildId
      ? prisma.roster.findMany({
          where: {
            guildId,
            rosterType: "CWL",
            rosterCategory: "signup",
            clanTag: { in: trackedTags },
            lifecycleState: { in: ["OPEN", "ACTIVE", "CLOSED"] },
          },
          select: {
            id: true,
            title: true,
            clanTag: true,
            lifecycleState: true,
            postedMessageUrl: true,
            postedAt: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    currentCwlEventIds.length > 0
      ? prisma.currentCwlRound.findMany({
          where: { eventInstanceId: { in: currentCwlEventIds } },
          select: {
            clanTag: true,
          },
        })
      : Promise.resolve([]),
    currentCwlEventIds.length > 0
      ? prisma.currentCwlPrepSnapshot.findMany({
          where: { eventInstanceId: { in: currentCwlEventIds } },
          select: {
            clanTag: true,
          },
        })
      : Promise.resolve([]),
    currentCwlEventIds.length > 0
      ? prisma.cwlRoundHistory.findMany({
          where: { eventInstanceId: { in: currentCwlEventIds } },
          select: {
            clanTag: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const observedRosterCountByTag = new Map<string, Set<string>>();
  for (const row of observedRosterRows) {
    const clanTag = normalizeClanTag(row.cwlClanTag);
    if (!clanTag) continue;
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const existing = observedRosterCountByTag.get(clanTag) ?? new Set<string>();
    existing.add(playerTag);
    observedRosterCountByTag.set(clanTag, existing);
  }

  const currentClanMemberCountByTag = new Map<string, number>();
  for (const row of memberCountRows as Array<{ clanTag: string; _count: { clanTag: number } }>) {
    const clanTag = normalizeClanTag(String(row.clanTag ?? ""));
    if (!clanTag) continue;
    currentClanMemberCountByTag.set(clanTag, row._count.clanTag);
  }

  const rostersByClanTag = new Map<string, CwlTrackedClanRosterRow[]>();
  for (const row of activeRosterRows as CwlTrackedClanRosterRow[]) {
    const clanTag = normalizeClanTag(String(row.clanTag ?? ""));
    if (!clanTag) continue;
    const current = rostersByClanTag.get(clanTag) ?? [];
    current.push({
      id: row.id,
      title: row.title,
      clanTag: row.clanTag,
      lifecycleState: row.lifecycleState,
      postedMessageUrl: row.postedMessageUrl,
      postedAt: row.postedAt,
      createdAt: row.createdAt,
    });
    rostersByClanTag.set(clanTag, current);
  }

  const persistedEvidenceTags = new Set<string>();
  for (const row of currentRoundRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (clanTag) persistedEvidenceTags.add(clanTag);
  }
  for (const row of prepRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (clanTag) persistedEvidenceTags.add(clanTag);
  }
  for (const row of historyRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (clanTag) persistedEvidenceTags.add(clanTag);
  }

  const rows = trackedClans.map((row) => {
    const clanTag = normalizeClanTag(row.tag) || row.tag;
    const observedCount = observedRosterCountByTag.get(clanTag)?.size ?? 0;
    const currentMemberCount = guildId ? currentClanMemberCountByTag.get(clanTag) ?? 0 : null;
    const roster = chooseBestCwlTrackedClanRoster(rostersByClanTag.get(clanTag) ?? []);
    const liveStatus = input.liveSpinStatusByTag?.get(clanTag) ?? null;
    const spinStatus: CwlTrackedClanSpinStatus =
      liveStatus ?? (observedCount > 0 || persistedEvidenceTags.has(clanTag) ? "matched" : "idle");
    return {
      season: row.season,
      tag: clanTag,
      name: row.name,
      leagueLabel: row.leagueLabel ?? null,
      spinStatus,
      observedCwlRosterCount: observedCount,
      currentClanMemberCount: currentMemberCount,
      rosterTitle: roster?.title ?? null,
      rosterPostedMessageUrl: roster?.postedMessageUrl ?? null,
    };
  });

  return rows.sort(compareCwlTrackedClanDetailedRows);
}

function normalizeSpinStatusReason(value: string): CwlTrackedClanSpinStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.includes("search")) return "searching";
  return "idle";
}

async function loadCwlTrackedClanLiveSpinStatus(input: {
  clanTags: string[];
  cocService: CoCService;
  season: string;
}): Promise<{
  liveSpinStatusByTag: Map<string, CwlTrackedClanSpinStatus>;
  failedClanCount: number;
  failedClanTags: string[];
  matchedCount: number;
  searchingCount: number;
  idleCount: number;
}> {
  const liveSpinStatusByTag = new Map<string, CwlTrackedClanSpinStatus>();
  const failedClanTags: string[] = [];
  let matchedCount = 0;
  let searchingCount = 0;
  let idleCount = 0;
  const requestedSeason = String(input.season ?? "").trim();

  for (const tag of input.clanTags) {
    try {
      const group = await input.cocService.getClanWarLeagueGroup(tag);
      const returnedSeason = String(group?.season ?? "").trim();
      if (group && returnedSeason === requestedSeason) {
        liveSpinStatusByTag.set(tag, "matched");
        matchedCount += 1;
        continue;
      }
      if (group) {
        liveSpinStatusByTag.set(tag, "idle");
        idleCount += 1;
        console.info(
          `[tracked-clan] stage=cwl_detailed_refresh_live_state season=${requestedSeason} clan=${tag} status=idle raw_reason=stale_group_season requested_season=${requestedSeason} returned_season=${returnedSeason}`,
        );
        continue;
      }
      liveSpinStatusByTag.set(tag, "idle");
      idleCount += 1;
      console.info(
        `[tracked-clan] stage=cwl_detailed_refresh_live_state season=${requestedSeason} clan=${tag} status=idle raw_reason=api_null`,
      );
    } catch (err) {
      const reason = formatError(err);
      const spinStatus = normalizeSpinStatusReason(reason);
      liveSpinStatusByTag.set(tag, spinStatus);
      if (spinStatus === "searching") {
        searchingCount += 1;
      } else {
        idleCount += 1;
      }
      failedClanTags.push(tag);
      console.info(
        `[tracked-clan] stage=cwl_detailed_refresh_live_state season=${requestedSeason} clan=${tag} status=${spinStatus} raw_reason=${reason}`,
      );
    }
  }

  return {
    liveSpinStatusByTag,
    failedClanCount: failedClanTags.length,
    failedClanTags,
    matchedCount,
    searchingCount,
    idleCount,
  };
}

/** Purpose: list tracked FWA clans in deterministic creation order for command rendering. */
export async function listFwaTrackedClansForDisplay(): Promise<FwaTrackedClanDisplayRow[]> {
  const rows = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      tag: true,
      name: true,
      loseStyle: true,
      mailChannelId: true,
      logChannelId: true,
      leaderChannelId: true,
      clanRoleId: true,
      leadRoleId: true,
      clanBadge: true,
      shortName: true,
      createdAt: true,
    },
  });
  const repTagsByClan = await listTrackedClanRepTagsForClanTags(rows.map((row) => row.tag));

  return rows.map((row) => ({
    tag: normalizeClanTag(row.tag) || row.tag,
    name: row.name,
    loseStyle: row.loseStyle,
    mailChannelId: row.mailChannelId,
    logChannelId: row.logChannelId,
    leaderChannelId: row.leaderChannelId,
    clanRoleId: row.clanRoleId,
    leadRoleId: row.leadRoleId,
    clanBadge: row.clanBadge,
    shortName: row.shortName,
    repPlayerTags: repTagsByClan.get(normalizeClanTag(row.tag) || row.tag) ?? [],
    createdAt: row.createdAt,
  }));
}

/** Purpose: load persisted FWA current-member counts for a set of tracked clan tags in one bulk query. */
export async function listFwaClanMemberCountsForTags(tags: string[]): Promise<Map<string, number>> {
  const normalizedTags = [
    ...new Set(tags.map((tag) => normalizeClanTag(tag)).filter((tag): tag is string => Boolean(tag))),
  ];
  if (normalizedTags.length === 0) {
    return new Map();
  }

  const rows = await prisma.fwaClanMemberCurrent.groupBy({
    by: ["clanTag"],
    where: {
      clanTag: { in: normalizedTags },
    },
    _count: {
      clanTag: true,
    },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const tag = normalizeClanTag(row.clanTag);
    if (!tag) continue;
    counts.set(tag, row._count.clanTag);
  }
  return counts;
}

/** Purpose: load the minimal FWA tracked-clan list state from persisted clan and member-count rows. */
export async function loadFwaTrackedClanMinimalListState(): Promise<FwaTrackedClanMinimalListState> {
  const trackedClans = await listFwaTrackedClansForDisplay();
  const refreshTags = trackedClans.map((clan) => clan.tag);
  const memberCountByTag = await listFwaClanMemberCountsForTags(refreshTags);

  return {
    trackedClans,
    refreshTags,
    memberCountByTag,
  };
}

/** Purpose: build the exact minimal FWA tracked-clan list embed and refresh button payload. */
export function buildFwaTrackedClanMinimalListRender(
  input: FwaTrackedClanMinimalListRenderInput,
): FwaTrackedClanMinimalListRender {
  const lines = input.trackedClans.map((clan) =>
    buildFwaTrackedClanMinimalListLine({
      ...clan,
      memberCount: input.memberCountByTag.get(normalizeClanTag(clan.tag) || clan.tag) ?? null,
    }),
  );

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Tracked Clans (FWA) (${input.trackedClans.length})`)
        .setDescription(buildFwaTrackedClanMinimalListSummaryDescription(lines))
        .setColor(0x57f287),
    ],
    components: [buildFwaTrackedClanMinimalListRefreshRow(input.refreshPrefix, input.refreshing)],
  };
}

/** Purpose: load CWL tracked clans for detailed list rendering using DB-backed counts and roster context. */
export async function listCwlTrackedClansForDetailedDisplay(input?: {
  season?: string;
  guildId?: string | null;
}): Promise<CwlTrackedClanDetailedDisplayRow[]> {
  return loadCwlTrackedClanDetailedRows({
    season: input?.season,
    guildId: input?.guildId ?? null,
  });
}

/** Purpose: force-refresh CWL detailed list data and live spin status inside the CoC queue. */
export async function refreshCwlTrackedClanDetailedDisplayWithQueueContext(input: {
  cocService: CoCService;
  season?: string;
  guildId?: string | null;
}): Promise<RefreshCwlTrackedClanDetailedDisplayResult> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const initialRows = await loadCwlTrackedClanDetailedRows({
    season,
    guildId: input.guildId ?? null,
  });
  const clanTags = initialRows.map((row) => row.tag);
  console.info(
    `[tracked-clan] stage=cwl_detailed_refresh status=started season=${season} displayed_count=${clanTags.length}`,
  );

  try {
    const result = await runWithCoCQueueContext(
      {
        priority: "interactive",
        source: "tracked-clan:list:cwl:detailed:refresh",
      },
      async () => {
        const metadataRefresh = await refreshCwlTrackedClanMetadataForSeason({
          season,
          clanTags,
          cocService: input.cocService,
          ensureRows: false,
        });
        const memberRefreshService = new FwaClanMembersSyncService();
        const memberRefresh = await memberRefreshService.refreshCurrentClanMembersForClanTags(
          clanTags,
          {
            cocService: input.cocService,
          },
        );
        const liveSpin = await loadCwlTrackedClanLiveSpinStatus({
          clanTags,
          cocService: input.cocService,
          season,
        });
        const rows = await loadCwlTrackedClanDetailedRows({
          season,
          guildId: input.guildId ?? null,
          liveSpinStatusByTag: liveSpin.liveSpinStatusByTag,
        });

        const failedClanCount = memberRefresh.failedClans.length + liveSpin.failedClanCount;
        const success = {
          season,
          displayedClanCount: clanTags.length,
          failedClanCount,
          metadataHydratedCount: metadataRefresh.hydratedCount,
          metadataSkippedCount: metadataRefresh.skippedCount,
          failedClanTags: [
            ...new Set([
              ...memberRefresh.failedClans.map((tag) => normalizeClanTag(tag) || tag),
              ...liveSpin.failedClanTags,
            ]),
          ],
          matchedCount: liveSpin.matchedCount,
          searchingCount: liveSpin.searchingCount,
          idleCount: liveSpin.idleCount,
          rows,
        };
        return success;
      },
    );

    console.info(
      `[tracked-clan] stage=cwl_detailed_refresh status=completed season=${result.season} displayed_count=${result.displayedClanCount} failed_count=${result.failedClanCount} matched_count=${result.matchedCount} searching_count=${result.searchingCount} idle_count=${result.idleCount} metadata_hydrated_count=${result.metadataHydratedCount} metadata_skipped_count=${result.metadataSkippedCount}`,
    );
    return result;
  } catch (err) {
    console.error(
      `[tracked-clan] stage=cwl_detailed_refresh status=failed season=${season} displayed_count=${clanTags.length} error=${formatError(err)}`,
    );
    throw err;
  }
}
