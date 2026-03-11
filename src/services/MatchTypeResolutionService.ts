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

export type StoredSyncMatchTypeRow = {
  opponentTag: string;
  isFwa: boolean | null;
  lastKnownMatchType: string | null;
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

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
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
  if (winnerBoxFallback) {
    return null;
  }
  if (signal.notFound === true) {
    return null;
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
