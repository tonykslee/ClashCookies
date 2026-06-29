import { prisma } from "../prisma";
import { formatClanBadgeEmoji } from "../helper/clanBadgeEmoji";
import { normalizePlayerTag, normalizeClanTag } from "./PlayerLinkService";

export type ParsedTrackedClanRepTagInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

export type TrackedClanRepWriteClient = {
  trackedClanRep: {
    deleteMany: (args: { where: { clanTag: string } }) => Promise<{ count: number }>;
    createMany: (args: {
      data: Array<{ clanTag: string; playerTag: string }>;
    }) => Promise<{ count: number }>;
  };
};

type TrackedClanRepReadClient = {
  trackedClanRep?: {
    findMany: (args: {
      where: { clanTag: { in: string[] } };
      orderBy?: Array<{ clanTag?: "asc" | "desc"; playerTag?: "asc" | "desc" }>;
      select: { clanTag: true; playerTag: true };
    }) => Promise<Array<{ clanTag: string; playerTag: string }>>;
  };
};

type TrackedClanRepBadgeClanRow = {
  tag: string;
  clanBadge: string | null;
  createdAt: Date;
  mailConfig: unknown;
};

type TrackedClanRepBadgeRow = {
  clanTag: string;
  playerTag: string;
  clan: TrackedClanRepBadgeClanRow | null;
};

type TrackedClanRepBadgeReadClient = {
  trackedClanRep?: {
    findMany: (args: {
      where: { playerTag: { in: string[] } };
      select: {
        clanTag: true;
        playerTag: true;
        clan: {
          select: {
            tag: true;
            clanBadge: true;
            createdAt: true;
            mailConfig: true;
          };
        };
      };
    }) => Promise<TrackedClanRepBadgeRow[]>;
  };
};

