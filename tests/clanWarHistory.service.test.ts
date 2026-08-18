import { describe, expect, it, vi } from "vitest";
import {
  ClanWarHistoryService,
  normalizeWarHistoryLimit,
} from "../src/services/ClanWarHistoryService";

describe("ClanWarHistoryService", () => {
  it("preserves /war history recent rows with a bounded latest-N query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ClanWarHistoryService({ clanWarHistory: { findMany } } as any);

    await service.listRecentByClan({ clanTag: "#aaa111", limit: 50 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        orderBy: [{ warStartTime: "desc" }, { warId: "desc" }],
        where: {
          OR: [
            { clanTag: { equals: "#AAA111", mode: "insensitive" } },
            { clanTag: { equals: "AAA111", mode: "insensitive" } },
          ],
        },
      }),
    );
  });

  it("queries all ended rows from the cutoff with deterministic newest-first ordering", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ClanWarHistoryService({ clanWarHistory: { findMany } } as any);
    const cutoff = new Date("2026-01-01T00:00:00.000Z");

    await service.listEndedByClanSince({ clanTag: "AAA111", cutoff });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { clanTag: { equals: "#AAA111", mode: "insensitive" } },
            { clanTag: { equals: "AAA111", mode: "insensitive" } },
          ],
          warEndTime: { not: null, gte: cutoff },
        },
        orderBy: [
          { warEndTime: "desc" },
          { warStartTime: "desc" },
          { warId: "desc" },
        ],
      }),
    );
    expect(findMany.mock.calls[0][0]).not.toHaveProperty("take");
  });

  it("keeps the public recent-history limit contract defensive", () => {
    expect(normalizeWarHistoryLimit(undefined)).toBe(10);
    expect(normalizeWarHistoryLimit(0)).toBe(1);
    expect(normalizeWarHistoryLimit(75)).toBe(50);
    expect(normalizeWarHistoryLimit(12.8)).toBe(12);
  });
});

