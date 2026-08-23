import { prisma } from "../prisma";
import {
  associateCanonicalHistories,
  classifyReconciliationHistoryScope,
  classifyPointsSyncClaim,
  HISTORICAL_SYNC_LOOKBACK_MS,
  planAnchoredSequenceIntervals,
  corroborateRealizedFwaSequence,
  type RealizedFwaSequencePlan,
  type RealizedFwaCyclePlan,
  type ReconciliationAnchor,
  type ReconciliationCycle,
  type ReconciliationEvaluation,
  type ReconciliationHistory,
  type ReconciliationParticipation,
  type ReconciliationPoint,
  type ReconciliationSchedule,
  type AnchorIntervalPlan,
  type AssociatedHistory,
  type ProposedSyncBoundary,
  type ReconciliationHistoryScopeWindow,
  type HistoryClaimResult,
} from "../services/historicalSyncReconciliation";
import { historicalHistoryMatchesPointByExactTuple, normalizeMembershipHistoryClanTag } from "../services/membershipHistoryIdentity";

export type HistoricalSyncReconciliationArgs = {
  guildId: string;
  fromSync?: number;
  toSync?: number;
};

export type HistoricalSyncReconciliationDb = {
  syncCycle: { findMany: (args?: any) => Promise<any[]> };
  scheduledSyncPost: { findMany: (args?: any) => Promise<any[]> };
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
  syncClanReadinessSnapshot?: { findMany: (args?: any) => Promise<any[]> };
};

type BoundaryReport = {
  boundary: ProposedSyncBoundary;
  histories: AssociatedHistory[];
  syncMatch: number;
  syncCorrectable: number;
  syncAmbiguous: number;
  pointsMatch: number;
  pointsCorrectable: number;
  pointsAmbiguous: number;
  participationRows: number;
  existingBuckets: number[];
  correctableHistoryWarIds: number[];
  correctablePointWarIds: number[];
  ambiguousWarIds: number[];
  ambiguousCandidateSyncs: string[];
};

type ReconciledHistory = {
  row: AssociatedHistory;
  claim: HistoryClaimResult;
  pointsClaim: ReturnType<typeof classifyPointsSyncClaim>;
};

type RealizedHistoryIdentity = {
  expectedSyncNumber: number;
  classification: "HISTORY_SYNC_MATCH";
};

type ExactSnapshotEvidence = {
  guildId: string;
  syncTime: Date;
  scheduledSyncPostId: string | null;
};

export type DirectHistoryOwnership = "OWNED" | "UNOWNED_DIRECT_HISTORY" | "CONFLICTING_OWNERSHIP";

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

/** Purpose: parse the read-only operator command arguments. */
export function parseHistoricalSyncReconciliationArgs(argv: string[]): HistoricalSyncReconciliationArgs {
  let guildId = "";
  let fromSync: number | undefined;
  let toSync: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--guild" || token === "--from-sync" || token === "--to-sync") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--guild") guildId = value.trim();
      else if (token === "--from-sync") fromSync = parsePositive(value, token);
      else toSync = parsePositive(value, token);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!guildId) throw new Error("Usage: yarn diagnose:historical-sync-reconciliation --guild <guildId> [--from-sync <n>] [--to-sync <n>]");
  if (fromSync !== undefined && toSync !== undefined && fromSync > toSync) throw new Error("--from-sync must not exceed --to-sync");
  return { guildId, fromSync, toSync };
}

function date(value: unknown): Date | null {
  const result = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(result.getTime()) ? result : null;
}

function positive(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) && result > 0 ? result : null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function comparable(value: unknown): string {
  return text(value).toUpperCase();
}

function normalizePoint(row: any): ReconciliationPoint | null {
  const guildId = text(row?.guildId);
  const syncNumber = positive(row?.syncNum);
  const warStartTime = date(row?.warStartTime);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const opponentTag = normalizeMembershipHistoryClanTag(row?.opponentTag);
  if (!guildId || !syncNumber || !warStartTime || !clanTag || !opponentTag) return null;
  return {
    guildId,
    syncNumber,
    warId: positive(row?.warId),
    clanTag,
    warStartTime,
    opponentTag,
    isFwa: row?.isFwa === true || comparable(row?.matchType) === "FWA",
  };
}

function normalizeHistory(row: any): ReconciliationHistory | null {
  const warId = positive(row?.warId);
  const warStartTime = date(row?.warStartTime);
  const warEndTime = date(row?.warEndTime);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  if (!warId || !warStartTime || !warEndTime || !clanTag || comparable(row?.matchType) !== "FWA") return null;
  return {
    warId,
    syncNumber: positive(row?.syncNumber),
    matchType: comparable(row?.matchType),
    clanTag,
    opponentTag: row?.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag),
    warStartTime,
    prepStartTime: date(row?.prepStartTime),
    warEndTime,
  };
}

function normalizeEvaluation(row: any): ReconciliationEvaluation | null {
  const warId = positive(row?.warId);
  const guildId = text(row?.guildId);
  const history = row?.warHistory;
  if (!warId || !guildId) return null;
  return {
    guildId,
    warId,
    clanTag: history?.clanTag == null ? null : normalizeMembershipHistoryClanTag(history.clanTag),
    matchType: comparable(row?.matchType ?? history?.matchType),
  };
}

function normalizeParticipation(row: any): ReconciliationParticipation | null {
  const guildId = text(row?.guildId);
  const warId = positive(row?.warId);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const playerTag = text(row?.playerTag);
  if (!guildId || !warId || !clanTag || !playerTag) return null;
  return { guildId, warId, clanTag, playerTag, matchType: comparable(row?.matchType) };
}

/** Purpose: establish target-guild ownership after direct history discovery using persisted semantic evidence. */
export function classifyDirectHistoryOwnership(input: {
  history: ReconciliationHistory;
  targetGuildId: string;
  participation: readonly ReconciliationParticipation[];
  points: readonly ReconciliationPoint[];
  evaluations: readonly ReconciliationEvaluation[];
}): DirectHistoryOwnership {
  const ownerGuilds = new Set<string>();
  for (const row of input.participation) {
    if (row.warId === input.history.warId && normalizeMembershipHistoryClanTag(row.clanTag) === normalizeMembershipHistoryClanTag(input.history.clanTag)) {
      ownerGuilds.add(row.guildId);
    }
  }
  for (const point of input.points) {
    if (point.guildId && point.isFwa && historicalHistoryMatchesPointByExactTuple(input.history, point)) ownerGuilds.add(point.guildId);
  }
  for (const evaluation of input.evaluations) {
    if (evaluation.warId === input.history.warId &&
      (evaluation.clanTag === null || normalizeMembershipHistoryClanTag(evaluation.clanTag) === normalizeMembershipHistoryClanTag(input.history.clanTag)) &&
      comparable(evaluation.matchType) === "FWA") ownerGuilds.add(evaluation.guildId);
  }
  if (ownerGuilds.size > 1) return "CONFLICTING_OWNERSHIP";
  if (ownerGuilds.has(input.targetGuildId)) return "OWNED";
  return "UNOWNED_DIRECT_HISTORY";
}

function normalizeAnchor(row: any): ReconciliationAnchor | null {
  const guildId = text(row?.guildId);
  const syncNumber = positive(row?.syncNumber);
  const syncTime = date(row?.syncTime);
  if (!guildId || !syncNumber || !syncTime) return null;
  return { guildId, syncNumber, syncTime, source: text(row?.resolutionSource) || "unknown" };
}

