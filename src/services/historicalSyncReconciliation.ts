import {
  historicalHistoryMatchesPointByExactTuple,
  membershipHistoryConflictingPersistedOwnerKeys,
  normalizeMembershipHistoryClanTag,
  type MembershipCanonicalHistoryIdentity,
  type MembershipHistoryPointIdentity,
} from "./membershipHistoryIdentity";

export const HISTORICAL_SYNC_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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

/** Purpose: decide reconciliation scope from persisted war timing, independently of whether prep time yields a schedule candidate. */
export function classifyReconciliationHistoryScope(input: {
  history: ReconciliationHistory;
  boundaries: readonly ProposedSyncBoundary[];
  intervals?: readonly AnchorIntervalPlan[];
}): ReconciliationHistoryScope {
  const windows = (input.intervals ?? [])
    .filter((interval) => interval.classification === "ANCHORED_SEQUENCE_EXACT")
    .map((interval) => ({
      start: interval.lower.syncTime.getTime(),
      end: interval.upper.syncTime.getTime() + HISTORICAL_SYNC_LOOKBACK_MS,
    }));
  if (windows.length === 0 && input.boundaries.length > 0) {
    const times = input.boundaries.map((boundary) => boundary.syncTime.getTime());
    windows.push({
      start: Math.min(...times),
      end: Math.max(...times) + HISTORICAL_SYNC_LOOKBACK_MS,
    });
  }
  if (windows.length === 0) return "OUT_OF_SCOPE";
  const timing = [input.history.prepStartTime, input.history.warStartTime]
    .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
  return timing.some((value) => windows.some((window) => value.getTime() >= window.start && value.getTime() <= window.end))
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
  const lowerBound = input.fromSync === undefined ? Number.NEGATIVE_INFINITY : input.fromSync - 1;
  const upperBound = input.toSync === undefined ? Number.POSITIVE_INFINITY : input.toSync + 1;
  const anchors = input.anchors
    .filter((anchor) => anchor.guildId === input.guildId)
    .filter((anchor) => anchor.syncNumber >= lowerBound && anchor.syncNumber <= upperBound)
    .sort((left, right) => left.syncNumber - right.syncNumber || left.syncTime.getTime() - right.syncTime.getTime());
  const plans: AnchorIntervalPlan[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const plan = classifyAnchoredSequenceInterval({
      lower: anchors[index - 1],
      upper: anchors[index],
      schedules: input.schedules,
      existingCycles: input.existingCycles,
    });
    if (input.fromSync !== undefined || input.toSync !== undefined) {
      plan.mappings = plan.mappings.filter((mapping) =>
        (input.fromSync === undefined || mapping.syncNumber >= input.fromSync) &&
        (input.toSync === undefined || mapping.syncNumber <= input.toSync));
    }
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
