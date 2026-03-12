#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 1 split-war repair apply script (WarEvent-only).
 *
 * Safety model:
 * - default is NO-WRITE (preview only)
 * - requires explicit --apply for delete operations
 * - aborts on invariant failures or out-of-scope rows
 * - aborts on candidate-count mismatch unless override is explicitly passed
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();

function normalizeTag(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function parseIsoDate(name, value) {
  const parsed = new Date(value);
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function assertNumericId(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }
  return Math.trunc(n);
}

function parseArgs(argv) {
  const out = {
    mappingFile: null,
    guildId: null,
    windowStart: null,
    windowEnd: null,
    apply: false,
    expectedCount: 8,
    allowCountMismatch: false,
    backupDir: "scripts/repair-backups",
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
    if (token === "--expected-count") {
      out.expectedCount = assertNumericId("expected-count", argv[i + 1] ?? null);
      i += 1;
      continue;
    }
    if (token === "--backup-dir") {
      out.backupDir = argv[i + 1] ?? out.backupDir;
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
    throw new Error(`Unknown arg: ${token}`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/phase1-split-war-apply.js \\",
    "    --mapping-file scripts/phase1-split-war-mapping-2026-03-11.json \\",
    "    --guild-id 1324040917602013261 \\",
    "    --window-start 2026-03-11T08:40:00.000Z \\",
    "    --window-end 2026-03-11T09:10:00.000Z \\",
    "    --expected-count 8",
    "",
    "Optional:",
    "  --apply                 Execute deletes (default is no-write preview)",
    "  --allow-count-mismatch  Permit apply when candidate count != expected count",
    "  --backup-dir <dir>      Backup directory (default scripts/repair-backups)",
  ].join("\n");
}

function line() {
  console.log("=".repeat(88));
}

function loadMapping(filePath, requiredGuildId) {
  const full = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Mapping file must be a JSON array.");
  }
  const rows = parsed.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`Mapping row ${index} must be an object.`);
    }
    const guildId = String(row.guildId ?? "").trim();
    const clanTag = normalizeTag(row.clanTag);
    const opponentTag = normalizeTag(row.opponentTag);
    const warStartTime = parseIsoDate(`mapping[${index}].warStartTime`, row.warStartTime);
    const oldWarId = assertNumericId(`mapping[${index}].oldWarId`, row.oldWarId);
    const splitWarId = assertNumericId(`mapping[${index}].splitWarId`, row.splitWarId);
    if (!guildId) throw new Error(`Mapping row ${index}: guildId is required.`);
    if (!clanTag) throw new Error(`Mapping row ${index}: clanTag is required.`);
    if (!opponentTag) throw new Error(`Mapping row ${index}: opponentTag is required.`);
    if (oldWarId === splitWarId) {
      throw new Error(`Mapping row ${index}: oldWarId and splitWarId must differ.`);
    }
    return {
      guildId,
      clanTag,
      opponentTag,
      warStartTime,
      oldWarId,
      splitWarId,
    };
  });

  const filtered = rows.filter((r) => r.guildId === requiredGuildId);
  if (filtered.length === 0) {
    throw new Error(`No mapping rows found for guildId=${requiredGuildId}.`);
  }
  return filtered;
}

