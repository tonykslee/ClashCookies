import { describe, expect, it } from "vitest";
import {
  formatWeightAgeLine,
  formatWeightHealthLine,
  getWeightHealthState,
} from "../src/commands/fwa/weightView";
import { type FwaStatsWeightAge } from "../src/services/FwaStatsWeightService";

function makeResult(input: Partial<FwaStatsWeightAge>): FwaStatsWeightAge {
  return {
    clanTag: "#ABC123",
    sourceUrl: "https://fwastats.com/Clan/ABC123/Weight",
    ageText: "2d ago",
    ageDays: 2,
    scrapedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "ok",
    httpStatus: 200,
    fromCache: false,
    error: null,
    ...input,
  };
}

describe("weight view helpers", () => {
  it("maps ages into health states", () => {
    expect(getWeightHealthState(2)).toBe("recent");
    expect(getWeightHealthState(14)).toBe("outdated");
    expect(getWeightHealthState(31)).toBe("severely_outdated");
    expect(getWeightHealthState(null)).toBe("unknown");
  });

  it("formats weight-age lines for success and failure", () => {
    const success = formatWeightAgeLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({}),
    });
    const failed = formatWeightAgeLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({ status: "login_required", ageText: null, ageDays: null }),
    });

    expect(success).toContain("Alpha (#ABC123) — 2d ago");
    expect(failed).toContain("unavailable (login required)");
  });

  it("formats health lines with legend emojis", () => {
    const recent = formatWeightHealthLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({ ageText: "2d ago", ageDays: 2 }),
    });
    const outdated = formatWeightHealthLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({ ageText: "14d ago", ageDays: 14 }),
    });
    const severe = formatWeightHealthLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({ ageText: "31d ago", ageDays: 31 }),
    });
    const unavailable = formatWeightHealthLine({
      clanName: "Alpha",
      clanTag: "ABC123",
      result: makeResult({ status: "parse_error", ageText: null, ageDays: null }),
    });

    expect(recent).toContain("✅");
    expect(outdated).toContain("⚠️");
    expect(severe).toContain("❌");
    expect(unavailable).toContain("❓");
  });
});

