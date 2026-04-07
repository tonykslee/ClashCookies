import { describe, expect, it } from "vitest";
import {
  buildOpponentSnapshotFromTrackedClanFallbackForTest,
  buildCurrentWarConfirmedStateForTest,
  buildSyncValidationStateForTest,
  buildDraftFromOutcomeToggleForTest,
  buildDraftFromMatchTypeSelectionForTest,
  buildEffectiveMatchMismatchWarningsForTest,
  buildMailSendGateDecisionForTest,
  buildInferredMatchWarningLinesForTest,
  buildNonActiveMailProjectionForTest,
  buildOverviewMailDecisionProjectionForTest,
  formatMailLifecycleStatusLineForTest,
  getMailBlockedReasonFromRevisionStateForTest,
  isPointsValidationCurrentForMatchupForTest,
  isLowConfidenceAllianceMismatchScenarioForTest,
  resolveWarMailFreshnessStatusForTest,
  resolveObservedSyncNumberForMatchupForTest,
  resolveMatchTypeSelectionForTest,
  resolveOpponentActiveFwaEvidenceForTest,
  resolveForceSyncMatchupEvidenceForTest,
  resolveSingleClanMatchEmbedColorForTest,
  buildSingleClanMatchLinksForTest,
  resolveAllianceDropdownMatchStateEmojiForTest,
  shouldDisplayInferredMatchTypeForTest,
  shouldHydrateAlliancePayloadForTest,
  resolveEffectiveFwaOutcomeForTest,
  resolveConfirmedRevisionBaselineForTest,
  resolveEffectiveRevisionStateForTest,
  resolveScopedDraftRevisionForTest,
} from "../src/commands/Fwa";
import {
  WAR_MAIL_COLOR_BL,
  WAR_MAIL_COLOR_FALLBACK,
  WAR_MAIL_COLOR_FWA_LOSE,
  WAR_MAIL_COLOR_FWA_WIN,
  WAR_MAIL_COLOR_MM,
  resolveWarMailEmbedColor,
} from "../src/commands/fwa/mailEmbedColor";

describe("fwa match revision baseline resolution", () => {
  it("uses confirmed ClanPointsSync baseline when war identity matches", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      syncRow: {
        warId: "123",
        opponentTag: "#2Q80R9PYU",
        lastKnownMatchType: "BL",
        lastKnownOutcome: null,
        isFwa: false,
        confirmedByClanMail: true,
      },
      mailConfig: null,
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

  it("keeps same-war posted refreshes anchored to the confirmed outcome baseline", () => {
    const confirmedState = buildCurrentWarConfirmedStateForTest({
      warId: 777,
      warStartMs: Date.parse("2026-03-12T00:00:00.000Z"),
      opponentTag: "2Q80R9PYU",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
    const liveFields = {
      warId: String(confirmedState?.warId ?? ""),
      opponentTag: "2Q80R9PYU",
      matchType: "FWA" as const,
      expectedOutcome: "WIN" as const,
    };
    const baseline = resolveConfirmedRevisionBaselineForTest({
      syncRow: {
        warId: String(confirmedState?.warId ?? ""),
        opponentTag: confirmedState?.opponentTag ?? "#2Q80R9PYU",
        lastKnownMatchType: confirmedState?.matchType ?? null,
        lastKnownOutcome: confirmedState?.outcome ?? null,
        isFwa: true,
        confirmedByClanMail: true,
      },
      mailConfig: {
        lastWarId: String(confirmedState?.warId ?? ""),
        lastOpponentTag: confirmedState?.opponentTag ?? "#2Q80R9PYU",
        lastMatchType: confirmedState?.matchType ?? null,
        lastExpectedOutcome: confirmedState?.outcome ?? null,
      },
      liveFields,
      lifecycleStatus: "posted",
    });
    const resolved = resolveEffectiveRevisionStateForTest({
      liveFields,
      confirmedBaseline: baseline,
      draft: null,
    });

    expect(baseline).toEqual({
      warId: "777",
      opponentTag: "2Q80R9PYU",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
    expect(resolved.effective).toEqual({
      warId: "777",
      opponentTag: "2Q80R9PYU",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
    expect(resolved.draftDiffersFromBaseline).toBe(false);
  });

  it("returns null for posted state when confirmed baseline is unavailable", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      syncRow: {
        warId: "999",
        opponentTag: "#ABC",
        lastKnownMatchType: "MM",
        lastKnownOutcome: null,
        isFwa: false,
        confirmedByClanMail: true,
      },
      mailConfig: null,
      liveFields: {
        warId: "123",
        opponentTag: "2Q80R9PYU",
        matchType: "FWA",
        expectedOutcome: "LOSE",
      },
      lifecycleStatus: "posted",
    });

    expect(baseline).toBeNull();
  });

  it("falls back to tracked mail-config baseline when posted sync checkpoint is unavailable", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      syncRow: null,
      mailConfig: {
        lastWarId: "123",
        lastOpponentTag: "#2Q80R9PYU",
        lastMatchType: "BL",
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
      matchType: "BL",
      expectedOutcome: null,
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

  it("keeps confirmed baseline effective when live outcome flips without a draft", () => {
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
        expectedOutcome: "LOSE",
      },
      draft: null,
    });

    expect(resolved.baseline).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
    expect(resolved.effective).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
    expect(resolved.appliedDraft).toBeNull();
    expect(resolved.draftDiffersFromBaseline).toBe(false);
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

  it("lets a manual draft override the confirmed baseline for the same war", () => {
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
        expectedOutcome: "LOSE",
      },
      draft: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL",
        expectedOutcome: null,
      },
    });

    expect(resolved.appliedDraft).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "BL",
      expectedOutcome: null,
    });
    expect(resolved.effective).toEqual({
      warId: "1001",
      opponentTag: "2TAG",
      matchType: "BL",
      expectedOutcome: null,
    });
    expect(resolved.draftDiffersFromBaseline).toBe(true);
  });
});

