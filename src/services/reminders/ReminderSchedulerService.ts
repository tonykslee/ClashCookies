import { ReminderDispatchStatus, ReminderTargetClanType, ReminderType } from "@prisma/client";
import { Client } from "discord.js";
import { formatError } from "../../helper/formatError";
import { prisma } from "../../prisma";
import { resolveCurrentCwlSeasonKey } from "../CwlRegistryService";
import { reminderDispatchService, type ReminderDispatchService } from "./ReminderDispatchService";

const DEFAULT_REMINDER_SCHEDULER_INTERVAL_MS = 60 * 1000;

type ReminderSchedulerRow = {
  id: string;
  guildId: string;
  channelId: string;
  type: ReminderType;
  isEnabled: boolean;
  times: Array<{ offsetSeconds: number }>;
  targetClans: Array<{ clanTag: string; clanType: ReminderTargetClanType }>;
};

type ReminderEventContext = {
  clanTag: string;
  clanName: string | null;
  eventEndsAt: Date;
  eventIdentity: string;
  eventLabel: string;
};

type ReminderWindow = {
  active: boolean;
  startMs: number;
  endMs: number;
};

type ReminderContextBundle = {
  byClan: Map<string, { war: ReminderEventContext | null; cwl: ReminderEventContext | null }>;
  clanNameByTag: Map<string, string | null>;
  raidWindow: ReminderWindow;
  gamesWindow: ReminderWindow;
  eventWindow: ReminderWindow;
};

type ReminderSchedulerCounts = {
  evaluated: number;
  fired: number;
  deduped: number;
  failed: number;
};

/** Purpose: evaluate and dispatch due reminder triggers on a bounded interval loop. */
export class ReminderSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** Purpose: initialize reminder scheduler dependencies with safe defaults. */
  constructor(
    private readonly client: Client,
    private readonly dispatch: ReminderDispatchService = reminderDispatchService,
    private readonly intervalMs: number = DEFAULT_REMINDER_SCHEDULER_INTERVAL_MS,
  ) {}

  /** Purpose: start one immediate cycle and register periodic scheduler runs. */
  start(): void {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
    console.log(`[reminders] scheduler started interval_ms=${this.intervalMs}`);
  }

  /** Purpose: stop periodic reminder scheduling for process shutdown or tests. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Purpose: run one deduped reminder scheduling pass while guarding against overlap. */
  async runCycle(nowMs: number = Date.now()): Promise<ReminderSchedulerCounts> {
    if (this.inFlight) {
      console.log("[reminders] scheduler skipped reason=in_flight");
      return {
        evaluated: 0,
        fired: 0,
        deduped: 0,
        failed: 0,
      };
    }
    this.inFlight = true;
    try {
      const counts = await runReminderSchedulerCycle({
        client: this.client,
        dispatch: this.dispatch,
        nowMs,
        intervalMs: this.intervalMs,
      });
      console.log(
        `[reminders] scheduler evaluated=${counts.evaluated} fired=${counts.fired} deduped=${counts.deduped} failed=${counts.failed}`,
      );
      return counts;
    } finally {
      this.inFlight = false;
    }
  }
}

