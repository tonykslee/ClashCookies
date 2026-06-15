import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/services/SettingsService";
import {
  PointsDirectFetchGateService,
  derivePointsLockLifecycleStateForTest,
  type PointsLockStateRecord,
} from "../src/services/PointsDirectFetchGateService";
import { trackedMessageService } from "../src/services/TrackedMessageService";

type TrackedMessageRow = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  featureType: string;
  status: string;
  referenceId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findUnique: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
  },
  clanPointsSync: {
    findFirst: vi.fn(),
  },
  warMailLifecycle: {
    findFirst: vi.fn(),
  },
  trackedMessage: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeSyncMetadata(syncEpochSeconds: number) {
  return {
    syncTimeIso: new Date(syncEpochSeconds * 1000).toISOString(),
    syncEpochSeconds,
    roleId: "123456789012345678",
    clans: [
      {
        code: "RR",
        clanTag: "#PYLQ",
        clanName: "Rocky Road",
        emojiId: "111",
        emojiName: "rr",
        emojiInline: "<:rr:111>",
      },
    ],
  };
}

function makeTrackedRoot(overrides: Partial<TrackedMessageRow> = {}): TrackedMessageRow {
  return {
    id: "tracked-root",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "sync-message-1",
    featureType: "SYNC_TIME_POST",
    status: "ACTIVE",
    referenceId: null,
    metadata: makeSyncMetadata(Math.floor(new Date("2026-03-09T09:00:00.000Z").getTime() / 1000)),
    createdAt: new Date("2026-03-09T08:30:00.000Z"),
    updatedAt: new Date("2026-03-09T08:30:00.000Z"),
    ...overrides,
  };
}

function makeStandaloneReadinessRow(overrides: Partial<TrackedMessageRow> = {}): TrackedMessageRow {
  return {
    id: "tracked-readiness",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "readiness-message",
    featureType: "SYNC_TIME_POST",
    status: "ACTIVE",
    referenceId: null,
    metadata: {
      readinessEnabled: true,
      createdAtIso: "2026-03-09T07:00:00.000Z",
    },
    createdAt: new Date("2026-03-09T08:00:00.000Z"),
    updatedAt: new Date("2026-03-09T08:00:00.000Z"),
    ...overrides,
  };
}

function makeChildRow(overrides: Partial<TrackedMessageRow> = {}): TrackedMessageRow {
  return {
    id: "tracked-child",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "sync-child-message",
    featureType: "SYNC_TIME_POST",
    status: "ACTIVE",
    referenceId: "sync-message-1",
    metadata: makeSyncMetadata(Math.floor(new Date("2026-03-09T09:00:00.000Z").getTime() / 1000)),
    createdAt: new Date("2026-03-09T08:10:00.000Z"),
    updatedAt: new Date("2026-03-09T08:10:00.000Z"),
    ...overrides,
  };
}

function makeCurrentWar(overrides: Record<string, unknown> = {}) {
  return {
    guildId: "guild-1",
    warId: null,
    state: "notInWar",
    startTime: null,
    endTime: null,
    opponentTag: null,
    matchType: "FWA",
    fwaPoints: null,
    updatedAt: new Date("2026-03-09T08:05:00.000Z"),
    ...overrides,
  };
}

function sortRows(rows: TrackedMessageRow[], orderBy: Array<Record<string, "asc" | "desc">> = []) {
  return [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const [field, direction] = Object.entries(order)[0] ?? [];
      if (!field || !direction) continue;
      const leftValue = left[field as keyof TrackedMessageRow];
      const rightValue = right[field as keyof TrackedMessageRow];
      const comparison =
        leftValue instanceof Date && rightValue instanceof Date
          ? leftValue.getTime() - rightValue.getTime()
          : String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
      if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
}

function matchesWhere(row: TrackedMessageRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === "guildId" || key === "featureType" || key === "referenceId" || key === "status") {
      return row[key as keyof TrackedMessageRow] === value;
    }
    return true;
  });
}

