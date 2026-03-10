import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
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
