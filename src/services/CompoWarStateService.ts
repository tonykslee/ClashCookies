import type {
  HeatMapRef,
  FwaTrackedClanWarRosterCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
} from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  type CompoWarWeightBucket,
  getCompoWarWeightBucket,
} from "../helper/compoWarWeightBuckets";
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import { FwaFeedOpsService } from "./fwa-feeds/FwaFeedOpsService";
import { normalizeFwaTag } from "./fwa-feeds/normalize";

type CollapsedStateRow = {
  clanName: string;
  totalWeight: string;
  missingWeights: string;
  players: string;
  th18Delta: string;
  th17Delta: string;
  th16Delta: string;
  th15Delta: string;
  th14Delta: string;
  th13OrLowerDelta: string;
};

type GranularBucketKey = CompoWarWeightBucket;

type BucketCounts = Record<GranularBucketKey, number>;

export type CompoWarStateReadResult = {
  stateRows: string[][] | null;
  contentLines: string[];
  trackedClanTags: string[];
  snapshotClanTags: string[];
  renderableClanTags: string[];
};

const EMPTY_BUCKET_COUNTS: BucketCounts = {
  TH18: 0,
  TH17: 0,
  TH16: 0,
  TH15: 0,
  TH14: 0,
  TH13: 0,
  TH12: 0,
  TH11: 0,
  TH10: 0,
  TH9: 0,
  TH8_OR_LOWER: 0,
};

function normalizeWarStateClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value);
  const trimmedRight = normalized.trimEnd();
  return trimmedRight.endsWith("-war")
    ? trimmedRight.slice(0, -"-war".length).trimEnd()
    : trimmedRight;
}

function toEpochLine(prefix: string, value: Date | null): string {
  if (!value) return `${prefix}: (not available)`;
  return `${prefix}: <t:${Math.floor(value.getTime() / 1000)}:F>`;
}

/** Purpose: count granular compo weight buckets from persisted effective member weights. */
function buildBucketCounts(
  members: readonly Pick<FwaTrackedClanWarRosterMemberCurrent, "effectiveWeight">[],
): BucketCounts | null {
  const counts: BucketCounts = { ...EMPTY_BUCKET_COUNTS };
  for (const member of members) {
    const bucket = getCompoWarWeightBucket(member.effectiveWeight);
    if (!bucket) return null;
    counts[bucket] += 1;
  }
  return counts;
}

/** Purpose: resolve the matching persisted HeatMapRef band for one total effective roster weight. */
function findHeatMapRefForWeight(
  refs: readonly HeatMapRef[],
  totalEffectiveWeight: number,
): HeatMapRef | null {
  return (
    refs.find(
      (row) =>
        totalEffectiveWeight >= row.weightMinInclusive &&
        totalEffectiveWeight <= row.weightMaxInclusive,
    ) ?? null
  );
}

/** Purpose: derive the legacy display delta columns while preserving granular internal TH counts. */
function buildCollapsedStateRow(input: {
  clanName: string;
  totalEffectiveWeight: number;
  rosterSize: number;
  missingWeights: number;
  bucketCounts: BucketCounts;
  heatMapRef: HeatMapRef;
}): CollapsedStateRow {
  const deltas = {
    TH18: input.bucketCounts.TH18 - input.heatMapRef.th18Count,
    TH17: input.bucketCounts.TH17 - input.heatMapRef.th17Count,
    TH16: input.bucketCounts.TH16 - input.heatMapRef.th16Count,
    TH15: input.bucketCounts.TH15 - input.heatMapRef.th15Count,
    TH14: input.bucketCounts.TH14 - input.heatMapRef.th14Count,
    TH13_OR_LOWER:
      input.bucketCounts.TH13 +
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
    th18Delta: `${deltas.TH18}`,
    th17Delta: `${deltas.TH17}`,
    th16Delta: `${deltas.TH16}`,
    th15Delta: `${deltas.TH15}`,
    th14Delta: `${deltas.TH14}`,
    th13OrLowerDelta: `${deltas.TH13_OR_LOWER}`,
  };
}

