#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Phase 2 production-side authoritative data collector (read-only).
 *
 * Purpose:
 * - fetch final war data from CoC war logs for the 8 approved archive wars
 * - emit staged correction JSON matching Phase 2 schema/validator format
 *
 * Constraints:
 * - no database access
 * - no apply logic
 * - fails closed if full 8-row output cannot be produced
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

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

const TARGET_WARS = [
  {
    archiveWarId: 1001293,
    clanTag: "#29PCQGUV0",
    opponentTag: "#2VGQG08Y",
    warStartTime: "2026-03-10T14:22:16.000Z",
  },
  {
    archiveWarId: 1001295,
    clanTag: "#2RYGLU2UY",
    opponentTag: "#2Q80R9PYU",
    warStartTime: "2026-03-10T14:21:56.000Z",
  },
  {
    archiveWarId: 1001296,
    clanTag: "#2YUYLJCGV",
    opponentTag: "#JV98CYYQ",
    warStartTime: "2026-03-10T14:20:36.000Z",
  },
  {
    archiveWarId: 1001297,
    clanTag: "#82YLR9Q2",
    opponentTag: "#2YL98RJ0",
    warStartTime: "2026-03-10T14:21:16.000Z",
  },
  {
    archiveWarId: 1001298,
    clanTag: "#8GPGGQ8C",
    opponentTag: "#2Y2U9VRCR",
    warStartTime: "2026-03-10T14:23:26.000Z",
  },
  {
    archiveWarId: 1001299,
    clanTag: "#9GLGQCCU",
    opponentTag: "#2LQ8JCJCG",
    warStartTime: "2026-03-10T14:22:16.000Z",
  },
  {
    archiveWarId: 1001300,
    clanTag: "#LQQ99UV8",
    opponentTag: "#2RVV0L0VP",
    warStartTime: "2026-03-10T14:30:56.000Z",
  },
  {
    archiveWarId: 1001301,
    clanTag: "#R80L8VYG",
    opponentTag: "#QUG2L2Y",
    warStartTime: "2026-03-10T14:49:06.000Z",
  },
];

const ACTUAL_OUTCOMES = new Set(["WIN", "LOSE", "TIE", "UNKNOWN"]);
const LOOKUP_RESULTS = new Set(["win", "lose", "tie", "unknown"]);
const DEFAULT_OUTPUT_FILE = path.resolve(
  process.cwd(),
  "scripts/phase2-staged-corrections.collected.json"
);

function line() {
  console.log("=".repeat(100));
}

function parseArgs(argv) {
  const out = {
    outFile: DEFAULT_OUTPUT_FILE,
    apiBaseUrl: "https://api.clashofclans.com/v1",
    warLogLimit: 50,
    matchToleranceMinutes: 10,
    timeoutMs: 15000,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--out-file") {
      out.outFile = path.resolve(process.cwd(), argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--api-base-url") {
      out.apiBaseUrl = String(argv[i + 1] ?? out.apiBaseUrl).trim();
      i += 1;
      continue;
    }
    if (token === "--warlog-limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --warlog-limit: ${argv[i + 1]}`);
      }
      out.warLogLimit = Math.trunc(value);
      i += 1;
      continue;
    }
    if (token === "--match-tolerance-minutes") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid --match-tolerance-minutes: ${argv[i + 1]}`);
      }
      out.matchToleranceMinutes = value;
      i += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --timeout-ms: ${argv[i + 1]}`);
      }
      out.timeoutMs = Math.trunc(value);
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
    "  node scripts/phase2-collect-staged-corrections.js [--out-file <path>]",
    "",
    "Options:",
    `  --out-file <path>               Output JSON path (default: ${DEFAULT_OUTPUT_FILE})`,
    "  --api-base-url <url>            CoC API base URL (default: https://api.clashofclans.com/v1)",
    "  --warlog-limit <n>              War log page limit (default: 50)",
    "  --match-tolerance-minutes <n>   Start-time matching tolerance in minutes (default: 10)",
    "  --timeout-ms <n>                HTTP timeout in ms (default: 15000)",
  ].join("\n");
}

