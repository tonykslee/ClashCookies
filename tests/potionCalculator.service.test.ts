import { describe, expect, it } from "vitest";
import {
  calculatePotionCompletion,
  formatPotionDuration,
  getPotionConfig,
  parsePotionDuration,
  POTION_NUM_POTS_INVALID_MESSAGE,
  POTION_TIME_LEFT_INVALID_MESSAGE,
} from "../src/services/PotionCalculatorService";

describe("PotionCalculatorService", () => {
  it("parses compact, spaced, and case-insensitive duration input", () => {
    expect(parsePotionDuration("3d12h45m")).toEqual({
      kind: "valid",
      totalSeconds: 305_100,
    });
    expect(parsePotionDuration("3D 12H 45M")).toEqual({
      kind: "valid",
      totalSeconds: 305_100,
    });
    expect(parsePotionDuration("12h30m")).toEqual({
      kind: "valid",
      totalSeconds: 45_000,
    });
    expect(formatPotionDuration(305_100)).toBe("3d 12h 45m");
    expect(formatPotionDuration(45_000)).toBe("12h 30m");
  });

  it("rejects malformed, duplicated, out-of-order, zero, negative, decimal, and overflow durations", () => {
    for (const input of [
      "",
      "abc",
      "0m",
      "-1h",
      "1.5h",
      "3d3d",
      "12h3d",
      "3d12h45m trailing",
      "999999999999999999999999999999d",
    ]) {
      const result = parsePotionDuration(input);
      expect(result).toEqual({
        kind: "invalid",
        message: POTION_TIME_LEFT_INVALID_MESSAGE,
      });
    }
  });

  it("rejects invalid potion counts before calculating", () => {
    const result = calculatePotionCompletion({
      type: "builder",
      timeLeft: "1h",
      numPots: 0,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "invalid",
      message: POTION_NUM_POTS_INVALID_MESSAGE,
    });
  });

  it("uses the builder potion configuration to finish a 54h upgrade in 36h with 2 potions", () => {
    const result = calculatePotionCompletion({
      type: "builder",
      timeLeft: "54h",
      numPots: 2,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "valid",
      type: "builder",
      typeLabel: "Builder Potion",
      speedMultiplier: 10,
      boostSecondsPerPotion: 3_600,
      numPots: 2,
      originalTimeLeftSeconds: 194_400,
      completionDurationSeconds: 129_600,
      timeSavedSeconds: 64_800,
    });
    if (result.kind === "valid") {
      expect(result.originalTimeLeftDisplay).toBe("2d 6h");
      expect(result.completionDurationDisplay).toBe("1d 12h");
      expect(result.timeSavedDisplay).toBe("18h");
      expect(result.completionUnixSeconds).toBe(
        Math.floor(new Date("2026-07-03T00:00:00.000Z").getTime() / 1000),
      );
      expect(result.completionAt.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    }
  });

  it("uses the research and pet 24x/1h configuration consistently", () => {
    expect(getPotionConfig("pet")).toMatchObject({
      label: "Pet Potion",
      speedMultiplier: 24,
      boostSecondsPerPotion: 3_600,
    });

    const research = calculatePotionCompletion({
      type: "research",
      timeLeft: "132h",
      numPots: 3,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });
    const pet = calculatePotionCompletion({
      type: "pet",
      timeLeft: "132h",
      numPots: 3,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(research).toMatchObject({
      kind: "valid",
      typeLabel: "Research Potion",
      speedMultiplier: 24,
      boostSecondsPerPotion: 3_600,
      originalTimeLeftSeconds: 475_200,
      completionDurationSeconds: 226_800,
      timeSavedSeconds: 248_400,
    });
    expect(pet).toMatchObject({
      kind: "valid",
      typeLabel: "Pet Potion",
      speedMultiplier: 24,
      boostSecondsPerPotion: 3_600,
      originalTimeLeftSeconds: 475_200,
      completionDurationSeconds: 226_800,
      timeSavedSeconds: 248_400,
    });
    if (research.kind === "valid" && pet.kind === "valid") {
      expect(research.completionDurationDisplay).toBe("2d 15h");
      expect(research.timeSavedDisplay).toBe("2d 21h");
      expect(pet.completionDurationDisplay).toBe("2d 15h");
      expect(pet.timeSavedDisplay).toBe("2d 21h");
    }
  });

  it("uses the clock tower configuration for 7h with one potion", () => {
    const result = calculatePotionCompletion({
      type: "clocktower",
      timeLeft: "7h",
      numPots: 1,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "valid",
      typeLabel: "Clock Tower Potion",
      speedMultiplier: 10,
      boostSecondsPerPotion: 1_800,
      completionDurationSeconds: 9_000,
      timeSavedSeconds: 16_200,
    });
    if (result.kind === "valid") {
      expect(result.completionDurationDisplay).toBe("2h 30m");
      expect(result.timeSavedDisplay).toBe("4h 30m");
    }
  });

  it("finishes exactly at the boost boundary for builder 10h with one potion", () => {
    const result = calculatePotionCompletion({
      type: "builder",
      timeLeft: "10h",
      numPots: 1,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "valid",
      completionDurationSeconds: 3_600,
      timeSavedSeconds: 32_400,
    });
    if (result.kind === "valid") {
      expect(result.completionDurationDisplay).toBe("1h");
      expect(result.timeSavedDisplay).toBe("9h");
      expect(result.completionUnixSeconds).toBe(
        Math.floor(new Date("2026-07-01T13:00:00.000Z").getTime() / 1000),
      );
    }
  });

  it("rounds partial boost completion up to the next whole second", () => {
    const result = calculatePotionCompletion({
      type: "research",
      timeLeft: "30m",
      numPots: 1,
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "valid",
      completionDurationSeconds: 75,
      timeSavedSeconds: 1_725,
    });
    if (result.kind === "valid") {
      expect(result.completionDurationDisplay).toBe("1m 15s");
      expect(result.timeSavedDisplay).toBe("28m 45s");
      expect(result.completionUnixSeconds).toBe(
        Math.floor(new Date("2026-07-01T12:01:15.000Z").getTime() / 1000),
      );
      expect(result.completionAt.toISOString()).toBe("2026-07-01T12:01:15.000Z");
    }
  });
});
