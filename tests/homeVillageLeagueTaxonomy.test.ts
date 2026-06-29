import { describe, expect, it } from "vitest";
import {
  HOME_VILLAGE_LEAGUE_EXACT_TIER_NAMES,
  HOME_VILLAGE_LEAGUE_FAMILY_LABELS,
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
    });

    expect(resolveHomeVillageLeagueObservation({})).toMatchObject({
      source: "missing",
      leagueName: null,
    });
  });

  it("exact-matches every current league tier name", () => {
    expect(HOME_VILLAGE_LEAGUE_EXACT_TIER_NAMES).toHaveLength(37);
    for (const tierName of HOME_VILLAGE_LEAGUE_EXACT_TIER_NAMES) {
      expect(matchesHomeVillageLeagueTarget(tierName, tierName)).toBe(true);
    }
  });

  it("matches official family selectors and rejects nearby non-members", () => {
    const familyCases: Array<{
      target: string;
      positives: string[];
      negatives: string[];
    }> = [
      {
        target: "Skeleton League",
        positives: ["Skeleton League 1", "Skeleton League 2", "Skeleton League 3"],
        negatives: ["Skeleton League 4", "Barbarian League 4"],
      },
      {
        target: "Barbarian League",
        positives: ["Barbarian League 4", "Barbarian League 5", "Barbarian League 6"],
        negatives: ["Archer League 7", "Barbarian League 7"],
      },
      {
        target: "Archer League",
        positives: ["Archer League 7", "Archer League 8", "Archer League 9"],
        negatives: ["Wizard League 10", "Archer League 10"],
      },
      {
        target: "Wizard League",
        positives: ["Wizard League 10", "Wizard League 11", "Wizard League 12"],
        negatives: ["Valkyrie League 13", "Wizard League 13"],
      },
      {
        target: "Valkyrie League",
        positives: ["Valkyrie League 13", "Valkyrie League 14", "Valkyrie League 15"],
        negatives: ["Witch League 16", "Valkyrie League 16"],
      },
      {
        target: "Witch League",
        positives: ["Witch League 16", "Witch League 17", "Witch League 18"],
        negatives: ["Golem League 19", "Witch League 19"],
      },
      {
        target: "Golem League",
        positives: ["Golem League 19", "Golem League 20", "Golem League 21"],
        negatives: ["P.E.K.K.A League 22", "Golem League 22"],
      },
      {
        target: "P.E.K.K.A League",
        positives: ["P.E.K.K.A League 22", "P.E.K.K.A League 23", "P.E.K.K.A League 24"],
        negatives: ["Titan League 25", "P.E.K.K.A League 25"],
      },
      {
        target: "Titan League",
        positives: ["Titan League 25", "Titan League 26", "Titan League 27"],
        negatives: ["Dragon League 28", "Titan League 28"],
      },
      {
        target: "Dragon League",
        positives: ["Dragon League 28", "Dragon League 29", "Dragon League 30"],
        negatives: ["Electro League 31", "Dragon League 31"],
      },
      {
        target: "Electro League",
        positives: ["Electro League 31", "Electro League 32", "Electro League 33"],
        negatives: ["Legend III", "Electro League 34"],
      },
      {
        target: "Legend",
        positives: ["Legend III", "Legend II", "Legend I", "Legend League"],
        negatives: ["Titan League 25", "Legend IV"],
      },
    ];

    for (const family of familyCases) {
      for (const positive of family.positives) {
        expect(matchesHomeVillageLeagueTarget(family.target, positive)).toBe(true);
      }
      for (const negative of family.negatives) {
        expect(matchesHomeVillageLeagueTarget(family.target, negative)).toBe(false);
      }
    }

    expect(matchesHomeVillageLeagueTarget("Legend League", "Legend III")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("legend league", "  LEGEND   iii  ")).toBe(true);
    expect(matchesHomeVillageLeagueTarget("Legend III", "Legend II")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Titan League 25", "Titan League 26")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Legendish", "Legend III")).toBe(false);
    expect(matchesHomeVillageLeagueTarget("Titan League 2", "Titan League 25")).toBe(false);
    expect(HOME_VILLAGE_LEAGUE_FAMILY_LABELS).toHaveLength(12);
    expect(HOME_VILLAGE_LEAGUE_FAMILY_LABELS).toContain("Legend");
  });
});
