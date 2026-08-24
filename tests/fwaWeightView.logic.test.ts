import { describe, expect, it } from "vitest";
import {
  FWA_WEIGHT_RED_DAYS,
  FWA_WEIGHT_YELLOW_DAYS,
  formatWeightHealthLine,
  formatWeightSubmissionZoneLine,
  getWeightSubmissionZone,
  getWeightHealthState,
} from "../src/commands/fwa/weightView";
import {
  buildFwaWeightPageUrl,
  deriveFwaCatalogWeightAge,
} from "../src/services/FwaWeightCatalogService";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("weight view helpers", () => {
  it("preserves the 7-day and 30-day health boundaries", () => {
    expect(getWeightHealthState(7)).toBe("recent");
    expect(getWeightHealthState(7.001)).toBe("outdated");
    expect(getWeightHealthState(30)).toBe("severely_outdated");
    expect(getWeightHealthState(null)).toBe("unknown");
  });

  it("clamps future submission timestamps to a non-negative age", () => {
    const result = deriveFwaCatalogWeightAge(
      "#ABC123",
      new Date("2026-08-10T12:00:00.000Z"),
      NOW,
    );
    expect(result.ageDays).toBe(0);
    expect(result.ageText).toBe("0d 0h ago");
  });

  it("preserves the existing weight-link URL shape", () => {
    expect(buildFwaWeightPageUrl("#ABC123")).toBe(
      "https://fwastats.com/Clan/ABC123/Weight",
    );
  });

  it("formats recent, stale, severe, and unknown rows with established icons", () => {
    const make = (ageDays: number | null) => ({
      clanTag: "#ABC123",
      weightSubmitDate: ageDays === null ? null : NOW,
      ageDays,
      ageText: ageDays === null ? null : `${ageDays}d 0h ago`,
    });
    expect(
      formatWeightHealthLine({ clanName: "Alpha", clanTag: "ABC123", result: make(2) }),
    ).toContain("\u2705");
    expect(
      formatWeightHealthLine({ clanName: "Alpha", clanTag: "ABC123", result: make(14) }),
    ).toContain("\u26a0\ufe0f");
    expect(
      formatWeightHealthLine({ clanName: "Alpha", clanTag: "ABC123", result: make(30) }),
    ).toContain("\u274c");
    expect(
      formatWeightHealthLine({ clanName: "Alpha", clanTag: "ABC123", result: make(null) }),
    ).toContain("\u2753");
  });

  it("keeps submission-zone boundaries separate from health boundaries", () => {
    expect(getWeightSubmissionZone(FWA_WEIGHT_YELLOW_DAYS - 0.001)).toBe("current");
    expect(getWeightSubmissionZone(FWA_WEIGHT_YELLOW_DAYS)).toBe("yellow");
    expect(getWeightSubmissionZone(FWA_WEIGHT_RED_DAYS - 0.001)).toBe("yellow");
    expect(getWeightSubmissionZone(FWA_WEIGHT_RED_DAYS)).toBe("red");
    expect(getWeightSubmissionZone(null)).toBe("unknown");
  });

  it("renders the zone label from the persisted age", () => {
    const result = {
      clanTag: "ABC123",
      weightSubmitDate: NOW,
      ageDays: 42,
      ageText: "42d 0h ago",
    };
    expect(
      formatWeightSubmissionZoneLine({
        clanName: "Alpha",
        clanTag: "ABC123",
        result,
      }),
    ).toContain("🔴 Red Zone");
  });
});
