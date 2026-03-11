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

describe("PointsSyncService war-scoped lookup", () => {
  const service = new PointsSyncService();
  const warStartTime = new Date("2026-03-10T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the current war has no persisted sync row", async () => {
    prismaMock.clanPointsSync.findFirst.mockResolvedValueOnce(null);
    prismaMock.clanPointsSync.findUnique.mockResolvedValueOnce(null);

    const result = await service.getWarScopedSyncForClan({
      guildId: "guild-1",
      clanTag: "aaa111",
      warId: "475",
      warStartTime,
    });

    expect(result).toBeNull();
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId: "guild-1",
          clanTag: "#AAA111",
          warId: "475",
        },
      })
    );
  });

  it("keeps legacy latest-row fallback for compatibility callers", async () => {
    const latestRow = { id: "prior-war-row", syncNum: 474 };
    prismaMock.clanPointsSync.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(latestRow);
    prismaMock.clanPointsSync.findUnique.mockResolvedValueOnce(null);

    const result = await service.getCurrentSyncForClan({
      guildId: "guild-1",
      clanTag: "aaa111",
      warId: "475",
      warStartTime,
    });

    expect(result).toBe(latestRow);
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          guildId: "guild-1",
          clanTag: "#AAA111",
        },
        orderBy: [
          { warStartTime: "desc" },
          { syncFetchedAt: "desc" },
          { lastSuccessfulPointsApiFetchAt: "desc" },
          { updatedAt: "desc" },
        ],
      })
    );
  });
});
