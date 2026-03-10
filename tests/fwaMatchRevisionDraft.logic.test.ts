import { describe, expect, it } from "vitest";
import {
  buildOpponentSnapshotFromTrackedClanFallbackForTest,
  buildSyncValidationStateForTest,
  buildDraftFromOutcomeToggleForTest,
  buildDraftFromMatchTypeSelectionForTest,
  buildEffectiveMatchMismatchWarningsForTest,
  getMailBlockedReasonFromRevisionStateForTest,
  isPointsValidationCurrentForMatchupForTest,
  isLowConfidenceAllianceMismatchScenarioForTest,
  resolveMatchTypeSelectionForTest,
  resolveOpponentActiveFwaEvidenceForTest,
  resolveSingleClanMatchEmbedColorForTest,
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
      hasConfirmedBaseline: false,
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

    expect(state.statusLine).toBe(":warning: clan not found in points.fwafarm");
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
