import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import {
  computeWarPointsDeltaForTest,
  normalizeTag,
  type MatchType,
  type WarEndResultSnapshot,
} from "./war-events/core";
import { ActiveWarSyncResolutionService } from "./ActiveWarSyncResolutionService";

type PointsSyncReadRow = {
  clanTag: string;
  warId: string | null;
  warStartTime: Date;
  syncNum: number;
  opponentTag: string;
  clanPoints: number | null;
  opponentPoints: number | null;
  outcome: string | null;
  isFwa: boolean;
  syncFetchedAt: Date;
  lastSuccessfulPointsApiFetchAt: Date | null;
  needsValidation: boolean;
  lastKnownPoints: number | null;
  lastKnownMatchType: string | null;
  lastKnownOutcome: string | null;
  lastKnownSyncNumber: number | null;
};

type WarHistoryReadRow = {
  warId: number;
  syncNumber: number | null;
  matchType: MatchType | null;
  clanStars: number | null;
  clanDestruction: number | null;
  opponentStars: number | null;
  opponentDestruction: number | null;
  pointsAfterWar: number | null;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  clanTag: string;
  opponentTag: string | null;
};

type WarLookupReadRow = {
  warId: string;
  payload: unknown;
};

type ReadDelegate = {
  findMany: (args: unknown) => Promise<unknown[]>;
};

type FindFirstDelegate = {
  findFirst: (args: unknown) => Promise<unknown | null>;
};

export type PointsEstimateReadDb = {
  clanPointsSync: ReadDelegate;
  clanWarHistory: ReadDelegate;
  warLookup?: ReadDelegate;
  syncCycle?: FindFirstDelegate;
};

export type PointsEstimateActiveWarContext = {
  /** Tracked clan whose active-war row provides counterpart evidence. */
  trackedClanTag?: string | null;
  warId?: string | number | null;
  warStartTime: Date;
  prepStartTime?: Date | null;
  opponentTag: string;
  /** An already resolved sync number may be supplied by the caller. */
  syncNumber?: number | null;
  /** Exact SyncCycle time, when the caller already has it. */
  syncTime?: Date | null;
  matchType?: string | null;
  inferredMatchType?: boolean | null;
  warState?: "preparation" | "inWar" | "notInWar";
};

export type PointsEstimateBaseline = {
  clanTag: string;
  sourceClanTag: string | null;
  warId: string | number | null;
  syncNumber: number | null;
  warStartTime: Date | null;
  observedAt: Date | null;
  kind: "observed" | "derived";
};

export type PointsEstimateSource =
  | "validated_same_war"
  | "validated_same_war_opponent_observation"
  | "history_reconstruction"
  | "last_known_observed"
  | "last_known_derived"
  | "unavailable";

export type PointsEstimateCoverage =
  | "complete_reconstruction"
  | "last_known_unresolved_history"
  | "no_usable_balance";

export type PointsEstimateResult = {
  balance: number | null;
  source: PointsEstimateSource;
  provenance: PointsEstimateBaseline | null;
  baseline: PointsEstimateBaseline | null;
  isEstimate: boolean;
  isValidatedCurrentMatchupEvidence: boolean;
  coverage: PointsEstimateCoverage;
  projectionSafe: boolean;
  syncNumber: number | null;
  syncNumberSource:
    | "caller_context"
    | "same_war_points"
    | "canonical_sync_cycle"
    | "active_war_schedule_candidate"
    | "unavailable";
  appliedWarIds: number[];
  reason: string;
};

type ResolverInput = {
  guildId: string;
  clanTag: string;
  activeWar: PointsEstimateActiveWarContext;
};

type BalanceCandidate = {
  balance: number;
  baseline: PointsEstimateBaseline;
  needsValidation: boolean;
};

/** Purpose: normalize a finite persisted number to an integer without turning null into zero. */
function finiteInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

/** Purpose: accept only valid persisted dates for chronology decisions. */
function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: compare clan tags using the repository's canonical normalization. */
function sameTag(left: string | null | undefined, right: string): boolean {
  return normalizeTag(left ?? "") === normalizeTag(right);
}

