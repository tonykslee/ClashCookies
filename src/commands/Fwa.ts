import axios from "axios";
import { Prisma } from "@prisma/client";
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
import {
  DISCORD_CONTENT_LIMIT,
  truncateDiscordContent,
} from "../helper/discordContent";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import {
  resolveSteadyStateLogLevel,
  SteadyStateLogGate,
} from "../helper/steadyStateLogGate";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { listPlayerLinksForClanMembers } from "../services/PlayerLinkService";
import {
  CommandPermissionService,
  FWA_LEADER_ROLE_SETTING_KEY,
} from "../services/CommandPermissionService";
import { GoogleSheetsService } from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";
import { trackedMessageService } from "../services/TrackedMessageService";
import { wrapDiscordLink } from "../services/FwaLayoutService";
import {
  WarComplianceService,
  type WarComplianceIssue,
} from "../services/WarComplianceService";
import { WarEventLogService } from "../services/WarEventLogService";
import { buildComplianceWarPlanText } from "../services/warPlanDisplay";
import { getClanScopedWarIdAutocompleteChoices } from "../services/WarIdAutocompleteService";
import { FwaStatsWeightService } from "../services/FwaStatsWeightService";
import { FwaStatsWeightCookieService } from "../services/FwaStatsWeightCookieService";
import { getNextWarMailRefreshAtMs } from "../services/refreshSchedule";
import { emojiResolverService } from "../services/emoji/EmojiResolverService";
import { WarEventHistoryService } from "../services/war-events/history";
import {
  buildOutcomeMismatchWarning,
  buildPointsMismatchWarning,
  buildPointsSyncStatusLine,
  buildSyncMismatchWarning,
  deriveWarState,
  deriveOpponentBalanceFromPrimarySnapshot,
  formatMatchTypeLabel,
  formatWarStateLabel,
  getCurrentSyncFromPrevious,
  getSyncDisplay,
  getWarStateRemaining,
  isMissedSyncClan,
  isPointsSiteUpdatedForOpponent,
  type WarStateForSync,
  withSyncModeLabel,
} from "./fwa/matchState";
import {
  asMailConfigInputJson,
  buildDiscordMessageUrl,
  type MatchMailConfig,
  parseForceMailMessageType,
  parseMatchMailConfig,
} from "./fwa/mailConfig";
import { PostedMessageService } from "../services/PostedMessageService";
import {
  WarMailLifecycleService,
  type WarMailLifecycleReconciliationOutcome,
  type WarMailLifecycleNormalizedStatus,
  type WarMailLifecycleStatusDebugInfo,
} from "../services/WarMailLifecycleService";
import type { PointsApiFetchReason } from "../services/PointsFetchTypes";
import { PointsSyncService } from "../services/PointsSyncService";
import {
  chooseMatchTypeResolution,
  inferMatchTypeFromOpponentPoints,
  resolveCurrentWarMatchTypeSignal,
  resolveMatchTypeFromStoredSyncRow,
  type MatchTypeResolution,
  type MatchTypeResolutionSource,
} from "../services/MatchTypeResolutionService";
import {
  PointsDirectFetchGateService,
  type PollerPointsFetchDecision,
  type PointsDirectFetchCaller,
  PointsDirectFetchBlockedError,
  isPointsDirectFetchBlockedError,
} from "../services/PointsDirectFetchGateService";
import {
  buildFwaMailBackCustomId,
  buildFwaBaseSwapSplitPostCustomId,
  createTransientFwaKey,
  buildFwaMailConfirmCustomId,
  buildFwaMailConfirmNoPingCustomId,
  buildFwaMailRefreshCustomId,
  buildFwaMatchAllianceCustomId,
  buildFwaMatchCopyCustomId,
  buildFwaMatchSelectCustomId,
  buildFwaMatchSendMailCustomId,
  buildFwaMatchTieBreakerCustomId,
  buildMatchSkipSyncActionCustomId,
  buildMatchSkipSyncConfirmCustomId,
  buildMatchSkipSyncUndoCustomId,
  buildMatchSyncActionCustomId,
  buildMatchTypeActionCustomId,
  buildMatchTypeEditCustomId,
  buildOutcomeActionCustomId,
  buildPointsPostButtonCustomId,
  parseFwaMailBackCustomId,
  parseFwaBaseSwapSplitPostCustomId,
  parseFwaComplianceViewCustomId,
  parseFwaMailConfirmCustomId,
  parseFwaMailConfirmNoPingCustomId,
  parseFwaMailRefreshCustomId,
  parseFwaMatchAllianceCustomId,
  parseFwaMatchCopyCustomId,
  parseFwaMatchSelectCustomId,
  parseFwaMatchSendMailCustomId,
  parseFwaMatchTieBreakerCustomId,
  parseMatchSkipSyncActionCustomId,
  parseMatchSkipSyncConfirmCustomId,
  parseMatchSkipSyncUndoCustomId,
  parseMatchSyncActionCustomId,
  parseMatchTypeActionCustomId,
  parseMatchTypeEditCustomId,
  parseOutcomeActionCustomId,
  parsePointsPostButtonCustomId,
} from "./fwa/customIds";
import {
  classifyPointsLookupState,
  extractActiveFwa,
  extractField,
  extractMatchupBalances,
  extractMatchupHeader,
  extractPointBalance,
  extractSyncNumber,
  extractTagsFromText,
  extractTopSectionText,
  extractWinnerBoxText,
  hasWinnerBoxNotMarkedFwaSignal,
  parseCocApiTime,
  type PointsLookupState,
  sanitizeClanName,
  toPlainText,
} from "./fwa/dataParsers";
import {
  buildLimitedMessage,
  compareTagsForTiebreak,
  formatPoints,
  getWinnerMarkerForSide,
  getSyncMode,
  limitDiscordContent,
} from "./fwa/matchUtils";
import {
  resolveWarMailEmbedColor,
  type WarMailExpectedOutcome,
  type WarMailMatchType,
} from "./fwa/mailEmbedColor";
import {
  buildFwaComplianceEmbedView,
  type FwaComplianceActiveView,
} from "./fwa/complianceEmbedView";
import {
  WEIGHT_SEVERE_STALE_DAYS,
  WEIGHT_STALE_DAYS,
  buildWeightAuthFailureNote,
  formatWeightAgeLine,
  formatWeightHealthLine,
  getWeightHealthState,
} from "./fwa/weightView";
import {
  deriveSyncActionSiteOutcome,
  evaluatePostSyncValidation,
  hasRenderedOutcomeMismatch,
} from "./fwa/syncAction";
import { buildActionableSyncStateLine } from "./fwa/syncDisplay";
import {
  selectWarScopedReuseRow,
  type WarScopedSyncReuseRow,
} from "./fwa/warScopedReuse";
export { isMissedSyncClanForTest } from "./fwa/matchState";
export {
  isFwaComplianceViewButtonCustomId,
  isFwaBaseSwapSplitPostButtonCustomId,
  isFwaMailBackButtonCustomId,
  isFwaMailConfirmButtonCustomId,
  isFwaMailConfirmNoPingButtonCustomId,
  isFwaMailRefreshButtonCustomId,
  isFwaMatchAllianceButtonCustomId,
  isFwaMatchCopyButtonCustomId,
  isFwaMatchSelectCustomId,
  isFwaMatchSendMailButtonCustomId,
  isFwaMatchTieBreakerButtonCustomId,
  isFwaMatchSkipSyncActionButtonCustomId,
  isFwaMatchSkipSyncConfirmButtonCustomId,
  isFwaMatchSkipSyncUndoButtonCustomId,
  isFwaMatchSyncActionButtonCustomId,
  isFwaMatchTypeActionButtonCustomId,
  isFwaMatchTypeEditButtonCustomId,
  isFwaOutcomeActionButtonCustomId,
  isPointsPostButtonCustomId,
} from "./fwa/customIds";
const POINTS_BASE_URL = "https://points.fwafarm.com/clan?tag=";
const POINTS_CACHE_VERSION = 5;
const POINTS_SNAPSHOT_CACHE_TTL_MS = 90 * 1000;
const WAR_MAIL_REFRESH_MS = 20 * 60 * 1000;
const MAILBOX_SENT_EMOJI = "📬";
const MAILBOX_NOT_SENT_EMOJI = "📭";
const postedMessageService = new PostedMessageService();
const warMailLifecycleService = new WarMailLifecycleService();
const pointsSyncService = new PointsSyncService();
const warComplianceService = new WarComplianceService();
const fwaStatsWeightService = new FwaStatsWeightService();
const fwaStatsWeightCookieService = new FwaStatsWeightCookieService();
const pointsDirectFetchGate = new PointsDirectFetchGateService();

type FwaBaseSwapSection = "war_bases" | "base_errors";

type FwaBaseSwapAnnouncementEntry = {
  position: number;
  playerTag: string;
  playerName: string;
  discordUserId: string | null;
  townhallLevel: number | null;
  section: FwaBaseSwapSection;
  acknowledged: boolean;
};

type FwaBaseSwapLayoutLink = {
  townhall: number;
  layoutLink: string;
};

type FwaBaseSwapAnnouncementState = {
  guildId: string;
  channelId: string;
  messageId: string;
  clanTag: string;
  clanName: string;
  createdByUserId: string;
  entries: FwaBaseSwapAnnouncementEntry[];
  layoutLinks?: FwaBaseSwapLayoutLink[];
  phaseTimingLine?: string | null;
  alertEmoji?: string | null;
  layoutBulletEmoji?: string | null;
  createdAtIso: string;
};

const FWA_BASE_SWAP_TTL_MS = 48 * 60 * 60 * 1000;
export const FWA_BASE_SWAP_ACK_EMOJI = "✅";
const FWA_BASE_SWAP_LAYOUT_TYPE = "RISINGDAWN";
const FWA_BASE_SWAP_ALERT_EMOJI_NAME = "alert";
const FWA_BASE_SWAP_LAYOUT_BULLET_EMOJI_NAME = "arrow_arrow";
export const FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI = "\u26A0\uFE0F";
export const FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI = "\u27A1\uFE0F";
const FWA_BASE_SWAP_DM_ACTIVE_PREFIX = "ACTIVE WAR BASE: swap to FWA now";
const FWA_BASE_SWAP_DM_ACTIVE_LABEL = "Active war base messages:";
const FWA_BASE_SWAP_DM_BASE_ERROR_LABEL = "Base error messages:";
const FWA_BASE_SWAP_DM_SECTION_SEPARATOR = "----------";
const FWA_BASE_SWAP_DM_MAX_PINGS_PER_LINE = 5;
const FWA_BASE_SWAP_DM_MAX_LINE_CHARS = 256;
const FWA_BASE_SWAP_DM_FAILURE_NOTICE =
  "Posted the base-swap message, but I couldn't DM you the in-game ping messages.";
const FWA_BASE_SWAP_SECTION_SEPARATOR = "──────────────────────────────────";
const FWA_BASE_SWAP_REACT_LINE = `👇 React with ${FWA_BASE_SWAP_ACK_EMOJI} once your base is fixed.`;
const FWA_BASE_SWAP_SPLIT_PROMPT = "This base-swap post is too large for one Discord message. Post it as 2 separate posts?";

type FwaBaseSwapRenderVariant = "single" | "split_part_1" | "split_part_2";

type FwaBaseSwapRenderPlan = {
  singleContent: string;
  splitContents: [string, string] | null;
  fitsSingleMessage: boolean;
};

type FwaBaseSwapSplitPostPayload = {
  userId: string;
  guildId: string;
  channelId: string;
  clanTag: string;
  clanName: string;
  entries: FwaBaseSwapAnnouncementEntry[];
  layoutLinks?: FwaBaseSwapLayoutLink[];
  phaseTimingLine?: string | null;
  alertEmoji?: string | null;
  layoutBulletEmoji?: string | null;
  mentionUserIds: string[];
  createdAtIso: string;
  splitContents: [string, string];
};

type FwaBaseSwapResolvedInlineEmojis = {
  alertEmoji: string;
  layoutBulletEmoji: string;
};

function isFwaBaseSwapExpired(
  state: FwaBaseSwapAnnouncementState,
  nowMs: number = Date.now(),
): boolean {
  const createdAtMs = Date.parse(state.createdAtIso);
  if (!Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs >= FWA_BASE_SWAP_TTL_MS;
}

export async function expireFwaBaseSwapAnnouncementState(
  messageId: string,
): Promise<void> {
  await trackedMessageService.markMessageDeleted(messageId);
}

export async function sweepExpiredFwaBaseSwapAnnouncementStates(): Promise<number> {
  return trackedMessageService.processDueExpirations();
}

export async function handleFwaBaseSwapReaction(
  messageId: string,
  reactorUserId: string,
  message: {
    id: string;
    channelId: string;
    client: Client;
    edit: (payload: {
      content: string;
      allowedMentions: { users: string[] };
    }) => Promise<unknown>;
  },
): Promise<boolean> {
  return trackedMessageService.handleFwaBaseSwapReaction({
    messageId,
    reactorUserId,
    message,
    render: renderFwaBaseSwapAnnouncement,
    resolveMessageForEdit: async ({ channelId, messageId: targetMessageId }) => {
      if (targetMessageId === message.id) return message;
      const channel = await message.client.channels
        .fetch(channelId)
        .catch(() => null);
      if (!channel || !channel.isTextBased() || !("messages" in channel)) {
        return null;
      }
      return (channel as any).messages.fetch(targetMessageId).catch(() => null);
    },
  });
}

export async function handleFwaBaseSwapSplitPostButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaBaseSwapSplitPostCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const payload = fwaBaseSwapSplitPostPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This base-swap split prompt expired. Please run `/fwa base-swap` again.",
    });
    return;
  }

  if (parsed.action === "cancel") {
    fwaBaseSwapSplitPostPayloads.delete(parsed.key);
    await interaction.update({
      content: "Cancelled. No split base-swap posts were published.",
      components: [],
    });
    return;
  }

  const channel = interaction.channel;
  if (
    !channel ||
    !channel.isTextBased() ||
    !("send" in channel) ||
    interaction.guildId !== payload.guildId ||
    interaction.channelId !== payload.channelId
  ) {
    await interaction.reply({
      ephemeral: true,
      content: "Could not post split base-swap messages in this channel.",
    });
    return;
  }

  try {
    const postedA = await (channel as any).send({
      content: payload.splitContents[0],
      allowedMentions: { users: payload.mentionUserIds },
    });
    const postedB = await (channel as any).send({
      content: payload.splitContents[1],
      allowedMentions: { users: payload.mentionUserIds },
    });

    const expiresAt = new Date(Date.now() + FWA_BASE_SWAP_TTL_MS);
    await trackedMessageService.createFwaBaseSwapTrackedMessages({
      guildId: payload.guildId,
      clanTag: payload.clanTag,
      expiresAt,
      referenceId: `fwa-base-swap:${parsed.key}`,
      messages: [
        {
          channelId: payload.channelId,
          messageId: postedA.id,
          metadata: {
            clanName: payload.clanName,
            createdByUserId: payload.userId,
            createdAtIso: payload.createdAtIso,
            entries: payload.entries,
            layoutLinks: payload.layoutLinks,
            phaseTimingLine: payload.phaseTimingLine,
            alertEmoji: payload.alertEmoji,
            layoutBulletEmoji: payload.layoutBulletEmoji,
            renderVariant: "split_part_1",
          },
        },
        {
          channelId: payload.channelId,
          messageId: postedB.id,
          metadata: {
            clanName: payload.clanName,
            createdByUserId: payload.userId,
            createdAtIso: payload.createdAtIso,
            entries: payload.entries,
            layoutLinks: payload.layoutLinks,
            phaseTimingLine: payload.phaseTimingLine,
            alertEmoji: payload.alertEmoji,
            layoutBulletEmoji: payload.layoutBulletEmoji,
            renderVariant: "split_part_2",
          },
        },
      ],
    });

    await postedA.react(FWA_BASE_SWAP_ACK_EMOJI).catch((err: unknown) => {
      console.error(
        `[fwa base-swap] react failed guild=${payload.guildId} channel=${payload.channelId} message=${postedA.id} emoji=${FWA_BASE_SWAP_ACK_EMOJI} user=${payload.userId} error=${formatError(
          err,
        )}`,
      );
    });
    await postedB.react(FWA_BASE_SWAP_ACK_EMOJI).catch((err: unknown) => {
      console.error(
        `[fwa base-swap] react failed guild=${payload.guildId} channel=${payload.channelId} message=${postedB.id} emoji=${FWA_BASE_SWAP_ACK_EMOJI} user=${payload.userId} error=${formatError(
          err,
        )}`,
      );
    });

    await deliverFwaBaseSwapDmMessages({
      entries: payload.entries,
      guildId: payload.guildId,
      channelId: payload.channelId,
      clanTag: payload.clanTag,
      userId: payload.userId,
      sendDm: async (content) => interaction.user.send({ content }),
      sendFailureNotice: async (content) =>
        interaction.followUp({ content, ephemeral: true }),
    });

    fwaBaseSwapSplitPostPayloads.delete(parsed.key);
    await interaction.update({
      content: `Posted split base swap announcements for **${payload.clanName}** (#${payload.clanTag}).\n${postedA.url}\n${postedB.url}`,
      components: [],
    });
  } catch (err) {
    console.error(
      `[fwa base-swap] split publish failed guild=${payload.guildId} channel=${payload.channelId} clan=#${payload.clanTag} user=${payload.userId} error=${formatError(
        err,
      )}`,
    );
    await interaction.reply({
      ephemeral: true,
      content: "Failed to publish split base-swap posts. Please try `/fwa base-swap` again.",
    });
  }
}

function parseBaseSwapPositionList(input: string | null | undefined): number[] {
  if (!input) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of String(input)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (!/^\d+$/.test(part)) continue;
    const parsed = Number.parseInt(part, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : null;
}

function getBaseSwapTownhallLevel(member: unknown): number | null {
  if (!member || typeof member !== "object") return null;
  const record = member as Record<string, unknown>;
  const rawTownhall = record.townhallLevel ?? record.townHallLevel;
  return toPositiveIntegerOrNull(rawTownhall);
}

function collectBaseSwapTownhallLevels(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
): number[] {
  return [...new Set(entries.map((entry) => entry.townhallLevel))]
    .filter(
      (townhall): townhall is number =>
        typeof townhall === "number" &&
        Number.isInteger(townhall) &&
        townhall > 0,
    )
    .sort((a, b) => b - a);
}

function resolveRenderableBaseSwapLayoutLinks(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
  layoutLinks: readonly FwaBaseSwapLayoutLink[] | undefined,
): FwaBaseSwapLayoutLink[] {
  if (!Array.isArray(layoutLinks) || layoutLinks.length === 0) return [];
  const townhalls = collectBaseSwapTownhallLevels(entries);
  if (townhalls.length === 0) return [];

  const linkByTownhall = new Map<number, string>();
  for (const row of layoutLinks) {
    if (!row || typeof row !== "object") continue;
    const townhall = toPositiveIntegerOrNull(row.townhall);
    const layoutLink = String(row.layoutLink ?? "").trim();
    if (townhall === null || !layoutLink || linkByTownhall.has(townhall)) continue;
    linkByTownhall.set(townhall, layoutLink);
  }

  return townhalls.flatMap((townhall) => {
    const layoutLink = linkByTownhall.get(townhall);
    if (!layoutLink) return [];
    return [{ townhall, layoutLink }];
  });
}

function buildBaseSwapLayoutLinks(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
  rows: ReadonlyArray<{ Townhall: number; LayoutLink: string }>,
): FwaBaseSwapLayoutLink[] {
  if (rows.length === 0) return [];
  const rowLinks: FwaBaseSwapLayoutLink[] = rows.map((row) => ({
    townhall: row.Townhall,
    layoutLink: row.LayoutLink,
  }));
  return resolveRenderableBaseSwapLayoutLinks(entries, rowLinks);
}

function renderBaseSwapLine(entry: FwaBaseSwapAnnouncementEntry): string {
  const mention = entry.discordUserId
    ? `<@${entry.discordUserId}>`
    : "*(unlinked)*";
  const mark = entry.acknowledged ? "✅" : ":x:";
  return `#${entry.position} - ${mention} - ${entry.playerName} - ${mark}`;
}

/** Purpose: normalize one in-game ping token from a base-swap entry using the existing player-name source. */
function buildFwaBaseSwapInGamePingToken(
  entry: FwaBaseSwapAnnouncementEntry,
): string | null {
  const normalizedPlayerName = String(entry.playerName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedPlayerName) return null;
  return normalizedPlayerName.startsWith("@")
    ? normalizedPlayerName
    : `@${normalizedPlayerName}`;
}

/** Purpose: pack ping tokens into single-line copy blocks under deterministic ping-count and character limits. */
function batchFwaBaseSwapPingLines(
  prefix: string,
  pingTokens: readonly string[],
): string[] {
  const normalizedPrefix = String(prefix).replace(/\s+/g, " ").trim();
  if (!normalizedPrefix) return [];
  const lines: string[] = [];
  let currentTokens: string[] = [];

  const flushCurrent = () => {
    if (currentTokens.length === 0) return;
    lines.push(`${normalizedPrefix} ${currentTokens.join(" ")}`);
    currentTokens = [];
  };

  for (const rawToken of pingTokens) {
    const token = String(rawToken).replace(/\s+/g, " ").trim();
    if (!token) continue;
    const singleTokenLine = `${normalizedPrefix} ${token}`;
    if (singleTokenLine.length > FWA_BASE_SWAP_DM_MAX_LINE_CHARS) continue;

    if (currentTokens.length === 0) {
      currentTokens.push(token);
      continue;
    }

    const candidateTokens = [...currentTokens, token];
    const candidateLine = `${normalizedPrefix} ${candidateTokens.join(" ")}`;
    const exceedsPingLimit =
      candidateTokens.length > FWA_BASE_SWAP_DM_MAX_PINGS_PER_LINE;
    const exceedsCharLimit = candidateLine.length > FWA_BASE_SWAP_DM_MAX_LINE_CHARS;
    if (exceedsPingLimit || exceedsCharLimit) {
      flushCurrent();
      currentTokens.push(token);
      continue;
    }

    currentTokens.push(token);
  }

  flushCurrent();
  return lines;
}

/** Purpose: build ACTIVE WAR BASE copy/paste lines from finalized base-swap announcement ordering. */
function buildFwaBaseSwapActiveWarDmLines(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
): string[] {
  const pingTokens = entries
    .filter((entry) => entry.section === "war_bases")
    .flatMap((entry) => {
      const token = buildFwaBaseSwapInGamePingToken(entry);
      return token ? [token] : [];
    });
  return batchFwaBaseSwapPingLines(FWA_BASE_SWAP_DM_ACTIVE_PREFIX, pingTokens);
}

/** Purpose: build TH-grouped base-error copy/paste lines while preserving original member order within each TH group. */
function buildFwaBaseSwapBaseErrorDmLines(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
): string[] {
  const orderedTownhalls: number[] = [];
  const tokensByTownhall = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.section !== "base_errors") continue;
    const townhall =
      typeof entry.townhallLevel === "number" &&
      Number.isFinite(entry.townhallLevel) &&
      entry.townhallLevel > 0
        ? Math.trunc(entry.townhallLevel)
        : null;
    if (townhall === null) continue;
    const token = buildFwaBaseSwapInGamePingToken(entry);
    if (!token) continue;
    if (!tokensByTownhall.has(townhall)) {
      tokensByTownhall.set(townhall, []);
      orderedTownhalls.push(townhall);
    }
    tokensByTownhall.get(townhall)!.push(token);
  }

  const lines: string[] = [];
  for (const townhall of orderedTownhalls) {
    const thTokens = tokensByTownhall.get(townhall) ?? [];
    if (thTokens.length === 0) continue;
    const prefix = `TH${townhall} update FWA layout: !th${townhall}`;
    lines.push(...batchFwaBaseSwapPingLines(prefix, thTokens));
  }
  return lines;
}

/** Purpose: present each generated copy line as an individually copyable inline-code block in DMs. */
function wrapFwaBaseSwapDmCopyLine(line: string): string {
  return `\`${line}\``;
}

/** Purpose: compose the final DM body with optional sections and separator while preserving raw line constraints. */
function buildFwaBaseSwapDmContent(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
): string | null {
  const activeWarLines = buildFwaBaseSwapActiveWarDmLines(entries);
  const baseErrorLines = buildFwaBaseSwapBaseErrorDmLines(entries);
  const lines: string[] = [];

  if (activeWarLines.length > 0) {
    lines.push(FWA_BASE_SWAP_DM_ACTIVE_LABEL);
    lines.push(...activeWarLines.map(wrapFwaBaseSwapDmCopyLine));
  }
  if (activeWarLines.length > 0 && baseErrorLines.length > 0) {
    lines.push("", FWA_BASE_SWAP_DM_SECTION_SEPARATOR, "");
  }
  if (baseErrorLines.length > 0) {
    lines.push(FWA_BASE_SWAP_DM_BASE_ERROR_LABEL);
    lines.push(...baseErrorLines.map(wrapFwaBaseSwapDmCopyLine));
  }

  if (lines.length === 0) return null;
  return lines.join("\n");
}

/** Purpose: attempt post-send DM delivery and preserve command success by downgrading DM transport failures to an ephemeral notice. */
async function deliverFwaBaseSwapDmMessages(input: {
  entries: readonly FwaBaseSwapAnnouncementEntry[];
  guildId: string | null;
  channelId: string | null;
  clanTag: string;
  userId: string;
  sendDm: (content: string) => Promise<unknown>;
  sendFailureNotice: (content: string) => Promise<unknown>;
}): Promise<"sent" | "skipped_empty" | "failed_notified" | "failed_unnoticed"> {
  const dmContent = buildFwaBaseSwapDmContent(input.entries);
  if (!dmContent) {
    console.info(
      `[fwa base-swap] dm status=skipped_empty guild=${input.guildId ?? "dm"} channel=${input.channelId ?? "dm"} clan=#${input.clanTag} user=${input.userId}`,
    );
    return "skipped_empty";
  }

  try {
    await input.sendDm(dmContent);
    console.info(
      `[fwa base-swap] dm status=sent guild=${input.guildId ?? "dm"} channel=${input.channelId ?? "dm"} clan=#${input.clanTag} user=${input.userId}`,
    );
    return "sent";
  } catch (err) {
    console.error(
      `[fwa base-swap] dm status=failed guild=${input.guildId ?? "dm"} channel=${input.channelId ?? "dm"} clan=#${input.clanTag} user=${input.userId} error=${formatError(
        err,
      )}`,
    );
  }

  try {
    await input.sendFailureNotice(FWA_BASE_SWAP_DM_FAILURE_NOTICE);
    return "failed_notified";
  } catch (noticeErr) {
    console.error(
      `[fwa base-swap] dm status=failed_notice guild=${input.guildId ?? "dm"} channel=${input.channelId ?? "dm"} clan=#${input.clanTag} user=${input.userId} error=${formatError(
        noticeErr,
      )}`,
    );
    return "failed_unnoticed";
  }
}

/** Purpose: derive unique mentioned Discord user ids from base-swap entries. */
function buildFwaBaseSwapMentionUserIds(
  entries: readonly FwaBaseSwapAnnouncementEntry[],
): string[] {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        entry.discordUserId ? [entry.discordUserId] : [],
      ),
    ),
  ];
}

/** Purpose: build yes/cancel controls for oversized base-swap split-post confirmation. */
function buildFwaBaseSwapSplitPromptComponents(
  userId: string,
  key: string,
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildFwaBaseSwapSplitPostCustomId({
            userId,
            key,
            action: "yes",
          }),
        )
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          buildFwaBaseSwapSplitPostCustomId({
            userId,
            key,
            action: "cancel",
          }),
        )
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function resolveFwaBaseSwapInlineEmojis(
  client: Client,
): Promise<FwaBaseSwapResolvedInlineEmojis> {
  const fallback: FwaBaseSwapResolvedInlineEmojis = {
    alertEmoji: FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI,
    layoutBulletEmoji: FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI,
  };
  const inventoryResult =
    await emojiResolverService.fetchApplicationEmojiInventory(client);
  if (!inventoryResult.ok) {
    return fallback;
  }

  const { snapshot } = inventoryResult;
  const resolveByName = (name: string): string | null => {
    const exact = snapshot.exactByName.get(name);
    if (exact?.rendered) return exact.rendered;
    const lowered = snapshot.lowercaseByName.get(name.toLowerCase());
    if (lowered?.rendered) return lowered.rendered;
    return null;
  };

  return {
    alertEmoji: resolveByName(FWA_BASE_SWAP_ALERT_EMOJI_NAME) ?? fallback.alertEmoji,
    layoutBulletEmoji:
      resolveByName(FWA_BASE_SWAP_LAYOUT_BULLET_EMOJI_NAME) ??
      fallback.layoutBulletEmoji,
  };
}

function renderBaseSwapLayoutLinkLine(
  link: FwaBaseSwapLayoutLink,
  layoutBulletEmoji: string,
): string {
  return `## ${layoutBulletEmoji} TH${link.townhall}: ${wrapDiscordLink(link.layoutLink)}`;
}

function buildFwaBaseSwapPhaseTimingLine(input: {
  warState: WarStateForSync;
  prepEndMs: number | null;
  warEndMs: number | null;
}): string | null {
  if (input.warState !== "preparation" && input.warState !== "inWar") {
    return null;
  }
  const targetMs =
    input.warState === "preparation" ? input.prepEndMs : input.warEndMs;
  if (targetMs === null || !Number.isFinite(targetMs)) return null;
  return `## ${mailStatusLabelForState(input.warState)} ends ${formatDiscordFullAndRelativeMs(targetMs)}`;
}

/** Purpose: materialize deterministic line tokens for base-swap rendering so sizing/splitting can be evaluated before posting. */
function buildFwaBaseSwapAnnouncementLines(state: {
  entries: FwaBaseSwapAnnouncementEntry[];
  layoutLinks?: FwaBaseSwapLayoutLink[];
  phaseTimingLine?: string | null;
  alertEmoji?: string | null;
  layoutBulletEmoji?: string | null;
}): string[] {
  const alertEmoji =
    String(state.alertEmoji ?? "").trim() || FWA_BASE_SWAP_ALERT_FALLBACK_EMOJI;
  const layoutBulletEmoji =
    String(state.layoutBulletEmoji ?? "").trim() ||
    FWA_BASE_SWAP_LAYOUT_BULLET_FALLBACK_EMOJI;
  const warBaseLines = state.entries
    .filter((entry) => entry.section === "war_bases")
    .map(renderBaseSwapLine);
  const baseErrorLines = state.entries
    .filter((entry) => entry.section === "base_errors")
    .map(renderBaseSwapLine);
  const layoutLinkLines = resolveRenderableBaseSwapLayoutLinks(
    state.entries,
    state.layoutLinks,
  ).map((link) => renderBaseSwapLayoutLinkLine(link, layoutBulletEmoji));

  const lines: string[] = [];
  if (warBaseLines.length > 0) {
    lines.push(
      `# ${alertEmoji} YOU HAVE AN ACTIVE WAR BASE ${alertEmoji}`,
      "",
      ...warBaseLines,
      "",
      "**Failure to comply + acknowledge will result in __kick__ before the next sync**",
    );
  }

  if (baseErrorLines.length > 0) {
    if (lines.length > 0) lines.push("", FWA_BASE_SWAP_SECTION_SEPARATOR, "");
    lines.push(
      "# :warning: YOU HAVE BASE ERRORS :warning:",
      "",
      ...baseErrorLines,
    );
  }

  if (lines.length > 0) {
    lines.push("", FWA_BASE_SWAP_SECTION_SEPARATOR);
    if (layoutLinkLines.length > 0) lines.push("", ...layoutLinkLines);
    lines.push("", FWA_BASE_SWAP_SECTION_SEPARATOR);
    if (state.phaseTimingLine) lines.push("", state.phaseTimingLine);
    lines.push("", FWA_BASE_SWAP_REACT_LINE);
  }

  return lines;
}

/** Purpose: score split boundaries to prefer separators/section starts while keeping output balanced and deterministic. */
function scoreFwaBaseSwapSplitBoundary(input: {
  allLines: readonly string[];
  splitIndex: number;
}): number {
  const prev = input.allLines[input.splitIndex - 1] ?? "";
  const next = input.allLines[input.splitIndex] ?? "";
  let score = 0;
  if (prev === FWA_BASE_SWAP_SECTION_SEPARATOR || next === FWA_BASE_SWAP_SECTION_SEPARATOR) {
    score += 1000;
  }
  if (next.startsWith("# ")) score += 200;
  if (next.startsWith("## ")) score += 100;
  if (!prev.trim() || !next.trim()) score += 25;
  return score;
}

/** Purpose: split oversized base-swap content into exactly two valid Discord messages without breaking individual lines. */
function splitFwaBaseSwapAnnouncementLines(
  lines: readonly string[],
): [string, string] | null {
  if (lines.length < 2) return null;
  let best: { first: string; second: string; score: number } | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const first = lines.slice(0, index).join("\n");
    const second = lines.slice(index).join("\n");
    if (
      first.length > DISCORD_CONTENT_LIMIT ||
      second.length > DISCORD_CONTENT_LIMIT
    ) {
      continue;
    }
    if (!first.trim() || !second.trim()) continue;
    const balancePenalty = Math.abs(first.length - second.length);
    const score =
      scoreFwaBaseSwapSplitBoundary({ allLines: lines, splitIndex: index }) -
      balancePenalty;
    if (!best || score > best.score) {
      best = { first, second, score };
    }
  }
  return best ? [best.first, best.second] : null;
}

/** Purpose: build posting plan for base-swap messages and determine whether split fallback is available without truncation. */
function buildFwaBaseSwapRenderPlan(state: {
  entries: FwaBaseSwapAnnouncementEntry[];
  layoutLinks?: FwaBaseSwapLayoutLink[];
  phaseTimingLine?: string | null;
  alertEmoji?: string | null;
  layoutBulletEmoji?: string | null;
}): FwaBaseSwapRenderPlan {
  const lines = buildFwaBaseSwapAnnouncementLines(state);
  const singleContent = lines.join("\n");
  if (singleContent.length <= DISCORD_CONTENT_LIMIT) {
    return {
      singleContent,
      splitContents: null,
      fitsSingleMessage: true,
    };
  }
  return {
    singleContent,
    splitContents: splitFwaBaseSwapAnnouncementLines(lines),
    fitsSingleMessage: false,
  };
}

function renderFwaBaseSwapAnnouncement(
  state: {
    entries: FwaBaseSwapAnnouncementEntry[];
    layoutLinks?: FwaBaseSwapLayoutLink[];
    phaseTimingLine?: string | null;
    alertEmoji?: string | null;
    layoutBulletEmoji?: string | null;
    renderVariant?: FwaBaseSwapRenderVariant;
  },
): string {
  const plan = buildFwaBaseSwapRenderPlan(state);
  if (state.renderVariant === "split_part_1" && plan.splitContents) {
    return plan.splitContents[0];
  }
  if (state.renderVariant === "split_part_2" && plan.splitContents) {
    return plan.splitContents[1];
  }
  return plan.singleContent;
}
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
  snapshotSource: "direct" | "tracked_clan_fallback";
  lookupState: PointsLookupState;
  balance: number | null;
  clanName: string | null;
  activeFwa: boolean | null;
  notFound: boolean;
  winnerBoxText: string | null;
  winnerBoxTags: string[];
  winnerBoxSync: number | null;
  effectiveSync: number | null;
  syncMode: "low" | "high" | null;
  winnerBoxHasTag: boolean;
  headerPrimaryName?: string | null;
  headerOpponentName?: string | null;
  fallbackCurrentForWar?: boolean;
  fallbackExtractedOpponentTag?: string | null;
  headerPrimaryTag: string | null;
  headerOpponentTag: string | null;
  headerPrimaryBalance: number | null;
  headerOpponentBalance: number | null;
  warEndMs: number | null;
  lastWarCheckAtMs: number;
  fetchedAtMs: number;
  refreshedForWarEndMs: number | null;
};

type PointsSnapshotCacheEntry = {
  snapshot: PointsSnapshot;
  expiresAtMs: number;
};

type SyncValidationState = {
  siteCurrent: boolean;
  syncRowMissing: boolean;
  differences: string[];
  statusLine: string;
};

function getOwnerBypassIds(): Set<string> {
  const raw =
    process.env.OWNER_DISCORD_USER_IDS ??
    process.env.OWNER_DISCORD_USER_ID ??
    "";
  const ids = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
  return new Set(ids);
}

function hasOwnerBypassUserId(userId: string): boolean {
  return getOwnerBypassIds().has(userId);
}

async function getButtonInteractionRoleIds(
  interaction: ButtonInteraction,
): Promise<string[]> {
  if (!interaction.inGuild()) return [];

  const member = interaction.member;
  if (member && "roles" in member) {
    const roles = member.roles;
    if (Array.isArray(roles)) return roles;
    if (roles && "cache" in roles) {
      return [...roles.cache.keys()];
    }
  }

  const guild = interaction.guild;
  if (!guild) return [];
  const fetched = await guild.members.fetch(interaction.user.id);
  return [...fetched.roles.cache.keys()];
}

async function canUseFwaMailSendFromButton(
  interaction: ButtonInteraction,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  if (hasOwnerBypassUserId(interaction.user.id)) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    return true;

  const permissionService = new CommandPermissionService();
  const explicitRoles =
    await permissionService.getAllowedRoleIds("fwa:mail:send");
  const userRoles = await getButtonInteractionRoleIds(interaction);
  if (explicitRoles.length > 0) {
    return explicitRoles.some((roleId) => userRoles.includes(roleId));
  }

  const leaderRoleId =
    (await permissionService.getFwaLeaderRoleId(interaction.guildId)) ??
    (await new SettingsService().get(
      `${FWA_LEADER_ROLE_SETTING_KEY}:${interaction.guildId}`,
    ));
  if (!leaderRoleId) return false;
  return userRoles.includes(leaderRoleId);
}

/** Purpose: gate `/fwa match` mail debug details to the same leadership/admin policy as mail send. */
async function canViewFwaMatchMailDebug(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  const permissionService = new CommandPermissionService();
  return permissionService.canUseCommand("fwa:mail:send", interaction);
}

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

type ComplianceWarTarget =
  | { scope: "current"; warId: number; requested: "current" }
  | { scope: "war_id"; warId: number; requested: "war_id" };

/**
 * The purpose of this function is to parse and validate the `war-id` input for compliance warplan text resolution,
 * supporting both "current" scope and explicit war ID lookups, while providing structured error feedback for invalid inputs.
 *
 * @param input
 * @returns
 */
/** Purpose: parse `/fwa compliance war-id` text into deterministic scope selection. */
function parseComplianceWarTarget(
  input: string | null | undefined,
): { ok: true; value: ComplianceWarTarget } | { ok: false; error: string } {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return {
      ok: false,
      error:
        "Please choose a `war-id` from autocomplete (`Ongoing`, opponent name, or a numeric war ID).",
    };
  }

  const lowered = raw.toLowerCase();
  if (lowered === "ongoing") {
    return {
      ok: true,
      value: { scope: "current", warId: -1, requested: "current" },
    };
  }

  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        ok: true,
        value: {
          scope: "war_id",
          warId: Math.trunc(parsed),
          requested: "war_id",
        },
      };
    }
  }

  return {
    ok: false,
    error:
      "Invalid `war-id`. Use `Ongoing` or select a numeric war ID from autocomplete.",
  };
}

/** Purpose: render a stored compliance-view payload into message-safe embed/components. */
function renderComplianceViewPayload(input: {
  key: string;
  payload: FwaComplianceViewPayload;
}): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const rendered = buildFwaComplianceEmbedView({
    userId: input.payload.userId,
    key: input.key,
    isFwa: input.payload.isFwa,
    clanName: input.payload.clanName,
    warPlanText: input.payload.warPlanText,
    warId: input.payload.warId,
    expectedOutcome: input.payload.expectedOutcome,
    fwaWinGateConfig: input.payload.fwaWinGateConfig,
    warStartTime: input.payload.warStartTime,
    warEndTime: input.payload.warEndTime,
    participantsCount: input.payload.participantsCount,
    attacksCount: input.payload.attacksCount,
    missedBoth: input.payload.missedBoth,
    notFollowingPlan: input.payload.notFollowingPlan,
    activeView: input.payload.activeView,
    mainPage: input.payload.mainPage,
    missedPage: input.payload.missedPage,
  });
  input.payload.mainPage = rendered.mainPage;
  input.payload.missedPage = rendered.missedPage;
  return {
    embeds: [rendered.embed],
    components: rendered.components,
  };
}

/** Purpose: resolve compliance warplan text from the same active plan source used by war mail, then format it for compliance display. */
async function resolveComplianceWarPlanText(input: {
  guildId: string;
  clanTag: string;
  clanName: string;
  opponentName: string | null;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  forcedLoseStyle?: "TRADITIONAL" | "TRIPLE_TOP_30" | null;
  cocService: CoCService;
}): Promise<string> {
  if (input.matchType !== "FWA") {
    return buildComplianceWarPlanText(null);
  }
  const history = new WarEventHistoryService(input.cocService);
  const planText = await history.buildWarPlanText(
    input.guildId,
    input.matchType,
    input.expectedOutcome,
    input.clanTag,
    input.opponentName,
    "battle",
    input.clanName,
    { forcedLoseStyle: input.forcedLoseStyle ?? null },
  );
  return buildComplianceWarPlanText(planText);
}

/** Purpose: normalize stored role values to a raw Discord role ID. */
function normalizeDiscordRoleId(
  input: string | null | undefined,
): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const idMatch = raw.match(/\d{5,}/);
  return idMatch?.[0] ?? null;
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

const FWA_MATCH_TIEBREAKER_RULES_URL = "https://i.imgur.com/lvoJgZB.png";

/** Purpose: build shared single-clan link presentation to keep render paths consistent. */
function buildSingleClanMatchLinks(input: {
  trackedClanTag: string;
  opponentTag: string;
}): {
  pointsFieldName: string;
  linksFieldName: string;
  linksFieldValue: string;
  copyLines: string[];
} {
  const opponentCcUrl = buildCcVerifyUrl(input.opponentTag);
  const trackedPointsUrl = buildOfficialPointsUrl(input.trackedClanTag);
  return {
    pointsFieldName: "Points",
    linksFieldName: "Links",
    linksFieldValue: `[cc.fwafarm](<${opponentCcUrl}>)\n[points.fwafarm](<${trackedPointsUrl}>)`,
    copyLines: [
      `CC (opponent): [cc.fwafarm](<${opponentCcUrl}>)`,
      `Points (tracked clan): [points.fwafarm](<${trackedPointsUrl}>)`,
    ],
  };
}

const MATCHTYPE_WARNING_LEGEND =
  ":warning: Match type is inferred. Sending is still allowed, but confirm before posting if this looks wrong.";
const POINTS_CLAN_NOT_FOUND_STATUS_LINE =
  ":interrobang: Clan not found on points.fwafarm";

function logFwaMatchTelemetry(event: string, detail: string): void {
  console.log(`[telemetry-fwa-match] event=${event} ${detail}`);
}

type MatchTypeResolutionLogStage = "mail_embed" | "alliance_view" | "single_view";

/** Purpose: build stable match-type log identity for one clan+war+stage. */
function buildMatchTypeResolutionLogIdentity(params: {
  stage: MatchTypeResolutionLogStage;
  clanTag: string;
  warId: number | null | undefined;
}): string {
  const warIdText =
    params.warId !== null &&
    params.warId !== undefined &&
    Number.isFinite(params.warId)
      ? String(Math.trunc(params.warId))
      : "unknown";
  return `matchtype|stage=${params.stage}|clan=${normalizeTag(params.clanTag)}|war=${warIdText}`;
}

/** Purpose: build match-type state signature used for steady-state info suppression. */
function buildMatchTypeResolutionLogSignature(params: {
  source: MatchTypeResolutionSource;
  matchType: "FWA" | "BL" | "MM" | "SKIP";
  inferred: boolean;
  confirmed: boolean;
}): string {
  return `source=${params.source}|match_type=${params.matchType}|inferred=${params.inferred ? "1" : "0"}|confirmed=${params.confirmed ? "1" : "0"}`;
}

/** Purpose: emit info only when match-type state changes for the same clan+war+stage identity. */
function resolveMatchTypeResolutionLogLevel(params: {
  stage: MatchTypeResolutionLogStage;
  clanTag: string;
  warId: number | null | undefined;
  source: MatchTypeResolutionSource;
  matchType: "FWA" | "BL" | "MM" | "SKIP";
  inferred: boolean;
  confirmed: boolean;
}): "info" | "debug" {
  return resolveSteadyStateLogLevel({
    gate: fwaMatchTypeResolutionLogGate,
    identity: buildMatchTypeResolutionLogIdentity({
      stage: params.stage,
      clanTag: params.clanTag,
      warId: params.warId,
    }),
    signature: buildMatchTypeResolutionLogSignature({
      source: params.source,
      matchType: params.matchType,
      inferred: params.inferred,
      confirmed: params.confirmed,
    }),
  });
}

/** Purpose: build stable routine blocked-fetch identity for one guild+clan+fetch reason. */
function buildRoutineBlockedPointsFetchLogIdentity(params: {
  guildId: string;
  clanTag: string;
  fetchReason: PointsApiFetchReason;
}): string {
  return `points_skip|guild=${params.guildId}|clan=${normalizeTag(params.clanTag)}|fetch_reason=${params.fetchReason}`;
}

/** Purpose: build routine blocked-fetch state signature for steady-state suppression. */
function buildRoutineBlockedPointsFetchLogSignature(params: {
  outcome: PollerPointsFetchDecision["outcome"];
  decisionCode: PollerPointsFetchDecision["decisionCode"];
}): string {
  return `outcome=${params.outcome}|code=${params.decisionCode}`;
}

/** Purpose: emit info only when routine blocked-fetch state changes for one guild+clan reason. */
function resolveRoutineBlockedPointsFetchSkipLogLevel(params: {
  guildId: string;
  clanTag: string;
  fetchReason: PointsApiFetchReason;
  outcome: PollerPointsFetchDecision["outcome"];
  decisionCode: PollerPointsFetchDecision["decisionCode"];
}): "info" | "debug" {
  return resolveSteadyStateLogLevel({
    gate: fwaRoutinePointsSkipLogGate,
    identity: buildRoutineBlockedPointsFetchLogIdentity({
      guildId: params.guildId,
      clanTag: params.clanTag,
      fetchReason: params.fetchReason,
    }),
    signature: buildRoutineBlockedPointsFetchLogSignature({
      outcome: params.outcome,
      decisionCode: params.decisionCode,
    }),
  });
}

/** Purpose: clear in-memory steady-state log trackers for deterministic tests. */
function resetFwaSteadyStateLogTrackers(): void {
  fwaMatchTypeResolutionLogGate.clear();
  fwaRoutinePointsSkipLogGate.clear();
}

/** Purpose: emit structured logs for match-type source/inference/confirmation decisions. */
function logMatchTypeResolution(params: {
  stage: MatchTypeResolutionLogStage;
  clanTag: string;
  opponentTag: string | null;
  warId: number | null | undefined;
  source: MatchTypeResolutionSource;
  matchType: "FWA" | "BL" | "MM" | "SKIP";
  inferred: boolean;
  confirmed: boolean;
}): void {
  const warIdText =
    params.warId !== null &&
    params.warId !== undefined &&
    Number.isFinite(params.warId)
      ? String(Math.trunc(params.warId))
      : "unknown";
  const opponent = normalizeTag(String(params.opponentTag ?? ""));
  const line = `[fwa-matchtype] stage=${params.stage} clan=#${normalizeTag(params.clanTag)} opponent=${opponent ? `#${opponent}` : "unknown"} war_id=${warIdText} source=${params.source} match_type=${params.matchType} inferred=${params.inferred ? "1" : "0"} confirmed=${params.confirmed ? "1" : "0"}`;
  const logLevel = resolveMatchTypeResolutionLogLevel({
    stage: params.stage,
    clanTag: params.clanTag,
    warId: params.warId,
    source: params.source,
    matchType: params.matchType,
    inferred: params.inferred,
    confirmed: params.confirmed,
  });
  if (logLevel === "info") {
    console.info(line);
    return;
  }
  console.debug(line);
}

type MatchView = {
  embed: EmbedBuilder;
  copyText: string;
  matchTypeAction?: { tag: string; currentType: "FWA" | "BL" | "MM" } | null;
  matchTypeCurrent?: "FWA" | "BL" | "MM" | "SKIP" | null;
  inferredMatchType?: boolean;
  outcomeAction?: { tag: string; currentOutcome: "WIN" | "LOSE" } | null;
  syncAction?: {
    tag: string;
    siteMatchType: "FWA" | "BL" | "MM" | null;
    siteFwaPoints: number | null;
    siteOpponentFwaPoints: number | null;
    siteOutcome: "WIN" | "LOSE" | null;
    siteSyncNumber: number | null;
  } | null;
  clanName?: string;
  clanTag?: string;
  mailStatusEmoji?: string;
  mailAction?: { tag: string; enabled: boolean; reason: string | null };
  skipSyncAction?: { tag: string } | null;
  undoSkipSyncAction?: { tag: string } | null;
  lifecycleStatus?: WarMailLifecycleNormalizedStatus;
  hasMailChannel?: boolean;
  liveRevisionFields?: MatchRevisionFields | null;
  confirmedRevisionBaseline?: MatchRevisionFields | null;
  effectiveRevisionFields?: MatchRevisionFields | null;
  appliedDraftRevision?: MatchRevisionFields | null;
  draftDiffersFromBaseline?: boolean;
  projectedFwaOutcome?: "WIN" | "LOSE" | null;
};

type MatchRevisionFields = {
  warId: string | null;
  opponentTag: string | null;
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
};

type FwaMatchCopyPayload = {
  userId: string;
  guildId: string | null;
  includePostButton: boolean;
  allianceView: MatchView;
  allianceViewIsScoped: boolean;
  singleViews: Record<string, MatchView>;
  currentScope: "alliance" | "single";
  currentTag: string | null;
  revisionDraftByTag: Record<string, MatchRevisionFields>;
};

type FwaMailPreviewPayload = {
  userId: string;
  guildId: string;
  tag: string;
  sourceMatchPayloadKey?: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  sourceShowMode?: "embed" | "copy";
  revisionOverride?: MatchRevisionFields | null;
};

type FwaComplianceViewPayload = {
  userId: string;
  guildId: string;
  clanName: string;
  clanTag: string;
  isFwa: boolean;
  warPlanText: string | null;
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  fwaWinGateConfig: {
    nonMirrorTripleMinClanStars: number;
    allBasesOpenHoursLeft: number;
  } | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  participantsCount: number;
  attacksCount: number;
  missedBoth: WarComplianceIssue[];
  notFollowingPlan: WarComplianceIssue[];
  activeView: FwaComplianceActiveView;
  mainPage: number;
  missedPage: number;
};

const fwaMatchCopyPayloads = new Map<string, FwaMatchCopyPayload>();
const fwaMailPreviewPayloads = new Map<string, FwaMailPreviewPayload>();
const fwaComplianceViewPayloads = new Map<string, FwaComplianceViewPayload>();
const fwaBaseSwapSplitPostPayloads = new Map<string, FwaBaseSwapSplitPostPayload>();
const fwaMailPollers = new Map<string, ReturnType<typeof setInterval>>();
const pointsSnapshotCache = new Map<string, PointsSnapshotCacheEntry>();
const pointsSnapshotInFlight = new Map<string, Promise<PointsSnapshot>>();
const fwaMatchTypeResolutionLogGate = new SteadyStateLogGate();
const fwaRoutinePointsSkipLogGate = new SteadyStateLogGate();

export function setFwaBaseSwapSplitPostPayloadForTest(
  key: string,
  payload: FwaBaseSwapSplitPostPayload,
): void {
  fwaBaseSwapSplitPostPayloads.set(key, payload);
}

export function clearFwaBaseSwapSplitPostPayloadsForTest(): void {
  fwaBaseSwapSplitPostPayloads.clear();
}

/** Purpose: normalize any war id input to a comparable string key. */
function normalizeWarIdText(
  warId: string | number | null | undefined,
): string | null {
  if (typeof warId === "number" && Number.isFinite(warId)) {
    return String(Math.trunc(warId));
  }
  const text = String(warId ?? "").trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  return String(Math.trunc(numeric));
}

/** Purpose: coerce revision fields into a canonical mail-defining comparison shape. */
function normalizeRevisionFields(
  value: MatchRevisionFields | null | undefined,
): MatchRevisionFields | null {
  if (!value) return null;
  const warId = normalizeWarIdText(value.warId);
  const opponentTag = normalizeTag(String(value.opponentTag ?? ""));
  if (!warId || !opponentTag) return null;
  const matchType =
    value.matchType === "FWA" ||
    value.matchType === "BL" ||
    value.matchType === "MM"
      ? value.matchType
      : "UNKNOWN";
  const expectedOutcome =
    matchType === "FWA"
      ? value.expectedOutcome === "WIN" || value.expectedOutcome === "LOSE"
        ? value.expectedOutcome
        : "UNKNOWN"
      : null;
  return {
    warId,
    opponentTag,
    matchType,
    expectedOutcome,
  };
}

/** Purpose: compare mail-defining revision fields while ignoring unrelated dynamic values. */
function areRevisionFieldsEqual(
  left: MatchRevisionFields | null | undefined,
  right: MatchRevisionFields | null | undefined,
): boolean {
  const normalizedLeft = normalizeRevisionFields(left);
  const normalizedRight = normalizeRevisionFields(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.warId === normalizedRight.warId &&
    normalizedLeft.opponentTag === normalizedRight.opponentTag &&
    normalizedLeft.matchType === normalizedRight.matchType &&
    normalizedLeft.expectedOutcome === normalizedRight.expectedOutcome
  );
}

/** Purpose: scope a payload draft to the active war/opponent identity. */
function resolveScopedDraftRevision(params: {
  draft: MatchRevisionFields | null | undefined;
  liveFields: MatchRevisionFields | null | undefined;
}): MatchRevisionFields | null {
  const normalizedDraft = normalizeRevisionFields(params.draft);
  const normalizedLive = normalizeRevisionFields(params.liveFields);
  if (!normalizedDraft || !normalizedLive) return null;
  if (
    normalizedDraft.warId !== normalizedLive.warId ||
    normalizedDraft.opponentTag !== normalizedLive.opponentTag
  ) {
    return null;
  }
  return normalizedDraft;
}

/** Purpose: build a canonical live mail-defining snapshot for current war identity. */
function buildLiveRevisionFields(params: {
  warId: number | string | null | undefined;
  opponentTag: string;
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
}): MatchRevisionFields | null {
  return normalizeRevisionFields({
    warId: normalizeWarIdText(params.warId),
    opponentTag: normalizeTag(params.opponentTag),
    matchType: params.matchType,
    expectedOutcome: params.expectedOutcome,
  });
}

/** Purpose: derive confirmed active-war revision baseline from persisted sync/lifecycle owners. */
function resolveConfirmedRevisionBaseline(params: {
  syncRow: {
    warId: string | null;
    opponentTag: string;
    lastKnownMatchType: string | null;
    lastKnownOutcome: string | null;
    isFwa: boolean | null;
    confirmedByClanMail: boolean;
  } | null;
  mailConfig: Pick<
    MatchMailConfig,
    "lastWarId" | "lastOpponentTag" | "lastMatchType" | "lastExpectedOutcome"
  > | null;
  liveFields: MatchRevisionFields | null;
  lifecycleStatus: WarMailLifecycleNormalizedStatus;
}): MatchRevisionFields | null {
  const normalizedLive = normalizeRevisionFields(params.liveFields);
  if (!normalizedLive) return null;
  if (params.syncRow?.confirmedByClanMail) {
    const matchType =
      params.syncRow.lastKnownMatchType === "FWA" ||
      params.syncRow.lastKnownMatchType === "BL" ||
      params.syncRow.lastKnownMatchType === "MM"
        ? params.syncRow.lastKnownMatchType
        : params.syncRow.isFwa === true
          ? "FWA"
          : "UNKNOWN";
    const knownOutcome =
      params.syncRow.lastKnownOutcome === "WIN" ||
      params.syncRow.lastKnownOutcome === "LOSE" ||
      params.syncRow.lastKnownOutcome === "UNKNOWN"
        ? params.syncRow.lastKnownOutcome
        : null;
    const syncCandidate = normalizeRevisionFields({
      warId: normalizeWarIdText(params.syncRow.warId) ?? normalizedLive.warId,
      opponentTag: params.syncRow.opponentTag,
      matchType,
      expectedOutcome: knownOutcome,
    });
    if (
      syncCandidate &&
      syncCandidate.warId === normalizedLive.warId &&
      syncCandidate.opponentTag === normalizedLive.opponentTag
    ) {
      return syncCandidate;
    }
  }

  if (params.lifecycleStatus === "posted") {
    const mailConfigCandidate = resolveRevisionBaselineFromMailConfig(
      params.mailConfig,
    );
    if (
      mailConfigCandidate &&
      mailConfigCandidate.warId === normalizedLive.warId &&
      mailConfigCandidate.opponentTag === normalizedLive.opponentTag
    ) {
      return mailConfigCandidate;
    }
  }
  return null;
}

/** Purpose: normalize tracked-clan mail-config baseline as a fallback when no sync checkpoint exists. */
function resolveRevisionBaselineFromMailConfig(
  mailConfig:
    | Pick<
        MatchMailConfig,
        | "lastWarId"
        | "lastOpponentTag"
        | "lastMatchType"
        | "lastExpectedOutcome"
      >
    | null
    | undefined,
): MatchRevisionFields | null {
  const warId = normalizeWarIdText(mailConfig?.lastWarId ?? null);
  const opponentTag = normalizeTag(String(mailConfig?.lastOpponentTag ?? ""));
  if (!warId || !opponentTag) return null;
  const matchType =
    mailConfig?.lastMatchType === "FWA" ||
    mailConfig?.lastMatchType === "BL" ||
    mailConfig?.lastMatchType === "MM"
      ? mailConfig.lastMatchType
      : "UNKNOWN";
  const expectedOutcome =
    matchType === "FWA"
      ? mailConfig?.lastExpectedOutcome === "WIN" ||
        mailConfig?.lastExpectedOutcome === "LOSE"
        ? mailConfig.lastExpectedOutcome
        : "UNKNOWN"
      : null;
  return normalizeRevisionFields({
    warId,
    opponentTag,
    matchType,
    expectedOutcome,
  });
}

/** Purpose: normalize posted mail-defining fields from a ClanPointsSync row. */
function resolvePostedRevisionFromSyncRow(
  syncRow: {
    lastKnownMatchType: string | null;
    lastKnownOutcome: string | null;
    isFwa: boolean | null;
  } | null,
): {
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
} | null {
  if (!syncRow) return null;
  const matchType =
    syncRow.lastKnownMatchType === "FWA" ||
    syncRow.lastKnownMatchType === "BL" ||
    syncRow.lastKnownMatchType === "MM"
      ? syncRow.lastKnownMatchType
      : syncRow.isFwa === true
        ? "FWA"
        : "UNKNOWN";
  const expectedOutcome =
    matchType === "FWA"
      ? syncRow.lastKnownOutcome === "WIN" ||
        syncRow.lastKnownOutcome === "LOSE"
        ? syncRow.lastKnownOutcome
        : "UNKNOWN"
      : null;
  return { matchType, expectedOutcome };
}

/** Purpose: compute effective revision state using draft-over-baseline precedence. */
function resolveEffectiveRevisionState(params: {
  liveFields: MatchRevisionFields | null;
  confirmedBaseline: MatchRevisionFields | null;
  draft: MatchRevisionFields | null;
}): {
  baseline: MatchRevisionFields | null;
  effective: MatchRevisionFields | null;
  appliedDraft: MatchRevisionFields | null;
  draftDiffersFromBaseline: boolean;
} {
  const baseline =
    normalizeRevisionFields(params.confirmedBaseline) ??
    normalizeRevisionFields(params.liveFields);
  const scopedDraft = resolveScopedDraftRevision({
    draft: params.draft,
    liveFields: params.liveFields,
  });
  const draftDiffersFromBaseline = Boolean(
    scopedDraft && baseline && !areRevisionFieldsEqual(scopedDraft, baseline),
  );
  const appliedDraft = draftDiffersFromBaseline ? scopedDraft : null;
  return {
    baseline,
    effective:
      appliedDraft ?? baseline ?? normalizeRevisionFields(params.liveFields),
    appliedDraft,
    draftDiffersFromBaseline,
  };
}

/** Purpose: derive mail-send blocking reason with posted baseline-vs-draft rules. */
function getMailBlockedReasonFromRevisionState(params: {
  inferredMatchType: boolean;
  hasMailChannel: boolean;
  mailStatus: WarMailLifecycleNormalizedStatus;
  appliedDraft: MatchRevisionFields | null;
  draftDiffersFromBaseline: boolean;
  hasConfirmedBaseline: boolean;
}): string | null {
  if (!params.hasMailChannel) {
    return "Mail channel is not configured. Use /tracked-clan configure with a mail channel.";
  }
  if (params.mailStatus === "posted") {
    if (!params.hasConfirmedBaseline) return null;
    if (params.appliedDraft && params.draftDiffersFromBaseline) return null;
    return "Current mail is already up to date. Change match config before sending again.";
  }
  return null;
}

/** Purpose: keep inferred-match warnings visible until the user explicitly applies a draft/confirmation. */
function shouldDisplayInferredMatchType(params: {
  inferredMatchType: boolean;
  appliedDraft: MatchRevisionFields | null | undefined;
}): boolean {
  return Boolean(
    params.inferredMatchType && !normalizeRevisionFields(params.appliedDraft),
  );
}

/** Purpose: return the persisted baseline used when evaluating whether a draft is a true revision. */
function getRevisionBaselineForView(
  view: MatchView,
): MatchRevisionFields | null {
  return (
    normalizeRevisionFields(view.confirmedRevisionBaseline) ??
    normalizeRevisionFields(view.liveRevisionFields)
  );
}

/** Purpose: return the currently effective revision snapshot for the rendered single view. */
function getEffectiveRevisionForView(
  view: MatchView,
): MatchRevisionFields | null {
  return (
    normalizeRevisionFields(view.appliedDraftRevision) ??
    normalizeRevisionFields(view.effectiveRevisionFields) ??
    getRevisionBaselineForView(view)
  );
}

/** Purpose: normalize outcome-like values to WIN/LOSE only for FWA-effective comparisons. */
function toWinLoseOutcome(
  value: "WIN" | "LOSE" | "UNKNOWN" | null | undefined,
): "WIN" | "LOSE" | null {
  if (value === "WIN" || value === "LOSE") return value;
  return null;
}

/** Purpose: resolve displayed FWA expected outcome with draft-explicit precedence and projection fallback. */
function resolveEffectiveFwaOutcome(params: {
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null | undefined;
  explicitOutcome: "WIN" | "LOSE" | "UNKNOWN" | null | undefined;
  projectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null | undefined;
}): "WIN" | "LOSE" | "UNKNOWN" | null {
  if (params.matchType !== "FWA") return null;
  return (
    toWinLoseOutcome(params.explicitOutcome) ??
    toWinLoseOutcome(params.projectedOutcome) ??
    "UNKNOWN"
  );
}

/** Purpose: keep single-clan `/fwa match` color aligned to the exact effective state shown in the card. */
function resolveSingleClanMatchEmbedColor(params: {
  effectiveMatchType: WarMailMatchType;
  effectiveExpectedOutcome: WarMailExpectedOutcome;
}): number {
  return resolveWarMailEmbedColor({
    matchType: params.effectiveMatchType,
    expectedOutcome: params.effectiveExpectedOutcome,
  });
}

/** Purpose: evaluate mismatch warnings from the effective state currently shown in the view. */
function buildEffectiveMatchMismatchWarnings(params: {
  siteUpdated: boolean;
  effectiveMatchType:
    | "FWA"
    | "BL"
    | "MM"
    | "SKIP"
    | "UNKNOWN"
    | null
    | undefined;
  effectiveExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null | undefined;
  projectedOutcome: "WIN" | "LOSE" | null | undefined;
  opponentActiveFwaEvidence: boolean | null | undefined;
}): { outcomeMismatch: string | null; matchTypeVsFwaMismatch: string | null } {
  if (!params.siteUpdated) {
    return { outcomeMismatch: null, matchTypeVsFwaMismatch: null };
  }
  const effectiveMatchType =
    params.effectiveMatchType === "FWA" ||
    params.effectiveMatchType === "BL" ||
    params.effectiveMatchType === "MM"
      ? params.effectiveMatchType
      : null;
  if (!effectiveMatchType) {
    return { outcomeMismatch: null, matchTypeVsFwaMismatch: null };
  }
  const outcomeMismatch =
    effectiveMatchType === "FWA"
      ? buildOutcomeMismatchWarning(
          toWinLoseOutcome(params.effectiveExpectedOutcome),
          toWinLoseOutcome(params.projectedOutcome),
        )
      : null;
  const matchTypeVsFwaMismatch =
    (effectiveMatchType === "BL" || effectiveMatchType === "MM") &&
    params.opponentActiveFwaEvidence === true
      ? ":warning: Points site reports Active FWA: YES but match type is BL/MM"
      : null;
  return { outcomeMismatch, matchTypeVsFwaMismatch };
}

/** Purpose: resolve whether current-war opponent evidence explicitly reports Active FWA yes/no. */
function resolveOpponentActiveFwaEvidence(params: {
  opponentActiveFwa: boolean | null | undefined;
  opponentNotFound: boolean | null | undefined;
  resolutionSource: MatchTypeResolutionSource | null | undefined;
}): boolean | null {
  if (params.opponentNotFound === true) return null;
  if (params.resolutionSource === "live_points_active_fwa_yes") return true;
  if (params.resolutionSource === "live_points_active_fwa_no") return false;
  if (params.opponentActiveFwa === true || params.opponentActiveFwa === false) {
    return params.opponentActiveFwa;
  }
  return null;
}

/** Purpose: detect alliance-only low-confidence evidence scenarios where mismatch bullets should be hidden. */
function isLowConfidenceAllianceMismatchScenario(params: {
  siteUpdated: boolean;
  opponentNotFound: boolean;
  opponentActiveFwaEvidence: boolean | null | undefined;
  resolutionSource: MatchTypeResolutionSource | null | undefined;
}): boolean {
  if (!params.siteUpdated) return true;
  if (params.opponentNotFound) return true;
  if (params.resolutionSource === "live_points_winner_box_not_marked_fwa")
    return true;
  return (
    params.opponentActiveFwaEvidence !== true &&
    params.opponentActiveFwaEvidence !== false
  );
}

/** Purpose: build next draft when a user chooses a different match type. */
function buildDraftFromMatchTypeSelection(params: {
  view: MatchView;
  targetType: "FWA" | "BL" | "MM";
}): MatchRevisionFields | null {
  const baseline = getRevisionBaselineForView(params.view);
  const effective = getEffectiveRevisionForView(params.view);
  if (!baseline || !effective) return null;
  const nextDraft = normalizeRevisionFields({
    ...effective,
    matchType: params.targetType,
    expectedOutcome: resolveEffectiveFwaOutcome({
      matchType: params.targetType,
      explicitOutcome: effective.expectedOutcome,
      projectedOutcome: params.view.projectedFwaOutcome ?? null,
    }),
  });
  if (!nextDraft || areRevisionFieldsEqual(nextDraft, baseline)) return null;
  return nextDraft;
}

type ActiveWarMatchInferenceOptions = {
  currentWarState?: "preparation" | "inWar" | "notInWar" | null;
  currentWarClanAttacksUsed?: number | null;
  currentWarClanStars?: number | null;
  currentWarOpponentStars?: number | null;
};

/** Purpose: pass only battle-relevant active-war evidence into shared BL/MM inference. */
function buildActiveWarMatchInferenceOptions(params: {
  warState: WarStateForSync | null | undefined;
  clanAttacksUsed?: number | null | undefined;
  clanStars?: number | null | undefined;
  opponentStars?: number | null | undefined;
}): ActiveWarMatchInferenceOptions {
  const normalizeFiniteInt = (
    value: number | null | undefined,
  ): number | null =>
    value !== null && value !== undefined && Number.isFinite(value)
      ? Math.trunc(value)
      : null;
  return {
    currentWarState: params.warState ?? null,
    currentWarClanAttacksUsed: normalizeFiniteInt(params.clanAttacksUsed),
    currentWarClanStars: normalizeFiniteInt(params.clanStars),
    currentWarOpponentStars: normalizeFiniteInt(params.opponentStars),
  };
}

type MatchTypeSelectionResolution = {
  draft: MatchRevisionFields | null;
  explicitConfirmation: {
    matchType: "FWA" | "BL" | "MM";
    expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  } | null;
};

/** Purpose: distinguish draft changes from explicit same-type confirmation of an inferred value. */
function resolveMatchTypeSelection(params: {
  view: MatchView;
  targetType: "FWA" | "BL" | "MM";
}): MatchTypeSelectionResolution {
  const draft = buildDraftFromMatchTypeSelection(params);
  if (draft) {
    return { draft, explicitConfirmation: null };
  }
  const currentType = params.view.matchTypeCurrent;
  const effective = getEffectiveRevisionForView(params.view);
  if (!params.view.inferredMatchType || currentType !== params.targetType) {
    return { draft: null, explicitConfirmation: null };
  }
  return {
    draft: null,
    explicitConfirmation: {
      matchType: params.targetType,
      expectedOutcome:
        params.targetType === "FWA"
          ? (effective?.expectedOutcome ?? "UNKNOWN")
          : null,
    },
  };
}

/** Purpose: build next draft when a user toggles expected outcome for an FWA revision. */
function buildDraftFromOutcomeToggle(params: {
  view: MatchView;
  currentOutcome: "WIN" | "LOSE";
}): MatchRevisionFields | null {
  const baseline = getRevisionBaselineForView(params.view);
  const effective = getEffectiveRevisionForView(params.view);
  if (!baseline || !effective || effective.matchType !== "FWA") return null;
  const nextOutcome = params.currentOutcome === "WIN" ? "LOSE" : "WIN";
  const nextDraft = normalizeRevisionFields({
    ...effective,
    matchType: "FWA",
    expectedOutcome: nextOutcome,
  });
  if (!nextDraft || areRevisionFieldsEqual(nextDraft, baseline)) return null;
  return nextDraft;
}

async function rebuildTrackedPayloadForTag(
  payload: FwaMatchCopyPayload,
  guildId: string | null,
  tag: string,
  client?: Client | null,
): Promise<FwaMatchCopyPayload | null> {
  if (!guildId) return null;
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, guildId);
  const cocService = new CoCService();
  const warLookupCache: WarLookupCache = new Map();
  const scopedOverview = await buildTrackedMatchOverview(
    cocService,
    sourceSync,
    guildId,
    warLookupCache,
    client ?? null,
    {
      onlyClanTags: [tag],
      includeActualSheet: false,
      revisionDraftByTag: payload.revisionDraftByTag,
    },
  );
  const trackedSingleView = scopedOverview.singleViews[tag];
  if (!trackedSingleView) return null;
  const allianceFields = [...(payload.allianceView.embed.data.fields ?? [])];
  const scopedField =
    (scopedOverview.embed.data.fields ?? []).find((field) =>
      String(field.name ?? "").includes(`(#${tag})`),
    ) ?? (scopedOverview.embed.data.fields ?? [])[0];
  if (scopedField) {
    const index = allianceFields.findIndex((field) =>
      String(field.name ?? "").includes(`(#${tag})`),
    );
    if (index >= 0) {
      allianceFields[index] = scopedField;
    } else {
      allianceFields.push(scopedField);
    }
  }
  const nextAllianceEmbed = EmbedBuilder.from(payload.allianceView.embed);
  if (allianceFields.length > 0) {
    nextAllianceEmbed.setFields(allianceFields);
  }
  const nextRevisionDraftByTag = { ...payload.revisionDraftByTag };
  if (
    trackedSingleView.appliedDraftRevision &&
    trackedSingleView.draftDiffersFromBaseline
  ) {
    nextRevisionDraftByTag[tag] = trackedSingleView.appliedDraftRevision;
  } else {
    delete nextRevisionDraftByTag[tag];
  }
  return {
    ...payload,
    guildId,
    allianceView: {
      ...payload.allianceView,
      embed: nextAllianceEmbed,
    },
    singleViews: {
      ...payload.singleViews,
      [tag]: trackedSingleView,
    },
    revisionDraftByTag: nextRevisionDraftByTag,
    currentScope: "single",
    currentTag: tag,
  };
}

/** Purpose: hydrate a scoped-alliance payload to full alliance data when user requests Alliance View. */
async function hydrateAlliancePayloadIfScoped(
  payload: FwaMatchCopyPayload,
  cocService: CoCService,
  client?: Client | null,
): Promise<FwaMatchCopyPayload> {
  if (!payload.allianceViewIsScoped || !payload.guildId) return payload;
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, payload.guildId);
  const warLookupCache: WarLookupCache = new Map();
  const fullOverview = await buildTrackedMatchOverview(
    cocService,
    sourceSync,
    payload.guildId,
    warLookupCache,
    client ?? null,
    {
      revisionDraftByTag: payload.revisionDraftByTag,
    },
  );
  const mergedSingleViews = {
    ...fullOverview.singleViews,
    ...Object.fromEntries(
      Object.entries(payload.singleViews).filter(
        ([tag]) => !fullOverview.singleViews[tag],
      ),
    ),
  };
  console.info(
    `[fwa-match-payload] stage=alliance_hydrate scope=scoped_to_full guild=${payload.guildId} single_count_before=${Object.keys(payload.singleViews).length} single_count_after=${Object.keys(mergedSingleViews).length}`,
  );
  return {
    ...payload,
    allianceView: {
      embed: fullOverview.embed,
      copyText: fullOverview.copyText,
      matchTypeAction: null,
    },
    allianceViewIsScoped: false,
    singleViews: mergedSingleViews,
  };
}

/** Purpose: decide if Alliance View click must rebuild a full overview from a scoped payload. */
function shouldHydrateAlliancePayload(payload: {
  allianceViewIsScoped: boolean;
  guildId: string | null;
}): boolean {
  return payload.allianceViewIsScoped && Boolean(payload.guildId);
}

async function getTrackedClanMailConfig(tag: string): Promise<{
  tag: string;
  name: string | null;
  mailChannelId: string | null;
  clanRoleId: string | null;
} | null> {
  const normalizedTag = normalizeTag(tag);
  const rows = await prisma.$queryRaw<
    Array<{
      tag: string;
      name: string | null;
      mailChannelId: string | null;
      clanRoleId: string | null;
    }>
  >(
    Prisma.sql`
      SELECT "tag","name","mailChannelId","clanRoleId"
      FROM "TrackedClan"
      WHERE UPPER(REPLACE("tag",'#','')) = ${normalizedTag}
      LIMIT 1
    `,
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    tag: normalizeTag(row.tag),
    name: sanitizeClanName(row.name ?? "") ?? null,
    mailChannelId: row.mailChannelId ?? null,
    clanRoleId: normalizeDiscordRoleId(row.clanRoleId ?? null),
  };
}

function isMatchTypeValue(
  value: unknown,
): value is "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" {
  return (
    value === "FWA" ||
    value === "BL" ||
    value === "MM" ||
    value === "SKIP" ||
    value === "UNKNOWN"
  );
}

function isExpectedOutcomeValue(
  value: unknown,
): value is "WIN" | "LOSE" | "UNKNOWN" {
  return value === "WIN" || value === "LOSE" || value === "UNKNOWN";
}

function formatMailBlockedReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  if (
    reason ===
    "Current mail is already up to date. Change match config before sending again."
  ) {
    return `:envelope_with_arrow: ${reason}`;
  }
  return `:warning: ${reason}`;
}

async function getCurrentWarMailConfig(
  guildId: string,
  tag: string,
): Promise<MatchMailConfig> {
  const normalizedTag = normalizeTag(tag);
  const row = await prisma.trackedClan.findUnique({
    where: { tag: `#${normalizedTag}` },
    select: { mailConfig: true },
  });
  return parseMatchMailConfig(
    row?.mailConfig as Prisma.JsonValue | null | undefined,
  );
}

async function saveCurrentWarMailConfig(params: {
  guildId: string;
  tag: string;
  channelId: string;
  mailConfig: MatchMailConfig;
}): Promise<void> {
  const normalizedTag = normalizeTag(params.tag);
  await prisma.trackedClan.update({
    where: { tag: `#${normalizedTag}` },
    data: {
      mailConfig: asMailConfigInputJson(params.mailConfig),
    },
  });
}

async function markMatchLiveDataChanged(params: {
  guildId: string;
  tag: string;
  channelId: string;
}): Promise<void> {
  const current = await getCurrentWarMailConfig(params.guildId, params.tag);
  const live = await prisma.currentWar.findUnique({
    where: {
      clanTag_guildId: {
        guildId: params.guildId,
        clanTag: `#${normalizeTag(params.tag)}`,
      },
    },
    select: { matchType: true, outcome: true, warId: true, startTime: true },
  });
  const liveMatchType = isMatchTypeValue(live?.matchType)
    ? live.matchType
    : null;
  const liveOutcome = isExpectedOutcomeValue(live?.outcome)
    ? live.outcome
    : null;
  const nowUnix = Math.floor(Date.now() / 1000);
  const next: MatchMailConfig = {
    ...current,
    lastMatchType: liveMatchType,
    lastExpectedOutcome: liveOutcome,
    lastDataChangedAtUnix: nowUnix,
  };
  await saveCurrentWarMailConfig({
    guildId: params.guildId,
    tag: params.tag,
    channelId: params.channelId,
    mailConfig: next,
  });
  await pointsSyncService
    .markNeedsValidation({
      guildId: params.guildId,
      clanTag: params.tag,
      warId: live?.warId ?? null,
      warStartTime: live?.startTime ?? null,
    })
    .catch(() => undefined);
}

function buildMatchStatusHeader(params: {
  clanName: string;
  clanTag: string;
  opponentName: string;
  opponentTag: string;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
  outcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  mailStatusEmoji?: string;
}): string {
  let mailbox = params.mailStatusEmoji ?? MAILBOX_NOT_SENT_EMOJI;
  let status = ":white_circle:";
  if (params.matchType === "BL") {
    status = ":pirate_flag:";
  } else if (params.matchType === "MM") {
    status = ":white_circle:";
  } else if (params.matchType === "SKIP") {
    status = ":white_circle:";
  } else if (params.outcome === "LOSE") {
    status = ":red_circle:";
  } else {
    status = ":green_circle:";
  }
  return `${mailbox} | ${params.clanName} (#${params.clanTag}) vs ${params.opponentName} (#${params.opponentTag}) ${status}`;
}

function mailStatusLabelForState(state: WarStateForSync): string {
  if (state === "preparation") return "Preparation Day";
  if (state === "inWar") return "Battle Day";
  return "Not In War";
}

function formatWarResultLabel(
  result: "WIN" | "LOSE" | "TIE" | "UNKNOWN",
): "WIN" | "LOSS" | "DRAW" | "UNKNOWN" {
  if (result === "LOSE") return "LOSS";
  if (result === "TIE") return "DRAW";
  return result;
}

function formatDiscordRelativeMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function formatDiscordFullAndRelativeMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  const seconds = Math.floor(ms / 1000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function formatWarStatCellLeft(value: string): string {
  return value.padStart(10, " ");
}

function formatWarStatCellRight(value: string): string {
  return value.padEnd(10, " ");
}

function formatWarStatLine(left: string, emoji: string, right: string): string {
  return `\`${formatWarStatCellLeft(left)}\` ${emoji} \`${formatWarStatCellRight(right)}\``;
}

function formatWarInt(input: unknown): string {
  const value = Number(input);
  if (!Number.isFinite(value)) return "?";
  return String(Math.max(0, Math.trunc(value)));
}

function formatWarPercent(input: unknown): string {
  const value = Number(input);
  if (!Number.isFinite(value)) return "?";
  const rounded = Math.round(value * 100) / 100;
  const withPrecision = Number.isInteger(rounded)
    ? `${rounded}`
    : `${rounded.toFixed(2)}`;
  return `${withPrecision.replace(/\.00$/, "")}%`;
}

function buildWarStatsLines(input: {
  clanStars: unknown;
  opponentStars: unknown;
  clanAttacks: unknown;
  opponentAttacks: unknown;
  teamSize: unknown;
  attacksPerMember: unknown;
  clanDestruction: unknown;
  opponentDestruction: unknown;
}): string[] {
  const starsLeft = formatWarInt(input.clanStars);
  const starsRight = formatWarInt(input.opponentStars);
  const attacksPerMember = Number.isFinite(Number(input.attacksPerMember))
    ? Math.max(1, Math.trunc(Number(input.attacksPerMember)))
    : 2;
  const teamSize = Number.isFinite(Number(input.teamSize))
    ? Math.max(1, Math.trunc(Number(input.teamSize)))
    : 0;
  const totalAttacks = teamSize > 0 ? teamSize * attacksPerMember : 0;
  const attacksLeft = formatWarInt(input.clanAttacks);
  const attacksRight = formatWarInt(input.opponentAttacks);
  const attacksLeftText =
    totalAttacks > 0 ? `${attacksLeft}/${totalAttacks}` : `${attacksLeft}/?`;
  const attacksRightText =
    totalAttacks > 0 ? `${attacksRight}/${totalAttacks}` : `${attacksRight}/?`;
  return [
    formatWarStatLine(starsLeft, ":star:", starsRight),
    formatWarStatLine(attacksLeftText, ":crossed_swords:", attacksRightText),
    formatWarStatLine(
      formatWarPercent(input.clanDestruction),
      ":boom:",
      formatWarPercent(input.opponentDestruction),
    ),
  ];
}

function mailStatusTitleForState(state: WarStateForSync): string {
  if (state === "preparation") return "War Started";
  if (state === "inWar") return "Battle Day Started";
  return "War Ended";
}

async function upsertCurrentWarHistoryAndGetWarId(params: {
  guildId: string;
  normalizedTag: string;
  warStartMs: number | null;
  warEndMs: number | null;
  currentSync: number | null;
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  clanName: string;
  opponentName: string;
  opponentTag: string;
  war: Awaited<ReturnType<CoCService["getCurrentWar"]>>;
}): Promise<number | null> {
  const resolvedWarStartMs =
    params.warStartMs !== null && Number.isFinite(params.warStartMs)
      ? params.warStartMs
      : parseCocApiTime(params.war?.startTime);
  return getCurrentWarIdForClan(
    params.guildId,
    params.normalizedTag,
    resolvedWarStartMs !== null && Number.isFinite(resolvedWarStartMs)
      ? resolvedWarStartMs
      : null,
  );
}

async function getCurrentWarIdForClan(
  guildId: string,
  normalizedTag: string,
  _warStartMs: number | null,
): Promise<number | null> {
  const current = await prisma.currentWar.findUnique({
    where: {
      clanTag_guildId: {
        guildId,
        clanTag: `#${normalizedTag}`,
      },
    },
    select: { warId: true },
  });
  return current?.warId ?? null;
}

async function buildWarMailEmbedForTag(
  cocService: CoCService,
  guildId: string,
  tag: string,
  options?: {
    fetchReason?: PointsApiFetchReason;
    routine?: boolean;
    revisionOverride?: MatchRevisionFields | null;
  },
): Promise<{
  embed: EmbedBuilder;
  planText: string;
  inferredMatchType: boolean;
  mailChannelId: string | null;
  clanRoleId: string | null;
  warId: number | null;
  opponentTag: string | null;
  warStartMs: number | null;
  freezeRefresh: boolean;
  unavailableReasons: string[];
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
}> {
  const normalizedTag = normalizeTag(tag);
  const trackedConfig = await getTrackedClanMailConfig(normalizedTag);
  if (!trackedConfig) {
    throw new Error(`Tracked clan #${normalizedTag} not found.`);
  }

  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, guildId);

  const war = await cocService
    .getCurrentWar(`#${normalizedTag}`)
    .catch(() => null);
  const warState = deriveWarState(war?.state);
  const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
  const opponentName =
    sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
  const clanName =
    trackedConfig.name ??
    sanitizeClanName(String(war?.clan?.name ?? "")) ??
    `#${normalizedTag}`;

  const subscription = await prisma.currentWar.findUnique({
    where: {
      clanTag_guildId: {
        guildId,
        clanTag: `#${normalizedTag}`,
      },
    },
    select: {
      warId: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      fwaPoints: true,
      opponentFwaPoints: true,
      startTime: true,
      state: true,
      endTime: true,
      opponentTag: true,
      opponentName: true,
      clanStars: true,
      opponentStars: true,
    },
  });

  const fallbackResolution = await resolveMatchTypeWithFallback({
    guildId,
    clanTag: normalizedTag,
    opponentTag,
    warState,
    warId: subscription?.warId ?? null,
    warStartTime: getWarStartDateForSync(subscription?.startTime ?? null, war),
    existingMatchType:
      (subscription?.matchType as
        | "FWA"
        | "BL"
        | "MM"
        | "SKIP"
        | null
        | undefined) ?? null,
    existingInferredMatchType: subscription?.inferredMatchType ?? null,
  });
  let appliedResolution = chooseMatchTypeResolution({
    confirmedCurrent: fallbackResolution.confirmedCurrent,
    liveOpponent: null,
    storedSync: fallbackResolution.storedSync,
    unconfirmedCurrent: fallbackResolution.unconfirmedCurrent,
  });
  let inferredMatchType =
    appliedResolution?.inferred ?? Boolean(subscription?.inferredMatchType);
  let matchType: "FWA" | "BL" | "MM" | "UNKNOWN" =
    appliedResolution?.matchType === "SKIP"
      ? "UNKNOWN"
      : (appliedResolution?.matchType ?? "UNKNOWN");
  let outcome =
    (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ?? null;
  const fallbackOpponentTag = normalizeTag(
    String(subscription?.opponentTag ?? ""),
  );
  const effectiveOpponentTag = opponentTag || fallbackOpponentTag;
  const effectiveOpponentName = opponentTag
    ? opponentName
    : (sanitizeClanName(String(subscription?.opponentName ?? "")) ??
      opponentName);
  const hasLiveWar = warState !== "notInWar" && Boolean(opponentTag);
  const freezeRefresh =
    !hasLiveWar &&
    Boolean(subscription?.startTime) &&
    Boolean(effectiveOpponentTag);

  const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
  const warIdForSync =
    subscription?.warId !== null &&
    subscription?.warId !== undefined &&
    Number.isFinite(subscription.warId)
      ? String(Math.trunc(subscription.warId))
      : null;
  const warStartTimeForSync = getWarStartDateForSync(
    subscription?.startTime ?? null,
    war,
  );
  const mailConfig = await getCurrentWarMailConfig(guildId, normalizedTag);
  const lifecycleStatus = warIdForSync
    ? ((
        await warMailLifecycleService
          .getLifecycleForWar({
            guildId,
            clanTag: normalizedTag,
            warId: Number(warIdForSync),
          })
          .catch(() => null)
      )?.status === "POSTED"
        ? "posted"
        : "not_posted")
    : "not_posted";
  const syncRow = await pointsSyncService
    .getCurrentSyncForClan({
      guildId,
      clanTag: normalizedTag,
      warId: warIdForSync,
      warStartTime: warStartTimeForSync,
    })
    .catch(() => null);
  const lifecycle =
    syncRow === null
      ? null
      : {
          confirmedByClanMail: Boolean(syncRow.confirmedByClanMail),
          needsValidation: Boolean(syncRow.needsValidation),
          lastSuccessfulPointsApiFetchAt:
            syncRow.lastSuccessfulPointsApiFetchAt ?? null,
          lastKnownSyncNumber:
            syncRow.lastKnownSyncNumber !== null &&
            syncRow.lastKnownSyncNumber !== undefined &&
            Number.isFinite(syncRow.lastKnownSyncNumber)
              ? Math.trunc(syncRow.lastKnownSyncNumber)
              : null,
          warId: syncRow.warId ?? null,
          opponentTag: syncRow.opponentTag ?? null,
          warStartTime: syncRow.warStartTime ?? null,
        };
  const routineDecision = options?.routine
    ? await pointsDirectFetchGate.evaluatePollerFetch({
        guildId,
        clanTag: normalizedTag,
        pollerSource: "mail_refresh_loop",
        requestedReason: options?.fetchReason ?? "mail_refresh",
        preferredAllowedReason: options?.fetchReason ?? "mail_refresh",
        warState,
        warStartTime: subscription?.startTime ?? null,
        warEndTime: subscription?.endTime ?? null,
        currentSyncNumber: currentSync,
        lifecycle,
        activeWarId:
          subscription?.warId !== null &&
          subscription?.warId !== undefined &&
          Number.isFinite(subscription.warId)
            ? String(Math.trunc(subscription.warId))
            : null,
        activeOpponentTag: effectiveOpponentTag || null,
      })
    : {
        allowed: true,
        outcome: "allowed" as const,
        decisionCode: "manual_override" as const,
        reason: "Manual mail preview fetch.",
        fetchReason: options?.fetchReason ?? ("mail_preview" as const),
        lockState: "unlocked" as const,
      };
  const fetchReason =
    options?.fetchReason ??
    routineDecision.fetchReason ??
    (options?.routine ? "mail_refresh" : "mail_preview");
  if (options?.routine && !routineDecision.allowed) {
    const line = `[fwa-mail] points fetch skipped guild=${guildId} clan=#${normalizedTag} outcome=${routineDecision.outcome} code=${routineDecision.decisionCode} reason=${routineDecision.reason}`;
    const logLevel = resolveRoutineBlockedPointsFetchSkipLogLevel({
      guildId,
      clanTag: normalizedTag,
      fetchReason,
      outcome: routineDecision.outcome,
      decisionCode: routineDecision.decisionCode,
    });
    if (logLevel === "info") {
      console.info(line);
    } else {
      console.debug(line);
    }
  }

  let primaryBalance: number | null = null;
  let opponentBalance: number | null = null;
  let primarySnapshot: PointsSnapshot | null = null;
  let opponentSnapshot: PointsSnapshot | null = null;
  let pointsInference: MatchTypeResolution | null = null;
  if (opponentTag && routineDecision.allowed) {
    primarySnapshot = await getClanPointsCached(
      settings,
      cocService,
      normalizedTag,
      currentSync,
      undefined,
      {
        fetchReason,
      },
    ).catch(() => null);
    opponentSnapshot = await getClanPointsCached(
      settings,
      cocService,
      opponentTag,
      currentSync,
      undefined,
      {
        fetchReason,
        fallbackTrackedClanTag: normalizedTag,
      },
    ).catch(() => null);
    primaryBalance = primarySnapshot?.balance ?? null;
    opponentBalance = opponentSnapshot?.balance ?? null;
  } else {
    primaryBalance = subscription?.fwaPoints ?? syncRow?.clanPoints ?? null;
    opponentBalance =
      subscription?.opponentFwaPoints ?? syncRow?.opponentPoints ?? null;
  }
  const siteCurrentFromPrimary = Boolean(
    opponentTag &&
    primarySnapshot !== null &&
    isPointsSiteUpdatedForOpponent(primarySnapshot, opponentTag, sourceSync),
  );
  const siteCurrent = opponentTag
    ? isPointsValidationCurrentForMatchup({
        primarySnapshot,
        opponentSnapshot,
        opponentTag,
        sourceSync,
      })
    : false;
  if (opponentTag) {
    const winnerBoxNotMarkedFwa = hasWinnerBoxNotMarkedFwaSignal(
      primarySnapshot?.winnerBoxText ?? null,
    );
    const strongOpponentEvidencePresent =
      opponentSnapshot?.notFound === true ||
      opponentSnapshot?.activeFwa === true ||
      opponentSnapshot?.activeFwa === false;
    const activeWarInference = buildActiveWarMatchInferenceOptions({
      warState,
      clanAttacksUsed: war?.clan?.attacks ?? null,
      clanStars: war?.clan?.stars ?? subscription?.clanStars ?? null,
      opponentStars:
        war?.opponent?.stars ?? subscription?.opponentStars ?? null,
    });
    pointsInference = toMatchTypeResolutionFromPointsInference(
      inferMatchTypeFromPointsSnapshots(primarySnapshot, opponentSnapshot, {
        winnerBoxNotMarkedFwa,
        opponentEvidenceMissingOrNotCurrent:
          !siteCurrent || !strongOpponentEvidencePresent,
        ...activeWarInference,
      }),
    );
    const guardedFallbackResolution =
      applyExplicitOpponentNotFoundFallbackGuard({
        fallbackResolution,
        opponentNotFoundExplicitly: opponentSnapshot?.notFound === true,
        hasSameWarExplicitFwaConfirmation: hasSameWarExplicitFwaConfirmation({
          fallbackResolution,
          currentWarStartTime: subscription?.startTime ?? null,
          currentWarOpponentTag: subscription?.opponentTag ?? null,
          activeWarStartTime: getWarStartDateForSync(null, war),
          activeOpponentTag: opponentTag,
        }),
      });
    appliedResolution = chooseMatchTypeResolution({
      confirmedCurrent: guardedFallbackResolution.confirmedCurrent,
      liveOpponent: pointsInference,
      storedSync: guardedFallbackResolution.storedSync,
      unconfirmedCurrent: guardedFallbackResolution.unconfirmedCurrent,
    });
    inferredMatchType =
      appliedResolution?.inferred ?? Boolean(subscription?.inferredMatchType);
    matchType =
      appliedResolution?.matchType === "SKIP"
        ? "UNKNOWN"
        : (appliedResolution?.matchType ?? "UNKNOWN");
    if (appliedResolution) {
      logMatchTypeResolution({
        stage: "mail_embed",
        clanTag: normalizedTag,
        opponentTag,
        warId: subscription?.warId ?? null,
        source: appliedResolution.source,
        matchType: appliedResolution.matchType,
        inferred: appliedResolution.inferred,
        confirmed: appliedResolution.confirmed,
      });
    }
    const syncIsFwaSignal =
      appliedResolution?.syncIsFwa ??
      (matchType === "FWA" ? true : matchType === "BL" ? false : false);
    if (opponentSnapshot) {
      console.info(
        `[fwa-matchtype] stage=mail_embed_active_fwa clan=#${normalizedTag} opponent=#${opponentTag} parsed_active_fwa=${opponentSnapshot.activeFwa === null ? "unknown" : opponentSnapshot.activeFwa ? "yes" : "no"} not_found=${opponentSnapshot.notFound ? "1" : "0"} source=${appliedResolution?.source ?? "none"} sync_is_fwa=${syncIsFwaSignal ? "1" : "0"}`,
      );
    }
    if (matchType === "FWA" && !outcome) {
      outcome = deriveProjectedOutcome(
        normalizedTag,
        opponentTag,
        primaryBalance,
        opponentBalance,
        currentSync,
      );
    }
    const siteSyncObservedForWrite = resolveObservedSyncNumberForMatchup({
      primarySnapshot,
      opponentSnapshot,
    });
    if (
      siteCurrent &&
      !siteCurrentFromPrimary &&
      opponentSnapshot?.snapshotSource === "tracked_clan_fallback"
    ) {
      console.info(
        `[fwa-sync-validation] stage=mail_embed proof=tracked_fallback clan=#${normalizedTag} opponent=#${opponentTag} sync=${siteSyncObservedForWrite ?? "unknown"}`,
      );
    }
    await persistClanPointsSyncIfCurrent({
      guildId,
      clanTag: normalizedTag,
      warId: subscription?.warId ?? null,
      warStartTime: warStartTimeForSync,
      siteCurrent,
      syncNum: siteSyncObservedForWrite,
      opponentTag,
      clanPoints: primarySnapshot?.balance ?? null,
      opponentPoints: opponentSnapshot?.balance ?? null,
      outcome: matchType === "FWA" ? outcome : null,
      isFwa: syncIsFwaSignal,
      fetchedAtMs: primarySnapshot?.fetchedAtMs ?? null,
      fetchReason,
      matchType,
      opponentNotFound: opponentSnapshot?.notFound ?? false,
    });
  }

  const liveRevisionFields = buildLiveRevisionFields({
    warId: subscription?.warId ?? null,
    opponentTag: effectiveOpponentTag,
    matchType:
      matchType === "FWA" || matchType === "BL" || matchType === "MM"
        ? matchType
        : "UNKNOWN",
    expectedOutcome: matchType === "FWA" ? (outcome ?? "UNKNOWN") : null,
  });
  const confirmedRevisionBaseline = resolveConfirmedRevisionBaseline({
    syncRow: syncRow
      ? {
          warId: syncRow.warId ?? null,
          opponentTag: syncRow.opponentTag,
          lastKnownMatchType: syncRow.lastKnownMatchType ?? null,
          lastKnownOutcome: syncRow.lastKnownOutcome ?? null,
          isFwa: syncRow.isFwa ?? null,
          confirmedByClanMail: Boolean(syncRow.confirmedByClanMail),
        }
      : null,
    mailConfig: {
      lastWarId: mailConfig.lastWarId,
      lastOpponentTag: mailConfig.lastOpponentTag,
      lastMatchType: mailConfig.lastMatchType,
      lastExpectedOutcome: mailConfig.lastExpectedOutcome,
    },
    liveFields: liveRevisionFields,
    lifecycleStatus,
  });
  const effectiveRevisionState = resolveEffectiveRevisionState({
    liveFields: liveRevisionFields,
    confirmedBaseline: confirmedRevisionBaseline,
    draft: options?.revisionOverride ?? null,
  });
  const effectiveRevisionFields = effectiveRevisionState.effective;
  const mailMatchType = effectiveRevisionFields?.matchType ?? matchType;
  const mailInferredMatchType = effectiveRevisionState.appliedDraft
    ? false
    : confirmedRevisionBaseline
      ? false
      : inferredMatchType;
  const mailExpectedOutcome =
    mailMatchType === "FWA"
      ? (effectiveRevisionFields?.expectedOutcome ?? outcome ?? "UNKNOWN")
      : null;

  const history = new WarEventHistoryService(cocService);
  let planText = "War plan unavailable.";
  const customOrDefaultPlan = await history.buildWarPlanText(
    guildId,
    mailMatchType === "UNKNOWN" ? "FWA" : mailMatchType,
    mailExpectedOutcome,
    normalizedTag,
    effectiveOpponentName,
    hasLiveWar && warState === "inWar" ? "battle" : "prep",
    clanName,
  );
  if (customOrDefaultPlan) {
    planText = customOrDefaultPlan;
  } else if (mailMatchType === "BL") {
    planText = [
      `# ⚫ ${clanName} vs ${effectiveOpponentName} 🏴‍☠️`,
      "Everyone switch to WAR BASES!!",
      "This is our opportunity to gain some extra FWA points!",
      "➕ 30+ people switch to war base = +1 point",
      "➕ 60% total destruction = +1 point",
      "➕ win war = +1 point",
      "---",
      "If you need war base, check https://clashofclans-layouts.com/ or bases",
    ].join("\n");
  } else if (mailMatchType === "MM") {
    planText = [
      `# ⚪ ${clanName} vs ${effectiveOpponentName} :sob:`,
      "Keep WA base active, attack what you can!",
    ].join("\n");
  }

  const battleTargetMs = parseCocApiTime(war?.endTime);
  const warStartMs = parseCocApiTime(war?.startTime);
  const fallbackWarStartMs = subscription?.startTime
    ? subscription.startTime.getTime()
    : null;
  const effectiveWarStartMs = warStartMs ?? fallbackWarStartMs;
  const liveExpectedOutcome =
    matchType === "FWA" ? (outcome ?? "UNKNOWN") : null;
  const remainingText = formatDiscordRelativeMs(
    warState === "preparation" ? effectiveWarStartMs : battleTargetMs,
  );
  const warId =
    (await upsertCurrentWarHistoryAndGetWarId({
      guildId,
      normalizedTag,
      warStartMs: effectiveWarStartMs,
      warEndMs: battleTargetMs,
      currentSync,
      matchType,
      expectedOutcome: liveExpectedOutcome,
      clanName,
      opponentName: effectiveOpponentName,
      opponentTag: effectiveOpponentTag,
      war,
    })) ??
    (await getCurrentWarIdForClan(guildId, normalizedTag, effectiveWarStartMs));
  let displayClanStars = war?.clan?.stars ?? null;
  let displayOpponentStars = war?.opponent?.stars ?? null;
  let displayClanDestruction = war?.clan?.destructionPercentage ?? null;
  let displayOpponentDestruction = war?.opponent?.destructionPercentage ?? null;
  let statusLabel = mailStatusLabelForState(warState);
  let timeFieldName =
    warState === "preparation" ? "Prep Day Remaining" : "Battle Day Remaining";
  let timeFieldValue = remainingText;
  let finalOutcomeLabel: "WIN" | "LOSS" | "DRAW" | "UNKNOWN" | null = null;
  if (freezeRefresh) {
    const finalResult = await history.getWarEndResultSnapshot({
      clanTag: normalizedTag,
      opponentTag: effectiveOpponentTag,
      fallbackClanStars: subscription?.clanStars ?? null,
      fallbackOpponentStars: subscription?.opponentStars ?? null,
      warStartTime: subscription?.startTime ?? null,
    });
    const endedAtMs =
      finalResult.warEndTime?.getTime() ??
      subscription?.endTime?.getTime() ??
      battleTargetMs ??
      null;
    displayClanStars = finalResult.clanStars;
    displayOpponentStars = finalResult.opponentStars;
    displayClanDestruction = finalResult.clanDestruction;
    displayOpponentDestruction = finalResult.opponentDestruction;
    statusLabel = "War Ended";
    timeFieldName = "Time Ended";
    timeFieldValue = formatDiscordFullAndRelativeMs(endedAtMs);
    finalOutcomeLabel = formatWarResultLabel(finalResult.resultLabel);
  }
  const warStatsLines = buildWarStatsLines({
    clanStars: displayClanStars,
    opponentStars: displayOpponentStars,
    clanAttacks: war?.clan?.attacks ?? null,
    opponentAttacks: war?.opponent?.attacks ?? null,
    teamSize: war?.teamSize ?? null,
    attacksPerMember: war?.attacksPerMember ?? null,
    clanDestruction: displayClanDestruction,
    opponentDestruction: displayOpponentDestruction,
  });

  const unavailableReasons: string[] = [];
  if (!trackedConfig.mailChannelId) {
    unavailableReasons.push("Tracked clan mail channel is not configured.");
  }

  const embed = new EmbedBuilder()
    .setTitle(
      `Event: ${mailStatusTitleForState(warState)} - ${clanName} (#${normalizedTag})`,
    )
    .setColor(
      resolveWarMailEmbedColor({
        matchType: mailMatchType,
        expectedOutcome: mailExpectedOutcome,
      }),
    )
    .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
    .setTimestamp(new Date());
  embed.addFields(
    {
      name: "Opponent",
      value: `${effectiveOpponentName} (${effectiveOpponentTag ? `#${effectiveOpponentTag}` : "unknown"})`,
      inline: false,
    },
    {
      name: "War Status",
      value: statusLabel,
      inline: true,
    },
    {
      name: timeFieldName,
      value: timeFieldValue,
      inline: true,
    },
    {
      name: "Match Type",
      value: mailMatchType,
      inline: true,
    },
  );
  if (mailMatchType === "FWA" && mailExpectedOutcome) {
    embed.addFields({
      name: "Expected Outcome",
      value: mailExpectedOutcome,
      inline: true,
    });
  }
  if (finalOutcomeLabel) {
    embed.addFields({
      name: "Final Result",
      value: finalOutcomeLabel,
      inline: true,
    });
  }
  embed.addFields({
    name: "War Stats",
    value: warStatsLines.join("\n"),
    inline: false,
  });
  if (unavailableReasons.length > 0) {
    embed.addFields({
      name: "Warnings",
      value: unavailableReasons
        .map((reason) => `:warning: ${reason}`)
        .join("\n"),
      inline: false,
    });
  }

  return {
    embed,
    planText,
    inferredMatchType: mailInferredMatchType,
    mailChannelId: trackedConfig.mailChannelId,
    clanRoleId: trackedConfig.clanRoleId,
    warId,
    opponentTag: effectiveOpponentTag || null,
    warStartMs: effectiveWarStartMs,
    freezeRefresh,
    unavailableReasons,
    matchType: mailMatchType,
    expectedOutcome: mailExpectedOutcome,
  };
}

type ResolveLiveWarMailStatusParams = {
  client: Client | null | undefined;
  guildId: string | null;
  tag: string;
  warId: number | null | undefined;
  emitDebugLog?: boolean;
};

type ResolvedLiveWarMailStatus = {
  status: WarMailLifecycleNormalizedStatus;
  mailStatusEmoji: string;
  debug: WarMailLifecycleStatusDebugInfo;
};

type FwaMatchMailStatusDebugRow = {
  clanTag: string;
  clanName: string;
  warId: number | null;
  status: WarMailLifecycleNormalizedStatus;
  debug: WarMailLifecycleStatusDebugInfo;
};

type WarMailDebugTrackedTarget = {
  warId: string | null;
  channelId: string;
  messageId: string;
  source?: string | null;
};

/** Purpose: materialize structured mail-status debug snapshot for command rendering/logging. */
function buildWarMailStatusDebugSnapshot(params: {
  currentWarId: string | null;
  trackedTarget: WarMailDebugTrackedTarget | null;
  matchesCurrentMailConfig: boolean;
  status: WarMailLifecycleNormalizedStatus;
  reconciliationOutcome: WarMailLifecycleReconciliationOutcome;
  trackingCleared?: boolean;
}): WarMailLifecycleStatusDebugInfo {
  const trackedMailWarId =
    params.trackedTarget?.warId && params.trackedTarget.warId.trim()
      ? params.trackedTarget.warId.trim()
      : null;
  const trackedMessageExists =
    params.reconciliationOutcome === "exists"
      ? "yes"
      : params.reconciliationOutcome === "message_missing_confirmed" ||
          params.reconciliationOutcome === "channel_missing_confirmed"
        ? "no"
        : "unknown";
  const reconciliationCertainty =
    params.reconciliationOutcome === "exists" ||
    params.reconciliationOutcome === "message_missing_confirmed" ||
    params.reconciliationOutcome === "channel_missing_confirmed"
      ? "definitive"
      : params.reconciliationOutcome === "not_checked"
        ? "not_checked"
        : "uncertain";
  const debugReasonCode =
    params.status === "posted" && params.reconciliationOutcome === "exists"
      ? "live_matching_post_exists"
      : params.status === "deleted" &&
          params.reconciliationOutcome === "message_missing_confirmed"
        ? "tracked_post_missing_message"
        : params.status === "deleted" &&
            params.reconciliationOutcome === "channel_missing_confirmed"
          ? "tracked_post_missing_channel"
          : params.status === "posted" &&
              params.reconciliationOutcome === "channel_inaccessible"
            ? "transient_channel_inaccessible"
            : params.status === "posted" &&
                params.reconciliationOutcome === "transient_error"
              ? "transient_unverified"
              : "no_post_tracked";
  const debugReason =
    debugReasonCode === "live_matching_post_exists"
      ? "Tracked lifecycle message exists for the active war."
      : debugReasonCode === "tracked_post_missing_message"
        ? "Tracked lifecycle message is missing/deleted; lifecycle marked DELETED."
        : debugReasonCode === "tracked_post_missing_channel"
          ? "Tracked lifecycle channel is missing; lifecycle marked DELETED."
          : debugReasonCode === "transient_channel_inaccessible"
            ? "Tracked lifecycle channel is inaccessible; lifecycle remains POSTED."
            : debugReasonCode === "transient_unverified"
              ? "Tracked lifecycle message could not be verified due to transient error."
              : "No tracked lifecycle message exists for this war.";
  return {
    currentWarId: params.currentWarId,
    trackedMailWarId,
    trackedChannelId: params.trackedTarget?.channelId ?? null,
    trackedMessageId: params.trackedTarget?.messageId ?? null,
    trackedMessageExists,
    currentWarConfigMatchesTrackedMessage: params.matchesCurrentMailConfig,
    winningSource: params.trackedTarget ? "WarMailLifecycle" : "none",
    finalNormalizedStatus: params.status,
    reconciliationOutcome: params.reconciliationOutcome,
    reconciliationCertainty,
    debugReasonCode,
    debugReason,
    environmentMismatchSignal:
      Boolean(params.currentWarId) &&
      Boolean(trackedMailWarId) &&
      params.currentWarId !== trackedMailWarId,
    trackingCleared: Boolean(params.trackingCleared),
  };
}

/** Purpose: render operator-focused lines that explain authoritative tracked mail status. */
function buildMailStatusDebugLines(
  debug: WarMailLifecycleStatusDebugInfo,
): string[] {
  const trackedExistsText =
    debug.trackedMessageExists === "yes"
      ? "yes"
      : debug.trackedMessageExists === "no"
        ? "no"
        : "unknown";
  const lines = [
    "`[MAIL DEBUG]`",
    `- Current war id: ${debug.currentWarId ?? "unknown"}`,
    `- Tracked mail war id: ${debug.trackedMailWarId ?? "none"}`,
    `- Tracked channel id: ${debug.trackedChannelId ?? "none"}`,
    `- Tracked message id: ${debug.trackedMessageId ?? "none"}`,
    `- Tracked message exists: ${trackedExistsText}`,
    `- Current war/config matches tracked: ${debug.currentWarConfigMatchesTrackedMessage ? "yes" : "no"}`,
    `- Winning source: ${debug.winningSource}`,
    `- Reconciliation outcome: ${debug.reconciliationOutcome} (${debug.reconciliationCertainty})`,
    `- Final normalized status: ${debug.finalNormalizedStatus}`,
    `- Diagnosis: ${debug.debugReason}`,
    `- Tracking repaired: ${debug.trackingCleared ? "yes" : "no"}`,
  ];
  if (debug.environmentMismatchSignal) {
    lines.push(
      "- Environment mismatch signal: current war id differs from tracked mail war id.",
    );
  }
  return lines;
}

/** Purpose: collect lifecycle-only debug rows for `/fwa match debug-mail-status` without running heavy match flows. */
async function collectFwaMatchMailStatusDebugRows(params: {
  client: Client | null | undefined;
  guildId: string;
  tag: string;
}): Promise<FwaMatchMailStatusDebugRow[]> {
  const tracked = await prisma.trackedClan.findMany({
    where: params.tag
      ? {
          OR: [
            { tag: { equals: `#${params.tag}`, mode: "insensitive" } },
            { tag: { equals: params.tag, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  if (tracked.length === 0) return [];
  const normalizedTags = tracked.map((row) => normalizeTag(row.tag));
  const currentWars = await prisma.currentWar.findMany({
    where: {
      guildId: params.guildId,
      clanTag: { in: normalizedTags.map((tag) => `#${tag}`) },
    },
    select: { clanTag: true, warId: true },
  });
  const warIdByTag = new Map(
    currentWars.map((row) => [
      normalizeTag(row.clanTag),
      row.warId !== null &&
      row.warId !== undefined &&
      Number.isFinite(row.warId)
        ? Math.trunc(row.warId)
        : null,
    ]),
  );

  const rows = await Promise.all(
    tracked.map(async (row) => {
      const normalizedTag = normalizeTag(row.tag);
      const warId = warIdByTag.get(normalizedTag) ?? null;
      const resolved = await resolveLiveWarMailStatus({
        client: params.client,
        guildId: params.guildId,
        tag: normalizedTag,
        warId,
        emitDebugLog: true,
      });
      return {
        clanTag: normalizedTag,
        clanName: sanitizeClanName(row.name) ?? `#${normalizedTag}`,
        warId,
        status: resolved.status,
        debug: resolved.debug,
      };
    }),
  );

  return rows;
}

/** Purpose: render concise lifecycle diagnostics for `/fwa match debug-mail-status`. */
function buildFwaMatchMailStatusDebugSummaryLines(
  rows: FwaMatchMailStatusDebugRow[],
): string[] {
  return rows.flatMap((row) => [
    `${row.clanName} (#${row.clanTag})`,
    `- war_id=${row.warId ?? "none"}`,
    `- status=${row.status}`,
    `- message_id=${row.debug.trackedMessageId ?? "none"}`,
    `- channel_id=${row.debug.trackedChannelId ?? "none"}`,
    `- message_exists=${row.debug.trackedMessageExists}`,
    `- reconciliation=${row.debug.reconciliationOutcome}`,
    `- action=${row.debug.trackingCleared ? "mark_deleted" : "no_change"}`,
    "",
  ]);
}

/** Purpose: reconcile tracked war-mail state with live Discord message existence and return normalized status. */
async function resolveLiveWarMailStatus(
  params: ResolveLiveWarMailStatusParams,
): Promise<ResolvedLiveWarMailStatus> {
  const result = await warMailLifecycleService.resolveStatusForCurrentWar({
    client: params.client,
    guildId: params.guildId,
    clanTag: params.tag,
    warId: params.warId ?? null,
    emitDebugLog: params.emitDebugLog,
    sentEmoji: MAILBOX_SENT_EMOJI,
    unsentEmoji: MAILBOX_NOT_SENT_EMOJI,
  });
  console.info(
    `[fwa-mail-status] guild=${params.guildId ?? "none"} clan=#${normalizeTag(params.tag)} war_id=${result.debug.currentWarId ?? "unknown"} status=${result.status} reconciliation=${result.debug.reconciliationOutcome} source=${result.debug.winningSource}`,
  );
  return result;
}

/** Purpose: derive Send Mail blocking reason from normalized mail-status and command prerequisites. */
function getMailBlockedReasonFromStatus(params: {
  inferredMatchType: boolean;
  hasMailChannel: boolean;
  mailStatus: WarMailLifecycleNormalizedStatus;
}): string | null {
  return getMailBlockedReasonFromRevisionState({
    inferredMatchType: params.inferredMatchType,
    hasMailChannel: params.hasMailChannel,
    mailStatus: params.mailStatus,
    appliedDraft: null,
    draftDiffersFromBaseline: false,
    hasConfirmedBaseline: false,
  });
}

type WarMailFreshnessStatus =
  | "unsent"
  | "sent_up_to_date"
  | "sent_out_of_date"
  | "deleted";

/** Purpose: classify active-war mail freshness from lifecycle + baseline revision drift. */
function resolveWarMailFreshnessStatus(params: {
  lifecycleStatus: WarMailLifecycleNormalizedStatus;
  hasConfirmedBaseline: boolean;
  draftDiffersFromBaseline: boolean;
}): WarMailFreshnessStatus {
  if (params.lifecycleStatus === "deleted") return "deleted";
  if (params.lifecycleStatus !== "posted") return "unsent";
  if (!params.hasConfirmedBaseline || params.draftDiffersFromBaseline) {
    return "sent_out_of_date";
  }
  return "sent_up_to_date";
}

/** Purpose: render lifecycle + freshness-aware mail status copy for `/fwa match` cards. */
function formatMailLifecycleStatusLine(
  status: WarMailLifecycleNormalizedStatus,
  options?: {
    hasConfirmedBaseline?: boolean;
    draftDiffersFromBaseline?: boolean;
  },
): string {
  if (!options) {
    if (status === "posted") return "Mail status: **Mail Sent**";
    if (status === "deleted")
      return "Mail status: **Mail Deleted / Resend Available**";
    return "Mail status: **Send Mail Available**";
  }
  const freshness = resolveWarMailFreshnessStatus({
    lifecycleStatus: status,
    hasConfirmedBaseline: Boolean(options?.hasConfirmedBaseline),
    draftDiffersFromBaseline: Boolean(options?.draftDiffersFromBaseline),
  });
  if (freshness === "sent_up_to_date") {
    return "Mail status: **Mail Sent (Up to Date)**";
  }
  if (freshness === "sent_out_of_date") {
    return "Mail status: **Mail Sent (Out of Date)**";
  }
  if (freshness === "deleted") {
    return "Mail status: **Mail Deleted / Resend Available**";
  }
  return "Mail status: **Send Mail Available**";
}

/** Purpose: compute shared mail-send gating from lifecycle status + persisted baseline for one rendered war state. */
async function resolveMailSendGateForRenderedState(params: {
  client: Client | null | undefined;
  guildId: string;
  tag: string;
  hasMailChannel: boolean;
  inferredMatchType: boolean;
  emitDebugLog?: boolean;
  warId: number | null | undefined;
  warStartMs: number | null | undefined;
  opponentTag: string | null | undefined;
  matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
}): Promise<{
  mailStatus: ResolvedLiveWarMailStatus;
  liveRevisionFields: MatchRevisionFields | null;
  confirmedRevisionBaseline: MatchRevisionFields | null;
  draftDiffersFromBaseline: boolean;
  mailBlockedReason: string | null;
}> {
  const mailStatus = await resolveLiveWarMailStatus({
    client: params.client,
    guildId: params.guildId,
    tag: params.tag,
    warId: params.warId ?? null,
    emitDebugLog: params.emitDebugLog,
  });
  const warIdText = normalizeWarIdText(params.warId ?? null);
  const warStartTime =
    params.warStartMs !== null &&
    params.warStartMs !== undefined &&
    Number.isFinite(params.warStartMs)
      ? new Date(Math.trunc(params.warStartMs))
      : null;
  const syncRow = await pointsSyncService
    .getCurrentSyncForClan({
      guildId: params.guildId,
      clanTag: params.tag,
      warId: warIdText,
      warStartTime,
    })
    .catch(() => null);
  const mailConfig = await getCurrentWarMailConfig(params.guildId, params.tag);
  const liveRevisionFields = buildLiveRevisionFields({
    warId: warIdText ?? normalizeWarIdText(mailStatus.debug.currentWarId),
    opponentTag: params.opponentTag ?? "",
    matchType: params.matchType,
    expectedOutcome:
      params.matchType === "FWA" ? (params.expectedOutcome ?? "UNKNOWN") : null,
  });
  const confirmedRevisionBaseline = resolveConfirmedRevisionBaseline({
    syncRow: syncRow
      ? {
          warId: syncRow.warId ?? null,
          opponentTag: syncRow.opponentTag,
          lastKnownMatchType: syncRow.lastKnownMatchType ?? null,
          lastKnownOutcome: syncRow.lastKnownOutcome ?? null,
          isFwa: syncRow.isFwa ?? null,
          confirmedByClanMail: Boolean(syncRow.confirmedByClanMail),
        }
      : null,
    mailConfig: {
      lastWarId: mailConfig.lastWarId,
      lastOpponentTag: mailConfig.lastOpponentTag,
      lastMatchType: mailConfig.lastMatchType,
      lastExpectedOutcome: mailConfig.lastExpectedOutcome,
    },
    liveFields: liveRevisionFields,
    lifecycleStatus: mailStatus.status,
  });
  const draftDiffersFromBaseline = Boolean(
    confirmedRevisionBaseline &&
    liveRevisionFields &&
    !areRevisionFieldsEqual(confirmedRevisionBaseline, liveRevisionFields),
  );
  const mailBlockedReason = getMailBlockedReasonFromRevisionState({
    inferredMatchType: params.inferredMatchType,
    hasMailChannel: params.hasMailChannel,
    mailStatus: mailStatus.status,
    appliedDraft: draftDiffersFromBaseline ? liveRevisionFields : null,
    draftDiffersFromBaseline,
    hasConfirmedBaseline: Boolean(confirmedRevisionBaseline),
  });
  return {
    mailStatus,
    liveRevisionFields,
    confirmedRevisionBaseline,
    draftDiffersFromBaseline,
    mailBlockedReason,
  };
}

function formatOutcomeForRevision(
  outcome: "WIN" | "LOSE" | "UNKNOWN" | null,
): string {
  return outcome ?? "N/A";
}

function buildWarMailRevisionLines(params: {
  previousMatchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
  previousExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  nextMatchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
  nextExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
}): string[] {
  const lines: string[] = [];
  if (params.previousMatchType !== params.nextMatchType) {
    lines.push(
      `- Match Type: **${params.previousMatchType}** -> **${params.nextMatchType}**`,
    );
  }
  if (params.previousExpectedOutcome !== params.nextExpectedOutcome) {
    lines.push(
      `- Expected outcome: **${formatOutcomeForRevision(params.previousExpectedOutcome)}** -> **${formatOutcomeForRevision(params.nextExpectedOutcome)}**`,
    );
  }
  return lines;
}

export const buildWarMailRevisionLinesForTest = buildWarMailRevisionLines;
export const buildFwaMatchMailStatusDebugSummaryLinesForTest =
  buildFwaMatchMailStatusDebugSummaryLines;

function buildSupersededWarMailDescription(params: {
  changedAtMs: number;
  revisionLines: string[];
}): string {
  const changedAtSec = Math.floor(params.changedAtMs / 1000);
  return [`Superseded at <t:${changedAtSec}:F>`, ...params.revisionLines].join(
    "\n",
  );
}

export const buildSupersededWarMailDescriptionForTest =
  buildSupersededWarMailDescription;

function buildSupersededWarMailContent(params: {
  changedAtMs: number;
  revisionLines: string[];
}): string {
  return limitDiscordContent(
    `:warning: ${buildSupersededWarMailDescription(params)}`,
  );
}

function stopWarMailPolling(key: string): void {
  const timer = fwaMailPollers.get(key);
  if (timer) {
    clearInterval(timer);
    fwaMailPollers.delete(key);
  }
}

async function annotatePreviousWarMailRevision(params: {
  client: Client;
  previous: {
    channelId: string;
    messageId: string;
    matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
    expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  };
  nextMatchType: "FWA" | "BL" | "MM" | "UNKNOWN";
  nextExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  changedAtMs: number;
}): Promise<boolean> {
  const revisionLines = buildWarMailRevisionLines({
    previousMatchType: params.previous.matchType,
    previousExpectedOutcome: params.previous.expectedOutcome,
    nextMatchType: params.nextMatchType,
    nextExpectedOutcome: params.nextExpectedOutcome,
  });
  if (revisionLines.length === 0) return false;

  const channel = await params.client.channels
    .fetch(params.previous.channelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased()) return false;
  const message = await (channel as any).messages
    .fetch(params.previous.messageId)
    .catch(() => null);
  if (!message) return false;
  const supersededSummary = buildSupersededWarMailDescription({
    changedAtMs: params.changedAtMs,
    revisionLines,
  });
  const previousEmbed = message.embeds[0]
    ? EmbedBuilder.from(message.embeds[0])
    : new EmbedBuilder();
  previousEmbed.setDescription(supersededSummary.slice(0, 4096));
  await message.edit({
    content: buildSupersededWarMailContent({
      changedAtMs: params.changedAtMs,
      revisionLines,
    }),
    embeds: [previousEmbed],
    components: [],
  });
  return true;
}

function buildWarMailPreviewComponents(params: {
  userId: string;
  key: string;
  enabled: boolean;
  showBack?: boolean;
}): Array<ActionRowBuilder<ButtonBuilder>> {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(buildFwaMailConfirmCustomId(params.userId, params.key))
      .setLabel("Confirm and Send")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!params.enabled),
    new ButtonBuilder()
      .setCustomId(buildFwaMailConfirmNoPingCustomId(params.userId, params.key))
      .setLabel("Send Without Ping")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!params.enabled),
  ];
  if (params.showBack) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(buildFwaMailBackCustomId(params.userId, params.key))
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

/** Purpose: prefer tracked-clan fallback sync when it is the proof source for current-war validation. */
function resolveObservedSyncNumberForMatchup(params: {
  primarySnapshot: {
    effectiveSync: number | null;
    winnerBoxSync?: number | null;
    winnerBoxHasTag?: boolean;
  } | null;
  opponentSnapshot: {
    snapshotSource: PointsSnapshot["snapshotSource"];
    fallbackCurrentForWar?: boolean;
    effectiveSync: number | null;
    winnerBoxSync?: number | null;
    winnerBoxHasTag?: boolean;
  } | null;
}): number | null {
  const resolveSnapshotSync = (snapshot: {
    effectiveSync: number | null;
    winnerBoxSync?: number | null;
    winnerBoxHasTag?: boolean;
  }): number | null => {
    const winnerBoxSync = snapshot.winnerBoxSync;
    if (
      winnerBoxSync !== null &&
      winnerBoxSync !== undefined &&
      Number.isFinite(winnerBoxSync) &&
      snapshot.winnerBoxHasTag !== false
    ) {
      return Math.trunc(winnerBoxSync);
    }
    const effectiveSync = snapshot.effectiveSync;
    if (
      effectiveSync !== null &&
      effectiveSync !== undefined &&
      Number.isFinite(effectiveSync)
    ) {
      return Math.trunc(effectiveSync);
    }
    return winnerBoxSync !== null &&
      winnerBoxSync !== undefined &&
      Number.isFinite(winnerBoxSync)
      ? Math.trunc(winnerBoxSync)
      : null;
  };
  const fallbackSync =
    params.opponentSnapshot?.snapshotSource === "tracked_clan_fallback" &&
    params.opponentSnapshot.fallbackCurrentForWar
      ? resolveSnapshotSync(params.opponentSnapshot)
      : null;
  if (fallbackSync !== null) {
    return fallbackSync;
  }
  if (!params.primarySnapshot) return null;
  return resolveSnapshotSync(params.primarySnapshot);
}

function buildWarMailPostedComponents(
  key: string,
): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMailRefreshCustomId(key))
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Purpose: build deterministic poll/refresh lookup key from lifecycle identity only. */
function buildWarMailPollKey(
  guildId: string,
  tag: string,
  warId: number | null,
): string {
  return `${guildId}|${normalizeTag(tag)}|${warId ?? 0}`;
}

/** Purpose: parse deterministic poll/refresh lookup key into lifecycle identity. */
function parseWarMailPollKey(
  key: string,
): { guildId: string; tag: string; warId: number | null } | null {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  const guildId = parts[0]?.trim() ?? "";
  const tag = normalizeTag(parts[1] ?? "");
  const warIdRaw = Number(parts[2]);
  if (!guildId || !tag) return null;
  const warId =
    Number.isFinite(warIdRaw) && Math.trunc(warIdRaw) > 0
      ? Math.trunc(warIdRaw)
      : null;
  return { guildId, tag, warId };
}

function buildNextRefreshRelativeLabel(
  intervalMs: number,
  nowMs = Date.now(),
  nextScheduledAtMs?: number | null,
): string {
  const nextAtMs =
    nextScheduledAtMs !== null &&
    nextScheduledAtMs !== undefined &&
    Number.isFinite(nextScheduledAtMs)
      ? Math.trunc(nextScheduledAtMs)
      : Math.trunc(nowMs + intervalMs);
  return `Next refresh <t:${Math.floor(nextAtMs / 1000)}:R>`;
}

function buildWarMailPostedContent(
  roleId?: string | null,
  nowMs?: number,
  options?: {
    pingRole?: boolean;
    planText?: string;
    includeNextRefresh?: boolean;
  },
): string {
  const normalizedRoleId = normalizeDiscordRoleId(roleId);
  const includeNextRefresh = options?.includeNextRefresh !== false;
  const nextRefresh = includeNextRefresh
    ? buildNextRefreshRelativeLabel(
        WAR_MAIL_REFRESH_MS,
        nowMs,
        getNextWarMailRefreshAtMs(),
      )
    : "";
  const planText = String(options?.planText ?? "").trim();
  if (!planText) {
    if (normalizedRoleId && options?.pingRole !== false) {
      return includeNextRefresh
        ? `<@&${normalizedRoleId}>\n${nextRefresh}`
        : `<@&${normalizedRoleId}>`;
    }
    return nextRefresh || "War plan unavailable.";
  }
  const sections: string[] = [];
  sections.push(planText);
  if (normalizedRoleId && options?.pingRole !== false) {
    sections.push(`<@&${normalizedRoleId}>`);
  }
  if (nextRefresh) {
    sections.push(nextRefresh);
  }
  return limitDiscordContent(sections.join("\n\n"));
}

export const buildWarMailPostedContentForTest = buildWarMailPostedContent;
export const buildWarMailNextRefreshLabelForTest =
  buildNextRefreshRelativeLabel;

/** Purpose: keep an already-visible role mention on refresh edits without deriving new mention state. */
function extractPostedWarMailMentionRoleId(
  existingPostedContent: string | null | undefined,
): string | null {
  const lines = String(existingPostedContent ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^<@&(\d{5,})>$/);
    if (match?.[1]) return normalizeDiscordRoleId(match[1]);
  }
  return null;
}

/** Purpose: build refresh edit payload while preserving visible mention text and suppressing re-pings. */
function buildWarMailRefreshEditPayload(
  existingPostedContent: string | null | undefined,
  planText: string | null | undefined,
  nowMs?: number,
): {
  content: string;
  allowedMentions: { parse: [] };
} {
  const persistedMentionRoleId = extractPostedWarMailMentionRoleId(
    existingPostedContent,
  );
  return {
    content: buildWarMailPostedContent(persistedMentionRoleId, nowMs, {
      planText: String(planText ?? ""),
    }),
    allowedMentions: { parse: [] },
  };
}

export const buildWarMailRefreshEditPayloadForTest =
  buildWarMailRefreshEditPayload;

function hasWarIdentityShifted(params: {
  postedWarId?: string | null;
  postedWarStartMs?: number | null;
  postedOpponentTag?: string | null;
  renderedWarId?: number | null;
  renderedWarStartMs?: number | null;
  renderedOpponentTag?: string | null;
  expectedWarId?: string | null;
  expectedWarStartMs?: number | null;
  expectedOpponentTag?: string | null;
}): boolean {
  const postedWarId =
    typeof params.postedWarId === "string" && params.postedWarId.trim()
      ? params.postedWarId.trim()
      : null;
  const expectedWarId =
    typeof params.expectedWarId === "string" && params.expectedWarId.trim()
      ? params.expectedWarId.trim()
      : null;
  const identityWarId = expectedWarId ?? postedWarId;
  const renderedWarId =
    params.renderedWarId !== null &&
    params.renderedWarId !== undefined &&
    Number.isFinite(params.renderedWarId)
      ? String(Math.trunc(params.renderedWarId))
      : null;
  if (identityWarId && renderedWarId && identityWarId !== renderedWarId)
    return true;

  const postedWarStartMs =
    typeof params.postedWarStartMs === "number" &&
    Number.isFinite(params.postedWarStartMs)
      ? Math.trunc(params.postedWarStartMs)
      : null;
  const expectedWarStartMs =
    typeof params.expectedWarStartMs === "number" &&
    Number.isFinite(params.expectedWarStartMs)
      ? Math.trunc(params.expectedWarStartMs)
      : null;
  const identityWarStartMs = expectedWarStartMs ?? postedWarStartMs;
  const renderedWarStartMs =
    typeof params.renderedWarStartMs === "number" &&
    Number.isFinite(params.renderedWarStartMs)
      ? Math.trunc(params.renderedWarStartMs)
      : null;
  if (
    identityWarStartMs !== null &&
    renderedWarStartMs !== null &&
    identityWarStartMs !== renderedWarStartMs
  ) {
    return true;
  }
  const normalizeIdentityTag = (value: string | null | undefined): string | null => {
    const normalized = normalizeTag(String(value ?? ""));
    return normalized || null;
  };
  const postedOpponentTag = normalizeIdentityTag(params.postedOpponentTag);
  const expectedOpponentTag = normalizeIdentityTag(params.expectedOpponentTag);
  const identityOpponentTag = expectedOpponentTag ?? postedOpponentTag;
  const renderedOpponentTag = normalizeIdentityTag(params.renderedOpponentTag);
  if (
    identityOpponentTag &&
    renderedOpponentTag &&
    identityOpponentTag !== renderedOpponentTag
  ) {
    return true;
  }
  return false;
}

export const hasWarIdentityShiftedForTest = hasWarIdentityShifted;

type WarMailRefreshIdentityDecision = {
  action: "edit" | "freeze";
  identityShifted: boolean;
};

/** Purpose: deterministically choose whether a posted war-mail refresh can edit or must freeze. */
function resolveWarMailRefreshIdentityDecision(params: {
  postedWarId?: string | null;
  postedWarStartMs?: number | null;
  postedOpponentTag?: string | null;
  renderedWarId?: number | null;
  renderedWarStartMs?: number | null;
  renderedOpponentTag?: string | null;
  expectedWarId?: string | null;
  expectedWarStartMs?: number | null;
  expectedOpponentTag?: string | null;
}): WarMailRefreshIdentityDecision {
  const hasExpectedWarIdentity = Boolean(
    (typeof params.expectedWarId === "string" && params.expectedWarId.trim()) ||
      (typeof params.expectedWarStartMs === "number" &&
        Number.isFinite(params.expectedWarStartMs)),
  );
  const hasPostedIdentity = Boolean(
    (typeof params.postedWarId === "string" && params.postedWarId.trim()) ||
      (typeof params.postedWarStartMs === "number" &&
        Number.isFinite(params.postedWarStartMs)) ||
      normalizeTag(String(params.postedOpponentTag ?? "")),
  );
  if (!hasExpectedWarIdentity && !hasPostedIdentity) {
    return {
      action: "freeze",
      identityShifted: true,
    };
  }
  const identityShifted = hasWarIdentityShifted(params);
  return {
    action: identityShifted ? "freeze" : "edit",
    identityShifted,
  };
}

async function refreshWarMailPost(
  client: Client,
  key: string,
): Promise<"refreshed" | "frozen" | "missing"> {
  const parsed = parseWarMailPollKey(key);
  if (!parsed || parsed.warId === null) {
    stopWarMailPolling(key);
    return "missing";
  }
  const lifecycle = await warMailLifecycleService
    .getLifecycleForWar({
      guildId: parsed.guildId,
      clanTag: parsed.tag,
      warId: parsed.warId,
    })
    .catch(() => null);
  if (
    !lifecycle ||
    lifecycle.status !== "POSTED" ||
    !lifecycle.channelId ||
    !lifecycle.messageId
  ) {
    stopWarMailPolling(key);
    return "missing";
  }
  const refreshed = await refreshWarMailPostByResolvedTarget({
    client,
    guildId: parsed.guildId,
    tag: parsed.tag,
    channelId: lifecycle.channelId,
    messageId: lifecycle.messageId,
    key,
    expectedWarId: String(parsed.warId),
    expectedWarStartMs: await resolveExpectedWarStartMsForRefresh({
      guildId: parsed.guildId,
      tag: parsed.tag,
      warId: parsed.warId,
    }),
    fetchReason: "mail_refresh",
    routine: true,
  });
  if (refreshed !== "refreshed") {
    stopWarMailPolling(key);
  }
  return refreshed;
}

async function refreshWarMailPostByResolvedTarget(params: {
  client: Client;
  guildId: string;
  tag: string;
  channelId: string;
  messageId: string;
  key?: string;
  expectedWarId?: string | null;
  expectedWarStartMs?: number | null;
  fetchReason?: PointsApiFetchReason;
  routine?: boolean;
}): Promise<"refreshed" | "frozen" | "missing"> {
  const normalizedTag = normalizeTag(params.tag);
  if (!normalizedTag) return "missing";
  const logIdentityDecision = (input: {
    action: "edit" | "freeze" | "missing";
    identityShifted: boolean;
    renderedWarId?: number | null;
    renderedWarStartMs?: number | null;
    renderedOpponentTag?: string | null;
    postedWarId?: string | null;
    postedOpponentTag?: string | null;
  }): void => {
    const expectedWarIdText =
      typeof params.expectedWarId === "string" && params.expectedWarId.trim()
        ? params.expectedWarId.trim()
        : "none";
    const expectedWarStartText =
      typeof params.expectedWarStartMs === "number" &&
      Number.isFinite(params.expectedWarStartMs)
        ? String(Math.trunc(params.expectedWarStartMs))
        : "none";
    const renderedWarIdText =
      input.renderedWarId !== null &&
      input.renderedWarId !== undefined &&
      Number.isFinite(input.renderedWarId)
        ? String(Math.trunc(input.renderedWarId))
        : "unknown";
    const renderedWarStartText =
      typeof input.renderedWarStartMs === "number" &&
      Number.isFinite(input.renderedWarStartMs)
        ? String(Math.trunc(input.renderedWarStartMs))
        : "unknown";
    const renderedOpponentTag = normalizeTag(String(input.renderedOpponentTag ?? ""));
    const postedWarIdText =
      typeof input.postedWarId === "string" && input.postedWarId.trim()
        ? input.postedWarId.trim()
        : "unknown";
    const postedOpponentTag = normalizeTag(String(input.postedOpponentTag ?? ""));
    console.info(
      `[fwa-mail-refresh-identity] guild=${params.guildId} clan=#${normalizedTag} message_id=${params.messageId} expected_war_id=${expectedWarIdText} expected_war_start_ms=${expectedWarStartText} posted_war_id=${postedWarIdText} posted_opponent=${postedOpponentTag ? `#${postedOpponentTag}` : "unknown"} rendered_war_id=${renderedWarIdText} rendered_war_start_ms=${renderedWarStartText} rendered_opponent=${renderedOpponentTag ? `#${renderedOpponentTag}` : "unknown"} identity_shifted=${input.identityShifted ? "1" : "0"} action=${input.action}`,
    );
  };
  let channel: any = null;
  try {
    channel = await params.client.channels.fetch(params.channelId);
  } catch (err) {
    const code = Number(
      (err as { code?: unknown } | null | undefined)?.code ?? NaN,
    );
    if ((code === 10003 || code === 10008) && params.expectedWarId) {
      await warMailLifecycleService
        .markDeleted({
          guildId: params.guildId,
          clanTag: normalizedTag,
          warId: Number(params.expectedWarId),
        })
        .catch(() => undefined);
    }
    logIdentityDecision({
      action: "missing",
      identityShifted: false,
    });
    return "missing";
  }
  if (!channel || !channel.isTextBased()) {
    logIdentityDecision({
      action: "missing",
      identityShifted: false,
    });
    return "missing";
  }
  let message: any = null;
  let messageVerifiedViaRest = false;
  try {
    // Force REST validation so deleted-message checks cannot be satisfied by stale cache.
    message = await (channel as any).messages.fetch({
      message: params.messageId,
      force: true,
    });
    messageVerifiedViaRest = true;
  } catch (err) {
    const code = Number(
      (err as { code?: unknown } | null | undefined)?.code ?? NaN,
    );
    if ((code === 10003 || code === 10008) && params.expectedWarId) {
      await warMailLifecycleService
        .markDeleted({
          guildId: params.guildId,
          clanTag: normalizedTag,
          warId: Number(params.expectedWarId),
        })
        .catch(() => undefined);
    }
    logIdentityDecision({
      action: "missing",
      identityShifted: false,
    });
    return "missing";
  }
  if (!message) {
    if (params.expectedWarId) {
      await warMailLifecycleService
        .markDeleted({
          guildId: params.guildId,
          clanTag: normalizedTag,
          warId: Number(params.expectedWarId),
        })
        .catch(() => undefined);
    }
    logIdentityDecision({
      action: "missing",
      identityShifted: false,
    });
    return "missing";
  }
  const postedWarId = extractWarMailIdFromMessage(message);
  const postedOpponentTag = extractWarMailOpponentTagFromMessage(message);
  const identityDecision = resolveWarMailRefreshIdentityDecision({
    postedWarId,
    postedOpponentTag,
    renderedWarId: null,
    renderedWarStartMs: null,
    renderedOpponentTag: null,
    expectedWarId: params.expectedWarId,
    expectedWarStartMs: params.expectedWarStartMs,
  });
  if (identityDecision.action === "freeze") {
    logIdentityDecision({
      action: "freeze",
      identityShifted: identityDecision.identityShifted,
      postedWarId,
      postedOpponentTag,
    });
    await message
      .edit({
        components: [],
      })
      .catch(() => undefined);
    if (params.key) stopWarMailPolling(params.key);
    return "frozen";
  }
  const cocService = new CoCService();
  const rendered = await buildWarMailEmbedForTag(
    cocService,
    params.guildId,
    normalizedTag,
    {
      fetchReason: params.fetchReason,
      routine: params.routine,
    },
  );
  const renderedIdentityDecision = resolveWarMailRefreshIdentityDecision({
    postedWarId,
    postedOpponentTag,
    renderedWarId: rendered.warId,
    renderedWarStartMs: rendered.warStartMs,
    renderedOpponentTag: rendered.opponentTag,
    expectedWarId: params.expectedWarId,
    expectedWarStartMs: params.expectedWarStartMs,
  });
  const identityShifted = renderedIdentityDecision.identityShifted;
  logIdentityDecision({
    action: renderedIdentityDecision.action,
    identityShifted,
    renderedWarId: rendered.warId,
    renderedWarStartMs: rendered.warStartMs,
    renderedOpponentTag: rendered.opponentTag,
    postedWarId,
    postedOpponentTag,
  });
  if (renderedIdentityDecision.action === "freeze") {
    await message
      .edit({
        components: [],
      })
      .catch(() => undefined);
    if (params.key) stopWarMailPolling(params.key);
    return "frozen";
  }
  const nextWarIdText =
    rendered.warId !== null &&
    rendered.warId !== undefined &&
    Number.isFinite(rendered.warId)
      ? String(Math.trunc(rendered.warId))
      : (params.expectedWarId ?? null);
  const refreshKey =
    params.key ??
    buildWarMailPollKey(
      params.guildId,
      normalizedTag,
      nextWarIdText && Number.isFinite(Number(nextWarIdText))
        ? Number(nextWarIdText)
        : null,
    );
  const refreshEditPayload = rendered.freezeRefresh
    ? null
    : buildWarMailRefreshEditPayload(
        String(message?.content ?? ""),
        rendered.planText,
      );
  await message.edit({
    content: rendered.freezeRefresh ? undefined : refreshEditPayload?.content,
    allowedMentions: rendered.freezeRefresh
      ? undefined
      : refreshEditPayload?.allowedMentions,
    embeds: [rendered.embed],
    components: rendered.freezeRefresh
      ? []
      : buildWarMailPostedComponents(refreshKey),
  });
  const lifecycleWarIdText =
    typeof params.expectedWarId === "string" && params.expectedWarId.trim()
      ? params.expectedWarId.trim()
      : nextWarIdText;
  if (
    messageVerifiedViaRest &&
    lifecycleWarIdText &&
    Number.isFinite(Number(lifecycleWarIdText)) &&
    params.channelId &&
    params.messageId
  ) {
    await warMailLifecycleService
      .markPosted({
        guildId: params.guildId,
        clanTag: normalizedTag,
        warId: Number(lifecycleWarIdText),
        channelId: params.channelId,
        messageId: params.messageId,
      })
      .catch(() => undefined);
  }
  if (rendered.freezeRefresh && params.key) {
    stopWarMailPolling(params.key);
  }
  return rendered.freezeRefresh ? "frozen" : "refreshed";
}

function extractWarMailTagFromMessage(
  message: ButtonInteraction["message"],
): string | null {
  const title = String(message.embeds?.[0]?.title ?? "");
  const match = title.match(/\(#([A-Z0-9]+)\)\s*$/i);
  if (!match?.[1]) return null;
  return normalizeTag(match[1]);
}

function extractWarMailIdFromMessage(
  message: ButtonInteraction["message"],
): string | null {
  const footerText = String(message.embeds?.[0]?.footer?.text ?? "");
  const match = footerText.match(/war\s*id:\s*(\d+)/i);
  if (!match?.[1]) return null;
  return match[1];
}

function extractWarMailOpponentTagFromMessage(
  message: ButtonInteraction["message"],
): string | null {
  const fields = message.embeds?.[0]?.fields ?? [];
  const opponentField = fields.find((field) =>
    String(field?.name ?? "").trim().toLowerCase() === "opponent",
  );
  const opponentValue = String(opponentField?.value ?? "");
  const match = opponentValue.match(/#([A-Z0-9]+)/i);
  if (!match?.[1]) return null;
  return normalizeTag(match[1]);
}

async function resolveExpectedWarStartMsForRefresh(params: {
  guildId: string;
  tag: string;
  warId: number | null | undefined;
}): Promise<number | null> {
  if (
    params.warId === null ||
    params.warId === undefined ||
    !Number.isFinite(params.warId)
  ) {
    return null;
  }
  const warId = Math.trunc(params.warId);
  const row = await prisma.currentWar
    .findUnique({
      where: {
        clanTag_guildId: {
          guildId: params.guildId,
          clanTag: `#${normalizeTag(params.tag)}`,
        },
      },
      select: {
        warId: true,
        startTime: true,
      },
    })
    .catch(() => null);
  if (
    !row ||
    row.warId === null ||
    row.warId === undefined ||
    !Number.isFinite(row.warId) ||
    Math.trunc(row.warId) !== warId ||
    !(row.startTime instanceof Date)
  ) {
    return null;
  }
  return row.startTime.getTime();
}

async function findWarMailTargetFromLifecycle(params: {
  guildId: string;
  channelId: string;
  messageId: string;
  warId?: string | null;
}): Promise<{
  tag: string;
  warId: string | null;
  channelId: string;
  messageId: string;
} | null> {
  const requestedWarId =
    typeof params.warId === "string" && params.warId.trim()
      ? Math.trunc(Number(params.warId))
      : null;
  const row = await warMailLifecycleService.findLifecycleByMessage({
    guildId: params.guildId,
    channelId: params.channelId,
    messageId: params.messageId,
    warId:
      requestedWarId !== null && Number.isFinite(requestedWarId)
        ? requestedWarId
        : null,
  });
  if (!row || !row.channelId || !row.messageId) return null;
  return {
    tag: normalizeTag(row.clanTag ?? ""),
    warId:
      row.warId !== null &&
      row.warId !== undefined &&
      Number.isFinite(row.warId)
        ? String(Math.trunc(row.warId))
        : null,
    channelId: row.channelId,
    messageId: row.messageId,
  };
}

function startWarMailPolling(client: Client, key: string): void {
  stopWarMailPolling(key);
  const timer = setInterval(() => {
    refreshWarMailPost(client, key).catch(() => undefined);
  }, WAR_MAIL_REFRESH_MS);
  fwaMailPollers.set(key, timer);
}

function buildFwaMatchCopyComponents(
  payload: FwaMatchCopyPayload,
  userId: string,
  key: string,
  showMode: "embed" | "copy",
): Array<
  ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
> {
  const view =
    payload.currentScope === "alliance" || !payload.currentTag
      ? payload.allianceView
      : (payload.singleViews[payload.currentTag] ?? payload.allianceView);
  const matchTypeAction = view.matchTypeAction ?? null;
  const outcomeAction = view.outcomeAction ?? null;
  const syncAction = view.syncAction ?? null;
  const mailAction = view.mailAction ?? null;
  const skipSyncAction = view.skipSyncAction ?? null;
  const undoSkipSyncAction = view.undoSkipSyncAction ?? null;
  const toggleMode = showMode === "embed" ? "copy" : "embed";
  const toggleLabel = showMode === "embed" ? "Copy/Paste View" : "Embed View";
  const baseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildFwaMatchCopyCustomId(userId, key, toggleMode))
      .setLabel(toggleLabel)
      .setStyle(ButtonStyle.Secondary),
  );
  if (payload.includePostButton) {
    baseRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildPointsPostButtonCustomId(userId))
        .setLabel("Post to Channel")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (payload.currentScope === "single") {
    baseRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMatchAllianceCustomId(userId, key))
        .setLabel("Alliance View")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  if (payload.currentScope === "single" && payload.currentTag && showMode === "embed") {
    baseRow.addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildFwaMatchTieBreakerCustomId({
            userId,
            key,
            tag: payload.currentTag,
          }),
        )
        .setLabel("Tie-breaker rules")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  const rows: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  > = [baseRow];
  if (payload.currentScope === "single" && payload.currentTag && mailAction) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildFwaMatchSendMailCustomId(userId, key, payload.currentTag),
          )
          .setLabel("Send Mail")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!mailAction.enabled),
      ),
    );
  }
  if (matchTypeAction) {
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "FWA",
          }),
        )
        .setLabel("FWA")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "BL",
          }),
        )
        .setLabel("BL")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(
          buildMatchTypeActionCustomId({
            userId,
            tag: matchTypeAction.tag,
            targetType: "MM",
          }),
        )
        .setLabel("MM")
        .setStyle(ButtonStyle.Secondary),
    );
    rows.push(actionRow);
  } else if (payload.currentScope === "single" && view.matchTypeCurrent) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildMatchTypeEditCustomId({ userId, key }))
          .setLabel("Change Match Type")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (outcomeAction) {
    const outcomeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildOutcomeActionCustomId({
            userId,
            tag: outcomeAction.tag,
            currentOutcome: outcomeAction.currentOutcome,
          }),
        )
        .setLabel("Reverse Outcome")
        .setStyle(ButtonStyle.Primary),
    );
    rows.push(outcomeRow);
  }
  if (syncAction) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildMatchSyncActionCustomId({
              userId,
              key,
              tag: syncAction.tag,
            }),
          )
          .setLabel("Sync Data")
          .setStyle(ButtonStyle.Danger),
      ),
    );
  }
  if (skipSyncAction) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildMatchSkipSyncActionCustomId({
              userId,
              key,
              tag: skipSyncAction.tag,
            }),
          )
          .setLabel("SKIP SYNC")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  if (undoSkipSyncAction) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildMatchSkipSyncUndoCustomId({
              userId,
              key,
              tag: undoSkipSyncAction.tag,
            }),
          )
          .setLabel("UNDO")
          .setStyle(ButtonStyle.Danger),
      ),
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
            const warningSuffix = viewForTag?.inferredMatchType ? " ⚠️" : "";
            const mailStatusEmoji =
              viewForTag?.mailStatusEmoji ?? MAILBOX_NOT_SENT_EMOJI;
            return {
              label: `${mailStatusEmoji} ${clanName}${warningSuffix}`.slice(
                0,
                100,
              ),
              description: (viewForTag?.inferredMatchType
                ? `#${tag} | Match type is inferred`
                : `#${tag}`
              ).slice(0, 100),
              value: tag,
            };
          }),
        );
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      );
    }
  }
  return rows;
}

export async function handleFwaComplianceViewButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaComplianceViewCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  const payload = fwaComplianceViewPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content:
        "This compliance view expired. Please run /fwa compliance again.",
    });
    return;
  }

  if (parsed.action === "open_missed") {
    payload.activeView = "missed";
  } else if (parsed.action === "open_main") {
    if (payload.isFwa) {
      payload.activeView = "fwa_main";
    }
  } else if (parsed.action === "prev") {
    if (payload.activeView === "fwa_main") {
      payload.mainPage = Math.max(0, payload.mainPage - 1);
    } else {
      payload.missedPage = Math.max(0, payload.missedPage - 1);
    }
  } else if (parsed.action === "next") {
    if (payload.activeView === "fwa_main") {
      payload.mainPage += 1;
    } else {
      payload.missedPage += 1;
    }
  }

  const rendered = renderComplianceViewPayload({
    key: parsed.key,
    payload,
  });
  fwaComplianceViewPayloads.set(parsed.key, payload);
  await interaction.update({
    content: undefined,
    embeds: rendered.embeds,
    components: rendered.components,
  });
}

export async function handleFwaMatchCopyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaMatchCopyCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "copy_toggle_click",
    `user=${interaction.user.id} mode=${parsed.mode} key=${parsed.key}`,
  );

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
      ? (payload.singleViews[payload.currentTag] ?? payload.allianceView)
      : payload.allianceView;
  if (parsed.mode === "copy") {
    await interaction.update({
      content: limitDiscordContent(view.copyText),
      embeds: [],
      components: buildFwaMatchCopyComponents(
        payload,
        payload.userId,
        parsed.key,
        "copy",
      ),
    });
    return;
  }

  await interaction.update({
    content: undefined,
    embeds: [view.embed],
    components: buildFwaMatchCopyComponents(
      payload,
      payload.userId,
      parsed.key,
      "embed",
    ),
  });
}

export async function handleFwaMatchSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseFwaMatchSelectCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "single_select_click",
    `user=${interaction.user.id} key=${parsed.key}`,
  );
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
    components: buildFwaMatchCopyComponents(
      payload,
      payload.userId,
      parsed.key,
      "embed",
    ),
  });
}

export async function handleFwaMatchAllianceButton(
  interaction: ButtonInteraction,
  cocService?: CoCService,
): Promise<void> {
  const parsed = parseFwaMatchAllianceCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "alliance_view_click",
    `user=${interaction.user.id} key=${parsed.key}`,
  );
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
  if (shouldHydrateAlliancePayload(payload)) {
    await interaction.deferUpdate();
    const clearProcessing = await showProcessingNotice(
      interaction,
      "Loading alliance view...",
    );
    try {
      const hydrated = await hydrateAlliancePayloadIfScoped(
        payload,
        cocService ?? new CoCService(),
        interaction.client,
      );
      hydrated.currentScope = "alliance";
      hydrated.currentTag = null;
      fwaMatchCopyPayloads.set(parsed.key, hydrated);
      await interaction.message.edit({
        content: undefined,
        embeds: [hydrated.allianceView.embed],
        components: buildFwaMatchCopyComponents(
          hydrated,
          hydrated.userId,
          parsed.key,
          "embed",
        ),
      });
    } finally {
      await clearProcessing();
    }
    return;
  }
  payload.currentScope = "alliance";
  payload.currentTag = null;
  fwaMatchCopyPayloads.set(parsed.key, payload);
  await interaction.update({
    content: undefined,
    embeds: [payload.allianceView.embed],
    components: buildFwaMatchCopyComponents(
      payload,
      payload.userId,
      parsed.key,
      "embed",
    ),
  });
}

export async function handleFwaMatchTieBreakerButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaMatchTieBreakerCustomId(interaction.customId);
  if (!parsed) return;

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [
      new EmbedBuilder()
        .setTitle("Tie-breaker rules")
        .setImage(FWA_MATCH_TIEBREAKER_RULES_URL),
    ],
  });
}

/** Purpose: show a short-lived ephemeral processing notice for slow button actions. */
async function showProcessingNotice(
  interaction: ButtonInteraction,
  content: string,
): Promise<() => Promise<void>> {
  const notice = await interaction
    .followUp({
      ephemeral: true,
      content,
    })
    .catch(() => null);
  return async () => {
    if (!notice) return;
    await interaction.deleteReply(notice.id).catch(() => undefined);
  };
}

export async function handleFwaMatchTypeActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchTypeActionCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "match_type_confirm_click",
    `user=${interaction.user.id} tag=${parsed.tag} type=${parsed.targetType}`,
  );

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
  await interaction.deferUpdate();
  const clearProcessing = await showProcessingNotice(
    interaction,
    "Updating match type...",
  );
  try {
    for (const [key, payload] of fwaMatchCopyPayloads.entries()) {
      if (payload.userId !== parsed.userId) continue;
      if (
        payload.currentScope !== "single" ||
        payload.currentTag !== parsed.tag
      )
        continue;
      const currentView = payload.singleViews[parsed.tag];
      if (!currentView) continue;

      const selection = resolveMatchTypeSelection({
        view: currentView,
        targetType: parsed.targetType,
      });
      const nextDraftByTag = { ...payload.revisionDraftByTag };
      if (selection.draft) {
        nextDraftByTag[parsed.tag] = selection.draft;
      } else {
        delete nextDraftByTag[parsed.tag];
      }
      if (selection.explicitConfirmation) {
        await prisma.currentWar.upsert({
          where: {
            clanTag_guildId: {
              guildId: interaction.guildId,
              clanTag: `#${parsed.tag}`,
            },
          },
          create: {
            guildId: interaction.guildId,
            clanTag: `#${parsed.tag}`,
            channelId: interaction.channelId,
            notify: false,
            matchType: selection.explicitConfirmation.matchType,
            inferredMatchType: false,
            outcome:
              selection.explicitConfirmation.matchType === "FWA" &&
              (selection.explicitConfirmation.expectedOutcome === "WIN" ||
                selection.explicitConfirmation.expectedOutcome === "LOSE")
                ? selection.explicitConfirmation.expectedOutcome
                : null,
          },
          update: {
            matchType: selection.explicitConfirmation.matchType,
            inferredMatchType: false,
            outcome:
              selection.explicitConfirmation.matchType === "FWA" &&
              (selection.explicitConfirmation.expectedOutcome === "WIN" ||
                selection.explicitConfirmation.expectedOutcome === "LOSE")
                ? selection.explicitConfirmation.expectedOutcome
                : null,
            updatedAt: new Date(),
          },
        });
        await markMatchLiveDataChanged({
          guildId: interaction.guildId,
          tag: parsed.tag,
          channelId: interaction.channelId,
        });
      }
      const draftPayload: FwaMatchCopyPayload = {
        ...payload,
        revisionDraftByTag: nextDraftByTag,
      };
      const refreshed = await rebuildTrackedPayloadForTag(
        draftPayload,
        interaction.guildId ?? null,
        parsed.tag,
        interaction.client,
      );
      if (!refreshed) {
        await interaction.followUp({
          ephemeral: true,
          content:
            "Could not refresh this match view. Please run /fwa match again.",
        });
        return;
      }
      const refreshedView = refreshed.singleViews[parsed.tag];
      if (!refreshedView) {
        await interaction.followUp({
          ephemeral: true,
          content:
            "Could not refresh this clan view. Please run /fwa match again.",
        });
        return;
      }
      refreshed.singleViews[parsed.tag] = {
        ...refreshedView,
        matchTypeAction: null,
      };
      fwaMatchCopyPayloads.set(key, refreshed);
      const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
      const nextView = refreshed.singleViews[parsed.tag];
      await interaction.editReply({
        content:
          showMode === "copy"
            ? limitDiscordContent(nextView.copyText)
            : undefined,
        embeds: showMode === "embed" ? [nextView.embed] : [],
        components: buildFwaMatchCopyComponents(
          refreshed,
          refreshed.userId,
          key,
          showMode,
        ),
      });
      return;
    }

    await interaction.followUp({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
  } finally {
    await clearProcessing();
  }
}

export async function handleFwaMatchTypeEditButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchTypeEditCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "match_type_edit_click",
    `user=${interaction.user.id} key=${parsed.key}`,
  );
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
  if (payload.currentScope !== "single" || !payload.currentTag) {
    await interaction.reply({
      ephemeral: true,
      content: "Open a single clan view first.",
    });
    return;
  }
  const tag = payload.currentTag;
  const view = payload.singleViews[tag];
  if (!view || !view.matchTypeCurrent) {
    await interaction.reply({
      ephemeral: true,
      content: "Match type is unavailable for this clan.",
    });
    return;
  }
  payload.singleViews[tag] = {
    ...view,
    matchTypeAction:
      view.matchTypeCurrent === "FWA" ||
      view.matchTypeCurrent === "BL" ||
      view.matchTypeCurrent === "MM"
        ? { tag, currentType: view.matchTypeCurrent }
        : null,
  };
  fwaMatchCopyPayloads.set(parsed.key, payload);
  await interaction.update({
    content: undefined,
    embeds: [payload.singleViews[tag].embed],
    components: buildFwaMatchCopyComponents(
      payload,
      payload.userId,
      parsed.key,
      "embed",
    ),
  });
}

export async function handleFwaOutcomeActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseOutcomeActionCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "outcome_reverse_click",
    `user=${interaction.user.id} tag=${parsed.tag} from=${parsed.currentOutcome}`,
  );

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

  await interaction.deferUpdate();
  const clearProcessing = await showProcessingNotice(
    interaction,
    "Reversing outcome...",
  );
  try {
    for (const [key, payload] of fwaMatchCopyPayloads.entries()) {
      if (payload.userId !== parsed.userId) continue;
      if (
        payload.currentScope !== "single" ||
        payload.currentTag !== parsed.tag
      )
        continue;
      const currentView = payload.singleViews[parsed.tag];
      if (!currentView) continue;

      const nextDraft = buildDraftFromOutcomeToggle({
        view: currentView,
        currentOutcome: parsed.currentOutcome,
      });
      const nextDraftByTag = { ...payload.revisionDraftByTag };
      if (nextDraft) {
        nextDraftByTag[parsed.tag] = nextDraft;
      } else {
        delete nextDraftByTag[parsed.tag];
      }
      const draftPayload: FwaMatchCopyPayload = {
        ...payload,
        revisionDraftByTag: nextDraftByTag,
      };
      const refreshed = await rebuildTrackedPayloadForTag(
        draftPayload,
        interaction.guildId ?? null,
        parsed.tag,
        interaction.client,
      );
      if (!refreshed) {
        await interaction.followUp({
          ephemeral: true,
          content:
            "Could not refresh this match view. Please run /fwa match again.",
        });
        return;
      }
      const nextView = refreshed.singleViews[parsed.tag];
      if (!nextView) {
        await interaction.followUp({
          ephemeral: true,
          content:
            "Could not refresh this clan view. Please run /fwa match again.",
        });
        return;
      }
      fwaMatchCopyPayloads.set(key, refreshed);
      const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
      await interaction.editReply({
        content:
          showMode === "copy"
            ? limitDiscordContent(nextView.copyText)
            : undefined,
        embeds: showMode === "embed" ? [nextView.embed] : [],
        components: buildFwaMatchCopyComponents(
          refreshed,
          refreshed.userId,
          key,
          showMode,
        ),
      });
      return;
    }

    await interaction.followUp({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
  } finally {
    await clearProcessing();
  }
}

export async function handleFwaMatchSyncActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchSyncActionCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "sync_action_click",
    `user=${interaction.user.id} tag=${parsed.tag}`,
  );

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

  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  const view = payload.singleViews[parsed.tag];
  const syncAction = view?.syncAction ?? null;
  if (!view || !syncAction) {
    logFwaMatchTelemetry(
      "sync_action_skipped",
      `user=${interaction.user.id} tag=${parsed.tag} reason=no_out_of_sync_data`,
    );
    await interaction.reply({
      ephemeral: true,
      content: "No out-of-sync data found for this clan.",
    });
    return;
  }

  await interaction.deferUpdate();
  const clearProcessing = await showProcessingNotice(
    interaction,
    "⏳ Syncing data...",
  );
  try {
    const persistedAfterApply = await prisma.$transaction(async (tx) => {
      await tx.currentWar.upsert({
        where: {
          clanTag_guildId: {
            guildId: interaction.guildId!,
            clanTag: `#${parsed.tag}`,
          },
        },
        create: {
          guildId: interaction.guildId!,
          clanTag: `#${parsed.tag}`,
          channelId: interaction.channelId,
          notify: false,
          fwaPoints: syncAction.siteFwaPoints,
          opponentFwaPoints: syncAction.siteOpponentFwaPoints,
          matchType: syncAction.siteMatchType ?? undefined,
          inferredMatchType: syncAction.siteMatchType !== null,
          outcome: syncAction.siteOutcome,
        },
        update: {
          fwaPoints: syncAction.siteFwaPoints,
          opponentFwaPoints: syncAction.siteOpponentFwaPoints,
          matchType: syncAction.siteMatchType ?? undefined,
          inferredMatchType: syncAction.siteMatchType !== null,
          outcome: syncAction.siteOutcome,
          updatedAt: new Date(),
        },
      });
      return tx.currentWar.findUnique({
        where: {
          clanTag_guildId: {
            guildId: interaction.guildId!,
            clanTag: `#${parsed.tag}`,
          },
        },
        select: {
          matchType: true,
          outcome: true,
          fwaPoints: true,
          opponentFwaPoints: true,
        },
      });
    });
    logFwaMatchTelemetry(
      "sync_action_applied",
      `user=${interaction.user.id} tag=${parsed.tag} site_sync=${syncAction.siteSyncNumber ?? "unknown"} site_match_type=${syncAction.siteMatchType ?? "unknown"} site_outcome=${syncAction.siteOutcome ?? "UNKNOWN"} site_points=${syncAction.siteFwaPoints ?? "unknown"} opponent_points=${syncAction.siteOpponentFwaPoints ?? "unknown"}`,
    );
    const postSyncValidation = evaluatePostSyncValidation({
      persistedMatchType: persistedAfterApply?.matchType ?? null,
      persistedOutcome: persistedAfterApply?.outcome ?? null,
      persistedFwaPoints: persistedAfterApply?.fwaPoints ?? null,
      persistedOpponentFwaPoints:
        persistedAfterApply?.opponentFwaPoints ?? null,
      siteMatchType: syncAction.siteMatchType,
      siteOutcome: syncAction.siteOutcome,
      siteFwaPoints: syncAction.siteFwaPoints,
      siteOpponentFwaPoints: syncAction.siteOpponentFwaPoints,
    });
    logFwaMatchTelemetry(
      "post_sync_validation",
      `user=${interaction.user.id} tag=${parsed.tag} fully_aligned=${postSyncValidation.fullyAligned ? 1 : 0} match_type_aligned=${postSyncValidation.matchTypeAligned ? 1 : 0} outcome_aligned=${postSyncValidation.outcomeAligned ? 1 : 0} points_aligned=${postSyncValidation.pointsAligned ? 1 : 0} persisted_match_type=${persistedAfterApply?.matchType ?? "unknown"} persisted_outcome=${persistedAfterApply?.outcome ?? "UNKNOWN"}`,
    );
    await markMatchLiveDataChanged({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: interaction.channelId,
    });

    const refreshed = await rebuildTrackedPayloadForTag(
      payload,
      interaction.guildId,
      parsed.tag,
      interaction.client,
    );
    if (!refreshed) {
      logFwaMatchTelemetry(
        "post_sync_render_state",
        `user=${interaction.user.id} tag=${parsed.tag} status=refresh_failed`,
      );
      await interaction.followUp({
        ephemeral: true,
        content: "Data synced, but this view could not be refreshed.",
      });
      return;
    }
    fwaMatchCopyPayloads.set(parsed.key, refreshed);
    const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
    const nextView = refreshed.singleViews[parsed.tag];
    if (!nextView) {
      logFwaMatchTelemetry(
        "post_sync_render_state",
        `user=${interaction.user.id} tag=${parsed.tag} status=view_missing`,
      );
      await interaction.followUp({
        ephemeral: true,
        content: "Data synced, but clan view is unavailable now.",
      });
      return;
    }
    const renderedDescription = String(nextView.embed.data.description ?? "");
    logFwaMatchTelemetry(
      "post_sync_render_state",
      `user=${interaction.user.id} tag=${parsed.tag} status=render_ready sync_action_visible=${nextView.syncAction ? 1 : 0} outcome_mismatch=${hasRenderedOutcomeMismatch(renderedDescription) ? 1 : 0}`,
    );
    await interaction.editReply({
      content:
        showMode === "copy"
          ? limitDiscordContent(nextView.copyText)
          : undefined,
      embeds: showMode === "embed" ? [nextView.embed] : [],
      components: buildFwaMatchCopyComponents(
        refreshed,
        refreshed.userId,
        parsed.key,
        showMode,
      ),
    });
  } finally {
    await clearProcessing();
  }
}

export async function handleFwaMatchSkipSyncActionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchSkipSyncActionCustomId(interaction.customId);
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
  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  const view = payload.singleViews[parsed.tag];
  if (!view?.skipSyncAction) {
    await interaction.reply({
      ephemeral: true,
      content: "Skip sync is unavailable for this clan view.",
    });
    return;
  }
  await interaction.reply({
    ephemeral: true,
    content:
      "Confirm SKIP? This action writes a SKIP row to ClanWarHistory and can affect clan logs.",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildMatchSkipSyncConfirmCustomId(parsed))
          .setLabel("Confirm SKIP")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

export async function handleFwaMatchSkipSyncConfirmButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchSkipSyncConfirmCustomId(interaction.customId);
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
  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  const view = payload.singleViews[parsed.tag];
  if (!view?.skipSyncAction) {
    await interaction.reply({
      ephemeral: true,
      content: "Skip sync is unavailable for this clan view.",
    });
    return;
  }

  await interaction.deferUpdate();
  const clearProcessing = await showProcessingNotice(
    interaction,
    "⏳ Applying SKIP sync...",
  );
  try {
    const tracked = await prisma.trackedClan.findFirst({
      where: { tag: { equals: `#${parsed.tag}`, mode: "insensitive" } },
      select: { name: true },
    });
    let resolvedSyncNum: number | null = null;
    const latestSync = await pointsSyncService.findLatestSyncNum({
      clanTag: parsed.tag,
    });
    if (latestSync !== null) {
      resolvedSyncNum = latestSync;
    } else {
      const lastHistory = await prisma.clanWarHistory.findFirst({
        where: {
          clanTag: parsed.tag,
          syncNumber: { not: null },
          matchType: { in: ["MM", "BL", "SKIP"] },
        },
        orderBy: { warStartTime: "desc" },
        select: { syncNumber: true },
      });
      const previousSync = Number(lastHistory?.syncNumber ?? NaN);
      if (Number.isFinite(previousSync)) {
        resolvedSyncNum = Math.max(0, Math.trunc(previousSync) + 1);
      }
    }

    const existingCurrent = await prisma.currentWar.findUnique({
      where: {
        clanTag_guildId: {
          guildId: interaction.guildId,
          clanTag: `#${parsed.tag}`,
        },
      },
      select: {
        warId: true,
        startTime: true,
      },
    });
    const existingMailConfig = await getCurrentWarMailConfig(
      interaction.guildId,
      parsed.tag,
    );
    const existingSkipHistory = existingMailConfig.skipSyncHistory;
    const skipWarStart =
      existingSkipHistory?.warStartUnix !== undefined &&
      existingSkipHistory?.warStartUnix !== null
        ? new Date(existingSkipHistory.warStartUnix * 1000)
        : (existingCurrent?.startTime ??
          new Date(Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000));
    const skipOpponentTag = normalizeTag(
      existingSkipHistory?.opponentTag ?? "SKIP",
    );
    const skipOpponentTagWithHash = `#${skipOpponentTag}`;
    const clanTagWithHash = `#${parsed.tag}`;
    const clanName = tracked?.name ?? view.clanName ?? clanTagWithHash;

    let skipWarId: number | null =
      existingSkipHistory?.warId !== null &&
      existingSkipHistory?.warId !== undefined &&
      Number.isFinite(existingSkipHistory?.warId)
        ? Math.trunc(existingSkipHistory.warId)
        : null;
    if (skipWarId !== null) {
      const rows = await prisma.$queryRaw<Array<{ warId: number }>>(
        Prisma.sql`
        INSERT INTO "ClanWarHistory"
          ("warId","syncNumber","matchType","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag","updatedAt")
        VALUES
          (${skipWarId}, ${resolvedSyncNum}, CAST(${"SKIP"} AS "WarMatchType"), ${skipWarStart}, NULL, ${clanName}, ${clanTagWithHash}, ${"SKIP"}, ${skipOpponentTagWithHash}, NOW())
        ON CONFLICT ("warId")
        DO UPDATE SET
          "syncNumber" = EXCLUDED."syncNumber",
          "matchType" = EXCLUDED."matchType",
          "warStartTime" = EXCLUDED."warStartTime",
          "warEndTime" = EXCLUDED."warEndTime",
          "clanName" = EXCLUDED."clanName",
          "clanTag" = EXCLUDED."clanTag",
          "opponentName" = EXCLUDED."opponentName",
          "opponentTag" = EXCLUDED."opponentTag",
          "updatedAt" = NOW()
        RETURNING "warId"
      `,
      );
      const returned = Number(rows[0]?.warId ?? NaN);
      if (Number.isFinite(returned)) skipWarId = Math.trunc(returned);
    } else {
      const rows = await prisma.$queryRaw<Array<{ warId: number }>>(
        Prisma.sql`
        INSERT INTO "ClanWarHistory"
          ("syncNumber","matchType","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag","updatedAt")
        VALUES
          (${resolvedSyncNum}, CAST(${"SKIP"} AS "WarMatchType"), ${skipWarStart}, NULL, ${clanName}, ${clanTagWithHash}, ${"SKIP"}, ${skipOpponentTagWithHash}, NOW())
        ON CONFLICT ("warStartTime","clanTag","opponentTag")
        DO UPDATE SET
          "syncNumber" = EXCLUDED."syncNumber",
          "matchType" = EXCLUDED."matchType",
          "warEndTime" = EXCLUDED."warEndTime",
          "clanName" = EXCLUDED."clanName",
          "opponentName" = EXCLUDED."opponentName",
          "updatedAt" = NOW()
        RETURNING "warId"
      `,
      );
      const returned = Number(rows[0]?.warId ?? NaN);
      skipWarId = Number.isFinite(returned) ? Math.trunc(returned) : null;
    }

    await prisma.currentWar.upsert({
      where: {
        clanTag_guildId: {
          guildId: interaction.guildId,
          clanTag: `#${parsed.tag}`,
        },
      },
      create: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
        channelId: interaction.channelId,
        notify: false,
        matchType: "SKIP",
        inferredMatchType: false,
        warId: skipWarId,
        state: "notInWar",
        clanName: tracked?.name ?? view.clanName ?? `#${parsed.tag}`,
      },
      update: {
        channelId: interaction.channelId,
        matchType: "SKIP",
        inferredMatchType: false,
        warId: skipWarId,
        state: "notInWar",
        updatedAt: new Date(),
      },
    });
    const nextMailConfig: MatchMailConfig = {
      ...existingMailConfig,
      skipSyncHistory:
        skipWarId !== null
          ? {
              warId: skipWarId,
              warStartUnix: Math.floor(skipWarStart.getTime() / 1000),
              opponentTag: skipOpponentTag,
            }
          : existingMailConfig.skipSyncHistory,
    };
    await saveCurrentWarMailConfig({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: interaction.channelId,
      mailConfig: nextMailConfig,
    });

    await markMatchLiveDataChanged({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: interaction.channelId,
    });
    const refreshed = await rebuildTrackedPayloadForTag(
      payload,
      interaction.guildId,
      parsed.tag,
      interaction.client,
    );
    if (!refreshed) {
      await interaction.followUp({
        ephemeral: true,
        content: "Skip sync applied, but this view could not be refreshed.",
      });
      return;
    }
    fwaMatchCopyPayloads.set(parsed.key, refreshed);
    const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
    const nextView = refreshed.singleViews[parsed.tag];
    if (!nextView) {
      await interaction.followUp({
        ephemeral: true,
        content: "Skip sync applied, but clan view is unavailable now.",
      });
      return;
    }
    await interaction.message.edit({
      content:
        showMode === "copy"
          ? limitDiscordContent(nextView.copyText)
          : undefined,
      embeds: showMode === "embed" ? [nextView.embed] : [],
      components: buildFwaMatchCopyComponents(
        refreshed,
        refreshed.userId,
        parsed.key,
        showMode,
      ),
    });
    await interaction.followUp({
      ephemeral: true,
      content: "SKIP confirmed. Clan logs updated.",
    });
  } finally {
    await clearProcessing();
  }
}

export async function handleFwaMatchSkipSyncUndoButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMatchSkipSyncUndoCustomId(interaction.customId);
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
  const payload = fwaMatchCopyPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This match view expired. Please run /fwa match again.",
    });
    return;
  }
  const view = payload.singleViews[parsed.tag];
  if (!view?.undoSkipSyncAction) {
    await interaction.reply({
      ephemeral: true,
      content: "Undo is unavailable for this clan view.",
    });
    return;
  }
  await interaction.deferUpdate();
  const clearProcessing = await showProcessingNotice(
    interaction,
    "⏳ Undoing SKIP sync...",
  );
  try {
    const current = await prisma.currentWar.findUnique({
      where: {
        clanTag_guildId: {
          guildId: interaction.guildId,
          clanTag: `#${parsed.tag}`,
        },
      },
      select: { warId: true, channelId: true },
    });
    const existingMailConfig = await getCurrentWarMailConfig(
      interaction.guildId,
      parsed.tag,
    );
    const skipWarId =
      existingMailConfig.skipSyncHistory?.warId ?? current?.warId ?? null;
    if (skipWarId !== null && Number.isFinite(skipWarId)) {
      await prisma.clanWarHistory.deleteMany({
        where: { warId: Math.trunc(skipWarId) },
      });
    }
    await prisma.currentWar.updateMany({
      where: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
      },
      data: {
        warId: null,
        matchType: null,
        inferredMatchType: true,
        updatedAt: new Date(),
      },
    });
    await saveCurrentWarMailConfig({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: current?.channelId ?? interaction.channelId,
      mailConfig: existingMailConfig,
    });
    await markMatchLiveDataChanged({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: interaction.channelId,
    });
    const refreshed = await rebuildTrackedPayloadForTag(
      payload,
      interaction.guildId,
      parsed.tag,
      interaction.client,
    );
    if (!refreshed) {
      await interaction.followUp({
        ephemeral: true,
        content: "Undo applied, but this view could not be refreshed.",
      });
      return;
    }
    fwaMatchCopyPayloads.set(parsed.key, refreshed);
    const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
    const nextView = refreshed.singleViews[parsed.tag];
    if (!nextView) {
      await interaction.followUp({
        ephemeral: true,
        content: "Undo applied, but clan view is unavailable now.",
      });
      return;
    }
    await interaction.message.edit({
      content:
        showMode === "copy"
          ? limitDiscordContent(nextView.copyText)
          : undefined,
      embeds: showMode === "embed" ? [nextView.embed] : [],
      components: buildFwaMatchCopyComponents(
        refreshed,
        refreshed.userId,
        parsed.key,
        showMode,
      ),
    });
  } finally {
    await clearProcessing();
  }
}

async function showWarMailPreview(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guildId: string,
  userId: string,
  tag: string,
  cocService: CoCService,
  sourceMatchPayloadKey?: string,
  revisionOverride?: MatchRevisionFields | null,
): Promise<void> {
  const rendered = await buildWarMailEmbedForTag(cocService, guildId, tag, {
    fetchReason: "pre_fwa_validation",
    revisionOverride: revisionOverride ?? null,
  });
  const previewKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const sourceShowMode =
    interaction.isButton() && interaction.message.embeds.length > 0
      ? "embed"
      : "copy";
  fwaMailPreviewPayloads.set(previewKey, {
    userId,
    guildId,
    tag,
    sourceMatchPayloadKey,
    sourceChannelId:
      interaction.isButton() && interaction.channelId
        ? interaction.channelId
        : undefined,
    sourceMessageId: interaction.isButton()
      ? interaction.message.id
      : undefined,
    sourceShowMode: interaction.isButton() ? sourceShowMode : undefined,
    revisionOverride: revisionOverride ?? null,
  });

  const mailSendGate = await resolveMailSendGateForRenderedState({
    client: interaction.client,
    guildId,
    tag,
    hasMailChannel: Boolean(rendered.mailChannelId),
    inferredMatchType: rendered.inferredMatchType,
    warId: rendered.warId,
    warStartMs: rendered.warStartMs,
    opponentTag: rendered.opponentTag,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  const channel = rendered.mailChannelId
    ? await interaction.client.channels
        .fetch(rendered.mailChannelId)
        .catch(() => null)
    : null;
  const channelAvailable = Boolean(channel && channel.isTextBased());
  const warnings = [
    ...new Set([
      ...rendered.unavailableReasons.map((reason) => `:warning: ${reason}`),
      rendered.mailChannelId && !channelAvailable
        ? ":warning: Configured mail channel is unavailable."
        : "",
      formatMailBlockedReason(mailSendGate.mailBlockedReason) ?? "",
    ]),
  ].filter((line) => line.length > 0);
  const enabled =
    rendered.unavailableReasons.length === 0 &&
    channelAvailable &&
    mailSendGate.mailBlockedReason === null;
  const previewSummary = enabled
    ? "Review mail preview and confirm send."
    : ["Cannot send yet.", ...warnings].join("\n");
  const previewMentionRoleId = normalizeDiscordRoleId(rendered.clanRoleId);
  const previewMailText = buildWarMailPostedContent(
    previewMentionRoleId,
    undefined,
    {
      pingRole: true,
      planText: rendered.planText,
      includeNextRefresh: !rendered.freezeRefresh,
    },
  );
  const content = limitDiscordContent(
    [previewSummary, "", "**Mail Text Preview**", previewMailText]
      .filter((part) => part.trim().length > 0)
      .join("\n"),
  );

  if (interaction.isButton()) {
    await interaction.update({
      content,
      allowedMentions: { parse: [] },
      embeds: [rendered.embed],
      components: buildWarMailPreviewComponents({
        userId,
        key: previewKey,
        enabled,
        showBack: Boolean(sourceMatchPayloadKey),
      }),
    });
    return;
  }

  await interaction.editReply({
    content,
    allowedMentions: { parse: [] },
    embeds: [rendered.embed],
    components: buildWarMailPreviewComponents({
      userId,
      key: previewKey,
      enabled,
      showBack: Boolean(sourceMatchPayloadKey),
    }),
  });
}

export async function handleFwaMatchSendMailButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaMatchSendMailCustomId(interaction.customId);
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
  const allowed = await canUseFwaMailSendFromButton(interaction);
  if (!allowed) {
    await interaction.reply({
      ephemeral: true,
      content:
        "You do not have permission to send war mail. Default access is `/fwa leader-role` + Administrator.",
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
  const refreshedPayload = await rebuildTrackedPayloadForTag(
    payload,
    interaction.guildId ?? null,
    parsed.tag,
    interaction.client,
  );
  const activePayload = refreshedPayload ?? payload;
  if (refreshedPayload) {
    fwaMatchCopyPayloads.set(parsed.key, refreshedPayload);
  }
  const view = activePayload.singleViews[parsed.tag];
  if (!view) {
    await interaction.reply({
      ephemeral: true,
      content:
        "This clan view is no longer available. Please run /fwa match again.",
    });
    return;
  }
  const revisionOverride = normalizeRevisionFields(
    view.appliedDraftRevision ?? null,
  );
  const cocService = new CoCService();
  await showWarMailPreview(
    interaction,
    interaction.guildId,
    interaction.user.id,
    parsed.tag,
    cocService,
    parsed.key,
    revisionOverride,
  );
}

async function refreshSourceMatchMessageAfterMailSend(
  interaction: ButtonInteraction,
  previewPayload: FwaMailPreviewPayload,
): Promise<{
  refreshed: FwaMatchCopyPayload | null;
  showMode: "embed" | "copy";
  sourceUpdated: boolean;
}> {
  const sourceKey = previewPayload.sourceMatchPayloadKey;
  const showMode = previewPayload.sourceShowMode ?? "embed";
  if (!sourceKey || !previewPayload.guildId) {
    return { refreshed: null, showMode, sourceUpdated: false };
  }

  const existing = fwaMatchCopyPayloads.get(sourceKey);
  if (!existing) return { refreshed: null, showMode, sourceUpdated: false };
  const refreshed = await rebuildTrackedPayloadForTag(
    existing,
    previewPayload.guildId,
    normalizeTag(previewPayload.tag),
    interaction.client,
  ).catch(() => null);
  if (!refreshed) return { refreshed: null, showMode, sourceUpdated: false };
  fwaMatchCopyPayloads.set(sourceKey, refreshed);

  if (!previewPayload.sourceChannelId || !previewPayload.sourceMessageId) {
    return { refreshed, showMode, sourceUpdated: false };
  }
  const channel = await interaction.client.channels
    .fetch(previewPayload.sourceChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { refreshed, showMode, sourceUpdated: false };
  }
  const message = await (channel as any).messages
    .fetch(previewPayload.sourceMessageId)
    .catch(() => null);
  if (!message) return { refreshed, showMode, sourceUpdated: false };

  const currentView =
    refreshed.currentScope === "single" && refreshed.currentTag
      ? (refreshed.singleViews[refreshed.currentTag] ?? refreshed.allianceView)
      : refreshed.allianceView;
  await message.edit({
    content:
      showMode === "copy"
        ? limitDiscordContent(currentView.copyText)
        : undefined,
    embeds: showMode === "embed" ? [currentView.embed] : [],
    components: buildFwaMatchCopyComponents(
      refreshed,
      refreshed.userId,
      sourceKey,
      showMode,
    ),
  });
  return { refreshed, showMode, sourceUpdated: true };
}

async function restoreSourceMatchMessageFromMailPreview(
  interaction: ButtonInteraction,
  previewPayload: FwaMailPreviewPayload,
): Promise<boolean> {
  const sourceKey = previewPayload.sourceMatchPayloadKey;
  const showMode = previewPayload.sourceShowMode ?? "embed";
  if (!sourceKey || !previewPayload.guildId) return false;

  const existing = fwaMatchCopyPayloads.get(sourceKey);
  if (!existing) return false;
  const refreshed = await rebuildTrackedPayloadForTag(
    existing,
    previewPayload.guildId,
    normalizeTag(previewPayload.tag),
    interaction.client,
  ).catch(() => null);
  if (!refreshed) return false;
  refreshed.currentScope = "single";
  refreshed.currentTag = normalizeTag(previewPayload.tag);
  fwaMatchCopyPayloads.set(sourceKey, refreshed);

  const currentView =
    refreshed.singleViews[normalizeTag(previewPayload.tag)] ??
    refreshed.allianceView;
  await interaction.editReply({
    content:
      showMode === "copy"
        ? limitDiscordContent(currentView.copyText)
        : undefined,
    embeds: showMode === "embed" ? [currentView.embed] : [],
    components: buildFwaMatchCopyComponents(
      refreshed,
      refreshed.userId,
      sourceKey,
      showMode,
    ),
  });
  return true;
}

type CurrentWarConfirmedState = {
  warId: number;
  startTime: Date | null;
  opponentTag: string | null;
  matchType: "FWA" | "BL" | "MM" | null;
  inferredMatchType: boolean;
  outcome: "WIN" | "LOSE" | null;
};

/** Purpose: derive canonical current-war fields from final mail confirmation so rerenders keep explicit match confirmation. */
function buildCurrentWarConfirmedState(input: {
  warId: number | null | undefined;
  warStartMs: number | null | undefined;
  opponentTag: string | null | undefined;
  matchType: WarMailMatchType;
  expectedOutcome: WarMailExpectedOutcome;
}): CurrentWarConfirmedState | null {
  const warId =
    input.warId !== null &&
    input.warId !== undefined &&
    Number.isFinite(input.warId)
      ? Math.trunc(input.warId)
      : null;
  if (warId === null || warId <= 0) return null;

  const matchType =
    input.matchType === "FWA" ||
    input.matchType === "BL" ||
    input.matchType === "MM"
      ? input.matchType
      : null;
  const inferredMatchType = matchType ? false : true;
  const outcome =
    matchType === "FWA" &&
    (input.expectedOutcome === "WIN" || input.expectedOutcome === "LOSE")
      ? input.expectedOutcome
      : null;
  const opponentTag = normalizeTag(String(input.opponentTag ?? ""));
  return {
    warId,
    startTime:
      input.warStartMs !== null &&
      input.warStartMs !== undefined &&
      Number.isFinite(input.warStartMs)
        ? new Date(Math.trunc(input.warStartMs))
        : null,
    opponentTag: opponentTag ? `#${opponentTag}` : null,
    matchType,
    inferredMatchType,
    outcome,
  };
}

export const buildCurrentWarConfirmedStateForTest =
  buildCurrentWarConfirmedState;

async function handleFwaMailConfirmAction(
  interaction: ButtonInteraction,
  options: { pingRole: boolean },
): Promise<void> {
  const parsed = options.pingRole
    ? parseFwaMailConfirmCustomId(interaction.customId)
    : parseFwaMailConfirmNoPingCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }
  const allowed = await canUseFwaMailSendFromButton(interaction);
  if (!allowed) {
    await interaction.reply({
      ephemeral: true,
      content:
        "You do not have permission to send war mail. Default access is `/fwa leader-role` + Administrator.",
    });
    return;
  }
  const payload = fwaMailPreviewPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This mail preview expired. Run /fwa mail send again.",
    });
    return;
  }
  await interaction.deferUpdate();
  await interaction
    .editReply({
      content: "Sending war mail... please wait.",
      embeds: [],
      components: [],
    })
    .catch(() => undefined);
  const cocService = new CoCService();
  const rendered = await buildWarMailEmbedForTag(
    cocService,
    payload.guildId,
    payload.tag,
    {
      fetchReason: "pre_fwa_validation",
      revisionOverride: payload.revisionOverride ?? null,
    },
  );
  if (!rendered.mailChannelId || rendered.unavailableReasons.length > 0) {
    await interaction.editReply({
      content: `Cannot send mail: ${rendered.unavailableReasons.join(" ") || "mail channel unavailable."}`,
      embeds: [],
      components: buildWarMailPreviewComponents({
        userId: parsed.userId,
        key: parsed.key,
        enabled: true,
      }),
    });
    return;
  }
  const channel = await interaction.client.channels
    .fetch(rendered.mailChannelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.editReply({
      content: "Configured mail channel is unavailable.",
      embeds: [],
      components: buildWarMailPreviewComponents({
        userId: parsed.userId,
        key: parsed.key,
        enabled: true,
      }),
    });
    return;
  }
  if (
    rendered.warId === null ||
    rendered.warId === undefined ||
    !Number.isFinite(rendered.warId)
  ) {
    await interaction.editReply({
      content: "Cannot send mail: active war id is unresolved for this clan.",
      embeds: [],
      components: buildWarMailPreviewComponents({
        userId: parsed.userId,
        key: parsed.key,
        enabled: true,
      }),
    });
    return;
  }
  const mailSendGate = await resolveMailSendGateForRenderedState({
    client: interaction.client,
    guildId: payload.guildId,
    tag: payload.tag,
    hasMailChannel: true,
    inferredMatchType: rendered.inferredMatchType,
    warId: rendered.warId,
    warStartMs: rendered.warStartMs,
    opponentTag: rendered.opponentTag,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  if (mailSendGate.mailBlockedReason) {
    await interaction.editReply({
      content: `Cannot send mail: ${
        formatMailBlockedReason(mailSendGate.mailBlockedReason) ??
        mailSendGate.mailBlockedReason
      }`,
      embeds: [],
      components: buildWarMailPreviewComponents({
        userId: parsed.userId,
        key: parsed.key,
        enabled: false,
        showBack: Boolean(payload.sourceMatchPayloadKey),
      }),
    });
    return;
  }
  const renderedWarIdNumber =
    rendered.warId !== null &&
    rendered.warId !== undefined &&
    Number.isFinite(rendered.warId)
      ? Math.trunc(rendered.warId)
      : null;
  const postKey = buildWarMailPollKey(
    payload.guildId,
    payload.tag,
    renderedWarIdNumber,
  );
  const mentionRoleId = normalizeDiscordRoleId(rendered.clanRoleId);
  const sent = await (channel as any).send({
    content: buildWarMailPostedContent(mentionRoleId, undefined, {
      pingRole: options.pingRole,
      planText: rendered.planText,
      includeNextRefresh: !rendered.freezeRefresh,
    }),
    allowedMentions:
      options.pingRole && mentionRoleId
        ? { roles: [mentionRoleId] }
        : undefined,
    embeds: [rendered.embed],
    components: rendered.freezeRefresh
      ? []
      : buildWarMailPostedComponents(postKey),
  });
  const confirmedCurrentWarState = buildCurrentWarConfirmedState({
    warId: renderedWarIdNumber,
    warStartMs: rendered.warStartMs ?? null,
    opponentTag: rendered.opponentTag ?? null,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  await prisma.currentWar.upsert({
    where: {
      clanTag_guildId: {
        guildId: payload.guildId,
        clanTag: `#${normalizeTag(payload.tag)}`,
      },
    },
    create: {
      guildId: payload.guildId,
      clanTag: `#${normalizeTag(payload.tag)}`,
      channelId: channel.id,
      notify: false,
      warId: confirmedCurrentWarState?.warId ?? renderedWarIdNumber ?? null,
      ...(confirmedCurrentWarState?.startTime
        ? { startTime: confirmedCurrentWarState.startTime }
        : {}),
      ...(confirmedCurrentWarState?.opponentTag
        ? { opponentTag: confirmedCurrentWarState.opponentTag }
        : {}),
      ...(confirmedCurrentWarState?.matchType
        ? { matchType: confirmedCurrentWarState.matchType }
        : {}),
      inferredMatchType: confirmedCurrentWarState?.inferredMatchType ?? true,
      outcome: confirmedCurrentWarState?.outcome ?? null,
    },
    update: {
      channelId: channel.id,
      warId: confirmedCurrentWarState?.warId ?? renderedWarIdNumber ?? null,
      ...(confirmedCurrentWarState?.startTime
        ? { startTime: confirmedCurrentWarState.startTime }
        : {}),
      ...(confirmedCurrentWarState?.opponentTag
        ? { opponentTag: confirmedCurrentWarState.opponentTag }
        : {}),
      ...(confirmedCurrentWarState?.matchType
        ? { matchType: confirmedCurrentWarState.matchType }
        : {}),
      inferredMatchType: confirmedCurrentWarState?.inferredMatchType ?? true,
      outcome: confirmedCurrentWarState?.outcome ?? null,
      updatedAt: new Date(),
    },
  });
  const nowMs = Date.now();
  const renderedWarIdText =
    renderedWarIdNumber !== null ? String(renderedWarIdNumber) : null;
  const checkpointWarStartTime =
    rendered.warStartMs !== null &&
    rendered.warStartMs !== undefined &&
    Number.isFinite(rendered.warStartMs)
      ? new Date(Math.trunc(rendered.warStartMs))
      : null;
  const checkpointSyncRow = await pointsSyncService
    .getCurrentSyncForClan({
      guildId: payload.guildId,
      clanTag: payload.tag,
      warId: renderedWarIdText,
      warStartTime: checkpointWarStartTime,
    })
    .catch(() => null);
  const previousRevision = resolvePostedRevisionFromSyncRow(
    checkpointSyncRow
      ? {
          lastKnownMatchType: checkpointSyncRow.lastKnownMatchType ?? null,
          lastKnownOutcome: checkpointSyncRow.lastKnownOutcome ?? null,
          isFwa: checkpointSyncRow.isFwa ?? null,
        }
      : null,
  );
  const previousLifecycle =
    renderedWarIdNumber !== null
      ? await warMailLifecycleService
          .getLifecycleForWar({
            guildId: payload.guildId,
            clanTag: payload.tag,
            warId: renderedWarIdNumber,
          })
          .catch(() => null)
      : null;
  const previous =
    previousLifecycle?.status === "POSTED" &&
    previousLifecycle.channelId &&
    previousLifecycle.messageId
      ? {
          channelId: previousLifecycle.channelId,
          messageId: previousLifecycle.messageId,
          matchType: previousRevision?.matchType ?? "UNKNOWN",
          expectedOutcome: previousRevision?.expectedOutcome ?? null,
        }
      : null;
  let revisedPrevious = false;
  if (previous) {
    revisedPrevious = await annotatePreviousWarMailRevision({
      client: interaction.client,
      previous,
      nextMatchType: rendered.matchType,
      nextExpectedOutcome: rendered.expectedOutcome,
      changedAtMs: nowMs,
    }).catch(() => false);
  }
  if (!rendered.freezeRefresh) {
    startWarMailPolling(interaction.client, postKey);
  }
  await warMailLifecycleService.markPosted({
    guildId: payload.guildId,
    clanTag: payload.tag,
    warId: Number(renderedWarIdNumber),
    channelId: channel.id,
    messageId: sent.id,
    postedAt: new Date(nowMs),
  });
  await pointsSyncService
    .markConfirmedByClanMail({
      guildId: payload.guildId,
      clanTag: payload.tag,
      warId: renderedWarIdText,
      warStartTime: checkpointWarStartTime,
      matchType: rendered.matchType,
      outcome: rendered.expectedOutcome,
      syncNum: checkpointSyncRow?.syncNum ?? null,
      points: checkpointSyncRow?.clanPoints ?? null,
    })
    .catch(() => undefined);
  const existingMailConfig = await getCurrentWarMailConfig(
    payload.guildId,
    payload.tag,
  );
  const nextMailConfig: MatchMailConfig = {
    ...existingMailConfig,
    lastPostedMessageId: sent.id,
    lastPostedChannelId: channel.id,
    lastPostedAtUnix: Math.floor(nowMs / 1000),
    lastWarStartMs:
      rendered.warStartMs !== null &&
      rendered.warStartMs !== undefined &&
      Number.isFinite(rendered.warStartMs)
        ? Math.trunc(rendered.warStartMs)
        : null,
    lastWarId: renderedWarIdText,
    lastOpponentTag: normalizeTag(String(rendered.opponentTag ?? "")) || null,
    lastMatchType: rendered.matchType,
    lastExpectedOutcome:
      rendered.matchType === "FWA"
        ? rendered.expectedOutcome === "WIN" ||
          rendered.expectedOutcome === "LOSE" ||
          rendered.expectedOutcome === "UNKNOWN"
          ? rendered.expectedOutcome
          : "UNKNOWN"
        : null,
  };
  await saveCurrentWarMailConfig({
    guildId: payload.guildId,
    tag: payload.tag,
    channelId: channel.id,
    mailConfig: nextMailConfig,
  });
  await new WarEventLogService(interaction.client, cocService)
    .refreshCurrentNotifyPost(payload.guildId, payload.tag)
    .catch((err) => {
      console.error(
        `[fwa-mail] notify refresh after mail send failed guild=${payload.guildId} clan=#${normalizeTag(payload.tag)} error=${formatError(err)}`,
      );
    });
  if (payload.sourceMatchPayloadKey) {
    const sourcePayload = fwaMatchCopyPayloads.get(
      payload.sourceMatchPayloadKey,
    );
    if (sourcePayload) {
      const nextDraftByTag = { ...sourcePayload.revisionDraftByTag };
      delete nextDraftByTag[normalizeTag(payload.tag)];
      fwaMatchCopyPayloads.set(payload.sourceMatchPayloadKey, {
        ...sourcePayload,
        revisionDraftByTag: nextDraftByTag,
      });
    }
  }
  fwaMailPreviewPayloads.delete(parsed.key);
  const refreshedSource = await refreshSourceMatchMessageAfterMailSend(
    interaction,
    payload,
  ).catch(() => ({
    refreshed: null,
    showMode: "embed" as const,
    sourceUpdated: false,
  }));
  if (payload.sourceMatchPayloadKey) {
    const sourcePayload =
      refreshedSource.refreshed ??
      fwaMatchCopyPayloads.get(payload.sourceMatchPayloadKey) ??
      null;
    if (sourcePayload) {
      const showMode = refreshedSource.showMode ?? "embed";
      const currentView =
        sourcePayload.currentScope === "single" && sourcePayload.currentTag
          ? (sourcePayload.singleViews[sourcePayload.currentTag] ??
            sourcePayload.allianceView)
          : sourcePayload.allianceView;
      const deliveryText = options.pingRole
        ? "War mail sent"
        : "War mail sent without ping";
      await interaction.editReply({
        content:
          showMode === "copy"
            ? limitDiscordContent(currentView.copyText)
            : revisedPrevious
              ? `${deliveryText} to <#${channel.id}>. Previous mail was updated with a revision log.`
              : `${deliveryText} to <#${channel.id}>.`,
        embeds: showMode === "embed" ? [currentView.embed] : [],
        components: buildFwaMatchCopyComponents(
          sourcePayload,
          sourcePayload.userId,
          payload.sourceMatchPayloadKey,
          showMode,
        ),
      });
      return;
    }
  }

  await interaction.deleteReply().catch(() => undefined);
  const deliveryText = options.pingRole
    ? "War mail sent"
    : "War mail sent without ping";
  await interaction.followUp({
    ephemeral: true,
    content: revisedPrevious
      ? `${deliveryText} to <#${channel.id}>. Previous mail was updated with a revision log.`
      : `${deliveryText} to <#${channel.id}>.`,
  });
  if (
    !refreshedSource.sourceUpdated &&
    refreshedSource.refreshed &&
    payload.sourceMatchPayloadKey
  ) {
    const currentView =
      refreshedSource.refreshed.currentScope === "single" &&
      refreshedSource.refreshed.currentTag
        ? (refreshedSource.refreshed.singleViews[
            refreshedSource.refreshed.currentTag
          ] ?? refreshedSource.refreshed.allianceView)
        : refreshedSource.refreshed.allianceView;
    await interaction.followUp({
      ephemeral: true,
      content:
        refreshedSource.showMode === "copy"
          ? limitDiscordContent(currentView.copyText)
          : "Updated match view:",
      embeds: refreshedSource.showMode === "embed" ? [currentView.embed] : [],
      components: buildFwaMatchCopyComponents(
        refreshedSource.refreshed,
        refreshedSource.refreshed.userId,
        payload.sourceMatchPayloadKey,
        refreshedSource.showMode,
      ),
    });
  }
}

export async function handleFwaMailConfirmButton(
  interaction: ButtonInteraction,
): Promise<void> {
  await handleFwaMailConfirmAction(interaction, { pingRole: true });
}

export async function handleFwaMailConfirmNoPingButton(
  interaction: ButtonInteraction,
): Promise<void> {
  await handleFwaMailConfirmAction(interaction, { pingRole: false });
}

export async function handleFwaMailBackButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaMailBackCustomId(interaction.customId);
  if (!parsed) return;
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
    return;
  }
  const payload = fwaMailPreviewPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This mail preview expired. Please run /fwa match again.",
    });
    return;
  }
  await interaction.deferUpdate();
  const restored = await restoreSourceMatchMessageFromMailPreview(
    interaction,
    payload,
  ).catch(() => false);
  if (!restored) {
    await interaction
      .followUp({
        ephemeral: true,
        content:
          "Could not restore the match view. Please run /fwa match again.",
      })
      .catch(() => undefined);
    return;
  }
  fwaMailPreviewPayloads.delete(parsed.key);
}

export async function handleFwaMailRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseFwaMailRefreshCustomId(interaction.customId);
  if (!parsed) return;
  const refreshedByKey = await refreshWarMailPost(
    interaction.client,
    parsed.key,
  ).catch(() => "missing" as const);
  if (refreshedByKey !== "missing") {
    await interaction.reply({
      ephemeral: true,
      content:
        refreshedByKey === "frozen"
          ? "War mail frozen for the ended war."
          : "War mail refreshed.",
    });
    return;
  }
  const guildId = interaction.guildId ?? "";
  const fallbackTag = extractWarMailTagFromMessage(interaction.message);
  const fallbackWarId = extractWarMailIdFromMessage(interaction.message);
  const fallbackTarget =
    guildId && fallbackTag
      ? {
          tag: fallbackTag,
          warId: fallbackWarId,
          channelId: interaction.channelId,
          messageId: interaction.message.id,
        }
      : guildId
        ? await findWarMailTargetFromLifecycle({
            guildId,
            channelId: interaction.channelId,
            messageId: interaction.message.id,
            warId: fallbackWarId,
          })
        : null;
  if (!guildId || !fallbackTarget) {
    await interaction.reply({
      ephemeral: true,
      content: "This mail post can no longer be refreshed.",
    });
    return;
  }
  const refreshed = await refreshWarMailPostByResolvedTarget({
    client: interaction.client,
    guildId,
    tag: fallbackTarget.tag,
    channelId: fallbackTarget.channelId,
    messageId: fallbackTarget.messageId,
    expectedWarId: fallbackTarget.warId ?? null,
    expectedWarStartMs:
      fallbackTarget.warId !== null
        ? await resolveExpectedWarStartMsForRefresh({
            guildId,
            tag: fallbackTarget.tag,
            warId: Number(fallbackTarget.warId),
          })
        : null,
    fetchReason: "mail_refresh",
    routine: true,
  }).catch(() => "missing" as const);
  await interaction.reply({
    ephemeral: true,
    content:
      refreshed === "missing"
        ? "This mail post can no longer be refreshed."
        : refreshed === "frozen"
          ? "War mail frozen for the ended war."
          : "War mail refreshed.",
  });
}

export async function refreshAllTrackedWarMailPosts(
  client: Client,
): Promise<void> {
  const rows = await prisma.currentWar.findMany({
    select: {
      guildId: true,
      clanTag: true,
      warId: true,
      startTime: true,
    },
  });

  for (const row of rows) {
    const guildId = row.guildId?.trim() ?? "";
    if (!guildId) continue;
    const warIdNumber =
      row.warId !== null &&
      row.warId !== undefined &&
      Number.isFinite(row.warId)
        ? Math.trunc(row.warId)
        : null;
    if (warIdNumber === null) continue;
    const lifecycle = await warMailLifecycleService
      .getLifecycleForWar({
        guildId,
        clanTag: row.clanTag,
        warId: warIdNumber,
      })
      .catch(() => null);
    if (
      !lifecycle ||
      lifecycle.status !== "POSTED" ||
      !lifecycle.channelId ||
      !lifecycle.messageId
    ) {
      continue;
    }
    const pollKey = buildWarMailPollKey(guildId, row.clanTag, warIdNumber);
    const refreshed = await refreshWarMailPostByResolvedTarget({
      client,
      guildId,
      tag: row.clanTag,
      channelId: lifecycle.channelId,
      messageId: lifecycle.messageId,
      key: pollKey,
      expectedWarId: String(warIdNumber),
      expectedWarStartMs: row.startTime ? row.startTime.getTime() : null,
      fetchReason: "mail_refresh",
      routine: true,
    }).catch(() => "missing" as const);
    if (refreshed === "refreshed") {
      startWarMailPolling(client, pollKey);
    } else {
      stopWarMailPolling(pollKey);
    }
  }
}

export async function runForceMailUpdateCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const visibility =
    interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  await interaction.deferReply({ ephemeral: !isPublic });

  if (!interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const tag = normalizeTag(interaction.options.getString("tag", true));
  const trackedClan = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    await interaction.editReply(`Clan #${tag} is not in tracked clans.`);
    return;
  }

  const currentWar = await prisma.currentWar.findUnique({
    where: {
      clanTag_guildId: {
        guildId: interaction.guildId,
        clanTag: `#${tag}`,
      },
    },
    select: {
      warId: true,
      startTime: true,
    },
  });
  const currentWarIdNumber =
    currentWar?.warId !== null &&
    currentWar?.warId !== undefined &&
    Number.isFinite(currentWar?.warId)
      ? Math.trunc(currentWar.warId)
      : null;
  if (currentWarIdNumber === null) {
    await interaction.editReply(
      `No active war id found for #${tag}. Send mail from an active war view first.`,
    );
    return;
  }
  const currentWarIdText = String(currentWarIdNumber);
  const currentWarStartMs = currentWar?.startTime
    ? currentWar.startTime.getTime()
    : null;
  const lifecycle = await warMailLifecycleService
    .getLifecycleForWar({
      guildId: interaction.guildId,
      clanTag: tag,
      warId: currentWarIdNumber,
    })
    .catch(() => null);
  if (
    !lifecycle ||
    lifecycle.status !== "POSTED" ||
    !lifecycle.channelId ||
    !lifecycle.messageId
  ) {
    await interaction.editReply(
      `No active sent mail reference found for #${tag}. Send mail first or sync it via \`/force sync mail\`.`,
    );
    return;
  }
  const stored = {
    channelId: lifecycle.channelId,
    messageId: lifecycle.messageId,
  };
  const pollKey = buildWarMailPollKey(
    interaction.guildId,
    tag,
    currentWarIdNumber,
  );

  const refreshed = await refreshWarMailPostByResolvedTarget({
    client: interaction.client,
    guildId: interaction.guildId,
    tag,
    channelId: stored.channelId,
    messageId: stored.messageId,
    key: pollKey,
    expectedWarId: currentWarIdText,
    expectedWarStartMs: currentWarStartMs,
    fetchReason: "manual_refresh",
    routine: false,
  }).catch(() => "missing" as const);
  if (refreshed === "missing") {
    await interaction.editReply(
      `Could not refresh #${tag} mail in place. The stored message was missing or inaccessible.`,
    );
    return;
  }
  const channelId = stored.channelId;
  const messageId = stored.messageId;
  if (refreshed === "refreshed") {
    startWarMailPolling(interaction.client, pollKey);
  } else {
    stopWarMailPolling(pollKey);
  }

  await interaction.editReply(
    [
      `Force mail update complete for #${tag}.`,
      "Updated existing message in place (no new ping).",
      refreshed === "frozen"
        ? "Refresh tracking stopped because the war has ended."
        : "20-minute refresh tracking is active for this post.",
      `Message: https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`,
    ].join("\n"),
  );
}

export async function handlePointsPostButton(
  interaction: ButtonInteraction,
): Promise<void> {
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
      content: truncateDiscordContent(
        interaction.message.content || "Points result",
      ),
      embeds: interaction.message.embeds.map((embed) => embed.toJSON()),
    });
    await interaction.reply({
      ephemeral: true,
      content: "Posted to channel.",
    });
  } catch {
    await interaction.reply({
      ephemeral: true,
      content:
        "Failed to post to channel. Check bot permissions and try again.",
    });
  }
}

async function getSourceOfTruthSync(
  _settings: SettingsService,
  _guildId?: string | null,
): Promise<number | null> {
  const latestSync = await pointsSyncService.findLatestSyncNum({
    guildId: _guildId ?? null,
  });
  if (latestSync !== null) {
    return Math.max(0, latestSync - 1);
  }

  const tracked = await prisma.trackedClan.findMany({
    select: { tag: true },
  });
  const trackedTags = new Set(tracked.map((row) => normalizeTag(row.tag)));
  const trackedForHistory = [...trackedTags];
  const latestHistory = await prisma.clanWarHistory.findFirst({
    where: {
      syncNumber: { not: null },
      ...(trackedForHistory.length > 0
        ? { clanTag: { in: trackedForHistory } }
        : {}),
    },
    orderBy: { warStartTime: "desc" },
    select: { syncNumber: true },
  });
  const latestHistorySync = Number(latestHistory?.syncNumber ?? NaN);
  if (Number.isFinite(latestHistorySync)) {
    return Math.max(0, Math.trunc(latestHistorySync));
  }

  return null;
}

function getWarStartDateForSync(
  currentStartTime: Date | null | undefined,
  war: { startTime?: string | null } | null | undefined,
): Date | null {
  if (currentStartTime instanceof Date) return currentStartTime;
  const startMs = parseCocApiTime(war?.startTime);
  if (startMs === null || !Number.isFinite(startMs)) return null;
  return new Date(startMs);
}

function normalizeFwaOutcomeForValidation(
  value: string | null | undefined,
): "WIN" | "LOSE" | "UNKNOWN" | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (
    normalized === "WIN" ||
    normalized === "LOSE" ||
    normalized === "UNKNOWN"
  ) {
    return normalized;
  }
  return null;
}

function normalizeDisplayMatchTypeForValidation(
  value: string | null | undefined,
): "FWA" | "BL" | "MM" | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (normalized === "FWA" || normalized === "BL" || normalized === "MM")
    return normalized;
  return null;
}

function resolvePersistedMatchTypeForValidation(input: {
  lastKnownMatchType: string | null | undefined;
  isFwa: boolean | null | undefined;
}): "FWA" | "BL" | "MM" | "BL/MM" | null {
  const stored = normalizeDisplayMatchTypeForValidation(
    input.lastKnownMatchType,
  );
  if (stored) return stored;
  if (input.isFwa === true) return "FWA";
  if (input.isFwa === false) return "BL/MM";
  return null;
}

function isMatchTypeValidationAligned(
  currentMatchType: "FWA" | "BL" | "MM" | null,
  persistedMatchType: "FWA" | "BL" | "MM" | "BL/MM" | null,
): boolean {
  if (!currentMatchType || !persistedMatchType)
    return currentMatchType === persistedMatchType;
  if (persistedMatchType === "BL/MM") {
    return currentMatchType === "BL" || currentMatchType === "MM";
  }
  return currentMatchType === persistedMatchType;
}

function buildSyncValidationState(input: {
  syncRow: {
    syncNum: number;
    opponentTag: string;
    clanPoints: number;
    opponentPoints: number;
    warStartTime: Date;
    syncFetchedAt: Date;
    outcome: string | null;
    isFwa: boolean | null;
    lastKnownMatchType?: string | null;
  } | null;
  currentWarId?: string | number | null;
  currentWarStartTime: Date | null;
  siteCurrent: boolean;
  syncNum: number | null;
  opponentTag: string;
  clanPoints: number | null;
  opponentPoints: number | null;
  outcome: string | null;
  isFwa: boolean | null;
  effectiveMatchType?: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  effectiveExpectedOutcome?: "WIN" | "LOSE" | "UNKNOWN" | null;
  opponentNotFound?: boolean;
}): SyncValidationState {
  if (!input.siteCurrent) {
    return {
      siteCurrent: false,
      syncRowMissing: input.syncRow === null,
      differences: [],
      statusLine:
        input.opponentNotFound === true
          ? POINTS_CLAN_NOT_FOUND_STATUS_LINE
          : ":hourglass_flowing_sand: points.fwafarm is not updated for this matchup yet.",
    };
  }

  const suppressMissingPersistedRowDifference =
    input.syncRow === null &&
    input.opponentNotFound === true &&
    input.syncNum !== null &&
    Number.isFinite(input.syncNum) &&
    (input.opponentPoints === null || !Number.isFinite(input.opponentPoints)) &&
    (normalizeWarIdText(input.currentWarId) !== null ||
      (input.currentWarStartTime instanceof Date &&
        Number.isFinite(input.currentWarStartTime.getTime())));
  const differences: string[] = [];
  if (!input.syncRow) {
    if (!suppressMissingPersistedRowDifference) {
      differences.push("- Missing persisted sync validation row for this war");
    }
  } else {
    const currentSyncLabel =
      input.syncNum !== null && Number.isFinite(input.syncNum)
        ? "#" + String(Math.trunc(input.syncNum))
        : "unknown";
    const persistedSyncLabel = "#" + String(Math.trunc(input.syncRow.syncNum));
    if (
      input.syncNum === null ||
      !Number.isFinite(input.syncNum) ||
      Math.trunc(input.syncNum) !== Math.trunc(input.syncRow.syncNum)
    ) {
      differences.push(
        "- Sync # mismatch: current " +
          currentSyncLabel +
          ", persisted " +
          persistedSyncLabel,
      );
    }
    const currentOpponentTag = normalizeTag(input.opponentTag);
    const persistedOpponentTag = normalizeTag(input.syncRow.opponentTag);
    if (persistedOpponentTag !== currentOpponentTag) {
      differences.push(
        "- Opponent mismatch: current #" +
          (currentOpponentTag || "unknown") +
          ", persisted #" +
          (persistedOpponentTag || "unknown"),
      );
    }

    const currentMatchType =
      normalizeDisplayMatchTypeForValidation(
        input.effectiveMatchType ?? null,
      ) ?? (input.isFwa === true ? "FWA" : input.isFwa === false ? "BL" : null);
    const persistedMatchType = resolvePersistedMatchTypeForValidation({
      lastKnownMatchType: input.syncRow.lastKnownMatchType ?? null,
      isFwa: input.syncRow.isFwa ?? null,
    });
    if (!isMatchTypeValidationAligned(currentMatchType, persistedMatchType)) {
      differences.push(
        "- Match type mismatch: current " +
          (currentMatchType ?? "UNKNOWN") +
          ", persisted " +
          (persistedMatchType ?? "UNKNOWN"),
      );
    }

    const currentOutcome =
      currentMatchType === "FWA"
        ? (normalizeFwaOutcomeForValidation(
            input.effectiveExpectedOutcome ?? input.outcome,
          ) ?? "UNKNOWN")
        : null;
    const persistedOutcome =
      persistedMatchType === "FWA"
        ? (normalizeFwaOutcomeForValidation(input.syncRow.outcome) ?? "UNKNOWN")
        : null;
    if (currentOutcome !== persistedOutcome) {
      differences.push(
        "- Outcome mismatch: current " +
          (currentOutcome ?? "N/A") +
          ", persisted " +
          (persistedOutcome ?? "N/A"),
      );
    }
  }

  const showNotFoundStatus = input.opponentNotFound === true;
  return {
    siteCurrent: true,
    syncRowMissing: input.syncRow === null,
    differences,
    statusLine:
      showNotFoundStatus &&
      (differences.length > 0 || suppressMissingPersistedRowDifference)
        ? POINTS_CLAN_NOT_FOUND_STATUS_LINE
        : differences.length > 0
          ? ":warning: Data not fully synced with points.fwafarm"
          : "✅ Data is in sync with points.fwafarm",
  };
}
function buildStoredSyncSummary(input: {
  syncRow: {
    syncNum: number;
    lastKnownSyncNumber: number | null;
    warId: string | null;
    warStartTime: Date;
    syncFetchedAt: Date;
    lastSuccessfulPointsApiFetchAt: Date | null;
    needsValidation: boolean;
  } | null;
  fallbackSyncNum: number | null;
  warId: string | number | null | undefined;
  warStartTime: Date | null;
  opponentNotFound: boolean;
  validationState: SyncValidationState;
}): {
  syncLine: string;
  updatedLine: string | null;
  stateLine: string;
} {
  const syncNumber = resolveRenderedSyncNumberForStoredSummary(input);
  const syncLine =
    syncNumber !== null && Number.isFinite(syncNumber)
      ? `#${Math.trunc(syncNumber)} (${Math.trunc(syncNumber) % 2 === 0 ? "High Sync" : "Low Sync"})`
      : "unknown";
  const syncFetchedAtMs =
    input.syncRow?.lastSuccessfulPointsApiFetchAt?.getTime?.() ??
    input.syncRow?.syncFetchedAt?.getTime?.() ??
    NaN;
  const updatedLine =
    Number.isFinite(syncFetchedAtMs) && syncFetchedAtMs > 0
      ? `<t:${Math.floor(syncFetchedAtMs / 1000)}:R>`
      : null;
  const stateLine = buildActionableSyncStateLine({
    syncRow: input.syncRow
      ? { needsValidation: input.syncRow.needsValidation }
      : null,
    siteCurrent: input.validationState.siteCurrent,
    differenceCount: input.validationState.differences.length,
  });
  return { syncLine, updatedLine, stateLine };
}

/** Purpose: normalize optional sync values into comparable integers. */
function toComparableSyncNumber(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null;
  return Math.trunc(value);
}

/** Purpose: normalize optional war-start timestamps to epoch milliseconds for identity matching. */
function toWarStartMs(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Purpose: compare persisted and active war identities with warId-first precedence. */
function isSameWarIdentityForSyncSummary(input: {
  rowWarId: string | null | undefined;
  rowWarStartTime: Date | null | undefined;
  activeWarId: string | number | null | undefined;
  activeWarStartTime: Date | null | undefined;
}): boolean {
  const activeWarId = normalizeWarIdText(input.activeWarId);
  const rowWarId = normalizeWarIdText(input.rowWarId);
  if (activeWarId) {
    return rowWarId === activeWarId;
  }
  const activeWarStartMs = toWarStartMs(input.activeWarStartTime);
  const rowWarStartMs = toWarStartMs(input.rowWarStartTime);
  return (
    activeWarStartMs !== null &&
    rowWarStartMs !== null &&
    Math.trunc(activeWarStartMs) === Math.trunc(rowWarStartMs)
  );
}

/** Purpose: resolve sync number rendering with same-war fallback precedence for explicit opponent-not-found cases. */
function resolveRenderedSyncNumberForStoredSummary(input: {
  syncRow: {
    syncNum: number;
    lastKnownSyncNumber: number | null;
    warId: string | null;
    warStartTime: Date;
  } | null;
  fallbackSyncNum: number | null;
  warId: string | number | null | undefined;
  warStartTime: Date | null;
  opponentNotFound: boolean;
  validationState: SyncValidationState;
}): number | null {
  const persistedSyncNum = toComparableSyncNumber(input.syncRow?.syncNum);
  const fallbackSyncNum = toComparableSyncNumber(input.fallbackSyncNum);
  if (
    !input.opponentNotFound ||
    !input.validationState.siteCurrent ||
    (!normalizeWarIdText(input.warId) &&
      toWarStartMs(input.warStartTime) === null)
  ) {
    return persistedSyncNum ?? fallbackSyncNum;
  }

  const rowMatchesActiveWar =
    input.syncRow === null
      ? false
      : isSameWarIdentityForSyncSummary({
          rowWarId: input.syncRow.warId ?? null,
          rowWarStartTime: input.syncRow.warStartTime ?? null,
          activeWarId: input.warId,
          activeWarStartTime: input.warStartTime,
        });
  if (input.syncRow !== null && !rowMatchesActiveWar) {
    return fallbackSyncNum ?? persistedSyncNum;
  }

  const checkpointSyncNum = toComparableSyncNumber(
    input.syncRow?.lastKnownSyncNumber ?? null,
  );
  const persistedBestSync = Math.max(
    persistedSyncNum ?? -1,
    checkpointSyncNum ?? -1,
  );
  if (persistedBestSync < 0) {
    return fallbackSyncNum;
  }
  if (fallbackSyncNum === null) {
    return persistedBestSync;
  }
  return fallbackSyncNum > persistedBestSync
    ? fallbackSyncNum
    : persistedBestSync;
}

/** Purpose: classify whether points-site data is current for this matchup, including tracked-clan fallback proof. */
function isPointsValidationCurrentForMatchup(input: {
  primarySnapshot: Pick<
    PointsSnapshot,
    "winnerBoxTags" | "winnerBoxSync"
  > | null;
  opponentSnapshot: Pick<
    PointsSnapshot,
    | "snapshotSource"
    | "fallbackCurrentForWar"
    | "fallbackExtractedOpponentTag"
    | "winnerBoxSync"
  > | null;
  opponentTag: string;
  sourceSync: number | null;
}): boolean {
  const normalizedOpponentTag = normalizeTag(input.opponentTag);
  const primaryCurrent =
    input.primarySnapshot !== null &&
    input.primarySnapshot.winnerBoxTags
      .map((tag) => normalizeTag(tag))
      .includes(normalizedOpponentTag) &&
    !(
      input.sourceSync !== null &&
      input.primarySnapshot.winnerBoxSync !== null &&
      Number.isFinite(input.primarySnapshot.winnerBoxSync) &&
      Math.trunc(input.primarySnapshot.winnerBoxSync) <=
        Math.trunc(input.sourceSync)
    );
  if (primaryCurrent) return true;

  if (!input.opponentSnapshot) return false;
  if (input.opponentSnapshot.snapshotSource !== "tracked_clan_fallback")
    return false;
  if (!input.opponentSnapshot.fallbackCurrentForWar) return false;
  const fallbackOpponentTag = normalizeTag(
    String(input.opponentSnapshot.fallbackExtractedOpponentTag ?? ""),
  );
  if (fallbackOpponentTag !== normalizedOpponentTag) return false;
  const fallbackSync = input.opponentSnapshot.winnerBoxSync;
  if (
    input.sourceSync !== null &&
    fallbackSync !== null &&
    Number.isFinite(fallbackSync) &&
    Math.trunc(fallbackSync) <= Math.trunc(input.sourceSync)
  ) {
    return false;
  }
  return true;
}

async function persistClanPointsSyncIfCurrent(input: {
  guildId: string | null | undefined;
  clanTag: string;
  warId: number | null | undefined;
  warStartTime: Date | null;
  siteCurrent: boolean;
  syncNum: number | null;
  opponentTag: string;
  clanPoints: number | null;
  opponentPoints: number | null;
  outcome: string | null;
  isFwa: boolean | null;
  fetchedAtMs?: number | null;
  fetchReason?: PointsApiFetchReason;
  matchType?: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  opponentNotFound?: boolean;
}): Promise<"none" | "full" | "checkpoint"> {
  if (!input.guildId || !input.siteCurrent) return "none";
  if (
    input.warStartTime &&
    input.syncNum !== null &&
    Number.isFinite(input.syncNum) &&
    input.clanPoints !== null &&
    Number.isFinite(input.clanPoints) &&
    input.opponentPoints !== null &&
    Number.isFinite(input.opponentPoints) &&
    Boolean(input.opponentTag)
  ) {
    await pointsSyncService.upsertPointsSync({
      guildId: input.guildId,
      clanTag: input.clanTag,
      warId:
        input.warId !== null &&
        input.warId !== undefined &&
        Number.isFinite(input.warId)
          ? String(Math.trunc(input.warId))
          : null,
      warStartTime: input.warStartTime,
      syncNum: Math.trunc(input.syncNum),
      opponentTag: input.opponentTag,
      clanPoints: Math.trunc(input.clanPoints),
      opponentPoints: Math.trunc(input.opponentPoints),
      outcome: input.outcome ?? null,
      isFwa: input.isFwa ?? false,
      fetchedAt:
        input.fetchedAtMs !== null &&
        input.fetchedAtMs !== undefined &&
        Number.isFinite(input.fetchedAtMs)
          ? new Date(Math.trunc(input.fetchedAtMs))
          : undefined,
      fetchReason: input.fetchReason ?? "match_render",
      matchType: input.matchType ?? null,
      needsValidation: false,
    });
    return "full";
  }

  const hasWarIdentity =
    (input.warId !== null &&
      input.warId !== undefined &&
      Number.isFinite(input.warId)) ||
    input.warStartTime instanceof Date;
  const canCheckpointSync =
    input.opponentNotFound === true &&
    hasWarIdentity &&
    input.syncNum !== null &&
    Number.isFinite(input.syncNum) &&
    (input.opponentPoints === null || !Number.isFinite(input.opponentPoints));
  if (!canCheckpointSync) return "none";
  const checkpointSyncNum = toComparableSyncNumber(input.syncNum);
  if (checkpointSyncNum === null) return "none";

  const checkpointed = await pointsSyncService.checkpointCurrentWarSync({
    guildId: input.guildId,
    clanTag: input.clanTag,
    warId:
      input.warId !== null &&
      input.warId !== undefined &&
      Number.isFinite(input.warId)
        ? String(Math.trunc(input.warId))
        : null,
    warStartTime: input.warStartTime,
    syncNum: checkpointSyncNum,
    fetchedAt:
      input.fetchedAtMs !== null &&
      input.fetchedAtMs !== undefined &&
      Number.isFinite(input.fetchedAtMs)
        ? new Date(Math.trunc(input.fetchedAtMs))
        : undefined,
    fetchReason: input.fetchReason ?? "match_render",
  });
  return checkpointed ? "checkpoint" : "none";
}

type MatchTypeFallbackResolution = {
  confirmedCurrent: MatchTypeResolution | null;
  storedSync: MatchTypeResolution | null;
  unconfirmedCurrent: MatchTypeResolution | null;
};

/** Purpose: verify confirmed FWA fallback comes from the same live-war identity. */
function hasSameWarExplicitFwaConfirmation(input: {
  fallbackResolution: MatchTypeFallbackResolution;
  currentWarStartTime: Date | null | undefined;
  currentWarOpponentTag: string | null | undefined;
  activeWarStartTime: Date | null | undefined;
  activeOpponentTag: string | null | undefined;
}): boolean {
  const confirmed = input.fallbackResolution.confirmedCurrent;
  if (
    !confirmed ||
    confirmed.matchType !== "FWA" ||
    confirmed.confirmed !== true
  )
    return false;
  const persistedOpponentTag = normalizeTag(
    String(input.currentWarOpponentTag ?? ""),
  );
  const activeOpponentTag = normalizeTag(String(input.activeOpponentTag ?? ""));
  if (
    !persistedOpponentTag ||
    !activeOpponentTag ||
    persistedOpponentTag !== activeOpponentTag
  ) {
    return false;
  }
  const persistedWarStartMs =
    input.currentWarStartTime instanceof Date &&
    Number.isFinite(input.currentWarStartTime.getTime())
      ? input.currentWarStartTime.getTime()
      : null;
  const activeWarStartMs =
    input.activeWarStartTime instanceof Date &&
    Number.isFinite(input.activeWarStartTime.getTime())
      ? input.activeWarStartTime.getTime()
      : null;
  if (persistedWarStartMs === null || activeWarStartMs === null) return false;
  return persistedWarStartMs === activeWarStartMs;
}

/** Purpose: block fallback FWA-family auto-selection on explicit opponent not-found unless same-war confirmation exists. */
function applyExplicitOpponentNotFoundFallbackGuard(input: {
  fallbackResolution: MatchTypeFallbackResolution;
  opponentNotFoundExplicitly: boolean;
  hasSameWarExplicitFwaConfirmation: boolean;
}): MatchTypeFallbackResolution {
  if (
    !input.opponentNotFoundExplicitly ||
    input.hasSameWarExplicitFwaConfirmation
  ) {
    return input.fallbackResolution;
  }
  const dropFallbackFwa = (
    resolution: MatchTypeResolution | null,
  ): MatchTypeResolution | null => {
    if (!resolution) return null;
    if (resolution.matchType !== "FWA") return resolution;
    return null;
  };
  return {
    confirmedCurrent: dropFallbackFwa(
      input.fallbackResolution.confirmedCurrent,
    ),
    storedSync: dropFallbackFwa(input.fallbackResolution.storedSync),
    unconfirmedCurrent: dropFallbackFwa(
      input.fallbackResolution.unconfirmedCurrent,
    ),
  };
}

export const getMailBlockedReasonFromStatusForTest =
  getMailBlockedReasonFromStatus;
export const collectBaseSwapTownhallLevelsForTest =
  collectBaseSwapTownhallLevels;
export const buildBaseSwapLayoutLinksForTest = buildBaseSwapLayoutLinks;
export const batchFwaBaseSwapPingLinesForTest = batchFwaBaseSwapPingLines;
export const buildFwaBaseSwapActiveWarDmLinesForTest =
  buildFwaBaseSwapActiveWarDmLines;
export const buildFwaBaseSwapBaseErrorDmLinesForTest =
  buildFwaBaseSwapBaseErrorDmLines;
export const buildFwaBaseSwapDmContentForTest = buildFwaBaseSwapDmContent;
export const deliverFwaBaseSwapDmMessagesForTest = deliverFwaBaseSwapDmMessages;
export const buildFwaBaseSwapRenderPlanForTest = buildFwaBaseSwapRenderPlan;
export const splitFwaBaseSwapAnnouncementLinesForTest =
  splitFwaBaseSwapAnnouncementLines;
export const buildFwaBaseSwapPhaseTimingLineForTest =
  buildFwaBaseSwapPhaseTimingLine;
export const renderFwaBaseSwapAnnouncementForTest =
  renderFwaBaseSwapAnnouncement;
export const getMailBlockedReasonFromRevisionStateForTest =
  getMailBlockedReasonFromRevisionState;
export const resolveWarMailFreshnessStatusForTest =
  resolveWarMailFreshnessStatus;
export const formatMailLifecycleStatusLineForTest =
  formatMailLifecycleStatusLine;
export const buildWarMailStatusDebugSnapshotForTest =
  buildWarMailStatusDebugSnapshot;
export const buildMailStatusDebugLinesForTest = buildMailStatusDebugLines;
export const resolveScopedDraftRevisionForTest = resolveScopedDraftRevision;
export const resolveEffectiveRevisionStateForTest =
  resolveEffectiveRevisionState;
export const resolveConfirmedRevisionBaselineForTest =
  resolveConfirmedRevisionBaseline;
export const shouldDisplayInferredMatchTypeForTest =
  shouldDisplayInferredMatchType;
export const resolveObservedSyncNumberForMatchupForTest =
  resolveObservedSyncNumberForMatchup;
export const buildDraftFromMatchTypeSelectionForTest =
  buildDraftFromMatchTypeSelection;
export const resolveMatchTypeSelectionForTest = resolveMatchTypeSelection;
export const buildDraftFromOutcomeToggleForTest = buildDraftFromOutcomeToggle;
export const resolveEffectiveFwaOutcomeForTest = resolveEffectiveFwaOutcome;
export const buildEffectiveMatchMismatchWarningsForTest =
  buildEffectiveMatchMismatchWarnings;
export const resolveOpponentActiveFwaEvidenceForTest =
  resolveOpponentActiveFwaEvidence;
export const isLowConfidenceAllianceMismatchScenarioForTest =
  isLowConfidenceAllianceMismatchScenario;
export const resolveSingleClanMatchEmbedColorForTest =
  resolveSingleClanMatchEmbedColor;
export const buildSingleClanMatchLinksForTest = buildSingleClanMatchLinks;
export const buildOpponentSnapshotFromTrackedClanFallbackForTest =
  buildOpponentSnapshotFromTrackedClanFallback;
export const resolveForceSyncMatchupEvidenceForTest =
  resolveForceSyncMatchupEvidence;
export const isPointsValidationCurrentForMatchupForTest =
  isPointsValidationCurrentForMatchup;
export const shouldHydrateAlliancePayloadForTest = shouldHydrateAlliancePayload;

export const resolveMatchTypeFromStoredSyncRowForTest =
  resolveMatchTypeFromStoredSyncRow;
export const buildSyncValidationStateForTest = buildSyncValidationState;
export const resolveRenderedSyncNumberForStoredSummaryForTest =
  resolveRenderedSyncNumberForStoredSummary;
export const hasSameWarExplicitFwaConfirmationForTest =
  hasSameWarExplicitFwaConfirmation;
export const applyExplicitOpponentNotFoundFallbackGuardForTest =
  applyExplicitOpponentNotFoundFallbackGuard;
export const resolveMatchTypeResolutionLogLevelForTest =
  resolveMatchTypeResolutionLogLevel;
export const resolveRoutineBlockedPointsFetchSkipLogLevelForTest =
  resolveRoutineBlockedPointsFetchSkipLogLevel;
export const resetFwaSteadyStateLogTrackersForTest =
  resetFwaSteadyStateLogTrackers;
export const resolveWarMailRefreshIdentityDecisionForTest =
  resolveWarMailRefreshIdentityDecision;

/** Purpose: infer match type strictly from opponent points-site signals. */
function inferMatchTypeFromPointsSnapshots(
  _primaryPoints: Pick<PointsSnapshot, "activeFwa"> | null,
  opponentPoints: Pick<
    PointsSnapshot,
    "balance" | "activeFwa" | "notFound"
  > | null,
  options?: {
    winnerBoxNotMarkedFwa?: boolean | null;
    opponentEvidenceMissingOrNotCurrent?: boolean | null;
    currentWarState?: "preparation" | "inWar" | "notInWar" | null;
    currentWarClanAttacksUsed?: number | null;
    currentWarClanStars?: number | null;
    currentWarOpponentStars?: number | null;
  },
): MatchTypeResolution | null {
  return inferMatchTypeFromOpponentPoints({
    available: opponentPoints !== null,
    balance: opponentPoints?.balance ?? null,
    activeFwa: opponentPoints?.activeFwa ?? null,
    notFound: opponentPoints?.notFound ?? false,
    winnerBoxNotMarkedFwa: options?.winnerBoxNotMarkedFwa ?? false,
    opponentEvidenceMissingOrNotCurrent:
      options?.opponentEvidenceMissingOrNotCurrent ?? false,
    currentWarState: options?.currentWarState ?? null,
    currentWarClanAttacksUsed: options?.currentWarClanAttacksUsed ?? null,
    currentWarClanStars: options?.currentWarClanStars ?? null,
    currentWarOpponentStars: options?.currentWarOpponentStars ?? null,
  });
}

export const inferMatchTypeFromPointsSnapshotsForTest =
  inferMatchTypeFromPointsSnapshots;

/** Purpose: normalize points-based inference into the shared resolution shape. */
function toMatchTypeResolutionFromPointsInference(
  pointsInference: MatchTypeResolution | null,
): MatchTypeResolution | null {
  return pointsInference;
}

/** Purpose: resolve match type from persisted sync data when live state is unset. */
async function resolveMatchTypeFromStoredSync(params: {
  guildId: string | null;
  clanTag: string;
  opponentTag: string;
  warId?: number | null;
  warStartTime?: Date | null;
}): Promise<MatchTypeResolution | null> {
  if (!params.guildId || !params.opponentTag) return null;
  const warIdText =
    params.warId !== null &&
    params.warId !== undefined &&
    Number.isFinite(params.warId)
      ? String(Math.trunc(params.warId))
      : null;
  const warStartTime =
    params.warStartTime instanceof Date ? params.warStartTime : null;
  if (!warIdText && !warStartTime) return null;
  const syncRow = await pointsSyncService.getCurrentSyncForClan({
    guildId: params.guildId,
    clanTag: params.clanTag,
    warId: warIdText,
    warStartTime,
  });
  return resolveMatchTypeFromStoredSyncRow({
    syncRow: syncRow
      ? {
          opponentTag: syncRow.opponentTag,
          isFwa: syncRow.isFwa ?? null,
          lastKnownMatchType: syncRow.lastKnownMatchType ?? null,
        }
      : null,
    opponentTag: params.opponentTag,
  });
}

/** Purpose: resolve match type with DB-backed fallback before live inference. */
async function resolveMatchTypeWithFallback(params: {
  guildId: string | null;
  clanTag: string;
  opponentTag: string;
  warState: WarStateForSync;
  warId?: number | null;
  warStartTime?: Date | null;
  existingMatchType: "FWA" | "BL" | "MM" | "SKIP" | null | undefined;
  existingInferredMatchType?: boolean | null | undefined;
}): Promise<MatchTypeFallbackResolution> {
  const currentResolution = resolveCurrentWarMatchTypeSignal({
    matchType: params.existingMatchType ?? null,
    inferredMatchType: params.existingInferredMatchType ?? true,
  });
  const hasWarIdentity =
    (params.warId !== null &&
      params.warId !== undefined &&
      Number.isFinite(params.warId)) ||
    params.warStartTime instanceof Date;
  if (params.warState === "notInWar") {
    return {
      confirmedCurrent: currentResolution.confirmed,
      storedSync: hasWarIdentity
        ? await resolveMatchTypeFromStoredSync({
            guildId: params.guildId,
            clanTag: params.clanTag,
            opponentTag: params.opponentTag,
            warId: params.warId,
            warStartTime: params.warStartTime,
          })
        : null,
      unconfirmedCurrent: currentResolution.unconfirmed,
    };
  }
  return {
    confirmedCurrent: currentResolution.confirmed,
    storedSync: hasWarIdentity
      ? await resolveMatchTypeFromStoredSync({
          guildId: params.guildId,
          clanTag: params.clanTag,
          opponentTag: params.opponentTag,
          warId: params.warId,
          warStartTime: params.warStartTime,
        })
      : null,
    unconfirmedCurrent: currentResolution.unconfirmed,
  };
}

export const resolveMatchTypeWithFallbackForTest = resolveMatchTypeWithFallback;

/** Purpose: apply source-of-truth sync number over a scraped points snapshot. */
function applySourceSync(
  snapshot: PointsSnapshot,
  sourceSync: number | null,
): PointsSnapshot {
  if (sourceSync === null) return snapshot;
  return {
    ...snapshot,
    effectiveSync: sourceSync,
    syncMode: getSyncMode(sourceSync),
  };
}

type TrackedClanOpponentFallbackResult = {
  snapshot: PointsSnapshot | null;
  extractedOpponentTag: string | null;
  extractedOpponentName: string | null;
  currentForWar: boolean;
  normalizedWinnerBoxText: string | null;
};

function normalizeTrackedFallbackWinnerBoxText(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  if (hasWinnerBoxNotMarkedFwaSignal(text)) {
    return "Not marked as an FWA match.";
  }
  const normalized = text.trim();
  return normalized || null;
}

/** Purpose: materialize opponent validation snapshot from tracked-clan points page when opponent page is missing. */
function buildOpponentSnapshotFromTrackedClanFallback(params: {
  requestedOpponentTag: string;
  trackedClanTag: string;
  trackedSnapshot: PointsSnapshot | null;
}): TrackedClanOpponentFallbackResult {
  const requestedOpponentTag = normalizeTag(params.requestedOpponentTag);
  const trackedClanTag = normalizeTag(params.trackedClanTag);
  const trackedSnapshot = params.trackedSnapshot;
  const normalizedWinnerBoxText = normalizeTrackedFallbackWinnerBoxText(
    trackedSnapshot?.winnerBoxText ?? null,
  );

  if (!requestedOpponentTag || !trackedClanTag || !trackedSnapshot) {
    return {
      snapshot: null,
      extractedOpponentTag: null,
      extractedOpponentName: null,
      currentForWar: false,
      normalizedWinnerBoxText,
    };
  }

  const headerPrimaryTag = normalizeTag(
    String(trackedSnapshot.headerPrimaryTag ?? ""),
  );
  const headerOpponentTag = normalizeTag(
    String(trackedSnapshot.headerOpponentTag ?? ""),
  );
  let extractedOpponentTag: string | null = null;
  let extractedOpponentName: string | null = null;

  if (
    headerPrimaryTag &&
    headerPrimaryTag === trackedClanTag &&
    headerOpponentTag
  ) {
    extractedOpponentTag = headerOpponentTag;
    extractedOpponentName = sanitizeClanName(
      trackedSnapshot.headerOpponentName ?? null,
    );
  } else if (
    headerOpponentTag &&
    headerOpponentTag === trackedClanTag &&
    headerPrimaryTag
  ) {
    extractedOpponentTag = headerPrimaryTag;
    extractedOpponentName = sanitizeClanName(
      trackedSnapshot.headerPrimaryName ?? null,
    );
  }

  if (!extractedOpponentTag) {
    const winnerBoxTags = trackedSnapshot.winnerBoxTags
      .map((value) => normalizeTag(value))
      .filter((value): value is string => Boolean(value));
    const nonTrackedTag =
      winnerBoxTags.find((value) => value !== trackedClanTag) ?? null;
    if (nonTrackedTag) {
      extractedOpponentTag = nonTrackedTag;
    }
  }

  const currentForWar = extractedOpponentTag === requestedOpponentTag;
  const opponentBalance = deriveOpponentBalanceFromPrimarySnapshot(
    trackedSnapshot,
    trackedClanTag,
    requestedOpponentTag,
  );
  if (
    !currentForWar ||
    opponentBalance === null ||
    !Number.isFinite(opponentBalance)
  ) {
    return {
      snapshot: null,
      extractedOpponentTag,
      extractedOpponentName,
      currentForWar,
      normalizedWinnerBoxText,
    };
  }

  const winnerBoxTags = Array.from(
    new Set([
      ...trackedSnapshot.winnerBoxTags
        .map((value) => normalizeTag(value))
        .filter(Boolean),
      trackedClanTag,
      requestedOpponentTag,
    ]),
  );

  return {
    snapshot: {
      ...trackedSnapshot,
      tag: requestedOpponentTag,
      snapshotSource: "tracked_clan_fallback",
      lookupState: "clan_not_found",
      clanName: extractedOpponentName ?? trackedSnapshot.clanName ?? null,
      balance: Math.trunc(opponentBalance),
      activeFwa: null,
      notFound: true,
      fallbackCurrentForWar: true,
      fallbackExtractedOpponentTag: extractedOpponentTag,
      winnerBoxText: normalizedWinnerBoxText,
      winnerBoxTags,
      winnerBoxHasTag: true,
    },
    extractedOpponentTag,
    extractedOpponentName,
    currentForWar,
    normalizedWinnerBoxText,
  };
}

/** Purpose: align force-sync matchup-current evidence selection with /fwa match contract, including tracked fallback proof. */
function resolveForceSyncMatchupEvidence(input: {
  trackedClanTag: string;
  opponentTag: string;
  sourceSync: number | null;
  primarySnapshot: PointsSnapshot | null;
  directOpponentSnapshot: PointsSnapshot | null;
}): {
  opponentSnapshot: PointsSnapshot | null;
  siteCurrent: boolean;
  siteCurrentFromPrimary: boolean;
  usedTrackedFallback: boolean;
} {
  const normalizedOpponentTag = normalizeTag(input.opponentTag);
  if (!normalizedOpponentTag) {
    return {
      opponentSnapshot: input.directOpponentSnapshot ?? null,
      siteCurrent: false,
      siteCurrentFromPrimary: false,
      usedTrackedFallback: false,
    };
  }

  const siteCurrentFromPrimary = Boolean(
    input.primarySnapshot &&
    isPointsSiteUpdatedForOpponent(
      input.primarySnapshot,
      normalizedOpponentTag,
      input.sourceSync,
    ),
  );
  const directSiteCurrent = isPointsValidationCurrentForMatchup({
    primarySnapshot: input.primarySnapshot,
    opponentSnapshot: input.directOpponentSnapshot,
    opponentTag: normalizedOpponentTag,
    sourceSync: input.sourceSync,
  });
  if (directSiteCurrent) {
    return {
      opponentSnapshot: input.directOpponentSnapshot ?? null,
      siteCurrent: true,
      siteCurrentFromPrimary,
      usedTrackedFallback: false,
    };
  }

  const trackedFallback = buildOpponentSnapshotFromTrackedClanFallback({
    requestedOpponentTag: normalizedOpponentTag,
    trackedClanTag: input.trackedClanTag,
    trackedSnapshot: input.primarySnapshot,
  });
  const fallbackSnapshot = trackedFallback.snapshot;
  const fallbackSiteCurrent = isPointsValidationCurrentForMatchup({
    primarySnapshot: input.primarySnapshot,
    opponentSnapshot: fallbackSnapshot,
    opponentTag: normalizedOpponentTag,
    sourceSync: input.sourceSync,
  });
  if (fallbackSnapshot && fallbackSiteCurrent) {
    return {
      opponentSnapshot: fallbackSnapshot,
      siteCurrent: true,
      siteCurrentFromPrimary,
      usedTrackedFallback: true,
    };
  }

  return {
    opponentSnapshot: fallbackSnapshot ?? input.directOpponentSnapshot ?? null,
    siteCurrent: false,
    siteCurrentFromPrimary,
    usedTrackedFallback: false,
  };
}

type ActualSheetClanSnapshot = {
  totalWeight: string | null;
  weightCompo: string | null;
  weightDeltas: string | null;
  compoAdvice: string | null;
};

const ACTUAL_FIXED_LAYOUT_RANGE = "AllianceDashboard!A6:BE500";
const ACTUAL_COL_CLAN_TAG = 1; // B
const ACTUAL_COL_TOTAL_WEIGHT = 3; // D
const ACTUAL_COL_MISSING_WEIGHT = 20; // U
const ACTUAL_COL_TOTAL_PLAYERS = 21; // V
const ACTUAL_COL_BUCKET_START = 22; // W (was 21 / V)
const ACTUAL_COL_BUCKET_END = 27; // AB (was 26 / AA)
const ACTUAL_COL_ADJUSTMENT = 54; // BC (was 53 / BB)
const ACTUAL_COL_MODE = 56; // BE (was 55 / BD)
const ACTUAL_SHEET_CACHE_TTL_MS = 60 * 1000;

let actualSheetSnapshotCache: {
  snapshot: Map<string, ActualSheetClanSnapshot>;
  expiresAtMs: number;
} | null = null;

function normalizeTagBare(input: string): string {
  return normalizeTag(input).replace(/^#/, "");
}

async function readActualSheetSnapshotByTag(
  settings: SettingsService,
): Promise<Map<string, ActualSheetClanSnapshot>> {
  const sheets = new GoogleSheetsService(settings);
  const rows = await sheets.readLinkedValues(
    ACTUAL_FIXED_LAYOUT_RANGE,
    "actual",
  );
  const out = new Map<string, ActualSheetClanSnapshot>();
  for (const row of rows) {
    const mode = String(row[ACTUAL_COL_MODE] ?? "")
      .trim()
      .toUpperCase();
    if (mode !== "ACTUAL") continue;
    const clanTag = normalizeTagBare(String(row[ACTUAL_COL_CLAN_TAG] ?? ""));
    if (!clanTag) continue;
    const totalWeightRaw = String(row[ACTUAL_COL_TOTAL_WEIGHT] ?? "").trim();
    const missingRaw = String(row[ACTUAL_COL_MISSING_WEIGHT] ?? "").trim();
    const bucketValues = [
      String(row[ACTUAL_COL_BUCKET_START] ?? "").trim(),
      String(row[ACTUAL_COL_BUCKET_START + 1] ?? "").trim(),
      String(row[ACTUAL_COL_BUCKET_START + 2] ?? "").trim(),
      String(row[ACTUAL_COL_BUCKET_START + 3] ?? "").trim(),
      String(row[ACTUAL_COL_BUCKET_START + 4] ?? "").trim(),
      String(row[ACTUAL_COL_BUCKET_END] ?? "").trim(),
    ];
    const compoRaw = bucketValues
      .map((value, index) => {
        const label = ["TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"][index];
        return `${label}:${value || "0"}`;
      })
      .join(" | ");
    const weightDeltasRaw = `Missing:${missingRaw || "0"} | ${compoRaw}`;
    const adviceRaw = String(row[ACTUAL_COL_ADJUSTMENT] ?? "").trim();
    out.set(clanTag, {
      totalWeight: totalWeightRaw || null,
      weightCompo: compoRaw || null,
      weightDeltas: weightDeltasRaw || null,
      compoAdvice: adviceRaw || null,
    });
  }
  return out;
}

/** Purpose: cache ACTUAL sheet reads to keep /fwa match refreshes responsive. */
async function getActualSheetSnapshotCached(
  settings: SettingsService,
): Promise<Map<string, ActualSheetClanSnapshot>> {
  const now = Date.now();
  if (actualSheetSnapshotCache && actualSheetSnapshotCache.expiresAtMs > now) {
    return actualSheetSnapshotCache.snapshot;
  }
  const snapshot = await readActualSheetSnapshotByTag(settings);
  actualSheetSnapshotCache = {
    snapshot,
    expiresAtMs: now + ACTUAL_SHEET_CACHE_TTL_MS,
  };
  return snapshot;
}

function getHttpStatus(err: unknown): number | null {
  const status =
    (err as { status?: number } | null | undefined)?.status ??
    (err as { response?: { status?: number } } | null | undefined)?.response
      ?.status;
  return typeof status === "number" ? status : null;
}

type CurrentWarResult = Awaited<ReturnType<CoCService["getCurrentWar"]>>;
type WarLookupCache = Map<string, Promise<CurrentWarResult>>;

function getCurrentWarCached(
  cocService: CoCService,
  tag: string,
  warLookupCache?: WarLookupCache,
): Promise<CurrentWarResult> {
  const normalized = `#${normalizeTag(tag)}`;
  if (!warLookupCache) return cocService.getCurrentWar(normalized);
  const cached = warLookupCache.get(normalized);
  if (cached) return cached;
  const pending = cocService.getCurrentWar(normalized);
  warLookupCache.set(normalized, pending);
  return pending;
}

async function scrapeClanPoints(
  tag: string,
  reason: PointsApiFetchReason = "match_render",
  options?: {
    manualForceBypass?: boolean;
    caller?: PointsDirectFetchCaller;
  },
): Promise<PointsSnapshot> {
  const normalizedTag = normalizeTag(tag);
  const caller: PointsDirectFetchCaller = options?.caller ?? "command";
  const gateDecision = await pointsDirectFetchGate.evaluateFetchAccess({
    clanTag: normalizedTag,
    fetchReason: reason,
    caller,
    manualForceBypass: options?.manualForceBypass ?? false,
  });
  if (!gateDecision.allowed) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_fetch",
      source: "fallback_cache",
      detail: `tag=${normalizedTag} blocked=1 code=${gateDecision.decisionCode} reason=${reason} caller=${caller}`,
      status: "failure",
      errorCategory: "validation",
      errorCode: gateDecision.decisionCode,
    });
    throw new PointsDirectFetchBlockedError(gateDecision);
  }
  const url = buildPointsUrl(normalizedTag);
  const startedAtMs = Date.now();
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
      detail: `tag=${normalizedTag} status=403 blocked=true reason=${reason}`,
      durationMs: Date.now() - startedAtMs,
      status: "failure",
      errorCategory: "permission",
      errorCode: "HTTP_403",
    });
    console.info(
      `[points-fetch] source=web tag=${normalizedTag} reason=${reason} status=403`,
    );
    throw { status: 403, message: "points site returned 403" };
  }
  if (response.status >= 400) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_fetch",
      source: "web",
      detail: `tag=${normalizedTag} status=${response.status} reason=${reason}`,
      durationMs: Date.now() - startedAtMs,
      status: "failure",
      errorCategory: response.status >= 500 ? "upstream_api" : "validation",
      errorCode: `HTTP_${response.status}`,
    });
    console.info(
      `[points-fetch] source=web tag=${normalizedTag} reason=${reason} status=${response.status}`,
    );
    throw {
      status: response.status,
      message: `points site returned ${response.status}`,
    };
  }
  recordFetchEvent({
    namespace: "points",
    operation: "clan_points_fetch",
    source: "web",
    detail: `tag=${normalizedTag} status=${response.status} reason=${reason}`,
    durationMs: Date.now() - startedAtMs,
    status: "success",
  });
  console.info(
    `[points-fetch] source=web tag=${normalizedTag} reason=${reason} status=${response.status}`,
  );

  const html = String(response.data ?? "");
  const balance = extractPointBalance(html);
  const plain = toPlainText(html);
  const topSection = extractTopSectionText(html);
  const topHeader = extractMatchupHeader(topSection);
  const activeFwa = extractActiveFwa(topSection, plain);
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
  const lookupState = classifyPointsLookupState(topSection, plain);
  const notFound = lookupState === "clan_not_found";
  const winnerBoxText = extractWinnerBoxText(html);
  const winnerBoxTags = extractTagsFromText(topSection || winnerBoxText || "");
  const winnerBoxSync =
    topHeader.syncNumber ??
    extractSyncNumber(topSection || winnerBoxText || "");
  const matchupBalances = extractMatchupBalances(
    topSection || winnerBoxText || "",
  );
  const winnerBoxHasTag = winnerBoxTags.includes(normalizedTag);
  const effectiveSync =
    winnerBoxSync === null
      ? null
      : winnerBoxHasTag
        ? winnerBoxSync
        : winnerBoxSync + 1;
  const syncMode = getSyncMode(effectiveSync);

  const fetchedAtMs = Date.now();
  await pointsDirectFetchGate
    .recordObservedPointValue({
      clanTag: normalizedTag,
      observedPoints: balance,
      nowMs: fetchedAtMs,
    })
    .catch(() => undefined);
  return {
    version: POINTS_CACHE_VERSION,
    tag: normalizedTag,
    url,
    snapshotSource: "direct",
    lookupState,
    balance,
    clanName,
    activeFwa,
    notFound,
    winnerBoxText,
    winnerBoxTags,
    winnerBoxSync,
    effectiveSync,
    syncMode,
    winnerBoxHasTag,
    headerPrimaryName: topHeader.primaryName,
    headerOpponentName: topHeader.opponentName,
    headerPrimaryTag: topHeader.primaryTag,
    headerOpponentTag: topHeader.opponentTag,
    headerPrimaryBalance: matchupBalances.primaryBalance,
    headerOpponentBalance: matchupBalances.opponentBalance,
    warEndMs: null,
    lastWarCheckAtMs: fetchedAtMs,
    fetchedAtMs,
    refreshedForWarEndMs: null,
  };
}

type ClanPointsFetchOptions = {
  requiredOpponentTag?: string | null;
  fetchReason?: PointsApiFetchReason;
  warScopedSnapshot?: PointsSnapshot | null;
  fallbackTrackedClanTag?: string | null;
};

type WarScopedSyncReuseDbRow = WarScopedSyncReuseRow & {
  clanTag: string;
};

/** Purpose: bucket reusable sync rows by clan for O(1) lookup in match rendering loops. */
function groupWarScopedSyncRowsByClanTag(
  rows: WarScopedSyncReuseDbRow[],
): Map<string, WarScopedSyncReuseRow[]> {
  const grouped = new Map<string, WarScopedSyncReuseRow[]>();
  for (const row of rows) {
    const tag = normalizeTag(row.clanTag);
    const list = grouped.get(tag) ?? [];
    list.push({
      warId: row.warId ?? null,
      warStartTime: row.warStartTime,
      syncNum: row.syncNum,
      opponentTag: row.opponentTag,
      clanPoints: row.clanPoints,
      opponentPoints: row.opponentPoints,
      isFwa: row.isFwa ?? null,
      needsValidation: row.needsValidation,
      lastSuccessfulPointsApiFetchAt:
        row.lastSuccessfulPointsApiFetchAt ?? null,
      syncFetchedAt: row.syncFetchedAt,
    });
    grouped.set(tag, list);
  }
  return grouped;
}

/** Purpose: build a synthetic points snapshot from a validated war-scoped ClanPointsSync row. */
function buildPointsSnapshotFromWarScopedSyncRow(input: {
  clanTag: string;
  row: WarScopedSyncReuseRow;
}): PointsSnapshot {
  const clanTag = normalizeTag(input.clanTag);
  const opponentTag = normalizeTag(input.row.opponentTag);
  const fetchedAtMs =
    input.row.lastSuccessfulPointsApiFetchAt?.getTime?.() ??
    input.row.syncFetchedAt?.getTime?.() ??
    Date.now();
  const resolvedFetchedAtMs =
    Number.isFinite(fetchedAtMs) && fetchedAtMs > 0
      ? Math.trunc(fetchedAtMs)
      : Date.now();
  return {
    version: POINTS_CACHE_VERSION,
    tag: clanTag,
    url: buildPointsUrl(clanTag),
    snapshotSource: "direct",
    lookupState: "ok",
    balance: Math.trunc(input.row.clanPoints),
    clanName: null,
    activeFwa: input.row.isFwa ?? null,
    notFound: false,
    winnerBoxText: null,
    winnerBoxTags: [opponentTag, clanTag],
    winnerBoxSync: Math.trunc(input.row.syncNum),
    effectiveSync: Math.trunc(input.row.syncNum),
    syncMode: getSyncMode(Math.trunc(input.row.syncNum)),
    winnerBoxHasTag: true,
    headerPrimaryTag: clanTag,
    headerOpponentTag: opponentTag,
    headerPrimaryBalance: Math.trunc(input.row.clanPoints),
    headerOpponentBalance: Math.trunc(input.row.opponentPoints),
    warEndMs: null,
    lastWarCheckAtMs: resolvedFetchedAtMs,
    fetchedAtMs: resolvedFetchedAtMs,
    refreshedForWarEndMs: null,
  };
}

/** Purpose: select and materialize war-scoped persisted points for a clan, when eligible. */
function resolveWarScopedSnapshotForMatch(input: {
  rows: WarScopedSyncReuseRow[];
  clanTag: string;
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string;
  currentSyncNumber: number | null;
  sourceSyncNumber: number | null;
}): PointsSnapshot | null {
  const reusableRow = selectWarScopedReuseRow({
    rows: input.rows,
    warId: input.warId,
    warStartTime: input.warStartTime,
    opponentTag: input.opponentTag,
    currentSyncNumber: input.currentSyncNumber,
    sourceSyncNumber: input.sourceSyncNumber,
  });
  if (!reusableRow) return null;
  return buildPointsSnapshotFromWarScopedSyncRow({
    clanTag: input.clanTag,
    row: reusableRow,
  });
}

/** Purpose: load latest reusable persisted points snapshot for lock-blocked fetch fallbacks. */
async function getPersistedPointsSnapshotFallback(
  clanTag: string,
  requiredOpponentTag?: string | null,
): Promise<PointsSnapshot | null> {
  const normalizedTag = normalizeTag(clanTag);
  const normalizedOpponentTag = normalizeTag(String(requiredOpponentTag ?? ""));
  const row = await prisma.clanPointsSync.findFirst({
    where: {
      clanTag: `#${normalizedTag}`,
      needsValidation: false,
      ...(normalizedOpponentTag
        ? { opponentTag: `#${normalizedOpponentTag}` }
        : {}),
    },
    select: {
      warId: true,
      warStartTime: true,
      syncNum: true,
      opponentTag: true,
      clanPoints: true,
      opponentPoints: true,
      isFwa: true,
      needsValidation: true,
      lastSuccessfulPointsApiFetchAt: true,
      syncFetchedAt: true,
    },
    orderBy: [
      { warStartTime: "desc" },
      { syncFetchedAt: "desc" },
      { updatedAt: "desc" },
    ],
  });
  if (!row) return null;
  return buildPointsSnapshotFromWarScopedSyncRow({
    clanTag: normalizedTag,
    row: {
      warId: row.warId ?? null,
      warStartTime: row.warStartTime,
      syncNum: row.syncNum,
      opponentTag: row.opponentTag,
      clanPoints: row.clanPoints,
      opponentPoints: row.opponentPoints,
      isFwa: row.isFwa ?? null,
      needsValidation: row.needsValidation,
      lastSuccessfulPointsApiFetchAt:
        row.lastSuccessfulPointsApiFetchAt ?? null,
      syncFetchedAt: row.syncFetchedAt,
    },
  });
}

async function getClanPointsCached(
  _settings: SettingsService,
  _cocService: CoCService,
  tag: string,
  sourceSync: number | null,
  _warLookupCache?: WarLookupCache,
  options?: ClanPointsFetchOptions,
): Promise<PointsSnapshot> {
  const normalizedTag = normalizeTag(tag);
  const reason = options?.fetchReason ?? "match_render";
  const now = Date.now();
  const cached = pointsSnapshotCache.get(normalizedTag);
  if (cached && cached.expiresAtMs > now) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_snapshot",
      source: "cache_hit",
      detail: `tag=${normalizedTag} reason=${reason}`,
    });
    return applySourceSync(cached.snapshot, sourceSync);
  }

  const warScopedSnapshotRaw = options?.warScopedSnapshot ?? null;
  const requiredOpponentTag = normalizeTag(
    String(options?.requiredOpponentTag ?? ""),
  );
  const warScopedSnapshot =
    warScopedSnapshotRaw &&
    (!requiredOpponentTag ||
      normalizeTag(String(warScopedSnapshotRaw.headerOpponentTag ?? "")) ===
        requiredOpponentTag)
      ? warScopedSnapshotRaw
      : null;
  if (warScopedSnapshot) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_snapshot",
      source: "cache_hit",
      detail: `tag=${normalizedTag} reason=${reason} reuse=war_scoped_persisted`,
    });
    pointsSnapshotCache.set(normalizedTag, {
      snapshot: warScopedSnapshot,
      expiresAtMs: now + POINTS_SNAPSHOT_CACHE_TTL_MS,
    });
    console.info(
      `[points-fetch] source=persisted tag=${normalizedTag} reason=${reason} reuse=war_scoped_persisted`,
    );
    return applySourceSync(warScopedSnapshot, sourceSync);
  }

  const existingPending = pointsSnapshotInFlight.get(normalizedTag);
  if (existingPending) {
    recordFetchEvent({
      namespace: "points",
      operation: "clan_points_snapshot",
      source: "fallback_cache",
      detail: `tag=${normalizedTag} reason=${reason}`,
    });
    const snapshot = await existingPending;
    return applySourceSync(snapshot, sourceSync);
  }

  recordFetchEvent({
    namespace: "points",
    operation: "clan_points_snapshot",
    source: "cache_miss",
    detail: `tag=${normalizedTag} reason=${reason}`,
  });
  const pending = scrapeClanPoints(normalizedTag, reason)
    .then((snapshot) => {
      pointsSnapshotCache.set(normalizedTag, {
        snapshot,
        expiresAtMs: Date.now() + POINTS_SNAPSHOT_CACHE_TTL_MS,
      });
      return snapshot;
    })
    .catch(async (err) => {
      if (!isPointsDirectFetchBlockedError(err)) throw err;

      const staleSnapshot =
        pointsSnapshotCache.get(normalizedTag)?.snapshot ?? null;
      if (staleSnapshot) {
        pointsSnapshotCache.set(normalizedTag, {
          snapshot: staleSnapshot,
          expiresAtMs: Date.now() + POINTS_SNAPSHOT_CACHE_TTL_MS,
        });
        recordFetchEvent({
          namespace: "points",
          operation: "clan_points_snapshot",
          source: "fallback_cache",
          detail: `tag=${normalizedTag} reason=${reason} fallback=stale_cache code=${err.decision.decisionCode}`,
        });
        console.info(
          `[points-lock] fallback_used clan=#${normalizedTag} reason=${reason} fallback=stale_cache code=${err.decision.decisionCode}`,
        );
        return staleSnapshot;
      }

      const persistedSnapshot = await getPersistedPointsSnapshotFallback(
        normalizedTag,
        requiredOpponentTag || null,
      );
      if (persistedSnapshot) {
        pointsSnapshotCache.set(normalizedTag, {
          snapshot: persistedSnapshot,
          expiresAtMs: Date.now() + POINTS_SNAPSHOT_CACHE_TTL_MS,
        });
        recordFetchEvent({
          namespace: "points",
          operation: "clan_points_snapshot",
          source: "fallback_cache",
          detail: `tag=${normalizedTag} reason=${reason} fallback=persisted_sync code=${err.decision.decisionCode}`,
        });
        console.info(
          `[points-lock] fallback_used clan=#${normalizedTag} reason=${reason} fallback=persisted_sync code=${err.decision.decisionCode}`,
        );
        return persistedSnapshot;
      }

      console.info(
        `[points-lock] fallback_miss clan=#${normalizedTag} reason=${reason} code=${err.decision.decisionCode}`,
      );
      throw err;
    })
    .finally(() => {
      pointsSnapshotInFlight.delete(normalizedTag);
    });
  pointsSnapshotInFlight.set(normalizedTag, pending);
  let snapshot = await pending;
  const fallbackTrackedClanTag = normalizeTag(
    String(options?.fallbackTrackedClanTag ?? ""),
  );
  if (
    snapshot.notFound &&
    fallbackTrackedClanTag &&
    fallbackTrackedClanTag !== normalizedTag
  ) {
    const trackedSnapshot = await getClanPointsCached(
      _settings,
      _cocService,
      fallbackTrackedClanTag,
      sourceSync,
      _warLookupCache,
      {
        fetchReason: reason,
      },
    ).catch(() => null);
    const fallback = buildOpponentSnapshotFromTrackedClanFallback({
      requestedOpponentTag: normalizedTag,
      trackedClanTag: fallbackTrackedClanTag,
      trackedSnapshot,
    });
    console.info(
      `[fwa-points-fallback] path=tracked_clan_page requested=#${normalizedTag} tracked=#${fallbackTrackedClanTag} extracted_opponent=${fallback.extractedOpponentTag ? `#${fallback.extractedOpponentTag}` : "unknown"} current=${fallback.currentForWar ? "1" : "0"} applied=${fallback.snapshot ? "1" : "0"}`,
    );
    if (fallback.snapshot) {
      snapshot = fallback.snapshot;
      pointsSnapshotCache.set(normalizedTag, {
        snapshot,
        expiresAtMs: Date.now() + POINTS_SNAPSHOT_CACHE_TTL_MS,
      });
      recordFetchEvent({
        namespace: "points",
        operation: "clan_points_snapshot",
        source: "fallback_cache",
        detail: `tag=${normalizedTag} reason=${reason} fallback=tracked_clan_page current=1`,
      });
    } else {
      recordFetchEvent({
        namespace: "points",
        operation: "clan_points_snapshot",
        source: "fallback_cache",
        detail: `tag=${normalizedTag} reason=${reason} fallback=tracked_clan_page current=0`,
      });
    }
  }
  return applySourceSync(snapshot, sourceSync);
}

export async function getPointsSnapshotForClan(
  cocService: CoCService,
  tag: string,
): Promise<PointsSnapshot> {
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, null);
  return getClanPointsCached(settings, cocService, tag, sourceSync);
}

function deriveProjectedOutcome(
  clanTag: string,
  opponentTag: string,
  clanPoints: number | null,
  opponentPoints: number | null,
  syncNumber: number | null,
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

async function _buildLastWarMatchOverview(
  clanTag: string,
  guildId: string | null,
  previousSync: number | null,
): Promise<string | null> {
  const normalizedTag = normalizeTag(clanTag);
  const lastWar = await prisma.warAttacks.findFirst({
    where: {
      clanTag: `#${normalizedTag}`,
      warEndTime: { not: null },
      attackOrder: 0,
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

  const participants = await prisma.warAttacks.findMany({
    where: {
      clanTag: `#${normalizedTag}`,
      warStartTime: lastWar.warStartTime,
      attackOrder: 0,
    },
    select: { attacksUsed: true },
  });

  const missedHits = participants.reduce((sum, p) => {
    const used = Math.max(0, Math.min(2, Number(p.attacksUsed ?? 0)));
    return sum + (2 - used);
  }, 0);
  const missedBoth = participants.filter(
    (p) => Number(p.attacksUsed ?? 0) <= 0,
  ).length;

  const starsRow = await prisma.$queryRaw<Array<{ stars: number }>>`
    SELECT COALESCE(SUM("trueStars"), 0)::int AS "stars"
    FROM "WarAttacks"
    WHERE "clanTag" = ${`#${normalizedTag}`} AND "warStartTime" = ${lastWar.warStartTime}
  `;
  const clanStarsTracked = Number(starsRow[0]?.stars ?? 0);

  const sub = await prisma.currentWar.findFirst({
    where: {
      clanTag: `#${normalizedTag}`,
      ...(guildId ? { guildId } : {}),
    },
    select: {
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      clanStars: true,
      opponentStars: true,
      warStartFwaPoints: true,
      warEndFwaPoints: true,
    },
  });

  const clanStars = sub?.clanStars ?? clanStarsTracked;
  const opponentStars = sub?.opponentStars ?? null;
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
  const opponentName =
    sanitizeClanName(lastWar.opponentClanName) ?? "Unknown Opponent";
  const opponentTag = normalizeTag(lastWar.opponentClanTag ?? "");

  return limitDiscordContent(
    [
      `Match overview for Sync ${syncLabel}`,
      `${clanName} (#${normalizedTag}) vs ${opponentName}${opponentTag ? ` (#${opponentTag})` : ""}`,
      `Match type: **${formatMatchTypeLabel(
        (sub?.matchType ?? "UNKNOWN") as "FWA" | "BL" | "MM" | "UNKNOWN",
        Boolean(sub?.inferredMatchType),
      )}**`,
      `Expected outcome: **${sub?.outcome ?? "UNKNOWN"}**`,
      `Actual outcome: **${actualOutcome}**`,
      `Total stars: ${clanName} ${clanStars} - ${opponentName} ${opponentStars ?? "unknown"}`,
      `Missed hits (${clanName}): ${missedHits}`,
      `Members missed both hits (${clanName}): ${missedBoth}`,
      `FWA points gained (${clanName}): ${pointsDelta === null ? "unknown" : pointsDelta >= 0 ? `+${pointsDelta}` : String(pointsDelta)}`,
    ].join("\n"),
  );
}

async function buildTrackedMatchOverview(
  cocService: CoCService,
  sourceSync: number | null,
  guildId: string | null,
  warLookupCache?: WarLookupCache,
  client?: Client | null,
  options?: {
    onlyClanTags?: string[];
    includeActualSheet?: boolean;
    mailStatusDebugEnabled?: boolean;
    revisionDraftByTag?: Record<string, MatchRevisionFields>;
  },
): Promise<{
  embed: EmbedBuilder;
  copyText: string;
  singleViews: Record<string, MatchView>;
}> {
  const settings = new SettingsService();
  const includeActualSheet = options?.includeActualSheet ?? true;
  const mailStatusDebugEnabled = options?.mailStatusDebugEnabled ?? false;
  const revisionDraftByTag = options?.revisionDraftByTag ?? {};
  const scopedTagSet =
    options?.onlyClanTags && options.onlyClanTags.length > 0
      ? new Set(options.onlyClanTags.map((tag) => normalizeTag(tag)))
      : null;
  const actualByTag = includeActualSheet
    ? await getActualSheetSnapshotCached(settings).catch(
        () => new Map<string, ActualSheetClanSnapshot>(),
      )
    : new Map<string, ActualSheetClanSnapshot>();
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, mailChannelId: true, mailConfig: true },
  });
  const scopedTracked = scopedTagSet
    ? tracked.filter((clan) => scopedTagSet.has(normalizeTag(clan.tag)))
    : tracked;
  const mailChannelByTag = new Map(
    scopedTracked.map((row) => [
      normalizeTag(row.tag),
      row.mailChannelId ?? null,
    ]),
  );
  const mailConfigByTag = new Map(
    scopedTracked.map((row) => [
      normalizeTag(row.tag),
      parseMatchMailConfig(
        row.mailConfig as Prisma.JsonValue | null | undefined,
      ),
    ]),
  );
  if (scopedTracked.length === 0) {
    return {
      embed: new EmbedBuilder()
        .setTitle("FWA Match Overview")
        .setDescription(
          "No tracked clans configured. Use `/tracked-clan configure` first.",
        ),
      copyText:
        "No tracked clans configured. Use `/tracked-clan configure` first.",
      singleViews: {},
    };
  }

  const subscriptions = await prisma.currentWar.findMany({
    where: guildId ? { guildId } : undefined,
    select: {
      clanTag: true,
      warId: true,
      startTime: true,
      opponentTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      fwaPoints: true,
      opponentFwaPoints: true,
    },
  });
  const subByTag = new Map(
    subscriptions.map((s) => [normalizeTag(s.clanTag), s]),
  );
  const subscriptionWarIds = [
    ...new Set(
      subscriptions
        .map((sub) =>
          sub.warId !== null &&
          sub.warId !== undefined &&
          Number.isFinite(sub.warId)
            ? String(Math.trunc(sub.warId))
            : null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const subscriptionWarStarts = [
    ...new Set(
      subscriptions
        .map((sub) =>
          sub.startTime instanceof Date ? sub.startTime.toISOString() : null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ].map((iso) => new Date(iso));
  const scopedTrackedTags = scopedTracked.map(
    (clan) => `#${normalizeTag(clan.tag)}`,
  );
  const reuseIdentityFilters = [
    subscriptionWarIds.length > 0
      ? { warId: { in: subscriptionWarIds } }
      : null,
    subscriptionWarStarts.length > 0
      ? { warStartTime: { in: subscriptionWarStarts } }
      : null,
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== null);
  const warScopedSyncRows =
    guildId && scopedTrackedTags.length > 0 && reuseIdentityFilters.length > 0
      ? await prisma.clanPointsSync.findMany({
          where: {
            guildId,
            clanTag: { in: scopedTrackedTags },
            needsValidation: false,
            OR: reuseIdentityFilters,
          },
          select: {
            clanTag: true,
            warId: true,
            warStartTime: true,
            syncNum: true,
            opponentTag: true,
            clanPoints: true,
            opponentPoints: true,
            isFwa: true,
            needsValidation: true,
            lastSuccessfulPointsApiFetchAt: true,
            syncFetchedAt: true,
          },
          orderBy: [
            { warStartTime: "desc" },
            { syncFetchedAt: "desc" },
            { updatedAt: "desc" },
          ],
        })
      : [];
  const warScopedSyncRowsByClanTag =
    groupWarScopedSyncRowsByClanTag(warScopedSyncRows);

  const warByClanTag = new Map<string, CurrentWarResult | null>();
  const warStateByClanTag = new Map<string, WarStateForSync>();
  const warStartMsByClanTag = new Map<string, number | null>();
  const activeWarStarts: number[] = [];

  await Promise.all(
    scopedTracked.map(async (clan) => {
      const clanTag = normalizeTag(clan.tag);
      const war = await getCurrentWarCached(
        cocService,
        clanTag,
        warLookupCache,
      ).catch(() => null);
      const warState = deriveWarState(war?.state);
      const warStartMs = parseCocApiTime(war?.startTime);
      warByClanTag.set(clanTag, war);
      warStateByClanTag.set(clanTag, warState);
      warStartMsByClanTag.set(clanTag, warStartMs);
      if (
        warState !== "notInWar" &&
        warStartMs !== null &&
        Number.isFinite(warStartMs)
      ) {
        activeWarStarts.push(warStartMs);
      }
    }),
  );
  const baselineWarStartMs =
    activeWarStarts.length > 0 ? Math.min(...activeWarStarts) : null;
  const nowMs = Date.now();
  const missedSyncTags = new Set<string>();
  for (const clan of scopedTracked) {
    const clanTag = normalizeTag(clan.tag);
    const clanWarState = warStateByClanTag.get(clanTag) ?? "notInWar";
    const clanWarStartMs = warStartMsByClanTag.get(clanTag) ?? null;
    if (
      isMissedSyncClan({
        baselineWarStartMs,
        clanWarState,
        clanWarStartMs,
        nowMs,
      })
    ) {
      missedSyncTags.add(clanTag);
    }
  }
  const includedTracked = scopedTracked.filter(
    (clan) => !missedSyncTags.has(normalizeTag(clan.tag)),
  );
  const embed = new EmbedBuilder().setTitle(
    `FWA Match Overview (${includedTracked.length})`,
  );
  const copyLines: string[] = [];
  const singleViews: Record<string, MatchView> = {};
  let hasAnyInferredMatchType = false;
  let syncActionAvailableCount = 0;
  const sourceOfTruthSyncLine = `Sync#: ${
    sourceSync !== null && Number.isFinite(sourceSync)
      ? `#${Math.trunc(sourceSync) + 1}`
      : "unknown"
  }`;

  for (const clan of scopedTracked) {
    const clanTag = normalizeTag(clan.tag);
    const includeInOverview = !missedSyncTags.has(clanTag);
    const clanName = sanitizeClanName(clan.name) ?? `#${clanTag}`;
    const war = warByClanTag.get(clanTag) ?? null;
    const warState =
      warStateByClanTag.get(clanTag) ?? deriveWarState(war?.state);
    const clanSyncLine = withSyncModeLabel(
      getSyncDisplay(sourceSync, warState),
      sourceSync,
    );
    const clanWarStateLine = formatWarStateLabel(warState);
    const clanTimeRemainingLine = getWarStateRemaining(war, warState);
    const sub = subByTag.get(clanTag);
    if (warState === "notInWar") {
      const preWarMailStatus = await resolveLiveWarMailStatus({
        client: client ?? null,
        guildId,
        tag: clanTag,
        warId: sub?.warId ?? null,
        emitDebugLog: mailStatusDebugEnabled,
      });
      const mailStatusEmoji = preWarMailStatus.mailStatusEmoji;
      const preWarMailDebugLines = mailStatusDebugEnabled
        ? buildMailStatusDebugLines(preWarMailStatus.debug)
        : [];
      const clanProfile = await cocService
        .getClan(`#${clanTag}`)
        .catch(() => null);
      const memberCount = Number.isFinite(Number(clanProfile?.members))
        ? Number(clanProfile?.members)
        : null;
      const livePoints = await getClanPointsCached(
        settings,
        cocService,
        clanTag,
        sourceSync,
        warLookupCache,
      ).catch(() => null);
      const clanPoints = livePoints?.balance ?? sub?.fwaPoints ?? null;
      const outOfSync =
        sub?.fwaPoints !== null &&
        sub?.fwaPoints !== undefined &&
        livePoints?.balance !== null &&
        livePoints?.balance !== undefined &&
        Number(sub.fwaPoints) !== Number(livePoints.balance);
      const actual = actualByTag.get(clanTag) ?? null;
      const preWarHeader = `${mailStatusEmoji} | ${clanName} (#${clanTag})`;
      const preWarLines = [
        outOfSync
          ? ":warning: out of sync with points site"
          : ":white_check_mark: data in sync with points site",
        `Clan points: **${clanPoints !== null && clanPoints !== undefined ? clanPoints : "unknown"}**`,
        `Members: **${memberCount ?? "?"}/50**`,
        `Total weight (ACTUAL): **${actual?.totalWeight ?? "unknown"}**`,
        `Weight compo (ACTUAL): ${actual?.weightCompo ?? "unknown"}`,
        `Weight deltas (ACTUAL): ${actual?.weightDeltas ?? "unknown"}`,
        `Compo advice (ACTUAL): ${actual?.compoAdvice ?? "none"}`,
        `War State: **${clanWarStateLine}**`,
        `Time Remaining: **${clanTimeRemainingLine}**`,
        `Sync: **${clanSyncLine}**`,
        formatMailLifecycleStatusLine(preWarMailStatus.status),
        ...preWarMailDebugLines,
      ];
      if (includeInOverview) {
        embed.addFields({
          name: preWarHeader,
          value: preWarLines.join("\n"),
          inline: false,
        });
        copyLines.push(
          `## ${preWarHeader}`,
          outOfSync
            ? "WARNING: out of sync with points site"
            : "Data in sync with points site",
          `Clan points: ${clanPoints !== null && clanPoints !== undefined ? clanPoints : "unknown"}`,
          `Members: ${memberCount ?? "?"}/50`,
          `Total weight (ACTUAL): ${actual?.totalWeight ?? "unknown"}`,
          `Weight compo (ACTUAL): ${actual?.weightCompo ?? "unknown"}`,
          `Weight deltas (ACTUAL): ${actual?.weightDeltas ?? "unknown"}`,
          `Compo advice (ACTUAL): ${actual?.compoAdvice ?? "none"}`,
          `War State: ${clanWarStateLine}`,
          `Time Remaining: ${clanTimeRemainingLine}`,
          `Sync: ${clanSyncLine}`,
          ...preWarMailDebugLines,
        );
      }
      singleViews[clanTag] = {
        embed: new EmbedBuilder()
          .setTitle(preWarHeader)
          .setDescription(preWarLines.join("\n"))
          .setColor(
            resolveSingleClanMatchEmbedColor({
              effectiveMatchType:
                (sub?.matchType as
                  | "FWA"
                  | "BL"
                  | "MM"
                  | "SKIP"
                  | "UNKNOWN"
                  | null
                  | undefined) ?? "UNKNOWN",
              effectiveExpectedOutcome: null,
            }),
          ),
        copyText: limitDiscordContent(
          [`# ${preWarHeader}`, ...preWarLines].join("\n"),
        ),
        matchTypeAction: null,
        matchTypeCurrent:
          (sub?.matchType as "FWA" | "BL" | "MM" | "SKIP" | null | undefined) ??
          null,
        inferredMatchType: false,
        outcomeAction: null,
        syncAction: null,
        clanName,
        clanTag,
        mailStatusEmoji,
        skipSyncAction: sub?.matchType === "SKIP" ? null : { tag: clanTag },
        undoSkipSyncAction: sub?.matchType === "SKIP" ? { tag: clanTag } : null,
      };
      continue;
    }

    const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
    const opponentName =
      sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
    const fallbackResolution = await resolveMatchTypeWithFallback({
      guildId,
      clanTag,
      opponentTag,
      warState,
      warId: sub?.warId ?? null,
      warStartTime: getWarStartDateForSync(sub?.startTime ?? null, war),
      existingMatchType: sub?.matchType ?? null,
      existingInferredMatchType: sub?.inferredMatchType ?? null,
    });

    if (!opponentTag) {
      const noOpponentMailStatus = await resolveLiveWarMailStatus({
        client: client ?? null,
        guildId,
        tag: clanTag,
        warId: sub?.warId ?? null,
        emitDebugLog: mailStatusDebugEnabled,
      });
      const mailStatusEmoji = noOpponentMailStatus.mailStatusEmoji;
      const noOpponentMailDebugLines = mailStatusDebugEnabled
        ? buildMailStatusDebugLines(noOpponentMailStatus.debug)
        : [];
      const noOpponentHeader = `${mailStatusEmoji} | ${clanName} (#${clanTag}) vs Unknown`;
      const noOpponentLines = [
        "No active war opponent",
        `War State: **${clanWarStateLine}**`,
        `Time Remaining: **${clanTimeRemainingLine}**`,
        `Sync: **${clanSyncLine}**`,
        formatMailLifecycleStatusLine(noOpponentMailStatus.status),
        ...noOpponentMailDebugLines,
      ];
      if (includeInOverview) {
        embed.addFields({
          name: noOpponentHeader,
          value: noOpponentLines.join("\n"),
          inline: false,
        });
        copyLines.push(
          `## ${noOpponentHeader}`,
          ...noOpponentLines.map((line) => line.replace(/\*\*/g, "")),
        );
      }
      singleViews[clanTag] = {
        embed: new EmbedBuilder()
          .setTitle(noOpponentHeader)
          .setDescription(noOpponentLines.join("\n"))
          .setColor(
            resolveSingleClanMatchEmbedColor({
              effectiveMatchType:
                (sub?.matchType as
                  | "FWA"
                  | "BL"
                  | "MM"
                  | "SKIP"
                  | "UNKNOWN"
                  | null
                  | undefined) ?? "UNKNOWN",
              effectiveExpectedOutcome: null,
            }),
          ),
        copyText: limitDiscordContent(
          [`# ${noOpponentHeader}`, ...noOpponentLines].join("\n"),
        ),
        matchTypeAction: null,
        matchTypeCurrent:
          (sub?.matchType as "FWA" | "BL" | "MM" | "SKIP" | null | undefined) ??
          null,
        inferredMatchType: false,
        outcomeAction: null,
        syncAction: null,
        clanName,
        clanTag,
        mailStatusEmoji,
        mailAction: {
          tag: clanTag,
          enabled: false,
          reason: "No active war opponent.",
        },
        skipSyncAction: sub?.matchType === "SKIP" ? null : { tag: clanTag },
        undoSkipSyncAction: sub?.matchType === "SKIP" ? { tag: clanTag } : null,
      };
      continue;
    }

    const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
    const warIdForReuse =
      sub?.warId !== null &&
      sub?.warId !== undefined &&
      Number.isFinite(sub?.warId)
        ? String(Math.trunc(sub.warId))
        : null;
    const warStartTimeForReuse = getWarStartDateForSync(
      sub?.startTime ?? null,
      war,
    );
    const warScopedSnapshot = resolveWarScopedSnapshotForMatch({
      rows: warScopedSyncRowsByClanTag.get(clanTag) ?? [],
      clanTag,
      warId: warIdForReuse,
      warStartTime: warStartTimeForReuse,
      opponentTag,
      currentSyncNumber: currentSync,
      sourceSyncNumber: sourceSync,
    });
    const primaryPoints = await getClanPointsCached(
      settings,
      cocService,
      clanTag,
      currentSync,
      warLookupCache,
      {
        requiredOpponentTag: opponentTag,
        fetchReason: "match_render",
        warScopedSnapshot,
      },
    ).catch(() => null);
    let opponentPoints: PointsSnapshot | null = null;
    if (primaryPoints) {
      const siteUpdated = isPointsSiteUpdatedForOpponent(
        primaryPoints,
        opponentTag,
        sourceSync,
      );
      const opponentFromPrimary = siteUpdated
        ? deriveOpponentBalanceFromPrimarySnapshot(
            primaryPoints,
            clanTag,
            opponentTag,
          )
        : null;
      if (opponentFromPrimary !== null && !Number.isNaN(opponentFromPrimary)) {
        opponentPoints = {
          ...primaryPoints,
          tag: opponentTag,
          balance: opponentFromPrimary,
          clanName: opponentName,
          activeFwa: null,
          winnerBoxHasTag: true,
        };
      }
    }
    const needsLiveOpponentResolution =
      fallbackResolution.confirmedCurrent === null;
    if (!opponentPoints || needsLiveOpponentResolution) {
      opponentPoints = await getClanPointsCached(
        settings,
        cocService,
        opponentTag,
        currentSync,
        warLookupCache,
        {
          fetchReason: "match_render",
          fallbackTrackedClanTag: clanTag,
        },
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
    const siteSyncObservedForWrite = resolveObservedSyncNumberForMatchup({
      primarySnapshot: primaryPoints,
      opponentSnapshot: opponentPoints,
    });
    const siteUpdatedFromPrimaryEvidence = Boolean(
      primaryPoints &&
      isPointsSiteUpdatedForOpponent(primaryPoints, opponentTag, sourceSync),
    );
    const siteUpdatedForAlert = isPointsValidationCurrentForMatchup({
      primarySnapshot: primaryPoints,
      opponentSnapshot: opponentPoints,
      opponentTag,
      sourceSync,
    });
    if (
      siteUpdatedForAlert &&
      !siteUpdatedFromPrimaryEvidence &&
      opponentPoints?.snapshotSource === "tracked_clan_fallback"
    ) {
      console.info(
        `[fwa-sync-validation] stage=alliance_view proof=tracked_fallback clan=#${clanTag} opponent=#${opponentTag} sync=${siteSyncObservedForWrite ?? "unknown"}`,
      );
    }
    const winnerBoxNotMarkedFwa = hasWinnerBoxNotMarkedFwaSignal(
      primaryPoints?.winnerBoxText ?? null,
    );
    const strongOpponentEvidencePresent =
      opponentPoints?.notFound === true ||
      opponentPoints?.activeFwa === true ||
      opponentPoints?.activeFwa === false;
    const activeWarInference = buildActiveWarMatchInferenceOptions({
      warState,
      clanAttacksUsed: war?.clan?.attacks ?? null,
      clanStars: war?.clan?.stars ?? null,
      opponentStars: war?.opponent?.stars ?? null,
    });
    const inferredFromPointsType = inferMatchTypeFromPointsSnapshots(
      primaryPoints,
      opponentPoints,
      {
        winnerBoxNotMarkedFwa,
        opponentEvidenceMissingOrNotCurrent:
          !siteUpdatedForAlert || !strongOpponentEvidencePresent,
        ...activeWarInference,
      },
    );
    const pointsResolution = toMatchTypeResolutionFromPointsInference(
      inferredFromPointsType,
    );
    const guardedFallbackResolution =
      applyExplicitOpponentNotFoundFallbackGuard({
        fallbackResolution,
        opponentNotFoundExplicitly: opponentPoints?.notFound === true,
        hasSameWarExplicitFwaConfirmation: hasSameWarExplicitFwaConfirmation({
          fallbackResolution,
          currentWarStartTime: sub?.startTime ?? null,
          currentWarOpponentTag: sub?.opponentTag ?? null,
          activeWarStartTime: getWarStartDateForSync(null, war),
          activeOpponentTag: opponentTag,
        }),
      });
    const appliedResolution = chooseMatchTypeResolution({
      confirmedCurrent: guardedFallbackResolution.confirmedCurrent,
      liveOpponent: pointsResolution,
      storedSync: guardedFallbackResolution.storedSync,
      unconfirmedCurrent: guardedFallbackResolution.unconfirmedCurrent,
    });
    if (!appliedResolution) {
      continue;
    }
    const matchType = appliedResolution.matchType;
    const inferredMatchType = appliedResolution.inferred;
    const syncIsFwaSignal =
      appliedResolution.syncIsFwa ??
      (matchType === "FWA" ? true : matchType === "BL" ? false : false);
    logMatchTypeResolution({
      stage: "alliance_view",
      clanTag,
      opponentTag,
      warId: sub?.warId ?? null,
      source: appliedResolution.source,
      matchType: appliedResolution.matchType,
      inferred: appliedResolution.inferred,
      confirmed: appliedResolution.confirmed,
    });
    console.info(
      `[fwa-matchtype] stage=alliance_view_active_fwa clan=#${clanTag} opponent=#${opponentTag} parsed_active_fwa=${opponentPoints?.activeFwa === null || opponentPoints?.activeFwa === undefined ? "unknown" : opponentPoints.activeFwa ? "yes" : "no"} not_found=${opponentPoints?.notFound ? "1" : "0"} source=${appliedResolution.source} sync_is_fwa=${syncIsFwaSignal ? "1" : "0"}`,
    );
    const derivedOutcome = deriveProjectedOutcome(
      clanTag,
      opponentTag,
      primaryPoints?.balance ?? null,
      opponentPoints?.balance ?? null,
      currentSync,
    );
    const liveExpectedOutcome =
      (sub?.outcome as "WIN" | "LOSE" | null | undefined) ??
      (matchType === "FWA" ? derivedOutcome : null);
    if (guildId) {
      await prisma.currentWar.upsert({
        where: {
          clanTag_guildId: {
            guildId,
            clanTag: `#${clanTag}`,
          },
        },
        create: {
          guildId,
          clanTag: `#${clanTag}`,
          notify: false,
          channelId: "",
          matchType: matchType,
          inferredMatchType,
          fwaPoints:
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null &&
            opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: liveExpectedOutcome,
          warStartFwaPoints:
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          warEndFwaPoints: null,
        },
        update: {
          matchType: matchType,
          inferredMatchType,
          fwaPoints:
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          opponentFwaPoints:
            opponentPoints?.balance !== null &&
            opponentPoints?.balance !== undefined
              ? opponentPoints.balance
              : null,
          outcome: liveExpectedOutcome,
          warStartFwaPoints:
            primaryPoints?.balance !== null &&
            primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
          warEndFwaPoints: undefined,
        },
      });
    }
    const pointsLine =
      hasPrimaryPoints && hasOpponentPoints
        ? `Points: ${primaryPoints.balance} - ${opponentPoints!.balance}`
        : "Points: unavailable";
    const verifyLink = `[cc:${opponentTag}](${buildCcVerifyUrl(opponentTag)})`;
    const warStartTimeForSync = warStartTimeForReuse;
    await persistClanPointsSyncIfCurrent({
      guildId,
      clanTag,
      warId: sub?.warId ?? null,
      warStartTime: warStartTimeForSync,
      siteCurrent: siteUpdatedForAlert,
      syncNum: siteSyncObservedForWrite,
      opponentTag,
      clanPoints: primaryPoints?.balance ?? null,
      opponentPoints: opponentPoints?.balance ?? null,
      outcome: derivedOutcome,
      isFwa: syncIsFwaSignal,
      fetchedAtMs: primaryPoints?.fetchedAtMs ?? null,
      fetchReason: "match_render",
      matchType,
      opponentNotFound: opponentPoints?.notFound ?? false,
    });
    const syncRow = await pointsSyncService.getCurrentSyncForClan({
      guildId: guildId ?? "",
      clanTag,
      warId:
        sub?.warId !== null &&
        sub?.warId !== undefined &&
        Number.isFinite(sub?.warId)
          ? String(Math.trunc(sub.warId))
          : null,
      warStartTime: warStartTimeForSync,
    });
    const primaryMismatch = siteUpdatedForAlert
      ? buildPointsMismatchWarning(
          clanName,
          sub?.fwaPoints ?? null,
          primaryPoints?.balance ?? null,
        )
      : null;
    const opponentMismatch = siteUpdatedForAlert
      ? buildPointsMismatchWarning(
          opponentName,
          sub?.opponentFwaPoints ?? null,
          opponentPoints?.balance ?? null,
        )
      : null;
    const siteSyncObserved = resolveObservedSyncNumberForMatchup({
      primarySnapshot: primaryPoints,
      opponentSnapshot: opponentPoints,
    });
    const syncMismatch = siteUpdatedForAlert
      ? buildSyncMismatchWarning(currentSync, siteSyncObserved)
      : null;
    const siteMatchType: "FWA" | "BL" | "MM" | null =
      inferredFromPointsType &&
      (inferredFromPointsType.matchType === "FWA" ||
        inferredFromPointsType.matchType === "BL" ||
        inferredFromPointsType.matchType === "MM")
        ? inferredFromPointsType.matchType
        : null;
    const singleClanLinks = buildSingleClanMatchLinks({
      trackedClanTag: clanTag,
      opponentTag,
    });
    const mailChannelId = mailChannelByTag.get(clanTag) ?? null;
    const liveMailStatus = await resolveLiveWarMailStatus({
      client: client ?? null,
      guildId,
      tag: clanTag,
      warId: sub?.warId ?? null,
      emitDebugLog: mailStatusDebugEnabled,
    });
    const revisionWarId =
      normalizeWarIdText(sub?.warId ?? null) ??
      normalizeWarIdText(liveMailStatus.debug.currentWarId);
    const liveRevisionFields = buildLiveRevisionFields({
      warId: revisionWarId,
      opponentTag,
      matchType:
        matchType === "FWA" || matchType === "BL" || matchType === "MM"
          ? matchType
          : "UNKNOWN",
      expectedOutcome:
        matchType === "FWA" ? (liveExpectedOutcome ?? "UNKNOWN") : null,
    });
    const confirmedRevisionBaseline = resolveConfirmedRevisionBaseline({
      syncRow: syncRow
        ? {
            warId: syncRow.warId ?? null,
            opponentTag: syncRow.opponentTag,
            lastKnownMatchType: syncRow.lastKnownMatchType ?? null,
            lastKnownOutcome: syncRow.lastKnownOutcome ?? null,
            isFwa: syncRow.isFwa ?? null,
            confirmedByClanMail: Boolean(syncRow.confirmedByClanMail),
          }
        : null,
      mailConfig: {
        lastWarId: mailConfigByTag.get(clanTag)?.lastWarId ?? null,
        lastOpponentTag: mailConfigByTag.get(clanTag)?.lastOpponentTag ?? null,
        lastMatchType: mailConfigByTag.get(clanTag)?.lastMatchType ?? null,
        lastExpectedOutcome:
          mailConfigByTag.get(clanTag)?.lastExpectedOutcome ?? null,
      },
      liveFields: liveRevisionFields,
      lifecycleStatus: liveMailStatus.status,
    });
    console.info(
      `[fwa-mail-baseline] stage=alliance_view clan=#${clanTag} owner=${confirmedRevisionBaseline ? "ClanPointsSync" : "none"} lifecycle=${liveMailStatus.status} war_id=${revisionWarId ?? "unknown"} opponent=#${opponentTag}`,
    );
    if (
      confirmedRevisionBaseline &&
      liveRevisionFields &&
      !areRevisionFieldsEqual(confirmedRevisionBaseline, liveRevisionFields)
    ) {
      console.info(
        `[fwa-mail-baseline] stage=alliance_view mismatch=1 clan=#${clanTag} baseline_match_type=${confirmedRevisionBaseline.matchType} live_match_type=${liveRevisionFields.matchType} baseline_outcome=${confirmedRevisionBaseline.expectedOutcome ?? "N/A"} live_outcome=${liveRevisionFields.expectedOutcome ?? "N/A"}`,
      );
    }
    const revisionState = resolveEffectiveRevisionState({
      liveFields: liveRevisionFields,
      confirmedBaseline: confirmedRevisionBaseline,
      draft: revisionDraftByTag[clanTag] ?? null,
    });
    const effectiveMatchType =
      revisionState.effective?.matchType === "FWA" ||
      revisionState.effective?.matchType === "BL" ||
      revisionState.effective?.matchType === "MM"
        ? revisionState.effective.matchType
        : matchType;
    const projectedFwaOutcome =
      toWinLoseOutcome(liveExpectedOutcome) ?? toWinLoseOutcome(derivedOutcome);
    const effectiveExpectedOutcome = resolveEffectiveFwaOutcome({
      matchType: effectiveMatchType,
      explicitOutcome: revisionState.effective?.expectedOutcome ?? null,
      projectedOutcome: projectedFwaOutcome,
    });
    const validationState = buildSyncValidationState({
      syncRow,
      currentWarId: sub?.warId ?? null,
      currentWarStartTime: warStartTimeForSync,
      siteCurrent: siteUpdatedForAlert,
      syncNum: siteSyncObservedForWrite,
      opponentTag,
      clanPoints: primaryPoints?.balance ?? null,
      opponentPoints: opponentPoints?.balance ?? null,
      outcome: derivedOutcome,
      isFwa: syncIsFwaSignal,
      effectiveMatchType,
      effectiveExpectedOutcome,
      opponentNotFound: opponentPoints?.notFound ?? false,
    });
    const pointsSyncStatus = validationState.statusLine;
    const storedSyncSummary = buildStoredSyncSummary({
      syncRow,
      fallbackSyncNum: siteSyncObservedForWrite,
      warId: sub?.warId ?? null,
      warStartTime: warStartTimeForSync,
      opponentNotFound: opponentPoints?.notFound ?? false,
      validationState,
    });
    const opponentActiveFwaEvidence = resolveOpponentActiveFwaEvidence({
      opponentActiveFwa: opponentPoints?.activeFwa,
      opponentNotFound: opponentPoints?.notFound ?? false,
      resolutionSource: appliedResolution.source,
    });
    const effectiveMismatchWarnings = buildEffectiveMatchMismatchWarnings({
      siteUpdated: siteUpdatedForAlert,
      effectiveMatchType,
      effectiveExpectedOutcome,
      projectedOutcome: derivedOutcome,
      opponentActiveFwaEvidence,
    });
    const validationMismatchLines = storedSyncSummary.stateLine
      ? validationState.differences.join("\n")
      : "";
    const allianceLowConfidenceMismatchEvidence =
      isLowConfidenceAllianceMismatchScenario({
        siteUpdated: siteUpdatedForAlert,
        opponentNotFound: opponentPoints?.notFound ?? false,
        opponentActiveFwaEvidence,
        resolutionSource: appliedResolution.source,
      });
    const isWarChangingState = Boolean(storedSyncSummary.stateLine);
    const mismatchLines = allianceLowConfidenceMismatchEvidence
      ? ""
      : isWarChangingState
        ? validationMismatchLines
        : [
            primaryMismatch,
            opponentMismatch,
            syncMismatch,
            effectiveMismatchWarnings.outcomeMismatch,
            effectiveMismatchWarnings.matchTypeVsFwaMismatch,
            validationMismatchLines,
          ]
            .filter(Boolean)
            .join("\n");
    const hasMismatch = Boolean(
      primaryMismatch ||
      opponentMismatch ||
      syncMismatch ||
      effectiveMismatchWarnings.outcomeMismatch ||
      effectiveMismatchWarnings.matchTypeVsFwaMismatch ||
      validationState.differences.length > 0,
    );
    const effectiveInferredMatchType = shouldDisplayInferredMatchType({
      inferredMatchType,
      appliedDraft: revisionState.appliedDraft,
    });
    if (effectiveInferredMatchType) hasAnyInferredMatchType = true;
    const mailStatusEmoji = liveMailStatus.mailStatusEmoji;
    const mailBlockedReason = getMailBlockedReasonFromRevisionState({
      inferredMatchType: effectiveInferredMatchType,
      hasMailChannel: Boolean(mailChannelId),
      mailStatus: liveMailStatus.status,
      appliedDraft: revisionState.appliedDraft,
      draftDiffersFromBaseline: revisionState.draftDiffersFromBaseline,
      hasConfirmedBaseline: Boolean(confirmedRevisionBaseline),
    });
    const mailBlockedReasonLine = formatMailBlockedReason(mailBlockedReason);
    const mailLifecycleStatusLine = formatMailLifecycleStatusLine(
      liveMailStatus.status,
      {
        hasConfirmedBaseline: Boolean(confirmedRevisionBaseline),
        draftDiffersFromBaseline: revisionState.draftDiffersFromBaseline,
      },
    );
    const mailDebugLines = mailStatusDebugEnabled
      ? buildMailStatusDebugLines(liveMailStatus.debug)
      : [];

    if (effectiveMatchType === "FWA") {
      const warnSuffix = effectiveInferredMatchType
        ? ` :warning: ${verifyLink}`
        : "";
      const matchHeader = buildMatchStatusHeader({
        clanName,
        clanTag,
        opponentName,
        opponentTag,
        matchType: effectiveMatchType,
        outcome: effectiveExpectedOutcome ?? "UNKNOWN",
        mailStatusEmoji,
      });
      if (includeInOverview) {
        embed.addFields({
          name: matchHeader,
          value: [
            pointsLine,
            pointsSyncStatus,
            storedSyncSummary.stateLine,
            mailLifecycleStatusLine,
            `Match Type: **FWA${warnSuffix}**`,
            `Outcome: **${effectiveExpectedOutcome ?? "UNKNOWN"}**`,
            `War State: **${clanWarStateLine}**`,
            `Time Remaining: **${clanTimeRemainingLine}**`,
            mismatchLines,
            ...mailDebugLines,
          ]
            .filter(Boolean)
            .join("\n"),
          inline: false,
        });
        copyLines.push(
          `## ${matchHeader}`,
          `### Opponent Name`,
          `\`${opponentName}\``,
          `### Opponent Tag`,
          `\`${opponentTag}\``,
          `${pointsLine}`,
          pointsSyncStatus,
          storedSyncSummary.stateLine,
          mailLifecycleStatusLine.replace(/\*\*/g, ""),
          `Match Type: FWA${effectiveInferredMatchType ? " :warning:" : ""}`,
          effectiveInferredMatchType
            ? `Verify: ${buildCcVerifyUrl(opponentTag)}`
            : "",
          `Outcome: ${effectiveExpectedOutcome ?? "UNKNOWN"}`,
          `War State: ${clanWarStateLine}`,
          `Time Remaining: ${clanTimeRemainingLine}`,
          mismatchLines,
          ...mailDebugLines,
        );
      }
    } else {
      const warnSuffix = effectiveInferredMatchType
        ? ` :warning: ${verifyLink}`
        : "";
      const matchHeader = buildMatchStatusHeader({
        clanName,
        clanTag,
        opponentName,
        opponentTag,
        matchType: effectiveMatchType,
        outcome: effectiveExpectedOutcome ?? "UNKNOWN",
        mailStatusEmoji,
      });
      if (includeInOverview) {
        embed.addFields({
          name: matchHeader,
          value: [
            pointsSyncStatus,
            storedSyncSummary.stateLine,
            mailLifecycleStatusLine,
            `Match Type: **${effectiveMatchType}${warnSuffix}**`,
            `War State: **${clanWarStateLine}**`,
            `Time Remaining: **${clanTimeRemainingLine}**`,
            mismatchLines,
            ...mailDebugLines,
          ]
            .filter(Boolean)
            .join("\n"),
          inline: false,
        });
        copyLines.push(
          `## ${matchHeader}`,
          `### Opponent Name`,
          `\`${opponentName}\``,
          `### Opponent Tag`,
          `\`${opponentTag}\``,
          pointsSyncStatus,
          storedSyncSummary.stateLine,
          mailLifecycleStatusLine.replace(/\*\*/g, ""),
          `Match Type: ${effectiveMatchType}${effectiveInferredMatchType ? " :warning:" : ""}`,
          effectiveInferredMatchType
            ? `Verify: ${buildCcVerifyUrl(opponentTag)}`
            : "",
          `War State: ${clanWarStateLine}`,
          `Time Remaining: ${clanTimeRemainingLine}`,
          mismatchLines,
          ...mailDebugLines,
        );
      }
    }

    const clanWinnerMarker = getWinnerMarkerForSide(
      effectiveExpectedOutcome ?? null,
      "clan",
    );
    const opponentWinnerMarker = getWinnerMarkerForSide(
      effectiveExpectedOutcome ?? null,
      "opponent",
    );
    const singleDescription = [
      pointsSyncStatus,
      storedSyncSummary.stateLine,
      effectiveInferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
      effectiveInferredMatchType ? "\u200B" : "",
      mailBlockedReasonLine ?? "",
      mailLifecycleStatusLine,
      `Match Type: **${effectiveMatchType}${effectiveInferredMatchType ? " :warning:" : ""}**${
        effectiveInferredMatchType ? ` ${verifyLink}` : ""
      }`,
      effectiveMatchType === "FWA"
        ? `Expected outcome: **${effectiveExpectedOutcome ?? "UNKNOWN"}**`
        : "",
      `War state: **${formatWarStateLabel(warState)}**`,
      `Time remaining: **${getWarStateRemaining(war, warState)}**`,
      `Sync #: **${storedSyncSummary.syncLine}**`,
      storedSyncSummary.updatedLine
        ? `Last points fetch: **${storedSyncSummary.updatedLine}**`
        : "",
      mismatchLines,
      ...mailDebugLines,
    ]
      .filter(Boolean)
      .join("\n");
    const syncActionSiteOutcome = deriveSyncActionSiteOutcome({
      siteMatchType,
      projectedOutcome: derivedOutcome,
    });
    const syncAction: MatchView["syncAction"] =
      siteUpdatedForAlert && hasMismatch
        ? {
            tag: clanTag,
            siteMatchType,
            siteFwaPoints: primaryPoints?.balance ?? null,
            siteOpponentFwaPoints: opponentPoints?.balance ?? null,
            siteOutcome: syncActionSiteOutcome,
            siteSyncNumber: siteSyncObserved,
          }
        : null;
    if (syncAction) syncActionAvailableCount += 1;
    singleViews[clanTag] = {
      embed: new EmbedBuilder()
        .setTitle(
          buildMatchStatusHeader({
            clanName,
            clanTag,
            opponentName,
            opponentTag,
            matchType: effectiveMatchType,
            outcome: effectiveExpectedOutcome ?? "UNKNOWN",
            mailStatusEmoji,
          }),
        )
        .setDescription(singleDescription)
        .setColor(
          resolveSingleClanMatchEmbedColor({
            effectiveMatchType,
            effectiveExpectedOutcome,
          }),
        )
        .addFields(
          {
            name: singleClanLinks.pointsFieldName,
            value:
              effectiveMatchType === "FWA"
                ? hasPrimaryPoints && hasOpponentPoints
                  ? `${clanName}: **${primaryPoints!.balance}**${clanWinnerMarker}\n${opponentName}: **${opponentPoints!.balance}**${opponentWinnerMarker}`
                  : "Unavailable on both clans."
                : hasPrimaryPoints
                  ? `${clanName}: **${primaryPoints!.balance}**`
                  : "Unavailable",
            inline: true,
          },
          {
            name: singleClanLinks.linksFieldName,
            value: singleClanLinks.linksFieldValue,
            inline: true,
          },
        ),
      copyText: limitDiscordContent(
        [
          `# ${buildMatchStatusHeader({
            clanName,
            clanTag,
            opponentName,
            opponentTag,
            matchType: effectiveMatchType,
            outcome: effectiveExpectedOutcome ?? "UNKNOWN",
            mailStatusEmoji,
          })}`,
          effectiveInferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
          pointsSyncStatus,
          storedSyncSummary.stateLine,
          mailLifecycleStatusLine.replace(/\*\*/g, ""),
          `Sync: ${clanSyncLine}`,
          `Sync #: ${storedSyncSummary.syncLine}`,
          storedSyncSummary.updatedLine
            ? `Last points fetch: ${storedSyncSummary.updatedLine}`
            : "",
          `War State: ${clanWarStateLine}`,
          `Time Remaining: ${clanTimeRemainingLine}`,
          `## Opponent Name`,
          `\`${opponentName}\``,
          `## Opponent Tag`,
          `\`${opponentTag}\``,
          ...singleClanLinks.copyLines,
          `## Points`,
          hasPrimaryPoints && hasOpponentPoints
            ? `${clanName}: ${primaryPoints!.balance}${clanWinnerMarker}`
            : "Unavailable",
          effectiveMatchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
            ? `${opponentName}: ${opponentPoints!.balance}${opponentWinnerMarker}`
            : "",
          `## Match Type`,
          `${effectiveMatchType}${effectiveInferredMatchType ? " :warning:" : ""}`,
          effectiveInferredMatchType
            ? `Verify: ${buildCcVerifyUrl(opponentTag)}`
            : "",
          effectiveMatchType === "FWA"
            ? `Expected outcome: ${effectiveExpectedOutcome ?? "UNKNOWN"}`
            : "",
          mismatchLines,
          ...mailDebugLines,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      matchTypeAction:
        effectiveInferredMatchType &&
        (effectiveMatchType === "FWA" ||
          effectiveMatchType === "BL" ||
          effectiveMatchType === "MM")
          ? { tag: clanTag, currentType: effectiveMatchType }
          : null,
      matchTypeCurrent: effectiveMatchType as "FWA" | "BL" | "MM" | "SKIP",
      inferredMatchType: effectiveInferredMatchType,
      outcomeAction:
        effectiveMatchType === "FWA" &&
        (effectiveExpectedOutcome === "WIN" ||
          effectiveExpectedOutcome === "LOSE")
          ? { tag: clanTag, currentOutcome: effectiveExpectedOutcome }
          : null,
      syncAction,
      clanName,
      clanTag,
      mailStatusEmoji,
      lifecycleStatus: liveMailStatus.status,
      hasMailChannel: Boolean(mailChannelId),
      liveRevisionFields,
      confirmedRevisionBaseline,
      effectiveRevisionFields: revisionState.effective,
      appliedDraftRevision: revisionState.appliedDraft,
      draftDiffersFromBaseline: revisionState.draftDiffersFromBaseline,
      projectedFwaOutcome,
      mailAction: {
        tag: clanTag,
        enabled: !mailBlockedReason,
        reason: mailBlockedReason,
      },
    };
  }

  const overviewNotes: string[] = [];
  overviewNotes.push(`Source of truth ${sourceOfTruthSyncLine}`);
  if (hasAnyInferredMatchType) {
    overviewNotes.push(MATCHTYPE_WARNING_LEGEND);
  }
  if (missedSyncTags.size > 0) {
    overviewNotes.push(
      `Ignored missed sync clans: **${missedSyncTags.size}** (started >2h after alliance war start or still no war past 2h).`,
    );
  }
  if (overviewNotes.length > 0) {
    embed.setDescription(overviewNotes.join("\n\n"));
  }
  logFwaMatchTelemetry(
    "overview_built",
    `clans=${includedTracked.length} inferred_match_type=${hasAnyInferredMatchType ? 1 : 0} sync_action_available=${syncActionAvailableCount} missed_sync=${missedSyncTags.size} source_sync=${sourceSync ?? "unknown"}`,
  );

  const copyHeaderLines = [`# FWA Match Overview (${includedTracked.length})`];
  copyHeaderLines.push(`Source of truth ${sourceOfTruthSyncLine}`);
  if (hasAnyInferredMatchType) {
    copyHeaderLines.push(MATCHTYPE_WARNING_LEGEND);
  }
  if (missedSyncTags.size > 0) {
    copyHeaderLines.push(
      `Ignored missed sync clans: ${missedSyncTags.size} (started >2h late or no war after 2h)`,
    );
  }
  const copyHeader = copyHeaderLines.join("\n");
  return {
    embed,
    copyText: buildLimitedMessage(
      copyHeader,
      copyLines.map((l) => `${l}\n`),
      "",
    ),
    singleViews,
  };
}

export async function runForceSyncDataCommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  const visibility =
    interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  const warLookupCache: WarLookupCache = new Map();
  await interaction.deferReply({ ephemeral: !isPublic });

  const rawTag = interaction.options.getString("tag", true);
  const tag = normalizeTag(rawTag);
  const datapoint = interaction.options.getString("datapoint", false) ?? "all";
  const trackedClan = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    await interaction.editReply(`Clan #${tag} is not in tracked clans.`);
    return;
  }

  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(
    settings,
    interaction.guildId ?? null,
  );
  const war = await getCurrentWarCached(cocService, tag, warLookupCache).catch(
    () => null,
  );
  const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
  const fresh = await scrapeClanPoints(tag, "manual_refresh", {
    manualForceBypass: true,
    caller: "command",
  });
  const directOpponentSnapshot = opponentTag
    ? await scrapeClanPoints(opponentTag, "manual_refresh", {
        manualForceBypass: true,
        caller: "command",
      }).catch(() => null)
    : null;
  const matchupEvidence = resolveForceSyncMatchupEvidence({
    trackedClanTag: tag,
    opponentTag,
    sourceSync,
    primarySnapshot: fresh,
    directOpponentSnapshot,
  });
  const opponentSnapshot = matchupEvidence.opponentSnapshot;
  const siteCurrent = matchupEvidence.siteCurrent;
  const siteSyncNum = resolveObservedSyncNumberForMatchup({
    primarySnapshot: fresh,
    opponentSnapshot,
  });
  const opponentBalanceFromSnapshot =
    opponentSnapshot?.balance !== null &&
    opponentSnapshot?.balance !== undefined &&
    Number.isFinite(opponentSnapshot.balance)
      ? Math.trunc(opponentSnapshot.balance)
      : null;
  const opponentBalanceFromPrimary = opponentTag
    ? deriveOpponentBalanceFromPrimarySnapshot(fresh, tag, opponentTag)
    : null;
  const opponentBalance =
    opponentBalanceFromSnapshot ??
    (opponentBalanceFromPrimary !== null &&
    Number.isFinite(opponentBalanceFromPrimary)
      ? Math.trunc(opponentBalanceFromPrimary)
      : null);
  const currentWar = interaction.guildId
    ? await prisma.currentWar.findUnique({
        where: {
          clanTag_guildId: {
            guildId: interaction.guildId,
            clanTag: `#${tag}`,
          },
        },
        select: {
          warId: true,
          startTime: true,
        },
      })
    : null;
  const warStartTimeForSync = getWarStartDateForSync(
    currentWar?.startTime ?? null,
    war,
  );
  const projectedOutcome =
    opponentTag &&
    fresh.balance !== null &&
    Number.isFinite(fresh.balance) &&
    opponentBalance !== null &&
    Number.isFinite(opponentBalance)
      ? deriveProjectedOutcome(
          tag,
          opponentTag,
          fresh.balance,
          opponentBalance,
          siteSyncNum,
        )
      : null;
  const persistenceOutcome = await persistClanPointsSyncIfCurrent({
    guildId: interaction.guildId,
    clanTag: tag,
    warId: currentWar?.warId ?? null,
    warStartTime: warStartTimeForSync,
    siteCurrent,
    syncNum: siteSyncNum,
    opponentTag,
    clanPoints:
      fresh.balance !== null && Number.isFinite(fresh.balance)
        ? Math.trunc(fresh.balance)
        : null,
    opponentPoints: opponentBalance,
    outcome: projectedOutcome,
    isFwa: fresh.activeFwa,
    fetchedAtMs: fresh.fetchedAtMs,
    fetchReason: "manual_refresh",
    opponentNotFound: opponentSnapshot?.notFound ?? false,
  });
  const currentnessLine = !opponentTag
    ? "Current-matchup proof: unavailable (no active war opponent)."
    : siteCurrent
      ? matchupEvidence.usedTrackedFallback &&
        !matchupEvidence.siteCurrentFromPrimary
        ? "Current-matchup proof: established via tracked-clan fallback evidence."
        : matchupEvidence.siteCurrentFromPrimary
          ? "Current-matchup proof: established via primary winner-box evidence."
          : "Current-matchup proof: established via direct opponent evidence."
      : "Current-matchup proof: not established from primary/direct/fallback evidence for the active opponent.";
  const hasWarIdentity =
    (currentWar?.warId !== null &&
      currentWar?.warId !== undefined &&
      Number.isFinite(currentWar.warId)) ||
    warStartTimeForSync instanceof Date;
  const persistenceLine =
    persistenceOutcome === "full"
      ? "ClanPointsSync updated for current war."
      : persistenceOutcome === "checkpoint"
        ? "ClanPointsSync sync checkpoint updated for current war."
        : !interaction.guildId
          ? "ClanPointsSync not updated (server context required)."
          : !siteCurrent
            ? "ClanPointsSync not updated because current-matchup proof is still missing."
            : !hasWarIdentity
              ? "ClanPointsSync not updated because active-war identity could not be resolved."
              : "ClanPointsSync not updated (no eligible same-war row for checkpoint-only write).";

  await interaction.editReply(
    [
      `Forced sync complete for #${tag} (${datapoint === "all" ? "points + syncNum" : datapoint}).`,
      `Point balance: ${
        fresh.balance !== null && Number.isFinite(fresh.balance)
          ? `**${formatPoints(fresh.balance)}**`
          : "unavailable"
      }`,
      `Site sync #: ${siteSyncNum !== null ? `#${siteSyncNum}` : "unknown"}`,
      `Active FWA: ${fresh.activeFwa === null ? "unknown" : fresh.activeFwa ? "YES" : "NO"}`,
      currentnessLine,
      persistenceLine,
    ].join("\n"),
  );
}

export async function runForceSyncMailCommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService,
): Promise<void> {
  const visibility =
    interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  await interaction.deferReply({ ephemeral: !isPublic });

  if (!interaction.guildId) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const tag = normalizeTag(interaction.options.getString("tag", true));
  const messageID = interaction.options.getString("message_id", true).trim();
  const messageTypeRaw = interaction.options.getString("message_type", true);
  const parsedType = parseForceMailMessageType(messageTypeRaw);
  if (!parsedType) {
    await interaction.editReply("Invalid `message_type`.");
    return;
  }
  if (!messageID) {
    await interaction.editReply("Please provide `message_id`.");
    return;
  }

  const trackedClan = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    await interaction.editReply(`Clan #${tag} is not in tracked clans.`);
    return;
  }

  const existing = await prisma.currentWar.findUnique({
    where: {
      clanTag_guildId: {
        guildId: interaction.guildId,
        clanTag: `#${tag}`,
      },
    },
    select: {
      warId: true,
      matchType: true,
      outcome: true,
      startTime: true,
      opponentTag: true,
    },
  });
  const currentWar = await getCurrentWarCached(cocService, tag).catch(
    () => null,
  );
  const opponentTag =
    normalizeTag(String(currentWar?.opponent?.tag ?? "")) ||
    normalizeTag(String(existing?.opponentTag ?? ""));
  const warStartMsFromApi = parseCocApiTime(currentWar?.startTime);
  const warStartMs =
    existing?.startTime?.getTime() ?? warStartMsFromApi ?? null;
  const warIdText =
    existing?.warId !== null &&
    existing?.warId !== undefined &&
    Number.isFinite(existing.warId)
      ? String(Math.trunc(existing.warId))
      : null;
  const nowUnix = Math.floor(Date.now() / 1000);
  const syncBaselineRow = await pointsSyncService
    .getCurrentSyncForClan({
      guildId: interaction.guildId,
      clanTag: tag,
      warId: warIdText,
      warStartTime:
        warStartMs !== null && Number.isFinite(warStartMs)
          ? new Date(Math.trunc(warStartMs))
          : null,
    })
    .catch(() => null);
  const syncBaseline = resolvePostedRevisionFromSyncRow(
    syncBaselineRow
      ? {
          lastKnownMatchType: syncBaselineRow.lastKnownMatchType ?? null,
          lastKnownOutcome: syncBaselineRow.lastKnownOutcome ?? null,
          isFwa: syncBaselineRow.isFwa ?? null,
        }
      : null,
  );
  const current = await getCurrentWarMailConfig(interaction.guildId, tag);
  const matchType = existing?.matchType ?? syncBaseline?.matchType ?? "UNKNOWN";
  const expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null =
    existing?.outcome === "WIN" || existing?.outcome === "LOSE"
      ? existing.outcome
      : (syncBaseline?.expectedOutcome ?? "UNKNOWN");

  const next: MatchMailConfig = {
    ...current,
    lastWarStartMs: warStartMs,
    lastWarId: warIdText,
    lastOpponentTag: opponentTag || null,
    lastMatchType: matchType,
    lastExpectedOutcome: expectedOutcome,
  };
  if (parsedType.messageType === "mail") {
    next.lastDataChangedAtUnix = nowUnix;
  }

  await saveCurrentWarMailConfig({
    guildId: interaction.guildId,
    tag,
    channelId: interaction.channelId,
    mailConfig: next,
  });

  if (parsedType.messageType === "mail") {
    if (!warIdText || !Number.isFinite(Number(warIdText))) {
      await interaction.editReply(
        "Cannot sync mail lifecycle: active war id is unresolved for this clan.",
      );
      return;
    }
    await warMailLifecycleService.markPosted({
      guildId: interaction.guildId,
      clanTag: tag,
      warId: Number(warIdText),
      channelId: interaction.channelId,
      messageId: messageID,
    });
    const checkpointSyncRow = await pointsSyncService
      .getCurrentSyncForClan({
        guildId: interaction.guildId,
        clanTag: tag,
        warId: warIdText,
        warStartTime: existing?.startTime ?? null,
      })
      .catch(() => null);
    await pointsSyncService
      .markConfirmedByClanMail({
        guildId: interaction.guildId,
        clanTag: tag,
        warId: warIdText,
        warStartTime: existing?.startTime ?? null,
        matchType: next.lastMatchType ?? null,
        outcome: next.lastExpectedOutcome ?? null,
        syncNum: checkpointSyncRow?.syncNum ?? null,
        points: checkpointSyncRow?.clanPoints ?? null,
      })
      .catch(() => undefined);
  } else {
    await postedMessageService.savePostedMessage({
      guildId: interaction.guildId,
      clanTag: tag,
      type: parsedType.messageType,
      event:
        parsedType.messageType === "notify"
          ? (parsedType.notifyType ?? null)
          : null,
      warId: warIdText,
      syncNum: null,
      channelId: interaction.channelId,
      messageId: messageID,
      messageUrl: buildDiscordMessageUrl(
        interaction.guildId,
        interaction.channelId,
        messageID,
      ),
      configHash: null,
    });
  }

  const messageTypeLabel =
    parsedType.messageType === "mail"
      ? "mail"
      : `notify:${parsedType.notifyType?.replace("_", " ") ?? "unknown"}`;
  await interaction.editReply(
    [
      `Force message-reference repair complete for #${tag}.`,
      `Message type: **${messageTypeLabel}**`,
      `Message ID: \`${messageID}\``,
      `War start: ${warStartMs !== null ? `<t:${Math.floor(warStartMs / 1000)}:F>` : "unknown"}`,
      `Match type: **${next.lastMatchType ?? "UNKNOWN"}**`,
      `Expected outcome: **${next.lastExpectedOutcome ?? "UNKNOWN"}**`,
      parsedType.messageType === "mail"
        ? `Mail lifecycle saved in **WarMailLifecycle**.`
        : `Posted message tracking saved in **ClanPostedMessage**.`,
    ].join("\n"),
  );
}

export async function runForceSyncWarIdCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const visibility =
    interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  await interaction.deferReply({ ephemeral: !isPublic });

  type WarIdTable = "currentwar" | "clanwarhistory" | "warattacks";
  const table = interaction.options.getString(
    "table",
    false,
  ) as WarIdTable | null;
  if (table) {
    const tagRaw = interaction.options.getString("tag", false);
    const tag = tagRaw ? normalizeTag(tagRaw) : null;
    const confirm = interaction.options.getBoolean("confirm", false) ?? false;
    const overwrite =
      interaction.options.getBoolean("overwrite", false) ?? false;
    const setWarId = interaction.options.getInteger("set_war_id", false);
    const filterWarId = interaction.options.getInteger("filter_war_id", false);
    const syncNumber = interaction.options.getInteger("sync_number", false);
    const opponentTagRaw = interaction.options.getString("opponent_tag", false);
    const opponentTag = opponentTagRaw ? normalizeTag(opponentTagRaw) : null;
    const warStartTimeRaw =
      interaction.options.getString("war_start_time", false)?.trim() ?? null;
    const warStartTime = warStartTimeRaw ? new Date(warStartTimeRaw) : null;
    if (warStartTime && Number.isNaN(warStartTime.getTime())) {
      await interaction.editReply(
        "Invalid `war_start_time`. Use ISO UTC, e.g. `2026-03-04T07:00:00.000Z`.",
      );
      return;
    }
    if (setWarId !== null && setWarId <= 0) {
      await interaction.editReply("`set_war_id` must be a positive integer.");
      return;
    }
    if (filterWarId !== null && filterWarId <= 0) {
      await interaction.editReply(
        "`filter_war_id` must be a positive integer.",
      );
      return;
    }

    if (table === "warattacks") {
      await interaction.editReply(
        "`table=warattacks` is deprecated. WarAttacks is current-war staging only now; repair `CurrentWar` or `ClanWarHistory` instead.",
      );
      return;
    }

    if (table === "currentwar") {
      if (
        setWarId !== null &&
        overwrite &&
        (tag === null || warStartTime === null)
      ) {
        await interaction.editReply(
          "For `table=currentwar` with `set_war_id`, include both `tag` and `war_start_time` so only one row is targeted.",
        );
        return;
      }
      const rows = await prisma.$queryRaw<
        Array<{
          id: number;
          clanTag: string;
          warStartTime: Date | null;
          syncNumber: number | null;
          opponentTag: string | null;
          existingWarId: number | null;
          targetWarId: number | null;
        }>
      >(
        Prisma.sql`
          WITH base_max AS (
            SELECT GREATEST(
              COALESCE((SELECT MAX("warId") FROM "ClanWarHistory"), 0),
              COALESCE((SELECT MAX("warId") FROM "CurrentWar"), 0)
            ) AS max_war_id
          ),
          candidates AS (
            SELECT
              cw."id",
              cw."clanTag",
              cw."startTime" AS "warStartTime",
              cw."syncNum" AS "syncNumber",
              cw."opponentTag" AS "opponentTag",
              cw."warId" AS "existingWarId",
              ROW_NUMBER() OVER (ORDER BY cw."id" ASC) AS rn
            FROM "CurrentWar" cw
            WHERE 1=1
              ${tag ? Prisma.sql`AND UPPER(REPLACE(cw."clanTag",'#','')) = ${tag}` : Prisma.empty}
              ${warStartTime ? Prisma.sql`AND cw."startTime" = ${warStartTime}` : Prisma.empty}
              ${syncNumber !== null ? Prisma.sql`AND cw."syncNum" = ${syncNumber}` : Prisma.empty}
              ${opponentTag ? Prisma.sql`AND UPPER(REPLACE(cw."opponentTag",'#','')) = ${opponentTag}` : Prisma.empty}
              ${filterWarId !== null ? Prisma.sql`AND cw."warId" = ${filterWarId}` : Prisma.empty}
              ${overwrite ? Prisma.empty : Prisma.sql`AND cw."warId" IS NULL`}
          )
          SELECT
            c."id",
            c."clanTag",
            c."warStartTime",
            c."syncNumber",
            c."opponentTag",
            c."existingWarId",
            ${
              setWarId !== null
                ? Prisma.sql`${setWarId}`
                : Prisma.sql`(b.max_war_id + c.rn)::int`
            } AS "targetWarId"
          FROM candidates c
          CROSS JOIN base_max b
          WHERE c."existingWarId" IS DISTINCT FROM ${
            setWarId !== null
              ? Prisma.sql`${setWarId}`
              : Prisma.sql`(b.max_war_id + c.rn)::int`
          }
          ORDER BY c."clanTag" ASC
        `,
      );
      if (setWarId !== null && rows.length > 1) {
        await interaction.editReply(
          "Refusing to set one `set_war_id` across multiple CurrentWar rows. Add tighter filters.",
        );
        return;
      }
      if (setWarId !== null && rows.length === 1) {
        const existingWarIdRows = await prisma.$queryRaw<
          Array<{ count: bigint | number }>
        >(
          Prisma.sql`
            SELECT SUM(cnt)::bigint AS count
            FROM (
              SELECT COUNT(*)::bigint AS cnt
              FROM "ClanWarHistory"
              WHERE "warId" = ${setWarId}
              UNION ALL
              SELECT COUNT(*)::bigint AS cnt
              FROM "CurrentWar"
              WHERE "warId" = ${setWarId}
                AND "id" <> ${rows[0].id}
            ) s
          `,
        );
        const taken = Number(existingWarIdRows[0]?.count ?? 0);
        if (taken > 0) {
          await interaction.editReply(
            `set_war_id=${setWarId} is already used in CurrentWar/ClanWarHistory. Choose a unique warId.`,
          );
          return;
        }
      }
      const previewLines = rows.slice(0, 20).map((row) => {
        const warStart = row.warStartTime
          ? row.warStartTime.toISOString()
          : "unknown";
        const sync = row.syncNumber ?? "unknown";
        const opp = row.opponentTag
          ? `#${normalizeTag(row.opponentTag)}`
          : "unknown";
        return `CurrentWar row: warStartTime=${warStart}, syncNumber=${sync}, clanTag=#${normalizeTag(
          row.clanTag,
        )}, opponentTag=${opp}, existingWarId=${row.existingWarId ?? "null"} -> targetWarId=${row.targetWarId}`;
      });
      const lines = [
        "Table: CurrentWar",
        `Matched rows: ${rows.length}`,
        ...previewLines,
        rows.length > 20 ? `...and ${rows.length - 20} more row(s).` : "",
      ].filter(Boolean);
      if (!confirm) {
        lines.push("No writes executed. Re-run with `confirm:true` to apply.");
        await interaction.editReply(truncateDiscordContent(lines.join("\n")));
        return;
      }
      const updated = Number(
        await prisma.$executeRaw(
          Prisma.sql`
            WITH base_max AS (
              SELECT GREATEST(
                COALESCE((SELECT MAX("warId") FROM "ClanWarHistory"), 0),
                COALESCE((SELECT MAX("warId") FROM "CurrentWar"), 0)
              ) AS max_war_id
            ),
            base_rows AS (
              SELECT
                cw."id",
                cw."warId" AS "existingWarId",
                ROW_NUMBER() OVER (ORDER BY cw."id" ASC) AS rn
              FROM "CurrentWar" cw
              WHERE 1=1
                ${tag ? Prisma.sql`AND UPPER(REPLACE(cw."clanTag",'#','')) = ${tag}` : Prisma.empty}
                ${warStartTime ? Prisma.sql`AND cw."startTime" = ${warStartTime}` : Prisma.empty}
                ${syncNumber !== null ? Prisma.sql`AND cw."syncNum" = ${syncNumber}` : Prisma.empty}
                ${opponentTag ? Prisma.sql`AND UPPER(REPLACE(cw."opponentTag",'#','')) = ${opponentTag}` : Prisma.empty}
                ${filterWarId !== null ? Prisma.sql`AND cw."warId" = ${filterWarId}` : Prisma.empty}
                ${overwrite ? Prisma.empty : Prisma.sql`AND cw."warId" IS NULL`}
            ),
            candidates AS (
              SELECT
                br."id",
                ${
                  setWarId !== null
                    ? Prisma.sql`${setWarId}`
                    : Prisma.sql`(b.max_war_id + br.rn)::int`
                } AS "targetWarId"
              FROM base_rows br
              CROSS JOIN base_max b
              WHERE br."existingWarId" IS DISTINCT FROM ${
                setWarId !== null
                  ? Prisma.sql`${setWarId}`
                  : Prisma.sql`(b.max_war_id + br.rn)::int`
              }
            )
            UPDATE "CurrentWar" cw
            SET "warId" = c."targetWarId"
            FROM candidates c
            WHERE cw."id" = c."id"
          `,
        ),
      );
      lines.push(`Updated CurrentWar rows: **${updated}**`);
      lines.push(
        "Note: This command is DB-only (no external API scrape calls).",
      );
      await interaction.editReply(truncateDiscordContent(lines.join("\n")));
      return;
    }

    if (table === "clanwarhistory") {
      if (setWarId === null) {
        await interaction.editReply(
          "For `table=clanwarhistory`, provide `set_war_id` (explicit target warId).",
        );
        return;
      }
      const rows = await prisma.$queryRaw<
        Array<{
          clanTag: string;
          warStartTime: Date;
          syncNumber: number | null;
          opponentTag: string | null;
          warId: number;
        }>
      >(
        Prisma.sql`
          SELECT h."clanTag", h."warStartTime", h."syncNumber", h."opponentTag", h."warId"
          FROM "ClanWarHistory" h
          WHERE 1=1
            ${tag ? Prisma.sql`AND UPPER(REPLACE(h."clanTag",'#','')) = ${tag}` : Prisma.empty}
            ${warStartTime ? Prisma.sql`AND h."warStartTime" = ${warStartTime}` : Prisma.empty}
            ${syncNumber !== null ? Prisma.sql`AND h."syncNumber" = ${syncNumber}` : Prisma.empty}
            ${opponentTag ? Prisma.sql`AND UPPER(REPLACE(h."opponentTag",'#','')) = ${opponentTag}` : Prisma.empty}
            ${filterWarId !== null ? Prisma.sql`AND h."warId" = ${filterWarId}` : Prisma.empty}
            ${overwrite ? Prisma.empty : Prisma.sql`AND h."warId" IS DISTINCT FROM ${setWarId}`}
          ORDER BY h."warStartTime" DESC
        `,
      );
      const lines = [
        "Table: ClanWarHistory",
        `Matched rows: ${rows.length}`,
        ...rows.slice(0, 20).map((row) => {
          const warStart = row.warStartTime
            ? row.warStartTime.toISOString()
            : "unknown";
          const opp = row.opponentTag
            ? `#${normalizeTag(row.opponentTag)}`
            : "unknown";
          return `ClanWarHistory row: warStartTime=${warStart}, syncNumber=${row.syncNumber ?? "unknown"}, clanTag=#${normalizeTag(
            row.clanTag,
          )}, opponentTag=${opp}, existingWarId=${row.warId} -> targetWarId=${setWarId}`;
        }),
        rows.length > 20 ? `...and ${rows.length - 20} more row(s).` : "",
      ].filter(Boolean);
      if (!confirm) {
        lines.push("No writes executed. Re-run with `confirm:true` to apply.");
        await interaction.editReply(truncateDiscordContent(lines.join("\n")));
        return;
      }
      if (rows.length !== 1) {
        await interaction.editReply(
          "For ClanWarHistory updates, filters must resolve to exactly 1 row.",
        );
        return;
      }
      const updated = Number(
        await prisma.$executeRaw(
          Prisma.sql`
            UPDATE "ClanWarHistory" h
            SET "warId" = ${setWarId}
            WHERE 1=1
              ${tag ? Prisma.sql`AND UPPER(REPLACE(h."clanTag",'#','')) = ${tag}` : Prisma.empty}
              ${warStartTime ? Prisma.sql`AND h."warStartTime" = ${warStartTime}` : Prisma.empty}
              ${syncNumber !== null ? Prisma.sql`AND h."syncNumber" = ${syncNumber}` : Prisma.empty}
              ${opponentTag ? Prisma.sql`AND UPPER(REPLACE(h."opponentTag",'#','')) = ${opponentTag}` : Prisma.empty}
              ${filterWarId !== null ? Prisma.sql`AND h."warId" = ${filterWarId}` : Prisma.empty}
          `,
        ),
      );
      lines.push(`Updated ClanWarHistory rows: **${updated}**`);
      lines.push(
        "Note: This command is DB-only (no external API scrape calls).",
      );
      await interaction.editReply(truncateDiscordContent(lines.join("\n")));
      return;
    }

    await interaction.editReply(`Unsupported table: ${table}`);
    return;
  }

  const tagRaw = interaction.options.getString("tag", false);
  const tag = tagRaw ? normalizeTag(tagRaw) : null;
  const confirm = interaction.options.getBoolean("confirm", false) ?? false;
  const tagFilterHistory = tag
    ? Prisma.sql`AND UPPER(REPLACE("clanTag",'#','')) = ${tag}`
    : Prisma.empty;
  const tagFilterHistoryAlias = tag
    ? Prisma.sql`AND UPPER(REPLACE(h."clanTag",'#','')) = ${tag}`
    : Prisma.empty;
  const tagFilterCurrentAlias = tag
    ? Prisma.sql`AND UPPER(REPLACE(cw."clanTag",'#','')) = ${tag}`
    : Prisma.empty;
  const tagFilterCurrent = tag
    ? Prisma.sql`AND UPPER(REPLACE("clanTag",'#','')) = ${tag}`
    : Prisma.empty;

  if (!confirm) {
    const previewRows = await prisma.$queryRaw<
      Array<{
        clanTag: string;
        warStartTime: Date | null;
        syncNumber: number | null;
        opponentTag: string | null;
        proposedWarId: number | null;
      }>
    >(
      Prisma.sql`
        WITH history_latest AS (
          SELECT DISTINCT ON (UPPER(REPLACE(h."clanTag",'#','')))
            UPPER(REPLACE(h."clanTag",'#','')) AS clan_norm,
            h."warId"
          FROM "ClanWarHistory" h
          WHERE h."warId" IS NOT NULL
            ${tagFilterHistory}
          ORDER BY UPPER(REPLACE(h."clanTag",'#','')), h."warStartTime" DESC, h."warId" DESC
        )
        SELECT
          cw."clanTag",
          cw."startTime" AS "warStartTime",
          cw."syncNum" AS "syncNumber",
          cw."opponentTag" AS "opponentTag",
          COALESCE(h_exact."warId", history_latest."warId") AS "proposedWarId"
        FROM "CurrentWar" cw
        LEFT JOIN "ClanWarHistory" h_exact
          ON UPPER(REPLACE(cw."clanTag",'#','')) = UPPER(REPLACE(h_exact."clanTag",'#',''))
         AND cw."startTime" = h_exact."warStartTime"
         AND h_exact."warId" IS NOT NULL
        LEFT JOIN history_latest
          ON UPPER(REPLACE(cw."clanTag",'#','')) = history_latest.clan_norm
        WHERE cw."warId" IS NULL
          ${tagFilterCurrentAlias}
        ORDER BY cw."clanTag" ASC
      `,
    );

    const lines: string[] = [
      `Preview mode only. No database writes were made.`,
      `Re-run with \`/force sync warid${tag ? ` tag:${tag}` : ""} confirm:true\` to apply.`,
      "",
    ];

    const deterministicRows = previewRows.filter(
      (row) => row.proposedWarId !== null,
    );
    if (deterministicRows.length === 0) {
      lines.push("No deterministic CurrentWar backfill rows found.");
    }

    for (const row of deterministicRows) {
      const attacksCountRows = await prisma.$queryRaw<
        Array<{ count: bigint | number }>
      >(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "WarAttacks" wa
          WHERE wa."warId" IS NULL
            AND UPPER(REPLACE(wa."clanTag",'#','')) = UPPER(REPLACE(${row.clanTag},'#',''))
            AND wa."warStartTime" = ${row.warStartTime}
        `,
      );
      const attacksCount = Number(attacksCountRows[0]?.count ?? 0);
      const warStartDisplay =
        row.warStartTime instanceof Date
          ? row.warStartTime.toISOString()
          : "unknown";
      const syncDisplay =
        row.syncNumber !== null && Number.isFinite(row.syncNumber)
          ? `#${Math.trunc(row.syncNumber)}`
          : "unknown";
      const clanDisplay = `#${normalizeTag(row.clanTag)}`;
      const oppDisplay = row.opponentTag
        ? `#${normalizeTag(row.opponentTag)}`
        : "unknown";
      const warIdDisplay = Math.trunc(Number(row.proposedWarId));
      lines.push(
        `CurrentWar row candidate: warStartTime=${warStartDisplay}, syncNumber=${syncDisplay}, clanTag=${clanDisplay} -> warId=${warIdDisplay}. Confirm?`,
      );
      lines.push(
        `WarAttacks row candidates: ${attacksCount} row(s) where warStartTime=${warStartDisplay}, clanTag=${clanDisplay}, opponentTag=${oppDisplay} -> warId=${warIdDisplay}. Confirm?`,
      );
      lines.push("");
    }

    const allocationCandidatesRows = await prisma.$queryRaw<
      Array<{ count: bigint | number }>
    >(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS count
        FROM "CurrentWar"
        WHERE "warId" IS NULL
          AND "state" IN ('preparation','inWar')
          ${tagFilterCurrent}
      `,
    );
    const allocationCandidates = Number(
      allocationCandidatesRows[0]?.count ?? 0,
    );
    lines.push(
      `Active-war allocation candidates (new sequence warId at execution time): ${allocationCandidates}`,
    );

    await interaction.editReply(truncateDiscordContent(lines.join("\n")));
    return;
  }

  const summary = await prisma.$transaction(async (tx) => {
    let historyAssigned = 0;

    const historyNullRows = await tx.$queryRaw<
      Array<{ clanTag: string; warStartTime: Date }>
    >(
      Prisma.sql`
        SELECT "clanTag","warStartTime"
        FROM "ClanWarHistory"
        WHERE "warId" IS NULL
        ${tagFilterHistory}
        ORDER BY "warStartTime" ASC
      `,
    );

    for (const row of historyNullRows) {
      const nextRows = await tx.$queryRaw<Array<{ warId: bigint | number }>>(
        Prisma.sql`SELECT nextval(pg_get_serial_sequence('"ClanWarHistory"', 'warId')) AS "warId"`,
      );
      const raw = nextRows[0]?.warId;
      const nextWarId = raw === undefined || raw === null ? null : Number(raw);
      if (nextWarId === null || !Number.isFinite(nextWarId)) continue;
      const updated = await tx.$executeRaw(
        Prisma.sql`
          UPDATE "ClanWarHistory"
          SET "warId" = ${Math.trunc(nextWarId)}
          WHERE "warId" IS NULL
            AND "clanTag" = ${row.clanTag}
            AND "warStartTime" = ${row.warStartTime}
        `,
      );
      historyAssigned += Number(updated ?? 0);
    }

    const warAttacksUpdated = Number(
      await tx.$executeRaw(
        Prisma.sql`
          WITH candidate AS (
            SELECT
              wa."id",
              wa."playerTag",
              wa."attackNumber",
              h."warId",
              ROW_NUMBER() OVER (
                PARTITION BY h."warId", wa."playerTag", wa."attackNumber"
                ORDER BY wa."id" ASC
              ) AS rn
            FROM "WarAttacks" wa
            JOIN "ClanWarHistory" h
              ON UPPER(REPLACE(wa."clanTag",'#','')) = UPPER(REPLACE(h."clanTag",'#',''))
             AND wa."warStartTime" = h."warStartTime"
            WHERE wa."warId" IS NULL
              AND h."warId" IS NOT NULL
              ${tagFilterHistoryAlias}
          ),
          safe AS (
            SELECT c."id", c."warId"
            FROM candidate c
            WHERE c.rn = 1
              AND NOT EXISTS (
                SELECT 1
                FROM "WarAttacks" existing
                WHERE existing."warId" = c."warId"
                  AND existing."playerTag" = c."playerTag"
                  AND existing."attackNumber" = c."attackNumber"
              )
          )
          UPDATE "WarAttacks" wa
          SET "warId" = s."warId"
          FROM safe s
          WHERE wa."id" = s."id"
        `,
      ),
    );

    const currentWarUpdated = Number(
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE "CurrentWar" cw
          SET "warId" = h."warId"
          FROM "ClanWarHistory" h
          WHERE cw."warId" IS NULL
            AND UPPER(REPLACE(cw."clanTag",'#','')) = UPPER(REPLACE(h."clanTag",'#',''))
            AND cw."startTime" = h."warStartTime"
            AND h."warId" IS NOT NULL
            ${tagFilterCurrentAlias}
        `,
      ),
    );

    const currentWarRowsNeedingAllocation = await tx.$queryRaw<
      Array<{ id: number; clanTag: string; startTime: Date | null }>
    >(
      Prisma.sql`
        SELECT "id","clanTag","startTime"
        FROM "CurrentWar"
        WHERE "warId" IS NULL
          AND "state" IN ('preparation','inWar')
          ${tagFilterCurrent}
      `,
    );

    let currentWarAllocated = 0;
    let warAttacksFromCurrentAllocated = 0;
    for (const row of currentWarRowsNeedingAllocation) {
      const nextRows = await tx.$queryRaw<Array<{ warId: bigint | number }>>(
        Prisma.sql`SELECT nextval(pg_get_serial_sequence('"ClanWarHistory"', 'warId')) AS "warId"`,
      );
      const raw = nextRows[0]?.warId;
      const nextWarId = raw === undefined || raw === null ? null : Number(raw);
      if (nextWarId === null || !Number.isFinite(nextWarId)) continue;
      const warId = Math.trunc(nextWarId);

      const updatedCurrent = Number(
        await tx.$executeRaw(
          Prisma.sql`
            UPDATE "CurrentWar"
            SET "warId" = ${warId}
            WHERE "id" = ${row.id}
              AND "warId" IS NULL
          `,
        ),
      );
      currentWarAllocated += updatedCurrent;

      if (updatedCurrent > 0 && row.startTime) {
        const updatedAttacks = Number(
          await tx.$executeRaw(
            Prisma.sql`
              WITH candidate AS (
                SELECT
                  wa."id",
                  wa."playerTag",
                  wa."attackNumber",
                  ROW_NUMBER() OVER (
                    PARTITION BY wa."playerTag", wa."attackNumber"
                    ORDER BY wa."id" ASC
                  ) AS rn
                FROM "WarAttacks" wa
                WHERE wa."warId" IS NULL
                  AND UPPER(REPLACE(wa."clanTag",'#','')) = UPPER(REPLACE(${row.clanTag},'#',''))
                  AND wa."warStartTime" = ${row.startTime}
              ),
              safe AS (
                SELECT c."id"
                FROM candidate c
                WHERE c.rn = 1
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "WarAttacks" existing
                    WHERE existing."warId" = ${warId}
                      AND existing."playerTag" = c."playerTag"
                      AND existing."attackNumber" = c."attackNumber"
                  )
              )
              UPDATE "WarAttacks" wa
              SET "warId" = ${warId}
              FROM safe s
              WHERE wa."id" = s."id"
            `,
          ),
        );
        warAttacksFromCurrentAllocated += updatedAttacks;
      }
    }

    const currentWarUpdatedFromLatestHistory = Number(
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE "CurrentWar" cw
          SET "warId" = history_latest."warId"
          FROM (
            SELECT DISTINCT ON (UPPER(REPLACE(h."clanTag",'#','')))
              UPPER(REPLACE(h."clanTag",'#','')) AS clan_norm,
              h."warId"
            FROM "ClanWarHistory" h
            WHERE h."warId" IS NOT NULL
              ${tagFilterHistory}
            ORDER BY UPPER(REPLACE(h."clanTag",'#','')), h."warStartTime" DESC, h."warId" DESC
          ) history_latest
          WHERE cw."warId" IS NULL
            AND UPPER(REPLACE(cw."clanTag",'#','')) = history_latest.clan_norm
            AND history_latest."warId" IS NOT NULL
            ${tagFilterCurrentAlias}
        `,
      ),
    );

    const warAttacksUpdatedFromSingleHistoryClan = Number(
      await tx.$executeRaw(
        Prisma.sql`
          WITH single_history AS (
            SELECT
              UPPER(REPLACE("clanTag",'#','')) AS clan_norm,
              MIN("warId") AS "warId"
            FROM "ClanWarHistory"
            WHERE "warId" IS NOT NULL
              ${tagFilterHistory}
            GROUP BY 1
            HAVING COUNT(DISTINCT "warId") = 1
          ),
          candidate AS (
            SELECT
              wa."id",
              wa."playerTag",
              wa."attackNumber",
              sh."warId",
              ROW_NUMBER() OVER (
                PARTITION BY sh."warId", wa."playerTag", wa."attackNumber"
                ORDER BY wa."id" ASC
              ) AS rn
            FROM "WarAttacks" wa
            JOIN single_history sh
              ON UPPER(REPLACE(wa."clanTag",'#','')) = sh.clan_norm
            WHERE wa."warId" IS NULL
          ),
          safe AS (
            SELECT c."id", c."warId"
            FROM candidate c
            WHERE c.rn = 1
              AND NOT EXISTS (
                SELECT 1
                FROM "WarAttacks" existing
                WHERE existing."warId" = c."warId"
                  AND existing."playerTag" = c."playerTag"
                  AND existing."attackNumber" = c."attackNumber"
              )
          )
          UPDATE "WarAttacks" wa
          SET "warId" = s."warId"
          FROM safe s
          WHERE wa."id" = s."id"
        `,
      ),
    );

    return {
      historyAssigned,
      warAttacksUpdated,
      currentWarUpdated,
      currentWarAllocated,
      warAttacksFromCurrentAllocated,
      currentWarUpdatedFromLatestHistory,
      warAttacksUpdatedFromSingleHistoryClan,
    };
  });

  await interaction.editReply(
    [
      `Force warId backfill complete${tag ? ` for #${tag}` : ""}.`,
      `ClanWarHistory warId assigned: **${summary.historyAssigned}**`,
      `WarAttacks warId updated: **${summary.warAttacksUpdated}**`,
      `CurrentWar warId updated: **${summary.currentWarUpdated}**`,
      `CurrentWar warId allocated (active wars): **${summary.currentWarAllocated}**`,
      `WarAttacks warId updated from CurrentWar allocation: **${summary.warAttacksFromCurrentAllocated}**`,
      `CurrentWar warId updated from latest ClanWarHistory: **${summary.currentWarUpdatedFromLatestHistory}**`,
      `WarAttacks warId updated from single-history clans: **${summary.warAttacksUpdatedFromSingleHistoryClan}**`,
      "Note: This command is DB-only (no external API scrape calls).",
    ].join("\n"),
  );
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
          description:
            "Clan tag (with or without #). Leave blank for all tracked clans.",
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
        {
          name: "debug-mail-status",
          description:
            "Show admin-only mail status diagnostics for tracked Discord post state",
          type: ApplicationCommandOptionType.Boolean,
          required: false,
        },
      ],
    },
    {
      name: "base-swap",
      description: "Post a base swap / base error acknowledgement announcement",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "war-bases",
          description: "Comma-separated war-base positions, e.g. 1,4,7",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "base-errors",
          description: "Comma-separated base-error positions, e.g. 2,3,9",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "compliance",
      description: "Review war-plan compliance for a tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "tag",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "war-id",
          description:
            "War target: `Ongoing` or a specific historical war (war ID / opponent from autocomplete)",
          type: ApplicationCommandOptionType.String,
          required: true,
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
      name: "weight-age",
      description: "Check last submitted FWA Stats weight age",
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
          description:
            "Clan tag (with or without #). Leave blank for all tracked clans.",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "weight-link",
      description: "Return FWA Stats weight page links",
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
          description:
            "Clan tag (with or without #). Leave blank for all tracked clans.",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "weight-health",
      description: "Show stale FWA Stats weight submissions",
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
          description:
            "Clan tag (with or without #). Leave blank for all tracked clans.",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "weight-cookie",
      description: "Set or check fwastats cookie auth used by weight commands",
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
          name: "application-cookie",
          description:
            "AspNetCore application cookie value (name auto-applied)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "antiforgery-cookie",
          description:
            "AspNetCore antiforgery cookie value (name auto-applied)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "antiforgery-cookie-name",
          description: "Optional antiforgery cookie name override",
          type: ApplicationCommandOptionType.String,
          required: false,
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
    {
      name: "mail",
      description: "Configure and send tracked clan war mail",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "send",
          description: "Preview and send war mail for a tracked clan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "tag",
              description: "Tracked clan tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
          ],
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(true);
    const visibility =
      interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    const defaultComponents = !isPublic
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildPointsPostButtonCustomId(interaction.user.id))
              .setLabel("Post to Channel")
              .setStyle(ButtonStyle.Secondary),
          ),
        ]
      : [];

    const editReplySafe = async (
      content: string,
      embeds?: EmbedBuilder[],
      componentsOverride?: Array<
        | ActionRowBuilder<ButtonBuilder>
        | ActionRowBuilder<StringSelectMenuBuilder>
      >,
    ): Promise<void> => {
      const normalized = content.trim();
      await interaction.editReply({
        content: normalized ? truncateDiscordContent(normalized) : undefined,
        embeds,
        components: componentsOverride ?? defaultComponents,
      });
    };

    await interaction.deferReply({ ephemeral: !isPublic });
    const settings = new SettingsService();
    const warLookupCache: WarLookupCache = new Map();
    const sourceSync = await getSourceOfTruthSync(
      settings,
      interaction.guildId ?? null,
    );
    const rawTag = interaction.options.getString("tag", false);
    const tag = normalizeTag(rawTag ?? "");
    const debugMailStatusRequested =
      subcommand === "match"
        ? (interaction.options.getBoolean("debug-mail-status", false) ?? false)
        : false;
    const debugMailStatusAllowed = debugMailStatusRequested
      ? await canViewFwaMatchMailDebug(interaction)
      : false;
    const matchMailStatusDebugEnabled =
      debugMailStatusRequested && debugMailStatusAllowed;
    if (debugMailStatusRequested) {
      console.info(
        `[fwa-mail-status-debug] event=invocation guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} scope=${tag ? "single" : "alliance"} clan=${tag ? `#${tag}` : "all"} allowed=${matchMailStatusDebugEnabled ? "1" : "0"}`,
      );
    }
    const resolveWeightTargets = async (): Promise<
      Array<{ tag: string; clanName: string }>
    > => {
      if (tag) {
        const trackedRow = interaction.guildId
          ? await prisma.trackedClan.findFirst({
              where: {
                OR: [
                  { tag: { equals: `#${tag}`, mode: "insensitive" } },
                  { tag: { equals: tag, mode: "insensitive" } },
                ],
              },
              select: { name: true },
            })
          : null;
        return [
          {
            tag,
            clanName: sanitizeClanName(trackedRow?.name) ?? `#${tag}`,
          },
        ];
      }

      if (!interaction.guildId) return [];
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { tag: true, name: true },
      });
      return tracked.map((row) => {
        const normalizedTag = normalizeTag(row.tag);
        return {
          tag: normalizedTag,
          clanName: sanitizeClanName(row.name) ?? `#${normalizedTag}`,
        };
      });
    };

    if (subcommand === "leader-role") {
      if (!interaction.inGuild()) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      const isOwnerBypass = (() => {
        const raw =
          process.env.OWNER_DISCORD_USER_IDS ??
          process.env.OWNER_DISCORD_USER_ID ??
          "";
        const owners = new Set(
          raw
            .split(",")
            .map((v) => v.trim())
            .filter((v) => /^\d+$/.test(v)),
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

    if (subcommandGroup === "mail" && subcommand === "send") {
      if (!interaction.inGuild() || !interaction.guildId) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      if (!tag) {
        await editReplySafe("Please provide `tag`.");
        return;
      }
      await showWarMailPreview(
        interaction,
        interaction.guildId,
        interaction.user.id,
        tag,
        cocService,
      );
      return;
    }

    if (subcommand === "base-swap") {
      if (
        !interaction.inGuild() ||
        !interaction.guildId ||
        !interaction.channel
      ) {
        await editReplySafe(
          "This command can only be used in a server channel.",
        );
        return;
      }
      const clanTag = normalizeTag(interaction.options.getString("clan", true));
      const warBasePositions = parseBaseSwapPositionList(
        interaction.options.getString("war-bases", false),
      );
      const baseErrorPositions = parseBaseSwapPositionList(
        interaction.options.getString("base-errors", false),
      );

      if (warBasePositions.length === 0 && baseErrorPositions.length === 0) {
        await editReplySafe(
          "Provide at least one position in `war-bases` or `base-errors`.",
        );
        return;
      }

      const trackedClan = await prisma.trackedClan.findFirst({
        where: {
          OR: [
            { tag: { equals: `#${clanTag}`, mode: "insensitive" } },
            { tag: { equals: clanTag, mode: "insensitive" } },
          ],
        },
        select: { tag: true, name: true },
      });
      if (!trackedClan) {
        await editReplySafe(`Clan #${clanTag} is not in tracked clans.`);
        return;
      }

      const currentWarRow = await prisma.currentWar.findFirst({
        where: {
          guildId: interaction.guildId,
          OR: [{ clanTag: `#${clanTag}` }, { clanTag: clanTag }],
        },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          state: true,
          startTime: true,
          endTime: true,
        },
      });
      const baseSwapPhaseTimingLine = buildFwaBaseSwapPhaseTimingLine({
        warState: deriveWarState(currentWarRow?.state ?? null),
        prepEndMs: currentWarRow?.startTime
          ? currentWarRow.startTime.getTime()
          : null,
        warEndMs: currentWarRow?.endTime ? currentWarRow.endTime.getTime() : null,
      });

      const war = await getCurrentWarCached(
        cocService,
        clanTag,
        warLookupCache,
      ).catch(() => null);
      if (
        !war ||
        !war.clan ||
        !Array.isArray(war.clan.members) ||
        war.clan.members.length === 0
      ) {
        await editReplySafe(
          `No active current war roster found for #${clanTag}.`,
        );
        return;
      }

      const roster = war.clan.members
        .map((member) => ({
          position:
            typeof member.mapPosition === "number" &&
            Number.isFinite(member.mapPosition)
              ? Math.trunc(member.mapPosition)
              : null,
          playerTag: normalizeTag(String(member.tag ?? "")),
          playerName: String(member.name ?? "Unknown").trim() || "Unknown",
          townhallLevel: getBaseSwapTownhallLevel(member),
        }))
        .filter(
          (
            member,
          ): member is {
            position: number;
            playerTag: string;
            playerName: string;
            townhallLevel: number | null;
          } =>
            member.position !== null &&
            member.position > 0 &&
            member.playerTag.length > 0,
        )
        .sort((a, b) => a.position - b.position);

      const memberByPosition = new Map(
        roster.map((member) => [member.position, member]),
      );
      const allRequestedPositions = [
        ...new Set([...warBasePositions, ...baseErrorPositions]),
      ];
      const missingPositions = allRequestedPositions.filter(
        (position) => !memberByPosition.has(position),
      );
      if (missingPositions.length > 0) {
        await editReplySafe(
          `These positions were not found in the current war roster for #${clanTag}: ${missingPositions
            .map((value) => `#${value}`)
            .join(", ")}`,
        );
        return;
      }

      const links = await listPlayerLinksForClanMembers({
        memberTagsInOrder: roster.map((member) => member.playerTag),
      });
      const linkByTag = new Map(
        links.map((link) => [normalizeTag(link.playerTag), link]),
      );

      const entries: FwaBaseSwapAnnouncementEntry[] = [];
      for (const position of warBasePositions) {
        const member = memberByPosition.get(position);
        if (!member) continue;
        entries.push({
          position,
          playerTag: member.playerTag,
          playerName: member.playerName,
          discordUserId: linkByTag.get(member.playerTag)?.discordUserId ?? null,
          townhallLevel: member.townhallLevel,
          section: "war_bases",
          acknowledged: false,
        });
      }
      for (const position of baseErrorPositions) {
        const member = memberByPosition.get(position);
        if (!member) continue;
        entries.push({
          position,
          playerTag: member.playerTag,
          playerName: member.playerName,
          discordUserId: linkByTag.get(member.playerTag)?.discordUserId ?? null,
          townhallLevel: member.townhallLevel,
          section: "base_errors",
          acknowledged: false,
        });
      }

      if (entries.length === 0) {
        await editReplySafe("No announcement entries were generated.");
        return;
      }

      const townhalls = collectBaseSwapTownhallLevels(entries);
      const layoutRows =
        townhalls.length > 0
          ? await prisma.fwaLayouts.findMany({
              where: {
                Type: FWA_BASE_SWAP_LAYOUT_TYPE,
                Townhall: { in: townhalls },
              },
              select: {
                Townhall: true,
                LayoutLink: true,
              },
            })
          : [];
      const layoutLinks = buildBaseSwapLayoutLinks(entries, layoutRows);
      const inlineEmojis = await resolveFwaBaseSwapInlineEmojis(
        interaction.client,
      );

      const clanName = sanitizeClanName(trackedClan.name) ?? `#${clanTag}`;
      const createdAtIso = new Date().toISOString();
      const renderPlan = buildFwaBaseSwapRenderPlan({
        entries,
        layoutLinks,
        phaseTimingLine: baseSwapPhaseTimingLine,
        alertEmoji: inlineEmojis.alertEmoji,
        layoutBulletEmoji: inlineEmojis.layoutBulletEmoji,
      });
      const mentionUserIds = buildFwaBaseSwapMentionUserIds(entries);
      const unlinked = entries.filter((entry) => !entry.discordUserId);

      if (!renderPlan.fitsSingleMessage) {
        if (!renderPlan.splitContents) {
          await editReplySafe(
            "This base-swap announcement exceeds Discord message limits and could not be safely split into 2 posts. Reduce the selected positions and try again.",
          );
          return;
        }

        const key = createTransientFwaKey();
        fwaBaseSwapSplitPostPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          clanTag,
          clanName,
          entries,
          layoutLinks,
          phaseTimingLine: baseSwapPhaseTimingLine,
          alertEmoji: inlineEmojis.alertEmoji,
          layoutBulletEmoji: inlineEmojis.layoutBulletEmoji,
          mentionUserIds,
          createdAtIso,
          splitContents: renderPlan.splitContents,
        });

        await interaction.editReply({
          content: [
            FWA_BASE_SWAP_SPLIT_PROMPT,
            "Click **Yes** to publish 2 linked posts, or **Cancel** to stop.",
            unlinked.length > 0
              ? `Unlinked positions: ${[
                  ...new Set(
                    unlinked.map(
                      (entry) => `#${entry.position} ${entry.playerName}`,
                    ),
                  ),
                ].join(", ")}`
              : "All listed players have linked Discord users.",
          ].join("\n"),
          components: buildFwaBaseSwapSplitPromptComponents(
            interaction.user.id,
            key,
          ),
        });
        return;
      }

      const posted = await interaction.channel.send({
        content: renderPlan.singleContent,
        allowedMentions: { users: mentionUserIds },
      });
      const expiresAt = new Date(Date.now() + FWA_BASE_SWAP_TTL_MS);
      await trackedMessageService.createFwaBaseSwapTrackedMessages({
        guildId: interaction.guildId,
        clanTag,
        expiresAt,
        messages: [
          {
            channelId: interaction.channelId,
            messageId: posted.id,
            metadata: {
              clanName,
              createdByUserId: interaction.user.id,
              createdAtIso,
              entries,
              layoutLinks,
              phaseTimingLine: baseSwapPhaseTimingLine,
              alertEmoji: inlineEmojis.alertEmoji,
              layoutBulletEmoji: inlineEmojis.layoutBulletEmoji,
              renderVariant: "single",
            },
          },
        ],
      });

      await posted.react(FWA_BASE_SWAP_ACK_EMOJI).catch((err: unknown) => {
        console.error(
          `[fwa base-swap] react failed guild=${interaction.guildId} channel=${interaction.channelId} message=${posted.id} emoji=${FWA_BASE_SWAP_ACK_EMOJI} user=${interaction.user.id} error=${formatError(
            err,
          )}`,
        );
      });

      await editReplySafe(
        [
          `Posted base swap announcement for **${clanName}** (#${clanTag}).`,
          unlinked.length > 0
            ? `Unlinked positions: ${[...new Set(unlinked.map((entry) => `#${entry.position} ${entry.playerName}`))].join(", ")}`
            : "All listed players have linked Discord users.",
          posted.url,
        ].join("\n"),
      );
      await deliverFwaBaseSwapDmMessages({
        entries,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        clanTag,
        userId: interaction.user.id,
        sendDm: async (content) => interaction.user.send({ content }),
        sendFailureNotice: async (content) =>
          interaction.followUp({ content, ephemeral: true }),
      });
      return;
    }

    if (subcommand === "compliance") {
      const startedAtMs = Date.now();
      const parsedWarTarget = parseComplianceWarTarget(
        interaction.options.getString("war-id", false),
      );
      if (!parsedWarTarget.ok) {
        await editReplySafe(parsedWarTarget.error);
        return;
      }
      const selectedWarTarget = parsedWarTarget.value;

      let resolvedWarTarget = selectedWarTarget;
      if (selectedWarTarget.scope === "current") {
        const guildId = interaction.guildId;
        if (!guildId) {
          await editReplySafe("This command must be used in a server.");
          return;
        }

        const currentWarRow = await prisma.currentWar.findFirst({
          where: {
            guildId,
            AND: [
              {
                OR: [{ clanTag: `#${tag}` }, { clanTag: tag }],
              },
              {
                OR: [
                  { state: { equals: "preparation", mode: "insensitive" } },
                  { state: { equals: "inWar", mode: "insensitive" } },
                ],
              },
            ],
          },
          orderBy: [{ updatedAt: "desc" }],
          select: { warId: true },
        });

        const resolvedCurrentWarId =
          currentWarRow?.warId !== null &&
          currentWarRow?.warId !== undefined &&
          Number.isFinite(Number(currentWarRow.warId)) &&
          Math.trunc(Number(currentWarRow.warId)) > 0
            ? Math.trunc(Number(currentWarRow.warId))
            : null;

        if (resolvedCurrentWarId === null) {
          await editReplySafe("No ongoing war found for that clan.");
          return;
        }

        resolvedWarTarget = {
          scope: "current",
          warId: resolvedCurrentWarId,
          requested: "current" as const,
        };
      }

      console.info(
        `[fwa-compliance] event=start guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} clan=#${tag || "unknown"} scope=${resolvedWarTarget.scope} requested=${resolvedWarTarget.requested} war_id=${resolvedWarTarget.warId}`,
      );
      if (!interaction.inGuild() || !interaction.guildId) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      if (!tag) {
        await editReplySafe("Please provide `tag`.");
        return;
      }

      const trackedClan = await prisma.trackedClan.findFirst({
        where: {
          OR: [
            { tag: { equals: `#${tag}`, mode: "insensitive" } },
            { tag: { equals: tag, mode: "insensitive" } },
          ],
        },
        select: { name: true, tag: true },
      });
      if (!trackedClan) {
        await editReplySafe(`Clan #${tag} is not in tracked clans.`);
        return;
      }

      const evaluation =
        await warComplianceService.evaluateComplianceForCommand({
          guildId: interaction.guildId,
          clanTag: tag,
          scope: resolvedWarTarget.scope,
          warId: resolvedWarTarget.warId,
        });
      const clanDisplayName = trackedClan.name?.trim() || `#${tag}`;
      const startedLabel =
        evaluation.warStartTime instanceof Date
          ? `<t:${Math.floor(evaluation.warStartTime.getTime() / 1000)}:f>`
          : "unknown";
      const endedLabel =
        evaluation.warEndTime instanceof Date
          ? `<t:${Math.floor(evaluation.warEndTime.getTime() / 1000)}:R>`
          : "unknown";

      if (evaluation.status === "no_active_war") {
        await editReplySafe(
          [
            `War compliance for **${clanDisplayName}** (#${tag})`,
            "No active war to evaluate.",
          ].join("\n"),
        );
        console.info(
          `[fwa-compliance] event=complete guild=${interaction.guildId} user=${interaction.user.id} clan=#${tag} scope=${evaluation.scope} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} war_id=${evaluation.warId ?? "unknown"} status=no_active_war duration_ms=${Date.now() - startedAtMs}`,
        );
        return;
      }

      if (evaluation.status === "war_not_found") {
        const requestedWarId =
          selectedWarTarget.scope === "war_id"
            ? String(selectedWarTarget.warId)
            : "unknown";
        await editReplySafe(
          [
            `War compliance for **${clanDisplayName}** (#${tag})`,
            `No ended war found for #${tag} with war ID ${requestedWarId}.`,
          ].join("\n"),
        );
        console.info(
          `[fwa-compliance] event=complete guild=${interaction.guildId} user=${interaction.user.id} clan=#${tag} scope=${evaluation.scope} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} war_id=${selectedWarTarget.scope === "war_id" ? selectedWarTarget.warId : "unknown"} status=war_not_found duration_ms=${Date.now() - startedAtMs}`,
        );
        return;
      }

      if (evaluation.status === "not_applicable") {
        const key = createTransientFwaKey();
        const payload: FwaComplianceViewPayload = {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          clanName: clanDisplayName,
          clanTag: tag,
          isFwa: false,
          warPlanText: null,
          warId: evaluation.warId,
          expectedOutcome: evaluation.expectedOutcome,
          fwaWinGateConfig: null,
          warStartTime: evaluation.warStartTime,
          warEndTime: evaluation.warEndTime,
          participantsCount: evaluation.participantsCount,
          attacksCount: evaluation.attacksCount,
          missedBoth: evaluation.report?.missedBoth ?? [],
          notFollowingPlan: [],
          activeView: "missed",
          mainPage: 0,
          missedPage: 0,
        };
        const rendered = renderComplianceViewPayload({ key, payload });
        fwaComplianceViewPayloads.set(key, payload);
        await interaction.editReply({
          content: undefined,
          embeds: rendered.embeds,
          components: rendered.components,
        });
        console.info(
          `[fwa-compliance] event=complete guild=${interaction.guildId} user=${interaction.user.id} clan=#${tag} scope=${evaluation.scope} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} war_id=${evaluation.warId ?? "unknown"} status=not_applicable match_type=${evaluation.matchType ?? "UNKNOWN"} missed_both=${payload.missedBoth.length} duration_ms=${Date.now() - startedAtMs}`,
        );
        return;
      }

      if (evaluation.status === "insufficient_data" || !evaluation.report) {
        await editReplySafe(
          [
            `War compliance for **${clanDisplayName}** (#${tag})`,
            `War: **${evaluation.warId ?? "unknown"}** | Started ${startedLabel} | Ended ${endedLabel}`,
            "Insufficient data to evaluate compliance for this war.",
          ].join("\n"),
        );
        console.info(
          `[fwa-compliance] event=complete guild=${interaction.guildId} user=${interaction.user.id} clan=#${tag} scope=${evaluation.scope} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} war_id=${evaluation.warId ?? "unknown"} status=insufficient_data participants=${evaluation.participantsCount} attacks=${evaluation.attacksCount} duration_ms=${Date.now() - startedAtMs}`,
        );
        return;
      }

      const warPlanText = await resolveComplianceWarPlanText({
        guildId: interaction.guildId,
        clanTag: evaluation.report.clanTag,
        clanName: evaluation.report.clanName || clanDisplayName,
        opponentName: evaluation.report.opponentName,
        matchType: evaluation.report.matchType,
        expectedOutcome: evaluation.report.expectedOutcome,
        forcedLoseStyle: evaluation.report.loseStyle,
        cocService,
      });

      const key = createTransientFwaKey();
      const payload: FwaComplianceViewPayload = {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        clanName: clanDisplayName,
        clanTag: tag,
        isFwa: true,
        warPlanText,
        warId: evaluation.report.warId ?? evaluation.warId,
        expectedOutcome:
          evaluation.report.expectedOutcome ?? evaluation.expectedOutcome,
        fwaWinGateConfig: evaluation.report.fwaWinGateConfig,
        warStartTime: evaluation.report.warStartTime ?? evaluation.warStartTime,
        warEndTime: evaluation.report.warEndTime ?? evaluation.warEndTime,
        participantsCount: evaluation.report.participantsCount,
        attacksCount: evaluation.report.attacksCount,
        missedBoth: evaluation.report.missedBoth,
        notFollowingPlan: evaluation.report.notFollowingPlan,
        activeView: "fwa_main",
        mainPage: 0,
        missedPage: 0,
      };
      const rendered = renderComplianceViewPayload({ key, payload });
      fwaComplianceViewPayloads.set(key, payload);
      await interaction.editReply({
        content: undefined,
        embeds: rendered.embeds,
        components: rendered.components,
      });
      console.info(
        `[fwa-compliance] event=complete guild=${interaction.guildId} user=${interaction.user.id} clan=#${tag} scope=${evaluation.scope} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} war_id=${evaluation.report.warId ?? evaluation.warId ?? "unknown"} status=ok missed_both=${evaluation.report.missedBoth.length} not_following=${evaluation.report.notFollowingPlan.length} participants=${evaluation.report.participantsCount} attacks=${evaluation.report.attacksCount} war_end_time=${evaluation.timingInputs.warEndTimeIso ?? "unknown"} first_attack_seen_at=${evaluation.timingInputs.firstAttackSeenAtIso ?? "unknown"} last_attack_seen_at=${evaluation.timingInputs.lastAttackSeenAtIso ?? "unknown"} duration_ms=${Date.now() - startedAtMs}`,
      );
      return;
    }

    if (subcommand === "weight-link") {
      const targets = await resolveWeightTargets();
      if (targets.length === 0) {
        await editReplySafe(
          "No tracked clans configured. Provide `tag` or configure tracked clans first.",
        );
        return;
      }
      const lines = targets.map(
        (target) =>
          `${target.clanName} (#${target.tag})\nhttps://fwastats.com/Clan/${target.tag}/Weight`,
      );
      await editReplySafe(
        buildLimitedMessage(
          `FWA Stats Weight Links (${targets.length})`,
          lines,
          "",
        ),
      );
      return;
    }

    if (subcommand === "weight-cookie") {
      if (!interaction.inGuild() || !interaction.guildId) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      const cookiePermissionService = new CommandPermissionService();
      const canManageWeightCookie = await cookiePermissionService.canUseCommand(
        "fwa:weight-cookie",
        interaction,
      );
      if (!canManageWeightCookie) {
        await editReplySafe(
          "You do not have permission to manage fwastats weight cookies in this server.",
        );
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_update",
          source: "api",
          status: "failure",
          errorCategory: "permission",
          errorCode: "weight_cookie_forbidden",
          detail: `guild=${interaction.guildId} user=${interaction.user.id}`,
        });
        return;
      }

      const applicationCookieRaw = interaction.options.getString(
        "application-cookie",
        false,
      );
      const antiforgeryCookieRaw = interaction.options.getString(
        "antiforgery-cookie",
        false,
      );
      const antiforgeryCookieNameRaw = interaction.options.getString(
        "antiforgery-cookie-name",
        false,
      );
      const hasApplicationArg = applicationCookieRaw !== null;
      const hasAntiforgeryArg = antiforgeryCookieRaw !== null;
      const hasAntiforgeryNameArg = antiforgeryCookieNameRaw !== null;

      if (!hasApplicationArg && !hasAntiforgeryArg && !hasAntiforgeryNameArg) {
        const status = await fwaStatsWeightCookieService.getCookieStatus();
        const updatedAtText =
          status.updatedAt && Number.isFinite(status.updatedAt.getTime())
            ? `<t:${Math.floor(status.updatedAt.getTime() / 1000)}:F>`
            : "unknown";
        const expiryText =
          status.applicationCookieExpiresAt &&
          Number.isFinite(status.applicationCookieExpiresAt.getTime())
            ? `<t:${Math.floor(status.applicationCookieExpiresAt.getTime() / 1000)}:F>`
            : "expiration unknown";
        const lines = [
          "FWA Stats Weight Cookie Status",
          `- Application cookie: ${status.applicationCookiePresent ? "present" : "missing"}`,
          `- Antiforgery cookie: ${status.antiforgeryCookiePresent ? "present" : "missing"}`,
          `- Application cookie expiry: ${expiryText}`,
          `- Last updated: ${updatedAtText}`,
          `- Runtime auth source: ${status.runtimeCookieSource}`,
        ];
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_status",
          source: "api",
          status: "success",
          detail: `guild=${interaction.guildId} user=${interaction.user.id} app_present=${status.applicationCookiePresent ? 1 : 0} anti_present=${status.antiforgeryCookiePresent ? 1 : 0} source=${status.runtimeCookieSource}`,
        });
        await editReplySafe(lines.join("\n"), [], []);
        return;
      }

      if (
        hasApplicationArg !== hasAntiforgeryArg ||
        (!hasApplicationArg && hasAntiforgeryNameArg)
      ) {
        await editReplySafe(
          "Provide both `application-cookie` and `antiforgery-cookie` (and optional `antiforgery-cookie-name`), or omit all cookie args to view status.",
          [],
          [],
        );
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_update",
          source: "api",
          status: "failure",
          errorCategory: "validation",
          errorCode: "weight_cookie_partial_input",
          detail: `guild=${interaction.guildId} user=${interaction.user.id}`,
        });
        return;
      }

      const applicationCookie = String(applicationCookieRaw ?? "").trim();
      const antiforgeryCookie = String(antiforgeryCookieRaw ?? "").trim();
      if (!applicationCookie || !antiforgeryCookie) {
        await editReplySafe(
          "Cookie values cannot be empty. Paste both cookie values (or full `name=value` pairs).",
          [],
          [],
        );
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_update",
          source: "api",
          status: "failure",
          errorCategory: "validation",
          errorCode: "weight_cookie_empty_input",
          detail: `guild=${interaction.guildId} user=${interaction.user.id}`,
        });
        return;
      }

      recordFetchEvent({
        namespace: "fwastats_weight",
        operation: "weight_cookie_update",
        source: "api",
        detail: `guild=${interaction.guildId} user=${interaction.user.id} event=attempt`,
      });
      try {
        const saved = await fwaStatsWeightCookieService.setCookies({
          applicationCookieRaw: applicationCookie,
          antiforgeryCookieRaw: antiforgeryCookie,
          antiforgeryCookieNameRaw,
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        fwaStatsWeightService.clearCache();
        const savedAtText = `<t:${Math.floor(saved.savedAt.getTime() / 1000)}:F>`;
        const expiryText =
          saved.applicationCookieExpiresAt &&
          Number.isFinite(saved.applicationCookieExpiresAt.getTime())
            ? `<t:${Math.floor(saved.applicationCookieExpiresAt.getTime() / 1000)}:F>`
            : "expiration unknown";
        await editReplySafe(
          [
            "FWA Stats weight cookies saved.",
            `- Application cookie name: \`${saved.applicationCookieName}\``,
            `- Antiforgery cookie name: \`${saved.antiforgeryCookieName}\``,
            `- Application cookie expiry: ${expiryText}`,
            `- Saved at: ${savedAtText}`,
            "Saved but not yet verified. Run `/fwa weight-age` to validate live access.",
          ].join("\n"),
          [],
          [],
        );
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_update",
          source: "api",
          status: "success",
          detail: `guild=${interaction.guildId} user=${interaction.user.id} event=saved`,
        });
      } catch (err) {
        const safeMessage = String(
          (err as Error)?.message ?? "Invalid cookie input.",
        );
        await editReplySafe(
          `Could not save fwastats cookies. ${safeMessage}`,
          [],
          [],
        );
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_cookie_update",
          source: "api",
          status: "failure",
          errorCategory: "validation",
          errorCode: "weight_cookie_save_failed",
          detail: `guild=${interaction.guildId} user=${interaction.user.id}`,
        });
      }
      return;
    }

    if (subcommand === "weight-age" || subcommand === "weight-health") {
      const targets = await resolveWeightTargets();
      if (targets.length === 0) {
        await editReplySafe(
          "No tracked clans configured. Provide `tag` or configure tracked clans first.",
        );
        return;
      }

      console.info(
        `[fwa-weight] event=command_start cmd=${subcommand} guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} clans=${targets.length}`,
      );
      const startedAtMs = Date.now();
      const results = await fwaStatsWeightService.getWeightAges(
        targets.map((target) => target.tag),
      );
      const byTag = new Map(
        results.map((result) => [normalizeTag(result.clanTag), result]),
      );

      if (subcommand === "weight-age") {
        const lines = targets.map((target) => {
          const result = byTag.get(target.tag);
          if (!result) {
            return `${target.clanName} (#${target.tag}) — unavailable (missing result)`;
          }
          return formatWeightAgeLine({
            clanName: target.clanName,
            clanTag: target.tag,
            result,
          });
        });
        const okCount = results.filter((row) => row.status === "ok").length;
        const cacheHits = results.filter((row) => row.fromCache).length;
        const authNote = buildWeightAuthFailureNote(results);
        await editReplySafe(
          buildLimitedMessage(
            `FWA Weight Age (${targets.length})`,
            lines,
            [
              "",
              `Successful: ${okCount}/${targets.length}`,
              `Cache hits: ${cacheHits}/${targets.length}`,
              ...(authNote ? [authNote] : []),
            ].join("\n"),
          ),
        );
        console.info(
          `[fwa-weight] event=command_complete cmd=weight-age guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} clans=${targets.length} ok=${okCount} cache_hits=${cacheHits} duration_ms=${Date.now() - startedAtMs}`,
        );
        return;
      }

      const lines = targets.map((target) => {
        const result = byTag.get(target.tag);
        if (!result) {
          return `${target.clanName} (#${target.tag}) — unavailable ❓`;
        }
        return formatWeightHealthLine({
          clanName: target.clanName,
          clanTag: target.tag,
          result,
          staleThresholdDays: WEIGHT_STALE_DAYS,
          severeThresholdDays: WEIGHT_SEVERE_STALE_DAYS,
        });
      });
      const okResults = results.filter((row) => row.status === "ok");
      const recentCount = okResults.filter(
        (row) =>
          getWeightHealthState(
            row.ageDays,
            WEIGHT_STALE_DAYS,
            WEIGHT_SEVERE_STALE_DAYS,
          ) === "recent",
      ).length;
      const outdatedCount = okResults.filter(
        (row) =>
          getWeightHealthState(
            row.ageDays,
            WEIGHT_STALE_DAYS,
            WEIGHT_SEVERE_STALE_DAYS,
          ) === "outdated",
      ).length;
      const severeCount = okResults.filter(
        (row) =>
          getWeightHealthState(
            row.ageDays,
            WEIGHT_STALE_DAYS,
            WEIGHT_SEVERE_STALE_DAYS,
          ) === "severely_outdated",
      ).length;
      const unknownCount =
        results.length - (recentCount + outdatedCount + severeCount);
      const authNote = buildWeightAuthFailureNote(results);
      await editReplySafe(
        buildLimitedMessage(
          `FWA Weight Health (${targets.length})`,
          lines,
          [
            "",
            "Legend:",
            "✅ recent",
            "⚠️ outdated",
            "❌ severely outdated",
            "❓ unavailable/unknown",
            `Thresholds: outdated > ${WEIGHT_STALE_DAYS}d, severe >= ${WEIGHT_SEVERE_STALE_DAYS}d`,
            `Summary: recent=${recentCount}, outdated=${outdatedCount}, severe=${severeCount}, unknown=${unknownCount}`,
            ...(authNote ? [authNote] : []),
          ].join("\n"),
        ),
      );
      console.info(
        `[fwa-weight] event=command_complete cmd=weight-health guild=${interaction.guildId ?? "dm"} user=${interaction.user.id} clans=${targets.length} recent=${recentCount} outdated=${outdatedCount} severe=${severeCount} unknown=${unknownCount} duration_ms=${Date.now() - startedAtMs}`,
      );
      return;
    }

    if (subcommand === "points" && !tag) {
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });
      const subByTag = new Map<string, { fwaPoints: number | null }>();
      if (interaction.guildId) {
        const subs = await prisma.currentWar.findMany({
          where: { guildId: interaction.guildId },
          select: { clanTag: true, fwaPoints: true },
        });
        for (const sub of subs) {
          subByTag.set(normalizeTag(sub.clanTag), { fwaPoints: sub.fwaPoints });
        }
      }

      if (tracked.length === 0) {
        await editReplySafe(
          "No tracked clans configured. Use `/tracked-clan configure` or provide a clan tag.",
        );
        return;
      }

      const lines: string[] = [];
      let failedCount = 0;
      let forbiddenCount = 0;
      const warStateByTag = new Map<string, WarStateForSync>();
      const warStartMsByTag = new Map<string, number | null>();
      const activeWarStarts: number[] = [];
      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        const war = await getCurrentWarCached(
          cocService,
          trackedTag,
          warLookupCache,
        ).catch(() => null);
        const warState = deriveWarState(war?.state);
        const warStartMs = parseCocApiTime(war?.startTime);
        warStateByTag.set(trackedTag, warState);
        warStartMsByTag.set(trackedTag, warStartMs);
        if (
          warState !== "notInWar" &&
          warStartMs !== null &&
          Number.isFinite(warStartMs)
        ) {
          activeWarStarts.push(warStartMs);
        }
      }

      const baselineWarStartMs =
        activeWarStarts.length > 0 ? Math.min(...activeWarStarts) : null;
      const nowMs = Date.now();
      const missedSyncTags = new Set<string>();
      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        const warState = warStateByTag.get(trackedTag) ?? "notInWar";
        const warStartMs = warStartMsByTag.get(trackedTag) ?? null;
        if (
          isMissedSyncClan({
            baselineWarStartMs,
            clanWarState: warState,
            clanWarStartMs: warStartMs,
            nowMs,
          })
        ) {
          missedSyncTags.add(trackedTag);
        }
      }

      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        try {
          const war = await getCurrentWarCached(
            cocService,
            trackedTag,
            warLookupCache,
          ).catch(() => null);
          const warState =
            warStateByTag.get(trackedTag) ?? deriveWarState(war?.state);
          const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
          const result = await getClanPointsCached(
            settings,
            cocService,
            trackedTag,
            currentSync,
            warLookupCache,
            { fetchReason: "points_command" },
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
          const trueOpponentTag = normalizeTag(
            String(war?.opponent?.tag ?? ""),
          );
          const mismatch =
            trueOpponentTag &&
            isPointsSiteUpdatedForOpponent(result, trueOpponentTag, sourceSync)
              ? buildPointsMismatchWarning(
                  label,
                  subByTag.get(trackedTag)?.fwaPoints ?? null,
                  result.balance,
                )
              : null;
          lines.push(
            `- ${label} (#${trackedTag}): **${formatPoints(result.balance)}**${
              mismatch ? `\n  ${mismatch}` : ""
            }`,
          );
        } catch (err) {
          failedCount += 1;
          if (getHttpStatus(err) === 403) forbiddenCount += 1;
          console.error(
            `[points] bulk request failed tag=${trackedTag} error=${formatError(err)}`,
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
        summary += `\n${forbiddenCount} request(s) were blocked by points.fwafarm.com (HTTP 403).`;
      }
      summary += `\nSync#: ${
        sourceSync !== null && Number.isFinite(sourceSync)
          ? `#${Math.trunc(sourceSync) + 1}`
          : "unknown"
      }`;
      if (missedSyncTags.size > 0) {
        summary += `\nIgnored for Sync#: ${missedSyncTags.size} missed-sync clan(s).`;
      }
      await editReplySafe(buildLimitedMessage(header, lines, summary));
      return;
    }

    if (subcommand === "match") {
      if (tag) {
        const trackedClan = await prisma.trackedClan.findFirst({
          where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
          select: { tag: true },
        });
        if (!trackedClan) {
          await editReplySafe(`Clan #${tag} is not in tracked clans.`);
          return;
        }
      }
      if (debugMailStatusRequested) {
        if (!matchMailStatusDebugEnabled) {
          await editReplySafe(
            "You do not have permission to use `/fwa match debug-mail-status` in this server.",
          );
          return;
        }
        if (!interaction.inGuild() || !interaction.guildId) {
          await editReplySafe("This command can only be used in a server.");
          return;
        }
        const debugRows = await collectFwaMatchMailStatusDebugRows({
          client: interaction.client,
          guildId: interaction.guildId,
          tag,
        });
        if (debugRows.length === 0) {
          await editReplySafe(
            tag
              ? `Clan #${tag} is not in tracked clans.`
              : "No tracked clans configured. Use `/tracked-clan configure` first.",
          );
          return;
        }
        const debugLines = buildFwaMatchMailStatusDebugSummaryLines(debugRows);
        await editReplySafe(
          buildLimitedMessage(
            `FWA Mail Lifecycle Debug (${debugRows.length})`,
            debugLines,
            "Lifecycle-only diagnostics (no points/war API fetches).",
          ),
          [],
          [],
        );
        return;
      }
      logFwaMatchTelemetry(
        "command",
        `user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} scope=${tag ? "single" : "alliance"} tag=${tag ?? "all"} visibility=${isPublic ? "public" : "private"} source_sync=${sourceSync ?? "unknown"}`,
      );
      const overview = await buildTrackedMatchOverview(
        cocService,
        sourceSync,
        interaction.guildId ?? null,
        warLookupCache,
        interaction.client,
        {
          onlyClanTags: tag ? [tag] : undefined,
          mailStatusDebugEnabled: matchMailStatusDebugEnabled,
        },
      );
      const key = interaction.id;
      if (!tag) {
        console.info(
          `[fwa-match-payload] stage=command_build scope=full guild=${interaction.guildId ?? "none"} source=alliance`,
        );
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
          includePostButton: !isPublic,
          allianceView: {
            embed: overview.embed,
            copyText: overview.copyText,
            matchTypeAction: null,
          },
          allianceViewIsScoped: false,
          singleViews: overview.singleViews,
          currentScope: "alliance",
          currentTag: null,
          revisionDraftByTag: {},
        });
        await editReplySafe(
          "",
          [overview.embed],
          buildFwaMatchCopyComponents(
            fwaMatchCopyPayloads.get(key)!,
            interaction.user.id,
            key,
            "embed",
          ),
        );
        return;
      }

      const trackedSingleView = overview.singleViews[tag];
      if (trackedSingleView) {
        console.info(
          `[fwa-match-payload] stage=command_build scope=scoped guild=${interaction.guildId ?? "none"} source=single_tag tag=#${tag}`,
        );
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
          includePostButton: !isPublic,
          allianceView: {
            embed: overview.embed,
            copyText: overview.copyText,
            matchTypeAction: null,
          },
          allianceViewIsScoped: true,
          singleViews: overview.singleViews,
          currentScope: "single",
          currentTag: tag,
          revisionDraftByTag: {},
        });
        const stored = fwaMatchCopyPayloads.get(key)!;
        await editReplySafe(
          "",
          [trackedSingleView.embed],
          buildFwaMatchCopyComponents(
            stored,
            interaction.user.id,
            key,
            "embed",
          ),
        );
        return;
      }

      let opponentTag = "";
      try {
        const war = await getCurrentWarCached(cocService, tag, warLookupCache);
        const warState = deriveWarState(war?.state);
        const warRemaining = getWarStateRemaining(war, warState);
        const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
        const trackedClanMeta = await prisma.trackedClan.findFirst({
          where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
          select: { name: true },
        });
        const subscription = interaction.guildId
          ? await prisma.currentWar.findUnique({
              where: {
                clanTag_guildId: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: {
                state: true,
                warId: true,
                startTime: true,
                opponentTag: true,
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
        opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
        const warIdForReuse =
          subscription?.warId !== null &&
          subscription?.warId !== undefined &&
          Number.isFinite(subscription?.warId)
            ? String(Math.trunc(subscription.warId))
            : null;
        const warStartTimeForReuse = getWarStartDateForSync(
          subscription?.startTime ?? null,
          war,
        );
        const warScopedIdentityFilters = [
          warIdForReuse ? { warId: warIdForReuse } : null,
          warStartTimeForReuse ? { warStartTime: warStartTimeForReuse } : null,
        ].filter(
          (clause): clause is NonNullable<typeof clause> => clause !== null,
        );
        const warScopedSyncRows =
          interaction.guildId && warScopedIdentityFilters.length > 0
            ? await prisma.clanPointsSync.findMany({
                where: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                  needsValidation: false,
                  OR: warScopedIdentityFilters,
                },
                select: {
                  clanTag: true,
                  warId: true,
                  warStartTime: true,
                  syncNum: true,
                  opponentTag: true,
                  clanPoints: true,
                  opponentPoints: true,
                  isFwa: true,
                  needsValidation: true,
                  lastSuccessfulPointsApiFetchAt: true,
                  syncFetchedAt: true,
                },
                orderBy: [
                  { warStartTime: "desc" },
                  { syncFetchedAt: "desc" },
                  { updatedAt: "desc" },
                ],
              })
            : [];
        const warScopedSyncRowsByClanTag =
          groupWarScopedSyncRowsByClanTag(warScopedSyncRows);
        if (
          warState === "notInWar" ||
          !opponentTag ||
          subscription?.state === "notInWar"
        ) {
          const clanProfile = await cocService
            .getClan(`#${tag}`)
            .catch(() => null);
          const memberCount = Array.isArray(clanProfile?.members)
            ? clanProfile.members.length
            : Number.isFinite(Number(clanProfile?.members))
              ? Number(clanProfile?.members)
              : null;
          const livePoints = await getClanPointsCached(
            settings,
            cocService,
            tag,
            sourceSync,
            warLookupCache,
          ).catch(() => null);
          const clanPoints =
            livePoints?.balance ?? subscription?.fwaPoints ?? null;
          const outOfSync =
            subscription?.fwaPoints !== null &&
            subscription?.fwaPoints !== undefined &&
            livePoints?.balance !== null &&
            livePoints?.balance !== undefined &&
            Number(subscription.fwaPoints) !== Number(livePoints.balance);
          const actualByTag = await getActualSheetSnapshotCached(
            settings,
          ).catch(() => new Map<string, ActualSheetClanSnapshot>());
          const actual = actualByTag.get(tag) ?? null;
          const preWarMailStatus = await resolveLiveWarMailStatus({
            client: interaction.client,
            guildId: interaction.guildId ?? null,
            tag,
            warId: subscription?.warId ?? null,
            emitDebugLog: matchMailStatusDebugEnabled,
          });
          const mailStatusEmoji = preWarMailStatus.mailStatusEmoji;
          const preWarMailDebugLines = matchMailStatusDebugEnabled
            ? buildMailStatusDebugLines(preWarMailStatus.debug)
            : [];
          const clanName =
            sanitizeClanName(trackedClanMeta?.name ?? "") ?? `#${tag}`;
          const preWarHeader = `${mailStatusEmoji} | ${clanName} (#${tag})`;
          const preWarLines = [
            outOfSync
              ? ":warning: out of sync with points site"
              : ":white_check_mark: data in sync with points site",
            `Clan points: **${clanPoints !== null && clanPoints !== undefined ? clanPoints : "unknown"}**`,
            `Members: **${memberCount ?? "?"}/50**`,
            `Total weight (ACTUAL): **${actual?.totalWeight ?? "unknown"}**`,
            `Weight compo (ACTUAL): ${actual?.weightCompo ?? "unknown"}`,
            `Weight deltas (ACTUAL): ${actual?.weightDeltas ?? "unknown"}`,
            `Compo advice (ACTUAL): ${actual?.compoAdvice ?? "none"}`,
            `War State: **${formatWarStateLabel(warState)}**`,
            `Time Remaining: **${warRemaining}**`,
            `Sync: **${withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync)}**`,
            formatMailLifecycleStatusLine(preWarMailStatus.status),
            ...preWarMailDebugLines,
          ];
          const singleView: MatchView = {
            embed: new EmbedBuilder()
              .setTitle(preWarHeader)
              .setDescription(preWarLines.join("\n"))
              .setColor(
                resolveSingleClanMatchEmbedColor({
                  effectiveMatchType:
                    (subscription?.matchType as
                      | "FWA"
                      | "BL"
                      | "MM"
                      | "SKIP"
                      | "UNKNOWN"
                      | null
                      | undefined) ?? "UNKNOWN",
                  effectiveExpectedOutcome: null,
                }),
              ),
            copyText: limitDiscordContent(
              [`# ${preWarHeader}`, ...preWarLines].join("\n"),
            ),
            matchTypeAction: null,
            matchTypeCurrent:
              (subscription?.matchType as
                | "FWA"
                | "BL"
                | "MM"
                | "SKIP"
                | null
                | undefined) ?? null,
            inferredMatchType: false,
            outcomeAction: null,
            syncAction: null,
            clanName,
            clanTag: tag,
            mailStatusEmoji,
            skipSyncAction: subscription?.matchType === "SKIP" ? null : { tag },
            undoSkipSyncAction:
              subscription?.matchType === "SKIP" ? { tag } : null,
          };
          console.info(
            `[fwa-match-payload] stage=command_build scope=scoped guild=${interaction.guildId ?? "none"} source=single_tag_prewar tag=#${tag}`,
          );
          fwaMatchCopyPayloads.set(key, {
            userId: interaction.user.id,
            guildId: interaction.guildId ?? null,
            includePostButton: !isPublic,
            allianceView: {
              embed: overview.embed,
              copyText: overview.copyText,
              matchTypeAction: null,
            },
            allianceViewIsScoped: true,
            singleViews: {
              ...overview.singleViews,
              [tag]: singleView,
            },
            currentScope: "single",
            currentTag: tag,
            revisionDraftByTag: {},
          });
          const stored = fwaMatchCopyPayloads.get(key)!;
          await editReplySafe(
            "",
            [singleView.embed],
            buildFwaMatchCopyComponents(
              stored,
              interaction.user.id,
              key,
              "embed",
            ),
          );
          return;
        }

        const warScopedSnapshot = resolveWarScopedSnapshotForMatch({
          rows: warScopedSyncRowsByClanTag.get(tag) ?? [],
          clanTag: tag,
          warId: warIdForReuse,
          warStartTime: warStartTimeForReuse,
          opponentTag,
          currentSyncNumber: currentSync,
          sourceSyncNumber: sourceSync,
        });
        const primary = await getClanPointsCached(
          settings,
          cocService,
          tag,
          currentSync,
          warLookupCache,
          {
            requiredOpponentTag: opponentTag,
            fetchReason: "match_render",
            warScopedSnapshot,
          },
        );
        let opponent: PointsSnapshot;
        const siteUpdatedFromPrimary = isPointsSiteUpdatedForOpponent(
          primary,
          opponentTag,
          sourceSync,
        );
        const opponentFromPrimary = siteUpdatedFromPrimary
          ? deriveOpponentBalanceFromPrimarySnapshot(primary, tag, opponentTag)
          : null;
        if (
          opponentFromPrimary !== null &&
          !Number.isNaN(opponentFromPrimary)
        ) {
          opponent = {
            ...primary,
            tag: opponentTag,
            balance: opponentFromPrimary,
            clanName:
              sanitizeClanName(String(war?.opponent?.name ?? "")) ??
              opponentTag,
            activeFwa: null,
            winnerBoxHasTag: true,
          };
        } else {
          opponent = await getClanPointsCached(
            settings,
            cocService,
            opponentTag,
            currentSync,
            warLookupCache,
            {
              fetchReason: "match_render",
              fallbackTrackedClanTag: tag,
            },
          );
        }
        const fallbackResolution = await resolveMatchTypeWithFallback({
          guildId: interaction.guildId ?? null,
          clanTag: tag,
          opponentTag,
          warState,
          warId: subscription?.warId ?? null,
          warStartTime: warStartTimeForReuse,
          existingMatchType: subscription?.matchType ?? null,
          existingInferredMatchType: subscription?.inferredMatchType ?? null,
        });
        if (fallbackResolution.confirmedCurrent === null) {
          const opponentForInference = await getClanPointsCached(
            settings,
            cocService,
            opponentTag,
            currentSync,
            warLookupCache,
            {
              fetchReason: "match_render",
              fallbackTrackedClanTag: tag,
            },
          ).catch(() => null);
          if (opponentForInference) {
            const hasDerivedOpponentBalance =
              opponent.balance !== null &&
              opponent.balance !== undefined &&
              !Number.isNaN(opponent.balance);
            const hasFetchedOpponentBalance =
              opponentForInference.balance !== null &&
              opponentForInference.balance !== undefined &&
              !Number.isNaN(opponentForInference.balance);
            opponent =
              hasDerivedOpponentBalance && !hasFetchedOpponentBalance
                ? { ...opponentForInference, balance: opponent.balance }
                : opponentForInference;
          }
        }
        const trackedPair = await prisma.trackedClan.findMany({
          select: { name: true, tag: true },
        });
        const trackedNameByTag = new Map(
          trackedPair.map((c) => [
            normalizeTag(c.tag),
            sanitizeClanName(c.name),
          ]),
        );

        const hasPrimaryPoints =
          primary.balance !== null && !Number.isNaN(primary.balance);
        const hasOpponentPoints =
          opponent.balance !== null && !Number.isNaN(opponent.balance);
        const siteUpdated = isPointsValidationCurrentForMatchup({
          primarySnapshot: primary,
          opponentSnapshot: opponent,
          opponentTag,
          sourceSync,
        });
        const siteSyncObservedForWrite = resolveObservedSyncNumberForMatchup({
          primarySnapshot: primary,
          opponentSnapshot: opponent,
        });
        if (
          siteUpdated &&
          !siteUpdatedFromPrimary &&
          opponent.snapshotSource === "tracked_clan_fallback"
        ) {
          console.info(
            `[fwa-sync-validation] stage=single_view proof=tracked_fallback clan=#${tag} opponent=#${opponentTag} sync=${siteSyncObservedForWrite ?? "unknown"}`,
          );
        }
        const winnerBoxNotMarkedFwa = hasWinnerBoxNotMarkedFwaSignal(
          primary.winnerBoxText ?? null,
        );
        const strongOpponentEvidencePresent =
          opponent.notFound === true ||
          opponent.activeFwa === true ||
          opponent.activeFwa === false;
        const activeWarInference = buildActiveWarMatchInferenceOptions({
          warState,
          clanAttacksUsed: war?.clan?.attacks ?? null,
          clanStars: war?.clan?.stars ?? null,
          opponentStars: war?.opponent?.stars ?? null,
        });
        if (!hasPrimaryPoints && hasOpponentPoints) {
          await editReplySafe(`Could not fetch point balance for #${tag}.`);
          return;
        }
        if (hasPrimaryPoints && !hasOpponentPoints) {
          await editReplySafe(
            `Could not fetch point balance for #${opponentTag}.`,
          );
          return;
        }
        const inferredFromPointsType = inferMatchTypeFromPointsSnapshots(
          primary,
          opponent,
          {
            winnerBoxNotMarkedFwa,
            opponentEvidenceMissingOrNotCurrent:
              !siteUpdated || !strongOpponentEvidencePresent,
            ...activeWarInference,
          },
        );
        const pointsResolution = toMatchTypeResolutionFromPointsInference(
          inferredFromPointsType,
        );
        const guardedFallbackResolution =
          applyExplicitOpponentNotFoundFallbackGuard({
            fallbackResolution,
            opponentNotFoundExplicitly: opponent.notFound === true,
            hasSameWarExplicitFwaConfirmation:
              hasSameWarExplicitFwaConfirmation({
                fallbackResolution,
                currentWarStartTime: subscription?.startTime ?? null,
                currentWarOpponentTag: subscription?.opponentTag ?? null,
                activeWarStartTime: getWarStartDateForSync(null, war),
                activeOpponentTag: opponentTag,
              }),
          });
        const appliedResolution = chooseMatchTypeResolution({
          confirmedCurrent: guardedFallbackResolution.confirmedCurrent,
          liveOpponent: pointsResolution,
          storedSync: guardedFallbackResolution.storedSync,
          unconfirmedCurrent: guardedFallbackResolution.unconfirmedCurrent,
        });
        if (!appliedResolution) {
          await editReplySafe(
            "Unable to resolve match type from current data.",
          );
          return;
        }
        const matchType = appliedResolution.matchType;
        const syncIsFwaSignal =
          appliedResolution.syncIsFwa ??
          (matchType === "FWA" ? true : matchType === "BL" ? false : false);
        logMatchTypeResolution({
          stage: "single_view",
          clanTag: tag,
          opponentTag,
          warId: subscription?.warId ?? null,
          source: appliedResolution.source,
          matchType: appliedResolution.matchType,
          inferred: appliedResolution.inferred,
          confirmed: appliedResolution.confirmed,
        });
        console.info(
          `[fwa-matchtype] stage=single_view_active_fwa clan=#${tag} opponent=#${opponentTag} parsed_active_fwa=${opponent.activeFwa === null || opponent.activeFwa === undefined ? "unknown" : opponent.activeFwa ? "yes" : "no"} not_found=${opponent.notFound ? "1" : "0"} source=${appliedResolution.source} sync_is_fwa=${syncIsFwaSignal ? "1" : "0"}`,
        );
        const derivedOutcome = deriveProjectedOutcome(
          tag,
          opponentTag,
          primary.balance,
          opponent.balance,
          currentSync,
        );
        const inferredMatchType = appliedResolution.inferred;
        const effectiveOutcome =
          (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ??
          (matchType === "FWA" ? derivedOutcome : null);
        const effectiveExpectedOutcome = resolveEffectiveFwaOutcome({
          matchType,
          explicitOutcome: effectiveOutcome,
          projectedOutcome: derivedOutcome,
        });
        if (interaction.guildId) {
          await prisma.currentWar.upsert({
            where: {
              clanTag_guildId: {
                guildId: interaction.guildId,
                clanTag: `#${tag}`,
              },
            },
            create: {
              guildId: interaction.guildId,
              clanTag: `#${tag}`,
              notify: false,
              channelId: interaction.channelId,
              matchType: matchType,
              inferredMatchType,
              fwaPoints: primary.balance,
              opponentFwaPoints: opponent.balance,
              outcome: effectiveOutcome,
              warStartFwaPoints: primary.balance,
              warEndFwaPoints: subscription?.warEndFwaPoints ?? null,
            },
            update: {
              matchType: matchType,
              inferredMatchType,
              fwaPoints: primary.balance,
              opponentFwaPoints: opponent.balance,
              outcome: effectiveOutcome,
              warStartFwaPoints: { set: primary.balance },
              warEndFwaPoints: undefined,
            },
          });
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

        const leftName = resolvedPrimaryName ?? primaryNameFromApi ?? tag;
        const rightName =
          resolvedOpponentName ?? opponentNameFromApi ?? opponentTag;
        const trackedMismatch = siteUpdated
          ? buildPointsMismatchWarning(
              leftName,
              subscription?.fwaPoints ?? null,
              primary.balance,
            )
          : null;
        const opponentMismatch = siteUpdated
          ? buildPointsMismatchWarning(
              rightName,
              subscription?.opponentFwaPoints ?? null,
              opponent.balance,
            )
          : null;
        const warStartTimeForSync = getWarStartDateForSync(
          subscription?.startTime ?? null,
          war,
        );
        await persistClanPointsSyncIfCurrent({
          guildId: interaction.guildId,
          clanTag: tag,
          warId: subscription?.warId ?? null,
          warStartTime: warStartTimeForSync,
          siteCurrent: siteUpdated,
          syncNum: siteSyncObservedForWrite,
          opponentTag,
          clanPoints: primary.balance,
          opponentPoints: opponent.balance,
          outcome: effectiveOutcome,
          isFwa: syncIsFwaSignal,
          fetchedAtMs: primary.fetchedAtMs,
          fetchReason: "match_render",
          matchType,
          opponentNotFound: opponent.notFound,
        });
        const syncRow = await pointsSyncService.getCurrentSyncForClan({
          guildId: interaction.guildId ?? "",
          clanTag: tag,
          warId:
            subscription?.warId !== null &&
            subscription?.warId !== undefined &&
            Number.isFinite(subscription?.warId)
              ? String(Math.trunc(subscription.warId))
              : null,
          warStartTime: warStartTimeForSync,
        });
        const validationState = buildSyncValidationState({
          syncRow,
          currentWarId: subscription?.warId ?? null,
          currentWarStartTime: warStartTimeForSync,
          siteCurrent: siteUpdated,
          syncNum: siteSyncObservedForWrite,
          opponentTag,
          clanPoints: primary.balance,
          opponentPoints: opponent.balance,
          outcome: effectiveOutcome,
          isFwa: syncIsFwaSignal,
          effectiveMatchType: matchType,
          effectiveExpectedOutcome,
          opponentNotFound: opponent.notFound,
        });
        const storedSyncSummary = buildStoredSyncSummary({
          syncRow,
          fallbackSyncNum: siteSyncObservedForWrite,
          warId: subscription?.warId ?? null,
          warStartTime: warStartTimeForSync,
          opponentNotFound: opponent.notFound,
          validationState,
        });
        const siteSyncObserved = resolveObservedSyncNumberForMatchup({
          primarySnapshot: primary,
          opponentSnapshot: opponent,
        });
        const syncMismatch = siteUpdated
          ? buildSyncMismatchWarning(currentSync, siteSyncObserved)
          : null;
        const effectiveMismatchWarnings = buildEffectiveMatchMismatchWarnings({
          siteUpdated,
          effectiveMatchType: matchType,
          effectiveExpectedOutcome,
          projectedOutcome: derivedOutcome,
          opponentActiveFwaEvidence: resolveOpponentActiveFwaEvidence({
            opponentActiveFwa: opponent.activeFwa,
            opponentNotFound: opponent.notFound,
            resolutionSource: appliedResolution.source,
          }),
        });
        const validationMismatchLines = storedSyncSummary.stateLine
          ? validationState.differences.join("\n")
          : "";
        const isWarChangingState = Boolean(storedSyncSummary.stateLine);
        const mismatchLines = isWarChangingState
          ? validationMismatchLines
          : [
              trackedMismatch,
              opponentMismatch,
              syncMismatch,
              effectiveMismatchWarnings.outcomeMismatch,
              effectiveMismatchWarnings.matchTypeVsFwaMismatch,
              validationMismatchLines,
            ]
              .filter(Boolean)
              .join("\n");
        const hasMismatch = Boolean(
          trackedMismatch ||
          opponentMismatch ||
          syncMismatch ||
          effectiveMismatchWarnings.outcomeMismatch ||
          effectiveMismatchWarnings.matchTypeVsFwaMismatch ||
          validationState.differences.length > 0,
        );
        const siteStatusLine = validationState.statusLine;
        const trackedMailConfig = await getTrackedClanMailConfig(tag);
        const renderedMatchTypeForMailGate =
          matchType === "FWA" || matchType === "BL" || matchType === "MM"
            ? matchType
            : "UNKNOWN";
        const mailSendGate = await resolveMailSendGateForRenderedState({
          client: interaction.client,
          guildId: interaction.guildId ?? "",
          tag,
          hasMailChannel: Boolean(trackedMailConfig?.mailChannelId),
          inferredMatchType,
          emitDebugLog: matchMailStatusDebugEnabled,
          warId: subscription?.warId ?? null,
          warStartMs: warStartTimeForSync?.getTime?.() ?? null,
          opponentTag,
          matchType: renderedMatchTypeForMailGate,
          expectedOutcome:
            renderedMatchTypeForMailGate === "FWA"
              ? (effectiveExpectedOutcome ?? "UNKNOWN")
              : null,
        });
        const liveMailStatus = mailSendGate.mailStatus;
        const mailBlockedReason = mailSendGate.mailBlockedReason;
        const mailStatusLine = formatMailLifecycleStatusLine(
          mailSendGate.mailStatus.status,
          {
            hasConfirmedBaseline: Boolean(
              mailSendGate.confirmedRevisionBaseline,
            ),
            draftDiffersFromBaseline: mailSendGate.draftDiffersFromBaseline,
          },
        );
        const mailBlockedReasonLine =
          formatMailBlockedReason(mailBlockedReason);
        const mailDebugLines = matchMailStatusDebugEnabled
          ? buildMailStatusDebugLines(liveMailStatus.debug)
          : [];
        const outcomeLine =
          matchType === "FWA" ? `${effectiveExpectedOutcome ?? "UNKNOWN"}` : "";
        const matchTypeText = `${matchType}${inferredMatchType ? " :warning:" : ""}`;
        const verifyLink = inferredMatchType
          ? `[cc:${opponentTag}](${buildCcVerifyUrl(opponentTag)})`
          : "";
        const singleClanLinks = buildSingleClanMatchLinks({
          trackedClanTag: tag,
          opponentTag,
        });
        const singleHeader = buildMatchStatusHeader({
          clanName: leftName,
          clanTag: tag,
          opponentName: rightName,
          opponentTag,
          matchType,
          outcome: effectiveExpectedOutcome ?? "UNKNOWN",
          mailStatusEmoji: liveMailStatus.mailStatusEmoji,
        });
        const leftWinnerMarker = getWinnerMarkerForSide(
          effectiveExpectedOutcome ?? null,
          "clan",
        );
        const rightWinnerMarker = getWinnerMarkerForSide(
          effectiveExpectedOutcome ?? null,
          "opponent",
        );
        const singleDescription = [
          inferredMatchType ? `${MATCHTYPE_WARNING_LEGEND}\n\u200B` : "",
          `Match Type: **${matchTypeText}**${verifyLink ? ` ${verifyLink}` : ""}`,
          outcomeLine ? `Expected outcome: **${outcomeLine}**` : "",
          siteStatusLine,
          storedSyncSummary.stateLine,
          mailStatusLine,
          mailBlockedReasonLine ?? "",
          `War state: **${formatWarStateLabel(warState)}**`,
          `Time remaining: **${warRemaining}**`,
          `Sync #: **${storedSyncSummary.syncLine}**`,
          storedSyncSummary.updatedLine
            ? `Last points fetch: **${storedSyncSummary.updatedLine}**`
            : "",
          mismatchLines,
          ...mailDebugLines,
        ]
          .filter(Boolean)
          .join("\n");
        const embed = new EmbedBuilder()
          .setTitle(singleHeader)
          .setDescription(singleDescription)
          .setColor(
            resolveSingleClanMatchEmbedColor({
              effectiveMatchType: matchType,
              effectiveExpectedOutcome,
            }),
          )
          .addFields(
            {
              name: singleClanLinks.pointsFieldName,
              value:
                matchType === "FWA"
                  ? hasPrimaryPoints && hasOpponentPoints
                    ? `${leftName}: **${primary.balance}**${leftWinnerMarker}\n${rightName}: **${opponent.balance}**${rightWinnerMarker}`
                    : "Unavailable on both clans."
                  : hasPrimaryPoints
                    ? `${leftName}: **${primary.balance}**`
                    : "Unavailable",
              inline: true,
            },
            {
              name: singleClanLinks.linksFieldName,
              value: singleClanLinks.linksFieldValue,
              inline: true,
            },
          );
        const copyText = limitDiscordContent(
          [
            `# ${singleHeader}`,
            inferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
            siteStatusLine,
            storedSyncSummary.stateLine,
            mailStatusLine.replace(/\*\*/g, ""),
            mailBlockedReasonLine
              ? `${mailBlockedReasonLine.replace(/^:warning: /, "Warning: ").replace(/^:envelope_with_arrow: /, "Mail: ")}`
              : "",
            `Sync #: ${storedSyncSummary.syncLine}`,
            storedSyncSummary.updatedLine
              ? `Last points fetch: ${storedSyncSummary.updatedLine}`
              : "",
            `War State: ${formatWarStateLabel(warState)}`,
            `Time Remaining: ${warRemaining}`,
            `## Opponent Name`,
            `\`${rightName}\``,
            `## Opponent Tag`,
            `\`${opponentTag}\``,
            ...singleClanLinks.copyLines,
            `## Points`,
            hasPrimaryPoints && hasOpponentPoints
              ? `${leftName}: ${primary.balance}${leftWinnerMarker}`
              : "Unavailable",
            matchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
              ? `${rightName}: ${opponent.balance}${rightWinnerMarker}`
              : "",
            `Match Type: ${matchTypeText}`,
            verifyLink ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
            outcomeLine ? `Expected outcome: ${outcomeLine}` : "",
            mismatchLines,
            ...mailDebugLines,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        let alliance = overview;
        const syncActionSiteMatchType: "FWA" | "BL" | "MM" | null =
          inferredFromPointsType &&
          (inferredFromPointsType.matchType === "FWA" ||
            inferredFromPointsType.matchType === "BL" ||
            inferredFromPointsType.matchType === "MM")
            ? inferredFromPointsType.matchType
            : null;
        const syncActionSiteOutcome = deriveSyncActionSiteOutcome({
          siteMatchType: syncActionSiteMatchType,
          projectedOutcome: derivedOutcome,
        });
        const singleView: MatchView = {
          embed,
          copyText,
          matchTypeAction:
            inferredMatchType &&
            (matchType === "FWA" || matchType === "BL" || matchType === "MM")
              ? { tag, currentType: matchType }
              : null,
          matchTypeCurrent: matchType as "FWA" | "BL" | "MM" | "SKIP",
          inferredMatchType,
          outcomeAction:
            matchType === "FWA" &&
            (effectiveExpectedOutcome === "WIN" ||
              effectiveExpectedOutcome === "LOSE")
              ? { tag, currentOutcome: effectiveExpectedOutcome }
              : null,
          syncAction:
            siteUpdated && hasMismatch
              ? {
                  tag,
                  siteMatchType: syncActionSiteMatchType,
                  siteFwaPoints: primary.balance,
                  siteOpponentFwaPoints: opponent.balance,
                  siteOutcome: syncActionSiteOutcome,
                  siteSyncNumber: siteSyncObserved,
                }
              : null,
          mailAction: {
            tag,
            enabled: !mailBlockedReason,
            reason: mailBlockedReason,
          },
        };
        alliance = {
          ...alliance,
          singleViews: {
            ...alliance.singleViews,
            [tag]: singleView,
          },
        };
        console.info(
          `[fwa-match-payload] stage=command_build scope=scoped guild=${interaction.guildId ?? "none"} source=single_tag_live tag=#${tag}`,
        );
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
          includePostButton: !isPublic,
          allianceView: {
            embed: alliance.embed,
            copyText: alliance.copyText,
            matchTypeAction: null,
          },
          allianceViewIsScoped: true,
          singleViews: alliance.singleViews,
          currentScope: "single",
          currentTag: tag,
          revisionDraftByTag: {},
        });
        const stored = fwaMatchCopyPayloads.get(key)!;
        await editReplySafe(
          "",
          [embed],
          buildFwaMatchCopyComponents(
            stored,
            interaction.user.id,
            key,
            "embed",
          ),
        );
        return;
      } catch (err) {
        console.error(
          `[points] matchup request failed tag=${tag} opponent=${opponentTag} error=${formatError(err)}`,
        );
        if (getHttpStatus(err) === 403) {
          await editReplySafe(
            "points.fwafarm.com blocked this request (HTTP 403). Try again later.",
          );
          return;
        }
        await editReplySafe(
          "Failed to fetch points matchup. Check both tags and try again.",
        );
        return;
      }
    }

    try {
      if (!tag) {
        await editReplySafe("Please provide `tag`.");
        return;
      }
      const war = await getCurrentWarCached(
        cocService,
        tag,
        warLookupCache,
      ).catch(() => null);
      const warState = deriveWarState(war?.state);
      const warRemaining = getWarStateRemaining(war, warState);
      const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
      const result = await getClanPointsCached(
        settings,
        cocService,
        tag,
        currentSync,
        warLookupCache,
        { fetchReason: "points_command" },
      );
      const balance = result.balance;
      if (balance === null || Number.isNaN(balance)) {
        if (result.notFound) {
          await editReplySafe(
            `No points data found for #${tag}. Check the clan tag and try again.`,
          );
          return;
        }

        console.error(
          `[points] could not parse point balance for tag=${tag} url=${result.url}`,
        );
        await editReplySafe(
          "Could not parse point balance from points.fwafarm.com right now. Try again later.",
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
        trackedName ?? scrapedName ?? apiName ?? "Unknown Clan";
      const subscription = interaction.guildId
        ? await prisma.currentWar.findUnique({
            where: {
              clanTag_guildId: {
                guildId: interaction.guildId,
                clanTag: `#${tag}`,
              },
            },
            select: { fwaPoints: true, outcome: true, matchType: true },
          })
        : null;
      const trueOpponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
      const siteUpdatedForCurrentWar = trueOpponentTag
        ? isPointsSiteUpdatedForOpponent(result, trueOpponentTag, sourceSync)
        : false;
      const pointsMismatch = siteUpdatedForCurrentWar
        ? buildPointsMismatchWarning(
            displayName,
            subscription?.fwaPoints ?? null,
            balance,
          )
        : null;
      const expectedSync = getCurrentSyncFromPrevious(sourceSync, warState);
      const siteSyncObserved = result.winnerBoxSync ?? null;
      const syncMismatch = siteUpdatedForCurrentWar
        ? buildSyncMismatchWarning(expectedSync, siteSyncObserved)
        : null;
      const opponentBalanceForOutcome = trueOpponentTag
        ? deriveOpponentBalanceFromPrimarySnapshot(result, tag, trueOpponentTag)
        : null;
      const siteOutcome =
        siteUpdatedForCurrentWar && trueOpponentTag
          ? deriveProjectedOutcome(
              tag,
              trueOpponentTag,
              balance,
              opponentBalanceForOutcome,
              siteSyncObserved,
            )
          : null;
      const outcomeMismatch =
        siteUpdatedForCurrentWar && subscription?.matchType === "FWA"
          ? buildOutcomeMismatchWarning(
              (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ??
                null,
              siteOutcome,
            )
          : null;
      const mismatchLines = [pointsMismatch, syncMismatch, outcomeMismatch]
        .filter(Boolean)
        .join("\n");
      const syncStatusLine = buildPointsSyncStatusLine(
        siteUpdatedForCurrentWar,
        Boolean(pointsMismatch || syncMismatch || outcomeMismatch),
      );

      await editReplySafe(
        `Clan Name: **${displayName}**\nTag: #${tag}\nPoint Balance: **${formatPoints(
          balance,
        )}**\nWar state: ${formatWarStateLabel(warState)}\nTime remaining: ${warRemaining}\nSync: ${getSyncDisplay(
          sourceSync,
          warState,
        )}\n${syncStatusLine}${mismatchLines ? `\n${mismatchLines}` : ""}\n${buildOfficialPointsUrl(tag)}`,
      );
    } catch (err) {
      console.error(
        `[points] request failed tag=${tag} error=${formatError(err)}`,
      );
      if (getHttpStatus(err) === 403) {
        await editReplySafe(
          "points.fwafarm.com blocked this request (HTTP 403). Try again later.",
        );
        return;
      }
      await editReplySafe(
        "Failed to fetch points. Check the tag and try again.",
      );
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand === "compliance" && focused.name === "war-id") {
      const choices = await getClanScopedWarIdAutocompleteChoices({
        rawClanTag: interaction.options.getString("tag", false),
        focusedText: String(focused.value ?? ""),
        includeOngoing: true,
        guildId: interaction.guildId,
      });
      await interaction.respond(choices);
      return;
    }

    if (focused.name !== "tag" && focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "")
      .trim()
      .toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((c) => {
        const normalized = normalizeTag(c.tag);
        const label = c.name?.trim()
          ? `${c.name.trim()} (#${normalized})`
          : `#${normalized}`;
        return { name: label.slice(0, 100), value: normalized };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query),
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
