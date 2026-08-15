import { ChannelType, type Client } from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import {
  isCompoActualStateProjectionComplete,
  projectCompoActualStateView,
} from "../helper/compoActualStateView";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import {
  clanGoalService,
  evaluateSyncZeroDeviationGoal,
  getClanGoalRoutingConfig,
  logClanGoalOutcome,
  resolveClanGoalDestination,
} from "./ClanGoalService";
import {
  botLogChannelService,
  type BotLogChannelService,
} from "./BotLogChannelService";
import {
  loadCompoActualStateContext,
  type CompoActualStateContext,
} from "./CompoActualStateService";
import { listFillerAccountTagsForGuild } from "./FillerAccountService";
import { normalizePlayerTag } from "./PlayerLinkService";
import { normalizeTag } from "./war-events/core";

export const SYNC_ZERO_DEVIATION_EVENT_TYPE =
  "clan_goal:SYNC_ZERO_DEVIATION" as const;
export const SYNC_CLAN_READINESS_ALGORITHM_VERSION = "compo-actual:auto:v1";
export const SYNC_BOUNDARY_CAPTURE_GRACE_MS = 5 * 15_000;
export const SYNC_CAPTURE_CANDIDATE_WINDOW_MS = 2 * SYNC_BOUNDARY_CAPTURE_GRACE_MS;
export const SYNC_GOAL_RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SYNC_GOAL_RECONCILIATION_LIMIT = 100;
export const SYNC_GOAL_CAPTURE_LIMIT = 100;
const SYNC_EVENT_RESERVATION_LEASE_MS = 5 * 60 * 1000;

export type SyncClanGoalClock = () => Date;

type SyncScheduleCandidate = {
  id: string;
  guildId: string;
  syncTime: Date;
  status: string;
};

type SyncSnapshotCandidate = {
  id: string;
  guildId: string;
  syncTime: Date;
  clanTag: string;
  clanName: string | null;
  memberCount: number;
  unresolvedWeightCount: number;
  deviationScore: number | null;
  projectionComplete: boolean;
  sourceSyncedAt: Date | null;
};

type SyncEventCandidate = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  eventType: string;
  createdAt: Date;
  payload: unknown;
};

export type SyncClanGoalCycleSummary = {
  tracked: number;
  captured: number;
  complete: number;
  zero: number;
  incomplete: number;
  stale: number;
  candidates: number;
  qualified: number;
  delivered: number;
  skipped: number;
  failed: number;
};

function zeroSummary(): SyncClanGoalCycleSummary {
  return {
    tracked: 0,
    captured: 0,
    complete: 0,
    zero: 0,
    incomplete: 0,
    stale: 0,
    candidates: 0,
    qualified: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
  };
}

function isFiniteDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function eventKey(input: {
  guildId: string;
  syncTime: Date;
  clanTag: string;
}): string {
  return `${input.guildId}|${input.syncTime.toISOString()}|${normalizeTag(input.clanTag)}`;
}

function eventPayloadStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const status = (payload as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function isReservationExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= SYNC_EVENT_RESERVATION_LEASE_MS;
}

function isSupportedDestination(channel: any, guildId: string): boolean {
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
    return false;
  }
  if (
    channel.type !== undefined &&
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement &&
    channel.type !== ChannelType.PublicThread &&
    channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }
  const channelGuildId = String(channel.guildId ?? "").trim();
  return !channelGuildId || channelGuildId === guildId;
}

