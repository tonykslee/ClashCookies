import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
  },
  fwaClanCatalog: {
    findFirst: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  fwaClanWarLogCurrent: {
    findMany: vi.fn(),
  },
}));

const warPlanHistoryMock = vi.hoisted(() => ({
  getClanLeaderboardForCutoff: vi.fn(),
  getClanLeaderboardForSyncNumbers: vi.fn(),
}));

const historicalWindowMock = vi.hoisted(() => ({
  resolveLatestSyncWindow: vi.fn(),
}));

const compositionMock = vi.hoisted(() => ({
  readTrackedClanCurrentComposition: vi.fn(),
  readExternalClanCurrentComposition: vi.fn(),
}));

const syncStateMock = vi.hoisted(() => ({
  getState: vi.fn(),
}));

const warsSyncMock = vi.hoisted(() => ({
  syncClan: vi.fn(),
}));

const homeRosterMock = vi.hoisted(() => ({
  getClanHomeRoster: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  ClanHealthSnapshotService,
  normalizeClanHealthWindowDays,
} from "../src/services/ClanHealthSnapshotService";

describe("ClanHealthSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findFirst.mockReset();
    prismaMock.fwaClanCatalog.findFirst.mockReset();
    prismaMock.clanWarHistory.findMany.mockReset();
    prismaMock.clanWarParticipation.findMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.fwaClanWarLogCurrent.findMany.mockReset();
    compositionMock.readTrackedClanCurrentComposition.mockResolvedValue(
      makeCompositionSnapshot(),
    );
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot(),
    );
    syncStateMock.getState.mockReset();
    syncStateMock.getState.mockResolvedValue(null);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockReset();
    warPlanHistoryMock.getClanLeaderboardForSyncNumbers.mockReset();
    warPlanHistoryMock.getClanLeaderboardForSyncNumbers.mockImplementation(() =>
      warPlanHistoryMock.getClanLeaderboardForCutoff(),
    );
    historicalWindowMock.resolveLatestSyncWindow.mockReset();
    historicalWindowMock.resolveLatestSyncWindow.mockResolvedValue({
      kind: "syncs",
      requestedSyncCount: 30,
      startSyncNumber: 516,
      endSyncNumber: 545,
      syncNumbers: Array.from({ length: 30 }, (_, index) => index + 516),
    });
    warsSyncMock.syncClan.mockResolvedValue({
      rowCount: 0,
      changedRowCount: 0,
      contentHash: null,
      status: "NOOP",
    });
    homeRosterMock.getClanHomeRoster.mockResolvedValue({
      guildId: "guild-1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      homeMemberCount: 0,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 0,
      openHomeSpots: 50,
      currentClanMemberCount: 0,
      unassignedPresentCount: 0,
      pendingTransferCount: 0,
      currentRosterCoverage: "UNAVAILABLE" as const,
      currentRosterObservedAt: null,
      members: [],
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createService() {
    return new ClanHealthSnapshotService(
      prismaMock as any,
      compositionMock as any,
      warPlanHistoryMock as any,
      syncStateMock as any,
      warsSyncMock as any,
      historicalWindowMock as any,
      homeRosterMock as any,
    );
  }

  function makeCompositionSnapshot(input?: Partial<Record<string, unknown>>) {
    return {
      viewType: "tracked",
      clanTag: "#AAA111",
      clanName: "Alpha",
      shortName: null,
      displayCounts: {
        TH18: 0,
        TH17: 0,
        TH16: 0,
        TH15: 0,
        TH14: 0,
        "<=TH13": 0,
      },
      memberCount: 50,
      unresolvedWeightCount: 0,
      sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      sourceAgeMs: 3_600_000,
      selectedHeatMapRefAvailable: true,
      deviationScore: 4,
      healthy: true,
      ...input,
    };
  }

  function makeExternalCompositionSnapshot(input?: Partial<Record<string, unknown>>) {
    return {
      viewType: "external",
      clanTag: "#AAA111",
      clanName: "Alpha",
      displayCounts: {
        TH18: 5,
        TH17: 7,
        TH16: 8,
        TH15: 10,
        TH14: 9,
        "<=TH13": 11,
      },
      memberCount: 50,
      unresolvedWeightCount: 0,
      estimatedWeight: 145000,
      sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      sourceAgeMs: 3_600_000,
      selectedHeatMapRefAvailable: true,
      compositionComplete: true,
      deviationScore: 0,
      healthy: true,
      ...input,
    };
  }

  it("normalizes the optional historical window to the supported bounded integer", () => {
    expect(normalizeClanHealthWindowDays(undefined)).toBe(30);
    expect(normalizeClanHealthWindowDays("not-a-number")).toBe(30);
    expect(normalizeClanHealthWindowDays(3)).toBe(7);
    expect(normalizeClanHealthWindowDays(90.9)).toBe(90);
    expect(normalizeClanHealthWindowDays(999)).toBe(180);
  });

  it("returns null for non-tracked clan", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue(null);
    const service = createService();

    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#MISSING",
    });

    expect(snapshot).toBeNull();
    expect(prismaMock.clanWarHistory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.playerActivity.findMany).not.toHaveBeenCalled();
    expect(warPlanHistoryMock.getClanLeaderboardForCutoff).not.toHaveBeenCalled();
  });

  it("returns an external snapshot with shared war classification for fresh persisted rows", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT111",
      name: "External Alpha",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-09T11:45:00.000Z"),
        result: "win",
        opponentInfo: "FWA",
        sourceSyncedAt: new Date("2026-03-09T11:45:00.000Z"),
      },
      {
        endTime: new Date("2026-03-09T11:30:00.000Z"),
        result: "LOSE",
        opponentInfo: "Friendly",
        sourceSyncedAt: new Date("2026-03-09T11:30:00.000Z"),
      },
      {
        endTime: new Date("2026-03-09T11:15:00.000Z"),
        result: "WIN",
        opponentInfo: "Blacklisted",
        sourceSyncedAt: new Date("2026-03-09T11:15:00.000Z"),
      },
      {
        endTime: new Date("2026-03-09T11:00:00.000Z"),
        result: "LOSE",
        opponentInfo: "Unknown",
        sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      },
      {
        endTime: new Date("2026-03-09T10:45:00.000Z"),
        result: "WIN",
        opponentInfo: null,
        sourceSyncedAt: new Date("2026-03-09T10:45:00.000Z"),
      },
    ]);
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT111",
        clanName: "External Alpha",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#ext111",
    });

    expect(snapshot?.viewType).toBe("external");
    expect(snapshot?.clanTag).toBe("#EXT111");
    expect(snapshot?.warPerformance).toMatchObject({
      endedWarSampleSize: 4,
      recognizedWarRows: 4,
      fwaMatchCount: 2,
      fwaWinCount: 1,
      fwaLossCount: 1,
      blMatchCount: 1,
      mmMatchCount: 1,
      blInclusiveMatchCount: 3,
      winCount: 2,
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 5,
      recognizedWarRows: 4,
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
    expect(warsSyncMock.syncClan).not.toHaveBeenCalled();
  });

  it("treats a NOOP sync as fresh for six hours and skips a second refresh", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXTNOOP",
      name: "External Noop",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-09T04:00:00.000Z"),
        result: "WIN",
        opponentInfo: "FWA",
        sourceSyncedAt: new Date("2026-03-09T04:00:00.000Z"),
      },
    ]);
    syncStateMock.getState
      .mockResolvedValueOnce({
        lastSuccessAt: new Date("2026-03-09T04:00:00.000Z"),
        lastStatus: "SUCCESS",
      })
      .mockResolvedValue({
        lastSuccessAt: new Date("2026-03-09T12:00:00.000Z"),
        lastStatus: "NOOP",
      });
    warsSyncMock.syncClan.mockResolvedValueOnce({
      rowCount: 1,
      changedRowCount: 0,
      contentHash: "hash",
      status: "NOOP",
    });
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXTNOOP",
        clanName: "External Noop",
      }),
    );

    const service = createService();
    const firstSnapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXTNOOP",
    });
    const secondSnapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXTNOOP",
    });

    expect(warsSyncMock.syncClan).toHaveBeenCalledTimes(1);
    expect(firstSnapshot?.warPerformance).toMatchObject({
      refreshStatus: "noop",
      staleFallbackUsed: false,
    });
    expect(firstSnapshot?.telemetry).toMatchObject({
      refreshStatus: "noop",
      staleFallbackUsed: false,
    });
    expect(firstSnapshot?.warPerformance?.sourceAgeMs ?? null).toBe(0);
    expect(firstSnapshot?.telemetry.warSourceAgeMs ?? null).toBe(0);
    expect(secondSnapshot?.warPerformance).toMatchObject({
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
    expect(secondSnapshot?.telemetry).toMatchObject({
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
  });

  it("refreshes stale external rows once and rereads refreshed data", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT222",
      name: "External Bravo",
    });
    prismaMock.fwaClanWarLogCurrent.findMany
      .mockResolvedValueOnce([
        {
          endTime: new Date("2026-03-09T05:00:00.000Z"),
          result: "WIN",
          opponentInfo: "FWA",
          sourceSyncedAt: new Date("2026-03-09T05:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          endTime: new Date("2026-03-09T11:50:00.000Z"),
          result: "LOSE",
          opponentInfo: "BLACKLISTED",
          sourceSyncedAt: new Date("2026-03-09T11:50:00.000Z"),
        },
      ]);
    syncStateMock.getState
      .mockResolvedValueOnce({
        lastSuccessAt: new Date("2026-03-09T05:00:00.000Z"),
        lastStatus: "SUCCESS",
      })
      .mockResolvedValueOnce({
        lastSuccessAt: new Date("2026-03-09T12:00:00.000Z"),
        lastStatus: "SUCCESS",
      });
    warsSyncMock.syncClan.mockResolvedValueOnce({
      rowCount: 1,
      changedRowCount: 1,
      contentHash: "hash",
      status: "SUCCESS",
    });
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT222",
        clanName: "External Bravo",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXT222",
    });

    expect(warsSyncMock.syncClan).toHaveBeenCalledWith("#EXT222", {
      force: false,
      minimumIntervalMs: 15 * 60 * 1000,
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    expect(prismaMock.fwaClanWarLogCurrent.findMany).toHaveBeenCalledTimes(2);
    expect(snapshot?.warPerformance).toMatchObject({
      endedWarSampleSize: 1,
      recognizedWarRows: 1,
      blMatchCount: 1,
      refreshAttempted: true,
      refreshStatus: "success",
      staleFallbackUsed: false,
    });
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 1,
      recognizedWarRows: 1,
      refreshAttempted: true,
      refreshStatus: "success",
      staleFallbackUsed: false,
    });
    expect(snapshot?.warPerformance?.sourceAgeMs).toBe(0);
  });

  it("skips refresh when a recent successful feed state keeps stale rows effectively fresh", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXTFRESH",
      name: "External Fresh",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-09T01:00:00.000Z"),
        result: "WIN",
        opponentInfo: "UNKNOWN",
        sourceSyncedAt: new Date("2026-03-09T01:00:00.000Z"),
      },
    ]);
    syncStateMock.getState.mockResolvedValue({
      lastSuccessAt: new Date("2026-03-09T11:45:00.000Z"),
      lastStatus: "SUCCESS",
    });
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXTFRESH",
        clanName: "External Fresh",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXTFRESH",
    });

    expect(warsSyncMock.syncClan).not.toHaveBeenCalled();
    expect(snapshot?.warPerformance).toMatchObject({
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
    expect(snapshot?.warPerformance?.sourceAgeMs).toBe(15 * 60 * 1000);
    expect(snapshot?.telemetry).toMatchObject({
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
    });
  });

  it("keeps stale external rows when refresh fails", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT333",
      name: "External Charlie",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-08T20:00:00.000Z"),
        result: "WIN",
        opponentInfo: "Unknown",
        sourceSyncedAt: new Date("2026-03-08T20:00:00.000Z"),
      },
    ]);
    syncStateMock.getState.mockResolvedValue({
      lastSuccessAt: new Date("2026-03-08T20:00:00.000Z"),
      lastStatus: "FAILURE",
    });
    warsSyncMock.syncClan.mockRejectedValueOnce(new Error("refresh failed"));
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT333",
        clanName: "External Charlie",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXT333",
    });

    expect(snapshot?.warPerformance).toMatchObject({
      recognizedWarRows: 1,
      mmMatchCount: 1,
      refreshAttempted: true,
      refreshStatus: "failed",
      staleFallbackUsed: true,
    });
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 1,
      recognizedWarRows: 1,
      refreshAttempted: true,
      refreshStatus: "failed",
      staleFallbackUsed: true,
    });
    expect(snapshot?.warPerformance?.sourceAgeMs).toBe(16 * 60 * 60 * 1000);
  });

  it("returns external composition even when refresh fails and no persisted war rows exist", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT444",
      name: "External Delta",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
    warsSyncMock.syncClan.mockRejectedValueOnce(new Error("refresh failed"));
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT444",
        clanName: "External Delta",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXT444",
    });

    expect(snapshot?.warPerformance).toBeNull();
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 0,
      recognizedWarRows: 0,
      refreshAttempted: true,
      refreshStatus: "failed",
      staleFallbackUsed: false,
    });
    expect(snapshot?.composition.clanTag).toBe("#EXT444");
  });

  it("renders stale persisted rows and marks stale fallback used when mirror refresh is skipped", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT555",
      name: "External Echo",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-08T20:00:00.000Z"),
        result: "WIN",
        opponentInfo: "FWA",
        sourceSyncedAt: new Date("2026-03-08T20:00:00.000Z"),
      },
    ]);
    syncStateMock.getState.mockResolvedValue({
      lastSuccessAt: new Date("2026-03-08T20:00:00.000Z"),
      lastStatus: "SUCCESS",
    });
    warsSyncMock.syncClan.mockResolvedValueOnce({
      rowCount: 0,
      changedRowCount: 0,
      contentHash: null,
      status: "SKIPPED",
    });
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT555",
        clanName: "External Echo",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXT555",
    });

    expect(snapshot?.warPerformance).toMatchObject({
      recognizedWarRows: 1,
      refreshAttempted: true,
      refreshStatus: "skipped",
      staleFallbackUsed: true,
    });
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 1,
      recognizedWarRows: 1,
      refreshAttempted: true,
      refreshStatus: "skipped",
      staleFallbackUsed: true,
    });
    expect(snapshot?.warPerformance?.sourceAgeMs).toBe(16 * 60 * 60 * 1000);
  });

  it("renders composition only when mirror refresh is skipped and no persisted rows exist", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXT556",
      name: "External Foxtrot",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([]);
    syncStateMock.getState.mockResolvedValue({
      lastSuccessAt: new Date("2026-03-08T20:00:00.000Z"),
      lastStatus: "SUCCESS",
    });
    warsSyncMock.syncClan.mockResolvedValueOnce({
      rowCount: 0,
      changedRowCount: 0,
      contentHash: null,
      status: "SKIPPED",
    });
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXT556",
        clanName: "External Foxtrot",
      }),
    );

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXT556",
    });

    expect(snapshot?.warPerformance).toBeNull();
    expect(snapshot?.telemetry).toMatchObject({
      warRows: 0,
      recognizedWarRows: 0,
      refreshAttempted: true,
      refreshStatus: "skipped",
      staleFallbackUsed: false,
    });
    expect(snapshot?.composition.clanTag).toBe("#EXT556");
    expect(snapshot?.composition.clanName).toBe("External Foxtrot");
  });

  it("computes rates, inactivity, and missing links for partial war samples", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#AAA111",
      name: "Alpha",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      ...Array.from({ length: 14 }, (_, index) => ({ warId: index + 1, matchType: "FWA", actualOutcome: "WIN" })),
      ...Array.from({ length: 12 }, (_, index) => ({ warId: index + 15, matchType: "FWA", actualOutcome: "LOSE" })),
      ...Array.from({ length: 3 }, (_, index) => ({ warId: index + 27, matchType: "BL", actualOutcome: "WIN" })),
      { warId: 30, matchType: "MM", actualOutcome: "LOSE" },
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      { playerTag: "#P1", missedBoth: false },
      { playerTag: "#P1", missedBoth: true },
      { playerTag: "#P2", missedBoth: false },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-08T23:00:00.000Z") },
      { tag: "#P3", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([{ playerTag: "#P1" }, { playerTag: "#P2" }]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "success",
      clanTag: "#AAA111",
      clanName: "Alpha",
      reportingWindow: {
        kind: "bounded",
        cutoff: new Date("2026-02-07T12:00:00.000Z"),
      },
      trackingSince: new Date("2026-02-01T00:00:00.000Z"),
      evaluatedWarCount: 9,
      affectedWarCount: 4,
      violationCount: 7,
      distinctPlayerCount: 5,
      players: [
        {
          playerTag: "#P1",
          playerName: "Player One",
          townHallLevel: 14,
          discordUserId: "111111111111111111",
          violationCount: 4,
          affectedWarCount: 3,
        },
        {
          playerTag: "#P2",
          playerName: "Player Two",
          townHallLevel: 15,
          discordUserId: "222222222222222222",
          violationCount: 2,
          affectedWarCount: 2,
        },
        {
          playerTag: "#P3",
          playerName: "Player Three",
          townHallLevel: 13,
          discordUserId: "111111111111111111",
          violationCount: 1,
          affectedWarCount: 1,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "aaa111",
      historicalWindowDays: 30,
      inactiveStaleHours: 6,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.clanTag).toBe("#AAA111");
    expect(snapshot?.historicalWindow).toEqual({
      kind: "days",
      days: 30,
      cutoff: new Date("2026-02-07T12:00:00.000Z"),
    });
    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(30);
    expect(snapshot?.warMetrics.fwaMatchCount).toBe(26);
    expect(snapshot?.warMetrics.fwaWinCount).toBe(14);
    expect(snapshot?.warMetrics.fwaLossCount).toBe(12);
    expect(snapshot?.warMetrics.blMatchCount).toBe(3);
    expect(snapshot?.warMetrics.mmMatchCount).toBe(1);
    expect(snapshot?.warMetrics.blInclusiveMatchCount).toBe(29);
    expect(snapshot?.warMetrics.winCount).toBe(17);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(26);
    expect(snapshot?.inactiveWars.warsSampled).toBe(26);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(1);
    expect(snapshot?.inactiveDays.thresholdDays).toBe(6);
    expect(snapshot?.inactiveDays.inactivePlayerCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(1);
    expect(snapshot?.missingLinks.observedMemberCount).toBe(3);
    expect(snapshot?.composition.memberCount).toBe(50);
    expect(snapshot?.composition.unresolvedWeightCount).toBe(0);
    expect(snapshot?.composition.selectedHeatMapRefAvailable).toBe(true);
    expect(snapshot?.composition.deviationScore).toBe(4);
    expect(snapshot?.composition.sourceAgeMs).toBe(3_600_000);
    expect(snapshot?.homeRoster).toMatchObject({
      homeMemberCount: 0,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 0,
      openHomeSpots: 50,
      pendingTransferCount: 0,
    });
    expect(snapshot?.warPlanCompliance).toEqual({
      hasCompletedEvaluations: true,
      evaluatedWarCount: 9,
      affectedWarCount: 4,
      violationCount: 7,
      distinctPlayerCount: 5,
      distinctCurrentDiscordUserCount: 2,
    });
    expect(warPlanHistoryMock.getClanLeaderboardForCutoff).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
      cutoff: new Date("2026-02-07T12:00:00.000Z"),
    });
    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: "#AAA111",
          warEndTime: { not: null, gte: new Date("2026-02-07T12:00:00.000Z") },
        },
      }),
    );
    expect(prismaMock.clanWarHistory.findMany.mock.calls[0]?.[0]?.take).toBeUndefined();
    expect(compositionMock.readTrackedClanCurrentComposition).toHaveBeenCalledWith({
      guildId: "guild-1",
      trackedClan: expect.objectContaining({
        tag: "#AAA111",
        name: "Alpha",
      }),
      now: expect.any(Date),
    });
  });

  it("uses the configured day cutoff and counts every eligible FWA war in that period", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#CUT777",
      name: "Cutoff Clan",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { warId: 11, matchType: "FWA", actualOutcome: "WIN" },
      { warId: 12, matchType: "FWA", actualOutcome: "LOSE" },
      { warId: 13, matchType: "BL", actualOutcome: "WIN" },
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      { playerTag: "#P1", missedBoth: false },
      { playerTag: "#P1", missedBoth: true },
      { playerTag: "#P2", missedBoth: true },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "not_found",
      clanTag: "#CUT777",
      clanName: null,
      reportingWindow: {
        kind: "bounded",
        cutoff: new Date("2026-01-08T12:00:00.000Z"),
      },
      trackingSince: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });

    const snapshot = await createService().getSnapshot({
      guildId: "guild-1",
      clanTag: "#CUT777",
      historicalWindowDays: 60,
    });

    expect(snapshot).toMatchObject({
      historicalWindow: {
        kind: "days",
        days: 60,
        cutoff: new Date("2026-01-08T12:00:00.000Z"),
      },
      warMetrics: {
        endedWarSampleSize: 3,
      },
      inactiveWars: {
        warsAvailable: 2,
        warsSampled: 2,
        inactivePlayerCount: 2,
      },
    });
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          matchType: "FWA",
          warId: { in: ["11", "12"] },
        }),
      }),
    );
    expect(warPlanHistoryMock.getClanLeaderboardForCutoff).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#CUT777",
      cutoff: new Date("2026-01-08T12:00:00.000Z"),
    });
  });

  it("handles no-war and all-linked edge case", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#BBB222",
      name: "Bravo",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-08T22:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-08T21:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([{ playerTag: "#P1" }, { playerTag: "#P2" }]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "success",
      clanTag: "#BBB222",
      clanName: "Bravo",
      reportingWindow: { kind: "bounded", cutoff: new Date("2026-02-07T12:00:00.000Z") },
      trackingSince: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#BBB222",
    });

    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(0);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(0);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(0);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(0);
    expect(snapshot?.warPlanCompliance.hasCompletedEvaluations).toBe(false);
    expect(snapshot?.warPlanCompliance.violationCount).toBe(0);
  });

  it("handles all-unlinked edge case", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#CCC333",
      name: "Charlie",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "not_found",
      clanTag: "#CCC333",
      clanName: null,
      reportingWindow: { kind: "bounded", cutoff: new Date("2026-02-07T12:00:00.000Z") },
      trackingSince: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#CCC333",
    });

    expect(snapshot?.missingLinks.observedMemberCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(2);
    expect(snapshot?.missingLinks.linkedMemberCount).toBe(0);
    expect(snapshot?.warPlanCompliance).toEqual({
      hasCompletedEvaluations: false,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      distinctCurrentDiscordUserCount: 0,
    });
  });

  it("logs aggregated compliance values without exposing identity payloads", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#DDD444",
      name: "Delta",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "success",
      clanTag: "#DDD444",
      clanName: "Delta",
      reportingWindow: { kind: "bounded", cutoff: new Date("2026-02-07T12:00:00.000Z") },
      trackingSince: null,
      evaluatedWarCount: 12,
      affectedWarCount: 4,
      violationCount: 9,
      distinctPlayerCount: 6,
      players: [],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#DDD444",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("view_type=tracked")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_evaluated_wars=12")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_affected_wars=4")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_violations=9")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_players=6")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_discord_users=0")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("composition_unresolved_count=0")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("composition_selected_heatmap_ref_available=true")
    );
    infoSpy.mockRestore();
  });

  it("logs external completion telemetry without fabricated compliance metrics", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
      clanTag: "#EXTLOG",
      name: "External Log",
    });
    prismaMock.fwaClanWarLogCurrent.findMany.mockResolvedValue([
      {
        endTime: new Date("2026-03-09T11:45:00.000Z"),
        result: "WIN",
        opponentInfo: "FWA",
        sourceSyncedAt: new Date("2026-03-09T11:45:00.000Z"),
      },
    ]);
    compositionMock.readExternalClanCurrentComposition.mockResolvedValue(
      makeExternalCompositionSnapshot({
        clanTag: "#EXTLOG",
        clanName: "External Log",
      }),
    );

    const service = createService();
    await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EXTLOG",
    });

    const logged = String(infoSpy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("view_type=external");
    expect(logged).not.toContain("compliance_evaluated_wars=");
    expect(logged).not.toContain("compliance_affected_wars=");
    expect(logged).not.toContain("compliance_violations=");
    expect(logged).not.toContain("compliance_players=");
    expect(logged).not.toContain("compliance_discord_users=");
    infoSpy.mockRestore();
  });

  it("counts only positive-violation linked discord users once and trims invalid ids", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#EEE555",
      name: "Echo",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "success",
      clanTag: "#EEE555",
      clanName: "Echo",
      reportingWindow: { kind: "bounded", cutoff: new Date("2026-02-07T12:00:00.000Z") },
      trackingSince: null,
      evaluatedWarCount: 4,
      affectedWarCount: 2,
      violationCount: 4,
      distinctPlayerCount: 3,
      players: [
        {
          playerTag: "#P1",
          playerName: "One",
          townHallLevel: 15,
          discordUserId: " 111111111111111111 ",
          violationCount: 0,
          affectedWarCount: 0,
        },
        {
          playerTag: "#P2",
          playerName: "Two",
          townHallLevel: 14,
          discordUserId: "222222222222222222",
          violationCount: 2,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P3",
          playerName: "Three",
          townHallLevel: 13,
          discordUserId: "222222222222222222",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P4",
          playerName: "Four",
          townHallLevel: 12,
          discordUserId: null,
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P5",
          playerName: "Five",
          townHallLevel: 12,
          discordUserId: "   ",
          violationCount: 1,
          affectedWarCount: 1,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EEE555",
    });

    expect(snapshot?.warPlanCompliance.distinctCurrentDiscordUserCount).toBe(1);
  });

  it("counts only normalized valid discord ids from positive-violation rows", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#GGG777",
      name: "Golf",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockResolvedValue({
      outcome: "success",
      clanTag: "#GGG777",
      clanName: "Golf",
      reportingWindow: { kind: "bounded", cutoff: new Date("2026-02-07T12:00:00.000Z") },
      trackingSince: null,
      evaluatedWarCount: 2,
      affectedWarCount: 2,
      violationCount: 4,
      distinctPlayerCount: 4,
      players: [
        {
          playerTag: "#P1",
          playerName: "One",
          townHallLevel: 15,
          discordUserId: "123456789012345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P2",
          playerName: "Two",
          townHallLevel: 14,
          discordUserId: "1234567890123456789012",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P3",
          playerName: "Three",
          townHallLevel: 13,
          discordUserId: "123456789012345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P4",
          playerName: "Four",
          townHallLevel: 12,
          discordUserId: "12345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P5",
          playerName: "Five",
          townHallLevel: 12,
          discordUserId: "12345678901234567890123",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P6",
          playerName: "Six",
          townHallLevel: 12,
          discordUserId: "abc123",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P7",
          playerName: "Seven",
          townHallLevel: 12,
          discordUserId: "   ",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P8",
          playerName: "Eight",
          townHallLevel: 12,
          discordUserId: null,
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P9",
          playerName: "Nine",
          townHallLevel: 12,
          discordUserId: "999999999999999999",
          violationCount: 0,
          affectedWarCount: 0,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#GGG777",
    });

    expect(snapshot?.warPlanCompliance.distinctCurrentDiscordUserCount).toBe(2);
  });

  it("propagates leaderboard failures instead of converting them into zero summaries", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#FFF666",
      name: "Foxtrot",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForCutoff.mockRejectedValue(new Error("leaderboard boom"));

    const service = createService();
    await expect(
      service.getSnapshot({
        guildId: "guild-1",
        clanTag: "#FFF666",
      })
    ).rejects.toThrow("leaderboard boom");
  });

  it("uses the latest contiguous sync range for an omitted historical window", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#SYNC545",
      name: "Sync Clan",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboardForSyncNumbers.mockResolvedValue(null);

    const snapshot = await createService().getSnapshot({
      guildId: "guild-1",
      clanTag: "#SYNC545",
    });

    expect(snapshot?.historicalWindow).toEqual({
      kind: "syncs",
      requestedSyncCount: 30,
      startSyncNumber: 516,
      endSyncNumber: 545,
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
    });
    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: "#SYNC545",
          warEndTime: { not: null },
          syncNumber: { in: Array.from({ length: 30 }, (_, index) => 516 + index) },
        },
      }),
    );
    expect(warPlanHistoryMock.getClanLeaderboardForSyncNumbers).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#SYNC545",
      syncNumbers: Array.from({ length: 30 }, (_, index) => 516 + index),
    });
  });
});
