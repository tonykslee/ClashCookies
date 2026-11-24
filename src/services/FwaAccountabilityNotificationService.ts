import { randomUUID } from "node:crypto";
import {
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import {
  FwaAccountabilityNotificationStatus,
} from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  botLogChannelService,
  type BotLogChannelService,
  type RoutedBotLogChannelType,
} from "./BotLogChannelService";
import { normalizeClanTag } from "./PlayerLinkService";

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_FAILURE_REASON_LENGTH = 500;

type AccountabilityDb = {
  fwaAccountabilityNotification: {
    upsert: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  trackedClan: {
    findFirst: (args: any) => Promise<any>;
  };
};

type AccountabilityEventType =
  | "BASES_CHECKED"
  | "MAIL_POSTED"
  | "MAIL_CONFIRMED";

type AccountabilityRoute =
  | "bases-checked"
  | "mail-posted"
  | "mail-confirmed";

type WarSyncIdentity = {
  warId?: string | number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
  syncMessageId?: string | null;
};

type AccountabilityNotificationInput = WarSyncIdentity & {
  client: Client;
  guildId: string;
  clanTag: string;
  clanName?: string | null;
  actorUserId: string;
  eventKey: string;
  eventType: AccountabilityEventType;
  route: AccountabilityRoute;
  content: string;
};

function normalizeId(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return /^\d+$/.test(value) ? value : null;
}

function normalizeDate(input: Date | null | undefined): string | null {
  return input instanceof Date && Number.isFinite(input.getTime())
    ? input.toISOString()
    : null;
}

function normalizeWarId(input: string | number | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return /^\d+$/.test(value) ? String(Math.trunc(Number(value))) : null;
}

function normalizeOpponentTag(input: string | null | undefined): string | null {
  const value = normalizeClanTag(String(input ?? ""));
  return value || null;
}

/** Purpose: construct the authoritative identity fragment used by checklist dedupe. */
export function buildFwaAccountabilityWarSyncIdentityForTest(
  input: WarSyncIdentity,
): string | null {
  const warId = normalizeWarId(input.warId);
  const warStartTime = normalizeDate(input.warStartTime);
  const opponentTag = normalizeOpponentTag(input.opponentTag);
  const syncMessageId = normalizeId(input.syncMessageId);
  if (!warId && !warStartTime && !syncMessageId) return null;
  return [
    `war=${warId ?? "none"}`,
    `start=${warStartTime ?? "none"}`,
    `opponent=${opponentTag ?? "none"}`,
    `sync=${syncMessageId ?? "none"}`,
  ].join("|");
}

function jumpUrl(guildId: string, channelId: string, messageId: string): string | null {
  const normalizedGuildId = normalizeId(guildId);
  const normalizedChannelId = normalizeId(channelId);
  const normalizedMessageId = normalizeId(messageId);
  if (!normalizedGuildId || !normalizedChannelId || !normalizedMessageId) return null;
  return `https://discord.com/channels/${normalizedGuildId}/${normalizedChannelId}/${normalizedMessageId}`;
}

function displayClanLabel(
  clanTag: string,
  clanName: string | null | undefined,
): string {
  const normalizedTag = normalizeClanTag(clanTag) || `#${String(clanTag ?? "").trim()}`;
  const normalizedName = String(clanName ?? "").replace(/\s+/g, " ").trim();
  return normalizedName ? `${normalizedName} (${normalizedTag})` : normalizedTag;
}

function contextLabel(input: WarSyncIdentity): string {
  const warId = normalizeWarId(input.warId);
  const syncMessageId = normalizeId(input.syncMessageId);
  if (warId) return `war #${warId}`;
  if (syncMessageId) return `sync ${syncMessageId}`;
  return "current war";
}

function summarizeError(error: unknown): string {
  return formatError(error).slice(0, MAX_FAILURE_REASON_LENGTH);
}

function isAmbiguousDeliveryError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null | undefined)?.code !== "number";
}

