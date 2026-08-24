import { describe, expect, it } from "vitest";
import {
  buildFwaPointsStrictLiveSyncIdentityForTest,
  deriveProjectedOutcomeForTest,
  formatFwaPointsSyncDisplayForTest,
  formatFwaPointsSyncFooterForTest,
  isFwaPointsCurrentWarSyncEligibleForTest,
  isPointsValidationCurrentForMatchupForTest,
  resolveFreshMatchupEvidenceForTest,
  resolveFwaPointsCurrentSyncForTest,
  resolveFwaPointsFooterSyncForTest,
  resolveManualMatchupFreshnessSourceSyncForTest,
} from "../src/commands/Fwa";
import { buildSyncMismatchWarning } from "../src/commands/fwa/matchState";
import {
  buildActiveWarSyncIdentity,
  resolveCurrentWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";

function buildSnapshot(overrides: Record<string, unknown>): any {
  return {
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
    winnerBoxSync: 477,
    effectiveSync: 477,
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
    ...overrides,
  };
}

describe("fwa manual fresh matchup evidence", () => {
  it("uses the predecessor of the resolved current sync as the manual freshness baseline", () => {
    expect(
      resolveManualMatchupFreshnessSourceSyncForTest({
        sourceSync: 477,
        resolvedCurrentSyncNum: 477,
      }),
    ).toBe(476);
  });

  it("applies the same freshness baseline to the tracked single-view currentness check", () => {
    const trackedFreshSourceSync =
      resolveManualMatchupFreshnessSourceSyncForTest({
        sourceSync: 493,
        resolvedCurrentSyncNum: 493,
      });
    const primary = buildSnapshot({
      winnerBoxSync: 493,
      effectiveSync: 493,
      headerPrimaryTag: "2TRACK",
      headerOpponentTag: "2OPP",
      headerOpponentBalance: 980,
    });
    const opponent = buildSnapshot({
      tag: "2OPP",
      url: "https://points.fwafarm.com/clan?tag=2OPP",
      snapshotSource: "direct",
      lookupState: "ok",
      balance: 980,
      clanName: "Opponent Clan",
      activeFwa: false,
      notFound: false,
      winnerBoxTags: ["2TRACK", "2OPP"],
      winnerBoxSync: 493,
      effectiveSync: 493,
      headerPrimaryTag: "2TRACK",
      headerOpponentTag: "2OPP",
      headerPrimaryBalance: 1200,
      headerOpponentBalance: 980,
      winnerBoxHasTag: true,
    });

    expect(
      isPointsValidationCurrentForMatchupForTest({
        primarySnapshot: primary,
        opponentSnapshot: opponent,
        opponentTag: "2OPP",
        sourceSync: trackedFreshSourceSync,
      }),
    ).toBe(true);
  });

  it("fetches fresh proof for both clans before classifying currentness", async () => {
    const calls: string[] = [];
    const primary = buildSnapshot({
      tag: "2TRACK",
      url: "https://points.fwafarm.com/clan?tag=2TRACK",
      winnerBoxTags: ["2TRACK", "2OPP"],
      winnerBoxSync: 477,
      effectiveSync: 477,
      headerPrimaryTag: "2TRACK",
      headerOpponentTag: "2OPP",
      headerOpponentBalance: 980,
    });
    const opponent = buildSnapshot({
      tag: "2OPP",
      url: "https://points.fwafarm.com/clan?tag=2OPP",
      snapshotSource: "direct",
      lookupState: "ok",
      balance: 980,
      clanName: "Opponent Clan",
      activeFwa: false,
      notFound: false,
      winnerBoxTags: ["2TRACK", "2OPP"],
      winnerBoxSync: 477,
      effectiveSync: 477,
      headerPrimaryTag: "2TRACK",
      headerOpponentTag: "2OPP",
      headerPrimaryBalance: 1200,
      headerOpponentBalance: 980,
      winnerBoxHasTag: true,
    });

    const resolved = await resolveFreshMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: 476,
      fetchClanPoints: async (tag: string) => {
        calls.push(tag);
        return tag === "2TRACK" ? primary : opponent;
      },
    });

    expect(calls).toEqual(["2TRACK", "2OPP"]);
    expect(resolved.siteCurrent).toBe(true);
    expect(resolved.siteCurrentFromPrimary).toBe(true);
  });

  it("still rejects stale freshness even with fresh proof sourcing", async () => {
    const manualFreshSourceSync =
      resolveManualMatchupFreshnessSourceSyncForTest({
        sourceSync: 476,
        resolvedCurrentSyncNum: 477,
      });
    const resolved = await resolveFreshMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: manualFreshSourceSync,
      fetchClanPoints: async (tag: string) =>
        buildSnapshot({
          tag,
          url: `https://points.fwafarm.com/clan?tag=${tag}`,
          winnerBoxTags: ["2TRACK", "2OPP"],
          winnerBoxSync: 476,
          effectiveSync: 476,
          headerPrimaryTag: "2TRACK",
          headerOpponentTag: "2OPP",
          headerOpponentBalance: 980,
        }),
    });

    expect(resolved.siteCurrent).toBe(false);
    expect(resolved.siteCurrentFromPrimary).toBe(false);
  });

  it("keeps opponent-tag mismatches out of currentness", async () => {
    const resolved = await resolveFreshMatchupEvidenceForTest({
      trackedClanTag: "2TRACK",
      opponentTag: "2OPP",
      sourceSync: 476,
      fetchClanPoints: async (tag: string) =>
        buildSnapshot({
          tag,
          url: `https://points.fwafarm.com/clan?tag=${tag}`,
          winnerBoxTags: ["2TRACK", "2OTHER"],
          winnerBoxSync: 477,
          effectiveSync: 477,
          headerPrimaryTag: "2TRACK",
          headerOpponentTag: "2OTHER",
          headerOpponentBalance: 980,
        }),
    });

    expect(resolved.siteCurrent).toBe(false);
    expect(resolved.usedTrackedFallback).toBe(false);
  });
});

