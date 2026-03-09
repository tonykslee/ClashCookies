export type SyncActionSiteMatchType = "FWA" | "MM" | null;
export type SyncActionOutcome = "WIN" | "LOSE" | null;

function normalizeMatchType(value: string | null | undefined): "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  if (
    normalized !== "FWA" &&
    normalized !== "BL" &&
    normalized !== "MM" &&
    normalized !== "SKIP" &&
    normalized !== "UNKNOWN"
  ) {
    return null;
  }
  return normalized;
}

function normalizeOutcome(value: string | null | undefined): "WIN" | "LOSE" | "UNKNOWN" | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  if (normalized !== "WIN" && normalized !== "LOSE" && normalized !== "UNKNOWN") return null;
  return normalized;
}

/** Purpose: derive sync action outcome from site-inferred match type, not persisted match type. */
export function deriveSyncActionSiteOutcome(input: {
  siteMatchType: SyncActionSiteMatchType;
  projectedOutcome: SyncActionOutcome;
}): SyncActionOutcome {
  if (input.siteMatchType !== "FWA") return null;
  return input.projectedOutcome ?? null;
}

function pointsAlignedIfKnown(
  persisted: number | null | undefined,
  site: number | null | undefined
): boolean {
  if (
    persisted === null ||
    persisted === undefined ||
    site === null ||
    site === undefined ||
    !Number.isFinite(persisted) ||
    !Number.isFinite(site)
  ) {
    return true;
  }
  return Math.trunc(persisted) === Math.trunc(site);
}

/** Purpose: evaluate if persisted CurrentWar fields align with the Sync Data payload after apply. */
export function evaluatePostSyncValidation(input: {
  persistedMatchType: string | null | undefined;
  persistedOutcome: string | null | undefined;
  persistedFwaPoints: number | null | undefined;
  persistedOpponentFwaPoints: number | null | undefined;
  siteMatchType: SyncActionSiteMatchType;
  siteOutcome: SyncActionOutcome;
  siteFwaPoints: number | null;
  siteOpponentFwaPoints: number | null;
}): {
  matchTypeAligned: boolean;
  outcomeAligned: boolean;
  pointsAligned: boolean;
  fullyAligned: boolean;
} {
  const persistedMatchType = normalizeMatchType(input.persistedMatchType);
  const persistedOutcome = normalizeOutcome(input.persistedOutcome);
  const matchTypeAligned =
    input.siteMatchType === null || persistedMatchType === input.siteMatchType;
  const outcomeAligned =
    input.siteMatchType !== "FWA" ||
    input.siteOutcome === null ||
    persistedOutcome === input.siteOutcome;
  const pointsAligned =
    pointsAlignedIfKnown(input.persistedFwaPoints, input.siteFwaPoints) &&
    pointsAlignedIfKnown(input.persistedOpponentFwaPoints, input.siteOpponentFwaPoints);
  return {
    matchTypeAligned,
    outcomeAligned,
    pointsAligned,
    fullyAligned: matchTypeAligned && outcomeAligned && pointsAligned,
  };
}

/** Purpose: detect rendered outcome-mismatch text for post-sync convergence telemetry. */
export function hasRenderedOutcomeMismatch(description: string): boolean {
  return /\boutcome mismatch\b/i.test(description);
}
