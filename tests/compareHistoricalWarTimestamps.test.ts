import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  compareHistoricalWarTimestamps,
  normalizeClashPerk,
  type ClashPerkRecord,
  type DuskPerWarRecord,
} from "../scripts/compareHistoricalWarTimestamps";

const clanTag = "#2YUYLJCGV";
const windowStart = "2026-09-23T00:00:00.000Z";
const windowEnd = "2026-11-22T00:00:00.000Z";

function external(
  sourceId = "external-1",
  opponentTag = "#OPPONENT",
  timestamp = "2026-10-01T00:00:00.000Z",
  externalClanTag = clanTag,
): ClashPerkRecord {
  return { sourceId, clanTag: externalClanTag, opponentTag, timestamp };
}

function dusk(overrides: Partial<DuskPerWarRecord> = {}): DuskPerWarRecord {
  return {
    duskWarId: "1001",
    clanTag,
    opponentTag: "#OPPONENT",
    warStartTime: "2026-09-30T00:00:00.000Z",
    historyEndTime: "2026-10-01T00:00:00.000Z",
    participationRowCount: 50,
    distinctParticipationIdentityCount: 50,
    distinctParticipationEndTimestampCount: 1,
    nullParticipationEndTimeCount: 0,
    minParticipationEndTime: "2026-10-01T00:00:00.000Z",
    maxParticipationEndTime: "2026-10-01T00:00:00.000Z",
    startTimeMismatchCount: 0,
    opponentTagMismatchCount: 0,
    crossGuildDuplicateIdentityCount: 0,
    crossGuildDuplicateCopyCount: 0,
    participationEndTimeInternallyConsistent: true,
    ...overrides,
  };
}

function compare(
  clashPerk: readonly ClashPerkRecord[],
  duskRows: readonly DuskPerWarRecord[],
) {
  return compareHistoricalWarTimestamps({
    clashPerk,
    dusk: duskRows,
    windowStart,
    windowEnd,
  });
}

