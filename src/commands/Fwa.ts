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
import { truncateDiscordContent } from "../helper/discordContent";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  CommandPermissionService,
  FWA_LEADER_ROLE_SETTING_KEY,
} from "../services/CommandPermissionService";
import { GoogleSheetsService } from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";
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
  isMissedSyncClanForTest,
  isPointsSiteUpdatedForOpponent,
  type WarStateForSync,
  withSyncModeLabel,
} from "./fwa/matchState";
export { isMissedSyncClanForTest } from "./fwa/matchState";

const POINTS_BASE_URL = "https://points.fwafarm.com/clan?tag=";
const TIEBREAK_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DISCORD_CONTENT_MAX = 2000;
const POINTS_CACHE_VERSION = 5;
const POINTS_POST_BUTTON_PREFIX = "points-post-channel";
const FWA_MATCH_COPY_BUTTON_PREFIX = "fwa-match-copy";
const FWA_MATCH_TYPE_ACTION_PREFIX = "fwa-match-type-action";
const FWA_MATCH_TYPE_EDIT_PREFIX = "fwa-match-type-edit";
const FWA_OUTCOME_ACTION_PREFIX = "fwa-outcome-action";
const FWA_MATCH_SYNC_ACTION_PREFIX = "fwa-match-sync-action";
const FWA_MATCH_SKIP_SYNC_ACTION_PREFIX = "fwa-match-skip-sync-action";
const FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX = "fwa-match-skip-sync-confirm";
const FWA_MATCH_SKIP_SYNC_UNDO_PREFIX = "fwa-match-skip-sync-undo";
const FWA_MATCH_SELECT_PREFIX = "fwa-match-select";
const FWA_MATCH_ALLIANCE_PREFIX = "fwa-match-alliance";
const FWA_MAIL_CONFIRM_PREFIX = "fwa-mail-confirm";
const FWA_MAIL_REFRESH_PREFIX = "fwa-mail-refresh";
const FWA_MATCH_SEND_MAIL_PREFIX = "fwa-match-send-mail";
const MAILBOX_SENT_EMOJI = "📬";
const MAILBOX_NOT_SENT_EMOJI = "📭";
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


function getOwnerBypassIds(): Set<string> {
  const raw = process.env.OWNER_DISCORD_USER_IDS ?? process.env.OWNER_DISCORD_USER_ID ?? "";
  const ids = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
  return new Set(ids);
}

function hasOwnerBypassUserId(userId: string): boolean {
  return getOwnerBypassIds().has(userId);
}

async function getButtonInteractionRoleIds(interaction: ButtonInteraction): Promise<string[]> {
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

async function canUseFwaMailSendFromButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  if (hasOwnerBypassUserId(interaction.user.id)) return true;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

  const permissionService = new CommandPermissionService();
  const explicitRoles = await permissionService.getAllowedRoleIds("fwa:mail:send");
  const userRoles = await getButtonInteractionRoleIds(interaction);
  if (explicitRoles.length > 0) {
    return explicitRoles.some((roleId) => userRoles.includes(roleId));
  }

  const leaderRoleId =
    (await permissionService.getFwaLeaderRoleId(interaction.guildId)) ??
    (await new SettingsService().get(`${FWA_LEADER_ROLE_SETTING_KEY}:${interaction.guildId}`));
  if (!leaderRoleId) return false;
  return userRoles.includes(leaderRoleId);
}

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

function logFwaMatchTelemetry(event: string, detail: string): void {
  console.log(`[telemetry-fwa-match] event=${event} ${detail}`);
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

type MatchView = {
  embed: EmbedBuilder;
  copyText: string;
  matchTypeAction?: { tag: string; currentType: "FWA" | "BL" | "MM" } | null;
  matchTypeCurrent?: "FWA" | "BL" | "MM" | "SKIP" | null;
  inferredMatchType?: boolean;
  outcomeAction?: { tag: string; currentOutcome: "WIN" | "LOSE" } | null;
  syncAction?: {
    tag: string;
    siteMatchType: "FWA" | "MM" | null;
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
};

type FwaMatchCopyPayload = {
  userId: string;
  guildId: string | null;
  includePostButton: boolean;
  allianceView: MatchView;
  singleViews: Record<string, MatchView>;
  currentScope: "alliance" | "single";
  currentTag: string | null;
};

type FwaMailPreviewPayload = {
  userId: string;
  guildId: string;
  tag: string;
  sourceMatchPayloadKey?: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  sourceShowMode?: "embed" | "copy";
};

type FwaMailPostedPayload = {
  guildId: string;
  tag: string;
  warStartMs: number | null;
  channelId: string;
  messageId: string;
  sentAtMs: number;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
};

type MatchMailMessageRef = {
  messageType: "mail" | "notify";
  messageID: string;
  channelId?: string;
  messageUrl?: string;
  notifyType?: "war_start" | "battle_start" | "war_end";
};

type MatchMailConfig = {
  lastPostedMessageId: string | null;
  lastPostedChannelId: string | null;
  lastPostedAtUnix: number | null;
  lastWarStartMs: number | null;
  lastMatchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  lastExpectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
  lastDataChangedAtUnix: number | null;
  messages: MatchMailMessageRef[];
  skipSyncHistory: {
    warId: number;
    warStartUnix: number;
    opponentTag: string;
  } | null;
};

type ForceMailMessageType = {
  messageType: "mail" | "notify";
  notifyType?: "war_start" | "battle_start" | "war_end";
};

const MATCH_MAIL_CONFIG_DEFAULT: MatchMailConfig = {
  lastPostedMessageId: null,
  lastPostedChannelId: null,
  lastPostedAtUnix: null,
  lastWarStartMs: null,
  lastMatchType: null,
  lastExpectedOutcome: null,
  lastDataChangedAtUnix: null,
  messages: [],
  skipSyncHistory: null,
};

function parseForceMailMessageType(value: string): ForceMailMessageType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mail") {
    return { messageType: "mail" };
  }
  if (normalized === "notify:war_start") {
    return { messageType: "notify", notifyType: "war_start" };
  }
  if (normalized === "notify:battle_start") {
    return { messageType: "notify", notifyType: "battle_start" };
  }
  if (normalized === "notify:war_end") {
    return { messageType: "notify", notifyType: "war_end" };
  }
  return null;
}

const fwaMatchCopyPayloads = new Map<string, FwaMatchCopyPayload>();
const fwaMailPreviewPayloads = new Map<string, FwaMailPreviewPayload>();
const fwaMailPostedPayloads = new Map<string, FwaMailPostedPayload>();
const fwaMailPollers = new Map<string, ReturnType<typeof setInterval>>();

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

type MatchTypeEditParams = { userId: string; key: string };

function buildMatchTypeEditCustomId(params: MatchTypeEditParams): string {
  return `${FWA_MATCH_TYPE_EDIT_PREFIX}:${params.userId}:${params.key}`;
}

function parseMatchTypeEditCustomId(customId: string): MatchTypeEditParams | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== FWA_MATCH_TYPE_EDIT_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  if (!userId || !key) return null;
  return { userId, key };
}

export function isFwaMatchTypeEditButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_TYPE_EDIT_PREFIX}:`);
}

type OutcomeActionParams = {
  userId: string;
  tag: string;
  currentOutcome: "WIN" | "LOSE";
};

function buildOutcomeActionCustomId(params: OutcomeActionParams): string {
  return `${FWA_OUTCOME_ACTION_PREFIX}:${params.userId}:${normalizeTag(params.tag)}:${params.currentOutcome}`;
}

function parseOutcomeActionCustomId(customId: string): OutcomeActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_OUTCOME_ACTION_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const tag = normalizeTag(parts[2] ?? "");
  const currentOutcome = parts[3] === "WIN" || parts[3] === "LOSE" ? parts[3] : null;
  if (!userId || !tag || !currentOutcome) return null;
  return { userId, tag, currentOutcome };
}

export function isFwaOutcomeActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_OUTCOME_ACTION_PREFIX}:`);
}

type MatchSyncActionParams = {
  userId: string;
  key: string;
  tag: string;
};

function buildMatchSyncActionCustomId(params: MatchSyncActionParams): string {
  return `${FWA_MATCH_SYNC_ACTION_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

function parseMatchSyncActionCustomId(customId: string): MatchSyncActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_SYNC_ACTION_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const tag = normalizeTag(parts[3] ?? "");
  if (!userId || !key || !tag) return null;
  return { userId, key, tag };
}

export function isFwaMatchSyncActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SYNC_ACTION_PREFIX}:`);
}

type MatchSkipSyncActionParams = {
  userId: string;
  key: string;
  tag: string;
};

function buildMatchSkipSyncActionCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_ACTION_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

function parseMatchSkipSyncActionCustomId(customId: string): MatchSkipSyncActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_SKIP_SYNC_ACTION_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const tag = normalizeTag(parts[3] ?? "");
  if (!userId || !key || !tag) return null;
  return { userId, key, tag };
}

export function isFwaMatchSkipSyncActionButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_ACTION_PREFIX}:`);
}

function buildMatchSkipSyncConfirmCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

function parseMatchSkipSyncConfirmCustomId(customId: string): MatchSkipSyncActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const tag = normalizeTag(parts[3] ?? "");
  if (!userId || !key || !tag) return null;
  return { userId, key, tag };
}

export function isFwaMatchSkipSyncConfirmButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_CONFIRM_PREFIX}:`);
}

function buildMatchSkipSyncUndoCustomId(params: MatchSkipSyncActionParams): string {
  return `${FWA_MATCH_SKIP_SYNC_UNDO_PREFIX}:${params.userId}:${params.key}:${normalizeTag(params.tag)}`;
}

function parseMatchSkipSyncUndoCustomId(customId: string): MatchSkipSyncActionParams | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_SKIP_SYNC_UNDO_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const tag = normalizeTag(parts[3] ?? "");
  if (!userId || !key || !tag) return null;
  return { userId, key, tag };
}

export function isFwaMatchSkipSyncUndoButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SKIP_SYNC_UNDO_PREFIX}:`);
}

export function isFwaMatchSelectCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SELECT_PREFIX}:`);
}

export function isFwaMatchAllianceButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_ALLIANCE_PREFIX}:`);
}

function buildFwaMailConfirmCustomId(userId: string, key: string): string {
  return `${FWA_MAIL_CONFIRM_PREFIX}:${userId}:${key}`;
}

function parseFwaMailConfirmCustomId(customId: string): { userId: string; key: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== FWA_MAIL_CONFIRM_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  if (!userId || !key) return null;
  return { userId, key };
}

export function isFwaMailConfirmButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_CONFIRM_PREFIX}:`);
}

function buildFwaMailRefreshCustomId(key: string): string {
  return `${FWA_MAIL_REFRESH_PREFIX}:${key}`;
}

function parseFwaMailRefreshCustomId(customId: string): { key: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 2 || parts[0] !== FWA_MAIL_REFRESH_PREFIX) return null;
  const key = parts[1]?.trim() ?? "";
  if (!key) return null;
  return { key };
}

export function isFwaMailRefreshButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MAIL_REFRESH_PREFIX}:`);
}

function buildFwaMatchSendMailCustomId(userId: string, key: string, tag: string): string {
  return `${FWA_MATCH_SEND_MAIL_PREFIX}:${userId}:${key}:${tag}`;
}

function parseFwaMatchSendMailCustomId(
  customId: string
): { userId: string; key: string; tag: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== FWA_MATCH_SEND_MAIL_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const key = parts[2]?.trim() ?? "";
  const tag = normalizeTag(parts[3] ?? "");
  if (!userId || !key || !tag) return null;
  return { userId, key, tag };
}

export function isFwaMatchSendMailButtonCustomId(customId: string): boolean {
  return customId.startsWith(`${FWA_MATCH_SEND_MAIL_PREFIX}:`);
}

function updateSingleViewMatchType(
  view: MatchView,
  nextType: "FWA" | "BL" | "MM",
  inferred: boolean
): MatchView {
  const warning = inferred ? " :warning:" : "";
  const description0 = String(view.embed.data.description ?? "");
  const lines = description0.split("\n");
  const matchTypeIdx = lines.findIndex((line) => line.startsWith("Match Type:"));
  if (nextType !== "FWA" && matchTypeIdx > 0) {
    for (let i = matchTypeIdx - 1; i >= 0; i -= 1) {
      const text = (lines[i] ?? "").trim();
      if (!text || text === "\u200B" || text === MATCHTYPE_WARNING_LEGEND) continue;
      lines[i] = `This is a ${nextType} match.`;
      break;
    }
  }
  const withoutOutcome = lines
    .filter((line) => (nextType === "FWA" ? true : !line.startsWith("Expected outcome:")))
    .join("\n");
  const description1 = withoutOutcome.replace(
    /Match Type:\s\*\*.*?\*\*(?:\s+\[[^\]]+\]\([^)]+\))?/,
    `Match Type: **${nextType}${warning}**`
  );
  const description2 = inferred
    ? description1
    : description1
        .replace(`${MATCHTYPE_WARNING_LEGEND}\n\u200B\n`, "")
        .replace(`${MATCHTYPE_WARNING_LEGEND}\n\n`, "");
  const nextEmbed = EmbedBuilder.from(view.embed).setDescription(description2);
  if (nextType !== "FWA") {
    nextEmbed.setFields(
      (nextEmbed.data.fields ?? []).map((field) => {
        if ((field.name ?? "") !== "Points") return field;
        const first = String(field.value ?? "").split("\n")[0] ?? "Unavailable";
        return {
          ...field,
          value: first,
        };
      })
    );
  }
  const nextCopy = view.copyText
    .replace(`${MATCHTYPE_WARNING_LEGEND}\n`, inferred ? `${MATCHTYPE_WARNING_LEGEND}\n` : "")
    .replace(/Match Type:\s.*$/m, `Match Type: ${nextType}${warning}`)
    .replace(/^Verify:\s.*$/m, inferred ? "$&" : "")
    .replace(/^Expected outcome:\s.*$/m, nextType === "FWA" ? "$&" : "")
    .replace(/## Projection[\r\n]+.*$/m, nextType === "FWA" ? "$&" : `## Projection\nThis is a ${nextType} match.`);
  return {
    ...view,
    embed: nextEmbed,
    copyText: nextCopy,
    matchTypeCurrent: nextType,
    inferredMatchType: inferred,
  };
}

function updateAllianceEmbedMatchType(
  embed: EmbedBuilder,
  clanTag: string,
  nextType: "FWA" | "BL" | "MM",
  inferred: boolean
): EmbedBuilder {
  const warning = inferred ? " :warning:" : "";
  const next = EmbedBuilder.from(embed);
  const fields = next.data.fields ?? [];
  next.setFields(
    fields.map((f) => {
      const name = f.name ?? "";
      if (!name.includes(`(#${clanTag})`)) return f;
      const baseValue = String(f.value ?? "");
      const noOutcome = nextType === "FWA" ? baseValue : baseValue.replace(/\nOutcome:\s\*\*.*?\*\*/g, "");
      const noPoints = nextType === "FWA" ? noOutcome : noOutcome.replace(/^Points:.*\n?/m, "");
      const value = noPoints.replace(
        /Match Type:\s\*\*.*?\*\*(?:\s+\[[^\]]+\]\([^)]+\))?/,
        `Match Type: **${nextType}${warning}**`
      );
      return { ...f, value };
    })
  );
  return next;
}

