import { Client, EmbedBuilder } from "discord.js";
import { normalizeClanTag } from "./PlayerLinkService";
import { resolveFwaMatchStateEmoji } from "./FwaMatchStateEmojiService";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";
import { BotLogChannelService } from "./BotLogChannelService";

export const TRACKED_MESSAGE_FEATURE_TYPE = {
  FWA_BASE_SWAP: "FWA_BASE_SWAP",
  SYNC_TIME_POST: "SYNC_TIME_POST",
  FWA_MATCH_CHECKLIST: "FWA_MATCH_CHECKLIST",
} as const;

export const TRACKED_MESSAGE_STATUS = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  REPLACED: "REPLACED",
  DELETED: "DELETED",
} as const;

export type TrackedMessageFeatureType =
  (typeof TRACKED_MESSAGE_FEATURE_TYPE)[keyof typeof TRACKED_MESSAGE_FEATURE_TYPE];
export type TrackedMessageStatus =
  (typeof TRACKED_MESSAGE_STATUS)[keyof typeof TRACKED_MESSAGE_STATUS];

export type FwaBaseSwapTrackedMetadata = {
  clanKind?: "FWA" | "CWL";
  clanName: string;
  createdByUserId: string;
  createdAtIso: string;
  syncMessageId?: string | null;
  clanRoleId?: string | null;
  pingRoleId?: string | null;
  swapReminder: boolean;
  renderVariant?: "single" | "split_part_1" | "split_part_2";
  phaseTimingLine?: string | null;
  alertEmoji?: string | null;
  fwaAlertEmoji?: string | null;
  layoutBulletEmoji?: string | null;
  entries: Array<{
    position: number;
    playerTag: string;
    playerName: string;
    discordUserId: string | null;
    townhallLevel: number | null;
    section: "war_bases" | "base_errors" | "fwa_bases";
    acknowledged: boolean;
  }>;
  layoutLinks?: Array<{
    townhall: number;
    layoutLink: string;
  }>;
};

export type FwaBaseSwapReminderCandidate = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  referenceId: string | null;
  clanTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: FwaBaseSwapTrackedMetadata;
};

function buildFwaBaseSwapBattleDayReminderClaimKey(params: {
  guildId: string;
  clanTag: string;
  referenceId: string;
}): string {
  return `fwa-base-swap-battle-day-reminder:${String(params.guildId ?? "").trim()}:${normalizeTagBare(params.clanTag)}:${String(params.referenceId ?? "").trim()}`;
}

export type SyncTimeTrackedMetadata = {
  syncTimeIso: string;
  syncEpochSeconds: number;
  roleId: string;
  clans: Array<{
    code: string;
    clanTag: string;
    clanName: string;
    emojiId: string | null;
    emojiName: string | null;
    emojiInline: string;
  }>;
  reminderSentAt?: string | null;
  statusPostedAt?: string | null;
};

export type FwaMatchChecklistTrackedRow = {
  clanTag: string;
  compactCopyLine: string;
  badgeEmojiId: string | null;
  badgeEmojiName: string | null;
  badgeEmojiInline: string;
  matchType?: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null;
  contextKey?: string | null;
  detailLines?: string[] | null;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTimeIso?: string | null;
};

export type FwaMatchChecklistTrackedMetadata = {
  kind?: "mail_checklist" | "bases_checklist";
  createdByUserId: string;
  createdAtIso: string;
  scopeKey?: string | null;
  referenceId?: string | null;
  checkedClanTags?: string[];
  rows: FwaMatchChecklistTrackedRow[];
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  clanTag?: string | null;
  clanName?: string | null;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTimeIso?: string | null;
};

export type FwaBaseSwapTrackedMessageSnapshot = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  referenceId: string | null;
  clanTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: FwaBaseSwapTrackedMetadata;
};

export type FwaBaseSwapIssueSummary = {
  hasIssues: boolean;
  statusText: string;
  detailLines: string[];
};

export type FwaMatchChecklistReactionChange = {
  kind: "add" | "remove";
  reaction: {
    emoji: { id: string | null; name: string | null };
    count?: number | null;
  };
};

export type FwaMatchChecklistRefreshOptions = {
  rows?: FwaMatchChecklistTrackedRow[];
  scopeKey?: string | null;
  expiresAt?: Date | null;
};

export type FwaMatchChecklistBasesCompletionMetadata = {
  kind: "bases_completion";
  createdByUserId: string;
  createdAtIso: string;
  syncMessageId?: string | null;
  syncReferenceId?: string | null;
  clanTag: string;
  clanName: string | null;
  checked: boolean;
  warId: string | null;
  opponentTag: string | null;
  warStartTimeIso: string | null;
};

export type FwaMatchChecklistBasesCompletionSnapshot = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  referenceId: string | null;
  clanTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: FwaMatchChecklistBasesCompletionMetadata;
};

export type FwaBasesChecklistReminderMetadata = {
  kind: "bases_check_reminder";
  createdByUserId: string;
  createdAtIso: string;
  guildId: string;
  clanTag: string;
  clanName: string | null;
  warId: string | null;
  opponentTag: string | null;
  warStartTimeIso: string | null;
  bucketHours: number;
  destinationChannelId: string | null;
  destinationChannelKind: "leader" | "notify" | "log" | null;
  clanRoleId: string | null;
};

export type FwaBasesChecklistReminderSnapshot = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  clanTag: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: FwaBasesChecklistReminderMetadata;
};

const FWA_MATCH_CHECKLIST_CHECKED_EMOJI = "✅";
const FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI = "☐";
const FWA_CHECKLIST_SYNC_FALLBACK_LOOKBACK_MS = 30 * 60 * 60 * 1000;
const FWA_CHECKLIST_SYNC_FALLBACK_PREP_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const FWA_CHECKLIST_SYNC_FALLBACK_LOOKAHEAD_MS = 6 * 60 * 60 * 1000;
const FWA_CHECKLIST_SYNC_FALLBACK_LIMIT = 25;
const FWA_BASE_SWAP_SYNC_REPAIR_WINDOW_MS = 48 * 60 * 60 * 1000;
const CUSTOM_EMOJI_INLINE_PATTERN = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,22})>$/;

export type FwaBasesChecklistRepairSummary = {
  guildId: string;
  currentSyncMessageId: string | null;
  currentSyncCreatedAtIso: string | null;
  dryRun: boolean;
  basesCompletionCandidates: number;
  basesCompletionReplaced: number;
  baseSwapCandidates: number;
  baseSwapExpiredCandidates: number;
  baseSwapOlderThanCurrentSyncCandidates: number;
  baseSwapReplaced: number;
};

export type FwaBaseSwapSyncIdentitySource =
  | "active_sync_post"
  | "expired_sync_post_fallback"
  | "none";

export type FwaBaseSwapSyncIdentityResolution = {
  syncMessageId: string | null;
  source: FwaBaseSwapSyncIdentitySource;
};

export type FwaBaseSwapSyncIdentityRepairSummary = {
  guildId: string;
  dryRun: boolean;
  scannedRows: number;
  eligibleRows: number;
  repairedRows: number;
  skippedNoCurrentWar: number;
  skippedNoSyncIdentity: number;
  skippedInvalidMetadata: number;
  skippedOutsideWindow: number;
};

type FwaBaseSwapCurrentWarSnapshot = {
  clanTag: string;
  state: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  updatedAt: Date | null;
};

const FWA_MATCH_CHECKLIST_BASES_COMPLETION_PREFIX = "fwa_match_checklist_bases_completion|";

/** Purpose: sanitize copy text so inline-code formatting stays intact in compact match rows. */
export function sanitizeFwaMatchCopyText(input: string | null | undefined): string {
  return String(input ?? "").replace(/`/g, "'");
}

/** Purpose: determine whether `/fwa match` should render the checklist column in compact copy output. */
export function resolveFwaMatchChecklistEnabled(params: {
  copyPaste: boolean;
  checklist: boolean | null | undefined;
}): boolean {
  return params.copyPaste ? Boolean(params.checklist) : false;
}

/** Purpose: choose the compact copy label for a tracked clan, preferring the configured short name. */
export function resolveFwaMatchCompactClanLabel(params: {
  shortName: string | null | undefined;
  clanName: string | null | undefined;
  fallbackLabel?: string | null | undefined;
}): string {
  const shortName = sanitizeFwaMatchCopyText(params.shortName?.trim() || null);
  if (shortName) return shortName;
  const clanName = sanitizeFwaMatchCopyText(params.clanName);
  if (clanName.trim()) return clanName;
  const fallbackLabel = sanitizeFwaMatchCopyText(params.fallbackLabel);
  return fallbackLabel.trim() || "unknown";
}

/** Purpose: build one mobile-friendly compact copy row for /fwa match overview and single-clan views. */
export function buildFwaMatchCompactCopyLine(params: {
  mailStatusEmoji?: string;
  checklist?: boolean;
  checklistChecked?: boolean;
  clanShortName?: string | null | undefined;
  clanName: string | null | undefined;
  opponentName: string | null | undefined;
  opponentTag: string | null | undefined;
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null | undefined;
  outcome: "WIN" | "LOSE" | "UNKNOWN" | null | undefined;
}): string {
  const mailStatusEmoji = params.mailStatusEmoji ?? "📬";
  const clanName = resolveFwaMatchCompactClanLabel({
    shortName: params.clanShortName,
    clanName: params.clanName,
  });
  const opponentName = sanitizeFwaMatchCopyText(params.opponentName) || "unknown";
  const opponentTagRaw = normalizeTagBare(String(params.opponentTag ?? ""));
  const opponentTag = opponentTagRaw
    ? sanitizeFwaMatchCopyText(`#${opponentTagRaw}`)
    : "—";
  const matchStateEmoji = resolveFwaMatchStateEmoji({
    matchType: params.matchType,
    outcome: params.outcome,
  });
  const checklistColumn = params.checklist
    ? ` | ${params.checklistChecked ? FWA_MATCH_CHECKLIST_CHECKED_EMOJI : FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI}`
    : "";

  return `${mailStatusEmoji} | ${matchStateEmoji}${checklistColumn} | ${clanName} vs \`${opponentName}\` (\`${opponentTag}\`)`;
}

export function buildFwaMatchChecklistContent(input: {
  rows: Iterable<FwaMatchChecklistTrackedRow>;
  checkedClanTags: Iterable<string>;
}): string {
  const checkedSet = new Set(
    [...input.checkedClanTags]
      .map((clanTag) => normalizeChecklistClanTag(clanTag))
      .filter((clanTag): clanTag is string => Boolean(clanTag)),
  );
  return [...input.rows]
    .map((row) =>
      insertFwaMatchChecklistColumn(row.compactCopyLine, checkedSet.has(normalizeChecklistClanTag(row.clanTag))),
    )
    .join("\n");
}

/** Purpose: build the full visible checklist message content. */
export function buildFwaMatchChecklistMessageContent(input: {
  rows: Iterable<FwaMatchChecklistTrackedRow>;
  checkedClanTags: Iterable<string>;
}): string {
  return [
    "# Clan Mail Checklist",
    "",
    "React with your clan's badge to indicate that the in-game mails have been sent.",
    "",
    buildFwaMatchChecklistContent(input),
  ].join("\n");
}

function insertFwaMatchChecklistColumn(line: string, checked: boolean): string {
  const normalized = stripFwaMatchChecklistColumn(String(line ?? "").trim());
  if (!normalized) return normalized;
  const firstSeparator = normalized.indexOf(" | ");
  if (firstSeparator < 0) return normalized;
  const secondSeparator = normalized.indexOf(" | ", firstSeparator + 3);
  if (secondSeparator < 0) return normalized;
  const mark = checked ? FWA_MATCH_CHECKLIST_CHECKED_EMOJI : FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI;
  return `${normalized.slice(0, secondSeparator + 3)}${mark} | ${normalized.slice(secondSeparator + 3)}`;
}

function stripFwaMatchChecklistColumn(line: string): string {
  const normalized = String(line ?? "").trim();
  if (!normalized) return normalized;
  const firstSeparator = normalized.indexOf(" | ");
  if (firstSeparator < 0) return normalized;
  const secondSeparator = normalized.indexOf(" | ", firstSeparator + 3);
  if (secondSeparator < 0) return normalized;
  const thirdSeparator = normalized.indexOf(" | ", secondSeparator + 3);
  if (thirdSeparator < 0) return normalized;
  const checklistValue = normalized.slice(secondSeparator + 3, thirdSeparator).trim();
  if (checklistValue !== FWA_MATCH_CHECKLIST_CHECKED_EMOJI && checklistValue !== FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI) {
    return normalized;
  }
  return `${normalized.slice(0, secondSeparator + 3)}${normalized.slice(thirdSeparator + 3)}`;
}

function activeWhere(featureType?: TrackedMessageFeatureType) {
  return {
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    ...(featureType ? { featureType: featureType as any } : {}),
  };
}

function normalizeTagBare(tag: string): string {
  return String(tag ?? "")
    .trim()
    .replace(/^#/, "")
    .toUpperCase();
}

function normalizeChecklistClanTag(tag: string): string {
  const normalized = normalizeClanTag(tag);
  return normalized || normalizeTagBare(tag);
}

function normalizeWarIdText(input: string | number | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  return raw ? raw : null;
}

function normalizeDateTimeIso(input: Date | null | undefined): string | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input.toISOString() : null;
}

function normalizeDateMs(input: Date | null | undefined): number | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input.getTime() : null;
}

