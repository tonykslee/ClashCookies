import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WarEventLogService } from "../src/services/WarEventLogService";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  currentWar: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  maintenanceWindowRuntimeState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findUnique.mockResolvedValue(null);
  prismaMock.currentWar.update.mockResolvedValue({});
  prismaMock.maintenanceWindowRuntimeState.findUnique.mockResolvedValue(null);
  prismaMock.maintenanceWindowRuntimeState.upsert.mockResolvedValue({});
});

const testGuildId = "guild-1";
const testClanTag = "#2QG2C08UP";
const prepStartTime = new Date("2026-03-20T09:00:00.000Z");
const sameWarStartTime = new Date("2026-03-20T09:00:00.000Z");
const newWarStartTime = new Date("2026-03-21T09:00:00.000Z");

function makeWarSnapshot(input: {
  state: "preparation" | "inWar" | "notInWar";
  startTime: Date;
  opponentTag: string;
  opponentName?: string;
}) {
  return {
    state: input.state,
    startTime: `${input.startTime.toISOString().replace(/[-:]/g, "").slice(0, 15)}.000Z`,
    endTime: null,
    preparationStartTime: `${input.startTime.toISOString().replace(/[-:]/g, "").slice(0, 15)}.000Z`,
    clan: {
      name: "Rocky Road",
      stars: 0,
      attacks: 0,
      destructionPercentage: 0,
    },
    opponent: {
      tag: input.opponentTag,
      name: input.opponentName ?? "Opponent",
      stars: 0,
      attacks: 0,
      destructionPercentage: 0,
    },
    teamSize: 15,
    attacksPerMember: 2,
  } as any;
}

function makeSubscriptionRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    guildId: testGuildId,
    clanTag: testClanTag,
    warId: 5001,
    syncNumber: 534,
    syncNum: 534,
    channelId: "notify-channel-1",
    notify: true,
    pingRole: true,
    embedEnabled: true,
    inferredMatchType: false,
    notifyRole: "notify-role-1",
    fwaPoints: 120,
    opponentFwaPoints: 120,
    outcome: null,
    matchType: "FWA",
    warStartFwaPoints: null,
    warEndFwaPoints: null,
    clanStars: null,
    opponentStars: null,
    state: "preparation",
    prepStartTime,
    startTime: sameWarStartTime,
    endTime: null,
    opponentTag: "#OPPX",
    opponentName: "Old Opponent",
    clanName: "Rocky Road",
    clanRoleId: null,
    pointsConfirmedByClanMail: false,
    pointsNeedsValidation: true,
    pointsLastSuccessfulFetchAt: null,
    pointsSyncNum: 534,
    pointsLastKnownSyncNumber: 534,
    pointsLastKnownPoints: 120,
    pointsLastKnownMatchType: "FWA",
    pointsLastKnownOutcome: null,
    pointsWarId: "5001",
    pointsOpponentTag: "#OPPX",
    pointsWarStartTime: sameWarStartTime,
    ...overrides,
  };
}

