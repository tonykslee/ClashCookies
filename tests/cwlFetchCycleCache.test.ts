import { describe, expect, it, vi } from "vitest";
import { CwlFetchCycleCache } from "../src/services/CwlFetchCycleCache";

describe("CwlFetchCycleCache", () => {
  it("caches clan war league group fetches within one cycle", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({
        season: "2026-04",
        state: "preparation",
        rounds: [],
      }),
      getClanWarLeagueWar: vi.fn(),
    } as any;
    const cache = new CwlFetchCycleCache(cocService);

    const first = await cache.getClanWarLeagueGroup("#2QG2C08UP");
    const second = await cache.getClanWarLeagueGroup("#2QG2C08UP");

    expect(first).toEqual(second);
    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toMatchObject({
      groupMissCount: 1,
      groupHitCount: 1,
      cachedGroupCount: 1,
    });
  });

  it("caches clan war league war fetches within one cycle", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClanWarLeagueWar: vi.fn().mockResolvedValue({
        state: "preparation",
        clan: { tag: "#2QG2C08UP" },
        opponent: { tag: "#Q2V8P9L2" },
      }),
    } as any;
    const cache = new CwlFetchCycleCache(cocService);

    const first = await cache.getClanWarLeagueWar("#WAR1");
    const second = await cache.getClanWarLeagueWar("#WAR1");

    expect(first).toEqual(second);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toMatchObject({
      warMissCount: 1,
      warHitCount: 1,
      cachedWarCount: 1,
    });
  });

  it("does not cache thrown CWL fetch failures", async () => {
    const cocService = {
      getClanWarLeagueGroup: vi
        .fn()
        .mockRejectedValueOnce(new Error("group boom"))
        .mockResolvedValueOnce({
          season: "2026-04",
          state: "preparation",
          rounds: [],
        }),
      getClanWarLeagueWar: vi
        .fn()
        .mockRejectedValueOnce(new Error("war boom"))
        .mockResolvedValueOnce({
          state: "preparation",
          clan: { tag: "#2QG2C08UP" },
          opponent: { tag: "#Q2V8P9L2" },
        }),
    } as any;
    const cache = new CwlFetchCycleCache(cocService);

    await expect(cache.getClanWarLeagueGroup("#2QG2C08UP")).rejects.toThrow("group boom");
    await expect(cache.getClanWarLeagueGroup("#2QG2C08UP")).resolves.toMatchObject({
      season: "2026-04",
    });
    await expect(cache.getClanWarLeagueWar("#WAR1")).rejects.toThrow("war boom");
    await expect(cache.getClanWarLeagueWar("#WAR1")).resolves.toMatchObject({
      state: "preparation",
    });

    expect(cocService.getClanWarLeagueGroup).toHaveBeenCalledTimes(2);
    expect(cocService.getClanWarLeagueWar).toHaveBeenCalledTimes(2);
  });
});
