import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260618120000_add_cwl_event_instances/migration.sql", import.meta.url),
);
const ROTATION_MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260619120000_scope_cwl_rotation_plans_by_event/migration.sql", import.meta.url),
);

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
  it("backfills legacy plans by historical event observation time instead of current pointer", () => {
    const migration = readFileSync(ROTATION_MIGRATION_PATH, "utf8");

    expect(migration).toContain('clan."firstObservedAt" <= plan."createdAt"');
    expect(migration).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN 0 ELSE 1 END ASC');
    expect(migration).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN clan."firstObservedAt" END DESC');
    expect(migration).toContain('CASE WHEN clan."firstObservedAt" > plan."createdAt" THEN clan."firstObservedAt" END ASC');
  });

  it("creates deterministic legacy event ownership for orphaned plans", () => {
    const migration = readFileSync(ROTATION_MIGRATION_PATH, "utf8");

    expect(migration).toContain("'legacy-rotation:' || orphan.\"season\" || ':' || orphan.\"clanTag\"");
    expect(migration).toContain("NOT EXISTS (");
    expect(migration).toContain('current_clan."isCurrent" = true');
    expect(migration).toContain('WHERE plan."eventInstanceId" IS NULL');
    expect(migration).toContain('ALTER TABLE "CwlRotationPlan" ALTER COLUMN "eventInstanceId" SET NOT NULL;');
  });

  it("repairs duplicate active plans and enforces event-scoped uniqueness", () => {
    const migration = readFileSync(ROTATION_MIGRATION_PATH, "utf8");

    expect(migration).toContain('PARTITION BY "eventInstanceId", "clanTag"');
    expect(migration).toContain('ORDER BY "version" DESC, "updatedAt" DESC, "id" DESC');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_eventInstanceId_clanTag_version_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_active_event_clan_key"');
    expect(migration).toContain('WHERE "isActive" = true;');
    expect(migration).toContain('FOREIGN KEY ("eventInstanceId", "clanTag") REFERENCES "CwlEventClan"("eventInstanceId", "clanTag")');
  });
});
