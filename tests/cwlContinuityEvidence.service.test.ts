import { describe, expect, it, vi } from "vitest";
import { CwlContinuityEvidenceService } from "../src/services/CwlContinuityEvidenceService";
import { resolvePersistedCwlEventTimings } from "../src/services/CwlEventTimingService";

const guildId = "guild-1";
const playerTag = "#P2222";
const season = "2026-04";
const cwlClanTag = "#CQL2";
const cwlClanTwo = "#CQL8";

function date(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function roster(eventInstanceId = "event-1", clanTag = cwlClanTag, player = playerTag, extra: Record<string, unknown> = {}) {
  return { eventInstanceId, season, playerTag: player, cwlClanTag: clanTag, ...extra };
}

function interval(firstObservedAt: Date, endedAt: Date | null = null, clanTag = cwlClanTag, player = playerTag) {
  return { playerTag: player, clanTag, firstObservedAt, endedAt };
}

function knownTiming(eventInstanceId = "event-1", clanTag = cwlClanTag) {
  return {
    current: [{
      eventInstanceId,
      clanTag,
      roundDay: 1,
      roundState: "preparation",
      preparationStartTime: date("2026-04-01"),
      startTime: date("2026-04-02"),
      endTime: null,
    }],
    prep: [],
    history: [{
      eventInstanceId,
      clanTag,
      roundDay: 7,
      roundState: "warEnded",
      preparationStartTime: date("2026-04-07"),
      startTime: date("2026-04-07"),
      endTime: date("2026-04-08"),
    }],
  };
}

function serviceFor(input: {
  roster?: any[];
  tracked?: any[];
  intervals?: any[];
  current?: any[];
  prep?: any[];
  history?: any[];
}) {
  const timing = knownTiming();
  const db = {
    cwlPlayerClanSeason: { findMany: vi.fn(async () => input.roster ?? [roster()]) },
    cwlTrackedClan: { findMany: vi.fn(async () => input.tracked ?? [{ season, tag: cwlClanTag }]) },
    allianceClanMembershipInterval: { findMany: vi.fn(async () => input.intervals ?? [interval(date("2026-03-30"), date("2026-04-08"))]) },
    currentCwlRound: { findMany: vi.fn(async () => input.current ?? timing.current) },
    currentCwlPrepSnapshot: { findMany: vi.fn(async () => input.prep ?? timing.prep) },
    cwlRoundHistory: { findMany: vi.fn(async () => input.history ?? timing.history) },
  };
  return { service: new CwlContinuityEvidenceService(db), db };
}

async function evidenceFor(
  input: Parameters<typeof serviceFor>[0],
  boundary = date("2026-04-02"),
  players = [playerTag],
) {
  return serviceFor(input).service.getEvidence({ guildId, playerTags: players, boundaryTimes: [boundary] });
}

describe("CwlContinuityEvidenceService", () => {
  it("resolves event-specific start, end, and known-through timing in one bulk batch", async () => {
    const first = knownTiming("event-1", cwlClanTag);
    const second = knownTiming("event-2", cwlClanTwo);
    const built = serviceFor({
      current: [...first.current, ...second.current],
      history: [...first.history, ...second.history.map((row) => ({
        ...row,
        endTime: date("2026-04-09"),
      }))],
    });
    const timings = await resolvePersistedCwlEventTimings(built.db, ["event-1", "event-2"]);
    expect(timings.get("event-1")).toMatchObject({
      eventInstanceId: "event-1",
      startsAt: date("2026-04-01"),
      endsAt: date("2026-04-08"),
      coverageThrough: date("2026-04-08"),
      startResolved: true,
      endResolved: true,
    });
    expect(timings.get("event-2")).toMatchObject({
      eventInstanceId: "event-2",
      startsAt: date("2026-04-01"),
      endsAt: date("2026-04-09"),
      coverageThrough: date("2026-04-09"),
      startResolved: true,
      endResolved: true,
    });
  });

  it("A: accepts an inside boundary from Round 1 start and ended Round 7 end", async () => {
    const built = serviceFor({ intervals: [interval(date("2026-03-30"), date("2026-04-08"))] });
    const result = await built.service.getEvidence({ guildId, playerTags: [playerTag], boundaryTimes: [date("2026-04-04")] });
    expect(result.exemptPairs.size).toBe(1);
    expect(built.db.cwlPlayerClanSeason.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.cwlTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.allianceClanMembershipInterval.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.currentCwlRound.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.currentCwlPrepSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.cwlRoundHistory.findMany).toHaveBeenCalledTimes(1);
  });

  it("B: rejects a boundary after the known final end", async () => {
    const result = await evidenceFor({ intervals: [interval(date("2026-03-30"), null)] }, date("2026-04-09"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("C: accepts an ongoing event through its persisted round coverage", async () => {
    const result = await evidenceFor({
      current: [
        { eventInstanceId: "event-1", roundDay: 1, preparationStartTime: date("2026-04-01"), startTime: date("2026-04-02"), endTime: null },
        { eventInstanceId: "event-1", roundDay: 4, roundState: "inWar", preparationStartTime: date("2026-04-04"), startTime: date("2026-04-05"), endTime: date("2026-04-05") },
      ],
      history: [],
    }, date("2026-04-05"));
    expect(result.exemptPairs.size).toBe(1);
  });

  it("D: rejects unresolved end coverage even when lastObservedAt is later", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag, playerTag, { eventInstance: { lastObservedAt: date("2026-04-10") } })],
      current: [
        { eventInstanceId: "event-1", roundDay: 1, preparationStartTime: date("2026-04-01"), startTime: date("2026-04-02") },
        { eventInstanceId: "event-1", roundDay: 3, startTime: date("2026-04-04") },
      ],
      history: [],
    }, date("2026-04-06"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("E: a late refreshed event observation cannot extend lifecycle coverage", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag, playerTag, { eventInstance: { firstObservedAt: date("2026-04-01"), lastObservedAt: date("2026-04-20") } })],
      current: [
        { eventInstanceId: "event-1", roundDay: 1, preparationStartTime: date("2026-04-01"), startTime: date("2026-04-02") },
        { eventInstanceId: "event-1", roundDay: 2, startTime: date("2026-04-03") },
      ],
      history: [],
    }, date("2026-04-04"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("F: accepts pre-CWL queueing when the same interval overlaps the event start", async () => {
    const result = await evidenceFor({ intervals: [interval(date("2026-03-30"), date("2026-04-03"))] }, date("2026-03-31"));
    expect(result.exemptPairs.size).toBe(1);
  });

  it("G: rejects a pre-CWL interval that ends before the event starts", async () => {
    const result = await evidenceFor({ intervals: [interval(date("2026-03-20"), date("2026-03-25"))] }, date("2026-03-31"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("H: keeps an unrelated unresolved tracked clan from vetoing the exact player event", async () => {
    const result = await evidenceFor({
      tracked: [{ season, tag: cwlClanTag }, { season, tag: cwlClanTwo }],
      roster: [roster()],
    });
    expect(result.exemptPairs.size).toBe(1);
  });

  it("I: rejects multiple player-specific event owners as ambiguous", async () => {
    const first = knownTiming("event-1", cwlClanTag);
    const second = knownTiming("event-2", cwlClanTwo);
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag), roster("event-2", cwlClanTwo)],
      tracked: [{ season, tag: cwlClanTag }, { season, tag: cwlClanTwo }],
      intervals: [interval(date("2026-03-30"), date("2026-04-08"), cwlClanTag), interval(date("2026-03-30"), date("2026-04-08"), cwlClanTwo)],
      current: [...first.current, ...second.current],
      history: [...first.history, ...second.history],
    });
    expect(result.exemptPairs.size).toBe(0);
    expect(result.ambiguousCandidates).toBe(1);
  });

  it("J: rejects a matching roster without a physical interval", async () => {
    const result = await evidenceFor({ intervals: [] });
    expect(result.exemptPairs.size).toBe(0);
  });

  it("K: rejects a physical interval without a matching player event roster", async () => {
    const result = await evidenceFor({ roster: [], intervals: [interval(date("2026-03-30"), date("2026-04-08"))] });
    expect(result.exemptPairs.size).toBe(0);
  });
});
