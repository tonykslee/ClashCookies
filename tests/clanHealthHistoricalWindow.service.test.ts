import { describe, expect, it, vi } from "vitest";
import {
  ClanHealthHistoricalWindowService,
  CLAN_HEALTH_DEFAULT_SYNC_COUNT,
} from "../src/services/ClanHealthHistoricalWindowService";

describe("ClanHealthHistoricalWindowService", () => {
  it("resolves the latest 30 guild sync rows at or before now with deterministic ordering", async () => {
    const now = new Date("2026-03-09T23:00:00.000Z");
    const syncRows = Array.from({ length: 35 }, (_, index) => ({
      syncNumber: 500 - index,
      syncTime: new Date(now.getTime() - index * 60 * 60 * 1000),
    }));
    const findMany = vi.fn().mockResolvedValue(syncRows.slice(0, CLAN_HEALTH_DEFAULT_SYNC_COUNT));
    const window = await new ClanHealthHistoricalWindowService({
      syncCycle: { findMany },
    }).resolveLatestSyncWindow({ guildId: "guild-1", now });

    expect(findMany).toHaveBeenCalledWith({
      where: { guildId: "guild-1", syncTime: { lte: now } },
      orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
      take: 30,
      select: { syncNumber: true, syncTime: true },
    });
    expect(window.kind).toBe("syncs");
    expect(window.requestedSyncCount).toBe(30);
    expect(window.syncNumbers).toHaveLength(30);
    expect(window.syncNumbers[0]).toBe(500);
  });

  it("truthfully returns fewer than 30 rows without day fallback", async () => {
    const window = await new ClanHealthHistoricalWindowService({
      syncCycle: {
        findMany: vi.fn().mockResolvedValue([
          { syncNumber: 7, syncTime: new Date("2026-03-09T12:00:00.000Z") },
        ]),
      },
    }).resolveLatestSyncWindow({ guildId: "guild-1", now: new Date("2026-03-09T12:00:00.000Z") });

    expect(window).toMatchObject({
      kind: "syncs",
      requestedSyncCount: 30,
      syncNumbers: [7],
    });
    expect(window).not.toHaveProperty("cutoff");
  });
});
