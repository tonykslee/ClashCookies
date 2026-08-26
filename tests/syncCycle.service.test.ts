import { describe, expect, it, vi } from "vitest";
import { SyncCycleService } from "../src/services/SyncCycleService";

const preparationStartTime = new Date("2026-08-15T12:00:00.000Z");

function makeCycle(overrides: Record<string, unknown> = {}) {
  return {
    id: "cycle-1",
    guildId: "guild-1",
    syncNumber: 42,
    syncTime: new Date("2026-08-15T11:00:00.000Z"),
    scheduledSyncPostId: "post-1",
    resolvedAt: preparationStartTime,
    resolutionSource: "ENDED_WAR_CANONICAL",
    createdAt: preparationStartTime,
    updatedAt: preparationStartTime,
    ...overrides,
  };
}

function makeDb(
  options: {
    schedules?: Array<{ id: string; syncTime: Date; status?: string }>;
    cycles?: Array<Record<string, unknown>>;
  } = {},
) {
  const schedules = options.schedules ?? [
    { id: "post-1", syncTime: new Date("2026-08-15T11:00:00.000Z") },
  ];
  const cycles = [...(options.cycles ?? [])];
  const scheduledSyncPost = {
    findFirst: vi.fn(async () => schedules[0] ?? null),
    findMany: vi.fn(async ({ where }: any = {}) => {
      const range = where?.syncTime ?? {};
      const lower = range.gte?.getTime?.() ?? -Infinity;
      const upper = range.lte?.getTime?.() ?? Infinity;
      const greater = range.gt?.getTime?.() ?? -Infinity;
      const less = range.lt?.getTime?.() ?? Infinity;
      const excluded = new Set(where?.status?.notIn ?? []);
      return schedules.filter((schedule) => {
        const time = schedule.syncTime.getTime();
        return (
          time >= lower &&
          time <= upper &&
          time > greater &&
          time < less &&
          !excluded.has(schedule.status)
        );
      });
    }),
  };
  const syncCycle = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.guildId_syncNumber) {
        return (
          cycles.find(
            (cycle) =>
              cycle.guildId === where.guildId_syncNumber.guildId &&
              cycle.syncNumber === where.guildId_syncNumber.syncNumber,
          ) ?? null
        );
      }
      return (
        cycles.find(
          (cycle) =>
            cycle.guildId === where.guildId_syncTime.guildId &&
            cycle.syncTime.getTime() ===
              where.guildId_syncTime.syncTime.getTime(),
        ) ?? null
      );
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      return (
        cycles
          .filter((cycle) => cycle.guildId === where.guildId)
          .filter(
            (cycle) => cycle.syncTime.getTime() < where.syncTime.lt.getTime(),
          )
          .sort(
            (left, right) => right.syncTime.getTime() - left.syncTime.getTime(),
          )[0] ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: any = {}) => {
      return cycles.filter((cycle) => cycle.guildId === where?.guildId);
    }),
    create: vi.fn(async ({ data }: any) => {
      const cycle = makeCycle(data);
      cycles.push(cycle);
      return cycle;
    }),
  };
  return { scheduledSyncPost, syncCycle };
}