function normalizeTag(tag) {
  const raw = String(tag ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function parseCocTimestamp(raw) {
  const value = String(raw ?? "").trim();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.000Z$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

function toIso(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function toBoundedNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function toStars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 150) return null;
  return n;
}

function deriveOutcome(entry) {
  const rawResult = String(entry?.result ?? "").trim().toLowerCase();
  if (rawResult.includes("win")) return "WIN";
  if (rawResult.includes("lose")) return "LOSE";
  if (rawResult.includes("tie")) return "TIE";

  const clanStars = toStars(entry?.clan?.stars);
  const opponentStars = toStars(entry?.opponent?.stars);
  if (clanStars !== null && opponentStars !== null) {
    if (clanStars > opponentStars) return "WIN";
    if (clanStars < opponentStars) return "LOSE";

    const clanDestruction = toBoundedNumber(entry?.clan?.destructionPercentage, 0, 100);
    const opponentDestruction = toBoundedNumber(entry?.opponent?.destructionPercentage, 0, 100);
    if (clanDestruction !== null && opponentDestruction !== null) {
      if (clanDestruction > opponentDestruction) return "WIN";
      if (clanDestruction < opponentDestruction) return "LOSE";
    }
    return "TIE";
  }

  return "UNKNOWN";
}

function findWarLogMatch(target, warLogItems, toleranceMs) {
  const targetOpponentTag = normalizeTag(target.opponentTag);
  const targetStartMs = new Date(target.warStartTime).getTime();
  const expectedEndMs = targetStartMs + 24 * 60 * 60 * 1000;

  const candidates = [];
  for (const item of warLogItems) {
    const itemOpponentTag = normalizeTag(item?.opponent?.tag);
    if (itemOpponentTag !== targetOpponentTag) continue;

    const endTime = parseCocTimestamp(item?.endTime);
    if (!endTime) continue;

    const endMs = endTime.getTime();
    const derivedStartMs = endMs - 24 * 60 * 60 * 1000;
    const startDiff = Math.abs(derivedStartMs - targetStartMs);
    const endDiff = Math.abs(endMs - expectedEndMs);

    candidates.push({
      item,
      endTime,
      startDiff,
      endDiff,
      withinTolerance: startDiff <= toleranceMs,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.withinTolerance !== b.withinTolerance) {
      return a.withinTolerance ? -1 : 1;
    }
    if (a.startDiff !== b.startDiff) return a.startDiff - b.startDiff;
    return a.endDiff - b.endDiff;
  });

  const best = candidates[0];
  if (!best.withinTolerance) return null;
  return { item: best.item, endTime: best.endTime, startDiffMs: best.startDiff };
}

function buildStagedRow(target, matchedItem, matchedEndTime) {
  const clanStars = toStars(matchedItem?.clan?.stars);
  const opponentStars = toStars(matchedItem?.opponent?.stars);
  const clanDestruction = toBoundedNumber(matchedItem?.clan?.destructionPercentage, 0, 100);
  const opponentDestruction = toBoundedNumber(matchedItem?.opponent?.destructionPercentage, 0, 100);
  const actualOutcome = deriveOutcome(matchedItem);
  const warLookupResult = actualOutcome.toLowerCase();

  const validationErrors = [];
  if (clanStars === null) validationErrors.push("invalid clanStars");
  if (opponentStars === null) validationErrors.push("invalid opponentStars");
  if (clanDestruction === null) validationErrors.push("invalid clanDestruction");
  if (opponentDestruction === null) validationErrors.push("invalid opponentDestruction");
  if (!ACTUAL_OUTCOMES.has(actualOutcome)) validationErrors.push("invalid actualOutcome");
  if (!LOOKUP_RESULTS.has(warLookupResult)) validationErrors.push("invalid warLookupResult");
  if (!toIso(matchedEndTime)) validationErrors.push("invalid warEndTime");

  return {
    row: {
      archiveWarId: target.archiveWarId,
      clanTag: normalizeTag(target.clanTag),
      opponentTag: normalizeTag(target.opponentTag),
      warStartTime: new Date(target.warStartTime).toISOString(),
      warEndTime: matchedEndTime.toISOString(),
      clanStars,
      opponentStars,
      clanDestruction,
      opponentDestruction,
      actualOutcome,
      warLookupResult,
    },
    validationErrors,
  };
}

async function fetchWarLog(apiBaseUrl, token, clanTag, limit, timeoutMs) {
  const normalized = normalizeTag(clanTag);
  const encodedTag = encodeURIComponent(normalized);
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/clans/${encodedTag}/warlog?limit=${limit}`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP_${response.status}`,
        body:
          typeof response.data === "object"
            ? response.data?.reason || response.data?.message || JSON.stringify(response.data)
            : String(response.data),
        items: [],
      };
    }
    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    return { ok: true, status: response.status, error: null, body: null, items };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: "REQUEST_FAILED",
      body: error instanceof Error ? error.message : String(error),
      items: [],
    };
  }
}

