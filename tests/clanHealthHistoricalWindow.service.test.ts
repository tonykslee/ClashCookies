import { describe, expect, it, vi } from "vitest";
import {
  buildClanHealthHistoricalDaysWindow,
  buildClanHealthHistoricalSyncWindow,
  ClanHealthHistoricalWindowService,
} from "../src/services/ClanHealthHistoricalWindowService";

describe("ClanHealthHistoricalWindowService", () => {
  it("builds exactly the latest 30 contiguous sync numbers", () => {
    expect(buildClanHealthHistoricalSyncWindow(545)).toEqual({
      kind: "syncs",
      requestedSyncCount: 30,
      startSyncNumber: 516,
      endSyncNumber: 545,
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
    });
  });

  it("uses the PointsSync baseline and never queries SyncCycle", async () => {
    const findLatestSyncNum = vi.fn().mockResolvedValue(545);
    const findFirst = vi.fn();
    const service = new ClanHealthHistoricalWindowService(
      { findLatestSyncNum },
      { clanWarHistory: { findFirst } },
    );

    const window = await service.resolveLatestSyncWindow({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    expect(window.kind).toBe("syncs");
    expect(findLatestSyncNum).toHaveBeenCalledWith({ guildId: "guild-1" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the selected clan's latest persisted sync number", async () => {
    const findFirst = vi.fn().mockResolvedValue({ syncNumber: 401 });
    const service = new ClanHealthHistoricalWindowService(
      { findLatestSyncNum: vi.fn().mockResolvedValue(null) },
      { clanWarHistory: { findFirst } },
    );

    await expect(
      service.resolveLatestSyncWindow({ guildId: "guild-1", clanTag: "aaa111" }),
    ).resolves.toMatchObject({
      kind: "syncs",
      startSyncNumber: 372,
      endSyncNumber: 401,
    });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ syncNumber: { not: null } }),
      orderBy: { syncNumber: "desc" },
    }));
  });

  it("keeps explicit day windows separate from sync-number windows", () => {
    const now = new Date("2026-03-09T12:00:00.000Z");
    expect(buildClanHealthHistoricalDaysWindow({ days: 60, now })).toEqual({
      kind: "days",
      days: 60,
      cutoff: new Date("2026-01-08T12:00:00.000Z"),
    });
  });
});
