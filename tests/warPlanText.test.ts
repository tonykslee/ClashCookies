import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { WarEventHistoryService } from "../src/services/war-events/history";

describe("WarEventHistoryService.buildWarPlanText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exact WIN plan lines", async () => {
    const svc = new WarEventHistoryService({} as never);
    const out = await svc.buildWarPlanText("FWA", "WIN", "ABC123", "OPPONENT_NAME");
    expect(out).toBe(
      [
        "**💚 WIN WAR 🆚 OPPONENT_NAME 🟢 **",
        "🗡️ 1st Attack: ★ ★ ★ -> Mirror",
        "🗡️ 2nd Attack: ★ ★ ☆ -> any",
        "⌛️ Only after 101+ stars -> Attack ANY base",
      ].join("\n")
    );
  });

  it("returns exact LOSE TRIPLE_TOP_30 plan lines", async () => {
    const svc = new WarEventHistoryService({} as never);
    (svc as any).getLoseStyleForClan = vi.fn().mockResolvedValue("TRIPLE_TOP_30");
    const out = await svc.buildWarPlanText("FWA", "LOSE", "ABC123", "OPPONENT_NAME");
    expect(out).toBe(
      [
        "**❤️ LOSE WAR 🆚 OPPONENT_NAME 🔴**",
        "🗡️ Attack any of the top 30 bases for 1-3 stars",
        "🚫 Do NOT attack the bottom 20 bases",
        "🎯 Goal is 90 stars (do not cross)",
      ].join("\n")
    );
  });

  it("returns exact LOSE TRADITIONAL plan lines", async () => {
    const svc = new WarEventHistoryService({} as never);
    (svc as any).getLoseStyleForClan = vi.fn().mockResolvedValue("TRADITIONAL");
    const out = await svc.buildWarPlanText("FWA", "LOSE", "ABC123", "OPPONENT_NAME");
    expect(out).toBe(
      [
        "**❤️ LOSE WAR 🆚 OPPONENT_NAME 🔴**",
        "🗡️ 1st Attack: ★ ★ ☆ -> Mirror",
        "🗡️ 2nd Attack: ★ ☆ ☆ -> any",
        "⏳ Last 12hrs: ★ ★ ☆ -> any",
        "🎯 Do NOT surpass 100 ★",
      ].join("\n")
    );
  });

  it("prefers clan custom plan text for guild-scoped lookups", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy.mockResolvedValueOnce({ planText: "MM custom plan vs {opponent}" } as any);

    const out = await svc.buildWarPlanText("123456789012345678", "MM", null, "ABC123", "OPPONENT_NAME");

    expect(out).toBe("MM custom plan vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(1);
    expect(planSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "CUSTOM",
          matchType: "MM",
          outcome: "ANY",
        }),
      })
    );
  });

  it("falls back to editable guild default when clan custom is missing", async () => {
    const svc = new WarEventHistoryService({} as never);
    const planSpy = vi.spyOn(prisma.clanWarPlan, "findFirst");
    planSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ planText: "BL default plan vs {opponent}" } as any);

    const out = await svc.buildWarPlanText("123456789012345678", "BL", null, "ABC123", "OPPONENT_NAME");

    expect(out).toBe("BL default plan vs OPPONENT_NAME");
    expect(planSpy).toHaveBeenCalledTimes(2);
    expect(planSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "123456789012345678",
          scope: "DEFAULT",
          matchType: "BL",
          outcome: "ANY",
        }),
      })
    );
  });
});
