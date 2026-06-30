import { describe, expect, it, vi } from "vitest";
import { WarPlanViolationHistoryService } from "../src/services/WarPlanViolationHistoryService";

type ViolationRow = {
  playerTag: string;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
};

type HistoryRow = {
  status: string;
  warId: number;
  completedAt: Date | null;
  warHistory: {
    warId: number;
    clanTag: string;
    clanName: string | null;
    warEndTime: Date | null;
    warStartTime: Date;
  } | null;
  violations: ViolationRow[];
};

function d(value: string): Date {
  return new Date(value);
}

function buildRow(input: {
  warId: number;
  status?: string;
  clanTag: string;
  clanName?: string | null;
  warStartTime?: Date;
  warEndTime?: Date | null;
  completedAt?: Date | null;
  violations?: ViolationRow[];
}): HistoryRow {
  return {
    warId: input.warId,
    status: input.status ?? "COMPLETED",
    completedAt: input.completedAt ?? input.warEndTime ?? null,
    warHistory: {
      warId: input.warId,
      clanTag: input.clanTag,
      clanName: input.clanName ?? input.clanTag,
      warEndTime: input.warEndTime ?? null,
      warStartTime: input.warStartTime ?? input.warEndTime ?? d("2026-05-01T00:00:00.000Z"),
    },
    violations: input.violations ?? [],
  };
}

function makeDb(rows: HistoryRow[]) {
  return {
    warPlanComplianceEvaluation: {
      findMany: vi.fn(async () => rows),
    },
  };
}

function buildService(rows: HistoryRow[]) {
  const db = makeDb(rows);
  return {
    db,
    service: new WarPlanViolationHistoryService(db as any),
  };
}

