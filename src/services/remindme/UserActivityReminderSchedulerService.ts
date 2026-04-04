import {
  UserActivityReminderDeliveryStatus,
  UserActivityReminderType,
} from "@prisma/client";
import { Client } from "discord.js";
import { formatError } from "../../helper/formatError";
import { prisma } from "../../prisma";
import { type CoCService } from "../CoCService";
import {
  isCoCQueueSkippedError,
} from "../CoCRequestQueueService";
import { runWithCoCQueueContext } from "../CoCQueueContext";
import { normalizeClanTag } from "../PlayerLinkService";
import {
  todoSnapshotService,
  type TodoSnapshotRecord,
} from "../TodoSnapshotService";
import {
  userActivityReminderDispatchService,
  type UserActivityReminderDispatchService,
} from "./UserActivityReminderDispatchService";

const DEFAULT_USER_ACTIVITY_REMINDER_INTERVAL_MS = 60 * 1000;
const DEFAULT_GAMES_COMPLETE_TARGET = 4000;

type ReminderSchedulerCounts = {
  evaluated: number;
  fired: number;
  deduped: number;
  failed: number;
};

type ResolvedReminderEventContext = {
  eventInstanceKey: string;
  eventEndsAt: Date;
  playerTag: string;
  playerName: string | null;
  clanName: string | null;
};

