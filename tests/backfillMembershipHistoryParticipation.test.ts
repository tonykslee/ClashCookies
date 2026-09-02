import { describe, expect, it, vi } from "vitest";
import {
  formatParticipationBackfillPlan,
  parseBackfillMembershipHistoryParticipationArgs,
} from "../src/scripts/backfillMembershipHistoryParticipation";
import { MembershipHistoryParticipationBackfillService } from "../src/services/MembershipHistoryParticipationBackfillService";
import { buildParticipationRows } from "../src/services/war-events/participationRowBuilder";

const guildId = "guild-1";
const start = new Date("2026-08-15T00:00:00.000Z");
const end = new Date("2026-08-16T00:00:00.000Z");

function point(syncNum: number, warId: number | string, clanTag = "#HOME", overrides: Record<string, unknown> = {}) {
  return { guildId, syncNum, warId: String(warId), clanTag, warStartTime: start, opponentTag: "#OPP", isFwa: true, ...overrides };
}

function history(syncNumber: number, warId: number, clanTag = "#HOME", overrides: Record<string, unknown> = {}) {
  return { warId, syncNumber, matchType: "FWA", clanTag, warStartTime: start, opponentTag: "#OPP", warEndTime: end, ...overrides };
}

function lookup(warId: number, participants: unknown[], attacks: unknown[] = [], overrides: Record<string, unknown> = {}) {
  return {
    warId: String(warId),
    clanTag: "#HOME",
    opponentTag: "#OPP",
    startTime: start,
    endTime: end,
    payload: {
      warMeta: { warId: String(warId), clanTag: "#HOME", opponentTag: "#OPP", startTime: start.toISOString(), teamSize: 2, teamSizeSource: "war_event_snapshot" },
      canonical: { participants, attacks },
    },
    ...overrides,
  };
}

function makeDb(options: { points?: any[]; histories?: any[]; cycles?: any[]; lookups?: any[]; participation?: any[] } = {}) {
  const points = [...(options.points ?? [point(543, 100)])];
  const histories = [...(options.histories ?? [history(543, 100)])];
  const cycles = [...(options.cycles ?? [{ guildId, syncNumber: 543, syncTime: new Date("2026-08-14T23:00:00.000Z") }])];
  const lookups = [...(options.lookups ?? [lookup(100, [{ playerTag: "#P1", playerName: "P1", playerPosition: 1, attacksUsed: 0 }, { playerTag: "#P2", playerName: "P2", playerPosition: 2, attacksUsed: 0 }])])];
  const participation = [...(options.participation ?? [])];
  const matches = (row: any, where: any = {}) => {
    if (where.guildId && row.guildId !== where.guildId) return false;
    const sync = where.syncNum ?? where.syncNumber;
    if (sync?.in && !sync.in.includes(Number(row.syncNum ?? row.syncNumber))) return false;
    if (where.warId?.in && !where.warId.in.map(String).includes(String(row.warId))) return false;
    return true;
  };
  const db: any = {
    clanPointsSync: { findMany: vi.fn(async ({ where }: any = {}) => points.filter((row) => matches(row, where))) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async (_args: any = {}) => []) },
    clanWarHistory: { findMany: vi.fn(async ({ where }: any = {}) => histories.filter((row) => matches(row, where))) },
    syncCycle: { findMany: vi.fn(async ({ where }: any = {}) => cycles.filter((row) => matches(row, where))) },
    warLookup: { findMany: vi.fn(async ({ where }: any = {}) => lookups.filter((row) => matches(row, where))) },
    clanWarParticipation: {
      findMany: vi.fn(async ({ where }: any = {}) => participation.filter((row) => matches(row, where))),
      createMany: vi.fn(async ({ data }: any) => { participation.push(...data); return { count: data.length }; }),
    },
  };
  return { db, participation, cycles };
}