function normalizeSchedule(row: any): ReconciliationSchedule | null {
  const id = text(row?.id);
  const guildId = text(row?.guildId);
  const syncTime = date(row?.syncTime);
  if (!id || !guildId || !syncTime) return null;
  return { id, guildId, syncTime, status: comparable(row?.status) };
}

function normalizeCycle(row: any): ReconciliationCycle | null {
  const guildId = text(row?.guildId);
  const syncNumber = positive(row?.syncNumber);
  const syncTime = date(row?.syncTime);
  if (!guildId || !syncNumber || !syncTime) return null;
  return { guildId, syncNumber, syncTime, scheduledSyncPostId: row?.scheduledSyncPostId == null ? null : text(row.scheduledSyncPostId) || null };
}

function normalizeSnapshot(row: any): ExactSnapshotEvidence | null {
  const guildId = text(row?.guildId);
  const syncTime = date(row?.syncTime);
  if (!guildId || !syncTime) return null;
  return { guildId, syncTime, scheduledSyncPostId: row?.scheduledSyncPostId == null ? null : text(row.scheduledSyncPostId) || null };
}

function uniqueHistories(rows: ReconciliationHistory[]): ReconciliationHistory[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.warId}|${row.clanTag}|${row.warStartTime.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readInputs(db: HistoricalSyncReconciliationDb, args: HistoricalSyncReconciliationArgs) {
  const cycleSelect = { guildId: true, syncNumber: true, syncTime: true, scheduledSyncPostId: true, resolutionSource: true };
  let rawCycles: any[];
  if (args.fromSync === undefined && args.toSync === undefined) {
    rawCycles = await db.syncCycle.findMany({
      where: { guildId: args.guildId },
      orderBy: [{ syncNumber: "asc" }, { syncTime: "asc" }],
      select: cycleSelect,
    });
  } else {
    const lowerRows = args.fromSync !== undefined
      ? await db.syncCycle.findMany({
          where: { guildId: args.guildId, syncNumber: { lte: args.fromSync } },
          orderBy: [{ syncNumber: "desc" }, { syncTime: "desc" }],
          take: 1,
          select: cycleSelect,
        })
      : [];
    const upperRows = args.toSync !== undefined
      ? await db.syncCycle.findMany({
          where: { guildId: args.guildId, syncNumber: { gte: args.toSync } },
          orderBy: [{ syncNumber: "asc" }, { syncTime: "asc" }],
          take: 1,
          select: cycleSelect,
        })
      : [];
    const lower = lowerRows[0];
    const upper = upperRows[0];
    if ((args.fromSync !== undefined && !lower) || (args.toSync !== undefined && !upper)) {
      return { anchors: [], cycles: [], schedules: [], points: [], histories: [], unownedHistories: [], conflictingHistories: [], evaluations: [], participation: [], intervals: [], exactBoundaries: [], snapshots: [] };
    }
    const rangeWhere = {
      guildId: args.guildId,
      syncNumber: {
        ...(lower ? { gte: lower.syncNumber } : {}),
        ...(upper ? { lte: upper.syncNumber } : {}),
      },
    };
    const rangeRows = await db.syncCycle.findMany({
      where: rangeWhere,
      orderBy: [{ syncNumber: "asc" }, { syncTime: "asc" }],
      select: cycleSelect,
    });
    const byIdentity = new Map<string, any>();
    for (const row of [...lowerRows, ...upperRows, ...rangeRows]) {
      byIdentity.set(`${row.guildId}|${row.syncNumber}|${new Date(row.syncTime).getTime()}`, row);
    }
    rawCycles = [...byIdentity.values()];
  }
  const cycles = rawCycles
    .map(normalizeCycle)
    .filter((row): row is ReconciliationCycle => Boolean(row))
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());
  const anchors = rawCycles
    .map(normalizeAnchor)
    .filter((row): row is ReconciliationAnchor => Boolean(row))
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());

  if (anchors.length < 2) {
    return { anchors, cycles, schedules: [], points: [], histories: [], unownedHistories: [], conflictingHistories: [], evaluations: [], participation: [], intervals: [], exactBoundaries: [], snapshots: [] };
  }

  const firstAnchorTime = anchors[0].syncTime.getTime();
  const lastAnchorTime = anchors[anchors.length - 1].syncTime.getTime();
  const boundedAnchorRead = args.fromSync !== undefined || args.toSync !== undefined;
  const rawSchedules = await db.scheduledSyncPost.findMany({
    where: {
      guildId: args.guildId,
      syncTime: {
        gte: new Date(boundedAnchorRead ? firstAnchorTime : firstAnchorTime - HISTORICAL_SYNC_LOOKBACK_MS),
        lte: new Date(boundedAnchorRead ? lastAnchorTime : lastAnchorTime + HISTORICAL_SYNC_LOOKBACK_MS),
      },
    },
    orderBy: [{ syncTime: "asc" }, { id: "asc" }],
    select: { id: true, guildId: true, syncTime: true, status: true },
  });
  const schedules = rawSchedules
    .map(normalizeSchedule)
    .filter((row): row is ReconciliationSchedule => Boolean(row))
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
  const intervals = planAnchoredSequenceIntervals({
    anchors,
    schedules,
    existingCycles: cycles,
    guildId: args.guildId,
    fromSync: args.fromSync,
    toSync: args.toSync,
  });
  const exactBoundaries = intervals.flatMap((interval) => interval.mappings);

  const targetSyncNumbers = [...new Set([
    ...exactBoundaries.map((boundary) => boundary.syncNumber),
    ...intervals.flatMap((interval) => [interval.lower.syncNumber, interval.upper.syncNumber]),
  ])].sort((left, right) => left - right);
  const evidenceStart = firstAnchorTime;
  const evidenceEnd = lastAnchorTime;
  const evidenceTime = { gte: new Date(evidenceStart), lt: new Date(evidenceEnd) };
  const historyEvidenceTime = { gte: new Date(evidenceStart), lt: new Date(evidenceEnd + HISTORICAL_SYNC_LOOKBACK_MS) };
  const [rawPoints, rawEvaluations] = await Promise.all([
    db.clanPointsSync.findMany({
      where: { guildId: args.guildId, OR: [{ syncNum: { in: targetSyncNumbers } }, { warStartTime: evidenceTime }] },
      orderBy: [{ syncNum: "asc" }, { warStartTime: "asc" }, { warId: "asc" }],
      select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true },
    }),
    db.warPlanComplianceEvaluation.findMany({
      where: {
        guildId: args.guildId,
        warHistory: {
          matchType: "FWA",
          OR: [{ syncNumber: { in: targetSyncNumbers } }, { warStartTime: evidenceTime }],
        },
      },
      orderBy: [{ warId: "asc" }],
      select: { guildId: true, warId: true, matchType: true, warHistory: { select: { clanTag: true, matchType: true } } },
    }),
  ]);
  const targetPoints = rawPoints.map(normalizePoint).filter((row): row is ReconciliationPoint => Boolean(row));
  const evaluations = rawEvaluations.map(normalizeEvaluation).filter((row): row is ReconciliationEvaluation => Boolean(row));
  const targetRawWarIds = [...new Set(targetPoints.map((point) => point.warId).filter((warId): warId is number => warId !== null))];
  const semanticTuples = targetPoints.map((point) => ({
    warStartTime: point.warStartTime,
    clanTag: point.clanTag,
    opponentTag: point.opponentTag,
  }));
  const candidateWarIds = [...new Set([...targetRawWarIds, ...evaluations.map((evaluation) => evaluation.warId)])];
  const rawOwnershipEvaluations = candidateWarIds.length > 0
    ? await db.warPlanComplianceEvaluation.findMany({
        where: { warId: { in: candidateWarIds } },
        orderBy: [{ warId: "asc" }, { guildId: "asc" }],
        select: { guildId: true, warId: true, matchType: true, warHistory: { select: { clanTag: true, matchType: true } } },
      })
    : [];
  const ownershipEvaluations = rawOwnershipEvaluations.map(normalizeEvaluation).filter((row): row is ReconciliationEvaluation => Boolean(row));
  const allEvaluations = [...new Map([...evaluations, ...ownershipEvaluations]
    .map((evaluation) => [`${evaluation.guildId}|${evaluation.warId}`, evaluation] as const)).values()];
  const historyWhere = [
    ...(candidateWarIds.length > 0 ? [{ warId: { in: candidateWarIds } }] : []),
    ...semanticTuples,
  ];
  const [rawCrossGuildPoints, rawOwnershipPoints, rawHistories, rawDirectHistories] = await Promise.all([
    targetRawWarIds.length > 0
      ? db.clanPointsSync.findMany({
          where: { warId: { in: targetRawWarIds.map(String) } },
          orderBy: [{ warId: "asc" }, { guildId: "asc" }, { syncNum: "asc" }],
          select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true },
        })
      : Promise.resolve([]),
    semanticTuples.length > 0
      ? db.clanPointsSync.findMany({
          where: { OR: semanticTuples },
          orderBy: [{ warStartTime: "asc" }, { guildId: "asc" }, { syncNum: "asc" }],
          select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true },
        })
      : Promise.resolve([]),
    historyWhere.length > 0
      ? db.clanWarHistory.findMany({
          where: { OR: historyWhere },
          orderBy: [{ warId: "asc" }],
          select: { warId: true, syncNumber: true, matchType: true, clanTag: true, opponentTag: true, prepStartTime: true, warStartTime: true, warEndTime: true },
        })
      : Promise.resolve([]),
    db.clanWarHistory.findMany({
      where: { matchType: "FWA", warEndTime: { not: null }, OR: [{ prepStartTime: historyEvidenceTime }, { warStartTime: historyEvidenceTime }] },
      orderBy: [{ prepStartTime: "asc" }, { warId: "asc" }],
      select: { warId: true, syncNumber: true, matchType: true, clanTag: true, opponentTag: true, prepStartTime: true, warStartTime: true, warEndTime: true },
    }),
  ]);
  const points = [...new Map([...targetPoints, ...rawCrossGuildPoints.map(normalizePoint).filter((row): row is ReconciliationPoint => Boolean(row))]
    .map((point) => [`${point.guildId}|${point.syncNumber}|${point.warId ?? "null"}|${point.clanTag}|${point.warStartTime.getTime()}|${point.opponentTag}`, point])).values()];
  const discoveredHistories = uniqueHistories([...rawDirectHistories, ...rawHistories]
    .map(normalizeHistory)
    .filter((row): row is ReconciliationHistory => Boolean(row)));
  const participationWarIds = [...new Set(discoveredHistories.map((history) => history.warId))];
  const rawParticipation = participationWarIds.length > 0
    ? await db.clanWarParticipation.findMany({
        where: { guildId: args.guildId, warId: { in: participationWarIds.map(String) } },
        orderBy: [{ warId: "asc" }, { playerTag: "asc" }],
        select: { guildId: true, warId: true, clanTag: true, playerTag: true, matchType: true },
      })
    : [];
  const participation = rawParticipation.map(normalizeParticipation).filter((row): row is ReconciliationParticipation => Boolean(row));
  const rawOwnershipParticipation = participationWarIds.length > 0
    ? await db.clanWarParticipation.findMany({
        where: { warId: { in: participationWarIds.map(String) } },
        orderBy: [{ warId: "asc" }, { guildId: "asc" }, { playerTag: "asc" }],
        select: { guildId: true, warId: true, clanTag: true, playerTag: true, matchType: true },
      })
    : [];
  const ownershipParticipation = rawOwnershipParticipation.map(normalizeParticipation).filter((row): row is ReconciliationParticipation => Boolean(row));
  const ownershipPoints = rawOwnershipPoints.map(normalizePoint).filter((row): row is ReconciliationPoint => Boolean(row));
  const ownedHistories: ReconciliationHistory[] = [];
  const unownedHistories: Array<{ history: ReconciliationHistory; ownership: DirectHistoryOwnership }> = [];
  const conflictingHistories: ReconciliationHistory[] = [];
  for (const history of discoveredHistories) {
    const ownership = classifyDirectHistoryOwnership({
      history,
      targetGuildId: args.guildId,
      participation: ownershipParticipation,
      points: [...points, ...ownershipPoints],
      evaluations: allEvaluations,
    });
    if (ownership === "OWNED") ownedHistories.push(history);
    else {
      unownedHistories.push({ history, ownership });
      if (ownership === "CONFLICTING_OWNERSHIP") conflictingHistories.push(history);
    }
  }
  const snapshots = db.syncClanReadinessSnapshot
    ? [...new Map((await db.syncClanReadinessSnapshot.findMany({
        where: { guildId: args.guildId, syncTime: historyEvidenceTime },
        orderBy: [{ syncTime: "asc" }, { clanTag: "asc" }],
        select: { guildId: true, syncTime: true, scheduledSyncPostId: true },
      })).map(normalizeSnapshot).filter((row): row is ExactSnapshotEvidence => Boolean(row))
        .map((snapshot) => [`${snapshot.guildId}|${snapshot.syncTime.getTime()}|${snapshot.scheduledSyncPostId ?? "null"}`, snapshot] as const)).values()]
    : [];
  return { anchors, cycles, schedules, points, histories: ownedHistories, unownedHistories, conflictingHistories, evaluations: allEvaluations, participation, intervals, exactBoundaries, snapshots };
}

