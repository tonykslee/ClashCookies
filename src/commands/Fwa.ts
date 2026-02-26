import axios from "axios";
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";

const POINTS_BASE_URL = "https://points.fwafarm.com/clan?tag=";
const TIEBREAK_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CACHE_REFRESH_DELAY_MS = 30 * 60 * 1000;
const WAR_END_RECHECK_MS = 10 * 60 * 1000;
const DISCORD_CONTENT_MAX = 2000;
const POINTS_CACHE_VERSION = 4;
const MATCHUP_CACHE_VERSION = 5;
const POINTS_POST_BUTTON_PREFIX = "points-post-channel";
const POINTS_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://points.fwafarm.com/",
  Origin: "https://points.fwafarm.com",
};

type PointsSnapshot = {
  version: number;
  tag: string;
  url: string;
  balance: number | null;
  clanName: string | null;
  notFound: boolean;
  winnerBoxText: string | null;
  winnerBoxTags: string[];
  winnerBoxSync: number | null;
  effectiveSync: number | null;
  syncMode: "low" | "high" | null;
  winnerBoxHasTag: boolean;
  warEndMs: number | null;
  lastWarCheckAtMs: number;
  fetchedAtMs: number;
  refreshedForWarEndMs: number | null;
};

type MatchupCacheEntry = {
  version: number;
  cycleKey: string;
  message: string;
  createdAtMs: number;
};

const PREVIOUS_SYNC_KEY = "previousSyncNum";
type WarStateForSync = "preparation" | "inWar" | "notInWar";

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function buildPointsUrl(tag: string): string {
  const normalizedTag = normalizeTag(tag);
  const proxyBase = (process.env.POINTS_PROXY_URL ?? "").trim();
  if (!proxyBase) {
    return `${POINTS_BASE_URL}${normalizedTag}`;
  }

  const proxyUrl = new URL(proxyBase);
  proxyUrl.searchParams.set("tag", normalizedTag);
  return proxyUrl.toString();
}

function buildOfficialPointsUrl(tag: string): string {
  return `${POINTS_BASE_URL}${normalizeTag(tag)}`;
}

function buildPointsPostButtonCustomId(userId: string): string {
  return `${POINTS_POST_BUTTON_PREFIX}:${userId}`;
}

function parsePointsPostButtonCustomId(customId: string): { userId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== POINTS_POST_BUTTON_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  return userId ? { userId } : null;
}

export function isPointsPostButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${POINTS_POST_BUTTON_PREFIX}:`);
}

export async function handlePointsPostButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parsePointsPostButtonCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    await interaction.reply({
      ephemeral: true,
      content: "Could not post to this channel.",
    });
    return;
  }

  try {
    await channel.send({
      content: truncateDiscordContent(interaction.message.content || "Points result"),
      embeds: interaction.message.embeds.map((embed) => embed.toJSON()),
    });
    await interaction.reply({
      ephemeral: true,
      content: "Posted to channel.",
    });
  } catch {
    await interaction.reply({
      ephemeral: true,
      content: "Failed to post to channel. Check bot permissions and try again.",
    });
  }
}

function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `${escaped}\\s*:\\s*(.+?)(?=\\s+[A-Za-z][A-Za-z0-9\\s]{1,40}:|$)`,
    "i"
  );
  const match = text.match(regex);
  if (!match?.[1]) return null;
  return match[1].trim().slice(0, 120);
}

function extractPointBalance(html: string): number | null {
  const directMatch = html.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  if (directMatch?.[1]) return Number(directMatch[1]);

  const plain = toPlainText(html);
  const textMatch = plain.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  if (!textMatch?.[1]) return null;
  return Number(textMatch[1]);
}

function extractWinnerBoxText(html: string): string | null {
  const match = html.match(
    /<p[^>]*class=["'][^"']*winner-box[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
  );
  if (!match?.[1]) return null;
  return toPlainText(match[1]);
}

function extractTopSectionText(html: string): string {
  const plain = toPlainText(html);
  const marker = plain.search(/Last Known War State\s*:/i);
  if (marker < 0) return plain;
  return plain.slice(0, marker).trim();
}

function extractTagsFromText(text: string): string[] {
  const tags = new Set<string>();
  const hashMatches = text.matchAll(/#([0-9A-Z]{4,})/gi);
  for (const match of hashMatches) {
    if (match[1]) tags.add(normalizeTag(match[1]));
  }
  const parenMatches = text.matchAll(/\(\s*([0-9A-Z]{4,})\s*\)/gi);
  for (const match of parenMatches) {
    if (match[1]) tags.add(normalizeTag(match[1]));
  }
  return [...tags];
}

function extractSyncNumber(text: string): number | null {
  const match = text.match(/sync\s*#\s*(\d+)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function getSyncMode(syncNumber: number | null): "low" | "high" | null {
  if (syncNumber === null) return null;
  return syncNumber % 2 === 0 ? "high" : "low";
}

async function getSourceOfTruthSync(settings: SettingsService): Promise<number | null> {
  const raw = await settings.get(PREVIOUS_SYNC_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function deriveWarState(rawState: string | null | undefined): WarStateForSync {
  const state = String(rawState ?? "").toLowerCase();
  if (state.includes("preparation")) return "preparation";
  if (state.includes("inwar")) return "inWar";
  return "notInWar";
}

function getCurrentSyncFromPrevious(
  previousSync: number | null,
  warState: WarStateForSync
): number | null {
  if (previousSync === null) return null;
  if (warState === "notInWar") return null;
  return previousSync + 1;
}

function getSyncDisplay(
  previousSync: number | null,
  warState: WarStateForSync
): string {
  if (previousSync === null) return "unknown";
  const current = previousSync + 1;
  if (warState === "notInWar") {
    return `between #${previousSync} and #${current}`;
  }
  return `#${current}`;
}