function resolveSyncTrackedMetadataTimeMs(metadata: SyncTimeTrackedMetadata): number | null {
  const syncEpochSeconds = Number(metadata.syncEpochSeconds);
  if (Number.isFinite(syncEpochSeconds) && syncEpochSeconds > 0) {
    return Math.trunc(syncEpochSeconds) * 1000;
  }
  const parsed = Date.parse(metadata.syncTimeIso);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTrackedMessageId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return trimmed || null;
}

export function resolveTrackedMessageSyncIdentity(input: {
  messageId?: string | null;
  referenceId?: string | null;
} | null | undefined): string | null {
  return (
    normalizeTrackedMessageId(input?.messageId ?? null) ??
    normalizeTrackedMessageId(input?.referenceId ?? null)
  );
}

export type FwaMatchChecklistKind = "mail_checklist" | "bases_checklist";
export type FwaMatchChecklistViewType = "Mail" | "Bases";

export function normalizeFwaMatchChecklistKind(
  value: unknown,
): FwaMatchChecklistKind | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "mail" || normalized === "mail_checklist") {
    return "mail_checklist";
  }
  if (normalized === "bases" || normalized === "bases_checklist") {
    return "bases_checklist";
  }
  return null;
}

export function resolveFwaMatchChecklistKindFromViewType(
  viewType: FwaMatchChecklistViewType | string | null | undefined,
): FwaMatchChecklistKind {
  return normalizeFwaMatchChecklistKind(viewType) ?? "mail_checklist";
}

export function buildFwaMatchChecklistPublicationClaimKey(params: {
  guildId: string;
  syncMessageId: string;
  viewType: FwaMatchChecklistViewType | string | null | undefined;
}): string | null {
  const guildId = String(params.guildId ?? "").trim();
  const syncMessageId = normalizeTrackedMessageId(params.syncMessageId ?? null);
  if (!guildId || !syncMessageId) return null;
  const kind = resolveFwaMatchChecklistKindFromViewType(params.viewType);
  return [
    "fwa_match_checklist_publication",
    `guild=${guildId}`,
    `sync=${syncMessageId}`,
    `feature=${TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST}`,
    `kind=${kind}`,
  ].join("|");
}

function buildFwaMatchChecklistBasesCompletionKey(params: {
  guildId: string;
  clanTag: string;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
  syncMessageId?: string | null;
  syncReferenceId?: string | null;
}): string | null {
  const guildId = String(params.guildId ?? "").trim();
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const warId = normalizeWarIdText(params.warId ?? null);
  const opponentTag = normalizeChecklistClanTag(String(params.opponentTag ?? ""));
  const warStartTimeIso = normalizeDateTimeIso(params.warStartTime ?? null);
  const syncIdentity = resolveTrackedMessageSyncIdentity({
    messageId: params.syncMessageId ?? null,
    referenceId: params.syncReferenceId ?? null,
  });
  if (!guildId || !clanTag) return null;
  if (!warId && !opponentTag && !warStartTimeIso && !syncIdentity) return null;
  const parts = [
    "fwa_match_checklist_bases_completion",
    `guild=${guildId}`,
    `clan=${clanTag}`,
    `war=${warId || "none"}`,
    `opponent=${opponentTag || "none"}`,
    `start=${warStartTimeIso || "none"}`,
  ];
  if (syncIdentity) {
    parts.push(`sync=${syncIdentity}`);
  }
  return parts.join("|");
}

function isLegacyUnscopedBasesCompletionTrackedMessage(row: {
  messageId: string;
  referenceId: string | null;
  metadata: unknown;
}): boolean {
  if (!String(row.messageId ?? "").trim().startsWith(FWA_MATCH_CHECKLIST_BASES_COMPLETION_PREFIX)) {
    return false;
  }
  if (normalizeTrackedMessageId(row.referenceId ?? null)) return false;
  const metadata = parseFwaMatchChecklistBasesCompletionMetadata(row.metadata);
  if (!metadata) return true;
  return !metadata.syncMessageId && !metadata.syncReferenceId;
}

export function buildFwaBasesChecklistReminderMessageId(params: {
  guildId: string;
  clanTag: string;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
  bucketHours: number;
}): string | null {
  const guildId = String(params.guildId ?? "").trim();
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const warId = normalizeWarIdText(params.warId ?? null);
  const opponentTag = normalizeChecklistClanTag(String(params.opponentTag ?? ""));
  const warStartTimeIso = normalizeDateTimeIso(params.warStartTime ?? null);
  const bucketHours = Math.trunc(Number(params.bucketHours));
  if (!guildId || !clanTag || !warStartTimeIso || !Number.isFinite(bucketHours) || bucketHours <= 0) {
    return null;
  }
  return [
    "fwa_match_checklist_bases_reminder",
    `guild=${guildId}`,
    `clan=${clanTag}`,
    `war=${warId || "none"}`,
    `opponent=${opponentTag || "none"}`,
    `start=${warStartTimeIso}`,
    `bucket=${bucketHours}`,
  ].join("|");
}

function resolveExtendedChecklistExpiresAt(
  currentExpiresAt: Date | null | undefined,
  refreshedExpiresAt: Date | null | undefined,
): Date | null {
  const currentTime =
    currentExpiresAt instanceof Date && Number.isFinite(currentExpiresAt.getTime())
      ? currentExpiresAt.getTime()
      : null;
  const refreshedTime =
    refreshedExpiresAt instanceof Date && Number.isFinite(refreshedExpiresAt.getTime())
      ? refreshedExpiresAt.getTime()
      : null;
  if (refreshedTime === null) return currentTime !== null ? currentExpiresAt ?? null : null;
  if (currentTime === null) return refreshedExpiresAt ?? null;
  return refreshedTime > currentTime ? refreshedExpiresAt ?? null : currentExpiresAt ?? null;
}

export function buildFwaBaseSwapIssueSummary(
  metadata: FwaBaseSwapTrackedMetadata,
  matchType?: string | null,
): FwaBaseSwapIssueSummary {
  const normalizedMatchType = String(matchType ?? "").trim().toUpperCase();
  const includeFwaBasesAsIssues = normalizedMatchType === "BL";
  const activeIssueEntries = metadata.entries.filter(
    (entry) =>
      !entry.acknowledged &&
      (entry.section === "war_bases" ||
        entry.section === "base_errors" ||
        (includeFwaBasesAsIssues && entry.section === "fwa_bases")),
  );
  if (activeIssueEntries.length === 0) {
    return {
      hasIssues: false,
      statusText: "❌ Bases not checked",
      detailLines: [],
    };
  }

  const detailLines: string[] = [];
  const sections: Array<{
    section: "war_bases" | "base_errors" | "fwa_bases";
    label: string;
  }> = [
    { section: "war_bases", label: "War bases" },
    { section: "base_errors", label: "Base errors" },
  ];
  if (includeFwaBasesAsIssues) {
    sections.push({ section: "fwa_bases", label: "Fwa bases" });
  }
  for (const { section, label } of sections) {
    const sectionEntries = activeIssueEntries
      .filter((entry) => entry.section === section)
      .sort((a, b) => a.position - b.position);
    if (sectionEntries.length === 0) continue;
    detailLines.push(`  ${label}:`);
    for (const entry of sectionEntries) {
      detailLines.push(`    - #${entry.position} ${entry.playerName}`);
    }
  }

  return {
    hasIssues: true,
    statusText: "⚠️ Bases checked - issues found",
    detailLines,
  };
}

/** Purpose: build a stable identity fragment for a checklist row when a live match/sync context exists. */
export function buildFwaMatchChecklistRowContextKey(params: {
  clanTag: string;
  warId: string | number | null | undefined;
  opponentTag: string | null | undefined;
}): string | null {
  const clanTag = normalizeChecklistClanTag(params.clanTag);
  const warIdText =
    typeof params.warId === "number"
      ? Number.isFinite(params.warId)
        ? String(Math.trunc(params.warId))
        : ""
      : String(params.warId ?? "").trim();
  const normalizedWarId =
    warIdText &&
    Number.isFinite(Number(warIdText)) &&
    Math.trunc(Number(warIdText)) > 0
      ? String(Math.trunc(Number(warIdText)))
      : "";
  const opponentTag = normalizeChecklistClanTag(String(params.opponentTag ?? ""));
  if (!clanTag || !normalizedWarId || !opponentTag) return null;
  return `clan=${clanTag}|war=${normalizedWarId}|opponent=${opponentTag}`;
}

