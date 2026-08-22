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
  status: "RESOLVED" | "AMBIGUOUS" | "UNKNOWN";
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
  latestFwaClanTag: string | null;
  clanStreakSyncs: number;
  clanStreakIsLowerBound: boolean;
  allianceStreakSyncs: number;
  allianceStreakIsLowerBound: boolean;
  latestEvidenceAvailable: boolean;
};

export type MembershipBoundaryEvidenceByPlayer = Record<string, MembershipBoundaryEvidence[]>;

type MembershipStreakDb = {
  syncCycle: { findMany: (args?: any) => Promise<any[]> };
  syncClanReadinessSnapshot: { findMany: (args?: any) => Promise<any[]> };
  syncClanMemberSnapshot: { findMany: (args?: any) => Promise<any[]> };
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
  evidenceByPlayer: MembershipBoundaryEvidenceByPlayer;
  historyBoundReached: boolean;
};

function normalizeGuildId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePlayerTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

function normalizeClanTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

function normalizePlayerTags(values: unknown): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizePlayerTag)
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

function normalizeMaxBoundaries(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_BOUNDARIES;
  return Math.min(parsed, HARD_MAX_BOUNDARIES);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedComparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function isFwaMatchType(value: unknown): boolean {
  return normalizedComparable(value) === "FWA";
}

function dateKey(value: Date): string {
  return String(value.getTime());
}

function evidenceKey(playerTag: string, boundaryTime: Date): string {
  return `${playerTag}|${dateKey(boundaryTime)}`;
}

function compareDatesDescending(a: Date, b: Date): number {
  return b.getTime() - a.getTime();
}

function uniqueSortedTags(tags: Iterable<string>): string[] {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

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

function buildFwaEvidence(
  exactTags: Set<string> | undefined,
  fallbackTags: Set<string> | undefined,
): MembershipFwaEvidence {
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

function buildAllianceEvidence(
  fwa: MembershipFwaEvidence,
  intervalTags: Set<string>,
): MembershipAllianceEvidence {
  const fwaPositive = fwa.status !== "UNKNOWN";
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

function computeStreaks(
  playerTag: string,
  boundaries: Date[],
  evidenceByKey: Map<string, MembershipBoundaryEvidence>,
  historyBoundReached: boolean,
): MembershipStreakResult {
  const latestBoundaryTime = boundaries[0] ?? null;
  const latest = latestBoundaryTime ? evidenceByKey.get(evidenceKey(playerTag, latestBoundaryTime)) : undefined;

  let clanStreakSyncs = 0;
  let clanStreakIsLowerBound = false;
  if (latest?.fwa.status === "RESOLVED") {
    const latestClanTag = latest.fwa.clanTag!;
    clanStreakSyncs = 1;
    let stopped = false;
    for (let index = 1; index < boundaries.length; index += 1) {
      const evidence = evidenceByKey.get(evidenceKey(playerTag, boundaries[index]));
      if (evidence?.fwa.status === "RESOLVED" && evidence.fwa.clanTag === latestClanTag) {
        clanStreakSyncs += 1;
        continue;
      }
      if (evidence?.fwa.status === "RESOLVED") break;
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

  async getMembershipStreaksForPlayers(input: MembershipStreakInput): Promise<MembershipStreakResult[]> {
    const loaded = await this.loadEvidence(input);
    const evidenceMaps = new Map(
      loaded.playerTags.map((playerTag) => [
        playerTag,
        new Map(loaded.evidenceByPlayer[playerTag].map((row) => [evidenceKey(playerTag, row.boundaryTime), row])),
      ]),
    );
    const results = loaded.playerTags.map((playerTag) => computeStreaks(
      playerTag,
      loaded.boundaries,
      evidenceMaps.get(playerTag)!,
      loaded.historyBoundReached,
    ));
    console.debug(
      `[membership-streak] event=bulk_resolution guild_id=${normalizeGuildId(input.guildId) || "unknown"} players=${loaded.playerTags.length} boundaries=${loaded.boundaries.length} lower_bound=${loaded.historyBoundReached ? 1 : 0}`,
    );
    return results;
  }

  /** Purpose: expose the recent boundary evidence primitive for later Home Clan establishment logic. */
  async getMembershipBoundaryEvidenceForPlayers(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    return (await this.loadEvidence(input)).evidenceByPlayer;
  }

  /** Alias retained as a concise reuse point for future exact FWA evidence consumers. */
  async getRecentFwaEvidenceForPlayers(
    input: MembershipStreakInput,
  ): Promise<MembershipBoundaryEvidenceByPlayer> {
    return this.getMembershipBoundaryEvidenceForPlayers(input);
  }

  private async loadEvidence(input: MembershipStreakInput): Promise<LoadedEvidence> {
    const guildId = normalizeGuildId(input.guildId);
    const playerTags = normalizePlayerTags(input.playerTags);
    const maxBoundaries = normalizeMaxBoundaries(input.maxBoundaries);
    if (!guildId || playerTags.length === 0) {
      return { playerTags, boundaries: [], evidenceByPlayer: {}, historyBoundReached: false };
    }

    const boundaryTake = maxBoundaries + 1;
    const memberRowTake = boundaryTake * Math.max(playerTags.length, 1) * 4;
    const [rawCycles, rawReadiness, rawMemberSnapshots] = await Promise.all([
      this.db.syncCycle.findMany({
        where: { guildId },
        orderBy: [{ syncTime: "desc" }, { syncNumber: "desc" }],
        take: boundaryTake,
        select: { syncNumber: true, syncTime: true },
      }),
      this.db.syncClanReadinessSnapshot.findMany({
        where: { guildId },
        orderBy: [{ syncTime: "desc" }, { clanTag: "asc" }],
        take: boundaryTake,
        select: { syncTime: true },
      }),
      this.db.syncClanMemberSnapshot.findMany({
        where: { guildId, playerTag: { in: playerTags } },
        orderBy: [{ syncTime: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
        take: memberRowTake,
        select: { guildId: true, syncTime: true, clanTag: true, playerTag: true },
      }),
    ]);

    const cycles = normalizeCanonicalCycles(rawCycles);
    const allBoundaryTimes = new Map<number, Date>();
    for (const cycle of cycles) allBoundaryTimes.set(cycle.syncTime.getTime(), cycle.syncTime);
    for (const row of rawReadiness) {
      if (isValidDate(row?.syncTime)) allBoundaryTimes.set(row.syncTime.getTime(), row.syncTime);
    }
    for (const row of rawMemberSnapshots) {
      if (isValidDate(row?.syncTime)) allBoundaryTimes.set(row.syncTime.getTime(), row.syncTime);
    }

    const sortedBoundaryTimes = [...allBoundaryTimes.values()].sort(compareDatesDescending);
    const cycleBoundaryCount = new Set(
      rawCycles.filter((row: any) => isValidDate(row?.syncTime)).map((row: any) => dateKey(row.syncTime)),
    ).size;
    const readinessBoundaryCount = new Set(
      rawReadiness.filter((row: any) => isValidDate(row?.syncTime)).map((row: any) => dateKey(row.syncTime)),
    ).size;
    const memberBoundaryCount = new Set(
      rawMemberSnapshots.filter((row: any) => isValidDate(row?.syncTime)).map((row: any) => dateKey(row.syncTime)),
    ).size;
    const historyBoundReached =
      cycleBoundaryCount > maxBoundaries ||
      readinessBoundaryCount > maxBoundaries ||
      memberBoundaryCount > maxBoundaries ||
      sortedBoundaryTimes.length > maxBoundaries;
    const boundaries = sortedBoundaryTimes.slice(0, maxBoundaries);
    const boundaryTimeSet = new Set(boundaries.map(dateKey));
    const boundedCycles = cycles.filter((cycle) => boundaryTimeSet.has(dateKey(cycle.syncTime)));
    const boundedCyclesBySyncNumber = new Map(boundedCycles.map((cycle) => [cycle.syncNumber, cycle]));
    const syncNumbers = [...boundedCyclesBySyncNumber.keys()].sort((a, b) => a - b);
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
        take: memberRowTake,
        select: { playerTag: true, clanTag: true, firstObservedAt: true, lastObservedAt: true },
      }),
      syncNumbers.length > 0
        ? this.db.clanPointsSync.findMany({
            where: { guildId, syncNum: { in: syncNumbers } },
            select: { clanTag: true, warId: true, warStartTime: true, opponentTag: true, syncNum: true },
          })
        : Promise.resolve([]),
      syncNumbers.length > 0
        ? this.db.warPlanComplianceEvaluation.findMany({
            where: { guildId, warHistory: { syncNumber: { in: syncNumbers } } },
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
      new Set(boundedCyclesBySyncNumber.keys()),
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
    const intervalHistoryBoundReached = rawIntervals.length >= memberRowTake;
    const evidenceByPlayer: MembershipBoundaryEvidenceByPlayer = {};
    for (const playerTag of playerTags) {
      evidenceByPlayer[playerTag] = boundaries.map((boundaryTime) => {
        const key = evidenceKey(playerTag, boundaryTime);
        const fwa = buildFwaEvidence(exactTagsByKey.get(key), fallbackTagsByKey.get(key));
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
      evidenceByPlayer,
      historyBoundReached: historyBoundReached || intervalHistoryBoundReached,
    };
  }
}

export const membershipStreakService = new MembershipStreakService();
