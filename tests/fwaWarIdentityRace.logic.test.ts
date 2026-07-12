import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
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
  resolveCurrentWarScopedSyncRowForTest,
  resolveCurrentWarSyncIdentityForTest,
} from "../src/commands/Fwa";
import { ActiveWarIdentityService } from "../src/services/ActiveWarIdentityService";

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
    prismaMock.$transaction.mockImplementation(async (callback: any) =>
      callback(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.update.mockResolvedValue({});
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

describe("ActiveWarIdentityService", () => {
  function makeLiveWar(overrides?: Partial<Record<string, unknown>>) {
    return {
      state: "preparation",
      startTime: "20260712T152226.000Z",
      preparationStartTime: "20260711T152226.000Z",
      opponent: {
        tag: "#LYPLQQUC",
        name: "War Farmers x44",
      },
      clan: {
        name: "Rocky Road",
      },
      ...overrides,
    };
  }

  function makeDbHarness(initialCurrentWar: Record<string, unknown> | null) {
    const state = {
      currentWar: initialCurrentWar,
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn(),
      currentWar: {
        findUnique: vi.fn().mockImplementation(async () => state.currentWar),
        update: vi.fn().mockImplementation(async ({ data }: any) => {
          state.currentWar = {
            ...(state.currentWar ?? {}),
            ...data,
          };
          return state.currentWar;
        }),
      },
    };
    const db = {
      $transaction: vi.fn().mockImplementation(async (callback: any) =>
        callback(tx),
      ),
    };
    return { db, tx, state };
  }

  it("materializes a missing current-war id when the live identity is complete", async () => {
    const { db, tx } = makeDbHarness({
      warId: null,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
      state: "preparation",
      prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
      endTime: null,
      opponentName: "War Farmers x44",
      clanName: "Rocky Road",
    });
    const service = new ActiveWarIdentityService(db as any);
    tx.$queryRaw.mockResolvedValueOnce([{ warId: 1000610 }]);
    tx.currentWar.update.mockResolvedValueOnce({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
    });

    const resolution = await service.resolveCurrentWarId({
      stage: "fwa_mail_render",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      liveWar: makeLiveWar(),
    });

    expect(resolution).toMatchObject({
      warId: 1000610,
      reason: "materialized_missing_current_war_id",
      materialized: true,
      positivelyResolved: true,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.currentWar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag_guildId: {
            guildId: "guild-1",
            clanTag: "#2RYGLU2UY",
          },
        },
        data: expect.objectContaining({
          warId: 1000610,
          state: "preparation",
          startTime: new Date("2026-07-12T15:22:26.000Z"),
          opponentTag: "#LYPLQQUC",
        }),
      }),
    );
  });

  it("reuses the current-war id safely once the poller has stamped the matching identity", async () => {
    const { db, tx } = makeDbHarness({
      warId: 1000610,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
      state: "preparation",
      prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
      endTime: null,
      opponentName: "War Farmers x44",
      clanName: "Rocky Road",
    });
    const service = new ActiveWarIdentityService(db as any);

    const resolution = await service.resolveCurrentWarId({
      stage: "fwa_mail_render",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      liveWar: makeLiveWar(),
    });

    expect(resolution).toMatchObject({
      warId: 1000610,
      reason: "reused_current_war_id",
      materialized: false,
      positivelyResolved: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.currentWar.update).not.toHaveBeenCalled();
  });

  it("rotates a stale current-war id instead of reusing it when the live identity rolls forward", async () => {
    const { db, tx } = makeDbHarness({
      warId: 1000609,
      startTime: new Date("2026-07-11T15:22:26.000Z"),
      opponentTag: "#OLDOPP",
      state: "preparation",
      prepStartTime: new Date("2026-07-10T15:22:26.000Z"),
      endTime: null,
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    const service = new ActiveWarIdentityService(db as any);
    tx.$queryRaw.mockResolvedValueOnce([{ warId: 1000611 }]);
    tx.currentWar.update.mockResolvedValueOnce({
      warId: 1000611,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
    });

    const resolution = await service.resolveCurrentWarId({
      stage: "poll_cycle",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      liveWar: makeLiveWar(),
    });

    expect(resolution).toMatchObject({
      warId: 1000611,
      reason: "rotated_stale_current_war_id",
      materialized: true,
      positivelyResolved: true,
      sameWar: false,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.currentWar.update).toHaveBeenCalledTimes(1);
  });

  it("blocks a partial live identity and leaves the current-war row untouched", async () => {
    const { db, tx } = makeDbHarness(null);
    const service = new ActiveWarIdentityService(db as any);
    const resolution = await service.resolveCurrentWarId({
      stage: "fwa_mail_render",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      liveWar: makeLiveWar({ opponent: null }),
    });

    expect(resolution).toMatchObject({
      warId: null,
      reason: "blocked_partial_live_identity",
      materialized: false,
      positivelyResolved: false,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.currentWar.findUnique).not.toHaveBeenCalled();
    expect(tx.currentWar.update).not.toHaveBeenCalled();
  });

  it("returns a blocked persistence error when the materialization write fails", async () => {
    const { db, tx } = makeDbHarness({
      warId: null,
      startTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "#LYPLQQUC",
      state: "preparation",
      prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
      endTime: null,
      opponentName: "War Farmers x44",
      clanName: "Rocky Road",
    });
    const service = new ActiveWarIdentityService(db as any);
    tx.$queryRaw.mockResolvedValueOnce([{ warId: 1000612 }]);
    tx.currentWar.update.mockRejectedValueOnce(new Error("write failed"));

    const resolution = await service.resolveCurrentWarId({
      stage: "poll_cycle",
      guildId: "guild-1",
      clanTag: "2RYGLU2UY",
      liveWar: makeLiveWar(),
    });

    expect(resolution).toMatchObject({
      warId: null,
      reason: "blocked_persistence_error",
      materialized: false,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.currentWar.update).toHaveBeenCalledTimes(1);
  });
});