/** Purpose: execute one scheduler cycle for enabled reminders, trigger resolution, dedupe, and dispatch. */
export async function runReminderSchedulerCycle(input: {
  client: Client;
  dispatch: ReminderDispatchService;
  nowMs?: number;
  intervalMs?: number;
}): Promise<ReminderSchedulerCounts> {
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const intervalMs = Number.isFinite(input.intervalMs)
    ? Math.max(1, Number(input.intervalMs))
    : DEFAULT_REMINDER_SCHEDULER_INTERVAL_MS;

  const reminders = await prisma.reminder.findMany({
    where: {
      isEnabled: true,
    },
    include: {
      times: {
        select: { offsetSeconds: true },
      },
      targetClans: {
        select: { clanTag: true, clanType: true },
      },
    },
  });

  if (reminders.length <= 0) {
    return { evaluated: 0, fired: 0, deduped: 0, failed: 0 };
  }

  const schedulerRows: ReminderSchedulerRow[] = reminders.map((row) => ({
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    type: row.type,
    isEnabled: row.isEnabled,
    times: row.times,
    targetClans: row.targetClans,
  }));
  const contextBundle = await resolveReminderContextBundle({
    nowMs,
    reminders: schedulerRows,
  });

  let evaluated = 0;
  let fired = 0;
  let deduped = 0;
  let failed = 0;

  for (const reminder of schedulerRows) {
    for (const target of reminder.targetClans) {
      const normalizedTag = target.clanTag;
      const context = resolveContextForReminderType({
        reminderType: reminder.type,
        clanTag: normalizedTag,
        contexts: contextBundle,
      });
      if (!context) continue;

      for (const offset of reminder.times) {
        const offsetSeconds = Math.max(1, Math.trunc(Number(offset.offsetSeconds)));
        evaluated += 1;
        if (
          !shouldReminderOffsetFire({
            nowMs,
            intervalMs,
            eventEndsAtMs: context.eventEndsAt.getTime(),
            offsetSeconds,
          })
        ) {
          continue;
        }

        const dedupeKey = buildReminderDedupeKey({
          reminderId: reminder.id,
          clanTag: context.clanTag,
          eventIdentity: context.eventIdentity,
          offsetSeconds,
        });
        const fireLog = await createReminderFireLogIfFirst({
          dedupeKey,
          reminder,
          context,
          offsetSeconds,
        });
        if (!fireLog.created) {
          deduped += 1;
          console.log(
            `[reminders] deduped reminder_id=${reminder.id} clan=${context.clanTag} offset_s=${offsetSeconds} identity=${context.eventIdentity}`,
          );
          continue;
        }

        const dispatchResult = await input.dispatch.dispatchReminder(input.client, {
          guildId: reminder.guildId,
          channelId: reminder.channelId,
          reminderId: reminder.id,
          type: reminder.type,
          clanTag: context.clanTag,
          clanName: context.clanName,
          offsetSeconds,
          eventIdentity: context.eventIdentity,
          eventEndsAt: context.eventEndsAt,
          eventLabel: context.eventLabel,
        });
        if (dispatchResult.status === "sent") {
          fired += 1;
          await prisma.reminderFireLog.update({
            where: { id: fireLog.id },
            data: {
              dispatchStatus: ReminderDispatchStatus.SENT,
              messageId: dispatchResult.messageId,
            },
          });
          console.log(
            `[reminders] fired reminder_id=${reminder.id} clan=${context.clanTag} offset_s=${offsetSeconds} identity=${context.eventIdentity} message_id=${dispatchResult.messageId}`,
          );
          continue;
        }

        failed += 1;
        await prisma.reminderFireLog.update({
          where: { id: fireLog.id },
          data: {
            dispatchStatus: ReminderDispatchStatus.FAILED,
            errorMessage: dispatchResult.errorMessage.slice(0, 500),
          },
        });
        console.error(
          `[reminders] dispatch_failed reminder_id=${reminder.id} clan=${context.clanTag} offset_s=${offsetSeconds} identity=${context.eventIdentity} error=${dispatchResult.errorMessage}`,
        );
      }
    }
  }

  return { evaluated, fired, deduped, failed };
}

/** Purpose: expose trigger-window evaluation for isolated scheduler unit tests. */
export const shouldReminderOffsetFireForTest = shouldReminderOffsetFire;
/** Purpose: expose reminder event-context resolution for isolated scheduler unit tests. */
export const resolveReminderContextBundleForTest = resolveReminderContextBundle;

