import { prisma } from "../prisma";
import { formatClanBadgeEmoji } from "../helper/clanBadgeEmoji";
import { normalizePlayerTag, normalizeClanTag, normalizeDiscordUserId } from "./PlayerLinkService";
import { normalizeSyncTimeZone } from "./syncTimeZone";

export type ParsedTrackedClanRepTagInput = {
  validTags: string[];
  invalidTags: string[];
  duplicateTagsInRequest: string[];
};

export type TrackedClanRepWriteClient = {
  trackedClanRep: {
    deleteMany: (args: { where: { clanTag: string; playerTag?: string } }) => Promise<{ count: number }>;
    create: (args: {
      data: {
        clanTag: string;
        playerTag: string;
      };
    }) => Promise<unknown>;
    createMany: (args: {
      data: Array<{ clanTag: string; playerTag: string }>;
    }) => Promise<{ count: number }>;
  };
};

type TrackedClanRepUserProfileWriteClient = {
  trackedClanRepUserProfile: {
    upsert: (args: {
      where: { discordUserId: string };
      create: {
        discordUserId: string;
        timeZone: string | null;
        updatedByDiscordUserId: string | null;
      };
      update: {
        timeZone: string | null;
        updatedByDiscordUserId: string | null;
      };
      select?: {
        discordUserId: true;
        timeZone: true;
        updatedByDiscordUserId: true;
        createdAt: true;
        updatedAt: true;
      };
    }) => Promise<{
      discordUserId: string;
      timeZone: string | null;
      updatedByDiscordUserId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
  };
};

export type TrackedClanRepAddOutcome = "created" | "already_exists" | "clan_not_found";
export type TrackedClanRepRemoveOutcome = "removed" | "not_found" | "clan_not_found";

export type TrackedClanRepAddResult = {
  outcome: TrackedClanRepAddOutcome;
  clanTag: string;
  clanName: string | null;
  playerTag: string;
};

export type TrackedClanRepRemoveResult = {
  outcome: TrackedClanRepRemoveOutcome;
  clanTag: string;
  clanName: string | null;
  playerTag: string;
};

type TrackedClanRepReadClient = {
  trackedClanRep?: {
    findMany: (args: {
      where: { clanTag: { in: string[] } };
      orderBy?: Array<{ clanTag?: "asc" | "desc"; playerTag?: "asc" | "desc" }>;
      select: { clanTag: true; playerTag: true };
    }) => Promise<Array<{ clanTag: string; playerTag: string }>>;
    findFirst?: (args: {
      where: { playerTag: string };
      select?: { playerTag: true };
    }) => Promise<{ playerTag: string } | null>;
  };
};

type TrackedClanRepLinkedUserReadClient = {
  trackedClanRep?: {
    findMany: (args: {
      where?: { clanTag?: { in: string[] } } | undefined;
      orderBy?: Array<{ clanTag?: "asc" | "desc"; playerTag?: "asc" | "desc" }>;
      select: { playerTag: true };
    }) => Promise<Array<{ playerTag: string }>>;
  };
  playerLink?: {
    findMany: (args: {
      where: { playerTag: { in: string[] } };
      select: {
        playerTag: true;
        discordUserId: true;
        playerName: true;
        discordUsername: true;
      };
    }) => Promise<
      Array<{
        playerTag: string;
        discordUserId: string | null;
        playerName: string | null;
        discordUsername: string | null;
      }>
    >;
  };
};

type TrackedClanRepPlayerTagReadClient = {
  trackedClanRep?: {
    findMany: (args: {
      where?: { clanTag?: { in: string[] } } | undefined;
      orderBy?: Array<{ clanTag?: "asc" | "desc"; playerTag?: "asc" | "desc" }>;
      select: { playerTag: true };
    }) => Promise<Array<{ playerTag: string }>>;
  };
};

type TrackedClanRepTimeProfileRow = {
  playerTag: string;
  timeZone: string | null;
  updatedByDiscordUserId: string | null;
  updatedAt: Date;
};

type TrackedClanRepUserProfileRow = {
  discordUserId: string;
  timeZone: string | null;
  updatedByDiscordUserId: string | null;
  updatedAt: Date;
};

type TrackedClanRepTimeClanRow = {
  clanTag: string;
  clanName: string | null;
  clanBadge: string | null;
  trackedClanSortOrder: number;
  repRows: TrackedClanRepTimeProfileRow[];
};

type TrackedClanRepTimeReadClient = {
  trackedClan?: {
    findMany: (args: {
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }];
      where?: { tag: { in: string[] } };
      select: { tag: true; name: true; clanBadge: true; createdAt: true };
    }) => Promise<Array<{ tag: string; name: string | null; clanBadge: string | null; createdAt: Date }>>;
  };
  trackedClanRep?: TrackedClanRepReadClient["trackedClanRep"];
  playerLink?: TrackedClanRepLinkedUserReadClient["playerLink"];
  trackedClanRepUserProfile?: {
    findMany: (args: {
      where: { discordUserId: { in: string[] } };
      select: {
        discordUserId: true;
        timeZone: true;
        updatedByDiscordUserId: true;
        updatedAt: true;
      };
    }) => Promise<
      Array<{
        discordUserId: string;
        timeZone: string | null;
        updatedByDiscordUserId: string | null;
        updatedAt: Date;
      }>
    >;
  };
};

