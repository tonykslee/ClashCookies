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
  playerCurrent: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
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
  townHall?: number | null;
  trueStars?: number;
  attackDelayMinutes?: number | null;
  attackWindowMissed?: boolean | null;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName,
    warId: input.warId,
    townHall: input.townHall ?? null,
    missedBoth: input.missedBoth,
    trueStars: input.trueStars ?? 0,
    attackDelayMinutes: input.attackDelayMinutes ?? null,
    attackWindowMissed: input.attackWindowMissed ?? null,
    warStartTime: new Date("2026-04-01T00:00:00.000Z"),
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

function makePlayerCurrentRow(input: { playerTag: string; townHall: number | null }) {
  return {
    playerTag: input.playerTag,
    townHall: input.townHall,
  };
}

function makeFwaClanMemberCurrentRow(input: {
  clanTag: string;
  playerTag: string;
  townHall: number | null;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    townHall: input.townHall,
  };
}

function makeFwaPlayerCatalogRow(input: {
  playerTag: string;
  latestTownHall: number | null;
}) {
  return {
    playerTag: input.playerTag,
    latestTownHall: input.latestTownHall,
  };
}

function makeFwaTrackedClanWarRosterMemberCurrentRow(input: {
  clanTag: string;
  playerTag: string;
  townHall: number | null;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    townHall: input.townHall,
  };
}

function getQueryInValues(args: any, path: "clanTag" | "warId"): Set<string> {
  return new Set((args?.where?.[path]?.in ?? []).map((value: string) => String(value)));
}

function getQueryNotInValues(args: any, path: "warId"): Set<string> {
  return new Set((args?.where?.[path]?.notIn ?? []).map((value: string) => String(value)));
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
  const warIdsIn = getQueryInValues(args, "warId");
  const warIdsNotIn = getQueryNotInValues(args, "warId");
  return rows.filter((row) => {
    const clanMatch = clanTags.size === 0 || clanTags.has(String(row.clanTag));
    const inMatch = warIdsIn.size === 0 || warIdsIn.has(String(row.warId));
    const notInMatch = warIdsNotIn.size === 0 || !warIdsNotIn.has(String(row.warId));
    return clanMatch && inMatch && notInMatch;
  });
}