/** Purpose: compare two persisted timestamps by instant. */
function sameDate(left: Date | null | undefined, right: Date | null | undefined): boolean {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime();
}

/** Purpose: match a persisted war row to an active identity using war ID or exact start time. */
function sameWar(
  row: { warId: string | number | null; warStartTime: Date },
  activeWar: PointsEstimateActiveWarContext,
): boolean {
  const activeWarId = String(activeWar.warId ?? "").trim();
  if (activeWarId.length > 0 && row.warId !== null) return String(row.warId) === activeWarId;
  const byStart = sameDate(row.warStartTime, activeWar.warStartTime);
  return byStart;
}

/** Purpose: reject point observations that belong to a later sync or war. */
function isBeforeActiveWar(
  row: { syncNumber: number | null; warStartTime: Date; checkpointSyncNumber?: number | null },
  activeWar: PointsEstimateActiveWarContext,
  activeSyncNumber: number | null,
): boolean {
  if (!validDate(row.warStartTime) || row.warStartTime.getTime() > activeWar.warStartTime.getTime()) return false;
  const checkpointSyncNumber = row.checkpointSyncNumber ?? row.syncNumber;
  return activeSyncNumber === null || checkpointSyncNumber === null || checkpointSyncNumber <= activeSyncNumber;
}

/** Purpose: accept only match types whose point rules are implemented by the shared core. */
function parseMatchType(value: unknown): MatchType {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "FWA" || normalized === "MM" || normalized === "BL" ? normalized : null;
}

/** Purpose: normalize canonical actual results while preserving TIE as distinct from unknown. */
function normalizeActualOutcome(value: unknown): "WIN" | "LOSE" | "TIE" | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "WIN" || normalized === "LOSE" || normalized === "TIE" ? normalized : null;
}

/** Purpose: translate canonical ended-war fields into the shared rule-engine result shape. */
function historyResult(row: WarHistoryReadRow): WarEndResultSnapshot {
  const actualOutcome = normalizeActualOutcome(row.actualOutcome);
  return {
    clanStars: finiteInt(row.clanStars),
    opponentStars: finiteInt(row.opponentStars),
    clanDestruction: finiteNumber(row.clanDestruction),
    opponentDestruction: finiteNumber(row.opponentDestruction),
    warEndTime: validDate(row.warEndTime) ? row.warEndTime : null,
    resultLabel: actualOutcome ?? "UNKNOWN",
  };
}

/** Purpose: normalize a persisted numeric value while preserving missing values as null. */
function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Purpose: prevent the shared BL rule from deciding an award when missing inputs could change it. */
function canComputeDefinitiveBlDelta(row: WarHistoryReadRow, teamSize: number | null): boolean {
  const outcome = normalizeActualOutcome(row.actualOutcome);
  if (outcome === "WIN") return true;
  const stars = finiteInt(row.clanStars);
  const perfect = teamSize === 50 ? stars === 150 : teamSize === 45 ? stars === 135 : false;
  if (perfect) return true;
  if (teamSize === null && (stars === 150 || stars === 135)) return false;
  return finiteNumber(row.clanDestruction) !== null;
}

/** Purpose: read compatibility team-size metadata needed only for the existing BL perfect-war rule. */
function extractTeamSize(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const warMeta = root.warMeta && typeof root.warMeta === "object" && !Array.isArray(root.warMeta)
    ? (root.warMeta as Record<string, unknown>)
    : null;
  return finiteInt(warMeta?.teamSize ?? root.teamSize);
}

/** Purpose: order historical evidence deterministically by sync chronology and war identity. */
function sortByEvidence<T extends { syncNumber: number | null; warStartTime: Date; warId?: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftSync = left.syncNumber ?? Number.MIN_SAFE_INTEGER;
    const rightSync = right.syncNumber ?? Number.MIN_SAFE_INTEGER;
    return leftSync - rightSync || left.warStartTime.getTime() - right.warStartTime.getTime() ||
      (left.warId ?? 0) - (right.warId ?? 0);
  });
}

