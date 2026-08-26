import { SyncCycleResolutionSource, type SyncCycle } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";

export const SYNC_CYCLE_SCHEDULE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type SyncCycleDb = {
  scheduledSyncPost?: {
    findFirst: (args: any) => Promise<{
      id: string;
      syncTime: Date;
    } | null>;
    findMany?: (args: any) => Promise<
      Array<{
        id: string;
        syncTime: Date;
        status?: string;
      }>
    >;
  };
  syncCycle?: {
    findUnique: (args: any) => Promise<SyncCycle | null>;
    findFirst?: (args: any) => Promise<SyncCycle | null>;
    findMany?: (args: any) => Promise<SyncCycle[]>;
    create: (args: any) => Promise<SyncCycle>;
  };
};

export type SyncCycleResolvedBindingInput = {
  guildId: string;
  syncNumber: number;
  syncTime: Date;
  scheduledSyncPostId: string;
  resolvedAt?: Date;
  resolutionSource?: SyncCycleResolutionSource;
};

export type SyncCyclePersistenceDb = {
  syncCycle: {
    findUnique: (args: any) => Promise<SyncCycle | null>;
    create: (args: any) => Promise<SyncCycle>;
  };
};

export type SyncCycleBindingInput = {
  guildId: string | null | undefined;
  syncNumber: number | null | undefined;
  matchType: string | null | undefined;
  preparationStartTime: Date | null | undefined;
};

export type ActiveSyncCycleResolution = {
  status: "exact" | "derived" | "unresolved" | "ambiguous" | "conflict";
  syncNumber: number | null;
  scheduledSyncPostId: string | null;
  syncTime: Date | null;
  previousSyncNumber: number | null;
  reason: string;
  resolutionSource: SyncCycleResolutionSource | null;
};

export type SyncCycleBindingResult =
  | { status: "created"; cycle: SyncCycle }
  | { status: "existing"; cycle: SyncCycle }
  | { status: "unmapped"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; error: unknown };

function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeMatchType(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeSyncNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as { code?: unknown }).code ?? "") === "P2002"
  );
}

function cycleIdentity(cycle: SyncCycle): string {
  return `guild_id=${cycle.guildId} sync_number=${cycle.syncNumber} sync_time=${cycle.syncTime.toISOString()}`;
}

