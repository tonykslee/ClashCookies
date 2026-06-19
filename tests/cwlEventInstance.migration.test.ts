import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260618120000_add_cwl_event_instances/migration.sql", import.meta.url),
);
const ROTATION_MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260619120000_scope_cwl_rotation_plans_by_event/migration.sql", import.meta.url),
);

type HistoricalEventFixture = {
  id: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

type OrphanPlanFixture = {
  season: string;
  clanTag: string;
  eventInstanceId: string;
  createdAt: Date;
  updatedAt: Date;
};

type ActivePlanFixture = {
  id: string;
  eventInstanceId: string;
  clanTag: string;
  version: number;
  updatedAt: Date;
  isActive: boolean;
};

function loadMigration(): string {
  return readFileSync(ROTATION_MIGRATION_PATH, "utf8");
}

function loadMigrationStatements(): string[] {
  return loadMigration()
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function findStatementIndex(statements: string[], pattern: string): number {
  return statements.findIndex((statement) => statement.includes(pattern));
}

function expectNoLaterStatementReferences(statements: string[], startIndex: number, pattern: string) {
  expect(statements.slice(startIndex + 1).some((statement) => statement.includes(pattern))).toBe(false);
}

function expectOrphanTempTableStructure(statement: string) {
  expect(statement).toContain('CREATE TEMP TABLE "_CwlRotationOrphanGroup" ON COMMIT DROP AS');
  expect(statement).toContain('WHERE plan."eventInstanceId" IS NULL');
  expect(statement).toContain('orphan_groups AS (');
  expect(statement).toContain('ranked_orphans AS (');
  expect(statement).toContain('FROM ranked_orphans orphan');
  expect(statement).toMatch(
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY orphan\."clanTag"\s*ORDER BY\s*orphan\."lastUpdatedAt" DESC,\s*orphan\."firstCreatedAt" DESC,\s*orphan\."season" DESC,\s*orphan\."eventInstanceId" DESC\s*\) AS "orphanRank"/,
  );
}

function expectSyntheticCurrentStructure(statement: string) {
  expect(statement).toContain('FROM "_CwlRotationOrphanGroup" orphan');
  expect(statement).toContain('orphan."orphanRank" = 1');
  expect(statement).toContain('NOT EXISTS (');
  expect(statement).toContain('current_clan."clanTag" = orphan."clanTag"');
  expect(statement).toContain('current_clan."isCurrent" = true');
  expect(statement).toContain('ELSE false');
}

function selectHistoricalEvent(
  planCreatedAt: Date,
  events: Array<HistoricalEventFixture & { season: string }>,
): HistoricalEventFixture & { season: string } {
  const ranked = [...events].sort((left, right) => {
    const leftBefore = left.firstObservedAt.getTime() <= planCreatedAt.getTime() ? 0 : 1;
    const rightBefore = right.firstObservedAt.getTime() <= planCreatedAt.getTime() ? 0 : 1;
    if (leftBefore !== rightBefore) return leftBefore - rightBefore;
    if (leftBefore === 0) {
      const byObserved = right.firstObservedAt.getTime() - left.firstObservedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byLastObserved = right.lastObservedAt.getTime() - left.lastObservedAt.getTime();
      if (byLastObserved !== 0) return byLastObserved;
    } else {
      const byObserved = left.firstObservedAt.getTime() - right.firstObservedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byLastObserved = left.lastObservedAt.getTime() - right.lastObservedAt.getTime();
      if (byLastObserved !== 0) return byLastObserved;
    }
    const bySeason = right.season.localeCompare(left.season);
    if (bySeason !== 0) return bySeason;
    return right.id.localeCompare(left.id);
  });
  return ranked[0]!;
}

function selectSyntheticCurrentOrphan(
  groups: OrphanPlanFixture[],
  currentPointerClanTags: Set<string>,
): OrphanPlanFixture | null {
  const groupedByClan = new Map<string, OrphanPlanFixture[]>();
  for (const group of groups) {
    const existing = groupedByClan.get(group.clanTag) ?? [];
    existing.push(group);
    groupedByClan.set(group.clanTag, existing);
  }

  const candidates: OrphanPlanFixture[] = [];
  for (const [clanTag, clanGroups] of groupedByClan.entries()) {
    if (currentPointerClanTags.has(clanTag)) {
      continue;
    }
    const ranked = [...clanGroups].sort((left, right) => {
      const byLastUpdated = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byLastUpdated !== 0) return byLastUpdated;
      const byFirstCreated = right.createdAt.getTime() - left.createdAt.getTime();
      if (byFirstCreated !== 0) return byFirstCreated;
      const bySeason = right.season.localeCompare(left.season);
      if (bySeason !== 0) return bySeason;
      return right.eventInstanceId.localeCompare(left.eventInstanceId);
    });
    candidates.push(ranked[0]!);
  }
  return candidates[0] ?? null;
}