type TrackedClanRepDisplayTrackedClanRow = {
  tag: string;
  name: string | null;
  createdAt: Date;
};

type TrackedClanRepDisplayTrackedClanClient = {
  trackedClan?: {
    findMany: (args: {
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }];
      where?: { tag: { in: string[] } };
      select: { tag: true; name: true; createdAt: true };
    }) => Promise<TrackedClanRepDisplayTrackedClanRow[]>;
  };
};

type TrackedClanRepClanLookupClient = {
  trackedClan?: {
    findUnique: (args: {
      where: { tag: string };
      select: { tag: true; name: true };
    }) => Promise<{ tag: string; name: string | null } | null>;
  };
} & Partial<TrackedClanRepReadClient>;

export type TrackedClanRepResolvedClan = {
  tag: string;
  name: string | null;
};

export type TrackedClanRepDisplayClanRow = {
  clanTag: string;
  clanName: string | null;
  trackedClanSortOrder: number;
  repPlayerTags: string[];
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

function normalizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function isKnownPrismaErrorCode(error: unknown, code: string): boolean {
  return String((error as { code?: unknown } | null | undefined)?.code ?? "") === code;
}

async function resolveTrackedClanForRepMutation(
  clanTag: string,
  db: TrackedClanRepClanLookupClient = prisma,
): Promise<{ tag: string; name: string | null } | null> {
  if (!db.trackedClan?.findUnique) return null;
  const clan = await db.trackedClan.findUnique({
    where: { tag: clanTag },
    select: { tag: true, name: true },
  });
  if (!clan) return null;
  const normalizedTag = normalizeClanTag(clan.tag);
  if (!normalizedTag) return null;
  return {
    tag: normalizedTag,
    name: normalizeDisplayText(clan.name),
  };
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

/** Purpose: create one rep player assignment for a tracked clan without replacing other rows. */
export async function addTrackedClanRepForClan(
  db: TrackedClanRepWriteClient & TrackedClanRepClanLookupClient,
  input: {
    clanTag: string;
    playerTag: string;
    trackedClan?: TrackedClanRepResolvedClan | null;
  },
): Promise<TrackedClanRepAddResult> {
  const clanTag = normalizeClanTag(input.clanTag);
  const playerTag = normalizePlayerTag(input.playerTag);
  if (!clanTag || !playerTag) {
    return {
      outcome: "clan_not_found",
      clanTag: clanTag || "",
      clanName: null,
      playerTag: playerTag || "",
    };
  }

  const clan =
    input.trackedClan ??
    (await resolveTrackedClanForRepMutation(clanTag, db));
  if (!clan) {
    return {
      outcome: "clan_not_found",
      clanTag,
      clanName: null,
      playerTag,
    };
  }

  try {
    await db.trackedClanRep.create({
      data: {
        clanTag: clan.tag,
        playerTag,
      },
    });
    return {
      outcome: "created",
      clanTag: clan.tag,
      clanName: clan.name,
      playerTag,
    };
  } catch (error) {
    if (isKnownPrismaErrorCode(error, "P2002")) {
      return {
        outcome: "already_exists",
        clanTag: clan.tag,
        clanName: clan.name,
        playerTag,
      };
    }
    if (isKnownPrismaErrorCode(error, "P2003")) {
      return {
        outcome: "clan_not_found",
        clanTag,
        clanName: null,
        playerTag,
      };
    }
    throw error;
  }
}

/** Purpose: delete one rep player assignment for a tracked clan without touching other rows. */
export async function removeTrackedClanRepForClan(
  db: TrackedClanRepWriteClient & TrackedClanRepClanLookupClient,
  input: {
    clanTag: string;
    playerTag: string;
    trackedClan?: TrackedClanRepResolvedClan | null;
  },
): Promise<TrackedClanRepRemoveResult> {
  const clanTag = normalizeClanTag(input.clanTag);
  const playerTag = normalizePlayerTag(input.playerTag);
  if (!clanTag || !playerTag) {
    return {
      outcome: "clan_not_found",
      clanTag: clanTag || "",
      clanName: null,
      playerTag: playerTag || "",
    };
  }

  const clan =
    input.trackedClan ??
    (await resolveTrackedClanForRepMutation(clanTag, db));
  if (!clan) {
    return {
      outcome: "clan_not_found",
      clanTag,
      clanName: null,
      playerTag,
    };
  }

  const removed = await db.trackedClanRep.deleteMany({
    where: {
      clanTag: clan.tag,
      playerTag,
    },
  });

  return {
    outcome: removed.count > 0 ? "removed" : "not_found",
    clanTag: clan.tag,
    clanName: clan.name,
    playerTag,
  };
}

/** Purpose: bulk-load configured rep player tags in deterministic player-tag order. */
export async function listTrackedClanRepPlayerTags(
  clanTags: string[] | null | undefined = null,
  db: TrackedClanRepPlayerTagReadClient = prisma,
): Promise<string[]> {
  if (!db.trackedClanRep?.findMany) {
    return [];
  }

  const normalizedClanTags = clanTags
    ? [...new Set(clanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean))]
    : [];

  const rows = await db.trackedClanRep.findMany({
    ...(normalizedClanTags.length > 0 ? { where: { clanTag: { in: normalizedClanTags } } } : {}),
    orderBy: normalizedClanTags.length > 0
      ? [{ clanTag: "asc" }, { playerTag: "asc" }]
      : [{ playerTag: "asc" }],
    select: {
      playerTag: true,
    },
  });

  const playerTags: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag || seen.has(playerTag)) continue;
    seen.add(playerTag);
    playerTags.push(playerTag);
  }

  return playerTags;
}

