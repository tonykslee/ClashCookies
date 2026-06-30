import { describe, expect, it, vi } from "vitest";
import { normalizeClashTagInput } from "../src/helper/clashTag";
import { WarPlanViolationHistoryService } from "../src/services/WarPlanViolationHistoryService";

type ViolationFixture = {
  playerTag: string;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
};

type EvaluationFixture = {
  guildId: string;
  warId: number;
  clanTag: string;
  clanName: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  completedAt?: Date | null;
  status?: string;
  violations: ViolationFixture[];
};

function d(value: string): Date {
  return new Date(value);
}

function buildFixture(input: Partial<EvaluationFixture> & {
  guildId?: string;
  warId: number;
  clanTag: string;
  warStartTime: Date;
  warEndTime: Date | null;
  violations?: ViolationFixture[];
}): EvaluationFixture {
  return {
    guildId: input.guildId ?? "guild-1",
    warId: input.warId,
    clanTag: input.clanTag,
    clanName: input.clanName ?? null,
    warStartTime: input.warStartTime,
    warEndTime: input.warEndTime,
    completedAt: input.completedAt ?? input.warEndTime ?? null,
    status: input.status ?? "COMPLETED",
    violations: input.violations ?? [],
  };
}

function normalizeTag(input: string | null | undefined): string {
  return normalizeClashTagInput(input);
}

function resolveCanonicalMs(row: EvaluationFixture): number {
  return (row.warEndTime ?? row.warStartTime).getTime();
}

function compareFixturesDesc(a: EvaluationFixture, b: EvaluationFixture): number {
  const timeDelta = resolveCanonicalMs(b) - resolveCanonicalMs(a);
  if (timeDelta !== 0) return timeDelta;
  return b.warId - a.warId;
}

function extractRelationFilter(where: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const relation = where?.warHistory as Record<string, unknown> | undefined;
  if (!relation) return null;
  const nested = relation.is as Record<string, unknown> | undefined;
  return nested ?? relation;
}

function matchesEvaluationWhere(row: EvaluationFixture, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  if (typeof where.guildId === "string" && where.guildId !== row.guildId) return false;
  if (typeof where.status === "string" && where.status !== row.status) return false;

  const relation = extractRelationFilter(where);
  if (!relation) return true;

  if (typeof relation.clanTag === "string" && normalizeTag(relation.clanTag) !== normalizeTag(row.clanTag)) {
    return false;
  }

  const warEndTime = relation.warEndTime as { gte?: Date } | undefined;
  if (warEndTime?.gte instanceof Date) {
    if (!(row.warEndTime instanceof Date)) return false;
    if (row.warEndTime.getTime() < warEndTime.gte.getTime()) return false;
  }

  return true;
}

function buildDb(fixtures: EvaluationFixture[]) {
  const ordered = [...fixtures].sort(compareFixturesDesc);

  const db = {
    clanWarHistory: {
      findFirst: vi.fn(async (args?: { where?: { clanTag?: string } }) => {
        const clanTag = normalizeTag(args?.where?.clanTag ?? "");
        if (!clanTag) return null;
        const hit = ordered.find((row) => normalizeTag(row.clanTag) === clanTag);
        if (!hit) return null;
        return {
          clanTag: hit.clanTag,
          clanName: hit.clanName,
        };
      }),
    },
    warPlanComplianceEvaluation: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        ordered
          .filter((row) => matchesEvaluationWhere(row, args?.where))
          .map((row) => ({
            warId: row.warId,
            warHistory: {
              warId: row.warId,
              clanTag: row.clanTag,
              clanName: row.clanName,
              warStartTime: row.warStartTime,
              warEndTime: row.warEndTime,
            },
            violations: row.violations,
          })),
      ),
    },
  };

  return db;
}

function buildService(fixtures: EvaluationFixture[]) {
  const db = buildDb(fixtures);
  return {
    db,
    service: new WarPlanViolationHistoryService(db as any),
  };
}

