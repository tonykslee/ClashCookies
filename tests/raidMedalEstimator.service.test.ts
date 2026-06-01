import { describe, expect, it } from "vitest";
import {
  estimateRaidMedals,
  getRaidCapitalHallOffensiveMedalValue,
  getRaidDistrictHallOffensiveMedalValue,
} from "../src/services/RaidMedalEstimator";

describe("RaidMedalEstimator", () => {
  it.each([
    [1, 135],
    [2, 225],
    [3, 350],
    [4, 405],
    [5, 460],
  ])("resolves DH%s offensive value", (level, expected) => {
    expect(getRaidDistrictHallOffensiveMedalValue(level)).toBe(expected);
  });

  it.each([
    [2, 180],
    [3, 360],
    [4, 585],
    [5, 810],
    [6, 1115],
    [7, 1240],
    [8, 1260],
    [9, 1375],
    [10, 1450],
  ])("resolves CH%s offensive value", (level, expected) => {
    expect(getRaidCapitalHallOffensiveMedalValue(level)).toBe(expected);
  });

  it("estimates mixed district and capital clears with separate defensive medals", () => {
    const estimate = estimateRaidMedals({
      destroyedDistrictHallLevels: [1, 3, 5],
      destroyedCapitalHallLevels: [6, 10],
      totalClanOffensiveAttacksUsed: 60,
      defensiveMedals: 120,
    });

    expect(estimate).toMatchObject({
      offensiveBaseValue: 3510,
      offensiveMedalsPerAttack: 59,
      offensiveMedalsForSixAttacks: 354,
      defensiveMedals: 120,
      totalEstimatedMedals: 474,
      confidence: "complete",
    });
  });

  it("rounds offensive medals per attack up", () => {
    const estimate = estimateRaidMedals({
      destroyedDistrictHallLevels: [1],
      destroyedCapitalHallLevels: [],
      totalClanOffensiveAttacksUsed: 8,
      defensiveMedals: 0,
    });

    expect(estimate.offensiveMedalsPerAttack).toBe(17);
    expect(estimate.offensiveMedalsForSixAttacks).toBe(102);
  });

  it("handles zero attacks without divide-by-zero", () => {
    const estimate = estimateRaidMedals({
      destroyedDistrictHallLevels: [5],
      destroyedCapitalHallLevels: [10],
      totalClanOffensiveAttacksUsed: 0,
      defensiveMedals: 50,
    });

    expect(estimate).toMatchObject({
      offensiveBaseValue: 1910,
      offensiveMedalsPerAttack: null,
      offensiveMedalsForSixAttacks: null,
      defensiveMedals: 50,
      totalEstimatedMedals: null,
      confidence: "insufficient_offense",
    });
    expect(estimate.sourceNotes).toContain(
      "offensive_medals_unavailable=no_positive_attack_count",
    );
  });

  it("keeps defensive medals unknown instead of guessing them", () => {
    const estimate = estimateRaidMedals({
      destroyedDistrictHallLevels: [2],
      destroyedCapitalHallLevels: [3],
      totalClanOffensiveAttacksUsed: 5,
      defensiveMedals: null,
    });

    expect(estimate).toMatchObject({
      offensiveBaseValue: 585,
      offensiveMedalsPerAttack: 117,
      offensiveMedalsForSixAttacks: 702,
      defensiveMedals: null,
      totalEstimatedMedals: null,
      confidence: "partial",
    });
    expect(estimate.sourceNotes).toContain("defensive_medals=unknown_not_guessed");
  });

  it("ignores unknown hall levels and records source notes", () => {
    const estimate = estimateRaidMedals({
      destroyedDistrictHallLevels: [1, 99],
      destroyedCapitalHallLevels: [2, 99],
      totalClanOffensiveAttacksUsed: 7,
      defensiveMedals: 0,
    });

    expect(estimate.offensiveBaseValue).toBe(315);
    expect(estimate.sourceNotes).toContain("unknown_district_hall_levels=99");
    expect(estimate.sourceNotes).toContain("unknown_capital_hall_levels=99");
  });
});
