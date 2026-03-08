import { describe, expect, it } from "vitest";
import {
  buildWarMailPostedContentForTest,
  hasWarIdentityShiftedForTest,
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

  it("treats posted mail as stale when live opponent changes", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      postedOpponentTag: "AAA111",
      liveMatchType: "FWA",
      liveExpectedOutcome: "WIN",
      liveOpponentTag: "BBB222",
    });

    expect(isCurrent).toBe(false);
  });

  it("treats posted mail as stale when war start changes", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      postedWarStartMs: 1000,
      liveMatchType: "FWA",
      liveExpectedOutcome: "WIN",
      liveWarStartMs: 2000,
    });

    expect(isCurrent).toBe(false);
  });

  it("treats posted mail as stale when war id changes", () => {
    const isCurrent = isPostedMailCurrentForLiveStateForTest({
      postedMatchType: "FWA",
      postedExpectedOutcome: "WIN",
      postedWarId: "101",
      liveMatchType: "FWA",
      liveExpectedOutcome: "WIN",
      liveWarId: 202,
    });

    expect(isCurrent).toBe(false);
  });
});

describe("fwa war-mail war identity shift detection", () => {
  it("detects war-id transitions for previously posted mail", () => {
    const shifted = hasWarIdentityShiftedForTest({
      postedWarId: "1001",
      renderedWarId: 2002,
    });
    expect(shifted).toBe(true);
  });

  it("detects war-start transitions when war id is unavailable", () => {
    const shifted = hasWarIdentityShiftedForTest({
      postedWarStartMs: 1_700_000_000_000,
      renderedWarStartMs: 1_700_086_400_000,
    });
    expect(shifted).toBe(true);
  });

  it("does not flag identity shift when war id and start are unchanged", () => {
    const shifted = hasWarIdentityShiftedForTest({
      postedWarId: "1001",
      postedWarStartMs: 1_700_000_000_000,
      renderedWarId: 1001,
      renderedWarStartMs: 1_700_000_000_000,
    });
    expect(shifted).toBe(false);
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

  it("keeps custom mail text in posted content", () => {
    const content = buildWarMailPostedContentForTest("123456789", 0, {
      pingRole: true,
      planText: "Custom war mail line 1\nCustom war mail line 2",
    });
    expect(content).toBe(
      "<@&123456789>\n\nCustom war mail line 1\nCustom war mail line 2\n\nNext refresh <t:1200:R>"
    );
  });

  it("normalizes mention-style stored role ids before pinging", () => {
    const content = buildWarMailPostedContentForTest("<@&123456789>", 0, {
      pingRole: true,
      planText: "Plan body",
    });
    expect(content).toBe("<@&123456789>\n\nPlan body\n\nNext refresh <t:1200:R>");
  });

  it("can omit next-refresh line for frozen mail posts", () => {
    const content = buildWarMailPostedContentForTest("123456789", 0, {
      pingRole: true,
      planText: "Plan body",
      includeNextRefresh: false,
    });
    expect(content).toBe("<@&123456789>\n\nPlan body");
  });
});
