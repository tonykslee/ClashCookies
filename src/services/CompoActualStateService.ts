import type {
  HeatMapRef,
  FwaClanMemberCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
  TrackedClan,
} from "@prisma/client";
import {
  resolveActualCompoWeight,
  toPositiveCompoWeight,
} from "../helper/compoActualWeight";
import {
  getCompoActualStateViewLabel,
  projectCompoActualStateView,
  type CompoActualStateBaseMetrics,
  type CompoActualStateProjection,
  type CompoActualStateView,
} from "../helper/compoActualStateView";
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

type TrackedClanRow = Pick<TrackedClan, "tag" | "name">;
type CurrentMemberRow = Pick<
  FwaClanMemberCurrent,
  "clanTag" | "playerTag" | "playerName" | "townHall" | "weight" | "sourceSyncedAt"
>;
type WarFallbackRow = Pick<
  FwaTrackedClanWarRosterMemberCurrent,
  "clanTag" | "playerTag" | "effectiveWeight" | "updatedAt"
>;

export type CompoActualStateClanContext = {
  clanTag: string;
  clanName: string;
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

type ActualStateRow = {
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

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function normalizeActualStateClanDisplayName(value: string): string {
  return normalizeCompoClanDisplayName(value).trimEnd();
}

function buildActualStateRow(input: {
  clanName: string;
  projection: CompoActualStateProjection;
}): ActualStateRow {
  return {
    clanName: normalizeActualStateClanDisplayName(input.clanName),
    totalWeight: input.projection.totalWeight.toLocaleString("en-US"),
    missingWeights: `${input.projection.missingWeights}`,
    players: `${input.projection.memberCount}`,
    th18Delta:
      input.projection.deltaByBucket.TH18 !== null
        ? `${input.projection.deltaByBucket.TH18}`
        : "?",
    th17Delta:
      input.projection.deltaByBucket.TH17 !== null
        ? `${input.projection.deltaByBucket.TH17}`
        : "?",
    th16Delta:
      input.projection.deltaByBucket.TH16 !== null
        ? `${input.projection.deltaByBucket.TH16}`
        : "?",
    th15Delta:
      input.projection.deltaByBucket.TH15 !== null
        ? `${input.projection.deltaByBucket.TH15}`
        : "?",
    th14Delta:
      input.projection.deltaByBucket.TH14 !== null
        ? `${input.projection.deltaByBucket.TH14}`
        : "?",
    th13OrLowerDelta:
      input.projection.deltaByBucket["<=TH13"] !== null
        ? `${input.projection.deltaByBucket["<=TH13"]}`
        : "?",
  };
}

function buildTrackedClanDisplayName(clan: TrackedClanRow): string {
  return clan.name?.trim() || clan.tag;
}

function buildActualViewSummaryLines(
  view: CompoActualStateView,
  latestSourceSyncedAt: Date | null,
  missingHeatMapBands: string[],
): string[] {
  const contentLines = [
    buildPersistedRefreshLine(latestSourceSyncedAt),
    `ACTUAL View: **${getCompoActualStateViewLabel(view)}**`,
  ];
  if (view === "raw") {
    contentLines.push("Displayed totals use resolved DB-backed ACTUAL weights only.");
    contentLines.push("Missing = unresolved weights only.");
  } else if (view === "auto") {
    contentLines.push(
      "Displayed totals use iterative missing-slot estimation and the converged HeatMapRef band.",
    );
    contentLines.push("Missing = unresolved weights plus empty-to-50 roster slots.");
  } else {
    contentLines.push(
      "Displayed totals use best-fit band scoring; shown estimates are guidance, not persisted truth.",
    );
    contentLines.push("Missing = unresolved weights plus empty-to-50 roster slots.");
  }
  if (missingHeatMapBands.length > 0) {
    contentLines.push(
      `Missing HeatMapRef band for displayed ACTUAL totals: ${missingHeatMapBands.join("; ")}`,
    );
  }
  return contentLines;
}

/** Purpose: load the persisted ACTUAL compo state snapshot used by both state rendering and advice simulation. */
export async function loadCompoActualStateContext(
  guildId?: string | null,
): Promise<CompoActualStateContext> {
  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
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

  const [warFallbackMembers, deferredByClanTag] = await Promise.all([
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
        }),
    guildId
      ? listOpenDeferredWeightsByClanAndPlayerTags({
          guildId,
          clanPlayerTags: trackedClanTags.map((clanTag) => ({
            clanTag,
            playerTags: (membersByClanTag.get(clanTag) ?? []).map(
              (member) => member.playerTag,
            ),
          })),
        })
      : Promise.resolve(new Map<string, Map<string, number>>()),
  ]);

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
    const members: CompoActualStateMemberContext[] = [];

    for (const member of clanMembers) {
      const playerTag = normalizePlayerTag(member.playerTag);
      const sameClanWarWeight = playerTag
        ? warFallbackByClanAndPlayerTag.get(`${clanTag}|${playerTag}`)
        : null;
      const anyWarWeight = playerTag ? warFallbackByPlayerTag.get(playerTag) : null;
      const deferredWeight = playerTag ? deferredByPlayerTag.get(playerTag) : null;
      const resolvedWeight = resolveActualCompoWeight({
        memberWeight: member.weight,
        deferredWeight,
        sameClanWarWeight,
        anyWarWeight,
      });
      const bucket = getCompoWarWeightBucket(resolvedWeight);
      const normalizedTownHall =
        Number.isFinite(Number(member.townHall)) && Number(member.townHall) > 0
          ? Math.trunc(Number(member.townHall))
          : null;
      members.push({
        clanTag,
        playerTag,
        playerName: member.playerName,
        townHall: normalizedTownHall,
        resolvedWeight,
        resolvedBucket: bucket,
      });
      if (resolvedWeight === null || !bucket) {
        unresolvedWeightCount += 1;
        continue;
      }
      totalResolvedWeight += resolvedWeight;
      bucketCounts[bucket] += 1;
    }

    clans.push({
      clanTag,
      clanName: clan.name?.trim() || clan.tag,
      base: {
        resolvedTotalWeight: totalResolvedWeight,
        unresolvedWeightCount,
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
    const view = options?.view ?? "raw";
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
        projection,
      });
      rows.push([
        row.clanName,
        row.totalWeight,
        row.missingWeights,
        row.players,
        row.th18Delta,
        row.th17Delta,
        row.th16Delta,
        row.th15Delta,
        row.th14Delta,
        row.th13OrLowerDelta,
      ]);
      renderableClanTags.push(clan.clanTag);
    }

    return {
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ...rows,
      ],
      contentLines: buildActualViewSummaryLines(
        view,
        context.latestSourceSyncedAt,
        missingHeatMapBands,
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
