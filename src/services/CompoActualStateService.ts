import type {
  FwaClanMemberCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
  HeatMapRef,
  TrackedClan,
} from "@prisma/client";
import {
  resolveActualCompoWeight,
  toPositiveCompoWeight,
} from "../helper/compoActualWeight";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { findHeatMapRefForWeight } from "../helper/compoHeatMap";
import {
  collapseCompoWarBucketCountsForDisplay,
  EMPTY_COMPO_WAR_BUCKET_COUNTS,
  type CompoWarBucketCounts,
} from "../helper/compoWarBucketCounts";
import { getCompoWarWeightBucket } from "../helper/compoWarWeightBuckets";
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
  "clanTag" | "playerTag" | "weight" | "sourceSyncedAt"
>;
type WarFallbackRow = Pick<
  FwaTrackedClanWarRosterMemberCurrent,
  "clanTag" | "playerTag" | "effectiveWeight" | "updatedAt"
>;

export type CompoActualStateReadResult = {
  stateRows: string[][] | null;
  contentLines: string[];
  trackedClanTags: string[];
  renderableClanTags: string[];
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
  totalResolvedWeight: number;
  missingWeights: number;
  playerCount: number;
  bucketCounts: CompoWarBucketCounts;
  heatMapRef: HeatMapRef | null;
}): ActualStateRow {
  const displayCounts = collapseCompoWarBucketCountsForDisplay(input.bucketCounts);
  const lowerTarget = input.heatMapRef
    ? input.heatMapRef.th13Count +
      input.heatMapRef.th12Count +
      input.heatMapRef.th11Count +
      input.heatMapRef.th10OrLowerCount
    : null;
  return {
    clanName: normalizeActualStateClanDisplayName(input.clanName),
    totalWeight: input.totalResolvedWeight.toLocaleString("en-US"),
    missingWeights: `${input.missingWeights}`,
    players: `${input.playerCount}`,
    th18Delta: input.heatMapRef
      ? `${displayCounts.TH18 - input.heatMapRef.th18Count}`
      : "?",
    th17Delta: input.heatMapRef
      ? `${displayCounts.TH17 - input.heatMapRef.th17Count}`
      : "?",
    th16Delta: input.heatMapRef
      ? `${displayCounts.TH16 - input.heatMapRef.th16Count}`
      : "?",
    th15Delta: input.heatMapRef
      ? `${displayCounts.TH15 - input.heatMapRef.th15Count}`
      : "?",
    th14Delta: input.heatMapRef
      ? `${displayCounts.TH14 - input.heatMapRef.th14Count}`
      : "?",
    th13OrLowerDelta:
      lowerTarget !== null ? `${displayCounts["<=TH13"] - lowerTarget}` : "?",
  };
}

function buildTrackedClanDisplayName(clan: TrackedClanRow): string {
  return clan.name?.trim() || clan.tag;
}

/** Purpose: load and explicitly refresh DB-backed ACTUAL compo state from persisted current-member rows only. */
export class CompoActualStateService {
  private readonly clanMembersSync = new FwaClanMembersSyncService();

  /** Purpose: load alliance-wide ACTUAL state rows from persisted tracked-clan current-member data with deterministic weight fallbacks. */
  async readState(guildId?: string | null): Promise<CompoActualStateReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const trackedClanTags = tracked
      .map((clan) => normalizeTag(clan.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedClanTags.length === 0) {
      return {
        stateRows: null,
        trackedClanTags: [],
        renderableClanTags: [],
        contentLines: [
          buildPersistedRefreshLine(null),
          "No tracked clans are configured for DB-backed ACTUAL state.",
        ],
      };
    }

    const [members, heatMapRefs] = await Promise.all([
      prisma.fwaClanMemberCurrent.findMany({
        where: { clanTag: { in: trackedClanTags } },
        select: {
          clanTag: true,
          playerTag: true,
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

    const renderableClanTags: string[] = [];
    const missingHeatMapBands: string[] = [];
    const rows: string[][] = [];

    for (const clan of tracked) {
      const clanTag = normalizeTag(clan.tag);
      if (!clanTag) continue;

      const clanMembers = membersByClanTag.get(clanTag) ?? [];
      const deferredByPlayerTag = deferredByClanTag.get(clanTag) ?? new Map();
      const bucketCounts: CompoWarBucketCounts = {
        ...EMPTY_COMPO_WAR_BUCKET_COUNTS,
      };
      let totalResolvedWeight = 0;
      let missingWeights = 0;

      for (const member of clanMembers) {
        const playerTag = normalizePlayerTag(member.playerTag);
        const sameClanWarWeight = playerTag
          ? warFallbackByClanAndPlayerTag.get(`${clanTag}|${playerTag}`)
          : null;
        const anyWarWeight = playerTag
          ? warFallbackByPlayerTag.get(playerTag)
          : null;
        const deferredWeight = playerTag
          ? deferredByPlayerTag.get(playerTag)
          : null;
        const resolvedWeight = resolveActualCompoWeight({
          memberWeight: member.weight,
          deferredWeight,
          sameClanWarWeight,
          anyWarWeight,
        });
        const bucket = getCompoWarWeightBucket(resolvedWeight);
        if (resolvedWeight === null || !bucket) {
          missingWeights += 1;
          continue;
        }
        totalResolvedWeight += resolvedWeight;
        bucketCounts[bucket] += 1;
      }

      const heatMapRef = findHeatMapRefForWeight(heatMapRefs, totalResolvedWeight);
      const displayName = buildTrackedClanDisplayName(clan);
      if (!heatMapRef) {
        missingHeatMapBands.push(
          `${normalizeActualStateClanDisplayName(displayName)} (${totalResolvedWeight.toLocaleString("en-US")})`,
        );
      }

      const row = buildActualStateRow({
        clanName: displayName,
        totalResolvedWeight,
        missingWeights,
        playerCount: clanMembers.length,
        bucketCounts,
        heatMapRef,
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
      renderableClanTags.push(clanTag);
    }

    const contentLines = [buildPersistedRefreshLine(latestSourceSyncedAt)];
    if (missingHeatMapBands.length > 0) {
      contentLines.push(
        `Missing HeatMapRef band for resolved ACTUAL totals: ${missingHeatMapBands.join("; ")}`,
      );
    }

    return {
      stateRows: [
        ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
        ...rows,
      ],
      contentLines,
      trackedClanTags,
      renderableClanTags,
    };
  }

  /** Purpose: explicitly refresh ACTUAL feed-backed weights plus live member counts for tracked clans, then rerender from persisted state. */
  async refreshState(guildId?: string | null): Promise<CompoActualStateReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    const trackedClanTags = tracked
      .map((clan) => normalizeTag(clan.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedClanTags.length > 0) {
      await this.clanMembersSync.syncAllTrackedClans({
        force: true,
      });
      await this.clanMembersSync.refreshCurrentClanMembersForClanTags(
        trackedClanTags,
      );
    }

    return this.readState(guildId);
  }
}
