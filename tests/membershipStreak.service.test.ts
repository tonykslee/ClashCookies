import { describe, expect, it, vi } from "vitest";
import {
  computeMembershipStreaksFromEvidence,
  MembershipStreakService,
} from "../src/services/MembershipStreakService";
import { cwlContinuityPairKey } from "../src/services/CwlContinuityEvidenceService";

const guildId = "guild-1";
const playerTag = "#P2222";
const otherPlayerTag = "#P8888";
const rockyRoad = "#RRRR";
const partyBlizzard = "#GJJJ";
const otherAllianceClan = "#CULP";

function time(day: number): Date {
  return new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

type Fixture = {
  cycles?: any[];
  snapshots?: any[];
  warAttacks?: any[];
  points?: any[];
  evaluations?: any[];
  histories?: any[];
  participation?: any[];
  lookups?: any[];
};

function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    if (field === "AND" || field === "OR") continue;
    const value = row?.[field];
    if (value === undefined) continue;
    if (condition && typeof condition === "object" && "in" in condition) {
      if (!(condition as { in: unknown[] }).in.some((candidate) =>
        candidate instanceof Date && value instanceof Date
          ? candidate.getTime() === value.getTime()
          : String(candidate) === String(value),
      )) return false;
      continue;
    }
    if (condition && typeof condition === "object" && "lte" in condition) {
      if (value instanceof Date && value.getTime() > (condition as { lte: Date }).lte.getTime()) return false;
      continue;
    }
    if (condition && typeof condition === "object" && "gte" in condition) {
      if (value instanceof Date && value.getTime() < (condition as { gte: Date }).gte.getTime()) return false;
      continue;
    }
    if (condition === null && value !== null) return false;
    if (String(value) !== String(condition)) return false;
  }
  return true;
}

function filteredRows(rows: any[], args: any): any[] {
  return rows.filter((row) => matchesWhere(row, args?.where));
}

function groupedBoundaryRows(rows: any[], args: any): any[] {
  const byTime = new Map<number, Date>();
  for (const row of rows) if (row?.syncTime instanceof Date) byTime.set(row.syncTime.getTime(), row.syncTime);
  return [...byTime.values()]
    .sort((a, b) => b.getTime() - a.getTime())
    .slice(0, args?.take ?? Number.MAX_SAFE_INTEGER)
    .map((syncTime) => ({ syncTime }));
}

function groupedParticipationRows(rows: any[], args: any): any[] {
  const grouped = new Map<string, { warId: string; clanTag: string; count: number }>();
  for (const row of filteredRows(rows, args)) {
    const key = `${row.warId}|${row.clanTag}`;
    const current = grouped.get(key) ?? { warId: row.warId, clanTag: row.clanTag, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => ({
    warId: row.warId,
    clanTag: row.clanTag,
    _count: { playerTag: row.count },
  }));
}

function makeDb(fixture: Fixture = {}) {
  const points = (fixture.points ?? []).map((row) => ({ needsValidation: false, ...row }));
  return {
    syncCycle: {
      findMany: vi.fn(async (args: any) => filteredRows(fixture.cycles ?? [], args)),
      groupBy: vi.fn(async (args: any) => groupedBoundaryRows(fixture.cycles ?? [], args)),
    },
    syncClanMemberSnapshot: {
      findMany: vi.fn(async (args: any) => filteredRows(fixture.snapshots ?? [], args)),
      groupBy: vi.fn(async (args: any) => groupedBoundaryRows(fixture.snapshots ?? [], args)),
    },
    warAttacks: { findMany: vi.fn(async (args: any) => filteredRows(fixture.warAttacks ?? [], args)) },
    clanPointsSync: { findMany: vi.fn(async (args: any) => filteredRows(points, args)) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => fixture.evaluations ?? []) },
    clanWarHistory: { findMany: vi.fn(async () => fixture.histories ?? []) },
    clanWarParticipation: {
      findMany: vi.fn(async (args: any) => filteredRows(fixture.participation ?? [], args)),
      groupBy: vi.fn(async (args: any) => groupedParticipationRows(fixture.participation ?? [], args)),
    },
    warLookup: { findMany: vi.fn(async (args: any) => filteredRows(fixture.lookups ?? [], args)) },
  };
}

function historical(
  syncNumber: number,
  day: number,
  clanTag: string,
  participants: string[] = [playerTag],
  warId = 100000 + syncNumber,
) {
  return {
    point: {
      guildId,
      syncNum: syncNumber,
      warId: String(warId),
      clanTag,
      warStartTime: time(day),
      opponentTag: "#0PP2",
    },
    history: {
      warId,
      syncNumber,
      matchType: "FWA",
      clanTag,
      warStartTime: time(day),
      opponentTag: "#0PP2",
    },
    participation: participants.map((tag) => ({ guildId, warId: String(warId), clanTag, playerTag: tag })),
  };
}

