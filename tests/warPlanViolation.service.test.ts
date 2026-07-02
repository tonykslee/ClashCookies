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

function applyEvaluationUpdate(
  row: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (key === "attemptCount" && value && typeof value === "object") {
      const increment = Number((value as { increment?: unknown }).increment ?? 0);
      const current = Number(next.attemptCount ?? 0);
      next.attemptCount = Math.trunc(current + increment);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function installEvaluationStateMock(
  initialRow = buildEvaluationRow(),
  options?: { enforceClaimLease?: boolean },
) {
  const state = {
    row: initialRow as Record<string, unknown>,
  };
  const updateManySpy = vi
    .spyOn(prisma.warPlanComplianceEvaluation, "updateMany")
    .mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (options?.enforceClaimLease) {
        const where = args as unknown as {
          where?: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        const claimToken = String((where.where?.claimToken as string | undefined) ?? "");
        const wantsClaim = Boolean(where.data.claimToken);
        if (wantsClaim) {
          const currentStatus = String(state.row.status ?? "");
          const allowedStatuses = Array.isArray(where.where?.status?.in)
            ? (where.where?.status?.in as string[])
            : null;
          if (allowedStatuses && !allowedStatuses.includes(currentStatus)) {
            return { count: 0 } as any;
          }
          const now = new Date();
          const currentClaimExpiresAt = state.row.claimExpiresAt as Date | null | undefined;
          const currentClaimToken = String(state.row.claimToken ?? "");
          if (
            currentClaimToken &&
            currentClaimToken.length > 0 &&
            currentClaimExpiresAt instanceof Date &&
            currentClaimExpiresAt.getTime() > now.getTime()
          ) {
            return { count: 0 } as any;
          }
        } else if (claimToken) {
          if (String(state.row.claimToken ?? "") !== claimToken) {
            return { count: 0 } as any;
          }
        }
      }
      state.row = applyEvaluationUpdate(state.row, args.data);
      return { count: 1 } as any;
    });
  const findUniqueSpy = vi
    .spyOn(prisma.warPlanComplianceEvaluation, "findUnique")
    .mockImplementation(async () =>
      ({
        ...state.row,
      }) as any,
    );

  return { state, updateManySpy, findUniqueSpy };
}

function installTransactionMock(state: { row: Record<string, unknown> }) {
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
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.row = applyEvaluationUpdate(state.row, args.data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({
        ...state.row,
        violations: [...createdViolations],
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

function installArchiveTxMock(initialRow: Record<string, unknown> | null) {
  const state = {
    row: initialRow as Record<string, unknown> | null,
  };
  const tx = {
    warPlanComplianceEvaluation: {
      findUnique: vi.fn(async () =>
        state.row
          ? {
              ...state.row,
              warHistory: state.row.warHistory,
              violations: Array.isArray(state.row.violations)
                ? [...(state.row.violations as Array<Record<string, unknown>>)]
                : [],
            }
          : null,
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.row = {
          id: "archive-eval",
          guildId: args.data.guildId,
          warId: args.data.warId,
          status: args.data.status,
          attemptCount: 0,
          lastAttemptAt: null,
          nextAttemptAt: null,
          completedAt: null,
          claimToken: null,
          claimExpiresAt: null,
          failureCode: null,
          failureMessage: null,
          matchType: null,
          expectedOutcome: null,
          warHistory: state.row?.warHistory ?? null,
          violations: [],
        };
        return { ...state.row };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (!state.row) throw new Error("missing archive row");
        state.row = applyEvaluationUpdate(state.row, args.data);
        return { ...state.row };
      }),
    },
    warPlanViolation: {
      deleteMany: vi.fn(async () => {
        const count = Array.isArray(state.row?.violations)
          ? (state.row?.violations.length ?? 0)
          : 0;
        if (state.row) {
          state.row.violations = [];
        }
        return { count };
      }),
    },
    clanWarHistory: {
      findUnique: vi.fn(async () =>
        state.row?.warHistory
          ? {
              warId: state.row.warId,
              matchType: (state.row.warHistory as any).matchType,
              expectedOutcome: (state.row.warHistory as any).expectedOutcome,
            }
          : null,
      ),
    },
  };

  return { state, tx };
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
    const { state, updateManySpy } = installEvaluationStateMock();
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaClanMemberCurrent, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.fwaPlayerCatalog, "findMany").mockResolvedValue([]);
    vi.spyOn(prisma.playerCurrent, "findMany").mockResolvedValue([]);
    const { tx, createdViolations } = installTransactionMock(state);

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(result?.violationCount).toBe(0);
    expect(createdViolations).toHaveLength(0);
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "eval-1",
        }),
      }),
    );
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      status: "COMPLETED",
      engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
      nextAttemptAt: null,
      failureCode: null,
      failureMessage: null,
      attemptCount: 1,
    });
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);

    state.row = buildEvaluationRow({
      status: "COMPLETED",
      engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
      matchType: "FWA",
      expectedOutcome: "WIN",
      completedAt: new Date("2026-03-30T01:05:00.000Z"),
      violations: [],
    });
    const idempotent = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(idempotent?.status).toBe("COMPLETED");
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not recompute completed history when only configuration fields change", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const { state, updateManySpy } = installEvaluationStateMock(
      buildEvaluationRow({
        status: "COMPLETED",
        engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
        matchType: "FWA",
        expectedOutcome: "WIN",
        rulesFingerprint: "old-fingerprint",
        nonMirrorTripleMinClanStars: 77,
        allBasesOpenHoursLeft: 6,
        completedAt: new Date("2026-03-30T01:05:00.000Z"),
        violations: [],
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
      }),
    );
    const { tx } = installTransactionMock(state);

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(compliance.evaluateComplianceForCommand).not.toHaveBeenCalled();
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(tx.warPlanComplianceEvaluation.updateMany).not.toHaveBeenCalled();
  });

  it("re-finalizes the same evaluation id when the canonical expectedOutcome changes", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => ({
        status: "ok",
        report: {
          ...buildZeroViolationReport(),
          expectedOutcome: "LOSE" as const,
        },
      })),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const { state, updateManySpy } = installEvaluationStateMock(
      buildEvaluationRow({
        status: "COMPLETED",
        engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
        matchType: "FWA",
        expectedOutcome: "WIN",
        attemptCount: 1,
        rulesFingerprint: "old-fingerprint",
        completedAt: new Date("2026-03-30T01:05:00.000Z"),
        violations: [],
        warHistory: {
          warId: 1,
          clanTag: "#AAA111",
          clanName: "Alpha",
          opponentName: "Beta",
          matchType: "FWA",
          expectedOutcome: "LOSE",
          actualOutcome: "WIN",
          warStartTime: new Date("2026-03-30T00:00:00.000Z"),
          warEndTime: new Date("2026-03-30T01:00:00.000Z"),
        },
      }),
      { enforceClaimLease: true },
    );
    const { tx } = installTransactionMock(state);

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      id: "eval-1",
      status: "COMPLETED",
      expectedOutcome: "LOSE",
      attemptCount: 2,
    });
  });

  it("recovers an expired claim before finalizing the evaluation", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => ({
        status: "ok",
        report: buildZeroViolationReport(),
      })),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const { state, updateManySpy } = installEvaluationStateMock(
      buildEvaluationRow({
        status: "FAILED",
        attemptCount: 3,
        claimToken: "stale-token",
        claimExpiresAt: new Date("2026-03-30T00:00:00.000Z"),
        nextAttemptAt: null,
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
      }),
      { enforceClaimLease: true },
    );
    const { tx } = installTransactionMock(state);

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
    expect(updateManySpy).toHaveBeenCalledTimes(1);
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      status: "COMPLETED",
      claimToken: null,
      attemptCount: 4,
    });
  });

  it("lets only one concurrent finalize attempt claim the evaluation", async () => {
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => {
        await gate;
        return {
          status: "ok",
          report: buildViolationReport(),
        };
      }),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const { state, updateManySpy } = installEvaluationStateMock(
      buildEvaluationRow({
        status: "PENDING",
        attemptCount: 0,
        nextAttemptAt: null,
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
      }),
      { enforceClaimLease: true },
    );
    vi.spyOn(prisma.clanWarParticipation, "findMany").mockResolvedValue([
      { playerTag: "#P1", townHall: 16 },
    ] as any);
    vi.spyOn(prisma.fwaClanMemberCurrent, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.fwaPlayerCatalog, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.playerCurrent, "findMany").mockResolvedValue([] as any);
    const { tx } = installTransactionMock(state);

    const firstAttempt = service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });
    await Promise.resolve();
    const secondAttempt = service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    releaseGate?.();
    const [firstResult, secondResult] = await Promise.all([firstAttempt, secondAttempt]);

    expect([firstResult, secondResult].filter(Boolean)).toHaveLength(1);
    expect(compliance.evaluateComplianceForCommand).toHaveBeenCalledTimes(1);
    expect(tx.warPlanViolation.createMany).toHaveBeenCalledTimes(1);
    expect(updateManySpy).toHaveBeenCalledTimes(2);
    expect(state.row).toMatchObject({
      status: "COMPLETED",
      attemptCount: 1,
    });
  });

  it("caps reconciliation selection at 20 rows", async () => {
    const service = new WarPlanViolationService({} as any);
    const findManySpy = vi.spyOn(prisma.warPlanComplianceEvaluation, "findMany").mockResolvedValue([]);

    const result = await service.reconcileDueEvaluations({ limit: 999 });

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(findManySpy.mock.calls[0]?.[0]?.take).toBe(20);
    expect(result.requestedLimit).toBe(999);
    expect(result.processedCount).toBe(0);
  });

  it("resets a completed evaluation to pending when archive canonical outcome changes", async () => {
    const service = new WarPlanViolationService({} as any);
    const initialRow = buildEvaluationRow({
      status: "COMPLETED",
      matchType: "FWA",
      expectedOutcome: "WIN",
      completedAt: new Date("2026-03-30T01:05:00.000Z"),
      violations: [
        {
          id: "v1",
        },
      ],
      warHistory: {
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        opponentName: "Beta",
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "WIN",
        warStartTime: new Date("2026-03-30T00:00:00.000Z"),
        warEndTime: new Date("2026-03-30T01:00:00.000Z"),
      },
    });
    const { state, tx } = installArchiveTxMock(initialRow);

    const result = await service.syncArchivedEvaluationState({
      tx: tx as any,
      guildId: "g1",
      warId: 1,
    });

    expect(result?.action).toBe("reset");
    expect(state.row).toMatchObject({
      status: "PENDING",
      completedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      failureCode: null,
      failureMessage: null,
    });
    expect(tx.warPlanViolation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("terminalizes archive evaluations for non-FWA canonical history", async () => {
    const service = new WarPlanViolationService({} as any);
    const initialRow = buildEvaluationRow({
      status: "PENDING",
      matchType: "FWA",
      expectedOutcome: "WIN",
      violations: [
        {
          id: "v1",
        },
      ],
      warHistory: {
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        opponentName: "Beta",
        matchType: "MM",
        expectedOutcome: null,
        actualOutcome: "WIN",
        warStartTime: new Date("2026-03-30T00:00:00.000Z"),
        warEndTime: new Date("2026-03-30T01:00:00.000Z"),
      },
    });
    const { state, tx } = installArchiveTxMock(initialRow);

    const result = await service.syncArchivedEvaluationState({
      tx: tx as any,
      guildId: "g1",
      warId: 1,
    });

    expect(result?.action).toBe("terminalized");
    expect(state.row).toMatchObject({
      status: "SKIPPED",
      completedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      failureCode: "NON_FWA_HISTORY",
      failureMessage: "Historical war is not an FWA match.",
    });
    expect(tx.warPlanViolation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("reactivates the same evaluation id when archive canonical history returns to FWA", async () => {
    const service = new WarPlanViolationService({} as any);
    const initialRow = buildEvaluationRow({
      status: "SKIPPED",
      matchType: "MM",
      expectedOutcome: null,
      claimToken: null,
      claimExpiresAt: null,
      completedAt: null,
      nextAttemptAt: null,
      failureCode: "NON_FWA_HISTORY",
      failureMessage: "Historical war is not an FWA match.",
      violations: [],
      warHistory: {
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        opponentName: "Beta",
        matchType: "FWA",
        expectedOutcome: "LOSE",
        actualOutcome: "LOSE",
        warStartTime: new Date("2026-03-30T00:00:00.000Z"),
        warEndTime: new Date("2026-03-30T01:00:00.000Z"),
      },
    });
    const { state, tx } = installArchiveTxMock(initialRow);

    const result = await service.syncArchivedEvaluationState({
      tx: tx as any,
      guildId: "g1",
      warId: 1,
    });

    expect(result?.action).toBe("reactivated");
    expect(state.row).toMatchObject({
      status: "PENDING",
      completedAt: null,
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      failureCode: null,
      failureMessage: null,
    });
    expect(tx.warPlanViolation.deleteMany).not.toHaveBeenCalled();
  });

  it("persists one violation per player and retains merged evidence with fallback classification", async () => {
    const compliance = {
      evaluateComplianceForCommand: vi.fn(async () => ({
        status: "ok",
        report: buildViolationReport(),
      })),
    } as any;
    const service = new WarPlanViolationService(compliance);
    const { state, updateManySpy } = installEvaluationStateMock();
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
    const { tx, createdViolations } = installTransactionMock(state);

    const result = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(result?.status).toBe("COMPLETED");
    expect(tx.warPlanViolation.createMany).toHaveBeenCalledTimes(1);
    expect(createdViolations).toHaveLength(4);
    expect(updateManySpy).toHaveBeenCalledTimes(1);

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
    const { state, updateManySpy } = installEvaluationStateMock(evaluationRow);
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
    const { tx } = installTransactionMock(state);

    const failed = await service.finalizeEvaluation({
      guildId: "g1",
      warId: 1,
    });

    expect(failed?.status).toBe("FAILED");
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: evaluationRow.id,
        }),
      }),
    );
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      status: "FAILED",
      attemptCount: 3,
      failureCode: "FAILED",
      nextAttemptAt: expect.any(Date),
    });

    compliance.evaluateComplianceForCommand.mockClear();
    tx.warPlanComplianceEvaluation.updateMany.mockClear();
    tx.warPlanViolation.deleteMany.mockClear();
    tx.warPlanViolation.createMany.mockClear();
    findManySpy.mockResolvedValue([
      {
        guildId: "g1",
        warId: 1,
      },
    ] as any);
    state.row = buildEvaluationRow({
      status: "FAILED",
      attemptCount: 3,
    });
    const retried = await service.reconcileDueEvaluations({ limit: 20 });

    expect(retried.completedCount).toBe(1);
    expect(tx.warPlanComplianceEvaluation.updateMany).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({
      status: "COMPLETED",
      attemptCount: 4,
    });
  });
});
