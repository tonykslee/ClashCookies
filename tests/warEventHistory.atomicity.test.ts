import { afterEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  warAttacks: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  currentWar: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  warPlanComplianceEvaluation: {
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { prisma } from "../src/prisma";
import { WarEventHistoryService } from "../src/services/war-events/history";

describe("WarEventHistoryService.persistWarEndHistory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildService(order: string[]) {
    const pointsSync = {
      attachWarId: vi.fn(async () => {
        order.push("attach_war_id");
      }),
      getCurrentSyncForClan: vi.fn(async () => {
        order.push("get_current_sync");
        return null;
      }),
    } as any;
    const warPlanViolations = {
      syncArchivedEvaluationState: vi.fn(async () => {
        order.push("evaluation_sync");
      }),
      finalizeEvaluation: vi.fn(async () => {
        order.push("finalize_evaluation");
      }),
    } as any;
    const service = new WarEventHistoryService(
      {} as any,
      pointsSync,
      {} as any,
      warPlanViolations,
    );
    vi.spyOn(service as any, "getWarEndResultSnapshot").mockResolvedValue({
      clanStars: 100,
      opponentStars: 99,
      clanDestruction: 70,
      opponentDestruction: 69,
      warEndTime: new Date("2026-03-30T01:00:00.000Z"),
      resultLabel: "WIN",
    });
    vi.spyOn(service as any, "persistWarParticipationSnapshot").mockImplementation(
      async () => {
        order.push("participation_snapshot");
      },
    );
    return { service, pointsSync, warPlanViolations };
  }

  it("keeps history persistence and enrollment inside one transaction before downstream writes", async () => {
    const order: string[] = [];
    const { service } = buildService(order);

    prismaMock.warAttacks.findFirst.mockResolvedValue({
      warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    });
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        playerTag: "#P1",
        playerName: "Alpha",
        playerPosition: 1,
        attackOrder: 0,
        attackerTag: null,
        attackerName: null,
        attackerPosition: null,
        defenderTag: null,
        defenderName: null,
        defenderPosition: null,
        stars: 0,
        trueStars: 0,
        destruction: 0,
        attackSeenAt: new Date("2026-03-30T00:30:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      guildId: "g1",
      inferredMatchType: false,
      matchType: "FWA",
      state: "inWar",
      outcome: "WIN",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      startTime: new Date("2026-03-30T00:00:00.000Z"),
      endTime: new Date("2026-03-30T01:00:00.000Z"),
    });

    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("history_upsert");
        return [{ warId: 99 }];
      }),
      $executeRaw: vi.fn(async () => {
        order.push("war_lookup_write");
        return 1;
      }),
      warPlanComplianceEvaluation: {
        findUnique: vi.fn(async () => null),
      },
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("transaction_begin");
      const result = await fn(tx as any);
      order.push("transaction_end");
      return result;
    });
    prismaMock.warAttacks.updateMany.mockImplementation(async () => {
      order.push("war_attacks_update");
      return { count: 1 };
    });
    prismaMock.currentWar.updateMany.mockImplementation(async () => {
      order.push("current_war_update");
      return { count: 1 };
    });
    prismaMock.warAttacks.deleteMany.mockImplementation(async () => {
      order.push("war_attacks_delete");
      return { count: 1 };
    });
    prismaMock.currentWar.deleteMany.mockImplementation(async () => {
      order.push("current_war_delete");
      return { count: 1 };
    });

    await service.persistWarEndHistory({
      eventType: "war_ended",
      guildId: "g1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      syncNumber: 10,
      notifyRole: null,
      fwaPoints: 100,
      opponentFwaPoints: 99,
      outcome: "WIN",
      matchType: "FWA",
      warStartFwaPoints: 100,
      warEndFwaPoints: 99,
      clanStars: 100,
      opponentStars: 99,
      prepStartTime: new Date("2026-03-29T12:00:00.000Z"),
      warStartTime: null,
    });

    expect(order).toEqual([
      "get_current_sync",
      "transaction_begin",
      "history_upsert",
      "evaluation_sync",
      "war_lookup_write",
      "participation_snapshot",
      "transaction_end",
      "war_attacks_update",
      "current_war_update",
      "attach_war_id",
      "finalize_evaluation",
      "war_attacks_delete",
      "current_war_delete",
    ]);
  });

  it("preserves existing WarLookup payload and participation when re-entered without live attacks", async () => {
    const order: string[] = [];
    const { service, warPlanViolations } = buildService(order);
    const existingPayload = {
      compliance: {
        canonical: {
          participants: [
            {
              playerTag: "#P1",
              playerName: "Alpha",
              playerPosition: 1,
              attacksUsed: 2,
            },
          ],
          attacks: [
            {
              playerTag: "#P1",
              playerName: "Alpha",
              playerPosition: 1,
              defenderPosition: 1,
              stars: 3,
              trueStars: 3,
              attackOrder: 1,
              attackSeenAt: "2026-03-30T00:30:00.000Z",
            },
          ],
        },
      },
    };

    prismaMock.warAttacks.findFirst.mockResolvedValue({
      warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    });
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      guildId: "g1",
      inferredMatchType: false,
      matchType: "FWA",
      state: "notInWar",
      outcome: "WIN",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      startTime: new Date("2026-03-30T00:00:00.000Z"),
      endTime: new Date("2026-03-30T01:00:00.000Z"),
    });

    const tx = {
      $queryRaw: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("history_upsert");
          return [{ warId: 99 }];
        })
        .mockImplementationOnce(async () => {
          order.push("lookup_select");
          return [{ payload: existingPayload }];
        }),
      $executeRaw: vi.fn(async () => {
        order.push("war_lookup_write");
        return 1;
      }),
      warPlanComplianceEvaluation: {
        findUnique: vi.fn(async () => null),
      },
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("transaction_begin");
      const result = await fn(tx as any);
      order.push("transaction_end");
      return result;
    });
    prismaMock.warAttacks.updateMany.mockImplementation(async () => {
      order.push("war_attacks_update");
      return { count: 1 };
    });
    prismaMock.currentWar.updateMany.mockImplementation(async () => {
      order.push("current_war_update");
      return { count: 1 };
    });
    prismaMock.warAttacks.deleteMany.mockImplementation(async () => {
      order.push("war_attacks_delete");
      return { count: 1 };
    });
    prismaMock.currentWar.deleteMany.mockImplementation(async () => {
      order.push("current_war_delete");
      return { count: 1 };
    });

    await service.persistWarEndHistory({
      eventType: "war_ended",
      guildId: "g1",
      clanTag: "#AAA111",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      syncNumber: 10,
      notifyRole: null,
      fwaPoints: 100,
      opponentFwaPoints: 99,
      outcome: "WIN",
      matchType: "FWA",
      warStartFwaPoints: 100,
      warEndFwaPoints: 99,
      clanStars: 100,
      opponentStars: 99,
      prepStartTime: new Date("2026-03-29T12:00:00.000Z"),
      warStartTime: null,
    });

    expect(order).toEqual([
      "get_current_sync",
      "transaction_begin",
      "history_upsert",
      "evaluation_sync",
      "lookup_select",
      "war_lookup_write",
      "transaction_end",
      "war_attacks_update",
      "current_war_update",
      "attach_war_id",
      "finalize_evaluation",
      "war_attacks_delete",
      "current_war_delete",
    ]);
    expect(warPlanViolations.finalizeEvaluation).toHaveBeenCalledTimes(1);
    expect(warPlanViolations.finalizeEvaluation).toHaveBeenCalledWith({
      guildId: "g1",
      warId: 99,
    });
    expect((service as any).persistWarParticipationSnapshot).not.toHaveBeenCalled();
    expect(prismaMock.warAttacks.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.warAttacks.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.updateMany).toHaveBeenCalledTimes(1);
  });

  it("rolls back the archive transaction when re-entered without live attacks or an existing WarLookup", async () => {
    const order: string[] = [];
    const { service, warPlanViolations } = buildService(order);

    prismaMock.warAttacks.findFirst.mockResolvedValue({
      warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    });
    prismaMock.warAttacks.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      guildId: "g1",
      inferredMatchType: false,
      matchType: "FWA",
      state: "inWar",
      outcome: "WIN",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      startTime: new Date("2026-03-30T00:00:00.000Z"),
      endTime: new Date("2026-03-30T01:00:00.000Z"),
    });

    const tx = {
      $queryRaw: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("history_upsert");
          return [{ warId: 99 }];
        })
        .mockImplementationOnce(async () => {
          order.push("lookup_select");
          return [];
        }),
      $executeRaw: vi.fn(async () => {
        order.push("war_lookup_write");
        return 1;
      }),
      warPlanComplianceEvaluation: {
        findUnique: vi.fn(async () => null),
      },
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("transaction_begin");
      await expect(fn(tx as any)).rejects.toThrow("archive input missing live attacks");
      order.push("transaction_failed");
      throw new Error("archive input missing live attacks");
    });

    await expect(
      service.persistWarEndHistory({
        eventType: "war_ended",
        guildId: "g1",
        clanTag: "#AAA111",
        clanName: "Alpha",
        opponentTag: "#OPP",
        opponentName: "Beta",
        syncNumber: 10,
        notifyRole: null,
        fwaPoints: 100,
        opponentFwaPoints: 99,
        outcome: "WIN",
        matchType: "FWA",
        warStartFwaPoints: 100,
        warEndFwaPoints: 99,
        clanStars: 100,
        opponentStars: 99,
        prepStartTime: new Date("2026-03-29T12:00:00.000Z"),
        warStartTime: null,
      }),
    ).rejects.toThrow("archive input missing live attacks");

    expect(order).toEqual([
      "get_current_sync",
      "transaction_begin",
      "history_upsert",
      "evaluation_sync",
      "lookup_select",
      "transaction_failed",
    ]);
    expect(warPlanViolations.finalizeEvaluation).not.toHaveBeenCalled();
    expect((service as any).persistWarParticipationSnapshot).not.toHaveBeenCalled();
    expect(prismaMock.warAttacks.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.warAttacks.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.deleteMany).not.toHaveBeenCalled();
  });

  it("rolls back the archive transaction when participation persistence fails after WarLookup", async () => {
    const order: string[] = [];
    const { service, warPlanViolations } = buildService(order);

    prismaMock.warAttacks.findFirst.mockResolvedValue({
      warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    });
    prismaMock.warAttacks.findMany.mockResolvedValue([
      {
        playerTag: "#P1",
        playerName: "Alpha",
        playerPosition: 1,
        attackOrder: 0,
        attackerTag: null,
        attackerName: null,
        attackerPosition: null,
        defenderTag: null,
        defenderName: null,
        defenderPosition: null,
        stars: 0,
        trueStars: 0,
        destruction: 0,
        attackSeenAt: new Date("2026-03-30T00:30:00.000Z"),
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      guildId: "g1",
      inferredMatchType: false,
      matchType: "FWA",
      state: "inWar",
      outcome: "WIN",
      clanName: "Alpha",
      opponentTag: "#OPP",
      opponentName: "Beta",
      startTime: new Date("2026-03-30T00:00:00.000Z"),
      endTime: new Date("2026-03-30T01:00:00.000Z"),
    });

    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("history_upsert");
        return [{ warId: 99 }];
      }),
      $executeRaw: vi.fn(async () => {
        order.push("war_lookup_write");
        return 1;
      }),
      warPlanComplianceEvaluation: {
        findUnique: vi.fn(async () => null),
      },
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("transaction_begin");
      await expect(fn(tx as any)).rejects.toThrow("participation failed");
      order.push("transaction_failed");
      throw new Error("participation failed");
    });
    prismaMock.warAttacks.updateMany.mockImplementation(async () => {
      order.push("war_attacks_update");
      return { count: 1 };
    });
    prismaMock.currentWar.updateMany.mockImplementation(async () => {
      order.push("current_war_update");
      return { count: 1 };
    });
    prismaMock.currentWar.deleteMany.mockImplementation(async () => {
      order.push("current_war_delete");
      return { count: 1 };
    });
    prismaMock.warAttacks.deleteMany.mockImplementation(async () => {
      order.push("war_attacks_delete");
      return { count: 1 };
    });
    vi.spyOn(service as any, "persistWarParticipationSnapshot").mockImplementation(
      async () => {
        order.push("participation_snapshot");
        throw new Error("participation failed");
      },
    );

    await expect(
      service.persistWarEndHistory({
        eventType: "war_ended",
        guildId: "g1",
        clanTag: "#AAA111",
        clanName: "Alpha",
        opponentTag: "#OPP",
        opponentName: "Beta",
        syncNumber: 10,
        notifyRole: null,
        fwaPoints: 100,
        opponentFwaPoints: 99,
        outcome: "WIN",
        matchType: "FWA",
        warStartFwaPoints: 100,
        warEndFwaPoints: 99,
        clanStars: 100,
        opponentStars: 99,
        prepStartTime: new Date("2026-03-29T12:00:00.000Z"),
        warStartTime: null,
      }),
    ).rejects.toThrow("participation failed");

    expect(order).toEqual([
      "get_current_sync",
      "transaction_begin",
      "history_upsert",
      "evaluation_sync",
      "war_lookup_write",
      "participation_snapshot",
      "transaction_failed",
    ]);
    expect(warPlanViolations.finalizeEvaluation).not.toHaveBeenCalled();
    expect(prismaMock.warAttacks.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });
});
