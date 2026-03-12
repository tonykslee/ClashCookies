import { describe, expect, it } from "vitest";
import { buildWarComplianceReportLines } from "../src/commands/fwa/complianceView";
import { type WarComplianceReport } from "../src/services/WarComplianceService";

function makeBaseReport(): WarComplianceReport {
  return {
    clanTag: "#ABC123",
    warId: 12345,
    warStartTime: new Date("2026-01-02T00:00:00.000Z"),
    warEndTime: new Date("2026-01-03T00:00:00.000Z"),
    matchType: "FWA",
    expectedOutcome: "WIN",
    loseStyle: "TRIPLE_TOP_30",
    missedBoth: [],
    notFollowingPlan: [],
    participantsCount: 50,
    attacksCount: 100,
  };
}

describe("buildWarComplianceReportLines", () => {
  it("renders a compliant summary when there are no violations", () => {
    const lines = buildWarComplianceReportLines({
      clanName: "Alpha",
      clanTag: "ABC123",
      report: makeBaseReport(),
    });

    const text = lines.join("\n");
    expect(text).toContain("War compliance for **Alpha** (#ABC123)");
    expect(text).toContain("Missed both attacks: **0**");
    expect(text).toContain("Didn't follow plan: **0**");
    expect(text).toContain("Everyone followed the configured war plan.");
  });

  it("renders missed-both and plan-violation sections with expected/actual details", () => {
    const report: WarComplianceReport = {
      ...makeBaseReport(),
      missedBoth: [
        {
          playerTag: "#P1",
          playerName: "Player One",
          playerPosition: 1,
          ruleType: "missed_both",
          expectedBehavior: "Use both attacks for the war.",
          actualBehavior: "",
        },
      ],
      notFollowingPlan: [
        {
          playerTag: "#P2",
          playerName: "Player Two",
          playerPosition: 2,
          ruleType: "not_following_plan",
          expectedBehavior: "Mirror triple in strict window; avoid off-mirror triples/zeros.",
          actualBehavior:
            "#1 (★ ★ ☆), #4 (★ ★ ★) : tripled non-mirror in strict window | 56★ | 22h 1m left",
        },
      ],
    };

    const text = buildWarComplianceReportLines({
      clanName: "Alpha",
      clanTag: "ABC123",
      report,
    }).join("\n");

    expect(text).toContain("Missed both attacks:");
    expect(text).toContain("- Player One (#P1)");
    expect(text).not.toContain("Attacks used: 0.");
    expect(text).toContain("Didn't follow war plan:");
    expect(text).toContain("Expected: Mirror triple in strict window; avoid off-mirror triples/zeros.");
    expect(text).toContain(
      "#2. Player Two --> #1 (★ ★ ☆), #4 (★ ★ ★) : tripled non-mirror in strict window"
    );
    expect(text).not.toContain("Attacks used: 2.");
  });
});

