#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 2 staged-correction validator (dry-run only).
 *
 * Validates a staged correction JSON file for archive war repairs before any
 * Phase 2 write script is considered.
 */

const fs = require("fs");
const path = require("path");

const EXPECTED_ARCHIVE_WAR_IDS = [
  1001293,
  1001295,
  1001296,
  1001297,
  1001298,
  1001299,
  1001300,
  1001301,
];

const REQUIRED_FIELDS = [
  "archiveWarId",
  "clanTag",
  "opponentTag",
  "warStartTime",
  "warEndTime",
  "clanStars",
  "opponentStars",
  "clanDestruction",
  "opponentDestruction",
  "actualOutcome",
  "warLookupResult",
];

const ACTUAL_OUTCOME_ENUM = new Set(["WIN", "LOSE", "TIE", "UNKNOWN"]);
const WAR_LOOKUP_RESULT_ENUM = new Set(["win", "lose", "tie", "unknown"]);
const IDENTITY_PROTECTED_FIELDS = [
  "warId",
  "clanTag",
  "opponentTag",
  "warStartTime",
  "payload.warMeta.startTime",
  "payload.warMeta.warId",
];

function parseArgs(argv) {
  const out = {
    file: null,
    schemaFile: path.resolve(process.cwd(), "scripts/phase2-staged-correction.schema.json"),
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--file") {
      out.file = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--schema-file") {
      out.schemaFile = path.resolve(process.cwd(), argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/phase2-validate-staged-corrections.js --file <staged-corrections.json>",
    "",
    "Optional:",
    "  --schema-file <path>   Override schema path (default: scripts/phase2-staged-correction.schema.json)",
  ].join("\n");
}

function line() {
  console.log("=".repeat(96));
}

function loadJsonFile(filePath, label) {
  const fullPath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  return { fullPath, parsed, raw };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUppercaseClanTag(value) {
  return typeof value === "string" && /^#[A-Z0-9]+$/.test(value);
}

function isClanTagAnyCase(value) {
  return typeof value === "string" && /^#[A-Za-z0-9]+$/.test(value);
}

function isIsoUtc(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function validateRow(row, index) {
  const errors = [];
  const warnings = [];

  if (!isObject(row)) {
    errors.push("row must be an object");
    return { index, archiveWarId: null, ok: false, errors, warnings };
  }

  const extraFields = Object.keys(row).filter((key) => !REQUIRED_FIELDS.includes(key));
  if (extraFields.length > 0) {
    errors.push(`unexpected fields: ${extraFields.join(", ")}`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in row)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  const archiveWarId = row.archiveWarId;
  if (!Number.isInteger(archiveWarId)) {
    errors.push("archiveWarId must be an integer");
  } else if (!EXPECTED_ARCHIVE_WAR_IDS.includes(archiveWarId)) {
    errors.push(`archiveWarId ${archiveWarId} is not in approved set`);
  }

  if (!isUppercaseClanTag(row.clanTag)) {
    if (isClanTagAnyCase(row.clanTag)) {
      errors.push("clanTag must be uppercase (e.g., #ABC123)");
    } else {
      errors.push("clanTag must match pattern ^#[A-Z0-9]+$");
    }
  }

  if (!isUppercaseClanTag(row.opponentTag)) {
    if (isClanTagAnyCase(row.opponentTag)) {
      errors.push("opponentTag must be uppercase (e.g., #ABC123)");
    } else {
      errors.push("opponentTag must match pattern ^#[A-Z0-9]+$");
    }
  }

  if (!isIsoUtc(row.warStartTime)) {
    errors.push("warStartTime must be ISO UTC format YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  if (!isIsoUtc(row.warEndTime)) {
    errors.push("warEndTime must be ISO UTC format YYYY-MM-DDTHH:mm:ss.sssZ");
  }
  if (isIsoUtc(row.warStartTime) && isIsoUtc(row.warEndTime)) {
    const startMs = new Date(row.warStartTime).getTime();
    const endMs = new Date(row.warEndTime).getTime();
    if (endMs < startMs) {
      errors.push("warEndTime must be >= warStartTime");
    }
  }

  if (!Number.isInteger(row.clanStars) || row.clanStars < 0 || row.clanStars > 150) {
    errors.push("clanStars must be an integer between 0 and 150");
  }
  if (!Number.isInteger(row.opponentStars) || row.opponentStars < 0 || row.opponentStars > 150) {
    errors.push("opponentStars must be an integer between 0 and 150");
  }

  if (typeof row.clanDestruction !== "number" || Number.isNaN(row.clanDestruction)) {
    errors.push("clanDestruction must be a number");
  } else if (row.clanDestruction < 0 || row.clanDestruction > 100) {
    errors.push("clanDestruction must be between 0 and 100");
  }
  if (typeof row.opponentDestruction !== "number" || Number.isNaN(row.opponentDestruction)) {
    errors.push("opponentDestruction must be a number");
  } else if (row.opponentDestruction < 0 || row.opponentDestruction > 100) {
    errors.push("opponentDestruction must be between 0 and 100");
  }

  if (!ACTUAL_OUTCOME_ENUM.has(row.actualOutcome)) {
    if (typeof row.actualOutcome === "string" && ACTUAL_OUTCOME_ENUM.has(row.actualOutcome.toUpperCase())) {
      errors.push(
        `actualOutcome has invalid casing: "${row.actualOutcome}" (must be uppercase WIN|LOSE|TIE|UNKNOWN)`
      );
    } else {
      errors.push(`actualOutcome must be one of: ${[...ACTUAL_OUTCOME_ENUM].join(", ")}`);
    }
  }

  if (!WAR_LOOKUP_RESULT_ENUM.has(row.warLookupResult)) {
    if (
      typeof row.warLookupResult === "string" &&
      WAR_LOOKUP_RESULT_ENUM.has(row.warLookupResult.toLowerCase())
    ) {
      errors.push(
        `warLookupResult has invalid casing: "${row.warLookupResult}" (must be lowercase win|lose|tie|unknown)`
      );
    } else {
      errors.push(`warLookupResult must be one of: ${[...WAR_LOOKUP_RESULT_ENUM].join(", ")}`);
    }
  }

  if (typeof row.actualOutcome === "string" && typeof row.warLookupResult === "string") {
    const expectedLookup = row.actualOutcome.toLowerCase();
    if (
      ACTUAL_OUTCOME_ENUM.has(row.actualOutcome) &&
      WAR_LOOKUP_RESULT_ENUM.has(row.warLookupResult) &&
      row.warLookupResult !== expectedLookup
    ) {
      warnings.push(
        `Outcome mismatch: actualOutcome=${row.actualOutcome} does not map to warLookupResult=${row.warLookupResult}`
      );
    }
  }

  return {
    index,
    archiveWarId: Number.isInteger(archiveWarId) ? archiveWarId : null,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function buildMembershipChecks(rows) {
  const errors = [];
  const diagnostics = {
    rowCount: rows.length,
    expectedRowCount: EXPECTED_ARCHIVE_WAR_IDS.length,
    rowCountOk: rows.length === EXPECTED_ARCHIVE_WAR_IDS.length,
    duplicates: [],
    missingWarIds: [],
    extraWarIds: [],
    exactMembershipOk: false,
  };

  const counts = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.archiveWarId)) continue;
    counts.set(row.archiveWarId, (counts.get(row.archiveWarId) ?? 0) + 1);
  }

  diagnostics.duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([archiveWarId, count]) => ({ archiveWarId, count }));

  const present = new Set([...counts.keys()]);
  diagnostics.missingWarIds = EXPECTED_ARCHIVE_WAR_IDS.filter((id) => !present.has(id));
  diagnostics.extraWarIds = [...present.values()].filter((id) => !EXPECTED_ARCHIVE_WAR_IDS.includes(id));
  diagnostics.exactMembershipOk =
    diagnostics.rowCountOk &&
    diagnostics.duplicates.length === 0 &&
    diagnostics.missingWarIds.length === 0 &&
    diagnostics.extraWarIds.length === 0;

  if (!diagnostics.rowCountOk) {
    errors.push(
      `rowcount mismatch: expected ${diagnostics.expectedRowCount}, got ${diagnostics.rowCount}`
    );
  }
  if (diagnostics.duplicates.length > 0) {
    errors.push(
      `duplicate archiveWarId values found: ${diagnostics.duplicates
        .map((d) => `${d.archiveWarId} (x${d.count})`)
        .join(", ")}`
    );
  }
  if (diagnostics.missingWarIds.length > 0) {
    errors.push(`missing required archiveWarId(s): ${diagnostics.missingWarIds.join(", ")}`);
  }
  if (diagnostics.extraWarIds.length > 0) {
    errors.push(`extra archiveWarId(s) not allowed: ${diagnostics.extraWarIds.join(", ")}`);
  }

  return { errors, diagnostics };
}

function printRowDiagnostics(rowResults) {
  line();
  console.log("PER-ROW FIELD VALIDATION");
  const table = rowResults.map((result) => ({
    index: result.index,
    archiveWarId: result.archiveWarId ?? "invalid",
    ok: result.ok,
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
  }));
  console.table(table);

  for (const result of rowResults) {
    if (result.errors.length === 0 && result.warnings.length === 0) continue;
    console.log(`row[${result.index}] archiveWarId=${result.archiveWarId ?? "invalid"}`);
    for (const err of result.errors) {
      console.log(`  - ERROR: ${err}`);
    }
    for (const warning of result.warnings) {
      console.log(`  - WARNING: ${warning}`);
    }
  }
}

function printIdentityProtections() {
  line();
  console.log("PHASE 2 IDENTITY PROTECTION RULES (MUST REMAIN UNCHANGED IN PATCHING)");
  for (const field of IDENTITY_PROTECTED_FIELDS) {
    console.log(`- ${field}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.file) {
    throw new Error(`Missing required --file argument.\n\n${usage()}`);
  }

  const schema = loadJsonFile(args.schemaFile, "schema");
  const staged = loadJsonFile(args.file, "staged correction file");

  line();
  console.log("PHASE 2 STAGED CORRECTION VALIDATOR (DRY-RUN ONLY)");
  console.log(`schemaFile: ${schema.fullPath}`);
  console.log(`stagedFile: ${staged.fullPath}`);
  line();

  if (!Array.isArray(staged.parsed)) {
    console.log("FAIL");
    console.log("Staged correction file must be a JSON array.");
    process.exit(2);
  }

  const rowResults = staged.parsed.map((row, index) => validateRow(row, index));
  const membership = buildMembershipChecks(staged.parsed);

  line();
  console.log("ROWCOUNT AND MEMBERSHIP CHECK");
  console.table([
    {
      check: "rowcount",
      pass: membership.diagnostics.rowCountOk,
      expected: membership.diagnostics.expectedRowCount,
      actual: membership.diagnostics.rowCount,
    },
    {
      check: "exact_membership",
      pass: membership.diagnostics.exactMembershipOk,
      expected: EXPECTED_ARCHIVE_WAR_IDS.join(", "),
      actual: staged.parsed
        .map((row) => (Number.isInteger(row.archiveWarId) ? row.archiveWarId : "invalid"))
        .join(", "),
    },
    {
      check: "duplicate_archiveWarId",
      pass: membership.diagnostics.duplicates.length === 0,
      expected: 0,
      actual: membership.diagnostics.duplicates.length,
    },
  ]);

  if (membership.diagnostics.duplicates.length > 0) {
    console.table(membership.diagnostics.duplicates);
  }
  if (membership.diagnostics.missingWarIds.length > 0) {
    console.log(`Missing archiveWarId(s): ${membership.diagnostics.missingWarIds.join(", ")}`);
  }
  if (membership.diagnostics.extraWarIds.length > 0) {
    console.log(`Extra archiveWarId(s): ${membership.diagnostics.extraWarIds.join(", ")}`);
  }

  printRowDiagnostics(rowResults);
  printIdentityProtections();

  const rowErrors = rowResults.reduce((sum, row) => sum + row.errors.length, 0);
  const rowWarnings = rowResults.reduce((sum, row) => sum + row.warnings.length, 0);
  const membershipErrors = membership.errors.length;
  const overallPass = membershipErrors === 0 && rowErrors === 0;

  line();
  console.log("OVERALL SUMMARY");
  console.table([
    { metric: "rows_checked", value: rowResults.length },
    { metric: "row_errors", value: rowErrors },
    { metric: "row_warnings", value: rowWarnings },
    { metric: "membership_errors", value: membershipErrors },
    { metric: "overall_pass", value: overallPass },
  ]);

  if (!overallPass) {
    console.log("FAIL: staged corrections are not valid for Phase 2 pre-apply.");
    process.exit(2);
  }

  console.log("PASS: staged corrections are valid for Phase 2 pre-apply.");
}

try {
  main();
} catch (error) {
  console.error(
    "[phase2-validator] fatal:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
}

