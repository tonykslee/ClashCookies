import type {
  HeatMapRef,
  FwaTrackedClanWarRosterCurrent,
  FwaTrackedClanWarRosterMemberCurrent,
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
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import { FwaFeedOpsService } from "./fwa-feeds/FwaFeedOpsService";
import { normalizeFwaTag } from "./fwa-feeds/normalize";

type PlacementCandidate = {
  clanName: string;
  clanTag: string;
  totalWeight: number;
  targetBand: number;
  missingCount: number;
  remainingToTarget: number;
  bucketDeltaByHeader: Record<string, number>;
};

type PlacementCandidateWithVacancy = PlacementCandidate & {
  liveMemberCount: number | null;
  vacancySlots: number;
  hasVacancy: boolean;
};

type PlacementCandidateWithDelta = PlacementCandidateWithVacancy & {
  delta: number;
};

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

type FeedOpsLike = Pick<FwaFeedOpsService, "runTracked">;

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

function normalizeWarPlacementClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value);
  const trimmedRight = normalized.trimEnd();
  return trimmedRight.endsWith("-war")
    ? trimmedRight.slice(0, -"-war".length).trimEnd()
    : trimmedRight;
}

function normalizeBucketDeltaKey(bucket: CompoWarDisplayBucket): string {
  return bucket === "<=TH13" ? "<=th13-delta" : `${bucket.toLowerCase()}-delta`;
}

function toEpochLine(prefix: string, value: Date | null): string {
  if (!value) return `${prefix}: (not available)`;
  return `${prefix}: <t:${Math.floor(value.getTime() / 1000)}:F>`;
}

function buildBucketDeltaByHeader(
  heatMapRef: HeatMapRef,
  members: readonly Pick<FwaTrackedClanWarRosterMemberCurrent, "effectiveWeight">[],
): Record<string, number> | null {
  const bucketCounts = buildCompoWarBucketCounts(members);
  if (!bucketCounts) return null;
  const collapsedCounts = collapseCompoWarBucketCountsForDisplay(bucketCounts);
  return {
    [normalizeBucketDeltaKey("TH18")]: collapsedCounts.TH18 - heatMapRef.th18Count,
    [normalizeBucketDeltaKey("TH17")]: collapsedCounts.TH17 - heatMapRef.th17Count,
    [normalizeBucketDeltaKey("TH16")]: collapsedCounts.TH16 - heatMapRef.th16Count,
    [normalizeBucketDeltaKey("TH15")]: collapsedCounts.TH15 - heatMapRef.th15Count,
    [normalizeBucketDeltaKey("TH14")]: collapsedCounts.TH14 - heatMapRef.th14Count,
    [normalizeBucketDeltaKey("<=TH13")]:
      collapsedCounts["<=TH13"] -
      (heatMapRef.th13Count +
        heatMapRef.th12Count +
        heatMapRef.th11Count +
        heatMapRef.th10OrLowerCount),
  };
}

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

function formatPlacementRows(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None";
}

