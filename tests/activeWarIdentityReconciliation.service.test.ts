import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  currentWar: { upsert: vi.fn() },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import { reconcileActiveWarIdentity } from "../src/services/ActiveWarIdentityReconciliationService";

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
      },
    });

    const call = prismaMock.currentWar.upsert.mock.calls[0]?.[0];
    expect(call.update).toMatchObject({
      state: "inWar",
      opponentTag: "OPP1",
      matchType: null,
      inferredMatchType: true,
      outcome: null,
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
