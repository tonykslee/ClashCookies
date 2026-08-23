import { describe, expect, it, vi } from "vitest";
import {
  formatBackfillPlan,
  parseBackfillMembershipHistorySyncCyclesArgs,
} from "../src/scripts/backfillMembershipHistorySyncCycles";
import { MembershipHistorySyncCycleBackfillService } from "../src/services/MembershipHistorySyncCycleBackfillService";

const guildId = "guild-1";
const otherGuildId = "guild-2";
const prep = new Date("2026-08-15T12:00:00.000Z");
const syncTime = new Date("2026-08-15T11:00:00.000Z");

function point(overrides: Record<string, unknown> = {}) {
  return {
    guildId,
    syncNum: 520,
    warId: 100,
    clanTag: "#HOME",
    warStartTime: new Date("2026-08-15T13:00:00.000Z"),
    opponentTag: "#OPPONENT",
    isFwa: true,
    ...overrides,
  };
}

function history(overrides: Record<string, unknown> = {}) {
  return {
    warId: 100,
    syncNumber: 520,
    matchType: "FWA",
    clanTag: "#HOME",
    warStartTime: new Date("2026-08-15T13:00:00.000Z"),
    opponentTag: "#OPPONENT",
    prepStartTime: prep,
    warEndTime: new Date("2026-08-15T14:00:00.000Z"),
    ...overrides,
  };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return { id: "schedule-520", guildId, syncTime, status: "PENDING", ...overrides };
}

function makeDb(options: {
  points?: any[];
  evaluations?: any[];
  histories?: any[];
  schedules?: any[];
  cycles?: any[];
} = {}) {
  const points = [...(options.points ?? [point()])];
  const evaluations = [...(options.evaluations ?? [])];
  const histories = [...(options.histories ?? [history()])];
  const schedules = [...(options.schedules ?? [schedule()])];
  const cycles = [...(options.cycles ?? [])];
  const syncCycle = {
    findMany: vi.fn(async () => cycles),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.guildId_syncNumber) {
        return cycles.find((row) => row.guildId === where.guildId_syncNumber.guildId && row.syncNumber === where.guildId_syncNumber.syncNumber) ?? null;
      }
      return cycles.find((row) => row.guildId === where.guildId_syncTime.guildId && row.syncTime.getTime() === where.guildId_syncTime.syncTime.getTime()) ?? null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const created = {
        id: `cycle-${data.syncNumber}`,
        createdAt: data.resolvedAt,
        updatedAt: data.resolvedAt,
        ...data,
      };
      cycles.push(created);
      return created;
    }),
  };
  const db: any = {
    clanPointsSync: {
      findMany: vi.fn(async ({ where }: any) => where?.guildId ? points.filter((row) => row.guildId === where.guildId) : points),
    },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => evaluations) },
    clanWarHistory: { findMany: vi.fn(async () => histories) },
    scheduledSyncPost: { findMany: vi.fn(async () => schedules) },
    syncCycle,
  };
  db.$transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db));
  return db;
}

