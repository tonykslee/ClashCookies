import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../prisma/migrations/20260825100000_backfill_fwa_layout_records/migration.sql",
    import.meta.url,
  ),
);

describe("FWA layout LayoutRecord backfill migration", () => {
  it("groups exact legacy links, preserves existing records, and leaves freshness unknown", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('GROUP BY "LayoutLink"');
    expect(migration).toContain('WHERE existing."layoutLink" = source."LayoutLink"');
    expect(migration).toContain("ON CONFLICT (\"layoutLink\") DO NOTHING");
    expect(migration).toContain('MAX("ImageUrl") FILTER (WHERE "ImageUrl" IS NOT NULL)');
    expect(migration).toContain('SET "layoutId" = layout."id"');
    expect(migration).toContain('SET "imageUrl" = source."ImageUrl"');
    expect(migration).toContain('"LayoutLink" = layout."layoutLink"');
    expect(migration).toContain('"ImageUrl" = layout."imageUrl"');
    expect(migration).toContain('WHERE fwa."layoutId" = layout."id"');
    expect(migration).toContain('"submittedAt"');
    expect(migration).toContain('"lastConfirmedAt"');
    expect(migration).toContain('"lastConfirmedByDiscordUserId"');
    expect(migration).not.toContain('"LastUpdated"');
  });
});
