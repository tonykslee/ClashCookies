import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  hasSameSyncTimeMetadataIdentity,
  loadValidatedSyncClaimAggregation,
  parseSyncTimeMetadata,
  type SyncTimeTrackedMetadata,
} from "./TrackedMessageService";
import {
  botLogChannelService,
  type BotLogChannelService,
} from "./BotLogChannelService";
import {
  claimSyncEvent,
  markSyncEventDelivered,
  releaseSyncEvent,
  syncEventKey,
  syncEventPayloadStatus,
  type SyncEventDeliveryIdentity,
} from "./SyncEventDeliveryService";
import {
  isMirrorPollingMode,
  resolveRuntimeEnvironment,
} from "./PollingModeService";

export const SYNC_ALL_SPUN_EVENT_TYPE = "sync_all_spun:announcement";
export const SYNC_ALL_SPUN_MESSAGE = "all spun";
export const SYNC_ALL_SPUN_RECOVERY_LIMIT = 100;

type SyncAllSpunDb = {
  trackedMessage: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    findMany: (args: any) => Promise<any[]>;
  };
  syncEvent: any;
};

type CanonicalSyncRoot = {
  id: string;
  guildId: string;
  messageId: string;
  expiresAt: Date | null;
  metadata: SyncTimeTrackedMetadata;
  syncTime: Date;
};

type CompletionSnapshot = CanonicalSyncRoot & {
  participatingClanTags: Set<string>;
  claimedClanTags: Set<string>;
  invalidChildIdentityCount: number;
};

export type SyncAllSpunEvaluation =
  | { state: "skipped"; reason: string }
  | { state: "incomplete"; participatingClanCount: number; claimedClanCount: number }
  | { state: "suppressed"; reason: string }
  | { state: "delivered"; channelId: string; messageId: string | null }
  | { state: "failed"; reason: string };

export type SyncAllSpunRecoverySummary = {
  scanned: number;
  delivered: number;
  suppressed: number;
  terminal: number;
  incomplete: number;
  skipped: number;
  failed: number;
};

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function syncTimeFromMetadata(metadata: SyncTimeTrackedMetadata): Date | null {
  const syncTime = new Date(String(metadata.syncTimeIso ?? ""));
  if (!isValidDate(syncTime)) return null;
  if (!Number.isSafeInteger(metadata.syncEpochSeconds)) return null;
  if (Math.floor(syncTime.getTime() / 1000) !== metadata.syncEpochSeconds) return null;
  return syncTime;
}

function isSupportedSyncAnnouncementChannel(
  channel: any,
  guildId: string,
  client: Client,
  guild: any,
): boolean {
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) return false;
  if (String(channel.guildId ?? "").trim() !== guildId) return false;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread]
    .includes(channel.type)) {
    return false;
  }
  if (typeof channel.send !== "function" || typeof channel.permissionsFor !== "function") return false;
  const permissions = channel.permissionsFor(guild?.members?.me ?? client.user);
  const requiredPermission = channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  return Boolean(
    permissions &&
    typeof permissions.has === "function" &&
    permissions.has(requiredPermission),
  );
}

function deliveryIdentity(root: CanonicalSyncRoot): SyncEventDeliveryIdentity {
  return {
    guildId: root.guildId,
    syncTime: root.syncTime,
    clanTag: "",
    eventType: SYNC_ALL_SPUN_EVENT_TYPE,
  };
}

function claimedPayload(root: CanonicalSyncRoot, snapshot: CompletionSnapshot) {
  return {
    kind: "sync_all_spun_delivery",
    status: "claimed",
    rootMessageId: root.messageId,
    participatingClanCount: snapshot.participatingClanTags.size,
    claimedClanCount: snapshot.claimedClanTags.size,
    invalidChildIdentityCount: snapshot.invalidChildIdentityCount,
  };
}

function deliveredPayload(
  root: CanonicalSyncRoot,
  snapshot: CompletionSnapshot,
  channelId: string,
  messageId: string | null,
) {
  return {
    ...claimedPayload(root, snapshot),
    status: "delivered",
    channelId,
    messageId,
  };
}