describe("InactiveWarService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
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

  it("keeps the default wars filter broad but consecutive:true requires misses in every selected war", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    const historyRows = [
      makeHistoryRow({
        warId: 503,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 502,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "BL",
      }),
      makeHistoryRow({
        warId: 501,
        clanTag: "#AAA111",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "MM",
      }),
    ];
    prismaMock.clanWarHistory.findMany.mockImplementation(async (args: any) =>
      filterHistoryRows(historyRows, args)
    );
    const participationRows = [
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha Partial",
        warId: "503",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha Partial",
        warId: "502",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Alpha Full",
        warId: "503",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Alpha Full",
        warId: "502",
        missedBoth: true,
      }),
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#B",
        playerName: "Alpha Full",
        warId: "501",
        missedBoth: true,
      }),
    ];
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) =>
      filterParticipationRows(participationRows, args)
    );

    const service = new InactiveWarService();
    const defaultSummary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
    });
    const consecutiveSummary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 3,
      consecutive: true,
    });

    expect(defaultSummary.results.map((row) => row.playerTag).sort()).toEqual(["A", "B"]);
    expect(defaultSummary.results.find((row) => row.playerTag === "A")).toMatchObject({
      missedWars: 2,
      participationWars: 2,
    });
    expect(consecutiveSummary.results.map((row) => row.playerTag)).toEqual(["B"]);
    expect(consecutiveSummary.results[0]).toMatchObject({
      missedWars: 3,
      participationWars: 3,
    });
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

  it("keeps the selected participation town hall when it is already present", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 400,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha",
        warId: "400",
        missedBoth: true,
        townHall: 17,
        trueStars: 0,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({ playerTag: "#A", townHall: 18 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(17);
    expect(prismaMock.playerCurrent.findMany).not.toHaveBeenCalled();
  });

  it("uses a historical participation town hall fallback when the selected rows are null", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 400,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "LOSE",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const rows = [
        makeParticipationRow({
          clanTag: "#AAA111",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "401",
          missedBoth: true,
          townHall: null,
          trueStars: 0,
        }),
        makeParticipationRow({
          clanTag: "#AAA111",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "400",
          missedBoth: false,
          townHall: 14,
          trueStars: 0,
        }),
      ];
      return filterParticipationRows(rows, args);
    });
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(14);
    expect(prismaMock.clanWarParticipation.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.playerCurrent.findMany).not.toHaveBeenCalled();
  });

  it("fills missing town halls from PlayerCurrent when war participation rows are null", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({ playerTag: "#A", townHall: 18 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(18);
    expect(prismaMock.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("falls back to FWA clan member current when PlayerCurrent is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeFwaClanMemberCurrentRow({ clanTag: "#AAA111", playerTag: "#A", townHall: 19 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(19);
    expect(prismaMock.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("falls back to FwaPlayerCatalog latestTownHall when earlier sources are missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "9Q8R0VRJ",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeFwaPlayerCatalogRow({ playerTag: "9Q8R0VRJ", latestTownHall: 15 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.playerTag).toBe("9Q8R0VRJ");
    expect(summary.results[0]?.townHall).toBe(15);
    expect(prismaMock.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("prefers PlayerCurrent town hall over catalog town hall", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "9Q8R0VRJ",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrentRow({ playerTag: "9Q8R0VRJ", townHall: 18 }),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeFwaPlayerCatalogRow({ playerTag: "9Q8R0VRJ", latestTownHall: 15 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(18);
    expect(prismaMock.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("prefers FWA clan member current town hall over catalog town hall", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "9Q8R0VRJ",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeFwaClanMemberCurrentRow({ clanTag: "#AAA111", playerTag: "9Q8R0VRJ", townHall: 19 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeFwaPlayerCatalogRow({ playerTag: "9Q8R0VRJ", latestTownHall: 15 }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(19);
    expect(prismaMock.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).not.toHaveBeenCalled();
  });

  it("falls back to tracked war roster members when earlier sources are missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#AAA111", name: "Alpha" }]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 401,
        clanTag: "#AAA111",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockResolvedValue([
      makeParticipationRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        playerName: "Alpha",
        warId: "401",
        missedBoth: true,
        townHall: null,
      }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeFwaTrackedClanWarRosterMemberCurrentRow({
        clanTag: "#AAA111",
        playerTag: "#A",
        townHall: 20,
      }),
    ]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 1,
    });

    expect(summary.results[0]?.townHall).toBe(20);
    expect(prismaMock.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany).toHaveBeenCalledTimes(1);
  });

  it("prefers same-clan historical town hall fallbacks when multiple rows exist", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha" },
      { tag: "#BBB222", name: "Beta" },
    ]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([
      makeHistoryRow({
        warId: 502,
        clanTag: "#AAA111",
        endedAt: "2026-04-06T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 501,
        clanTag: "#BBB222",
        endedAt: "2026-04-05T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "WIN",
      }),
      makeHistoryRow({
        warId: 400,
        clanTag: "#AAA111",
        endedAt: "2026-04-04T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "LOSE",
      }),
      makeHistoryRow({
        warId: 399,
        clanTag: "#BBB222",
        endedAt: "2026-04-03T00:00:00.000Z",
        matchType: "FWA",
        actualOutcome: "LOSE",
      }),
    ]);
    prismaMock.clanWarParticipation.findMany.mockImplementation(async (args: any) => {
      const rows = [
        makeParticipationRow({
          clanTag: "#AAA111",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "502",
          missedBoth: true,
          townHall: null,
        }),
        makeParticipationRow({
          clanTag: "#BBB222",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "501",
          missedBoth: true,
          townHall: null,
        }),
        makeParticipationRow({
          clanTag: "#AAA111",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "400",
          missedBoth: false,
          townHall: 18,
        }),
        makeParticipationRow({
          clanTag: "#BBB222",
          playerTag: "#A",
          playerName: "Alpha",
          warId: "399",
          missedBoth: false,
          townHall: 16,
        }),
      ];
      return filterParticipationRows(rows, args);
    });
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);

    const service = new InactiveWarService();
    const summary = await service.listInactiveWarPlayers({
      guildId: "guild-1",
      wars: 2,
    });

    expect(summary.results.find((row) => row.clanTag === "AAA111")?.townHall).toBe(18);
    expect(summary.results.find((row) => row.clanTag === "BBB222")?.townHall).toBe(16);
  });
});