function relatedHistories(boundary: ProposedSyncBoundary, associated: readonly AssociatedHistory[]): AssociatedHistory[] {
  return associated.filter((row) => {
    const prep = row.history.prepStartTime?.getTime();
    if (prep === undefined || !Number.isFinite(prep)) return false;
    const delta = prep - boundary.syncTime.getTime();
    return delta >= 0 && delta <= 24 * 60 * 60 * 1000;
  });
}

function participationForHistory(row: AssociatedHistory, participation: readonly ReconciliationParticipation[]): ReconciliationParticipation[] {
  return participation.filter((entry) =>
    entry.warId === row.history.warId &&
    normalizeMembershipHistoryClanTag(entry.clanTag) === normalizeMembershipHistoryClanTag(row.history.clanTag));
}

function historyIdentityKey(history: ReconciliationHistory): string {
  return `${history.warId}|${normalizeMembershipHistoryClanTag(history.clanTag)}|${history.warStartTime.getTime()}`;
}

function allCanonicalAssociatedHistories(
  histories: readonly ReconciliationHistory[],
  associated: readonly AssociatedHistory[],
): AssociatedHistory[] {
  const byIdentity = new Map(associated.map((row) => [historyIdentityKey(row.history), row]));
  return histories
    .filter((history) => comparable(history.matchType) === "FWA")
    .map((history) => byIdentity.get(historyIdentityKey(history)) ?? ({
      history,
      points: [],
      hasEvaluation: false,
      ambiguousReasons: [],
    }))
    .sort((left, right) => left.history.warId - right.history.warId || historyIdentityKey(left.history).localeCompare(historyIdentityKey(right.history)));
}

function historiesForInterval(interval: AnchorIntervalPlan, histories: readonly ReconciliationHistory[]): ReconciliationHistory[] {
  return histories.filter((history) => {
    const timing = history.prepStartTime?.getTime() ?? history.warStartTime.getTime();
    return timing >= interval.lower.syncTime.getTime() && timing <= interval.upper.syncTime.getTime() + HISTORICAL_SYNC_LOOKBACK_MS;
  });
}

