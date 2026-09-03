import { normalizeClashTagBareInput } from "../helper/clashTag";
import { compareTagsForTiebreak, getSyncMode } from "../helper/fwaProjection";

type MatchType = "FWA" | "BL" | "MM" | "SKIP";

export type MatchTypeResolutionSource =
  | "confirmed_current_war"
  | "unconfirmed_current_war"
  | "stored_sync"
  | "live_points_clan_not_found"
  | "live_points_winner_box_not_marked_fwa"
  | "active_war_non_fwa_blacklist"
  | "active_war_non_fwa_mismatch"
  | "live_points_active_fwa_yes"
  | "live_points_active_fwa_no";

export type MatchTypeResolution = {
  matchType: MatchType;
  source: MatchTypeResolutionSource;
  inferred: boolean;
  confirmed: boolean;
  syncIsFwa: boolean | null;
};

export type PreparedMatchTypeFallbackResolution = {
  confirmedCurrent: MatchTypeResolution | null;
  storedSync: MatchTypeResolution | null;
  unconfirmedCurrent: MatchTypeResolution | null;
};

export type PreparedStoredSyncMatchRow = StoredSyncMatchTypeRow & {
  warId?: string | number | null;
  warStartTime?: Date | null;
  syncNum?: number | null;
  clanPoints?: number | null;
  opponentPoints?: number | null;
  outcome?: string | null;
  lastKnownOutcome?: string | null;
  needsValidation?: boolean | null;
};

export type StoredSyncMatchTypeRow = {
  opponentTag: string;
  isFwa: boolean | null;
  lastKnownMatchType?: string | null;
};

export type OpponentPointsMatchTypeSignal = {
  available: boolean;
  balance: number | null | undefined;
  activeFwa: boolean | null | undefined;
  notFound?: boolean | null | undefined;
  winnerBoxNotMarkedFwa?: boolean | null | undefined;
  opponentEvidenceMissingOrNotCurrent?: boolean | null | undefined;
  currentWarState?: "preparation" | "inWar" | "notInWar" | null | undefined;
  currentWarClanAttacksUsed?: number | null | undefined;
  currentWarClanStars?: number | null | undefined;
  currentWarOpponentStars?: number | null | undefined;
};

type CurrentWarMatchTypeSignal = {
  matchType: string | null | undefined;
  inferredMatchType: boolean | null | undefined;
};

export type MatchTypeWarIdentity = {
  warId?: string | number | null | undefined;
  warStartTime?: Date | null | undefined;
  opponentTag?: string | null | undefined;
};

function normalizeTag(input: string): string {
  return normalizeClashTagBareInput(input);
}

function normalizeWarId(input: string | number | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? String(normalized) : null;
}

function normalizeDate(input: Date | null | undefined): Date | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input : null;
}

/** Purpose: normalize persisted match-type strings into known values. */
export function normalizeStoredMatchType(raw: string | null | undefined): MatchType | null {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "FWA" || value === "BL" || value === "MM" || value === "SKIP") return value;
  return null;
}

/** Purpose: derive sync isFwa signal from resolved match type when explicit signal is absent. */
export function toSyncIsFwa(matchType: MatchType | null): boolean | null {
  if (matchType === "FWA") return true;
  if (matchType === "BL" || matchType === "MM") return false;
  return null;
}

/** Purpose: compare persisted and active current-war identity before trusting current-war match state. */
export function compareActiveWarIdentities(input: {
  persisted: MatchTypeWarIdentity;
  active: MatchTypeWarIdentity;
}): { sameWar: boolean; identityChanged: boolean } {
  const persistedWarStartTime = normalizeDate(input.persisted.warStartTime ?? null);
  const activeWarStartTime = normalizeDate(input.active.warStartTime ?? null);
  const persistedOpponentTag = normalizeTag(String(input.persisted.opponentTag ?? ""));
  const activeOpponentTag = normalizeTag(String(input.active.opponentTag ?? ""));
  const persistedWarId = normalizeWarId(input.persisted.warId ?? null);
  const activeWarId = normalizeWarId(input.active.warId ?? null);

  const startTimeMatches =
    persistedWarStartTime !== null && activeWarStartTime !== null
      ? persistedWarStartTime.getTime() === activeWarStartTime.getTime()
      : null;
  const opponentTagMatches =
    persistedOpponentTag && activeOpponentTag
      ? persistedOpponentTag === activeOpponentTag
      : null;
  const warIdMatches =
    persistedWarId !== null && activeWarId !== null
      ? persistedWarId === activeWarId
      : null;

  return {
    sameWar:
      startTimeMatches === true &&
      opponentTagMatches === true &&
      warIdMatches !== false,
    identityChanged:
      startTimeMatches === false ||
      opponentTagMatches === false ||
      warIdMatches === false,
  };
}

