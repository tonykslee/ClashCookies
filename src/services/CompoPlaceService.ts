import type {
  FwaClanMemberCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
  HeatMapRef,
  TrackedClan,
} from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { findHeatMapRefForWeight } from "../helper/compoHeatMap";
import {
  buildCompoWarBucketCounts,
  collapseCompoWarBucketCountsForDisplay,
} from "../helper/compoWarBucketCounts";
import { type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import { prisma } from "../prisma";
import {
  listOpenDeferredWeightsByClanAndPlayerTags,
  normalizePlayerTag,
} from "./WeightInputDefermentService";
import { normalizeTag } from "./war-events/core";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";

type PlacementCandidate = {
  clanName: string;
  clanTag: string;
  totalWeight: number;
  targetBand: number;
  missingCount: number;
  remainingToTarget: number;
  bucketDeltaByHeader: Record<string, number>;
  liveMemberCount: number | null;
  vacancySlots: number;
  hasVacancy: boolean;
};

type PlacementCandidateWithDelta = PlacementCandidate & {
  delta: number;
};

type TrackedClanRow = Pick<TrackedClan, "tag" | "name">;
type CurrentMemberRow = Pick<
  FwaClanMemberCurrent,
  "clanTag" | "playerTag" | "weight" | "sourceSyncedAt"
>;
type WarFallbackRow = Pick<
  FwaTrackedClanWarRosterMemberCurrent,
  "clanTag" | "playerTag" | "effectiveWeight" | "updatedAt"
>;

export type CompoPlaceReadResult = {
  content: string;
  embeds: EmbedBuilder[];
  trackedClanTags: string[];
  eligibleClanTags: string[];
  candidateCount: number;
  recommendedCount: number;
  vacancyCount: number;
  compositionCount: number;
};

function normalizePlaceClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value).trimEnd();
  if (!normalized.endsWith("-war")) {
    return normalized;
  }
  return normalized.slice(0, -"-war".length).trimEnd();
}

function abbreviateClan(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/TM/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const map: Record<string, string> = {
    "RISING DAWN": "RD",
    "ZERO GRAVITY": "ZG",
    "DARK EMPIRE": "DE",
    "THE BADLANDS": "BL",
    "LEGENDARY ROYALS": "LR",
    "STEEL EMPIRE": "SE",
    "STEEL EMPIRE 2": "SE",
    THEWISECOWBOYS: "TWC",
    MARVELS: "MV",
    "ROCKY ROAD": "RR",
    AKATSUKI: "AK",
  };

  return map[normalized] ?? value;
}

function normalizeBucketDeltaKey(bucket: CompoWarDisplayBucket): string {
  return bucket === "<=TH13" ? "<=th13-delta" : `${bucket.toLowerCase()}-delta`;
}

function formatPlacementRows(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None";
}