/** Purpose: convert the canonical ACTUAL context into immutable sync facts using the shared projection. */
export function buildSyncClanReadinessSnapshotRows(input: {
  guildId: string;
  syncTime: Date;
  scheduledSyncPostId?: string | null;
  context: CompoActualStateContext;
  fillerTags?: readonly string[];
  fillerCaptureComplete?: boolean;
}): Array<{
  guildId: string;
  syncTime: Date;
  clanTag: string;
  clanName: string;
  memberCount: number;
  unresolvedWeightCount: number;
  deviationScore: number | null;
  projectionComplete: boolean;
  sourceSyncedAt: Date | null;
  algorithmVersion: string;
  scheduledSyncPostId: string | null;
  fillerCaptureComplete: boolean;
  fillerPlayerTags: string[];
}> {
  const fillerCaptureComplete = input.fillerCaptureComplete === true;
  const normalizedFillerTags = [...new Set(
    (input.fillerTags ?? [])
      .map((tag) => normalizePlayerTag(tag))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));

  return input.context.clans.map((clan) => {
    const projection = projectCompoActualStateView({
      view: "auto",
      base: clan.base,
      heatMapRefs: input.context.heatMapRefs,
    });
    const projectionComplete =
      isCompoActualStateProjectionComplete(projection) &&
      projection.selectedHeatMapRef !== null;
    const deviationScore = Number.isFinite(Number(projection.deviationScore))
      ? Number(projection.deviationScore)
      : null;
    const memberTags = new Set(
      clan.members
        .map((member) => normalizePlayerTag(member.playerTag))
        .filter(Boolean),
    );
    return {
      guildId: input.guildId,
      syncTime: input.syncTime,
      clanTag: normalizeTag(clan.clanTag),
      clanName: clan.clanName,
      memberCount: projection.memberCount,
      unresolvedWeightCount: projection.unresolvedWeightCount,
      deviationScore,
      projectionComplete,
      sourceSyncedAt: isFiniteDate(clan.sourceSyncedAt)
        ? clan.sourceSyncedAt
        : isFiniteDate(input.context.latestSourceSyncedAt)
          ? input.context.latestSourceSyncedAt
          : null,
      algorithmVersion: SYNC_CLAN_READINESS_ALGORITHM_VERSION,
      scheduledSyncPostId: input.scheduledSyncPostId ?? null,
      fillerCaptureComplete,
      fillerPlayerTags: fillerCaptureComplete
        ? normalizedFillerTags.filter((tag) => memberTags.has(tag))
        : [],
    };
  });
}

export class SyncClanGoalService {
  constructor(
    private readonly client: Client,
    private readonly botLogChannels: BotLogChannelService = botLogChannelService,
    private readonly clock: SyncClanGoalClock = () => new Date(),
  ) {}

