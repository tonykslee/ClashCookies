import { describe, expect, it, vi } from "vitest";
import { normalizeClashTagInput } from "../src/helper/clashTag";
import { normalizeDiscordUserId } from "../src/services/PlayerLinkService";
import { WarPlanViolationHistoryService } from "../src/services/WarPlanViolationHistoryService";

type ViolationFixture = {
  id?: string;
  playerTag: string;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
  playerPosition?: number | null;
  violationType?: string;
  reasonLabel?: string | null;
  expectedBehavior?: string;
  actualBehavior?: string;
  breachStarsAt?: number | null;
  breachTimeRemaining?: string | null;
  attackDetails?: unknown;
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
  expectedOutcome?: string | null;
  loseStyle?: string | null;
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

function makeAutocompleteTag(index: number): string {
  const chars = "PYLQGRJCUV0289";
  const first = chars[index % chars.length] ?? "P";
  const second = chars[Math.floor(index / chars.length) % chars.length] ?? "Y";
  return `#2QG2C08${first}${second}`;
}

function makeLongPlayerName(prefix: string): string {
  return `${prefix} ${"X".repeat(120)}`;
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

function compareViolationRowsForDistinct(
  a: BuiltViolationRow,
  b: BuiltViolationRow,
  orderBy: Array<Record<string, "asc" | "desc">> | undefined,
): number {
  if (!orderBy?.length) return 0;

  for (const clause of orderBy) {
    const [field, direction] = Object.entries(clause)[0] as [string, "asc" | "desc"];
    let delta = 0;
    if (field === "playerTag") {
      delta = normalizeTag(a.playerTag).localeCompare(normalizeTag(b.playerTag));
    } else if (field === "id") {
      delta = String(a.id).localeCompare(String(b.id));
    } else if (field === "evaluation") {
      const evaluationOrder = clause.evaluation as
        | { warHistory?: Record<string, "asc" | "desc"> }
        | undefined;
      const historyOrder = evaluationOrder?.warHistory;
      if (historyOrder?.warEndTime) {
        const aTime = a.evaluation.warHistory.warEndTime?.getTime() ?? Number.NEGATIVE_INFINITY;
        const bTime = b.evaluation.warHistory.warEndTime?.getTime() ?? Number.NEGATIVE_INFINITY;
        delta = aTime - bTime;
      } else if (historyOrder?.warStartTime) {
        delta = a.evaluation.warHistory.warStartTime.getTime() - b.evaluation.warHistory.warStartTime.getTime();
      } else if (historyOrder?.warId) {
        delta = a.evaluation.warHistory.warId - b.evaluation.warHistory.warId;
      }
    } else {
      delta = String((a as Record<string, unknown>)[field] ?? "").localeCompare(
        String((b as Record<string, unknown>)[field] ?? ""),
      );
    }

    if (delta !== 0) {
      return direction === "desc" ? -delta : delta;
    }
  }

  return 0;
}

function applyViolationDistinct(rows: BuiltViolationRow[], args?: { distinct?: string[]; orderBy?: Array<Record<string, "asc" | "desc">>; take?: number }): BuiltViolationRow[] {
  let ordered = [...rows];
  if (args?.orderBy?.length) {
    ordered.sort((a, b) => compareViolationRowsForDistinct(a, b, args.orderBy));
  }

  if (args?.distinct?.includes("playerTag")) {
    const seen = new Set<string>();
    ordered = ordered.filter((row) => {
      const tag = normalizeTag(row.playerTag);
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
  }

  if (typeof args?.take === "number" && Number.isFinite(args.take)) {
    ordered = ordered.slice(0, Math.max(0, Math.trunc(args.take)));
  }

  return ordered;
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

type BuiltViolationRow = {
  id: string;
  evaluationId: string;
  guildId: string;
  status: string;
  playerTag: string;
  playerNameSnapshot: string | null;
  playerPosition: number | null;
  townHallLevelSnapshot: number | null;
  violationType: string;
  reasonLabel: string | null;
  expectedBehavior: string;
  actualBehavior: string;
  breachStarsAt: number | null;
  breachTimeRemaining: string | null;
  attackDetails: unknown;
  evaluation: {
    id: string;
    expectedOutcome: string | null;
    loseStyle: string | null;
    warHistory: {
      warId: number;
      clanTag: string;
      clanName: string | null;
      opponentTag: string | null;
      opponentName: string | null;
      warStartTime: Date;
      warEndTime: Date | null;
    };
  };
};

function buildViolationRows(fixtures: EvaluationFixture[]): BuiltViolationRow[] {
  return fixtures.flatMap((evaluation) =>
    evaluation.violations.map((violation, index) => {
      const evaluationId = `eval-${evaluation.guildId}-${evaluation.warId}`;
      return {
        id: violation.id ?? `vio-${evaluation.warId}-${index + 1}`,
        evaluationId,
        guildId: evaluation.guildId,
        status: evaluation.status ?? "COMPLETED",
        playerTag: violation.playerTag,
        playerNameSnapshot: violation.playerNameSnapshot,
        playerPosition: violation.playerPosition ?? null,
        townHallLevelSnapshot: violation.townHallLevelSnapshot,
        violationType: violation.violationType ?? "OTHER_PLAN_VIOLATION",
        reasonLabel: violation.reasonLabel ?? null,
        expectedBehavior: violation.expectedBehavior ?? "expected",
        actualBehavior: violation.actualBehavior ?? "actual",
        breachStarsAt: violation.breachStarsAt ?? null,
        breachTimeRemaining: violation.breachTimeRemaining ?? null,
        attackDetails: violation.attackDetails ?? null,
        evaluation: {
          id: evaluationId,
          expectedOutcome: evaluation.expectedOutcome ?? null,
          loseStyle: evaluation.loseStyle ?? null,
          warHistory: {
            warId: evaluation.warId,
            clanTag: evaluation.clanTag,
            clanName: evaluation.clanName,
            opponentTag: null,
            opponentName: null,
            warStartTime: evaluation.warStartTime,
            warEndTime: evaluation.warEndTime,
          },
        },
      };
    }),
  );
}

function extractRelationFilter(where: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const relation = where?.warHistory as Record<string, unknown> | undefined;
  if (!relation) return null;
  const nested = relation.is as Record<string, unknown> | undefined;
  return nested ?? relation;
}

function matchesViolationEvaluationRelation(
  row: BuiltViolationRow,
  where: Record<string, unknown> | undefined,
): boolean {
  const relation = where?.evaluation as
    | { is?: { guildId?: string; status?: string; warHistory?: Record<string, unknown> } }
    | undefined;
  const nested = relation?.is;
  if (!nested) return true;
  if (typeof nested.guildId === "string" && nested.guildId !== row.guildId) return false;
  if (typeof nested.status === "string" && nested.status !== row.status) return false;
  const history = nested.warHistory as Record<string, unknown> | undefined;
  if (!history) return true;
  const nestedHistory = (history as { is?: Record<string, unknown> }).is ?? history;
  const warEndTimeFilter = nestedHistory.warEndTime as
    | { gte?: Date; not?: null | Date }
    | Date
    | null
    | undefined;
  if (warEndTimeFilter === null) {
    if (row.evaluation.warHistory.warEndTime !== null) return false;
  } else if (typeof warEndTimeFilter === "object") {
    const gte = warEndTimeFilter.gte;
    if (gte instanceof Date) {
      if (!(row.evaluation.warHistory.warEndTime instanceof Date)) return false;
      if (row.evaluation.warHistory.warEndTime.getTime() < gte.getTime()) return false;
    }
    if (Object.prototype.hasOwnProperty.call(warEndTimeFilter, "not")) {
      if (warEndTimeFilter.not === null) {
        if (row.evaluation.warHistory.warEndTime === null) return false;
      } else if (warEndTimeFilter.not instanceof Date) {
        if (row.evaluation.warHistory.warEndTime instanceof Date && row.evaluation.warHistory.warEndTime.getTime() === warEndTimeFilter.not.getTime()) {
          return false;
        }
      }
    }
  }
  if (typeof nestedHistory.clanTag === "string" && normalizeTag(nestedHistory.clanTag) !== normalizeTag(row.evaluation.warHistory.clanTag)) {
    return false;
  }
  return true;
}

function matchesViolationWhere(
  row: BuiltViolationRow,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  const playerTagFilter = where.playerTag as
    | string
    | { in?: string[] }
    | undefined;
  if (typeof playerTagFilter === "string") {
    if (normalizeTag(playerTagFilter) !== normalizeTag(row.playerTag)) return false;
  } else if (playerTagFilter && Array.isArray(playerTagFilter.in)) {
    const allowedTags = playerTagFilter.in.map((tag) => normalizeTag(tag)).filter(Boolean);
    if (!allowedTags.includes(normalizeTag(row.playerTag))) return false;
  }
  return matchesViolationEvaluationRelation(row, where);
}

function matchesPlayerLinkWhere(
  row: PlayerLinkFixture,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;

  const normalizedRowTag = normalizeTag(row.playerTag);
  const playerTagFilter = where.playerTag as
    | string
    | { in?: string[] }
    | undefined;
  if (typeof playerTagFilter === "string") {
    if (normalizeTag(playerTagFilter) !== normalizedRowTag) return false;
  } else if (playerTagFilter && Array.isArray(playerTagFilter.in)) {
    const allowedTags = playerTagFilter.in.map((tag) => normalizeTag(tag)).filter(Boolean);
    if (!allowedTags.includes(normalizedRowTag)) return false;
  }

  const discordUserIdFilter = where.discordUserId as
    | string
    | { not?: string | null }
    | undefined;
  if (typeof discordUserIdFilter === "string") {
    if (normalizeDiscordUserId(discordUserIdFilter) !== normalizeDiscordUserId(row.discordUserId)) return false;
  } else if (discordUserIdFilter && Object.prototype.hasOwnProperty.call(discordUserIdFilter, "not")) {
    const notValue = normalizeDiscordUserId(discordUserIdFilter.not);
    if (notValue !== undefined && notValue === normalizeDiscordUserId(row.discordUserId)) return false;
    if (discordUserIdFilter.not === null && row.discordUserId === null) return false;
  }

  const verificationStatusFilter = where.verificationStatus as
    | string
    | { not?: string }
    | undefined;
  if (typeof verificationStatusFilter === "string") {
    if (verificationStatusFilter !== row.verificationStatus) return false;
  } else if (verificationStatusFilter && typeof verificationStatusFilter.not === "string") {
    if (row.verificationStatus === verificationStatusFilter.not) return false;
  }

  return true;
}

function projectViolationRow(row: BuiltViolationRow, select: Record<string, unknown> | undefined) {
  if (!select) return row;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(select)) {
    if (!value) continue;
    if (key === "evaluation" && typeof value === "object") {
      const evaluationSelect = value as { select?: Record<string, unknown> };
      const evaluationResult: Record<string, unknown> = {};
      const evaluationRow = row.evaluation;
      for (const [evaluationKey, evaluationValue] of Object.entries(evaluationSelect.select ?? {})) {
        if (!evaluationValue) continue;
        if (evaluationKey === "warHistory" && typeof evaluationValue === "object") {
          const historySelect = evaluationValue as { select?: Record<string, unknown> };
          const historyResult: Record<string, unknown> = {};
          for (const [historyKey, historyValue] of Object.entries(historySelect.select ?? {})) {
            if (!historyValue) continue;
            historyResult[historyKey] = (evaluationRow.warHistory as Record<string, unknown>)[historyKey];
          }
          evaluationResult.warHistory = historyResult;
          continue;
        }
        evaluationResult[evaluationKey] = (evaluationRow as Record<string, unknown>)[evaluationKey];
      }
      result[key] = evaluationResult;
      continue;
    }
    result[key] = (row as Record<string, unknown>)[key];
  }
  return result;
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
  const violationRows = buildViolationRows(ordered);
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
        identityFixtures.playerLink.filter((row) => matchesPlayerLinkWhere(row, args?.where)),
      ),
    },
    warPlanViolation: {
      findMany: vi.fn(async (args?: {
        where?: Record<string, unknown>;
        select?: Record<string, unknown>;
        distinct?: string[];
        orderBy?: Array<Record<string, "asc" | "desc">>;
        take?: number;
      }) =>
        applyViolationDistinct(
          violationRows.filter((row) => matchesViolationWhere(row, args?.where)),
          args,
        ).map((row) => projectViolationRow(row, args?.select)),
      ),
      findFirst: vi.fn(async (args?: {
        where?: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) => {
        const hit = violationRows.find((row) => matchesViolationWhere(row, args?.where));
        return hit ? projectViolationRow(hit, args?.select) : null;
      }),
      groupBy: vi.fn(async (args?: {
        by?: string[];
        where?: Record<string, unknown>;
        _count?: { _all?: boolean };
      }) => {
        const grouped = new Map<string, number>();
        for (const row of violationRows.filter((entry) => matchesViolationWhere(entry, args?.where))) {
          const tag = normalizeTag(row.playerTag);
          if (!tag) continue;
          grouped.set(tag, (grouped.get(tag) ?? 0) + 1);
        }
        return [...grouped.entries()]
          .map(([playerTag, count]) => ({
            playerTag,
            _count: { _all: count },
          }))
          .sort((a, b) => a.playerTag.localeCompare(b.playerTag));
      }),
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

  describe("getPlayerHistory", () => {
    it("returns invalid_tag without database reads", async () => {
      const { db, service } = buildService([]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "not-a-tag",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.outcome).toBe("invalid_tag");
      expect(db.warPlanViolation.findMany).not.toHaveBeenCalled();
      expect(db.warPlanViolation.findFirst).not.toHaveBeenCalled();
      expect(db.warPlanComplianceEvaluation.findMany).not.toHaveBeenCalled();
      expect(db.playerCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
      expect(db.todoPlayerSnapshot.findMany).not.toHaveBeenCalled();
      expect(db.playerLink.findMany).not.toHaveBeenCalled();
    });

    it("keeps guild isolation and completed-evaluation filtering", async () => {
      const { db, service } = buildService([
        buildFixture({
          guildId: "guild-a",
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          status: "FAILED",
          violations: [
            {
              id: "vio-a",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Alpha One",
              townHallLevelSnapshot: 16,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
        buildFixture({
          guildId: "guild-b",
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Beta",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              id: "vio-b",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Beta One",
              townHallLevelSnapshot: 17,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-a",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(1);
      expect(db.warPlanViolation.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
        playerTag: "#PYLQ0289",
        evaluation: {
          is: {
            guildId: "guild-a",
            status: "COMPLETED",
          },
        },
      });
      expect(db.warPlanViolation.findFirst).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe("not_found");
      expect(result.playerTag).toBe("#PYLQ0289");
    });

    it("pushes the exact canonical 30-day cutoff into Prisma", async () => {
      const now = d("2026-06-01T00:00:00.000Z");
      const { db, service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Alpha One",
              townHallLevelSnapshot: 16,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "30d",
        now,
      });

      const where = db.warPlanViolation.findMany.mock.calls[0]?.[0]?.where as {
        evaluation?: { is?: { warHistory?: { is?: { warEndTime?: { gte?: Date } } } } };
      };
      const cutoff = where.evaluation?.is?.warHistory?.is?.warEndTime?.gte;

      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(1);
      expect(cutoff).toBe(result.cutoff);
      expect(result.cutoff).toBe(cutoff);
      expect(result.outcome).toBe("success");
      expect(result.hasViolationsInPeriod).toBe(true);
    });

    it("excludes null-ended wars from 30d but includes them in lifetime", async () => {
      const fixtures = [
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-30T23:00:00.000Z"),
          warEndTime: d("2026-05-31T01:00:00.000Z"),
          violations: [
            {
              id: "vio-ended",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Ended",
              townHallLevelSnapshot: 16,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
        buildFixture({
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-31T23:00:00.000Z"),
          warEndTime: null,
          violations: [
            {
              id: "vio-null",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Null Ended",
              townHallLevelSnapshot: 17,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
      ];

      const thirtyDay = await buildService(fixtures).service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "30d",
        now: d("2026-06-01T00:00:00.000Z"),
      });
      const lifetime = await buildService(fixtures).service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(thirtyDay.outcome).toBe("success");
      expect(thirtyDay.entries).toHaveLength(1);
      expect(thirtyDay.entries[0]?.violationId).toBe("vio-ended");
      expect(lifetime.outcome).toBe("success");
      expect(lifetime.entries.map((entry) => entry.violationId)).toEqual([
        "vio-null",
        "vio-ended",
      ]);
      expect(lifetime.trackingSince).toEqual(d("2026-05-31T01:00:00.000Z"));
    });

    it("sorts entries by canonical war time, war ID, then violation ID", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 10,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              id: "vio-c",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Older",
              townHallLevelSnapshot: 15,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
        buildFixture({
          warId: 20,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          violations: [
            {
              id: "vio-b",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Same War Later",
              townHallLevelSnapshot: 16,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
            {
              id: "vio-a",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Same War Earlier",
              townHallLevelSnapshot: 17,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.entries.map((entry) => entry.violationId)).toEqual([
        "vio-a",
        "vio-b",
        "vio-c",
      ]);
    });

    it("returns populated entry fields and counts", async () => {
      const { service } = buildService(
        [
          buildFixture({
            warId: 1,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-05-10T00:00:00.000Z"),
            warEndTime: d("2026-05-10T01:00:00.000Z"),
            expectedOutcome: "WIN",
            loseStyle: "NONE",
            violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
                playerPosition: 3,
                violationType: "ANY_3STAR",
                reasonLabel: "Reason Alpha",
                expectedBehavior: "Expected Alpha",
                actualBehavior: "Actual Alpha",
                breachStarsAt: 3,
                breachTimeRemaining: "0s",
                attackDetails: {
                  attackDetails: [
                    {
                      defenderPosition: 3,
                      stars: 3,
                      attackOrder: 1,
                      isBreach: true,
                    },
                    {
                      defenderPosition: null,
                      stars: 2,
                      attackOrder: 2,
                      isBreach: false,
                    },
                  ],
                  breachContext: {
                    starsAtBreach: 3,
                    timeRemaining: "0s",
                  },
                },
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
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        outcome: "success",
        playerTag: "#PYLQ0289",
        playerName: "Current Alpha",
        townHallLevel: 17,
        discordUserId: "111111111111111111",
        violationCount: 1,
        affectedWarCount: 1,
        hasRecordedViolations: true,
        hasViolationsInPeriod: true,
      });
      expect(result.entries[0]).toMatchObject({
        violationId: "vio-1",
        evaluationId: "eval-guild-1-1",
        warId: 1,
        warStartTime: d("2026-05-10T00:00:00.000Z"),
        warEndTime: d("2026-05-10T01:00:00.000Z"),
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        opponentTag: "",
        opponentName: null,
        playerNameSnapshot: "Snapshot Alpha",
        townHallLevelSnapshot: 12,
        playerPosition: 3,
        violationType: "ANY_3STAR",
        reasonLabel: "Reason Alpha",
        expectedBehavior: "Expected Alpha",
        actualBehavior: "Actual Alpha",
        breachStarsAt: 3,
        breachTimeRemaining: "0s",
        attackEvidence: {
          attacks: [
            {
              defenderPosition: 3,
              stars: 3,
              attackOrder: 1,
              isBreach: true,
            },
            {
              defenderPosition: null,
              stars: 2,
              attackOrder: 2,
              isBreach: false,
            },
          ],
          breachContext: {
            starsAtBreach: 3,
            timeRemaining: "0s",
          },
        },
      });
    });

    it("returns empty attack evidence for root arrays and primitives", async () => {
      const arrayResult = await buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails: [{ defenderPosition: 1, stars: 3, attackOrder: 1, isBreach: true }],
            },
          ],
        }),
      ]).service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });
      const primitiveResult = await buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails: 42,
            },
          ],
        }),
      ]).service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(arrayResult.entries[0]?.attackEvidence).toEqual({
        attacks: [],
        breachContext: null,
      });
      expect(primitiveResult.entries[0]?.attackEvidence).toEqual({
        attacks: [],
        breachContext: null,
      });
    });

    it("omits invalid nested attack entries rather than replacing them with placeholders", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails: {
                attackDetails: [
                  {
                    defenderPosition: 4,
                    stars: 2,
                    attackOrder: 7,
                    isBreach: true,
                  },
                  "bad-row",
                  null,
                  [1, 2, 3],
                ],
                breachContext: {
                  starsAtBreach: 6,
                  timeRemaining: " 33m left ",
                },
              },
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.entries[0]?.attackEvidence).toEqual({
        attacks: [
          {
            defenderPosition: 4,
            stars: 2,
            attackOrder: 7,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 6,
          timeRemaining: "33m left",
        },
      });
    });

    it("preserves zero stars, truncates finite decimals, and nulls strict-invalid values", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails: {
                attackDetails: [
                  {
                    defenderPosition: 4.9,
                    stars: 0,
                    attackOrder: 2.7,
                    isBreach: true,
                  },
                ],
                breachContext: {
                  starsAtBreach: 5.4,
                  timeRemaining: 123,
                },
              },
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.entries[0]?.attackEvidence).toEqual({
        attacks: [
          {
            defenderPosition: 4,
            stars: 0,
            attackOrder: 2,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 5,
          timeRemaining: null,
        },
      });
    });

    it("keeps a structurally valid empty breachContext as an object with null fields", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails: {
                attackDetails: [],
                breachContext: {},
              },
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.entries[0]?.attackEvidence).toEqual({
        attacks: [],
        breachContext: {
          starsAtBreach: null,
          timeRemaining: null,
        },
      });
    });

    it("does not mutate the original persisted evidence object", async () => {
      const attackDetails = {
        attackDetails: [
          {
            defenderPosition: 4.8,
            stars: 1,
            attackOrder: 2,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 7.1,
          timeRemaining: " 12m left ",
        },
      };
      const snapshot = JSON.parse(JSON.stringify(attackDetails));
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 12,
              attackDetails,
            },
          ],
        }),
      ]);

      await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(attackDetails).toEqual(snapshot);
    });

    it("returns successful empty-period metadata when the player has lifetime violations but none in 30d", async () => {
      const { service } = buildService(
        [
          buildFixture({
            warId: 1,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-04-01T00:00:00.000Z"),
            warEndTime: d("2026-04-01T01:00:00.000Z"),
            violations: [
              {
                id: "vio-1",
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Outside Window",
                townHallLevelSnapshot: 12,
                expectedBehavior: "Expected",
                actualBehavior: "Actual",
                violationType: "OTHER_PLAN_VIOLATION",
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
        },
      );

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "30d",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        outcome: "success",
        playerTag: "#PYLQ0289",
        playerName: "#PYLQ0289",
        townHallLevel: null,
        discordUserId: null,
        violationCount: 0,
        affectedWarCount: 0,
        hasRecordedViolations: true,
        hasViolationsInPeriod: false,
        trackingSince: null,
        entries: [],
      });
    });

    it("returns not_found when the player has no completed violations in the guild", async () => {
      const { service } = buildService([
        buildFixture({
          guildId: "guild-a",
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          status: "FAILED",
          violations: [
            {
              id: "vio-1",
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Alpha One",
              townHallLevelSnapshot: 16,
              expectedBehavior: "Expected",
              actualBehavior: "Actual",
              violationType: "OTHER_PLAN_VIOLATION",
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-a",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.outcome).toBe("not_found");
      expect(result.playerTag).toBe("#PYLQ0289");
    });

    it("returns current identity and PlayerLink ownership", async () => {
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
                id: "vio-1",
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Snapshot Alpha",
                townHallLevelSnapshot: 12,
                expectedBehavior: "Expected",
                actualBehavior: "Actual",
                violationType: "OTHER_PLAN_VIOLATION",
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
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        playerName: "Current Alpha",
        townHallLevel: 17,
        discordUserId: "111111111111111111",
      });
    });

    it("uses the newest violation snapshots when no persisted identity exists", async () => {
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
              townHallLevelSnapshot: 17,
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
              townHallLevelSnapshot: 18,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        playerName: "Newest Name",
        townHallLevel: 18,
      });
      expect(result.entries.map((entry) => entry.playerNameSnapshot)).toEqual([
        "Newest Name",
        "Older Name",
      ]);
    });

    it("falls back to the player tag when the newest violation name is blank", async () => {
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

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        playerName: "#PYLQ0289",
        townHallLevel: 18,
      });
      expect(result.entries.map((entry) => entry.playerNameSnapshot)).toEqual([
        null,
        "Older Name",
      ]);
    });

    it("uses the older non-null Town Hall snapshot when the newest one is absent", async () => {
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

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        playerName: "Newest Name",
        townHallLevel: 18,
      });
    });

    it("performs bounded reads without per-entry queries or state mutations", async () => {
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
                id: "vio-1",
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Snapshot Alpha",
                townHallLevelSnapshot: 12,
                expectedBehavior: "Expected",
                actualBehavior: "Actual",
                violationType: "OTHER_PLAN_VIOLATION",
              },
              {
                id: "vio-2",
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Snapshot Alpha 2",
                townHallLevelSnapshot: 13,
                expectedBehavior: "Expected",
                actualBehavior: "Actual",
                violationType: "OTHER_PLAN_VIOLATION",
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
          fwaPlayerCatalog: [
            makeFwaPlayerCatalogFixture({
              playerTag: "#PYLQ0289",
              latestName: "Catalog Alpha",
              latestTownHall: 18,
            }),
          ],
          todoPlayerSnapshot: [
            makeTodoPlayerSnapshotFixture({
              playerTag: "#PYLQ0289",
              playerName: "Todo Alpha",
              townHall: 19,
            }),
          ],
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getPlayerHistory({
        guildId: "guild-1",
        playerTag: "#PYLQ0289",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(1);
      expect(db.warPlanViolation.findMany.mock.calls[0]?.[0]?.select).toMatchObject({
        attackDetails: true,
      });
      expect(db.warPlanViolation.findFirst).not.toHaveBeenCalled();
      expect(db.playerCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
      expect(db.todoPlayerSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(db.playerLink.findMany).toHaveBeenCalledTimes(1);
      expect(result.entries).toHaveLength(2);
    });
  });

  describe("getDiscordUserAggregate", () => {
    it("returns invalid input outcomes without database reads", async () => {
      const { db, service } = buildService([]);

      await expect(
        service.getDiscordUserAggregate({
          guildId: "guild-1",
          discordUserId: "not-a-user",
          period: "lifetime",
          now: d("2026-06-01T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "invalid_user",
      });

      await expect(
        service.getDiscordUserAggregate({
          guildId: "guild-1",
          discordUserId: "111111111111111111",
          period: "lifetime",
          clanTag: "not-a-tag",
          now: d("2026-06-01T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "invalid_clan",
      });

      expect(db.playerLink.findMany).not.toHaveBeenCalled();
      expect(db.warPlanViolation.findMany).not.toHaveBeenCalled();
      expect(db.playerCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
      expect(db.todoPlayerSnapshot.findMany).not.toHaveBeenCalled();
    });

    it("returns not_found when the Discord user has no current non-revoked links", async () => {
      const { db, service } = buildService([], {
        playerLink: [
          makePlayerLinkFixture({
            playerTag: "#2QG2C08UP",
            discordUserId: "222222222222222222",
            verificationStatus: "VERIFIED",
          }),
        ],
      });

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.outcome).toBe("not_found");
      expect(result.currentLinkedAccountCount).toBe(0);
      expect(db.playerLink.findMany).toHaveBeenCalledTimes(1);
      expect(db.warPlanViolation.findMany).not.toHaveBeenCalled();
      expect(db.playerCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
      expect(db.todoPlayerSnapshot.findMany).not.toHaveBeenCalled();
    });

    it("includes VERIFIED and UNVERIFIED current links while excluding REVOKED rows and other users", async () => {
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
                playerNameSnapshot: "Alpha One",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
        ],
        {
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#2RVGJYLC0",
              discordUserId: "111111111111111111",
              verificationStatus: "UNVERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#8J9PP8GV9",
              discordUserId: "111111111111111111",
              verificationStatus: "REVOKED",
            }),
            makePlayerLinkFixture({
              playerTag: "#3GQ2C0R9Q",
              discordUserId: "222222222222222222",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        outcome: "success",
        currentLinkedAccountCount: 2,
        violatingAccountCount: 1,
        violationCount: 1,
        affectedWarCount: 1,
        hasViolationsInPeriod: true,
      });
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts.map((row) => row.playerTag)).toEqual([
        "#PYLQ0289",
        "#2RVGJYLC0",
      ]);
      expect(result.accounts.find((row) => row.playerTag === "#2RVGJYLC0")).toMatchObject({
        violationCount: 0,
        affectedWarCount: 0,
      });
    });

    it("applies guild, COMPLETED, 30-day, and historical clan filters", async () => {
      const now = d("2026-06-01T00:00:00.000Z");
      const { db, service } = buildService(
        [
          buildFixture({
            guildId: "guild-1",
            warId: 1,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-05-20T00:00:00.000Z"),
            warEndTime: d("2026-05-20T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Inside Range",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
          buildFixture({
            guildId: "guild-1",
            warId: 2,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-04-01T00:00:00.000Z"),
            warEndTime: d("2026-04-01T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Outside Range",
                townHallLevelSnapshot: 15,
              },
            ],
          }),
          buildFixture({
            guildId: "guild-1",
            warId: 3,
            clanTag: "#8J9PP8GV9",
            clanName: "Beta",
            warStartTime: d("2026-05-21T00:00:00.000Z"),
            warEndTime: d("2026-05-21T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Wrong Clan",
                townHallLevelSnapshot: 14,
              },
            ],
          }),
          buildFixture({
            guildId: "guild-2",
            warId: 4,
            clanTag: "#2QG2C08UP",
            clanName: "Gamma",
            warStartTime: d("2026-05-22T00:00:00.000Z"),
            warEndTime: d("2026-05-22T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Wrong Guild",
                townHallLevelSnapshot: 13,
              },
            ],
          }),
        ],
        {
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "30d",
        clanTag: "#2QG2C08UP",
        now,
      });

      const where = db.warPlanViolation.findMany.mock.calls[0]?.[0]?.where as Record<
        string,
        unknown
      >;
      expect(where).toMatchObject({
        playerTag: {
          in: ["#PYLQ0289"],
        },
        evaluation: {
          is: {
            guildId: "guild-1",
            status: "COMPLETED",
            warHistory: {
              is: {
                clanTag: "#2QG2C08UP",
                warEndTime: {
                  gte: result.cutoff,
                },
              },
            },
          },
        },
      });
      expect(result).toMatchObject({
        outcome: "success",
        violationCount: 1,
        affectedWarCount: 1,
        currentLinkedAccountCount: 1,
        violatingAccountCount: 1,
        hasViolationsInPeriod: true,
      });
    });

    it("returns every current linked account, including zero-violation accounts", async () => {
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
                playerNameSnapshot: "Alpha One",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
        ],
        {
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#2RVGJYLC0",
              discordUserId: "111111111111111111",
              verificationStatus: "UNVERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#8J9PP8GV9",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result.currentLinkedAccountCount).toBe(3);
      expect(result.accounts).toHaveLength(3);
      expect(result.accounts.filter((row) => row.violationCount === 0)).toHaveLength(2);
      expect(result.accounts.some((row) => row.playerTag === "#2RVGJYLC0")).toBe(true);
      expect(result.accounts.some((row) => row.playerTag === "#8J9PP8GV9")).toBe(true);
    });

    it("follows the current owner for relinked accounts", async () => {
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
                playerNameSnapshot: "Relinked Player",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
        ],
        {
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "222222222222222222",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const oldOwner = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });
      const newOwner = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "222222222222222222",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(oldOwner.outcome).toBe("not_found");
      expect(newOwner).toMatchObject({
        outcome: "success",
        currentLinkedAccountCount: 1,
        violatingAccountCount: 1,
        violationCount: 1,
        affectedWarCount: 1,
      });
      expect(newOwner.accounts).toEqual([
        expect.objectContaining({
          playerTag: "#PYLQ0289",
          violationCount: 1,
        }),
      ]);
    });

    it("keeps canonical snapshot fallback and current identity precedence while sorting deterministically", async () => {
      const { service } = buildService(
        [
          buildFixture({
            warId: 100,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-05-10T00:00:00.000Z"),
            warEndTime: d("2026-05-10T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Older Alpha",
                townHallLevelSnapshot: 15,
              },
              {
                playerTag: "#2RVGJYLC0",
                playerNameSnapshot: "Older Bravo",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
          buildFixture({
            warId: 101,
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
              {
                playerTag: "#2RVGJYLC0",
                playerNameSnapshot: "   ",
                townHallLevelSnapshot: null,
              },
            ],
          }),
        ],
        {
          playerCurrent: [
            makePlayerCurrentFixture({
              playerTag: "#PYLQ0289",
              playerName: "Alpha Current",
              townHall: 20,
            }),
            makePlayerCurrentFixture({
              playerTag: "#8J9PP8GV9",
              playerName: "Charlie Current",
              townHall: 18,
            }),
          ],
          fwaPlayerCatalog: [
            makeFwaPlayerCatalogFixture({
              playerTag: "#PYLQ0289",
              latestName: "Alpha Catalog",
              latestTownHall: 19,
            }),
          ],
          todoPlayerSnapshot: [
            makeTodoPlayerSnapshotFixture({
              playerTag: "#PYLQ0289",
              playerName: "Alpha Todo",
              townHall: 18,
            }),
          ],
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#2RVGJYLC0",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#8J9PP8GV9",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        outcome: "success",
        currentLinkedAccountCount: 3,
        violatingAccountCount: 2,
        violationCount: 4,
        affectedWarCount: 2,
        hasViolationsInPeriod: true,
        trackingSince: d("2026-05-10T01:00:00.000Z"),
      });
      expect(result.accounts.map((row) => row.playerTag)).toEqual([
        "#2RVGJYLC0",
        "#PYLQ0289",
        "#8J9PP8GV9",
      ]);
      expect(result.accounts).toEqual([
        expect.objectContaining({
          playerTag: "#2RVGJYLC0",
          playerName: "#2RVGJYLC0",
          townHallLevel: 16,
          violationCount: 2,
          affectedWarCount: 2,
        }),
        expect.objectContaining({
          playerTag: "#PYLQ0289",
          playerName: "Alpha Current",
          townHallLevel: 20,
          violationCount: 2,
          affectedWarCount: 2,
        }),
        expect.objectContaining({
          playerTag: "#8J9PP8GV9",
          playerName: "Charlie Current",
          townHallLevel: 18,
          violationCount: 0,
          affectedWarCount: 0,
        }),
      ]);
    });

    it("keeps reads bounded and does not call getPlayerHistory per account", async () => {
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
                playerNameSnapshot: "Alpha One",
                townHallLevelSnapshot: 16,
              },
              {
                playerTag: "#2RVGJYLC0",
                playerNameSnapshot: "Beta Two",
                townHallLevelSnapshot: 15,
              },
            ],
          }),
        ],
        {
          playerCurrent: [
            makePlayerCurrentFixture({
              playerTag: "#PYLQ0289",
              playerName: "Alpha Current",
              townHall: 20,
            }),
            makePlayerCurrentFixture({
              playerTag: "#2RVGJYLC0",
              playerName: "Beta Current",
              townHall: 19,
            }),
          ],
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#PYLQ0289",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
            makePlayerLinkFixture({
              playerTag: "#2RVGJYLC0",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );

      const historySpy = vi.spyOn(service, "getPlayerHistory");

      const result = await service.getDiscordUserAggregate({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        period: "lifetime",
        now: d("2026-06-01T00:00:00.000Z"),
      });

      expect(historySpy).not.toHaveBeenCalled();
      expect(db.playerLink.findMany).toHaveBeenCalledTimes(2);
      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(1);
      expect(db.playerCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
      expect(db.todoPlayerSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(result.accounts).toHaveLength(2);
    });
  });

  describe("getPlayerAutocompleteChoices", () => {
    it("returns an empty array for a blank guild without database reads", async () => {
      const { db, service } = buildService([]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "   ",
        focusedText: "alpha",
      });

      expect(result).toEqual([]);
      expect(db.warPlanViolation.findMany).not.toHaveBeenCalled();
      expect(db.warPlanViolation.groupBy).not.toHaveBeenCalled();
      expect(db.playerCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaClanMemberCurrent.findMany).not.toHaveBeenCalled();
      expect(db.fwaPlayerCatalog.findMany).not.toHaveBeenCalled();
      expect(db.todoPlayerSnapshot.findMany).not.toHaveBeenCalled();
      expect(db.playerLink.findMany).not.toHaveBeenCalled();
    });

    it("only includes guild-scoped completed violators", async () => {
      const { db, service } = buildService([
        buildFixture({
          guildId: "guild-a",
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Guild Alpha",
              townHallLevelSnapshot: 16,
            },
          ],
        }),
        buildFixture({
          guildId: "guild-a",
          warId: 2,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-11T00:00:00.000Z"),
          warEndTime: d("2026-05-11T01:00:00.000Z"),
          status: "FAILED",
          violations: [
            {
              playerTag: "#2RVGJYLC0",
              playerNameSnapshot: "Guild Failed",
              townHallLevelSnapshot: 15,
            },
          ],
        }),
        buildFixture({
          guildId: "guild-b",
          warId: 3,
          clanTag: "#2QG2C08UR",
          clanName: "Beta",
          warStartTime: d("2026-05-12T00:00:00.000Z"),
          warEndTime: d("2026-05-12T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#8J9PP8GV9",
              playerNameSnapshot: "Other Guild",
              townHallLevelSnapshot: 14,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-a",
        focusedText: "",
      });

      expect(result.map((choice) => choice.value)).toEqual(["#PYLQ0289"]);
      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(2);
      expect(db.warPlanViolation.groupBy).toHaveBeenCalledTimes(1);
      expect(db.warPlanViolation.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
        evaluation: {
          is: {
            guildId: "guild-a",
            status: "COMPLETED",
            warHistory: {
              is: {
                warEndTime: { not: null },
              },
            },
          },
        },
      });
      expect(db.warPlanViolation.findMany.mock.calls[1]?.[0]?.where).toMatchObject({
        evaluation: {
          is: {
            guildId: "guild-a",
            status: "COMPLETED",
            warHistory: {
              is: {
                warEndTime: null,
              },
            },
          },
        },
      });
      expect(db.warPlanViolation.groupBy.mock.calls[0]?.[0]?.where).toMatchObject({
        playerTag: {
          in: ["#PYLQ0289"],
        },
        evaluation: {
          is: {
            guildId: "guild-a",
            status: "COMPLETED",
          },
        },
      });
      expect(result[0]?.name).toContain("Guild Alpha");
    });

    it.each(["#pylq0289", "pylq0289", "#PyLq0289"])(
      "matches tags case-insensitively with or without a leading hash (%s)",
      async (focusedText) => {
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
                playerNameSnapshot: "Guild Alpha",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
        ]);

        const result = await service.getPlayerAutocompleteChoices({
          guildId: "guild-1",
          focusedText,
        });

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          name: "Guild Alpha (#PYLQ0289) — 1 violation",
          value: "#PYLQ0289",
        });
      },
    );

    it("makes current resolved player names searchable", async () => {
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
                townHallLevelSnapshot: 16,
              },
            ],
          }),
        ],
        {
          playerCurrent: [
            makePlayerCurrentFixture({
              playerTag: "#PYLQ0289",
              playerName: "Current Alpha",
              townHall: 19,
            }),
          ],
        },
      );

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "current",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toContain("Current Alpha");
    });

    it("keeps snapshot-only fallback names searchable when they are the final resolved name", async () => {
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
              playerNameSnapshot: "Snapshot Only",
              townHallLevelSnapshot: 16,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "snapshot",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toContain("Snapshot Only");
    });

    it("does not return an old snapshot match when a higher-precedence current name does not match", async () => {
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
                playerNameSnapshot: "Old Snapshot",
                townHallLevelSnapshot: 16,
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
        ],
        {
          playerCurrent: [
            makePlayerCurrentFixture({
              playerTag: "#PYLQ0289",
              playerName: "Current Alpha",
              townHall: 19,
            }),
          ],
        },
      );

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "old snapshot",
      });

      expect(result).toEqual([]);
    });

    it("deduplicates multiple violation rows into one choice with the total count", async () => {
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
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Snapshot Alpha",
              townHallLevelSnapshot: 16,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toContain("— 2 violations");
    });

    it("ranks exact tag matches ahead of substring matches", async () => {
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
                playerTag: "#2QG2C08UP",
                playerNameSnapshot: "Exact Match",
                townHallLevelSnapshot: 16,
              },
            ],
          }),
          buildFixture({
            warId: 2,
            clanTag: "#2QG2C08UR",
            clanName: "Beta",
            warStartTime: d("2026-05-11T00:00:00.000Z"),
            warEndTime: d("2026-05-11T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "My #2QG2C08UP Player",
                townHallLevelSnapshot: 15,
              },
            ],
          }),
        ],
      );

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "#2QG2C08UP",
      });

      expect(result.map((choice) => choice.value)).toEqual(["#2QG2C08UP", "#PYLQ0289"]);
    });

    it("ranks tag prefix, name prefix, and substring matches deterministically", async () => {
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
                playerTag: "#2QG2C08UR",
                playerNameSnapshot: "Tag Prefix",
                townHallLevelSnapshot: 16,
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
                playerTag: "#8J9PP8GV9",
                playerNameSnapshot: "2QG Name Prefix",
                townHallLevelSnapshot: 15,
              },
            ],
          }),
          buildFixture({
            warId: 3,
            clanTag: "#2QG2C08UP",
            clanName: "Alpha",
            warStartTime: d("2026-05-12T00:00:00.000Z"),
            warEndTime: d("2026-05-12T01:00:00.000Z"),
            violations: [
              {
                playerTag: "#PYLQ0289",
                playerNameSnapshot: "Contains 2QG",
                townHallLevelSnapshot: 14,
              },
            ],
          }),
        ],
      );

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "2qg",
      });

      expect(result.map((choice) => choice.value)).toEqual([
        "#2QG2C08UR",
        "#8J9PP8GV9",
        "#PYLQ0289",
      ]);
    });

    it("orders empty queries by count, resolved name, then tag", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#2QG2C08UP",
              playerNameSnapshot: "Bravo",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#2QG2C08UP",
              playerNameSnapshot: "Bravo",
              townHallLevelSnapshot: 16,
            },
            {
              playerTag: "#2QG2C08UP",
              playerNameSnapshot: "Bravo",
              townHallLevelSnapshot: 16,
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
              playerTag: "#2QG2C08UR",
              playerNameSnapshot: "Alpha",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#2QG2C08UR",
              playerNameSnapshot: "Alpha",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#2QG2C08UR",
              playerNameSnapshot: "Alpha",
              townHallLevelSnapshot: 15,
            },
          ],
        }),
        buildFixture({
          warId: 3,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-12T00:00:00.000Z"),
          warEndTime: d("2026-05-12T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Charlie",
              townHallLevelSnapshot: 14,
            },
            {
              playerTag: "#PYLQ0289",
              playerNameSnapshot: "Charlie",
              townHallLevelSnapshot: 14,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "",
      });

      expect(result.map((choice) => choice.value)).toEqual([
        "#2QG2C08UR",
        "#2QG2C08UP",
        "#PYLQ0289",
      ]);
    });

    it("formats singular and plural violation labels and keeps names under 100 characters", async () => {
      const { service } = buildService([
        buildFixture({
          warId: 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d("2026-05-10T00:00:00.000Z"),
          warEndTime: d("2026-05-10T01:00:00.000Z"),
          violations: [
            {
              playerTag: "#2QG2C08UP",
              playerNameSnapshot: makeLongPlayerName("Solo"),
              townHallLevelSnapshot: 16,
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
              playerTag: "#2QG2C08UR",
              playerNameSnapshot: "Plural",
              townHallLevelSnapshot: 15,
            },
            {
              playerTag: "#2QG2C08UR",
              playerNameSnapshot: "Plural",
              townHallLevelSnapshot: 15,
            },
          ],
        }),
      ]);

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "",
      });

      expect(result.some((choice) => choice.name.includes("— 2 violations"))).toBe(true);
      expect(result.every((choice) => choice.name.length <= 100)).toBe(true);
    });

    it("clamps the limit to the allowed 1 through 25 range", async () => {
      const fixtures = Array.from({ length: 30 }, (_, index) =>
        buildFixture({
          warId: index + 1,
          clanTag: "#2QG2C08UP",
          clanName: "Alpha",
          warStartTime: d(`2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
          warEndTime: d(`2026-05-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`),
          violations: [
            {
              playerTag: makeAutocompleteTag(index),
              playerNameSnapshot: `Player ${index + 1}`,
              townHallLevelSnapshot: 10 + (index % 5),
            },
          ],
        }),
      );
      const { service } = buildService(fixtures);

      const defaultLimit = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
      });
      const cappedLimit = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        limit: 100,
      });
      const minLimit = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        limit: 0,
      });
      const fractionalLimit = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        limit: 2.9,
      });

      expect(defaultLimit).toHaveLength(25);
      expect(cappedLimit).toHaveLength(25);
      expect(minLimit).toHaveLength(1);
      expect(fractionalLimit).toHaveLength(2);
    });

    it("keeps reads bounded and avoids per-player history calls", async () => {
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
                playerTag: "#2QG2C08UP",
                playerNameSnapshot: "Alpha One",
                townHallLevelSnapshot: 16,
              },
              {
                playerTag: "#2QG2C08UR",
                playerNameSnapshot: "Alpha Two",
                townHallLevelSnapshot: 15,
              },
            ],
          }),
        ],
        {
          playerCurrent: [
            makePlayerCurrentFixture({
              playerTag: "#2QG2C08UP",
              playerName: "Current Alpha One",
              townHall: 18,
            }),
            makePlayerCurrentFixture({
              playerTag: "#2QG2C08UR",
              playerName: "Current Alpha Two",
              townHall: 17,
            }),
          ],
          fwaPlayerCatalog: [
            makeFwaPlayerCatalogFixture({
              playerTag: "#2QG2C08UP",
              latestName: "Catalog Alpha One",
              latestTownHall: 19,
            }),
          ],
          todoPlayerSnapshot: [
            makeTodoPlayerSnapshotFixture({
              playerTag: "#2QG2C08UR",
              playerName: "Todo Alpha Two",
              townHall: 16,
            }),
          ],
          playerLink: [
            makePlayerLinkFixture({
              playerTag: "#2QG2C08UP",
              discordUserId: "111111111111111111",
              verificationStatus: "VERIFIED",
            }),
          ],
        },
      );
      const historySpy = vi.spyOn(service, "getPlayerHistory");

      const result = await service.getPlayerAutocompleteChoices({
        guildId: "guild-1",
        focusedText: "alpha",
      });

      expect(historySpy).not.toHaveBeenCalled();
      expect(db.warPlanViolation.findMany).toHaveBeenCalledTimes(2);
      expect(db.warPlanViolation.groupBy).toHaveBeenCalledTimes(1);
      expect(db.playerCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaClanMemberCurrent.findMany).toHaveBeenCalledTimes(1);
      expect(db.fwaPlayerCatalog.findMany).toHaveBeenCalledTimes(1);
      expect(db.todoPlayerSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(db.playerLink.findMany).toHaveBeenCalledTimes(1);
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
