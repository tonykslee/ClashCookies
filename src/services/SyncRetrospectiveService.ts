import { prisma } from "../prisma";
import { normalizeTag } from "./war-events/core";

type RetrospectiveDb = {
  syncCycle: {
    findUnique: (args: any) => Promise<any | null>;
    findMany: (args: any) => Promise<any[]>;
  };
  clanPointsSync: { findMany: (args: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args: any) => Promise<any[]> };
  syncClanReadinessSnapshot: { findMany: (args: any) => Promise<any[]> };
  clanWarParticipation: { findMany: (args: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args: any) => Promise<any[]> };
  warPlanViolation: { findMany: (args: any) => Promise<any[]> };
};

export type SyncRetrospectiveInput = {
  guildId: string;
  syncNumber: number;
};

export type SyncRetrospectiveLatestInput = {
  guildId: string;
};

export type SyncRetrospectiveCompletionState = {
  complete: boolean;
  participantClanCount: number;
  endedParticipantClanCount: number;
  completedAt: Date | null;
  reason:
    | "complete"
    | "no_participants"
    | "incomplete_history"
    | "completion_time_unavailable";
};

export type SyncRetrospectivePlayerRow = {
  playerTag: string;
  playerName: string | null;
  attacksUsed: number;
  attacksMissed: number;
  starsEarned: number;
};

export type SyncRetrospectiveViolationRow = {
  violationType: string;
  playerTag: string | null;
  playerName: string | null;
  reasonLabel: string | null;
  expectedBehavior: string | null;
  actualBehavior: string | null;
};

export type SyncRetrospectiveClanRow = {
  identity: {
    clanTag: string;
    clanName: string | null;
    warId: number | null;
    matchType: string | null;
    expectedOutcome: string | null;
    actualOutcome: string | null;
  };
  war: {
    stars: number | null;
  };
  missedAttacks: {
    total: number | null;
    coverageComplete: boolean;
    players: SyncRetrospectivePlayerRow[];
  };
  violations: {
    total: number | null;
    evaluationComplete: boolean;
    applicable: boolean;
    details: SyncRetrospectiveViolationRow[];
  };
  readiness: {
    memberCount: number | null;
    deviationScore: number | null;
    projectionComplete: boolean;
    dataAvailable: boolean;
  };
  fillers: {
    fillerCount: number | null;
    fillerPlayerTags: string[];
    fillerCaptureComplete: boolean;
  };
};

export type SyncRetrospectiveResult = {
  identity: {
    guildId: string;
    syncNumber: number;
    syncTime: Date | null;
    cycleMapped: boolean;
  };
  warSummary: {
    clanWarCount: number;
    totalStarsKnown: number | null;
    starsCoverage: { known: number; total: number };
  };
  missedAttacks: {
    missedAttacksKnownTotal: number | null;
    coverage: { completeClans: number; warClans: number };
  };
  fwaViolations: {
    violationKnownTotal: number | null;
    coverage: { completedFwaEvaluations: number; fwaWars: number };
  };
  readiness: {
    averageDeviation: number | null;
    deviationCoverage: { valid: number; totalSnapshots: number };
  };
  fillers: {
    fillerKnownTotal: number | null;
    fillerCoverage: { complete: number; totalSnapshots: number };
  };
  clans: SyncRetrospectiveClanRow[];
};

type HistoryRow = {
  warId: number;
  syncNumber: number | null;
  matchType: string | null;
  clanStars: number | null;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  prepStartTime: Date | null;
  clanName: string | null;
  clanTag: string;
};

type CompletionHistoryRow = {
  warId: number;
  syncNumber: number | null;
  clanTag: string;
  warStartTime: Date | null;
  warEndTime: Date | null;
  opponentTag: string | null;
};

type SnapshotRow = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  clanName: string | null;
  memberCount: number | null;
  deviationScore: number | null;
  projectionComplete: boolean;
  fillerCaptureComplete: boolean;
  fillerPlayerTags: string[];
};

type PointsSyncIdentityRow = {
  clanTag: string;
  warId: number | null;
  warStartTime: Date;
  opponentTag: string;
  syncNum: number;
};

