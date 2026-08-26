import { prisma } from "../prisma";
import { PointsSyncService } from "./PointsSyncService";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  SyncCycleService,
  type ActiveSyncCycleResolution,
  type ActiveWarCycleContext,
} from "./SyncCycleService";
import { normalizeTag, normalizeTagBare } from "./war-events/core";
import { SyncCycleResolutionSource, type Prisma } from "@prisma/client";

export type ActiveWarSyncState = "preparation" | "inWar" | "notInWar";

export type ActiveWarSyncResolutionSource =
  | "same_war_persisted"
  | "refresh_posted_sync"
  | "active_cycle_reuse"
  | "active_cycle_conflict"
  | "historical_latest_persisted"
  | "active_war_confirmed"
  | "active_war_schedule_candidate"
  | "active_war_ambiguous"
  | "none";

export type ActiveWarSyncIdentity = {
  warState: ActiveWarSyncState;
  warId: string | null;
  warStartTime: Date | null;
  opponentTag: string | null;
  positivelyResolved: boolean;
};

export type ActiveWarSyncResolutionResult = {
  syncNumber: number | null;
  source: ActiveWarSyncResolutionSource;
  isDerived: boolean;
  identity: ActiveWarSyncIdentity;
  latestPersistedSyncNumber: number | null;
  sameWarPersistedSyncNumber: number | null;
  postedSyncNumber: number | null;
};

export type ActiveWarSyncAssignmentSource =
  | "existing_current_war"
  | "exact_same_war_reconcile"
  | "active_cycle_reuse"
  | "active_cycle_conflict"
  | "same_war_points_recovery"
  | "not_fwa"
  | "identity_incomplete"
  | "mirror_mode"
  | "unavailable";

export type ActiveWarSyncValidationState =
  "matched" | "missing_local" | "missing_external" | "mismatch";

export type ActiveWarSyncPersistenceState =
  | "saved"
  | "idempotent"
  | "conflict"
  | "revision_changed"
  | "identity_changed"
  | "not_needed";

export type ActiveWarSyncPollCycle = {
  activeSyncNumber: number | null;
  /** Ephemeral per-poll marker: the bounded active-cycle evidence read ran. */
  activeSyncEvidenceChecked?: boolean;
  /** Ephemeral per-poll marker preserving a bounded evidence conflict after cache invalidation. */
  activeSyncEvidenceConflict?: boolean;
  recordActiveSyncNumber: (syncNumber: number) => void;
  clearActiveSyncNumber: () => void;
};

export type ResolveOrAllocateActiveWarSyncNumberInput = {
  guildId: string;
  clanTag: string;
  identity: ActiveWarSyncIdentity;
  expectedCurrentWarRevisionAt?: Date | null;
  currentWarSyncNumber?: number | null;
  currentWarLegacySyncNumber?: number | null;
  sameWarPointsSyncNumber?: number | null;
  matchType?: string | null;
  inferredMatchType?: boolean | null;
  allowAllocation?: boolean;
  pollCycle?: ActiveWarSyncPollCycle | null;
};

export type ActiveWarSyncAssignmentResult = {
  syncNumber: number | null;
  proposedSyncNumber: number | null;
  usable: boolean;
  source: ActiveWarSyncAssignmentSource;
  shouldPersist: boolean;
  persistence: ActiveWarSyncPersistenceState;
  validation: ActiveWarSyncValidationState | null;
  latestPersistedSyncNumber: number | null;
  activeCycleSyncNumber: number | null;
  sameWarPointsSyncNumber: number | null;
  persistedSyncNumber: number | null;
  persistedRevisionAt: Date | null;
};

function normalizeBareTag(input: string | null | undefined): string | null {
  const normalized = normalizeTagBare(input);
  return normalized ? normalized : null;
}

function normalizeWarId(
  input: string | number | null | undefined,
): string | null {
  const raw = String(input ?? "").trim();
  return raw ? raw : null;
}

function normalizeDate(value: Date | null | undefined): Date | null {
  if (!(value instanceof Date)) return null;
  return Number.isFinite(value.getTime()) ? value : null;
}

/** Purpose: generate a strictly advancing CurrentWar revision token. */
export function nextCurrentWarRevision(
  previousRevision: Date | null | undefined,
): Date {
  const previousTime = normalizeDate(previousRevision)?.getTime() ?? null;
  const nextTime = Math.max(Date.now(), (previousTime ?? 0) + 1);
  return new Date(nextTime);
}

function parseCocApiTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const match = String(input).match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/,
  );
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  return new Date(
    Date.UTC(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss),
    ),
  );
}

/** Purpose: normalize optional values that should behave like canonical sync numbers. */
function normalizeSyncNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

/** Purpose: treat preparation and inWar as the only allocatable active-war states. */
function isAllocatableWarState(state: ActiveWarSyncState): boolean {
  return state === "preparation" || state === "inWar";
}

/** Purpose: normalize a current-war lifecycle value into the active allocation window. */
function isActiveCurrentWarState(state: string | null | undefined): boolean {
  const normalized = String(state ?? "")
    .trim()
    .toLowerCase();
  return normalized === "preparation" || normalized === "inwar";
}

/** Purpose: classify the strongest FWA evidence available for guarded allocation. */
function classifyFwaEvidence(input: {
  matchType?: string | null;
  inferredMatchType?: boolean | null;
}): "confirmed_fwa" | "strongly_inferred_fwa" | "not_fwa" | "unresolved" {
  const matchType = String(input.matchType ?? "")
    .trim()
    .toUpperCase();
  if (matchType === "FWA") {
    return input.inferredMatchType === false
      ? "confirmed_fwa"
      : "strongly_inferred_fwa";
  }
  if (matchType === "BL" || matchType === "MM" || matchType === "SKIP") {
    return "not_fwa";
  }
  if (matchType) return "unresolved";
  if (input.inferredMatchType === true) return "strongly_inferred_fwa";
  if (input.inferredMatchType === false) return "unresolved";
  return "unresolved";
}

/** Purpose: normalize an assignment value used for persisted sync rows and logs. */
function normalizeAssignmentSyncNumber(
  value: number | null | undefined,
): number | null {
  return normalizeSyncNumber(value);
}

type ActiveCycleSyncCandidate = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  startTime: Date | null;
  opponentTag: string | null;
  syncNumber: number | null;
  matchType: string | null;
  inferredMatchType: boolean | null;
};

type ActiveCycleSyncDiscovery = {
  syncNumber: number | null;
  conflict: boolean;
  candidates: ActiveCycleSyncCandidate[];
};

type ActiveCycleCurrentWarIdentity = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  startTime: Date;
  opponentTag: string;
  matchType: string | null;
  inferredMatchType: boolean | null;
};

function buildActiveWarEvidenceKey(input: {
  guildId: string;
  clanTag: string;
  startTime: Date;
  opponentTag: string;
}): string {
  return [
    input.guildId,
    normalizeBareTag(input.clanTag) ?? "",
    String(input.startTime.getTime()),
    normalizeBareTag(input.opponentTag) ?? "",
  ].join("\u0000");
}