async function validateAndCollect(input) {
  const { mapping, guildId, windowStart, windowEnd } = input;
  const failures = [];
  const warnings = [];
  const mappingCheck = [];
  const candidates = [];
  const outOfScope = [];

  for (const m of mapping) {
    // Guild guardrail: split war identity must not appear in any OTHER guild-scoped table rows.
    const crossGuildRefs = await prisma.$queryRaw`
      WITH refs AS (
        SELECT cps."guildId"::text AS "guildId"
        FROM "ClanPointsSync" cps
        WHERE cps."clanTag" = ${m.clanTag}
          AND cps."warId" = ${String(m.splitWarId)}
        UNION ALL
        SELECT cpm."guildId"::text AS "guildId"
        FROM "ClanPostedMessage" cpm
        WHERE cpm."clanTag" = ${m.clanTag}
          AND cpm."warId" = ${String(m.splitWarId)}
        UNION ALL
        SELECT wml."guildId"::text AS "guildId"
        FROM "WarMailLifecycle" wml
        WHERE wml."clanTag" = ${m.clanTag}
          AND wml."warId" = ${m.splitWarId}
        UNION ALL
        SELECT cw."guildId"::text AS "guildId"
        FROM "CurrentWar" cw
        WHERE cw."clanTag" = ${m.clanTag}
          AND cw."warId" = ${m.splitWarId}
      )
      SELECT DISTINCT "guildId" FROM refs
      WHERE "guildId" <> ${guildId}
    `;
    const crossGuild = Array.isArray(crossGuildRefs) ? crossGuildRefs : [];
    if (crossGuild.length > 0) {
      failures.push(
        `[${m.clanTag}] guild scope check failed: splitWarId=${m.splitWarId} has cross-guild references (${crossGuild
          .map((r) => String(r.guildId))
          .join(", ")}).`
      );
    }

    // Split-war scope on WarEvent.
    const splitAllEvents = await prisma.warEvent.findMany({
      where: { clanTag: m.clanTag, warId: m.splitWarId },
      select: { warId: true, clanTag: true, eventType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const oldAllEvents = await prisma.warEvent.findMany({
      where: { clanTag: m.clanTag, warId: m.oldWarId },
      select: { warId: true, clanTag: true, eventType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const splitInScope = splitAllEvents.filter(
      (r) =>
        r.eventType === "battle_day" &&
        r.createdAt.getTime() >= windowStart.getTime() &&
        r.createdAt.getTime() <= windowEnd.getTime()
    );
    const splitOutScope = splitAllEvents.filter(
      (r) =>
        !(
          r.eventType === "battle_day" &&
          r.createdAt.getTime() >= windowStart.getTime() &&
          r.createdAt.getTime() <= windowEnd.getTime()
        )
    );

    // Continuity signal check on old ID.
    const hasOldLifecycleSignal =
      oldAllEvents.some((e) => e.eventType === "war_started") ||
      oldAllEvents.some((e) => e.eventType === "war_ended");
    if (!hasOldLifecycleSignal) {
      failures.push(
        `[${m.clanTag}] oldWarId=${m.oldWarId} missing lifecycle signal (war_started/war_ended).`
      );
    }

    // "same opponent / war-start identity" invariant proof from ClanWarHistory.
    const historyIdentity = await prisma.clanWarHistory.findFirst({
      where: {
        clanTag: m.clanTag,
        warStartTime: m.warStartTime,
        opponentTag: m.opponentTag,
      },
      select: { warId: true, warStartTime: true, opponentTag: true },
    });
    const hasHistoryIdentity = Boolean(historyIdentity);
    if (!hasHistoryIdentity) {
      failures.push(
        `[${m.clanTag}] missing ClanWarHistory identity proof for warStartTime=${m.warStartTime.toISOString()} opponent=${m.opponentTag}.`
      );
    }

    if (splitInScope.length !== 1) {
      failures.push(
        `[${m.clanTag}] expected exactly 1 in-scope split battle_day row on splitWarId=${m.splitWarId}, got ${splitInScope.length}.`
      );
    }
    if (splitOutScope.length > 0) {
      failures.push(
        `[${m.clanTag}] splitWarId=${m.splitWarId} has ${splitOutScope.length} out-of-scope WarEvent rows.`
      );
    }
    if (splitAllEvents.length === 0) {
      warnings.push(`[${m.clanTag}] splitWarId=${m.splitWarId} has no WarEvent rows.`);
    }

    for (const row of splitInScope) {
      candidates.push({
        warId: row.warId,
        clanTag: row.clanTag,
        eventType: row.eventType,
        createdAt: row.createdAt.toISOString(),
      });
    }
    for (const row of splitOutScope) {
      outOfScope.push({
        warId: row.warId,
        clanTag: row.clanTag,
        eventType: row.eventType,
        createdAt: row.createdAt.toISOString(),
      });
    }

    mappingCheck.push({
      clanTag: m.clanTag,
      oldWarId: m.oldWarId,
      splitWarId: m.splitWarId,
      guildScoped: crossGuild.length === 0,
      splitAllEvents: splitAllEvents.length,
      splitInScope: splitInScope.length,
      splitOutScope: splitOutScope.length,
      hasOldLifecycleSignal,
      hasHistoryIdentity,
    });
  }

  return {
    failures,
    warnings,
    mappingCheck,
    candidates,
    outOfScope,
  };
}

async function countScopedRows(mapping) {
  const counts = [];
  for (const m of mapping) {
    const splitCount = await prisma.warEvent.count({
      where: {
        clanTag: m.clanTag,
        warId: m.splitWarId,
      },
    });
    const oldCount = await prisma.warEvent.count({
      where: {
        clanTag: m.clanTag,
        warId: m.oldWarId,
      },
    });
    counts.push({
      clanTag: m.clanTag,
      oldWarId: m.oldWarId,
      oldCount,
      splitWarId: m.splitWarId,
      splitCount,
    });
  }
  return counts;
}

function writeBackupPayload(input) {
  const {
    backupDir,
    mappingFile,
    guildId,
    windowStart,
    windowEnd,
    candidates,
    mapping,
    fullRows,
  } = input;
  const dir = path.resolve(process.cwd(), backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dir, `phase1-warevent-backup-${stamp}.json`);
  const payload = {
    kind: "phase1_split_war_warevent_backup",
    createdAt: new Date().toISOString(),
    guildId,
    mappingFile: path.resolve(process.cwd(), mappingFile),
    maintenanceWindow: {
      start: windowStart.toISOString(),
      end: windowEnd.toISOString(),
    },
    mapping,
    candidateCount: candidates.length,
    candidateRows: candidates,
    fullWarEventRows: fullRows,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function applyDeletes(candidates) {
  const deleted = [];
  await prisma.$transaction(async (tx) => {
    for (const row of candidates) {
      await tx.warEvent.delete({
        where: {
          warId_clanTag_eventType: {
            warId: row.warId,
            clanTag: row.clanTag,
            eventType: row.eventType,
          },
        },
      });
      deleted.push({
        warId: row.warId,
        clanTag: row.clanTag,
        eventType: row.eventType,
        createdAt: row.createdAt,
      });
    }
  });
  return deleted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.mappingFile || !args.guildId || !args.windowStart || !args.windowEnd) {
    throw new Error(`Missing required arguments.\n\n${usage()}`);
  }

  const guildId = String(args.guildId).trim();
  const windowStart = parseIsoDate("window-start", args.windowStart);
  const windowEnd = parseIsoDate("window-end", args.windowEnd);
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw new Error("window-start must be before window-end.");
  }

  const mapping = loadMapping(args.mappingFile, guildId);

  line();
  console.log("PHASE 1 APPLY (WAR-EVENT ONLY)");
  console.log(`mode: ${args.apply ? "APPLY" : "NO-WRITE PREVIEW"}`);
  console.log(`guildId: ${guildId}`);
  console.log(`mappingFile: ${path.resolve(process.cwd(), args.mappingFile)}`);
  console.log(`maintenanceWindowStart: ${windowStart.toISOString()}`);
  console.log(`maintenanceWindowEnd:   ${windowEnd.toISOString()}`);
  console.log(`expectedCandidateCount: ${args.expectedCount}`);
  console.log(`allowCountMismatch: ${args.allowCountMismatch ? "1" : "0"}`);
  line();

  const beforeCounts = await countScopedRows(mapping);
  console.log("BEFORE COUNTS");
  console.table(beforeCounts);

  const collected = await validateAndCollect({
    mapping,
    guildId,
    windowStart,
    windowEnd,
  });

  line();
  console.log("MAPPING CHECK");
  console.table(collected.mappingCheck);

  line();
  console.log(`CANDIDATE PKS (WarEvent): ${collected.candidates.length}`);
  if (collected.candidates.length > 0) {
    console.table(collected.candidates);
  }

  line();
  console.log(`OUT-OF-SCOPE ROWS: ${collected.outOfScope.length}`);
  if (collected.outOfScope.length > 0) {
    console.table(collected.outOfScope);
  }

  if (collected.warnings.length > 0) {
    line();
    console.log(`WARNINGS: ${collected.warnings.length}`);
    for (const msg of collected.warnings) {
      console.log(`- ${msg}`);
    }
  }

  const hardFailures = [...collected.failures];
  if (collected.outOfScope.length > 0) {
    hardFailures.push("Out-of-scope rows detected.");
  }

  const countMismatch = collected.candidates.length !== args.expectedCount;
  if (countMismatch && !args.allowCountMismatch) {
    hardFailures.push(
      `Candidate count mismatch: expected=${args.expectedCount}, actual=${collected.candidates.length}.`
    );
  }

  if (hardFailures.length > 0) {
    line();
    console.log(`ABORT: ${hardFailures.length} failure(s)`);
    for (const msg of hardFailures) {
      console.log(`- ${msg}`);
    }
    process.exitCode = 2;
    return;
  }

  const fullBackupRows = await prisma.warEvent.findMany({
    where: {
      OR: collected.candidates.map((c) => ({
        warId: c.warId,
        clanTag: c.clanTag,
        eventType: c.eventType,
      })),
    },
    orderBy: [{ clanTag: "asc" }, { warId: "asc" }, { eventType: "asc" }],
  });

  const backupPath = writeBackupPayload({
    backupDir: args.backupDir,
    mappingFile: args.mappingFile,
    guildId,
    windowStart,
    windowEnd,
    candidates: collected.candidates,
    mapping,
    fullRows: fullBackupRows.map((r) => ({
      warId: r.warId,
      clanTag: r.clanTag,
      eventType: r.eventType,
      createdAt: r.createdAt.toISOString(),
      payload: r.payload,
    })),
  });
  line();
  console.log(`Backup exported: ${backupPath}`);

  if (!args.apply) {
    line();
    console.log("NO-WRITE PREVIEW COMPLETE (pass --apply to execute delete)");
    return;
  }

  line();
  console.log("APPLYING DELETES...");
  const deleted = await applyDeletes(collected.candidates);
  console.log(`Deleted rows: ${deleted.length}`);
  if (deleted.length > 0) {
    console.table(deleted);
  }

  const afterCounts = await countScopedRows(mapping);
  const verify = await validateAndCollect({
    mapping,
    guildId,
    windowStart,
    windowEnd,
  });
  const remainingCandidates = verify.candidates.length;
  const outOfScopeAfter = verify.outOfScope.length;

  line();
  console.log("AFTER COUNTS");
  console.table(afterCounts);

  line();
  console.log("POST-APPLY VERIFICATION");
  console.log(`remainingInScopeCandidates=${remainingCandidates}`);
  console.log(`outOfScopeRowsAfter=${outOfScopeAfter}`);
  console.log(`deletedPkCount=${deleted.length}`);

  const postFailures = [];
  if (remainingCandidates !== 0) {
    postFailures.push(`Expected zero remaining in-scope split artifacts, got ${remainingCandidates}.`);
  }
  if (outOfScopeAfter !== 0) {
    postFailures.push(`Expected zero out-of-scope rows after apply, got ${outOfScopeAfter}.`);
  }
  if (deleted.length !== collected.candidates.length) {
    postFailures.push(
      `Deleted PK count mismatch: expected ${collected.candidates.length}, got ${deleted.length}.`
    );
  }
  if (postFailures.length > 0) {
    line();
    console.log(`POST-APPLY FAILURES: ${postFailures.length}`);
    for (const msg of postFailures) {
      console.log(`- ${msg}`);
    }
    process.exitCode = 3;
    return;
  }

  line();
  console.log("APPLY COMPLETE");
}

main()
  .catch((error) => {
    console.error("[phase1-apply] fatal:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
