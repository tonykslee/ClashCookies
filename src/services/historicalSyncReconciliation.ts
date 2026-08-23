import {
  historicalHistoryMatchesPointByExactTuple,
  membershipHistoryConflictingPersistedOwnerKeys,
  normalizeMembershipHistoryClanTag,
  type MembershipCanonicalHistoryIdentity,
  type MembershipHistoryPointIdentity,
} from "./membershipHistoryIdentity";

export const HISTORICAL_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const MAX_PREP_CLUSTER_SPREAD_MS = 2 * 60 * 60 * 1000;

export type ReconciliationAnchor = {
  guildId: string;
  syncNumber: number;
  syncTime: Date;
  source: string;
};

export type ReconciliationSchedule = {
  id: string;
  guildId: string;
  syncTime: Date;
  status: string;
};

export type ReconciliationCycle = {
  guildId: string;
  syncNumber: number;
  syncTime: Date;
  scheduledSyncPostId?: string | null;
};

export type ReconciliationHistory = MembershipCanonicalHistoryIdentity & {
  matchType: string | null;
  prepStartTime: Date | null;
  warStartTime: Date;
  warEndTime: Date | null;
};

export type ReconciliationPoint = MembershipHistoryPointIdentity & {
  isFwa: boolean;
};

export type ReconciliationEvaluation = {
  guildId: string;
  warId: number;
  clanTag: string | null;
  matchType: string | null;
};

export type ReconciliationParticipation = {
  guildId: string;
  warId: number;
  clanTag: string;
  playerTag: string;
  matchType: string | null;
};

export type ProposedSyncBoundary = {
  guildId: string;
  syncNumber: number;
  syncTime: Date;
  scheduledSyncPostId: string;
  lowerSyncNumber: number;
  upperSyncNumber: number;
};

export type AnchorIntervalPlan = {
  guildId: string;
  lower: ReconciliationAnchor;
  upper: ReconciliationAnchor;
  expectedMissingSyncCount: number;
  eligibleScheduleCount: number;
  classification: "ANCHORED_SEQUENCE_EXACT" | "AMBIGUOUS_SEQUENCE";
  reasons: string[];
  eligibleSchedules: ReconciliationSchedule[];
  mappings: ProposedSyncBoundary[];
};

export type RealizedHistorySyncClassification = "HISTORY_SYNC_MATCH" | "HISTORY_SYNC_DISAGREEMENT" | "HISTORY_SYNC_NULL" | "HISTORY_SYNC_MIXED";

export type RealizedFwaCluster = {
  histories: ReconciliationHistory[];
  prepMin: Date | null;
  prepMax: Date | null;
  prepCenter: Date | null;
  spreadSeconds: number | null;
  spreadMinutes: number | null;
  excessiveSpread: boolean;
  canonicalHistoryCount: number;
  distinctClanCount: number;
  canonicalWarIds: number[];
  participationRowCount: number;
  distinctPlayerCount: number;
  persistedSyncNumbers: number[];
  unanimousPersistedSyncNumber: number | null;
  historySyncClassification: RealizedHistorySyncClassification;
  reasons: string[];
};

export type PrepClusterSummary = {
  min: Date | null;
  max: Date | null;
  center: Date | null;
  spreadSeconds: number | null;
  spreadMinutes: number | null;
  excessiveSpread: boolean;
};

export type RealizedCycleScheduleAction =
  | "EXACT_SYNC_CYCLE_CANDIDATE"
  | "ALREADY_PRESENT"
  | "REALIZED_MISSING_EXACT_SCHEDULE"
  | "REALIZED_AMBIGUOUS_SCHEDULE"
  | "REALIZED_NUMBER_CONFLICT"
  | "CONFLICT";

export type RealizedFwaCyclePlan = {
  cluster: RealizedFwaCluster;
  expectedSyncNumber: number | null;
  numberClassification: RealizedHistorySyncClassification;
  scheduleCandidates: ReconciliationSchedule[];
  selectedSchedule: ReconciliationSchedule | null;
  action: RealizedCycleScheduleAction;
  reasons: string[];
};

export type RealizedFwaSequencePlan = {
  lower: ReconciliationAnchor;
  upper: ReconciliationAnchor;
  expectedMissingSyncCount: number;
  realizedClusterCount: number;
  classification: "REALIZED_SEQUENCE_CORROBORATED" | "REALIZED_SEQUENCE_AMBIGUOUS";
  reasons: string[];
  cycles: RealizedFwaCyclePlan[];
  unusedEligibleSchedules: ReconciliationSchedule[];
};

