import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { PointsSyncService } from "../src/services/PointsSyncService";

describe("PointsSyncService.getCurrentSyncForClan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null instead of reusing the latest row when a requested war identity has no match", async () => {
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.clanPointsSync.findUnique.mockResolvedValue(null);
    const service = new PointsSyncService();

    const result = await service.getCurrentSyncForClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: "1001",
      warStartTime: new Date("2026-03-10T08:00:00.000Z"),
    });

    expect(result).toBeNull();
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns null for warStartTime-only lookups when no current-war row exists", async () => {
    prismaMock.clanPointsSync.findUnique.mockResolvedValue(null);
    const service = new PointsSyncService();

    const result = await service.getCurrentSyncForClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warStartTime: new Date("2026-03-10T08:00:00.000Z"),
    });

    expect(result).toBeNull();
    expect(prismaMock.clanPointsSync.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findFirst).not.toHaveBeenCalled();
  });

  it("still returns the latest row when no war identity is requested", async () => {
    prismaMock.clanPointsSync.findFirst.mockResolvedValue({
      syncNum: 474,
      warId: "999",
    });
    const service = new PointsSyncService();

    const result = await service.getCurrentSyncForClan({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    expect(result).toMatchObject({
      syncNum: 474,
      warId: "999",
    });
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("PointsSyncService.checkpointCurrentWarSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates lifecycle checkpoint fields for an existing war-scoped row", async () => {
    prismaMock.clanPointsSync.updateMany.mockResolvedValue({ count: 1 });
    const service = new PointsSyncService();
    const warStartTime = new Date("2026-03-11T08:00:00.000Z");

    const updated = await service.checkpointCurrentWarSync({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: "2001",
      warStartTime,
      syncNum: 475,
      fetchReason: "match_render",
      fetchedAt: new Date("2026-03-11T08:05:00.000Z"),
    });

    expect(updated).toBe(true);
    expect(prismaMock.clanPointsSync.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "guild-1",
          clanTag: "#AAA111",
          warStartTime,
        }),
        data: expect.objectContaining({
          lastKnownSyncNumber: 475,
          lastFetchReason: "match_render",
        }),
      })
    );
  });

  it("does not create or mutate rows when war identity is missing", async () => {
    const service = new PointsSyncService();

    const updated = await service.checkpointCurrentWarSync({
      guildId: "guild-1",
      clanTag: "#AAA111",
      syncNum: 475,
      fetchReason: "match_render",
    });

    expect(updated).toBe(false);
    expect(prismaMock.clanPointsSync.updateMany).not.toHaveBeenCalled();
  });

  it("returns false when no same-war row exists for checkpoint update", async () => {
    prismaMock.clanPointsSync.updateMany.mockResolvedValue({ count: 0 });
    const service = new PointsSyncService();

    const updated = await service.checkpointCurrentWarSync({
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: "2001",
      syncNum: 475,
      fetchReason: "match_render",
    });

    expect(updated).toBe(false);
    expect(prismaMock.clanPointsSync.updateMany).toHaveBeenCalledTimes(1);
  });
});
