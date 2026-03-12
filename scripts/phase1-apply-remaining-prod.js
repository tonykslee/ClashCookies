#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Production Phase 1 remaining apply script (fail-closed).
 *
 * Scope:
 * - ClanPointsSync split->old warId updates
 * - ClanPostedMessage split artifact deletes
 *
 * Excluded:
 * - WarEvent (no writes)
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();

const DEFAULT_EXPECTED_CPS_UPDATES = 7;
const DEFAULT_EXPECTED_CPM_DELETES = 9;

function usage() {
  return [
    "Usage:",
    "  node scripts/phase1-apply-remaining-prod.js \\",
    "    --mapping-file <path> \\",
    "    --guild-id <guildId> \\",
    "    --window-start <ISO-UTC> \\",
    "    --window-end <ISO-UTC>",
    "",
    "Options:",
    "  --apply                        Execute writes (default: dry-run only)",
    "  --backup-dir <path>            Backup directory (default: scripts/repair-backups)",
    "  --expected-cps-updates <int>   Default: 7",
    "  --expected-cpm-deletes <int>   Default: 9",
    "  --allow-count-mismatch         Allow candidate count mismatch (not recommended)",
    "  --help                         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    mappingFile: null,
    guildId: null,
    windowStart: null,
    windowEnd: null,
    apply: false,
    backupDir: "scripts/repair-backups",
    expectedCpsUpdates: DEFAULT_EXPECTED_CPS_UPDATES,
    expectedCpmDeletes: DEFAULT_EXPECTED_CPM_DELETES,
    allowCountMismatch: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mapping-file") {
      out.mappingFile = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--guild-id") {
      out.guildId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--window-start") {
      out.windowStart = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--window-end") {
      out.windowEnd = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--backup-dir") {
      out.backupDir = argv[i + 1] ?? out.backupDir;
      i += 1;
      continue;
    }
    if (token === "--expected-cps-updates") {
      out.expectedCpsUpdates = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    if (token === "--expected-cpm-deletes") {
      out.expectedCpmDeletes = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }
    if (token === "--allow-count-mismatch") {
      out.allowCountMismatch = true;
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

function line() {
  console.log("=".repeat(112));
}

function parseIsoUtcStrict(input, label) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} is required and must be ISO UTC.`);
  }
  if (!input.endsWith("Z")) {
    throw new Error(`${label} must be UTC (must end with "Z"). Received: ${input}`);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is invalid ISO datetime: ${input}`);
  }
  return parsed;
}

