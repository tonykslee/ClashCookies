import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";

const DEFAULT_MAX_BOUNDARIES = 100;
const HARD_MAX_BOUNDARIES = 500;

export type MembershipStreakInput = {
  guildId: string;
  playerTags: string[];
  maxBoundaries?: number;
};

export type MembershipFwaEvidenceSource =
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
};

export type MembershipStreakBatchResult = {
  streaks: MembershipStreakResult[];
  boundaryTimes: Date[];
  boundaryIdentities: Array<{ boundaryTime: Date; syncNumber: number }>;
  boundaryHistoryTruncated: boolean;
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer;
};

export type MembershipBoundaryEvidenceByPlayer = Record<string, MembershipBoundaryEvidence[]>;

type MembershipStreakDb = {
  syncCycle: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
  syncClanReadinessSnapshot: {
    groupBy: (args?: any) => Promise<any[]>;
  };
  syncClanMemberSnapshot: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
  allianceClanMembershipInterval: { findMany: (args?: any) => Promise<any[]> };
  clanPointsSync: { findMany: (args?: any) => Promise<any[]> };
  warPlanComplianceEvaluation: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: { findMany: (args?: any) => Promise<any[]> };
};

const defaultDb = prisma as unknown as MembershipStreakDb;

type CanonicalCycle = {
  syncNumber: number;
  syncTime: Date;
};

type PointIdentity = {
  syncNumber: number;
  warId: number | null;
  clanTag: string;
  warStartTime: Date;
  opponentTag: string;
};

type HistoricalFwaHistory = {
  warId: number;
  syncNumber: number;
  syncTime: Date;
  clanTag: string;
};

type IntervalRow = {
  playerTag: string;
  clanTag: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

type LoadedEvidence = {
  playerTags: string[];
  boundaries: Date[];
  boundaryIdentities: Array<{ boundaryTime: Date; syncNumber: number }>;
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
  const byTime = new Map<number, CanonicalCycle>();
  for (const row of rows) {
    const syncNumber = normalizePositiveInteger(row?.syncNumber);
    if (!syncNumber || !isValidDate(row?.syncTime)) continue;
    const current = byTime.get(row.syncTime.getTime());
    if (!current || syncNumber < current.syncNumber) {
      byTime.set(row.syncTime.getTime(), { syncNumber, syncTime: row.syncTime });
    }
  }
  return [...byTime.values()].sort((a, b) => compareDatesDescending(a.syncTime, b.syncTime));
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
  const clauses = new Map<string, any>();
  for (const point of points) {
    if (!syncNumbers.has(point.syncNumber)) continue;
    const clause = point.warId !== null
      ? { syncNumber: point.syncNumber, warId: point.warId }
      : {
          syncNumber: point.syncNumber,
          clanTag: point.clanTag,
          warStartTime: point.warStartTime,
          opponentTag: point.opponentTag,
        };
    clauses.set(JSON.stringify(clause), clause);
  }
  for (const row of evaluationRows) {
    const syncNumber = normalizePositiveInteger(row?.warHistory?.syncNumber);
    const warId = normalizePositiveInteger(row?.warId);
    if (!syncNumber || !warId || !syncNumbers.has(syncNumber)) continue;
    const clause = { syncNumber, warId };
    clauses.set(JSON.stringify(clause), clause);
  }
  return clauses.size > 0 ? { OR: [...clauses.values()] } : null;
}

/** Purpose: normalize FWA history rows against canonical sync-cycle times. */
function normalizeHistoricalHistories(
  rows: any[],
  cyclesBySyncNumber: Map<number, CanonicalCycle>,
): HistoricalFwaHistory[] {
  const byIdentity = new Map<string, HistoricalFwaHistory>();
  for (const row of rows) {
    const warId = normalizePositiveInteger(row?.warId);
    const syncNumber = normalizePositiveInteger(row?.syncNumber);
    const clanTag = normalizeClanTag(row?.clanTag);
    const cycle = syncNumber ? cyclesBySyncNumber.get(syncNumber) : undefined;
    if (!warId || !syncNumber || !cycle || !clanTag || !isFwaMatchType(row?.matchType)) continue;
    const normalized: HistoricalFwaHistory = { warId, syncNumber, syncTime: cycle.syncTime, clanTag };
    byIdentity.set(`${warId}|${syncNumber}|${clanTag}`, normalized);
  }
  return [...byIdentity.values()].sort((a, b) =>
    compareDatesDescending(a.syncTime, b.syncTime) ||
    a.clanTag.localeCompare(b.clanTag) ||
    a.warId - b.warId,
  );
}

/** Purpose: normalize and deduplicate observed alliance membership intervals. */
function normalizeIntervals(rows: any[]): IntervalRow[] {
  const byIdentity = new Map<string, IntervalRow>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row?.playerTag);
    const clanTag = normalizeClanTag(row?.clanTag);
    if (!playerTag || !clanTag || !isValidDate(row?.firstObservedAt) || !isValidDate(row?.lastObservedAt)) continue;
    if (row.lastObservedAt.getTime() < row.firstObservedAt.getTime()) continue;
    const normalized: IntervalRow = {
      playerTag,
      clanTag,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
    };
    byIdentity.set(`${playerTag}|${clanTag}|${dateKey(row.firstObservedAt)}|${dateKey(row.lastObservedAt)}`, normalized);
  }
  return [...byIdentity.values()];
}