/** Purpose: run periodic user-activity reminder evaluation with overlap guards and restart-safe dedupe. */
export class UserActivityReminderSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** Purpose: initialize scheduler dependencies with deterministic defaults. */
  constructor(
    private readonly client: Client,
    private readonly cocService: CoCService,
    private readonly dispatch: UserActivityReminderDispatchService =
      userActivityReminderDispatchService,
    private readonly intervalMs: number = DEFAULT_USER_ACTIVITY_REMINDER_INTERVAL_MS,
  ) {}

  /** Purpose: start immediate + periodic scheduler evaluation for user-scoped reminder rules. */
  start(): void {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
    console.log(`[remindme] scheduler started interval_ms=${this.intervalMs}`);
  }

  /** Purpose: stop periodic scheduler loop for clean shutdowns/tests. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Purpose: run one guarded evaluation cycle while preventing overlapping work. */
  async runCycle(nowMs: number = Date.now()): Promise<ReminderSchedulerCounts> {
    if (this.inFlight) {
      console.log("[remindme] scheduler skipped reason=in_flight");
      return { evaluated: 0, fired: 0, deduped: 0, failed: 0 };
    }
    this.inFlight = true;
    try {
      const counts = await runWithCoCQueueContext(
        {
          priority: "background",
          source: "user_activity_reminder_scheduler",
          scheduledAtMs: nowMs,
          nextScheduledAtMs: nowMs + this.intervalMs,
        },
        () =>
          runUserActivityReminderSchedulerCycle({
            client: this.client,
            cocService: this.cocService,
            dispatch: this.dispatch,
            nowMs,
            intervalMs: this.intervalMs,
          }),
      );
      console.log(
        `[remindme] scheduler evaluated=${counts.evaluated} fired=${counts.fired} deduped=${counts.deduped} failed=${counts.failed}`,
      );
      return counts;
    } catch (err) {
      if (isCoCQueueSkippedError(err)) {
        console.warn(`[remindme] scheduler skipped reason=stale_queue ${err.message}`);
        return { evaluated: 0, fired: 0, deduped: 0, failed: 0 };
      }
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
}

/** Purpose: run one scheduler cycle from persisted rules to due dispatch with dedupe persistence. */
export async function runUserActivityReminderSchedulerCycle(input: {
  client: Client;
  cocService: CoCService;
  dispatch: UserActivityReminderDispatchService;
  nowMs?: number;
  intervalMs?: number;
}): Promise<ReminderSchedulerCounts> {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const intervalMs = Number.isFinite(input.intervalMs)
    ? Math.max(1, Math.trunc(Number(input.intervalMs)))
    : DEFAULT_USER_ACTIVITY_REMINDER_INTERVAL_MS;

  const rules = await prisma.userActivityReminderRule.findMany({
    where: { isActive: true },
    orderBy: [
      { discordUserId: "asc" },
      { type: "asc" },
      { playerTag: "asc" },
      { method: "asc" },
      { offsetMinutes: "asc" },
    ],
  });
  if (rules.length <= 0) {
    return { evaluated: 0, fired: 0, deduped: 0, failed: 0 };
  }

  const uniqueTags = [...new Set(rules.map((rule) => rule.playerTag))];
  if (uniqueTags.length > 0) {
    try {
      await todoSnapshotService.refreshSnapshotsForPlayerTags({
        playerTags: uniqueTags,
        cocService: input.cocService,
        nowMs,
      });
    } catch (err) {
      console.error(`[remindme] snapshot_refresh_failed error=${formatError(err)}`);
    }
  }

  const snapshots = await todoSnapshotService.listSnapshotsByPlayerTags({
    playerTags: uniqueTags,
  });
  const snapshotByTag = new Map(snapshots.map((row) => [row.playerTag, row]));

  const warClanTags = [...new Set(
    snapshots
      .map((row) => normalizeClanTag(row.clanTag ?? ""))
      .filter(Boolean),
  )];
  const currentWarRows =
    warClanTags.length > 0
      ? await prisma.currentWar.findMany({
          where: { clanTag: { in: warClanTags } },
          select: {
            clanTag: true,
            warId: true,
            startTime: true,
            endTime: true,
            state: true,
            updatedAt: true,
          },
        })
      : [];
  const currentWarByClanTag = pickLatestCurrentWarByClanTag(currentWarRows);

  let evaluated = 0;
  let fired = 0;
  let deduped = 0;
  let failed = 0;

  for (const rule of rules) {
    const snapshot = snapshotByTag.get(rule.playerTag) ?? null;
    if (!snapshot) continue;

    const context = resolveReminderEventContext({
      ruleType: rule.type,
      snapshot,
      currentWarByClanTag,
      nowMs,
    });
    if (!context) continue;

    evaluated += 1;
    if (
      !shouldReminderOffsetFire({
        nowMs,
        intervalMs,
        eventEndsAtMs: context.eventEndsAt.getTime(),
        offsetMinutes: rule.offsetMinutes,
      })
    ) {
      continue;
    }

    const triggerAt = new Date(context.eventEndsAt.getTime() - rule.offsetMinutes * 60 * 1000);
    const delivery = await createDeliveryIfFirst({
      reminderRuleId: rule.id,
      eventInstanceKey: context.eventInstanceKey,
      scheduledAt: triggerAt,
    });
    if (delivery.outcome === "duplicate") {
      deduped += 1;
      continue;
    }
    if (delivery.outcome === "failed") {
      failed += 1;
      continue;
    }

    const completionState = resolveReminderCompletionState({
      ruleType: rule.type,
      snapshot,
    });
    if (completionState.complete) {
      await prisma.userActivityReminderDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveryStatus: UserActivityReminderDeliveryStatus.SKIPPED,
          errorMessage: completionState.reason,
        },
      });
      continue;
    }

    const dispatchResult = await input.dispatch.dispatchReminder(input.client, {
      discordUserId: rule.discordUserId,
      method: rule.method,
      surfaceChannelId: rule.surfaceChannelId ?? null,
      reminderType: rule.type,
      playerTag: context.playerTag,
      playerName: context.playerName,
      clanName: context.clanName,
      eventInstanceKey: context.eventInstanceKey,
      eventEndsAt: context.eventEndsAt,
      offsetMinutes: rule.offsetMinutes,
    });

    if (dispatchResult.status === "sent") {
      fired += 1;
      await prisma.userActivityReminderDelivery.update({
        where: { id: delivery.id },
        data: {
          deliveryStatus: UserActivityReminderDeliveryStatus.SENT,
          sentAt: new Date(nowMs),
          deliverySurface: dispatchResult.deliverySurface,
        },
      });
      continue;
    }

    failed += 1;
    await prisma.userActivityReminderDelivery.update({
      where: { id: delivery.id },
      data: {
        deliveryStatus: UserActivityReminderDeliveryStatus.FAILED,
        errorMessage: dispatchResult.errorMessage.slice(0, 500),
      },
    });
  }

  return { evaluated, fired, deduped, failed };
}

/** Purpose: expose trigger-window logic for deterministic unit tests. */
export const shouldReminderOffsetFireForTest = shouldReminderOffsetFire;

/** Purpose: decide whether one offset is due in current scheduler tick while preventing post-end sends. */
function shouldReminderOffsetFire(input: {
  nowMs: number;
  intervalMs: number;
  eventEndsAtMs: number;
  offsetMinutes: number;
}): boolean {
  const offsetMs = Math.max(1, Math.trunc(input.offsetMinutes)) * 60 * 1000;
  const triggerAtMs = input.eventEndsAtMs - offsetMs;
  if (!Number.isFinite(triggerAtMs)) return false;
  if (input.nowMs >= input.eventEndsAtMs) return false;
  const previousTickMs = input.nowMs - Math.max(1, input.intervalMs);
  const crossedThisCycle = triggerAtMs > previousTickMs && triggerAtMs <= input.nowMs;
  const lateFireBeforeEnd = triggerAtMs <= previousTickMs;
  return crossedThisCycle || lateFireBeforeEnd;
}