function _buildCompoPlaceEmbed(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidateWithVacancy[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
}): EmbedBuilder {
  const recommendedRows = params.recommended.map(
    (c) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(c.clanName))} — needs ${Math.abs(c.delta)} ${params.bucket}`,
  );
  const vacancyRows = params.vacancyList.map(
    (c) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(c.clanName))} — ${
        c.liveMemberCount !== null ? `${c.liveMemberCount}/50` : "unknown/50"
      }`,
  );
  const compositionRows = params.compositionList.map(
    (c) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(c.clanName))} — ${c.delta}`,
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

function buildCompoPlaceEmbedDb(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidateWithVacancy[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
}): EmbedBuilder {
  const recommendedRows = params.recommended.map(
    (candidate) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(candidate.clanName))} - needs ${Math.abs(candidate.delta)} ${params.bucket}`,
  );
  const vacancyRows = params.vacancyList.map(
    (candidate) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(candidate.clanName))} - ${
        candidate.liveMemberCount !== null
          ? `${candidate.liveMemberCount}/50`
          : "unknown/50"
      }`,
  );
  const compositionRows = params.compositionList.map(
    (candidate) =>
      `${abbreviateClan(normalizeWarPlacementClanDisplayName(candidate.clanName))} - ${candidate.delta}`,
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

/** Purpose: derive DB-backed `/compo place` suggestions from persisted tracked WAR roster state only. */
export class CompoPlaceService {
  constructor(private readonly feedOps: FeedOpsLike = new FwaFeedOpsService()) {}

  async readPlace(inputWeight: number, bucket: CompoWarDisplayBucket): Promise<CompoPlaceReadResult> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    const trackedClanTags = tracked
      .map((row) => normalizeFwaTag(row.tag))
      .filter((tag): tag is string => Boolean(tag));

    if (trackedClanTags.length === 0) {
      return {
        content: [
          "Mode Displayed: **PLACE**",
          toEpochLine("Persisted WAR data last refreshed", null),
          "No tracked clans are configured for DB-backed placement suggestions.",
        ].join("\n"),
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      };
    }

    const [parents, members, refs] = await Promise.all([
      prisma.fwaTrackedClanWarRosterCurrent.findMany({
        where: { clanTag: { in: trackedClanTags } },
      }),
      prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
        where: { clanTag: { in: trackedClanTags } },
        orderBy: [{ clanTag: "asc" }, { position: "asc" }],
      }),
      prisma.heatMapRef.findMany({
        orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
      }),
    ]);

    const trackedByTag = new Map(
      trackedClanTags.map((tag, index) => [tag, tracked[index]?.name?.trim() ?? null]),
    );
    const parentByTag = new Map(parents.map((row) => [row.clanTag, row]));
    const membersByTag = new Map<string, FwaTrackedClanWarRosterMemberCurrent[]>();
    for (const member of members) {
      const existing = membersByTag.get(member.clanTag) ?? [];
      existing.push(member);
      membersByTag.set(member.clanTag, existing);
    }

    const candidates: PlacementCandidateWithVacancy[] = [];
    const eligibleClanTags: string[] = [];
    const skipped: string[] = [];
    let latestRefreshAt: Date | null = null;

    for (const clanTag of trackedClanTags) {
      const parent = parentByTag.get(clanTag);
      if (!parent) continue;

      const clanMembers = membersByTag.get(clanTag) ?? [];
      const effectiveWeight = parent.totalEffectiveWeight;
      const heatMapRef =
        effectiveWeight === null ? null : findHeatMapRefForWeight(refs, effectiveWeight);
      const displayName =
        parent.clanName?.trim() || trackedByTag.get(clanTag) || parent.clanTag;

      const freshness = parent.sourceUpdatedAt ?? parent.observedAt;
      if (!latestRefreshAt || freshness.getTime() > latestRefreshAt.getTime()) {
        latestRefreshAt = freshness;
      }

      const ineligibleReason = getIneligibleReason({
        parent,
        memberCount: clanMembers.length,
        heatMapRef,
      });
      if (ineligibleReason) {
        skipped.push(`${normalizeWarPlacementClanDisplayName(displayName)} (${ineligibleReason})`);
        continue;
      }

      const bucketDeltaByHeader = buildBucketDeltaByHeader(
        heatMapRef as HeatMapRef,
        clanMembers,
      );
      if (!bucketDeltaByHeader) {
        skipped.push(`${normalizeWarPlacementClanDisplayName(displayName)} (unresolved effective weights)`);
        continue;
      }

      eligibleClanTags.push(clanTag);
      const missingCount = clanMembers.filter((row) => row.rawWeight <= 0).length;
      const vacancySlots = Math.max(0, 50 - parent.rosterSize);
      candidates.push({
        clanName: displayName,
        clanTag: parent.clanTag,
        totalWeight: effectiveWeight as number,
        targetBand: (heatMapRef as HeatMapRef).weightMaxInclusive,
        missingCount,
        remainingToTarget: (heatMapRef as HeatMapRef).weightMaxInclusive - (effectiveWeight as number),
        bucketDeltaByHeader,
        liveMemberCount: parent.rosterSize,
        vacancySlots,
        hasVacancy: vacancySlots > 0,
      });
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
        return normalizeWarPlacementClanDisplayName(a.clanName).localeCompare(
          normalizeWarPlacementClanDisplayName(b.clanName),
        );
      });

    const vacancyList = candidates
      .filter((candidate) => candidate.hasVacancy)
      .sort((a, b) => {
        if (b.vacancySlots !== a.vacancySlots) return b.vacancySlots - a.vacancySlots;
        const remainingDelta =
          Math.abs(a.remainingToTarget - inputWeight) -
          Math.abs(b.remainingToTarget - inputWeight);
        if (remainingDelta !== 0) return remainingDelta;
        return normalizeWarPlacementClanDisplayName(a.clanName).localeCompare(
          normalizeWarPlacementClanDisplayName(b.clanName),
        );
      });
    const recommended = compositionNeeds.filter((candidate) => candidate.hasVacancy);

    const refreshLine = toEpochLine("Persisted WAR data last refreshed", latestRefreshAt);
    if (candidates.length === 0) {
      const contentLines = [
        "Mode Displayed: **PLACE**",
        refreshLine,
      ];
      if (skipped.length > 0) {
        contentLines.push(`Skipped ineligible clans: ${skipped.join("; ")}`);
      }
      contentLines.push(
        "No eligible DB-backed WAR roster snapshots are currently available for placement suggestions.",
      );
      return {
        content: contentLines.join("\n"),
        embeds: [],
        trackedClanTags,
        eligibleClanTags,
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      };
    }

    return {
      content: "",
      embeds: [
        buildCompoPlaceEmbedDb({
          inputWeight,
          bucket,
          recommended,
          vacancyList,
          compositionList: compositionNeeds,
          refreshLine,
        }),
      ],
      trackedClanTags,
      eligibleClanTags,
      candidateCount: candidates.length,
      recommendedCount: recommended.length,
      vacancyCount: vacancyList.length,
      compositionCount: compositionNeeds.length,
    };
  }

  async refreshPlace(inputWeight: number, bucket: CompoWarDisplayBucket): Promise<CompoPlaceReadResult> {
    const current = await this.readPlace(inputWeight, bucket);
    if (current.trackedClanTags.length === 0) {
      return current;
    }

    await mapWithConcurrency(current.trackedClanTags, 3, async (clanTag) => {
      await this.feedOps.runTracked("war-roster", clanTag);
    });

    return this.readPlace(inputWeight, bucket);
  }
}

export const buildCompoPlaceEmbedForTest = buildCompoPlaceEmbedDb;
export const normalizeBucketDeltaKeyForTest = normalizeBucketDeltaKey;
