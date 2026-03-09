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
  warId?: string | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
};

type RoutinePointsFetchInput = {
  warState: WarStateForPolicy;
  warStartTime: Date | null;
  warEndTime: Date | null;
  currentSyncNumber: number | null;
  lifecycle: PointsLifecycleState | null;
  nowMs?: number;
};

export type PollerPointsFetchSource = "war_event_poll_cycle" | "mail_refresh_loop";

export type PollerPointsFetchOutcome = "allowed" | "blocked" | "not_applicable";

export type PollerPointsFetchDecisionCode =
  | "manual_override"
  | "optimized_polling_disabled"
  | "no_active_opponent"
  | "inactive_war_for_mail_refresh"
  | "validation_required"
  | "sync_number_changed"
  | "war_identity_changed"
  | "war_identity_unverifiable"
  | "locked_mail_confirmed"
  | "policy_allowed"
  | "policy_blocked";

export type PollerPointsFetchDecision = {
  allowed: boolean;
  outcome: PollerPointsFetchOutcome;
  decisionCode: PollerPointsFetchDecisionCode;
  reason: string;
  fetchReason: PointsApiFetchReason | null;
  policyReason: PointsApiFetchReason | null;
  mailConfirmedLockActive: boolean;
  optimized: boolean;
};

export type PollerPointsFetchInput = RoutinePointsFetchInput & {
  guildId: string;
  clanTag: string;
  pollerSource: PollerPointsFetchSource;
  requestedReason: PointsApiFetchReason;
  preferredAllowedReason?: PointsApiFetchReason | null;
  activeOpponentTag?: string | null;
  activeWarId?: string | number | null;
  manualOverride?: boolean;
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

/** Purpose: normalize clan tags for stable policy comparisons. */
function normalizeTag(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  return raw ? `#${raw}` : null;
}

/** Purpose: normalize optional war IDs for stable policy comparisons. */
function normalizeWarId(input: string | number | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  return raw ? raw : null;
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
  private static readonly pollerDecisionRollups = new Map<string, number>();
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
    return this.evaluateRoutineDecision(input);
  }

  /** Purpose: decide poller-side points fetch behavior with explicit lock/identity semantics and audit metadata. */
  evaluatePollerFetch(input: PollerPointsFetchInput): PollerPointsFetchDecision {
    const nowMs = input.nowMs ?? Date.now();
    const lifecycle = input.lifecycle;
    const activeWar = input.warState !== "notInWar";
    const activeOpponentTag = normalizeTag(input.activeOpponentTag);
    const lifecycleOpponentTag = normalizeTag(lifecycle?.opponentTag ?? null);
    const activeWarId = normalizeWarId(input.activeWarId);
    const lifecycleWarId = normalizeWarId(lifecycle?.warId ?? null);
    const activeWarStartMs = toEpochMs(input.warStartTime);
    const lifecycleWarStartMs = toEpochMs(lifecycle?.warStartTime ?? null);
    const hasIdentitySignals =
      (activeWarId !== null && lifecycleWarId !== null) ||
      (activeOpponentTag !== null && lifecycleOpponentTag !== null) ||
      (activeWarStartMs !== null && lifecycleWarStartMs !== null);
    const identityChanged =
      (activeWarId !== null && lifecycleWarId !== null && activeWarId !== lifecycleWarId) ||
      (activeOpponentTag !== null &&
        lifecycleOpponentTag !== null &&
        activeOpponentTag !== lifecycleOpponentTag) ||
      (activeWarStartMs !== null &&
        lifecycleWarStartMs !== null &&
        activeWarStartMs !== lifecycleWarStartMs);

    if (input.manualOverride) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "manual_override",
        reason: "Manual override bypasses routine poller lock checks.",
        fetchReason: input.preferredAllowedReason ?? input.requestedReason,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: this.config.optimizedPollingEnabled,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (!this.config.optimizedPollingEnabled) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "optimized_polling_disabled",
        reason: "Optimized polling disabled; routine poller fetches are allowed.",
        fetchReason: input.preferredAllowedReason ?? input.requestedReason,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: false,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (input.requestedReason === "mail_refresh" && !activeWar) {
      const decision = this.buildPollerDecision({
        allowed: false,
        outcome: "not_applicable",
        decisionCode: "inactive_war_for_mail_refresh",
        reason: "Mail refresh points fetch applies only to active wars.",
        fetchReason: null,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (activeWar && activeOpponentTag === null) {
      const decision = this.buildPollerDecision({
        allowed: false,
        outcome: "not_applicable",
        decisionCode: "no_active_opponent",
        reason: "Active war has no resolved opponent tag.",
        fetchReason: null,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (
      activeWar &&
      lifecycle &&
      lifecycle.lastKnownSyncNumber !== null &&
      input.currentSyncNumber !== null &&
      Math.trunc(lifecycle.lastKnownSyncNumber) !== Math.trunc(input.currentSyncNumber)
    ) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "sync_number_changed",
        reason: "Active sync number changed since last checkpoint; revalidation is required.",
        fetchReason: input.preferredAllowedReason ?? "pre_fwa_validation",
        policyReason: "pre_fwa_validation",
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (activeWar && lifecycle?.needsValidation) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "validation_required",
        reason: "Lifecycle requires validation; routine fetch is re-enabled.",
        fetchReason:
          input.preferredAllowedReason ??
          (input.warState === "preparation" ? "pre_fwa_validation" : input.requestedReason),
        policyReason: input.warState === "preparation" ? "pre_fwa_validation" : null,
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    const lockCandidate =
      activeWar &&
      Boolean(lifecycle?.confirmedByClanMail) &&
      !Boolean(lifecycle?.needsValidation);
    if (lockCandidate && identityChanged) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "war_identity_changed",
        reason: "War identity changed since mail confirmation; routine fetch is re-enabled.",
        fetchReason: input.preferredAllowedReason ?? input.requestedReason,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (lockCandidate && !hasIdentitySignals) {
      const decision = this.buildPollerDecision({
        allowed: true,
        outcome: "allowed",
        decisionCode: "war_identity_unverifiable",
        reason: "War identity could not be verified; lock is not enforced conservatively.",
        fetchReason: input.preferredAllowedReason ?? input.requestedReason,
        policyReason: null,
        mailConfirmedLockActive: false,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    if (lockCandidate) {
      const decision = this.buildPollerDecision({
        allowed: false,
        outcome: "blocked",
        decisionCode: "locked_mail_confirmed",
        reason:
          "Active war mail-confirmed lock is active; routine poller points fetch is suppressed.",
        fetchReason: null,
        policyReason: null,
        mailConfirmedLockActive: true,
        optimized: true,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    const policyDecision = this.evaluateRoutineDecision({
      ...input,
      nowMs,
    });
    if (!policyDecision.shouldFetch) {
      const decision = this.buildPollerDecision({
        allowed: false,
        outcome: "blocked",
        decisionCode: "policy_blocked",
        reason: policyDecision.skipReason ?? "Routine policy did not trigger a fetch.",
        fetchReason: null,
        policyReason: policyDecision.reason,
        mailConfirmedLockActive: false,
        optimized: policyDecision.optimized,
      });
      this.logPollerDecision(input, decision);
      return decision;
    }

    const decision = this.buildPollerDecision({
      allowed: true,
      outcome: "allowed",
      decisionCode: "policy_allowed",
      reason: "Routine policy trigger allowed poller points fetch.",
      fetchReason: input.preferredAllowedReason ?? policyDecision.reason ?? input.requestedReason,
      policyReason: policyDecision.reason,
      mailConfirmedLockActive: false,
      optimized: policyDecision.optimized,
    });
    this.logPollerDecision(input, decision);
    return decision;
  }

  /** Purpose: build a normalized poller decision payload. */
  private buildPollerDecision(input: PollerPointsFetchDecision): PollerPointsFetchDecision {
    return {
      ...input,
      allowed: Boolean(input.allowed),
    };
  }

  /** Purpose: emit standardized decision logs and in-memory rollups for poller points gate behavior. */
  private logPollerDecision(
    input: PollerPointsFetchInput,
    decision: PollerPointsFetchDecision
  ): void {
    const normalizedClanTag = normalizeTag(input.clanTag) ?? input.clanTag;
    const rollupKey = `${input.pollerSource}:${input.requestedReason}:${decision.outcome}`;
    const nextCount = (PointsFetchPolicyService.pollerDecisionRollups.get(rollupKey) ?? 0) + 1;
    PointsFetchPolicyService.pollerDecisionRollups.set(rollupKey, nextCount);
    const activeWarStartMs = toEpochMs(input.warStartTime);
    const lifecycleWarStartMs = toEpochMs(input.lifecycle?.warStartTime ?? null);
    console.info(
      `[points-gate] source=${input.pollerSource} guild=${input.guildId} clan=${normalizedClanTag} requested_reason=${input.requestedReason} outcome=${decision.outcome} code=${decision.decisionCode} allowed=${decision.allowed ? 1 : 0} lock_active=${decision.mailConfirmedLockActive ? 1 : 0} active_war=${input.warState !== "notInWar" ? 1 : 0} fetch_reason=${decision.fetchReason ?? "none"} active_war_id=${normalizeWarId(input.activeWarId) ?? "none"} active_war_start_ms=${activeWarStartMs ?? "none"} active_opponent=${normalizeTag(input.activeOpponentTag) ?? "none"} lifecycle_war_id=${normalizeWarId(input.lifecycle?.warId ?? null) ?? "none"} lifecycle_war_start_ms=${lifecycleWarStartMs ?? "none"} lifecycle_opponent=${normalizeTag(input.lifecycle?.opponentTag ?? null) ?? "none"} rollup=${nextCount} reason=${decision.reason}`
    );
  }

  /** Purpose: evaluate base routine triggers independent of poller identity-lock semantics. */
  private evaluateRoutineDecision(input: RoutinePointsFetchInput): RoutinePointsFetchDecision {
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
