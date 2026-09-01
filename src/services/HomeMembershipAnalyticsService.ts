import { normalizeClashTagWithHash } from "../helper/clashTag";
import {
  clanHomeMembershipService,
  type ActiveHomeMembership,
  type ClanHomeMembershipService,
} from "./ClanHomeMembershipService";
import {
  membershipStreakService,
  type MembershipBoundaryEvidence,
  type MembershipStreakResult,
  type MembershipStreakService,
} from "./MembershipStreakService";

const DEFAULT_ANALYTICS_MAX_BOUNDARIES = 500;

export type HomeMembershipAnalyticsInput = {
  guildId: string;
  playerTags: string[];
};

export type HomeMembershipAnalyticsResult = {
  playerTag: string;
  homeMembershipPeriodId: string | null;
  homeClanTag: string | null;
  clanTenureSyncs: number | null;
  clanTenureIsLowerBound: boolean;
  clanStreakSyncs: number | null;
  clanStreakIsLowerBound: boolean;
  allianceStreakSyncs: number | null;
  allianceStreakIsLowerBound: boolean;
};

type HomeMembershipReader = Pick<ClanHomeMembershipService, "getActiveHomeMembershipsForPlayers">;
type MembershipStreakReader = Pick<MembershipStreakService, "getMembershipStreakBatchForPlayers">;

/** Purpose: normalize a player tag into the canonical hash-prefixed form. */
function normalizePlayerTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize a clan tag into the canonical hash-prefixed form. */
function normalizeClanTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize and deterministically order the requested player batch. */
function normalizePlayerTags(values: unknown): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizePlayerTag)
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

/** Purpose: count resolved canonical FWA-roster observations credited to one active Home period. */
function resolveClanTenure(input: {
  home: ActiveHomeMembership;
  boundaryTimes: Date[];
  evidenceRows: MembershipBoundaryEvidence[];
  boundaryHistoryTruncated: boolean;
}): { syncs: number | null; isLowerBound: boolean } {
  const startedAt = input.home.startedAtSyncTime;
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
    return { syncs: null, isLowerBound: false };
  }

  const coveredBoundaries = input.boundaryTimes.filter((boundaryTime) => boundaryTime.getTime() >= startedAt.getTime());
  if (coveredBoundaries.length === 0) return { syncs: null, isLowerBound: false };

  const oldestLoadedBoundary = input.boundaryTimes[input.boundaryTimes.length - 1];
  if (!oldestLoadedBoundary) return { syncs: null, isLowerBound: false };
  if (oldestLoadedBoundary.getTime() > startedAt.getTime() && !input.boundaryHistoryTruncated) {
    return { syncs: null, isLowerBound: false };
  }
  const syncs = input.evidenceRows.filter((row) =>
    row.boundaryTime.getTime() >= startedAt.getTime() &&
    row.fwa.status === "RESOLVED" &&
    row.fwa.clanTag === normalizeClanTag(input.home.clanTag),
  ).length;
  return { syncs, isLowerBound: input.boundaryHistoryTruncated };
}

/** Purpose: expose the authoritative physical-clan streak without applying Home-specific interpretation. */
function resolvePhysicalClanStreak(
  streak: MembershipStreakResult,
): { syncs: number | null; isLowerBound: boolean } {
  if (streak.latestFwaEvidenceStatus === "RESOLVED") {
    return {
      syncs: streak.clanStreakSyncs,
      isLowerBound: streak.clanStreakIsLowerBound,
    };
  }
  if (streak.latestFwaEvidenceStatus === "ABSENT") {
    return { syncs: 0, isLowerBound: false };
  }
  if (streak.latestEvidencePending) {
    return { syncs: streak.clanStreakSyncs, isLowerBound: streak.clanStreakIsLowerBound };
  }
  return { syncs: null, isLowerBound: false };
}

/** Purpose: retain existing alliance-streak values while hiding genuinely unknown latest coverage. */
function resolveAllianceStreak(
  streak: MembershipStreakResult,
): { syncs: number | null; isLowerBound: boolean } {
  if (!streak.latestBoundaryTime || (!streak.latestEvidenceAvailable && !streak.latestEvidencePending)) {
    return { syncs: null, isLowerBound: false };
  }
  return {
    syncs: streak.allianceStreakSyncs,
    isLowerBound: streak.allianceStreakIsLowerBound,
  };
}