/** Purpose: persist one already-resolved canonical schedule mapping with live-path uniqueness semantics. */
export async function persistResolvedSyncCycle(
  db: SyncCyclePersistenceDb,
  input: SyncCycleResolvedBindingInput,
): Promise<SyncCycleBindingResult> {
  const { guildId, syncNumber, syncTime, scheduledSyncPostId } = input;
  const resolvedAt = input.resolvedAt ?? new Date();
  const byNumberWhere = { guildId_syncNumber: { guildId, syncNumber } };
  const byTimeWhere = { guildId_syncTime: { guildId, syncTime } };
  let existingByNumber: SyncCycle | null;
  let existingByTime: SyncCycle | null;
  try {
    [existingByNumber, existingByTime] = await Promise.all([
      db.syncCycle.findUnique({ where: byNumberWhere }),
      db.syncCycle.findUnique({ where: byTimeWhere }),
    ]);
  } catch (error) {
    dozzleLog.warn(
      `[sync-cycle] event=read_existing outcome=failure guild_id=${guildId} sync_number=${syncNumber} sync_time=${syncTime.toISOString()} error=${formatError(error)}`,
    );
    return { status: "failed", reason: "sync_cycle_read_failed", error };
  }

  if (
    existingByNumber &&
    existingByNumber.syncTime.getTime() !== syncTime.getTime()
  ) {
    const reason = `sync_number_already_mapped existing_sync_time=${existingByNumber.syncTime.toISOString()} candidate_sync_time=${syncTime.toISOString()}`;
    dozzleLog.warn(
      `[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_number=${syncNumber} ${reason}`,
    );
    return { status: "conflict", reason };
  }
  if (existingByTime && existingByTime.syncNumber !== syncNumber) {
    const reason = `sync_time_already_mapped existing_sync_number=${existingByTime.syncNumber} candidate_sync_number=${syncNumber}`;
    dozzleLog.warn(
      `[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_time=${syncTime.toISOString()} ${reason}`,
    );
    return { status: "conflict", reason };
  }
  if (existingByNumber || existingByTime) {
    dozzleLog.debug(
      `[sync-cycle] event=bind outcome=idempotent ${cycleIdentity(existingByNumber ?? existingByTime!)}`,
    );
    return { status: "existing", cycle: existingByNumber ?? existingByTime! };
  }

  try {
    const cycle = await db.syncCycle.create({
      data: {
        guildId,
        syncNumber,
        syncTime,
        scheduledSyncPostId,
        resolvedAt,
        resolutionSource:
          input.resolutionSource ??
          SyncCycleResolutionSource.ENDED_WAR_CANONICAL,
      },
    });
    dozzleLog.info(
      `[sync-cycle] event=bind outcome=created ${cycleIdentity(cycle)} scheduled_sync_post_id=${scheduledSyncPostId}`,
    );
    return { status: "created", cycle };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      dozzleLog.warn(
        `[sync-cycle] event=bind outcome=failure guild_id=${guildId} sync_number=${syncNumber} sync_time=${syncTime.toISOString()} error=${formatError(error)}`,
      );
      return { status: "failed", reason: "sync_cycle_create_failed", error };
    }

    try {
      const [racedByNumber, racedByTime] = await Promise.all([
        db.syncCycle.findUnique({ where: byNumberWhere }),
        db.syncCycle.findUnique({ where: byTimeWhere }),
      ]);
      if (
        racedByNumber &&
        racedByNumber.syncTime.getTime() !== syncTime.getTime()
      ) {
        const reason = `sync_number_already_mapped existing_sync_time=${racedByNumber.syncTime.toISOString()} candidate_sync_time=${syncTime.toISOString()}`;
        dozzleLog.warn(
          `[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_number=${syncNumber} ${reason}`,
        );
        return { status: "conflict", reason };
      }
      if (racedByTime && racedByTime.syncNumber !== syncNumber) {
        const reason = `sync_time_already_mapped existing_sync_number=${racedByTime.syncNumber} candidate_sync_number=${syncNumber}`;
        dozzleLog.warn(
          `[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_time=${syncTime.toISOString()} ${reason}`,
        );
        return { status: "conflict", reason };
      }
      const cycle = racedByNumber ?? racedByTime;
      if (cycle) {
        dozzleLog.debug(
          `[sync-cycle] event=bind outcome=idempotent_after_race ${cycleIdentity(cycle)}`,
        );
        return { status: "existing", cycle };
      }
    } catch (readError) {
      dozzleLog.warn(
        `[sync-cycle] event=bind outcome=failure guild_id=${guildId} sync_number=${syncNumber} sync_time=${syncTime.toISOString()} error=${formatError(readError)}`,
      );
      return {
        status: "failed",
        reason: "sync_cycle_race_read_failed",
        error: readError,
      };
    }
    return {
      status: "failed",
      reason: "sync_cycle_unique_conflict_without_row",
      error,
    };
  }
}

/** Purpose: bind canonical ended-war sync identity to one exact scheduled sync boundary. */
export class SyncCycleService {
  constructor(
    private readonly db: SyncCycleDb = prisma as unknown as SyncCycleDb,
  ) {}

  /** Purpose: persist a caller-resolved canonical boundary while preserving SyncCycle uniqueness semantics. */
  async bindResolvedCanonical(
    input: SyncCycleResolvedBindingInput,
  ): Promise<SyncCycleBindingResult> {
    if (!this.db.syncCycle?.findUnique || !this.db.syncCycle?.create) {
      return {
        status: "failed",
        reason: "sync_cycle_database_unavailable",
        error: new Error("SyncCycle database delegates unavailable"),
      };
    }
    return persistResolvedSyncCycle({ syncCycle: this.db.syncCycle }, input);
  }

