import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";
import {
  ActiveWarSyncResolutionService,
  type ActiveCycleSyncCandidate,
  type ActiveCycleSyncDiscovery,
} from "./ActiveWarSyncResolutionService";
import {
  historicalHistoryMatchesPointByExactTuple,
  membershipCanonicalHistoryKey,
  type MembershipCanonicalHistoryIdentity,
  type MembershipHistoryPointIdentity,
} from "./membershipHistoryIdentity";

const DEFAULT_MAX_BOUNDARIES = 100;
const HARD_MAX_BOUNDARIES = 500;

export type MembershipStreakInput = {
  guildId: string;
  playerTags: string[];
  maxBoundaries?: number;
};

export type MembershipFwaEvidenceSource =
  | "ACTIVE_FWA_WAR_ROSTER"
  | "FWA_WAR_PARTICIPATION"
  | "SYNC_SNAPSHOT"
  | "FWA_WAR_PARTICIPATION_FALLBACK";

export type MembershipFwaEvidence = {
  status: "RESOLVED" | "AMBIGUOUS" | "ABSENT" | "UNKNOWN";
  clanTag: string | null;
  clanTags: string[];
  source: MembershipFwaEvidenceSource | null;
};

export type MembershipAllianceEvidence = {
  positive: boolean;
  clanTags: string[];
  ambiguous: boolean;
  sources: Array<"FWA_EVIDENCE" | "ALLIANCE_INTERVAL">;
};

export type MembershipBoundaryEvidence = {
  playerTag: string;
  boundaryTime: Date;
  fwa: MembershipFwaEvidence;
  alliance: MembershipAllianceEvidence;
};

export type MembershipStreakResult = {
  playerTag: string;
  latestBoundaryTime: Date | null;
  latestFwaEvidenceStatus: MembershipFwaEvidence["status"];
  latestFwaClanTag: string | null;
  clanStreakSyncs: number;
  clanStreakIsLowerBound: boolean;
  allianceStreakSyncs: number;
  allianceStreakIsLowerBound: boolean;
  latestEvidenceAvailable: boolean;
  latestEvidencePending: boolean;
  latestPendingClanValueAvailable: boolean;
  latestPendingAllianceValueAvailable: boolean;
};

export type MembershipStreakBatchResult = {
  streaks: MembershipStreakResult[];
  boundaryTimes: Date[];
  boundaryIdentities: MembershipBoundaryIdentity[];
  boundaryHistoryTruncated: boolean;
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer;
};

export type MembershipBoundaryEvidenceByPlayer = Record<string, MembershipBoundaryEvidence[]>;

export type MembershipBoundaryIdentity = {
  boundaryTime: Date;
  syncNumber: number | null;
};

type MembershipStreakDb = {
  syncCycle: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
  syncClanMemberSnapshot: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
  warAttacks: { findMany: (args?: any) => Promise<any[]> };
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
};

const defaultDb = prisma as unknown as MembershipStreakDb;

type CanonicalCycle = {
  syncNumber: number | null;
  syncTime: Date;
};

type PointIdentity = MembershipHistoryPointIdentity & {
  syncNumber: number;
  isFwa: boolean;
  needsValidation: boolean;
};

type HistoricalFwaHistory = MembershipCanonicalHistoryIdentity & {
  syncNumber: number;
  syncTime: Date;
};

type ActiveWarSyncReader = Pick<
  ActiveWarSyncResolutionService,
  "findPersistedActiveSyncNumber"
>;

type RosterCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";
type ActiveRosterEvidence = {
  candidate: ActiveCycleSyncCandidate & { syncNumber: number; startTime: Date };
  coverage: RosterCompleteness;
};
type HistoricalRosterEvidence = {
  history: HistoricalFwaHistory;
  coverage: RosterCompleteness;
};

type LoadedEvidence = {
  playerTags: string[];
  boundaries: Date[];
  boundaryIdentities: MembershipBoundaryIdentity[];
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer;
  historyBoundReached: boolean;
  boundaryHistoryTruncated: boolean;
  historicalCanonicalization: HistoricalCanonicalizationStats;
};

type HistoricalCanonicalizationStats = {
  validatedPoints: number;
  dirtyPointsIgnored: number;
  pointsCanonicalized: number;
  staleRawIdsCanonicalized: number;
  unmatchedValidatedPoints: number;
  ambiguousTuplePoints: number;
  canonicalHistoriesUsed: number;
  negativeCoverageUncertainBoundaries: number;
};

/** Purpose: create the bounded diagnostic counters for historical owner canonicalization. */
function emptyHistoricalCanonicalizationStats(): HistoricalCanonicalizationStats {
  return {
    validatedPoints: 0,
    dirtyPointsIgnored: 0,
    pointsCanonicalized: 0,
    staleRawIdsCanonicalized: 0,
    unmatchedValidatedPoints: 0,
    ambiguousTuplePoints: 0,
    canonicalHistoriesUsed: 0,
    negativeCoverageUncertainBoundaries: 0,
  };
}

/** Purpose: normalize a guild identifier before applying guild-scoped reads. */
function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

/** Purpose: normalize a player tag into the canonical hash-prefixed form. */
function normalizePlayerTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize a clan tag into the canonical hash-prefixed form. */
function normalizeClanTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: deduplicate and deterministically order requested player tags. */
function normalizePlayerTags(values: unknown): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizePlayerTag)
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

/** Purpose: clamp the requested history window to safe service bounds. */
function normalizeMaxBoundaries(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_BOUNDARIES;
  return Math.min(parsed, HARD_MAX_BOUNDARIES);
}

/** Purpose: accept only finite Date values from persisted query results. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: normalize positive numeric identifiers used by historical ownership joins. */
function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Purpose: key one canonical war/clan roster for bounded completeness aggregation. */
function rosterKey(warId: number, clanTag: string): string {
  return `${warId}|${clanTag}`;
}

