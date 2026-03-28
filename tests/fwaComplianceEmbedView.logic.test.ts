import { describe, expect, it } from "vitest";
import { type APIActionRowComponent, type APIButtonComponent } from "discord.js";
import {
  buildFwaComplianceEmbedView,
  toEmbedJson,
} from "../src/commands/fwa/complianceEmbedView";
import {
  type WarComplianceIssue,
  type WarComplianceIssueAttackDetail,
} from "../src/services/WarComplianceService";

function makeViolation(
  position: number,
  name: string,
  options?: {
    actualBehavior?: string;
    attackDetails?: WarComplianceIssueAttackDetail[];
    breachContext?: { starsAtBreach: number; timeRemaining: string } | null;
    reasonLabel?: string;
  }
): WarComplianceIssue {
  return {
    playerTag: `#P${position}`,
    playerName: name,
    playerPosition: position,
    ruleType: "not_following_plan",
    expectedBehavior: "Mirror triple in strict window; avoid off-mirror triples/zeros.",
    actualBehavior: options?.actualBehavior ?? "#5 (★ ★ ★), #14 (★ ★ ★) : tripled non-mirror in strict window | 56★ | 22h 1m left",
    attackDetails: options?.attackDetails,
    breachContext: options?.breachContext ?? { starsAtBreach: 56, timeRemaining: "22h 1m left" },
    reasonLabel: options?.reasonLabel ?? "tripled non-mirror in strict window",
  };
}

function makeMissed(position: number, name: string): WarComplianceIssue {
  return {
    playerTag: `#M${position}`,
    playerName: name,
    playerPosition: position,
    ruleType: "missed_both",
    expectedBehavior: "Use both attacks for the war.",
    actualBehavior: "",
  };
}

function flattenButtons(components: ReturnType<typeof buildFwaComplianceEmbedView>["components"]) {
  const rows = components.map((row) => row.toJSON() as APIActionRowComponent<APIButtonComponent>);
  return rows.flatMap((row) => row.components);
}