/** Purpose: announce once when all clans in the current sync root have an active spin claim. */
export class SyncAllSpunAnnouncementService {
  constructor(
    private readonly botLogChannels: Pick<BotLogChannelService, "getChannelIdForType"> = botLogChannelService,
    private readonly db: SyncAllSpunDb = prisma as unknown as SyncAllSpunDb,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private runtimeAllowed(): boolean {
    return !isMirrorPollingMode(this.env) && resolveRuntimeEnvironment(this.env) === "prod";
  }

  private async resolveCanonicalRoot(
    messageId: string,
    now: Date,
  ): Promise<CanonicalSyncRoot | null> {
    const tracked = await this.db.trackedMessage.findUnique({
      where: { messageId },
      select: {
        id: true,
        guildId: true,
        messageId: true,
        referenceId: true,
        featureType: true,
        status: true,
        expiresAt: true,
        metadata: true,
      },
    });
    if (
      !tracked ||
      tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST ||
      tracked.status !== TRACKED_MESSAGE_STATUS.ACTIVE
    ) {
      return null;
    }
    if (isValidDate(tracked.expiresAt) && tracked.expiresAt.getTime() <= now.getTime()) return null;

    const root = tracked.referenceId
      ? await this.db.trackedMessage.findUnique({
          where: { messageId: tracked.referenceId },
          select: {
            id: true,
            guildId: true,
            messageId: true,
            referenceId: true,
            featureType: true,
            status: true,
            expiresAt: true,
            metadata: true,
          },
        })
      : tracked;
    if (
      !root ||
      root.guildId !== tracked.guildId ||
      root.referenceId !== null ||
      root.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST ||
      root.status !== TRACKED_MESSAGE_STATUS.ACTIVE
    ) {
      return null;
    }

    const expiresAt = isValidDate(root.expiresAt) ? root.expiresAt : null;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return null;

    const metadata = parseSyncTimeMetadata(root.metadata);
    if (!metadata) return null;
    const syncTime = syncTimeFromMetadata(metadata);
    if (!syncTime || syncTime.getTime() > now.getTime()) return null;

    const latestRoot = await this.db.trackedMessage.findFirst({
      where: {
        guildId: root.guildId,
        referenceId: null,
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
      },
      orderBy: [{ createdAt: "desc" }, { messageId: "desc" }],
      select: { messageId: true },
    });
    if (!latestRoot || latestRoot.messageId !== root.messageId) return null;

    return {
      id: String(root.id ?? ""),
      guildId: String(root.guildId ?? "").trim(),
      messageId: String(root.messageId ?? "").trim(),
      expiresAt,
      metadata,
      syncTime,
    };
  }

  private async loadCompletionSnapshot(
    root: CanonicalSyncRoot,
    now: Date,
  ): Promise<CompletionSnapshot | null> {
    const aggregation = await loadValidatedSyncClaimAggregation(this.db, root.messageId, now);
    if (!aggregation || aggregation.root.id !== root.id) return null;
    return {
      ...root,
      metadata: aggregation.metadata,
      syncTime: aggregation.syncTime,
      participatingClanTags: aggregation.participatingClanTags,
      claimedClanTags: aggregation.claimedClanTags,
      invalidChildIdentityCount: aggregation.invalidChildIdentityCount,
    };
  }

  private async resolveDestination(
    client: Client,
    guildId: string,
  ): Promise<{ channelId: string; guild: any; channel: any } | null> {
    const channelId = await this.botLogChannels.getChannelIdForType(guildId, "sync");
    if (!channelId) return null;
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const channel = guild
      ? await guild.channels.fetch(channelId).catch(() => null)
      : null;
    if (!guild || !isSupportedSyncAnnouncementChannel(channel, guildId, client, guild)) return null;
    return { channelId, guild, channel };
  }

  private async deliver(
    client: Client,
    root: CanonicalSyncRoot,
    initialSnapshot: CompletionSnapshot,
    now: Date,
  ): Promise<SyncAllSpunEvaluation> {
    const destination = await this.resolveDestination(client, root.guildId).catch((error) => {
      dozzleLog.error(
        `[sync-all-spun] event=routing_lookup_failed guild_id=${root.guildId} root_message_id=${root.messageId} error=${formatError(error)}`,
      );
      return null;
    });
    if (!destination) {
      dozzleLog.warn(
        `[sync-all-spun] event=delivery_skipped guild_id=${root.guildId} root_message_id=${root.messageId} reason=sync_destination_unavailable`,
      );
      return { state: "failed", reason: "sync_destination_unavailable" };
    }

    const identity = deliveryIdentity(root);
    const claim = await claimSyncEvent({
      eventModel: this.db.syncEvent,
      identity,
      now,
      claimedPayload: claimedPayload(root, initialSnapshot),
    });
    if (claim.state === "unavailable") {
      dozzleLog.error(
        `[sync-all-spun] event=delivery_claim_failed guild_id=${root.guildId} root_message_id=${root.messageId} sync_time=${root.syncTime.toISOString()} error=${claim.reason}`,
      );
      return { state: "failed", reason: claim.reason };
    }
    if (claim.state !== "claimed") {
      dozzleLog.debug(
        `[sync-all-spun] event=delivery_suppressed guild_id=${root.guildId} root_message_id=${root.messageId} sync_time=${root.syncTime.toISOString()} reason=${claim.reason}`,
      );
      return { state: "suppressed", reason: claim.reason };
    }

    try {
      const currentRoot = await this.resolveCanonicalRoot(root.messageId, now);
      const currentSnapshot = currentRoot
        ? await this.loadCompletionSnapshot(currentRoot, now)
        : null;
      if (!this.isDeliverySnapshotStillValid(root, initialSnapshot, currentRoot, currentSnapshot)) {
        await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
        dozzleLog.debug(
          `[sync-all-spun] event=delivery_revalidation_failed guild_id=${root.guildId} root_message_id=${root.messageId} reason=root_or_completion_changed`,
        );
        return { state: "failed", reason: "root_or_completion_changed" };
      }

      const currentDestination = await this.resolveDestination(client, root.guildId);
      if (!currentDestination) {
        await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
        dozzleLog.warn(
          `[sync-all-spun] event=delivery_retryable_failure guild_id=${root.guildId} root_message_id=${root.messageId} reason=sync_destination_unavailable_after_claim`,
        );
        return { state: "failed", reason: "sync_destination_unavailable_after_claim" };
      }

      const clockNow = this.clock();
      const finalNow = clockNow.getTime() >= now.getTime() ? clockNow : now;
      const finalRoot = await this.resolveCanonicalRoot(root.messageId, finalNow);
      const finalSnapshot = finalRoot
        ? await this.loadCompletionSnapshot(finalRoot, finalNow)
        : null;
      if (
        !finalRoot ||
        !this.isDeliverySnapshotStillValid(root, initialSnapshot, finalRoot, finalSnapshot)
      ) {
        await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
        dozzleLog.debug(
          `[sync-all-spun] event=delivery_revalidation_failed guild_id=${root.guildId} root_message_id=${root.messageId} reason=root_or_completion_changed_before_send`,
        );
        return { state: "failed", reason: "root_or_completion_changed_before_send" };
      }

      const sent = await currentDestination.channel.send(SYNC_ALL_SPUN_MESSAGE);
      const messageId = String(sent?.id ?? "").trim() || null;
      const marked = await markSyncEventDelivered({
        eventModel: this.db.syncEvent,
        identity,
        createdAt: claim.createdAt,
        deliveredPayload: deliveredPayload(
          finalRoot,
          finalSnapshot,
          currentDestination.channelId,
          messageId,
        ),
      });
      if (!marked) {
        await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
        dozzleLog.error(
          `[sync-all-spun] event=delivery_state_update_failed guild_id=${root.guildId} root_message_id=${root.messageId} sync_time=${root.syncTime.toISOString()}`,
        );
        return { state: "failed", reason: "delivery_state_update_failed" };
      }
      dozzleLog.info(
        `[sync-all-spun] event=delivered guild_id=${root.guildId} root_message_id=${root.messageId} sync_time=${root.syncTime.toISOString()} participating_clan_count=${finalSnapshot.participatingClanTags.size} channel_id=${currentDestination.channelId} message_id=${messageId ?? "none"}`,
      );
      return { state: "delivered", channelId: currentDestination.channelId, messageId };
    } catch (error) {
      await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
      dozzleLog.error(
        `[sync-all-spun] event=delivery_failed guild_id=${root.guildId} root_message_id=${root.messageId} sync_time=${root.syncTime.toISOString()} error=${formatError(error)}`,
      );
      return { state: "failed", reason: "discord_send_failed" };
    }
  }

  /** Purpose: require one unchanged canonical participant snapshot through delivery preparation. */
  private isDeliverySnapshotStillValid(
    initialRoot: CanonicalSyncRoot,
    initialSnapshot: CompletionSnapshot,
    currentRoot: CanonicalSyncRoot | null,
    currentSnapshot: CompletionSnapshot | null,
  ): currentSnapshot is CompletionSnapshot {
    if (
      !currentRoot ||
      !currentSnapshot ||
      currentRoot.guildId !== initialRoot.guildId ||
      currentRoot.messageId !== initialRoot.messageId ||
      currentRoot.syncTime.getTime() !== initialRoot.syncTime.getTime() ||
      !hasSameSyncTimeMetadataIdentity(initialRoot.metadata, currentRoot.metadata) ||
      currentSnapshot.claimedClanTags.size !== currentSnapshot.participatingClanTags.size ||
      currentSnapshot.participatingClanTags.size !== initialSnapshot.participatingClanTags.size
    ) return false;
    return [...initialSnapshot.participatingClanTags].every((clanTag) =>
      currentSnapshot.participatingClanTags.has(clanTag),
    );
  }

  async evaluateAfterAdd(
    client: Client,
    messageId: string,
    now: Date = this.clock(),
  ): Promise<SyncAllSpunEvaluation> {
    if (!this.runtimeAllowed()) {
      return { state: "skipped", reason: "non_production_runtime" };
    }
    try {
      const root = await this.resolveCanonicalRoot(messageId, now);
      if (!root) {
        dozzleLog.debug(
          `[sync-all-spun] event=evaluation_skipped message_id=${messageId} reason=unresolved_current_root`,
        );
        return { state: "skipped", reason: "unresolved_current_root" };
      }
      const snapshot = await this.loadCompletionSnapshot(root, now);
      if (!snapshot) {
        dozzleLog.warn(
          `[sync-all-spun] event=evaluation_skipped guild_id=${root.guildId} root_message_id=${root.messageId} reason=invalid_participating_clans`,
        );
        return { state: "skipped", reason: "invalid_participating_clans" };
      }
      if (snapshot.claimedClanTags.size !== snapshot.participatingClanTags.size) {
        dozzleLog.debug(
          `[sync-all-spun] event=evaluation_incomplete guild_id=${root.guildId} root_message_id=${root.messageId} claimed_count=${snapshot.claimedClanTags.size} participating_count=${snapshot.participatingClanTags.size} invalid_child_identity_count=${snapshot.invalidChildIdentityCount}`,
        );
        return {
          state: "incomplete",
          participatingClanCount: snapshot.participatingClanTags.size,
          claimedClanCount: snapshot.claimedClanTags.size,
        };
      }
      return await this.deliver(client, root, snapshot, now);
    } catch (error) {
      dozzleLog.error(
        `[sync-all-spun] event=evaluation_failed message_id=${messageId} error=${formatError(error)}`,
      );
      return { state: "failed", reason: "evaluation_failed" };
    }
  }

  private async findTerminalDeliveryKeys(
    roots: Array<{ guildId: string; metadata: unknown }>,
    now: Date,
  ): Promise<Set<string>> {
    if (!this.db.syncEvent?.findMany) return new Set();
    const candidates = roots.flatMap((root) => {
      const metadata = parseSyncTimeMetadata(root.metadata);
      const syncTime = metadata ? syncTimeFromMetadata(metadata) : null;
      return syncTime && syncTime.getTime() <= now.getTime()
        ? [{ guildId: root.guildId, syncTime }]
        : [];
    });
    if (candidates.length === 0) return new Set();

    const events = await this.db.syncEvent.findMany({
      where: {
        eventType: SYNC_ALL_SPUN_EVENT_TYPE,
        clanTag: "",
        OR: candidates.map((candidate) => ({
          guildId: candidate.guildId,
          syncTime: candidate.syncTime,
        })),
      },
      select: { guildId: true, syncTime: true, clanTag: true, eventType: true, payload: true },
    });
    return new Set(
      events
        .filter((event: any) => {
          const status = syncEventPayloadStatus(event.payload);
          return status === "delivered" || status === "suppressed";
        })
        .map((event: any) => syncEventKey(event)),
    );
  }

  async reconcileDue(
    client: Client,
    now: Date = this.clock(),
  ): Promise<SyncAllSpunRecoverySummary> {
    const summary: SyncAllSpunRecoverySummary = {
      scanned: 0,
      delivered: 0,
      suppressed: 0,
      terminal: 0,
      incomplete: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.runtimeAllowed()) return summary;

    const roots = await this.db.trackedMessage.findMany({
      where: {
        featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
        status: TRACKED_MESSAGE_STATUS.ACTIVE,
        referenceId: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { messageId: "desc" }],
      take: SYNC_ALL_SPUN_RECOVERY_LIMIT,
      select: { messageId: true, guildId: true, metadata: true },
    });
    const terminalKeys = await this.findTerminalDeliveryKeys(roots, now);
    for (const root of roots) {
      summary.scanned += 1;
      const metadata = parseSyncTimeMetadata(root.metadata);
      const syncTime = metadata ? syncTimeFromMetadata(metadata) : null;
      if (!syncTime || syncTime.getTime() > now.getTime()) {
        summary.skipped += 1;
        continue;
      }
      if (terminalKeys.has(syncEventKey({
        guildId: root.guildId,
        syncTime,
        clanTag: "",
        eventType: SYNC_ALL_SPUN_EVENT_TYPE,
      }))) {
        summary.terminal += 1;
        continue;
      }
      const result = await this.evaluateAfterAdd(client, root.messageId, now);
      if (result.state === "delivered") summary.delivered += 1;
      else if (result.state === "suppressed") summary.suppressed += 1;
      else if (result.state === "incomplete") summary.incomplete += 1;
      else if (result.state === "skipped") summary.skipped += 1;
      else summary.failed += 1;
    }
    if (summary.delivered || summary.suppressed || summary.failed) {
      dozzleLog.info(
        `[sync-all-spun] event=recovery_summary scanned=${summary.scanned} delivered=${summary.delivered} suppressed=${summary.suppressed} terminal=${summary.terminal} incomplete=${summary.incomplete} skipped=${summary.skipped} failed=${summary.failed}`,
      );
    }
    return summary;
  }
}

export const syncAllSpunAnnouncementService = new SyncAllSpunAnnouncementService();