/** Purpose: key one active candidate identity for roster completeness and player matching. */
function activeCandidateKey(candidate: ActiveCycleSyncCandidate & { syncNumber: number; startTime: Date }): string {
  return [
    candidate.syncNumber,
    candidate.warId ?? "none",
    normalizeClanTag(candidate.clanTag),
    candidate.startTime.getTime(),
    candidate.opponentTag ? normalizeClanTag(candidate.opponentTag) : "none",
  ].join("|");
}

/** Purpose: verify that overlapping active and archived evidence describes the same physical roster. */
function activeAndHistoricalIdentitiesCompatible(
  candidate: ActiveCycleSyncCandidate & { syncNumber: number; startTime: Date },
  history: HistoricalFwaHistory,
): boolean {
  if (candidate.warId !== null && candidate.warId !== history.warId) return false;
  if (history.warStartTime && candidate.startTime.getTime() !== history.warStartTime.getTime()) return false;
  if (candidate.opponentTag && history.opponentTag && normalizeClanTag(candidate.opponentTag) !== normalizeClanTag(history.opponentTag)) return false;
  return true;
}

/** Purpose: normalize case-insensitive persisted enum-like values for comparison. */
function normalizedComparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Purpose: restrict historical fallback evidence to FWA war records. */
function isFwaMatchType(value: unknown): boolean {
  return normalizedComparable(value) === "FWA";
}

/** Purpose: provide a stable millisecond key for boundary and interval maps. */
function dateKey(value: Date): string {
  return String(value.getTime());
}

/** Purpose: key one player's evidence at one exact sync boundary. */
function evidenceKey(playerTag: string, boundaryTime: Date): string {
  return `${playerTag}|${dateKey(boundaryTime)}`;
}

/** Purpose: order sync boundaries from newest to oldest. */
function compareDatesDescending(a: Date, b: Date): number {
  return b.getTime() - a.getTime();
}

/** Purpose: deduplicate clan evidence while keeping output deterministic. */
function uniqueSortedTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

/** Purpose: normalize distinct grouped sync-time rows into a deterministic boundary list. */
function normalizeBoundaryTimes(rows: any[]): Date[] {
  const byTime = new Map<number, Date>();
  for (const row of rows) {
    if (isValidDate(row?.syncTime)) byTime.set(row.syncTime.getTime(), row.syncTime);
  }
  return [...byTime.values()].sort(compareDatesDescending);
}

/** Purpose: normalize canonical sync-cycle rows and retain one sync number per time. */
function normalizeCanonicalCycles(rows: any[]): CanonicalCycle[] {
  const syncNumbersByTime = new Map<number, Set<number>>();
  for (const row of rows) {
    const syncNumber = normalizePositiveInteger(row?.syncNumber);
    if (!syncNumber || !isValidDate(row?.syncTime)) continue;
    const syncNumbers = syncNumbersByTime.get(row.syncTime.getTime()) ?? new Set<number>();
    syncNumbers.add(syncNumber);
    syncNumbersByTime.set(row.syncTime.getTime(), syncNumbers);
  }
  const timesBySyncNumber = new Map<number, Set<number>>();
  for (const [time, syncNumbers] of syncNumbersByTime) {
    for (const syncNumber of syncNumbers) {
      const times = timesBySyncNumber.get(syncNumber) ?? new Set<number>();
      times.add(time);
      timesBySyncNumber.set(syncNumber, times);
    }
  }
  return [...syncNumbersByTime.entries()].map(([time, syncNumbers]) => {
    const onlySyncNumber = syncNumbers.size === 1 ? [...syncNumbers][0] : null;
    const syncNumberIsDuplicated = onlySyncNumber !== null &&
      (timesBySyncNumber.get(onlySyncNumber)?.size ?? 0) > 1;
    return {
      syncNumber: syncNumberIsDuplicated ? null : onlySyncNumber,
      syncTime: new Date(time),
    };
  }).sort((a, b) => compareDatesDescending(a.syncTime, b.syncTime));
}

/** Purpose: normalize a points row into a guild-owned historical war identity. */
function normalizePointIdentity(row: any): PointIdentity | null {
  const syncNumber = normalizePositiveInteger(row?.syncNum);
  const clanTag = normalizeClanTag(row?.clanTag);
  const warStartTime = row?.warStartTime;
  const opponentTag = normalizeClanTag(row?.opponentTag);
  if (!syncNumber || !clanTag || !opponentTag || !isValidDate(warStartTime)) return null;
  return {
    syncNumber,
    isFwa: row?.isFwa !== false,
    needsValidation: row?.needsValidation === true,
    warId: normalizePositiveInteger(row?.warId),
    clanTag,
    warStartTime,
    opponentTag,
  };
}

/** Purpose: normalize bounded canonical FWA history candidates against sync-cycle times. */
function normalizeHistoricalHistories(
  rows: any[],
  cyclesBySyncNumber: Map<number, CanonicalCycle>,
): HistoricalFwaHistory[] {
  const byIdentity = new Map<string, HistoricalFwaHistory>();
  for (const row of rows) {
    const warId = normalizePositiveInteger(row?.warId);
    const persistedSyncNumber = normalizePositiveInteger(row?.syncNumber);
    const clanTag = normalizeClanTag(row?.clanTag);
    if (!warId || !clanTag || !isFwaMatchType(row?.matchType)) continue;
    if (persistedSyncNumber === null) continue;
    const cycle = cyclesBySyncNumber.get(persistedSyncNumber);
    if (!cycle || cycle.syncNumber === null) continue;
    const history: MembershipCanonicalHistoryIdentity = {
      warId,
      syncNumber: persistedSyncNumber,
      clanTag,
      warStartTime: isValidDate(row?.warStartTime) ? row.warStartTime : null,
      opponentTag: row?.opponentTag == null ? null : normalizeClanTag(row.opponentTag),
    };
    const normalized: HistoricalFwaHistory = {
      ...history,
      syncNumber: persistedSyncNumber,
      syncTime: cycle.syncTime,
    };
    byIdentity.set(`${warId}|${persistedSyncNumber}|${clanTag}`, normalized);
  }
  return [...byIdentity.values()].sort((a, b) =>
    compareDatesDescending(a.syncTime, b.syncTime) ||
    a.clanTag.localeCompare(b.clanTag) ||
    a.warId - b.warId,
  );
}