/** Purpose: resolve exact, absent, fallback, or unknown FWA evidence for one boundary. */
function buildFwaEvidence(
  exactTags: Set<string> | undefined,
  fallbackTags: Set<string> | undefined,
  exactCaptureAvailable: boolean,
): MembershipFwaEvidence {
  if (exactCaptureAvailable && (!exactTags || exactTags.size === 0)) {
    return { status: "ABSENT", clanTag: null, clanTags: [], source: "SYNC_SNAPSHOT" };
  }
  const tags = exactTags && exactTags.size > 0 ? exactTags : fallbackTags;
  if (!tags || tags.size === 0) {
    return { status: "UNKNOWN", clanTag: null, clanTags: [], source: null };
  }
  const clanTags = uniqueSortedTags(tags);
  const source: MembershipFwaEvidenceSource = exactTags && exactTags.size > 0
    ? "SYNC_SNAPSHOT"
    : "FWA_WAR_PARTICIPATION_FALLBACK";
  return {
    status: clanTags.length === 1 ? "RESOLVED" : "AMBIGUOUS",
    clanTag: clanTags.length === 1 ? clanTags[0] : null,
    clanTags,
    source,
  };
}

/** Purpose: combine FWA and interval observations into positive alliance evidence. */
function buildAllianceEvidence(
  fwa: MembershipFwaEvidence,
  intervalTags: Set<string>,
): MembershipAllianceEvidence {
  const fwaPositive = fwa.status === "RESOLVED" || fwa.status === "AMBIGUOUS";
  const intervalPositive = intervalTags.size > 0;
  const clanTags = uniqueSortedTags([...fwa.clanTags, ...intervalTags]);
  return {
    positive: fwaPositive || intervalPositive,
    clanTags,
    ambiguous: clanTags.length > 1,
    sources: [
      ...(fwaPositive ? ["FWA_EVIDENCE" as const] : []),
      ...(intervalPositive ? ["ALLIANCE_INTERVAL" as const] : []),
    ],
  };
}