/** Purpose: resolve a DB-first point estimate without mutating any owner or calling an upstream API. */
export class PointsEstimateResolverService {
  private readonly activeWarSyncResolution: ActiveWarSyncResolutionService;

  public constructor(
    private readonly db: PointsEstimateReadDb = prisma as unknown as PointsEstimateReadDb,
    activeWarSyncResolution?: ActiveWarSyncResolutionService,
  ) {
    this.activeWarSyncResolution = activeWarSyncResolution ?? new ActiveWarSyncResolutionService();
  }

  /** Purpose: resolve one matchup participant independently from evidence associated with that tag. */
  public async resolveForClan(input: ResolverInput): Promise<PointsEstimateResult> {
    const clanTag = normalizeTag(input.clanTag);
    const opponentTag = normalizeTag(input.activeWar.opponentTag);
    const empty = (
      reason: string,
      syncNumber: number | null = null,
      syncNumberSource: PointsEstimateResult["syncNumberSource"] = "unavailable",
    ): PointsEstimateResult => ({
      balance: null,
      source: "unavailable",
      provenance: null,
      baseline: null,
      isEstimate: true,
      isValidatedCurrentMatchupEvidence: false,
      coverage: "no_usable_balance",
      projectionSafe: false,
      syncNumber,
      syncNumberSource,
      appliedWarIds: [],
      reason,
    });

    if (!clanTag || !String(input.guildId ?? "").trim() || !opponentTag || !validDate(input.activeWar.warStartTime)) {
      return empty("incomplete_active_war_context");
    }

    let pointRows: PointsSyncReadRow[] = [];
    let historyRows: WarHistoryReadRow[] = [];
    const trackedClanTag = normalizeTag(input.activeWar.trackedClanTag ?? opponentTag);
    try {
      const rawPointRows = await this.db.clanPointsSync.findMany({
        where: {
          guildId: input.guildId,
          OR: [
            { clanTag },
            { clanTag: trackedClanTag, opponentTag: clanTag },
          ],
        },
        select: {
          clanTag: true,
          warId: true,
          warStartTime: true,
          syncNum: true,
          opponentTag: true,
          clanPoints: true,
          opponentPoints: true,
          outcome: true,
          isFwa: true,
          syncFetchedAt: true,
          lastSuccessfulPointsApiFetchAt: true,
          needsValidation: true,
          lastKnownPoints: true,
          lastKnownMatchType: true,
          lastKnownOutcome: true,
          lastKnownSyncNumber: true,
        },
        orderBy: [{ syncNum: "asc" }, { syncFetchedAt: "asc" }],
      });
      pointRows = rawPointRows as PointsSyncReadRow[];

      const resolvedSync = await this.resolveSyncNumber({ input, pointRows, clanTag, opponentTag });
      const historyLowerBound = pointRows
        .filter((row) =>
          (sameTag(row.clanTag, clanTag)
            ? finiteInt(row.lastKnownPoints) ?? finiteInt(row.clanPoints)
            : sameTag(row.clanTag, trackedClanTag) && sameTag(row.opponentTag, clanTag)
              ? finiteInt(row.opponentPoints)
              : null) !== null,
        )
        .filter((row) => isBeforeActiveWar({
          syncNumber: finiteInt(row.syncNum),
          checkpointSyncNumber: finiteInt(row.lastKnownSyncNumber),
          warStartTime: row.warStartTime,
        }, input.activeWar, resolvedSync.syncNumber))
        .map((row) => row.warStartTime)
        .filter(validDate)
        .sort((left, right) => left.getTime() - right.getTime())[0];
      const historyWhere: Record<string, unknown> = {
        clanTag,
        warEndTime: { not: null },
        warStartTime: {
          ...(historyLowerBound ? { gte: historyLowerBound } : {}),
          lt: input.activeWar.warStartTime,
        },
      };
      const rawHistoryRows = await this.db.clanWarHistory.findMany({
        where: historyWhere,
        select: {
          warId: true,
          syncNumber: true,
          matchType: true,
          clanStars: true,
          clanDestruction: true,
          opponentStars: true,
          opponentDestruction: true,
          pointsAfterWar: true,
          expectedOutcome: true,
          actualOutcome: true,
          warStartTime: true,
          warEndTime: true,
          clanTag: true,
          opponentTag: true,
        },
        orderBy: [{ syncNumber: "asc" }, { warStartTime: "asc" }, { warId: "asc" }],
      });
      historyRows = rawHistoryRows as WarHistoryReadRow[];

      const syncNumber = resolvedSync.syncNumber;

      const sameWarOwn = pointRows
        .filter((row) => sameTag(row.clanTag, clanTag) && sameWar(row, input.activeWar))
        .filter((row) => sameTag(row.opponentTag, opponentTag) && row.needsValidation === false)
        .filter((row) => isBeforeActiveWar({
          syncNumber: finiteInt(row.syncNum),
          checkpointSyncNumber: finiteInt(row.lastKnownSyncNumber),
          warStartTime: row.warStartTime,
        }, input.activeWar, syncNumber))
        .filter((row) => finiteInt(row.syncNum) === syncNumber || syncNumber === null)
        .map((row) => ({ balance: finiteInt(row.clanPoints), row }))
        .filter((candidate): candidate is { balance: number; row: PointsSyncReadRow } => candidate.balance !== null)
        .sort((left, right) => right.row.syncFetchedAt.getTime() - left.row.syncFetchedAt.getTime());
      const direct = sameWarOwn[0];
      if (direct) {
        const baseline = this.baselineFromPointRow({
          clanTag,
          sourceClanTag: clanTag,
          row: direct.row,
          balance: direct.balance,
        });
        this.logChosenSource(clanTag, "validated_same_war", "validated_same_war", syncNumber);
        return {
          balance: direct.balance,
          source: "validated_same_war",
          provenance: baseline,
          baseline,
          isEstimate: false,
          isValidatedCurrentMatchupEvidence: true,
          coverage: "complete_reconstruction",
          projectionSafe: true,
          syncNumber,
          syncNumberSource: resolvedSync.source,
          appliedWarIds: [],
          reason: "validated_same_war_points_sync",
        };
      }

      const sameWarOpponent = pointRows
        .filter(
          (row) =>
            sameTag(row.clanTag, trackedClanTag) &&
            sameTag(row.opponentTag, clanTag),
        )
        .filter((row) => sameWar(row, input.activeWar) && row.needsValidation === false)
        .filter((row) => isBeforeActiveWar({
          syncNumber: finiteInt(row.syncNum),
          checkpointSyncNumber: finiteInt(row.lastKnownSyncNumber),
          warStartTime: row.warStartTime,
        }, input.activeWar, syncNumber))
        .filter((row) => finiteInt(row.syncNum) === syncNumber || syncNumber === null)
        .map((row) => ({ balance: finiteInt(row.opponentPoints), row }))
        .filter((candidate): candidate is { balance: number; row: PointsSyncReadRow } => candidate.balance !== null)
        .sort((left, right) => right.row.syncFetchedAt.getTime() - left.row.syncFetchedAt.getTime())[0];
      if (sameWarOpponent) {
        const baseline = this.baselineFromPointRow({
          clanTag,
          sourceClanTag: sameWarOpponent.row.clanTag,
          row: sameWarOpponent.row,
          balance: sameWarOpponent.balance,
        });
        this.logChosenSource(clanTag, "validated_same_war_opponent_observation", "validated_same_war_opponent_observation", syncNumber);
        return {
          balance: sameWarOpponent.balance,
          source: "validated_same_war_opponent_observation",
          provenance: baseline,
          baseline,
          isEstimate: false,
          isValidatedCurrentMatchupEvidence: true,
          coverage: "complete_reconstruction",
          projectionSafe: true,
          syncNumber,
          syncNumberSource: resolvedSync.source,
          appliedWarIds: [],
          reason: "validated_same_war_opponent_points_observation",
        };
      }

      const historyForClan = historyRows.filter((row) => sameTag(row.clanTag, clanTag));
      const baselineCandidate = this.choosePointBaseline({
        clanTag,
        opponentTag,
        pointRows,
        activeWar: input.activeWar,
        activeSyncNumber: syncNumber,
      });
      const historyBaseline = baselineCandidate ?? this.chooseHistoryBaseline({
        clanTag,
        historyRows: historyForClan,
        activeWar: input.activeWar,
        activeSyncNumber: syncNumber,
      });
      if (!historyBaseline) {
        this.logChosenSource(clanTag, "unavailable", "no_safe_baseline", syncNumber);
        return empty("no_safe_persisted_baseline", syncNumber, resolvedSync.source);
      }

      const lookupTeamSizes = await this.loadTeamSizes(historyForClan);
      const reconstruction = this.reconstructFromHistory({
        baseline: historyBaseline,
        historyRows: historyForClan,
        activeWar: input.activeWar,
        activeSyncNumber: syncNumber,
        lookupTeamSizes,
      });
      const result = {
        ...reconstruction,
        syncNumber,
        syncNumberSource: resolvedSync.source,
      };
      this.logChosenSource(clanTag, result.source, result.reason, syncNumber);
      return result;
    } catch (error) {
      dozzleLog.warn(`[points-estimate] event=resolve outcome=read_failed clan_tag=${clanTag} error=${String(error)}`);
      return empty("database_read_failed");
    }
  }

