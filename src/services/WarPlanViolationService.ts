import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";
import {
  classifyFwaPoliceViolation,
  normalizeFwaPoliceText,
  type FwaPoliceApplicabilityContext,
  type FwaPoliceViolation,
} from "./FwaPoliceTemplateCatalog";
import {
  type WarComplianceIssue,
  type WarComplianceReport,
  type WarComplianceService,
  WarComplianceService as WarComplianceServiceClass,
} from "./WarComplianceService";
import { normalizeTag } from "./war-events/core";

export const WAR_PLAN_COMPLIANCE_ENGINE_VERSION = "war-plan-compliance-v1";
const MAX_RECONCILE_LIMIT = 20;
const RETRY_BASE_DELAY_MS = 15 * 60 * 1000;
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

type EvaluationStatus =
  | "COMPLETED"
  | "INSUFFICIENT_DATA"
  | "FAILED"
  | "SKIPPED";

export type WarPlanViolationFinalizeResult = {
  status: EvaluationStatus;
  guildId: string;
  warId: number;
  violationCount: number;
  attemptCount: number;
  durationMs: number;
  failureCode: string | null;
  failureMessage: string | null;
  completedAt: Date | null;
};

export type WarPlanViolationReconcileResult = {
  requestedLimit: number;
  processedCount: number;
  completedCount: number;
  insufficientDataCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
};

type WarPlanEvaluationRow = Awaited<
  ReturnType<typeof prisma.warPlanComplianceEvaluation.findUnique>
>;

type EvaluatedViolationRow = Awaited<
  ReturnType<typeof prisma.warPlanViolation.findMany>
>[number];

type ViolationIssueBundle = {
  issue: WarComplianceIssue;
  violationType: FwaPoliceViolation | "OTHER_PLAN_VIOLATION";
};

function clampRetryDelayMs(attemptCount: number): number {
  const safeAttemptCount = Math.max(1, Math.trunc(Number(attemptCount) || 1));
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * safeAttemptCount);
}

