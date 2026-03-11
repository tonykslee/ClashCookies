import { describe, expect, it } from "vitest";
import {
  buildWarMailPostedContentForTest,
  buildWarMailRefreshEditPayloadForTest,
  hasWarIdentityShiftedForTest,
} from "../src/commands/Fwa";

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

describe("fwa war-mail refresh edit payload", () => {
  it("preserves existing visible role mention in refreshed content", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "<@&123456789>\n\nOld plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.content).toBe("<@&123456789>\n\nNew plan\n\nNext refresh <t:1200:R>");
  });

  it("uses non-pinging allowedMentions on refresh edits", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "<@&123456789>\n\nOld plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("does not add a role mention when existing posted message has none", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "Old plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.content).toBe("New plan\n\nNext refresh <t:1200:R>");
  });
});
