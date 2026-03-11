import { describe, expect, it } from "vitest";
import {
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
  sanitizeWarPlanForEmbedForTest,
} from "../src/services/WarEventLogService";
import { WarEventHistoryService } from "../src/services/war-events/history";

function dateAt(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, 0, 0));
}

describe("WarEventLogService.computeWarPointsDeltaForTest", () => {
  it("BL war: returns +3 points when final result is WIN", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 100,
        opponentStars: 99,
        clanDestruction: 59,
        opponentDestruction: 58,
        warEndTime: null,
        resultLabel: "WIN",
      },
    });
    expect(delta).toBe(3);
  });

  it("BL war: returns +2 points when not a win but clan destruction is >= 60%", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 60,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(2);
  });

  it("BL war: returns +1 point when not a win and clan destruction is < 60%", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "BL",
      before: 100,
      after: 100,
      finalResult: {
        clanStars: 90,
        opponentStars: 100,
        clanDestruction: 59.99,
        opponentDestruction: 70,
        warEndTime: null,
        resultLabel: "LOSE",
      },
    });
    expect(delta).toBe(1);
  });

  it("FWA war: returns arithmetic delta (after - before) when both values are present", () => {
    expect(
      computeWarPointsDeltaForTest({
        matchType: "FWA",
        before: 1200,
        after: 1205,
        finalResult: {
          clanStars: null,
          opponentStars: null,
          clanDestruction: null,
          opponentDestruction: null,
          warEndTime: null,
          resultLabel: "UNKNOWN",
        },
      })
    ).toBe(5);
  });

  it("MM war: always returns 0 points delta at war end", () => {
    expect(
      computeWarPointsDeltaForTest({
        matchType: "MM",
        before: 1200,
        after: 1197,
        finalResult: {
          clanStars: null,
          opponentStars: null,
          clanDestruction: null,
          opponentDestruction: null,
          warEndTime: null,
          resultLabel: "UNKNOWN",
        },
      })
    ).toBe(0);
  });

  it("FWA/MM war: returns null when before/after values are incomplete", () => {
    const delta = computeWarPointsDeltaForTest({
      matchType: "FWA",
      before: null,
      after: 100,
      finalResult: {
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      },
    });
    expect(delta).toBeNull();
  });
});

describe("WarEventHistoryService.buildWarEndPointsLine", () => {
  const history = new WarEventHistoryService({} as any);
  const baseResult = {
    clanStars: 100,
    opponentStars: 99,
    clanDestruction: 59,
    opponentDestruction: 58,
    warEndTime: null,
    resultLabel: "WIN" as const,
  };

  it("BL win: derives +3 and renders before->after even when after is missing", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: null,
      },
      baseResult
    );
    expect(line).toBe("Alpha: 100 -> 103 (+3) [BL]");
  });

  it("BL lose with 60%+ destruction: derives +2", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: null,
      },
      {
        ...baseResult,
        resultLabel: "LOSE",
        clanDestruction: 60,
      }
    );
    expect(line).toBe("Alpha: 100 -> 102 (+2) [BL]");
  });

  it("BL lose below 60% destruction: derives +1", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "BL",
        warStartFwaPoints: 100,
        warEndFwaPoints: null,
      },
      {
        ...baseResult,
        resultLabel: "LOSE",
        clanDestruction: 59.99,
      }
    );
    expect(line).toBe("Alpha: 100 -> 101 (+1) [BL]");
  });

  it("FWA war: renders arithmetic delta using stored before/after", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "FWA",
        warStartFwaPoints: 1200,
        warEndFwaPoints: 1205,
      },
      {
        ...baseResult,
        resultLabel: "UNKNOWN",
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
      }
    );
    expect(line).toBe("Alpha: 1200 -> 1205 (+5)");
  });

  it("MM war: renders no points change at war end", () => {
    const line = history.buildWarEndPointsLine(
      {
        clanName: "Alpha",
        matchType: "MM",
        warStartFwaPoints: 1200,
        warEndFwaPoints: 1197,
      },
      {
        ...baseResult,
        resultLabel: "UNKNOWN",
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
      }
    );
    expect(line).toBe("Alpha: 1200 -> 1200 (+0) [MM]");
  });
});

