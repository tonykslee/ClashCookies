import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { hashMessageConfig } from "../helper/hashConfig";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";
import { PointsDirectFetchGateService } from "./PointsDirectFetchGateService";
import { PostedMessageService } from "./PostedMessageService";
import { PointsSyncService } from "./PointsSyncService";
import type { PointsApiFetchReason } from "./PointsFetchTypes";
import { SettingsService } from "./SettingsService";
import { CommandPermissionService } from "./CommandPermissionService";
import {
  chooseMatchTypeResolution,
  inferMatchTypeFromOpponentPoints,
  resolveCurrentWarMatchTypeSignal,
  toSyncIsFwa,
  type MatchTypeResolution,
} from "./MatchTypeResolutionService";
import { WarEventHistoryService } from "./war-events/history";
import { WarStartPointsSyncService } from "./war-events/pointsSync";
import { WarComplianceService, type WarComplianceIssue } from "./WarComplianceService";
import { buildFwaComplianceEmbedView } from "../commands/fwa/complianceEmbedView";
import { buildComplianceWarPlanText, sanitizeWarPlanForEmbed } from "./warPlanDisplay";
import { getNextNotifyRefreshAtMs } from "./refreshSchedule";
import {
  type EventType,
  type MatchType,
  type WarEndResultSnapshot,
  type WarState,
  computeExpectedWarEndPointsForTest,
  deriveExpectedOutcome,
  deriveState,
  eventTitle,
  normalizeOutcome,
  normalizeTag,
  normalizeTagBare,
  parseCocTime,
  shouldEmit,
  toDiscordRelativeTime,
} from "./war-events/core";
export {
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
} from "./war-events/core";

const NOTIFY_WAR_REFRESH_PREFIX = "notify-war-refresh";
const NOTIFY_WAR_ENDED_VIEW_PREFIX = "notify-war-end";
const NOTIFY_WAR_ENDED_VIEW_EXPIRED = "This war-end view expired.";
const BATTLE_DAY_REFRESH_MS = 20 * 60 * 1000;
const COC_WAR_OUTAGE_FAILURE_THRESHOLD = 2;
const COC_WAR_OUTAGE_RECOVERY_THRESHOLD = 2;
const battleDayPostByGuildTag = new Map<string, { channelId: string; messageId: string }>();
const warEndedViewStateByMessage = new Map<string, NotifyWarEndedViewState>();
const NOTIFY_UNKNOWN_OPPONENT = "Unknown Opponent";
const WAR_END_DISCREPANCY_MARKER = "war_end_discrepancy";
const POINTS_FWA_CLAN_URL_BASE = "https://points.fwafarm.com/clan?tag=";

/** Purpose: build canonical tracked-clan points URL for war-end mismatch follow-up. */
function buildTrackedClanPointsUrl(clanTag: string): string {
  return `${POINTS_FWA_CLAN_URL_BASE}${normalizeTagBare(clanTag)}`;
}

/** Purpose: keep mismatch warning headline concise while linking to tracked-clan points page. */
function buildWarEndMismatchWarningHeadline(clanTag: string): string {
  return `⚠️ War-end points mismatch detected. [points.fwafarm](<${buildTrackedClanPointsUrl(clanTag)}>)`;
}

function buildNextRefreshRelativeLabel(
  intervalMs: number,
  nowMs = Date.now(),
  nextScheduledAtMs?: number | null
): string {
  const nextAtMs =
    nextScheduledAtMs !== null &&
    nextScheduledAtMs !== undefined &&
    Number.isFinite(nextScheduledAtMs)
      ? Math.trunc(nextScheduledAtMs)
      : Math.trunc(nowMs + intervalMs);
  return `Next refresh <t:${Math.floor(nextAtMs / 1000)}:R>`;
}

export const buildNotifyNextRefreshLabelForTest = buildNextRefreshRelativeLabel;

