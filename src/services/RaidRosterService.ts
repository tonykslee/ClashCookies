import { prisma } from "../prisma";
import { normalizePlayerTag } from "./PlayerLinkService";

export type RaidRosterAddResult = {
  added: string[];
  alreadyOnRoster: string[];
  invalidTags: string[];
  duplicateInRequest: string[];
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
