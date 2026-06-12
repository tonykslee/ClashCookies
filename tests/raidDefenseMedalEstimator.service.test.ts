import { describe, expect, it } from "vitest";
import { predictRaidDefenseMedalsFromDefenseLog } from "../src/services/RaidDefenseMedalEstimator";

describe("RaidDefenseMedalEstimator", () => {
  it("shares district weights across opponents by district id and uses ClashCliffs housing space", () => {
    const defenseLog = [
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 10,
            destructionPercent: 100,
            totalLooted: 1000,
          },
        ],
      },
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 12,
            destructionPercent: 100,
            totalLooted: 1600,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(56);
  });

  it("caps the predicted defense reward at 350", () => {
    const defenseLog = [
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 75,
            destructionPercent: 100,
            totalLooted: 1800,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(350);
  });

  it("returns zero for missing or empty defense logs", () => {
    expect(predictRaidDefenseMedalsFromDefenseLog(null as any)).toBe(0);
    expect(predictRaidDefenseMedalsFromDefenseLog([] as any)).toBe(0);
  });
});
