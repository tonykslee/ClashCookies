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
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { SettingsService } from "../services/SettingsService";

const POINTS_BASE_URL = "https://points.fwafarm.com/clan?tag=";
const TIEBREAK_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CACHE_REFRESH_DELAY_MS = 30 * 60 * 1000;
const WAR_END_RECHECK_MS = 10 * 60 * 1000;
const DISCORD_CONTENT_MAX = 2000;
const POINTS_CACHE_VERSION = 5;
const MATCHUP_CACHE_VERSION = 5;
const POINTS_POST_BUTTON_PREFIX = "points-post-channel";
const FWA_MATCH_COPY_BUTTON_PREFIX = "fwa-match-copy";
const FWA_MATCH_TYPE_ACTION_PREFIX = "fwa-match-type-action";
const FWA_MATCH_SELECT_PREFIX = "fwa-match-select";
const FWA_MATCH_ALLIANCE_PREFIX = "fwa-match-alliance";
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
  headerPrimaryTag: string | null;
  headerOpponentTag: string | null;
  headerPrimaryBalance: number | null;
  headerOpponentBalance: number | null;
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

function buildCcVerifyUrl(tag: string): string {
  return `https://cc.fwafarm.com/cc_n/clan.php?tag=${normalizeTag(tag)}`;
}

const MATCHTYPE_WARNING_LEGEND =
  ":warning: indicates inferred match type. Verify opponent association before confirming.";

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

type MatchView = {
  embed: EmbedBuilder;
  copyText: string;
  matchTypeAction?: { tag: string; currentType: "FWA" | "BL" | "MM" } | null;
  clanName?: string;
  clanTag?: string;
};

type FwaMatchCopyPayload = {
  userId: string;
  includePostButton: boolean;
  allianceView: MatchView;
  singleViews: Record<string, MatchView>;
  currentScope: "alliance" | "single";
  currentTag: string | null;
};

const fwaMatchCopyPayloads = new Map<string, FwaMatchCopyPayload>();

function buildFwaMatchCopyCustomId(
  userId: string,
  key: string,
  mode: "copy" | "embed"
): string {
  return `${FWA_MATCH_COPY_BUTTON_PREFIX}:${userId}:${key}:${mode}`;
}

function buildFwaMatchSelectCustomId(userId: string, key: string): string {
  return `${FWA_MATCH_SELECT_PREFIX}:${userId}:${key}`;
}

function parseFwaMatchSelectCustomId(customId: string): { userId: string; key: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== FWA_MATCH_SELECT_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  if (!userId || !key) return null;
  return { userId, key };
}

function buildFwaMatchAllianceCustomId(userId: string, key: string): string {
  return `${FWA_MATCH_ALLIANCE_PREFIX}:${userId}:${key}`;
}

function parseFwaMatchAllianceCustomId(customId: string): { userId: string; key: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== FWA_MATCH_ALLIANCE_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  if (!userId || !key) return null;
  return { userId, key };
}

function parseFwaMatchCopyCustomId(
  customId: string
): { userId: string; key: string; mode: "copy" | "embed" } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_COPY_BUTTON_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const mode = parts[3] === "copy" || parts[3] === "embed" ? parts[3] : null;
  if (!userId || !key || !mode) return null;
  return { userId, key, mode };
}

export function isFwaMatchCopyButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_COPY_BUTTON_PREFIX}:`);
}

type MatchTypeActionParams = {
  userId: string;
  tag: string;
  targetType: "FWA" | "BL" | "MM";
};

function buildMatchTypeActionCustomId(params: MatchTypeActionParams): string {
  return `${FWA_MATCH_TYPE_ACTION_PREFIX}:${params.userId}:${normalizeTag(params.tag)}:${params.targetType}`;
}

function parseMatchTypeActionCustomId(customId: string): MatchTypeActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_TYPE_ACTION_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const tag = normalizeTag(parts[2] ?? "");
  const targetType = parts[3] === "FWA" || parts[3] === "BL" || parts[3] === "MM" ? parts[3] : null;
  if (!userId || !tag || !targetType) return null;
  return { userId, tag, targetType };
}

export function isFwaMatchTypeActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_TYPE_ACTION_PREFIX}:`);
}

export function isFwaMatchSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SELECT_PREFIX}:`);
}

export function isFwaMatchAllianceButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_ALLIANCE_PREFIX}:`);
}

function buildFwaMatchCopyComponents(
  payload: FwaMatchCopyPayload,
  userId: string,
  key: string,
  showMode: "embed" | "copy"
): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  const view =
    payload.currentScope === "alliance" || !payload.currentTag
      ? payload.allianceView
      : payload.singleViews[payload.currentTag] ?? payload.allianceView;
  const matchTypeAction = view.matchTypeAction ?? null;
  const toggleMode = showMode === "embed" ? "copy" : "embed";
  const toggleLabel = showMode === "embed" ? "Copy/Paste View" : "Embed View";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildFwaMatchCopyCustomId(userId, key, toggleMode))
      .setLabel(toggleLabel)
      .setStyle(ButtonStyle.Secondary)
  );
  if (payload.includePostButton) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildPointsPostButtonCustomId(userId))
        .setLabel("Post to Channel")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (payload.currentScope === "single") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMatchAllianceCustomId(userId, key))
        .setLabel("Alliance View")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (matchTypeAction) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "FWA",
          })
        )
        .setLabel("FWA")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "BL",
          })
        )
        .setLabel("BL")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "MM",
          })
        )
        .setLabel("MM")
        .setStyle(
          matchTypeAction.currentType === "MM" ? ButtonStyle.Success : ButtonStyle.Secondary
        )
    );
  }
  if (payload.currentScope === "alliance") {
    const entries = Object.keys(payload.singleViews).slice(0, 25);
    if (entries.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(buildFwaMatchSelectCustomId(userId, key))
        .setPlaceholder("Open clan match view")
        .addOptions(
          entries.map((tag) => {
            const viewForTag = payload.singleViews[tag];
            const clanName = (viewForTag?.clanName ?? `#${tag}`).trim();
            return {
              label: `${clanName}`.slice(0, 100),
              description: `#${tag}`.slice(0, 100),
              value: tag,
            };
          })
        );
      return [row, new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
    }
  }
  return [row];
}