/** Purpose: create one unique delivery record per `(rule,event)` and return dedupe outcome. */
async function createDeliveryIfFirst(input: {
  reminderRuleId: string;
  eventInstanceKey: string;
  scheduledAt: Date;
}): Promise<
  | { outcome: "created"; id: string }
  | { outcome: "duplicate" }
  | { outcome: "failed" }
> {
  try {
    const created = await prisma.userActivityReminderDelivery.create({
      data: {
        reminderRuleId: input.reminderRuleId,
        eventInstanceKey: input.eventInstanceKey,
        scheduledAt: input.scheduledAt,
        deliveryStatus: UserActivityReminderDeliveryStatus.SKIPPED,
      },
      select: { id: true },
    });
    return { outcome: "created", id: created.id };
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code ?? "";
    if (code === "P2002") {
      return { outcome: "duplicate" };
    }
    console.error(`[remindme] delivery_create_failed error=${formatError(err)}`);
    return { outcome: "failed" };
  }
}

/** Purpose: resolve one rule's active event identity and end timestamp from snapshot/current-war state. */
function resolveReminderEventContext(input: {
  ruleType: UserActivityReminderType;
  snapshot: TodoSnapshotRecord;
  currentWarByClanTag: Map<
    string,
    {
      warId: number | null;
      startTime: Date | null;
      endTime: Date | null;
      state: string | null;
    }
  >;
  nowMs: number;
}): ResolvedReminderEventContext | null {
  if (input.ruleType === UserActivityReminderType.WAR) {
    const clanTag = normalizeClanTag(input.snapshot.clanTag ?? "");
    if (!clanTag) return null;
    const war = input.currentWarByClanTag.get(clanTag) ?? null;
    const eventEndsAt = war?.endTime ?? input.snapshot.warEndsAt ?? null;
    if (!input.snapshot.warActive || !eventEndsAt) return null;
    if (eventEndsAt.getTime() <= input.nowMs) return null;
    const eventInstanceKey = war
      ? buildWarEventInstanceKey(clanTag, war)
      : `WAR:${clanTag}:${eventEndsAt.getTime()}`;
    return {
      eventInstanceKey,
      eventEndsAt,
      playerTag: input.snapshot.playerTag,
      playerName: sanitizeDisplayText(input.snapshot.playerName),
      clanName: sanitizeDisplayText(input.snapshot.clanName),
    };
  }

  if (input.ruleType === UserActivityReminderType.CWL) {
    if (!input.snapshot.cwlActive || !input.snapshot.cwlEndsAt) return null;
    if (input.snapshot.cwlEndsAt.getTime() <= input.nowMs) return null;
    const cwlClanTag = normalizeClanTag(input.snapshot.cwlClanTag ?? "");
    if (!cwlClanTag) return null;
    return {
      eventInstanceKey: `CWL:${cwlClanTag}:${input.snapshot.cwlEndsAt.getTime()}`,
      eventEndsAt: input.snapshot.cwlEndsAt,
      playerTag: input.snapshot.playerTag,
      playerName: sanitizeDisplayText(input.snapshot.playerName),
      clanName: sanitizeDisplayText(input.snapshot.cwlClanName),
    };
  }

  if (input.ruleType === UserActivityReminderType.RAIDS) {
    if (!input.snapshot.raidActive || !input.snapshot.raidEndsAt) return null;
    if (input.snapshot.raidEndsAt.getTime() <= input.nowMs) return null;
    const clanTag =
      normalizeClanTag(input.snapshot.clanTag ?? "") || input.snapshot.playerTag;
    return {
      eventInstanceKey: `RAIDS:${clanTag}:${input.snapshot.raidEndsAt.getTime()}`,
      eventEndsAt: input.snapshot.raidEndsAt,
      playerTag: input.snapshot.playerTag,
      playerName: sanitizeDisplayText(input.snapshot.playerName),
      clanName: sanitizeDisplayText(input.snapshot.clanName),
    };
  }

  if (!input.snapshot.gamesActive || !input.snapshot.gamesEndsAt) return null;
  if (input.snapshot.gamesEndsAt.getTime() <= input.nowMs) return null;
  const clanTag =
    normalizeClanTag(input.snapshot.clanTag ?? "") ||
    normalizeClanTag(input.snapshot.cwlClanTag ?? "") ||
    input.snapshot.playerTag;
  const cycleKey = sanitizeDisplayText(input.snapshot.gamesCycleKey) ?? String(input.snapshot.gamesEndsAt.getTime());
  return {
    eventInstanceKey: `GAMES:${clanTag}:${cycleKey}`,
    eventEndsAt: input.snapshot.gamesEndsAt,
    playerTag: input.snapshot.playerTag,
    playerName: sanitizeDisplayText(input.snapshot.playerName),
    clanName:
      sanitizeDisplayText(input.snapshot.clanName) ??
      sanitizeDisplayText(input.snapshot.cwlClanName),
  };
}

