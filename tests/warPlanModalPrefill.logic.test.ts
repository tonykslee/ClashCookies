import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { getCurrentOrDefaultPlanDataForTest } from "../src/commands/WarPlan";

describe("warplan set modal compliance prefill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses exact clan-specific compliance config when present", async () => {
    const findUniqueSpy = vi.spyOn(prisma.clanWarPlan, "findUnique");
    findUniqueSpy
      .mockResolvedValueOnce({
        planText: "Custom FWA WIN plan",
        nonMirrorTripleMinClanStars: 133,
        allBasesOpenHoursLeft: 5,
      } as any)
      .mockResolvedValueOnce({
        nonMirrorTripleMinClanStars: 120,
        allBasesOpenHoursLeft: 9,
      } as any);
    const history = {
      buildWarPlanText: vi.fn().mockResolvedValue("Generated fallback plan"),
    };

    const prefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      history: history as any,
    });

    expect(prefill.planText).toBe("Custom FWA WIN plan");
    expect(prefill.nonMirrorTripleMinClanStars).toBe(133);
    expect(prefill.allBasesOpenHoursLeft).toBe(5);
    expect(history.buildWarPlanText).not.toHaveBeenCalled();
  });

  it("falls back to default compliance config when clan-specific config is missing", async () => {
    const findUniqueSpy = vi.spyOn(prisma.clanWarPlan, "findUnique");
    findUniqueSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({
        nonMirrorTripleMinClanStars: 118,
        allBasesOpenHoursLeft: 7,
      } as any);
    const history = {
      buildWarPlanText: vi.fn().mockResolvedValue("Generated fallback plan"),
    };

    const prefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      history: history as any,
    });

    expect(prefill.planText).toBe("Generated fallback plan");
    expect(prefill.nonMirrorTripleMinClanStars).toBe(118);
    expect(prefill.allBasesOpenHoursLeft).toBe(7);
    expect(history.buildWarPlanText).toHaveBeenCalledTimes(1);
  });

  it("resolves different matchType/outcome targets to different prefill values", async () => {
    vi.spyOn(prisma.clanWarPlan, "findUnique").mockImplementation(
      (async (args?: Parameters<typeof prisma.clanWarPlan.findUnique>[0]) => {
        const where =
          args?.where?.guildId_scope_clanTag_matchType_outcome_loseStyle as
            | {
                scope: "CUSTOM" | "DEFAULT";
                matchType: "FWA" | "BL" | "MM";
                outcome: "WIN" | "LOSE" | "ANY";
                loseStyle: "TRADITIONAL" | "TRIPLE_TOP_30" | "ANY";
              }
            | undefined;
        if (!where) return null;
        if (where.scope === "CUSTOM") return null;
        if (
          where.scope === "DEFAULT" &&
          where.matchType === "FWA" &&
          where.outcome === "WIN"
        ) {
          return {
            nonMirrorTripleMinClanStars: 140,
            allBasesOpenHoursLeft: 3,
          } as any;
        }
        if (
          where.scope === "DEFAULT" &&
          where.matchType === "FWA" &&
          where.outcome === "LOSE" &&
          where.loseStyle === "TRADITIONAL"
        ) {
          return {
            nonMirrorTripleMinClanStars: 0,
            allBasesOpenHoursLeft: 12,
          } as any;
        }
        return null;
      }) as typeof prisma.clanWarPlan.findUnique,
    );
    const history = {
      buildWarPlanText: vi.fn().mockResolvedValue("Generated fallback plan"),
    };

    const winPrefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      history: history as any,
    });
    const traditionalLosePrefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      history: history as any,
    });

    expect(winPrefill.nonMirrorTripleMinClanStars).toBe(140);
    expect(winPrefill.allBasesOpenHoursLeft).toBe(3);
    expect(traditionalLosePrefill.nonMirrorTripleMinClanStars).toBe(0);
    expect(traditionalLosePrefill.allBasesOpenHoursLeft).toBe(12);
  });
});
