import { describe, expect, it, vi } from "vitest";
import {
  HomeMembershipAnalyticsService,
  type HomeMembershipAnalyticsResult,
} from "../src/services/HomeMembershipAnalyticsService";
import type { ActiveHomeMembership } from "../src/services/ClanHomeMembershipService";

const guildId = "guild-1";
const playerTag = "#P2222";
const homeClanTag = "#RRRR";
const otherClanTag = "#GJJJ";

function time(day: number): Date {
  return new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

function home(clanTag = homeClanTag, startedAtSyncTime = time(1)): ActiveHomeMembership {
  return {
    id: "home-1",
    guildId,
    playerTag,
    clanTag,
    startedAtSyncTime,
    qualifiedAtSyncTime: startedAtSyncTime,
    endedAtSyncTime: null,
    establishmentSource: "AUTO_3_SYNC",
    endReason: null,
  };
}

function evidence(day: number, status: "RESOLVED" | "ABSENT" | "UNKNOWN" | "AMBIGUOUS", clanTag: string | null = null) {
  const positive = status === "RESOLVED";
  return {
    playerTag,
    boundaryTime: time(day),
    fwa: {
      status,
      clanTag: positive ? clanTag : null,
      clanTags: (positive || status === "AMBIGUOUS") && clanTag ? [clanTag] : [],
      source: positive ? "FWA_WAR_PARTICIPATION" as const : null,
    },
    alliance: {
      positive,
      clanTags: positive && clanTag ? [clanTag] : [],
      ambiguous: false,
      sources: positive ? ["FWA_EVIDENCE" as const] : [],
    },
  };
}

function streak(overrides: Partial<{
  playerTag: string;
  latestBoundaryTime: Date | null;
  latestFwaEvidenceStatus: "RESOLVED" | "AMBIGUOUS" | "ABSENT" | "UNKNOWN";
  latestFwaClanTag: string | null;
  clanStreakSyncs: number;
  clanStreakIsLowerBound: boolean;
  allianceStreakSyncs: number;
  allianceStreakIsLowerBound: boolean;
  latestEvidenceAvailable: boolean;
  latestEvidencePending: boolean;
  latestPendingClanValueAvailable: boolean;
  latestPendingAllianceValueAvailable: boolean;
  latestCwlContinuityExempt: boolean;
}> = {}) {
  return {
    playerTag: overrides.playerTag ?? playerTag,
    latestBoundaryTime: overrides.latestBoundaryTime === undefined ? time(3) : overrides.latestBoundaryTime,
    latestFwaEvidenceStatus: overrides.latestFwaEvidenceStatus ?? "RESOLVED",
    latestFwaClanTag: overrides.latestFwaClanTag === undefined ? homeClanTag : overrides.latestFwaClanTag,
    clanStreakSyncs: overrides.clanStreakSyncs ?? 3,
    clanStreakIsLowerBound: overrides.clanStreakIsLowerBound ?? false,
    allianceStreakSyncs: overrides.allianceStreakSyncs ?? 3,
    allianceStreakIsLowerBound: overrides.allianceStreakIsLowerBound ?? false,
    latestEvidenceAvailable: overrides.latestEvidenceAvailable ?? true,
    latestEvidencePending: overrides.latestEvidencePending ?? false,
    latestPendingClanValueAvailable: overrides.latestPendingClanValueAvailable ?? false,
    latestPendingAllianceValueAvailable: overrides.latestPendingAllianceValueAvailable ?? false,
    latestCwlContinuityExempt: overrides.latestCwlContinuityExempt ?? false,
  };
}

function serviceFor(input: {
  homes?: ActiveHomeMembership[];
  streaks?: ReturnType<typeof streak>[];
  boundaryTimes?: Date[];
  boundaryIdentities?: Array<{ boundaryTime: Date; syncNumber: number | null }>;
  boundaryHistoryTruncated?: boolean;
  evidenceByPlayer?: Record<string, any[]>;
}) {
  const homeReader = {
    getActiveHomeMembershipsForPlayers: vi.fn(async () => input.homes ?? []),
  };
  const streakReader = {
    getMembershipStreakBatchForPlayers: vi.fn(async () => ({
      streaks: input.streaks ?? [],
      boundaryTimes: input.boundaryTimes ?? [],
      boundaryIdentities: input.boundaryIdentities ?? [],
      boundaryHistoryTruncated: input.boundaryHistoryTruncated ?? false,
      evidenceByPlayer: input.evidenceByPlayer ?? {},
    })),
  };
  return { service: new HomeMembershipAnalyticsService(homeReader, streakReader), homeReader, streakReader };
}

function byTag(results: HomeMembershipAnalyticsResult[]): HomeMembershipAnalyticsResult {
  return results.find((result) => result.playerTag === playerTag)!;
}

describe("HomeMembershipAnalyticsService", () => {
  it("keeps prior S/A values visible for a latest CWL-neutral UNKNOWN boundary", async () => {
    const built = serviceFor({
      homes: [home()],
      streaks: [streak({ latestFwaEvidenceStatus: "UNKNOWN", latestFwaClanTag: null, latestEvidenceAvailable: false, latestEvidencePending: false, latestCwlContinuityExempt: true, clanStreakSyncs: 2, allianceStreakSyncs: 2 })],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "UNKNOWN"), evidence(2, "RESOLVED", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2 });
  });

  it("keeps prior S/A values visible for a latest CWL-neutral ABSENT boundary", async () => {
    const built = serviceFor({
      homes: [home()],
      streaks: [streak({ latestFwaEvidenceStatus: "ABSENT", latestFwaClanTag: null, latestEvidenceAvailable: true, latestEvidencePending: false, latestCwlContinuityExempt: true, clanStreakSyncs: 2, allianceStreakSyncs: 2 })],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "ABSENT"), evidence(2, "RESOLVED", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2 });
  });

  it("counts only resolved FWA-roster observations matching the active Home clan", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "RESOLVED", homeClanTag), evidence(2, "RESOLVED", otherClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanTenureIsLowerBound: false });
  });

  it("counts canonical Home observations before a late Home establishment", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(3))],
      streaks: [streak()],
      boundaryTimes: [time(7), time(6), time(5), time(4), time(3)],
      evidenceByPlayer: {
        [playerTag]: [
          evidence(7, "RESOLVED", homeClanTag),
          evidence(6, "RESOLVED", homeClanTag),
          evidence(5, "RESOLVED", homeClanTag),
          evidence(4, "RESOLVED", homeClanTag),
          evidence(3, "RESOLVED", homeClanTag),
        ],
      },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 5, clanTenureIsLowerBound: false });
  });

  it("does not erase prior C when the player moves to another clan", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak({ latestFwaClanTag: otherClanTag, clanStreakSyncs: 1, allianceStreakSyncs: 1 })],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "RESOLVED", otherClanTag), evidence(2, "RESOLVED", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanStreakSyncs: 1, allianceStreakSyncs: 1 });
  });

  it("keeps displayed C/S/A values pending until the newest sync is observable", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak({ latestFwaEvidenceStatus: "UNKNOWN", latestFwaClanTag: null, latestEvidenceAvailable: false, latestEvidencePending: true, latestPendingClanValueAvailable: true, latestPendingAllianceValueAvailable: true, clanStreakSyncs: 2, allianceStreakSyncs: 2 })],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "UNKNOWN"), evidence(2, "RESOLVED", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanTenureIsLowerBound: true, clanStreakSyncs: 2, allianceStreakSyncs: 2 });
  });

  it("does not synthesize S0/A0 when the prior boundary is unresolved", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak({
        latestFwaEvidenceStatus: "UNKNOWN",
        latestFwaClanTag: null,
        latestEvidenceAvailable: false,
        latestEvidencePending: true,
        latestPendingClanValueAvailable: false,
        latestPendingAllianceValueAvailable: false,
        clanStreakSyncs: 0,
        allianceStreakSyncs: 0,
      })],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: {
        [playerTag]: [evidence(3, "UNKNOWN"), evidence(2, "UNKNOWN"), evidence(1, "RESOLVED", homeClanTag)],
      },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanStreakSyncs: null, allianceStreakSyncs: null });
  });

  it("returns an unavailable Home tenure when there is no boundary coverage", async () => {
    const built = serviceFor({ homes: [home()], streaks: [streak()], boundaryTimes: [] });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: null, clanTenureIsLowerBound: false });
  });

  it("keeps Home tenure credit across UNKNOWN boundaries and marks C lower-bounded", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak()],
      boundaryTimes: [time(6), time(5), time(4), time(3), time(2), time(1)],
      boundaryIdentities: [6, 5, 4, 3, 2, 1].map((syncNumber, index) => ({
        boundaryTime: time(6 - index),
        syncNumber: 550 + syncNumber,
      })),
      evidenceByPlayer: {
        [playerTag]: [
          evidence(6, "RESOLVED", homeClanTag),
          evidence(5, "UNKNOWN"),
          evidence(4, "UNKNOWN"),
          evidence(3, "UNKNOWN"),
          evidence(2, "RESOLVED", homeClanTag),
          evidence(1, "RESOLVED", homeClanTag),
        ],
      },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 3, clanTenureIsLowerBound: true });
  });

  it("does not reset C for a resolved observation in another clan", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag)],
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "RESOLVED", homeClanTag), evidence(2, "RESOLVED", otherClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanTenureIsLowerBound: false });
  });

  it("does not lower-bound C for a known ABSENT boundary", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag)],
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "RESOLVED", homeClanTag), evidence(2, "ABSENT"), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanTenureIsLowerBound: false });
  });

  it("does not credit an AMBIGUOUS boundary and lower-bounds C", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag)],
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
      evidenceByPlayer: { [playerTag]: [evidence(3, "RESOLVED", homeClanTag), evidence(2, "AMBIGUOUS", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 2, clanTenureIsLowerBound: true });
  });

  it("lower-bounds C across a canonical sync-number gap without synthesizing it", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag)],
      streaks: [streak()],
      boundaryTimes: [time(4), time(3), time(2), time(1)],
      boundaryIdentities: [556, 555, 553, 552].map((syncNumber, index) => ({
        boundaryTime: time(4 - index),
        syncNumber,
      })),
      evidenceByPlayer: { [playerTag]: [evidence(4, "RESOLVED", homeClanTag), evidence(3, "RESOLVED", homeClanTag), evidence(2, "RESOLVED", homeClanTag), evidence(1, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 4, clanTenureIsLowerBound: true });
  });

  it("marks C as a lower bound when the bounded canonical window is truncated", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(1))],
      streaks: [streak({ clanStreakSyncs: 3, allianceStreakSyncs: 3 })],
      boundaryTimes: [time(5), time(4), time(3)],
      boundaryHistoryTruncated: true,
      evidenceByPlayer: { [playerTag]: [evidence(5, "RESOLVED", homeClanTag), evidence(4, "RESOLVED", homeClanTag), evidence(3, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 3, clanTenureIsLowerBound: true });
  });

  it("keeps C lower-bounded whenever the canonical history is truncated", async () => {
    const built = serviceFor({
      homes: [home(homeClanTag, time(5))],
      streaks: [streak()],
      boundaryTimes: [time(5), time(4), time(3)],
      boundaryHistoryTruncated: true,
      evidenceByPlayer: { [playerTag]: [evidence(5, "RESOLVED", homeClanTag), evidence(4, "RESOLVED", homeClanTag), evidence(3, "RESOLVED", homeClanTag)] },
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: 3, clanTenureIsLowerBound: true });
  });

  it("keeps physical and alliance streaks independent of Home ownership", async () => {
    const built = serviceFor({
      streaks: [streak({ clanStreakSyncs: 2, allianceStreakSyncs: 4, clanStreakIsLowerBound: true, allianceStreakIsLowerBound: true })],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const result = byTag(await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] }));

    expect(result).toMatchObject({ clanTenureSyncs: null, clanStreakSyncs: 2, allianceStreakSyncs: 4 });
  });
});
