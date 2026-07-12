import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import {
  WarStartPointsSyncService,
  type WarStartPointsCheckContext,
} from "../src/services/war-events/pointsSync";

vi.mock("../src/prisma", () => ({
  prisma: {
    currentWar: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    clanWarHistory: {
      findFirst: vi.fn(),
    },
  },
}));

function buildSettingsHarness() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    store,
  };
}

function buildPointsHarness() {
  const now = Date.now();
  return {
    fetchSnapshot: vi.fn().mockImplementation(async (clanTag: string) => {
      const normalized = String(clanTag ?? "").toUpperCase();
      if (normalized === "#AAA111") {
        return {
          balance: 1300,
          winnerBoxTags: ["#OPP123"],
          winnerBoxText: "not marked as an fwa match",
          winnerBoxSync: 44,
          fetchedAtMs: now,
        };
      }
      return {
        balance: 1200,
        activeFwa: false,
        notFound: false,
        fetchedAtMs: now,
      };
    }),
  };
}

function readLatestJobBlob(
  settings: { store: Map<string, string> },
  context: WarStartPointsCheckContext,
) {
  const key = `warStartPointsCheck:${String(context.clanTag ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "")}`;
  const raw = settings.store.get(key);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("WarStartPointsSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildService() {
    const points = buildPointsHarness();
    const settings = buildSettingsHarness();
    const pointsSync = {
      upsertPointsSync: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WarStartPointsSyncService(
      points as any,
      settings as any,
      pointsSync as any,
    );
    return { service, points, settings, pointsSync };
  }

  const context: WarStartPointsCheckContext = {
    guildId: "guild-1",
    clanTag: "#AAA111",
    warId: 1001,
    warStartTime: new Date("2026-03-12T00:00:00.000Z"),
    opponentTag: "#OPP123",
  };

  function exactCurrentWarRow(overrides?: Record<string, unknown>) {
    return {
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1001,
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      opponentTag: "#OPP123",
      fwaPoints: 1300,
      state: "inWar",
      matchType: "FWA",
      inferredMatchType: true,
      clanStars: 100,
      opponentStars: 99,
      ...overrides,
    } as any;
  }

  it("stores the canonical war identity in the retry job blob", async () => {
    const { service, settings } = buildService();

    await service.resetWarStartPointsJob(context);

    expect(settings.set).toHaveBeenCalledTimes(1);
    const [, blob] = settings.set.mock.calls[0] ?? [];
    expect(JSON.parse(String(blob))).toMatchObject({
      clanTag: "#AAA111",
      opponentTag: "#0PP123",
      warId: "1001",
      warStartTime: "2026-03-12T00:00:00.000Z",
      status: "pending",
      completed: false,
    });
  });

  it("creates the first retry job and skips the second poll before the deadline", async () => {
    const { service, points, settings } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(exactCurrentWarRow());
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    points.fetchSnapshot.mockImplementation(async (clanTag: string) => {
      const normalized = String(clanTag ?? "").toUpperCase();
      if (normalized === "#AAA111") {
        return {
          balance: 1300,
          winnerBoxTags: [],
          winnerBoxText: "not marked as an fwa match",
          winnerBoxSync: 44,
          fetchedAtMs: 1_000_000,
        };
      }
      return {
        balance: 1200,
        activeFwa: false,
        notFound: false,
        fetchedAtMs: 1_000_000,
      };
    });

    await service.maybeRunWarStartPointsCheck(context);
    const firstJob = readLatestJobBlob(settings, context);
    const fetchCountAfterFirstRun = points.fetchSnapshot.mock.calls.length;

    expect(firstJob).toMatchObject({
      attempts: 1,
      status: "pending",
      completed: false,
      warId: "1001",
      warStartTime: "2026-03-12T00:00:00.000Z",
    });

    await service.maybeRunWarStartPointsCheck(context);

    expect(points.fetchSnapshot.mock.calls.length).toBe(fetchCountAfterFirstRun);
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      attempts: 1,
      status: "pending",
      completed: false,
    });
    nowSpy.mockRestore();
  });

  it("records in_sync when the exact tracked points match the website balance", async () => {
    const { service, points, settings, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      exactCurrentWarRow({ fwaPoints: 1300 }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).toHaveBeenCalledTimes(1);
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      attempts: 1,
      status: "in_sync",
      completed: true,
      trackedPointBalanceSite: 1300,
      trackedPointBalanceDb: 1300,
    });
    expect(points.fetchSnapshot).toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("records out_of_sync when the exact tracked points differ from the website balance", async () => {
    const { service, settings, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      exactCurrentWarRow({ fwaPoints: 1200 }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).toHaveBeenCalledTimes(1);
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      attempts: 1,
      status: "out_of_sync",
      completed: true,
      trackedPointBalanceSite: 1300,
      trackedPointBalanceDb: 1200,
    });
    nowSpy.mockRestore();
  });

  it("treats null tracked points as a non-mismatch", async () => {
    const { service, settings, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      exactCurrentWarRow({ fwaPoints: null }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).toHaveBeenCalledTimes(1);
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      attempts: 1,
      status: "in_sync",
      completed: true,
      trackedPointBalanceSite: 1300,
      trackedPointBalanceDb: null,
    });
    nowSpy.mockRestore();
  });

  it("reaches max attempts when the exact row never becomes in sync", async () => {
    const { service, points, settings } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      exactCurrentWarRow({ fwaPoints: 1200 }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    points.fetchSnapshot.mockImplementation(async (clanTag: string) => {
      const normalized = String(clanTag ?? "").toUpperCase();
      if (normalized === "#AAA111") {
        return {
          balance: 1300,
          winnerBoxTags: [],
          winnerBoxText: "not marked as an fwa match",
          winnerBoxSync: 44,
          fetchedAtMs: 1_000_000,
        };
      }
      return {
        balance: 1200,
        activeFwa: false,
        notFound: false,
        fetchedAtMs: 1_000_000,
      };
    });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      nowSpy.mockReturnValue(1_000_000 + (attempt - 1) * 31 * 60 * 1000);
      await service.maybeRunWarStartPointsCheck(context);
    }

    expect(points.fetchSnapshot.mock.calls.length).toBeGreaterThan(0);
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      attempts: 10,
      status: "max_attempts",
      completed: true,
    });
    nowSpy.mockRestore();
  });

  it("creates a fresh retry job when the war identity context changes", async () => {
    const { service, settings } = buildService();
    const nextContext: WarStartPointsCheckContext = {
      guildId: "guild-1",
      clanTag: "#AAA111",
      warId: 1002,
      warStartTime: new Date("2026-03-14T00:00:00.000Z"),
      opponentTag: "#NEW999",
    };
    vi.spyOn(prisma.currentWar, "findFirst").mockResolvedValue(
      exactCurrentWarRow({
        warId: 1002,
        startTime: new Date("2026-03-14T00:00:00.000Z"),
        opponentTag: "#NEW999",
        fwaPoints: 1250,
      }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    settings.store.set(
      "warStartPointsCheck:AAA111",
      JSON.stringify({
        clanTag: "#AAA111",
        opponentTag: "#0PP123",
        warId: "1001",
        warStartTime: "2026-03-12T00:00:00.000Z",
        attempts: 9,
        maxAttempts: 10,
        nextAttemptAtMs: 0,
        completed: false,
        status: "pending",
        trackedPointBalanceSite: null,
        trackedPointBalanceDb: null,
        siteSyncNumber: null,
        siteOpponentTag: null,
        siteOpponentBalance: null,
        siteOpponentActiveFwa: null,
        siteOpponentNotFound: null,
        inferredOpponentIsFwa: null,
        opponentChecked: false,
        lastCheckedAtMs: null,
      }),
    );

    await service.maybeRunWarStartPointsCheck(nextContext);

    expect(readLatestJobBlob(settings, nextContext)).toMatchObject({
      attempts: 1,
      warId: "1002",
      warStartTime: "2026-03-14T00:00:00.000Z",
      opponentTag: "#NEW999",
    });
    nowSpy.mockRestore();
  });

  it("keeps a completed retry job from fetching again", async () => {
    const { service, points, settings } = buildService();
    settings.store.set(
      "warStartPointsCheck:AAA111",
      JSON.stringify({
        clanTag: "#AAA111",
        opponentTag: "#0PP123",
        warId: "1001",
        warStartTime: "2026-03-12T00:00:00.000Z",
        attempts: 1,
        maxAttempts: 10,
        nextAttemptAtMs: 0,
        completed: true,
        status: "in_sync",
        trackedPointBalanceSite: 1300,
        trackedPointBalanceDb: 1300,
        siteSyncNumber: 44,
        siteOpponentTag: "#0PP123",
        siteOpponentBalance: 1200,
        siteOpponentActiveFwa: false,
        siteOpponentNotFound: false,
        inferredOpponentIsFwa: false,
        opponentChecked: true,
        lastCheckedAtMs: 1_000_000,
      }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await service.maybeRunWarStartPointsCheck(context);

    expect(points.fetchSnapshot).not.toHaveBeenCalled();
    expect(readLatestJobBlob(settings, context)).toMatchObject({
      completed: true,
      status: "in_sync",
    });
    nowSpy.mockRestore();
  });

  it("skips the points-sync write when the exact current-war tuple changes during fetch", async () => {
    const { service, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findFirst")
      .mockResolvedValueOnce(exactCurrentWarRow())
      .mockResolvedValueOnce(null);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).not.toHaveBeenCalled();
    expect(nowSpy).toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
