import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../src/services/TrackedMessageService";

const syncTime = new Date("2026-11-15T11:00:00.000Z");
const observedAt = new Date("2026-11-15T12:00:00.000Z");

type Claim = { trackedMessageId: string; userId: string; clanTag: string };
type Row = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  featureType: string;
  status: string;
  referenceId: string | null;
  expiresAt: Date;
  createdAt: Date;
  metadata: any;
};

const state = {
  rows: [] as Row[],
  claims: [] as Claim[],
  events: [] as any[],
  failHistory: false,
  forceDuplicateCreate: false,
  duplicateWinner: null as Claim | null,
  eventOrderAllocations: [] as number[],
};

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  trackedMessageClaim: {
    findUnique: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  syncReactionHistory: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

function makeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    syncTimeIso: syncTime.toISOString(),
    syncEpochSeconds: Math.floor(syncTime.getTime() / 1000),
    roleId: "role-1",
    clans: [
      {
        code: "A",
        clanTag: "#PYLQ",
        clanName: "Alpha",
        emojiId: "111",
        emojiName: "alpha",
        emojiInline: "<:alpha:111>",
      },
      {
        code: "B",
        clanTag: "#PYLG",
        clanName: "Bravo",
        emojiId: "222",
        emojiName: "bravo",
        emojiInline: "<:bravo:222>",
      },
    ],
    ...overrides,
  };
}

function makeRows(metadata = makeMetadata()): Row[] {
  return [
    {
      id: "root-db-id",
      guildId: "guild-1",
      channelId: "source-channel",
      messageId: "root-message",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: null,
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
      createdAt: new Date("2026-11-15T10:00:00.000Z"),
      metadata,
    },
    {
      id: "status-db-id",
      guildId: "guild-1",
      channelId: "status-channel",
      messageId: "status-message",
      featureType: TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST,
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      referenceId: "root-message",
      expiresAt: new Date("2026-11-15T13:00:00.000Z"),
      createdAt: new Date("2026-11-15T10:30:00.000Z"),
      metadata,
    },
  ];
}

function reaction(emojiId = "111") {
  return { emoji: { id: emojiId, name: emojiId === "111" ? "alpha" : "bravo" } };
}

function restoreSnapshot(snapshot: { rows: Row[]; claims: Claim[]; events: any[] }) {
  state.rows = snapshot.rows;
  state.claims = snapshot.claims;
  state.events = snapshot.events;
}

function matchesWhere(row: Row, where: any): boolean {
  if (!where) return true;
  if (where.OR) return where.OR.some((branch: any) => matchesWhere(row, branch));
  if (where.AND) return where.AND.every((branch: any) => matchesWhere(row, branch));
  return Object.entries(where).every(([field, expected]) => {
    if (field === "OR" || field === "AND") return true;
    const actual = (row as any)[field];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected as Record<string, unknown>).every(([operator, value]) => {
        if (operator === "equals") return actual === value;
        if (operator === "lt") return actual instanceof Date ? actual < new Date(String(value)) : actual < value;
        if (operator === "lte") return actual instanceof Date ? actual <= new Date(String(value)) : actual <= value;
        if (operator === "gt") return actual instanceof Date ? actual > new Date(String(value)) : actual > value;
        if (operator === "gte") return actual instanceof Date ? actual >= new Date(String(value)) : actual >= value;
        return false;
      });
    }
    return actual === expected;
  });
}