/** Purpose: check whether one player tag is currently assigned as a tracked clan rep anywhere. */
export async function hasTrackedClanRepAssignmentForPlayerTag(
  playerTag: string,
  db: Pick<TrackedClanRepReadClient, "trackedClanRep"> = prisma,
): Promise<boolean> {
  const normalizedPlayerTag = normalizePlayerTag(playerTag);
  if (!normalizedPlayerTag || !db.trackedClanRep?.findFirst) {
    return false;
  }

  const row = await db.trackedClanRep.findFirst({
    where: { playerTag: normalizedPlayerTag },
    select: { playerTag: true },
  });
  return Boolean(row);
}

/** Purpose: check whether one Discord user is linked to at least one currently configured rep account. */
export async function hasTrackedClanRepAssignmentForDiscordUserId(
  discordUserId: string,
  db: TrackedClanRepLinkedUserReadClient = prisma,
): Promise<boolean> {
  const normalizedDiscordUserId = normalizeDiscordUserId(discordUserId);
  if (!normalizedDiscordUserId || !db.trackedClanRep?.findMany || !db.playerLink?.findMany) {
    return false;
  }

  const repTags = await db.trackedClanRep.findMany({
    select: { playerTag: true },
  });
  const normalizedPlayerTags = [
    ...new Set(repTags.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean)),
  ];
  if (normalizedPlayerTags.length === 0) {
    return false;
  }

  const linkedRows = await db.playerLink.findMany({
    where: { playerTag: { in: normalizedPlayerTags } },
    select: {
      playerTag: true,
      discordUserId: true,
      playerName: true,
      discordUsername: true,
    },
  });

  return linkedRows.some((row) => normalizeDiscordUserId(row.discordUserId) === normalizedDiscordUserId);
}

async function loadTrackedClanRepTimezoneUserChoices(
  db: TrackedClanRepLinkedUserReadClient = prisma,
): Promise<
  Array<{
    discordUserId: string;
    discordUsername: string | null;
    playerNames: string[];
    repCount: number;
  }>
