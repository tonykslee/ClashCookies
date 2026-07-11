import { describe, expect, it } from "vitest";
import {
  classifyFwaPoliceViolation,
  FWA_POLICE_VIOLATIONS,
  renderFwaPoliceTemplate,
} from "../src/services/FwaPoliceTemplateCatalog";

function buildCanonicalIssue(input: {
  reasonLabel: string;
  attackDetails: any[];
  breachContext?: { starsAtBreach: number; timeRemaining: string } | null;
}) {
  return {
    playerTag: "#P2YLC8R0",
    playerName: "Player One",
    playerPosition: 5,
    ruleType: "not_following_plan",
    expectedBehavior: "Mirror triple in strict window.",
    actualBehavior: "#5 (2-star) : canonical police label",
    reasonLabel: input.reasonLabel,
    attackDetails: input.attackDetails,
    breachContext: input.breachContext ?? null,
  } as any;
}

describe("FwaPoliceTemplateCatalog", () => {
  it("defines exactly nine canonical violation enums", () => {
    expect(FWA_POLICE_VIOLATIONS).toEqual([
      "EARLY_NON_MIRROR_TRIPLE",
      "STRICT_WINDOW_MIRROR_MISS_WIN",
      "STRICT_WINDOW_MIRROR_MISS_LOSS",
      "EARLY_NON_MIRROR_2STAR",
      "TRADITIONAL_INVALID_STAR_COUNT",
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

  it("maps canonical reason labels to their exact police violations", () => {
    const cases = [
      {
        reasonLabel: "tripled non-mirror in strict window",
        expected: "EARLY_NON_MIRROR_TRIPLE",
        context: {
          matchType: "FWA",
          expectedOutcome: "WIN",
          loseStyle: "TRIPLE_TOP_30",
        },
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 3,
            attackOrder: 2,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 11,
          timeRemaining: "7h 0m left",
        },
      },
      {
        reasonLabel: "didn't triple mirror",
        expected: "STRICT_WINDOW_MIRROR_MISS_WIN",
        context: {
          matchType: "FWA",
          expectedOutcome: "WIN",
          loseStyle: "TRIPLE_TOP_30",
        },
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
      {
        reasonLabel: "strict-window mirror miss in traditional loss",
        expected: "STRICT_WINDOW_MIRROR_MISS_LOSS",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
        attackDetails: [
          {
            defenderPosition: 5,
            stars: 2,
            attackOrder: 4,
            isBreach: false,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "early non-mirror 2-star in traditional loss",
        expected: "EARLY_NON_MIRROR_2STAR",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 2,
            attackOrder: 5,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "invalid star count in traditional loss",
        expected: "TRADITIONAL_INVALID_STAR_COUNT",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 1,
            attackOrder: 6,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "any 3-star in traditional loss",
        expected: "ANY_3STAR",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
        attackDetails: [
          {
            defenderPosition: 1,
            stars: 3,
            attackOrder: 7,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "attack on a lower-20 base",
        expected: "LOWER20_ANY_STARS",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
        },
        attackDetails: [
          {
            defenderPosition: 41,
            stars: 2,
            attackOrder: 8,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "0-star attack on a top-30 base",
        expected: "TOP30_ZERO_STARS",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
        },
        attackDetails: [
          {
            defenderPosition: 22,
            stars: 0,
            attackOrder: 9,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
      {
        reasonLabel: "clan star cap exceeded",
        expected: "CLAN_STAR_CAP_EXCEEDED",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
        attackDetails: [
          {
            defenderPosition: 9,
            stars: 1,
            attackOrder: 10,
            isBreach: true,
          },
        ],
        breachContext: null,
      },
    ] as const;

    for (const testCase of cases) {
      const violation = classifyFwaPoliceViolation({
        issue: buildCanonicalIssue({
          reasonLabel: testCase.reasonLabel,
          attackDetails: testCase.attackDetails as any,
          breachContext: testCase.breachContext ?? null,
        }),
        context: testCase.context,
      });
      expect(violation).toBe(testCase.expected);
    }
  });

  it("rejects exact didn't triple mirror without strict-window breach context in FWA-WIN", () => {
    const violation = classifyFwaPoliceViolation({
      issue: buildCanonicalIssue({
        reasonLabel: "didn't triple mirror",
        attackDetails: [
          {
            defenderPosition: 1,
            stars: 2,
            attackOrder: 3,
            isBreach: true,
          },
        ],
        breachContext: null,
      }),
      context: {
        matchType: "FWA",
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
      },
    });

    expect(violation).toBeNull();
  });

  it("keeps the exact traditional exhausted-obligation label applicable without breach context", () => {
    const violation = classifyFwaPoliceViolation({
      issue: buildCanonicalIssue({
        reasonLabel: "strict-window mirror miss in traditional loss",
        attackDetails: [
          {
            defenderPosition: 5,
            stars: 2,
            attackOrder: 4,
            isBreach: false,
          },
        ],
        breachContext: null,
      }),
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });

    expect(violation).toBe("STRICT_WINDOW_MIRROR_MISS_LOSS");
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

  it("classifies invalid star count from the traditional-loss reason label", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Use the correct star count in traditional loss.",
        actualBehavior: "#14 (1-star) : invalid star count in traditional loss",
        reasonLabel: "invalid star count in traditional loss",
        attackDetails: [
          {
            defenderPosition: 14,
            stars: 1,
            attackOrder: 2,
            isBreach: true,
          },
        ],
        breachContext: {
          starsAtBreach: 9,
          timeRemaining: "8h 0m left",
        },
      },
      context: {
        matchType: "FWA",
        expectedOutcome: "LOSE",
        loseStyle: "TRADITIONAL",
      },
    });

    expect(violation).toBe("TRADITIONAL_INVALID_STAR_COUNT");
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

  it("applies applicability checks to legacy mirror-miss text before classifying", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Mirror 2-star in traditional loss strict window.",
        actualBehavior: "#5 (2-star) : late mirror",
        reasonLabel: "late mirror 2-star",
        attackDetails: [
          {
            defenderPosition: 5,
            stars: 2,
            attackOrder: 4,
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

  it("rejects mismatched canonical labels across unsupported plans", () => {
    const cases = [
      {
        reasonLabel: "any 3-star in traditional loss",
        context: {
          matchType: "FWA",
          expectedOutcome: "WIN",
          loseStyle: "TRIPLE_TOP_30",
        },
      },
      {
        reasonLabel: "early non-mirror 2-star in traditional loss",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
        },
      },
      {
        reasonLabel: "attack on a lower-20 base",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
      },
      {
        reasonLabel: "didn't triple mirror",
        context: {
          matchType: "FWA",
          expectedOutcome: "LOSE",
          loseStyle: "TRADITIONAL",
        },
      },
      {
        reasonLabel: "strict-window mirror miss in traditional loss",
        context: {
          matchType: "FWA",
          expectedOutcome: "WIN",
          loseStyle: "TRIPLE_TOP_30",
        },
      },
      {
        reasonLabel: "clan star cap exceeded",
        context: {
          matchType: "FWA",
          expectedOutcome: "WIN",
          loseStyle: "TRIPLE_TOP_30",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const violation = classifyFwaPoliceViolation({
        issue: buildCanonicalIssue({
          reasonLabel: testCase.reasonLabel,
          attackDetails: [
            {
              defenderPosition: 5,
              stars: 2,
              attackOrder: 4,
              isBreach: true,
            },
          ],
          breachContext: null,
        }),
        context: testCase.context,
      });
      expect(violation).toBeNull();
    }
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
