import { describe, expect, it } from "vitest";
import {
  EMPTY_COMPO_WAR_BUCKET_COUNTS,
  type CompoWarBucketCounts,
} from "../src/helper/compoWarBucketCounts";
import type { CompoWarWeightBucket } from "../src/helper/compoWarWeightBuckets";
import { buildCompoFillPlanForTest } from "../src/services/CompoFillPlanner";

function makeCounts(
  overrides: Partial<Record<CompoWarWeightBucket, number>> = {},
): CompoWarBucketCounts {
  return {
    ...EMPTY_COMPO_WAR_BUCKET_COUNTS,
    ...overrides,
  };
}

function makeClan(input: {
  clanTag: string;
  clanName: string;
  shortName?: string | null;
  memberCount: number;
  currentBucketCounts: Partial<Record<CompoWarWeightBucket, number>>;
  targetBucketCounts: Partial<Record<CompoWarWeightBucket, number>>;
}) {
  return {
    clanTag: input.clanTag,
    clanName: input.clanName,
    shortName: input.shortName ?? null,
    memberCount: input.memberCount,
    currentBucketCounts: makeCounts(input.currentBucketCounts),
    targetBucketCounts: makeCounts(input.targetBucketCounts),
    targetEvidence: "validated" as const,
    targetSupportsTh19: false,
  };
}

function makeFiller(input: {
  playerTag: string;
  playerName: string;
  resolvedWeight: number | null;
  currentClanTag?: string | null;
  currentClanName?: string | null;
  clanState?: "known" | "no_clan" | "unknown";
}) {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    resolvedWeight: input.resolvedWeight,
    currentClanTag: input.currentClanTag ?? null,
    currentClanName: input.currentClanName ?? null,
    clanState: input.clanState ?? "no_clan",
  };
}

