import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActiveWarSyncResolutionService,
  buildActiveWarSyncIdentity,
} from "../src/services/ActiveWarSyncResolutionService";
import {
  resolveExactSameWarPointsSyncNumberForTest,
  WarEventLogService,
} from "../src/services/WarEventLogService";
import { deriveExpectedOutcome } from "../src/services/war-events/core";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  currentWar: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  warAttacks: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  maintenanceWindowRuntimeState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
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
  process.env.POLLING_MODE = "active";
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.currentWar.findFirst.mockResolvedValue(null);
  prismaMock.currentWar.findMany.mockResolvedValue([]);
  prismaMock.currentWar.findUnique.mockResolvedValue(null);
  prismaMock.currentWar.update.mockResolvedValue({});
  prismaMock.currentWar.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.warAttacks.findFirst.mockResolvedValue(null);
  prismaMock.warAttacks.findMany.mockResolvedValue([]);
  prismaMock.warAttacks.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.maintenanceWindowRuntimeState.findUnique.mockResolvedValue(null);
  prismaMock.maintenanceWindowRuntimeState.upsert.mockResolvedValue({});
});

const testGuildId = "guild-1";
const testClanTag = "#2QG2C08UP";
const prepStartTime = new Date("2026-03-20T09:00:00.000Z");
const sameWarStartTime = new Date("2026-03-20T09:00:00.000Z");
const newWarStartTime = new Date("2026-03-21T09:00:00.000Z");

type CurrentWarState = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  syncNumber: number | null;
  syncNum: number | null;
  state: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
  updatedAt: Date;
};

function createCurrentWarState(
  overrides?: Partial<CurrentWarState>,
): CurrentWarState {
  return {
    guildId: testGuildId,
    clanTag: testClanTag,
    warId: 5001,
    syncNumber: 534,
    syncNum: 534,
    state: "preparation",
    prepStartTime,
    startTime: sameWarStartTime,
    endTime: null,
    opponentTag: "#0PPX",
    opponentName: "Old Opponent",
    clanName: "Rocky Road",
    updatedAt: new Date("2026-03-20T09:30:00.000Z"),
    ...overrides,
  };
}

function cloneCurrentWarState(state: CurrentWarState): CurrentWarState {
  return {
    ...state,
    prepStartTime: state.prepStartTime ? new Date(state.prepStartTime) : null,
    startTime: state.startTime ? new Date(state.startTime) : null,
    endTime: state.endTime ? new Date(state.endTime) : null,
    updatedAt: new Date(state.updatedAt),
  };
}

