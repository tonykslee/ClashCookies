import { PointsSyncService } from "./PointsSyncService";

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

function normalizeSyncNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
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
}
