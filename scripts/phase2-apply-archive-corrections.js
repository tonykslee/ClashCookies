#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 2 archive/history correction apply script.
 *
 * Scope (and only scope):
 * - ClanWarHistory (target warIds)
 * - WarLookup (target warIds)
 *
 * Defaults to dry-run. Writes require explicit --apply.
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();

const DEFAULT_TARGET_FILE = path.resolve(
  process.cwd(),
  "scripts/phase2-targets-staging.json"
);

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

function line() {
  console.log("=".repeat(104));
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTag(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function isIsoUtc(input) {
  if (typeof input !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return false;
  const parsed = new Date(input);
  return !Number.isNaN(parsed.getTime());
}

function readJson(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
  return { fullPath, parsed: JSON.parse(raw) };
}

function parseTargetWarIdsCsv(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("--target-war-ids must be a non-empty CSV string.");
  }
  const tokens = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("--target-war-ids did not contain any IDs.");
  }
  const ids = tokens.map((token) => Number.parseInt(token, 10));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`--target-war-ids contains invalid IDs: ${input}`);
  }
  return ids;
}

function parseTargetWarIdsFromConfig(config, sourceLabel) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Target config must be a JSON object: ${sourceLabel}`);
  }
  const idsRaw =
    config.archiveWarIds ??
    config.targetArchiveWarIds ??
    config.targetWarIds;
  if (!Array.isArray(idsRaw)) {
    throw new Error(
      `Target config must contain an array field: archiveWarIds (or targetArchiveWarIds/targetWarIds) in ${sourceLabel}`
    );
  }
  const ids = idsRaw.map((v) => Number(v));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`Target config has invalid archive IDs in ${sourceLabel}`);
  }
  return ids;
}

function buildTargetSpec(args) {
  if (args.targetFile && args.targetWarIds) {
    throw new Error("Provide only one of --target-file or --target-war-ids.");
  }

  let warIds;
  let source;
  if (args.targetWarIds) {
    warIds = parseTargetWarIdsCsv(args.targetWarIds);
    source = "cli:--target-war-ids";
  } else {
    const targetFilePath = args.targetFile
      ? path.resolve(process.cwd(), args.targetFile)
      : DEFAULT_TARGET_FILE;
    const cfg = readJson(targetFilePath);
    warIds = parseTargetWarIdsFromConfig(cfg.parsed, cfg.fullPath);
    source = `file:${cfg.fullPath}`;
  }

  const seen = new Set();
  const duplicates = [];
  for (const id of warIds) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate target archiveWarId(s): ${[...new Set(duplicates)].join(", ")}`);
  }
  if (warIds.length === 0) {
    throw new Error("Target archive war ID set cannot be empty.");
  }

  return { source, warIds, warIdSet: new Set(warIds) };
}

function parseArgs(argv) {
  const out = {
    stagedFile: null,
    targetFile: null,
    targetWarIds: null,
    apply: false,
    backupDir: "scripts/repair-backups",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--staged-file") {
      out.stagedFile = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--target-file") {
      out.targetFile = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--target-war-ids") {
      out.targetWarIds = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--backup-dir") {
      out.backupDir = argv[i + 1] ?? out.backupDir;
      i += 1;
      continue;
    }
    if (token === "--apply") {
      out.apply = true;
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
    "  node scripts/phase2-apply-archive-corrections.js --staged-file <path-to-staged-correction.json> [target options]",
    "",
    "Target options (choose one):",
    "  --target-file <path>          JSON config with archive target IDs",
    "  --target-war-ids <csv>        Inline CSV IDs, e.g. 1000026,1000027,...",
    "",
    "Options:",
    "  --apply                 Execute writes. Without this flag script is dry-run only.",
    "  --backup-dir <path>     Backup directory (default: scripts/repair-backups)",
    "",
    "Default target:",
    `  --target-file ${DEFAULT_TARGET_FILE}`,
  ].join("\n");
}

