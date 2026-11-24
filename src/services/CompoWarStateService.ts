import type {
  HeatMapRef,
  FwaTrackedClanWarRosterCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
} from "@prisma/client";
import { prisma } from "../prisma";
import { findHeatMapRefForWeight } from "../helper/compoHeatMap";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  buildCompoWarBucketCounts,
  collapseCompoWarBucketCountsForDisplay,
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import { getCompoActualStateDeltaByBucket } from "../helper/compoActualStateView";
import {
  getCompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import { FwaFeedOpsService } from "./fwa-feeds/FwaFeedOpsService";
import { normalizeFwaTag } from "./fwa-feeds/normalize";
import { type HeatMapRefReferenceAvailability } from "../helper/heatMapRefAvailability";
import { resolveHeatMapRefReference } from "../helper/heatMapRefResolver";
import { calculateProfileDeviationScore } from "../helper/compoCalculationProfile";
import { LEGACY_COMPO_CALCULATION_PROFILE } from "../helper/compoCalculationProfile";
import { NativeHeatMapReferencePublicationService } from "./NativeHeatMapReferencePublicationService";

type CollapsedStateRow = {
  clanName: string;
  totalWeight: string;
  missingWeights: string;
  players: string;
  th19Count?: string;
  th18Delta: string;
  th17Delta: string;
  th16Delta: string;
  th15Delta: string;
  th14Delta: string;
  th13OrLowerDelta: string;
};

type BucketCounts = CompoWarBucketCounts;

export type CompoWarStateClanContext = {
  clanTag: string;
  clanName: string;
  totalEffectiveWeight: number;
  rosterSize: number;
  missingWeights: number;
  bucketCounts: BucketCounts;
  heatMapRef: HeatMapRef | null;
};

export type CompoWarStateContext = {
  trackedClanTags: string[];
  snapshotClanTags: string[];
  renderableClanTags: string[];
  latestRefreshAt: Date | null;
  skipped: string[];
  clans: CompoWarStateClanContext[];
  heatMapRefs: HeatMapRef[];
  referenceAvailability: HeatMapRefReferenceAvailability;
};

export type CompoWarStateReadResult = {
  stateRows: string[][] | null;
  contentLines: string[];
  trackedClanTags: string[];
  snapshotClanTags: string[];
  renderableClanTags: string[];
};

function normalizeWarStateClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value);
  const trimmedRight = normalized.trimEnd();
  return trimmedRight.endsWith("-war")
    ? trimmedRight.slice(0, -"-war".length).trimEnd()
    : trimmedRight;
}

function toRefreshLine(value: Date | null): string {
  if (!value) return "refreshed (not available)";
  return `refreshed <t:${Math.floor(value.getTime() / 1000)}:F>`;
}

function nativeComparisonLine(input: {
  native: Awaited<ReturnType<NativeHeatMapReferencePublicationService["readCurrent"]>>;
  clans: readonly CompoWarStateClanContext[];
}): string | null {
  if (input.native.status !== "CURRENT") return null;
  let supported = 0;
  let unknown = 0;
  const scores: number[] = [];
  for (const clan of input.clans) {
    const bandOrdinal = input.native.bands.findIndex(
      (band) => clan.totalEffectiveWeight >= band.weightMinInclusive && clan.totalEffectiveWeight <= band.weightMaxInclusive,
    );
    if (bandOrdinal < 0) {
      unknown += 1;
      continue;
    }
    const targets = input.native.targets.filter((target) => target.bandOrdinal === bandOrdinal);
    if (targets.length === 0 || targets.some((target) => target.status !== "SUPPORTED" || target.targetCount === null)) {
      unknown += 1;
      continue;
    }
    const targetByBucket = new Map(targets.map((target) => [target.bucketId, target.targetCount as number]));
    const targetCounts = {
      TH18: targetByBucket.get("TH18")!,
      TH17: targetByBucket.get("TH17")!,
      TH16: targetByBucket.get("TH16")!,
      TH15: targetByBucket.get("TH15")!,
      TH14: targetByBucket.get("TH14")!,
      "<=TH13": (targetByBucket.get("TH13") ?? 0) + (targetByBucket.get("TH12") ?? 0) + (targetByBucket.get("TH11") ?? 0) + (targetByBucket.get("TH10_OR_LOWER") ?? 0),
    };
    const observedCounts = {
      TH18: clan.bucketCounts.TH18 ?? 0,
      TH17: clan.bucketCounts.TH17 ?? 0,
      TH16: clan.bucketCounts.TH16 ?? 0,
      TH15: clan.bucketCounts.TH15 ?? 0,
      TH14: clan.bucketCounts.TH14 ?? 0,
      "<=TH13": (clan.bucketCounts.TH13 ?? 0) + (clan.bucketCounts.TH12 ?? 0) + (clan.bucketCounts.TH11 ?? 0) + (clan.bucketCounts.TH10 ?? 0) + (clan.bucketCounts.TH9 ?? 0) + (clan.bucketCounts.TH8_OR_LOWER ?? 0),
    };
    const score = calculateProfileDeviationScore({ profile: LEGACY_COMPO_CALCULATION_PROFILE, observedCounts, targetCounts });
    if (score === null) unknown += 1;
    else { supported += 1; scores.push(score); }
  }
  const scoreText = scores.length > 0 ? ` · profile score avg ${ (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1) }` : "";
  return `Provisional native comparison (informational only; no recommendations): ${supported} supported / ${unknown} UNKNOWN clans · ${input.native.profileVersion} · ${input.native.policyVersion}${scoreText}`;
}