/** Purpose: describe an already-resolved war identity with the minimum fields needed for safe sync fallback. */
export function buildActiveWarSyncIdentity(input: {
  warState: ActiveWarSyncState;
  warId?: string | number | null;
  warStartTime?: Date | null;
  opponentTag?: string | null;
}): ActiveWarSyncIdentity {
  const warId = normalizeWarId(input.warId ?? null);
  const warStartTime = normalizeDate(input.warStartTime ?? null);
  const opponentTag = normalizeBareTag(input.opponentTag ?? null);
  const isActiveWar =
    input.warState === "preparation" || input.warState === "inWar";
  const positivelyResolved =
    isActiveWar &&
    (warId !== null || (warStartTime !== null && opponentTag !== null));
  return {
    warState: input.warState,
    warId,
    warStartTime,
    opponentTag,
    positivelyResolved,
  };
}

/** Purpose: scope active-war sync identity to the live war and drop stale CurrentWar ids on rollover. */
export function resolveCurrentWarSyncIdentity(input: {
  clanTag?: string | null;
  warState: ActiveWarSyncState;
  liveWarStartTime: string | null | undefined;
  liveOpponentTag: string | null | undefined;
  currentWarId: number | string | null | undefined;
  currentWarStartTime: Date | null | undefined;
  currentWarOpponentTag: string | null | undefined;
}): ActiveWarSyncIdentity {
  if (input.warState === "notInWar") {
    return buildActiveWarSyncIdentity({ warState: "notInWar" });
  }

  const liveWarStartTime = parseCocApiTime(input.liveWarStartTime ?? null);
  const currentWarStartTime = normalizeDate(input.currentWarStartTime ?? null);
  const liveOpponentTag = normalizeBareTag(input.liveOpponentTag ?? null);
  const currentWarOpponentTag = normalizeBareTag(
    input.currentWarOpponentTag ?? null,
  );
  const currentWarId = normalizeWarId(input.currentWarId ?? null);
  const clanTag = normalizeBareTag(input.clanTag ?? null);

  const startAligned =
    liveWarStartTime && currentWarStartTime
      ? liveWarStartTime.getTime() === currentWarStartTime.getTime()
      : null;
  const opponentAligned =
    liveOpponentTag && currentWarOpponentTag
      ? liveOpponentTag === currentWarOpponentTag
      : null;
  const hasFullLiveIdentity =
    liveWarStartTime !== null &&
    liveOpponentTag !== null &&
    currentWarStartTime !== null &&
    currentWarOpponentTag !== null;
  const identityMismatch =
    (liveWarStartTime !== null &&
      currentWarStartTime !== null &&
      startAligned === false) ||
    (liveOpponentTag !== null &&
      currentWarOpponentTag !== null &&
      opponentAligned === false);
  const canUseCurrentWarId =
    currentWarId !== null &&
    hasFullLiveIdentity &&
    !identityMismatch &&
    startAligned === true &&
    opponentAligned === true;

  if (currentWarId !== null) {
    const decision = canUseCurrentWarId ? "reuse" : "drop";
    const reason = !hasFullLiveIdentity
      ? "partial_live_identity"
      : identityMismatch
        ? "identity_mismatch"
        : "unconfirmed_identity";
    console.info(
      `[sync-identity] clan=${clanTag ? `#${clanTag}` : "unknown"} war_state=${input.warState} current_war_id=${currentWarId} current_war_start=${currentWarStartTime?.toISOString() ?? "none"} current_war_opponent=${currentWarOpponentTag ? `#${currentWarOpponentTag}` : "none"} live_war_start=${liveWarStartTime?.toISOString() ?? "none"} live_opponent=${liveOpponentTag ? `#${liveOpponentTag}` : "none"} decision=${decision} reason=${reason}`,
    );
  }

  return buildActiveWarSyncIdentity({
    warState: input.warState,
    warId: canUseCurrentWarId ? currentWarId : null,
    warStartTime: liveWarStartTime ?? currentWarStartTime,
    opponentTag: liveOpponentTag ?? currentWarOpponentTag,
  });
}

/** Purpose: resolve active-war sync with one shared precedence stack for commands and notify flows. */
export function resolveActiveWarSyncNumber(input: {
  identity: ActiveWarSyncIdentity;
  latestPersistedSyncNumber: number | null;
  sameWarPersistedSyncNumber: number | null | undefined;
  activeCycleSyncNumber?: number | null;
  activeCycleConflict?: boolean;
  postedSyncNumber?: number | null;
  allowPostedSyncReuse?: boolean;
}): ActiveWarSyncResolutionResult {
  const latestPersistedSyncNumber = normalizeSyncNumber(
    input.latestPersistedSyncNumber,
  );
  const sameWarPersistedSyncNumber = normalizeSyncNumber(
    input.sameWarPersistedSyncNumber,
  );
  const activeCycleSyncNumber = normalizeSyncNumber(
    input.activeCycleSyncNumber ?? null,
  );
  const postedSyncNumber = normalizeSyncNumber(input.postedSyncNumber ?? null);
  if (sameWarPersistedSyncNumber !== null) {
    return {
      syncNumber: sameWarPersistedSyncNumber,
      source: "same_war_persisted",
      isDerived: false,
      identity: input.identity,
      latestPersistedSyncNumber,
      sameWarPersistedSyncNumber,
      postedSyncNumber,
    };
  }

  if (input.allowPostedSyncReuse && postedSyncNumber !== null) {
    return {
      syncNumber: postedSyncNumber,
      source: "refresh_posted_sync",
      isDerived: false,
      identity: input.identity,
      latestPersistedSyncNumber,
      sameWarPersistedSyncNumber,
      postedSyncNumber,
    };
  }

  const isActiveWar =
    input.identity.warState === "preparation" ||
    input.identity.warState === "inWar";
  if (isActiveWar) {
    if (input.identity.positivelyResolved && input.activeCycleConflict) {
      return {
        syncNumber: null,
        source: "active_cycle_conflict",
        isDerived: false,
        identity: input.identity,
        latestPersistedSyncNumber,
        sameWarPersistedSyncNumber,
        postedSyncNumber,
      };
    }
    if (input.identity.positivelyResolved && activeCycleSyncNumber !== null) {
      return {
        syncNumber: activeCycleSyncNumber,
        source: "active_cycle_reuse",
        isDerived: false,
        identity: input.identity,
        latestPersistedSyncNumber,
        sameWarPersistedSyncNumber,
        postedSyncNumber,
      };
    }
    return {
      syncNumber: null,
      source: "none",
      isDerived: false,
      identity: input.identity,
      latestPersistedSyncNumber,
      sameWarPersistedSyncNumber,
      postedSyncNumber,
    };
  }

  if (latestPersistedSyncNumber !== null) {
    return {
      syncNumber: latestPersistedSyncNumber,
      source: "historical_latest_persisted",
      isDerived: false,
      identity: input.identity,
      latestPersistedSyncNumber,
      sameWarPersistedSyncNumber,
      postedSyncNumber,
    };
  }

  return {
    syncNumber: null,
    source: "none",
    isDerived: false,
    identity: input.identity,
    latestPersistedSyncNumber,
    sameWarPersistedSyncNumber,
    postedSyncNumber,
  };
}