async function evaluateGate(options: {
  trackedRows: TrackedMessageRow[];
  legacySetting: number | null;
  currentWar?: Record<string, unknown> | null;
  persistedLockState?: PointsLockStateRecord | null;
  nowMs?: number;
}) {
  const service = new PointsDirectFetchGateService();
  const settingsGetSpy = vi.spyOn(SettingsService.prototype, "get").mockImplementation(async (key: string) => {
    if (key.startsWith("active_sync_post:")) {
      return options.legacySetting === null
        ? null
        : JSON.stringify({ epochSeconds: Math.trunc(options.legacySetting / 1000) });
    }
    if (key.startsWith("points_lock_state:")) {
      return options.persistedLockState ? JSON.stringify(options.persistedLockState) : null;
    }
    return null;
  });
  const settingsSetSpy = vi.spyOn(SettingsService.prototype, "set").mockImplementation(async (key: string, value: string) => {
    if (key.startsWith("points_lock_state:")) {
      options.persistedLockState = JSON.parse(value) as PointsLockStateRecord;
    }
  });
  const resolveSpy = vi.spyOn(trackedMessageService, "resolveLatestActiveSyncPost");

  prismaMock.trackedClan.findUnique.mockResolvedValue({ tag: "#AAA111" });
  prismaMock.currentWar.findFirst.mockResolvedValue(options.currentWar ?? makeCurrentWar());
  prismaMock.clanPointsSync.findFirst.mockResolvedValue(null);
  prismaMock.warMailLifecycle.findFirst.mockResolvedValue(null);
  prismaMock.trackedMessage.findFirst.mockImplementation(async ({ where, orderBy }: any) => {
    const rows = options.trackedRows.filter((row) => matchesWhere(row, where));
    return sortRows(rows, orderBy)[0] ?? null;
  });

  const decision = await service.evaluateFetchAccess({
    clanTag: "#AAA111",
    caller: "command",
    fetchReason: "match_render",
    nowMs: options.nowMs ?? new Date("2026-03-09T08:40:00.000Z").getTime(),
  });

  return {
    decision,
    settingsGetSpy,
    settingsSetSpy,
    resolveSpy,
  };
}