  /** Purpose: compatibility alias for callers that prefer estimate terminology. */
  public async resolveEstimatedBalance(input: ResolverInput): Promise<PointsEstimateResult> {
    return this.resolveForClan(input);
  }

  /** Purpose: resolve both matchup participants without sharing one clan's balance with the other. */
  public async resolveMatchup(input: {
    guildId: string;
    clanTag: string;
    activeWar: PointsEstimateActiveWarContext;
  }): Promise<{ clan: PointsEstimateResult; opponent: PointsEstimateResult }> {
    const clan = await this.resolveForClan(input);
    const opponent = await this.resolveForClan({
      guildId: input.guildId,
      clanTag: input.activeWar.opponentTag,
      activeWar: {
        ...input.activeWar,
        trackedClanTag: input.clanTag,
        opponentTag: input.clanTag,
      },
    });
    return { clan, opponent };
  }

  /** Purpose: convert one points-sync observation into explicit baseline provenance. */
  private baselineFromPointRow(input: {
    clanTag: string;
    sourceClanTag: string | null;
    row: PointsSyncReadRow;
    balance: number;
  }): PointsEstimateBaseline {
    return {
      clanTag: input.clanTag,
      sourceClanTag: input.sourceClanTag,
      warId: input.row.warId,
      syncNumber: finiteInt(input.row.lastKnownSyncNumber) ?? finiteInt(input.row.syncNum),
      warStartTime: validDate(input.row.warStartTime) ? input.row.warStartTime : null,
      observedAt: validDate(input.row.lastSuccessfulPointsApiFetchAt)
        ? input.row.lastSuccessfulPointsApiFetchAt
        : validDate(input.row.syncFetchedAt)
          ? input.row.syncFetchedAt
          : null,
      kind: "observed",
    };
  }

