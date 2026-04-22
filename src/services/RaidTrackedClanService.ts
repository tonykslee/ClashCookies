import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";
import { formatError } from "../helper/formatError";
import { RecruitingType } from "../generated/coc-api";
import { toFailureTelemetry } from "./telemetry/ingest";

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

export type RaidTrackedClanRefreshResult = {
  refreshed: string[];
  joinTypeRefreshFailures: string[];
};

function stripLeadingHash(tag: string): string {
  return tag.startsWith("#") ? tag.slice(1) : tag;
}

function toDisplayTag(tag: string): string {
  return `#${stripLeadingHash(tag)}`;
}

function normalizeRaidTrackedClanName(name: string | null | undefined): string | null {
  const trimmed = String(name ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
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

function normalizeRaidJoinType(
  joinType: RecruitingType | string | null | undefined,
): RaidTrackedClanJoinType | null {
  const raw = String(joinType ?? "").trim();
  if (raw === "open" || raw === "anyoneCanJoin") {
    return "open";
  }
  if (raw === "inviteOnly" || raw === "closed") {
    return raw;
  }
  return null;
}

export function getRaidTrackedClanJoinTypeEmoji(
  joinType: RaidTrackedClanJoinType | "anyoneCanJoin" | null | undefined,
): string {
  const normalized = normalizeRaidJoinType(joinType);
  if (normalized === "open") {
    return "🔓";
  }
  if (normalized === "inviteOnly" || normalized === "closed") {
    return "🔒";
  }
  return "⚪";
}

async function readRaidTrackedClanLiveData(input: {
  clanTag: string;
  cocService: CoCService;
  source: string;
}): Promise<{ clanName: string | null; joinType: RaidTrackedClanJoinType | null } | null> {
  try {
    const clan = await input.cocService.getClan(toDisplayTag(input.clanTag));
    return {
      clanName: normalizeRaidTrackedClanName(clan?.name),
      joinType: normalizeRaidJoinType(clan?.type),
    };
  } catch (err) {
    const failure = toFailureTelemetry(err);
    if (failure.errorCode === "COC_QUEUE_CONTEXT_MISSING") {
      console.error(
        `[tracked-clan] stage=raid_live_fetch_failed source=${input.source} operation=getClan tag=${toDisplayTag(input.clanTag)} error=${formatError(err)}`,
      );
    }
    return null;
  }
}

function formatRaidTrackedClanListLine(input: RaidTrackedClanDisplayRow): string {
  const clanTagDisplay = stripLeadingHash(input.clanTag);
  const clanName = normalizeRaidTrackedClanName(input.clanName) ?? clanTagDisplay;
  const upgradesText = input.upgrades === null ? "—" : String(input.upgrades);
  const emoji = getRaidTrackedClanJoinTypeEmoji(input.joinType);
  const url = `https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodeURIComponent(clanTagDisplay)}`;
  return `### ${emoji} [${clanName} | ${upgradesText}](<${url}>) \`${clanTagDisplay}\``;
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
      name: true,
      upgrades: true,
      joinType: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (rows.length === 0) return [];

  return rows.map((row) => ({
    clanTag: normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag,
    clanName: normalizeRaidTrackedClanName(row.name),
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
    select: {
      clanTag: true,
      name: true,
      upgrades: true,
      joinType: true,
    },
  });
  const existingMap = new Map(
    existingRows
      .map((row) => [normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag, row] as const)
      .filter((entry): entry is readonly [string, (typeof existingRows)[number]] => Boolean(entry[0])),
  );
  const existingSet = new Set(existingMap.keys());
  const newTags = parsed.validTags.filter((tag) => !existingSet.has(tag));
  const existingTags = parsed.validTags.filter((tag) => existingSet.has(tag));

  const createRows: {
    clanTag: string;
    name: string | null;
    upgrades: number | null;
    joinType: RaidTrackedClanJoinType | null;
  }[] = [];
  const joinTypeRefreshFailures: string[] = [];

  for (const tag of parsed.validTags) {
    const existing = existingMap.get(tag) ?? null;
    const liveData = await readRaidTrackedClanLiveData({
      clanTag: tag,
      cocService: input.cocService,
      source: "tracked-clan:raid-tags",
    });

    if (!liveData) {
      joinTypeRefreshFailures.push(toDisplayTag(tag));
    }

    if (!existing) {
      createRows.push({
        clanTag: tag,
        name: liveData?.clanName ?? null,
        upgrades,
        joinType: liveData?.joinType ?? null,
      });
      continue;
    }

    const updateData: {
      upgrades?: number | null;
      name?: string | null;
      joinType?: RaidTrackedClanJoinType | null;
    } = {};
    if (upgrades !== null && existing.upgrades !== upgrades) {
      updateData.upgrades = upgrades;
    }

    if (liveData) {
      const storedName = normalizeRaidTrackedClanName(existing.name);
      if (liveData.clanName && liveData.clanName !== storedName) {
        updateData.name = liveData.clanName;
      }
      if (liveData.joinType !== existing.joinType) {
        updateData.joinType = liveData.joinType;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.raidTrackedClan.updateMany({
        where: { clanTag: tag },
        data: updateData,
      });
    }
  }

  if (createRows.length > 0) {
    await prisma.raidTrackedClan.createMany({
      data: createRows,
      skipDuplicates: true,
    });
  }

  const added = newTags.map(toDisplayTag);
  const updated = upgrades !== null ? existingTags.map(toDisplayTag) : [];
  const alreadyExisting = upgrades !== null ? [] : existingTags.map(toDisplayTag);

  return {
    added,
    updated,
    alreadyExisting,
    invalid: parsed.invalidTags,
    duplicateInRequest: parsed.duplicateTagsInRequest.map(toDisplayTag),
    joinTypeRefreshFailures,
  };
}

export async function refreshRaidTrackedClansMetadata(input: {
  cocService: CoCService;
}): Promise<RaidTrackedClanRefreshResult> {
  const rows = await prisma.raidTrackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
    select: {
      clanTag: true,
      name: true,
      joinType: true,
    },
  });

  const refreshed: string[] = [];
  const joinTypeRefreshFailures: string[] = [];

  for (const row of rows) {
    const normalizedTag = normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag;
    const liveData = await readRaidTrackedClanLiveData({
      clanTag: normalizedTag,
      cocService: input.cocService,
      source: "tracked-clan:list:raids:refresh",
    });
    if (!liveData) {
      joinTypeRefreshFailures.push(toDisplayTag(row.clanTag));
      continue;
    }

    const updateData: {
      name?: string | null;
      joinType?: RaidTrackedClanJoinType | null;
    } = {};
    const storedName = normalizeRaidTrackedClanName(row.name);
    if (liveData.clanName && liveData.clanName !== storedName) {
      updateData.name = liveData.clanName;
    }
    if (liveData.joinType !== row.joinType) {
      updateData.joinType = liveData.joinType;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.raidTrackedClan.updateMany({
        where: { clanTag: normalizedTag },
        data: updateData,
      });
      refreshed.push(toDisplayTag(row.clanTag));
    }
  }

  return {
    refreshed,
    joinTypeRefreshFailures,
  };
}
