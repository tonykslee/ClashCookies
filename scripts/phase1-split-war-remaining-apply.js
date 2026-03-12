#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 1 remaining split-war repair apply script.
 *
 * Scope:
 * - ClanPointsSync split->old warId updates
 * - ClanPostedMessage split artifact deletes (notify/battle_day)
 *
 * No WarEvent writes are performed by this script.
 * Defaults to dry-run unless --apply is explicitly provided.
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();

const REQUIRED_GUILD_ID = "1474194205109780703";
const DEFAULT_EXPECTED_CPS_UPDATES = 6;
const DEFAULT_EXPECTED_CPM_DELETES = 8;

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

function parsePositiveInt(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Math.trunc(n);
}

function parseWarId(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${name}: ${value}`);
  }
  return Math.trunc(n);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function line() {
  console.log("=".repeat(96));
}

function parseArgs(argv) {
  const out = {
    mappingFile: null,
    guildId: null,
    windowStart: null,
    windowEnd: null,
    apply: false,
    allowCountMismatch: false,
    expectedCpsUpdates: DEFAULT_EXPECTED_CPS_UPDATES,
    expectedCpmDeletes: DEFAULT_EXPECTED_CPM_DELETES,
    backupDir: "scripts/repair-backups",
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
    if (token === "--expected-cps-updates") {
      out.expectedCpsUpdates = parsePositiveInt("expected-cps-updates", argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--expected-cpm-deletes") {
      out.expectedCpmDeletes = parsePositiveInt("expected-cpm-deletes", argv[i + 1]);
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
    if (token === "--allow-count-mismatch") {
      out.allowCountMismatch = true;
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
    "  node scripts/phase1-split-war-remaining-apply.js \\",
    "    --mapping-file scripts/phase1-split-war-mapping-2026-03-11-guild-1474194205109780703.json \\",
    "    --guild-id 1474194205109780703 \\",
    "    --window-start 2026-03-11T08:40:00.000Z \\",
    "    --window-end 2026-03-11T09:10:00.000Z",
    "",
    "Defaults:",
    `  --expected-cps-updates ${DEFAULT_EXPECTED_CPS_UPDATES}`,
    `  --expected-cpm-deletes ${DEFAULT_EXPECTED_CPM_DELETES}`,
    "  --backup-dir scripts/repair-backups",
    "",
    "Write mode:",
    "  --apply                Execute writes. Without this flag, script is dry-run only.",
    "  --allow-count-mismatch Allow candidate counts to differ from expected values.",
  ].join("\n");
}

function loadMapping(mappingFile, guildId) {
  const full = path.resolve(process.cwd(), mappingFile);
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Mapping file must be a JSON array.");
  }

  const rows = parsed.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`Mapping row ${index} must be an object.`);
    }
    const rowGuildId = String(row.guildId ?? "").trim();
    const clanTag = normalizeTag(row.clanTag);
    const opponentTag = normalizeTag(row.opponentTag);
    const warStartTime = parseIsoDate(`mapping[${index}].warStartTime`, row.warStartTime);
    const oldWarId = parseWarId(`mapping[${index}].oldWarId`, row.oldWarId);
    const splitWarId = parseWarId(`mapping[${index}].splitWarId`, row.splitWarId);

    if (!rowGuildId) throw new Error(`Mapping row ${index}: guildId is required.`);
    if (!clanTag) throw new Error(`Mapping row ${index}: clanTag is required.`);
    if (!opponentTag) throw new Error(`Mapping row ${index}: opponentTag is required.`);
    if (oldWarId === splitWarId) {
      throw new Error(`Mapping row ${index}: oldWarId and splitWarId must differ.`);
    }

    return {
      guildId: rowGuildId,
      clanTag,
      opponentTag,
      warStartTime,
      oldWarId,
      splitWarId,
    };
  });

  const filtered = rows.filter((row) => row.guildId === guildId);
  if (filtered.length === 0) {
    throw new Error(`No mapping rows found for guildId=${guildId}.`);
  }

  const dedupeKey = new Set();
  for (const row of filtered) {
    const key = `${row.clanTag}|${row.splitWarId}`;
    if (dedupeKey.has(key)) {
      throw new Error(`Duplicate mapping entry detected for ${key}.`);
    }
    dedupeKey.add(key);
  }

  return { fullPath: full, rows: filtered };
}

function asIso(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function collectState({ guildId, mappingRows, windowStart, windowEnd }) {
  const errors = [];
  const warnings = [];

  const splitWarIds = [...new Set(mappingRows.map((row) => String(row.splitWarId)))];
  const splitWarIdInts = [...new Set(mappingRows.map((row) => Number(row.splitWarId)))];
  const mappingBySplitAndClan = new Map(
    mappingRows.map((row) => [`${row.splitWarId}|${row.clanTag}`, row])
  );

  const allSplitCpsRows = await prisma.clanPointsSync.findMany({
    where: {
      guildId,
      warId: { in: splitWarIds },
    },
    orderBy: [{ warId: "asc" }, { clanTag: "asc" }, { warStartTime: "asc" }],
    select: {
      id: true,
      guildId: true,
      clanTag: true,
      warId: true,
      warStartTime: true,
      opponentTag: true,
      createdAt: true,
      updatedAt: true,
      syncNum: true,
    },
  });

  const allSplitCpmRows = await prisma.clanPostedMessage.findMany({
    where: {
      guildId,
      warId: { in: splitWarIds },
    },
    orderBy: [{ warId: "asc" }, { clanTag: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      guildId: true,
      clanTag: true,
      warId: true,
      type: true,
      event: true,
      channelId: true,
      messageId: true,
      createdAt: true,
    },
  });

  const splitBattleDayWarEvents = await prisma.warEvent.findMany({
    where: {
      warId: { in: splitWarIdInts },
      eventType: "battle_day",
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: [{ warId: "asc" }, { clanTag: "asc" }, { createdAt: "asc" }],
    select: {
      warId: true,
      clanTag: true,
      eventType: true,
      createdAt: true,
    },
  });

  const cpsCandidates = [];
  const cpsOutOfScope = [];
  const cpsConflicts = [];
  for (const row of allSplitCpsRows) {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    const startsMatch = row.warStartTime.getTime() === mapping?.warStartTime.getTime();
    const opponentMatch = normalizeTag(row.opponentTag) === mapping?.opponentTag;
    if (!mapping || !startsMatch || !opponentMatch) {
      cpsOutOfScope.push({
        id: row.id,
        guildId: row.guildId,
        clanTag: row.clanTag,
        splitWarId: row.warId,
        warStartTime: asIso(row.warStartTime),
        opponentTag: row.opponentTag,
        reason: !mapping
          ? "missing_mapping"
          : !startsMatch
            ? "war_start_identity_mismatch"
            : "opponent_tag_mismatch",
      });
      continue;
    }

    const conflict = await prisma.clanPointsSync.findFirst({
      where: {
        guildId,
        clanTag: row.clanTag,
        warId: String(mapping.oldWarId),
        warStartTime: row.warStartTime,
      },
      select: {
        id: true,
        warId: true,
        clanTag: true,
        warStartTime: true,
      },
    });

    if (conflict) {
      cpsConflicts.push({
        candidateId: row.id,
        conflictId: conflict.id,
        clanTag: row.clanTag,
        splitWarId: row.warId,
        oldWarId: String(mapping.oldWarId),
        warStartTime: asIso(row.warStartTime),
      });
    }

    cpsCandidates.push({
      id: row.id,
      guildId: row.guildId,
      clanTag: row.clanTag,
      opponentTag: row.opponentTag,
      fromWarId: row.warId,
      toWarId: String(mapping.oldWarId),
      warStartTime: asIso(row.warStartTime),
      syncNum: row.syncNum,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
      conflictingCanonicalOldWarRowExists: Boolean(conflict),
    });
  }

  const cpmCandidates = [];
  const cpmOutOfScope = [];
  for (const row of allSplitCpmRows) {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    const inWindow =
      row.createdAt.getTime() >= windowStart.getTime() &&
      row.createdAt.getTime() <= windowEnd.getTime();
    const qualifies =
      Boolean(mapping) &&
      row.type === "notify" &&
      row.event === "battle_day" &&
      inWindow;
    if (!qualifies) {
      cpmOutOfScope.push({
        id: row.id,
        guildId: row.guildId,
        clanTag: row.clanTag,
        warId: row.warId,
        type: row.type,
        event: row.event,
        createdAt: asIso(row.createdAt),
        messageId: row.messageId,
        channelId: row.channelId,
        reason: !mapping
          ? "missing_mapping"
          : row.type !== "notify"
            ? "type_mismatch"
            : row.event !== "battle_day"
              ? "event_mismatch"
              : "outside_maintenance_window",
      });
      continue;
    }

    cpmCandidates.push({
      id: row.id,
      guildId: row.guildId,
      clanTag: row.clanTag,
      warId: row.warId,
      type: row.type,
      event: row.event,
      createdAt: asIso(row.createdAt),
      messageId: row.messageId,
      channelId: row.channelId,
    });
  }

  const cpmIdSet = new Set(cpmCandidates.map((row) => row.id));
  const cpsIdSet = new Set(cpsCandidates.map((row) => row.id));
  if (cpmIdSet.size !== cpmCandidates.length) {
    errors.push("Duplicate ClanPostedMessage candidate IDs detected.");
  }
  if (cpsIdSet.size !== cpsCandidates.length) {
    errors.push("Duplicate ClanPointsSync candidate IDs detected.");
  }

  const cpsByClan = new Map(cpsCandidates.map((row) => [`${row.clanTag}|${row.fromWarId}`, row]));
  for (const mappingRow of mappingRows) {
    const key = `${mappingRow.clanTag}|${mappingRow.splitWarId}`;
    const cps = cpsByClan.get(key);
    if (!cps) {
      warnings.push(
        `[${mappingRow.clanTag}] No ClanPointsSync split row found for splitWarId=${mappingRow.splitWarId}.`
      );
    }
    const cpmCountForKey = cpmCandidates.filter(
      (row) => row.clanTag === mappingRow.clanTag && Number(row.warId) === mappingRow.splitWarId
    ).length;
    if (cpmCountForKey !== 1) {
      warnings.push(
        `[${mappingRow.clanTag}] Expected 1 ClanPostedMessage split artifact row for splitWarId=${mappingRow.splitWarId}, found ${cpmCountForKey}.`
      );
    }
  }

  if (cpsOutOfScope.length > 0) {
    errors.push(`Out-of-scope ClanPointsSync split rows found: ${cpsOutOfScope.length}.`);
  }
  if (cpmOutOfScope.length > 0) {
    errors.push(`Out-of-scope ClanPostedMessage split rows found: ${cpmOutOfScope.length}.`);
  }
  if (cpsConflicts.length > 0) {
    errors.push(`Conflicting canonical ClanPointsSync old-war rows found: ${cpsConflicts.length}.`);
  }
  if (splitBattleDayWarEvents.length > 0) {
    errors.push(
      `WarEvent split battle_day rows still exist (${splitBattleDayWarEvents.length}); this script does not perform WarEvent writes.`
    );
  }

  const beforeCounts = {
    clanPointsSyncSplitRows: allSplitCpsRows.length,
    clanPointsSyncCandidates: cpsCandidates.length,
    clanPostedMessageSplitRows: allSplitCpmRows.length,
    clanPostedMessageCandidates: cpmCandidates.length,
    warEventSplitBattleDayRows: splitBattleDayWarEvents.length,
  };

  return {
    errors,
    warnings,
    beforeCounts,
    cpsCandidates,
    cpmCandidates,
    cpsOutOfScope,
    cpmOutOfScope,
    cpsConflicts,
    splitBattleDayWarEvents,
    splitWarIds,
    mappingRows,
  };
}

function writeBackup({ backupDir, payload }) {
  const dir = path.resolve(process.cwd(), backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `phase1-remaining-backup-${nowStamp()}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function printCandidateTables(state) {
  line();
  console.log("CANDIDATE PK SETS");
  console.log(`ClanPointsSync update candidates: ${state.cpsCandidates.length}`);
  if (state.cpsCandidates.length > 0) {
    console.table(
      state.cpsCandidates.map((row) => ({
        id: row.id,
        guildId: row.guildId,
        clanTag: row.clanTag,
        fromWarId: row.fromWarId,
        toWarId: row.toWarId,
        warStartTime: row.warStartTime,
        opponentTag: row.opponentTag,
      }))
    );
  }
  console.log(`ClanPostedMessage delete candidates: ${state.cpmCandidates.length}`);
  if (state.cpmCandidates.length > 0) {
    console.table(
      state.cpmCandidates.map((row) => ({
        id: row.id,
        guildId: row.guildId,
        clanTag: row.clanTag,
        warId: row.warId,
        type: row.type,
        event: row.event,
        createdAt: row.createdAt,
        messageId: row.messageId,
        channelId: row.channelId,
      }))
    );
  }
}

function printOutOfScope(state) {
  line();
  console.log("OUT-OF-SCOPE INVENTORY");
  console.log(`ClanPointsSync out-of-scope rows: ${state.cpsOutOfScope.length}`);
  if (state.cpsOutOfScope.length > 0) {
    console.table(state.cpsOutOfScope);
  }
  console.log(`ClanPostedMessage out-of-scope rows: ${state.cpmOutOfScope.length}`);
  if (state.cpmOutOfScope.length > 0) {
    console.table(state.cpmOutOfScope);
  }
  console.log(`ClanPointsSync canonical conflicts: ${state.cpsConflicts.length}`);
  if (state.cpsConflicts.length > 0) {
    console.table(state.cpsConflicts);
  }
}

function failClosedIfNeeded(args, state) {
  if (
    state.cpsCandidates.length !== args.expectedCpsUpdates ||
    state.cpmCandidates.length !== args.expectedCpmDeletes
  ) {
    const mismatchMessage = [
      "Candidate count mismatch:",
      `expected ClanPointsSync updates=${args.expectedCpsUpdates}, actual=${state.cpsCandidates.length}`,
      `expected ClanPostedMessage deletes=${args.expectedCpmDeletes}, actual=${state.cpmCandidates.length}`,
    ].join(" ");
    if (args.allowCountMismatch) {
      state.warnings.push(`[count-mismatch-override] ${mismatchMessage}`);
    } else {
      state.errors.push(`${mismatchMessage} Use --allow-count-mismatch to override.`);
    }
  }
}

async function applyWrites(args, state) {
  const windowStart = parseIsoDate("window-start", args.windowStart);
  const windowEnd = parseIsoDate("window-end", args.windowEnd);
  const result = {
    cpsUpdates: [],
    cpmDeletes: [],
  };

  await prisma.$transaction(async (tx) => {
    for (const candidate of state.cpsCandidates) {
      const conflict = await tx.clanPointsSync.findFirst({
        where: {
          guildId: candidate.guildId,
          clanTag: candidate.clanTag,
          warId: candidate.toWarId,
          warStartTime: new Date(candidate.warStartTime),
        },
        select: { id: true },
      });
      if (conflict) {
        throw new Error(
          `Conflict detected in transaction for ClanPointsSync id=${candidate.id}, conflictId=${conflict.id}.`
        );
      }

      const updated = await tx.clanPointsSync.updateMany({
        where: {
          id: candidate.id,
          guildId: candidate.guildId,
          clanTag: candidate.clanTag,
          warId: candidate.fromWarId,
        },
        data: {
          warId: candidate.toWarId,
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          `ClanPointsSync update failed closed for id=${candidate.id}; expected 1 row, got ${updated.count}.`
        );
      }

      const afterRow = await tx.clanPointsSync.findUnique({
        where: { id: candidate.id },
        select: {
          id: true,
          guildId: true,
          clanTag: true,
          warId: true,
          updatedAt: true,
        },
      });
      result.cpsUpdates.push({
        id: candidate.id,
        guildId: candidate.guildId,
        clanTag: candidate.clanTag,
        beforeWarId: candidate.fromWarId,
        afterWarId: afterRow?.warId ?? null,
        updatedAt: afterRow?.updatedAt ? asIso(afterRow.updatedAt) : null,
      });
    }

    for (const candidate of state.cpmCandidates) {
      const deleted = await tx.clanPostedMessage.deleteMany({
        where: {
          id: candidate.id,
          guildId: candidate.guildId,
          clanTag: candidate.clanTag,
          warId: candidate.warId,
          type: "notify",
          event: "battle_day",
          createdAt: {
            gte: windowStart,
            lte: windowEnd,
          },
        },
      });
      if (deleted.count !== 1) {
        throw new Error(
          `ClanPostedMessage delete failed closed for id=${candidate.id}; expected 1 row, got ${deleted.count}.`
        );
      }
      result.cpmDeletes.push({
        id: candidate.id,
        guildId: candidate.guildId,
        clanTag: candidate.clanTag,
        warId: candidate.warId,
      });
    }
  });

  return result;
}

async function postApplyVerification({ guildId, mappingRows, windowStart, windowEnd }) {
  const splitWarIds = [...new Set(mappingRows.map((row) => String(row.splitWarId)))];
  const mappingBySplitAndClan = new Map(
    mappingRows.map((row) => [`${row.splitWarId}|${row.clanTag}`, row])
  );

  const cpsRemaining = await prisma.clanPointsSync.findMany({
    where: {
      guildId,
      warId: { in: splitWarIds },
    },
    select: {
      id: true,
      guildId: true,
      clanTag: true,
      warId: true,
      warStartTime: true,
      opponentTag: true,
    },
    orderBy: [{ warId: "asc" }, { clanTag: "asc" }],
  });
  const cpsInScopeRemaining = cpsRemaining.filter((row) => {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    if (!mapping) return false;
    return (
      row.warStartTime.getTime() === mapping.warStartTime.getTime() &&
      normalizeTag(row.opponentTag) === mapping.opponentTag
    );
  });
  const cpsOutOfScopeRemaining = cpsRemaining.filter((row) => {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    if (!mapping) return true;
    return (
      row.warStartTime.getTime() !== mapping.warStartTime.getTime() ||
      normalizeTag(row.opponentTag) !== mapping.opponentTag
    );
  });

  const cpmRemaining = await prisma.clanPostedMessage.findMany({
    where: {
      guildId,
      warId: { in: splitWarIds },
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
    orderBy: [{ warId: "asc" }, { clanTag: "asc" }, { createdAt: "asc" }],
  });
  const cpmInScopeRemaining = cpmRemaining.filter((row) => {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    if (!mapping) return false;
    const inWindow =
      row.createdAt.getTime() >= windowStart.getTime() &&
      row.createdAt.getTime() <= windowEnd.getTime();
    return row.type === "notify" && row.event === "battle_day" && inWindow;
  });
  const cpmOutOfScopeRemaining = cpmRemaining.filter((row) => {
    const mapping = mappingBySplitAndClan.get(`${Number(row.warId)}|${row.clanTag}`);
    if (!mapping) return true;
    const inWindow =
      row.createdAt.getTime() >= windowStart.getTime() &&
      row.createdAt.getTime() <= windowEnd.getTime();
    return !(row.type === "notify" && row.event === "battle_day" && inWindow);
  });

  return {
    cpsInScopeRemaining,
    cpsOutOfScopeRemaining,
    cpmInScopeRemaining,
    cpmOutOfScopeRemaining,
    counts: {
      cpsInScopeRemaining: cpsInScopeRemaining.length,
      cpsOutOfScopeRemaining: cpsOutOfScopeRemaining.length,
      cpmInScopeRemaining: cpmInScopeRemaining.length,
      cpmOutOfScopeRemaining: cpmOutOfScopeRemaining.length,
    },
  };
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
  if (guildId !== REQUIRED_GUILD_ID) {
    throw new Error(
      `This script is scoped to guildId=${REQUIRED_GUILD_ID}. Received guildId=${guildId}.`
    );
  }

  const windowStart = parseIsoDate("window-start", args.windowStart);
  const windowEnd = parseIsoDate("window-end", args.windowEnd);
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw new Error("window-start must be before window-end.");
  }

  const mapping = loadMapping(args.mappingFile, guildId);
  const state = await collectState({
    guildId,
    mappingRows: mapping.rows,
    windowStart,
    windowEnd,
  });

  failClosedIfNeeded(args, state);

  line();
  console.log("PHASE 1 REMAINING APPLY SCRIPT");
  console.log(`mode: ${args.apply ? "APPLY" : "DRY_RUN"}`);
  console.log(`guildId: ${guildId}`);
  console.log(`mappingFile: ${mapping.fullPath}`);
  console.log(`maintenanceWindowStart: ${windowStart.toISOString()}`);
  console.log(`maintenanceWindowEnd:   ${windowEnd.toISOString()}`);
  console.log(`mappingRows: ${mapping.rows.length}`);
  console.log(`expectedCpsUpdates: ${args.expectedCpsUpdates}`);
  console.log(`expectedCpmDeletes: ${args.expectedCpmDeletes}`);
  line();
  console.log("BEFORE COUNTS");
  console.table([
    { metric: "clanPointsSyncSplitRows", count: state.beforeCounts.clanPointsSyncSplitRows },
    { metric: "clanPointsSyncCandidates", count: state.beforeCounts.clanPointsSyncCandidates },
    {
      metric: "clanPostedMessageSplitRows",
      count: state.beforeCounts.clanPostedMessageSplitRows,
    },
    {
      metric: "clanPostedMessageCandidates",
      count: state.beforeCounts.clanPostedMessageCandidates,
    },
    {
      metric: "warEventSplitBattleDayRows",
      count: state.beforeCounts.warEventSplitBattleDayRows,
    },
  ]);

  printCandidateTables(state);
  printOutOfScope(state);

  if (state.warnings.length > 0) {
    line();
    console.log(`WARNINGS (${state.warnings.length})`);
    for (const warning of state.warnings) {
      console.log(`- ${warning}`);
    }
  }

  const backupPayload = {
    script: "phase1-split-war-remaining-apply.js",
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "dry_run",
    args: {
      mappingFile: mapping.fullPath,
      guildId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      expectedCpsUpdates: args.expectedCpsUpdates,
      expectedCpmDeletes: args.expectedCpmDeletes,
      allowCountMismatch: args.allowCountMismatch,
    },
    counts: state.beforeCounts,
    candidates: {
      clanPointsSyncUpdates: state.cpsCandidates,
      clanPostedMessageDeletes: state.cpmCandidates,
    },
    outOfScope: {
      clanPointsSync: state.cpsOutOfScope,
      clanPostedMessage: state.cpmOutOfScope,
      clanPointsSyncConflicts: state.cpsConflicts,
      warEventSplitBattleDayRows: state.splitBattleDayWarEvents.map((row) => ({
        warId: row.warId,
        clanTag: row.clanTag,
        eventType: row.eventType,
        createdAt: asIso(row.createdAt),
      })),
    },
  };
  const backupFile = writeBackup({
    backupDir: args.backupDir,
    payload: backupPayload,
  });
  line();
  console.log(`Backup payload exported: ${backupFile}`);

  if (state.errors.length > 0) {
    line();
    console.log(`FAIL_CLOSED (${state.errors.length} error(s))`);
    for (const error of state.errors) {
      console.log(`- ${error}`);
    }
    process.exitCode = 2;
    return;
  }

  if (!args.apply) {
    line();
    console.log("DRY RUN COMPLETE (NO WRITES EXECUTED)");
    return;
  }

  line();
  console.log("APPLY START");
  const applied = await applyWrites(args, state);
  line();
  console.log("APPLY RESULT");
  console.log(`ClanPointsSync rows updated: ${applied.cpsUpdates.length}`);
  if (applied.cpsUpdates.length > 0) {
    console.table(applied.cpsUpdates);
  }
  console.log(`ClanPostedMessage rows deleted: ${applied.cpmDeletes.length}`);
  if (applied.cpmDeletes.length > 0) {
    console.table(applied.cpmDeletes);
  }

  const verification = await postApplyVerification({
    guildId,
    mappingRows: mapping.rows,
    windowStart,
    windowEnd,
  });
  line();
  console.log("POST-APPLY VERIFICATION");
  console.table([
    { metric: "cpsInScopeRemaining", count: verification.counts.cpsInScopeRemaining },
    { metric: "cpsOutOfScopeRemaining", count: verification.counts.cpsOutOfScopeRemaining },
    { metric: "cpmInScopeRemaining", count: verification.counts.cpmInScopeRemaining },
    { metric: "cpmOutOfScopeRemaining", count: verification.counts.cpmOutOfScopeRemaining },
  ]);

  if (
    verification.counts.cpsInScopeRemaining !== 0 ||
    verification.counts.cpmInScopeRemaining !== 0
  ) {
    throw new Error(
      `Post-apply verification failed: remaining in-scope rows detected (cps=${verification.counts.cpsInScopeRemaining}, cpm=${verification.counts.cpmInScopeRemaining}).`
    );
  }

  line();
  console.log("APPLY COMPLETE");
}

main()
  .catch((error) => {
    console.error(
      "[phase1-remaining-apply] fatal:",
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