describe("PointsDirectFetchGateService posted sync source resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("uses a valid active tracked sync epoch when no legacy setting exists", async () => {
    const { decision, settingsGetSpy, resolveSpy } = await evaluateGate({
      trackedRows: [makeTrackedRoot()],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(resolveSpy).toHaveBeenCalledWith("guild-1");
    expect(decision.postedSyncAtMs).toBe(new Date("2026-03-09T09:00:00.000Z").getTime());
    expect(settingsGetSpy.mock.calls.map((call) => call[0]).some((key) => key.startsWith("active_sync_post:"))).toBe(false);
  });

  it("lets a valid tracked epoch win over a stale legacy setting", async () => {
    const { decision, settingsGetSpy } = await evaluateGate({
      trackedRows: [makeTrackedRoot()],
      legacySetting: new Date("2026-03-09T07:00:00.000Z").getTime(),
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBe(new Date("2026-03-09T09:00:00.000Z").getTime());
    expect(settingsGetSpy.mock.calls.map((call) => call[0]).some((key) => key.startsWith("active_sync_post:"))).toBe(false);
  });

  it("does not read the legacy active-sync setting when valid tracked metadata is available", async () => {
    const { settingsGetSpy } = await evaluateGate({
      trackedRows: [makeTrackedRoot()],
      legacySetting: new Date("2026-03-09T06:00:00.000Z").getTime(),
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(settingsGetSpy.mock.calls.filter((call) => String(call[0]).startsWith("active_sync_post:"))).toHaveLength(0);
  });

  it("uses the legacy setting when there is no active tracked root", async () => {
    const legacySetting = new Date("2026-03-09T07:00:00.000Z").getTime();
    const { decision, settingsGetSpy } = await evaluateGate({
      trackedRows: [],
      legacySetting,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBe(legacySetting);
    expect(settingsGetSpy.mock.calls.some((call) => String(call[0]).startsWith("active_sync_post:"))).toBe(true);
  });

  it("uses the legacy setting when tracked metadata is malformed", async () => {
    const legacySetting = new Date("2026-03-09T07:00:00.000Z").getTime();
    const { decision, settingsGetSpy } = await evaluateGate({
      trackedRows: [
        makeTrackedRoot({
          metadata: { syncEpochSeconds: "bad", syncTimeIso: "invalid", roleId: "role-1", clans: [] },
        }),
      ],
      legacySetting,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBe(legacySetting);
    expect(settingsGetSpy.mock.calls.some((call) => String(call[0]).startsWith("active_sync_post:"))).toBe(true);
  });

  it("rejects standalone readiness metadata and leaves postedSyncAtMs null without a legacy setting", async () => {
    const { decision } = await evaluateGate({
      trackedRows: [makeStandaloneReadinessRow()],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBeNull();
  });

  it("rejects a child sync-status row from becoming postedSyncAtMs", async () => {
    const { decision } = await evaluateGate({
      trackedRows: [makeChildRow()],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBeNull();
  });

  it("rejects replaced sync roots because active ownership resolution excludes them", async () => {
    const { decision } = await evaluateGate({
      trackedRows: [
        makeTrackedRoot({ id: "tracked-replaced", status: "REPLACED" }),
      ],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBeNull();
  });

  it("rejects completed sync roots because active ownership resolution excludes them", async () => {
    const { decision } = await evaluateGate({
      trackedRows: [
        makeTrackedRoot({ id: "tracked-completed", status: "COMPLETED" }),
      ],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBeNull();
  });

  it("keeps postedSyncAtMs null when neither tracked state nor legacy setting exists", async () => {
    const { decision } = await evaluateGate({
      trackedRows: [],
      legacySetting: null,
      currentWar: makeCurrentWar({ matchType: "FWA" }),
    });

    expect(decision.postedSyncAtMs).toBeNull();
  });

  it("preserves prior.postedSyncAtMs from persisted lock state when runtime has no posted sync source", () => {
    const prior = derivePointsLockLifecycleStateForTest({
      runtime: {
        tracked: true,
        clanTag: "#AAA111",
        guildId: "guild-1",
        warState: "notInWar",
        matchType: "FWA",
        activeWarId: null,
        activeWarStartMs: null,
        activeWarEndMs: null,
        activeOpponentTag: null,
        mailLifecycleStatus: null,
        lifecycle: null,
        latestKnownPoints: null,
        postedSyncAtMs: null,
        hasReusableWarSnapshot: false,
      },
      persisted: {
        lifecycleState: "unlocked",
        clanTag: "#AAA111",
        guildId: "guild-1",
        warId: null,
        warStartMs: null,
        warEndMs: null,
        matchType: "FWA",
        baselinePoints: null,
        pointValueChangedAtMs: null,
        postedSyncAtMs: new Date("2026-03-09T09:00:00.000Z").getTime(),
        lockUntilMs: null,
        updatedAtMs: new Date("2026-03-09T08:00:00.000Z").getTime(),
      },
      nowMs: new Date("2026-03-09T08:40:00.000Z").getTime(),
    });

    expect(prior.postedSyncAtMs).toBe(new Date("2026-03-09T09:00:00.000Z").getTime());
  });

  it("keeps the pre-sync unlock exactly ten minutes before the tracked sync epoch", async () => {
    const trackedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const { decision, settingsGetSpy } = await evaluateGate({
      trackedRows: [makeTrackedRoot()],
      legacySetting: new Date("2026-03-09T07:00:00.000Z").getTime(),
      currentWar: makeCurrentWar({ matchType: "MM" }),
      nowMs: new Date("2026-03-09T08:30:00.000Z").getTime(),
    });

    expect(decision.postedSyncAtMs).toBe(trackedSyncAtMs);
    expect(decision.lockUntilMs).toBe(trackedSyncAtMs - 10 * 60 * 1000);
    expect(settingsGetSpy.mock.calls.filter((call) => String(call[0]).startsWith("active_sync_post:"))).toHaveLength(0);
  });

  it("does not let a stale settings pointer extend or shorten the lock when a current tracked owner exists", async () => {
    const trackedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const { decision } = await evaluateGate({
      trackedRows: [makeTrackedRoot()],
      legacySetting: new Date("2026-03-09T12:00:00.000Z").getTime(),
      currentWar: makeCurrentWar({ matchType: "MM" }),
      nowMs: new Date("2026-03-09T08:30:00.000Z").getTime(),
    });

    expect(decision.postedSyncAtMs).toBe(trackedSyncAtMs);
    expect(decision.lockUntilMs).toBe(trackedSyncAtMs - 10 * 60 * 1000);
  });
});
