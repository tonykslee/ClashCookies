import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";
import {
  ActiveWarSyncResolutionService,
  type ActiveCycleSyncCandidate,
  type ActiveCycleSyncDiscovery,
} from "./ActiveWarSyncResolutionService";
import {
  hasMembershipHistoryIdentityConflict,
  hasMembershipHistoryPartialIdentityConflict,
  hasMembershipHistorySyncNumberDisagreement,
  historicalHistoryMatchesPoint,
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
  warLookup: { findMany: (args?: any) => Promise<any[]> };
};

const defaultDb = prisma as unknown as MembershipStreakDb;

type CanonicalCycle = {
  syncNumber: number | null;
  syncTime: Date;
};

type PointIdentity = MembershipHistoryPointIdentity & {
  syncNumber: number;
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

type LoadedEvidence = {
  playerTags: string[];
  boundaries: Date[];
  boundaryIdentities: MembershipBoundaryIdentity[];
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer;
  historyBoundReached: boolean;
  boundaryHistoryTruncated: boolean;
};

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

/** Purpose: extract only the authoritative archived roster size from WarLookup metadata. */
function parseCanonicalTeamSize(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const warMeta = root.warMeta && typeof root.warMeta === "object"
    ? root.warMeta as Record<string, unknown>
    : null;
  if (String(warMeta?.teamSizeSource ?? "").trim().toLowerCase() !== "war_event_snapshot") return null;
  return normalizePositiveInteger(warMeta?.teamSize);
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
    warId: normalizePositiveInteger(row?.warId),
    clanTag,
    warStartTime,
    opponentTag,
  };
}

/** Purpose: build narrowly scoped canonical clauses for historical FWA history reads. */
function buildHistoricalHistoryWhere(
  points: PointIdentity[],
  evaluationRows: any[],
  syncNumbers: Set<number>,
): any | null {
  if (syncNumbers.size === 0 || (points.length === 0 && evaluationRows.length === 0)) return null;
  const clauses = new Map<string, any>();
  clauses.set("syncNumbers", { syncNumber: { in: [...syncNumbers] } });
  for (const point of points) {
    if (point.warId === null) continue;
    const clause = {
      warId: point.warId,
      clanTag: point.clanTag,
    };
    clauses.set(JSON.stringify(clause), clause);
  }
  for (const row of evaluationRows) {
    const warId = normalizePositiveInteger(row?.warId);
    if (!warId) continue;
    const clause = { warId };
    clauses.set(JSON.stringify(clause), clause);
  }
  return clauses.size > 0 ? { OR: [...clauses.values()] } : null;
}

/** Purpose: normalize FWA history rows against canonical sync-cycle times. */
function normalizeHistoricalHistories(
  rows: any[],
  cyclesBySyncNumber: Map<number, CanonicalCycle>,
  points: readonly PointIdentity[],
  evaluationRows: readonly any[],
): HistoricalFwaHistory[] {
  const byIdentity = new Map<string, HistoricalFwaHistory>();
  for (const row of rows) {
    const warId = normalizePositiveInteger(row?.warId);
    const persistedSyncNumber = normalizePositiveInteger(row?.syncNumber);
    const clanTag = normalizeClanTag(row?.clanTag);
    if (!warId || !clanTag || !isFwaMatchType(row?.matchType)) continue;
    const history: MembershipCanonicalHistoryIdentity = {
      warId,
      syncNumber: persistedSyncNumber,
      clanTag,
      warStartTime: isValidDate(row?.warStartTime) ? row.warStartTime : null,
      opponentTag: row?.opponentTag == null ? null : normalizeClanTag(row.opponentTag),
    };
    const matchingPoints = points.filter((point) => historicalHistoryMatchesPoint(history, point));
    const evaluationMatch = evaluationRows.some((evaluation) =>
      normalizePositiveInteger(evaluation?.warId) === warId &&
      normalizePositiveInteger(evaluation?.warHistory?.syncNumber) === persistedSyncNumber,
    );
    const syncNumbers = new Set(matchingPoints.map((point) => point.syncNumber));
    if (evaluationMatch && persistedSyncNumber !== null) syncNumbers.add(persistedSyncNumber);
    if (syncNumbers.size === 0) continue;
    for (const syncNumber of syncNumbers) {
      const cycle = cyclesBySyncNumber.get(syncNumber);
      if (!cycle || cycle.syncNumber === null) continue;
      const normalized: HistoricalFwaHistory = {
        ...history,
        syncNumber,
        syncTime: cycle.syncTime,
      };
      byIdentity.set(`${warId}|${syncNumber}|${clanTag}`, normalized);
    }
  }
  return [...byIdentity.values()].sort((a, b) =>
    compareDatesDescending(a.syncTime, b.syncTime) ||
    a.clanTag.localeCompare(b.clanTag) ||
    a.warId - b.warId,
  );
}

