import { describe, expect, it, vi } from "vitest";
import { MembershipStreakService } from "../src/services/MembershipStreakService";

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
  histories?: any[];
  participation?: any[];
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

function makeDb(fixture: Fixture = {}) {
  return {
    syncCycle: {
      findMany: vi.fn(async (args: any) => filteredRows(fixture.cycles ?? [], args)),
      groupBy: vi.fn(async (args: any) => groupedBoundaryRows(fixture.cycles ?? [], args)),
    },
    warAttacks: { findMany: vi.fn(async (args: any) => filteredRows(fixture.warAttacks ?? [], args)) },
    clanPointsSync: { findMany: vi.fn(async (args: any) => filteredRows(fixture.points ?? [], args)) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => []) },
    clanWarHistory: { findMany: vi.fn(async () => fixture.histories ?? []) },
    clanWarParticipation: {
      findMany: vi.fn(async (args: any) => filteredRows(fixture.participation ?? [], args)),
    },
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

function activeCandidate(syncNumber: number, day: number, clanTag = rockyRoad, warId = 200000 + syncNumber) {
  return {
    guildId,
    clanTag: clanTag.replace(/^#/, ""),
    warId,
    startTime: time(day),
    opponentTag: "0PP2",
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

function serviceFor(fixture: Fixture, candidates: any[] = [], conflict = false) {
  const db = makeDb(fixture);
  const activeReader = {
    findPersistedActiveSyncNumber: vi.fn(async () => ({
      syncNumber: candidates.length === 1 ? candidates[0].syncNumber : null,
      conflict,
      candidates,
    })),
  };
  return { service: new MembershipStreakService(db, activeReader), db, activeReader };
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

describe("MembershipStreakService", () => {
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

  it("fails closed when active canonical sync identity is ambiguous", async () => {
    const built = serviceFor({
      cycles: [{ guildId, syncNumber: 553, syncTime: time(2) }],
      warAttacks: [activeRoster(553, 2)],
    }, [activeCandidate(553, 2)], true);

    const evidence = await built.service.getRecentFwaEvidenceForPlayers(input());

    expect(evidence[playerTag][0].fwa.status).toBe("UNKNOWN");
    expect(built.db.warAttacks.findMany).not.toHaveBeenCalled();
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
