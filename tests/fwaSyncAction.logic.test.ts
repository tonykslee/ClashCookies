import { describe, expect, it } from "vitest";
import {
  deriveSyncActionSiteOutcome,
  evaluatePostSyncValidation,
  hasRenderedOutcomeMismatch,
} from "../src/commands/fwa/syncAction";

describe("fwa sync action helpers", () => {
  it("derives site outcome from site-inferred FWA type", () => {
    const siteOutcome = deriveSyncActionSiteOutcome({
      siteMatchType: "FWA",
      projectedOutcome: "WIN",
    });

    expect(siteOutcome).toBe("WIN");
  });

  it("keeps site outcome null for non-FWA site matches", () => {
    const siteOutcome = deriveSyncActionSiteOutcome({
      siteMatchType: "MM",
      projectedOutcome: "WIN",
    });

    expect(siteOutcome).toBeNull();
  });

  it("keeps site outcome null when projected site outcome is unknown", () => {
    const siteOutcome = deriveSyncActionSiteOutcome({
      siteMatchType: "FWA",
      projectedOutcome: null,
    });

    expect(siteOutcome).toBeNull();
  });

  it("marks post-sync validation aligned when persisted values match site payload", () => {
    const result = evaluatePostSyncValidation({
      persistedMatchType: "FWA",
      persistedOutcome: "WIN",
      persistedFwaPoints: 1000,
      persistedOpponentFwaPoints: 900,
      siteMatchType: "FWA",
      siteOutcome: "WIN",
      siteFwaPoints: 1000,
      siteOpponentFwaPoints: 900,
    });

    expect(result.fullyAligned).toBe(true);
    expect(result.matchTypeAligned).toBe(true);
    expect(result.outcomeAligned).toBe(true);
    expect(result.pointsAligned).toBe(true);
  });

  it("keeps mismatch visible when persisted FWA outcome is still unknown", () => {
    const result = evaluatePostSyncValidation({
      persistedMatchType: "FWA",
      persistedOutcome: "UNKNOWN",
      persistedFwaPoints: 1000,
      persistedOpponentFwaPoints: 900,
      siteMatchType: "FWA",
      siteOutcome: "WIN",
      siteFwaPoints: 1000,
      siteOpponentFwaPoints: 900,
    });

    expect(result.fullyAligned).toBe(false);
    expect(result.outcomeAligned).toBe(false);
  });

  it("ignores outcome alignment for non-FWA site match types", () => {
    const result = evaluatePostSyncValidation({
      persistedMatchType: "MM",
      persistedOutcome: "UNKNOWN",
      persistedFwaPoints: 1000,
      persistedOpponentFwaPoints: 900,
      siteMatchType: "MM",
      siteOutcome: null,
      siteFwaPoints: 1000,
      siteOpponentFwaPoints: 900,
    });

    expect(result.matchTypeAligned).toBe(true);
    expect(result.outcomeAligned).toBe(true);
    expect(result.pointsAligned).toBe(true);
    expect(result.fullyAligned).toBe(true);
  });

  it("detects rendered outcome mismatch text", () => {
    expect(
      hasRenderedOutcomeMismatch("⚠ Outcome mismatch: expected UNKNOWN, site WIN.")
    ).toBe(true);
    expect(hasRenderedOutcomeMismatch("• Outcome mismatch")).toBe(true);
    expect(hasRenderedOutcomeMismatch("Data is in sync with points.fwafarm")).toBe(false);
  });
});
