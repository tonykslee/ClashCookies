import { WarMailLifecycleStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { SettingsService } from "./SettingsService";
import type { PointsApiFetchReason, PointsLifecycleState } from "./PointsFetchPolicyService";

type WarStateForPolicy = "notInWar" | "preparation" | "inWar";

type MatchTypeForPolicy = "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN";

export type PointsLockLifecycleState =
  | "unlocked"
  | "active_war_locked"
  | "post_war_unlocked_waiting_for_point_change"
  | "between_wars_locked_until_presync"
  | "mm_locked_until_presync"
  | "mm_locked_until_postwar_timeout";

export type PointsDirectFetchCaller = "command" | "poller" | "service";

export type PointsDirectFetchDecisionCode =
  | "manual_force_bypass"
  | "reused_war_snapshot"
  | "not_tracked"
  | "locked_active_war"
  | "locked_between_wars_until_presync"
  | "locked_mm_until_presync"
  | "locked_mm_postwar_timeout"
  | "allowed_non_mm_postwar_window"
  | "allowed_unlocked";

export type PointsDirectFetchDecisionOutcome = "allowed" | "blocked" | "not_applicable";

export type PointsLockStateRecord = {
  lifecycleState: PointsLockLifecycleState;
  clanTag: string;
  guildId: string | null;
  warId: string | null;
  warStartMs: number | null;
  warEndMs: number | null;
  matchType: MatchTypeForPolicy | null;
  baselinePoints: number | null;
  pointValueChangedAtMs: number | null;
  postedSyncAtMs: number | null;
  lockUntilMs: number | null;
  updatedAtMs: number;
};

type PointsLockRuntimeSnapshot = {
  tracked: boolean;
  clanTag: string;
  guildId: string | null;
  warState: WarStateForPolicy;
  matchType: MatchTypeForPolicy | null;
  activeWarId: string | null;
  activeWarStartMs: number | null;
  activeWarEndMs: number | null;
  activeOpponentTag: string | null;
  mailLifecycleStatus: WarMailLifecycleStatus | null;
  lifecycle: PointsLifecycleState | null;
  latestKnownPoints: number | null;
  postedSyncAtMs: number | null;
  hasReusableWarSnapshot: boolean;
};

export type EvaluatePointsDirectFetchInput = {
  clanTag: string;
  fetchReason: PointsApiFetchReason;
  caller: PointsDirectFetchCaller;
  manualForceBypass?: boolean;
  nowMs?: number;
};

export type PointsDirectFetchDecision = {
  allowed: boolean;
  outcome: PointsDirectFetchDecisionOutcome;
  decisionCode: PointsDirectFetchDecisionCode;
  reason: string;
  clanTag: string;
  guildId: string | null;
  fetchReason: PointsApiFetchReason;
  caller: PointsDirectFetchCaller;
  lockState: PointsLockLifecycleState;
  lockUntilMs: number | null;
  postedSyncAtMs: number | null;
  manualForceBypass: boolean;
};

type ApplyObservedPointValueInput = {
  state: PointsLockStateRecord;
  observedPoints: number | null;
  nowMs: number;
};

const PRESYNC_UNLOCK_OFFSET_MS = 10 * 60 * 1000;
const MM_POSTWAR_UNLOCK_DELAY_MS = 60 * 60 * 1000;
const ACTIVE_SYNC_POST_KEY_PREFIX = "active_sync_post:";
const LOCK_STATE_KEY_PREFIX = "points_lock_state:";

/** Purpose: normalize clan tag into canonical #TAG form. */
function normalizeTag(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  return raw ? `#${raw}` : null;
}

/** Purpose: normalize optional war IDs for deterministic comparisons. */
function normalizeWarId(input: string | number | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  return raw ? raw : null;
}

/** Purpose: normalize optional timestamps into epoch milliseconds. */
function toEpochMs(input: Date | null | undefined): number | null {
  if (!(input instanceof Date)) return null;
  const ms = input.getTime();
  return Number.isFinite(ms) ? Math.trunc(ms) : null;
}

/** Purpose: normalize optional integer values for lock-state checkpoints. */
function toOptionalInt(input: number | null | undefined): number | null {
  if (input === null || input === undefined || !Number.isFinite(input)) return null;
  return Math.trunc(input);
}

/** Purpose: normalize match type labels for lifecycle rules. */
function normalizeMatchType(input: string | null | undefined): MatchTypeForPolicy | null {
  const raw = String(input ?? "").trim().toUpperCase();
  if (raw === "FWA" || raw === "BL" || raw === "MM" || raw === "SKIP" || raw === "UNKNOWN") {
    return raw;
  }
  return null;
}

/** Purpose: map raw war-state values into policy states. */
function deriveWarState(input: string | null | undefined): WarStateForPolicy {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "preparation") return "preparation";
  if (value === "inwar" || value === "in_war") return "inWar";
  return "notInWar";
}