function formatWarStateLabel(warState: WarStateForSync): string {
  if (warState === "preparation") return "preparation";
  if (warState === "inWar") return "battle day";
  return "no war";
}

function applySourceSync(snapshot: PointsSnapshot, sourceSync: number | null): PointsSnapshot {
  if (sourceSync === null) return snapshot;
  return {
    ...snapshot,
    effectiveSync: sourceSync,
    syncMode: getSyncMode(sourceSync),
  };
}

function rankChar(ch: string): number {
  const idx = TIEBREAK_ORDER.indexOf(ch);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function compareTagsForTiebreak(primaryTag: string, opponentTag: string): number {
  const a = normalizeTag(primaryTag);
  const b = normalizeTag(opponentTag);
  const maxLen = Math.max(a.length, b.length);

  for (let i = 0; i < maxLen; i += 1) {
    const ra = rankChar(a[i] ?? "");
    const rb = rankChar(b[i] ?? "");
    if (ra === rb) continue;
    return ra - rb;
  }

  return 0;
}

function formatPoints(value: number): string {
  return Intl.NumberFormat("en-US").format(value);
}

function sanitizeClanName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.length > 80) return null;
  if (/Clan Tag|Point Balance|Sync #|Winner|War State/i.test(trimmed)) return null;
  return trimmed;
}

type MatchupHeader = {
  syncNumber: number | null;
  primaryName: string | null;
  primaryTag: string | null;
  opponentName: string | null;
  opponentTag: string | null;
};

function extractMatchupHeader(topText: string): MatchupHeader {
  const regex =
    /Sync\s*#\s*(\d+)\s+(.+?)\s*\(\s*([0-9A-Z]{4,})\s*\)\s+vs\.\s+(.+?)\s*\(\s*([0-9A-Z]{4,})\s*\)/i;
  const match = topText.match(regex);
  if (!match) {
    return {
      syncNumber: extractSyncNumber(topText),
      primaryName: null,
      primaryTag: null,
      opponentName: null,
      opponentTag: null,
    };
  }

  return {
    syncNumber: Number(match[1]),
    primaryName: sanitizeClanName(match[2]) ?? null,
    primaryTag: normalizeTag(match[3]),
    opponentName: sanitizeClanName(match[4]) ?? null,
    opponentTag: normalizeTag(match[5]),
  };
}

function limitDiscordContent(content: string): string {
  return truncateDiscordContent(content, DISCORD_CONTENT_MAX);
}

function buildLimitedMessage(header: string, lines: string[], summary: string): string {
  let message = `${header}\n\n`;
  let included = 0;

  for (const line of lines) {
    const candidate = `${message}${line}\n`;
    if ((candidate + summary).length > DISCORD_CONTENT_MAX) break;
    message = candidate;
    included += 1;
  }

  if (included < lines.length) {
    const omittedNote = `\n...and ${lines.length - included} more clan(s).`;
    if ((message + omittedNote + summary).length <= DISCORD_CONTENT_MAX) {
      message += omittedNote;
    }
  }

  // If the first line alone is too long, still show a shortened version.
  if (included === 0 && lines.length > 0) {
    const firstLineBudget = Math.max(0, DISCORD_CONTENT_MAX - message.length - summary.length - 40);
    const shortened = firstLineBudget > 0 ? `${lines[0].slice(0, firstLineBudget)}...` : "";
    if (shortened) {
      message += `${shortened}\n`;
      if (lines.length > 1) {
        const omittedNote = `...and ${lines.length - 1} more clan(s).`;
        if ((message + omittedNote + summary).length <= DISCORD_CONTENT_MAX) {
          message += omittedNote;
        }
      }
    }
  }

  if ((message + summary).length > DISCORD_CONTENT_MAX) {
    const allowed = Math.max(0, DISCORD_CONTENT_MAX - message.length);
    return `${message}${summary.slice(0, allowed)}`;
  }

  return `${message}${summary}`;
}