  /** Purpose: choose the newest point observation that is not from a future war. */
  private choosePointBaseline(input: {
    clanTag: string;
    opponentTag: string;
    pointRows: PointsSyncReadRow[];
    activeWar: PointsEstimateActiveWarContext;
    activeSyncNumber: number | null;
  }): BalanceCandidate | null {
    const candidates: Array<BalanceCandidate & { evidenceTime: number; syncNumber: number }> = [];
    for (const row of input.pointRows) {
      const own = sameTag(row.clanTag, input.clanTag);
      const opponentObservation =
        sameTag(row.clanTag, input.activeWar.trackedClanTag ?? input.activeWar.opponentTag) &&
        sameTag(row.opponentTag, input.clanTag);
      if (!own && !opponentObservation) continue;
      if (!isBeforeActiveWar({
        syncNumber: finiteInt(row.syncNum),
        checkpointSyncNumber: finiteInt(row.lastKnownSyncNumber),
        warStartTime: row.warStartTime,
      }, input.activeWar, input.activeSyncNumber)) continue;
      const balance = own ? finiteInt(row.lastKnownPoints) ?? finiteInt(row.clanPoints) : finiteInt(row.opponentPoints);
      if (balance === null) continue;
      const syncNumber = finiteInt(row.lastKnownSyncNumber) ?? finiteInt(row.syncNum) ?? Number.MIN_SAFE_INTEGER;
      const baseline = own
        ? this.baselineFromPointRow({ clanTag: input.clanTag, sourceClanTag: input.clanTag, row, balance })
        : {
            ...this.baselineFromPointRow({ clanTag: input.clanTag, sourceClanTag: row.clanTag, row, balance }),
            kind: "observed" as const,
          };
      candidates.push({ balance, baseline, needsValidation: row.needsValidation, evidenceTime: row.syncFetchedAt.getTime(), syncNumber });
    }
    return candidates.sort((left, right) => right.syncNumber - left.syncNumber || right.evidenceTime - left.evidenceTime)[0] ?? null;
  }