function isTextSendableChannel(channel: any): boolean {
  return Boolean(
    channel &&
      typeof channel.isTextBased === "function" &&
      channel.isTextBased() &&
      typeof channel.send === "function",
  );
}

export class FwaAccountabilityNotificationService {
  constructor(
    private readonly botLogChannels: Pick<
      BotLogChannelService,
      "getRoutingConfigForType" | "getChannelId"
    > = botLogChannelService,
    private readonly db: AccountabilityDb = prisma as unknown as AccountabilityDb,
  ) {}

  async notifyBasesChecked(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    clanName?: string | null;
    actorUserId: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    syncMessageId?: string | null;
    checklistChannelId?: string | null;
    checklistMessageId?: string | null;
  }): Promise<boolean> {
    const identity = buildFwaAccountabilityWarSyncIdentityForTest(input);
    if (!identity) return false;
    const clanName = input.clanName ?? await this.resolveClanName(input.clanTag);
    return this.deliver({
      ...input,
      clanName,
      eventType: "BASES_CHECKED",
      route: "bases-checked",
      eventKey: identity,
      content: this.buildBasesContent({ ...input, clanName }),
    });
  }

  async notifyMailPosted(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    clanName?: string | null;
    actorUserId: string;
    publicationIdentity: string;
    resent: boolean;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    mailChannelId: string;
    mailMessageId: string;
  }): Promise<boolean> {
    const publicationIdentity = String(input.publicationIdentity ?? "").trim();
    const mailUrl = jumpUrl(input.guildId, input.mailChannelId, input.mailMessageId);
    if (!publicationIdentity || !mailUrl) return false;
    const clanName = input.clanName ?? await this.resolveClanName(input.clanTag);
    return this.deliver({
      ...input,
      clanName,
      eventType: "MAIL_POSTED",
      route: "mail-posted",
      eventKey: `publication=${publicationIdentity}`,
      content: `${input.resent ? "📨 Clan mail resent" : "📨 Clan mail posted"} by <@${input.actorUserId}> — [View Mail](${mailUrl}) — ${displayClanLabel(input.clanTag, clanName)} (${contextLabel(input)})`,
    });
  }

  async notifyMailConfirmed(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    clanName?: string | null;
    actorUserId: string;
    warId?: string | number | null;
    warStartTime?: Date | null;
    opponentTag?: string | null;
    syncMessageId?: string | null;
    checklistChannelId?: string | null;
    checklistMessageId?: string | null;
  }): Promise<boolean> {
    const identity = buildFwaAccountabilityWarSyncIdentityForTest(input);
    if (!identity) return false;
    const clanName = input.clanName ?? await this.resolveClanName(input.clanTag);
    const checklistUrl = input.checklistChannelId && input.checklistMessageId
      ? jumpUrl(input.guildId, input.checklistChannelId, input.checklistMessageId)
      : null;
    return this.deliver({
      ...input,
      clanName,
      eventType: "MAIL_CONFIRMED",
      route: "mail-confirmed",
      eventKey: identity,
      content: [
        `✅ Clan mail marked as sent by <@${input.actorUserId}>`,
        checklistUrl ? `— [View Checklist](${checklistUrl})` : null,
        `— ${displayClanLabel(input.clanTag, clanName)} (${contextLabel(input)})`,
      ].filter((line): line is string => Boolean(line)).join(" "),
    });
  }

  private buildBasesContent(input: {
    clanTag: string;
    clanName?: string | null;
    actorUserId: string;
  } & WarSyncIdentity): string {
    return `✅ Bases checked and all good by <@${input.actorUserId}> — ${displayClanLabel(input.clanTag, input.clanName)} (${contextLabel(input)})`;
  }

  private async deliver(input: AccountabilityNotificationInput): Promise<boolean> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeClanTag(input.clanTag);
    const actorUserId = normalizeId(input.actorUserId);
    if (!guildId || !clanTag || !actorUserId) return false;

    let claim: any;
    try {
      claim = await this.claimNotification({
        guildId,
        clanTag,
        eventType: input.eventType,
        eventKey: input.eventKey,
        actorUserId,
      });
    } catch (error) {
      console.error(
        `[fwa-accountability] event=claim_failed guild=${guildId} clan=${clanTag} type=${input.eventType} error=${summarizeError(error)}`,
      );
      return false;
    }
    if (!claim) return false;

    const destination = await this.resolveDestination({
      client: input.client,
      guildId,
      clanTag,
      route: input.route,
    });
    if (!destination) {
      await this.markFailed(claim, "DESTINATION_UNAVAILABLE", "Configured destination is missing, inaccessible, or not sendable.");
      return false;
    }

    try {
      const sent = await destination.channel.send({
        content: input.content,
        allowedMentions: { parse: [], users: [actorUserId] },
      });
      const messageId = normalizeId(String(sent?.id ?? ""));
      const messageUrl = messageId
        ? jumpUrl(guildId, destination.channelId, messageId)
        : null;
      await this.db.fwaAccountabilityNotification.updateMany({
        where: {
          id: claim.id,
          status: FwaAccountabilityNotificationStatus.CLAIMED,
          claimToken: claim.claimToken,
        },
        data: {
          status: FwaAccountabilityNotificationStatus.SENT,
          claimToken: null,
          claimedAt: null,
          sentAt: new Date(),
          channelId: destination.channelId,
          messageId,
          messageUrl,
          failureCode: null,
          failureReason: null,
        },
      });
      return true;
    } catch (error) {
      await this.markFailed(
        claim,
        isAmbiguousDeliveryError(error) ? "DELIVERY_UNKNOWN" : "SEND_FAILED",
        summarizeError(error),
        isAmbiguousDeliveryError(error)
          ? FwaAccountabilityNotificationStatus.UNKNOWN
          : FwaAccountabilityNotificationStatus.FAILED,
      );
      console.warn(
        `[fwa-accountability] event=delivery_failed guild=${guildId} clan=${clanTag} type=${input.eventType} destination=${destination.channelId} status=${isAmbiguousDeliveryError(error) ? "unknown" : "failed"} error=${summarizeError(error)}`,
      );
      return false;
    }
  }

  private async claimNotification(input: {
    guildId: string;
    clanTag: string;
    eventType: AccountabilityEventType;
    eventKey: string;
    actorUserId: string;
  }): Promise<{ id: string; claimToken: string } | null> {
    const claimToken = randomUUID();
    const now = new Date();
    const row = await this.db.fwaAccountabilityNotification.upsert({
      where: {
        guildId_eventType_eventKey: {
          guildId: input.guildId,
          eventType: input.eventType,
          eventKey: input.eventKey,
        },
      },
      update: {},
      create: {
        guildId: input.guildId,
        clanTag: input.clanTag,
        eventType: input.eventType,
        eventKey: input.eventKey,
        actorUserId: input.actorUserId,
        status: FwaAccountabilityNotificationStatus.CLAIMED,
        claimToken,
        claimedAt: now,
        attemptCount: 1,
        lastAttemptAt: now,
      },
    });
    const status = row.status as FwaAccountabilityNotificationStatus;
    if (
      status === FwaAccountabilityNotificationStatus.SENT ||
      status === FwaAccountabilityNotificationStatus.UNKNOWN
    ) {
      return null;
    }
    const claimedAt = row.claimedAt instanceof Date ? row.claimedAt.getTime() : 0;
    if (
      status === FwaAccountabilityNotificationStatus.CLAIMED &&
      claimedAt > now.getTime() - CLAIM_LEASE_MS
    ) {
      return row.claimToken === claimToken ? { id: row.id, claimToken } : null;
    }
    const updated = await this.db.fwaAccountabilityNotification.updateMany({
      where: {
        id: row.id,
        status: { in: [
          FwaAccountabilityNotificationStatus.CLAIMED,
          FwaAccountabilityNotificationStatus.FAILED,
        ] },
        ...(status === FwaAccountabilityNotificationStatus.CLAIMED
          ? { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }
          : {}),
      },
      data: {
        status: FwaAccountabilityNotificationStatus.CLAIMED,
        claimToken,
        claimedAt: now,
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        actorUserId: input.actorUserId,
      },
    });
    return updated.count === 1 ? { id: row.id, claimToken } : null;
  }

  private async markFailed(
    claim: { id: string; claimToken: string },
    code: string,
    reason: string,
    status: FwaAccountabilityNotificationStatus = FwaAccountabilityNotificationStatus.FAILED,
  ): Promise<void> {
    await this.db.fwaAccountabilityNotification.updateMany({
      where: {
        id: claim.id,
        status: FwaAccountabilityNotificationStatus.CLAIMED,
        claimToken: claim.claimToken,
      },
      data: {
        status,
        claimToken: null,
        claimedAt: null,
        failureCode: code.slice(0, 100),
        failureReason: reason.slice(0, MAX_FAILURE_REASON_LENGTH),
      },
    });
  }

  private async resolveDestination(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    route: AccountabilityRoute;
  }): Promise<{
    channelId: string;
    channel: { send: (payload: any) => Promise<any> };
  } | null> {
    const routing = await this.botLogChannels.getRoutingConfigForType(
      input.guildId,
      input.route as RoutedBotLogChannelType,
    );
    const routingMode = routing.configured ? routing.routingMode : "CLAN_LEAD";
    if (routingMode === "DISABLED") return null;

    const trackedClan = await this.db.trackedClan.findFirst({
      where: { tag: { equals: input.clanTag, mode: "insensitive" } },
      select: { name: true, shortName: true, logChannelId: true, leaderChannelId: true },
    });
    let channelId: string | null = null;
    if (routingMode === "CLAN_LOG") channelId = normalizeId(trackedClan?.logChannelId);
    else if (routingMode === "CLAN_LEAD") channelId = normalizeId(trackedClan?.leaderChannelId);
    else if (routingMode === "BOT_LOG") channelId = await this.botLogChannels.getChannelId(input.guildId);
    else if (routingMode === "CUSTOM") channelId = normalizeId(routing.channelId);
    if (!channelId) {
      console.warn(
        `[fwa-accountability] event=destination_unavailable guild=${input.guildId} clan=${input.clanTag} route=${input.route} mode=${routingMode} reason=channel_not_configured`,
      );
      return null;
    }

    const channel = await input.client.channels.fetch(channelId).catch(() => null) as any;
    if (!channel || String(channel.guildId ?? "").trim() !== input.guildId || !isTextSendableChannel(channel)) {
      console.warn(
        `[fwa-accountability] event=destination_unavailable guild=${input.guildId} clan=${input.clanTag} route=${input.route} mode=${routingMode} channel=${channelId} reason=channel_not_sendable`,
      );
      return null;
    }
    if (typeof channel.permissionsFor === "function") {
      const guild = input.client.guilds.cache.get(input.guildId) ?? null;
      const permissions = channel.permissionsFor(guild?.members?.me ?? input.client.user);
      const requiredPermission = channel.isThread?.()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
      if (
        permissions &&
        typeof permissions.has === "function" &&
        !permissions.has(requiredPermission)
      ) {
        console.warn(
          `[fwa-accountability] event=destination_unavailable guild=${input.guildId} clan=${input.clanTag} route=${input.route} mode=${routingMode} channel=${channelId} reason=missing_send_permission`,
        );
        return null;
      }
    }
    return { channelId, channel };
  }

  private async resolveClanName(clanTag: string): Promise<string | null> {
    try {
      const row = await this.db.trackedClan.findFirst({
        where: { tag: { equals: normalizeClanTag(clanTag), mode: "insensitive" } },
        select: { name: true, shortName: true },
      });
      return String(row?.shortName ?? row?.name ?? "").replace(/\s+/g, " ").trim() || null;
    } catch {
      return null;
    }
  }
}

export const fwaAccountabilityNotificationService =
  new FwaAccountabilityNotificationService();
