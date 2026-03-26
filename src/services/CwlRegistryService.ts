import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";

export type TrackedClanRegistryType = "FWA" | "CWL";

export type ParsedCwlTagInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

export type AddCwlClanTagsResult = {
  season: string;
  added: string[];
  alreadyExisting: string[];
  invalid: string[];
  duplicateInRequest: string[];
};

export type RemoveTrackedClanResult =
  | {
      outcome: "removed";
      tag: string;
      removedFrom: TrackedClanRegistryType;
      season: string;
      removedCount: number;
    }
  | {
      outcome: "not_found";
      tag: string;
      season: string;
    }
  | {
      outcome: "ambiguous";
      tag: string;
      season: string;
    };

/** Purpose: resolve current CWL month key in stable UTC `YYYY-MM` format. */
export function resolveCurrentCwlSeasonKey(nowMs?: number): string {
  const now = Number.isFinite(nowMs) ? new Date(Number(nowMs)) : new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Purpose: parse one free-form CWL tags input string into normalized valid/invalid/duplicate buckets. */
export function parseCwlClanTagsInput(rawInput: string): ParsedCwlTagInput {
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
    .map((part) => part.trim().replace(/^['"`]+|['"`]+$/g, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  const validTags: string[] = [];
  const invalidTags: string[] = [];
  const duplicateTagsInRequest: string[] = [];
  for (const part of parts) {
    const normalized = normalizeClanTag(part);
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

/** Purpose: add one CWL clan-tag batch for a target season with partial-success semantics. */
export async function addCwlClanTagsForSeason(input: {
  rawTags: string;
  season?: string;
  cocService?: CoCService;
}): Promise<AddCwlClanTagsResult> {
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  const parsed = parseCwlClanTagsInput(input.rawTags);
  if (parsed.validTags.length <= 0) {
    return {
      season,
      added: [],
      alreadyExisting: [],
      invalid: parsed.invalidTags,
      duplicateInRequest: parsed.duplicateTagsInRequest,
    };
  }

  const existing = await prisma.cwlTrackedClan.findMany({
    where: {
      season,
      tag: { in: parsed.validTags },
    },
    select: { tag: true },
  });
  const existingSet = new Set(existing.map((row) => normalizeClanTag(row.tag)).filter(Boolean));
  const toCreate = parsed.validTags.filter((tag) => !existingSet.has(tag));

  const namesByTag = new Map<string, string | null>();
  if (input.cocService && toCreate.length > 0) {
    const lookups = await Promise.allSettled(
      toCreate.map(async (tag) => {
        const clan = await input.cocService!.getClan(tag);
        return [tag, String(clan.name ?? "").trim() || null] as const;
      }),
    );
    for (const lookup of lookups) {
      if (lookup.status !== "fulfilled") continue;
      namesByTag.set(lookup.value[0], lookup.value[1]);
    }
  }

  if (toCreate.length > 0) {
    await prisma.cwlTrackedClan.createMany({
      data: toCreate.map((tag) => ({
        season,
        tag,
        name: namesByTag.get(tag) ?? null,
      })),
      skipDuplicates: true,
    });
  }

  const finalRows = await prisma.cwlTrackedClan.findMany({
    where: {
      season,
      tag: { in: parsed.validTags },
    },
    select: { tag: true },
  });
  const finalSet = new Set(finalRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean));

  const added: string[] = [];
  const alreadyExisting: string[] = [];
  for (const tag of parsed.validTags) {
    if (!finalSet.has(tag)) continue;
    if (existingSet.has(tag)) {
      alreadyExisting.push(tag);
      continue;
    }
    added.push(tag);
  }

  return {
    season,
    added,
    alreadyExisting,
    invalid: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest,
  };
}

/** Purpose: list one season-scoped CWL tracked-clan registry in deterministic order. */
export async function listCwlTrackedClansForSeason(input?: {
  season?: string;
}): Promise<Array<{ season: string; tag: string; name: string | null; createdAt: Date }>> {
  const season = input?.season ?? resolveCurrentCwlSeasonKey();
  const rows = await prisma.cwlTrackedClan.findMany({
    where: { season },
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: {
      season: true,
      tag: true,
      name: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    season: row.season,
    tag: normalizeClanTag(row.tag) || row.tag,
    name: row.name,
    createdAt: row.createdAt,
  }));
}

/** Purpose: remove one tag from FWA/CWL registries with deterministic ambiguity handling. */
export async function removeTrackedClanTagFromRegistries(input: {
  tag: string;
  type?: TrackedClanRegistryType | null;
  season?: string;
}): Promise<RemoveTrackedClanResult> {
  const normalizedTag = normalizeClanTag(input.tag);
  const season = input.season ?? resolveCurrentCwlSeasonKey();
  if (!normalizedTag) {
    return {
      outcome: "not_found",
      tag: "",
      season,
    };
  }

  if (input.type === "FWA") {
    const deleted = await prisma.trackedClan.deleteMany({
      where: { tag: normalizedTag },
    });
    if (deleted.count <= 0) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "FWA",
      season,
      removedCount: deleted.count,
    };
  }

  if (input.type === "CWL") {
    const [deletedClans, deletedMappings] = await prisma.$transaction([
      prisma.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      }),
      prisma.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      }),
    ]);
    if (deletedClans.count <= 0) {
      return { outcome: "not_found", tag: normalizedTag, season };
    }
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: deletedClans.count + deletedMappings.count,
    };
  }

  const [fwaRow, cwlRow] = await Promise.all([
    prisma.trackedClan.findUnique({
      where: { tag: normalizedTag },
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findFirst({
      where: { season, tag: normalizedTag },
      select: { id: true },
    }),
  ]);

  if (fwaRow && cwlRow) {
    return {
      outcome: "ambiguous",
      tag: normalizedTag,
      season,
    };
  }

  if (fwaRow) {
    const deleted = await prisma.trackedClan.deleteMany({
      where: { tag: normalizedTag },
    });
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "FWA",
      season,
      removedCount: deleted.count,
    };
  }

  if (cwlRow) {
    const [deletedClans, deletedMappings] = await prisma.$transaction([
      prisma.cwlTrackedClan.deleteMany({
        where: { season, tag: normalizedTag },
      }),
      prisma.cwlPlayerClanSeason.deleteMany({
        where: { season, cwlClanTag: normalizedTag },
      }),
    ]);
    return {
      outcome: "removed",
      tag: normalizedTag,
      removedFrom: "CWL",
      season,
      removedCount: deletedClans.count + deletedMappings.count,
    };
  }

  return {
    outcome: "not_found",
    tag: normalizedTag,
    season,
  };
}
