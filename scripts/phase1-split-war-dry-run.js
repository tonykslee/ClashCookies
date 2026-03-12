#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 1 split-war identity repair dry-run (read-only).
 *
 * This script does NOT execute any writes.
 * It prints:
 * - maintenance window
 * - mapping invariant checks
 * - before-counts by table/warId
 * - exact candidate PK sets for Phase 1
 * - out-of-scope rows that would block a safe write run
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

function parseArgs(argv) {
  const out = {
    mappingFile: null,
    guildId: null,
    windowStart: null,
    windowEnd: null,
    failOnWarnings: false,
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
    if (token === "--fail-on-warnings") {
      out.failOnWarnings = true;
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
    "  node scripts/phase1-split-war-dry-run.js \\",
    "    --mapping-file scripts/phase1-split-war-mapping-2026-03-11.json \\",
    "    --guild-id 1324040917602013261 \\",
    "    --window-start 2026-03-11T08:40:00.000Z \\",
    "    --window-end 2026-03-11T09:10:00.000Z",
    "",
    "Optional:",
    "  --fail-on-warnings   Exit non-zero if any warning is detected.",
  ].join("\n");
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

function line() {
  console.log("=".repeat(88));
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
  console.log("PHASE 1 DRY RUN ONLY");
  console.log(`guildId: ${guildId}`);
  console.log(`mappingFile: ${path.resolve(process.cwd(), args.mappingFile)}`);
  console.log(`maintenanceWindowStart: ${windowStart.toISOString()}`);
  console.log(`maintenanceWindowEnd:   ${windowEnd.toISOString()}`);
  console.log(`mappingRows: ${mapping.length}`);
  line();

  const warnings = [];
  const tableWarIds = new Set();
  for (const m of mapping) {
    tableWarIds.add(m.oldWarId);
    tableWarIds.add(m.splitWarId);
  }

  const beforeCounts = {
    warEvent: {},
    clanPostedMessage: {},
    clanPointsSync: {},
  };

  const invariantRows = [];
  const candidate = {
    clanPointsSyncUpdates: [],
    warEventDeletes: [],
    clanPostedMessageDeletes: [],
  };
  const outOfScope = {
    warEventSplitRows: [],
    clanPostedMessageSplitRows: [],
    clanPointsSyncSplitRows: [],
  };

  for (const m of mapping) {
    const cpsBySplit = await prisma.clanPointsSync.findMany({
      where: {
        guildId,
        clanTag: m.clanTag,
        warId: String(m.splitWarId),
      },
      select: {
        id: true,
        clanTag: true,
        guildId: true,
        warId: true,
        warStartTime: true,
        opponentTag: true,
      },
      orderBy: { warStartTime: "asc" },
    });
    const cpsByOld = await prisma.clanPointsSync.findMany({
      where: {
        guildId,
        clanTag: m.clanTag,
        warId: String(m.oldWarId),
      },
      select: {
        id: true,
        warId: true,
        warStartTime: true,
        opponentTag: true,
      },
      orderBy: { warStartTime: "asc" },
    });
    const cpsCanonicalConflict = await prisma.clanPointsSync.findFirst({
      where: {
        guildId,
        clanTag: m.clanTag,
        warStartTime: m.warStartTime,
        warId: String(m.oldWarId),
      },
      select: { id: true, warId: true, warStartTime: true },
    });

    const splitBattleDayEvents = await prisma.warEvent.findMany({
      where: {
        clanTag: m.clanTag,
        warId: m.splitWarId,
        eventType: "battle_day",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        clanTag: true,
        warId: true,
        eventType: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const splitAllEvents = await prisma.warEvent.findMany({
      where: {
        clanTag: m.clanTag,
        warId: m.splitWarId,
      },
      select: {
        clanTag: true,
        warId: true,
        eventType: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const oldAllEvents = await prisma.warEvent.findMany({
      where: {
        clanTag: m.clanTag,
        warId: m.oldWarId,
      },
      select: {
        clanTag: true,
        warId: true,
        eventType: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const splitBattleDayNotifyMessages = await prisma.clanPostedMessage.findMany({
      where: {
        guildId,
        clanTag: m.clanTag,
        warId: String(m.splitWarId),
        type: "notify",
        event: "battle_day",
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        guildId: true,
        clanTag: true,
        warId: true,
        type: true,
        event: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const splitAllMessages = await prisma.clanPostedMessage.findMany({
      where: {
        guildId,
        clanTag: m.clanTag,
        warId: String(m.splitWarId),
      },
      select: {
        id: true,
        guildId: true,
        clanTag: true,
        warId: true,
        type: true,
        event: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    beforeCounts.warEvent[m.oldWarId] =
      (beforeCounts.warEvent[m.oldWarId] ?? 0) + oldAllEvents.length;
    beforeCounts.warEvent[m.splitWarId] =
      (beforeCounts.warEvent[m.splitWarId] ?? 0) + splitAllEvents.length;
    beforeCounts.clanPostedMessage[m.splitWarId] =
      (beforeCounts.clanPostedMessage[m.splitWarId] ?? 0) + splitAllMessages.length;
    beforeCounts.clanPointsSync[m.splitWarId] =
      (beforeCounts.clanPointsSync[m.splitWarId] ?? 0) + cpsBySplit.length;
    beforeCounts.clanPointsSync[m.oldWarId] =
      (beforeCounts.clanPointsSync[m.oldWarId] ?? 0) + cpsByOld.length;

    const sameOpponentOnSplit = cpsBySplit.every(
      (r) => normalizeTag(r.opponentTag) === m.opponentTag
    );
    const sameStartIdentityOnSplit = cpsBySplit.every(
      (r) => r.warStartTime.getTime() === m.warStartTime.getTime()
    );

    const hasOldLifecycleSignal =
      oldAllEvents.some((e) => e.eventType === "war_started") ||
      oldAllEvents.some((e) => e.eventType === "war_ended");
    const splitOnlyBattleDayWithinWindow =
      splitAllEvents.length > 0 &&
      splitAllEvents.every(
        (e) =>
          e.eventType === "battle_day" &&
          e.createdAt.getTime() >= windowStart.getTime() &&
          e.createdAt.getTime() <= windowEnd.getTime()
      );

    if (cpsBySplit.length === 0) {
      warnings.push(
        `[${m.clanTag}] No ClanPointsSync row found for splitWarId=${m.splitWarId}; update candidate is empty.`
      );
    }
    if (!sameOpponentOnSplit) {
      warnings.push(
        `[${m.clanTag}] Opponent mismatch on split ClanPointsSync rows for splitWarId=${m.splitWarId}.`
      );
    }
    if (!sameStartIdentityOnSplit) {
      warnings.push(
        `[${m.clanTag}] warStartTime mismatch on split ClanPointsSync rows for splitWarId=${m.splitWarId}.`
      );
    }
    if (!hasOldLifecycleSignal) {
      warnings.push(
        `[${m.clanTag}] No old-war lifecycle signal found on oldWarId=${m.oldWarId} (war_started/war_ended missing).`
      );
    }
    if (!splitOnlyBattleDayWithinWindow) {
      warnings.push(
        `[${m.clanTag}] split WarEvent rows are not strictly battle_day within maintenance window for splitWarId=${m.splitWarId}.`
      );
    }
    if (cpsCanonicalConflict) {
      warnings.push(
        `[${m.clanTag}] Canonical ClanPointsSync row already exists for oldWarId=${m.oldWarId} at mapped warStartTime; update would be conflict-prone.`
      );
    }

    invariantRows.push({
      clanTag: m.clanTag,
      oldWarId: m.oldWarId,
      splitWarId: m.splitWarId,
      cpsSplitRows: cpsBySplit.length,
      cpsOldRows: cpsByOld.length,
      splitBattleDayEvents: splitBattleDayEvents.length,
      splitAllEvents: splitAllEvents.length,
      splitBattleDayNotifyMessages: splitBattleDayNotifyMessages.length,
      splitAllMessages: splitAllMessages.length,
      sameOpponentOnSplit,
      sameStartIdentityOnSplit,
      hasOldLifecycleSignal,
      splitOnlyBattleDayWithinWindow,
      canonicalConflict: Boolean(cpsCanonicalConflict),
    });

    for (const row of cpsBySplit) {
      candidate.clanPointsSyncUpdates.push({
        id: row.id,
        guildId,
        clanTag: row.clanTag,
        fromWarId: row.warId,
        toWarId: String(m.oldWarId),
        warStartTime: row.warStartTime.toISOString(),
        opponentTag: row.opponentTag,
      });
    }
    for (const row of splitBattleDayEvents) {
      candidate.warEventDeletes.push({
        warId: row.warId,
        clanTag: row.clanTag,
        eventType: row.eventType,
        createdAt: row.createdAt.toISOString(),
      });
    }
    for (const row of splitBattleDayNotifyMessages) {
      candidate.clanPostedMessageDeletes.push({
        id: row.id,
        guildId: row.guildId,
        clanTag: row.clanTag,
        warId: row.warId,
        type: row.type,
        event: row.event,
        createdAt: row.createdAt.toISOString(),
      });
    }

    const scopedWarEventKeys = new Set(
      splitBattleDayEvents.map((e) => `${e.warId}|${e.clanTag}|${e.eventType}|${e.createdAt.toISOString()}`)
    );
    for (const row of splitAllEvents) {
      const key = `${row.warId}|${row.clanTag}|${row.eventType}|${row.createdAt.toISOString()}`;
      if (!scopedWarEventKeys.has(key)) {
        outOfScope.warEventSplitRows.push({
          warId: row.warId,
          clanTag: row.clanTag,
          eventType: row.eventType,
          createdAt: row.createdAt.toISOString(),
        });
      }
    }

    const scopedMessageIds = new Set(splitBattleDayNotifyMessages.map((r) => r.id));
    for (const row of splitAllMessages) {
      if (!scopedMessageIds.has(row.id)) {
        outOfScope.clanPostedMessageSplitRows.push({
          id: row.id,
          guildId: row.guildId,
          clanTag: row.clanTag,
          warId: row.warId,
          type: row.type,
          event: row.event,
          createdAt: row.createdAt.toISOString(),
        });
      }
    }

    for (const row of cpsBySplit) {
      const isMappedIdentity =
        normalizeTag(row.opponentTag) === m.opponentTag &&
        row.warStartTime.getTime() === m.warStartTime.getTime();
      if (!isMappedIdentity) {
        outOfScope.clanPointsSyncSplitRows.push({
          id: row.id,
          guildId,
          clanTag: row.clanTag,
          warId: row.warId,
          warStartTime: row.warStartTime.toISOString(),
          opponentTag: row.opponentTag,
        });
      }
    }
  }

  line();
  console.log("MAPPING INVARIANT CHECK");
  console.table(invariantRows);

  line();
  console.log("BEFORE COUNTS (SCOPED)");
  const countRows = [];
  for (const tableName of ["warEvent", "clanPostedMessage", "clanPointsSync"]) {
    for (const warId of [...tableWarIds].sort((a, b) => a - b)) {
      countRows.push({
        table: tableName,
        warId,
        count: Number(beforeCounts[tableName][warId] ?? 0),
      });
    }
  }
  console.table(countRows);

  line();
  console.log("PHASE 1 CANDIDATE PK SETS (DRY RUN)");
  console.log(`ClanPointsSync update candidates: ${candidate.clanPointsSyncUpdates.length}`);
  if (candidate.clanPointsSyncUpdates.length > 0) {
    console.table(candidate.clanPointsSyncUpdates);
  }
  console.log(`WarEvent delete candidates: ${candidate.warEventDeletes.length}`);
  if (candidate.warEventDeletes.length > 0) {
    console.table(candidate.warEventDeletes);
  }
  console.log(`ClanPostedMessage delete candidates: ${candidate.clanPostedMessageDeletes.length}`);
  if (candidate.clanPostedMessageDeletes.length > 0) {
    console.table(candidate.clanPostedMessageDeletes);
  }

  line();
  console.log("OUT-OF-SCOPE SPLIT ROWS (MUST BE EMPTY BEFORE WRITE RUN)");
  console.log(`WarEvent out-of-scope rows: ${outOfScope.warEventSplitRows.length}`);
  if (outOfScope.warEventSplitRows.length > 0) {
    console.table(outOfScope.warEventSplitRows);
  }
  console.log(`ClanPostedMessage out-of-scope rows: ${outOfScope.clanPostedMessageSplitRows.length}`);
  if (outOfScope.clanPostedMessageSplitRows.length > 0) {
    console.table(outOfScope.clanPostedMessageSplitRows);
  }
  console.log(`ClanPointsSync out-of-scope rows: ${outOfScope.clanPointsSyncSplitRows.length}`);
  if (outOfScope.clanPointsSyncSplitRows.length > 0) {
    console.table(outOfScope.clanPointsSyncSplitRows);
  }

  line();
  if (warnings.length === 0) {
    console.log("Warnings: none");
  } else {
    console.log(`Warnings: ${warnings.length}`);
    for (const msg of warnings) {
      console.log(`- ${msg}`);
    }
  }

  const hasBlockingOutOfScope =
    outOfScope.warEventSplitRows.length > 0 ||
    outOfScope.clanPostedMessageSplitRows.length > 0 ||
    outOfScope.clanPointsSyncSplitRows.length > 0;
  const exitCode = args.failOnWarnings && (warnings.length > 0 || hasBlockingOutOfScope) ? 2 : 0;

  line();
  console.log("DRY RUN COMPLETE (NO WRITES EXECUTED)");
  console.log(`exitCode=${exitCode}`);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main()
  .catch((error) => {
    console.error("[phase1-dry-run] fatal:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