describe("buildFwaComplianceEmbedView", () => {
  it("renders summary without participants or divider and formats violations as per-attack lines", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "Mirror first\nHit mirror\nThen clean up",
      warId: 777,
      expectedOutcome: "WIN",
      fwaWinGateConfig: {
        nonMirrorTripleMinClanStars: 101,
        allBasesOpenHoursLeft: 8,
      },
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      warEndTime: new Date("2026-03-13T00:00:00.000Z"),
      participantsCount: 50,
      attacksCount: 53,
      missedBoth: [makeMissed(10, "Missed One")],
      notFollowingPlan: [
        makeViolation(5, "lotus", {
          attackDetails: [
            { defenderPosition: 5, stars: 3, attackOrder: 1, isBreach: false },
            { defenderPosition: 14, stars: 3, attackOrder: 2, isBreach: true },
          ],
          breachContext: { starsAtBreach: 56, timeRemaining: "22h 1m left" },
        }),
      ],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    const embed = toEmbedJson(rendered.embed);
    const summary = embed.fields?.[0]?.value ?? "";
    const warPlan = embed.fields?.[1]?.value ?? "";
    const plan = embed.fields?.[2]?.value ?? "";
    expect(embed.description).toContain("Rules: N=101, H=8h");

    expect(embed.title).toBe("FWA War Compliance — Rocky Road");
    expect(embed.description).toContain("War #777 • Expected: WIN");
    expect(summary).toContain("⚔️ Attacks Logged: 53");
    expect(summary).toContain("❌ Missed Both Attacks: 1");
    expect(summary).toContain("⚠️ Didn't Follow Plan: 1");
    expect(summary).not.toContain("Participants:");
    expect(summary).not.toContain("---");
    expect(embed.fields?.[1]?.name).toBe("Warplan");
    expect(warPlan).toBe("Mirror first\nHit mirror\nThen clean up");

    expect(plan).toContain("#5 lotus");
    expect(plan).toContain("→ #5 ★ ★ ★");
    expect(plan).toContain("→ #14 ★ ★ ★ ⚠️");
    expect(plan).toContain("56★ | 22h 1m left");
    expect(plan).not.toContain("tripled non-mirror in strict window");
    expect(plan).not.toContain("| #14");

    const buttons = flattenButtons(rendered.components);
    const missedToggle = buttons.find((button) => button.label === "Missed Attacks");
    expect(missedToggle?.disabled).toBe(false);
  });

  it("marks both attack lines when both attacks are breaches", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "No warplan details",
      warId: 777,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 53,
      missedBoth: [],
      notFollowingPlan: [
        makeViolation(1, "Kirito", {
          attackDetails: [
            { defenderPosition: 1, stars: 3, attackOrder: 1, isBreach: true },
            { defenderPosition: 2, stars: 3, attackOrder: 2, isBreach: true },
          ],
          breachContext: { starsAtBreach: 49, timeRemaining: "21h 27m left" },
        }),
      ],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    const plan = toEmbedJson(rendered.embed).fields?.[2]?.value ?? "";
    expect(plan).toContain("→ #1 ★ ★ ★ ⚠️");
    expect(plan).toContain("→ #2 ★ ★ ★ ⚠️");
    expect(plan).toContain("49★ | 21h 27m left");
  });

  it("does not render a no-targets placeholder when violation details are empty", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "No warplan details",
      warId: 777,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 53,
      missedBoth: [],
      notFollowingPlan: [
        makeViolation(3, "NoDetail", {
          actualBehavior: "",
          attackDetails: [],
          breachContext: null,
        }),
      ],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    const plan = toEmbedJson(rendered.embed).fields?.[2]?.value ?? "";
    expect(plan).toContain("#3 NoDetail");
    expect(plan).not.toContain("No targets logged");
  });

  it("disables missed-attacks toggle when there are no missed-both players", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "No warplan details",
      warId: 777,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 53,
      missedBoth: [],
      notFollowingPlan: [],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    const buttons = flattenButtons(rendered.components);
    const missedToggle = buttons.find((button) => button.label === "Missed Attacks");
    expect(missedToggle?.disabled).toBe(true);
  });

  it("renders non-FWA missed view with disabled FWA compliance button and compact player spacing", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: false,
      clanName: "Rocky Road",
      warPlanText: null,
      warId: 888,
      expectedOutcome: null,
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 20,
      missedBoth: [
        makeMissed(2, "Lucky Luke"),
        makeMissed(5, "DiamondPro68"),
        makeMissed(7, "Darkdestyne"),
      ],
      notFollowingPlan: [],
      activeView: "missed",
      mainPage: 0,
      missedPage: 0,
    });

    const embed = toEmbedJson(rendered.embed);
    expect(embed.title).toBe("Missed Attacks — Rocky Road");
    expect(embed.fields?.[0]?.name).toBe("Players");
    const players = embed.fields?.[0]?.value ?? "";
    expect(players).toContain("Lucky Luke (#M2)");
    expect(players).toContain("DiamondPro68 (#M5)");
    expect(players).toContain("Darkdestyne (#M7)");
    expect(players).not.toContain("\n\n");

    const buttons = flattenButtons(rendered.components);
    const fwaButton = buttons.find((button) => button.label === "FWA Compliance");
    expect(fwaButton?.disabled).toBe(true);
  });

  it("keeps pagination deterministic for violations and missed-attacks lists", () => {
    const notFollowing = Array.from({ length: 24 }, (_, idx) =>
      makeViolation(idx + 1, `P${idx + 1}`, {
        actualBehavior: `#${idx + 1} (★ ★ ★), #${idx + 2} (★ ★ ☆) : didn't triple mirror | ${45 + idx}★ | 21h 10m left`,
        attackDetails: [
          { defenderPosition: idx + 1, stars: 3, attackOrder: 1, isBreach: true },
          { defenderPosition: idx + 2, stars: 2, attackOrder: 2, isBreach: true },
        ],
        breachContext: { starsAtBreach: 45 + idx, timeRemaining: "21h 10m left" },
      })
    );
    const missed = Array.from({ length: 140 }, (_, idx) => makeMissed(idx + 1, `M${idx + 1}`));

    const firstMain = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "No warplan details",
      warId: 999,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 54,
      missedBoth: missed,
      notFollowingPlan: notFollowing,
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });
    const secondMain = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warId: 999,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 54,
      missedBoth: missed,
      notFollowingPlan: notFollowing,
      activeView: "fwa_main",
      mainPage: 1,
      missedPage: 0,
    });
    const firstMainEmbed = toEmbedJson(firstMain.embed);
    const secondMainEmbed = toEmbedJson(secondMain.embed);
    expect(firstMain.mainPageCount).toBeGreaterThan(1);
    expect(firstMainEmbed.footer?.text).toMatch(/^Page 1\/\d+$/);
    expect(secondMainEmbed.footer?.text).toMatch(/^Page 2\/\d+$/);
    expect(firstMainEmbed.fields?.[2]?.value).toContain("#1 P1");
    expect(secondMainEmbed.fields?.[2]?.value).not.toContain("#1 P1");

    const secondMissed = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "No warplan details",
      warId: 999,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 54,
      missedBoth: missed,
      notFollowingPlan: notFollowing,
      activeView: "missed",
      mainPage: 0,
      missedPage: 1,
    });
    const secondMissedEmbed = toEmbedJson(secondMissed.embed);
    expect(secondMissed.missedPageCount).toBeGreaterThan(1);
    expect(secondMissedEmbed.footer?.text).toMatch(/^Page 2\/\d+$/);
  });

  it("renders fallback warplan text when no details remain", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warPlanText: "",
      warId: 1001,
      expectedOutcome: "WIN",
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 0,
      missedBoth: [],
      notFollowingPlan: [],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    expect(toEmbedJson(rendered.embed).fields?.[1]?.value).toBe("No warplan details");
  });
});