/** Purpose: resolve a command read without allocating, honoring exact and already-assigned canonical evidence. */
export function resolveActiveWarSyncNumberReadOnly(input: {
  identity: ActiveWarSyncIdentity;
  latestPersistedSyncNumber: number | null;
  sameWarPersistedSyncNumber: number | null | undefined;
  currentWarSyncNumber?: number | null;
  activeCycleSyncNumber?: number | null;
  activeCycleConflict?: boolean;
}): ActiveWarSyncResolutionResult {
  // CurrentWar.syncNumber is materialized runtime state. Older releases could
  // have filled it from latest+1, so identity matching alone is not evidence.
  // Keep the input for compatibility with callers while deliberately ignoring it.
  const sameWarPersistedSyncNumber = normalizeSyncNumber(
    input.sameWarPersistedSyncNumber,
  );
  return resolveActiveWarSyncNumber({
    identity: input.identity,
    latestPersistedSyncNumber: input.latestPersistedSyncNumber,
    sameWarPersistedSyncNumber,
    activeCycleSyncNumber: input.activeCycleSyncNumber ?? null,
    activeCycleConflict: input.activeCycleConflict ?? false,
  });
}

/** Purpose: log shared sync resolution decisions in one structured format. */
export function logActiveWarSyncResolution(input: {
  stage: string;
  guildId?: string | null;
  clanTag: string;
  pointsLockPreventedLiveValidation?: boolean | null;
  resolution: ActiveWarSyncResolutionResult;
}): void {
  const line =
    `[sync-resolution] stage=${input.stage} guild=${String(input.guildId ?? "none")}` +
    ` clan=#${normalizeBareTag(input.clanTag) ?? "unknown"}` +
    ` sync_resolution_source=${input.resolution.source}` +
    ` war_state=${input.resolution.identity.warState}` +
    ` war_id=${input.resolution.identity.warId ?? "none"}` +
    ` war_start=${input.resolution.identity.warStartTime?.toISOString() ?? "none"}` +
    ` opponent=${input.resolution.identity.opponentTag ? `#${input.resolution.identity.opponentTag}` : "none"}` +
    ` identity_positive=${input.resolution.identity.positivelyResolved ? "1" : "0"}` +
    ` latest_persisted_sync=${input.resolution.latestPersistedSyncNumber ?? "none"}` +
    ` same_war_persisted_sync=${input.resolution.sameWarPersistedSyncNumber ?? "none"}` +
    ` posted_sync=${input.resolution.postedSyncNumber ?? "none"}` +
    ` resolved_sync=${input.resolution.syncNumber ?? "none"}` +
    ` derived=${input.resolution.isDerived ? "1" : "0"}` +
    ` points_lock_prevented_live_validation=${input.pointsLockPreventedLiveValidation ? "1" : "0"}`;
  if (input.resolution.source === "none") {
    console.info(line);
    return;
  }
  console.debug(line);
}

/** Purpose: log canonical active-war sync ownership decisions in one structured format. */
export function logActiveWarSyncAssignment(input: {
  stage: string;
  guildId?: string | null;
  clanTag: string;
  resolution: ActiveWarSyncAssignmentResult;
}): void {
  const ignoredLegacyNonFwaSync =
    input.stage === "existing_current_war_legacy" &&
    input.resolution.source === "existing_current_war" &&
    input.resolution.persistence === "not_needed" &&
    input.resolution.usable === false &&
    input.resolution.syncNumber === null &&
    input.resolution.proposedSyncNumber !== null;
  const line =
    `[sync-assignment] stage=${input.stage} guild=${String(input.guildId ?? "none")}` +
    ` clan=#${normalizeBareTag(input.clanTag) ?? "unknown"}` +
    ` source=${input.resolution.source}` +
    ` persistence=${input.resolution.persistence}` +
    ` usable=${input.resolution.usable ? "1" : "0"}` +
    ` should_persist=${input.resolution.shouldPersist ? "1" : "0"}` +
    ` proposed_sync=${input.resolution.proposedSyncNumber ?? "none"}` +
    ` persisted_sync=${input.resolution.persistedSyncNumber ?? "none"}` +
    ` validation=${input.resolution.validation ?? "none"}` +
    ` latest_persisted_sync=${input.resolution.latestPersistedSyncNumber ?? "none"}` +
    ` active_cycle_sync=${input.resolution.activeCycleSyncNumber ?? "none"}` +
    ` same_war_points_sync=${input.resolution.sameWarPointsSyncNumber ?? "none"}` +
    ` resolved_sync=${input.resolution.syncNumber ?? "none"}` +
    (ignoredLegacyNonFwaSync ? " reason=legacy_non_fwa_ignored" : "");
  if (
    input.resolution.persistence === "conflict" ||
    input.resolution.persistence === "revision_changed" ||
    input.resolution.persistence === "identity_changed" ||
    input.resolution.source === "active_cycle_conflict"
  ) {
    console.warn(line);
    return;
  }
  console.info(line);
}

/** Purpose: read the latest persisted sync baseline directly from ClanPointsSync. */
export class ActiveWarSyncResolutionService {
  /** Purpose: initialize shared sync-resolution dependencies. */
  constructor(
    private readonly pointsSync = new PointsSyncService(),
    private readonly syncCycles = new SyncCycleService(),
  ) {}

  /** Purpose: load one request-scoped active-cycle chronology context. */
  async loadActiveWarCycleContext(input: {
    guildId: string;
    preparationStartTimes: Array<Date | null | undefined>;
  }): Promise<ActiveWarCycleContext> {
    return this.syncCycles.loadActiveWarCycleContext(input);
  }