describe("WarPlanViolationHistoryService", () => {
  it("includes only completed evaluations and issues one bounded query", async () => {
    const { db, service } = buildService([
      buildRow({
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Alpha One",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildRow({
        warId: 2,
        status: "PENDING",
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P2",
            playerNameSnapshot: "Pending Player",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildRow({
        warId: 3,
        status: "FAILED",
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P3",
            playerNameSnapshot: "Failed Player",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildRow({
        warId: 4,
        status: "INSUFFICIENT_DATA",
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P4",
            playerNameSnapshot: "Missing Player",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildRow({
        warId: 5,
        status: "SKIPPED",
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P5",
            playerNameSnapshot: "Skipped Player",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-05-31T00:00:00.000Z"),
    });

    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId: "guild-1",
          status: "COMPLETED",
        },
      }),
    );
    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 1,
      affectedWarCount: 1,
      violationCount: 1,
      distinctPlayerCount: 1,
      distinctClanCount: 1,
      hasCompletedEvaluations: true,
    });
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#P1",
        playerNameSnapshot: "Alpha One",
        townHallLevelSnapshot: 16,
      }),
    ]);
  });

  it("applies the 30-day cutoff to canonical warEndTime and excludes null-ended wars", async () => {
    const now = d("2026-05-31T00:00:00.000Z");
    const { service } = buildService([
      buildRow({
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warStartTime: d("2026-05-19T00:00:00.000Z"),
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Inside Window",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildRow({
        warId: 2,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warStartTime: d("2026-05-30T00:00:00.000Z"),
        warEndTime: d("2026-04-29T00:00:00.000Z"),
        completedAt: d("2026-05-30T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P2",
            playerNameSnapshot: "Old by End Time",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildRow({
        warId: 3,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warStartTime: d("2026-05-30T00:00:00.000Z"),
        warEndTime: null,
        completedAt: d("2026-05-30T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#P3",
            playerNameSnapshot: "Null Ended",
            townHallLevelSnapshot: 14,
          },
        ],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "30d",
      now,
    });

    expect(result).toMatchObject({
      cutoff: d("2026-05-01T00:00:00.000Z"),
      evaluatedWarCount: 1,
      affectedWarCount: 1,
      violationCount: 1,
      trackingSince: d("2026-05-20T00:00:00.000Z"),
    });
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#P1",
        playerNameSnapshot: "Inside Window",
      }),
    ]);
  });

  it("counts zero-violation completed evaluations toward coverage and trackingSince in lifetime", async () => {
    const now = d("2026-05-31T00:00:00.000Z");
    const { service } = buildService([
      buildRow({
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-01T00:00:00.000Z"),
        violations: [],
      }),
      buildRow({
        warId: 2,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-10T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Alpha One",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildRow({
        warId: 3,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: null,
        completedAt: d("2026-05-12T00:00:00.000Z"),
        violations: [],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now,
    });

    expect(result).toMatchObject({
      evaluatedWarCount: 3,
      affectedWarCount: 1,
      violationCount: 1,
      trackingSince: d("2026-05-01T00:00:00.000Z"),
      hasCompletedEvaluations: true,
    });
  });

  it("builds deterministic alliance and player rankings from the newest canonical snapshots", async () => {
    const { service } = buildService([
      buildRow({
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-10T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Alpha One",
            townHallLevelSnapshot: 14,
          },
          {
            playerTag: "#P2",
            playerNameSnapshot: "Beta Two",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildRow({
        warId: 2,
        clanTag: "#AAA111",
        clanName: "Alpha Renamed",
        warEndTime: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Alpha Renamed",
            townHallLevelSnapshot: null,
          },
        ],
      }),
      buildRow({
        warId: 3,
        clanTag: "#BBB222",
        clanName: "Bravo Current",
        warEndTime: d("2026-05-30T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P3",
            playerNameSnapshot: "Charlie Three",
            townHallLevelSnapshot: 13,
          },
          {
            playerTag: "#P4",
            playerNameSnapshot: "   ",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-05-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      evaluatedWarCount: 3,
      affectedWarCount: 3,
      violationCount: 5,
      distinctPlayerCount: 4,
      distinctClanCount: 2,
    });
    expect(result.clanSummaries).toEqual([
      expect.objectContaining({
        clanTag: "#AAA111",
        clanName: "Alpha Renamed",
        evaluatedWarCount: 2,
        affectedWarCount: 2,
        violationCount: 3,
        distinctPlayerCount: 2,
      }),
      expect.objectContaining({
        clanTag: "#BBB222",
        clanName: "Bravo Current",
        evaluatedWarCount: 1,
        affectedWarCount: 1,
        violationCount: 2,
        distinctPlayerCount: 2,
      }),
    ]);
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#P1",
        playerNameSnapshot: "Alpha Renamed",
        townHallLevelSnapshot: 14,
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#P4",
        playerNameSnapshot: "#P4",
        townHallLevelSnapshot: 16,
        violationCount: 1,
        affectedWarCount: 1,
      }),
      expect.objectContaining({
        playerTag: "#P2",
        playerNameSnapshot: "Beta Two",
        townHallLevelSnapshot: 15,
        violationCount: 1,
        affectedWarCount: 1,
      }),
      expect.objectContaining({
        playerTag: "#P3",
        playerNameSnapshot: "Charlie Three",
        townHallLevelSnapshot: 13,
        violationCount: 1,
        affectedWarCount: 1,
      }),
    ]);
  });

  it("returns a zero-violation clan leaderboard as success and a missing clan as not_found", async () => {
    const { db, service } = buildService([
      buildRow({
        warId: 1,
        clanTag: "#AAA111",
        clanName: "Alpha",
        warEndTime: d("2026-05-10T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#P1",
            playerNameSnapshot: "Alpha One",
            townHallLevelSnapshot: 14,
          },
        ],
      }),
      buildRow({
        warId: 2,
        clanTag: "#CCC333",
        clanName: "Gamma",
        warEndTime: d("2026-05-11T00:00:00.000Z"),
        violations: [],
      }),
    ]);

    const success = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#CCC333",
      period: "lifetime",
      now: d("2026-05-31T00:00:00.000Z"),
    });

    const missing = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#DDD444",
      period: "lifetime",
      now: d("2026-05-31T00:00:00.000Z"),
    });

    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(2);
    expect(success).toMatchObject({
      outcome: "success",
      clanTag: "#CCC333",
      clanName: "Gamma",
      evaluatedWarCount: 1,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      hasCompletedEvaluations: true,
    });
    expect(success.players).toEqual([]);
    expect(missing).toMatchObject({
      outcome: "not_found",
      clanTag: "#DDD444",
      clanName: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      trackingSince: null,
      hasCompletedEvaluations: false,
    });
  });
});