/** Purpose: bulk-combine active Home periods, canonical boundaries, and persisted streak evidence. */
export class HomeMembershipAnalyticsService {
  constructor(
    private readonly homeMembershipReader: HomeMembershipReader = clanHomeMembershipService,
    private readonly membershipStreakReader: MembershipStreakReader = membershipStreakService,
  ) {}

  /** Purpose: return one deterministic Home analytics result per requested player tag without N+1 reads. */
  async getAnalyticsForPlayers(
    input: HomeMembershipAnalyticsInput,
  ): Promise<HomeMembershipAnalyticsResult[]> {
    const guildId = String(input.guildId ?? "").trim();
    const playerTags = normalizePlayerTags(input.playerTags);
    if (!guildId || playerTags.length === 0) return [];

    const [homes, streakBatch] = await Promise.all([
      this.homeMembershipReader.getActiveHomeMembershipsForPlayers({ guildId, playerTags }),
      this.membershipStreakReader.getMembershipStreakBatchForPlayers({
        guildId,
        playerTags,
        maxBoundaries: DEFAULT_ANALYTICS_MAX_BOUNDARIES,
      }),
    ]);
    const homeByPlayerTag = new Map(
      homes
        .filter((home) => home.guildId === guildId)
        .map((home) => [normalizePlayerTag(home.playerTag), home]),
    );
    const streakByPlayerTag = new Map(streakBatch.streaks.map((streak) => [streak.playerTag, streak]));

    const results = playerTags.map((playerTag) => {
      const home = homeByPlayerTag.get(playerTag);
      const streak = streakByPlayerTag.get(playerTag);
      if (!streak) {
        return {
          playerTag,
          homeMembershipPeriodId: null,
          homeClanTag: null,
          clanTenureSyncs: null,
          clanTenureIsLowerBound: false,
          clanStreakSyncs: null,
          clanStreakIsLowerBound: false,
          allianceStreakSyncs: null,
          allianceStreakIsLowerBound: false,
        };
      }

      const clanStreak = resolvePhysicalClanStreak(streak);
      const allianceStreak = resolveAllianceStreak(streak);
      if (!home) {
        return {
          playerTag,
          homeMembershipPeriodId: null,
          homeClanTag: null,
          clanTenureSyncs: null,
          clanTenureIsLowerBound: false,
          clanStreakSyncs: clanStreak.syncs,
          clanStreakIsLowerBound: clanStreak.isLowerBound,
          allianceStreakSyncs: allianceStreak.syncs,
          allianceStreakIsLowerBound: allianceStreak.isLowerBound,
        };
      }

      const tenure = resolveClanTenure({
        home,
        boundaryTimes: streakBatch.boundaryTimes,
        evidenceRows: streakBatch.evidenceByPlayer[playerTag] ?? [],
        boundaryHistoryTruncated: streakBatch.boundaryHistoryTruncated,
      });
      return {
        playerTag,
        homeMembershipPeriodId: home.id,
        homeClanTag: normalizeClanTag(home.clanTag) || null,
        clanTenureSyncs: tenure.syncs,
        clanTenureIsLowerBound: tenure.isLowerBound,
        clanStreakSyncs: clanStreak.syncs,
        clanStreakIsLowerBound: clanStreak.isLowerBound,
        allianceStreakSyncs: allianceStreak.syncs,
        allianceStreakIsLowerBound: allianceStreak.isLowerBound,
      };
    });

    const lowerBoundCount = results.filter((result) =>
      result.clanTenureIsLowerBound || result.clanStreakIsLowerBound || result.allianceStreakIsLowerBound,
    ).length;
    console.debug(
      `[home-membership-analytics] guild_id=${guildId || "unknown"} players=${playerTags.length} homes=${homeByPlayerTag.size} boundaries=${streakBatch.boundaryTimes.length} lower_bound=${lowerBoundCount}`,
    );
    return results;
  }
}

export const homeMembershipAnalyticsService = new HomeMembershipAnalyticsService();
