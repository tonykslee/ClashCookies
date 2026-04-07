import { describe, expect, it } from "vitest";
import {
  buildWarMailPostedContentForTest,
  buildWarMailSendPayloadForTest,
  buildWarMailRefreshEditPayloadForTest,
  hasWarIdentityShiftedForTest,
  resolveWarMailRefreshIdentityDecisionForTest,
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

  it("detects shift when the opponent identity changes for the same posted war id", () => {
    const shifted = hasWarIdentityShiftedForTest({
      postedWarId: "1001",
      postedOpponentTag: "2OLDTAG",
      renderedWarId: 1001,
      renderedOpponentTag: "2NEWTAG",
    });
    expect(shifted).toBe(true);
  });

  it("does not flag shift when expected/posted and rendered opponent identities match", () => {
    const shifted = hasWarIdentityShiftedForTest({
      expectedWarId: "1001",
      expectedOpponentTag: "#2MATCHED",
      renderedWarId: 1001,
      renderedOpponentTag: "2MATCHED",
    });
    expect(shifted).toBe(false);
  });
});

describe("fwa war-mail refresh identity decision", () => {
  it("freezes when a refresh resolves to a different war identity", () => {
    const decision = resolveWarMailRefreshIdentityDecisionForTest({
      expectedWarId: "1001",
      expectedWarStartMs: 1_700_000_000_000,
      postedWarId: "1001",
      postedOpponentTag: "2OLDTAG",
      renderedWarId: 2002,
      renderedWarStartMs: 1_700_086_400_000,
      renderedOpponentTag: "2NEWTAG",
    });

    expect(decision).toEqual({
      action: "freeze",
      identityShifted: true,
    });
  });

  it("allows same-war rerender edits when identity is unchanged", () => {
    const decision = resolveWarMailRefreshIdentityDecisionForTest({
      expectedWarId: "1001",
      expectedWarStartMs: 1_700_000_000_000,
      postedWarId: "1001",
      postedOpponentTag: "2MATCHED",
      renderedWarId: 1001,
      renderedWarStartMs: 1_700_000_000_000,
      renderedOpponentTag: "2MATCHED",
    });

    expect(decision).toEqual({
      action: "edit",
      identityShifted: false,
    });
  });

  it("fails closed when neither expected nor posted identity is available", () => {
    const decision = resolveWarMailRefreshIdentityDecisionForTest({
      expectedWarId: null,
      expectedWarStartMs: null,
      postedWarId: null,
      postedOpponentTag: null,
      renderedWarId: 1001,
      renderedWarStartMs: 1_700_000_000_000,
      renderedOpponentTag: "2MATCHED",
    });

    expect(decision).toEqual({
      action: "freeze",
      identityShifted: true,
    });
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
      "Custom war mail line 1\nCustom war mail line 2\n\n<@&123456789>\n\nNext refresh <t:1200:R>"
    );
  });

  it("normalizes mention-style stored role ids before pinging", () => {
    const content = buildWarMailPostedContentForTest("<@&123456789>", 0, {
      pingRole: true,
      planText: "Plan body",
    });
    expect(content).toBe("Plan body\n\n<@&123456789>\n\nNext refresh <t:1200:R>");
  });

  it("can omit next-refresh line for frozen mail posts", () => {
    const content = buildWarMailPostedContentForTest("123456789", 0, {
      pingRole: true,
      planText: "Plan body",
      includeNextRefresh: false,
    });
    expect(content).toBe("Plan body\n\n<@&123456789>");
  });
});

describe("fwa war-mail send payload", () => {
  it("includes the visible role mention and allows the ping when enabled", () => {
    const payload = buildWarMailSendPayloadForTest("123456789", 0, {
      pingRole: true,
      planText: "Plan body",
      includeNextRefresh: true,
    });

    expect(payload.content).toBe("Plan body\n\n<@&123456789>\n\nNext refresh <t:1200:R>");
    expect(payload.allowedMentions).toEqual({ roles: ["123456789"] });
  });

  it("omits the visible role mention and allowedMentions when pinging is disabled", () => {
    const payload = buildWarMailSendPayloadForTest("123456789", 0, {
      pingRole: false,
      planText: "Plan body",
      includeNextRefresh: true,
    });

    expect(payload.content).toBe("Plan body\n\nNext refresh <t:1200:R>");
    expect(payload.allowedMentions).toBeUndefined();
  });
});

describe("fwa war-mail refresh edit payload", () => {
  it("preserves existing visible role mention in refreshed content", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "Old plan\n\n<@&123456789>\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.content).toBe("New plan\n\n<@&123456789>\n\nNext refresh <t:1200:R>");
  });

  it("preserves mention in refresh edits for legacy mention-first content", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "<@&123456789>\n\nOld plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.content).toBe("New plan\n\n<@&123456789>\n\nNext refresh <t:1200:R>");
  });

  it("uses non-pinging allowedMentions on refresh edits", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "<@&123456789>\n\nOld plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("prefers durable mention role state over parsing when provided", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "Old plan -- <@&999999999> in the middle of text\n\nNext refresh <t:999:R>",
      "New plan",
      0,
      { mentionRoleId: "123456789" },
    );

    expect(payload.content).toBe("New plan\n\n<@&123456789>\n\nNext refresh <t:1200:R>");
  });

  it("does not add a role mention when existing posted message has none", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "Old plan\n\nNext refresh <t:999:R>",
      "New plan",
      0
    );

    expect(payload.content).toBe("New plan\n\nNext refresh <t:1200:R>");
  });

  it("removes stale next-refresh text when refresh is frozen", () => {
    const payload = buildWarMailRefreshEditPayloadForTest(
      "Old plan\n\nMail role: <@&123456789>.\n\nNext refresh <t:999:R>",
      "New plan",
      0,
      { includeNextRefresh: false },
    );

    expect(payload.content).toBe("New plan\n\n<@&123456789>");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
});
