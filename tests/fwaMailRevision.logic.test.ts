import { describe, expect, it } from "vitest";
import {
  buildSupersededWarMailDescriptionForTest,
  buildWarMailRevisionLinesForTest,
} from "../src/commands/Fwa";

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

  it("builds superseded description with only revision details", () => {
    const description = buildSupersededWarMailDescriptionForTest({
      changedAtMs: 1_700_000_000_000,
      revisionLines: ["- Match Type: **FWA** -> **BL**"],
    });

    expect(description).toBe(
      "Superseded at <t:1700000000:F>\n- Match Type: **FWA** -> **BL**"
    );
  });
});