/** Purpose: derive the legacy display delta columns while preserving granular internal TH counts. */
function buildCollapsedStateRow(input: {
  clanName: string;
  totalEffectiveWeight: number;
  rosterSize: number;
  missingWeights: number;
  bucketCounts: BucketCounts;
  heatMapRef: HeatMapRef | null;
}): CollapsedStateRow {
  const deltas = getCompoActualStateDeltaByBucket(
    collapseCompoWarBucketCountsForDisplay(input.bucketCounts),
    input.heatMapRef,
  );

  return {
    clanName: normalizeWarStateClanDisplayName(input.clanName),
    totalWeight: input.totalEffectiveWeight.toLocaleString("en-US"),
    missingWeights: `${input.missingWeights}`,
    players: `${input.rosterSize}`,
    ...((input.bucketCounts.TH19 ?? 0) > 0
      ? { th19Count: `${input.bucketCounts.TH19}` }
      : {}),
    th18Delta: deltas.TH18 === null ? "?" : `${deltas.TH18}`,
    th17Delta: deltas.TH17 === null ? "?" : `${deltas.TH17}`,
    th16Delta: deltas.TH16 === null ? "?" : `${deltas.TH16}`,
    th15Delta: deltas.TH15 === null ? "?" : `${deltas.TH15}`,
    th14Delta: deltas.TH14 === null ? "?" : `${deltas.TH14}`,
    th13OrLowerDelta: deltas["<=TH13"] === null ? "?" : `${deltas["<=TH13"]}`,
  };
}

/** Purpose: explain why one persisted tracked-clan roster snapshot cannot be safely rendered. */
function getIneligibleReason(input: {
  parent: FwaTrackedClanWarRosterCurrent;
  memberCount: number;
  heatMapRef: HeatMapRef | null;
  allowMissingHeatMapRef?: boolean;
}): string | null {
  if (input.parent.rosterSize !== 50) {
    return `roster size ${input.parent.rosterSize}/50`;
  }
  if (input.parent.hasUnresolvedWeights) {
    return "unresolved effective weights";
  }
  if (input.parent.totalEffectiveWeight === null) {
    return "missing total effective weight";
  }
  if (input.memberCount !== input.parent.rosterSize) {
    return `persisted member rows ${input.memberCount}/${input.parent.rosterSize}`;
  }
  if (!input.heatMapRef && !input.allowMissingHeatMapRef) {
    return "missing HeatMapRef band";
  }
  return null;
}

