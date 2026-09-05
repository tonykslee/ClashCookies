import { normalizeClashTagWithHash } from "../helper/clashTag";
import {
  clanHomeMembershipService,
  type ActiveHomeMembership,
  type ClanHomeMembershipService,
} from "./ClanHomeMembershipService";
import {
  membershipStreakService,
  type MembershipBoundaryEvidence,
  type MembershipBoundaryIdentity,
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
  boundaryIdentities: readonly MembershipBoundaryIdentity[];
  evidenceRows: MembershipBoundaryEvidence[];
  boundaryHistoryTruncated: boolean;
}): { syncs: number | null; isLowerBound: boolean } {
  if (input.boundaryTimes.length === 0) return { syncs: null, isLowerBound: false };

  const evidenceByBoundaryTime = new Map(
    input.evidenceRows.map((row) => [row.boundaryTime.getTime(), row]),
  );
  const homeClanTag = normalizeClanTag(input.home.clanTag);
  const syncs = input.boundaryTimes.filter((boundaryTime) => {
    const evidence = evidenceByBoundaryTime.get(boundaryTime.getTime());
    return evidence?.fwa.status === "RESOLVED" && evidence.fwa.clanTag === homeClanTag;
  }).length;
  const evidenceCoverageUncertain = input.boundaryTimes.some((boundaryTime) => {
    const status = evidenceByBoundaryTime.get(boundaryTime.getTime())?.fwa.status;
    return status === undefined || status === "UNKNOWN" || status === "AMBIGUOUS";
  });
  const identityByBoundaryTime = new Map(
    input.boundaryIdentities.map((identity) => [identity.boundaryTime.getTime(), identity.syncNumber]),
  );
  const canonicalContinuityUncertain = input.boundaryIdentities.length > 0 && input.boundaryTimes.some((boundaryTime, index) => {
    const syncNumber = identityByBoundaryTime.get(boundaryTime.getTime());
    if (syncNumber === undefined || syncNumber === null) return true;
    if (index === 0) return false;
    const newerSyncNumber = identityByBoundaryTime.get(input.boundaryTimes[index - 1].getTime());
    return newerSyncNumber === undefined || newerSyncNumber === null || newerSyncNumber - syncNumber !== 1;
  });
  return {
    syncs,
    isLowerBound: input.boundaryHistoryTruncated || evidenceCoverageUncertain || canonicalContinuityUncertain,
  };
}

/** Purpose: expose the authoritative physical-clan streak without applying Home-specific interpretation. */
function resolvePhysicalClanStreak(
  streak: MembershipStreakResult,
): { syncs: number | null; isLowerBound: boolean } {
  if (streak.latestCwlContinuityExempt && streak.clanStreakSyncs > 0) {
    return {
      syncs: streak.clanStreakSyncs,
      isLowerBound: streak.clanStreakIsLowerBound,
    };
  }
  if (streak.latestFwaEvidenceStatus === "RESOLVED") {
    return {
      syncs: streak.clanStreakSyncs,
      isLowerBound: streak.clanStreakIsLowerBound,
    };
  }
  if (streak.latestFwaEvidenceStatus === "ABSENT") {
    return { syncs: 0, isLowerBound: false };
  }
  if (streak.latestEvidencePending && streak.latestPendingClanValueAvailable) {
    return { syncs: streak.clanStreakSyncs, isLowerBound: streak.clanStreakIsLowerBound };
  }
  return { syncs: null, isLowerBound: false };
}

/** Purpose: retain existing alliance-streak values while hiding genuinely unknown latest coverage. */
function resolveAllianceStreak(
  streak: MembershipStreakResult,
): { syncs: number | null; isLowerBound: boolean } {
  if (streak.latestCwlContinuityExempt && streak.allianceStreakSyncs > 0) {
    return {
      syncs: streak.allianceStreakSyncs,
      isLowerBound: streak.allianceStreakIsLowerBound,
    };
  }
  if (!streak.latestBoundaryTime ||
      (!streak.latestEvidenceAvailable &&
        (!streak.latestEvidencePending || !streak.latestPendingAllianceValueAvailable))) {
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
        boundaryIdentities: streakBatch.boundaryIdentities,
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
