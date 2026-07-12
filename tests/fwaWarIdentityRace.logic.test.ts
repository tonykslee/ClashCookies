import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  currentWar: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PointsSyncService", () => ({
  PointsSyncService: vi.fn().mockImplementation(() => ({
    getCurrentSyncForClan: vi.fn(),
    markNeedsValidation: vi.fn().mockResolvedValue(undefined),
    clearNeedsValidation: vi.fn().mockResolvedValue(undefined),
    markConfirmedByClanMail: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  getCurrentWarIdForClanForTest,
  resolveCurrentWarScopedSyncRowForTest,
  resolveCurrentWarSyncIdentityForTest,
} from "../src/commands/Fwa";
import { WarEventLogService } from "../src/services/WarEventLogService";

function makeWarIdentity(params: {
  currentWarId: number | null;
  currentWarStartTime: Date | null;
  currentWarOpponentTag: string | null;
  liveWarStartTime: string | null;
  liveOpponentTag: string | null;
}) {
  return resolveCurrentWarSyncIdentityForTest({
    clanTag: "#2RYGLU2UY",
    warState: "preparation",
    currentWarId: params.currentWarId,
    currentWarStartTime: params.currentWarStartTime,
    currentWarOpponentTag: params.currentWarOpponentTag,
    liveWarStartTime: params.liveWarStartTime,
    liveOpponentTag: params.liveOpponentTag,
  });
}

describe("Rocky Road war identity resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the send path when the poller has not materialized a current-war id yet", () => {
    const identity = makeWarIdentity({
      currentWarId: null,
      currentWarStartTime: null,
      currentWarOpponentTag: null,
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("reuses the current-war id safely once the poller has stamped the matching identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBe("1000610");
  });

  it("drops the current-war id when the final rerender only sees a partial live identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: null,
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("rejects a stale current-war id when the live identity has rolled to a new war", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000609,
      currentWarStartTime: new Date("2026-07-11T15:22:26.000Z"),
      currentWarOpponentTag: "#OLDOPP",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
  });

  it("keeps scoped sync-row selection aligned to start time and opponent before reuse", () => {
    const selected = resolveCurrentWarScopedSyncRowForTest({
      rows: [
        {
          warId: "1000609",
          warStartTime: new Date("2026-07-11T15:22:26.000Z"),
          opponentTag: "#OLDOPP",
          needsValidation: false,
        } as any,
      ],
      warId: "1000610",
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });

    expect(selected).toBeNull();
  });
});

describe("Current-war lookup and allocation diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the persisted current-war id without validating the supplied war-start time", async () => {
    prismaMock.currentWar.findUnique.mockResolvedValueOnce({
      warId: 1000609,
    });

    const warId = await getCurrentWarIdForClanForTest(
      "guild-1",
      "2RYGLU2UY",
      new Date("2026-07-12T15:22:26.000Z").getTime(),
    );

    expect(warId).toBe(1000609);
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          guildId: "guild-1",
          clanTag: "#2RYGLU2UY",
        },
      },
      select: { warId: true },
    });
  });

  it("allocates the same next war id for overlapping poll cycles that observe the same max snapshot", async () => {
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.$queryRaw.mockResolvedValue([{ warId: 1000610 }]);
    const service = new WarEventLogService({} as any, {} as any);
    const args = {
      sub: {
        clanTag: "#2RYGLU2UY",
        warId: null,
        startTime: null,
      },
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentState: "preparation" as const,
    };

    const [first, second] = await Promise.all([
      (service as any).ensureCurrentWarId(args),
      (service as any).ensureCurrentWarId(args),
    ]);

    expect(first).toBe(1000610);
    expect(second).toBe(1000610);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("leaves the next render with a stale or null current-war id when persistence fails after allocation", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          guildId: "guild-1",
          clanTag: "#2RYGLU2UY",
          warId: null,
          syncNum: 532,
          channelId: "mail-channel-1",
          notify: true,
          pingRole: false,
          embedEnabled: true,
          notifyRole: "notify-role-1",
          inferredMatchType: false,
          fwaPoints: null,
          opponentFwaPoints: null,
          outcome: null,
          matchType: "FWA",
          warStartFwaPoints: null,
          warEndFwaPoints: null,
          clanStars: null,
          opponentStars: null,
          state: "preparation",
          prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
          startTime: null,
          endTime: null,
          opponentTag: null,
          opponentName: null,
          clanName: "Rocky Road",
          clanRoleId: null,
          pointsConfirmedByClanMail: false,
          pointsNeedsValidation: true,
          pointsLastSuccessfulFetchAt: null,
          pointsLastKnownSyncNumber: null,
          pointsLastKnownPoints: null,
          pointsLastKnownMatchType: null,
          pointsLastKnownOutcome: null,
          pointsWarId: null,
          pointsOpponentTag: null,
          pointsWarStartTime: null,
        },
      ])
      .mockResolvedValueOnce([{ warId: 1000610 }]);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.update.mockRejectedValueOnce(new Error("write failed"));

    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as any, {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "preparation",
        startTime: "20260712T152226.000Z",
        opponent: {
          tag: "#LYPLQQUC",
          name: "War Farmers x44",
        },
        clan: {
          name: "Rocky Road",
        },
      }),
    } as any);
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: {
        state: "preparation",
        startTime: "20260712T152226.000Z",
        opponent: {
          tag: "#LYPLQQUC",
          name: "War Farmers x44",
        },
        clan: {
          name: "Rocky Road",
        },
      },
      observation: { kind: "success" },
      error: null,
    });
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(0);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(532),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
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

    await expect(
      (service as any).processSubscription("guild-1", "#2RYGLU2UY", {
        previousSync: 532,
        activeSync: 533,
      }),
    ).rejects.toThrow("write failed");

    const rerenderWarId = await getCurrentWarIdForClanForTest(
      "guild-1",
      "2RYGLU2UY",
      new Date("2026-07-12T15:22:26.000Z").getTime(),
    );
    expect(rerenderWarId).toBeNull();
  });
});
