import { describe, expect, it } from "vitest";
import {
  classifyFwaPoliceViolation,
  FWA_POLICE_VIOLATIONS,
  renderFwaPoliceTemplate,
} from "../src/services/FwaPoliceTemplateCatalog";

describe("FwaPoliceTemplateCatalog", () => {
  it("defines exactly eight canonical violation enums", () => {
    expect(FWA_POLICE_VIOLATIONS).toEqual([
      "EARLY_NON_MIRROR_TRIPLE",
      "STRICT_WINDOW_MIRROR_MISS_WIN",
      "STRICT_WINDOW_MIRROR_MISS_LOSS",
      "EARLY_NON_MIRROR_2STAR",
      "ANY_3STAR",
      "LOWER20_ANY_STARS",
      "CLAN_STAR_CAP_EXCEEDED",
      "TOP30_ZERO_STARS",
    ]);
  });

  it("renders offender/user placeholders deterministically", () => {
    const rendered = renderFwaPoliceTemplate({
      template: "Alert {offender} / {user}",
      offender: "#15 - Tilonius",
      user: "UNLINKED_USER",
    });
    expect(rendered).toBe("Alert #15 - Tilonius / UNLINKED_USER");
  });

  it("classifies early non-mirror 2-star from traditional-loss breach details", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Avoid early non-mirror 2-star in traditional loss.",
        actualBehavior: "#14 (2-star) : early non-mirror 2-star",
        reasonLabel: null,
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 2,
            attackOrder: 1,
            isBreach: true,
          },
        ],
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });
    expect(violation).toBe("EARLY_NON_MIRROR_2STAR");
  });

  it("classifies top-30 zero-star and clan cap exceeded when no reason label is present", () => {
    const zeroStarViolation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Attack only top-30 bases.",
        actualBehavior: "#22 (0-star) : top-30 zero-star",
        reasonLabel: null,
        attackDetails: [
          {
            defenderPosition: 22,
            stars: 0,
            attackOrder: 1,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRIPLE_TOP_30",
      },
    });

    const capViolation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Stay within the clan star cap.",
        actualBehavior: "#9 (2-star) : pushed clan past the cap",
        reasonLabel: "clan star cap exceeded",
        attackDetails: [
          {
            defenderPosition: 9,
            stars: 1,
            attackOrder: 3,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });

    expect(zeroStarViolation).toBe("TOP30_ZERO_STARS");
    expect(capViolation).toBe("CLAN_STAR_CAP_EXCEEDED");
  });

  it("does not classify generic FWA-WIN non-strict-window issues as strict-window violations", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Mirror triple in strict window.",
        actualBehavior: "#14 (1-star) : generic miss",
        reasonLabel: "generic plan mismatch",
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 1,
            attackOrder: 8,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
      },
    });
    expect(violation).toBeNull();
  });

  it("classifies strict-window mirror miss in FWA-WIN only when strict-window context exists", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Mirror triple in strict window.",
        actualBehavior: "#1 (2-star) : missed mirror",
        reasonLabel: "didn't triple mirror in strict window",
        attackDetails: [
          {
            defenderPosition: 1,
            stars: 2,
            attackOrder: 3,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 10,
          timeRemaining: "6h 30m left",
        },
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
      },
    });
    expect(violation).toBe("STRICT_WINDOW_MIRROR_MISS_WIN");
  });

  it("keeps FWA-LOSS traditional any-3star as a valid police violation even without strict-window context", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "No triples in traditional loss flow.",
        actualBehavior: "#1 (3-star) : tripled mirror",
        reasonLabel: null,
        attackDetails: [
          {
            defenderPosition: 1,
            stars: 3,
            attackOrder: 15,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });
    expect(violation).toBe("ANY_3STAR");
  });

  it("does not classify generic FWA-LOSS traditional non-triple issues without strict-window context", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Mirror in strict window.",
        actualBehavior: "#1 (2-star) : late mirror",
        reasonLabel: "generic plan mismatch",
        attackDetails: [
          {
            defenderPosition: 1,
            stars: 2,
            attackOrder: 15,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });
    expect(violation).toBeNull();
  });
});
