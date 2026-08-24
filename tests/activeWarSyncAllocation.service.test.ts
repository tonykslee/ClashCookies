import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveWarSyncResolutionService,
  buildActiveWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";

const prismaMock = vi.hoisted(() => ({
  clanPointsSync: {
    findMany: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const originalPollingMode = process.env.POLLING_MODE;
const testGuildId = "guild-1";

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
  prismaMock.clanPointsSync.findMany.mockResolvedValue([]);
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

function createCurrentWarStore(overrides?: {
  guildId?: string;
  clanTag?: string;
  warId?: number | null;
  syncNumber?: number | null;
  syncNum?: number | null;
  state?: string | null;
  startTime?: Date | null;
  opponentTag?: string | null;
  updatedAt?: Date;
}) {
  const state = {
    guildId: testGuildId,
    clanTag: "#2YUYLJCGV",
    warId: null as number | null,
    syncNumber: null as number | null,
    syncNum: null as number | null,
    state: "preparation" as string | null,
    startTime: new Date("2026-07-16T20:03:41.000Z"),
    opponentTag: "#2RU0J9QQJ",
    updatedAt: new Date("2026-07-16T03:16:54.876Z"),
    ...overrides,
  };
  return {
    state,
    findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (
        where.guildId !== undefined &&
        where.guildId !== state.guildId
      ) {
        return null;
      }
      if (
        where.clanTag !== undefined &&
        String(where.clanTag ?? "").replace(/^#/, "").toUpperCase() !==
          String(state.clanTag ?? "").replace(/^#/, "").toUpperCase()
      ) {
        return null;
      }
      if (
        where.startTime instanceof Date &&
        state.startTime instanceof Date &&
        where.startTime.getTime() !== state.startTime.getTime()
      ) {
        return null;
      }
      return {
        ...state,
      };
    }),
    updateMany: vi.fn(async (args?: {
      where?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }) => {
      const where = args?.where ?? {};
      if (
        where.guildId !== undefined &&
        where.guildId !== state.guildId
      ) {
        return { count: 0 };
      }
      if (
        where.clanTag !== undefined &&
        String(where.clanTag ?? "").replace(/^#/, "").toUpperCase() !==
          String(state.clanTag ?? "").replace(/^#/, "").toUpperCase()
      ) {
        return { count: 0 };
      }
      if (
        where.updatedAt instanceof Date &&
        state.updatedAt.getTime() !== where.updatedAt.getTime()
      ) {
        return { count: 0 };
      }
      if (
        where.startTime instanceof Date &&
        state.startTime instanceof Date &&
        where.startTime.getTime() !== state.startTime.getTime()
      ) {
        return { count: 0 };
      }
      if (
        where.opponentTag !== undefined &&
        String(where.opponentTag ?? "").replace(/^#/, "").toUpperCase() !==
          String(state.opponentTag ?? "").replace(/^#/, "").toUpperCase()
      ) {
        return { count: 0 };
      }
      if (where.warId === null && state.warId !== null) {
        return { count: 0 };
      }

      const data = args?.data ?? {};
      if (Object.prototype.hasOwnProperty.call(data, "warId")) {
        state.warId =
          data.warId === null || data.warId === undefined
            ? null
            : Number(data.warId);
      }
      if (Object.prototype.hasOwnProperty.call(data, "syncNumber")) {
        state.syncNumber =
          data.syncNumber === null || data.syncNumber === undefined
            ? null
            : Number(data.syncNumber);
      }
      if (Object.prototype.hasOwnProperty.call(data, "syncNum")) {
        state.syncNum =
          data.syncNum === null || data.syncNum === undefined
            ? null
            : Number(data.syncNum);
      }
      if (Object.prototype.hasOwnProperty.call(data, "updatedAt")) {
        state.updatedAt =
          data.updatedAt instanceof Date
            ? new Date(data.updatedAt)
            : state.updatedAt;
      }
      return { count: 1 };
    }),
  };
}

const allocationRevision = new Date("2026-03-12T00:00:00.000Z");

function makeActiveFwaRow(input: {
  clanTag: string;
  warId: number;
  syncNumber: number | null;
  opponentTag: string;
  startTime?: Date;
}) {
  return {
    guildId: testGuildId,
    clanTag: input.clanTag,
    warId: input.warId,
    syncNumber: input.syncNumber,
    startTime: input.startTime ?? new Date("2026-03-12T09:00:00.000Z"),
    opponentTag: input.opponentTag,
    matchType: "FWA",
    inferredMatchType: true,
  };
}

function setPointsEvidence(
  rows: Array<ReturnType<typeof makeActiveFwaRow>>,
  syncByClanTag?: Record<string, number>,
) {
  prismaMock.clanPointsSync.findMany.mockResolvedValue(
    rows.map((row) => ({
      guildId: row.guildId,
      clanTag: row.clanTag,
      warId: String(row.warId),
      warStartTime: row.startTime,
      opponentTag: row.opponentTag,
      syncNum: syncByClanTag?.[row.clanTag] ?? row.syncNumber,
    })),
  );
}

describe("ActiveWarSyncResolutionService allocation", () => {
  it("uses canonical hashed CurrentWar database keys for exact sync persistence", async () => {
    const incidentStartTime = new Date("2026-07-16T20:03:41.000Z");
    const currentWarStore = createCurrentWarStore({
      guildId: testGuildId,
      clanTag: "#2YUYLJCGV",
      warId: null,
      syncNumber: null,
      syncNum: null,
      state: "preparation",
      startTime: incidentStartTime,
      opponentTag: "#2RU0J9QQJ",
      updatedAt: new Date("2026-07-16T03:16:54.876Z"),
    });

    prismaMock.currentWar.findFirst.mockImplementation(currentWarStore.findFirst);
    prismaMock.currentWar.updateMany.mockImplementation(currentWarStore.updateMany);
    const service = makeService(534);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2YUYLJCGV",
      identity: buildActiveWarSyncIdentity({
        warState: "preparation",
        warId: null,
        warStartTime: incidentStartTime,
        opponentTag: "#2RU0J9QQJ",
      }),
      sameWarPointsSyncNumber: 534,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: currentWarStore.state.updatedAt,
      allowAllocation: true,
    });

    expect(result).toMatchObject({
      syncNumber: 534,
      source: "same_war_points_recovery",
      usable: true,
      shouldPersist: true,
      persistence: "saved",
    });

    expect(prismaMock.currentWar.updateMany).toHaveBeenCalled();
    const firstUpdate = prismaMock.currentWar.updateMany.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
    };
    expect(firstUpdate.where).toMatchObject({
      guildId: testGuildId,
      clanTag: "#2YUYLJCGV",
      opponentTag: "#2RU0J9QQJ",
    });
    expect(String(firstUpdate.where?.clanTag ?? "")).not.toBe("2YUYLJCGV");
    expect(String(firstUpdate.where?.opponentTag ?? "")).not.toBe("2RU0J9QQJ");
    expect(currentWarStore.state.syncNumber).toBe(534);
  });

  it("fails closed when only a materialized CurrentWar sync number exists", async () => {
    const service = makeService(552);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4001",
        warStartTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 553,
      currentWarLegacySyncNumber: null,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "unavailable",
      persistence: "not_needed",
      shouldPersist: false,
      usable: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("repairs a stale canonical sync from exact same-war points evidence", async () => {
    const warStartTime = new Date("2026-03-12T09:00:00.000Z");
    const currentWarStore = createCurrentWarStore({
      clanTag: "#2QG2C08UP",
      warId: 4001,
      syncNumber: 534,
      startTime: warStartTime,
      opponentTag: "#0PP123",
      updatedAt: allocationRevision,
    });
    prismaMock.currentWar.updateMany.mockImplementation(
      currentWarStore.updateMany,
    );
    const pollCycle = {
      activeSyncNumber: null,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    const service = makeService();
    prismaMock.currentWar.findMany.mockImplementation(async () => [
      {
        ...currentWarStore.state,
        matchType: "FWA",
        inferredMatchType: true,
      },
    ]);
    prismaMock.clanPointsSync.findMany.mockResolvedValue([
      {
        guildId: testGuildId,
        clanTag: "#2QG2C08UP",
        warId: "4001",
        warStartTime,
        opponentTag: "#0PP123",
        syncNum: 544,
      },
    ]);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4001",
        warStartTime,
        opponentTag: "#0PP123",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: 544,
      proposedSyncNumber: 544,
      usable: true,
      source: "exact_same_war_reconcile",
      shouldPersist: true,
      persistence: "saved",
      validation: "mismatch",
    });
    expect(currentWarStore.state.syncNumber).toBe(544);
    expect(pollCycle.activeSyncNumber).toBe(544);
    expect(pollCycle.recordActiveSyncNumber).toHaveBeenCalledWith(544);
    expect(pollCycle.clearActiveSyncNumber).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          syncNumber: 534,
          updatedAt: allocationRevision,
          warId: 4001,
        }),
        data: expect.objectContaining({ syncNumber: 544 }),
      }),
    );
  });

  it("does not write when the canonical sync already matches exact same-war points", async () => {
    const warStartTime = new Date("2026-03-13T09:00:00.000Z");
    const pollCycle = {
      activeSyncNumber: null,
      recordActiveSyncNumber: vi.fn(),
      clearActiveSyncNumber: vi.fn(),
    };
    const service = makeService();
    prismaMock.currentWar.findMany.mockResolvedValue([
      makeActiveFwaRow({
        clanTag: "#2QG2C08UP",
        warId: 4002,
        syncNumber: 544,
        startTime: warStartTime,
        opponentTag: "#OPP123",
      }),
    ]);
    setPointsEvidence([
      makeActiveFwaRow({
        clanTag: "#2QG2C08UP",
        warId: 4002,
        syncNumber: 544,
        startTime: warStartTime,
        opponentTag: "#OPP123",
      }),
    ]);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4002",
        warStartTime,
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 544,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      pollCycle,
    });

    expect(result).toMatchObject({
      syncNumber: 544,
      source: "existing_current_war",
      persistence: "not_needed",
      usable: true,
      validation: "matched",
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
    expect(pollCycle.recordActiveSyncNumber).toHaveBeenCalledWith(544);
  });

  it("bounds active-cycle evidence discovery to one read per poll snapshot", async () => {
    const warStartTime = new Date("2026-03-20T09:00:00.000Z");
    const rows = [
      makeActiveFwaRow({
        clanTag: "#FIRST",
        warId: 4050,
        syncNumber: 552,
        startTime: warStartTime,
        opponentTag: "#OPP-FIRST",
      }),
      makeActiveFwaRow({
        clanTag: "#SECOND",
        warId: 4051,
        syncNumber: 552,
        startTime: warStartTime,
        opponentTag: "#OPP-SECOND",
      }),
    ];
    prismaMock.currentWar.findMany.mockResolvedValue(rows);
    setPointsEvidence(rows, { "#FIRST": 552, "#SECOND": 552 });
    const pollCycle = {
      activeSyncNumber: null,
      activeSyncEvidenceChecked: false,
      activeSyncEvidenceConflict: false,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(),
    };
    const service = makeService();
    const resolve = (clanTag: string, warId: number, opponentTag: string) =>
      service.resolveOrAllocateActiveSyncNumber({
        guildId: testGuildId,
        clanTag,
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: String(warId),
          warStartTime,
          opponentTag,
        }),
        currentWarSyncNumber: 552,
        sameWarPointsSyncNumber: 552,
        matchType: "FWA",
        inferredMatchType: true,
        pollCycle,
      });

    const first = await resolve("#FIRST", 4050, "#OPP-FIRST");
    const second = await resolve("#SECOND", 4051, "#OPP-SECOND");

    expect(first.syncNumber).toBe(552);
    expect(second.syncNumber).toBe(552);
    expect(prismaMock.currentWar.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
    expect(pollCycle.activeSyncNumber).toBe(552);
    expect(pollCycle.clearActiveSyncNumber).not.toHaveBeenCalled();
  });

  it("does not rediscover active-cycle evidence after exact repair", async () => {
    const rows = [
      makeActiveFwaRow({
        clanTag: "#PEER",
        warId: 4010,
        syncNumber: 534,
        opponentTag: "#0PPPEER",
      }),
      makeActiveFwaRow({
        clanTag: "#REPAIR",
        warId: 4011,
        syncNumber: 534,
        opponentTag: "#0PPREPAIR",
      }),
    ];
    const pollCycle = {
      activeSyncNumber: 534,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    prismaMock.currentWar.findMany.mockImplementation(async () => rows);
    setPointsEvidence(rows, {
      "#PEER": 534,
      "#REPAIR": 544,
    });
    prismaMock.currentWar.updateMany.mockImplementation(async (args: any) => {
      const row = rows.find((candidate) => candidate.clanTag === args.where?.clanTag);
      if (row && args.where?.syncNumber === 534) {
        row.syncNumber = Number(args.data?.syncNumber);
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = makeService();

    const repaired = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#REPAIR",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4011,
        warStartTime: rows[1]!.startTime,
        opponentTag: "#0PPREPAIR",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const subsequent = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#NEW",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4012,
        warStartTime: new Date("2026-03-12T10:00:00.000Z"),
        opponentTag: "#0PPNEW",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(repaired).toMatchObject({
      syncNumber: 544,
      usable: true,
      source: "exact_same_war_reconcile",
    });
    expect(rows.map((row) => row.syncNumber)).toEqual([534, 544]);
    expect(pollCycle.clearActiveSyncNumber).not.toHaveBeenCalled();
    expect(pollCycle.activeSyncNumber).toBe(534);
    expect(subsequent).toMatchObject({
      syncNumber: null,
      source: "active_cycle_conflict",
      usable: false,
    });
  });

  it("does not switch the cache when exact evidence conflicts across active rows", async () => {
    const rows = [
      makeActiveFwaRow({
        clanTag: "#EXACT534",
        warId: 4013,
        syncNumber: 534,
        opponentTag: "#0PPA",
      }),
      makeActiveFwaRow({
        clanTag: "#EXACT544",
        warId: 4014,
        syncNumber: 534,
        opponentTag: "#0PPB",
      }),
    ];
    const pollCycle = {
      activeSyncNumber: 534,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    prismaMock.currentWar.findMany.mockImplementation(async () => rows);
    setPointsEvidence(rows, {
      "#EXACT534": 534,
      "#EXACT544": 544,
    });
    prismaMock.currentWar.updateMany.mockImplementation(async (args: any) => {
      const row = rows.find((candidate) => candidate.clanTag === args.where?.clanTag);
      if (row && args.where?.syncNumber === 534) {
        row.syncNumber = Number(args.data?.syncNumber);
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = makeService();

    await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#EXACT534",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4013,
        warStartTime: rows[0]!.startTime,
        opponentTag: "#0PPA",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 534,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const repaired = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#EXACT544",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4014,
        warStartTime: rows[1]!.startTime,
        opponentTag: "#0PPB",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const discovery = await service.findPersistedActiveSyncNumber();
    const subsequent = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#NEWCONFLICT",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4020,
        warStartTime: new Date("2026-03-12T10:00:00.000Z"),
        opponentTag: "#0PPNEW",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(repaired).toMatchObject({
      syncNumber: 544,
      usable: true,
      source: "exact_same_war_reconcile",
    });
    expect(pollCycle.activeSyncNumber).toBe(534);
    expect(pollCycle.clearActiveSyncNumber).not.toHaveBeenCalled();
    expect(discovery).toMatchObject({
      syncNumber: null,
      conflict: true,
    });
    expect(subsequent).toMatchObject({
      syncNumber: null,
      source: "active_cycle_conflict",
      usable: false,
    });
  });

  it("does not replace a conflicting poll snapshot after exact repair", async () => {
    const rows = [
      makeActiveFwaRow({
        clanTag: "#C0NVERGED",
        warId: 4015,
        syncNumber: 534,
        opponentTag: "#0PPC",
      }),
      makeActiveFwaRow({
        clanTag: "#ALREADY544",
        warId: 4016,
        syncNumber: 544,
        opponentTag: "#0PPD",
      }),
    ];
    const pollCycle = {
      activeSyncNumber: 534,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    prismaMock.currentWar.findMany.mockImplementation(async () => rows);
    setPointsEvidence(rows, {
      "#C0NVERGED": 544,
      "#ALREADY544": 544,
    });
    prismaMock.currentWar.updateMany.mockImplementation(async (args: any) => {
      const row = rows.find((candidate) => candidate.clanTag === args.where?.clanTag);
      if (row && args.where?.syncNumber === 534) {
        row.syncNumber = Number(args.data?.syncNumber);
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = makeService();

    const repaired = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#C0NVERGED",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4015,
        warStartTime: rows[0]!.startTime,
        opponentTag: "#0PPC",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const discovery = await service.findPersistedActiveSyncNumber();

    expect(repaired.syncNumber).toBe(544);
    expect(pollCycle.activeSyncNumber).toBe(534);
    expect(pollCycle.recordActiveSyncNumber).not.toHaveBeenCalledWith(544);
    expect(discovery).toMatchObject({
      syncNumber: 544,
      conflict: false,
    });
  });

  it("self-heals exact rows from ClanPointsSync evidence without trusting old CurrentWar values", async () => {
    const rows = [
      makeActiveFwaRow({
        clanTag: "#STALE0NE",
        warId: 4017,
        syncNumber: 534,
        opponentTag: "#0PPE",
      }),
      makeActiveFwaRow({
        clanTag: "#STALETW0",
        warId: 4018,
        syncNumber: 534,
        opponentTag: "#0PPF",
      }),
      makeActiveFwaRow({
        clanTag: "#AUTHORITATIVE",
        warId: 4019,
        syncNumber: 544,
        opponentTag: "#0PPG",
      }),
    ];
    const pollCycle = {
      activeSyncNumber: 534,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    prismaMock.currentWar.findMany.mockImplementation(async () => rows);
    setPointsEvidence(rows, {
      "#STALE0NE": 544,
      "#STALETW0": 544,
      "#AUTHORITATIVE": 544,
    });
    prismaMock.currentWar.updateMany.mockImplementation(async (args: any) => {
      const row = rows.find((candidate) => candidate.clanTag === args.where?.clanTag);
      if (row && args.where?.syncNumber === 534) {
        row.syncNumber = Number(args.data?.syncNumber);
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = makeService();

    const repair = async (clanTag: string, warId: number, opponentTag: string) =>
      service.resolveOrAllocateActiveSyncNumber({
        guildId: testGuildId,
        clanTag,
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId,
          warStartTime: new Date("2026-03-12T09:00:00.000Z"),
          opponentTag,
        }),
        currentWarSyncNumber: 534,
        sameWarPointsSyncNumber: 544,
        matchType: "FWA",
        inferredMatchType: true,
        expectedCurrentWarRevisionAt: allocationRevision,
        pollCycle,
      });

    const firstRepair = await repair("#STALE0NE", 4017, "#0PPE");
    expect(firstRepair.syncNumber).toBe(544);
    expect(pollCycle.activeSyncNumber).toBe(534);
    expect((await service.findPersistedActiveSyncNumber()).conflict).toBe(false);

    const secondRepair = await repair("#STALETW0", 4018, "#0PPF");
    expect(secondRepair.syncNumber).toBe(544);
    expect(pollCycle.activeSyncNumber).toBe(534);
    expect(await service.findPersistedActiveSyncNumber()).toMatchObject({
      syncNumber: 544,
      conflict: false,
    });
  });

  it("does not trust a materialized canonical sync when exact points evidence is missing", async () => {
    const service = makeService(544);

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4003",
        warStartTime: new Date("2026-03-14T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: null,
      matchType: "FWA",
      inferredMatchType: true,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "unavailable",
      persistence: "not_needed",
      usable: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it.each(["MM", "BL", "SKIP"])(
    "does not reconcile a canonical sync for %s evidence",
    async (matchType) => {
      const service = makeService();

      const result = await service.resolveOrAllocateActiveSyncNumber({
        guildId: testGuildId,
        clanTag: "#2QG2C08UP",
        identity: buildActiveWarSyncIdentity({
          warState: "inWar",
          warId: "4004",
          warStartTime: new Date("2026-03-15T09:00:00.000Z"),
          opponentTag: "#OPP123",
        }),
        currentWarSyncNumber: 534,
        sameWarPointsSyncNumber: 544,
        matchType,
        inferredMatchType: false,
      });

      expect(result).toMatchObject({
        syncNumber: null,
        source: "not_fwa",
        persistence: "not_needed",
        usable: false,
      });
      expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the exact current war identity changes before stale-sync repair", async () => {
    const service = makeService();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.currentWar.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        syncNumber: 544,
        warId: 4999,
        startTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP999",
        updatedAt: new Date("2026-03-12T09:01:00.000Z"),
      });

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4005",
        warStartTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "exact_same_war_reconcile",
      persistence: "identity_changed",
      usable: false,
    });
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ syncNumber: 534, warId: 4005 }),
      }),
    );
  });

  it("fails closed when the exact current war revision changes before stale-sync repair", async () => {
    const service = makeService();
    prismaMock.currentWar.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 534,
      warId: 4006,
      startTime: new Date("2026-03-12T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
      updatedAt: new Date("2026-03-12T09:01:00.000Z"),
    });

    const result = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#2QG2C08UP",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4006",
        warStartTime: new Date("2026-03-12T09:00:00.000Z"),
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
    });

    expect(result).toMatchObject({
      syncNumber: null,
      source: "exact_same_war_reconcile",
      persistence: "revision_changed",
      usable: false,
    });
  });

  it("converges active-cycle discovery after exact stale-sync repair", async () => {
    const warStartTime = new Date("2026-03-12T09:00:00.000Z");
    const rows = [
      {
        guildId: testGuildId,
        clanTag: "#STALE",
        warId: 4007,
        syncNumber: 534,
        startTime: warStartTime,
        opponentTag: "#OPP123",
        matchType: "FWA",
        inferredMatchType: true,
      },
      {
        guildId: testGuildId,
        clanTag: "#CORRECT",
        warId: 4008,
        syncNumber: 544,
        startTime: warStartTime,
        opponentTag: "#OPP456",
        matchType: "FWA",
        inferredMatchType: true,
      },
    ];
    prismaMock.currentWar.findMany.mockImplementation(async () => rows);
    setPointsEvidence(rows, {
      "#STALE": 544,
      "#CORRECT": 544,
    });
    prismaMock.currentWar.updateMany.mockImplementation(async (args: any) => {
      if (args.where?.clanTag === "#STALE" && args.where?.syncNumber === 534) {
        rows[0]!.syncNumber = 544;
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = makeService();

    const first = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#STALE",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: "4007",
        warStartTime,
        opponentTag: "#OPP123",
      }),
      currentWarSyncNumber: 534,
      sameWarPointsSyncNumber: 544,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
    });
    const discovery = await service.findPersistedActiveSyncNumber();

    expect(first).toMatchObject({
      syncNumber: 544,
      source: "exact_same_war_reconcile",
      usable: true,
    });
    expect(discovery).toMatchObject({
      syncNumber: 544,
      conflict: false,
    });
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

  it("does not trust a legacy-only CurrentWar sync number", async () => {
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
      syncNumber: null,
      source: "unavailable",
      persistence: "not_needed",
      shouldPersist: false,
      usable: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
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
      source: "not_fwa",
      persistence: "not_needed",
      shouldPersist: false,
      usable: false,
      proposedSyncNumber: null,
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
      proposedSyncNumber: null,
      persistence: "not_needed",
      source: "unavailable",
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

  it("does not allocate a guessed sync number for multiple new active FWA clans", async () => {
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
      clearActiveSyncNumber: () => {
        pollCycle.activeSyncNumber = null;
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

    expect(first).toMatchObject({
      syncNumber: null,
      proposedSyncNumber: null,
      source: "unavailable",
      usable: false,
      shouldPersist: false,
    });
    expect(second).toMatchObject({
      syncNumber: null,
      proposedSyncNumber: null,
      source: "unavailable",
      usable: false,
      shouldPersist: false,
    });
    expect(pollCycle.activeSyncNumber).toBeNull();
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });

  it("does not seed the active cycle from stale CurrentWar but reuses exact points evidence for another clan", async () => {
    const warStartTime = new Date("2026-03-21T09:00:00.000Z");
    const rows = [
      makeActiveFwaRow({
        clanTag: "#STALE",
        warId: 4101,
        syncNumber: 553,
        startTime: warStartTime,
        opponentTag: "#OPPSTALE",
      }),
      makeActiveFwaRow({
        clanTag: "#PEER",
        warId: 4102,
        syncNumber: null,
        startTime: warStartTime,
        opponentTag: "#OPPPEER",
      }),
    ];
    const pollCycle = {
      activeSyncNumber: null,
      recordActiveSyncNumber: vi.fn((syncNumber: number) => {
        pollCycle.activeSyncNumber = syncNumber;
      }),
      clearActiveSyncNumber: vi.fn(() => {
        pollCycle.activeSyncNumber = null;
      }),
    };
    prismaMock.currentWar.findMany.mockResolvedValue(rows);
    setPointsEvidence([rows[0]!], { "#STALE": 552 });
    const service = makeService(552);

    const stale = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#STALE",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4101,
        warStartTime,
        opponentTag: "#OPPSTALE",
      }),
      currentWarSyncNumber: 553,
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });
    const peer = await service.resolveOrAllocateActiveSyncNumber({
      guildId: testGuildId,
      clanTag: "#PEER",
      identity: buildActiveWarSyncIdentity({
        warState: "inWar",
        warId: 4102,
        warStartTime,
        opponentTag: "#OPPPEER",
      }),
      matchType: "FWA",
      inferredMatchType: true,
      expectedCurrentWarRevisionAt: allocationRevision,
      pollCycle,
    });

    expect(stale.syncNumber).toBeNull();
    expect(stale.source).toBe("active_cycle_conflict");
    expect(peer).toMatchObject({
      syncNumber: 552,
      source: "active_cycle_reuse",
      usable: true,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncNumber: 553 }) }),
    );
  });

  it("reports idempotent persistence when the canonical sync already exists", async () => {
    const service = makeService();
    const pollCycle = {
      activeSyncNumber: 777,
      recordActiveSyncNumber: vi.fn(),
      clearActiveSyncNumber: vi.fn(),
    };
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 777,
      warId: 4007,
      startTime: new Date("2026-03-17T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
      updatedAt: allocationRevision,
    });
    const establishedRow = makeActiveFwaRow({
      clanTag: "#2QG2C08UP",
      warId: 4007,
      syncNumber: 777,
      startTime: new Date("2026-03-17T09:00:00.000Z"),
      opponentTag: "#OPP123",
    });
    prismaMock.currentWar.findMany.mockResolvedValue([establishedRow]);
    setPointsEvidence([establishedRow]);
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
    const pollCycle = {
      activeSyncNumber: 888,
      recordActiveSyncNumber: vi.fn(),
      clearActiveSyncNumber: vi.fn(),
    };
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
    const establishedRow = makeActiveFwaRow({
      clanTag: "#2QG2C08UP",
      warId: 4008,
      syncNumber: 888,
      startTime: new Date("2026-03-18T09:00:00.000Z"),
      opponentTag: "#OPP123",
    });
    prismaMock.currentWar.findMany.mockResolvedValue([establishedRow]);
    setPointsEvidence([establishedRow]);
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
    const pollCycle = {
      activeSyncNumber: 889,
      recordActiveSyncNumber: vi.fn(),
      clearActiveSyncNumber: vi.fn(),
    };
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({
      syncNumber: 123,
      warId: 4009,
      startTime: new Date("2026-03-19T09:00:00.000Z"),
      opponentTag: "#OPP123",
      state: "inWar",
      updatedAt: new Date("2026-03-19T09:30:00.000Z"),
    });
    const establishedRow = makeActiveFwaRow({
      clanTag: "#2QG2C08UP",
      warId: 4009,
      syncNumber: 889,
      startTime: new Date("2026-03-19T09:00:00.000Z"),
      opponentTag: "#OPP123",
    });
    prismaMock.currentWar.findMany.mockResolvedValue([establishedRow]);
    setPointsEvidence([establishedRow]);
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

  it("does not allocate from latest baseline when only non-FWA active rows exist", async () => {
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
      syncNumber: null,
      proposedSyncNumber: null,
      source: "unavailable",
      usable: false,
      shouldPersist: false,
    });
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
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
    prismaMock.clanPointsSync.findMany.mockResolvedValueOnce([
      {
        guildId: "guild-1",
        clanTag: "#FWA1",
        warId: "7001",
        warStartTime: new Date("2026-03-21T09:00:00.000Z"),
        opponentTag: "#OPP1",
        syncNum: 999,
      },
      {
        guildId: "guild-2",
        clanTag: "#FWA2",
        warId: "7002",
        warStartTime: new Date("2026-03-21T10:00:00.000Z"),
        opponentTag: "#OPP2",
        syncNum: 1000,
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
