import { SyncCycleResolutionSource, type SyncCycle } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";

export const SYNC_CYCLE_SCHEDULE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type SyncCycleDb = {
  scheduledSyncPost?: {
    findFirst: (args: any) => Promise<{
      id: string;
      syncTime: Date;
    } | null>;
  };
  syncCycle?: {
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
  return String(value ?? "").trim().toUpperCase();
}

function normalizeSyncNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    String((error as { code?: unknown }).code ?? "") === "P2002";
}

function cycleIdentity(cycle: SyncCycle): string {
  return `guild_id=${cycle.guildId} sync_number=${cycle.syncNumber} sync_time=${cycle.syncTime.toISOString()}`;
}

/** Purpose: bind canonical ended-war sync identity to one exact scheduled sync boundary. */
export class SyncCycleService {
  constructor(private readonly db: SyncCycleDb = prisma as unknown as SyncCycleDb) {}

  async bindFromEndedWar(input: SyncCycleBindingInput): Promise<SyncCycleBindingResult> {
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
    if (!this.db.scheduledSyncPost?.findFirst || !this.db.syncCycle?.findUnique || !this.db.syncCycle?.create) {
      return { status: "failed", reason: "sync_cycle_database_unavailable", error: new Error("SyncCycle database delegates unavailable") };
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

    const syncTime = schedule.syncTime;
    const byNumberWhere = { guildId_syncNumber: { guildId, syncNumber } };
    const byTimeWhere = { guildId_syncTime: { guildId, syncTime } };
    let existingByNumber: SyncCycle | null;
    let existingByTime: SyncCycle | null;
    try {
      [existingByNumber, existingByTime] = await Promise.all([
        this.db.syncCycle.findUnique({ where: byNumberWhere }),
        this.db.syncCycle.findUnique({ where: byTimeWhere }),
      ]);
    } catch (error) {
      dozzleLog.warn(
        `[sync-cycle] event=read_existing outcome=failure guild_id=${guildId} sync_number=${syncNumber} sync_time=${syncTime.toISOString()} error=${formatError(error)}`,
      );
      return { status: "failed", reason: "sync_cycle_read_failed", error };
    }

    if (existingByNumber && existingByNumber.syncTime.getTime() !== syncTime.getTime()) {
      const reason = `sync_number_already_mapped existing_sync_time=${existingByNumber.syncTime.toISOString()} candidate_sync_time=${syncTime.toISOString()}`;
      dozzleLog.warn(`[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_number=${syncNumber} ${reason}`);
      return { status: "conflict", reason };
    }
    if (existingByTime && existingByTime.syncNumber !== syncNumber) {
      const reason = `sync_time_already_mapped existing_sync_number=${existingByTime.syncNumber} candidate_sync_number=${syncNumber}`;
      dozzleLog.warn(`[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_time=${syncTime.toISOString()} ${reason}`);
      return { status: "conflict", reason };
    }
    if (existingByNumber || existingByTime) {
      dozzleLog.debug(
        `[sync-cycle] event=bind outcome=idempotent ${cycleIdentity(existingByNumber ?? existingByTime!)}`,
      );
      return { status: "existing", cycle: existingByNumber ?? existingByTime! };
    }

    try {
      const cycle = await this.db.syncCycle.create({
        data: {
          guildId,
          syncNumber,
          syncTime,
          scheduledSyncPostId: schedule.id,
          resolvedAt: new Date(),
          resolutionSource: SyncCycleResolutionSource.ENDED_WAR_CANONICAL,
        },
      });
      dozzleLog.info(
        `[sync-cycle] event=bind outcome=created ${cycleIdentity(cycle)} scheduled_sync_post_id=${schedule.id}`,
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
          this.db.syncCycle.findUnique({ where: byNumberWhere }),
          this.db.syncCycle.findUnique({ where: byTimeWhere }),
        ]);
        if (racedByNumber && racedByNumber.syncTime.getTime() !== syncTime.getTime()) {
          const reason = `sync_number_already_mapped existing_sync_time=${racedByNumber.syncTime.toISOString()} candidate_sync_time=${syncTime.toISOString()}`;
          dozzleLog.warn(`[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_number=${syncNumber} ${reason}`);
          return { status: "conflict", reason };
        }
        if (racedByTime && racedByTime.syncNumber !== syncNumber) {
          const reason = `sync_time_already_mapped existing_sync_number=${racedByTime.syncNumber} candidate_sync_number=${syncNumber}`;
          dozzleLog.warn(`[sync-cycle] event=bind outcome=conflict guild_id=${guildId} sync_time=${syncTime.toISOString()} ${reason}`);
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
        return { status: "failed", reason: "sync_cycle_race_read_failed", error: readError };
      }
      return { status: "failed", reason: "sync_cycle_unique_conflict_without_row", error };
    }
  }
}