describe("fwa inferred warning visibility", () => {
  it("keeps the warning visible while the view is still inferred and no draft is applied", () => {
    expect(
      shouldDisplayInferredMatchTypeForTest({
        inferredMatchType: true,
        appliedDraft: null,
      })
    ).toBe(true);
  });

  it("clears the warning after a draft/confirmation is applied", () => {
    expect(
      shouldDisplayInferredMatchTypeForTest({
        inferredMatchType: true,
        appliedDraft: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
      })
    ).toBe(false);
  });
});

describe("fwa inferred warning rendering", () => {
  it("suppresses standalone inferred warning when inferred block reason is already present", () => {
    const lines = buildInferredMatchWarningLinesForTest({
      inferredMatchType: true,
      mailBlockedReason: "Match type is inferred. Confirm match type before sending mail.",
      includeSpacer: true,
    });

    expect(lines).toEqual([]);
  });

  it("renders standalone inferred warning when inferred and no inferred-block reason is present", () => {
    const lines = buildInferredMatchWarningLinesForTest({
      inferredMatchType: true,
      mailBlockedReason: null,
      includeSpacer: true,
    });

    expect(lines).toEqual([
      ":warning: Match type is inferred. Confirm match type before sending mail.",
      "\u200B",
    ]);
  });

  it("does not render inferred warning lines for confirmed match type", () => {
    const lines = buildInferredMatchWarningLinesForTest({
      inferredMatchType: false,
      mailBlockedReason: "Match type is inferred. Confirm match type before sending mail.",
      includeSpacer: true,
    });

    expect(lines).toEqual([]);
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
      hasConfirmedBaseline: true,
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
      hasConfirmedBaseline: true,
    });

    expect(reason).toBeNull();
  });

  it("does not block posted state when confirmed baseline is unavailable", () => {
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: false,
      hasMailChannel: true,
      mailStatus: "posted",
      appliedDraft: null,
      draftDiffersFromBaseline: false,
      hasConfirmedBaseline: false,
    });

    expect(reason).toBeNull();
  });

  it("does not report posted state as up-to-date across war identities", () => {
    const baseline = resolveConfirmedRevisionBaselineForTest({
      syncRow: {
        warId: "1001",
        opponentTag: "#2OLDWAR",
        lastKnownMatchType: "BL",
        lastKnownOutcome: null,
        isFwa: false,
        confirmedByClanMail: true,
      },
      mailConfig: {
        lastWarId: "1001",
        lastOpponentTag: "#2OLDWAR",
        lastMatchType: "BL",
        lastExpectedOutcome: null,
      },
      liveFields: {
        warId: "2002",
        opponentTag: "2NEWWAR",
        matchType: "FWA",
        expectedOutcome: "WIN",
      },
      lifecycleStatus: "posted",
    });
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: false,
      hasMailChannel: true,
      mailStatus: "posted",
      appliedDraft: null,
      draftDiffersFromBaseline: false,
      hasConfirmedBaseline: Boolean(baseline),
    });

    expect(baseline).toBeNull();
    expect(reason).toBeNull();
  });

  it("blocks send for inferred not-posted state even when a draft is present", () => {
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
      hasConfirmedBaseline: false,
    });

    expect(reason).toBe(
      "Match type is inferred. Confirm match type before sending mail."
    );
  });

  it("allows normal not-posted send gating once match type is confirmed", () => {
    const reason = getMailBlockedReasonFromRevisionStateForTest({
      inferredMatchType: false,
      hasMailChannel: true,
      mailStatus: "not_posted",
      appliedDraft: null,
      draftDiffersFromBaseline: false,
      hasConfirmedBaseline: false,
    });

    expect(reason).toBeNull();
  });
});

