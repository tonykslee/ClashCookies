import { describe, expect, it, vi } from "vitest";
import { MembershipStreakService } from "../src/services/MembershipStreakService";

const guildId = "guild-1";
const playerTag = "#P2222";
const rr = "#RRRR";
const eb = "#GJJJ";
const cwlOne = "#CULL";
const cwlTwo = "#CULP";

function time(day: number): Date {
  return new Date(`2026-08-${String(day).padStart(2, "0")}T12:00:00.000Z`);
}

type Fixture = {
  cycles?: any[];
  readiness?: any[];
  snapshots?: any[];
  intervals?: any[];
  points?: any[];
  histories?: any[];
  participation?: any[];
  evaluations?: any[];
};

function makeDb(fixture: Fixture = {}) {
  const db = {
    syncCycle: { findMany: vi.fn(async () => fixture.cycles ?? []) },
    syncClanReadinessSnapshot: { findMany: vi.fn(async () => fixture.readiness ?? []) },
    syncClanMemberSnapshot: { findMany: vi.fn(async () => fixture.snapshots ?? []) },
    allianceClanMembershipInterval: { findMany: vi.fn(async () => fixture.intervals ?? []) },
    clanPointsSync: { findMany: vi.fn(async () => fixture.points ?? []) },
    warPlanComplianceEvaluation: { findMany: vi.fn(async () => fixture.evaluations ?? []) },
    clanWarHistory: { findMany: vi.fn(async () => fixture.histories ?? []) },
    clanWarParticipation: { findMany: vi.fn(async () => fixture.participation ?? []) },
  };
  return db;
}

function cycleRows(days: number[]) {
  return days.map((day, index) => ({ syncNumber: 540 + index, syncTime: time(day) }));
}

function snapshot(day: number, clanTag: string, tag = playerTag) {
  return { guildId, syncTime: time(day), clanTag, playerTag: tag };
}

function interval(dayStart: number, dayEnd: number, clanTag: string, tag = playerTag) {
  return {
    guildId,
    playerTag: tag,
    clanTag,
    firstObservedAt: time(dayStart),
    lastObservedAt: time(dayEnd),
    endedAt: time(dayEnd),
  };
}

function streakInput(playerTags = [playerTag], maxBoundaries?: number) {
  return { guildId, playerTags, ...(maxBoundaries === undefined ? {} : { maxBoundaries }) };
}

