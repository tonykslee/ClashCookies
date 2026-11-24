import type {
  HeatMapRef,
  FwaClanMemberCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
  FwaFeedSyncStatus,
  TrackedClan,
} from "@prisma/client";
import {
  toPositiveCompoWeight,
} from "../helper/compoActualWeight";
import {
  getCompoActualStateViewLabel,
  calculateCompoDeviationScore,
  isCompoActualStateDeviationHealthy,
  isCompoActualStateProjectionComplete,
  projectCompoActualStateView,
  hasUnsupportedCompoTh19Target,
  type CompoActualStateBaseMetrics,
  type CompoActualStateProjection,
  type CompoActualStateView,
  type CompoActualRosterCoverage,
  type CompoActualRosterSourceStatus,
} from "../helper/compoActualStateView";
import { findHeatMapRefForWeight, getHeatMapRefBandKey } from "../helper/compoHeatMap";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  EMPTY_COMPO_WAR_BUCKET_COUNTS,
  collapseCompoWarBucketCountsForDisplay,
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import {
  getCompoWarWeightBucket,
  type CompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import { prisma } from "../prisma";
import { resolveEffectivePlayerWeight } from "../helper/effectiveWeightResolution";
import {
  listOpenDeferredWeightsByClanAndPlayerTags,
  normalizePlayerTag,
} from "./WeightInputDefermentService";
import { normalizeTag } from "./war-events/core";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import {
  type HeatMapRefHistoricalReferenceAvailability,
  type HeatMapRefReferenceAvailability,
} from "../helper/heatMapRefAvailability";
import { resolveHeatMapRefReference } from "../helper/heatMapRefResolver";
import {
  calculateNativeCompoComparison,
  NATIVE_COMPO_COMPARISON_BUCKETS,
  type NativeCompoComparison,
} from "../helper/nativeCompoComparison";
import { NativeHeatMapReferencePublicationService } from "./NativeHeatMapReferencePublicationService";
import {
  getConfiguredClanMembersCadenceMinutes,
  getHomeRosterCoverage,
} from "./HomeRosterService";
import {
  computeClanMembersSnapshotHash,
  toPersistedClanMembersSnapshotRow,
} from "./fwa-feeds/clanMembersSnapshot";

type TrackedClanRow = Pick<TrackedClan, "tag" | "name"> & {
  shortName?: string | null;
};
type CurrentMemberRow = Pick<
  FwaClanMemberCurrent,
  | "clanTag"
  | "playerTag"
  | "playerName"
  | "role"
  | "level"
  | "donated"
  | "received"
  | "rank"
  | "trophies"
  | "league"
  | "townHall"
  | "weight"
  | "inWar"
  | "sourceSyncedAt"
>;
type ClanMembersSyncStateRow = {
  scopeKey: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: FwaFeedSyncStatus;
  lastRowCount: number | null;
  lastChangedRowCount: number | null;
  lastContentHash: string | null;
};
type WarFallbackRow = Pick<
  FwaTrackedClanWarRosterMemberCurrent,
  "clanTag" | "playerTag" | "effectiveWeight" | "updatedAt"
>;

type CompoActualDiagnosticsSurface = "state" | "advice";
type CompoActualDiagnosticsCoverageReason =
  | "no_heatmap_refs"
  | "out_of_range_low"
  | "out_of_range_high"
  | "coverage_gap"
  | "selected";

export type CompoActualStateClanContext = {
  clanTag: string;
  clanName: string;
  shortName: string | null;
  sourceSyncedAt?: Date | null;
  base: CompoActualStateBaseMetrics;
  members: CompoActualStateMemberContext[];
};

export type CompoActualStateMemberContext = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  resolvedWeight: number | null;
  resolvedBucket: CompoWarWeightBucket | null;
  resolvedWeightSource: "member" | "catalog" | "defer" | "current" | "war" | null;
};

export type CompoActualStateContext = {
  trackedClanTags: string[];
  renderableClanTags: string[];
  /** Factual parent-band coverage, retained separately from authorized comparison refs. */
  heatMapRefParents: HeatMapRef[];
  latestSourceSyncedAt: Date | null;
  heatMapRefs: HeatMapRef[];
  referenceAvailability: HeatMapRefReferenceAvailability;
  /** Separately verified canonical legacy-v1 rows usable only for informational state display. */
  historicalHeatMapRefs?: HeatMapRef[];
  historicalReferenceAvailability?: HeatMapRefHistoricalReferenceAvailability;
  clans: CompoActualStateClanContext[];
};

type CompoActualStateReferenceMode = "current" | "historical" | "unavailable";

export type CompoActualStateTrackedClanComposition = {
  clanTag: string;
  clanName: string;
  shortName: string | null;
  displayCounts: ReturnType<typeof collapseCompoWarBucketCountsForDisplay>;
  memberCount: number;
  unresolvedWeightCount: number;
  sourceSyncedAt: Date | null;
  sourceAgeMs: number | null;
  selectedHeatMapRefAvailable: boolean;
  deviationScore: number | null;
  healthy: boolean;
  projection: CompoActualStateProjection;
  members: CompoActualStateMemberContext[];
};

export type CompoActualStateExternalClanComposition = {
  clanTag: string;
  clanName: string;
  displayCounts: {
    TH18: number | null;
    TH17: number | null;
    TH16: number | null;
    TH15: number | null;
    TH14: number | null;
    "<=TH13": number | null;
  };
  memberCount: number | null;
  unresolvedWeightCount: number;
  estimatedWeight: number | null;
  sourceSyncedAt: Date | null;
  sourceAgeMs: number | null;
  selectedHeatMapRefAvailable: boolean;
  compositionComplete: boolean;
  deviationScore: number | null;
  healthy: boolean;
};

export type CompoActualStateReadResult = {
  stateRows: string[][] | null;
  contentLines: string[];
  imageNotice?: string | null;
  trackedClanTags: string[];
  renderableClanTags: string[];
  view: CompoActualStateView;
};

type NativeActualComparisonState = {
  summaryLine: string;
  byClanTag: ReadonlyMap<string, NativeCompoComparison>;
};

