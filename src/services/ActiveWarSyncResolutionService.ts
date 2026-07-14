import { prisma } from "../prisma";
import { PointsSyncService } from "./PointsSyncService";
import { isMirrorPollingMode } from "./PollingModeService";

export type ActiveWarSyncState = "preparation" | "inWar" | "notInWar";

export type ActiveWarSyncResolutionSource =
  | "same_war_persisted"
  | "refresh_posted_sync"
  | "derived_latest_plus_one"
  | "historical_latest_persisted"
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
  | "active_cycle_reuse"
  | "active_cycle_conflict"
  | "allocated_latest_plus_one"
  | "same_war_points_recovery"
  | "not_fwa"
  | "identity_incomplete"
  | "mirror_mode"
  | "unavailable";

export type ActiveWarSyncValidationState =
  | "matched"
  | "missing_local"
  | "missing_external"
  | "mismatch";

export type ActiveWarSyncPersistenceState =
  | "saved"
  | "idempotent"
  | "conflict"
  | "identity_changed"
  | "not_needed";

export type ActiveWarSyncPollCycle = {
  activeSyncNumber: number | null;
  recordActiveSyncNumber: (syncNumber: number) => void;
};

export type ResolveOrAllocateActiveWarSyncNumberInput = {
  guildId: string;
  clanTag: string;
  identity: ActiveWarSyncIdentity;
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

function normalizeTag(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
  return normalized ? normalized : null;
}

function normalizeWarId(input: string | number | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  return raw ? raw : null;
}

function normalizeDate(value: Date | null | undefined): Date | null {
  if (!(value instanceof Date)) return null;
  return Number.isFinite(value.getTime()) ? value : null;
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
  const normalized = String(state ?? "").trim().toLowerCase();
  return normalized === "preparation" || normalized === "inwar";
}

/** Purpose: classify the strongest FWA evidence available for guarded allocation. */
function classifyFwaEvidence(input: {
  matchType?: string | null;
  inferredMatchType?: boolean | null;
}): "confirmed_fwa" | "strongly_inferred_fwa" | "not_fwa" | "unresolved" {
  const matchType = String(input.matchType ?? "").trim().toUpperCase();
  if (matchType === "FWA") return "confirmed_fwa";
  if (matchType === "BL" || matchType === "MM" || matchType === "SKIP") {
    return "not_fwa";
  }
  if (matchType) return "unresolved";
  if (input.inferredMatchType === true) return "strongly_inferred_fwa";
  if (input.inferredMatchType === false) return "unresolved";
  return "unresolved";
}

/** Purpose: normalize an assignment value used for persisted sync rows and logs. */
function normalizeAssignmentSyncNumber(value: number | null | undefined): number | null {
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

/** Purpose: keep only active canonical rows that can legitimately seed the current FWA cycle. */
function isEligibleActiveCycleSyncCandidate(candidate: ActiveCycleSyncCandidate): boolean {
  const evidence = classifyFwaEvidence({
    matchType: candidate.matchType,
    inferredMatchType: candidate.inferredMatchType,
  });
  return evidence === "confirmed_fwa" || evidence === "strongly_inferred_fwa";
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
  const opponentTag = normalizeTag(input.opponentTag ?? null);
  const isActiveWar =
    input.warState === "preparation" || input.warState === "inWar";
  const positivelyResolved =
    isActiveWar && (warId !== null || (warStartTime !== null && opponentTag !== null));
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
  const liveOpponentTag = normalizeTag(input.liveOpponentTag ?? null);
  const currentWarOpponentTag = normalizeTag(input.currentWarOpponentTag ?? null);
  const currentWarId = normalizeWarId(input.currentWarId ?? null);
  const clanTag = normalizeTag(input.clanTag ?? null);

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
  postedSyncNumber?: number | null;
  allowPostedSyncReuse?: boolean;
}): ActiveWarSyncResolutionResult {
  const latestPersistedSyncNumber = normalizeSyncNumber(
    input.latestPersistedSyncNumber,
  );
  const sameWarPersistedSyncNumber = normalizeSyncNumber(
    input.sameWarPersistedSyncNumber,
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
    input.identity.warState === "preparation" || input.identity.warState === "inWar";
  if (isActiveWar) {
    if (input.identity.positivelyResolved && latestPersistedSyncNumber !== null) {
      return {
        syncNumber: latestPersistedSyncNumber + 1,
        source: "derived_latest_plus_one",
        isDerived: true,
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
    ` clan=#${normalizeTag(input.clanTag) ?? "unknown"}` +
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
  if (input.resolution.source === "derived_latest_plus_one" || input.resolution.source === "none") {
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
  const line =
    `[sync-assignment] stage=${input.stage} guild=${String(input.guildId ?? "none")}` +
    ` clan=#${normalizeTag(input.clanTag) ?? "unknown"}` +
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
    ` resolved_sync=${input.resolution.syncNumber ?? "none"}`;
  if (
    input.resolution.persistence === "conflict" ||
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
  constructor(private readonly pointsSync = new PointsSyncService()) {}

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
    const clanTag = normalizeTag(input.clanTag) ?? "";
    const currentWarCanonicalSyncNumber = normalizeAssignmentSyncNumber(
      input.currentWarSyncNumber ?? null,
    );
    const currentWarLegacySyncNumber = normalizeAssignmentSyncNumber(
      input.currentWarLegacySyncNumber ?? null,
    );
    const currentWarSyncNumber =
      currentWarCanonicalSyncNumber ?? currentWarLegacySyncNumber;
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
    const activeCycleDiscovery =
      cachedActiveSyncNumber !== null
        ? {
            syncNumber: cachedActiveSyncNumber,
            conflict: false,
            candidates: [] as ActiveCycleSyncCandidate[],
          }
        : await this.findPersistedActiveSyncNumber();
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
        syncNumber: currentWarSyncNumber,
        proposedSyncNumber: null,
        usable: currentWarSyncNumber !== null,
        source: "mirror_mode",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: currentWarSyncNumber,
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

    if (currentWarCanonicalSyncNumber !== null) {
      input.pollCycle?.recordActiveSyncNumber(currentWarCanonicalSyncNumber);
      return finish("existing_current_war", {
        syncNumber: currentWarCanonicalSyncNumber,
        proposedSyncNumber: currentWarCanonicalSyncNumber,
        usable: true,
        source: "existing_current_war",
        shouldPersist: false,
        persistence: "not_needed",
        ...baseResult,
        persistedSyncNumber: currentWarCanonicalSyncNumber,
        persistedRevisionAt: null,
      });
    }

    if (currentWarLegacySyncNumber !== null) {
      if (!allowAllocation) {
        return finish("existing_current_war_legacy", {
          syncNumber: null,
          proposedSyncNumber: currentWarLegacySyncNumber,
          usable: false,
          source: "existing_current_war",
          shouldPersist: false,
          persistence: "not_needed",
          ...baseResult,
          persistedSyncNumber: null,
          persistedRevisionAt: null,
        });
      }
      const persistence = await this.persistCurrentWarSyncNumber({
        guildId,
        clanTag,
        identity: input.identity,
        syncNumber: currentWarLegacySyncNumber,
        revisionAt: new Date(),
      });
      const usable =
        persistence.state === "saved" || persistence.state === "idempotent";
      if (usable) {
        input.pollCycle?.recordActiveSyncNumber(currentWarLegacySyncNumber);
      }
      return finish("existing_current_war_legacy", {
        syncNumber: usable ? currentWarLegacySyncNumber : null,
        proposedSyncNumber: currentWarLegacySyncNumber,
        usable,
        source: "existing_current_war",
        shouldPersist: persistence.state === "saved",
        persistence: persistence.state,
        ...baseResult,
        persistedSyncNumber: usable ? currentWarLegacySyncNumber : null,
        persistedRevisionAt: persistence.persistedRevisionAt,
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
      const persistence = await this.persistCurrentWarSyncNumber({
        guildId,
        clanTag,
        identity: input.identity,
        syncNumber: sameWarPointsSyncNumber,
        revisionAt: new Date(),
      });
      const usable =
        persistence.state === "saved" || persistence.state === "idempotent";
      if (usable && input.pollCycle && input.pollCycle.activeSyncNumber === null) {
        input.pollCycle.recordActiveSyncNumber(sameWarPointsSyncNumber);
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
        persistedRevisionAt: persistence.persistedRevisionAt,
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
      const persistence = await this.persistCurrentWarSyncNumber({
        guildId,
        clanTag,
        identity: input.identity,
        syncNumber: activeSyncNumber,
        revisionAt: new Date(),
      });
      const usable =
        persistence.state === "saved" || persistence.state === "idempotent";
      if (usable && input.pollCycle && input.pollCycle.activeSyncNumber === null) {
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
        persistedRevisionAt: persistence.persistedRevisionAt,
      });
    }

    const latestPersistedSyncNumber = baseResult.latestPersistedSyncNumber;
    if (latestPersistedSyncNumber === null) {
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

    const allocatedSyncNumber = latestPersistedSyncNumber + 1;
    const persistence = await this.persistCurrentWarSyncNumber({
      guildId,
      clanTag,
      identity: input.identity,
      syncNumber: allocatedSyncNumber,
      revisionAt: new Date(),
    });
    const usable =
      persistence.state === "saved" || persistence.state === "idempotent";
    if (usable) {
      input.pollCycle?.recordActiveSyncNumber(allocatedSyncNumber);
    }
    return finish("allocated_latest_plus_one", {
      syncNumber: usable ? allocatedSyncNumber : null,
      proposedSyncNumber: allocatedSyncNumber,
      usable,
      source: "allocated_latest_plus_one",
      shouldPersist: persistence.state === "saved",
      persistence: persistence.state,
      ...baseResult,
      persistedSyncNumber: usable ? allocatedSyncNumber : null,
      persistedRevisionAt: persistence.persistedRevisionAt,
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
        syncNumber: { not: null },
      },
      select: {
        guildId: true,
        clanTag: true,
        warId: true,
        syncNumber: true,
        startTime: true,
        opponentTag: true,
        matchType: true,
        inferredMatchType: true,
      },
    });
    const candidates = rows
      .map((row) => ({
        guildId: row.guildId,
        clanTag: row.clanTag,
        warId:
          row.warId !== null && row.warId !== undefined
            ? Math.trunc(Number(row.warId))
            : null,
        startTime: row.startTime ?? null,
        opponentTag: normalizeTag(row.opponentTag ?? null),
        syncNumber: normalizeAssignmentSyncNumber(row.syncNumber ?? null),
        matchType: row.matchType ?? null,
        inferredMatchType: row.inferredMatchType ?? null,
      }))
      .filter((row) => row.syncNumber !== null && isEligibleActiveCycleSyncCandidate(row));
    const distinctSyncNumbers = Array.from(
      new Set(
        candidates.map((row) => normalizeAssignmentSyncNumber(row.syncNumber)).filter(
          (syncNumber): syncNumber is number => syncNumber !== null,
        ),
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
          .map((row) =>
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

  /** Purpose: persist one canonical sync number to the exact current-war identity. */
  private async persistCurrentWarSyncNumber(input: {
    guildId: string;
    clanTag: string;
    identity: ActiveWarSyncIdentity;
    syncNumber: number;
    revisionAt: Date;
  }): Promise<{
    state: ActiveWarSyncPersistenceState;
    persistedRevisionAt: Date | null;
  }> {
    const syncNumber = normalizeAssignmentSyncNumber(input.syncNumber);
    if (syncNumber === null) {
      return { state: "not_needed", persistedRevisionAt: null };
    }
    const revisionAt =
      input.revisionAt instanceof Date && Number.isFinite(input.revisionAt.getTime())
        ? input.revisionAt
        : new Date();
    const where: Parameters<typeof prisma.currentWar.updateMany>[0]["where"] = {
      guildId: input.guildId,
      clanTag: normalizeTag(input.clanTag) ?? "",
      syncNumber: null,
      state: { in: ["preparation", "inWar"] },
      ...(input.identity.warStartTime
        ? { startTime: input.identity.warStartTime }
        : {}),
      ...(input.identity.opponentTag
        ? { opponentTag: input.identity.opponentTag }
        : {}),
      ...(input.identity.warId !== null
        ? { warId: Number(input.identity.warId) }
        : {}),
    };

    const updated = await prisma.currentWar.updateMany({
      where,
      data: {
        syncNumber,
        updatedAt: revisionAt,
      },
    });
    if (updated.count === 1) {
      return { state: "saved", persistedRevisionAt: revisionAt };
    }
    if (updated.count > 1) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=conflict guild=${input.guildId} clan=#${normalizeTag(input.clanTag) ?? "unknown"} proposed_sync=${syncNumber} updated_count=${updated.count}`,
      );
      return { state: "conflict", persistedRevisionAt: null };
    }

    const exactRow = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: normalizeTag(input.clanTag) ?? "",
        state: { in: ["preparation", "inWar"] },
        ...(input.identity.warStartTime
          ? { startTime: input.identity.warStartTime }
          : {}),
        ...(input.identity.opponentTag
          ? { opponentTag: input.identity.opponentTag }
          : {}),
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
      },
      orderBy: { updatedAt: "desc" },
    });
    if (
      exactRow?.syncNumber !== null &&
      exactRow?.syncNumber !== undefined &&
      normalizeAssignmentSyncNumber(exactRow.syncNumber) === syncNumber
    ) {
      return { state: "idempotent", persistedRevisionAt: null };
    }
    if (
      exactRow?.syncNumber !== null &&
      exactRow?.syncNumber !== undefined &&
      normalizeAssignmentSyncNumber(exactRow.syncNumber) !== syncNumber
    ) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=conflict guild=${input.guildId} clan=#${normalizeTag(input.clanTag) ?? "unknown"} proposed_sync=${syncNumber} persisted_sync=${normalizeAssignmentSyncNumber(exactRow.syncNumber) ?? "none"} war_id=${exactRow.warId ?? "none"} war_start=${exactRow.startTime?.toISOString() ?? "none"} opponent=${exactRow.opponentTag ? `#${normalizeTag(exactRow.opponentTag) ?? "unknown"}` : "none"}`,
      );
      return { state: "conflict", persistedRevisionAt: null };
    }

    const replacementRow = await prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        clanTag: normalizeTag(input.clanTag) ?? "",
        state: { in: ["preparation", "inWar"] },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        syncNumber: true,
        warId: true,
        startTime: true,
        opponentTag: true,
      },
    });
    if (
      replacementRow &&
      (
        normalizeAssignmentSyncNumber(replacementRow.syncNumber) !== null ||
        replacementRow.warId !== exactRow?.warId ||
        replacementRow.startTime?.getTime() !== exactRow?.startTime?.getTime() ||
        normalizeTag(replacementRow.opponentTag ?? "") !== normalizeTag(exactRow?.opponentTag ?? "")
      )
    ) {
      console.warn(
        `[sync-assignment] stage=persist_current_war source=identity_changed guild=${input.guildId} clan=#${normalizeTag(input.clanTag) ?? "unknown"} proposed_sync=${syncNumber} previous_identity=war_id:${exactRow?.warId ?? "none"}|war_start:${exactRow?.startTime?.toISOString() ?? "none"}|opponent:${exactRow?.opponentTag ? `#${normalizeTag(exactRow.opponentTag) ?? "unknown"}` : "none"} replacement_identity=war_id:${replacementRow.warId ?? "none"}|war_start:${replacementRow.startTime?.toISOString() ?? "none"}|opponent:${replacementRow.opponentTag ? `#${normalizeTag(replacementRow.opponentTag) ?? "unknown"}` : "none"}`,
      );
      return { state: "identity_changed", persistedRevisionAt: null };
    }
    return { state: "conflict", persistedRevisionAt: null };
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
    if (
      currentWarSyncNumber === null &&
      sameWarPointsSyncNumber === null
    ) {
      return null;
    }
    if (
      currentWarSyncNumber !== null &&
      sameWarPointsSyncNumber !== null
    ) {
      return currentWarSyncNumber === sameWarPointsSyncNumber
        ? "matched"
        : "mismatch";
    }
    if (currentWarSyncNumber !== null) return "missing_external";
    return "missing_local";
  }
}