describe("MembershipStreakService", () => {
  it("counts three exact snapshots as three-sync clan and alliance streaks", async () => {
    const db = makeDb({
      cycles: cycleRows([1, 2, 3]),
      snapshots: [snapshot(1, rr), snapshot(2, rr), snapshot(3, rr)],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());

    expect(result).toMatchObject({
      playerTag,
      latestBoundaryTime: time(3),
      latestFwaClanTag: rr,
      clanStreakSyncs: 3,
      clanStreakIsLowerBound: false,
      allianceStreakSyncs: 3,
      allianceStreakIsLowerBound: false,
      latestEvidenceAvailable: true,
    });
  });

  it("keeps alliance streak across a physical FWA clan move", async () => {
    const db = makeDb({
      cycles: cycleRows([1, 2, 3, 4]),
      snapshots: [
        snapshot(1, rr), snapshot(2, rr), snapshot(3, eb), snapshot(4, rr),
      ],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());

    expect(result).toMatchObject({ clanStreakSyncs: 1, allianceStreakSyncs: 4 });
  });

  it("preserves alliance streak through a seasonal CWL interval without extending physical clan streak", async () => {
    const db = makeDb({
      cycles: cycleRows([1, 2, 3]),
      snapshots: [snapshot(1, rr), snapshot(3, rr)],
      intervals: [interval(2, 2, cwlOne)],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());

    expect(result).toMatchObject({
      latestFwaClanTag: rr,
      clanStreakSyncs: 1,
      clanStreakIsLowerBound: true,
      allianceStreakSyncs: 3,
      allianceStreakIsLowerBound: false,
    });
  });

  it("does not skip an unknown middle boundary", async () => {
    const db = makeDb({
      cycles: cycleRows([1, 2, 3]),
      readiness: [{ syncTime: time(2) }],
      snapshots: [snapshot(1, rr), snapshot(3, rr)],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());

    expect(result).toMatchObject({
      clanStreakSyncs: 1,
      clanStreakIsLowerBound: true,
      allianceStreakSyncs: 1,
      allianceStreakIsLowerBound: true,
    });
  });

  it("never chooses one clan from ambiguous exact same-boundary membership", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(1) }],
      snapshots: [snapshot(1, rr), snapshot(1, eb)],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());
    const evidence = await new MembershipStreakService(db).getRecentFwaEvidenceForPlayers(streakInput());

    expect(result).toMatchObject({ clanStreakSyncs: 0, latestFwaClanTag: null, allianceStreakSyncs: 1 });
    expect(evidence[playerTag][0].fwa).toEqual({
      status: "AMBIGUOUS",
      clanTag: null,
      clanTags: [eb, rr],
      source: "SYNC_SNAPSHOT",
    });
  });

  it("counts multiple covering alliance interval clans as positive but ambiguous evidence", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(2) }],
      intervals: [interval(1, 3, cwlOne), interval(1, 3, cwlTwo)],
    });

    const evidence = await new MembershipStreakService(db).getMembershipBoundaryEvidenceForPlayers(streakInput());

    expect(evidence[playerTag][0].alliance).toEqual({
      positive: true,
      clanTags: [cwlOne, cwlTwo],
      ambiguous: true,
      sources: ["ALLIANCE_INTERVAL"],
    });
  });

  it("extends an older streak with guild-scoped historical FWA participation fallback", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(1) }, { syncNumber: 2, syncTime: time(2) }],
      snapshots: [snapshot(2, rr)],
      points: [{
        guildId,
        syncNum: 1,
        warId: "100",
        clanTag: rr,
        warStartTime: time(1),
        opponentTag: "#0PP2",
      }],
      histories: [{ warId: 100, syncNumber: 1, matchType: "FWA", clanTag: rr }],
      participation: [{ guildId, warId: "100", clanTag: rr, playerTag }],
    });

    const result = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());
    const evidence = await new MembershipStreakService(db).getRecentFwaEvidenceForPlayers(streakInput());

    expect(result[0]).toMatchObject({ clanStreakSyncs: 2, allianceStreakSyncs: 2 });
    expect(evidence[playerTag][0].fwa.source).toBe("SYNC_SNAPSHOT");
    expect(evidence[playerTag][1].fwa.source).toBe("FWA_WAR_PARTICIPATION_FALLBACK");
  });

  it("lets exact snapshots win over conflicting historical fallback evidence", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(1) }],
      snapshots: [snapshot(1, eb)],
      points: [{ syncNum: 1, warId: "101", clanTag: rr, warStartTime: time(1), opponentTag: "#0PP2" }],
      histories: [{ warId: 101, syncNumber: 1, matchType: "FWA", clanTag: rr }],
      participation: [{ warId: "101", clanTag: rr, playerTag }],
    });

    const evidence = await new MembershipStreakService(db).getRecentFwaEvidenceForPlayers(streakInput());

    expect(evidence[playerTag][0].fwa).toEqual({
      status: "RESOLVED",
      clanTag: eb,
      clanTags: [eb],
      source: "SYNC_SNAPSHOT",
    });
  });

  it("fails closed when historical guild/canonical ownership cannot be resolved", async () => {
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(1) }],
      histories: [{ warId: 102, syncNumber: 1, matchType: "FWA", clanTag: rr }],
      participation: [{ warId: "102", clanTag: rr, playerTag }],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput());

    expect(result).toMatchObject({ clanStreakSyncs: 0, allianceStreakSyncs: 0, latestEvidenceAvailable: false });
    expect(db.clanWarHistory.findMany).not.toHaveBeenCalled();
  });

  it("marks bounded history as a lower bound instead of an exact truncated streak", async () => {
    const db = makeDb({
      cycles: cycleRows([1, 2, 3]),
      snapshots: [snapshot(1, rr), snapshot(2, rr), snapshot(3, rr)],
    });

    const [result] = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput([playerTag], 2));

    expect(result).toMatchObject({
      clanStreakSyncs: 2,
      clanStreakIsLowerBound: true,
      allianceStreakSyncs: 2,
      allianceStreakIsLowerBound: true,
    });
    expect(db.syncCycle.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("resolves a 50-player batch with bounded bulk reads and no per-player calls", async () => {
    const players = Array.from({ length: 50 }, (_, index) => {
      const alphabet = ["2", "8", "9"];
      let remaining = index;
      let suffix = "";
      for (let position = 0; position < 4; position += 1) {
        suffix = alphabet[remaining % alphabet.length] + suffix;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return `#P${suffix}`;
    });
    const db = makeDb({
      cycles: [{ syncNumber: 1, syncTime: time(1) }],
      snapshots: players.map((tag) => snapshot(1, rr, tag)),
    });

    const results = await new MembershipStreakService(db).getMembershipStreaksForPlayers(streakInput(players));

    expect(results).toHaveLength(50);
    expect(db.syncCycle.findMany).toHaveBeenCalledTimes(1);
    expect(db.syncClanReadinessSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(db.syncClanMemberSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(db.allianceClanMembershipInterval.findMany).toHaveBeenCalledTimes(1);
    expect(db.clanPointsSync.findMany).toHaveBeenCalledTimes(1);
    expect(db.warPlanComplianceEvaluation.findMany).toHaveBeenCalledTimes(1);
    expect(db.clanWarParticipation.findMany).not.toHaveBeenCalled();
  });

  it("normalizes, deduplicates, and deterministically orders requested player tags", async () => {
    const db = makeDb();

    const results = await new MembershipStreakService(db).getMembershipStreaksForPlayers(
      streakInput(["p8888", "#P2222", "P8888", " #P2222"]),
    );

    expect(results.map((row) => row.playerTag)).toEqual(["#P2222", "#P8888"]);
    expect(db.syncClanMemberSnapshot.findMany).toHaveBeenCalledTimes(1);
  });
});