/** Purpose: compute bounded physical-clan and alliance streaks from boundary evidence. */
export function computeMembershipStreaksFromEvidence(
  playerTag: string,
  boundaries: Date[],
  evidenceRows: MembershipBoundaryEvidence[],
  historyBoundReached: boolean,
): MembershipStreakResult {
  const evidenceByKey = new Map(
    evidenceRows.map((row) => [evidenceKey(playerTag, row.boundaryTime), row]),
  );
  const latestBoundaryTime = boundaries[0] ?? null;
  const latest = latestBoundaryTime ? evidenceByKey.get(evidenceKey(playerTag, latestBoundaryTime)) : undefined;

  let clanStreakSyncs = 0;
  let clanStreakIsLowerBound = false;
  if (latest?.fwa.status === "ABSENT") {
    clanStreakSyncs = 0;
  } else if (latest?.fwa.status === "RESOLVED") {
    const latestClanTag = latest.fwa.clanTag!;
    clanStreakSyncs = 1;
    let stopped = false;
    for (let index = 1; index < boundaries.length; index += 1) {
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
    if (!stopped && clanStreakSyncs === boundaries.length && historyBoundReached) {
      clanStreakIsLowerBound = true;
    }
  } else if (latestBoundaryTime) {
    clanStreakIsLowerBound = true;
  }

  let allianceStreakSyncs = 0;
  let allianceStreakIsLowerBound = false;
  if (latest?.alliance.positive) {
    allianceStreakSyncs = 1;
    let stopped = false;
    for (let index = 1; index < boundaries.length; index += 1) {
      const evidence = evidenceByKey.get(evidenceKey(playerTag, boundaries[index]));
      if (evidence?.alliance.positive) {
        allianceStreakSyncs += 1;
        continue;
      }
      allianceStreakIsLowerBound = true;
      stopped = true;
      break;
    }
    if (!stopped && allianceStreakSyncs === boundaries.length && historyBoundReached) {
      allianceStreakIsLowerBound = true;
    }
  } else if (latestBoundaryTime) {
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
  };
}

/** Purpose: resolve bounded, persisted membership evidence in bulk for future Home Clan automation. */
export class MembershipStreakService {
  constructor(private readonly db: MembershipStreakDb = defaultDb) {}

  /** Purpose: return streaks and the same canonical boundary window through one bulk evidence load. */
  async getMembershipStreakBatchForPlayers(input: MembershipStreakInput): Promise<MembershipStreakBatchResult> {
    const loaded = await this.loadEvidence(input);
    const results = loaded.playerTags.map((playerTag) => computeMembershipStreaksFromEvidence(
      playerTag,
      loaded.boundaries,
      loaded.evidenceByPlayer[playerTag],
      loaded.historyBoundReached,
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
    return (await this.loadEvidence(input)).evidenceByPlayer;
  }

  /** Purpose: expose the same recent evidence under a concise future-consumer alias. */
  async getRecentFwaEvidenceForPlayers(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    return this.getMembershipBoundaryEvidenceForPlayers(input);
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
    const intervalRowTake = boundaryTake * Math.max(playerTags.length, 1) * 4;
    const [rawCycleBoundaries, rawReadinessBoundaries, rawMemberBoundaries] = await Promise.all([
      this.db.syncCycle.groupBy({
        by: ["syncTime"],
        where: { guildId },
        orderBy: { syncTime: "desc" },
        take: boundaryTake,
      }),
      this.db.syncClanReadinessSnapshot.groupBy({
        by: ["syncTime"],
        where: { guildId },
        orderBy: { syncTime: "desc" },
        take: boundaryTake,
      }),
      this.db.syncClanMemberSnapshot.groupBy({
        by: ["syncTime"],
        where: { guildId },
        orderBy: { syncTime: "desc" },
        take: boundaryTake,
      }),
    ]);

    const cycleBoundaryTimes = normalizeBoundaryTimes(rawCycleBoundaries);
    const readinessBoundaryTimes = normalizeBoundaryTimes(rawReadinessBoundaries);
    const memberBoundaryTimes = normalizeBoundaryTimes(rawMemberBoundaries);
    const allBoundaryTimes = new Map<number, Date>();
    for (const boundaryTime of [...cycleBoundaryTimes, ...readinessBoundaryTimes, ...memberBoundaryTimes]) {
      allBoundaryTimes.set(boundaryTime.getTime(), boundaryTime);
    }
    const sortedBoundaryTimes = [...allBoundaryTimes.values()].sort(compareDatesDescending);
    const historyBoundReached =
      cycleBoundaryTimes.length > maxBoundaries ||
      readinessBoundaryTimes.length > maxBoundaries ||
      memberBoundaryTimes.length > maxBoundaries ||
      sortedBoundaryTimes.length > maxBoundaries;
    const boundaryHistoryTruncated = historyBoundReached;
    const boundaries = sortedBoundaryTimes.slice(0, maxBoundaries);
    const boundaryTimeSet = new Set(boundaries.map(dateKey));
    const exactCaptureBoundarySet = new Set(
      memberBoundaryTimes.filter((boundaryTime) => boundaryTimeSet.has(dateKey(boundaryTime))).map(dateKey),
    );

    let rawCycles: any[] = [];
    let rawMemberSnapshots: any[] = [];
    if (boundaries.length > 0) {
      [rawCycles, rawMemberSnapshots] = await Promise.all([
        this.db.syncCycle.findMany({
          where: { guildId, syncTime: { in: boundaries } },
          orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
          select: { syncNumber: true, syncTime: true },
        }),
        this.db.syncClanMemberSnapshot.findMany({
          where: { guildId, syncTime: { in: boundaries }, playerTag: { in: playerTags } },
          orderBy: [{ syncTime: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
          select: { guildId: true, syncTime: true, clanTag: true, playerTag: true },
        }),
      ]);
    }

    const cycles = normalizeCanonicalCycles(rawCycles);
    const boundedCycles = cycles.filter((cycle) => boundaryTimeSet.has(dateKey(cycle.syncTime)));
    const boundaryIdentities = boundedCycles.map((cycle) => ({
      boundaryTime: cycle.syncTime,
      syncNumber: cycle.syncNumber,
    }));
    const boundedCyclesBySyncNumber = new Map(boundedCycles.map((cycle) => [cycle.syncNumber, cycle]));
    const fallbackSyncNumbers = boundedCycles
      .filter((cycle) => !exactCaptureBoundarySet.has(dateKey(cycle.syncTime)))
      .map((cycle) => cycle.syncNumber)
      .sort((a, b) => a - b);
    const newestBoundary = boundaries[0];
    const oldestBoundary = boundaries[boundaries.length - 1];

    const [rawIntervals, rawPoints, rawEvaluations] = await Promise.all([
      this.db.allianceClanMembershipInterval.findMany({
        where: {
          guildId,
          playerTag: { in: playerTags },
          ...(newestBoundary && oldestBoundary
            ? {
                firstObservedAt: { lte: newestBoundary },
                lastObservedAt: { gte: oldestBoundary },
              }
            : {}),
        },
        orderBy: [{ playerTag: "asc" }, { firstObservedAt: "asc" }, { clanTag: "asc" }],
        take: intervalRowTake,
        select: { playerTag: true, clanTag: true, firstObservedAt: true, lastObservedAt: true },
      }),
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
          select: { warId: true, syncNumber: true, matchType: true, clanTag: true },
        })
      : [];
    const histories = normalizeHistoricalHistories(rawHistories, boundedCyclesBySyncNumber);
    const warIds = [...new Set(histories.map((row) => String(row.warId)))];
    const rawParticipation = warIds.length > 0
      ? await this.db.clanWarParticipation.findMany({
          where: { guildId, warId: { in: warIds }, playerTag: { in: playerTags } },
          orderBy: [{ warId: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
          select: { warId: true, clanTag: true, playerTag: true },
        })
      : [];

    const exactTagsByKey = new Map<string, Set<string>>();
    for (const row of rawMemberSnapshots) {
      const playerTag = normalizePlayerTag(row?.playerTag);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!playerTag || !clanTag || !isValidDate(row?.syncTime) || !boundaryTimeSet.has(dateKey(row.syncTime))) continue;
      const key = evidenceKey(playerTag, row.syncTime);
      const tags = exactTagsByKey.get(key) ?? new Set<string>();
      tags.add(clanTag);
      exactTagsByKey.set(key, tags);
    }

    const fallbackTagsByKey = new Map<string, Set<string>>();
    const historyByWarId = new Map<number, HistoricalFwaHistory[]>();
    for (const history of histories) {
      const rows = historyByWarId.get(history.warId) ?? [];
      rows.push(history);
      historyByWarId.set(history.warId, rows);
    }
    const participationKeys = new Set<string>();
    for (const row of rawParticipation) {
      const warId = normalizePositiveInteger(row?.warId);
      const playerTag = normalizePlayerTag(row?.playerTag);
      const clanTag = normalizeClanTag(row?.clanTag);
      if (!warId || !playerTag || !clanTag) continue;
      for (const history of historyByWarId.get(warId) ?? []) {
        if (history.clanTag !== clanTag) continue;
        const dedupeKey = `${history.warId}|${history.syncNumber}|${playerTag}|${clanTag}`;
        if (participationKeys.has(dedupeKey)) continue;
        participationKeys.add(dedupeKey);
        const key = evidenceKey(playerTag, history.syncTime);
        const tags = fallbackTagsByKey.get(key) ?? new Set<string>();
        tags.add(clanTag);
        fallbackTagsByKey.set(key, tags);
      }
    }

    const intervals = normalizeIntervals(rawIntervals);
    const intervalHistoryBoundReached = rawIntervals.length >= intervalRowTake;
    const evidenceByPlayer: MembershipBoundaryEvidenceByPlayer = {};
    for (const playerTag of playerTags) {
      evidenceByPlayer[playerTag] = boundaries.map((boundaryTime) => {
        const key = evidenceKey(playerTag, boundaryTime);
        const fwa = buildFwaEvidence(
          exactTagsByKey.get(key),
          fallbackTagsByKey.get(key),
          exactCaptureBoundarySet.has(dateKey(boundaryTime)),
        );
        const intervalTags = new Set(
          intervals
            .filter((interval) =>
              interval.playerTag === playerTag &&
              interval.firstObservedAt.getTime() <= boundaryTime.getTime() &&
              interval.lastObservedAt.getTime() >= boundaryTime.getTime(),
            )
            .map((interval) => interval.clanTag),
        );
        return {
          playerTag,
          boundaryTime,
          fwa,
          alliance: buildAllianceEvidence(fwa, intervalTags),
        };
      });
    }

    return {
      playerTags,
      boundaries,
      boundaryIdentities,
      evidenceByPlayer,
      historyBoundReached: historyBoundReached || intervalHistoryBoundReached,
      boundaryHistoryTruncated,
    };
  }
}

export const membershipStreakService = new MembershipStreakService();