export type AssociatedHistory = {
  history: ReconciliationHistory;
  points: ReconciliationPoint[];
  hasEvaluation: boolean;
  ambiguousReasons: string[];
};

export type HistoryClaimClassification = "SYNC_MATCH" | "SYNC_CORRECTABLE" | "SYNC_AMBIGUOUS";
export type PointsClaimClassification = "POINTS_MATCH" | "POINTS_CORRECTABLE" | "POINTS_AMBIGUOUS";

export type HistoryClaimResult = {
  classification: HistoryClaimClassification;
  expectedSyncNumber: number | null;
  candidates: ProposedSyncBoundary[];
  reasons: string[];
};

export type PointsClaimResult = {
  classification: PointsClaimClassification;
  reasons: string[];
};

export type ReconciliationHistoryScope = "IN_SCOPE" | "OUT_OF_SCOPE";
export type ReconciliationHistoryScopeWindow = { startTime: Date; endTime: Date };

function comparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalHistoryKey(history: ReconciliationHistory): string {
  return `${history.warId}|${normalizeMembershipHistoryClanTag(history.clanTag)}`;
}

function scheduleIsEligible(schedule: ReconciliationSchedule): boolean {
  return !["CANCELLED", "REPLACED"].includes(comparable(schedule.status));
}

function validPrepTime(history: ReconciliationHistory): Date | null {
  return history.prepStartTime instanceof Date && Number.isFinite(history.prepStartTime.getTime())
    ? history.prepStartTime
    : null;
}

/** Purpose: summarize a conservative prep-time cluster without assigning an exact sync boundary. */
export function summarizePrepTimes(prepTimes: readonly Date[]): PrepClusterSummary {
  const times = prepTimes.map((value) => value.getTime()).filter(Number.isFinite).sort((left, right) => left - right);
  if (times.length === 0) return { min: null, max: null, center: null, spreadSeconds: null, spreadMinutes: null, excessiveSpread: false };
  const min = times[0];
  const max = times[times.length - 1];
  const middle = Math.floor(times.length / 2);
  const center = times.length % 2 === 0 ? Math.round((times[middle - 1] + times[middle]) / 2) : times[middle];
  const spread = max - min;
  return {
    min: new Date(min),
    max: new Date(max),
    center: new Date(center),
    spreadSeconds: Math.round(spread / 1000),
    spreadMinutes: Math.round(spread / 60000),
    excessiveSpread: spread > MAX_PREP_CLUSTER_SPREAD_MS,
  };
}

function prepClusterSummary(histories: readonly ReconciliationHistory[]): Pick<RealizedFwaCluster, "prepMin" | "prepMax" | "prepCenter" | "spreadSeconds" | "spreadMinutes" | "excessiveSpread"> {
  const summary = summarizePrepTimes(histories.map(validPrepTime).filter((value): value is Date => value !== null));
  return {
    prepMin: summary.min,
    prepMax: summary.max,
    prepCenter: summary.center,
    spreadSeconds: summary.spreadSeconds,
    spreadMinutes: summary.spreadMinutes,
    excessiveSpread: summary.excessiveSpread,
  };
}

function clusterHistorySyncClassification(syncNumbers: readonly number[], hasMissing: boolean): RealizedHistorySyncClassification {
  if (syncNumbers.length === 0 || hasMissing) return "HISTORY_SYNC_NULL";
  if (syncNumbers.length > 1) return "HISTORY_SYNC_MIXED";
  return "HISTORY_SYNC_MATCH";
}

