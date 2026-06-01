import { EmbedBuilder } from "discord.js";
import { prisma } from "../prisma";
import { normalizePlayerTag } from "./PlayerLinkService";
import { playerCurrentService } from "./PlayerCurrentService";
import { todoSnapshotService } from "./TodoSnapshotService";
import type { CoCService } from "./CoCService";
import { getCachedTownHallEmojiMap, renderTownHallIcon, type TownHallEmojiMap } from "../helper/townHallEmoji";
import { buildRaidHitStatsByAttackerTag, type RaidHitStats } from "./RaidHitStatsService";

export type RaidRosterAddResult = {
  added: string[];
  alreadyOnRoster: string[];
  invalidTags: string[];
  duplicateInRequest: string[];
};

export type RaidRosterStatusRow = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  discordUserId: string | null;
  completedRaidAttacks: number;
  raidHitStats30d?: RaidRosterHitStatsSummary;
};

export type RaidRosterHitStatsSummary = {
  totalHits: number;
  oneShots: number;
  twoShots: number;
  threeShots: number;
  averageDestructionPercent: number | null;
  perfectHits: number;
  lastHitAt: Date | null;
};

export type ParsedRaidRosterPlayerTagsInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

function stripOuterQuotes(input: string): string {
  return input.replace(/^['"`]+|['"`]+$/g, "");
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function clampInt(value: unknown, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function normalizeStatsLookupTag(playerTag: string): string | null {
  const normalized = normalizePlayerTag(playerTag);
  return normalized ? normalized.replace(/^#/, "") : null;
}

function emptyRaidRosterHitStatsSummary(): RaidRosterHitStatsSummary & {
  weightedDestructionSum: number;
  weightedDestructionHitCount: number;
} {
  return {
    totalHits: 0,
    oneShots: 0,
    twoShots: 0,
    threeShots: 0,
    averageDestructionPercent: null,
    perfectHits: 0,
    lastHitAt: null,
    weightedDestructionSum: 0,
    weightedDestructionHitCount: 0,
  };
}

function mergeRaidRosterHitStats(
  target: RaidRosterHitStatsSummary & {
    weightedDestructionSum: number;
    weightedDestructionHitCount: number;
  },
  source: RaidHitStats | null | undefined,
): void {
  if (!source || source.totalHits <= 0) return;
  target.totalHits += source.totalHits;
  target.oneShots += source.oneShots;
  target.twoShots += source.twoShots;
  target.threeShots += source.threeShots;
  target.perfectHits += source.perfectHits;
  if (source.averageDestructionPercent !== null) {
    target.weightedDestructionSum += source.averageDestructionPercent * source.totalHits;
    target.weightedDestructionHitCount += source.totalHits;
  }
  if (source.lastHitAt && (!target.lastHitAt || source.lastHitAt > target.lastHitAt)) {
    target.lastHitAt = source.lastHitAt;
  }
}

function finalizeRaidRosterHitStatsSummary(
  value:
    | (RaidRosterHitStatsSummary & {
        weightedDestructionSum: number;
        weightedDestructionHitCount: number;
      })
    | null
    | undefined,
): RaidRosterHitStatsSummary | undefined {
  if (!value || value.totalHits <= 0) return undefined;
  return {
    totalHits: value.totalHits,
    oneShots: value.oneShots,
    twoShots: value.twoShots,
    threeShots: value.threeShots,
    averageDestructionPercent:
      value.weightedDestructionHitCount > 0
        ? value.weightedDestructionSum / value.weightedDestructionHitCount
        : null,
    perfectHits: value.perfectHits,
    lastHitAt: value.lastHitAt,
  };
}

function formatRaidRosterHitStatsSummary(stats: RaidRosterHitStatsSummary | null | undefined): string | null {
  if (!stats || stats.totalHits <= 0) return null;
  const average =
    stats.averageDestructionPercent === null
      ? "—"
      : `${Math.round(stats.averageDestructionPercent)}%`;
  return `30d: 1s ${stats.oneShots} | 2s ${stats.twoShots} | 3s ${stats.threeShots} | avg ${average}`;
}

function buildPlayerProfileMarkdownLink(playerName: string | null, playerTag: string): string {
  const normalizedPlayerTag = normalizePlayerTag(playerTag);
  const label = normalizeText(playerName) || normalizedPlayerTag || "Unknown Player";
  if (!normalizedPlayerTag) return label;
  const encodedTag = normalizedPlayerTag.replace(/^#/, "");
  return `[${label}](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${encodedTag}>)`;
}

export function parseRaidRosterPlayerTagsInput(rawInput: string): ParsedRaidRosterPlayerTagsInput {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) {
    return {
      validTags: [],
      invalidTags: [],
      duplicateTagsInRequest: [],
    };
  }

  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  const parts = withoutBrackets
    .split(/[\s,;]+/g)
    .map((part) => stripOuterQuotes(part.trim()))
    .filter(Boolean);

  const seen = new Set<string>();
  const validTags: string[] = [];
  const invalidTags: string[] = [];
  const duplicateTagsInRequest: string[] = [];

  for (const part of parts) {
    const normalized = normalizePlayerTag(part);
    if (!normalized) {
      invalidTags.push(part);
      continue;
    }
    if (seen.has(normalized)) {
      duplicateTagsInRequest.push(normalized);
      continue;
    }
    seen.add(normalized);
    validTags.push(normalized);
  }

  return {
    validTags,
    invalidTags,
    duplicateTagsInRequest: uniquePreserveOrder(duplicateTagsInRequest),
  };
}

export async function addRaidRosterMembersForGuild(input: {
  guildId: string;
  rawTags: string;
  createdByDiscordUserId?: string | null;
}): Promise<RaidRosterAddResult> {
  const guildId = String(input.guildId ?? "").trim();
  const parsed = parseRaidRosterPlayerTagsInput(input.rawTags);

  if (!guildId || parsed.validTags.length <= 0) {
    return {
      added: [],
      alreadyOnRoster: uniquePreserveOrder(parsed.duplicateTagsInRequest),
      invalidTags: parsed.invalidTags,
      duplicateInRequest: parsed.duplicateTagsInRequest,
    };
  }

  const existingRows = await prisma.raidRosterMember.findMany({
    where: {
      guildId,
      playerTag: { in: parsed.validTags },
    },
    select: { playerTag: true },
  });
  const existingSet = new Set(
    existingRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean),
  );
  const toCreate = parsed.validTags.filter((tag) => !existingSet.has(tag));

  if (toCreate.length > 0) {
    await prisma.raidRosterMember.createMany({
      data: toCreate.map((playerTag) => ({
        guildId,
        playerTag,
        createdByDiscordUserId: String(input.createdByDiscordUserId ?? "").trim() || null,
      })),
      skipDuplicates: true,
    });
  }

  const finalRows = await prisma.raidRosterMember.findMany({
    where: {
      guildId,
      playerTag: { in: parsed.validTags },
    },
    select: { playerTag: true },
  });
  const finalSet = new Set(
    finalRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean),
  );

  const added = parsed.validTags.filter((tag) => finalSet.has(tag) && !existingSet.has(tag));
  const alreadyOnRoster = uniquePreserveOrder([
    ...existingRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean),
    ...parsed.duplicateTagsInRequest,
  ]);

  return {
    added,
    alreadyOnRoster,
    invalidTags: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest,
  };
}

export async function listRaidRosterStatusRowsForGuild(input: {
  guildId: string;
  cocService?: CoCService | null;
}): Promise<RaidRosterStatusRow[]> {
  const guildId = String(input.guildId ?? "").trim();
  if (!guildId) return [];

  const rosterRows = await prisma.raidRosterMember.findMany({
    where: { guildId },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    select: {
      playerTag: true,
    },
  });
  const rosterTags = uniquePreserveOrder(
    rosterRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean),
  );
  if (rosterTags.length <= 0) return [];

  if (input.cocService) {
    await todoSnapshotService
      .refreshSnapshotsForPlayerTags({
        playerTags: rosterTags,
        cocService: input.cocService,
      })
      .catch((error) => {
        console.warn(
          `[raids-roster] event=status_snapshot_refresh_failed guildId=${guildId} playerCount=${rosterTags.length} error=${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  const [snapshotRows, playerCurrentRows, playerLinkRows, playerActivityRows, hitStatsByAttackerTag] = await Promise.all([
    todoSnapshotService.listSnapshotsByPlayerTags({ playerTags: rosterTags }),
    playerCurrentService.listPlayerCurrentByTags(rosterTags),
    prisma.playerLink.findMany({
      where: { playerTag: { in: rosterTags } },
      select: {
        playerTag: true,
        discordUserId: true,
      },
    }),
    prisma.playerActivity.findMany({
      where: { tag: { in: rosterTags } },
      select: {
        tag: true,
        name: true,
      },
    }),
    buildRaidHitStatsByAttackerTag({ guildId }),
  ]);

  const snapshotByTag = new Map(
    snapshotRows.map((row) => [
      normalizePlayerTag(row.playerTag),
      row,
    ] as const).filter((entry): entry is readonly [string, (typeof snapshotRows)[number]] => Boolean(entry[0])),
  );
  const playerCurrentByTag = new Map(playerCurrentRows);
  const playerLinkByTag = new Map(
    playerLinkRows.map((row) => [normalizePlayerTag(row.playerTag), row.discordUserId ?? null] as const).filter((entry): entry is readonly [string, string | null] => Boolean(entry[0])),
  );
  const playerActivityByTag = new Map(
    playerActivityRows
      .map((row) => [normalizePlayerTag(row.tag), normalizeText(row.name)] as const)
      .filter((entry): entry is readonly [string, string | null] => Boolean(entry[0])),
  );

  const directStatsByRosterTag = new Map<string, RaidHitStats>();
  for (const playerTag of rosterTags) {
    const lookupTag = normalizeStatsLookupTag(playerTag);
    const stats = lookupTag ? hitStatsByAttackerTag.get(lookupTag) ?? null : null;
    if (stats) {
      directStatsByRosterTag.set(playerTag, stats);
    }
  }

  const aggregateStatsByDiscordUserId = new Map<
    string,
    RaidRosterHitStatsSummary & {
      weightedDestructionSum: number;
      weightedDestructionHitCount: number;
    }
  >();
  for (const playerTag of rosterTags) {
    const discordUserId = playerLinkByTag.get(playerTag) ?? null;
    if (!discordUserId) continue;
    const stats = directStatsByRosterTag.get(playerTag) ?? null;
    if (!stats) continue;
    const aggregate =
      aggregateStatsByDiscordUserId.get(discordUserId) ?? emptyRaidRosterHitStatsSummary();
    mergeRaidRosterHitStats(aggregate, stats);
    aggregateStatsByDiscordUserId.set(discordUserId, aggregate);
  }

  return rosterTags.map((playerTag) => {
    const snapshot = snapshotByTag.get(playerTag) ?? null;
    const playerCurrent = playerCurrentByTag.get(playerTag) ?? null;
    const activityName = playerActivityByTag.get(playerTag) ?? null;
    const playerName =
      normalizeText(snapshot?.playerName) ??
      normalizeText(playerCurrent?.playerName) ??
      activityName ??
      playerTag;
    const townHall = snapshot?.townHall ?? playerCurrent?.townHall ?? null;
    const completedRaidAttacks = clampInt(snapshot?.raidAttacksUsed ?? 0, 0, 6);
    const discordUserId = playerLinkByTag.get(playerTag) ?? null;
    const raidHitStats30d =
      finalizeRaidRosterHitStatsSummary(
        discordUserId
          ? aggregateStatsByDiscordUserId.get(discordUserId)
          : (() => {
              const stats = directStatsByRosterTag.get(playerTag) ?? null;
              if (!stats) return null;
              const aggregate = emptyRaidRosterHitStatsSummary();
              mergeRaidRosterHitStats(aggregate, stats);
              return aggregate;
            })(),
      );
    return {
      playerTag,
      playerName,
      townHall,
      discordUserId,
      completedRaidAttacks,
      ...(raidHitStats30d ? { raidHitStats30d } : {}),
    };
  });
}

function chunkStatusLines(lines: string[], maxChars = 3500): string[] {
  const pages: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (current && next.length > maxChars) {
      pages.push(current);
      current = line;
      continue;
    }
    current = next;
  }
  if (current) pages.push(current);
  return pages;
}

export function buildRaidRosterStatusLine(
  row: RaidRosterStatusRow,
  townHallEmojiByLevel: TownHallEmojiMap = getCachedTownHallEmojiMap(),
): string {
  const townHallIcon = renderTownHallIcon(row.townHall, townHallEmojiByLevel);
  const playerLink = buildPlayerProfileMarkdownLink(row.playerName, row.playerTag);
  const tag = `\`${normalizePlayerTag(row.playerTag) || row.playerTag}\``;
  const discordPart = row.discordUserId ? `<@${row.discordUserId}>` : "unlinked";
  const statsPart = formatRaidRosterHitStatsSummary(row.raidHitStats30d);
  return `- ${townHallIcon} ${playerLink} ${tag} ${discordPart} - ${row.completedRaidAttacks}/6${statsPart ? ` | ${statsPart}` : ""}`;
}

export function buildRaidRosterStatusEmbeds(
  rows: RaidRosterStatusRow[],
  townHallEmojiByLevel: TownHallEmojiMap = getCachedTownHallEmojiMap(),
): EmbedBuilder[] {
  if (rows.length <= 0) return [];

  const lines = rows.map((row) => buildRaidRosterStatusLine(row, townHallEmojiByLevel));
  const pages = chunkStatusLines(lines);
  const totalPages = pages.length;

  return pages.map((description, index) =>
    (() => {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(totalPages > 1 ? `RAIDS Roster Status (${index + 1}/${totalPages})` : "RAIDS Roster Status")
        .setDescription(description);
      if (totalPages > 1) {
        embed.setFooter({ text: `Page ${index + 1} of ${totalPages}` });
      }
      return embed;
    })(),
  );
}
