import { ReminderDispatchStatus, ReminderTargetClanType, ReminderType } from "@prisma/client";
import { Client } from "discord.js";
import { formatError } from "../../helper/formatError";
import { prisma } from "../../prisma";
import { resolveCurrentCwlSeasonKey } from "../CwlRegistryService";
import { normalizeClanTag } from "../PlayerLinkService";
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
  clanType: ReminderTargetClanType;
  clanName: string | null;
  eventEndsAt: Date;
  eventIdentity: string;
  eventLabel: string;
};

type ReminderContextBundle = {
  warByClanTag: Map<string, ReminderEventContext>;
  cwlWarByClanTag: Map<string, ReminderEventContext>;
  raidByTargetKey: Map<string, ReminderEventContext>;
  gamesByTargetKey: Map<string, ReminderEventContext>;
  clanNameByTag: Map<string, string | null>;
};

type TimedTargetContextRow = {
  clanTag: string | null;
  clanName: string | null;
  cwlClanTag: string | null;
  cwlClanName: string | null;
  raidActive: boolean;
  raidEndsAt: Date | null;
  gamesActive: boolean;
  gamesEndsAt: Date | null;
  updatedAt: Date;
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
      const context = resolveContextForReminderType({
        reminderType: reminder.type,
        target,
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
          clanType: context.clanType,
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
  const previousTickMs = input.nowMs - Math.max(1, input.intervalMs);
  const crossedThisCycle = triggerAtMs > previousTickMs && triggerAtMs <= input.nowMs;
  const lateFireBeforeEnd = triggerAtMs <= previousTickMs;
  return crossedThisCycle || lateFireBeforeEnd;
}

/** Purpose: build deterministic dedupe key per reminder+clan+event identity+offset. */
function buildReminderDedupeKey(input: {
  reminderId: string;
  clanTag: string;
  clanType: ReminderTargetClanType;
  eventIdentity: string;
  offsetSeconds: number;
}): string {
  return `${input.reminderId}|${input.clanType}|${input.clanTag}|${input.eventIdentity}|${input.offsetSeconds}`;
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
  target: { clanTag: string; clanType: ReminderTargetClanType };
  contexts: ReminderContextBundle;
}): ReminderEventContext | null {
  if (input.reminderType === ReminderType.WAR_CWL) {
    if (input.target.clanType === ReminderTargetClanType.CWL) {
      return input.contexts.cwlWarByClanTag.get(input.target.clanTag) ?? null;
    }
    return input.contexts.warByClanTag.get(input.target.clanTag) ?? null;
  }

  if (input.reminderType === ReminderType.RAIDS) {
    return input.contexts.raidByTargetKey.get(buildTargetKey(input.target)) ?? null;
  }
  if (input.reminderType === ReminderType.GAMES) {
    return input.contexts.gamesByTargetKey.get(buildTargetKey(input.target)) ?? null;
  }

  // EVENT remains unimplemented in v1 until explicit stored event-timestamp semantics are added.
  if (input.reminderType === ReminderType.EVENT) {
    return null;
  }

  return null;
}

/** Purpose: assemble per-target reminder contexts for WAR/CWL + RAIDS/GAMES using persisted state only. */
async function resolveReminderContextBundle(input: {
  nowMs: number;
  reminders: ReminderSchedulerRow[];
}): Promise<ReminderContextBundle> {
  const clanTagSet = new Set(
    input.reminders.flatMap((reminder) => reminder.targetClans.map((target) => target.clanTag)),
  );
  const clanTags = [...clanTagSet];
  const warByClanTag = new Map<string, ReminderEventContext>();
  const cwlWarByClanTag = new Map<string, ReminderEventContext>();
  const raidByTargetKey = new Map<string, ReminderEventContext>();
  const gamesByTargetKey = new Map<string, ReminderEventContext>();
  const clanNameByTag = new Map<string, string | null>();
  if (clanTags.length <= 0) {
    return {
      warByClanTag,
      cwlWarByClanTag,
      raidByTargetKey,
      gamesByTargetKey,
      clanNameByTag,
    };
  }

  const season = resolveCurrentCwlSeasonKey(input.nowMs);
  const [warRows, cwlRows, timedRows, fwaNameRows, cwlNameRows] = await Promise.all([
    prisma.currentWar.findMany({
      where: {
        clanTag: { in: clanTags },
      },
      select: {
        clanTag: true,
        clanName: true,
        warId: true,
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
    prisma.todoPlayerSnapshot.findMany({
      where: {
        OR: [{ clanTag: { in: clanTags } }, { cwlClanTag: { in: clanTags } }],
      },
      select: {
        clanTag: true,
        clanName: true,
        cwlClanTag: true,
        cwlClanName: true,
        raidActive: true,
        raidEndsAt: true,
        gamesActive: true,
        gamesEndsAt: true,
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
    fwaNameRows
      .map((row) => [normalizeClanTag(row.tag), sanitizeDisplayText(row.name)] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );
  const cwlNameByTag = new Map(
    cwlNameRows
      .map((row) => [normalizeClanTag(row.tag), sanitizeDisplayText(row.name)] as const)
      .filter((entry): entry is [string, string | null] => Boolean(entry[0])),
  );
  const latestWarByTag = pickLatestWarByClanTag(warRows, input.nowMs);
  const latestCwlByTag = pickLatestCwlByClanTag(cwlRows, input.nowMs);

  for (const clanTag of clanTags) {
    clanNameByTag.set(
      clanTag,
      cwlNameByTag.get(clanTag) ?? fwaNameByTag.get(clanTag) ?? null,
    );
    const war = latestWarByTag.get(clanTag) ?? null;
    const cwl = latestCwlByTag.get(clanTag) ?? null;
    if (war) {
      warByClanTag.set(clanTag, {
        clanTag,
        clanType: ReminderTargetClanType.FWA,
        clanName: sanitizeDisplayText(war.clanName) ?? fwaNameByTag.get(clanTag) ?? null,
        eventEndsAt: war.warEndsAt,
        eventIdentity: `WAR:${war.warIdentity}`,
        eventLabel: "war end",
      });
    }
    if (cwl) {
      cwlWarByClanTag.set(clanTag, {
        clanTag,
        clanType: ReminderTargetClanType.CWL,
        clanName: sanitizeDisplayText(cwl.cwlClanName) ?? cwlNameByTag.get(clanTag) ?? null,
        eventEndsAt: cwl.warEndsAt,
        eventIdentity: `CWL:${cwl.warIdentity}`,
        eventLabel: "cwl war end",
      });
    }
  }

  const latestRaidByTargetKey = new Map<string, { context: ReminderEventContext; updatedAtMs: number }>();
  const latestGamesByTargetKey = new Map<string, { context: ReminderEventContext; updatedAtMs: number }>();
  for (const row of timedRows) {
    ingestTimedTargetContexts({
      nowMs: input.nowMs,
      row,
      clanTagSet,
      clanNameByTag,
      latestByTargetKey: latestRaidByTargetKey,
      eventType: "RAIDS",
      isActive: row.raidActive,
      eventEndsAt: row.raidEndsAt,
      eventLabel: "raid weekend",
    });
    ingestTimedTargetContexts({
      nowMs: input.nowMs,
      row,
      clanTagSet,
      clanNameByTag,
      latestByTargetKey: latestGamesByTargetKey,
      eventType: "GAMES",
      isActive: row.gamesActive,
      eventEndsAt: row.gamesEndsAt,
      eventLabel: "clan games",
    });
  }

  for (const [targetKey, payload] of latestRaidByTargetKey.entries()) {
    raidByTargetKey.set(targetKey, payload.context);
  }
  for (const [targetKey, payload] of latestGamesByTargetKey.entries()) {
    gamesByTargetKey.set(targetKey, payload.context);
  }

  return {
    warByClanTag,
    cwlWarByClanTag,
    raidByTargetKey,
    gamesByTargetKey,
    clanNameByTag,
  };
}

/** Purpose: keep latest active-war-end context per clan from CurrentWar rows. */
function pickLatestWarByClanTag(
  rows: Array<{
    clanTag: string;
    clanName: string | null;
    warId: number | null;
    state: string | null;
    startTime: Date | null;
    endTime: Date | null;
    updatedAt: Date;
  }>,
  nowMs: number,
): Map<
  string,
  {
    clanName: string | null;
    warIdentity: string;
    warEndsAt: Date;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      clanName: string | null;
      warIdentity: string;
      warEndsAt: Date;
      updatedAt: Date;
    }
  >();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag || !isActiveWarState(row.state) || !row.endTime) continue;
    if (row.endTime.getTime() <= nowMs) continue;
    const warIdentity =
      Number.isFinite(row.warId) && Number(row.warId) > 0
        ? `war-id:${Number(row.warId)}`
        : `derived:${clanTag}:${row.startTime?.getTime() ?? 0}:${row.endTime.getTime()}`;

    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        clanName: row.clanName,
        warIdentity,
        warEndsAt: row.endTime,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep latest active-CWL war-end context per clan from snapshot rows. */
function pickLatestCwlByClanTag(
  rows: Array<{
    cwlClanTag: string | null;
    cwlClanName: string | null;
    cwlPhase: string | null;
    cwlEndsAt: Date | null;
    updatedAt: Date;
  }>,
  nowMs: number,
): Map<
  string,
  {
    cwlClanName: string | null;
    warIdentity: string;
    warEndsAt: Date;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      cwlClanName: string | null;
      warIdentity: string;
      warEndsAt: Date;
      updatedAt: Date;
    }
  >();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.cwlClanTag ?? "");
    const phaseEndsAt = row.cwlEndsAt;
    if (!clanTag || !phaseEndsAt) continue;
    const normalizedPhase = String(row.cwlPhase ?? "").toLowerCase();
    const warEndsAt = normalizedPhase.includes("preparation")
      ? new Date(phaseEndsAt.getTime() + 24 * 60 * 60 * 1000)
      : phaseEndsAt;
    if (warEndsAt.getTime() <= nowMs) continue;
    const warIdentity = `${clanTag}:${warEndsAt.getTime()}`;
    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        cwlClanName: row.cwlClanName,
        warIdentity,
        warEndsAt,
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

/** Purpose: normalize reminder target identity into a deterministic map key. */
function buildTargetKey(input: {
  clanTag: string;
  clanType: ReminderTargetClanType;
}): string {
  return `${input.clanType}|${input.clanTag}`;
}

/** Purpose: classify persisted war-state values into active/non-active buckets. */
function isActiveWarState(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

/** Purpose: ingest one snapshot row into per-target timed event maps for RAIDS/GAMES semantics. */
function ingestTimedTargetContexts(input: {
  nowMs: number;
  row: TimedTargetContextRow;
  clanTagSet: Set<string>;
  clanNameByTag: Map<string, string | null>;
  latestByTargetKey: Map<string, { context: ReminderEventContext; updatedAtMs: number }>;
  eventType: "RAIDS" | "GAMES";
  isActive: boolean;
  eventEndsAt: Date | null;
  eventLabel: string;
}): void {
  if (!input.isActive || !input.eventEndsAt) return;
  if (input.eventEndsAt.getTime() <= input.nowMs) return;

  const upsert = (target: {
    clanTag: string;
    clanType: ReminderTargetClanType;
    clanName: string | null;
  }) => {
    if (!input.clanTagSet.has(target.clanTag)) return;
    const targetKey = buildTargetKey({
      clanTag: target.clanTag,
      clanType: target.clanType,
    });
    const nextContext: ReminderEventContext = {
      clanTag: target.clanTag,
      clanType: target.clanType,
      clanName: target.clanName,
      eventEndsAt: input.eventEndsAt!,
      eventIdentity: `${input.eventType}:${targetKey}:${input.eventEndsAt!.getTime()}`,
      eventLabel: input.eventLabel,
    };
    const nextUpdatedAtMs = input.row.updatedAt.getTime();
    const existing = input.latestByTargetKey.get(targetKey);
    if (!existing || nextUpdatedAtMs >= existing.updatedAtMs) {
      input.latestByTargetKey.set(targetKey, {
        context: nextContext,
        updatedAtMs: nextUpdatedAtMs,
      });
    }
  };

  const fwaClanTag = normalizeClanTag(input.row.clanTag ?? "");
  const fwaClanName = sanitizeDisplayText(input.row.clanName) ?? null;
  if (fwaClanTag) {
    input.clanNameByTag.set(fwaClanTag, input.clanNameByTag.get(fwaClanTag) ?? fwaClanName);
    upsert({
      clanTag: fwaClanTag,
      clanType: ReminderTargetClanType.FWA,
      clanName: fwaClanName,
    });
  }

  const cwlClanTag = normalizeClanTag(input.row.cwlClanTag ?? "");
  const cwlClanName = sanitizeDisplayText(input.row.cwlClanName) ?? null;
  if (cwlClanTag) {
    input.clanNameByTag.set(cwlClanTag, input.clanNameByTag.get(cwlClanTag) ?? cwlClanName);
    upsert({
      clanTag: cwlClanTag,
      clanType: ReminderTargetClanType.CWL,
      clanName: cwlClanName,
    });
  }
}
