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

  it("uses only the PointsSync baseline for the global range", async () => {
    const findLatestSyncNum = vi.fn().mockResolvedValue(545);
    const service = new ClanHealthHistoricalWindowService({ findLatestSyncNum });

    const window = await service.resolveLatestSyncWindow({
      guildId: "guild-1",
    });

    expect(window.kind).toBe("syncs");
    expect(findLatestSyncNum).toHaveBeenCalledWith({ guildId: "guild-1" });
  });

  it("returns unavailable when the PointsSync baseline is null", async () => {
    const findLatestSyncNum = vi.fn().mockResolvedValue(null);
    const service = new ClanHealthHistoricalWindowService({ findLatestSyncNum });
    await expect(
      service.resolveLatestSyncWindow({ guildId: "guild-1" }),
    ).resolves.toEqual({
      kind: "unavailable",
      requestedSyncCount: 30,
      reason: "latest_sync_unavailable",
    });
    expect(findLatestSyncNum).toHaveBeenCalledWith({ guildId: "guild-1" });
  });

  it("returns unavailable when the PointsSync baseline throws", async () => {
    const findLatestSyncNum = vi.fn().mockRejectedValue(new Error("points sync unavailable"));
    const service = new ClanHealthHistoricalWindowService({ findLatestSyncNum });

    await expect(
      service.resolveLatestSyncWindow({ guildId: "guild-1" }),
    ).resolves.toEqual({
      kind: "unavailable",
      requestedSyncCount: 30,
      reason: "latest_sync_unavailable",
    });
  });

  it("does not let a clan with missing recent wars shift the global range", async () => {
    const findLatestSyncNum = vi.fn().mockResolvedValue(545);
    const service = new ClanHealthHistoricalWindowService({ findLatestSyncNum });

    await expect(
      service.resolveLatestSyncWindow({ guildId: "guild-1" }),
    ).resolves.toMatchObject({
      kind: "syncs",
      startSyncNumber: 516,
      endSyncNumber: 545,
    });
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
