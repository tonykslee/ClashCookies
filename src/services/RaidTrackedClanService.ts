import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { CoCService } from "./CoCService";
import { RecruitingType } from "../generated/coc-api";

export type RaidTrackedClanJoinType = "open" | "inviteOnly" | "closed";

export type RaidTrackedClanDisplayRow = {
  clanTag: string;
  clanName: string | null;
  upgrades: number | null;
  joinType: RaidTrackedClanJoinType | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RaidTrackedClanWriteResult = {
  added: string[];
  updated: string[];
  alreadyExisting: string[];
  invalid: string[];
  duplicateInRequest: string[];
  joinTypeRefreshFailures: string[];
};

function stripLeadingHash(tag: string): string {
  return tag.startsWith("#") ? tag.slice(1) : tag;
}

function toDisplayTag(tag: string): string {
  return `#${stripLeadingHash(tag)}`;
}

export function normalizeRaidTrackedClanTag(input: string): string | null {
  const normalized = normalizeClanTag(input);
  if (!normalized) return null;
  return stripLeadingHash(normalized);
}

export function parseRaidTrackedClanTagsInput(rawInput: string): {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
} {
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
    const normalized = normalizeRaidTrackedClanTag(part);
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

export function getRaidTrackedClanJoinTypeEmoji(
  joinType: RaidTrackedClanJoinType | null,
): string {
  switch (joinType) {
    case "open":
      return "🟢";
    case "inviteOnly":
      return "🟡";
    case "closed":
      return "🔴";
    default:
      return "⚪";
  }
}

function normalizeRaidJoinType(
  joinType: RecruitingType | string | null | undefined,
): RaidTrackedClanJoinType | null {
  const raw = String(joinType ?? "").trim();
  if (raw === "open" || raw === "inviteOnly" || raw === "closed") {
    return raw;
  }
  return null;
}

async function resolveRaidTrackedClanDisplayNames(
  storedClanTags: string[],
): Promise<Map<string, string>> {
  const displayTagMap = new Map<string, string>();
  const normalizedTags = [...new Set(storedClanTags.map((tag) => toDisplayTag(tag)))];
  if (normalizedTags.length === 0) return displayTagMap;

  const season = resolveCurrentCwlSeasonKey();
  const [trackedRows, cwlRows] = await Promise.all([
    prisma.trackedClan.findMany({
      where: { tag: { in: normalizedTags } },
      select: { tag: true, name: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: { season, tag: { in: normalizedTags } },
      select: { tag: true, name: true },
    }),
  ]);

  for (const row of trackedRows) {
    const tag = normalizeClanTag(row.tag);
    if (!tag) continue;
    const storedTag = stripLeadingHash(tag);
    const name = String(row.name ?? "").trim();
    if (name && !displayTagMap.has(storedTag)) {
      displayTagMap.set(storedTag, name);
    }
  }

  for (const row of cwlRows) {
    const tag = normalizeClanTag(row.tag);
    if (!tag) continue;
    const storedTag = stripLeadingHash(tag);
    const name = String(row.name ?? "").trim();
    if (name && !displayTagMap.has(storedTag)) {
      displayTagMap.set(storedTag, name);
    }
  }

  return displayTagMap;
}

function formatRaidTrackedClanListLine(input: RaidTrackedClanDisplayRow): string {
  const clanTagDisplay = stripLeadingHash(input.clanTag);
  const clanName = String(input.clanName ?? "").trim() || clanTagDisplay;
  const upgradesText = input.upgrades === null ? "—" : String(input.upgrades);
  const emoji = getRaidTrackedClanJoinTypeEmoji(input.joinType);
  const url = `https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(clanTagDisplay)}`;
  return `## ${emoji} [${clanName} | ${upgradesText}](<${url}>) \`${clanTagDisplay}\``;
}

export function buildRaidTrackedClanListLines(
  rows: RaidTrackedClanDisplayRow[],
): string[] {
  return rows.map((row) => formatRaidTrackedClanListLine(row));
}

export async function listRaidTrackedClansForDisplay(): Promise<
  RaidTrackedClanDisplayRow[]
> {
  const rows = await prisma.raidTrackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
    select: {
      clanTag: true,
      upgrades: true,
      joinType: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (rows.length === 0) return [];

  const displayNames = await resolveRaidTrackedClanDisplayNames(
    rows.map((row) => row.clanTag),
  );

  return rows.map((row) => ({
    clanTag: normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag,
    clanName: displayNames.get(normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) ?? null,
    upgrades:
      row.upgrades !== null && row.upgrades !== undefined && Number.isFinite(row.upgrades)
        ? Math.trunc(row.upgrades)
        : null,
    joinType: normalizeRaidJoinType(row.joinType),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function upsertRaidTrackedClansForTags(input: {
  rawTags: string;
  upgrades?: number | null;
  cocService: CoCService;
}): Promise<RaidTrackedClanWriteResult> {
  const parsed = parseRaidTrackedClanTagsInput(input.rawTags);
  if (parsed.validTags.length === 0) {
    return {
      added: [],
      updated: [],
      alreadyExisting: [],
      invalid: parsed.invalidTags,
      duplicateInRequest: parsed.duplicateTagsInRequest,
      joinTypeRefreshFailures: [],
    };
  }

  const upgrades =
    input.upgrades !== null && input.upgrades !== undefined
      ? Math.trunc(input.upgrades)
      : null;

  const existingRows = await prisma.raidTrackedClan.findMany({
    where: { clanTag: { in: parsed.validTags } },
    select: { clanTag: true },
  });
  const existingSet = new Set(existingRows.map((row) => normalizeRaidTrackedClanTag(row.clanTag)).filter(Boolean));
  const newTags = parsed.validTags.filter((tag) => !existingSet.has(tag));
  const existingTags = parsed.validTags.filter((tag) => existingSet.has(tag));

  if (newTags.length > 0) {
    await prisma.raidTrackedClan.createMany({
      data: newTags.map((tag) => ({
        clanTag: tag,
        upgrades,
        joinType: null,
      })),
      skipDuplicates: true,
    });
  }

  if (upgrades !== null && existingTags.length > 0) {
    await prisma.raidTrackedClan.updateMany({
      where: { clanTag: { in: existingTags } },
      data: { upgrades },
    });
  }

  const joinTypeRefreshFailures: string[] = [];
  for (const tag of parsed.validTags) {
    try {
      const clan = await input.cocService.getClan(toDisplayTag(tag));
      const joinType = normalizeRaidJoinType(clan?.type);
      await prisma.raidTrackedClan.updateMany({
        where: { clanTag: tag },
        data: { joinType },
      });
    } catch {
      joinTypeRefreshFailures.push(toDisplayTag(tag));
    }
  }

  const added = newTags.map(toDisplayTag);
  const updated = upgrades !== null ? existingTags.map(toDisplayTag) : [];
  const alreadyExisting =
    upgrades !== null ? [] : existingTags.map(toDisplayTag);

  return {
    added,
    updated,
    alreadyExisting,
    invalid: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest.map(toDisplayTag),
    joinTypeRefreshFailures,
  };
}
