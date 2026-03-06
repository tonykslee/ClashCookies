import { describe, expect, it } from "vitest";
import {
  buildWarMailPostedContentForTest,
  isPostedMailCurrentForLiveStateForTest,
} from "../src/commands/Fwa";

describe("fwa mail downstream update gating", () => {
  it("treats posted mail as stale when live match type changes in single-clan view", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      liveMatchType: "BL",
      liveExpectedOutcome: "WIN",
    });

    expect(isCurrent).toBe(false);
  });

  it("treats posted mail as stale when live expected outcome changes", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      liveMatchType: "FWA",
      liveExpectedOutcome: "LOSE",
    });

    expect(isCurrent).toBe(false);
  });

  it("treats posted mail as current when live match config is unchanged", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      liveMatchType: "FWA",
      liveExpectedOutcome: "WIN",
    });

    expect(isCurrent).toBe(true);
  });
});

describe("fwa war-mail posted content", () => {
  it("includes role mention and relative next-refresh label", () => {
    const content = buildWarMailPostedContentForTest("123456789", 0);
    expect(content).toBe("<@&123456789>\nNext refresh <t:1200:R>");
  });

  it("includes next-refresh label without role mention", () => {
    const content = buildWarMailPostedContentForTest(null, 0);
    expect(content).toBe("Next refresh <t:1200:R>");
  });

  it("omits the role mention when ping is explicitly disabled", () => {
    const content = buildWarMailPostedContentForTest("123456789", 0, { pingRole: false });
    expect(content).toBe("Next refresh <t:1200:R>");
  });
});