describe("fwa points sync numbering regression", () => {
  const activeIdentity = buildActiveWarSyncIdentity({
    warState: "inWar",
    warStartTime: new Date("2026-08-10T20:00:00.000Z"),
    opponentTag: "2OPP",
  });

  it("keeps the alliance footer on the exact persisted sync", () => {
    expect(formatFwaPointsSyncFooterForTest(545)).toBe("Sync#: #545");
  });

  it("uses the unambiguous active-cycle sync for the alliance footer", () => {
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        activeCycleSyncNumber: 545,
      }),
    ).toBe(545);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(546);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
      }),
    ).toBe(545);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        resolvedActiveSyncNumbers: [546, 546],
        activeCurrentClanCount: 2,
      }),
    ).toBe(546);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        resolvedActiveSyncNumbers: [545, 546],
        activeCurrentClanCount: 2,
      }),
    ).toBeNull();
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        resolvedActiveSyncNumbers: [546],
        activeCurrentClanCount: 1,
      }),
    ).toBe(546);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        activeCycleSyncNumber: 546,
        resolvedActiveSyncNumbers: [545],
        exactResolvedActiveSyncNumbers: [545],
        activeCurrentClanCount: 1,
      }),
    ).toBe(545);
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        activeCycleSyncNumber: 546,
        resolvedActiveSyncNumbers: [545, 546],
        exactResolvedActiveSyncNumbers: [545],
        activeCurrentClanCount: 2,
      }),
    ).toBeNull();
    expect(
      resolveFwaPointsFooterSyncForTest({
        sourceSync: 545,
        activeCycleSyncNumber: 545,
        resolvedActiveSyncNumbers: [545],
        exactResolvedActiveSyncNumbers: [545],
        activeCurrentClanCount: 1,
      }),
    ).toBe(545);
    expect(
      formatFwaPointsSyncFooterForTest(
        resolveFwaPointsFooterSyncForTest({
          sourceSync: 545,
          activeCycleConflict: true,
        }),
      ),
    ).toBe("Sync#: unknown");
  });

  it("keeps tag-specific points on an already-resolved current sync", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: 545,
      }),
    ).toBe(545);
    expect(formatFwaPointsSyncDisplayForTest(545)).toContain("#545");
  });

  it("reuses an existing active cycle when this clan has not propagated its same-war row yet", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
        activeCycleSyncNumber: 545,
      }),
    ).toBe(545);
  });

  it("does not let a materialized CurrentWar sync override an active-cycle conflict", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        currentWarSyncNumber: 545,
        activeCycleConflict: true,
      }),
    ).toBeNull();
  });

  it("lets exact same-war points evidence supersede stale canonical CurrentWar sync", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: 545,
        currentWarSyncNumber: 546,
        activeCycleConflict: true,
      }),
    ).toBe(545);
  });

  it("fails closed for a genuinely new active war without sync evidence", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
      }),
    ).toBeNull();
  });

  it("does not invent parity from an already-current latest baseline", () => {
    const unresolvedSync = resolveFwaPointsCurrentSyncForTest({
      identity: activeIdentity,
      sourceSync: 552,
      sameWarPersistedSyncNumber: null,
    });

    expect(unresolvedSync).toBeNull();
    expect(formatFwaPointsSyncDisplayForTest(unresolvedSync)).toBe("unknown");
  });

  it("does not use a stale materialized CurrentWar parity value for outcomes", () => {
    const unresolvedSync = resolveFwaPointsCurrentSyncForTest({
      identity: activeIdentity,
      sourceSync: 552,
      sameWarPersistedSyncNumber: null,
      currentWarSyncNumber: 553,
    });

    expect(unresolvedSync).toBeNull();
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 1000, 1000, unresolvedSync),
    ).toBeNull();
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 1200, 980, unresolvedSync),
    ).toBe("WIN");
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 980, 1200, unresolvedSync),
    ).toBe("LOSE");
  });

  it("uses an evidence-backed active cycle despite stale CurrentWar sync", () => {
    const resolvedSync = resolveFwaPointsCurrentSyncForTest({
      identity: activeIdentity,
      sourceSync: 552,
      sameWarPersistedSyncNumber: null,
      currentWarSyncNumber: 553,
      activeCycleSyncNumber: 552,
      activeCycleConflict: false,
    });

    expect(resolvedSync).toBe(552);
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 1000, 1000, resolvedSync),
    ).toBe("WIN");
  });

  it("keeps unequal-point outcomes available while sync parity is unresolved", () => {
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 1200, 980, null),
    ).toBe("WIN");
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 980, 1200, null),
    ).toBe("LOSE");
    expect(
      deriveProjectedOutcomeForTest("2TRACK", "2OPP", 1000, 1000, null),
    ).toBeNull();
  });

  it("fails closed on an active-cycle conflict instead of deriving latest plus one", () => {
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: activeIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
        activeCycleConflict: true,
      }),
    ).toBeNull();
  });

  it("treats winner-box sync 545 as current, while sync 544 remains stale", () => {
    const freshnessBaseline =
      resolveManualMatchupFreshnessSourceSyncForTest({
        sourceSync: 545,
        resolvedCurrentSyncNum: 545,
      });
    const currentSnapshot = buildSnapshot({
      winnerBoxTags: ["2TRACK", "2OPP"],
      winnerBoxSync: 545,
      effectiveSync: 545,
    });
    const staleSnapshot = buildSnapshot({
      winnerBoxTags: ["2TRACK", "2OPP"],
      winnerBoxSync: 544,
      effectiveSync: 544,
    });

    expect(freshnessBaseline).toBe(544);
    expect(buildSyncMismatchWarning(545, 545)).toBeNull();
    expect(buildSyncMismatchWarning(545, 544)).toBe(
      "⚠️ Sync # mismatch: expected #545, site #544.",
    );
    expect(
      isPointsValidationCurrentForMatchupForTest({
        primarySnapshot: currentSnapshot,
        opponentSnapshot: null,
        opponentTag: "2OPP",
        sourceSync: freshnessBaseline,
      }),
    ).toBe(true);
    expect(
      isPointsValidationCurrentForMatchupForTest({
        primarySnapshot: staleSnapshot,
        opponentSnapshot: null,
        opponentTag: "2OPP",
        sourceSync: freshnessBaseline,
      }),
    ).toBe(false);
  });

  it("keeps alliance and tag-specific output on the same active sync", () => {
    expect(formatFwaPointsSyncFooterForTest(545)).toBe("Sync#: #545");
    expect(formatFwaPointsSyncDisplayForTest(545)).toBe("#545 (Low Sync)");
  });
});