/** Purpose: split current-war match type into confirmed vs unconfirmed candidates. */
export function resolveCurrentWarMatchTypeSignal(
  signal: CurrentWarMatchTypeSignal
): { confirmed: MatchTypeResolution | null; unconfirmed: MatchTypeResolution | null } {
  const current = normalizeStoredMatchType(signal.matchType);
  if (!current) {
    return { confirmed: null, unconfirmed: null };
  }
  const isConfirmed = signal.inferredMatchType === false;
  const base: Omit<MatchTypeResolution, "source" | "inferred" | "confirmed"> = {
    matchType: current,
    syncIsFwa: toSyncIsFwa(current),
  };
  if (isConfirmed) {
    return {
      confirmed: {
        ...base,
        source: "confirmed_current_war",
        inferred: false,
        confirmed: true,
      },
      unconfirmed: null,
    };
  }
  return {
    confirmed: null,
    unconfirmed: {
      ...base,
      source: "unconfirmed_current_war",
      inferred: true,
      confirmed: false,
    },
  };
}

/** Purpose: map stored sync metadata to fallback match type for matching opponent context. */
export function resolveMatchTypeFromStoredSyncRow(params: {
  syncRow: StoredSyncMatchTypeRow | null;
  opponentTag: string;
}): MatchTypeResolution | null {
  if (!params.syncRow) return null;
  const syncOpponent = normalizeTag(params.syncRow.opponentTag ?? "");
  const requestedOpponent = normalizeTag(params.opponentTag);
  if (!syncOpponent || syncOpponent !== requestedOpponent) return null;

  const storedType = normalizeStoredMatchType(params.syncRow.lastKnownMatchType);
  if (storedType) {
    return {
      matchType: storedType,
      source: "stored_sync",
      inferred: true,
      confirmed: false,
      syncIsFwa: params.syncRow.isFwa ?? toSyncIsFwa(storedType),
    };
  }
  if (params.syncRow.isFwa === true) {
    return {
      matchType: "FWA",
      source: "stored_sync",
      inferred: true,
      confirmed: false,
      syncIsFwa: true,
    };
  }
  if (params.syncRow.isFwa === false) {
    return {
      matchType: "BL",
      source: "stored_sync",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    };
  }
  return null;
}

/** Purpose: infer match type from live opponent points-site signals. */
export function inferMatchTypeFromOpponentPoints(
  signal: OpponentPointsMatchTypeSignal
): MatchTypeResolution | null {
  const winnerBoxFallback =
    signal.winnerBoxNotMarkedFwa === true &&
    signal.opponentEvidenceMissingOrNotCurrent === true;
  if (signal.available) {
    const hasOpponentPoints =
      signal.balance !== null &&
      signal.balance !== undefined &&
      !Number.isNaN(Number(signal.balance)) &&
      Number.isFinite(Number(signal.balance));
    if (hasOpponentPoints) {
      if (signal.activeFwa === false) {
        return {
          matchType: "BL",
          source: "live_points_active_fwa_no",
          inferred: true,
          confirmed: false,
          syncIsFwa: false,
        };
      }
      if (signal.activeFwa === true) {
        return {
          matchType: "FWA",
          source: "live_points_active_fwa_yes",
          inferred: true,
          confirmed: false,
          syncIsFwa: true,
        };
      }
    }
  }
  const activeWarNonFwaResolution = resolveNonFwaMatchTypeFromActiveWarEvidence({
    nonFwaEvidencePresent: winnerBoxFallback || signal.notFound === true,
    currentWarState: signal.currentWarState ?? null,
    currentWarClanAttacksUsed: signal.currentWarClanAttacksUsed ?? null,
    currentWarClanStars: signal.currentWarClanStars ?? null,
    currentWarOpponentStars: signal.currentWarOpponentStars ?? null,
  });
  if (activeWarNonFwaResolution) {
    return activeWarNonFwaResolution;
  } 
  if (signal.notFound === true || winnerBoxFallback) {
    return {
      matchType: "MM",
      source: "live_points_clan_not_found",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    };
  }
  return null;
}