function normalizeTagForMock(input: unknown) {
  return String(input ?? "")
    .replace(/^#/, "")
    .toUpperCase();
}

function createCurrentWarStore(overrides?: Partial<CurrentWarState>) {
  const state = createCurrentWarState(overrides);
  const bumpUpdatedAt = () => {
    state.updatedAt = new Date(state.updatedAt.getTime() + 1000);
  };
  const applyUpdate = (data: Record<string, unknown>) => {
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
    if (Object.prototype.hasOwnProperty.call(data, "state")) {
      state.state = (data.state as string | null) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "prepStartTime")) {
      state.prepStartTime =
        data.prepStartTime instanceof Date
          ? new Date(data.prepStartTime)
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "startTime")) {
      state.startTime =
        data.startTime instanceof Date ? new Date(data.startTime) : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "endTime")) {
      state.endTime =
        data.endTime instanceof Date ? new Date(data.endTime) : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "opponentTag")) {
      state.opponentTag =
        (data.opponentTag as string | null | undefined) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "opponentName")) {
      state.opponentName =
        (data.opponentName as string | null | undefined) ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data, "clanName")) {
      state.clanName = (data.clanName as string | null | undefined) ?? null;
    }
    bumpUpdatedAt();
    return cloneCurrentWarState(state);
  };
  const matchesWhere = (where: any) => {
    if (where?.clanTag_guildId) {
      if (where.clanTag_guildId.guildId !== state.guildId) return false;
      if (where.clanTag_guildId.clanTag !== state.clanTag) return false;
    }
    if (where?.guildId && where.guildId !== state.guildId) return false;
    if (where?.clanTag !== undefined) {
      if (normalizeTagForMock(where.clanTag) !== normalizeTagForMock(state.clanTag)) {
        return false;
      }
    }
    if (where?.updatedAt instanceof Date) {
      if (where.updatedAt.getTime() !== state.updatedAt.getTime()) return false;
    }
    if (where?.warId !== undefined) {
      if (typeof where.warId === "object" && where.warId !== null) {
        if (where.warId.not === null && state.warId === null) return false;
        if (where.warId.not !== undefined && where.warId.not !== null) {
          if (state.warId === where.warId.not) return false;
        }
        if (where.warId.in && !where.warId.in.includes(state.warId)) return false;
      } else if (where.warId !== state.warId) {
        return false;
      }
    }
    if (where?.syncNumber !== undefined) {
      if (where.syncNumber === null) {
        if (state.syncNumber !== null) return false;
      } else if (typeof where.syncNumber === "object") {
        if (where.syncNumber.not === null && state.syncNumber === null) return false;
      } else if (where.syncNumber !== state.syncNumber) {
        return false;
      }
    }
    if (where?.state !== undefined) {
      if (typeof where.state === "object" && where.state !== null) {
        if (Array.isArray(where.state.in)) {
          if (!where.state.in.includes(state.state)) return false;
        } else if (where.state.not !== undefined) {
          if (state.state === where.state.not) return false;
        }
      } else if (where.state !== state.state) {
        return false;
      }
    }
    if (where?.startTime instanceof Date) {
      if (!state.startTime || where.startTime.getTime() !== state.startTime.getTime()) {
        return false;
      }
    }
    if (where?.opponentTag !== undefined) {
      if (where.opponentTag === null) {
        if (state.opponentTag !== null) return false;
      } else if (
        typeof where.opponentTag === "object" &&
        where.opponentTag !== null
      ) {
        if (where.opponentTag.equals !== undefined && where.opponentTag.equals !== null) {
          const expected = String(where.opponentTag.equals).toUpperCase();
          const actual = String(state.opponentTag ?? "").toUpperCase();
          if (expected !== actual) return false;
        }
      } else if (typeof where.opponentTag === "string") {
        if (
          normalizeTagForMock(where.opponentTag) !==
          normalizeTagForMock(state.opponentTag)
        ) {
          return false;
        }
      } else if (where.opponentTag !== state.opponentTag) {
        return false;
      }
    }
    return true;
  };
  return {
    state,
    snapshot: () => cloneCurrentWarState(state),
    findUnique: vi.fn(async (args?: { where?: any }) => {
      if (args?.where && !matchesWhere(args.where)) return null;
      return cloneCurrentWarState(state);
    }),
    findFirst: vi.fn(async (args?: { where?: any }) => {
      if (args?.where?.startTime instanceof Date) {
        if (
          !state.startTime ||
          args.where.startTime.getTime() !== state.startTime.getTime()
        ) {
          return null;
        }
      }
      if (args?.where?.warId?.not === null && state.warId === null) {
        return null;
      }
      return state.warId !== null ? { warId: state.warId } : null;
    }),
    updateMany: vi.fn(async (args?: { where?: any; data?: any }) => {
      if (args?.where && !matchesWhere(args.where)) {
        return { count: 0 };
      }
      applyUpdate(args?.data ?? {});
      return { count: 1 };
    }),
    update: vi.fn(async (args?: { data?: any }) => {
      return applyUpdate(args?.data ?? {});
    }),
  };
}

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
    updatedAt: new Date("2026-03-20T09:30:00.000Z"),
    state: "preparation",
    prepStartTime,
    startTime: sameWarStartTime,
    endTime: null,
    opponentTag: "#0PPX",
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
    pointsOpponentTag: "#0PPX",
    pointsWarStartTime: sameWarStartTime,
    ...overrides,
  };
}

