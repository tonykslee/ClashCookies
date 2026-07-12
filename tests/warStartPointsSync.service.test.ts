import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import {
  WarStartPointsSyncService,
  type WarStartPointsCheckContext,
} from "../src/services/war-events/pointsSync";

vi.mock("../src/prisma", () => ({
  prisma: {
    currentWar: {
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

  it("writes the points sync only when the exact current-war row still matches the retry job", async () => {
    const { service, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValue({
      guildId: "guild-1",
      warId: 1001,
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      state: "inWar",
      matchType: "FWA",
      inferredMatchType: true,
      clanStars: 100,
      opponentStars: 99,
      opponentTag: "#OPP123",
    } as any);

    await service.resetWarStartPointsJob(context);
    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).toHaveBeenCalledTimes(1);
    expect(pointsSync.upsertPointsSync).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#AAA111",
        warId: "1001",
        warStartTime: new Date("2026-03-12T00:00:00.000Z"),
        opponentTag: "#0PP123",
      }),
    );
  });

  it("skips the retry write when the exact current-war tuple has already changed", async () => {
    const { service, pointsSync } = buildService();
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValue({
      guildId: "guild-1",
      warId: 1002,
      startTime: new Date("2026-03-12T00:00:00.000Z"),
      state: "inWar",
      matchType: "FWA",
      inferredMatchType: true,
      clanStars: 100,
      opponentStars: 99,
      opponentTag: "#OPP123",
    } as any);

    await service.resetWarStartPointsJob(context);
    await service.maybeRunWarStartPointsCheck(context);

    expect(pointsSync.upsertPointsSync).not.toHaveBeenCalled();
  });
});
