import { describe, expect, it, vi } from "vitest";
import { WarEventHistoryService } from "../src/services/war-events/history";

describe("WarEventHistoryService.buildWarPlanText", () => {
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
});
