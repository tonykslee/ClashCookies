import { describe, expect, it, vi } from "vitest";
import { CwlAllianceCampingService } from "../src/services/CwlAllianceCampingService";

const season = "2026-08";
const guildId = "guild-1";
const cwlOne = "#QGRJ2222";
const cwlTwo = "#QGRJ8888";
const homeOne = "#QGRJ9999";
const homeTwo = "#QGRJ8889";
const playerOne = "#PYLQ2222";
const playerTwo = "#PYLQ8888";
const playerThree = "#PYLQ9999";
const reportNow = new Date("2026-08-10T00:00:00.000Z");
const startsAt = new Date("2026-08-01T00:00:00.000Z");
const endsAt = new Date("2026-08-08T00:00:00.000Z");

const at = (value: string) => new Date(value);
const interval = (playerTag: string, clanTag: string, first: string, endedAt: string | null, last = endedAt ?? first) => ({
  playerTag,
  clanTag,
  firstObservedAt: at(first),
  lastObservedAt: at(last),
  endedAt: endedAt ? at(endedAt) : null,
});

function activity(overrides: Record<string, unknown> = {}): any {
  return {
    season,
    cwlWindow: { startsAt, endsAt, timingCoverageComplete: true, missingTimingDetails: [] },
    coverage: {
      cwlClanCount: 2,
      resolvedEventCount: 2,
      unresolvedCwlClans: [],
      preFwaClansExpected: 2,
      preFwaClansCovered: 2,
      postCoverageComplete: true,
      coveredPostClanCount: 2,
      expectedPostClanCount: 2,
      duplicateReconciliations: 0,
    },
    players: {
      preFwa: [
        { playerTag: playerOne, playerName: "One", townHall: 16, homeFwaClanTag: homeOne },
        { playerTag: playerTwo, playerName: "Two", townHall: 15, homeFwaClanTag: homeTwo },
      ],
      cwl: [],
      both: [],
      fwaOnly: [],
      cwlOnly: [],
    },
    ...overrides,
  };
}

function makeDb(intervals: any[], tracked = [
  { tag: cwlOne, name: "CWL One" },
  { tag: cwlTwo, name: "CWL Two" },
]) {
  return {
    cwlTrackedClan: { findMany: vi.fn(async () => tracked) },
    allianceClanMembershipInterval: { findMany: vi.fn(async () => intervals) },
  };
}

function camping(
  intervals: any[],
  activityResult: any = activity(),
  tracked?: any[],
  now = reportNow,
) {
  const db = makeDb(intervals, tracked);
  const reader = { getActivity: vi.fn(async () => activityResult) };
  const service = new CwlAllianceCampingService(db as any, reader as any, () => now);
  return { db, reader, run: () => service.getCamping({ season, guildId }) };
}