function buildRefreshTimestamp(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) return "refreshed (not available)";
  return `refreshed <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function normalizeActualStateClanDisplayName(value: string): string {
  return normalizeCompoClanDisplayName(value).trimEnd();
}

function buildActualStateRow(input: {
  clanName: string;
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  projection: CompoActualStateProjection;
  includeTh19: boolean;
  nativeComparison?: NativeCompoComparison;
}): string[] {
  const row = [normalizeActualStateClanDisplayName(input.clanName)];
  if (input.view === "raw") {
    row.push(
      input.base.resolvedTotalWeight.toLocaleString("en-US"),
      `${input.projection.unresolvedWeightCount}`,
      `${input.projection.deferredWeightCount}`,
      `${input.projection.memberCount}`,
      ...(input.includeTh19 ? [`${input.projection.displayCounts.TH19 ?? 0}`] : []),
      `${input.projection.displayCounts.TH18}`,
      `${input.projection.displayCounts.TH17}`,
      `${input.projection.displayCounts.TH16}`,
      `${input.projection.displayCounts.TH15}`,
      `${input.projection.displayCounts.TH14}`,
      `${input.projection.displayCounts["<=TH13"]}`,
    );
    return appendNativeActualColumns(row, input.nativeComparison);
  }

  row.push(input.base.resolvedTotalWeight.toLocaleString("en-US"));
  row.push(input.projection.totalWeight.toLocaleString("en-US"));
  row.push(
    `${input.projection.missingWeights}`,
    `${input.projection.deferredWeightCount}`,
    `${input.projection.memberCount}`,
    ...(input.includeTh19 ? [`${input.projection.displayCounts.TH19 ?? 0}`] : []),
    input.projection.deltaByBucket.TH18 !== null
      ? `${input.projection.deltaByBucket.TH18}`
      : "?",
    input.projection.deltaByBucket.TH17 !== null
      ? `${input.projection.deltaByBucket.TH17}`
      : "?",
    input.projection.deltaByBucket.TH16 !== null
      ? `${input.projection.deltaByBucket.TH16}`
      : "?",
    input.projection.deltaByBucket.TH15 !== null
      ? `${input.projection.deltaByBucket.TH15}`
      : "?",
    input.projection.deltaByBucket.TH14 !== null
      ? `${input.projection.deltaByBucket.TH14}`
      : "?",
    input.projection.deltaByBucket["<=TH13"] !== null
      ? `${input.projection.deltaByBucket["<=TH13"]}`
      : "?",
  );
  return appendNativeActualColumns(row, input.nativeComparison);
}

function appendNativeActualColumns(
  row: string[],
  comparison: NativeCompoComparison | undefined,
): string[] {
  if (!comparison) return row;
  return [
    ...row,
    comparison.status === "SUPPORTED" ? "PROVISIONAL" : "UNKNOWN",
    ...NATIVE_COMPO_COMPARISON_BUCKETS.map((bucketId) => {
      const delta = comparison.deltaByBucket[bucketId];
      return delta === null || delta === undefined ? "UNKNOWN" : `${delta}`;
    }),
    comparison.score === null ? "UNKNOWN" : comparison.score.toFixed(1),
  ];
}

function buildTrackedClanDisplayName(clan: TrackedClanRow): string {
  return clan.name?.trim() || clan.tag;
}

function normalizePositiveCount(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || value === null || value === undefined) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

function buildActualViewSummaryLines(
  view: CompoActualStateView,
  latestSourceSyncedAt: Date | null,
  missingHeatMapBands: string[],
  missingTo50Count: number,
  includeTh19: boolean,
  referenceAvailability: HeatMapRefReferenceAvailability,
  historicalReferenceAvailability: HeatMapRefHistoricalReferenceAvailability,
  referenceMode: CompoActualStateReferenceMode,
  heatMapRefParentCount: number,
  unsupportedTh19Comparisons: string[],
): string[] {
  const contentLines = [
    `ACTUAL · View: **${getCompoActualStateViewLabel(view)}** · ${buildRefreshTimestamp(latestSourceSyncedAt)}`,
  ];
  if (view === "raw") {
    contentLines.push(
      `Columns: Total=resolved weight; Missing=unresolved/fallback; DF=deferred-weight count; ${includeTh19 ? "TH19=observed count; " : ""}TH=resolved composition counts.`,
    );
  } else {
    const comparisonLabel =
      referenceMode === "current"
        ? "current validated HeatMapRef"
        : referenceMode === "historical"
          ? "verified historical legacy-v1 HeatMapRef baseline (informational only)"
          : "HeatMapRef";
    contentLines.push(
      `Columns: Total=resolved weight; Plan=projected 50-player total; Missing=unresolved/empty slots; DF=deferred-weight count; ${includeTh19 ? "TH19=observed count; " : ""}TH=roster delta vs ${comparisonLabel}${missingTo50Count > 0 ? `; ${missingTo50Count} open roster slot${missingTo50Count === 1 ? "" : "s"} across tracked clans` : ""}.`,
    );
  }
  if (view !== "raw" && missingHeatMapBands.length > 0) {
    contentLines.push(
      `Missing HeatMapRef band for displayed ACTUAL totals: ${missingHeatMapBands.join("; ")}`,
    );
  }
  if (
    view !== "raw" &&
    heatMapRefParentCount > 0 &&
    referenceMode === "unavailable"
  ) {
    contentLines.push(
      "HeatMapRef parent bands are present, but target comparisons remain UNKNOWN until reference validation is available.",
    );
  }
  if (view !== "raw" && referenceMode === "historical") {
    contentLines.push(
      `Reference mode: verified historical legacy-v1 baseline ${historicalReferenceAvailability.sourceVersion ?? "(version unavailable)"}; comparisons are informational only and do not authorize current-reference operations.`,
    );
  }
  if (view !== "raw" && unsupportedTh19Comparisons.length > 0) {
    contentLines.push(
      `TH19 comparison unavailable for: ${unsupportedTh19Comparisons.join(
        "; ",
      )} (legacy HeatMapRef targets do not support observed TH19).`,
    );
  }
  return contentLines;
}

function buildHeatMapRefUnknownNotice(
  availability: HeatMapRefReferenceAvailability,
  historicalAvailability: HeatMapRefHistoricalReferenceAvailability,
  referenceMode: CompoActualStateReferenceMode,
  view: CompoActualStateView,
  unsupportedTh19ComparisonCount: number,
): string | null {
  if (view === "raw") {
    return null;
  }
  if (referenceMode === "historical") {
    return historicalAvailability.status === "verified"
      ? unsupportedTh19ComparisonCount > 0
        ? "Historical legacy-v1 comparison is informational only; current validation unavailable; observed TH19 remains unsupported"
        : "Historical legacy-v1 comparison is informational only; current reference validation unavailable"
      : "TH comparisons unavailable - historical legacy-v1 baseline not verified";
  }
  if (
    availability.status === "validated" &&
    unsupportedTh19ComparisonCount > 0
  ) {
    return "TH comparisons unavailable - observed TH19 unsupported by legacy HeatMapRef";
  }
  if (availability.status === "validated") {
    return null;
  }
  const warning = availability.warning?.toLowerCase() ?? "";
  if (warning.includes("normalized target")) {
    return "TH comparisons unavailable - normalized HeatMapRef targets unavailable";
  }
  if (availability.status === "retained_unverified") {
    return "TH comparisons unavailable - HeatMapRef validation blocked";
  }
  if (warning.includes("in progress")) {
    return "TH comparisons unavailable - HeatMapRef validation pending";
  }
  return "TH comparisons unavailable - HeatMapRef not validated";
}

function getDebugTaggedClanTags(): Set<string> {
  const raw = String(process.env.COMPO_ACTUAL_DEBUG_CLAN_TAGS ?? "").trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(/[\s,]+/)
      .map((value) => normalizeTag(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function shouldLogCompoActualDiagnostics(clanTag: string): boolean {
  const normalizedClanTag = normalizeTag(clanTag);
  if (!normalizedClanTag) {
    return false;
  }

  if (normalizedClanTag === "#2RYGLU2UY") {
    return true;
  }

  return getDebugTaggedClanTags().has(normalizedClanTag);
}

function getCompoActualDiagnosticsCoverageReason(input: {
  heatMapRefs: readonly HeatMapRef[];
  totalWeight: number;
}): CompoActualDiagnosticsCoverageReason {
  if (input.heatMapRefs.length === 0) {
    return "no_heatmap_refs";
  }
  if (findHeatMapRefForWeight(input.heatMapRefs, input.totalWeight)) {
    return "selected";
  }

  const minWeightInclusive = Math.min(
    ...input.heatMapRefs.map((ref) => ref.weightMinInclusive),
  );
  const maxWeightInclusive = Math.max(
    ...input.heatMapRefs.map((ref) => ref.weightMaxInclusive),
  );
  if (input.totalWeight < minWeightInclusive) {
    return "out_of_range_low";
  }
  if (input.totalWeight > maxWeightInclusive) {
    return "out_of_range_high";
  }
  return "coverage_gap";
}

function getLowestCoverageBandRef(refs: readonly HeatMapRef[]): HeatMapRef {
  return refs.reduce((lowest, current) =>
    current.weightMinInclusive < lowest.weightMinInclusive ||
    (current.weightMinInclusive === lowest.weightMinInclusive &&
      current.weightMaxInclusive < lowest.weightMaxInclusive)
      ? current
      : lowest,
  refs[0] as HeatMapRef);
}

function getHighestCoverageBandRef(refs: readonly HeatMapRef[]): HeatMapRef {
  return refs.reduce((highest, current) =>
    current.weightMaxInclusive > highest.weightMaxInclusive ||
    (current.weightMaxInclusive === highest.weightMaxInclusive &&
      current.weightMinInclusive > highest.weightMinInclusive)
      ? current
      : highest,
  refs[0] as HeatMapRef);
}

function buildCompoActualDiagnosticsLine(input: {
  surface: CompoActualDiagnosticsSurface;
  clanTag: string;
  clanName: string;
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  projection: CompoActualStateProjection;
  heatMapRefs: readonly HeatMapRef[];
}): string | null {
  if (!shouldLogCompoActualDiagnostics(input.clanTag)) {
    return null;
  }

  const normalizedClanTag = normalizeTag(input.clanTag);
  const selectedHeatMapRefBandKey = input.projection.selectedHeatMapRef
    ? getHeatMapRefBandKey(input.projection.selectedHeatMapRef)
    : null;
  const coverageReason = getCompoActualDiagnosticsCoverageReason({
    heatMapRefs: input.heatMapRefs,
    totalWeight: input.projection.totalWeight,
  });
  const coverageMinBandKey =
    input.heatMapRefs.length > 0
      ? getHeatMapRefBandKey(getLowestCoverageBandRef(input.heatMapRefs))
      : null;
  const coverageMaxBandKey =
    input.heatMapRefs.length > 0
      ? getHeatMapRefBandKey(getHighestCoverageBandRef(input.heatMapRefs))
      : null;

  return [
    "[compo-actual-debug]",
    `surface=${input.surface}`,
    `clanTag=${normalizedClanTag}`,
    `clanName=${input.clanName.trim() || "none"}`,
    `view=${input.view}`,
    `resolvedTotalWeight=${input.base.resolvedTotalWeight}`,
    `missingWeightCount=${input.base.unresolvedWeightCount}`,
    `memberCount=${input.base.memberCount}`,
    `missingTo50Count=${input.projection.missingTo50Count}`,
    `projectedTotalWeight=${input.projection.totalWeight}`,
    `selectedHeatMapRefBandKey=${selectedHeatMapRefBandKey ?? "null"}`,
    `coverageMinBandKey=${coverageMinBandKey ?? "null"}`,
    `coverageMaxBandKey=${coverageMaxBandKey ?? "null"}`,
    `heatMapRefsEmpty=${input.heatMapRefs.length === 0 ? "true" : "false"}`,
    `coverageReason=${coverageReason}`,
    `deltaByBucketNull=${input.projection.selectedHeatMapRef ? "false" : "true"}`,
  ].join(" ");
}

export function maybeLogCompoActualDiagnostics(input: {
  surface: CompoActualDiagnosticsSurface;
  clanTag: string;
  clanName: string;
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  projection: CompoActualStateProjection;
  heatMapRefs: readonly HeatMapRef[];
}): void {
  const line = buildCompoActualDiagnosticsLine(input);
  if (line) {
    console.log(line);
  }
}

async function readNativeInformationalComparison(
  clans: readonly CompoActualStateClanContext[],
): Promise<NativeActualComparisonState | null> {
  if (clans.length === 0) return null;
  try {
    const nativeDb = prisma as typeof prisma & { nativeHeatMapReferenceHead?: unknown };
    if (!nativeDb.nativeHeatMapReferenceHead) return null;
    const native = await new NativeHeatMapReferencePublicationService(prisma).readCurrent();
    if (native.status !== "CURRENT") return null;
    let supported = 0;
    let unknown = 0;
    const byClanTag = new Map<string, NativeCompoComparison>();
    for (const clan of clans) {
      const comparison = calculateNativeCompoComparison({
        native,
        totalWeight: clan.base.resolvedTotalWeight,
        sourceCounts: clan.base.bucketCounts,
      });
      byClanTag.set(clan.clanTag, comparison);
      if (comparison.status === "UNKNOWN") {
        unknown += 1;
      } else {
        supported += 1;
      }
    }
    return {
      summaryLine: `Provisional native targets (informational only; no recommendations): ${supported} supported / ${unknown} UNKNOWN clans · ${native.profileVersion} · ${native.policyVersion} · generation ${native.generationId ?? "unknown"}`,
      byClanTag,
    };
  } catch {
    return null;
  }
}

export const buildCompoActualDiagnosticsLineForTest = buildCompoActualDiagnosticsLine;

function assessPersistedClanMembersCoverage(input: {
  syncState: ClanMembersSyncStateRow | null;
  memberCount: number;
  now: Date;
  snapshotHash: string;
}): {
  coverage: CompoActualRosterCoverage;
  memberCountEvidence: "observed" | "unknown";
  observedAt: Date | null;
  sourceStatus: CompoActualRosterSourceStatus | null;
  reason: string;
} {
  const state = input.syncState;
  const isValidDate = (value: unknown): value is Date =>
    value instanceof Date && Number.isFinite(value.getTime());
  const observedAt = isValidDate(state?.lastSuccessAt) ? state.lastSuccessAt : null;
  const sourceStatus = state?.lastStatus ?? null;
  if (!state || !observedAt) {
    return {
      coverage: "unavailable",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_missing_success",
    };
  }
  if (
    !isValidDate(state.lastAttemptAt) ||
    state.lastAttemptAt.getTime() < observedAt.getTime() ||
    observedAt.getTime() > input.now.getTime() ||
    state.lastAttemptAt.getTime() > input.now.getTime()
  ) {
    return {
      coverage: "contradictory",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_timestamp_order_invalid",
    };
  }
  if (state.lastStatus !== "SUCCESS" && state.lastStatus !== "NOOP") {
    return {
      coverage: state.lastStatus === "FAILURE" ? "stale" : "unavailable",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_status_not_authoritative",
    };
  }
  if (state.lastRowCount === null || state.lastRowCount === undefined) {
    return {
      coverage: "partial",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_row_count_missing",
    };
  }
  if (!Number.isInteger(state.lastRowCount) || state.lastRowCount < 0 || state.lastRowCount !== input.memberCount) {
    return {
      coverage: "contradictory",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_row_count_mismatch",
    };
  }
  if (!state.lastContentHash || state.lastContentHash !== input.snapshotHash) {
    return {
      coverage: state.lastContentHash ? "contradictory" : "partial",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: state.lastContentHash ? "sync_snapshot_hash_mismatch" : "sync_snapshot_hash_missing",
    };
  }

  const freshness = getHomeRosterCoverage({
    lastSuccessAt: observedAt,
    now: input.now,
    cadenceMinutes: getConfiguredClanMembersCadenceMinutes(),
  });
  if (freshness.coverage !== "CURRENT") {
    return {
      coverage: "stale",
      memberCountEvidence: "unknown",
      observedAt,
      sourceStatus,
      reason: "sync_state_stale",
    };
  }
  return {
    coverage: "complete",
    memberCountEvidence: "observed",
    observedAt,
    sourceStatus,
    reason: state.lastStatus === "NOOP" ? "sync_noop_current" : "sync_success_current",
  };
}

async function loadCompoActualStateContextFromTrackedClans(input: {
  guildId?: string | null;
  trackedClans: readonly (
    Pick<TrackedClan, "tag" | "name"> & { shortName?: string | null }
  )[];
}): Promise<CompoActualStateContext> {
  const trackedClanTags = input.trackedClans
    .map((clan) => normalizeTag(clan.tag))
    .filter((tag): tag is string => Boolean(tag));

  if (trackedClanTags.length === 0) {
    return {
      trackedClanTags: [],
      renderableClanTags: [],
      heatMapRefParents: [],
      latestSourceSyncedAt: null,
      heatMapRefs: [],
      referenceAvailability: {
        status: "unknown",
        blockReasonCode: null,
        lastSuccessAtIso: null,
        warning: null,
      },
      historicalHeatMapRefs: [],
      historicalReferenceAvailability: {
        status: "unknown",
        sourceVersion: null,
        warning: null,
      },
      clans: [],
    };
  }

  const [members, reference, feedStates] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: { in: trackedClanTags } },
      select: {
        clanTag: true,
        playerTag: true,
        playerName: true,
        role: true,
        level: true,
        donated: true,
        received: true,
        rank: true,
        trophies: true,
        league: true,
        townHall: true,
        weight: true,
        inWar: true,
        sourceSyncedAt: true,
      },
      orderBy: [{ clanTag: "asc" }, { sourceSyncedAt: "desc" }, { playerTag: "asc" }],
    }),
    resolveHeatMapRefReference({ guildId: input.guildId }),
    prisma.fwaFeedSyncState.findMany({
      where: {
        feedType: "CLAN_MEMBERS",
        scopeType: "CLAN_TAG",
        scopeKey: { in: trackedClanTags },
      },
      select: {
        scopeKey: true,
        lastAttemptAt: true,
        lastSuccessAt: true,
        lastStatus: true,
        lastRowCount: true,
        lastChangedRowCount: true,
        lastContentHash: true,
      },
    }),
  ]);
  const heatMapRefs = reference.heatMapRefs;
  const referenceAvailability = reference.availability;
  const historicalReferenceAvailability = reference.historicalAvailability;
  const availableHeatMapRefs =
    referenceAvailability.status === "validated" ? heatMapRefs : [];

  const syncStateByClanTag = new Map<string, ClanMembersSyncStateRow>();
  for (const row of feedStates ?? []) {
    const clanTag = normalizeTag(row.scopeKey);
    if (clanTag) syncStateByClanTag.set(clanTag, row);
  }
  const now = new Date();

  const membersByClanTag = new Map<string, CurrentMemberRow[]>();
  const allPlayerTags = new Set<string>();
  let latestSourceSyncedAt: Date | null = null;
  for (const member of members) {
    const clanTag = normalizeTag(member.clanTag);
    const playerTag = normalizePlayerTag(member.playerTag);
    if (!clanTag || !playerTag) continue;
    allPlayerTags.add(playerTag);
    const existing = membersByClanTag.get(clanTag) ?? [];
    existing.push({
      ...member,
      clanTag,
      playerTag,
    });
    membersByClanTag.set(clanTag, existing);
    if (
      !latestSourceSyncedAt ||
      member.sourceSyncedAt.getTime() > latestSourceSyncedAt.getTime()
    ) {
      latestSourceSyncedAt = member.sourceSyncedAt;
    }
  }

  const catalogWeightsPromise =
    allPlayerTags.size === 0
      ? Promise.resolve([] as Array<{ playerTag: string; latestKnownWeight: number | null }>)
      : prisma.fwaPlayerCatalog.findMany({
          where: { playerTag: { in: [...allPlayerTags] } },
          select: {
            playerTag: true,
            latestKnownWeight: true,
          },
        });
  const playerCurrentWeightsPromise =
    allPlayerTags.size === 0
      ? Promise.resolve([] as Array<{ playerTag: string; currentWeight: number | null }>)
      : prisma.playerCurrent.findMany({
          where: { playerTag: { in: [...allPlayerTags] } },
          select: {
            playerTag: true,
            currentWeight: true,
          },
        });
  const warFallbackMembersPromise =
    allPlayerTags.size === 0
      ? Promise.resolve([] as WarFallbackRow[])
      : prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
          where: {
            playerTag: { in: [...allPlayerTags] },
            effectiveWeight: { not: null },
          },
          select: {
            clanTag: true,
            playerTag: true,
            effectiveWeight: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "desc" }, { clanTag: "asc" }, { playerTag: "asc" }],
        });
  const deferredByClanTagPromise = input.guildId
    ? listOpenDeferredWeightsByClanAndPlayerTags({
        guildId: input.guildId,
        clanPlayerTags: trackedClanTags.map((clanTag) => ({
          clanTag,
          playerTags: (membersByClanTag.get(clanTag) ?? []).map(
            (member) => member.playerTag,
          ),
        })),
      })
    : Promise.resolve(new Map<string, Map<string, number>>());

  const [catalogRows, playerCurrentRows, warFallbackMembers, deferredByClanTag] =
    await Promise.all([
      catalogWeightsPromise,
      playerCurrentWeightsPromise,
      warFallbackMembersPromise,
      deferredByClanTagPromise,
    ]);

  const catalogWeightByPlayerTag = new Map<string, number>();
  for (const row of catalogRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const weight = toPositiveCompoWeight(row.latestKnownWeight);
    if (!playerTag || catalogWeightByPlayerTag.has(playerTag) || weight === null) {
      continue;
    }
    catalogWeightByPlayerTag.set(playerTag, weight);
  }

  const currentWeightByPlayerTag = new Map<string, number>();
  for (const row of playerCurrentRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const weight = toPositiveCompoWeight(row.currentWeight);
    if (!playerTag || currentWeightByPlayerTag.has(playerTag) || weight === null) {
      continue;
    }
    currentWeightByPlayerTag.set(playerTag, weight);
  }

  const warFallbackByClanAndPlayerTag = new Map<string, number>();
  const warFallbackByPlayerTag = new Map<string, number>();
  for (const row of warFallbackMembers) {
    const clanTag = normalizeTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    const effectiveWeight = toPositiveCompoWeight(row.effectiveWeight);
    if (!clanTag || !playerTag || effectiveWeight === null) {
      continue;
    }
    const clanAndPlayerTagKey = `${clanTag}|${playerTag}`;
    if (!warFallbackByClanAndPlayerTag.has(clanAndPlayerTagKey)) {
      warFallbackByClanAndPlayerTag.set(clanAndPlayerTagKey, effectiveWeight);
    }
    if (!warFallbackByPlayerTag.has(playerTag)) {
      warFallbackByPlayerTag.set(playerTag, effectiveWeight);
    }
  }

  const clans: CompoActualStateClanContext[] = [];
  for (const clan of input.trackedClans) {
    const clanTag = normalizeTag(clan.tag);
    if (!clanTag) continue;

    const clanMembers = membersByClanTag.get(clanTag) ?? [];
    const clanSourceSyncedAt = clanMembers.reduce<Date | null>((latest, member) => {
      if (!latest || member.sourceSyncedAt.getTime() > latest.getTime()) {
        return member.sourceSyncedAt;
      }
      return latest;
    }, null);
    const deferredByPlayerTag = deferredByClanTag.get(clanTag) ?? new Map();
    const bucketCounts: CompoWarBucketCounts = {
      ...EMPTY_COMPO_WAR_BUCKET_COUNTS,
    };
    let totalResolvedWeight = 0;
    let unresolvedWeightCount = 0;
    let unclassifiedWeightCount = 0;
    let deferredWeightCount = 0;
    const members: CompoActualStateMemberContext[] = [];

    for (const member of clanMembers) {
      const playerTag = normalizePlayerTag(member.playerTag);
      const catalogWeight = playerTag ? catalogWeightByPlayerTag.get(playerTag) ?? null : null;
      const sameClanWarWeight = playerTag
        ? warFallbackByClanAndPlayerTag.get(`${clanTag}|${playerTag}`) ?? null
        : null;
      const currentWeight = playerTag ? currentWeightByPlayerTag.get(playerTag) ?? null : null;
      const anyWarWeight = playerTag ? warFallbackByPlayerTag.get(playerTag) ?? null : null;
      const deferredWeight = playerTag ? deferredByPlayerTag.get(playerTag) ?? null : null;
      const { resolvedWeight, resolvedWeightSource } = resolveEffectivePlayerWeight({
        primaryCandidates: [
          { source: "member", weight: member.weight },
          { source: "catalog", weight: catalogWeight },
        ],
        overrideCandidates: [{ source: "defer", weight: deferredWeight }],
        fallbackCandidates: [
          { source: "current", weight: currentWeight },
          { source: "war", weight: sameClanWarWeight },
          { source: "war", weight: anyWarWeight },
        ],
      });
      const bucket = getCompoWarWeightBucket(resolvedWeight);
      const normalizedTownHall =
        Number.isFinite(Number(member.townHall)) && Number(member.townHall) > 0
          ? Math.trunc(Number(member.townHall))
          : null;
      const isMissing = resolvedWeightSource === "war" || resolvedWeight === null;
      if (resolvedWeightSource === "defer") {
        deferredWeightCount += 1;
      }
      members.push({
        clanTag,
        playerTag,
        playerName: member.playerName,
        townHall: normalizedTownHall,
        resolvedWeight,
        resolvedBucket: bucket,
        resolvedWeightSource,
      });
      if (resolvedWeight === null || !bucket) {
        if (resolvedWeight !== null && !bucket) {
          unclassifiedWeightCount += 1;
        }
        if (isMissing) {
          unresolvedWeightCount += 1;
        }
        continue;
      }
      totalResolvedWeight += resolvedWeight;
      bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
      if (isMissing) {
        unresolvedWeightCount += 1;
      }
    }

    const snapshotHash = computeClanMembersSnapshotHash(
      clanMembers.map((member) => toPersistedClanMembersSnapshotRow(member)),
    );
    const rosterEvidence = assessPersistedClanMembersCoverage({
      syncState: syncStateByClanTag.get(clanTag) ?? null,
      memberCount: clanMembers.length,
      now,
      snapshotHash,
    });
    clans.push({
      clanTag,
      clanName: clan.name?.trim() || clan.tag,
      shortName: clan.shortName?.trim() || null,
      sourceSyncedAt: clanSourceSyncedAt,
      base: {
        resolvedTotalWeight: totalResolvedWeight,
        unresolvedWeightCount,
        unclassifiedWeightCount,
        deferredWeightCount,
        memberCount: clanMembers.length,
        memberCountEvidence: rosterEvidence.memberCountEvidence,
        rosterCoverage: rosterEvidence.coverage,
        rosterObservedAt: rosterEvidence.observedAt ?? clanSourceSyncedAt,
        rosterSourceStatus: rosterEvidence.sourceStatus,
        rosterEvidenceReason: rosterEvidence.reason,
        bucketCounts,
      },
      members,
    });
  }

  return {
    trackedClanTags,
    renderableClanTags: clans.map((clan) => clan.clanTag),
    heatMapRefParents: heatMapRefs,
    latestSourceSyncedAt,
    heatMapRefs: availableHeatMapRefs,
    referenceAvailability,
    historicalHeatMapRefs:
      historicalReferenceAvailability.status === "verified" ? heatMapRefs : [],
    historicalReferenceAvailability,
    clans,
  };
}

/** Purpose: load the persisted ACTUAL compo state snapshot used by both state rendering and advice simulation. */
export async function loadCompoActualStateContext(
  guildId?: string | null,
): Promise<CompoActualStateContext> {
  const tracked = (await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, shortName: true },
  })) ?? [];
  return loadCompoActualStateContextFromTrackedClans({
    guildId,
    trackedClans: tracked,
  });
}

/** Purpose: load the persisted ACTUAL composition snapshot for one tracked clan only. */
export async function readTrackedClanCurrentComposition(input: {
  guildId?: string | null;
  trackedClan: Pick<TrackedClan, "tag" | "name"> & {
    shortName?: string | null;
  };
  now?: Date;
}): Promise<CompoActualStateTrackedClanComposition | null> {
  const context = await loadCompoActualStateContextFromTrackedClans({
    guildId: input.guildId,
    trackedClans: [input.trackedClan],
  });
  const clan = context.clans[0];
  if (!clan) {
    return null;
  }

  const projection = projectCompoActualStateView({
    view: "auto",
    base: clan.base,
    heatMapRefs: context.heatMapRefs,
  });
  const displayCounts = collapseCompoWarBucketCountsForDisplay(clan.base.bucketCounts);
  const sourceSyncedAt = context.latestSourceSyncedAt;
  const now = input.now ?? new Date();
  const sourceAgeMs =
    sourceSyncedAt === null ? null : Math.max(0, now.getTime() - sourceSyncedAt.getTime());

  return {
    clanTag: clan.clanTag,
    clanName: clan.clanName,
    shortName: clan.shortName,
    displayCounts,
    memberCount: clan.base.memberCount,
    unresolvedWeightCount: clan.base.unresolvedWeightCount,
    sourceSyncedAt,
    sourceAgeMs,
    selectedHeatMapRefAvailable: projection.selectedHeatMapRef !== null,
    deviationScore: projection.deviationScore ?? null,
    healthy:
      clan.base.memberCount === 50 &&
      isCompoActualStateProjectionComplete(projection) &&
      isCompoActualStateDeviationHealthy(projection.deviationScore),
    projection,
    members: clan.members,
  };
}

/** Purpose: load the persisted catalog-backed composition snapshot for one active FWA clan. */
export async function readExternalClanCurrentComposition(input: {
  clanTag: string;
  guildId?: string | null;
  now?: Date;
}): Promise<CompoActualStateExternalClanComposition | null> {
  const normalizedClanTag = normalizeTag(input.clanTag);
  if (!normalizedClanTag) {
    return null;
  }

  const catalogRow = await prisma.fwaClanCatalog.findFirst({
    where: { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
    select: {
      clanTag: true,
      name: true,
      th18Count: true,
      th17Count: true,
      th16Count: true,
      th15Count: true,
      th14Count: true,
      th13Count: true,
      th12Count: true,
      th11Count: true,
      th10Count: true,
      th9Count: true,
      th8Count: true,
      thLowCount: true,
      estimatedWeight: true,
      lastSyncedAt: true,
    },
  });
  if (!catalogRow) {
    return null;
  }

  const now = input.now ?? new Date();
  const sourceSyncedAt =
    catalogRow.lastSyncedAt instanceof Date && Number.isFinite(catalogRow.lastSyncedAt.getTime())
      ? catalogRow.lastSyncedAt
      : null;
  const sourceAgeMs =
    sourceSyncedAt === null ? null : Math.max(0, now.getTime() - sourceSyncedAt.getTime());
  const th18Count = normalizePositiveCount(catalogRow.th18Count);
  const th17Count = normalizePositiveCount(catalogRow.th17Count);
  const th16Count = normalizePositiveCount(catalogRow.th16Count);
  const th15Count = normalizePositiveCount(catalogRow.th15Count);
  const th14Count = normalizePositiveCount(catalogRow.th14Count);
  const th13Count = normalizePositiveCount(catalogRow.th13Count);
  const th12Count = normalizePositiveCount(catalogRow.th12Count);
  const th11Count = normalizePositiveCount(catalogRow.th11Count);
  const th10Count = normalizePositiveCount(catalogRow.th10Count);
  const th9Count = normalizePositiveCount(catalogRow.th9Count);
  const th8Count = normalizePositiveCount(catalogRow.th8Count);
  const thLowCount = normalizePositiveCount(catalogRow.thLowCount);
  const estimatedWeight = toPositiveCompoWeight(catalogRow.estimatedWeight);
  const countsComplete =
    th18Count !== null &&
    th17Count !== null &&
    th16Count !== null &&
    th15Count !== null &&
    th14Count !== null &&
    th13Count !== null &&
    th12Count !== null &&
    th11Count !== null &&
    th10Count !== null &&
    th9Count !== null &&
    th8Count !== null &&
    thLowCount !== null;
  const unresolvedWeightCount =
    [
      th18Count,
      th17Count,
      th16Count,
      th15Count,
      th14Count,
      th13Count,
      th12Count,
      th11Count,
      th10Count,
      th9Count,
      th8Count,
      thLowCount,
    ].filter((value) => value === null).length + (estimatedWeight === null ? 1 : 0);
  const memberCount = countsComplete
    ? th18Count +
      th17Count +
      th16Count +
      th15Count +
      th14Count +
      th13Count +
      th12Count +
      th11Count +
      th10Count +
      th9Count +
      th8Count +
      thLowCount
    : null;
  const compositionComplete = countsComplete && estimatedWeight !== null;
  const displayCounts = {
    TH18: th18Count,
    TH17: th17Count,
    TH16: th16Count,
    TH15: th15Count,
    TH14: th14Count,
    "<=TH13":
      th13Count !== null &&
      th12Count !== null &&
      th11Count !== null &&
      th10Count !== null &&
      th9Count !== null &&
      th8Count !== null &&
      thLowCount !== null
        ? th13Count + th12Count + th11Count + th10Count + th9Count + th8Count + thLowCount
        : null,
  };
  const reference = await resolveHeatMapRefReference({ guildId: input.guildId });
  const heatMapRefs = reference.heatMapRefs;
  const referenceAvailability = reference.availability;
  const selectedHeatMapRef = estimatedWeight !== null && referenceAvailability.status === "validated"
    ? findHeatMapRefForWeight(heatMapRefs, estimatedWeight)
    : null;
  const deviationScore =
    compositionComplete && selectedHeatMapRef
      ? calculateCompoDeviationScore({
          displayCounts: {
            TH18: displayCounts.TH18 ?? 0,
            TH17: displayCounts.TH17 ?? 0,
            TH16: displayCounts.TH16 ?? 0,
            TH15: displayCounts.TH15 ?? 0,
            TH14: displayCounts.TH14 ?? 0,
            "<=TH13": displayCounts["<=TH13"] ?? 0,
          },
          heatMapRef: selectedHeatMapRef,
        })
      : null;

  return {
    clanTag: normalizeTag(catalogRow.clanTag) || normalizedClanTag,
    clanName: catalogRow.name?.trim() || normalizedClanTag,
    displayCounts,
    memberCount,
    estimatedWeight,
    sourceSyncedAt,
    sourceAgeMs,
    selectedHeatMapRefAvailable: selectedHeatMapRef !== null,
    compositionComplete,
    unresolvedWeightCount,
    deviationScore,
    healthy:
      compositionComplete &&
      memberCount === 50 &&
      selectedHeatMapRef !== null &&
      isCompoActualStateDeviationHealthy(deviationScore),
  };
}

/** Purpose: load and explicitly refresh DB-backed ACTUAL compo state from persisted current-member rows only. */
export class CompoActualStateService {
  private readonly clanMembersSync = new FwaClanMembersSyncService();

  /** Purpose: load alliance-wide ACTUAL state rows from persisted tracked-clan current-member data with deterministic weight fallbacks. */
  async readState(
    guildId?: string | null,
    options?: { view?: CompoActualStateView },
  ): Promise<CompoActualStateReadResult> {
    const view = options?.view ?? "auto";
    const context = await loadCompoActualStateContext(guildId);
    const nativeComparison = await readNativeInformationalComparison(context.clans);

    if (context.trackedClanTags.length === 0) {
      return {
        stateRows: null,
        imageNotice: null,
        trackedClanTags: [],
        renderableClanTags: [],
        view,
        contentLines: [
          `ACTUAL · View: **${getCompoActualStateViewLabel(view)}** · ${buildRefreshTimestamp(null)}`,
          "No tracked clans are configured for DB-backed ACTUAL state.",
          ...(nativeComparison ? [nativeComparison.summaryLine] : []),
        ],
      };
    }

    const renderableClanTags: string[] = [];
    const missingHeatMapBands: string[] = [];
    const unsupportedTh19Comparisons: string[] = [];
    const historicalReferenceAvailability = context.historicalReferenceAvailability ?? {
      status: "unknown" as const,
      sourceVersion: null,
      warning: null,
    };
    const referenceMode: CompoActualStateReferenceMode =
      context.referenceAvailability.status === "validated"
        ? "current"
        : historicalReferenceAvailability.status === "verified"
          ? "historical"
          : "unavailable";
    const stateHeatMapRefs =
      referenceMode === "current"
        ? context.heatMapRefs
        : referenceMode === "historical"
          ? context.historicalHeatMapRefs ?? []
          : [];
    const includeTh19 = context.clans.some(
      (clan) => (clan.base.bucketCounts.TH19 ?? 0) > 0,
    );
    const rows: string[][] = [];
    const totalMissingTo50Count = context.clans.reduce(
      (sum, clan) => sum + Math.max(0, 50 - clan.base.memberCount),
      0,
    );

    for (const clan of context.clans) {
      const projection = projectCompoActualStateView({
        view,
        base: clan.base,
        heatMapRefs: stateHeatMapRefs,
      });
      const displayName = buildTrackedClanDisplayName({
        tag: clan.clanTag,
        name: clan.clanName,
      });
      if (!projection.selectedHeatMapRef) {
        const parentHeatMapRef = findHeatMapRefForWeight(
          context.heatMapRefParents,
          projection.totalWeight,
        );
        if (!parentHeatMapRef) {
          missingHeatMapBands.push(
            `${normalizeActualStateClanDisplayName(displayName)} (${projection.totalWeight.toLocaleString("en-US")})`,
          );
        }
      }
      if (
        referenceMode !== "unavailable" &&
        hasUnsupportedCompoTh19Target(clan.base.bucketCounts) &&
        projection.targetStatus === "unavailable"
      ) {
        unsupportedTh19Comparisons.push(
          normalizeActualStateClanDisplayName(displayName),
        );
      }

      const row = buildActualStateRow({
        clanName: displayName,
        view,
        base: clan.base,
        projection,
        includeTh19,
        nativeComparison: nativeComparison?.byClanTag.get(clan.clanTag),
      });
      maybeLogCompoActualDiagnostics({
        surface: "state",
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        view,
        base: clan.base,
        projection,
        heatMapRefs: stateHeatMapRefs,
      });
      rows.push(row);
      renderableClanTags.push(clan.clanTag);
    }

    const contentLines = buildActualViewSummaryLines(
      view,
      context.latestSourceSyncedAt,
      missingHeatMapBands,
      totalMissingTo50Count,
      includeTh19,
      context.referenceAvailability,
      historicalReferenceAvailability,
      referenceMode,
      context.heatMapRefParents.length,
      unsupportedTh19Comparisons,
    );
    if (context.referenceAvailability.warning) {
      contentLines.push(
        referenceMode === "historical"
          ? `Current-reference warning: ${context.referenceAvailability.warning} Historical comparisons remain informational only.`
          : `Reference warning: ${context.referenceAvailability.warning}`,
      );
    }
    if (nativeComparison) contentLines.push(nativeComparison.summaryLine);
    const imageNotice = buildHeatMapRefUnknownNotice(
      context.referenceAvailability,
      historicalReferenceAvailability,
      referenceMode,
      view,
      unsupportedTh19Comparisons.length,
    );

    return {
      stateRows: [
        view === "raw"
          ? [
              "Clan",
              "Resolved Total",
              "Missing",
              "DF",
              "Players",
              ...(includeTh19 ? ["TH19"] : []),
              "TH18",
              "TH17",
              "TH16",
              "TH15",
              "TH14",
              "<=TH13",
              ...(nativeComparison ? ["Native"] : []),
              ...(nativeComparison ? NATIVE_COMPO_COMPARISON_BUCKETS.map((bucketId) => `Native Δ ${bucketId}`) : []),
              ...(nativeComparison ? ["Native score"] : []),
            ]
          : [
              "Clan",
              "Resolved Total",
              "Planning Total",
              "Missing",
              "DF",
              "Players",
              ...(includeTh19 ? ["TH19"] : []),
              "TH18",
              "TH17",
              "TH16",
              "TH15",
              "TH14",
              "<=TH13",
              ...(nativeComparison ? ["Native"] : []),
              ...(nativeComparison ? NATIVE_COMPO_COMPARISON_BUCKETS.map((bucketId) => `Native Δ ${bucketId}`) : []),
              ...(nativeComparison ? ["Native score"] : []),
            ],
        ...rows,
      ],
      contentLines,
      imageNotice,
      trackedClanTags: context.trackedClanTags,
      renderableClanTags,
      view,
    };
  }

  /** Purpose: explicitly refresh ACTUAL feed-backed weights plus live member counts for tracked clans, then rerender from persisted state. */
  async refreshState(
    guildId?: string | null,
    options?: { view?: CompoActualStateView },
  ): Promise<CompoActualStateReadResult> {
    const context = await loadCompoActualStateContext(guildId);

    if (context.trackedClanTags.length > 0) {
      const failures = new Set<string>();
      const feedResult = await this.clanMembersSync.syncAllTrackedClans({
        force: true,
      });
      for (const clanTag of feedResult.failedClans) failures.add(clanTag);
      const currentMembersResult = await this.clanMembersSync.refreshCurrentClanMembersForClanTags(
        context.trackedClanTags,
      );
      for (const clanTag of currentMembersResult.failedClans) failures.add(clanTag);

      const next = await this.readState(guildId, options);
      if (failures.size > 0) {
        next.contentLines = [
          ...next.contentLines,
          `Refresh warnings: ACTUAL data may be stale for ${[...failures]
            .map((tag) => `#${tag.replace(/^#/, "")}`)
            .join(", ")}; retry after the shared cooldown.`,
        ];
      }
      return next;
    }

    return this.readState(guildId, options);
  }
}
