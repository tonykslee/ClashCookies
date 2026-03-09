import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import { WarComplianceService } from "../src/services/WarComplianceService";
import { WarEventHistoryService } from "../src/services/war-events/history";
import { computeWarComplianceForTest } from "../src/services/war-events/core";

describe("WarComplianceService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps compliance snapshot parity with the shared war-end rule engine", async () => {
    const warStartTime = new Date("2026-02-01T00:00:00.000Z");
    const warEndTime = new Date("2026-02-02T00:00:00.000Z");
    const participants = [
      { playerName: "Alice", playerTag: "#A", attacksUsed: 2, playerPosition: 1 },
      { playerName: "Bob", playerTag: "#B", attacksUsed: 2, playerPosition: 2 },
      { playerName: "Cory", playerTag: "#C", attacksUsed: 0, playerPosition: 3 },
    ];
    const attacks = [
      {
        playerTag: "#A",
        playerName: "Alice",
        playerPosition: 1,
        defenderPosition: 2,
        stars: 3,
        trueStars: 3,
        attackSeenAt: new Date("2026-02-01T02:00:00.000Z"),
        warEndTime,
        attackOrder: 1,
      },
      {
        playerTag: "#B",
        playerName: "Bob",
        playerPosition: 2,
        defenderPosition: 2,
        stars: 2,
        trueStars: 2,
        attackSeenAt: new Date("2026-02-01T03:00:00.000Z"),
        warEndTime,
        attackOrder: 2,
      },
    ];

    vi.spyOn(prisma.warAttacks, "findFirst").mockResolvedValue({
      warStartTime,
      warEndTime,
      warId: 777,
    } as any);
    vi.spyOn(prisma.warAttacks, "findMany")
      .mockResolvedValueOnce(participants as any)
      .mockResolvedValueOnce(attacks as any);
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValue({
      loseStyle: "TRADITIONAL",
    } as any);

    const service = new WarComplianceService();
    const snapshot = await service.getComplianceSnapshot({
      clanTag: "#TEST",
      preferredWarStartTime: warStartTime,
      matchType: "FWA",
      expectedOutcome: "WIN",
    });

    const expected = computeWarComplianceForTest({
      clanTag: "#TEST",
      participants: participants as any,
      attacks: attacks as any,
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
    });
    expect(snapshot).toEqual(expected);
  });

  it("returns null report for BL/MM checks without hitting DB", async () => {
    const findFirstSpy = vi.spyOn(prisma.warAttacks, "findFirst");
    const service = new WarComplianceService();

    const report = await service.getComplianceReport({
      clanTag: "#TEST",
      matchType: "BL",
      expectedOutcome: null,
    });

    expect(report).toBeNull();
    expect(findFirstSpy).not.toHaveBeenCalled();
  });
});

describe("WarEventHistoryService.getWarComplianceSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates compliance evaluation to WarComplianceService", async () => {
    const delegated = { missedBoth: ["Alice"], notFollowingPlan: ["Bob"] };
    const serviceSpy = vi
      .spyOn(WarComplianceService.prototype, "getComplianceSnapshot")
      .mockResolvedValue(delegated);
    const history = new WarEventHistoryService({} as any);
    const warStart = new Date("2026-02-01T00:00:00.000Z");

    const result = await history.getWarComplianceSnapshot("#TEST", warStart, "FWA", "LOSE");

    expect(result).toEqual(delegated);
    expect(serviceSpy).toHaveBeenCalledWith({
      clanTag: "#TEST",
      preferredWarStartTime: warStart,
      matchType: "FWA",
      expectedOutcome: "LOSE",
    });
  });
});