/** Purpose: pick one freshest CurrentWar row per clan-tag for WAR event identity resolution. */
function pickLatestCurrentWarByClanTag(
  rows: Array<{
    clanTag: string;
    warId: number | null;
    startTime: Date | null;
    endTime: Date | null;
    state: string | null;
    updatedAt: Date;
  }>,
): Map<
  string,
  {
    warId: number | null;
    startTime: Date | null;
    endTime: Date | null;
    state: string | null;
  }
> {
  const latest = new Map<
    string,
    {
      warId: number | null;
      startTime: Date | null;
      endTime: Date | null;
      state: string | null;
      updatedAt: Date;
    }
  >();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        warId: toFiniteIntOrNull(row.warId),
        startTime: row.startTime ?? null,
        endTime: row.endTime ?? null,
        state: row.state ?? null,
        updatedAt: row.updatedAt,
      });
    }
  }
  const finalized = new Map<
    string,
    {
      warId: number | null;
      startTime: Date | null;
      endTime: Date | null;
      state: string | null;
    }
  >();
  for (const [clanTag, value] of latest.entries()) {
    finalized.set(clanTag, {
      warId: value.warId,
      startTime: value.startTime,
      endTime: value.endTime,
      state: value.state,
    });
  }
  return finalized;
}

/** Purpose: build durable WAR event-instance identity from strongest available current-war keys. */
function buildWarEventInstanceKey(
  clanTag: string,
  war: {
    warId: number | null;
    startTime: Date | null;
    endTime: Date | null;
    state: string | null;
  },
): string {
  if (war.warId !== null && war.warId > 0) {
    return `WAR:${clanTag}:war-id:${war.warId}`;
  }
  const startMs = war.startTime ? war.startTime.getTime() : 0;
  const endMs = war.endTime ? war.endTime.getTime() : 0;
  return `WAR:${clanTag}:derived:${startMs}:${endMs}`;
}

/** Purpose: coerce unknown numeric inputs to finite ints or null for identity-safe keys. */
function toFiniteIntOrNull(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Purpose: clamp unknown numeric inputs into one deterministic integer range. */
function clampInt(input: unknown, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return min;
  const truncated = Math.trunc(parsed);
  return Math.max(min, Math.min(max, truncated));
}

/** Purpose: decide whether reminder delivery should be skipped because task completion is already satisfied. */
function resolveReminderCompletionState(input: {
  ruleType: UserActivityReminderType;
  snapshot: TodoSnapshotRecord;
}): { complete: boolean; reason: string | null } {
  if (input.ruleType === UserActivityReminderType.WAR) {
    const max = Math.max(1, clampInt(input.snapshot.warAttacksMax, 1, 2));
    const used = clampInt(input.snapshot.warAttacksUsed, 0, max);
    if (used >= max) {
      return { complete: true, reason: `completed_before_send:WAR:${used}/${max}` };
    }
    return { complete: false, reason: null };
  }

  if (input.ruleType === UserActivityReminderType.CWL) {
    const max = Math.max(1, clampInt(input.snapshot.cwlAttacksMax, 1, 1));
    const used = clampInt(input.snapshot.cwlAttacksUsed, 0, max);
    if (used >= max) {
      return { complete: true, reason: `completed_before_send:CWL:${used}/${max}` };
    }
    return { complete: false, reason: null };
  }

  if (input.ruleType === UserActivityReminderType.RAIDS) {
    const max = Math.max(1, clampInt(input.snapshot.raidAttacksMax, 1, 6));
    const used = clampInt(input.snapshot.raidAttacksUsed, 0, max);
    if (used >= max) {
      return { complete: true, reason: `completed_before_send:RAIDS:${used}/${max}` };
    }
    return { complete: false, reason: null };
  }

  const points = Math.max(0, toFiniteIntOrNull(input.snapshot.gamesPoints) ?? 0);
  const target = Math.max(
    1,
    toFiniteIntOrNull(input.snapshot.gamesTarget) ?? DEFAULT_GAMES_COMPLETE_TARGET,
  );
  if (points >= target) {
    return {
      complete: true,
      reason: `completed_before_send:GAMES:${points}/${target}`,
    };
  }
  return { complete: false, reason: null };
}

/** Purpose: normalize optional text fields into deterministic display-safe values. */
function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}
