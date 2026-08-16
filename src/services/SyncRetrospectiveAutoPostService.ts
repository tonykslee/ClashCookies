import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import {
  botLogChannelService,
  type BotLogChannelService,
} from "./BotLogChannelService";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  buildSyncRetrospectiveComponents,
  buildSyncRetrospectiveEmbeds,
  hasSyncRetrospectiveData,
} from "./SyncRetrospectiveViewService";
import {
  SyncRetrospectiveService,
  type SyncRetrospectiveCompletionState,
} from "./SyncRetrospectiveService";
import {
  claimSyncEvent,
  markSyncEventDelivered,
  markSyncEventSuppressed,
  releaseSyncEvent,
  syncEventKey,
  syncEventPayloadStatus,
  type SyncEventDeliveryIdentity,
} from "./SyncEventDeliveryService";

export const SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE = "sync_retrospective:auto_post";
export const SYNC_RETROSPECTIVE_AUTO_POST_CANDIDATE_LIMIT = 100;

type SyncCycleCandidate = {
  guildId: string;
  syncNumber: number;
  syncTime: Date;
};

type SyncEventCandidate = SyncEventDeliveryIdentity & {
  createdAt: Date;
  payload: unknown;
};

type AutoPostDb = {
  syncCycle: {
    findMany: (args: any) => Promise<any[]>;
  };
  syncEvent: any;
};

export type SyncRetrospectiveAutoPostSummary = {
  candidates: number;
  complete: number;
  suppressed: number;
  delivered: number;
  skipped: number;
  failed: number;
};

