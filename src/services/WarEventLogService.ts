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
import {
  ActiveWarSyncResolutionService,
  type ActiveWarSyncAssignmentResult,
  buildActiveWarSyncIdentity,
  logActiveWarSyncResolution,
  nextCurrentWarRevision,
  resolveActiveWarSyncNumber,
} from "./ActiveWarSyncResolutionService";
import { PointsProjectionService } from "./PointsProjectionService";
import { PointsDirectFetchGateService } from "./PointsDirectFetchGateService";
import { PostedMessageService } from "./PostedMessageService";
import { PointsSyncService } from "./PointsSyncService";
import type { PointsApiFetchReason } from "./PointsFetchTypes";
import { SettingsService } from "./SettingsService";
import { CommandPermissionService } from "./CommandPermissionService";
import { BotLogChannelService } from "./BotLogChannelService";
import { cwlStateService } from "./CwlStateService";
import { MaintenanceWindowService } from "./MaintenanceWindowService";
import {
  chooseMatchTypeResolution,
  compareActiveWarIdentities,
  inferMatchTypeFromOpponentPoints,
  resolveCurrentWarMatchTypeSignal,
  toSyncIsFwa,
  type MatchTypeResolution,
} from "./MatchTypeResolutionService";
import { WarEventHistoryService } from "./war-events/history";
import { WarStartPointsSyncService } from "./war-events/pointsSync";
import {
  WarComplianceService,
  type WarComplianceIssue,
} from "./WarComplianceService";
import { WarPlanViolationService } from "./WarPlanViolationService";
import { FwaPoliceService } from "./FwaPoliceService";
import {
  fireBattleDayTransitionWar24hRemindersForClan,
  fireBattleDayTransitionWar24hRemindersForGuild,
} from "./reminders/ReminderSchedulerService";
import { buildFwaComplianceEmbedView } from "./FwaComplianceEmbedViewService";
import {
  buildComplianceWarPlanText,
  sanitizeWarPlanForEmbed,
} from "./warPlanDisplay";
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
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  parseFwaBaseSwapMetadata,
  shouldSendFwaBaseSwapBattleDayReminder,
  trackedMessageService,
} from "./TrackedMessageService";
export {
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
} from "./war-events/core";

type CurrentWarSnapshot = Awaited<ReturnType<CoCService["getCurrentWar"]>>;
export type CurrentWarSnapshotCycleContext = {
  currentWarSnapshotByClanTag: Map<string, CurrentWarSnapshot | null>;
};

const NOTIFY_WAR_REFRESH_PREFIX = "notify-war-refresh";
const NOTIFY_WAR_ENDED_VIEW_PREFIX = "notify-war-end";
const NOTIFY_WAR_ENDED_VIEW_EXPIRED = "This war-end view expired.";
const BATTLE_DAY_REFRESH_MS = 20 * 60 * 1000;
const COC_WAR_OUTAGE_FAILURE_THRESHOLD = 2;
const COC_WAR_OUTAGE_RECOVERY_THRESHOLD = 2;
const battleDayPostByGuildTag = new Map<
  string,
  { channelId: string; messageId: string }
>();
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

export const buildNotifyNextRefreshLabelForTest = buildNextRefreshRelativeLabel;

function normalizeNotifyRoleId(
  roleId: string | null | undefined,
): string | null {
  const raw = String(roleId ?? "").trim();
  if (!raw) return null;
  const mentionMatch = raw.match(/^<@&(\d{5,})>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const idMatch = raw.match(/^(\d{5,})$/);
  if (idMatch?.[1]) return idMatch[1];
  return null;
}

function buildNotifyEventContextLine(
  eventType: EventType,
  opponentNameInput: string | null | undefined,
): string {
  const opponentName =
    String(opponentNameInput ?? "").trim() || NOTIFY_UNKNOWN_OPPONENT;
  if (eventType === "war_started")
    return `War declared against ${opponentName}`;
  if (eventType === "battle_day") return `War started against ${opponentName}`;
  return `War ended against ${opponentName}`;
}

function shouldSuppressBattleDayNotifyRoleMention(
  eventType: EventType,
  pointsNeedsValidation: boolean | null | undefined,
): boolean {
  return eventType === "battle_day" && pointsNeedsValidation === true;
}

function buildNotifyEventPostedContent(params: {
  eventType: EventType;
  opponentName: string | null | undefined;
  notifyRoleId?: string | null;
  includeRoleMention?: boolean;
  nowMs?: number;
  nextScheduledRefreshAtMs?: number | null;
}): string {
  const sections: string[] = [
    buildNotifyEventContextLine(params.eventType, params.opponentName),
  ];
  const normalizedRoleId = normalizeNotifyRoleId(params.notifyRoleId);
  if (params.includeRoleMention !== false && normalizedRoleId) {
    sections.push(`<@&${normalizedRoleId}>`);
  }
  if (params.eventType === "battle_day") {
    sections.push(
      buildNextRefreshRelativeLabel(
        BATTLE_DAY_REFRESH_MS,
        params.nowMs,
        params.nextScheduledRefreshAtMs,
      ),
    );
  }
  return sections.join("\n");
}

export const buildNotifyEventPostedContentForTest =
  buildNotifyEventPostedContent;

function extractPostedNotifyMentionRoleId(
  existingPostedContent: string | null | undefined,
): string | null {
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
  nowMs?: number,
  includeRoleMention = true,
): { content: string; allowedMentions: { parse: [] } } {
  const persistedMentionRoleId = extractPostedNotifyMentionRoleId(
    includeRoleMention ? existingPostedContent : null,
  );
  return {
    content: buildNotifyEventPostedContent({
      eventType: "battle_day",
      opponentName,
      notifyRoleId: persistedMentionRoleId,
      includeRoleMention:
        includeRoleMention && Boolean(persistedMentionRoleId),
      nowMs,
      nextScheduledRefreshAtMs: getNextNotifyRefreshAtMs(),
    }),
    allowedMentions: { parse: [] },
  };
}

export const buildBattleDayRefreshEditPayloadForTest =
  buildBattleDayRefreshEditPayload;

function buildFwaBaseSwapBattleDayReminderContent(input: {
  clanRoleId?: string | null;
  matchType: "BL" | "CWL";
}): string {
  const clanRoleId = String(input.clanRoleId ?? "").trim();
  const body =
    input.matchType === "CWL"
      ? "Thanks everyone for swapping to war bases for the serious CWL. Please swap back to your FWA base for the next FWA war."
      : "Thanks everyone for swapping to war bases for the blacklist war. Please swap back to your FWA base for the next war.";
  const lines = ["### Battle Day Started!", body];
  if (clanRoleId) lines.push(`<@&${clanRoleId}>`);
  return lines.join("\n");
}

export const buildFwaBaseSwapBattleDayReminderContentForTest =
  buildFwaBaseSwapBattleDayReminderContent;

function normalizeBattleDayReminderAllowedMentions(
  roleId: string | null | undefined,
): { roles: string[] } | { parse: [] } {
  const normalizedRoleId = String(roleId ?? "").trim();
  return normalizedRoleId ? { roles: [normalizedRoleId] } : { parse: [] };
}

function buildBattleDayReminderIdentity(input: {
  kind: "BL" | "CWL";
  guildId: string;
  clanTag: string;
  referenceId: string;
  season: string;
  roundDay: number;
  battleDayStart: Date | null;
}): string {
  const parts = [
    "fwa-base-swap-battle-day",
    input.kind,
    String(input.guildId ?? "").trim(),
    normalizeTagBare(input.clanTag),
    String(input.referenceId ?? "").trim(),
    String(input.season ?? "").trim(),
    String(Math.trunc(Number(input.roundDay) || 0)),
    input.battleDayStart ? String(Math.trunc(input.battleDayStart.getTime())) : "unknown",
  ];
  return parts.join(":");
}

type CwlBattleDayReminderState = {
  season: string;
  roundDay: number;
  roundState: string;
  startTime: Date | null;
  endTime: Date | null;
};

function isBattleDayRoundState(roundState: string | null | undefined): boolean {
  return String(roundState ?? "").trim().toLowerCase().includes("inwar");
}

function resolveCwlBattleDayReminderRange(
  state: CwlBattleDayReminderState | null | undefined,
): { startTime: number; endTime: number } | null {
  if (!state?.startTime) return null;
  const startTime = state.startTime.getTime();
  const endTime = state.endTime?.getTime() ?? startTime;
  return {
    startTime,
    endTime: Math.max(startTime, endTime),
  };
}

function scoreCwlRosterLifecycleState(lifecycleState: string | null | undefined): number {
  const normalized = String(lifecycleState ?? "").trim().toUpperCase();
  if (normalized === "ACTIVE") return 3;
  if (normalized === "OPEN") return 2;
  if (normalized === "CLOSED") return 1;
  return 0;
}

function scoreCwlRosterOverlap(
  roster: { startsAt: Date | null; endsAt: Date | null },
  battleDayRange: { startTime: number; endTime: number } | null,
): number {
  if (!battleDayRange || !roster.startsAt) return 0;
  const rosterStart = roster.startsAt.getTime();
  const rosterEnd = roster.endsAt?.getTime() ?? rosterStart;
  const overlapStart = Math.max(rosterStart, battleDayRange.startTime);
  const overlapEnd = Math.min(Math.max(rosterStart, rosterEnd), battleDayRange.endTime);
  return Math.max(0, overlapEnd - overlapStart);
}

async function resolveCwlBattleDayReminderStateForClan(input: {
  clanTag: string;
}): Promise<CwlBattleDayReminderState | null> {
  const clanTag = String(input.clanTag ?? "").trim();
  if (!clanTag) return null;

  const [currentRound, currentPrep] = await Promise.all([
    cwlStateService.getCurrentRoundForClan({ clanTag }),
    cwlStateService.getCurrentPreparationSnapshotForClan({ clanTag }),
  ]);

  if (currentRound && isBattleDayRoundState(currentRound.roundState)) {
    return {
      season: currentRound.season,
      roundDay: currentRound.roundDay,
      roundState: currentRound.roundState,
      startTime: currentRound.startTime,
      endTime: currentRound.endTime,
    };
  }

  if (currentPrep && isBattleDayRoundState(currentPrep.roundState)) {
    return {
      season: currentPrep.season,
      roundDay: currentPrep.roundDay,
      roundState: currentPrep.roundState,
      startTime: currentPrep.startTime,
      endTime: currentPrep.endTime,
    };
  }

  return null;
}

async function resolveCwlBattleDayReminderRoleId(input: {
  guildId: string;
  clanTag: string;
  battleDayState: CwlBattleDayReminderState;
}): Promise<string | null> {
  const guildId = String(input.guildId ?? "").trim();
  const clanTag = String(input.clanTag ?? "").trim();
  if (!guildId || !clanTag) return null;

  const rosterRows = await prisma.roster.findMany({
    where: {
      guildId,
      rosterType: "CWL",
      clanTag: { equals: clanTag, mode: "insensitive" },
      rosterRoleId: { not: null },
      lifecycleState: { not: "ARCHIVED" },
    },
    select: {
      rosterRoleId: true,
      lifecycleState: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
    },
  });

  if (rosterRows.length === 0) return null;

  const battleDayRange = resolveCwlBattleDayReminderRange(input.battleDayState);
  const sortedRows = [...rosterRows].sort((left, right) => {
    const leftOverlap = scoreCwlRosterOverlap(left, battleDayRange);
    const rightOverlap = scoreCwlRosterOverlap(right, battleDayRange);
    if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;

    const leftLifecycle = scoreCwlRosterLifecycleState(left.lifecycleState);
    const rightLifecycle = scoreCwlRosterLifecycleState(right.lifecycleState);
    if (leftLifecycle !== rightLifecycle) return rightLifecycle - leftLifecycle;

    const leftStartsAt = left.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightStartsAt = right.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (leftStartsAt !== rightStartsAt) return rightStartsAt - leftStartsAt;

    const leftCreatedAt = left.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightCreatedAt = right.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return rightCreatedAt - leftCreatedAt;
  });

  return String(sortedRows[0]?.rosterRoleId ?? "").trim() || null;
}

function buildFwaBaseSwapBattleDayReminderLogContent(input: {
  clanName: string;
  clanTag: string;
  targetChannelId: string | null;
  reminderMessageUrl: string;
  referenceId: string;
  clanRoleMentionIncluded: boolean;
}): string {
  const targetChannelId = String(input.targetChannelId ?? "").trim();
  return [
    "FWA base-swap battle-day reminder sent",
    `/fwa base-swap reminder tied to ${input.clanName} (#${input.clanTag})`,
    `Target channel: ${targetChannelId ? `<#${targetChannelId}>` : "unknown"}`,
    `Reminder message link: ${input.reminderMessageUrl}`,
    `Base-swap reference id: ${input.referenceId}`,
    `Clan role ping included: ${input.clanRoleMentionIncluded ? "yes" : "no"}`,
  ].join("\n");
}

export const buildFwaBaseSwapBattleDayReminderLogContentForTest =
  buildFwaBaseSwapBattleDayReminderLogContent;

async function resolveTrackedClanMailChannelIdByTag(
  clanTag: string,
): Promise<string | null> {
  const inputClanTag = String(clanTag ?? "").trim();
  if (!inputClanTag) return null;

  const rows = await prisma
    .$queryRaw<Array<{ mailChannelId: string | null }>>(Prisma.sql`
      SELECT tc."mailChannelId"
      FROM "TrackedClan" tc
      WHERE UPPER(REPLACE(tc."tag", '#', '')) = UPPER(REPLACE(${inputClanTag}, '#', ''))
      LIMIT 1
    `)
    .catch(() => []);
  const mailChannelId = String(rows[0]?.mailChannelId ?? "").trim();
  return mailChannelId || null;
}

function isTextSendableChannel(
  channel: unknown,
): channel is { isTextBased: () => boolean; send: (payload: unknown) => Promise<unknown> } {
  return Boolean(channel) &&
    typeof (channel as { isTextBased?: unknown }).isTextBased === "function" &&
    (channel as { isTextBased: () => boolean }).isTextBased() === true &&
    typeof (channel as { send?: unknown }).send === "function";
}

/** Purpose: resolve configured bot-log destination channel for the current guild, clearing stale ids. */
async function resolveBotLogChannel(
  client: Client,
  guildId: string | null,
  botLogChannelService: BotLogChannelService,
): Promise<{ send: (payload: { content: string }) => Promise<unknown> } | null> {
  if (!guildId) return null;

  const configuredChannelId = await botLogChannelService.getChannelId(guildId);
  if (!configuredChannelId) return null;

  let fetchedChannel: unknown;
  try {
    fetchedChannel = await client.channels.fetch(configuredChannelId);
  } catch (error) {
    const code = (error as { code?: number } | null | undefined)?.code;
    if (code === 10003) {
      await botLogChannelService.clearChannelId(guildId);
    }
    return null;
  }

  if (!fetchedChannel) {
    await botLogChannelService.clearChannelId(guildId);
    return null;
  }

  const logChannel = fetchedChannel as {
    guildId?: string;
    isTextBased?: () => boolean;
    send?: (payload: { content: string }) => Promise<unknown>;
  };

  const logGuildId = String(logChannel.guildId ?? "").trim();
  if (!logGuildId || logGuildId !== guildId) {
    await botLogChannelService.clearChannelId(guildId);
    return null;
  }
  if (typeof logChannel.isTextBased !== "function" || !logChannel.isTextBased()) {
    return null;
  }
  if (typeof logChannel.send !== "function") {
    return null;
  }

  return { send: logChannel.send.bind(logChannel) };
}

/** Purpose: normalize and persist discrepancy fingerprint data on tracked notify rows. */
function parseWarEndDiscrepancyFingerprint(
  configHash: string | null | undefined,
): string | null {
  const raw = String(configHash ?? "");
  const match = raw.match(
    new RegExp(`(?:^|\\|)${WAR_END_DISCREPANCY_MARKER}:([^|]+)$`),
  );
  return match?.[1] ? match[1] : null;
}

/** Purpose: write discrepancy fingerprint while preserving the existing notify config hash payload. */
function writeWarEndDiscrepancyFingerprint(
  configHash: string | null | undefined,
  fingerprint: string,
): string {
  const raw = String(configHash ?? "");
  const stripped = raw.replace(
    new RegExp(`(?:^|\\|)${WAR_END_DISCREPANCY_MARKER}:[^|]+$`),
    "",
  );
  if (!stripped) return `${WAR_END_DISCREPANCY_MARKER}:${fingerprint}`;
  return `${stripped}|${WAR_END_DISCREPANCY_MARKER}:${fingerprint}`;
}

/** Purpose: build canonical mismatch fingerprint for idempotent war-end discrepancy alerts. */
function buildWarEndDiscrepancyFingerprint(
  warId: number,
  expectedPoints: number,
  actualPoints: number,
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
}): {
  content: string;
  allowedMentions: { parse: [] };
} {
  const existingMentionRoleId = extractPostedNotifyMentionRoleId(
    params.existingPostedContent,
  );
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
  return {
    content: [baseContent, ...warningLines].join("\n"),
    allowedMentions: { parse: [] },
  };
}

export const buildWarEndDiscrepancyContentForTest =
  buildWarEndDiscrepancyContent;
export const buildWarEndDiscrepancyFingerprintForTest =
  buildWarEndDiscrepancyFingerprint;

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
  syncNumber: number | null;
  syncNum: number | null;
  updatedAt: Date;
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
  pendingEventType: string | null;
  pendingEventTargetState: string | null;
  state: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
  clanRoleId: string | null;
  pointsConfirmedByClanMail: boolean | null;
  pointsNeedsValidation: boolean | null;
  pointsLastSuccessfulFetchAt: Date | null;
  pointsSyncNum: number | null;
  pointsLastKnownSyncNumber: number | null;
  pointsLastKnownPoints: number | null;
  pointsLastKnownMatchType: string | null;
  pointsLastKnownOutcome: string | null;
  pointsWarId: string | null;
  pointsOpponentTag: string | null;
  pointsWarStartTime: Date | null;
};

type PendingCurrentWarEventType = Extract<EventType, "war_started" | "battle_day">;
const WAR_EVENT_RESERVATION_LEASE_MS = 5 * 60 * 1000;

type EventDeliveryReservation =
  | {
      state: "delivered_existing";
      existingMessage: {
        channelId: string;
        messageId: string;
      };
      warId: string;
    }
  | {
      state: "claimed";
      warId: string;
      guardCreatedAt: Date;
    }
  | {
      state: "in_flight";
      warId: string | null;
      reason: string;
    }
  | {
      state: "unavailable";
      warId: string | null;
      reason: string;
    };

type EventDispatchResult =
  | {
      state: "delivered_new";
      warId: string | null;
      guardCreatedAt: Date | null;
    }
  | {
      state: "delivered_existing";
      warId: string | null;
      existingMessage: {
        channelId: string;
        messageId: string;
      };
    }
  | {
      state: "intentionally_suppressed";
      warId: string | null;
      reason: string;
    }
  | {
      state: "in_flight";
      warId: string | null;
      reason: string;
    }
  | {
      state: "unavailable";
      warId: string | null;
      reason: string;
    }
  | {
      state: "failed";
      warId: string | null;
      reason: string;
    };

function isPendingCurrentWarEventType(
  input: string | null | undefined,
): input is PendingCurrentWarEventType {
  return input === "war_started" || input === "battle_day";
}

function pendingCurrentWarTargetStateForEvent(
  eventType: PendingCurrentWarEventType,
): WarState {
  return eventType === "war_started" ? "preparation" : "inWar";
}

function isEventDeliveryCleanupSuccess(
  result: EventDispatchResult | boolean | null | undefined,
): boolean {
  if (typeof result === "boolean") {
    return result;
  }
  if (!result) {
    return false;
  }
  return (
    result.state === "delivered_new" ||
    result.state === "delivered_existing" ||
    result.state === "intentionally_suppressed"
  );
}

function getWarEventReservationLeaseExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + WAR_EVENT_RESERVATION_LEASE_MS);
}

function isWarEventReservationExpired(
  createdAt: Date,
  now = new Date(),
): boolean {
  return now.getTime() >= getWarEventReservationLeaseExpiresAt(createdAt).getTime();
}

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
  resolveActiveSyncNumber?: (
    input: ActiveWarSyncResolutionInput,
  ) => Promise<ActiveWarSyncAssignmentResult>;
};

type ActiveWarSyncResolutionInput = {
  guildId: string;
  clanTag: string;
  warState: WarState;
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string | null;
  expectedCurrentWarRevisionAt: Date | null;
  currentWarCanonicalSyncNumber: number | null;
  currentWarLegacySyncNumber: number | null;
  sameWarPointsSyncNumber: number | null;
  matchType: string | null;
  inferredMatchType: boolean | null;
  allowAllocation?: boolean;
  pollCycle?: {
    activeSyncNumber: number | null;
    recordActiveSyncNumber: (syncNumber: number) => void;
  };
};

type ReconciliationRelease = () => void;
type ReconciliationMode = "global" | "targeted";
type ReconciliationOutcome = {
  status: "resolved" | "failed";
  error: unknown | null;
};
type ReconciliationObservationState =
  | "idle"
  | "global_active"
  | "global_queued"
  | "targeted_active";
type ReconciliationObservedRun = {
  completion: Promise<ReconciliationOutcome>;
};
type ReconciliationObservedRunHandle = {
  run: ReconciliationObservedRun;
  settle: (outcome: ReconciliationOutcome) => void;
};
export type ReconciliationCoordinatorSnapshot = {
  activeMode: ReconciliationMode | null;
  globalQueueLength: number;
  observedState: ReconciliationObservationState;
  observedRun: ReconciliationObservedRun | null;
};
type TargetedReconciliationResult<T> =
  | {
      acquired: true;
      value: T;
    }
  | {
      acquired: false;
      observation: ReconciliationCoordinatorSnapshot;
    };
type ReconciliationWaitResult =
  | {
      kind: "completed";
      observedState: Exclude<ReconciliationObservationState, "idle" | "targeted_active">;
      waitedMs: number;
      outcome: ReconciliationOutcome;
    }
  | {
      kind: "timeout";
      observedState: Exclude<ReconciliationObservationState, "idle" | "targeted_active">;
      waitedMs: number;
    }
  | {
      kind: "no_active_run";
      observedState: ReconciliationObservationState;
    };

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Purpose: coordinate active and scheduled war reconciliation work within one Node process. */
class WarReconciliationCoordinator {
  private activeMode: ReconciliationMode | null = null;
  private activeGlobalRun: ReconciliationObservedRun | null = null;
  private readonly globalWaiters: Array<{
    resolve: (release: ReconciliationRelease) => void;
    run: ReconciliationObservedRun;
    settle: (outcome: ReconciliationOutcome) => void;
  }> = [];

