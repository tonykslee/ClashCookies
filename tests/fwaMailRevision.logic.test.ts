import { describe, expect, it } from "vitest";
import { buildWarMailRevisionLinesForTest } from "../src/commands/Fwa";

describe("war mail revision log", () => {
  it("includes both match type and expected outcome changes", () => {
    const lines = buildWarMailRevisionLinesForTest({
      previousMatchType: "FWA",
      previousExpectedOutcome: "WIN",
      nextMatchType: "BL",
      nextExpectedOutcome: null,
    });

    expect(lines).toEqual([
      "- Match Type: **FWA** -> **BL**",
      "- Expected outcome: **WIN** -> **N/A**",
    ]);
  });

  it("returns no lines when nothing changed", () => {
    const lines = buildWarMailRevisionLinesForTest({
      previousMatchType: "FWA",
      previousExpectedOutcome: "LOSE",
      nextMatchType: "FWA",
      nextExpectedOutcome: "LOSE",
    });

    expect(lines).toEqual([]);
  });
});
