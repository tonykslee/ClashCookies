import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveWarSyncResolutionService,
  buildActiveWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findFirst: vi.fn(),
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
  prismaMock.currentWar.updateMany.mockResolvedValue({ count: 1 });
  process.env.POLLING_MODE = "active";
});

function makeService(pointsBaseline = 500) {
  return new ActiveWarSyncResolutionService({
    findLatestSyncNum: vi.fn().mockResolvedValue(pointsBaseline),
  } as any);
}

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
    });
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
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
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: 777,
      source: "active_cycle_reuse",
      persistence: "idempotent",
      shouldPersist: false,
    });
  });

  it("reports identity_changed when the exact row is replaced before write", async () => {
    const service = makeService();
    const pollCycle = { activeSyncNumber: 888, recordActiveSyncNumber: vi.fn() };
    prismaMock.currentWar.findFirst
      .mockResolvedValueOnce({
        syncNumber: null,
        warId: 4008,
        startTime: new Date("2026-03-18T09:00:00.000Z"),
        opponentTag: "#OPP123",
        state: "inWar",
      })
      .mockResolvedValueOnce({
        syncNumber: null,
        warId: 9999,
        startTime: new Date("2026-03-18T09:00:00.000Z"),
        opponentTag: "#OPP123",
        state: "inWar",
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
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: 888,
      source: "active_cycle_reuse",
      persistence: "identity_changed",
      shouldPersist: false,
    });
  });

  it("reports conflict when the exact row already owns a different sync number", async () => {
    const service = makeService();
    const pollCycle = { activeSyncNumber: 889, recordActiveSyncNumber: vi.fn() };
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 123,
      warId: 4009,
      startTime: new Date("2026-03-19T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
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
      syncNumber: 889,
      source: "active_cycle_reuse",
      persistence: "conflict",
      shouldPersist: false,
    });
  });
});
