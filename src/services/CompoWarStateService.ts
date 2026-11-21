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
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import {
  getCompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import { FwaFeedOpsService } from "./fwa-feeds/FwaFeedOpsService";
import { normalizeFwaTag } from "./fwa-feeds/normalize";
import {
  readHeatMapRefReferenceAvailability,
  type HeatMapRefReferenceAvailability,
} from "../helper/heatMapRefAvailability";
import { SettingsService } from "./SettingsService";

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

/** Purpose: derive the legacy display delta columns while preserving granular internal TH counts. */
function buildCollapsedStateRow(input: {
  clanName: string;
  totalEffectiveWeight: number;
  rosterSize: number;
  missingWeights: number;
  bucketCounts: BucketCounts;
  heatMapRef: HeatMapRef | null;
}): CollapsedStateRow {
  const hasUnsupportedTh19 = (input.bucketCounts.TH19 ?? 0) > 0;
  const deltas = {
    TH18: hasUnsupportedTh19 || !input.heatMapRef ? null : input.bucketCounts.TH18 - input.heatMapRef.th18Count,
    TH17: hasUnsupportedTh19 || !input.heatMapRef ? null : input.bucketCounts.TH17 - input.heatMapRef.th17Count,
    TH16: hasUnsupportedTh19 || !input.heatMapRef ? null : input.bucketCounts.TH16 - input.heatMapRef.th16Count,
    TH15: hasUnsupportedTh19 || !input.heatMapRef ? null : input.bucketCounts.TH15 - input.heatMapRef.th15Count,
    TH14: hasUnsupportedTh19 || !input.heatMapRef ? null : input.bucketCounts.TH14 - input.heatMapRef.th14Count,
    TH13_OR_LOWER:
      hasUnsupportedTh19 || !input.heatMapRef
        ? null
        : input.bucketCounts.TH13 +
          input.bucketCounts.TH12 +
          input.bucketCounts.TH11 +
          input.bucketCounts.TH10 +
          input.bucketCounts.TH9 +
          input.bucketCounts.TH8_OR_LOWER -
          (input.heatMapRef.th13Count +
            input.heatMapRef.th12Count +
            input.heatMapRef.th11Count +
            input.heatMapRef.th10OrLowerCount),
  };

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
    th13OrLowerDelta: deltas.TH13_OR_LOWER === null ? "?" : `${deltas.TH13_OR_LOWER}`,
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

  const [parents, members, refs, referenceAvailability] = await Promise.all([
    prisma.fwaTrackedClanWarRosterCurrent.findMany({
      where: { clanTag: { in: trackedTags } },
    }),
    prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
      where: { clanTag: { in: trackedTags } },
      orderBy: [{ clanTag: "asc" }, { position: "asc" }],
    }),
    prisma.heatMapRef.findMany({
      orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
    }),
    readHeatMapRefReferenceAvailability({
      guildId,
      settings: new SettingsService(),
    }),
  ]);
  const availableRefs =
    referenceAvailability.status === "retained_unverified" ? [] : refs;

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
      allowMissingHeatMapRef: referenceAvailability.status === "retained_unverified",
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

    if (context.trackedClanTags.length === 0) {
      return {
        stateRows: null,
        trackedClanTags: [],
        snapshotClanTags: [],
        renderableClanTags: [],
        contentLines: [
          "WAR · refreshed (not available)",
          "No tracked clans are configured for DB-backed WAR state.",
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