export async function handleFwaMatchCopyButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseFwaMatchCopyCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }

  const view =
    payload.currentScope === "single" && payload.currentTag
      ? payload.singleViews[payload.currentTag] ?? payload.allianceView
      : payload.allianceView;
  if (parsed.mode === "copy") {
    await interaction.update({
      content: limitDiscordContent(view.copyText),
      embeds: [],
      components: buildFwaMatchCopyComponents(payload, payload.userId, parsed.key, "copy"),
    });
    return;
  }

  await interaction.update({
    content: undefined,
    embeds: [view.embed],
    components: buildFwaMatchCopyComponents(payload, payload.userId, parsed.key, "embed"),
  });
}

export async function handleFwaMatchSelectMenu(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  const parsed = parseFwaMatchSelectCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this menu.",
    });
    return;
  }
  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  const selectedTag = normalizeTag(interaction.values[0] ?? "");
  if (!selectedTag || !payload.singleViews[selectedTag]) {
    await interaction.reply({
      ephemeral: true,
      content: "Could not open that clan view.",
    });
    return;
  }
  payload.currentScope = "single";
  payload.currentTag = selectedTag;
  fwaMatchCopyPayloads.set(parsed.key, payload);
  const view = payload.singleViews[selectedTag];
  await interaction.update({
    content: undefined,
    embeds: [view.embed],
    components: buildFwaMatchCopyComponents(payload, payload.userId, parsed.key, "embed"),
  });
}

export async function handleFwaMatchAllianceButton(
  interaction: ButtonInteraction
): Promise<void> {
  const parsed = parseFwaMatchAllianceCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }
  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  payload.currentScope = "alliance";
  payload.currentTag = null;
  fwaMatchCopyPayloads.set(parsed.key, payload);
  await interaction.update({
    content: undefined,
    embeds: [payload.allianceView.embed],
    components: buildFwaMatchCopyComponents(payload, payload.userId, parsed.key, "embed"),
  });
}

export async function handleFwaMatchTypeActionButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseMatchTypeActionCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This action can only be used in a server.",
    });
    return;
  }

  await prisma.warEventLogSubscription.upsert({
    where: {
      guildId_clanTag: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
      },
    },
    create: {
      guildId: interaction.guildId,
      clanTag: `#${parsed.tag}`,
      channelId: interaction.channelId,
      notify: false,
      matchType: parsed.targetType,
      inferredMatchType: false,
    },
    update: {
      matchType: parsed.targetType,
      inferredMatchType: false,
      updatedAt: new Date(),
    },
  });

  await interaction.reply({
    ephemeral: true,
    content: `Match type for #${parsed.tag} is now **${parsed.targetType}** (manual).`,
  });
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