describe("backfillMembershipHistoryParticipation", () => {
  it("requires an explicit sync filter and parses ranges", () => {
    expect(parseBackfillMembershipHistoryParticipationArgs(["--guild", guildId, "--syncs", "543-545"])).toEqual({ guildId, syncFilter: new Set([543, 544, 545]), apply: false });
    expect(() => parseBackfillMembershipHistoryParticipationArgs(["--guild", guildId])).toThrow("sync");
  });

  it("skips missing sync 544 without bridging 543 and 545", async () => {
    const db = makeDb({
      points: [point(543, 100), point(544, 101), point(545, 102)],
      histories: [history(543, 100), history(544, 101), history(545, 102)],
      cycles: [
        { guildId, syncNumber: 543, syncTime: new Date("2026-08-14T23:00:00.000Z") },
        { guildId, syncNumber: 545, syncTime: new Date("2026-08-14T23:00:00.000Z") },
      ],
      lookups: [lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }]), lookup(102, [{ playerTag: "#P2", attacksUsed: 0 }])],
    }).db;
    const plan = await new MembershipHistoryParticipationBackfillService(db).plan(guildId, new Set([543, 544, 545]));
    expect(plan.reports.find((row) => row.syncNumber === 544)).toMatchObject({ action: "SKIP", reasons: ["missing_sync_cycle"] });
    expect(plan.reports.filter((row) => row.syncNumber !== 544).every((row) => row.action === "INSERT_MISSING")).toBe(true);
    expect(db.syncCycle.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ syncNumber: { in: [544] } }) }));
  });

  it("uses the canonical history war ID and ignores a stale raw-ID lookup collision", async () => {
    const stale = lookup(900, [{ playerTag: "#WRONG", attacksUsed: 0 }]);
    const canonical = lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }]);
    const { db } = makeDb({ points: [point(543, 900)], histories: [history(543, 100)], lookups: [stale, canonical] });
    const plan = await new MembershipHistoryParticipationBackfillService(db).plan(guildId, new Set([543]));
    expect(plan.reports[0]).toMatchObject({ action: "INSERT_MISSING", canonicalWarId: 100, reconstructableCount: 1 });
    expect(plan.reports[0].plannedRows[0].playerTag).toBe("#P1");
  });

  it("reconstructs production metrics including the exact 12-hour boundary", () => {
    const rows = buildParticipationRows({
      guildId,
      warId: "100",
      clanTag: "#HOME",
      opponentTag: "#OPP",
      warStartTime: start,
      warEndTime: end,
      matchType: "FWA",
      participantRows: [{ playerTag: "#P1", playerName: "", playerPosition: 1 }],
      attackRows: [{ playerTag: "#P1", playerName: "Archived P1", stars: 2, trueStars: 3, attackSeenAt: new Date(start.getTime() + 12 * 60 * 60 * 1000 + 60_000) }],
    });
    expect(rows[0]).toMatchObject({ playerName: "Archived P1", attacksUsed: 1, attacksMissed: 1, starsEarned: 2, trueStars: 3, attackDelayMinutes: 721, attackWindowMissed: true, missedBoth: false });
    expect(rows[0].firstAttackAt).toEqual(new Date(start.getTime() + 12 * 60 * 60 * 1000 + 60_000));
  });

  it("rejects declared attack-count disagreement and malformed required attack fields", async () => {
    const { db } = makeDb({
      lookups: [lookup(100, [{ playerTag: "#P1", attacksUsed: 2 }], [{ playerTag: "#P1", stars: 3, trueStars: 3, attackSeenAt: "not-a-date" }])],
    });
    const plan = await new MembershipHistoryParticipationBackfillService(db).plan(guildId, new Set([543]));
    expect(plan.reports[0]).toMatchObject({ action: "SKIP", reconstructableCount: 0 });
    expect(plan.reports[0].reasons).toEqual(expect.arrayContaining(["malformed_attack", "declared_attack_count_mismatch"]));
  });

  it("reports partial and unknown coverage while retaining positive rows", async () => {
    const partial = makeDb({ lookups: [lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }, { playerTag: "#P2", attacksUsed: 1 }], [{ playerTag: "#P2", stars: 1, trueStars: 1, attackSeenAt: start.toISOString() }])] }).db;
    const partialPlan = await new MembershipHistoryParticipationBackfillService(partial).plan(guildId, new Set([543]));
    expect(partialPlan.reports[0]).toMatchObject({ action: "INSERT_MISSING", projectedCoverage: "COMPLETE", expectedTeamSize: 2 });

    const unknownLookup = lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }]);
    unknownLookup.payload.warMeta.teamSize = null;
    unknownLookup.payload.warMeta.teamSizeSource = "unknown";
    const unknown = makeDb({ lookups: [unknownLookup] }).db;
    const unknownPlan = await new MembershipHistoryParticipationBackfillService(unknown).plan(guildId, new Set([543]));
    expect(unknownPlan.reports[0]).toMatchObject({ action: "INSERT_MISSING", projectedCoverage: "UNKNOWN", expectedTeamSize: null });
  });

  it("fails closed when projected roster exceeds authoritative team size", async () => {
    const oneSlot = lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }, { playerTag: "#P2", attacksUsed: 0 }]);
    oneSlot.payload.warMeta.teamSize = 1;
    const plan = await new MembershipHistoryParticipationBackfillService(makeDb({ lookups: [oneSlot] }).db).plan(guildId, new Set([543]));
    expect(plan.reports[0]).toMatchObject({ action: "CONFLICT", plannedInsertCount: 0, projectedCoverage: "PARTIAL" });
  });

  it("rejects contradictory same-sync cross-clan player evidence without choosing a clan", async () => {
    const awayLookup = lookup(101, [{ playerTag: "#P1", attacksUsed: 0 }], [], {
      clanTag: "#AWAY",
      opponentTag: "#OPP2",
      payload: { warMeta: { warId: "101", clanTag: "#AWAY", opponentTag: "#OPP2", startTime: start.toISOString(), teamSize: 1, teamSizeSource: "war_event_snapshot" }, canonical: { participants: [{ playerTag: "#P1", attacksUsed: 0 }], attacks: [] } },
    });
    const { db, participation } = makeDb({
      points: [point(543, 100, "#HOME"), point(543, 101, "#AWAY", { opponentTag: "#OPP2" })],
      histories: [history(543, 100, "#HOME"), history(543, 101, "#AWAY", { opponentTag: "#OPP2" })],
      cycles: [{ guildId, syncNumber: 543, syncTime: new Date("2026-08-14T23:00:00.000Z") }],
      lookups: [lookup(100, [{ playerTag: "#P1", attacksUsed: 0 }]), awayLookup],
    });
    const plan = await new MembershipHistoryParticipationBackfillService(db).plan(guildId, new Set([543]));
    expect(plan.reports.filter((row) => row.canonicalWarId !== null).every((row) => row.action === "CONFLICT")).toBe(true);
    expect(plan.rowsPlanned).toBe(0);
    expect(participation).toHaveLength(0);
  });

  it("plans only the missing subset and second apply is idempotent", async () => {
    const { db, participation } = makeDb({
      participation: [{ guildId, warId: "100", clanTag: "#HOME", playerTag: "#P1", matchType: "FWA", warStartTime: start }],
    });
    const service = new MembershipHistoryParticipationBackfillService(db);
    const plan = await service.plan(guildId, new Set([543]));
    expect(plan.reports[0]).toMatchObject({ action: "INSERT_MISSING", existingCount: 1, plannedInsertCount: 1 });
    await service.apply(plan);
    const rerun = await service.plan(guildId, new Set([543]));
    expect(rerun.reports[0]).toMatchObject({ action: "ALREADY_PRESENT", plannedInsertCount: 0 });
    expect(participation).toHaveLength(2);
  });

  it("does not apply a structural existing-row conflict", async () => {
    const { db } = makeDb({ participation: [{ guildId, warId: "100", clanTag: "#OTHER", playerTag: "#P1", matchType: "FWA", warStartTime: start }] });
    const plan = await new MembershipHistoryParticipationBackfillService(db).plan(guildId, new Set([543]));
    expect(plan.reports[0]).toMatchObject({ action: "CONFLICT", plannedInsertCount: 0 });
    await expect(new MembershipHistoryParticipationBackfillService(db).apply(plan)).rejects.toThrow("conflicts");
  });

  it("prints bounded operator output with the required prefix", async () => {
    const plan = await new MembershipHistoryParticipationBackfillService(makeDb().db).plan(guildId, new Set([543]));
    const output = formatParticipationBackfillPlan(plan, false);
    expect(output).toContain("[membership-participation-backfill]");
    expect(output).toContain("archive_participants=");
    expect(output).toContain("rows_planned=");
    expect(output).not.toContain("P1");
  });
});
