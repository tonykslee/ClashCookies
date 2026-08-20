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

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(63);
  });

  it("keeps shared district bounds independent by district id", () => {
    const defenseLog = [
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 2,
            destructionPercent: 100,
            totalLooted: 1000,
          },
          {
            id: 70000002,
            districtHallLevel: 4,
            attackCount: 1,
            destructionPercent: 100,
            totalLooted: 500,
          },
        ],
      },
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 3,
            destructionPercent: 100,
            totalLooted: 1600,
          },
          {
            id: 70000002,
            districtHallLevel: 4,
            attackCount: 4,
            destructionPercent: 100,
            totalLooted: 800,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(38);
  });

  it("uses the single best defense result rather than summing opponents", () => {
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
            attackCount: 20,
            destructionPercent: 100,
            totalLooted: 1000,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(115);
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

  it("returns unknown for missing or empty defense logs", () => {
    expect(predictRaidDefenseMedalsFromDefenseLog(null as any)).toBeNull();
    expect(predictRaidDefenseMedalsFromDefenseLog([] as any)).toBeNull();
  });

  it("returns unknown for nonempty defense logs without usable attack data", () => {
    const defenseLog = [
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            destructionPercent: 100,
            totalLooted: 1000,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBeNull();
  });

  it("ignores a partially malformed opponent when selecting the best defense", () => {
    const defenseLog = [
      {
        districts: [
          {
            id: 70000001,
            districtHallLevel: 5,
            attackCount: 2,
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
            attackCount: 100,
            destructionPercent: 100,
          },
        ],
      },
    ];

    expect(predictRaidDefenseMedalsFromDefenseLog(defenseLog as any)).toBe(7);
  });
});