function zeroSummary(): SyncRetrospectiveAutoPostSummary {
  return {
    candidates: 0,
    complete: 0,
    suppressed: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function normalizeCandidate(row: any): SyncCycleCandidate | null {
  const guildId = String(row?.guildId ?? "").trim();
  const syncNumber = Number(row?.syncNumber);
  if (!guildId || !Number.isSafeInteger(syncNumber) || syncNumber <= 0 || !isValidDate(row?.syncTime)) {
    return null;
  }
  return { guildId, syncNumber, syncTime: row.syncTime };
}

function isTerminalDelivery(payload: unknown): boolean {
  const status = syncEventPayloadStatus(payload);
  return status === "delivered" || status === "suppressed";
}

function isSupportedAutoPostChannel(
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
  return Boolean(
    permissions &&
    typeof permissions.has === "function" &&
    permissions.has(PermissionFlagsBits.SendMessages),
  );
}

function identityFor(candidate: SyncCycleCandidate): SyncEventDeliveryIdentity {
  return {
    guildId: candidate.guildId,
    syncTime: candidate.syncTime,
    clanTag: "",
    eventType: SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE,
  };
}

function claimedPayload(candidate: SyncCycleCandidate) {
  return {
    kind: "sync_retrospective_delivery",
    status: "claimed",
    syncNumber: candidate.syncNumber,
  };
}

function suppressedPayload(candidate: SyncCycleCandidate) {
  return {
    kind: "sync_retrospective_delivery",
    status: "suppressed",
    syncNumber: candidate.syncNumber,
    reason: "completed_before_enabled",
  };
}

/** Purpose: reconcile recent completed sync retrospectives into one durable public delivery per sync. */
export class SyncRetrospectiveAutoPostService {
  constructor(
    private readonly client: Client,
    private readonly botLogChannels: Pick<BotLogChannelService, "getRoutingConfigForType" | "getChannelId" | "getSyncRetrospectiveEnabledAt"> = botLogChannelService,
    private readonly retrospectiveService: Pick<SyncRetrospectiveService, "getCompletionState" | "getBySyncNumber"> = new SyncRetrospectiveService(),
    private readonly db: AutoPostDb = prisma as unknown as AutoPostDb,
  ) {}

  async runCycle(now: Date = new Date()): Promise<SyncRetrospectiveAutoPostSummary> {
    const summary = zeroSummary();
    if (isMirrorPollingMode(process.env)) {
      dozzleLog.debug("[retrospective-auto-post] event=reconciliation outcome=skip reason=mirror");
      return summary;
    }
    if (!this.db.syncCycle?.findMany || !this.db.syncEvent?.findMany) return summary;

    const rawCandidates = await this.db.syncCycle.findMany({
      where: { syncTime: { lte: now } },
      orderBy: { syncTime: "desc" },
      take: SYNC_RETROSPECTIVE_AUTO_POST_CANDIDATE_LIMIT,
      select: { guildId: true, syncNumber: true, syncTime: true },
    });
    const candidates = rawCandidates
      .map(normalizeCandidate)
      .filter((candidate): candidate is SyncCycleCandidate => candidate !== null);
    summary.candidates = candidates.length;
    if (candidates.length === 0) return summary;

    const enabledCandidates: Array<{
      candidate: SyncCycleCandidate;
      enabledAt: Date;
      channelId: string;
    }> = [];
    for (const candidate of candidates) {
      try {
        const routing = await this.botLogChannels.getRoutingConfigForType(
          candidate.guildId,
          "sync-retrospective",
        );
        if (!routing.configured || routing.routingMode === "DISABLED") continue;
        const enabledAt = await this.botLogChannels.getSyncRetrospectiveEnabledAt(candidate.guildId);
        if (!enabledAt) {
          dozzleLog.debug(
            `[retrospective-auto-post] event=skip guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} reason=enabled_at_unavailable`,
          );
          continue;
        }
        const channelId = routing.routingMode === "CUSTOM"
          ? routing.channelId
          : await this.botLogChannels.getChannelId(candidate.guildId);
        if (!channelId) continue;
        enabledCandidates.push({ candidate, enabledAt, channelId });
      } catch (error) {
        dozzleLog.error(
          `[retrospective-auto-post] event=routing_lookup_failed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} error=${formatError(error)}`,
        );
      }
    }
    if (enabledCandidates.length === 0) return summary;

    const events = (await this.db.syncEvent.findMany({
      where: {
        eventType: SYNC_RETROSPECTIVE_AUTO_POST_EVENT_TYPE,
        OR: enabledCandidates.map(({ candidate }) => ({
          guildId: candidate.guildId,
          syncTime: candidate.syncTime,
          clanTag: "",
        })),
      },
      select: { guildId: true, syncTime: true, clanTag: true, eventType: true, createdAt: true, payload: true },
    })) as SyncEventCandidate[];
    const eventsByKey = new Map(events.map((event) => [syncEventKey(event), event]));

    for (const item of enabledCandidates) {
      const { candidate, enabledAt, channelId } = item;
      const identity = identityFor(candidate);
      const existing = eventsByKey.get(syncEventKey(identity));
      if (existing && isTerminalDelivery(existing.payload)) {
        summary.skipped += 1;
        continue;
      }

      try {
        const completion: SyncRetrospectiveCompletionState =
          await this.retrospectiveService.getCompletionState({
            guildId: candidate.guildId,
            syncNumber: candidate.syncNumber,
          });
        if (!completion.complete || !completion.completedAt) {
          dozzleLog.debug(
            `[retrospective-auto-post] event=skip guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} reason=${completion.reason}`,
          );
          continue;
        }
        summary.complete += 1;

        if (completion.completedAt.getTime() < enabledAt.getTime()) {
          const suppression = await markSyncEventSuppressed({
            eventModel: this.db.syncEvent,
            identity,
            suppressedPayload: suppressedPayload(candidate),
          });
          if (suppression === "created") summary.suppressed += 1;
          else if (suppression === "unavailable") summary.failed += 1;
          else summary.skipped += 1;
          dozzleLog.debug(
            `[retrospective-auto-post] event=suppressed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} reason=completed_before_enabled`,
          );
          continue;
        }

        const claim = await claimSyncEvent({
          eventModel: this.db.syncEvent,
          identity,
          now,
          claimedPayload: claimedPayload(candidate),
        });
        if (claim.state !== "claimed") {
          summary.skipped += 1;
          continue;
        }

        try {
          const guild = await this.client.guilds.fetch(candidate.guildId).catch(() => null);
          const channel = guild
            ? await guild.channels.fetch(channelId).catch(() => null)
            : null;
          if (!guild || !isSupportedAutoPostChannel(channel, candidate.guildId, this.client, guild)) {
            await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
            summary.failed += 1;
            dozzleLog.warn(
              `[retrospective-auto-post] event=destination_unavailable guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} channel_id=${channelId}`,
            );
            continue;
          }

          const result = await this.retrospectiveService.getBySyncNumber({
            guildId: candidate.guildId,
            syncNumber: candidate.syncNumber,
          });
          if (!hasSyncRetrospectiveData(result)) {
            await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
            summary.failed += 1;
            dozzleLog.error(
              `[retrospective-auto-post] event=render_failed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} reason=no_retrospective_data`,
            );
            continue;
          }

          const sent = await (channel as any).send({
            embeds: buildSyncRetrospectiveEmbeds(result),
            components: buildSyncRetrospectiveComponents(result),
            allowedMentions: { parse: [] },
          });
          const marked = await markSyncEventDelivered({
            eventModel: this.db.syncEvent,
            identity,
            createdAt: claim.createdAt,
            deliveredPayload: {
              kind: "sync_retrospective_delivery",
              status: "delivered",
              syncNumber: candidate.syncNumber,
              channelId,
              messageId: String(sent?.id ?? "").trim() || null,
            },
          });
          if (!marked) {
            await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
            summary.failed += 1;
            dozzleLog.error(
              `[retrospective-auto-post] event=delivery_state_update_failed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber}`,
            );
            continue;
          }
          summary.delivered += 1;
          dozzleLog.info(
            `[retrospective-auto-post] event=delivered guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} sync_time=${candidate.syncTime.toISOString()} participant_count=${completion.participantClanCount} channel_id=${channelId} message_id=${String(sent?.id ?? "")}`,
          );
        } catch (error) {
          await releaseSyncEvent({ eventModel: this.db.syncEvent, identity, createdAt: claim.createdAt });
          summary.failed += 1;
          dozzleLog.error(
            `[retrospective-auto-post] event=send_failed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} error=${formatError(error)}`,
          );
        }
      } catch (error) {
        summary.failed += 1;
        dozzleLog.error(
          `[retrospective-auto-post] event=reconciliation_failed guild_id=${candidate.guildId} sync_number=${candidate.syncNumber} error=${formatError(error)}`,
        );
      }
    }

    const log = summary.delivered > 0 || summary.suppressed > 0 ? dozzleLog.info : dozzleLog.debug;
    log(
      `[retrospective-auto-post] event=reconciliation_summary candidates=${summary.candidates} complete=${summary.complete} suppressed=${summary.suppressed} delivered=${summary.delivered} skipped=${summary.skipped} failed=${summary.failed}`,
    );
    return summary;
  }
}
