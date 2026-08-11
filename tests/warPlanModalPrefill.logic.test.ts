import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import {
  buildComplianceConfigLineForTest,
  getCurrentOrDefaultPlanDataForTest,
} from "../src/commands/WarPlan";

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
    expect(prefill.winRequireMirrorAfterOpen).toBe(false);
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

  it("does not append hardcoded FWA_WIN-only copy in compliance text", () => {
    const line = buildComplianceConfigLineForTest({
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      nonMirrorTripleMinClanStars: 0,
      allBasesOpenHoursLeft: 12,
    });

    expect(line).toBe(
      "Compliance gate: open at 150 clan stars or 12h left | open attacks: 0-2★ any | uncleared mirror after open: not required | clan cap: 100★",
    );
    expect(line).not.toContain("applies to FWA_WIN only");
  });

  it("prefills the built-in Traditional mirror requirement as false", async () => {
    vi.spyOn(prisma.clanWarPlan, "findUnique")
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce(null as any);

    const prefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      history: {
        buildWarPlanText: vi.fn().mockResolvedValue("Generated fallback plan"),
      } as any,
    });

    expect(prefill.traditionalRequireMirrorAfterOpen).toBe(false);
  });

  it("uses DEFAULT true when CUSTOM is unset, and preserves explicit CUSTOM false", async () => {
    const findUniqueSpy = vi.spyOn(prisma.clanWarPlan, "findUnique");
    findUniqueSpy
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({
        traditionalRequireMirrorAfterOpen: true,
      } as any);

    const inherited = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      history: { buildWarPlanText: vi.fn().mockResolvedValue("Fallback") } as any,
    });
    expect(inherited.traditionalRequireMirrorAfterOpen).toBe(true);

    findUniqueSpy
      .mockResolvedValueOnce({
        planText: "Custom",
        traditionalRequireMirrorAfterOpen: false,
      } as any)
      .mockResolvedValueOnce({
        traditionalRequireMirrorAfterOpen: true,
      } as any);
    const explicitFalse = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      history: { buildWarPlanText: vi.fn().mockResolvedValue("Fallback") } as any,
    });
    expect(explicitFalse.traditionalRequireMirrorAfterOpen).toBe(false);
  });

  it("uses an explicit CUSTOM true value even when DEFAULT is false", async () => {
    vi.spyOn(prisma.clanWarPlan, "findUnique")
      .mockResolvedValueOnce({
        planText: "Custom",
        traditionalRequireMirrorAfterOpen: true,
      } as any)
      .mockResolvedValueOnce({
        traditionalRequireMirrorAfterOpen: false,
      } as any);

    const prefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope: "CUSTOM",
      clanTag: "AAA111",
      target: { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
      history: { buildWarPlanText: vi.fn().mockResolvedValue("Fallback") } as any,
    });
    expect(prefill.traditionalRequireMirrorAfterOpen).toBe(true);
  });

  it.each([
    {
      name: "CUSTOM inherits DEFAULT true",
      scope: "CUSTOM" as const,
      primary: null,
      fallback: { winRequireMirrorAfterOpen: true },
      expected: true,
    },
    {
      name: "CUSTOM false overrides DEFAULT true",
      scope: "CUSTOM" as const,
      primary: { winRequireMirrorAfterOpen: false },
      fallback: { winRequireMirrorAfterOpen: true },
      expected: false,
    },
    {
      name: "CUSTOM true overrides DEFAULT false",
      scope: "CUSTOM" as const,
      primary: { winRequireMirrorAfterOpen: true },
      fallback: { winRequireMirrorAfterOpen: false },
      expected: true,
    },
    {
      name: "DEFAULT uses its explicit value",
      scope: "DEFAULT" as const,
      primary: { winRequireMirrorAfterOpen: true },
      fallback: null,
      expected: true,
    },
    {
      name: "unset DEFAULT uses built-in false",
      scope: "DEFAULT" as const,
      primary: null,
      fallback: null,
      expected: false,
    },
  ])("prefills WIN mirror-after-open as $expected when $name", async ({
    scope,
    primary,
    fallback,
    expected,
  }) => {
    const findUniqueSpy = vi.spyOn(prisma.clanWarPlan, "findUnique");
    findUniqueSpy.mockResolvedValueOnce(primary as any);
    if (scope === "CUSTOM") {
      findUniqueSpy.mockResolvedValueOnce(fallback as any);
    }

    const prefill = await getCurrentOrDefaultPlanDataForTest({
      guildId: "guild-1",
      scope,
      clanTag: scope === "CUSTOM" ? "AAA111" : "",
      target: { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      history: { buildWarPlanText: vi.fn().mockResolvedValue("Fallback") } as any,
    });

    expect(prefill.winRequireMirrorAfterOpen).toBe(expected);
  });
});