/** Purpose: cluster canonical ended FWA histories chronologically without using persisted sync numbers. */
export function buildRealizedFwaClusters(input: {
  histories: readonly ReconciliationHistory[];
  participation?: readonly ReconciliationParticipation[];
}): { clusters: RealizedFwaCluster[]; unclusteredHistoryWarIds: number[]; reasons: string[] } {
  const histories = input.histories
    .filter((history) => comparable(history.matchType) === "FWA" && history.warEndTime instanceof Date && Number.isFinite(history.warEndTime.getTime()))
    .sort((left, right) => {
      const leftPrep = validPrepTime(left)?.getTime() ?? Number.POSITIVE_INFINITY;
      const rightPrep = validPrepTime(right)?.getTime() ?? Number.POSITIVE_INFINITY;
      return leftPrep - rightPrep || left.warId - right.warId || normalizeMembershipHistoryClanTag(left.clanTag).localeCompare(normalizeMembershipHistoryClanTag(right.clanTag));
    });
  const unclusteredHistoryWarIds = histories.filter((history) => validPrepTime(history) === null).map((history) => history.warId);
  const reasons = new Set<string>();
  if (unclusteredHistoryWarIds.length > 0) reasons.add("realized_history_missing_prep_start_time");
  const clusters: ReconciliationHistory[][] = [];
  for (const history of histories.filter((candidate) => validPrepTime(candidate) !== null)) {
    const prep = validPrepTime(history)!.getTime();
    const current = clusters[clusters.length - 1];
    const currentMin = current?.map(validPrepTime).filter((value): value is Date => value !== null).reduce((min, value) => Math.min(min, value.getTime()), Number.POSITIVE_INFINITY);
    if (!current || prep - currentMin > MAX_PREP_CLUSTER_SPREAD_MS) clusters.push([history]);
    else current.push(history);
  }
  const realized = clusters.map((clusterHistories) => {
    const summary = prepClusterSummary(clusterHistories);
    const canonicalWarIds = [...new Set(clusterHistories.map((history) => history.warId))].sort((left, right) => left - right);
    const distinctClans = new Set(clusterHistories.map((history) => normalizeMembershipHistoryClanTag(history.clanTag)).filter(Boolean));
    const clusterParticipation = (input.participation ?? []).filter((entry) => clusterHistories.some((history) =>
      history.warId === entry.warId && normalizeMembershipHistoryClanTag(history.clanTag) === normalizeMembershipHistoryClanTag(entry.clanTag)));
    const distinctPlayers = new Set(clusterParticipation.map((entry) => `${normalizeMembershipHistoryClanTag(entry.clanTag)}|${entry.playerTag}`));
    const persistedSyncNumbers = [...new Set(clusterHistories.map((history) => history.syncNumber).filter((value): value is number => value !== null))].sort((left, right) => left - right);
    const hasMissing = clusterHistories.some((history) => history.syncNumber === null);
    const clusterReasons = new Set<string>();
    if (summary.excessiveSpread) clusterReasons.add("realized_cluster_prep_spread_exceeds_limit");
    if (new Set(clusterHistories.map((history) => history.warId)).size !== clusterHistories.length) clusterReasons.add("duplicate_realized_history_identity");
    return {
      histories: [...clusterHistories].sort((left, right) => left.warId - right.warId || normalizeMembershipHistoryClanTag(left.clanTag).localeCompare(normalizeMembershipHistoryClanTag(right.clanTag))),
      ...summary,
      canonicalHistoryCount: clusterHistories.length,
      distinctClanCount: distinctClans.size,
      canonicalWarIds,
      participationRowCount: clusterParticipation.length,
      distinctPlayerCount: distinctPlayers.size,
      persistedSyncNumbers,
      unanimousPersistedSyncNumber: persistedSyncNumbers.length === 1 && !hasMissing ? persistedSyncNumbers[0] : null,
      historySyncClassification: clusterHistorySyncClassification(persistedSyncNumbers, hasMissing),
      reasons: [...clusterReasons].sort((left, right) => left.localeCompare(right)),
    };
  });
  return { clusters: realized, unclusteredHistoryWarIds: [...new Set(unclusteredHistoryWarIds)].sort((left, right) => left - right), reasons: [...reasons].sort((left, right) => left.localeCompare(right)) };
}

function schedulesForRealizedCluster(cluster: RealizedFwaCluster, schedules: readonly ReconciliationSchedule[]): ReconciliationSchedule[] {
  const histories = cluster.histories;
  return schedules
    .filter((schedule) => scheduleIsEligible(schedule) && histories.every((history) => {
      const prep = validPrepTime(history)?.getTime();
      if (prep === undefined) return false;
      const delta = prep - schedule.syncTime.getTime();
      return delta >= 0 && delta <= HISTORICAL_SYNC_LOOKBACK_MS;
    }))
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
}