function normalizeTag(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function readMapping(mappingFilePath, expectedGuildId) {
  const fullPath = path.resolve(process.cwd(), mappingFilePath);
  const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Mapping file must be a JSON array: ${fullPath}`);
  }
  if (parsed.length === 0) {
    throw new Error(`Mapping file is empty: ${fullPath}`);
  }

  const issues = [];
  const splitSeen = new Set();
  const oldSeen = new Set();
  const clanSeen = new Set();

  const normalized = parsed.map((row, index) => {
    if (!row || typeof row !== "object") {
      issues.push(`row[${index}] must be an object`);
      return null;
    }

    const guildId = String(row.guildId ?? "");
    const clanTag = normalizeTag(row.clanTag);
    const opponentTag = normalizeTag(row.opponentTag);
    const oldWarId = Number(row.oldWarId);
    const splitWarId = Number(row.splitWarId);
    const warStartTimeRaw = row.warStartTime;

    if (guildId !== expectedGuildId) {
      issues.push(
        `row[${index}] guildId mismatch: expected ${expectedGuildId}, got ${guildId || "empty"}`
      );
    }
    if (!/^#[A-Z0-9]+$/.test(clanTag)) issues.push(`row[${index}] invalid clanTag: ${row.clanTag}`);
    if (!/^#[A-Z0-9]+$/.test(opponentTag)) {
      issues.push(`row[${index}] invalid opponentTag: ${row.opponentTag}`);
    }
    if (!Number.isInteger(oldWarId) || oldWarId <= 0) {
      issues.push(`row[${index}] invalid oldWarId: ${row.oldWarId}`);
    }
    if (!Number.isInteger(splitWarId) || splitWarId <= 0) {
      issues.push(`row[${index}] invalid splitWarId: ${row.splitWarId}`);
    }
    if (oldWarId === splitWarId) {
      issues.push(`row[${index}] oldWarId and splitWarId must differ (both ${oldWarId})`);
    }

    const warStartTime = parseIsoUtcStrict(String(warStartTimeRaw ?? ""), `row[${index}].warStartTime`);

    if (splitSeen.has(splitWarId)) issues.push(`duplicate splitWarId: ${splitWarId}`);
    if (oldSeen.has(oldWarId)) issues.push(`duplicate oldWarId: ${oldWarId}`);
    if (clanSeen.has(clanTag)) issues.push(`duplicate clanTag: ${clanTag}`);
    splitSeen.add(splitWarId);
    oldSeen.add(oldWarId);
    clanSeen.add(clanTag);

    return {
      guildId,
      clanTag,
      opponentTag,
      warStartTime,
      oldWarId,
      splitWarId,
    };
  });

  if (issues.length > 0) {
    throw new Error(`Mapping invariants failed:\n- ${issues.join("\n- ")}`);
  }

  return { fullPath, rows: normalized };
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function writeBackup(backupDir, payload) {
  const dir = path.resolve(process.cwd(), backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(dir, `phase1-remaining-prod-backup-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outPath;
}

function keyCpm(row) {
  return String(row.id);
}

function keyCps(row) {
  return String(row.id);
}

async function collectDryRunData({
  mappingRows,
  mappingBySplit,
  splitWarIdStrings,
  guildId,
  windowStart,
  windowEnd,
}) {
  const [cpmSplitRows, cpsSplitRows] = await Promise.all([
    prisma.clanPostedMessage.findMany({
      where: { warId: { in: splitWarIdStrings } },
      orderBy: [{ guildId: "asc" }, { warId: "asc" }, { clanTag: "asc" }],
      select: {
        id: true,
        guildId: true,
        clanTag: true,
        warId: true,
        type: true,
        event: true,
        createdAt: true,
        channelId: true,
        messageId: true,
      },
    }),
    prisma.clanPointsSync.findMany({
      where: { warId: { in: splitWarIdStrings } },
      orderBy: [{ guildId: "asc" }, { warId: "asc" }, { clanTag: "asc" }],
      select: {
        id: true,
        guildId: true,
        clanTag: true,
        opponentTag: true,
        warId: true,
        warStartTime: true,
        syncNum: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const cpmCandidates = cpmSplitRows.filter((row) => {
    const splitWarId = Number(row.warId);
    const mapping = mappingBySplit.get(splitWarId);
    if (!mapping) return false;
    return (
      row.guildId === guildId &&
      normalizeTag(row.clanTag) === mapping.clanTag &&
      row.type === "notify" &&
      row.event === "battle_day" &&
      row.createdAt >= windowStart &&
      row.createdAt <= windowEnd
    );
  });

  const cpmOutOfScope = cpmSplitRows.filter((row) => {
    const splitWarId = Number(row.warId);
    const mapping = mappingBySplit.get(splitWarId);
    if (!mapping) return true;
    const inScope =
      row.guildId === guildId &&
      normalizeTag(row.clanTag) === mapping.clanTag &&
      row.type === "notify" &&
      row.event === "battle_day" &&
      row.createdAt >= windowStart &&
      row.createdAt <= windowEnd;
    return !inScope;
  });

  const cpsCandidates = cpsSplitRows.filter((row) => {
    const splitWarId = Number(row.warId);
    const mapping = mappingBySplit.get(splitWarId);
    if (!mapping) return false;
    return row.guildId === guildId && normalizeTag(row.clanTag) === mapping.clanTag;
  });

  const cpsOutOfScope = cpsSplitRows.filter((row) => {
    const splitWarId = Number(row.warId);
    const mapping = mappingBySplit.get(splitWarId);
    if (!mapping) return true;
    const inScope = row.guildId === guildId && normalizeTag(row.clanTag) === mapping.clanTag;
    return !inScope;
  });

  const cpsConflicts = [];
  for (const row of cpsCandidates) {
    const splitWarId = Number(row.warId);
    const mapping = mappingBySplit.get(splitWarId);
    const conflict = await prisma.clanPointsSync.findFirst({
      where: {
        guildId,
        clanTag: normalizeTag(row.clanTag),
        warStartTime: row.warStartTime,
        NOT: { id: row.id },
      },
      select: {
        id: true,
        guildId: true,
        clanTag: true,
        warId: true,
        warStartTime: true,
      },
    });
    if (conflict) {
      cpsConflicts.push({
        candidateId: row.id,
        candidateSplitWarId: row.warId,
        targetOldWarId: String(mapping.oldWarId),
        conflict,
      });
    }
  }

  const cpmCrossGuildRows = cpmSplitRows.filter((row) => row.guildId !== guildId);
  const cpsCrossGuildRows = cpsSplitRows.filter((row) => row.guildId !== guildId);

  const cpsCandidateDetails = cpsCandidates.map((row) => {
    const mapping = mappingBySplit.get(Number(row.warId));
    return {
      ...row,
      targetOldWarId: String(mapping.oldWarId),
      targetOldWarIdNumber: mapping.oldWarId,
    };
  });

  return {
    raw: {
      cpmSplitRows,
      cpsSplitRows,
    },
    candidates: {
      cpm: cpmCandidates,
      cps: cpsCandidateDetails,
    },
    outOfScope: {
      cpm: cpmOutOfScope,
      cps: cpsOutOfScope,
    },
    crossGuild: {
      cpm: cpmCrossGuildRows,
      cps: cpsCrossGuildRows,
    },
    conflicts: {
      cps: cpsConflicts,
    },
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!args.mappingFile || !args.guildId || !args.windowStart || !args.windowEnd) {
    throw new Error(`Missing required arguments.\n\n${usage()}`);
  }
  if (!Number.isInteger(args.expectedCpsUpdates) || args.expectedCpsUpdates < 0) {
    throw new Error(`--expected-cps-updates must be a non-negative integer.`);
  }
  if (!Number.isInteger(args.expectedCpmDeletes) || args.expectedCpmDeletes < 0) {
    throw new Error(`--expected-cpm-deletes must be a non-negative integer.`);
  }

  const windowStart = parseIsoUtcStrict(args.windowStart, "--window-start");
  const windowEnd = parseIsoUtcStrict(args.windowEnd, "--window-end");
  if (windowEnd < windowStart) throw new Error(`--window-end must be >= --window-start`);

  const { fullPath: mappingFullPath, rows: mappingRows } = readMapping(args.mappingFile, args.guildId);
  const mappingBySplit = new Map(mappingRows.map((m) => [m.splitWarId, m]));
  const splitWarIdStrings = mappingRows.map((m) => String(m.splitWarId));

  line();
  console.log("PHASE 1 REMAINING APPLY (PRODUCTION-SAFE)");
  console.log(`mode: ${args.apply ? "APPLY" : "DRY_RUN"}`);
  console.log(`guildId: ${args.guildId}`);
  console.log(`mappingFile: ${mappingFullPath}`);
  console.log(`maintenanceWindowStart: ${windowStart.toISOString()}`);
  console.log(`maintenanceWindowEnd:   ${windowEnd.toISOString()}`);
  console.log(`mappingRows: ${mappingRows.length}`);
  console.log(`expectedCpsUpdates: ${args.expectedCpsUpdates}`);
  console.log(`expectedCpmDeletes: ${args.expectedCpmDeletes}`);
  console.log(`allowCountMismatch: ${args.allowCountMismatch ? 1 : 0}`);
  line();

  const snapshotBefore = await collectDryRunData({
    mappingRows,
    mappingBySplit,
    splitWarIdStrings,
    guildId: args.guildId,
    windowStart,
    windowEnd,
  });

  const actualCpsUpdates = snapshotBefore.candidates.cps.length;
  const actualCpmDeletes = snapshotBefore.candidates.cpm.length;
  const outOfScopeCount =
    snapshotBefore.outOfScope.cps.length + snapshotBefore.outOfScope.cpm.length;
  const crossGuildCount =
    snapshotBefore.crossGuild.cps.length + snapshotBefore.crossGuild.cpm.length;
  const cpsConflictCount = snapshotBefore.conflicts.cps.length;

  console.log("CANDIDATE SUMMARY");
  console.table([
    {
      metric: "ClanPointsSync update candidates",
      expected: args.expectedCpsUpdates,
      actual: actualCpsUpdates,
      pass: actualCpsUpdates === args.expectedCpsUpdates || args.allowCountMismatch,
    },
    {
      metric: "ClanPostedMessage delete candidates",
      expected: args.expectedCpmDeletes,
      actual: actualCpmDeletes,
      pass: actualCpmDeletes === args.expectedCpmDeletes || args.allowCountMismatch,
    },
    {
      metric: "Out-of-scope rows",
      expected: 0,
      actual: outOfScopeCount,
      pass: outOfScopeCount === 0,
    },
    {
      metric: "Cross-guild split references",
      expected: 0,
      actual: crossGuildCount,
      pass: crossGuildCount === 0,
    },
    {
      metric: "Canonical CPS conflicts",
      expected: 0,
      actual: cpsConflictCount,
      pass: cpsConflictCount === 0,
    },
  ]);
  line();

  console.log("CANDIDATE IDS");
  console.log("ClanPointsSync IDs:");
  snapshotBefore.candidates.cps.forEach((row) => {
    console.log(
      `- ${row.id} clan=${row.clanTag} split=${row.warId} -> old=${row.targetOldWarId} warStart=${toIso(
        row.warStartTime
      )}`
    );
  });
  console.log("ClanPostedMessage IDs:");
  snapshotBefore.candidates.cpm.forEach((row) => {
    console.log(`- ${row.id} clan=${row.clanTag} warId=${row.warId} createdAt=${toIso(row.createdAt)}`);
  });
  line();

  if (snapshotBefore.outOfScope.cpm.length > 0 || snapshotBefore.outOfScope.cps.length > 0) {
    console.log("OUT-OF-SCOPE ROWS (MUST BE EMPTY)");
    if (snapshotBefore.outOfScope.cps.length > 0) {
      console.log("ClanPointsSync out-of-scope:");
      console.table(
        snapshotBefore.outOfScope.cps.map((row) => ({
          id: row.id,
          guildId: row.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
          warStartTime: toIso(row.warStartTime),
        }))
      );
    }
    if (snapshotBefore.outOfScope.cpm.length > 0) {
      console.log("ClanPostedMessage out-of-scope:");
      console.table(
        snapshotBefore.outOfScope.cpm.map((row) => ({
          id: row.id,
          guildId: row.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
          type: row.type,
          event: row.event,
          createdAt: toIso(row.createdAt),
        }))
      );
    }
    line();
  }

  if (snapshotBefore.conflicts.cps.length > 0) {
    console.log("CPS CONFLICTS (MUST BE EMPTY)");
    console.table(snapshotBefore.conflicts.cps);
    line();
  }

  if (snapshotBefore.crossGuild.cpm.length > 0 || snapshotBefore.crossGuild.cps.length > 0) {
    console.log("CROSS-GUILD SPLIT REFERENCES (MUST BE EMPTY)");
    if (snapshotBefore.crossGuild.cps.length > 0) {
      console.table(
        snapshotBefore.crossGuild.cps.map((row) => ({
          id: row.id,
          guildId: row.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
        }))
      );
    }
    if (snapshotBefore.crossGuild.cpm.length > 0) {
      console.table(
        snapshotBefore.crossGuild.cpm.map((row) => ({
          id: row.id,
          guildId: row.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
        }))
      );
    }
    line();
  }

  const countMismatch =
    actualCpsUpdates !== args.expectedCpsUpdates || actualCpmDeletes !== args.expectedCpmDeletes;
  if (countMismatch && !args.allowCountMismatch) {
    throw new Error("Candidate count mismatch. Aborting (use --allow-count-mismatch to override).");
  }
  if (outOfScopeCount > 0) throw new Error("Out-of-scope rows detected. Aborting.");
  if (cpsConflictCount > 0) throw new Error("Canonical CPS conflicts detected. Aborting.");
  if (crossGuildCount > 0) throw new Error("Cross-guild split references detected. Aborting.");

  const backupPayload = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    guildId: args.guildId,
    mappingFile: mappingFullPath,
    maintenanceWindowStart: windowStart.toISOString(),
    maintenanceWindowEnd: windowEnd.toISOString(),
    expectedCounts: {
      cpsUpdates: args.expectedCpsUpdates,
      cpmDeletes: args.expectedCpmDeletes,
    },
    actualCounts: {
      cpsUpdates: actualCpsUpdates,
      cpmDeletes: actualCpmDeletes,
    },
    candidates: {
      cps: snapshotBefore.candidates.cps,
      cpm: snapshotBefore.candidates.cpm,
    },
    outOfScope: snapshotBefore.outOfScope,
    conflicts: snapshotBefore.conflicts,
    crossGuild: snapshotBefore.crossGuild,
  };
  const backupPath = writeBackup(args.backupDir, backupPayload);
  console.log(`Backup written: ${backupPath}`);
  line();

  if (!args.apply) {
    console.log("DRY RUN COMPLETE (NO WRITES EXECUTED)");
    return;
  }

  const cpsCandidateById = new Map(snapshotBefore.candidates.cps.map((row) => [row.id, row]));
  const cpmCandidateIds = snapshotBefore.candidates.cpm.map((row) => row.id);

  const touched = {
    cpsUpdatedIds: [],
    cpmDeletedIds: [],
  };

  await prisma.$transaction(async (tx) => {
    for (const row of snapshotBefore.candidates.cps) {
      const updated = await tx.clanPointsSync.updateMany({
        where: {
          id: row.id,
          guildId: args.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
        },
        data: {
          warId: row.targetOldWarId,
        },
      });
      if (updated.count !== 1) {
        throw new Error(`Expected 1 ClanPointsSync update for id=${row.id}; got ${updated.count}`);
      }
      touched.cpsUpdatedIds.push(row.id);
    }

    for (const row of snapshotBefore.candidates.cpm) {
      const deleted = await tx.clanPostedMessage.deleteMany({
        where: {
          id: row.id,
          guildId: args.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
          type: "notify",
          event: "battle_day",
          createdAt: {
            gte: windowStart,
            lte: windowEnd,
          },
        },
      });
      if (deleted.count !== 1) {
        throw new Error(`Expected 1 ClanPostedMessage delete for id=${row.id}; got ${deleted.count}`);
      }
      touched.cpmDeletedIds.push(row.id);
    }
  });

  const snapshotAfter = await collectDryRunData({
    mappingRows,
    mappingBySplit,
    splitWarIdStrings,
    guildId: args.guildId,
    windowStart,
    windowEnd,
  });

  const afterInScopeCps = snapshotAfter.candidates.cps.length;
  const afterInScopeCpm = snapshotAfter.candidates.cpm.length;
  const afterOutOfScopeCpsIds = new Set(snapshotAfter.outOfScope.cps.map(keyCps));
  const beforeOutOfScopeCpsIds = new Set(snapshotBefore.outOfScope.cps.map(keyCps));
  const afterOutOfScopeCpmIds = new Set(snapshotAfter.outOfScope.cpm.map(keyCpm));
  const beforeOutOfScopeCpmIds = new Set(snapshotBefore.outOfScope.cpm.map(keyCpm));

  const outOfScopeChanged =
    beforeOutOfScopeCpsIds.size !== afterOutOfScopeCpsIds.size ||
    beforeOutOfScopeCpmIds.size !== afterOutOfScopeCpmIds.size ||
    [...beforeOutOfScopeCpsIds].some((id) => !afterOutOfScopeCpsIds.has(id)) ||
    [...beforeOutOfScopeCpmIds].some((id) => !afterOutOfScopeCpmIds.has(id));

  const cpsVerifyRows = await prisma.clanPointsSync.findMany({
    where: { id: { in: touched.cpsUpdatedIds } },
    select: { id: true, warId: true },
  });
  const cpsVerifyProblems = cpsVerifyRows.filter(
    (row) => row.warId !== cpsCandidateById.get(row.id)?.targetOldWarId
  );

  line();
  console.log("POST-APPLY VERIFICATION");
  console.table([
    {
      check: "remaining in-scope ClanPointsSync split rows",
      expected: 0,
      actual: afterInScopeCps,
      pass: afterInScopeCps === 0,
    },
    {
      check: "remaining in-scope ClanPostedMessage split artifacts",
      expected: 0,
      actual: afterInScopeCpm,
      pass: afterInScopeCpm === 0,
    },
    {
      check: "out-of-scope rows unchanged",
      expected: true,
      actual: !outOfScopeChanged,
      pass: !outOfScopeChanged,
    },
    {
      check: "ClanPointsSync updated to target oldWarId",
      expected: 0,
      actual: cpsVerifyProblems.length,
      pass: cpsVerifyProblems.length === 0,
    },
  ]);
  console.log(`Updated ClanPointsSync IDs (${touched.cpsUpdatedIds.length}): ${touched.cpsUpdatedIds.join(", ")}`);
  console.log(`Deleted ClanPostedMessage IDs (${touched.cpmDeletedIds.length}): ${touched.cpmDeletedIds.join(", ")}`);
  line();

  if (afterInScopeCps !== 0 || afterInScopeCpm !== 0 || outOfScopeChanged || cpsVerifyProblems.length > 0) {
    throw new Error("Post-apply verification failed.");
  }

  console.log("APPLY COMPLETE");
}

run()
  .catch((error) => {
    console.error("[phase1-remaining-prod] fatal:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

