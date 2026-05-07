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

function makeHistoryRow(input: {
  warId: number;
  clanTag: string;
  endedAt: string | null;
  matchType?: string | null;
  actualOutcome?: string | null;
  clanName?: string | null;
}) {
  const warEndTime = input.endedAt ? new Date(input.endedAt) : null;
  const warStartTime = warEndTime
    ? new Date(warEndTime.getTime() - 24 * 60 * 60 * 1000)
    : new Date("2026-04-01T00:00:00.000Z");
  return {
    warId: input.warId,
    clanTag: input.clanTag,
    clanName: input.clanName ?? `${input.clanTag}-name`,
    warStartTime,
    warEndTime,
    matchType: input.matchType ?? null,
    actualOutcome: input.actualOutcome ?? null,
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

function filterHistoryRows(rows: Array<{ clanTag: string; warEndTime: Date | null }>, args: any) {
  const clanTags = getQueryInValues(args, "clanTag");
  const endedOnly = args?.where?.warEndTime?.not === null;
  return rows.filter((row) => {
    const clanTagMatches = clanTags.size === 0 || clanTags.has(String(row.clanTag));
    const endedMatch = !endedOnly || row.warEndTime !== null;
    return clanTagMatches && endedMatch;
  });
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

  it("selects the last N ended wars across match types and records missed-war states", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    const historyRows = [
      makeHistoryRow({
        warId: 505,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 504,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "BL",
      }),
      makeHistoryRow({
        warId: 503,
        clanTag: "#AAA111",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "MM",
      }),
      makeHistoryRow({
        warId: 502,
        clanTag: "#AAA111",
        endedAt: "2026-04-02T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "LOSE",
      }),
      makeHistoryRow({
        warId: 501,
        clanTag: "#AAA111",
        endedAt: "2026-04-01T00:00:00.000Z",
        matchType: null,
        actualOutcome: null,
      }),
      makeHistoryRow({
        warId: 500,
        clanTag: "#AAA111",
        endedAt: null,
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ];
    prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) =>
      filterHistoryRows(historyRows, args)
    );
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "505",
        missedBoth: true,
        attackDelayMinutes: 40,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "504",
        missedBoth: true,
        attackDelayMinutes: 41,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "503",
        missedBoth: true,
        attackDelayMinutes: 42,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "502",
        missedBoth: true,
        attackDelayMinutes: 43,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "501",
        missedBoth: true,
        attackDelayMinutes: 44,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "500",
        missedBoth: true,
        attackDelayMinutes: 99,
        attackWindowMissed: true,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
      filterParticipationRows(participationRows, args)
    );

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 6,
    });

    expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          warEndTime: { not: null },
        }),
      })
    );
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          warId: expect.objectContaining({
            in: ["505", "504", "503", "502", "501"],
          }),
        }),
      })
    );
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      clanTag: "AAA111",
      playerTag: "B",
      playerName: "Bravo",
      missedWars: 5,
      participationWars: 5,
      totalTrueStars: 0,
      lateAttacks: 5,
      warsAvailable: 5,
    });
    expect(summary.results[0]?.missedWarStates.map((state) => state.warId)).toEqual([
      "505",
      "504",
      "503",
      "502",
      "501",
    ]);
    expect(summary.results[0]?.missedWarStates.map((state) => state.emoji)).toEqual([
      "🟢",
      "⚫",
      "⚪",
      "🔴",
      "🔘",
    ]);
    expect(summary.results[0]?.missedWarStates[0]).toMatchObject({
      matchType: "FWA",
      outcome: "WIN",
    });
    expect(summary.results[0]?.missedWarStates[4]).toMatchObject({
      matchType: null,
      outcome: null,
    });
    expect(summary.diagnosticNote).toBeNull();
  });

  it.each(["AAA111", "#AAA111"])(
    "filters to the selected tracked clan when clanTag is %s",
    async (clanTagFilter) => {
      prismaMock.trackedClan.findMany.mockResolvedValue([
        { tag: "AAA111", name: "Alpha" },
        { tag: "#BBB222", name: "Beta" },
      ]);
      const historyRows = [
        makeHistoryRow({
          warId: 400,
          clanTag: "AAA111",
          endedAt: "2026-04-04T00:00:00.000Z",
          matchType: "FWA",
          actualOutcome: "WIN",
        }),
        makeHistoryRow({
          warId: 300,
          clanTag: "#BBB222",
          endedAt: "2026-04-03T00:00:00.000Z",
          matchType: "BL",
        }),
      ];
      prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) =>
        filterHistoryRows(historyRows, args)
      );
      const participationRows = [
        makeParticipationRow({
          clanTag: "AAA111",
          playerTag: "#A",
          playerName: "Alpha Player",
          warId: "400",
          missedBoth: true,
        }),
        makeParticipationRow({
          clanTag: "#BBB222",
          playerTag: "#B",
          playerName: "Beta Player",
          warId: "300",
          missedBoth: true,
        }),
      ];
      prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
        filterParticipationRows(participationRows, args)
      );

      const service = new InactiveWarService();
      const summary = await service.listInactiveWarPlayers({
        guildId: "guild-1",
        wars: 1,
        clanTag: clanTagFilter,
      });

      expect(summary.trackedTags).toEqual(["AAA111"]);
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]).toMatchObject({
        clanTag: "AAA111",
        playerTag: "A",
        playerName: "Alpha Player",
        missedWars: 1,
        participationWars: 1,
        warsAvailable: 1,
      });
      expect(prismaMock.clanWarHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clanTag: expect.objectContaining({
              in: ["AAA111", "#AAA111"],
            }),
          }),
        })
      );
      expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clanTag: expect.objectContaining({
              in: ["AAA111", "#AAA111"],
            }),
          }),
        })
      );
    }
  );

  it("matches tracked-clan history and participation rows stored with either bare or # clan tags", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "AAA111", name: "Alpha" },
      { tag: "#BBB222", name: "Beta" },
    ]);
    const historyRows = [
      makeHistoryRow({
        warId: 400,
        clanTag: "AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 300,
        clanTag: "#BBB222",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "BL",
      }),
    ];
    prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) =>
      filterHistoryRows(historyRows, args)
    );
    const participationRows = [
      makeParticipationRow({
        clanTag: "AAA111",
        playerTag: "#A",
        playerName: "Alpha Player",
        warId: "400",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#BBB222",
        playerTag: "#B",
        playerName: "Beta Player",
        warId: "300",
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
            in: expect.arrayContaining(["AAA111", "#AAA111", "BBB222", "#BBB222"]),
          }),
        }),
      })
    );
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clanTag: expect.objectContaining({
            in: expect.arrayContaining(["AAA111", "#AAA111", "BBB222", "#BBB222"]),
          }),
        }),
      })
    );
    expect(summary.trackedTags).toEqual(["AAA111", "BBB222"]);
    expect(summary.results.map((row) => row.playerTag).sort()).toEqual(["A", "B"]);
  });

  it("omits players with no missed-both rows and keeps missedWarStates limited to missed wars", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 400,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 399,
        clanTag: "#AAA111",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "MM",
      }),
      makeHistoryRow({
        warId: 398,
        clanTag: "#AAA111",
        endedAt: "2026-04-02T00:00:00.000Z",
        matchType: "BL",
      }),
    ]);
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "400",
        missedBoth: true,
        attackDelayMinutes: 40,
        attackWindowMissed: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "399",
        missedBoth: false,
        attackDelayMinutes: 55,
        attackWindowMissed: false,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Bravo",
        warId: "398",
        missedBoth: false,
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
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
      filterParticipationRows(participationRows, args)
    );

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
    expect(summary.results[0]?.missedWarStates).toHaveLength(1);
    expect(summary.results[0]?.missedWarStates[0]).toMatchObject({
      warId: "400",
      emoji: "🟢",
      matchType: "FWA",
      outcome: "WIN",
    });
    expect(summary.results.some((row) => row.playerTag === "C")).toBe(false);
  });

  it("returns an empty tracked scope and diagnostic when the clan filter misses", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
      clanTag: "#ZZZ999",
    });

    expect(summary.results).toEqual([]);
    expect(summary.trackedTags).toEqual([]);
    expect(summary.trackedNameByTag.size).toBe(0);
    expect(summary.warnings).toEqual([
      "Diagnostic: clan filter #ZZZ999 matched no tracked clan.",
    ]);
    expect(summary.diagnosticNote).toBe(
      "Diagnostic: clan filter #ZZZ999 matched no tracked clan."
    );
    expect(prismaMock.clanWarHistory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.clanWarParticipation.findMany).not.toHaveBeenCalled();
  });

  it("reports a short diagnostic note when no inactive players are found but data exists", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 400,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 399,
        clanTag: "#AAA111",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "MM",
      }),
      makeHistoryRow({
        warId: 398,
        clanTag: "#AAA111",
        endedAt: "2026-04-02T00:00:00.000Z",
        matchType: "BL",
      }),
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
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
      filterParticipationRows(participationRows, args)
    );

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
