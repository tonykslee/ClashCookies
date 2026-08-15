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

function makeDb(options: {
  schedules?: Array<{ id: string; syncTime: Date }>;
  cycles?: Array<Record<string, unknown>>;
} = {}) {
  const schedules = options.schedules ?? [{ id: "post-1", syncTime: new Date("2026-08-15T11:00:00.000Z") }];
  const cycles = [...(options.cycles ?? [])];
  const scheduledSyncPost = {
    findFirst: vi.fn(async () => schedules[0] ?? null),
  };
  const syncCycle = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.guildId_syncNumber) {
        return cycles.find((cycle) =>
          cycle.guildId === where.guildId_syncNumber.guildId &&
          cycle.syncNumber === where.guildId_syncNumber.syncNumber,
        ) ?? null;
      }
      return cycles.find((cycle) =>
        cycle.guildId === where.guildId_syncTime.guildId &&
        cycle.syncTime.getTime() === where.guildId_syncTime.syncTime.getTime(),
      ) ?? null;
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
    expect(db.scheduledSyncPost.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: "guild-1",
        syncTime: {
          lte: preparationStartTime,
          gte: new Date("2026-08-14T12:00:00.000Z"),
        },
      }),
      orderBy: { syncTime: "desc" },
    }));
    expect(db.syncCycle.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        syncTime: new Date("2026-08-15T11:00:00.000Z"),
        scheduledSyncPostId: "latest",
      }),
    }));
  });

  it("leaves the cycle unmapped when no schedule is eligible", async () => {
    const db = makeDb({ schedules: [] });
    const result = await new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1",
      syncNumber: 42,
      matchType: "FWA",
      preparationStartTime,
    });
    expect(result).toEqual({ status: "unmapped", reason: "no_eligible_schedule" });
    expect(db.syncCycle.create).not.toHaveBeenCalled();
  });

  it("is idempotent and preserves a conflicting existing number mapping", async () => {
    const existing = makeCycle({ syncTime: new Date("2026-08-15T10:30:00.000Z") });
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
    expect((await sameService.bindFromEndedWar({
      guildId: "guild-1", syncNumber: 42, matchType: "FWA", preparationStartTime,
    })).status).toBe("existing");
    expect(sameDb.syncCycle.create).not.toHaveBeenCalled();
  });

  it("skips incomplete identity and non-FWA lifecycle events", async () => {
    const db = makeDb();
    await expect(new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1", syncNumber: 42, matchType: "BL", preparationStartTime,
    })).resolves.toEqual({ status: "skipped", reason: "non_fwa_cycle" });
    await expect(new SyncCycleService(db).bindFromEndedWar({
      guildId: "guild-1", syncNumber: null, matchType: "FWA", preparationStartTime,
    })).resolves.toEqual({ status: "skipped", reason: "incomplete_canonical_identity" });
    expect(db.scheduledSyncPost.findFirst).not.toHaveBeenCalled();
  });
});