  /** Purpose: use an ended-war balance as a derived baseline only when its identity and actual result are usable. */
  private chooseHistoryBaseline(input: {
    clanTag: string;
    historyRows: WarHistoryReadRow[];
    activeWar: PointsEstimateActiveWarContext;
    activeSyncNumber: number | null;
  }): BalanceCandidate | null {
    const candidates = input.historyRows
      .filter((row) => validDate(row.warEndTime) && row.warEndTime!.getTime() < input.activeWar.warStartTime.getTime())
      .filter((row) => finiteInt(row.pointsAfterWar) !== null && parseMatchType(row.matchType) !== null)
      .filter((row) => normalizeActualOutcome(row.actualOutcome) !== null || parseMatchType(row.matchType) === "MM")
      .filter((row) => isBeforeActiveWar(row, input.activeWar, input.activeSyncNumber))
      .filter((row) => input.activeSyncNumber === null || row.syncNumber === null || row.syncNumber < input.activeSyncNumber)
      .sort((left, right) => (right.syncNumber ?? Number.MIN_SAFE_INTEGER) - (left.syncNumber ?? Number.MIN_SAFE_INTEGER) || right.warStartTime.getTime() - left.warStartTime.getTime());
    const row = candidates[0];
    if (!row) return null;
    const balance = finiteInt(row.pointsAfterWar);
    if (balance === null) return null;
    const baseline: PointsEstimateBaseline = {
      clanTag: input.clanTag,
      sourceClanTag: input.clanTag,
      warId: row.warId,
      syncNumber: finiteInt(row.syncNumber),
      warStartTime: row.warStartTime,
      observedAt: row.warEndTime,
      kind: "derived",
    };
    return { balance, baseline, needsValidation: true };
  }