function splitFreeFormTagList(rawInput: string): string[] {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) return [];
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return withoutBrackets
    .split(/[\s,;]+/g)
    .map((part) => part.trim().replace(/^['"`]+|['"`]+$/g, ""))
    .filter(Boolean);
}

/** Purpose: parse a free-form tracked-clan rep player-tag list into normalized valid/invalid buckets. */
export function parseTrackedClanRepTagsInput(rawInput: string): ParsedTrackedClanRepTagInput {
  const parts = splitFreeFormTagList(rawInput);
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
    duplicateTagsInRequest: [...new Set(duplicateTagsInRequest)],
  };
}

function tryParseFiniteNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string" && input.trim().length > 0) {
    const parsed = Number(input.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractTrackedClanDisplayOrder(mailConfig: unknown): number | null {
  if (!mailConfig || typeof mailConfig !== "object") return null;
  const obj = mailConfig as Record<string, unknown>;
  const direct =
    tryParseFiniteNumber(obj.displayOrder) ??
    tryParseFiniteNumber(obj.sortOrder) ??
    tryParseFiniteNumber(obj.order);
  if (direct !== null) return direct;

  const nested = obj.display;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as Record<string, unknown>;
    return (
      tryParseFiniteNumber(nestedObj.order) ??
      tryParseFiniteNumber(nestedObj.displayOrder) ??
      null
    );
  }

  return null;
}

function normalizeTrackedClanBadge(input: string | null | undefined): string | null {
  return formatClanBadgeEmoji(input);
}

function compareTrackedClanRepBadgeRows(
  a: TrackedClanRepBadgeRow,
  b: TrackedClanRepBadgeRow,
): number {
  const aClan = a.clan;
  const bClan = b.clan;
  const aDisplayOrder = extractTrackedClanDisplayOrder(aClan?.mailConfig ?? null);
  const bDisplayOrder = extractTrackedClanDisplayOrder(bClan?.mailConfig ?? null);
  const aHasDisplayOrder = aDisplayOrder !== null;
  const bHasDisplayOrder = bDisplayOrder !== null;
  if (aHasDisplayOrder !== bHasDisplayOrder) return aHasDisplayOrder ? -1 : 1;
  if (aDisplayOrder !== null && bDisplayOrder !== null && aDisplayOrder !== bDisplayOrder) {
    return aDisplayOrder - bDisplayOrder;
  }

  const aCreatedAt = aClan?.createdAt?.getTime?.() ?? Number.POSITIVE_INFINITY;
  const bCreatedAt = bClan?.createdAt?.getTime?.() ?? Number.POSITIVE_INFINITY;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

  const aClanTag = normalizeClanTag(aClan?.tag ?? a.clanTag) ?? "";
  const bClanTag = normalizeClanTag(bClan?.tag ?? b.clanTag) ?? "";
  if (aClanTag !== bClanTag) return aClanTag.localeCompare(bClanTag);

  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: replace every configured rep player tag for one tracked FWA clan. */
export async function replaceTrackedClanRepsForClan(
  db: TrackedClanRepWriteClient,
  input: {
    clanTag: string;
    playerTags: string[];
  },
): Promise<string[]> {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag) return [];

  const playerTags = [...new Set(input.playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
  await db.trackedClanRep.deleteMany({
    where: {
      clanTag,
    },
  });

  if (playerTags.length > 0) {
    await db.trackedClanRep.createMany({
      data: playerTags.map((playerTag) => ({
        clanTag,
        playerTag,
      })),
    });
  }

  return playerTags;
}

/** Purpose: bulk-load rep player tags for tracked clan tags in deterministic clan/player order. */
export async function listTrackedClanRepTagsForClanTags(
  clanTags: string[],
  db: TrackedClanRepReadClient = prisma,
): Promise<Map<string, string[]>> {
  const normalizedClanTags = [...new Set(clanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean))];
  const byClan = new Map<string, string[]>();
  if (normalizedClanTags.length === 0 || !db.trackedClanRep?.findMany) {
    return byClan;
  }

  const rows = await db.trackedClanRep.findMany({
    where: {
      clanTag: { in: normalizedClanTags },
    },
    orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
    select: {
      clanTag: true,
      playerTag: true,
    },
  });

  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    const tags = byClan.get(clanTag) ?? [];
    tags.push(playerTag);
    byClan.set(clanTag, tags);
  }

  return byClan;
}

/** Purpose: bulk-load rendered rep badges for player tags in deterministic clan-order. */
export async function listTrackedClanRepBadgesForPlayerTags(
  playerTags: string[],
  db: TrackedClanRepBadgeReadClient = prisma,
): Promise<Map<string, string[]>> {
  const normalizedPlayerTags = [
    ...new Set(playerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean)),
  ];
  const badgesByPlayerTag = new Map<string, string[]>();
  if (normalizedPlayerTags.length === 0 || !db.trackedClanRep?.findMany) {
    return badgesByPlayerTag;
  }

  const rows = (await db.trackedClanRep.findMany({
    where: {
      playerTag: { in: normalizedPlayerTags },
    },
    select: {
      clanTag: true,
      playerTag: true,
      clan: {
        select: {
          tag: true,
          clanBadge: true,
          createdAt: true,
          mailConfig: true,
        },
      },
    },
  })) as TrackedClanRepBadgeRow[];

  if (rows.length === 0) {
    return badgesByPlayerTag;
  }

  const rowsByPlayerTag = new Map<string, TrackedClanRepBadgeRow[]>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const bucket = rowsByPlayerTag.get(playerTag) ?? [];
    bucket.push(row);
    rowsByPlayerTag.set(playerTag, bucket);
  }

  for (const playerTag of normalizedPlayerTags) {
    const repRows = rowsByPlayerTag.get(playerTag) ?? [];
    if (repRows.length === 0) continue;

    const renderedBadges = new Set<string>();
    const orderedRows = [...repRows].sort(compareTrackedClanRepBadgeRows);
    const badgeTokens: string[] = [];

    for (const row of orderedRows) {
      const rawBadge = normalizeTrackedClanBadge(row.clan?.clanBadge ?? null);
      if (!rawBadge) continue;
      if (renderedBadges.has(rawBadge)) continue;
      renderedBadges.add(rawBadge);
      badgeTokens.push(rawBadge);
    }

    if (badgeTokens.length > 0) {
      badgesByPlayerTag.set(playerTag, badgeTokens);
    }
  }

  return badgesByPlayerTag;
}