function repairDuplicateActivePlans(rows: ActivePlanFixture[]): ActivePlanFixture[] {
  const ranked = new Map<string, ActivePlanFixture[]>();
  for (const row of rows.filter((entry) => entry.isActive)) {
    const key = `${row.eventInstanceId}:${row.clanTag}`;
    const existing = ranked.get(key) ?? [];
    existing.push(row);
    ranked.set(key, existing);
  }

  const kept = [...rows.filter((row) => !row.isActive)];
  for (const group of ranked.values()) {
    const winner = [...group].sort((left, right) => {
      if (left.version !== right.version) return right.version - left.version;
      const byUpdatedAt = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byUpdatedAt !== 0) return byUpdatedAt;
      return right.id.localeCompare(left.id);
    })[0]!;
    kept.push(winner);
  }
  return kept;
}

describe("CWL event instance migration", () => {
  it("backfills one current clan pointer per clan and enforces a partial unique current index", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");

    expect(migration).toContain('ROW_NUMBER() OVER (');
    expect(migration).toContain('PARTITION BY "clanTag"');
    expect(migration).toContain('ORDER BY "lastObservedAt" DESC, "season" DESC, "eventInstanceId" DESC');
    expect(migration).toContain('"currentRank" = 1 AS "isCurrent"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlEventClan_current_clan_key"');
    expect(migration).toContain('WHERE "isCurrent" = true;');
  });
});