async function rebuildTrackedPayloadForTag(
  payload: FwaMatchCopyPayload,
  guildId: string | null,
  tag: string,
  client?: Client | null
): Promise<FwaMatchCopyPayload | null> {
  if (!guildId) return null;
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, guildId);
  const cocService = new CoCService();
  const warLookupCache: WarLookupCache = new Map();
  const overview = await buildTrackedMatchOverview(
    cocService,
    sourceSync,
    guildId,
    warLookupCache,
    client ?? null
  );
  const trackedSingleView = overview.singleViews[tag];
  if (!trackedSingleView) return null;
  return {
    userId: payload.userId,
    guildId,
    includePostButton: payload.includePostButton,
    allianceView: { embed: overview.embed, copyText: overview.copyText, matchTypeAction: null },
    singleViews: overview.singleViews,
    currentScope: "single",
    currentTag: tag,
  };
}

async function getTrackedClanMailConfig(tag: string): Promise<{
  tag: string;
  name: string | null;
  mailChannelId: string | null;
  clanRoleId: string | null;
} | null> {
  const normalizedTag = normalizeTag(tag);
  const rows = await prisma.$queryRaw<
    Array<{ tag: string; name: string | null; mailChannelId: string | null; clanRoleId: string | null }>
  >(
    Prisma.sql`
      SELECT "tag","name","mailChannelId","clanRoleId"
      FROM "TrackedClan"
      WHERE UPPER(REPLACE("tag",'#','')) = ${normalizedTag}
      LIMIT 1
    `
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  return {
    tag: normalizeTag(row.tag),
    name: sanitizeClanName(row.name ?? "") ?? null,
    mailChannelId: row.mailChannelId ?? null,
    clanRoleId: row.clanRoleId ?? null,
  };
}

async function resolveCurrentSyncNumForMailConfirm(tag: string): Promise<number | null> {
  const normalizedTag = normalizeTag(tag);
  const tracked = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${normalizedTag}`, mode: "insensitive" } },
    select: { pointsScrape: true },
  });
  const trackedScrape = parseTrackedClanPointsScrape(tracked?.pointsScrape ?? null);
  if (
    trackedScrape?.pointsSiteUpToDate &&
    trackedScrape.syncNumber !== null &&
    Number.isFinite(trackedScrape.syncNumber)
  ) {
    return Math.trunc(trackedScrape.syncNumber);
  }
  const lastHistory = await prisma.clanWarHistory.findFirst({
    where: {
      clanTag: normalizedTag,
      syncNumber: { not: null },
      matchType: { in: ["MM", "BL", "SKIP"] },
    },
    orderBy: { warStartTime: "desc" },
    select: { syncNumber: true },
  });
  const previousSync = Number(lastHistory?.syncNumber ?? NaN);
  if (Number.isFinite(previousSync)) {
    return Math.max(0, Math.trunc(previousSync) + 1);
  }
  return null;
}

function isMatchTypeValue(value: unknown): value is "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" {
  return value === "FWA" || value === "BL" || value === "MM" || value === "SKIP" || value === "UNKNOWN";
}

function isExpectedOutcomeValue(value: unknown): value is "WIN" | "LOSE" | "UNKNOWN" {
  return value === "WIN" || value === "LOSE" || value === "UNKNOWN";
}

function parseMatchMailConfig(value: Prisma.JsonValue | null | undefined): MatchMailConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...MATCH_MAIL_CONFIG_DEFAULT };
  }
  const obj = value as Record<string, unknown>;
  const rawMessages = Array.isArray(obj.messages) ? obj.messages : [];
  const messages: MatchMailMessageRef[] = [];
  for (const entry of rawMessages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const messageType = item.messageType;
    const messageID = typeof item.messageID === "string" ? item.messageID.trim() : "";
    const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
    const messageUrl = typeof item.messageUrl === "string" ? item.messageUrl.trim() : "";
    const notifyTypeRaw = typeof item.notifyType === "string" ? item.notifyType.trim() : "";
    const notifyType =
      notifyTypeRaw === "war_start" ||
      notifyTypeRaw === "battle_start" ||
      notifyTypeRaw === "war_end"
        ? notifyTypeRaw
        : undefined;
    if ((messageType !== "mail" && messageType !== "notify") || !messageID) continue;
    messages.push({
      messageType,
      messageID,
      channelId: channelId || undefined,
      messageUrl: messageUrl || undefined,
      notifyType: messageType === "notify" ? notifyType : undefined,
    });
  }

  const lastPostedMessageId =
    typeof obj.lastPostedMessageId === "string" && obj.lastPostedMessageId.trim()
      ? obj.lastPostedMessageId.trim()
      : null;
  const lastPostedChannelId =
    typeof obj.lastPostedChannelId === "string" && obj.lastPostedChannelId.trim()
      ? obj.lastPostedChannelId.trim()
      : null;
  const lastPostedAtUnix =
    typeof obj.lastPostedAtUnix === "number" && Number.isFinite(obj.lastPostedAtUnix)
      ? Math.trunc(obj.lastPostedAtUnix)
      : null;
  const lastWarStartMs =
    typeof obj.lastWarStartMs === "number" && Number.isFinite(obj.lastWarStartMs)
      ? Math.trunc(obj.lastWarStartMs)
      : null;
  const lastMatchType = isMatchTypeValue(obj.lastMatchType) ? obj.lastMatchType : null;
  const lastExpectedOutcome = isExpectedOutcomeValue(obj.lastExpectedOutcome)
    ? obj.lastExpectedOutcome
    : null;
  const lastDataChangedAtUnix =
    typeof obj.lastDataChangedAtUnix === "number" && Number.isFinite(obj.lastDataChangedAtUnix)
      ? Math.trunc(obj.lastDataChangedAtUnix)
      : null;
  const skipSyncRaw =
    obj.skipSyncHistory && typeof obj.skipSyncHistory === "object" && !Array.isArray(obj.skipSyncHistory)
      ? (obj.skipSyncHistory as Record<string, unknown>)
      : null;
  const skipSyncWarId =
    skipSyncRaw && typeof skipSyncRaw.warId === "number" && Number.isFinite(skipSyncRaw.warId)
      ? Math.trunc(skipSyncRaw.warId)
      : null;
  const skipSyncWarStartUnix =
    skipSyncRaw && typeof skipSyncRaw.warStartUnix === "number" && Number.isFinite(skipSyncRaw.warStartUnix)
      ? Math.trunc(skipSyncRaw.warStartUnix)
      : null;
  const skipSyncOpponentTag =
    skipSyncRaw && typeof skipSyncRaw.opponentTag === "string"
      ? normalizeTag(skipSyncRaw.opponentTag)
      : "";
  const skipSyncHistory =
    skipSyncWarId !== null && skipSyncWarStartUnix !== null
      ? {
          warId: skipSyncWarId,
          warStartUnix: skipSyncWarStartUnix,
          opponentTag: skipSyncOpponentTag || "SKIP",
        }
      : null;

  return {
    lastPostedMessageId,
    lastPostedChannelId,
    lastPostedAtUnix,
    lastWarStartMs,
    lastMatchType,
    lastExpectedOutcome,
    lastDataChangedAtUnix,
    messages,
    skipSyncHistory,
  };
}

function asMailConfigInputJson(config: MatchMailConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue;
}

async function getCurrentWarMailConfig(
  guildId: string,
  tag: string
): Promise<MatchMailConfig> {
  const normalizedTag = normalizeTag(tag);
  const row = await prisma.currentWar.findUnique({
    where: {
      guildId_clanTag: {
        guildId,
        clanTag: `#${normalizedTag}`,
      },
    },
    select: { mailConfig: true },
  });
  return parseMatchMailConfig(row?.mailConfig as Prisma.JsonValue | null | undefined);
}

async function saveCurrentWarMailConfig(params: {
  guildId: string;
  tag: string;
  channelId: string;
  mailConfig: MatchMailConfig;
}): Promise<void> {
  const normalizedTag = normalizeTag(params.tag);
  await prisma.currentWar.upsert({
    where: {
      guildId_clanTag: {
        guildId: params.guildId,
        clanTag: `#${normalizedTag}`,
      },
    },
    create: {
      guildId: params.guildId,
      clanTag: `#${normalizedTag}`,
      channelId: params.channelId,
      notify: false,
      mailConfig: asMailConfigInputJson(params.mailConfig),
    },
    update: {
      mailConfig: asMailConfigInputJson(params.mailConfig),
      updatedAt: new Date(),
    },
  });
}

async function recordMatchMailUpdated(params: {
  guildId: string;
  tag: string;
  channelId: string;
  messageId: string;
  messageUrl?: string;
  warStartMs: number | null;
  sentAtMs: number;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";
  expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
}): Promise<MatchMailConfig> {
  const current = await getCurrentWarMailConfig(params.guildId, params.tag);
  const deduped = current.messages.filter((entry) => entry.messageType !== "mail");
  deduped.push({
    messageType: "mail",
    messageID: params.messageId,
    channelId: params.channelId,
    messageUrl: params.messageUrl,
  });

  const next: MatchMailConfig = {
    ...current,
    lastPostedMessageId: params.messageId,
    lastPostedChannelId: params.channelId,
    lastPostedAtUnix: Math.floor(params.sentAtMs / 1000),
    lastWarStartMs: params.warStartMs,
    lastMatchType: params.matchType,
    lastExpectedOutcome: params.expectedOutcome,
    lastDataChangedAtUnix: Math.floor(params.sentAtMs / 1000),
    messages: deduped,
  };
  await saveCurrentWarMailConfig({
    guildId: params.guildId,
    tag: params.tag,
    channelId: params.channelId,
    mailConfig: next,
  });
  return next;
}

async function markMatchLiveDataChanged(params: {
  guildId: string;
  tag: string;
  channelId: string;
}): Promise<void> {
  const current = await getCurrentWarMailConfig(params.guildId, params.tag);
  const live = await prisma.currentWar.findUnique({
    where: {
      guildId_clanTag: {
        guildId: params.guildId,
        clanTag: `#${normalizeTag(params.tag)}`,
      },
    },
    select: { matchType: true, outcome: true },
  });
  const liveMatchType = isMatchTypeValue(live?.matchType) ? live.matchType : null;
  const liveOutcome = isExpectedOutcomeValue(live?.outcome) ? live.outcome : null;
  const liveMatchesPosted =
    Boolean(current.lastPostedMessageId) &&
    current.lastMatchType !== null &&
    liveMatchType !== null &&
    current.lastMatchType === liveMatchType &&
    (current.lastExpectedOutcome ?? null) === liveOutcome;
  const nowUnix = Math.floor(Date.now() / 1000);
  const next: MatchMailConfig = {
    ...current,
    lastDataChangedAtUnix: liveMatchesPosted
      ? (current.lastPostedAtUnix ?? nowUnix)
      : nowUnix,
  };
  await saveCurrentWarMailConfig({
    guildId: params.guildId,
    tag: params.tag,
    channelId: params.channelId,
    mailConfig: next,
  });
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

function buildDiscordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function mailStatusLabelForState(state: WarStateForSync): string {
  if (state === "preparation") return "Preparation Day";
  if (state === "inWar") return "Battle Day";
  return "Not In War";
}

function formatDiscordRelativeMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown";
  return `<t:${Math.floor(ms / 1000)}:R>`;
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
  const withPrecision = Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(2)}`;
  return `${withPrecision.replace(/\.00$/, "")}%`;
}

async function upsertCurrentWarHistoryAndGetWarId(params: {
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
    params.normalizedTag,
    resolvedWarStartMs !== null && Number.isFinite(resolvedWarStartMs) ? resolvedWarStartMs : null
  );
}

async function getCurrentWarIdForClan(
  normalizedTag: string,
  warStartMs: number | null
): Promise<number | null> {
  if (warStartMs !== null && Number.isFinite(warStartMs)) {
    const exact = await prisma.clanWarHistory.findFirst({
      where: {
        clanTag: `#${normalizedTag}`,
        warStartTime: new Date(warStartMs),
      },
      orderBy: { warStartTime: "desc" },
      select: { warId: true },
    });
    if (exact?.warId) return exact.warId;
  }
  const fallback = await prisma.clanWarHistory.findFirst({
    where: { clanTag: `#${normalizedTag}` },
    orderBy: { warStartTime: "desc" },
    select: { warId: true },
  });
  return fallback?.warId ?? null;
}

