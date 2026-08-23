import {
  hasMembershipHistoryIdentityConflict,
  hasMembershipHistoryPartialIdentityConflict,
  hasMembershipHistorySyncNumberDisagreement,
  historicalHistoryMatchesPoint,
  membershipCanonicalHistoryKey,
  normalizeMembershipHistoryClanTag,
  type MembershipCanonicalHistoryIdentity,
  type MembershipHistoryPointIdentity,
} from "./membershipHistoryIdentity";
import {
  persistResolvedSyncCycle,
  type SyncCycleBindingResult,
  type SyncCyclePersistenceDb,
  type SyncCycleResolvedBindingInput,
} from "./SyncCycleService";

const SCHEDULE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type MembershipSyncFilter = Set<number> | null;

export type MembershipHistorySyncCycleBackfillDb = SyncCyclePersistenceDb & {
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  scheduledSyncPost: { findMany: (args?: any) => Promise<any[]> };
  syncCycle: SyncCyclePersistenceDb["syncCycle"] & {
    findMany: (args?: any) => Promise<any[]>;
  };
  $transaction?: <T>(callback: (tx: MembershipHistorySyncCycleBackfillDb) => Promise<T>) => Promise<T>;
};

export type MembershipSyncCycleBackfillAction = "CREATE" | "ALREADY_PRESENT" | "SKIP" | "CONFLICT";

export type MembershipSyncCycleBackfillPlanRow = {
  guildId: string;
  syncNumber: number;
  action: MembershipSyncCycleBackfillAction;
  candidateSyncTime: Date | null;
  scheduledSyncPostId: string | null;
  canonicalHistoryCount: number;
  reasons: string[];
};

export type MembershipSyncCycleBackfillPlan = {
  guildId: string;
  rows: MembershipSyncCycleBackfillPlanRow[];
  considered: number;
  creatable: number;
  alreadyPresent: number;
  skipped: number;
  conflicts: number;
};

type PointIdentity = MembershipHistoryPointIdentity & { isFwa: boolean };
type HistoryIdentity = MembershipCanonicalHistoryIdentity & {
  matchType: string | null;
  prepStartTime: Date | null;
  warEndTime: Date | null;
};
type ScheduleIdentity = { id: string; guildId: string; syncTime: Date; status: string };
type CycleIdentity = { guildId: string; syncNumber: number; syncTime: Date };

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeComparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function normalizePoint(row: any): PointIdentity | null {
  const guildId = normalizeGuildId(row?.guildId);
  const syncNumber = normalizePositiveInteger(row?.syncNum);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const warStartTime = normalizeDate(row?.warStartTime);
  const opponentTag = normalizeMembershipHistoryClanTag(row?.opponentTag);
  if (!guildId || !syncNumber || !clanTag || !warStartTime || !opponentTag) return null;
  return {
    guildId,
    syncNumber,
    warId: normalizePositiveInteger(row?.warId),
    clanTag,
    warStartTime,
    opponentTag,
    isFwa: row?.isFwa === true || normalizeComparable(row?.matchType) === "FWA",
  };
}

function normalizeHistory(row: any): HistoryIdentity | null {
  const warId = normalizePositiveInteger(row?.warId);
  const clanTag = normalizeMembershipHistoryClanTag(row?.clanTag);
  const warEndTime = normalizeDate(row?.warEndTime);
  if (!warId || !clanTag || !warEndTime || normalizeComparable(row?.matchType) !== "FWA") return null;
  return {
    warId,
    syncNumber: normalizePositiveInteger(row?.syncNumber),
    clanTag,
    warStartTime: normalizeDate(row?.warStartTime),
    opponentTag: row?.opponentTag == null ? null : normalizeMembershipHistoryClanTag(row.opponentTag),
    matchType: normalizeComparable(row?.matchType),
    prepStartTime: normalizeDate(row?.prepStartTime),
    warEndTime,
  };
}

function normalizeSchedule(row: any): ScheduleIdentity | null {
  const id = String(row?.id ?? "").trim();
  const guildId = normalizeGuildId(row?.guildId);
  const syncTime = normalizeDate(row?.syncTime);
  if (!id || !guildId || !syncTime) return null;
  return { id, guildId, syncTime, status: normalizeComparable(row?.status) };
}

function normalizeCycle(row: any): CycleIdentity | null {
  const guildId = normalizeGuildId(row?.guildId);
  const syncNumber = normalizePositiveInteger(row?.syncNumber);
  const syncTime = normalizeDate(row?.syncTime);
  if (!guildId || !syncNumber || !syncTime) return null;
  return { guildId, syncNumber, syncTime };
}