function safeBoundariesFromSequences(sequences: readonly RealizedFwaSequencePlan[]): ProposedSyncBoundary[] {
  return sequences.filter((sequence) => sequence.classification === "REALIZED_SEQUENCE_CORROBORATED").flatMap((sequence) => sequence.cycles
    .filter((cycle) => cycle.expectedSyncNumber !== null && cycle.selectedSchedule !== null && ["EXACT_SYNC_CYCLE_CANDIDATE", "ALREADY_PRESENT"].includes(cycle.action))
    .map((cycle) => ({
      guildId: sequence.lower.guildId,
      syncNumber: cycle.expectedSyncNumber!,
      syncTime: cycle.selectedSchedule!.syncTime,
      scheduledSyncPostId: cycle.selectedSchedule!.id,
      lowerSyncNumber: sequence.lower.syncNumber,
      upperSyncNumber: sequence.upper.syncNumber,
    })));
}

function selectedRealizedScopeWindows(
  sequences: readonly RealizedFwaSequencePlan[],
  intervals: readonly AnchorIntervalPlan[],
  args: HistoricalSyncReconciliationArgs,
): ReconciliationHistoryScopeWindow[] {
  return intervals.flatMap((interval) => {
    const intervalSequence = sequences.find((sequence) =>
      sequence.lower.syncNumber === interval.lower.syncNumber && sequence.upper.syncNumber === interval.upper.syncNumber);
    const firstRequested = Math.max(interval.lower.syncNumber + 1, args.fromSync ?? interval.lower.syncNumber + 1);
    const lastRequested = Math.min(interval.upper.syncNumber - 1, args.toSync ?? interval.upper.syncNumber - 1);
    if (firstRequested > lastRequested) return [];

    if (intervalSequence?.classification !== "REALIZED_SEQUENCE_CORROBORATED") {
      if (args.fromSync !== undefined || args.toSync !== undefined) return [];
      const lowerContextEnd = intervalSequence?.lowerAnchorContextClusters
        .map((cluster) => cluster.prepMax?.getTime())
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => right - left)[0];
      const upperContextStart = intervalSequence?.upperAnchorContextClusters
        .map((cluster) => cluster.prepMin?.getTime())
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right)[0];
      const start = lowerContextEnd === undefined ? interval.lower.syncTime.getTime() : lowerContextEnd + 1;
      const end = upperContextStart ?? interval.upper.syncTime.getTime();
      return start < end ? [{ startTime: new Date(start), endTime: new Date(end) }] : [];
    }

    const selectedCycles = intervalSequence.cycles
      .filter((cycle) => cycle.expectedSyncNumber !== null && cycle.expectedSyncNumber >= firstRequested && cycle.expectedSyncNumber <= lastRequested);
    if (selectedCycles.length === 0) return [];
    const firstCycle = selectedCycles[0];
    const lastCycle = selectedCycles[selectedCycles.length - 1];
    const nextCycle = intervalSequence.cycles.find((cycle) => cycle.expectedSyncNumber !== null && cycle.expectedSyncNumber > lastCycle.expectedSyncNumber!);
    const upperContextPrep = intervalSequence.upperAnchorContextClusters
      .map((cluster) => cluster.prepMin?.getTime())
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)[0];
    const start = firstCycle.cluster.prepMin?.getTime() ?? interval.lower.syncTime.getTime();
    const end = nextCycle?.cluster.prepMin?.getTime() ?? upperContextPrep ?? interval.upper.syncTime.getTime();
    return [{ startTime: new Date(start), endTime: new Date(end) }];
  });
}

/** Purpose: use realized ended-history clusters as the sole authoritative history-to-sync identity map. */
function realizedHistoryIdentities(sequences: readonly RealizedFwaSequencePlan[]): Map<string, RealizedHistoryIdentity> {
  const identities = new Map<string, RealizedHistoryIdentity>();
  for (const sequence of sequences) {
    if (sequence.classification !== "REALIZED_SEQUENCE_CORROBORATED") continue;
    for (const cycle of sequence.cycles) {
      if (cycle.expectedSyncNumber === null || cycle.numberClassification !== "HISTORY_SYNC_MATCH" || cycle.cluster.reasons.length > 0) continue;
      for (const history of cycle.cluster.histories) {
        const key = historyIdentityKey(history);
        const previous = identities.get(key);
        if (previous && previous.expectedSyncNumber !== cycle.expectedSyncNumber) {
          identities.delete(key);
          continue;
        }
        if (!previous) identities.set(key, { expectedSyncNumber: cycle.expectedSyncNumber, classification: "HISTORY_SYNC_MATCH" });
      }
    }
  }
  return identities;
}

/** Purpose: classify canonical history and points claims from realized-cycle identity, never schedule ordinal mappings. */
function diagnosticBoundaryCandidates(history: ReconciliationHistory, boundaries: readonly ProposedSyncBoundary[]): ProposedSyncBoundary[] {
  const prep = history.prepStartTime?.getTime();
  if (prep === undefined || !Number.isFinite(prep)) return [];
  return boundaries.filter((boundary) => {
    const delta = prep - boundary.syncTime.getTime();
    return delta >= 0 && delta <= HISTORICAL_SYNC_LOOKBACK_MS;
  }).sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.syncNumber - right.syncNumber);
}

function classifyRealizedHistoryClaim(
  row: AssociatedHistory,
  identity: RealizedHistoryIdentity | undefined,
  diagnosticBoundaries: readonly ProposedSyncBoundary[],
): HistoryClaimResult {
  const reasons = new Set(row.ambiguousReasons);
  const candidates = diagnosticBoundaryCandidates(row.history, diagnosticBoundaries);
  if (!row.history.prepStartTime) reasons.add("missing_prep_start_time");
  if (!identity) reasons.add("no_unique_reconstructed_schedule");
  if (!identity || row.ambiguousReasons.length > 0) {
    if (!identity && candidates.length === 1) reasons.add("no_corroborated_realized_cycle_identity");
    return {
      classification: "SYNC_AMBIGUOUS",
      expectedSyncNumber: null,
      candidates,
      reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
    };
  }
  return {
    classification: row.history.syncNumber === identity.expectedSyncNumber ? "SYNC_MATCH" : "SYNC_CORRECTABLE",
    expectedSyncNumber: identity.expectedSyncNumber,
    candidates,
    reasons: row.history.syncNumber === identity.expectedSyncNumber ? [] : ["stored_history_sync_number_differs_from_realized_cycle"],
  };
}

function formatRealizedSequence(sequence: RealizedFwaSequencePlan, args: HistoricalSyncReconciliationArgs): string[] {
  const scope = sequence.classification === "REALIZED_SEQUENCE_CORROBORATED"
    ? "REALIZED_CLUSTER_PREP_WINDOWS"
    : args.fromSync === undefined && args.toSync === undefined
      ? "BROAD_AMBIGUOUS_INTERVAL_SCOPE"
      : "SUPPRESSED_AMBIGUOUS_INTERVAL_SCOPE";
  return [
    `lower=#${sequence.lower.syncNumber}@${sequence.lower.syncTime.toISOString()} upper=#${sequence.upper.syncNumber}@${sequence.upper.syncTime.toISOString()} expected_cycles=${sequence.expectedMissingSyncCount} realized_clusters=${sequence.realizedClusterCount} post_upper_context_clusters=${sequence.postUpperContextClusters.length} analysis_scope=${scope} classification=${sequence.classification} reasons=${formatList(sequence.reasons)}`,
  ];
}

