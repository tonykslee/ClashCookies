import { describe, expect, it } from "vitest";
import {
  buildDraftFromOutcomeToggleForTest,
  buildDraftFromMatchTypeSelectionForTest,
  buildEffectiveMatchMismatchWarningsForTest,
  getMailBlockedReasonFromRevisionStateForTest,
  resolveSingleClanMatchEmbedColorForTest,
  resolveEffectiveFwaOutcomeForTest,
  resolveConfirmedRevisionBaselineForTest,
  resolveEffectiveRevisionStateForTest,
  resolveScopedDraftRevisionForTest,
} from "../src/commands/Fwa";
import { MATCH_MAIL_CONFIG_DEFAULT } from "../src/commands/fwa/mailConfig";
import {
  WAR_MAIL_COLOR_BL,
  WAR_MAIL_COLOR_FALLBACK,
  WAR_MAIL_COLOR_FWA_LOSE,
  WAR_MAIL_COLOR_FWA_WIN,
  WAR_MAIL_COLOR_MM,
  resolveWarMailEmbedColor,
} from "../src/commands/fwa/mailEmbedColor";

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

describe("fwa match draft initialization for BL/MM -> FWA", () => {
  it("seeds BL -> FWA draft with projected WIN when available", () => {
    const draft = buildDraftFromMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        confirmedRevisionBaseline: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        effectiveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        projectedFwaOutcome: "WIN",
      },
      targetType: "FWA",
    });

    expect(draft).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "FWA",
      expectedOutcome: "WIN",
    });
  });

  it("seeds MM -> FWA draft with projected LOSE when available", () => {
    const draft = buildDraftFromMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        confirmedRevisionBaseline: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "MM",
          expectedOutcome: null,
        },
        effectiveRevisionFields: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "MM",
          expectedOutcome: null,
        },
        projectedFwaOutcome: "LOSE",
      },
      targetType: "FWA",
    });

    expect(draft).toEqual({
      warId: "2002",
      opponentTag: "2TAG",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
  });
});

describe("fwa effective outcome resolution for FWA drafts", () => {
  it("keeps explicit draft WIN/LOSE over projected fallback", () => {
    const resolved = resolveEffectiveFwaOutcomeForTest({
      matchType: "FWA",
      explicitOutcome: "WIN",
      projectedOutcome: "LOSE",
    });

    expect(resolved).toBe("WIN");
  });

  it("uses projected outcome when draft value is UNKNOWN", () => {
    const resolved = resolveEffectiveFwaOutcomeForTest({
      matchType: "FWA",
      explicitOutcome: "UNKNOWN",
      projectedOutcome: "LOSE",
    });

    expect(resolved).toBe("LOSE");
  });

  it("stays UNKNOWN only when projected outcome is unavailable", () => {
    const resolved = resolveEffectiveFwaOutcomeForTest({
      matchType: "FWA",
      explicitOutcome: "UNKNOWN",
      projectedOutcome: null,
    });

    expect(resolved).toBe("UNKNOWN");
  });
});

describe("fwa effective-state mismatch gating", () => {
  it("evaluates mismatch from effective FWA state instead of BL/MM warning path", () => {
    const mismatch = buildEffectiveMatchMismatchWarningsForTest({
      siteUpdated: true,
      effectiveMatchType: "FWA",
      effectiveExpectedOutcome: "UNKNOWN",
      projectedOutcome: "WIN",
      siteActiveFwa: true,
    });

    expect(mismatch.outcomeMismatch).toContain("Outcome mismatch");
    expect(mismatch.matchTypeVsFwaMismatch).toBeNull();
  });

  it("keeps BL/MM active-fwa warning when effective state remains BL/MM", () => {
    const mismatch = buildEffectiveMatchMismatchWarningsForTest({
      siteUpdated: true,
      effectiveMatchType: "BL",
      effectiveExpectedOutcome: null,
      projectedOutcome: "WIN",
      siteActiveFwa: true,
    });

    expect(mismatch.outcomeMismatch).toBeNull();
    expect(mismatch.matchTypeVsFwaMismatch).toContain("Active FWA: YES");
  });
});

