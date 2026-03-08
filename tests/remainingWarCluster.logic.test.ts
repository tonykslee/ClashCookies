import { describe, expect, it } from "vitest";
import {
  pickDominantClusterRankForTest,
  summarizeDominantRemainingCluster,
  type ActiveWarRemainingSample,
} from "../src/services/RemainingWarService";

/** Purpose: build concise remaining-time samples for cluster tests. */
function sample(
  clanTag: string,
  remainingMinutes: number,
  phase: "preparation" | "inWar" = "inWar"
): ActiveWarRemainingSample {
  return {
    clanTag,
    clanName: clanTag,
    phase,
    phaseEndAtMs: remainingMinutes * 60 * 1000,
    remainingSeconds: remainingMinutes * 60,
    remainingMinutes,
  };
}

describe("remaining-war clustering", () => {
  it("treats exactly 10-minute difference as same cluster boundary", () => {
    const result = summarizeDominantRemainingCluster(
      [sample("#A", 60), sample("#B", 70), sample("#C", 130)],
      10
    );

    expect(result?.dominantCluster.members.map((item) => item.clanTag)).toEqual(["#A", "#B"]);
    expect(result?.outliers.map((item) => item.clanTag)).toEqual(["#C"]);
  });

  it("selects the modal cluster by highest member count", () => {
    const result = summarizeDominantRemainingCluster(
      [sample("#A", 60), sample("#B", 65), sample("#C", 69), sample("#D", 140)],
      10
    );

    expect(result?.dominantCluster.members).toHaveLength(3);
    expect(result?.totalActiveWarClans).toBe(4);
    expect(result?.outliers.map((item) => item.clanTag)).toEqual(["#D"]);
  });

  it("uses smaller mean remaining as tie-breaker for equal cluster sizes", () => {
    const result = summarizeDominantRemainingCluster(
      [sample("#A", 60), sample("#B", 66), sample("#C", 120), sample("#D", 126)],
      10
    );

    expect(result?.dominantCluster.members.map((item) => item.clanTag)).toEqual(["#A", "#B"]);
    expect(result?.dominantCluster.meanRemainingSeconds).toBe(3780);
  });

  it("uses lexical key as deterministic fallback when size and mean tie", () => {
    const winner = pickDominantClusterRankForTest([
      { size: 2, meanRemainingSeconds: 3600, lexicalKey: "#B|#C" },
      { size: 2, meanRemainingSeconds: 3600, lexicalKey: "#A|#D" },
    ]);

    expect(winner?.lexicalKey).toBe("#A|#D");
  });
});

