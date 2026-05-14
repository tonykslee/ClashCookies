import type { HeatMapRef } from "@prisma/client";
import { EmbedBuilder } from "discord.js";
import { resolveActualCompoWeight } from "../helper/compoActualWeight";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import {
  collapseCompoWarBucketCountsForDisplay,
} from "../helper/compoWarBucketCounts";
import { type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import {
  normalizeTownHallLevel,
  renderTownHallIcon,
  type TownHallEmojiMap,
} from "../helper/townHallEmoji";
import { prisma } from "../prisma";
import { playerCurrentService } from "./PlayerCurrentService";
import {
  loadCompoActualStateContext,
  type CompoActualStateClanContext,
} from "./CompoActualStateService";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import { listFillerAccountTagsForGuild } from "./FillerAccountService";
import { InactiveWarService, type InactiveWarSummary } from "./InactiveWarService";
import { listPlayerLinksForClanMembers, normalizePlayerTag } from "./PlayerLinkService";
import { normalizeTag } from "./war-events/core";
import {
  projectCompoActualStateView,
  type CompoActualStateProjection,
} from "../helper/compoActualStateView";

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

type ReplaceCandidate = {
  clanName: string;
  clanTag: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  weight: number;
  filler: boolean;
  daysInactive: number | null;
  warsMissed: number | null;
  inactiveByDays: boolean;
  inactiveByWars: boolean;
  linkedDiscordUserId: string | null;
};

const REPLACE_FIELD_VALUE_LIMIT = 1024;
const REPLACE_EMBED_TEXT_SAFE_LIMIT = 5900;

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

function buildPlayerProfileMarkdownLink(
  playerName: string | null,
  playerTag: string,
): string {
  const normalizedTag = normalizePlayerTag(playerTag);
  const label = String(playerName ?? "").trim() || normalizedTag || "Unknown Player";
  if (!normalizedTag) return label;
  const encodedTag = normalizedTag.replace(/^#/, "");
  return `[${label}](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${encodedTag}>)`;
}

function buildTrackedClanShortNameMap(rows: Array<{
  tag: string;
  shortName: string | null;
}>): Map<string, string> {
  const byTag = new Map<string, string>();
  for (const row of rows) {
    const tag = normalizeTag(row.tag);
    if (!tag) continue;
    const shortName = String(row.shortName ?? "").trim();
    if (shortName) {
      byTag.set(tag, shortName);
      byTag.set(tag.replace(/^#/, ""), shortName);
    }
  }
  return byTag;
}

function buildReplaceReasonText(candidate: ReplaceCandidate): string {
  const parts: string[] = [];
  if (candidate.filler) parts.push(":man_standing:");
  if (candidate.daysInactive !== null || candidate.warsMissed !== null) {
    parts.push(
      `:zzz: ${Math.max(0, Math.trunc(candidate.daysInactive ?? 0))}d | :x: ${Math.max(
        0,
        Math.trunc(candidate.warsMissed ?? 0),
      )}`,
    );
  }
  return parts.join(" ").trim();
}

function buildReplaceClanPrefix(input: {
  clanName: string;
  clanTag: string;
  shortNameByClanTag: Map<string, string>;
}): string {
  const clanTag = normalizeTag(input.clanTag);
  const shortName = clanTag ? input.shortNameByClanTag.get(clanTag)?.trim() ?? "" : "";
  const clanName = normalizePlaceClanDisplayName(String(input.clanName ?? ""));
  return shortName || clanName || input.clanTag;
}

function truncateReplaceRow(line: string, limit = REPLACE_FIELD_VALUE_LIMIT): string {
  if (line.length <= limit) return line;
  if (limit <= 1) return "\u2026";
  return `${line.slice(0, limit - 1).trimEnd()}\u2026`;
}

function paginateReplaceRows(lines: string[]): string[] {
  const pages: string[] = [];
  let current = "";

  for (const rawLine of lines) {
    const line = String(rawLine ?? "").trim();
    if (!line) continue;

    const next = current.length > 0 ? `${current}\n${line}` : line;
    if (next.length <= REPLACE_FIELD_VALUE_LIMIT) {
      current = next;
      continue;
    }

    if (current.length > 0) {
      pages.push(current);
      current = "";
    }

    if (line.length <= REPLACE_FIELD_VALUE_LIMIT) {
      current = line;
      continue;
    }

    pages.push(truncateReplaceRow(line));
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

function estimateEmbedTextLength(embed: EmbedBuilder): number {
  const json = embed.toJSON();
  let total = 0;
  if (typeof json.title === "string") total += json.title.length;
  if (typeof json.description === "string") total += json.description.length;
  if (json.footer && typeof json.footer.text === "string") total += json.footer.text.length;
  if (Array.isArray(json.fields)) {
    for (const field of json.fields) {
      total += String(field.name ?? "").length;
      total += String(field.value ?? "").length;
    }
  }
  return total;
}

function estimateEmbedFieldTextLength(field: { name: string; value: string }): number {
  return field.name.length + field.value.length;
}

async function buildReplaceRows(input: {
  guildId: string | null | undefined;
  bucket: CompoWarDisplayBucket;
  clans: CompoActualStateClanContext[];
  townHallEmojiByLevel: TownHallEmojiMap;
}): Promise<string[]> {
  const sameBucketMembers = input.clans.flatMap((clan) =>
    clan.members
      .filter(
        (member) =>
          member.resolvedBucket === input.bucket &&
          member.resolvedWeight !== null &&
          member.resolvedWeight > 0,
      )
      .map((member) => ({
        clanName: clan.clanName,
        clanTag: clan.clanTag,
        playerTag: member.playerTag,
        playerName: member.playerName,
        townHall: member.townHall,
        weight: member.resolvedWeight ?? 0,
      })),
  );
  if (sameBucketMembers.length === 0) {
    return [];
  }

  const uniquePlayerTags = [...new Set(
    sameBucketMembers
      .map((member) => normalizePlayerTag(member.playerTag))
      .filter((tag): tag is string => Boolean(tag)),
  )];

  const [fillerTags, activityRows, inactiveWarSummary, linkedRows, trackedClanRows, playerCurrentByTag, fwaCatalogRows] = await Promise.all([
    input.guildId ? listFillerAccountTagsForGuild({ guildId: input.guildId }) : Promise.resolve([]),
    input.guildId
      ? prisma.playerActivity.findMany({
          where: {
            guildId: input.guildId,
            tag: { in: uniquePlayerTags },
          },
          select: {
            tag: true,
            lastSeenAt: true,
          },
          orderBy: [{ tag: "asc" }, { lastSeenAt: "desc" }],
        })
      : Promise.resolve([] as Array<{ tag: string; lastSeenAt: Date }>),
    input.guildId
      ? new InactiveWarService().listInactiveWarPlayers({
          guildId: input.guildId,
          wars: 3,
        })
      : Promise.resolve(null as InactiveWarSummary | null),
    listPlayerLinksForClanMembers({ memberTagsInOrder: uniquePlayerTags }),
    prisma.trackedClan.findMany({
      where: {
        tag: {
          in: input.clans.flatMap((clan) => {
            const normalized = normalizeTag(clan.clanTag);
            return normalized ? [normalized, normalized.replace(/^#/, "")] : [];
          }),
        },
      },
      select: {
        tag: true,
        shortName: true,
      },
    }),
    playerCurrentService.listPlayerCurrentByTags(uniquePlayerTags),
    prisma.fwaPlayerCatalog.findMany({
      where: { playerTag: { in: uniquePlayerTags } },
      select: {
        playerTag: true,
        latestTownHall: true,
      },
    }),
  ]);

  const fillerTagSet = new Set(
    fillerTags.map((tag) => normalizePlayerTag(tag)).filter((tag): tag is string => Boolean(tag)),
  );
  const lastSeenByTag = new Map<string, Date>();
  for (const row of activityRows as Array<{ tag: string; lastSeenAt: Date }>) {
    const tag = normalizePlayerTag(row.tag);
    if (!tag || lastSeenByTag.has(tag)) continue;
    lastSeenByTag.set(tag, row.lastSeenAt);
  }
  const warsMissedByTag = new Map<string, number>();
  const warRows = inactiveWarSummary?.results ?? [];
  for (const row of warRows) {
    const tag = normalizePlayerTag(row.playerTag);
    const missedWars = Math.trunc(Number(row.missedWars));
    if (!tag || !Number.isFinite(missedWars) || missedWars <= 0) continue;
    warsMissedByTag.set(tag, missedWars);
  }
  const linkedDiscordUserIdByTag = new Map<string, string>();
  for (const row of linkedRows) {
    const tag = normalizePlayerTag(row.playerTag);
    const discordUserId = String(row.discordUserId ?? "").trim();
    if (!tag || !discordUserId) continue;
    linkedDiscordUserIdByTag.set(tag, discordUserId);
  }
  const shortNameByClanTag = buildTrackedClanShortNameMap(
    trackedClanRows as Array<{ tag: string; shortName: string | null }>,
  );
  const townHallByTag = new Map<string, number | null>();
  for (const [playerTag, playerCurrent] of playerCurrentByTag.entries()) {
    const playerCurrentTownHall = normalizeTownHallLevel(playerCurrent.townHall);
    if (playerCurrentTownHall !== null) {
      townHallByTag.set(playerTag, playerCurrentTownHall);
    }
  }
  for (const row of fwaCatalogRows as Array<{ playerTag: string; latestTownHall: unknown }>) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || townHallByTag.get(playerTag) !== undefined) continue;
    townHallByTag.set(playerTag, normalizeTownHallLevel(row.latestTownHall));
  }

  const candidates = sameBucketMembers
    .map((member) => {
      const playerTag = normalizePlayerTag(member.playerTag);
      if (!playerTag) return null;
      const filler = fillerTagSet.has(playerTag);
      const lastSeenAt = lastSeenByTag.get(playerTag) ?? null;
      const daysInactive =
        lastSeenAt !== null
          ? Math.max(0, Math.floor((Date.now() - lastSeenAt.getTime()) / (24 * 60 * 60 * 1000)))
          : null;
      const inactiveByDays = daysInactive !== null && daysInactive >= 7;
      const warsMissed = warsMissedByTag.get(playerTag) ?? null;
      const inactiveByWars = warsMissed !== null && warsMissed > 0;
      if (!filler && !inactiveByDays && !inactiveByWars) {
        return null;
      }
      return {
        clanName: member.clanName,
        clanTag: member.clanTag,
        playerTag,
        playerName: member.playerName,
        townHall:
          normalizeTownHallLevel(member.townHall) ??
          townHallByTag.get(playerTag) ??
          null,
        weight: member.weight,
        filler,
        daysInactive,
        warsMissed,
        inactiveByDays,
        inactiveByWars,
        linkedDiscordUserId: linkedDiscordUserIdByTag.get(playerTag) ?? null,
      } satisfies ReplaceCandidate;
    })
    .filter((candidate): candidate is ReplaceCandidate => candidate !== null)
    .sort((a, b) => {
      const aScore =
        (a.filler ? 1 : 0) +
        (a.inactiveByDays ? 1 : 0) +
        (a.inactiveByWars ? 1 : 0);
      const bScore =
        (b.filler ? 1 : 0) +
        (b.inactiveByDays ? 1 : 0) +
        (b.inactiveByWars ? 1 : 0);
      if (bScore !== aScore) return bScore - aScore;
      if ((b.daysInactive ?? -1) !== (a.daysInactive ?? -1)) {
        return (b.daysInactive ?? -1) - (a.daysInactive ?? -1);
      }
      if ((b.warsMissed ?? -1) !== (a.warsMissed ?? -1)) {
        return (b.warsMissed ?? -1) - (a.warsMissed ?? -1);
      }
      if (b.weight !== a.weight) return b.weight - a.weight;
      const clanCompare = a.clanName.localeCompare(b.clanName);
      if (clanCompare !== 0) return clanCompare;
      const nameCompare = a.playerName.localeCompare(b.playerName);
      if (nameCompare !== 0) return nameCompare;
      return a.playerTag.localeCompare(b.playerTag);
    });

  return candidates.map((candidate) => {
    const clanPrefix = buildReplaceClanPrefix({
      clanName: candidate.clanName,
      clanTag: candidate.clanTag,
      shortNameByClanTag,
    });
    const reason = buildReplaceReasonText(candidate);
    const mention = candidate.linkedDiscordUserId
      ? ` <@${candidate.linkedDiscordUserId}>`
      : "";
    return `${clanPrefix} ${renderTownHallIcon(
      candidate.townHall,
      input.townHallEmojiByLevel,
    )} ${candidate.weight.toLocaleString("en-US")} ${reason} - ${buildPlayerProfileMarkdownLink(
      candidate.playerName,
      candidate.playerTag,
    )} \`${candidate.playerTag}\`${mention}`;
  });
}

/** Purpose: preserve the existing `/compo place` embed structure while swapping the source to persisted ACTUAL data. */
function buildCompoPlaceBaseEmbed(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  modeLabel?: string;
  deltaLabel?: string;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
  includeCoreSections?: boolean;
}): EmbedBuilder {
  const includeCoreSections = params.includeCoreSections ?? true;
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
  const fields = [
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
  ];

  const embed = new EmbedBuilder()
    .setTitle("Compo Placement Suggestions")
    .setDescription(
      `Mode: **${params.modeLabel ?? buildCompoPlaceModeLabel()}**\n` +
        `Deltas: **${params.deltaLabel ?? buildCompoPlaceDeltaLabel()}**\n` +
      `Weight: **${params.inputWeight.toLocaleString("en-US")}**\n` +
        `Bucket: **${params.bucket}**\n` +
        params.refreshLine,
    );

  if (includeCoreSections) {
    embed.addFields(...fields);
  }

  return embed;
}

function buildCompoPlaceEmbeds(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  modeLabel?: string;
  deltaLabel?: string;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  replaceRows?: string[];
  refreshLine: string;
}): EmbedBuilder[] {
  const replacePages = paginateReplaceRows(params.replaceRows ?? []);
  if (replacePages.length === 0) {
    return [
      buildCompoPlaceBaseEmbed({
        inputWeight: params.inputWeight,
        bucket: params.bucket,
        modeLabel: params.modeLabel,
        deltaLabel: params.deltaLabel,
        recommended: params.recommended,
        vacancyList: params.vacancyList,
        compositionList: params.compositionList,
        refreshLine: params.refreshLine,
        includeCoreSections: true,
      }),
    ];
  }

  const replaceFields = replacePages.map((value, index) => ({
    name: `Replace ${index + 1}/${replacePages.length}`,
    value,
    inline: false,
  }));

  const embeds: EmbedBuilder[] = [];
  let currentEmbed = buildCompoPlaceBaseEmbed({
    inputWeight: params.inputWeight,
    bucket: params.bucket,
    modeLabel: params.modeLabel,
    deltaLabel: params.deltaLabel,
    recommended: params.recommended,
    vacancyList: params.vacancyList,
    compositionList: params.compositionList,
    refreshLine: params.refreshLine,
    includeCoreSections: true,
  });
  let currentEstimate = estimateEmbedTextLength(currentEmbed);

  for (const field of replaceFields) {
    const fieldEstimate = estimateEmbedFieldTextLength(field);
    if (
      currentEstimate + fieldEstimate > REPLACE_EMBED_TEXT_SAFE_LIMIT &&
      currentEmbed.toJSON().fields?.length
    ) {
      embeds.push(currentEmbed);
      currentEmbed = buildCompoPlaceBaseEmbed({
        inputWeight: params.inputWeight,
        bucket: params.bucket,
        modeLabel: params.modeLabel,
        deltaLabel: params.deltaLabel,
        recommended: [],
        vacancyList: [],
        compositionList: [],
        refreshLine: params.refreshLine,
        includeCoreSections: false,
      });
      currentEstimate = estimateEmbedTextLength(currentEmbed);
    }

    currentEmbed.addFields(field);
    currentEstimate += fieldEstimate;
  }

  if (currentEmbed.toJSON().fields?.length) {
    embeds.push(currentEmbed);
  }

  return embeds;
}

function buildPersistedRefreshLine(latestSourceSyncedAt: Date | null): string {
  if (!latestSourceSyncedAt) {
    return "RAW Data last refreshed: (not available)";
  }
  return `RAW Data last refreshed: <t:${Math.floor(latestSourceSyncedAt.getTime() / 1000)}:F>`;
}

function buildCompoPlaceModeLabel(): string {
  return "ACTUAL Auto-Detect";
}

function buildCompoPlaceDeltaLabel(): string {
  return "resolved roster vs HeatMapRef";
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

function buildBucketDeltaByHeaderFromProjection(
  projection: CompoActualStateProjection,
): Record<string, number> {
  return {
    "th18-delta": projection.deltaByBucket.TH18 ?? 0,
    "th17-delta": projection.deltaByBucket.TH17 ?? 0,
    "th16-delta": projection.deltaByBucket.TH16 ?? 0,
    "th15-delta": projection.deltaByBucket.TH15 ?? 0,
    "th14-delta": projection.deltaByBucket.TH14 ?? 0,
    "<=th13-delta": projection.deltaByBucket["<=TH13"] ?? 0,
  };
}

function buildPlacementCandidates(input: {
  clans: CompoActualStateClanContext[];
  heatMapRefs: HeatMapRef[];
}): {
  candidates: PlacementCandidate[];
  latestSourceSyncedAt: Date | null;
} {
  const candidates: PlacementCandidate[] = [];
  for (const clan of input.clans) {
    if (clan.base.resolvedTotalWeight <= 0) {
      continue;
    }
    const projection = projectCompoActualStateView({
      view: "auto",
      base: clan.base,
      heatMapRefs: input.heatMapRefs,
    });
    const selectedHeatMapRef = projection.selectedHeatMapRef;
    if (!selectedHeatMapRef) {
      continue;
    }

    const liveMemberCount = Math.max(0, Math.min(50, Math.trunc(clan.base.memberCount)));
    candidates.push({
      clanName: normalizePlaceClanDisplayName(clan.clanName),
      clanTag: clan.clanTag,
      totalWeight: projection.totalWeight,
      targetBand: selectedHeatMapRef.weightMaxInclusive,
      missingCount: clan.base.unresolvedWeightCount,
      remainingToTarget: selectedHeatMapRef.weightMaxInclusive - projection.totalWeight,
      bucketDeltaByHeader: buildBucketDeltaByHeaderFromProjection(projection),
      liveMemberCount,
      vacancySlots: Math.max(0, 50 - liveMemberCount),
      hasVacancy: liveMemberCount < 50,
    });
  }

  return { candidates, latestSourceSyncedAt: null };
}

/** Purpose: derive `/compo place` suggestions from persisted ACTUAL feed-backed current-member state. */
export class CompoPlaceService {
  private readonly clanMembersSync = new FwaClanMembersSyncService();

  /** Purpose: load ACTUAL placement suggestions using one persisted tracked-clan/member snapshot read plus deterministic weight fallbacks. */
  async readPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
    townHallEmojiByLevel: TownHallEmojiMap = new Map(),
  ): Promise<CompoPlaceReadResult> {
    const context = await loadCompoActualStateContext(guildId ?? null);
    if (context.trackedClanTags.length === 0) {
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

    const { candidates } = buildPlacementCandidates({
      clans: context.clans,
      heatMapRefs: context.heatMapRefs,
    });

    if (candidates.length === 0) {
      return {
        content:
          "No eligible placement data found in persisted ACTUAL current-member state.",
        embeds: [],
        trackedClanTags: context.trackedClanTags,
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
    const replaceRows = await buildReplaceRows({
      guildId,
      bucket,
      clans: context.clans,
      townHallEmojiByLevel,
    });

    return {
      content: "",
      embeds: buildCompoPlaceEmbeds({
          inputWeight,
          bucket,
          recommended,
          vacancyList,
          compositionList: compositionNeeds,
          replaceRows,
          refreshLine: buildPersistedRefreshLine(context.latestSourceSyncedAt),
          modeLabel: buildCompoPlaceModeLabel(),
          deltaLabel: buildCompoPlaceDeltaLabel(),
        }),
      trackedClanTags: context.trackedClanTags,
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
    townHallEmojiByLevel: TownHallEmojiMap = new Map(),
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
    return this.readPlace(inputWeight, bucket, guildId, townHallEmojiByLevel);
  }
}

export const buildCompoPlaceEmbedForTest = buildCompoPlaceBaseEmbed;
export const buildCompoPlaceEmbedsForTest = buildCompoPlaceEmbeds;
export const buildBucketDeltaByHeaderForTest = buildBucketDeltaByHeader;
export const resolvePlacementWeightForTest = resolveActualCompoWeight;