> {
  if (!db.trackedClanRep?.findMany || !db.playerLink?.findMany) {
    return [];
  }

  const repRows = await db.trackedClanRep.findMany({
    select: { playerTag: true },
  });
  const repTags = [
    ...new Set(repRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean)),
  ];
  if (repTags.length === 0) {
    return [];
  }

  const linkedRows = await db.playerLink.findMany({
    where: { playerTag: { in: repTags } },
    select: {
      playerTag: true,
      discordUserId: true,
      playerName: true,
      discordUsername: true,
    },
  });

  const grouped = new Map<
    string,
    { discordUsername: string | null; playerNamesByTag: Map<string, string>; playerTags: Set<string> }
  >();
  for (const row of linkedRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const discordUserId = normalizeDiscordUserId(row.discordUserId);
    if (!discordUserId || !playerTag) continue;
    const entry = grouped.get(discordUserId) ?? {
      discordUsername: normalizeDisplayText(row.discordUsername),
      playerNamesByTag: new Map<string, string>(),
      playerTags: new Set<string>(),
    };
    entry.discordUsername = entry.discordUsername ?? normalizeDisplayText(row.discordUsername);
    const playerName = normalizeDisplayText(row.playerName);
    if (playerName) {
      entry.playerNamesByTag.set(playerTag, playerName);
    }
    entry.playerTags.add(playerTag);
    grouped.set(discordUserId, entry);
  }

  return [...grouped.entries()]
    .map(([discordUserId, entry]) => ({
      discordUserId,
      discordUsername: entry.discordUsername,
      playerNames: [...entry.playerNamesByTag.values()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      ),
      repCount: entry.playerTags.size,
    }))
    .sort((a, b) => {
      const leftLabel = (a.discordUsername ?? a.playerNames[0] ?? a.discordUserId).toLowerCase();
      const rightLabel = (b.discordUsername ?? b.playerNames[0] ?? b.discordUserId).toLowerCase();
      const byLabel = leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
      if (byLabel !== 0) return byLabel;
      return a.discordUserId.localeCompare(b.discordUserId, undefined, { sensitivity: "base" });
    });
}

function buildTrackedClanRepTimezoneUserChoiceLabel(input: {
  discordUserId: string;
  discordUsername: string | null;
  playerNames: string[];
  repCount: number;
}): string {
  const userLabel = normalizeDisplayText(input.discordUsername) ?? input.playerNames[0] ?? input.discordUserId;
  const normalizedUserLabel = userLabel.startsWith("@") ? userLabel.slice(1) : userLabel;
  const repLabel = `${input.repCount} rep${input.repCount === 1 ? "" : "s"}`;
  const playerLabel =
    input.playerNames.length > 0 ? input.playerNames.slice(0, 3).join(", ") : "no named reps";
  return `@${normalizedUserLabel} | ${repLabel} | ${playerLabel}`.slice(0, 100);
}

function scoreTrackedClanRepTimezoneUserChoice(input: {
  discordUserId: string;
  discordUsername: string | null;
  playerNames: string[];
  query: string;
}): number {
  const queryText = normalizeDisplayText(input.query)?.toLowerCase() ?? "";
  if (queryText.length === 0) return 3;

  const strippedQuery = queryText.startsWith("@") ? queryText.slice(1) : queryText;
  const mentionMatch = strippedQuery.match(/^<@!?(\d{15,22})>$/);
  const queryUserId = normalizeDiscordUserId(mentionMatch?.[1] ?? strippedQuery);
  if (queryUserId && queryUserId === input.discordUserId) return 0;

  const username = normalizeDisplayText(input.discordUsername)?.toLowerCase() ?? "";
  if (username.includes(strippedQuery) || input.discordUserId.includes(strippedQuery)) return 2;
  if (input.playerNames.some((playerName) => playerName.toLowerCase().includes(strippedQuery))) return 2;
  if (`@${username}`.includes(queryText)) return 2;
  return 99;
}

/** Purpose: autocomplete rep-user timezone targets from currently linked rep accounts. */
export async function autocompleteTrackedClanRepTimezoneUserChoices(
  query: string,
  db: TrackedClanRepLinkedUserReadClient = prisma,
): Promise<{ name: string; value: string }[]> {
  const choices = await loadTrackedClanRepTimezoneUserChoices(db);
  if (choices.length === 0) {
    return [];
  }

  return choices
    .map((choice) => ({
      ...choice,
      matchRank: scoreTrackedClanRepTimezoneUserChoice({
        discordUserId: choice.discordUserId,
        discordUsername: choice.discordUsername,
        playerNames: choice.playerNames,
        query,
      }),
      label: buildTrackedClanRepTimezoneUserChoiceLabel(choice),
    }))
    .filter((choice) => choice.matchRank !== 99)
    .sort((a, b) => {
      if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
      const byLabel = a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
      if (byLabel !== 0) return byLabel;
      return a.discordUserId.localeCompare(b.discordUserId, undefined, { sensitivity: "base" });
    })
    .slice(0, 25)
    .map((choice) => ({ name: choice.label, value: choice.discordUserId }));
}