/** Purpose: detect whether one reminder offset is currently due for firing before event end. */
function shouldReminderOffsetFire(input: {
  nowMs: number;
  intervalMs: number;
  eventEndsAtMs: number;
  offsetSeconds: number;
}): boolean {
  const offsetMs = Math.max(1, Math.trunc(input.offsetSeconds)) * 1000;
  const triggerAtMs = input.eventEndsAtMs - offsetMs;
  if (!Number.isFinite(triggerAtMs)) return false;
  if (input.nowMs >= input.eventEndsAtMs) return false;
  if (input.nowMs < triggerAtMs) return false;
  return true;
}

/** Purpose: build deterministic dedupe key per reminder+clan+event identity+offset. */
function buildReminderDedupeKey(input: {
  reminderId: string;
  clanTag: string;
  eventIdentity: string;
  offsetSeconds: number;
}): string {
  return `${input.reminderId}|${input.clanTag}|${input.eventIdentity}|${input.offsetSeconds}`;
}

/** Purpose: write one reminder fire-log row if unique key not seen, returning dedupe outcome. */
async function createReminderFireLogIfFirst(input: {
  dedupeKey: string;
  reminder: ReminderSchedulerRow;
  context: ReminderEventContext;
  offsetSeconds: number;
}): Promise<{ created: true; id: string } | { created: false }> {
  try {
    const created = await prisma.reminderFireLog.create({
      data: {
        reminderId: input.reminder.id,
        guildId: input.reminder.guildId,
        clanTag: input.context.clanTag,
        reminderType: input.reminder.type,
        offsetSeconds: input.offsetSeconds,
        eventIdentity: input.context.eventIdentity,
        dedupeKey: input.dedupeKey,
        channelId: input.reminder.channelId,
      },
      select: { id: true },
    });
    return { created: true, id: created.id };
  } catch (error) {
    const code = (error as { code?: string } | null | undefined)?.code ?? "";
    if (code === "P2002") {
      return { created: false };
    }
    console.error(`[reminders] firelog_create_failed error=${formatError(error)}`);
    return { created: false };
  }
}

/** Purpose: choose one applicable context for a clan-target based on reminder type semantics. */
function resolveContextForReminderType(input: {
  reminderType: ReminderType;
  clanTag: string;
  contexts: ReminderContextBundle;
}): ReminderEventContext | null {
  const byClan = input.contexts.byClan.get(input.clanTag);
  if (input.reminderType === ReminderType.WAR_CWL) {
    if (byClan?.cwl) return byClan.cwl;
    if (byClan?.war) return byClan.war;
    return null;
  }

  const clanName = input.contexts.clanNameByTag.get(input.clanTag) ?? null;
  if (input.reminderType === ReminderType.RAIDS) {
    if (!input.contexts.raidWindow.active) return null;
    return {
      clanTag: input.clanTag,
      clanName,
      eventEndsAt: new Date(input.contexts.raidWindow.endMs),
      eventIdentity: `RAIDS:${input.contexts.raidWindow.startMs}:${input.contexts.raidWindow.endMs}`,
      eventLabel: "raid weekend",
    };
  }
  if (input.reminderType === ReminderType.GAMES) {
    if (!input.contexts.gamesWindow.active) return null;
    return {
      clanTag: input.clanTag,
      clanName,
      eventEndsAt: new Date(input.contexts.gamesWindow.endMs),
      eventIdentity: `GAMES:${input.contexts.gamesWindow.startMs}:${input.contexts.gamesWindow.endMs}`,
      eventLabel: "clan games",
    };
  }
  if (!input.contexts.eventWindow.active) return null;
  return {
    clanTag: input.clanTag,
    clanName,
    eventEndsAt: new Date(input.contexts.eventWindow.endMs),
    eventIdentity: `EVENT:${input.contexts.eventWindow.startMs}:${input.contexts.eventWindow.endMs}`,
    eventLabel: "season event",
  };
}

