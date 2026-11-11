import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";

export type NonFwaMembershipEvidenceStatus = "RESOLVED" | "AMBIGUOUS" | "ABSENT" | "UNKNOWN";

export type NonFwaPhysicalEvidence = {
  status: NonFwaMembershipEvidenceStatus;
  clanTag: string | null;
  clanTags: string[];
  conflicting: boolean;
};

export type NonFwaAllianceEvidence = {
  status: NonFwaMembershipEvidenceStatus;
  positive: boolean;
  clanTags: string[];
  ambiguous: boolean;
  conflicting: boolean;
};

export type NonFwaBoundaryEvidence = {
  observed: boolean;
  physical: NonFwaPhysicalEvidence;
  alliance: NonFwaAllianceEvidence;
};

export type NonFwaMembershipEvidenceResult = {
  byBoundary: Map<string, NonFwaBoundaryEvidence>;
  acceptedProofs: number;
  rejectedProofs: number;
  conflictingProofs: number;
};

export type NonFwaMembershipEvidenceInput = {
  guildId: string;
  playerTags: string[];
  boundaries: readonly { syncNumber: number; syncTime: Date }[];
};

type NonFwaMembershipDb = {
  trackedClan: { findMany: (args?: any) => Promise<any[]> };
  clanWarHistory: { findMany: (args?: any) => Promise<any[]> };
  clanWarParticipation: {
    findMany: (args?: any) => Promise<any[]>;
    groupBy: (args?: any) => Promise<any[]>;
  };
};

const defaultDb = prisma as unknown as NonFwaMembershipDb;

type CanonicalHistory = {
  warId: number;
  syncNumber: number;
  syncTime: Date;
  clanTag: string;
  opponentTag: string | null;
  warStartTime: Date;
  matchType: "BL" | "MM";
};

type RosterGroup = {
  warId: string;
  clanTag: string;
  opponentTag: string | null;
  matchType: string | null;
  warStartTime: Date | null;
  count: number;
};

function normalizePlayerTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

function normalizeClanTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