/** Purpose: resolve canonical war-roster evidence for one boundary. */
function buildFwaEvidence(
  positiveTags: Set<string> | undefined,
  completeCoverage: boolean,
  coverageSource: MembershipFwaEvidenceSource | null,
): MembershipFwaEvidence {
  if (positiveTags && positiveTags.size > 0) {
    const clanTags = uniqueSortedTags(positiveTags);
    return {
      status: clanTags.length === 1 ? "RESOLVED" : "AMBIGUOUS",
      clanTag: clanTags.length === 1 ? clanTags[0] : null,
      clanTags,
      source: coverageSource,
    };
  }
  if (completeCoverage) {
    return { status: "ABSENT", clanTag: null, clanTags: [], source: coverageSource };
  }
  return { status: "UNKNOWN", clanTag: null, clanTags: [], source: null };
}

/** Purpose: derive alliance membership only from the canonical FWA roster observation. */
function buildAllianceEvidence(fwa: MembershipFwaEvidence): MembershipAllianceEvidence {
  const fwaPositive = fwa.status === "RESOLVED" || fwa.status === "AMBIGUOUS";
  return {
    positive: fwaPositive,
    clanTags: [...fwa.clanTags],
    ambiguous: fwa.status === "AMBIGUOUS",
    sources: fwaPositive ? ["FWA_EVIDENCE"] : [],
  };
}

/** Purpose: compute bounded physical-clan and alliance streaks from boundary evidence. */
export function computeMembershipStreaksFromEvidence(
  playerTag: string,
  boundaries: Date[],
  evidenceRows: MembershipBoundaryEvidence[],
  historyBoundReached: boolean,
  boundaryIdentities: readonly MembershipBoundaryIdentity[] = [],
): MembershipStreakResult {
  const evidenceByKey = new Map(
    evidenceRows.map((row) => [evidenceKey(playerTag, row.boundaryTime), row]),
  );
  const identityByTime = new Map(
    boundaryIdentities.map((identity) => [dateKey(identity.boundaryTime), identity.syncNumber]),
  );
  const orderedIdentities: MembershipBoundaryIdentity[] = boundaries.map((boundaryTime) => ({
    boundaryTime,
    syncNumber: identityByTime.get(dateKey(boundaryTime)) ?? null,
  }));
  const latestBoundaryTime = boundaries[0] ?? null;
  const latest = latestBoundaryTime ? evidenceByKey.get(evidenceKey(playerTag, latestBoundaryTime)) : undefined;
  const latestEvidencePending = Boolean(
    latest && latest.fwa.status === "UNKNOWN" && !latest.alliance.positive,
  );
  const priorEvidence = evidenceRows[1];
  const latestPendingClanValueAvailable = Boolean(
    latestEvidencePending &&
    (priorEvidence?.fwa.status === "RESOLVED" || priorEvidence?.fwa.status === "ABSENT"),
  );
  const latestPendingAllianceValueAvailable = Boolean(
    latestEvidencePending && priorEvidence && priorEvidence.fwa.status !== "UNKNOWN",
  );

  const hasContiguousCanonicalBoundary = (index: number): boolean => {
    const newer = orderedIdentities[index - 1]?.syncNumber;
    const older = orderedIdentities[index]?.syncNumber;
    return newer !== null && older !== null && newer !== undefined && older !== undefined && newer - 1 === older;
  };

  let clanStreakSyncs = 0;
  let clanStreakIsLowerBound = false;
  let clanStartIndex: number | null = null;
  if (latest?.fwa.status === "RESOLVED") {
    clanStartIndex = 0;
  } else if (latestEvidencePending && evidenceRows[1]?.fwa.status === "RESOLVED") {
    clanStartIndex = 1;
  }
  if (clanStartIndex !== null) {
    const latestClanTag = evidenceByKey.get(
      evidenceKey(playerTag, boundaries[clanStartIndex]),
    )!.fwa.clanTag!;
    clanStreakSyncs = 1;
    let stopped = orderedIdentities[clanStartIndex]?.syncNumber === null;
    if (clanStartIndex === 1 && !hasContiguousCanonicalBoundary(1)) {
      clanStreakIsLowerBound = true;
      stopped = true;
    }
    if (stopped) clanStreakIsLowerBound = true;
    if (!stopped) {
      for (let index = clanStartIndex + 1; index < boundaries.length; index += 1) {
        if (!hasContiguousCanonicalBoundary(index)) {
          clanStreakIsLowerBound = true;
          stopped = true;
          break;
        }
        const evidence = evidenceByKey.get(evidenceKey(playerTag, boundaries[index]));
        if (evidence?.fwa.status === "RESOLVED" && evidence.fwa.clanTag === latestClanTag) {
          clanStreakSyncs += 1;
          continue;
        }
        if (evidence?.fwa.status === "RESOLVED" || evidence?.fwa.status === "ABSENT") break;
        clanStreakIsLowerBound = true;
        stopped = true;
        break;
      }
    }
    if (!stopped && clanStreakSyncs === boundaries.length && historyBoundReached) {
      clanStreakIsLowerBound = true;
    }
  } else if (latestBoundaryTime && !latestEvidencePending && latest?.fwa.status !== "ABSENT") {
    clanStreakIsLowerBound = true;
  }

  let allianceStreakSyncs = 0;
  let allianceStreakIsLowerBound = false;
  let allianceStartIndex: number | null = null;
  if (latest?.alliance.positive) {
    allianceStartIndex = 0;
  } else if (latestEvidencePending && evidenceRows[1]?.alliance.positive) {
    allianceStartIndex = 1;
  }
  if (allianceStartIndex !== null) {
    allianceStreakSyncs = 1;
    let stopped = orderedIdentities[allianceStartIndex]?.syncNumber === null;
    if (allianceStartIndex === 1 && !hasContiguousCanonicalBoundary(1)) {
      allianceStreakIsLowerBound = true;
      stopped = true;
    }
    if (stopped) allianceStreakIsLowerBound = true;
    if (!stopped) {
      for (let index = allianceStartIndex + 1; index < boundaries.length; index += 1) {
        if (!hasContiguousCanonicalBoundary(index)) {
          allianceStreakIsLowerBound = true;
          stopped = true;
          break;
        }
        const evidence = evidenceByKey.get(evidenceKey(playerTag, boundaries[index]));
        if (evidence?.alliance.positive) {
          allianceStreakSyncs += 1;
          continue;
        }
        if (evidence?.fwa.status === "ABSENT") break;
        allianceStreakIsLowerBound = true;
        stopped = true;
        break;
      }
    }
    if (!stopped && allianceStreakSyncs === boundaries.length && historyBoundReached) {
      allianceStreakIsLowerBound = true;
    }
  } else if (latestBoundaryTime && !latestEvidencePending && latest?.fwa.status !== "ABSENT") {
    allianceStreakIsLowerBound = true;
  }

  return {
    playerTag,
    latestBoundaryTime,
    latestFwaEvidenceStatus: latest?.fwa.status ?? "UNKNOWN",
    latestFwaClanTag: latest?.fwa.status === "RESOLVED" ? latest.fwa.clanTag : null,
    clanStreakSyncs,
    clanStreakIsLowerBound,
    allianceStreakSyncs,
    allianceStreakIsLowerBound,
    latestEvidenceAvailable: Boolean(latest && (latest.fwa.status !== "UNKNOWN" || latest.alliance.positive)),
    latestEvidencePending,
    latestPendingClanValueAvailable,
    latestPendingAllianceValueAvailable,
  };
}

