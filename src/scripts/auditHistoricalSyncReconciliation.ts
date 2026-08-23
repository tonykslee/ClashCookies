import { prisma } from "../prisma";
import {
  associateCanonicalHistories,
  classifyHistorySyncClaim,
  classifyPointsSyncClaim,
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

async function readInputs(db: HistoricalSyncReconciliationDb, guildId: string) {
  const [rawCycles, rawSchedules, rawPoints, rawHistories, rawEvaluations, rawParticipation] = await Promise.all([
    db.syncCycle.findMany({ orderBy: [{ guildId: "asc" }, { syncNumber: "asc" }], select: { guildId: true, syncNumber: true, syncTime: true, resolutionSource: true } }),
    db.scheduledSyncPost.findMany({ orderBy: [{ guildId: "asc" }, { syncTime: "asc" }, { id: "asc" }], select: { id: true, guildId: true, syncTime: true, status: true } }),
    db.clanPointsSync.findMany({ orderBy: [{ guildId: "asc" }, { syncNum: "asc" }, { warId: "asc" }], select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true } }),
    db.clanWarHistory.findMany({ orderBy: [{ warId: "asc" }], select: { warId: true, syncNumber: true, matchType: true, clanTag: true, opponentTag: true, prepStartTime: true, warStartTime: true, warEndTime: true } }),
    db.warPlanComplianceEvaluation.findMany({ where: { guildId }, orderBy: [{ guildId: "asc" }, { warId: "asc" }], select: { guildId: true, warId: true, matchType: true, warHistory: { select: { clanTag: true, matchType: true } } } }),
    db.clanWarParticipation.findMany({ where: { guildId }, orderBy: [{ warId: "asc" }, { playerTag: "asc" }], select: { guildId: true, warId: true, clanTag: true, playerTag: true, matchType: true } }),
  ]);
  return {
    anchors: rawCycles.map(normalizeAnchor).filter((row): row is ReconciliationAnchor => Boolean(row)).filter((row) => row.guildId === guildId).sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime()),
    cycles: rawCycles.map(normalizeCycle).filter((row): row is ReconciliationCycle => Boolean(row)).sort((left, right) => left.guildId.localeCompare(right.guildId) || left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime()),
    schedules: rawSchedules.map(normalizeSchedule).filter((row): row is ReconciliationSchedule => Boolean(row)).sort((left, right) => left.guildId.localeCompare(right.guildId) || left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id)),
    points: rawPoints.map(normalizePoint).filter((row): row is ReconciliationPoint => Boolean(row)),
    histories: uniqueHistories(rawHistories.map(normalizeHistory).filter((row): row is ReconciliationHistory => Boolean(row))),
    evaluations: rawEvaluations.map(normalizeEvaluation).filter((row): row is ReconciliationEvaluation => Boolean(row)),
    participation: rawParticipation.map(normalizeParticipation).filter((row): row is ReconciliationParticipation => Boolean(row)),
  };
}

function relatedHistories(boundary: ProposedSyncBoundary, associated: readonly AssociatedHistory[]): AssociatedHistory[] {
  return associated.filter((row) => {
    const prep = row.history.prepStartTime?.getTime();
    if (prep === undefined || !Number.isFinite(prep)) return false;
    const delta = prep - boundary.syncTime.getTime();
    return delta >= 0 && delta <= 24 * 60 * 60 * 1000;
  });
}

function buildBoundaryReport(boundary: ProposedSyncBoundary, associated: readonly AssociatedHistory[], participation: readonly ReconciliationParticipation[]): BoundaryReport {
  const histories = relatedHistories(boundary, associated);
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
  let participationRows = 0;
  for (const row of histories) {
    if (row.history.syncNumber !== null) existingBuckets.add(row.history.syncNumber);
    for (const point of row.points) existingBuckets.add(point.syncNumber);
    const claim = classifyHistorySyncClaim({ history: row.history, associated: row, boundaries: [boundary] });
    if (claim.classification === "SYNC_MATCH") syncMatch += 1;
    else if (claim.classification === "SYNC_CORRECTABLE") { syncCorrectable += 1; correctableHistoryWarIds.push(row.history.warId); }
    else { syncAmbiguous += 1; ambiguousWarIds.push(row.history.warId); }
    const pointsClaim = classifyPointsSyncClaim({ expectedSyncNumber: claim.expectedSyncNumber, associated: row });
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
  };
}