/** Purpose: choose the best known points value for lifecycle baselines. */
function resolveLatestKnownPoints(input: {
  lifecycle: PointsLifecycleState | null;
  syncRowPoints: number | null;
  currentWarPoints: number | null;
  previousBaseline: number | null;
}): number | null {
  return (
    toOptionalInt(input.lifecycle?.lastKnownPoints ?? null) ??
    toOptionalInt(input.syncRowPoints) ??
    toOptionalInt(input.currentWarPoints) ??
    toOptionalInt(input.previousBaseline)
  );
}

/** Purpose: determine whether active-war mail-confirmed lock should be applied. */
function hasActiveWarMailLock(runtime: PointsLockRuntimeSnapshot): boolean {
  if (runtime.warState === "notInWar") return false;
  if (runtime.mailLifecycleStatus !== WarMailLifecycleStatus.POSTED) return false;
  if (!runtime.lifecycle) return false;
  if (runtime.lifecycle.needsValidation) return false;
  return true;
}

/** Purpose: build a baseline unlocked lock-state record from runtime context. */
function buildDefaultLockState(
  runtime: PointsLockRuntimeSnapshot,
  nowMs: number
): PointsLockStateRecord {
  return {
    lifecycleState: "unlocked",
    clanTag: runtime.clanTag,
    guildId: runtime.guildId,
    warId: normalizeWarId(runtime.activeWarId),
    warStartMs: toOptionalInt(runtime.activeWarStartMs),
    warEndMs: toOptionalInt(runtime.activeWarEndMs),
    matchType: runtime.matchType ?? null,
    baselinePoints: resolveLatestKnownPoints({
      lifecycle: runtime.lifecycle,
      syncRowPoints: null,
      currentWarPoints: null,
      previousBaseline: null,
    }),
    pointValueChangedAtMs: null,
    postedSyncAtMs: toOptionalInt(runtime.postedSyncAtMs),
    lockUntilMs: null,
    updatedAtMs: nowMs,
  };
}

