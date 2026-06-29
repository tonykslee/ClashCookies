import { describe, expect, it } from "vitest";
import {
  HOME_VILLAGE_LEAGUE_FAMILY_LABELS,
  HOME_VILLAGE_LEAGUE_LEGACY_RECORDS,
  HOME_VILLAGE_LEAGUE_TIER_RECORDS,
  matchesHomeVillageLeagueTarget,
  resolveHomeVillageLeagueObservation,
} from "../src/services/HomeVillageLeagueTaxonomy";

describe("HomeVillageLeagueTaxonomy", () => {
  it("resolves leagueTier before legacy league and records the source", () => {
    expect(
      resolveHomeVillageLeagueObservation({
        leagueTier: { id: 105000034, name: "Legend III" },
        league: { name: "Legend League" },
      }),
    ).toMatchObject({
      source: "leagueTier",
      leagueTierId: 105000034,
      leagueName: "Legend III",
      family: "Legend",
    });

    expect(
      resolveHomeVillageLeagueObservation({
        leagueTier: null,
        league: { name: "Legend League" },
      }),
    ).toMatchObject({
      source: "league",
      leagueTierId: null,
      leagueName: "Legend League",
      family: "Legend",
    });

    expect(resolveHomeVillageLeagueObservation({})).toMatchObject({
      source: "missing",
      leagueName: null,
    });
  });

  it("exposes the full current and legacy record lists", () => {
    expect(
      HOME_VILLAGE_LEAGUE_TIER_RECORDS.map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: 105000000, name: "Unranked" },
      { id: 105000001, name: "Skeleton League 1" },
      { id: 105000002, name: "Skeleton League 2" },
      { id: 105000003, name: "Skeleton League 3" },
      { id: 105000004, name: "Barbarian League 4" },
      { id: 105000005, name: "Barbarian League 5" },
      { id: 105000006, name: "Barbarian League 6" },
      { id: 105000007, name: "Archer League 7" },
      { id: 105000008, name: "Archer League 8" },
      { id: 105000009, name: "Archer League 9" },
      { id: 105000010, name: "Wizard League 10" },
      { id: 105000011, name: "Wizard League 11" },
      { id: 105000012, name: "Wizard League 12" },
      { id: 105000013, name: "Valkyrie League 13" },
      { id: 105000014, name: "Valkyrie League 14" },
      { id: 105000015, name: "Valkyrie League 15" },
      { id: 105000016, name: "Witch League 16" },
      { id: 105000017, name: "Witch League 17" },
      { id: 105000018, name: "Witch League 18" },
      { id: 105000019, name: "Golem League 19" },
      { id: 105000020, name: "Golem League 20" },
      { id: 105000021, name: "Golem League 21" },
      { id: 105000022, name: "P.E.K.K.A League 22" },
      { id: 105000023, name: "P.E.K.K.A League 23" },
      { id: 105000024, name: "P.E.K.K.A League 24" },
      { id: 105000025, name: "Titan League 25" },
      { id: 105000026, name: "Titan League 26" },
      { id: 105000027, name: "Titan League 27" },
      { id: 105000028, name: "Dragon League 28" },
      { id: 105000029, name: "Dragon League 29" },
      { id: 105000030, name: "Dragon League 30" },
      { id: 105000031, name: "Electro League 31" },
      { id: 105000032, name: "Electro League 32" },
      { id: 105000033, name: "Electro League 33" },
      { id: 105000034, name: "Legend III" },
      { id: 105000035, name: "Legend II" },
      { id: 105000036, name: "Legend I" },
    ]);

    expect(
      HOME_VILLAGE_LEAGUE_LEGACY_RECORDS.map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: 29000000, name: "Unranked" },
      { id: 29000001, name: "Bronze League III" },
      { id: 29000002, name: "Bronze League II" },
      { id: 29000003, name: "Bronze League I" },
      { id: 29000004, name: "Silver League III" },
      { id: 29000005, name: "Silver League II" },
      { id: 29000006, name: "Silver League I" },
      { id: 29000007, name: "Gold League III" },
      { id: 29000008, name: "Gold League II" },
      { id: 29000009, name: "Gold League I" },
      { id: 29000010, name: "Crystal League III" },
      { id: 29000011, name: "Crystal League II" },
      { id: 29000012, name: "Crystal League I" },
      { id: 29000013, name: "Master League III" },
      { id: 29000014, name: "Master League II" },
      { id: 29000015, name: "Master League I" },
      { id: 29000016, name: "Champion League III" },
      { id: 29000017, name: "Champion League II" },
      { id: 29000018, name: "Champion League I" },
      { id: 29000019, name: "Titan League III" },
      { id: 29000020, name: "Titan League II" },
      { id: 29000021, name: "Titan League I" },
      { id: 29000022, name: "Legend League" },
    ]);
  });

  it("matches each current family selector only against its official current tier records", () => {
    const familyCases: Array<{
      target: string;
      positives: string[];
      negatives: string[];
    }> = [
      {
        target: "Skeleton League",
        positives: ["Skeleton League 1", "Skeleton League 2", "Skeleton League 3"],
        negatives: ["Skeleton League", "Skeleton League 4", "Barbarian League 4"],
      },
      {
        target: "Barbarian League",
        positives: ["Barbarian League 4", "Barbarian League 5", "Barbarian League 6"],
        negatives: ["Barbarian League", "Archer League 7"],
      },
      {
        target: "Archer League",
        positives: ["Archer League 7", "Archer League 8", "Archer League 9"],
        negatives: ["Archer League", "Wizard League 10"],
      },
      {
        target: "Wizard League",
        positives: ["Wizard League 10", "Wizard League 11", "Wizard League 12"],
        negatives: ["Wizard League", "Valkyrie League 13"],
      },
      {
        target: "Valkyrie League",
        positives: ["Valkyrie League 13", "Valkyrie League 14", "Valkyrie League 15"],
        negatives: ["Valkyrie League", "Witch League 16"],
      },
      {
        target: "Witch League",
        positives: ["Witch League 16", "Witch League 17", "Witch League 18"],
        negatives: ["Witch League", "Golem League 19"],
      },
      {
        target: "Golem League",
        positives: ["Golem League 19", "Golem League 20", "Golem League 21"],
        negatives: ["Golem League", "P.E.K.K.A League 22"],
      },
      {
        target: "P.E.K.K.A League",
        positives: ["P.E.K.K.A League 22", "P.E.K.K.A League 23", "P.E.K.K.A League 24"],
        negatives: ["P.E.K.K.A League", "Titan League 25"],
      },
      {
        target: "Titan League",
        positives: ["Titan League 25", "Titan League 26", "Titan League 27"],
        negatives: ["Titan League", "Dragon League 28"],
      },
      {
        target: "Dragon League",
        positives: ["Dragon League 28", "Dragon League 29", "Dragon League 30"],
        negatives: ["Dragon League", "Electro League 31"],
      },
      {
        target: "Electro League",
        positives: ["Electro League 31", "Electro League 32", "Electro League 33"],
        negatives: ["Electro League", "Legend III"],
      },
      {
        target: "Legend",
        positives: ["Legend III", "Legend II", "Legend I"],
        negatives: ["Legend", "Legend League", "Titan League 25"],
      },
    ];

    for (const family of familyCases) {
      expect(matchesHomeVillageLeagueTarget(family.target, family.target)).toBe(false);
      for (const positive of family.positives) {
        expect(matchesHomeVillageLeagueTarget(family.target, positive)).toBe(true);
      }
      for (const negative of family.negatives) {
        expect(matchesHomeVillageLeagueTarget(family.target, negative)).toBe(false);
      }
    }
  });

  it("keeps the Legend League compatibility alias narrow and backward-compatible", () => {
    expect(matchesHomeVillageLeagueTarget("Legend League", "Legend III")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("legend league", "  LEGEND   ii  ")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("Legend League", "Legend League")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("Legend League", "Titan League 25")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Legend", "Legend")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Titan League", "Titan League")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Legend League", "Legend II")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("Legend League", "Legend I")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("Legend League", "legend league")).toBe(true);
  });

  it("preserves exact matching for current and legacy non-family targets", () => {
    for (const { name } of HOME_VILLAGE_LEAGUE_TIER_RECORDS) {
      expect(matchesHomeVillageLeagueTarget(name, name)).toBe(true);
    }

    for (const { name } of HOME_VILLAGE_LEAGUE_LEGACY_RECORDS) {
      expect(matchesHomeVillageLeagueTarget(name, name)).toBe(true);
    }

    expect(matchesHomeVillageLeagueTarget("Legend III", "Legend II")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Titan League 25", "Titan League 26")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Titan League I", "Titan League")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Bronze League III", "Bronze League II")).toBe(false);
  });

  it("exposes the family selector labels in canonical order", () => {
    expect(HOME_VILLAGE_LEAGUE_FAMILY_LABELS).toEqual([
      "Skeleton League",
      "Barbarian League",
      "Archer League",
      "Wizard League",
      "Valkyrie League",
      "Witch League",
      "Golem League",
      "P.E.K.K.A League",
      "Titan League",
      "Dragon League",
      "Electro League",
      "Legend",
    ]);
  });
});