/** Purpose: load the persisted WAR compo state snapshot used by both state rendering and advice simulation. */
export async function loadCompoWarStateContext(
  guildId?: string | null,
): Promise<CompoWarStateContext> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  const trackedTags = tracked
    .map((row) => normalizeFwaTag(row.tag))
    .filter((tag): tag is string => Boolean(tag));

  if (trackedTags.length === 0) {
    return {
      trackedClanTags: [],
      snapshotClanTags: [],
      renderableClanTags: [],
      latestRefreshAt: null,
      skipped: [],
      clans: [],
      heatMapRefs: [],
      referenceAvailability: {
        status: "unknown",
        blockReasonCode: null,
        lastSuccessAtIso: null,
        warning: null,
      },
    };
  }

  const [parents, members, reference] = await Promise.all([
    prisma.fwaTrackedClanWarRosterCurrent.findMany({
      where: { clanTag: { in: trackedTags } },
    }),
    prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
      where: { clanTag: { in: trackedTags } },
      orderBy: [{ clanTag: "asc" }, { position: "asc" }],
    }),
    resolveHeatMapRefReference({ guildId }),
  ]);
  const refs = reference.heatMapRefs;
  const referenceAvailability = reference.availability;
  const availableRefs =
    referenceAvailability.status === "validated" ? refs : [];

  const trackedByTag = new Map(
    trackedTags.map((tag, index) => [tag, tracked[index]?.name?.trim() ?? null]),
  );
  const parentByTag = new Map(parents.map((row) => [row.clanTag, row]));
  const membersByTag = new Map<string, FwaTrackedClanWarRosterMemberCurrent[]>();
  for (const member of members) {
    const existing = membersByTag.get(member.clanTag) ?? [];
    existing.push(member);
    membersByTag.set(member.clanTag, existing);
  }

  const clans: CompoWarStateClanContext[] = [];
  const skipped: string[] = [];
  const renderableClanTags: string[] = [];
  const snapshotClanTags = parents.map((row) => row.clanTag);
  let latestRefreshAt: Date | null = null;

  for (const clanTag of trackedTags) {
    const parent = parentByTag.get(clanTag);
    if (!parent) {
      continue;
    }
    const clanMembers = membersByTag.get(clanTag) ?? [];
    const effectiveWeight = parent.totalEffectiveWeight;
    const heatMapRef =
      effectiveWeight === null ? null : findHeatMapRefForWeight(availableRefs, effectiveWeight);
    const ineligibleReason = getIneligibleReason({
      parent,
      memberCount: clanMembers.length,
      heatMapRef,
      allowMissingHeatMapRef: referenceAvailability.status !== "validated",
    });
    const displayName =
      parent.clanName?.trim() ||
      trackedByTag.get(clanTag) ||
      parent.clanTag;

    const freshness = parent.sourceUpdatedAt ?? parent.observedAt;
    if (!latestRefreshAt || freshness.getTime() > latestRefreshAt.getTime()) {
      latestRefreshAt = freshness;
    }

    if (ineligibleReason) {
      skipped.push(`${normalizeWarStateClanDisplayName(displayName)} (${ineligibleReason})`);
      continue;
    }

    const bucketCounts = buildCompoWarBucketCounts(clanMembers);
    if (!bucketCounts) {
      skipped.push(`${normalizeWarStateClanDisplayName(displayName)} (unresolved effective weights)`);
      continue;
    }
    const missingWeights = clanMembers.filter((row) => row.rawWeight <= 0).length;
    clans.push({
      clanTag,
      clanName: displayName,
      totalEffectiveWeight: effectiveWeight as number,
      rosterSize: parent.rosterSize,
      missingWeights,
      bucketCounts,
      heatMapRef,
    });
    renderableClanTags.push(clanTag);
  }

  return {
    trackedClanTags: trackedTags,
    snapshotClanTags,
    renderableClanTags,
    latestRefreshAt,
    skipped,
    clans,
    heatMapRefs: availableRefs,
    referenceAvailability,
  };
}

type FeedOpsLike = Pick<FwaFeedOpsService, "runTracked">;

/** Purpose: read and explicitly refresh DB-backed tracked-clan war compo state without touching sheet-backed flows. */
export class CompoWarStateService {
  /** Purpose: allow feed-ops injection for deterministic refresh tests. */
  constructor(private readonly feedOps: FeedOpsLike = new FwaFeedOpsService()) {}

