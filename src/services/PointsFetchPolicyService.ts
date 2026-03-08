type WarStateForPolicy = "notInWar" | "preparation" | "inWar";

export type PointsApiFetchReason =
  | "post_war_reconciliation"
  | "post_war_check"
  | "potential_admin_adjustment"
  | "pre_fwa_validation"
  | "manual_refresh"
  | "sync_data_reconcile"
  | "mail_preview"
  | "mail_refresh"
  | "match_render"
  | "points_command"
  | "war_event_projection";

export type PointsLifecycleState = {
  confirmedByClanMail: boolean;
  needsValidation: boolean;
  lastSuccessfulPointsApiFetchAt: Date | null;
  lastKnownSyncNumber: number | null;
};

type RoutinePointsFetchInput = {
  warState: WarStateForPolicy;
  warStartTime: Date | null;
  warEndTime: Date | null;
  currentSyncNumber: number | null;
  lifecycle: PointsLifecycleState | null;
  nowMs?: number;
};

type PointsFetchPolicyConfig = {
  optimizedPollingEnabled: boolean;
  postWarCheckWindowMs: number;
  postWarCheckIntervalMs: number;
  adminAdjustmentCheckIntervalMs: number;
  preFwaValidationWindowMs: number;
  preFwaValidationIntervalMs: number;
};

export type RoutinePointsFetchDecision = {
  shouldFetch: boolean;
  reason: PointsApiFetchReason | null;
  skipReason: string | null;
  optimized: boolean;
};

const DEFAULT_POLICY: PointsFetchPolicyConfig = {
  optimizedPollingEnabled: true,
  postWarCheckWindowMs: 4 * 60 * 60 * 1000,
  postWarCheckIntervalMs: 30 * 60 * 1000,
  adminAdjustmentCheckIntervalMs: 6 * 60 * 60 * 1000,
  preFwaValidationWindowMs: 90 * 60 * 1000,
  preFwaValidationIntervalMs: 20 * 60 * 1000,
};

