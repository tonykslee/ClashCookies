import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";

export type ParsedBlacklistClanTagsInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

export type BlacklistClanRow = {
  clanTag: string;
  clanName: string | null;
  sourceLabel: string;
  active: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertBlacklistClanTagsResult = {
  sourceLabel: string;
  active: boolean;
  added: string[];
  updated: string[];
  invalid: string[];
  duplicateInRequest: string[];
  totalRequested: number;
};

const DEFAULT_BLACKLIST_SOURCE_LABEL = "manual-import";

/** Purpose: normalize a free-form blacklist source label into a stable non-empty string. */
export function normalizeBlacklistSourceLabel(input: string | null | undefined): string {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || DEFAULT_BLACKLIST_SOURCE_LABEL;
}

/** Purpose: parse free-form clan tag input into normalized valid/invalid/duplicate buckets. */
export function parseBlacklistClanTagsInput(rawInput: string): ParsedBlacklistClanTagsInput {
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

export class BlacklistClanService {
  async listBlacklistClans(input?: { active?: boolean }): Promise<BlacklistClanRow[]> {
    return prisma.blacklistClan.findMany({
      where: typeof input?.active === "boolean" ? { active: input.active } : undefined,
      orderBy: [{ active: "desc" }, { lastSeenAt: "desc" }, { clanTag: "asc" }],
      select: {
        clanTag: true,
        clanName: true,
        sourceLabel: true,
        active: true,
        firstSeenAt: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async upsertBlacklistClanTags(input: {
    rawTags: string;
    sourceLabel?: string | null;
    active?: boolean | null;
    clanNameByTag?: Map<string, string | null>;
    now?: Date;
  }): Promise<UpsertBlacklistClanTagsResult> {
    const parsed = parseBlacklistClanTagsInput(input.rawTags);
    const now = input.now ?? new Date();
    const sourceLabel = normalizeBlacklistSourceLabel(input.sourceLabel);
    const active = input.active ?? true;
    const requestedCount =
      parsed.validTags.length + parsed.invalidTags.length + parsed.duplicateTagsInRequest.length;

    if (parsed.validTags.length <= 0) {
      return {
        sourceLabel,
        active,
        added: [],
        updated: [],
        invalid: parsed.invalidTags,
        duplicateInRequest: parsed.duplicateTagsInRequest,
        totalRequested: requestedCount,
      };
    }

    const existingRows = await prisma.blacklistClan.findMany({
      where: {
        clanTag: { in: parsed.validTags },
      },
      select: { clanTag: true },
    });
    const existingSet = new Set(
      existingRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean),
    );

    for (const clanTag of parsed.validTags) {
      const clanName =
        input.clanNameByTag?.has(clanTag) === true
          ? input.clanNameByTag?.get(clanTag) ?? null
          : undefined;
      await prisma.blacklistClan.upsert({
        where: { clanTag },
        update: {
          ...(clanName !== undefined ? { clanName } : {}),
          sourceLabel,
          active,
          lastSeenAt: now,
        },
        create: {
          clanTag,
          clanName: clanName ?? null,
          sourceLabel,
          active,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
    }

    const finalRows = await prisma.blacklistClan.findMany({
      where: {
        clanTag: { in: parsed.validTags },
      },
      select: { clanTag: true },
    });
    const finalSet = new Set(
      finalRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean),
    );

    const added: string[] = [];
    const updated: string[] = [];
    for (const clanTag of parsed.validTags) {
      if (!finalSet.has(clanTag)) continue;
      if (existingSet.has(clanTag)) {
        updated.push(clanTag);
      } else {
        added.push(clanTag);
      }
    }

    return {
      sourceLabel,
      active,
      added,
      updated,
      invalid: parsed.invalidTags,
      duplicateInRequest: parsed.duplicateTagsInRequest,
      totalRequested: requestedCount,
    };
  }
}

export const blacklistClanService = new BlacklistClanService();
