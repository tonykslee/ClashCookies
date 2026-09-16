import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

import {
  buildPointsSnapshotRequestKeyForTest,
  clearPointsSnapshotCachesForTest,
  getClanPointsCachedForTest,
  isPointsSnapshotEligibleForOpponentForTest,
  isPointsValidationCurrentForMatchupForTest,
  setPointsSnapshotCacheForTest,
} from "../src/commands/Fwa";
import {
  PointsDirectFetchBlockedError,
  PointsDirectFetchGateService,
} from "../src/services/PointsDirectFetchGateService";

function buildSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    version: 5,
    tag: "TRACK",
    url: "https://points.fwafarm.com/clan?tag=TRACK",
    snapshotSource: "direct",
    lookupState: "ok",
    balance: 1200,
    clanName: "Tracked Clan",
    activeFwa: true,
    notFound: false,
    winnerBoxText: "Winner Box",
    winnerBoxTags: ["TRACK", "OPPONENT"],
    winnerBoxSync: 477,
    effectiveSync: 477,
    syncMode: "high",
    winnerBoxHasTag: true,
    headerPrimaryTag: "TRACK",
    headerOpponentTag: "OPPONENT",
    headerPrimaryBalance: 1200,
    headerOpponentBalance: 980,
    warEndMs: null,
    lastWarCheckAtMs: Date.now(),
    fetchedAtMs: Date.now(),
    refreshedForWarEndMs: null,
    ...overrides,
  };
}

function blockedError(): PointsDirectFetchBlockedError {
  return new PointsDirectFetchBlockedError({
    allowed: false,
    outcome: "blocked",
    decisionCode: "lock_active",
    reason: "test lock",
  } as any);
}

async function getCached(
  requiredOpponentTag?: string | null,
): Promise<any> {
  return getClanPointsCachedForTest(
    {} as any,
    {} as any,
    "#TRACK",
    null,
    undefined,
    requiredOpponentTag === undefined
      ? undefined
      : { requiredOpponentTag, fetchReason: "match_render" },
  );
}

describe("FWA points matchup-safe cache reuse", () => {
  beforeEach(() => {
    clearPointsSnapshotCachesForTest();
    prismaMock.clanPointsSync.findFirst.mockReset();
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits TTL cache for the same clan and opponent without another scrape", async () => {
    const gateSpy = vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    );
    const snapshot = buildSnapshot();
    setPointsSnapshotCacheForTest({ tag: "TRACK", snapshot });

    await expect(getCached("#OPPONENT")).resolves.toMatchObject(snapshot);

    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("rejects a changed opponent from a still-fresh TTL snapshot", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({ tag: "TRACK", snapshot: buildSnapshot() });

    await expect(getCached("#CHANGED")).rejects.toBeInstanceOf(
      PointsDirectFetchBlockedError,
    );

    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an in-flight request for another matchup", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());

    const results = await Promise.allSettled([
      getCached("#OPPONENT"),
      getCached("#CHANGED"),
    ]);

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(gateSpy).toHaveBeenCalledTimes(2);
    expect(buildPointsSnapshotRequestKeyForTest("#TRACK", "#OPPONENT")).not.toBe(
      buildPointsSnapshotRequestKeyForTest("#TRACK", "#CHANGED"),
    );
  });

  it("rejects incompatible stale cache data when the direct fetch is blocked", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildSnapshot(),
      expiresAtMs: Date.now() - 1,
    });

    await expect(getCached("#CHANGED")).rejects.toBeInstanceOf(
      PointsDirectFetchBlockedError,
    );

    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findFirst).toHaveBeenCalledTimes(1);
  });

  it("uses an eligible persisted snapshot when the direct fetch is blocked", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockRejectedValue(blockedError());
    prismaMock.clanPointsSync.findFirst.mockResolvedValue({
      warId: "123",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      syncNum: 478,
      lastKnownSyncNumber: 477,
      opponentTag: "#OPPONENT",
      clanPoints: 1300,
      opponentPoints: 1100,
      isFwa: true,
      needsValidation: false,
      lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T01:00:00.000Z"),
      syncFetchedAt: new Date("2026-03-08T01:00:00.000Z"),
    });

    await expect(getCached("#OPPONENT")).resolves.toMatchObject({
      balance: 1300,
      headerOpponentTag: "OPPONENT",
    });
    expect(
      prismaMock.clanPointsSync.findFirst.mock.calls[0]?.[0]?.where,
    ).toMatchObject({ opponentTag: "#OPPONENT" });
  });

  it("keeps blocked-fetch failure behavior when no eligible fallback exists", async () => {
    const error = blockedError();
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockRejectedValue(error);

    await expect(getCached("#OPPONENT")).rejects.toBe(error);
  });

  it("preserves legitimate cache reuse when no opponent is required", async () => {
    const gateSpy = vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    );
    const snapshot = buildSnapshot({
      winnerBoxTags: ["TRACK", "OLDOPPONENT"],
      headerOpponentTag: "OLDOPPONENT",
    });
    setPointsSnapshotCacheForTest({ tag: "TRACK", snapshot });

    await expect(getCached()).resolves.toMatchObject(snapshot);

    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("does not let mismatched data become current-matchup evidence", () => {
    const primary = buildSnapshot({
      winnerBoxTags: ["TRACK", "OTHER"],
      headerOpponentTag: "OTHER",
    });
    const opponent = buildSnapshot({
      tag: "OPPONENT",
      winnerBoxTags: ["TRACK", "OPPONENT"],
      headerOpponentTag: "OPPONENT",
    });

    expect(
      isPointsSnapshotEligibleForOpponentForTest(primary, "OPPONENT"),
    ).toBe(false);
    expect(
      isPointsValidationCurrentForMatchupForTest({
        primarySnapshot: primary,
        opponentSnapshot: opponent,
        opponentTag: "OPPONENT",
        sourceSync: 476,
      }),
    ).toBe(false);
  });
});
