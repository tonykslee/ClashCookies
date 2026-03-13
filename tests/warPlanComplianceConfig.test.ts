import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
  MAX_ALL_BASES_OPEN_HOURS_LEFT,
  parseAllBasesOpenHoursLeftInput,
  parseNonMirrorTripleMinClanStarsInput,
  resolveWarPlanComplianceConfig,
} from "../src/services/warPlanComplianceConfig";

describe("warPlanComplianceConfig", () => {
  it("parses non-mirror min-stars as an optional non-negative integer", () => {
    expect(parseNonMirrorTripleMinClanStarsInput("")).toEqual({ ok: true, value: null });
    expect(parseNonMirrorTripleMinClanStarsInput("101")).toEqual({
      ok: true,
      value: 101,
    });
    expect(parseNonMirrorTripleMinClanStarsInput("abc").ok).toBe(false);
    expect(parseNonMirrorTripleMinClanStarsInput("-1").ok).toBe(false);
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
      nonMirrorTripleMinClanStars: DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
      allBasesOpenHoursLeft: DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { nonMirrorTripleMinClanStars: null, allBasesOpenHoursLeft: null },
        fallback: { nonMirrorTripleMinClanStars: 120, allBasesOpenHoursLeft: 9 },
      })
    ).toEqual({
      nonMirrorTripleMinClanStars: 120,
      allBasesOpenHoursLeft: 9,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { nonMirrorTripleMinClanStars: 130, allBasesOpenHoursLeft: 4 },
        fallback: { nonMirrorTripleMinClanStars: 120, allBasesOpenHoursLeft: 9 },
      })
    ).toEqual({
      nonMirrorTripleMinClanStars: 130,
      allBasesOpenHoursLeft: 4,
    });

    expect(
      resolveWarPlanComplianceConfig({
        primary: { allBasesOpenHoursLeft: 999 },
      }).allBasesOpenHoursLeft
    ).toBe(MAX_ALL_BASES_OPEN_HOURS_LEFT);
  });
});