describe("fwa single-clan match embed color", () => {
  it("reuses shared war-mail color semantics for effective displayed state", () => {
    const cases: Array<{
      matchType: "FWA" | "BL" | "MM" | "UNKNOWN";
      expectedOutcome: "WIN" | "LOSE" | "UNKNOWN" | null;
      expectedColor: number;
    }> = [
      { matchType: "BL", expectedOutcome: null, expectedColor: WAR_MAIL_COLOR_BL },
      { matchType: "MM", expectedOutcome: null, expectedColor: WAR_MAIL_COLOR_MM },
      { matchType: "FWA", expectedOutcome: "WIN", expectedColor: WAR_MAIL_COLOR_FWA_WIN },
      { matchType: "FWA", expectedOutcome: "LOSE", expectedColor: WAR_MAIL_COLOR_FWA_LOSE },
      { matchType: "FWA", expectedOutcome: "UNKNOWN", expectedColor: WAR_MAIL_COLOR_FALLBACK },
      { matchType: "UNKNOWN", expectedOutcome: null, expectedColor: WAR_MAIL_COLOR_FALLBACK },
    ];

    for (const testCase of cases) {
      const resolved = resolveSingleClanMatchEmbedColorForTest({
        effectiveMatchType: testCase.matchType,
        effectiveExpectedOutcome: testCase.expectedOutcome,
      });
      expect(resolved).toBe(testCase.expectedColor);
      expect(resolved).toBe(
        resolveWarMailEmbedColor({
          matchType: testCase.matchType,
          expectedOutcome: testCase.expectedOutcome,
        })
      );
    }
  });

  it("updates color for BL -> FWA draft transition using projected outcome", () => {
    const draft = buildDraftFromMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        confirmedRevisionBaseline: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        effectiveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        projectedFwaOutcome: "WIN",
      },
      targetType: "FWA",
    });

    expect(draft?.expectedOutcome).toBe("WIN");
    const nextColor = resolveSingleClanMatchEmbedColorForTest({
      effectiveMatchType: draft?.matchType ?? "UNKNOWN",
      effectiveExpectedOutcome: draft?.expectedOutcome ?? null,
    });
    expect(nextColor).toBe(WAR_MAIL_COLOR_FWA_WIN);
  });

  it("updates color for MM -> FWA draft transition using projected outcome", () => {
    const draft = buildDraftFromMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        confirmedRevisionBaseline: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "MM",
          expectedOutcome: null,
        },
        effectiveRevisionFields: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "MM",
          expectedOutcome: null,
        },
        projectedFwaOutcome: "LOSE",
      },
      targetType: "FWA",
    });

    expect(draft?.expectedOutcome).toBe("LOSE");
    const nextColor = resolveSingleClanMatchEmbedColorForTest({
      effectiveMatchType: draft?.matchType ?? "UNKNOWN",
      effectiveExpectedOutcome: draft?.expectedOutcome ?? null,
    });
    expect(nextColor).toBe(WAR_MAIL_COLOR_FWA_LOSE);
  });

  it("updates color immediately when FWA draft outcome is reversed", () => {
    const nextDraft = buildDraftFromOutcomeToggleForTest({
      view: {
        embed: {} as never,
        copyText: "",
        confirmedRevisionBaseline: {
          warId: "3003",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        effectiveRevisionFields: {
          warId: "3003",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
      },
      currentOutcome: "WIN",
    });

    expect(nextDraft?.expectedOutcome).toBe("LOSE");
    const nextColor = resolveSingleClanMatchEmbedColorForTest({
      effectiveMatchType: nextDraft?.matchType ?? "UNKNOWN",
      effectiveExpectedOutcome: nextDraft?.expectedOutcome ?? null,
    });
    expect(nextColor).toBe(WAR_MAIL_COLOR_FWA_LOSE);
  });
});
