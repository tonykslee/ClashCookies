import { beforeEach, describe, expect, it, vi } from "vitest";
import { FwaStatsService } from "../src/services/FwaStatsService";

describe("FwaStatsService", () => {
  const fetchClanWars = vi.fn();

  beforeEach(() => {
    fetchClanWars.mockReset();
  });

  it("returns true when opponent is present in active wars", async () => {
    fetchClanWars.mockResolvedValue([
        { opponentTag: "#ABC123", matched: true, synced: true },
        { opponentTag: "#ZZZ999", matched: true, synced: false },
      ]);
    const service = new FwaStatsService({ fetchClanWars } as any);

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBe(true);
  });

  it("ignores rows explicitly not matched and not synced", async () => {
    fetchClanWars.mockResolvedValue([{ opponentTag: "#ABC123", matched: false, synced: false }]);
    const service = new FwaStatsService({ fetchClanWars } as any);

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBe(false);
  });

  it("uses cached response within ttl", async () => {
    fetchClanWars.mockResolvedValue([{ opponentTag: "#ABC123", matched: true, synced: true }]);
    const service = new FwaStatsService({ fetchClanWars } as any);

    const first = await service.isOpponentInActiveWars("#TAG1", "#ABC123");
    const second = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(fetchClanWars).toHaveBeenCalledTimes(1);
  });

  it("returns null when fwastats request fails", async () => {
    fetchClanWars.mockRejectedValue(new Error("boom"));
    const service = new FwaStatsService({ fetchClanWars } as any);

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBeNull();
  });
});