  /** Purpose: resolve a locally provable active FWA sync and persist it only when explicitly authorized. */
  async resolveActiveWarSyncFromCanonicalCycle(input: {
    guildId: string;
    identity: ActiveWarSyncIdentity;
    preparationStartTime: Date | null | undefined;
    matchType?: string | null;
    inferredMatchType?: boolean | null;
    persistCanonical?: boolean;
    activeCycleContext?: ActiveWarCycleContext;
    /** Exact same-war points evidence is corroboration, not a cycle owner. */
    sameWarPersistedSyncNumber?: number | null;
  }): Promise<{
    syncNumber: number | null;
    source:
      | "active_war_confirmed"
      | "active_war_schedule_candidate"
      | "active_cycle_reuse"
      | "active_war_ambiguous"
      | "none";
    status:
      | ActiveSyncCycleResolution["status"]
      | "not_fwa"
      | "identity_incomplete"
      | "mirror_mode";
    scheduledSyncPostId: string | null;
    syncTime: Date | null;
    reason: string;
  }> {
    const evidence = classifyFwaEvidence({
      matchType: input.matchType ?? null,
      inferredMatchType: input.inferredMatchType ?? null,
    });
    const base = {
      syncNumber: null,
      scheduledSyncPostId: null,
      syncTime: null,
    };
    if (
      !input.identity.positivelyResolved ||
      input.identity.warStartTime === null ||
      input.identity.opponentTag === null
    ) {
      return {
        ...base,
        source: "none",
        status: "identity_incomplete",
        reason: "identity_incomplete",
      };
    }
    if (
      evidence !== "confirmed_fwa" &&
      evidence !== "strongly_inferred_fwa" &&
      !input.activeCycleContext
    ) {
      return {
        ...base,
        source: "none",
        status: "not_fwa",
        reason: "fwa_evidence_unresolved",
      };
    }
    let resolution: ActiveSyncCycleResolution;
    try {
      resolution = input.activeCycleContext
        ? await this.syncCycles.resolveActiveWarCycleFromContext(
            input.activeCycleContext,
            {
              guildId: input.guildId,
              preparationStartTime: input.preparationStartTime,
              matchType: input.matchType ?? null,
              inferredMatchType: input.inferredMatchType ?? null,
            },
          )
        : await this.syncCycles.resolveActiveWarCycle({
            guildId: input.guildId,
            preparationStartTime: input.preparationStartTime,
            matchType: input.matchType ?? null,
            inferredMatchType: input.inferredMatchType ?? null,
          });
    } catch (error) {
      console.warn(
        `[sync-cycle] event=active_resolve outcome=failure guild_id=${input.guildId} reason=resolver_exception error=${String(error)}`,
      );
      return {
        ...base,
        source: "none",
        status: "unresolved",
        reason: "resolver_exception",
      };
    }
    if (resolution.status === "conflict" || resolution.status === "ambiguous") {
      return {
        syncNumber: null,
        source: "active_war_ambiguous",
        status: resolution.status,
        scheduledSyncPostId: resolution.scheduledSyncPostId,
        syncTime: resolution.syncTime,
        reason: resolution.reason,
      };
    }
    if (
      (resolution.status !== "exact" && resolution.status !== "derived") ||
      resolution.syncNumber === null ||
      resolution.scheduledSyncPostId === null ||
      resolution.syncTime === null
    ) {
      return {
        ...base,
        source: "none",
        status: resolution.status,
        reason: resolution.reason,
      };
    }
    const sameWarPersistedSyncNumber = normalizeSyncNumber(
      input.sameWarPersistedSyncNumber ?? null,
    );
    if (
      sameWarPersistedSyncNumber !== null &&
      sameWarPersistedSyncNumber !== resolution.syncNumber
    ) {
      return {
        syncNumber: null,
        source: "active_war_ambiguous",
        status: "conflict",
        scheduledSyncPostId: resolution.scheduledSyncPostId,
        syncTime: resolution.syncTime,
        reason: "points_sync_conflicts_with_active_cycle",
      };
    }
    const isFwaEvidence =
      evidence === "confirmed_fwa" || evidence === "strongly_inferred_fwa";
    if (resolution.status === "derived" && !isFwaEvidence) {
      return {
        ...base,
        source: "none",
        status: "not_fwa",
        reason: "fwa_evidence_unresolved",
      };
    }
    if (resolution.status === "exact" && !isFwaEvidence) {
      return {
        syncNumber: resolution.syncNumber,
        source: "active_cycle_reuse",
        status: resolution.status,
        scheduledSyncPostId: resolution.scheduledSyncPostId,
        syncTime: resolution.syncTime,
        reason: resolution.reason,
      };
    }
    if (resolution.status === "derived" && input.activeCycleContext) {
      this.syncCycles.updateActiveWarCycleCandidateContext?.(
        input.activeCycleContext,
        {
          syncNumber: resolution.syncNumber,
          scheduledSyncPostId: resolution.scheduledSyncPostId,
          syncTime: resolution.syncTime,
          previousSyncNumber: resolution.previousSyncNumber ?? 0,
        },
      );
    }
    if (
      (resolution.status === "derived" ||
        (resolution.status === "exact" &&
          resolution.resolutionSource === null)) &&
      input.persistCanonical === true &&
      evidence === "confirmed_fwa"
    ) {
      if (isMirrorPollingMode()) {
        return {
          ...base,
          source: "none",
          status: "mirror_mode",
          reason: "mirror_does_not_resolve_sync_cycles",
        };
      }
      const binding = await this.syncCycles.bindResolvedCanonical({
        guildId: input.guildId,
        syncNumber: resolution.syncNumber,
        syncTime: resolution.syncTime,
        scheduledSyncPostId: resolution.scheduledSyncPostId,
        resolutionSource: SyncCycleResolutionSource.ACTIVE_WAR_CONFIRMED,
      });
      if (binding.status === "conflict" || binding.status === "failed") {
        return {
          syncNumber: null,
          source: "active_war_ambiguous",
          status: "conflict",
          scheduledSyncPostId: resolution.scheduledSyncPostId,
          syncTime: resolution.syncTime,
          reason:
            binding.status === "conflict" ? binding.reason : binding.reason,
        };
      }
      if (
        input.activeCycleContext &&
        (binding.status === "created" || binding.status === "existing")
      ) {
        this.syncCycles.updateActiveWarCycleContext(
          input.activeCycleContext,
          binding.cycle,
        );
      }
    }
    const source =
      evidence === "confirmed_fwa"
        ? "active_war_confirmed"
        : "active_war_schedule_candidate";
    return {
      syncNumber: resolution.syncNumber,
      source,
      status: resolution.status,
      scheduledSyncPostId: resolution.scheduledSyncPostId,
      syncTime: resolution.syncTime,
      reason: resolution.reason,
    };
  }

  /** Purpose: load the latest persisted sync baseline without pre-decrementing it. */
  async getLatestPersistedSyncBaseline(input?: {
    guildId?: string | null;
  }): Promise<number | null> {
    return this.pointsSync.findLatestSyncNum({
      guildId: input?.guildId ?? null,
    });
  }

