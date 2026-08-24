import { describe, expect, it, vi } from "vitest";
import {
  applyHistoricalSyncReconciliationPlan,
  buildHistoricalSyncReconciliationWriterPlan,
  parseHistoricalSyncReconciliationWriterArgs,
  runHistoricalSyncReconciliationWriter,
} from "../src/scripts/backfillHistoricalSyncReconciliation";

const guildId = "guild-writer";
const base = new Date("2026-08-05T12:00:00.000Z");
const at = (days: number, hours = 0) => new Date(base.getTime() + (days * 24 + hours) * 3600000);

function makeDb(options: { missingScheduleId?: string; cancelledScheduleId?: string; fullRange?: boolean } = {}) {
  const fullRange = options.fullRange === true;
  const cycles: any[] = (fullRange
    ? [520, 522, 523, 524, 525, 526, 548]
    : [543, 548]
  ).map((syncNumber) => ({
    guildId,
    syncNumber,
    syncTime: fullRange
      ? at(syncNumber === 548 ? 28 : syncNumber - 520)
      : syncNumber === 543 ? base : at(10),
    resolutionSource: "ENDED_WAR_CANONICAL",
  }));
  const scheduleNumbers = fullRange
    ? [521, ...Array.from({ length: 17 }, (_unused, index) => index + 527), 545, 546, 547]
    : [545, 546, 547];
  const schedules: any[] = scheduleNumbers.map((syncNumber) => ({
    id: `s-${syncNumber}`,
    guildId,
    syncTime: fullRange
      ? at(syncNumber - 520, 2)
      : at(syncNumber === 545 ? 4 : syncNumber === 546 ? 6 : 8, syncNumber === 545 ? 2 : syncNumber === 546 ? 4 : 6),
    status: "PUBLISHED",
  })).filter((row) => row.id !== options.missingScheduleId)
    .map((row) => row.id === options.cancelledScheduleId ? { ...row, status: "CANCELLED" } : row);
  const simpleHistories = [
    { warId: 5440, syncNumber: 544, clanTag: "#C544", opponentTag: "#O544", prepStartTime: at(2), warStartTime: at(2, 4), warEndTime: at(2, 8) },
    { warId: 5450, syncNumber: 545, clanTag: "#C545", opponentTag: "#O545", prepStartTime: at(4, 4), warStartTime: at(4, 8), warEndTime: at(4, 12) },
    { warId: 5460, syncNumber: 546, clanTag: "#C546", opponentTag: "#O546", prepStartTime: at(6, 6), warStartTime: at(6, 10), warEndTime: at(6, 14) },
    { warId: 5470, syncNumber: 547, clanTag: "#C547", opponentTag: "#O547", prepStartTime: at(8, 8), warStartTime: at(8, 12), warEndTime: at(8, 16) },
  ];
  const fullHistories = [521, ...Array.from({ length: 21 }, (_unused, index) => index + 527)].map((syncNumber) => ({
    warId: syncNumber * 10,
    syncNumber,
    clanTag: `#C${syncNumber}`,
    opponentTag: `#O${syncNumber}`,
    prepStartTime: at(syncNumber - 520, 4),
    warStartTime: at(syncNumber - 520, 8),
    warEndTime: at(syncNumber - 520, 12),
  }));
  const histories = (fullRange ? fullHistories : simpleHistories).map((row) => ({ ...row, matchType: "FWA" }));
  const points = histories.map((row) => ({
    guildId,
    syncNum: row.syncNumber,
    warId: String(row.warId),
    clanTag: row.clanTag,
    warStartTime: row.warStartTime,
    opponentTag: row.opponentTag,
    isFwa: true,
  }));
  const participation = histories.map((row) => ({ guildId, warId: String(row.warId), clanTag: row.clanTag, playerTag: `#P${row.syncNumber}`, matchType: "FWA" }));
  const findCycles = (where: any = {}) => cycles
    .filter((row) => !where.guildId || row.guildId === where.guildId)
    .filter((row) => where.syncNumber?.gte === undefined || row.syncNumber >= where.syncNumber.gte)
    .filter((row) => where.syncNumber?.lte === undefined || row.syncNumber <= where.syncNumber.lte)
    .sort((left, right) => left.syncNumber - right.syncNumber);
  const db: any = {
    syncCycle: {
      findMany: vi.fn(async ({ where = {} }: any = {}) => findCycles(where)),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.guildId_syncNumber) return cycles.find((row) => row.guildId === where.guildId_syncNumber.guildId && row.syncNumber === where.guildId_syncNumber.syncNumber) ?? null;
        return cycles.find((row) => row.guildId === where.guildId_syncTime.guildId && row.syncTime.getTime() === where.guildId_syncTime.syncTime.getTime()) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `cycle-${data.syncNumber}`, ...data };
        cycles.push(created);
        return created;
      }),
    },
    scheduledSyncPost: {
      findMany: vi.fn(async () => schedules),
      findUnique: vi.fn(async ({ where }: any) => schedules.find((row) => row.id === where.id) ?? null),
    },
    clanPointsSync: { findMany: vi.fn(async () => points) },
    clanWarHistory: { findMany: vi.fn(async () => histories) },
    clanWarParticipation: { findMany: vi.fn(async () => participation) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => []) },
    syncClanReadinessSnapshot: { findMany: vi.fn(async () => []) },
  };
  db.$transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db));
  return { db, cycles, schedules };
}