  /** Purpose: resolve the active war's canonical scheduled boundary from persisted schedule and cycle chronology. */
  async resolveActiveWarCycle(input: {
    guildId: string;
    preparationStartTime: Date | null | undefined;
    matchType: string | null | undefined;
    inferredMatchType?: boolean | null;
  }): Promise<ActiveSyncCycleResolution> {
    const guildId = normalizeGuildId(input.guildId);
    const preparationStartTime = input.preparationStartTime;
    const matchType = normalizeMatchType(input.matchType);
    const isFwa =
      matchType === "FWA" || (!matchType && input.inferredMatchType === true);
    if (!guildId || !isValidDate(preparationStartTime)) {
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "incomplete_active_identity",
        resolutionSource: null,
      };
    }
    if (!isFwa) {
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "fwa_evidence_unresolved",
        resolutionSource: null,
      };
    }
    if (
      !this.db.scheduledSyncPost?.findMany ||
      !this.db.syncCycle?.findUnique ||
      !this.db.syncCycle?.findFirst
    ) {
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "active_cycle_database_unavailable",
        resolutionSource: null,
      };
    }

    const lowerBound = new Date(
      preparationStartTime.getTime() - SYNC_CYCLE_SCHEDULE_LOOKBACK_MS,
    );
    let schedules: Array<{ id: string; syncTime: Date; status?: string }>;
    try {
      schedules = await this.db.scheduledSyncPost.findMany({
        where: {
          guildId,
          status: { notIn: ["CANCELLED", "REPLACED"] },
          syncTime: { gte: lowerBound, lte: preparationStartTime },
        },
        orderBy: { syncTime: "asc" },
        select: { id: true, syncTime: true, status: true },
      });
    } catch (error) {
      dozzleLog.warn(
        `[sync-cycle] event=active_resolve outcome=failure guild_id=${guildId} reason=schedule_read_failed error=${formatError(error)}`,
      );
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "schedule_read_failed",
        resolutionSource: null,
      };
    }
    const validSchedules = schedules.filter((row) => isValidDate(row.syncTime));
    if (validSchedules.length === 0) {
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "no_eligible_schedule",
        resolutionSource: null,
      };
    }

    // The latest eligible schedule is the live candidate. Earlier schedules
    // in the lookback window are normal chronology evidence for its previous
    // canonical cycle, not competing candidates for the current war.
    const schedule = validSchedules[validSchedules.length - 1];
    const laterScheduleRows = await this.db.scheduledSyncPost.findMany({
      where: {
        guildId,
        syncTime: { gt: schedule.syncTime, lte: preparationStartTime },
      },
      select: { id: true, syncTime: true, status: true },
      orderBy: { syncTime: "asc" },
    });
    const terminalLaterSchedules = laterScheduleRows.filter(
      (row) => row.status === "CANCELLED" || row.status === "REPLACED",
    );
    if (terminalLaterSchedules.length > 0) {
      dozzleLog.warn(
        `[sync-cycle] event=active_resolve outcome=unresolved guild_id=${guildId} reason=terminal_intervening_schedule schedule_count=${terminalLaterSchedules.length}`,
      );
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: null,
        syncTime: null,
        previousSyncNumber: null,
        reason: "terminal_intervening_schedule",
        resolutionSource: null,
      };
    }
    const exactCurrentCycle = await this.db.syncCycle.findUnique({
      where: { guildId_syncTime: { guildId, syncTime: schedule.syncTime } },
    });
    if (exactCurrentCycle) {
      return {
        status: "exact",
        syncNumber: exactCurrentCycle.syncNumber,
        scheduledSyncPostId: schedule.id,
        syncTime: schedule.syncTime,
        previousSyncNumber: null,
        reason: "exact_sync_cycle",
        resolutionSource: exactCurrentCycle.resolutionSource,
      };
    }
    const previous = await this.db.syncCycle.findFirst({
      where: {
        guildId,
        syncTime: { lt: schedule.syncTime },
      },
      orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
    });
    if (
      !previous ||
      !Number.isInteger(previous.syncNumber) ||
      previous.syncNumber <= 0
    ) {
      if (validSchedules.length > 1) {
        dozzleLog.warn(
          `[sync-cycle] event=active_resolve outcome=ambiguous guild_id=${guildId} reason=multiple_eligible_schedules schedule_count=${validSchedules.length}`,
        );
        return {
          status: "ambiguous",
          syncNumber: null,
          scheduledSyncPostId: schedule.id,
          syncTime: schedule.syncTime,
          previousSyncNumber: null,
          reason: "multiple_eligible_schedules",
          resolutionSource: null,
        };
      }
      return {
        status: "unresolved",
        syncNumber: null,
        scheduledSyncPostId: schedule.id,
        syncTime: schedule.syncTime,
        previousSyncNumber: null,
        reason: "no_previous_canonical_cycle",
        resolutionSource: null,
      };
    }

    const interveningSchedules = await this.db.scheduledSyncPost.findMany({
      where: {
        guildId,
        status: { notIn: ["CANCELLED", "REPLACED"] },
        syncTime: { gt: previous.syncTime, lt: schedule.syncTime },
      },
      select: { id: true, syncTime: true, status: true },
      orderBy: { syncTime: "asc" },
    });
    if (interveningSchedules.length > 0) {
      dozzleLog.warn(
        `[sync-cycle] event=active_resolve outcome=ambiguous guild_id=${guildId} reason=intervening_schedule schedule_count=${interveningSchedules.length}`,
      );
      return {
        status: "ambiguous",
        syncNumber: null,
        scheduledSyncPostId: schedule.id,
        syncTime: schedule.syncTime,
        previousSyncNumber: previous.syncNumber,
        reason: "intervening_schedule",
        resolutionSource: null,
      };
    }

    const syncNumber = previous.syncNumber + 1;
    const isConfirmedFwa =
      matchType === "FWA" && input.inferredMatchType === false;
    return {
      status: "derived",
      syncNumber,
      scheduledSyncPostId: schedule.id,
      syncTime: schedule.syncTime,
      previousSyncNumber: previous.syncNumber,
      reason: "previous_cycle_immediate_next_schedule",
      resolutionSource: isConfirmedFwa
        ? SyncCycleResolutionSource.ACTIVE_WAR_CONFIRMED
        : null,
    };
  }

  async bindFromEndedWar(
    input: SyncCycleBindingInput,
  ): Promise<SyncCycleBindingResult> {
    const guildId = normalizeGuildId(input.guildId);
    const syncNumber = normalizeSyncNumber(input.syncNumber);
    const matchType = normalizeMatchType(input.matchType);
    const preparationStartTime = input.preparationStartTime;

    if (!guildId || syncNumber === null || !isValidDate(preparationStartTime)) {
      return { status: "skipped", reason: "incomplete_canonical_identity" };
    }
    if (matchType !== "FWA") {
      return { status: "skipped", reason: "non_fwa_cycle" };
    }
    if (
      !this.db.scheduledSyncPost?.findFirst ||
      !this.db.syncCycle?.findUnique ||
      !this.db.syncCycle?.create
    ) {
      return {
        status: "failed",
        reason: "sync_cycle_database_unavailable",
        error: new Error("SyncCycle database delegates unavailable"),
      };
    }

    const syncTimeUpperBound = preparationStartTime;
    const syncTimeLowerBound = new Date(
      preparationStartTime.getTime() - SYNC_CYCLE_SCHEDULE_LOOKBACK_MS,
    );

    let schedule: { id: string; syncTime: Date } | null;
    try {
      schedule = await this.db.scheduledSyncPost.findFirst({
        where: {
          status: { notIn: ["CANCELLED", "REPLACED"] },
          guildId,
          syncTime: {
            lte: syncTimeUpperBound,
            gte: syncTimeLowerBound,
          },
        },
        orderBy: { syncTime: "desc" },
        select: { id: true, syncTime: true },
      });
    } catch (error) {
      dozzleLog.warn(
        `[sync-cycle] event=resolve_schedule outcome=failure guild_id=${guildId} sync_number=${syncNumber} preparation_start=${preparationStartTime.toISOString()} error=${formatError(error)}`,
      );
      return { status: "failed", reason: "schedule_read_failed", error };
    }

    if (!schedule || !isValidDate(schedule.syncTime)) {
      return { status: "unmapped", reason: "no_eligible_schedule" };
    }

    return this.bindResolvedCanonical({
      guildId,
      syncNumber,
      syncTime: schedule.syncTime,
      scheduledSyncPostId: schedule.id,
    });
  }
}