async function buildWarMailEmbedForTag(
  cocService: CoCService,
  guildId: string,
  tag: string
): Promise<{
  embed: EmbedBuilder;
  inferredMatchType: boolean;
  mailChannelId: string | null;
  clanRoleId: string | null;
  warStartMs: number | null;
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

  const war = await cocService.getCurrentWar(`#${normalizedTag}`).catch(() => null);
  const warState = deriveWarState(war?.state);
  const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
  const opponentName = sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
  const clanName =
    trackedConfig.name ?? sanitizeClanName(String(war?.clan?.name ?? "")) ?? `#${normalizedTag}`;

  const subscription = await prisma.currentWar.findUnique({
    where: {
      guildId_clanTag: {
        guildId,
        clanTag: `#${normalizedTag}`,
      },
    },
    select: { matchType: true, inferredMatchType: true, outcome: true, lastWarStartTime: true },
  });

  let inferredMatchType = Boolean(subscription?.inferredMatchType);
  let matchType: "FWA" | "BL" | "MM" | "UNKNOWN" = (subscription?.matchType as
    | "FWA"
    | "BL"
    | "MM"
    | null) ?? "UNKNOWN";
  let outcome = (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ?? null;

  const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
  let primaryBalance: number | null = null;
  let opponentBalance: number | null = null;
  if (opponentTag) {
    const primary = await getClanPointsCached(settings, cocService, normalizedTag, currentSync).catch(
      () => null
    );
    const opponent = await getClanPointsCached(settings, cocService, opponentTag, currentSync).catch(
      () => null
    );
    primaryBalance = primary?.balance ?? null;
    opponentBalance = opponent?.balance ?? null;
    if (matchType === "UNKNOWN") {
      matchType = opponentBalance !== null && !Number.isNaN(opponentBalance) ? "FWA" : "MM";
      inferredMatchType = true;
    }
    if (matchType === "FWA" && !outcome) {
      outcome = deriveProjectedOutcome(
        normalizedTag,
        opponentTag,
        primaryBalance,
        opponentBalance,
        currentSync
      );
    }
  }

  const history = new WarEventHistoryService(cocService);
  let planText = "War plan unavailable.";
  if (matchType === "FWA") {
    planText =
      (await history.buildWarPlanText("FWA", outcome, normalizedTag, opponentName)) ??
      "War plan unavailable.";
  } else if (matchType === "BL") {
    planText = [
      `**⚫️ BLACKLIST WAR 🆚 ${opponentName} 🏴‍☠️**`,
      "Everyone switch to WAR BASES!!",
      "This is our opportunity to gain some extra FWA points!",
      "➕ 30+ people switch to war base = +1 point",
      "➕ 60% total destruction = +1 point",
      "➕ win war = +1 point",
      "---",
      "If you need war base, check https://clashofclans-layouts.com/ or ⁠bases",
    ].join("\n");
  } else if (matchType === "MM") {
    planText = [
      `⚪️ MISMATCHED WAR 🆚 ${opponentName} :sob:`,
      "Keep WA base active, attack what you can!",
    ].join("\n");
  }

  const prepTargetMs = parseCocApiTime(war?.startTime);
  const battleTargetMs = parseCocApiTime(war?.endTime);
  const warStartMs = parseCocApiTime(war?.startTime);
  const fallbackWarStartMs = subscription?.lastWarStartTime
    ? subscription.lastWarStartTime.getTime()
    : null;
  const effectiveWarStartMs = warStartMs ?? fallbackWarStartMs;
  const expectedOutcome = matchType === "FWA" ? (outcome ?? "UNKNOWN") : null;
  const remainingText = formatDiscordRelativeMs(
    warState === "preparation" ? prepTargetMs : battleTargetMs
  );
  const warId =
    (await upsertCurrentWarHistoryAndGetWarId({
      normalizedTag,
      warStartMs: effectiveWarStartMs,
      warEndMs: battleTargetMs,
      currentSync,
      matchType,
      expectedOutcome,
      clanName,
      opponentName,
      opponentTag,
      war,
    })) ?? (await getCurrentWarIdForClan(normalizedTag, effectiveWarStartMs));
  const starsLeft = formatWarInt(war?.clan?.stars);
  const starsRight = formatWarInt(war?.opponent?.stars);
  const attacksPerMember = Number.isFinite(Number(war?.attacksPerMember))
    ? Math.max(1, Math.trunc(Number(war?.attacksPerMember)))
    : 2;
  const teamSize = Number.isFinite(Number(war?.teamSize))
    ? Math.max(1, Math.trunc(Number(war?.teamSize)))
    : 0;
  const totalAttacks = teamSize > 0 ? teamSize * attacksPerMember : 0;
  const attacksLeft = formatWarInt(war?.clan?.attacks);
  const attacksRight = formatWarInt(war?.opponent?.attacks);
  const attacksLeftText = totalAttacks > 0 ? `${attacksLeft}/${totalAttacks}` : `${attacksLeft}/?`;
  const attacksRightText = totalAttacks > 0 ? `${attacksRight}/${totalAttacks}` : `${attacksRight}/?`;
  const destructionLeft = formatWarPercent(war?.clan?.destructionPercentage);
  const destructionRight = formatWarPercent(war?.opponent?.destructionPercentage);
  const lines: string[] = [
    planText,
    "------",
    `War Status: ${mailStatusLabelForState(warState)}`,
    `Time remaining: ${remainingText}`,
    "",
    "War Stats",
    formatWarStatLine(starsLeft, ":star:", starsRight),
    formatWarStatLine(attacksLeftText, ":crossed_swords:", attacksRightText),
    formatWarStatLine(destructionLeft, ":boom:", destructionRight),
  ];

  const unavailableReasons: string[] = [];
  if (!trackedConfig.mailChannelId) {
    unavailableReasons.push("Tracked clan mail channel is not configured.");
  }
  if (inferredMatchType) {
    unavailableReasons.push("Match type is inferred. Confirm match type before sending war mail.");
  }
  if (unavailableReasons.length > 0) {
    lines.push("", ...unavailableReasons.map((r) => `:warning: ${r}`));
  }

  const embed = new EmbedBuilder()
    .setTitle(`War Mail - ${clanName} (#${normalizedTag})`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
    .setTimestamp(new Date());

  return {
    embed,
    inferredMatchType,
    mailChannelId: trackedConfig.mailChannelId,
    clanRoleId: trackedConfig.clanRoleId,
    warStartMs: effectiveWarStartMs,
    unavailableReasons,
    matchType,
    expectedOutcome,
  };
}

function findLatestPostedWarMailForClan(params: {
  guildId: string;
  tag: string;
  warStartMs?: number | null;
  strictWarStart?: boolean;
}): { key: string; payload: FwaMailPostedPayload } | null {
  const normalizedTag = normalizeTag(params.tag);
  const strictWarStart = Boolean(params.strictWarStart);
  let latest: { key: string; payload: FwaMailPostedPayload } | null = null;
  for (const [key, payload] of fwaMailPostedPayloads.entries()) {
    if (payload.guildId !== params.guildId) continue;
    if (normalizeTag(payload.tag) !== normalizedTag) continue;
    if (strictWarStart && payload.warStartMs !== (params.warStartMs ?? null)) continue;
    if (!latest || payload.sentAtMs > latest.payload.sentAtMs) {
      latest = { key, payload };
    }
  }
  return latest;
}

function getMailStatusEmojiForClan(params: {
  guildId: string | null;
  tag: string;
  warStartMs: number | null;
  mailConfig?: MatchMailConfig | null;
}): string {
  if (!params.guildId) return MAILBOX_NOT_SENT_EMOJI;
  const config = params.mailConfig ?? null;
  const postedAfterLatestChange =
    config?.lastPostedAtUnix !== null &&
    config?.lastPostedAtUnix !== undefined &&
    (config.lastDataChangedAtUnix === null ||
      config.lastDataChangedAtUnix === undefined ||
      config.lastPostedAtUnix >= config.lastDataChangedAtUnix);
  if (config?.lastPostedMessageId) {
    if (!postedAfterLatestChange) return MAILBOX_NOT_SENT_EMOJI;
    if (
      params.warStartMs !== null &&
      config.lastWarStartMs !== null &&
      config.lastWarStartMs === params.warStartMs
    ) {
      return MAILBOX_SENT_EMOJI;
    }
    if (params.warStartMs === null) {
      return MAILBOX_SENT_EMOJI;
    }
    if (
      params.warStartMs !== null &&
      config.lastWarStartMs === null &&
      config.messages.some((entry) => entry.messageType === "mail")
    ) {
      return MAILBOX_SENT_EMOJI;
    }
  }
  const sentForSameWar =
    params.warStartMs !== null
      ? findLatestPostedWarMailForClan({
          guildId: params.guildId,
          tag: params.tag,
          warStartMs: params.warStartMs,
          strictWarStart: true,
        })
      : null;
  const sent =
    sentForSameWar ??
    findLatestPostedWarMailForClan({
      guildId: params.guildId,
      tag: params.tag,
    });
  return sent ? MAILBOX_SENT_EMOJI : MAILBOX_NOT_SENT_EMOJI;
}

function clearPostedMailTrackingForClan(params: {
  guildId: string;
  tag: string;
}): void {
  const normalizedTag = normalizeTag(params.tag);
  for (const [key, posted] of fwaMailPostedPayloads.entries()) {
    if (posted.guildId !== params.guildId) continue;
    if (normalizeTag(posted.tag) !== normalizedTag) continue;
    stopWarMailPolling(key);
    fwaMailPostedPayloads.delete(key);
  }
}

async function hasPostedMailMessage(params: {
  client: Client | null | undefined;
  guildId: string | null;
  mailConfig: MatchMailConfig | null | undefined;
}): Promise<boolean> {
  if (!params.client || !params.guildId || !params.mailConfig) return false;
  const channelId = params.mailConfig.lastPostedChannelId;
  const messageId = params.mailConfig.lastPostedMessageId;
  if (!channelId || !messageId) return false;
  const channel = await params.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;
  const message = await (channel as any).messages.fetch(messageId).catch(() => null);
  return Boolean(message);
}

function formatOutcomeForRevision(outcome: "WIN" | "LOSE" | "UNKNOWN" | null): string {
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
    lines.push(`- Match Type: **${params.previousMatchType}** -> **${params.nextMatchType}**`);
  }
  if (params.previousExpectedOutcome !== params.nextExpectedOutcome) {
    lines.push(
      `- Expected outcome: **${formatOutcomeForRevision(params.previousExpectedOutcome)}** -> **${formatOutcomeForRevision(params.nextExpectedOutcome)}**`
    );
  }
  return lines;
}

export const buildWarMailRevisionLinesForTest = buildWarMailRevisionLines;

function buildSupersededWarMailDescription(params: {
  changedAtMs: number;
  revisionLines: string[];
}): string {
  const changedAtSec = Math.floor(params.changedAtMs / 1000);
  return [`Superseded at <t:${changedAtSec}:F>`, ...params.revisionLines].join("\n");
}

export const buildSupersededWarMailDescriptionForTest = buildSupersededWarMailDescription;

function stopWarMailPolling(key: string): void {
  const timer = fwaMailPollers.get(key);
  if (timer) {
    clearInterval(timer);
    fwaMailPollers.delete(key);
  }
}

async function annotatePreviousWarMailRevision(params: {
  client: Client;
  previousKey: string;
  previous: FwaMailPostedPayload;
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

  const channel = await params.client.channels.fetch(params.previous.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;
  const message = await (channel as any).messages.fetch(params.previous.messageId).catch(() => null);
  if (!message) return false;
  const previousEmbed = message.embeds[0] ? EmbedBuilder.from(message.embeds[0]) : new EmbedBuilder();
  previousEmbed.setDescription(
    buildSupersededWarMailDescription({
      changedAtMs: params.changedAtMs,
      revisionLines,
    }).slice(0, 4096)
  );
  await message.edit({
    embeds: [previousEmbed],
    components: [],
  });
  stopWarMailPolling(params.previousKey);
  fwaMailPostedPayloads.delete(params.previousKey);
  return true;
}

function buildWarMailPreviewComponents(params: {
  userId: string;
  key: string;
  enabled: boolean;
}): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMailConfirmCustomId(params.userId, params.key))
        .setLabel("Confirm and Send")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!params.enabled)
    ),
  ];
}

function buildWarMailPostedComponents(key: string): Array<ActionRowBuilder<ButtonBuilder>> {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMailRefreshCustomId(key))
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function refreshWarMailPost(client: Client, key: string): Promise<void> {
  const payload = fwaMailPostedPayloads.get(key);
  if (!payload) return;
  const cocService = new CoCService();
  const rendered = await buildWarMailEmbedForTag(cocService, payload.guildId, payload.tag);
  fwaMailPostedPayloads.set(key, {
    ...payload,
    warStartMs: rendered.warStartMs,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  const channel = await client.channels.fetch(payload.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const message = await (channel as any).messages.fetch(payload.messageId).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [rendered.embed],
    components: buildWarMailPostedComponents(key),
  });
}

function startWarMailPolling(client: Client, key: string): void {
  stopWarMailPolling(key);
  const timer = setInterval(() => {
    refreshWarMailPost(client, key).catch(() => undefined);
  }, 20 * 60 * 1000);
  fwaMailPollers.set(key, timer);
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
      .setStyle(ButtonStyle.Secondary)
  );
  if (payload.includePostButton) {
    baseRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildPointsPostButtonCustomId(userId))
        .setLabel("Post to Channel")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  if (payload.currentScope === "single") {
    baseRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildFwaMatchAllianceCustomId(userId, key))
        .setLabel("Alliance View")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    baseRow,
  ];
  if (payload.currentScope === "single" && payload.currentTag && mailAction) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildFwaMatchSendMailCustomId(userId, key, payload.currentTag))
          .setLabel("Send Mail")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!mailAction.enabled)
      )
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
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(actionRow);
  } else if (payload.currentScope === "single" && view.matchTypeCurrent) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildMatchTypeEditCustomId({ userId, key }))
          .setLabel("Change Match Type")
          .setStyle(ButtonStyle.Secondary)
      )
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
          })
        )
        .setLabel("Reverse Outcome")
        .setStyle(ButtonStyle.Primary)
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
            })
          )
          .setLabel("Sync Data")
          .setStyle(ButtonStyle.Danger)
      )
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
            })
          )
          .setLabel("SKIP SYNC")
          .setStyle(ButtonStyle.Secondary)
      )
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
            })
          )
          .setLabel("UNDO")
          .setStyle(ButtonStyle.Danger)
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
            const warningSuffix = viewForTag?.inferredMatchType ? " :warning:" : "";
            const mailStatusEmoji = viewForTag?.mailStatusEmoji ?? MAILBOX_NOT_SENT_EMOJI;
            return {
              label: `${mailStatusEmoji} ${clanName}${warningSuffix}`.slice(0, 100),
              description: `#${tag}`.slice(0, 100),
              value: tag,
            };
          })
        );
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }
  }
  return rows;
}

export async function handleFwaMatchCopyButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseFwaMatchCopyCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "copy_toggle_click",
    `user=${interaction.user.id} mode=${parsed.mode} key=${parsed.key}`
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
  logFwaMatchTelemetry("single_select_click", `user=${interaction.user.id} key=${parsed.key}`);
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
  logFwaMatchTelemetry("alliance_view_click", `user=${interaction.user.id} key=${parsed.key}`);
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
  logFwaMatchTelemetry(
    "match_type_confirm_click",
    `user=${interaction.user.id} tag=${parsed.tag} type=${parsed.targetType}`
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

  const existingSub = await prisma.currentWar.findUnique({
    where: {
      guildId_clanTag: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
      },
    },
    select: { matchType: true },
  });
  const didMatchTypeChange = existingSub?.matchType !== parsed.targetType;

  await prisma.currentWar.upsert({
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
  if (didMatchTypeChange) {
    await markMatchLiveDataChanged({
      guildId: interaction.guildId,
      tag: parsed.tag,
      channelId: interaction.channelId,
    });
  }

  for (const [key, payload] of fwaMatchCopyPayloads.entries()) {
    if (payload.userId !== parsed.userId) continue;
    if (payload.currentScope !== "single" || payload.currentTag !== parsed.tag) continue;
    const refreshed = await rebuildTrackedPayloadForTag(
      payload,
      interaction.guildId ?? null,
      parsed.tag,
      interaction.client
    );
    const nextPayload = refreshed ?? payload;
    if (!refreshed) {
      const view = payload.singleViews[parsed.tag];
      if (!view) continue;
      const updatedSingle = updateSingleViewMatchType(view, parsed.targetType, false);
      updatedSingle.matchTypeAction = null;
      nextPayload.singleViews[parsed.tag] = updatedSingle;
      nextPayload.allianceView = {
        ...nextPayload.allianceView,
        embed: updateAllianceEmbedMatchType(
          nextPayload.allianceView.embed,
          parsed.tag,
          parsed.targetType,
          false
        ),
      };
    }
    fwaMatchCopyPayloads.set(key, nextPayload);
    const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
    const view = nextPayload.singleViews[parsed.tag];
    if (!view) continue;
    await interaction.editReply({
      content: showMode === "copy" ? limitDiscordContent(view.copyText) : undefined,
      embeds: showMode === "embed" ? [view.embed] : [],
      components: buildFwaMatchCopyComponents(nextPayload, nextPayload.userId, key, showMode),
    });
    return;
  }

  await interaction.followUp({
    ephemeral: true,
    content: `Match type for #${parsed.tag} is now **${parsed.targetType}** (manual).`,
  });
}

export async function handleFwaMatchTypeEditButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseMatchTypeEditCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "match_type_edit_click",
    `user=${interaction.user.id} key=${parsed.key}`
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
    components: buildFwaMatchCopyComponents(payload, payload.userId, parsed.key, "embed"),
  });
}

export async function handleFwaOutcomeActionButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseOutcomeActionCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry(
    "outcome_reverse_click",
    `user=${interaction.user.id} tag=${parsed.tag} from=${parsed.currentOutcome}`
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

  const nextOutcome = parsed.currentOutcome === "WIN" ? "LOSE" : "WIN";
  await prisma.currentWar.upsert({
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
      outcome: nextOutcome,
    },
    update: {
      outcome: nextOutcome,
      updatedAt: new Date(),
    },
  });
  await markMatchLiveDataChanged({
    guildId: interaction.guildId,
    tag: parsed.tag,
    channelId: interaction.channelId,
  });

  for (const [key, payload] of fwaMatchCopyPayloads.entries()) {
    if (payload.userId !== parsed.userId) continue;
    if (payload.currentScope !== "single" || payload.currentTag !== parsed.tag) continue;
    const refreshed = await rebuildTrackedPayloadForTag(
      payload,
      interaction.guildId ?? null,
      parsed.tag,
      interaction.client
    );
    const nextPayload = refreshed ?? payload;
    if (!refreshed) {
      const view = payload.singleViews[parsed.tag];
      if (!view) continue;
      const description = String(view.embed.data.description ?? "");
      const updated = EmbedBuilder.from(view.embed).setDescription(
        description.replace(
          /Expected outcome:\s\*\*(WIN|LOSE|UNKNOWN)\*\*/,
          `Expected outcome: **${nextOutcome}**`
        )
      );
      nextPayload.singleViews[parsed.tag] = {
        ...view,
        embed: updated,
        outcomeAction: { tag: parsed.tag, currentOutcome: nextOutcome },
      };
      nextPayload.allianceView = {
        ...nextPayload.allianceView,
        embed: EmbedBuilder.from(nextPayload.allianceView.embed).setFields(
          (nextPayload.allianceView.embed.data.fields ?? []).map((f) => {
            const name = String(f.name ?? "");
            if (!name.includes(`(#${parsed.tag})`)) return f;
            return {
              ...f,
              value: String(f.value ?? "").replace(
                /Outcome:\s\*\*(WIN|LOSE|UNKNOWN)\*\*/,
                `Outcome: **${nextOutcome}**`
              ),
            };
          })
        ),
      };
    }
    fwaMatchCopyPayloads.set(key, nextPayload);
    const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
    const view = nextPayload.singleViews[parsed.tag];
    if (!view) continue;
    await interaction.update({
      content: showMode === "copy" ? limitDiscordContent(view.copyText) : undefined,
      embeds: showMode === "embed" ? [view.embed] : [],
      components: buildFwaMatchCopyComponents(nextPayload, nextPayload.userId, key, showMode),
    });
    return;
  }

  await interaction.reply({
    ephemeral: true,
    content: `Expected outcome for #${parsed.tag} reversed to **${nextOutcome}**.`,
  });
}

export async function handleFwaMatchSyncActionButton(
  interaction: ButtonInteraction
): Promise<void> {
  const parsed = parseMatchSyncActionCustomId(interaction.customId);
  if (!parsed) return;
  logFwaMatchTelemetry("sync_action_click", `user=${interaction.user.id} tag=${parsed.tag}`);

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
      `user=${interaction.user.id} tag=${parsed.tag} reason=no_out_of_sync_data`
    );
    await interaction.reply({
      ephemeral: true,
      content: "No out-of-sync data found for this clan.",
    });
    return;
  }

  await prisma.currentWar.upsert({
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
      fwaPoints: syncAction.siteFwaPoints,
      opponentFwaPoints: syncAction.siteOpponentFwaPoints,
      matchType: syncAction.siteMatchType ?? undefined,
      inferredMatchType: syncAction.siteMatchType === "MM",
      outcome: syncAction.siteOutcome,
    },
    update: {
      fwaPoints: syncAction.siteFwaPoints,
      opponentFwaPoints: syncAction.siteOpponentFwaPoints,
      matchType: syncAction.siteMatchType ?? undefined,
      inferredMatchType: syncAction.siteMatchType === "MM",
      outcome: syncAction.siteOutcome,
      updatedAt: new Date(),
    },
  });
  logFwaMatchTelemetry(
    "sync_action_applied",
    `user=${interaction.user.id} tag=${parsed.tag} site_sync=${syncAction.siteSyncNumber ?? "unknown"} site_points=${syncAction.siteFwaPoints ?? "unknown"} opponent_points=${syncAction.siteOpponentFwaPoints ?? "unknown"}`
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
    interaction.client
  );
  if (!refreshed) {
    await interaction.reply({
      ephemeral: true,
      content: "Data synced, but this view could not be refreshed.",
    });
    return;
  }
  fwaMatchCopyPayloads.set(parsed.key, refreshed);
  const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
  const nextView = refreshed.singleViews[parsed.tag];
  if (!nextView) {
    await interaction.reply({
      ephemeral: true,
      content: "Data synced, but clan view is unavailable now.",
    });
    return;
  }
  await interaction.update({
    content: showMode === "copy" ? limitDiscordContent(nextView.copyText) : undefined,
    embeds: showMode === "embed" ? [nextView.embed] : [],
    components: buildFwaMatchCopyComponents(refreshed, refreshed.userId, parsed.key, showMode),
  });
}

export async function handleFwaMatchSkipSyncActionButton(
  interaction: ButtonInteraction
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
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });
}

export async function handleFwaMatchSkipSyncConfirmButton(
  interaction: ButtonInteraction
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

  const tracked = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${parsed.tag}`, mode: "insensitive" } },
    select: { pointsScrape: true, name: true },
  });
  const trackedScrape = parseTrackedClanPointsScrape(tracked?.pointsScrape ?? null);
  let resolvedSyncNum: number | null = null;
  if (
    trackedScrape?.pointsSiteUpToDate &&
    trackedScrape.syncNumber !== null &&
    Number.isFinite(trackedScrape.syncNumber)
  ) {
    resolvedSyncNum = Math.trunc(trackedScrape.syncNumber);
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
      guildId_clanTag: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
      },
    },
    select: {
      warId: true,
      lastWarStartTime: true,
      mailConfig: true,
    },
  });
  const existingMailConfig = parseMatchMailConfig(
    existingCurrent?.mailConfig as Prisma.JsonValue | null | undefined
  );
  const existingSkipHistory = existingMailConfig.skipSyncHistory;
  const skipWarStart =
    existingSkipHistory?.warStartUnix !== undefined && existingSkipHistory?.warStartUnix !== null
      ? new Date(existingSkipHistory.warStartUnix * 1000)
      : existingCurrent?.lastWarStartTime ??
        new Date(Math.floor(Date.now() / (60 * 60 * 1000)) * 60 * 60 * 1000);
  const skipOpponentTag = normalizeTag(existingSkipHistory?.opponentTag ?? "SKIP");
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
      `
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
      `
    );
    const returned = Number(rows[0]?.warId ?? NaN);
    skipWarId = Number.isFinite(returned) ? Math.trunc(returned) : null;
  }

  await prisma.currentWar.upsert({
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
      matchType: "SKIP",
      inferredMatchType: false,
      warId: skipWarId,
      lastState: "notInWar",
      clanName: tracked?.name ?? view.clanName ?? `#${parsed.tag}`,
    },
    update: {
      channelId: interaction.channelId,
      matchType: "SKIP",
      inferredMatchType: false,
      warId: skipWarId,
      lastState: "notInWar",
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
    interaction.client
  );
  if (!refreshed) {
    await interaction.reply({
      ephemeral: true,
      content: "Skip sync applied, but this view could not be refreshed.",
    });
    return;
  }
  fwaMatchCopyPayloads.set(parsed.key, refreshed);
  const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
  const nextView = refreshed.singleViews[parsed.tag];
  if (!nextView) {
    await interaction.reply({
      ephemeral: true,
      content: "Skip sync applied, but clan view is unavailable now.",
    });
    return;
  }
  await interaction.update({
    content: "SKIP confirmed. Clan logs updated.",
    components: [],
  });
  await interaction.message.edit({
    content: showMode === "copy" ? limitDiscordContent(nextView.copyText) : undefined,
    embeds: showMode === "embed" ? [nextView.embed] : [],
    components: buildFwaMatchCopyComponents(refreshed, refreshed.userId, parsed.key, showMode),
  });
}

export async function handleFwaMatchSkipSyncUndoButton(
  interaction: ButtonInteraction
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
  const current = await prisma.currentWar.findUnique({
    where: {
      guildId_clanTag: {
        guildId: interaction.guildId,
        clanTag: `#${parsed.tag}`,
      },
    },
    select: { warId: true, mailConfig: true, channelId: true },
  });
  const existingMailConfig = parseMatchMailConfig(
    current?.mailConfig as Prisma.JsonValue | null | undefined
  );
  const skipWarId = existingMailConfig.skipSyncHistory?.warId ?? current?.warId ?? null;
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
    interaction.client
  );
  if (!refreshed) {
    await interaction.reply({
      ephemeral: true,
      content: "Undo applied, but this view could not be refreshed.",
    });
    return;
  }
  fwaMatchCopyPayloads.set(parsed.key, refreshed);
  const showMode = interaction.message.embeds.length > 0 ? "embed" : "copy";
  const nextView = refreshed.singleViews[parsed.tag];
  if (!nextView) {
    await interaction.reply({
      ephemeral: true,
      content: "Undo applied, but clan view is unavailable now.",
    });
    return;
  }
  await interaction.update({
    content: showMode === "copy" ? limitDiscordContent(nextView.copyText) : undefined,
    embeds: showMode === "embed" ? [nextView.embed] : [],
    components: buildFwaMatchCopyComponents(refreshed, refreshed.userId, parsed.key, showMode),
  });
}

async function showWarMailPreview(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guildId: string,
  userId: string,
  tag: string,
  cocService: CoCService,
  sourceMatchPayloadKey?: string
): Promise<void> {
  const rendered = await buildWarMailEmbedForTag(cocService, guildId, tag);
  const previewKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const sourceShowMode =
    interaction.isButton() && interaction.message.embeds.length > 0 ? "embed" : "copy";
  fwaMailPreviewPayloads.set(previewKey, {
    userId,
    guildId,
    tag,
    sourceMatchPayloadKey,
    sourceChannelId:
      interaction.isButton() && interaction.channelId ? interaction.channelId : undefined,
    sourceMessageId: interaction.isButton() ? interaction.message.id : undefined,
    sourceShowMode: interaction.isButton() ? sourceShowMode : undefined,
  });

  let enabled = rendered.unavailableReasons.length === 0;
  if (enabled && rendered.mailChannelId) {
    const channel = await interaction.client.channels.fetch(rendered.mailChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      enabled = false;
    }
  }
  const extraWarning =
    enabled || rendered.mailChannelId
      ? ""
      : "\n:warning: Tracked clan mail channel is missing or unavailable.";
  const content = enabled
    ? "Review mail preview and confirm send."
    : `Cannot send yet.${extraWarning}`;

  if (interaction.isButton()) {
    await interaction.update({
      content,
      embeds: [rendered.embed],
      components: buildWarMailPreviewComponents({
        userId,
        key: previewKey,
        enabled,
      }),
    });
    return;
  }

  await interaction.editReply({
    content,
    embeds: [rendered.embed],
    components: buildWarMailPreviewComponents({
      userId,
      key: previewKey,
      enabled,
    }),
  });
}

export async function handleFwaMatchSendMailButton(interaction: ButtonInteraction): Promise<void> {
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
  const cocService = new CoCService();
  await showWarMailPreview(
    interaction,
    interaction.guildId,
    interaction.user.id,
    parsed.tag,
    cocService,
    parsed.key
  );
}

async function refreshSourceMatchMessageAfterMailSend(
  interaction: ButtonInteraction,
  previewPayload: FwaMailPreviewPayload
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
    interaction.client
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
  const message = await (channel as any).messages.fetch(previewPayload.sourceMessageId).catch(() => null);
  if (!message) return { refreshed, showMode, sourceUpdated: false };

  const currentView =
    refreshed.currentScope === "single" && refreshed.currentTag
      ? refreshed.singleViews[refreshed.currentTag] ?? refreshed.allianceView
      : refreshed.allianceView;
  await message.edit({
    content: showMode === "copy" ? limitDiscordContent(currentView.copyText) : undefined,
    embeds: showMode === "embed" ? [currentView.embed] : [],
    components: buildFwaMatchCopyComponents(refreshed, refreshed.userId, sourceKey, showMode),
  });
  return { refreshed, showMode, sourceUpdated: true };
}

