import { Client, EmbedBuilder } from "discord.js";
import { normalizeClanTag } from "./PlayerLinkService";
import { resolveFwaMatchStateEmoji } from "./FwaMatchStateEmojiService";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";

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
  clanRoleId?: string | null;
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
const CUSTOM_EMOJI_INLINE_PATTERN = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,22})>$/;

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

function buildFwaMatchChecklistBasesCompletionKey(params: {
  guildId: string;
  clanTag: string;
  warId?: string | number | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
}): string | null {
  const guildId = String(params.guildId ?? "").trim();
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
  const warId = normalizeWarIdText(params.warId ?? null);
  const opponentTag = normalizeChecklistClanTag(String(params.opponentTag ?? ""));
  const warStartTimeIso = normalizeDateTimeIso(params.warStartTime ?? null);
  if (!guildId || !clanTag) return null;
  if (!warId && !opponentTag && !warStartTimeIso) return null;
  return [
    "fwa_match_checklist_bases_completion",
    `guild=${guildId}`,
    `clan=${clanTag}`,
    `war=${warId || "none"}`,
    `opponent=${opponentTag || "none"}`,
    `start=${warStartTimeIso || "none"}`,
  ].join("|");
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
): FwaBaseSwapIssueSummary {
  const activeIssueEntries = metadata.entries.filter(
    (entry) =>
      !entry.acknowledged &&
      (entry.section === "war_bases" || entry.section === "base_errors"),
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
    section: "war_bases" | "base_errors";
    label: string;
  }> = [
    { section: "war_bases", label: "War bases" },
    { section: "base_errors", label: "Base errors" },
  ];
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
}): Promise<string[]> {
  const scopeKey = String(params.scopeKey ?? "").trim();
  if (!scopeKey) return [];
  const clanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
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
    select: { metadata: true },
  });
  for (const row of rows) {
    const metadata = parseFwaMatchChecklistMetadata(row.metadata);
    if (!metadata || metadata.scopeKey !== scopeKey) continue;
    return metadata.checkedClanTags ?? [];
  }
  return [];
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
  const clanRoleId = String(value.clanRoleId ?? "").trim() || null;
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
    clanRoleId,
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
  if (!createdByUserId || !createdAtIso || !clanTag) return null;
  return {
    kind: "bases_completion",
    createdByUserId,
    createdAtIso,
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
    createdByUserId,
    createdAtIso,
    scopeKey: scopeKey || null,
    checkedClanTags,
    rows,
  };
}

export function resolveFwaMatchChecklistViewType(
  metadata: unknown,
): "Mail" | "Bases" {
  if (!isObject(metadata)) return "Mail";
  return String(metadata.kind ?? "").trim() === "bases_checklist" ? "Bases" : "Mail";
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
    messages: Array<{
      channelId: string;
      messageId: string;
      metadata: FwaBaseSwapTrackedMetadata;
    }>;
  }): Promise<void> {
    if (!Array.isArray(params.messages) || params.messages.length === 0) return;
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
            metadata: message.metadata as any,
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
            metadata: message.metadata as any,
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
    metadata: FwaBaseSwapTrackedMetadata;
  }): Promise<void> {
    await this.createFwaBaseSwapTrackedMessages({
      guildId: params.guildId,
      clanTag: params.clanTag,
      expiresAt: params.expiresAt,
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
  }): Promise<FwaBaseSwapTrackedMessageSnapshot | null> {
    const guildId = String(params.guildId ?? "").trim();
    const normalizedClanTag = normalizeChecklistClanTag(String(params.clanTag ?? ""));
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

    for (const row of rows) {
      const metadata = parseFwaBaseSwapMetadata(row.metadata);
      if (!metadata) continue;
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
  }): Promise<boolean> {
    const messageId = buildFwaMatchChecklistBasesCompletionKey({
      guildId: params.guildId,
      clanTag: params.clanTag,
      warId: params.warId ?? null,
      opponentTag: params.opponentTag ?? null,
      warStartTime: params.warStartTime ?? null,
    });
    if (!messageId) return false;
    const createdAtIso = new Date().toISOString();
    const normalizedClanTag = normalizeChecklistClanTag(params.clanTag);
    const metadata: FwaMatchChecklistBasesCompletionMetadata = {
      kind: "bases_completion",
      createdByUserId: params.createdByUserId,
      createdAtIso,
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
        referenceId: null,
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
        referenceId: null,
        clanTag: normalizedClanTag,
        expiresAt: null,
        metadata: metadata as any,
      },
    });
    return true;
  }

  async findLatestFwaMatchChecklistBasesCompletionForClan(params: {
    guildId: string;
    clanTag: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
  }): Promise<FwaMatchChecklistBasesCompletionSnapshot | null> {
    const messageId = buildFwaMatchChecklistBasesCompletionKey({
      guildId: params.guildId,
      clanTag: params.clanTag,
      warId: params.warId ?? null,
      opponentTag: params.opponentTag ?? null,
      warStartTime: params.warStartTime ?? null,
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
      const channel = await guild.channels.fetch(tracked.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        console.error(
          `[tracked-message] sync status post skipped channel_unavailable guild=${tracked.guildId} channel=${tracked.channelId} message=${tracked.messageId}`,
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
          `[tracked-message] sync status post failed guild=${tracked.guildId} channel=${tracked.channelId} message=${tracked.messageId} error=${formatError(err)}`,
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
          channelId: tracked.channelId,
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
          channelId: tracked.channelId,
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

    const embed = buildSyncSpinStatusEmbed({
      guildId: tracked.guildId,
      sourceChannelId: tracked.channelId,
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
    reactions: {
      cache: {
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
      const changedRowTag = change
        ? findChecklistRowTagForReaction(metadata.rows, change.reaction)
        : null;
      if (change && changedRowTag) {
        const reactionChange = change;
        const matchedRow = metadata.rows.find(
          (row) => normalizeChecklistClanTag(row.clanTag) === changedRowTag,
        );
        if (matchedRow) {
          const warStartTime = matchedRow.warStartTimeIso
            ? new Date(matchedRow.warStartTimeIso)
            : null;
          const checked =
            reactionChange.kind === "add" ||
            (reactionChange.kind === "remove" && (reactionChange.reaction.count ?? 0) > 1);
          if (checked) {
            await this.setFwaMatchChecklistBasesCompletion({
              guildId: tracked.guildId,
              channelId: tracked.channelId,
              createdByUserId: metadata.createdByUserId,
              clanTag: matchedRow.clanTag,
              clanName: null,
              warId: matchedRow.warId ?? null,
              warStartTime,
              opponentTag: matchedRow.opponentTag ?? null,
              checked: true,
            });
          } else if (
            reactionChange.kind === "remove" &&
            (reactionChange.reaction.count ?? 0) <= 1
          ) {
            await this.setFwaMatchChecklistBasesCompletion({
              guildId: tracked.guildId,
              channelId: tracked.channelId,
              createdByUserId: metadata.createdByUserId,
              clanTag: matchedRow.clanTag,
              clanName: null,
              warId: matchedRow.warId ?? null,
              warStartTime,
              opponentTag: matchedRow.opponentTag ?? null,
              checked: false,
            });
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
      });
      const content = checklistService.buildFwaMatchBasesMessageContent({
        rows: checklistState.rows,
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
            checkedClanTags: [],
            rows: checklistState.rows.map((row) => ({ ...row })),
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
          checkedClanTags: [...reactedTags],
          rows: effectiveRows.map((row) => ({ ...row })),
        } as any,
      },
    });
    return true;
  }
}

export const trackedMessageService = new TrackedMessageService();