function getHttpStatus(err: unknown): number | null {
  const status =
    (err as { status?: number } | null | undefined)?.status ??
    (err as { response?: { status?: number } } | null | undefined)?.response?.status;
  return typeof status === "number" ? status : null;
}

function parseCocApiTime(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = input.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/
  );
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
}

function clanCacheKey(tag: string): string {
  return `points_cache:${normalizeTag(tag)}`;
}

function matchupCacheKey(tag: string, opponentTag: string): string {
  return `points_matchup_cache:${normalizeTag(tag)}:${normalizeTag(opponentTag)}`;
}

async function getClanWarEndMs(cocService: CoCService, tag: string): Promise<number | null> {
  const war = await cocService.getCurrentWar(`#${normalizeTag(tag)}`);
  return parseCocApiTime(war?.endTime);
}

async function readPointsCache(
  settings: SettingsService,
  tag: string
): Promise<PointsSnapshot | null> {
  const raw = await settings.get(clanCacheKey(tag));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PointsSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== POINTS_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePointsCache(
  settings: SettingsService,
  tag: string,
  snapshot: PointsSnapshot
): Promise<void> {
  await settings.set(clanCacheKey(tag), JSON.stringify(snapshot));
}

async function readMatchupCache(
  settings: SettingsService,
  tag: string,
  opponentTag: string
): Promise<MatchupCacheEntry | null> {
  const raw = await settings.get(matchupCacheKey(tag, opponentTag));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MatchupCacheEntry;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== MATCHUP_CACHE_VERSION) return null;
    if (typeof parsed.message !== "string" || typeof parsed.cycleKey !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMatchupCache(
  settings: SettingsService,
  tag: string,
  opponentTag: string,
  data: MatchupCacheEntry
): Promise<void> {
  await settings.set(matchupCacheKey(tag, opponentTag), JSON.stringify(data));
}

async function scrapeClanPoints(
  tag: string,
  options: {
    refreshedForWarEndMs: number | null;
    warEndMs: number | null;
    lastWarCheckAtMs: number;
  }
): Promise<PointsSnapshot> {
  const normalizedTag = normalizeTag(tag);
  const url = buildPointsUrl(normalizedTag);
  const response = await axios.get<string>(url, {
    timeout: 15000,
    responseType: "text",
    headers: POINTS_REQUEST_HEADERS,
    validateStatus: () => true,
  });
  if (response.status === 403) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_fetch",
      source: "web",
      detail: `tag=${normalizedTag} status=403 blocked=true`,
    });
    throw { status: 403, message: "points site returned 403" };
  }
  if (response.status >= 400) {
    throw { status: response.status, message: `points site returned ${response.status}` };
  }
  recordFetchEvent({
    namespace: "points",
    operation: "clan_points_fetch",
    source: "web",
    detail: `tag=${normalizedTag} status=${response.status}`,
  });

  const html = String(response.data ?? "");
  const balance = extractPointBalance(html);
  const plain = toPlainText(html);
  const topSection = extractTopSectionText(html);
  const topHeader = extractMatchupHeader(topSection);
  const clanNameFromHeader =
    topHeader.primaryTag === normalizedTag
      ? topHeader.primaryName
      : topHeader.opponentTag === normalizedTag
        ? topHeader.opponentName
        : null;
  const clanName =
    clanNameFromHeader ??
    extractField(topSection, "Clan Name") ??
    extractField(plain, "Clan Name");
  const notFound = /not found|unknown clan|no clan/i.test(topSection || plain);
  const winnerBoxText = extractWinnerBoxText(html);
  const winnerBoxTags = extractTagsFromText(topSection || winnerBoxText || "");
  const winnerBoxSync =
    topHeader.syncNumber ?? extractSyncNumber(topSection || winnerBoxText || "");
  const winnerBoxHasTag = winnerBoxTags.includes(normalizedTag);
  const effectiveSync =
    winnerBoxSync === null ? null : winnerBoxHasTag ? winnerBoxSync : winnerBoxSync + 1;
  const syncMode = getSyncMode(effectiveSync);

  return {
    version: POINTS_CACHE_VERSION,
    tag: normalizedTag,
    url,
    balance,
    clanName,
    notFound,
    winnerBoxText,
    winnerBoxTags,
    winnerBoxSync,
    effectiveSync,
    syncMode,
    winnerBoxHasTag,
    warEndMs: options.warEndMs,
    lastWarCheckAtMs: options.lastWarCheckAtMs,
    fetchedAtMs: Date.now(),
    refreshedForWarEndMs: options.refreshedForWarEndMs,
  };
}

