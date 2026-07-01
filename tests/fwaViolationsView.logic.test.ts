import { type APIActionRowComponent, type APIButtonComponent } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  buildWarPlanViolationsAllianceOverviewEmbed,
  buildWarPlanViolationsClanLeaderboardEmbed,
  buildWarPlanViolationsDiscordUserAggregateEmbed,
  buildWarPlanViolationsPlayerHistoryEmbed,
  buildWarPlanViolationsPlayerHistoryPaginationRow,
  buildWarPlanViolationsPlayerSummaryLine,
  formatWarPlanViolationsPeriodLabel,
  formatWarPlanViolationsViolationTypeLabel,
  toEmbedJson,
} from "../src/commands/fwa/violationsView";
import {
  type WarPlanViolationHistoryAllianceOverview,
  type WarPlanViolationHistoryPlayerHistoryEntry,
  type WarPlanViolationHistoryPlayerHistoryResult,
  type WarPlanViolationHistoryPlayerSummary,
} from "../src/services/WarPlanViolationHistoryService";

function flattenButtons(
  components: Array<NonNullable<ReturnType<typeof buildWarPlanViolationsPlayerHistoryPaginationRow>>>,
) {
  const rows = components.map((row) => row.toJSON() as APIActionRowComponent<APIButtonComponent>);
  return rows.flatMap((row) => row.components);
}

function makePlayerSummary(
  index: number,
  overrides?: Partial<WarPlanViolationHistoryPlayerSummary>,
): WarPlanViolationHistoryPlayerSummary {
  return {
    playerTag: `#P${index}`,
    playerName: `Player ${index}`,
    townHallLevel: 18,
    discordUserId: `10${index}`,
    violationCount: index,
    affectedWarCount: index > 0 ? 1 : 0,
    ...overrides,
  };
}

function makeClanSummary(index: number, overrides?: Partial<WarPlanViolationHistoryAllianceOverview["clanSummaries"][number]>) {
  return {
    clanTag: `#C${index}`,
    clanName: `Clan ${index}`,
    evaluatedWarCount: index,
    affectedWarCount: index,
    violationCount: index,
    distinctPlayerCount: index,
    ...overrides,
  };
}

