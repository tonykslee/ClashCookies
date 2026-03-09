import { afterEach, describe, expect, it } from "vitest";
import { PointsFetchPolicyService } from "../src/services/PointsFetchPolicyService";

const ENV_KEYS = [
  "FWA_OPTIMIZED_POINTS_POLLING",
  "FWA_POST_WAR_CHECK_WINDOW_MINUTES",
  "FWA_POST_WAR_CHECK_INTERVAL_MINUTES",
  "FWA_ADMIN_ADJUSTMENT_CHECK_INTERVAL_MINUTES",
  "FWA_PRE_FWA_VALIDATION_WINDOW_MINUTES",
  "FWA_PRE_FWA_VALIDATION_INTERVAL_MINUTES",
];

/** Purpose: clear policy-related env vars so tests stay deterministic. */
function resetPolicyEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  resetPolicyEnv();
});

describe("PointsFetchPolicyService", () => {
  it("allows reconciliation fetches when no lifecycle state exists", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.shouldFetchForRoutine({
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: null,
      currentSyncNumber: 2001,
      lifecycle: null,
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.shouldFetch).toBe(true);
    expect(decision.reason).toBe("post_war_reconciliation");
  });

  it("suppresses routine fetches after clan-mail confirmation when no trigger is active", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.shouldFetchForRoutine({
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: null,
      currentSyncNumber: 2001,
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:55:00.000Z"),
        lastKnownSyncNumber: 2001,
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.shouldFetch).toBe(false);
    expect(decision.skipReason).toBe("confirmed_by_clan_mail");
  });

  it("re-enables fetches when lifecycle is explicitly marked as needs-validation", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.shouldFetchForRoutine({
      warState: "preparation",
      warStartTime: new Date("2026-03-08T09:00:00.000Z"),
      warEndTime: null,
      currentSyncNumber: 2001,
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: true,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:55:00.000Z"),
        lastKnownSyncNumber: 2001,
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.shouldFetch).toBe(true);
    expect(decision.reason).toBe("pre_fwa_validation");
  });

  it("runs post-war delayed checks inside the configured window", () => {
    process.env.FWA_POST_WAR_CHECK_WINDOW_MINUTES = "240";
    process.env.FWA_POST_WAR_CHECK_INTERVAL_MINUTES = "30";
    const service = new PointsFetchPolicyService();
    const now = new Date("2026-03-08T10:00:00.000Z").getTime();
    const decision = service.shouldFetchForRoutine({
      warState: "notInWar",
      warStartTime: new Date("2026-03-07T08:00:00.000Z"),
      warEndTime: new Date("2026-03-08T08:30:00.000Z"),
      currentSyncNumber: 2002,
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T09:00:00.000Z"),
        lastKnownSyncNumber: 2002,
      },
      nowMs: now,
    });

    expect(decision.shouldFetch).toBe(true);
    expect(decision.reason).toBe("post_war_check");
  });

  it("blocks post_war_reconciliation under active mail-confirmed lock", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      activeWarId: "777",
      activeOpponentTag: "#OPP999",
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:40:00.000Z"),
        lastKnownSyncNumber: 2001,
        warId: "777",
        opponentTag: "#OPP999",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("blocked");
    expect(decision.decisionCode).toBe("locked_mail_confirmed");
  });

  it("blocks mail_refresh under active mail-confirmed lock", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "mail_refresh_loop",
      requestedReason: "mail_refresh",
      preferredAllowedReason: "mail_refresh",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      activeWarId: "777",
      activeOpponentTag: "#OPP999",
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:40:00.000Z"),
        lastKnownSyncNumber: 2001,
        warId: "777",
        opponentTag: "#OPP999",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("locked_mail_confirmed");
  });

  it("unlocks routine fetch when war identity changed", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      activeWarId: "888",
      activeOpponentTag: "#NEW123",
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:40:00.000Z"),
        lastKnownSyncNumber: 2001,
        warId: "777",
        opponentTag: "#OLD123",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("war_identity_changed");
  });

  it("unlocks routine fetch when validation is required", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      activeWarId: "777",
      activeOpponentTag: "#OPP999",
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: true,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:40:00.000Z"),
        lastKnownSyncNumber: 2001,
        warId: "777",
        opponentTag: "#OPP999",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("validation_required");
  });

  it("allows manual override even when lock would otherwise block", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      activeWarId: "777",
      activeOpponentTag: "#OPP999",
      manualOverride: true,
      lifecycle: {
        confirmedByClanMail: true,
        needsValidation: false,
        lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:40:00.000Z"),
        lastKnownSyncNumber: 2001,
        warId: "777",
        opponentTag: "#OPP999",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("manual_override");
  });

  it("returns not_applicable for mail_refresh when no active war exists", () => {
    const service = new PointsFetchPolicyService();
    const decision = service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "mail_refresh_loop",
      requestedReason: "mail_refresh",
      preferredAllowedReason: "mail_refresh",
      warState: "notInWar",
      warStartTime: null,
      warEndTime: null,
      currentSyncNumber: 2001,
      activeWarId: null,
      activeOpponentTag: null,
      lifecycle: null,
      nowMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("not_applicable");
    expect(decision.decisionCode).toBe("inactive_war_for_mail_refresh");
  });
});
