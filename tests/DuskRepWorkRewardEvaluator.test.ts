import { describe, expect, it, vi } from "vitest";

import {
  DUSK_REP_WORK_EVALUATION_MAX_EVENTS,
  evaluateDuskRepWorkRewards,
  evaluateDuskRepWorkRewardsFromStore,
  type DuskRepWorkRewardEvaluationScope,
} from "../src/services/DuskRepWorkRewardEvaluator";
import type { HistoricalRepWorkEventRow } from "../src/services/duskHistoricalEarningsSimulation";

const scope: DuskRepWorkRewardEvaluationScope = {
  guildId: "guild-1",
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-19T00:00:00.000Z"),
  snapshotAt: new Date("2026-01-20T00:00:00.000Z"),
};

function event(id: string, dedupeKey: string, overrides: Partial<HistoricalRepWorkEventRow> = {}): HistoricalRepWorkEventRow {
  return {
    id,
    guildId: "guild-1",
    activityType: "BASES_CHECKED",
    discordUserId: "111111111111111",
    clanTag: "#HOME",
    syncMessageId: "sync-1",
    sourceMessageId: "message-1",
    sourceTrackedMessageId: "tracked-1",
    warId: "100",
    warStartTime: new Date("2026-01-06T12:00:00.000Z"),
    opponentTag: "#OPPONENT",
    eventAt: new Date("2026-01-07T10:00:00.000Z"),
    dedupeKey,
    metadata: {
      activityType: "BASES_CHECKED",
      source: "base_swap",
      clanKind: "FWA",
      viewType: "Bases",
    },
    createdAt: new Date("2026-01-07T10:00:01.000Z"),
    updatedAt: new Date("2026-01-07T10:00:01.000Z"),
    ...overrides,
  };
}