async function getClanPointsCached(
  settings: SettingsService,
  cocService: CoCService,
  tag: string,
  sourceSync: number | null
): Promise<PointsSnapshot> {
  const normalizedTag = normalizeTag(tag);
  const cached = await readPointsCache(settings, normalizedTag);
  const now = Date.now();
  const knownWarEndMs = cached?.warEndMs ?? null;
  const refreshAfterKnownMs =
    knownWarEndMs === null ? null : knownWarEndMs + CACHE_REFRESH_DELAY_MS;
  const needsRefreshByKnownCycle =
    knownWarEndMs !== null &&
    refreshAfterKnownMs !== null &&
    now >= refreshAfterKnownMs &&
    cached?.refreshedForWarEndMs !== knownWarEndMs;
  const shouldRecheckWar =
    !cached ||
    !cached.lastWarCheckAtMs ||
    now - cached.lastWarCheckAtMs >= WAR_END_RECHECK_MS;

  if (cached && !needsRefreshByKnownCycle && !shouldRecheckWar) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_snapshot",
      source: "cache_hit",
      detail: `tag=${normalizedTag}`,
    });
    return applySourceSync(cached, sourceSync);
  }

  let warEndMs = knownWarEndMs;
  if (shouldRecheckWar) {
    warEndMs = await getClanWarEndMs(cocService, normalizedTag);
  }
  const refreshAfterMs = warEndMs === null ? null : warEndMs + CACHE_REFRESH_DELAY_MS;
  const needsRefreshByCycle =
    warEndMs !== null &&
    refreshAfterMs !== null &&
    now >= refreshAfterMs &&
    cached?.refreshedForWarEndMs !== warEndMs;

  if (cached && !needsRefreshByCycle) {
    if (shouldRecheckWar) {
      await writePointsCache(settings, normalizedTag, {
        ...cached,
        warEndMs,
        lastWarCheckAtMs: now,
      });
    }
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_snapshot",
      source: "cache_hit",
      detail: `tag=${normalizedTag}${shouldRecheckWar ? " reason=war_checked" : ""}`,
    });
    return applySourceSync(cached, sourceSync);
  }

  recordFetchEvent({
    namespace: "points",
    operation: "clan_points_snapshot",
    source: "cache_miss",
    detail: `tag=${normalizedTag}${needsRefreshByCycle ? " reason=refresh_due" : ""}`,
  });

  try {
    const snapshot = await scrapeClanPoints(normalizedTag, {
      refreshedForWarEndMs:
        warEndMs !== null && refreshAfterMs !== null && now >= refreshAfterMs ? warEndMs : null,
      warEndMs,
      lastWarCheckAtMs: now,
    });
    await writePointsCache(settings, normalizedTag, snapshot);
    return applySourceSync(snapshot, sourceSync);
  } catch (err) {
    if (cached) {
      recordFetchEvent({
        namespace: "points",
        operation: "clan_points_snapshot",
        source: "fallback_cache",
        detail: `tag=${normalizedTag}`,
      });
      console.warn(
        `[points] using cached value after scrape error tag=${normalizedTag} error=${formatError(err)}`
      );
      return applySourceSync(cached, sourceSync);
    }
    throw err;
  }
}

export async function getPointsSnapshotForClan(
  cocService: CoCService,
  tag: string
): Promise<PointsSnapshot> {
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings);
  return getClanPointsCached(settings, cocService, tag, sourceSync);
}

function buildMatchupMessage(
  primary: PointsSnapshot,
  opponent: PointsSnapshot,
  nameOverrides?: { primaryName?: string | null; opponentName?: string | null }
): string {
  const primaryTag = normalizeTag(primary.tag);
  const opponentTag = normalizeTag(opponent.tag);
  const primaryName =
    sanitizeClanName(nameOverrides?.primaryName) ??
    sanitizeClanName(primary.clanName) ??
    primaryTag;
  const opponentName =
    sanitizeClanName(nameOverrides?.opponentName) ??
    sanitizeClanName(opponent.clanName) ??
    opponentTag;
  const primaryBalance = primary.balance ?? 0;
  const opponentBalance = opponent.balance ?? 0;

  let outcome = "";
  if (primaryBalance > opponentBalance) {
    outcome = `**${primaryName}** should win by points (${primaryBalance} > ${opponentBalance})`;
  } else if (primaryBalance < opponentBalance) {
    outcome = `**${primaryName}** should lose by points (${opponentBalance} > ${primaryBalance})`;
  } else {
    const syncMode = primary.syncMode ?? opponent.syncMode;
    if (!syncMode) {
      outcome = `Points are tied (${primaryBalance} = ${opponentBalance}) but sync number was not found, so tiebreak cannot be determined.`;
    } else {
      const tiebreakCmp = compareTagsForTiebreak(primaryTag, opponentTag);
      if (tiebreakCmp === 0) {
        outcome = `Points are tied (${primaryBalance} = ${opponentBalance}) and tags are identical for tiebreak ordering.`;
      } else {
        const primaryWinsTiebreak = syncMode === "low" ? tiebreakCmp < 0 : tiebreakCmp > 0;
        outcome = primaryWinsTiebreak
          ? `**${primaryName}** should win by tiebreak (${primaryBalance} = ${opponentBalance}, ${syncMode} sync)`
          : `**${primaryName}** should lose by tiebreak (${primaryBalance} = ${opponentBalance}, ${syncMode} sync)`;
      }
    }
  }

  return limitDiscordContent(
    `${primaryName} (${primaryTag}) vs. ${opponentName} (${opponentTag}):\n${outcome}`
  );
}

