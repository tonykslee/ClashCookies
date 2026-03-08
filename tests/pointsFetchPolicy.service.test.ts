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
});