  /** Purpose: apply each completed canonical war once, stopping at unknown or non-contiguous evidence. */
  private reconstructFromHistory(input: {
    baseline: BalanceCandidate;
    historyRows: WarHistoryReadRow[];
    activeWar: PointsEstimateActiveWarContext;
    activeSyncNumber: number | null;
    lookupTeamSizes: Map<number, number>;
  }): PointsEstimateResult {
    let balance = input.baseline.balance;
    let lastSync = input.baseline.baseline.syncNumber;
    const appliedWarIds: number[] = [];
    const seenWars = new Set<string>();
    let stoppedReason: string | null = null;
    const rows = sortByEvidence(input.historyRows).filter((row) => {
      if (!validDate(row.warEndTime) || row.warEndTime!.getTime() >= input.activeWar.warStartTime.getTime()) return false;
      if (sameWar(row, input.activeWar)) return false;
      const baselineStart = input.baseline.baseline.warStartTime;
      if (!validDate(baselineStart) || row.warStartTime.getTime() <= baselineStart.getTime()) return false;
      const rowSync = finiteInt(row.syncNumber);
      if (input.activeSyncNumber !== null && rowSync !== null && rowSync >= input.activeSyncNumber) return false;
      if (lastSync !== null && rowSync !== null && rowSync <= lastSync) return false;
      return true;
    });

    for (const row of rows) {
      const key = `${row.warId}|${row.warStartTime.getTime()}|${normalizeTag(row.clanTag)}|${normalizeTag(row.opponentTag ?? "")}`;
      if (seenWars.has(key)) continue;
      seenWars.add(key);
      const rowSync = finiteInt(row.syncNumber);
      if (input.activeSyncNumber !== null && rowSync === null) {
        stoppedReason = "history_sync_number_missing";
        break;
      }
      if (lastSync !== null && rowSync !== null && rowSync > lastSync + 1) {
        stoppedReason = "history_sync_gap";
        break;
      }
      const matchType = parseMatchType(row.matchType);
      const actualOutcome = normalizeActualOutcome(row.actualOutcome);
      if (!matchType || (matchType !== "MM" && actualOutcome === null)) {
        stoppedReason = "history_actual_result_unconfirmed";
        break;
      }
      const teamSize = input.lookupTeamSizes.get(row.warId) ?? null;
      const persistedAfter = finiteInt(row.pointsAfterWar);
      if (matchType === "BL" && !canComputeDefinitiveBlDelta(row, teamSize)) {
        if (persistedAfter === null) {
          stoppedReason = "history_delta_input_incomplete";
          break;
        }
        balance = persistedAfter;
        appliedWarIds.push(row.warId);
        lastSync = rowSync ?? lastSync;
        continue;
      }
      const delta = computeWarPointsDeltaForTest({
        matchType,
        before: balance,
        after: null,
        finalResult: historyResult(row),
        teamSize,
      });
      if (delta === null || !Number.isFinite(delta)) {
        stoppedReason = "history_delta_unavailable";
        break;
      }
      const expectedAfter = balance + Math.trunc(delta);
      balance = persistedAfter ?? expectedAfter;
      appliedWarIds.push(row.warId);
      lastSync = rowSync ?? lastSync;
    }

    if (!stoppedReason && input.activeSyncNumber !== null && lastSync !== null && input.activeSyncNumber > lastSync + 1) {
      stoppedReason = "history_sync_gap_after_last_row";
    }
    const fullyReconstructed =
      stoppedReason === null &&
      input.activeSyncNumber !== null &&
      lastSync !== null &&
      input.activeSyncNumber <= lastSync + 1;
    const source: PointsEstimateSource =
      appliedWarIds.length > 0
        ? fullyReconstructed
          ? "history_reconstruction"
          : "last_known_derived"
        : input.baseline.baseline.kind === "derived"
          ? "last_known_derived"
          : "last_known_observed";
    return {
      balance,
      source,
      provenance: input.baseline.baseline,
      baseline: input.baseline.baseline,
      isEstimate: true,
      isValidatedCurrentMatchupEvidence: false,
      coverage: fullyReconstructed ? "complete_reconstruction" : "last_known_unresolved_history",
      projectionSafe: fullyReconstructed,
      syncNumber: input.activeSyncNumber,
      syncNumberSource: "unavailable",
      appliedWarIds,
      reason: stoppedReason ?? (appliedWarIds.length > 0 ? "completed_history_deltas_applied" : "last_known_persisted_balance"),
    };
  }

  /** Purpose: load optional archived team-size evidence needed by the existing BL perfect-war rule. */
  private async loadTeamSizes(historyRows: WarHistoryReadRow[]): Promise<Map<number, number>> {
    const delegate = this.db.warLookup;
    const warIds = [...new Set(historyRows.map((row) => row.warId).filter((warId) => Number.isInteger(warId)))];
    if (!delegate?.findMany || warIds.length === 0) return new Map();
    try {
      const rows = (await delegate.findMany({
        where: { warId: { in: warIds.map(String) } },
        select: { warId: true, payload: true },
      })) as WarLookupReadRow[];
      const result = new Map<number, number>();
      for (const row of rows) {
        const warId = finiteInt(row.warId);
        const teamSize = extractTeamSize(row.payload);
        if (warId !== null && teamSize !== null) result.set(warId, teamSize);
      }
      return result;
    } catch (error) {
      dozzleLog.debug(`[points-estimate] event=team_size_read_failed war_count=${warIds.length} error=${String(error)}`);
      return new Map();
    }
  }