async function buildLastWarMatchOverview(
  clanTag: string,
  guildId: string | null,
  previousSync: number | null
): Promise<string | null> {
  const normalizedTag = normalizeTag(clanTag);
  const lastWar = await prisma.warHistoryParticipant.findFirst({
    where: {
      clanTag: `#${normalizedTag}`,
      warEndTime: { not: null },
    },
    orderBy: { warStartTime: "desc" },
    select: {
      warStartTime: true,
      opponentClanTag: true,
      opponentClanName: true,
      clanName: true,
    },
  });

  if (!lastWar) return null;

  const participants = await prisma.warHistoryParticipant.findMany({
    where: {
      clanTag: `#${normalizedTag}`,
      warStartTime: lastWar.warStartTime,
    },
    select: { attacksUsed: true },
  });

  const missedHits = participants.reduce((sum, p) => {
    const used = Math.max(0, Math.min(2, Number(p.attacksUsed ?? 0)));
    return sum + (2 - used);
  }, 0);
  const missedBoth = participants.filter((p) => Number(p.attacksUsed ?? 0) <= 0).length;

  const starsRow = await prisma.$queryRaw<Array<{ stars: number }>>`
    SELECT COALESCE(SUM("trueStars"), 0)::int AS "stars"
    FROM "WarHistoryAttack"
    WHERE "clanTag" = ${`#${normalizedTag}`} AND "warStartTime" = ${lastWar.warStartTime}
  `;
  const clanStarsTracked = Number(starsRow[0]?.stars ?? 0);

  const sub = await prisma.warEventLogSubscription.findFirst({
    where: {
      clanTag: `#${normalizedTag}`,
      ...(guildId ? { guildId } : {}),
    },
    select: {
      matchType: true,
      outcome: true,
      lastClanStars: true,
      lastOpponentStars: true,
      warStartFwaPoints: true,
      warEndFwaPoints: true,
    },
  });

  const clanStars = sub?.lastClanStars ?? clanStarsTracked;
  const opponentStars = sub?.lastOpponentStars ?? null;
  const actualOutcome =
    opponentStars === null
      ? "UNKNOWN"
      : clanStars > opponentStars
        ? "WIN"
        : clanStars < opponentStars
          ? "LOSE"
          : "TIE";

  const pointsDelta =
    sub?.warStartFwaPoints !== null &&
    sub?.warStartFwaPoints !== undefined &&
    sub?.warEndFwaPoints !== null &&
    sub?.warEndFwaPoints !== undefined
      ? sub.warEndFwaPoints - sub.warStartFwaPoints
      : null;

  const syncLabel = previousSync !== null ? `#${previousSync}` : "unknown";
  const clanName = sanitizeClanName(lastWar.clanName) ?? `#${normalizedTag}`;
  const opponentName = sanitizeClanName(lastWar.opponentClanName) ?? "Unknown Opponent";
  const opponentTag = normalizeTag(lastWar.opponentClanTag ?? "");

  return limitDiscordContent(
    [
      `Match overview for Sync ${syncLabel}`,
      `${clanName} (#${normalizedTag}) vs ${opponentName}${opponentTag ? ` (#${opponentTag})` : ""}`,
      `Match type: **${sub?.matchType ?? "UNKNOWN"}**`,
      `Expected outcome: **${sub?.outcome ?? "UNKNOWN"}**`,
      `Actual outcome: **${actualOutcome}**`,
      `Total stars: ${clanName} ${clanStars} - ${opponentName} ${opponentStars ?? "unknown"}`,
      `Missed hits (${clanName}): ${missedHits}`,
      `Members missed both hits (${clanName}): ${missedBoth}`,
      `FWA points gained (${clanName}): ${pointsDelta === null ? "unknown" : pointsDelta >= 0 ? `+${pointsDelta}` : String(pointsDelta)}`,
    ].join("\n")
  );
}