/** Purpose: assemble per-clan reminder event contexts for WAR/CWL plus shared RAIDS/GAMES/EVENT windows. */
async function resolveReminderContextBundle(input: {
  nowMs: number;
  reminders: ReminderSchedulerRow[];
}): Promise<ReminderContextBundle> {
  const clanTags = [
    ...new Set(
      input.reminders.flatMap((reminder) =>
        reminder.targetClans.map((target) => target.clanTag),
      ),
    ),
  ];
  const byClan = new Map<string, { war: ReminderEventContext | null; cwl: ReminderEventContext | null }>();
  const clanNameByTag = new Map<string, string | null>();
  const raidWindow = resolveRaidWeekendWindow(input.nowMs);
  const gamesWindow = resolveClanGamesWindow(input.nowMs);
  const eventWindow = resolveSeasonEventWindow(input.nowMs);
  if (clanTags.length <= 0) {
    return {
      byClan,
      clanNameByTag,
      raidWindow,
      gamesWindow,
      eventWindow,
    };
  }

  const season = resolveCurrentCwlSeasonKey(input.nowMs);
  const [warRows, cwlRows, fwaNameRows, cwlNameRows] = await Promise.all([
    prisma.currentWar.findMany({
      where: {
        clanTag: { in: clanTags },
      },
      select: {
        clanTag: true,
        clanName: true,
        state: true,
        startTime: true,
        endTime: true,
        updatedAt: true,
      },
    }),
    prisma.todoPlayerSnapshot.findMany({
      where: {
        cwlActive: true,
        cwlClanTag: { in: clanTags },
      },
      select: {
        cwlClanTag: true,
        cwlClanName: true,
        cwlPhase: true,
        cwlEndsAt: true,
        updatedAt: true,
      },
    }),
    prisma.trackedClan.findMany({
      where: { tag: { in: clanTags } },
      select: { tag: true, name: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: {
        season,
        tag: { in: clanTags },
      },
      select: { tag: true, name: true },
    }),
  ]);

  const fwaNameByTag = new Map(
    fwaNameRows.map((row) => [row.tag, sanitizeDisplayText(row.name)] as const),
  );
  const cwlNameByTag = new Map(
    cwlNameRows.map((row) => [row.tag, sanitizeDisplayText(row.name)] as const),
  );
  const latestWarByTag = pickLatestWarByClanTag(warRows);
  const latestCwlByTag = pickLatestCwlByClanTag(cwlRows);

  for (const clanTag of clanTags) {
    clanNameByTag.set(
      clanTag,
      cwlNameByTag.get(clanTag) ?? fwaNameByTag.get(clanTag) ?? null,
    );
    const war = latestWarByTag.get(clanTag) ?? null;
    const cwl = latestCwlByTag.get(clanTag) ?? null;
    byClan.set(clanTag, {
      war: war
        ? {
            clanTag,
            clanName: sanitizeDisplayText(war.clanName) ?? fwaNameByTag.get(clanTag) ?? null,
            eventEndsAt: war.phaseEndsAt,
            eventIdentity: `WAR:${clanTag}:${war.phase}:${war.phaseEndsAt.getTime()}`,
            eventLabel: `war ${war.phase}`,
          }
        : null,
      cwl: cwl
        ? {
            clanTag,
            clanName: sanitizeDisplayText(cwl.cwlClanName) ?? cwlNameByTag.get(clanTag) ?? null,
            eventEndsAt: cwl.phaseEndsAt,
            eventIdentity: `CWL:${clanTag}:${cwl.phase}:${cwl.phaseEndsAt.getTime()}`,
            eventLabel: `cwl ${cwl.phase}`,
          }
        : null,
    });
  }

  return {
    byClan,
    clanNameByTag,
    raidWindow,
    gamesWindow,
    eventWindow,
  };
}

/** Purpose: keep latest active-war phase context per clan from CurrentWar rows. */
function pickLatestWarByClanTag(
  rows: Array<{
    clanTag: string;
    clanName: string | null;
    state: string | null;
    startTime: Date | null;
    endTime: Date | null;
    updatedAt: Date;
  }>,
): Map<
  string,
  {
    clanName: string | null;
    phase: string;
    phaseEndsAt: Date;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      clanName: string | null;
      phase: string;
      phaseEndsAt: Date;
      updatedAt: Date;
    }
  >();
  for (const row of rows) {
    const normalizedState = String(row.state ?? "").toLowerCase();
    const phase = normalizedState.includes("preparation")
      ? "preparation"
      : normalizedState.includes("inwar")
        ? "battle day"
        : "";
    const phaseEndsAt =
      phase === "preparation"
        ? row.startTime
        : phase === "battle day"
          ? row.endTime
          : null;
    if (!phase || !phaseEndsAt) continue;

    const existing = latest.get(row.clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(row.clanTag, {
        clanName: row.clanName,
        phase,
        phaseEndsAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep latest active-CWL phase context per clan from snapshot rows. */
function pickLatestCwlByClanTag(
  rows: Array<{
    cwlClanTag: string | null;
    cwlClanName: string | null;
    cwlPhase: string | null;
    cwlEndsAt: Date | null;
    updatedAt: Date;
  }>,
): Map<
  string,
  {
    cwlClanName: string | null;
    phase: string;
    phaseEndsAt: Date;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      cwlClanName: string | null;
      phase: string;
      phaseEndsAt: Date;
      updatedAt: Date;
    }
  >();
  for (const row of rows) {
    const clanTag = String(row.cwlClanTag ?? "").trim();
    const phaseEndsAt = row.cwlEndsAt;
    const phase = sanitizeDisplayText(row.cwlPhase) ?? "active phase";
    if (!clanTag || !phaseEndsAt) continue;
    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        cwlClanName: row.cwlClanName,
        phase,
        phaseEndsAt,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: normalize display text into compact deterministic labels. */
function sanitizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Purpose: compute current/next raid weekend window boundaries using UTC-safe math. */
function resolveRaidWeekendWindow(nowMs: number): ReminderWindow {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const now = new Date(nowMs);
  const dayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const weekStartMs = dayStartMs - now.getUTCDay() * dayMs;
  const fridayStartMs = weekStartMs + 5 * dayMs + 7 * hourMs;
  const raidEndMs = fridayStartMs + 3 * dayMs;
  if (nowMs >= fridayStartMs && nowMs < raidEndMs) {
    return { active: true, startMs: fridayStartMs, endMs: raidEndMs };
  }
  if (nowMs < fridayStartMs) {
    return { active: false, startMs: fridayStartMs, endMs: raidEndMs };
  }
  const nextStartMs = fridayStartMs + 7 * dayMs;
  return { active: false, startMs: nextStartMs, endMs: nextStartMs + 3 * dayMs };
}

/** Purpose: compute current/next clan-games window boundaries in UTC. */
function resolveClanGamesWindow(nowMs: number): ReminderWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const currentStartMs = Date.UTC(year, month, 22, 8, 0, 0, 0);
  const currentEndMs = Date.UTC(year, month, 28, 8, 0, 0, 0);
  if (nowMs >= currentStartMs && nowMs < currentEndMs) {
    return { active: true, startMs: currentStartMs, endMs: currentEndMs };
  }
  if (nowMs < currentStartMs) {
    return { active: false, startMs: currentStartMs, endMs: currentEndMs };
  }
  const nextStartMs = Date.UTC(year, month + 1, 22, 8, 0, 0, 0);
  const nextEndMs = Date.UTC(year, month + 1, 28, 8, 0, 0, 0);
  return { active: false, startMs: nextStartMs, endMs: nextEndMs };
}

/** Purpose: provide bounded EVENT window semantics as current UTC month -> next month rollover. */
function resolveSeasonEventWindow(nowMs: number): ReminderWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
  const endMs = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  return {
    active: nowMs >= startMs && nowMs < endMs,
    startMs,
    endMs,
  };
}