function extractMatchupBalances(text: string): {
  primaryBalance: number | null;
  opponentBalance: number | null;
} {
  const match = text.match(/\(\s*([+-]?\d+)\s*([<>=])\s*([+-]?\d+)(?:,|\))/i);
  if (!match?.[1] || !match?.[3]) {
    return { primaryBalance: null, opponentBalance: null };
  }
  const primary = Number(match[1]);
  const opponent = Number(match[3]);
  return {
    primaryBalance: Number.isFinite(primary) ? primary : null,
    opponentBalance: Number.isFinite(opponent) ? opponent : null,
  };
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

function getSyncModeFromPrevious(previousSync: number | null): "high" | "low" | null {
  if (previousSync === null) return null;
  return (previousSync + 1) % 2 === 0 ? "high" : "low";
}

function withSyncModeLabel(syncText: string, previousSync: number | null): string {
  const mode = getSyncModeFromPrevious(previousSync);
  if (!mode) return syncText;
  return `${syncText} (${mode === "high" ? "High Sync" : "Low Sync"})`;
}

function formatWarStateLabel(warState: WarStateForSync): string {
  if (warState === "preparation") return "preparation";
  if (warState === "inWar") return "battle day";
  return "no war";
}

function formatMatchTypeLabel(
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN",
  inferred: boolean
): string {
  if (!inferred) return matchType;
  return `${matchType} \u26A0\uFE0F`;
}

function isPointsSiteUpdatedForOpponent(
  primary: PointsSnapshot,
  opponentTag: string,
  previousSync: number | null
): boolean {
  const normalizedOpponent = normalizeTag(opponentTag);
  const hasOpponent = primary.winnerBoxTags.map((t) => normalizeTag(t)).includes(normalizedOpponent);
  if (!hasOpponent) return false;
  if (
    previousSync !== null &&
    primary.winnerBoxSync !== null &&
    Number.isFinite(primary.winnerBoxSync) &&
    primary.winnerBoxSync <= previousSync
  ) {
    return false;
  }
  return true;
}

function deriveOpponentBalanceFromPrimarySnapshot(
  primary: PointsSnapshot,
  primaryTag: string,
  opponentTag: string
): number | null {
  const normalizedPrimary = normalizeTag(primaryTag);
  const normalizedOpponent = normalizeTag(opponentTag);
  if (
    primary.headerPrimaryTag === normalizedPrimary &&
    primary.headerOpponentTag === normalizedOpponent
  ) {
    return primary.headerOpponentBalance;
  }
  if (
    primary.headerPrimaryTag === normalizedOpponent &&
    primary.headerOpponentTag === normalizedPrimary
  ) {
    return primary.headerPrimaryBalance;
  }
  return null;
}

function buildPointsMismatchWarning(
  label: string,
  expected: number | null | undefined,
  actual: number | null | undefined
): string | null {
  if (
    expected === null ||
    expected === undefined ||
    actual === null ||
    actual === undefined ||
    Number.isNaN(expected) ||
    Number.isNaN(actual)
  ) {
    return null;
  }
  if (expected === actual) return null;
  return `\u26A0\uFE0F ${label} points mismatch: expected ${expected}, site ${actual}.`;
}

function getWarStateRemaining(
  war: { startTime?: string | null; endTime?: string | null } | null | undefined,
  warState: WarStateForSync
): string {
  if (warState === "notInWar") return "n/a";
  const startMs = parseCocApiTime(war?.startTime);
  const endMs = parseCocApiTime(war?.endTime);
  const targetMs = warState === "preparation" ? startMs : endMs;
  if (targetMs === null || !Number.isFinite(targetMs)) return "unknown";
  return `<t:${Math.floor(targetMs / 1000)}:R>`;
}

async function resolveMatchTypeWithFallback(params: {
  guildId: string | null;
  clanTag: string;
  opponentTag: string;
  warState: WarStateForSync;
  existingMatchType: "FWA" | "BL" | "MM" | null | undefined;
}): Promise<"FWA" | "BL" | "MM" | null> {
  return params.existingMatchType ?? null;
}

async function recoverPreviousSyncNumFromPoints(
  settings: SettingsService,
  cocService: CoCService,
  warLookupCache?: WarLookupCache
): Promise<number | null> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true },
  });
  for (const clan of tracked) {
    const tag = normalizeTag(clan.tag);
    const war = await getCurrentWarCached(cocService, tag, warLookupCache).catch(() => null);
    const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
    if (!opponentTag) continue;

    const snapshot = await getClanPointsCached(
      settings,
      cocService,
      tag,
      null,
      warLookupCache
    ).catch(() => null);
    if (!snapshot || snapshot.winnerBoxSync === null) continue;

    const siteUpdated = snapshot.winnerBoxTags
      .map((t) => normalizeTag(t))
      .includes(opponentTag);
    const recoveredPrevious = siteUpdated
      ? snapshot.winnerBoxSync - 1
      : snapshot.winnerBoxSync;
    if (!Number.isFinite(recoveredPrevious) || recoveredPrevious < 0) continue;

    const next = Math.trunc(recoveredPrevious);
    await settings.set(PREVIOUS_SYNC_KEY, String(next));
    recordFetchEvent({
      namespace: "points",
      operation: "sync_recovery",
      source: "cache_miss",
      detail: `tag=${tag} opponent=${opponentTag} recovered=${next} mode=${siteUpdated ? "updated_site" : "stale_site"}`,
    });
    return next;
  }

  return null;
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

type CurrentWarResult = Awaited<ReturnType<CoCService["getCurrentWar"]>>;
type WarLookupCache = Map<string, Promise<CurrentWarResult>>;

function getCurrentWarCached(
  cocService: CoCService,
  tag: string,
  warLookupCache?: WarLookupCache
): Promise<CurrentWarResult> {
  const normalized = `#${normalizeTag(tag)}`;
  if (!warLookupCache) return cocService.getCurrentWar(normalized);
  const cached = warLookupCache.get(normalized);
  if (cached) return cached;
  const pending = cocService.getCurrentWar(normalized);
  warLookupCache.set(normalized, pending);
  return pending;
}

function matchupCacheKey(tag: string, opponentTag: string): string {
  return `points_matchup_cache:${normalizeTag(tag)}:${normalizeTag(opponentTag)}`;
}