function makeService(snapshot: any) {
  const service = new WarEventLogService(
    { channels: { fetch: vi.fn() } } as any,
    {
      getCurrentWar: vi.fn().mockResolvedValue(snapshot),
    } as any,
  );
  (service as any).pointsGate = {
    evaluatePollerFetch: vi.fn().mockReturnValue({
      allowed: false,
      fetchReason: "post_war_reconciliation",
    }),
  };
  (service as any).points = {
    fetchSnapshot: vi.fn(),
  };
  (service as any).pointsSync = {
    resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
    maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
    getPreviousSyncNum: vi.fn().mockResolvedValue(534),
  };
  (service as any).currentSyncs = {
    upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    markNeedsValidation: vi.fn().mockResolvedValue(undefined),
  };
  (service as any).history = {
    resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
    getWarEndResultSnapshot: vi.fn().mockResolvedValue({
      clanStars: null,
      opponentStars: null,
      clanDestruction: null,
      opponentDestruction: null,
      warEndTime: null,
      resultLabel: "UNKNOWN",
    }),
  };
  (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(0);
  (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
  (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
  (service as any).fwaPolice = {
    enforceWarViolations: vi.fn().mockResolvedValue(undefined),
  };
  return service;
}

describe("WarEventLogService sync-number lifecycle", () => {
  it("retains the canonical sync number for the same physical war", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([makeSubscriptionRow()]);
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: sameWarStartTime,
        opponentTag: "#OPPX",
      }),
    );
    const resolveActiveSyncNumber = vi.fn().mockResolvedValue({
      syncNumber: 534,
      proposedSyncNumber: 534,
      usable: true,
      source: "existing_current_war",
      shouldPersist: false,
      persistence: "not_needed",
      validation: "matched",
      latestPersistedSyncNumber: 534,
      activeCycleSyncNumber: 534,
      sameWarPointsSyncNumber: 534,
      persistedSyncNumber: 534,
    });

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 533,
      activeSync: 534,
      resolveActiveSyncNumber,
    });

    expect(resolveActiveSyncNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        currentWarCanonicalSyncNumber: 534,
        currentWarLegacySyncNumber: 534,
        sameWarPointsSyncNumber: 534,
      }),
    );
    expect(prismaMock.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncNumber: 534,
        }),
      }),
    );
    expect((service as any).dispatchDetectedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          syncNumber: 534,
        }),
      }),
    );
  });

  it("clears the stale sync number when a new physical war rolls over", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#OPPX",
        pointsWarStartTime: prepStartTime,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#OPPY",
      }),
    );
    const resolveActiveSyncNumber = vi.fn().mockResolvedValue({
      syncNumber: 535,
      proposedSyncNumber: 535,
      usable: true,
      source: "allocated_latest_plus_one",
      shouldPersist: true,
      persistence: "saved",
      validation: null,
      latestPersistedSyncNumber: 534,
      activeCycleSyncNumber: null,
      sameWarPointsSyncNumber: null,
      persistedSyncNumber: 535,
    });

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: null,
      resolveActiveSyncNumber,
    });

    expect(prismaMock.currentWar.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          warId: 5002,
          state: "inWar",
          syncNumber: null,
        }),
      }),
    );
    expect(resolveActiveSyncNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        currentWarCanonicalSyncNumber: null,
        currentWarLegacySyncNumber: null,
        sameWarPointsSyncNumber: null,
      }),
    );
    expect(prismaMock.currentWar.update.mock.invocationCallOrder?.[0]).toBeLessThan(
      resolveActiveSyncNumber.mock.invocationCallOrder?.[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(prismaMock.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          warId: 5002,
          syncNumber: 535,
        }),
      }),
    );
    expect((service as any).dispatchDetectedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          syncNumber: 535,
        }),
      }),
    );
  });

  it("fails closed when the sync resolver returns no usable canonical number", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: null,
        syncNum: null,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#OPPX",
        pointsWarStartTime: prepStartTime,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#OPPY",
      }),
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi.fn().mockImplementation(
      async (clanTag: string) => {
        if (clanTag === testClanTag) {
          return {
            balance: 100,
            winnerBoxTags: ["#OPPY"],
            winnerBoxText: "Marked as an FWA match",
            activeFwa: true,
            notFound: false,
            fetchedAtMs: Date.now(),
            effectiveSync: null,
          };
        }
        return {
          balance: 100,
          winnerBoxTags: [],
          winnerBoxText: "Marked as an FWA match",
          activeFwa: true,
          notFound: false,
          fetchedAtMs: Date.now(),
          effectiveSync: null,
        };
      },
    );
    const resolveActiveSyncNumber = vi.fn().mockResolvedValue({
      syncNumber: null,
      proposedSyncNumber: 535,
      usable: false,
      source: "active_cycle_conflict",
      shouldPersist: false,
      persistence: "not_needed",
      validation: null,
      latestPersistedSyncNumber: 534,
      activeCycleSyncNumber: null,
      sameWarPointsSyncNumber: null,
      persistedSyncNumber: null,
    });

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: null,
      resolveActiveSyncNumber,
    });

    expect(prismaMock.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncNumber: null,
          outcome: null,
        }),
      }),
    );
    expect((service as any).dispatchDetectedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          syncNumber: null,
          outcome: null,
        }),
      }),
    );
  });
});
