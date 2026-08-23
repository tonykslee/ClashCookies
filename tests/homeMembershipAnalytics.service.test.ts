import { describe, expect, it, vi } from "vitest";
import {
  HomeMembershipAnalyticsService,
  type HomeMembershipAnalyticsResult,
} from "../src/services/HomeMembershipAnalyticsService";
import type { ActiveHomeMembership } from "../src/services/ClanHomeMembershipService";

const guildId = "guild-1";
const playerTag = "#P2222";
const otherPlayerTag = "#P8888";
const homeClanTag = "#RRRR";
const otherClanTag = "#GJJJ";

function time(day: number): Date {
  return new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

function home(tag = playerTag, clanTag = homeClanTag, startedAtSyncTime = time(1)): ActiveHomeMembership {
  return {
    id: `home-${tag}`,
    guildId,
    playerTag: tag,
    clanTag,
    startedAtSyncTime,
    qualifiedAtSyncTime: startedAtSyncTime,
    endedAtSyncTime: null,
    establishmentSource: "AUTO_3_SYNC",
    endReason: null,
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
}> = {}) {
  return {
    playerTag: overrides.playerTag ?? playerTag,
    latestBoundaryTime: overrides.latestBoundaryTime === undefined ? time(3) : overrides.latestBoundaryTime,
    latestFwaEvidenceStatus: overrides.latestFwaEvidenceStatus ?? "RESOLVED",
    latestFwaClanTag: overrides.latestFwaClanTag === undefined ? homeClanTag : overrides.latestFwaClanTag,
    clanStreakSyncs: overrides.clanStreakSyncs ?? 3,
    clanStreakIsLowerBound: overrides.clanStreakIsLowerBound ?? false,
    allianceStreakSyncs: overrides.allianceStreakSyncs ?? 4,
    allianceStreakIsLowerBound: overrides.allianceStreakIsLowerBound ?? false,
    latestEvidenceAvailable: overrides.latestEvidenceAvailable ?? true,
  };
}

function serviceFor(input: {
  homes?: ActiveHomeMembership[];
  streaks?: ReturnType<typeof streak>[];
  boundaryTimes?: Date[];
  boundaryHistoryTruncated?: boolean;
}) {
  const homeReader = {
    getActiveHomeMembershipsForPlayers: vi.fn(async () => input.homes ?? []),
  };
  const streakReader = {
    getMembershipStreakBatchForPlayers: vi.fn(async () => ({
      streaks: input.streaks ?? [],
      boundaryTimes: input.boundaryTimes ?? [],
      boundaryHistoryTruncated: input.boundaryHistoryTruncated ?? false,
    })),
  };
  return {
    service: new HomeMembershipAnalyticsService(homeReader, streakReader),
    homeReader,
    streakReader,
  };
}

function byTag(results: HomeMembershipAnalyticsResult[], tag = playerTag): HomeMembershipAnalyticsResult {
  return results.find((result) => result.playerTag === tag)!;
}

describe("HomeMembershipAnalyticsService", () => {
  it("exposes physical streaks for a no-Home player while tenure remains unavailable", async () => {
    const built = serviceFor({
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({
      playerTag,
      homeMembershipPeriodId: null,
      homeClanTag: null,
      clanTenureSyncs: null,
      clanStreakSyncs: 3,
      allianceStreakSyncs: 4,
    });
    expect(built.homeReader.getActiveHomeMembershipsForPlayers).toHaveBeenCalledTimes(1);
    expect(built.streakReader.getMembershipStreakBatchForPlayers).toHaveBeenCalledTimes(1);
  });

  it("reports C3 for a newly established Home whose first three boundaries are covered", async () => {
    const built = serviceFor({
      homes: [home(playerTag, homeClanTag, time(1))],
      streaks: [streak()],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({ clanTenureSyncs: 3, clanTenureIsLowerBound: false, clanStreakSyncs: 3, allianceStreakSyncs: 4 });
  });

  it("does not reset Clan Tenure for temporary absence or a different physical clan", async () => {
    const built = serviceFor({
      homes: [home()],
      streaks: [streak({ latestFwaClanTag: otherClanTag, clanStreakSyncs: 1 })],
      boundaryTimes: [time(5), time(4), time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({ clanTenureSyncs: 5, clanTenureIsLowerBound: false, clanStreakSyncs: 1, allianceStreakSyncs: 4 });
  });

  it("counts a successor Home from its own started boundary", async () => {
    const built = serviceFor({
      homes: [home(playerTag, otherClanTag, time(4))],
      streaks: [streak({ latestFwaClanTag: otherClanTag, clanStreakSyncs: 2 })],
      boundaryTimes: [time(5), time(4), time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({ homeClanTag: otherClanTag, clanTenureSyncs: 2, clanStreakSyncs: 2 });
  });

  it("marks tenure as a lower bound when the bounded history ends after Home start", async () => {
    const built = serviceFor({
      homes: [home(playerTag, homeClanTag, time(1))],
      streaks: [streak()],
      boundaryTimes: [time(5), time(4), time(3)],
      boundaryHistoryTruncated: true,
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({ clanTenureSyncs: 3, clanTenureIsLowerBound: true });
  });

  it("preserves independent lower-bound streak flags without an active Home", async () => {
    const built = serviceFor({
      streaks: [streak({ clanStreakSyncs: 2, clanStreakIsLowerBound: true, allianceStreakSyncs: 2, allianceStreakIsLowerBound: true })],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({
      clanTenureSyncs: null,
      clanTenureIsLowerBound: false,
      clanStreakSyncs: 2,
      clanStreakIsLowerBound: true,
      allianceStreakSyncs: 2,
      allianceStreakIsLowerBound: true,
    });
  });

  it("keeps no-Home unknown and absent latest evidence fail-closed", async () => {
    const unknownBuilt = serviceFor({
      streaks: [streak({ latestFwaEvidenceStatus: "UNKNOWN", latestFwaClanTag: null, latestEvidenceAvailable: false })],
      boundaryTimes: [time(3), time(2), time(1)],
    });
    const [unknown] = await unknownBuilt.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });
    expect(unknown).toMatchObject({ clanTenureSyncs: null, clanStreakSyncs: null, allianceStreakSyncs: null });

    const absentBuilt = serviceFor({
      streaks: [streak({ latestFwaEvidenceStatus: "ABSENT", latestFwaClanTag: null, clanStreakSyncs: 0, allianceStreakSyncs: 0 })],
      boundaryTimes: [time(3), time(2), time(1)],
    });
    const [absent] = await absentBuilt.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });
    expect(absent).toMatchObject({ clanTenureSyncs: null, clanStreakSyncs: 0, allianceStreakSyncs: 0 });
  });

  it("returns unknown tenure when there is no canonical boundary coverage", async () => {
    const built = serviceFor({
      homes: [home(playerTag, homeClanTag, time(1))],
      streaks: [streak()],
      boundaryTimes: [],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result).toMatchObject({ clanTenureSyncs: null, clanTenureIsLowerBound: false });
  });

  it.each([
    ["ABSENT", 0],
    ["UNKNOWN", null],
    ["AMBIGUOUS", null],
  ] as const)("maps latest %s physical evidence to the physical-clan streak %s", async (status, expected) => {
    const built = serviceFor({
      homes: [home()],
      streaks: [streak({ latestFwaEvidenceStatus: status, latestFwaClanTag: null, latestEvidenceAvailable: status !== "UNKNOWN" })],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const [result] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });

    expect(result.clanStreakSyncs).toBe(expected);
  });

  it("preserves lower-bound streaks and hides an unknown alliance latest value", async () => {
    const built = serviceFor({
      homes: [home()],
      streaks: [streak({ clanStreakIsLowerBound: true, allianceStreakSyncs: 2, allianceStreakIsLowerBound: true, latestEvidenceAvailable: true })],
      boundaryTimes: [time(3), time(2), time(1)],
    });
    const [known] = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });
    expect(known).toMatchObject({ clanStreakSyncs: 3, clanStreakIsLowerBound: true, allianceStreakSyncs: 2, allianceStreakIsLowerBound: true });

    const unknownBuilt = serviceFor({
      homes: [home()],
      streaks: [streak({ latestFwaEvidenceStatus: "UNKNOWN", latestFwaClanTag: null, latestEvidenceAvailable: false })],
      boundaryTimes: [time(3), time(2), time(1)],
    });
    const [unknown] = await unknownBuilt.service.getAnalyticsForPlayers({ guildId, playerTags: [playerTag] });
    expect(unknown.allianceStreakSyncs).toBeNull();
  });

  it("returns identical analytics for linked and unlinked player tags in one batch", async () => {
    const built = serviceFor({
      homes: [home(playerTag), home(otherPlayerTag, homeClanTag, time(2))],
      streaks: [streak({ playerTag }), streak({ playerTag: otherPlayerTag })],
      boundaryTimes: [time(3), time(2), time(1)],
    });

    const results = await built.service.getAnalyticsForPlayers({ guildId, playerTags: [otherPlayerTag, playerTag, playerTag] });

    expect(results.map((result) => result.playerTag)).toEqual([playerTag, otherPlayerTag]);
    expect(byTag(results).clanTenureSyncs).toBe(3);
    expect(byTag(results, otherPlayerTag).clanTenureSyncs).toBe(2);
    expect(built.homeReader.getActiveHomeMembershipsForPlayers).toHaveBeenCalledTimes(1);
    expect(built.streakReader.getMembershipStreakBatchForPlayers).toHaveBeenCalledTimes(1);
  });
});
