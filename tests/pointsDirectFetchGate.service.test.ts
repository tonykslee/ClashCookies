import { WarMailLifecycleStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  applyObservedPointValueTransitionForTest,
  buildPointsDirectFetchDecisionForTest,
  derivePointsLockLifecycleStateForTest,
  type PointsLockStateRecord,
} from "../src/services/PointsDirectFetchGateService";

type TestRuntime = Parameters<
  typeof derivePointsLockLifecycleStateForTest
>[0]["runtime"];

function buildRuntime(overrides?: Partial<TestRuntime>): TestRuntime {
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
    mailLifecycleStatus: WarMailLifecycleStatus.POSTED,
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

function buildState(
  overrides?: Partial<PointsLockStateRecord>,
): PointsLockStateRecord {
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

describe("PointsDirectFetchGate lifecycle", () => {
  it("blocks active-war direct fetches and allows explicit manual force bypass", () => {
    const nowMs = new Date("2026-03-08T08:10:00.000Z").getTime();
    const runtime = buildRuntime();
    const state = derivePointsLockLifecycleStateForTest({
      runtime,
      persisted: null,
      nowMs,
    });
    const blocked = buildPointsDirectFetchDecisionForTest({
      runtime,
      state,
      caller: "command",
      fetchReason: "match_render",
      manualForceBypass: false,
    });
    const bypass = buildPointsDirectFetchDecisionForTest({
      runtime,
      state,
      caller: "command",
      fetchReason: "manual_refresh",
      manualForceBypass: true,
    });

    expect(state.lifecycleState).toBe("active_war_locked");
    expect(blocked.allowed).toBe(false);
    expect(blocked.decisionCode).toBe("locked_active_war");
    expect(bypass.allowed).toBe(true);
    expect(bypass.decisionCode).toBe("manual_force_bypass");
  });

  it("blocks routine direct fetches when a reusable war snapshot already exists", () => {
    const runtime = buildRuntime({
      warState: "inWar",
      hasReusableWarSnapshot: true,
    });
    const state = buildState({ lifecycleState: "unlocked" });
    const decision = buildPointsDirectFetchDecisionForTest({
      runtime,
      state,
      caller: "poller",
      fetchReason: "post_war_reconciliation",
      manualForceBypass: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("reused_war_snapshot");
  });

  it("re-locks non-MM between wars after point value changes when posted sync exists", () => {
    const nowMs = new Date("2026-03-09T07:05:00.000Z").getTime();
    const postedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const runtime = buildRuntime({
      warState: "notInWar",
      matchType: "FWA",
      lifecycle: null,
      postedSyncAtMs,
    });
    const postWarState = derivePointsLockLifecycleStateForTest({
      runtime,
      persisted: buildState({ postedSyncAtMs }),
      nowMs,
    });
    const changed = applyObservedPointValueTransitionForTest({
      state: postWarState,
      observedPoints: 1250,
      nowMs: nowMs + 60_000,
    });
    const blockedDecision = buildPointsDirectFetchDecisionForTest({
      runtime,
      state: changed,
      caller: "poller",
      fetchReason: "post_war_reconciliation",
      manualForceBypass: false,
    });

    expect(postWarState.lifecycleState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
    expect(changed.lifecycleState).toBe("between_wars_locked_until_presync");
    expect(changed.lockUntilMs).toBe(postedSyncAtMs - 10 * 60 * 1000);
    expect(blockedDecision.allowed).toBe(false);
    expect(blockedDecision.decisionCode).toBe(
      "locked_between_wars_until_presync",
    );
  });

  it("does not keep non-MM between-war lock after point change when no posted sync exists", () => {
    const state = buildState({
      lifecycleState: "post_war_unlocked_waiting_for_point_change",
      postedSyncAtMs: null,
      lockUntilMs: null,
      matchType: "FWA",
    });
    const transitioned = applyObservedPointValueTransitionForTest({
      state,
      observedPoints: 1300,
      nowMs: new Date("2026-03-09T08:00:00.000Z").getTime(),
    });

    expect(transitioned.lifecycleState).toBe("unlocked");
    expect(transitioned.lockUntilMs).toBeNull();
  });

  it("keeps non-MM post-war wait state unchanged when observed points equal baseline", () => {
    const state = buildState({
      lifecycleState: "post_war_unlocked_waiting_for_point_change",
      postedSyncAtMs: null,
      lockUntilMs: null,
      matchType: "BL",
      baselinePoints: 6,
      pointValueChangedAtMs: null,
    });
    const transitioned = applyObservedPointValueTransitionForTest({
      state,
      observedPoints: 6,
      nowMs: new Date("2026-03-09T08:00:00.000Z").getTime(),
    });

    expect(transitioned).toEqual(state);
    expect(transitioned.lifecycleState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
    expect(transitioned.baselinePoints).toBe(6);
  });

  it("does not unlock MM post-war state when observed points change", () => {
    const state = buildState({
      lifecycleState: "post_war_unlocked_waiting_for_point_change",
      postedSyncAtMs: null,
      lockUntilMs: null,
      matchType: "MM",
      baselinePoints: 6,
      pointValueChangedAtMs: null,
    });
    const transitioned = applyObservedPointValueTransitionForTest({
      state,
      observedPoints: 7,
      nowMs: new Date("2026-03-09T08:00:00.000Z").getTime(),
    });

    expect(transitioned).toEqual(state);
    expect(transitioned.lifecycleState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
    expect(transitioned.baselinePoints).toBe(6);
  });

  it("keeps post-war waiting lifecycle when reusable sync snapshot blocks direct fetch", () => {
    const runtime = buildRuntime({
      warState: "notInWar",
      matchType: "BL",
      hasReusableWarSnapshot: true,
    });
    const state = buildState({
      lifecycleState: "post_war_unlocked_waiting_for_point_change",
      matchType: "BL",
      baselinePoints: 6,
    });
    const decision = buildPointsDirectFetchDecisionForTest({
      runtime,
      state,
      caller: "poller",
      fetchReason: "post_war_reconciliation",
      manualForceBypass: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.decisionCode).toBe("reused_war_snapshot");
    expect(decision.lockState).toBe(
      "post_war_unlocked_waiting_for_point_change",
    );
  });

  it("keeps MM locked until pre-sync window when posted sync exists", () => {
    const warEndMs = new Date("2026-03-09T07:00:00.000Z").getTime();
    const postedSyncAtMs = new Date("2026-03-09T09:00:00.000Z").getTime();
    const lockedState = derivePointsLockLifecycleStateForTest({
      runtime: buildRuntime({
        warState: "notInWar",
        matchType: "MM",
        lifecycle: null,
        activeWarEndMs: warEndMs,
        postedSyncAtMs,
      }),
      persisted: buildState({ matchType: "MM", warEndMs, postedSyncAtMs }),
      nowMs: new Date("2026-03-09T07:10:00.000Z").getTime(),
    });
    const unlockedState = derivePointsLockLifecycleStateForTest({
      runtime: buildRuntime({
        warState: "notInWar",
        matchType: "MM",
        lifecycle: null,
        activeWarEndMs: warEndMs,
        postedSyncAtMs,
      }),
      persisted: lockedState,
      nowMs: postedSyncAtMs - 9 * 60 * 1000,
    });

    expect(lockedState.lifecycleState).toBe("mm_locked_until_presync");
    expect(unlockedState.lifecycleState).toBe("unlocked");
  });

  it("keeps MM locked for one hour post-war when no posted sync exists", () => {
    const warEndMs = new Date("2026-03-09T07:00:00.000Z").getTime();
    const lockedState = derivePointsLockLifecycleStateForTest({
      runtime: buildRuntime({
        warState: "notInWar",
        matchType: "MM",
        lifecycle: null,
        activeWarEndMs: warEndMs,
        postedSyncAtMs: null,
      }),
      persisted: buildState({
        matchType: "MM",
        warEndMs,
        postedSyncAtMs: null,
      }),
      nowMs: warEndMs + 30 * 60 * 1000,
    });
    const unlockedState = derivePointsLockLifecycleStateForTest({
      runtime: buildRuntime({
        warState: "notInWar",
        matchType: "MM",
        lifecycle: null,
        activeWarEndMs: warEndMs,
        postedSyncAtMs: null,
      }),
      persisted: lockedState,
      nowMs: warEndMs + 61 * 60 * 1000,
    });

    expect(lockedState.lifecycleState).toBe("mm_locked_until_postwar_timeout");
    expect(unlockedState.lifecycleState).toBe("unlocked");
  });
});