describe("fwa mail freshness status mapping", () => {
  it("maps posted + baseline match to sent/up-to-date", () => {
    const freshness = resolveWarMailFreshnessStatusForTest({
      lifecycleStatus: "posted",
      hasConfirmedBaseline: true,
      draftDiffersFromBaseline: false,
    });
    const line = formatMailLifecycleStatusLineForTest("posted", {
      hasConfirmedBaseline: true,
      draftDiffersFromBaseline: false,
    });

    expect(freshness).toBe("sent_up_to_date");
    expect(line).toBe("Mail status: **Mail Sent (Up to Date)**");
  });

  it("maps posted + effective drift to sent/out-of-date", () => {
    const freshness = resolveWarMailFreshnessStatusForTest({
      lifecycleStatus: "posted",
      hasConfirmedBaseline: true,
      draftDiffersFromBaseline: true,
    });
    const line = formatMailLifecycleStatusLineForTest("posted", {
      hasConfirmedBaseline: true,
      draftDiffersFromBaseline: true,
    });

    expect(freshness).toBe("sent_out_of_date");
    expect(line).toBe("Mail status: **Mail Sent (Out of Date)**");
  });

  it("maps not-posted lifecycle to unsent for new war identities", () => {
    const freshness = resolveWarMailFreshnessStatusForTest({
      lifecycleStatus: "not_posted",
      hasConfirmedBaseline: false,
      draftDiffersFromBaseline: false,
    });
    const line = formatMailLifecycleStatusLineForTest("not_posted", {
      hasConfirmedBaseline: false,
      draftDiffersFromBaseline: false,
    });

    expect(freshness).toBe("unsent");
    expect(line).toBe("Mail status: **Send Mail Available**");
  });
});

describe("fwa mail revision decision contract projection", () => {
  it("keeps gate and status line aligned for posted up-to-date state", () => {
    const decision = {
      mailStatus: {
        status: "posted" as const,
        mailStatusEmoji: ":mailbox_with_mail:",
        debug: {},
      },
      liveRevisionFields: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA" as const,
        expectedOutcome: "WIN" as const,
      },
      confirmedRevisionBaseline: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA" as const,
        expectedOutcome: "WIN" as const,
      },
      effectiveRevisionFields: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "FWA" as const,
        expectedOutcome: "WIN" as const,
      },
      appliedDraftRevision: null,
      draftDiffersFromBaseline: false,
      mailBlockedReason:
        "Current mail is already up to date. Change match config before sending again.",
    } as Parameters<typeof buildMailSendGateDecisionForTest>[0];

    const gate = buildMailSendGateDecisionForTest(decision);
    const statusLine = formatMailLifecycleStatusLineForTest(gate.mailStatus.status, {
      hasConfirmedBaseline: Boolean(gate.confirmedRevisionBaseline),
      draftDiffersFromBaseline: gate.draftDiffersFromBaseline,
    });

    expect(gate.mailStatus).toBe(decision.mailStatus);
    expect(gate.mailBlockedReason).toBe(decision.mailBlockedReason);
    expect(statusLine).toBe("Mail status: **Mail Sent (Up to Date)**");
  });

  it("keeps deleted lifecycle semantics aligned with resend availability", () => {
    const decision = {
      mailStatus: {
        status: "deleted" as const,
        mailStatusEmoji: ":mailbox_with_no_mail:",
        debug: {},
      },
      liveRevisionFields: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL" as const,
        expectedOutcome: null,
      },
      confirmedRevisionBaseline: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL" as const,
        expectedOutcome: null,
      },
      effectiveRevisionFields: {
        warId: "1001",
        opponentTag: "2TAG",
        matchType: "BL" as const,
        expectedOutcome: null,
      },
      appliedDraftRevision: null,
      draftDiffersFromBaseline: false,
      mailBlockedReason: null,
    } as Parameters<typeof buildMailSendGateDecisionForTest>[0];

    const gate = buildMailSendGateDecisionForTest(decision);
    const statusLine = formatMailLifecycleStatusLineForTest(gate.mailStatus.status, {
      hasConfirmedBaseline: Boolean(gate.confirmedRevisionBaseline),
      draftDiffersFromBaseline: gate.draftDiffersFromBaseline,
    });

    expect(gate.mailBlockedReason).toBeNull();
    expect(statusLine).toBe("Mail status: **Mail Deleted / Resend Available**");
  });

  it("keeps overview active-war status/action aligned with posted up-to-date decisions", () => {
    const projection = buildOverviewMailDecisionProjectionForTest({
      inferredMatchType: true,
      decision: {
        mailStatus: {
          status: "posted",
          mailStatusEmoji: ":mailbox_with_mail:",
          debug: {},
        },
        liveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        confirmedRevisionBaseline: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        effectiveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        appliedDraftRevision: null,
        draftDiffersFromBaseline: false,
        mailBlockedReason:
          "Current mail is already up to date. Change match config before sending again.",
      },
    } as Parameters<typeof buildOverviewMailDecisionProjectionForTest>[0]);

    expect(projection.mailLifecycleStatusLine).toBe(
      "Mail status: **Mail Sent (Up to Date)**"
    );
    expect(projection.mailActionEnabled).toBe(false);
    expect(projection.effectiveInferredMatchType).toBe(true);
  });

  it("enables action when a same-war draft differs from the posted baseline", () => {
    const projection = buildOverviewMailDecisionProjectionForTest({
      inferredMatchType: true,
      decision: {
        mailStatus: {
          status: "posted",
          mailStatusEmoji: ":mailbox_with_mail:",
          debug: {},
        },
        liveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "LOSE",
        },
        confirmedRevisionBaseline: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "FWA",
          expectedOutcome: "WIN",
        },
        effectiveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        appliedDraftRevision: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        draftDiffersFromBaseline: true,
        mailBlockedReason: null,
      },
    } as Parameters<typeof buildOverviewMailDecisionProjectionForTest>[0]);

    expect(projection.mailLifecycleStatusLine).toBe(
      "Mail status: **Mail Sent (Out of Date)**"
    );
    expect(projection.mailActionEnabled).toBe(true);
    expect(projection.effectiveInferredMatchType).toBe(false);
  });

  it("keeps not-posted status semantics unchanged for pre-war/no-opponent paths", () => {
    const projection = buildOverviewMailDecisionProjectionForTest({
      inferredMatchType: false,
      decision: {
        mailStatus: {
          status: "not_posted",
          mailStatusEmoji: ":mailbox_with_no_mail:",
          debug: {},
        },
        liveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        confirmedRevisionBaseline: null,
        effectiveRevisionFields: {
          warId: "1001",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        appliedDraftRevision: null,
        draftDiffersFromBaseline: false,
        mailBlockedReason: null,
      },
    } as Parameters<typeof buildOverviewMailDecisionProjectionForTest>[0]);

    expect(projection.mailLifecycleStatusLine).toBe(
      "Mail status: **Send Mail Available**"
    );
    expect(projection.mailActionEnabled).toBe(true);
  });

  it("aligns pre-war status/action semantics across overview and direct projections", () => {
    const projection = buildNonActiveMailProjectionForTest({
      mode: "pre_war",
      tag: "2RYGLU2UY",
      resolvedStatus: {
        status: "not_posted",
        mailStatusEmoji: ":mailbox_with_no_mail:",
        debug: {},
      },
      mailStatusDebugEnabled: false,
    } as Parameters<typeof buildNonActiveMailProjectionForTest>[0]);

    expect(projection.mailStatusLine).toBe("Mail status: **Send Mail Available**");
    expect(projection.mailAction).toBeUndefined();
  });

  it("aligns no-opponent status/action semantics across overview and direct projections", () => {
    const projection = buildNonActiveMailProjectionForTest({
      mode: "no_opponent",
      tag: "2RYGLU2UY",
      resolvedStatus: {
        status: "posted",
        mailStatusEmoji: ":mailbox_with_mail:",
        debug: {},
      },
      mailStatusDebugEnabled: false,
    } as Parameters<typeof buildNonActiveMailProjectionForTest>[0]);

    expect(projection.mailStatusLine).toBe("Mail status: **Mail Sent**");
    expect(projection.mailAction).toEqual({
      tag: "2RYGLU2UY",
      enabled: false,
      reason: "No active war opponent.",
    });
  });

  it("keeps non-active projection intentionally separate from active-war freshness semantics", () => {
    const projection = buildNonActiveMailProjectionForTest({
      mode: "pre_war",
      tag: "2RYGLU2UY",
      resolvedStatus: {
        status: "posted",
        mailStatusEmoji: ":mailbox_with_mail:",
        debug: {},
      },
      mailStatusDebugEnabled: false,
    } as Parameters<typeof buildNonActiveMailProjectionForTest>[0]);

    expect(projection.mailStatusLine).toBe("Mail status: **Mail Sent**");
  });
});