describe("historical SyncCycle reconciliation writer", () => {
  it("requires bounded apply confirmation and defaults to dry run", () => {
    expect(parseHistoricalSyncReconciliationWriterArgs(["--guild", guildId])).toEqual({ guildId, apply: false, expectedCreateCount: undefined });
    expect(() => parseHistoricalSyncReconciliationWriterArgs(["--guild", guildId, "--apply", "--from-sync", "544", "--to-sync", "547"])).toThrow("expected-create-count");
    expect(() => parseHistoricalSyncReconciliationWriterArgs(["--guild", guildId, "--apply", "--expected-create-count", "3"])).toThrow("both --from-sync and --to-sync");
  });

  it("dry-runs production-shaped candidates and skips #544 without opening a transaction", async () => {
    const { db } = makeDb();
    const plan = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 544, toSync: 547, apply: false }, db);
    expect(plan.rows.map((row) => [row.syncNumber, row.action])).toEqual([
      [544, "SKIP"], [545, "CREATE"], [546, "CREATE"], [547, "CREATE"],
    ]);
    expect(plan.rows[0].reason).toBe("no_exact_persisted_schedule");
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("uses shared targets across multiple corroborated intervals for the full production range", async () => {
    const dryDb = makeDb({ fullRange: true });
    const dry = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 520, toSync: 548, apply: false }, dryDb.db);
    expect(dry.considered).toBe(22);
    expect(dry.create).toBe(21);
    expect(dry.alreadyPresent).toBe(0);
    expect(dry.skip).toBe(1);
    expect(dry.conflict).toBe(0);
    expect(dry.rows.map((row) => row.syncNumber)).not.toEqual(expect.arrayContaining([520, 522, 523, 524, 525, 526, 548]));
    expect(dry.rows.find((row) => row.syncNumber === 544)?.action).toBe("SKIP");

    const applyDb = makeDb({ fullRange: true });
    const applied = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 520, toSync: 548, apply: true, expectedCreateCount: 21 }, applyDb.db);
    expect(applied.create).toBe(21);
    expect(applied.rows.find((row) => row.syncNumber === 544)?.action).toBe("SKIP");
    expect(applyDb.cycles.some((row) => row.syncNumber === 544)).toBe(false);
    expect(applyDb.db.syncCycle.create).toHaveBeenCalledTimes(21);
    const rerun = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 520, toSync: 548, apply: true, expectedCreateCount: 0 }, applyDb.db);
    expect(rerun.rows).toEqual([expect.objectContaining({ syncNumber: 544, action: "SKIP" })]);
    expect(applyDb.db.syncCycle.create).toHaveBeenCalledTimes(21);
  });

  it("applies only exact candidates, revalidates schedules, and reruns idempotently", async () => {
    const { db, cycles } = makeDb();
    const first = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 544, toSync: 547, apply: true, expectedCreateCount: 3 }, db);
    expect(first.create).toBe(3);
    expect(cycles.filter((row) => row.syncNumber >= 544 && row.syncNumber <= 547).map((row) => row.syncNumber)).toEqual([545, 546, 547]);
    const second = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 544, toSync: 547, apply: true, expectedCreateCount: 0 }, db);
    expect(second.rows.map((row) => [row.syncNumber, row.action])).toEqual([
      [544, "SKIP"],
    ]);
    expect(db.syncCycle.create).toHaveBeenCalledTimes(3);
  });

  it("rolls back when a selected schedule changes before the transaction writes", async () => {
    const { db, schedules, cycles } = makeDb();
    const plan = await runHistoricalSyncReconciliationWriter({ guildId, fromSync: 544, toSync: 547, apply: false }, db);
    schedules.find((row) => row.id === "s-546").status = "REPLACED";
    await expect(applyHistoricalSyncReconciliationPlan(plan as any, db)).rejects.toThrow("REPLACED");
    expect(cycles).toHaveLength(2);
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("does not write when a plan contains a number conflict", async () => {
    const { db } = makeDb();
    const shared = await import("../src/scripts/auditHistoricalSyncReconciliation");
    const basePlan = await shared.buildHistoricalSyncReconciliationPlan({ guildId, fromSync: 544, toSync: 547 }, db);
    const writerPlan = buildHistoricalSyncReconciliationWriterPlan(basePlan);
    const conflicted = { ...writerPlan, conflict: 1, rows: writerPlan.rows.map((row) => row.syncNumber === 545 ? { ...row, action: "CONFLICT" as const, reason: "sync_number_already_mapped" } : row) };
    await expect(applyHistoricalSyncReconciliationPlan(conflicted, db)).rejects.toThrow("CONFLICT");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
