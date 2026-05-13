import { Client, EmbedBuilder } from "discord.js";
import { normalizeClanTag } from "./PlayerLinkService";
import { resolveFwaMatchStateEmoji } from "../commands/fwa/matchStateEmoji";
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
};

export type FwaMatchChecklistTrackedRow = {
  clanTag: string;
  compactCopyLine: string;
  badgeEmojiId: string | null;
  badgeEmojiName: string | null;
  badgeEmojiInline: string;
};

export type FwaMatchChecklistTrackedMetadata = {
  createdByUserId: string;
  createdAtIso: string;
  rows: FwaMatchChecklistTrackedRow[];
};

const FWA_MATCH_CHECKLIST_CHECKED_EMOJI = "✅";
const FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI = "☐";

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

function insertFwaMatchChecklistColumn(line: string, checked: boolean): string {
  const normalized = String(line ?? "").trim();
  if (!normalized) return normalized;
  const firstSeparator = normalized.indexOf(" | ");
  if (firstSeparator < 0) return normalized;
  const secondSeparator = normalized.indexOf(" | ", firstSeparator + 3);
  if (secondSeparator < 0) return normalized;
  const mark = checked ? FWA_MATCH_CHECKLIST_CHECKED_EMOJI : FWA_MATCH_CHECKLIST_UNCHECKED_EMOJI;
  return `${normalized.slice(0, secondSeparator + 3)}${mark} | ${normalized.slice(secondSeparator + 3)}`;
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
  return {
    syncTimeIso,
    syncEpochSeconds: Math.trunc(syncEpochSeconds),
    roleId,
    clans,
    reminderSentAt: typeof value.reminderSentAt === "string" ? value.reminderSentAt : null,
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
  return {
    clanTag,
    compactCopyLine,
    badgeEmojiId: badgeEmojiId || null,
    badgeEmojiName: badgeEmojiName || null,
    badgeEmojiInline: badgeEmojiInline || "",
  };
}

export function parseFwaMatchChecklistMetadata(
  value: unknown,
): FwaMatchChecklistTrackedMetadata | null {
  if (!isObject(value) || !Array.isArray(value.rows)) return null;
  const createdByUserId = String(value.createdByUserId ?? "").trim();
  const createdAtIso = String(value.createdAtIso ?? "").trim();
  if (!createdByUserId || !createdAtIso) return null;
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
    rows,
  };
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

function emojiMatches(
  reaction: { emoji: { id: string | null; name: string | null } },
  target: { emojiId: string | null; emojiName: string | null },
): boolean {
  if (reaction.emoji.id && target.emojiId && reaction.emoji.id === target.emojiId) return true;
  return Boolean(reaction.emoji.name && target.emojiName && reaction.emoji.name === target.emojiName);
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
      if (!metadata.swapReminder) continue;
      if (!metadata.entries.some((entry) => entry.section === "fwa_bases")) {
        continue;
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
        allowedMentions: { users: string[] };
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
            allowedMentions: { users: string[] };
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
      if (metadata.reminderSentAt) continue;
      const existingStatus = await prisma.trackedMessage.findFirst({
        where: {
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          referenceId: tracked.messageId,
        },
        select: { id: true },
      });
      if (existingStatus) {
        if (!metadata.reminderSentAt) {
          metadata.reminderSentAt = now.toISOString();
          await prisma.trackedMessage.update({
            where: { id: tracked.id },
            data: { metadata: metadata as any },
          });
        }
        continue;
      }

      const guild = await client.guilds.fetch(tracked.guildId).catch(() => null);
      if (!guild) {
        console.error(
          `[tracked-message] sync status post skipped guild_missing message=${tracked.messageId}`,
        );
        continue;
      }
      const channel = await guild.channels.fetch(tracked.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        console.error(
          `[tracked-message] sync status post skipped channel_unavailable guild=${tracked.guildId} channel=${tracked.channelId} message=${tracked.messageId}`,
        );
        continue;
      }

      const embed = buildSyncSpinStatusEmbed({
        guildId: tracked.guildId,
        sourceChannelId: tracked.channelId,
        sourceMessageId: tracked.messageId,
        metadata,
        claimedClanTags: new Set(
          tracked.claims.map((claim) => String(claim.clanTag ?? "").trim()).filter(Boolean),
        ),
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
      if (!sentMessage) continue;

      metadata.reminderSentAt = now.toISOString();
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
  }): Promise<boolean> {
    const tracked = await prisma.trackedMessage.findUnique({
      where: { messageId: message.id },
    });
    if (!tracked || tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE) return false;
    if ((tracked.featureType as string) !== TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST) return false;

    const metadata = parseFwaMatchChecklistMetadata(tracked.metadata);
    if (!metadata) {
      await prisma.trackedMessage.update({
        where: { messageId: message.id },
        data: { status: TRACKED_MESSAGE_STATUS.EXPIRED },
      });
      return false;
    }

    const reactedTags = new Set<string>();
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

    const content = buildFwaMatchChecklistContent({
      rows: metadata.rows,
      checkedClanTags: reactedTags,
    });
    await message.edit({
      content,
      allowedMentions: { parse: [] },
    });
    return true;
  }
}

export const trackedMessageService = new TrackedMessageService();