describe("fwa post-send current-war confirmation persistence", () => {
  it("builds canonical current-war confirmed BL state for same-war rerenders", () => {
    const state = buildCurrentWarConfirmedStateForTest({
      warId: 12345,
      warStartMs: Date.parse("2026-03-11T10:00:00.000Z"),
      opponentTag: "2Y2U9VRCR",
      matchType: "BL",
      expectedOutcome: null,
    });

    expect(state).toEqual({
      warId: 12345,
      startTime: new Date("2026-03-11T10:00:00.000Z"),
      opponentTag: "#2Y2U9VRCR",
      matchType: "BL",
      inferredMatchType: false,
      outcome: null,
    });
  });

  it("stores WIN/LOSE only for confirmed FWA outcomes", () => {
    const state = buildCurrentWarConfirmedStateForTest({
      warId: 555,
      warStartMs: Date.parse("2026-03-11T12:00:00.000Z"),
      opponentTag: "2OPP",
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    expect(state?.matchType).toBe("FWA");
    expect(state?.inferredMatchType).toBe(false);
    expect(state?.outcome).toBe("WIN");
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

describe("fwa explicit match-type confirmation", () => {
  it("treats selecting the same inferred visible type as an explicit confirmation", () => {
    const selection = resolveMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        matchTypeCurrent: "MM",
        inferredMatchType: true,
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
      },
      targetType: "MM",
    });

    expect(selection).toEqual({
      draft: null,
      explicitConfirmation: {
        matchType: "MM",
        expectedOutcome: null,
      },
    });
  });

  it("prefers explicit confirmation over draft when inferred view already shows the selected type", () => {
    const selection = resolveMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        matchTypeCurrent: "BL",
        inferredMatchType: true,
        confirmedRevisionBaseline: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "MM",
          expectedOutcome: null,
        },
        effectiveRevisionFields: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
        liveRevisionFields: {
          warId: "2002",
          opponentTag: "2TAG",
          matchType: "BL",
          expectedOutcome: null,
        },
      },
      targetType: "BL",
    });

    expect(selection).toEqual({
      draft: null,
      explicitConfirmation: {
        matchType: "BL",
        expectedOutcome: null,
      },
    });
  });

  it("treats selecting a different type on inferred view as explicit confirmation", () => {
    const selection = resolveMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        matchTypeCurrent: "MM",
        inferredMatchType: true,
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
      },
      targetType: "BL",
    });

    expect(selection).toEqual({
      draft: null,
      explicitConfirmation: {
        matchType: "BL",
        expectedOutcome: null,
      },
    });
  });

  it("keeps same-type selection as a no-op when the visible type is already confirmed", () => {
    const selection = resolveMatchTypeSelectionForTest({
      view: {
        embed: {} as never,
        copyText: "",
        matchTypeCurrent: "MM",
        inferredMatchType: false,
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
      },
      targetType: "MM",
    });

    expect(selection).toEqual({
      draft: null,
      explicitConfirmation: null,
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
      opponentActiveFwaEvidence: true,
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
      opponentActiveFwaEvidence: true,
    });

    expect(mismatch.outcomeMismatch).toBeNull();
    expect(mismatch.matchTypeVsFwaMismatch).toContain("Active FWA: YES");
  });

  it("does not show BL/MM active-fwa warning when evidence is NO", () => {
    const mismatch = buildEffectiveMatchMismatchWarningsForTest({
      siteUpdated: true,
      effectiveMatchType: "MM",
      effectiveExpectedOutcome: null,
      projectedOutcome: "LOSE",
      opponentActiveFwaEvidence: false,
    });

    expect(mismatch.matchTypeVsFwaMismatch).toBeNull();
  });
});