function validateStagedRow(row, index, targetSpec) {
  const errors = [];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return {
      index,
      archiveWarId: null,
      errors: ["row must be an object"],
    };
  }

  const unknownFields = Object.keys(row).filter((k) => !REQUIRED_FIELDS.includes(k));
  if (unknownFields.length > 0) {
    errors.push(`unexpected fields: ${unknownFields.join(", ")}`);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in row)) errors.push(`missing required field: ${field}`);
  }

  if (!Number.isInteger(row.archiveWarId)) {
    errors.push("archiveWarId must be an integer");
  } else if (!targetSpec.warIdSet.has(row.archiveWarId)) {
    errors.push(`archiveWarId ${row.archiveWarId} is outside target set`);
  }

  const clanTag = normalizeTag(row.clanTag);
  const opponentTag = normalizeTag(row.opponentTag);
  if (!/^#[A-Z0-9]+$/.test(clanTag)) errors.push("clanTag must match ^#[A-Z0-9]+$");
  if (!/^#[A-Z0-9]+$/.test(opponentTag)) errors.push("opponentTag must match ^#[A-Z0-9]+$");

  if (!isIsoUtc(row.warStartTime)) errors.push("warStartTime must be ISO UTC");
  if (!isIsoUtc(row.warEndTime)) errors.push("warEndTime must be ISO UTC");
  if (isIsoUtc(row.warStartTime) && isIsoUtc(row.warEndTime)) {
    const startMs = new Date(row.warStartTime).getTime();
    const endMs = new Date(row.warEndTime).getTime();
    if (endMs < startMs) errors.push("warEndTime must be >= warStartTime");
  }

  if (!Number.isInteger(row.clanStars) || row.clanStars < 0 || row.clanStars > 150) {
    errors.push("clanStars must be integer in [0,150]");
  }
  if (!Number.isInteger(row.opponentStars) || row.opponentStars < 0 || row.opponentStars > 150) {
    errors.push("opponentStars must be integer in [0,150]");
  }
  if (
    typeof row.clanDestruction !== "number" ||
    Number.isNaN(row.clanDestruction) ||
    row.clanDestruction < 0 ||
    row.clanDestruction > 100
  ) {
    errors.push("clanDestruction must be number in [0,100]");
  }
  if (
    typeof row.opponentDestruction !== "number" ||
    Number.isNaN(row.opponentDestruction) ||
    row.opponentDestruction < 0 ||
    row.opponentDestruction > 100
  ) {
    errors.push("opponentDestruction must be number in [0,100]");
  }

  if (!ACTUAL_OUTCOME_ENUM.has(row.actualOutcome)) {
    errors.push("actualOutcome must be WIN|LOSE|TIE|UNKNOWN (uppercase)");
  }
  if (!WAR_LOOKUP_RESULT_ENUM.has(row.warLookupResult)) {
    errors.push("warLookupResult must be win|lose|tie|unknown (lowercase)");
  }

  return {
    index,
    archiveWarId: Number.isInteger(row.archiveWarId) ? row.archiveWarId : null,
    errors,
  };
}

function validateStagedFile(stagedRows, targetSpec) {
  const errors = [];
  if (!Array.isArray(stagedRows)) {
    return { errors: ["staged file must be a JSON array"], rowResults: [], byWarId: new Map() };
  }

  if (stagedRows.length !== targetSpec.warIds.length) {
    errors.push(
      `rowcount mismatch: expected ${targetSpec.warIds.length}, got ${stagedRows.length}`
    );
  }

  const rowResults = stagedRows.map((row, index) =>
    validateStagedRow(row, index, targetSpec)
  );
  for (const result of rowResults) {
    for (const rowError of result.errors) {
      errors.push(`row[${result.index}] ${rowError}`);
    }
  }

  const byWarId = new Map();
  for (const row of stagedRows) {
    if (!Number.isInteger(row.archiveWarId)) continue;
    const existing = byWarId.get(row.archiveWarId) ?? [];
    existing.push(row);
    byWarId.set(row.archiveWarId, existing);
  }
  const duplicates = [...byWarId.entries()].filter(([, rows]) => rows.length > 1);
  if (duplicates.length > 0) {
    errors.push(
      `duplicate archiveWarId values: ${duplicates
        .map(([warId, rows]) => `${warId} (x${rows.length})`)
        .join(", ")}`
    );
  }

  const present = new Set([...byWarId.keys()]);
  const missing = targetSpec.warIds.filter((warId) => !present.has(warId));
  const extras = [...present].filter((warId) => !targetSpec.warIdSet.has(warId));
  if (missing.length > 0) errors.push(`missing archiveWarId values: ${missing.join(", ")}`);
  if (extras.length > 0) errors.push(`unexpected archiveWarId values: ${extras.join(", ")}`);

  return { errors, rowResults, byWarId };
}

function summarizeDiff(beforeCwh, beforeWl, stagedByWarId) {
  const rows = [];
  for (const cwh of beforeCwh) {
    const staged = stagedByWarId.get(cwh.warId);
    const wl = beforeWl.find((row) => Number(row.warId) === cwh.warId) ?? null;
    rows.push({
      warId: cwh.warId,
      clanTag: cwh.clanTag,
      opponentTag: cwh.opponentTag,
      cwhClanStarsBefore: cwh.clanStars,
      cwhClanStarsAfter: staged.clanStars,
      cwhOpponentStarsBefore: cwh.opponentStars,
      cwhOpponentStarsAfter: staged.opponentStars,
      cwhActualOutcomeBefore: cwh.actualOutcome,
      cwhActualOutcomeAfter: staged.actualOutcome,
      cwhWarEndBefore: cwh.warEndTime ? toIso(cwh.warEndTime) : null,
      cwhWarEndAfter: staged.warEndTime,
      wlResultBefore: wl?.result ?? null,
      wlResultAfter: staged.warLookupResult,
      wlEndBefore: wl?.endTime ? toIso(wl.endTime) : null,
      wlEndAfter: staged.warEndTime,
    });
  }
  return rows;
}

function patchWarLookupPayload(existingPayload, stagedRow) {
  if (!existingPayload || typeof existingPayload !== "object" || Array.isArray(existingPayload)) {
    throw new Error(`WarLookup payload must be an object for warId=${stagedRow.archiveWarId}`);
  }
  const payload = JSON.parse(JSON.stringify(existingPayload));
  if (!payload.warMeta || typeof payload.warMeta !== "object" || Array.isArray(payload.warMeta)) {
    throw new Error(`WarLookup payload.warMeta missing/invalid for warId=${stagedRow.archiveWarId}`);
  }
  if (!payload.score || typeof payload.score !== "object" || Array.isArray(payload.score)) {
    throw new Error(`WarLookup payload.score missing/invalid for warId=${stagedRow.archiveWarId}`);
  }

  const originalStart = payload.warMeta.startTime;
  const originalWarId = payload.warMeta.warId;

  payload.warMeta.endTime = stagedRow.warEndTime;
  payload.warMeta.result = stagedRow.warLookupResult;
  payload.score.clanStars = stagedRow.clanStars;
  payload.score.opponentStars = stagedRow.opponentStars;
  payload.score.clanDestruction = stagedRow.clanDestruction;
  payload.score.opponentDestruction = stagedRow.opponentDestruction;

  if (payload.warMeta.startTime !== originalStart) {
    throw new Error(`payload.warMeta.startTime mutated unexpectedly for warId=${stagedRow.archiveWarId}`);
  }
  if (payload.warMeta.warId !== originalWarId) {
    throw new Error(`payload.warMeta.warId mutated unexpectedly for warId=${stagedRow.archiveWarId}`);
  }

  return payload;
}

function writeBackup(backupDir, payload) {
  const dir = path.resolve(process.cwd(), backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(dir, `phase2-archive-backup-${ts}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outFile;
}

function mapResultToOutcome(result) {
  const normalized = String(result ?? "").trim().toLowerCase();
  if (normalized === "win") return "WIN";
  if (normalized === "lose") return "LOSE";
  if (normalized === "tie") return "TIE";
  if (normalized === "unknown") return "UNKNOWN";
  return null;
}

async function fetchTargetRows(targetSpec) {
  const cwhRows = await prisma.clanWarHistory.findMany({
    where: { warId: { in: targetSpec.warIds } },
    orderBy: { warId: "asc" },
  });
  const wlRows = await prisma.warLookup.findMany({
    where: { warId: { in: targetSpec.warIds.map(String) } },
    orderBy: { warId: "asc" },
  });
  return { cwhRows, wlRows };
}

function validateDbRows(cwhRows, wlRows, stagedByWarId, targetSpec) {
  const errors = [];
  if (cwhRows.length !== targetSpec.warIds.length) {
    errors.push(
      `ClanWarHistory rowcount mismatch: expected ${targetSpec.warIds.length}, got ${cwhRows.length}`
    );
  }
  if (wlRows.length !== targetSpec.warIds.length) {
    errors.push(
      `WarLookup rowcount mismatch: expected ${targetSpec.warIds.length}, got ${wlRows.length}`
    );
  }

  const cwhByWarId = new Map(cwhRows.map((row) => [row.warId, row]));
  const wlByWarId = new Map(wlRows.map((row) => [Number(row.warId), row]));

  for (const warId of targetSpec.warIds) {
    const staged = stagedByWarId.get(warId);
    const cwh = cwhByWarId.get(warId);
    const wl = wlByWarId.get(warId);
    if (!staged) {
      errors.push(`staged row missing for warId=${warId}`);
      continue;
    }
    if (!cwh) {
      errors.push(`ClanWarHistory missing target warId=${warId}`);
      continue;
    }
    if (!wl) {
      errors.push(`WarLookup missing target warId=${warId}`);
      continue;
    }

    if (normalizeTag(cwh.clanTag) !== normalizeTag(staged.clanTag)) {
      errors.push(`ClanWarHistory clanTag mismatch for warId=${warId}`);
    }
    if (normalizeTag(cwh.opponentTag ?? "") !== normalizeTag(staged.opponentTag)) {
      errors.push(`ClanWarHistory opponentTag mismatch for warId=${warId}`);
    }
    if (toIso(cwh.warStartTime) !== staged.warStartTime) {
      errors.push(`ClanWarHistory warStartTime mismatch for warId=${warId}`);
    }

    if (normalizeTag(wl.clanTag) !== normalizeTag(staged.clanTag)) {
      errors.push(`WarLookup clanTag mismatch for warId=${warId}`);
    }
    if (normalizeTag(wl.opponentTag ?? "") !== normalizeTag(staged.opponentTag)) {
      errors.push(`WarLookup opponentTag mismatch for warId=${warId}`);
    }
    if (toIso(wl.startTime) !== staged.warStartTime) {
      errors.push(`WarLookup startTime mismatch for warId=${warId}`);
    }

    if (toIso(cwh.warStartTime) !== toIso(wl.startTime)) {
      errors.push(`cross-table startTime mismatch for warId=${warId}`);
    }
    if (normalizeTag(cwh.clanTag) !== normalizeTag(wl.clanTag)) {
      errors.push(`cross-table clanTag mismatch for warId=${warId}`);
    }
    if (normalizeTag(cwh.opponentTag ?? "") !== normalizeTag(wl.opponentTag ?? "")) {
      errors.push(`cross-table opponentTag mismatch for warId=${warId}`);
    }
  }

  return { errors, cwhByWarId, wlByWarId };
}

async function runPostApplyVerification(beforeSnapshot, targetSpec) {
  const { cwhRows, wlRows } = await fetchTargetRows(targetSpec);
  const errors = [];

  if (cwhRows.length !== targetSpec.warIds.length) {
    errors.push(
      `post-apply ClanWarHistory rowcount mismatch: expected ${targetSpec.warIds.length}, got ${cwhRows.length}`
    );
  }
  if (wlRows.length !== targetSpec.warIds.length) {
    errors.push(
      `post-apply WarLookup rowcount mismatch: expected ${targetSpec.warIds.length}, got ${wlRows.length}`
    );
  }

  const cwhByWarId = new Map(cwhRows.map((row) => [row.warId, row]));
  const wlByWarId = new Map(wlRows.map((row) => [Number(row.warId), row]));

  const cwhIdentityKeys = new Set();
  for (const row of cwhRows) {
    const key = `${normalizeTag(row.clanTag)}|${normalizeTag(row.opponentTag ?? "")}|${toIso(row.warStartTime)}`;
    if (cwhIdentityKeys.has(key)) {
      errors.push(`duplicate ClanWarHistory identity detected post-apply: ${key}`);
    }
    cwhIdentityKeys.add(key);
  }

  for (const warId of targetSpec.warIds) {
    const cwh = cwhByWarId.get(warId);
    const wl = wlByWarId.get(warId);
    if (!cwh || !wl) continue;

    if (toIso(cwh.warStartTime) !== toIso(wl.startTime)) {
      errors.push(`post-apply cross-table startTime mismatch for warId=${warId}`);
    }
    if ((cwh.warEndTime ? toIso(cwh.warEndTime) : null) !== (wl.endTime ? toIso(wl.endTime) : null)) {
      errors.push(`post-apply cross-table endTime mismatch for warId=${warId}`);
    }

    const mappedOutcome = mapResultToOutcome(wl.result);
    if (mappedOutcome && cwh.actualOutcome && mappedOutcome !== cwh.actualOutcome) {
      errors.push(
        `post-apply result mismatch warId=${warId}: actualOutcome=${cwh.actualOutcome} warLookup.result=${wl.result}`
      );
    }

    const before = beforeSnapshot.byWarId.get(warId);
    if (before) {
      if (toIso(cwh.createdAt) !== before.cwhCreatedAt) {
        errors.push(`createdAt changed unexpectedly in ClanWarHistory warId=${warId}`);
      }
      if (normalizeTag(cwh.clanTag) !== before.clanTag) {
        errors.push(`clanTag changed unexpectedly in ClanWarHistory warId=${warId}`);
      }
      if (normalizeTag(cwh.opponentTag ?? "") !== before.opponentTag) {
        errors.push(`opponentTag changed unexpectedly in ClanWarHistory warId=${warId}`);
      }
      if (toIso(cwh.warStartTime) !== before.warStartTime) {
        errors.push(`warStartTime changed unexpectedly in ClanWarHistory warId=${warId}`);
      }
      if (wl.createdAt && toIso(wl.createdAt) !== before.wlCreatedAt) {
        errors.push(`createdAt changed unexpectedly in WarLookup warId=${warId}`);
      }

      const wlPayload = wl.payload;
      if (!wlPayload || typeof wlPayload !== "object" || Array.isArray(wlPayload)) {
        errors.push(`payload invalid post-apply for warId=${warId}`);
      } else {
        const warMeta = wlPayload.warMeta;
        if (!warMeta || typeof warMeta !== "object" || Array.isArray(warMeta)) {
          errors.push(`payload.warMeta invalid post-apply for warId=${warId}`);
        } else {
          if (String(warMeta.startTime ?? "") !== before.warMetaStartTime) {
            errors.push(`payload.warMeta.startTime changed unexpectedly for warId=${warId}`);
          }
          if (String(warMeta.warId ?? "") !== before.warMetaWarId) {
            errors.push(`payload.warMeta.warId changed unexpectedly for warId=${warId}`);
          }
        }
      }
    }
  }

  return { errors, cwhRows, wlRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.stagedFile) {
    throw new Error(`Missing --staged-file.\n\n${usage()}`);
  }

  const targetSpec = buildTargetSpec(args);
  const stagedInput = readJson(args.stagedFile);
  const stagedValidation = validateStagedFile(stagedInput.parsed, targetSpec);

  line();
  console.log("PHASE 2 APPLY SCRIPT (ARCHIVE/HISTORY)");
  console.log(`mode: ${args.apply ? "APPLY" : "DRY_RUN"}`);
  console.log(`stagedFile: ${stagedInput.fullPath}`);
  console.log(`targetSource: ${targetSpec.source}`);
  console.log(`targetWarIds: ${targetSpec.warIds.join(", ")}`);
  line();

  if (stagedValidation.rowResults.length > 0) {
    console.log("STAGED FILE PER-ROW VALIDATION");
    console.table(
      stagedValidation.rowResults.map((row) => ({
        row: row.index,
        archiveWarId: row.archiveWarId ?? "invalid",
        ok: row.errors.length === 0,
        errorCount: row.errors.length,
      }))
    );
  }

  if (stagedValidation.errors.length > 0) {
    line();
    console.log(`FAIL_CLOSED: staged file has ${stagedValidation.errors.length} error(s)`);
    for (const err of stagedValidation.errors) {
      console.log(`- ${err}`);
    }
    process.exitCode = 2;
    return;
  }

  const stagedByWarId = new Map();
  for (const row of stagedInput.parsed) {
    stagedByWarId.set(row.archiveWarId, row);
  }

  const { cwhRows, wlRows } = await fetchTargetRows(targetSpec);
  const dbValidation = validateDbRows(cwhRows, wlRows, stagedByWarId, targetSpec);
  if (dbValidation.errors.length > 0) {
    line();
    console.log(`FAIL_CLOSED: DB invariant checks failed (${dbValidation.errors.length})`);
    for (const err of dbValidation.errors) {
      console.log(`- ${err}`);
    }
    process.exitCode = 2;
    return;
  }

  const beforeDiff = summarizeDiff(cwhRows, wlRows, stagedByWarId);
  line();
  console.log("TARGET PKS");
  console.table(
    cwhRows.map((row) => ({
      warId: row.warId,
      clanTag: row.clanTag,
      opponentTag: row.opponentTag ?? null,
      warStartTime: toIso(row.warStartTime),
      warEndTime: row.warEndTime ? toIso(row.warEndTime) : null,
      cwhCreatedAt: toIso(row.createdAt),
    }))
  );
  console.log("PLANNED BEFORE/AFTER SUMMARY");
  console.table(beforeDiff);

  const beforeSnapshotByWar = new Map();
  for (const cwh of cwhRows) {
    const wl = wlRows.find((row) => Number(row.warId) === cwh.warId);
    const wlPayload = wl?.payload;
    const warMeta =
      wlPayload && typeof wlPayload === "object" && !Array.isArray(wlPayload)
        ? wlPayload.warMeta
        : null;
    beforeSnapshotByWar.set(cwh.warId, {
      clanTag: normalizeTag(cwh.clanTag),
      opponentTag: normalizeTag(cwh.opponentTag ?? ""),
      warStartTime: toIso(cwh.warStartTime),
      cwhCreatedAt: toIso(cwh.createdAt),
      wlCreatedAt: wl?.createdAt ? toIso(wl.createdAt) : null,
      warMetaStartTime:
        warMeta && typeof warMeta === "object" && !Array.isArray(warMeta)
          ? String(warMeta.startTime ?? "")
          : "",
      warMetaWarId:
        warMeta && typeof warMeta === "object" && !Array.isArray(warMeta)
          ? String(warMeta.warId ?? "")
          : "",
    });
  }

  const backupPayload = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    targetSource: targetSpec.source,
    targetWarIds: targetSpec.warIds,
    stagedFile: stagedInput.fullPath,
    stagedRows: stagedInput.parsed,
    before: {
      clanWarHistory: cwhRows.map((row) => ({
        warId: row.warId,
        clanTag: row.clanTag,
        opponentTag: row.opponentTag,
        warStartTime: toIso(row.warStartTime),
        warEndTime: row.warEndTime ? toIso(row.warEndTime) : null,
        clanStars: row.clanStars,
        opponentStars: row.opponentStars,
        clanDestruction: row.clanDestruction,
        opponentDestruction: row.opponentDestruction,
        actualOutcome: row.actualOutcome,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
      warLookup: wlRows.map((row) => ({
        warId: row.warId,
        clanTag: row.clanTag,
        opponentTag: row.opponentTag,
        startTime: toIso(row.startTime),
        endTime: row.endTime ? toIso(row.endTime) : null,
        result: row.result,
        payload: row.payload,
        createdAt: toIso(row.createdAt),
      })),
    },
    plannedChanges: beforeDiff,
  };
  const backupFile = writeBackup(args.backupDir, backupPayload);
  line();
  console.log(`Backup written: ${backupFile}`);

  if (!args.apply) {
    line();
    console.log("DRY RUN COMPLETE (NO WRITES EXECUTED)");
    return;
  }

  line();
  console.log("APPLY START");
  const applyResult = {
    cwhUpdated: [],
    wlUpdated: [],
  };

  await prisma.$transaction(async (tx) => {
    for (const warId of targetSpec.warIds) {
      const staged = stagedByWarId.get(warId);
      if (!staged) {
        throw new Error(`staged row missing inside apply transaction for warId=${warId}`);
      }
      const cwh = dbValidation.cwhByWarId.get(warId);
      const wl = dbValidation.wlByWarId.get(warId);
      if (!cwh || !wl) {
        throw new Error(`target row missing inside apply transaction for warId=${warId}`);
      }

      const cwhUpdate = await tx.clanWarHistory.updateMany({
        where: {
          warId,
          clanTag: cwh.clanTag,
          opponentTag: cwh.opponentTag,
          warStartTime: cwh.warStartTime,
        },
        data: {
          clanStars: staged.clanStars,
          opponentStars: staged.opponentStars,
          clanDestruction: staged.clanDestruction,
          opponentDestruction: staged.opponentDestruction,
          actualOutcome: staged.actualOutcome,
          warEndTime: new Date(staged.warEndTime),
        },
      });
      if (cwhUpdate.count !== 1) {
        throw new Error(`ClanWarHistory update affected ${cwhUpdate.count} rows for warId=${warId}`);
      }
      applyResult.cwhUpdated.push({
        warId,
        clanTag: cwh.clanTag,
        beforeWarEndTime: cwh.warEndTime ? toIso(cwh.warEndTime) : null,
        afterWarEndTime: staged.warEndTime,
        beforeActualOutcome: cwh.actualOutcome,
        afterActualOutcome: staged.actualOutcome,
      });

      const patchedPayload = patchWarLookupPayload(wl.payload, staged);
      const wlUpdate = await tx.warLookup.updateMany({
        where: {
          warId: String(warId),
          clanTag: wl.clanTag,
          opponentTag: wl.opponentTag,
          startTime: wl.startTime,
        },
        data: {
          endTime: new Date(staged.warEndTime),
          result: staged.warLookupResult,
          payload: patchedPayload,
        },
      });
      if (wlUpdate.count !== 1) {
        throw new Error(`WarLookup update affected ${wlUpdate.count} rows for warId=${warId}`);
      }
      applyResult.wlUpdated.push({
        warId,
        clanTag: wl.clanTag,
        beforeEndTime: wl.endTime ? toIso(wl.endTime) : null,
        afterEndTime: staged.warEndTime,
        beforeResult: wl.result,
        afterResult: staged.warLookupResult,
      });
    }
  });

  line();
  console.log("APPLY SUMMARY");
  console.log(`ClanWarHistory rows updated: ${applyResult.cwhUpdated.length}`);
  console.table(applyResult.cwhUpdated);
  console.log(`WarLookup rows updated: ${applyResult.wlUpdated.length}`);
  console.table(applyResult.wlUpdated);

  const postVerify = await runPostApplyVerification(
    { byWarId: beforeSnapshotByWar },
    targetSpec
  );
  line();
  console.log("POST-APPLY VERIFICATION");
  console.table([
    { metric: "cwhRowcount", value: postVerify.cwhRows.length },
    { metric: "wlRowcount", value: postVerify.wlRows.length },
    { metric: "verificationErrors", value: postVerify.errors.length },
  ]);
  if (postVerify.errors.length > 0) {
    for (const err of postVerify.errors) {
      console.log(`- ${err}`);
    }
    throw new Error("Post-apply verification failed.");
  }

  line();
  console.log("APPLY COMPLETE");
}

main()
  .catch((error) => {
    console.error(
      "[phase2-apply] fatal:",
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