/** Purpose: explain why one persisted tracked-clan roster snapshot cannot be safely rendered. */
function getIneligibleReason(input: {
  parent: FwaTrackedClanWarRosterCurrent;
  memberCount: number;
  heatMapRef: HeatMapRef | null;
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
  if (!input.heatMapRef) {
    return "missing HeatMapRef band";
  }
  return null;
}

type FeedOpsLike = Pick<FwaFeedOpsService, "runTracked">;

/** Purpose: read and explicitly refresh DB-backed tracked-clan war compo state without touching sheet-backed flows. */
export class CompoWarStateService {
  /** Purpose: allow feed-ops injection for deterministic refresh tests. */
  constructor(private readonly feedOps: FeedOpsLike = new FwaFeedOpsService()) {}

  /** Purpose: load alliance-wide tracked-clan war state rows from persisted feed-owned tables only. */
  async readState(): Promise<CompoWarStateReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const trackedTags = tracked
      .map((row) => normalizeFwaTag(row.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedTags.length === 0) {
      return {
        stateRows: null,
        trackedClanTags: [],
        snapshotClanTags: [],
        renderableClanTags: [],
        contentLines: [
          "Mode Displayed: **WAR**",
          toEpochLine("Persisted WAR data last refreshed", null),
          "No tracked clans are configured for DB-backed WAR state.",
        ],
      };
    }

    const [parents, members, refs] = await Promise.all([
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
    ]);

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

    const renderableRows: string[][] = [];
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
        effectiveWeight === null ? null : findHeatMapRefForWeight(refs, effectiveWeight);
      const ineligibleReason = getIneligibleReason({
        parent,
        memberCount: clanMembers.length,
        heatMapRef,
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

      const bucketCounts = buildBucketCounts(clanMembers);
      if (!bucketCounts) {
        skipped.push(`${normalizeWarStateClanDisplayName(displayName)} (unresolved effective weights)`);
        continue;
      }
      const missingWeights = clanMembers.filter((row) => row.rawWeight <= 0).length;
      const collapsed = buildCollapsedStateRow({
        clanName: displayName,
        totalEffectiveWeight: effectiveWeight as number,
        rosterSize: parent.rosterSize,
        missingWeights,
        bucketCounts,
        heatMapRef: heatMapRef as HeatMapRef,
      });
      renderableRows.push([
        collapsed.clanName,
        collapsed.totalWeight,
        collapsed.missingWeights,
        collapsed.players,
        collapsed.th18Delta,
        collapsed.th17Delta,
        collapsed.th16Delta,
        collapsed.th15Delta,
        collapsed.th14Delta,
        collapsed.th13OrLowerDelta,
      ]);
      renderableClanTags.push(clanTag);
    }

    const contentLines = [
      "Mode Displayed: **WAR**",
      toEpochLine("Persisted WAR data last refreshed", latestRefreshAt),
    ];

    if (skipped.length > 0) {
      contentLines.push(`Skipped ineligible clans: ${skipped.join("; ")}`);
    }

    if (renderableRows.length === 0) {
      contentLines.push("No DB-backed WAR roster snapshots are currently renderable.");
      return {
        stateRows: null,
        trackedClanTags: trackedTags,
        snapshotClanTags,
        renderableClanTags,
        contentLines,
      };
    }

    return {
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ...renderableRows,
      ],
      trackedClanTags: trackedTags,
      snapshotClanTags,
      renderableClanTags,
      contentLines,
    };
  }

  /** Purpose: explicitly refresh the currently persisted tracked-clan war roster scopes and rerender from DB. */
  async refreshState(): Promise<CompoWarStateReadResult> {
    const current = await this.readState();
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

    const next = await this.readState();
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
export const buildBucketCountsForTest = buildBucketCounts;
export const findHeatMapRefForWeightForTest = findHeatMapRefForWeight;
export const buildCollapsedStateRowForTest = buildCollapsedStateRow;
export const getIneligibleReasonForTest = getIneligibleReason;