describe("fwa warning evidence helpers", () => {
  it("resolves active-fwa evidence from live_points source over null snapshot", () => {
    const yesEvidence = resolveOpponentActiveFwaEvidenceForTest({
      opponentActiveFwa: null,
      opponentNotFound: false,
      resolutionSource: "live_points_active_fwa_yes",
    });
    const noEvidence = resolveOpponentActiveFwaEvidenceForTest({
      opponentActiveFwa: null,
      opponentNotFound: false,
      resolutionSource: "live_points_active_fwa_no",
    });

    expect(yesEvidence).toBe(true);
    expect(noEvidence).toBe(false);
  });

  it("treats clan-not-found as non-YES evidence", () => {
    const evidence = resolveOpponentActiveFwaEvidenceForTest({
      opponentActiveFwa: true,
      opponentNotFound: true,
      resolutionSource: "live_points_clan_not_found",
    });

    expect(evidence).toBeNull();
  });
});

describe("fwa alliance low-confidence mismatch suppression", () => {
  it("marks clan-not-found evidence as low confidence", () => {
    const suppress = isLowConfidenceAllianceMismatchScenarioForTest({
      siteUpdated: true,
      opponentNotFound: true,
      opponentActiveFwaEvidence: null,
      resolutionSource: "live_points_clan_not_found",
    });

    expect(suppress).toBe(true);
  });

  it("marks explicit active-fwa evidence as high confidence", () => {
    const suppress = isLowConfidenceAllianceMismatchScenarioForTest({
      siteUpdated: true,
      opponentNotFound: false,
      opponentActiveFwaEvidence: false,
      resolutionSource: "live_points_active_fwa_no",
    });

    expect(suppress).toBe(false);
  });
});

describe("fwa sync validation status copy", () => {
  it("uses :warning: token for out-of-sync status", () => {
    const state = buildSyncValidationStateForTest({
      syncRow: {
        syncNum: 475,
        opponentTag: "#2TAG",
        clanPoints: 10,
        opponentPoints: 10,
        warStartTime: new Date("2026-03-10T00:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-10T00:00:00.000Z"),
        outcome: null,
        isFwa: false,
      },
      currentWarStartTime: new Date("2026-03-10T00:00:00.000Z"),
      siteCurrent: true,
      syncNum: 476,
      opponentTag: "2TAG",
      clanPoints: 10,
      opponentPoints: 10,
      outcome: null,
      isFwa: false,
    });

    expect(state.statusLine).toBe(":warning: Data not fully synced with points.fwafarm");
  });

  it("returns concise field-specific differences for war-changing validation", () => {
    const state = buildSyncValidationStateForTest({
      syncRow: {
        syncNum: 475,
        opponentTag: "#2OLDTAG",
        clanPoints: 10,
        opponentPoints: 10,
        warStartTime: new Date("2026-03-10T00:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-10T00:00:00.000Z"),
        outcome: "LOSE",
        isFwa: true,
        lastKnownMatchType: "FWA",
      },
      currentWarStartTime: new Date("2026-03-10T00:00:00.000Z"),
      siteCurrent: true,
      syncNum: 476,
      opponentTag: "2NEWTAG",
      clanPoints: 10,
      opponentPoints: 10,
      outcome: null,
      isFwa: false,
      effectiveMatchType: "BL",
      effectiveExpectedOutcome: null,
    });

    expect(state.differences).toEqual([
      "- Sync # mismatch: current #476, persisted #475",
      "- Opponent mismatch: current #2NEWTAG, persisted #2OLDTAG",
      "- Match type mismatch: current BL, persisted FWA",
      "- Outcome mismatch: current N/A, persisted LOSE",
    ]);
    expect(state.differences.some((line) => line.includes("points mismatch"))).toBe(false);
  });

  it("shows no mismatch lines when persisted validation matches effective display state", () => {
    const state = buildSyncValidationStateForTest({
      syncRow: {
        syncNum: 476,
        opponentTag: "#2TAG",
        clanPoints: 10,
        opponentPoints: 10,
        warStartTime: new Date("2026-03-10T00:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-10T00:00:00.000Z"),
        outcome: "WIN",
        isFwa: true,
        lastKnownMatchType: "FWA",
      },
      currentWarStartTime: new Date("2026-03-10T00:00:00.000Z"),
      siteCurrent: true,
      syncNum: 476,
      opponentTag: "2TAG",
      clanPoints: 10,
      opponentPoints: 10,
      outcome: "WIN",
      isFwa: true,
      effectiveMatchType: "FWA",
      effectiveExpectedOutcome: "WIN",
    });

    expect(state.differences).toEqual([]);
    expect(state.statusLine).toBe("✅ Data is in sync with points.fwafarm");
  });

  it("uses clan-not-found warning copy for opponent not-found validation mismatches", () => {
    const state = buildSyncValidationStateForTest({
      syncRow: {
        syncNum: 475,
        opponentTag: "#2TAG",
        clanPoints: 10,
        opponentPoints: 10,
        warStartTime: new Date("2026-03-10T00:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-10T00:00:00.000Z"),
        outcome: null,
        isFwa: false,
        lastKnownMatchType: "MM",
      },
      currentWarStartTime: new Date("2026-03-10T00:00:00.000Z"),
      siteCurrent: true,
      syncNum: 476,
      opponentTag: "2TAG",
      clanPoints: 10,
      opponentPoints: 10,
      outcome: null,
      isFwa: false,
      effectiveMatchType: "MM",
      effectiveExpectedOutcome: null,
      opponentNotFound: true,
    });

    expect(state.statusLine).toBe(":interrobang: Clan not found on points.fwafarm");
  });

  it("uses clan-not-found copy before validation becomes current when the opponent page is missing", () => {
    const state = buildSyncValidationStateForTest({
      syncRow: null,
      currentWarStartTime: new Date("2026-03-10T00:00:00.000Z"),
      siteCurrent: false,
      syncNum: 476,
      opponentTag: "2TAG",
      clanPoints: 10,
      opponentPoints: null,
      outcome: null,
      isFwa: false,
      opponentNotFound: true,
    });

    expect(state.statusLine).toBe(":interrobang: Clan not found on points.fwafarm");
  });
});