describe("Dusk rep-work reward evaluator", () => {
  it("deduplicates canonical keys and preserves eligible, ineligible, and UNKNOWN classifications", () => {
    const result = evaluateDuskRepWorkRewards({
      scope,
      events: [
        event("event-1", "dedupe-1"),
        event("event-2", "dedupe-1"),
        event("event-3", "dedupe-cwl", { metadata: { source: "base_swap", clanKind: "CWL" } }),
        event("event-4", "dedupe-missing-kind", { metadata: { source: "base_swap" } }),
        event("event-5", "dedupe-unknown", { metadata: { source: "other" } }),
      ],
    });

    expect(result.summary).toMatchObject({
      sourceRows: 5,
      eligibleEvents: 1,
      ineligibleEvents: 1,
      unknownEvents: 3,
      duplicateEvents: 1,
      uncappedSimulationOnlyDuskits: 2,
    });
    expect(result.events.map((row) => [row.classification, row.reasonCode])).toEqual([
      ["ELIGIBLE", "RECOGNIZED_FWA_REP_WORK"],
      ["INELIGIBLE", "DUPLICATE_DEDUPE_KEY"],
      ["UNKNOWN", "REP_EVENT_CWL_SOURCE"],
      ["UNKNOWN", "REP_EVENT_SOURCE_UNKNOWN"],
      ["UNKNOWN", "REP_EVENT_SOURCE_UNKNOWN"],
    ]);
  });

  it("fails closed for an UNKNOWN row paired with a valid same-key row regardless of order", () => {
    const unknown = event("event-unknown", "shared-key", { metadata: { source: "other" } });
    const valid = event("event-valid", "shared-key");
    const unknownFirst = evaluateDuskRepWorkRewards({ scope, events: [unknown, valid] });
    const validFirst = evaluateDuskRepWorkRewards({ scope, events: [valid, unknown] });

    expect(unknownFirst).toEqual(validFirst);
    expect(unknownFirst.summary).toMatchObject({ eligibleEvents: 0, unknownEvents: 2, cappedSimulationOnlyDuskits: 0 });
    expect(unknownFirst.events.map((row) => row.reasonCode)).toEqual([
      "REP_EVENT_DEDUPE_CONFLICT",
      "REP_EVENT_DEDUPE_CONFLICT",
    ]);
  });

  it("fails closed for conflicting Discord identities and FWA/CWL source evidence", () => {
    const identityConflict = evaluateDuskRepWorkRewards({
      scope,
      events: [
        event("event-a", "identity-conflict", { discordUserId: "111111111111111" }),
        event("event-b", "identity-conflict", { discordUserId: "222222222222222" }),
      ],
    });
    const sourceConflict = evaluateDuskRepWorkRewards({
      scope,
      events: [
        event("event-fwa", "source-conflict"),
        event("event-cwl", "source-conflict", { metadata: { source: "base_swap", clanKind: "CWL" } }),
      ],
    });

    expect(identityConflict.summary.eligibleEvents).toBe(0);
    expect(identityConflict.events.every((row) => row.reasonCode === "REP_EVENT_DEDUPE_CONFLICT")).toBe(true);
    expect(sourceConflict.summary.eligibleEvents).toBe(0);
    expect(sourceConflict.events.every((row) => row.reasonCode === "REP_EVENT_DEDUPE_CONFLICT")).toBe(true);
  });

  it("keeps identical recognized evidence deterministic while suppressing the duplicate row", () => {
    const result = evaluateDuskRepWorkRewards({
      scope,
      events: [event("event-a", "identical"), event("event-b", "identical")],
    });

    expect(result.events.map((row) => [row.sourceEventId, row.classification, row.reasonCode])).toEqual([
      ["event-a", "ELIGIBLE", "RECOGNIZED_FWA_REP_WORK"],
      ["event-b", "INELIGIBLE", "DUPLICATE_DEDUPE_KEY"],
    ]);
    expect(result.summary).toMatchObject({ eligibleEvents: 1, duplicateEvents: 1, uncappedSimulationOnlyDuskits: 2 });
  });

  it("fails closed for conflicting timestamps, clan/war identity, and message provenance in either input order", () => {
    const base = event("event-base", "context-conflict");
    const conflicts = [
      event("event-time", "context-conflict", { eventAt: new Date("2026-01-07T11:00:00.000Z") }),
      event("event-clan", "context-conflict", { clanTag: "#OTHER" }),
      event("event-war", "context-conflict", { warId: "101" }),
      event("event-war-start", "context-conflict", { warStartTime: new Date("2026-01-06T13:00:00.000Z") }),
      event("event-opponent", "context-conflict", { opponentTag: "#OTHEROPP" }),
      event("event-message", "context-conflict", { sourceMessageId: "message-2" }),
      event("event-tracked", "context-conflict", { sourceTrackedMessageId: "tracked-2" }),
      event("event-sync", "context-conflict", { syncMessageId: "sync-2" }),
    ];

    for (const conflicting of conflicts) {
      const forward = evaluateDuskRepWorkRewards({ scope, events: [base, conflicting] });
      const reverse = evaluateDuskRepWorkRewards({ scope, events: [conflicting, base] });
      expect(forward).toEqual(reverse);
      expect(forward.summary).toMatchObject({ eligibleEvents: 0, unknownEvents: 2, cappedSimulationOnlyDuskits: 0 });
      expect(forward.events.every((row) => row.reasonCode === "REP_EVENT_DEDUPE_CONFLICT")).toBe(true);
    }
  });

  it("treats optional context as equivalent when absent on both rows, but fails closed for missing-versus-present context", () => {
    const missingA = event("event-missing-a", "optional-context", {
      syncMessageId: null,
      sourceTrackedMessageId: null,
      warId: null,
      warStartTime: null,
      opponentTag: null,
    });
    const missingB = event("event-missing-b", "optional-context", {
      syncMessageId: null,
      sourceTrackedMessageId: null,
      warId: null,
      warStartTime: null,
      opponentTag: null,
    });
    const equivalent = evaluateDuskRepWorkRewards({ scope, events: [missingB, missingA] });
    expect(equivalent.summary).toMatchObject({ eligibleEvents: 1, duplicateEvents: 1 });

    const present = evaluateDuskRepWorkRewards({ scope, events: [missingA, event("event-present", "optional-context")] });
    expect(present.summary).toMatchObject({ eligibleEvents: 0, unknownEvents: 2 });
    expect(present.events.every((row) => row.reasonCode === "REP_EVENT_DEDUPE_CONFLICT")).toBe(true);
  });

  it("attributes directly to Discord identity and does not require PlayerLink evidence", () => {
    const result = evaluateDuskRepWorkRewards({
      scope,
      events: [
        event("event-a", "dedupe-a", { discordUserId: "111111111111111" }),
        event("event-b", "dedupe-b", { discordUserId: "222222222222222" }),
      ],
    });

    expect(result.summary.eligibleUsers).toBe(2);
    expect(result.weekly[0]?.users.map((user) => user.discordUserId)).toEqual([
      "111111111111111",
      "222222222222222",
    ]);
  });

  it("applies the UTC-week cap at the boundary while labeling the rate and cap simulation-only", () => {
    const events = Array.from({ length: 16 }, (_, index) => event(
      `event-${index}`,
      `dedupe-${index}`,
      { eventAt: new Date(`2026-01-07T${String(1 + index).padStart(2, "0")}:00:00.000Z`) },
    ));
    const result = evaluateDuskRepWorkRewards({ scope, events });

    expect(result.policy).toEqual({
      rateDuskits: 2,
      weeklyCapDuskits: 30,
      status: "SIMULATION_ONLY_NOT_APPROVED",
    });
    expect(result.weekly[0]).toMatchObject({
      totalUncappedSimulationOnlyDuskits: 32,
      totalCappedSimulationOnlyDuskits: 30,
      users: [{ eligibleEventCount: 16, uncappedSimulationOnlyDuskits: 32, cappedSimulationOnlyDuskits: 30 }],
    });
  });

  it("reports source updates without treating them as proven corrections", () => {
    const result = evaluateDuskRepWorkRewards({
      scope,
      events: [event("event-updated", "dedupe-updated", {
        updatedAt: new Date("2026-01-08T00:00:00.000Z"),
      })],
    });

    expect(result.summary).toMatchObject({ observedSourceUpdates: 1, provenCorrectionRows: 0 });
    expect(result.events[0]).toMatchObject({
      classification: "ELIGIBLE",
      sourceCorrectionStatus: "OBSERVED_UPDATE_NOT_PROVEN_CORRECTION",
    });
  });

  it("is deterministic across repeat evaluation and exposes a bounded read-only store adapter", async () => {
    const listEventsForEvaluation = vi.fn().mockResolvedValue([event("event-1", "dedupe-1")]);
    const first = await evaluateDuskRepWorkRewardsFromStore(scope, { listEventsForEvaluation });
    const second = await evaluateDuskRepWorkRewardsFromStore(scope, { listEventsForEvaluation });

    expect(first).toEqual(second);
    expect(listEventsForEvaluation).toHaveBeenCalledWith({
      guildId: "guild-1",
      from: scope.from,
      to: scope.to,
      limit: DUSK_REP_WORK_EVALUATION_MAX_EVENTS,
    });
  });

  it("is unchanged for repeated evaluation and reordered input", () => {
    const events = [
      event("event-z", "dedupe-z"),
      event("event-a", "dedupe-a"),
      event("event-b", "dedupe-a"),
    ];
    const first = evaluateDuskRepWorkRewards({ scope, events });
    const repeated = evaluateDuskRepWorkRewards({ scope, events });
    const reordered = evaluateDuskRepWorkRewards({ scope, events: [...events].reverse() });

    expect(repeated).toEqual(first);
    expect(reordered).toEqual(first);
  });

  it("keeps missing immutable identifiers and evidence UNKNOWN", () => {
    const result = evaluateDuskRepWorkRewards({
      scope,
      events: [
        event("", "dedupe-no-id"),
        event("event-no-dedupe", "", { metadata: { source: "base_swap", clanKind: "FWA" } }),
        event("event-no-user", "dedupe-no-user", { discordUserId: "not-a-discord-id" }),
      ],
    });

    expect(result.events.map((row) => row.reasonCode)).toEqual([
      "REP_EVENT_ID_MISSING",
      "REP_EVENT_DEDUPE_MISSING",
      "REP_EVENT_USER_INVALID",
    ]);
    expect(result.summary.eligibleEvents).toBe(0);
  });
});
