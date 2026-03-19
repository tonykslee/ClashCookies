import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaFeedSyncStateService } from "../src/services/fwa-feeds/FwaFeedSyncStateService";

const prismaMock = vi.hoisted(() => ({
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("FwaFeedSyncStateService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats missing scope state as eligible", async () => {
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    const service = new FwaFeedSyncStateService();
    const eligible = await service.isEligible(
      { feedType: "CLANS", scopeType: "GLOBAL", scopeKey: null },
      15 * 60 * 1000,
      new Date("2026-03-19T10:00:00.000Z"),
    );
    expect(eligible).toBe(true);
  });

  it("blocks runs before nextEligibleAt", async () => {
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue({
      nextEligibleAt: new Date("2026-03-19T10:10:00.000Z"),
      lastAttemptAt: new Date("2026-03-19T09:55:00.000Z"),
    });
    const service = new FwaFeedSyncStateService();
    const eligible = await service.isEligible(
      { feedType: "CLAN_MEMBERS", scopeType: "CLAN_TAG", scopeKey: "#AAA111" },
      15 * 60 * 1000,
      new Date("2026-03-19T10:00:00.000Z"),
    );
    expect(eligible).toBe(false);
  });

  it("persists success metadata with row counts and hash", async () => {
    prismaMock.fwaFeedSyncState.upsert.mockResolvedValue(undefined);
    const service = new FwaFeedSyncStateService();
    await service.recordSuccess({
      feedType: "WAR_MEMBERS",
      scopeType: "GLOBAL",
      scopeKey: "SWEEP",
      rowCount: 20,
      changedRowCount: 5,
      contentHash: "abc123",
      status: "SUCCESS",
      nextEligibleAt: new Date("2026-03-19T10:15:00.000Z"),
    });
    expect(prismaMock.fwaFeedSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastRowCount: 20,
          lastChangedRowCount: 5,
          lastContentHash: "abc123",
          lastStatus: "SUCCESS",
        }),
      }),
    );
  });
});