/** Purpose: derive lock lifecycle state deterministically from runtime + persisted context. */
export function derivePointsLockLifecycleStateForTest(input: {
  runtime: PointsLockRuntimeSnapshot;
  persisted: PointsLockStateRecord | null;
  nowMs: number;
}): PointsLockStateRecord {
  const runtime = input.runtime;
  const nowMs = input.nowMs;
  const prior = input.persisted ?? buildDefaultLockState(runtime, nowMs);
  const postedSyncAtMs = toOptionalInt(runtime.postedSyncAtMs ?? prior.postedSyncAtMs);
  const presyncUnlockAtMs =
    postedSyncAtMs !== null ? Math.max(0, postedSyncAtMs - PRESYNC_UNLOCK_OFFSET_MS) : null;
  const matchType = normalizeMatchType(runtime.matchType ?? prior.matchType ?? null);
  const latestKnownPoints = resolveLatestKnownPoints({
    lifecycle: runtime.lifecycle,
    syncRowPoints: toOptionalInt(runtime.lifecycle?.lastKnownPoints ?? null),
    currentWarPoints: null,
    previousBaseline: prior.baselinePoints,
  });
  const warEndMs = toOptionalInt(runtime.activeWarEndMs ?? prior.warEndMs);

  if (hasActiveWarMailLock(runtime)) {
    return {
      ...prior,
      lifecycleState: "active_war_locked",
      clanTag: runtime.clanTag,
      guildId: runtime.guildId,
      warId: normalizeWarId(runtime.activeWarId),
      warStartMs: toOptionalInt(runtime.activeWarStartMs),
      warEndMs,
      matchType,
      baselinePoints: latestKnownPoints,
      pointValueChangedAtMs: null,
      postedSyncAtMs,
      lockUntilMs: null,
      updatedAtMs: nowMs,
    };
  }

  if (runtime.warState !== "notInWar") {
    return {
      ...prior,
      lifecycleState: "unlocked",
      clanTag: runtime.clanTag,
      guildId: runtime.guildId,
      warId: normalizeWarId(runtime.activeWarId),
      warStartMs: toOptionalInt(runtime.activeWarStartMs),
      warEndMs,
      matchType,
      baselinePoints: latestKnownPoints,
      postedSyncAtMs,
      lockUntilMs: null,
      updatedAtMs: nowMs,
    };
  }

  if (matchType === "MM") {
    if (presyncUnlockAtMs !== null) {
      if (nowMs < presyncUnlockAtMs) {
        return {
          ...prior,
          lifecycleState: "mm_locked_until_presync",
          clanTag: runtime.clanTag,
          guildId: runtime.guildId,
          matchType,
          baselinePoints: latestKnownPoints,
          postedSyncAtMs,
          lockUntilMs: presyncUnlockAtMs,
          updatedAtMs: nowMs,
        };
      }
      return {
        ...prior,
        lifecycleState: "unlocked",
        clanTag: runtime.clanTag,
        guildId: runtime.guildId,
        matchType,
        baselinePoints: latestKnownPoints,
        postedSyncAtMs,
        lockUntilMs: null,
        updatedAtMs: nowMs,
      };
    }

    if (warEndMs !== null) {
      const mmUnlockAtMs = warEndMs + MM_POSTWAR_UNLOCK_DELAY_MS;
      if (nowMs < mmUnlockAtMs) {
        return {
          ...prior,
          lifecycleState: "mm_locked_until_postwar_timeout",
          clanTag: runtime.clanTag,
          guildId: runtime.guildId,
          matchType,
          baselinePoints: latestKnownPoints,
          postedSyncAtMs,
          lockUntilMs: mmUnlockAtMs,
          updatedAtMs: nowMs,
        };
      }
    }

    return {
      ...prior,
      lifecycleState: "unlocked",
      clanTag: runtime.clanTag,
      guildId: runtime.guildId,
      matchType,
      baselinePoints: latestKnownPoints,
      postedSyncAtMs,
      lockUntilMs: null,
      updatedAtMs: nowMs,
    };
  }

  if (prior.lifecycleState === "between_wars_locked_until_presync") {
    if (presyncUnlockAtMs !== null && nowMs < presyncUnlockAtMs) {
      return {
        ...prior,
        clanTag: runtime.clanTag,
        guildId: runtime.guildId,
        matchType,
        baselinePoints: latestKnownPoints,
        postedSyncAtMs,
        lockUntilMs: presyncUnlockAtMs,
        updatedAtMs: nowMs,
      };
    }
    return {
      ...prior,
      lifecycleState: "unlocked",
      clanTag: runtime.clanTag,
      guildId: runtime.guildId,
      matchType,
      baselinePoints: latestKnownPoints,
      postedSyncAtMs,
      lockUntilMs: null,
      updatedAtMs: nowMs,
    };
  }

  const hasWarEndSignal =
    warEndMs !== null ||
    prior.lifecycleState === "active_war_locked" ||
    prior.lifecycleState === "post_war_unlocked_waiting_for_point_change";
  if (hasWarEndSignal && latestKnownPoints !== null) {
    return {
      ...prior,
      lifecycleState: "post_war_unlocked_waiting_for_point_change",
      clanTag: runtime.clanTag,
      guildId: runtime.guildId,
      matchType,
      baselinePoints: latestKnownPoints,
      postedSyncAtMs,
      lockUntilMs: null,
      updatedAtMs: nowMs,
    };
  }

  return {
    ...prior,
    lifecycleState: "unlocked",
    clanTag: runtime.clanTag,
    guildId: runtime.guildId,
    matchType,
    baselinePoints: latestKnownPoints,
    postedSyncAtMs,
    lockUntilMs: null,
    updatedAtMs: nowMs,
  };
}

