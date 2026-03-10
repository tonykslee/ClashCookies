import { describe, expect, it } from "vitest";
import {
  getMailBlockedReasonFromRevisionStateForTest,
  resolveConfirmedRevisionBaselineForTest,
  resolveEffectiveRevisionStateForTest,
  resolveScopedDraftRevisionForTest,
} from "../src/commands/Fwa";
import { MATCH_MAIL_CONFIG_DEFAULT } from "../src/commands/fwa/mailConfig";

describe("fwa match revision baseline resolution", () => {
  it("uses persisted confirmed baseline when war identity matches", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      mailConfig: {
        ...MATCH_MAIL_CONFIG_DEFAULT,
        lastWarId: "123",
        lastOpponentTag: "#2Q80R9PYU",
        lastMatchType: "BL",
        lastExpectedOutcome: null,
      },
      liveFields: {
        warId: "123",
        opponentTag: "2Q80R9PYU",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
      lifecycleStatus: "posted",
    });

    expect(baseline).toEqual({
      warId: "123",
      opponentTag: "2Q80R9PYU",
      matchType: "BL",
      expectedOutcome: null,
    });
  });

  it("falls back to live fields for posted state when baseline is missing", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      mailConfig: {
        ...MATCH_MAIL_CONFIG_DEFAULT,
        lastWarId: "999",
        lastOpponentTag: "#ABC",
        lastMatchType: "MM",
        lastExpectedOutcome: null,
      },
      liveFields: {
        warId: "123",
        opponentTag: "2Q80R9PYU",
        matchType: "FWA",
        expectedOutcome: "LOSE",
      },
      lifecycleStatus: "posted",
    });

    expect(baseline).toEqual({
      warId: "123",
      opponentTag: "2Q80R9PYU",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
  });
});

describe("fwa match revision draft scoping", () => {
  it("drops draft when war identity no longer matches current view", () => {
    const scoped = resolveScopedDraftRevisionForTest({
      draft: {
        warId: "1001",
        opponentTag: "2OLDTAG",
        matchType: "BL",
        expectedOutcome: null,
      },
      liveFields: {
        warId: "1002",
        opponentTag: "2NEWTAG",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
    });

    expect(scoped).toBeNull();
  });

  it("applies draft over baseline only when values actually differ", () => {
    const resolved = resolveEffectiveRevisionStateForTest({
      liveFields: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
      confirmedBaseline: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
      draft: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL",
        expectedOutcome: null,
      },
    });

    expect(resolved.draftDiffersFromBaseline).toBe(true);
    expect(resolved.appliedDraft).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "BL",
      expectedOutcome: null,
    });
    expect(resolved.effective?.matchType).toBe("BL");
  });
});

describe("fwa match posted mail gating with revisions", () => {
  it("keeps send blocked when posted and no draft revision exists", () => {
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: false,
      hasMailChannel: true,
      mailStatus: "posted",
      appliedDraft: null,
      draftDiffersFromBaseline: false,
    });

    expect(reason).toBe(
      "Current mail is already up to date. Change match config before sending again."
    );
  });

  it("enables send when posted and a draft differs from baseline", () => {
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: false,
      hasMailChannel: true,
      mailStatus: "posted",
      appliedDraft: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL",
        expectedOutcome: null,
      },
      draftDiffersFromBaseline: true,
    });

    expect(reason).toBeNull();
  });

  it("allows draft-confirmed send for inferred not-posted state", () => {
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: true,
      hasMailChannel: true,
      mailStatus: "not_posted",
      appliedDraft: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA",
        expectedOutcome: "LOSE",
      },
      draftDiffersFromBaseline: true,
    });

    expect(reason).toBeNull();
  });
});