  /** Purpose: capture due sync boundaries and reconcile recent immutable snapshots in one bounded poll phase. */
  async runCycle(now?: Date): Promise<SyncClanGoalCycleSummary> {
    const summary = zeroSummary();
    const captureNow = now ? new Date(now) : this.clock();
    const scheduleModel = (prisma as any).scheduledSyncPost;
    const snapshotModel = (prisma as any).syncClanReadinessSnapshot;
    const eventModel = (prisma as any).syncEvent;
    if (
      !scheduleModel?.findMany ||
      !snapshotModel?.findMany ||
      !snapshotModel?.createMany ||
      !eventModel?.findMany
    ) {
      return summary;
    }

    const captureCandidates = (await scheduleModel.findMany({
      where: {
        syncTime: {
          lte: captureNow,
          gte: new Date(captureNow.getTime() - SYNC_CAPTURE_CANDIDATE_WINDOW_MS),
        },
        status: { notIn: ["CANCELLED", "REPLACED"] },
      },
      orderBy: { syncTime: "asc" },
      take: SYNC_GOAL_CAPTURE_LIMIT,
      select: { id: true, guildId: true, syncTime: true, status: true },
    })) as SyncScheduleCandidate[];

    const contexts = new Map<string, Promise<CompoActualStateContext>>();
    const fillerTagsByBoundary = new Map<string, Promise<string[]>>();
    const rowsByBoundary = new Map<string, {
      syncTime: Date;
      rows: ReturnType<typeof buildSyncClanReadinessSnapshotRows>;
    }>();
    const activeCaptureCandidates = captureCandidates.filter((schedule) =>
      schedule.status !== "CANCELLED" && schedule.status !== "REPLACED",
    );
    for (const schedule of activeCaptureCandidates) {
      const ageMs = captureNow.getTime() - schedule.syncTime.getTime();
      if (ageMs > SYNC_BOUNDARY_CAPTURE_GRACE_MS) {
        summary.stale += 1;
        continue;
      }
      const contextKey = `${schedule.guildId}|${schedule.syncTime.toISOString()}`;
      let contextPromise = contexts.get(contextKey);
      if (!contextPromise) {
        contextPromise = loadCompoActualStateContext(schedule.guildId);
        contexts.set(contextKey, contextPromise);
      }
      try {
        const context = await contextPromise;
        const freshnessNow = this.clock();
        if (freshnessNow.getTime() - schedule.syncTime.getTime() > SYNC_BOUNDARY_CAPTURE_GRACE_MS) {
          summary.stale += 1;
          continue;
        }
        let fillerTagsPromise = fillerTagsByBoundary.get(contextKey);
        if (!fillerTagsPromise) {
          fillerTagsPromise = listFillerAccountTagsForGuild({ guildId: schedule.guildId });
          fillerTagsByBoundary.set(contextKey, fillerTagsPromise);
        }
        let fillerTags: string[] = [];
        let fillerCaptureComplete = false;
        try {
          fillerTags = await fillerTagsPromise;
          fillerCaptureComplete = true;
        } catch (error) {
          dozzleLog.error(
            `[sync-clan-goals] event=filler_registry_capture outcome=failure guild_id=${schedule.guildId} sync_identity=${schedule.syncTime.toISOString()} error=${formatError(error)}`,
          );
        }
        const postFillerFreshnessNow = this.clock();
        if (postFillerFreshnessNow.getTime() - schedule.syncTime.getTime() > SYNC_BOUNDARY_CAPTURE_GRACE_MS) {
          summary.stale += 1;
          continue;
        }
        const rows = buildSyncClanReadinessSnapshotRows({
          guildId: schedule.guildId,
          syncTime: schedule.syncTime,
          scheduledSyncPostId: schedule.id,
          context,
          fillerTags,
          fillerCaptureComplete,
        });
        summary.tracked += rows.length;
        for (const row of rows) {
          const evaluation = evaluateSyncZeroDeviationGoal(row);
          if (evaluation.qualified) summary.zero += 1;
          else summary.incomplete += 1;
          if (row.projectionComplete) summary.complete += 1;
        }
        rowsByBoundary.set(contextKey, { syncTime: schedule.syncTime, rows });
      } catch (error) {
        dozzleLog.error(
          `[sync-clan-goals] event=readiness_capture outcome=failure guild_id=${schedule.guildId} sync_identity=${schedule.syncTime.toISOString()} error=${formatError(error)}`,
        );
      }
    }

    const rowsToCreate: ReturnType<typeof buildSyncClanReadinessSnapshotRows> = [];
    for (const boundary of rowsByBoundary.values()) {
      const freshnessNow = this.clock();
      if (freshnessNow.getTime() - boundary.syncTime.getTime() > SYNC_BOUNDARY_CAPTURE_GRACE_MS) {
        summary.stale += 1;
        continue;
      }
      rowsToCreate.push(...boundary.rows);
    }

    if (rowsToCreate.length > 0) {
      try {
        const result = await snapshotModel.createMany({
          data: rowsToCreate,
          skipDuplicates: true,
        });
        summary.captured = Number(result?.count ?? 0);
        const captureLog = summary.captured > 0 ? dozzleLog.info : dozzleLog.debug;
        captureLog(
          `[sync-clan-goals] event=readiness_capture outcome=success tracked=${summary.tracked} captured=${summary.captured} complete=${summary.complete} zero=${summary.zero} incomplete=${summary.incomplete} stale=${summary.stale}`,
        );
      } catch (error) {
        dozzleLog.error(
          `[sync-clan-goals] event=readiness_capture outcome=failure rows=${rowsToCreate.length} error=${formatError(error)}`,
        );
      }
    } else if (captureCandidates.length > 0 || summary.stale > 0) {
      dozzleLog.debug(
        `[sync-clan-goals] event=readiness_capture outcome=skip tracked=${summary.tracked} captured=0 complete=${summary.complete} zero=${summary.zero} incomplete=${summary.incomplete} stale=${summary.stale}`,
      );
    }

    const snapshots = (await snapshotModel.findMany({
      where: {
        syncTime: {
          gte: new Date(captureNow.getTime() - SYNC_GOAL_RECONCILIATION_WINDOW_MS),
          lte: captureNow,
        },
      },
      orderBy: { syncTime: "desc" },
      take: SYNC_GOAL_RECONCILIATION_LIMIT,
      select: {
        id: true,
        guildId: true,
        syncTime: true,
        clanTag: true,
        clanName: true,
        memberCount: true,
        unresolvedWeightCount: true,
        deviationScore: true,
        projectionComplete: true,
        sourceSyncedAt: true,
      },
    })) as SyncSnapshotCandidate[];
    summary.candidates = snapshots.length;
    if (snapshots.length === 0) {
      return summary;
    }

    const syncTimes = [...new Map(
      snapshots.map((snapshot) => [snapshot.syncTime.toISOString(), snapshot.syncTime]),
    ).values()];
    const events = (await eventModel.findMany({
      where: {
        eventType: SYNC_ZERO_DEVIATION_EVENT_TYPE,
        syncTime: { in: syncTimes },
      },
      select: {
        guildId: true,
        syncTime: true,
        clanTag: true,
        eventType: true,
        createdAt: true,
        payload: true,
      },
    })) as SyncEventCandidate[];
    const eventByKey = new Map(events.map((event) => [eventKey(event), event]));
    const qualified = snapshots.filter((snapshot) =>
      evaluateSyncZeroDeviationGoal(snapshot).qualified,
    );
    summary.qualified = qualified.length;
    const undispatched = qualified.filter((snapshot) => {
      const event = eventByKey.get(eventKey(snapshot));
      const status = eventPayloadStatus(event?.payload);
      return status !== "delivered" && !(event && !isReservationExpired(event.createdAt, captureNow));
    });
    summary.skipped += qualified.length - undispatched.length;
    if (undispatched.length === 0) {
      dozzleLog.debug(
        `[sync-clan-goals] event=reconciliation outcome=summary candidates=${summary.candidates} qualified=${summary.qualified} delivered=0 skipped=${summary.skipped} failed=0`,
      );
      return summary;
    }

    const clanTags = [...new Set(undispatched.map((snapshot) => normalizeTag(snapshot.clanTag)))];
    const trackedClans = (await (prisma as any).trackedClan.findMany({
      where: { tag: { in: clanTags } },
      select: { tag: true, logChannelId: true, leaderChannelId: true },
    })) as Array<{ tag: string; logChannelId: string | null; leaderChannelId: string | null }>;
    const trackedByTag = new Map(trackedClans.map((clan) => [normalizeTag(clan.tag), clan]));
    const routingByGuild = new Map<string, Promise<any>>();
    const botChannelByGuild = new Map<string, Promise<string | null>>();

    for (const snapshot of undispatched) {
      const tracked = trackedByTag.get(normalizeTag(snapshot.clanTag));
      const routingPromise = routingByGuild.get(snapshot.guildId) ??
        getClanGoalRoutingConfig(snapshot.guildId, this.botLogChannels);
      routingByGuild.set(snapshot.guildId, routingPromise);
      try {
        const routingConfig = await routingPromise;
        let botLogChannelId: string | null = null;
        if (routingConfig.routingMode === "BOT_LOG") {
          const botChannelPromise = botChannelByGuild.get(snapshot.guildId) ??
            this.botLogChannels.getChannelId(snapshot.guildId);
          botChannelByGuild.set(snapshot.guildId, botChannelPromise);
          botLogChannelId = await botChannelPromise;
        }
        const destination = resolveClanGoalDestination({
          routingConfig,
          clanLogChannelId: tracked?.logChannelId,
          clanLeaderChannelId: tracked?.leaderChannelId,
          botLogChannelId,
        });
        if (destination.channelId === null) {
          summary.skipped += 1;
          logClanGoalOutcome({
            outcome: "skip",
            event: "sync_goal_delivery",
            goalId: "SYNC_ZERO_DEVIATION",
            identity: {
              guildId: snapshot.guildId,
              clanTag: snapshot.clanTag,
              syncIdentity: snapshot.syncTime.toISOString(),
            },
            reason: destination.skipReason,
          });
          continue;
        }
        const channel = await this.client.channels.fetch(destination.channelId).catch(() => null);
        if (!isSupportedDestination(channel, snapshot.guildId)) {
          summary.failed += 1;
          logClanGoalOutcome({
            outcome: "failure",
            event: "sync_goal_delivery",
            goalId: "SYNC_ZERO_DEVIATION",
            identity: {
              guildId: snapshot.guildId,
              clanTag: snapshot.clanTag,
              syncIdentity: snapshot.syncTime.toISOString(),
            },
            reason: "destination_unavailable",
          });
          continue;
        }

        const claim = await this.claimEvent({
          eventModel,
          snapshot,
          now: captureNow,
        });
        if (claim.state !== "claimed" || !claim.createdAt) {
          summary.skipped += 1;
          logClanGoalOutcome({
            outcome: claim.state === "unavailable" ? "failure" : "skip",
            event: "sync_goal_delivery",
            goalId: "SYNC_ZERO_DEVIATION",
            identity: {
              guildId: snapshot.guildId,
              clanTag: snapshot.clanTag,
              syncIdentity: snapshot.syncTime.toISOString(),
            },
            reason: claim.reason,
          });
          if (claim.state === "unavailable") summary.failed += 1;
          continue;
        }

        const identity = {
          guildId: snapshot.guildId,
          clanTag: snapshot.clanTag,
          syncIdentity: snapshot.syncTime.toISOString(),
        } as const;
        const rendered = clanGoalService.renderMessage({
          ...identity,
          goalId: "SYNC_ZERO_DEVIATION",
          clanName: snapshot.clanName,
        });
        try {
          const sent = await (channel as any).send({
            content: rendered.content,
            allowedMentions: rendered.allowedMentions,
          });
          const marked = await this.markEventDelivered({
            eventModel,
            snapshot,
            createdAt: claim.createdAt,
            channelId: destination.channelId,
            messageId: String(sent?.id ?? "").trim() || null,
          });
          if (!marked) {
            await this.releaseEvent({ eventModel, snapshot, createdAt: claim.createdAt });
            summary.failed += 1;
            logClanGoalOutcome({
              outcome: "failure",
              event: "sync_goal_delivery",
              goalId: "SYNC_ZERO_DEVIATION",
              identity,
              reason: "delivery_claim_update_failed",
            });
            continue;
          }
          summary.delivered += 1;
          logClanGoalOutcome({
            outcome: "success",
            event: "sync_goal_delivery",
            goalId: "SYNC_ZERO_DEVIATION",
            identity,
            reason: "posted",
          });
        } catch (error) {
          await this.releaseEvent({ eventModel, snapshot, createdAt: claim.createdAt });
          summary.failed += 1;
          logClanGoalOutcome({
            outcome: "failure",
            event: "sync_goal_delivery",
            goalId: "SYNC_ZERO_DEVIATION",
            identity,
            reason: "send_failed_retryable",
            error,
          });
        }
      } catch (error) {
        summary.failed += 1;
        dozzleLog.error(
          `[sync-clan-goals] event=reconciliation outcome=failure guild_id=${snapshot.guildId} clan_tag=${snapshot.clanTag} sync_identity=${snapshot.syncTime.toISOString()} error=${formatError(error)}`,
        );
      }
    }

    const reconciliationLog = summary.delivered > 0 ? dozzleLog.info : dozzleLog.debug;
    reconciliationLog(
      `[sync-clan-goals] event=reconciliation outcome=summary candidates=${summary.candidates} qualified=${summary.qualified} delivered=${summary.delivered} skipped=${summary.skipped} failed=${summary.failed}`,
    );
    return summary;
  }

