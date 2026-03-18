import { Client } from "discord.js";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";

export const TRACKED_MESSAGE_FEATURE_TYPE = {
  FWA_BASE_SWAP: "FWA_BASE_SWAP",
  SYNC_TIME_POST: "SYNC_TIME_POST",
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
  clanName: string;
  createdByUserId: string;
  createdAtIso: string;
  entries: Array<{
    position: number;
    playerTag: string;
    playerName: string;
    discordUserId: string | null;
    section: "war_bases" | "base_errors";
    acknowledged: boolean;
  }>;
};

export type SyncTimeTrackedMetadata = {
  syncTimeIso: string;
  syncEpochSeconds: number;
  roleId: string;
  clans: Array<{
    clanTag: string;
    clanName: string;
    emojiId: string | null;
    emojiName: string | null;
    emojiInline: string;
  }>;
  reminderSentAt?: string | null;
};

function activeWhere(featureType?: TrackedMessageFeatureType) {
  return {
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    ...(featureType ? { featureType } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseFwaBaseSwapMetadata(value: unknown): FwaBaseSwapTrackedMetadata | null {
  if (!isObject(value) || !Array.isArray(value.entries)) return null;
  const clanName = String(value.clanName ?? "").trim();
  const createdByUserId = String(value.createdByUserId ?? "").trim();
  const createdAtIso = String(value.createdAtIso ?? "").trim();
  if (!clanName || !createdByUserId || !createdAtIso) return null;
  const entries = value.entries
    .map((entry) => {
      if (!isObject(entry)) return null;
      const position = Number(entry.position);
      const playerTag = String(entry.playerTag ?? "").trim();
      const playerName = String(entry.playerName ?? "").trim();
      const discordUserIdRaw = String(entry.discordUserId ?? "").trim();
      const section = entry.section === "base_errors" ? "base_errors" : "war_bases";
      return {
        position: Number.isFinite(position) ? Math.trunc(position) : 0,
        playerTag,
        playerName,
        discordUserId: discordUserIdRaw || null,
        section,
        acknowledged: Boolean(entry.acknowledged),
      };
    })
    .filter(
      (entry): entry is FwaBaseSwapTrackedMetadata["entries"][number] =>
        Boolean(entry && entry.position > 0 && entry.playerTag && entry.playerName)
    );
  if (entries.length === 0) return null;
  return { clanName, createdByUserId, createdAtIso, entries };
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
      const clanTag = String(clan.clanTag ?? "").trim();
      const clanName = String(clan.clanName ?? "").trim();
      const emojiInline = String(clan.emojiInline ?? "").trim();
      const emojiIdRaw = String(clan.emojiId ?? "").trim();
      const emojiNameRaw = String(clan.emojiName ?? "").trim();
      if (!clanTag || !clanName || !emojiInline) return null;
      return {
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

function emojiMatches(
  reaction: { emoji: { id: string | null; name: string | null } },
  target: { emojiId: string | null; emojiName: string | null },
): boolean {
  if (reaction.emoji.id && target.emojiId && reaction.emoji.id === target.emojiId) return true;
  return Boolean(reaction.emoji.name && target.emojiName && reaction.emoji.name === target.emojiName);
}

export class TrackedMessageService {
  async createFwaBaseSwapTrackedMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    clanTag: string;
    expiresAt: Date;
    metadata: FwaBaseSwapTrackedMetadata;
  }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.trackedMessage.updateMany({
        where: {
          guildId: params.guildId,
          clanTag: params.clanTag,
          ...activeWhere(TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP),
        },
        data: { status: TRACKED_MESSAGE_STATUS.REPLACED },
      });

      await tx.trackedMessage.upsert({
        where: { messageId: params.messageId },
        update: {
          guildId: params.guildId,
          channelId: params.channelId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          clanTag: params.clanTag,
          expiresAt: params.expiresAt,
          metadata: params.metadata as any,
        },
        create: {
          guildId: params.guildId,
          channelId: params.channelId,
          messageId: params.messageId,
          featureType: TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
          clanTag: params.clanTag,
          expiresAt: params.expiresAt,
          metadata: params.metadata as any,
        },
      });
    });
  }

  async getActiveByMessageId(messageId: string) {
    return prisma.trackedMessage.findUnique({ where: { messageId } });
  }

  async markMessageDeleted(messageId: string): Promise<void> {
    const tracked = await prisma.trackedMessage.findUnique({ where: { messageId } });
    if (!tracked) return;
    if (tracked.status === TRACKED_MESSAGE_STATUS.DELETED) return;
    await prisma.trackedMessage.update({
      where: { messageId },
      data: { status: TRACKED_MESSAGE_STATUS.DELETED },
    });
  }

  async handleFwaBaseSwapReaction(params: {
    messageId: string;
    reactorUserId: string;
    message: { edit: (payload: { content: string; allowedMentions: { users: string[] } }) => Promise<unknown> };
    render: (metadata: FwaBaseSwapTrackedMetadata) => string;
    truncate: (content: string) => string;
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

    await params.message.edit({
      content: params.truncate(params.render(metadata)),
      allowedMentions: {
        users: metadata.entries.flatMap((entry) => (entry.discordUserId ? [entry.discordUserId] : [])),
      },
    });

    const allAcknowledged = metadata.entries.every((entry) => !entry.discordUserId || entry.acknowledged);
    await prisma.trackedMessage.update({
      where: { messageId: params.messageId },
      data: {
        status: allAcknowledged ? TRACKED_MESSAGE_STATUS.COMPLETED : TRACKED_MESSAGE_STATUS.ACTIVE,
        metadata: metadata as any,
      },
    });
    return true;
  }

  async createSyncTimeTrackedMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    remindAt: Date;
    expiresAt: Date;
    metadata: SyncTimeTrackedMetadata;
  }): Promise<void> {
    await prisma.trackedMessage.upsert({
      where: { messageId: params.messageId },
      update: {
        guildId: params.guildId,
        channelId: params.channelId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        remindAt: params.remindAt,
        expiresAt: params.expiresAt,
        metadata: params.metadata as any,
      },
      create: {
        guildId: params.guildId,
        channelId: params.channelId,
        messageId: params.messageId,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        remindAt: params.remindAt,
        expiresAt: params.expiresAt,
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
      const claimsByUser = new Map<string, string[]>();
      const countByClan = new Map<string, number>();
      for (const claim of tracked.claims) {
        claimsByUser.set(claim.userId, [...(claimsByUser.get(claim.userId) ?? []), claim.clanTag]);
        countByClan.set(claim.clanTag, (countByClan.get(claim.clanTag) ?? 0) + 1);
      }

      for (const [userId, clanTags] of claimsByUser.entries()) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) continue;
        const uniqueClanTags = [...new Set(clanTags)];
        const clans = uniqueClanTags
          .map((clanTag) => {
            const clan = metadata.clans.find((entry) => entry.clanTag === clanTag);
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
            `<@${userId}> sync reminder for <t:${metadata.syncEpochSeconds}:F> (<t:${metadata.syncEpochSeconds}:R>).`,
            "You opted into these clans:",
            ...lines,
          ].join("\n"))
          .catch((err) => {
            console.error(
              `[tracked-message] sync reminder DM failed user=${userId} message=${tracked.messageId} error=${formatError(err)}`,
            );
          });
      }

      metadata.reminderSentAt = new Date().toISOString();
      await prisma.trackedMessage.update({
        where: { id: tracked.id },
        data: { metadata: metadata as any },
      });
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
}

export const trackedMessageService = new TrackedMessageService();
