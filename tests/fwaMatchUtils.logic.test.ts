import { describe, expect, it } from "vitest";
import {
  buildLimitedMessage,
  compareTagsForTiebreak,
  formatPoints,
  getWinnerMarkerForSide,
  getSyncMode,
} from "../src/commands/fwa/matchUtils";

describe("fwa match utils", () => {
  it("derives sync mode from sync number parity", () => {
    expect(getSyncMode(10)).toBe("high");
    expect(getSyncMode(11)).toBe("low");
    expect(getSyncMode(null)).toBeNull();
  });

  it("compares tags using deterministic tiebreak order", () => {
    expect(compareTagsForTiebreak("A000", "B000")).toBeLessThan(0);
    expect(compareTagsForTiebreak("Z000", "A000")).toBeGreaterThan(0);
    expect(compareTagsForTiebreak("#Q2AAA", "Q2AAA")).toBe(0);
  });

  it("formats points for display", () => {
    expect(formatPoints(1234567)).toBe("1,234,567");
  });

  it("adds winner marker only to the expected winner side", () => {
    expect(getWinnerMarkerForSide("WIN", "clan")).toBe(" :trophy:");
    expect(getWinnerMarkerForSide("WIN", "opponent")).toBe("");
    expect(getWinnerMarkerForSide("LOSE", "opponent")).toBe(" :trophy:");
    expect(getWinnerMarkerForSide("LOSE", "clan")).toBe("");
    expect(getWinnerMarkerForSide("UNKNOWN", "clan")).toBe("");
  });

  it("builds bounded messages and adds omitted-count note when truncated", () => {
    const lines = Array.from({ length: 120 }, (_, index) => `Clan ${index} ${"x".repeat(40)}`);
    const message = buildLimitedMessage("Header", lines, "\nSummary");

    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).toContain("...and ");
  });
});