async function buildTrackedMatchOverview(
  cocService: CoCService,
  sourceSync: number | null,
  guildId: string | null
): Promise<string> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  if (tracked.length === 0) {
    return "No tracked clans configured. Use `/tracked-clan add` first.";
  }

  const subscriptions = await prisma.warEventLogSubscription.findMany({
    where: guildId ? { guildId } : undefined,
    select: {
      clanTag: true,
      matchType: true,
      outcome: true,
    },
  });
  const subByTag = new Map(subscriptions.map((s) => [normalizeTag(s.clanTag), s]));

  const stateCounts = new Map<WarStateForSync, number>([
    ["preparation", 0],
    ["inWar", 0],
    ["notInWar", 0],
  ]);
  const lines: string[] = [];

  for (const clan of tracked) {
    const clanTag = normalizeTag(clan.tag);
    const clanName = sanitizeClanName(clan.name) ?? `#${clanTag}`;
    const war = await cocService.getCurrentWar(`#${clanTag}`).catch(() => null);
    const warState = deriveWarState(war?.state);
    stateCounts.set(warState, (stateCounts.get(warState) ?? 0) + 1);

    const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
    const opponentName = sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
    const sub = subByTag.get(clanTag);
    const matchType = sub?.matchType ?? "UNKNOWN";

    if (!opponentTag) {
      lines.push(`- ${clanName}(#${clanTag}) vs Unknown\n  No active war opponent`);
      continue;
    }

    if (matchType === "FWA") {
      lines.push(
        `- ${clanName}(#${clanTag}) vs ${opponentName}(#${opponentTag})\n  ${clanName} outcome: ${sub?.outcome ?? "UNKNOWN"}`
      );
      continue;
    }

    lines.push(
      `- ${clanName}(#${clanTag}) vs ${opponentName}(#${opponentTag})\n  Match Type: ${matchType}`
    );
  }

  const nonZeroStates = [...stateCounts.entries()].filter(([, count]) => count > 0);
  const stateLabel =
    nonZeroStates.length === 1 ? formatWarStateLabel(nonZeroStates[0][0]) : "mixed";
  let syncLabel = "unknown";
  if (sourceSync !== null) {
    if (stateLabel === "no war") syncLabel = `between #${sourceSync} and #${sourceSync + 1}`;
    else if (stateLabel === "mixed") syncLabel = "mixed";
    else syncLabel = `#${sourceSync + 1}`;
  }

  const header = `Tracked FWA match overview (${tracked.length})\nSync: ${syncLabel}\nWar State: ${stateLabel}`;
  return buildLimitedMessage(header, lines, "");
}

