import { type Client } from "discord.js";
import { randomUUID } from "node:crypto";
import { dozzleLog } from "../helper/dozzleLogger";
import { formatError } from "../helper/formatError";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  classifyDiscordDeliveryRetryability,
} from "./fwa/baseSwapDmReminderSchedulerService";
import {
  homeRosterService,
  type ClanHomeRoster,
  type HomeRosterMember,
  type HomeRosterService,
} from "./HomeRosterService";
import { prisma } from "../prisma";

export const HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  EVALUATED: "EVALUATED",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;

export const HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  SENT: "SENT",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;

export type HomeAwaySyncAlertScheduleStatus =
  (typeof HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS)[keyof typeof HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS];

export type HomeAwaySyncAlertDeliveryStatus =
  (typeof HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS)[keyof typeof HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS];

export type HomeAwaySyncAlertCounts = {
  ensured: number;
  due: number;
  evaluated: number;
  recipients: number;
  sent: number;
  failed: number;
  unlinked: number;
  unknown: number;
  cancelled: number;
  expired: number;
  completed: number;
};

type HomeAwaySyncAlertScheduleRow = {
  id: string;
  guildId: string;
  scheduledSyncPostId: string;
  syncTime: Date;
  fireAt: Date;
  status: HomeAwaySyncAlertScheduleStatus;
  claimToken: string | null;
  claimedAt: Date | null;
  evaluatedAt: Date | null;
  completedAt: Date | null;
};

type HomeAwaySyncAlertDeliveryRow = {
  id: string;
  alertScheduleId: string;
  guildId: string;
  discordUserId: string;
  messageContent: string;
  status: HomeAwaySyncAlertDeliveryStatus;
  claimToken: string | null;
  claimedAt: Date | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
};

