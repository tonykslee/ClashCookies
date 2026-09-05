import { describe, expect, it, vi } from "vitest";
import { CwlContinuityEvidenceService } from "../src/services/CwlContinuityEvidenceService";

const guildId = "guild-1";
const playerTag = "#P2222";
const season = "2026-04";
const cwlClanTag = "#CQL2";
const startsAt = new Date("2026-04-01T00:00:00.000Z");
const endsAt = new Date("2026-04-07T00:00:00.000Z");

function date(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

function window(overrides: Record<string, unknown> = {}) {
  return {
    season,
    startsAt,
    endsAt,
    timingCoverageComplete: true,
    startTimingResolved: true,
    endTimingResolved: true,
    missingTimingDetails: [],
    hasTrackedCwlClans: true,
    resolvedEventCount: 1,
    unresolvedCwlClans: [],
    ...overrides,
  };
}

function roster(eventInstanceId = "event-1", clanTag = cwlClanTag, eventLastObservedAt: Date | null = date("2026-04-06")) {
  return {
    eventInstanceId,
    season,
    playerTag,
    cwlClanTag: clanTag,
    eventInstance: { firstObservedAt: startsAt, lastObservedAt: eventLastObservedAt },
  };
}

function interval(firstObservedAt: Date, endedAt: Date | null = null, clanTag = cwlClanTag) {
  return { playerTag, clanTag, firstObservedAt, endedAt };
}

function serviceFor(input: {
  roster?: any[];
  tracked?: any[];
  intervals?: any[];
  cwlWindow?: Record<string, unknown>;
}) {
  const db = {
    cwlPlayerClanSeason: { findMany: vi.fn(async () => input.roster ?? []) },
    cwlTrackedClan: { findMany: vi.fn(async () => input.tracked ?? [{ season, tag: cwlClanTag }]) },
    allianceClanMembershipInterval: { findMany: vi.fn(async () => input.intervals ?? [interval(date("2026-03-30"), endsAt)]) },
  };
  const windowReader = { getCwlWindow: vi.fn(async () => window(input.cwlWindow)) };
  return { service: new CwlContinuityEvidenceService(db, windowReader), db, windowReader };
}

async function evidenceFor(input: Parameters<typeof serviceFor>[0], boundary = date("2026-04-02")) {
  return serviceFor(input).service.getEvidence({ guildId, playerTags: [playerTag], boundaryTimes: [boundary] });
}

describe("CwlContinuityEvidenceService", () => {
  it("A: accepts matching player roster, tracked clan, interval, and timing", async () => {
    const built = serviceFor({ roster: [roster()], intervals: [interval(date("2026-03-30"), endsAt)] });
    const result = await built.service.getEvidence({ guildId, playerTags: [playerTag], boundaryTimes: [date("2026-04-02")] });
    expect(result.exemptPairs.size).toBe(1);
    expect(built.db.cwlPlayerClanSeason.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.cwlTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(built.db.allianceClanMembershipInterval.findMany).toHaveBeenCalledTimes(1);
    expect(built.windowReader.getCwlWindow).toHaveBeenCalledTimes(1);
  });

  it("B: accepts a queued boundary before the official window when the interval continues into CWL", async () => {
    const result = await evidenceFor({ roster: [roster()], intervals: [interval(date("2026-03-30"), endsAt)] }, date("2026-03-31"));
    expect(result.exemptPairs.size).toBe(1);
  });

  it("C: rejects an unrelated pre-CWL interval that ends before CWL starts", async () => {
    const result = await evidenceFor({ roster: [roster()], intervals: [interval(date("2026-03-20"), date("2026-03-25"))] }, date("2026-03-31"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("D: rejects post-CWL camping after the known window end", async () => {
    const result = await evidenceFor({ roster: [roster()], intervals: [interval(date("2026-03-30"), null)] }, date("2026-04-08"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("E: rejects a CWL roster row without a matching alliance interval", async () => {
    const result = await evidenceFor({ roster: [roster()], intervals: [] });
    expect(result.exemptPairs.size).toBe(0);
  });

  it("F: does not attribute an interval without a player roster row", async () => {
    const result = await evidenceFor({ roster: [], intervals: [interval(date("2026-03-30"), endsAt)] });
    expect(result.exemptPairs.size).toBe(0);
  });

  it("G: rejects a player roster row whose CWL clan is not tracked for the season", async () => {
    const result = await evidenceFor({ roster: [roster()], tracked: [], intervals: [interval(date("2026-03-30"), endsAt)] });
    expect(result.exemptPairs.size).toBe(0);
  });

  it("H: fails closed when multiple persisted CWL owners match the same boundary", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", "#CQL2"), roster("event-2", "#CQL8")],
      tracked: [{ season, tag: "#CQL2" }, { season, tag: "#CQL8" }],
      intervals: [interval(date("2026-03-30"), endsAt, "#CQL2"), interval(date("2026-03-30"), endsAt, "#CQL8")],
    });
    expect(result.exemptPairs.size).toBe(0);
    expect(result.ambiguousCandidates).toBe(1);
  });

  it("I: rejects unresolved CWL timing", async () => {
    const result = await evidenceFor({ roster: [roster()], intervals: [interval(date("2026-03-30"), endsAt)], cwlWindow: { startTimingResolved: false, startsAt: null } });
    expect(result.exemptPairs.size).toBe(0);
  });

  it("J: accepts an ongoing interval after a resolved CWL start when no end is known", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag, date("2026-04-06"))],
      intervals: [interval(date("2026-03-30"), null)],
      cwlWindow: { endsAt: null, endTimingResolved: false },
    }, date("2026-04-06"));
    expect(result.exemptPairs.size).toBe(1);
  });

  it("K: rejects an unresolved CWL end when the boundary is after the last event observation", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag, date("2026-04-05"))],
      intervals: [interval(date("2026-03-30"), null)],
      cwlWindow: { endsAt: null, endTimingResolved: false },
    }, date("2026-04-06"));
    expect(result.exemptPairs.size).toBe(0);
  });

  it("L: accepts an unresolved CWL end when the event observation covers the boundary", async () => {
    const result = await evidenceFor({
      roster: [roster("event-1", cwlClanTag, date("2026-04-06"))],
      intervals: [interval(date("2026-03-30"), null)],
      cwlWindow: { endsAt: null, endTimingResolved: false },
    }, date("2026-04-06"));
    expect(result.exemptPairs.size).toBe(1);
  });
});