beforeEach(() => {
  state.rows = makeRows();
  state.claims = [];
  state.events = [];
  state.failHistory = false;
  state.forceDuplicateCreate = false;
  state.duplicateWinner = null;
  state.eventOrderAllocations = [];
  vi.clearAllMocks();

  prismaMock.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
    const snapshot = structuredClone({ rows: state.rows, claims: state.claims, events: state.events });
    try {
      return await callback(prismaMock);
    } catch (error) {
      restoreSnapshot(snapshot);
      if ((error as { code?: string }).code === "P2002" && state.duplicateWinner) {
        state.claims.push(state.duplicateWinner);
      }
      throw error;
    }
  });
  prismaMock.trackedMessage.findUnique.mockImplementation(async ({ where }: any) =>
    state.rows.find((row) => row.messageId === where.messageId) ?? null,
  );
  prismaMock.trackedMessage.findFirst.mockImplementation(async ({ where }: any) =>
    [...state.rows]
      .filter((row) => matchesWhere(row, where))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
  );
  prismaMock.trackedMessageClaim.findUnique.mockImplementation(async ({ where }: any) =>
    state.claims.find((claim) =>
      claim.trackedMessageId === where.trackedMessageId_userId_clanTag.trackedMessageId &&
      claim.userId === where.trackedMessageId_userId_clanTag.userId &&
      claim.clanTag === where.trackedMessageId_userId_clanTag.clanTag,
    ) ?? null,
  );
  prismaMock.trackedMessageClaim.create.mockImplementation(async ({ data }: any) => {
    if (state.forceDuplicateCreate) {
      state.forceDuplicateCreate = false;
      state.duplicateWinner = data;
      throw Object.assign(new Error("unique claim"), { code: "P2002" });
    }
    state.claims.push(data);
    return data;
  });
  prismaMock.trackedMessageClaim.deleteMany.mockImplementation(async ({ where }: any) => {
    const before = state.claims.length;
    state.claims = state.claims.filter((claim) =>
      claim.trackedMessageId !== where.trackedMessageId ||
      claim.userId !== where.userId ||
      claim.clanTag !== where.clanTag,
    );
    return { count: before - state.claims.length };
  });
  prismaMock.syncReactionHistory.create.mockImplementation(async ({ data }: any) => {
    if (state.failHistory) throw new Error("history unavailable");
    const event = {
      id: `history-${state.events.length + 1}`,
      eventOrder: state.eventOrderAllocations.shift() ?? state.events.length + 1,
      createdAt: new Date("2026-11-15T12:00:01.000Z"),
      ...data,
    };
    state.events.push(event);
    return event;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sync reaction history", () => {
  it("records source and status transitions against one canonical root", async () => {
    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
      .resolves.toBe(true);
    await expect(trackedMessageService.recordSyncClaim("status-message", "user-b", reaction("222"), observedAt))
      .resolves.toBe(true);

    expect(state.events).toHaveLength(2);
    expect(state.events).toEqual([
      expect.objectContaining({
        action: "ADD",
        syncRootTrackedId: "root-db-id",
        syncRootMessageId: "root-message",
        trackedMessageId: "root-db-id",
        messageId: "root-message",
        discordUserId: "user-a",
        clanTag: "#PYLQ",
        syncTime,
        observedAt,
        eventOrder: 1,
      }),
      expect.objectContaining({
        action: "ADD",
        syncRootTrackedId: "root-db-id",
        syncRootMessageId: "root-message",
        trackedMessageId: "status-db-id",
        messageId: "status-message",
        discordUserId: "user-b",
        clanTag: "#PYLG",
        syncTime,
        observedAt,
        eventOrder: 2,
      }),
    ]);
  });

  it("does not mutate sync claims or history in mirror runtime", async () => {
    vi.stubEnv("POLLING_MODE", "mirror");

    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
      .resolves.toBe(false);
    await expect(trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), observedAt))
      .resolves.toBe(false);

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(state.claims).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("preserves valid pre-sync ADD and REMOVE current-state transitions", async () => {
    const earlyObservedAt = new Date("2026-11-15T10:30:00.000Z");

    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), earlyObservedAt))
      .resolves.toBe(true);
    expect(state.claims).toEqual([
      { trackedMessageId: "root-db-id", userId: "user-a", clanTag: "#PYLQ" },
    ]);
    expect(state.events[0]).toMatchObject({
      action: "ADD",
      observationPhase: "PRE_SYNC",
      observedAt: earlyObservedAt,
    });

    const earlyRemoveObservedAt = new Date("2026-11-15T10:45:00.000Z");
    await expect(trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), earlyRemoveObservedAt))
      .resolves.toBe(true);
    expect(state.claims).toHaveLength(0);
    expect(state.events[1]).toMatchObject({
      action: "REMOVE",
      observationPhase: "PRE_SYNC",
      observedAt: earlyRemoveObservedAt,
    });
  });

  it("keeps sequence allocation order separate from observed timing", async () => {
    state.eventOrderAllocations = [20, 10];
    const earlyObservedAt = new Date("2026-11-15T10:30:00.000Z");

    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), earlyObservedAt);
    await trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), observedAt);

    expect(state.events).toEqual([
      expect.objectContaining({ eventOrder: 20, observationPhase: "PRE_SYNC", observedAt: earlyObservedAt }),
      expect.objectContaining({ eventOrder: 10, observationPhase: "POST_SYNC", observedAt }),
    ]);
  });

  it("records only absent-to-present and present-to-absent transitions", async () => {
    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt);
    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), new Date(observedAt.getTime() + 1));
    await trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), new Date(observedAt.getTime() + 2));
    await trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), new Date(observedAt.getTime() + 3));
    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), new Date(observedAt.getTime() + 4));

    expect(state.events.map((event) => event.action)).toEqual(["ADD", "REMOVE", "ADD"]);
    expect(state.claims).toEqual([
      { trackedMessageId: "root-db-id", userId: "user-a", clanTag: "#PYLQ" },
    ]);
  });

  it("preserves multiple users claiming one clan without duplicate transitions", async () => {
    await Promise.all([
      trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt),
      trackedMessageService.recordSyncClaim("root-message", "user-b", reaction(), observedAt),
    ]);
    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt);

    expect(state.claims).toHaveLength(2);
    expect(state.events).toHaveLength(2);
    expect(new Set(state.events.map((event) => event.clanTag))).toEqual(new Set(["#PYLQ"]));
  });

  it("handles a conflicting duplicate ADD without inventing history", async () => {
    state.forceDuplicateCreate = true;

    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
      .resolves.toBe(true);

    expect(state.events).toHaveLength(0);
    expect(state.claims).toEqual([
      { trackedMessageId: "root-db-id", userId: "user-a", clanTag: "#PYLQ" },
    ]);
  });

  it("keeps a concurrent conflicting ADD and REMOVE sequence truthful", async () => {
    const [addResult, removeResult] = await Promise.all([
      trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt),
      trackedMessageService.removeSyncClaim(
        "root-message",
        "user-a",
        reaction(),
        new Date(observedAt.getTime() + 1),
      ),
    ]);

    expect([addResult, removeResult]).toEqual([true, true]);
    const actions = state.events.map((event) => event.action);
    if (state.claims.length === 0) {
      expect(actions).toEqual(["ADD", "REMOVE"]);
    } else {
      expect(actions).toEqual(["ADD"]);
    }
  });

  it("does not create a remove event when the current claim is absent", async () => {
    await expect(trackedMessageService.removeSyncClaim("status-message", "user-a", reaction(), observedAt))
      .resolves.toBe(true);
    expect(state.events).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });

  it("rolls back the current-state mutation when history persistence fails", async () => {
    state.failHistory = true;
    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
      .rejects.toThrow("history unavailable");
    expect(state.claims).toHaveLength(0);
    expect(state.events).toHaveLength(0);

    state.failHistory = false;
    await trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt);
    state.failHistory = true;
    await expect(trackedMessageService.removeSyncClaim("root-message", "user-a", reaction(), observedAt))
      .rejects.toThrow("history unavailable");
    expect(state.claims).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it("fails closed for expired, replaced, malformed, and stale identities", async () => {
    const cases = [
      () => { state.rows[0].expiresAt = new Date("2026-11-15T11:59:59.000Z"); },
      () => { state.rows[0].status = TRACKED_MESSAGE_STATUS.REPLACED; },
      () => { state.rows[0].metadata = makeMetadata({ syncTimeIso: "not-a-time" }); },
      () => {
        state.rows.push({
          ...state.rows[0],
          id: "new-root-db-id",
          messageId: "new-root-message",
          createdAt: new Date("2026-11-15T10:30:00.000Z"),
          referenceId: null,
          status: TRACKED_MESSAGE_STATUS.ACTIVE,
        });
      },
      () => {
        state.rows[0].metadata = makeMetadata({
          clans: [{
            code: "A",
            clanTag: "not-a-clash-tag",
            clanName: "Malformed",
            emojiId: "111",
            emojiName: "alpha",
            emojiInline: "<:alpha:111>",
          }],
        });
      },
    ];

    for (const setup of cases) {
      state.rows = makeRows();
      state.claims = [];
      state.events = [];
      setup();
      await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
        .resolves.toBe(false);
      expect(state.claims).toHaveLength(0);
      expect(state.events).toHaveLength(0);
    }

    state.rows = makeRows();
    state.claims = [];
    state.events = [];
    state.rows[0].metadata = makeMetadata({
      syncTimeIso: "2026-11-15T13:00:00.000Z",
      syncEpochSeconds: Math.floor(new Date("2026-11-15T13:00:00.000Z").getTime() / 1000),
    });

    await expect(trackedMessageService.recordSyncClaim("root-message", "user-a", reaction(), observedAt))
      .resolves.toBe(true);
    expect(state.claims).toHaveLength(1);
    expect(state.events).toMatchObject([{
      action: "ADD",
      observationPhase: "PRE_SYNC",
      observedAt,
    }]);
  });
});