describe("fwa tagged CurrentWar canonical sync live-identity eligibility", () => {
  const currentWarStartTime = new Date("2026-08-10T20:00:00.000Z");
  const oldWarStartTime = new Date("2026-08-10T20:00:00.000Z");
  const newWarStartTime = new Date("2026-08-11T20:00:00.000Z");
  const fallbackFilledIdentity = buildActiveWarSyncIdentity({
    warState: "inWar",
    warStartTime: oldWarStartTime,
    opponentTag: "2OPP",
  });

  it("accepts a full live start/opponent match", () => {
    expect(
      isFwaPointsCurrentWarSyncEligibleForTest({
        liveWarStartTime: "20260810T200000.000Z",
        liveOpponentTag: "#2OPP",
        currentWarStartTime,
        currentWarOpponentTag: "#2OPP",
      }),
    ).toBe(true);
  });

  it("keeps exact same-war points evidence when strict live identity is complete", () => {
    const strictLiveIdentity = buildFwaPointsStrictLiveSyncIdentityForTest({
      warState: "inWar",
      liveWarStartTime: "20260810T200000.000Z",
      liveOpponentTag: "#2OPP",
    });

    expect(strictLiveIdentity.positivelyResolved).toBe(true);
    expect(strictLiveIdentity.warStartTime).toEqual(oldWarStartTime);
    expect(strictLiveIdentity.opponentTag).toBe("20PP");
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: strictLiveIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: 545,
        currentWarSyncNumber: 546,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(545);
  });

  it.each([
    ["start mismatch", "20260810T210000.000Z", "#2OPP"],
    ["opponent mismatch", "20260810T200000.000Z", "#2OTHER"],
    ["missing live start", null, "#2OPP"],
    ["missing live opponent", "20260810T200000.000Z", null],
  ])("rejects %s", (_label, liveWarStartTime, liveOpponentTag) => {
    expect(
      isFwaPointsCurrentWarSyncEligibleForTest({
        liveWarStartTime,
        liveOpponentTag,
        currentWarStartTime,
        currentWarOpponentTag: "#2OPP",
      }),
    ).toBe(false);
  });

  it("does not let partial live identity self-confirm stale CurrentWar sync", () => {
    const identity = resolveCurrentWarSyncIdentity({
      clanTag: "2TRACK",
      warState: "inWar",
      liveWarStartTime: "20260810T200000.000Z",
      liveOpponentTag: null,
      currentWarId: 7001,
      currentWarStartTime,
      currentWarOpponentTag: "#2OPP",
    });

    expect(identity.positivelyResolved).toBe(true);
    const currentWarSyncEligible = isFwaPointsCurrentWarSyncEligibleForTest({
      liveWarStartTime: "20260810T200000.000Z",
      liveOpponentTag: null,
      currentWarStartTime,
      currentWarOpponentTag: "#2OPP",
    });
    expect(currentWarSyncEligible).toBe(false);
    const staleCanonicalSync = 545;
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity,
        sourceSync: 545,
        currentWarSyncNumber: currentWarSyncEligible
          ? staleCanonicalSync
          : null,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(546);
  });

  it("does not use an old points row when live start is missing", () => {
    const strictLiveIdentity = buildFwaPointsStrictLiveSyncIdentityForTest({
      warState: "inWar",
      liveWarStartTime: null,
      liveOpponentTag: "#2OPP",
    });

    expect(strictLiveIdentity.positivelyResolved).toBe(false);
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: fallbackFilledIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(546);
  });

  it("does not use an old points row when live opponent is missing", () => {
    const strictLiveIdentity = buildFwaPointsStrictLiveSyncIdentityForTest({
      warState: "inWar",
      liveWarStartTime: "20260810T200000.000Z",
      liveOpponentTag: null,
    });

    expect(strictLiveIdentity.positivelyResolved).toBe(false);
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: fallbackFilledIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(546);
  });

  it("scopes exact points evidence to the new live start during rollover", () => {
    const strictLiveIdentity = buildFwaPointsStrictLiveSyncIdentityForTest({
      warState: "inWar",
      liveWarStartTime: "20260811T200000.000Z",
      liveOpponentTag: "#2OPP",
    });

    expect(strictLiveIdentity.positivelyResolved).toBe(true);
    expect(strictLiveIdentity.warStartTime).toEqual(newWarStartTime);
    expect(strictLiveIdentity.warStartTime).not.toEqual(oldWarStartTime);
    expect(
      resolveFwaPointsCurrentSyncForTest({
        identity: strictLiveIdentity,
        sourceSync: 545,
        sameWarPersistedSyncNumber: null,
        activeCycleSyncNumber: 546,
      }),
    ).toBe(546);
  });
});
