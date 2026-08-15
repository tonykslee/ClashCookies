import { describe, expect, it, vi } from "vitest";
import {
  CLAN_GOAL_IDS,
  getClanGoalCatalog,
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("outcome=skip"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("outcome=failure"));
  });
});