/** Purpose: resolve bounded, persisted membership evidence in bulk for future Home Clan automation. */
export class MembershipStreakService {
  private readonly activeWarSyncReader: ActiveWarSyncReader | null;

  constructor(
    private readonly db: MembershipStreakDb = defaultDb,
    activeWarSyncReader?: ActiveWarSyncReader | null,
  ) {
    this.activeWarSyncReader = activeWarSyncReader === undefined
      ? db === defaultDb ? new ActiveWarSyncResolutionService() : null
      : activeWarSyncReader;
  }

  /** Purpose: return streaks and the same canonical boundary window through one bulk evidence load. */
  async getMembershipStreakBatchForPlayers(input: MembershipStreakInput): Promise<MembershipStreakBatchResult> {
    const loaded = await this.loadEvidence(input);
    const results = loaded.playerTags.map((playerTag) => computeMembershipStreaksFromEvidence(
      playerTag,
      loaded.boundaries,
      loaded.evidenceByPlayer[playerTag],
      loaded.historyBoundReached,
      loaded.boundaryIdentities,
    ));
    console.debug(
      `[membership-streak] event=bulk_resolution guild_id=${normalizeGuildId(input.guildId) || "unknown"} players=${loaded.playerTags.length} boundaries=${loaded.boundaries.length} lower_bound=${loaded.historyBoundReached ? 1 : 0}`,
    );
    const canonicalization = loaded.historicalCanonicalization;
    console.debug(
      `[membership-streak] event=historical_canonicalization guild_id=${normalizeGuildId(input.guildId) || "unknown"} validated_points=${canonicalization.validatedPoints} dirty_points_ignored=${canonicalization.dirtyPointsIgnored} points_canonicalized=${canonicalization.pointsCanonicalized} stale_raw_ids_canonicalized=${canonicalization.staleRawIdsCanonicalized} unmatched_validated_points=${canonicalization.unmatchedValidatedPoints} ambiguous_tuple_points=${canonicalization.ambiguousTuplePoints} canonical_histories_used=${canonicalization.canonicalHistoriesUsed} negative_coverage_uncertain_boundaries=${canonicalization.negativeCoverageUncertainBoundaries}`,
    );
    return {
      streaks: results,
      boundaryTimes: [...loaded.boundaries],
      boundaryIdentities: [...loaded.boundaryIdentities],
      boundaryHistoryTruncated: loaded.boundaryHistoryTruncated,
      evidenceByPlayer: loaded.evidenceByPlayer,
    };
  }

  /** Purpose: preserve the existing streak-only API while delegating to the shared batch primitive. */
  async getMembershipStreaksForPlayers(input: MembershipStreakInput): Promise<MembershipStreakResult[]> {
    return (await this.getMembershipStreakBatchForPlayers(input)).streaks;
  }

  /** Purpose: expose the recent boundary evidence primitive for later Home Clan establishment logic. */
  async getMembershipBoundaryEvidenceForPlayers(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    return this.loadHomeQualificationEvidence(input);
  }

  /** Purpose: expose canonical FWA-roster evidence for C/S/A consumers. */
  async getRecentFwaEvidenceForPlayers(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    return (await this.loadEvidence(input)).evidenceByPlayer;
  }