  /** Purpose: resolve a usable sync number without allocating or persisting a SyncCycle row. */
  private async resolveSyncNumber(input: {
    input: ResolverInput;
    pointRows: PointsSyncReadRow[];
    clanTag: string;
    opponentTag: string;
  }): Promise<{ syncNumber: number | null; source: PointsEstimateResult["syncNumberSource"] }> {
    const supplied = finiteInt(input.input.activeWar.syncNumber);
    if (supplied !== null && supplied > 0) return { syncNumber: supplied, source: "caller_context" };
    const sameWar = input.pointRows.find(
      (row) =>
        ((sameTag(row.clanTag, input.clanTag) && sameTag(row.opponentTag, input.opponentTag)) ||
          (sameTag(row.clanTag, input.input.activeWar.trackedClanTag ?? input.opponentTag) &&
            sameTag(row.opponentTag, input.clanTag))) &&
        sameWarIdentity(row, input.input.activeWar),
    );
    const sameWarSync = finiteInt(sameWar?.syncNum);
    if (sameWarSync !== null && sameWarSync > 0) return { syncNumber: sameWarSync, source: "same_war_points" };

    if (input.input.activeWar.syncTime && this.db.syncCycle?.findFirst) {
      try {
        const cycle = (await this.db.syncCycle.findFirst({
          where: { guildId: input.input.guildId, syncTime: input.input.activeWar.syncTime },
          select: { syncNumber: true },
        })) as { syncNumber?: number | null } | null;
        const syncNumber = finiteInt(cycle?.syncNumber);
        if (syncNumber !== null && syncNumber > 0) return { syncNumber, source: "canonical_sync_cycle" };
      } catch (error) {
        dozzleLog.debug(`[points-estimate] event=sync_cycle_read_failed guild_id=${input.input.guildId} error=${String(error)}`);
      }
    }

    const matchType = parseMatchType(input.input.activeWar.matchType);
    if (matchType === "FWA" && validDate(input.input.activeWar.prepStartTime)) {
      try {
        const resolution = await this.activeWarSyncResolution.resolveActiveWarSyncFromCanonicalCycle({
          guildId: input.input.guildId,
          identity: {
            warState: input.input.activeWar.warState ?? "inWar",
            warId: input.input.activeWar.warId === null || input.input.activeWar.warId === undefined ? null : String(input.input.activeWar.warId),
            warStartTime: input.input.activeWar.warStartTime,
            opponentTag: input.opponentTag,
            positivelyResolved: true,
          },
          preparationStartTime: input.input.activeWar.prepStartTime,
          matchType,
          inferredMatchType: input.input.activeWar.inferredMatchType ?? false,
          persistCanonical: false,
          shareDerivedCandidate: false,
          sameWarPersistedSyncNumber: sameWarSync,
        });
        const syncNumber = finiteInt(resolution.syncNumber);
        if (syncNumber !== null && syncNumber > 0) {
          return {
            syncNumber,
            source: resolution.source === "active_war_schedule_candidate" ? "active_war_schedule_candidate" : "canonical_sync_cycle",
          };
        }
      } catch (error) {
        dozzleLog.debug(`[points-estimate] event=active_sync_read_failed guild_id=${input.input.guildId} error=${String(error)}`);
      }
    }
    return { syncNumber: null, source: "unavailable" };
  }

  /** Purpose: emit one bounded diagnostic for a chosen estimate source or unavailable reason. */
  private logChosenSource(clanTag: string, source: PointsEstimateSource, reason: string, syncNumber: number | null): void {
    const line = `[points-estimate] event=resolve source=${source} clan_tag=${clanTag} sync_number=${syncNumber ?? "unknown"} reason=${reason}`;
    if (source === "unavailable") dozzleLog.warn(line);
    else dozzleLog.debug(line);
  }
}

/** Purpose: match a points-sync row to active identity without relying on an external site identity. */
function sameWarIdentity(row: PointsSyncReadRow, activeWar: PointsEstimateActiveWarContext): boolean {
  const activeWarId = String(activeWar.warId ?? "").trim();
  if (activeWarId.length > 0 && row.warId !== null) return String(row.warId) === activeWarId;
  return sameDate(row.warStartTime, activeWar.warStartTime);
}
