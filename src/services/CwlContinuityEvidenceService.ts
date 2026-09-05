import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";
import {
  cwlAllianceActivityService,
  type PersistedCwlWindow,
} from "./CwlAllianceActivityService";

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

type ContinuityDb = {
  cwlPlayerClanSeason: { findMany: (args?: any) => Promise<any[]> };
  cwlTrackedClan: { findMany: (args?: any) => Promise<any[]> };
  allianceClanMembershipInterval: { findMany: (args?: any) => Promise<any[]> };
};

type CwlWindowReader = Pick<typeof cwlAllianceActivityService, "getCwlWindow">;

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
  eventLastObservedAt: Date | null;
};

/** Purpose: prove whether one persisted player/clan interval belongs to the exact CWL window. */
function intervalProvesBoundary(
  interval: any,
  boundaryTime: Date,
  window: PersistedCwlWindow,
  eventLastObservedAt: Date | null,
): boolean {
  const firstObservedAt = interval?.firstObservedAt instanceof Date ? interval.firstObservedAt : null;
  const endedAt = interval?.endedAt instanceof Date ? interval.endedAt : null;
  if (!firstObservedAt || firstObservedAt.getTime() > boundaryTime.getTime()) return false;
  if (endedAt && boundaryTime.getTime() >= endedAt.getTime()) return false;
  if (!window.startTimingResolved || !window.startsAt) return false;
  if (window.endsAt && boundaryTime.getTime() > window.endsAt.getTime()) return false;
  if (boundaryTime.getTime() < window.startsAt.getTime()) {
    return !endedAt || window.startsAt.getTime() < endedAt.getTime();
  }
  if (!window.endsAt) {
    if (!eventLastObservedAt || boundaryTime.getTime() > eventLastObservedAt.getTime()) return false;
  }
  return true;
}

/** Purpose: read player-aware, persisted CWL excursion proof in bounded bulk queries. */
export class CwlContinuityEvidenceService {
  constructor(
    private readonly db: ContinuityDb = continuityDb,
    private readonly windowReader: CwlWindowReader = cwlAllianceActivityService,
  ) {}

  /** Purpose: return only exact player/boundary pairs proven to be CWL-neutral. */
  async getEvidence(input: CwlContinuityEvidenceInput): Promise<CwlContinuityEvidenceResult> {
    const guildId = String(input.guildId ?? "").trim();
    const playerTags = [...new Set(input.playerTags.map(normalizePlayerTag).filter(Boolean))];
    const boundaryTimes = input.boundaryTimes.filter((value) => value instanceof Date && Number.isFinite(value.getTime()));
    if (!guildId || playerTags.length === 0 || boundaryTimes.length === 0) return emptyCwlContinuityEvidence();

    const minBoundaryTime = new Date(Math.min(...boundaryTimes.map((value) => value.getTime())));
    const maxBoundaryTime = new Date(Math.max(...boundaryTimes.map((value) => value.getTime())));
    const playerSeasonRows = await this.db.cwlPlayerClanSeason.findMany({
      where: {
        playerTag: { in: playerTags },
        eventInstance: {
          firstObservedAt: { lte: maxBoundaryTime },
          lastObservedAt: { gte: minBoundaryTime },
        },
      },
      select: {
        eventInstanceId: true,
        season: true,
        playerTag: true,
        cwlClanTag: true,
        eventInstance: { select: { firstObservedAt: true, lastObservedAt: true } },
      },
    });
    const rosterCandidates = playerSeasonRows
      .map((row): RosterCandidate | null => {
        const playerTag = normalizePlayerTag(row?.playerTag);
        const clanTag = normalizeClanTag(row?.cwlClanTag);
        const season = String(row?.season ?? "").trim();
        const eventInstanceId = String(row?.eventInstanceId ?? "").trim();
        const eventLastObservedAt = row?.eventInstance?.lastObservedAt instanceof Date
          ? row.eventInstance.lastObservedAt
          : null;
        return playerTag && clanTag && season && eventInstanceId
          ? { eventInstanceId, season, playerTag, clanTag, eventLastObservedAt }
          : null;
      })
      .filter((row): row is RosterCandidate => row !== null);
    if (rosterCandidates.length === 0) return emptyCwlContinuityEvidence();

    const seasons = [...new Set(rosterCandidates.map((row) => row.season))];
    const clanTags = [...new Set(rosterCandidates.map((row) => row.clanTag))];
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
    const trackedKeys = new Set(trackedRows.map((row) => `${String(row?.season ?? "").trim()}|${normalizeClanTag(row?.tag)}`));
    const intervalsByPlayerAndClan = new Map<string, any[]>();
    for (const row of intervalRows) {
      const key = `${normalizePlayerTag(row?.playerTag)}|${normalizeClanTag(row?.clanTag)}`;
      const rows = intervalsByPlayerAndClan.get(key) ?? [];
      rows.push(row);
      intervalsByPlayerAndClan.set(key, rows);
    }

    const seasonsToRead = new Set<string>(seasons);
    const windows = new Map<string, PersistedCwlWindow | null>();
    await Promise.all([...seasonsToRead].map(async (season) => {
      try {
        windows.set(season, await this.windowReader.getCwlWindow({ season }));
      } catch {
        windows.set(season, null);
      }
    }));

    const exemptPairs = new Set<string>();
    const players = new Set<string>();
    let candidatesRejected = 0;
    let ambiguousCandidates = 0;
    for (const playerTag of playerTags) {
      for (const boundaryTime of boundaryTimes) {
        const candidates = rosterCandidates.filter((candidate) => {
          if (candidate.playerTag !== playerTag || !trackedKeys.has(`${candidate.season}|${candidate.clanTag}`)) return false;
          const intervals = intervalsByPlayerAndClan.get(`${playerTag}|${candidate.clanTag}`) ?? [];
          const window = windows.get(candidate.season);
          return Boolean(window && intervals.some((interval) => intervalProvesBoundary(
            interval,
            boundaryTime,
            window,
            candidate.eventLastObservedAt,
          )));
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
        const candidate = uniqueCandidates[0];
        const window = windows.get(candidate.season);
        if (!window || !window.hasTrackedCwlClans || window.resolvedEventCount <= 0 || window.unresolvedCwlClans.length > 0) {
          candidatesRejected += 1;
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