  /** Purpose: preserve the separate snapshot-backed Home establishment policy without making it C/S/A evidence. */
  private async loadHomeQualificationEvidence(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    const guildId = normalizeGuildId(input.guildId);
    const playerTags = normalizePlayerTags(input.playerTags);
    const maxBoundaries = normalizeMaxBoundaries(input.maxBoundaries);
    if (!guildId || playerTags.length === 0) return {};
    const boundaryRows = await this.db.syncCycle.groupBy({
      by: ["syncTime"],
      where: { guildId },
      orderBy: { syncTime: "desc" },
      take: maxBoundaries + 1,
    });
    const cycleBoundaryTimes = normalizeBoundaryTimes(boundaryRows);
    const rawCycles = cycleBoundaryTimes.length > 0
      ? await this.db.syncCycle.findMany({
          where: { guildId, syncTime: { in: cycleBoundaryTimes } },
          orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
          select: { syncNumber: true, syncTime: true },
        })
      : [];
    const canonicalCycles = normalizeCanonicalCycles(rawCycles);
    const contiguousBoundaries: Date[] = [];
    for (const cycle of canonicalCycles) {
      if (cycle.syncNumber === null) break;
      const previous = canonicalCycles[contiguousBoundaries.length - 1];
      if (previous && (previous.syncNumber === null || previous.syncNumber - 1 !== cycle.syncNumber)) break;
      contiguousBoundaries.push(cycle.syncTime);
      if (contiguousBoundaries.length >= maxBoundaries) break;
    }
    const boundaries = contiguousBoundaries;
    if (boundaries.length === 0) return Object.fromEntries(playerTags.map((playerTag) => [playerTag, []]));
    const rows = await this.db.syncClanMemberSnapshot.findMany({
      where: { guildId, syncTime: { in: boundaries }, playerTag: { in: playerTags } },
      orderBy: [{ syncTime: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
      select: { guildId: true, syncTime: true, clanTag: true, playerTag: true },
    });
    const tagsByKey = new Map<string, Set<string>>();
    for (const row of rows) {
      const playerTag = normalizePlayerTag(row?.playerTag);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!playerTag || !clanTag || !isValidDate(row?.syncTime)) continue;
      const key = evidenceKey(playerTag, row.syncTime);
      const tags = tagsByKey.get(key) ?? new Set<string>();
      tags.add(clanTag);
      tagsByKey.set(key, tags);
    }
    return Object.fromEntries(playerTags.map((playerTag) => [playerTag, boundaries.map((boundaryTime) => {
      const tags = tagsByKey.get(evidenceKey(playerTag, boundaryTime));
      const clanTags = uniqueSortedTags(tags ?? []);
      const fwa: MembershipFwaEvidence = tags && tags.size > 0
        ? {
            status: clanTags.length === 1 ? "RESOLVED" : "AMBIGUOUS",
            clanTag: clanTags.length === 1 ? clanTags[0] : null,
            clanTags,
            source: "SYNC_SNAPSHOT",
          }
        : { status: "ABSENT", clanTag: null, clanTags: [], source: "SYNC_SNAPSHOT" };
      return { playerTag, boundaryTime, fwa, alliance: buildAllianceEvidence(fwa) };
    })]));
  }

  /** Purpose: load all bounded membership evidence with bulk, guild-scoped database reads. */
  private async loadEvidence(input: MembershipStreakInput): Promise<LoadedEvidence> {
    const guildId = normalizeGuildId(input.guildId);
    const playerTags = normalizePlayerTags(input.playerTags);
    const maxBoundaries = normalizeMaxBoundaries(input.maxBoundaries);
    if (!guildId || playerTags.length === 0) {
      return {
        playerTags,
        boundaries: [],
        boundaryIdentities: [],
        evidenceByPlayer: {},
        historyBoundReached: false,
        boundaryHistoryTruncated: false,
        historicalCanonicalization: emptyHistoricalCanonicalizationStats(),
      };
    }

    const boundaryTake = maxBoundaries + 1;
    const rawCycleBoundaries = await this.db.syncCycle.groupBy({
      by: ["syncTime"],
      where: { guildId },
      orderBy: { syncTime: "desc" },
      take: boundaryTake,
    });
    const cycleBoundaryTimes = normalizeBoundaryTimes(rawCycleBoundaries);
    const historyBoundReached = cycleBoundaryTimes.length > maxBoundaries;
    const boundaries = cycleBoundaryTimes.slice(0, maxBoundaries);
    const boundaryTimeSet = new Set(boundaries.map(dateKey));

    const rawCycles = boundaries.length > 0
      ? await this.db.syncCycle.findMany({
          where: { guildId, syncTime: { in: boundaries } },
          orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
          select: { syncNumber: true, syncTime: true },
        })
      : [];
    const cycles = normalizeCanonicalCycles(rawCycles);
    const boundedCycles = cycles.filter((cycle): cycle is CanonicalCycle & { syncNumber: number } =>
      cycle.syncNumber !== null && boundaryTimeSet.has(dateKey(cycle.syncTime)));
    const cycleByBoundaryTime = new Map(cycles.map((cycle) => [dateKey(cycle.syncTime), cycle]));
    const boundedCyclesBySyncNumber = new Map(boundedCycles.map((cycle) => [cycle.syncNumber, cycle]));
    const boundaryIdentities: MembershipBoundaryIdentity[] = boundaries.map((boundaryTime) => ({
      boundaryTime,
      syncNumber: cycleByBoundaryTime.get(dateKey(boundaryTime))?.syncNumber ?? null,
    }));

    let activeDiscovery: ActiveCycleSyncDiscovery | null = null;
    if (this.activeWarSyncReader) {
      try {
        activeDiscovery = await this.activeWarSyncReader.findPersistedActiveSyncNumber({ guildId });
      } catch (error) {
        console.warn(
          `[membership-streak] event=active_roster_resolution_failed guild_id=${guildId} reason=${String(error)}`,
        );
      }
    }
    const activeCandidates = (activeDiscovery?.conflict ? [] : activeDiscovery?.candidates ?? [])
      .filter((candidate): candidate is ActiveCycleSyncCandidate & { syncNumber: number; startTime: Date } =>
        candidate.guildId === guildId &&
        candidate.syncNumber !== null &&
        candidate.syncNumber > 0 &&
        isValidDate(candidate.startTime) &&
        boundedCyclesBySyncNumber.has(candidate.syncNumber),
      )
      .map((candidate) => ({
        ...candidate,
        clanTag: normalizeClanTag(candidate.clanTag),
        opponentTag: candidate.opponentTag ? normalizeClanTag(candidate.opponentTag) : null,
      }));
    const activeRosterWhereClauses = activeCandidates.map((candidate) => ({
      clanTag: normalizeClanTag(candidate.clanTag),
      warStartTime: candidate.startTime,
      ...(candidate.warId !== null ? { warId: candidate.warId } : {}),
      ...(candidate.opponentTag ? { opponentClanTag: normalizeClanTag(candidate.opponentTag) } : {}),
    }));
    let rawActiveRoster: any[] = [];
    if (activeRosterWhereClauses.length > 0) {
      try {
        rawActiveRoster = await this.db.warAttacks.findMany({
          where: {
            attackOrder: 0,
            warState: { in: ["preparation", "inWar"] },
            OR: activeRosterWhereClauses,
          },
          orderBy: [{ warStartTime: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
          select: {
            warId: true,
            clanTag: true,
            opponentClanTag: true,
            warStartTime: true,
            warState: true,
            playerTag: true,
          },
        });
      } catch (error) {
        console.warn(
          `[membership-streak] event=active_roster_read_failed guild_id=${guildId} reason=${String(error)}`,
        );
      }
    }

    const fallbackSyncNumbers = boundedCycles.map((cycle) => cycle.syncNumber).sort((a, b) => a - b);
    const [rawPoints, rawEvaluations] = await Promise.all([
      fallbackSyncNumbers.length > 0
        ? this.db.clanPointsSync.findMany({
            where: { guildId, syncNum: { in: fallbackSyncNumbers } },
            select: { clanTag: true, warId: true, warStartTime: true, opponentTag: true, syncNum: true, isFwa: true, needsValidation: true },
          })
        : Promise.resolve([]),
      fallbackSyncNumbers.length > 0
        ? this.db.warPlanComplianceEvaluation.findMany({
            where: { guildId, warHistory: { syncNumber: { in: fallbackSyncNumbers } } },
            select: {
              warId: true,
              warHistory: {
                select: {
                  warId: true,
                  syncNumber: true,
                  matchType: true,
                  clanTag: true,
                  warStartTime: true,
                  opponentTag: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const historicalCanonicalization = emptyHistoricalCanonicalizationStats();
    historicalCanonicalization.dirtyPointsIgnored = rawPoints.filter((row) => row?.needsValidation === true).length;
    historicalCanonicalization.validatedPoints = rawPoints.filter((row) => row?.needsValidation !== true).length;
    const points = rawPoints
      .map(normalizePointIdentity)
      .filter((row): row is PointIdentity =>
        row !== null && !row.needsValidation && boundedCyclesBySyncNumber.has(row.syncNumber));

    const hasHistoricalOwnerCandidates = points.length > 0 || rawEvaluations.some((evaluation) =>
      normalizePositiveInteger(evaluation?.warId) !== null &&
      normalizePositiveInteger(evaluation?.warHistory?.syncNumber) !== null,
    );
    const rawHistories = hasHistoricalOwnerCandidates
      ? await this.db.clanWarHistory.findMany({
          where: { syncNumber: { in: fallbackSyncNumbers }, matchType: "FWA" },
          orderBy: [{ syncNumber: "desc" }, { clanTag: "asc" }, { warId: "asc" }],
          select: {
            warId: true,
            syncNumber: true,
            matchType: true,
            clanTag: true,
            warStartTime: true,
            opponentTag: true,
          },
        })
      : [];
    const canonicalHistoryCandidates = normalizeHistoricalHistories(rawHistories, boundedCyclesBySyncNumber);
    const canonicalOwnerHistoryKeys = new Set<string>();
    const historyKeysByBoundaryClan = new Map<string, Set<string>>();
    const negativeCoverageUncertainBoundaryKeys = new Set<string>();
    const addCanonicalOwner = (history: HistoricalFwaHistory): void => {
      const historyKey = `${history.syncNumber}|${membershipCanonicalHistoryKey(history)}`;
      canonicalOwnerHistoryKeys.add(historyKey);
      const ownerKey = `${history.syncNumber}|${history.clanTag}`;
      const historyKeys = historyKeysByBoundaryClan.get(ownerKey) ?? new Set<string>();
      historyKeys.add(historyKey);
      historyKeysByBoundaryClan.set(ownerKey, historyKeys);
    };
    const ambiguousOwnerKeys = new Set<string>();
    for (const point of points) {
      const matches = canonicalHistoryCandidates.filter((history) =>
        history.syncNumber === point.syncNumber && historicalHistoryMatchesPointByExactTuple(history, point));
      if (matches.length === 0) {
        if (point.isFwa) historicalCanonicalization.unmatchedValidatedPoints += 1;
        const activeMatches = activeCandidates.filter((candidate) =>
          candidate.syncNumber === point.syncNumber &&
          candidate.clanTag === point.clanTag &&
          candidate.startTime.getTime() === point.warStartTime.getTime() &&
          Boolean(candidate.opponentTag) &&
          normalizeClanTag(candidate.opponentTag) === normalizeClanTag(point.opponentTag));
        if (point.isFwa && activeMatches.length !== 1) {
          const cycle = boundedCyclesBySyncNumber.get(point.syncNumber);
          if (cycle) negativeCoverageUncertainBoundaryKeys.add(dateKey(cycle.syncTime));
        }
        continue;
      }
      if (matches.length > 1) {
        historicalCanonicalization.ambiguousTuplePoints += 1;
        const cycle = boundedCyclesBySyncNumber.get(point.syncNumber);
        if (cycle) negativeCoverageUncertainBoundaryKeys.add(dateKey(cycle.syncTime));
        for (const history of matches) ambiguousOwnerKeys.add(`${history.syncNumber}|${history.clanTag}`);
        continue;
      }
      const [history] = matches;
      historicalCanonicalization.pointsCanonicalized += 1;
      if (point.warId !== null && point.warId !== history.warId) {
        historicalCanonicalization.staleRawIdsCanonicalized += 1;
      }
      addCanonicalOwner(history);
    }
    for (const evaluation of rawEvaluations) {
      const evaluationSyncNumber = normalizePositiveInteger(evaluation?.warHistory?.syncNumber);
      const evaluationWarId = normalizePositiveInteger(evaluation?.warId);
      if (!evaluationSyncNumber || !evaluationWarId ||
        (evaluation?.warHistory?.matchType !== undefined && !isFwaMatchType(evaluation.warHistory.matchType))) continue;
      const matches = canonicalHistoryCandidates.filter((history) =>
        history.syncNumber === evaluationSyncNumber && history.warId === evaluationWarId);
      if (matches.length === 1) addCanonicalOwner(matches[0]);
      else if (matches.length > 1) {
        for (const history of matches) {
          ambiguousOwnerKeys.add(`${history.syncNumber}|${history.clanTag}`);
          negativeCoverageUncertainBoundaryKeys.add(dateKey(history.syncTime));
        }
      }
    }
    for (const [ownerKey, historyKeys] of historyKeysByBoundaryClan) {
      if (historyKeys.size > 1) {
        ambiguousOwnerKeys.add(ownerKey);
        const ownerHistory = canonicalHistoryCandidates.find((history) =>
          `${history.syncNumber}|${history.clanTag}` === ownerKey);
        if (ownerHistory) negativeCoverageUncertainBoundaryKeys.add(dateKey(ownerHistory.syncTime));
      }
    }
    const histories = canonicalHistoryCandidates.filter((history) => {
      const historyKey = `${history.syncNumber}|${membershipCanonicalHistoryKey(history)}`;
      return canonicalOwnerHistoryKeys.has(historyKey) && !ambiguousOwnerKeys.has(`${history.syncNumber}|${history.clanTag}`);
    });
    historicalCanonicalization.canonicalHistoriesUsed = histories.length;
    historicalCanonicalization.negativeCoverageUncertainBoundaries = negativeCoverageUncertainBoundaryKeys.size;
    const expectedFwaClanTagsByBoundary = new Map<string, Set<string>>();
    for (const candidate of activeCandidates) {
      const cycle = boundedCyclesBySyncNumber.get(candidate.syncNumber);
      if (!cycle || !candidate.clanTag) continue;
      const boundaryKey = dateKey(cycle.syncTime);
      const clanTags = expectedFwaClanTagsByBoundary.get(boundaryKey) ?? new Set<string>();
      clanTags.add(candidate.clanTag);
      expectedFwaClanTagsByBoundary.set(boundaryKey, clanTags);
    }
    for (const history of histories) {
      const boundaryKey = dateKey(history.syncTime);
      const clanTags = expectedFwaClanTagsByBoundary.get(boundaryKey) ?? new Set<string>();
      clanTags.add(history.clanTag);
      expectedFwaClanTagsByBoundary.set(boundaryKey, clanTags);
    }
    const warIds = [...new Set(histories.map((row) => String(row.warId)))];
    const [rawParticipation, rawParticipationCounts] = warIds.length > 0
      ? await Promise.all([
          this.db.clanWarParticipation.findMany({
            where: { guildId, warId: { in: warIds }, playerTag: { in: playerTags } },
            orderBy: [{ warId: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
            select: { warId: true, clanTag: true, playerTag: true },
          }),
          this.db.clanWarParticipation.groupBy({
            by: ["warId", "clanTag"],
            where: { guildId, warId: { in: warIds } },
            _count: { playerTag: true },
          }),
        ])
      : [[], []];

    const observedParticipationRosterKeys = new Set<string>();
    for (const row of rawParticipationCounts) {
      const warId = normalizePositiveInteger(row?.warId);
      const clanTag = normalizeClanTag(row?.clanTag);
      const count = Number(row?._count?.playerTag);
      if (!warId || !clanTag || !Number.isInteger(count) || count <= 0) continue;
      observedParticipationRosterKeys.add(rosterKey(warId, clanTag));
    }
    const historicalCoverageByRosterKey = new Map<string, RosterCompleteness>();
    for (const history of histories) {
      const key = rosterKey(history.warId, history.clanTag);
      historicalCoverageByRosterKey.set(
        key,
        observedParticipationRosterKeys.has(key) ? "COMPLETE" : "UNKNOWN",
      );
    }
    const activeTagsByKey = new Map<string, Set<string>>();
    const activeRosterPlayersByCandidateKey = new Map<string, Set<string>>();
    for (const row of rawActiveRoster) {
      const playerTag = normalizePlayerTag(row?.playerTag);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!playerTag || !clanTag || !isValidDate(row?.warStartTime)) continue;
      const matchingCandidates = activeCandidates.filter((candidate) =>
        candidate.clanTag === clanTag &&
        candidate.startTime.getTime() === row.warStartTime.getTime() &&
        (candidate.warId === null || normalizePositiveInteger(row?.warId) === candidate.warId) &&
        (!candidate.opponentTag || !row?.opponentClanTag || normalizeClanTag(row.opponentClanTag) === normalizeClanTag(candidate.opponentTag)) &&
        (!row?.warState || ["PREPARATION", "INWAR"].includes(normalizedComparable(row.warState))),
      );
      for (const candidate of matchingCandidates) {
        const cycle = boundedCyclesBySyncNumber.get(candidate.syncNumber);
        if (!cycle) continue;
        const candidateKey = activeCandidateKey(candidate);
        const rosterPlayers = activeRosterPlayersByCandidateKey.get(candidateKey) ?? new Set<string>();
        rosterPlayers.add(playerTag);
        activeRosterPlayersByCandidateKey.set(candidateKey, rosterPlayers);
        if (!playerTags.includes(playerTag)) continue;
        const key = evidenceKey(playerTag, cycle.syncTime);
        const tags = activeTagsByKey.get(key) ?? new Set<string>();
        tags.add(clanTag);
        activeTagsByKey.set(key, tags);
      }
    }

    const activeCoverageByBoundaryAndClan = new Map<string, Map<string, Map<string, ActiveRosterEvidence>>>();
    for (const candidate of activeCandidates) {
      const cycle = boundedCyclesBySyncNumber.get(candidate.syncNumber);
      if (!cycle) continue;
      const boundaryKey = dateKey(cycle.syncTime);
      const candidateKey = activeCandidateKey(candidate);
      const expectedSize = normalizePositiveInteger(candidate.teamSize);
      const observedSize = activeRosterPlayersByCandidateKey.get(candidateKey)?.size ?? 0;
      const coverage: RosterCompleteness = expectedSize === null
        ? "UNKNOWN"
        : observedSize === expectedSize ? "COMPLETE" : "PARTIAL";
      const coverageByClan = activeCoverageByBoundaryAndClan.get(boundaryKey) ?? new Map<string, Map<string, ActiveRosterEvidence>>();
      const coverageByCandidate = coverageByClan.get(candidate.clanTag) ?? new Map<string, ActiveRosterEvidence>();
      coverageByCandidate.set(candidateKey, { candidate, coverage });
      coverageByClan.set(candidate.clanTag, coverageByCandidate);
      activeCoverageByBoundaryAndClan.set(boundaryKey, coverageByClan);
    }

    const historicalTagsByKey = new Map<string, Set<string>>();
    const historicalCoverageByBoundaryAndClan = new Map<string, Map<string, Map<string, HistoricalRosterEvidence>>>();
    for (const history of histories) {
      const boundaryKey = dateKey(history.syncTime);
      const coverageByClan = historicalCoverageByBoundaryAndClan.get(boundaryKey) ?? new Map<string, Map<string, HistoricalRosterEvidence>>();
      const coverageByRoster = coverageByClan.get(history.clanTag) ?? new Map<string, HistoricalRosterEvidence>();
      const key = rosterKey(history.warId, history.clanTag);
      coverageByRoster.set(key, { history, coverage: historicalCoverageByRosterKey.get(key) ?? "UNKNOWN" });
      coverageByClan.set(history.clanTag, coverageByRoster);
      historicalCoverageByBoundaryAndClan.set(boundaryKey, coverageByClan);
    }
    const historyByWarId = new Map<number, HistoricalFwaHistory[]>();
    for (const history of histories) {
      const rows = historyByWarId.get(history.warId) ?? [];
      rows.push(history);
      historyByWarId.set(history.warId, rows);
    }
    for (const row of rawParticipation) {
      const warId = normalizePositiveInteger(row?.warId);
      const playerTag = normalizePlayerTag(row?.playerTag);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!warId || !clanTag) continue;
      for (const history of historyByWarId.get(warId) ?? []) {
        if (history.clanTag !== clanTag) continue;
        const key = evidenceKey(playerTag, history.syncTime);
        if (!playerTag || !playerTags.includes(playerTag)) continue;
        const tags = historicalTagsByKey.get(key) ?? new Set<string>();
        tags.add(clanTag);
        historicalTagsByKey.set(key, tags);
      }
    }

    const completeCoverageByBoundary = new Map<string, {
      source: MembershipFwaEvidenceSource;
    }>();
    for (const [boundaryKey, expectedClanTags] of expectedFwaClanTagsByBoundary) {
      if (expectedClanTags.size === 0) continue;
      if (negativeCoverageUncertainBoundaryKeys.has(boundaryKey)) continue;
      const activeCoverageByClan = activeCoverageByBoundaryAndClan.get(boundaryKey);
      const historicalCoverageByClan = historicalCoverageByBoundaryAndClan.get(boundaryKey);
      let complete = true;
      let coverageSource: MembershipFwaEvidenceSource | null = null;
      for (const clanTag of expectedClanTags) {
        const activeEvidence = [...(activeCoverageByClan?.get(clanTag)?.values() ?? [])];
        const historicalEvidence = [...(historicalCoverageByClan?.get(clanTag)?.values() ?? [])];
        if (activeEvidence.length > 1 || historicalEvidence.length > 1) {
          complete = false;
          break;
        }
        const active = activeEvidence[0] ?? null;
        const historical = historicalEvidence[0] ?? null;
        if (active && historical && !activeAndHistoricalIdentitiesCompatible(active.candidate, historical.history)) {
          complete = false;
          break;
        }
        const activeComplete = active?.coverage === "COMPLETE";
        const historicalComplete = historical?.coverage === "COMPLETE";
        if (!activeComplete && !historicalComplete) {
          complete = false;
          break;
        }
        if (activeComplete) coverageSource = "ACTIVE_FWA_WAR_ROSTER";
        else if (historicalComplete && coverageSource === null) coverageSource = "FWA_WAR_PARTICIPATION";
      }
      if (complete && coverageSource !== null) {
        completeCoverageByBoundary.set(boundaryKey, { source: coverageSource });
      }
    }

    const evidenceByPlayer: MembershipBoundaryEvidenceByPlayer = {};
    for (const playerTag of playerTags) {
      evidenceByPlayer[playerTag] = boundaries.map((boundaryTime) => {
        const key = evidenceKey(playerTag, boundaryTime);
        const positiveTags = new Set<string>([
          ...(activeTagsByKey.get(key) ?? []),
          ...(historicalTagsByKey.get(key) ?? []),
        ]);
        const completeCoverage = completeCoverageByBoundary.get(dateKey(boundaryTime));
        const positiveSource = activeTagsByKey.get(key)?.size
          ? "ACTIVE_FWA_WAR_ROSTER"
          : historicalTagsByKey.get(key)?.size
            ? "FWA_WAR_PARTICIPATION"
            : completeCoverage?.source ?? null;
        const fwa = buildFwaEvidence(
          positiveTags,
          completeCoverage !== undefined,
          positiveSource,
        );
        return {
          playerTag,
          boundaryTime,
          fwa,
          alliance: buildAllianceEvidence(fwa),
        };
      });
    }

    return {
      playerTags,
      boundaries,
      boundaryIdentities,
      evidenceByPlayer,
      historyBoundReached,
      boundaryHistoryTruncated: historyBoundReached,
      historicalCanonicalization,
    };
  }
}

export const membershipStreakService = new MembershipStreakService();
