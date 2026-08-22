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
  failureCode: string | null;
  failureReason: string | null;
};

type ScheduledSyncPostSourceRow = {
  id: string;
  guildId: string;
  syncTime: Date;
  status: string;
};

type HomeAwaySyncAlertDb = {
  scheduledSyncPost: {
    findMany: (args?: any) => Promise<any[]>;
    findUnique: (args?: any) => Promise<ScheduledSyncPostSourceRow | null>;
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
  clock?: () => Date;
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
const MAX_DISCORD_MESSAGE_LENGTH = 2_000;
const MAX_MESSAGE_FIELD_LENGTH = 512;
const ACTIVE_SOURCE_STATUSES = ["PENDING", "CLAIMED", "PUBLISHED", "FAILED"];
const EVALUATION_STATUSES = [
  HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING,
  HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CLAIMED,
];
const CANCELLABLE_SCHEDULE_STATUSES = [
  ...EVALUATION_STATUSES,
  HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
] as HomeAwaySyncAlertScheduleStatus[];
const NONTERMINAL_DELIVERY_STATUSES = [
  HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
  HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED,
];

/** Purpose: initialize the bounded counters reported by one alert lifecycle cycle. */
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

/** Purpose: accept only finite Date values at persistence and scheduler boundaries. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: normalize persisted identifiers before comparison or member-facing rendering. */
function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

/** Purpose: identify the expected concurrent schedule-creation race from Prisma. */
function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "") === "P2002";
}

/** Purpose: derive the one-time uniform five-to-seven-hour pre-sync fire time. */
function computeFireAt(syncTime: Date, random: () => number): Date {
  const randomValue = Number(random());
  const bounded = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  return new Date(syncTime.getTime() - FIVE_HOURS_MS - bounded * TWO_HOURS_MS);
}

/** Purpose: calculate bounded exponential retry delay for one failed DM attempt. */
function computeRetryAfterMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

/** Purpose: identify claims old enough for safe restart recovery. */
function isStaleClaim(claimedAt: Date | null, now: Date): boolean {
  return Boolean(
    claimedAt &&
      isValidDate(claimedAt) &&
      claimedAt.getTime() <= now.getTime() - CLAIM_STALE_MS,
  );
}

/** Purpose: snapshot the authoritative Home roster identity used in immutable DM content. */
function normalizeRosterMember(member: HomeRosterMember, roster: ClanHomeRoster): RecipientAccount {
  return {
    playerTag: normalizeId(member.playerTag),
    playerName: normalizeId(member.playerName) || normalizeId(member.playerTag),
    homeClanName: normalizeId(roster.clanName) || normalizeId(roster.clanTag),
    homeClanTag: normalizeId(roster.clanTag),
  };
}

/** Purpose: truncate one message field without splitting Unicode code points. */
function truncateMessageField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const kept: string[] = [];
  let length = 0;
  for (const character of value) {
    if (length + character.length > Math.max(0, maxLength - 1)) break;
    kept.push(character);
    length += character.length;
  }
  return `${kept.join("")}…`;
}

/** Purpose: format one complete account line while keeping pathological roster text bounded. */
function buildBoundedAccountLine(account: RecipientAccount): string {
  return `• ${truncateMessageField(account.playerName, MAX_MESSAGE_FIELD_LENGTH)} (\`${truncateMessageField(account.playerTag, MAX_MESSAGE_FIELD_LENGTH)}\`) → **${truncateMessageField(account.homeClanName, MAX_MESSAGE_FIELD_LENGTH)}**`;
}

/** Purpose: format the compact overflow line without exposing sync timing. */
function buildOverflowSummary(omittedCount: number): string {
  return `• …and ${omittedCount} more away Home Clan accounts.`;
}

