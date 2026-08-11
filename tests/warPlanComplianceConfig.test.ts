import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
  DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
  MAX_ALL_BASES_OPEN_HOURS_LEFT,
  formatWarPlanComplianceLine,
  parseAllBasesOpenHoursLeftInput,
  parseNonMirrorMinClanStarsInput,
  resolveWarPlanComplianceConfig,
  resolveWarPlanComplianceConfigForPlan,
} from "../src/services/warPlanComplianceConfig";

describe("warPlanComplianceConfig", () => {
  it("parses non-mirror min-stars as an optional non-negative integer", () => {
    expect(parseNonMirrorMinClanStarsInput("")).toEqual({ ok: true, value: null });
    expect(parseNonMirrorMinClanStarsInput("101")).toEqual({
      ok: true,
      value: 101,
    });
    expect(parseNonMirrorMinClanStarsInput("abc").ok).toBe(false);
    expect(parseNonMirrorMinClanStarsInput("-1").ok).toBe(false);
  });

  it("parses all-bases-open hours as optional H/Hh in range 0..24", () => {
    expect(parseAllBasesOpenHoursLeftInput("")).toEqual({ ok: true, value: null });
    expect(parseAllBasesOpenHoursLeftInput("8")).toEqual({ ok: true, value: 8 });
    expect(parseAllBasesOpenHoursLeftInput("8h")).toEqual({ ok: true, value: 8 });
    expect(parseAllBasesOpenHoursLeftInput("24h")).toEqual({ ok: true, value: 24 });
    expect(parseAllBasesOpenHoursLeftInput("25").ok).toBe(false);
    expect(parseAllBasesOpenHoursLeftInput("8.5").ok).toBe(false);
    expect(parseAllBasesOpenHoursLeftInput("8m").ok).toBe(false);
  });

  it("resolves effective config using primary -> fallback -> defaults", () => {
    expect(resolveWarPlanComplianceConfig({})).toEqual({
      nonMirrorMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
      nonMirrorTripleMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
      allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { nonMirrorTripleMinClanStars: null, allBasesOpenHoursLeft: null },
        fallback: { nonMirrorTripleMinClanStars: 120, allBasesOpenHoursLeft: 9 },
      })
    ).toEqual({
      nonMirrorMinClanStars: 120,
      nonMirrorTripleMinClanStars: 120,
      allBasesOpenHoursLeft: 9,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { nonMirrorTripleMinClanStars: 130, allBasesOpenHoursLeft: 4 },
        fallback: { nonMirrorTripleMinClanStars: 120, allBasesOpenHoursLeft: 9 },
      })
    ).toEqual({
      nonMirrorMinClanStars: 130,
      nonMirrorTripleMinClanStars: 130,
      allBasesOpenHoursLeft: 4,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { allBasesOpenHoursLeft: 999 },
      }).allBasesOpenHoursLeft
    ).toBe(MAX_ALL_BASES_OPEN_HOURS_LEFT);
  });

  it("resolves effective config per plan style and formats human-readable compliance lines", () => {
    const win = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "ANY",
      primary: null,
      fallback: null,
    });
    const traditional = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      primary: null,
      fallback: null,
    });
    const tripleTop30 = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRIPLE_TOP_30",
      primary: null,
      fallback: null,
    });

    expect(win).toEqual({
      nonMirrorMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
      nonMirrorTripleMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
      allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
      winRequireMirrorAfterOpen: false,
    });
    expect(traditional).toEqual({
      nonMirrorMinClanStars: DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
      nonMirrorTripleMinClanStars: DEFAULT_FWA_LOSS_TRADITIONAL_NON_MIRROR_MIN_CLAN_STARS,
      allBasesOpenHoursLeft: DEFAULT_FWA_LOSS_TRADITIONAL_ALL_BASES_OPEN_HOURS_LEFT,
      traditionalRequireMirrorAfterOpen: false,
    });
    expect(tripleTop30).toBeNull();
    expect(
      formatWarPlanComplianceLine({
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "ANY",
        config: win,
      }),
    ).toContain("non-mirror 3★ opens at 101 clan stars or 0h left");
    expect(
      formatWarPlanComplianceLine({
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
        config: traditional,
      }),
    ).toBe(
      "Compliance gate: open at 150 clan stars or 12h left | open attacks: 0-2★ any | uncleared mirror after open: not required | clan cap: 100★",
    );
    expect(
      formatWarPlanComplianceLine({
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
        config: { ...traditional, traditionalRequireMirrorAfterOpen: true },
      }),
    ).toContain("uncleared mirror after open: required");
    expect(
      formatWarPlanComplianceLine({
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRIPLE_TOP_30",
        config: null,
      }),
    ).toBe("Compliance rules: targets #1-30 only | attacks must earn 1-3★ | clan cap: 90★");
  });

  it("resolves the Traditional mirror-after-open flag with custom -> default -> false precedence", () => {
    const custom = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      primary: { traditionalRequireMirrorAfterOpen: true },
      fallback: { traditionalRequireMirrorAfterOpen: false },
    });
    const inherited = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      primary: { traditionalRequireMirrorAfterOpen: null },
      fallback: { traditionalRequireMirrorAfterOpen: true },
    });
    const customFalse = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      primary: { traditionalRequireMirrorAfterOpen: false },
      fallback: { traditionalRequireMirrorAfterOpen: true },
    });
    const builtIn = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
      primary: null,
      fallback: null,
    });

    expect(custom?.traditionalRequireMirrorAfterOpen).toBe(true);
    expect(inherited?.traditionalRequireMirrorAfterOpen).toBe(true);
    expect(customFalse?.traditionalRequireMirrorAfterOpen).toBe(false);
    expect(builtIn?.traditionalRequireMirrorAfterOpen).toBe(false);
  });

  it("resolves the FWA-WIN mirror-after-open flag with custom -> default -> false precedence", () => {
    const builtIn = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "ANY",
      primary: null,
      fallback: null,
    });
    const customTrue = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "ANY",
      primary: { winRequireMirrorAfterOpen: true },
      fallback: { winRequireMirrorAfterOpen: false },
    });
    const customFalse = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "ANY",
      primary: { winRequireMirrorAfterOpen: false },
      fallback: { winRequireMirrorAfterOpen: true },
    });
    const inherited = resolveWarPlanComplianceConfigForPlan({
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "ANY",
      primary: { winRequireMirrorAfterOpen: null },
      fallback: { winRequireMirrorAfterOpen: true },
    });

    expect(builtIn?.winRequireMirrorAfterOpen).toBe(false);
    expect(customTrue?.winRequireMirrorAfterOpen).toBe(true);
    expect(customFalse?.winRequireMirrorAfterOpen).toBe(false);
    expect(inherited?.winRequireMirrorAfterOpen).toBe(true);
    expect(customTrue?.nonMirrorMinClanStars).toBe(
      DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
    );
    expect(customTrue?.allBasesOpenHoursLeft).toBe(
      DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
    );
    expect(
      resolveWarPlanComplianceConfigForPlan({
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
        primary: { traditionalRequireMirrorAfterOpen: true },
        fallback: { traditionalRequireMirrorAfterOpen: false },
      })?.traditionalRequireMirrorAfterOpen,
    ).toBe(true);
  });
});
