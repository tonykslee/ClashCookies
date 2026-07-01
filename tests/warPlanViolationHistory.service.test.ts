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

type PlayerCurrentFixture = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
};

type FwaClanMemberCurrentFixture = {
  playerTag: string;
  clanTag: string;
  townHall: number | null;
  sourceSyncedAt: Date;
};

type FwaPlayerCatalogFixture = {
  playerTag: string;
  latestName: string | null;
  latestTownHall: number | null;
};

type TodoPlayerSnapshotFixture = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
};

type PlayerLinkFixture = {
  playerTag: string;
  discordUserId: string | null;
  verificationStatus: "VERIFIED" | "UNVERIFIED" | "REVOKED";
};

type IdentityFixtures = {
  playerCurrent: PlayerCurrentFixture[];
  fwaClanMemberCurrent: FwaClanMemberCurrentFixture[];
  fwaPlayerCatalog: FwaPlayerCatalogFixture[];
  todoPlayerSnapshot: TodoPlayerSnapshotFixture[];
  playerLink: PlayerLinkFixture[];
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

function makePlayerCurrentFixture(input: PlayerCurrentFixture): PlayerCurrentFixture {
  return input;
}

function makeFwaClanMemberCurrentFixture(input: FwaClanMemberCurrentFixture): FwaClanMemberCurrentFixture {
  return input;
}

function makeFwaPlayerCatalogFixture(input: FwaPlayerCatalogFixture): FwaPlayerCatalogFixture {
  return input;
}

function makeTodoPlayerSnapshotFixture(input: TodoPlayerSnapshotFixture): TodoPlayerSnapshotFixture {
  return input;
}

function makePlayerLinkFixture(input: PlayerLinkFixture): PlayerLinkFixture {
  return input;
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

function matchesInFilter(where: Record<string, unknown> | undefined, playerTag: string): boolean {
  const inValues = (where?.playerTag as { in?: string[] } | undefined)?.in;
  if (!inValues) return true;
  return inValues.map((tag) => normalizeTag(tag)).includes(normalizeTag(playerTag));
}

function compareIdentityRows(
  a: EvaluationFixture,
  b: EvaluationFixture,
  orderBy: Array<Record<string, "asc" | "desc">> | undefined,
): number {
  if (!orderBy?.length) return 0;

  for (const clause of orderBy) {
    const [field, direction] = Object.entries(clause)[0] as [
      keyof EvaluationFixture,
      "asc" | "desc",
    ];
    const aValue = a[field];
    const bValue = b[field];

    let delta = 0;
    if (aValue instanceof Date && bValue instanceof Date) {
      delta = aValue.getTime() - bValue.getTime();
    } else if (typeof aValue === "number" && typeof bValue === "number") {
      delta = aValue - bValue;
    } else {
      delta = String(aValue ?? "").localeCompare(String(bValue ?? ""));
    }

    if (delta !== 0) {
      return direction === "desc" ? -delta : delta;
    }
  }

  return 0;
}

function extractRelationFilter(where: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const relation = where?.warHistory as Record<string, unknown> | undefined;
  if (!relation) return null;
  const nested = relation.is as Record<string, unknown> | undefined;
  return nested ?? relation;
}

function matchesIdentityRelation(
  row: EvaluationFixture,
  where: Record<string, unknown> | undefined,
): boolean {
  const relation = where?.warPlanEvaluations as
    | { some?: { guildId?: string; status?: string } }
    | undefined;
  const some = relation?.some;
  if (!some) return true;
  if (typeof some.guildId === "string" && some.guildId !== row.guildId) return false;
  if (typeof some.status === "string" && some.status !== row.status) return false;
  return true;
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

function buildDb(fixtures: EvaluationFixture[], identity: Partial<IdentityFixtures> = {}) {
  const ordered = [...fixtures].sort(compareFixturesDesc);
  const identityFixtures: IdentityFixtures = {
    playerCurrent: identity.playerCurrent ?? [],
    fwaClanMemberCurrent: identity.fwaClanMemberCurrent ?? [],
    fwaPlayerCatalog: identity.fwaPlayerCatalog ?? [],
    todoPlayerSnapshot: identity.todoPlayerSnapshot ?? [],
    playerLink: identity.playerLink ?? [],
  };

  const db = {
    playerCurrent: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        identityFixtures.playerCurrent.filter((row) => matchesInFilter(args?.where, row.playerTag)),
      ),
    },
    fwaClanMemberCurrent: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        identityFixtures.fwaClanMemberCurrent.filter((row) =>
          matchesInFilter(args?.where, row.playerTag),
        ),
      ),
    },
    fwaPlayerCatalog: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        identityFixtures.fwaPlayerCatalog.filter((row) =>
          matchesInFilter(args?.where, row.playerTag),
        ),
      ),
    },
    todoPlayerSnapshot: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        identityFixtures.todoPlayerSnapshot.filter((row) =>
          matchesInFilter(args?.where, row.playerTag),
        ),
      ),
    },
    playerLink: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
        identityFixtures.playerLink.filter((row) => matchesInFilter(args?.where, row.playerTag)),
      ),
    },
    clanWarHistory: {
      findFirst: vi.fn(async (args?: {
        where?: Record<string, unknown>;
        orderBy?: Array<Record<string, "asc" | "desc">>;
      }) => {
        const clanTag = normalizeTag(args?.where?.clanTag ?? "");
        if (!clanTag) return null;
        const matches = ordered.filter(
          (row) =>
            normalizeTag(row.clanTag) === clanTag && matchesIdentityRelation(row, args?.where),
        );
        const hit = matches.sort((a, b) => compareIdentityRows(a, b, args?.orderBy))[0];
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

function buildService(
  fixtures: EvaluationFixture[],
  identity: Partial<IdentityFixtures> = {},
) {
  const db = buildDb(fixtures, identity);
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
      distinctCurrentDiscordUserCount: 0,
      hasCompletedEvaluations: true,
    });
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#2QG2C08UP",
        playerName: "Inside Window",
        townHallLevel: 16,
        discordUserId: null,
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
      warPlanEvaluations?: { some?: { guildId?: string; status?: string } };
    };
    const queryWhere = db.warPlanComplianceEvaluation.findMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;

    expect(identityWhere.clanTag).toBe("#2QG2C08UP");
    expect(identityWhere.warPlanEvaluations).toEqual({
      some: {
        guildId: "guild-1",
        status: "COMPLETED",
      },
    });
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
        playerName: "Alpha One",
        townHallLevel: 16,
        discordUserId: null,
      }),
    ]);
  });

  it("returns not_found when the clan is only completed under a different guild", async () => {
    const { db, service } = buildService([
      buildFixture({
        guildId: "guild-b",
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
    ]);

    const result = await service.getClanLeaderboard({
      guildId: "guild-a",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.clanWarHistory.findFirst).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      outcome: "not_found",
      clanTag: "#2QG2C08UP",
      clanName: null,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      players: [],
      hasCompletedEvaluations: false,
    });
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
      buildFixture({
        warId: 2,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha Latest",
        warStartTime: d("2026-04-02T00:00:00.000Z"),
        warEndTime: d("2026-04-02T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#G2R9RQLJQ",
            playerNameSnapshot: "Outside Latest",
            townHallLevelSnapshot: 15,
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
    expect(db.clanWarHistory.findFirst.mock.calls[0]?.[0]?.orderBy).toEqual([
      { warStartTime: "desc" },
      { warId: "desc" },
    ]);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "success",
      clanTag: "#2QG2C08UP",
      clanName: "Alpha Latest",
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
      playerName: "Newer Canonical",
      townHallLevel: 16,
      discordUserId: null,
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
      playerName: "Null Newer",
      townHallLevel: 17,
      discordUserId: null,
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
        playerName: "Alpha Updated",
        townHallLevel: 14,
        discordUserId: null,
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        playerName: "Zulu Updated",
        townHallLevel: 16,
        discordUserId: null,
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#2RVGJYLC0",
        playerName: "Beta",
        townHallLevel: 13,
        discordUserId: null,
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
      distinctCurrentDiscordUserCount: 0,
      clanSummaries: [],
      topPlayers: [],
      hasCompletedEvaluations: false,
      trackingSince: null,
    });
  });

  it("counts only violating clans in distinctClanCount while preserving zero-violation coverage", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Violating Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Violator",
            townHallLevelSnapshot: 16,
          },
        ],
      }),
      buildFixture({
        warId: 2,
        clanTag: "#G2R9RQLJQ",
        clanName: "Clean Beta",
        warStartTime: d("2026-05-11T00:00:00.000Z"),
        warEndTime: d("2026-05-11T01:00:00.000Z"),
        violations: [],
      }),
    ]);

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 2,
      affectedWarCount: 1,
      violationCount: 1,
      distinctPlayerCount: 1,
      distinctClanCount: 1,
      distinctCurrentDiscordUserCount: 0,
      hasCompletedEvaluations: true,
    });
    expect(result.clanSummaries).toHaveLength(1);
    expect(result.clanSummaries[0]).toMatchObject({
      clanTag: "#2QG2C08UP",
      clanName: "Violating Alpha",
      evaluatedWarCount: 1,
      affectedWarCount: 1,
      violationCount: 1,
      distinctPlayerCount: 1,
    });
  });

  it("prefers PlayerCurrent name and Town Hall over violation snapshots", async () => {
    const { db, service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
            townHall: 17,
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "Current Alpha",
      townHallLevel: 17,
      discordUserId: null,
      violationCount: 1,
      affectedWarCount: 1,
    });
  });

  it("uses FwaClanMemberCurrent townHall when PlayerCurrent lacks it", async () => {
    const { db, service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#PYLQ0289",
            playerName: "Current Alpha",
            townHall: null,
          }),
        ],
        fwaClanMemberCurrent: [
          makeFwaClanMemberCurrentFixture({
            playerTag: "#PYLQ0289",
            clanTag: "#CURR1",
            townHall: 16,
            sourceSyncedAt: d("2026-05-09T00:00:00.000Z"),
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "Current Alpha",
      townHallLevel: 16,
      discordUserId: null,
    });
  });

  it("selects the newest FWA member row deterministically by sync time and clan tag", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: null,
              townHallLevelSnapshot: null,
            },
          ],
        }),
      ],
      {
        fwaClanMemberCurrent: [
          makeFwaClanMemberCurrentFixture({
            playerTag: "#PYLQ0289",
            clanTag: "#BBB222",
            townHall: 17,
            sourceSyncedAt: d("2026-05-09T00:00:00.000Z"),
          }),
          makeFwaClanMemberCurrentFixture({
            playerTag: "#PYLQ0289",
            clanTag: "#AAA111",
            townHall: 16,
            sourceSyncedAt: d("2026-05-09T00:00:00.000Z"),
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "#PYLQ0289",
      townHallLevel: 16,
      discordUserId: null,
    });
  });

  it("uses FwaPlayerCatalog for missing name and Town Hall", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#PYLQ0289",
            playerName: null,
            townHall: null,
          }),
        ],
        fwaPlayerCatalog: [
          makeFwaPlayerCatalogFixture({
            playerTag: "#PYLQ0289",
            latestName: "Catalog Alpha",
            latestTownHall: 15,
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "Catalog Alpha",
      townHallLevel: 15,
      discordUserId: null,
    });
  });

  it("uses TodoPlayerSnapshot after higher-priority sources are missing", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#PYLQ0289",
            playerName: null,
            townHall: null,
          }),
        ],
        fwaPlayerCatalog: [
          makeFwaPlayerCatalogFixture({
            playerTag: "#PYLQ0289",
            latestName: null,
            latestTownHall: null,
          }),
        ],
        todoPlayerSnapshot: [
          makeTodoPlayerSnapshotFixture({
            playerTag: "#PYLQ0289",
            playerName: "Todo Alpha",
            townHall: 14,
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "Todo Alpha",
      townHallLevel: 14,
      discordUserId: null,
    });
  });

  it("uses the newest canonical violation name when present", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Older Name",
            townHallLevelSnapshot: 18,
          },
        ],
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
            playerNameSnapshot: "Newest Name",
            townHallLevelSnapshot: null,
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

    expect(result.players).toEqual([
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        playerName: "Newest Name",
        townHallLevel: 18,
        discordUserId: null,
        violationCount: 2,
        affectedWarCount: 2,
      }),
    ]);
  });

  it("falls back to the player tag when the newest canonical violation name is null", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Older Name",
            townHallLevelSnapshot: 18,
          },
        ],
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
            playerNameSnapshot: null,
            townHallLevelSnapshot: null,
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

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "#PYLQ0289",
      townHallLevel: 18,
      discordUserId: null,
    });
  });

  it("falls back to the player tag when the newest canonical violation name is blank or whitespace", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Older Name",
            townHallLevelSnapshot: 18,
          },
        ],
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
            playerNameSnapshot: "   ",
            townHallLevelSnapshot: null,
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

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "#PYLQ0289",
      townHallLevel: 18,
      discordUserId: null,
    });
  });

  it("continues to use the newest non-null Town Hall snapshot even when the newest name is absent", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Older Name",
            townHallLevelSnapshot: 18,
          },
        ],
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
            playerNameSnapshot: null,
            townHallLevelSnapshot: null,
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

    expect(result.players[0]).toMatchObject({
      playerTag: "#PYLQ0289",
      playerName: "#PYLQ0289",
      townHallLevel: 18,
      discordUserId: null,
    });
  });

  it("still lets PlayerCurrent, catalog, and Todo names override an absent newest violation name", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAA111",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 12,
            },
            {
              playerTag: "#BBB222",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 13,
            },
            {
              playerTag: "#CCC333",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 14,
            },
          ],
        }),
        buildFixture({
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAA111",
              playerNameSnapshot: "Older Alpha",
              townHallLevelSnapshot: null,
            },
            {
              playerTag: "#BBB222",
              playerNameSnapshot: "Older Bravo",
              townHallLevelSnapshot: null,
            },
            {
              playerTag: "#CCC333",
              playerNameSnapshot: "Older Charlie",
              townHallLevelSnapshot: null,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#AAA111",
            playerName: "Current Alpha",
            townHall: null,
          }),
        ],
        fwaPlayerCatalog: [
          makeFwaPlayerCatalogFixture({
            playerTag: "#BBB222",
            latestName: "Catalog Bravo",
            latestTownHall: null,
          }),
        ],
        todoPlayerSnapshot: [
          makeTodoPlayerSnapshotFixture({
            playerTag: "#CCC333",
            playerName: "Todo Charlie",
            townHall: null,
          }),
        ],
      },
    );

    const result = await service.getClanLeaderboard({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(
      result.players.map((row) => ({ playerTag: row.playerTag, playerName: row.playerName })),
    ).toEqual([
      { playerTag: "#BBB222", playerName: "Catalog Bravo" },
      { playerTag: "#AAA111", playerName: "Current Alpha" },
      { playerTag: "#CCC333", playerName: "Todo Charlie" },
    ]);
  });

  it("sorts players using the resolved name and tag fallback after the newest violation name is absent", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAAAAA",
              playerNameSnapshot: "Older Alpha",
              townHallLevelSnapshot: null,
            },
            {
              playerTag: "#BBBBBB",
              playerNameSnapshot: "Older Bravo",
              townHallLevelSnapshot: null,
            },
            {
              playerTag: "#CCCCCC",
              playerNameSnapshot: "Older Charlie",
              townHallLevelSnapshot: null,
            },
          ],
        }),
        buildFixture({
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAAAAA",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#BBBBBB",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#CCCCCC",
              playerNameSnapshot: null,
              townHallLevelSnapshot: 14,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({
            playerTag: "#AAAAAA",
            playerName: "Bravo",
            townHall: 16,
          }),
        ],
        todoPlayerSnapshot: [
          makeTodoPlayerSnapshotFixture({
            playerTag: "#CCCCCC",
            playerName: "Alpha",
            townHall: 14,
          }),
        ],
      },
    );

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.topPlayers.map((row) => row.playerTag)).toEqual([
      "#BBBBBB",
      "#CCCCCC",
      "#AAAAAA",
    ]);
    expect(result.topPlayers.map((row) => row.playerName)).toEqual([
      "#BBBBBB",
      "Alpha",
      "Bravo",
    ]);
  });

  it("falls back to the newest canonical violation snapshots and normalized tags", async () => {
    const { service } = buildService([
      buildFixture({
        warId: 1,
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        violations: [
          {
            playerTag: "#PYLQ0289",
            playerNameSnapshot: "Older Name",
            townHallLevelSnapshot: null,
          },
        ],
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
            playerNameSnapshot: null,
            townHallLevelSnapshot: 18,
          },
          {
            playerTag: "#2RVGJYLC0",
            playerNameSnapshot: null,
            townHallLevelSnapshot: null,
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

    expect(result.players).toEqual([
      expect.objectContaining({
        playerTag: "#PYLQ0289",
        playerName: "#PYLQ0289",
        townHallLevel: 18,
        discordUserId: null,
        violationCount: 2,
        affectedWarCount: 2,
      }),
      expect.objectContaining({
        playerTag: "#2RVGJYLC0",
        playerName: "#2RVGJYLC0",
        townHallLevel: null,
        discordUserId: null,
        violationCount: 1,
        affectedWarCount: 1,
      }),
    ]);
  });

  it("attributes current PlayerLink owners and deduplicates distinct Discord users", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAA111",
              playerNameSnapshot: "Alpha Snapshot",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#BBB222",
              playerNameSnapshot: "Bravo Snapshot",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#CCC333",
              playerNameSnapshot: "Charlie Snapshot",
              townHallLevelSnapshot: 14,
            },
            {
              playerTag: "#DDD444",
              playerNameSnapshot: "Delta Snapshot",
              townHallLevelSnapshot: 13,
            },
            {
              playerTag: "#EEE555",
              playerNameSnapshot: "Echo Snapshot",
              townHallLevelSnapshot: 12,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({ playerTag: "#AAA111", playerName: "Alpha", townHall: 16 }),
          makePlayerCurrentFixture({ playerTag: "#BBB222", playerName: "Bravo", townHall: 15 }),
          makePlayerCurrentFixture({ playerTag: "#CCC333", playerName: "Charlie", townHall: 14 }),
          makePlayerCurrentFixture({ playerTag: "#DDD444", playerName: "Delta", townHall: 13 }),
          makePlayerCurrentFixture({ playerTag: "#EEE555", playerName: "Echo", townHall: 12 }),
        ],
        playerLink: [
          makePlayerLinkFixture({
            playerTag: "#AAA111",
            discordUserId: "111111111111111111",
            verificationStatus: "VERIFIED",
          }),
          makePlayerLinkFixture({
            playerTag: "#BBB222",
            discordUserId: "111111111111111111",
            verificationStatus: "UNVERIFIED",
          }),
          makePlayerLinkFixture({
            playerTag: "#CCC333",
            discordUserId: "222222222222222222",
            verificationStatus: "REVOKED",
          }),
          makePlayerLinkFixture({
            playerTag: "#EEE555",
            discordUserId: "333333333333333333",
            verificationStatus: "VERIFIED",
          }),
        ],
      },
    );

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.distinctCurrentDiscordUserCount).toBe(2);
    expect(result.topPlayers).toEqual([
      expect.objectContaining({
        playerTag: "#AAA111",
        playerName: "Alpha",
        discordUserId: "111111111111111111",
      }),
      expect.objectContaining({
        playerTag: "#BBB222",
        playerName: "Bravo",
        discordUserId: "111111111111111111",
      }),
      expect.objectContaining({
        playerTag: "#CCC333",
        playerName: "Charlie",
        discordUserId: null,
      }),
      expect.objectContaining({
        playerTag: "#DDD444",
        playerName: "Delta",
        discordUserId: null,
      }),
      expect.objectContaining({
        playerTag: "#EEE555",
        playerName: "Echo",
        discordUserId: "333333333333333333",
      }),
    ]);
  });

  it("keeps player ordering stable after identity enrichment", async () => {
    const { service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAAAAA",
              playerNameSnapshot: "Zulu Snapshot",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#BBBBBB",
              playerNameSnapshot: "Alpha Snapshot",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#CCCCCC",
              playerNameSnapshot: "Beta Snapshot",
              townHallLevelSnapshot: 14,
            },
          ],
        }),
        buildFixture({
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAAAAA",
              playerNameSnapshot: "Zulu Updated",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#BBBBBB",
              playerNameSnapshot: "Alpha Updated",
              townHallLevelSnapshot: 15,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({ playerTag: "#AAAAAA", playerName: "Zulu", townHall: 16 }),
          makePlayerCurrentFixture({ playerTag: "#BBBBBB", playerName: "Alpha", townHall: 15 }),
          makePlayerCurrentFixture({ playerTag: "#CCCCCC", playerName: "Beta", townHall: 14 }),
        ],
      },
    );

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(result.topPlayers.map((row) => row.playerTag)).toEqual([
      "#BBBBBB",
      "#AAAAAA",
      "#CCCCCC",
    ]);
    expect(result.topPlayers.map((row) => row.playerName)).toEqual(["Alpha", "Zulu", "Beta"]);
  });

  it("performs one bulk identity query per source and skips nothing for violating tags", async () => {
    const { db, service } = buildService(
      [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#AAAAAA",
              playerNameSnapshot: "Alpha Snapshot",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#BBBBBB",
              playerNameSnapshot: "Bravo Snapshot",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#CCCCCC",
              playerNameSnapshot: "Charlie Snapshot",
              townHallLevelSnapshot: 14,
            },
          ],
        }),
      ],
      {
        playerCurrent: [
          makePlayerCurrentFixture({ playerTag: "#AAAAAA", playerName: "Alpha", townHall: 16 }),
        ],
        fwaClanMemberCurrent: [
          makeFwaClanMemberCurrentFixture({
            playerTag: "#BBBBBB",
            clanTag: "#CURR1",
            townHall: 15,
            sourceSyncedAt: d("2026-05-09T00:00:00.000Z"),
          }),
        ],
        fwaPlayerCatalog: [
          makeFwaPlayerCatalogFixture({
            playerTag: "#CCCCCC",
            latestName: "Catalog Charlie",
            latestTownHall: 14,
          }),
        ],
        todoPlayerSnapshot: [
          makeTodoPlayerSnapshotFixture({
            playerTag: "#AAAAAA",
            playerName: "Todo Alpha",
            townHall: 16,
          }),
        ],
        playerLink: [
          makePlayerLinkFixture({
            playerTag: "#AAAAAA",
            discordUserId: "111111111111111111",
            verificationStatus: "VERIFIED",
          }),
        ],
      },
    );

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.playerCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
    expect(db.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
    expect(db.todoPlayerSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(db.playerLink.findMany).toHaveBeenCalledTimes(1);
    expect((db.playerCurrent.findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>).playerTag).toEqual({
      in: ["#AAAAAA", "#BBBBBB", "#CCCCCC"],
    });
    expect((db.playerLink.findMany.mock.calls[0]?.[0]?.where as Record<string, unknown>).playerTag).toEqual({
      in: ["#AAAAAA", "#BBBBBB", "#CCCCCC"],
    });
    expect(result.topPlayers).toHaveLength(3);
  });

  it("skips identity and PlayerLink queries when there are no violating player tags", async () => {
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

    const result = await service.getAllianceOverview({
      guildId: "guild-1",
      period: "lifetime",
      now: d("2026-06-01T00:00:00.000Z"),
    });

    expect(db.playerCurrent.findMany).not.toHaveBeenCalled();
    expect(db.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
    expect(db.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
    expect(db.todoPlayerSnapshot.findMany).not.toHaveBeenCalled();
    expect(db.playerLink.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "success",
      evaluatedWarCount: 1,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      distinctClanCount: 0,
      distinctCurrentDiscordUserCount: 0,
      clanSummaries: [],
      topPlayers: [],
      hasCompletedEvaluations: true,
    });
  });
});