function formatRealizedCycle(cycle: RealizedFwaCyclePlan, parentSequence: RealizedFwaSequencePlan["classification"]): string[] {
  const cluster = cycle.cluster;
  const candidates = cycle.scheduleCandidates.map((schedule) => `${schedule.id}@${schedule.syncTime.toISOString()}`);
  const candidateDeltas = cycle.scheduleCandidates.map((schedule) => {
    const minDelta = cluster.prepMin === null ? null : Math.round((cluster.prepMin.getTime() - schedule.syncTime.getTime()) / 1000);
    const maxDelta = cluster.prepMax === null ? null : Math.round((cluster.prepMax.getTime() - schedule.syncTime.getTime()) / 1000);
    return `${schedule.id}:${minDelta ?? "unknown"}..${maxDelta ?? "unknown"}`;
  });
  const writerActionable = parentSequence === "REALIZED_SEQUENCE_CORROBORATED" && cycle.action === "EXACT_SYNC_CYCLE_CANDIDATE";
  return [
    `expected_sync=${cycle.expectedSyncNumber === null ? "unknown" : `#${cycle.expectedSyncNumber}`} prep_min=${cluster.prepMin?.toISOString() ?? "unknown"} prep_max=${cluster.prepMax?.toISOString() ?? "unknown"} prep_center=${cluster.prepCenter?.toISOString() ?? "unknown"} prep_spread_seconds=${cluster.spreadSeconds ?? "unknown"} prep_spread_minutes=${cluster.spreadMinutes ?? "unknown"} history_count=${cluster.canonicalHistoryCount} distinct_clans=${cluster.distinctClanCount} participation_rows=${cluster.participationRowCount} distinct_players=${cluster.distinctPlayerCount} stored_history_syncs=${formatList(cluster.persistedSyncNumbers)} number_classification=${cycle.numberClassification} schedule_candidates=${formatList(candidates)} schedule_candidate_delta_seconds=${formatList(candidateDeltas)} action=${cycle.action} parent_sequence=${parentSequence} safe_for_apply=${writerActionable} already_present=${cycle.action === "ALREADY_PRESENT"} writer_actionable=${writerActionable} reasons=${formatList(cycle.reasons)}`,
    `  canonical_war_ids=${formatList(cluster.canonicalWarIds)} selected_schedule=${cycle.selectedSchedule ? `${cycle.selectedSchedule.id}@${cycle.selectedSchedule.syncTime.toISOString()}` : "none"}`,
  ];
}

function exactSnapshotCandidates(cluster: RealizedFwaCyclePlan["cluster"], snapshots: readonly ExactSnapshotEvidence[]): string[] {
  const seen = new Set<string>();
  return snapshots
    .filter((snapshot) => cluster.histories.length > 0 && cluster.histories.every((history) => {
      const prep = history.prepStartTime?.getTime();
      if (prep === undefined || !Number.isFinite(prep)) return false;
      const delta = prep - snapshot.syncTime.getTime();
      return delta >= 0 && delta <= HISTORICAL_SYNC_LOOKBACK_MS;
    }))
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || (left.scheduledSyncPostId ?? "").localeCompare(right.scheduledSyncPostId ?? ""))
    .map((snapshot) => `SYNC_CLAN_READINESS_SNAPSHOT: time=${snapshot.syncTime.toISOString()} scheduledSyncPostId=${snapshot.scheduledSyncPostId ?? "none"}`)
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

function unresolvedExpectedNumbers(
  sequences: readonly RealizedFwaSequencePlan[],
  args: HistoricalSyncReconciliationArgs,
): number[] {
  return sequences.flatMap((sequence) => {
    const expected = Array.from({ length: sequence.expectedMissingSyncCount }, (_unused, index) => sequence.lower.syncNumber + index + 1);
    const resolved = new Set((sequence.classification === "REALIZED_SEQUENCE_CORROBORATED" ? sequence.cycles : [])
      .filter((cycle) => cycle.expectedSyncNumber !== null && ["EXACT_SYNC_CYCLE_CANDIDATE", "ALREADY_PRESENT"].includes(cycle.action))
      .map((cycle) => cycle.expectedSyncNumber!));
    return expected.filter((syncNumber) => !resolved.has(syncNumber));
  })
    .filter((syncNumber) => args.fromSync === undefined || syncNumber >= args.fromSync)
    .filter((syncNumber) => args.toSync === undefined || syncNumber <= args.toSync)
    .sort((left, right) => left - right);
}

function realizedHistoryClassificationCounts(sequences: readonly RealizedFwaSequencePlan[]): Record<string, number> {
  const counts: Record<string, number> = {
    HISTORY_SYNC_MATCH: 0,
    HISTORY_SYNC_DISAGREEMENT: 0,
    HISTORY_SYNC_NULL: 0,
    HISTORY_SYNC_MIXED: 0,
  };
  for (const sequence of sequences) {
    for (const cycle of sequence.cycles) counts[cycle.numberClassification] += 1;
  }
  return counts;
}