/** Purpose: transition non-MM between-war state after observing a changed website point value. */
export function applyObservedPointValueTransitionForTest(
  input: ApplyObservedPointValueInput
): PointsLockStateRecord {
  const state = input.state;
  if (state.lifecycleState !== "post_war_unlocked_waiting_for_point_change") return state;
  if (state.matchType === "MM") return state;

  const observedPoints = toOptionalInt(input.observedPoints);
  const baselinePoints = toOptionalInt(state.baselinePoints);
  if (observedPoints === null || baselinePoints === null) return state;
  if (observedPoints === baselinePoints) return state;

  const presyncUnlockAtMs =
    state.postedSyncAtMs !== null
      ? Math.max(0, state.postedSyncAtMs - PRESYNC_UNLOCK_OFFSET_MS)
      : null;
  if (presyncUnlockAtMs !== null && input.nowMs < presyncUnlockAtMs) {
    return {
      ...state,
      lifecycleState: "between_wars_locked_until_presync",
      baselinePoints: observedPoints,
      pointValueChangedAtMs: input.nowMs,
      lockUntilMs: presyncUnlockAtMs,
      updatedAtMs: input.nowMs,
    };
  }

  return {
    ...state,
    lifecycleState: "unlocked",
    baselinePoints: observedPoints,
    pointValueChangedAtMs: input.nowMs,
    lockUntilMs: null,
    updatedAtMs: input.nowMs,
  };
}

/** Purpose: compare two lock-state records while ignoring harmless timestamp jitter. */
function isSameLockState(a: PointsLockStateRecord | null, b: PointsLockStateRecord): boolean {
  if (!a) return false;
  return (
    a.lifecycleState === b.lifecycleState &&
    a.clanTag === b.clanTag &&
    a.guildId === b.guildId &&
    a.warId === b.warId &&
    a.warStartMs === b.warStartMs &&
    a.warEndMs === b.warEndMs &&
    a.matchType === b.matchType &&
    a.baselinePoints === b.baselinePoints &&
    a.pointValueChangedAtMs === b.pointValueChangedAtMs &&
    a.postedSyncAtMs === b.postedSyncAtMs &&
    a.lockUntilMs === b.lockUntilMs
  );
}

/** Purpose: construct a lock-state storage key by normalized clan tag. */
function buildLockStateKey(clanTag: string): string {
  const bare = String(normalizeTag(clanTag) ?? "").replace(/^#/, "");
  return `${LOCK_STATE_KEY_PREFIX}${bare}`;
}

/** Purpose: construct active sync-post lookup key for a guild. */
function buildActiveSyncPostKey(guildId: string): string {
  return `${ACTIVE_SYNC_POST_KEY_PREFIX}${guildId}`;
}

/** Purpose: parse persisted active-sync metadata and extract epoch milliseconds when available. */
function parsePostedSyncAtMs(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { epochSeconds?: unknown };
    const epochSeconds =
      typeof parsed.epochSeconds === "number" && Number.isFinite(parsed.epochSeconds)
        ? Math.trunc(parsed.epochSeconds)
        : null;
    if (epochSeconds === null || epochSeconds <= 0) return null;
    return epochSeconds * 1000;
  } catch {
    return null;
  }
}

