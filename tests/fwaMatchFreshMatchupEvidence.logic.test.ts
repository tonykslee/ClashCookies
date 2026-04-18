import { describe, expect, it } from "vitest";
import {
  resolveFreshMatchupEvidenceForTest,
  resolveManualMatchupFreshnessSourceSyncForTest,
} from "../src/commands/Fwa";

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