function buildBoundaryReport(boundary: ProposedSyncBoundary, reconciled: readonly ReconciledHistory[], participation: readonly ReconciliationParticipation[]): BoundaryReport {
  const rows = reconciled.filter(({ row }) => relatedHistories(boundary, [row]).length > 0);
  const histories = rows.map(({ row }) => row);
  let syncMatch = 0;
  let syncCorrectable = 0;
  let syncAmbiguous = 0;
  let pointsMatch = 0;
  let pointsCorrectable = 0;
  let pointsAmbiguous = 0;
  const existingBuckets = new Set<number>();
  const correctableHistoryWarIds: number[] = [];
  const correctablePointWarIds: number[] = [];
  const ambiguousWarIds: number[] = [];
  const ambiguousCandidateSyncs: string[] = [];
  let participationRows = 0;
  for (const { row, claim, pointsClaim } of rows) {
    if (row.history.syncNumber !== null) existingBuckets.add(row.history.syncNumber);
    for (const point of row.points) existingBuckets.add(point.syncNumber);
    if (claim.classification === "SYNC_MATCH") syncMatch += 1;
    else if (claim.classification === "SYNC_CORRECTABLE") { syncCorrectable += 1; correctableHistoryWarIds.push(row.history.warId); }
    else {
      syncAmbiguous += 1;
      ambiguousWarIds.push(row.history.warId);
      ambiguousCandidateSyncs.push(`${row.history.warId}=>${formatList(claim.candidates.map((candidate) => `#${candidate.syncNumber}`))}`);
    }
    if (pointsClaim.classification === "POINTS_MATCH") pointsMatch += 1;
    else if (pointsClaim.classification === "POINTS_CORRECTABLE") { pointsCorrectable += 1; correctablePointWarIds.push(row.history.warId); }
    else pointsAmbiguous += 1;
    participationRows += participation.filter((entry) => entry.warId === row.history.warId && normalizeMembershipHistoryClanTag(entry.clanTag) === normalizeMembershipHistoryClanTag(row.history.clanTag)).length;
  }
  return {
    boundary,
    histories,
    syncMatch,
    syncCorrectable,
    syncAmbiguous,
    pointsMatch,
    pointsCorrectable,
    pointsAmbiguous,
    participationRows,
    existingBuckets: [...existingBuckets].sort((left, right) => left - right),
    correctableHistoryWarIds: correctableHistoryWarIds.sort((left, right) => left - right),
    correctablePointWarIds: correctablePointWarIds.sort((left, right) => left - right),
    ambiguousWarIds: ambiguousWarIds.sort((left, right) => left - right),
    ambiguousCandidateSyncs: ambiguousCandidateSyncs.sort((left, right) => left.localeCompare(right)),
  };
}

function formatList(values: readonly (number | string)[]): string {
  return values.length > 0 ? values.join(",") : "-";
}

function mappingIsRequested(mapping: ProposedSyncBoundary, args: HistoricalSyncReconciliationArgs): boolean {
  return (args.fromSync === undefined || mapping.syncNumber >= args.fromSync) &&
    (args.toSync === undefined || mapping.syncNumber <= args.toSync);
}

function formatInterval(plan: AnchorIntervalPlan, displayedMappings: readonly ProposedSyncBoundary[] = plan.mappings): string[] {
  return [
    `DIAGNOSTIC ONLY — NOT SAFE IDENTITY | lower=#${plan.lower.syncNumber}@${plan.lower.syncTime.toISOString()} upper=#${plan.upper.syncNumber}@${plan.upper.syncTime.toISOString()} expected_missing=${plan.expectedMissingSyncCount} eligible_schedules=${plan.eligibleScheduleCount} classification=${plan.classification} schedule_count_classification=${plan.classification} reasons=${formatList(plan.reasons)}`,
    `  proof_context_schedule_ids=${formatList(plan.eligibleSchedules.map((schedule) => schedule.id))}`,
    ...displayedMappings
      .filter((mapping) => mapping.lowerSyncNumber === plan.lower.syncNumber && mapping.upperSyncNumber === plan.upper.syncNumber)
      .map((mapping) => `  safe_realized_boundary=#${mapping.syncNumber} -> ${mapping.syncTime.toISOString()} scheduled_sync_post_id=${mapping.scheduledSyncPostId}`),
  ];
}

function longestRun(numbers: readonly number[]): { start: number | null; end: number | null; length: number } {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  let best = { start: null as number | null, end: null as number | null, length: 0 };
  let start = sorted[0];
  for (let index = 1; index <= sorted.length; index += 1) {
    if (index < sorted.length && sorted[index] === sorted[index - 1] + 1) continue;
    if (start !== undefined) {
      const end = sorted[index - 1];
      if (end - start + 1 > best.length) best = { start, end, length: end - start + 1 };
    }
    start = sorted[index];
  }
  return best;
}

function patternLines(reports: readonly BoundaryReport[], reconciled: readonly ReconciledHistory[]): string[] {
  const lines: string[] = [];
  const offsets = reconciled.flatMap(({ row, claim }) => {
    return claim.expectedSyncNumber !== null && row.history.syncNumber !== null ? [row.history.syncNumber - claim.expectedSyncNumber] : [];
  });
  if (offsets.length > 0 && offsets.every((offset) => offset === -1)) lines.push("consistent_stored_sync_number=canonical-1");
  if (offsets.length > 0 && offsets.every((offset) => offset === 1)) lines.push("consistent_stored_sync_number=canonical+1");
  if (new Set(offsets).size > 1) lines.push("mixed_adjacent_persisted_sync_buckets");
  if (reconciled.some(({ row }) => row.ambiguousReasons.includes("raw_war_identity_claimed_by_multiple_sync_owners"))) lines.push("one_raw_war_identity_claimed_by_multiple_sync_buckets");
  if (reports.some((report) => report.existingBuckets.length > 1)) lines.push("one_true_schedule_contains_histories_split_across_persisted_buckets");
  if (reconciled.some(({ row, claim }) => row.history.syncNumber !== null && claim.expectedSyncNumber === row.history.syncNumber && row.points.some((point) => point.syncNumber !== row.history.syncNumber))) lines.push("canonical_history_sync_correct_but_points_sync_stale");
  if (reconciled.some(({ row }) => row.history.syncNumber === null)) lines.push("null_historical_sync_number");
  if (reports.some((report) => report.existingBuckets.length > 1)) lines.push("histories_split_across_adjacent_persisted_sync_numbers");
  return lines.length > 0 ? lines : ["none"];
}

function formatUnmappedAmbiguities(
  reconciled: readonly ReconciledHistory[],
  participation: readonly ReconciliationParticipation[],
): string[] {
  const rows = reconciled
    .filter(({ claim }) => claim.classification === "SYNC_AMBIGUOUS" && claim.candidates.length === 0)
    .sort((left, right) => left.row.history.warId - right.row.history.warId);
  if (rows.length === 0) return ["UNMAPPED IN-SCOPE AMBIGUITIES", "none"];
  return [
    "UNMAPPED IN-SCOPE AMBIGUITIES",
    ...rows.flatMap(({ row, claim }) => {
      const points = [...new Set(row.points.map((point) => point.syncNumber))].sort((left, right) => left - right);
      const participationRows = participationForHistory(row, participation).length;
      return [
        `war_id=${row.history.warId} reasons=${formatList(claim.reasons)} stored_history_sync=${row.history.syncNumber ?? "null"} points_sync_claims=${formatList(points)} participation_rows=${participationRows}`,
      ];
    }),
  ];
}

/** Purpose: execute the complete read-only reconciliation and return deterministic operator text. */
export async function runHistoricalSyncReconciliation(
  args: HistoricalSyncReconciliationArgs,
  db: HistoricalSyncReconciliationDb = prisma as unknown as HistoricalSyncReconciliationDb,
): Promise<string> {
  const inputs = await readInputs(db, args);
  const intervals = inputs.intervals;
  const realizedSequences = intervals.map((interval) => corroborateRealizedFwaSequence({
    lower: interval.lower,
    upper: interval.upper,
    histories: historiesForInterval(interval, inputs.histories),
    conflictingHistories: historiesForInterval(interval, inputs.conflictingHistories),
    participation: inputs.participation,
    schedules: inputs.schedules,
    existingCycles: inputs.cycles,
  }));
  const realizedBoundaries = safeBoundariesFromSequences(realizedSequences);
  const realizedIdentities = realizedHistoryIdentities(realizedSequences);
  const diagnosticBoundaries = intervals
    .filter((interval) => interval.classification === "ANCHORED_SEQUENCE_EXACT")
    .flatMap((interval) => interval.mappings);
  const selectedAnalysisBoundaries = realizedBoundaries
    .filter((mapping) => mappingIsRequested(mapping, args))
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());
  const scopeWindows = selectedRealizedScopeWindows(realizedSequences, intervals, args);
  const associated = allCanonicalAssociatedHistories(inputs.histories, associateCanonicalHistories({
    guildId: args.guildId,
    histories: inputs.histories,
    points: inputs.points,
    evaluations: inputs.evaluations,
  }));
  const scopedAssociated = associated.filter((row) => classifyReconciliationHistoryScope({
    history: row.history,
    boundaries: selectedAnalysisBoundaries,
    intervals,
    scopeWindows,
  }) === "IN_SCOPE");
  const reconciled: ReconciledHistory[] = scopedAssociated.map((row) => {
    const claim = classifyRealizedHistoryClaim(row, realizedIdentities.get(historyIdentityKey(row.history)), diagnosticBoundaries);
    return { row, claim, pointsClaim: classifyPointsSyncClaim({ expectedSyncNumber: claim.expectedSyncNumber, associated: row }) };
  });
  const uniqueMapped = reconciled.filter(({ claim }) => claim.classification !== "SYNC_AMBIGUOUS");
  const reports = selectedAnalysisBoundaries.map((boundary) => buildBoundaryReport(boundary, reconciled, inputs.participation));
  const allSyncMatch = reconciled.filter(({ claim }) => claim.classification === "SYNC_MATCH").length;
  const allSyncCorrectable = reconciled.filter(({ claim }) => claim.classification === "SYNC_CORRECTABLE").length;
  const allSyncAmbiguous = reconciled.filter(({ claim }) => claim.classification === "SYNC_AMBIGUOUS").length;
  const allPointsMatch = reconciled.filter(({ pointsClaim }) => pointsClaim.classification === "POINTS_MATCH").length;
  const allPointsCorrectable = reconciled.filter(({ pointsClaim }) => pointsClaim.classification === "POINTS_CORRECTABLE").length;
  const allPointsAmbiguous = reconciled.filter(({ pointsClaim }) => pointsClaim.classification === "POINTS_AMBIGUOUS").length;
  const realizedHistoryCounts = realizedHistoryClassificationCounts(realizedSequences);
  const requestedMissingNumbers = realizedSequences.flatMap((sequence) =>
    Array.from({ length: sequence.expectedMissingSyncCount }, (_unused, index) => sequence.lower.syncNumber + index + 1),
  )
    .filter((syncNumber) => args.fromSync === undefined || syncNumber >= args.fromSync)
    .filter((syncNumber) => args.toSync === undefined || syncNumber <= args.toSync)
    .sort((left, right) => left - right);
  const existingNumbers = inputs.anchors.map((anchor) => anchor.syncNumber);
  const exactCandidateSyncNumbers = new Set(realizedSequences.filter((sequence) => sequence.classification === "REALIZED_SEQUENCE_CORROBORATED").flatMap((sequence) => sequence.cycles
    .filter((cycle) => cycle.action === "EXACT_SYNC_CYCLE_CANDIDATE" && cycle.expectedSyncNumber !== null)
    .map((cycle) => cycle.expectedSyncNumber!)));
  const selectedExactCandidateNumbers = selectedAnalysisBoundaries
    .map((boundary) => boundary.syncNumber)
    .filter((syncNumber) => exactCandidateSyncNumbers.has(syncNumber));
  const run = longestRun([...existingNumbers, ...selectedExactCandidateNumbers]);
  const exactTimes = selectedAnalysisBoundaries
    .filter((boundary) => exactCandidateSyncNumbers.has(boundary.syncNumber))
    .map((boundary) => boundary.syncTime.getTime())
    .sort((left, right) => left - right);
  const participationBackedSyncNumbers = new Set<number>();
  const playerBoundaryFactsSet = new Set<string>();
  uniqueMapped.filter(({ claim }) => claim.expectedSyncNumber !== null && exactCandidateSyncNumbers.has(claim.expectedSyncNumber)).forEach(({ row, claim }) => {
    const expectedSyncNumber = claim.expectedSyncNumber;
    if (expectedSyncNumber === null || expectedSyncNumber === undefined) return;
    for (const entry of participationForHistory(row, inputs.participation)) {
      participationBackedSyncNumbers.add(expectedSyncNumber);
      playerBoundaryFactsSet.add(`${expectedSyncNumber}|${entry.playerTag}`);
    }
  });
  const additionalParticipationHistories = participationBackedSyncNumbers.size;
  const playerBoundaryFacts = playerBoundaryFactsSet.size;
  const intervalLines = intervals.flatMap((interval) => formatInterval(interval, selectedAnalysisBoundaries));
  const realizedSequenceLines = realizedSequences.flatMap((sequence) => formatRealizedSequence(sequence, args));
  const realizedCycleLines = realizedSequences.flatMap((sequence) => sequence.cycles.flatMap((cycle) => formatRealizedCycle(cycle, sequence.classification)));
  const safePlanLines = realizedSequences.filter((sequence) => sequence.classification === "REALIZED_SEQUENCE_CORROBORATED").flatMap((sequence) => sequence.cycles
    .filter((cycle) => cycle.expectedSyncNumber !== null && mappingIsRequested({
      guildId: sequence.lower.guildId,
      syncNumber: cycle.expectedSyncNumber,
      syncTime: cycle.selectedSchedule?.syncTime ?? sequence.lower.syncTime,
      scheduledSyncPostId: cycle.selectedSchedule?.id ?? "",
      lowerSyncNumber: sequence.lower.syncNumber,
      upperSyncNumber: sequence.upper.syncNumber,
    }, args))
    .map((cycle) => {
      const snapshotEvidence = exactSnapshotCandidates(cycle.cluster, inputs.snapshots);
      return `#${cycle.expectedSyncNumber} action=${cycle.action} writer_actionable=${cycle.action === "EXACT_SYNC_CYCLE_CANDIDATE"} candidate_sync_time=${cycle.selectedSchedule?.syncTime.toISOString() ?? "none"} scheduled_sync_post_id=${cycle.selectedSchedule?.id ?? "none"} canonical_history_count=${cycle.cluster.canonicalHistoryCount} participation_rows=${cycle.cluster.participationRowCount} exact_source_candidates=${formatList(snapshotEvidence)} reasons=${formatList(cycle.reasons)}`;
    }));
  const unusedScheduleLines = realizedSequences.flatMap((sequence) => sequence.unusedEligibleSchedules.map((schedule) =>
    `schedule_id=${schedule.id} sync_time=${schedule.syncTime.toISOString()} status=${schedule.status} reason=SCHEDULE_WITHOUT_REALIZED_FWA_CLUSTER`));
  const ambiguousScheduleLines = realizedSequences.flatMap((sequence) => sequence.ambiguousScheduleCandidates.map((schedule) =>
    `schedule_id=${schedule.id} sync_time=${schedule.syncTime.toISOString()} status=${schedule.status} reason=AMBIGUOUS_REALIZED_SCHEDULE_CANDIDATE`));
  const unresolvedRealizedNumbers = unresolvedExpectedNumbers(realizedSequences, args);
  const unmappedLines = formatUnmappedAmbiguities(reconciled, inputs.participation);
  const boundaryLines = reports.flatMap((report) => [
    `#${report.boundary.syncNumber} scheduledSyncPost=${report.boundary.scheduledSyncPostId} time=${report.boundary.syncTime.toISOString()} canonical_fwa_histories=${report.histories.length} existing_persisted_buckets=${formatList(report.existingBuckets)} sync_match=${report.syncMatch} sync_correctable=${report.syncCorrectable} sync_ambiguous=${report.syncAmbiguous} points_match=${report.pointsMatch} points_correctable=${report.pointsCorrectable} points_ambiguous=${report.pointsAmbiguous} participation_rows=${report.participationRows}`,
    `  correctable_history_war_ids=${formatList(report.correctableHistoryWarIds)} correctable_points_war_ids=${formatList(report.correctablePointWarIds)} ambiguous_war_ids=${formatList(report.ambiguousWarIds)} ambiguous_candidate_syncs=${formatList(report.ambiguousCandidateSyncs)}`,
  ]);
  const special = [
    [520, 522],
    [526, 548],
  ].map(([lower, upper]) => intervals.find((interval) => interval.lower.syncNumber === lower && interval.upper.syncNumber === upper));
  const scopedAnchors = inputs.anchors.filter((anchor) => anchor.guildId === args.guildId);
  const terminalAnchors = scopedAnchors.length <= 1
    ? scopedAnchors
    : [scopedAnchors[0], scopedAnchors[scopedAnchors.length - 1]];
  const adjacent = terminalAnchors.map((anchor) => {
    const nearby = inputs.schedules
      .filter((schedule) => schedule.guildId === args.guildId && !["CANCELLED", "REPLACED"].includes(comparable(schedule.status)))
      .filter((schedule) => Math.abs(schedule.syncTime.getTime() - anchor.syncTime.getTime()) <= 24 * 60 * 60 * 1000 && schedule.syncTime.getTime() !== anchor.syncTime.getTime())
      .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
    return `anchor=#${anchor.syncNumber} adjacent_schedule_diagnostics_only before_or_after=${formatList(nearby.map((schedule) => `${schedule.id}@${schedule.syncTime.toISOString()}`))} no_number_assigned`;
  });
  return [
    "READ ONLY — no database mutations will be performed.",
    `guild=${args.guildId}`,
    "",
    "CANONICAL ANCHORS",
    ...inputs.anchors.map((anchor) => `#${anchor.syncNumber} | ${anchor.syncTime.toISOString()} | ${anchor.source}`),
    "",
    "ANCHOR INTERVALS",
    ...(intervalLines.length > 0 ? intervalLines : ["none"]),
    "",
    "REALIZED FWA SEQUENCES",
    ...(realizedSequenceLines.length > 0 ? realizedSequenceLines : ["none"]),
    "",
    "REALIZED FWA CYCLES",
    ...(realizedCycleLines.length > 0 ? realizedCycleLines : ["none"]),
    "",
    "UNREALIZED / UNASSIGNED SCHEDULES",
    ...(unusedScheduleLines.length > 0 ? unusedScheduleLines : ["none"]),
    "",
    "AMBIGUOUS REALIZED SCHEDULE CANDIDATES",
    ...(ambiguousScheduleLines.length > 0 ? ambiguousScheduleLines : ["none"]),
    "",
    "SAFE SYNC-CYCLE PLAN",
    ...(safePlanLines.length > 0 ? safePlanLines : ["none"]),
    `unresolved_missing_sync_numbers=${formatList(unresolvedRealizedNumbers)}`,
    "",
    "PROPOSED BOUNDARIES",
    ...(boundaryLines.length > 0 ? boundaryLines : ["none"]),
    "",
    ...unmappedLines,
    "",
    "UNOWNED / CONFLICTING DIRECT HISTORIES",
    ...(inputs.unownedHistories.length > 0
      ? inputs.unownedHistories.map(({ history, ownership }) => `war_id=${history.warId} ownership=${ownership} war_start=${history.warStartTime.toISOString()}`)
      : ["none"]),
    "",
    "SPECIAL WINDOWS",
    ...special.flatMap((interval, index) => interval ? [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: ${interval.classification} expected=${interval.expectedMissingSyncCount} schedules=${interval.eligibleScheduleCount} reasons=${formatList(interval.reasons)}`] : [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: not present in selected canonical anchors`]),
    "#548 onward: only existing canonical anchors and exact bounded intervals are reported; no unresolved #551 identity is invented.",
    ...adjacent,
    "",
    "AGGREGATE",
    `existing_anchors=${inputs.anchors.length}`,
    `missing_numbers_examined=${requestedMissingNumbers.length}`,
    `requested_missing_sync_numbers=${formatList(requestedMissingNumbers)}`,
    `schedule_ordinal_diagnostic_boundaries=${diagnosticBoundaries.filter((mapping) => mappingIsRequested(mapping, args)).length}`,
    `selected_safe_realized_boundaries=${selectedAnalysisBoundaries.length}`,
    `REALIZED_SEQUENCE_CORROBORATED=${realizedSequences.filter((sequence) => sequence.classification === "REALIZED_SEQUENCE_CORROBORATED").length}`,
    `REALIZED_SEQUENCE_AMBIGUOUS=${realizedSequences.filter((sequence) => sequence.classification === "REALIZED_SEQUENCE_AMBIGUOUS").length}`,
    `EXACT_SYNC_CYCLE_CANDIDATE=${selectedExactCandidateNumbers.length}`,
    `ALREADY_PRESENT_REALIZED_CYCLES=${selectedAnalysisBoundaries.filter((boundary) => !exactCandidateSyncNumbers.has(boundary.syncNumber)).length}`,
    `REALIZED_MISSING_EXACT_SCHEDULE=${unresolvedRealizedNumbers.filter((syncNumber) => realizedSequences.some((sequence) => sequence.cycles.some((cycle) => cycle.expectedSyncNumber === syncNumber && cycle.action === "REALIZED_MISSING_EXACT_SCHEDULE"))).length}`,
    `REALIZED_AMBIGUOUS_SCHEDULE=${unresolvedRealizedNumbers.filter((syncNumber) => realizedSequences.some((sequence) => sequence.cycles.some((cycle) => cycle.expectedSyncNumber === syncNumber && cycle.action === "REALIZED_AMBIGUOUS_SCHEDULE"))).length}`,
    `REALIZED_NUMBER_CONFLICT=${realizedSequences.flatMap((sequence) => sequence.cycles).filter((cycle) => cycle.action === "REALIZED_NUMBER_CONFLICT").length}`,
    `SYNC_CYCLE_CONFLICT=${realizedSequences.flatMap((sequence) => sequence.cycles).filter((cycle) => cycle.action === "CONFLICT").length}`,
    `SCHEDULE_WITHOUT_REALIZED_FWA_CLUSTER=${unusedScheduleLines.length}`,
    `AMBIGUOUS_REALIZED_SCHEDULE_CANDIDATE=${ambiguousScheduleLines.length}`,
    `ambiguous_intervals=${intervals.filter((interval) => interval.classification === "AMBIGUOUS_SEQUENCE").length}`,
    `unresolved_missing_boundaries=${unresolvedRealizedNumbers.length}`,
    `ClanWarHistory_SYNC_MATCH=${allSyncMatch}`,
    `ClanWarHistory_SYNC_CORRECTABLE=${allSyncCorrectable}`,
    `ClanWarHistory_SYNC_AMBIGUOUS=${allSyncAmbiguous}`,
    `HISTORY_SYNC_MATCH=${realizedHistoryCounts.HISTORY_SYNC_MATCH}`,
    `HISTORY_SYNC_DISAGREEMENT=${realizedHistoryCounts.HISTORY_SYNC_DISAGREEMENT}`,
    `HISTORY_SYNC_NULL=${realizedHistoryCounts.HISTORY_SYNC_NULL}`,
    `HISTORY_SYNC_MIXED=${realizedHistoryCounts.HISTORY_SYNC_MIXED}`,
    `ClanPointsSync_POINTS_MATCH=${allPointsMatch}`,
    `ClanPointsSync_POINTS_CORRECTABLE=${allPointsCorrectable}`,
    `ClanPointsSync_POINTS_AMBIGUOUS=${allPointsAmbiguous}`,
    `POINTS_SYNC_MATCH=${allPointsMatch}`,
    `POINTS_SYNC_DISAGREEMENT=${allPointsCorrectable}`,
    `POINTS_SYNC_AMBIGUOUS=${allPointsAmbiguous}`,
    "",
    "ERROR PATTERNS (diagnostics only)",
    ...patternLines(reports, reconciled),
    "",
    "MEMBERSHIP-HISTORY IMPACT SIMULATION (not safe/applied)",
    `additional_exact_SyncCycle_boundaries_potentially_recoverable=${selectedExactCandidateNumbers.length}`,
    `additional_historical_FWA_cycles_with_uniquely_assignable_participation=${additionalParticipationHistories}`,
    `player_boundary_membership_facts_potentially_unlocked=${playerBoundaryFacts}`,
    `longest_newly_contiguous_canonical_sync_run=#${run.start ?? "none"}..#${run.end ?? "none"} length=${run.length}`,
    `earliest_uniquely_recoverable_boundary=${exactTimes.length > 0 ? new Date(exactTimes[0]).toISOString() : "none"}`,
    `latest_uniquely_recoverable_boundary=${exactTimes.length > 0 ? new Date(exactTimes[exactTimes.length - 1]).toISOString() : "none"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseHistoricalSyncReconciliationArgs(process.argv.slice(2));
  console.log(await runHistoricalSyncReconciliation(args));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(async () => {
    await prisma.$disconnect();
  });
}