function makeService(snapshot: any, currentWarStore = createCurrentWarStore()) {
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
  prismaMock.currentWar.findUnique.mockImplementation(
    currentWarStore.findUnique,
  );
  prismaMock.currentWar.findFirst.mockImplementation(currentWarStore.findFirst);
  prismaMock.currentWar.updateMany.mockImplementation(
    currentWarStore.updateMany,
  );
  prismaMock.currentWar.update.mockImplementation(currentWarStore.update);
  (service as any).__currentWarStore = currentWarStore;
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

function mutateCurrentWarStore(
  currentWarStore: ReturnType<typeof createCurrentWarStore>,
  overrides: Partial<CurrentWarState>,
) {
  Object.assign(currentWarStore.state, overrides);
}

function makeResolveActiveSyncNumber(pointsBaseline = 534) {
  const allocationService = new ActiveWarSyncResolutionService({
    findLatestSyncNum: vi.fn().mockResolvedValue(pointsBaseline),
  } as any);
  return vi.fn(async (input: any) =>
    allocationService.resolveOrAllocateActiveSyncNumber({
      guildId: input.guildId,
      clanTag: input.clanTag,
      identity: buildActiveWarSyncIdentity({
        warState: input.warState,
        warId: input.warId,
        warStartTime: input.warStartTime,
        opponentTag: input.opponentTag,
      }),
      currentWarSyncNumber: input.currentWarCanonicalSyncNumber,
      currentWarLegacySyncNumber: input.currentWarLegacySyncNumber,
      sameWarPointsSyncNumber: input.sameWarPointsSyncNumber,
      matchType: input.matchType,
      inferredMatchType: input.inferredMatchType,
      allowAllocation: true,
      pollCycle: input.pollCycle,
    }),
  );
}

type CurrentWarUpdateManyKind =
  | "preliminary_rollover"
  | "allocator"
  | "finalization"
  | "other";

function classifyCurrentWarUpdateManyCall(args: { data?: any; where?: any }) {
  if (args?.data?.syncNumber === null) return "preliminary_rollover";
  if (
    args?.data?.fwaPoints !== undefined ||
    args?.data?.opponentFwaPoints !== undefined ||
    args?.data?.warStartFwaPoints !== undefined ||
    args?.data?.warEndFwaPoints !== undefined
  ) {
    return "finalization";
  }
  if (
    args?.where?.syncNumber === null &&
    args?.data?.syncNumber !== null &&
    args?.data?.syncNumber !== undefined
  ) {
    return "allocator";
  }
  return "other";
}

function getCurrentWarUpdateManyCallsByKind(kind: CurrentWarUpdateManyKind) {
  return prismaMock.currentWar.updateMany.mock.calls
    .map(([args]) => args as { data?: any; where?: any })
    .filter((args) => classifyCurrentWarUpdateManyCall(args) === kind);
}

function expectNoPreliminarySyncClear() {
  expect(getCurrentWarUpdateManyCallsByKind("preliminary_rollover")).toHaveLength(0);
}

function expectNoFinalizationUpdateMany() {
  expect(getCurrentWarUpdateManyCallsByKind("finalization")).toHaveLength(0);
}

describe("exact same-war points identity validation", () => {
  const intendedWarId = "5002";
  const intendedWarStartTime = newWarStartTime;
  const intendedOpponentTag = "#0PPY";

  function resolvePointsSync(overrides?: Record<string, unknown>) {
    return resolveExactSameWarPointsSyncNumberForTest({
      guildId: "guild-1",
      clanTag: testClanTag,
      intendedWarId,
      intendedWarStartTime,
      intendedOpponentTag,
      pointsWarId: "5002",
      pointsWarStartTime: intendedWarStartTime,
      pointsOpponentTag: intendedOpponentTag,
      pointsSyncNumber: 535,
      ...overrides,
    });
  }

  it("accepts an exact same-war points row", () => {
    expect(resolvePointsSync()).toBe(535);
  });

  it("rejects a different start time", () => {
    expect(
      resolvePointsSync({
        pointsWarStartTime: new Date("2026-03-22T09:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("rejects a different opponent", () => {
    expect(resolvePointsSync({ pointsOpponentTag: "#0PPZ" })).toBeNull();
  });

  it("rejects conflicting war IDs", () => {
    expect(resolvePointsSync({ pointsWarId: "9999" })).toBeNull();
  });

  it("rejects missing points start", () => {
    expect(resolvePointsSync({ pointsWarStartTime: null })).toBeNull();
  });

  it("rejects missing points opponent", () => {
    expect(resolvePointsSync({ pointsOpponentTag: null })).toBeNull();
  });

  it("rejects invalid points sync values", () => {
    expect(resolvePointsSync({ pointsSyncNumber: 0 })).toBeNull();
    expect(resolvePointsSync({ pointsSyncNumber: -1 })).toBeNull();
    expect(resolvePointsSync({ pointsSyncNumber: Number.NaN })).toBeNull();
  });

  it("allows legacy rows without a war ID when the physical identity matches", () => {
    expect(
      resolvePointsSync({
        pointsWarId: null,
      }),
    ).toBe(535);
  });
});

describe("WarEventLogService sync-number lifecycle", () => {
  it("uses the canonical sync number for war_started payloads and tied-point outcome", async () => {
    const clanTag = "#1AAAA";
    const opponentTag = "#2AAAA";
    const currentWarStore = createCurrentWarStore({
      clanTag,
      opponentTag,
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "notInWar",
      prepStartTime,
      startTime: prepStartTime,
      opponentName: "Old Opponent",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        clanTag,
        opponentTag,
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        pointsSyncNum: 534,
        state: "unknown",
        startTime: prepStartTime,
        prepStartTime,
        opponentName: "Old Opponent",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5002,
        syncNumber: 535,
        syncNum: 535,
        state: "preparation",
        prepStartTime: newWarStartTime,
        startTime: newWarStartTime,
        endTime: null,
        opponentTag,
        opponentName: "New Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "preparation",
        startTime: newWarStartTime,
        opponentTag,
      }),
      currentWarStore,
    );
    (service as any).resolveNotifyEventSyncNumber = vi.fn().mockResolvedValue(534);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi.fn().mockImplementation(
      async (tag: string) => ({
        balance: 100,
        winnerBoxTags: tag === clanTag ? [opponentTag] : [],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: null,
      }),
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", clanTag, {
      previousSync: 534,
      activeSync: 534,
      resolveActiveSyncNumber,
    });

    const expectedOutcome = deriveExpectedOutcome(
      clanTag,
      opponentTag,
      100,
      100,
      535,
    );
    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect((service as any).resolveNotifyEventSyncNumber).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5002,
      syncNumber: 535,
      state: "preparation",
      opponentTag,
    });
    expect(expectedOutcome).not.toBe(
      deriveExpectedOutcome(clanTag, opponentTag, 100, 100, 534),
    );
  });

  it("rejects completed-war points rows during a new war start and allocates the next canonical sync", async () => {
    const clanTag = "#1AAAA";
    const oldOpponentTag = "#0PPX";
    const newOpponentTag = "#2AAAA";
    const currentWarStore = createCurrentWarStore({
      clanTag,
      warId: 5002,
      syncNumber: null,
      syncNum: null,
      state: "preparation",
      prepStartTime: newWarStartTime,
      startTime: newWarStartTime,
      opponentTag: newOpponentTag,
      opponentName: "New Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        clanTag,
        opponentTag: oldOpponentTag,
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        pointsSyncNum: 534,
        state: "notInWar",
        startTime: sameWarStartTime,
        prepStartTime: sameWarStartTime,
        opponentName: "Old Opponent",
        pointsWarId: "5001",
        pointsWarStartTime: sameWarStartTime,
        pointsOpponentTag: oldOpponentTag,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () =>
      currentWarStore.snapshot(),
    );
    const service = makeService(
      makeWarSnapshot({
        state: "preparation",
        startTime: newWarStartTime,
        opponentTag: newOpponentTag,
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi.fn().mockImplementation(
      async (tag: string) => ({
        balance: 100,
        winnerBoxTags: tag === clanTag ? [newOpponentTag] : [],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: 535,
      }),
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", clanTag, {
      previousSync: 534,
      activeSync: null,
      resolveActiveSyncNumber,
    });

    const allocationResolution = await resolveActiveSyncNumber.mock.results[0]?.value;

    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect(allocationResolution).toBeUndefined();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5002,
      syncNumber: null,
      state: "preparation",
      opponentTag: newOpponentTag,
    });
  });

  it("uses the canonical sync number for battle_day payloads", async () => {
    const clanTag = "#1AAAA";
    const opponentTag = "#2AAAA";
    const currentWarStore = createCurrentWarStore({
      clanTag,
      opponentTag,
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "preparation",
      prepStartTime,
      startTime: prepStartTime,
      opponentName: "Old Opponent",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        clanTag,
        opponentTag,
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        pointsSyncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentName: "Old Opponent",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5002,
        syncNumber: 535,
        syncNum: 535,
        state: "inWar",
        prepStartTime: newWarStartTime,
        startTime: newWarStartTime,
        endTime: null,
        opponentTag,
        opponentName: "New Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag,
      }),
      currentWarStore,
    );
    (service as any).resolveNotifyEventSyncNumber = vi.fn().mockResolvedValue(534);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi.fn().mockImplementation(
      async (tag: string) => ({
        balance: 100,
        winnerBoxTags: tag === clanTag ? [opponentTag] : [],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: null,
      }),
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", clanTag, {
      previousSync: 534,
      activeSync: 534,
      resolveActiveSyncNumber,
    });

    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect((service as any).resolveNotifyEventSyncNumber).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5002,
      syncNumber: 535,
      state: "inWar",
      opponentTag,
    });
  });

  it("keeps the canonical sync number during a routine preparation refresh", async () => {
    const currentWarStore = createCurrentWarStore({
      state: "preparation",
      prepStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        state: "preparation",
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    const service = makeService(
      makeWarSnapshot({
        state: "preparation",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
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
    expectNoPreliminarySyncClear();
    expect(currentWarStore.state.syncNumber).toBe(534);
  });

  it("keeps the canonical sync number during a routine inWar refresh", async () => {
    const currentWarStore = createCurrentWarStore({
      state: "inWar",
      prepStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        state: "inWar",
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
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
    expectNoPreliminarySyncClear();
    expect(currentWarStore.state.syncNumber).toBe(534);
  });

  it("retains the canonical sync number for the same physical war", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([makeSubscriptionRow()]);
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
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
    expectNoPreliminarySyncClear();
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledWith(
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

  it("keeps a same-war sync intact if the resolver throws", async () => {
    const currentWarStore = createCurrentWarStore({
      state: "preparation",
      prepStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        state: "preparation",
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    const service = makeService(
      makeWarSnapshot({
        state: "preparation",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
    );
    const resolveActiveSyncNumber = vi
      .fn()
      .mockRejectedValue(new Error("sync resolver boom"));

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
        previousSync: 534,
        activeSync: 534,
        resolveActiveSyncNumber,
      }),
    ).rejects.toThrow("sync resolver boom");

    expect(resolveActiveSyncNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        currentWarCanonicalSyncNumber: 534,
      }),
    );
    expectNoPreliminarySyncClear();
    expect(currentWarStore.state.syncNumber).toBe(534);
  });

  it("keeps a same-war sync intact when the final CAS misses", async () => {
    const currentWarStore = createCurrentWarStore({
      state: "preparation",
      prepStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        state: "preparation",
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        opponentName: "Fresh Opponent",
        clanName: "Fresh Clan",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "preparation",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
    );
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: 534,
      resolveActiveSyncNumber,
    });

    expectNoPreliminarySyncClear();
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
    expect(
      prismaMock.currentWar.updateMany.mock.calls[0]?.[0]?.where?.updatedAt?.getTime(),
    ).not.toBe(currentWarStore.state.updatedAt.getTime());
    expect(currentWarStore.state.syncNumber).toBe(534);
    expect(currentWarStore.state.opponentName).toBe("Fresh Opponent");
    expect(currentWarStore.state.clanName).toBe("Fresh Clan");
  });

  it("keeps the completed-war canonical sync during war-ended processing", async () => {
    const currentWarStore = createCurrentWarStore({
      state: "inWar",
      prepStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        state: "inWar",
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    const service = makeService(
      makeWarSnapshot({
        state: "notInWar",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
    );
    (service as any).resolveNotifyEventSyncNumber = vi.fn().mockResolvedValue(534);

    await (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: 534,
    });

    expectNoPreliminarySyncClear();
    expect(currentWarStore.state.syncNumber).toBe(534);
  });

  it("rejects a stale same-war row before finalization reread", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "inWar",
      prepStartTime: sameWarStartTime,
      startTime: sameWarStartTime,
      opponentTag: "#0PPX",
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "inWar",
        startTime: sameWarStartTime,
        prepStartTime: sameWarStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: sameWarStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      mutateCurrentWarStore(currentWarStore, {
        warId: 5003,
        syncNumber: 999,
        syncNum: 999,
        state: "inWar",
        prepStartTime: new Date("2026-03-22T09:00:00.000Z"),
        startTime: new Date("2026-03-22T09:00:00.000Z"),
        endTime: null,
        opponentTag: "#0PPZ",
        opponentName: "Third Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return currentWarStore.snapshot();
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: sameWarStartTime,
        opponentTag: "#0PPX",
      }),
      currentWarStore,
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

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
        previousSync: 533,
        activeSync: 534,
        resolveActiveSyncNumber,
      }),
    ).resolves.toBe(false);

    expectNoPreliminarySyncClear();
    expectNoFinalizationUpdateMany();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect((service as any).fwaPolice.enforceWarViolations).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5003,
      syncNumber: 999,
      state: "inWar",
      opponentTag: "#0PPZ",
    });
  });

  it("rejects a stale rollover snapshot and stops processing", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "preparation",
      prepStartTime,
      startTime: prepStartTime,
      opponentTag: "#0PPX",
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5003,
        syncNumber: 999,
        syncNum: 999,
        state: "inWar",
        prepStartTime: new Date("2026-03-22T09:00:00.000Z"),
        startTime: new Date("2026-03-22T09:00:00.000Z"),
        endTime: null,
        opponentTag: "#0PPZ",
        opponentName: "New Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#0PPY",
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
        previousSync: 534,
        activeSync: 534,
        resolveActiveSyncNumber,
      }),
    ).resolves.toBe(false);

    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect((service as any).fwaPolice.enforceWarViolations).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale snapshot that is already unrelated before the first rollover reread", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5003,
      syncNumber: 999,
      syncNum: 999,
      state: "inWar",
      prepStartTime: new Date("2026-03-22T09:00:00.000Z"),
      startTime: new Date("2026-03-22T09:00:00.000Z"),
      opponentTag: "#0PPZ",
      opponentName: "Third Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#0PPY",
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
        previousSync: 534,
        activeSync: 534,
        resolveActiveSyncNumber,
      }),
    ).resolves.toBe(false);

    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect((service as any).fwaPolice.enforceWarViolations).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5003,
      syncNumber: 999,
      state: "inWar",
      opponentTag: "#0PPZ",
    });
  });

  it("rejects a stale rollover snapshot when the target identity is already present without sync", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "preparation",
      prepStartTime,
      startTime: prepStartTime,
      opponentTag: "#0PPX",
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5002,
        syncNumber: null,
        syncNum: null,
        state: "inWar",
        prepStartTime: newWarStartTime,
        startTime: newWarStartTime,
        endTime: null,
        opponentTag: "#0PPY",
        opponentName: "New Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#0PPY",
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        balance: 145,
        winnerBoxTags: ["#0PPY"],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: 535,
      })
      .mockResolvedValueOnce({
        balance: 132,
        winnerBoxTags: [],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: 535,
      });
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: null,
      resolveActiveSyncNumber,
    })).resolves.toBe(false);

    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect(getCurrentWarUpdateManyCallsByKind("preliminary_rollover")).toHaveLength(
      1,
    );
    expect(getCurrentWarUpdateManyCallsByKind("finalization")).toHaveLength(0);
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5002,
      syncNumber: null,
      state: "inWar",
      opponentTag: "#0PPY",
    });
  });

  it("rejects a rollover snapshot when a newer same-war revision already exists", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "preparation",
      prepStartTime,
      startTime: prepStartTime,
      opponentTag: "#0PPX",
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5002,
        syncNumber: 535,
        syncNum: 535,
        state: "inWar",
        prepStartTime: newWarStartTime,
        startTime: newWarStartTime,
        endTime: null,
        opponentTag: "#0PPY",
        opponentName: "New Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#0PPY",
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: true,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).points.fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        balance: 145,
        winnerBoxTags: ["#0PPY"],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: 535,
      })
      .mockResolvedValueOnce({
        balance: 132,
        winnerBoxTags: [],
        winnerBoxText: "Marked as an FWA match",
        activeFwa: true,
        notFound: false,
        fetchedAtMs: Date.now(),
        effectiveSync: 535,
      });
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
      previousSync: 534,
      activeSync: null,
      resolveActiveSyncNumber,
    })).resolves.toBe(false);

    expect(resolveActiveSyncNumber).not.toHaveBeenCalled();
    expect(getCurrentWarUpdateManyCallsByKind("preliminary_rollover")).toHaveLength(
      1,
    );
    expect(getCurrentWarUpdateManyCallsByKind("finalization")).toHaveLength(0);
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5002,
      syncNumber: 535,
      state: "inWar",
      opponentTag: "#0PPY",
    });
  });

  it("rejects a stale active-rollover row before finalization reread", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5002,
      syncNumber: 535,
      syncNum: 535,
      state: "inWar",
      prepStartTime: newWarStartTime,
      startTime: newWarStartTime,
      opponentTag: "#0PPY",
      opponentName: "New Opponent",
      clanName: "Rocky Road",
    });
    prismaMock.$queryRaw.mockResolvedValueOnce([
      makeSubscriptionRow({
        warId: 5001,
        syncNumber: 534,
        syncNum: 534,
        state: "preparation",
        startTime: prepStartTime,
        prepStartTime,
        opponentTag: "#0PPX",
        pointsWarStartTime: prepStartTime,
        updatedAt: currentWarStore.state.updatedAt,
      }),
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValueOnce({ warId: 5002 });
    prismaMock.currentWar.findUnique.mockImplementationOnce(async () => {
      const snapshot = currentWarStore.snapshot();
      mutateCurrentWarStore(currentWarStore, {
        warId: 5003,
        syncNumber: 999,
        syncNum: 999,
        state: "inWar",
        prepStartTime: new Date("2026-03-22T09:00:00.000Z"),
        startTime: new Date("2026-03-22T09:00:00.000Z"),
        endTime: null,
        opponentTag: "#0PPZ",
        opponentName: "Third Opponent",
        clanName: "Rocky Road",
        updatedAt: new Date(currentWarStore.state.updatedAt.getTime() + 1000),
      });
      return snapshot;
    });
    const service = makeService(
      makeWarSnapshot({
        state: "inWar",
        startTime: newWarStartTime,
        opponentTag: "#0PPY",
      }),
      currentWarStore,
    );
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    const resolveActiveSyncNumber = makeResolveActiveSyncNumber();

    await expect(
      (service as any).processSubscription("guild-1", testClanTag, {
        previousSync: 534,
        activeSync: 534,
        resolveActiveSyncNumber,
      }),
    ).resolves.toBe(false);

    expectNoPreliminarySyncClear();
    expectNoFinalizationUpdateMany();
    expect((service as any).currentSyncs.upsertPointsSync).not.toHaveBeenCalled();
    expect((service as any).syncWarAttacksFromWarSnapshot).not.toHaveBeenCalled();
    expect((service as any).fwaPolice.enforceWarViolations).not.toHaveBeenCalled();
    expect((service as any).dispatchDetectedEvent).not.toHaveBeenCalled();
    expect(currentWarStore.state).toMatchObject({
      warId: 5003,
      syncNumber: 999,
      state: "inWar",
      opponentTag: "#0PPZ",
    });
  });

  it("returns zero from updateMany when the CAS where clause misses and leaves the row untouched", async () => {
    const currentWarStore = createCurrentWarStore({
      warId: 5001,
      syncNumber: 534,
      syncNum: 534,
      state: "preparation",
      prepStartTime,
      startTime: prepStartTime,
      opponentTag: "#0PPX",
      opponentName: "Old Opponent",
      clanName: "Rocky Road",
    });
    const beforeSnapshot = currentWarStore.snapshot();
    const beforeUpdatedAt = currentWarStore.state.updatedAt.getTime();

    const result = await prismaMock.currentWar.updateMany({
      where: {
        guildId: testGuildId,
        clanTag: testClanTag,
        warId: 9999,
        syncNumber: 777,
      },
      data: {
        syncNumber: 888,
        state: "inWar",
      },
    });

    expect(result).toEqual({ count: 0 });
    expect(currentWarStore.state).toMatchObject({
      warId: beforeSnapshot.warId,
      syncNumber: beforeSnapshot.syncNumber,
      syncNum: beforeSnapshot.syncNum,
      state: beforeSnapshot.state,
      opponentTag: beforeSnapshot.opponentTag,
    });
    expect(currentWarStore.state.updatedAt.getTime()).toBe(beforeUpdatedAt);
  });
});