function validateFinalCollection(rows) {
  const errors = [];

  if (rows.length !== EXPECTED_ARCHIVE_WAR_IDS.length) {
    errors.push(
      `rowcount mismatch: expected ${EXPECTED_ARCHIVE_WAR_IDS.length}, got ${rows.length}`
    );
  }

  const seen = new Map();
  for (const row of rows) {
    const id = row.archiveWarId;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    errors.push(
      `duplicate archiveWarId values: ${duplicates
        .map(([id, count]) => `${id} (x${count})`)
        .join(", ")}`
    );
  }

  const present = new Set([...seen.keys()]);
  const missing = EXPECTED_ARCHIVE_WAR_IDS.filter((id) => !present.has(id));
  const extra = [...present].filter((id) => !EXPECTED_ARCHIVE_WAR_IDS.includes(id));
  if (missing.length > 0) {
    errors.push(`missing archiveWarId values: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(`unexpected archiveWarId values: ${extra.join(", ")}`);
  }

  return { errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const token = String(process.env.COC_API_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("COC_API_TOKEN missing. This script must run in a whitelisted CoC API environment.");
  }

  line();
  console.log("PHASE 2 PRODUCTION COLLECTOR (READ-ONLY)");
  console.log(`targets: ${TARGET_WARS.length}`);
  console.log(`expectedArchiveWarIds: ${EXPECTED_ARCHIVE_WAR_IDS.join(", ")}`);
  console.log(`apiBaseUrl: ${args.apiBaseUrl}`);
  console.log(`warLogLimit: ${args.warLogLimit}`);
  console.log(`matchToleranceMinutes: ${args.matchToleranceMinutes}`);
  console.log(`outFile: ${args.outFile}`);
  line();

  const toleranceMs = args.matchToleranceMinutes * 60 * 1000;
  const stagedRows = [];
  const failures = [];

  for (const target of TARGET_WARS) {
    const warLabel = `${target.archiveWarId} ${target.clanTag} vs ${target.opponentTag}`;
    const warLog = await fetchWarLog(
      args.apiBaseUrl,
      token,
      target.clanTag,
      args.warLogLimit,
      args.timeoutMs
    );
    if (!warLog.ok) {
      failures.push({
        archiveWarId: target.archiveWarId,
        clanTag: target.clanTag,
        opponentTag: target.opponentTag,
        reason: `warlog_fetch_failed ${warLog.error}`,
        status: warLog.status,
        detail: warLog.body,
      });
      console.log(`[collect] FAIL war=${warLabel} reason=warlog_fetch_failed status=${warLog.status ?? "n/a"} detail=${warLog.body ?? "n/a"}`);
      continue;
    }

    const match = findWarLogMatch(target, warLog.items, toleranceMs);
    if (!match) {
      failures.push({
        archiveWarId: target.archiveWarId,
        clanTag: target.clanTag,
        opponentTag: target.opponentTag,
        reason: "warlog_match_not_found",
        status: warLog.status,
        detail: `items=${warLog.items.length} toleranceMinutes=${args.matchToleranceMinutes}`,
      });
      console.log(`[collect] FAIL war=${warLabel} reason=warlog_match_not_found items=${warLog.items.length}`);
      continue;
    }

    const built = buildStagedRow(target, match.item, match.endTime);
    if (built.validationErrors.length > 0) {
      failures.push({
        archiveWarId: target.archiveWarId,
        clanTag: target.clanTag,
        opponentTag: target.opponentTag,
        reason: "row_validation_failed",
        status: warLog.status,
        detail: built.validationErrors.join("; "),
      });
      console.log(`[collect] FAIL war=${warLabel} reason=row_validation_failed detail=${built.validationErrors.join(", ")}`);
      continue;
    }

    stagedRows.push(built.row);
    console.log(
      `[collect] OK war=${warLabel} matchedEnd=${built.row.warEndTime} actualOutcome=${built.row.actualOutcome} warLookupResult=${built.row.warLookupResult}`
    );
  }

  const finalCheck = validateFinalCollection(stagedRows);
  line();
  console.log("COLLECTION SUMMARY");
  console.table([
    { metric: "targets", value: TARGET_WARS.length },
    { metric: "collectedRows", value: stagedRows.length },
    { metric: "failures", value: failures.length },
    { metric: "finalMembershipErrors", value: finalCheck.errors.length },
  ]);
  if (failures.length > 0) {
    console.log("Missing/unavailable war data:");
    console.table(failures);
  }
  if (finalCheck.errors.length > 0) {
    console.log("Final staged-file validation failures:");
    for (const err of finalCheck.errors) {
      console.log(`- ${err}`);
    }
  }

  if (failures.length > 0 || finalCheck.errors.length > 0) {
    throw new Error(
      "Collection did not produce a valid 8-row staged correction file. Fix collection issues and rerun."
    );
  }

  const sortedRows = [...stagedRows].sort((a, b) => a.archiveWarId - b.archiveWarId);
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(args.outFile, `${JSON.stringify(sortedRows, null, 2)}\n`, "utf8");

  line();
  console.log(`SUCCESS: wrote staged correction file: ${args.outFile}`);
  console.log("Next step: run scripts/phase2-validate-staged-corrections.js on this file before any apply workflow.");
}

main().catch((error) => {
  console.error(
    "[phase2-collector] fatal:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