describe("MembershipHistorySyncCycleBackfillService", () => {
  it("plans one canonical history and exact schedule as CREATE", async () => {
    const db = makeDb();
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows).toEqual([expect.objectContaining({
      syncNumber: 520,
      action: "CREATE",
      candidateSyncTime: syncTime,
      scheduledSyncPostId: "schedule-520",
      canonicalHistoryCount: 1,
    })]);
  });

  it("creates one plan row when multiple canonical histories converge on one schedule", async () => {
    const db = makeDb({
      points: [point(), point({ warId: 101, clanTag: "#OTHER", opponentTag: "#OPPONENT2" })],
      histories: [history(), history({ warId: 101, clanTag: "#OTHER", opponentTag: "#OPPONENT2" })],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CREATE", canonicalHistoryCount: 2 });
  });

  it("reports an exact existing mapping as ALREADY_PRESENT", async () => {
    const db = makeDb({ cycles: [{ guildId, syncNumber: 520, syncTime }] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "ALREADY_PRESENT" });
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("rejects a sync-number conflict without overwriting it", async () => {
    const db = makeDb({ cycles: [{ guildId, syncNumber: 520, syncTime: new Date("2026-08-15T10:00:00.000Z") }] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CONFLICT", reasons: ["sync_number_already_mapped"] });
  });

  it("rejects a sync-time conflict without overwriting it", async () => {
    const db = makeDb({ cycles: [{ guildId, syncNumber: 519, syncTime }] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CONFLICT", reasons: ["sync_time_already_mapped"] });
  });

  it("does not require participation evidence for a valid boundary", async () => {
    const db = makeDb({ histories: [history()] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.creatable).toBe(1);
  });

  it("recovers a stale raw point war ID through the canonical tuple", async () => {
    const db = makeDb({
      points: [point({ warId: 900001 })],
      histories: [history({ warId: 100123 })],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0].action).toBe("CREATE");
  });

  it("rejects persisted same-clan sync disagreement", async () => {
    const db = makeDb({
      points: [point({ warId: 900001 })],
      histories: [history({ warId: 900001, syncNumber: 519 }), history({ warId: 100123 })],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CONFLICT", reasons: ["persisted_sync_number_disagreement"] });
  });

  it("rejects incompatible persisted identities within one guild/sync/clan", async () => {
    const db = makeDb({
      points: [point({ warId: 100 }), point({ warId: 101 })],
      histories: [history({ warId: 100 }), history({ warId: 101 })],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0].action).toBe("CONFLICT");
    expect(plan.rows[0].reasons).toContain("conflicting_war_identities");
  });

  it("rejects one canonical history mapped to multiple guild/sync owners", async () => {
    const db = makeDb({
      points: [point(), point({ guildId: otherGuildId })],
      histories: [history()],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CONFLICT" });
    expect(plan.rows[0].reasons).toContain("history_maps_to_multiple_guild_sync_owners");
  });

  it("rejects histories that resolve to different schedules", async () => {
    const db = makeDb({
      points: [point(), point({ warId: 101, clanTag: "#OTHER", opponentTag: "#OPPONENT2" })],
      histories: [
        history(),
        history({ warId: 101, clanTag: "#OTHER", opponentTag: "#OPPONENT2", prepStartTime: new Date("2026-08-17T12:00:00.000Z") }),
      ],
      schedules: [schedule(), schedule({ id: "schedule-other", syncTime: new Date("2026-08-17T11:00:00.000Z") })],
    });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "CONFLICT" });
    expect(plan.rows[0].reasons).toContain("histories_resolve_to_different_schedules");
  });

  it("ignores cancelled and replaced schedules", async () => {
    const db = makeDb({ schedules: [
      schedule({ id: "cancelled", status: "CANCELLED" }),
      schedule({ id: "replaced", status: "REPLACED" }),
      schedule(),
    ] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0].action).toBe("CREATE");
  });

  it("skips when no exact persisted schedule is eligible", async () => {
    const db = makeDb({ schedules: [schedule({ syncTime: new Date("2026-08-17T00:00:00.000Z") })] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0]).toMatchObject({ action: "SKIP", reasons: ["no_eligible_schedule"] });
  });

  it("never promotes a prep-cluster timestamp without a schedule", async () => {
    const db = makeDb({ schedules: [] });
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(plan.rows[0].action).toBe("SKIP");
    expect(plan.rows[0].candidateSyncTime).toBeNull();
  });

  it("performs no writes during dry-run planning", async () => {
    const db = makeDb();
    await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(db.syncCycle.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("applies the exact scheduled mapping and is idempotent on rerun", async () => {
    const db = makeDb();
    const service = new MembershipHistorySyncCycleBackfillService(db);
    const plan = await service.plan(guildId, new Set([520]));
    const first = await service.apply(plan);
    expect(first[0]).toMatchObject({ status: "created" });
    expect(db.syncCycle.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        guildId,
        syncNumber: 520,
        syncTime,
        scheduledSyncPostId: "schedule-520",
        resolutionSource: "ENDED_WAR_CANONICAL",
      }),
    }));
    const rerun = await service.plan(guildId, new Set([520]));
    expect(rerun.rows[0].action).toBe("ALREADY_PRESENT");
    expect((await service.apply(rerun)).length).toBe(0);
    expect(db.syncCycle.create).toHaveBeenCalledTimes(1);
  });

  it("does not partially apply a selected set containing a conflict", async () => {
    const db = makeDb({
      points: [point(), point({ syncNum: 521, warId: 101 })],
      histories: [history(), history({ syncNumber: 521, warId: 101 })],
      schedules: [schedule(), schedule({ id: "schedule-521", syncTime: new Date("2026-08-16T11:00:00.000Z") })],
      cycles: [{ guildId, syncNumber: 521, syncTime: new Date("2026-08-16T10:00:00.000Z") }],
    });
    const service = new MembershipHistorySyncCycleBackfillService(db);
    const plan = await service.plan(guildId, new Set([520, 521]));
    expect(plan.rows.map((row) => row.action)).toEqual(["CREATE", "CONFLICT"]);
    await expect(service.apply(plan)).rejects.toThrow(/conflict/i);
    expect(db.syncCycle.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("parses guild and sync range arguments with dry-run as the default", () => {
    expect(parseBackfillMembershipHistorySyncCyclesArgs(["--guild", guildId, "--syncs", "520,522-526"])).toEqual({
      guildId,
      syncFilter: new Set([520, 522, 523, 524, 525, 526]),
      apply: false,
    });
    expect(parseBackfillMembershipHistorySyncCyclesArgs(["--guild", guildId, "--sync", "520", "--apply"]).apply).toBe(true);
  });

  it("prints deterministic dry-run output", async () => {
    const db = makeDb();
    const plan = await new MembershipHistorySyncCycleBackfillService(db).plan(guildId, new Set([520]));
    expect(formatBackfillPlan(plan, false)).toContain("DRY RUN — no database mutations performed");
    expect(formatBackfillPlan(plan, false)).toContain("action=CREATE");
  });
});