/** Purpose: resolve opponent-missing non-FWA BL/MM from explicit active-war battle evidence only. */
export function resolveNonFwaMatchTypeFromActiveWarEvidence(input: {
  nonFwaEvidencePresent: boolean;
  currentWarState: "preparation" | "inWar" | "notInWar" | null;
  currentWarClanAttacksUsed: number | null;
  currentWarClanStars: number | null;
  currentWarOpponentStars: number | null;
}): MatchTypeResolution | null {
  if (!input.nonFwaEvidencePresent) return null;
  const clanAttacksUsed =
    input.currentWarClanAttacksUsed !== null &&
    input.currentWarClanAttacksUsed !== undefined &&
    Number.isFinite(input.currentWarClanAttacksUsed)
      ? Math.trunc(input.currentWarClanAttacksUsed)
      : null;
  const clanStars =
    input.currentWarClanStars !== null &&
    input.currentWarClanStars !== undefined &&
    Number.isFinite(input.currentWarClanStars)
      ? Math.trunc(input.currentWarClanStars)
      : null;
  const opponentStars =
    input.currentWarOpponentStars !== null &&
    input.currentWarOpponentStars !== undefined &&
    Number.isFinite(input.currentWarOpponentStars)
      ? Math.trunc(input.currentWarOpponentStars)
      : null;

  if ((clanAttacksUsed !== null && clanAttacksUsed > 0) || (clanStars !== null && clanStars > 0)) {
    return {
      matchType: "MM",
      source: "active_war_non_fwa_mismatch",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    };
  }
  if (
    input.currentWarState === "inWar" &&
    clanAttacksUsed === 0 &&
    opponentStars !== null &&
    opponentStars > 0
  ) {
    return {
      matchType: "BL",
      source: "active_war_non_fwa_blacklist",
      inferred: true,
      confirmed: false,
      syncIsFwa: false,
    };
  }
  return null;
}

/** Purpose: apply deterministic precedence across confirmed, live, stored, and unconfirmed signals. */
export function chooseMatchTypeResolution(input: {
  confirmedCurrent: MatchTypeResolution | null;
  liveOpponent: MatchTypeResolution | null;
  storedSync: MatchTypeResolution | null;
  unconfirmedCurrent: MatchTypeResolution | null;
}): MatchTypeResolution | null {
  return (
    input.confirmedCurrent ??
    input.liveOpponent ??
    input.storedSync ??
    input.unconfirmedCurrent ??
    null
  );
}

/** Purpose: resolve the command and checklist fallback from one current-war identity and prepared same-war sync row. */
export function resolveMatchTypeWithPreparedStoredSync(input: {
  opponentTag: string;
  warState: "preparation" | "inWar" | "notInWar";
  currentWarId?: number | string | null;
  currentWarStartTime?: Date | null;
  currentWarOpponentTag?: string | null;
  activeWarId?: number | string | null;
  activeWarStartTime?: Date | null;
  activeOpponentTag?: string | null;
  existingMatchType: "FWA" | "BL" | "MM" | "SKIP" | null | undefined;
  existingInferredMatchType?: boolean | null | undefined;
  storedSyncRow?: PreparedStoredSyncMatchRow | null;
}): PreparedMatchTypeFallbackResolution {
  const sameActiveWar =
    input.warState === "notInWar"
      ? true
      : compareActiveWarIdentities({
          persisted: {
            warId: input.currentWarId ?? null,
            warStartTime: input.currentWarStartTime ?? null,
            opponentTag: input.currentWarOpponentTag ?? null,
          },
          active: {
            warId: input.activeWarId ?? null,
            warStartTime: input.activeWarStartTime ?? null,
            opponentTag: input.activeOpponentTag ?? input.opponentTag,
          },
        }).sameWar;
  const currentResolution = resolveCurrentWarMatchTypeSignal({
    matchType: sameActiveWar ? (input.existingMatchType ?? null) : null,
    inferredMatchType: sameActiveWar
      ? (input.existingInferredMatchType ?? true)
      : true,
  });
  const lookupWarId =
    input.warState === "notInWar"
      ? (input.currentWarId ?? input.activeWarId ?? null)
      : (input.activeWarId ?? null);
  const lookupWarStartTime =
    input.warState === "notInWar"
      ? (input.currentWarStartTime ?? input.activeWarStartTime ?? null)
      : (input.activeWarStartTime ?? null);
  const lookupOpponentTag =
    input.warState === "notInWar"
      ? (input.currentWarOpponentTag ?? input.activeOpponentTag ?? input.opponentTag)
      : (input.activeOpponentTag ?? input.opponentTag);
  const hasWarIdentity =
    (lookupWarId !== null &&
      lookupWarId !== undefined &&
      Number.isFinite(Number(lookupWarId))) ||
    lookupWarStartTime instanceof Date;
  const storedSync =
    hasWarIdentity && input.storedSyncRow
      ? resolveMatchTypeFromStoredSyncRow({
          syncRow: input.storedSyncRow,
          opponentTag: lookupOpponentTag,
        })
      : null;
  return {
    confirmedCurrent: currentResolution.confirmed,
    storedSync,
    unconfirmedCurrent: currentResolution.unconfirmed,
  };
}