/** Purpose: store one rep profile timezone row without touching any clan assignments. */
export async function upsertTrackedClanRepUserTimezone(
  db: TrackedClanRepUserProfileWriteClient,
  input: {
    discordUserId: string;
    timeZone: string;
    updatedByDiscordUserId?: string | null;
  },
): Promise<TrackedClanRepUserProfileRow | null> {
  const discordUserId = normalizeDiscordUserId(input.discordUserId);
  const timeZone = normalizeSyncTimeZone(input.timeZone);
  if (!discordUserId || !timeZone) {
    return null;
  }

  const updatedByDiscordUserId = String(input.updatedByDiscordUserId ?? "").trim() || null;
  const row = await db.trackedClanRepUserProfile.upsert({
    where: { discordUserId },
    create: {
      discordUserId,
      timeZone,
      updatedByDiscordUserId,
    },
    update: {
      timeZone,
      updatedByDiscordUserId,
    },
  });

  return {
    discordUserId,
    timeZone: normalizeSyncTimeZone(row.timeZone) ?? timeZone,
    updatedByDiscordUserId: String(row.updatedByDiscordUserId ?? "").trim() || null,
    updatedAt: row.updatedAt,
  };
}

/** Purpose: backward-compatible wrapper for older player-tag timezone writes. */
export async function upsertTrackedClanRepProfileTimezone(
  db: TrackedClanRepUserProfileWriteClient,
  input: {
    playerTag: string;
    timeZone: string;
    updatedByDiscordUserId?: string | null;
  },
): Promise<TrackedClanRepUserProfileRow | null> {
  return upsertTrackedClanRepUserTimezone(db, {
    discordUserId: input.playerTag,
    timeZone: input.timeZone,
    updatedByDiscordUserId: input.updatedByDiscordUserId ?? null,
  });
}