describe("SyncCycleService", () => {
  it("maps an ended FWA war to the latest eligible prior schedule using preparation start", async () => {
    const db = makeDb({
      schedules: [
        { id: "latest", syncTime: new Date("2026-08-15T11:00:00.000Z") },
        { id: "older", syncTime: new Date("2026-08-15T10:00:00.000Z") },
      ],
    });

    const result = await new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1",
      syncNumber: 42,
      matchType: "fwa",
      preparationStartTime,
    });

    expect(result.status).toBe("created");
    expect(db.scheduledSyncPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          status: { notIn: ["CANCELLED", "REPLACED"] },
          syncTime: {
            lte: preparationStartTime,
            gte: new Date("2026-08-14T12:00:00.000Z"),
          },
        }),
        orderBy: { syncTime: "desc" },
      }),
    );
    expect(db.syncCycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncTime: new Date("2026-08-15T11:00:00.000Z"),
          scheduledSyncPostId: "latest",
        }),
      }),
    );
  });

  it("leaves the cycle unmapped when no schedule is eligible", async () => {
    const db = makeDb({ schedules: [] });
    const result = await new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1",
      syncNumber: 42,
      matchType: "FWA",
      preparationStartTime,
    });
    expect(result).toEqual({
      status: "unmapped",
      reason: "no_eligible_schedule",
    });
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("is idempotent and preserves a conflicting existing number mapping", async () => {
    const existing = makeCycle({
      syncTime: new Date("2026-08-15T10:30:00.000Z"),
    });
    const db = makeDb({ cycles: [existing] });
    const result = await new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1",
      syncNumber: 42,
      matchType: "FWA",
      preparationStartTime,
    });
    expect(result.status).toBe("conflict");
    expect(db.syncCycle.create).not.toHaveBeenCalled();

    const sameDb = makeDb({ cycles: [makeCycle()] });
    const sameService = new SyncCycleService(sameDb);
    expect(
      (
        await sameService.bindFromEndedWar({
          guildId: "guild-1",
          syncNumber: 42,
          matchType: "FWA",
          preparationStartTime,
        })
      ).status,
    ).toBe("existing");
    expect(sameDb.syncCycle.create).not.toHaveBeenCalled();
  });

  it("skips incomplete identity and non-FWA lifecycle events", async () => {
    const db = makeDb();
    await expect(
      new SyncCycleService(db).bindFromEndedWar({
        guildId: "guild-1",
        syncNumber: 42,
        matchType: "BL",
        preparationStartTime,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "non_fwa_cycle" });
    await expect(
      new SyncCycleService(db).bindFromEndedWar({
        guildId: "guild-1",
        syncNumber: null,
        matchType: "FWA",
        preparationStartTime,
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "incomplete_canonical_identity",
    });
    expect(db.scheduledSyncPost.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a sync-time conflict without overwriting the existing mapping", async () => {
    const existing = makeCycle({ syncNumber: 43 });
    const db = makeDb({ cycles: [existing] });
    const result = await new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1",
      syncNumber: 42,
      matchType: "FWA",
      preparationStartTime,
    });
    expect(result.status).toBe("conflict");
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("derives the immediate next active FWA cycle from the previous canonical boundary", async () => {
    const scheduleA = new Date("2026-08-15T10:00:00.000Z");
    const scheduleB = new Date("2026-08-15T11:00:00.000Z");
    const db = makeDb({
      schedules: [
        { id: "post-a", syncTime: scheduleA },
        { id: "post-b", syncTime: scheduleB },
      ],
      cycles: [
        makeCycle({
          syncNumber: 552,
          syncTime: scheduleA,
          scheduledSyncPostId: "post-a",
        }),
      ],
    });

    const result = await new SyncCycleService(db).resolveActiveWarCycle({
      guildId: "guild-1",
      preparationStartTime,
      matchType: "FWA",
      inferredMatchType: false,
    });

    expect(result).toMatchObject({
      status: "derived",
      syncNumber: 553,
      scheduledSyncPostId: "post-b",
      resolutionSource: "ACTIVE_WAR_CONFIRMED",
    });
    const persisted = await new SyncCycleService(db).bindResolvedCanonical({
      guildId: "guild-1",
      syncNumber: 553,
      syncTime: scheduleB,
      scheduledSyncPostId: "post-b",
      resolutionSource: "ACTIVE_WAR_CONFIRMED" as any,
    });
    expect(persisted.status).toBe("created");
    const restarted = await new SyncCycleService(db).resolveActiveWarCycle({
      guildId: "guild-1",
      preparationStartTime,
      matchType: "FWA",
      inferredMatchType: false,
    });
    expect(restarted).toMatchObject({ status: "exact", syncNumber: 553 });
  });

  it("does not guess when multiple unresolved schedules remain after the previous cycle", async () => {
    const db = makeDb({
      schedules: [
        { id: "post-a", syncTime: new Date("2026-08-15T10:00:00.000Z") },
        { id: "post-b", syncTime: new Date("2026-08-15T10:30:00.000Z") },
        { id: "post-c", syncTime: new Date("2026-08-15T11:00:00.000Z") },
      ],
      cycles: [
        makeCycle({
          syncNumber: 552,
          syncTime: new Date("2026-08-15T10:00:00.000Z"),
        }),
      ],
    });
    const result = await new SyncCycleService(db).resolveActiveWarCycle({
      guildId: "guild-1",
      preparationStartTime,
      matchType: "FWA",
      inferredMatchType: true,
    });
    expect(result).toMatchObject({
      status: "ambiguous",
      syncNumber: null,
      reason: "intervening_schedule",
    });
  });

  it("ignores cancelled and replaced schedules instead of using them to establish a current cycle", async () => {
    const db = makeDb({
      schedules: [
        { id: "post-a", syncTime: new Date("2026-08-15T10:00:00.000Z") },
        {
          id: "post-b",
          syncTime: new Date("2026-08-15T11:00:00.000Z"),
          status: "CANCELLED",
        },
      ],
      cycles: [
        makeCycle({
          syncNumber: 552,
          syncTime: new Date("2026-08-15T10:00:00.000Z"),
        }),
      ],
    });
    const result = await new SyncCycleService(db).resolveActiveWarCycle({
      guildId: "guild-1",
      preparationStartTime,
      matchType: "FWA",
      inferredMatchType: true,
    });
    expect(result).toMatchObject({
      status: "unresolved",
      syncNumber: null,
      reason: "terminal_intervening_schedule",
    });
  });

  it("requires positive FWA evidence before the schedule chronology is consulted", async () => {
    const db = makeDb({
      schedules: [
        { id: "post-b", syncTime: new Date("2026-08-15T11:00:00.000Z") },
      ],
      cycles: [makeCycle({ syncNumber: 552 })],
    });
    const result = await new SyncCycleService(db).resolveActiveWarCycle({
      guildId: "guild-1",
      preparationStartTime,
      matchType: "BL",
      inferredMatchType: false,
    });
    expect(result).toMatchObject({
      status: "unresolved",
      syncNumber: null,
      reason: "fwa_evidence_unresolved",
    });
    expect(db.scheduledSyncPost.findMany).not.toHaveBeenCalled();
  });
});