describe("buildCompoFillPlan", () => {
  it("treats fillers outside tracked clans as available and returns unused external fillers when no slot remains", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#AAA111",
          clanName: "Alpha",
          memberCount: 49,
          currentBucketCounts: { TH15: 1, TH14: 48 },
          targetBucketCounts: { TH15: 2, TH14: 48 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#P1",
          playerName: "External One",
          resolvedWeight: 145000,
        }),
        makeFiller({
          playerTag: "#P2",
          playerName: "External Two",
          resolvedWeight: 155000,
        }),
      ],
    });

    expect(result.destinationPlans).toHaveLength(1);
    expect(result.destinationPlans[0].plannedMoves).toHaveLength(1);
    expect(result.destinationPlans[0].plannedMoves[0]?.filler.currentClanTag).toBeNull();
    expect(result.destinationPlans[0].plannedMoves[0]?.matchedBucket).toBe("TH15");
    expect(result.unusedAvailableFillers).toHaveLength(1);
    expect(result.unusedAvailableFillers[0]?.playerTag).toBe("#P2");
    expect(result.unavailableFillers).toHaveLength(0);
    expect(result.excludedFillers).toHaveLength(0);
    expect(result.remainingUnfilledClanSlots).toHaveLength(0);
  });

  it("allows tracked fillers with surplus and updates source and destination counts in memory", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#DST",
          clanName: "Destination",
          memberCount: 49,
          currentBucketCounts: { TH15: 1, TH14: 48 },
          targetBucketCounts: { TH15: 2, TH14: 48 },
        }),
        makeClan({
          clanTag: "#SRC",
          clanName: "Source",
          memberCount: 51,
          currentBucketCounts: { TH15: 2, TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#TRACKED",
          playerName: "Tracked Filler",
          resolvedWeight: 145000,
          currentClanTag: "#SRC",
          currentClanName: "Source",
        }),
      ],
    });

    const move = result.destinationPlans[0]?.plannedMoves[0];
    expect(move).toBeDefined();
    expect(move?.destinationClanTag).toBe("#DST");
    expect(move?.sourceClanTag).toBe("#SRC");
    expect(move?.sourceMemberCountBefore).toBe(51);
    expect(move?.sourceMemberCountAfter).toBe(50);
    expect(move?.sourceBucketCountsBefore?.TH15).toBe(2);
    expect(move?.sourceBucketCountsAfter?.TH15).toBe(1);
    expect(move?.destinationMemberCountBefore).toBe(49);
    expect(move?.destinationMemberCountAfter).toBe(50);
    expect(move?.destinationBucketCountsBefore?.TH15).toBe(1);
    expect(move?.destinationBucketCountsAfter?.TH15).toBe(2);
    expect(result.unavailableFillers).toHaveLength(0);
  });

  it("excludes missing-weight fillers and rejects tracked fillers without source surplus", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#DST",
          clanName: "Destination",
          memberCount: 49,
          currentBucketCounts: { TH15: 1, TH14: 48 },
          targetBucketCounts: { TH15: 2, TH14: 48 },
        }),
        makeClan({
          clanTag: "#SRC",
          clanName: "Source",
          memberCount: 51,
          currentBucketCounts: { TH15: 1, TH14: 50 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#BLOCKED",
          playerName: "Blocked",
          resolvedWeight: 145000,
          currentClanTag: "#SRC",
          currentClanName: "Source",
        }),
        makeFiller({
          playerTag: "#MISSING",
          playerName: "Missing Weight",
          resolvedWeight: null,
        }),
        makeFiller({
          playerTag: "#OK",
          playerName: "Okay",
          resolvedWeight: 145000,
        }),
      ],
    });

    expect(result.destinationPlans[0]?.plannedMoves).toHaveLength(1);
    expect(result.destinationPlans[0]?.plannedMoves[0]?.filler.playerTag).toBe("#OK");
    expect(result.unavailableFillers).toHaveLength(1);
    expect(result.unavailableFillers[0]).toMatchObject({
      playerTag: "#BLOCKED",
      reasonCodes: ["source_bucket_deficit"],
    });
    expect(result.excludedFillers).toHaveLength(1);
    expect(result.excludedFillers[0]).toMatchObject({
      playerTag: "#MISSING",
      reasonCodes: ["missing_weight"],
    });
  });

  it("fills the largest member deficit first", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#A",
          clanName: "Alpha",
          memberCount: 47,
          currentBucketCounts: { TH14: 47 },
          targetBucketCounts: { TH16: 1, TH14: 49 },
        }),
        makeClan({
          clanTag: "#B",
          clanName: "Bravo",
          memberCount: 49,
          currentBucketCounts: { TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#TH14",
          playerName: "TH14 Filler",
          resolvedWeight: 135000,
        }),
        makeFiller({
          playerTag: "#TH16",
          playerName: "TH16 Filler",
          resolvedWeight: 155000,
        }),
      ],
    });

    expect(result.destinationPlans.map((plan) => plan.clanTag)).toEqual(["#A", "#B"]);
    expect(result.destinationPlans[0]?.plannedMoves[0]?.destinationClanTag).toBe("#A");
    expect(result.destinationPlans[0]?.plannedMoves[0]?.matchedBucket).toBe("TH14");
  });

  it("prefers destination bucket deficits over generic open slots", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#C",
          clanName: "Charlie",
          memberCount: 49,
          currentBucketCounts: { TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#MATCH",
          playerName: "Matching",
          resolvedWeight: 145000,
        }),
        makeFiller({
          playerTag: "#GENERIC",
          playerName: "Generic",
          resolvedWeight: 155000,
        }),
      ],
    });

    expect(result.destinationPlans[0]?.plannedMoves[0]?.filler.playerTag).toBe("#MATCH");
    expect(result.destinationPlans[0]?.plannedMoves[0]?.matchedBucket).toBe("TH15");
    expect(result.unusedAvailableFillers.map((filler) => filler.playerTag)).toEqual([
      "#GENERIC",
    ]);
    expect(result.remainingUnfilledClanSlots).toHaveLength(0);
  });

  it("never recommends the same filler twice and returns remaining open slots when there are not enough valid fillers", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#A",
          clanName: "Alpha",
          memberCount: 48,
          currentBucketCounts: { TH14: 48 },
          targetBucketCounts: { TH15: 2, TH14: 48 },
        }),
        makeClan({
          clanTag: "#B",
          clanName: "Bravo",
          memberCount: 49,
          currentBucketCounts: { TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#ONE",
          playerName: "Only One",
          resolvedWeight: 145000,
        }),
      ],
    });

    const totalMoves = result.destinationPlans.reduce(
      (sum, plan) => sum + plan.plannedMoves.length,
      0,
    );
    expect(totalMoves).toBe(1);
    expect(result.destinationPlans[0]?.plannedMoves[0]?.filler.playerTag).toBe("#ONE");
    expect(result.remainingUnfilledClanSlots).toHaveLength(2);
    expect(result.remainingUnfilledClanSlots.map((slot) => slot.clanTag)).toEqual([
      "#A",
      "#B",
    ]);
  });

  it("accounts for the actual bucket on a nonmatching fallback while preserving null metadata", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#DST",
          clanName: "Destination",
          memberCount: 49,
          currentBucketCounts: { TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#FALLBACK",
          playerName: "Fallback",
          resolvedWeight: 135000,
        }),
      ],
    });

    const move = result.destinationPlans[0]?.plannedMoves[0];
    expect(move?.matchedBucket).toBeNull();
    expect(move?.destinationMemberCountBefore).toBe(49);
    expect(move?.destinationMemberCountAfter).toBe(50);
    expect(move?.destinationBucketCountsBefore.TH14).toBe(49);
    expect(move?.destinationBucketCountsAfter.TH14).toBe(50);
    expect(move?.destinationBucketCountsAfter.TH15).toBe(0);
  });

  it("conserves tracked-source bucket and member deltas for fallback moves", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#DST",
          clanName: "Destination",
          memberCount: 49,
          currentBucketCounts: { TH14: 49 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
        makeClan({
          clanTag: "#SRC",
          clanName: "Source",
          memberCount: 51,
          currentBucketCounts: { TH15: 1, TH14: 50 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({
          playerTag: "#TRACKED-FALLBACK",
          playerName: "Tracked Fallback",
          resolvedWeight: 135000,
          currentClanTag: "#SRC",
          currentClanName: "Source",
        }),
      ],
    });

    const move = result.destinationPlans[0]?.plannedMoves[0];
    expect(move?.matchedBucket).toBeNull();
    expect(move?.sourceMemberCountBefore).toBe(51);
    expect(move?.sourceMemberCountAfter).toBe(50);
    expect(move?.sourceBucketCountsBefore?.TH14).toBe(50);
    expect(move?.sourceBucketCountsAfter?.TH14).toBe(49);
    expect(move?.destinationBucketCountsAfter.TH14).toBe(50);
  });

  it("replays sequential matched and fallback snapshots without shared mutable state", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#DST",
          clanName: "Destination",
          memberCount: 48,
          currentBucketCounts: { TH14: 48 },
          targetBucketCounts: { TH15: 1, TH14: 49 },
        }),
      ],
      fillers: [
        makeFiller({ playerTag: "#MATCH", playerName: "Match", resolvedWeight: 145000 }),
        makeFiller({ playerTag: "#FALLBACK", playerName: "Fallback", resolvedWeight: 155000 }),
      ],
    });

    const moves = result.destinationPlans[0]?.plannedMoves ?? [];
    expect(moves).toHaveLength(2);
    expect(moves[0]?.matchedBucket).toBe("TH15");
    expect(moves[1]?.matchedBucket).toBeNull();
    expect(moves[0]?.destinationBucketCountsAfter.TH15).toBe(1);
    expect(moves[1]?.destinationBucketCountsBefore.TH15).toBe(1);
    expect(moves[1]?.destinationBucketCountsAfter.TH16).toBe(1);
    expect(moves[0]?.destinationBucketCountsAfter).not.toBe(
      moves[1]?.destinationBucketCountsBefore,
    );
  });

  it("withholds TH19 and malformed weights from legacy targets", () => {
    const result = buildCompoFillPlanForTest({
      trackedClans: [
        makeClan({
          clanTag: "#LEGACY",
          clanName: "Legacy",
          memberCount: 49,
          currentBucketCounts: { TH18: 49 },
          targetBucketCounts: { TH18: 50 },
        }),
      ],
      fillers: [
        makeFiller({ playerTag: "#TH19", playerName: "TH19", resolvedWeight: 181000 }),
        makeFiller({ playerTag: "#FRACTION", playerName: "Fraction", resolvedWeight: 181000.5 }),
        makeFiller({ playerTag: "#GAP", playerName: "Gap", resolvedWeight: 180500 }),
        makeFiller({ playerTag: "#HIGH", playerName: "High", resolvedWeight: 190001 }),
      ],
    });

    expect(result.destinationPlans[0]?.plannedMoves).toHaveLength(0);
    expect(result.remainingUnfilledClanSlots[0]?.remainingSlots).toBe(1);
    expect(result.unusedAvailableFillers.map((filler) => filler.playerTag)).toEqual(["#TH19"]);
    expect(result.excludedFillers.map((filler) => filler.playerTag)).toEqual([
      "#FRACTION",
      "#GAP",
      "#HIGH",
    ]);
  });

  it("fails closed for unavailable targets and omitted tracked source context", () => {
    const result = buildCompoFillPlanForTest({
      trackedClanTags: ["#MISSING-SOURCE", "#UNKNOWN-TARGET"],
      trackedClans: [
        {
          ...makeClan({
            clanTag: "#UNKNOWN-TARGET",
            clanName: "Unknown Target",
            memberCount: 49,
            currentBucketCounts: { TH14: 49 },
            targetBucketCounts: null as any,
          }),
          targetBucketCounts: null,
          targetEvidence: "unavailable",
        },
      ],
      fillers: [
        makeFiller({
          playerTag: "#TRACKED",
          playerName: "Tracked",
          resolvedWeight: 135000,
          currentClanTag: "#MISSING-SOURCE",
          currentClanName: "Missing Source",
        }),
      ],
    });

    expect(result.destinationPlans).toHaveLength(0);
    expect(result.remainingUnfilledClanSlots).toMatchObject([
      { clanTag: "#UNKNOWN-TARGET", remainingSlots: 1, targetMemberCount: 50 },
    ]);
    expect(result.unavailableFillers[0]).toMatchObject({
      playerTag: "#TRACKED",
      reasonCodes: ["source_context_unavailable"],
    });
  });
});
