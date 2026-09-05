import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";
import {
  resolvePersistedCwlEventTimings,
  type CwlEventTimingDb,
  type PersistedCwlEventTiming,
} from "./CwlEventTimingService";

export type CwlContinuityEvidenceInput = {
  guildId: string;
  playerTags: string[];
  boundaryTimes: Date[];
};

export type CwlContinuityEvidenceResult = {
  exemptPairs: ReadonlySet<string>;
  neutralBoundaryCount: number;
  neutralPlayerCount: number;
  candidatesRejected: number;
  ambiguousCandidates: number;
};

type ContinuityDb = CwlEventTimingDb & {
  cwlPlayerClanSeason: { findMany: (args?: any) => Promise<any[]> };
  cwlTrackedClan: { findMany: (args?: any) => Promise<any[]> };
  allianceClanMembershipInterval: { findMany: (args?: any) => Promise<any[]> };
};

const continuityDb = prisma as unknown as ContinuityDb;

/** Purpose: normalize a player tag into the canonical hash-prefixed form. */
function normalizePlayerTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize a clan tag into the canonical hash-prefixed form. */
function normalizeClanTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: return a stable key for one player and canonical boundary pair. */
export function cwlContinuityPairKey(playerTag: string, boundaryTime: Date): string {
  return `${playerTag}|${boundaryTime.getTime()}`;
}

/** Purpose: return an empty read-only result when bounded CWL proof is unavailable. */
export function emptyCwlContinuityEvidence(): CwlContinuityEvidenceResult {
  return {
    exemptPairs: new Set<string>(),
    neutralBoundaryCount: 0,
    neutralPlayerCount: 0,
    candidatesRejected: 0,
    ambiguousCandidates: 0,
  };
}

type RosterCandidate = {
  eventInstanceId: string;
  season: string;
  playerTag: string;
  clanTag: string;
};

/** Purpose: prove one physical interval covers a boundary under one event's persisted lifecycle facts. */
function intervalProvesBoundary(
  interval: any,
  boundaryTime: Date,
  timing: PersistedCwlEventTiming,
): boolean {
  const firstObservedAt = interval?.firstObservedAt instanceof Date && Number.isFinite(interval.firstObservedAt.getTime())
    ? interval.firstObservedAt
    : null;
  const endedAt = interval?.endedAt == null
    ? null
    : interval.endedAt instanceof Date && Number.isFinite(interval.endedAt.getTime())
      ? interval.endedAt
      : undefined;
  if (!firstObservedAt || endedAt === undefined || firstObservedAt.getTime() > boundaryTime.getTime()) return false;
  if (endedAt && boundaryTime.getTime() >= endedAt.getTime()) return false;
  if (!timing.startResolved || !timing.startsAt) return false;

  const boundaryMs = boundaryTime.getTime();
  const startMs = timing.startsAt.getTime();
  if (boundaryMs < startMs) {
    return !endedAt || endedAt.getTime() > startMs;
  }
  if (timing.endResolved && timing.endsAt) {
    return boundaryMs <= timing.endsAt.getTime();
  }
  return Boolean(timing.coverageThrough && boundaryMs <= timing.coverageThrough.getTime());
}

/** Purpose: read player-aware, event-specific persisted CWL excursion proof in bounded bulk queries. */
export class CwlContinuityEvidenceService {
  constructor(private readonly db: ContinuityDb = continuityDb) {}

