import { beforeEach, describe, expect, it } from "vitest";
import {
  resetFwaSteadyStateLogTrackersForTest,
  resolveMatchTypeResolutionLogLevelForTest,
  resolveRoutineBlockedPointsFetchSkipLogLevelForTest,
} from "../src/commands/Fwa";
import { SteadyStateLogGate } from "../src/helper/steadyStateLogGate";
import {
  buildTrackedClanWarsWatchSummaryKeyForTest,
  resolveTrackedClanWarsWatchSummaryLogLevelForTest,
} from "../src/services/fwa-feeds/FwaFeedSchedulerService";

describe("fwa routine points-skip logging policy", () => {
  beforeEach(() => {
    resetFwaSteadyStateLogTrackersForTest();
  });

  it("demotes repeated validated_active_war_locked routine skips to debug", () => {
    const first = resolveRoutineBlockedPointsFetchSkipLogLevelForTest({
      guildId: "guild-1",
      clanTag: "AAA111",
      fetchReason: "mail_refresh",
      outcome: "blocked",
      decisionCode: "validated_active_war_locked",
    });
    const second = resolveRoutineBlockedPointsFetchSkipLogLevelForTest({
      guildId: "guild-1",
      clanTag: "AAA111",
      fetchReason: "mail_refresh",
      outcome: "blocked",
      decisionCode: "validated_active_war_locked",
    });

    expect(first).toBe("info");
    expect(second).toBe("debug");
  });

  it("keeps changed blocked-state events at info", () => {
    const first = resolveRoutineBlockedPointsFetchSkipLogLevelForTest({
      guildId: "guild-1",
      clanTag: "AAA111",
      fetchReason: "mail_refresh",
      outcome: "blocked",
      decisionCode: "validated_active_war_locked",
    });
    const changed = resolveRoutineBlockedPointsFetchSkipLogLevelForTest({
      guildId: "guild-1",
      clanTag: "AAA111",
      fetchReason: "mail_refresh",
      outcome: "blocked",
      decisionCode: "policy_blocked",
    });

    expect(first).toBe("info");
    expect(changed).toBe("info");
  });
});

describe("fwa match-type logging policy", () => {
  beforeEach(() => {
    resetFwaSteadyStateLogTrackersForTest();
  });

  it("demotes repeated identical match-type confirmations to debug", () => {
    const first = resolveMatchTypeResolutionLogLevelForTest({
      stage: "mail_embed",
      clanTag: "AAA111",
      warId: 1001,
      source: "confirmed_current_war",
      matchType: "FWA",
      inferred: false,
      confirmed: true,
    });
    const second = resolveMatchTypeResolutionLogLevelForTest({
      stage: "mail_embed",
      clanTag: "AAA111",
      warId: 1001,
      source: "confirmed_current_war",
      matchType: "FWA",
      inferred: false,
      confirmed: true,
    });

    expect(first).toBe("info");
    expect(second).toBe("debug");
  });

  it("logs source/type/flag changes at info", () => {
    resolveMatchTypeResolutionLogLevelForTest({
      stage: "mail_embed",
      clanTag: "AAA111",
      warId: 1001,
      source: "confirmed_current_war",
      matchType: "FWA",
      inferred: false,
      confirmed: true,
    });
    const changedSource = resolveMatchTypeResolutionLogLevelForTest({
      stage: "mail_embed",
      clanTag: "AAA111",
      warId: 1001,
      source: "stored_sync",
      matchType: "FWA",
      inferred: true,
      confirmed: false,
    });
    const changedType = resolveMatchTypeResolutionLogLevelForTest({
      stage: "mail_embed",
      clanTag: "AAA111",
      warId: 1001,
      source: "live_points_active_fwa_no",
      matchType: "BL",
      inferred: true,
      confirmed: false,
    });

    expect(changedSource).toBe("info");
    expect(changedType).toBe("info");
  });
});

describe("tracked clan wars watch summary logging policy", () => {
  it("keeps repeated empty/no-op watch summaries out of info", () => {
    const summary = {
      trackedClanCount: 9,
      activeClanCount: 0,
      polledClanCount: 0,
      updateAcquiredCount: 0,
    };

    const gate = new SteadyStateLogGate();
    const firstChanged = gate.shouldEmitInfo(
      "tracked_clan_wars_watch",
      buildTrackedClanWarsWatchSummaryKeyForTest(summary),
    );
    const secondChanged = gate.shouldEmitInfo(
      "tracked_clan_wars_watch",
      buildTrackedClanWarsWatchSummaryKeyForTest(summary),
    );
    const secondLevel = resolveTrackedClanWarsWatchSummaryLogLevelForTest({
      summary,
      summaryChanged: secondChanged,
    });

    expect(firstChanged).toBe(true);
    expect(secondChanged).toBe(false);
    expect(secondLevel).toBe("debug");
  });

  it("logs changed or non-empty watch summaries at info", () => {
    const noOpSummary = {
      trackedClanCount: 9,
      activeClanCount: 0,
      polledClanCount: 0,
      updateAcquiredCount: 0,
    };
    const changedSummary = {
      trackedClanCount: 9,
      activeClanCount: 1,
      polledClanCount: 1,
      updateAcquiredCount: 0,
    };
    const gate = new SteadyStateLogGate();
    gate.shouldEmitInfo(
      "tracked_clan_wars_watch",
      buildTrackedClanWarsWatchSummaryKeyForTest(noOpSummary),
    );
    const changed = gate.shouldEmitInfo(
      "tracked_clan_wars_watch",
      buildTrackedClanWarsWatchSummaryKeyForTest(changedSummary),
    );

    const changedLevel = resolveTrackedClanWarsWatchSummaryLogLevelForTest({
      summary: noOpSummary,
      summaryChanged: changed,
    });
    const nonEmptyLevel = resolveTrackedClanWarsWatchSummaryLogLevelForTest({
      summary: changedSummary,
      summaryChanged: false,
    });

    expect(changed).toBe(true);
    expect(changedLevel).toBe("info");
    expect(nonEmptyLevel).toBe("info");
  });
});