describe("CWL rotation event-scope migration", () => {
  it("assigns historical plans before materializing orphan groups", () => {
    const statements = loadMigrationStatements();
    const historicalUpdateIndex = findStatementIndex(statements, 'WITH ranked_candidates AS (');
    const tempTableIndex = findStatementIndex(statements, 'CREATE TEMP TABLE "_CwlRotationOrphanGroup" ON COMMIT DROP AS');
    const eventInstanceInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventInstance"');
    const eventClanInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventClan"');
    const orphanPlanUpdateIndex = findStatementIndex(statements, 'SET "eventInstanceId" = orphan."eventInstanceId"');

    expect(historicalUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(tempTableIndex).toBeGreaterThan(historicalUpdateIndex);
    expect(eventInstanceInsertIndex).toBeGreaterThan(tempTableIndex);
    expect(eventClanInsertIndex).toBeGreaterThan(eventInstanceInsertIndex);
    expect(orphanPlanUpdateIndex).toBeGreaterThan(eventClanInsertIndex);

    const tempTableStatement = statements[tempTableIndex]!;
    expectOrphanTempTableStructure(tempTableStatement);
    expectNoLaterStatementReferences(statements, tempTableIndex, 'orphan_groups');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'ranked_orphans');

    const laterStatements = statements.slice(tempTableIndex + 1);
    const tempReferences = laterStatements.filter((statement) => statement.includes('_CwlRotationOrphanGroup'));
    expect(tempReferences.length).toBeGreaterThan(0);
    expect(tempReferences.every((statement) => !statement.includes('orphan_groups'))).toBe(true);
    expect(tempReferences.every((statement) => !statement.includes('ranked_orphans'))).toBe(true);

    const historicalStatement = statements[historicalUpdateIndex]!;
    expect(historicalStatement).toContain('clan."firstObservedAt" <= plan."createdAt"');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN 0 ELSE 1 END ASC');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN clan."firstObservedAt" END DESC');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" > plan."createdAt" THEN clan."firstObservedAt" END ASC');
  });

  it("materializes only still-null plans into the orphan table and keeps the temp table local", () => {
    const migration = loadMigration();
    const statements = loadMigrationStatements();
    const tempTableIndex = findStatementIndex(statements, 'CREATE TEMP TABLE "_CwlRotationOrphanGroup" ON COMMIT DROP AS');
    const tempTableStatement = statements[tempTableIndex]!;

    expect(migration).toContain('CREATE TEMP TABLE "_CwlRotationOrphanGroup" ON COMMIT DROP AS');
    expect(tempTableStatement).toContain('WHERE plan."eventInstanceId" IS NULL');
    expect(tempTableStatement).toContain('ON COMMIT DROP');
    expect(tempTableStatement).toContain('orphan_groups AS (');
    expect(tempTableStatement).toContain('ranked_orphans AS (');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'orphan_groups');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'ranked_orphans');

    const orphanPlanMaterializationIndex = findStatementIndex(
      statements,
      'SET "eventInstanceId" = orphan."eventInstanceId"',
    );
    expect(orphanPlanMaterializationIndex).toBeGreaterThan(tempTableIndex);
  });

  it("nominates at most one orphan event as current per clan and leaves existing pointers alone", () => {
    const statements = loadMigrationStatements();
    const clanInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventClan"');
    const clanInsertStatement = statements[clanInsertIndex]!;

    expectSyntheticCurrentStructure(clanInsertStatement);

    const orphanGroups: OrphanPlanFixture[] = [
      {
        season: "2026-05",
        clanTag: "#2QG2C08UP",
        eventInstanceId: "legacy-rotation:2026-05:#2QG2C08UP",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      },
      {
        season: "2026-06",
        clanTag: "#2QG2C08UP",
        eventInstanceId: "legacy-rotation:2026-06:#2QG2C08UP",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ];
    const syntheticCurrent = selectSyntheticCurrentOrphan(orphanGroups, new Set());
    expect(syntheticCurrent).toEqual(
      expect.objectContaining({
        season: "2026-06",
        clanTag: "#2QG2C08UP",
      }),
    );

    const existingCurrentSynthetic = selectSyntheticCurrentOrphan(orphanGroups, new Set(["#2QG2C08UP"]));
    expect(existingCurrentSynthetic).toBeNull();
  });

  it("attaches a historical plan to the earliest eligible event and keeps tie-breakers deterministic", () => {
    const planCreatedAt = new Date("2026-06-05T00:00:00.000Z");
    const selectedPastEvent = selectHistoricalEvent(planCreatedAt, [
      {
        id: "event-a",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "event-b",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "event-c",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-15T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-15T00:00:00.000Z"),
      },
    ]);
    const selectedFutureEvent = selectHistoricalEvent(new Date("2026-05-01T00:00:00.000Z"), [
      {
        id: "event-d",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-10T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-10T00:00:00.000Z"),
      },
      {
        id: "event-e",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-20T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ]);

    expect(selectedPastEvent.id).toBe("event-b");
    expect(selectedFutureEvent.id).toBe("event-d");
  });

  it("repairs duplicate active plans and enforces event-scoped uniqueness", () => {
    const migration = loadMigration();

    expect(migration).toContain('PARTITION BY "eventInstanceId", "clanTag"');
    expect(migration).toContain('ORDER BY "version" DESC, "updatedAt" DESC, "id" DESC');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_eventInstanceId_clanTag_version_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_active_event_clan_key"');
    expect(migration).toContain('WHERE "isActive" = true;');
    expect(migration).toContain('FOREIGN KEY ("eventInstanceId", "clanTag") REFERENCES "CwlEventClan"("eventInstanceId", "clanTag")');

    const repaired = repairDuplicateActivePlans([
      {
        id: "plan-a-v1",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 1,
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-a-v2-newer",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 2,
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-a-v2-older",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 2,
        updatedAt: new Date("2026-06-01T12:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-b-v1",
        eventInstanceId: "event-b",
        clanTag: "#2QG2C08UP",
        version: 1,
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
        isActive: true,
      },
    ]);

    expect(repaired.map((row) => row.id)).toEqual(["plan-a-v2-newer", "plan-b-v1"]);
    expect(repaired).toHaveLength(2);
  });

  it("chooses only one synthetic current pointer when multiple orphan seasons exist for one clan", () => {
    const migration = loadMigration();

    expectOrphanTempTableStructure(migration);

    const orphanGroups: OrphanPlanFixture[] = [
      {
        season: "2026-05",
        clanTag: "#9GLGQCCU",
        eventInstanceId: "legacy-rotation:2026-05:#9GLGQCCU",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-04T00:00:00.000Z"),
      },
      {
        season: "2026-06",
        clanTag: "#9GLGQCCU",
        eventInstanceId: "legacy-rotation:2026-06:#9GLGQCCU",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ];

    const current = selectSyntheticCurrentOrphan(orphanGroups, new Set());
    expect(current).toEqual(
      expect.objectContaining({
        season: "2026-06",
        clanTag: "#9GLGQCCU",
      }),
    );
  });
});
