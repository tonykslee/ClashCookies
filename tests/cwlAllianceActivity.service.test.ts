import { describe, expect, it, vi } from "vitest";
import { CwlAllianceActivityService } from "../src/services/CwlAllianceActivityService";

const season = "2026-04";
const guildId = "guild-1";
const cwlClan = "#QGRJ2222";
const cwlClanTwo = "#QGRJ8888";
const fwaClan = "#QGRJ9999";
const fwaClanTwo = "#QGRJ8889";
const playerOne = "#PYLQ2222";
const playerTwo = "#PYLQ8888";
const playerThree = "#PYLQ9999";

const at = (value: string) => new Date(value);

type Seed = {
  cwlTrackedClan?: any[];
  cwlEventClan?: any[];
  currentCwlRound?: any[];
  currentCwlPrepSnapshot?: any[];
  cwlRoundHistory?: any[];
  trackedClan?: any[];
  clanWarHistory?: any[];
  clanWarParticipation?: any[];
  cwlPlayerClanSeason?: any[];
};

function baseSeed(overrides: Seed = {}): Required<Seed> {
  const event = {
    id: "event-1",
    season,
    firstObservedAt: at("2026-04-01T00:00:00.000Z"),
    lastObservedAt: at("2026-04-08T00:00:00.000Z"),
  };
  return {
    cwlTrackedClan: [{ id: 1, season, tag: cwlClan, name: "CWL One" }],
    cwlEventClan: [{
      id: "event-clan-1",
      eventInstanceId: event.id,
      season,
      clanTag: cwlClan,
      isCurrent: false,
      firstObservedAt: event.firstObservedAt,
      lastObservedAt: event.lastObservedAt,
      eventInstance: event,
    }],
    currentCwlRound: [{
      eventInstanceId: event.id,
      clanTag: cwlClan,
      roundDay: 1,
      preparationStartTime: at("2026-04-01T00:00:00.000Z"),
      startTime: at("2026-04-02T00:00:00.000Z"),
      endTime: at("2026-04-08T00:00:00.000Z"),
    }],
    currentCwlPrepSnapshot: [],
    cwlRoundHistory: [{
      eventInstanceId: event.id,
      clanTag: cwlClan,
      roundDay: 7,
      roundState: "warEnded",
      preparationStartTime: at("2026-04-07T00:00:00.000Z"),
      startTime: at("2026-04-07T01:00:00.000Z"),
      endTime: at("2026-04-08T00:00:00.000Z"),
    }],
    trackedClan: [{ id: 1, tag: fwaClan, name: "FWA One" }],
    clanWarHistory: [{
      warId: 1,
      clanTag: fwaClan,
      clanName: "FWA One",
      opponentTag: "#QGRJ6666",
      opponentName: "Opponent",
      matchType: "FWA",
      warStartTime: at("2026-03-20T00:00:00.000Z"),
      warEndTime: at("2026-03-25T00:00:00.000Z"),
    }],
    clanWarParticipation: [{
      guildId,
      warId: "1",
      clanTag: fwaClan,
      playerTag: playerOne,
      playerName: "One",
      townHall: 16,
    }],
    cwlPlayerClanSeason: [{
      eventInstanceId: event.id,
      season,
      playerTag: playerOne,
      playerName: "One",
      townHall: 16,
      cwlClanTag: cwlClan,
      daysParticipated: 7,
    }],
    ...overrides,
  };
}

function matches(actual: any, condition: any): boolean {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    if ("in" in condition && !condition.in.map(String).includes(String(actual))) return false;
    if ("not" in condition && actual === condition.not) return false;
    if ("gt" in condition && !(actual > condition.gt)) return false;
    if ("gte" in condition && !(actual >= condition.gte)) return false;
    if ("lt" in condition && !(actual < condition.lt)) return false;
    if ("lte" in condition && !(actual <= condition.lte)) return false;
    return true;
  }
  return actual === condition;
}