function uniquePoints(points: PointIdentity[]): PointIdentity[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${point.guildId}|${point.syncNumber}|${point.warId ?? "null"}|${point.clanTag}|${point.warStartTime.getTime()}|${point.opponentTag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueHistories(histories: HistoryIdentity[]): HistoryIdentity[] {
  const seen = new Set<string>();
  return histories.filter((history) => {
    const key = `${history.warId}|${history.syncNumber ?? "null"}|${history.clanTag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseOwnerKey(point: PointIdentity): string {
  return `${point.guildId ?? ""}|${point.syncNumber}`;
}

function scheduleCandidates(guildId: string, history: HistoryIdentity, schedules: readonly ScheduleIdentity[]): ScheduleIdentity[] {
  if (!history.prepStartTime) return [];
  const lower = history.prepStartTime.getTime() - SCHEDULE_LOOKBACK_MS;
  const upper = history.prepStartTime.getTime();
  return schedules
    .filter((schedule) => schedule.guildId === guildId &&
      !["CANCELLED", "REPLACED"].includes(schedule.status) &&
      schedule.syncTime.getTime() >= lower && schedule.syncTime.getTime() <= upper)
    .sort((left, right) => left.syncTime.getTime() - right.syncTime.getTime() || left.id.localeCompare(right.id));
}

function historyOwnerConflictReasons(
  points: readonly PointIdentity[],
  allPoints: readonly PointIdentity[],
  histories: readonly HistoryIdentity[],
): Map<string, Set<string>> {
  const reasonsByOwner = new Map<string, Set<string>>();
  const add = (owner: string, reason: string) => {
    const reasons = reasonsByOwner.get(owner) ?? new Set<string>();
    reasons.add(reason);
    reasonsByOwner.set(owner, reasons);
  };
  const matchedOwnersByHistory = new Map<string, Set<string>>();
  const matchedClansByWar = new Map<number, Set<string>>();

  for (const point of allPoints) {
    if (!point.isFwa) continue;
    const owner = parseOwnerKey(point);
    const sameOwnerPoints = allPoints.filter((candidate) =>
      candidate.guildId === point.guildId && candidate.syncNumber === point.syncNumber);
    if (hasMembershipHistorySyncNumberDisagreement(point, histories)) add(owner, "persisted_sync_number_disagreement");
    if (hasMembershipHistoryIdentityConflict(point, sameOwnerPoints)) add(owner, "conflicting_war_identities");
    if (hasMembershipHistoryPartialIdentityConflict(point, allPoints)) add(owner, "conflicting_partial_war_identity_across_sync_buckets");
    for (const history of histories) {
      if (!historicalHistoryMatchesPoint(history, point)) continue;
      const historyKey = membershipCanonicalHistoryKey(history);
      const owners = matchedOwnersByHistory.get(historyKey) ?? new Set<string>();
      owners.add(owner);
      matchedOwnersByHistory.set(historyKey, owners);
      const clans = matchedClansByWar.get(history.warId) ?? new Set<string>();
      clans.add(normalizeMembershipHistoryClanTag(history.clanTag));
      matchedClansByWar.set(history.warId, clans);
    }
  }

  for (const [historyKey, owners] of matchedOwnersByHistory) {
    if (owners.size <= 1) continue;
    for (const owner of owners) add(owner, "history_maps_to_multiple_guild_sync_owners");
    const [warIdText] = historyKey.split("|");
    const warId = Number(warIdText);
    for (const point of allPoints.filter((candidate) => owners.has(parseOwnerKey(candidate)))) {
      if (point.warId === warId || point.warId === null) add(parseOwnerKey(point), "history_maps_to_multiple_guild_sync_owners");
    }
  }
  for (const [warId, clans] of matchedClansByWar) {
    if (clans.size <= 1) continue;
    for (const point of allPoints.filter((candidate) => candidate.warId === warId)) {
      add(parseOwnerKey(point), "contradictory_clan_ownership");
    }
  }
  for (const point of points) {
    if (!point.isFwa) add(parseOwnerKey(point), "non_fwa_cycle");
  }
  return reasonsByOwner;
}

function canonicalMatchesForOwner(
  points: readonly PointIdentity[],
  histories: readonly HistoryIdentity[],
  owner: string,
): HistoryIdentity[] {
  return uniqueHistories(histories.filter((history) => points.some((point) =>
    parseOwnerKey(point) === owner && historicalHistoryMatchesPoint(history, point))));
}

function summarizeReasons(reasons: Iterable<string>): string[] {
  return [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
}

export class MembershipHistorySyncCycleBackfillService {
  constructor(private readonly db: MembershipHistorySyncCycleBackfillDb) {}

  async plan(guildIdInput: string, syncFilter: MembershipSyncFilter = null): Promise<MembershipSyncCycleBackfillPlan> {
    const guildId = normalizeGuildId(guildIdInput);
    if (!guildId) throw new Error("guild ID is required");
    const syncWhere = syncFilter ? { syncNum: { in: [...syncFilter] } } : {};
    const scopedPointRows = await this.db.clanPointsSync.findMany({
      where: { guildId, ...syncWhere },
      select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true },
    });
    const scopedEvaluationRows = await this.db.warPlanComplianceEvaluation.findMany({
      where: { guildId },
      select: {
        guildId: true,
        warId: true,
        matchType: true,
        warHistory: { select: { warId: true, syncNumber: true, matchType: true, clanTag: true, warStartTime: true, opponentTag: true } },
      },
    });
    const scopedPoints = uniquePoints(scopedPointRows.map(normalizePoint).filter((point): point is PointIdentity => Boolean(point)));
    const evaluationPoints = scopedEvaluationRows.map((row) => normalizePoint({
      guildId: row.guildId,
      syncNum: row.warHistory?.syncNumber,
      warId: row.warId,
      clanTag: row.warHistory?.clanTag,
      warStartTime: row.warHistory?.warStartTime,
      opponentTag: row.warHistory?.opponentTag,
      isFwa: normalizeComparable(row.matchType ?? row.warHistory?.matchType) === "FWA",
    })).filter((point): point is PointIdentity => Boolean(point));
    const targetPoints = uniquePoints([...scopedPoints, ...evaluationPoints]).filter((point) => syncFilter === null || syncFilter.has(point.syncNumber));
    const syncNumbers = new Set(targetPoints.map((point) => point.syncNumber));
    const allPointRows = syncNumbers.size > 0
      ? await this.db.clanPointsSync.findMany({
          where: { syncNum: { in: [...syncNumbers] } },
          select: { guildId: true, syncNum: true, warId: true, clanTag: true, warStartTime: true, opponentTag: true, isFwa: true },
        })
      : [];
    const allPoints = uniquePoints([
      ...allPointRows.map(normalizePoint).filter((point): point is PointIdentity => Boolean(point)),
      ...targetPoints,
    ]);
    const rawWarIds = [...new Set(allPoints.map((point) => point.warId).filter((warId): warId is number => warId !== null))];
    const rawHistories = syncNumbers.size > 0
      ? await this.db.clanWarHistory.findMany({
          where: {
            OR: [
              { syncNumber: { in: [...syncNumbers] } },
              ...rawWarIds.map((warId) => ({ warId })),
            ],
          },
          select: {
            warId: true,
            syncNumber: true,
            matchType: true,
            clanTag: true,
            warStartTime: true,
            opponentTag: true,
            prepStartTime: true,
            warEndTime: true,
          },
        })
      : [];
    const histories = uniqueHistories(rawHistories.map(normalizeHistory).filter((history): history is HistoryIdentity => Boolean(history)));
    const schedules = (await this.db.scheduledSyncPost.findMany({
      where: { guildId },
      select: { id: true, guildId: true, syncTime: true, status: true },
    })).map(normalizeSchedule).filter((schedule): schedule is ScheduleIdentity => Boolean(schedule));
    const existingCycles = (await this.db.syncCycle.findMany({
      where: { guildId },
      select: { guildId: true, syncNumber: true, syncTime: true },
    })).map(normalizeCycle).filter((cycle): cycle is CycleIdentity => Boolean(cycle));
    const reasonsByOwner = historyOwnerConflictReasons(targetPoints, allPoints, histories);
    const targetSyncNumbers = [...new Set(targetPoints.map((point) => point.syncNumber).concat(syncFilter ? [...syncFilter] : []))].sort((a, b) => a - b);
    const rows = targetSyncNumbers.map((syncNumber): MembershipSyncCycleBackfillPlanRow => {
      const owner = `${guildId}|${syncNumber}`;
      const points = targetPoints.filter((point) => point.guildId === guildId && point.syncNumber === syncNumber && point.isFwa);
      const canonicalHistories = canonicalMatchesForOwner(points, histories, owner);
      const reasons = new Set(reasonsByOwner.get(owner) ?? []);
      if (points.length === 0) reasons.add("no_guild_owned_historical_identity");
      if (canonicalHistories.length === 0 && reasons.size === 0) reasons.add("no_canonical_history");
      const resolvedSchedules = new Map<string, ScheduleIdentity>();
      let scheduleResolutionFailed = false;
      for (const history of canonicalHistories) {
        const candidates = scheduleCandidates(guildId, history, schedules);
        if (candidates.length === 0) {
          scheduleResolutionFailed = true;
          reasons.add(history.prepStartTime ? "no_eligible_schedule" : "missing_prep_start_time");
        } else if (candidates.length > 1) {
          scheduleResolutionFailed = true;
          reasons.add("multiple_eligible_scheduled_posts");
        } else {
          resolvedSchedules.set(candidates[0].id, candidates[0]);
        }
      }
      if (resolvedSchedules.size > 1) reasons.add("histories_resolve_to_different_schedules");
      if (reasons.size > 0 && [...reasons].some((reason) => [
        "persisted_sync_number_disagreement",
        "conflicting_war_identities",
        "conflicting_partial_war_identity_across_sync_buckets",
        "history_maps_to_multiple_guild_sync_owners",
        "contradictory_clan_ownership",
        "multiple_eligible_scheduled_posts",
        "histories_resolve_to_different_schedules",
      ].includes(reason))) {
        return {
          guildId,
          syncNumber,
          action: "CONFLICT",
          candidateSyncTime: null,
          scheduledSyncPostId: null,
          canonicalHistoryCount: canonicalHistories.length,
          reasons: summarizeReasons(reasons),
        };
      }
      if (canonicalHistories.length === 0 || scheduleResolutionFailed || resolvedSchedules.size !== 1) {
        return {
          guildId,
          syncNumber,
          action: "SKIP",
          candidateSyncTime: !scheduleResolutionFailed && resolvedSchedules.size === 1 ? [...resolvedSchedules.values()][0].syncTime : null,
          scheduledSyncPostId: !scheduleResolutionFailed && resolvedSchedules.size === 1 ? [...resolvedSchedules.values()][0].id : null,
          canonicalHistoryCount: canonicalHistories.length,
          reasons: summarizeReasons(reasons.size > 0 ? reasons : ["no_eligible_schedule"]),
        };
      }
      const schedule = [...resolvedSchedules.values()][0];
      const existingByNumber = existingCycles.find((cycle) => cycle.syncNumber === syncNumber);
      const existingByTime = existingCycles.find((cycle) => cycle.syncTime.getTime() === schedule.syncTime.getTime());
      if (existingByNumber && existingByNumber.syncTime.getTime() !== schedule.syncTime.getTime()) {
        return { guildId, syncNumber, action: "CONFLICT", candidateSyncTime: schedule.syncTime, scheduledSyncPostId: schedule.id, canonicalHistoryCount: canonicalHistories.length, reasons: ["sync_number_already_mapped"] };
      }
      if (existingByTime && existingByTime.syncNumber !== syncNumber) {
        return { guildId, syncNumber, action: "CONFLICT", candidateSyncTime: schedule.syncTime, scheduledSyncPostId: schedule.id, canonicalHistoryCount: canonicalHistories.length, reasons: ["sync_time_already_mapped"] };
      }
      if (existingByNumber || existingByTime) {
        return { guildId, syncNumber, action: "ALREADY_PRESENT", candidateSyncTime: schedule.syncTime, scheduledSyncPostId: schedule.id, canonicalHistoryCount: canonicalHistories.length, reasons: ["exact_mapping_already_present"] };
      }
      return { guildId, syncNumber, action: "CREATE", candidateSyncTime: schedule.syncTime, scheduledSyncPostId: schedule.id, canonicalHistoryCount: canonicalHistories.length, reasons: [] };
    });
    return {
      guildId,
      rows,
      considered: rows.length,
      creatable: rows.filter((row) => row.action === "CREATE").length,
      alreadyPresent: rows.filter((row) => row.action === "ALREADY_PRESENT").length,
      skipped: rows.filter((row) => row.action === "SKIP").length,
      conflicts: rows.filter((row) => row.action === "CONFLICT").length,
    };
  }

  async apply(plan: MembershipSyncCycleBackfillPlan): Promise<SyncCycleBindingResult[]> {
    if (plan.conflicts > 0) throw new Error("Apply aborted: the complete selected plan contains CONFLICT rows.");
    const createRows = plan.rows.filter((row) => row.action === "CREATE");
    if (createRows.length === 0) return [];
    if (!this.db.$transaction) throw new Error("Apply requires a transactional database delegate.");
    return this.db.$transaction(async (tx) => {
      const results: SyncCycleBindingResult[] = [];
      for (const row of createRows) {
        if (!row.candidateSyncTime || !row.scheduledSyncPostId) throw new Error(`CREATE row missing schedule for sync ${row.syncNumber}`);
        const input: SyncCycleResolvedBindingInput = {
          guildId: row.guildId,
          syncNumber: row.syncNumber,
          syncTime: row.candidateSyncTime,
          scheduledSyncPostId: row.scheduledSyncPostId,
        };
        const result = await persistResolvedSyncCycle(tx, input);
        if (result.status === "conflict" || result.status === "failed") {
          throw new Error(`Apply aborted for sync ${row.syncNumber}: ${result.status} ${"reason" in result ? result.reason : ""}`.trim());
        }
        results.push(result);
      }
      return results;
    });
  }
}
