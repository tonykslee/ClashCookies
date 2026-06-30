import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/prisma";
import {
  WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
  WarPlanViolationService,
} from "../src/services/WarPlanViolationService";

function buildZeroViolationReport() {
  return {
    clanTag: "#AAA111",
    clanName: "Alpha",
    opponentName: "Beta",
    warId: 1,
    warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    warEndTime: new Date("2026-03-30T01:00:00.000Z"),
    matchType: "FWA" as const,
    expectedOutcome: "WIN" as const,
    loseStyle: "TRIPLE_TOP_30" as const,
    missedBoth: [
      {
        playerTag: "#P9",
        playerName: "Missed Both",
        playerPosition: 9,
        ruleType: "missed_both" as const,
        expectedBehavior: "Use both attacks for the war.",
        actualBehavior: "No attacks used.",
      },
    ],
    notFollowingPlan: [],
    participantsCount: 10,
    attacksCount: 20,
    fwaWinGateConfig: {
      nonMirrorTripleMinClanStars: 101,
      allBasesOpenHoursLeft: 12,
    },
  };
}

function buildViolationReport() {
  return {
    clanTag: "#AAA111",
    clanName: "Alpha",
    opponentName: "Beta",
    warId: 1,
    warStartTime: new Date("2026-03-30T00:00:00.000Z"),
    warEndTime: new Date("2026-03-30T01:00:00.000Z"),
    matchType: "FWA" as const,
    expectedOutcome: "WIN" as const,
    loseStyle: "TRIPLE_TOP_30" as const,
    missedBoth: [],
    notFollowingPlan: [
      {
        playerTag: "#P1",
        playerName: "Alpha One",
        playerPosition: 1,
        ruleType: "not_following_plan" as const,
        expectedBehavior: "Mirror triple in strict window.",
        actualBehavior: "#14 (3-star) : tripled non-mirror in strict window",
        reasonLabel: null,
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 3,
            attackOrder: 1,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 10,
          timeRemaining: "6h 0m left",
        },
      },
      {
        playerTag: "#P1",
        playerName: "Alpha One",
        playerPosition: 1,
        ruleType: "not_following_plan" as const,
        expectedBehavior: "Mirror triple in strict window.",
        actualBehavior: "#8 (2-star) : another breach",
        reasonLabel: "generic mismatch",
        attackDetails: [
          {
            defenderPosition: 8,
            stars: 2,
            attackOrder: 2,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 12,
          timeRemaining: "5h 30m left",
        },
      },
      {
        playerTag: "#P2",
        playerName: "Beta Two",
        playerPosition: 2,
        ruleType: "not_following_plan" as const,
        expectedBehavior: "Follow the plan.",
        actualBehavior: "#2 (1-star) : unknown mismatch",
        reasonLabel: "mystery mismatch",
        attackDetails: [
          {
            defenderPosition: 2,
            stars: 1,
            attackOrder: 4,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        playerTag: "#P3",
        playerName: "Gamma Three",
        playerPosition: 3,
        ruleType: "not_following_plan" as const,
        expectedBehavior: "Use the late mirror.",
        actualBehavior: "#3 (2-star) : late breach",
        reasonLabel: "late mirror breach",
        attackDetails: [
          {
            defenderPosition: 3,
            stars: 2,
            attackOrder: 8,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        playerTag: "#P4",
        playerName: "Delta Four",
        playerPosition: 4,
        ruleType: "not_following_plan" as const,
        expectedBehavior: "Use the fallback mirror.",
        actualBehavior: "#4 (1-star) : late fallback",
        reasonLabel: "late fallback breach",
        attackDetails: [
          {
            defenderPosition: 4,
            stars: 1,
            attackOrder: 10,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
    ],
    participantsCount: 10,
    attacksCount: 20,
    fwaWinGateConfig: {
      nonMirrorTripleMinClanStars: 101,
      allBasesOpenHoursLeft: 12,
    },
  };
}

function buildEvaluationRow(params?: Partial<Record<string, unknown>>) {
  return {
    id: "eval-1",
    guildId: "g1",
    warId: 1,
    status: "PENDING",
    engineVersion: null,
    matchType: null,
    expectedOutcome: null,
    loseStyle: null,
    nonMirrorTripleMinClanStars: null,
    allBasesOpenHoursLeft: null,
    rulesFingerprint: null,
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    completedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date("2026-03-30T01:00:00.000Z"),
    updatedAt: new Date("2026-03-30T01:00:00.000Z"),
    warHistory: {
      warId: 1,
      clanTag: "#AAA111",
      clanName: "Alpha",
      opponentName: "Beta",
      matchType: "FWA",
      expectedOutcome: "WIN",
      actualOutcome: "WIN",
      warStartTime: new Date("2026-03-30T00:00:00.000Z"),
      warEndTime: new Date("2026-03-30T01:00:00.000Z"),
    },
    violations: [],
    ...params,
  } as any;
}

function installTransactionMock() {
  const createdViolations: Array<Record<string, unknown>> = [];
  const tx = {
    warPlanViolation: {
      deleteMany: vi.fn(async () => {
        const count = createdViolations.length;
        createdViolations.length = 0;
        return { count };
      }),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        createdViolations.push(...args.data.map((row) => ({ ...row })));
        return { count: args.data.length };
      }),
    },
    warPlanComplianceEvaluation: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...buildEvaluationRow({
          status: args.data.status ?? "COMPLETED",
          engineVersion: args.data.engineVersion ?? WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
          matchType: args.data.matchType ?? "FWA",
          expectedOutcome: args.data.expectedOutcome ?? "WIN",
          loseStyle: args.data.loseStyle ?? "TRIPLE_TOP_30",
          nonMirrorTripleMinClanStars:
            args.data.nonMirrorTripleMinClanStars ?? null,
          allBasesOpenHoursLeft: args.data.allBasesOpenHoursLeft ?? null,
          rulesFingerprint: args.data.rulesFingerprint ?? null,
          attemptCount: args.data.attemptCount ?? 0,
          lastAttemptAt: args.data.lastAttemptAt ?? null,
          nextAttemptAt: args.data.nextAttemptAt ?? null,
          completedAt: args.data.completedAt ?? null,
          failureCode: args.data.failureCode ?? null,
          failureMessage: args.data.failureMessage ?? null,
          violations: [...createdViolations],
        }),
      })),
    },
  };

  const transactionSpy = vi
    .spyOn(prisma, "$transaction")
    .mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx as any),
    );

  return { tx, createdViolations, transactionSpy };
}