/** Purpose: resolve canonical war-roster evidence for one boundary. */
function buildFwaEvidence(
  activeTags: Set<string> | undefined,
  activeBoundary: boolean,
  activeCoverage: boolean,
  historicalTags: Set<string> | undefined,
  historicalCoverage: boolean,
): MembershipFwaEvidence {
  if (activeBoundary) {
    if (activeTags && activeTags.size > 0) {
      const clanTags = uniqueSortedTags(activeTags);
      return {
        status: clanTags.length === 1 ? "RESOLVED" : "AMBIGUOUS",
        clanTag: clanTags.length === 1 ? clanTags[0] : null,
        clanTags,
        source: "ACTIVE_FWA_WAR_ROSTER",
      };
    }
    if (activeCoverage) {
      return { status: "ABSENT", clanTag: null, clanTags: [], source: "ACTIVE_FWA_WAR_ROSTER" };
    }
    return { status: "UNKNOWN", clanTag: null, clanTags: [], source: null };
  }
  if (!historicalTags || historicalTags.size === 0) {
    if (historicalCoverage) {
      return { status: "ABSENT", clanTag: null, clanTags: [], source: "FWA_WAR_PARTICIPATION" };
    }
    return { status: "UNKNOWN", clanTag: null, clanTags: [], source: null };
  }
  const clanTags = uniqueSortedTags(historicalTags);
  return {
    status: clanTags.length === 1 ? "RESOLVED" : "AMBIGUOUS",
    clanTag: clanTags.length === 1 ? clanTags[0] : null,
    clanTags,
    source: "FWA_WAR_PARTICIPATION",
  };
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
    let activeResolutionReadFailed = false;
    if (this.activeWarSyncReader) {
      try {
        activeDiscovery = await this.activeWarSyncReader.findPersistedActiveSyncNumber({ guildId });
      } catch (error) {
        activeResolutionReadFailed = true;
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
    const activeBoundaryKeys = new Set(
      activeCandidates.map((candidate) => dateKey(boundedCyclesBySyncNumber.get(candidate.syncNumber)!.syncTime)),
    );
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
            select: { clanTag: true, warId: true, warStartTime: true, opponentTag: true, syncNum: true },
          })
        : Promise.resolve([]),
      fallbackSyncNumbers.length > 0
        ? this.db.warPlanComplianceEvaluation.findMany({
            where: { guildId, warHistory: { syncNumber: { in: fallbackSyncNumbers } } },
            select: { warId: true, warHistory: { select: { syncNumber: true } } },
          })
        : Promise.resolve([]),
    ]);

    const points = rawPoints
      .map(normalizePointIdentity)
      .filter((row): row is PointIdentity => row !== null && boundedCyclesBySyncNumber.has(row.syncNumber));
    const historyWhere = buildHistoricalHistoryWhere(
      points,
      rawEvaluations,
      new Set(fallbackSyncNumbers),
    );
    const rawHistories = historyWhere
      ? await this.db.clanWarHistory.findMany({
          where: historyWhere,
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
    const canonicalHistories = normalizeHistoricalHistories(
      rawHistories,
      boundedCyclesBySyncNumber,
      points,
      rawEvaluations,
    );
    const disagreementPointKeys = new Set(
      points
        .filter((point) => hasMembershipHistorySyncNumberDisagreement(point, rawHistories))
        .map((point) => `${point.guildId ?? ""}|${point.syncNumber}|${normalizeClanTag(point.clanTag)}`),
    );
    const identityConflictPointKeys = new Set(
      points
        .filter((point) => hasMembershipHistoryIdentityConflict(point, points))
        .map((point) => `${point.guildId ?? ""}|${point.syncNumber}|${normalizeClanTag(point.clanTag)}`),
    );
    const partialIdentityConflictPointKeys = new Set(
      points
        .filter((point) => hasMembershipHistoryPartialIdentityConflict(point, points))
        .map((point) => `${point.guildId ?? ""}|${point.syncNumber}|${normalizeClanTag(point.clanTag)}`),
    );
    const matchedHistoryOwners = new Map<string, Set<string>>();
    for (const point of points) {
      const pointKey = `${point.guildId ?? ""}|${point.syncNumber}|${normalizeClanTag(point.clanTag)}`;
      if (disagreementPointKeys.has(pointKey) || identityConflictPointKeys.has(pointKey) || partialIdentityConflictPointKeys.has(pointKey)) continue;
      for (const history of canonicalHistories) {
        if (!historicalHistoryMatchesPoint(history, point)) continue;
        const historyKey = membershipCanonicalHistoryKey(history);
        const owners = matchedHistoryOwners.get(historyKey) ?? new Set<string>();
        owners.add(pointKey);
        matchedHistoryOwners.set(historyKey, owners);
      }
    }
    const multiplyOwnedHistoryKeys = new Set(
      [...matchedHistoryOwners.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([historyKey]) => historyKey),
    );
    const histories = canonicalHistories.filter((history) => {
      const historyKey = membershipCanonicalHistoryKey(history);
      if (multiplyOwnedHistoryKeys.has(historyKey)) return false;
      const matchingPoints = points.filter((point) => historicalHistoryMatchesPoint(history, point));
      if (matchingPoints.length === 0) return true;
      return matchingPoints.some((point) => {
        const pointKey = `${point.guildId ?? ""}|${point.syncNumber}|${normalizeClanTag(point.clanTag)}`;
        return !disagreementPointKeys.has(pointKey) &&
          !identityConflictPointKeys.has(pointKey) &&
          !partialIdentityConflictPointKeys.has(pointKey);
      });
    });
    const warIds = [...new Set(histories.map((row) => String(row.warId)))];
    const warLookupIds = [...new Set([
      ...warIds,
      ...activeCandidates
        .map((candidate) => candidate.warId)
        .filter((warId): warId is number => warId !== null)
        .map(String),
    ])];
    const [rawParticipation, rawParticipationCounts, rawWarLookups] = warIds.length > 0 || warLookupIds.length > 0
      ? await Promise.all([
          warIds.length > 0
            ? this.db.clanWarParticipation.findMany({
                where: { guildId, warId: { in: warIds }, playerTag: { in: playerTags } },
                orderBy: [{ warId: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
                select: { warId: true, clanTag: true, playerTag: true },
              })
            : Promise.resolve([]),
          warIds.length > 0
            ? this.db.clanWarParticipation.groupBy({
                by: ["warId", "clanTag"],
                where: { guildId, warId: { in: warIds } },
                _count: { playerTag: true },
              })
            : Promise.resolve([]),
          warLookupIds.length > 0
            ? this.db.warLookup.findMany({
                where: { warId: { in: warLookupIds } },
                select: { warId: true, clanTag: true, payload: true },
              })
            : Promise.resolve([]),
        ])
      : [[], [], []];

    const expectedTeamSizesByRosterKey = new Map<string, Set<number>>();
    for (const row of rawWarLookups) {
      const warId = normalizePositiveInteger(row?.warId);
      const clanTag = normalizeClanTag(row?.clanTag);
      const teamSize = parseCanonicalTeamSize(row?.payload);
      if (!warId || !clanTag || teamSize === null) continue;
      const key = rosterKey(warId, clanTag);
      const sizes = expectedTeamSizesByRosterKey.get(key) ?? new Set<number>();
      sizes.add(teamSize);
      expectedTeamSizesByRosterKey.set(key, sizes);
    }
    const expectedTeamSizeForRoster = (key: string): number | null => {
      const sizes = expectedTeamSizesByRosterKey.get(key);
      return sizes?.size === 1 ? [...sizes][0] : null;
    };
    const observedParticipationCountByRosterKey = new Map<string, number>();
    for (const row of rawParticipationCounts) {
      const warId = normalizePositiveInteger(row?.warId);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!warId || !clanTag) continue;
      const count = Number(row?._count?.playerTag);
      observedParticipationCountByRosterKey.set(rosterKey(warId, clanTag), Number.isInteger(count) && count >= 0 ? count : 0);
    }
    const historicalCoverageByRosterKey = new Map<string, RosterCompleteness>();
    for (const history of histories) {
      const key = rosterKey(history.warId, history.clanTag);
      const expectedSize = expectedTeamSizeForRoster(key);
      const observedCount = observedParticipationCountByRosterKey.get(key) ?? 0;
      historicalCoverageByRosterKey.set(
        key,
        expectedSize === null ? "UNKNOWN" : observedCount === expectedSize ? "COMPLETE" : "PARTIAL",
      );
    }
    const historicalRosterKeysByBoundary = new Map<string, Set<string>>();
    for (const history of histories) {
      const boundaryKey = dateKey(history.syncTime);
      const rosterKeys = historicalRosterKeysByBoundary.get(boundaryKey) ?? new Set<string>();
      rosterKeys.add(rosterKey(history.warId, history.clanTag));
      historicalRosterKeysByBoundary.set(boundaryKey, rosterKeys);
    }
    const historicalCoverageBoundaryKeys = new Set<string>();
    for (const [boundaryKey, rosterKeys] of historicalRosterKeysByBoundary) {
      if ([...rosterKeys].every((key) => historicalCoverageByRosterKey.get(key) === "COMPLETE")) {
        historicalCoverageBoundaryKeys.add(boundaryKey);
      }
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
        const boundaryKey = dateKey(cycle.syncTime);
        activeBoundaryKeys.add(boundaryKey);
        if (!playerTags.includes(playerTag)) continue;
        const key = evidenceKey(playerTag, cycle.syncTime);
        const tags = activeTagsByKey.get(key) ?? new Set<string>();
        tags.add(clanTag);
        activeTagsByKey.set(key, tags);
      }
    }

    const activeCoverageByBoundary = new Map<string, RosterCompleteness>();
    const activeCandidatesByBoundary = new Map<string, Set<string>>();
    for (const candidate of activeCandidates) {
      const cycle = boundedCyclesBySyncNumber.get(candidate.syncNumber);
      if (!cycle) continue;
      const boundaryKey = dateKey(cycle.syncTime);
      const candidateKey = activeCandidateKey(candidate);
      const candidateKeys = activeCandidatesByBoundary.get(boundaryKey) ?? new Set<string>();
      candidateKeys.add(candidateKey);
      activeCandidatesByBoundary.set(boundaryKey, candidateKeys);
      const expectedSize = candidate.warId === null
        ? null
        : expectedTeamSizeForRoster(rosterKey(candidate.warId, candidate.clanTag));
      const observedSize = activeRosterPlayersByCandidateKey.get(candidateKey)?.size ?? 0;
      const current = activeCoverageByBoundary.get(candidateKey);
      const coverage: RosterCompleteness = expectedSize === null
        ? "UNKNOWN"
        : observedSize === expectedSize ? "COMPLETE" : "PARTIAL";
      if (!current || current === "COMPLETE" && coverage !== "COMPLETE") activeCoverageByBoundary.set(candidateKey, coverage);
    }
    const completeActiveBoundaries = new Set<string>();
    for (const [boundaryKey, candidateKeys] of activeCandidatesByBoundary) {
      if ([...candidateKeys].every((candidateKey) => activeCoverageByBoundary.get(candidateKey) === "COMPLETE")) {
        completeActiveBoundaries.add(boundaryKey);
      }
    }

    const historicalTagsByKey = new Map<string, Set<string>>();
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

    const evidenceByPlayer: MembershipBoundaryEvidenceByPlayer = {};
    for (const playerTag of playerTags) {
      evidenceByPlayer[playerTag] = boundaries.map((boundaryTime) => {
        const key = evidenceKey(playerTag, boundaryTime);
        const fwa = buildFwaEvidence(
          activeTagsByKey.get(key),
          activeBoundaryKeys.has(dateKey(boundaryTime)) ||
            (activeResolutionReadFailed && boundaries[0]?.getTime() === boundaryTime.getTime()),
          completeActiveBoundaries.has(dateKey(boundaryTime)),
          historicalTagsByKey.get(key),
          historicalCoverageBoundaryKeys.has(dateKey(boundaryTime)),
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
    };
  }
}

export const membershipStreakService = new MembershipStreakService();