export async function handleFwaMailConfirmButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseFwaMailConfirmCustomId(interaction.customId);
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
      content: "⏳ Sending war mail... please wait.",
      embeds: [],
      components: [],
    })
    .catch(() => undefined);
  const cocService = new CoCService();
  const rendered = await buildWarMailEmbedForTag(cocService, payload.guildId, payload.tag);
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
  const channel = await interaction.client.channels.fetch(rendered.mailChannelId).catch(() => null);
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
  const postKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const sent = await (channel as any).send({
    content: rendered.clanRoleId ? `<@&${rendered.clanRoleId}>` : undefined,
    allowedMentions: rendered.clanRoleId ? { roles: [rendered.clanRoleId] } : undefined,
    embeds: [rendered.embed],
    components: buildWarMailPostedComponents(postKey),
  });
  const resolvedCurrentSyncNum = await resolveCurrentSyncNumForMailConfirm(payload.tag);
  await prisma.currentWar.upsert({
    where: {
      guildId_clanTag: {
        guildId: payload.guildId,
        clanTag: `#${normalizeTag(payload.tag)}`,
      },
    },
    create: {
      guildId: payload.guildId,
      clanTag: `#${normalizeTag(payload.tag)}`,
      channelId: channel.id,
      notify: false,
      currentSyncNum: resolvedCurrentSyncNum,
    },
    update: {
      currentSyncNum: resolvedCurrentSyncNum ?? undefined,
      updatedAt: new Date(),
    },
  });
  const nowMs = Date.now();
  let previous = findLatestPostedWarMailForClan({
    guildId: payload.guildId,
    tag: payload.tag,
    warStartMs: rendered.warStartMs,
    strictWarStart: rendered.warStartMs !== null,
  });
  if (!previous) {
    const existingMailConfig = await getCurrentWarMailConfig(payload.guildId, payload.tag);
    if (
      existingMailConfig.lastPostedMessageId &&
      existingMailConfig.lastPostedChannelId &&
      (rendered.warStartMs === null ||
        existingMailConfig.lastWarStartMs === null ||
        existingMailConfig.lastWarStartMs === rendered.warStartMs)
    ) {
      previous = {
        key: `db:${payload.guildId}:${normalizeTag(payload.tag)}`,
        payload: {
          guildId: payload.guildId,
          tag: payload.tag,
          warStartMs: existingMailConfig.lastWarStartMs,
          channelId: existingMailConfig.lastPostedChannelId,
          messageId: existingMailConfig.lastPostedMessageId,
          sentAtMs:
            existingMailConfig.lastPostedAtUnix !== null
              ? existingMailConfig.lastPostedAtUnix * 1000
              : 0,
          matchType: existingMailConfig.lastMatchType ?? "UNKNOWN",
          expectedOutcome: existingMailConfig.lastExpectedOutcome ?? null,
        },
      };
    }
  }
  fwaMailPostedPayloads.set(postKey, {
    guildId: payload.guildId,
    tag: payload.tag,
    warStartMs: rendered.warStartMs,
    channelId: channel.id,
    messageId: sent.id,
    sentAtMs: nowMs,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  let revisedPrevious = false;
  if (previous) {
    revisedPrevious = await annotatePreviousWarMailRevision({
      client: interaction.client,
      previousKey: previous.key,
      previous: previous.payload,
      nextMatchType: rendered.matchType,
      nextExpectedOutcome: rendered.expectedOutcome,
      changedAtMs: nowMs,
    }).catch(() => false);
  }
  startWarMailPolling(interaction.client, postKey);
  await recordMatchMailUpdated({
    guildId: payload.guildId,
    tag: payload.tag,
    channelId: channel.id,
    messageId: sent.id,
    messageUrl: buildDiscordMessageUrl(payload.guildId, channel.id, sent.id),
    warStartMs: rendered.warStartMs,
    sentAtMs: nowMs,
    matchType: rendered.matchType,
    expectedOutcome: rendered.expectedOutcome,
  });
  fwaMailPreviewPayloads.delete(parsed.key);
  const refreshedSource = await refreshSourceMatchMessageAfterMailSend(interaction, payload).catch(
    () => ({ refreshed: null, showMode: "embed" as const, sourceUpdated: false })
  );
  if (payload.sourceMatchPayloadKey) {
    const sourcePayload = refreshedSource.refreshed ?? fwaMatchCopyPayloads.get(payload.sourceMatchPayloadKey) ?? null;
    if (sourcePayload) {
      const showMode = refreshedSource.showMode ?? "embed";
      const currentView =
        sourcePayload.currentScope === "single" && sourcePayload.currentTag
          ? sourcePayload.singleViews[sourcePayload.currentTag] ?? sourcePayload.allianceView
          : sourcePayload.allianceView;
      await interaction.editReply({
        content:
          showMode === "copy"
            ? limitDiscordContent(currentView.copyText)
            : revisedPrevious
              ? `War mail sent to <#${channel.id}>. Previous mail was updated with a revision log.`
              : `War mail sent to <#${channel.id}>.`,
        embeds: showMode === "embed" ? [currentView.embed] : [],
        components: buildFwaMatchCopyComponents(
          sourcePayload,
          sourcePayload.userId,
          payload.sourceMatchPayloadKey,
          showMode
        ),
      });
      return;
    }
  }

  await interaction.deleteReply().catch(() => undefined);
  await interaction.followUp({
    ephemeral: true,
    content: revisedPrevious
      ? `War mail sent to <#${channel.id}>. Previous mail was updated with a revision log.`
      : `War mail sent to <#${channel.id}>.`,
  });
  if (!refreshedSource.sourceUpdated && refreshedSource.refreshed && payload.sourceMatchPayloadKey) {
    const currentView =
      refreshedSource.refreshed.currentScope === "single" && refreshedSource.refreshed.currentTag
        ? refreshedSource.refreshed.singleViews[refreshedSource.refreshed.currentTag] ??
          refreshedSource.refreshed.allianceView
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
        refreshedSource.showMode
      ),
    });
  }
}