  private async claimEvent(input: {
    eventModel: any;
    snapshot: SyncSnapshotCandidate;
    now: Date;
  }): Promise<{ state: "claimed" | "unavailable" | "in_flight"; createdAt?: Date; reason: string }> {
    const where = {
      guildId: input.snapshot.guildId,
      syncTime: input.snapshot.syncTime,
      clanTag: normalizeTag(input.snapshot.clanTag),
      eventType: SYNC_ZERO_DEVIATION_EVENT_TYPE,
    };
    try {
      const existing = await input.eventModel.findFirst({
        where,
        select: { createdAt: true, payload: true },
      });
      if (existing) {
        if (eventPayloadStatus(existing.payload) === "delivered") {
          return { state: "in_flight", reason: "already_delivered" };
        }
        if (!isReservationExpired(existing.createdAt, input.now)) {
          return { state: "in_flight", reason: "reservation_in_flight" };
        }
        const reclaimed = await input.eventModel.deleteMany({
          where: { ...where, createdAt: existing.createdAt },
        });
        if (reclaimed.count !== 1) {
          return { state: "in_flight", reason: "reservation_ownership_lost" };
        }
      }
      const created = await input.eventModel.create({
        data: {
          ...where,
          payload: {
            kind: "clan_goal_delivery",
            status: "claimed",
            goalId: "SYNC_ZERO_DEVIATION",
            syncIdentity: input.snapshot.syncTime.toISOString(),
          },
        },
        select: { createdAt: true },
      });
      return { state: "claimed", createdAt: created.createdAt, reason: "claimed" };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { state: "in_flight", reason: "reservation_already_claimed" };
      }
      return { state: "unavailable", reason: `reservation_unavailable:${formatError(error)}` };
    }
  }

  private async markEventDelivered(input: {
    eventModel: any;
    snapshot: SyncSnapshotCandidate;
    createdAt: Date;
    channelId: string;
    messageId: string | null;
  }): Promise<boolean> {
    const result = await input.eventModel.updateMany({
      where: {
        guildId: input.snapshot.guildId,
        syncTime: input.snapshot.syncTime,
        clanTag: normalizeTag(input.snapshot.clanTag),
        eventType: SYNC_ZERO_DEVIATION_EVENT_TYPE,
        createdAt: input.createdAt,
      },
      data: {
        payload: {
          kind: "clan_goal_delivery",
          status: "delivered",
          goalId: "SYNC_ZERO_DEVIATION",
          channelId: input.channelId,
          messageId: input.messageId,
          syncIdentity: input.snapshot.syncTime.toISOString(),
        },
      },
    }).catch(() => ({ count: 0 }));
    return result.count === 1;
  }

  private async releaseEvent(input: {
    eventModel: any;
    snapshot: SyncSnapshotCandidate;
    createdAt: Date;
  }): Promise<void> {
    await input.eventModel.deleteMany({
      where: {
        guildId: input.snapshot.guildId,
        syncTime: input.snapshot.syncTime,
        clanTag: normalizeTag(input.snapshot.clanTag),
        eventType: SYNC_ZERO_DEVIATION_EVENT_TYPE,
        createdAt: input.createdAt,
      },
    }).catch(() => undefined);
  }
}