  /** Purpose: run one global reconciliation at a time while waiting for any active targeted reconciliation. */
  async runGlobal<T>(work: () => Promise<T>): Promise<T> {
    const observed = this.createObservedRun();
    const release = await this.acquireGlobal(observed);
    const releaseOnce = (() => {
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        release();
      };
    })();
    try {
      const value = await work();
      releaseOnce();
      observed.settle({ status: "resolved", error: null });
      return value;
    } catch (error) {
      releaseOnce();
      observed.settle({ status: "failed", error });
      throw error;
    }
  }

  /** Purpose: attempt targeted reconciliation once and skip immediately if any reconciliation is already active or queued. */
  async runTargeted<T>(work: () => Promise<T>): Promise<
    TargetedReconciliationResult<T>
  > {
    const release = this.tryAcquireTargeted();
    if (!release) {
      return {
        acquired: false,
        observation: this.getSnapshot(),
      };
    }

    try {
      return { acquired: true, value: await work() };
    } finally {
      release();
    }
  }

  /** Purpose: queue a global reconciliation until the coordinator becomes free. */
  private acquireGlobal(
    observed: ReconciliationObservedRunHandle,
  ): Promise<ReconciliationRelease> {
    return new Promise((resolve) => {
      if (this.activeMode === null && this.globalWaiters.length === 0) {
        this.activeMode = "global";
        this.activeGlobalRun = observed.run;
        resolve(this.createRelease());
        return;
      }

      this.globalWaiters.push({
        resolve,
        run: observed.run,
        settle: observed.settle,
      });
    });
  }

  /** Purpose: grab the coordinator only when no reconciliation is active or already waiting. */
  private tryAcquireTargeted(): ReconciliationRelease | null {
    if (this.activeMode !== null || this.globalWaiters.length > 0) {
      return null;
    }

    this.activeMode = "targeted";
    this.activeGlobalRun = null;
    return this.createRelease();
  }

  /** Purpose: create a completion promise for one observed global reconciliation run. */
  private createObservedRun(): ReconciliationObservedRunHandle {
    const deferred = createDeferred<ReconciliationOutcome>();
    return {
      run: {
        completion: deferred.promise,
      },
      settle: deferred.resolve,
    };
  }

  /** Purpose: release the current reconciliation and hand the coordinator to the next queued global run. */
  private createRelease(): ReconciliationRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.globalWaiters.shift();
      if (next) {
        this.activeMode = "global";
        this.activeGlobalRun = next.run;
        next.resolve(this.createRelease());
        return;
      }

      this.activeMode = null;
      this.activeGlobalRun = null;
    };
  }

  /** Purpose: expose one bounded snapshot of the shared reconciliation coordinator for waiters. */
  getSnapshot(): ReconciliationCoordinatorSnapshot {
    if (this.activeMode === "global" && this.activeGlobalRun) {
      return {
        activeMode: "global",
        globalQueueLength: this.globalWaiters.length,
        observedState: "global_active",
        observedRun: this.activeGlobalRun,
      };
    }
    if (this.globalWaiters.length > 0) {
      return {
        activeMode: this.activeMode,
        globalQueueLength: this.globalWaiters.length,
        observedState: "global_queued",
        observedRun: this.globalWaiters[0]?.run ?? null,
      };
    }
    if (this.activeMode === "targeted") {
      return {
        activeMode: "targeted",
        globalQueueLength: 0,
        observedState: "targeted_active",
        observedRun: null,
      };
    }
    return {
      activeMode: null,
      globalQueueLength: 0,
      observedState: "idle",
      observedRun: null,
    };
  }

  /** Purpose: clear coordinator state for isolated tests. */
  resetForTest(): void {
    this.activeMode = null;
    this.activeGlobalRun = null;
    this.globalWaiters.length = 0;
  }
}

const reconciliationCoordinator = new WarReconciliationCoordinator();

/** Purpose: clear the module-scoped reconciliation coordinator between isolated tests. */
export const resetWarReconciliationCoordinatorForTest = (): void => {
  reconciliationCoordinator.resetForTest();
};

/** Purpose: observe the current shared war-reconciliation ownership state without mutating it. */
export const getWarReconciliationCoordinatorState = (): ReconciliationCoordinatorSnapshot =>
  reconciliationCoordinator.getSnapshot();