function buildRulesFingerprint(input: {
  engineVersion: string;
  matchType: string | null;
  expectedOutcome: string | null;
  loseStyle: string | null;
  nonMirrorTripleMinClanStars: number | null;
  allBasesOpenHoursLeft: number | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function normalizeViolationIssues(
  issues: WarComplianceIssue[],
  context: FwaPoliceApplicabilityContext,
): ViolationIssueBundle[] {
  const byPlayerTag = new Map<string, WarComplianceIssue>();
  for (const issue of issues) {
    const playerTag = normalizeTag(issue.playerTag);
    if (!playerTag) continue;
    const existing = byPlayerTag.get(playerTag);
    if (!existing) {
      byPlayerTag.set(playerTag, {
        ...issue,
        attackDetails: Array.isArray(issue.attackDetails)
          ? [...issue.attackDetails]
          : issue.attackDetails,
      });
      continue;
    }

    const mergedAttackDetails = [
      ...(existing.attackDetails ?? []),
      ...(issue.attackDetails ?? []),
    ];
    byPlayerTag.set(playerTag, {
      ...existing,
      reasonLabel: existing.reasonLabel ?? issue.reasonLabel ?? null,
      expectedBehavior:
        existing.expectedBehavior?.trim() ||
        issue.expectedBehavior?.trim() ||
        "Follow the war plan.",
      actualBehavior:
        existing.actualBehavior?.trim() ||
        issue.actualBehavior?.trim() ||
        "Plan violation detected.",
      attackDetails: mergedAttackDetails,
      breachContext: existing.breachContext ?? issue.breachContext ?? null,
    });
  }

  return [...byPlayerTag.values()]
    .sort((a, b) => {
      const posA =
        Number.isFinite(Number(a.playerPosition)) && Number(a.playerPosition) > 0
          ? Number(a.playerPosition)
          : Number.MAX_SAFE_INTEGER;
      const posB =
        Number.isFinite(Number(b.playerPosition)) && Number(b.playerPosition) > 0
          ? Number(b.playerPosition)
          : Number.MAX_SAFE_INTEGER;
      if (posA !== posB) return posA - posB;
      return normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
    })
    .map((issue) => ({
      issue,
      violationType:
        classifyFwaPoliceViolation({ issue, context }) ?? "OTHER_PLAN_VIOLATION",
    }));
}

function buildViolationAttackDetails(issue: WarComplianceIssue): Prisma.InputJsonValue {
  return {
    attackDetails: Array.isArray(issue.attackDetails) ? issue.attackDetails : [],
    breachContext: issue.breachContext ?? null,
  };
}

function resolvePlayerNameSnapshot(issue: WarComplianceIssue): string {
  return String(issue.playerName ?? "").trim() || normalizeTag(issue.playerTag);
}

function resolvePlayerPositionSnapshot(issue: WarComplianceIssue): number | null {
  return Number.isFinite(Number(issue.playerPosition))
    ? Math.trunc(Number(issue.playerPosition))
    : null;
}

function resolveBreachStarsAt(issue: WarComplianceIssue): number | null {
  const breach = issue.breachContext?.starsAtBreach;
  return Number.isFinite(Number(breach)) ? Math.trunc(Number(breach)) : null;
}

function resolveBreachTimeRemaining(issue: WarComplianceIssue): string | null {
  const value = normalizeFwaPoliceText(issue.breachContext?.timeRemaining ?? "");
  return value || null;
}

function resolveTownHallSnapshot(
  row:
    | { townHall: number | null; playerTag: string }
    | null
    | undefined,
): number | null {
  if (!row) return null;
  if (row.townHall === null || row.townHall === undefined) return null;
  return Number.isFinite(Number(row.townHall))
    ? Math.trunc(Number(row.townHall))
    : null;
}

/** Purpose: own durable finalized war-plan compliance history for ended FWA wars. */
export class WarPlanViolationService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly compliance: WarComplianceService = new WarComplianceServiceClass()) {}

  /** Purpose: create an explicit evaluation enrollment for a finalized FWA war. */
  async ensurePendingEvaluation(input: {
    guildId: string;
    warId: number;
  }): Promise<WarPlanEvaluationRow | null> {
    const guildId = String(input.guildId ?? "").trim();
    const warId = Math.trunc(Number(input.warId));
    if (!guildId || !Number.isFinite(warId) || warId <= 0) return null;

    const historyRow = await prisma.clanWarHistory.findUnique({
      where: { warId },
      select: {
        warId: true,
        matchType: true,
      },
    });
    if (!historyRow || historyRow.matchType !== "FWA") {
      return null;
    }

    return prisma.warPlanComplianceEvaluation.upsert({
      where: {
        guildId_warId: {
          guildId,
          warId,
        },
      },
      create: {
        guildId,
        warId,
        status: "PENDING",
      },
      update: {},
      include: {
        warHistory: true,
        violations: true,
      },
    });
  }

  /** Purpose: finalize one pending or retryable evaluation without recomputing completed history. */
  async finalizeEvaluation(input: {
    guildId: string;
    warId: number;
    force?: boolean;
  }): Promise<WarPlanViolationFinalizeResult | null> {
    const startedAt = Date.now();
    const guildId = String(input.guildId ?? "").trim();
    const warId = Math.trunc(Number(input.warId));
    if (!guildId || !Number.isFinite(warId) || warId <= 0) return null;

    const evaluation = await prisma.warPlanComplianceEvaluation.findUnique({
      where: {
        guildId_warId: {
          guildId,
          warId,
        },
      },
      include: {
        warHistory: {
          select: {
            warId: true,
            clanTag: true,
            clanName: true,
            opponentName: true,
            matchType: true,
            expectedOutcome: true,
            actualOutcome: true,
            warStartTime: true,
            warEndTime: true,
          },
        },
        violations: true,
      },
    });
    if (!evaluation) return null;

    if (evaluation.status === "COMPLETED" && !input.force) {
      return {
        status: "COMPLETED",
        guildId,
        warId,
        violationCount: evaluation.violations.length,
        attemptCount: evaluation.attemptCount,
        durationMs: Date.now() - startedAt,
        failureCode: evaluation.failureCode ?? null,
        failureMessage: evaluation.failureMessage ?? null,
        completedAt: evaluation.completedAt ?? null,
      };
    }

    const historyRow = evaluation.warHistory;
    const wasCompleted = evaluation.status === "COMPLETED";
    if (!historyRow || historyRow.matchType !== "FWA") {
      return {
        status: "SKIPPED",
        guildId,
        warId,
        violationCount: evaluation.violations.length,
        attemptCount: evaluation.attemptCount,
        durationMs: Date.now() - startedAt,
        failureCode: null,
        failureMessage: "Historical war is not an FWA match.",
        completedAt: evaluation.completedAt ?? null,
      };
    }

    const attemptCount = evaluation.attemptCount + 1;
    const attemptAt = new Date();

    const persistFailure = async (failure: {
      status: "INSUFFICIENT_DATA" | "FAILED";
      failureCode: string;
      failureMessage: string;
    }): Promise<WarPlanViolationFinalizeResult> => {
      const nextAttemptAt = new Date(
        Date.now() + clampRetryDelayMs(attemptCount),
      );
      try {
        const updated = await prisma.warPlanComplianceEvaluation.update({
          where: {
            guildId_warId: {
              guildId,
              warId,
            },
          },
          data: {
            status: failure.status,
            attemptCount,
            lastAttemptAt: attemptAt,
            nextAttemptAt,
            failureCode: failure.failureCode,
            failureMessage: failure.failureMessage,
          },
          include: {
            violations: true,
          },
        });
        const durationMs = Date.now() - startedAt;
        console.warn(
          [
            "[war-plan-violation] event=evaluation_failed",
            `guild=${guildId}`,
            `war_id=${warId}`,
            `clan_tag=${historyRow.clanTag}`,
            `status=${updated.status}`,
            `violation_count=${updated.violations.length}`,
            `attempt=${updated.attemptCount}`,
            `duration_ms=${durationMs}`,
            `failure_code=${updated.failureCode ?? failure.failureCode}`,
          ].join(" "),
        );
        return {
          status: updated.status as EvaluationStatus,
          guildId,
          warId,
          violationCount: updated.violations.length,
          attemptCount: updated.attemptCount,
          durationMs,
          failureCode: updated.failureCode ?? failure.failureCode,
          failureMessage: updated.failureMessage ?? failure.failureMessage,
          completedAt: updated.completedAt ?? null,
        };
      } catch (error) {
        console.error(
          [
            "[war-plan-violation] event=evaluation_failed_persist",
            `guild=${guildId}`,
            `war_id=${warId}`,
            `clan_tag=${historyRow.clanTag}`,
            `failure_code=${failure.failureCode}`,
            `error=${formatError(error)}`,
          ].join(" "),
        );
        return {
          status: failure.status,
          guildId,
          warId,
          violationCount: evaluation.violations.length,
          attemptCount,
          durationMs: Date.now() - startedAt,
          failureCode: failure.failureCode,
          failureMessage: failure.failureMessage,
          completedAt: evaluation.completedAt ?? null,
        };
      }
    };

    try {
      const evaluationResult = await this.compliance.evaluateComplianceForCommand({
        guildId,
        clanTag: historyRow.clanTag,
        scope: "war_id",
        warId,
      });

      if (evaluationResult.status === "insufficient_data") {
        if (wasCompleted && input.force) {
          console.warn(
            [
              "[war-plan-violation] event=evaluation_force_insufficient_data_preserve_completed",
              `guild=${guildId}`,
              `war_id=${warId}`,
              `clan_tag=${historyRow.clanTag}`,
            ].join(" "),
          );
          return {
            status: "COMPLETED",
            guildId,
            warId,
            violationCount: evaluation.violations.length,
            attemptCount: evaluation.attemptCount,
            durationMs: Date.now() - startedAt,
            failureCode: evaluation.failureCode ?? null,
            failureMessage: evaluation.failureMessage ?? null,
            completedAt: evaluation.completedAt ?? null,
          };
        }
        return persistFailure({
          status: "INSUFFICIENT_DATA",
          failureCode: "INSUFFICIENT_DATA",
          failureMessage: "Compliance evaluation returned insufficient historical data.",
        });
      }

      if (evaluationResult.status !== "ok" || !evaluationResult.report) {
        if (wasCompleted && input.force) {
          console.warn(
            [
              "[war-plan-violation] event=evaluation_force_failed_preserve_completed",
              `guild=${guildId}`,
              `war_id=${warId}`,
              `clan_tag=${historyRow.clanTag}`,
              `status=${evaluationResult.status}`,
            ].join(" "),
          );
          return {
            status: "COMPLETED",
            guildId,
            warId,
            violationCount: evaluation.violations.length,
            attemptCount: evaluation.attemptCount,
            durationMs: Date.now() - startedAt,
            failureCode: evaluation.failureCode ?? null,
            failureMessage: evaluation.failureMessage ?? null,
            completedAt: evaluation.completedAt ?? null,
          };
        }
        return persistFailure({
          status: "FAILED",
          failureCode: evaluationResult.status.toUpperCase(),
          failureMessage: `Compliance evaluation returned ${evaluationResult.status}.`,
        });
      }

      return await this.persistCompletedEvaluation({
        evaluation,
        guildId,
        warId,
        report: evaluationResult.report,
        attemptCount,
        attemptAt,
        startedAt,
      });
    } catch (error) {
      if (wasCompleted && input.force) {
        console.warn(
          [
            "[war-plan-violation] event=evaluation_force_failed_preserve_completed",
            `guild=${guildId}`,
            `war_id=${warId}`,
            `clan_tag=${historyRow.clanTag}`,
            `error=${formatError(error)}`,
          ].join(" "),
        );
        return {
          status: "COMPLETED",
          guildId,
          warId,
          violationCount: evaluation.violations.length,
          attemptCount: evaluation.attemptCount,
          durationMs: Date.now() - startedAt,
          failureCode: evaluation.failureCode ?? null,
          failureMessage: evaluation.failureMessage ?? null,
          completedAt: evaluation.completedAt ?? null,
        };
      }
      return persistFailure({
        status: "FAILED",
        failureCode: "FAILED",
        failureMessage: `Unexpected compliance evaluation failure: ${formatError(error)}`,
      });
    }
  }

  /** Purpose: reconcile a bounded number of explicitly enrolled retryable evaluations. */
  async reconcileDueEvaluations(input?: {
    limit?: number;
  }): Promise<WarPlanViolationReconcileResult> {
    const startedAt = Date.now();
    const parsedLimit = Math.trunc(Number(input?.limit ?? MAX_RECONCILE_LIMIT));
    const requestedLimit = Number.isFinite(parsedLimit)
      ? Math.max(0, parsedLimit)
      : MAX_RECONCILE_LIMIT;
    const limit = Math.min(MAX_RECONCILE_LIMIT, requestedLimit);
    if (limit <= 0) {
      return {
        requestedLimit,
        processedCount: 0,
        completedCount: 0,
        insufficientDataCount: 0,
        failedCount: 0,
        skippedCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const now = new Date();
    const candidates = await prisma.warPlanComplianceEvaluation.findMany({
      where: {
        status: {
          in: ["PENDING", "INSUFFICIENT_DATA", "FAILED"],
        },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: [{ nextAttemptAt: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        guildId: true,
        warId: true,
      },
    });

    let completedCount = 0;
    let insufficientDataCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.finalizeEvaluation({
          guildId: candidate.guildId,
          warId: candidate.warId,
        });
        if (!result) {
          skippedCount += 1;
          continue;
        }
        if (result.status === "COMPLETED") completedCount += 1;
        else if (result.status === "INSUFFICIENT_DATA") insufficientDataCount += 1;
        else if (result.status === "FAILED") failedCount += 1;
        else skippedCount += 1;
      } catch (error) {
        failedCount += 1;
        console.error(
          [
            "[war-plan-violation] event=reconcile_candidate_failed",
            `guild=${candidate.guildId}`,
            `war_id=${candidate.warId}`,
            `error=${formatError(error)}`,
          ].join(" "),
        );
      }
    }

    const processedCount =
      completedCount + insufficientDataCount + failedCount + skippedCount;
    const durationMs = Date.now() - startedAt;
    console.info(
      [
        "[war-plan-violation] event=reconcile_complete",
        `requested_limit=${requestedLimit}`,
        `processed=${processedCount}`,
        `completed=${completedCount}`,
        `insufficient_data=${insufficientDataCount}`,
        `failed=${failedCount}`,
        `skipped=${skippedCount}`,
        `duration_ms=${durationMs}`,
      ].join(" "),
    );
    return {
      requestedLimit,
      processedCount,
      completedCount,
      insufficientDataCount,
      failedCount,
      skippedCount,
      durationMs,
    };
  }

  private async persistCompletedEvaluation(input: {
    evaluation: NonNullable<WarPlanEvaluationRow>;
    guildId: string;
    warId: number;
    report: WarComplianceReport;
    attemptCount: number;
    attemptAt: Date;
    startedAt: number;
  }): Promise<WarPlanViolationFinalizeResult> {
    const issueContext = {
      matchType: input.report.matchType,
      expectedOutcome: input.report.expectedOutcome,
      loseStyle: input.report.loseStyle,
    } satisfies FwaPoliceApplicabilityContext;
    const resolvedViolations = normalizeViolationIssues(
      input.report.notFollowingPlan,
      issueContext,
    );
    const violationPlayerTags = resolvedViolations.map(({ issue }) =>
      normalizeTag(issue.playerTag),
    );
    const townHallSnapshotByPlayerTag = await this.resolveTownHallSnapshots({
      guildId: input.guildId,
      warId: input.warId,
      clanTag: input.report.clanTag,
      playerTags: violationPlayerTags,
    });
    const nonMirrorTripleMinClanStars =
      input.report.fwaWinGateConfig?.nonMirrorTripleMinClanStars ?? null;
    const allBasesOpenHoursLeft =
      input.report.fwaWinGateConfig?.allBasesOpenHoursLeft ?? null;
    const rulesFingerprint = buildRulesFingerprint({
      engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
      matchType: input.report.matchType,
      expectedOutcome: input.report.expectedOutcome,
      loseStyle: input.report.loseStyle,
      nonMirrorTripleMinClanStars,
      allBasesOpenHoursLeft,
    });
    const completedAt = new Date();
    const violationRows = resolvedViolations.map(({ issue, violationType }) => ({
      evaluationId: input.evaluation.id,
      playerTag: normalizeTag(issue.playerTag),
      playerNameSnapshot: resolvePlayerNameSnapshot(issue),
      playerPosition: resolvePlayerPositionSnapshot(issue),
      townHallLevelSnapshot:
        townHallSnapshotByPlayerTag.get(normalizeTag(issue.playerTag)) ?? null,
      violationType,
      reasonLabel: normalizeFwaPoliceText(issue.reasonLabel) || null,
      expectedBehavior: normalizeFwaPoliceText(issue.expectedBehavior),
      actualBehavior: normalizeFwaPoliceText(issue.actualBehavior),
      breachStarsAt: resolveBreachStarsAt(issue),
      breachTimeRemaining: resolveBreachTimeRemaining(issue),
      attackDetails: buildViolationAttackDetails(issue),
    }));

    const updated = await prisma.$transaction(async (tx) => {
      await tx.warPlanViolation.deleteMany({
        where: { evaluationId: input.evaluation.id },
      });
      const insertedViolations =
        violationRows.length > 0
          ? await tx.warPlanViolation.createMany({
              data: violationRows,
            })
          : { count: 0 };
      const parent = await tx.warPlanComplianceEvaluation.update({
        where: {
          id: input.evaluation.id,
        },
        data: {
          status: "COMPLETED",
          engineVersion: WAR_PLAN_COMPLIANCE_ENGINE_VERSION,
          matchType: input.report.matchType,
          expectedOutcome: input.report.expectedOutcome,
          loseStyle: input.report.loseStyle,
          nonMirrorTripleMinClanStars,
          allBasesOpenHoursLeft,
          rulesFingerprint,
          attemptCount: input.attemptCount,
          lastAttemptAt: input.attemptAt,
          nextAttemptAt: null,
          completedAt,
          failureCode: null,
          failureMessage: null,
        },
        include: {
          violations: true,
        },
      });
      void insertedViolations;
      return parent;
    });

    const durationMs = Date.now() - input.startedAt;
    console.info(
      [
        "[war-plan-violation] event=evaluation_completed",
        `guild=${input.guildId}`,
        `war_id=${input.warId}`,
        `clan_tag=${input.report.clanTag}`,
        `status=${updated.status}`,
        `violation_count=${updated.violations.length}`,
        `attempt=${updated.attemptCount}`,
        `duration_ms=${durationMs}`,
      ].join(" "),
    );
    return {
      status: "COMPLETED",
      guildId: input.guildId,
      warId: input.warId,
      violationCount: updated.violations.length,
      attemptCount: updated.attemptCount,
      durationMs,
      failureCode: null,
      failureMessage: null,
      completedAt: updated.completedAt ?? completedAt,
    };
  }

  private async resolveTownHallSnapshots(input: {
    guildId: string;
    warId: number;
    clanTag: string;
    playerTags: string[];
  }): Promise<Map<string, number | null>> {
    const normalizedTags = [
      ...new Set(
        input.playerTags
          .flatMap((tag) => {
            const normalized = normalizeTag(tag);
            const bare = normalized.replace(/^#/, "");
            return bare && bare !== normalized ? [normalized, bare] : [normalized];
          })
          .filter((tag) => Boolean(tag && tag.trim())),
      ),
    ];
    if (normalizedTags.length <= 0) return new Map();

    const [participationRows, clanMemberRows, playerCatalogRows, playerCurrentRows] =
      await Promise.all([
        prisma.clanWarParticipation.findMany({
          where: {
            guildId: input.guildId,
            warId: String(input.warId),
            playerTag: { in: normalizedTags },
          },
          select: {
            playerTag: true,
            townHall: true,
          },
        }),
        prisma.fwaClanMemberCurrent.findMany({
          where: {
            OR: [
              { clanTag: input.clanTag },
              { clanTag: normalizeTag(input.clanTag).replace(/^#/, "") },
            ],
            playerTag: { in: normalizedTags },
          },
          select: {
            playerTag: true,
            townHall: true,
          },
        }),
        prisma.fwaPlayerCatalog.findMany({
          where: {
            playerTag: { in: normalizedTags },
          },
          select: {
            playerTag: true,
            latestTownHall: true,
          },
        }),
        prisma.playerCurrent.findMany({
          where: {
            playerTag: { in: normalizedTags },
          },
          select: {
            playerTag: true,
            townHall: true,
          },
        }),
      ]);

    const result = new Map<string, number | null>();
    const setIfMissing = (
      playerTag: string,
      townHall: number | null,
    ): void => {
      const normalized = normalizeTag(playerTag);
      if (!normalized || result.has(normalized) || townHall === null) return;
      result.set(normalized, townHall);
    };

    for (const row of participationRows) {
      setIfMissing(row.playerTag, resolveTownHallSnapshot(row));
    }
    for (const row of clanMemberRows) {
      setIfMissing(row.playerTag, resolveTownHallSnapshot(row));
    }
    for (const row of playerCatalogRows) {
      setIfMissing(row.playerTag, resolveTownHallSnapshot({ playerTag: row.playerTag, townHall: row.latestTownHall }));
    }
    for (const row of playerCurrentRows) {
      setIfMissing(row.playerTag, resolveTownHallSnapshot(row));
    }

    for (const tag of normalizedTags) {
      const normalized = normalizeTag(tag);
      if (!result.has(normalized)) {
        result.set(normalized, null);
      }
    }

    return result;
  }
}