  /** Purpose: return only exact player/boundary pairs proven to be CWL-neutral. */
  async getEvidence(input: CwlContinuityEvidenceInput): Promise<CwlContinuityEvidenceResult> {
    const guildId = String(input.guildId ?? "").trim();
    const playerTags = [...new Set(input.playerTags.map(normalizePlayerTag).filter(Boolean))];
    const boundaryTimes = input.boundaryTimes.filter(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    );
    if (!guildId || playerTags.length === 0 || boundaryTimes.length === 0) return emptyCwlContinuityEvidence();

    const minBoundaryTime = new Date(Math.min(...boundaryTimes.map((value) => value.getTime())));
    const maxBoundaryTime = new Date(Math.max(...boundaryTimes.map((value) => value.getTime())));
    const playerSeasonRows = await this.db.cwlPlayerClanSeason.findMany({
      where: { playerTag: { in: playerTags } },
      select: { eventInstanceId: true, season: true, playerTag: true, cwlClanTag: true },
    });
    const rosterCandidates = playerSeasonRows
      .map((row): RosterCandidate | null => {
        const playerTag = normalizePlayerTag(row?.playerTag);
        const clanTag = normalizeClanTag(row?.cwlClanTag);
        const season = String(row?.season ?? "").trim();
        const eventInstanceId = String(row?.eventInstanceId ?? "").trim();
        return playerTag && clanTag && season && eventInstanceId
          ? { eventInstanceId, season, playerTag, clanTag }
          : null;
      })
      .filter((row): row is RosterCandidate => row !== null);
    if (rosterCandidates.length === 0) return emptyCwlContinuityEvidence();

    const seasons = [...new Set(rosterCandidates.map((row) => row.season))];
    const clanTags = [...new Set(rosterCandidates.map((row) => row.clanTag))];
    const eventInstanceIds = [...new Set(rosterCandidates.map((row) => row.eventInstanceId))];
    const [trackedRows, intervalRows] = await Promise.all([
      this.db.cwlTrackedClan.findMany({
        where: { season: { in: seasons }, tag: { in: clanTags } },
        select: { season: true, tag: true },
      }),
      this.db.allianceClanMembershipInterval.findMany({
        where: {
          guildId,
          playerTag: { in: playerTags },
          clanTag: { in: clanTags },
          firstObservedAt: { lte: maxBoundaryTime },
          OR: [{ endedAt: null }, { endedAt: { gt: minBoundaryTime } }],
        },
        select: { playerTag: true, clanTag: true, firstObservedAt: true, endedAt: true },
      }),
    ]);
    const trackedKeys = new Set(
      trackedRows.map((row) => `${String(row?.season ?? "").trim()}|${normalizeClanTag(row?.tag)}`),
    );
    const intervalsByPlayerAndClan = new Map<string, any[]>();
    for (const row of intervalRows) {
      const key = `${normalizePlayerTag(row?.playerTag)}|${normalizeClanTag(row?.clanTag)}`;
      const rows = intervalsByPlayerAndClan.get(key) ?? [];
      rows.push(row);
      intervalsByPlayerAndClan.set(key, rows);
    }

    const timings = await resolvePersistedCwlEventTimings(this.db, eventInstanceIds);
    const exemptPairs = new Set<string>();
    const players = new Set<string>();
    let candidatesRejected = 0;
    let ambiguousCandidates = 0;
    for (const playerTag of playerTags) {
      for (const boundaryTime of boundaryTimes) {
        const candidates = rosterCandidates.filter((candidate) => {
          if (candidate.playerTag !== playerTag || !trackedKeys.has(`${candidate.season}|${candidate.clanTag}`)) return false;
          const timing = timings.get(candidate.eventInstanceId);
          if (!timing) return false;
          const intervals = intervalsByPlayerAndClan.get(`${playerTag}|${candidate.clanTag}`) ?? [];
          return intervals.some((interval) => intervalProvesBoundary(interval, boundaryTime, timing));
        });
        const uniqueCandidates = [...new Map(candidates.map((candidate) => [
          `${candidate.eventInstanceId}|${candidate.season}|${candidate.clanTag}`,
          candidate,
        ])).values()];
        if (uniqueCandidates.length > 1) {
          ambiguousCandidates += 1;
          candidatesRejected += 1;
          continue;
        }
        if (uniqueCandidates.length !== 1) {
          if (rosterCandidates.some((candidate) => candidate.playerTag === playerTag)) candidatesRejected += 1;
          continue;
        }
        exemptPairs.add(cwlContinuityPairKey(playerTag, boundaryTime));
        players.add(playerTag);
      }
    }
    return {
      exemptPairs,
      neutralBoundaryCount: new Set([...exemptPairs].map((key) => key.slice(key.indexOf("|") + 1))).size,
      neutralPlayerCount: players.size,
      candidatesRejected,
      ambiguousCandidates,
    };
  }
}

export const cwlContinuityEvidenceService = new CwlContinuityEvidenceService();
