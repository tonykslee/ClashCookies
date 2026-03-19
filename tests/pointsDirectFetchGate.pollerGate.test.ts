import { describe, expect, it, vi } from "vitest";
import {
  PointsDirectFetchGateService,
  type PointsLockStateRecord,
} from "../src/services/PointsDirectFetchGateService";

function buildRuntime(overrides?: Record<string, unknown>) {
  return {
    tracked: true,
    clanTag: "#AAA111",
    guildId: "guild-1",
    warState: "inWar",
    matchType: "FWA",
    activeWarId: "777",
    activeWarStartMs: new Date("2026-03-08T07:00:00.000Z").getTime(),
    activeWarEndMs: new Date("2026-03-09T07:00:00.000Z").getTime(),
    activeOpponentTag: "#OPP999",
    mailLifecycleStatus: "POSTED",
    lifecycle: {
      confirmedByClanMail: true,
      needsValidation: false,
      lastSuccessfulPointsApiFetchAt: new Date("2026-03-08T07:30:00.000Z"),
      lastKnownSyncNumber: 2001,
      lastKnownPoints: 1200,
      warId: "777",
      opponentTag: "#OPP999",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
    },
    latestKnownPoints: 1200,
    postedSyncAtMs: null,
    hasReusableWarSnapshot: false,
    ...overrides,
  };
}

function buildState(overrides?: Partial<PointsLockStateRecord>): PointsLockStateRecord {
  return {
    lifecycleState: "active_war_locked",
    clanTag: "#AAA111",
    guildId: "guild-1",
    warId: "777",
    warStartMs: new Date("2026-03-08T07:00:00.000Z").getTime(),
    warEndMs: new Date("2026-03-09T07:00:00.000Z").getTime(),
    matchType: "FWA",
    baselinePoints: 1200,
    pointValueChangedAtMs: null,
    postedSyncAtMs: null,
    lockUntilMs: null,
    updatedAtMs: new Date("2026-03-08T08:00:00.000Z").getTime(),
    ...overrides,
  };
}

function buildService(params?: {
  runtime?: ReturnType<typeof buildRuntime>;
  persisted?: PointsLockStateRecord | null;
}) {
  const service = new PointsDirectFetchGateService({} as never);
  const runtime = params?.runtime ?? buildRuntime();
  const persisted = params?.persisted ?? null;
  (service as any).loadRuntimeSnapshot = vi.fn().mockResolvedValue(runtime);
  (service as any).readPersistedState = vi.fn().mockResolvedValue(persisted);
  (service as any).writePersistedState = vi.fn().mockResolvedValue(undefined);
  return { service, runtime, persisted };
}

describe("PointsDirectFetchGateService.evaluatePollerFetch", () => {
  it("blocks active-war polling after the match is validated and locked for the clan", async () => {
    const { service } = buildService({
      runtime: buildRuntime(),
      persisted: buildState({ lifecycleState: "active_war_locked" }),
    });

    const decision = await service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "pre_fwa_validation",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2001,
      lifecycle: buildRuntime().lifecycle,
      activeOpponentTag: "#OPP999",
      activeWarId: "777",
      nowMs: new Date("2026-03-08T08:10:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("validated_active_war_locked");
    expect(decision.fetchReason).toBeNull();
    expect(decision.lockState).toBe("active_war_locked");
  });

  it("keeps active-war polling open while validation is still needed", async () => {
    const runtime = buildRuntime({
      lifecycle: {
        confirmedByClanMail: false,
        needsValidation: true,
        lastSuccessfulPointsApiFetchAt: null,
        lastKnownSyncNumber: 2000,
        lastKnownPoints: 1180,
        warId: "777",
        opponentTag: "#OPP999",
        warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      },
      mailLifecycleStatus: "UNSENT",
    });
    const { service } = buildService({ runtime, persisted: buildState({ lifecycleState: "unlocked" }) });

    const decision = await service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "pre_fwa_validation",
      preferredAllowedReason: "mail_refresh",
      warState: "inWar",
      warStartTime: new Date("2026-03-08T07:00:00.000Z"),
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: 2000,
      lifecycle: runtime.lifecycle,
      activeOpponentTag: "#OPP999",
      activeWarId: "777",
      nowMs: new Date("2026-03-08T07:15:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("policy_allowed");
    expect(decision.fetchReason).toBe("mail_refresh");
    expect(decision.lockState).toBe("unlocked");
  });

  it("allows post-war polling until website points change", async () => {
    const postedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const { service } = buildService({
      runtime: buildRuntime({
        warState: "notInWar",
        lifecycle: null,
        postedSyncAtMs,
        activeWarEndMs: new Date("2026-03-09T07:00:00.000Z").getTime(),
      }),
      persisted: buildState({
        lifecycleState: "post_war_unlocked_waiting_for_point_change",
        postedSyncAtMs,
      }),
    });

    const decision = await service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "notInWar",
      warStartTime: null,
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: null,
      lifecycle: null,
      activeOpponentTag: null,
      activeWarId: null,
      nowMs: new Date("2026-03-09T07:05:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.decisionCode).toBe("policy_allowed");
    expect(decision.fetchReason).toBe("post_war_reconciliation");
    expect(decision.lockState).toBe("post_war_unlocked_waiting_for_point_change");
  });

  it("blocks between-wars polling until the pre-sync reopen window", async () => {
    const postedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const { service } = buildService({
      runtime: buildRuntime({
        warState: "notInWar",
        lifecycle: null,
        postedSyncAtMs,
      }),
      persisted: buildState({
        lifecycleState: "between_wars_locked_until_presync",
        postedSyncAtMs,
        lockUntilMs: postedSyncAtMs - 10 * 60 * 1000,
      }),
    });

    const decision = await service.evaluatePollerFetch({
      guildId: "guild-1",
      clanTag: "#AAA111",
      pollerSource: "war_event_poll_cycle",
      requestedReason: "post_war_reconciliation",
      warState: "notInWar",
      warStartTime: null,
      warEndTime: new Date("2026-03-09T07:00:00.000Z"),
      currentSyncNumber: null,
      lifecycle: null,
      activeOpponentTag: null,
      activeWarId: null,
      nowMs: new Date("2026-03-09T07:20:00.000Z").getTime(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("policy_blocked");
    expect(decision.fetchReason).toBeNull();
    expect(decision.lockState).toBe("between_wars_locked_until_presync");
  });
});