/** Purpose: corroborate chronological realized FWA numbering, then correlate each realized cycle to exact persisted schedules. */
export function corroborateRealizedFwaSequence(input: {
  lower: ReconciliationAnchor;
  upper: ReconciliationAnchor;
  histories: readonly ReconciliationHistory[];
  participation?: readonly ReconciliationParticipation[];
  schedules: readonly ReconciliationSchedule[];
  existingCycles: readonly ReconciliationCycle[];
}): RealizedFwaSequencePlan {
  const expectedMissingSyncCount = Math.max(0, input.upper.syncNumber - input.lower.syncNumber - 1);
  const inInterval = input.histories.filter((history) => {
    const timing = validPrepTime(history)?.getTime() ?? history.warStartTime.getTime();
    return timing > input.lower.syncTime.getTime() && timing < input.upper.syncTime.getTime();
  });
  const clustered = buildRealizedFwaClusters({ histories: inInterval, participation: input.participation });
  const reasons = new Set<string>(clustered.reasons);
  if (clustered.unclusteredHistoryWarIds.length > 0) reasons.add("realized_history_missing_prep_start_time");
  if (clustered.clusters.length !== expectedMissingSyncCount) {
    reasons.add("realized_cluster_count_does_not_match_numeric_gap");
    if (clustered.clusters.length < expectedMissingSyncCount) reasons.add("realized_cluster_missing");
    if (clustered.clusters.length > expectedMissingSyncCount) reasons.add("realized_cluster_extra");
  }
  const cycles = clustered.clusters.map((cluster, index) => {
    const expectedSyncNumber = clustered.clusters.length === expectedMissingSyncCount ? input.lower.syncNumber + index + 1 : null;
    const candidates = schedulesForRealizedCluster(cluster, input.schedules.filter((schedule) =>
      schedule.syncTime.getTime() > input.lower.syncTime.getTime() && schedule.syncTime.getTime() < input.upper.syncTime.getTime()));
    const cycleReasons = new Set(cluster.reasons);
    let action: RealizedCycleScheduleAction;
    let selectedSchedule: ReconciliationSchedule | null = null;
    const numberClassification: RealizedHistorySyncClassification = cluster.historySyncClassification === "HISTORY_SYNC_MATCH" &&
      expectedSyncNumber !== null && cluster.unanimousPersistedSyncNumber !== expectedSyncNumber
      ? "HISTORY_SYNC_DISAGREEMENT"
      : cluster.historySyncClassification;
    if (expectedSyncNumber === null || cluster.unanimousPersistedSyncNumber === null || cluster.unanimousPersistedSyncNumber !== expectedSyncNumber || cluster.historySyncClassification !== "HISTORY_SYNC_MATCH") {
      cycleReasons.add(cluster.historySyncClassification === "HISTORY_SYNC_MIXED" ? "history_sync_number_mixed" : cluster.historySyncClassification === "HISTORY_SYNC_NULL" ? "history_sync_number_null" : "history_sync_number_disagrees_with_chronological_sequence");
      action = "REALIZED_NUMBER_CONFLICT";
    } else if (candidates.length > 1) {
      cycleReasons.add("multiple_exact_schedule_candidates");
      action = "REALIZED_AMBIGUOUS_SCHEDULE";
    } else if (candidates.length === 0) {
      const existing = input.existingCycles.find((cycle) => cycle.guildId === input.lower.guildId && cycle.syncNumber === expectedSyncNumber);
      if (existing) {
        action = "ALREADY_PRESENT";
        selectedSchedule = input.schedules.find((schedule) => schedule.id === existing.scheduledSyncPostId) ?? null;
      } else {
        cycleReasons.add("no_exact_persisted_schedule");
        action = "REALIZED_MISSING_EXACT_SCHEDULE";
      }
    } else {
      selectedSchedule = candidates[0];
      const existingByNumber = input.existingCycles.find((cycle) => cycle.guildId === input.lower.guildId && cycle.syncNumber === expectedSyncNumber);
      const existingByTime = input.existingCycles.find((cycle) => cycle.guildId === input.lower.guildId && cycle.syncTime.getTime() === selectedSchedule!.syncTime.getTime());
      if (existingByNumber && existingByNumber.syncTime.getTime() !== selectedSchedule.syncTime.getTime()) {
        cycleReasons.add("sync_number_already_mapped");
        action = "CONFLICT";
      } else if (existingByTime && existingByTime.syncNumber !== expectedSyncNumber) {
        cycleReasons.add("sync_time_already_mapped");
        action = "CONFLICT";
      } else if (existingByNumber || existingByTime) action = "ALREADY_PRESENT";
      else action = "EXACT_SYNC_CYCLE_CANDIDATE";
    }
    return { cluster, expectedSyncNumber, numberClassification, scheduleCandidates: candidates, selectedSchedule, action, reasons: [...cycleReasons].sort((left, right) => left.localeCompare(right)) };
  });
  const usedScheduleIds = new Set(cycles.filter((cycle) => cycle.selectedSchedule && ["EXACT_SYNC_CYCLE_CANDIDATE", "ALREADY_PRESENT"].includes(cycle.action)).map((cycle) => cycle.selectedSchedule!.id));
  const intervalSchedules = input.schedules.filter((schedule) => scheduleIsEligible(schedule) && schedule.syncTime.getTime() > input.lower.syncTime.getTime() && schedule.syncTime.getTime() < input.upper.syncTime.getTime());
  const unusedEligibleSchedules = intervalSchedules.filter((schedule) => !usedScheduleIds.has(schedule.id)).sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
  const corroborated = input.lower.guildId === input.upper.guildId && input.upper.syncNumber > input.lower.syncNumber && input.upper.syncTime.getTime() > input.lower.syncTime.getTime() &&
    clustered.clusters.length === expectedMissingSyncCount && clustered.unclusteredHistoryWarIds.length === 0 && cycles.length === expectedMissingSyncCount &&
    cycles.every((cycle) => cycle.cluster.reasons.length === 0) &&
    cycles.every((cycle) => cycle.cluster.historySyncClassification === "HISTORY_SYNC_MATCH" && cycle.cluster.unanimousPersistedSyncNumber === cycle.expectedSyncNumber);
  if (!corroborated) reasons.add("realized_sequence_not_fully_corroborated");
  return {
    lower: input.lower,
    upper: input.upper,
    expectedMissingSyncCount,
    realizedClusterCount: clustered.clusters.length,
    classification: corroborated ? "REALIZED_SEQUENCE_CORROBORATED" : "REALIZED_SEQUENCE_AMBIGUOUS",
    reasons: [...reasons].sort((left, right) => left.localeCompare(right)),
    cycles,
    unusedEligibleSchedules,
  };
}