/** Purpose: compose bounded immutable DM text without exposing sync, fire, or readiness timing. */
export function buildHomeAwaySyncAlertMessage(accounts: readonly RecipientAccount[]): string {
  const sorted = [...accounts].sort(
    (left, right) =>
      left.playerName.localeCompare(right.playerName) ||
      left.playerTag.localeCompare(right.playerTag) ||
      left.homeClanTag.localeCompare(right.homeClanTag),
  );
  if (sorted.length === 1) {
    const account = sorted[0];
    const message = [
      `⚠️ Please return **${account.playerName}** to **${account.homeClanName}** before the upcoming FWA sync.`,
      "",
      "This account is currently away from its Home Clan.",
    ].join("\n");
    if (message.length <= MAX_DISCORD_MESSAGE_LENGTH) return message;
    return [
      `⚠️ Please return **${truncateMessageField(account.playerName, MAX_MESSAGE_FIELD_LENGTH)}** to **${truncateMessageField(account.homeClanName, MAX_MESSAGE_FIELD_LENGTH)}** before the upcoming FWA sync.`,
      "",
      "This account is currently away from its Home Clan.",
    ].join("\n");
  }

  const header = [
    "⚠️ Please return your away Home Clan accounts before the upcoming FWA sync.",
    "",
  ];
  const fullLines = sorted.map((account) =>
    `• ${account.playerName} (\`${account.playerTag}\`) → **${account.homeClanName}**`);
  const fullMessage = [...header, ...fullLines].join("\n");
  if (fullMessage.length <= MAX_DISCORD_MESSAGE_LENGTH) return fullMessage;

  const lines: string[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const line = buildBoundedAccountLine(sorted[index]);
    const omittedCount = sorted.length - index - 1;
    const candidateLines = omittedCount > 0
      ? [...header, ...lines, line, buildOverflowSummary(omittedCount)]
      : [...header, ...lines, line];
    if (candidateLines.join("\n").length > MAX_DISCORD_MESSAGE_LENGTH) break;
    lines.push(line);
  }
  const omittedCount = sorted.length - lines.length;
  return [...header, ...lines, ...(omittedCount > 0 ? [buildOverflowSummary(omittedCount)] : [])].join("\n");
}

/** Purpose: own durable random fire times and idempotent recipient delivery for Home Away events. */
export class HomeAwaySyncAlertService {
  private readonly db: HomeAwaySyncAlertDb;
  private readonly homeRosterReader: Pick<HomeRosterService, "getClanHomeRoster">;
  private readonly random: () => number;
  private readonly clock: () => Date;