/** Purpose: wait for one observed reconciliation run to release ownership without stealing it. */
export async function waitForObservedWarReconciliation(
  observation: ReconciliationCoordinatorSnapshot,
  timeoutMs: number,
): Promise<ReconciliationWaitResult> {
  if (!observation.observedRun) {
    return {
      kind: "no_active_run",
      observedState: observation.observedState,
    };
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      const maybeTimer = timer as { unref?: () => void } | null;
      if (maybeTimer && typeof maybeTimer.unref === "function") {
        maybeTimer.unref();
      }
    });

    const outcome = await Promise.race([
      observation.observedRun.completion,
      timeoutPromise,
    ]);
    if (outcome === "timeout") {
      const observedState =
        observation.observedState as Exclude<
          ReconciliationObservationState,
          "idle" | "targeted_active"
        >;
      return {
        kind: "timeout",
        observedState,
        waitedMs: Date.now() - startedAt,
      };
    }

    const observedState =
      observation.observedState as Exclude<
        ReconciliationObservationState,
        "idle" | "targeted_active"
      >;
    return {
      kind: "completed",
      observedState,
      waitedMs: Date.now() - startedAt,
      outcome,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export type WarEventPollClanResult = {
  processed: boolean;
  warEnded: boolean;
  skippedReason?: "reconciliation_in_flight";
  reason?: "coordinator_busy" | "invalid_input" | "subscription_missing";
  coordinatorObservation?: ReconciliationCoordinatorSnapshot;
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
  fallbackDate: Date,
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

function sortWarComplianceIssuesByPosition(
  issues: WarComplianceIssue[],
): WarComplianceIssue[] {
  return [...issues].sort((a, b) => {
    const posA = Number.isFinite(Number(a.playerPosition))
      ? Number(a.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    const posB = Number.isFinite(Number(b.playerPosition))
      ? Number(b.playerPosition)
      : Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    const nameA =
      String(a.playerName ?? "").trim() || String(a.playerTag ?? "").trim();
    const nameB =
      String(b.playerName ?? "").trim() || String(b.playerTag ?? "").trim();
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
  return extra > 0
    ? `${capped.join("\n")}\n(+${extra} more)`
    : capped.join("\n");
}

function withNotifyComplianceEmptyState(
  embed: EmbedBuilder,
  hasViolations: boolean,
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
          : field,
      )
    : json.fields;
  return EmbedBuilder.from({
    ...json,
    fields,
  });
}

function toNotifyWarEndedViewToken(
  input: string,
): NotifyWarEndedViewToken | null {
  if (input === "s" || input === "c") return input;
  return null;
}

export function buildNotifyWarEndedViewCustomId(
  input: NotifyWarEndedViewCustomIdInput,
): string {
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
  customId: string,
): ParsedNotifyWarEndedViewCustomId | null {
  const [
    prefix,
    viewRaw,
    guildId,
    clanTagBare,
    warIdRaw,
    messageId,
    timestampRaw,
    pageRaw,
  ] = String(customId ?? "").split(":");
  if (prefix !== NOTIFY_WAR_ENDED_VIEW_PREFIX) return null;
  const view = toNotifyWarEndedViewToken(viewRaw);
  if (!view) return null;
  if (!/^\d{5,}$/.test(guildId ?? "")) return null;
  if (!/^[A-Z0-9]+$/i.test(clanTagBare ?? "")) return null;
  if (!/^\d{5,}$/.test(messageId ?? "")) return null;
  const warId = Number(warIdRaw);
  if (!Number.isFinite(warId) || Math.trunc(warId) <= 0) return null;
  const timestampUnix = Number(timestampRaw);
  if (!Number.isFinite(timestampUnix) || Math.trunc(timestampUnix) <= 0)
    return null;
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
  for (
    let memberIndex = 0;
    memberIndex < input.ownMembers.length;
    memberIndex += 1
  ) {
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
      const defender = defenderTag
        ? (opponentByTag.get(defenderTag) ?? null)
        : null;
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
  pointsNeedsValidation?: boolean | null;
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
  nextWarStartTime: Date | null,
): boolean {
  if (
    !(nextWarStartTime instanceof Date) ||
    Number.isNaN(nextWarStartTime.getTime())
  )
    return false;
  if (
    !(previousWarStartTime instanceof Date) ||
    Number.isNaN(previousWarStartTime.getTime())
  )
    return true;
  return nextWarStartTime.getTime() !== previousWarStartTime.getTime();
}

function deriveResultLabelFromStars(
  clanStars: number | null,
  opponentStars: number | null,
): "WIN" | "LOSE" | "TIE" | "UNKNOWN" {
  if (clanStars === null || opponentStars === null) return "UNKNOWN";
  if (clanStars > opponentStars) return "WIN";
  if (clanStars < opponentStars) return "LOSE";
  return "TIE";
}

function formatResultLabelForEmbed(
  result: "WIN" | "LOSE" | "TIE" | "UNKNOWN",
): "WIN" | "LOSS" | "DRAW" | "UNKNOWN" {
  if (result === "WIN") return "WIN";
  if (result === "LOSE") return "LOSS";
  if (result === "TIE") return "DRAW";
  return "UNKNOWN";
}

function makeBattleDayPostKey(guildId: string, clanTag: string): string {
  return `${guildId}:${normalizeTag(clanTag)}`;
}

function toValidSyncNumber(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

/** Purpose: normalize optional war identifiers for same-war confirmation checks. */
function toValidWarIdText(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? String(normalized) : null;
}

/** Purpose: keep confirmed clan-mail protection scoped to the exact same current-war identity. */
function hasSameWarConfirmedMailBaseline(input: {
  sub: SubscriptionRow;
  effectiveWarIdentityChanged: boolean;
}): boolean {
  if (input.effectiveWarIdentityChanged) return false;
  if (!input.sub.pointsConfirmedByClanMail) return false;
  if (!input.sub.startTime || !input.sub.pointsWarStartTime) return false;
  if (
    input.sub.startTime.getTime() !== input.sub.pointsWarStartTime.getTime()
  ) {
    return false;
  }
  const currentWarId = toValidWarIdText(input.sub.warId);
  const pointsWarId = toValidWarIdText(input.sub.pointsWarId);
  if (currentWarId && pointsWarId && currentWarId !== pointsWarId) {
    return false;
  }
  const currentOpponentTag = normalizeTag(input.sub.opponentTag ?? "");
  const pointsOpponentTag = normalizeTag(input.sub.pointsOpponentTag ?? "");
  if (
    currentOpponentTag &&
    pointsOpponentTag &&
    currentOpponentTag !== pointsOpponentTag
  ) {
    return false;
  }
  return true;
}

type ExactSameWarPointsSyncRejectionReason =
  | "identity_incomplete"
  | "start_mismatch"
  | "opponent_mismatch"
  | "war_id_mismatch";

function logRejectedExactSameWarPointsSync(input: {
  guildId?: string | null;
  clanTag?: string | null;
  reason: ExactSameWarPointsSyncRejectionReason;
  pointsWarId: string | number | null | undefined;
  pointsWarStartTime: Date | null | undefined;
  pointsOpponentTag: string | null | undefined;
  pointsSyncNumber: number | null | undefined;
  intendedWarId: string | number | null | undefined;
  intendedWarStartTime: Date | null | undefined;
  intendedOpponentTag: string | null | undefined;
}): void {
  const line =
    `[war-events] event=active_war_points_identity result=rejected reason=${input.reason}` +
    ` guild=${String(input.guildId ?? "none")}` +
    ` clan=${String(input.clanTag ?? "none")}` +
    ` points_war_id=${toValidWarIdText(input.pointsWarId) ?? "none"}` +
    ` points_war_start=${input.pointsWarStartTime?.toISOString() ?? "none"}` +
    ` points_opponent=${normalizeTag(input.pointsOpponentTag ?? "") ?? "none"}` +
    ` points_sync=${toValidSyncNumber(input.pointsSyncNumber) ?? "none"}` +
    ` intended_war_id=${toValidWarIdText(input.intendedWarId) ?? "none"}` +
    ` intended_war_start=${input.intendedWarStartTime?.toISOString() ?? "none"}` +
    ` intended_opponent=${normalizeTag(input.intendedOpponentTag ?? "") ?? "none"}`;
  if (input.reason === "war_id_mismatch") {
    console.warn(line);
    return;
  }
  console.debug(line);
}

function resolveExactSameWarPointsSyncNumber(input: {
  guildId?: string | null;
  clanTag?: string | null;
  pointsWarId: string | number | null | undefined;
  pointsWarStartTime: Date | null | undefined;
  pointsOpponentTag: string | null | undefined;
  pointsSyncNumber: number | null | undefined;
  intendedWarId: string | number | null | undefined;
  intendedWarStartTime: Date | null | undefined;
  intendedOpponentTag: string | null | undefined;
}): number | null {
  const pointsSyncNumber = toValidSyncNumber(input.pointsSyncNumber);
  if (pointsSyncNumber === null) {
    return null;
  }
  const pointsWarStartTime =
    input.pointsWarStartTime instanceof Date &&
    Number.isFinite(input.pointsWarStartTime.getTime())
      ? input.pointsWarStartTime
      : null;
  const intendedWarStartTime =
    input.intendedWarStartTime instanceof Date &&
    Number.isFinite(input.intendedWarStartTime.getTime())
      ? input.intendedWarStartTime
      : null;
  const pointsOpponentTag = normalizeTag(input.pointsOpponentTag ?? null);
  const intendedOpponentTag = normalizeTag(input.intendedOpponentTag ?? null);
  if (
    !pointsWarStartTime ||
    !intendedWarStartTime ||
    !pointsOpponentTag ||
    !intendedOpponentTag
  ) {
    logRejectedExactSameWarPointsSync({
      ...input,
      reason: "identity_incomplete",
    });
    return null;
  }
  if (pointsWarStartTime.getTime() !== intendedWarStartTime.getTime()) {
    logRejectedExactSameWarPointsSync({
      ...input,
      pointsWarStartTime,
      intendedWarStartTime,
      pointsOpponentTag,
      intendedOpponentTag,
      reason: "start_mismatch",
    });
    return null;
  }
  if (pointsOpponentTag !== intendedOpponentTag) {
    logRejectedExactSameWarPointsSync({
      ...input,
      pointsWarStartTime,
      intendedWarStartTime,
      pointsOpponentTag,
      intendedOpponentTag,
      reason: "opponent_mismatch",
    });
    return null;
  }
  const pointsWarId = toValidWarIdText(input.pointsWarId);
  const intendedWarId = toValidWarIdText(input.intendedWarId);
  if (pointsWarId && intendedWarId && pointsWarId !== intendedWarId) {
    logRejectedExactSameWarPointsSync({
      ...input,
      pointsWarStartTime,
      intendedWarStartTime,
      pointsOpponentTag,
      intendedOpponentTag,
      reason: "war_id_mismatch",
    });
    return null;
  }
  return pointsSyncNumber;
}

function resolveEventRenderSyncNumber(input: {
  identity: ReturnType<typeof buildActiveWarSyncIdentity>;
  sameWarSyncNumber: number | null;
  postedSyncNumber: number | null;
  latestPersistedSyncNumber: number | null;
  allowPostedSyncReuse?: boolean;
}): number | null {
  return resolveActiveWarSyncNumber({
    identity: input.identity,
    latestPersistedSyncNumber: input.latestPersistedSyncNumber,
    sameWarPersistedSyncNumber: input.sameWarSyncNumber,
    postedSyncNumber: input.postedSyncNumber,
    allowPostedSyncReuse: input.allowPostedSyncReuse,
  }).syncNumber;
}

export const resolveEventRenderSyncNumberForTest = resolveEventRenderSyncNumber;
export const resolveExactSameWarPointsSyncNumberForTest =
  resolveExactSameWarPointsSyncNumber;

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
  const attacksLeftText =
    totalAttacks > 0 ? `${attacksLeft}/${totalAttacks}` : `${attacksLeft}/?`;
  const attacksRightText =
    totalAttacks > 0 ? `${attacksRight}/${totalAttacks}` : `${attacksRight}/?`;
  return [
    "War Stats",
    formatWarStatLine(starsLeft, ":star:", starsRight),
    formatWarStatLine(attacksLeftText, ":crossed_swords:", attacksRightText),
    formatWarStatLine(
      formatWarPercent(stats.clanDestruction),
      ":boom:",
      formatWarPercent(stats.opponentDestruction),
    ),
  ];
}

export const sanitizeWarPlanForEmbedForTest = sanitizeWarPlanForEmbed;

/** Purpose: extract a numeric HTTP status code from CoC API errors. */
function parseCocApiStatusCode(error: unknown): number | null {
  const responseStatus = Number(
    (error as { response?: { status?: unknown } } | null | undefined)?.response
      ?.status,
  );
  if (
    Number.isFinite(responseStatus) &&
    responseStatus >= 100 &&
    responseStatus <= 599
  ) {
    return Math.trunc(responseStatus);
  }
  const message = String(
    (error as { message?: unknown } | null | undefined)?.message ?? "",
  );
  const match = message.match(/CoC API error (\d{3})/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** Purpose: advance outage suspicion state from the latest CoC poll observation. */
function advanceCocWarOutageState(
  previous: CocWarOutageState | null,
  observation: CocWarFetchObservation,
  now: Date,
): CocWarOutageState {
  const base: CocWarOutageState = previous ?? {
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
      suspected:
        base.suspected || failureStreak >= COC_WAR_OUTAGE_FAILURE_THRESHOLD,
      lastFailureStatusCode: observation.statusCode,
      updatedAt: now,
    };
  }

  const recoveryStreak = base.recoveryStreak + 1;
  return {
    failureStreak: 0,
    recoveryStreak,
    suspected:
      base.suspected && recoveryStreak < COC_WAR_OUTAGE_RECOVERY_THRESHOLD,
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
    warStartTime.getTime() === input.previousWarStartTime.getTime(),
  );
  const warEndTime =
    input.observedWarEndTime ??
    (sameWarIdentity ? (input.previousWarEndTime ?? null) : null);
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

  const knownEndMs =
    input.knownWarEndTime instanceof Date
      ? input.knownWarEndTime.getTime()
      : NaN;
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

function isActiveWarState(state: WarState): boolean {
  return state === "preparation" || state === "inWar";
}

/** Purpose: decide whether the prior active phase should still be running based on last known war timing. */
function isWarPhaseExpectedActive(input: {
  state: WarState;
  knownWarStartTime: Date | null;
  knownWarEndTime: Date | null;
  now: Date;
}): boolean {
  if (!isActiveWarState(input.state)) return false;
  const nowMs = input.now.getTime();
  const knownStartMs =
    input.knownWarStartTime instanceof Date
      ? input.knownWarStartTime.getTime()
      : NaN;
  const knownEndMs =
    input.knownWarEndTime instanceof Date
      ? input.knownWarEndTime.getTime()
      : NaN;

  if (input.state === "preparation" && Number.isFinite(knownStartMs)) {
    return nowMs < knownStartMs;
  }
  if (input.state === "inWar" && Number.isFinite(knownEndMs)) {
    return nowMs < knownEndMs;
  }
  if (Number.isFinite(knownEndMs)) {
    return nowMs < knownEndMs;
  }
  return true;
}

/** Purpose: preserve active-war identity when outage recovery only changes timestamps but not lifecycle phase. */
function shouldPreserveWarIdentityDuringOutageRecovery(input: {
  previousState: WarState;
  candidateState: WarState;
  previousWarStartTime: Date | null;
  previousWarEndTime: Date | null;
  warIdentityChanged: boolean;
  eventDerivedFromIdentityShift: boolean;
  warFetchFailed: boolean;
  maintenanceSuspected: boolean;
  now: Date;
}): boolean {
  if (input.warFetchFailed) return false;
  if (!input.maintenanceSuspected) return false;
  if (!input.warIdentityChanged) return false;
  if (!input.eventDerivedFromIdentityShift) return false;
  if (!isActiveWarState(input.previousState)) return false;
  if (!isActiveWarState(input.candidateState)) return false;

  return isWarPhaseExpectedActive({
    state: input.previousState,
    knownWarStartTime: input.previousWarStartTime,
    knownWarEndTime: input.previousWarEndTime,
    now: input.now,
  });
}

type CurrentWarIdentityCompletionState =
  | "saved"
  | "idempotent"
  | "conflict"
  | "identity_changed"
  | "not_needed";

type CurrentWarIdentityCompletionResult = {
  state: CurrentWarIdentityCompletionState;
  warId: number | null;
  persistedRevisionAt: Date | null;
};

/** Purpose: emit one bounded structured event for active CurrentWar identity completion. */
function logCurrentWarIdentityCompletion(input: {
  result: Exclude<CurrentWarIdentityCompletionState, "not_needed">;
  guildId: string;
  clanTag: string;
  dbClanTag: string;
  dbOpponentTag: string | null;
  warId: number | null;
  warStartTime: Date | null;
  expectedRevisionAt: Date | null;
  persistedRevisionAt: Date | null;
}): void {
  const line =
    `[war-events] event=current_war_identity_completion result=${input.result}` +
    ` guild=${input.guildId}` +
    ` clan=#${normalizeTagBare(input.clanTag) ?? "unknown"}` +
    ` db_clan_tag=${input.dbClanTag}` +
    ` db_opponent_tag=${input.dbOpponentTag ?? "none"}` +
    ` war_id=${input.warId ?? "none"}` +
    ` war_start=${input.warStartTime?.toISOString() ?? "none"}` +
    ` opponent=${input.dbOpponentTag ?? "none"}` +
    ` expected_revision=${input.expectedRevisionAt?.toISOString() ?? "none"}` +
    ` persisted_revision=${input.persistedRevisionAt?.toISOString() ?? "none"}`;
  if (input.result === "conflict" || input.result === "identity_changed") {
    console.warn(line);
    return;
  }
  console.info(line);
}

export const advanceCocWarOutageStateForTest = advanceCocWarOutageState;
export const resolveActiveWarTimingForTest = resolveActiveWarTiming;
export const applyWarEndedMaintenanceGuardForTest =
  applyWarEndedMaintenanceGuard;
export const isWarPhaseExpectedActiveForTest = isWarPhaseExpectedActive;
export const shouldPreserveWarIdentityDuringOutageRecoveryForTest =
  shouldPreserveWarIdentityDuringOutageRecovery;
export const computeWarSnapshotAttackRowsForTest = computeWarSnapshotAttackRows;

export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly pointsGate: PointsDirectFetchGateService;
  private readonly pointsSync: WarStartPointsSyncService;
  private readonly currentSyncs: PointsSyncService;
  private readonly syncResolution: ActiveWarSyncResolutionService;
  private readonly commandPermissions: CommandPermissionService;
  private readonly history: WarEventHistoryService;
  private readonly warCompliance: WarComplianceService;
  private readonly warPlanViolations: WarPlanViolationService;
  private readonly fwaPolice: FwaPoliceService;
  private readonly postedMessages: PostedMessageService;
  private readonly botLogChannels = new BotLogChannelService();
  private readonly maintenanceWindowService: MaintenanceWindowService;
  private readonly cocWarOutageByClanTag = new Map<string, CocWarOutageState>();

  /** Purpose: initialize service dependencies. */
  constructor(
    private readonly client: Client,
    private readonly coc: CoCService,
  ) {
    this.points = new PointsProjectionService(coc);
    this.pointsGate = new PointsDirectFetchGateService();
    this.pointsSync = new WarStartPointsSyncService(
      this.points,
      new SettingsService(),
    );
    this.currentSyncs = new PointsSyncService();
    this.syncResolution = new ActiveWarSyncResolutionService(this.currentSyncs);
    this.commandPermissions = new CommandPermissionService();
    this.warCompliance = new WarComplianceService();
    this.warPlanViolations = new WarPlanViolationService(this.warCompliance);
    this.history = new WarEventHistoryService(
      coc,
      this.currentSyncs,
      this.warCompliance,
      this.warPlanViolations,
    );
    this.fwaPolice = new FwaPoliceService();
    this.postedMessages = new PostedMessageService();
    this.maintenanceWindowService = new MaintenanceWindowService(
      client,
      this.botLogChannels,
    );
  }

  /** Purpose: poll. */
  async poll(input?: {
    sendBattleDaySwapReminders?: boolean;
    currentWarSnapshotCycleContext?: CurrentWarSnapshotCycleContext;
  }): Promise<void> {
    await reconciliationCoordinator.runGlobal(async () => {
      const sendBattleDaySwapReminders =
        input?.sendBattleDaySwapReminders === true;
      const syncContext = await this.buildPollSyncContext();
      const targets = await this.listPollTargets();
      const maintenanceOverGuildIds = new Set<string>();
      for (const target of targets) {
        await this.ensureCurrentWarBaseline(target);
        await this.processSubscription(
          target.guildId,
          target.clanTag,
          syncContext,
          {
            sendBattleDaySwapReminders,
            maintenanceOverGuildIds,
            currentWarSnapshotCycleContext: input?.currentWarSnapshotCycleContext ?? null,
          },
        ).catch((err) => {
          console.error(
            `[war-events] process failed guild=${target.guildId} clan=${target.clanTag} error=${formatError(
              err,
            )}`,
          );
        });
      }
      for (const guildId of maintenanceOverGuildIds) {
        await fireBattleDayTransitionWar24hRemindersForGuild({
          client: this.client,
          guildId,
          nowMs: Date.now(),
          triggerSource: "maintenance_over",
        }).catch((err) => {
          console.error(
            `[reminders] battle_day_maintenance_over_failed guild=${guildId} trigger=maintenance_over error=${formatError(err)}`,
          );
        });
      }

      await this.warPlanViolations
        .reconcileDueEvaluations({ limit: 20 })
        .catch((err) => {
          console.error(
            `[war-plan-violation] event=reconcile_failed error=${formatError(err)}`,
          );
        });
    });
  }

  /** Purpose: derive the shared poll sync context without widening the global poll loop. */
  private async buildPollSyncContext(): Promise<PollSyncContext> {
    const previousSync = await this.syncResolution.getLatestPersistedSyncBaseline();
    let activeSync: number | null = null;
    let pollCycle: ActiveWarSyncResolutionInput["pollCycle"] = {
      activeSyncNumber: activeSync,
      recordActiveSyncNumber: (syncNumber: number) => {
        if (Number.isFinite(syncNumber) && syncNumber > 0) {
          activeSync = Math.trunc(syncNumber);
          if (pollCycle) pollCycle.activeSyncNumber = activeSync;
        }
      },
    };
    return {
      previousSync,
      get activeSync() {
        return activeSync;
      },
      resolveActiveSyncNumber: async (input: ActiveWarSyncResolutionInput) => {
        pollCycle.activeSyncNumber = activeSync;
        const resolution = await this.syncResolution.resolveOrAllocateActiveSyncNumber({
          guildId: input.guildId,
          clanTag: input.clanTag,
          identity: buildActiveWarSyncIdentity({
            warState: input.warState,
            warId: input.warId,
            warStartTime: input.warStartTime,
            opponentTag: input.opponentTag,
          }),
          expectedCurrentWarRevisionAt: input.expectedCurrentWarRevisionAt,
          currentWarSyncNumber: input.currentWarCanonicalSyncNumber,
          currentWarLegacySyncNumber: input.currentWarLegacySyncNumber,
          sameWarPointsSyncNumber: input.sameWarPointsSyncNumber,
          matchType: input.matchType,
          inferredMatchType: input.inferredMatchType,
          allowAllocation: input.allowAllocation,
          pollCycle,
        });
        activeSync = pollCycle.activeSyncNumber;
        return resolution;
      },
    };
  }

  /** Purpose: reconcile one tracked clan through the authoritative poll worker. */
  async pollClan(input: {
    guildId: string;
    clanTag: string;
    sendBattleDaySwapReminders?: boolean;
  }): Promise<WarEventPollClanResult> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeTag(input.clanTag);
    if (!guildId || !clanTag) {
      return {
        processed: false,
        warEnded: false,
        reason: "invalid_input",
      };
    }

    const targeted = await reconciliationCoordinator.runTargeted(
      async (): Promise<WarEventPollClanResult> => {
      const subscription = await this.findSubscriptionByGuildAndTag(
        guildId,
        clanTag,
      );
      if (!subscription) {
        return {
          processed: false,
          warEnded: false,
          reason: "subscription_missing",
        };
      }

      const syncContext = await this.buildPollSyncContext();
      const warEnded = await this.processSubscription(
        guildId,
        clanTag,
        syncContext,
        {
          sendBattleDaySwapReminders:
            input.sendBattleDaySwapReminders === true,
        },
      );

      return { processed: true, warEnded };
      },
    );

    if (!targeted.acquired) {
      console.warn(
        `[war-events] event=reconciliation_skipped source=poll_clan reason=in_flight guild=${guildId} clan=${clanTag}`,
      );
      return {
        processed: false,
        warEnded: false,
        skippedReason: "reconciliation_in_flight",
        reason: "coordinator_busy",
        coordinatorObservation: targeted.observation,
      };
    }

    return targeted.value;
  }

  private async listPollTargets(): Promise<PollTarget[]> {
    const [trackedClans, currentWars, clanNotifyConfigs] = await Promise.all([
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

    const clanNotifyConfigsByTag = new Map<string, typeof clanNotifyConfigs>();
    for (const row of clanNotifyConfigs) {
      const key = normalizeTag(row.clanTag);
      const list = clanNotifyConfigsByTag.get(key) ?? [];
      list.push(row);
      clanNotifyConfigsByTag.set(key, list);
    }

    const targets: PollTarget[] = [];
    for (const tracked of trackedClans) {
      const clanTag = normalizeTag(tracked.tag);
      const configRows = clanNotifyConfigsByTag.get(clanTag) ?? [];
      const currentRows = currentWarsByTag.get(clanTag) ?? [];
      const guildIds = new Set<string>();
      for (const row of configRows) guildIds.add(row.guildId);
      for (const row of currentRows) guildIds.add(row.guildId);
      for (const guildId of guildIds) {
        const config =
          configRows.find((row) => row.guildId === guildId) ?? null;
        const current =
          currentRows.find((row) => row.guildId === guildId) ?? null;
        const channelId =
          config?.channelId ??
          current?.channelId ??
          tracked.notifyChannelId ??
          tracked.mailChannelId ??
          tracked.logChannelId ??
          null;
        if (!channelId) continue;
        targets.push({
          guildId,
          clanTag,
          channelId,
          notify:
            config?.embedEnabled ??
            current?.notify ??
            tracked.notifyEnabled ??
            false,
          pingRole: config?.pingEnabled ?? current?.pingRole ?? true,
          inferredMatchType: current?.inferredMatchType ?? true,
          notifyRole:
            config?.roleId ?? current?.notifyRole ?? tracked.notifyRole ?? null,
          clanName: current?.clanName ?? tracked.name ?? null,
        });
      }
    }

    return targets.sort((a, b) =>
      `${a.guildId}:${normalizeTagBare(a.clanTag)}`.localeCompare(
        `${b.guildId}:${normalizeTagBare(b.clanTag)}`,
      ),
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
    const sub = await this.findSubscriptionByGuildAndTag(
      params.guildId,
      params.clanTag,
    );
    if (!sub)
      return {
        ok: false,
        reason: "No war event subscription found for that guild+clan.",
      };
    if (!sub.channelId)
      return { ok: false, reason: "Subscription has no configured channel." };
    const payload = await this.buildTestEventPayload(sub, params);
    const canonicalized =
      payload.eventType === "war_ended"
        ? await this.resolveCanonicalWarEndedPayloadContext(payload)
        : { payload, warId: null };
    const payloadForEmit = canonicalized.payload;
    const resolvedWarId =
      canonicalized.warId ??
      payloadForEmit.resolvedWarIdHint ??
      (await this.resolveWarId(
        payloadForEmit.clanTag,
        payloadForEmit.warStartTime,
      ));
    await this.emitEvent(sub.channelId, payloadForEmit, resolvedWarId, sub);

    return { ok: true };
  }

  async buildTestEventPreviewForClan(params: {
    guildId: string;
    clanTag: string;
    eventType: EventType;
    source: TestSource;
  }): Promise<NotifyWarPreviewResult> {
    const tracked = await prisma.trackedClan.findUnique({
      where: { tag: normalizeTag(params.clanTag) },
      select: {
        name: true,
        notifyChannelId: true,
        notifyRole: true,
        notifyEnabled: true,
        mailChannelId: true,
        logChannelId: true,
      },
    });
    const config = await prisma.clanNotifyConfig.findUnique({
      where: {
        guildId_clanTag: {
          guildId: params.guildId,
          clanTag: normalizeTagBare(params.clanTag),
        },
      },
    });

    const sub = await this.findSubscriptionByGuildAndTag(
      params.guildId,
      params.clanTag,
    );
    const effectiveChannelId =
      sub?.channelId ??
      config?.channelId ??
      tracked?.notifyChannelId ??
      tracked?.mailChannelId ??
      tracked?.logChannelId ??
      null;

    if (!tracked && !config && !sub)
      return {
        ok: false,
        reason: "No notification configuration found for that clan.",
      };
    if (!effectiveChannelId)
      return { ok: false, reason: "Configuration has no channel set." };

    const previewSub: SubscriptionRow = sub ?? {
      guildId: params.guildId,
      clanTag: normalizeTag(params.clanTag),
      warId: null,
      syncNumber: null,
      syncNum: null,
      channelId: effectiveChannelId,
      notify: config?.embedEnabled ?? tracked?.notifyEnabled ?? false,
      pingRole: config?.pingEnabled ?? true,
      embedEnabled: config?.embedEnabled ?? tracked?.notifyEnabled ?? false,
      inferredMatchType: true,
      notifyRole: config?.roleId ?? tracked?.notifyRole ?? null,
      fwaPoints: null,
      opponentFwaPoints: null,
      outcome: null,
      matchType: "FWA",
      warStartFwaPoints: null,
      warEndFwaPoints: null,
      clanStars: null,
      opponentStars: null,
      pendingEventType: null,
      pendingEventTargetState: null,
      updatedAt: new Date(),
      state: "notInWar",
      prepStartTime: null,
      startTime: null,
      endTime: null,
      opponentTag: null,
      opponentName: null,
      clanName:
        String(tracked?.name ?? params.clanTag).trim() || params.clanTag,
      clanRoleId: null,
      pointsConfirmedByClanMail: null,
      pointsNeedsValidation: null,
      pointsLastSuccessfulFetchAt: null,
      pointsSyncNum: null,
      pointsLastKnownSyncNumber: null,
      pointsLastKnownPoints: null,
      pointsLastKnownMatchType: null,
      pointsLastKnownOutcome: null,
      pointsWarId: null,
      pointsOpponentTag: null,
      pointsWarStartTime: null,
    };

    const payload = await this.buildTestEventPayload(previewSub, params);
    const canonicalized =
      payload.eventType === "war_ended"
        ? await this.resolveCanonicalWarEndedPayloadContext(payload)
        : { payload, warId: null };
    const payloadForPreview = canonicalized.payload;
    const warId =
      canonicalized.warId ??
      payloadForPreview.resolvedWarIdHint ??
      (await this.resolveWarId(
        payloadForPreview.clanTag,
        payloadForPreview.warStartTime,
      ));
    const message = await this.buildEventMessage(
      payloadForPreview,
      params.guildId,
      {
        includeRoleMention: false,
        includeEventComponents: false,
        warId,
      },
    );
    return {
      ok: true,
      clanName: payloadForPreview.clanName,
      clanTag: payloadForPreview.clanTag,
      channelId: effectiveChannelId,
      embeds: message.embeds,
    };
  }

  private async buildTestEventPayload(
    sub: SubscriptionRow,
    params: { eventType: EventType; source: TestSource },
  ): Promise<EventEmitPayload> {
    const previousSync = await this.syncResolution.getLatestPersistedSyncBaseline();
    const activeSync = previousSync === null ? null : previousSync + 1;

    const currentWar =
      params.source === "current"
        ? await this.coc.getCurrentWar(sub.clanTag).catch(() => null)
        : null;
    const lastWarLogEntry =
      params.source === "last"
        ? ((await this.coc.getClanWarLog(sub.clanTag, 1))[0] ?? null)
        : null;
    const lastWarRow =
      params.source === "last"
        ? await prisma.warAttacks.findFirst({
            where: {
              clanTag: normalizeTag(sub.clanTag),
              warEndTime: { not: null },
              attackOrder: 0,
            },
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
            orderBy: [
              { warEndTime: "desc" },
              { warStartTime: "desc" },
              { updatedAt: "desc" },
            ],
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
        "",
    );
    const clanName =
      String(
        currentWar?.clan?.name ??
          lastWarHistoryRow?.clanName ??
          lastWarLogEntry?.clan?.name ??
          lastWarRow?.clanName ??
          sub.clanName ??
          clanTag,
      ).trim() || clanTag;
    const opponentName =
      String(
        currentWar?.opponent?.name ??
          lastWarHistoryRow?.opponentName ??
          lastWarLogEntry?.opponent?.name ??
          lastWarRow?.opponentClanName ??
          sub.opponentName ??
          "Unknown",
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
      outcome = deriveExpectedOutcome(
        clanTag,
        opponentTag,
        a.balance,
        b.balance,
        syncNumber,
      );
    }

    const currentWarStartTime = parseCocTime(currentWar?.startTime ?? null);
    const testWarStartTime =
      params.source === "current"
        ? (currentWarStartTime ?? sub.startTime)
        : (lastWarHistoryRow?.warStartTime ??
          lastWarRow?.warStartTime ??
          sub.startTime ??
          currentWarStartTime);
    const currentClanStars = Number.isFinite(Number(currentWar?.clan?.stars))
      ? Number(currentWar?.clan?.stars)
      : sub.clanStars;
    const currentOpponentStars = Number.isFinite(
      Number(currentWar?.opponent?.stars),
    )
      ? Number(currentWar?.opponent?.stars)
      : sub.opponentStars;
    const testFinalResultOverride: WarEndResultSnapshot | null =
      params.source === "current" && params.eventType === "war_ended"
        ? {
            clanStars: currentClanStars,
            opponentStars: currentOpponentStars,
            clanDestruction: Number.isFinite(
              Number(currentWar?.clan?.destructionPercentage),
            )
              ? Number(currentWar?.clan?.destructionPercentage)
              : null,
            opponentDestruction: Number.isFinite(
              Number(currentWar?.opponent?.destructionPercentage),
            )
              ? Number(currentWar?.opponent?.destructionPercentage)
              : null,
            warEndTime: new Date(),
            resultLabel: deriveResultLabelFromStars(
              currentClanStars,
              currentOpponentStars,
            ),
          }
        : null;
    const testWarStartFwaPoints = this.resolveWarEndBeforePoints({
      warStartFwaPoints: sub.warStartFwaPoints,
      fwaPoints: sub.fwaPoints,
    });
    let testWarEndFwaPoints = sub.warEndFwaPoints;
    const testTeamSize = Number.isFinite(
      Number((currentWar as { teamSize?: number | null } | null)?.teamSize),
    )
      ? Number((currentWar as { teamSize?: number | null } | null)?.teamSize)
      : Number.isFinite(Number((sub as { teamSize?: number | null }).teamSize))
        ? Number((sub as { teamSize?: number | null }).teamSize)
        : null;
    if (
      params.source === "current" &&
      params.eventType === "war_ended" &&
      testFinalResultOverride
    ) {
      const before = this.resolveWarEndBeforePoints({
        warStartFwaPoints: sub.warStartFwaPoints,
        fwaPoints: sub.fwaPoints,
      });
      testWarEndFwaPoints = this.computeExpectedWarEndPoints({
        matchType,
        before,
        finalResult: testFinalResultOverride,
        outcome,
        teamSize: testTeamSize,
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
      prepStartTime:
        parseCocTime(currentWar?.preparationStartTime ?? null) ??
        sub.prepStartTime,
      warStartTime: testWarStartTime,
      warEndTime:
        params.source === "last"
          ? (lastWarHistoryRow?.warEndTime ?? null)
          : parseCocTime(currentWar?.endTime ?? null),
      clanAttacks: Number.isFinite(Number(currentWar?.clan?.attacks))
        ? Number(currentWar?.clan?.attacks)
        : null,
      opponentAttacks: Number.isFinite(Number(currentWar?.opponent?.attacks))
        ? Number(currentWar?.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(currentWar?.teamSize))
        ? Number(currentWar?.teamSize)
        : null,
      attacksPerMember: Number.isFinite(Number(currentWar?.attacksPerMember))
        ? Number(currentWar?.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(
        Number(currentWar?.clan?.destructionPercentage),
      )
        ? Number(currentWar?.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(
        Number(currentWar?.opponent?.destructionPercentage),
      )
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
      Number.isFinite(Number(params.warId)) &&
      Math.trunc(Number(params.warId)) > 0
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
    const summaryPointsLine = this.history.buildWarEndPointsLine(
      params.payload,
      finalResult,
    );

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
        const sortedMissed = sortWarComplianceIssuesByPosition(
          report.missedBoth,
        );
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
            { forcedLoseStyle: report.loseStyle },
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
          params.payload.outcome,
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
          params.payload.clanName,
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

  private buildWarEndedSummaryEmbed(
    state: NotifyWarEndedViewState,
  ): EmbedBuilder {
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
        },
      );
  }

  private buildWarEndedComplianceEmbed(
    state: NotifyWarEndedViewState,
    page: number,
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
            },
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
      state.compliance.notFollowingPlan.length > 0,
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
              }),
            )
            .setLabel(
              canOpenCompliance ? "FWA Compliance" : "FWA Compliance (N/A)",
            )
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canOpenCompliance),
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
            }),
          )
          .setLabel("Back to War Ended")
          .setStyle(ButtonStyle.Secondary),
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
              }),
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
              }),
            )
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(input.currentPage >= input.pageCount - 1),
        ),
      );
    }

    return rows;
  }

  private buildWarEndedViewMessage(
    state: NotifyWarEndedViewState,
    view: NotifyWarEndedViewToken,
    page: number,
    includeComponents: boolean,
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

  private async replyWithExpiredWarEndedView(
    interaction: ButtonInteraction,
  ): Promise<void> {
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
    },
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
    const includeRoleMentionForPost =
      includeRoleMention &&
      payload.pingRole &&
      !shouldSuppressBattleDayNotifyRoleMention(
        payload.eventType,
        payload.pointsNeedsValidation,
      );
    const content = buildNotifyEventPostedContent({
      eventType: payload.eventType,
      opponentName: payload.opponentName,
      notifyRoleId: roleId,
      includeRoleMention: includeRoleMentionForPost,
      nowMs: Date.now(),
      nextScheduledRefreshAtMs: getNextNotifyRefreshAtMs(),
    });

    if (payload.eventType === "war_ended") {
      const timestampUnix = resolveWarEndedMetadataTimestampUnix(
        payload.warEndTime,
        new Date(),
      );
      const safeWarId =
        warId !== null && Number.isFinite(Number(warId))
          ? Math.trunc(Number(warId))
          : 0;
      const state = await this.buildWarEndedViewState({
        payload,
        guildId,
        warId: safeWarId,
        messageId: "00000",
        timestampUnix,
      });
      const rendered = this.buildWarEndedViewMessage(
        state,
        "s",
        0,
        includeEventComponents,
      );
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
      },
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
        },
      );
      const battlePlanTextRaw = await this.history.buildWarPlanText(
        guildId,
        payload.matchType,
        payload.outcome,
        payload.clanTag,
        payload.opponentName,
        "battle",
        payload.clanName,
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
        },
      );
      const prepPlanTextRaw = await this.history.buildWarPlanText(
        guildId,
        payload.matchType,
        payload.outcome,
        payload.clanTag,
        payload.opponentName,
        "prep",
        payload.clanName,
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
                .setCustomId(
                  buildNotifyWarRefreshCustomId(guildId, payload.clanTag),
                )
                .setLabel("Refresh")
                .setStyle(ButtonStyle.Secondary),
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
    clanTag: string,
  ): Promise<SubscriptionRow | null> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          cw."guildId",cw."clanTag",cw."warId",cw."syncNumber",cw."syncNum",cw."updatedAt",
          COALESCE(
            cnc."channelId",
            cw."channelId",
            tc."notifyChannelId",
            tc."mailChannelId",
            tc."logChannelId"
          ) AS "channelId",
          COALESCE(cnc."embedEnabled", cw."notify", COALESCE(tc."notifyEnabled", false), false) AS "notify",
          COALESCE(cnc."pingEnabled", cw."pingRole", true) AS "pingRole",
          COALESCE(cnc."embedEnabled", cw."notify", COALESCE(tc."notifyEnabled", false), false) AS "embedEnabled",
          COALESCE(cnc."roleId", cw."notifyRole", tc."notifyRole") AS "notifyRole",
          cw."inferredMatchType",
          cw."fwaPoints",cw."opponentFwaPoints",cw."outcome",cw."matchType",cw."warStartFwaPoints",cw."warEndFwaPoints",
          cw."clanStars",cw."opponentStars",cw."pendingEventType",cw."pendingEventTargetState",cw."state",cw."prepStartTime",cw."startTime",cw."endTime",
          cw."opponentTag",cw."opponentName",cw."clanName",
          tc."clanRoleId" AS "clanRoleId",
          cps."confirmedByClanMail" AS "pointsConfirmedByClanMail",
          cps."needsValidation" AS "pointsNeedsValidation",
          cps."lastSuccessfulPointsApiFetchAt" AS "pointsLastSuccessfulFetchAt",
          cps."syncNum" AS "pointsSyncNum",
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
          ON cnc."guildId" = cw."guildId"
          AND UPPER(REPLACE(cnc."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanPointsSync" cps
          ON cps."guildId" = cw."guildId"
          AND UPPER(REPLACE(cps."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
          AND cps."warStartTime" = cw."startTime"
        WHERE cw."guildId" = ${guildId} AND UPPER(REPLACE(cw."clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /** Purpose: has war end recorded. */
  private async hasWarEndRecorded(
    clanTagInput: string,
    warStartTime: Date,
  ): Promise<boolean> {
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
    if (
      sub.warStartFwaPoints !== null &&
      Number.isFinite(sub.warStartFwaPoints)
    ) {
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
    teamSize?: number | null;
  }): number | null {
    return computeExpectedWarEndPointsForTest({
      matchType: input.matchType,
      before: input.before,
      finalResult: input.finalResult,
      outcome: input.outcome,
      teamSize: input.teamSize ?? null,
    });
  }

  /** Purpose: fetch current war while preserving upstream-failure classification. */
  private async getCurrentWarSnapshot(
    clanTag: string,
    currentWarSnapshotCycleContext?: CurrentWarSnapshotCycleContext | null,
  ): Promise<{
    war: CurrentWarSnapshot | null;
    observation: CocWarFetchObservation;
    error: unknown | null;
  }> {
    const normalizedClanTag = normalizeTag(clanTag);
    const cached = currentWarSnapshotCycleContext?.currentWarSnapshotByClanTag.get(
      normalizedClanTag,
    );
    if (currentWarSnapshotCycleContext?.currentWarSnapshotByClanTag.has(normalizedClanTag)) {
      return {
        war: cached ?? null,
        observation: { kind: "success" },
        error: null,
      };
    }
    try {
      const war = await this.coc.getCurrentWar(normalizedClanTag || clanTag);
      if (currentWarSnapshotCycleContext) {
        currentWarSnapshotCycleContext.currentWarSnapshotByClanTag.set(normalizedClanTag, war);
      }
      return { war, observation: { kind: "success" }, error: null };
    } catch (error) {
      return {
        war: null,
        error,
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
    observation: CocWarFetchObservation,
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
      `,
    );
    const raw = rows[0]?.warId;
    if (raw === null || raw === undefined) return null;
    const warId = typeof raw === "bigint" ? Number(raw) : Number(raw);
    return Number.isFinite(warId) ? Math.trunc(warId) : null;
  }

  /** Purpose: complete the live CurrentWar physical identity before sync assignment depends on it. */
  private async ensureCurrentWarIdentityCompletion(input: {
    guildId: string;
    clanTag: string;
    warState: WarState;
    warStartTime: Date | null;
    opponentTag: string | null;
  }): Promise<CurrentWarIdentityCompletionResult> {
    const dbClanTag = normalizeTag(input.clanTag) ?? "";
    const dbOpponentTag = input.opponentTag ? normalizeTag(input.opponentTag) : null;
    if (
      !dbClanTag ||
      !dbOpponentTag ||
      !input.warStartTime ||
      !isActiveWarState(input.warState)
    ) {
      return {
        state: "not_needed",
        warId: null,
        persistedRevisionAt: null,
      };
    }

    const readExactRow = async () =>
      prisma.currentWar.findUnique({
        where: {
          clanTag_guildId: {
            guildId: input.guildId,
            clanTag: dbClanTag,
          },
        },
        select: {
          warId: true,
          updatedAt: true,
          state: true,
          startTime: true,
          opponentTag: true,
        },
      });

    const exactRow = await readExactRow();
    if (!exactRow) {
      return {
        state: "conflict",
        warId: null,
        persistedRevisionAt: null,
      };
    }

    const exactStartTime = exactRow.startTime ?? null;
    const exactOpponentTag = normalizeTag(exactRow.opponentTag ?? null);
    const exactWarId =
      exactRow.warId !== null && exactRow.warId !== undefined
        ? Math.trunc(Number(exactRow.warId))
        : null;
    const samePhysicalIdentity =
      isActiveWarState((exactRow.state ?? "notInWar") as WarState) &&
      exactStartTime !== null &&
      exactStartTime.getTime() === input.warStartTime.getTime() &&
      exactOpponentTag === dbOpponentTag;

    if (!samePhysicalIdentity) {
      return {
        state: "identity_changed",
        warId: exactWarId !== null && exactWarId > 0 ? exactWarId : null,
        persistedRevisionAt: exactRow.updatedAt ?? null,
      };
    }

    if (exactWarId !== null && exactWarId > 0) {
      return {
        state: "idempotent",
        warId: exactWarId,
        persistedRevisionAt: exactRow.updatedAt ?? null,
      };
    }

    const expectedRevisionAt = exactRow.updatedAt ?? null;
    if (!expectedRevisionAt) {
      return {
        state: "conflict",
        warId: null,
        persistedRevisionAt: null,
      };
    }

    const allocatedWarId = await this.allocateNextWarId();
    if (!allocatedWarId || allocatedWarId <= 0) {
      return {
        state: "conflict",
        warId: null,
        persistedRevisionAt: null,
      };
    }

    const persistedRevisionAt = new Date(
      Math.max(Date.now(), expectedRevisionAt.getTime() + 1),
    );
    const updated = await prisma.currentWar.updateMany({
      where: {
        guildId: input.guildId,
        clanTag: dbClanTag,
        updatedAt: expectedRevisionAt,
        state: exactRow.state,
        startTime: exactStartTime,
        opponentTag: dbOpponentTag,
        warId: null,
      },
      data: {
        warId: allocatedWarId,
        updatedAt: persistedRevisionAt,
      },
    });

    if (updated.count === 1) {
      logCurrentWarIdentityCompletion({
        result: "saved",
        guildId: input.guildId,
        clanTag: input.clanTag,
        dbClanTag,
        dbOpponentTag,
        warId: allocatedWarId,
        warStartTime: input.warStartTime,
        expectedRevisionAt,
        persistedRevisionAt,
      });
      return {
        state: "saved",
        warId: allocatedWarId,
        persistedRevisionAt,
      };
    }

    const rereadExactRow = await readExactRow();
    if (!rereadExactRow) {
      logCurrentWarIdentityCompletion({
        result: "conflict",
        guildId: input.guildId,
        clanTag: input.clanTag,
        dbClanTag,
        dbOpponentTag,
        warId: null,
        warStartTime: input.warStartTime,
        expectedRevisionAt,
        persistedRevisionAt: null,
      });
      return {
        state: "conflict",
        warId: null,
        persistedRevisionAt: null,
      };
    }

    const rereadStartTime = rereadExactRow.startTime ?? null;
    const rereadOpponentTag = normalizeTag(rereadExactRow.opponentTag ?? null);
    const rereadWarId =
      rereadExactRow.warId !== null && rereadExactRow.warId !== undefined
        ? Math.trunc(Number(rereadExactRow.warId))
        : null;
    const rereadSameIdentity =
      isActiveWarState((rereadExactRow.state ?? "notInWar") as WarState) &&
      rereadStartTime !== null &&
      rereadStartTime.getTime() === input.warStartTime.getTime() &&
      rereadOpponentTag === dbOpponentTag;

    if (!rereadSameIdentity) {
      logCurrentWarIdentityCompletion({
        result: "identity_changed",
        guildId: input.guildId,
        clanTag: input.clanTag,
        dbClanTag,
        dbOpponentTag,
        warId: rereadWarId,
        warStartTime: input.warStartTime,
        expectedRevisionAt,
        persistedRevisionAt: rereadExactRow.updatedAt ?? null,
      });
      return {
        state: "identity_changed",
        warId: rereadWarId !== null && rereadWarId > 0 ? rereadWarId : null,
        persistedRevisionAt: rereadExactRow.updatedAt ?? null,
      };
    }

    if (rereadWarId !== null && rereadWarId > 0) {
      logCurrentWarIdentityCompletion({
        result: "idempotent",
        guildId: input.guildId,
        clanTag: input.clanTag,
        dbClanTag,
        dbOpponentTag,
        warId: rereadWarId,
        warStartTime: input.warStartTime,
        expectedRevisionAt,
        persistedRevisionAt: rereadExactRow.updatedAt ?? null,
      });
      return {
        state: "idempotent",
        warId: rereadWarId,
        persistedRevisionAt: rereadExactRow.updatedAt ?? null,
      };
    }

    logCurrentWarIdentityCompletion({
      result: "conflict",
      guildId: input.guildId,
      clanTag: input.clanTag,
      dbClanTag,
      dbOpponentTag,
      warId: null,
      warStartTime: input.warStartTime,
      expectedRevisionAt,
      persistedRevisionAt: rereadExactRow.updatedAt ?? null,
    });
    return {
      state: "conflict",
      warId: null,
      persistedRevisionAt: null,
    };
  }

  private async ensureCurrentWarId(params: {
    sub: SubscriptionRow;
    warStartTime: Date | null;
    currentState: WarState;
    preserveExistingWarId?: boolean;
  }): Promise<number | null> {
    if (params.currentState === "notInWar") return params.sub.warId ?? null;
    if (!params.warStartTime) return params.sub.warId ?? null;
    if (
      params.preserveExistingWarId &&
      params.sub.warId !== null &&
      params.sub.warId !== undefined
    ) {
      return Number(params.sub.warId);
    }

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

  /** Purpose: validate whether a persisted pending marker still belongs to the observed active war. */
  private resolveCurrentWarPendingEvent(input: {
    sub: SubscriptionRow;
    currentState: WarState;
    warIdentityChanged: boolean;
    nextWarStartTime: Date | null;
    nextOpponentTag: string | null;
  }):
    | { kind: "none" }
    | {
        kind: "valid";
        eventType: PendingCurrentWarEventType;
        targetState: WarState;
      }
    | {
        kind: "abandoned";
        reason: "identity_changed";
        eventType: PendingCurrentWarEventType;
        targetState: WarState;
      }
    | {
        kind: "malformed";
        reason: "invalid_marker" | "state_mismatch" | "identity_mismatch";
      } {
    const pendingEventType = String(input.sub.pendingEventType ?? "").trim();
    const pendingTargetState = String(
      input.sub.pendingEventTargetState ?? "",
    ).trim();
    if (!pendingEventType && !pendingTargetState) {
      return { kind: "none" };
    }
    if (!isPendingCurrentWarEventType(pendingEventType)) {
      return { kind: "malformed", reason: "invalid_marker" };
    }
    if (
      pendingTargetState !== "preparation" &&
      pendingTargetState !== "inWar"
    ) {
      return { kind: "malformed", reason: "invalid_marker" };
    }
    const expectedTargetState =
      pendingCurrentWarTargetStateForEvent(pendingEventType);
    if (expectedTargetState !== pendingTargetState) {
      return { kind: "malformed", reason: "invalid_marker" };
    }
    if (pendingTargetState !== input.currentState) {
      return input.warIdentityChanged
        ? {
            kind: "abandoned",
            reason: "identity_changed",
            eventType: pendingEventType,
            targetState: pendingTargetState,
          }
        : { kind: "malformed", reason: "state_mismatch" };
    }
    const persistedStartTime = input.sub.startTime ?? null;
    if (
      persistedStartTime &&
      input.nextWarStartTime &&
      persistedStartTime.getTime() !== input.nextWarStartTime.getTime()
    ) {
      return input.warIdentityChanged
        ? {
            kind: "abandoned",
            reason: "identity_changed",
            eventType: pendingEventType,
            targetState: pendingTargetState,
          }
        : { kind: "malformed", reason: "identity_mismatch" };
    }
    const persistedOpponentTag = normalizeTag(input.sub.opponentTag ?? null);
    const observedOpponentTag = normalizeTag(input.nextOpponentTag ?? null);
    if (persistedOpponentTag && observedOpponentTag && persistedOpponentTag !== observedOpponentTag) {
      return input.warIdentityChanged
        ? {
            kind: "abandoned",
            reason: "identity_changed",
            eventType: pendingEventType,
            targetState: pendingTargetState,
          }
        : { kind: "malformed", reason: "identity_mismatch" };
    }
    return {
      kind: "valid",
      eventType: pendingEventType,
      targetState: pendingTargetState as WarState,
    };
  }

  private async processSubscription(
    guildId: string,
    clanTag: string,
    syncContext: PollSyncContext,
    options?: {
      sendBattleDaySwapReminders?: boolean;
      maintenanceOverGuildIds?: Set<string>;
      currentWarSnapshotCycleContext?: CurrentWarSnapshotCycleContext | null;
    },
  ): Promise<boolean> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          cw."guildId",cw."clanTag",cw."warId",cw."syncNumber",cw."syncNum",
          cw."updatedAt",
          COALESCE(
            cnc."channelId",
            cw."channelId",
            tc."notifyChannelId",
            tc."mailChannelId",
            tc."logChannelId"
          ) AS "channelId",
          COALESCE(cnc."embedEnabled", cw."notify", COALESCE(tc."notifyEnabled", false), false) AS "notify",
          COALESCE(cnc."pingEnabled", cw."pingRole", true) AS "pingRole",
          COALESCE(cnc."embedEnabled", cw."notify", COALESCE(tc."notifyEnabled", false), false) AS "embedEnabled",
          COALESCE(cnc."roleId", cw."notifyRole", tc."notifyRole") AS "notifyRole",
          cw."inferredMatchType",
          cw."fwaPoints",cw."opponentFwaPoints",cw."outcome",cw."matchType",cw."warStartFwaPoints",cw."warEndFwaPoints",
          cw."clanStars",cw."opponentStars",cw."pendingEventType",cw."pendingEventTargetState",cw."state",cw."prepStartTime",cw."startTime",cw."endTime",
          cw."opponentTag",cw."opponentName",cw."clanName",
          tc."clanRoleId" AS "clanRoleId",
          cps."confirmedByClanMail" AS "pointsConfirmedByClanMail",
          cps."needsValidation" AS "pointsNeedsValidation",
          cps."lastSuccessfulPointsApiFetchAt" AS "pointsLastSuccessfulFetchAt",
          cps."syncNum" AS "pointsSyncNum",
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
          ON cnc."guildId" = cw."guildId"
          AND UPPER(REPLACE(cnc."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
        LEFT JOIN "ClanPointsSync" cps
          ON cps."guildId" = cw."guildId"
          AND UPPER(REPLACE(cps."clanTag",'#','')) = UPPER(REPLACE(cw."clanTag",'#',''))
          AND cps."warStartTime" = cw."startTime"
        WHERE cw."guildId" = ${guildId}
          AND UPPER(REPLACE(cw."clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `,
    );
    const sub = rows[0] ?? null;
    if (!sub) return false;

    const warSnapshot = await this.getCurrentWarSnapshot(
      sub.clanTag,
      options?.currentWarSnapshotCycleContext ?? null,
    );
    const war = warSnapshot.war;
    const outageState = this.recordCocWarObservation(
      sub.clanTag,
      warSnapshot.observation,
    );
    const maintenanceObservation = await this.maintenanceWindowService.observeWarFetch({
      guildId: sub.guildId,
      clanTag: sub.clanTag,
      observation: warSnapshot.observation,
      error: warSnapshot.error,
    });
    const resolvedState: WarState = war
      ? deriveState(String(war.state ?? ""))
      : "notInWar";
    const resolvedOpponentTag = normalizeTag(war?.opponent?.tag ?? "");
    const candidateState: WarState =
      resolvedState === "inWar" && !resolvedOpponentTag
        ? "notInWar"
        : resolvedState;
    const prevState: WarState = deriveState(sub.state ?? "notInWar");
    const nextClanName =
      String(war?.clan?.name ?? sub.clanName ?? sub.clanTag).trim() ||
      sub.clanTag;
    const nextOpponentTag = normalizeTag(
      war?.opponent?.tag ?? sub.opponentTag ?? "",
    );
    const nextOpponentName =
      String(war?.opponent?.name ?? sub.opponentName ?? "").trim() || null;
    const timing = resolveActiveWarTiming({
      observedWarStartTime: parseCocTime(war?.startTime ?? null),
      observedWarEndTime: parseCocTime(war?.endTime ?? null),
      previousWarStartTime: sub.startTime ?? null,
      previousWarEndTime: sub.endTime ?? null,
    });
    const nextWarStartTime = timing.warStartTime;
    const nextWarEndTime = timing.warEndTime;
    const nextPrepStartTime =
      parseCocTime(war?.preparationStartTime ?? null) ?? sub.prepStartTime;
    // This poller keeps its own identity/timing reconciliation because it also
    // decides outage recovery and event emission; the shared active-war helper
    // used by `/fwa match` is intentionally narrower and command-focused.
    const warIdentityComparison = compareActiveWarIdentities({
      persisted: {
        warId: sub.warId,
        warStartTime: sub.startTime ?? null,
        opponentTag: sub.opponentTag ?? null,
      },
      active: {
        warStartTime: nextWarStartTime,
        opponentTag: nextOpponentTag || null,
      },
    });
    const warIdentityChanged =
      isNewWarCycle(sub.startTime, nextWarStartTime) ||
      warIdentityComparison.identityChanged;
    const pollNow = new Date();
    const previousPhaseExpectedActive = isWarPhaseExpectedActive({
      state: prevState,
      knownWarStartTime: sub.startTime ?? null,
      knownWarEndTime: sub.endTime ?? null,
      now: pollNow,
    });
    if (
      warSnapshot.observation.kind === "failure" &&
      isActiveWarState(prevState) &&
      previousPhaseExpectedActive
    ) {
      console.warn(
        `[war-events] outage detected guild=${sub.guildId} clan=${sub.clanTag} prev=${prevState} knownStart=${sub.startTime?.toISOString() ?? "unknown"} knownEnd=${sub.endTime?.toISOString() ?? "unknown"} status=${outageState.lastFailureStatusCode ?? "unknown"} failureStreak=${outageState.failureStreak}`,
      );
    }

    const pendingEventResolution = this.resolveCurrentWarPendingEvent({
      sub,
      currentState: candidateState,
      warIdentityChanged,
      nextWarStartTime,
      nextOpponentTag,
    });
    if (pendingEventResolution.kind === "valid") {
      console.info(
        `[war-events] event=current_war_pending_event result=retrying guild=${sub.guildId} clan=${sub.clanTag} pending_event=${pendingEventResolution.eventType} target_state=${pendingEventResolution.targetState} war_id=${sub.warId ?? "none"} war_start=${sub.startTime?.toISOString() ?? "none"} opponent=${sub.opponentTag ? `#${normalizeTag(sub.opponentTag) ?? "unknown"}` : "none"} revision=${sub.updatedAt.toISOString()}`,
      );
    } else if (pendingEventResolution.kind === "abandoned") {
      console.warn(
        `[war-events] event=current_war_pending_event result=abandoned reason=${pendingEventResolution.reason} guild=${sub.guildId} clan=${sub.clanTag} pending_event=${pendingEventResolution.eventType} target_state=${pendingEventResolution.targetState} persisted_war=${sub.warId ?? "none"} persisted_start=${sub.startTime?.toISOString() ?? "none"} persisted_opponent=${sub.opponentTag ? `#${normalizeTag(sub.opponentTag) ?? "unknown"}` : "none"} observed_state=${candidateState} observed_start=${nextWarStartTime?.toISOString() ?? "none"} observed_opponent=${nextOpponentTag || "none"} revision=${sub.updatedAt.toISOString()}`,
      );
    } else if (pendingEventResolution.kind === "malformed") {
      console.warn(
        `[war-events] event=current_war_pending_event result=abandoned reason=${pendingEventResolution.reason} guild=${sub.guildId} clan=${sub.clanTag} persisted_war=${sub.warId ?? "none"} persisted_start=${sub.startTime?.toISOString() ?? "none"} persisted_opponent=${sub.opponentTag ? `#${normalizeTag(sub.opponentTag) ?? "unknown"}` : "none"} observed_state=${candidateState} observed_start=${nextWarStartTime?.toISOString() ?? "none"} observed_opponent=${nextOpponentTag || "none"} revision=${sub.updatedAt.toISOString()}`,
      );
      if (!warIdentityChanged) {
        return false;
      }
    }
    let eventType = pendingEventResolution.kind === "valid"
      ? pendingEventResolution.eventType
      : shouldEmit(prevState, candidateState);
    let eventDerivedFromIdentityShift = false;
    if (!eventType && warIdentityChanged) {
      if (candidateState === "preparation") {
        eventType = "war_started";
        eventDerivedFromIdentityShift = true;
      } else if (candidateState === "inWar") {
        eventType = "battle_day";
        eventDerivedFromIdentityShift = true;
      }
    }
    const warEndedGuard = applyWarEndedMaintenanceGuard({
      eventType,
      previousState: prevState,
      candidateState,
      warFetchFailed: warSnapshot.observation.kind === "failure",
      maintenanceSuspected: outageState.suspected,
      knownWarEndTime: nextWarEndTime,
      now: pollNow,
    });
    let currentState: WarState = warEndedGuard.state;
    eventType = warEndedGuard.eventType;
    if (warEndedGuard.suppressReason) {
      console.log(
        `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=${warEndedGuard.suppressReason} prev=${prevState} current=${candidateState} knownEnd=${nextWarEndTime?.toISOString() ?? "unknown"} maintenanceSuspected=${outageState.suspected} failureStreak=${outageState.failureStreak}${outageState.lastFailureStatusCode ? ` status=${outageState.lastFailureStatusCode}` : ""}`,
      );
    }
    if (
      sub.state === "notInWar" &&
      pendingEventResolution.kind !== "valid" &&
      (await this.maybeRecoverEndedWarArchive({ sub }))
    ) {
      return false;
    }
    let effectiveWarIdentityChanged = warIdentityChanged;
    if (
      shouldPreserveWarIdentityDuringOutageRecovery({
        previousState: prevState,
        candidateState,
        previousWarStartTime: sub.startTime ?? null,
        previousWarEndTime: sub.endTime ?? null,
        warIdentityChanged,
        eventDerivedFromIdentityShift,
        warFetchFailed: warSnapshot.observation.kind === "failure",
        maintenanceSuspected: outageState.suspected,
        now: pollNow,
      })
    ) {
      effectiveWarIdentityChanged = false;
      eventType = null;
      currentState = prevState;
      console.log(
        `[war-events] outage recovery reconciled guild=${sub.guildId} clan=${sub.clanTag} action=update_in_place suppress_new_cycle=true prev=${prevState} current=${candidateState} previousStart=${sub.startTime?.toISOString() ?? "unknown"} observedStart=${nextWarStartTime?.toISOString() ?? "unknown"} previousEnd=${sub.endTime?.toISOString() ?? "unknown"} observedEnd=${nextWarEndTime?.toISOString() ?? "unknown"} suspected=${outageState.suspected} failureStreak=${outageState.failureStreak} recoveryStreak=${outageState.recoveryStreak}`,
      );
    }
    if (eventType === "war_ended") {
      if (!sub.startTime) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=no_last_war_start prev=${prevState} current=${currentState}`,
        );
        eventType = null;
      } else if (await this.hasWarEndRecorded(sub.clanTag, sub.startTime)) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=already_recorded warStart=${sub.startTime.toISOString()}`,
        );
        eventType = null;
      }
    }
    if (
      (eventType === "war_started" || eventType === "war_ended") &&
      nextWarStartTime
    ) {
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
            lastSuccessfulPointsApiFetchAt:
              sub.pointsLastSuccessfulFetchAt ?? null,
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
      currentSyncNumber:
        currentState === "notInWar"
          ? syncContext.previousSync
          : syncContext.activeSync,
      lifecycle: lifecycleState,
      activeWarId:
        sub.warId !== null &&
        sub.warId !== undefined &&
        Number.isFinite(sub.warId)
          ? String(Math.trunc(sub.warId))
          : null,
      activeOpponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
    });
    if (eventType === "war_started" && nextOpponentTag) {
      await this.pointsSync
        .resetWarStartPointsJob(sub.clanTag, nextOpponentTag)
        .catch(() => null);
    }
    if (
      gateDecision.allowed &&
      currentState !== "notInWar" &&
      nextOpponentTag
    ) {
      await this.pointsSync
        .maybeRunWarStartPointsCheck(
          sub,
          nextOpponentTag,
          nextClanName,
          nextOpponentName,
        )
        .catch(() => null);
    }
    const fallbackSyncNumberForEvent =
      eventType === "war_ended"
        ? syncContext.activeSync
        : currentState === "notInWar"
          ? syncContext.previousSync
          : syncContext.activeSync;
    const frozenEndedWarContext =
      currentState === "notInWar"
        ? typeof this.history.resolveExactCanonicalWarEndedHistoryRow ===
          "function"
          ? await this.history.resolveExactCanonicalWarEndedHistoryRow({
              clanTag: sub.clanTag,
              opponentTag:
                nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
              warStartTime: sub.startTime ?? nextWarStartTime,
            })
          : null
        : null;
    const freezeEndedWarMatchDecision = Boolean(frozenEndedWarContext);
    const restoreFrozenEndedWarContext = () => {
      if (!frozenEndedWarContext) return;
      nextFwaPoints = sub.fwaPoints;
      nextOpponentFwaPoints = sub.opponentFwaPoints;
      nextOutcome = normalizeOutcome(
        frozenEndedWarContext.expectedOutcome ??
          frozenEndedWarContext.actualOutcome ??
          sub.outcome,
      );
      nextMatchType = frozenEndedWarContext.matchType ?? sub.matchType;
      nextInferredMatchType = sub.inferredMatchType;
      nextWarStartFwaPoints = sub.warStartFwaPoints;
      nextWarEndFwaPoints =
        frozenEndedWarContext.pointsAfterWar ?? sub.warEndFwaPoints;
      nextClanStars = sub.clanStars;
      nextOpponentStars = sub.opponentStars;
    };

    const pendingEventActive = pendingEventResolution.kind === "valid";
    const currentMatchTypeForResolution = pendingEventActive
      ? null
      : effectiveWarIdentityChanged
        ? null
        : sub.matchType;
    const currentInferredMatchTypeForResolution = pendingEventActive
      ? true
      : effectiveWarIdentityChanged
        ? true
        : sub.inferredMatchType;
    const currentWarResolution = resolveCurrentWarMatchTypeSignal({
      matchType: currentMatchTypeForResolution,
      inferredMatchType: currentInferredMatchTypeForResolution,
    });
    const preserveConfirmedCurrentWarRevision = hasSameWarConfirmedMailBaseline({
      sub,
      effectiveWarIdentityChanged,
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
    let resolvedWarId: number | null = null;
    let pendingPointsSyncWrite: Parameters<
      PointsSyncService["upsertPointsSync"]
    >[0] | null = null;
    let nextClanStars = Number.isFinite(
      Number((war as { clan?: { stars?: number } } | null)?.clan?.stars),
    )
      ? Number((war as { clan?: { stars?: number } }).clan?.stars)
      : sub.clanStars;
    let nextOpponentStars = Number.isFinite(
      Number(
        (war as { opponent?: { stars?: number } } | null)?.opponent?.stars,
      ),
    )
      ? Number((war as { opponent?: { stars?: number } }).opponent?.stars)
      : sub.opponentStars;
    let ownedCurrentWarRevisionAt = new Date(sub.updatedAt);
    const nextClanAttacks = Number.isFinite(Number(war?.clan?.attacks))
      ? Number(war?.clan?.attacks)
      : null;
    const nextOpponentAttacks = Number.isFinite(Number(war?.opponent?.attacks))
      ? Number(war?.opponent?.attacks)
      : null;
    const nextTeamSize = Number.isFinite(Number(war?.teamSize))
      ? Number(war?.teamSize)
      : Number.isFinite(Number((sub as { teamSize?: number | null }).teamSize))
        ? Number((sub as { teamSize?: number | null }).teamSize)
        : null;
    const nextAttacksPerMember = Number.isFinite(Number(war?.attacksPerMember))
      ? Number(war?.attacksPerMember)
      : null;
    const nextClanDestruction = Number.isFinite(
      Number(war?.clan?.destructionPercentage),
    )
      ? Number(war?.clan?.destructionPercentage)
      : null;
    const nextOpponentDestruction = Number.isFinite(
      Number(war?.opponent?.destructionPercentage),
    )
      ? Number(war?.opponent?.destructionPercentage)
      : null;
    if (
      gateDecision.allowed &&
      (nextOpponentTag || normalizeTag(sub.opponentTag ?? ""))
    ) {
      const projectionClanTag = sub.clanTag;
      const projectionOpponentTag =
        nextOpponentTag || normalizeTag(sub.opponentTag ?? "");
      const projectionReason =
        gateDecision.fetchReason ?? "war_event_projection";
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
      const siteCurrent = a.winnerBoxTags
        .map((t) => normalizeTag(t))
        .includes(projectionOpponentTag);
      const winnerBoxNotMarkedFwa = /not marked as an fwa match/i.test(
        String(a.winnerBoxText ?? ""),
      );
      const strongOpponentEvidencePresent =
        b.notFound === true || b.activeFwa === true || b.activeFwa === false;
      liveOpponentResolution = inferMatchTypeFromOpponentPoints({
        available: true,
        balance: b.balance,
        activeFwa: b.activeFwa,
        notFound: b.notFound,
        winnerBoxNotMarkedFwa,
        opponentEvidenceMissingOrNotCurrent:
          !siteCurrent || !strongOpponentEvidencePresent,
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
        if (!freezeEndedWarMatchDecision) {
          const syncResolution = chooseMatchTypeResolution({
            confirmedCurrent: currentWarResolution.confirmed,
            liveOpponent: liveOpponentResolution,
            storedSync: null,
            unconfirmedCurrent: currentWarResolution.unconfirmed,
          });
          const syncMatchType =
            syncResolution?.matchType ?? sub.matchType ?? null;
          const syncIsFwa =
            syncResolution?.syncIsFwa ?? toSyncIsFwa(syncMatchType) ?? false;
          pendingPointsSyncWrite = {
            guildId: sub.guildId,
            clanTag: projectionClanTag,
            warId: null,
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
              observedSync,
            ),
            isFwa: syncIsFwa,
            fetchedAt: new Date(a.fetchedAtMs),
            fetchReason: projectionReason,
            matchType: syncMatchType,
            needsValidation: false,
          };
        }
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
    let nextMatchType =
      resolvedMatchType?.matchType ?? currentMatchTypeForResolution;
    let nextInferredMatchType =
      resolvedMatchType?.inferred ?? currentInferredMatchTypeForResolution;

    const currentSubscriptionWarId =
      sub.warId !== null &&
      sub.warId !== undefined &&
      Number.isFinite(Number(sub.warId))
        ? Math.trunc(Number(sub.warId))
        : null;
    if (currentState !== "notInWar") {
      if (effectiveWarIdentityChanged) {
        resolvedWarId = await this.ensureCurrentWarId({
          sub,
          warStartTime: nextWarStartTime,
          currentState,
        });
      } else if (currentSubscriptionWarId !== null && currentSubscriptionWarId > 0) {
        resolvedWarId = await this.ensureCurrentWarId({
          sub,
          warStartTime: nextWarStartTime,
          currentState,
          preserveExistingWarId: true,
        });
      } else {
        const identityCompletion = await this.ensureCurrentWarIdentityCompletion({
          guildId: sub.guildId,
          clanTag: sub.clanTag,
          warState: currentState,
          warStartTime: nextWarStartTime,
          opponentTag: nextOpponentTag || null,
        });
        if (
          (identityCompletion.state === "saved" ||
            identityCompletion.state === "idempotent") &&
          identityCompletion.warId !== null &&
          identityCompletion.warId > 0 &&
          identityCompletion.persistedRevisionAt !== null
        ) {
          resolvedWarId = identityCompletion.warId;
          ownedCurrentWarRevisionAt = identityCompletion.persistedRevisionAt;
        } else {
          return false;
        }
      }
    } else {
      resolvedWarId = currentSubscriptionWarId;
    }
    const resolvedWarIdText =
      resolvedWarId !== null && resolvedWarId !== undefined
        ? String(Math.trunc(Number(resolvedWarId)))
        : null;
    const intendedActiveWarOpponentTag =
      nextOpponentTag || normalizeTag(sub.opponentTag ?? "");
    const sameWarPointsSyncNumber = resolveExactSameWarPointsSyncNumber({
      guildId: sub.guildId,
      clanTag: sub.clanTag,
      pointsWarId: sub.pointsWarId,
      pointsWarStartTime: sub.pointsWarStartTime,
      pointsOpponentTag: sub.pointsOpponentTag,
      pointsSyncNumber: sub.pointsSyncNum,
      intendedWarId: resolvedWarIdText,
      intendedWarStartTime: nextWarStartTime,
      intendedOpponentTag: intendedActiveWarOpponentTag,
    });
    const readCurrentWarSnapshot = () =>
      prisma.currentWar.findUnique({
        where: {
          clanTag_guildId: {
            guildId: sub.guildId,
            clanTag: sub.clanTag,
          },
        },
        select: {
          warId: true,
          syncNumber: true,
          state: true,
          startTime: true,
          opponentTag: true,
          pendingEventType: true,
          pendingEventTargetState: true,
          updatedAt: true,
        },
      });
    const originalSubscriptionIdentity = {
      warId: sub.warId ?? null,
      state: prevState,
      startTime: sub.startTime ?? null,
      opponentTag: normalizeTag(sub.opponentTag ?? null),
      syncNumber: toValidSyncNumber(sub.syncNumber ?? null),
    };
    type CurrentWarRolloverClassification =
      | "original"
      | "intended_next_sync_null"
      | "intended_next_sync_assigned"
      | "stale";
    const matchesExactCurrentWarIdentity = (
      snapshot: {
        warId: number | null;
        syncNumber: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      } | null,
      reference: {
        warId: number | null;
        syncNumber: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      },
    ) => {
      if (!snapshot) return false;
      if (snapshot.warId !== reference.warId) return false;
      if (snapshot.state !== reference.state) return false;
      if (snapshot.startTime?.getTime() !== reference.startTime?.getTime()) {
        return false;
      }
      if (
        normalizeTag(snapshot.opponentTag ?? null) !==
        normalizeTag(reference.opponentTag ?? null)
      ) {
        return false;
      }
      return (
        toValidSyncNumber(snapshot.syncNumber) ===
        toValidSyncNumber(reference.syncNumber)
      );
    };
    const matchesIdentityWithoutSync = (
      snapshot: {
        warId: number | null;
        syncNumber: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      } | null,
      reference: {
        warId: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      },
    ) => {
      if (!snapshot) return false;
      if (snapshot.warId !== reference.warId) return false;
      if (snapshot.state !== reference.state) return false;
      if (snapshot.startTime?.getTime() !== reference.startTime?.getTime()) {
        return false;
      }
      return (
        normalizeTag(snapshot.opponentTag ?? null) ===
        normalizeTag(reference.opponentTag ?? null)
      );
    };
    const classifyCurrentWarRolloverSnapshot = (input: {
      snapshot: {
        warId: number | null;
        syncNumber: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      } | null;
      originalIdentity: typeof originalSubscriptionIdentity;
      intendedIdentity: typeof intendedNextIdentity;
    }): CurrentWarRolloverClassification => {
      if (matchesExactCurrentWarIdentity(input.snapshot, input.originalIdentity)) {
        return "original";
      }
      if (!matchesIdentityWithoutSync(input.snapshot, input.intendedIdentity)) {
        return "stale";
      }
      return toValidSyncNumber(input.snapshot?.syncNumber ?? null) === null
        ? "intended_next_sync_null"
        : "intended_next_sync_assigned";
    };
    type CurrentWarFinalizationClassification =
      | "owned_pre_finalize"
      | "already_finalized_same_identity"
      | "stale_physical_identity"
      | "missing";
    const classifyCurrentWarFinalizationSnapshot = (input: {
      snapshot: {
        warId: number | null;
        syncNumber: number | null;
        state: string | null;
        startTime: Date | null;
        opponentTag: string | null;
      } | null;
      expectedPhysicalIdentity: {
        warId: number | null;
        state: WarState;
        startTime: Date | null;
        opponentTag: string | null;
        syncNumber: number | null;
      };
      previousState: WarState;
      intendedState: WarState;
    }): CurrentWarFinalizationClassification => {
      if (!input.snapshot) return "missing";
      if (input.snapshot.warId !== input.expectedPhysicalIdentity.warId) {
        return "stale_physical_identity";
      }
      if (
        input.snapshot.state !== input.expectedPhysicalIdentity.state &&
        input.snapshot.state !== input.previousState &&
        input.snapshot.state !== input.intendedState
      ) {
        return "stale_physical_identity";
      }
      if (
        input.snapshot.startTime?.getTime() !==
        input.expectedPhysicalIdentity.startTime?.getTime()
      ) {
        return "stale_physical_identity";
      }
      if (
        normalizeTag(input.snapshot.opponentTag ?? null) !==
        normalizeTag(input.expectedPhysicalIdentity.opponentTag ?? null)
      ) {
        return "stale_physical_identity";
      }
      if (
        toValidSyncNumber(input.snapshot.syncNumber) !==
        toValidSyncNumber(input.expectedPhysicalIdentity.syncNumber)
      ) {
        return "stale_physical_identity";
      }
      if (input.snapshot.state === input.intendedState) {
        return "already_finalized_same_identity";
      }
      if (
        input.previousState !== input.intendedState &&
        input.snapshot.state === input.previousState
      ) {
        return "owned_pre_finalize";
      }
      if (input.snapshot.state === input.expectedPhysicalIdentity.state) {
        return "owned_pre_finalize";
      }
      return "stale_physical_identity";
    };
    const isActivePhysicalRollover =
      effectiveWarIdentityChanged && currentState !== "notInWar";
    let currentWarCanonicalSyncNumber = toValidSyncNumber(sub.syncNumber ?? null);
    let currentWarLegacySyncNumber = toValidSyncNumber(sub.syncNum ?? null);
    const currentWarPhysicalIdentity = {
      warId:
        currentState === "notInWar" ? (sub.warId ?? null) : resolvedWarId,
      state: currentState,
      prepStartTime: nextPrepStartTime,
      startTime: nextWarStartTime,
      endTime: nextWarEndTime,
      opponentTag: nextOpponentTag || sub.opponentTag,
      opponentName: nextOpponentName || sub.opponentName,
      clanName: nextClanName,
    };
    const currentWarPendingIdentity =
      currentState === "notInWar"
        ? null
        : {
            ...currentWarPhysicalIdentity,
            pendingEventType:
              currentState === "preparation"
                ? "war_started"
                : currentState === "inWar"
                  ? "battle_day"
                  : null,
            pendingEventTargetState: currentState,
            syncNumber: null,
            syncNum: null,
            fwaPoints: null,
            opponentFwaPoints: null,
            outcome: null,
            matchType: null,
            inferredMatchType: true,
            warStartFwaPoints: null,
            warEndFwaPoints: null,
            clanStars: null,
            opponentStars: null,
          };
    const currentWarFinalizationIdentity = currentWarPhysicalIdentity;
    const rolloverRevisionAt = nextCurrentWarRevision(ownedCurrentWarRevisionAt);
    const intendedNextIdentity = {
      warId: currentWarPhysicalIdentity.warId ?? null,
      state: currentWarPhysicalIdentity.state,
      startTime: currentWarPhysicalIdentity.startTime ?? null,
      opponentTag: normalizeTag(currentWarPhysicalIdentity.opponentTag ?? null),
    };
    if (isActivePhysicalRollover) {
      const currentWarBeforeRollover = await readCurrentWarSnapshot();
      if (!currentWarBeforeRollover) {
        return false;
      }
      const currentWarBeforeRolloverClassification =
        classifyCurrentWarRolloverSnapshot({
          snapshot: currentWarBeforeRollover,
          originalIdentity: originalSubscriptionIdentity,
          intendedIdentity: intendedNextIdentity,
        });
      if (
        currentWarBeforeRollover.updatedAt.getTime() !==
        ownedCurrentWarRevisionAt.getTime()
      ) {
        console.warn(
          `[war-events] event=current_war_rollover result=skipped reason=stale_before_rollover guild=${sub.guildId} clan=${sub.clanTag} original_war=${originalSubscriptionIdentity.warId ?? "none"} original_state=${originalSubscriptionIdentity.state ?? "none"} original_start=${originalSubscriptionIdentity.startTime?.toISOString() ?? "none"} original_opponent=${originalSubscriptionIdentity.opponentTag ? `#${originalSubscriptionIdentity.opponentTag}` : "none"} original_sync=${originalSubscriptionIdentity.syncNumber ?? "none"} observed_war=${currentWarBeforeRollover.warId ?? "none"} observed_state=${currentWarBeforeRollover.state ?? "none"} observed_start=${currentWarBeforeRollover.startTime?.toISOString() ?? "none"} observed_opponent=${currentWarBeforeRollover.opponentTag ? `#${normalizeTag(currentWarBeforeRollover.opponentTag) ?? "unknown"}` : "none"} observed_sync=${currentWarBeforeRollover.syncNumber ?? "none"} intended_war=${intendedNextIdentity.warId ?? "none"} intended_state=${intendedNextIdentity.state ?? "none"} intended_start=${intendedNextIdentity.startTime?.toISOString() ?? "none"} intended_opponent=${intendedNextIdentity.opponentTag ? `#${intendedNextIdentity.opponentTag}` : "none"}`,
        );
        return false;
      }
      if (currentWarBeforeRolloverClassification === "original") {
        const rolloverAttempt = await prisma.currentWar.updateMany({
          where: {
            guildId: sub.guildId,
            clanTag: sub.clanTag,
            updatedAt: currentWarBeforeRollover.updatedAt,
            warId: currentWarBeforeRollover.warId,
            state: currentWarBeforeRollover.state,
            startTime: currentWarBeforeRollover.startTime,
            opponentTag: normalizeTag(currentWarBeforeRollover.opponentTag ?? null),
            syncNumber: currentWarBeforeRollover.syncNumber,
          },
          data: {
            ...currentWarPendingIdentity!,
            updatedAt: rolloverRevisionAt,
          },
        });
        if (rolloverAttempt.count > 1) {
          console.warn(
            `[war-events] rollover rejected guild=${sub.guildId} clan=${sub.clanTag} reason=consistency_conflict updated_count=${rolloverAttempt.count}`,
          );
          return false;
        }
        if (rolloverAttempt.count === 0) {
          const currentWarAfterRollover = await readCurrentWarSnapshot();
          console.warn(
            `[war-events] rollover rejected guild=${sub.guildId} clan=${sub.clanTag} reason=contention_after_rollover_race prev_war=${currentWarBeforeRollover.warId ?? "none"} prev_state=${currentWarBeforeRollover.state ?? "none"} current_war=${currentWarAfterRollover?.warId ?? "none"} current_state=${currentWarAfterRollover?.state ?? "none"} current_start=${currentWarAfterRollover?.startTime?.toISOString() ?? "none"} current_opponent=${currentWarAfterRollover?.opponentTag ? `#${normalizeTag(currentWarAfterRollover.opponentTag) ?? "unknown"}` : "none"} current_sync=${currentWarAfterRollover?.syncNumber ?? "none"}`,
          );
          return false;
        }
        ownedCurrentWarRevisionAt = rolloverRevisionAt;
        currentWarCanonicalSyncNumber = null;
        currentWarLegacySyncNumber = null;
        if (currentWarPendingIdentity) {
          console.info(
            `[war-events] event=current_war_pending_event result=created guild=${sub.guildId} clan=${sub.clanTag} pending_event=${currentWarPendingIdentity.pendingEventType} target_state=${currentWarPendingIdentity.pendingEventTargetState} war_id=${currentWarPendingIdentity.warId ?? "none"} war_start=${currentWarPendingIdentity.startTime?.toISOString() ?? "none"} opponent=${currentWarPendingIdentity.opponentTag ? `#${normalizeTag(currentWarPendingIdentity.opponentTag) ?? "unknown"}` : "none"} revision=${rolloverRevisionAt.toISOString()}`,
          );
        }
      } else if (
        currentWarBeforeRolloverClassification === "intended_next_sync_null" ||
        currentWarBeforeRolloverClassification === "intended_next_sync_assigned"
      ) {
        currentWarCanonicalSyncNumber = toValidSyncNumber(
          currentWarBeforeRollover.syncNumber ?? null,
        );
        currentWarLegacySyncNumber = null;
      } else {
        console.warn(
          `[war-events] event=current_war_rollover result=skipped reason=stale_before_rollover guild=${sub.guildId} clan=${sub.clanTag} original_war=${originalSubscriptionIdentity.warId ?? "none"} original_state=${originalSubscriptionIdentity.state ?? "none"} original_start=${originalSubscriptionIdentity.startTime?.toISOString() ?? "none"} original_opponent=${originalSubscriptionIdentity.opponentTag ? `#${originalSubscriptionIdentity.opponentTag}` : "none"} original_sync=${originalSubscriptionIdentity.syncNumber ?? "none"} observed_war=${currentWarBeforeRollover.warId ?? "none"} observed_state=${currentWarBeforeRollover.state ?? "none"} observed_start=${currentWarBeforeRollover.startTime?.toISOString() ?? "none"} observed_opponent=${currentWarBeforeRollover.opponentTag ? `#${normalizeTag(currentWarBeforeRollover.opponentTag) ?? "unknown"}` : "none"} observed_sync=${currentWarBeforeRollover.syncNumber ?? "none"} intended_war=${intendedNextIdentity.warId ?? "none"} intended_state=${intendedNextIdentity.state ?? "none"} intended_start=${intendedNextIdentity.startTime?.toISOString() ?? "none"} intended_opponent=${intendedNextIdentity.opponentTag ? `#${intendedNextIdentity.opponentTag}` : "none"}`,
        );
        return false;
      }
    }
    const resolveActiveSyncNumber =
      syncContext.resolveActiveSyncNumber ??
      (async (
        input: ActiveWarSyncResolutionInput,
      ): Promise<ActiveWarSyncAssignmentResult> => {
        const isNonFwaMatchType = toSyncIsFwa(
          input.matchType as MatchType | null,
        ) === false;
        const proposedSyncNumber =
          input.currentWarCanonicalSyncNumber ??
          input.currentWarLegacySyncNumber ??
          input.sameWarPointsSyncNumber ??
          null;
        const fallbackSyncNumber =
          input.currentWarCanonicalSyncNumber ??
          (isNonFwaMatchType ? null : input.currentWarLegacySyncNumber) ??
          input.sameWarPointsSyncNumber ??
          null;
        return {
          syncNumber: fallbackSyncNumber,
          proposedSyncNumber,
          usable: fallbackSyncNumber !== null,
          source:
            input.currentWarCanonicalSyncNumber !== null
              ? "existing_current_war"
              : input.currentWarLegacySyncNumber !== null
                ? "existing_current_war"
                : input.sameWarPointsSyncNumber !== null
                  ? "same_war_points_recovery"
                  : "unavailable",
          shouldPersist: false,
          persistence: "not_needed",
          validation: null,
          latestPersistedSyncNumber: syncContext.previousSync,
          activeCycleSyncNumber: syncContext.activeSync,
          sameWarPointsSyncNumber: input.sameWarPointsSyncNumber,
          persistedSyncNumber: fallbackSyncNumber,
          persistedRevisionAt: null,
        };
      });
    const syncAssignment =
      currentState === "notInWar"
        ? null
        : await resolveActiveSyncNumber({
            guildId,
            clanTag: sub.clanTag,
            warState: currentState,
            warId: resolvedWarIdText,
            warStartTime: nextWarStartTime,
            opponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
            currentWarCanonicalSyncNumber,
            currentWarLegacySyncNumber,
            sameWarPointsSyncNumber,
            matchType: nextMatchType,
            inferredMatchType: nextInferredMatchType,
            allowAllocation: true,
            expectedCurrentWarRevisionAt: ownedCurrentWarRevisionAt,
          });
    const assignmentNeedsOwnership =
      Boolean(syncAssignment) &&
      currentWarCanonicalSyncNumber === null &&
      (syncAssignment?.persistence === "conflict" ||
        syncAssignment?.persistence === "revision_changed" ||
        syncAssignment?.persistence === "identity_changed" ||
        syncAssignment?.source === "active_cycle_conflict");
    if (syncAssignment?.persistence === "saved" && syncAssignment.persistedRevisionAt) {
      ownedCurrentWarRevisionAt = syncAssignment.persistedRevisionAt;
    } else if (assignmentNeedsOwnership) {
      return false;
    }
    const nextCanonicalSyncNumber =
      currentState === "notInWar"
        ? currentWarCanonicalSyncNumber
        : syncAssignment?.usable && syncAssignment.syncNumber !== null
          ? syncAssignment.syncNumber
          : currentWarCanonicalSyncNumber;
    const syncNumberForEvent =
      currentState === "notInWar"
        ? await this.resolveNotifyEventSyncNumber({
            guildId,
            clanTag: sub.clanTag,
            warId: resolvedWarIdText,
            warStartTime: nextWarStartTime,
            opponentTag: nextOpponentTag || normalizeTag(sub.opponentTag ?? ""),
            currentState,
            postedSyncNumber: null,
            previousSyncNumber: syncContext.previousSync,
          })
        : nextCanonicalSyncNumber;
    if (outcomeComputationInput) {
      nextOutcome = deriveExpectedOutcome(
        outcomeComputationInput.clanTag,
        outcomeComputationInput.opponentTag,
        outcomeComputationInput.clanPoints,
        outcomeComputationInput.opponentPoints,
        syncNumberForEvent,
      );
    }
    if (preserveConfirmedCurrentWarRevision) {
      nextMatchType = sub.matchType;
      nextOutcome = normalizeOutcome(sub.outcome);
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
        (nextWarStartFwaPoints === null ||
          nextWarStartFwaPoints === undefined) &&
        before !== null
      ) {
        nextWarStartFwaPoints = before;
      }
      nextWarEndFwaPoints = this.computeExpectedWarEndPoints({
        matchType: nextMatchType,
        before,
        finalResult,
        outcome: normalizeOutcome(nextOutcome),
        teamSize: nextTeamSize,
      });
    }
    if (freezeEndedWarMatchDecision) {
      restoreFrozenEndedWarContext();
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
          pointsNeedsValidation: sub.pointsNeedsValidation,
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
        `[war-events] transition detected guild=${sub.guildId} clan=${sub.clanTag} event=${detectedEventPayload.eventType} prev=${prevState} current=${currentState} sync=${syncNumberForEvent ?? "unknown"} warStart=${nextWarStartTime?.toISOString() ?? "unknown"} warEnd=${nextWarEndTime?.toISOString() ?? "unknown"} opponent=${nextOpponentTag || normalizeTag(sub.opponentTag ?? "") || "unknown"}`,
      );
    }

    const expectedFinalizationIdentity = {
      warId: currentWarFinalizationIdentity.warId ?? null,
      state: currentWarFinalizationIdentity.state,
      startTime: currentWarFinalizationIdentity.startTime ?? null,
      opponentTag: normalizeTag(currentWarFinalizationIdentity.opponentTag ?? null),
      syncNumber: nextCanonicalSyncNumber,
    };
    const currentWarBeforeFinalize = await readCurrentWarSnapshot();
    if (!currentWarBeforeFinalize) {
      return false;
    }
    if (
      currentWarBeforeFinalize.updatedAt.getTime() !==
      ownedCurrentWarRevisionAt.getTime()
    ) {
      console.warn(
        `[war-events] event=current_war_finalization result=skipped reason=revision_not_owned guild=${sub.guildId} clan=${sub.clanTag} expected_war=${expectedFinalizationIdentity.warId ?? "none"} expected_state=${expectedFinalizationIdentity.state ?? "none"} expected_start=${expectedFinalizationIdentity.startTime?.toISOString() ?? "none"} expected_opponent=${expectedFinalizationIdentity.opponentTag ? `#${expectedFinalizationIdentity.opponentTag}` : "none"} expected_sync=${expectedFinalizationIdentity.syncNumber ?? "none"} observed_war=${currentWarBeforeFinalize?.warId ?? "none"} observed_state=${currentWarBeforeFinalize?.state ?? "none"} observed_start=${currentWarBeforeFinalize?.startTime?.toISOString() ?? "none"} observed_opponent=${currentWarBeforeFinalize?.opponentTag ? `#${normalizeTag(currentWarBeforeFinalize.opponentTag) ?? "unknown"}` : "none"} observed_sync=${currentWarBeforeFinalize?.syncNumber ?? "none"} observed_updated=${currentWarBeforeFinalize.updatedAt.toISOString()} owned_updated=${ownedCurrentWarRevisionAt.toISOString()}`,
      );
      return false;
    }
    const currentWarBeforeFinalizeClassification =
      classifyCurrentWarFinalizationSnapshot({
        snapshot: currentWarBeforeFinalize,
        expectedPhysicalIdentity: expectedFinalizationIdentity,
        previousState: prevState,
        intendedState: currentState,
      });
    if (
      currentWarBeforeFinalizeClassification === "missing" ||
      currentWarBeforeFinalizeClassification === "stale_physical_identity"
    ) {
      console.warn(
        `[war-events] event=current_war_finalization result=skipped reason=stale_before_finalize guild=${sub.guildId} clan=${sub.clanTag} expected_war=${expectedFinalizationIdentity.warId ?? "none"} expected_state=${expectedFinalizationIdentity.state ?? "none"} expected_start=${expectedFinalizationIdentity.startTime?.toISOString() ?? "none"} expected_opponent=${expectedFinalizationIdentity.opponentTag ? `#${expectedFinalizationIdentity.opponentTag}` : "none"} expected_sync=${expectedFinalizationIdentity.syncNumber ?? "none"} observed_war=${currentWarBeforeFinalize?.warId ?? "none"} observed_state=${currentWarBeforeFinalize?.state ?? "none"} observed_start=${currentWarBeforeFinalize?.startTime?.toISOString() ?? "none"} observed_opponent=${currentWarBeforeFinalize?.opponentTag ? `#${normalizeTag(currentWarBeforeFinalize.opponentTag) ?? "unknown"}` : "none"} observed_sync=${currentWarBeforeFinalize?.syncNumber ?? "none"}`,
      );
      return false;
    }
    const finalizationRevisionAt = nextCurrentWarRevision(
      ownedCurrentWarRevisionAt,
    );
    const finalUpdateData = {
      ...currentWarFinalizationIdentity,
      updatedAt: finalizationRevisionAt,
      syncNumber: nextCanonicalSyncNumber,
      fwaPoints: nextFwaPoints,
      opponentFwaPoints: nextOpponentFwaPoints,
      outcome: nextOutcome,
      matchType: nextMatchType,
      inferredMatchType: nextInferredMatchType,
      warStartFwaPoints: nextWarStartFwaPoints,
      warEndFwaPoints: nextWarEndFwaPoints,
      clanStars: nextClanStars,
      opponentStars: nextOpponentStars,
    };
    const finalizeAttempt = await prisma.currentWar.updateMany({
      where: {
        guildId: sub.guildId,
        clanTag: sub.clanTag,
        updatedAt: ownedCurrentWarRevisionAt,
        warId: currentWarBeforeFinalize.warId,
        syncNumber: currentWarBeforeFinalize.syncNumber,
        state: currentWarBeforeFinalize.state,
        startTime: currentWarBeforeFinalize.startTime,
        opponentTag: normalizeTag(currentWarBeforeFinalize.opponentTag ?? null),
      },
      data: finalUpdateData,
    });
    if (finalizeAttempt.count === 0) {
      const currentWarAfterFinalize = await readCurrentWarSnapshot();
      if (
        !currentWarAfterFinalize ||
        currentWarAfterFinalize.updatedAt.getTime() !==
          ownedCurrentWarRevisionAt.getTime()
      ) {
        console.warn(
          `[war-events] finalize rejected guild=${sub.guildId} clan=${sub.clanTag} reason=revision_not_owned prev_updated=${ownedCurrentWarRevisionAt.toISOString()} current_updated=${currentWarAfterFinalize?.updatedAt?.toISOString() ?? "none"} expected_war=${expectedFinalizationIdentity.warId ?? "none"} expected_state=${expectedFinalizationIdentity.state ?? "none"} expected_start=${expectedFinalizationIdentity.startTime?.toISOString() ?? "none"} expected_opponent=${expectedFinalizationIdentity.opponentTag ? `#${expectedFinalizationIdentity.opponentTag}` : "none"} expected_sync=${expectedFinalizationIdentity.syncNumber ?? "none"} current_war=${currentWarAfterFinalize?.warId ?? "none"} current_state=${currentWarAfterFinalize?.state ?? "none"} current_start=${currentWarAfterFinalize?.startTime?.toISOString() ?? "none"} current_opponent=${currentWarAfterFinalize?.opponentTag ? `#${normalizeTag(currentWarAfterFinalize.opponentTag) ?? "unknown"}` : "none"} current_sync=${currentWarAfterFinalize?.syncNumber ?? "none"}`,
        );
        return false;
      }
      const currentWarAfterFinalizeClassification =
        classifyCurrentWarFinalizationSnapshot({
          snapshot: currentWarAfterFinalize,
          expectedPhysicalIdentity: expectedFinalizationIdentity,
          previousState: prevState,
          intendedState: currentState,
        });
      if (currentWarAfterFinalizeClassification !== "already_finalized_same_identity") {
        const finalizeLossReason =
          currentWarAfterFinalizeClassification === "stale_physical_identity"
            ? "identity_changed"
            : "revision_not_owned";
        console.warn(
          `[war-events] finalize rejected guild=${sub.guildId} clan=${sub.clanTag} reason=${finalizeLossReason} prev_updated=${ownedCurrentWarRevisionAt.toISOString()} current_updated=${currentWarAfterFinalize?.updatedAt?.toISOString() ?? "none"} expected_war=${expectedFinalizationIdentity.warId ?? "none"} expected_state=${expectedFinalizationIdentity.state ?? "none"} expected_start=${expectedFinalizationIdentity.startTime?.toISOString() ?? "none"} expected_opponent=${expectedFinalizationIdentity.opponentTag ? `#${expectedFinalizationIdentity.opponentTag}` : "none"} expected_sync=${expectedFinalizationIdentity.syncNumber ?? "none"} current_war=${currentWarAfterFinalize?.warId ?? "none"} current_state=${currentWarAfterFinalize?.state ?? "none"} current_start=${currentWarAfterFinalize?.startTime?.toISOString() ?? "none"} current_opponent=${currentWarAfterFinalize?.opponentTag ? `#${normalizeTag(currentWarAfterFinalize.opponentTag) ?? "unknown"}` : "none"} current_sync=${currentWarAfterFinalize?.syncNumber ?? "none"}`,
        );
        return false;
      }
    }
    ownedCurrentWarRevisionAt = finalizationRevisionAt;
    if (pendingPointsSyncWrite) {
      await this.currentSyncs
        .upsertPointsSync({
          ...pendingPointsSyncWrite,
          warId: resolvedWarIdText,
        })
        .catch(() => null);
    }
    const newAttackRowsObserved = await this.syncWarAttacksFromWarSnapshot({
      war,
      clanTag: sub.clanTag,
      resolvedWarId,
      fallbackWarStartTime: nextWarStartTime,
    });
    if (maintenanceObservation.maintenanceTransition === "over") {
      options?.maintenanceOverGuildIds?.add(sub.guildId);
    }
    if (
      currentState === "inWar" &&
      newAttackRowsObserved > 0 &&
      resolvedWarId !== null &&
      resolvedWarId !== undefined &&
      Number.isFinite(Number(resolvedWarId)) &&
      Math.trunc(Number(resolvedWarId)) > 0
    ) {
      const policeWarId = Math.trunc(Number(resolvedWarId));
      await this.fwaPolice
        .enforceWarViolations({
          client: this.client,
          guildId: sub.guildId,
          clanTag: sub.clanTag,
          warId: policeWarId,
          warCompliance: this.warCompliance,
        })
        .catch((err) => {
          console.error(
            `[fwa-police] enforce_failed guild=${sub.guildId} clan=${sub.clanTag} warId=${policeWarId} source=poll_cycle error=${formatError(err)}`,
          );
        });
    }
    let dispatchResult: EventDispatchResult | boolean | null = null;
    if (detectedEventPayload) {
      dispatchResult = await this.dispatchDetectedEvent({
        sub,
        payload: detectedEventPayload,
        resolvedWarId,
        sendBattleDaySwapReminders:
          options?.sendBattleDaySwapReminders === true,
      });
    }
    const pendingEventCleanupRequired =
      isEventDeliveryCleanupSuccess(dispatchResult) &&
      (isActivePhysicalRollover || pendingEventResolution.kind === "valid");
    if (pendingEventCleanupRequired && currentWarPendingIdentity) {
      const cleanupRevisionAt = nextCurrentWarRevision(
        ownedCurrentWarRevisionAt,
      );
      const cleanupAttempt = await prisma.currentWar.updateMany({
        where: {
          guildId: sub.guildId,
          clanTag: sub.clanTag,
          updatedAt: ownedCurrentWarRevisionAt,
          warId: currentWarFinalizationIdentity.warId,
          state: currentWarFinalizationIdentity.state,
          startTime: currentWarFinalizationIdentity.startTime,
          opponentTag: normalizeTag(currentWarFinalizationIdentity.opponentTag ?? null),
          syncNumber: nextCanonicalSyncNumber,
          pendingEventType: currentWarPendingIdentity.pendingEventType,
          pendingEventTargetState:
            currentWarPendingIdentity.pendingEventTargetState,
        },
        data: {
          pendingEventType: null,
          pendingEventTargetState: null,
          updatedAt: cleanupRevisionAt,
        },
      });
      if (cleanupAttempt.count === 1) {
        console.info(
          `[war-events] event=current_war_pending_event result=cleared guild=${sub.guildId} clan=${sub.clanTag} pending_event=${currentWarPendingIdentity.pendingEventType} target_state=${currentWarPendingIdentity.pendingEventTargetState} war_id=${currentWarFinalizationIdentity.warId ?? "none"} state=${currentWarFinalizationIdentity.state} start=${currentWarFinalizationIdentity.startTime?.toISOString() ?? "none"} opponent=${currentWarFinalizationIdentity.opponentTag ? `#${normalizeTag(currentWarFinalizationIdentity.opponentTag) ?? "unknown"}` : "none"} sync=${nextCanonicalSyncNumber ?? "none"} revision=${cleanupRevisionAt.toISOString()}`,
        );
        ownedCurrentWarRevisionAt = cleanupRevisionAt;
      } else {
        const currentWarAfterCleanup = await readCurrentWarSnapshot();
        const cleanupReason =
          !currentWarAfterCleanup ||
          currentWarAfterCleanup.updatedAt.getTime() !==
            ownedCurrentWarRevisionAt.getTime()
            ? "revision_not_owned"
            : "identity_changed";
        console.warn(
          `[war-events] event=current_war_pending_event result=cleanup_skipped reason=${cleanupReason} guild=${sub.guildId} clan=${sub.clanTag} pending_event=${currentWarPendingIdentity.pendingEventType} target_state=${currentWarPendingIdentity.pendingEventTargetState} observed_war=${currentWarAfterCleanup?.warId ?? "none"} observed_state=${currentWarAfterCleanup?.state ?? "none"} observed_start=${currentWarAfterCleanup?.startTime?.toISOString() ?? "none"} observed_opponent=${currentWarAfterCleanup?.opponentTag ? `#${normalizeTag(currentWarAfterCleanup.opponentTag) ?? "unknown"}` : "none"} observed_sync=${currentWarAfterCleanup?.syncNumber ?? "none"} observed_revision=${currentWarAfterCleanup?.updatedAt?.toISOString() ?? "none"} expected_war=${currentWarFinalizationIdentity.warId ?? "none"} expected_state=${currentWarFinalizationIdentity.state ?? "none"} expected_start=${currentWarFinalizationIdentity.startTime?.toISOString() ?? "none"} expected_opponent=${currentWarFinalizationIdentity.opponentTag ? `#${normalizeTag(currentWarFinalizationIdentity.opponentTag) ?? "unknown"}` : "none"} expected_sync=${nextCanonicalSyncNumber ?? "none"} revision=${ownedCurrentWarRevisionAt.toISOString()}`,
        );
      }
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
            err,
          )}`,
        );
      });
    }
    return eventType === "war_ended";
  }

  /** Purpose: recover a failed ended-war archive before attack sync can discard the stale rows. */
  private async maybeRecoverEndedWarArchive(params: {
    sub: SubscriptionRow;
  }): Promise<boolean> {
    if (params.sub.state !== "notInWar") return false;
    if (
      String(params.sub.pendingEventType ?? "").trim() ||
      String(params.sub.pendingEventTargetState ?? "").trim()
    ) {
      return false;
    }
    if (!params.sub.startTime) return false;

    const oldAttackRow = await prisma.warAttacks.findFirst({
      where: {
        clanTag: params.sub.clanTag,
        warStartTime: params.sub.startTime,
      },
      orderBy: [{ updatedAt: "desc" }, { attackSeenAt: "desc" }],
      select: {
        opponentClanTag: true,
        warId: true,
      },
    });
    const persistedOpponentTag = normalizeTag(params.sub.opponentTag ?? "");
    const fallbackOpponentTag = normalizeTag(oldAttackRow?.opponentClanTag ?? "");
    const recoveryOpponentTag = persistedOpponentTag || fallbackOpponentTag;
    if (!recoveryOpponentTag) return false;

    const exactCanonicalRow = await this.history.resolveExactCanonicalWarEndedHistoryRow(
      {
        clanTag: params.sub.clanTag,
        opponentTag: recoveryOpponentTag,
        warStartTime: params.sub.startTime,
      },
    );
    if (exactCanonicalRow) return false;
    if (!oldAttackRow) {
      console.warn(
        `[war-events] event=archive_recovery_skipped reason=no_matching_attack_rows guild=${params.sub.guildId} clan=${params.sub.clanTag} war_start=${params.sub.startTime.toISOString()} war_id=${params.sub.warId ?? "unknown"} opponent=${persistedOpponentTag || "unknown"}`,
      );
      return false;
    }

    const recoveryWarId = params.sub.warId ?? oldAttackRow?.warId ?? "unknown";
    try {
      await this.history.persistWarEndHistory({
        eventType: "war_ended",
        guildId: params.sub.guildId,
        clanTag: params.sub.clanTag,
        clanName: String(params.sub.clanName ?? params.sub.clanTag).trim() || params.sub.clanTag,
        opponentTag: recoveryOpponentTag,
        opponentName:
          String(params.sub.opponentName ?? "Unknown").trim() || "Unknown",
        syncNumber: params.sub.syncNum ?? null,
        notifyRole: params.sub.notifyRole,
        fwaPoints: params.sub.fwaPoints,
        opponentFwaPoints: params.sub.opponentFwaPoints,
        outcome: normalizeOutcome(params.sub.outcome),
        matchType: params.sub.matchType,
        warStartFwaPoints: params.sub.warStartFwaPoints,
        warEndFwaPoints: params.sub.warEndFwaPoints,
        clanStars: params.sub.clanStars,
        opponentStars: params.sub.opponentStars,
        prepStartTime: params.sub.prepStartTime,
        warStartTime: params.sub.startTime,
      });
      console.info(
        `[war-events] archive_recovery_success guild=${params.sub.guildId} clan=${params.sub.clanTag} war_start=${params.sub.startTime.toISOString()} war_id=${recoveryWarId} opponent=${recoveryOpponentTag}`,
      );
    } catch (error) {
      console.error(
        `[war-events] archive_recovery_failed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_start=${params.sub.startTime.toISOString()} war_id=${recoveryWarId} opponent=${recoveryOpponentTag} error=${formatError(error)}`,
      );
    }

    return true;
  }

  private async syncWarAttacksFromWarSnapshot(params: {
    war: Awaited<ReturnType<CoCService["getCurrentWar"]>> | null;
    clanTag: string;
    resolvedWarId: number | null;
    fallbackWarStartTime: Date | null;
  }): Promise<number> {
    if (
      params.resolvedWarId === null ||
      params.resolvedWarId === undefined ||
      !Number.isFinite(Number(params.resolvedWarId))
    ) {
      return 0;
    }
    const war = params.war;
    const ownClanTag = normalizeTag(war?.clan?.tag ?? params.clanTag);
    if (!ownClanTag) return 0;
    if (!war?.clan?.tag || !war?.startTime) return 0;

    const ownClanName =
      String(war.clan.name ?? ownClanTag).trim() || ownClanTag;
    const opponentClanTag = normalizeTag(war.opponent?.tag ?? "");
    const opponentClanName =
      String(war.opponent?.name ?? opponentClanTag).trim() || opponentClanTag;
    const warStartTime =
      parseCocTime(war.startTime) ?? params.fallbackWarStartTime;
    if (!warStartTime) return 0;
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
        `,
      );
    }

    const computedAttackRows = computeWarSnapshotAttackRows({
      ownMembers,
      opponentMembers,
    });
    const existingAttackRows = await prisma.warAttacks.findMany({
      where: {
        clanTag: ownClanTag,
        warStartTime,
        attackOrder: { gt: 0 },
      },
      select: {
        playerTag: true,
        attackOrder: true,
      },
    });
    const existingAttackKeys = new Set(
      existingAttackRows.map(
        (row) => `${normalizeTag(row.playerTag)}:${Math.trunc(Number(row.attackOrder))}`,
      ),
    );
    let newAttackRowsObserved = 0;
    for (const row of computedAttackRows) {
      const attackOrder = Math.trunc(Number(row.attackOrder));
      const attackKey = `${normalizeTag(row.playerTag)}:${attackOrder}`;
      if (attackOrder > 0 && !existingAttackKeys.has(attackKey)) {
        existingAttackKeys.add(attackKey);
        newAttackRowsObserved += 1;
      }
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
        `,
      );
    }
    return newAttackRowsObserved;
  }

  private async dispatchDetectedEvent(params: {
    sub: SubscriptionRow;
    payload: EventEmitPayload;
    resolvedWarId: number | null;
    sendBattleDaySwapReminders?: boolean;
  }): Promise<EventDispatchResult> {
    let payloadForDelivery = params.payload;
    let resolvedWarIdForDelivery = params.resolvedWarId;

    if (payloadForDelivery.eventType === "battle_day") {
      await fireBattleDayTransitionWar24hRemindersForClan({
        client: this.client,
        guildId: params.sub.guildId,
        clanTag: params.sub.clanTag,
        clanName: params.sub.clanName ?? payloadForDelivery.clanName,
        warId: resolvedWarIdForDelivery,
        warStartTime:
          payloadForDelivery.warStartTime ?? params.sub.startTime ?? null,
        warEndTime: payloadForDelivery.warEndTime ?? params.sub.endTime ?? null,
        nowMs: Date.now(),
      }).catch((err) => {
        console.error(
          `[reminders] battle_day_transition_failed guild=${params.sub.guildId} clan=${params.sub.clanTag} error=${formatError(err)}`,
        );
      });
    }

    if (params.payload.eventType === "war_ended") {
      await this.history
        .persistWarEndHistory({
          ...params.payload,
          guildId: params.sub.guildId,
        })
        .catch((err) => {
          console.error(
            `[war-events] persist war history failed guild=${params.sub.guildId} clan=${params.sub.clanTag} error=${formatError(err)}`,
          );
        });
      const canonicalized = await this.resolveCanonicalWarEndedPayloadContext(
        params.payload,
      );
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
        teamSize: payloadForDelivery.teamSize ?? null,
      });
      payloadForDelivery = {
        ...payloadForDelivery,
        warEndFwaPoints: canonicalWarEndFwaPoints,
        testFinalResultOverride: canonicalFinalResult,
      };
      if (
        payloadForDelivery.warEndFwaPoints !== params.payload.warEndFwaPoints
      ) {
        await this.history
          .persistWarEndHistory({
            ...payloadForDelivery,
            guildId: params.sub.guildId,
          })
          .catch((err) => {
            console.error(
              `[war-events] persist canonical war history failed guild=${params.sub.guildId} clan=${params.sub.clanTag} error=${formatError(err)}`,
            );
          });
      }
    }

    if (
      params.sendBattleDaySwapReminders === true &&
      payloadForDelivery.eventType === "battle_day"
    ) {
      const battleDayPayload =
        payloadForDelivery as EventEmitPayload & { eventType: "battle_day" };
      await this.sendFwaBaseSwapBattleDayReminder({
        sub: params.sub,
        payload: battleDayPayload,
      });
    }

    if (!params.sub.notify) {
      console.info(
        `[war-events] event=war_event_delivery result=intentionally_suppressed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${resolvedWarIdForDelivery ?? "none"} event_type=${payloadForDelivery.eventType} reason=notifications_disabled`,
      );
      return {
        state: "intentionally_suppressed",
        warId:
          resolvedWarIdForDelivery !== null
            ? String(resolvedWarIdForDelivery)
            : null,
        reason: "notifications_disabled",
      };
    }
    if (!params.sub.channelId) {
      console.warn(
        `[war-events] event=war_event_delivery result=failed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${resolvedWarIdForDelivery ?? "none"} event_type=${payloadForDelivery.eventType} reason=channel_missing`,
      );
      return {
        state: "failed",
        warId:
          resolvedWarIdForDelivery !== null
            ? String(resolvedWarIdForDelivery)
            : null,
        reason: "channel_missing",
      };
    }
    const reserved = await this.reserveEventDelivery({
      sub: params.sub,
      payload: payloadForDelivery,
      resolvedWarId: resolvedWarIdForDelivery,
    });
    if (reserved.state === "delivered_existing") {
      console.log(
        `[war-events] event=war_event_delivery result=existing guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${reserved.warId} event_type=${payloadForDelivery.eventType} message=${reserved.existingMessage.messageId}`,
      );
      if (payloadForDelivery.eventType === "battle_day") {
        battleDayPostByGuildTag.set(
          makeBattleDayPostKey(params.sub.guildId, params.sub.clanTag),
          {
            channelId: reserved.existingMessage.channelId,
            messageId: reserved.existingMessage.messageId,
          },
        );
      }
      return {
        state: "delivered_existing",
        warId: reserved.warId,
        existingMessage: reserved.existingMessage,
      };
    }
    if (reserved.state === "in_flight") {
      console.info(
        `[war-events] event=war_event_delivery result=in_flight guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${reserved.warId ?? "none"} event_type=${payloadForDelivery.eventType} reason=${reserved.reason}`,
      );
      return reserved;
    }
    if (reserved.state === "unavailable") {
      console.warn(
        `[war-events] event=war_event_delivery result=unavailable guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${reserved.warId ?? "none"} event_type=${payloadForDelivery.eventType} reason=${reserved.reason}`,
      );
      return {
        state: "unavailable",
        warId: reserved.warId,
        reason: reserved.reason,
      };
    }
    if (reserved.state !== "claimed") {
      return {
        state: "failed",
        warId:
          resolvedWarIdForDelivery !== null &&
          resolvedWarIdForDelivery !== undefined
            ? String(resolvedWarIdForDelivery)
            : null,
        reason: "unexpected_reservation_state",
      };
    }
    console.log(
      `[war-events] emit start guild=${params.sub.guildId} channel=${params.sub.channelId} clan=${payloadForDelivery.clanTag} event=${payloadForDelivery.eventType}`,
    );
    const delivered = await this.emitEvent(
      params.sub.channelId,
      payloadForDelivery,
      resolvedWarIdForDelivery,
      params.sub,
      reserved.guardCreatedAt,
    );
    if (delivered) {
      console.info(
        `[war-events] event=war_event_delivery result=durable_success guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${reserved.warId} event_type=${payloadForDelivery.eventType} claim_created_at=${reserved.guardCreatedAt.toISOString()}`,
      );
      return {
        state: "delivered_new",
        warId: reserved.warId,
        guardCreatedAt: reserved.guardCreatedAt,
      };
    }
    console.warn(
      `[war-events] event=war_event_delivery result=failed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${reserved.warId} event_type=${payloadForDelivery.eventType} reason=delivery_failed`,
    );
    return {
      state: "failed",
      warId: reserved.warId,
      reason: "delivery_failed",
    };
  }

  private async sendFwaBaseSwapBattleDayReminder(params: {
    sub: SubscriptionRow;
    payload: EventEmitPayload & { eventType: "battle_day" };
  }): Promise<boolean> {
    if (params.payload.matchType !== "BL") {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} reason=non_bl_match_type`,
      );
      return false;
    }

    const candidate =
      await trackedMessageService.findLatestActiveFwaBaseSwapReminderCandidate({
        guildId: params.sub.guildId,
        clanTag: params.sub.clanTag,
      });
    if (!candidate) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} reason=no_reminder_candidate`,
      );
      return false;
    }
    if (!shouldSendFwaBaseSwapBattleDayReminder(candidate.metadata)) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} clan_kind=FWA reason=not_eligible`,
      );
      return false;
    }
    const referenceId = String(candidate.referenceId ?? candidate.messageId).trim();
    const channel = await this.client.channels.fetch(candidate.channelId).catch(() => null);
    if (!isTextSendableChannel(channel)) {
      console.error(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${candidate.referenceId ?? candidate.messageId} channel=${candidate.channelId} reason=tracked_channel_unavailable`,
      );
      await this.logFwaBaseSwapBattleDayReminderFailure({
        sub: params.sub,
        candidate,
        targetChannelId: candidate.channelId,
        reason: "tracked_channel_unavailable",
      });
      return false;
    }

    const clanRoleId = String(params.sub.clanRoleId ?? "").trim();
    if (!clanRoleId) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${referenceId} channel=${candidate.channelId} reason=clan_role_missing`,
      );
      await this.logFwaBaseSwapBattleDayReminderFailure({
        sub: params.sub,
        candidate,
        targetChannelId: candidate.channelId,
        reason: "clan_role_missing",
      });
      return false;
    }

    const claimed = await trackedMessageService.claimFwaBaseSwapBattleDayReminder({
      guildId: params.sub.guildId,
      clanTag: params.sub.clanTag,
      referenceId,
    });
    if (!claimed) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${referenceId} reason=claim_exists`,
      );
      return false;
    }
    console.log(
      `[fwa base-swap] battle-day reminder claim success guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${referenceId}`,
    );

    const reminderContent = buildFwaBaseSwapBattleDayReminderContent({
      clanRoleId,
      matchType: "BL",
    });
    const allowedMentions = { roles: [clanRoleId] };
    const clanRoleMentionIncluded = true;
    const sent = (await channel
      .send({ content: reminderContent, allowedMentions })
      .catch(async (err: unknown) => {
        console.error(
          `[fwa base-swap] battle-day reminder send failed guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${candidate.referenceId ?? candidate.messageId} channel=${candidate.channelId} error=${formatError(err)}`,
        );
        await this.logFwaBaseSwapBattleDayReminderFailure({
          sub: params.sub,
          candidate,
          targetChannelId: candidate.channelId,
          reason: `send_failed:${formatError(err)}`,
        });
        return null;
      })) as any;
    if (!sent) return false;

    console.log(
      `[fwa base-swap] battle-day reminder sent guild=${params.sub.guildId} clan=${params.sub.clanTag} reference=${referenceId} channel=${candidate.channelId} role_ping=${clanRoleId ? "yes" : "no"}`,
    );
    await this.logFwaBaseSwapBattleDayReminder({
      sub: params.sub,
      candidate,
      targetChannelId: candidate.channelId,
      reminderMessageUrl:
        String(sent.url ?? "").trim() ||
        `https://discord.com/channels/${params.sub.guildId}/${candidate.channelId}/${sent.id}`,
      clanRoleMentionIncluded,
    });
    return true;
  }

  async sendCwlBaseSwapBattleDayReminders(): Promise<number> {
    const trackedRows = await prisma.trackedMessage.findMany({
      where: {
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        guildId: true,
        clanTag: true,
        metadata: true,
      },
    });

    const processedClanKeys = new Set<string>();
    let sentCount = 0;
    for (const row of trackedRows) {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (String(metadata?.clanKind ?? "").trim().toUpperCase() !== "CWL") continue;
      if (!shouldSendFwaBaseSwapBattleDayReminder(metadata)) continue;
      const guildId = String(row.guildId ?? "").trim();
      const clanTag = String(row.clanTag ?? "").trim();
      if (!guildId || !clanTag) continue;
      const clanKey = `${guildId}:${normalizeTagBare(clanTag)}`;
      if (processedClanKeys.has(clanKey)) continue;
      processedClanKeys.add(clanKey);

      const sent = await this.sendCwlBaseSwapBattleDayReminderForClan({
        guildId,
        clanTag,
      });
      if (sent) sentCount += 1;
    }

    return sentCount;
  }

  private async sendCwlBaseSwapBattleDayReminderForClan(params: {
    guildId: string;
    clanTag: string;
  }): Promise<boolean> {
    const candidate =
      await trackedMessageService.findLatestActiveFwaBaseSwapTrackedMessageForClan({
        guildId: params.guildId,
        clanTag: params.clanTag,
        clanKind: "CWL",
      });
    if (!candidate) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.guildId} clan=${params.clanTag} clan_kind=CWL reason=no_active_tracked_message`,
      );
      return false;
    }
    if (!shouldSendFwaBaseSwapBattleDayReminder(candidate.metadata)) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.guildId} clan=${params.clanTag} clan_kind=CWL reason=not_eligible`,
      );
      return false;
    }

    const battleDayState = await resolveCwlBattleDayReminderStateForClan({
      clanTag: params.clanTag,
    });
    if (!battleDayState) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.guildId} clan=${params.clanTag} clan_kind=CWL reason=not_battle_day`,
      );
      return false;
    }

    const referenceId = String(candidate.referenceId ?? candidate.messageId).trim();
    const channel = await this.client.channels.fetch(candidate.channelId).catch(() => null);
    if (!isTextSendableChannel(channel)) {
      console.error(
        `[fwa base-swap] battle-day reminder skipped guild=${params.guildId} clan=${params.clanTag} reference=${candidate.referenceId ?? candidate.messageId} channel=${candidate.channelId} reason=tracked_channel_unavailable`,
      );
      await this.logFwaBaseSwapBattleDayReminderFailure({
        sub: {
          guildId: params.guildId,
          clanTag: params.clanTag,
          clanName: candidate.metadata.clanName ?? null,
        } as SubscriptionRow,
        candidate: candidate as any,
        targetChannelId: candidate.channelId,
        reason: "tracked_channel_unavailable",
      });
      return false;
    }

    const rosterRoleId = await resolveCwlBattleDayReminderRoleId({
      guildId: params.guildId,
      clanTag: params.clanTag,
      battleDayState,
    });
    const claimed = await trackedMessageService.claimFwaBaseSwapBattleDayReminder({
      guildId: params.guildId,
      clanTag: params.clanTag,
      referenceId,
      battleDayIdentity: buildBattleDayReminderIdentity({
        kind: "CWL",
        guildId: params.guildId,
        clanTag: params.clanTag,
        referenceId,
        battleDayStart: battleDayState.startTime,
        roundDay: battleDayState.roundDay,
        season: battleDayState.season,
      }),
    });
    if (!claimed) {
      console.warn(
        `[fwa base-swap] battle-day reminder skipped guild=${params.guildId} clan=${params.clanTag} reference=${referenceId} reason=claim_exists`,
      );
      return false;
    }
    console.log(
      `[fwa base-swap] battle-day reminder claim success guild=${params.guildId} clan=${params.clanTag} reference=${referenceId}`,
    );

    const reminderContent = buildFwaBaseSwapBattleDayReminderContent({
      clanRoleId: rosterRoleId,
      matchType: "CWL",
    });
    const allowedMentions = normalizeBattleDayReminderAllowedMentions(rosterRoleId);
    const clanRoleMentionIncluded =
      "roles" in allowedMentions && allowedMentions.roles.length > 0;

    const sent = (await channel
      .send({ content: reminderContent, allowedMentions })
      .catch(async (err: unknown) => {
        console.error(
          `[fwa base-swap] battle-day reminder send failed guild=${params.guildId} clan=${params.clanTag} reference=${candidate.referenceId ?? candidate.messageId} channel=${candidate.channelId} error=${formatError(err)}`,
        );
        await this.logFwaBaseSwapBattleDayReminderFailure({
          sub: {
            guildId: params.guildId,
            clanTag: params.clanTag,
            clanName: candidate.metadata.clanName ?? null,
          } as SubscriptionRow,
          candidate: candidate as any,
          targetChannelId: candidate.channelId,
          reason: `send_failed:${formatError(err)}`,
        });
        return null;
      })) as any;
    if (!sent) return false;

    console.log(
      `[fwa base-swap] battle-day reminder sent guild=${params.guildId} clan=${params.clanTag} reference=${referenceId} channel=${candidate.channelId} role_ping=${clanRoleMentionIncluded ? "yes" : "no"}`,
    );
    await this.logFwaBaseSwapBattleDayReminder({
      sub: {
        guildId: params.guildId,
        clanTag: params.clanTag,
        clanName: candidate.metadata.clanName ?? null,
      } as SubscriptionRow,
      candidate: candidate as any,
      targetChannelId: candidate.channelId,
      reminderMessageUrl:
        String(sent.url ?? "").trim() ||
        `https://discord.com/channels/${params.guildId}/${candidate.channelId}/${sent.id}`,
      clanRoleMentionIncluded,
    });
    return true;
  }

  private async logFwaBaseSwapBattleDayReminderFailure(params: {
    sub: SubscriptionRow;
    candidate: Awaited<
      ReturnType<typeof trackedMessageService.findLatestActiveFwaBaseSwapReminderCandidate>
    > extends infer T
      ? NonNullable<T>
      : never;
    targetChannelId: string | null;
    reason: string;
  }): Promise<void> {
    const logChannel = await resolveBotLogChannel(
      this.client,
      params.sub.guildId,
      this.botLogChannels,
    );
    if (!logChannel) return;

    try {
      await logChannel.send({
        content: [
          "FWA base-swap battle-day reminder failed",
          `/fwa base-swap reminder tied to ${params.sub.clanName ?? params.candidate.metadata.clanName} (#${params.sub.clanTag})`,
          `Target channel: ${String(params.targetChannelId ?? "").trim() ? `<#${String(params.targetChannelId).trim()}>` : "unknown"}`,
          `Base-swap reference id: ${params.candidate.referenceId ?? params.candidate.messageId}`,
          `Failure reason: ${params.reason}`,
        ].join("\n"),
      });
    } catch {
      // non-blocking
    }
  }

  private async logFwaBaseSwapBattleDayReminder(params: {
    sub: SubscriptionRow;
    candidate: Awaited<
      ReturnType<typeof trackedMessageService.findLatestActiveFwaBaseSwapReminderCandidate>
    > extends infer T
      ? NonNullable<T>
      : never;
    targetChannelId: string;
    reminderMessageUrl: string;
    clanRoleMentionIncluded: boolean;
  }): Promise<void> {
    const logChannel = await resolveBotLogChannel(
      this.client,
      params.sub.guildId,
      this.botLogChannels,
    );
    if (!logChannel) return;

    try {
      await logChannel.send({
        content: buildFwaBaseSwapBattleDayReminderLogContent({
          clanName: params.sub.clanName ?? params.candidate.metadata.clanName,
          clanTag: params.sub.clanTag,
          targetChannelId: params.targetChannelId,
          reminderMessageUrl: params.reminderMessageUrl,
          referenceId: params.candidate.referenceId ?? params.candidate.messageId,
          clanRoleMentionIncluded: params.clanRoleMentionIncluded,
        }),
      });
    } catch {
      // non-blocking: reminder delivery must succeed even if bot-log posting fails
    }
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

    const fingerprint = buildWarEndDiscrepancyFingerprint(
      warId,
      expectedPoints,
      actualPoints,
    );
    const previousFingerprint = parseWarEndDiscrepancyFingerprint(
      trackedMessage.configHash,
    );
    if (previousFingerprint === fingerprint) return;

    const warningContent =
      `${buildWarEndMismatchWarningHeadline(clanTag)}\n` +
      `${historyRow?.clanName ?? clanTag} (War ID: ${Math.trunc(warId)}).\n` +
      `Expected points: ${expectedPoints}\n` +
      `Actual points: ${actualPoints}`;

    let alerted = false;
    const channel = await this.client.channels
      .fetch(trackedMessage.channelId)
      .catch(() => null);
    if (channel && channel.isTextBased()) {
      const message = await (channel as any).messages
        .fetch(trackedMessage.messageId)
        .catch(() => null);
      if (message) {
        const edited = buildWarEndDiscrepancyContent({
          existingPostedContent: String(message.content ?? ""),
          clanTag,
          opponentName: historyRow?.opponentName ?? params.fallbackOpponentName,
          expectedPoints,
          actualPoints,
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
          allowedMentions: { parse: [] },
        })
        .catch(() => null);
      alerted = Boolean(sent);
    }
    if (!alerted) return;

    await prisma.clanPostedMessage
      .update({
        where: { id: trackedMessage.id },
        data: {
          configHash: writeWarEndDiscrepancyFingerprint(
            trackedMessage.configHash,
            fingerprint,
          ),
        },
      })
      .catch(() => null);
  }

  private async tryCreateEventGuard(
    warId: string,
    clanTag: string,
    eventType: string,
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
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        console.log(
          `[WarEvent] Duplicate ${eventType} skipped clan=#${normalizeTag(clanTag)} warId=${warId}`,
        );
        return false;
      }
      throw error;
    }
  }

  private buildNotifyConfigHash(
    sub: SubscriptionRow,
    eventType: EventType,
  ): string {
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
  }): Promise<EventDeliveryReservation> {
    const eventType = params.payload.eventType;
    const clanTag = normalizeTag(params.payload.clanTag);
    const warId =
      params.resolvedWarId ??
      params.sub.warId ??
      (await this.resolveWarId(
        params.payload.clanTag,
        params.payload.warStartTime,
      ));
    if (
      warId === null ||
      warId === undefined ||
      !Number.isFinite(Number(warId))
    ) {
      console.warn(
        `[war-events] emit skipped guild=${params.sub.guildId} clan=${params.sub.clanTag} event=${eventType} reason=missing_war_id_for_idempotency`,
      );
      return {
        state: "unavailable",
        warId: null,
        reason: "missing_war_id_for_idempotency",
      };
    }
    const warIdText = String(Math.trunc(Number(warId)));
    let existingMessage:
      | Awaited<
          ReturnType<PostedMessageService["findExistingMessage"]>
        >
      | null = null;
    try {
      existingMessage = await this.postedMessages.findExistingMessage({
        guildId: params.sub.guildId,
        clanTag,
        warId: warIdText,
        type: "notify",
        event: eventType,
      });
    } catch (err) {
      console.warn(
        `[war-events] event=war_event_delivery_reservation result=unavailable guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} reason=existing_message_lookup_failed error=${formatError(err)}`,
      );
      return {
        state: "unavailable",
        warId: warIdText,
        reason: "existing_message_lookup_failed",
      };
    }
    if (existingMessage) {
      return {
        state: "delivered_existing",
        existingMessage: {
          channelId: existingMessage.channelId,
          messageId: existingMessage.messageId,
        },
        warId: warIdText,
      };
    }
    const existingReservation = await prisma.warEvent
      .findFirst({
        where: {
          warId: Math.trunc(Number(warIdText)),
          clanTag,
          eventType,
        },
        select: {
          createdAt: true,
        },
      })
      .catch((err) => {
        console.warn(
          `[war-events] event=war_event_delivery_reservation result=unavailable guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} reason=reservation_lookup_failed error=${formatError(err)}`,
        );
        return null;
      });
    if (existingReservation) {
      if (!isWarEventReservationExpired(existingReservation.createdAt)) {
        return {
          state: "in_flight",
          warId: warIdText,
          reason: "reservation_in_flight",
        };
      }
      const reclaimed = await prisma.warEvent
        .deleteMany({
          where: {
            warId: Math.trunc(Number(warIdText)),
            clanTag,
            eventType,
            createdAt: existingReservation.createdAt,
          },
        })
        .catch((err) => {
          console.warn(
            `[war-events] event=war_event_delivery_reservation result=unavailable guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} reason=reservation_reclaim_failed error=${formatError(err)}`,
          );
          return null;
        });
      if (!reclaimed || reclaimed.count !== 1) {
        return {
          state: "in_flight",
          warId: warIdText,
          reason: "reservation_ownership_lost",
        };
      }
      console.info(
        `[war-events] event=war_event_delivery_reservation result=reclaimed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} claim_created_at=${existingReservation.createdAt.toISOString()}`,
      );
    }
    const createdReservation = await prisma.warEvent
      .create({
        data: {
          warId: Math.trunc(Number(warIdText)),
          clanTag,
          eventType,
          payload: {},
        },
      })
      .catch((err) => {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          return null;
        }
        console.warn(
          `[war-events] event=war_event_delivery_reservation result=unavailable guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} reason=reservation_create_failed error=${formatError(err)}`,
        );
        return null;
      });
    if (!createdReservation) {
      return {
        state: "in_flight",
        warId: warIdText,
        reason: "reservation_already_claimed",
      };
    }
    console.info(
      `[war-events] event=war_event_delivery_reservation result=claimed guild=${params.sub.guildId} clan=${params.sub.clanTag} war_id=${warIdText} event_type=${eventType} claim_created_at=${createdReservation.createdAt.toISOString()}`,
    );
    return {
      state: "claimed",
      warId: warIdText,
      guardCreatedAt: createdReservation.createdAt,
    };
  }

  private async resolveWarId(
    clanTagInput: string,
    warStartTime: Date | null,
  ): Promise<number | null> {
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
    payload: EventEmitPayload,
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
        clanName:
          String(canonical.clanName ?? payload.clanName).trim() ||
          payload.clanName,
        opponentTag: canonical.opponentTag || payload.opponentTag,
        opponentName:
          String(canonical.opponentName ?? payload.opponentName).trim() ||
          payload.opponentName,
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
    sub?: SubscriptionRow,
    reservationGuardCreatedAt?: Date | null,
  ): Promise<boolean> {
    let warId = resolvedWarIdOverride ?? null;
    const releaseReservation = async (reason: string): Promise<void> => {
      if (!reservationGuardCreatedAt) return;
      await this.releaseEventDelivery({
        warId:
          warId !== null && warId !== undefined
            ? String(Math.trunc(Number(warId)))
            : null,
        clanTag: payload.clanTag,
        eventType: payload.eventType,
        guardCreatedAt: reservationGuardCreatedAt,
        reason,
      });
    };
    const channel = await this.client.channels
      .fetch(channelId)
      .catch(() => null);
    if (!channel) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_found`,
      );
      await releaseReservation("channel_not_found");
      return false;
    }
    if (!channel.isTextBased()) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_text_based`,
      );
      await releaseReservation("channel_not_text_based");
      return false;
    }
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread
    ) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=unsupported_channel_type type=${channel.type}`,
      );
      await releaseReservation("unsupported_channel_type");
      return false;
    }

    const guildId = (channel as { guildId?: string }).guildId ?? null;
    warId =
      warId ?? (await this.resolveWarId(payload.clanTag, payload.warStartTime));
    const roleId = normalizeNotifyRoleId(payload.notifyRole);
    const includeRoleMentionForPost = payload.pingRole;

    let warEndedStateForSend: NotifyWarEndedViewState | null = null;
    let embed: EmbedBuilder;
    let components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (payload.eventType === "war_ended") {
      const initialTimestampUnix = resolveWarEndedMetadataTimestampUnix(
        payload.warEndTime,
        new Date(),
      );
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
      embed = this.buildWarEndedViewMessage(
        warEndedStateForSend,
        "s",
        0,
        false,
      ).embed;
    } else {
      const opponentTag = normalizeTag(payload.opponentTag);
      embed = new EmbedBuilder()
        .setTitle(
          `Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`,
        )
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
          payload.clanName,
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
          payload.clanName,
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
                  .setCustomId(
                    buildNotifyWarRefreshCustomId(guildId, payload.clanTag),
                  )
                  .setLabel("Refresh")
                  .setStyle(ButtonStyle.Secondary),
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
          `[war-events] send failed channel=${channelId} clan=${payload.clanTag} error=${formatError(err)}`,
        );
        return null;
      });
    if (sent) {
      if (guildId && sub && warId !== null && warId !== undefined) {
        const savedMessage = await this.postedMessages
          .savePostedMessage({
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
          })
          .catch((err) => {
            console.error(
              `[war-events] persist posted message failed guild=${guildId} clan=${payload.clanTag} event=${payload.eventType} message=${sent.id} error=${formatError(err)}`,
            );
            return null;
          });
        if (!savedMessage) {
          await releaseReservation("posted_message_persistence_failed");
          return false;
        }
      }

      if (guildId) {
        const key = makeBattleDayPostKey(guildId, payload.clanTag);
        if (payload.eventType === "battle_day") {
          battleDayPostByGuildTag.set(key, { channelId, messageId: sent.id });
        } else {
          battleDayPostByGuildTag.delete(key);
        }
      }

      if (
        payload.eventType === "war_ended" &&
        warEndedStateForSend &&
        guildId
      ) {
        const finalizedState: NotifyWarEndedViewState = {
          ...warEndedStateForSend,
          guildId,
          warId:
            warId !== null &&
            warId !== undefined &&
            Number.isFinite(Number(warId))
              ? Math.trunc(Number(warId))
              : warEndedStateForSend.warId,
          messageId: sent.id,
          timestampUnix: resolveWarEndedMetadataTimestampUnix(
            payload.warEndTime,
            new Date(sent.createdTimestamp),
          ),
        };
        const rendered = this.buildWarEndedViewMessage(
          finalizedState,
          "s",
          0,
          true,
        );
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
        `[war-events] emit success guild=${guildId ?? "unknown"} channel=${channelId} message=${sent.id} clan=${payload.clanTag} event=${payload.eventType}`,
      );
    }
    if (!sent) {
      await releaseReservation("send_failed");
    }
    return Boolean(sent);
  }

  private async releaseEventDelivery(params: {
    warId: string | null;
    clanTag: string;
    eventType: string;
    guardCreatedAt: Date | null | undefined;
    reason: string;
  }): Promise<boolean> {
    if (!params.guardCreatedAt) {
      return false;
    }
    const warId = params.warId;
    if (warId === null || warId === undefined || !Number.isFinite(Number(warId))) {
      console.warn(
        `[war-events] event=war_event_delivery_reservation result=release_skipped clan=${params.clanTag} event_type=${params.eventType} reason=invalid_war_id cleanup_reason=${params.reason}`,
      );
      return false;
    }
    try {
      const released = await prisma.warEvent.deleteMany({
        where: {
          warId: Math.trunc(Number(warId)),
          clanTag: normalizeTag(params.clanTag),
          eventType: params.eventType,
          createdAt: params.guardCreatedAt,
        },
      });
      if (released.count === 1) {
        console.info(
          `[war-events] event=war_event_delivery_reservation result=released clan=${params.clanTag} event_type=${params.eventType} cleanup_reason=${params.reason} claim_created_at=${params.guardCreatedAt.toISOString()}`,
        );
        return true;
      }
      console.info(
        `[war-events] event=war_event_delivery_reservation result=release_skipped clan=${params.clanTag} event_type=${params.eventType} cleanup_reason=${params.reason} reason=ownership_lost`,
      );
      return false;
    } catch (err) {
      console.warn(
        `[war-events] event=war_event_delivery_reservation result=release_skipped clan=${params.clanTag} event_type=${params.eventType} cleanup_reason=${params.reason} error=${formatError(err)}`,
      );
      return false;
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
      battleDayPostByGuildTag.set(
        makeBattleDayPostKey(stored.guildId, stored.clanTag),
        {
          channelId: stored.channelId,
          messageId: stored.messageId,
        },
      );
    }
    const keys = [...battleDayPostByGuildTag.keys()];
    for (const key of keys) {
      await this.refreshBattleDayPostByKey(key).catch((err) => {
        console.error(
          `[war-events] battle-day refresh failed key=${key} error=${formatError(err)}`,
        );
      });
    }
  }

  async refreshBattleDayPostByInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
    const parsed = parseNotifyWarRefreshCustomId(interaction.customId);
    if (!parsed) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          ephemeral: true,
          content: "Invalid refresh action.",
        });
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

  async toggleWarEndedViewByInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
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
      toWarEndedViewStateKey(parsed.guildId, parsed.messageId),
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
      true,
    );
    await interaction.update({
      embeds: [rendered.embed],
      components: rendered.components,
    });
  }

  async refreshCurrentNotifyPost(
    guildId: string,
    clanTagInput: string,
  ): Promise<boolean> {
    const clanTag = normalizeTag(clanTagInput);
    if (!guildId || !clanTag) return false;

    const sub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!sub || !sub.notify) return false;

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    if (!war) return false;

    const state = deriveState(String(war.state ?? ""));
    if (state !== "preparation" && state !== "inWar") return false;

    const prepStartTime =
      parseCocTime(war.preparationStartTime ?? null) ??
      sub.prepStartTime ??
      null;
    const warStartTime =
      parseCocTime(war.startTime ?? null) ?? sub.startTime ?? null;
    const warEndTime = parseCocTime(war.endTime ?? null) ?? sub.endTime ?? null;
    const nextClanName =
      String(war.clan?.name ?? sub.clanName ?? sub.clanTag).trim() ||
      sub.clanTag;
    const nextOpponentTag = normalizeTag(
      war.opponent?.tag ?? sub.opponentTag ?? "",
    );
    const nextOpponentName =
      String(war.opponent?.name ?? sub.opponentName ?? "Unknown").trim() ||
      "Unknown";
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

    const refreshedSub = await this.findSubscriptionByGuildAndTag(
      guildId,
      clanTag,
    );
    if (!refreshedSub) return false;

    const warIdText =
      resolvedWarId !== null &&
      resolvedWarId !== undefined &&
      Number.isFinite(Number(resolvedWarId))
        ? String(Math.trunc(Number(resolvedWarId)))
        : refreshedSub.warId !== null && refreshedSub.warId !== undefined
          ? String(Math.trunc(Number(refreshedSub.warId)))
          : null;
    if (!warIdText) return false;

    const eventType: EventType =
      state === "preparation" ? "war_started" : "battle_day";
    const existingMessage = await this.postedMessages.findExistingMessage({
      guildId,
      clanTag,
      warId: warIdText,
      type: "notify",
      event: eventType,
    });
    if (!existingMessage) return false;

    const channel = await this.client.channels
      .fetch(existingMessage.channelId)
      .catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    const message = await (channel as any).messages
      .fetch(existingMessage.messageId)
      .catch(() => null);
    if (!message) return false;

    const syncNumber = await this.resolveNotifyEventSyncNumber({
      guildId,
      clanTag,
      warId: warIdText,
      warStartTime,
      opponentTag: nextOpponentTag,
      currentState: state,
      postedSyncNumber: toValidSyncNumber(existingMessage.syncNum),
      allowPostedSyncReuse: true,
    });

    const basePayload = {
      clanTag: refreshedSub.clanTag,
      clanName: nextClanName,
      opponentTag: nextOpponentTag,
      opponentName: nextOpponentName,
      syncNumber,
      pointsNeedsValidation: refreshedSub.pointsNeedsValidation,
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
      clanAttacks: Number.isFinite(Number(war.clan?.attacks))
        ? Number(war.clan?.attacks)
        : null,
      opponentAttacks: Number.isFinite(Number(war.opponent?.attacks))
        ? Number(war.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(war.teamSize))
        ? Number(war.teamSize)
        : null,
      attacksPerMember: Number.isFinite(Number(war.attacksPerMember))
        ? Number(war.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(war.clan?.destructionPercentage))
        ? Number(war.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(
        Number(war.opponent?.destructionPercentage),
      )
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
      const next = await this.buildBattleDayRefreshEmbed(
        payload,
        Number(warIdText),
        guildId,
        embed,
      );
      const refreshEditPayload = buildBattleDayRefreshEditPayload(
        String(message.content ?? ""),
        payload.opponentName,
        Date.now(),
        !shouldSuppressBattleDayNotifyRoleMention(
          payload.eventType,
          payload.pointsNeedsValidation,
        ),
      );
      await message.edit({
        content: refreshEditPayload.content,
        allowedMentions: refreshEditPayload.allowedMentions,
        embeds: [next],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(
                buildNotifyWarRefreshCustomId(guildId, payload.clanTag),
              )
              .setLabel("Refresh")
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return true;
    }

    const payload = { ...basePayload, eventType: "war_started" as const };
    const next = await this.buildWarStartedRefreshEmbed(
      payload,
      Number(warIdText),
      guildId,
    );
    await message.edit({
      content: message.content || undefined,
      embeds: [next],
      components: [],
    });
    return true;
  }

  private async refreshBattleDayPostByKey(
    key: string,
  ): Promise<"refreshed" | "frozen" | "missing"> {
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

    const channel = await this.client.channels
      .fetch(tracked.channelId)
      .catch(() => null);
    if (!channel || !channel.isTextBased()) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }
    const message = await (channel as any).messages
      .fetch(tracked.messageId)
      .catch(() => null);
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

    const prepStartTime =
      parseCocTime(war.preparationStartTime ?? null) ??
      sub.prepStartTime ??
      null;
    const warStartTime =
      parseCocTime(war.startTime ?? null) ?? sub.startTime ?? null;
    const warEndTime = parseCocTime(war.endTime ?? null);
    const nextClanName =
      String(war.clan?.name ?? sub.clanName ?? sub.clanTag).trim() ||
      sub.clanTag;
    const nextOpponentTag = normalizeTag(
      war.opponent?.tag ?? sub.opponentTag ?? "",
    );
    const nextOpponentName =
      String(war.opponent?.name ?? sub.opponentName ?? "Unknown").trim() ||
      "Unknown";
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

    const refreshedSub = await this.findSubscriptionByGuildAndTag(
      guildId,
      clanTag,
    );
    if (!refreshedSub) {
      battleDayPostByGuildTag.delete(key);
      return "missing";
    }

    const resolvedWarIdText =
      resolvedWarId !== null && resolvedWarId !== undefined
        ? String(Math.trunc(Number(resolvedWarId)))
        : refreshedSub.warId !== null && refreshedSub.warId !== undefined
          ? String(Math.trunc(Number(refreshedSub.warId)))
          : null;
    const existingMessage = await this.postedMessages.findExistingMessage({
      guildId,
      clanTag,
      warId: resolvedWarIdText,
      type: "notify",
      event: "battle_day",
    });
    const postedSyncNumber =
      existingMessage &&
      existingMessage.channelId === tracked.channelId &&
      existingMessage.messageId === tracked.messageId
        ? toValidSyncNumber(existingMessage.syncNum)
        : null;
    const syncNumber = await this.resolveNotifyEventSyncNumber({
      guildId,
      clanTag,
      warId: resolvedWarIdText,
      warStartTime,
      opponentTag: nextOpponentTag || refreshedSub.opponentTag,
      currentState: "inWar",
      postedSyncNumber,
      allowPostedSyncReuse: true,
    });

    const payload = {
      eventType: "battle_day" as const,
      clanTag: refreshedSub.clanTag,
      clanName:
        String(
          war.clan?.name ?? refreshedSub.clanName ?? refreshedSub.clanTag,
        ).trim() || refreshedSub.clanTag,
      opponentTag: normalizeTag(
        war.opponent?.tag ?? refreshedSub.opponentTag ?? "",
      ),
      opponentName:
        String(
          war.opponent?.name ?? refreshedSub.opponentName ?? "Unknown",
        ).trim() || "Unknown",
      syncNumber,
      pointsNeedsValidation: refreshedSub.pointsNeedsValidation,
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
      clanAttacks: Number.isFinite(Number(war.clan?.attacks))
        ? Number(war.clan?.attacks)
        : null,
      opponentAttacks: Number.isFinite(Number(war.opponent?.attacks))
        ? Number(war.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(war.teamSize))
        ? Number(war.teamSize)
        : null,
      attacksPerMember: Number.isFinite(Number(war.attacksPerMember))
        ? Number(war.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(war.clan?.destructionPercentage))
        ? Number(war.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(
        Number(war.opponent?.destructionPercentage),
      )
        ? Number(war.opponent?.destructionPercentage)
        : null,
    };
    const warId = resolvedWarId ?? refreshedSub.warId ?? null;
    const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder());
    const next = await this.buildBattleDayRefreshEmbed(
      payload,
      warId,
      guildId,
      embed,
    );
    const refreshEditPayload = buildBattleDayRefreshEditPayload(
      String(message.content ?? ""),
      payload.opponentName,
      Date.now(),
      !shouldSuppressBattleDayNotifyRoleMention(
        payload.eventType,
        payload.pointsNeedsValidation,
      ),
    );
    await message.edit({
      content: refreshEditPayload.content,
      allowedMentions: refreshEditPayload.allowedMentions,
      embeds: [next],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(
              buildNotifyWarRefreshCustomId(guildId, payload.clanTag),
            )
            .setLabel("Refresh")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    return "refreshed";
  }

  private async resolveNotifyEventSyncNumber(input: {
    guildId: string;
    clanTag: string;
    warId: string | null;
    warStartTime: Date | null;
    opponentTag?: string | null;
    currentState: WarState;
    postedSyncNumber: number | null;
    previousSyncNumber?: number | null;
    allowPostedSyncReuse?: boolean;
  }): Promise<number | null> {
    const sameWarSync = await this.currentSyncs
      .getCurrentSyncForClan({
        guildId: input.guildId,
        clanTag: input.clanTag,
        warId: input.warId,
        warStartTime: input.warStartTime,
      })
      .catch(() => null);
    const sameWarPersistedSyncNumber = toValidSyncNumber(sameWarSync?.syncNum ?? null);
    const postedSyncNumber = toValidSyncNumber(input.postedSyncNumber);
    const preferredBaseline = toValidSyncNumber(input.previousSyncNumber ?? null);
    const needsLatestPersistedBaseline =
      sameWarPersistedSyncNumber === null &&
      !(input.allowPostedSyncReuse && postedSyncNumber !== null) &&
      preferredBaseline === null;
    const latestPersistedSyncNumber = needsLatestPersistedBaseline
      ? toValidSyncNumber(
          await this.syncResolution.getLatestPersistedSyncBaseline({
            guildId: input.guildId,
          }),
        )
      : preferredBaseline;
    const identity = buildActiveWarSyncIdentity({
      warState: input.currentState,
      warId: input.warId,
      warStartTime: input.warStartTime,
      opponentTag: input.opponentTag ?? null,
    });
    const resolution = resolveActiveWarSyncNumber({
      identity,
      latestPersistedSyncNumber,
      sameWarPersistedSyncNumber,
      postedSyncNumber,
      allowPostedSyncReuse: input.allowPostedSyncReuse,
    });
    logActiveWarSyncResolution({
      stage: input.allowPostedSyncReuse
        ? "notify_refresh_sync"
        : "notify_event_sync",
      guildId: input.guildId,
      clanTag: input.clanTag,
      resolution,
    });
    return resolution.syncNumber;
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
    _previous: EmbedBuilder,
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
      payload.clanName,
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
    guildId: string,
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
      payload.clanName,
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

export function buildNotifyWarRefreshCustomId(
  guildId: string,
  clanTag: string,
): string {
  return `${NOTIFY_WAR_REFRESH_PREFIX}:${guildId}:${normalizeTagBare(clanTag)}`;
}

export function parseNotifyWarRefreshCustomId(
  customId: string,
): { guildId: string; clanTag: string } | null {
  const [prefix, guildId, clanTagBare] = String(customId ?? "").split(":");
  if (prefix !== NOTIFY_WAR_REFRESH_PREFIX || !guildId || !clanTagBare)
    return null;
  return { guildId, clanTag: normalizeTag(clanTagBare) };
}

export function isNotifyWarRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_REFRESH_PREFIX}:`);
}

export async function handleNotifyWarRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const service = new WarEventLogService(interaction.client, new CoCService());
  await service.refreshBattleDayPostByInteraction(interaction);
}

export async function handleNotifyWarEndedViewButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const service = new WarEventLogService(interaction.client, new CoCService());
  await service.toggleWarEndedViewByInteraction(interaction);
}

export const notifyWarBattleDayRefreshIntervalMs = BATTLE_DAY_REFRESH_MS;