/** Purpose: parse persisted lock-state JSON safely and return null on malformed blobs. */
function parseLockState(raw: string | null): PointsLockStateRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PointsLockStateRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const lifecycleState = String(parsed.lifecycleState ?? "");
    if (
      lifecycleState !== "unlocked" &&
      lifecycleState !== "active_war_locked" &&
      lifecycleState !== "post_war_unlocked_waiting_for_point_change" &&
      lifecycleState !== "between_wars_locked_until_presync" &&
      lifecycleState !== "mm_locked_until_presync" &&
      lifecycleState !== "mm_locked_until_postwar_timeout"
    ) {
      return null;
    }
    const clanTag = normalizeTag(parsed.clanTag ?? null);
    if (!clanTag) return null;
    return {
      lifecycleState,
      clanTag,
      guildId: typeof parsed.guildId === "string" && parsed.guildId.trim() ? parsed.guildId : null,
      warId: normalizeWarId(parsed.warId ?? null),
      warStartMs: toOptionalInt(parsed.warStartMs ?? null),
      warEndMs: toOptionalInt(parsed.warEndMs ?? null),
      matchType: normalizeMatchType(parsed.matchType ?? null),
      baselinePoints: toOptionalInt(parsed.baselinePoints ?? null),
      pointValueChangedAtMs: toOptionalInt(parsed.pointValueChangedAtMs ?? null),
      postedSyncAtMs: toOptionalInt(parsed.postedSyncAtMs ?? null),
      lockUntilMs: toOptionalInt(parsed.lockUntilMs ?? null),
      updatedAtMs: toOptionalInt(parsed.updatedAtMs ?? Date.now()) ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/** Purpose: create direct-fetch decision metadata from the effective lock state and caller context. */
function buildDecisionFromState(input: {
  runtime: PointsLockRuntimeSnapshot;
  state: PointsLockStateRecord;
  caller: PointsDirectFetchCaller;
  fetchReason: PointsApiFetchReason;
  manualForceBypass: boolean;
}): PointsDirectFetchDecision {
  if (input.manualForceBypass) {
    return {
      allowed: true,
      outcome: "allowed",
      decisionCode: "manual_force_bypass",
      reason: "Manual force-sync bypass is explicitly allowed during lock windows.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: true,
    };
  }

  if (input.runtime.hasReusableWarSnapshot) {
    return {
      allowed: false,
      outcome: "blocked",
      decisionCode: "reused_war_snapshot",
      reason: "Current-war snapshot already exists; reuse persisted sync data instead of direct fetch.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (!input.runtime.tracked) {
    return {
      allowed: true,
      outcome: "not_applicable",
      decisionCode: "not_tracked",
      reason: "Clan is not tracked; lock policy does not apply.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (input.state.lifecycleState === "active_war_locked") {
    return {
      allowed: false,
      outcome: "blocked",
      decisionCode: "locked_active_war",
      reason: "Active-war points lock is authoritative; direct points fetch is blocked.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (input.state.lifecycleState === "between_wars_locked_until_presync") {
    return {
      allowed: false,
      outcome: "blocked",
      decisionCode: "locked_between_wars_until_presync",
      reason: "Between-wars lock is active until the pre-sync unlock window.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (input.state.lifecycleState === "mm_locked_until_presync") {
    return {
      allowed: false,
      outcome: "blocked",
      decisionCode: "locked_mm_until_presync",
      reason: "MM between-wars lock is active until pre-sync unlock.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (input.state.lifecycleState === "mm_locked_until_postwar_timeout") {
    return {
      allowed: false,
      outcome: "blocked",
      decisionCode: "locked_mm_postwar_timeout",
      reason: "MM between-wars lock is active until the 1-hour post-war timeout.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  if (input.state.lifecycleState === "post_war_unlocked_waiting_for_point_change") {
    return {
      allowed: true,
      outcome: "allowed",
      decisionCode: "allowed_non_mm_postwar_window",
      reason: "Non-MM post-war unlock window is open until website points change.",
      clanTag: input.runtime.clanTag,
      guildId: input.runtime.guildId,
      fetchReason: input.fetchReason,
      caller: input.caller,
      lockState: input.state.lifecycleState,
      lockUntilMs: input.state.lockUntilMs,
      postedSyncAtMs: input.state.postedSyncAtMs,
      manualForceBypass: false,
    };
  }

  return {
    allowed: true,
    outcome: "allowed",
    decisionCode: "allowed_unlocked",
    reason: "No active lock window; direct points fetch is allowed.",
    clanTag: input.runtime.clanTag,
    guildId: input.runtime.guildId,
    fetchReason: input.fetchReason,
    caller: input.caller,
    lockState: input.state.lifecycleState,
    lockUntilMs: input.state.lockUntilMs,
    postedSyncAtMs: input.state.postedSyncAtMs,
    manualForceBypass: false,
  };
}

/** Purpose: expose deterministic decision mapping for unit tests without database dependencies. */
export function buildPointsDirectFetchDecisionForTest(input: {
  runtime: PointsLockRuntimeSnapshot;
  state: PointsLockStateRecord;
  caller: PointsDirectFetchCaller;
  fetchReason: PointsApiFetchReason;
  manualForceBypass: boolean;
}): PointsDirectFetchDecision {
  return buildDecisionFromState(input);
}

export class PointsDirectFetchBlockedError extends Error {
  readonly decision: PointsDirectFetchDecision;

  /** Purpose: surface deterministic lock decisions to callsites that attempted direct fetches. */
  constructor(decision: PointsDirectFetchDecision) {
    super(`Direct points fetch blocked by lock policy (${decision.decisionCode}).`);
    this.name = "PointsDirectFetchBlockedError";
    this.decision = decision;
  }
}

/** Purpose: narrow unknown thrown values into lock-block errors. */
export function isPointsDirectFetchBlockedError(
  err: unknown
): err is PointsDirectFetchBlockedError {
  return err instanceof PointsDirectFetchBlockedError;
}

export class PointsDirectFetchGateService {
  private static readonly decisionRollups = new Map<string, number>();

  /** Purpose: initialize lock gate persistence dependencies. */
  constructor(private readonly settings: SettingsService = new SettingsService()) {}

  /** Purpose: evaluate whether a direct points fetch is allowed and persist lock-state transitions. */
  async evaluateFetchAccess(input: EvaluatePointsDirectFetchInput): Promise<PointsDirectFetchDecision> {
    const nowMs = toOptionalInt(input.nowMs ?? Date.now()) ?? Date.now();
    const normalizedTag = normalizeTag(input.clanTag);
    if (!normalizedTag) {
      return {
        allowed: true,
        outcome: "not_applicable",
        decisionCode: "not_tracked",
        reason: "Invalid clan tag; lock policy is not applicable.",
        clanTag: String(input.clanTag ?? ""),
        guildId: null,
        fetchReason: input.fetchReason,
        caller: input.caller,
        lockState: "unlocked",
        lockUntilMs: null,
        postedSyncAtMs: null,
        manualForceBypass: Boolean(input.manualForceBypass),
      };
    }

    const [runtime, persisted] = await Promise.all([
      this.loadRuntimeSnapshot(normalizedTag),
      this.readPersistedState(normalizedTag),
    ]);
    const state = derivePointsLockLifecycleStateForTest({
      runtime,
      persisted,
      nowMs,
    });
    if (runtime.tracked && !isSameLockState(persisted, state)) {
      await this.writePersistedState(state);
    }

    const decision = buildDecisionFromState({
      runtime,
      state,
      caller: input.caller,
      fetchReason: input.fetchReason,
      manualForceBypass: Boolean(input.manualForceBypass),
    });
    this.logDecision(decision);
    return decision;
  }

  /** Purpose: update between-war lock state after observing a fresh website point value. */
  async recordObservedPointValue(params: {
    clanTag: string;
    observedPoints: number | null;
    nowMs?: number;
  }): Promise<void> {
    const normalizedTag = normalizeTag(params.clanTag);
    if (!normalizedTag) return;
    const nowMs = toOptionalInt(params.nowMs ?? Date.now()) ?? Date.now();
    const persisted = await this.readPersistedState(normalizedTag);
    if (!persisted) return;

    const next = applyObservedPointValueTransitionForTest({
      state: persisted,
      observedPoints: params.observedPoints,
      nowMs,
    });
    if (isSameLockState(persisted, next)) return;
    await this.writePersistedState(next);
    console.info(
      `[points-lock] transition clan=${normalizedTag} from=${persisted.lifecycleState} to=${next.lifecycleState} observed_points=${toOptionalInt(
        params.observedPoints
      ) ?? "none"} baseline=${next.baselinePoints ?? "none"} lock_until_ms=${next.lockUntilMs ?? "none"} changed_at_ms=${next.pointValueChangedAtMs ?? "none"}`
    );
  }

  /** Purpose: load runtime policy inputs from authoritative tracked/current/sync state. */
  private async loadRuntimeSnapshot(clanTag: string): Promise<PointsLockRuntimeSnapshot> {
    const normalizedTag = normalizeTag(clanTag) ?? clanTag;
    const [tracked, currentWar] = await Promise.all([
      prisma.trackedClan.findUnique({
        where: { tag: normalizedTag },
        select: { tag: true },
      }),
      prisma.currentWar.findFirst({
        where: { clanTag: normalizedTag },
        orderBy: { updatedAt: "desc" },
        select: {
          guildId: true,
          warId: true,
          state: true,
          startTime: true,
          endTime: true,
          opponentTag: true,
          matchType: true,
          fwaPoints: true,
        },
      }),
    ]);

    const guildId = currentWar?.guildId ?? null;
    const warId = normalizeWarId(
      currentWar?.warId !== null && currentWar?.warId !== undefined
        ? String(Math.trunc(currentWar.warId))
        : null
    );
    const warStartTime = currentWar?.startTime ?? null;
    const syncWhereOr = [
      ...(warId ? [{ warId }] : []),
      ...(warStartTime ? [{ warStartTime }] : []),
    ];
    const syncRow =
      guildId !== null
        ? await prisma.clanPointsSync.findFirst({
            where: {
              guildId,
              clanTag: normalizedTag,
              ...(syncWhereOr.length > 0 ? { OR: syncWhereOr } : {}),
            },
            orderBy: [
              { syncFetchedAt: "desc" },
              { lastSuccessfulPointsApiFetchAt: "desc" },
              { updatedAt: "desc" },
            ],
          })
        : null;
    const hasReusableWarSnapshot = Boolean(
      syncRow &&
        syncRow.needsValidation === false &&
        Number.isFinite(syncRow.clanPoints) &&
        Number.isFinite(syncRow.opponentPoints) &&
        (warId !== null || warStartTime !== null)
    );
    const mailLifecycleRow =
      guildId !== null && warId !== null
        ? await prisma.warMailLifecycle.findUnique({
            where: {
              guildId_clanTag_warId: {
                guildId,
                clanTag: normalizedTag,
                warId: Number(warId),
              },
            },
            select: { status: true },
          })
        : null;
    const latestSync =
      syncRow ??
      (await prisma.clanPointsSync.findFirst({
        where: { clanTag: normalizedTag },
        orderBy: [
          { warStartTime: "desc" },
          { syncFetchedAt: "desc" },
          { updatedAt: "desc" },
        ],
      }));
    const postedSyncAtMs =
      guildId !== null
        ? parsePostedSyncAtMs(await this.settings.get(buildActiveSyncPostKey(guildId)))
        : null;
    const lifecycle =
      latestSync === null
        ? null
        : ({
            confirmedByClanMail: Boolean(latestSync.confirmedByClanMail),
            needsValidation: Boolean(latestSync.needsValidation),
            lastSuccessfulPointsApiFetchAt: latestSync.lastSuccessfulPointsApiFetchAt ?? null,
            lastKnownSyncNumber:
              latestSync.lastKnownSyncNumber !== null &&
              latestSync.lastKnownSyncNumber !== undefined &&
              Number.isFinite(latestSync.lastKnownSyncNumber)
                ? Math.trunc(latestSync.lastKnownSyncNumber)
                : null,
            lastKnownPoints:
              latestSync.lastKnownPoints !== null &&
              latestSync.lastKnownPoints !== undefined &&
              Number.isFinite(latestSync.lastKnownPoints)
                ? Math.trunc(latestSync.lastKnownPoints)
                : null,
            warId: latestSync.warId ?? null,
            opponentTag: latestSync.opponentTag ?? null,
            warStartTime: latestSync.warStartTime ?? null,
          } as PointsLifecycleState);

    return {
      tracked: Boolean(tracked),
      clanTag: normalizedTag,
      guildId,
      warState: deriveWarState(currentWar?.state ?? null),
      matchType: normalizeMatchType(currentWar?.matchType ?? latestSync?.lastKnownMatchType ?? null),
      activeWarId: warId,
      activeWarStartMs: toEpochMs(currentWar?.startTime ?? null),
      activeWarEndMs: toEpochMs(currentWar?.endTime ?? null),
      activeOpponentTag: normalizeTag(currentWar?.opponentTag ?? null),
      mailLifecycleStatus: mailLifecycleRow?.status ?? null,
      lifecycle,
      latestKnownPoints: resolveLatestKnownPoints({
        lifecycle,
        syncRowPoints: toOptionalInt(latestSync?.clanPoints ?? null),
        currentWarPoints: toOptionalInt(currentWar?.fwaPoints ?? null),
        previousBaseline: null,
      }),
      postedSyncAtMs,
      hasReusableWarSnapshot,
    };
  }

  /** Purpose: load persisted lock-state JSON for a clan. */
  private async readPersistedState(clanTag: string): Promise<PointsLockStateRecord | null> {
    const raw = await this.settings.get(buildLockStateKey(clanTag));
    return parseLockState(raw);
  }

  /** Purpose: persist lock-state JSON atomically for deterministic transitions. */
  private async writePersistedState(state: PointsLockStateRecord): Promise<void> {
    await this.settings.set(buildLockStateKey(state.clanTag), JSON.stringify(state));
  }

  /** Purpose: emit structured gate decisions and lightweight rollups for lock observability. */
  private logDecision(decision: PointsDirectFetchDecision): void {
    const rollupKey = `${decision.caller}:${decision.fetchReason}:${decision.outcome}:${decision.decisionCode}`;
    const nextCount = (PointsDirectFetchGateService.decisionRollups.get(rollupKey) ?? 0) + 1;
    PointsDirectFetchGateService.decisionRollups.set(rollupKey, nextCount);
    console.info(
      `[points-lock] caller=${decision.caller} clan=${decision.clanTag} guild=${decision.guildId ?? "none"} reason=${decision.fetchReason} outcome=${decision.outcome} code=${decision.decisionCode} lock_state=${decision.lockState} allowed=${decision.allowed ? 1 : 0} bypass=${decision.manualForceBypass ? 1 : 0} lock_until_ms=${decision.lockUntilMs ?? "none"} posted_sync_ms=${decision.postedSyncAtMs ?? "none"} rollup=${nextCount} detail=${decision.reason}`
    );
  }
}
