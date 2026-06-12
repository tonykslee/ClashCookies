import { prisma } from "../prisma";
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