function normalizedComparable(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function boundaryKey(syncTime: Date): string {
  return String(syncTime.getTime());
}

function sameOptionalTag(left: unknown, right: unknown): boolean {
  const leftTag = left == null ? null : normalizeClanTag(left);
  const rightTag = right == null ? null : normalizeClanTag(right);
  return leftTag === rightTag;
}

function historyMatchesGroup(history: CanonicalHistory, group: RosterGroup): boolean {
  return String(history.warId) === String(group.warId) &&
    history.clanTag === normalizeClanTag(group.clanTag) &&
    history.matchType === normalizedComparable(group.matchType) &&
    history.warStartTime.getTime() === (group.warStartTime?.getTime() ?? NaN) &&
    sameOptionalTag(history.opponentTag, group.opponentTag);
}

function emptyResult(): NonFwaMembershipEvidenceResult {
  return {
    byBoundary: new Map(),
    acceptedProofs: 0,
    rejectedProofs: 0,
    conflictingProofs: 0,
  };
}

/** Purpose: read bounded, canonical BL/MM roster proof without changing FWA ownership. */
export class NonFwaMembershipEvidenceService {
  constructor(private readonly db: NonFwaMembershipDb = defaultDb) {}

  /** Purpose: resolve exact guild-owned BL/MM roster observations for one canonical sync window. */
  async getEvidence(input: NonFwaMembershipEvidenceInput): Promise<NonFwaMembershipEvidenceResult> {
    const guildId = String(input.guildId ?? "").trim();
    const playerTags = [...new Set(input.playerTags.map(normalizePlayerTag).filter(Boolean))];
    const boundaries = input.boundaries.filter((boundary) =>
      Number.isInteger(boundary.syncNumber) && boundary.syncNumber > 0 && validDate(boundary.syncTime));
    if (!guildId || playerTags.length === 0 || boundaries.length === 0) return emptyResult();

    const syncNumbers = [...new Set(boundaries.map((boundary) => boundary.syncNumber))];
    const syncTimeByNumber = new Map(boundaries.map((boundary) => [boundary.syncNumber, boundary.syncTime]));
    const historyRows = await this.db.clanWarHistory.findMany({
      where: { syncNumber: { in: syncNumbers } },
      orderBy: [{ syncNumber: "desc" }, { clanTag: "asc" }, { warId: "asc" }],
      select: {
        warId: true,
        syncNumber: true,
        matchType: true,
        clanTag: true,
        warStartTime: true,
        opponentTag: true,
      },
    });
    const trackedRows = await this.db.trackedClan.findMany({
      where: {
        tag: {
          in: uniqueSorted(historyRows.map((row) => normalizeClanTag(row?.clanTag)).filter(Boolean)),
        },
      },
      select: { tag: true },
    });
    const trackedClanTags = new Set(
      trackedRows.map((row) => normalizeClanTag(row?.tag)).filter(Boolean),
    );
    const unknownTypeHistories = historyRows.filter((row) => {
      const matchType = normalizedComparable(row?.matchType);
      return matchType !== "FWA" && matchType !== "BL" && matchType !== "MM" && matchType !== "SKIP";
    });
    const histories: CanonicalHistory[] = historyRows
      .map((row): CanonicalHistory | null => {
        const warId = positiveInteger(row?.warId);
        const syncNumber = positiveInteger(row?.syncNumber);
        const clanTag = normalizeClanTag(row?.clanTag);
        const matchType = normalizedComparable(row?.matchType);
        if (!warId || !syncNumber || !syncTimeByNumber.has(syncNumber) ||
          (matchType !== "BL" && matchType !== "MM") || !clanTag ||
          !validDate(row?.warStartTime)) return null;
        return {
          warId,
          syncNumber,
          syncTime: syncTimeByNumber.get(syncNumber)!,
          clanTag,
          opponentTag: row?.opponentTag == null ? null : normalizeClanTag(row.opponentTag),
          warStartTime: row.warStartTime,
          matchType: matchType as "BL" | "MM",
        };
      })
      .filter((row): row is CanonicalHistory => row !== null);
    const candidateHistoryRows = historyRows.filter((row) => {
      const matchType = normalizedComparable(row?.matchType);
      return matchType === "BL" || matchType === "MM" ||
        (matchType !== "FWA" && matchType !== "SKIP");
    });

    const result = emptyResult();
    for (const boundary of boundaries) {
      result.byBoundary.set(boundaryKey(boundary.syncTime), {
        observed: false,
        physical: { status: "ABSENT", clanTag: null, clanTags: [], conflicting: false },
        alliance: { status: "ABSENT", positive: false, clanTags: [], ambiguous: false, conflicting: false },
      });
    }
    const warIds = [...new Set(candidateHistoryRows
      .map((row) => positiveInteger(row?.warId))
      .filter((warId): warId is number => warId !== null)
      .map(String))];
    if (warIds.length === 0) return result;
    const [playerRows, groupedRows] = await Promise.all([
      this.db.clanWarParticipation.findMany({
        where: { guildId, warId: { in: warIds }, playerTag: { in: playerTags } },
        orderBy: [{ warId: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
        select: {
          warId: true,
          clanTag: true,
          opponentTag: true,
          matchType: true,
          warStartTime: true,
          playerTag: true,
        },
      }),
      this.db.clanWarParticipation.groupBy({
        by: ["warId", "clanTag", "opponentTag", "matchType", "warStartTime"],
        where: { guildId, warId: { in: warIds } },
        _count: { playerTag: true },
      }),
    ]);
    const groupsByWarId = new Map<string, RosterGroup[]>();
    for (const row of groupedRows) {
      const warId = String(row?.warId ?? "").trim();
      const clanTag = normalizeClanTag(row?.clanTag);
      const count = Number(row?._count?.playerTag);
      if (!warId || !clanTag || !Number.isInteger(count) || count <= 0) continue;
      const groups = groupsByWarId.get(warId) ?? [];
      groups.push({
        warId,
        clanTag,
        opponentTag: row?.opponentTag == null ? null : normalizeClanTag(row.opponentTag),
        matchType: row?.matchType == null ? null : normalizedComparable(row.matchType),
        warStartTime: validDate(row?.warStartTime) ? row.warStartTime : null,
        count,
      });
      groupsByWarId.set(warId, groups);
    }

    const playerTagsByWarId = new Map<string, Set<string>>();
    for (const row of playerRows) {
      const warId = positiveInteger(row?.warId);
      const playerTag = normalizePlayerTag(row?.playerTag);
      if (warId === null || !playerTags.includes(playerTag)) continue;
      const tags = playerTagsByWarId.get(String(warId)) ?? new Set<string>();
      tags.add(playerTag);
      playerTagsByWarId.set(String(warId), tags);
    }

    const acceptedHistories: CanonicalHistory[] = [];
    const rejectedByPlayerBoundary = new Set<string>();
    const unknownByPlayerBoundary = new Set<string>();
    const conflictingByPlayerBoundary = new Set<string>();
    for (const history of histories) {
      const key = boundaryKey(history.syncTime);
      const groups = groupsByWarId.get(String(history.warId)) ?? [];
      const exactGroups = groups.filter((group) => historyMatchesGroup(history, group));
      if (groups.length === 1 && exactGroups.length === 1) {
        acceptedHistories.push(history);
        continue;
      }
      const relevantPlayers = playerTagsByWarId.get(String(history.warId));
      if (!relevantPlayers || relevantPlayers.size === 0) continue;
      result.rejectedProofs += 1;
      for (const playerTag of relevantPlayers) rejectedByPlayerBoundary.add(`${key}|${playerTag}`);
      if (groups.length > 1 || exactGroups.length > 1) {
        result.conflictingProofs += 1;
        for (const playerTag of relevantPlayers) conflictingByPlayerBoundary.add(`${key}|${playerTag}`);
      }
    }
    for (const row of unknownTypeHistories) {
      const syncNumber = positiveInteger(row?.syncNumber);
      const warId = positiveInteger(row?.warId);
      const syncTime = syncNumber === null ? null : syncTimeByNumber.get(syncNumber);
      const relevantPlayers = warId === null ? undefined : playerTagsByWarId.get(String(warId));
      if (!syncTime || !relevantPlayers || relevantPlayers.size === 0) continue;
      result.rejectedProofs += 1;
      for (const playerTag of relevantPlayers) unknownByPlayerBoundary.add(`${boundaryKey(syncTime)}|${playerTag}`);
    }

    const acceptedByBoundary = new Map<string, CanonicalHistory[]>();
    for (const history of acceptedHistories) {
      const key = boundaryKey(history.syncTime);
      const rows = acceptedByBoundary.get(key) ?? [];
      rows.push(history);
      acceptedByBoundary.set(key, rows);
      result.acceptedProofs += 1;
    }
    const playerRowsByAcceptedHistory = new Map<string, Set<string>>();
    for (const row of playerRows) {
      const playerTag = normalizePlayerTag(row?.playerTag);
      if (!playerTags.includes(playerTag)) continue;
      const candidates = acceptedHistories.filter((history) =>
        String(history.warId) === String(row?.warId) &&
        history.clanTag === normalizeClanTag(row?.clanTag) &&
        history.matchType === normalizedComparable(row?.matchType) &&
        history.warStartTime.getTime() === (validDate(row?.warStartTime) ? row.warStartTime.getTime() : NaN) &&
        sameOptionalTag(history.opponentTag, row?.opponentTag));
      for (const history of candidates) {
        const historyKey = `${history.warId}|${boundaryKey(history.syncTime)}`;
        const players = playerRowsByAcceptedHistory.get(historyKey) ?? new Set<string>();
        players.add(playerTag);
        playerRowsByAcceptedHistory.set(historyKey, players);
      }
    }
    for (const [key, rows] of acceptedByBoundary) {
      const byClan = new Map<string, number>();
      for (const history of rows) byClan.set(history.clanTag, (byClan.get(history.clanTag) ?? 0) + 1);
      for (const [clanTag, count] of byClan) {
        if (count > 1) {
          result.acceptedProofs = Math.max(0, result.acceptedProofs - count);
          result.conflictingProofs += 1;
          for (const history of rows.filter((row) => row.clanTag === clanTag)) {
            const players = playerRowsByAcceptedHistory.get(`${history.warId}|${key}`) ?? [];
            for (const playerTag of players) {
              const playerKey = `${key}|${playerTag}`;
              rejectedByPlayerBoundary.add(playerKey);
              conflictingByPlayerBoundary.add(playerKey);
            }
          }
        }
      }
    }
    const positiveByBoundaryAndPlayer = new Map<string, Set<string>>();
    for (const history of acceptedHistories) {
      const key = boundaryKey(history.syncTime);
      const players = playerRowsByAcceptedHistory.get(`${history.warId}|${key}`) ?? [];
      for (const playerTag of players) {
        const playerKey = `${playerTag}|${key}`;
        const clans = positiveByBoundaryAndPlayer.get(playerKey) ?? new Set<string>();
        clans.add(history.clanTag);
        positiveByBoundaryAndPlayer.set(playerKey, clans);
      }
    }

    for (const boundary of boundaries) {
      const key = boundaryKey(boundary.syncTime);
      const candidates = acceptedByBoundary.get(key) ?? [];
      for (const playerTag of playerTags) {
        const playerKey = `${key}|${playerTag}`;
        const coverageUnknown = rejectedByPlayerBoundary.has(playerKey) || unknownByPlayerBoundary.has(playerKey);
        const clanTags = positiveByBoundaryAndPlayer.get(`${playerTag}|${key}`) ?? new Set<string>();
        const physicalTags = uniqueSorted(clanTags);
        if (physicalTags.length > 1) {
          result.conflictingProofs += 1;
          conflictingByPlayerBoundary.add(playerKey);
        }
        const physicalConflicting = conflictingByPlayerBoundary.has(playerKey);
        const physical: NonFwaPhysicalEvidence = coverageUnknown
          ? { status: "UNKNOWN", clanTag: null, clanTags: [], conflicting: physicalConflicting }
          : physicalTags.length === 1
            ? { status: "RESOLVED", clanTag: physicalTags[0], clanTags: physicalTags, conflicting: physicalConflicting }
            : physicalTags.length > 1
              ? { status: "AMBIGUOUS", clanTag: null, clanTags: physicalTags, conflicting: true }
              : candidates.length > 0
                ? { status: "ABSENT", clanTag: null, clanTags: [], conflicting: physicalConflicting }
                : { status: "ABSENT", clanTag: null, clanTags: [], conflicting: physicalConflicting };
        const allianceTags = physicalTags.filter((clanTag) => trackedClanTags.has(clanTag));
        const alliance: NonFwaAllianceEvidence = coverageUnknown
          ? { status: "UNKNOWN", positive: false, clanTags: [], ambiguous: false, conflicting: physicalConflicting }
          : allianceTags.length === 1
            ? { status: "RESOLVED", positive: true, clanTags: allianceTags, ambiguous: false, conflicting: physicalConflicting }
            : allianceTags.length > 1
              ? { status: "AMBIGUOUS", positive: false, clanTags: allianceTags, ambiguous: true, conflicting: true }
              : { status: "ABSENT", positive: false, clanTags: [], ambiguous: false, conflicting: physicalConflicting };
        result.byBoundary.set(`${key}|${playerTag}`, {
          observed: candidates.length > 0 || coverageUnknown,
          physical,
          alliance,
        });
      }
    }
    return result;
  }
}

export const nonFwaMembershipEvidenceService = new NonFwaMembershipEvidenceService();