describe("WarEventLogService.computeWarComplianceForTest", () => {
  const participants = [
    { playerName: "Alice", playerTag: "#A", attacksUsed: 2, playerPosition: 1 },
    { playerName: "Bob", playerTag: "#B", attacksUsed: 2, playerPosition: 2 },
    { playerName: "Cory", playerTag: "#C", attacksUsed: 0, playerPosition: 3 },
  ];

  it("BL war: returns empty missedBoth and notFollowingPlan because war-plan enforcement is disabled", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [],
      matchType: "BL",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result).toEqual({ missedBoth: [], notFollowingPlan: [] });
  });

  it("MM war: returns empty missedBoth and notFollowingPlan because war-plan enforcement is disabled", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 2,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
      ],
      matchType: "MM",
      expectedOutcome: null,
      loseStyle: "TRADITIONAL",
    });
    expect(result).toEqual({ missedBoth: [], notFollowingPlan: [] });
  });

  it("FWA WIN plan: flags players who miss required mirror triple during strict window and invalid non-mirror strict-window hits", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 2,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 2,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "WIN",
      loseStyle: "TRADITIONAL",
    });
    expect(result.missedBoth).toEqual(["Cory"]);
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });

  it("FWA LOSE Triple-top-30 plan: flags attacks on defender positions 31-50", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 31,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRIPLE_TOP_30",
    });
    expect(result.notFollowingPlan).toEqual(["Alice"]);
  });

  it("FWA LOSE Traditional plan (late window <12h): flags mirror!=2-star and non-mirror!=1-star attacks", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 1,
          stars: 1,
          trueStars: 1,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 1,
          stars: 2,
          trueStars: 2,
          attackSeenAt: dateAt(11),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });

  it("FWA LOSE Traditional plan (early window >=12h): flags stars outside 1-2 and attacks that push cumulative stars over 100", () => {
    const result = computeWarComplianceForTest({
      clanTag: "#CLAN",
      participants,
      attacks: [
        {
          playerTag: "#A",
          playerName: "Alice",
          playerPosition: 1,
          defenderPosition: 1,
          stars: 3,
          trueStars: 3,
          attackSeenAt: dateAt(1),
          warEndTime: dateAt(20),
          attackOrder: 1,
        },
        {
          playerTag: "#B",
          playerName: "Bob",
          playerPosition: 2,
          defenderPosition: 2,
          stars: 2,
          trueStars: 101,
          attackSeenAt: dateAt(2),
          warEndTime: dateAt(20),
          attackOrder: 2,
        },
      ],
      matchType: "FWA",
      expectedOutcome: "LOSE",
      loseStyle: "TRADITIONAL",
    });
    expect(result.notFollowingPlan).toEqual(["Alice", "Bob"]);
  });
});

describe("WarEventLogService.sanitizeWarPlanForEmbedForTest", () => {
  it("omits heading-style lines and keeps non-heading lines in order", () => {
    const text = [
      "# Title",
      "Line 1",
      "  ## Subtitle",
      "",
      "  - Keep this",
      "   ### Internal Header",
      "Line 2",
    ].join("\n");

    const sanitized = sanitizeWarPlanForEmbedForTest(text);

    expect(sanitized?.split("\n")).toEqual(["Line 1", "", "  - Keep this", "Line 2"]);
  });

  it("keeps plans without heading lines unchanged", () => {
    const text = ["Line 1", "  - Keep this", "", "Line 2"].join("\n");

    const sanitized = sanitizeWarPlanForEmbedForTest(text);

    expect(sanitized).toBe(text);
  });

  it("returns null when all lines are heading-style lines", () => {
    const text = ["# Title", "  ## Subtitle", "   ### More"].join("\n");

    expect(sanitizeWarPlanForEmbedForTest(text)).toBeNull();
  });
});
