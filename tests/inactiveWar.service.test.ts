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

function getQueryInValues(args: any, path: "clanTag" | "warId"): Set<string> {
  return new Set((args?.where?.[path]?.in ?? []).map((value: string) => String(value)));
}

function filterHistoryRowsByClanTags(rows: Array<{ clanTag: string }>, args: any) {
  const clanTags = getQueryInValues(args, "clanTag");
  return rows.filter((row) => clanTags.has(String(row.clanTag)));
}

function filterParticipationRows(
  rows: Array<{ clanTag: string; warId: string }>,
  args: any
) {
  const clanTags = getQueryInValues(args, "clanTag");
  const warIds = getQueryInValues(args, "warId");
  return rows.filter((row) => clanTags.has(String(row.clanTag)) && warIds.has(String(row.warId)));
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
      return filterParticipationRows(participationRows, args);
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
    expect(summary.diagnosticNote).toBe(
      "Diagnostic: ended wars found yes (4), participation rows found no (0)."
    );
  });

  it("includes a player when at least one of the selected wars was missedBoth and excludes players with no missed-both rows", async () => {
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
        missedBoth: false,
        trueStars: 0,
        attackDelayMinutes: 55,
        attackWindowMissed: false,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "398",
        missedBoth: false,
        trueStars: 0,
        attackDelayMinutes: null,
        attackWindowMissed: null,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#C",
        playerName: "Charlie",
        warId: "400",
        missedBoth: false,
        trueStars: 2,
        attackDelayMinutes: 12,
        attackWindowMissed: false,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#C",
        playerName: "Charlie",
        warId: "399",
        missedBoth: false,
        trueStars: 1,
        attackDelayMinutes: 20,
        attackWindowMissed: false,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      return filterParticipationRows(participationRows, args);
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
      missedWars: 1,
      participationWars: 3,
      totalTrueStars: 0,
      lateAttacks: 1,
      warsAvailable: 3,
    });
    expect(summary.results[0]?.avgAttackDelay).toBeCloseTo(47.5);
    expect(summary.results.some((row) => row.playerTag === "C")).toBe(false);
  });

  it("matches tracked-clan history and participation rows stored with either bare or # clan tags", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "AAA111", name: "Alpha" }]);
    const historyRows = [
      makeHistoryRow(400, "AAA111", "2026-04-04T00:00:00.000Z"),
      makeHistoryRow(399, "#AAA111", "2026-04-03T00:00:00.000Z"),
    ];
    prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) =>
      filterHistoryRowsByClanTags(historyRows, args)
    );
    const participationRows = [
      makeParticipationRow({
        clanTag: "AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "400",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#C",
        playerName: "Charlie",
        warId: "399",
        missedBoth: true,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
      filterParticipationRows(participationRows, args)
    );

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 2,
    });

    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clanTag: expect.objectContaining({
            in: expect.arrayContaining(["AAA111", "#AAA111"]),
          }),
        }),
      })
    );
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clanTag: expect.objectContaining({
            in: expect.arrayContaining(["AAA111", "#AAA111"]),
          }),
        }),
      })
    );
    expect(summary.results.map((row) => row.playerTag).sort()).toEqual(["B", "C"]);
  });

  it("omits players with no missed-both rows", async () => {
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
        missedBoth: false,
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
      return filterParticipationRows(participationRows, args);
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(summary.results).toEqual([]);
    expect(summary.diagnosticNote).toContain("ended wars found yes");
  });

  it("reports a short diagnostic note when no inactive players are found but data exists", async () => {
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
        missedBoth: false,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#D",
        playerName: "Delta",
        warId: "398",
        missedBoth: false,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      return filterParticipationRows(participationRows, args);
    });

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });

    expect(summary.results).toEqual([]);
    expect(summary.diagnosticNote).toBe(
      "Diagnostic: ended wars found yes (3), participation rows found yes (2)."
    );
  });
});
