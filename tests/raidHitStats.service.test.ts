import { describe, expect, it, beforeEach, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
  },
  raidDistrictHitHistory: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { buildRaidHitStatsByAttackerTag } from "../src/services/RaidHitStatsService";

describe("RaidHitStatsService", () => {
  const now = new Date("2026-05-31T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([{ clanTag: "2QG2C08UP" }]);
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([]);
  });

  function makeHit(overrides: Record<string, unknown> = {}) {
    return {
      sourceClanTag: "2QG2C08UP",
      attackerTag: "PYPYQ0R2",
      destructionPercent: 100,
      districtFinalAttackCount: 1,
      districtFinalDestructionPercent: 100,
      districtFinalStars: 3,
      observedAt: new Date("2026-05-30T12:00:00.000Z"),
      ...overrides,
    };
  }

  it("counts completed 1-shot hits", async () => {
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({
        attackerTag: "#PYPYQ0R2",
        destructionPercent: 100,
        districtFinalAttackCount: 1,
      }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ guildId: "guild-1", now });

    expect(stats.get("PYPYQ0R2")).toMatchObject({
      attackerTag: "PYPYQ0R2",
      totalHits: 1,
      oneShots: 1,
      twoShots: 0,
      threeShots: 0,
      averageDestructionPercent: 100,
      perfectHits: 1,
      lastHitAt: new Date("2026-05-30T12:00:00.000Z"),
    });
  });

  it("counts each hitter on completed 2-shot districts", async () => {
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({
        attackerTag: "PYPYQ0R2",
        destructionPercent: 52,
        districtFinalAttackCount: 2,
      }),
      makeHit({
        attackerTag: "8G2RJCP0",
        destructionPercent: 100,
        districtFinalAttackCount: 2,
      }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ now });

    expect(stats.get("PYPYQ0R2")).toMatchObject({
      totalHits: 1,
      oneShots: 0,
      twoShots: 1,
      threeShots: 0,
      averageDestructionPercent: 52,
      perfectHits: 0,
    });
    expect(stats.get("8G2RJCP0")).toMatchObject({
      totalHits: 1,
      oneShots: 0,
      twoShots: 1,
      threeShots: 0,
      averageDestructionPercent: 100,
      perfectHits: 1,
    });
  });

  it("counts each hitter on completed 3-shot districts", async () => {
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({ attackerTag: "PYPYQ0R2", destructionPercent: 37, districtFinalAttackCount: 3 }),
      makeHit({ attackerTag: "8G2RJCP0", destructionPercent: 81, districtFinalAttackCount: 3 }),
      makeHit({ attackerTag: "20RLGVJPP", destructionPercent: 100, districtFinalAttackCount: 3 }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ now });

    expect(stats.get("PYPYQ0R2")?.threeShots).toBe(1);
    expect(stats.get("8G2RJCP0")?.threeShots).toBe(1);
    expect(stats.get("20RLGVJPP")?.threeShots).toBe(1);
  });

  it("does not count incomplete districts as 1-shot, 2-shot, or 3-shot buckets", async () => {
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({
        attackerTag: "PYPYQ0R2",
        destructionPercent: 80,
        districtFinalAttackCount: 2,
        districtFinalDestructionPercent: 80,
        districtFinalStars: 2,
      }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ now });

    expect(stats.get("PYPYQ0R2")).toMatchObject({
      totalHits: 1,
      oneShots: 0,
      twoShots: 0,
      threeShots: 0,
      averageDestructionPercent: 80,
      perfectHits: 0,
    });
  });

  it("limits hit history query to the last 30 days", async () => {
    await buildRaidHitStatsByAttackerTag({ guildId: "guild-1", now });

    expect(prismaMock.raidDistrictHitHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          observedAt: { gte: new Date("2026-05-01T12:00:00.000Z") },
        }),
      }),
    );
  });

  it("limits source clans to configured tracked RAIDS clans", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([{ clanTag: "#2QG2C08UP" }]);
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({ sourceClanTag: "2QG2C08UP", attackerTag: "PYPYQ0R2" }),
      makeHit({ sourceClanTag: "2RVGJYLC0", attackerTag: "8G2RJCP0" }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ now });

    expect(prismaMock.raidDistrictHitHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceClanTag: { in: ["2QG2C08UP", "#2QG2C08UP"] },
        }),
      }),
    );
    expect(stats.has("PYPYQ0R2")).toBe(true);
    expect(stats.has("8G2RJCP0")).toBe(false);
  });

  it("averages destruction percent and tracks the latest hit time per attacker", async () => {
    prismaMock.raidDistrictHitHistory.findMany.mockResolvedValue([
      makeHit({
        attackerTag: "PYPYQ0R2",
        destructionPercent: 40,
        districtFinalAttackCount: 3,
        observedAt: new Date("2026-05-20T12:00:00.000Z"),
      }),
      makeHit({
        attackerTag: "PYPYQ0R2",
        destructionPercent: 100,
        districtFinalAttackCount: 3,
        observedAt: new Date("2026-05-30T12:00:00.000Z"),
      }),
    ]);

    const stats = await buildRaidHitStatsByAttackerTag({ now });

    expect(stats.get("PYPYQ0R2")?.averageDestructionPercent).toBe(70);
    expect(stats.get("PYPYQ0R2")?.perfectHits).toBe(1);
    expect(stats.get("PYPYQ0R2")?.lastHitAt).toEqual(new Date("2026-05-30T12:00:00.000Z"));
  });
});