/** Purpose: decide reconciliation scope from persisted war timing, independently of whether prep time yields a schedule candidate. */
export function classifyReconciliationHistoryScope(input: {
  history: ReconciliationHistory;
  boundaries: readonly ProposedSyncBoundary[];
  intervals?: readonly AnchorIntervalPlan[];
  scopeWindows?: readonly ReconciliationHistoryScopeWindow[];
}): ReconciliationHistoryScope {
  const windows = (input.scopeWindows ?? [])
    .map((window) => ({ start: window.startTime.getTime(), end: window.endTime.getTime() }));
  if (windows.length === 0) {
    windows.push(...(input.intervals ?? [])
      .filter((interval) => interval.classification === "ANCHORED_SEQUENCE_EXACT" && interval.mappings.length > 0)
      .map((interval) => ({
        start: interval.mappings[0].syncTime.getTime(),
        end: interval.upper.syncTime.getTime(),
      })));
  }
  if (windows.length === 0 && input.boundaries.length > 0) {
    const times = input.boundaries.map((boundary) => boundary.syncTime.getTime());
    windows.push({
      start: Math.min(...times),
      end: Math.max(...times),
    });
  }
  if (windows.length === 0) return "OUT_OF_SCOPE";
  const preferredTiming = input.history.prepStartTime instanceof Date && Number.isFinite(input.history.prepStartTime.getTime())
    ? input.history.prepStartTime
    : input.history.warStartTime;
  return preferredTiming instanceof Date && Number.isFinite(preferredTiming.getTime()) && windows.some((window) => preferredTiming.getTime() >= window.start && preferredTiming.getTime() < window.end)
    ? "IN_SCOPE"
    : "OUT_OF_SCOPE";
}