  /** Purpose: resolve or allocate one canonical active-war sync number for a poll cycle. */
  async resolveOrAllocateActiveSyncNumber(
    input: ResolveOrAllocateActiveWarSyncNumberInput,
  ): Promise<ActiveWarSyncAssignmentResult> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeBareTag(input.clanTag) ?? "";
    const currentWarCanonicalSyncNumber = normalizeAssignmentSyncNumber(
      input.currentWarSyncNumber ?? null,
    );
    const currentWarLegacySyncNumber = normalizeAssignmentSyncNumber(
      input.currentWarLegacySyncNumber ?? null,
    );
    const currentWarSyncNumber =
      currentWarCanonicalSyncNumber ?? currentWarLegacySyncNumber;
    const expectedCurrentWarRevisionAt = normalizeDate(
      input.expectedCurrentWarRevisionAt ?? null,
    );
    const sameWarPointsSyncNumber = normalizeAssignmentSyncNumber(
      input.sameWarPointsSyncNumber ?? null,
    );
    const evidence = classifyFwaEvidence({
      matchType: input.matchType ?? null,
      inferredMatchType: input.inferredMatchType ?? null,
    });
    const allowAllocation =
      input.allowAllocation !== false &&
      isAllocatableWarState(input.identity.warState) &&
      (evidence === "confirmed_fwa" || evidence === "strongly_inferred_fwa");
    const validation = this.resolveValidationState({
      currentWarSyncNumber,
      sameWarPointsSyncNumber,
    });
    const cachedActiveSyncNumber = normalizeAssignmentSyncNumber(
      input.pollCycle?.activeSyncNumber ?? null,
    );
    const shouldReadActiveCycleEvidence =
      !input.pollCycle || input.pollCycle.activeSyncEvidenceChecked !== true;
    const persistedActiveCycleDiscovery = shouldReadActiveCycleEvidence
      ? await this.findPersistedActiveSyncNumber()
      : null;
    if (input.pollCycle) {
      input.pollCycle.activeSyncEvidenceChecked = true;
    }
    const activeCycleDiscovery =
      persistedActiveCycleDiscovery !== null
        ? cachedActiveSyncNumber === null ||
          persistedActiveCycleDiscovery.conflict ||
          persistedActiveCycleDiscovery.syncNumber === cachedActiveSyncNumber
          ? persistedActiveCycleDiscovery
          : {
              syncNumber: null,
              conflict: persistedActiveCycleDiscovery.syncNumber !== null,
              candidates: persistedActiveCycleDiscovery.candidates,
            }
        : cachedActiveSyncNumber !== null
          ? {
              syncNumber: cachedActiveSyncNumber,
              conflict: input.pollCycle?.activeSyncEvidenceConflict === true,
              candidates: [] as ActiveCycleSyncCandidate[],
            }
          : {
              syncNumber: null,
              conflict: input.pollCycle?.activeSyncEvidenceConflict === true,
              candidates: [] as ActiveCycleSyncCandidate[],
            };
    if (input.pollCycle) {
      input.pollCycle.activeSyncEvidenceConflict =
        activeCycleDiscovery.conflict;
      if (
        !activeCycleDiscovery.conflict &&
        activeCycleDiscovery.syncNumber !== null &&
        input.pollCycle.activeSyncNumber !== activeCycleDiscovery.syncNumber
      ) {
        input.pollCycle.recordActiveSyncNumber(activeCycleDiscovery.syncNumber);
      }
    }
    const activeSyncNumber = activeCycleDiscovery.syncNumber;
    const baseResult = {
      latestPersistedSyncNumber: await this.getLatestPersistedSyncBaseline({
        guildId: null,
      }),
      activeCycleSyncNumber: activeSyncNumber,
      sameWarPointsSyncNumber,
      validation,
    };
    const finish = (
      stage: string,
      resolution: ActiveWarSyncAssignmentResult,
    ): ActiveWarSyncAssignmentResult => {
      logActiveWarSyncAssignment({
        stage,
        guildId: guildId || null,
        clanTag,
        resolution,
      });
      return resolution;
    };

    if (isMirrorPollingMode()) {
      return finish("mirror_mode", {
        syncNumber: null,
        proposedSyncNumber: null,
        usable: false,
        source: "mirror_mode",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: null,
        persistedRevisionAt: null,
      });
    }

    if (!input.identity.positivelyResolved) {
      return finish("identity_incomplete", {
        syncNumber: null,
        proposedSyncNumber: null,
        usable: false,
        source: "identity_incomplete",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: null,
        persistedRevisionAt: null,
      });
    }

    if (evidence === "unresolved") {
      return finish("unresolved", {
        syncNumber: null,
        proposedSyncNumber: null,
        usable: false,
        source: "identity_incomplete",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: null,
        persistedRevisionAt: null,
      });
    }

    if (!allowAllocation) {
      return finish("not_fwa", {
        syncNumber: null,
        proposedSyncNumber: null,
        usable: false,
        source: "not_fwa",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: null,
        persistedRevisionAt: null,
      });
    }

    if (sameWarPointsSyncNumber !== null) {
      if (
        currentWarCanonicalSyncNumber !== null &&
        currentWarCanonicalSyncNumber !== sameWarPointsSyncNumber
      ) {
        const persistence =
          await this.reconcileCurrentWarSyncNumberFromExactEvidence({
            guildId,
            clanTag,
            identity: input.identity,
            expectedRevisionAt: expectedCurrentWarRevisionAt,
            expectedSyncNumber: currentWarCanonicalSyncNumber,
            resolvedSyncNumber: sameWarPointsSyncNumber,
          });
        const usable =
          persistence.state === "saved" || persistence.state === "idempotent";
        if (usable) {
          this.recordExactEvidenceForPollCycle(
            input.pollCycle,
            sameWarPointsSyncNumber,
          );
        }
        return finish("exact_same_war_reconcile", {
          syncNumber: usable ? sameWarPointsSyncNumber : null,
          proposedSyncNumber: sameWarPointsSyncNumber,
          usable,
          source: "exact_same_war_reconcile",
          shouldPersist: persistence.state === "saved",
          persistence: persistence.state,
          ...baseResult,
          persistedSyncNumber: usable ? sameWarPointsSyncNumber : null,
          persistedRevisionAt: usable ? persistence.persistedRevisionAt : null,
        });
      }
      if (currentWarCanonicalSyncNumber === sameWarPointsSyncNumber) {
        this.recordExactEvidenceForPollCycle(
          input.pollCycle,
          sameWarPointsSyncNumber,
        );
        return finish("existing_current_war", {
          syncNumber: sameWarPointsSyncNumber,
          proposedSyncNumber: sameWarPointsSyncNumber,
          usable: true,
          source: "existing_current_war",
          shouldPersist: false,
          persistence: "not_needed",
          ...baseResult,
          persistedSyncNumber: sameWarPointsSyncNumber,
          persistedRevisionAt: null,
        });
      }
      const persistence = await this.persistCurrentWarSyncNumber({
        guildId,
        clanTag,
        identity: input.identity,
        expectedRevisionAt: expectedCurrentWarRevisionAt,
        syncNumber: sameWarPointsSyncNumber,
      });
      const usable =
        persistence.state === "saved" || persistence.state === "idempotent";
      if (usable) {
        this.recordExactEvidenceForPollCycle(
          input.pollCycle,
          sameWarPointsSyncNumber,
        );
      }
      return finish("same_war_points_recovery", {
        syncNumber: usable ? sameWarPointsSyncNumber : null,
        proposedSyncNumber: sameWarPointsSyncNumber,
        usable,
        source: "same_war_points_recovery",
        shouldPersist: persistence.state === "saved",
        persistence: persistence.state,
        ...baseResult,
        persistedSyncNumber: usable ? sameWarPointsSyncNumber : null,
        persistedRevisionAt: usable ? persistence.persistedRevisionAt : null,
      });
    }

    if (activeCycleDiscovery.conflict) {
      return finish("active_cycle_conflict", {
        syncNumber: null,
        proposedSyncNumber: null,
        usable: false,
        source: "active_cycle_conflict",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: null,
        persistedRevisionAt: null,
      });
    }