describe("FB-002 P4d-1a.3 historical timestamp comparator", () => {
  it("recognizes an exact-match control for both Dusk sources", () => {
    const report = compare([external()], [dusk()]);
    expect(report.rows[0].outcome).toBe("EQUAL_DISTANCE");
    expect(report.rows[0].historyMatchesExactly).toBe(true);
    expect(report.rows[0].participationMatchesExactly).toBe(true);
  });

  it("distinguishes history-closer, participation-closer, one-second, and larger offsets", () => {
    const report = compare(
      [
        external("history-closer", "#HISTORY", "2026-10-01T00:00:10.000Z"),
        external("participation-closer", "#PARTICIPATION", "2026-10-01T00:00:50.000Z"),
        external("one-second", "#ONE", "2026-10-01T00:00:01.000Z"),
        external("larger", "#LARGE", "2026-10-01T00:02:00.000Z"),
      ],
      [
        dusk({ duskWarId: "1002", opponentTag: "#HISTORY", minParticipationEndTime: "2026-10-01T00:00:30.000Z", maxParticipationEndTime: "2026-10-01T00:00:30.000Z" }),
        dusk({ duskWarId: "1003", opponentTag: "#PARTICIPATION", historyEndTime: "2026-10-01T00:01:10.000Z", minParticipationEndTime: "2026-10-01T00:00:40.000Z", maxParticipationEndTime: "2026-10-01T00:00:40.000Z" }),
        dusk({ duskWarId: "1004", opponentTag: "#ONE", minParticipationEndTime: "2026-10-01T00:00:03.000Z", maxParticipationEndTime: "2026-10-01T00:00:03.000Z" }),
        dusk({ duskWarId: "1005", opponentTag: "#LARGE", historyEndTime: "2026-10-01T00:01:00.000Z", minParticipationEndTime: "2026-10-01T00:01:30.000Z", maxParticipationEndTime: "2026-10-01T00:01:30.000Z" }),
      ],
    );
    expect(report.rows.find((row) => row.sourceId === "history-closer")?.outcome).toBe("CLOSER_TO_HISTORY");
    expect(report.rows.find((row) => row.sourceId === "participation-closer")?.outcome).toBe("CLOSER_TO_PARTICIPATION");
    expect(report.rows.find((row) => row.sourceId === "one-second")?.outcome).toBe("CLOSER_TO_HISTORY");
    expect(report.rows.find((row) => row.sourceId === "larger")?.outcome).toBe("CLOSER_TO_PARTICIPATION");
    expect(report.rows.find((row) => row.sourceId === "one-second")?.clashPerkMinusDuskHistorySeconds).toBe(1);
    expect(report.rows.find((row) => row.sourceId === "larger")?.clashPerkMinusDuskHistorySeconds).toBe(60);
  });

  it("does not collapse contradictory or missing participation evidence", () => {
    const report = compare(
      [external("multiple"), external("null", "#NULL"), external("missing", "#MISSING")],
      [
        dusk({ duskWarId: "1006", opponentTag: "#OPPONENT", distinctParticipationEndTimestampCount: 2, minParticipationEndTime: "2026-10-01T00:00:01.000Z", maxParticipationEndTime: "2026-10-01T00:00:02.000Z" }),
        dusk({ duskWarId: "1007", opponentTag: "#NULL", distinctParticipationEndTimestampCount: 1, nullParticipationEndTimeCount: 1 }),
        dusk({ duskWarId: "1008", opponentTag: "#MISSING", participationRowCount: 0, distinctParticipationIdentityCount: 0, distinctParticipationEndTimestampCount: 0, nullParticipationEndTimeCount: 0, minParticipationEndTime: null, maxParticipationEndTime: null, participationEndTimeInternallyConsistent: false }),
      ],
    );
    expect(report.rows.find((row) => row.sourceId === "multiple")?.outcome).toBe("INCONSISTENT_PARTICIPATION");
    expect(report.rows.find((row) => row.sourceId === "multiple")?.clashPerkMinusParticipationSeconds).toBeNull();
    expect(report.rows.find((row) => row.sourceId === "null")?.outcome).toBe("INCONSISTENT_PARTICIPATION");
    expect(report.rows.find((row) => row.sourceId === "missing")?.outcome).toBe("MISSING_EVIDENCE");
  });

  it("requires clan/opponent context and refuses ambiguous candidates", () => {
    const report = compare(
      [external("wrong-opponent", "#WRONG"), external("wrong-clan", "#OPPONENT", "2026-10-01T00:00:00.000Z", "#OTHER"), external("ambiguous", "#DUP")],
      [
        dusk({ duskWarId: "1009", opponentTag: "#OPPONENT" }),
        dusk({ duskWarId: "1010", opponentTag: "#DUP" }),
        dusk({ duskWarId: "1011", opponentTag: "#DUP", historyEndTime: "2026-10-02T00:00:00.000Z" }),
      ],
    );
    expect(report.rows.find((row) => row.sourceId === "wrong-opponent")?.outcome).toBe("UNMATCHED");
    expect(report.rows.find((row) => row.sourceId === "wrong-clan")?.outcome).toBe("UNMATCHED");
    expect(report.rows.find((row) => row.sourceId === "ambiguous")?.outcome).toBe("AMBIGUOUS");
    expect(report.rows.find((row) => row.sourceId === "ambiguous")?.duskWarId).toBeNull();
  });

  it("normalizes timezone-less external timestamps as UTC and preserves duplicate indicators", () => {
    const report = compare(
      [external("timezone", "#OPPONENT", "2026-10-01 00:00:00")],
      [dusk({ crossGuildDuplicateIdentityCount: 1, crossGuildDuplicateCopyCount: 1 })],
    );
    expect(report.rows[0].outcome).toBe("EQUAL_DISTANCE");
    expect(report.rows[0].crossGuildDuplicateIdentityCount).toBe(1);
    expect(report.rows[0].crossGuildDuplicateCopyCount).toBe(1);
  });

  it("uses deterministic UTC normalization for PostgreSQL and explicit-offset timestamps", () => {
    expect(normalizeClashPerk({ sourceId: "pg", clanTag, opponentTag: "#X", timestamp: "2026-10-01 00:00:00" }).timestamp).toBe("2026-10-01T00:00:00.000Z");
    expect(normalizeClashPerk({ sourceId: "z", clanTag, opponentTag: "#X", timestamp: "2026-10-01T00:00:00Z" }).timestamp).toBe("2026-10-01T00:00:00.000Z");
    expect(normalizeClashPerk({ sourceId: "offset", clanTag, opponentTag: "#X", timestamp: "2026-10-01 02:00:00+02:00" }).timestamp).toBe("2026-10-01T00:00:00.000Z");

    const child = spawnSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        "-e",
        `const { normalizeClashPerk } = require("./scripts/compareHistoricalWarTimestamps"); process.stdout.write(normalizeClashPerk({ sourceId: "non-utc", clanTag: "${clanTag}", opponentTag: "#X", timestamp: "2026-10-01 00:00:00" }).timestamp);`,
      ],
      { cwd: process.cwd(), env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("2026-10-01T00:00:00.000Z");
  });

  it("fails closed for duplicate external identities and reused Dusk identities", () => {
    const duplicateExternal = compare([external("same"), external("same")], [dusk()]);
    expect(duplicateExternal.rows.map((row) => row.outcome)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(duplicateExternal.rows.every((row) => row.ambiguousReason === "DUPLICATE_EXTERNAL_IDENTITY")).toBe(true);
    expect(duplicateExternal.summary.duplicateExternalIdentityCount).toBe(2);

    const reusedDusk = compare(
      [external("first", "#OPPONENT", "2026-10-01T00:00:00.000Z"), external("second", "#OPPONENT", "2026-10-01T00:00:01.000Z")],
      [dusk()],
    );
    expect(reusedDusk.rows.map((row) => row.outcome)).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(reusedDusk.rows.every((row) => row.ambiguousReason === "REUSED_DUSK_IDENTITY")).toBe(true);
    expect(reusedDusk.summary.reusedDuskIdentityCount).toBe(2);
  });

  it("preserves unavailable aggregate fields instead of treating them as zero", () => {
    const report = compare(
      [external()],
      [dusk({ participationRowCount: "", distinctParticipationIdentityCount: undefined as unknown as number })],
    );
    expect(report.rows[0].participationRowCount).toBeNull();
    expect(report.rows[0].distinctParticipationIdentityCount).toBeNull();
    expect(report.rows[0].outcome).toBe("MISSING_EVIDENCE");
  });

  it("separates equal-timestamp controls from genuinely discrepant paths", () => {
    const report = compare(
      [external("control", "#CONTROL"), external("discrepant", "#DISCREPANT")],
      [
        dusk({ duskWarId: "1014", opponentTag: "#CONTROL" }),
        dusk({ duskWarId: "1015", opponentTag: "#DISCREPANT", minParticipationEndTime: "2026-10-01T00:00:10.000Z", maxParticipationEndTime: "2026-10-01T00:00:10.000Z" }),
      ],
    );
    expect(report.analysis.dualSourceInterpretation.equalTimestampPathRows).toBe(1);
    expect(report.analysis.dualSourceInterpretation.discrepantTimestampPathRows).toBe(1);
    expect(report.analysis.dualSourceInterpretation.unresolvedOrConflictingRows).toBe(0);
  });

  it("orders results deterministically and keeps the approved SQL bounded and read-only", () => {
    const report = compare(
      [external("b", "#B", "2026-10-02T00:00:00.000Z"), external("a", "#A", "2026-10-01T00:00:00.000Z")],
      [dusk({ duskWarId: "1012", opponentTag: "#A" }), dusk({ duskWarId: "1013", opponentTag: "#B", historyEndTime: "2026-10-02T00:00:00.000Z", minParticipationEndTime: "2026-10-02T00:00:00.000Z", maxParticipationEndTime: "2026-10-02T00:00:00.000Z" })],
    );
    expect(report.rows.map((row) => row.sourceId)).toEqual(["a", "b"]);

    const explainSql = readFileSync("docs/diagnostics/sql/fb-002-p4d-1a3-war-timestamp-explain.sql", "utf8");
    const selectSql = readFileSync("docs/diagnostics/sql/fb-002-p4d-1a3-war-timestamp-select.sql", "utf8");
    for (const sql of [explainSql, selectSql]) {
      expect(sql).toContain("BEGIN READ ONLY");
      expect(sql).toContain("SET LOCAL statement_timeout = '5s'");
      expect(sql).toContain("SET LOCAL lock_timeout = '1s'");
      expect(sql).toContain("SET LOCAL TIME ZONE 'UTC'");
      expect(sql).toContain('LIMIT 20');
      expect(sql).toContain('h."warEndTime" >= p.window_start');
      expect(sql).toContain('h."warEndTime" < p.window_end');
      expect(sql).toContain('ORDER BY h."warEndTime" DESC');
      expect(sql).toContain('ORDER BY h."warEndTime" DESC,');
      expect(sql).toContain('ROLLBACK;');
      expect(sql).not.toMatch(/EXPLAIN\s+ANALYZE/i);
      expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/im);
      expect(sql).not.toContain('"WarLookup"');
    }
    expect(explainSql).toContain("EXPLAIN (COSTS TRUE, VERBOSE FALSE)");
    expect(selectSql).not.toContain("EXPLAIN (");
    expect(selectSql).toContain("TIMESTAMPTZ :'window_end' - TIMESTAMPTZ :'window_start' = interval '60 days'");
  });

  it("marks external records outside the approved half-open window as missing evidence", () => {
    const report = compare(
      [external("before", "#OPPONENT", "2026-09-22T23:59:59.000Z"), external("at-end", "#OPPONENT", "2026-11-22T00:00:00.000Z")],
      [dusk()],
    );
    expect(report.rows.map((row) => row.outcome)).toEqual(["MISSING_EVIDENCE", "MISSING_EVIDENCE"]);
  });
});