type HomeAwaySyncAlertDb = {
  scheduledSyncPost: {
    findMany: (args?: any) => Promise<any[]>;
  };
  homeAwaySyncAlertSchedule: {
    findMany: (args?: any) => Promise<HomeAwaySyncAlertScheduleRow[]>;
    findUnique: (args?: any) => Promise<HomeAwaySyncAlertScheduleRow | null>;
    create: (args: any) => Promise<HomeAwaySyncAlertScheduleRow>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  homeAwaySyncAlertDelivery: {
    findMany: (args?: any) => Promise<HomeAwaySyncAlertDeliveryRow[]>;
    createMany: (args: any) => Promise<{ count: number }>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  clanHomeMembershipPeriod: {
    findMany: (args?: any) => Promise<any[]>;
  };
  trackedClan: {
    findMany: (args?: any) => Promise<any[]>;
  };
  playerLink: {
    findMany: (args?: any) => Promise<any[]>;
  };
  $transaction: <T>(callback: (tx: HomeAwaySyncAlertDb) => Promise<T>) => Promise<T>;
};

type HomeAwaySyncAlertDependencies = {
  db?: HomeAwaySyncAlertDb;
  homeRosterService?: Pick<HomeRosterService, "getClanHomeRoster">;
  random?: () => number;
};

type RecipientAccount = {
  playerTag: string;
  playerName: string;
  homeClanName: string;
  homeClanTag: string;
};

type Recipient = {
  discordUserId: string;
  accounts: RecipientAccount[];
  messageContent: string;
};

const defaultDb = prisma as unknown as HomeAwaySyncAlertDb;
const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const TWO_HOURS_MS = 2 * HOUR_MS;
const CLAIM_STALE_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 5;
const ACTIVE_SOURCE_STATUSES = ["PENDING", "CLAIMED", "PUBLISHED", "FAILED"];
const EVALUATION_STATUSES = [
  HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
  HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
];
const NONTERMINAL_DELIVERY_STATUSES = [
  HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
  HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED,
];

function zeroCounts(): HomeAwaySyncAlertCounts {
  return {
    ensured: 0,
    due: 0,
    evaluated: 0,
    recipients: 0,
    sent: 0,
    failed: 0,
    unlinked: 0,
    unknown: 0,
    cancelled: 0,
    expired: 0,
    completed: 0,
  };
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "") === "P2002";
}

function computeFireAt(syncTime: Date, random: () => number): Date {
  const randomValue = Number(random());
  const bounded = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  return new Date(syncTime.getTime() - FIVE_HOURS_MS - bounded * TWO_HOURS_MS);
}

function computeRetryAfterMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

function isStaleClaim(claimedAt: Date | null, now: Date): boolean {
  return Boolean(
    claimedAt &&
      isValidDate(claimedAt) &&
      claimedAt.getTime() <= now.getTime() - CLAIM_STALE_MS,
  );
}

function normalizeRosterMember(member: HomeRosterMember, roster: ClanHomeRoster): RecipientAccount {
  return {
    playerTag: normalizeId(member.playerTag),
    playerName: normalizeId(member.playerName) || normalizeId(member.playerTag),
    homeClanName: normalizeId(roster.clanName) || normalizeId(roster.clanTag),
    homeClanTag: normalizeId(roster.clanTag),
  };
}

/** Purpose: build immutable DM text without exposing sync, fire, or readiness timing. */
export function buildHomeAwaySyncAlertMessage(accounts: readonly RecipientAccount[]): string {
  const sorted = [...accounts].sort(
    (left, right) =>
      left.playerName.localeCompare(right.playerName) ||
      left.playerTag.localeCompare(right.playerTag) ||
      left.homeClanTag.localeCompare(right.homeClanTag),
  );
  if (sorted.length === 1) {
    const account = sorted[0];
    return [
      `⚠️ Please return **${account.playerName}** to **${account.homeClanName}** before the upcoming FWA sync.`,
      "",
      "This account is currently away from its Home Clan.",
    ].join("\n");
  }

  return [
    "⚠️ Please return your away Home Clan accounts before the upcoming FWA sync.",
    "",
    ...sorted.map(
      (account) =>
        `• ${account.playerName} (\`${account.playerTag}\`) → **${account.homeClanName}**`,
    ),
  ].join("\n");
}

/** Purpose: own durable random fire times and idempotent recipient delivery for Home Away events. */
export class HomeAwaySyncAlertService {
  private readonly db: HomeAwaySyncAlertDb;
  private readonly homeRosterReader: Pick<HomeRosterService, "getClanHomeRoster">;
  private readonly random: () => number;

  constructor(
    private readonly client: Client,
    dependencies: HomeAwaySyncAlertDependencies = {},
  ) {
    this.db = dependencies.db ?? defaultDb;
    this.homeRosterReader = dependencies.homeRosterService ?? homeRosterService;
    this.random = dependencies.random ?? Math.random;
  }

  /** Purpose: run the alert lifecycle from cheap persisted rows while evaluating Home presence only when due. */
  async runCycle(nowInput: Date = new Date()): Promise<HomeAwaySyncAlertCounts> {
    const counts = zeroCounts();
    if (isMirrorPollingMode(process.env)) return counts;
    const now = isValidDate(nowInput) ? new Date(nowInput) : new Date();

    try {
      const activeSources = await this.db.scheduledSyncPost.findMany({
        where: {
          status: { in: ACTIVE_SOURCE_STATUSES },
          syncTime: { gt: now },
        },
        orderBy: [{ syncTime: "asc" }, { createdAt: "asc" }],
        select: { id: true, guildId: true, syncTime: true, status: true },
      });
      const activeSourceIds = activeSources
        .map((row) => normalizeId(row.id))
        .filter(Boolean);

      const existingSchedules = activeSourceIds.length === 0
        ? []
        : await this.db.homeAwaySyncAlertSchedule.findMany({
            where: { scheduledSyncPostId: { in: activeSourceIds } },
          });
      const existingBySourceId = new Map(
        existingSchedules.map((row) => [normalizeId(row.scheduledSyncPostId), row]),
      );

      for (const source of activeSources) {
        const sourceId = normalizeId(source.id);
        if (!sourceId || !isValidDate(source.syncTime)) continue;
        if (existingBySourceId.has(sourceId)) continue;
        const created = await this.createScheduleIfAbsent({
          scheduledSyncPostId: sourceId,
          guildId: normalizeId(source.guildId),
          syncTime: source.syncTime,
        });
        if (created) {
          existingSchedules.push(created);
          existingBySourceId.set(sourceId, created);
          counts.ensured += 1;
          dozzleLog.info(
            `[home-away-sync-alert] schedule_created alert_id=${created.id} guild_id=${created.guildId} sync_epoch=${Math.floor(created.syncTime.getTime() / 1000)} fire_epoch=${Math.floor(created.fireAt.getTime() / 1000)}`,
          );
        }
      }

      const staleSchedules = await this.db.homeAwaySyncAlertSchedule.findMany({
        where: {
          status: {
            in: [
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
            ],
          },
          syncTime: { gt: now },
          ...(activeSourceIds.length > 0
            ? { scheduledSyncPostId: { notIn: activeSourceIds } }
            : {}),
        },
      });
      for (const schedule of staleSchedules) {
        await this.cancelSchedule(schedule.id, "source_replaced_or_cancelled");
        counts.cancelled += 1;
        existingBySourceId.delete(normalizeId(schedule.scheduledSyncPostId));
      }

      const dueSchedules = await this.db.homeAwaySyncAlertSchedule.findMany({
        where: {
          status: { in: EVALUATION_STATUSES },
          fireAt: { lte: now },
          syncTime: { gt: now },
        },
        orderBy: [{ fireAt: "asc" }, { createdAt: "asc" }],
      });
      counts.due = dueSchedules.length;

      for (const schedule of dueSchedules) {
        const claimed = await this.claimSchedule(schedule, now);
        if (!claimed) continue;
        const evaluation = await this.evaluateSchedule(claimed, now);
        counts.evaluated += evaluation.evaluated ? 1 : 0;
        counts.completed += evaluation.completed ? 1 : 0;
        counts.recipients += evaluation.recipients;
        counts.unlinked += evaluation.unlinked;
        counts.unknown += evaluation.unknown;
      }

      const evaluatedSchedules = await this.db.homeAwaySyncAlertSchedule.findMany({
        where: {
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
          syncTime: { gt: now },
        },
        orderBy: [{ evaluatedAt: "asc" }, { createdAt: "asc" }],
      });
      for (const schedule of evaluatedSchedules) {
        const deliveryResult = await this.processDeliveries(schedule, now);
        counts.sent += deliveryResult.sent;
        counts.failed += deliveryResult.failed;
        counts.expired += deliveryResult.expired;
        counts.completed += deliveryResult.completed ? 1 : 0;
      }

      const expiredSchedules = await this.db.homeAwaySyncAlertSchedule.findMany({
        where: {
          status: {
            in: [
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
            ],
          },
          syncTime: { lte: now },
        },
      });
      for (const schedule of expiredSchedules) {
        await this.expireSchedule(schedule.id, "sync_time_passed");
        counts.expired += 1;
      }

      dozzleLog.info(
        `[home-away-sync-alert] cycle_complete ensured=${counts.ensured} due=${counts.due} evaluated=${counts.evaluated} recipients=${counts.recipients} sent=${counts.sent} failed=${counts.failed} unlinked=${counts.unlinked} unknown=${counts.unknown} cancelled=${counts.cancelled} expired=${counts.expired} completed=${counts.completed}`,
      );
      return counts;
    } catch (error) {
      dozzleLog.error(`[home-away-sync-alert] cycle_failed error=${formatError(error)}`);
      throw error;
    }
  }

  private async createScheduleIfAbsent(input: {
    scheduledSyncPostId: string;
    guildId: string;
    syncTime: Date;
  }): Promise<HomeAwaySyncAlertScheduleRow | null> {
    try {
      return await this.db.homeAwaySyncAlertSchedule.create({
        data: {
          scheduledSyncPostId: input.scheduledSyncPostId,
          guildId: input.guildId,
          syncTime: input.syncTime,
          fireAt: computeFireAt(input.syncTime, this.random),
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.db.homeAwaySyncAlertSchedule.findUnique({
        where: { scheduledSyncPostId: input.scheduledSyncPostId },
      });
    }
  }

  private async cancelSchedule(scheduleId: string, reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.homeAwaySyncAlertDelivery.updateMany({
        where: {
          alertScheduleId: scheduleId,
          status: { in: NONTERMINAL_DELIVERY_STATUSES },
        },
        data: {
          status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.EXPIRED,
          claimToken: null,
          claimedAt: null,
          failureCode: "source_cancelled",
          failureReason: reason,
        },
      });
      await tx.homeAwaySyncAlertSchedule.updateMany({
        where: {
          id: scheduleId,
          status: {
            in: [
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
            ],
          },
        },
        data: {
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CANCELLED,
          claimToken: null,
          claimedAt: null,
          failureCode: "source_cancelled",
          failureReason: reason,
        },
      });
    });
    dozzleLog.info(`[home-away-sync-alert] schedule_cancelled alert_id=${scheduleId} reason=${reason}`);
  }

  private async claimSchedule(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<HomeAwaySyncAlertScheduleRow | null> {
    const stale = schedule.status === HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED;
    if (stale && !isStaleClaim(schedule.claimedAt, now)) return null;
    if (
      schedule.status !== HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING &&
      !stale
    ) {
      return null;
    }
    const claimToken = randomUUID();
    const result = await this.db.homeAwaySyncAlertSchedule.updateMany({
      where: {
        id: schedule.id,
        status: stale
          ? HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED
          : HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
        ...(stale
          ? { claimedAt: { lte: new Date(now.getTime() - CLAIM_STALE_MS) } }
          : { fireAt: { lte: now } }),
      },
      data: {
        status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
        claimToken,
        claimedAt: now,
      },
    });
    if (result.count !== 1) return null;
    return {
      ...schedule,
      status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
      claimToken,
      claimedAt: now,
    };
  }

  private async evaluateSchedule(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<{
    evaluated: boolean;
    completed: boolean;
    recipients: number;
    unlinked: number;
    unknown: number;
  }> {
    if (now.getTime() >= schedule.syncTime.getTime()) {
      await this.expireSchedule(schedule.id, "sync_time_passed_before_evaluation");
      return { evaluated: false, completed: false, recipients: 0, unlinked: 0, unknown: 0 };
    }

    const homeRows = await this.db.clanHomeMembershipPeriod.findMany({
      where: { guildId: schedule.guildId, endedAtSyncTime: null },
      select: { clanTag: true },
    });
    const homeClanTags = [...new Set(homeRows.map((row) => normalizeId(row.clanTag)).filter(Boolean))];
    const trackedClans = homeClanTags.length === 0
      ? []
      : await this.db.trackedClan.findMany({
          where: { tag: { in: homeClanTags } },
          select: { tag: true, name: true },
        });
    const trackedTagSet = new Set(trackedClans.map((row) => normalizeId(row.tag)).filter(Boolean));
    const rosters = await Promise.all(
      trackedClans
        .filter((row) => trackedTagSet.has(normalizeId(row.tag)))
        .map((row) => this.homeRosterReader.getClanHomeRoster({ guildId: schedule.guildId, clanTag: row.tag, now })),
    );
    const awayMembers: Array<{ member: HomeRosterMember; roster: ClanHomeRoster }> = [];
    let unknown = 0;
    for (const roster of rosters) {
      unknown += roster.unknownCount;
      for (const member of roster.members) {
        if (member.presence === "AWAY") awayMembers.push({ member, roster });
      }
    }
    const awayTags = [...new Set(awayMembers.map(({ member }) => normalizeId(member.playerTag)).filter(Boolean))];
    const links = awayTags.length === 0
      ? []
      : await this.db.playerLink.findMany({
          where: { playerTag: { in: awayTags }, discordUserId: { not: null } },
          select: { playerTag: true, discordUserId: true },
        });
    const linkedByTag = new Map(
      links
        .map((row) => [normalizeId(row.playerTag), normalizeId(row.discordUserId)] as const)
        .filter(([tag, userId]) => Boolean(tag && userId)),
    );
    const recipientAccounts = new Map<string, RecipientAccount[]>();
    let unlinked = 0;
    for (const entry of awayMembers) {
      const playerTag = normalizeId(entry.member.playerTag);
      const discordUserId = linkedByTag.get(playerTag);
      if (!discordUserId) {
        unlinked += 1;
        continue;
      }
      const accounts = recipientAccounts.get(discordUserId) ?? [];
      accounts.push(normalizeRosterMember(entry.member, entry.roster));
      recipientAccounts.set(discordUserId, accounts);
    }
    const recipients: Recipient[] = [...recipientAccounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([discordUserId, accounts]) => ({
        discordUserId,
        accounts,
        messageContent: buildHomeAwaySyncAlertMessage(accounts),
      }));

    await this.db.$transaction(async (tx) => {
      if (recipients.length > 0) {
        await tx.homeAwaySyncAlertDelivery.createMany({
          data: recipients.map((recipient) => ({
            alertScheduleId: schedule.id,
            guildId: schedule.guildId,
            discordUserId: recipient.discordUserId,
            messageContent: recipient.messageContent,
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
          })),
          skipDuplicates: true,
        });
      }
      await tx.homeAwaySyncAlertSchedule.updateMany({
        where: { id: schedule.id, claimToken: schedule.claimToken, status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED },
        data: {
          status: recipients.length > 0
            ? HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED
            : HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED,
          evaluatedAt: now,
          completedAt: recipients.length > 0 ? null : now,
          claimToken: null,
          claimedAt: null,
        },
      });
    });
    dozzleLog.info(
      `[home-away-sync-alert] evaluated alert_id=${schedule.id} guild_id=${schedule.guildId} recipients=${recipients.length} away=${awayMembers.length} unlinked=${unlinked} unknown=${unknown}`,
    );
    return {
      evaluated: true,
      completed: recipients.length === 0,
      recipients: recipients.length,
      unlinked,
      unknown,
    };
  }

  private async processDeliveries(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<{ sent: number; failed: number; expired: number; completed: boolean }> {
    if (now.getTime() >= schedule.syncTime.getTime()) {
      await this.expireSchedule(schedule.id, "sync_time_passed_before_delivery");
      return { sent: 0, failed: 0, expired: 1, completed: false };
    }
    const deliveries = await this.db.homeAwaySyncAlertDelivery.findMany({
      where: {
        alertScheduleId: schedule.id,
        status: { in: NONTERMINAL_DELIVERY_STATUSES },
      },
      orderBy: [{ createdAt: "asc" }, { discordUserId: "asc" }],
    });
    let sent = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      const claimed = await this.claimDelivery(delivery, now);
      if (!claimed) continue;
      if (now.getTime() >= schedule.syncTime.getTime()) {
        await this.expireDelivery(delivery.id, claimed.claimToken, "sync_time_passed_before_send");
        continue;
      }
      try {
        const user = await this.client.users.fetch(delivery.discordUserId);
        await user.send({ content: delivery.messageContent });
        const marked = await this.db.homeAwaySyncAlertDelivery.updateMany({
          where: { id: delivery.id, claimToken: claimed.claimToken, status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED },
          data: {
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.SENT,
            claimToken: null,
            claimedAt: null,
            sentAt: now,
            failureCode: null,
            failureReason: null,
          },
        });
        if (marked.count === 1) sent += 1;
      } catch (error) {
        failed += 1;
        await this.recordDeliveryFailure({ delivery, claimToken: claimed.claimToken, error, now, syncTime: schedule.syncTime });
      }
    }

    const remaining = await this.db.homeAwaySyncAlertDelivery.findMany({
      where: {
        alertScheduleId: schedule.id,
        status: { in: NONTERMINAL_DELIVERY_STATUSES },
      },
      select: { id: true },
    });
    if (remaining.length === 0) {
      const completed = await this.db.homeAwaySyncAlertSchedule.updateMany({
        where: { id: schedule.id, status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED },
        data: {
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED,
          completedAt: now,
        },
      });
      if (completed.count === 1) {
        dozzleLog.info(`[home-away-sync-alert] completed alert_id=${schedule.id} guild_id=${schedule.guildId}`);
        return { sent, failed, expired: 0, completed: true };
      }
    }
    return { sent, failed, expired: 0, completed: false };
  }

  private async claimDelivery(
    delivery: HomeAwaySyncAlertDeliveryRow,
    now: Date,
  ): Promise<{ claimToken: string } | null> {
    const stale = delivery.status === HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED;
    if (stale && !isStaleClaim(delivery.claimedAt, now)) return null;
    if (delivery.status !== HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING && !stale) return null;
    if (!stale && delivery.nextAttemptAt && delivery.nextAttemptAt.getTime() > now.getTime()) return null;
    const claimToken = randomUUID();
    const result = await this.db.homeAwaySyncAlertDelivery.updateMany({
      where: {
        id: delivery.id,
        status: stale
          ? HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED
          : HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
        ...(stale
          ? { claimedAt: { lte: new Date(now.getTime() - CLAIM_STALE_MS) } }
          : {
              OR: [
                { nextAttemptAt: null },
                { nextAttemptAt: { lte: now } },
              ],
            }),
      },
      data: {
        status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED,
        claimToken,
        claimedAt: now,
        attemptCount: { increment: 1 },
        nextAttemptAt: null,
      },
    });
    return result.count === 1 ? { claimToken } : null;
  }

  private async recordDeliveryFailure(input: {
    delivery: HomeAwaySyncAlertDeliveryRow;
    claimToken: string;
    error: unknown;
    now: Date;
    syncTime: Date;
  }): Promise<void> {
    const classification = classifyDiscordDeliveryRetryability(input.error);
    const attemptCount = input.delivery.attemptCount + 1;
    const retryAfterMs = computeRetryAfterMs(attemptCount);
    const canRetry =
      classification.retryable &&
      attemptCount < MAX_DELIVERY_ATTEMPTS &&
      input.now.getTime() + retryAfterMs < input.syncTime.getTime();
    await this.db.homeAwaySyncAlertDelivery.updateMany({
      where: {
        id: input.delivery.id,
        claimToken: input.claimToken,
        status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED,
      },
      data: canRetry
        ? {
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
            claimToken: null,
            claimedAt: null,
            nextAttemptAt: new Date(input.now.getTime() + retryAfterMs),
            failureCode: classification.code,
            failureReason: formatError(input.error),
          }
        : {
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.FAILED,
            claimToken: null,
            claimedAt: null,
            nextAttemptAt: null,
            failureCode: classification.code ?? (classification.retryable ? "retry_exhausted" : "terminal_delivery_failure"),
            failureReason: formatError(input.error),
          },
    });
    dozzleLog.warn(
      `[home-away-sync-alert] delivery_failed alert_id=${input.delivery.alertScheduleId} user_id=${input.delivery.discordUserId} retryable=${canRetry ? "true" : "false"} code=${classification.code ?? "unknown"}`,
    );
  }

  private async expireDelivery(deliveryId: string, claimToken: string, reason: string): Promise<void> {
    await this.db.homeAwaySyncAlertDelivery.updateMany({
      where: { id: deliveryId, claimToken, status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED },
      data: {
        status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.EXPIRED,
        claimToken: null,
        claimedAt: null,
        failureCode: "expired",
        failureReason: reason,
      },
    });
  }

  private async expireSchedule(scheduleId: string, reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.homeAwaySyncAlertDelivery.updateMany({
        where: {
          alertScheduleId: scheduleId,
          status: { in: NONTERMINAL_DELIVERY_STATUSES },
        },
        data: {
          status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.EXPIRED,
          claimToken: null,
          claimedAt: null,
          failureCode: "expired",
          failureReason: reason,
        },
      });
      await tx.homeAwaySyncAlertSchedule.updateMany({
        where: {
          id: scheduleId,
          status: {
            in: [
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
              HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
            ],
          },
        },
        data: {
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EXPIRED,
          claimToken: null,
          claimedAt: null,
          failureCode: "expired",
          failureReason: reason,
        },
      });
    });
    dozzleLog.info(`[home-away-sync-alert] schedule_expired alert_id=${scheduleId} reason=${reason}`);
  }
}
