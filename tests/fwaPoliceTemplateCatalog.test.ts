import { describe, expect, it } from "vitest";
import {
  classifyFwaPoliceViolation,
  FWA_POLICE_VIOLATIONS,
  renderFwaPoliceTemplate,
  validateFwaPoliceTemplatePlaceholders,
} from "../src/services/FwaPoliceTemplateCatalog";

describe("FwaPoliceTemplateCatalog", () => {
  it("defines exactly six canonical violation enums", () => {
    expect(FWA_POLICE_VIOLATIONS).toEqual([
      "EARLY_NON_MIRROR_TRIPLE",
      "STRICT_WINDOW_MIRROR_MISS_WIN",
      "STRICT_WINDOW_MIRROR_MISS_LOSS",
      "EARLY_NON_MIRROR_2STAR",
      "ANY_3STAR",
      "LOWER20_ANY_STARS",
    ]);
  });

  it("rejects unknown placeholders while allowing offender/user", () => {
    const valid = validateFwaPoliceTemplatePlaceholders(
      "{offender} -> {user}",
    );
    const invalid = validateFwaPoliceTemplatePlaceholders(
      "{offender} {bad_token}",
    );

    expect(valid).toEqual({ ok: true });
    expect(invalid).toEqual({
      ok: false,
      unknownPlaceholders: ["bad_token"],
    });
  });

  it("renders offender/user placeholders deterministically", () => {
    const rendered = renderFwaPoliceTemplate({
      template: "Alert {offender} / {user}",
      offender: "#15 - Tilonius",
      user: "UNLINKED_USER",
    });
    expect(rendered).toBe("Alert #15 - Tilonius / UNLINKED_USER");
  });

  it("classifies early non-mirror 2-star from breach details", () => {
    const violation = classifyFwaPoliceViolation({
      issue: {
        playerTag: "#P2YLC8R0",
        playerName: "Player One",
        playerPosition: 1,
        ruleType: "not_following_plan",
        expectedBehavior: "Mirror triple in strict window.",
        actualBehavior: "#14 (2-star) : missed mirror",
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
        expectedOutcome: "WIN",
        loseStyle: "TRIPLE_TOP_30",
      },
    });
    expect(violation).toBe("EARLY_NON_MIRROR_2STAR");
  });
});