describe("fwa tracked-clan fallback snapshot", () => {
  const trackedSnapshot = {
    version: 5,
    tag: "2TRACK",
    url: "https://points.fwafarm.com/clan?tag=2TRACK",
    balance: 1200,
    clanName: "Tracked Clan",
    activeFwa: false,
    notFound: false,
    winnerBoxText: "Not marked as an FWA match",
    winnerBoxTags: ["2TRACK", "2OPP"],
    winnerBoxSync: 476,
    effectiveSync: 476,
    syncMode: "high" as const,
    winnerBoxHasTag: true,
    headerPrimaryName: "Tracked Clan",
    headerOpponentName: "Opponent Clan",
    headerPrimaryTag: "2TRACK",
    headerOpponentTag: "2OPP",
    headerPrimaryBalance: 1200,
    headerOpponentBalance: 980,
    warEndMs: null,
    lastWarCheckAtMs: 0,
    fetchedAtMs: 0,
    refreshedForWarEndMs: null,
  };

  it("applies tracked-page fallback when extracted opponent matches current war opponent", () => {
    const resolved = buildOpponentSnapshotFromTrackedClanFallbackForTest({
      requestedOpponentTag: "2OPP",
      trackedClanTag: "2TRACK",
      trackedSnapshot,
    });

    expect(resolved.currentForWar).toBe(true);
    expect(resolved.extractedOpponentTag).toBe("2OPP");
    expect(resolved.snapshot?.tag).toBe("2OPP");
    expect(resolved.snapshot?.balance).toBe(980);
    expect(resolved.snapshot?.clanName).toBe("Opponent Clan");
    expect(resolved.snapshot?.lookupState).toBe("clan_not_found");
    expect(resolved.snapshot?.notFound).toBe(true);
    expect(resolved.snapshot?.winnerBoxText).toBe("Not marked as an FWA match.");
  });

  it("does not apply fallback when tracked-page opponent does not match current war opponent", () => {
    const resolved = buildOpponentSnapshotFromTrackedClanFallbackForTest({
      requestedOpponentTag: "2NEWOPP",
      trackedClanTag: "2TRACK",
      trackedSnapshot,
    });

    expect(resolved.currentForWar).toBe(false);
    expect(resolved.extractedOpponentTag).toBe("2OPP");
    expect(resolved.snapshot).toBeNull();
  });
});

describe("fwa points validation current classification", () => {
  it("treats tracked-clan fallback as current when it proves the same opponent and newer sync", () => {
    const current = isPointsValidationCurrentForMatchupForTest({
      primarySnapshot: {
        winnerBoxTags: [],
        winnerBoxSync: 474,
      },
      opponentSnapshot: {
        snapshotSource: "tracked_clan_fallback",
        fallbackCurrentForWar: true,
        fallbackExtractedOpponentTag: "2OPP",
        winnerBoxSync: 475,
      },
      opponentTag: "2OPP",
      sourceSync: 474,
    });

    expect(current).toBe(true);
  });

  it("does not treat fallback as current when fallback sync is not newer than source sync", () => {
    const current = isPointsValidationCurrentForMatchupForTest({
      primarySnapshot: {
        winnerBoxTags: [],
        winnerBoxSync: 474,
      },
      opponentSnapshot: {
        snapshotSource: "tracked_clan_fallback",
        fallbackCurrentForWar: true,
        fallbackExtractedOpponentTag: "2OPP",
        winnerBoxSync: 474,
      },
      opponentTag: "2OPP",
      sourceSync: 474,
    });

    expect(current).toBe(false);
  });
});