export async function handleFwaMailRefreshButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseFwaMailRefreshCustomId(interaction.customId);
  if (!parsed) return;
  const payload = fwaMailPostedPayloads.get(parsed.key);
  if (!payload) {
    await interaction.reply({
      ephemeral: true,
      content: "This mail post can no longer be refreshed.",
    });
    return;
  }
  await refreshWarMailPost(interaction.client, parsed.key);
  await interaction.reply({
    ephemeral: true,
    content: "War mail refreshed.",
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

async function getSourceOfTruthSync(
  _settings: SettingsService,
  _guildId?: string | null
): Promise<number | null> {
  const tracked = await prisma.trackedClan.findMany({
    select: { tag: true, pointsScrape: true },
  });
  const trackedTags = new Set(tracked.map((row) => normalizeTag(row.tag)));
  const scrapeSyncCandidates = tracked
    .map((row) => parseTrackedClanPointsScrape(row.pointsScrape))
    .filter(
      (scrape): scrape is TrackedClanPointsScrape =>
        Boolean(scrape && scrape.pointsSiteUpToDate && scrape.syncNumber !== null)
    )
    .map((scrape) => Number(scrape.syncNumber))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.trunc(value));
  if (scrapeSyncCandidates.length > 0) {
    const maxSync = Math.max(...scrapeSyncCandidates);
    return Math.max(0, maxSync - 1);
  }

  const trackedForHistory = [...trackedTags];
  const latestHistory = await prisma.clanWarHistory.findFirst({
    where: {
      syncNumber: { not: null },
      ...(trackedForHistory.length > 0 ? { clanTag: { in: trackedForHistory } } : {}),
    },
    orderBy: { warStartTime: "desc" },
    select: { syncNumber: true },
  });
  const latestSync = Number(latestHistory?.syncNumber ?? NaN);
  if (Number.isFinite(latestSync)) {
    return Math.max(0, Math.trunc(latestSync));
  }

  return null;
}

async function resolveMatchTypeWithFallback(params: {
  guildId: string | null;
  clanTag: string;
  opponentTag: string;
  warState: WarStateForSync;
  existingMatchType: "FWA" | "BL" | "MM" | "SKIP" | null | undefined;
}): Promise<"FWA" | "BL" | "MM" | "SKIP" | null> {
  return params.existingMatchType ?? null;
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

type TrackedClanPointsScrape = {
  version: number;
  source: "points.fwafarm";
  fetchedAtMs: number;
  trackedClanName: string | null;
  trackedClanTag: string;
  opponentClanName: string | null;
  opponentClanTag: string | null;
  pointBalance: number | null;
  opponentPointBalance: number | null;
  activeFwa: boolean;
  syncNumber: number | null;
  matchup: string;
  pointsSiteUpToDate: boolean;
};

type ActualSheetClanSnapshot = {
  totalWeight: string | null;
  weightCompo: string | null;
  weightDeltas: string | null;
  compoAdvice: string | null;
};

const ACTUAL_FIXED_LAYOUT_RANGE = "AllianceDashboard!A6:BD500";
const ACTUAL_COL_CLAN_TAG = 1; // B
const ACTUAL_COL_TOTAL_WEIGHT = 3; // D
const ACTUAL_COL_MISSING_WEIGHT = 20; // U
const ACTUAL_COL_BUCKET_START = 21; // V
const ACTUAL_COL_BUCKET_END = 26; // AA
const ACTUAL_COL_ADJUSTMENT = 53; // BB
const ACTUAL_COL_MODE = 55; // BD

function normalizeTagBare(input: string): string {
  return normalizeTag(input).replace(/^#/, "");
}

async function readActualSheetSnapshotByTag(
  settings: SettingsService
): Promise<Map<string, ActualSheetClanSnapshot>> {
  const sheets = new GoogleSheetsService(settings);
  const rows = await sheets.readLinkedValues(ACTUAL_FIXED_LAYOUT_RANGE, "actual");
  const out = new Map<string, ActualSheetClanSnapshot>();
  for (const row of rows) {
    const mode = String(row[ACTUAL_COL_MODE] ?? "").trim().toUpperCase();
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

function parseTrackedClanPointsScrape(value: unknown): TrackedClanPointsScrape | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const trackedClanTag = normalizeTag(String(obj.trackedClanTag ?? ""));
  if (!trackedClanTag) return null;
  const opponentClanTagRaw = String(obj.opponentClanTag ?? "").trim();
  const opponentClanTag = opponentClanTagRaw ? normalizeTag(opponentClanTagRaw) : null;
  return {
    version: Number(obj.version ?? 0),
    source: "points.fwafarm",
    fetchedAtMs: Number(obj.fetchedAtMs ?? 0),
    trackedClanName: sanitizeClanName(String(obj.trackedClanName ?? "")),
    trackedClanTag,
    opponentClanName: sanitizeClanName(String(obj.opponentClanName ?? "")),
    opponentClanTag,
    pointBalance:
      obj.pointBalance !== null && Number.isFinite(Number(obj.pointBalance))
        ? Number(obj.pointBalance)
        : null,
    opponentPointBalance:
      obj.opponentPointBalance !== null && Number.isFinite(Number(obj.opponentPointBalance))
        ? Number(obj.opponentPointBalance)
        : null,
    activeFwa: Boolean(obj.activeFwa),
    syncNumber:
      obj.syncNumber !== null && Number.isFinite(Number(obj.syncNumber))
        ? Number(obj.syncNumber)
        : null,
    matchup: String(obj.matchup ?? ""),
    pointsSiteUpToDate: Boolean(obj.pointsSiteUpToDate),
  };
}

function buildSnapshotFromTrackedScrape(
  tag: string,
  scrape: TrackedClanPointsScrape
): PointsSnapshot {
  const normalizedTag = normalizeTag(tag);
  return {
    version: POINTS_CACHE_VERSION,
    tag: normalizedTag,
    url: buildOfficialPointsUrl(normalizedTag),
    balance: scrape.pointBalance ?? null,
    clanName: scrape.trackedClanName ?? null,
    notFound: false,
    winnerBoxText: scrape.matchup ?? null,
    winnerBoxTags: scrape.opponentClanTag ? [normalizeTag(scrape.opponentClanTag)] : [],
    winnerBoxSync: scrape.syncNumber ?? null,
    effectiveSync: scrape.syncNumber ?? null,
    syncMode: getSyncMode(scrape.syncNumber ?? null),
    winnerBoxHasTag: true,
    headerPrimaryTag: normalizedTag,
    headerOpponentTag: scrape.opponentClanTag ? normalizeTag(scrape.opponentClanTag) : null,
    headerPrimaryBalance: scrape.pointBalance ?? null,
    headerOpponentBalance: scrape.opponentPointBalance ?? null,
    warEndMs: null,
    lastWarCheckAtMs: scrape.fetchedAtMs ?? Date.now(),
    fetchedAtMs: scrape.fetchedAtMs ?? Date.now(),
    refreshedForWarEndMs: null,
  };
}

function isPointsScrapeUpdatedForOpponent(
  scrape: TrackedClanPointsScrape | null,
  opponentTag: string
): boolean {
  if (!scrape || !scrape.pointsSiteUpToDate) return false;
  if (!scrape.opponentClanTag) return false;
  return normalizeTag(scrape.opponentClanTag) === normalizeTag(opponentTag);
}

function buildPointsScrapeMatchupSummary(
  trackedClanName: string | null,
  trackedClanTag: string,
  opponentClanName: string | null,
  opponentClanTag: string | null,
  trackedPoints: number | null,
  opponentPoints: number | null,
  syncNumber: number | null,
  activeFwa: boolean
): string {
  if (!activeFwa) return "Not marked as an FWA match.";
  if (
    trackedPoints === null ||
    opponentPoints === null ||
    !Number.isFinite(trackedPoints) ||
    !Number.isFinite(opponentPoints)
  ) {
    return "Not marked as an FWA match.";
  }
  const left = trackedClanName ?? normalizeTag(trackedClanTag);
  const right = opponentClanName ?? normalizeTag(opponentClanTag ?? "");
  if (trackedPoints > opponentPoints) {
    return `${left} should win by points (${trackedPoints} > ${opponentPoints})`;
  }
  if (trackedPoints < opponentPoints) {
    return `${right} should win by points (${trackedPoints} < ${opponentPoints})`;
  }
  if (syncNumber === null || !Number.isFinite(syncNumber)) {
    return "Not marked as an FWA match.";
  }
  const mode = syncNumber % 2 === 0 ? "high sync" : "low sync";
  const cmp = compareTagsForTiebreak(trackedClanTag, opponentClanTag ?? "");
  if (cmp === 0) return "Not marked as an FWA match.";
  const winner = mode === "low sync" ? (cmp < 0 ? left : right) : cmp > 0 ? left : right;
  return `${winner} should win by tiebreak (${trackedPoints} = ${opponentPoints}, ${mode})`;
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

async function scrapeClanPoints(tag: string): Promise<PointsSnapshot> {
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
    warEndMs: null,
    lastWarCheckAtMs: Date.now(),
    fetchedAtMs: Date.now(),
    refreshedForWarEndMs: null,
  };
}

async function getClanPointsCached(
  _settings: SettingsService,
  cocService: CoCService,
  tag: string,
  sourceSync: number | null,
  _warLookupCache?: WarLookupCache,
  options?: {
    requiredOpponentTag?: string | null;
    preferTrackedScrape?: boolean;
  }
): Promise<PointsSnapshot> {
  const normalizedTag = normalizeTag(tag);
  const requiredOpponentTag = normalizeTag(options?.requiredOpponentTag ?? "");
  const preferTrackedScrape = options?.preferTrackedScrape !== false;

  if (preferTrackedScrape) {
    const tracked = await prisma.trackedClan.findFirst({
      where: { tag: { equals: `#${normalizedTag}`, mode: "insensitive" } },
      select: { pointsScrape: true },
    });
    const trackedScrape = parseTrackedClanPointsScrape(tracked?.pointsScrape ?? null);
    const useTrackedScrape =
      trackedScrape &&
      trackedScrape.pointsSiteUpToDate &&
      (!requiredOpponentTag || isPointsScrapeUpdatedForOpponent(trackedScrape, requiredOpponentTag));
    if (trackedScrape && useTrackedScrape) {
      recordFetchEvent({
        namespace: "points",
        operation: "clan_points_snapshot",
        source: "cache_hit",
        detail: `tag=${normalizedTag}${requiredOpponentTag ? ` opponent=${requiredOpponentTag}` : ""}`,
      });
      return applySourceSync(buildSnapshotFromTrackedScrape(normalizedTag, trackedScrape), sourceSync);
    }
  }

  recordFetchEvent({
    namespace: "points",
    operation: "clan_points_snapshot",
    source: "web",
    detail: `tag=${normalizedTag}`,
  });
  const snapshot = await scrapeClanPoints(normalizedTag);
  return applySourceSync(snapshot, sourceSync);
}

export async function getPointsSnapshotForClan(
  cocService: CoCService,
  tag: string
): Promise<PointsSnapshot> {
  const settings = new SettingsService();
  const sourceSync = await getSourceOfTruthSync(settings, null);
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
  const missedBoth = participants.filter((p) => Number(p.attacksUsed ?? 0) <= 0).length;

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
  warLookupCache?: WarLookupCache,
  client?: Client | null
): Promise<{ embed: EmbedBuilder; copyText: string; singleViews: Record<string, MatchView> }> {
  const settings = new SettingsService();
  const actualByTag = await readActualSheetSnapshotByTag(settings).catch(() => new Map<string, ActualSheetClanSnapshot>());
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, pointsScrape: true },
  });
  const trackedMailRows = await prisma.$queryRaw<Array<{ tag: string; mailChannelId: string | null }>>(
    Prisma.sql`SELECT "tag","mailChannelId" FROM "TrackedClan"`
  );
  const mailChannelByTag = new Map(
    trackedMailRows.map((row) => [normalizeTag(row.tag), row.mailChannelId ?? null])
  );
  if (tracked.length === 0) {
    return {
      embed: new EmbedBuilder()
      .setTitle("FWA Match Overview")
      .setDescription("No tracked clans configured. Use `/tracked-clan configure` first."),
      copyText: "No tracked clans configured. Use `/tracked-clan configure` first.",
      singleViews: {},
    };
  }

  const subscriptions = await prisma.currentWar.findMany({
    where: guildId ? { guildId } : undefined,
    select: {
      clanTag: true,
      matchType: true,
      inferredMatchType: true,
      outcome: true,
      fwaPoints: true,
      opponentFwaPoints: true,
      mailConfig: true,
    },
  });
  const subByTag = new Map(subscriptions.map((s) => [normalizeTag(s.clanTag), s]));

  const warByClanTag = new Map<string, CurrentWarResult | null>();
  const warStateByClanTag = new Map<string, WarStateForSync>();
  const warStartMsByClanTag = new Map<string, number | null>();
  const activeWarStarts: number[] = [];

  for (const clan of tracked) {
    const clanTag = normalizeTag(clan.tag);
    const war = await getCurrentWarCached(cocService, clanTag, warLookupCache).catch(() => null);
    const warState = deriveWarState(war?.state);
    const warStartMs = parseCocApiTime(war?.startTime);
    warByClanTag.set(clanTag, war);
    warStateByClanTag.set(clanTag, warState);
    warStartMsByClanTag.set(clanTag, warStartMs);
    if (warState !== "notInWar" && warStartMs !== null && Number.isFinite(warStartMs)) {
      activeWarStarts.push(warStartMs);
    }
  }
  const baselineWarStartMs =
    activeWarStarts.length > 0 ? Math.min(...activeWarStarts) : null;
  const nowMs = Date.now();
  const missedSyncTags = new Set<string>();
  for (const clan of tracked) {
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
  const includedTracked = tracked.filter((clan) => !missedSyncTags.has(normalizeTag(clan.tag)));
  const embed = new EmbedBuilder().setTitle(`FWA Match Overview (${includedTracked.length})`);
  const copyLines: string[] = [];
  const singleViews: Record<string, MatchView> = {};
  let hasAnyInferredMatchType = false;
  let syncActionAvailableCount = 0;
  const sourceOfTruthSyncLine = `Sync#: ${
    sourceSync !== null && Number.isFinite(sourceSync)
      ? `#${Math.trunc(sourceSync) + 1}`
      : "unknown"
  }`;

  for (const clan of includedTracked) {
    const clanTag = normalizeTag(clan.tag);
    const clanName = sanitizeClanName(clan.name) ?? `#${clanTag}`;
    const war = warByClanTag.get(clanTag) ?? null;
    const warState = warStateByClanTag.get(clanTag) ?? deriveWarState(war?.state);
    const clanSyncLine = withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync);
    const clanWarStateLine = formatWarStateLabel(warState);
    const clanTimeRemainingLine = getWarStateRemaining(war, warState);
    const clanWarStartMs = warStartMsByClanTag.get(clanTag) ?? null;
    const sub = subByTag.get(clanTag);
    const parsedMailConfig = parseMatchMailConfig(sub?.mailConfig ?? null);
    const baseMailStatusEmoji = getMailStatusEmojiForClan({
      guildId,
      tag: clanTag,
      warStartMs: clanWarStartMs,
      mailConfig: parsedMailConfig,
    });
    const postedMailExistsForStatus =
      baseMailStatusEmoji === MAILBOX_SENT_EMOJI
        ? await hasPostedMailMessage({
            client: client ?? null,
            guildId,
            mailConfig: parsedMailConfig,
          })
        : false;
    const mailStatusEmoji = postedMailExistsForStatus
      ? MAILBOX_SENT_EMOJI
      : MAILBOX_NOT_SENT_EMOJI;
    if (warState === "notInWar") {
      const trackedScrape = parseTrackedClanPointsScrape(clan.pointsScrape);
      const clanProfile = await cocService.getClan(`#${clanTag}`).catch(() => null);
      const memberCount = Number.isFinite(Number(clanProfile?.members))
        ? Number(clanProfile?.members)
        : null;
      const livePoints = await getClanPointsCached(
        settings,
        cocService,
        clanTag,
        sourceSync,
        warLookupCache
      ).catch(() => null);
      const clanPoints =
        trackedScrape?.pointBalance !== null && trackedScrape?.pointBalance !== undefined
          ? trackedScrape.pointBalance
          : livePoints?.balance ?? sub?.fwaPoints ?? null;
      const outOfSync =
        !trackedScrape?.pointsSiteUpToDate ||
        (sub?.fwaPoints !== null &&
          sub?.fwaPoints !== undefined &&
          trackedScrape?.pointBalance !== null &&
          trackedScrape?.pointBalance !== undefined &&
          Number(sub.fwaPoints) !== Number(trackedScrape.pointBalance));
      const actual = actualByTag.get(clanTag) ?? null;
      const preWarHeader = `${mailStatusEmoji} | ${clanName} (#${clanTag})`;
      const preWarLines = [
        outOfSync ? ":warning: out of sync with points site" : ":white_check_mark: data in sync with points site",
        `Clan points: **${clanPoints !== null && clanPoints !== undefined ? clanPoints : "unknown"}**`,
        `Members: **${memberCount ?? "?"}/50**`,
        `Total weight (ACTUAL): **${actual?.totalWeight ?? "unknown"}**`,
        `Weight compo (ACTUAL): ${actual?.weightCompo ?? "unknown"}`,
        `Weight deltas (ACTUAL): ${actual?.weightDeltas ?? "unknown"}`,
        `Compo advice (ACTUAL): ${actual?.compoAdvice ?? "none"}`,
        `War State: **${clanWarStateLine}**`,
        `Time Remaining: **${clanTimeRemainingLine}**`,
        `Sync: **${clanSyncLine}**`,
      ];
      embed.addFields({
        name: preWarHeader,
        value: preWarLines.join("\n"),
        inline: false,
      });
      copyLines.push(
        `## ${preWarHeader}`,
        outOfSync ? "WARNING: out of sync with points site" : "Data in sync with points site",
        `Clan points: ${clanPoints !== null && clanPoints !== undefined ? clanPoints : "unknown"}`,
        `Members: ${memberCount ?? "?"}/50`,
        `Total weight (ACTUAL): ${actual?.totalWeight ?? "unknown"}`,
        `Weight compo (ACTUAL): ${actual?.weightCompo ?? "unknown"}`,
        `Weight deltas (ACTUAL): ${actual?.weightDeltas ?? "unknown"}`,
        `Compo advice (ACTUAL): ${actual?.compoAdvice ?? "none"}`,
        `War State: ${clanWarStateLine}`,
        `Time Remaining: ${clanTimeRemainingLine}`,
        `Sync: ${clanSyncLine}`
      );
      singleViews[clanTag] = {
        embed: new EmbedBuilder().setTitle(preWarHeader).setDescription(preWarLines.join("\n")),
        copyText: limitDiscordContent([`# ${preWarHeader}`, ...preWarLines].join("\n")),
        matchTypeAction: null,
        matchTypeCurrent: (sub?.matchType as "FWA" | "BL" | "MM" | "SKIP" | null | undefined) ?? null,
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
    const opponentName = sanitizeClanName(String(war?.opponent?.name ?? "")) ?? "Unknown";
    const matchTypeResolved = await resolveMatchTypeWithFallback({
      guildId,
      clanTag,
      opponentTag,
      warState,
      existingMatchType: sub?.matchType ?? null,
    });

    if (!opponentTag) {
      embed.addFields({
        name: `${mailStatusEmoji} | ${clanName} (#${clanTag}) vs Unknown`,
        value: [
          "No active war opponent",
          `War State: **${clanWarStateLine}**`,
          `Time Remaining: **${clanTimeRemainingLine}**`,
        ].join("\n"),
        inline: false,
      });
      copyLines.push(
        `## ${mailStatusEmoji} | ${clanName} (#${clanTag})`,
        "No active war opponent",
        `War State: ${clanWarStateLine}`,
        `Time Remaining: ${clanTimeRemainingLine}`
      );
      continue;
    }

    const currentSync = getCurrentSyncFromPrevious(sourceSync, warState);
    const trackedScrape = parseTrackedClanPointsScrape(clan.pointsScrape);
    const scrapeIsCurrentOpponent = isPointsScrapeUpdatedForOpponent(trackedScrape, opponentTag);
    const primaryPoints = scrapeIsCurrentOpponent
      ? buildSnapshotFromTrackedScrape(clanTag, trackedScrape as TrackedClanPointsScrape)
      : await getClanPointsCached(
          settings,
          cocService,
          clanTag,
          currentSync,
          warLookupCache,
          { requiredOpponentTag: opponentTag }
        ).catch(() => null);
    let opponentPoints: PointsSnapshot | null = null;
    if (scrapeIsCurrentOpponent) {
      opponentPoints = {
        ...(primaryPoints as PointsSnapshot),
        tag: opponentTag,
        balance: trackedScrape?.opponentPointBalance ?? null,
        clanName: trackedScrape?.opponentClanName ?? opponentName,
      };
    } else if (primaryPoints) {
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
    const siteSyncObservedForWrite = scrapeIsCurrentOpponent
      ? trackedScrape?.syncNumber ?? null
      : primaryPoints?.winnerBoxSync ?? null;
    const syncNumberForWrite =
      siteSyncObservedForWrite !== null && Number.isFinite(siteSyncObservedForWrite)
        ? Math.trunc(siteSyncObservedForWrite)
        : currentSync !== null && Number.isFinite(currentSync)
          ? Math.trunc(currentSync)
          : null;
    const inferredFromPointsType: "FWA" | "MM" | null = hasOpponentPoints ? "FWA" : "MM";
    const matchType = matchTypeResolved ?? inferredFromPointsType ?? "UNKNOWN";
    const inferredMatchType = Boolean(sub?.inferredMatchType) || (matchTypeResolved === null && inferredFromPointsType !== null);
    if (inferredMatchType) hasAnyInferredMatchType = true;
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
      await prisma.currentWar.upsert({
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
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          warEndFwaPoints: null,
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
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? { set: primaryPoints.balance }
              : undefined,
          warEndFwaPoints: undefined,
        },
      });
    } else if (guildId) {
      await prisma.currentWar.upsert({
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
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
              ? primaryPoints.balance
              : null,
          warEndFwaPoints: null,
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
            primaryPoints?.balance !== null && primaryPoints?.balance !== undefined
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
    const siteUpdatedForAlert = Boolean(
      scrapeIsCurrentOpponent ||
        (primaryPoints && isPointsSiteUpdatedForOpponent(primaryPoints, opponentTag, sourceSync))
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
    const siteSyncObserved = scrapeIsCurrentOpponent
      ? trackedScrape?.syncNumber ?? null
      : primaryPoints?.winnerBoxSync ?? null;
    const syncMismatch = siteUpdatedForAlert
      ? buildSyncMismatchWarning(currentSync, siteSyncObserved)
      : null;
    const outcomeMismatch = siteUpdatedForAlert
      ? buildOutcomeMismatchWarning(
          (sub?.outcome as "WIN" | "LOSE" | null | undefined) ?? null,
          derivedOutcome
        )
      : null;
    const mismatchLines = [primaryMismatch, opponentMismatch, syncMismatch, outcomeMismatch]
      .filter(Boolean)
      .join("\n");
    const hasMismatch = Boolean(primaryMismatch || opponentMismatch || syncMismatch || outcomeMismatch);
    const pointsSyncStatus = buildPointsSyncStatusLine(siteUpdatedForAlert, hasMismatch);
    const siteMatchType = hasOpponentPoints ? "FWA" : "MM";
    const opponentCcUrl = buildCcVerifyUrl(opponentTag);
    const opponentPointsUrl = buildOfficialPointsUrl(opponentTag);
    const mailChannelId = mailChannelByTag.get(clanTag) ?? null;
    const currentExpectedOutcomeForMail: "WIN" | "LOSE" | "UNKNOWN" | null =
      matchType === "FWA" ? (effectiveOutcome ?? "UNKNOWN") : null;
    const matchesLastPostedConfig =
      parsedMailConfig.lastMatchType === matchType &&
      (parsedMailConfig.lastExpectedOutcome ?? null) === currentExpectedOutcomeForMail;
    const postedMailExists = await hasPostedMailMessage({
      client: client ?? null,
      guildId,
      mailConfig: parsedMailConfig,
    });
    const mailBlockedReason = inferredMatchType
      ? "Match type is inferred. Confirm match type before sending war mail."
      : !mailChannelId
        ? "Mail channel is not configured. Use /tracked-clan configure with a mail channel."
        : postedMailExists && matchesLastPostedConfig
          ? "Current mail is already up to date. Change match config before sending again."
          : null;

    if (matchType === "FWA") {
      const warnSuffix = inferredMatchType ? ` :warning: ${verifyLink}` : "";
      const matchHeader = buildMatchStatusHeader({
        clanName,
        clanTag,
        opponentName,
        opponentTag,
        matchType,
        outcome: effectiveOutcome ?? "UNKNOWN",
        mailStatusEmoji,
      });
      embed.addFields({
        name: matchHeader,
        value: [
          pointsLine,
          pointsSyncStatus,
          `Match Type: **FWA${warnSuffix}**`,
          `Outcome: **${effectiveOutcome ?? "UNKNOWN"}**`,
          `War State: **${clanWarStateLine}**`,
          `Time Remaining: **${clanTimeRemainingLine}**`,
          mismatchLines,
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
        `Match Type: FWA${inferredMatchType ? " :warning:" : ""}`,
        inferredMatchType ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
        `Outcome: ${effectiveOutcome ?? "UNKNOWN"}`,
        `War State: ${clanWarStateLine}`,
        `Time Remaining: ${clanTimeRemainingLine}`,
        mismatchLines
      );
    } else {
      const warnSuffix = inferredMatchType ? ` :warning: ${verifyLink}` : "";
      const matchHeader = buildMatchStatusHeader({
        clanName,
        clanTag,
        opponentName,
        opponentTag,
        matchType,
        outcome: effectiveOutcome ?? "UNKNOWN",
        mailStatusEmoji,
      });
      embed.addFields({
        name: matchHeader,
        value: [
          pointsSyncStatus,
          `Match Type: **${matchType}${warnSuffix}**`,
          `War State: **${clanWarStateLine}**`,
          `Time Remaining: **${clanTimeRemainingLine}**`,
          mismatchLines,
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
        `Match Type: ${matchType}${inferredMatchType ? " :warning:" : ""}`,
        inferredMatchType ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
        `War State: ${clanWarStateLine}`,
        `Time Remaining: ${clanTimeRemainingLine}`,
        mismatchLines
      );
    }

    const projectionLineSingle =
      matchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
        ? (buildMatchupMessage(primaryPoints as PointsSnapshot, opponentPoints as PointsSnapshot, {
            primaryName: clanName,
            opponentName,
          }).split("\n")[1] ?? "Projection unavailable.")
        : `This is a ${matchType} match.`;
    const singleDescription = [
      pointsSyncStatus,
      inferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
      inferredMatchType ? "\u200B" : "",
      mailBlockedReason ? `:warning: ${mailBlockedReason}` : "",
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
    const syncAction: MatchView["syncAction"] =
      siteUpdatedForAlert && hasMismatch
        ? {
            tag: clanTag,
            siteMatchType,
            siteFwaPoints: primaryPoints?.balance ?? null,
            siteOpponentFwaPoints: opponentPoints?.balance ?? null,
            siteOutcome: matchType === "FWA" ? derivedOutcome : null,
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
            matchType,
            outcome: effectiveOutcome ?? "UNKNOWN",
            mailStatusEmoji,
          })
        )
        .setDescription(singleDescription)
        .addFields(
          {
            name: "Points",
            value:
              matchType === "FWA"
                ? hasPrimaryPoints && hasOpponentPoints
                  ? `${clanName}: **${primaryPoints!.balance}**\n${opponentName}: **${opponentPoints!.balance}**`
                  : "Unavailable on both clans."
                : hasPrimaryPoints
                  ? `${clanName}: **${primaryPoints!.balance}**`
                  : "Unavailable",
            inline: true,
          },
          {
            name: "Opponent Links",
            value: `[cc.fwafarm](${opponentCcUrl})\n[points.fwafarm](${opponentPointsUrl})`,
            inline: true,
          }
        ),
      copyText: limitDiscordContent(
        [
          `# ${buildMatchStatusHeader({
            clanName,
            clanTag,
            opponentName,
            opponentTag,
            matchType,
            outcome: effectiveOutcome ?? "UNKNOWN",
            mailStatusEmoji,
          })}`,
          inferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
          pointsSyncStatus,
          `Sync: ${clanSyncLine}`,
          `War State: ${clanWarStateLine}`,
          `Time Remaining: ${clanTimeRemainingLine}`,
          `## Opponent Name`,
          `\`${opponentName}\``,
          `## Opponent Tag`,
          `\`${opponentTag}\``,
          `CC: ${opponentCcUrl}`,
          `Points: ${opponentPointsUrl}`,
          `## Points`,
          hasPrimaryPoints && hasOpponentPoints ? `${clanName}: ${primaryPoints!.balance}` : "Unavailable",
          matchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
            ? `${opponentName}: ${opponentPoints!.balance}`
            : "",
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
      matchTypeCurrent: matchType as "FWA" | "BL" | "MM",
      inferredMatchType,
      outcomeAction:
        matchType === "FWA" && (effectiveOutcome === "WIN" || effectiveOutcome === "LOSE")
          ? { tag: clanTag, currentOutcome: effectiveOutcome }
          : null,
      syncAction,
      clanName,
      clanTag,
      mailStatusEmoji,
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
      `Ignored missed sync clans: **${missedSyncTags.size}** (started >2h after alliance war start or still no war past 2h).`
    );
  }
  if (overviewNotes.length > 0) {
    embed.setDescription(overviewNotes.join("\n\n"));
  }
  logFwaMatchTelemetry(
    "overview_built",
    `clans=${includedTracked.length} inferred_match_type=${hasAnyInferredMatchType ? 1 : 0} sync_action_available=${syncActionAvailableCount} missed_sync=${missedSyncTags.size} source_sync=${sourceSync ?? "unknown"}`
  );

  const copyHeaderLines = [`# FWA Match Overview (${includedTracked.length})`];
  copyHeaderLines.push(`Source of truth ${sourceOfTruthSyncLine}`);
  if (hasAnyInferredMatchType) {
    copyHeaderLines.push(MATCHTYPE_WARNING_LEGEND);
  }
  if (missedSyncTags.size > 0) {
    copyHeaderLines.push(
      `Ignored missed sync clans: ${missedSyncTags.size} (started >2h late or no war after 2h)`
    );
  }
  const copyHeader = copyHeaderLines.join("\n");
  return {
    embed,
    copyText: buildLimitedMessage(copyHeader, copyLines.map((l) => `${l}\n`), ""),
    singleViews,
  };
}

export async function runForceSyncDataCommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> {
  const visibility = interaction.options.getString("visibility", false) ?? "private";
  const isPublic = visibility === "public";
  const warLookupCache: WarLookupCache = new Map();
  await interaction.deferReply({ ephemeral: !isPublic });

  const rawTag = interaction.options.getString("tag", true);
  const tag = normalizeTag(rawTag);
  const datapoint = interaction.options.getString("datapoint", false) ?? "all";
  const shouldOverwritePoints = datapoint === "all" || datapoint === "points";
  const shouldOverwriteSyncNum = datapoint === "all" || datapoint === "syncNum";
  const trackedClan = await prisma.trackedClan.findFirst({
    where: { tag: { equals: `#${tag}`, mode: "insensitive" } },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    await interaction.editReply(`Clan #${tag} is not in tracked clans.`);
    return;
  }

  const war = await getCurrentWarCached(cocService, tag, warLookupCache).catch(() => null);
  const opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
  const opponentName = sanitizeClanName(String(war?.opponent?.name ?? "")) ?? null;
  const fresh = await scrapeClanPoints(tag);

  const siteSync = fresh.winnerBoxSync;
  const siteSyncNum =
    siteSync !== null && Number.isFinite(siteSync) ? Math.trunc(siteSync) : null;
  const siteUpdatedForOpponent = Boolean(
    opponentTag && isPointsSiteUpdatedForOpponent(fresh, opponentTag, null)
  );

  let opponentSnapshot: PointsSnapshot | null = null;
  let opponentBalance: number | null = null;
  if (siteUpdatedForOpponent) {
    const fromPrimary = deriveOpponentBalanceFromPrimarySnapshot(fresh, tag, opponentTag);
    if (fromPrimary !== null && Number.isFinite(fromPrimary)) {
      opponentBalance = fromPrimary;
    } else if (opponentTag) {
      opponentSnapshot = await scrapeClanPoints(opponentTag).catch(() => null);
      opponentBalance =
        opponentSnapshot?.balance !== null &&
        opponentSnapshot?.balance !== undefined &&
        Number.isFinite(opponentSnapshot.balance)
          ? opponentSnapshot.balance
          : null;
    }
  }
  const pointsScrape: TrackedClanPointsScrape = {
    version: 1,
    source: "points.fwafarm",
    fetchedAtMs: Date.now(),
    trackedClanName:
      sanitizeClanName(trackedClan.name) ?? sanitizeClanName(fresh.clanName) ?? null,
    trackedClanTag: tag,
    opponentClanName: opponentName,
    opponentClanTag: opponentTag || null,
    pointBalance:
      fresh.balance !== null && Number.isFinite(fresh.balance) ? fresh.balance : null,
    opponentPointBalance: opponentBalance,
    activeFwa: Boolean(opponentTag),
    syncNumber:
      siteSync !== null && Number.isFinite(siteSync) ? Math.trunc(siteSync) : null,
    matchup: buildPointsScrapeMatchupSummary(
      sanitizeClanName(trackedClan.name) ?? sanitizeClanName(fresh.clanName) ?? null,
      tag,
      opponentName,
      opponentTag || null,
      fresh.balance !== null && Number.isFinite(fresh.balance) ? fresh.balance : null,
      opponentBalance,
      siteSync !== null && Number.isFinite(siteSync) ? Math.trunc(siteSync) : null,
      Boolean(opponentTag)
    ),
    pointsSiteUpToDate: siteUpdatedForOpponent,
  };
  await prisma.trackedClan.update({
    where: { tag: `#${tag}` },
    data: { pointsScrape },
  });

  await interaction.editReply(
    [
      `Forced sync complete for #${tag} (${datapoint === "all" ? "points + syncNum" : datapoint}).`,
      `Point balance: ${
        fresh.balance !== null && Number.isFinite(fresh.balance)
          ? `**${formatPoints(fresh.balance)}**`
          : "unavailable"
      }`,
      `Site sync #: ${siteSyncNum !== null ? `#${siteSyncNum}` : "unknown"}`,
      `TrackedClan.pointsScrape.syncNumber: ${
        shouldOverwriteSyncNum
          ? siteSyncNum !== null
            ? `set to #${siteSyncNum}`
            : "set to unknown"
          : "retained from fresh scrape"
      }`,
      `TrackedClan.pointsScrape.pointBalance: ${
        shouldOverwritePoints
          ? fresh.balance !== null && Number.isFinite(fresh.balance)
            ? `set to ${formatPoints(fresh.balance)}`
            : "set to unavailable"
          : "retained from fresh scrape"
      }`,
      siteUpdatedForOpponent
        ? "pointsScrape marked in-sync with current opponent."
        : "pointsScrape marked out-of-sync for current opponent.",
    ].join("\n")
  );
}

export async function runForceSyncMailCommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> {
  const visibility = interaction.options.getString("visibility", false) ?? "private";
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
      guildId_clanTag: {
        guildId: interaction.guildId,
        clanTag: `#${tag}`,
      },
    },
    select: {
      matchType: true,
      outcome: true,
      lastWarStartTime: true,
      mailConfig: true,
    },
  });
  const currentWar = await getCurrentWarCached(cocService, tag).catch(() => null);
  const warStartMsFromApi = parseCocApiTime(currentWar?.startTime);
  const warStartMs =
    existing?.lastWarStartTime?.getTime() ?? warStartMsFromApi ?? null;
  const nowUnix = Math.floor(Date.now() / 1000);
  const current = parseMatchMailConfig(existing?.mailConfig as Prisma.JsonValue | null | undefined);
  const messages = current.messages.filter(
    (entry) =>
      !(
        entry.messageID === messageID &&
        entry.messageType === parsedType.messageType &&
        (parsedType.messageType !== "notify" || entry.notifyType === parsedType.notifyType)
      )
  );
  if (parsedType.messageType === "mail") {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.messageType === "mail") messages.splice(i, 1);
    }
  }
  messages.push({
    messageType: parsedType.messageType,
    messageID,
    channelId: interaction.channelId,
    messageUrl: buildDiscordMessageUrl(interaction.guildId, interaction.channelId, messageID),
    notifyType: parsedType.messageType === "notify" ? parsedType.notifyType : undefined,
  });

  const matchType = existing?.matchType ?? current.lastMatchType ?? "UNKNOWN";
  const expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null =
    existing?.outcome === "WIN" || existing?.outcome === "LOSE"
      ? existing.outcome
      : current.lastExpectedOutcome ?? "UNKNOWN";

  const next: MatchMailConfig = {
    ...current,
    lastWarStartMs: warStartMs,
    lastMatchType: matchType,
    lastExpectedOutcome: expectedOutcome,
    messages,
  };
  if (parsedType.messageType === "mail") {
    next.lastPostedMessageId = messageID;
    next.lastPostedChannelId = interaction.channelId;
    next.lastPostedAtUnix = nowUnix;
    next.lastDataChangedAtUnix = nowUnix;
  }

  await saveCurrentWarMailConfig({
    guildId: interaction.guildId,
    tag,
    channelId: interaction.channelId,
    mailConfig: next,
  });

  const messageTypeLabel =
    parsedType.messageType === "mail"
      ? "mail"
      : `notify:${parsedType.notifyType?.replace("_", " ") ?? "unknown"}`;
  await interaction.editReply(
    [
      `Force sync mail config complete for #${tag}.`,
      `Message type: **${messageTypeLabel}**`,
      `Message ID: \`${messageID}\``,
      `War start: ${warStartMs !== null ? `<t:${Math.floor(warStartMs / 1000)}:F>` : "unknown"}`,
      `Match type: **${next.lastMatchType ?? "UNKNOWN"}**`,
      `Expected outcome: **${next.lastExpectedOutcome ?? "UNKNOWN"}**`,
      `Tracked message refs: **${next.messages.length}**`,
    ].join("\n")
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
    cocService: CoCService
  ) => {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
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
    const sourceSync = await getSourceOfTruthSync(settings, interaction.guildId ?? null);
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

    if (subcommandGroup === "mail" && subcommand === "send") {
      if (!interaction.inGuild() || !interaction.guildId) {
        await editReplySafe("This command can only be used in a server.");
        return;
      }
      if (!tag) {
        await editReplySafe("Please provide `tag`.");
        return;
      }
      await showWarMailPreview(interaction, interaction.guildId, interaction.user.id, tag, cocService);
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
          "No tracked clans configured. Use `/tracked-clan configure` or provide a clan tag."
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
        const war = await getCurrentWarCached(cocService, trackedTag, warLookupCache).catch(
          () => null
        );
        const warState = deriveWarState(war?.state);
        const warStartMs = parseCocApiTime(war?.startTime);
        warStateByTag.set(trackedTag, warState);
        warStartMsByTag.set(trackedTag, warStartMs);
        if (warState !== "notInWar" && warStartMs !== null && Number.isFinite(warStartMs)) {
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
          const war = await getCurrentWarCached(cocService, trackedTag, warLookupCache).catch(
            () => null
          );
          const warState = warStateByTag.get(trackedTag) ?? deriveWarState(war?.state);
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
      logFwaMatchTelemetry(
        "command",
        `user=${interaction.user.id} guild=${interaction.guildId ?? "dm"} scope=${tag ? "single" : "alliance"} tag=${tag ?? "all"} visibility=${isPublic ? "public" : "private"} source_sync=${sourceSync ?? "unknown"}`
      );
      const overview = await buildTrackedMatchOverview(
        cocService,
        sourceSync,
        interaction.guildId ?? null,
        warLookupCache,
        interaction.client
      );
      const key = interaction.id;
      if (!tag) {
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
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

      const trackedSingleView = overview.singleViews[tag];
      if (trackedSingleView) {
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
          includePostButton: !isPublic,
          allianceView: { embed: overview.embed, copyText: overview.copyText, matchTypeAction: null },
          singleViews: overview.singleViews,
          currentScope: "single",
          currentTag: tag,
        });
        const stored = fwaMatchCopyPayloads.get(key)!;
        await editReplySafe(
          "",
          [trackedSingleView.embed],
          buildFwaMatchCopyComponents(stored, interaction.user.id, key, "embed")
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
          select: { name: true, pointsScrape: true },
        });
        const subscription = interaction.guildId
          ? await prisma.currentWar.findUnique({
              where: {
                guildId_clanTag: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: {
                lastState: true,
                matchType: true,
                inferredMatchType: true,
                outcome: true,
                fwaPoints: true,
                opponentFwaPoints: true,
                warStartFwaPoints: true,
                warEndFwaPoints: true,
                mailConfig: true,
              },
            })
          : null;
        opponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
        if (warState === "notInWar" || !opponentTag || subscription?.lastState === "notInWar") {
          const trackedScrape = parseTrackedClanPointsScrape(trackedClanMeta?.pointsScrape ?? null);
          const clanProfile = await cocService.getClan(`#${tag}`).catch(() => null);
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
            warLookupCache
          ).catch(() => null);
          const clanPoints =
            trackedScrape?.pointBalance !== null && trackedScrape?.pointBalance !== undefined
              ? trackedScrape.pointBalance
              : livePoints?.balance ?? subscription?.fwaPoints ?? null;
          const outOfSync =
            !trackedScrape?.pointsSiteUpToDate ||
            (subscription?.fwaPoints !== null &&
              subscription?.fwaPoints !== undefined &&
              trackedScrape?.pointBalance !== null &&
              trackedScrape?.pointBalance !== undefined &&
              Number(subscription.fwaPoints) !== Number(trackedScrape.pointBalance));
          const actualByTag = await readActualSheetSnapshotByTag(settings).catch(
            () => new Map<string, ActualSheetClanSnapshot>()
          );
          const actual = actualByTag.get(tag) ?? null;
          const parsedMailConfig = parseMatchMailConfig(
            subscription?.mailConfig as Prisma.JsonValue | null | undefined
          );
          const baseMailStatusEmoji = getMailStatusEmojiForClan({
            guildId: interaction.guildId ?? null,
            tag,
            warStartMs: null,
            mailConfig: parsedMailConfig,
          });
          const postedMailExistsForStatus =
            baseMailStatusEmoji === MAILBOX_SENT_EMOJI
              ? await hasPostedMailMessage({
                  client: interaction.client,
                  guildId: interaction.guildId ?? null,
                  mailConfig: parsedMailConfig,
                })
              : false;
          const mailStatusEmoji = postedMailExistsForStatus
            ? MAILBOX_SENT_EMOJI
            : MAILBOX_NOT_SENT_EMOJI;
          const clanName = sanitizeClanName(trackedClanMeta?.name ?? "") ?? `#${tag}`;
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
          ];
          const singleView: MatchView = {
            embed: new EmbedBuilder().setTitle(preWarHeader).setDescription(preWarLines.join("\n")),
            copyText: limitDiscordContent([`# ${preWarHeader}`, ...preWarLines].join("\n")),
            matchTypeAction: null,
            matchTypeCurrent:
              (subscription?.matchType as "FWA" | "BL" | "MM" | "SKIP" | null | undefined) ?? null,
            inferredMatchType: false,
            outcomeAction: null,
            syncAction: null,
            clanName,
            clanTag: tag,
            mailStatusEmoji,
            skipSyncAction: subscription?.matchType === "SKIP" ? null : { tag },
            undoSkipSyncAction: subscription?.matchType === "SKIP" ? { tag } : null,
          };
          fwaMatchCopyPayloads.set(key, {
            userId: interaction.user.id,
            guildId: interaction.guildId ?? null,
            includePostButton: !isPublic,
            allianceView: { embed: overview.embed, copyText: overview.copyText, matchTypeAction: null },
            singleViews: {
              ...overview.singleViews,
              [tag]: singleView,
            },
            currentScope: "single",
            currentTag: tag,
          });
          const stored = fwaMatchCopyPayloads.get(key)!;
          await editReplySafe(
            "",
            [singleView.embed],
            buildFwaMatchCopyComponents(stored, interaction.user.id, key, "embed")
          );
          return;
        }

        const trackedScrape = parseTrackedClanPointsScrape(trackedClanMeta?.pointsScrape ?? null);
        const scrapeIsCurrentOpponent = isPointsScrapeUpdatedForOpponent(trackedScrape, opponentTag);
        const primary = scrapeIsCurrentOpponent
          ? buildSnapshotFromTrackedScrape(tag, trackedScrape as TrackedClanPointsScrape)
          : await getClanPointsCached(
              settings,
              cocService,
              tag,
              currentSync,
              warLookupCache,
              { requiredOpponentTag: opponentTag }
            );
        let opponent: PointsSnapshot;
        const siteUpdated =
          scrapeIsCurrentOpponent || isPointsSiteUpdatedForOpponent(primary, opponentTag, sourceSync);
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
        } else if (scrapeIsCurrentOpponent) {
          opponent = {
            ...primary,
            tag: opponentTag,
            balance: trackedScrape?.opponentPointBalance ?? null,
            clanName: trackedScrape?.opponentClanName ?? sanitizeClanName(String(war?.opponent?.name ?? "")) ?? opponentTag,
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
        const siteSyncObservedForWrite = scrapeIsCurrentOpponent
          ? trackedScrape?.syncNumber ?? null
          : primary.winnerBoxSync ?? null;
        const syncNumberForWrite =
          siteSyncObservedForWrite !== null && Number.isFinite(siteSyncObservedForWrite)
            ? Math.trunc(siteSyncObservedForWrite)
            : currentSync !== null && Number.isFinite(currentSync)
              ? Math.trunc(currentSync)
              : null;
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
          await prisma.currentWar.upsert({
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
              warStartFwaPoints: primary.balance,
              warEndFwaPoints: subscription?.warEndFwaPoints ?? null,
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
              warStartFwaPoints: { set: primary.balance },
              warEndFwaPoints: undefined,
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

        const projectionLine =
          matchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
          ? limitDiscordContent(
              buildMatchupMessage(primary, opponent, {
                primaryName: resolvedPrimaryName ?? primaryNameFromApi,
                opponentName: resolvedOpponentName ?? opponentNameFromApi,
              })
            )
              .split("\n")[1]
              ?.trim() ?? "Projection unavailable."
          : `This is a ${matchType} match.`;
        const syncDisplay = withSyncModeLabel(getSyncDisplay(sourceSync, warState), sourceSync);
        const leftName = resolvedPrimaryName ?? primaryNameFromApi ?? tag;
        const rightName = resolvedOpponentName ?? opponentNameFromApi ?? opponentTag;
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
        const siteSyncObserved = scrapeIsCurrentOpponent
          ? trackedScrape?.syncNumber ?? null
          : primary.winnerBoxSync ?? null;
        const syncMismatch = siteUpdated
          ? buildSyncMismatchWarning(currentSync, siteSyncObserved)
          : null;
        const outcomeMismatch = siteUpdated
          ? buildOutcomeMismatchWarning(
              (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ?? null,
              derivedOutcome
            )
          : null;
        const mismatchLines = [trackedMismatch, opponentMismatch, syncMismatch, outcomeMismatch]
          .filter(Boolean)
          .join("\n");
        const hasMismatch = Boolean(
          trackedMismatch || opponentMismatch || syncMismatch || outcomeMismatch
        );
        const siteStatusLine = buildPointsSyncStatusLine(siteUpdated, hasMismatch);
        const trackedMailConfig = await getTrackedClanMailConfig(tag);
        const parsedMailConfig = parseMatchMailConfig(
          subscription?.mailConfig as Prisma.JsonValue | null | undefined
        );
        const currentExpectedOutcomeForMail: "WIN" | "LOSE" | "UNKNOWN" | null =
          matchType === "FWA" ? (effectiveOutcome ?? "UNKNOWN") : null;
        const matchesLastPostedConfig =
          parsedMailConfig.lastMatchType === matchType &&
          (parsedMailConfig.lastExpectedOutcome ?? null) === currentExpectedOutcomeForMail;
        const postedMailExists = await hasPostedMailMessage({
          client: interaction.client,
          guildId: interaction.guildId ?? null,
          mailConfig: parsedMailConfig,
        });
        const mailBlockedReason = inferredMatchType
          ? "Match type is inferred. Confirm match type before sending war mail."
          : !trackedMailConfig?.mailChannelId
            ? "Mail channel is not configured. Use /tracked-clan configure with a mail channel."
            : postedMailExists && matchesLastPostedConfig
              ? "Current mail is already up to date. Change match config before sending again."
              : null;
        const outcomeLine =
          matchType === "FWA"
            ? `${effectiveOutcome ?? "UNKNOWN"}`
            : "";
        const matchTypeText = `${matchType}${inferredMatchType ? " :warning:" : ""}`;
        const verifyLink = inferredMatchType
          ? `[cc:${opponentTag}](${buildCcVerifyUrl(opponentTag)})`
          : "";
        const opponentCcUrl = buildCcVerifyUrl(opponentTag);
        const opponentPointsUrl = buildOfficialPointsUrl(opponentTag);
        const singleHeader = buildMatchStatusHeader({
          clanName: leftName,
          clanTag: tag,
          opponentName: rightName,
          opponentTag,
          matchType,
          outcome: effectiveOutcome ?? "UNKNOWN",
        });
        const embed = new EmbedBuilder()
          .setTitle(singleHeader)
          .setDescription(
            `${inferredMatchType ? `${MATCHTYPE_WARNING_LEGEND}\n\u200B\n` : ""}${projectionLine}\nMatch Type: **${matchTypeText}**${
              verifyLink ? ` ${verifyLink}` : ""
            }${
              outcomeLine ? `\nExpected outcome: **${outcomeLine}**` : ""
            }\n${siteStatusLine}${
              mailBlockedReason ? `\n:warning: ${mailBlockedReason}` : ""
            }\nWar state: **${formatWarStateLabel(warState)}**\nTime remaining: **${warRemaining}**\nSync: **${syncDisplay}**${
              mismatchLines ? `\n${mismatchLines}` : ""
            }`
          )
            .addFields(
              {
                name: "Points",
                value:
                  matchType === "FWA"
                    ? hasPrimaryPoints && hasOpponentPoints
                      ? `${leftName}: **${primary.balance}**\n${rightName}: **${opponent.balance}**`
                      : "Unavailable on both clans."
                    : hasPrimaryPoints
                      ? `${leftName}: **${primary.balance}**`
                      : "Unavailable",
                inline: true,
              },
              {
                name: "Opponent Links",
                value: `[cc.fwafarm](${opponentCcUrl})\n[points.fwafarm](${opponentPointsUrl})`,
                inline: true,
              }
            );
        const copyText = limitDiscordContent(
          [
            `# ${singleHeader}`,
            inferredMatchType ? MATCHTYPE_WARNING_LEGEND : "",
            siteStatusLine,
            mailBlockedReason ? `Warning: ${mailBlockedReason}` : "",
            `Sync: ${syncDisplay}`,
            `War State: ${formatWarStateLabel(warState)}`,
            `Time Remaining: ${warRemaining}`,
            `## Opponent Name`,
            `\`${rightName}\``,
            `## Opponent Tag`,
            `\`${opponentTag}\``,
            `CC: ${opponentCcUrl}`,
            `Points: ${opponentPointsUrl}`,
            `## Points`,
            hasPrimaryPoints && hasOpponentPoints ? `${leftName}: ${primary.balance}` : "Unavailable",
            matchType === "FWA" && hasPrimaryPoints && hasOpponentPoints
              ? `${rightName}: ${opponent.balance}`
              : "",
            `## Projection`,
            projectionLine,
            `Match Type: ${matchTypeText}`,
            verifyLink ? `Verify: ${buildCcVerifyUrl(opponentTag)}` : "",
            outcomeLine ? `Expected outcome: ${outcomeLine}` : "",
            mismatchLines,
          ]
            .filter(Boolean)
            .join("\n")
        );
        let alliance = overview;
        const singleView: MatchView = {
          embed,
          copyText,
          matchTypeAction:
            inferredMatchType && matchType !== "UNKNOWN"
              ? { tag, currentType: matchType as "FWA" | "BL" | "MM" }
              : null,
          matchTypeCurrent: matchType === "UNKNOWN" ? null : (matchType as "FWA" | "BL" | "MM"),
          inferredMatchType,
          outcomeAction:
            matchType === "FWA" && (effectiveOutcome === "WIN" || effectiveOutcome === "LOSE")
              ? { tag, currentOutcome: effectiveOutcome }
              : null,
          syncAction:
            siteUpdated && hasMismatch
              ? {
                  tag,
                  siteMatchType: hasOpponentPoints ? "FWA" : "MM",
                  siteFwaPoints: primary.balance,
                  siteOpponentFwaPoints: opponent.balance,
                  siteOutcome: matchType === "FWA" ? derivedOutcome : null,
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
        fwaMatchCopyPayloads.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guildId ?? null,
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
        select: { name: true, pointsScrape: true },
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
          ? await prisma.currentWar.findUnique({
              where: {
                guildId_clanTag: {
                  guildId: interaction.guildId,
                  clanTag: `#${tag}`,
                },
              },
              select: { fwaPoints: true, outcome: true },
            })
          : null;
      const trueOpponentTag = normalizeTag(String(war?.opponent?.tag ?? ""));
      const trackedScrape = parseTrackedClanPointsScrape(trackedClan?.pointsScrape ?? null);
      const scrapeIsCurrentOpponent = isPointsScrapeUpdatedForOpponent(
        trackedScrape,
        trueOpponentTag
      );
      const scrapeBalance = trackedScrape?.pointBalance ?? null;
      const siteUpdatedForCurrentWar =
        trueOpponentTag
          ? scrapeIsCurrentOpponent || isPointsSiteUpdatedForOpponent(result, trueOpponentTag, sourceSync)
          : false;
      const pointsMismatch =
        siteUpdatedForCurrentWar
          ? buildPointsMismatchWarning(
              displayName,
              subscription?.fwaPoints ?? null,
              scrapeIsCurrentOpponent ? scrapeBalance : balance
            )
          : null;
      const expectedSync = getCurrentSyncFromPrevious(sourceSync, warState);
      const siteSyncObserved = scrapeIsCurrentOpponent
        ? trackedScrape?.syncNumber ?? null
        : result.winnerBoxSync ?? null;
      const syncMismatch = siteUpdatedForCurrentWar
        ? buildSyncMismatchWarning(expectedSync, siteSyncObserved)
        : null;
      const opponentBalanceForOutcome = scrapeIsCurrentOpponent
        ? trackedScrape?.opponentPointBalance ?? null
        : trueOpponentTag
          ? deriveOpponentBalanceFromPrimarySnapshot(result, tag, trueOpponentTag)
          : null;
      const siteOutcome = siteUpdatedForCurrentWar && trueOpponentTag
        ? deriveProjectedOutcome(
            tag,
            trueOpponentTag,
            scrapeIsCurrentOpponent ? scrapeBalance : balance,
            opponentBalanceForOutcome,
            siteSyncObserved
          )
        : null;
      const outcomeMismatch = siteUpdatedForCurrentWar
        ? buildOutcomeMismatchWarning(
            (subscription?.outcome as "WIN" | "LOSE" | null | undefined) ?? null,
            siteOutcome
          )
        : null;
      const mismatchLines = [pointsMismatch, syncMismatch, outcomeMismatch]
        .filter(Boolean)
        .join("\n");
      const syncStatusLine = buildPointsSyncStatusLine(
        siteUpdatedForCurrentWar,
        Boolean(pointsMismatch || syncMismatch || outcomeMismatch)
      );

      await editReplySafe(
        `Clan Name: **${displayName}**\nTag: #${tag}\nPoint Balance: **${formatPoints(
          balance
        )}**\nWar state: ${formatWarStateLabel(warState)}\nTime remaining: ${warRemaining}\nSync: ${getSyncDisplay(
          sourceSync,
          warState
        )}\n${syncStatusLine}${mismatchLines ? `\n${mismatchLines}` : ""}\n${buildOfficialPointsUrl(tag)}`
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




