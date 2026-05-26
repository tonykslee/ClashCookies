import type {
  HeatMapRef,
  FwaClanMemberCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
  TrackedClan,
} from "@prisma/client";
import {
  toPositiveCompoWeight,
} from "../helper/compoActualWeight";
import {
  getCompoActualStateViewLabel,
  projectCompoActualStateView,
  type CompoActualStateBaseMetrics,
  type CompoActualStateProjection,
  type CompoActualStateView,
} from "../helper/compoActualStateView";
import { findHeatMapRefForWeight, getHeatMapRefBandKey } from "../helper/compoHeatMap";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  EMPTY_COMPO_WAR_BUCKET_COUNTS,
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import {
  getCompoWarWeightBucket,
  type CompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import { prisma } from "../prisma";
import {
  listOpenDeferredWeightsByClanAndPlayerTags,
  normalizePlayerTag,
} from "./WeightInputDefermentService";
import { normalizeTag } from "./war-events/core";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";

type TrackedClanRow = Pick<TrackedClan, "tag" | "name"> & {
  shortName?: string | null;
};
type CurrentMemberRow = Pick<
  FwaClanMemberCurrent,
  "clanTag" | "playerTag" | "playerName" | "townHall" | "weight" | "sourceSyncedAt"
>;
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
  latestSourceSyncedAt: Date | null;
  heatMapRefs: HeatMapRef[];
  clans: CompoActualStateClanContext[];
};

export type CompoActualStateReadResult = {
  stateRows: string[][] | null;
  contentLines: string[];
  trackedClanTags: string[];
  renderableClanTags: string[];
  view: CompoActualStateView;
};

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function resolveActualWeightWithSource(input: {
  memberWeight: number | null | undefined;
  catalogWeight: number | null | undefined;
  deferredWeight: number | null | undefined;
  currentWeight: number | null | undefined;
  sameClanWarWeight: number | null | undefined;
  anyWarWeight: number | null | undefined;
}): {
  resolvedWeight: number | null;
  resolvedWeightSource: CompoActualStateMemberContext["resolvedWeightSource"];
} {
  const memberWeight = toPositiveCompoWeight(input.memberWeight);
  if (memberWeight !== null) {
    return { resolvedWeight: memberWeight, resolvedWeightSource: "member" };
  }

  const catalogWeight = toPositiveCompoWeight(input.catalogWeight);
  if (catalogWeight !== null) {
    return { resolvedWeight: catalogWeight, resolvedWeightSource: "catalog" };
  }

  const deferredWeight = toPositiveCompoWeight(input.deferredWeight);
  if (deferredWeight !== null) {
    return { resolvedWeight: deferredWeight, resolvedWeightSource: "defer" };
  }

  const currentWeight = toPositiveCompoWeight(input.currentWeight);
  if (currentWeight !== null) {
    return { resolvedWeight: currentWeight, resolvedWeightSource: "current" };
  }

  const sameClanWarWeight = toPositiveCompoWeight(input.sameClanWarWeight);
  if (sameClanWarWeight !== null) {
    return { resolvedWeight: sameClanWarWeight, resolvedWeightSource: "war" };
  }

  const anyWarWeight = toPositiveCompoWeight(input.anyWarWeight);
  if (anyWarWeight !== null) {
    return { resolvedWeight: anyWarWeight, resolvedWeightSource: "war" };
  }

  return { resolvedWeight: null, resolvedWeightSource: null };
}

function normalizeActualStateClanDisplayName(value: string): string {
  return normalizeCompoClanDisplayName(value).trimEnd();
}