/** Purpose: reproduce the existing FWA points/tiebreak projection for a prepared sync row. */
export function deriveFwaProjectedOutcomeFromPreparedSync(input: {
  clanTag: string;
  opponentTag: string;
  clanPoints?: number | null;
  opponentPoints?: number | null;
  syncNum?: number | null;
}): "WIN" | "LOSE" | null {
  const clanPoints = input.clanPoints ?? null;
  const opponentPoints = input.opponentPoints ?? null;
  if (
    clanPoints === null ||
    opponentPoints === null ||
    Number.isNaN(clanPoints) ||
    Number.isNaN(opponentPoints) ||
    !Number.isFinite(clanPoints) ||
    !Number.isFinite(opponentPoints)
  ) {
    return null;
  }
  if (clanPoints > opponentPoints) return "WIN";
  if (clanPoints < opponentPoints) return "LOSE";
  const syncNum =
    input.syncNum !== null && input.syncNum !== undefined && Number.isFinite(input.syncNum)
      ? Math.trunc(input.syncNum)
      : null;
  const mode = getSyncMode(syncNum);
  if (!mode) return null;
  const cmp = compareTagsForTiebreak(input.clanTag, input.opponentTag);
  if (cmp === 0) return null;
  return (mode === "low" ? cmp < 0 : cmp > 0) ? "WIN" : "LOSE";
}

/** Purpose: resolve FWA outcome with confirmed-current precedence and safe projected fallback. */
export function resolveFwaOutcomeFromPreparedEvidence(input: {
  matchType: string | null | undefined;
  currentOutcome?: string | null;
  currentOutcomeConfirmed?: boolean;
  projectedOutcome?: string | null;
  clanTag?: string | null;
  opponentTag?: string | null;
  storedSyncRow?: Pick<
    PreparedStoredSyncMatchRow,
    | "outcome"
    | "lastKnownOutcome"
    | "syncNum"
    | "clanPoints"
    | "opponentPoints"
    | "opponentTag"
  > | null;
}): "WIN" | "LOSE" | "UNKNOWN" | null {
  if (normalizeStoredMatchType(input.matchType) !== "FWA") return null;
  const confirmedCurrentOutcome =
    input.currentOutcomeConfirmed === true
      ? toWinLoseOutcome(input.currentOutcome ?? null)
      : null;
  const projectedOutcome = toWinLoseOutcome(input.projectedOutcome ?? null);
  const storedOutcome =
    toWinLoseOutcome(input.storedSyncRow?.outcome ?? null) ??
    toWinLoseOutcome(input.storedSyncRow?.lastKnownOutcome ?? null);
  const preparedProjection =
    input.clanTag && (input.opponentTag ?? input.storedSyncRow?.opponentTag)
      ? deriveFwaProjectedOutcomeFromPreparedSync({
          clanTag: input.clanTag,
          opponentTag: input.opponentTag ?? input.storedSyncRow?.opponentTag ?? "",
          clanPoints: input.storedSyncRow?.clanPoints ?? null,
          opponentPoints: input.storedSyncRow?.opponentPoints ?? null,
          syncNum: input.storedSyncRow?.syncNum ?? null,
        })
      : null;
  return (
    confirmedCurrentOutcome ??
    projectedOutcome ??
    storedOutcome ??
    preparedProjection ??
    "UNKNOWN"
  );
}

function toWinLoseOutcome(
  value: string | null | undefined,
): "WIN" | "LOSE" | null {
  const normalized = normalizeOutcomeValue(value);
  return normalized === "WIN" || normalized === "LOSE" ? normalized : null;
}

function normalizeOutcomeValue(
  value: string | null | undefined,
): "WIN" | "LOSE" | "UNKNOWN" | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "WIN" || normalized === "LOSE" || normalized === "UNKNOWN") {
    return normalized;
  }
  return null;
}