function formatList(values: readonly (number | string)[]): string {
  return values.length > 0 ? values.join(",") : "-";
}

function formatInterval(plan: AnchorIntervalPlan): string[] {
  return [
    `lower=#${plan.lower.syncNumber}@${plan.lower.syncTime.toISOString()} upper=#${plan.upper.syncNumber}@${plan.upper.syncTime.toISOString()} expected_missing=${plan.expectedMissingSyncCount} eligible_schedules=${plan.eligibleScheduleCount} classification=${plan.classification} reasons=${formatList(plan.reasons)}`,
    ...plan.mappings.map((mapping) => `  #${mapping.syncNumber} -> ${mapping.syncTime.toISOString()} scheduled_sync_post_id=${mapping.scheduledSyncPostId}`),
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

function patternLines(reports: readonly BoundaryReport[], associated: readonly AssociatedHistory[], boundaries: readonly ProposedSyncBoundary[]): string[] {
  const lines: string[] = [];
  const allUniqueClaims = associated.map((row) => classifyHistorySyncClaim({ history: row.history, associated: row, boundaries }));
  const offsets = associated.flatMap((row, index) => {
    const claim = allUniqueClaims[index];
    return claim.expectedSyncNumber !== null && row.history.syncNumber !== null ? [row.history.syncNumber - claim.expectedSyncNumber] : [];
  });
  if (offsets.length > 0 && offsets.every((offset) => offset === -1)) lines.push("consistent_stored_sync_number=canonical-1");
  if (offsets.length > 0 && offsets.every((offset) => offset === 1)) lines.push("consistent_stored_sync_number=canonical+1");
  if (new Set(offsets).size > 1) lines.push("mixed_adjacent_persisted_sync_buckets");
  if (associated.some((row) => row.ambiguousReasons.includes("raw_war_identity_claimed_by_multiple_sync_owners"))) lines.push("one_raw_war_identity_claimed_by_multiple_sync_buckets");
  if (reports.some((report) => report.existingBuckets.length > 1)) lines.push("one_true_schedule_contains_histories_split_across_persisted_buckets");
  if (associated.some((row, index) => row.history.syncNumber !== null && allUniqueClaims[index].expectedSyncNumber === row.history.syncNumber && row.points.some((point) => point.syncNumber !== row.history.syncNumber))) lines.push("canonical_history_sync_correct_but_points_sync_stale");
  if (associated.some((row) => row.history.syncNumber === null)) lines.push("null_historical_sync_number");
  if (reports.some((report) => report.existingBuckets.length > 1)) lines.push("histories_split_across_adjacent_persisted_sync_numbers");
  return lines.length > 0 ? lines : ["none"];
}

/** Purpose: execute the complete read-only reconciliation and return deterministic operator text. */
export async function runHistoricalSyncReconciliation(
  args: HistoricalSyncReconciliationArgs,
  db: HistoricalSyncReconciliationDb = prisma as unknown as HistoricalSyncReconciliationDb,
): Promise<string> {
  const inputs = await readInputs(db, args.guildId);
  const intervals = planAnchoredSequenceIntervals({ anchors: inputs.anchors, schedules: inputs.schedules, existingCycles: inputs.cycles, guildId: args.guildId, fromSync: args.fromSync, toSync: args.toSync });
  const exactBoundaries = intervals.flatMap((interval) => interval.mappings);
  const associated = associateCanonicalHistories({ guildId: args.guildId, histories: inputs.histories, points: inputs.points, evaluations: inputs.evaluations });
  const reports = exactBoundaries.map((boundary) => buildBoundaryReport(boundary, associated, inputs.participation));
  const uniqueClaims = associated.map((row) => classifyHistorySyncClaim({ history: row.history, associated: row, boundaries: exactBoundaries }));
  const uniqueMapped = associated.filter((_row, index) => uniqueClaims[index].classification !== "SYNC_AMBIGUOUS");
  const participationByWar = new Map(uniqueMapped.map((row) => [row.history.warId, inputs.participation.filter((entry) => entry.warId === row.history.warId && normalizeMembershipHistoryClanTag(entry.clanTag) === normalizeMembershipHistoryClanTag(row.history.clanTag))]));
  const allSyncMatch = uniqueClaims.filter((claim) => claim.classification === "SYNC_MATCH").length;
  const allSyncCorrectable = uniqueClaims.filter((claim) => claim.classification === "SYNC_CORRECTABLE").length;
  const allSyncAmbiguous = uniqueClaims.filter((claim) => claim.classification === "SYNC_AMBIGUOUS").length;
  const pointClaims = associated.map((row, index) => classifyPointsSyncClaim({ expectedSyncNumber: uniqueClaims[index].expectedSyncNumber, associated: row }));
  const allPointsMatch = pointClaims.filter((claim) => claim.classification === "POINTS_MATCH").length;
  const allPointsCorrectable = pointClaims.filter((claim) => claim.classification === "POINTS_CORRECTABLE").length;
  const allPointsAmbiguous = pointClaims.filter((claim) => claim.classification === "POINTS_AMBIGUOUS").length;
  const proposedNumbers = exactBoundaries.map((boundary) => boundary.syncNumber);
  const existingNumbers = inputs.anchors.map((anchor) => anchor.syncNumber);
  const run = longestRun([...existingNumbers, ...proposedNumbers]);
  const exactTimes = exactBoundaries.map((boundary) => boundary.syncTime.getTime()).sort((left, right) => left - right);
  const additionalParticipationHistories = uniqueMapped.filter((row) => (participationByWar.get(row.history.warId) ?? []).length > 0).length;
  const playerBoundaryFacts = new Set(uniqueMapped.flatMap((row) => (participationByWar.get(row.history.warId) ?? []).map((entry) => `${row.history.warId}|${entry.playerTag}`))).size;
  const intervalLines = intervals.flatMap(formatInterval);
  const boundaryLines = reports.flatMap((report) => [
    `#${report.boundary.syncNumber} scheduledSyncPost=${report.boundary.scheduledSyncPostId} time=${report.boundary.syncTime.toISOString()} canonical_fwa_histories=${report.histories.length} existing_persisted_buckets=${formatList(report.existingBuckets)} sync_match=${report.syncMatch} sync_correctable=${report.syncCorrectable} sync_ambiguous=${report.syncAmbiguous} points_match=${report.pointsMatch} points_correctable=${report.pointsCorrectable} points_ambiguous=${report.pointsAmbiguous} participation_rows=${report.participationRows}`,
    `  correctable_history_war_ids=${formatList(report.correctableHistoryWarIds)} correctable_points_war_ids=${formatList(report.correctablePointWarIds)} ambiguous_war_ids=${formatList(report.ambiguousWarIds)}`,
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
    "SPECIAL WINDOWS",
    ...special.flatMap((interval, index) => interval ? [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: ${interval.classification} expected=${interval.expectedMissingSyncCount} schedules=${interval.eligibleScheduleCount} reasons=${formatList(interval.reasons)}`] : [`#${index === 0 ? "520 -> 522" : "526 -> 548"}: not present in selected canonical anchors`]),
    "#548 onward: only existing canonical anchors and exact bounded intervals are reported; no unresolved #551 identity is invented.",
    ...adjacent,
    "",
    "AGGREGATE",
    `existing_anchors=${inputs.anchors.length}`,
    `missing_numbers_examined=${proposedNumbers.length}`,
    `ANCHORED_SEQUENCE_EXACT_boundaries=${exactBoundaries.length}`,
    `ambiguous_boundaries=${intervals.filter((interval) => interval.classification === "AMBIGUOUS_SEQUENCE").length}`,
    `ClanWarHistory_SYNC_MATCH=${allSyncMatch}`,
    `ClanWarHistory_SYNC_CORRECTABLE=${allSyncCorrectable}`,
    `ClanWarHistory_SYNC_AMBIGUOUS=${allSyncAmbiguous}`,
    `ClanPointsSync_POINTS_MATCH=${allPointsMatch}`,
    `ClanPointsSync_POINTS_CORRECTABLE=${allPointsCorrectable}`,
    `ClanPointsSync_POINTS_AMBIGUOUS=${allPointsAmbiguous}`,
    "",
    "ERROR PATTERNS (diagnostics only)",
    ...patternLines(reports, associated, exactBoundaries),
    "",
    "MEMBERSHIP-HISTORY IMPACT SIMULATION (not safe/applied)",
    `additional_exact_SyncCycle_boundaries_potentially_recoverable=${exactBoundaries.length}`,
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
