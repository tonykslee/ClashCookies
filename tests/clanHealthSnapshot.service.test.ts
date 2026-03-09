import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("returns null for non-tracked clan", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue(null);
    const service = new ClanHealthSnapshotService();

    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#MISSING",
    });

    expect(snapshot).toBeNull();
    expect(prismaMock.clanWarHistory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.playerActivity.findMany).not.toHaveBeenCalled();
  });

  it("computes rates, inactivity, and missing links for partial war samples", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#AAA111",
      name: "Alpha",
    });
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      { matchType: "FWA", actualOutcome: "WIN" },
      { matchType: "BL", actualOutcome: "LOSE" },
      { matchType: "FWA", actualOutcome: "WIN" },
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

    const service = new ClanHealthSnapshotService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "aaa111",
      warWindowSize: 30,
      inactiveWarWindowSize: 3,
      inactiveDaysThreshold: 7,
      inactiveStaleHours: 6,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.clanTag).toBe("#AAA111");
    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(3);
    expect(snapshot?.warMetrics.fwaMatchCount).toBe(2);
    expect(snapshot?.warMetrics.winCount).toBe(2);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(2);
    expect(snapshot?.inactiveWars.warsSampled).toBe(2);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(1);
    expect(snapshot?.inactiveDays.inactivePlayerCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(1);
    expect(snapshot?.missingLinks.observedMemberCount).toBe(3);
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

    const service = new ClanHealthSnapshotService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#BBB222",
    });

    expect(snapshot?.warMetrics.endedWarSampleSize).toBe(0);
    expect(snapshot?.inactiveWars.warsAvailable).toBe(0);
    expect(snapshot?.inactiveWars.inactivePlayerCount).toBe(0);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(0);
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

    const service = new ClanHealthSnapshotService();
    const snapshot = await service.getSnapshot({
      guildId: "guild-1",
      clanTag: "#CCC333",
    });

    expect(snapshot?.missingLinks.observedMemberCount).toBe(2);
    expect(snapshot?.missingLinks.missingMemberCount).toBe(2);
    expect(snapshot?.missingLinks.linkedMemberCount).toBe(0);
  });
});