  /** Purpose: inject active Discord delivery, persistence, Home roster, and deterministic randomness dependencies. */
  constructor(
    private readonly client: Client,
    dependencies: HomeAwaySyncAlertDependencies = {},
  ) {
    this.db = dependencies.db ?? defaultDb;
    this.homeRosterReader = dependencies.homeRosterService ?? homeRosterService;
    this.random = dependencies.random ?? Math.random;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  /** Purpose: advance a deterministic cycle timestamp to the latest injected or wall-clock time. */
  private getEffectiveNow(cycleNow: Date): Date {
    const current = this.clock();
    if (!isValidDate(current) || current.getTime() <= cycleNow.getTime()) return new Date(cycleNow);
    return new Date(current);
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
      const sourcesByGuild = new Map<string, typeof activeSources>();
      for (const source of activeSources) {
        const guildId = normalizeId(source.guildId);
        if (!guildId) continue;
        const guildSources = sourcesByGuild.get(guildId) ?? [];
        guildSources.push(source);
        sourcesByGuild.set(guildId, guildSources);
      }
      const ambiguousSourceIds = new Set(
        [...sourcesByGuild.values()]
          .filter((guildSources) => guildSources.length > 1)
          .flatMap((guildSources) => guildSources.map((source) => normalizeId(source.id)))
          .filter(Boolean),
      );
      const authoritativeSources = activeSources.filter(
        (source) => !ambiguousSourceIds.has(normalizeId(source.id)),
      );

      const existingSchedules = activeSourceIds.length === 0
        ? []
        : await this.db.homeAwaySyncAlertSchedule.findMany({
            where: { scheduledSyncPostId: { in: activeSourceIds } },
          });
      const existingBySourceId = new Map(
        existingSchedules.map((row) => [normalizeId(row.scheduledSyncPostId), row]),
      );

      for (const sourceId of ambiguousSourceIds) {
        const existing = existingBySourceId.get(sourceId);
        if (!existing || !CANCELLABLE_SCHEDULE_STATUSES.includes(existing.status)) continue;
        await this.cancelSchedule(existing.id, "source_ambiguous");
        counts.cancelled += 1;
      }

      for (const source of authoritativeSources) {
        const sourceId = normalizeId(source.id);
        if (!sourceId || !isValidDate(source.syncTime)) continue;
        const existing = existingBySourceId.get(sourceId);
        if (existing) {
          const reactivated = await this.reactivateScheduleIfNeeded(existing, now);
          if (reactivated) {
            existingBySourceId.set(sourceId, reactivated);
            counts.ensured += 1;
          }
          continue;
        }
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
        counts.cancelled += evaluation.cancelled ? 1 : 0;
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

      dozzleLog.debug(
        `[home-away-sync-alert] cycle_complete ensured=${counts.ensured} due=${counts.due} evaluated=${counts.evaluated} recipients=${counts.recipients} sent=${counts.sent} failed=${counts.failed} unlinked=${counts.unlinked} unknown=${counts.unknown} cancelled=${counts.cancelled} expired=${counts.expired} completed=${counts.completed}`,
      );
      return counts;
    } catch (error) {
      dozzleLog.error(`[home-away-sync-alert] cycle_failed error=${formatError(error)}`);
      throw error;
    }
  }

  /** Purpose: create one durable schedule while converging concurrent creators on its existing row. */
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

  /** Purpose: cancel source-owned work and expire only delivery claims that are still sendable. */
  private async cancelSchedule(scheduleId: string, reason: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.cancelScheduleInTransaction(tx, scheduleId, reason);
    });
    dozzleLog.info(`[home-away-sync-alert] schedule_cancelled alert_id=${scheduleId} reason=${reason}`);
  }

  /** Purpose: apply source-cancellation state atomically inside an existing alert transaction. */
  private async cancelScheduleInTransaction(
    tx: HomeAwaySyncAlertDb,
    scheduleId: string,
    reason: string,
  ): Promise<void> {
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
  }

  /** Purpose: reactivate a cancelled alert without rerandomizing or re-evaluating an existing snapshot. */
  private async reactivateScheduleIfNeeded(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<HomeAwaySyncAlertScheduleRow | null> {
    if (schedule.status !== HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CANCELLED) return null;
    if (!(await this.isSourceValid(this.db, schedule, now))) return null;
    const deliveries = await this.db.homeAwaySyncAlertDelivery.findMany({
      where: { alertScheduleId: schedule.id },
    });
    const resumable = deliveries.filter(
      (delivery) =>
        delivery.status === HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.EXPIRED &&
        delivery.failureCode === "source_cancelled",
    );
    if (resumable.length > 0) {
      await this.db.$transaction(async (tx) => {
        await tx.homeAwaySyncAlertDelivery.updateMany({
          where: {
            alertScheduleId: schedule.id,
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.EXPIRED,
            failureCode: "source_cancelled",
          },
          data: {
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.PENDING,
            claimToken: null,
            claimedAt: null,
            nextAttemptAt: null,
            failureCode: null,
            failureReason: null,
          },
        });
        await tx.homeAwaySyncAlertSchedule.updateMany({
          where: { id: schedule.id, status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CANCELLED },
          data: {
            status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
            claimToken: null,
            claimedAt: null,
            completedAt: null,
            failureCode: null,
            failureReason: null,
          },
        });
      });
      return {
        ...schedule,
        status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED,
        claimToken: null,
        claimedAt: null,
        completedAt: null,
      };
    }

    const allTerminal = deliveries.length > 0 && deliveries.every(
      (delivery) =>
        delivery.status === HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.SENT ||
        delivery.status === HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.FAILED,
    );
    const nextStatus = deliveries.length === 0
      ? HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.PENDING
      : allTerminal
        ? HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED
        : HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED;
    await this.db.homeAwaySyncAlertSchedule.updateMany({
      where: { id: schedule.id, status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.CANCELLED },
      data: {
        status: nextStatus,
        claimToken: null,
        claimedAt: null,
        completedAt: nextStatus === HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED ? now : null,
        failureCode: null,
        failureReason: null,
      },
    });
    return {
      ...schedule,
      status: nextStatus,
      claimToken: null,
      claimedAt: null,
      completedAt: nextStatus === HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED ? now : null,
    };
  }

  /** Purpose: atomically claim one due schedule or recover its stale evaluation lease. */
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

  /** Purpose: authorize later alert side effects against the current immutable sync source row. */
  private async isSourceValid(
    db: Pick<HomeAwaySyncAlertDb, "scheduledSyncPost">,
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<boolean> {
    const sources = await db.scheduledSyncPost.findMany({
      where: {
        guildId: schedule.guildId,
        status: { in: ACTIVE_SOURCE_STATUSES },
        syncTime: { gt: now },
      },
      select: { id: true, guildId: true, syncTime: true, status: true },
    });
    const matchingSources = sources.filter(
      (source) =>
        normalizeId(source.id) === normalizeId(schedule.scheduledSyncPostId) &&
        normalizeId(source.guildId) === normalizeId(schedule.guildId) &&
        isValidDate(source.syncTime) &&
        source.syncTime.getTime() === schedule.syncTime.getTime(),
    );
    return matchingSources.length === 1 && sources.length === 1;
  }

  /** Purpose: distinguish a missing source from a legacy multi-source ambiguity for fail-closed cancellation. */
  private async validateSource(
    db: Pick<HomeAwaySyncAlertDb, "scheduledSyncPost">,
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<"valid" | "ambiguous" | "invalid"> {
    const sources = await db.scheduledSyncPost.findMany({
      where: {
        guildId: schedule.guildId,
        status: { in: ACTIVE_SOURCE_STATUSES },
        syncTime: { gt: now },
      },
      select: { id: true, guildId: true, syncTime: true, status: true },
    });
    if (sources.length > 1) return "ambiguous";
    const source = sources[0];
    return source &&
      normalizeId(source.id) === normalizeId(schedule.scheduledSyncPostId) &&
      normalizeId(source.guildId) === normalizeId(schedule.guildId) &&
      isValidDate(source.syncTime) &&
      source.syncTime.getTime() === schedule.syncTime.getTime()
      ? "valid"
      : "invalid";
  }

  /** Purpose: materialize the one-time Away snapshot only after the source remains authorized. */
  private async evaluateSchedule(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<{
    evaluated: boolean;
    completed: boolean;
    cancelled: boolean;
    recipients: number;
    unlinked: number;
    unknown: number;
  }> {
    if (now.getTime() >= schedule.syncTime.getTime()) {
      await this.expireSchedule(schedule.id, "sync_time_passed_before_evaluation");
      return {
        evaluated: false,
        completed: false,
        cancelled: false,
        recipients: 0,
        unlinked: 0,
        unknown: 0,
      };
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

    const materialized = await this.db.$transaction(async (tx) => {
      const sourceValidation = await this.validateSource(tx, schedule, now);
      if (sourceValidation !== "valid") {
        await this.cancelScheduleInTransaction(
          tx,
          schedule.id,
          sourceValidation === "ambiguous" ? "source_ambiguous" : "source_replaced_or_cancelled",
        );
        return sourceValidation;
      }
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
      return "valid";
    });
    if (materialized !== "valid") {
      dozzleLog.info(
        `[home-away-sync-alert] schedule_cancelled alert_id=${schedule.id} reason=${materialized === "ambiguous" ? "source_ambiguous" : "source_replaced_or_cancelled"}`,
      );
      return {
        evaluated: false,
        completed: false,
        cancelled: true,
        recipients: 0,
        unlinked: 0,
        unknown: 0,
      };
    }
    dozzleLog.info(
      `[home-away-sync-alert] evaluated alert_id=${schedule.id} guild_id=${schedule.guildId} recipients=${recipients.length} away=${awayMembers.length} unlinked=${unlinked} unknown=${unknown}`,
    );
    return {
      evaluated: true,
      completed: recipients.length === 0,
      cancelled: false,
      recipients: recipients.length,
      unlinked,
      unknown,
    };
  }

  /** Purpose: claim and deliver immutable recipients only while the source and schedule remain current. */
  private async processDeliveries(
    schedule: HomeAwaySyncAlertScheduleRow,
    now: Date,
  ): Promise<{ sent: number; failed: number; expired: number; completed: boolean }> {
    const cycleEffectiveNow = this.getEffectiveNow(now);
    if (cycleEffectiveNow.getTime() >= schedule.syncTime.getTime()) {
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
    let expired = 0;
    for (const delivery of deliveries) {
      const claimed = await this.claimDelivery(delivery, now);
      if (!claimed) continue;
      const beforeFetchNow = this.getEffectiveNow(now);
      if (beforeFetchNow.getTime() >= schedule.syncTime.getTime()) {
        await this.expireDelivery(delivery.id, claimed.claimToken, "sync_time_passed_before_send");
        expired += 1;
        continue;
      }
      const beforeFetchValidation = await this.validateSource(this.db, schedule, beforeFetchNow);
      const beforeFetchSchedule = await this.db.homeAwaySyncAlertSchedule.findUnique({
        where: { id: schedule.id },
      });
      const beforeFetchScheduleCurrent = Boolean(
        beforeFetchSchedule &&
          beforeFetchSchedule.status === HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED &&
          normalizeId(beforeFetchSchedule.scheduledSyncPostId) === normalizeId(schedule.scheduledSyncPostId) &&
          normalizeId(beforeFetchSchedule.guildId) === normalizeId(schedule.guildId) &&
          isValidDate(beforeFetchSchedule.syncTime) &&
          beforeFetchSchedule.syncTime.getTime() === schedule.syncTime.getTime(),
      );
      if (beforeFetchValidation !== "valid") {
        await this.cancelSchedule(
          schedule.id,
          beforeFetchValidation === "ambiguous" ? "source_ambiguous" : "source_replaced_or_cancelled",
        );
        continue;
      }
      if (!beforeFetchScheduleCurrent) {
        await this.expireDelivery(delivery.id, claimed.claimToken, "schedule_no_longer_evaluated");
        expired += 1;
        continue;
      }
      try {
        const user = await this.client.users.fetch(delivery.discordUserId);
        const finalNow = this.getEffectiveNow(now);
        if (finalNow.getTime() >= schedule.syncTime.getTime()) {
          await this.expireDelivery(delivery.id, claimed.claimToken, "sync_time_passed_before_send");
          expired += 1;
          continue;
        }
        const finalSourceValidation = await this.validateSource(this.db, schedule, finalNow);
        const currentSchedule = await this.db.homeAwaySyncAlertSchedule.findUnique({
          where: { id: schedule.id },
        });
        const scheduleCurrent = Boolean(
          currentSchedule &&
            currentSchedule.status === HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED &&
            normalizeId(currentSchedule.scheduledSyncPostId) === normalizeId(schedule.scheduledSyncPostId) &&
            normalizeId(currentSchedule.guildId) === normalizeId(schedule.guildId) &&
            isValidDate(currentSchedule.syncTime) &&
            currentSchedule.syncTime.getTime() === schedule.syncTime.getTime(),
        );
        if (finalSourceValidation !== "valid") {
          await this.cancelSchedule(
            schedule.id,
            finalSourceValidation === "ambiguous" ? "source_ambiguous" : "source_replaced_or_cancelled",
          );
          continue;
        }
        if (!scheduleCurrent) {
          await this.expireDelivery(delivery.id, claimed.claimToken, "schedule_no_longer_evaluated");
          continue;
        }
        await user.send({ content: delivery.messageContent });
        const marked = await this.db.homeAwaySyncAlertDelivery.updateMany({
          where: { id: delivery.id, claimToken: claimed.claimToken, status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.CLAIMED },
          data: {
            status: HOME_AWAY_SYNC_ALERT_DELIVERY_STATUS.SENT,
            claimToken: null,
            claimedAt: null,
            sentAt: finalNow,
            failureCode: null,
            failureReason: null,
          },
        });
        if (marked.count === 1) sent += 1;
      } catch (error) {
        failed += 1;
        await this.recordDeliveryFailure({
          delivery,
          claimToken: claimed.claimToken,
          error,
          now: this.getEffectiveNow(now),
          syncTime: schedule.syncTime,
        });
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
      const completedAt = this.getEffectiveNow(now);
      const completed = await this.db.homeAwaySyncAlertSchedule.updateMany({
        where: { id: schedule.id, status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.EVALUATED },
        data: {
          status: HOME_AWAY_SYNC_ALERT_SCHEDULE_STATUS.COMPLETED,
          completedAt,
        },
      });
      if (completed.count === 1) {
        dozzleLog.info(`[home-away-sync-alert] completed alert_id=${schedule.id} guild_id=${schedule.guildId}`);
        return { sent, failed, expired, completed: true };
      }
    }
    return { sent, failed, expired, completed: false };
  }

  /** Purpose: atomically claim one recipient delivery or recover its stale retry lease. */
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

  /** Purpose: classify one failed DM and persist bounded retry or terminal failure state. */
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

  /** Purpose: prevent a claimed recipient from sending after its sync or schedule expires. */
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

  /** Purpose: expire all remaining alert work when the immutable sync deadline has passed. */
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
