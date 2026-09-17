import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";

vi.mock("axios");

const mockedAxios = vi.mocked(axios, true);

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

import {
  buildPointsSnapshotRequestKeyForTest,
  buildCurrentWarPointsUpdateForTest,
  canPreserveCurrentWarPointsForActiveWarForTest,
  classifyPointsSnapshotMatchupForTest,
  clearPointsSnapshotCachesForTest,
  getClanPointsCachedForTest,
  isPointsSnapshotEligibleForOpponentForTest,
  isPointsValidationCurrentForMatchupForTest,
  resolveCurrentMatchupBalanceForTest,
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

function allowedDecision(): any {
  return {
    allowed: true,
    outcome: "allowed",
    decisionCode: "allowed_unlocked",
    reason: "test access",
  };
}

function buildPointsHtml(
  primaryTag: string,
  opponentTag: string,
  primaryBalance = 1200,
  opponentBalance = 980,
): string {
  return `<main>Sync #477 Primary (${primaryTag}) vs. Opponent (${opponentTag}) (${primaryBalance} > ${opponentBalance}) Point Balance: ${primaryBalance} Active FWA: Yes</main>`;
}

function buildClanNotFoundHtml(): string {
  return "<main>Clan not found.</main>";
}

function buildClanNotFoundSnapshot(): any {
  return buildSnapshot({
    tag: "OPPONENT",
    lookupState: "clan_not_found",
    balance: null,
    notFound: true,
    winnerBoxText: null,
    winnerBoxTags: [],
    winnerBoxSync: null,
    effectiveSync: null,
    syncMode: null,
    winnerBoxHasTag: false,
    headerPrimaryTag: null,
    headerOpponentTag: null,
    headerPrimaryBalance: null,
    headerOpponentBalance: null,
  });
}

async function getCached(
  requiredOpponentTag?: string | null,
  tag = "#TRACK",
  extraOptions: Record<string, unknown> = {},
): Promise<any> {
  return getClanPointsCachedForTest(
    {} as any,
    {} as any,
    tag,
    null,
    undefined,
    requiredOpponentTag === undefined
      ? undefined
      : { requiredOpponentTag, fetchReason: "match_render", ...extraOptions },
  );
}

describe("FWA points matchup-safe cache reuse", () => {
  beforeEach(() => {
    clearPointsSnapshotCachesForTest();
    prismaMock.clanPointsSync.findFirst.mockReset();
    prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
    prismaMock.clanPointsSync.findMany.mockReset();
    prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
    mockedAxios.get.mockReset();
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "recordObservedPointValue",
    ).mockResolvedValue(undefined);
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

  it("accepts a fresh scrape that proves the requested opponent", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildPointsHtml("TRACK", "OPPONENT"),
    } as any);

    await expect(getCached("#OPPONENT")).resolves.toMatchObject({
      tag: "TRACK",
      balance: 1200,
      headerOpponentTag: "OPPONENT",
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("accepts fresh same-war evidence and reuses it within the same context", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockResolvedValue(allowedDecision());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildPointsHtml("TRACK", "OPPONENT"),
    } as any);
    const warContext = {
      guildId: "guild-1",
      warId: "123",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      currentSyncNumber: 477,
      sourceSyncNumber: 476,
    };

    await expect(
      getCached("#OPPONENT", "#TRACK", { warContext }),
    ).resolves.toMatchObject({ headerOpponentTag: "OPPONENT" });
    await expect(
      getCached("#OPPONENT", "#TRACK", { warContext }),
    ).resolves.toMatchObject({ headerOpponentTag: "OPPONENT" });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a fresh scrape for a different opponent and does not cache it", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockResolvedValueOnce(allowedDecision())
      .mockRejectedValueOnce(blockedError());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildPointsHtml("TRACK", "OTHER", 1999, 1888),
    } as any);

    await expect(getCached("#OPPONENT")).rejects.toThrow(
      "did not prove opponent",
    );
    await expect(getCached("#OPPONENT")).rejects.toBeInstanceOf(
      PointsDirectFetchBlockedError,
    );
    expect(gateSpy).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
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

  it("rejects a same-opponent cache from the wrong sync", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildSnapshot({ winnerBoxSync: 477, effectiveSync: 477 }),
      requestContext: {
        guildId: "guild-1",
        warId: "123",
        warStartTime: new Date("2026-03-08T00:00:00.000Z"),
        currentSyncNumber: 477,
        sourceSyncNumber: 476,
      },
    });

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a previous-war cache even when the opponent is unchanged", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildSnapshot({ winnerBoxSync: 477 }),
      requestContext: {
        guildId: "guild-1",
        warId: "122",
        warStartTime: new Date("2026-03-07T00:00:00.000Z"),
        currentSyncNumber: 477,
        sourceSyncNumber: 476,
      },
    });

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
  });

  it("rejects historical balances and not-found evidence when scoped war identity is unresolved", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    const unresolvedContext = {
      guildId: "guild-1",
      opponentTag: "#OPPONENT",
      currentSyncNumber: 478,
      sourceSyncNumber: 477,
    };
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildSnapshot(),
    });

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: unresolvedContext,
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);

    clearPointsSnapshotCachesForTest();
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildClanNotFoundSnapshot(),
    });
    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: unresolvedContext,
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
    expect(gateSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects an unscoped historical cache entry for a scoped active-war request", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({
      tag: "TRACK",
      snapshot: buildSnapshot(),
    });

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          opponentTag: "#OPPONENT",
          currentSyncNumber: 477,
          sourceSyncNumber: 476,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
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

  it("validates a shared in-flight result before either caller accepts it", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    let resolveResponse!: (response: unknown) => void;
    mockedAxios.get.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }) as any,
    );

    const first = getCached("#OPPONENT");
    const second = getCached("#OPPONENT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveResponse({
      status: 200,
      data: buildPointsHtml("TRACK", "OTHER"),
    });

    const results = await Promise.allSettled([first, second]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a shared in-flight request when it proves the same matchup", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    let resolveResponse!: (response: unknown) => void;
    mockedAxios.get.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }) as any,
    );

    const first = getCached("#OPPONENT");
    const second = getCached("#OPPONENT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveResponse({
      status: 200,
      data: buildPointsHtml("TRACK", "OPPONENT"),
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("does not share an in-flight result across active-war identities", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    let resolveResponse!: (response: unknown) => void;
    const response = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    mockedAxios.get.mockImplementation(() => response as any);

    const previousWar = getCached("#OPPONENT", "#TRACK", {
      warContext: {
        guildId: "guild-1",
        warId: "122",
        warStartTime: new Date("2026-03-07T00:00:00.000Z"),
        currentSyncNumber: 477,
        sourceSyncNumber: 476,
      },
    });
    const currentWar = getCached("#OPPONENT", "#TRACK", {
      warContext: {
        guildId: "guild-1",
        warId: "123",
        warStartTime: new Date("2026-03-08T00:00:00.000Z"),
        currentSyncNumber: 477,
        sourceSyncNumber: 476,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    resolveResponse({
      status: 200,
      data: buildPointsHtml("TRACK", "OPPONENT"),
    });

    const results = await Promise.allSettled([previousWar, currentWar]);
    // Raw points-site data has no war ID; the important invariant here is
    // that the incompatible requests performed independent fetches.
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
  });

  it("preserves an explicit direct clan_not_found result without matchup tags", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildClanNotFoundHtml(),
    } as any);

    await expect(getCached("#TRACK", "#OPPONENT")).resolves.toMatchObject({
      tag: "OPPONENT",
      lookupState: "clan_not_found",
      notFound: true,
      winnerBoxTags: [],
    });
  });

  it("accepts a freshly fetched direct clan_not_found for a scoped request", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildClanNotFoundHtml(),
    } as any);

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          opponentTag: "#TRACK",
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).resolves.toMatchObject({
      lookupState: "clan_not_found",
      notFound: true,
    });
  });

  it("keeps a fresh direct clan_not_found usable when scoped war identity is unresolved", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: buildClanNotFoundHtml(),
    } as any);

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          guildId: "guild-1",
          opponentTag: "#TRACK",
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).resolves.toMatchObject({
      lookupState: "clan_not_found",
      notFound: true,
    });
  });

  it("reuses cached clan_not_found only for the same war and sync context", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    const requestContext = {
      guildId: "guild-1",
      warId: "123",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#TRACK",
      currentSyncNumber: 478,
      sourceSyncNumber: 477,
    };
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
      requestContext,
    });

    await expect(
      getCached("#TRACK", "#OPPONENT", { warContext: requestContext }),
    ).resolves.toMatchObject({ notFound: true });
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("rejects cached clan_not_found when stored current sync is not ahead of the requested source sync", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    const storedContext = {
      guildId: "guild-1",
      warId: "123",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#TRACK",
      currentSyncNumber: 478,
      sourceSyncNumber: 477,
    };
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
      requestContext: storedContext,
    });

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          ...storedContext,
          currentSyncNumber: null,
          sourceSyncNumber: 478,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses cached clan_not_found when stored current sync is ahead of the requested source sync", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    const storedContext = {
      guildId: "guild-1",
      warId: "123",
      warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      opponentTag: "#TRACK",
      currentSyncNumber: 478,
      sourceSyncNumber: 477,
    };
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
      requestContext: storedContext,
    });

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          ...storedContext,
          currentSyncNumber: null,
          sourceSyncNumber: 477,
        },
      }),
    ).resolves.toMatchObject({ notFound: true });
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("rejects cached clan_not_found from a different war or incompatible sync", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    const previousWarContext = {
      guildId: "guild-1",
      warId: "122",
      warStartTime: new Date("2026-03-07T00:00:00.000Z"),
      opponentTag: "#TRACK",
      currentSyncNumber: 477,
      sourceSyncNumber: 476,
    };
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
      requestContext: previousWarContext,
    });

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          ...previousWarContext,
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);

    clearPointsSnapshotCachesForTest();
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
      requestContext: {
        ...previousWarContext,
        warId: "123",
        warStartTime: new Date("2026-03-08T00:00:00.000Z"),
      },
    });
    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          ...previousWarContext,
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
    expect(gateSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps an unscoped historical clan_not_found from proving a scoped war", async () => {
    const gateSpy = vi
      .spyOn(PointsDirectFetchGateService.prototype, "evaluateFetchAccess")
      .mockRejectedValue(blockedError());
    setPointsSnapshotCacheForTest({
      tag: "OPPONENT",
      snapshot: buildClanNotFoundSnapshot(),
    });

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          opponentTag: "#TRACK",
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps tracked-clan fallback usable when it proves the requested matchup", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockResolvedValue(allowedDecision());
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: buildClanNotFoundHtml() } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: buildPointsHtml("TRACK", "OPPONENT", 1200, 980),
      } as any);

    await expect(
      getCached("#TRACK", "#OPPONENT", {
        fallbackTrackedClanTag: "#TRACK",
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          opponentTag: "#TRACK",
          currentSyncNumber: 477,
          sourceSyncNumber: 476,
        },
      }),
    ).resolves.toMatchObject({
      tag: "OPPONENT",
      snapshotSource: "tracked_clan_fallback",
      lookupState: "clan_not_found",
      notFound: true,
      balance: 980,
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
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

    await expect(
      getCached("#CHANGED", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "124",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).rejects.toBeInstanceOf(
      PointsDirectFetchBlockedError,
    );

    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
  });

  it("uses an eligible persisted snapshot when the direct fetch is blocked", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockRejectedValue(blockedError());
    prismaMock.clanPointsSync.findMany.mockResolvedValue([
      {
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
      },
    ]);

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).resolves.toMatchObject({
      balance: 1300,
      headerOpponentTag: "OPPONENT",
    });
    expect(
      prismaMock.clanPointsSync.findMany.mock.calls[0]?.[0]?.where,
    ).toMatchObject({
      guildId: "guild-1",
      opponentTag: "#OPPONENT",
      needsValidation: false,
    });
  });

  it("rejects previous-war and needs-validation persisted rows", async () => {
    vi.spyOn(
      PointsDirectFetchGateService.prototype,
      "evaluateFetchAccess",
    ).mockRejectedValue(blockedError());
    prismaMock.clanPointsSync.findMany.mockResolvedValue([
      {
        warId: "122",
        warStartTime: new Date("2026-03-07T00:00:00.000Z"),
        syncNum: 477,
        lastKnownSyncNumber: 476,
        opponentTag: "#OPPONENT",
        clanPoints: 1300,
        opponentPoints: 1100,
        isFwa: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-07T01:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-07T01:00:00.000Z"),
      },
      {
        warId: "123",
        warStartTime: new Date("2026-03-08T00:00:00.000Z"),
        syncNum: 478,
        lastKnownSyncNumber: 477,
        opponentTag: "#OPPONENT",
        clanPoints: 1400,
        opponentPoints: 1200,
        isFwa: true,
        needsValidation: true,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T01:00:00.000Z"),
        syncFetchedAt: new Date("2026-03-08T01:00:00.000Z"),
      },
    ]);

    await expect(
      getCached("#OPPONENT", "#TRACK", {
        warContext: {
          guildId: "guild-1",
          warId: "123",
          warStartTime: new Date("2026-03-08T00:00:00.000Z"),
          currentSyncNumber: 478,
          sourceSyncNumber: 477,
        },
      }),
    ).rejects.toBeInstanceOf(PointsDirectFetchBlockedError);
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
      winnerBoxSync: 470,
      effectiveSync: 470,
    });
    setPointsSnapshotCacheForTest({ tag: "TRACK", snapshot });

    await expect(getCached()).resolves.toMatchObject(snapshot);

    expect(
      isPointsValidationCurrentForMatchupForTest({
        primarySnapshot: snapshot,
        opponentSnapshot: null,
        opponentTag: "#OLDOPPONENT",
        sourceSync: 476,
      }),
    ).toBe(false);

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
    expect(
      classifyPointsSnapshotMatchupForTest(primary, "OPPONENT"),
    ).toBe("mismatched");
    expect(resolveCurrentMatchupBalanceForTest(primary, false)).toBeNull();
  });

  it("only preserves unavailable CurrentWar points for the exact active identity", () => {
    const sameWar = {
      warId: 5001,
      startTime: new Date("2026-09-09T18:00:00.000Z"),
      opponentTag: "#OPPONENT",
    };

    expect(
      canPreserveCurrentWarPointsForActiveWarForTest({
        currentWar: sameWar,
        activeWarId: 5001,
        activeWarStartTime: new Date("2026-09-09T18:00:00.000Z"),
        activeOpponentTag: "#OPPONENT",
      }),
    ).toBe(true);
    expect(
      canPreserveCurrentWarPointsForActiveWarForTest({
        currentWar: sameWar,
        activeWarId: 5002,
        activeWarStartTime: new Date("2026-09-10T18:00:00.000Z"),
        activeOpponentTag: "#NEWOPPONENT",
      }),
    ).toBe(false);
    expect(
      canPreserveCurrentWarPointsForActiveWarForTest({
        currentWar: null,
        activeWarId: 5001,
        activeWarStartTime: new Date("2026-09-09T18:00:00.000Z"),
        activeOpponentTag: "#OPPONENT",
      }),
    ).toBe(false);

    expect(
      buildCurrentWarPointsUpdateForTest({
        currentWar: sameWar,
        activeWarId: 5001,
        activeWarStartTime: new Date("2026-09-09T18:00:00.000Z"),
        activeOpponentTag: "#OPPONENT",
        currentPrimaryBalance: null,
        currentOpponentBalance: null,
      }),
    ).toEqual({
      fwaPoints: undefined,
      opponentFwaPoints: undefined,
      warStartFwaPoints: undefined,
    });
    expect(
      buildCurrentWarPointsUpdateForTest({
        currentWar: sameWar,
        activeWarId: 5002,
        activeWarStartTime: new Date("2026-09-10T18:00:00.000Z"),
        activeOpponentTag: "#NEWOPPONENT",
        currentPrimaryBalance: null,
        currentOpponentBalance: null,
      }),
    ).toEqual({
      fwaPoints: null,
      opponentFwaPoints: null,
      warStartFwaPoints: undefined,
    });
    expect(
      buildCurrentWarPointsUpdateForTest({
        currentWar: null,
        activeWarId: 5001,
        activeWarStartTime: new Date("2026-09-09T18:00:00.000Z"),
        activeOpponentTag: "#OPPONENT",
        currentPrimaryBalance: 1300,
        currentOpponentBalance: 1100,
      }),
    ).toEqual({
      fwaPoints: 1300,
      opponentFwaPoints: 1100,
      warStartFwaPoints: { set: 1300 },
    });
  });
});
