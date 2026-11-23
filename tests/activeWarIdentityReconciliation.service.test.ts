import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  currentWar: { upsert: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import {
  reconcileActiveWarIdentity,
  resolveActiveWarIdentityPatch,
} from "../src/services/ActiveWarIdentityReconciliationService";

const liveWar = {
  state: "inWar",
  startTime: "20260909T180000.000Z",
  preparationStartTime: "20260908T180000.000Z",
  endTime: "20260910T180000.000Z",
  warId: 5001,
  clan: { name: "Alpha" },
  opponent: { name: "Opponent", tag: "#OPP1" },
};

describe("reconcileActiveWarIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.currentWar.upsert.mockResolvedValue(null);
  });

  it("preserves same-war match evidence while converging stale identity", async () => {
    await reconcileActiveWarIdentity({
      guildId: "guild-1",
      clanTag: "#ALPHA",
      liveWar,
      currentWar: {
        state: "notInWar",
        startTime: new Date("2026-09-09T18:00:00.000Z"),
        warId: 5001,
        opponentTag: "#OPP1",
        matchType: "FWA",
        inferredMatchType: true,
        outcome: "WIN",
        fwaPoints: 1200,
        opponentFwaPoints: 980,
        warStartFwaPoints: 1200,
      },
    });

    const call = prismaMock.currentWar.upsert.mock.calls[0]?.[0];
    expect(call.update).toMatchObject({
      state: "inWar",
      opponentTag: "OPP1",
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
    });
    expect(call.update).not.toHaveProperty("fwaPoints");
    expect(call.update).not.toHaveProperty("opponentFwaPoints");
    expect(call.update).not.toHaveProperty("warStartFwaPoints");
  });

  it("clears prior match evidence for a genuinely new war", async () => {
    const result = await reconcileActiveWarIdentity({
      guildId: "guild-1",
      clanTag: "#ALPHA",
      liveWar,
      currentWar: {
        state: "notInWar",
        startTime: new Date("2026-09-08T18:00:00.000Z"),
        warId: 5000,
        opponentTag: "#OLDOPP",
        matchType: "FWA",
        inferredMatchType: false,
        outcome: "LOSE",
        fwaPoints: 1200,
        opponentFwaPoints: 980,
        warStartFwaPoints: 1200,
      },
    });

    const call = prismaMock.currentWar.upsert.mock.calls[0]?.[0];
    expect(call.update).toMatchObject({
      state: "inWar",
      opponentTag: "OPP1",
      matchType: null,
      inferredMatchType: true,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      warStartFwaPoints: null,
    });
    expect(result.identity?.sameWar).toBe(false);
    expect(result.currentWar?.matchType).toBeNull();
    expect(result.currentWar?.outcome).toBeNull();
  });

  it("does not return an in-memory CurrentWar projection when persistence fails", async () => {
    const error = new Error("database unavailable");
    prismaMock.currentWar.upsert.mockRejectedValue(error);

    await expect(
      reconcileActiveWarIdentity({
        guildId: "guild-1",
        clanTag: "#ALPHA",
        liveWar,
        currentWar: {
          state: "notInWar",
          startTime: new Date("2026-09-08T18:00:00.000Z"),
          warId: 5000,
          opponentTag: "#OLDOPP",
        },
      }),
    ).rejects.toThrow("database unavailable");
  });
});

describe("resolveActiveWarIdentityPatch end-time authority", () => {
  it("prefers a valid live end time over an older persisted same-war end time", () => {
    const result = resolveActiveWarIdentityPatch({
      guildId: "guild-1",
      clanTag: "#ALPHA",
      liveWar,
      currentWar: {
        warId: 5001,
        startTime: new Date("2026-09-09T18:00:00.000Z"),
        opponentTag: "#OPP1",
        endTime: new Date("2026-09-09T23:00:00.000Z"),
      },
    });

    expect(result?.sameWar).toBe(true);
    expect(result?.patch.endTime).toEqual(new Date("2026-09-10T18:00:00.000Z"));
  });

  it("preserves a valid persisted end time when live end time is missing for the same war", () => {
    const result = resolveActiveWarIdentityPatch({
      guildId: "guild-1",
      clanTag: "#ALPHA",
      liveWar: { ...liveWar, endTime: null },
      currentWar: {
        warId: 5001,
        startTime: new Date("2026-09-09T18:00:00.000Z"),
        opponentTag: "#OPP1",
        endTime: new Date("2026-09-10T18:00:00.000Z"),
      },
    });

    expect(result?.sameWar).toBe(true);
    expect(result?.patch.endTime).toEqual(new Date("2026-09-10T18:00:00.000Z"));
  });

  it.each([
    {
      name: "different opponent",
      currentWar: {
        warId: 5001,
        startTime: new Date("2026-09-09T18:00:00.000Z"),
        opponentTag: "#OLDOPP",
        endTime: new Date("2026-09-10T18:00:00.000Z"),
      },
    },
    {
      name: "different war start time",
      currentWar: {
        warId: 5001,
        startTime: new Date("2026-09-08T18:00:00.000Z"),
        opponentTag: "#OPP1",
        endTime: new Date("2026-09-10T18:00:00.000Z"),
      },
    },
  ])("clears a persisted end time for a new war: $name", ({ currentWar }) => {
    const result = resolveActiveWarIdentityPatch({
      guildId: "guild-1",
      clanTag: "#ALPHA",
      liveWar: { ...liveWar, endTime: null },
      currentWar,
    });

    expect(result?.sameWar).toBe(false);
    expect(result?.patch.endTime).toBeNull();
  });
});