/** Purpose: prove or reject a numbered interval using only canonical endpoints and persisted schedules. */
export function classifyAnchoredSequenceInterval(input: {
  lower: ReconciliationAnchor;
  upper: ReconciliationAnchor;
  schedules: readonly ReconciliationSchedule[];
  existingCycles: readonly ReconciliationCycle[];
}): AnchorIntervalPlan {
  const { lower, upper } = input;
  const reasons = new Set<string>();
  if (lower.guildId !== upper.guildId) reasons.add("anchor_guild_mismatch");
  if (!(upper.syncNumber > lower.syncNumber)) reasons.add("upper_sync_number_not_greater");
  if (!(upper.syncTime.getTime() > lower.syncTime.getTime())) reasons.add("upper_sync_time_not_greater");

  const eligibleSchedules = input.schedules
    .filter((schedule) => schedule.guildId === lower.guildId && scheduleIsEligible(schedule))
    .filter((schedule) => schedule.syncTime.getTime() > lower.syncTime.getTime() && schedule.syncTime.getTime() < upper.syncTime.getTime())
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));

  const times = new Set<number>();
  for (const schedule of eligibleSchedules) {
    if (times.has(schedule.syncTime.getTime())) reasons.add("duplicate_eligible_schedule_time");
    times.add(schedule.syncTime.getTime());
  }

  const expectedMissingSyncCount = Math.max(0, upper.syncNumber - lower.syncNumber - 1);
  if (eligibleSchedules.length !== expectedMissingSyncCount) reasons.add("schedule_count_does_not_match_numeric_gap");

  const cyclesByTime = new Map<number, ReconciliationCycle[]>();
  for (const cycle of input.existingCycles.filter((candidate) => candidate.guildId === lower.guildId)) {
    const rows = cyclesByTime.get(cycle.syncTime.getTime()) ?? [];
    rows.push(cycle);
    cyclesByTime.set(cycle.syncTime.getTime(), rows);
  }
  for (const [index, schedule] of eligibleSchedules.entries()) {
    const expectedSyncNumber = lower.syncNumber + index + 1;
    for (const cycle of cyclesByTime.get(schedule.syncTime.getTime()) ?? []) {
      if (cycle.syncNumber !== expectedSyncNumber) reasons.add("schedule_collides_with_contradictory_sync_cycle");
      else reasons.add("schedule_collides_with_existing_sync_cycle");
    }
  }

  const mappings = reasons.size === 0
    ? eligibleSchedules.map((schedule, index) => ({
        guildId: lower.guildId,
        syncNumber: lower.syncNumber + index + 1,
        syncTime: schedule.syncTime,
        scheduledSyncPostId: schedule.id,
        lowerSyncNumber: lower.syncNumber,
        upperSyncNumber: upper.syncNumber,
      }))
    : [];
  return {
    guildId: lower.guildId,
    lower,
    upper,
    expectedMissingSyncCount,
    eligibleScheduleCount: eligibleSchedules.length,
    classification: reasons.size === 0 ? "ANCHORED_SEQUENCE_EXACT" : "AMBIGUOUS_SEQUENCE",
    reasons: uniqueSorted(reasons),
    eligibleSchedules,
    mappings,
  };
}

/** Purpose: classify every adjacent canonical anchor interval in deterministic order. */
export function planAnchoredSequenceIntervals(input: {
  guildId: string;
  anchors: readonly ReconciliationAnchor[];
  schedules: readonly ReconciliationSchedule[];
  existingCycles: readonly ReconciliationCycle[];
  fromSync?: number;
  toSync?: number;
}): AnchorIntervalPlan[] {
  const anchors = input.anchors
    .filter((anchor) => anchor.guildId === input.guildId)
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());
  const plans: AnchorIntervalPlan[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const plan = classifyAnchoredSequenceInterval({
      lower: anchors[index - 1],
      upper: anchors[index],
      schedules: input.schedules,
      existingCycles: input.existingCycles,
    });
    plans.push(plan);
  }
  return plans;
}