function buildActualStateRow(input: {
  clanName: string;
  view: CompoActualStateView;
  base: CompoActualStateBaseMetrics;
  projection: CompoActualStateProjection;
}): string[] {
  const row = [normalizeActualStateClanDisplayName(input.clanName)];
  if (input.view === "raw") {
    row.push(
      input.base.resolvedTotalWeight.toLocaleString("en-US"),
      `${input.projection.unresolvedWeightCount}`,
      `${input.projection.deferredWeightCount}`,
      `${input.projection.memberCount}`,
      `${input.projection.displayCounts.TH18}`,
      `${input.projection.displayCounts.TH17}`,
      `${input.projection.displayCounts.TH16}`,
      `${input.projection.displayCounts.TH15}`,
      `${input.projection.displayCounts.TH14}`,
      `${input.projection.displayCounts["<=TH13"]}`,
    );
    return row;
  }

  row.push(input.base.resolvedTotalWeight.toLocaleString("en-US"));
  row.push(input.projection.totalWeight.toLocaleString("en-US"));
  row.push(
    `${input.projection.missingWeights}`,
    `${input.projection.deferredWeightCount}`,
    `${input.projection.memberCount}`,
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
  return row;
}

function buildTrackedClanDisplayName(clan: TrackedClanRow): string {
  return clan.name?.trim() || clan.tag;
}

function buildActualViewSummaryLines(
  view: CompoActualStateView,
  latestSourceSyncedAt: Date | null,
  missingHeatMapBands: string[],
  missingTo50Count: number,
): string[] {
  const contentLines = [
    buildPersistedRefreshLine(latestSourceSyncedAt),
    `ACTUAL View: **${getCompoActualStateViewLabel(view)}**`,
  ];
  if (view === "raw") {
    contentLines.push("Raw Data: current resolved roster composition.");
    contentLines.push("No estimated fill-ins or heatmap deltas.");
    contentLines.push("Resolved roster weight is shown directly in the table.");
    contentLines.push("Missing = unresolved weights plus WAR fallback-only members.");
    contentLines.push(`Missing-to-50 roster fill info: ${missingTo50Count}`);
  } else if (view === "auto") {
    contentLines.push("Resolved roster weight is shown separately from the planning total shown for display.");
    contentLines.push("Selected band source: resolved-count best fit.");
    contentLines.push("Deltas: resolved roster vs HeatMapRef.");
    contentLines.push("Resolved roster deficits remain available in Raw Data.");
    contentLines.push("Missing = unresolved weights plus empty-to-50 roster slots.");
  } else {
    contentLines.push("Resolved roster weight is shown separately from the projected best-fit total.");
    contentLines.push("Selected band source: projected total.");
    contentLines.push("Deltas: resolved roster vs HeatMapRef.");
    contentLines.push("Resolved roster deficits remain available in Raw Data.");
    contentLines.push("Missing = unresolved weights plus empty-to-50 roster slots.");
  }
  if (view !== "raw" && missingHeatMapBands.length > 0) {
    contentLines.push(
      `Missing HeatMapRef band for displayed ACTUAL totals: ${missingHeatMapBands.join("; ")}`,
    );
  }
  return contentLines;
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

export const buildCompoActualDiagnosticsLineForTest = buildCompoActualDiagnosticsLine;

/** Purpose: load the persisted ACTUAL compo state snapshot used by both state rendering and advice simulation. */
export async function loadCompoActualStateContext(
  guildId?: string | null,
): Promise<CompoActualStateContext> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true, shortName: true },
  });
  const trackedClanTags = tracked
    .map((clan) => normalizeTag(clan.tag))
    .filter((tag): tag is string => Boolean(tag));

  if (trackedClanTags.length === 0) {
    return {
      trackedClanTags: [],
      renderableClanTags: [],
      latestSourceSyncedAt: null,
      heatMapRefs: [],
      clans: [],
    };
  }

  const [members, heatMapRefs] = await Promise.all([
    prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: { in: trackedClanTags } },
      select: {
        clanTag: true,
        playerTag: true,
        playerName: true,
        townHall: true,
        weight: true,
        sourceSyncedAt: true,
      },
      orderBy: [{ clanTag: "asc" }, { sourceSyncedAt: "desc" }, { playerTag: "asc" }],
    }),
    prisma.heatMapRef.findMany({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    }),
  ]);

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
  const deferredByClanTagPromise = guildId
    ? listOpenDeferredWeightsByClanAndPlayerTags({
        guildId,
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
  for (const clan of tracked) {
    const clanTag = normalizeTag(clan.tag);
    if (!clanTag) continue;

    const clanMembers = membersByClanTag.get(clanTag) ?? [];
    const deferredByPlayerTag = deferredByClanTag.get(clanTag) ?? new Map();
    const bucketCounts: CompoWarBucketCounts = {
      ...EMPTY_COMPO_WAR_BUCKET_COUNTS,
    };
    let totalResolvedWeight = 0;
    let unresolvedWeightCount = 0;
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
      const { resolvedWeight, resolvedWeightSource } = resolveActualWeightWithSource({
        memberWeight: member.weight,
        catalogWeight,
        deferredWeight,
        currentWeight,
        sameClanWarWeight,
        anyWarWeight,
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
        if (isMissing) {
          unresolvedWeightCount += 1;
        }
        continue;
      }
      totalResolvedWeight += resolvedWeight;
      bucketCounts[bucket] += 1;
      if (isMissing) {
        unresolvedWeightCount += 1;
      }
    }

    clans.push({
      clanTag,
      clanName: clan.name?.trim() || clan.tag,
      shortName: clan.shortName?.trim() || null,
      base: {
        resolvedTotalWeight: totalResolvedWeight,
        unresolvedWeightCount,
        deferredWeightCount,
        memberCount: clanMembers.length,
        bucketCounts,
      },
      members,
    });
  }

  return {
    trackedClanTags,
    renderableClanTags: clans.map((clan) => clan.clanTag),
    latestSourceSyncedAt,
    heatMapRefs,
    clans,
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

    if (context.trackedClanTags.length === 0) {
      return {
        stateRows: null,
        trackedClanTags: [],
        renderableClanTags: [],
        view,
        contentLines: [
          buildPersistedRefreshLine(null),
          `ACTUAL View: **${getCompoActualStateViewLabel(view)}**`,
          "No tracked clans are configured for DB-backed ACTUAL state.",
        ],
      };
    }

    const renderableClanTags: string[] = [];
    const missingHeatMapBands: string[] = [];
    const rows: string[][] = [];
    const totalMissingTo50Count = context.clans.reduce(
      (sum, clan) => sum + Math.max(0, 50 - clan.base.memberCount),
      0,
    );

    for (const clan of context.clans) {
      const projection = projectCompoActualStateView({
        view,
        base: clan.base,
        heatMapRefs: context.heatMapRefs,
      });
      const displayName = buildTrackedClanDisplayName({
        tag: clan.clanTag,
        name: clan.clanName,
      });
      if (!projection.selectedHeatMapRef) {
        missingHeatMapBands.push(
          `${normalizeActualStateClanDisplayName(displayName)} (${projection.totalWeight.toLocaleString("en-US")})`,
        );
      }

      const row = buildActualStateRow({
        clanName: displayName,
        view,
        base: clan.base,
        projection,
      });
      maybeLogCompoActualDiagnostics({
        surface: "state",
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        view,
        base: clan.base,
        projection,
        heatMapRefs: context.heatMapRefs,
      });
      rows.push(row);
      renderableClanTags.push(clan.clanTag);
    }

    return {
      stateRows: [
        view === "raw"
          ? ["Clan", "Resolved Total", "Missing", "DF", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"]
          : [
              "Clan",
              "Resolved Total",
              "Planning Total",
              "Missing",
              "DF",
              "Players",
              "TH18",
              "TH17",
              "TH16",
              "TH15",
              "TH14",
              "<=TH13",
            ],
        ...rows,
      ],
      contentLines: buildActualViewSummaryLines(
        view,
        context.latestSourceSyncedAt,
        missingHeatMapBands,
        totalMissingTo50Count,
      ),
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
      await this.clanMembersSync.syncAllTrackedClans({
        force: true,
      });
      await this.clanMembersSync.refreshCurrentClanMembersForClanTags(
        context.trackedClanTags,
      );
    }

    return this.readState(guildId, options);
  }
}
