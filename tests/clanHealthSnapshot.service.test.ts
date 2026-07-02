import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
}));

const warPlanHistoryMock = vi.hoisted(() => ({
  getClanLeaderboard: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { ClanHealthSnapshotService } from "../src/services/ClanHealthSnapshotService";

describe("ClanHealthSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createService() {
    return new ClanHealthSnapshotService(prismaMock as any, warPlanHistoryMock as any);
  }

  it("returns null for non-tracked clan", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    const service = createService();

    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#MISSING",
    });

    expect(snapshot).toBeNull();
    expect(prismaMock.clanWarHistory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.playerActivity.findMany).not.toHaveBeenCalled();
    expect(warPlanHistoryMock.getClanLeaderboard).not.toHaveBeenCalled();
  });

  it("computes rates, inactivity, and missing links for partial war samples", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#AAA111",
      name: "Alpha",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      ...Array.from({ length: 14 }, () => ({ matchType: "FWA", actualOutcome: "WIN" })),
      ...Array.from({ length: 12 }, () => ({ matchType: "FWA", actualOutcome: "LOSE" })),
      ...Array.from({ length: 3 }, () => ({ matchType: "BL", actualOutcome: "WIN" })),
      { matchType: "MM", actualOutcome: "LOSE" },
    ]);
    prismaMock.clanWarParticipation.findMany
      .mockResolvedValueOnce([
        { warId: "w3", warStartTime: new Date("2026-03-08T00:00:00.000Z") },
        { warId: "w2", warStartTime: new Date("2026-03-07T00:00:00.000Z") },
      ])
      .mockResolvedValueOnce([
        { playerTag: "#P1", missedBoth: false },
        { playerTag: "#P1", missedBoth: true },
        { playerTag: "#P2", missedBoth: false },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-08T23:00:00.000Z") },
      { tag: "#P3", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([{ playerTag: "#P1" }, { playerTag: "#P2" }]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "success",
      clanTag: "#AAA111",
      clanName: "Alpha",
      period: "30d",
      cutoff: new Date("2026-02-08T12:00:00.000Z"),
      trackingSince: new Date("2026-02-01T00:00:00.000Z"),
      evaluatedWarCount: 9,
      affectedWarCount: 4,
      violationCount: 7,
      distinctPlayerCount: 5,
      players: [
        {
          playerTag: "#P1",
          playerName: "Player One",
          townHallLevel: 14,
          discordUserId: "111111111111111111",
          violationCount: 4,
          affectedWarCount: 3,
        },
        {
          playerTag: "#P2",
          playerName: "Player Two",
          townHallLevel: 15,
          discordUserId: "222222222222222222",
          violationCount: 2,
          affectedWarCount: 2,
        },
        {
          playerTag: "#P3",
          playerName: "Player Three",
          townHallLevel: 13,
          discordUserId: "111111111111111111",
          violationCount: 1,
          affectedWarCount: 1,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "aaa111",
      warWindowSize: 30,
      inactiveWarWindowSize: 3,
      inactiveStaleHours: 6,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.clanTag).toBe("#AAA111");
    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(30);
    expect(snapshot?.warMetrics.fwaMatchCount).toBe(26);
    expect(snapshot?.warMetrics.fwaWinCount).toBe(14);
    expect(snapshot?.warMetrics.fwaLossCount).toBe(12);
    expect(snapshot?.warMetrics.blMatchCount).toBe(3);
    expect(snapshot?.warMetrics.mmMatchCount).toBe(1);
    expect(snapshot?.warMetrics.blInclusiveMatchCount).toBe(29);
    expect(snapshot?.warMetrics.winCount).toBe(17);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(2);
    expect(snapshot?.inactiveWars.warsSampled).toBe(2);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(1);
    expect(snapshot?.inactiveDays.thresholdDays).toBe(6);
    expect(snapshot?.inactiveDays.inactivePlayerCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(1);
    expect(snapshot?.missingLinks.observedMemberCount).toBe(3);
    expect(snapshot?.warPlanCompliance).toEqual({
      period: "30d",
      hasCompletedEvaluations: true,
      evaluatedWarCount: 9,
      affectedWarCount: 4,
      violationCount: 7,
      distinctPlayerCount: 5,
      distinctCurrentDiscordUserCount: 2,
    });
    expect(warPlanHistoryMock.getClanLeaderboard).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
      period: "30d",
    });
  });

  it("handles no-war and all-linked edge case", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#BBB222",
      name: "Bravo",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-08T22:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-08T21:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([{ playerTag: "#P1" }, { playerTag: "#P2" }]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "success",
      clanTag: "#BBB222",
      clanName: "Bravo",
      period: "30d",
      cutoff: null,
      trackingSince: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#BBB222",
    });

    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(0);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(0);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(0);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(0);
    expect(snapshot?.warPlanCompliance.hasCompletedEvaluations).toBe(false);
    expect(snapshot?.warPlanCompliance.violationCount).toBe(0);
  });

  it("handles all-unlinked edge case", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#CCC333",
      name: "Charlie",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: "#P1", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
      { tag: "#P2", lastSeenAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "not_found",
      clanTag: "#CCC333",
      clanName: null,
      period: "30d",
      cutoff: null,
      trackingSince: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#CCC333",
    });

    expect(snapshot?.missingLinks.observedMemberCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(2);
    expect(snapshot?.missingLinks.linkedMemberCount).toBe(0);
    expect(snapshot?.warPlanCompliance).toEqual({
      period: "30d",
      hasCompletedEvaluations: false,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      distinctCurrentDiscordUserCount: 0,
    });
  });

  it("logs aggregated compliance values without exposing identity payloads", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#DDD444",
      name: "Delta",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "success",
      clanTag: "#DDD444",
      clanName: "Delta",
      period: "30d",
      cutoff: null,
      trackingSince: null,
      evaluatedWarCount: 12,
      affectedWarCount: 4,
      violationCount: 9,
      distinctPlayerCount: 6,
      players: [],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#DDD444",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_evaluated_wars=12")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("compliance_discord_users=0")
    );
    infoSpy.mockRestore();
  });

  it("counts only positive-violation linked discord users once and trims invalid ids", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#EEE555",
      name: "Echo",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "success",
      clanTag: "#EEE555",
      clanName: "Echo",
      period: "30d",
      cutoff: null,
      trackingSince: null,
      evaluatedWarCount: 4,
      affectedWarCount: 2,
      violationCount: 4,
      distinctPlayerCount: 3,
      players: [
        {
          playerTag: "#P1",
          playerName: "One",
          townHallLevel: 15,
          discordUserId: " 111111111111111111 ",
          violationCount: 0,
          affectedWarCount: 0,
        },
        {
          playerTag: "#P2",
          playerName: "Two",
          townHallLevel: 14,
          discordUserId: "222222222222222222",
          violationCount: 2,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P3",
          playerName: "Three",
          townHallLevel: 13,
          discordUserId: "222222222222222222",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P4",
          playerName: "Four",
          townHallLevel: 12,
          discordUserId: null,
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P5",
          playerName: "Five",
          townHallLevel: 12,
          discordUserId: "   ",
          violationCount: 1,
          affectedWarCount: 1,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#EEE555",
    });

    expect(snapshot?.warPlanCompliance.distinctCurrentDiscordUserCount).toBe(1);
  });

  it("counts only normalized valid discord ids from positive-violation rows", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#GGG777",
      name: "Golf",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboard.mockResolvedValue({
      outcome: "success",
      clanTag: "#GGG777",
      clanName: "Golf",
      period: "30d",
      cutoff: null,
      trackingSince: null,
      evaluatedWarCount: 2,
      affectedWarCount: 2,
      violationCount: 4,
      distinctPlayerCount: 4,
      players: [
        {
          playerTag: "#P1",
          playerName: "One",
          townHallLevel: 15,
          discordUserId: "123456789012345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P2",
          playerName: "Two",
          townHallLevel: 14,
          discordUserId: "1234567890123456789012",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P3",
          playerName: "Three",
          townHallLevel: 13,
          discordUserId: "123456789012345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P4",
          playerName: "Four",
          townHallLevel: 12,
          discordUserId: "12345",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P5",
          playerName: "Five",
          townHallLevel: 12,
          discordUserId: "12345678901234567890123",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P6",
          playerName: "Six",
          townHallLevel: 12,
          discordUserId: "abc123",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P7",
          playerName: "Seven",
          townHallLevel: 12,
          discordUserId: "   ",
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P8",
          playerName: "Eight",
          townHallLevel: 12,
          discordUserId: null,
          violationCount: 1,
          affectedWarCount: 1,
        },
        {
          playerTag: "#P9",
          playerName: "Nine",
          townHallLevel: 12,
          discordUserId: "999999999999999999",
          violationCount: 0,
          affectedWarCount: 0,
        },
      ],
      hasCompletedEvaluations: true,
    });

    const service = createService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#GGG777",
    });

    expect(snapshot?.warPlanCompliance.distinctCurrentDiscordUserCount).toBe(2);
  });

  it("propagates leaderboard failures instead of converting them into zero summaries", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#FFF666",
      name: "Foxtrot",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValueOnce([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    warPlanHistoryMock.getClanLeaderboard.mockRejectedValue(new Error("leaderboard boom"));

    const service = createService();
    await expect(
      service.getSnapshot({
        guildId: "guild-1",
        clanTag: "#FFF666",
      })
    ).rejects.toThrow("leaderboard boom");
  });
});
