import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  clanWarParticipation: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { InactiveWarService } from "../src/services/InactiveWarService";

function makeHistoryRow(warId: number, clanTag: string, endedAt: string) {
  const warEndTime = new Date(endedAt);
  return {
    warId,
    clanTag,
    clanName: `${clanTag}-name`,
    warStartTime: new Date(warEndTime.getTime() - 24 * 60 * 60 * 1000),
    warEndTime,
  };
}

function makeParticipationRow(input: {
  clanTag: string;
  playerTag: string;
  playerName: string;
  warId: string;
  missedBoth: boolean;
  trueStars?: number;
  attackDelayMinutes?: number | null;
  attackWindowMissed?: boolean | null;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName,
    warId: input.warId,
    missedBoth: input.missedBoth,
    trueStars: input.trueStars ?? 0,
    attackDelayMinutes: input.attackDelayMinutes ?? null,
    attackWindowMissed: input.attackWindowMissed ?? null,
    warStartTime: new Date("2026-04-01T00:00:00.000Z"),
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

describe("InactiveWarService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects only the latest ended wars and excludes older participation rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow(400, "#AAA111", "2026-04-04T00:00:00.000Z"),
      makeHistoryRow(399, "#AAA111", "2026-04-03T00:00:00.000Z"),
      makeHistoryRow(398, "#AAA111", "2026-04-02T00:00:00.000Z"),
      makeHistoryRow(397, "#AAA111", "2026-04-01T00:00:00.000Z"),
    ]);
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#OLD",
        playerName: "Old Timer",
        warId: "397",
        missedBoth: true,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const warIds = new Set((args?.where?.warId?.in ?? []).map((value: string) => String(value)));
      return participationRows.filter((row) => warIds.has(String(row.warId)));
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.clanWarParticipation.findMany.mock.calls[0]?.[0]?.where?.warId?.in).toEqual([
      "400",
      "399",
      "398",
    ]);
    expect(summary.results).toEqual([]);
    expect(summary.warnings).toEqual([]);
  });

  it("flags a player inactive only when every counted participation row is missedBoth", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow(400, "#AAA111", "2026-04-04T00:00:00.000Z"),
      makeHistoryRow(399, "#AAA111", "2026-04-03T00:00:00.000Z"),
      makeHistoryRow(398, "#AAA111", "2026-04-02T00:00:00.000Z"),
    ]);
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "400",
        missedBoth: true,
        trueStars: 0,
        attackDelayMinutes: 40,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "399",
        missedBoth: true,
        trueStars: 0,
        attackDelayMinutes: 55,
        attackWindowMissed: false,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "398",
        missedBoth: true,
        trueStars: 0,
        attackDelayMinutes: null,
        attackWindowMissed: null,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const warIds = new Set((args?.where?.warId?.in ?? []).map((value: string) => String(value)));
      return participationRows.filter((row) => warIds.has(String(row.warId)));
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      clanTag: "AAA111",
      playerTag: "B",
      playerName: "Bravo",
      missedWars: 3,
      participationWars: 3,
      totalTrueStars: 0,
      lateAttacks: 1,
      warsAvailable: 3,
    });
    expect(summary.results[0]?.avgAttackDelay).toBeCloseTo(47.5);
  });

  it("excludes a player who was active in any counted participation row", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow(400, "#AAA111", "2026-04-04T00:00:00.000Z"),
      makeHistoryRow(399, "#AAA111", "2026-04-03T00:00:00.000Z"),
      makeHistoryRow(398, "#AAA111", "2026-04-02T00:00:00.000Z"),
    ]);
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#C",
        playerName: "Charlie",
        warId: "400",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#C",
        playerName: "Charlie",
        warId: "399",
        missedBoth: false,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const warIds = new Set((args?.where?.warId?.in ?? []).map((value: string) => String(value)));
      return participationRows.filter((row) => warIds.has(String(row.warId)));
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(summary.results).toEqual([]);
  });

  it("treats partial roster participation as inactive only when all counted participation rows are missedBoth", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow(400, "#AAA111", "2026-04-04T00:00:00.000Z"),
      makeHistoryRow(399, "#AAA111", "2026-04-03T00:00:00.000Z"),
      makeHistoryRow(398, "#AAA111", "2026-04-02T00:00:00.000Z"),
    ]);
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#D",
        playerName: "Delta",
        warId: "400",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#D",
        playerName: "Delta",
        warId: "398",
        missedBoth: true,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const warIds = new Set((args?.where?.warId?.in ?? []).map((value: string) => String(value)));
      return participationRows.filter((row) => warIds.has(String(row.warId)));
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      clanTag: "AAA111",
      playerTag: "D",
      playerName: "Delta",
      missedWars: 2,
      participationWars: 2,
    });
  });
});