/** Purpose: load tracked-clan rep time rows grouped by assigned clan in deterministic clan order. */
export async function listTrackedClanRepTimeRowsForClanTags(
  clanTags: string[] | null | undefined,
  db: TrackedClanRepTimeReadClient = prisma,
): Promise<TrackedClanRepTimeClanRow[]> {
  if (!db.trackedClan?.findMany || !db.trackedClanRep?.findMany) {
    return [];
  }

  const normalizedClanTags = clanTags
    ? [...new Set(clanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean))]
    : [];

  const trackedClanRows = await db.trackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    ...(normalizedClanTags.length > 0 ? { where: { tag: { in: normalizedClanTags } } } : {}),
    select: { tag: true, name: true, clanBadge: true, createdAt: true },
  });

  const canonicalClanRows = trackedClanRows
    .map((row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) return null;
      return {
        clanTag,
        clanName: normalizeDisplayText(row.name),
        clanBadge: normalizeTrackedClanBadge(row.clanBadge ?? null),
        createdAt: row.createdAt,
      };
    })
    .filter(
      (row): row is { clanTag: string; clanName: string | null; clanBadge: string | null; createdAt: Date } =>
        Boolean(row),
    );

  if (canonicalClanRows.length === 0) {
    return [];
  }

  const repRows = await db.trackedClanRep.findMany({
    where: {
      clanTag: { in: canonicalClanRows.map((row) => row.clanTag) },
    },
    orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
    select: {
      clanTag: true,
      playerTag: true,
    },
  });

  const normalizedPlayerTags = [
    ...new Set(repRows.map((row) => normalizePlayerTag(row.playerTag)).filter(Boolean)),
  ];
  const linkedUserIdByPlayerTag = new Map<string, string>();
  const linkedDiscordUserIds = new Set<string>();
  if (normalizedPlayerTags.length > 0 && db.playerLink?.findMany) {
    const linkRows = await db.playerLink.findMany({
      where: { playerTag: { in: normalizedPlayerTags } },
      select: {
        playerTag: true,
        discordUserId: true,
        playerName: true,
        discordUsername: true,
      },
    });

    for (const row of linkRows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      if (!playerTag || !discordUserId) continue;
      linkedUserIdByPlayerTag.set(playerTag, discordUserId);
      linkedDiscordUserIds.add(discordUserId);
    }
  }

  const profileByDiscordUserId = new Map<
    string,
    {
      timeZone: string | null;
      updatedByDiscordUserId: string | null;
      updatedAt: Date;
    }
  >();
  if (linkedDiscordUserIds.size > 0 && db.trackedClanRepUserProfile?.findMany) {
    const profileRows = await db.trackedClanRepUserProfile.findMany({
      where: {
        discordUserId: { in: [...linkedDiscordUserIds] },
      },
      select: {
        discordUserId: true,
        timeZone: true,
        updatedByDiscordUserId: true,
        updatedAt: true,
      },
    });

    for (const row of profileRows) {
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      if (!discordUserId) continue;
      profileByDiscordUserId.set(discordUserId, {
        timeZone: normalizeSyncTimeZone(row.timeZone) ?? null,
        updatedByDiscordUserId: String(row.updatedByDiscordUserId ?? "").trim() || null,
        updatedAt: row.updatedAt,
      });
    }
  }

  const repRowsByClan = new Map<string, TrackedClanRepTimeProfileRow[]>();
  const clanBadgeByTag = new Map(canonicalClanRows.map((row) => [row.clanTag, row.clanBadge] as const));
  for (const row of repRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    const discordUserId = linkedUserIdByPlayerTag.get(playerTag) ?? null;
    const profileData = discordUserId ? profileByDiscordUserId.get(discordUserId) : null;
    const profile: TrackedClanRepTimeProfileRow = profileData
      ? {
          playerTag,
          timeZone: profileData.timeZone,
          updatedByDiscordUserId: profileData.updatedByDiscordUserId,
          updatedAt: profileData.updatedAt,
        }
      : {
          playerTag,
          timeZone: null,
          updatedByDiscordUserId: null,
          updatedAt: new Date(0),
        };
    const bucket = repRowsByClan.get(clanTag) ?? [];
    bucket.push(profile);
    repRowsByClan.set(clanTag, bucket);
  }

  return canonicalClanRows
    .map((row, index) => ({
      clanTag: row.clanTag,
      clanName: row.clanName,
      clanBadge: clanBadgeByTag.get(row.clanTag) ?? null,
      trackedClanSortOrder: index,
      repRows: repRowsByClan.get(row.clanTag) ?? [],
    }))
    .filter((row) => row.repRows.length > 0);
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

/** Purpose: load tracked clan rep display rows for all requested clans in deterministic clan order. */
export async function listTrackedClanRepDisplayRowsForClanTags(
  clanTags: string[] | null | undefined,
  db: TrackedClanRepReadClient & TrackedClanRepDisplayTrackedClanClient = prisma,
): Promise<TrackedClanRepDisplayClanRow[]> {
  const normalizedClanTags = clanTags
    ? [...new Set(clanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean))]
    : [];

  if (!db.trackedClan?.findMany || !db.trackedClanRep?.findMany) {
    return [];
  }

  const trackedClanRows = await db.trackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    ...(normalizedClanTags.length > 0 ? { where: { tag: { in: normalizedClanTags } } } : {}),
    select: { tag: true, name: true, createdAt: true },
  });

  if (trackedClanRows.length === 0) {
    return [];
  }

  const canonicalClanRows = trackedClanRows
    .map((row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) return null;
      return {
        clanTag,
        clanName: normalizeDisplayText(row.name),
        createdAt: row.createdAt,
      };
    })
    .filter(
      (row): row is { clanTag: string; clanName: string | null; createdAt: Date } =>
        Boolean(row),
    );

  if (canonicalClanRows.length === 0) {
    return [];
  }

  const repRows = await db.trackedClanRep.findMany({
    where: {
      clanTag: { in: canonicalClanRows.map((row) => row.clanTag) },
    },
    orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
    select: {
      clanTag: true,
      playerTag: true,
    },
  });

  const repTagsByClan = new Map<string, string[]>();
  for (const row of repRows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    const bucket = repTagsByClan.get(clanTag) ?? [];
    if (!bucket.includes(playerTag)) {
      bucket.push(playerTag);
      repTagsByClan.set(clanTag, bucket);
    }
  }

  return canonicalClanRows.map((row, index) => ({
    clanTag: row.clanTag,
    clanName: row.clanName,
    trackedClanSortOrder: index,
    repPlayerTags: repTagsByClan.get(row.clanTag) ?? [],
  }));
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
