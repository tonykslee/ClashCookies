import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveWarSyncResolutionService,
  buildActiveWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const originalPollingMode = process.env.POLLING_MODE;

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  process.env.POLLING_MODE = originalPollingMode;
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.currentWar.updateMany.mockResolvedValue({ count: 1 });
  process.env.POLLING_MODE = "active";
});

function makeService(pointsBaseline = 500) {
  const service = new ActiveWarSyncResolutionService({
    findLatestSyncNum: vi.fn().mockResolvedValue(pointsBaseline),
  } as any);
  return new Proxy(service as any, {
    get(target, prop, receiver) {
      if (prop === "resolveOrAllocateActiveSyncNumber") {
        return (input: any) =>
          target.resolveOrAllocateActiveSyncNumber({
            ...input,
            expectedCurrentWarRevisionAt:
              input?.expectedCurrentWarRevisionAt ?? allocationRevision,
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const allocationRevision = new Date("2026-03-12T00:00:00.000Z");

describe("ActiveWarSyncResolutionService allocation", () => {
  it("reuses an existing canonical CurrentWar sync number without writing", async () => {
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4001",
        warStartTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 321,
      currentWarLegacySyncNumber: 111,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: 321,
      source: "existing_current_war",
      persistence: "not_needed",
      shouldPersist: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("does not promote same-war points sync in mirror mode when CurrentWar syncNumber is absent", async () => {
    process.env.POLLING_MODE = "mirror";
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4001",
        warStartTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      sameWarPointsSyncNumber: 321,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "mirror_mode",
      persistence: "not_needed",
      shouldPersist: false,
      usable: false,
      persistedSyncNumber: null,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("persists a legacy-only CurrentWar sync number when the war is positively resolved", async () => {
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4002",
        warStartTime: new Date("2026-03-13T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarLegacySyncNumber: 322,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: 322,
      source: "existing_current_war",
      persistence: "saved",
      shouldPersist: true,
      usable: true,
    });
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
  });

  it("ignores a legacy-only CurrentWar sync number for non-FWA wars without persisting", async () => {
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4002",
        warStartTime: new Date("2026-03-13T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarLegacySyncNumber: 322,
      matchType: "MM",
      inferredMatchType: false,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "existing_current_war",
      persistence: "not_needed",
      shouldPersist: false,
      usable: false,
      proposedSyncNumber: 322,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed without an expected revision when persistence is required", async () => {
    const service = new ActiveWarSyncResolutionService({
      findLatestSyncNum: vi.fn().mockResolvedValue(500),
    } as any);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4002",
        warStartTime: new Date("2026-03-13T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarLegacySyncNumber: 322,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      proposedSyncNumber: 322,
      persistence: "revision_changed",
      usable: false,
      shouldPersist: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("leaves unresolved active wars without a canonical sync number", async () => {
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4003",
        warStartTime: new Date("2026-03-14T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "identity_incomplete",
      persistence: "not_needed",
      shouldPersist: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("skips non-FWA wars without persisting a canonical sync number", async () => {
    const service = makeService();

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4004",
        warStartTime: new Date("2026-03-15T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "MM",
      inferredMatchType: false,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "not_fwa",
      persistence: "not_needed",
      shouldPersist: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("allocates the next global sync number and reuses it for the same poll cycle", async () => {
    const pointsSync = {
      findLatestSyncNum: vi
        .fn()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(999),
    };
    const service = new ActiveWarSyncResolutionService(pointsSync as any);
    let pollCycle: {
      activeSyncNumber: number | null;
      recordActiveSyncNumber: (syncNumber: number) => void;
    };
    pollCycle = {
      activeSyncNumber: null,
      recordActiveSyncNumber: (syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      },
    };
    prismaMock.currentWar.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const first = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4005",
        warStartTime: new Date("2026-03-16T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const second = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C09UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4006",
        warStartTime: new Date("2026-03-16T10:00:00.000Z"),
        opponentTag: "#OPP456",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(first.syncNumber).toBe(501);
    expect(second.syncNumber).toBe(501);
    expect(pollCycle.activeSyncNumber).toBe(501);
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(2);
  });

  it("reports idempotent persistence when the canonical sync already exists", async () => {
    const service = makeService();
    const pollCycle = { activeSyncNumber: 777, recordActiveSyncNumber: vi.fn() };
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 777,
      warId: 4007,
      startTime: new Date("2026-03-17T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
      updatedAt: allocationRevision,
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4007",
        warStartTime: new Date("2026-03-17T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: 777,
      source: "active_cycle_reuse",
      persistence: "idempotent",
      usable: true,
      shouldPersist: false,
    });
  });

  it("reports revision_changed when the exact row is replaced before write", async () => {
    const service = makeService();
    const pollCycle = { activeSyncNumber: 888, recordActiveSyncNumber: vi.fn() };
    prismaMock.currentWar.findFirst
      .mockResolvedValueOnce({
        syncNumber: null,
        warId: 4008,
        startTime: new Date("2026-03-18T09:00:00.000Z"),
        opponentTag: "#OPP123",
        state: "inWar",
        updatedAt: new Date("2026-03-18T09:30:00.000Z"),
      })
      .mockResolvedValueOnce({
        syncNumber: null,
        warId: 9999,
        startTime: new Date("2026-03-18T09:00:00.000Z"),
        opponentTag: "#OPP123",
        state: "inWar",
        updatedAt: new Date("2026-03-18T09:30:01.000Z"),
      });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4008",
        warStartTime: new Date("2026-03-18T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      proposedSyncNumber: 888,
      source: "active_cycle_reuse",
      persistence: "revision_changed",
      usable: false,
      shouldPersist: false,
    });
  });

  it("reports revision_changed when the exact row already owns a different sync number", async () => {
    const service = makeService();
    const pollCycle = { activeSyncNumber: 889, recordActiveSyncNumber: vi.fn() };
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 123,
      warId: 4009,
      startTime: new Date("2026-03-19T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
      updatedAt: new Date("2026-03-19T09:30:00.000Z"),
    });
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4009",
        warStartTime: new Date("2026-03-19T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      proposedSyncNumber: 889,
      source: "active_cycle_reuse",
      persistence: "revision_changed",
      usable: false,
      shouldPersist: false,
    });
  });

  it("does not seed FWA allocation from active BL/MM/SKIP rows", async () => {
    const service = makeService(500);
    prismaMock.currentWar.findMany.mockResolvedValueOnce([
      {
        guildId: "guild-1",
        clanTag: "#BLROW",
        warId: 6001,
        syncNumber: 999,
        startTime: new Date("2026-03-20T09:00:00.000Z"),
        opponentTag: "#OPP999",
        matchType: "BL",
        inferredMatchType: false,
      },
      {
        guildId: "guild-2",
        clanTag: "#MMROW",
        warId: 6002,
        syncNumber: 998,
        startTime: new Date("2026-03-20T10:00:00.000Z"),
        opponentTag: "#OPP998",
        matchType: "MM",
        inferredMatchType: false,
      },
      {
        guildId: "guild-3",
        clanTag: "#SKIPROW",
        warId: 6003,
        syncNumber: 997,
        startTime: new Date("2026-03-20T11:00:00.000Z"),
        opponentTag: "#OPP997",
        matchType: "SKIP",
        inferredMatchType: false,
      },
    ]);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4010",
        warStartTime: new Date("2026-03-20T12:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: 501,
      source: "allocated_latest_plus_one",
      usable: true,
    });
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
  });

  it("fails closed when multiple active FWA rows disagree on the sync number", async () => {
    const service = makeService(500);
    prismaMock.currentWar.findMany.mockResolvedValueOnce([
      {
        guildId: "guild-1",
        clanTag: "#FWA1",
        warId: 7001,
        syncNumber: 999,
        startTime: new Date("2026-03-21T09:00:00.000Z"),
        opponentTag: "#OPP1",
        matchType: "FWA",
        inferredMatchType: false,
      },
      {
        guildId: "guild-2",
        clanTag: "#FWA2",
        warId: 7002,
        syncNumber: 1000,
        startTime: new Date("2026-03-21T10:00:00.000Z"),
        opponentTag: "#OPP2",
        matchType: "FWA",
        inferredMatchType: true,
      },
    ]);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4011",
        warStartTime: new Date("2026-03-21T12:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "active_cycle_conflict",
      usable: false,
      shouldPersist: false,
      persistence: "not_needed",
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("reads the latest persisted baseline without guild scoping", async () => {
    const findLatestSyncNum = vi.fn().mockResolvedValue(500);
    const service = new ActiveWarSyncResolutionService({
      findLatestSyncNum,
    } as any);

    await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4012",
        warStartTime: new Date("2026-03-22T12:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(findLatestSyncNum).toHaveBeenCalledWith({
      guildId: null,
    });
  });
});