function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSyncNumber(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validNonnegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizedComparable(value: unknown): string | null {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function historyMatchType(row: HistoryRow): string | null {
  return normalizedComparable(row.matchType);
}

function isFwa(row: HistoryRow): boolean {
  return historyMatchType(row) === "FWA";
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function rowKey(warId: number | null, clanTag: string): string {
  return `${warId ?? "none"}|${clanTag}`;
}

function normalizeHistoryRow(row: any): HistoryRow | null {
  const warId = Number(row?.warId);
  const clanTag = normalizeTag(row?.clanTag);
  if (!Number.isInteger(warId) || warId <= 0 || !clanTag) return null;
  return {
    warId,
    syncNumber: normalizeSyncNumber(row?.syncNumber) || null,
    matchType: normalizeText(row?.matchType),
    clanStars: finiteNumber(row?.clanStars),
    expectedOutcome: normalizeText(row?.expectedOutcome),
    actualOutcome: normalizeText(row?.actualOutcome),
    prepStartTime: isValidDate(row?.prepStartTime) ? row.prepStartTime : null,
    clanName: normalizeText(row?.clanName),
    clanTag,
  };
}

function normalizeSnapshotRow(row: any): SnapshotRow | null {
  const guildId = normalizeGuildId(row?.guildId);
  const clanTag = normalizeTag(row?.clanTag);
  if (!guildId || !clanTag || !isValidDate(row?.syncTime)) return null;
  return {
    guildId,
    syncTime: row.syncTime,
    clanTag,
    clanName: normalizeText(row?.clanName),
    memberCount: Number.isInteger(Number(row?.memberCount)) ? Number(row.memberCount) : null,
    deviationScore: finiteNumber(row?.deviationScore),
    projectionComplete: row?.projectionComplete === true,
    fillerCaptureComplete: row?.fillerCaptureComplete === true,
    fillerPlayerTags: Array.isArray(row?.fillerPlayerTags)
      ? row.fillerPlayerTags.map((tag: unknown) => normalizeTag(String(tag))).filter(Boolean)
      : [],
  };
}

function normalizePointsSyncIdentity(row: any): PointsSyncIdentityRow | null {
  const clanTag = normalizeText(row?.clanTag);
  const opponentTag = normalizeText(row?.opponentTag);
  const warStartTime = row?.warStartTime;
  const syncNum = normalizeSyncNumber(row?.syncNum);
  if (!clanTag || !opponentTag || !isValidDate(warStartTime) || syncNum <= 0) return null;
  const parsedWarId = Number(row?.warId);
  return {
    clanTag,
    warId: Number.isInteger(parsedWarId) && parsedWarId > 0 ? parsedWarId : null,
    warStartTime,
    opponentTag,
    syncNum,
  };
}

type GuildOwnedHistoryClause = {
  syncNumber: number;
  warId?: number;
  clanTag?: string;
  warStartTime?: Date;
  opponentTag?: string;
};

function buildGuildOwnedHistoryClauses(
  pointsSyncRows: PointsSyncIdentityRow[],
  syncNumbers: Set<number>,
): GuildOwnedHistoryClause[] {
  return pointsSyncRows
    .filter((row) => syncNumbers.has(row.syncNum))
    .map((row) => row.warId !== null
      ? { syncNumber: row.syncNum, warId: row.warId }
      : {
          syncNumber: row.syncNum,
          clanTag: row.clanTag,
          warStartTime: row.warStartTime,
          opponentTag: row.opponentTag,
        });
}

function buildGuildOwnedHistoryWhere(
  pointsSyncRows: PointsSyncIdentityRow[],
  evaluationRows: any[],
  syncNumber: number,
): any | null {
  const pointClauses = buildGuildOwnedHistoryClauses(pointsSyncRows, new Set([syncNumber]));
  const directWarIds = new Set<number>();
  const fallbackIdentities: Array<{
    clanTag: string;
    warStartTime: Date;
    opponentTag: string;
  }> = [];

  for (const row of pointClauses) {
    if (row.warId !== undefined) directWarIds.add(row.warId);
    else fallbackIdentities.push({
      clanTag: row.clanTag!,
      warStartTime: row.warStartTime!,
      opponentTag: row.opponentTag!,
    });
  }
  for (const row of evaluationRows) {
    const warId = Number(row?.warId);
    if (Number.isInteger(warId) && warId > 0) directWarIds.add(warId);
  }

  const identityOr = [
    ...(directWarIds.size > 0 ? [{ warId: { in: [...directWarIds] } }] : []),
    ...fallbackIdentities.map((identity) => ({
      clanTag: identity.clanTag,
      warStartTime: identity.warStartTime,
      opponentTag: identity.opponentTag,
    })),
  ];
  if (identityOr.length === 0) return null;
  return { syncNumber, OR: identityOr };
}

function buildPointsOwnedHistoryWhere(
  pointsSyncRows: PointsSyncIdentityRow[],
  syncNumber: number,
): any | null {
  const clauses = buildGuildOwnedHistoryClauses(pointsSyncRows, new Set([syncNumber]));
  return clauses.length > 0 ? { syncNumber, OR: clauses } : null;
}

function normalizeCompletionHistoryRow(row: any): CompletionHistoryRow | null {
  const warId = Number(row?.warId);
  const syncNumber = normalizeSyncNumber(row?.syncNumber) || null;
  const clanTag = normalizeTag(row?.clanTag);
  if (!Number.isInteger(warId) || warId <= 0 || !clanTag || syncNumber === null) return null;
  return {
    warId,
    syncNumber,
    clanTag,
    warStartTime: isValidDate(row?.warStartTime) ? row.warStartTime : null,
    warEndTime: isValidDate(row?.warEndTime) ? row.warEndTime : null,
    opponentTag: normalizeTag(row?.opponentTag) || null,
  };
}

/** Purpose: build a DB-first read model for one historically mapped sync cycle without writes or external calls. */
export class SyncRetrospectiveService {
  constructor(private readonly db: RetrospectiveDb = prisma as unknown as RetrospectiveDb) {}

  /** Purpose: find the newest bounded sync cycle with persisted retrospective evidence. */
  async getLatestAvailableSyncNumber(
    input: SyncRetrospectiveLatestInput,
  ): Promise<number | null> {
    const guildId = normalizeGuildId(input.guildId);
    if (!guildId) return null;

    const cycles = await this.db.syncCycle.findMany({
      where: { guildId },
      orderBy: { syncNumber: "desc" },
      take: 100,
      select: { syncNumber: true, syncTime: true },
    });
    const normalizedCycles = cycles
      .map((row: any) => ({
        syncNumber: normalizeSyncNumber(row?.syncNumber),
        syncTime: row?.syncTime,
      }))
      .filter((row: { syncNumber: number; syncTime: unknown }) =>
        row.syncNumber > 0 && isValidDate(row.syncTime),
      );
    if (normalizedCycles.length === 0) return null;

    const syncNumbers = normalizedCycles.map((row) => row.syncNumber);
    const syncTimes = normalizedCycles.map((row) => row.syncTime);
    const [rawPointsRows, evaluationRows, snapshotRows] = await Promise.all([
      this.db.clanPointsSync.findMany({
        where: { guildId, syncNum: { in: syncNumbers } },
        select: {
          clanTag: true,
          warId: true,
          warStartTime: true,
          opponentTag: true,
          syncNum: true,
        },
      }),
      this.db.warPlanComplianceEvaluation.findMany({
        where: { guildId, warHistory: { syncNumber: { in: syncNumbers } } },
        select: { warId: true, warHistory: { select: { syncNumber: true } } },
      }),
      this.db.syncClanReadinessSnapshot.findMany({
        where: { guildId, syncTime: { in: syncTimes } },
        select: { syncTime: true },
      }),
    ]);

    const pointsSyncRows = rawPointsRows
      .map(normalizePointsSyncIdentity)
      .filter((row): row is PointsSyncIdentityRow => row !== null);
    const candidateSyncNumbers = new Set(syncNumbers);
    const pointHistoryClauses = buildGuildOwnedHistoryClauses(pointsSyncRows, candidateSyncNumbers);
    const rawPointHistories = pointHistoryClauses.length > 0
      ? await this.db.clanWarHistory.findMany({
          where: { OR: pointHistoryClauses },
          select: { syncNumber: true },
        })
      : [];
    const actualSyncNumbers = new Set(
      rawPointHistories
        .map((row: any) => normalizeSyncNumber(row?.syncNumber))
        .filter((syncNumber: number) => candidateSyncNumbers.has(syncNumber)),
    );
    for (const row of evaluationRows) {
      const syncNumber = normalizeSyncNumber(row?.warHistory?.syncNumber);
      if (candidateSyncNumbers.has(syncNumber)) actualSyncNumbers.add(syncNumber);
    }
    const snapshotTimes = new Set(
      snapshotRows
        .filter((row: any) => isValidDate(row?.syncTime))
        .map((row: any) => row.syncTime.getTime()),
    );

    for (const cycle of normalizedCycles) {
      if (
        actualSyncNumbers.has(cycle.syncNumber) ||
        snapshotTimes.has(cycle.syncTime.getTime())
      ) {
        return cycle.syncNumber;
      }
    }
    return null;
  }

  /** Purpose: prove sync completion from the persisted participation cohort and canonical ended histories only. */
  async getCompletionState(
    input: SyncRetrospectiveInput,
  ): Promise<SyncRetrospectiveCompletionState> {
    const guildId = normalizeGuildId(input.guildId);
    const syncNumber = normalizeSyncNumber(input.syncNumber);
    const cycle = await this.db.syncCycle.findUnique({
      where: { guildId_syncNumber: { guildId, syncNumber } },
      select: { syncTime: true },
    });
    if (!cycle || !isValidDate(cycle.syncTime)) {
      return {
        complete: false,
        participantClanCount: 0,
        endedParticipantClanCount: 0,
        completedAt: null,
        reason: "incomplete_history",
      };
    }

    const rawPointsRows = await this.db.clanPointsSync.findMany({
      where: { guildId, syncNum: syncNumber },
      select: {
        clanTag: true,
        warId: true,
        warStartTime: true,
        opponentTag: true,
        syncNum: true,
      },
    });
    const pointsSyncRows = rawPointsRows
      .map(normalizePointsSyncIdentity)
      .filter((row): row is PointsSyncIdentityRow => row !== null);
    const participantTags = new Set(pointsSyncRows.map((row) => normalizeTag(row.clanTag)));
    if (participantTags.size === 0) {
      return {
        complete: false,
        participantClanCount: 0,
        endedParticipantClanCount: 0,
        completedAt: null,
        reason: "no_participants",
      };
    }

    const historyWhere = buildPointsOwnedHistoryWhere(pointsSyncRows, syncNumber);
    const rawHistories = historyWhere
      ? await this.db.clanWarHistory.findMany({
          where: historyWhere,
          select: {
            warId: true,
            syncNumber: true,
            clanTag: true,
            warStartTime: true,
            warEndTime: true,
            opponentTag: true,
          },
        })
      : [];
    const histories = rawHistories
      .map(normalizeCompletionHistoryRow)
      .filter((row): row is CompletionHistoryRow => row !== null);
    const endedHistories: CompletionHistoryRow[] = [];
    let missingHistory = false;
    let missingCompletionTime = false;

    for (const participantTag of participantTags) {
      const participantRows = pointsSyncRows.filter((row) => normalizeTag(row.clanTag) === participantTag);
      const matches = histories.filter((history) => participantRows.some((point) =>
        point.warId !== null
            ? history.warId === point.warId && history.syncNumber === syncNumber
          : history.clanTag === participantTag &&
            history.warStartTime?.getTime() === point.warStartTime.getTime() &&
            history.opponentTag === normalizeTag(point.opponentTag)
      ));
      if (matches.length === 0) {
        missingHistory = true;
        continue;
      }
      const ended = matches.find((history) => history.warEndTime !== null);
      if (!ended) {
        missingCompletionTime = true;
        continue;
      }
      endedHistories.push(ended);
    }

    const completedAt = endedHistories.length > 0
      ? new Date(Math.max(...endedHistories.map((history) => history.warEndTime!.getTime())))
      : null;
    const endedParticipantClanCount = endedHistories.length;
    if (missingHistory) {
      return {
        complete: false,
        participantClanCount: participantTags.size,
        endedParticipantClanCount,
        completedAt,
        reason: "incomplete_history",
      };
    }
    if (missingCompletionTime || endedParticipantClanCount !== participantTags.size || !completedAt) {
      return {
        complete: false,
        participantClanCount: participantTags.size,
        endedParticipantClanCount,
        completedAt,
        reason: "completion_time_unavailable",
      };
    }
    return {
      complete: true,
      participantClanCount: participantTags.size,
      endedParticipantClanCount,
      completedAt,
      reason: "complete",
    };
  }

  async getBySyncNumber(input: SyncRetrospectiveInput): Promise<SyncRetrospectiveResult> {
    const guildId = normalizeGuildId(input.guildId);
    const syncNumber = normalizeSyncNumber(input.syncNumber);
    const [cycle, rawPointsSync, ownershipEvaluations] = await Promise.all([
      this.db.syncCycle.findUnique({
        where: { guildId_syncNumber: { guildId, syncNumber } },
        select: { syncTime: true },
      }),
      this.db.clanPointsSync.findMany({
        where: { guildId, syncNum: syncNumber },
        select: {
          clanTag: true,
          warId: true,
          warStartTime: true,
          opponentTag: true,
          syncNum: true,
        },
      }),
      this.db.warPlanComplianceEvaluation.findMany({
        where: { guildId, warHistory: { syncNumber } },
        select: {
          id: true,
          warId: true,
          status: true,
          matchType: true,
          expectedOutcome: true,
        },
      }),
    ]);
    const pointsSyncRows = rawPointsSync
      .map(normalizePointsSyncIdentity)
      .filter((row): row is PointsSyncIdentityRow => row !== null);
    const historyWhere = buildGuildOwnedHistoryWhere(pointsSyncRows, ownershipEvaluations, syncNumber);
    const rawHistories = historyWhere
      ? await this.db.clanWarHistory.findMany({
          where: historyWhere,
          orderBy: [{ clanTag: "asc" }, { warId: "asc" }],
          select: {
            warId: true,
            syncNumber: true,
            matchType: true,
            clanStars: true,
            expectedOutcome: true,
            actualOutcome: true,
            prepStartTime: true,
            clanName: true,
            clanTag: true,
          },
        })
      : [];
    const histories = rawHistories.map(normalizeHistoryRow).filter((row): row is HistoryRow => row !== null);
    const warIds = histories.map((row) => row.warId);
    const snapshotPromise = cycle?.syncTime
      ? this.db.syncClanReadinessSnapshot.findMany({
          where: { guildId, syncTime: cycle.syncTime },
          orderBy: [{ clanTag: "asc" }],
          select: {
            guildId: true,
            syncTime: true,
            clanTag: true,
            clanName: true,
            memberCount: true,
            deviationScore: true,
            projectionComplete: true,
            fillerCaptureComplete: true,
            fillerPlayerTags: true,
          },
        })
      : Promise.resolve([]);

    const [rawParticipation, rawEvaluations, rawSnapshots] = await Promise.all([
      warIds.length > 0
        ? this.db.clanWarParticipation.findMany({
            where: { guildId, warId: { in: warIds.map(String) } },
            orderBy: [{ warId: "asc" }, { playerTag: "asc" }],
            select: {
              warId: true,
              clanTag: true,
              playerTag: true,
              playerName: true,
              attacksUsed: true,
              attacksMissed: true,
              starsEarned: true,
            },
          })
        : Promise.resolve([]),
      Promise.resolve(ownershipEvaluations.filter((row: any) => warIds.includes(Number(row?.warId)))),
      snapshotPromise,
    ]);

    const evaluationIds = rawEvaluations.map((row: any) => String(row?.id ?? "")).filter(Boolean);
    const rawViolations = evaluationIds.length > 0
      ? await this.db.warPlanViolation.findMany({
          where: { evaluationId: { in: evaluationIds } },
          orderBy: [{ evaluationId: "asc" }, { playerTag: "asc" }],
          select: {
            evaluationId: true,
            violationType: true,
            playerTag: true,
            playerNameSnapshot: true,
            reasonLabel: true,
            expectedBehavior: true,
            actualBehavior: true,
          },
        })
      : [];

    return buildRetrospectiveResult({
      guildId,
      syncNumber,
      cycle,
      histories,
      snapshots: rawSnapshots.map(normalizeSnapshotRow).filter((row): row is SnapshotRow => row !== null),
      participation: rawParticipation,
      evaluations: rawEvaluations,
      violations: rawViolations,
    });
  }
}

function buildRetrospectiveResult(input: {
  guildId: string;
  syncNumber: number;
  cycle: { syncTime: Date } | null;
  histories: HistoryRow[];
  snapshots: SnapshotRow[];
  participation: any[];
  evaluations: any[];
  violations: any[];
}): SyncRetrospectiveResult {
  const historyByClan = new Map<string, HistoryRow>();
  for (const history of input.histories) {
    if (!historyByClan.has(history.clanTag)) historyByClan.set(history.clanTag, history);
  }
  const snapshotByClan = new Map<string, SnapshotRow>();
  for (const snapshot of input.snapshots) snapshotByClan.set(snapshot.clanTag, snapshot);

  const participationByWarAndClan = new Map<string, any[]>();
  for (const row of input.participation) {
    const key = rowKey(Number(row?.warId) || null, normalizeTag(row?.clanTag));
    const rows = participationByWarAndClan.get(key) ?? [];
    rows.push(row);
    participationByWarAndClan.set(key, rows);
  }
  const evaluationByWarId = new Map(input.evaluations.map((row) => [Number(row?.warId), row]));
  const violationsByEvaluationId = new Map<string, any[]>();
  for (const row of input.violations) {
    const key = String(row?.evaluationId ?? "");
    const rows = violationsByEvaluationId.get(key) ?? [];
    rows.push(row);
    violationsByEvaluationId.set(key, rows);
  }

  const clanTags = [...new Set([...historyByClan.keys(), ...snapshotByClan.keys()])].sort((a, b) => a.localeCompare(b));
  const clans: SyncRetrospectiveClanRow[] = clanTags.map((clanTag) => {
    const history = historyByClan.get(clanTag) ?? null;
    const snapshot = snapshotByClan.get(clanTag) ?? null;
    const participationRows = history
      ? participationByWarAndClan.get(rowKey(history.warId, clanTag)) ?? []
      : [];
    const normalizedPlayers = buildCanonicalParticipation(participationRows);
    const missedAttacks = normalizedPlayers
      ? normalizedPlayers.reduce((sum, player) => sum + player.attacksMissed, 0)
      : null;

    const applicable = history ? isFwa(history) : false;
    const evaluation = history ? evaluationByWarId.get(history.warId) : null;
    const evaluationComplete = applicable && Boolean(
      evaluation &&
      normalizedComparable(evaluation.status) === "COMPLETED" &&
      normalizedComparable(evaluation.matchType) === "FWA" &&
      normalizedComparable(evaluation.matchType) === normalizedComparable(history?.matchType) &&
      normalizedComparable(evaluation.expectedOutcome) === normalizedComparable(history?.expectedOutcome),
    );
    const violationRows = evaluationComplete
      ? (violationsByEvaluationId.get(String(evaluation.id)) ?? [])
      : [];

    return {
      identity: {
        clanTag,
        clanName: snapshot?.clanName ?? history?.clanName ?? null,
        warId: history?.warId ?? null,
        matchType: history?.matchType ?? null,
        expectedOutcome: history?.expectedOutcome ?? null,
        actualOutcome: history?.actualOutcome ?? null,
      },
      war: { stars: history?.clanStars ?? null },
      missedAttacks: {
        total: missedAttacks,
        coverageComplete: history !== null && normalizedPlayers !== null,
        players: normalizedPlayers ?? [],
      },
      violations: {
        total: evaluationComplete ? violationRows.length : null,
        evaluationComplete,
        applicable,
        details: evaluationComplete
          ? violationRows.map((row) => ({
              violationType: String(row?.violationType ?? "OTHER_PLAN_VIOLATION"),
              playerTag: normalizeTag(row?.playerTag) || null,
              playerName: normalizeText(row?.playerNameSnapshot),
              reasonLabel: normalizeText(row?.reasonLabel),
              expectedBehavior: normalizeText(row?.expectedBehavior),
              actualBehavior: normalizeText(row?.actualBehavior),
            }))
          : [],
      },
      readiness: {
        memberCount: snapshot?.memberCount ?? null,
        deviationScore: snapshot?.projectionComplete && snapshot?.deviationScore !== null
          ? snapshot.deviationScore
          : null,
        projectionComplete: snapshot?.projectionComplete ?? false,
        dataAvailable: snapshot !== null,
      },
      fillers: {
        fillerCount: snapshot?.fillerCaptureComplete ? snapshot.fillerPlayerTags.length : null,
        fillerPlayerTags: snapshot?.fillerCaptureComplete ? snapshot.fillerPlayerTags : [],
        fillerCaptureComplete: snapshot?.fillerCaptureComplete ?? false,
      },
    };
  });

  const knownStars = clans.map((clan) => clan.war.stars).filter((stars): stars is number => stars !== null && Number.isFinite(stars));
  const completeMissed = clans.filter((clan) => clan.missedAttacks.coverageComplete);
  const applicableViolations = clans.filter((clan) => clan.violations.applicable);
  const completeViolations = applicableViolations.filter((clan) => clan.violations.evaluationComplete);
  const validDeviation = input.snapshots
    .filter((snapshot) => snapshot.projectionComplete && snapshot.deviationScore !== null && Number.isFinite(snapshot.deviationScore))
    .map((snapshot) => snapshot.deviationScore as number);
  const completeFillers = input.snapshots.filter((snapshot) => snapshot.fillerCaptureComplete);

  return {
    identity: {
      guildId: input.guildId,
      syncNumber: input.syncNumber,
      syncTime: input.cycle?.syncTime ?? null,
      cycleMapped: input.cycle !== null,
    },
    warSummary: {
      clanWarCount: input.histories.length,
      totalStarsKnown: knownStars.length > 0 ? knownStars.reduce((sum, stars) => sum + stars, 0) : null,
      starsCoverage: { known: knownStars.length, total: input.histories.length },
    },
    missedAttacks: {
      missedAttacksKnownTotal: completeMissed.length > 0
        ? completeMissed.reduce((sum, clan) => sum + (clan.missedAttacks.total ?? 0), 0)
        : null,
      coverage: { completeClans: completeMissed.length, warClans: input.histories.length },
    },
    fwaViolations: {
      violationKnownTotal: completeViolations.length > 0
        ? completeViolations.reduce((sum, clan) => sum + (clan.violations.total ?? 0), 0)
        : null,
      coverage: {
        completedFwaEvaluations: completeViolations.length,
        fwaWars: applicableViolations.length,
      },
    },
    readiness: {
      averageDeviation: validDeviation.length > 0
        ? validDeviation.reduce((sum, value) => sum + value, 0) / validDeviation.length
        : null,
      deviationCoverage: { valid: validDeviation.length, totalSnapshots: input.snapshots.length },
    },
    fillers: {
      fillerKnownTotal: completeFillers.length > 0
        ? completeFillers.reduce((sum, snapshot) => sum + snapshot.fillerPlayerTags.length, 0)
        : null,
      fillerCoverage: { complete: completeFillers.length, totalSnapshots: input.snapshots.length },
    },
    clans,
  };
}

/** Purpose: validate the canonical ended-war participation roster without external size metadata. */
function buildCanonicalParticipation(rows: any[]): SyncRetrospectivePlayerRow[] | null {
  if (rows.length === 0) return null;
  const tags = new Set<string>();
  const players: SyncRetrospectivePlayerRow[] = [];
  for (const row of rows) {
    const playerTag = normalizeTag(row?.playerTag);
    const attacksMissed = validNonnegativeInteger(row?.attacksMissed);
    const attacksUsed = validNonnegativeInteger(row?.attacksUsed);
    const starsEarned = validNonnegativeInteger(row?.starsEarned);
    if (!playerTag || tags.has(playerTag) || attacksMissed === null || attacksUsed === null || starsEarned === null) return null;
    tags.add(playerTag);
    players.push({
      playerTag,
      playerName: normalizeText(row?.playerName),
      attacksUsed,
      attacksMissed,
      starsEarned,
    });
  }
  return players.sort((a, b) => a.playerTag.localeCompare(b.playerTag));
}