function activeCandidate(syncNumber: number, day: number, clanTag = rockyRoad, warId = 200000 + syncNumber, teamSize: number | null = null) {
  return {
    guildId,
    clanTag: clanTag.replace(/^#/, ""),
    warId,
    startTime: time(day),
    opponentTag: "0PP2",
    teamSize,
    syncNumber,
    matchType: "FWA",
    inferredMatchType: false,
  };
}

function activeRoster(syncNumber: number, day: number, clanTag = rockyRoad, tag = playerTag, warId = 200000 + syncNumber) {
  return {
    warId,
    clanTag,
    opponentClanTag: "#0PP2",
    warStartTime: time(day),
    warEndTime: null,
    warState: "inWar",
    playerTag: tag,
  };
}

function lookup(warId: number, clanTag: string, teamSize = 1) {
  return {
    warId: String(warId),
    clanTag,
    payload: { warMeta: { teamSizeSource: "war_event_snapshot", teamSize } },
  };
}

function complianceEvaluation(history: any) {
  return {
    guildId,
    warId: history.warId,
    warHistory: { ...history },
  };
}

function serviceFor(fixture: Fixture, candidates: any[] = [], conflict = false, cwlContinuityReader: any = null) {
  const db = makeDb(fixture);
  const activeReader = {
    findPersistedActiveSyncNumber: vi.fn(async () => ({
      syncNumber: candidates.length === 1 ? candidates[0].syncNumber : null,
      conflict,
      candidates,
    })),
  };
  return { service: new MembershipStreakService(db, activeReader, cwlContinuityReader), db, activeReader };
}

function historicalFixture(rows: ReturnType<typeof historical>[]) {
  return {
    cycles: rows.map((row) => ({ guildId, syncNumber: row.point.syncNum, syncTime: row.point.warStartTime })),
    points: rows.map((row) => row.point),
    histories: rows.map((row) => row.history),
    participation: rows.flatMap((row) => row.participation),
  };
}

function input(playerTags = [playerTag], maxBoundaries?: number) {
  return { guildId, playerTags, ...(maxBoundaries === undefined ? {} : { maxBoundaries }) };
}

function pureEvidence(
  boundaryTime: Date,
  status: "RESOLVED" | "AMBIGUOUS" | "ABSENT" | "UNKNOWN",
  clanTag: string | null = rockyRoad,
  cwlExempt = false,
) {
  const resolved = status === "RESOLVED";
  const positive = resolved || status === "AMBIGUOUS";
  return {
    playerTag,
    boundaryTime,
    fwa: {
      status,
      clanTag: resolved ? clanTag : null,
      clanTags: positive && clanTag ? [clanTag] : [],
      source: positive ? "FWA_WAR_PARTICIPATION" as const : null,
    },
    alliance: {
      positive,
      clanTags: positive && clanTag ? [clanTag] : [],
      ambiguous: status === "AMBIGUOUS",
      sources: positive ? ["FWA_EVIDENCE" as const] : [],
    },
    ...(cwlExempt ? { continuity: { cwlExempt: true as const, source: "CWL_EXCURSION" as const } } : {}),
  };
}

function canonicalIdentities(boundaries: Date[], startSync = 556) {
  return boundaries.map((boundaryTime, index) => ({ boundaryTime, syncNumber: startSync - index }));
}

describe("MembershipStreakService", () => {
  it("attaches bounded CWL-neutral evidence without changing the FWA status", async () => {
    const boundaryTime = time(3);
    const cwlContinuityReader = {
      getEvidence: vi.fn(async () => ({
        exemptPairs: new Set([cwlContinuityPairKey(playerTag, boundaryTime)]),
        neutralBoundaryCount: 1,
        neutralPlayerCount: 1,
        candidatesRejected: 0,
        ambiguousCandidates: 0,
      })),
    };
    const built = serviceFor({ cycles: [{ guildId, syncNumber: 556, syncTime: boundaryTime }] }, [], false, cwlContinuityReader);

    const batch = await built.service.getMembershipStreakBatchForPlayers(input());

    expect(cwlContinuityReader.getEvidence).toHaveBeenCalledTimes(1);
    expect(batch.evidenceByPlayer[playerTag][0]).toMatchObject({ fwa: { status: "UNKNOWN" }, continuity: { cwlExempt: true, source: "CWL_EXCURSION" } });
    expect(batch.streaks[0]).toMatchObject({ latestFwaEvidenceStatus: "UNKNOWN", latestCwlContinuityExempt: true });
  });

  it("treats CWL-neutral UNKNOWN boundaries as continuity-neutral for S/A", () => {
    const boundaries = [6, 5, 4, 3, 2, 1].map(time);
    const result = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [
        pureEvidence(boundaries[0], "RESOLVED"),
        pureEvidence(boundaries[1], "UNKNOWN", null, true),
        pureEvidence(boundaries[2], "UNKNOWN", null, true),
        pureEvidence(boundaries[3], "UNKNOWN", null, true),
        pureEvidence(boundaries[4], "RESOLVED"),
        pureEvidence(boundaries[5], "RESOLVED"),
      ],
      false,
      canonicalIdentities(boundaries),
    );

    expect(result).toMatchObject({ clanStreakSyncs: 3, allianceStreakSyncs: 3, clanStreakIsLowerBound: false, allianceStreakIsLowerBound: false });
  });

  it("treats CWL-neutral ABSENT boundaries as continuity-neutral without changing FWA status", () => {
    const boundaries = [3, 2, 1].map(time);
    const result = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "ABSENT", null, true), pureEvidence(boundaries[2], "RESOLVED")],
      false,
      canonicalIdentities(boundaries),
    );

    expect(result).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2, latestFwaEvidenceStatus: "RESOLVED" });
  });

  it("skips multiple leading CWL-neutral boundaries to the prior FWA anchor", () => {
    const boundaries = [4, 3, 2, 1].map(time);
    const result = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "UNKNOWN", null, true), pureEvidence(boundaries[1], "ABSENT", null, true), pureEvidence(boundaries[2], "RESOLVED"), pureEvidence(boundaries[3], "RESOLVED")],
      false,
      canonicalIdentities(boundaries),
    );

    expect(result).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2, clanStreakIsLowerBound: false, allianceStreakIsLowerBound: false });
  });

  it("does not neutralize ambiguous or resolved FWA evidence when flagged", () => {
    const boundaries = [3, 2].map(time);
    const result = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "AMBIGUOUS", rockyRoad, true)],
      false,
      canonicalIdentities(boundaries),
    );
    const resolvedFlagged = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "RESOLVED", rockyRoad, true)],
      false,
      canonicalIdentities(boundaries),
    );

    expect(result).toMatchObject({ clanStreakSyncs: 1, clanStreakIsLowerBound: true, allianceStreakSyncs: 2 });
    expect(resolvedFlagged).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2, clanStreakIsLowerBound: false });
  });

  it("does not bridge a resolved observation in another clan or a canonical sync gap", () => {
    const boundaries = [3, 2, 1].map(time);
    const otherClan = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "RESOLVED", otherAllianceClan, true), pureEvidence(boundaries[2], "RESOLVED")],
      false,
      canonicalIdentities(boundaries),
    );
    const gap = computeMembershipStreaksFromEvidence(
      playerTag,
      boundaries,
      [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "UNKNOWN", null, true), pureEvidence(boundaries[2], "RESOLVED")],
      false,
      [{ boundaryTime: boundaries[0], syncNumber: 545 }, { boundaryTime: boundaries[1], syncNumber: null }, { boundaryTime: boundaries[2], syncNumber: 543 }],
    );

    expect(otherClan).toMatchObject({ clanStreakSyncs: 1, allianceStreakSyncs: 3 });
    expect(gap).toMatchObject({ clanStreakSyncs: 1, allianceStreakSyncs: 1, clanStreakIsLowerBound: true, allianceStreakIsLowerBound: true });
  });

  it("keeps ordinary UNKNOWN lower-bounded, ABSENT exact, and bounded history lower-bounded", () => {
    const boundaries = [3, 2, 1].map(time);
    const unknown = computeMembershipStreaksFromEvidence(playerTag, boundaries, [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "UNKNOWN"), pureEvidence(boundaries[2], "RESOLVED")], false, canonicalIdentities(boundaries));
    const absent = computeMembershipStreaksFromEvidence(playerTag, boundaries, [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "ABSENT"), pureEvidence(boundaries[2], "RESOLVED")], false, canonicalIdentities(boundaries));
    const bounded = computeMembershipStreaksFromEvidence(playerTag, boundaries, [pureEvidence(boundaries[0], "RESOLVED"), pureEvidence(boundaries[1], "RESOLVED"), pureEvidence(boundaries[2], "RESOLVED")], true, canonicalIdentities(boundaries));

    expect(unknown).toMatchObject({ clanStreakSyncs: 1, clanStreakIsLowerBound: true, allianceStreakSyncs: 1, allianceStreakIsLowerBound: true });
    expect(absent).toMatchObject({ clanStreakSyncs: 1, clanStreakIsLowerBound: false, allianceStreakSyncs: 1, allianceStreakIsLowerBound: false });
    expect(bounded).toMatchObject({ clanStreakSyncs: 3, clanStreakIsLowerBound: true, allianceStreakSyncs: 3, allianceStreakIsLowerBound: true });
  });

  it("uses canonical historical participation when a stale snapshot omits the player", async () => {
    const row = historical(552, 1, rockyRoad);
    const built = serviceFor({
      ...historicalFixture([row]),
      snapshots: [{ guildId, syncTime: time(1), clanTag: partyBlizzard, playerTag: otherPlayerTag }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toEqual({
      status: "RESOLVED",
      clanTag: rockyRoad,
      clanTags: [rockyRoad],
      source: "FWA_WAR_PARTICIPATION",
    });
  });

  it("uses persisted active WarAttacks roster membership before war end", async () => {
    const candidate = activeCandidate(553, 2);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: [activeRoster(553, 2)],
    }, [candidate]);

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({
      latestFwaEvidenceStatus: "RESOLVED",
      latestFwaClanTag: rockyRoad,
      clanStreakSyncs: 1,
      allianceStreakSyncs: 1,
    });
    expect(built.activeReader.findPersistedActiveSyncNumber).toHaveBeenCalledWith({ guildId });
  });

  it("accepts an active roster row with a scheduled war end time", async () => {
    const candidate = activeCandidate(553, 2);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: [{ ...activeRoster(553, 2), warEndTime: time(3), warState: "preparation" }],
    }, [candidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("treats a target absent from an active canonical roster as unknown", async () => {
    const candidate = activeCandidate(553, 2);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: [activeRoster(553, 2, rockyRoad, otherPlayerTag)],
    }, [candidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "UNKNOWN", clanTag: null });
    expect(built.db.warAttacks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ playerTag: expect.anything() }),
    }));
  });

  it("proves active-roster absence only when persisted team-size coverage is complete", async () => {
    const candidate = activeCandidate(553, 2, rockyRoad, 200553, 1);
    const secondCandidate = activeCandidate(553, 2, partyBlizzard, 200554, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        { guildId, syncNum: 553, warId: String(candidate.warId), clanTag: rockyRoad, warStartTime: time(2), opponentTag: "#0PP2" },
        { guildId, syncNum: 553, warId: String(secondCandidate.warId), clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      warAttacks: [
        activeRoster(553, 2, rockyRoad, otherPlayerTag, candidate.warId),
        activeRoster(553, 2, partyBlizzard, otherPlayerTag, secondCandidate.warId),
      ],
    }, [candidate, secondCandidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT", source: "ACTIVE_FWA_WAR_ROSTER" });
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("keeps active absence unknown when an expected participating clan is unresolved", async () => {
    const candidate = activeCandidate(553, 2, rockyRoad, 200553, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        { guildId, syncNum: 553, warId: String(candidate.warId), clanTag: rockyRoad, warStartTime: time(2), opponentTag: "#0PP2" },
        { guildId, syncNum: 553, warId: "200554", clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      warAttacks: [activeRoster(553, 2, rockyRoad, otherPlayerTag, candidate.warId)],
    }, [candidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("fails closed as unknown when the active CurrentWar team size is null", async () => {
    const candidate = activeCandidate(553, 2, rockyRoad, 200553, null);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [{ guildId, syncNum: 553, warId: String(candidate.warId), clanTag: rockyRoad, warStartTime: time(2), opponentTag: "#0PP2" }],
      warAttacks: [activeRoster(553, 2, rockyRoad, otherPlayerTag, candidate.warId)],
    }, [candidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("allows active positive membership before the full participating clan cohort resolves", async () => {
    const candidate = activeCandidate(553, 2, rockyRoad, 200553, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        { guildId, syncNum: 553, warId: String(candidate.warId), clanTag: rockyRoad, warStartTime: time(2), opponentTag: "#0PP2" },
        { guildId, syncNum: 553, warId: "200554", clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      warAttacks: [activeRoster(553, 2, rockyRoad, playerTag, candidate.warId)],
    }, [candidate]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("combines historical positive membership with an incomplete active cohort", async () => {
    const archived = historical(553, 2, rockyRoad, [playerTag], 200553);
    const active = activeCandidate(553, 2, partyBlizzard, 200554, 2);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        archived.point,
        { guildId, syncNum: 553, warId: String(active.warId), clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, partyBlizzard, otherPlayerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("proves mixed-lifecycle absence from complete historical and active rosters", async () => {
    const archived = historical(553, 2, rockyRoad, [otherPlayerTag], 200553);
    const active = activeCandidate(553, 2, partyBlizzard, 200554, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        archived.point,
        { guildId, syncNum: 553, warId: String(active.warId), clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, partyBlizzard, otherPlayerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT" });
  });

  it("marks cross-source positive membership ambiguous", async () => {
    const archived = historical(553, 2, rockyRoad, [playerTag], 200553);
    const active = activeCandidate(553, 2, partyBlizzard, 200554, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        archived.point,
        { guildId, syncNum: 553, warId: String(active.warId), clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, partyBlizzard, playerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({
      status: "AMBIGUOUS",
      clanTags: [partyBlizzard, rockyRoad],
    });
  });

  it("keeps mixed-lifecycle absence unknown when active team size is unavailable", async () => {
    const archived = historical(553, 2, rockyRoad, [otherPlayerTag], 200553);
    const active = activeCandidate(553, 2, partyBlizzard, 200554, null);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [
        archived.point,
        { guildId, syncNum: 553, warId: String(active.warId), clanTag: partyBlizzard, warStartTime: time(2), opponentTag: "#0PP2" },
      ],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, partyBlizzard, otherPlayerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("allows compatible same-clan active and archived coverage once", async () => {
    const archived = historical(553, 2, rockyRoad, [playerTag], 200553);
    const active = activeCandidate(553, 2, rockyRoad, 200553, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [archived.point],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, rockyRoad, playerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("fails closed for incompatible same-clan active and archived identities", async () => {
    const archived = historical(553, 2, rockyRoad, [otherPlayerTag], 200553);
    const active = activeCandidate(553, 2, rockyRoad, 200554, 1);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      points: [archived.point],
      histories: [archived.history],
      participation: archived.participation,
      lookups: [lookup(archived.history.warId, rockyRoad)],
      warAttacks: [activeRoster(553, 2, rockyRoad, otherPlayerTag, active.warId)],
    }, [active]);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("fails closed when active canonical sync identity is ambiguous", async () => {
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: [activeRoster(553, 2)],
    }, [activeCandidate(553, 2)], true);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.warAttacks.findMany).not.toHaveBeenCalled();
  });

  it("does not let snapshot evidence skip a missing canonical Home boundary", async () => {
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 554, syncTime: time(4) },
        { guildId, syncNumber: 552, syncTime: time(2) },
        { guildId, syncNumber: 551, syncTime: time(1) },
      ],
      snapshots: [4, 2, 1].map((day) => ({ guildId, syncTime: time(day), clanTag: rockyRoad, playerTag })),
    });

    const evidence = await built.service.getMembershipBoundaryEvidenceForPlayers(input());

    expect(evidence[playerTag]).toHaveLength(1);
    expect(evidence[playerTag][0].boundaryTime).toEqual(time(4));
  });

  it("keeps prior C/S/A values pending until the newest roster is observed", async () => {
    const older = historical(552, 1, rockyRoad);
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 553, syncTime: time(2) },
        { guildId, syncNumber: 552, syncTime: time(1) },
      ],
      points: [older.point],
      histories: [older.history],
      participation: older.participation,
    });

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({
      latestFwaEvidenceStatus: "UNKNOWN",
      latestEvidencePending: true,
      clanStreakSyncs: 1,
      allianceStreakSyncs: 1,
    });
  });

  it("incorporates the newest active roster as soon as it is persisted", async () => {
    const older = historical(552, 1, rockyRoad);
    const candidate = activeCandidate(553, 2);
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 553, syncTime: time(2) },
        { guildId, syncNumber: 552, syncTime: time(1) },
      ],
      points: [older.point],
      histories: [older.history],
      participation: older.participation,
      warAttacks: [activeRoster(553, 2), activeRoster(552, 1)],
    }, [candidate]);

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({ latestFwaClanTag: rockyRoad, clanStreakSyncs: 2, allianceStreakSyncs: 2 });
  });

  it("resets S on a tracked-clan move while preserving A", async () => {
    const rows = [historical(551, 1, rockyRoad), historical(552, 2, otherAllianceClan)];
    const built = serviceFor(historicalFixture(rows));

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({ latestFwaClanTag: otherAllianceClan, clanStreakSyncs: 1, allianceStreakSyncs: 2 });
  });

  it("does not bridge a missing canonical sync number", async () => {
    const built = serviceFor(historicalFixture([
      historical(545, 2, rockyRoad),
      historical(543, 1, rockyRoad),
    ]));

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({ clanStreakSyncs: 1, clanStreakIsLowerBound: true, allianceStreakSyncs: 1, allianceStreakIsLowerBound: true });
  });

  it("resolves stale raw ClanPointsSync war IDs through canonical history", async () => {
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 552, syncTime: time(2) },
        { guildId, syncNumber: 551, syncTime: time(1) },
      ],
      points: [{ guildId, syncNum: 551, warId: 900001, clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" }],
      histories: [{ warId: 100123, syncNumber: 551, matchType: "FWA", clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" }],
      participation: [{ guildId, warId: "100123", clanTag: rockyRoad, playerTag }],
      lookups: [lookup(100123, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][1].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("does not let a stale extra point veto the current canonical tuple", async () => {
    const current = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 551, syncTime: time(1) }],
      points: [
        { ...current.point, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1" },
        { ...current.point, warId: "900002" },
      ],
      histories: [current.history],
      participation: current.participation,
      lookups: [lookup(current.history.warId, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("canonicalizes an exact tuple even when the raw point says non-FWA", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [{ ...row.point, isFwa: false }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("ignores unmatched non-FWA operational evidence beside valid FWA evidence", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [
        row.point,
        { ...row.point, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1", isFwa: false },
      ],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("ignores dirty points while preserving safe canonical evidence", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [row.point, { ...row.point, warId: "900001", needsValidation: true }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("does not establish historical ownership from dirty points alone", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [{ ...row.point, needsValidation: true }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.clanWarHistory.findMany).not.toHaveBeenCalled();
  });

  it("uses canonical compliance evidence when a raw point is unmatched", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 551, syncTime: time(1) }],
      points: [{ ...row.point, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1" }],
      histories: [row.history],
      evaluations: [complianceEvaluation(row.history)],
      participation: row.participation,
      lookups: [lookup(row.history.warId, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("fails closed when one exact tuple matches multiple canonical histories", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 551, syncTime: time(1) }],
      points: [row.point],
      histories: [row.history, { ...row.history, warId: 100124 }],
      participation: row.participation,
      lookups: [lookup(row.history.warId, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.clanWarParticipation.findMany).not.toHaveBeenCalled();
  });

  it("resolves positive participation without trusted team-size coverage", async () => {
    const row = historical(551, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      lookups: [{ warId: "100123", clanTag: rockyRoad, payload: { warMeta: { teamSize: 50 } } }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", source: "FWA_WAR_PARTICIPATION" });
  });

  it("proves historical negative membership from a nonempty canonical roster without WarLookup", async () => {
    const row = historical(551, 1, rockyRoad, [otherPlayerTag], 100123);
    const built = serviceFor({
      ...historicalFixture([row]),
      lookups: [{ warId: "100123", clanTag: rockyRoad, payload: { warMeta: { teamSize: 50 } } }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("ABSENT");
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("treats a 45-player canonical historical participation roster as complete without WarLookup", async () => {
    const participants = Array.from({ length: 45 }, (_, index) => `#P${String(index).padStart(4, "0")}`);
    const row = historical(551, 1, rockyRoad, participants, 100123);
    const built = serviceFor(historicalFixture([row]), [], false);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input([participants[0]]));

    expect(evidence[participants[0]][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
    expect(built.db.clanWarParticipation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ playerTag: { in: [participants[0]] } }),
      select: { warId: true, clanTag: true, playerTag: true },
    }));
    expect(built.db.clanWarParticipation.groupBy).toHaveBeenCalledTimes(1);
    expect(built.db.clanWarParticipation.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ["warId", "clanTag"],
      where: { guildId, warId: { in: ["100123"] } },
      _count: { playerTag: true },
    }));
  });

  it("treats a 50-player canonical historical participation roster as complete without WarLookup", async () => {
    const participants = Array.from({ length: 50 }, (_, index) => `#P${String(index).padStart(4, "0")}`);
    const row = historical(551, 1, rockyRoad, participants, 100123);
    const built = serviceFor(historicalFixture([row]), [], false);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input([participants[0]]));

    expect(evidence[participants[0]][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
    expect(built.db.warLookup.findMany).not.toHaveBeenCalled();
  });

  it("ignores an unrelated raw-ID collision when tuple recovery is available", async () => {
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 551, syncTime: time(1) }],
      points: [{ guildId, syncNum: 551, warId: 900001, clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" }],
      histories: [
        { warId: 900001, syncNumber: 551, matchType: "FWA", clanTag: "#OTHER", warStartTime: time(1), opponentTag: "#0PP2" },
        { warId: 100123, syncNumber: 551, matchType: "FWA", clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" },
      ],
      participation: [{ guildId, warId: "100123", clanTag: rockyRoad, playerTag }],
      lookups: [lookup(100123, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("ignores persisted raw-ID disagreement when the canonical tuple resolves", async () => {
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 552, syncTime: time(2) },
        { guildId, syncNumber: 551, syncTime: time(1) },
      ],
      points: [{ guildId, syncNum: 551, warId: 900001, clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" }],
      histories: [
        { warId: 900001, syncNumber: 552, matchType: "FWA", clanTag: rockyRoad, warStartTime: time(2), opponentTag: "#0PP2" },
        { warId: 100123, syncNumber: 551, matchType: "FWA", clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" },
      ],
      participation: [{ guildId, warId: "100123", clanTag: rockyRoad, playerTag }],
      lookups: [lookup(100123, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][1].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("fails closed when no guild-scoped canonical ownership can be established", async () => {
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 551, syncTime: time(1) }],
      histories: [{ warId: 100123, syncNumber: 551, matchType: "FWA", clanTag: rockyRoad, warStartTime: time(1), opponentTag: "#0PP2" }],
      participation: [{ guildId, warId: "100123", clanTag: rockyRoad, playerTag }],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.clanWarHistory.findMany).not.toHaveBeenCalled();
  });

  it("preserves duplicate canonical boundary identity as unresolved", async () => {
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 552, syncTime: time(1) },
        { guildId, syncNumber: 551, syncTime: time(1) },
      ],
    });

    const batch = await built.service.getMembershipStreakBatchForPlayers(input());

    expect(batch.boundaryIdentities[0].syncNumber).toBeNull();
    expect(batch.streaks[0]).toMatchObject({ latestFwaEvidenceStatus: "UNKNOWN", clanStreakSyncs: 0, allianceStreakSyncs: 0 });
  });

  it("normalizes, deduplicates, and orders requested player tags deterministically", async () => {
    const built = serviceFor({});

    const results = await built.service.getMembershipStreaksForPlayers(input(["p8888", "#P2222", "P8888", " #P2222"]));

    expect(results.map((row) => row.playerTag)).toEqual(["#P2222", "#P8888"]);
  });

  it("marks a bounded canonical history window as a lower bound", async () => {
    const rows = [historical(551, 1, rockyRoad), historical(552, 2, rockyRoad), historical(553, 3, rockyRoad)];
    const built = serviceFor(historicalFixture(rows));

    const [result] = await built.service.getMembershipStreaksForPlayers(input([playerTag], 2));

    expect(result).toMatchObject({ clanStreakSyncs: 2, clanStreakIsLowerBound: true, allianceStreakSyncs: 2, allianceStreakIsLowerBound: true });
  });

  it("does not skip an unknown historical middle boundary", async () => {
    const newest = historical(545, 3, rockyRoad);
    const oldest = historical(543, 1, rockyRoad);
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 545, syncTime: time(3) },
        { guildId, syncNumber: 544, syncTime: time(2) },
        { guildId, syncNumber: 543, syncTime: time(1) },
      ],
      points: [newest.point, oldest.point],
      histories: [newest.history, oldest.history],
      participation: [...newest.participation, ...oldest.participation],
    });

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({ clanStreakSyncs: 1, clanStreakIsLowerBound: true, allianceStreakSyncs: 1, allianceStreakIsLowerBound: true });
  });

  it("keeps contradictory same-sync multi-clan roster evidence ambiguous", async () => {
    const first = historical(552, 1, rockyRoad);
    const second = historical(552, 1, partyBlizzard);
    const built = serviceFor(historicalFixture([first, second]));

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());
    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "AMBIGUOUS", clanTag: null, clanTags: [partyBlizzard, rockyRoad] });
    expect(result).toMatchObject({ clanStreakSyncs: 0, allianceStreakSyncs: 1 });
  });

  it("proves historical absence only when canonical participation coverage exists", async () => {
    const row = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const built = serviceFor(historicalFixture([row]));

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT", source: "FWA_WAR_PARTICIPATION" });
  });

  it("keeps historical absence unknown when canonical history has no participation roster", async () => {
    const row = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const built = serviceFor({
      ...historicalFixture([row]),
      participation: [],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.clanWarParticipation.groupBy).toHaveBeenCalledTimes(1);
  });

  it("keeps historical absence unknown when a second canonical clan has no participation roster", async () => {
    const resolved = historical(552, 1, rockyRoad, [otherPlayerTag], 1005520);
    const missing = historical(552, 1, partyBlizzard, [otherPlayerTag], 1005521);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 552, syncTime: time(1) }],
      points: [resolved.point, missing.point],
      histories: [resolved.history, missing.history],
      participation: resolved.participation,
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("keeps historical absence unknown when an expected participating clan is unresolved", async () => {
    const resolved = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const missing = historical(552, 1, partyBlizzard, [otherPlayerTag], 1005521);
    const built = serviceFor({
      ...historicalFixture([resolved]),
      points: [resolved.point, missing.point],
      histories: [resolved.history],
      participation: resolved.participation,
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("resolves canonical positive participation despite unmatched extra FWA evidence", async () => {
    const row = historical(552, 1, rockyRoad, [playerTag]);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [
        row.point,
        { ...row.point, clanTag: partyBlizzard, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1" },
      ],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "RESOLVED", clanTag: rockyRoad });
  });

  it("keeps absence unknown when an ambiguous owner accompanies complete coverage", async () => {
    const complete = historical(552, 1, rockyRoad, [otherPlayerTag], 1005520);
    const ambiguous = historical(552, 1, partyBlizzard, [otherPlayerTag], 1005521);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 552, syncTime: time(1) }],
      points: [complete.point, ambiguous.point],
      histories: [complete.history, ambiguous.history, { ...ambiguous.history, warId: 1005522 }],
      participation: complete.participation,
      lookups: [lookup(complete.history.warId, rockyRoad)],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("allows negative proof with unmatched non-FWA operational evidence", async () => {
    const row = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [
        row.point,
        { ...row.point, isFwa: false, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1" },
      ],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT", source: "FWA_WAR_PARTICIPATION" });
  });

  it("allows negative proof when dirty FWA-looking evidence is present", async () => {
    const row = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const built = serviceFor({
      ...historicalFixture([row]),
      points: [
        row.point,
        { ...row.point, needsValidation: true, warId: "900001", warStartTime: time(2), opponentTag: "#OLD1" },
      ],
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT", source: "FWA_WAR_PARTICIPATION" });
  });

  it("requires complete canonical coverage of every expected historical participating clan", async () => {
    const first = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const second = historical(552, 1, partyBlizzard, [otherPlayerTag], 1005521);
    const built = serviceFor(historicalFixture([first, second]));

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa).toMatchObject({ status: "ABSENT", source: "FWA_WAR_PARTICIPATION" });
  });

  it("returns exact zero streaks for an authoritative latest absence", async () => {
    const row = historical(552, 1, rockyRoad, [otherPlayerTag]);
    const built = serviceFor(historicalFixture([row]));

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({
      latestFwaEvidenceStatus: "ABSENT",
      clanStreakSyncs: 0,
      clanStreakIsLowerBound: false,
      allianceStreakSyncs: 0,
      allianceStreakIsLowerBound: false,
    });
  });

  it("terminates S/A exactly at an authoritative absent middle boundary", async () => {
    const rows = [
      historical(553, 3, rockyRoad),
      historical(552, 2, rockyRoad, [otherPlayerTag]),
      historical(551, 1, rockyRoad),
    ];
    const built = serviceFor(historicalFixture(rows));

    const [result] = await built.service.getMembershipStreaksForPlayers(input());

    expect(result).toMatchObject({
      clanStreakSyncs: 1,
      clanStreakIsLowerBound: false,
      allianceStreakSyncs: 1,
      allianceStreakIsLowerBound: false,
    });
  });

  it("preserves historical identity conflict protections", async () => {
    const point = historical(552, 1, rockyRoad, [], 900001);
    const canonical = historical(552, 1, rockyRoad, [playerTag], 100123);
    const built = serviceFor({
      cycles: [
        { guildId, syncNumber: 552, syncTime: time(1) },
        { guildId, syncNumber: 553, syncTime: time(2) },
      ],
      points: [point.point],
      histories: [{ ...point.history, syncNumber: 553 }, canonical.history],
      participation: canonical.participation,
    });

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
  });

  it("resolves a 50-player batch with bounded bulk reads", async () => {
    const alphabet = ["2", "8", "9"];
    const players = Array.from({ length: 50 }, (_, index) => {
      let remaining = index;
      let suffix = "";
      for (let position = 0; position < 4; position += 1) {
        suffix = alphabet[remaining % alphabet.length] + suffix;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return `#P${suffix}`;
    });
    const candidate = activeCandidate(553, 2);
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: players.map((tag) => activeRoster(553, 2, rockyRoad, tag)),
    }, [candidate]);

    const results = await built.service.getMembershipStreaksForPlayers(input(players));

    expect(results).toHaveLength(50);
    expect(built.db.syncCycle.groupBy).toHaveBeenCalledTimes(1);
    expect(built.db.syncCycle.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.warAttacks.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.clanWarParticipation.findMany).not.toHaveBeenCalled();
  });
});