async function getClanWarEndMs(
  cocService: CoCService,
  tag: string,
  warLookupCache?: WarLookupCache
): Promise<number | null> {
  const war = await getCurrentWarCached(cocService, tag, warLookupCache);
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
  const matchupBalances = extractMatchupBalances(topSection || winnerBoxText || "");
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
    headerPrimaryTag: topHeader.primaryTag,
    headerOpponentTag: topHeader.opponentTag,
    headerPrimaryBalance: matchupBalances.primaryBalance,
    headerOpponentBalance: matchupBalances.opponentBalance,
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
  sourceSync: number | null,
  warLookupCache?: WarLookupCache
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
    warEndMs = await getClanWarEndMs(cocService, normalizedTag, warLookupCache);
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
  let sourceSync = await getSourceOfTruthSync(settings);
  if (sourceSync === null) {
    sourceSync = await recoverPreviousSyncNumFromPoints(settings, cocService);
  }
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
    outcome = `**${primaryName}** should lose by points (${primaryBalance} < ${opponentBalance})`;
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

function deriveProjectedOutcome(
  clanTag: string,
  opponentTag: string,
  clanPoints: number | null,
  opponentPoints: number | null,
  syncNumber: number | null
): "WIN" | "LOSE" | null {
  if (
    clanPoints === null ||
    opponentPoints === null ||
    Number.isNaN(clanPoints) ||
    Number.isNaN(opponentPoints)
  ) {
    return null;
  }
  if (clanPoints > opponentPoints) return "WIN";
  if (clanPoints < opponentPoints) return "LOSE";
  if (syncNumber === null) return null;
  const mode = getSyncMode(syncNumber);
  if (!mode) return null;
  const cmp = compareTagsForTiebreak(clanTag, opponentTag);
  if (cmp === 0) return null;
  const wins = mode === "low" ? cmp < 0 : cmp > 0;
  return wins ? "WIN" : "LOSE";
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
      inferredMatchType: true,
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
      `Match type: **${formatMatchTypeLabel(
        (sub?.matchType ?? "UNKNOWN") as "FWA" | "BL" | "MM" | "UNKNOWN",
        Boolean(sub?.inferredMatchType)
      )}**`,
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
  guildId: string | null,
  warLookupCache?: WarLookupCache
): Promise<{ embed: EmbedBuilder; copyText: string; singleViews: Record<string, MatchView> }> {
  const settings = new SettingsService();
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  if (tracked.length === 0) {
    return {
      embed: new EmbedBuilder()
      .setTitle("FWA Match Overview")
      .setDescription("No tracked clans configured. Use `/tracked-clan add` first."),
      copyText: "No tracked clans configured. Use `/tracked-clan add` first.",
      singleViews: {},
    };
  }

  const subscriptions = await prisma.warEventLogSubscription.findMany({
    where: guildId ? { guildId } : undefined,
    select: {
      clanTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      fwaPoints: true,
      opponentFwaPoints: true,
    },
  });
  const subByTag = new Map(subscriptions.map((s) => [normalizeTag(s.clanTag), s]));

  const stateCounts = new Map<WarStateForSync, number>([
    ["preparation", 0],
    ["inWar", 0],
    ["notInWar", 0],
  ]);
  const stateRemaining = new Map<WarStateForSync, string>();
  const embed = new EmbedBuilder().setTitle(`FWA Match Overview (${tracked.length})`);
  const copyLines: string[] = [];
  const singleViews: Record<string, MatchView> = {};

  for (const clan of tracked) {
    const clanTag = normalizeTag(clan.tag);
    const clanName = sanitizeClanName(clan.name) ?? `#${clanTag}`;
    const war = await getCurrentWarCached(cocService, clanTag, warLookupCache).catch(() => null);
    const warState = deriveWarState(war?.state);
    stateCounts.set(warState, (stateCounts.get(warState) ?? 0) + 1);
    if (!stateRemaining.has(warState)) {
      stateRemaining.set(warState, getWarStateRemaining(war, warState));
    }

    const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
    const opponentName = sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
    const sub = subByTag.get(clanTag);
    const matchTypeResolved = await resolveMatchTypeWithFallback({
      guildId,
      clanTag,
      opponentTag,
      warState,
      existingMatchType: sub?.matchType ?? null,
    });

    if (!opponentTag) {
      embed.addFields({
        name: `${clanName} (#${clanTag}) vs Unknown`,
        value: "No active war opponent",
        inline: false,
      });
      copyLines.push(
        `## ${clanName} (#${clanTag})`,
        "No active war opponent"
      );
      continue;
    }

    const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
    const primaryPoints = await getClanPointsCached(
      settings,
      cocService,
      clanTag,
      currentSync,
      warLookupCache
    ).catch(() => null);
    let opponentPoints: PointsSnapshot | null = null;
    if (primaryPoints) {
      const siteUpdated = isPointsSiteUpdatedForOpponent(primaryPoints, opponentTag, sourceSync);
      const opponentFromPrimary = siteUpdated
        ? deriveOpponentBalanceFromPrimarySnapshot(primaryPoints, clanTag, opponentTag)
        : null;
      if (opponentFromPrimary !== null && !Number.isNaN(opponentFromPrimary)) {
        opponentPoints = {
          ...primaryPoints,
          tag: opponentTag,
          balance: opponentFromPrimary,
          clanName: opponentName,
          winnerBoxHasTag: true,
        };
      }
    }
    if (!opponentPoints) {
      opponentPoints = await getClanPointsCached(
        settings,
        cocService,
        opponentTag,
        currentSync,
        warLookupCache
      ).catch(() => null);
    }
    const hasPrimaryPoints =
      primaryPoints?.balance !== null &&
      primaryPoints?.balance !== undefined &&
      !Number.isNaN(primaryPoints.balance);
    const hasOpponentPoints =
      opponentPoints?.balance !== null &&
      opponentPoints?.balance !== undefined &&
      !Number.isNaN(opponentPoints.balance);
    const inferredFromPointsType: "FWA" | "MM" | null = hasOpponentPoints ? "FWA" : "MM";
    const matchType = matchTypeResolved ?? inferredFromPointsType ?? "UNKNOWN";
    const inferredMatchType = Boolean(sub?.inferredMatchType) || (matchTypeResolved === null && inferredFromPointsType !== null);
    const derivedOutcome = deriveProjectedOutcome(
      clanTag,
      opponentTag,
      primaryPoints?.balance ?? null,
      opponentPoints?.balance ?? null,
      currentSync
    );
    const effectiveOutcome =
      (sub?.outcome as "WIN" | "LOSE" | null | undefined) ??
      (matchType === "FWA" ? derivedOutcome : null);
    if (matchTypeResolved === null && inferredFromPointsType && guildId) {
      await prisma.warEventLogSubscription.upsert({
        where: {
          guildId_clanTag: {
            guildId,
            clanTag: `#${clanTag}`,
          },
        },
        create: {
          guildId,
          clanTag: `#${clanTag}`,
          notify: false,
          channelId: "",
          matchType: inferredFromPointsType,
          inferredMatchType: true,
          fwaPoints:
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null && opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: effectiveOutcome,
          warStartFwaPoints:
            warState !== "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          warEndFwaPoints:
            warState === "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
        },
        update: {
          matchType: inferredFromPointsType,
          inferredMatchType: true,
          fwaPoints:
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null && opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: effectiveOutcome,
          warStartFwaPoints:
            warState !== "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
          warEndFwaPoints:
            warState === "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
        },
      });
    } else if (guildId) {
      await prisma.warEventLogSubscription.upsert({
        where: {
          guildId_clanTag: {
            guildId,
            clanTag: `#${clanTag}`,
          },
        },
        create: {
          guildId,
          clanTag: `#${clanTag}`,
          notify: false,
          channelId: "",
          matchType,
          inferredMatchType,
          fwaPoints:
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null && opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: effectiveOutcome,
          warStartFwaPoints:
            warState !== "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          warEndFwaPoints:
            warState === "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
        },
        update: {
          matchType,
          inferredMatchType,
          fwaPoints:
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null && opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: effectiveOutcome,
          warStartFwaPoints:
            warState !== "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
          warEndFwaPoints:
            warState === "notInWar" &&
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
        },
      });
    }
    const pointsLine =
      hasPrimaryPoints && hasOpponentPoints
        ? `Points: ${primaryPoints.balance} - ${opponentPoints!.balance}`
        : "Points: unavailable";
    const verifyLink = `[cc:${opponentTag}](${buildCcVerifyUrl(opponentTag)})`;
    const siteUpdatedForAlert = Boolean(
      primaryPoints && isPointsSiteUpdatedForOpponent(primaryPoints, opponentTag, sourceSync)
    );
    const primaryMismatch = siteUpdatedForAlert
      ? buildPointsMismatchWarning(
          clanName,
          sub?.fwaPoints ?? null,
          primaryPoints?.balance ?? null
        )
      : null;
    const opponentMismatch = siteUpdatedForAlert
      ? buildPointsMismatchWarning(
          opponentName,
          sub?.opponentFwaPoints ?? null,
          opponentPoints?.balance ?? null
        )
      : null;
    const mismatchLines = [primaryMismatch, opponentMismatch].filter(Boolean).join("\n");

    if (matchType === "FWA") {
      const warnSuffix = inferredMatchType ? ` :warning: ${verifyLink}` : "";
      embed.addFields({
        name: `${clanName} (#${clanTag}) vs ${opponentName} (#${opponentTag})`,
        value: `${pointsLine}\nMatch Type: **FWA${warnSuffix}**\nOutcome: **${effectiveOutcome ?? "UNKNOWN"}**${mismatchLines ? `\n${mismatchLines}` : ""}`,
        inline: false,
      });
      copyLines.push(
        `## ${clanName} (#${clanTag})`,
        `### Opponent Name`,
        `\`${opponentName}\``,
        `### Opponent Tag`,
        `\`${opponentTag}\``,
        `${pointsLine}`,
        `Match Type: FWA${inferredMatchType ? " :warning:" : ""}`,
        inferredMatchType ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
        `Outcome: ${effectiveOutcome ?? "UNKNOWN"}`,
        mismatchLines
      );
    } else {
      const warnSuffix = inferredMatchType ? ` :warning: ${verifyLink}` : "";
      embed.addFields({
        name: `${clanName} (#${clanTag}) vs ${opponentName} (#${opponentTag})`,
        value: `${pointsLine}\nMatch Type: **${matchType}${warnSuffix}**${mismatchLines ? `\n${mismatchLines}` : ""}`,
        inline: false,
      });
      copyLines.push(
        `## ${clanName} (#${clanTag})`,
        `### Opponent Name`,
        `\`${opponentName}\``,
        `### Opponent Tag`,
        `\`${opponentTag}\``,
        `${pointsLine}`,
        `Match Type: ${matchType}${inferredMatchType ? " :warning:" : ""}`,
        inferredMatchType ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
        mismatchLines
      );
    }

    const projectionLineSingle =
      hasPrimaryPoints && hasOpponentPoints
        ? (buildMatchupMessage(primaryPoints as PointsSnapshot, opponentPoints as PointsSnapshot, {
            primaryName: clanName,
            opponentName,
          }).split("\n")[1] ?? "Projection unavailable.")
        : "Projection unavailable (points missing).";
    const singleDescription = [
      MATCHTYPE_WARNING_LEGEND,
      "",
      `${projectionLineSingle}`,
      `Match Type: **${matchType}${inferredMatchType ? " :warning:" : ""}**${
        inferredMatchType ? ` ${verifyLink}` : ""
      }`,
      matchType === "FWA" ? `Expected outcome: **${effectiveOutcome ?? "UNKNOWN"}**` : "",
      `War state: **${formatWarStateLabel(warState)}**`,
      `Time remaining: **${getWarStateRemaining(war, warState)}**`,
      `Sync: **${withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync)}**`,
      mismatchLines,
    ]
      .filter(Boolean)
      .join("\n");
      singleViews[clanTag] = {
        embed: new EmbedBuilder()
          .setTitle(`${clanName} (#${clanTag}) vs ${opponentName} (#${opponentTag})`)
        .setDescription(singleDescription)
        .addFields({
          name: "Points",
          value:
            hasPrimaryPoints && hasOpponentPoints
              ? `${clanName}: **${primaryPoints!.balance}**\n${opponentName}: **${opponentPoints!.balance}**`
              : "Unavailable on both clans.",
          inline: false,
        }),
      copyText: limitDiscordContent(
        [
          `# ${clanName} (#${clanTag}) vs ${opponentName} (#${opponentTag})`,
          MATCHTYPE_WARNING_LEGEND,
          `Sync: ${withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync)}`,
          `War State: ${formatWarStateLabel(warState)}`,
          `Time Remaining: ${getWarStateRemaining(war, warState)}`,
          `## Opponent Name`,
          `\`${opponentName}\``,
          `## Opponent Tag`,
          `\`${opponentTag}\``,
          `## Points`,
          hasPrimaryPoints && hasOpponentPoints ? `${clanName}: ${primaryPoints!.balance}` : "Unavailable",
          hasPrimaryPoints && hasOpponentPoints ? `${opponentName}: ${opponentPoints!.balance}` : "Unavailable",
          `## Match Type`,
          `${matchType}${inferredMatchType ? " :warning:" : ""}`,
          inferredMatchType ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
          matchType === "FWA" ? `Expected outcome: ${effectiveOutcome ?? "UNKNOWN"}` : "",
          mismatchLines,
        ]
          .filter(Boolean)
          .join("\n")
      ),
      matchTypeAction:
        inferredMatchType
          ? { tag: clanTag, currentType: matchType as "FWA" | "BL" | "MM" }
          : null,
      clanName,
      clanTag,
    };
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
  const remainingLabel =
    stateLabel === "mixed"
      ? "mixed"
      : stateLabel === "preparation"
        ? (stateRemaining.get("preparation") ?? "unknown")
        : stateLabel === "battle day"
          ? (stateRemaining.get("inWar") ?? "unknown")
          : "n/a";

  const syncWithMode = stateLabel === "mixed" ? "mixed" : withSyncModeLabel(syncLabel, sourceSync);
  embed.setDescription(
    `${MATCHTYPE_WARNING_LEGEND}\n\nSync: **${syncWithMode}**\nWar State: **${stateLabel}**\nTime Remaining: **${remainingLabel}**`
  );
  const copyHeader = `# FWA Match Overview (${tracked.length})\n${MATCHTYPE_WARNING_LEGEND}\nSync: ${syncWithMode}\nWar State: ${stateLabel}\nTime Remaining: ${remainingLabel}`;
  return {
    embed,
    copyText: buildLimitedMessage(copyHeader, copyLines.map((l) => `${l}\n`), ""),
    singleViews,
  };
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
    {
      name: "leader-role",
      description: "Set the default FWA leader role",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "role",
          description: "Role to set as the FWA leader role",
          type: ApplicationCommandOptionType.Role,
          required: true,
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
    const defaultComponents = !isPublic
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildPointsPostButtonCustomId(interaction.user.id))
              .setLabel("Post to Channel")
              .setStyle(ButtonStyle.Secondary)
          ),
        ]
      : [];

    const editReplySafe = async (
      content: string,
      embeds?: EmbedBuilder[],
      componentsOverride?: Array<
        ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
      >
    ): Promise<void> => {
      const normalized = content.trim();
      await interaction.editReply({
        content: normalized ? truncateDiscordContent(normalized) : undefined,
        embeds,
        components: componentsOverride ?? defaultComponents,
      });
    };

    const settings = new SettingsService();
    const warLookupCache: WarLookupCache = new Map();
    let sourceSync = await getSourceOfTruthSync(settings);
    if (sourceSync === null) {
      sourceSync = await recoverPreviousSyncNumFromPoints(settings, cocService, warLookupCache);
    }
    await interaction.deferReply({ ephemeral: !isPublic });
    const rawTag = interaction.options.getString("tag", false);
    const tag = normalizeTag(rawTag ?? "");
    if (subcommand === "leader-role") {
      if (!interaction.inGuild()) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      const isOwnerBypass = (() => {
        const raw =
          process.env.OWNER_DISCORD_USER_IDS ?? process.env.OWNER_DISCORD_USER_ID ?? "";
        const owners = new Set(
          raw
            .split(",")
            .map((v) => v.trim())
            .filter((v) => /^\d+$/.test(v))
        );
        return owners.has(interaction.user.id);
      })();
      if (
        !isOwnerBypass &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ) {
        await editReplySafe("Only administrators can use this command.");
        return;
      }
      const role = interaction.options.getRole("role", true);
      if (!("id" in role)) {
        await editReplySafe("Invalid role selected.");
        return;
      }
      const permissionService = new CommandPermissionService();
      await permissionService.setFwaLeaderRoleId(interaction.guildId, role.id);
      await editReplySafe(`FWA leader role set to <@&${role.id}>.`);
      return;
    }

    if (subcommand === "points" && !tag) {
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });
      const subByTag = new Map<
        string,
        { fwaPoints: number | null }
      >();
      if (interaction.guildId) {
        const subs = await prisma.warEventLogSubscription.findMany({
          where: { guildId: interaction.guildId },
          select: { clanTag: true, fwaPoints: true },
        });
        for (const sub of subs) {
          subByTag.set(normalizeTag(sub.clanTag), { fwaPoints: sub.fwaPoints });
        }
      }

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
      const stateRemaining = new Map<WarStateForSync, string>();
      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        try {
          const war = await getCurrentWarCached(cocService, trackedTag, warLookupCache).catch(
            () => null
          );
          const warState = deriveWarState(war?.state);
          stateCounts.set(warState, (stateCounts.get(warState) ?? 0) + 1);
          if (!stateRemaining.has(warState)) {
            stateRemaining.set(warState, getWarStateRemaining(war, warState));
          }
          const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
          const result = await getClanPointsCached(
            settings,
            cocService,
            trackedTag,
            currentSync,
            warLookupCache
          );
          if (result.balance === null || Number.isNaN(result.balance)) {
            failedCount += 1;
            lines.push(`- ${clan.name ?? `#${trackedTag}`}: unavailable`);
            continue;
          }
          const label =
            sanitizeClanName(clan.name) ??
            sanitizeClanName(result.clanName) ??
            `#${trackedTag}`;
          const trueOpponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
          const mismatch =
            trueOpponentTag && isPointsSiteUpdatedForOpponent(result, trueOpponentTag, sourceSync)
              ? buildPointsMismatchWarning(
                  label,
                  subByTag.get(trackedTag)?.fwaPoints ?? null,
                  result.balance
                )
              : null;
          lines.push(
            `- ${label} (#${trackedTag}): **${formatPoints(result.balance)}**${
              mismatch ? `\n  ${mismatch}` : ""
            }`
          );
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
        summary += `\nTime remaining: ${stateRemaining.get(state) ?? "unknown"}`;
        summary += `\nSync: ${getSyncDisplay(sourceSync, state)}`;
      } else if (nonZeroStates.length > 1) {
        summary += `\nWar state: mixed`;
        summary += `\nTime remaining: mixed`;
        summary += `\nSync: mixed`;
        summary += `\nState counts: prep=${stateCounts.get("preparation") ?? 0}, battle=${stateCounts.get("inWar") ?? 0}, no-war=${stateCounts.get("notInWar") ?? 0}`;
      } else if (sourceSync !== null) {
        summary += `\nTime remaining: n/a`;
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
          interaction.guildId ?? null,
          warLookupCache
        );
        const key = interaction.id;
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          includePostButton: !isPublic,
          allianceView: { embed: overview.embed, copyText: overview.copyText, matchTypeAction: null },
          singleViews: overview.singleViews,
          currentScope: "alliance",
          currentTag: null,
        });
        await editReplySafe(
          "",
          [overview.embed],
          buildFwaMatchCopyComponents(
            fwaMatchCopyPayloads.get(key)!,
            interaction.user.id,
            key,
            "embed"
          )
        );
        return;
      }

      let opponentTag = "";
      try {
        const war = await getCurrentWarCached(cocService, tag, warLookupCache);
        const warState = deriveWarState(war?.state);
        const warRemaining = getWarStateRemaining(war, warState);
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

        const primary = await getClanPointsCached(
          settings,
          cocService,
          tag,
          currentSync,
          warLookupCache
        );
        let opponent: PointsSnapshot;
        const siteUpdated = isPointsSiteUpdatedForOpponent(primary, opponentTag, sourceSync);
        const opponentFromPrimary = siteUpdated
          ? deriveOpponentBalanceFromPrimarySnapshot(primary, tag, opponentTag)
          : null;
        if (opponentFromPrimary !== null && !Number.isNaN(opponentFromPrimary)) {
          opponent = {
            ...primary,
            tag: opponentTag,
            balance: opponentFromPrimary,
            clanName: sanitizeClanName(String(war?.opponent?.name ?? "")) ?? opponentTag,
            winnerBoxHasTag: true,
          };
        } else {
          opponent = await getClanPointsCached(
            settings,
            cocService,
            opponentTag,
            currentSync,
            warLookupCache
          );
        }
        const subscription = interaction.guildId
          ? await prisma.warEventLogSubscription.findUnique({
              where: {
                guildId_clanTag: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: {
                matchType: true,
                inferredMatchType: true,
                outcome: true,
                fwaPoints: true,
                opponentFwaPoints: true,
                warStartFwaPoints: true,
                warEndFwaPoints: true,
              },
            })
          : null;
        const matchTypeResolved = await resolveMatchTypeWithFallback({
          guildId: interaction.guildId ?? null,
          clanTag: tag,
          opponentTag,
          warState,
          existingMatchType: subscription?.matchType ?? null,
        });
        const trackedPair = await prisma.trackedClan.findMany({
          select: { name: true, tag: true },
        });
        const trackedNameByTag = new Map(
          trackedPair.map((c) => [normalizeTag(c.tag), sanitizeClanName(c.name)])
        );

        const hasPrimaryPoints = primary.balance !== null && !Number.isNaN(primary.balance);
        const hasOpponentPoints = opponent.balance !== null && !Number.isNaN(opponent.balance);
        if (!hasPrimaryPoints && hasOpponentPoints) {
          await editReplySafe(`Could not fetch point balance for #${tag}.`);
          return;
        }
        if (hasPrimaryPoints && !hasOpponentPoints) {
          await editReplySafe(`Could not fetch point balance for #${opponentTag}.`);
          return;
        }
        const inferredFromPointsType: "FWA" | "MM" | null = hasOpponentPoints ? "FWA" : "MM";
        let matchType = (matchTypeResolved ?? inferredFromPointsType ?? "UNKNOWN") as
          | "FWA"
          | "BL"
          | "MM"
          | "UNKNOWN";
        const derivedOutcome = deriveProjectedOutcome(
          tag,
          opponentTag,
          primary.balance,
          opponent.balance,
          currentSync
        );
        const inferredMatchType =
          Boolean(subscription?.inferredMatchType) ||
          (matchTypeResolved === null && inferredFromPointsType !== null);
        const effectiveOutcome =
          (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ??
          (matchType === "FWA" ? derivedOutcome : null);
        if (interaction.guildId) {
          await prisma.warEventLogSubscription.upsert({
            where: {
              guildId_clanTag: {
                guildId: interaction.guildId,
                clanTag: `#${tag}`,
              },
            },
            create: {
              guildId: interaction.guildId,
              clanTag: `#${tag}`,
              notify: false,
              channelId: interaction.channelId,
              matchType:
                matchTypeResolved === null && inferredFromPointsType
                  ? inferredFromPointsType
                  : matchType === "UNKNOWN"
                    ? null
                    : matchType,
              inferredMatchType:
                matchTypeResolved === null && inferredFromPointsType ? true : inferredMatchType,
              fwaPoints: primary.balance,
              opponentFwaPoints: opponent.balance,
              outcome: effectiveOutcome,
              warStartFwaPoints:
                warState !== "notInWar" ? primary.balance : subscription?.warStartFwaPoints ?? null,
              warEndFwaPoints:
                warState === "notInWar" ? primary.balance : subscription?.warEndFwaPoints ?? null,
            },
            update: {
              matchType:
                matchTypeResolved === null && inferredFromPointsType
                  ? inferredFromPointsType
                  : matchType === "UNKNOWN"
                    ? undefined
                    : matchType,
              inferredMatchType:
                matchTypeResolved === null && inferredFromPointsType ? true : inferredMatchType,
              fwaPoints: primary.balance,
              opponentFwaPoints: opponent.balance,
              outcome: effectiveOutcome,
              warStartFwaPoints:
                warState !== "notInWar" ? { set: primary.balance } : undefined,
              warEndFwaPoints:
                warState === "notInWar" ? { set: primary.balance } : undefined,
            },
          });
        }
        if (matchTypeResolved === null && inferredFromPointsType) {
          matchType = inferredFromPointsType;
        }

        recordFetchEvent({
          namespace: "points",
          operation: "matchup_projection",
          source: "cache_hit",
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

        const projectionLine = hasPrimaryPoints && hasOpponentPoints
          ? limitDiscordContent(
              buildMatchupMessage(primary, opponent, {
                primaryName: resolvedPrimaryName ?? primaryNameFromApi,
                opponentName: resolvedOpponentName ?? opponentNameFromApi,
              })
            )
              .split("\n")[1]
              ?.trim() ?? "Projection unavailable."
          : "Projection unavailable (no points found on either side).";
        const syncDisplay = withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync);
        const leftName = resolvedPrimaryName ?? primaryNameFromApi ?? tag;
        const rightName = resolvedOpponentName ?? opponentNameFromApi ?? opponentTag;
        const staleSite = !siteUpdated;
        const siteStatusLine = staleSite ? "Note: points.fwafarm site is not updated yet." : null;
        const trackedMismatch = siteUpdated
          ? buildPointsMismatchWarning(
              leftName,
              subscription?.fwaPoints ?? null,
              primary.balance
            )
          : null;
        const opponentMismatch = siteUpdated
          ? buildPointsMismatchWarning(
              rightName,
              subscription?.opponentFwaPoints ?? null,
              opponent.balance
            )
          : null;
        const mismatchLines = [trackedMismatch, opponentMismatch]
          .filter(Boolean)
          .join("\n");
        const outcomeLine =
          matchType === "FWA"
            ? `${effectiveOutcome ?? "UNKNOWN"}`
            : "";
        const matchTypeText = `${matchType}${inferredMatchType ? " :warning:" : ""}`;
        const verifyLink = inferredMatchType
          ? `[cc:${opponentTag}](${buildCcVerifyUrl(opponentTag)})`
          : "";
        const embed = new EmbedBuilder()
          .setTitle(`${leftName} (#${tag}) vs ${rightName} (#${opponentTag})`)
          .setDescription(
            `${MATCHTYPE_WARNING_LEGEND}\n\n${projectionLine}\nMatch Type: **${matchTypeText}**${
              verifyLink ? ` ${verifyLink}` : ""
            }${
              outcomeLine ? `\nExpected outcome: **${outcomeLine}**` : ""
            }\nWar state: **${formatWarStateLabel(warState)}**\nTime remaining: **${warRemaining}**\nSync: **${syncDisplay}**${
              siteStatusLine ? `\n${siteStatusLine}` : ""
            }${
              mismatchLines ? `\n${mismatchLines}` : ""
            }`
          )
            .addFields({
            name: "Points",
            value: hasPrimaryPoints && hasOpponentPoints
              ? `${leftName}: **${primary.balance}**\n${rightName}: **${opponent.balance}**`
              : "Unavailable on both clans.",
            inline: false,
          });
        const copyText = limitDiscordContent(
          [
            `# ${leftName} (#${tag}) vs ${rightName} (#${opponentTag})`,
            MATCHTYPE_WARNING_LEGEND,
            `Sync: ${syncDisplay}`,
            `War State: ${formatWarStateLabel(warState)}`,
            `Time Remaining: ${warRemaining}`,
            `## Opponent Name`,
            `\`${rightName}\``,
            `## Opponent Tag`,
            `\`${opponentTag}\``,
            `## Points`,
            hasPrimaryPoints && hasOpponentPoints ? `${leftName}: ${primary.balance}` : "Unavailable",
            hasPrimaryPoints && hasOpponentPoints ? `${rightName}: ${opponent.balance}` : "Unavailable",
            `## Projection`,
            projectionLine,
            `Match Type: ${matchTypeText}`,
            verifyLink ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
            outcomeLine ? `Expected outcome: ${outcomeLine}` : "",
            mismatchLines,
            siteStatusLine ?? "",
          ]
            .filter(Boolean)
            .join("\n")
        );
        const key = interaction.id;
        let alliance = await buildTrackedMatchOverview(
          cocService,
          sourceSync,
          interaction.guildId ?? null,
          warLookupCache
        );
        const singleView: MatchView = {
          embed,
          copyText,
          matchTypeAction:
            inferredMatchType && matchType !== "UNKNOWN"
              ? { tag, currentType: matchType as "FWA" | "BL" | "MM" }
              : null,
        };
        alliance = {
          ...alliance,
          singleViews: {
            ...alliance.singleViews,
            [tag]: singleView,
          },
        };
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          includePostButton: !isPublic,
          allianceView: { embed: alliance.embed, copyText: alliance.copyText, matchTypeAction: null },
          singleViews: alliance.singleViews,
          currentScope: "single",
          currentTag: tag,
        });
        const stored = fwaMatchCopyPayloads.get(key)!;
        await editReplySafe(
          "",
          [embed],
          buildFwaMatchCopyComponents(stored, interaction.user.id, key, "embed")
        );
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
      const war = await getCurrentWarCached(cocService, tag, warLookupCache).catch(() => null);
      const warState = deriveWarState(war?.state);
      const warRemaining = getWarStateRemaining(war, warState);
      const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
      const result = await getClanPointsCached(
        settings,
        cocService,
        tag,
        currentSync,
        warLookupCache
      );
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
      const subscription =
        interaction.guildId
          ? await prisma.warEventLogSubscription.findUnique({
              where: {
                guildId_clanTag: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: { fwaPoints: true },
            })
          : null;
      const trueOpponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
      const mismatch =
        trueOpponentTag && isPointsSiteUpdatedForOpponent(result, trueOpponentTag, sourceSync)
          ? buildPointsMismatchWarning(displayName, subscription?.fwaPoints ?? null, balance)
          : null;

      await editReplySafe(
        `Clan Name: **${displayName}**\nTag: #${tag}\nPoint Balance: **${formatPoints(
          balance
        )}**\nWar state: ${formatWarStateLabel(warState)}\nTime remaining: ${warRemaining}\nSync: ${getSyncDisplay(
          sourceSync,
          warState
        )}${mismatch ? `\n${mismatch}` : ""}\n${buildOfficialPointsUrl(tag)}`
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