/** Purpose: preserve the existing `/compo place` embed structure while swapping the source to persisted ACTUAL data. */
function buildCompoPlaceEmbed(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
}): EmbedBuilder {
  const recommendedRows = params.recommended.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - needs ${Math.abs(candidate.delta)} ${params.bucket}`,
  );
  const vacancyRows = params.vacancyList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${
        candidate.liveMemberCount !== null
          ? `${candidate.liveMemberCount}/50`
          : "unknown/50"
      }`,
  );
  const compositionRows = params.compositionList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${candidate.delta}`,
  );

  return new EmbedBuilder()
    .setTitle("Compo Placement Suggestions")
    .setDescription(
      `Weight: **${params.inputWeight.toLocaleString("en-US")}**\n` +
        `Bucket: **${params.bucket}**\n` +
        params.refreshLine,
    )
    .addFields(
      {
        name: "Recommended",
        value: formatPlacementRows(recommendedRows),
        inline: false,
      },
      {
        name: "Vacancy",
        value: formatPlacementRows(vacancyRows),
        inline: false,
      },
      {
        name: "Composition",
        value: formatPlacementRows(compositionRows),
        inline: false,
      },
    );
}

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function buildBucketDeltaByHeader(
  heatMapRef: HeatMapRef,
  counts: ReturnType<typeof collapseCompoWarBucketCountsForDisplay>,
): Record<string, number> {
  return {
    "th18-delta": counts.TH18 - heatMapRef.th18Count,
    "th17-delta": counts.TH17 - heatMapRef.th17Count,
    "th16-delta": counts.TH16 - heatMapRef.th16Count,
    "th15-delta": counts.TH15 - heatMapRef.th15Count,
    "th14-delta": counts.TH14 - heatMapRef.th14Count,
    "<=th13-delta":
      counts["<=TH13"] -
      (heatMapRef.th13Count +
        heatMapRef.th12Count +
        heatMapRef.th11Count +
        heatMapRef.th10OrLowerCount),
  };
}

function toPositiveInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function resolvePlacementWeight(input: {
  memberWeight: number | null | undefined;
  deferredWeight: number | null | undefined;
  sameClanWarWeight: number | null | undefined;
  anyWarWeight: number | null | undefined;
}): number | null {
  return (
    toPositiveInt(input.memberWeight) ??
    toPositiveInt(input.deferredWeight) ??
    toPositiveInt(input.sameClanWarWeight) ??
    toPositiveInt(input.anyWarWeight) ??
    null
  );
}

function buildTrackedClanDisplayName(clan: TrackedClanRow): string {
  return clan.name?.trim() || clan.tag;
}

function buildPlacementCandidates(input: {
  tracked: TrackedClanRow[];
  membersByClanTag: Map<string, CurrentMemberRow[]>;
  deferredByClanTag: Map<string, Map<string, number>>;
  warFallbackByClanAndPlayerTag: Map<string, number>;
  warFallbackByPlayerTag: Map<string, number>;
  heatMapRefs: HeatMapRef[];
}): {
  candidates: PlacementCandidate[];
  latestSourceSyncedAt: Date | null;
} {
  const candidates: PlacementCandidate[] = [];
  let latestSourceSyncedAt: Date | null = null;

  for (const clan of input.tracked) {
    const clanTag = normalizeTag(clan.tag);
    if (!clanTag) continue;

    const members = input.membersByClanTag.get(clanTag) ?? [];
    for (const member of members) {
      if (
        !latestSourceSyncedAt ||
        member.sourceSyncedAt.getTime() > latestSourceSyncedAt.getTime()
      ) {
        latestSourceSyncedAt = member.sourceSyncedAt;
      }
    }

    if (members.length === 0) {
      continue;
    }

    const deferredByPlayerTag = input.deferredByClanTag.get(clanTag) ?? new Map();
    const weightedMembers = members
      .map((member) => {
        const playerTag = normalizePlayerTag(member.playerTag);
        const sameClanWarWeight = playerTag
          ? input.warFallbackByClanAndPlayerTag.get(`${clanTag}|${playerTag}`)
          : null;
        const anyWarWeight = playerTag
          ? input.warFallbackByPlayerTag.get(playerTag)
          : null;
        const deferredWeight = playerTag
          ? deferredByPlayerTag.get(playerTag)
          : null;
        const effectiveWeight = resolvePlacementWeight({
          memberWeight: member.weight,
          deferredWeight,
          sameClanWarWeight,
          anyWarWeight,
        });
        return {
          effectiveWeight,
        };
      })
      .filter(
        (member): member is { effectiveWeight: number } =>
          member.effectiveWeight !== null,
      );

    if (weightedMembers.length === 0) {
      continue;
    }

    const totalWeight = weightedMembers.reduce(
      (sum, member) => sum + member.effectiveWeight,
      0,
    );
    const heatMapRef = findHeatMapRefForWeight(input.heatMapRefs, totalWeight);
    if (!heatMapRef) {
      continue;
    }

    const bucketCounts = buildCompoWarBucketCounts(weightedMembers);
    if (!bucketCounts) {
      continue;
    }
    const displayCounts = collapseCompoWarBucketCountsForDisplay(bucketCounts);
    const missingCount = members.filter(
      (member) => toPositiveInt(member.weight) === null,
    ).length;
    const liveMemberCount = Math.max(0, Math.min(50, Math.trunc(members.length)));

    candidates.push({
      clanName: buildTrackedClanDisplayName(clan),
      clanTag,
      totalWeight,
      targetBand: heatMapRef.weightMaxInclusive,
      missingCount,
      remainingToTarget: heatMapRef.weightMaxInclusive - totalWeight,
      bucketDeltaByHeader: buildBucketDeltaByHeader(heatMapRef, displayCounts),
      liveMemberCount,
      vacancySlots: Math.max(0, 50 - liveMemberCount),
      hasVacancy: liveMemberCount < 50,
    });
  }

  return { candidates, latestSourceSyncedAt };
}

/** Purpose: derive `/compo place` suggestions from persisted ACTUAL feed-backed current-member state. */
export class CompoPlaceService {
  private readonly clanMembersSync = new FwaClanMembersSyncService();

  /** Purpose: load ACTUAL placement suggestions using one persisted tracked-clan/member snapshot read plus deterministic weight fallbacks. */
  async readPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
  ): Promise<CompoPlaceReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const trackedClanTags = tracked
      .map((clan) => normalizeTag(clan.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedClanTags.length === 0) {
      return {
        content: "No tracked clans are configured for ACTUAL placement suggestions.",
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
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
      const effectiveWeight = toPositiveInt(row.effectiveWeight);
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

    const { candidates, latestSourceSyncedAt } = buildPlacementCandidates({
      tracked,
      membersByClanTag,
      deferredByClanTag,
      warFallbackByClanAndPlayerTag,
      warFallbackByPlayerTag,
      heatMapRefs,
    });

    if (candidates.length === 0) {
      return {
        content:
          "No eligible placement data found in persisted ACTUAL current-member state.",
        embeds: [],
        trackedClanTags,
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      };
    }

    const compositionNeeds = candidates
      .map((candidate) => ({
        ...candidate,
        delta: candidate.bucketDeltaByHeader[normalizeBucketDeltaKey(bucket)] ?? 0,
      }))
      .filter((candidate) => candidate.delta < 0)
      .sort((a, b) => {
        if (a.delta !== b.delta) return a.delta - b.delta;
        if (b.missingCount !== a.missingCount) return b.missingCount - a.missingCount;
        return normalizePlaceClanDisplayName(a.clanName).localeCompare(
          normalizePlaceClanDisplayName(b.clanName),
        );
      });

    const vacancyList = candidates
      .filter((candidate) => candidate.hasVacancy)
      .sort((a, b) => {
        if (b.vacancySlots !== a.vacancySlots) return b.vacancySlots - a.vacancySlots;
        const distance =
          Math.abs(a.remainingToTarget - inputWeight) -
          Math.abs(b.remainingToTarget - inputWeight);
        if (distance !== 0) return distance;
        return normalizePlaceClanDisplayName(a.clanName).localeCompare(
          normalizePlaceClanDisplayName(b.clanName),
        );
      });

    const recommended = compositionNeeds.filter((candidate) => candidate.hasVacancy);

    return {
      content: "",
      embeds: [
        buildCompoPlaceEmbed({
          inputWeight,
          bucket,
          recommended,
          vacancyList,
          compositionList: compositionNeeds,
          refreshLine: buildPersistedRefreshLine(latestSourceSyncedAt),
        }),
      ],
      trackedClanTags,
      eligibleClanTags: candidates.map((candidate) => candidate.clanTag),
      candidateCount: candidates.length,
      recommendedCount: recommended.length,
      vacancyCount: vacancyList.length,
      compositionCount: compositionNeeds.length,
    };
  }

  /** Purpose: explicitly refresh ACTUAL current-member weights plus live member counts for tracked clans, then rerender `/compo place` from persisted state. */
  async refreshPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
  ): Promise<CompoPlaceReadResult> {
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
    return this.readPlace(inputWeight, bucket, guildId);
  }
}

export const buildCompoPlaceEmbedForTest = buildCompoPlaceEmbed;
export const buildBucketDeltaByHeaderForTest = buildBucketDeltaByHeader;
export const resolvePlacementWeightForTest = resolvePlacementWeight;