  /** Purpose: load alliance-wide tracked-clan war state rows from persisted feed-owned tables only. */
  async readState(guildId?: string | null): Promise<CompoWarStateReadResult> {
    const context = await loadCompoWarStateContext(guildId);
    let nativeLine: string | null = null;
    try {
      const nativeDb = prisma as typeof prisma & { nativeHeatMapReferenceHead?: unknown };
      if (nativeDb.nativeHeatMapReferenceHead) {
        nativeLine = nativeComparisonLine({ native: await new NativeHeatMapReferencePublicationService(prisma).readCurrent(), clans: context.clans });
      }
    } catch {
      nativeLine = null;
    }

    if (context.trackedClanTags.length === 0) {
      return {
        stateRows: null,
        trackedClanTags: [],
        snapshotClanTags: [],
        renderableClanTags: [],
        contentLines: [
          "WAR · refreshed (not available)",
          "No tracked clans are configured for DB-backed WAR state.",
        ...(nativeLine ? [nativeLine] : []),
        ],
      };
    }
    const renderableRows: string[][] = [];
    const includeTh19 = context.clans.some(
      (clan) => (clan.bucketCounts.TH19 ?? 0) > 0,
    );
    for (const clan of context.clans) {
      const collapsed = buildCollapsedStateRow({
        clanName: clan.clanName,
        totalEffectiveWeight: clan.totalEffectiveWeight,
        rosterSize: clan.rosterSize,
        missingWeights: clan.missingWeights,
        bucketCounts: clan.bucketCounts,
        heatMapRef: clan.heatMapRef,
      });
      renderableRows.push([
        collapsed.clanName,
        collapsed.totalWeight,
        collapsed.missingWeights,
        collapsed.players,
        ...(includeTh19 ? [collapsed.th19Count ?? "0"] : []),
        collapsed.th18Delta,
        collapsed.th17Delta,
        collapsed.th16Delta,
        collapsed.th15Delta,
        collapsed.th14Delta,
        collapsed.th13OrLowerDelta,
      ]);
    }

    const contentLines = [
      `WAR · ${toRefreshLine(context.latestRefreshAt)}`,
      `Columns: Total=effective weight; Missing=unresolved weights; Players=roster size; ${includeTh19 ? "TH19=observed count; " : ""}TH columns=delta vs HeatMapRef.`,
    ];

    if (context.skipped.length > 0) {
      contentLines.push(`Skipped ineligible clans: ${context.skipped.join("; ")}`);
    }
    if (context.referenceAvailability.warning) {
      contentLines.push(`Reference warning: ${context.referenceAvailability.warning}`);
    }
    if (nativeLine) contentLines.push(nativeLine);

    if (renderableRows.length === 0) {
      contentLines.push("No DB-backed WAR roster snapshots are currently renderable.");
      return {
        stateRows: null,
        trackedClanTags: context.trackedClanTags,
        snapshotClanTags: context.snapshotClanTags,
        renderableClanTags: context.renderableClanTags,
        contentLines,
      };
    }

    return {
      stateRows: [
        [
          "Clan",
          "Total",
          "Missing",
          "Players",
          ...(includeTh19 ? ["TH19"] : []),
          "TH18",
          "TH17",
          "TH16",
          "TH15",
          "TH14",
          "<=TH13",
        ],
        ...renderableRows,
      ],
      trackedClanTags: context.trackedClanTags,
      snapshotClanTags: context.snapshotClanTags,
      renderableClanTags: context.renderableClanTags,
      contentLines,
    };
  }

  /** Purpose: explicitly refresh the currently persisted tracked-clan war roster scopes and rerender from DB. */
  async refreshState(guildId?: string | null): Promise<CompoWarStateReadResult> {
    const current = await this.readState(guildId);
    if (current.trackedClanTags.length === 0) {
      return current;
    }

    const failures: string[] = [];
    await mapWithConcurrency(current.trackedClanTags, 3, async (clanTag) => {
      try {
        await this.feedOps.runTracked("war-roster", clanTag);
      } catch {
        failures.push(clanTag);
      }
    });

    const next = await this.readState(guildId);
    if (failures.length > 0) {
      next.contentLines = [
        ...next.contentLines,
        `Refresh warnings: ${failures.map((tag) => `#${tag.replace(/^#/, "")}`).join(", ")}`,
      ];
    }
    return next;
  }
}

export const getCompoWarWeightBucketForTest = getCompoWarWeightBucket;
export const buildBucketCountsForTest = buildCompoWarBucketCounts;
export const findHeatMapRefForWeightForTest = findHeatMapRefForWeight;
export const buildCollapsedStateRowForTest = buildCollapsedStateRow;
export const getIneligibleReasonForTest = getIneligibleReason;
