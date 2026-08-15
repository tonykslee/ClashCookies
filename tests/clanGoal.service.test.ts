import { describe, expect, it, vi } from "vitest";
import {
  CLAN_GOAL_IDS,
  getClanGoalCatalog,
  evaluateFwaNoViolationsGoal,
  evaluateLiveWarClanGoal,
  evaluateLiveWarClanGoals,
  evaluateWarNoMissedAttacksGoal,
  logClanGoalOutcome,
  renderClanGoalMessage,
  resolveClanGoalDestination,
  selectClanGoalSnippet,
} from "../src/services/ClanGoalService";

describe("ClanGoalService foundation", () => {
  it("exposes all canonical goal ids with several snippets each", () => {
    const catalog = getClanGoalCatalog();

    expect(catalog.map((goal) => goal.id)).toEqual([...CLAN_GOAL_IDS]);
    expect(catalog).toHaveLength(7);
    expect(catalog.every((goal) => goal.snippets.length >= 3)).toBe(true);
  });

  it("selects snippets deterministically from the full event identity", () => {
    const input = {
      goalId: "FWA_WIN_150_STARS" as const,
      guildId: "guild-1",
      clanTag: "#ABC123",
      warId: 42,
      syncIdentity: "sync-7",
    };

    expect(selectClanGoalSnippet(input)).toBe(selectClanGoalSnippet(input));
    expect(selectClanGoalSnippet({ ...input, warId: 43 })).toMatch(
      /.+/,
    );
  });

  it("renders non-pinging content", () => {
    const rendered = renderClanGoalMessage({
      goalId: "SYNC_ZERO_DEVIATION",
      guildId: "guild-1",
      clanTag: "#ABC123",
      clanName: "The Testers",
      syncIdentity: "sync-7",
    });

    expect(rendered.content).toContain("The Testers (#ABC123)");
    expect(rendered.allowedMentions).toEqual({ parse: [] });
  });

  it("normalizes bare and hash clan tags identically for rendering and snippets", () => {
    const bare = {
      goalId: "FWA_WIN_150_STARS" as const,
      guildId: "guild-1",
      clanTag: "abc123",
      warId: 42,
    };
    const hashed = { ...bare, clanTag: "#ABC123" };

    expect(selectClanGoalSnippet(bare)).toBe(selectClanGoalSnippet(hashed));
    expect(renderClanGoalMessage(bare).content).toContain("#ABC123");
    expect(renderClanGoalMessage(hashed).content).toBe(
      renderClanGoalMessage(bare).content,
    );
  });

  it("evaluates current live-war facts without requiring threshold transitions", () => {
    const base = {
      warState: "inWar" as const,
      matchType: "FWA" as const,
      inferredMatchType: false,
      outcome: "LOSE" as const,
      loseStyle: "TRADITIONAL" as const,
      clanStars: 103,
    };

    expect(
      evaluateLiveWarClanGoal({
        goalId: "FWA_LOSE_TRADITIONAL_100_STARS",
        facts: base,
      }),
    ).toMatchObject({ qualified: true, reason: "qualified" });
    expect(evaluateLiveWarClanGoals(base)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          goalId: "FWA_LOSE_TRADITIONAL_100_STARS",
          qualified: true,
        }),
      ]),
    );
  });

  it("waits for settled classification and gates top-30 cleanliness after stars", () => {
    const unresolved = evaluateLiveWarClanGoal({
      goalId: "FWA_WIN_150_STARS",
      facts: {
        warState: "inWar",
        matchType: "FWA",
        inferredMatchType: true,
        outcome: "WIN",
        loseStyle: null,
        clanStars: 150,
      },
    });
    expect(unresolved).toMatchObject({
      qualified: false,
      reason: "classification_unsettled",
    });

    const needsCleanliness = evaluateLiveWarClanGoal({
      goalId: "FWA_LOSE_TOP30_90_CLEAN",
      facts: {
        warState: "inWar",
        matchType: "FWA",
        inferredMatchType: false,
        outcome: "LOSE",
        loseStyle: "TRIPLE_TOP_30",
        clanStars: 90,
      },
    });
    expect(needsCleanliness).toMatchObject({
      qualified: false,
      reason: "attack_cleanliness_not_checked",
      requiresAttackCleanliness: true,
    });
    expect(
      evaluateLiveWarClanGoal({
        goalId: "FWA_LOSE_TOP30_90_CLEAN",
        facts: {
          warState: "inWar",
          matchType: "FWA",
          inferredMatchType: false,
          outcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
          clanStars: 90,
          top30Clean: false,
        },
      }),
    ).toMatchObject({ qualified: false, reason: "top30_attack_on_bottom_20" });
  });

  it("keeps the four live predicates independent", () => {
    expect(
      evaluateLiveWarClanGoal({
        goalId: "FWA_LOSE_TOP30_90_CLEAN",
        facts: {
          warState: "inWar",
          matchType: "FWA",
          inferredMatchType: false,
          outcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
          clanStars: 91,
          top30Clean: true,
        },
      }).qualified,
    ).toBe(true);
    expect(
      evaluateLiveWarClanGoal({
        goalId: "FWA_WIN_150_STARS",
        facts: {
          warState: "inWar",
          matchType: "FWA",
          inferredMatchType: false,
          outcome: "WIN",
          loseStyle: "TRADITIONAL",
          clanStars: 150,
        },
      }).qualified,
    ).toBe(true);
    expect(
      evaluateLiveWarClanGoal({
        goalId: "BL_150_STARS",
        facts: {
          warState: "inWar",
          matchType: "BL",
          inferredMatchType: false,
          outcome: null,
          loseStyle: "TRADITIONAL",
          clanStars: 150,
        },
      }).qualified,
    ).toBe(true);
  });

  it("requires completed canonical FWA compliance with zero violations", () => {
    const base = {
      guildId: "guild-1",
      warId: 42,
      clanTag: "#ABC123",
      history: {
        warId: 42,
        clanTag: "#ABC123",
        matchType: "FWA",
        warEndTime: new Date("2026-01-02T00:00:00.000Z"),
      },
    };
    expect(
      evaluateFwaNoViolationsGoal({
        ...base,
        evaluation: {
          guildId: "guild-1",
          warId: 42,
          status: "COMPLETED",
          violationCount: 0,
        },
      }),
    ).toMatchObject({ qualified: true, reason: "qualified" });
    expect(
      evaluateFwaNoViolationsGoal({
        ...base,
        evaluation: {
          guildId: "guild-1",
          warId: 42,
          status: "PENDING",
          violationCount: 0,
        },
      }),
    ).toMatchObject({ qualified: false, reason: "evaluation_not_completed" });
    expect(
      evaluateFwaNoViolationsGoal({
        ...base,
        evaluation: {
          guildId: "guild-1",
          warId: 42,
          status: "COMPLETED",
          violationCount: 0,
        },
        history: { ...base.history, matchType: "MM" },
      }),
    ).toMatchObject({ qualified: false, reason: "history_match_type_mismatch" });
  });

  it("requires an explicit complete canonical roster for no-missed-attacks", () => {
    const base = {
      guildId: "guild-1",
      warId: "42",
      clanTag: "#ABC123",
      history: {
        warId: 42,
        clanTag: "ABC123",
        matchType: "MM",
        warEndTime: new Date("2026-01-02T00:00:00.000Z"),
      },
      expectedParticipantCount: 2,
    };
    expect(
      evaluateWarNoMissedAttacksGoal({
        ...base,
        participation: [
          { guildId: "guild-1", warId: "42", clanTag: "#ABC123", playerTag: "#P1", attacksMissed: 0 },
          { guildId: "guild-1", warId: "42", clanTag: "#ABC123", playerTag: "#P2", attacksMissed: 0 },
        ],
      }),
    ).toMatchObject({ qualified: true, reason: "qualified" });
    expect(
      evaluateWarNoMissedAttacksGoal({
        ...base,
        participation: [
          { guildId: "guild-1", warId: "42", clanTag: "#ABC123", playerTag: "#P1", attacksMissed: 0 },
        ],
      }),
    ).toMatchObject({ qualified: false, reason: "participant_count_mismatch" });
    expect(
      evaluateWarNoMissedAttacksGoal({
        ...base,
        participation: [
          { guildId: "guild-1", warId: "42", clanTag: "#ABC123", playerTag: "#P1", attacksMissed: 1 },
          { guildId: "guild-1", warId: "42", clanTag: "#ABC123", playerTag: "#P2", attacksMissed: 0 },
        ],
      }),
    ).toMatchObject({ qualified: false, reason: "missed_attacks_present" });
  });

  it("resolves all routed destination modes and reports missing destinations as skips", () => {
    const base = {
      clanLogChannelId: "111111111111111111",
      clanLeaderChannelId: "222222222222222222",
      botLogChannelId: "333333333333333333",
    };
    expect(resolveClanGoalDestination({ routingConfig: { routingMode: "CLAN_LOG" }, ...base })).toEqual({
      channelId: "111111111111111111",
      source: "clan_log",
    });
    expect(resolveClanGoalDestination({ routingConfig: { routingMode: "CLAN_LEAD" }, ...base })).toEqual({
      channelId: "222222222222222222",
      source: "clan_lead",
    });
    expect(resolveClanGoalDestination({ routingConfig: { routingMode: "BOT_LOG" }, ...base })).toEqual({
      channelId: "333333333333333333",
      source: "bot_log",
    });
    expect(resolveClanGoalDestination({
      routingConfig: { routingMode: "CUSTOM", channelId: "444444444444444444" },
      ...base,
    })).toEqual({ channelId: "444444444444444444", source: "custom" });
    expect(resolveClanGoalDestination({ routingConfig: { routingMode: "DISABLED" }, ...base })).toEqual({
      channelId: null,
      source: null,
      skipReason: "disabled",
    });
    expect(resolveClanGoalDestination({
      routingConfig: { routingMode: "CLAN_LOG" },
      ...base,
      clanLogChannelId: null,
    })).toEqual({
      channelId: null,
      source: null,
      skipReason: "missing_clan_log_channel",
    });
  });

  it("emits structured outcome logs for future trigger callers", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const identity = { guildId: "guild-1", clanTag: "#ABC123", warId: 42 };

    logClanGoalOutcome({
      outcome: "success",
      event: "goal_notification",
      goalId: "FWA_WIN_150_STARS",
      identity,
    });
    logClanGoalOutcome({
      outcome: "skip",
      event: "goal_notification",
      goalId: "FWA_WIN_150_STARS",
      identity,
      reason: "disabled",
    });
    logClanGoalOutcome({
      outcome: "failure",
      event: "goal_notification",
      goalId: "FWA_WIN_150_STARS",
      identity,
      error: new Error("boom"),
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining("outcome=success"));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("outcome=skip"));
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("outcome=failure"));
  });
});