/** Purpose: associate canonical histories with a guild without treating raw points sync numbers as authority. */
export function associateCanonicalHistories(input: {
  guildId: string;
  histories: readonly ReconciliationHistory[];
  points: readonly ReconciliationPoint[];
  evaluations: readonly ReconciliationEvaluation[];
}): AssociatedHistory[] {
  const conflictingRawOwners = membershipHistoryConflictingPersistedOwnerKeys(input.points);
  const associated: AssociatedHistory[] = [];
  for (const history of input.histories) {
    if (comparable(history.matchType) !== "FWA") continue;
    const matchingPoints = input.points.filter((point) => {
      const exactTupleMatch = historicalHistoryMatchesPointByExactTuple(history, point);
      return point.isFwa && point.guildId === input.guildId && exactTupleMatch;
    });
    const evaluations = input.evaluations.filter((evaluation) =>
      evaluation.guildId === input.guildId && evaluation.warId === history.warId &&
      (evaluation.clanTag === null || normalizeMembershipHistoryClanTag(evaluation.clanTag) === normalizeMembershipHistoryClanTag(history.clanTag)) &&
      comparable(evaluation.matchType) === "FWA",
    );
    if (matchingPoints.length === 0 && evaluations.length === 0) continue;

    const owners = input.points
      .filter((point) => point.isFwa && point.warId === history.warId && normalizeMembershipHistoryClanTag(point.clanTag) === normalizeMembershipHistoryClanTag(history.clanTag))
      .map((point) => `${point.guildId ?? ""}|${point.syncNumber}`);
    const reasons = new Set<string>();
    if (conflictingRawOwners.has(`${normalizeMembershipHistoryClanTag(history.clanTag)}|${history.warId}`)) reasons.add("raw_war_identity_claimed_by_multiple_sync_owners");
    if (new Set(owners).size > 1) reasons.add("history_has_multiple_persisted_sync_claims");
    associated.push({
      history,
      points: matchingPoints,
      hasEvaluation: evaluations.length > 0,
      ambiguousReasons: uniqueSorted(reasons),
    });
  }
  return associated.sort((left, right) => left.history.warId - right.history.warId || canonicalHistoryKey(left.history).localeCompare(canonicalHistoryKey(right.history)));
}

/** Purpose: find schedules that satisfy the live 24-hour lookback relationship for one ended war. */
export function schedulesForHistory(
  history: ReconciliationHistory,
  boundaries: readonly ProposedSyncBoundary[],
): ProposedSyncBoundary[] {
  if (!history.prepStartTime || !Number.isFinite(history.prepStartTime.getTime())) return [];
  const prepTime = history.prepStartTime.getTime();
  return boundaries
    .filter((boundary) => {
      const scheduleTime = boundary.syncTime.getTime();
      return scheduleTime <= prepTime && prepTime - scheduleTime <= HISTORICAL_SYNC_LOOKBACK_MS;
    })
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.syncNumber - right.syncNumber);
}

/** Purpose: classify a canonical FWA history against schedule boundaries proven by anchors. */
export function classifyHistorySyncClaim(input: {
  history: ReconciliationHistory;
  associated: AssociatedHistory;
  boundaries: readonly ProposedSyncBoundary[];
}): HistoryClaimResult {
  const candidates = schedulesForHistory(input.history, input.boundaries);
  const reasons = new Set(input.associated.ambiguousReasons);
  if (!input.history.prepStartTime) reasons.add("missing_prep_start_time");
  if (candidates.length === 0) reasons.add("no_unique_reconstructed_schedule");
  if (candidates.length > 1) reasons.add("history_maps_to_multiple_reconstructed_schedules");
  if (reasons.size > 0 || candidates.length !== 1) {
    return { classification: "SYNC_AMBIGUOUS", expectedSyncNumber: null, candidates, reasons: uniqueSorted(reasons) };
  }
  const expectedSyncNumber = candidates[0].syncNumber;
  return {
    classification: input.history.syncNumber === expectedSyncNumber ? "SYNC_MATCH" : "SYNC_CORRECTABLE",
    expectedSyncNumber,
    candidates,
    reasons: [],
  };
}

/** Purpose: classify corroborating ClanPointsSync claims without allowing them to override canonical schedule proof. */
export function classifyPointsSyncClaim(input: {
  expectedSyncNumber: number | null;
  associated: AssociatedHistory;
}): PointsClaimResult {
  if (input.expectedSyncNumber === null || input.associated.ambiguousReasons.length > 0) {
    return { classification: "POINTS_AMBIGUOUS", reasons: input.associated.ambiguousReasons.length > 0 ? input.associated.ambiguousReasons : ["history_sync_mapping_ambiguous"] };
  }
  if (input.associated.points.length === 0) return { classification: "POINTS_AMBIGUOUS", reasons: ["no_points_claim"] };
  const claims = new Set(input.associated.points.map((point) => point.syncNumber));
  if (claims.size === 1 && claims.has(input.expectedSyncNumber)) return { classification: "POINTS_MATCH", reasons: [] };
  if (claims.size === 1) return { classification: "POINTS_CORRECTABLE", reasons: ["stored_points_sync_number_differs"] };
  return { classification: "POINTS_AMBIGUOUS", reasons: ["multiple_points_sync_numbers"] };
}