    if (activeSyncNumber !== null) {
      const currentMaterializedSyncNumber =
        currentWarCanonicalSyncNumber ?? currentWarLegacySyncNumber;
      if (
        currentMaterializedSyncNumber !== null &&
        currentMaterializedSyncNumber !== activeSyncNumber
      ) {
        return finish("active_cycle_conflict", {
          syncNumber: null,
          proposedSyncNumber: activeSyncNumber,
          usable: false,
          source: "active_cycle_conflict",
          shouldPersist: false,
          persistence: "not_needed",
          ...baseResult,
          persistedSyncNumber: null,
          persistedRevisionAt: null,
        });
      }
      if (currentMaterializedSyncNumber === activeSyncNumber) {
        return finish("active_cycle_reuse", {
          syncNumber: activeSyncNumber,
          proposedSyncNumber: activeSyncNumber,
          usable: true,
          source: "active_cycle_reuse",
          shouldPersist: false,
          persistence: "idempotent",
          ...baseResult,
          persistedSyncNumber: activeSyncNumber,
          persistedRevisionAt: null,
        });
      }
      const persistence = await this.persistCurrentWarSyncNumber({
        guildId,
        clanTag,
        identity: input.identity,
        expectedRevisionAt: expectedCurrentWarRevisionAt,
        syncNumber: activeSyncNumber,
      });
      const usable =
        persistence.state === "saved" || persistence.state === "idempotent";
      if (
        usable &&
        input.pollCycle &&
        input.pollCycle.activeSyncNumber === null
      ) {
        input.pollCycle.recordActiveSyncNumber(activeSyncNumber);
      }
      return finish("active_cycle_reuse", {
        syncNumber: usable ? activeSyncNumber : null,
        proposedSyncNumber: activeSyncNumber,
        usable,
        source: "active_cycle_reuse",
        shouldPersist: persistence.state === "saved",
        persistence: persistence.state,
        ...baseResult,
        persistedSyncNumber: usable ? activeSyncNumber : null,
        persistedRevisionAt: usable ? persistence.persistedRevisionAt : null,
      });
    }