describe("force sync matchup current evidence contract", () => {
  it("accepts primary winner-box proof as current for the active opponent", () => {
    const resolved = resolveForceSyncMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: 474,
      primarySnapshot: {
        version: 5,
        tag: "2TRACK",
        url: "https://points.fwafarm.com/clan?tag=2TRACK",
        snapshotSource: "direct",
        lookupState: "ok",
        balance: 1200,
        clanName: "Tracked Clan",
        activeFwa: true,
        notFound: false,
        winnerBoxText: "Winner Box",
        winnerBoxTags: ["2TRACK", "2OPP"],
        winnerBoxSync: 475,
        effectiveSync: 475,
        syncMode: "high",
        winnerBoxHasTag: true,
        headerPrimaryTag: "2TRACK",
        headerOpponentTag: "2OPP",
        headerPrimaryBalance: 1200,
        headerOpponentBalance: 980,
        warEndMs: null,
        lastWarCheckAtMs: 0,
        fetchedAtMs: 0,
        refreshedForWarEndMs: null,
      },
      directOpponentSnapshot: null,
    });

    expect(resolved.siteCurrent).toBe(true);
    expect(resolved.siteCurrentFromPrimary).toBe(true);
    expect(resolved.usedTrackedFallback).toBe(false);
  });

  it("uses tracked-clan fallback proof when direct opponent evidence is unavailable", () => {
    const resolved = resolveForceSyncMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: 474,
      primarySnapshot: {
        version: 5,
        tag: "2TRACK",
        url: "https://points.fwafarm.com/clan?tag=2TRACK",
        snapshotSource: "direct",
        lookupState: "ok",
        balance: 1200,
        clanName: "Tracked Clan",
        activeFwa: true,
        notFound: false,
        winnerBoxText: "Winner Box",
        winnerBoxTags: ["2TRACK"],
        winnerBoxSync: 475,
        effectiveSync: 475,
        syncMode: "high",
        winnerBoxHasTag: true,
        headerPrimaryName: "Tracked Clan",
        headerOpponentName: "Opponent Clan",
        headerPrimaryTag: "2TRACK",
        headerOpponentTag: "2OPP",
        headerPrimaryBalance: 1200,
        headerOpponentBalance: 980,
        warEndMs: null,
        lastWarCheckAtMs: 0,
        fetchedAtMs: 0,
        refreshedForWarEndMs: null,
      },
      directOpponentSnapshot: {
        version: 5,
        tag: "2OPP",
        url: "https://points.fwafarm.com/clan?tag=2OPP",
        snapshotSource: "direct",
        lookupState: "clan_not_found",
        balance: null,
        clanName: null,
        activeFwa: null,
        notFound: true,
        winnerBoxText: "Clan not found.",
        winnerBoxTags: [],
        winnerBoxSync: null,
        effectiveSync: null,
        syncMode: null,
        winnerBoxHasTag: false,
        headerPrimaryTag: null,
        headerOpponentTag: null,
        headerPrimaryBalance: null,
        headerOpponentBalance: null,
        warEndMs: null,
        lastWarCheckAtMs: 0,
        fetchedAtMs: 0,
        refreshedForWarEndMs: null,
      },
    });

    expect(resolved.siteCurrent).toBe(true);
    expect(resolved.usedTrackedFallback).toBe(true);
    expect(resolved.opponentSnapshot?.snapshotSource).toBe("tracked_clan_fallback");
    expect(resolved.opponentSnapshot?.notFound).toBe(true);
  });

  it("stays not-current when neither primary nor fallback can prove the active matchup", () => {
    const resolved = resolveForceSyncMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: 475,
      primarySnapshot: {
        version: 5,
        tag: "2TRACK",
        url: "https://points.fwafarm.com/clan?tag=2TRACK",
        snapshotSource: "direct",
        lookupState: "ok",
        balance: 1200,
        clanName: "Tracked Clan",
        activeFwa: true,
        notFound: false,
        winnerBoxText: "Winner Box",
        winnerBoxTags: ["2TRACK", "2OLD"],
        winnerBoxSync: 475,
        effectiveSync: 475,
        syncMode: "high",
        winnerBoxHasTag: true,
        headerPrimaryName: "Tracked Clan",
        headerOpponentName: "Different Opponent",
        headerPrimaryTag: "2TRACK",
        headerOpponentTag: "2OLD",
        headerPrimaryBalance: 1200,
        headerOpponentBalance: 980,
        warEndMs: null,
        lastWarCheckAtMs: 0,
        fetchedAtMs: 0,
        refreshedForWarEndMs: null,
      },
      directOpponentSnapshot: null,
    });

    expect(resolved.siteCurrent).toBe(false);
    expect(resolved.usedTrackedFallback).toBe(false);
  });
});