function normalizeNotifyRoleId(roleId: string | null | undefined): string | null {
  const raw = String(roleId ?? "").trim();
  if (!raw) return null;
  const mentionMatch = raw.match(/^<@&(\d{5,})>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const idMatch = raw.match(/^(\d{5,})$/);
  if (idMatch?.[1]) return idMatch[1];
  return null;
}

function buildNotifyEventContextLine(eventType: EventType, opponentNameInput: string | null | undefined): string {
  const opponentName = String(opponentNameInput ?? "").trim() || NOTIFY_UNKNOWN_OPPONENT;
  if (eventType === "war_started") return `War declared against ${opponentName}`;
  if (eventType === "battle_day") return `War started against ${opponentName}`;
  return `War ended against ${opponentName}`;
}

function buildNotifyEventPostedContent(params: {
  eventType: EventType;
  opponentName: string | null | undefined;
  notifyRoleId?: string | null;
  includeRoleMention?: boolean;
  nowMs?: number;
  nextScheduledRefreshAtMs?: number | null;
}): string {
  const sections: string[] = [buildNotifyEventContextLine(params.eventType, params.opponentName)];
  const normalizedRoleId = normalizeNotifyRoleId(params.notifyRoleId);
  if (params.includeRoleMention !== false && normalizedRoleId) {
    sections.push(`<@&${normalizedRoleId}>`);
  }
  if (params.eventType === "battle_day") {
    sections.push(
      buildNextRefreshRelativeLabel(
        BATTLE_DAY_REFRESH_MS,
        params.nowMs,
        params.nextScheduledRefreshAtMs
      )
    );
  }
  return sections.join("\n");
}

export const buildNotifyEventPostedContentForTest = buildNotifyEventPostedContent;

function extractPostedNotifyMentionRoleId(existingPostedContent: string | null | undefined): string | null {
  const lines = String(existingPostedContent ?? "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^<@&(\d{5,})>$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function buildBattleDayRefreshEditPayload(
  existingPostedContent: string | null | undefined,
  opponentName: string | null | undefined,
  nowMs?: number
): { content: string; allowedMentions: { parse: [] } } {
  const persistedMentionRoleId = extractPostedNotifyMentionRoleId(existingPostedContent);
  return {
    content: buildNotifyEventPostedContent({
      eventType: "battle_day",
      opponentName,
      notifyRoleId: persistedMentionRoleId,
      includeRoleMention: Boolean(persistedMentionRoleId),
      nowMs,
      nextScheduledRefreshAtMs: getNextNotifyRefreshAtMs(),
    }),
    allowedMentions: { parse: [] },
  };
}

export const buildBattleDayRefreshEditPayloadForTest = buildBattleDayRefreshEditPayload;

/** Purpose: normalize and persist discrepancy fingerprint data on tracked notify rows. */
function parseWarEndDiscrepancyFingerprint(configHash: string | null | undefined): string | null {
  const raw = String(configHash ?? "");
  const match = raw.match(new RegExp(`(?:^|\\|)${WAR_END_DISCREPANCY_MARKER}:([^|]+)$`));
  return match?.[1] ? match[1] : null;
}

/** Purpose: write discrepancy fingerprint while preserving the existing notify config hash payload. */
function writeWarEndDiscrepancyFingerprint(
  configHash: string | null | undefined,
  fingerprint: string
): string {
  const raw = String(configHash ?? "");
  const stripped = raw.replace(
    new RegExp(`(?:^|\\|)${WAR_END_DISCREPANCY_MARKER}:[^|]+$`),
    ""
  );
  if (!stripped) return `${WAR_END_DISCREPANCY_MARKER}:${fingerprint}`;
  return `${stripped}|${WAR_END_DISCREPANCY_MARKER}:${fingerprint}`;
}

/** Purpose: build canonical mismatch fingerprint for idempotent war-end discrepancy alerts. */
function buildWarEndDiscrepancyFingerprint(
  warId: number,
  expectedPoints: number,
  actualPoints: number
): string {
  return `${Math.trunc(warId)}:${Math.trunc(expectedPoints)}:${Math.trunc(actualPoints)}`;
}

/** Purpose: build visible warning content for war-end points reconciliation mismatches. */
function buildWarEndDiscrepancyContent(params: {
  existingPostedContent: string | null | undefined;
  clanTag: string;
  opponentName: string | null | undefined;
  expectedPoints: number;
  actualPoints: number;
  fwaLeaderRoleId: string | null;
}): {
  content: string;
  allowedMentions: { parse: []; roles?: string[] };
} {
  const existingMentionRoleId = extractPostedNotifyMentionRoleId(params.existingPostedContent);
  const baseContent = buildNotifyEventPostedContent({
    eventType: "war_ended",
    opponentName: params.opponentName,
    notifyRoleId: existingMentionRoleId,
    includeRoleMention: Boolean(existingMentionRoleId),
  });
  const warningLines = [
    buildWarEndMismatchWarningHeadline(params.clanTag),
    `Expected points: ${Math.trunc(params.expectedPoints)}`,
    `Actual points: ${Math.trunc(params.actualPoints)}`,
  ];
  if (params.fwaLeaderRoleId) {
    warningLines.push(`<@&${params.fwaLeaderRoleId}>`);
  }
  return {
    content: [baseContent, ...warningLines].join("\n"),
    allowedMentions: params.fwaLeaderRoleId
      ? { parse: [], roles: [params.fwaLeaderRoleId] }
      : { parse: [] },
  };
}

export const buildWarEndDiscrepancyContentForTest = buildWarEndDiscrepancyContent;
export const buildWarEndDiscrepancyFingerprintForTest = buildWarEndDiscrepancyFingerprint;

/** Purpose: keep notify-event embed colors stable and centralized across render paths. */
export function resolveNotifyEventEmbedColor(eventType: EventType): number {
  if (eventType === "war_started") return 0x3498db;
  if (eventType === "battle_day") return 0xf1c40f;
  return 0x2ecc71;
}

type TestSource = "current" | "last";

type SubscriptionRow = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  syncNum: number | null;
  channelId: string | null;
  notify: boolean;
  pingRole: boolean;
  embedEnabled: boolean;
  inferredMatchType: boolean;
  notifyRole: string | null;
  fwaPoints: number | null;
  opponentFwaPoints: number | null;
  outcome: string | null;
  matchType: MatchType;
  warStartFwaPoints: number | null;
  warEndFwaPoints: number | null;
  clanStars: number | null;
  opponentStars: number | null;
  state: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
  pointsConfirmedByClanMail: boolean | null;
  pointsNeedsValidation: boolean | null;
  pointsLastSuccessfulFetchAt: Date | null;
  pointsLastKnownSyncNumber: number | null;
  pointsLastKnownPoints: number | null;
  pointsLastKnownMatchType: string | null;
  pointsLastKnownOutcome: string | null;
  pointsWarId: string | null;
  pointsOpponentTag: string | null;
  pointsWarStartTime: Date | null;
};

type PollTarget = {
  guildId: string;
  clanTag: string;
  channelId: string | null;
  notify: boolean;
  pingRole: boolean;
  inferredMatchType: boolean;
  notifyRole: string | null;
  clanName: string | null;
};


type PollSyncContext = {
  previousSync: number | null;
  activeSync: number | null;
};

type CocWarOutageState = {
  failureStreak: number;
  recoveryStreak: number;
  suspected: boolean;
  lastFailureStatusCode: number | null;
  updatedAt: Date;
};

type CocWarFetchObservation =
  | {
      kind: "success";
    }
  | {
      kind: "failure";
      statusCode: number | null;
    };

type EmbedWarStats = {
  clanStars: number | null;
  opponentStars: number | null;
  clanAttacks: number | null;
  opponentAttacks: number | null;
  teamSize: number | null;
  attacksPerMember: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
};

type WarMemberSnapshot = {
  tag?: string;
  name?: string;
  mapPosition?: number;
  attacks?: Array<{
    order?: number;
    stars?: number;
    destructionPercentage?: number;
    defenderTag?: string;
    defenderPosition?: number;
  }> | null;
};

type SnapshotWarAttackRow = {
  playerTag: string;
  playerName: string;
  playerPosition: number | null;
  attacksUsed: number;
  attackOrder: number;
  attackNumber: number;
  defenderTag: string | null;
  defenderName: string | null;
  defenderPosition: number | null;
  stars: number;
  trueStars: number;
  destruction: number;
};

type PendingSnapshotWarAttackRow = SnapshotWarAttackRow & {
  sortAttackOrder: number;
  sortPlayerPosition: number;
  sortPlayerTag: string;
  sortAttackNumber: number;
  sortMemberIndex: number;
};

type NotifyWarEndedViewToken = "s" | "c";

type NotifyWarEndedViewCustomIdInput = {
  view: NotifyWarEndedViewToken;
  guildId: string;
  clanTag: string;
  warId: number;
  messageId: string;
  timestampUnix: number;
  page?: number;
};

type ParsedNotifyWarEndedViewCustomId = {
  view: NotifyWarEndedViewToken;
  guildId: string;
  clanTag: string;
  warId: number;
  messageId: string;
  timestampUnix: number;
  page: number;
};

type NotifyWarEndedSummaryState = {
  clanName: string;
  opponentName: string;
  opponentTag: string;
  syncNumber: number | null;
  resultLabel: "WIN" | "LOSS" | "DRAW" | "UNKNOWN";
  warStatsValue: string;
  pointsLine: string;
  missedBothLines: string[];
};

type NotifyWarEndedComplianceState = {
  clanName: string;
  warPlanText: string | null;
  warId: number | null;
  expectedOutcome: "WIN" | "LOSE" | null;
  fwaWinGateConfig:
    | {
        nonMirrorTripleMinClanStars: number;
        allBasesOpenHoursLeft: number;
      }
    | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  participantsCount: number;
  attacksCount: number;
  missedBoth: WarComplianceIssue[];
  notFollowingPlan: WarComplianceIssue[];
};

type NotifyWarEndedViewState = {
  guildId: string;
  clanTag: string;
  warId: number;
  messageId: string;
  matchType: MatchType;
  timestampUnix: number;
  summary: NotifyWarEndedSummaryState;
  compliance: NotifyWarEndedComplianceState | null;
};

function sanitizeWarEndedPage(input: number | null | undefined): number {
  const parsed = Number(input ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toWarEndedViewStateKey(guildId: string, messageId: string): string {
  return `${guildId}:${messageId}`;
}

function resolveWarEndedMetadataTimestampUnix(
  warEndTime: Date | null,
  fallbackDate: Date
): number {
  const warEndMs = warEndTime instanceof Date ? warEndTime.getTime() : NaN;
  if (Number.isFinite(warEndMs)) {
    return Math.floor(warEndMs / 1000);
  }
  const fallbackMs = fallbackDate.getTime();
  if (Number.isFinite(fallbackMs)) {
    return Math.floor(fallbackMs / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function buildWarEndedMetadataValue(input: {
  warId: number | null;
  syncNumber: number | null;
  timestampUnix: number;
}): string {
  const warIdText =
    input.warId !== null && Number.isFinite(Number(input.warId))
      ? String(Math.trunc(Number(input.warId)))
      : "unknown";
  const syncText =
    input.syncNumber !== null && Number.isFinite(Number(input.syncNumber))
      ? String(Math.trunc(Number(input.syncNumber)))
      : "unknown";
  const timestampToken = Number.isFinite(Number(input.timestampUnix))
    ? `<t:${Math.trunc(Number(input.timestampUnix))}:F>`
    : "unknown";
  return `War ID: ${warIdText} - Sync: ${syncText} - ${timestampToken}`;
}

export const buildWarEndedMetadataValueForTest = buildWarEndedMetadataValue;

function sortWarComplianceIssuesByPosition(issues: WarComplianceIssue[]): WarComplianceIssue[] {
  return [...issues].sort((a, b) => {
    const posA = Number.isFinite(Number(a.playerPosition))
      ? Number(a.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    const posB = Number.isFinite(Number(b.playerPosition))
      ? Number(b.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    const nameA = String(a.playerName ?? "").trim() || String(a.playerTag ?? "").trim();
    const nameB = String(b.playerName ?? "").trim() || String(b.playerTag ?? "").trim();
    return nameA.localeCompare(nameB);
  });
}

function formatWarEndedMissedBothLine(issue: WarComplianceIssue): string {
  const name = String(issue.playerName ?? "").trim() || "Unknown member";
  const tag = normalizeTag(issue.playerTag);
  if (!tag) return name;
  return `${name} (${tag})`;
}

function formatWarEndedRosterValue(lines: string[]): string {
  if (lines.length <= 0) return "None";
  const normalized = lines
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0);
  if (normalized.length <= 0) return "None";
  const capped = normalized.slice(0, 15);
  const extra = normalized.length - capped.length;
  return extra > 0 ? `${capped.join("\n")}\n(+${extra} more)` : capped.join("\n");
}

function withNotifyComplianceEmptyState(
  embed: EmbedBuilder,
  hasViolations: boolean
): EmbedBuilder {
  if (hasViolations) return embed;
  const json = embed.toJSON();
  const fields = Array.isArray(json.fields)
    ? json.fields.map((field) =>
        field.name === "Plan Violations"
          ? {
              ...field,
              value: "None",
            }
          : field
      )
    : json.fields;
  return EmbedBuilder.from({
    ...json,
    fields,
  });
}

function toNotifyWarEndedViewToken(input: string): NotifyWarEndedViewToken | null {
  if (input === "s" || input === "c") return input;
  return null;
}

export function buildNotifyWarEndedViewCustomId(input: NotifyWarEndedViewCustomIdInput): string {
  const warId = Math.max(1, Math.trunc(Number(input.warId)));
  const page = sanitizeWarEndedPage(input.page);
  const timestampUnix = Math.max(0, Math.trunc(Number(input.timestampUnix)));
  return [
    NOTIFY_WAR_ENDED_VIEW_PREFIX,
    input.view,
    String(input.guildId),
    normalizeTagBare(input.clanTag),
    String(warId),
    String(input.messageId),
    String(timestampUnix),
    String(page),
  ].join(":");
}

export function parseNotifyWarEndedViewCustomId(
  customId: string
): ParsedNotifyWarEndedViewCustomId | null {
  const [prefix, viewRaw, guildId, clanTagBare, warIdRaw, messageId, timestampRaw, pageRaw] = String(
    customId ?? ""
  ).split(":");
  if (prefix !== NOTIFY_WAR_ENDED_VIEW_PREFIX) return null;
  const view = toNotifyWarEndedViewToken(viewRaw);
  if (!view) return null;
  if (!/^\d{5,}$/.test(guildId ?? "")) return null;
  if (!/^[A-Z0-9]+$/i.test(clanTagBare ?? "")) return null;
  if (!/^\d{5,}$/.test(messageId ?? "")) return null;
  const warId = Number(warIdRaw);
  if (!Number.isFinite(warId) || Math.trunc(warId) <= 0) return null;
  const timestampUnix = Number(timestampRaw);
  if (!Number.isFinite(timestampUnix) || Math.trunc(timestampUnix) <= 0) return null;
  const page = sanitizeWarEndedPage(Number(pageRaw));
  return {
    view,
    guildId,
    clanTag: normalizeTag(clanTagBare),
    warId: Math.trunc(warId),
    messageId,
    timestampUnix: Math.trunc(timestampUnix),
    page,
  };
}

export function isNotifyWarEndedViewButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_ENDED_VIEW_PREFIX}:`);
}

function toFiniteIntOrNull(input: unknown): number | null {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function compareLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Purpose: compute global war-snapshot attack rows with deterministic true-stars attribution. */
function computeWarSnapshotAttackRows(input: {
  ownMembers: WarMemberSnapshot[];
  opponentMembers: WarMemberSnapshot[];
}): SnapshotWarAttackRow[] {
  const opponentByTag = new Map<string, WarMemberSnapshot>();
  for (const member of input.opponentMembers) {
    const tag = normalizeTag(member?.tag ?? "");
    if (tag) opponentByTag.set(tag, member);
  }

  const pendingRows: PendingSnapshotWarAttackRow[] = [];
  for (let memberIndex = 0; memberIndex < input.ownMembers.length; memberIndex += 1) {
    const member = input.ownMembers[memberIndex];
    const playerTag = normalizeTag(member?.tag ?? "");
    if (!playerTag) continue;
    const playerName = String(member?.name ?? playerTag).trim() || playerTag;
    const playerPosition = toFiniteIntOrNull(member?.mapPosition);
    const attacks = Array.isArray(member?.attacks) ? member.attacks : [];
    const attacksUsed = attacks.length;
    const indexedAttacks = attacks.map((attack, index) => ({ attack, index }));
    indexedAttacks.sort((a, b) => {
      const orderA = toFiniteIntOrNull(a.attack?.order);
      const orderB = toFiniteIntOrNull(b.attack?.order);
      const normalizedA = orderA ?? Number.MAX_SAFE_INTEGER;
      const normalizedB = orderB ?? Number.MAX_SAFE_INTEGER;
      return normalizedA - normalizedB || a.index - b.index;
    });

    for (let idx = 0; idx < indexedAttacks.length; idx += 1) {
      const wrapped = indexedAttacks[idx];
      const attack = wrapped.attack;
      const attackNumber = idx + 1;
      const explicitOrder = toFiniteIntOrNull(attack?.order);
      const attackOrder = explicitOrder ?? attackNumber;
      const sortAttackOrder = explicitOrder ?? Number.MAX_SAFE_INTEGER;
      const defenderTag = normalizeTag(attack?.defenderTag ?? "");
      const defender = defenderTag ? opponentByTag.get(defenderTag) ?? null : null;
      const defenderName = defender
        ? String(defender.name ?? defenderTag).trim() || defenderTag
        : null;
      const defenderPosition =
        toFiniteIntOrNull(defender?.mapPosition) ??
        toFiniteIntOrNull(attack?.defenderPosition);
      const stars = Math.max(0, Number(attack?.stars ?? 0));
      const destruction = Number(attack?.destructionPercentage ?? 0);

      pendingRows.push({
        playerTag,
        playerName,
        playerPosition,
        attacksUsed,
        attackOrder,
        attackNumber,
        defenderTag: defenderTag || null,
        defenderName,
        defenderPosition,
        stars,
        trueStars: 0,
        destruction,
        sortAttackOrder,
        sortPlayerPosition: playerPosition ?? Number.MAX_SAFE_INTEGER,
        sortPlayerTag: playerTag,
        sortAttackNumber: attackNumber,
        sortMemberIndex: memberIndex,
      });
    }
  }

  // Global deterministic order: attack.order, then stable member/attack fallbacks.
  pendingRows.sort((a, b) => {
    return (
      a.sortAttackOrder - b.sortAttackOrder ||
      a.sortPlayerPosition - b.sortPlayerPosition ||
      compareLexicographic(a.sortPlayerTag, b.sortPlayerTag) ||
      a.sortAttackNumber - b.sortAttackNumber ||
      a.sortMemberIndex - b.sortMemberIndex
    );
  });

  const defenderBestStars = new Map<string, number>();
  for (const row of pendingRows) {
    const defenderKey =
      row.defenderTag !== null && row.defenderTag.length > 0
        ? `TAG:${row.defenderTag}`
        : row.defenderPosition !== null
          ? `POS:${row.defenderPosition}`
          : null;
    if (!defenderKey) {
      row.trueStars = 0;
      continue;
    }
    const previousBest = defenderBestStars.get(defenderKey) ?? 0;
    row.trueStars = Math.max(0, row.stars - previousBest);
    defenderBestStars.set(defenderKey, Math.max(previousBest, row.stars));
  }

  return pendingRows.map((row) => ({
    playerTag: row.playerTag,
    playerName: row.playerName,
    playerPosition: row.playerPosition,
    attacksUsed: row.attacksUsed,
    attackOrder: row.attackOrder,
    attackNumber: row.attackNumber,
    defenderTag: row.defenderTag,
    defenderName: row.defenderName,
    defenderPosition: row.defenderPosition,
    stars: row.stars,
    trueStars: row.trueStars,
    destruction: row.destruction,
  }));
}

type EventEmitPayload = {
  eventType: EventType;
  clanTag: string;
  clanName: string;
  opponentTag: string;
  opponentName: string;
  syncNumber: number | null;
  notifyRole: string | null;
  pingRole: boolean;
  fwaPoints: number | null;
  opponentFwaPoints: number | null;
  outcome: "WIN" | "LOSE" | null;
  matchType: MatchType;
  warStartFwaPoints: number | null;
  warEndFwaPoints: number | null;
  clanStars: number | null;
  opponentStars: number | null;
  prepStartTime: Date | null;
  warStartTime: Date | null;
  warEndTime: Date | null;
  clanAttacks: number | null;
  opponentAttacks: number | null;
  teamSize: number | null;
  attacksPerMember: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
  resolvedWarIdHint?: number | null;
  testFinalResultOverride?: WarEndResultSnapshot | null;
};

export type NotifyWarPreviewResult = {
  ok: boolean;
  reason?: string;
  clanName?: string;
  clanTag?: string;
  channelId?: string;
  embeds?: EmbedBuilder[];
};

/** Purpose: detect if current poll belongs to a newer war cycle than the stored snapshot. */
function isNewWarCycle(
  previousWarStartTime: Date | null,
  nextWarStartTime: Date | null
): boolean {
  if (!(nextWarStartTime instanceof Date) || Number.isNaN(nextWarStartTime.getTime())) return false;
  if (!(previousWarStartTime instanceof Date) || Number.isNaN(previousWarStartTime.getTime())) return true;
  return nextWarStartTime.getTime() !== previousWarStartTime.getTime();
}

function deriveResultLabelFromStars(
  clanStars: number | null,
  opponentStars: number | null
): "WIN" | "LOSE" | "TIE" | "UNKNOWN" {
  if (clanStars === null || opponentStars === null) return "UNKNOWN";
  if (clanStars > opponentStars) return "WIN";
  if (clanStars < opponentStars) return "LOSE";
  return "TIE";
}

function formatResultLabelForEmbed(
  result: "WIN" | "LOSE" | "TIE" | "UNKNOWN"
): "WIN" | "LOSS" | "DRAW" | "UNKNOWN" {
  if (result === "WIN") return "WIN";
  if (result === "LOSE") return "LOSS";
  if (result === "TIE") return "DRAW";
  return "UNKNOWN";
}

function makeBattleDayPostKey(guildId: string, clanTag: string): string {
  return `${guildId}:${normalizeTag(clanTag)}`;
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

function buildWarStatsLines(stats: EmbedWarStats): string[] {
  const starsLeft = formatWarInt(stats.clanStars);
  const starsRight = formatWarInt(stats.opponentStars);
  const attacksPerMember = Number.isFinite(Number(stats.attacksPerMember))
    ? Math.max(1, Math.trunc(Number(stats.attacksPerMember)))
    : 2;
  const teamSize = Number.isFinite(Number(stats.teamSize))
    ? Math.max(1, Math.trunc(Number(stats.teamSize)))
    : 0;
  const totalAttacks = teamSize > 0 ? teamSize * attacksPerMember : 0;
  const attacksLeft = formatWarInt(stats.clanAttacks);
  const attacksRight = formatWarInt(stats.opponentAttacks);
  const attacksLeftText = totalAttacks > 0 ? `${attacksLeft}/${totalAttacks}` : `${attacksLeft}/?`;
  const attacksRightText = totalAttacks > 0 ? `${attacksRight}/${totalAttacks}` : `${attacksRight}/?`;
  return [
    "War Stats",
    formatWarStatLine(starsLeft, ":star:", starsRight),
    formatWarStatLine(attacksLeftText, ":crossed_swords:", attacksRightText),
    formatWarStatLine(formatWarPercent(stats.clanDestruction), ":boom:", formatWarPercent(stats.opponentDestruction)),
  ];
}

export const sanitizeWarPlanForEmbedForTest = sanitizeWarPlanForEmbed;

/** Purpose: extract a numeric HTTP status code from CoC API errors. */
function parseCocApiStatusCode(error: unknown): number | null {
  const responseStatus = Number(
    (error as { response?: { status?: unknown } } | null | undefined)?.response?.status
  );
  if (Number.isFinite(responseStatus) && responseStatus >= 100 && responseStatus <= 599) {
    return Math.trunc(responseStatus);
  }
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? "");
  const match = message.match(/CoC API error (\d{3})/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Purpose: advance outage suspicion state from the latest CoC poll observation. */
function advanceCocWarOutageState(
  previous: CocWarOutageState | null,
  observation: CocWarFetchObservation,
  now: Date
): CocWarOutageState {
  const base: CocWarOutageState =
    previous ?? {
      failureStreak: 0,
      recoveryStreak: 0,
      suspected: false,
      lastFailureStatusCode: null,
      updatedAt: now,
    };

  if (observation.kind === "failure") {
    const failureStreak = base.failureStreak + 1;
    return {
      failureStreak,
      recoveryStreak: 0,
      suspected: base.suspected || failureStreak >= COC_WAR_OUTAGE_FAILURE_THRESHOLD,
      lastFailureStatusCode: observation.statusCode,
      updatedAt: now,
    };
  }

  const recoveryStreak = base.recoveryStreak + 1;
  return {
    failureStreak: 0,
    recoveryStreak,
    suspected: base.suspected && recoveryStreak < COC_WAR_OUTAGE_RECOVERY_THRESHOLD,
    lastFailureStatusCode: base.lastFailureStatusCode,
    updatedAt: now,
  };
}

/** Purpose: resolve same-war timing while preventing prior-war end-time bleed. */
function resolveActiveWarTiming(input: {
  observedWarStartTime: Date | null;
  observedWarEndTime: Date | null;
  previousWarStartTime: Date | null;
  previousWarEndTime: Date | null;
}): {
  warStartTime: Date | null;
  warEndTime: Date | null;
  sameWarIdentity: boolean;
} {
  const warStartTime = input.observedWarStartTime ?? input.previousWarStartTime;
  const sameWarIdentity = Boolean(
    warStartTime &&
      input.previousWarStartTime &&
      warStartTime.getTime() === input.previousWarStartTime.getTime()
  );
  const warEndTime =
    input.observedWarEndTime ?? (sameWarIdentity ? input.previousWarEndTime ?? null : null);
  return {
    warStartTime,
    warEndTime,
    sameWarIdentity,
  };
}

/** Purpose: gate uncertain war-ended transitions so transient snapshots cannot close active wars. */
function applyWarEndedMaintenanceGuard(input: {
  eventType: EventType | null;
  previousState: WarState;
  candidateState: WarState;
  warFetchFailed: boolean;
  maintenanceSuspected: boolean;
  knownWarEndTime: Date | null;
  now: Date;
}): {
  eventType: EventType | null;
  state: WarState;
  suppressReason: string | null;
} {
  if (input.eventType !== "war_ended") {
    return {
      eventType: input.eventType,
      state: input.candidateState,
      suppressReason: null,
    };
  }

  const knownEndMs = input.knownWarEndTime instanceof Date ? input.knownWarEndTime.getTime() : NaN;
  const nowMs = input.now.getTime();
  const hasKnownEnd = Number.isFinite(knownEndMs);
  const beforeKnownEnd = hasKnownEnd && nowMs < knownEndMs;
  const maintenanceBlocksTransition =
    input.maintenanceSuspected && (!hasKnownEnd || beforeKnownEnd);

  if (input.warFetchFailed) {
    return {
      eventType: null,
      state: input.previousState,
      suppressReason: "upstream_unavailable",
    };
  }
  if (beforeKnownEnd) {
    return {
      eventType: null,
      state: input.previousState,
      suppressReason: "before_known_war_end_time",
    };
  }
  if (maintenanceBlocksTransition) {
    return {
      eventType: null,
      state: input.previousState,
      suppressReason: "maintenance_suspected",
    };
  }

  return {
    eventType: input.eventType,
    state: input.candidateState,
    suppressReason: null,
  };
}

export const advanceCocWarOutageStateForTest = advanceCocWarOutageState;
export const resolveActiveWarTimingForTest = resolveActiveWarTiming;
export const applyWarEndedMaintenanceGuardForTest = applyWarEndedMaintenanceGuard;
export const computeWarSnapshotAttackRowsForTest = computeWarSnapshotAttackRows;

export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly pointsGate: PointsDirectFetchGateService;
  private readonly pointsSync: WarStartPointsSyncService;
  private readonly currentSyncs: PointsSyncService;
  private readonly commandPermissions: CommandPermissionService;
  private readonly history: WarEventHistoryService;
  private readonly warCompliance: WarComplianceService;
  private readonly postedMessages: PostedMessageService;
  private readonly cocWarOutageByClanTag = new Map<string, CocWarOutageState>();

  /** Purpose: initialize service dependencies. */
  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.pointsGate = new PointsDirectFetchGateService();
    this.pointsSync = new WarStartPointsSyncService(this.points, new SettingsService());
    this.currentSyncs = new PointsSyncService();
    this.commandPermissions = new CommandPermissionService();
    this.history = new WarEventHistoryService(coc);
    this.warCompliance = new WarComplianceService();
    this.postedMessages = new PostedMessageService();
  }

  /** Purpose: poll. */
  async poll(): Promise<void> {
    const previousSync = await this.pointsSync.getPreviousSyncNum();
    const syncContext: PollSyncContext = {
      previousSync,
      activeSync: previousSync === null ? null : previousSync + 1,
    };
    const targets = await this.listPollTargets();
    for (const target of targets) {
      await this.ensureCurrentWarBaseline(target);
      await this.processSubscription(target.guildId, target.clanTag, syncContext).catch((err) => {
        console.error(
          `[war-events] process failed guild=${target.guildId} clan=${target.clanTag} error=${formatError(
            err
          )}`
        );
      });
    }
  }

  private async listPollTargets(): Promise<PollTarget[]> {
    const [trackedClans, currentWars, notifyConfigs] = await Promise.all([
      prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          tag: true,
          name: true,
          notifyChannelId: true,
          notifyRole: true,
          notifyEnabled: true,
          mailChannelId: true,
          logChannelId: true,
        },
      }),
      prisma.currentWar.findMany({
        select: {
          guildId: true,
          clanTag: true,
          channelId: true,
          notify: true,
          pingRole: true,
          inferredMatchType: true,
          notifyRole: true,
          clanName: true,
        },
      }),
      prisma.clanNotifyConfig.findMany({
        select: {
          guildId: true,
          clanTag: true,
          channelId: true,
          roleId: true,
          pingEnabled: true,
          embedEnabled: true,
        },
      }),
    ]);

    const currentWarsByTag = new Map<string, typeof currentWars>();
    for (const row of currentWars) {
      const key = normalizeTag(row.clanTag);
      const list = currentWarsByTag.get(key) ?? [];
      list.push(row);
      currentWarsByTag.set(key, list);
    }

    const notifyConfigsByTag = new Map<string, typeof notifyConfigs>();
    for (const row of notifyConfigs) {
      const key = normalizeTag(row.clanTag);
      const list = notifyConfigsByTag.get(key) ?? [];
      list.push(row);
      notifyConfigsByTag.set(key, list);
    }

    const targets: PollTarget[] = [];
    for (const tracked of trackedClans) {
      const clanTag = normalizeTag(tracked.tag);
      const configRows = notifyConfigsByTag.get(clanTag) ?? [];
      const currentRows = currentWarsByTag.get(clanTag) ?? [];
      const guildIds = new Set<string>();
      for (const row of configRows) guildIds.add(row.guildId);
      for (const row of currentRows) guildIds.add(row.guildId);
      for (const guildId of guildIds) {
        const config = configRows.find((row) => row.guildId === guildId) ?? null;
        const current = currentRows.find((row) => row.guildId === guildId) ?? null;
        targets.push({
          guildId,
          clanTag,
          channelId:
            config?.channelId ??
            current?.channelId ??
            tracked.notifyChannelId ??
            tracked.mailChannelId ??
            tracked.logChannelId ??
            null,
          notify: config?.embedEnabled ?? current?.notify ?? tracked.notifyEnabled ?? false,
          pingRole: config?.pingEnabled ?? current?.pingRole ?? true,
          inferredMatchType: current?.inferredMatchType ?? true,
          notifyRole: config?.roleId ?? current?.notifyRole ?? tracked.notifyRole ?? null,
          clanName: current?.clanName ?? tracked.name ?? null,
        });
      }
    }

    return targets.sort((a, b) =>
      `${a.guildId}:${normalizeTagBare(a.clanTag)}`.localeCompare(
        `${b.guildId}:${normalizeTagBare(b.clanTag)}`
      )
    );
  }

  private async ensureCurrentWarBaseline(target: PollTarget): Promise<void> {
    if (!target.channelId) return;
    await prisma.currentWar.upsert({
      where: {
        clanTag_guildId: {
          clanTag: target.clanTag,
          guildId: target.guildId,
        },
      },
      update: {
        channelId: target.channelId,
        notify: target.notify,
        pingRole: target.pingRole,
        inferredMatchType: target.inferredMatchType,
        notifyRole: target.notifyRole,
        clanName: target.clanName,
      },
      create: {
        guildId: target.guildId,
        clanTag: target.clanTag,
        channelId: target.channelId,
        notify: target.notify,
        pingRole: target.pingRole,
        inferredMatchType: target.inferredMatchType,
        notifyRole: target.notifyRole,
        clanName: target.clanName,
        state: "notInWar",
      },
    });
  }

  async emitTestEventForClan(params: {
    guildId: string;
    clanTag: string;
    eventType: EventType;
    source: TestSource;
  }): Promise<{ ok: boolean; reason?: string }> {
    const sub = await this.findSubscriptionByGuildAndTag(params.guildId, params.clanTag);
    if (!sub) return { ok: false, reason: "No war event subscription found for that guild+clan." };
    if (!sub.channelId) return { ok: false, reason: "Subscription has no configured channel." };
    const payload = await this.buildTestEventPayload(sub, params);
    const canonicalized =
      payload.eventType === "war_ended"
        ? await this.resolveCanonicalWarEndedPayloadContext(payload)
        : { payload, warId: null };
    const payloadForEmit = canonicalized.payload;
    const resolvedWarId =
      canonicalized.warId ??
      payloadForEmit.resolvedWarIdHint ??
      (await this.resolveWarId(payloadForEmit.clanTag, payloadForEmit.warStartTime));
    await this.emitEvent(sub.channelId, payloadForEmit, resolvedWarId, sub);

    return { ok: true };
  }

  async buildTestEventPreviewForClan(params: {
    guildId: string;
    clanTag: string;
    eventType: EventType;
    source: TestSource;
  }): Promise<NotifyWarPreviewResult> {
    // Get config from ClanNotifyConfig table
    const config = await prisma.clanNotifyConfig.findUnique({
      where: {
        guildId_clanTag: {
          guildId: params.guildId,
          clanTag: normalizeTagBare(params.clanTag),
        },
      },
    });
    if (!config) return { ok: false, reason: "No notification configuration found for that guild+clan." };
    if (!config.channelId) return { ok: false, reason: "Configuration has no channel set." };

    // Get current war data for the payload
    const sub = await this.findSubscriptionByGuildAndTag(params.guildId, params.clanTag);
    if (!sub) return { ok: false, reason: "No current war data found for that clan." };

    const payload = await this.buildTestEventPayload(sub, params);
    const canonicalized =
      payload.eventType === "war_ended"
        ? await this.resolveCanonicalWarEndedPayloadContext(payload)
        : { payload, warId: null };
    const payloadForPreview = canonicalized.payload;
    const warId =
      canonicalized.warId ??
      payloadForPreview.resolvedWarIdHint ??
      (await this.resolveWarId(payloadForPreview.clanTag, payloadForPreview.warStartTime));
    const message = await this.buildEventMessage(payloadForPreview, params.guildId, {
      includeRoleMention: false,
      includeEventComponents: false,
      warId,
    });
    return {
      ok: true,
      clanName: payloadForPreview.clanName,
      clanTag: payloadForPreview.clanTag,
      channelId: config.channelId,
      embeds: message.embeds,
    };
  }

  private async buildTestEventPayload(
    sub: SubscriptionRow,
    params: { eventType: EventType; source: TestSource }
  ): Promise<EventEmitPayload> {
    const previousSync = await this.pointsSync.getPreviousSyncNum();
    const activeSync = previousSync === null ? null : previousSync + 1;

    const currentWar =
      params.source === "current"
        ? await this.coc.getCurrentWar(sub.clanTag).catch(() => null)
        : null;
    const lastWarLogEntry =
      params.source === "last"
        ? (await this.coc.getClanWarLog(sub.clanTag, 1))[0] ?? null
        : null;
    const lastWarRow =
      params.source === "last"
        ? await prisma.warAttacks.findFirst({
            where: { clanTag: normalizeTag(sub.clanTag), warEndTime: { not: null }, attackOrder: 0 },
            orderBy: { warStartTime: "desc" },
            select: {
              warId: true,
              clanName: true,
              opponentClanTag: true,
              opponentClanName: true,
              warStartTime: true,
            },
          })
        : null;
    const lastWarHistoryRow =
      params.source === "last"
        ? await prisma.clanWarHistory.findFirst({
            where: { clanTag: normalizeTag(sub.clanTag) },
            orderBy: [{ warEndTime: "desc" }, { warStartTime: "desc" }, { updatedAt: "desc" }],
            select: {
              warId: true,
              syncNumber: true,
              clanName: true,
              opponentTag: true,
              opponentName: true,
              warStartTime: true,
              warEndTime: true,
              expectedOutcome: true,
              matchType: true,
            },
          })
        : null;
    const syncNumber =
      params.source === "last" &&
      lastWarHistoryRow?.syncNumber !== null &&
      lastWarHistoryRow?.syncNumber !== undefined &&
      Number.isFinite(Number(lastWarHistoryRow?.syncNumber))
        ? Math.trunc(Number(lastWarHistoryRow.syncNumber))
        : params.source === "last"
          ? previousSync
          : activeSync;

    const clanTag = normalizeTag(sub.clanTag);
    const opponentTag = normalizeTag(
      currentWar?.opponent?.tag ??
        lastWarHistoryRow?.opponentTag ??
        lastWarLogEntry?.opponent?.tag ??
        lastWarRow?.opponentClanTag ??
        sub.opponentTag ??
        ""
    );
    const clanName =
      String(
        currentWar?.clan?.name ??
          lastWarHistoryRow?.clanName ??
          lastWarLogEntry?.clan?.name ??
          lastWarRow?.clanName ??
          sub.clanName ??
          clanTag
      ).trim() || clanTag;
    const opponentName =
      String(
        currentWar?.opponent?.name ??
          lastWarHistoryRow?.opponentName ??
          lastWarLogEntry?.opponent?.name ??
          lastWarRow?.opponentClanName ??
          sub.opponentName ??
          "Unknown"
      ).trim() || "Unknown";

    let fwaPoints = sub.fwaPoints;
    let opponentFwaPoints = sub.opponentFwaPoints;
    let outcome =
      params.source === "last"
        ? normalizeOutcome(lastWarHistoryRow?.expectedOutcome ?? sub.outcome)
        : normalizeOutcome(sub.outcome);
    let matchType: MatchType =
      params.source === "last" &&
      (lastWarHistoryRow?.matchType === "BL" ||
        lastWarHistoryRow?.matchType === "MM" ||
        lastWarHistoryRow?.matchType === "FWA")
        ? lastWarHistoryRow.matchType
        : sub.matchType;
    if (params.source === "current" && opponentTag) {
      const [a, b] = await Promise.all([
        this.points.fetchSnapshot(clanTag, {
          reason: "manual_refresh",
          caller: "command",
          manualForceBypass: true,
        }),
        this.points.fetchSnapshot(opponentTag, {
          reason: "manual_refresh",
          caller: "command",
          manualForceBypass: true,
          fallbackTrackedClanTag: clanTag,
        }),
      ]);
      fwaPoints = a.balance;
      opponentFwaPoints = b.balance;
      outcome = deriveExpectedOutcome(clanTag, opponentTag, a.balance, b.balance, syncNumber);
    }

    const currentWarStartTime = parseCocTime(currentWar?.startTime ?? null);
    const testWarStartTime =
      params.source === "current"
        ? currentWarStartTime ?? sub.startTime
        : lastWarHistoryRow?.warStartTime ?? lastWarRow?.warStartTime ?? sub.startTime ?? currentWarStartTime;
    const currentClanStars = Number.isFinite(Number(currentWar?.clan?.stars))
      ? Number(currentWar?.clan?.stars)
      : sub.clanStars;
    const currentOpponentStars = Number.isFinite(Number(currentWar?.opponent?.stars))
      ? Number(currentWar?.opponent?.stars)
      : sub.opponentStars;
    const testFinalResultOverride: WarEndResultSnapshot | null =
      params.source === "current" && params.eventType === "war_ended"
        ? {
            clanStars: currentClanStars,
            opponentStars: currentOpponentStars,
            clanDestruction: Number.isFinite(Number(currentWar?.clan?.destructionPercentage))
              ? Number(currentWar?.clan?.destructionPercentage)
              : null,
            opponentDestruction: Number.isFinite(Number(currentWar?.opponent?.destructionPercentage))
              ? Number(currentWar?.opponent?.destructionPercentage)
              : null,
            warEndTime: new Date(),
            resultLabel: deriveResultLabelFromStars(currentClanStars, currentOpponentStars),
          }
        : null;
    const testWarStartFwaPoints = this.resolveWarEndBeforePoints({
      warStartFwaPoints: sub.warStartFwaPoints,
      fwaPoints: sub.fwaPoints,
    });
    let testWarEndFwaPoints = sub.warEndFwaPoints;
    if (params.source === "current" && params.eventType === "war_ended" && testFinalResultOverride) {
      const before = this.resolveWarEndBeforePoints({
        warStartFwaPoints: sub.warStartFwaPoints,
        fwaPoints: sub.fwaPoints,
      });
      testWarEndFwaPoints = this.computeExpectedWarEndPoints({
        matchType,
        before,
        finalResult: testFinalResultOverride,
        outcome,
      });
    }

    return {
      eventType: params.eventType,
      clanTag,
      clanName,
      opponentTag,
      opponentName,
      syncNumber,
      notifyRole: sub.notifyRole,
      pingRole: sub.pingRole,
      fwaPoints,
      opponentFwaPoints,
      outcome,
      matchType,
      warStartFwaPoints: testWarStartFwaPoints,
      warEndFwaPoints: testWarEndFwaPoints,
      clanStars:
        params.source === "last"
          ? Number.isFinite(Number(lastWarLogEntry?.clan?.stars))
            ? Number(lastWarLogEntry?.clan?.stars)
            : sub.clanStars
          : Number.isFinite(Number(currentWar?.clan?.stars))
            ? Number(currentWar?.clan?.stars)
            : sub.clanStars,
      opponentStars:
        params.source === "last"
          ? Number.isFinite(Number(lastWarLogEntry?.opponent?.stars))
            ? Number(lastWarLogEntry?.opponent?.stars)
            : sub.opponentStars
          : Number.isFinite(Number(currentWar?.opponent?.stars))
            ? Number(currentWar?.opponent?.stars)
            : sub.opponentStars,
      prepStartTime: parseCocTime(currentWar?.preparationStartTime ?? null) ?? sub.prepStartTime,
      warStartTime: testWarStartTime,
      warEndTime:
        params.source === "last"
          ? lastWarHistoryRow?.warEndTime ?? null
          : parseCocTime(currentWar?.endTime ?? null),
      clanAttacks: Number.isFinite(Number(currentWar?.clan?.attacks))
        ? Number(currentWar?.clan?.attacks)
        : null,
      opponentAttacks: Number.isFinite(Number(currentWar?.opponent?.attacks))
        ? Number(currentWar?.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(currentWar?.teamSize)) ? Number(currentWar?.teamSize) : null,
      attacksPerMember: Number.isFinite(Number(currentWar?.attacksPerMember))
        ? Number(currentWar?.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(currentWar?.clan?.destructionPercentage))
        ? Number(currentWar?.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(Number(currentWar?.opponent?.destructionPercentage))
        ? Number(currentWar?.opponent?.destructionPercentage)
        : null,
      resolvedWarIdHint:
        params.source === "last" &&
        lastWarHistoryRow?.warId !== null &&
        lastWarHistoryRow?.warId !== undefined &&
        Number.isFinite(Number(lastWarHistoryRow?.warId))
          ? Math.trunc(Number(lastWarHistoryRow.warId))
          : lastWarRow?.warId !== null &&
              lastWarRow?.warId !== undefined &&
              Number.isFinite(Number(lastWarRow.warId))
            ? Math.trunc(Number(lastWarRow.warId))
            : null,
      testFinalResultOverride,
    };
  }

  private async buildWarEndedViewState(params: {
    payload: EventEmitPayload;
    guildId: string | null;
    warId: number;
    messageId: string;
    timestampUnix: number;
  }): Promise<NotifyWarEndedViewState> {
    const finalResult =
      params.payload.testFinalResultOverride ??
      (await this.history.getWarEndResultSnapshot({
        clanTag: params.payload.clanTag,
        opponentTag: params.payload.opponentTag,
        fallbackClanStars: params.payload.clanStars,
        fallbackOpponentStars: params.payload.opponentStars,
        warStartTime: params.payload.warStartTime,
      }));

    const normalizedWarId =
      Number.isFinite(Number(params.warId)) && Math.trunc(Number(params.warId)) > 0
        ? Math.trunc(Number(params.warId))
        : 0;
    const normalizedMatchType = params.payload.matchType;
    const summaryWarStatsValue = buildWarStatsLines({
      clanStars: finalResult.clanStars,
      opponentStars: finalResult.opponentStars,
      clanAttacks: params.payload.clanAttacks,
      opponentAttacks: params.payload.opponentAttacks,
      teamSize: params.payload.teamSize,
      attacksPerMember: params.payload.attacksPerMember,
      clanDestruction: finalResult.clanDestruction,
      opponentDestruction: finalResult.opponentDestruction,
    }).join("\n");
    const summaryPointsLine = this.history.buildWarEndPointsLine(params.payload, finalResult);

    let missedBothLines: string[] = [];
    let complianceState: NotifyWarEndedComplianceState | null = null;

    if (
      normalizedMatchType === "FWA" &&
      params.guildId &&
      normalizedWarId > 0
    ) {
      const evaluation = await this.warCompliance
        .evaluateComplianceForCommand({
          guildId: params.guildId,
          clanTag: params.payload.clanTag,
          scope: "war_id",
          warId: normalizedWarId,
        })
        .catch(() => null);
      const report = evaluation?.status === "ok" ? evaluation.report : null;
      if (report) {
        const sortedMissed = sortWarComplianceIssuesByPosition(report.missedBoth);
        missedBothLines = sortedMissed.map(formatWarEndedMissedBothLine);
        const warPlanTextRaw = await this.history
          .buildWarPlanText(
            params.guildId,
            report.matchType,
            report.expectedOutcome,
            report.clanTag,
            report.opponentName,
            "battle",
            report.clanName,
            { forcedLoseStyle: report.loseStyle }
          )
          .catch(() => null);
        complianceState = {
          clanName: report.clanName,
          warPlanText: buildComplianceWarPlanText(warPlanTextRaw),
          warId: report.warId,
          expectedOutcome: report.expectedOutcome,
          fwaWinGateConfig: report.fwaWinGateConfig,
          warStartTime: report.warStartTime,
          warEndTime: report.warEndTime,
          participantsCount: report.participantsCount,
          attacksCount: report.attacksCount,
          missedBoth: report.missedBoth,
          notFollowingPlan: report.notFollowingPlan,
        };
      }
    }

    if (missedBothLines.length <= 0) {
      const fallbackCompliance = await this.history
        .getWarComplianceSnapshot(
          params.payload.clanTag,
          params.payload.warStartTime,
          params.payload.matchType,
          params.payload.outcome
        )
        .catch(() => ({ missedBoth: [], notFollowingPlan: [] }));
      missedBothLines = fallbackCompliance.missedBoth
        .map((name) => String(name ?? "").trim())
        .filter((name) => name.length > 0);
    }

    if (normalizedMatchType === "FWA" && !complianceState) {
      const fallbackWarPlanTextRaw = await this.history
        .buildWarPlanText(
          params.guildId,
          "FWA",
          normalizeOutcome(params.payload.outcome),
          params.payload.clanTag,
          params.payload.opponentName,
          "battle",
          params.payload.clanName
        )
        .catch(() => null);
      complianceState = {
        clanName: params.payload.clanName,
        warPlanText: buildComplianceWarPlanText(fallbackWarPlanTextRaw),
        warId: normalizedWarId || null,
        expectedOutcome: normalizeOutcome(params.payload.outcome),
        fwaWinGateConfig: null,
        warStartTime: params.payload.warStartTime,
        warEndTime: finalResult.warEndTime ?? params.payload.warEndTime ?? null,
        participantsCount: 0,
        attacksCount: 0,
        missedBoth: [],
        notFollowingPlan: [],
      };
    }

    return {
      guildId: params.guildId ?? "",
      clanTag: normalizeTag(params.payload.clanTag),
      warId: normalizedWarId,
      messageId: params.messageId,
      matchType: normalizedMatchType,
      timestampUnix: Math.max(1, Math.trunc(Number(params.timestampUnix))),
      summary: {
        clanName: params.payload.clanName,
        opponentName: params.payload.opponentName,
        opponentTag: normalizeTag(params.payload.opponentTag),
        syncNumber: params.payload.syncNumber,
        resultLabel: formatResultLabelForEmbed(finalResult.resultLabel),
        warStatsValue: summaryWarStatsValue,
        pointsLine: summaryPointsLine,
        missedBothLines,
      },
      compliance: complianceState,
    };
  }

  private buildWarEndedSummaryEmbed(state: NotifyWarEndedViewState): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(`War Ended - ${state.summary.clanName}`)
      .setColor(resolveNotifyEventEmbedColor("war_ended"))
      .setTimestamp(new Date(state.timestampUnix * 1000))
      .addFields(
        {
          name: "Opponent",
          value: `${state.summary.opponentName} (${state.summary.opponentTag || "unknown"})`,
          inline: false,
        },
        {
          name: "Match Type",
          value: state.matchType ?? "unknown",
          inline: true,
        },
        {
          name: "Result",
          value: state.summary.resultLabel,
          inline: true,
        },
        {
          name: "\u200b",
          value: state.summary.warStatsValue,
          inline: false,
        },
        {
          name: "FWA Points",
          value: state.summary.pointsLine,
          inline: false,
        },
        {
          name: "Missed Both Attacks",
          value: formatWarEndedRosterValue(state.summary.missedBothLines),
          inline: false,
        },
        {
          name: "War Metadata",
          value: buildWarEndedMetadataValue({
            warId: state.warId > 0 ? state.warId : null,
            syncNumber: state.summary.syncNumber,
            timestampUnix: state.timestampUnix,
          }),
          inline: false,
        }
      );
  }

  private buildWarEndedComplianceEmbed(
    state: NotifyWarEndedViewState,
    page: number
  ): { embed: EmbedBuilder; currentPage: number; pageCount: number } {
    if (!state.compliance) {
      return {
        embed: new EmbedBuilder()
          .setTitle(`FWA War Compliance - ${state.summary.clanName}`)
          .setColor(resolveNotifyEventEmbedColor("war_ended"))
          .setTimestamp(new Date(state.timestampUnix * 1000))
          .addFields(
            {
              name: "Plan Violations",
              value: "None",
              inline: false,
            },
            {
              name: "War Metadata",
              value: buildWarEndedMetadataValue({
                warId: state.warId > 0 ? state.warId : null,
                syncNumber: state.summary.syncNumber,
                timestampUnix: state.timestampUnix,
              }),
              inline: false,
            }
          ),
        currentPage: 0,
        pageCount: 1,
      };
    }

    const rendered = buildFwaComplianceEmbedView({
      userId: "notify",
      key: state.messageId,
      isFwa: true,
      clanName: state.compliance.clanName,
      warPlanText: state.compliance.warPlanText,
      warId: state.compliance.warId,
      expectedOutcome: state.compliance.expectedOutcome,
      fwaWinGateConfig: state.compliance.fwaWinGateConfig,
      warStartTime: state.compliance.warStartTime,
      warEndTime: state.compliance.warEndTime,
      participantsCount: state.compliance.participantsCount,
      attacksCount: state.compliance.attacksCount,
      missedBoth: state.compliance.missedBoth,
      notFollowingPlan: state.compliance.notFollowingPlan,
      activeView: "fwa_main",
      mainPage: page,
      missedPage: 0,
    });
    const normalized = withNotifyComplianceEmptyState(
      rendered.embed,
      state.compliance.notFollowingPlan.length > 0
    );
    const json = normalized.toJSON();
    const fields = [...(json.fields ?? [])];
    fields.push({
      name: "War Metadata",
      value: buildWarEndedMetadataValue({
        warId: state.warId > 0 ? state.warId : null,
        syncNumber: state.summary.syncNumber,
        timestampUnix: state.timestampUnix,
      }),
      inline: false,
    });
    const embed = EmbedBuilder.from({
      ...json,
      fields,
    }).setTimestamp(new Date(state.timestampUnix * 1000));
    return {
      embed,
      currentPage: rendered.mainPage,
      pageCount: Math.max(1, rendered.mainPageCount),
    };
  }

  private buildWarEndedViewComponents(input: {
    state: NotifyWarEndedViewState;
    view: NotifyWarEndedViewToken;
    includeComponents: boolean;
    currentPage: number;
    pageCount: number;
  }): ActionRowBuilder<ButtonBuilder>[] {
    if (!input.includeComponents) return [];
    const state = input.state;
    const canOpenCompliance =
      state.matchType === "FWA" &&
      state.warId > 0 &&
      /^\d{5,}$/.test(state.guildId);
    const baseContext = {
      guildId: state.guildId,
      clanTag: state.clanTag,
      warId: state.warId,
      messageId: state.messageId,
      timestampUnix: state.timestampUnix,
    };

    if (input.view === "s") {
      return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              buildNotifyWarEndedViewCustomId({
                ...baseContext,
                view: "c",
                page: 0,
              })
            )
            .setLabel(canOpenCompliance ? "FWA Compliance" : "FWA Compliance (N/A)")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canOpenCompliance)
        ),
      ];
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            buildNotifyWarEndedViewCustomId({
              ...baseContext,
              view: "s",
              page: 0,
            })
          )
          .setLabel("Back to War Ended")
          .setStyle(ButtonStyle.Secondary)
      ),
    ];

    if (input.pageCount > 1) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              buildNotifyWarEndedViewCustomId({
                ...baseContext,
                view: "c",
                page: Math.max(0, input.currentPage - 1),
              })
            )
            .setLabel("Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(input.currentPage <= 0),
          new ButtonBuilder()
            .setCustomId(
              buildNotifyWarEndedViewCustomId({
                ...baseContext,
                view: "c",
                page: Math.min(input.pageCount - 1, input.currentPage + 1),
              })
            )
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(input.currentPage >= input.pageCount - 1)
        )
      );
    }

    return rows;
  }

  private buildWarEndedViewMessage(
    state: NotifyWarEndedViewState,
    view: NotifyWarEndedViewToken,
    page: number,
    includeComponents: boolean
  ): {
    embed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder>[];
    currentPage: number;
    pageCount: number;
  } {
    if (view === "c" && state.matchType === "FWA") {
      const compliance = this.buildWarEndedComplianceEmbed(state, page);
      return {
        embed: compliance.embed,
        components: this.buildWarEndedViewComponents({
          state,
          view,
          includeComponents,
          currentPage: compliance.currentPage,
          pageCount: compliance.pageCount,
        }),
        currentPage: compliance.currentPage,
        pageCount: compliance.pageCount,
      };
    }
    return {
      embed: this.buildWarEndedSummaryEmbed(state),
      components: this.buildWarEndedViewComponents({
        state,
        view: "s",
        includeComponents,
        currentPage: 0,
        pageCount: 1,
      }),
      currentPage: 0,
      pageCount: 1,
    };
  }

  private rememberWarEndedViewState(state: NotifyWarEndedViewState): void {
    if (!state.guildId || !state.messageId) return;
    const key = toWarEndedViewStateKey(state.guildId, state.messageId);
    warEndedViewStateByMessage.set(key, state);
    if (warEndedViewStateByMessage.size <= 500) return;
    const oldest = warEndedViewStateByMessage.keys().next().value;
    if (oldest) {
      warEndedViewStateByMessage.delete(oldest);
    }
  }

  private async replyWithExpiredWarEndedView(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: NOTIFY_WAR_ENDED_VIEW_EXPIRED,
      });
      return;
    }
    if (interaction.deferred) {
      const edited = await interaction
        .editReply({
          content: NOTIFY_WAR_ENDED_VIEW_EXPIRED,
          components: [],
          embeds: [],
        })
        .then(() => true)
        .catch(() => false);
      if (edited) return;
    }
    await interaction
      .followUp({
        ephemeral: true,
        content: NOTIFY_WAR_ENDED_VIEW_EXPIRED,
      })
      .catch(async () => {
        await interaction.followUp({
          content: NOTIFY_WAR_ENDED_VIEW_EXPIRED,
        });
      });
  }

  private async buildEventMessage(
    payload: EventEmitPayload,
    guildId: string | null,
    options?: {
      includeRoleMention?: boolean;
      includeEventComponents?: boolean;
      warId?: number | null;
    }
  ): Promise<{
    content?: string;
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
    allowedMentions?: { roles: string[] };
  }> {
    const includeRoleMention = options?.includeRoleMention ?? true;
    const includeEventComponents = options?.includeEventComponents ?? true;
    const warId = options?.warId ?? null;
    const roleId = normalizeNotifyRoleId(payload.notifyRole);
    const includeRoleMentionForPost = includeRoleMention && payload.pingRole;
    const content = buildNotifyEventPostedContent({
      eventType: payload.eventType,
      opponentName: payload.opponentName,
      notifyRoleId: roleId,
      includeRoleMention: includeRoleMentionForPost,
      nowMs: Date.now(),
      nextScheduledRefreshAtMs: getNextNotifyRefreshAtMs(),
    });

    if (payload.eventType === "war_ended") {
      const timestampUnix = resolveWarEndedMetadataTimestampUnix(payload.warEndTime, new Date());
      const safeWarId =
        warId !== null && Number.isFinite(Number(warId)) ? Math.trunc(Number(warId)) : 0;
      const state = await this.buildWarEndedViewState({
        payload,
        guildId,
        warId: safeWarId,
        messageId: "00000",
        timestampUnix,
      });
      const rendered = this.buildWarEndedViewMessage(state, "s", 0, includeEventComponents);
      return {
        content,
        embeds: [rendered.embed],
        components: rendered.components,
        allowedMentions:
          includeRoleMentionForPost && roleId ? { roles: [roleId] } : undefined,
      };
    }

    const opponentTag = normalizeTag(payload.opponentTag);
    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(resolveNotifyEventEmbedColor(payload.eventType))
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
      .setTimestamp(new Date());

    embed.addFields(
      {
        name: "Opponent",
        value: `${payload.opponentName} (${opponentTag || "unknown"})`,
        inline: false,
      },
      {
        name: "Sync #",
        value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
        inline: true,
      }
    );

    if (payload.eventType === "battle_day") {
      embed.addFields(
        {
          name: "Battle Day Ends",
          value: toDiscordRelativeTime(payload.warEndTime),
          inline: true,
        },
        {
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        }
      );
      const battlePlanTextRaw = await this.history.buildWarPlanText(
        guildId,
        payload.matchType,
        payload.outcome,
        payload.clanTag,
        payload.opponentName,
        "battle",
        payload.clanName
      );
      const battlePlanText = sanitizeWarPlanForEmbed(battlePlanTextRaw);
      if (battlePlanText) {
        embed.addFields({
          name: "War Plan",
          value: battlePlanText,
          inline: false,
        });
      } else if (!battlePlanTextRaw && payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value:
            "**Battle day has started! Thank you for helping with war bases; please switch back to FWA bases asap.**",
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: "Attack whatever you want! Free for all!",
          inline: false,
        });
      }
      embed.addFields({
        name: "\u200b",
        value: buildWarStatsLines({
          clanStars: payload.clanStars,
          opponentStars: payload.opponentStars,
          clanAttacks: payload.clanAttacks,
          opponentAttacks: payload.opponentAttacks,
          teamSize: payload.teamSize,
          attacksPerMember: payload.attacksPerMember,
          clanDestruction: payload.clanDestruction,
          opponentDestruction: payload.opponentDestruction,
        }).join("\n"),
        inline: false,
      });
    }

    if (payload.eventType === "war_started") {
      embed.addFields(
        {
          name: "Prep Day Remaining",
          value: toDiscordRelativeTime(payload.warStartTime),
          inline: true,
        },
        {
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        }
      );
      const prepPlanTextRaw = await this.history.buildWarPlanText(
        guildId,
        payload.matchType,
        payload.outcome,
        payload.clanTag,
        payload.opponentName,
        "prep",
        payload.clanName
      );
      const prepPlanText = sanitizeWarPlanForEmbed(prepPlanTextRaw);
      if (prepPlanText) {
        embed.addFields({
          name: "War Plan",
          value: prepPlanText,
          inline: false,
        });
      } else if (!prepPlanTextRaw && payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value: [
            `BLACKLIST WAR vs ${payload.opponentName}`,
            "Everyone switch to WAR BASES!",
            "This is an opportunity to gain extra FWA points.",
          ].join("\n"),
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: [
            `MISMATCHED WAR vs ${payload.opponentName}`,
            "Keep war base active and attack what you can.",
          ].join("\n"),
          inline: false,
        });
      }
    }

    const components =
      includeEventComponents && payload.eventType === "battle_day" && guildId
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
                .setLabel("Refresh")
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];

    return {
      content,
      embeds: [embed],
      components,
      allowedMentions:
        includeRoleMentionForPost && roleId ? { roles: [roleId] } : undefined,
    };
  }

  private async findSubscriptionByGuildAndTag(
    guildId: string,
    clanTag: string
  ): Promise<SubscriptionRow | null> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          cw."guildId",cw."clanTag",cw."warId",cw."syncNum",
          COALESCE(cnc."channelId", tc."notifyChannelId") AS "channelId",
          COALESCE(cnc."embedEnabled", tc."notifyEnabled", false) AS "notify",
          COALESCE(cnc."pingEnabled", cw."pingRole", true) AS "pingRole",
          COALESCE(cnc."embedEnabled", true) AS "embedEnabled",
          cw."inferredMatchType",
          COALESCE(cnc."roleId", tc."notifyRole") AS "notifyRole",
          cw."fwaPoints",cw."opponentFwaPoints",cw."outcome",cw."matchType",cw."warStartFwaPoints",cw."warEndFwaPoints",
          cw."clanStars",cw."opponentStars",cw."state",cw."prepStartTime",cw."startTime",cw."endTime",
          cw."opponentTag",cw."opponentName",cw."clanName",
          cps."confirmedByClanMail" AS "pointsConfirmedByClanMail",
          cps."needsValidation" AS "pointsNeedsValidation",
          cps."lastSuccessfulPointsApiFetchAt" AS "pointsLastSuccessfulFetchAt",
          cps."lastKnownSyncNumber" AS "pointsLastKnownSyncNumber",
          cps."lastKnownPoints" AS "pointsLastKnownPoints",
          cps."lastKnownMatchType" AS "pointsLastKnownMatchType",
          cps."lastKnownOutcome" AS "pointsLastKnownOutcome",
          cps."warId" AS "pointsWarId",
          cps."opponentTag" AS "pointsOpponentTag",
          cps."warStartTime" AS "pointsWarStartTime"
        FROM "CurrentWar" cw
        LEFT JOIN "TrackedClan" tc
          ON UPPER(REPLACE(tc."tag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanNotifyConfig" cnc
          ON cnc."guildId" = cw."guildId" AND UPPER(REPLACE(cnc."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanPointsSync" cps
          ON cps."guildId" = cw."guildId"
          AND UPPER(REPLACE(cps."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
          AND cps."warStartTime" = cw."startTime"
        WHERE cw."guildId" = ${guildId} AND UPPER(REPLACE(cw."clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `
    );
    return rows[0] ?? null;
  }

  /** Purpose: has war end recorded. */
  private async hasWarEndRecorded(clanTagInput: string, warStartTime: Date): Promise<boolean> {
    const clanTag = normalizeTag(clanTagInput);
    const existing = await prisma.clanWarHistory.findFirst({
      where: { clanTag, warStartTime },
      orderBy: { warId: "desc" },
      select: { warId: true },
    });
    return Boolean(existing?.warId);
  }

  /** Purpose: resolve canonical war-end "before points" source with explicit precedence. */
  private resolveWarEndBeforePoints(sub: {
    warStartFwaPoints: number | null;
    fwaPoints: number | null;
  }): number | null {
    if (sub.warStartFwaPoints !== null && Number.isFinite(sub.warStartFwaPoints)) {
      return Math.trunc(sub.warStartFwaPoints);
    }
    if (sub.fwaPoints !== null && Number.isFinite(sub.fwaPoints)) {
      return Math.trunc(sub.fwaPoints);
    }
    return null;
  }

  /** Purpose: compute expected post-war points for persisted war-end canonical output. */
  private computeExpectedWarEndPoints(input: {
    matchType: MatchType;
    before: number | null;
    finalResult: WarEndResultSnapshot;
    outcome: "WIN" | "LOSE" | null;
  }): number | null {
    return computeExpectedWarEndPointsForTest({
      matchType: input.matchType,
      before: input.before,
      finalResult: input.finalResult,
      outcome: input.outcome,
    });
  }

  /** Purpose: fetch current war while preserving upstream-failure classification. */
  private async getCurrentWarSnapshot(clanTag: string): Promise<{
    war: Awaited<ReturnType<CoCService["getCurrentWar"]>> | null;
    observation: CocWarFetchObservation;
  }> {
    try {
      const war = await this.coc.getCurrentWar(clanTag);
      return { war, observation: { kind: "success" } };
    } catch (error) {
      return {
        war: null,
        observation: {
          kind: "failure",
          statusCode: parseCocApiStatusCode(error),
        },
      };
    }
  }

  /** Purpose: update per-clan outage suspicion state from latest CoC fetch observation. */
  private recordCocWarObservation(
    clanTagInput: string,
    observation: CocWarFetchObservation
  ): CocWarOutageState {
    const key = normalizeTag(clanTagInput);
    const previous = this.cocWarOutageByClanTag.get(key) ?? null;
    const next = advanceCocWarOutageState(previous, observation, new Date());
    this.cocWarOutageByClanTag.set(key, next);
    return next;
  }

  private async allocateNextWarId(): Promise<number | null> {
    const rows = await prisma.$queryRaw<Array<{ warId: bigint | number }>>(
      Prisma.sql`
        SELECT
          GREATEST(
            COALESCE(
              (
                SELECT MAX(
                  CASE
                    WHEN "warId" ~ '^[0-9]+$' THEN "warId"::bigint
                    ELSE NULL
                  END
                )
                FROM "WarLookup"
              ),
              0
            ),
            COALESCE((SELECT MAX("warId")::bigint FROM "CurrentWar"), 0),
            COALESCE((SELECT MAX("warId")::bigint FROM "WarAttacks"), 0)
          ) + 1 AS "warId"
      `
    );
    const raw = rows[0]?.warId;
    if (raw === null || raw === undefined) return null;
    const warId = typeof raw === "bigint" ? Number(raw) : Number(raw);
    return Number.isFinite(warId) ? Math.trunc(warId) : null;
  }

  private async ensureCurrentWarId(params: {
    sub: SubscriptionRow;
    warStartTime: Date | null;
    currentState: WarState;
  }): Promise<number | null> {
    if (params.currentState === "notInWar") return params.sub.warId ?? null;
    if (!params.warStartTime) return params.sub.warId ?? null;

    if (
      params.sub.warId !== null &&
      params.sub.warId !== undefined &&
      params.sub.startTime &&
      params.sub.startTime.getTime() === params.warStartTime.getTime()
    ) {
      return params.sub.warId;
    }

    const existing = await prisma.currentWar.findFirst({
      where: {
        clanTag: params.sub.clanTag,
        startTime: params.warStartTime,
        warId: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: { warId: true },
    });
    if (existing?.warId !== null && existing?.warId !== undefined) {
      return Number(existing.warId);
    }

    return this.allocateNextWarId();
  }

  private async processSubscription(
    guildId: string,
    clanTag: string,
    syncContext: PollSyncContext
  ): Promise<boolean> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          cw."guildId",cw."clanTag",cw."warId",cw."syncNum",
          COALESCE(cnc."channelId", tc."notifyChannelId") AS "channelId",
          COALESCE(cnc."embedEnabled", tc."notifyEnabled", false) AS "notify",
          COALESCE(cnc."pingEnabled", cw."pingRole", true) AS "pingRole",
          COALESCE(cnc."embedEnabled", true) AS "embedEnabled",
          cw."inferredMatchType",
          COALESCE(cnc."roleId", tc."notifyRole") AS "notifyRole",
          cw."fwaPoints",cw."opponentFwaPoints",cw."outcome",cw."matchType",cw."warStartFwaPoints",cw."warEndFwaPoints",
          cw."clanStars",cw."opponentStars",cw."state",cw."prepStartTime",cw."startTime",cw."endTime",
          cw."opponentTag",cw."opponentName",cw."clanName",
          cps."confirmedByClanMail" AS "pointsConfirmedByClanMail",
          cps."needsValidation" AS "pointsNeedsValidation",
          cps."lastSuccessfulPointsApiFetchAt" AS "pointsLastSuccessfulFetchAt",
          cps."lastKnownSyncNumber" AS "pointsLastKnownSyncNumber",
          cps."lastKnownPoints" AS "pointsLastKnownPoints",
          cps."lastKnownMatchType" AS "pointsLastKnownMatchType",
          cps."lastKnownOutcome" AS "pointsLastKnownOutcome",
          cps."warId" AS "pointsWarId",
          cps."opponentTag" AS "pointsOpponentTag",
          cps."warStartTime" AS "pointsWarStartTime"
        FROM "CurrentWar" cw
        LEFT JOIN "TrackedClan" tc
          ON UPPER(REPLACE(tc."tag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanNotifyConfig" cnc
          ON cnc."guildId" = cw."guildId" AND UPPER(REPLACE(cnc."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanPointsSync" cps
          ON cps."guildId" = cw."guildId"
          AND UPPER(REPLACE(cps."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
          AND cps."warStartTime" = cw."startTime"
        WHERE cw."guildId" = ${guildId}
          AND UPPER(REPLACE(cw."clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `
    );
    const sub = rows[0] ?? null;
    if (!sub) return false;

    const warSnapshot = await this.getCurrentWarSnapshot(sub.clanTag);
    const war = warSnapshot.war;
    const outageState = this.recordCocWarObservation(sub.clanTag, warSnapshot.observation);
    const resolvedState: WarState = war ? deriveState(String(war.state ?? "")) : "notInWar";
    const resolvedOpponentTag = normalizeTag(war?.opponent?.tag ?? "");
    const candidateState: WarState =
      resolvedState === "inWar" && !resolvedOpponentTag ? "notInWar" : resolvedState;
    const prevState: WarState = deriveState(sub.state ?? "notInWar");
    const nextClanName =
      String(war?.clan?.name ?? sub.clanName ?? sub.clanTag).trim() || sub.clanTag;
    const nextOpponentTag = normalizeTag(war?.opponent?.tag ?? sub.opponentTag ?? "");
    const nextOpponentName = String(war?.opponent?.name ?? sub.opponentName ?? "").trim() || null;
    const timing = resolveActiveWarTiming({
      observedWarStartTime: parseCocTime(war?.startTime ?? null),
      observedWarEndTime: parseCocTime(war?.endTime ?? null),
      previousWarStartTime: sub.startTime ?? null,
      previousWarEndTime: sub.endTime ?? null,
    });
    const nextWarStartTime = timing.warStartTime;
    const nextWarEndTime = timing.warEndTime;
    const nextPrepStartTime = parseCocTime(war?.preparationStartTime ?? null) ?? sub.prepStartTime;
    const warIdentityChanged = isNewWarCycle(sub.startTime, nextWarStartTime);

    const eventTypeRaw = shouldEmit(prevState, candidateState);
    let eventType = eventTypeRaw;
    if (!eventType && isNewWarCycle(sub.startTime, nextWarStartTime)) {
      if (candidateState === "preparation") {
        eventType = "war_started";
      } else if (candidateState === "inWar") {
        eventType = "battle_day";
      }
    }
    const warEndedGuard = applyWarEndedMaintenanceGuard({
      eventType,
      previousState: prevState,
      candidateState,
      warFetchFailed: warSnapshot.observation.kind === "failure",
      maintenanceSuspected: outageState.suspected,
      knownWarEndTime: nextWarEndTime,
      now: new Date(),
    });
    let currentState: WarState = warEndedGuard.state;
    eventType = warEndedGuard.eventType;
    if (warEndedGuard.suppressReason) {
      console.log(
        `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=${warEndedGuard.suppressReason} prev=${prevState} current=${candidateState} knownEnd=${nextWarEndTime?.toISOString() ?? "unknown"} maintenanceSuspected=${outageState.suspected} failureStreak=${outageState.failureStreak}${outageState.lastFailureStatusCode ? ` status=${outageState.lastFailureStatusCode}` : ""}`
      );
    }
    if (eventType === "war_ended") {
      if (!sub.startTime) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=no_last_war_start prev=${prevState} current=${currentState}`
        );
        eventType = null;
      } else if (await this.hasWarEndRecorded(sub.clanTag, sub.startTime)) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=already_recorded warStart=${sub.startTime.toISOString()}`
        );
        eventType = null;
      }
    }
    if ((eventType === "war_started" || eventType === "war_ended") && nextWarStartTime) {
      await this.currentSyncs
        .markNeedsValidation({
          guildId: sub.guildId,
          clanTag: sub.clanTag,
          warStartTime: nextWarStartTime,
        })
        .catch(() => null);
    }
    const lifecycleState =
      sub.pointsConfirmedByClanMail === null &&
      sub.pointsNeedsValidation === null &&
      !sub.pointsLastSuccessfulFetchAt &&
      sub.pointsLastKnownSyncNumber === null
        ? null
        : {
            confirmedByClanMail: Boolean(sub.pointsConfirmedByClanMail),
            needsValidation:
              eventType === "war_started" || eventType === "war_ended"
                ? true
                : Boolean(sub.pointsNeedsValidation),
            lastSuccessfulPointsApiFetchAt: sub.pointsLastSuccessfulFetchAt ?? null,
            lastKnownSyncNumber:
              sub.pointsLastKnownSyncNumber !== null &&
              sub.pointsLastKnownSyncNumber !== undefined &&
              Number.isFinite(sub.pointsLastKnownSyncNumber)
                ? Math.trunc(sub.pointsLastKnownSyncNumber)
                : null,
            warId: sub.pointsWarId ?? null,
            opponentTag: sub.pointsOpponentTag ?? null,
            warStartTime: sub.pointsWarStartTime ?? null,
          };
    const gateDecision = await this.pointsGate.evaluatePollerFetch({
      guildId: sub.guildId,
      clanTag: sub.clanTag,
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: currentState,
      warStartTime: nextWarStartTime,
      warEndTime: nextWarEndTime,
      currentSyncNumber: syncContext.activeSync,
      lifecycle: lifecycleState,
      activeWarId:
        sub.warId !== null && sub.warId !== undefined && Number.isFinite(sub.warId)
          ? String(Math.trunc(sub.warId))
          : null,
      activeOpponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
    });
    if (eventType === "war_started" && nextOpponentTag) {
      await this.pointsSync.resetWarStartPointsJob(sub.clanTag, nextOpponentTag).catch(() => null);
    }
    if (gateDecision.allowed && currentState !== "notInWar" && nextOpponentTag) {
      await this.pointsSync.maybeRunWarStartPointsCheck(
        sub,
        nextOpponentTag,
        nextClanName,
        nextOpponentName
      ).catch(() => null);
    }
    const fallbackSyncNumberForEvent =
      eventType === "war_ended"
        ? syncContext.activeSync
        : currentState === "notInWar"
          ? syncContext.previousSync
          : syncContext.activeSync;

    const currentMatchTypeForResolution = warIdentityChanged ? null : sub.matchType;
    const currentInferredMatchTypeForResolution = warIdentityChanged
      ? true
      : sub.inferredMatchType;
    const currentWarResolution = resolveCurrentWarMatchTypeSignal({
      matchType: currentMatchTypeForResolution,
      inferredMatchType: currentInferredMatchTypeForResolution,
    });
    let liveOpponentResolution: MatchTypeResolution | null = null;

    let nextFwaPoints = sub.fwaPoints;
    let nextOpponentFwaPoints = sub.opponentFwaPoints;
    let nextOutcome = sub.outcome;
    let outcomeComputationInput: {
      clanTag: string;
      opponentTag: string;
      clanPoints: number | null;
      opponentPoints: number | null;
    } | null = null;
    let nextWarStartFwaPoints = sub.warStartFwaPoints;
    let nextWarEndFwaPoints = sub.warEndFwaPoints;
    let nextClanStars =
      Number.isFinite(Number((war as { clan?: { stars?: number } } | null)?.clan?.stars))
        ? Number((war as { clan?: { stars?: number } }).clan?.stars)
        : sub.clanStars;
    let nextOpponentStars =
      Number.isFinite(Number((war as { opponent?: { stars?: number } } | null)?.opponent?.stars))
        ? Number((war as { opponent?: { stars?: number } }).opponent?.stars)
        : sub.opponentStars;
    const nextClanAttacks = Number.isFinite(Number(war?.clan?.attacks))
      ? Number(war?.clan?.attacks)
      : null;
    const nextOpponentAttacks = Number.isFinite(Number(war?.opponent?.attacks))
      ? Number(war?.opponent?.attacks)
      : null;
    const nextTeamSize = Number.isFinite(Number(war?.teamSize)) ? Number(war?.teamSize) : null;
    const nextAttacksPerMember = Number.isFinite(Number(war?.attacksPerMember))
      ? Number(war?.attacksPerMember)
      : null;
    const nextClanDestruction = Number.isFinite(Number(war?.clan?.destructionPercentage))
      ? Number(war?.clan?.destructionPercentage)
      : null;
    const nextOpponentDestruction = Number.isFinite(Number(war?.opponent?.destructionPercentage))
      ? Number(war?.opponent?.destructionPercentage)
      : null;
    if (gateDecision.allowed && (nextOpponentTag || normalizeTag(sub.opponentTag ?? ""))) {
      const projectionClanTag = sub.clanTag;
      const projectionOpponentTag = nextOpponentTag || normalizeTag(sub.opponentTag ?? "");
      const projectionReason = gateDecision.fetchReason ?? "war_event_projection";
      const [a, b] = await Promise.all([
        this.points.fetchSnapshot(projectionClanTag, {
          reason: projectionReason,
          caller: "poller",
        }),
        this.points.fetchSnapshot(projectionOpponentTag, {
          reason: projectionReason,
          caller: "poller",
          fallbackTrackedClanTag: projectionClanTag,
        }),
      ]);
      const siteCurrent = a.winnerBoxTags.map((t) => normalizeTag(t)).includes(projectionOpponentTag);
      const winnerBoxNotMarkedFwa = /not marked as an fwa match/i.test(
        String(a.winnerBoxText ?? "")
      );
      const strongOpponentEvidencePresent =
        b.notFound === true || b.activeFwa === true || b.activeFwa === false;
      liveOpponentResolution = inferMatchTypeFromOpponentPoints({
        available: true,
        balance: b.balance,
        activeFwa: b.activeFwa,
        notFound: b.notFound,
        winnerBoxNotMarkedFwa,
        opponentEvidenceMissingOrNotCurrent: !siteCurrent || !strongOpponentEvidencePresent,
        currentWarState: currentState,
        currentWarClanAttacksUsed: nextClanAttacks,
        currentWarClanStars: nextClanStars,
        currentWarOpponentStars: nextOpponentStars,
      });
      nextFwaPoints = a.balance;
      nextOpponentFwaPoints = b.balance;
      outcomeComputationInput = {
        clanTag: projectionClanTag,
        opponentTag: projectionOpponentTag,
        clanPoints: a.balance,
        opponentPoints: b.balance,
      };
      const observedSync =
        a.effectiveSync !== null && Number.isFinite(a.effectiveSync)
          ? Math.trunc(a.effectiveSync)
          : fallbackSyncNumberForEvent;
      if (
        siteCurrent &&
        sub.guildId &&
        nextWarStartTime &&
        observedSync !== null &&
        Number.isFinite(observedSync) &&
        a.balance !== null &&
        Number.isFinite(a.balance) &&
        b.balance !== null &&
        Number.isFinite(b.balance)
      ) {
        const syncResolution = chooseMatchTypeResolution({
          confirmedCurrent: currentWarResolution.confirmed,
          liveOpponent: liveOpponentResolution,
          storedSync: null,
          unconfirmedCurrent: currentWarResolution.unconfirmed,
        });
        const syncMatchType = syncResolution?.matchType ?? sub.matchType ?? null;
        const syncIsFwa = syncResolution?.syncIsFwa ?? toSyncIsFwa(syncMatchType) ?? false;
        await this.currentSyncs
          .upsertPointsSync({
            guildId: sub.guildId,
            clanTag: projectionClanTag,
            warId:
              sub.warId !== null && sub.warId !== undefined && Number.isFinite(sub.warId)
                ? String(Math.trunc(sub.warId))
                : null,
            warStartTime: nextWarStartTime,
            syncNum: observedSync,
            opponentTag: projectionOpponentTag,
            clanPoints: a.balance,
            opponentPoints: b.balance,
            outcome: deriveExpectedOutcome(
              projectionClanTag,
              projectionOpponentTag,
              a.balance,
              b.balance,
              observedSync
            ),
            isFwa: syncIsFwa,
            fetchedAt: new Date(a.fetchedAtMs),
            fetchReason: projectionReason,
            matchType: syncMatchType,
            needsValidation: false,
          })
          .catch(() => null);
      }
      if (eventType === "war_started") {
        nextWarStartFwaPoints = a.balance;
      }
    }
    const resolvedMatchType = chooseMatchTypeResolution({
      confirmedCurrent: currentWarResolution.confirmed,
      liveOpponent: liveOpponentResolution,
      storedSync: null,
      unconfirmedCurrent: currentWarResolution.unconfirmed,
    });
    let nextMatchType = resolvedMatchType?.matchType ?? currentMatchTypeForResolution;
    let nextInferredMatchType =
      resolvedMatchType?.inferred ?? currentInferredMatchTypeForResolution;

    const resolvedWarId = await this.ensureCurrentWarId({
      sub,
      warStartTime: nextWarStartTime,
      currentState,
    });
    const syncRow =
      guildId && nextWarStartTime
        ? await this.currentSyncs.getCurrentSyncForClan({
            guildId,
            clanTag: sub.clanTag,
            warId:
              resolvedWarId !== null && resolvedWarId !== undefined
                ? String(Math.trunc(Number(resolvedWarId)))
                : sub.warId !== null && sub.warId !== undefined
                  ? String(Math.trunc(Number(sub.warId)))
                  : null,
            warStartTime: nextWarStartTime,
          })
        : null;
    const syncNumberForEvent =
      syncRow?.syncNum ??
      fallbackSyncNumberForEvent;
    if (outcomeComputationInput) {
      nextOutcome = deriveExpectedOutcome(
        outcomeComputationInput.clanTag,
        outcomeComputationInput.opponentTag,
        outcomeComputationInput.clanPoints,
        outcomeComputationInput.opponentPoints,
        syncNumberForEvent
      );
    }
    if (eventType === "war_ended") {
      const finalResult = await this.history.getWarEndResultSnapshot({
        clanTag: sub.clanTag,
        opponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
        fallbackClanStars: nextClanStars,
        fallbackOpponentStars: nextOpponentStars,
        warStartTime: nextWarStartTime,
      });
      const before = this.resolveWarEndBeforePoints({
        warStartFwaPoints: sub.warStartFwaPoints,
        fwaPoints: sub.fwaPoints,
      });
      if (
        (nextWarStartFwaPoints === null || nextWarStartFwaPoints === undefined) &&
        before !== null
      ) {
        nextWarStartFwaPoints = before;
      }
      nextWarEndFwaPoints = this.computeExpectedWarEndPoints({
        matchType: nextMatchType,
        before,
        finalResult,
        outcome: normalizeOutcome(nextOutcome),
      });
    }

    const detectedEventPayload = eventType
      ? ({
          eventType,
          clanTag: sub.clanTag,
          clanName: nextClanName,
          opponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
          opponentName: nextOpponentName || sub.opponentName || "Unknown",
          syncNumber: syncNumberForEvent,
          notifyRole: sub.notifyRole,
          pingRole: sub.pingRole,
          fwaPoints: nextFwaPoints,
          opponentFwaPoints: nextOpponentFwaPoints,
          outcome: normalizeOutcome(nextOutcome),
          matchType: nextMatchType,
          warStartFwaPoints: nextWarStartFwaPoints,
          warEndFwaPoints: nextWarEndFwaPoints,
          clanStars: nextClanStars,
          opponentStars: nextOpponentStars,
          prepStartTime: nextPrepStartTime,
          warStartTime: nextWarStartTime,
          warEndTime: nextWarEndTime,
          clanAttacks: nextClanAttacks,
          opponentAttacks: nextOpponentAttacks,
          teamSize: nextTeamSize,
          attacksPerMember: nextAttacksPerMember,
          clanDestruction: nextClanDestruction,
          opponentDestruction: nextOpponentDestruction,
        } as const)
      : null;

    if (detectedEventPayload) {
      console.log(
        `[war-events] transition detected guild=${sub.guildId} clan=${sub.clanTag} event=${detectedEventPayload.eventType} prev=${prevState} current=${currentState} sync=${syncNumberForEvent ?? "unknown"} warStart=${nextWarStartTime?.toISOString() ?? "unknown"} warEnd=${nextWarEndTime?.toISOString() ?? "unknown"} opponent=${nextOpponentTag || normalizeTag(sub.opponentTag ?? "") || "unknown"}`
      );
    }

    await prisma.currentWar.update({
      where: {
        clanTag_guildId: {
          guildId: sub.guildId,
          clanTag: sub.clanTag,
        },
      },
      data: {
        warId: currentState === "notInWar" ? (sub.warId ?? null) : resolvedWarId,
        state: currentState,
        fwaPoints: nextFwaPoints,
        opponentFwaPoints: nextOpponentFwaPoints,
        outcome: nextOutcome,
        matchType: nextMatchType,
        inferredMatchType: nextInferredMatchType,
        warStartFwaPoints: nextWarStartFwaPoints,
        warEndFwaPoints: nextWarEndFwaPoints,
        clanStars: nextClanStars,
        opponentStars: nextOpponentStars,
        prepStartTime: currentState === "notInWar" ? null : nextPrepStartTime,
        startTime: currentState === "notInWar" ? null : nextWarStartTime,
        endTime: currentState === "notInWar" ? null : nextWarEndTime,
        opponentTag: nextOpponentTag || sub.opponentTag,
        opponentName: nextOpponentName || sub.opponentName,
        clanName: nextClanName,
        updatedAt: new Date(),
      },
    });
    await this.syncWarAttacksFromWarSnapshot({
      war,
      clanTag: sub.clanTag,
      resolvedWarId,
      fallbackWarStartTime: nextWarStartTime,
    });
    if (detectedEventPayload) {
      await this.dispatchDetectedEvent({
        sub,
        payload: detectedEventPayload,
        resolvedWarId,
      });
    }
    if (currentState === "notInWar" && eventType !== "war_ended") {
      await this.reconcileWarEndedPointsDiscrepancy({
        guildId: sub.guildId,
        clanTag: sub.clanTag,
        fallbackOpponentName: nextOpponentName || sub.opponentName || null,
        allowProviderFetch: gateDecision.allowed,
        fetchReason: gateDecision.fetchReason ?? "post_war_reconciliation",
      }).catch((err) => {
        console.error(
          `[war-events] reconcile war-end points failed guild=${sub.guildId} clan=${sub.clanTag} error=${formatError(
            err
          )}`
        );
      });
    }
    return eventType === "war_ended";
  }

  private async syncWarAttacksFromWarSnapshot(params: {
    war: Awaited<ReturnType<CoCService["getCurrentWar"]>> | null;
    clanTag: string;
    resolvedWarId: number | null;
    fallbackWarStartTime: Date | null;
  }): Promise<void> {
    if (
      params.resolvedWarId === null ||
      params.resolvedWarId === undefined ||
      !Number.isFinite(Number(params.resolvedWarId))
    ) {
      return;
    }
    const war = params.war;
    const ownClanTag = normalizeTag(war?.clan?.tag ?? params.clanTag);
    if (!ownClanTag) return;
    if (!war?.clan?.tag || !war?.startTime) return;

    const ownClanName = String(war.clan.name ?? ownClanTag).trim() || ownClanTag;
    const opponentClanTag = normalizeTag(war.opponent?.tag ?? "");
    const opponentClanName = String(war.opponent?.name ?? opponentClanTag).trim() || opponentClanTag;
    const warStartTime = parseCocTime(war.startTime) ?? params.fallbackWarStartTime;
    if (!warStartTime) return;
    const warEndTime = parseCocTime(war.endTime ?? null);
    const warState = String(war.state ?? "").trim() || null;
    const observedAt = new Date();

    // Keep WarAttacks as current-war-only storage for each clan.
    await prisma.warAttacks.deleteMany({
      where: {
        clanTag: ownClanTag,
        warStartTime: { not: warStartTime },
      },
    });

    const opponentMembers = Array.isArray(war.opponent?.members)
      ? (war.opponent?.members as WarMemberSnapshot[])
      : [];
    const ownMembers = Array.isArray(war.clan.members)
      ? (war.clan.members as WarMemberSnapshot[])
      : [];

    for (const member of ownMembers) {
      const playerTag = normalizeTag(member.tag);
      if (!playerTag) continue;
      const playerName = String(member.name ?? playerTag).trim() || playerTag;
      const playerPosition = Number.isFinite(Number(member.mapPosition))
        ? Number(member.mapPosition)
        : null;
      const attacks = Array.isArray(member.attacks) ? member.attacks : [];
      const attacksUsed = attacks.length;

      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "WarAttacks"
            ("warId","clanTag","clanName","opponentClanTag","opponentClanName","warStartTime","warEndTime","warState","playerTag","playerName","playerPosition","attacksUsed","attackOrder","attackNumber","defenderTag","defenderName","defenderPosition","stars","trueStars","destruction","attackSeenAt","createdAt","updatedAt")
          VALUES
            (${params.resolvedWarId}, ${ownClanTag}, ${ownClanName}, ${opponentClanTag || null}, ${opponentClanName || null}, ${warStartTime}, ${warEndTime}, ${warState}, ${playerTag}, ${playerName}, ${playerPosition}, ${attacksUsed}, 0, 0, NULL, NULL, NULL, 0, 0, 0, ${observedAt}, NOW(), NOW())
          ON CONFLICT ("clanTag","warStartTime","playerTag","attackOrder")
          DO UPDATE SET
            "warId" = EXCLUDED."warId",
            "clanName" = EXCLUDED."clanName",
            "opponentClanTag" = EXCLUDED."opponentClanTag",
            "opponentClanName" = EXCLUDED."opponentClanName",
            "warEndTime" = EXCLUDED."warEndTime",
            "warState" = EXCLUDED."warState",
            "playerName" = EXCLUDED."playerName",
            "playerPosition" = EXCLUDED."playerPosition",
            "attacksUsed" = EXCLUDED."attacksUsed",
            "attackSeenAt" = LEAST("WarAttacks"."attackSeenAt", EXCLUDED."attackSeenAt"),
            "updatedAt" = NOW()
        `
      );
    }

    const computedAttackRows = computeWarSnapshotAttackRows({
      ownMembers,
      opponentMembers,
    });
    for (const row of computedAttackRows) {
      await prisma.$executeRaw(
        Prisma.sql`
          INSERT INTO "WarAttacks"
            ("warId","clanTag","clanName","opponentClanTag","opponentClanName","warStartTime","warEndTime","warState","playerTag","playerName","playerPosition","attacksUsed","attackOrder","attackNumber","defenderTag","defenderName","defenderPosition","stars","trueStars","destruction","attackSeenAt","createdAt","updatedAt")
          VALUES
            (${params.resolvedWarId}, ${ownClanTag}, ${ownClanName}, ${opponentClanTag || null}, ${opponentClanName || null}, ${warStartTime}, ${warEndTime}, ${warState}, ${row.playerTag}, ${row.playerName}, ${row.playerPosition}, ${row.attacksUsed}, ${row.attackOrder}, ${row.attackNumber}, ${row.defenderTag}, ${row.defenderName}, ${row.defenderPosition}, ${row.stars}, ${row.trueStars}, ${row.destruction}, ${observedAt}, NOW(), NOW())
          ON CONFLICT ("clanTag","warStartTime","playerTag","attackOrder")
          DO UPDATE SET
            "warId" = EXCLUDED."warId",
            "clanName" = EXCLUDED."clanName",
            "opponentClanTag" = EXCLUDED."opponentClanTag",
            "opponentClanName" = EXCLUDED."opponentClanName",
            "warEndTime" = EXCLUDED."warEndTime",
            "warState" = EXCLUDED."warState",
            "playerName" = EXCLUDED."playerName",
            "playerPosition" = EXCLUDED."playerPosition",
            "attacksUsed" = EXCLUDED."attacksUsed",
            "attackNumber" = EXCLUDED."attackNumber",
            "defenderTag" = EXCLUDED."defenderTag",
            "defenderName" = EXCLUDED."defenderName",
            "defenderPosition" = EXCLUDED."defenderPosition",
            "stars" = EXCLUDED."stars",
            "trueStars" = EXCLUDED."trueStars",
            "destruction" = EXCLUDED."destruction",
            "attackSeenAt" = LEAST("WarAttacks"."attackSeenAt", EXCLUDED."attackSeenAt"),
            "updatedAt" = NOW()
        `
      );
    }
  }

  private async dispatchDetectedEvent(params: {
    sub: SubscriptionRow;
    payload: EventEmitPayload;
    resolvedWarId: number | null;
  }): Promise<void> {
    let payloadForDelivery = params.payload;
    let resolvedWarIdForDelivery = params.resolvedWarId;
    if (params.payload.eventType === "war_ended") {
      await this.history.persistWarEndHistory(params.payload).catch((err) => {
        console.error(
          `[war-events] persist war history failed guild=${params.sub.guildId} clan=${params.sub.clanTag} error=${formatError(err)}`
        );
      });
      const canonicalized = await this.resolveCanonicalWarEndedPayloadContext(params.payload);
      payloadForDelivery = canonicalized.payload;
      resolvedWarIdForDelivery = canonicalized.warId ?? resolvedWarIdForDelivery;
      const canonicalFinalResult = await this.history.getWarEndResultSnapshot({
        clanTag: payloadForDelivery.clanTag,
        opponentTag: payloadForDelivery.opponentTag,
        fallbackClanStars: payloadForDelivery.clanStars,
        fallbackOpponentStars: payloadForDelivery.opponentStars,
        warStartTime: payloadForDelivery.warStartTime,
      });
      const canonicalBeforePoints = this.resolveWarEndBeforePoints({
        warStartFwaPoints: payloadForDelivery.warStartFwaPoints,
        fwaPoints: payloadForDelivery.fwaPoints,
      });
      const canonicalWarEndFwaPoints = this.computeExpectedWarEndPoints({
        matchType: payloadForDelivery.matchType,
        before: canonicalBeforePoints,
        finalResult: canonicalFinalResult,
        outcome: normalizeOutcome(payloadForDelivery.outcome),
      });
      payloadForDelivery = {
        ...payloadForDelivery,
        warEndFwaPoints: canonicalWarEndFwaPoints,
        testFinalResultOverride: canonicalFinalResult,
      };
      if (payloadForDelivery.warEndFwaPoints !== params.payload.warEndFwaPoints) {
        await this.history.persistWarEndHistory(payloadForDelivery).catch((err) => {
          console.error(
            `[war-events] persist canonical war history failed guild=${params.sub.guildId} clan=${params.sub.clanTag} error=${formatError(err)}`
          );
        });
      }
    }
    if (!params.sub.notify || !params.sub.channelId) return;
    const reserved = await this.reserveEventDelivery({
      sub: params.sub,
      payload: payloadForDelivery,
      resolvedWarId: resolvedWarIdForDelivery,
    });
    if (!reserved.allowed) {
      return;
    }
    if (reserved.existingMessage) {
      console.log(
        `[notify] existing message found guild=${params.sub.guildId} clan=${params.sub.clanTag} event=${payloadForDelivery.eventType} message=${reserved.existingMessage.messageId}`
      );
      if (payloadForDelivery.eventType === "battle_day") {
        battleDayPostByGuildTag.set(makeBattleDayPostKey(params.sub.guildId, params.sub.clanTag), {
          channelId: reserved.existingMessage.channelId,
          messageId: reserved.existingMessage.messageId,
        });
      }
      return;
    }
    console.log(
      `[war-events] emit start guild=${params.sub.guildId} channel=${params.sub.channelId} clan=${payloadForDelivery.clanTag} event=${payloadForDelivery.eventType}`
    );
    await this.emitEvent(
      params.sub.channelId,
      payloadForDelivery,
      resolvedWarIdForDelivery,
      params.sub
    );
  }

  /** Purpose: reconcile ended-war provider points against persisted expected points and alert once per mismatch fingerprint. */
  private async reconcileWarEndedPointsDiscrepancy(params: {
    guildId: string;
    clanTag: string;
    fallbackOpponentName: string | null;
    allowProviderFetch: boolean;
    fetchReason: PointsApiFetchReason;
  }): Promise<void> {
    const clanTag = normalizeTag(params.clanTag);
    if (!clanTag) return;

    const trackedMessage = await prisma.clanPostedMessage.findFirst({
      where: {
        guildId: params.guildId,
        clanTag,
        type: "notify",
        event: "war_ended",
        warId: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!trackedMessage?.warId) return;

    const warId = Number(trackedMessage.warId);
    if (!Number.isFinite(warId)) return;

    const historyRow = await prisma.clanWarHistory.findFirst({
      where: {
        warId: Math.trunc(warId),
        clanTag,
      },
      select: {
        pointsAfterWar: true,
        clanName: true,
        opponentName: true,
      },
    });
    const expectedPoints =
      historyRow?.pointsAfterWar !== null &&
      historyRow?.pointsAfterWar !== undefined &&
      Number.isFinite(Number(historyRow.pointsAfterWar))
        ? Math.trunc(Number(historyRow.pointsAfterWar))
        : null;
    if (expectedPoints === null) return;
    if (!params.allowProviderFetch) return;

    const providerSnapshot = await this.points
      .fetchSnapshot(clanTag, {
        reason: params.fetchReason,
        caller: "poller",
      })
      .catch(() => null);
    const actualPoints =
      providerSnapshot?.balance !== null &&
      providerSnapshot?.balance !== undefined &&
      Number.isFinite(Number(providerSnapshot.balance))
        ? Math.trunc(Number(providerSnapshot.balance))
        : null;
    if (actualPoints === null) return;
    if (actualPoints === expectedPoints) return;

    const fingerprint = buildWarEndDiscrepancyFingerprint(warId, expectedPoints, actualPoints);
    const previousFingerprint = parseWarEndDiscrepancyFingerprint(trackedMessage.configHash);
    if (previousFingerprint === fingerprint) return;

    const fwaLeaderRoleId = await this.commandPermissions
      .getFwaLeaderRoleId(params.guildId)
      .catch(() => null);
    const allowedMentions = fwaLeaderRoleId
      ? ({ parse: [], roles: [fwaLeaderRoleId] } as const)
      : ({ parse: [] } as const);
    const warningContent =
      `${buildWarEndMismatchWarningHeadline(clanTag)}\n` +
      `${historyRow?.clanName ?? clanTag} (War ID: ${Math.trunc(warId)}).\n` +
      `Expected points: ${expectedPoints}\n` +
      `Actual points: ${actualPoints}` +
      (fwaLeaderRoleId ? `\n<@&${fwaLeaderRoleId}>` : "");

    let alerted = false;
    const channel = await this.client.channels.fetch(trackedMessage.channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const message = await (channel as any).messages.fetch(trackedMessage.messageId).catch(() => null);
      if (message) {
        const edited = buildWarEndDiscrepancyContent({
          existingPostedContent: String(message.content ?? ""),
          clanTag,
          opponentName: historyRow?.opponentName ?? params.fallbackOpponentName,
          expectedPoints,
          actualPoints,
          fwaLeaderRoleId,
        });
        const editedOk = await message
          .edit({
            content: edited.content,
            allowedMentions: edited.allowedMentions,
          })
          .then(() => true)
          .catch(() => false);
        alerted = editedOk;
      }
    }

    if (!alerted && channel && channel.isTextBased()) {
      const sent = await (channel as any)
        .send({
          content: warningContent,
          allowedMentions,
        })
        .catch(() => null);
      alerted = Boolean(sent);
    }
    if (!alerted) return;

    await prisma.clanPostedMessage
      .update({
        where: { id: trackedMessage.id },
        data: {
          configHash: writeWarEndDiscrepancyFingerprint(trackedMessage.configHash, fingerprint),
        },
      })
      .catch(() => null);
  }

  private async tryCreateEventGuard(
    warId: string,
    clanTag: string,
    eventType: string
  ): Promise<boolean> {
    try {
      await prisma.warEvent.create({
        data: {
          warId: Math.trunc(Number(warId)),
          clanTag: normalizeTag(clanTag),
          eventType,
          payload: {},
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        console.log(`[WarEvent] Duplicate ${eventType} skipped clan=#${normalizeTag(clanTag)} warId=${warId}`);
        return false;
      }
      throw error;
    }
  }

  private buildNotifyConfigHash(sub: SubscriptionRow, eventType: EventType): string {
    return hashMessageConfig({
      type: "notify",
      event: eventType,
      channel: sub.channelId,
      role: sub.notifyRole,
      pingEnabled: sub.pingRole,
      embedEnabled: sub.embedEnabled,
    });
  }

  private async reserveEventDelivery(params: {
    sub: SubscriptionRow;
    payload: EventEmitPayload;
    resolvedWarId: number | null;
  }): Promise<{
    allowed: boolean;
    existingMessage: {
      channelId: string;
      messageId: string;
    } | null;
    warId: string | null;
  }> {
    const eventType = params.payload.eventType;
    const warId =
      params.resolvedWarId ??
      params.sub.warId ??
      (await this.resolveWarId(params.payload.clanTag, params.payload.warStartTime));
    if (warId === null || warId === undefined || !Number.isFinite(Number(warId))) {
      console.warn(
        `[war-events] emit skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} event=${eventType} reason=missing_war_id_for_idempotency`
      );
      return { allowed: false, existingMessage: null, warId: null };
    }
    const warIdText = String(Math.trunc(Number(warId)));
    const allowed = await this.tryCreateEventGuard(warIdText, params.payload.clanTag, eventType);
    if (!allowed) {
      return { allowed: false, existingMessage: null, warId: warIdText };
    }
    const existingMessage = await this.postedMessages.findExistingMessage({
      guildId: params.sub.guildId,
      clanTag: params.payload.clanTag,
      warId: warIdText,
      type: "notify",
      event: eventType,
    });
    return {
      allowed: true,
      existingMessage: existingMessage
        ? { channelId: existingMessage.channelId, messageId: existingMessage.messageId }
        : null,
      warId: warIdText,
    };
  }

  private async resolveWarId(clanTagInput: string, warStartTime: Date | null): Promise<number | null> {
    if (!warStartTime) return null;
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return null;
    const currentWarId = await prisma.currentWar
      .findFirst({
        where: {
          clanTag,
          startTime: warStartTime,
        },
        select: { warId: true },
      })
      .catch(() => null);
    return currentWarId?.warId !== null && currentWarId?.warId !== undefined
      ? Number(currentWarId.warId)
      : null;
  }

  /** Purpose: resolve one canonical persisted ended-war context and apply it to war-ended metadata payloads. */
  private async resolveCanonicalWarEndedPayloadContext(
    payload: EventEmitPayload
  ): Promise<{ payload: EventEmitPayload; warId: number | null }> {
    const canonical = await this.history
      .resolveCanonicalWarEndedContext({
        clanTag: payload.clanTag,
        opponentTag: payload.opponentTag,
        warStartTime: payload.warStartTime,
      })
      .catch(() => null);
    if (!canonical) {
      return {
        payload,
        warId: payload.resolvedWarIdHint ?? null,
      };
    }
    return {
      payload: {
        ...payload,
        clanName: String(canonical.clanName ?? payload.clanName).trim() || payload.clanName,
        opponentTag: canonical.opponentTag || payload.opponentTag,
        opponentName: String(canonical.opponentName ?? payload.opponentName).trim() || payload.opponentName,
        syncNumber:
          canonical.syncNumber !== null && canonical.syncNumber !== undefined
            ? canonical.syncNumber
            : payload.syncNumber,
        warStartTime: canonical.warStartTime ?? payload.warStartTime,
        warEndTime: canonical.warEndTime ?? payload.warEndTime,
        resolvedWarIdHint: canonical.warId ?? payload.resolvedWarIdHint ?? null,
      },
      warId: canonical.warId ?? payload.resolvedWarIdHint ?? null,
    };
  }

  private async emitEvent(
    channelId: string,
    payload: {
      eventType: EventType;
      clanTag: string;
      clanName: string;
      opponentTag: string;
      opponentName: string;
      syncNumber: number | null;
      notifyRole: string | null;
      pingRole: boolean;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: "WIN" | "LOSE" | null;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
      clanStars: number | null;
      opponentStars: number | null;
      prepStartTime: Date | null;
      warStartTime: Date | null;
      warEndTime: Date | null;
      clanAttacks: number | null;
      opponentAttacks: number | null;
      teamSize: number | null;
      attacksPerMember: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
      testFinalResultOverride?: WarEndResultSnapshot | null;
    },
    resolvedWarIdOverride?: number | null,
    sub?: SubscriptionRow
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_found`
      );
      return;
    }
    if (!channel.isTextBased()) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_text_based`
      );
      return;
    }
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread
    ) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=unsupported_channel_type type=${channel.type}`
      );
      return;
    }

    const guildId = (channel as { guildId?: string }).guildId ?? null;
    const warId =
      resolvedWarIdOverride ?? (await this.resolveWarId(payload.clanTag, payload.warStartTime));
    const roleId = normalizeNotifyRoleId(payload.notifyRole);
    const includeRoleMentionForPost = payload.pingRole;

    let warEndedStateForSend: NotifyWarEndedViewState | null = null;
    let embed: EmbedBuilder;
    let components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (payload.eventType === "war_ended") {
      const initialTimestampUnix = resolveWarEndedMetadataTimestampUnix(payload.warEndTime, new Date());
      const safeWarId =
        warId !== null && warId !== undefined && Number.isFinite(Number(warId))
          ? Math.trunc(Number(warId))
          : 0;
      warEndedStateForSend = await this.buildWarEndedViewState({
        payload,
        guildId,
        warId: safeWarId,
        messageId: "00000",
        timestampUnix: initialTimestampUnix,
      });
      embed = this.buildWarEndedViewMessage(warEndedStateForSend, "s", 0, false).embed;
    } else {
      const opponentTag = normalizeTag(payload.opponentTag);
      embed = new EmbedBuilder()
        .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
        .setColor(resolveNotifyEventEmbedColor(payload.eventType))
        .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
        .setTimestamp(new Date());

      embed.addFields({
        name: "Opponent",
        value: `${payload.opponentName} (${opponentTag || "unknown"})`,
        inline: false,
      });
      embed.addFields({
        name: "Sync #",
        value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
        inline: true,
      });

      if (payload.eventType === "battle_day") {
        embed.addFields({
          name: "Battle Day Remaining",
          value: toDiscordRelativeTime(payload.warEndTime),
          inline: true,
        });
        embed.addFields({
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        });
        const battlePlanTextRaw = await this.history.buildWarPlanText(
          guildId,
          payload.matchType,
          payload.outcome,
          payload.clanTag,
          payload.opponentName,
          "battle",
          payload.clanName
        );
        const battlePlanText = sanitizeWarPlanForEmbed(battlePlanTextRaw);
        if (battlePlanText) {
          embed.addFields({
            name: "War Plan",
            value: battlePlanText,
            inline: false,
          });
        } else if (!battlePlanTextRaw && payload.matchType === "BL") {
          embed.addFields({
            name: "Message",
            value:
              "**Battle day has started! Thank you for your help swapping to war bases, please swap back to FWA bases asap!**",
            inline: false,
          });
        } else if (!battlePlanTextRaw && payload.matchType === "MM") {
          embed.addFields({
            name: "Message",
            value: "Attack whatever you want! Free for all!",
            inline: false,
          });
        }
      }

      if (payload.eventType === "battle_day") {
        embed.addFields({
          name: "\u200b",
          value: buildWarStatsLines({
            clanStars: payload.clanStars,
            opponentStars: payload.opponentStars,
            clanAttacks: payload.clanAttacks,
            opponentAttacks: payload.opponentAttacks,
            teamSize: payload.teamSize,
            attacksPerMember: payload.attacksPerMember,
            clanDestruction: payload.clanDestruction,
            opponentDestruction: payload.opponentDestruction,
          }).join("\n"),
          inline: false,
        });
      }

      if (payload.eventType === "war_started") {
        embed.addFields({
          name: "Prep Day Remaining",
          value: toDiscordRelativeTime(payload.warStartTime),
          inline: true,
        });
        embed.addFields({
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        });
        const prepPlanTextRaw = await this.history.buildWarPlanText(
          guildId,
          payload.matchType,
          payload.outcome,
          payload.clanTag,
          payload.opponentName,
          "prep",
          payload.clanName
        );
        const prepPlanText = sanitizeWarPlanForEmbed(prepPlanTextRaw);
        if (prepPlanText) {
          embed.addFields({
            name: "War Plan",
            value: prepPlanText,
            inline: false,
          });
        } else if (!prepPlanTextRaw && payload.matchType === "BL") {
          embed.addFields({
            name: "Message",
            value: [
              `BLACKLIST WAR vs ${payload.opponentName}`,
              "Everyone switch to WAR BASES!",
              "This is an opportunity to gain extra FWA points.",
            ].join("\n"),
            inline: false,
          });
        }
        if (payload.matchType === "MM") {
          embed.addFields({
            name: "Message",
            value: [
              `MISMATCHED WAR vs ${payload.opponentName}`,
              "Keep war base active and attack what you can.",
            ].join("\n"),
            inline: false,
          });
        }
      }

      components =
        payload.eventType === "battle_day" && guildId
          ? [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
                  .setLabel("Refresh")
                  .setStyle(ButtonStyle.Secondary)
              ),
            ]
          : [];
    }

    const sent = await channel
      .send({
        content: buildNotifyEventPostedContent({
          eventType: payload.eventType,
          opponentName: payload.opponentName,
          notifyRoleId: roleId,
          includeRoleMention: includeRoleMentionForPost,
          nowMs: Date.now(),
          nextScheduledRefreshAtMs: getNextNotifyRefreshAtMs(),
        }),
        embeds: [embed],
        components,
        allowedMentions:
          includeRoleMentionForPost && roleId ? { roles: [roleId] } : undefined,
      })
      .catch((err) => {
        console.error(
          `[war-events] send failed channel=${channelId} clan=${payload.clanTag} error=${formatError(err)}`
        );
        return null;
      });
    if (guildId) {
      const key = makeBattleDayPostKey(guildId, payload.clanTag);
      if (payload.eventType === "battle_day" && sent) {
        battleDayPostByGuildTag.set(key, { channelId, messageId: sent.id });
      } else if (payload.eventType !== "battle_day") {
        battleDayPostByGuildTag.delete(key);
      }
    }
    if (sent) {
      if (guildId && sub && warId !== null && warId !== undefined) {
        await this.postedMessages.savePostedMessage({
          guildId,
          clanTag: payload.clanTag,
          type: "notify",
          event: payload.eventType,
          warId: String(warId),
          syncNum: payload.syncNumber ?? null,
          channelId,
          messageId: sent.id,
          messageUrl: `https://discord.com/channels/${guildId}/${channelId}/${sent.id}`,
          configHash: this.buildNotifyConfigHash(sub, payload.eventType),
        });
      }

      if (payload.eventType === "war_ended" && warEndedStateForSend && guildId) {
        const finalizedState: NotifyWarEndedViewState = {
          ...warEndedStateForSend,
          guildId,
          warId:
            warId !== null && warId !== undefined && Number.isFinite(Number(warId))
              ? Math.trunc(Number(warId))
              : warEndedStateForSend.warId,
          messageId: sent.id,
          timestampUnix: resolveWarEndedMetadataTimestampUnix(
            payload.warEndTime,
            new Date(sent.createdTimestamp)
          ),
        };
        const rendered = this.buildWarEndedViewMessage(finalizedState, "s", 0, true);
        const updated = await sent
          .edit({
            embeds: [rendered.embed],
            components: rendered.components,
            allowedMentions: { parse: [] },
          })
          .then(() => true)
          .catch(() => false);
        if (updated) {
          this.rememberWarEndedViewState(finalizedState);
        }
      }

      console.log(
        `[war-events] emit success guild=${guildId ?? "unknown"} channel=${channelId} message=${sent.id} clan=${payload.clanTag} event=${payload.eventType}`
      );
    }
  }
  async refreshBattleDayPosts(): Promise<void> {
    const storedPosts = await prisma.clanPostedMessage.findMany({
      where: {
        type: "notify",
        event: "battle_day",
      },
      select: {
        guildId: true,
        clanTag: true,
        channelId: true,
        messageId: true,
      },
    });
    for (const stored of storedPosts) {
      battleDayPostByGuildTag.set(makeBattleDayPostKey(stored.guildId, stored.clanTag), {
        channelId: stored.channelId,
        messageId: stored.messageId,
      });
    }
    const keys = [...battleDayPostByGuildTag.keys()];
    for (const key of keys) {
      await this.refreshBattleDayPostByKey(key).catch((err) => {
        console.error(`[war-events] battle-day refresh failed key=${key} error=${formatError(err)}`);
      });
    }
  }

  async refreshBattleDayPostByInteraction(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseNotifyWarRefreshCustomId(interaction.customId);
    if (!parsed) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ ephemeral: true, content: "Invalid refresh action." });
      }
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const key = makeBattleDayPostKey(parsed.guildId, parsed.clanTag);
    battleDayPostByGuildTag.set(key, {
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
    const result = await this.refreshBattleDayPostByKey(key);
    await interaction.editReply({
      content:
        result === "missing"
          ? "This battle day embed can no longer be refreshed."
          : result === "frozen"
            ? "Battle day embed frozen for the ended phase."
        : "Battle day embed refreshed.",
    });
  }

  async toggleWarEndedViewByInteraction(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseNotifyWarEndedViewCustomId(interaction.customId);
    if (!parsed) {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }
    if (
      interaction.guildId !== parsed.guildId ||
      interaction.message.id !== parsed.messageId
    ) {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }

    const state = warEndedViewStateByMessage.get(
      toWarEndedViewStateKey(parsed.guildId, parsed.messageId)
    );
    if (!state) {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }
    if (
      state.guildId !== parsed.guildId ||
      normalizeTag(state.clanTag) !== normalizeTag(parsed.clanTag) ||
      Math.trunc(state.warId) !== Math.trunc(parsed.warId) ||
      state.messageId !== parsed.messageId ||
      Math.trunc(state.timestampUnix) !== Math.trunc(parsed.timestampUnix)
    ) {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }

    const trackedMessage = await this.postedMessages.findExistingMessage({
      guildId: parsed.guildId,
      clanTag: parsed.clanTag,
      warId: String(Math.trunc(parsed.warId)),
      type: "notify",
      event: "war_ended",
    });
    if (!trackedMessage || trackedMessage.messageId !== parsed.messageId) {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }

    if (parsed.view === "c" && state.matchType !== "FWA") {
      await this.replyWithExpiredWarEndedView(interaction);
      return;
    }

    const rendered = this.buildWarEndedViewMessage(
      state,
      parsed.view,
      parsed.page,
      true
    );
    await interaction.update({
      embeds: [rendered.embed],
      components: rendered.components,
    });
  }

  async refreshCurrentNotifyPost(guildId: string, clanTagInput: string): Promise<boolean> {
    const clanTag = normalizeTag(clanTagInput);
    if (!guildId || !clanTag) return false;

    const sub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!sub || !sub.notify) return false;

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    if (!war) return false;

    const state = deriveState(String(war.state ?? ""));
    if (state !== "preparation" && state !== "inWar") return false;

    const prepStartTime = parseCocTime(war.preparationStartTime ?? null) ?? sub.prepStartTime ?? null;
    const warStartTime = parseCocTime(war.startTime ?? null) ?? sub.startTime ?? null;
    const warEndTime = parseCocTime(war.endTime ?? null) ?? sub.endTime ?? null;
    const nextClanName = String(war.clan?.name ?? sub.clanName ?? sub.clanTag).trim() || sub.clanTag;
    const nextOpponentTag = normalizeTag(war.opponent?.tag ?? sub.opponentTag ?? "");
    const nextOpponentName =
      String(war.opponent?.name ?? sub.opponentName ?? "Unknown").trim() || "Unknown";
    const nextClanStars = Number.isFinite(Number(war.clan?.stars))
      ? Number(war.clan?.stars)
      : sub.clanStars;
    const nextOpponentStars = Number.isFinite(Number(war.opponent?.stars))
      ? Number(war.opponent?.stars)
      : sub.opponentStars;
    const resolvedWarId = await this.ensureCurrentWarId({
      sub,
      warStartTime,
      currentState: state,
    });

    await prisma.currentWar.update({
      where: {
        clanTag_guildId: {
          guildId: sub.guildId,
          clanTag: sub.clanTag,
        },
      },
      data: {
        warId: resolvedWarId,
        state,
        prepStartTime,
        startTime: warStartTime,
        endTime: warEndTime,
        opponentTag: nextOpponentTag || sub.opponentTag,
        opponentName: nextOpponentName || sub.opponentName,
        clanName: nextClanName,
        clanStars: nextClanStars,
        opponentStars: nextOpponentStars,
        updatedAt: new Date(),
      },
    });

    const refreshedSub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!refreshedSub) return false;

    const warIdText =
      resolvedWarId !== null && resolvedWarId !== undefined && Number.isFinite(Number(resolvedWarId))
        ? String(Math.trunc(Number(resolvedWarId)))
        : refreshedSub.warId !== null && refreshedSub.warId !== undefined
          ? String(Math.trunc(Number(refreshedSub.warId)))
          : null;
    if (!warIdText) return false;

    const eventType: EventType = state === "preparation" ? "war_started" : "battle_day";
    const existingMessage = await this.postedMessages.findExistingMessage({
      guildId,
      clanTag,
      warId: warIdText,
      type: "notify",
      event: eventType,
    });
    if (!existingMessage) return false;

    const channel = await this.client.channels.fetch(existingMessage.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    const message = await (channel as any).messages.fetch(existingMessage.messageId).catch(() => null);
    if (!message) return false;

    const basePayload = {
      clanTag: refreshedSub.clanTag,
      clanName: nextClanName,
      opponentTag: nextOpponentTag,
      opponentName: nextOpponentName,
      syncNumber:
        (
          await this.currentSyncs.getCurrentSyncForClan({
            guildId,
            clanTag,
            warId: warIdText,
            warStartTime,
          })
        )?.syncNum ?? null,
      notifyRole: refreshedSub.notifyRole,
      pingRole: refreshedSub.pingRole,
      fwaPoints: refreshedSub.fwaPoints,
      opponentFwaPoints: refreshedSub.opponentFwaPoints,
      outcome: normalizeOutcome(refreshedSub.outcome),
      matchType: refreshedSub.matchType,
      warStartFwaPoints: refreshedSub.warStartFwaPoints,
      warEndFwaPoints: refreshedSub.warEndFwaPoints,
      clanStars: nextClanStars,
      opponentStars: nextOpponentStars,
      prepStartTime,
      warStartTime,
      warEndTime,
      clanAttacks: Number.isFinite(Number(war.clan?.attacks)) ? Number(war.clan?.attacks) : null,
      opponentAttacks: Number.isFinite(Number(war.opponent?.attacks))
        ? Number(war.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(war.teamSize)) ? Number(war.teamSize) : null,
      attacksPerMember: Number.isFinite(Number(war.attacksPerMember))
        ? Number(war.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(war.clan?.destructionPercentage))
        ? Number(war.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(Number(war.opponent?.destructionPercentage))
        ? Number(war.opponent?.destructionPercentage)
        : null,
    };

    if (eventType === "battle_day") {
      const payload = { ...basePayload, eventType: "battle_day" as const };
      const key = makeBattleDayPostKey(guildId, clanTag);
      battleDayPostByGuildTag.set(key, {
        channelId: existingMessage.channelId,
        messageId: existingMessage.messageId,
      });
      const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder());
      const next = await this.buildBattleDayRefreshEmbed(payload, Number(warIdText), guildId, embed);
      const refreshEditPayload = buildBattleDayRefreshEditPayload(
        String(message.content ?? ""),
        payload.opponentName,
        Date.now()
      );
      await message.edit({
        content: refreshEditPayload.content,
        allowedMentions: refreshEditPayload.allowedMentions,
        embeds: [next],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
              .setLabel("Refresh")
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return true;
    }

    const payload = { ...basePayload, eventType: "war_started" as const };
    const next = await this.buildWarStartedRefreshEmbed(payload, Number(warIdText), guildId);
    await message.edit({
      content: message.content || undefined,
      embeds: [next],
      components: [],
    });
    return true;
  }

  private async refreshBattleDayPostByKey(key: string): Promise<"refreshed" | "frozen" | "missing"> {
    const tracked = battleDayPostByGuildTag.get(key);
    if (!tracked) return "missing";
    const [guildId, clanTag] = key.split(":");
    if (!guildId || !clanTag) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }

    const sub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!sub || !sub.notify) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }

    const channel = await this.client.channels.fetch(tracked.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }
    const message = await (channel as any).messages.fetch(tracked.messageId).catch(() => null);
    if (!message) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    if (!war || deriveState(String(war.state ?? "")) !== "inWar") {
      await message.edit({
        content: undefined,
        embeds: message.embeds.map((embed: any) => EmbedBuilder.from(embed)),
        components: [],
      });
      battleDayPostByGuildTag.delete(key);
      return "frozen";
    }

    const prepStartTime = parseCocTime(war.preparationStartTime ?? null) ?? sub.prepStartTime ?? null;
    const warStartTime = parseCocTime(war.startTime ?? null) ?? sub.startTime ?? null;
    const warEndTime = parseCocTime(war.endTime ?? null);
    const nextClanName = String(war.clan?.name ?? sub.clanName ?? sub.clanTag).trim() || sub.clanTag;
    const nextOpponentTag = normalizeTag(war.opponent?.tag ?? sub.opponentTag ?? "");
    const nextOpponentName =
      String(war.opponent?.name ?? sub.opponentName ?? "Unknown").trim() || "Unknown";
    const nextClanStars = Number.isFinite(Number(war.clan?.stars))
      ? Number(war.clan?.stars)
      : sub.clanStars;
    const nextOpponentStars = Number.isFinite(Number(war.opponent?.stars))
      ? Number(war.opponent?.stars)
      : sub.opponentStars;
    const resolvedWarId = await this.ensureCurrentWarId({
      sub,
      warStartTime,
      currentState: "inWar",
    });
    await prisma.currentWar.update({
      where: {
        clanTag_guildId: {
          guildId: sub.guildId,
          clanTag: sub.clanTag,
        },
      },
      data: {
        warId: resolvedWarId,
        state: "inWar",
        prepStartTime,
        startTime: warStartTime,
        endTime: warEndTime,
        opponentTag: nextOpponentTag || sub.opponentTag,
        opponentName: nextOpponentName || sub.opponentName,
        clanName: nextClanName,
        clanStars: nextClanStars,
        opponentStars: nextOpponentStars,
        updatedAt: new Date(),
      },
    });

    const refreshedSub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!refreshedSub) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }

    const payload = {
      eventType: "battle_day" as const,
      clanTag: refreshedSub.clanTag,
      clanName: String(war.clan?.name ?? refreshedSub.clanName ?? refreshedSub.clanTag).trim() || refreshedSub.clanTag,
      opponentTag: normalizeTag(war.opponent?.tag ?? refreshedSub.opponentTag ?? ""),
      opponentName:
        String(war.opponent?.name ?? refreshedSub.opponentName ?? "Unknown").trim() || "Unknown",
      syncNumber:
        (
          await this.currentSyncs.getCurrentSyncForClan({
            guildId,
            clanTag,
            warId:
              resolvedWarId !== null && resolvedWarId !== undefined
                ? String(Math.trunc(Number(resolvedWarId)))
                : refreshedSub.warId !== null && refreshedSub.warId !== undefined
                  ? String(Math.trunc(Number(refreshedSub.warId)))
                  : null,
            warStartTime,
          })
        )?.syncNum ?? null,
      notifyRole: refreshedSub.notifyRole,
      pingRole: refreshedSub.pingRole,
      fwaPoints: refreshedSub.fwaPoints,
      opponentFwaPoints: refreshedSub.opponentFwaPoints,
      outcome: normalizeOutcome(refreshedSub.outcome),
      matchType: refreshedSub.matchType,
      warStartFwaPoints: refreshedSub.warStartFwaPoints,
      warEndFwaPoints: refreshedSub.warEndFwaPoints,
      clanStars: Number.isFinite(Number(war.clan?.stars))
        ? Number(war.clan?.stars)
        : refreshedSub.clanStars,
      opponentStars: Number.isFinite(Number(war.opponent?.stars))
        ? Number(war.opponent?.stars)
        : refreshedSub.opponentStars,
      warStartTime,
      warEndTime,
      clanAttacks: Number.isFinite(Number(war.clan?.attacks)) ? Number(war.clan?.attacks) : null,
      opponentAttacks: Number.isFinite(Number(war.opponent?.attacks))
        ? Number(war.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(war.teamSize)) ? Number(war.teamSize) : null,
      attacksPerMember: Number.isFinite(Number(war.attacksPerMember))
        ? Number(war.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(war.clan?.destructionPercentage))
        ? Number(war.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(Number(war.opponent?.destructionPercentage))
        ? Number(war.opponent?.destructionPercentage)
        : null,
    };
    const warId = resolvedWarId ?? refreshedSub.warId ?? null;
    const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder());
    const next = await this.buildBattleDayRefreshEmbed(payload, warId, guildId, embed);
    const refreshEditPayload = buildBattleDayRefreshEditPayload(
      String(message.content ?? ""),
      payload.opponentName,
      Date.now()
    );
    await message.edit({
      content: refreshEditPayload.content,
      allowedMentions: refreshEditPayload.allowedMentions,
      embeds: [next],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
            .setLabel("Refresh")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
    return "refreshed";
  }

  private async buildBattleDayRefreshEmbed(
    payload: {
      eventType: "battle_day";
      clanTag: string;
      clanName: string;
      opponentTag: string;
      opponentName: string;
      syncNumber: number | null;
      notifyRole: string | null;
      pingRole: boolean;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: "WIN" | "LOSE" | null;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
      clanStars: number | null;
      opponentStars: number | null;
      warStartTime: Date | null;
      warEndTime: Date | null;
      clanAttacks: number | null;
      opponentAttacks: number | null;
      teamSize: number | null;
      attacksPerMember: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
    },
    warId: number | null,
    guildId: string,
    _previous: EmbedBuilder
  ): Promise<EmbedBuilder> {
    const opponentTag = normalizeTag(payload.opponentTag);
    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(0xf1c40f)
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
      .setTimestamp(new Date());
    embed.addFields({
      name: "Opponent",
      value: `${payload.opponentName} (${opponentTag || "unknown"})`,
      inline: false,
    });
    embed.addFields({
      name: "Sync #",
      value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
      inline: true,
    });
    embed.addFields({
      name: "Battle Day Ends",
      value: toDiscordRelativeTime(payload.warEndTime),
      inline: true,
    });
    embed.addFields({
      name: "Match Type",
      value: payload.matchType ?? "unknown",
      inline: true,
    });
    const battlePlanTextRaw = await this.history.buildWarPlanText(
      guildId,
      payload.matchType,
      payload.outcome,
      payload.clanTag,
      payload.opponentName,
      "battle",
      payload.clanName
    );
    const battlePlanText = sanitizeWarPlanForEmbed(battlePlanTextRaw);
    if (battlePlanText) {
      embed.addFields({
        name: "War Plan",
        value: battlePlanText,
        inline: false,
      });
    } else if (!battlePlanTextRaw && payload.matchType === "BL") {
      embed.addFields({
        name: "Message",
        value:
          "**Battle day has started! Thank you for your help swapping to war bases, please swap back to FWA bases asap!**",
        inline: false,
      });
    } else if (!battlePlanTextRaw) {
      embed.addFields({
        name: "Message",
        value: "Attack whatever you want! Free for all! ⚔️",
        inline: false,
      });
    }
    embed.addFields({
      name: "\u200b",
      value: buildWarStatsLines({
        clanStars: payload.clanStars,
        opponentStars: payload.opponentStars,
        clanAttacks: payload.clanAttacks,
        opponentAttacks: payload.opponentAttacks,
        teamSize: payload.teamSize,
        attacksPerMember: payload.attacksPerMember,
        clanDestruction: payload.clanDestruction,
        opponentDestruction: payload.opponentDestruction,
      }).join("\n"),
      inline: false,
    });
    return embed;
  }

  private async buildWarStartedRefreshEmbed(
    payload: {
      eventType: "war_started";
      clanTag: string;
      clanName: string;
      opponentTag: string;
      opponentName: string;
      syncNumber: number | null;
      notifyRole: string | null;
      pingRole: boolean;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: "WIN" | "LOSE" | null;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
      clanStars: number | null;
      opponentStars: number | null;
      prepStartTime: Date | null;
      warStartTime: Date | null;
      warEndTime: Date | null;
      clanAttacks: number | null;
      opponentAttacks: number | null;
      teamSize: number | null;
      attacksPerMember: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
    },
    warId: number | null,
    guildId: string
  ): Promise<EmbedBuilder> {
    const opponentTag = normalizeTag(payload.opponentTag);
    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(0x3498db)
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
      .setTimestamp(new Date());
    embed.addFields({
      name: "Opponent",
      value: `${payload.opponentName} (${opponentTag || "unknown"})`,
      inline: false,
    });
    embed.addFields({
      name: "Sync #",
      value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
      inline: true,
    });
    embed.addFields({
      name: "Prep Day Remaining",
      value: toDiscordRelativeTime(payload.warStartTime),
      inline: true,
    });
    embed.addFields({
      name: "Match Type",
      value: payload.matchType ?? "unknown",
      inline: true,
    });
    const prepPlanTextRaw = await this.history.buildWarPlanText(
      guildId,
      payload.matchType,
      payload.outcome,
      payload.clanTag,
      payload.opponentName,
      "prep",
      payload.clanName
    );
    const prepPlanText = sanitizeWarPlanForEmbed(prepPlanTextRaw);
    if (prepPlanText) {
      embed.addFields({
        name: "War Plan",
        value: prepPlanText,
        inline: false,
      });
    } else if (!prepPlanTextRaw && payload.matchType === "BL") {
      embed.addFields({
        name: "Message",
        value:
          "**Prep day has started. This is a blacklist war. Keep regular prep coordination and plan for battle day instructions.**",
        inline: false,
      });
    } else if (!prepPlanTextRaw) {
      embed.addFields({
        name: "Message",
        value: "Prep day has started. This is a mismatch war.",
        inline: false,
      });
    }
    return embed;
  }

}

export function buildNotifyWarRefreshCustomId(guildId: string, clanTag: string): string {
  return `${NOTIFY_WAR_REFRESH_PREFIX}:${guildId}:${normalizeTagBare(clanTag)}`;
}

export function parseNotifyWarRefreshCustomId(
  customId: string
): { guildId: string; clanTag: string } | null {
  const [prefix, guildId, clanTagBare] = String(customId ?? "").split(":");
  if (prefix !== NOTIFY_WAR_REFRESH_PREFIX || !guildId || !clanTagBare) return null;
  return { guildId, clanTag: normalizeTag(clanTagBare) };
}

export function isNotifyWarRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_REFRESH_PREFIX}:`);
}

export async function handleNotifyWarRefreshButton(
  interaction: ButtonInteraction
): Promise<void> {
  const service = new WarEventLogService(interaction.client, new CoCService());
  await service.refreshBattleDayPostByInteraction(interaction);
}

export async function handleNotifyWarEndedViewButton(
  interaction: ButtonInteraction
): Promise<void> {
  const service = new WarEventLogService(interaction.client, new CoCService());
  await service.toggleWarEndedViewByInteraction(interaction);
}

export const notifyWarBattleDayRefreshIntervalMs = BATTLE_DAY_REFRESH_MS;