    return finish("unavailable", {
      syncNumber: null,
      proposedSyncNumber: null,
      usable: false,
      source: "unavailable",
      shouldPersist: false,
      persistence: "not_needed",
      ...baseResult,
      persistedSyncNumber: null,
      persistedRevisionAt: null,
    });
  }

  /** Purpose: validate the canonical sync number against exact same-war points data. */
  validateExactCurrentWarSyncNumber(input: {
    currentWarSyncNumber: number | null;
    sameWarPointsSyncNumber: number | null;
  }): ActiveWarSyncValidationState | null {
    return this.resolveValidationState(input);
  }

  /** Purpose: read the currently active canonical sync number from persisted active-war rows. */
  async findPersistedActiveSyncNumber(): Promise<ActiveCycleSyncDiscovery> {
    const rows = await prisma.currentWar.findMany({
      where: {
        state: { in: ["preparation", "inWar"] },
      },
      select: {
        guildId: true,
        clanTag: true,
        warId: true,
        startTime: true,
        opponentTag: true,
        matchType: true,
        inferredMatchType: true,
      },
    });
    const eligibleCurrentWarRows = rows
      .map((row) => ({
        guildId: row.guildId,
        clanTag: normalizeBareTag(row.clanTag),
        warId:
          row.warId !== null && row.warId !== undefined
            ? Math.trunc(Number(row.warId))
            : null,
        startTime: row.startTime ?? null,
        opponentTag: normalizeBareTag(row.opponentTag ?? null),
        matchType: row.matchType !== null ? String(row.matchType) : null,
        inferredMatchType: row.inferredMatchType === true ? true : null,
      }))
      .filter(
        (row): row is ActiveCycleCurrentWarIdentity =>
          row.clanTag !== null &&
          row.startTime !== null &&
          row.opponentTag !== null &&
          (classifyFwaEvidence({
            matchType: row.matchType,
            inferredMatchType: row.inferredMatchType,
          }) === "confirmed_fwa" ||
            classifyFwaEvidence({
              matchType: row.matchType,
              inferredMatchType: row.inferredMatchType,
            }) === "strongly_inferred_fwa"),
      );

    const pointsSyncWhere: Prisma.ClanPointsSyncWhereInput[] =
      eligibleCurrentWarRows.map((row) => ({
        guildId: row.guildId,
        clanTag: normalizeTag(row.clanTag),
        warStartTime: row.startTime as Date,
        opponentTag: normalizeTag(row.opponentTag),
        needsValidation: false,
      }));
    const pointsRows =
      pointsSyncWhere.length > 0
        ? await prisma.clanPointsSync.findMany({
            where: { OR: pointsSyncWhere },
            select: {
              guildId: true,
              clanTag: true,
              warId: true,
              warStartTime: true,
              opponentTag: true,
              syncNum: true,
            },
          })
        : [];
    const pointsByIdentity = new Map<
      string,
      Array<{ warId: string | null; syncNumber: number }>
    >();
    for (const row of pointsRows) {
      const syncNumber = normalizeAssignmentSyncNumber(row.syncNum);
      const startTime = row.warStartTime;
      const opponentTag = normalizeBareTag(row.opponentTag);
      const clanTag = normalizeBareTag(row.clanTag);
      if (
        syncNumber === null ||
        !(startTime instanceof Date) ||
        clanTag === null ||
        opponentTag === null
      ) {
        continue;
      }
      const identityKey = buildActiveWarEvidenceKey({
        guildId: row.guildId,
        clanTag,
        startTime,
        opponentTag,
      });
      const identityEvidence = pointsByIdentity.get(identityKey) ?? [];
      identityEvidence.push({
        warId: row.warId !== null ? String(row.warId) : null,
        syncNumber,
      });
      pointsByIdentity.set(identityKey, identityEvidence);
    }
    const candidates = eligibleCurrentWarRows.flatMap((row) => {
      const pointsEvidence =
        pointsByIdentity.get(buildActiveWarEvidenceKey(row)) ?? [];
      return pointsEvidence
        .filter(
          (evidence) =>
            row.warId === null ||
            evidence.warId === null ||
            String(row.warId) === evidence.warId,
        )
        .map((evidence) => ({
          ...row,
          syncNumber: evidence.syncNumber,
        }));
    });
    const distinctSyncNumbers = Array.from(
      new Set(
        candidates
          .map((row) => normalizeAssignmentSyncNumber(row.syncNumber))
          .filter((syncNumber): syncNumber is number => syncNumber !== null),
      ),
    );
    if (distinctSyncNumbers.length === 1) {
      return {
        syncNumber: distinctSyncNumbers[0],
        conflict: false,
        candidates,
      };
    }
    if (distinctSyncNumbers.length > 1) {
      console.warn(
        `[sync-assignment] stage=active_cycle_conflict source=active_cycle_conflict candidate_syncs=${distinctSyncNumbers.join(",")} rows=${candidates
          .map(
            (row) =>
              `guild=${row.guildId} clan=#${row.clanTag} war_id=${row.warId ?? "none"} war_start=${row.startTime?.toISOString() ?? "none"} opponent=${row.opponentTag ? `#${row.opponentTag}` : "none"} sync=${row.syncNumber ?? "none"} match_type=${row.matchType ?? "none"} inferred=${row.inferredMatchType ? "1" : "0"}`,
          )
          .join(" | ")}`,
      );
      return {
        syncNumber: null,
        conflict: true,
        candidates,
      };
    }
    return {
      syncNumber: null,
      conflict: false,
      candidates,
    };
  }

  /** Purpose: add exact points evidence to an existing poll snapshot without rediscovering unchanged evidence. */
  private recordExactEvidenceForPollCycle(
    pollCycle: ActiveWarSyncPollCycle | null | undefined,
    resolvedSyncNumber: number,
  ): void {
    if (!pollCycle || pollCycle.activeSyncEvidenceConflict === true) return;
    const cachedSyncNumber = normalizeAssignmentSyncNumber(
      pollCycle.activeSyncNumber,
    );
    if (cachedSyncNumber === null) {
      pollCycle.recordActiveSyncNumber(resolvedSyncNumber);
    }
  }

  /** Purpose: persist one canonical sync number to the exact current-war identity. */
  private async persistCurrentWarSyncNumber(input: {
    guildId: string;
    clanTag: string;
    identity: ActiveWarSyncIdentity;
    expectedRevisionAt: Date | null;
    syncNumber: number;
    assignmentRevisionAt?: Date | null;
  }): Promise<{
    state: ActiveWarSyncPersistenceState;
    persistedRevisionAt: Date | null;
  }> {
    const syncNumber = normalizeAssignmentSyncNumber(input.syncNumber);
    if (syncNumber === null) {
      return { state: "not_needed", persistedRevisionAt: null };
    }
    const dbClanTag = normalizeTag(input.clanTag) ?? "";
    const dbOpponentTag = input.identity.opponentTag
      ? normalizeTag(input.identity.opponentTag)
      : null;
    const expectedRevisionAt = normalizeDate(input.expectedRevisionAt ?? null);
    if (!expectedRevisionAt) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=revision_changed guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} reason=missing_revision`,
      );
      return { state: "revision_changed", persistedRevisionAt: null };
    }
    const assignmentRevisionAt =
      normalizeDate(input.assignmentRevisionAt ?? null) ??
      nextCurrentWarRevision(expectedRevisionAt);
    const where: Parameters<typeof prisma.currentWar.updateMany>[0]["where"] = {
      guildId: input.guildId,
      clanTag: dbClanTag,
      updatedAt: expectedRevisionAt,
      syncNumber: null,
      state: { in: ["preparation", "inWar"] },
      ...(input.identity.warStartTime
        ? { startTime: input.identity.warStartTime }
        : {}),
      ...(input.identity.opponentTag ? { opponentTag: dbOpponentTag } : {}),
      ...(input.identity.warId !== null
        ? { warId: Number(input.identity.warId) }
        : {}),
    };

    const updated = await prisma.currentWar.updateMany({
      where,
      data: {
        syncNumber,
        updatedAt: assignmentRevisionAt,
      },
    });
    if (updated.count === 1) {
      return { state: "saved", persistedRevisionAt: assignmentRevisionAt };
    }
    if (updated.count > 1) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=conflict guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} updated_count=${updated.count}`,
      );
      return { state: "conflict", persistedRevisionAt: null };
    }

    const exactRow = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: dbClanTag,
        state: { in: ["preparation", "inWar"] },
        ...(input.identity.warStartTime
          ? { startTime: input.identity.warStartTime }
          : {}),
        ...(input.identity.opponentTag ? { opponentTag: dbOpponentTag } : {}),
        ...(input.identity.warId !== null
          ? { warId: Number(input.identity.warId) }
          : {}),
      },
      select: {
        syncNumber: true,
        warId: true,
        startTime: true,
        opponentTag: true,
        state: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!exactRow) {
      const replacementRow = await prisma.currentWar.findFirst({
        where: {
          guildId: input.guildId,
          clanTag: dbClanTag,
          state: { in: ["preparation", "inWar"] },
        },
        orderBy: { updatedAt: "desc" },
        select: {
          syncNumber: true,
          warId: true,
          startTime: true,
          opponentTag: true,
          updatedAt: true,
        },
      });
      if (replacementRow) {
        console.warn(
          `[sync-assignment] stage=persist_current_war source=identity_changed guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} observed_revision=${replacementRow.updatedAt?.toISOString() ?? "none"} expected_revision=${expectedRevisionAt.toISOString()} replacement_identity=war_id:${replacementRow.warId ?? "none"}|war_start:${replacementRow.startTime?.toISOString() ?? "none"}|opponent:${replacementRow.opponentTag ? normalizeTag(replacementRow.opponentTag) : "none"}`,
        );
        return { state: "identity_changed", persistedRevisionAt: null };
      }
      console.warn(
        `[sync-assignment] stage=persist_current_war source=conflict guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} expected_revision=${expectedRevisionAt.toISOString()} result=missing_row`,
      );
      return { state: "conflict", persistedRevisionAt: null };
    }

    if (exactRow.updatedAt.getTime() !== expectedRevisionAt.getTime()) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=revision_changed guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} expected_revision=${expectedRevisionAt.toISOString()} observed_revision=${exactRow.updatedAt.toISOString()} war_id=${exactRow.warId ?? "none"} war_start=${exactRow.startTime?.toISOString() ?? "none"} opponent=${exactRow.opponentTag ? normalizeTag(exactRow.opponentTag) : "none"} persisted_sync=${normalizeAssignmentSyncNumber(exactRow.syncNumber) ?? "none"}`,
      );
      return { state: "revision_changed", persistedRevisionAt: null };
    }
    if (
      exactRow.syncNumber !== null &&
      exactRow.syncNumber !== undefined &&
      normalizeAssignmentSyncNumber(exactRow.syncNumber) === syncNumber
    ) {
      return { state: "idempotent", persistedRevisionAt: exactRow.updatedAt };
    }
    if (
      exactRow.syncNumber !== null &&
      exactRow.syncNumber !== undefined &&
      normalizeAssignmentSyncNumber(exactRow.syncNumber) !== syncNumber
    ) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=conflict guild=${input.guildId} clan=#${normalizeBareTag(input.clanTag) ?? "unknown"} db_clan_tag=${dbClanTag || "none"} db_opponent_tag=${dbOpponentTag ?? "none"} proposed_sync=${syncNumber} persisted_sync=${normalizeAssignmentSyncNumber(exactRow.syncNumber) ?? "none"} expected_revision=${expectedRevisionAt.toISOString()} exact_revision=${exactRow.updatedAt?.toISOString() ?? "none"} war_id=${exactRow.warId ?? "none"} war_start=${exactRow.startTime?.toISOString() ?? "none"} opponent=${exactRow.opponentTag ? normalizeTag(exactRow.opponentTag) : "none"}`,
      );
      return { state: "conflict", persistedRevisionAt: null };
    }
    return { state: "identity_changed", persistedRevisionAt: null };
  }

  /** Purpose: reconcile a stale canonical sync only when exact war evidence still owns the guarded row. */
  private async reconcileCurrentWarSyncNumberFromExactEvidence(input: {
    guildId: string;
    clanTag: string;
    identity: ActiveWarSyncIdentity;
    expectedRevisionAt: Date | null;
    expectedSyncNumber: number;
    resolvedSyncNumber: number;
  }): Promise<{
    state: ActiveWarSyncPersistenceState;
    persistedRevisionAt: Date | null;
  }> {
    const expectedSyncNumber = normalizeAssignmentSyncNumber(
      input.expectedSyncNumber,
    );
    const resolvedSyncNumber = normalizeAssignmentSyncNumber(
      input.resolvedSyncNumber,
    );
    const expectedRevisionAt = normalizeDate(input.expectedRevisionAt ?? null);
    if (
      expectedSyncNumber === null ||
      resolvedSyncNumber === null ||
      expectedSyncNumber === resolvedSyncNumber
    ) {
      return { state: "not_needed", persistedRevisionAt: null };
    }
    if (!expectedRevisionAt) {
      this.logExactSameWarReconciliation({
        ...input,
        expectedSyncNumber,
        resolvedSyncNumber,
        outcome: "revision_changed",
      });
      return { state: "revision_changed", persistedRevisionAt: null };
    }

    const dbClanTag = normalizeTag(input.clanTag) ?? "";
    const dbOpponentTag = input.identity.opponentTag
      ? normalizeTag(input.identity.opponentTag)
      : null;
    const assignmentRevisionAt = nextCurrentWarRevision(expectedRevisionAt);
    const where: Parameters<typeof prisma.currentWar.updateMany>[0]["where"] = {
      guildId: input.guildId,
      clanTag: dbClanTag,
      updatedAt: expectedRevisionAt,
      syncNumber: expectedSyncNumber,
      state: { in: ["preparation", "inWar"] },
      ...(input.identity.warStartTime
        ? { startTime: input.identity.warStartTime }
        : {}),
      ...(input.identity.opponentTag ? { opponentTag: dbOpponentTag } : {}),
      ...(input.identity.warId !== null
        ? { warId: Number(input.identity.warId) }
        : {}),
    };
    const updated = await prisma.currentWar.updateMany({
      where,
      data: {
        syncNumber: resolvedSyncNumber,
        updatedAt: assignmentRevisionAt,
      },
    });
    if (updated.count === 1) {
      this.logExactSameWarReconciliation({
        ...input,
        expectedSyncNumber,
        resolvedSyncNumber,
        outcome: "saved",
      });
      return { state: "saved", persistedRevisionAt: assignmentRevisionAt };
    }
    if (updated.count > 1) {
      this.logExactSameWarReconciliation({
        ...input,
        expectedSyncNumber,
        resolvedSyncNumber,
        outcome: "conflict",
      });
      return { state: "conflict", persistedRevisionAt: null };
    }

    const exactRow = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: dbClanTag,
        state: { in: ["preparation", "inWar"] },
        ...(input.identity.warStartTime
          ? { startTime: input.identity.warStartTime }
          : {}),
        ...(input.identity.opponentTag ? { opponentTag: dbOpponentTag } : {}),
        ...(input.identity.warId !== null
          ? { warId: Number(input.identity.warId) }
          : {}),
      },
      select: {
        syncNumber: true,
        warId: true,
        startTime: true,
        opponentTag: true,
        state: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (exactRow) {
      if (exactRow.updatedAt.getTime() !== expectedRevisionAt.getTime()) {
        this.logExactSameWarReconciliation({
          ...input,
          expectedSyncNumber,
          resolvedSyncNumber,
          outcome: "revision_changed",
        });
        return { state: "revision_changed", persistedRevisionAt: null };
      }
      if (
        normalizeAssignmentSyncNumber(exactRow.syncNumber) ===
        resolvedSyncNumber
      ) {
        this.logExactSameWarReconciliation({
          ...input,
          expectedSyncNumber,
          resolvedSyncNumber,
          outcome: "idempotent",
        });
        return { state: "idempotent", persistedRevisionAt: exactRow.updatedAt };
      }
      this.logExactSameWarReconciliation({
        ...input,
        expectedSyncNumber,
        resolvedSyncNumber,
        outcome: "conflict",
      });
      return { state: "conflict", persistedRevisionAt: null };
    }

    const replacementRow = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: dbClanTag,
        state: { in: ["preparation", "inWar"] },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        syncNumber: true,
        warId: true,
        startTime: true,
        opponentTag: true,
        updatedAt: true,
      },
    });
    const outcome = replacementRow ? "identity_changed" : "conflict";
    this.logExactSameWarReconciliation({
      ...input,
      expectedSyncNumber,
      resolvedSyncNumber,
      outcome,
    });
    return { state: outcome, persistedRevisionAt: null };
  }

  /** Purpose: emit bounded structured telemetry for exact same-war stale-sync repair outcomes. */
  private logExactSameWarReconciliation(input: {
    guildId: string;
    clanTag: string;
    identity: ActiveWarSyncIdentity;
    expectedSyncNumber: number;
    resolvedSyncNumber: number;
    outcome: Exclude<ActiveWarSyncPersistenceState, "not_needed">;
  }): void {
    const line =
      `[sync-assignment] stage=exact_same_war_reconcile` +
      ` guild=${input.guildId}` +
      ` clan=#${normalizeBareTag(input.clanTag) ?? "unknown"}` +
      ` war_id=${input.identity.warId ?? "none"}` +
      ` war_start=${input.identity.warStartTime?.toISOString() ?? "none"}` +
      ` opponent=${input.identity.opponentTag ? `#${input.identity.opponentTag}` : "none"}` +
      ` previous_sync=${input.expectedSyncNumber}` +
      ` resolved_sync=${input.resolvedSyncNumber}` +
      ` outcome=${input.outcome}`;
    if (
      input.outcome === "revision_changed" ||
      input.outcome === "identity_changed" ||
      input.outcome === "conflict"
    ) {
      console.warn(line);
      return;
    }
    if (input.outcome === "idempotent") {
      console.debug(line);
      return;
    }
    console.info(line);
  }

  /** Purpose: resolve validation status between the canonical row and exact same-war points data. */
  private resolveValidationState(input: {
    currentWarSyncNumber: number | null;
    sameWarPointsSyncNumber: number | null;
  }): ActiveWarSyncValidationState | null {
    const currentWarSyncNumber = normalizeAssignmentSyncNumber(
      input.currentWarSyncNumber,
    );
    const sameWarPointsSyncNumber = normalizeAssignmentSyncNumber(
      input.sameWarPointsSyncNumber,
    );
    if (currentWarSyncNumber === null && sameWarPointsSyncNumber === null) {
      return null;
    }
    if (currentWarSyncNumber !== null && sameWarPointsSyncNumber !== null) {
      return currentWarSyncNumber === sameWarPointsSyncNumber
        ? "matched"
        : "mismatch";
    }
    if (currentWarSyncNumber !== null) return "missing_external";
    return "missing_local";
  }
}