function makePlayerHistoryEntry(
  index: number,
  overrides?: Partial<WarPlanViolationHistoryPlayerHistoryEntry>,
): WarPlanViolationHistoryPlayerHistoryEntry {
  return {
    violationId: `vio-${index}`,
    evaluationId: `eval-${index}`,
    warId: 100 + index,
    warStartTime: new Date(`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    warEndTime: new Date(`2026-01-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`),
    clanTag: `#C${index}`,
    clanName: `Clan ${index}`,
    opponentTag: `#O${index}`,
    opponentName: `Opponent ${index}`,
    expectedOutcome: "WIN",
    loseStyle: "TRIPLE_TOP_30",
    playerNameSnapshot: `Snapshot ${index}`,
    townHallLevelSnapshot: 15 + index,
    playerPosition: index,
    violationType: "ANY_3STAR",
    reasonLabel: `Reason ${index}`,
    expectedBehavior: "Mirror the base.",
    actualBehavior: "Missed the mirror.",
    breachStarsAt: 42 + index,
    breachTimeRemaining: `${20 + index}h left`,
    attackEvidence: {
      attacks: [],
      breachContext: null,
    },
    ...overrides,
  };
}

function makePlayerHistoryResult(
  overrides?: Partial<Extract<WarPlanViolationHistoryPlayerHistoryResult, { outcome: "success" }>>,
): Extract<WarPlanViolationHistoryPlayerHistoryResult, { outcome: "success" }> {
  return {
    outcome: "success",
    period: "30d",
    cutoff: new Date("2026-01-01T00:00:00.000Z"),
    trackingSince: new Date("2026-01-02T00:00:00.000Z"),
    playerTag: "#P1",
    playerName: "Player 1",
    townHallLevel: 18,
    discordUserId: "123",
    violationCount: 1,
    affectedWarCount: 1,
    hasRecordedViolations: true,
    hasViolationsInPeriod: true,
    entries: [makePlayerHistoryEntry(1)],
    ...overrides,
  };
}

function makeAllianceOverview(
  overrides?: Partial<WarPlanViolationHistoryAllianceOverview>,
): WarPlanViolationHistoryAllianceOverview {
  return {
    outcome: "success",
    period: "30d",
    cutoff: new Date("2026-01-01T00:00:00.000Z"),
    trackingSince: new Date("2026-01-02T00:00:00.000Z"),
    evaluatedWarCount: 5,
    affectedWarCount: 4,
    violationCount: 9,
    distinctPlayerCount: 6,
    distinctClanCount: 2,
    distinctCurrentDiscordUserCount: 3,
    clanSummaries: [makeClanSummary(1), makeClanSummary(2)],
    topPlayers: [makePlayerSummary(1), makePlayerSummary(2)],
    hasCompletedEvaluations: true,
    ...overrides,
  };
}

describe("war plan violations view helpers", () => {
  it("formats the shared period label and lifetime tracking note", () => {
    const embed = buildWarPlanViolationsAllianceOverviewEmbed({
      result: makeAllianceOverview({ period: "lifetime" }),
    });

    const json = toEmbedJson(embed);
    expect(formatWarPlanViolationsPeriodLabel("30d")).toBe("Last 30 Days");
    expect(formatWarPlanViolationsPeriodLabel("lifetime")).toBe("Lifetime");
    expect(json.title).toBe("War Plan Violations — Lifetime");
    expect(json.description).toContain("Period: Lifetime");
    expect(json.description).toContain("Tracking since <t:");
    expect(json.description).toContain(
      "History begins when violation tracking was enabled; no historical backfill.",
    );
  });

  it("renders player summary lines with Town Hall fallback, mention, and count suffix intact", () => {
    const line = buildWarPlanViolationsPlayerSummaryLine({
      playerTag: "#LONGTAG",
      playerName: "Commander of the Entirely Too Long Name That Needs Truncation",
      townHallLevel: 18,
      discordUserId: "123",
      violationCount: 4,
      townHallIconSource: new Map<number, string>(),
      maxLength: 90,
    });

    expect(line).toContain("TH18");
    expect(line).toContain("`#LONGTAG`");
    expect(line).toContain("<@123>");
    expect(line).toContain("4 violations");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
    expect(line.length).toBeLessThanOrEqual(100);
  });

  it("renders alliance overview totals, clan rows, top violators, and hidden-item markers", () => {
    const overview = makeAllianceOverview({
      clanSummaries: [makeClanSummary(1), makeClanSummary(2, { clanName: "Clan Two" })],
      topPlayers: Array.from({ length: 12 }, (_, index) =>
        makePlayerSummary(index + 1, {
          playerName: `Very Long Player Name ${index + 1}`,
          townHallLevel: index % 2 === 0 ? 18 : 17,
        }),
      ),
    });

    const embed = toEmbedJson(
      buildWarPlanViolationsAllianceOverviewEmbed({
        result: overview,
        townHallIconSource: new Map([[18, "🏰"]]),
      }),
    );

    expect(embed.fields?.[0]?.name).toBe("Summary");
    expect(embed.fields?.[0]?.value).toContain("Violations: 9");
    expect(embed.fields?.[1]?.name).toBe("By Clan");
    expect(embed.fields?.[1]?.value).toContain("Clan 1");
    expect(embed.fields?.[1]?.value).toContain("Clan Two");
    expect(embed.fields?.[2]?.name).toBe("Top Violators");
    expect(embed.fields?.[2]?.value).toContain("🏰");
    expect(embed.fields?.[2]?.value).toContain("Very Long Player Name 1");
    expect(embed.fields?.[3]?.name).toBe("More");
    expect(embed.fields?.[3]?.value).toBe("+2 more");
  });

  it("renders alliance overview zero state when no completed evaluations exist", () => {
    const embed = toEmbedJson(
      buildWarPlanViolationsAllianceOverviewEmbed({
        result: makeAllianceOverview({
          hasCompletedEvaluations: false,
          clanSummaries: [],
          topPlayers: [],
        }),
      }),
    );

    expect(embed.fields?.[1]?.name).toBe("By Clan");
    expect(embed.fields?.[1]?.value).toContain("No completed evaluations in this period.");
    expect(embed.fields?.[2]?.name).toBe("Top Violators");
    expect(embed.fields?.[2]?.value).toContain("No completed evaluations in this period.");
  });

  it("renders clan leaderboard not-found and zero-violation states", () => {
    const notFound = toEmbedJson(
      buildWarPlanViolationsClanLeaderboardEmbed({
        result: {
          outcome: "not_found",
          clanTag: "#ABC123",
          clanName: null,
          period: "30d",
          cutoff: new Date("2026-01-01T00:00:00.000Z"),
          trackingSince: null,
          evaluatedWarCount: 0,
          affectedWarCount: 0,
          violationCount: 0,
          distinctPlayerCount: 0,
          players: [],
          hasCompletedEvaluations: false,
        },
      }),
    );
    expect(notFound.title).toBe("War Plan Violations — #ABC123");
    expect(notFound.fields?.[0]?.value).toContain("No completed evaluation history exists for this clan in this guild.");

    const zeroState = toEmbedJson(
      buildWarPlanViolationsClanLeaderboardEmbed({
        result: {
          outcome: "success",
          clanTag: "#ABC123",
          clanName: "Alpha Clan",
          period: "30d",
          cutoff: new Date("2026-01-01T00:00:00.000Z"),
          trackingSince: new Date("2026-01-02T00:00:00.000Z"),
          evaluatedWarCount: 3,
          affectedWarCount: 0,
          violationCount: 0,
          distinctPlayerCount: 0,
          players: [],
          hasCompletedEvaluations: false,
        },
      }),
    );
    expect(zeroState.fields?.[0]?.value).toContain("Completed tracking exists, but no violations were recorded in the selected period.");
    expect(zeroState.fields?.[1]?.value).toContain("No completed evaluations were found for this clan in the selected period.");
  });

  it("renders discord-user aggregate success, invalid-user, and not-found states", () => {
    const success = toEmbedJson(
      buildWarPlanViolationsDiscordUserAggregateEmbed({
        result: {
          outcome: "success",
          discordUserId: "123",
          period: "30d",
          cutoff: new Date("2026-01-01T00:00:00.000Z"),
          clanTag: "#ABC123",
          trackingSince: new Date("2026-01-02T00:00:00.000Z"),
          currentLinkedAccountCount: 2,
          violatingAccountCount: 1,
          violationCount: 3,
          affectedWarCount: 2,
          hasViolationsInPeriod: true,
          accounts: [
            makePlayerSummary(1, { playerName: "Zero Violations", violationCount: 0, affectedWarCount: 0 }),
            makePlayerSummary(2, { playerName: "Violator", violationCount: 3, affectedWarCount: 2 }),
          ],
        },
      }),
    );
    expect(success.fields?.[0]?.value).toContain("Current linked accounts: 2");
    expect(success.fields?.[1]?.value).toContain("Zero Violations");
    expect(success.fields?.[1]?.value).toContain("Violator");

    const invalidUser = toEmbedJson(
      buildWarPlanViolationsDiscordUserAggregateEmbed({
        result: {
          outcome: "invalid_user",
          discordUserId: "",
          period: "30d",
          cutoff: new Date("2026-01-01T00:00:00.000Z"),
          clanTag: null,
          trackingSince: null,
          currentLinkedAccountCount: 0,
          violatingAccountCount: 0,
          violationCount: 0,
          affectedWarCount: 0,
          hasViolationsInPeriod: false,
          accounts: [],
        },
      }),
    );
    expect(invalidUser.fields?.[0]?.value).toContain("Invalid Discord user ID.");

    const notFound = toEmbedJson(
      buildWarPlanViolationsDiscordUserAggregateEmbed({
        result: {
          outcome: "not_found",
          discordUserId: "123",
          period: "30d",
          cutoff: new Date("2026-01-01T00:00:00.000Z"),
          clanTag: null,
          trackingSince: null,
          currentLinkedAccountCount: 0,
          violatingAccountCount: 0,
          violationCount: 0,
          affectedWarCount: 0,
          hasViolationsInPeriod: false,
          accounts: [],
        },
      }),
    );
    expect(notFound.fields?.[0]?.value).toContain("No current linked accounts were found for this Discord user.");
  });

  it("renders player-history pages in service order and formats attack evidence cleanly", () => {
    const result = makePlayerHistoryResult({
      entries: [
        makePlayerHistoryEntry(2, {
          warId: 202,
          clanName: "Newest Clan",
          opponentName: null,
          attackEvidence: {
            attacks: [
              { defenderPosition: 12, stars: 0, attackOrder: 1, isBreach: false },
              { defenderPosition: null, stars: 2.7, attackOrder: 2, isBreach: true },
            ],
            breachContext: { starsAtBreach: null, timeRemaining: null },
          },
        }),
        makePlayerHistoryEntry(1, {
          warId: 101,
          clanName: "Older Clan",
          attackEvidence: {
            attacks: [],
            breachContext: null,
          },
        }),
      ],
      violationCount: 2,
      affectedWarCount: 2,
    });

    const firstPage = toEmbedJson(
      buildWarPlanViolationsPlayerHistoryEmbed({
        result,
        page: 0,
        townHallIconSource: new Map([[18, "🏰"]]),
      }),
    );
    const secondPage = toEmbedJson(
      buildWarPlanViolationsPlayerHistoryEmbed({
        result,
        page: 1,
        townHallIconSource: new Map([[18, "🏰"]]),
      }),
    );

    expect(firstPage.footer?.text).toBe("Page 1/2");
    expect(secondPage.footer?.text).toBe("Page 2/2");
    expect(firstPage.fields?.[0]?.value).toContain("War ID: 202");
    expect(secondPage.fields?.[0]?.value).toContain("War ID: 101");
    expect(firstPage.fields?.[0]?.value).toContain("Opponent: #O2");
    expect(firstPage.fields?.[1]?.value).toContain("Breach stars at: 44");
    expect(firstPage.fields?.[2]?.value).toContain("Attack 1: #12 - 0 stars");
    expect(firstPage.fields?.[2]?.value).toContain("Attack 2: #? - 2 stars (breach)");

    const firstPagination = buildWarPlanViolationsPlayerHistoryPaginationRow({
      previousCustomId: "prev",
      nextCustomId: "next",
      currentPage: 0,
      totalPages: 2,
    });
    const controlsFirst = flattenButtons(firstPagination ? [firstPagination] : []);
    expect(controlsFirst[0]?.disabled).toBe(true);
    expect(controlsFirst[1]?.disabled).toBe(false);

    const lastPagination = buildWarPlanViolationsPlayerHistoryPaginationRow({
      previousCustomId: "prev",
      nextCustomId: "next",
      currentPage: 1,
      totalPages: 2,
    });
    const controlsLast = flattenButtons(lastPagination ? [lastPagination] : []);
    expect(controlsLast[0]?.disabled).toBe(false);
    expect(controlsLast[1]?.disabled).toBe(true);

    const expiredPagination = buildWarPlanViolationsPlayerHistoryPaginationRow({
      previousCustomId: "prev",
      nextCustomId: "next",
      currentPage: 1,
      totalPages: 2,
      disabled: true,
    });
    const controlsExpired = flattenButtons(expiredPagination ? [expiredPagination] : []);
    expect(controlsExpired[0]?.disabled).toBe(true);
    expect(controlsExpired[1]?.disabled).toBe(true);
    expect(buildWarPlanViolationsPlayerHistoryPaginationRow({
      previousCustomId: "prev",
      nextCustomId: "next",
      currentPage: 0,
      totalPages: 1,
    })).toBeNull();
  });

  it("formats all known violation labels and a stable unknown fallback", () => {
    expect(formatWarPlanViolationsViolationTypeLabel("EARLY_NON_MIRROR_TRIPLE")).toBe(
      "Early non-mirror triple",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("STRICT_WINDOW_MIRROR_MISS_WIN")).toBe(
      "Missed mirror during WIN strict window",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("STRICT_WINDOW_MIRROR_MISS_LOSS")).toBe(
      "Missed mirror during LOSS strict window",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("EARLY_NON_MIRROR_2STAR")).toBe(
      "Early non-mirror 2-star",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("ANY_3STAR")).toBe("3-star plan violation");
    expect(formatWarPlanViolationsViolationTypeLabel("LOWER20_ANY_STARS")).toBe(
      "Lower-20 attack violation",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("OTHER_PLAN_VIOLATION")).toBe(
      "Other plan violation",
    );
    expect(formatWarPlanViolationsViolationTypeLabel("NEW_FUTURE_TYPE")).toBe(
      "Unknown plan violation: NEW FUTURE TYPE",
    );
  });

  it("keeps the visible suffix when player names are truncated", () => {
    const line = buildWarPlanViolationsPlayerSummaryLine({
      playerTag: "#ABCDEFG",
      playerName: "This is an intentionally long player name that should be truncated before the suffix",
      townHallLevel: 16,
      discordUserId: null,
      violationCount: 1,
      maxLength: 70,
    });

    expect(line).toContain("`#ABCDEFG`");
    expect(line).toContain("1 violation");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
  });
});
