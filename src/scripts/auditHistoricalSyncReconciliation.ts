import { prisma } from "../prisma";
import {
  associateCanonicalHistories,
  classifyReconciliationHistoryScope,
  classifyHistorySyncClaim,
  classifyPointsSyncClaim,
  HISTORICAL_SYNC_LOOKBACK_MS,
  planAnchoredSequenceIntervals,
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
} from "../services/historicalSyncReconciliation";
import { normalizeMembershipHistoryClanTag } from "../services/membershipHistoryIdentity";

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
  claim: ReturnType<typeof classifyHistorySyncClaim>;
  pointsClaim: ReturnType<typeof classifyPointsSyncClaim>;
};

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
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  if (!warId || !warStartTime || !clanTag || comparable(row?.matchType) !== "FWA") return null;
  return {
    warId,
    syncNumber: positive(row?.syncNumber),
    matchType: comparable(row?.matchType),
    clanTag,
    opponentTag: row?.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag),
    warStartTime,
    prepStartTime: date(row?.prepStartTime),
    warEndTime: date(row?.warEndTime),
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
  return { guildId, syncNumber, syncTime };
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
  const cycleSelect = { guildId: true, syncNumber: true, syncTime: true, resolutionSource: true };
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
      return { anchors: [], cycles: [], schedules: [], points: [], histories: [], evaluations: [], participation: [], intervals: [], exactBoundaries: [] };
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
    return { anchors, cycles, schedules: [], points: [], histories: [], evaluations: [], participation: [], intervals: [], exactBoundaries: [] };
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
  if (exactBoundaries.length === 0) {
    return { anchors, cycles, schedules, points: [], histories: [], evaluations: [], participation: [], intervals, exactBoundaries };
  }

  const targetSyncNumbers = [...new Set([
    ...exactBoundaries.map((boundary) => boundary.syncNumber),
    ...intervals.flatMap((interval) => [interval.lower.syncNumber, interval.upper.syncNumber]),
  ])].sort((left, right) => left - right);
  const examinedWindows = intervals
    .filter((interval) => interval.classification === "ANCHORED_SEQUENCE_EXACT" && interval.mappings.length > 0)
    .map((interval) => ({ start: interval.mappings[0].syncTime.getTime(), end: interval.upper.syncTime.getTime() }));
  const evidenceStart = Math.min(...examinedWindows.map((window) => window.start));
  const evidenceEnd = Math.max(...examinedWindows.map((window) => window.end));
  const evidenceTime = { gte: new Date(evidenceStart), lt: new Date(evidenceEnd) };
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
  const historyWhere = [
    ...(candidateWarIds.length > 0 ? [{ warId: { in: candidateWarIds } }] : []),
    ...semanticTuples,
  ];
  const [rawCrossGuildPoints, rawHistories] = await Promise.all([
    targetRawWarIds.length > 0
      ? db.clanPointsSync.findMany({
          where: { warId: { in: targetRawWarIds.map(String) } },
          orderBy: [{ warId: "asc" }, { guildId: "asc" }, { syncNum: "asc" }],
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
  ]);
  const points = [...new Map([...targetPoints, ...rawCrossGuildPoints.map(normalizePoint).filter((row): row is ReconciliationPoint => Boolean(row))]
    .map((point) => [`${point.guildId}|${point.syncNumber}|${point.warId ?? "null"}|${point.clanTag}|${point.warStartTime.getTime()}|${point.opponentTag}`, point])).values()];
  const histories = uniqueHistories(rawHistories.map(normalizeHistory).filter((row): row is ReconciliationHistory => Boolean(row)));
  const participationWarIds = [...new Set(histories.map((history) => history.warId))];
  const rawParticipation = participationWarIds.length > 0
    ? await db.clanWarParticipation.findMany({
        where: { guildId: args.guildId, warId: { in: participationWarIds.map(String) } },
        orderBy: [{ warId: "asc" }, { playerTag: "asc" }],
        select: { guildId: true, warId: true, clanTag: true, playerTag: true, matchType: true },
      })
    : [];
  const participation = rawParticipation.map(normalizeParticipation).filter((row): row is ReconciliationParticipation => Boolean(row));
  return { anchors, cycles, schedules, points, histories, evaluations, participation, intervals, exactBoundaries };
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

function unresolvedMissingBoundaryCount(
  intervals: readonly AnchorIntervalPlan[],
  args: HistoricalSyncReconciliationArgs,
): number {
  return intervals
    .filter((interval) => interval.classification === "AMBIGUOUS_SEQUENCE")
    .reduce((total, interval) => {
      const first = Math.max(interval.lower.syncNumber + 1, args.fromSync ?? Number.NEGATIVE_INFINITY);
      const last = Math.min(interval.upper.syncNumber - 1, args.toSync ?? Number.POSITIVE_INFINITY);
      return total + Math.max(0, last - first + 1);
    }, 0);
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

function selectedBoundaries(intervals: readonly AnchorIntervalPlan[], args: HistoricalSyncReconciliationArgs): ProposedSyncBoundary[] {
  return intervals
    .flatMap((interval) => interval.mappings.filter((mapping) => mappingIsRequested(mapping, args)))
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());
}

function selectedScopeWindows(intervals: readonly AnchorIntervalPlan[], args: HistoricalSyncReconciliationArgs): ReconciliationHistoryScopeWindow[] {
  return intervals
    .filter((interval) => interval.classification === "ANCHORED_SEQUENCE_EXACT")
    .flatMap((interval) => {
      const mappings = interval.mappings.filter((mapping) => mappingIsRequested(mapping, args));
      if (mappings.length === 0) return [];
      const first = mappings[0];
      const last = mappings[mappings.length - 1];
      const next = interval.mappings.find((mapping) => mapping.syncNumber > last.syncNumber);
      return [{ startTime: first.syncTime, endTime: next?.syncTime ?? interval.upper.syncTime }];
    });
}

function formatInterval(plan: AnchorIntervalPlan, displayedMappings: readonly ProposedSyncBoundary[] = plan.mappings): string[] {
  const displayedIds = new Set(displayedMappings.map((mapping) => mapping.scheduledSyncPostId));
  return [
    `lower=#${plan.lower.syncNumber}@${plan.lower.syncTime.toISOString()} upper=#${plan.upper.syncNumber}@${plan.upper.syncTime.toISOString()} expected_missing=${plan.expectedMissingSyncCount} eligible_schedules=${plan.eligibleScheduleCount} classification=${plan.classification} reasons=${formatList(plan.reasons)}`,
    ...plan.mappings
      .filter((mapping) => displayedIds.has(mapping.scheduledSyncPostId))
      .map((mapping) => `  #${mapping.syncNumber} -> ${mapping.syncTime.toISOString()} scheduled_sync_post_id=${mapping.scheduledSyncPostId}`),
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
  const proofBoundaries = inputs.exactBoundaries;
  const selectedAnalysisBoundaries = selectedBoundaries(intervals, args);
  const scopeWindows = selectedScopeWindows(intervals, args);
  const associated = associateCanonicalHistories({ guildId: args.guildId, histories: inputs.histories, points: inputs.points, evaluations: inputs.evaluations });
  const scopedAssociated = associated.filter((row) => classifyReconciliationHistoryScope({
    history: row.history,
    boundaries: selectedAnalysisBoundaries,
    intervals,
    scopeWindows,
  }) === "IN_SCOPE");
  const reconciled: ReconciledHistory[] = scopedAssociated.map((row) => {
    const claim = classifyHistorySyncClaim({ history: row.history, associated: row, boundaries: proofBoundaries });
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
  const proposedNumbers = selectedAnalysisBoundaries.map((boundary) => boundary.syncNumber);
  const existingNumbers = inputs.anchors.map((anchor) => anchor.syncNumber);
  const run = longestRun([...existingNumbers, ...proposedNumbers]);
  const exactTimes = selectedAnalysisBoundaries.map((boundary) => boundary.syncTime.getTime()).sort((left, right) => left - right);
  const participationBackedSyncNumbers = new Set<number>();
  const playerBoundaryFactsSet = new Set<string>();
  uniqueMapped.forEach(({ row, claim }) => {
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
    "PROPOSED BOUNDARIES",
    ...(boundaryLines.length > 0 ? boundaryLines : ["none"]),
    "",
    ...unmappedLines,
    "",
    "SPECIAL WINDOWS",
    ...special.flatMap((interval, index) => interval ? [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: ${interval.classification} expected=${interval.expectedMissingSyncCount} schedules=${interval.eligibleScheduleCount} reasons=${formatList(interval.reasons)}`] : [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: not present in selected canonical anchors`]),
    "#548 onward: only existing canonical anchors and exact bounded intervals are reported; no unresolved #551 identity is invented.",
    ...adjacent,
    "",
    "AGGREGATE",
    `existing_anchors=${inputs.anchors.length}`,
    `missing_numbers_examined=${proposedNumbers.length}`,
    `ANCHORED_SEQUENCE_EXACT_boundaries=${selectedAnalysisBoundaries.length}`,
    `ambiguous_intervals=${intervals.filter((interval) => interval.classification === "AMBIGUOUS_SEQUENCE").length}`,
    `unresolved_missing_boundaries=${unresolvedMissingBoundaryCount(intervals, args)}`,
    `ClanWarHistory_SYNC_MATCH=${allSyncMatch}`,
    `ClanWarHistory_SYNC_CORRECTABLE=${allSyncCorrectable}`,
    `ClanWarHistory_SYNC_AMBIGUOUS=${allSyncAmbiguous}`,
    `ClanPointsSync_POINTS_MATCH=${allPointsMatch}`,
    `ClanPointsSync_POINTS_CORRECTABLE=${allPointsCorrectable}`,
    `ClanPointsSync_POINTS_AMBIGUOUS=${allPointsAmbiguous}`,
    "",
    "ERROR PATTERNS (diagnostics only)",
    ...patternLines(reports, reconciled),
    "",
    "MEMBERSHIP-HISTORY IMPACT SIMULATION (not safe/applied)",
    `additional_exact_SyncCycle_boundaries_potentially_recoverable=${selectedAnalysisBoundaries.length}`,
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