describe("fwa observed sync resolution", () => {
  it("prefers tracked-clan fallback sync when it proves the current war", () => {
    const sync = resolveObservedSyncNumberForMatchupForTest({
      primarySnapshot: {
        effectiveSync: 474,
      },
      opponentSnapshot: {
        snapshotSource: "tracked_clan_fallback",
        fallbackCurrentForWar: true,
        effectiveSync: 476,
      },
    });

    expect(sync).toBe(476);
  });

  it("prefers tracked fallback winner-box sync when effective sync is stale/overlaid", () => {
    const sync = resolveObservedSyncNumberForMatchupForTest({
      primarySnapshot: {
        effectiveSync: 474,
      },
      opponentSnapshot: {
        snapshotSource: "tracked_clan_fallback",
        fallbackCurrentForWar: true,
        effectiveSync: 474,
        winnerBoxSync: 476,
      },
    });

    expect(sync).toBe(476);
  });

  it("prefers primary winner-box sync when the page proves the tracked clan tag", () => {
    const sync = resolveObservedSyncNumberForMatchupForTest({
      primarySnapshot: {
        effectiveSync: 474,
        winnerBoxSync: 476,
        winnerBoxHasTag: true,
      },
      opponentSnapshot: null,
    });

    expect(sync).toBe(476);
  });
});

describe("fwa alliance payload hydration flag", () => {
  it("requires hydration for scoped payloads with guild context", () => {
    expect(
      shouldHydrateAlliancePayloadForTest({
        allianceViewIsScoped: true,
        guildId: "123",
      })
    ).toBe(true);
  });

  it("skips hydration when payload already has full alliance view", () => {
    expect(
      shouldHydrateAlliancePayloadForTest({
        allianceViewIsScoped: false,
        guildId: "123",
      })
    ).toBe(false);
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

describe("fwa single-clan links presentation", () => {
  it("keeps plain points header and includes labeled us/them links for cc and points", () => {
    const rendered = buildSingleClanMatchLinksForTest({
      trackedClanTag: "#CLAN123",
      opponentTag: "#OPPO456",
    });

    expect(rendered.linksFieldName).toBe("Links");
    expect(rendered.linksFieldValue).toContain(
      "[cc.fwafarm (them)](<https://cc.fwafarm.com/cc_n/clan.php?tag=OPPO456>)"
    );
    expect(rendered.linksFieldValue).toContain(
      "[cc.fwafarm (us)](<https://cc.fwafarm.com/cc_n/clan.php?tag=CLAN123>)"
    );
    expect(rendered.linksFieldValue).toContain(
      "[points.fwafarm (them)](<https://points.fwafarm.com/clan?tag=OPPO456>)"
    );
    expect(rendered.linksFieldValue).toContain(
      "[points.fwafarm (us)](<https://points.fwafarm.com/clan?tag=CLAN123>)"
    );
    expect(rendered.linksFieldValue).not.toContain("lvoJgZB.png");
    expect(rendered.pointsFieldName).toBe("Points");
  });

  it("labels copy output links with deterministic us/them ownership", () => {
    const rendered = buildSingleClanMatchLinksForTest({
      trackedClanTag: "#TEAM999",
      opponentTag: "#ENEMY111",
    });

    expect(rendered.copyLines).toEqual([
      "CC (them): [cc.fwafarm](<https://cc.fwafarm.com/cc_n/clan.php?tag=ENEMY111>)",
      "CC (us): [cc.fwafarm](<https://cc.fwafarm.com/cc_n/clan.php?tag=TEAM999>)",
      "Points (them): [points.fwafarm](<https://points.fwafarm.com/clan?tag=ENEMY111>)",
      "Points (us): [points.fwafarm](<https://points.fwafarm.com/clan?tag=TEAM999>)",
    ]);
    expect(rendered.copyLines.join("\n")).not.toContain("lvoJgZB.png");
  });
});

describe("fwa alliance dropdown state emoji", () => {
  it("maps effective displayed match state to the expected dropdown emoji", () => {
    const cases: Array<{
      view: {
        matchTypeCurrent?: "FWA" | "BL" | "MM" | "SKIP" | null;
        outcomeAction?: { tag: string; currentOutcome: "WIN" | "LOSE" } | null;
      } | null;
      expected: "⚪" | "⚫" | "🟢" | "🔴" | "💤";
    }> = [
      { view: { matchTypeCurrent: "MM" }, expected: "⚪" },
      { view: { matchTypeCurrent: "BL" }, expected: "⚫" },
      {
        view: {
          matchTypeCurrent: "FWA",
          outcomeAction: { tag: "TAG1", currentOutcome: "WIN" },
        },
        expected: "🟢",
      },
      {
        view: {
          matchTypeCurrent: "FWA",
          outcomeAction: { tag: "TAG1", currentOutcome: "LOSE" },
        },
        expected: "🔴",
      },
      { view: { matchTypeCurrent: "FWA", outcomeAction: null }, expected: "💤" },
      { view: { matchTypeCurrent: "SKIP" }, expected: "💤" },
      { view: null, expected: "💤" },
    ];

    for (const testCase of cases) {
      expect(
        resolveAllianceDropdownMatchStateEmojiForTest(testCase.view as any),
      ).toBe(testCase.expected);
    }
  });
});
