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
      warPlanComplianceEvaluation: {
        upsert: vi.fn(async () => {
          order.push("evaluation_enroll");
          return {};
        }),
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
    prismaMock.$executeRaw.mockImplementation(async () => {
      order.push("war_lookup_write");
      return 1;
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
      "transaction_begin",
      "history_upsert",
      "evaluation_enroll",
      "transaction_end",
      "war_attacks_update",
      "current_war_update",
      "attach_war_id",
      "get_current_sync",
      "war_lookup_write",
      "participation_snapshot",
      "finalize_evaluation",
      "war_attacks_delete",
      "current_war_delete",
    ]);
  });

  it("does not continue post-transaction writes when enrollment fails after history persistence", async () => {
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
      $queryRaw: vi.fn(async () => {
        order.push("history_upsert");
        return [{ warId: 99 }];
      }),
      warPlanComplianceEvaluation: {
        upsert: vi.fn(async () => {
          order.push("evaluation_enroll");
          throw new Error("enrollment failed");
        }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      order.push("transaction_begin");
      await expect(fn(tx as any)).rejects.toThrow("enrollment failed");
      order.push("transaction_failed");
      throw new Error("enrollment failed");
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
    ).rejects.toThrow("enrollment failed");

    expect(order).toEqual([
      "transaction_begin",
      "history_upsert",
      "evaluation_enroll",
      "transaction_failed",
    ]);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    expect(warPlanViolations.finalizeEvaluation).not.toHaveBeenCalled();
    expect(prismaMock.warAttacks.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.updateMany).not.toHaveBeenCalled();
  });
});