/** Purpose: parse boolean-like env values with fallback support. */
function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/** Purpose: parse minute-based env values into bounded millisecond durations. */
function readMinutesEnv(name: string, fallbackMs: number): number {
  const raw = Number(String(process.env[name] ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return fallbackMs;
  const ms = Math.trunc(raw) * 60 * 1000;
  return Math.max(60 * 1000, ms);
}

/** Purpose: convert a Date to epoch milliseconds when valid. */
function toEpochMs(value: Date | null): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Purpose: build config from defaults + environment overrides. */
function resolveConfig(overrides?: Partial<PointsFetchPolicyConfig>): PointsFetchPolicyConfig {
  return {
    optimizedPollingEnabled: readBooleanEnv(
      "FWA_OPTIMIZED_POINTS_POLLING",
      overrides?.optimizedPollingEnabled ?? DEFAULT_POLICY.optimizedPollingEnabled
    ),
    postWarCheckWindowMs: readMinutesEnv(
      "FWA_POST_WAR_CHECK_WINDOW_MINUTES",
      overrides?.postWarCheckWindowMs ?? DEFAULT_POLICY.postWarCheckWindowMs
    ),
    postWarCheckIntervalMs: readMinutesEnv(
      "FWA_POST_WAR_CHECK_INTERVAL_MINUTES",
      overrides?.postWarCheckIntervalMs ?? DEFAULT_POLICY.postWarCheckIntervalMs
    ),
    adminAdjustmentCheckIntervalMs: readMinutesEnv(
      "FWA_ADMIN_ADJUSTMENT_CHECK_INTERVAL_MINUTES",
      overrides?.adminAdjustmentCheckIntervalMs ?? DEFAULT_POLICY.adminAdjustmentCheckIntervalMs
    ),
    preFwaValidationWindowMs: readMinutesEnv(
      "FWA_PRE_FWA_VALIDATION_WINDOW_MINUTES",
      overrides?.preFwaValidationWindowMs ?? DEFAULT_POLICY.preFwaValidationWindowMs
    ),
    preFwaValidationIntervalMs: readMinutesEnv(
      "FWA_PRE_FWA_VALIDATION_INTERVAL_MINUTES",
      overrides?.preFwaValidationIntervalMs ?? DEFAULT_POLICY.preFwaValidationIntervalMs
    ),
  };
}

export class PointsFetchPolicyService {
  private readonly config: PointsFetchPolicyConfig;

  /** Purpose: initialize policy config from env + optional overrides. */
  constructor(overrides?: Partial<PointsFetchPolicyConfig>) {
    this.config = resolveConfig(overrides);
  }

  /** Purpose: expose the effective policy config for diagnostics/tests. */
  getConfig(): PointsFetchPolicyConfig {
    return { ...this.config };
  }

  /** Purpose: decide if routine/background flows should fetch points right now. */
  shouldFetchForRoutine(input: RoutinePointsFetchInput): RoutinePointsFetchDecision {
    const nowMs = input.nowMs ?? Date.now();
    if (!this.config.optimizedPollingEnabled) {
      return {
        shouldFetch: true,
        reason: input.warState === "notInWar" ? "post_war_check" : "post_war_reconciliation",
        skipReason: null,
        optimized: false,
      };
    }

    const lifecycle = input.lifecycle;
    if (!lifecycle) {
      return {
        shouldFetch: true,
        reason: input.warState === "notInWar" ? "post_war_check" : "post_war_reconciliation",
        skipReason: null,
        optimized: true,
      };
    }

    if (lifecycle.needsValidation) {
      return {
        shouldFetch: true,
        reason:
          input.warState === "notInWar"
            ? "post_war_check"
            : input.warState === "preparation"
              ? "pre_fwa_validation"
              : "post_war_reconciliation",
        skipReason: null,
        optimized: true,
      };
    }

    if (!lifecycle.confirmedByClanMail) {
      return {
        shouldFetch: true,
        reason: input.warState === "notInWar" ? "post_war_check" : "post_war_reconciliation",
        skipReason: null,
        optimized: true,
      };
    }

    if (
      input.warState !== "notInWar" &&
      input.currentSyncNumber !== null &&
      lifecycle.lastKnownSyncNumber !== null &&
      Math.trunc(input.currentSyncNumber) !== Math.trunc(lifecycle.lastKnownSyncNumber)
    ) {
      return {
        shouldFetch: true,
        reason: "pre_fwa_validation",
        skipReason: null,
        optimized: true,
      };
    }

    const lastFetchMs = toEpochMs(lifecycle.lastSuccessfulPointsApiFetchAt);
    const warStartMs = toEpochMs(input.warStartTime);
    const warEndMs = toEpochMs(input.warEndTime);
    const staleForPreFwa =
      lastFetchMs === null || nowMs - lastFetchMs >= this.config.preFwaValidationIntervalMs;
    const staleForPostWar =
      lastFetchMs === null || nowMs - lastFetchMs >= this.config.postWarCheckIntervalMs;
    const staleForAdmin =
      lastFetchMs === null || nowMs - lastFetchMs >= this.config.adminAdjustmentCheckIntervalMs;

    if (
      input.warState === "preparation" &&
      warStartMs !== null &&
      warStartMs >= nowMs &&
      warStartMs - nowMs <= this.config.preFwaValidationWindowMs &&
      staleForPreFwa
    ) {
      return {
        shouldFetch: true,
        reason: "pre_fwa_validation",
        skipReason: null,
        optimized: true,
      };
    }

    if (
      input.warState === "notInWar" &&
      warEndMs !== null &&
      nowMs >= warEndMs &&
      nowMs - warEndMs <= this.config.postWarCheckWindowMs &&
      staleForPostWar
    ) {
      return {
        shouldFetch: true,
        reason: "post_war_check",
        skipReason: null,
        optimized: true,
      };
    }

    if (staleForAdmin) {
      return {
        shouldFetch: true,
        reason: "potential_admin_adjustment",
        skipReason: null,
        optimized: true,
      };
    }

    return {
      shouldFetch: false,
      reason: null,
      skipReason: "confirmed_by_clan_mail",
      optimized: true,
    };
  }
}
