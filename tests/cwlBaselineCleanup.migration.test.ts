import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const originalMigrationPath = fileURLToPath(
  new URL("../prisma/migrations/20260618120000_add_cwl_alliance_baseline/migration.sql", import.meta.url),
);
const cleanupMigrationPath = fileURLToPath(
  new URL("../prisma/migrations/20260814130000_remove_legacy_cwl_alliance_baseline/migration.sql", import.meta.url),
);
const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const legacyPrefix = "CwlAllianceSeason";
const legacyTables = [
  `${legacyPrefix}BaselineMember`,
  `${legacyPrefix}BaselineClan`,
  `${legacyPrefix}Baseline`,
];
const legacyEnums = [
  `${legacyPrefix}BaselineCaptureStatus`,
  `${legacyPrefix}BaselineSourceType`,
];

describe("legacy CWL baseline cleanup migration", () => {
  it("removes legacy models from the active schema and drops them dependency-safely", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const cleanup = readFileSync(cleanupMigrationPath, "utf8");

    for (const legacyObject of [...legacyTables, ...legacyEnums]) {
      expect(schema).not.toContain(legacyObject);
    }
    const dropStatements = [
      ...legacyTables.map((table) => `DROP TABLE "${table}";`),
      ...legacyEnums.map((enumName) => `DROP TYPE "${enumName}";`),
    ];
    let previousIndex = -1;
    for (const statement of dropStatements) {
      const index = cleanup.indexOf(statement);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(cleanup).not.toContain("playerPosition");
  });

  it("keeps the already-applied creation migration immutable", () => {
    const original = readFileSync(originalMigrationPath);
    // Pin the exact bytes of this already-applied immutable migration.
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "2e51f72c1984b3265e318bf5ebc12f451f45085b5e277d549c575190b979c931",
    );
    expect(original.toString("utf8")).toContain('ADD COLUMN IF NOT EXISTS "playerPosition" INTEGER;');
  });
});
