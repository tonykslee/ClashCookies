import { describe, expect, it } from "vitest";
import { type APIActionRowComponent, type APIButtonComponent } from "discord.js";
import {
  buildFwaComplianceEmbedView,
  toEmbedJson,
} from "../src/commands/fwa/complianceEmbedView";
import { type WarComplianceIssue } from "../src/services/WarComplianceService";

function makeViolation(position: number, name: string, actualBehavior: string): WarComplianceIssue {
  return {
    playerTag: `#P${position}`,
    playerName: name,
    playerPosition: position,
    ruleType: "not_following_plan",
    expectedBehavior: "Mirror triple in strict window; avoid off-mirror triples/zeros.",
    actualBehavior,
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
  it("renders main FWA compliance embed with summary and violations", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
      warId: 777,
      expectedOutcome: "WIN",
      warStartTime: new Date("2026-03-12T00:00:00.000Z"),
      warEndTime: new Date("2026-03-13T00:00:00.000Z"),
      participantsCount: 50,
      attacksCount: 53,
      missedBoth: [makeMissed(10, "Missed One")],
      notFollowingPlan: [
        makeViolation(
          5,
          "lotus",
          "#5 (★ ★ ★), #14 (★ ★ ★) : tripled non-mirror in strict window | 56★ | 22h 1m left"
        ),
      ],
      activeView: "fwa_main",
      mainPage: 0,
      missedPage: 0,
    });

    const embed = toEmbedJson(rendered.embed);
    expect(embed.title).toBe("FWA War Compliance — Rocky Road");
    expect(embed.description).toContain("War #777 • Expected: WIN");
    expect(embed.fields?.[0]?.name).toBe("Summary");
    expect(embed.fields?.[1]?.name).toBe("Plan Violations");
    expect(embed.fields?.[1]?.value).toContain("#5 lotus");
    expect(embed.fields?.[1]?.value).toContain("→ #5 ★ ★ ★ | #14 ★ ★ ★");
    expect(embed.fields?.[1]?.value).toContain("tripled non-mirror in strict window");
    expect(embed.fields?.[1]?.value).toContain("56★ | 22h 1m left");

    const buttons = flattenButtons(rendered.components);
    const missedToggle = buttons.find((button) => button.label === "Missed Attacks");
    expect(missedToggle).toBeTruthy();
    expect(missedToggle?.disabled).toBe(false);
  });

  it("disables missed-attacks toggle when there are no missed-both players", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: true,
      clanName: "Rocky Road",
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
    expect(missedToggle).toBeTruthy();
    expect(missedToggle?.disabled).toBe(true);
  });

  it("renders non-FWA missed view with disabled FWA compliance button and empty state", () => {
    const rendered = buildFwaComplianceEmbedView({
      userId: "123",
      key: "payload",
      isFwa: false,
      clanName: "Rocky Road",
      warId: 888,
      expectedOutcome: null,
      warStartTime: null,
      warEndTime: null,
      participantsCount: 50,
      attacksCount: 20,
      missedBoth: [],
      notFollowingPlan: [],
      activeView: "missed",
      mainPage: 0,
      missedPage: 0,
    });

    const embed = toEmbedJson(rendered.embed);
    expect(embed.title).toBe("Missed Attacks — Rocky Road");
    expect(embed.fields?.[0]?.name).toBe("Players");
    expect(embed.fields?.[0]?.value).toContain("No players missed both attacks.");

    const buttons = flattenButtons(rendered.components);
    const fwaButton = buttons.find((button) => button.label === "FWA Compliance");
    expect(fwaButton).toBeTruthy();
    expect(fwaButton?.disabled).toBe(true);
  });

  it("paginates violations and players with deterministic ordering", () => {
    const notFollowing = Array.from({ length: 28 }, (_, idx) =>
      makeViolation(
        idx + 1,
        `P${idx + 1}`,
        `#${idx + 1} (★ ★ ☆), #${idx + 2} (★ ★ ★) : didn't triple mirror in strict window with extended reason text ${"x".repeat(48)} | ${20 + idx}★ | 21h 0m left`
      )
    );
    const missed = Array.from({ length: 140 }, (_, idx) => makeMissed(idx + 1, `M${idx + 1}`));

    const mainPageOne = buildFwaComplianceEmbedView({
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
      mainPage: 0,
      missedPage: 0,
    });

    const mainPageTwo = buildFwaComplianceEmbedView({
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

    const mainOne = toEmbedJson(mainPageOne.embed);
    const mainTwo = toEmbedJson(mainPageTwo.embed);
    expect(mainPageOne.mainPageCount).toBeGreaterThan(1);
    expect(mainOne.footer?.text).toMatch(/^Page 1\/\d+$/);
    expect(mainTwo.footer?.text).toMatch(/^Page 2\/\d+$/);
    expect(mainOne.fields?.[1]?.value).toContain("#1 P1");
    expect(mainTwo.fields?.[1]?.value).not.toContain("#1 P1");

    const missedPageTwo = buildFwaComplianceEmbedView({
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
      activeView: "missed",
      mainPage: 0,
      missedPage: 1,
    });
    const missedTwo = toEmbedJson(missedPageTwo.embed);
    expect(missedPageTwo.missedPageCount).toBeGreaterThan(1);
    expect(missedTwo.footer?.text).toMatch(/^Page 2\/\d+$/);
  });
});