function makeDb(seed: Seed = {}) {
  const data = baseSeed(seed);
  const model = (rows: any[]) => ({
    findMany: vi.fn(async (args: any = {}) => {
      const where = args.where ?? {};
      return rows.filter((row) => Object.entries(where).every(([key, condition]) => matches(row[key], condition)));
    }),
  });
  return {
    cwlTrackedClan: model(data.cwlTrackedClan),
    cwlEventClan: model(data.cwlEventClan),
    currentCwlRound: model(data.currentCwlRound),
    currentCwlPrepSnapshot: model(data.currentCwlPrepSnapshot),
    cwlRoundHistory: model(data.cwlRoundHistory),
    trackedClan: model(data.trackedClan),
    clanWarHistory: model(data.clanWarHistory),
    clanWarParticipation: model(data.clanWarParticipation),
    cwlPlayerClanSeason: model(data.cwlPlayerClanSeason),
    data,
  };
}

function activity(seed: Seed = {}) {
  const db = makeDb(seed);
  return { db, run: () => new CwlAllianceActivityService(db as any).getActivity({ season, guildId }) };
}

describe("CwlAllianceActivityService", () => {
  it("returns the canonical requested YYYY-MM season", async () => {
    const { run } = activity();
    expect((await run()).season).toBe(season);
  });

  it("resolves historical events without requiring isCurrent", async () => {
    const { run } = activity();
    const result = await run();
    expect(result.coverage.resolvedEventCount).toBe(1);
    expect(result.totals.cwlParticipantCount).toBe(1);
  });

  it("chooses the event with the latest persisted observation timestamps", async () => {
    const first = baseSeed();
    const secondEvent = { id: "event-2", season, firstObservedAt: at("2026-04-02T00:00:00.000Z"), lastObservedAt: at("2026-04-09T00:00:00.000Z") };
    first.cwlEventClan = [first.cwlEventClan[0], { ...first.cwlEventClan[0], id: "event-clan-2", eventInstanceId: secondEvent.id, eventInstance: secondEvent, lastObservedAt: secondEvent.lastObservedAt }];
    first.currentCwlRound = [{ ...first.currentCwlRound[0], eventInstanceId: secondEvent.id }];
    first.cwlPlayerClanSeason = [{ ...first.cwlPlayerClanSeason[0], eventInstanceId: secondEvent.id, playerTag: playerTwo }];
    const { run } = activity(first);
    const result = await run();
    expect(result.coverage.resolvedEventCount).toBe(1);
    expect(result.players.cwl.map((player) => player.playerTag)).toEqual([playerTwo]);
  });

  it("uses the stable event id as the final resolution tie-breaker", async () => {
    const first = baseSeed();
    const eventA = { id: "event-a", season, firstObservedAt: at("2026-04-02T00:00:00.000Z"), lastObservedAt: at("2026-04-09T00:00:00.000Z") };
    const eventB = { id: "event-b", ...eventA };
    first.cwlEventClan = [
      { ...first.cwlEventClan[0], eventInstanceId: eventA.id, eventInstance: eventA },
      { ...first.cwlEventClan[0], id: "event-clan-b", eventInstanceId: eventB.id, eventInstance: eventB },
    ];
    first.currentCwlRound = [{ ...first.currentCwlRound[0], eventInstanceId: eventB.id }];
    first.cwlPlayerClanSeason = [{ ...first.cwlPlayerClanSeason[0], eventInstanceId: eventB.id, playerTag: playerTwo }];
    const { run } = activity(first);
    expect((await run()).players.cwl[0].playerTag).toBe(playerTwo);
  });

  it("reports unresolved tracked CWL clans without failing the report", async () => {
    const { run } = activity({ cwlTrackedClan: [
      { id: 1, season, tag: cwlClan, name: "CWL One" },
      { id: 2, season, tag: cwlClanTwo, name: "CWL Two" },
    ] });
    const result = await run();
    expect(result.coverage.unresolvedCwlClans).toMatchObject([{ clanTag: cwlClanTwo, reason: "NO_HISTORICAL_EVENT" }]);
    expect(result.coverage.resolvedEventCount).toBe(1);
  });

  it("prefers preparation start and falls back to round start", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], preparationStartTime: null, startTime: at("2026-04-02T00:00:00.000Z") }],
      currentCwlPrepSnapshot: [{ eventInstanceId: "event-1", roundDay: 1, preparationStartTime: at("2026-04-01T00:00:00.000Z"), startTime: null, endTime: null }],
    });
    expect((await run()).cwlWindow.startsAt).toEqual(at("2026-04-01T00:00:00.000Z"));
  });

  it("uses Round 1 timing and ended Round 7 history for the CWL window", async () => {
    const { run } = activity({
      cwlRoundHistory: [
        { eventInstanceId: "event-1", roundDay: 1, roundState: "warEnded", preparationStartTime: at("2026-03-31T00:00:00.000Z"), startTime: at("2026-04-02T00:00:00.000Z"), endTime: at("2026-04-02T00:00:00.000Z") },
        { eventInstanceId: "event-1", roundDay: 7, roundState: "warEnded", preparationStartTime: null, startTime: at("2026-04-08T00:00:00.000Z"), endTime: at("2026-04-09T00:00:00.000Z") },
      ],
    });
    const result = await run();
    expect(result.cwlWindow.startsAt).toEqual(at("2026-03-31T00:00:00.000Z"));
    expect(result.cwlWindow.endsAt).toEqual(at("2026-04-09T00:00:00.000Z"));
  });

  it("does not invent an end for an incomplete or ongoing round set", async () => {
    const { run } = activity({ currentCwlRound: [{ ...baseSeed().currentCwlRound[0], endTime: null }], cwlRoundHistory: [] });
    const result = await run();
    expect(result.cwlWindow.endsAt).toBeNull();
    expect(result.cwlWindow.timingCoverageComplete).toBe(false);
    expect(result.postCwlRetention.available).toBe(false);
  });

  it("ignores a scheduled Day 4 current-round end while CWL is in progress", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], roundDay: 4, roundState: "inWar", endTime: at("2026-04-08T00:00:00.000Z") }],
      cwlRoundHistory: [],
    });
    const result = await run();
    expect(result.cwlWindow.endsAt).toBeNull();
  });

  it("ignores a scheduled Day 7 current-round end until ended history exists", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], roundDay: 7, roundState: "inWar", endTime: at("2026-04-08T00:00:00.000Z") }],
      cwlRoundHistory: [],
    });
    expect((await run()).cwlWindow.endsAt).toBeNull();
  });

  it("makes endsAt available from a valid ended Round 7 history row", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], roundDay: 1 }],
      cwlRoundHistory: [{ eventInstanceId: "event-1", roundDay: 7, roundState: "warEnded", endTime: at("2026-04-09T00:00:00.000Z") }],
    });
    expect((await run()).cwlWindow.endsAt).toEqual(at("2026-04-09T00:00:00.000Z"));
  });

  it("requires final-ended evidence for every selected event", async () => {
    const seed = baseSeed();
    const eventTwo = { id: "event-2", season, firstObservedAt: at("2026-04-01T00:00:00.000Z"), lastObservedAt: at("2026-04-08T00:00:00.000Z") };
    seed.cwlTrackedClan = [{ id: 1, season, tag: cwlClan }, { id: 2, season, tag: cwlClanTwo }];
    seed.cwlEventClan = [seed.cwlEventClan[0], { ...seed.cwlEventClan[0], id: "event-clan-2", eventInstanceId: eventTwo.id, clanTag: cwlClanTwo, eventInstance: eventTwo }];
    seed.currentCwlRound = [seed.currentCwlRound[0], { ...seed.currentCwlRound[0], eventInstanceId: eventTwo.id, clanTag: cwlClanTwo }];
    const { run } = activity(seed);
    const result = await run();
    expect(result.cwlWindow.endsAt).toBeNull();
    expect(result.cwlWindow.missingTimingDetails).toContain("event-2:FINAL_END_ROUND_7");
  });

  it("does not use Day 3 as the authoritative CWL start", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], roundDay: 3, preparationStartTime: at("2026-04-03T00:00:00.000Z") }],
      cwlRoundHistory: [{ eventInstanceId: "event-1", roundDay: 7, roundState: "warEnded", endTime: at("2026-04-09T00:00:00.000Z") }],
    });
    const result = await run();
    expect(result.cwlWindow.startsAt).toBeNull();
    expect(result.cwlWindow.missingTimingDetails).toContain("event-1:START_ROUND_1");
  });

  it("uses Round 1 startTime only when preparationStartTime is unavailable", async () => {
    const { run } = activity({
      currentCwlRound: [{ ...baseSeed().currentCwlRound[0], preparationStartTime: null, startTime: at("2026-04-02T00:00:00.000Z") }],
    });
    expect((await run()).cwlWindow.startsAt).toEqual(at("2026-04-02T00:00:00.000Z"));
  });

  it("selects the latest completed pre-CWL FWA war", async () => {
    const { run } = activity({ clanWarHistory: [
      baseSeed().clanWarHistory[0],
      { ...baseSeed().clanWarHistory[0], warId: 2, warStartTime: at("2026-03-26T00:00:00.000Z"), warEndTime: at("2026-03-30T00:00:00.000Z") },
      { ...baseSeed().clanWarHistory[0], warId: 3, warStartTime: at("2026-04-02T00:00:00.000Z"), warEndTime: at("2026-04-06T00:00:00.000Z") },
    ], clanWarParticipation: [
      ...baseSeed().clanWarParticipation,
      { ...baseSeed().clanWarParticipation[0], warId: "2", playerTag: playerTwo },
      { ...baseSeed().clanWarParticipation[0], warId: "3", playerTag: playerThree },
    ] });
    const result = await run();
    expect(result.preCwlClans[0].sourcePreCwlWar?.warId).toBe(2);
    expect(result.players.preFwa.map((player) => player.playerTag)).toEqual([playerTwo]);
  });

  it("uses war start and war id to break equal pre-CWL war timestamps", async () => {
    const baseWar = baseSeed().clanWarHistory[0];
    const { run } = activity({ clanWarHistory: [
      { ...baseWar, warId: 8, warStartTime: at("2026-03-25T00:00:00.000Z"), warEndTime: at("2026-03-30T00:00:00.000Z") },
      { ...baseWar, warId: 9, warStartTime: at("2026-03-26T00:00:00.000Z"), warEndTime: at("2026-03-30T00:00:00.000Z") },
    ], clanWarParticipation: [{ ...baseSeed().clanWarParticipation[0], warId: "9", playerTag: playerTwo }] });
    expect((await run()).preCwlClans[0].sourcePreCwlWar?.warId).toBe(9);
  });

  it("keeps missing pre-CWL clan coverage local to that clan", async () => {
    const { run } = activity({
      trackedClan: [{ id: 1, tag: fwaClan, name: "FWA One" }, { id: 2, tag: fwaClanTwo, name: "FWA Two" }],
      clanWarParticipation: [],
    });
    const result = await run();
    expect(result.coverage.preFwaClansExpected).toBe(2);
    expect(result.coverage.preFwaClansCovered).toBe(0);
    expect(result.preCwlClans).toHaveLength(2);
    expect(result.preCwlClans.every((clan) => clan.coverageAvailable === false)).toBe(true);
  });

  it("uses an incomplete persisted roster as usable pre-CWL evidence", async () => {
    const { run } = activity({ clanWarParticipation: [{ ...baseSeed().clanWarParticipation[0], playerTag: playerTwo }] });
    const result = await run();
    expect(result.coverage.preFwaClansCovered).toBe(1);
    expect(result.preCwlClans[0].preCwlRosterCount).toBe(1);
  });

  it("reconciles duplicate pre-CWL player attribution to the later war", async () => {
    const baseWar = baseSeed().clanWarHistory[0];
    const { run } = activity({
      trackedClan: [{ id: 1, tag: fwaClan, name: "FWA One" }, { id: 2, tag: fwaClanTwo, name: "FWA Two" }],
      clanWarHistory: [baseWar, { ...baseWar, warId: 2, clanTag: fwaClanTwo, warEndTime: at("2026-03-30T00:00:00.000Z") }],
      clanWarParticipation: [
        { ...baseSeed().clanWarParticipation[0], playerTag: playerTwo },
        { ...baseSeed().clanWarParticipation[0], warId: "2", clanTag: fwaClanTwo, playerTag: playerTwo },
      ],
    });
    const result = await run();
    expect(result.coverage.duplicateReconciliations).toBeGreaterThanOrEqual(1);
    expect(result.players.preFwa[0].homeFwaClanTag).toBe(fwaClanTwo);
    expect(result.preCwlClans.find((clan) => clan.clanTag === fwaClan)).toMatchObject({ preCwlRosterCount: 0, sourcePreCwlRosterCount: 1 });
    expect(result.preCwlClans.find((clan) => clan.clanTag === fwaClanTwo)).toMatchObject({ preCwlRosterCount: 1, sourcePreCwlRosterCount: 1 });
  });

  it("excludes CWL rows with zero participation days", async () => {
    const { run } = activity({ cwlPlayerClanSeason: [{ ...baseSeed().cwlPlayerClanSeason[0], daysParticipated: 0 }] });
    expect((await run()).totals.cwlParticipantCount).toBe(0);
  });

  it("deduplicates CWL evidence and keeps the strongest days value", async () => {
    const { run } = activity({ cwlPlayerClanSeason: [
      { ...baseSeed().cwlPlayerClanSeason[0], daysParticipated: 3 },
      { ...baseSeed().cwlPlayerClanSeason[0], cwlClanTag: cwlClanTwo, daysParticipated: 7 },
    ] });
    const result = await run();
    expect(result.totals.cwlParticipantCount).toBe(1);
    expect(result.players.cwl[0]).toMatchObject({ daysParticipated: 7, cwlClanTag: cwlClanTwo });
    expect(result.coverage.duplicateReconciliations).toBeGreaterThanOrEqual(1);
  });

  it("builds the 1-through-7 participation histogram", async () => {
    const validTags = ["#PYLQ0002", "#PYLQ0008", "#PYLQ0009", "#PYLQ0022", "#PYLQ0028", "#PYLQ0029", "#PYLQ0088"];
    const rows = Array.from({ length: 7 }, (_, index) => ({ ...baseSeed().cwlPlayerClanSeason[0], playerTag: validTags[index], daysParticipated: index + 1 }));
    const { run } = activity({ cwlPlayerClanSeason: rows });
    const result = await run();
    expect(result.participationDayHistogram).toEqual({ "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 1 });
  });

  it("keeps unexpected participation days visible separately", async () => {
    const { run } = activity({ cwlPlayerClanSeason: [{ ...baseSeed().cwlPlayerClanSeason[0], daysParticipated: 8 }] });
    const result = await run();
    expect(result.unexpectedParticipationDays).toEqual({ "8": 1 });
    expect(result.participationDayHistogram["7"]).toBe(0);
  });

  it("derives BOTH, FWA-only, and CWL-only cohorts without inflating counts", async () => {
    const { run } = activity({
      clanWarParticipation: [
        { ...baseSeed().clanWarParticipation[0], playerTag: playerOne },
        { ...baseSeed().clanWarParticipation[0], playerTag: playerTwo },
      ],
      cwlPlayerClanSeason: [
        { ...baseSeed().cwlPlayerClanSeason[0], playerTag: playerOne },
        { ...baseSeed().cwlPlayerClanSeason[0], playerTag: playerThree },
      ],
    });
    const result = await run();
    expect(result.totals).toMatchObject({ preFwaCount: 2, cwlParticipantCount: 2, bothCount: 1, fwaOnlyCount: 1, cwlOnlyCount: 1 });
    expect(result.percentages.bothOfPreFwa).toBe(50);
  });

  it("preserves home FWA clan and aggregates movement for BOTH players", async () => {
    const { run } = activity();
    const result = await run();
    expect(result.players.both[0].homeFwaClanTag).toBe(fwaClan);
    expect(result.movementSummary).toEqual([{ homeFwaClanTag: fwaClan, cwlClanTag: cwlClan, accountCount: 1 }]);
  });

  it("selects the first qualifying post-CWL FWA war per tracked clan", async () => {
    const baseWar = baseSeed().clanWarHistory[0];
    const { run } = activity({ clanWarHistory: [
      baseWar,
      { ...baseWar, warId: 4, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") },
      { ...baseWar, warId: 5, warStartTime: at("2026-04-12T00:00:00.000Z"), warEndTime: at("2026-04-13T00:00:00.000Z") },
    ], clanWarParticipation: [
      ...baseSeed().clanWarParticipation,
      { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerTwo },
      { ...baseSeed().clanWarParticipation[0], warId: "5", playerTag: playerThree },
    ] });
    expect((await run()).preCwlClans[0].sourcePostCwlWar?.warId).toBe(4);
  });

  it("returns post-CWL returned, not-returned, and new-player sets", async () => {
    const { run } = activity({
      clanWarHistory: [...baseSeed().clanWarHistory, { ...baseSeed().clanWarHistory[0], warId: 4, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") }],
      clanWarParticipation: [
        ...baseSeed().clanWarParticipation,
        { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerOne },
        { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerTwo },
      ],
    });
    const result = await run();
    expect(result.postCwlRetention.returnedAfterCwl.map((player) => player.playerTag)).toEqual([playerOne]);
    expect(result.postCwlRetention.notReturnedAfterCwl).toHaveLength(0);
    expect(result.postCwlRetention.newPostCwlFwa.map((player) => player.playerTag)).toEqual([playerTwo]);
    expect(result.postCwlRetention.retentionRate).toBe(100);
  });

  it("does not let post evidence from a pre-uncovered clan satisfy retention coverage", async () => {
    const baseWar = baseSeed().clanWarHistory[0];
    const { run } = activity({
      trackedClan: [{ id: 1, tag: fwaClan }, { id: 2, tag: fwaClanTwo }],
      clanWarHistory: [
        baseWar,
        { ...baseWar, warId: 5, clanTag: fwaClanTwo, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") },
      ],
      clanWarParticipation: [
        baseSeed().clanWarParticipation[0],
        { ...baseSeed().clanWarParticipation[0], warId: "5", clanTag: fwaClanTwo, playerTag: playerTwo },
      ],
    });
    const result = await run();
    expect(result.coverage).toMatchObject({ expectedPostClanCount: 1, coveredPostClanCount: 0, postCoverageComplete: false });
    expect(result.postCwlRetention.retentionRate).toBeNull();
  });

  it("counts a post-covered clan only when it is also pre-covered", async () => {
    const baseWar = baseSeed().clanWarHistory[0];
    const { run } = activity({
      trackedClan: [{ id: 1, tag: fwaClan }, { id: 2, tag: fwaClanTwo }],
      clanWarHistory: [
        baseWar,
        { ...baseWar, warId: 4, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") },
        { ...baseWar, warId: 5, clanTag: fwaClanTwo, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") },
      ],
      clanWarParticipation: [
        baseSeed().clanWarParticipation[0],
        { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerOne },
        { ...baseSeed().clanWarParticipation[0], warId: "5", clanTag: fwaClanTwo, playerTag: playerTwo },
      ],
    });
    const result = await run();
    expect(result.coverage).toMatchObject({ expectedPostClanCount: 1, coveredPostClanCount: 1, postCoverageComplete: true });
  });

  it("keeps global retention null when one expected post-CWL clan is uncovered", async () => {
    const { run } = activity({
      trackedClan: [{ id: 1, tag: fwaClan, name: "FWA One" }, { id: 2, tag: fwaClanTwo, name: "FWA Two" }],
      clanWarHistory: [
        ...baseSeed().clanWarHistory,
        { ...baseSeed().clanWarHistory[0], warId: 2, clanTag: fwaClanTwo, clanName: "FWA Two" },
        { ...baseSeed().clanWarHistory[0], warId: 4, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") },
      ],
      clanWarParticipation: [
        baseSeed().clanWarParticipation[0],
        { ...baseSeed().clanWarParticipation[0], warId: "2", clanTag: fwaClanTwo, playerTag: playerTwo },
        { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerOne },
      ],
    });
    const result = await run();
    expect(result.coverage.postCoverageComplete).toBe(false);
    expect(result.postCwlRetention.retentionRate).toBeNull();
  });

  it("reports per-home-clan post retention only for covered clans", async () => {
    const { run } = activity({
      clanWarHistory: [...baseSeed().clanWarHistory, { ...baseSeed().clanWarHistory[0], warId: 4, warStartTime: at("2026-04-10T00:00:00.000Z"), warEndTime: at("2026-04-11T00:00:00.000Z") }],
      clanWarParticipation: [
        baseSeed().clanWarParticipation[0],
        { ...baseSeed().clanWarParticipation[0], warId: "4", playerTag: playerOne },
      ],
    });
    const result = await run();
    expect(result.preCwlClans[0]).toMatchObject({ preCwlRosterCount: 1, sourcePreCwlRosterCount: 1, returnedAfterCwlCount: 1, retentionRate: 100 });
  });

  it("does not query CurrentWar owners", async () => {
    const { db, run } = activity();
    const forbidden = { findMany: vi.fn(() => { throw new Error("forbidden owner queried"); }) };
    (db as any).currentWar = forbidden;
    await expect(run()).resolves.toBeDefined();
    expect(forbidden.findMany).not.toHaveBeenCalled();
  });

  it("uses only injected persisted reads and makes no external API call", async () => {
    const { db, run } = activity();
    const result = await run();
    expect(Object.keys(db).sort()).toEqual([
      "clanWarHistory", "clanWarParticipation", "cwlEventClan", "cwlPlayerClanSeason", "cwlRoundHistory",
      "cwlTrackedClan", "currentCwlPrepSnapshot", "currentCwlRound", "data", "trackedClan",
    ].sort());
    expect(result.totals.preFwaCount).toBe(1);
  });

  it("returns stable clan and player ordering regardless of input order", async () => {
    const seed = baseSeed({
      cwlTrackedClan: [{ id: 2, season, tag: cwlClanTwo }, { id: 1, season, tag: cwlClan }],
      trackedClan: [{ id: 2, tag: fwaClanTwo }, { id: 1, tag: fwaClan }],
    });
    const { run } = activity(seed);
    const result = await run();
    expect(result.preCwlClans.map((clan) => clan.clanTag)).toEqual([fwaClanTwo, fwaClan]);
    expect(result.players.preFwa.map((player) => player.playerTag)).toEqual([playerOne]);
  });

  it("does not issue a post-CWL war read when the persisted CWL end is unavailable", async () => {
    const { db, run } = activity({ currentCwlRound: [{ ...baseSeed().currentCwlRound[0], endTime: null }], cwlRoundHistory: [] });
    await run();
    expect(db.clanWarHistory.findMany).toHaveBeenCalledTimes(1);
  });

  it("emits one bounded summary log with the required counters", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { run } = activity();
    await run();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/event=activity_summary season=2026-04 .*cwl_clans=1 .*pre_fwa_accounts=1 .*duration_ms=\d+/);
    log.mockRestore();
  });
});