/** Purpose: build the stable persistence scope for one checklist render. */
export function buildFwaMatchChecklistScopeKey(params: {
  guildId: string;
  clanTag: string | null;
  rows: Iterable<FwaMatchChecklistTrackedRow>;
}): string {
  const guildId = String(params.guildId ?? "").trim() || "unknown";
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const rowTokens = [...params.rows]
    .map((row) =>
      String(row.contextKey ?? row.compactCopyLine ?? row.clanTag ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter((token) => Boolean(token))
    .sort();
  return [
    "fwa_match_checklist",
    `guild=${guildId}`,
    `clan=${clanTag || "all"}`,
    `rows=${rowTokens.join("|") || "none"}`,
  ].join("|");
}

/** Purpose: read the most recent checklist state for a matching guild/clan/scope combination. */
export async function findLatestFwaMatchChecklistCheckedClanTags(params: {
  guildId: string;
  clanTag: string | null;
  scopeKey: string | null;
  syncMessageId?: string | null;
  syncReferenceId?: string | null;
}): Promise<string[]> {
  const scopeKey = String(params.scopeKey ?? "").trim();
  if (!scopeKey) return [];
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const syncIdentity = resolveTrackedMessageSyncIdentity({
    messageId: params.syncMessageId ?? null,
    referenceId: params.syncReferenceId ?? null,
  });
  const rows = await prisma.trackedMessage.findMany({
    where: {
      guildId: String(params.guildId ?? "").trim(),
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
      status: {
        in: [
          TRACKED_MESSAGE_STATUS.ACTIVE,
          TRACKED_MESSAGE_STATUS.REPLACED,
        ],
      },
      ...(clanTag
        ? {
            OR: [{ clanTag }, { clanTag: `#${clanTag}` }],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    select: { metadata: true, referenceId: true },
  });
  let syncScopedFallback: string[] | null = null;
  for (const row of rows) {
    const metadata = parseFwaMatchChecklistMetadata(row.metadata);
    if (!metadata || resolveFwaMatchChecklistViewType(row.metadata) !== "Mail") continue;
    if (metadata.scopeKey === scopeKey) {
      return metadata.checkedClanTags ?? [];
    }
    const rowSyncIdentity = normalizeTrackedMessageId(row.referenceId ?? null);
    if (
      syncScopedFallback === null &&
      syncIdentity &&
      rowSyncIdentity === syncIdentity
    ) {
      syncScopedFallback = metadata.checkedClanTags ?? [];
    }
  }
  return syncScopedFallback ?? [];
}

export function parseFwaMatchChecklistBadgeInline(input: string | null | undefined): {
  badgeEmojiId: string | null;
  badgeEmojiName: string | null;
  badgeEmojiInline: string;
} {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return {
      badgeEmojiId: null,
      badgeEmojiName: null,
      badgeEmojiInline: "",
    };
  }
  const custom = trimmed.match(CUSTOM_EMOJI_INLINE_PATTERN);
  if (custom) {
    return {
      badgeEmojiId: custom[3],
      badgeEmojiName: custom[2],
      badgeEmojiInline: `<${custom[1] ? "a" : ""}:${custom[2]}:${custom[3]}>`,
    };
  }
  return {
    badgeEmojiId: null,
    badgeEmojiName: trimmed,
    badgeEmojiInline: trimmed,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveSyncClanCode(input: { code?: unknown; clanTag: string; clanName: string }): string {
  const explicitCode = String(input.code ?? "").replace(/\s+/g, " ").trim();
  if (explicitCode) return explicitCode.toUpperCase();

  const source = String(input.clanName ?? "").replace(/\s+/g, " ").trim() || input.clanTag.replace(/^#/, "");
  const lettersAndNumbers = source
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const base = lettersAndNumbers.length > 0 ? lettersAndNumbers : source.replace(/\s+/g, "");
  const tagBase = input.clanTag.replace(/^#/, "").toUpperCase();
  return (base + tagBase).slice(0, 3).toUpperCase();
}

export function parseFwaBaseSwapMetadata(value: unknown): FwaBaseSwapTrackedMetadata | null {
  if (!isObject(value) || !Array.isArray(value.entries)) return null;
  const clanKindRaw = String(value.clanKind ?? "").trim().toUpperCase();
  const clanKind =
    clanKindRaw === "CWL"
      ? "CWL"
      : "FWA";
  const clanName = String(value.clanName ?? "").trim();
  const createdByUserId = String(value.createdByUserId ?? "").trim();
  const createdAtIso = String(value.createdAtIso ?? "").trim();
  if (!clanName || !createdByUserId || !createdAtIso) return null;
  const swapReminder =
    value.swapReminder === true ||
    String(value.swapReminder ?? "").trim().toLowerCase() === "true";
  const syncMessageId = normalizeTrackedMessageId(value.syncMessageId as string | null | undefined);
  const clanRoleId = String(value.clanRoleId ?? "").trim() || null;
  const pingRoleId = String(value.pingRoleId ?? "").trim() || null;
  const entries = value.entries
    .map((entry) => {
      if (!isObject(entry)) return null;
      const position = Number(entry.position);
      const playerTag = String(entry.playerTag ?? "").trim();
      const playerName = String(entry.playerName ?? "").trim();
      const discordUserIdRaw = String(entry.discordUserId ?? "").trim();
      const townhallLevel = Number(entry.townhallLevel);
      const section =
        entry.section === "base_errors"
          ? "base_errors"
          : entry.section === "fwa_bases"
            ? "fwa_bases"
            : "war_bases";
      return {
        position: Number.isFinite(position) ? Math.trunc(position) : 0,
        playerTag,
        playerName,
        discordUserId: discordUserIdRaw || null,
        townhallLevel:
          Number.isFinite(townhallLevel) && Math.trunc(townhallLevel) > 0
            ? Math.trunc(townhallLevel)
            : null,
        section,
        acknowledged: Boolean(entry.acknowledged),
      };
    })
    .filter(
      (entry): entry is FwaBaseSwapTrackedMetadata["entries"][number] =>
        Boolean(entry && entry.position > 0 && entry.playerTag && entry.playerName)
    );
  if (entries.length === 0) return null;
  const layoutLinks = Array.isArray(value.layoutLinks)
    ? value.layoutLinks
        .map((layoutLink) => {
          if (!isObject(layoutLink)) return null;
          const townhall = Number(layoutLink.townhall);
          const resolvedLink = String(layoutLink.layoutLink ?? "").trim();
          if (!Number.isFinite(townhall) || Math.trunc(townhall) <= 0 || !resolvedLink) return null;
          return {
            townhall: Math.trunc(townhall),
            layoutLink: resolvedLink,
          };
        })
        .filter(
          (layoutLink): layoutLink is NonNullable<FwaBaseSwapTrackedMetadata["layoutLinks"]>[number] =>
            Boolean(layoutLink)
        )
    : undefined;
  const phaseTimingLineRaw = String(value.phaseTimingLine ?? "").trim();
  const alertEmojiRaw = String(value.alertEmoji ?? "").trim();
  const fwaAlertEmojiRaw = String(value.fwaAlertEmoji ?? "").trim();
  const layoutBulletEmojiRaw = String(value.layoutBulletEmoji ?? "").trim();
  const rawRenderVariant = String(value.renderVariant ?? "").trim();
  const renderVariant: FwaBaseSwapTrackedMetadata["renderVariant"] =
    rawRenderVariant === "split_part_1" || rawRenderVariant === "split_part_2"
      ? rawRenderVariant
      : "single";
  return {
    clanKind,
    clanName,
    createdByUserId,
    createdAtIso,
    syncMessageId,
    clanRoleId,
    pingRoleId,
    renderVariant,
    phaseTimingLine: phaseTimingLineRaw || null,
    alertEmoji: alertEmojiRaw || null,
    fwaAlertEmoji: fwaAlertEmojiRaw || null,
    layoutBulletEmoji: layoutBulletEmojiRaw || null,
    swapReminder,
    entries,
    layoutLinks,
  };
}

export function parseSyncTimeMetadata(value: unknown): SyncTimeTrackedMetadata | null {
  if (!isObject(value) || !Array.isArray(value.clans)) return null;
  const syncTimeIso = String(value.syncTimeIso ?? "").trim();
  const syncEpochSeconds = Number(value.syncEpochSeconds);
  const roleId = String(value.roleId ?? "").trim();
  if (!syncTimeIso || !Number.isFinite(syncEpochSeconds) || !roleId) return null;
  const clans = value.clans
    .map((clan) => {
      if (!isObject(clan)) return null;
      const clanCode = resolveSyncClanCode({
        code: clan.code,
        clanTag: String(clan.clanTag ?? "").trim(),
        clanName: String(clan.clanName ?? "").trim(),
      });
      const clanTag = String(clan.clanTag ?? "").trim();
      const clanName = String(clan.clanName ?? "").trim();
      const emojiInline = String(clan.emojiInline ?? "").trim();
      const emojiIdRaw = String(clan.emojiId ?? "").trim();
      const emojiNameRaw = String(clan.emojiName ?? "").trim();
      if (!clanTag || !clanName || !emojiInline) return null;
      return {
        code: clanCode,
        clanTag,
        clanName,
        emojiId: emojiIdRaw || null,
        emojiName: emojiNameRaw || null,
        emojiInline,
      };
    })
    .filter((clan): clan is SyncTimeTrackedMetadata["clans"][number] => Boolean(clan));
  if (clans.length === 0) return null;
  const reminderSentAt = typeof value.reminderSentAt === "string" ? value.reminderSentAt : null;
  const statusPostedAt = typeof value.statusPostedAt === "string" ? value.statusPostedAt : null;
  return {
    syncTimeIso,
    syncEpochSeconds: Math.trunc(syncEpochSeconds),
    roleId,
    clans,
    ...(reminderSentAt ? { reminderSentAt } : {}),
    ...(statusPostedAt ? { statusPostedAt } : {}),
  };
}

function parseFwaMatchChecklistRow(value: unknown): FwaMatchChecklistTrackedRow | null {
  if (!isObject(value)) return null;
  const clanTag = String(value.clanTag ?? "").trim();
  const compactCopyLine = String(value.compactCopyLine ?? "").trim();
  const badgeEmojiInline = String(value.badgeEmojiInline ?? "").trim();
  if (!clanTag || !compactCopyLine) return null;
  const badgeEmojiId = String(value.badgeEmojiId ?? "").trim();
  const badgeEmojiName = String(value.badgeEmojiName ?? "").trim();
  const detailLines = Array.isArray(value.detailLines)
    ? value.detailLines
        .map((line) => String(line ?? "").trimEnd())
        .filter((line) => Boolean(line.trim()))
    : null;
  return {
    clanTag,
    compactCopyLine,
    badgeEmojiId: badgeEmojiId || null,
    badgeEmojiName: badgeEmojiName || null,
    badgeEmojiInline: badgeEmojiInline || "",
    contextKey: String(value.contextKey ?? "").trim() || null,
    detailLines: detailLines && detailLines.length > 0 ? detailLines : null,
    warId: normalizeWarIdText(value.warId as string | number | null | undefined),
    opponentTag: String(value.opponentTag ?? "").trim() || null,
    warStartTimeIso: String(value.warStartTimeIso ?? "").trim() || null,
  };
}

function parseFwaMatchChecklistBasesCompletionMetadata(
  value: unknown,
): FwaMatchChecklistBasesCompletionMetadata | null {
  if (!isObject(value)) return null;
  if (String(value.kind ?? "").trim() !== "bases_completion") return null;
  const createdByUserId = String(value.createdByUserId ?? "").trim();
  const createdAtIso = String(value.createdAtIso ?? "").trim();
  const clanTag = normalizeChecklistClanTag(String(value.clanTag ?? ""));
  const clanName = String(value.clanName ?? "").trim() || null;
  const warId = normalizeWarIdText(value.warId as string | number | null | undefined);
  const opponentTag = normalizeChecklistClanTag(String(value.opponentTag ?? ""));
  const warStartTimeIso = String(value.warStartTimeIso ?? "").trim() || null;
  const syncMessageId = normalizeTrackedMessageId(value.syncMessageId as string | null | undefined);
  const syncReferenceId = normalizeTrackedMessageId(
    value.syncReferenceId as string | null | undefined,
  );
  if (!createdByUserId || !createdAtIso || !clanTag) return null;
  return {
    kind: "bases_completion",
    createdByUserId,
    createdAtIso,
    syncMessageId,
    syncReferenceId,
    clanTag,
    clanName,
    checked:
      value.checked === true ||
      String(value.checked ?? "").trim().toLowerCase() === "true",
    warId,
    opponentTag: opponentTag || null,
    warStartTimeIso,
  };
}

export function parseFwaMatchChecklistMetadata(
  value: unknown,
): FwaMatchChecklistTrackedMetadata | null {
  if (!isObject(value) || !Array.isArray(value.rows)) return null;
  const createdByUserId = String(value.createdByUserId ?? "").trim();
  const createdAtIso = String(value.createdAtIso ?? "").trim();
  if (!createdByUserId || !createdAtIso) return null;
  const scopeKey = String(value.scopeKey ?? "").trim();
  const checkedClanTags = Array.isArray(value.checkedClanTags)
    ? [
        ...new Set(
          value.checkedClanTags
            .map((clanTag) => normalizeChecklistClanTag(String(clanTag ?? "")))
            .filter((clanTag): clanTag is string => Boolean(clanTag)),
        ),
      ]
    : [];
  const rows = value.rows
    .map((row) => parseFwaMatchChecklistRow(row))
    .filter(
      (row): row is FwaMatchChecklistTrackedRow =>
        Boolean(row && row.clanTag),
    );
  if (rows.length === 0) return null;
  return {
    kind: normalizeFwaMatchChecklistKind(value.kind) ?? undefined,
    createdByUserId,
    createdAtIso,
    scopeKey: scopeKey || null,
    referenceId: String(value.referenceId ?? "").trim() || null,
    checkedClanTags,
    rows,
  };
}

type FwaMatchChecklistReactionCacheEntry = {
  emoji: { id: string | null; name: string | null };
  count?: number | null;
};

type FwaMatchChecklistReactionCache = {
  size?: number;
  values(): IterableIterator<FwaMatchChecklistReactionCacheEntry>;
};

async function hydrateFwaMatchChecklistReactionCache(params: {
  guildId: string;
  messageId: string;
  message: {
    reactions: {
      cache: FwaMatchChecklistReactionCache;
    };
    fetch?: () => Promise<any>;
    partial?: boolean;
  };
}): Promise<FwaMatchChecklistReactionCache> {
  const currentCache = params.message.reactions.cache;
  const currentEntries = [...currentCache.values()];
  const shouldHydrate = params.message.partial === true || currentEntries.length === 0;
  if (!shouldHydrate) return currentCache;

  if (typeof params.message.fetch !== "function") {
    console.error(
      `[tracked-message] fwa checklist bases reaction hydration unavailable guild=${params.guildId} message=${params.messageId} reason=fetch_unavailable cache_size=${currentEntries.length}`,
    );
    return currentCache;
  }

  try {
    const fetchedMessage = await params.message.fetch();
    const fetchedCache = fetchedMessage?.reactions?.cache as FwaMatchChecklistReactionCache | null;
    if (fetchedCache) {
      const fetchedEntries = [...fetchedCache.values()];
      if (fetchedEntries.length > 0) {
        return fetchedCache;
      }
      console.error(
        `[tracked-message] fwa checklist bases reaction hydration unavailable guild=${params.guildId} message=${params.messageId} reason=empty_after_fetch cache_size=${currentEntries.length}`,
      );
      return fetchedCache;
    }
    console.error(
      `[tracked-message] fwa checklist bases reaction hydration unavailable guild=${params.guildId} message=${params.messageId} reason=no_reaction_cache cache_size=${currentEntries.length}`,
    );
  } catch (err) {
    console.error(
      `[tracked-message] fwa checklist bases reaction hydration failed guild=${params.guildId} message=${params.messageId} error=${formatError(err)}`,
    );
  }
  return currentCache;
}

export function resolveFwaMatchChecklistViewType(
  metadata: unknown,
): "Mail" | "Bases" {
  if (!isObject(metadata)) return "Mail";
  return normalizeFwaMatchChecklistKind(metadata.kind) === "bases_checklist" ? "Bases" : "Mail";
}

/** Purpose: render the current sync spin/claim state into one embed shared by the scheduler and the manual command. */
export function buildSyncSpinStatusEmbed(input: {
  guildId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  metadata: SyncTimeTrackedMetadata;
  claimedClanTags: Iterable<string>;
  title?: string;
}): EmbedBuilder {
  const claimedSet = new Set(
    [...input.claimedClanTags]
      .map((clanTag) => normalizeClanTag(clanTag))
      .filter((clanTag): clanTag is string => Boolean(clanTag)),
  );
  const claimedCount = input.metadata.clans.filter((clan) => claimedSet.has(normalizeClanTag(clan.clanTag))).length;

  const embed = new EmbedBuilder()
    .setTitle(input.title ?? "Sync Spin Status")
    .setDescription(
      [
        `Message: https://discord.com/channels/${input.guildId}/${input.sourceChannelId}/${input.sourceMessageId}`,
        `Sync time: <t:${input.metadata.syncEpochSeconds}:F> (<t:${input.metadata.syncEpochSeconds}:R>)`,
        "",
        `Claimed: **${claimedCount}/${input.metadata.clans.length}**`,
        "",
        "**Clan Status**",
        ...input.metadata.clans.map((clan) => {
          const prefix = claimedSet.has(normalizeClanTag(clan.clanTag)) ? "✅" : "-";
          return `${prefix} ${clan.emojiInline} **${clan.code}** (${clan.clanName})`;
        }),
      ].join("\n"),
  );
  return embed;
}

async function sendSyncTimeReminderDms(input: {
  client: Client;
  tracked: {
    messageId: string;
    claims: Array<{
      clanTag: string;
      userId: string;
    }>;
  };
  metadata: SyncTimeTrackedMetadata;
}): Promise<void> {
  const claimsByUser = new Map<string, string[]>();
  const countByClan = new Map<string, number>();
  for (const claim of input.tracked.claims) {
    claimsByUser.set(claim.userId, [...(claimsByUser.get(claim.userId) ?? []), claim.clanTag]);
    countByClan.set(claim.clanTag, (countByClan.get(claim.clanTag) ?? 0) + 1);
  }

  for (const [userId, clanTags] of claimsByUser.entries()) {
    const user = await input.client.users.fetch(userId).catch(() => null);
    if (!user) continue;

    const uniqueClanTags = [...new Set(clanTags)];
    const clans = uniqueClanTags
      .map((clanTag) => {
        const clan = input.metadata.clans.find((entry) => entry.clanTag === clanTag);
        if (!clan) return null;
        const claimedCount = countByClan.get(clanTag) ?? 0;
        return {
          clanTag,
          clanName: clan.clanName,
          claimedCount,
          exclusive: claimedCount === 1,
        };
      })
      .filter((entry): entry is { clanTag: string; clanName: string; claimedCount: number; exclusive: boolean } => Boolean(entry))
      .sort((a, b) => {
        if (a.exclusive !== b.exclusive) return a.exclusive ? -1 : 1;
        return a.clanName.localeCompare(b.clanName, undefined, { sensitivity: "base" });
      });
    if (clans.length === 0) continue;

    const lines = clans.map((clan) => `- ${clan.clanName} (${clan.claimedCount})`);
    await user
      .send([
        `<@${userId}> sync reminder for <t:${input.metadata.syncEpochSeconds}:F> (<t:${input.metadata.syncEpochSeconds}:R>).`,
        "You opted into these clans:",
        ...lines,
      ].join("\n"))
      .catch((err) => {
        console.error(
          `[tracked-message] sync reminder DM failed user=${userId} message=${input.tracked.messageId} error=${formatError(err)}`,
        );
      });
  }
}

function emojiMatches(
  reaction: { emoji: { id: string | null; name: string | null } },
  target: { emojiId: string | null; emojiName: string | null },
): boolean {
  if (reaction.emoji.id && target.emojiId && reaction.emoji.id === target.emojiId) return true;
  return Boolean(reaction.emoji.name && target.emojiName && reaction.emoji.name === target.emojiName);
}

function findChecklistRowTagForReaction(
  rows: FwaMatchChecklistTrackedRow[],
  reaction: { emoji: { id: string | null; name: string | null } },
): string | null {
  const matched = rows.find((row) =>
    emojiMatches(reaction, {
      emojiId: row.badgeEmojiId,
      emojiName: row.badgeEmojiName,
    }),
  );
  return matched ? normalizeChecklistClanTag(matched.clanTag) : null;
}

export class TrackedMessageService {
  async createFwaBaseSwapTrackedMessages(params: {
    guildId: string;
    clanTag: string;
    expiresAt: Date;
    referenceId?: string | null;
    syncMessageId?: string | null;
    messages: Array<{
      channelId: string;
      messageId: string;
      metadata: FwaBaseSwapTrackedMetadata;
    }>;
  }): Promise<void> {
    if (!Array.isArray(params.messages) || params.messages.length === 0) return;
    const syncMessageId = normalizeTrackedMessageId(params.syncMessageId ?? null);
    await prisma.$transaction(async (tx) => {
      await tx.trackedMessage.updateMany({
        where: {
          guildId: params.guildId,
          clanTag: params.clanTag,
          ...activeWhere(TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP),
        },
        data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
      });

      for (const message of params.messages) {
        await tx.trackedMessage.upsert({
          where: { messageId: message.messageId },
          update: {
            guildId: params.guildId,
            channelId: message.channelId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
            referenceId: params.referenceId ?? null,
            clanTag: params.clanTag,
            expiresAt: params.expiresAt,
            metadata: {
              ...message.metadata,
              ...(syncMessageId ? { syncMessageId } : {}),
            } as any,
          },
          create: {
            guildId: params.guildId,
            channelId: message.channelId,
            messageId: message.messageId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
            referenceId: params.referenceId ?? null,
            clanTag: params.clanTag,
            expiresAt: params.expiresAt,
            metadata: {
              ...message.metadata,
              ...(syncMessageId ? { syncMessageId } : {}),
            } as any,
          },
        });
      }
    });
  }

  async createFwaBaseSwapTrackedMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    clanTag: string;
    expiresAt: Date;
    syncMessageId?: string | null;
    metadata: FwaBaseSwapTrackedMetadata;
  }): Promise<void> {
    await this.createFwaBaseSwapTrackedMessages({
      guildId: params.guildId,
      clanTag: params.clanTag,
      expiresAt: params.expiresAt,
      syncMessageId: params.syncMessageId ?? null,
      messages: [
        {
          channelId: params.channelId,
          messageId: params.messageId,
          metadata: params.metadata,
        },
      ],
    });
  }

  async findLatestActiveFwaBaseSwapTrackedMessageForClan(params: {
    guildId: string;
    clanTag: string;
    syncMessageId?: string | null;
  }): Promise<FwaBaseSwapTrackedMessageSnapshot | null> {
    const guildId = String(params.guildId ?? "").trim();
    const normalizedClanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
    const syncIdentity = normalizeTrackedMessageId(params.syncMessageId ?? null);
    if (!guildId || !normalizedClanTag) return null;
    const now = new Date();

    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        expiresAt: { gt: now },
        OR: [
          { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
          {
            clanTag: {
              equals: normalizedClanTag.replace(/^#/, ""),
              mode: "insensitive",
            },
          },
          {
            clanTag: {
              equals: `#${normalizedClanTag.replace(/^#/, "")}`,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        guildId: true,
        channelId: true,
        messageId: true,
        referenceId: true,
        clanTag: true,
        createdAt: true,
        expiresAt: true,
        metadata: true,
      },
    });

    let rejectedStaleUnscopedCount = 0;
    for (const row of rows) {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) continue;
      const rowSyncIdentity = normalizeTrackedMessageId(metadata.syncMessageId ?? null);
      const snapshot = {
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
        referenceId: row.referenceId ?? null,
        clanTag: row.clanTag ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
        metadata,
      };
      if (syncIdentity) {
        if (rowSyncIdentity === syncIdentity) {
          console.debug(
            `[tracked-message] fwa_base_swap_lookup guild=${guildId} clan=${normalizedClanTag} syncMessageId=${syncIdentity} selection=matched_sync messageId=${row.messageId} createdAt=${row.createdAt.toISOString()}`,
          );
          return snapshot;
        }
        if (!rowSyncIdentity) {
          rejectedStaleUnscopedCount += 1;
          console.debug(
            `[tracked-message] fwa_base_swap_lookup guild=${guildId} clan=${normalizedClanTag} syncMessageId=${syncIdentity} selection=rejected_stale_unscoped messageId=${row.messageId} createdAt=${row.createdAt.toISOString()}`,
          );
        }
        continue;
      }
      if (!rowSyncIdentity) {
        console.debug(
          `[tracked-message] fwa_base_swap_lookup guild=${guildId} clan=${normalizedClanTag} selection=matched_unscoped messageId=${row.messageId} createdAt=${row.createdAt.toISOString()}`,
        );
        return snapshot;
      }
    }
    if (syncIdentity) {
      console.debug(
        `[tracked-message] fwa_base_swap_lookup guild=${guildId} clan=${normalizedClanTag} syncMessageId=${syncIdentity} selection=no_match rejectedStaleUnscopedCount=${rejectedStaleUnscopedCount}`,
      );
    }
    return null;
  }

  async getActiveByMessageId(messageId: string) {
    return prisma.trackedMessage.findUnique({ where: { messageId } });
  }

  async findLatestActiveFwaBaseSwapReminderCandidate(params: {
    guildId: string;
    clanTag: string;
  }): Promise<FwaBaseSwapReminderCandidate | null> {
    const now = new Date();
    const normalizedClanTag = String(params.clanTag ?? "").trim();
    if (!params.guildId || !normalizedClanTag) return null;
    const logPrefix = `[fwa base-swap] reminder candidate guild=${params.guildId} clan=${normalizedClanTag}`;

    const rows = await prisma.trackedMessage.findMany({
        where: {
          guildId: params.guildId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        expiresAt: { gt: now },
        OR: [
          { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
          {
            clanTag: {
              equals: normalizedClanTag.replace(/^#/, ""),
              mode: "insensitive",
            },
          },
          {
            clanTag: {
              equals: `#${normalizedClanTag.replace(/^#/, "")}`,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        guildId: true,
        channelId: true,
        messageId: true,
        referenceId: true,
        clanTag: true,
        createdAt: true,
        expiresAt: true,
        metadata: true,
      },
    });

    for (const row of rows) {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) continue;
      if (!metadata.swapReminder) {
        console.log(
          `${logPrefix} message=${row.messageId} reference=${row.referenceId ?? row.messageId} skipped=swapReminder_false`,
        );
        continue;
      }
      if (!metadata.entries.some((entry) => entry.section === "fwa_bases")) {
        console.log(
          `${logPrefix} message=${row.messageId} reference=${row.referenceId ?? row.messageId} skipped=no_fwa_bases_entry`,
        );
        continue;
      }
      console.log(
        `${logPrefix} message=${row.messageId} reference=${row.referenceId ?? row.messageId} selected=true`,
      );
      return {
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
        referenceId: row.referenceId ?? null,
        clanTag: row.clanTag ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
        metadata,
      };
    }

    console.log(`${logPrefix} selected=false reason=no_qualifying_candidate`);
    return null;
  }

  async claimFwaBaseSwapBattleDayReminder(params: {
    guildId: string;
    clanTag: string;
    referenceId: string;
  }): Promise<boolean> {
    const guildId = String(params.guildId ?? "").trim();
    const clanTag = normalizeTagBare(params.clanTag);
    const referenceId = String(params.referenceId ?? "").trim();
    if (!guildId || !clanTag || !referenceId) return false;

    const claimKey = buildFwaBaseSwapBattleDayReminderClaimKey({
      guildId,
      clanTag,
      referenceId,
    });
    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        expiresAt: { gt: new Date() },
        OR: [
          { referenceId },
          { messageId: referenceId },
          { clanTag: { equals: clanTag, mode: "insensitive" } },
          { clanTag: { equals: `#${clanTag}`, mode: "insensitive" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      select: { id: true },
    });
    if (rows.length === 0) return false;

    const existingClaim = await prisma.trackedMessageClaim.findFirst({
      where: {
        trackedMessageId: { in: rows.map((row) => row.id) },
        userId: claimKey,
        clanTag: claimKey,
      },
      select: { id: true },
    });
    if (existingClaim) return false;

    const claimed = await prisma.trackedMessageClaim.createMany({
      data: [
        {
          trackedMessageId: rows[0].id,
          userId: claimKey,
          clanTag: claimKey,
        },
      ],
      skipDuplicates: true,
    });
    return claimed.count > 0;
  }

  async markMessageDeleted(messageId: string): Promise<void> {
    const tracked = await prisma.trackedMessage.findUnique({ where: { messageId } });
    if (!tracked) return;
    if (tracked.status === TRACKED_MESSAGE_STATUS.DELETED) return;
    await prisma.$transaction([
      prisma.trackedMessage.update({
        where: { messageId },
        data: { status: TRACKED_MESSAGE_STATUS.DELETED },
      }),
      ...(tracked.referenceId
        ? []
        : [
            prisma.trackedMessage.updateMany({
              where: {
                referenceId: messageId,
                featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
                status: TRACKED_MESSAGE_STATUS.ACTIVE,
              },
              data: { status: TRACKED_MESSAGE_STATUS.DELETED },
            }),
          ]),
    ]);
  }

  async handleFwaBaseSwapReaction(params: {
    messageId: string;
    reactorUserId: string;
    message: {
      id: string;
      channelId: string;
      edit: (payload: {
        content: string;
        allowedMentions: { users: string[]; roles?: string[] };
      }) => Promise<unknown>;
    };
    render: (metadata: FwaBaseSwapTrackedMetadata) => string;
    resolveMessageForEdit?: (input: {
      channelId: string;
      messageId: string;
    }) => Promise<
      | {
          edit: (payload: {
            content: string;
            allowedMentions: { users: string[]; roles?: string[] };
          }) => Promise<unknown>;
        }
      | null
    >;
  }): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({ where: { messageId: params.messageId } });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP) return false;

    const metadata = parseFwaBaseSwapMetadata(tracked.metadata);
    if (!metadata) {
      await prisma.trackedMessage.update({
        where: { messageId: params.messageId },
        data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
      });
      return false;
    }

    let changed = false;
    for (const entry of metadata.entries) {
      if (entry.discordUserId === params.reactorUserId && !entry.acknowledged) {
        entry.acknowledged = true;
        changed = true;
      }
    }
    if (!changed) return false;

    const relatedRows =
      tracked.referenceId
        ? await prisma.trackedMessage.findMany({
            where: {
              referenceId: tracked.referenceId,
              featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
              ...activeWhere(TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP),
            },
            orderBy: [{ createdAt: "asc" }],
          })
        : [tracked];
    const rowsToUpdate = relatedRows.length > 0 ? relatedRows : [tracked];

    const mentionUserIds = [
      ...new Set(
        metadata.entries.flatMap((entry) =>
          entry.discordUserId ? [entry.discordUserId] : [],
        ),
      ),
    ];

    for (const row of rowsToUpdate) {
      const rowMetadataRaw = parseFwaBaseSwapMetadata(row.metadata);
      if (!rowMetadataRaw) continue;
      const rowMetadata: FwaBaseSwapTrackedMetadata = {
        ...rowMetadataRaw,
        entries: metadata.entries.map((entry) => ({ ...entry })),
      };
      const editTarget =
        row.messageId === params.message.id
          ? params.message
          : params.resolveMessageForEdit
            ? await params.resolveMessageForEdit({
                channelId: row.channelId,
                messageId: row.messageId,
              })
            : null;
      if (!editTarget) continue;
      await editTarget.edit({
        content: params.render(rowMetadata),
        allowedMentions: {
          users: mentionUserIds,
        },
      });
    }

    const allAcknowledged = metadata.entries.every((entry) => !entry.discordUserId || entry.acknowledged);
    await prisma.$transaction(
      rowsToUpdate.map((row) => {
        const rowMetadataRaw = parseFwaBaseSwapMetadata(row.metadata);
        if (!rowMetadataRaw) {
          return prisma.trackedMessage.update({
            where: { messageId: row.messageId },
            data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
          });
        }
        return prisma.trackedMessage.update({
          where: { messageId: row.messageId },
          data: {
            status: allAcknowledged
              ? TRACKED_MESSAGE_STATUS.COMPLETED
              : TRACKED_MESSAGE_STATUS.ACTIVE,
            metadata: {
              ...rowMetadataRaw,
              entries: metadata.entries.map((entry) => ({ ...entry })),
            } as any,
          },
        });
      }),
    );
    return true;
  }

  async createSyncTimeTrackedMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    remindAt?: Date | null;
    expiresAt: Date;
    referenceId?: string | null;
    metadata: SyncTimeTrackedMetadata;
  }): Promise<void> {
    await prisma.trackedMessage.upsert({
      where: { messageId: params.messageId },
      update: {
        guildId: params.guildId,
        channelId: params.channelId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: params.referenceId ?? null,
        remindAt: params.remindAt ?? null,
        expiresAt: params.expiresAt,
        metadata: params.metadata as any,
      },
      create: {
        guildId: params.guildId,
        channelId: params.channelId,
        messageId: params.messageId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: params.referenceId ?? null,
        remindAt: params.remindAt ?? null,
        expiresAt: params.expiresAt,
        metadata: params.metadata as any,
      },
    });
  }

  async createFwaMatchChecklistTrackedMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    clanTag?: string | null;
    expiresAt?: Date | null;
    referenceId?: string | null;
    metadata: FwaMatchChecklistTrackedMetadata;
  }): Promise<void> {
    await prisma.trackedMessage.upsert({
      where: { messageId: params.messageId },
      update: {
        guildId: params.guildId,
        channelId: params.channelId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: params.referenceId ?? null,
        clanTag: params.clanTag ?? null,
        expiresAt: params.expiresAt ?? null,
        metadata: params.metadata as any,
      },
      create: {
        guildId: params.guildId,
        channelId: params.channelId,
        messageId: params.messageId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: params.referenceId ?? null,
        clanTag: params.clanTag ?? null,
        expiresAt: params.expiresAt ?? null,
        metadata: params.metadata as any,
      },
    });
  }

  async claimFwaMatchChecklistPublication(params: {
    guildId: string;
    syncMessageId: string;
    viewType: FwaMatchChecklistViewType | string | null | undefined;
  }): Promise<{
    claimed: boolean;
    claimKey: string | null;
    sourceTrackedMessageId: string | null;
  }> {
    const guildId = String(params.guildId ?? "").trim();
    const syncMessageId = normalizeTrackedMessageId(params.syncMessageId ?? null);
    const claimKey = buildFwaMatchChecklistPublicationClaimKey({
      guildId,
      syncMessageId: syncMessageId ?? "",
      viewType: params.viewType,
    });
    if (!guildId || !syncMessageId || !claimKey) {
      return {
        claimed: false,
        claimKey: null,
        sourceTrackedMessageId: null,
      };
    }

    const sourceTracked = await prisma.trackedMessage.findUnique({
      where: { messageId: syncMessageId },
      select: { id: true, guildId: true, messageId: true, featureType: true },
    });
    if (
      !sourceTracked ||
      sourceTracked.guildId !== guildId ||
      (sourceTracked.featureType as string) !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST
    ) {
      return {
        claimed: false,
        claimKey,
        sourceTrackedMessageId: sourceTracked?.id ?? null,
      };
    }

    const claimed = await prisma.trackedMessageClaim.createMany({
      data: [
        {
          trackedMessageId: sourceTracked.id,
          userId: claimKey,
          clanTag: claimKey,
        },
      ],
      skipDuplicates: true,
    });

    return {
      claimed: claimed.count > 0,
      claimKey,
      sourceTrackedMessageId: sourceTracked.id,
    };
  }

  async releaseFwaMatchChecklistPublicationClaim(params: {
    sourceTrackedMessageId: string;
    claimKey: string;
  }): Promise<boolean> {
    const sourceTrackedMessageId = String(params.sourceTrackedMessageId ?? "").trim();
    const claimKey = String(params.claimKey ?? "").trim();
    if (!sourceTrackedMessageId || !claimKey) return false;

    const result = await prisma.trackedMessageClaim.deleteMany({
      where: {
        trackedMessageId: sourceTrackedMessageId,
        userId: claimKey,
        clanTag: claimKey,
      },
    });
    return result.count > 0;
  }

  async findFwaMatchChecklistPublicationBySyncReference(params: {
    guildId: string;
    syncMessageId: string;
    viewType: FwaMatchChecklistViewType | string | null | undefined;
  }): Promise<{
    id: string;
    messageId: string;
    referenceId: string | null;
    status: (typeof TRACKED_MESSAGE_STATUS)[keyof typeof TRACKED_MESSAGE_STATUS];
    metadata: unknown;
  } | null> {
    const guildId = String(params.guildId ?? "").trim();
    const syncMessageId = normalizeTrackedMessageId(params.syncMessageId ?? null);
    const kind = normalizeFwaMatchChecklistKind(params.viewType);
    if (!guildId || !syncMessageId || !kind) return null;

    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId,
        referenceId: syncMessageId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        messageId: true,
        referenceId: true,
        status: true,
        metadata: true,
      },
    });

    for (const row of rows) {
      const metadata = parseFwaMatchChecklistMetadata(row.metadata);
      if (!metadata) continue;
      if (metadata.kind !== kind) continue;
      return {
        id: row.id,
        messageId: row.messageId,
        referenceId: row.referenceId ?? null,
        status: row.status,
        metadata: row.metadata,
      };
    }

    return null;
  }

  async claimFwaBasesChecklistReminderMarker(params: {
    guildId: string;
    channelId: string;
    clanTag: string;
    clanName?: string | null;
    warId?: string | number | null;
    opponentTag?: string | null;
    warStartTime?: Date | null;
    bucketHours: number;
    destinationChannelId?: string | null;
    destinationChannelKind?: "leader" | "notify" | "log" | null;
    clanRoleId?: string | null;
    createdByUserId?: string | null;
    createdAtIso?: string | null;
  }): Promise<boolean> {
    const messageId = buildFwaBasesChecklistReminderMessageId({
      guildId: params.guildId,
      clanTag: params.clanTag,
      warId: params.warId ?? null,
      opponentTag: params.opponentTag ?? null,
      warStartTime: params.warStartTime ?? null,
      bucketHours: params.bucketHours,
    });
    if (!messageId) return false;

    const createdByUserId = String(params.createdByUserId ?? "system").trim() || "system";
    const createdAtIso = String(params.createdAtIso ?? "").trim() || new Date().toISOString();
    const clanTag = normalizeChecklistClanTag(params.clanTag);
    const clanName = String(params.clanName ?? "").trim() || null;
    const metadata: FwaBasesChecklistReminderMetadata = {
      kind: "bases_check_reminder",
      createdByUserId,
      createdAtIso,
      guildId: String(params.guildId ?? "").trim(),
      clanTag,
      clanName,
      warId: normalizeWarIdText(params.warId ?? null),
      opponentTag: normalizeChecklistClanTag(String(params.opponentTag ?? "")) || null,
      warStartTimeIso: normalizeDateTimeIso(params.warStartTime ?? null),
      bucketHours: Math.trunc(Number(params.bucketHours)),
      destinationChannelId: String(params.destinationChannelId ?? "").trim() || null,
      destinationChannelKind:
        params.destinationChannelKind === "leader" ||
        params.destinationChannelKind === "notify" ||
        params.destinationChannelKind === "log"
          ? params.destinationChannelKind
          : null,
      clanRoleId: String(params.clanRoleId ?? "").trim() || null,
    };

    try {
      await prisma.trackedMessage.create({
        data: {
          guildId: String(params.guildId ?? "").trim(),
          channelId: String(params.channelId ?? "").trim() || String(params.destinationChannelId ?? "").trim() || "missing-channel",
          messageId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          referenceId: null,
          clanTag,
          expiresAt: params.warStartTime ?? null,
          metadata: metadata as any,
        },
      });
      return true;
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code ?? "";
      if (code === "P2002") return false;
      throw err;
    }
  }

  async replaceOlderFwaMatchChecklistMessages(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    resolveMessageForCleanup?: (input: {
      channelId: string;
      messageId: string;
    }) => Promise<
      | {
          pinned?: boolean | null;
          unpin: () => Promise<unknown>;
        }
      | null
    >;
  }): Promise<number> {
    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId: String(params.guildId ?? "").trim(),
        channelId: String(params.channelId ?? "").trim(),
        messageId: { not: String(params.messageId ?? "").trim() },
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
      },
      orderBy: [{ createdAt: "asc" }],
    });

    let replacedCount = 0;
    for (const row of rows) {
      if (resolveFwaMatchChecklistViewType(row.metadata) !== "Bases") continue;
      const currentMessage =
        params.resolveMessageForCleanup
          ? await params.resolveMessageForCleanup({
              channelId: row.channelId,
              messageId: row.messageId,
            }).catch((err) => {
              console.error(
                `[tracked-message] fwa checklist cleanup fetch failed guild=${params.guildId} channel=${params.channelId} message=${row.messageId} error=${formatError(err)}`,
              );
              return null;
            })
          : null;
      if (!currentMessage) {
        console.error(
          `[tracked-message] fwa checklist cleanup missing message guild=${params.guildId} channel=${params.channelId} message=${row.messageId}`,
        );
      } else if (currentMessage.pinned !== false) {
        await currentMessage.unpin().catch((err) => {
          console.error(
            `[tracked-message] fwa checklist cleanup unpin failed guild=${params.guildId} channel=${params.channelId} message=${row.messageId} error=${formatError(err)}`,
          );
        });
      }

      await prisma.trackedMessage.update({
        where: { messageId: row.messageId },
        data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
      });
      replacedCount += 1;
    }

    return replacedCount;
  }

  async setFwaMatchChecklistBasesCompletion(params: {
    guildId: string;
    channelId: string;
    createdByUserId: string;
    clanTag: string;
    clanName?: string | null;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    checked: boolean;
    syncMessageId?: string | null;
    syncReferenceId?: string | null;
  }): Promise<boolean> {
    const messageId = buildFwaMatchChecklistBasesCompletionKey({
      guildId: params.guildId,
      clanTag: params.clanTag,
      warId: params.warId ?? null,
      opponentTag: params.opponentTag ?? null,
      warStartTime: params.warStartTime ?? null,
      syncMessageId: params.syncMessageId ?? null,
      syncReferenceId: params.syncReferenceId ?? null,
    });
    if (!messageId) return false;
    const createdAtIso = new Date().toISOString();
    const normalizedClanTag = normalizeChecklistClanTag(params.clanTag);
    const syncIdentity = resolveTrackedMessageSyncIdentity({
      messageId: params.syncMessageId ?? null,
      referenceId: params.syncReferenceId ?? null,
    });
    const metadata: FwaMatchChecklistBasesCompletionMetadata = {
      kind: "bases_completion",
      createdByUserId: params.createdByUserId,
      createdAtIso,
      syncMessageId: normalizeTrackedMessageId(params.syncMessageId ?? null),
      syncReferenceId: normalizeTrackedMessageId(params.syncReferenceId ?? null),
      clanTag: normalizedClanTag,
      clanName: String(params.clanName ?? "").trim() || null,
      checked: params.checked,
      warId: normalizeWarIdText(params.warId ?? null),
      opponentTag: normalizeChecklistClanTag(String(params.opponentTag ?? "")) || null,
      warStartTimeIso: normalizeDateTimeIso(params.warStartTime ?? null),
    };
    await prisma.trackedMessage.upsert({
      where: { messageId },
      update: {
        guildId: params.guildId,
        channelId: params.channelId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: params.checked
          ? TRACKED_MESSAGE_STATUS.ACTIVE
          : TRACKED_MESSAGE_STATUS.REPLACED,
        referenceId: syncIdentity,
        clanTag: normalizedClanTag,
        expiresAt: null,
        metadata: metadata as any,
      },
      create: {
        guildId: params.guildId,
        channelId: params.channelId,
        messageId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: params.checked
          ? TRACKED_MESSAGE_STATUS.ACTIVE
          : TRACKED_MESSAGE_STATUS.REPLACED,
        referenceId: syncIdentity,
        clanTag: normalizedClanTag,
        expiresAt: null,
        metadata: metadata as any,
      },
    });
    if (!params.checked && syncIdentity) {
      const syncScopedMessageId = buildFwaMatchChecklistBasesCompletionKey({
        guildId: params.guildId,
        clanTag: params.clanTag,
        warId: null,
        opponentTag: null,
        warStartTime: null,
        syncMessageId: syncIdentity,
      });
      if (syncScopedMessageId && syncScopedMessageId !== messageId) {
        await prisma.trackedMessage.updateMany({
          where: {
            guildId: params.guildId,
            messageId: syncScopedMessageId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
          },
          data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
        });
      }
    }
    return true;
  }

  async findLatestFwaMatchChecklistBasesCompletionForClan(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    syncMessageId?: string | null;
    syncReferenceId?: string | null;
  }): Promise<FwaMatchChecklistBasesCompletionSnapshot | null> {
    const messageId = buildFwaMatchChecklistBasesCompletionKey({
      guildId: params.guildId,
      clanTag: params.clanTag,
      warId: params.warId ?? null,
      opponentTag: params.opponentTag ?? null,
      warStartTime: params.warStartTime ?? null,
      syncMessageId: params.syncMessageId ?? null,
      syncReferenceId: params.syncReferenceId ?? null,
    });
    if (!messageId) return null;
    const row = await prisma.trackedMessage.findUnique({
      where: { messageId },
    });
    if (!row || row.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return null;
    if ((row.featureType as string) !== TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST) return null;
    const metadata = parseFwaMatchChecklistBasesCompletionMetadata(row.metadata);
    if (!metadata || !metadata.checked) return null;
    return {
      id: row.id,
      guildId: row.guildId,
      channelId: row.channelId,
      messageId: row.messageId,
      referenceId: row.referenceId ?? null,
      clanTag: row.clanTag ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt ?? null,
      metadata,
    };
  }

  async findLatestActiveFwaMatchChecklistBasesCompletionForClan(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    syncMessageId?: string | null;
    syncReferenceId?: string | null;
  }): Promise<FwaMatchChecklistBasesCompletionSnapshot | null> {
    const exact = await this.findLatestFwaMatchChecklistBasesCompletionForClan(params).catch(() => null);
    if (exact) return exact;

    const guildId = String(params.guildId ?? "").trim();
    const normalizedClanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
    if (!guildId || !normalizedClanTag) return null;

    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        messageId: {
          startsWith: FWA_MATCH_CHECKLIST_BASES_COMPLETION_PREFIX,
        },
        OR: [
          { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
          {
            clanTag: {
              equals: normalizedClanTag.replace(/^#/, ""),
              mode: "insensitive",
            },
          },
          {
            clanTag: {
              equals: `#${normalizedClanTag.replace(/^#/, "")}`,
              mode: "insensitive",
            },
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        guildId: true,
        channelId: true,
        messageId: true,
        referenceId: true,
        clanTag: true,
        createdAt: true,
        expiresAt: true,
        metadata: true,
      },
    });

    const expectedWarId = normalizeWarIdText(params.warId ?? null);
    const expectedOpponentTag = normalizeChecklistClanTag(String(params.opponentTag ?? "")) || null;
    const expectedWarStartTimeIso =
      params.warStartTime instanceof Date && Number.isFinite(params.warStartTime.getTime())
        ? params.warStartTime.toISOString()
        : null;
    const expectedSyncIdentity = resolveTrackedMessageSyncIdentity({
      messageId: params.syncMessageId ?? null,
      referenceId: params.syncReferenceId ?? null,
    });
    const allowWarStartTimeMatch = expectedWarStartTimeIso !== null;
    const allowWarIdOpponentMatch = expectedWarId !== null && expectedOpponentTag !== null;
    if (!allowWarStartTimeMatch && !allowWarIdOpponentMatch && !expectedSyncIdentity) return null;

    for (const row of rows) {
      const metadata = parseFwaMatchChecklistBasesCompletionMetadata(row.metadata);
      if (!metadata || !metadata.checked) continue;
      const rowSyncIdentity = resolveTrackedMessageSyncIdentity({
        messageId: metadata.syncMessageId ?? row.referenceId ?? null,
        referenceId: metadata.syncReferenceId ?? null,
      });
      const syncScopedFallbackMatches =
        Boolean(expectedSyncIdentity) &&
        rowSyncIdentity === expectedSyncIdentity &&
        !metadata.warId &&
        !metadata.opponentTag &&
        !metadata.warStartTimeIso;
      if (allowWarStartTimeMatch) {
        if (metadata.warStartTimeIso !== expectedWarStartTimeIso && !syncScopedFallbackMatches) {
          continue;
        }
      } else if (allowWarIdOpponentMatch) {
        if (
          (metadata.warId !== expectedWarId || metadata.opponentTag !== expectedOpponentTag) &&
          !syncScopedFallbackMatches
        ) {
          continue;
        }
      } else if (expectedSyncIdentity) {
        if (rowSyncIdentity !== expectedSyncIdentity) continue;
      }
      return {
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        messageId: row.messageId,
        referenceId: row.referenceId ?? null,
        clanTag: row.clanTag ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
        metadata,
      };
    }

    return null;
  }

  async recordSyncClaim(messageId: string, userId: string, reaction: { emoji: { id: string | null; name: string | null } }): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({ where: { messageId } });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) return false;
    const metadata = parseSyncTimeMetadata(tracked.metadata);
    if (!metadata) return false;
    const matchedClan = metadata.clans.find((clan) => emojiMatches(reaction, clan));
    if (!matchedClan) return false;
    await prisma.trackedMessageClaim.upsert({
      where: {
        trackedMessageId_userId_clanTag: {
          trackedMessageId: tracked.id,
          userId,
          clanTag: matchedClan.clanTag,
        },
      },
      update: {},
      create: {
        trackedMessageId: tracked.id,
        userId,
        clanTag: matchedClan.clanTag,
      },
    });
    return true;
  }

  async removeSyncClaim(messageId: string, userId: string, reaction: { emoji: { id: string | null; name: string | null } }): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({ where: { messageId } });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) return false;
    const metadata = parseSyncTimeMetadata(tracked.metadata);
    if (!metadata) return false;
    const matchedClan = metadata.clans.find((clan) => emojiMatches(reaction, clan));
    if (!matchedClan) return false;
    await prisma.trackedMessageClaim.deleteMany({
      where: {
        trackedMessageId: tracked.id,
        userId,
        clanTag: matchedClan.clanTag,
      },
    });
    return true;
  }

  async resolveLatestActiveSyncPost(guildId: string) {
    return prisma.trackedMessage.findFirst({
      where: {
        guildId,
        referenceId: null,
        ...activeWhere(TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST),
      },
      orderBy: [{ remindAt: "desc" }, { createdAt: "desc" }],
    });
  }

  async resolveLatestSyncPost(guildId: string, now: Date = new Date()) {
    return prisma.trackedMessage.findFirst({
      where: {
        guildId,
        referenceId: null,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        OR: [
          { remindAt: null },
          {
            remindAt: {
              lte: now,
            },
          },
        ],
      },
      orderBy: [{ remindAt: "desc" }, { createdAt: "desc" }],
    });
  }

  async resolveLatestRelevantSyncPostForClanWar(params: {
    guildId: string;
    clanTag: string;
    battleDayStart?: Date | null;
    prepStartTime?: Date | null;
    now?: Date;
  }): Promise<string | null> {
    const guildId = String(params.guildId ?? "").trim();
    const normalizedClanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
    const battleDayStartMs = normalizeDateMs(params.battleDayStart ?? null);
    const prepStartTimeMs = normalizeDateMs(params.prepStartTime ?? null);
    const referenceTimeMs = prepStartTimeMs ?? battleDayStartMs;
    const now =
      params.now instanceof Date && Number.isFinite(params.now.getTime())
        ? params.now
        : new Date();
    if (!guildId || !normalizedClanTag || referenceTimeMs === null) return null;

    const lowerBoundMs =
      prepStartTimeMs !== null
        ? referenceTimeMs - FWA_CHECKLIST_SYNC_FALLBACK_PREP_LOOKBACK_MS
        : referenceTimeMs - FWA_CHECKLIST_SYNC_FALLBACK_LOOKBACK_MS;
    const upperBoundMs = referenceTimeMs + FWA_CHECKLIST_SYNC_FALLBACK_LOOKAHEAD_MS;
    const rows = await prisma.trackedMessage.findMany({
      where: {
        guildId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST as any,
        status: TRACKED_MESSAGE_STATUS.EXPIRED,
        referenceId: null,
        createdAt: {
          lte: now,
        },
      },
      orderBy: [{ createdAt: "desc" }, { expiresAt: "desc" }],
      take: FWA_CHECKLIST_SYNC_FALLBACK_LIMIT,
      select: {
        messageId: true,
        metadata: true,
      },
    });

    for (const row of rows) {
      const metadata = parseSyncTimeMetadata(row.metadata);
      if (!metadata) continue;
      const clanMatches = metadata.clans.some(
        (clan) => normalizeChecklistClanTag(clan.clanTag) === normalizedClanTag,
      );
      if (!clanMatches) continue;
      const syncTimeMs = resolveSyncTrackedMetadataTimeMs(metadata);
      if (syncTimeMs === null) continue;
      if (syncTimeMs < lowerBoundMs || syncTimeMs > upperBoundMs) continue;
      return normalizeTrackedMessageId(row.messageId);
    }

    return null;
  }

  async resolveFwaBaseSwapSyncIdentityForClanWar(params: {
    guildId: string;
    clanTag: string;
    battleDayStart?: Date | null;
    prepStartTime?: Date | null;
    now?: Date;
  }): Promise<FwaBaseSwapSyncIdentityResolution> {
    const guildId = String(params.guildId ?? "").trim();
    if (!guildId) {
      return { syncMessageId: null, source: "none" };
    }

    const latestActiveSyncPost = await this.resolveLatestActiveSyncPost(guildId).catch(() => null);
    const activeSyncMessageId = normalizeTrackedMessageId(latestActiveSyncPost?.messageId ?? null);
    if (activeSyncMessageId) {
      return {
        syncMessageId: activeSyncMessageId,
        source: "active_sync_post",
      };
    }

    const fallbackSyncMessageId = await this.resolveLatestRelevantSyncPostForClanWar({
      guildId,
      clanTag: params.clanTag,
      battleDayStart: params.battleDayStart ?? null,
      prepStartTime: params.prepStartTime ?? null,
      now: params.now,
    }).catch(() => null);
    if (fallbackSyncMessageId) {
      return {
        syncMessageId: fallbackSyncMessageId,
        source: "expired_sync_post_fallback",
      };
    }

    return {
      syncMessageId: null,
      source: "none",
    };
  }

  async repairStaleFwaBasesChecklistState(params: {
    guildId: string;
    now?: Date;
    apply?: boolean;
  }): Promise<FwaBasesChecklistRepairSummary> {
    const guildId = String(params.guildId ?? "").trim();
    const now = params.now instanceof Date && Number.isFinite(params.now.getTime()) ? params.now : new Date();
    const apply = params.apply ?? false;
    const latestSyncPost = guildId
      ? await this.resolveLatestSyncPost(guildId, now).catch(() => null)
      : null;
    const currentSyncMessageId = resolveTrackedMessageSyncIdentity(latestSyncPost);
    const currentSyncCreatedAtIso =
      latestSyncPost?.createdAt instanceof Date &&
      Number.isFinite(latestSyncPost.createdAt.getTime())
        ? latestSyncPost.createdAt.toISOString()
        : null;
    const currentSyncCreatedAtMs =
      latestSyncPost?.createdAt instanceof Date &&
      Number.isFinite(latestSyncPost.createdAt.getTime())
        ? latestSyncPost.createdAt.getTime()
        : null;

    const basesCompletionRows = guildId
      ? await prisma.trackedMessage.findMany({
          where: {
            guildId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
            referenceId: null,
            messageId: {
              startsWith: FWA_MATCH_CHECKLIST_BASES_COMPLETION_PREFIX,
            },
          },
          select: {
            id: true,
            createdAt: true,
            messageId: true,
            referenceId: true,
            metadata: true,
          },
        })
      : [];
    const basesCompletionCandidateRows = basesCompletionRows.filter((row) => {
      if (!isLegacyUnscopedBasesCompletionTrackedMessage(row)) return false;
      if (currentSyncCreatedAtMs === null) return false;
      return row.createdAt.getTime() < currentSyncCreatedAtMs;
    });
    const basesCompletionIds = basesCompletionCandidateRows.map((row) => row.id);

    const baseSwapRows = guildId
      ? await prisma.trackedMessage.findMany({
          where: {
            guildId,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
          },
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            metadata: true,
          },
        })
      : [];
    const baseSwapExpiredRows: Array<{ id: string }> = [];
    const baseSwapOlderRows: Array<{ id: string }> = [];
    for (const row of baseSwapRows) {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) continue;
      if (metadata.syncMessageId) continue;
      const expiresAtMs =
        row.expiresAt instanceof Date && Number.isFinite(row.expiresAt.getTime())
          ? row.expiresAt.getTime()
          : null;
      if (expiresAtMs !== null && expiresAtMs <= now.getTime()) {
        baseSwapExpiredRows.push({ id: row.id });
        continue;
      }
      if (currentSyncCreatedAtMs !== null && row.createdAt.getTime() < currentSyncCreatedAtMs) {
        baseSwapOlderRows.push({ id: row.id });
      }
    }

    const baseSwapIds = [...new Set([...baseSwapExpiredRows, ...baseSwapOlderRows].map((row) => row.id))];
    if (apply && guildId) {
      if (basesCompletionIds.length > 0) {
        await prisma.trackedMessage.updateMany({
          where: {
            guildId,
            id: { in: basesCompletionIds },
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST as any,
          },
          data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
        });
      }
      if (baseSwapIds.length > 0) {
        await prisma.trackedMessage.updateMany({
          where: {
            guildId,
            id: { in: baseSwapIds },
            status: TRACKED_MESSAGE_STATUS.ACTIVE,
            featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
          },
          data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
        });
      }
    }

    return {
      guildId,
      currentSyncMessageId,
      currentSyncCreatedAtIso,
      dryRun: !apply,
      basesCompletionCandidates: basesCompletionCandidateRows.length,
      basesCompletionReplaced: basesCompletionIds.length,
      baseSwapCandidates: baseSwapIds.length,
      baseSwapExpiredCandidates: baseSwapExpiredRows.length,
      baseSwapOlderThanCurrentSyncCandidates: baseSwapOlderRows.length,
      baseSwapReplaced: baseSwapIds.length,
    };
  }

  async repairUnscopedFwaBaseSwapSyncIdentity(params: {
    guildId: string;
    now?: Date;
    apply?: boolean;
  }): Promise<FwaBaseSwapSyncIdentityRepairSummary> {
    const guildId = String(params.guildId ?? "").trim();
    const now = params.now instanceof Date && Number.isFinite(params.now.getTime())
      ? params.now
      : new Date();
    const apply = params.apply ?? false;
    if (!guildId) {
      return {
        guildId,
        dryRun: !apply,
        scannedRows: 0,
        eligibleRows: 0,
        repairedRows: 0,
        skippedNoCurrentWar: 0,
        skippedNoSyncIdentity: 0,
        skippedInvalidMetadata: 0,
        skippedOutsideWindow: 0,
      };
    }

    const [candidateRows, currentWarRows] = await Promise.all([
      prisma.trackedMessage.findMany({
        where: {
          guildId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP as any,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        },
        select: {
          id: true,
          clanTag: true,
          createdAt: true,
          expiresAt: true,
          metadata: true,
        },
      }),
      prisma.currentWar.findMany({
        where: { guildId },
        select: {
          clanTag: true,
          state: true,
          prepStartTime: true,
          startTime: true,
          endTime: true,
          updatedAt: true,
        },
      }),
    ]);

    const currentWarByClan = new Map<string, FwaBaseSwapCurrentWarSnapshot>();
    for (const row of currentWarRows) {
      const normalizedClanTag = normalizeChecklistClanTag(row.clanTag);
      if (!normalizedClanTag) continue;
      const updatedAt = row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime())
        ? row.updatedAt
        : null;
      const existing = currentWarByClan.get(normalizedClanTag);
      if (!existing) {
        currentWarByClan.set(normalizedClanTag, {
          clanTag: normalizedClanTag,
          state: String(row.state ?? "").trim() || null,
          prepStartTime: row.prepStartTime ?? null,
          startTime: row.startTime ?? null,
          endTime: row.endTime ?? null,
          updatedAt,
        });
        continue;
      }
      const existingUpdatedAtMs = existing.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const nextUpdatedAtMs = updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (nextUpdatedAtMs >= existingUpdatedAtMs) {
        currentWarByClan.set(normalizedClanTag, {
          clanTag: normalizedClanTag,
          state: String(row.state ?? "").trim() || null,
          prepStartTime: row.prepStartTime ?? null,
          startTime: row.startTime ?? null,
          endTime: row.endTime ?? null,
          updatedAt,
        });
      }
    }

    let scannedRows = 0;
    let eligibleRows = 0;
    let repairedRows = 0;
    let skippedNoCurrentWar = 0;
    let skippedNoSyncIdentity = 0;
    let skippedInvalidMetadata = 0;
    let skippedOutsideWindow = 0;

    for (const row of candidateRows) {
      scannedRows += 1;
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) {
        skippedInvalidMetadata += 1;
        continue;
      }
      if (normalizeTrackedMessageId(metadata.syncMessageId ?? null)) {
        continue;
      }

      const normalizedClanTag = normalizeChecklistClanTag(row.clanTag ?? "");
      const currentWar = normalizedClanTag ? currentWarByClan.get(normalizedClanTag) ?? null : null;
      if (!currentWar) {
        skippedNoCurrentWar += 1;
        continue;
      }

      const syncIdentity = await this.resolveFwaBaseSwapSyncIdentityForClanWar({
        guildId,
        clanTag: normalizedClanTag,
        battleDayStart: currentWar.startTime,
        prepStartTime: currentWar.prepStartTime,
        now,
      }).catch(() => ({ syncMessageId: null, source: "none" as const }));
      const syncMessageId = normalizeTrackedMessageId(syncIdentity.syncMessageId ?? null);
      if (!syncMessageId) {
        skippedNoSyncIdentity += 1;
        continue;
      }

      const syncRow = await prisma.trackedMessage.findUnique({
        where: { messageId: syncMessageId },
        select: {
          createdAt: true,
          messageId: true,
        },
      }).catch(() => null);
      if (
        !syncRow ||
        !(syncRow.createdAt instanceof Date) ||
        !Number.isFinite(syncRow.createdAt.getTime())
      ) {
        skippedInvalidMetadata += 1;
        continue;
      }

      const rowCreatedAtMs = row.createdAt.getTime();
      const syncCreatedAtMs = syncRow.createdAt.getTime();
      if (
        rowCreatedAtMs < syncCreatedAtMs ||
        rowCreatedAtMs > syncCreatedAtMs + FWA_BASE_SWAP_SYNC_REPAIR_WINDOW_MS
      ) {
        skippedOutsideWindow += 1;
        continue;
      }

      eligibleRows += 1;
      if (!apply) continue;

      await prisma.trackedMessage.update({
        where: { id: row.id },
        data: {
          metadata: {
            ...metadata,
            syncMessageId,
          } as any,
        },
      });
      repairedRows += 1;
    }

    return {
      guildId,
      dryRun: !apply,
      scannedRows,
      eligibleRows,
      repairedRows,
      skippedNoCurrentWar,
      skippedNoSyncIdentity,
      skippedInvalidMetadata,
      skippedOutsideWindow,
    };
  }

  async processDueExpirations(): Promise<number> {
    const now = new Date();
    const result = await prisma.trackedMessage.updateMany({
      where: {
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        expiresAt: { lte: now },
      },
      data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
    });
    return result.count;
  }

  async processDueSyncReminders(client: Client): Promise<number> {
    const now = new Date();
    const due = await prisma.trackedMessage.findMany({
      where: {
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        remindAt: { lte: now },
      },
      include: { claims: true },
      orderBy: [{ remindAt: "asc" }, { createdAt: "asc" }],
    });

    let sentCount = 0;
    for (const tracked of due) {
      const metadata = parseSyncTimeMetadata(tracked.metadata);
      if (!metadata) {
        await prisma.trackedMessage.update({
          where: { id: tracked.id },
          data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
        });
        continue;
      }
      const existingStatus = await prisma.trackedMessage.findFirst({
        where: {
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          referenceId: tracked.messageId,
        },
        select: { id: true },
      });

      let didWork = false;
      if (!metadata.reminderSentAt) {
        await sendSyncTimeReminderDms({
          client,
          tracked: {
            messageId: tracked.messageId,
            claims: tracked.claims as Array<{ clanTag: string; userId: string }>,
          },
          metadata,
        });
        metadata.reminderSentAt = now.toISOString();
        await prisma.trackedMessage.update({
          where: { id: tracked.id },
          data: { metadata: metadata as any },
        });
        didWork = true;
      }

      if (existingStatus) {
        if (!metadata.statusPostedAt) {
          metadata.statusPostedAt = now.toISOString();
          await prisma.trackedMessage.update({
            where: { id: tracked.id },
            data: { metadata: metadata as any },
          });
          didWork = true;
        }
        if (didWork) sentCount += 1;
        continue;
      }

      const guild = await client.guilds.fetch(tracked.guildId).catch(() => null);
      if (!guild) {
        console.error(
          `[tracked-message] sync status post skipped guild_missing message=${tracked.messageId}`,
        );
        if (didWork) sentCount += 1;
        continue;
      }
      const botLogChannelService = new BotLogChannelService();
      const typedSyncChannelId = await botLogChannelService.getChannelIdForType(
        tracked.guildId,
        "sync",
      );
      let destinationChannelId = tracked.channelId;
      if (typedSyncChannelId) {
        destinationChannelId = typedSyncChannelId;
      }

      let channel = await guild.channels.fetch(destinationChannelId).catch((err) => {
        console.error(
          `[tracked-message] sync status destination fetch failed event=sync_status_destination_fetch_failed guild=${tracked.guildId} configured_channel=${destinationChannelId} fallback_channel=${tracked.channelId} typed_sync_channel=${typedSyncChannelId ?? "none"} message=${tracked.messageId} error=${formatError(err)}`,
        );
        return null;
      });
      if (
        typedSyncChannelId &&
        (!channel || !channel.isTextBased() || !("send" in channel))
      ) {
        console.error(
          `[tracked-message] sync status typed destination unavailable event=sync_status_typed_destination_unavailable guild=${tracked.guildId} configured_channel=${typedSyncChannelId} fallback_channel=${tracked.channelId} message=${tracked.messageId}`,
        );
        channel = await guild.channels.fetch(tracked.channelId).catch((err) => {
          console.error(
            `[tracked-message] sync status fallback fetch failed event=sync_status_fallback_fetch_failed guild=${tracked.guildId} fallback_channel=${tracked.channelId} message=${tracked.messageId} error=${formatError(err)}`,
          );
          return null;
        });
        destinationChannelId = tracked.channelId;
      }
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        console.error(
          `[tracked-message] sync status post skipped channel_unavailable guild=${tracked.guildId} channel=${destinationChannelId} source_channel=${tracked.channelId} message=${tracked.messageId}`,
        );
        if (didWork) sentCount += 1;
        continue;
      }

      const embed = buildSyncSpinStatusEmbed({
        guildId: tracked.guildId,
        sourceChannelId: tracked.channelId,
        sourceMessageId: tracked.messageId,
        metadata,
        claimedClanTags: [],
        title: "Sync Spin Status",
      });

      const sentMessage = await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      }).catch((err) => {
        console.error(
          `[tracked-message] sync status post failed guild=${tracked.guildId} channel=${destinationChannelId} source_channel=${tracked.channelId} message=${tracked.messageId} error=${formatError(err)}`,
        );
        return null;
      });
      if (!sentMessage) {
        if (didWork) sentCount += 1;
        continue;
      }

      metadata.statusPostedAt = now.toISOString();
      await prisma.trackedMessage.update({
        where: { id: tracked.id },
        data: { metadata: metadata as any },
      });

      await prisma.trackedMessage.upsert({
        where: { messageId: sentMessage.id },
        update: {
          guildId: tracked.guildId,
          channelId: destinationChannelId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          clanTag: tracked.clanTag ?? null,
          referenceId: tracked.messageId,
          remindAt: null,
          expiresAt: tracked.expiresAt,
          metadata: metadata as any,
        },
        create: {
          guildId: tracked.guildId,
          channelId: destinationChannelId,
          messageId: sentMessage.id,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          clanTag: tracked.clanTag ?? null,
          referenceId: tracked.messageId,
          remindAt: null,
          expiresAt: tracked.expiresAt,
          metadata: metadata as any,
        },
      });

      for (const clan of metadata.clans) {
        try {
          await sentMessage.react(clan.emojiInline);
        } catch (err) {
          console.error(
            `[tracked-message] sync status post react failed guild=${tracked.guildId} channel=${tracked.channelId} message=${sentMessage.id} clan=${clan.clanTag} emoji=${clan.emojiInline} error=${formatError(err)}`,
          );
        }
      }
      didWork = true;
      sentCount += 1;
    }
    return sentCount;
  }

  async fetchSyncTrackedMessageWithClaims(messageId: string) {
    return prisma.trackedMessage.findUnique({
      where: { messageId },
      include: { claims: true },
    });
  }

  async refreshSyncSpinStatusMessage(message: {
    id: string;
    edit: (payload: { embeds: EmbedBuilder[] }) => Promise<unknown>;
  }): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({
      where: { messageId: message.id },
      include: { claims: true },
    });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if (tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST) return false;
    if (!tracked.referenceId) return false;

    const metadata = parseSyncTimeMetadata(tracked.metadata);
    if (!metadata) return false;
    const sourceSyncPost = await prisma.trackedMessage.findUnique({
      where: { messageId: tracked.referenceId },
      select: { channelId: true },
    });
    const sourceChannelId = sourceSyncPost?.channelId ?? tracked.channelId;

    const embed = buildSyncSpinStatusEmbed({
      guildId: tracked.guildId,
      sourceChannelId,
      sourceMessageId: tracked.referenceId,
      metadata,
      claimedClanTags: new Set(
        tracked.claims.map((claim) => String(claim.clanTag ?? "").trim()).filter(Boolean),
      ),
      title: "Sync Spin Status",
    });
    await message.edit({ embeds: [embed] });
    return true;
  }

  async refreshFwaMatchChecklistMessage(message: {
    id: string;
    partial?: boolean;
    fetch?: () => Promise<any>;
    reactions: {
      cache: {
        size?: number;
        values(): IterableIterator<{
          emoji: { id: string | null; name: string | null };
          count?: number | null;
        }>;
      };
    };
    edit: (payload: {
      content: string;
      allowedMentions?: { parse: [] };
    }) => Promise<unknown>;
  },
  change?: FwaMatchChecklistReactionChange | null,
  options?: FwaMatchChecklistRefreshOptions,
  ): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({
      where: { messageId: message.id },
    });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if ((tracked.featureType as string) !== TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST) return false;
    if (tracked.expiresAt instanceof Date && tracked.expiresAt.getTime() <= Date.now()) {
      await prisma.trackedMessage.update({
        where: { messageId: message.id },
        data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
      });
      return false;
    }

    const metadata = parseFwaMatchChecklistMetadata(tracked.metadata);
    if (!metadata) {
      await prisma.trackedMessage.update({
        where: { messageId: message.id },
        data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
      });
      return false;
    }

    const viewType = resolveFwaMatchChecklistViewType(tracked.metadata);
    if (viewType === "Bases") {
      const syncReferenceId = normalizeTrackedMessageId(tracked.referenceId ?? null);
      const hydratedReactionCache = await hydrateFwaMatchChecklistReactionCache({
        guildId: tracked.guildId,
        messageId: message.id,
        message,
      });
      console.debug(
        `[fwa_checklist_bases_refresh_state] checklistMessageId=${message.id} trackedReferenceId=${tracked.referenceId ?? "none"} syncIdentityUsed=${syncReferenceId ?? "none"} rowCount=${(options?.rows ?? metadata.rows).length}`,
      );
      const sourceRows = options?.rows ?? metadata.rows;
      const persistBasesCheckedStateForRow = async (
        row: FwaMatchChecklistTrackedRow,
        checked: boolean,
      ): Promise<void> => {
        const warStartTime = row.warStartTimeIso ? new Date(row.warStartTimeIso) : null;
        const hasWarIdentity = Boolean(row.warId || row.opponentTag || warStartTime);
        const activeBaseSwap = await this.findLatestActiveFwaBaseSwapTrackedMessageForClan({
          guildId: tracked.guildId,
          clanTag: row.clanTag,
          syncMessageId: syncReferenceId,
        }).catch(() => null);
        if (checked && activeBaseSwap) {
          const issueSummary = buildFwaBaseSwapIssueSummary(
            activeBaseSwap.metadata,
            String(row.matchType ?? "").trim() || null,
          );
          if (issueSummary.hasIssues) {
            return;
          }
        }
        await this.setFwaMatchChecklistBasesCompletion({
          guildId: tracked.guildId,
          channelId: tracked.channelId,
          createdByUserId: metadata.createdByUserId,
          clanTag: row.clanTag,
          clanName: null,
          ...(hasWarIdentity
            ? {
                warId: row.warId ?? null,
                warStartTime,
                opponentTag: row.opponentTag ?? null,
              }
            : {
                syncReferenceId,
              }),
          checked,
        });
      };
      const changedRowTag = change
        ? findChecklistRowTagForReaction(sourceRows, change.reaction)
        : null;
      if (change && changedRowTag) {
        const reactionChange = change;
        const matchedRow = sourceRows.find(
          (row) => normalizeChecklistClanTag(row.clanTag) === changedRowTag,
        );
        console.debug(
          `[fwa_checklist_reaction_matched] guildId=${tracked.guildId} messageId=${message.id} clanTag=${changedRowTag} matched=${Boolean(matchedRow)} reason=${matchedRow ? "matched_row" : "row_not_found"}`,
        );
        if (matchedRow) {
          const checked =
            reactionChange.kind === "add" ||
            (reactionChange.kind === "remove" && (reactionChange.reaction.count ?? 0) > 1);
          await persistBasesCheckedStateForRow(matchedRow, checked);
        }
      } else if (!change) {
        for (const row of sourceRows) {
          const reaction = [...hydratedReactionCache.values()].find((candidate) =>
            emojiMatches(candidate, {
              emojiId: row.badgeEmojiId,
              emojiName: row.badgeEmojiName,
            }),
          );
          console.debug(
            `[fwa_checklist_reaction_matched] guildId=${tracked.guildId} messageId=${message.id} clanTag=${row.clanTag} matched=${Boolean(reaction && (reaction.count ?? 0) > 1)} reason=${reaction ? (reaction.count ?? 0) > 1 ? "reaction_count_gt_1" : "reaction_count_le_1" : "no_reaction"}`,
          );
          if (!reaction) continue;
          if ((reaction.count ?? 0) > 1) {
            await persistBasesCheckedStateForRow(row, true);
          }
        }
      }

      const [stateService, checklistService] = await Promise.all([
        import("./FwaMatchChecklistStateService"),
        import("./FwaMatchChecklistService"),
      ]);
      const checklistState = await stateService.buildFwaMatchChecklistRenderStateForGuild({
        cocService: {} as any,
        guildId: tracked.guildId,
        client: (message as { client?: Client }).client ?? ({} as Client),
        viewType: "Bases",
        syncMessageId: syncReferenceId,
      });
      const effectiveRows = checklistState.rows;
      const content = checklistService.buildFwaMatchBasesMessageContent({
        rows: effectiveRows,
      });
      const extendedExpiresAt = resolveExtendedChecklistExpiresAt(
        tracked.expiresAt ?? null,
        options?.expiresAt ?? null,
      );
      await message.edit({
        content,
        allowedMentions: { parse: [] },
      });
      await prisma.trackedMessage.update({
        where: { messageId: message.id },
        data: {
          ...(extendedExpiresAt ? { expiresAt: extendedExpiresAt } : {}),
          metadata: {
            kind: "bases_checklist",
            createdByUserId: metadata.createdByUserId,
            createdAtIso: metadata.createdAtIso,
            scopeKey: options?.scopeKey ?? metadata.scopeKey ?? null,
            referenceId: tracked.referenceId ?? null,
            checkedClanTags: [],
            rows: effectiveRows.map((row) => ({ ...row })),
            guildId: tracked.guildId,
            channelId: tracked.channelId,
            messageId: tracked.messageId,
            clanTag: tracked.clanTag ?? null,
          } as any,
        },
      });
      return true;
    }

    const persistedCheckedTags = new Set(
      (metadata.checkedClanTags ?? [])
        .map((clanTag) => normalizeChecklistClanTag(clanTag))
        .filter((clanTag): clanTag is string => Boolean(clanTag)),
    );
    const reactedTags = new Set<string>(persistedCheckedTags);
    for (const row of metadata.rows) {
      const reaction = [...message.reactions.cache.values()].find((candidate) =>
        emojiMatches(candidate, {
          emojiId: row.badgeEmojiId,
          emojiName: row.badgeEmojiName,
        }),
      );
      if (!reaction) continue;
      if ((reaction.count ?? 0) > 1) {
        reactedTags.add(normalizeChecklistClanTag(row.clanTag));
      }
    }
    if (change) {
      const changedRowTag = findChecklistRowTagForReaction(metadata.rows, change.reaction);
      if (changedRowTag) {
        const changeCount = Math.trunc(Number(change.reaction.count ?? 0));
        if (change.kind === "add") {
          reactedTags.add(changedRowTag);
        } else if (change.kind === "remove" && changeCount <= 1) {
          reactedTags.delete(changedRowTag);
        }
      }
    }

    const effectiveRows = options?.rows ?? metadata.rows;
    const content = buildFwaMatchChecklistMessageContent({
      rows: effectiveRows,
      checkedClanTags: reactedTags,
    });
    const extendedExpiresAt = resolveExtendedChecklistExpiresAt(
      tracked.expiresAt ?? null,
      options?.expiresAt ?? null,
    );
    await message.edit({
      content,
      allowedMentions: { parse: [] },
    });
    await prisma.trackedMessage.update({
      where: { messageId: message.id },
      data: {
        ...(extendedExpiresAt
          ? { expiresAt: extendedExpiresAt }
          : {}),
        metadata: {
          createdByUserId: metadata.createdByUserId,
          createdAtIso: metadata.createdAtIso,
          scopeKey: options?.scopeKey ?? metadata.scopeKey ?? null,
          referenceId: tracked.referenceId ?? null,
          checkedClanTags: [...reactedTags],
          rows: effectiveRows.map((row) => ({ ...row })),
        } as any,
      },
    });
    return true;
  }
}

export const trackedMessageService = new TrackedMessageService();
