import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260618120000_add_cwl_event_instances/migration.sql", import.meta.url),
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