describe("CwlAllianceCampingService", () => {
  it("counts non-home CWL residence but not remaining in the home CWL clan", async () => {
    const { run } = camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      interval(playerTwo, homeTwo, "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
    ], activity(), [
      { tag: cwlOne, name: "CWL One" },
      { tag: homeTwo, name: "Home CWL" },
    ]);

    const result = await run();

    expect(result.players).toHaveLength(2);
    expect(result.players.find((player) => player.playerTag === playerOne)).toMatchObject({
      playerTag: playerOne,
      homeFwaClanTag: homeOne,
      duringCwlDurationMs: 2 * 24 * 60 * 60 * 1000,
    });
  });

  it("separates CWL-clan evidence without a historical home attribution", async () => {
    const result = await camping([
      interval(playerThree, cwlOne, "2026-08-02T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ], activity({ players: { ...activity().players, preFwa: [] } })).run();

    expect(result.players).toEqual([]);
    expect(result.unattributed).toEqual({
      observedAccountCount: 1,
      observedDurationMs: 2 * 24 * 60 * 60 * 1000,
    });
  });

  it("clips intervals to the CWL start and uses endedAt instead of lastObservedAt", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-07-30T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-06T00:00:00.000Z"),
    ]).run();

    expect(result.players[0].duringCwlDurationMs).toBe(1 * 24 * 60 * 60 * 1000);
  });

  it("uses the injected report time for open intervals", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-02T00:00:00.000Z", null),
    ], activity({ cwlWindow: { startsAt, endsAt: null, timingCoverageComplete: false, missingTimingDetails: [] } }), undefined, at("2026-08-05T12:00:00.000Z")).run();

    expect(result.players[0]).toMatchObject({
      duringCwlDurationMs: 3.5 * 24 * 60 * 60 * 1000,
      postCwlDurationMs: null,
    });
  });

  it("separates completed CWL during and post-CWL camping", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-02T00:00:00.000Z", null),
    ]).run();

    expect(result.players[0]).toMatchObject({
      duringCwlDurationMs: 6 * 24 * 60 * 60 * 1000,
      postCwlDurationMs: 2 * 24 * 60 * 60 * 1000,
      totalObservedCampingDurationMs: 8 * 24 * 60 * 60 * 1000,
    });
    expect(result.summary.postCwlCamperCount).toBe(1);
  });

  it("keeps post-CWL metrics unavailable while CWL is ongoing", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-02T00:00:00.000Z", null),
    ], activity({ cwlWindow: { startsAt, endsAt: null, timingCoverageComplete: false, missingTimingDetails: [] } }), undefined, at("2026-08-05T00:00:00.000Z")).run();

    expect(result.summary.postCwlCamperCount).toBeNull();
    expect(result.summary.totalPostCwlCampingDurationMs).toBeNull();
    expect(result.players[0].postCwlDurationMs).toBeNull();
  });

  it("merges CWL transfers and overlapping malformed intervals without inflating player time", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
      interval(playerOne, cwlTwo, "2026-08-03T00:00:00.000Z", "2026-08-05T00:00:00.000Z"),
      interval(playerTwo, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      interval(playerTwo, cwlOne, "2026-08-02T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ]).run();

    expect(result.players.find((player) => player.playerTag === playerOne)).toMatchObject({
      duringCwlDurationMs: 4 * 24 * 60 * 60 * 1000,
      cwlClanTagsVisited: [cwlOne, cwlTwo],
    });
    expect(result.players.find((player) => player.playerTag === playerTwo)?.duringCwlDurationMs)
      .toBe(3 * 24 * 60 * 60 * 1000);
    expect(result.overlapReconciliationCount).toBeGreaterThan(0);
    expect(result.clans.find((clan) => clan.clanTag === cwlOne)?.totalDuringCwlCampingDurationMs)
      .toBe(5 * 24 * 60 * 60 * 1000);
  });

  it("keeps player and clan allocations equal across cross-clan overlap in both windows", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-09T00:00:00.000Z"),
      interval(playerOne, cwlTwo, "2026-08-07T00:00:00.000Z", "2026-08-10T00:00:00.000Z"),
    ]).run();

    const player = result.players.find((entry) => entry.playerTag === playerOne)!;
    const clanDuring = result.clans.reduce((sum, clan) => sum + (clan.totalDuringCwlCampingDurationMs ?? 0), 0);
    const clanPost = result.clans.reduce((sum, clan) => sum + (clan.totalPostCwlCampingDurationMs ?? 0), 0);
    expect(player.duringCwlDurationMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(player.postCwlDurationMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(clanDuring).toBe(result.summary.totalCampingDurationMs);
    expect(clanPost).toBe(result.summary.totalPostCwlCampingDurationMs);
  });

  it("breaks equal-start cross-clan overlap ties by ascending clan tag", async () => {
    const result = await camping([
      interval(playerOne, cwlTwo, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ]).run();

    expect(result.clans.find((clan) => clan.clanTag === cwlOne)?.totalDuringCwlCampingDurationMs)
      .toBe(1 * 24 * 60 * 60 * 1000);
    expect(result.clans.find((clan) => clan.clanTag === cwlTwo)?.totalDuringCwlCampingDurationMs)
      .toBe(0);
  });

  it("ignores non-CWL intervals and other guild history", async () => {
    const db = makeDb([
      interval(playerOne, "#OTHER", "2026-08-01T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ]);
    db.allianceClanMembershipInterval.findMany.mockResolvedValueOnce([]);
    const result = await new CwlAllianceCampingService(db as any, { getActivity: vi.fn(async () => activity()) } as any, () => reportNow)
      .getCamping({ season, guildId });

    expect(result.players).toEqual([]);
    expect(result.intervalRowCount).toBe(0);
  });

  it("classifies tracking history as PARTIAL or OBSERVED", async () => {
    const partial = await camping([
      interval(playerOne, cwlOne, "2026-08-03T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ]).run();
    const observed = await camping([
      interval(playerOne, cwlOne, "2026-07-31T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ]).run();

    expect(partial.trackingCoverage.status).toBe("PARTIAL");
    expect(partial.summary.zeroObservedCampingCount).toBeNull();
    expect(observed.trackingCoverage.status).toBe("OBSERVED");
    expect(observed.summary.zeroObservedCampingCount).toBe(1);
  });

  it("returns UNAVAILABLE rather than zeroes when no interval history exists", async () => {
    const result = await camping([]).run();

    expect(result.trackingCoverage.status).toBe("UNAVAILABLE");
    expect(result.trackingCoverage.trackingStartedAt).toBeNull();
    expect(result.summary.totalCampingDurationMs).toBeNull();
  });

  it("does not manufacture a CWL duration when startsAt is unavailable", async () => {
    const { db, run } = camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ], activity({ cwlWindow: { startsAt: null, endsAt: null, timingCoverageComplete: false, missingTimingDetails: ["start"] } }));

    const result = await run();

    expect(result.timing.available).toBe(false);
    expect(result.players).toEqual([]);
    expect(result.unattributed.observedDurationMs).toBeNull();
    expect(result.intervalRowCount).toBe(0);
    expect(db.allianceClanMembershipInterval.findMany).toHaveBeenCalledTimes(1);
  });

  it("detects only open non-home CWL intervals as current camping", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", null),
      interval(playerTwo, homeTwo, "2026-08-01T00:00:00.000Z", null),
    ]).run();

    expect(result.summary.currentlyCampingCount).toBe(1);
    expect(result.players.find((player) => player.playerTag === playerOne)?.currentlyCamping).toBe(true);
    expect(result.players.find((player) => player.playerTag === playerTwo)?.currentlyCamping).toBe(false);
  });

  it("reports the current streak separately from cumulative post-CWL camping", async () => {
    const result = await camping([
      interval(playerOne, cwlOne, "2026-08-07T00:00:00.000Z", "2026-08-09T00:00:00.000Z"),
      interval(playerOne, cwlTwo, "2026-08-09T21:00:00.000Z", null),
    ]).run();

    const player = result.players.find((entry) => entry.playerTag === playerOne)!;
    expect(player.postCwlDurationMs).toBe(27 * 60 * 60 * 1000);
    expect(player.currentCampingDurationMs).toBe(3 * 60 * 60 * 1000);
    expect(player.currentCampingSince).toEqual(at("2026-08-09T21:00:00.000Z"));
  });

  it("sorts players and clans deterministically by observed camping duration", async () => {
    const result = await camping([
      interval(playerOne, cwlTwo, "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
      interval(playerTwo, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-04T00:00:00.000Z"),
    ]).run();

    expect(result.players.map((player) => player.playerTag)).toEqual([playerTwo, playerOne]);
    expect(result.clans.map((clan) => clan.clanTag)).toEqual([cwlOne, cwlTwo]);
  });

  it("uses only the activity reader and interval/CWL registry reads, with no writes", async () => {
    const { db, reader, run } = camping([
      interval(playerOne, cwlOne, "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ]);

    await run();

    expect(reader.getActivity).toHaveBeenCalledWith({ season, guildId });
    expect(db.cwlTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(db.allianceClanMembershipInterval.findMany).toHaveBeenCalledTimes(2);
    expect((db as any).$transaction).toBeUndefined();
  });
});