export const Fwa: Command = {
  name: "fwa",
  description: "FWA points and matchup tools",
  options: [
    {
      name: "points",
      description: "Get FWA points for one clan or all tracked clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "visibility",
          description: "Response visibility",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "private", value: "private" },
            { name: "public", value: "public" },
          ],
        },
        {
          name: "tag",
          description: "Clan tag (with or without #). Leave blank for all tracked clans.",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "match",
      description: "Project FWA matchup using current war opponent and points",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Your clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "visibility",
          description: "Response visibility",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "private", value: "private" },
            { name: "public", value: "public" },
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
    const subcommand = interaction.options.getSubcommand(true);
    const visibility = interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    const components = !isPublic
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildPointsPostButtonCustomId(interaction.user.id))
              .setLabel("Post to Channel")
              .setStyle(ButtonStyle.Secondary)
          ),
        ]
      : [];

    const editReplySafe = async (content: string): Promise<void> => {
      await interaction.editReply({
        content: truncateDiscordContent(content),
        components,
      });
    };

    const settings = new SettingsService();
    const sourceSync = await getSourceOfTruthSync(settings);
    await interaction.deferReply({ ephemeral: !isPublic });
    const rawTag = interaction.options.getString("tag", false);
    const tag = normalizeTag(rawTag ?? "");
    if (subcommand === "points" && !tag) {
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });

      if (tracked.length === 0) {
        await editReplySafe(
          "No tracked clans configured. Use `/tracked-clan add` or provide a clan tag."
        );
        return;
      }

      const lines: string[] = [];
      let failedCount = 0;
      let forbiddenCount = 0;
      const stateCounts = new Map<WarStateForSync, number>([
        ["preparation", 0],
        ["inWar", 0],
        ["notInWar", 0],
      ]);
      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        try {
          const war = await cocService.getCurrentWar(`#${trackedTag}`).catch(() => null);
          const warState = deriveWarState(war?.state);
          stateCounts.set(warState, (stateCounts.get(warState) ?? 0) + 1);
          const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
          const result = await getClanPointsCached(settings, cocService, trackedTag, currentSync);
          if (result.balance === null || Number.isNaN(result.balance)) {
            failedCount += 1;
            lines.push(`- ${clan.name ?? `#${trackedTag}`}: unavailable`);
            continue;
          }
          const label =
            sanitizeClanName(clan.name) ??
            sanitizeClanName(result.clanName) ??
            `#${trackedTag}`;
          lines.push(`- ${label} (#${trackedTag}): **${formatPoints(result.balance)}**`);
        } catch (err) {
          failedCount += 1;
          if (getHttpStatus(err) === 403) forbiddenCount += 1;
          console.error(
            `[points] bulk request failed tag=${trackedTag} error=${formatError(err)}`
          );
          lines.push(`- ${clan.name ?? `#${trackedTag}`}: unavailable`);
        }
      }

      const header = `Tracked clan points (${tracked.length})`;
      let summary = "";
      if (failedCount > 0) {
        summary = `\n\n${failedCount} clan(s) could not be fetched right now.`;
      }
      if (forbiddenCount > 0) {
        summary +=
          `\n${forbiddenCount} request(s) were blocked by points.fwafarm.com (HTTP 403).`;
      }
      const nonZeroStates = [...stateCounts.entries()].filter(([, count]) => count > 0);
      if (nonZeroStates.length === 1) {
        const state = nonZeroStates[0][0];
        summary += `\nWar state: ${formatWarStateLabel(state)}`;
        summary += `\nSync: ${getSyncDisplay(sourceSync, state)}`;
      } else if (nonZeroStates.length > 1) {
        summary += `\nWar state: mixed`;
        summary += `\nSync: mixed`;
        summary += `\nState counts: prep=${stateCounts.get("preparation") ?? 0}, battle=${stateCounts.get("inWar") ?? 0}, no-war=${stateCounts.get("notInWar") ?? 0}`;
      } else if (sourceSync !== null) {
        summary += `\nSync: between #${sourceSync} and #${sourceSync + 1}`;
      }
      await editReplySafe(buildLimitedMessage(header, lines, summary));
      return;
    }

    if (subcommand === "match") {
      if (!tag) {
        const overview = await buildTrackedMatchOverview(
          cocService,
          sourceSync,
          interaction.guildId ?? null
        );
        await editReplySafe(overview);
        return;
      }

      let opponentTag = "";
      try {
        const war = await cocService.getCurrentWar(`#${tag}`);
        const warState = deriveWarState(war?.state);
        const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
        opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
        if (!opponentTag) {
          const overview = await buildLastWarMatchOverview(tag, interaction.guildId ?? null, sourceSync);
          if (!overview) {
            await editReplySafe(`No active war opponent found for #${tag}. No ended war snapshot is available yet.`);
            return;
          }
          await editReplySafe(overview);
          return;
        }

        const [primary, opponent] = await Promise.all([
          getClanPointsCached(settings, cocService, tag, currentSync),
          getClanPointsCached(settings, cocService, opponentTag, currentSync),
        ]);
        const subscription = interaction.guildId
          ? await prisma.warEventLogSubscription.findUnique({
              where: {
                guildId_clanTag: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: { matchType: true, outcome: true },
            })
          : null;
        const matchType = subscription?.matchType ?? "UNKNOWN";
        const trackedPair = await prisma.trackedClan.findMany({
          select: { name: true, tag: true },
        });
        const trackedNameByTag = new Map(
          trackedPair.map((c) => [normalizeTag(c.tag), sanitizeClanName(c.name)])
        );

        if (primary.balance === null || Number.isNaN(primary.balance)) {
          await editReplySafe(`Could not fetch point balance for #${tag}.`);
          return;
        }
        if (opponent.balance === null || Number.isNaN(opponent.balance)) {
          await editReplySafe(`Could not fetch point balance for #${opponentTag}.`);
          return;
        }

        const cycleKey = `${currentSync ?? "none"}:${primary.refreshedForWarEndMs ?? "none"}:${opponent.refreshedForWarEndMs ?? "none"}`;
        const cachedMatchup = await readMatchupCache(settings, tag, opponentTag);
        if (cachedMatchup && cachedMatchup.cycleKey === cycleKey) {
          recordFetchEvent({
            namespace: "points",
            operation: "matchup_projection",
            source: "cache_hit",
            detail: `tag=${tag} opponent=${opponentTag}`,
          });
          const safeCachedMessage = limitDiscordContent(cachedMatchup.message);
          await editReplySafe(safeCachedMessage);
          if (safeCachedMessage !== cachedMatchup.message) {
            await writeMatchupCache(settings, tag, opponentTag, {
              ...cachedMatchup,
              message: safeCachedMessage,
            });
          }
          return;
        }
        recordFetchEvent({
          namespace: "points",
          operation: "matchup_projection",
          source: "cache_miss",
          detail: `tag=${tag} opponent=${opponentTag}`,
        });

        const resolvedPrimaryName =
          trackedNameByTag.get(tag) ??
          sanitizeClanName(String(war?.clan?.name ?? "")) ??
          sanitizeClanName(primary.clanName);
        const resolvedOpponentName =
          trackedNameByTag.get(opponentTag) ??
          sanitizeClanName(String(war?.opponent?.name ?? "")) ??
          sanitizeClanName(opponent.clanName);
        const [primaryNameFromApi, opponentNameFromApi] = await Promise.all([
          resolvedPrimaryName
            ? Promise.resolve<string | null>(null)
            : cocService
                .getClanName(tag)
                .then((name) => sanitizeClanName(name))
                .catch(() => null),
          resolvedOpponentName
            ? Promise.resolve<string | null>(null)
            : cocService
                .getClanName(opponentTag)
                .then((name) => sanitizeClanName(name))
                .catch(() => null),
        ]);

        const message = limitDiscordContent(
          buildMatchupMessage(primary, opponent, {
            primaryName: resolvedPrimaryName ?? primaryNameFromApi,
            opponentName: resolvedOpponentName ?? opponentNameFromApi,
          })
        );
        const opponentInWinnerBox = primary.winnerBoxTags
          .map((t) => normalizeTag(t))
          .includes(opponentTag);
        const staleSite =
          !opponentInWinnerBox || (sourceSync !== null && primary.winnerBoxSync === sourceSync);
        const siteStatusLine = staleSite
          ? "\nNote: points.fwafarm site is not updated yet."
          : "";
        const outcomeLine =
          matchType === "FWA"
            ? `\nExpected outcome: ${subscription?.outcome ?? "UNKNOWN"}`
            : "";
        const messageWithSync = limitDiscordContent(
          `${message}\nMatch Type: ${matchType}${outcomeLine}\nWar state: ${formatWarStateLabel(
            warState
          )}\nSync: ${getSyncDisplay(sourceSync, warState)}${siteStatusLine}`
        );
        await writeMatchupCache(settings, tag, opponentTag, {
          version: MATCHUP_CACHE_VERSION,
          cycleKey,
          message: messageWithSync,
          createdAtMs: Date.now(),
        });

        await editReplySafe(messageWithSync);
        return;
      } catch (err) {
        console.error(
          `[points] matchup request failed tag=${tag} opponent=${opponentTag} error=${formatError(err)}`
        );
        if (getHttpStatus(err) === 403) {
          await editReplySafe(
            "points.fwafarm.com blocked this request (HTTP 403). Try again later."
          );
          return;
        }
        await editReplySafe("Failed to fetch points matchup. Check both tags and try again.");
        return;
      }
    }

    try {
      if (!tag) {
        await editReplySafe("Please provide `tag`.");
        return;
      }
      const war = await cocService.getCurrentWar(`#${tag}`).catch(() => null);
      const warState = deriveWarState(war?.state);
      const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
      const result = await getClanPointsCached(settings, cocService, tag, currentSync);
      const balance = result.balance;
      if (balance === null || Number.isNaN(balance)) {
        if (result.notFound) {
          await editReplySafe(
            `No points data found for #${tag}. Check the clan tag and try again.`
          );
          return;
        }

        console.error(`[points] could not parse point balance for tag=${tag} url=${result.url}`);
        await editReplySafe(
          "Could not parse point balance from points.fwafarm.com right now. Try again later."
        );
        return;
      }

      const trackedClan = await prisma.trackedClan.findFirst({
        where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
        select: { name: true },
      });
      const trackedName = sanitizeClanName(trackedClan?.name);
      const scrapedName = sanitizeClanName(result.clanName);
      const apiName =
        trackedName || scrapedName
          ? null
          : await cocService
              .getClanName(tag)
              .then((name) => sanitizeClanName(name))
              .catch(() => null);
      const displayName =
        trackedName ??
        scrapedName ??
        apiName ??
        "Unknown Clan";

      await editReplySafe(
        `Clan Name: **${displayName}**\nTag: #${tag}\nPoint Balance: **${formatPoints(
          balance
        )}**\nWar state: ${formatWarStateLabel(warState)}\nSync: ${getSyncDisplay(
          sourceSync,
          warState
        )}\n${buildOfficialPointsUrl(tag)}`
      );
    } catch (err) {
      console.error(`[points] request failed tag=${tag} error=${formatError(err)}`);
      if (getHttpStatus(err) === 403) {
        await editReplySafe(
          "points.fwafarm.com blocked this request (HTTP 403). Try again later."
        );
        return;
      }
      await editReplySafe("Failed to fetch points. Check the tag and try again.");
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
      .map((c) => {
        const normalized = normalizeTag(c.tag);
        const label = c.name?.trim() ? `${c.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: label.slice(0, 100), value: normalized };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