describe("WarPlanViolationHistoryService", () => {
  it("pushes the 30-day cutoff into Prisma and reuses the exact cutoff Date", async () => {
    const now = d("2026-06-01T00:00:00.000Z");
    const { db, service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#PYLQ0289",
        clanName: "Alpha",
        warStartTime: d("2026-05-02T00:00:00.000Z"),
        warEndTime: d("2026-05-02T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#2QG2C08UP",
            playerNameSnapshot: "Inside Window",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#PYLQ0289",
        clanName: "Alpha",
        warStartTime: d("2026-04-01T00:00:00.000Z"),
        warEndTime: d("2026-04-02T00:00:00.000Z"),
        completedAt: d("2026-06-10T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#G2R9RQLJQ",
            playerNameSnapshot: "Outside Window",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildFixture({
        warId: 3,
        clanTag: "#PYLQ0289",
        clanName: "Alpha",
        warStartTime: d("2026-05-31T00:00:00.000Z"),
        warEndTime: null,
        completedAt: d("2026-06-30T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#2RVGJYLC0",
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

    const where = db.warPlanComplianceEvaluation.findMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
    const cutoff = (where.warHistory as { is?: { warEndTime?: { gte?: Date } } })?.is?.warEndTime?.gte;

    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(where).toMatchObject({
      guildId: "guild-1",
      status: "COMPLETED",
    });
    expect((where.warHistory as { is?: { warEndTime?: { gte?: Date } } }).is?.warEndTime?.gte).toBe(
      result.cutoff,
    );
    expect(result.cutoff).toBe(cutoff);
    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 1,
      affectedWarCount: 1,
      violationCount: 1,
      hasCompletedEvaluations: true,
    });
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#2QG2C08UP",
        playerNameSnapshot: "Inside Window",
      }),
    ]);
  });

  it("pushes the normalized clan tag into Prisma and excludes unrelated clan rows", async () => {
    const { db, service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Alpha One",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#G2R9RQLJQ",
        clanName: "Beta",
        warStartTime: d("2026-05-11T00:00:00.000Z"),
        warEndTime: d("2026-05-11T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#2RVGJYLC0",
            playerNameSnapshot: "Beta One",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "2qg2c08up",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    const identityWhere = db.clanWarHistory.findFirst.mock.calls[0]?.[0]?.where as {
      clanTag?: string;
    };
    const queryWhere = db.warPlanComplianceEvaluation.findMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;

    expect(identityWhere.clanTag).toBe("#2QG2C08UP");
    expect(queryWhere).toMatchObject({
      guildId: "guild-1",
      status: "COMPLETED",
    });
    expect((queryWhere.warHistory as { is?: { clanTag?: string } }).is?.clanTag).toBe("#2QG2C08UP");
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "success",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      evaluatedWarCount: 1,
      affectedWarCount: 1,
      violationCount: 1,
      distinctPlayerCount: 1,
      hasCompletedEvaluations: true,
    });
    expect(result.players).toEqual([
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        playerNameSnapshot: "Alpha One",
      }),
    ]);
  });

  it("returns successful no-data metadata for a known clan with only outside-window evaluations", async () => {
    const { db, service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-04-01T00:00:00.000Z"),
        warEndTime: d("2026-04-01T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Outside Only",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "30d",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.clanWarHistory.findFirst).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "success",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
      trackingSince: null,
    });
  });

  it("returns not_found for malformed and genuinely unknown clans", async () => {
    const { db, service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [],
      }),
    ]);

    const malformed = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "bad-tag",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });
    const unknown = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#G2R9RQLJQ",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(malformed.outcome).toBe("not_found");
    expect(malformed.clanTag).toBe("");
    expect(unknown).toMatchObject({
      outcome: "not_found",
      clanTag: "#G2R9RQLJQ",
      clanName: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });
    expect(db.clanWarHistory.findFirst).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(0);
  });

  it("orders snapshots by canonical history instead of completedAt when a null-ended war is newer on paper", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#PYLQ0289",
        clanName: "Older Null Clan",
        warStartTime: d("2026-05-01T00:00:00.000Z"),
        warEndTime: null,
        completedAt: d("2026-05-20T00:00:00.000Z"),
        violations: [
          {
            playerTag: "#2QG2C08UP",
            playerNameSnapshot: "Older Null",
            townHallLevelSnapshot: 14,
          },
        ],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#PYLQ0289",
        clanName: "Newer Canonical Clan",
        warStartTime: d("2026-05-16T00:00:00.000Z"),
        warEndTime: d("2026-05-16T01:00:00.000Z"),
        completedAt: d("2026-05-16T01:30:00.000Z"),
        violations: [
          {
            playerTag: "#2QG2C08UP",
            playerNameSnapshot: "Newer Canonical",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#PYLQ0289",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.clanName).toBe("Newer Canonical Clan");
    expect(result.trackingSince).toEqual(d("2026-05-16T01:00:00.000Z"));
    expect(result.players[0]).toMatchObject({
      playerTag: "#2QG2C08UP",
      playerNameSnapshot: "Newer Canonical",
      townHallLevelSnapshot: 16,
    });
  });

  it("uses warStartTime when warEndTime is null for canonical recency ordering", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#PYLQ0289",
        clanName: "Null Newer Clan",
        warStartTime: d("2026-05-17T00:00:00.000Z"),
        warEndTime: null,
        completedAt: d("2026-05-17T00:30:00.000Z"),
        violations: [
          {
            playerTag: "#2QG2C08UP",
            playerNameSnapshot: "Null Newer",
            townHallLevelSnapshot: 17,
          },
        ],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#PYLQ0289",
        clanName: "Ended Older Clan",
        warStartTime: d("2026-05-16T00:00:00.000Z"),
        warEndTime: d("2026-05-16T01:00:00.000Z"),
        completedAt: d("2026-05-16T01:05:00.000Z"),
        violations: [
          {
            playerTag: "#2QG2C08UP",
            playerNameSnapshot: "Ended Older",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#PYLQ0289",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.clanName).toBe("Null Newer Clan");
    expect(result.players[0]).toMatchObject({
      playerTag: "#2QG2C08UP",
      playerNameSnapshot: "Null Newer",
      townHallLevelSnapshot: 17,
    });
  });

  it("keeps zero-violation completed evaluations in coverage and returns deterministic player ordering", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-11T00:00:00.000Z"),
        warEndTime: d("2026-05-11T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Zulu",
            townHallLevelSnapshot: 16,
          },
          {
            playerTag: "#G2R9RQLJQ",
            playerNameSnapshot: "Alpha",
            townHallLevelSnapshot: 15,
          },
        ],
      }),
      buildFixture({
        warId: 3,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Latest",
        warStartTime: d("2026-05-12T00:00:00.000Z"),
        warEndTime: d("2026-05-12T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Zulu Updated",
            townHallLevelSnapshot: null,
          },
          {
            playerTag: "#G2R9RQLJQ",
            playerNameSnapshot: "Alpha Updated",
            townHallLevelSnapshot: 14,
          },
          {
            playerTag: "#2RVGJYLC0",
            playerNameSnapshot: "Beta",
            townHallLevelSnapshot: 13,
          },
        ],
      }),
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 3,
      affectedWarCount: 2,
      violationCount: 5,
      distinctPlayerCount: 3,
      hasCompletedEvaluations: true,
      clanName: "Alpha Latest",
    });
    expect(result.players).toEqual([
      expect.objectContaining({
        playerTag: "#G2R9RQLJQ",
        playerNameSnapshot: "Alpha Updated",
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        playerNameSnapshot: "Zulu Updated",
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#2RVGJYLC0",
        playerNameSnapshot: "Beta",
        violationCount: 1,
        affectedWarCount: 1,
      }),
    ]);
  });

  it("returns a success shell for alliance overviews with no completed evaluations in range", async () => {
    const { db, service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-04-01T00:00:00.000Z"),
        warEndTime: d("2026-04-01T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Outside",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "30d",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      distinctClanCount: 0,
      clanSummaries: [],
      topPlayers: [],
      hasCompletedEvaluations: false,
      trackingSince: null,
    });
  });
});