describe("WarPlanViolationService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates pending enrollment only for canonical FWA wars", async () => {
    const upsert = vi
      .spyOn(prisma.warPlanComplianceEvaluation, "upsert")
      .mockResolvedValue(buildEvaluationRow({ status: "PENDING" }) as any);
    vi.spyOn(prisma.clanWarHistory, "findUnique").mockResolvedValue(
      { warId: 1, matchType: "FWA" } as any,
    );

    const service = new WarPlanViolationService({} as any);
    const created = await service.ensurePendingEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(created?.status).toBe("PENDING");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          guildId: "g1",
          warId: 1,
          status: "PENDING",
        }),
      }),
    );

    upsert.mockClear();
    vi.spyOn(prisma.clanWarHistory, "findUnique").mockResolvedValue(
      { warId: 1, matchType: "BL" } as any,
    );
    const skipped = await service.ensurePendingEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(skipped).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("finalizes zero violations and stays idempotent once completed", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => ({
        status: "ok",
        report: buildZeroViolationReport(),
      })),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const findUniqueSpy = vi.spyOn(prisma.warPlanComplianceEvaluation, "findUnique").mockResolvedValue(
      buildEvaluationRow() as any,
    );
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaClanMemberCurrent, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaPlayerCatalog, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.playerCurrent, "findMany").mockResolvedValue([]);
    const { tx, createdViolations } = installTransactionMock();

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(result?.violationCount).toBe(0);
    expect(createdViolations).toHaveLength(0);
    expect(tx.warPlanComplianceEvaluation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "COMPLETED",
          engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
          rulesFingerprint: expect.any(String),
          attemptCount: 1,
          nextAttemptAt: null,
          failureCode: null,
          failureMessage: null,
        }),
      }),
    );
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);

    findUniqueSpy.mockResolvedValue(
      buildEvaluationRow({
        status: "COMPLETED",
        engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
        completedAt: new Date("2026-03-30T01:05:00.000Z"),
        violations: [],
      }) as any,
    );
    const idempotent = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(idempotent?.status).toBe("COMPLETED");
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
    expect(tx.warPlanComplianceEvaluation.update).toHaveBeenCalledTimes(1);
  });

  it("persists one violation per player and retains merged evidence with fallback classification", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => ({
        status: "ok",
        report: buildViolationReport(),
      })),
    } as any;
    const service = new WarPlanViolationService(compliance);
    vi.spyOn(prisma.warPlanComplianceEvaluation, "findUnique").mockResolvedValue(
      buildEvaluationRow() as any,
    );
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([
      { playerTag: "#P1", townHall: 16 },
    ] as any);
    vi.spyOn(prisma.fwaClanMemberCurrent, "findMany").mockResolvedValue([
      { playerTag: "#P2", townHall: 15 },
      { playerTag: "#P3", townHall: null },
    ] as any);
    vi.spyOn(prisma.fwaPlayerCatalog, "findMany").mockResolvedValue([
      { playerTag: "#P3", latestTownHall: 14 },
    ] as any);
    vi.spyOn(prisma.playerCurrent, "findMany").mockResolvedValue([
      { playerTag: "#P4", townHall: 13 },
    ] as any);
    const { tx, createdViolations } = installTransactionMock();

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(tx.warPlanViolation.createMany).toHaveBeenCalledTimes(1);
    expect(createdViolations).toHaveLength(4);

    const p1 = createdViolations.find((row) => row.playerTag === "#P1");
    const p2 = createdViolations.find((row) => row.playerTag === "#P2");
    const p3 = createdViolations.find((row) => row.playerTag === "#P3");
    const p4 = createdViolations.find((row) => row.playerTag === "#P4");

    expect(p1).toMatchObject({
      townHallLevelSnapshot: 16,
      violationType: "EARLY_NON_MIRROR_TRIPLE",
      breachStarsAt: 10,
    });
    expect((p1?.attackDetails as any)?.attackDetails).toHaveLength(2);
    expect(p2).toMatchObject({
      townHallLevelSnapshot: 15,
      violationType: "OTHER_PLAN_VIOLATION",
    });
    expect(p3).toMatchObject({
      townHallLevelSnapshot: 14,
      violationType: "OTHER_PLAN_VIOLATION",
    });
    expect(p4).toMatchObject({
      townHallLevelSnapshot: 13,
      violationType: "OTHER_PLAN_VIOLATION",
    });
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
  });

  it("marks unexpected failures retryable and reconciles them on the next poll", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error("compliance exploded"))
        .mockResolvedValueOnce({
          status: "ok",
          report: buildZeroViolationReport(),
        }),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const evaluationRow = buildEvaluationRow({
      status: "FAILED",
      attemptCount: 2,
      nextAttemptAt: new Date("2026-03-30T00:30:00.000Z"),
    });
    const findUniqueSpy = vi.spyOn(prisma.warPlanComplianceEvaluation, "findUnique").mockResolvedValue(
      evaluationRow as any,
    );
    const findManySpy = vi.spyOn(prisma.warPlanComplianceEvaluation, "findMany").mockResolvedValue([
      {
        guildId: "g1",
        warId: 1,
      },
    ] as any);
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaClanMemberCurrent, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaPlayerCatalog, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.playerCurrent, "findMany").mockResolvedValue([]);
    const updateSpy = vi
      .spyOn(prisma.warPlanComplianceEvaluation, "update")
      .mockResolvedValue(
        buildEvaluationRow({
          status: "FAILED",
          attemptCount: 3,
        }) as any,
      );
    const { tx } = installTransactionMock();

    const failed = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(failed?.status).toBe("FAILED");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          attemptCount: 3,
          failureCode: "FAILED",
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );

    compliance.evaluateComplianceForCommand.mockClear();
    updateSpy.mockClear();
    tx.warPlanComplianceEvaluation.update.mockClear();
    tx.warPlanViolation.deleteMany.mockClear();
    tx.warPlanViolation.createMany.mockClear();
    findManySpy.mockResolvedValue([
      {
        guildId: "g1",
        warId: 1,
      },
    ] as any);
    findUniqueSpy.mockResolvedValue(
      buildEvaluationRow({
        status: "FAILED",
        attemptCount: 3,
      }) as any,
    );
    const retried = await service.reconcileDueEvaluations({ limit: 20 });

    expect(retried.completedCount).toBe(1);
    expect(tx.warPlanComplianceEvaluation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "COMPLETED",
          attemptCount: 4,
        }),
      }),
    );
  });
});
