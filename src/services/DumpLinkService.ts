import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeTag } from "./war-events/core";

export type DumpClanInfoCache = {
  clanTag: string | null;
  name: string | null;
  joinType: "open" | "inviteOnly" | "closed" | null;
  minTownHall: number | null;
  minLeagueLabel: string | null;
  minTrophies: number | null;
};

export type DumpLinkRecord = {
  guildId: string;
  link: string;
  updatedByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
  clanInfoJson: unknown | null;
  clanInfoFetchedAt: Date | null;
};

const DUMP_CACHE_KEYS: Array<keyof DumpClanInfoCache> = [
  "clanTag",
  "name",
  "joinType",
  "minTownHall",
  "minLeagueLabel",
  "minTrophies",
];

const TROPHY_LEAGUE_LABELS: Array<{ trophies: number; label: string }> = [
  { trophies: 5_000, label: "Legend League" },
  { trophies: 2_900, label: "Titan League I" },
  { trophies: 2_800, label: "Titan League II" },
  { trophies: 2_700, label: "Titan League III" },
  { trophies: 2_600, label: "Champion League I" },
  { trophies: 2_500, label: "Champion League II" },
  { trophies: 2_400, label: "Champion League III" },
  { trophies: 2_300, label: "Master League I" },
  { trophies: 2_200, label: "Master League II" },
  { trophies: 2_100, label: "Master League III" },
  { trophies: 2_000, label: "Crystal League I" },
  { trophies: 1_900, label: "Crystal League II" },
  { trophies: 1_800, label: "Crystal League III" },
  { trophies: 1_700, label: "Gold League I" },
  { trophies: 1_600, label: "Gold League II" },
  { trophies: 1_500, label: "Gold League III" },
  { trophies: 1_400, label: "Silver League I" },
  { trophies: 1_300, label: "Silver League II" },
  { trophies: 1_200, label: "Silver League III" },
  { trophies: 1_100, label: "Bronze League I" },
  { trophies: 1_000, label: "Bronze League II" },
  { trophies: 0, label: "Bronze League III" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeDumpJoinType(
  joinType: unknown,
): DumpClanInfoCache["joinType"] {
  const raw = String(joinType ?? "").trim();
  if (raw === "open" || raw === "anyoneCanJoin") {
    return "open";
  }
  if (raw === "inviteOnly" || raw === "closed") {
    return raw;
  }
  return null;
}

function formatDumpJoinType(joinType: DumpClanInfoCache["joinType"]): string {
  if (joinType === "open") return "Anyone can join";
  if (joinType === "inviteOnly") return "Invite only";
  if (joinType === "closed") return "Closed";
  return "Unknown";
}

function formatDumpTownHall(minTownHall: number | null): string {
  return minTownHall !== null && Number.isFinite(minTownHall)
    ? `TH${Math.trunc(minTownHall)}`
    : "Unknown";
}

function formatDumpLeagueLabel(cache: DumpClanInfoCache): string {
  if (cache.minLeagueLabel) return cache.minLeagueLabel;
  if (cache.minTrophies !== null && Number.isFinite(cache.minTrophies)) {
    return `${Math.trunc(cache.minTrophies).toLocaleString("en-US")} trophies`;
  }
  return "Unknown";
}

function formatDumpClanInfoLines(cache: DumpClanInfoCache): string[] {
  return [
    `Name: ${cache.name ?? "Unknown"}`,
    `Join: ${formatDumpJoinType(cache.joinType)}`,
    `Min TH: ${formatDumpTownHall(cache.minTownHall)}`,
    `Min Leagues: ${formatDumpLeagueLabel(cache)}`,
  ];
}

function normalizeDumpClanTag(input: string | null | undefined): string | null {
  const normalized = normalizeTag(String(input ?? ""));
  return normalized ? normalized : null;
}

function leagueLabelFromRequiredTrophies(requiredTrophies: number | null): string | null {
  if (requiredTrophies === null || !Number.isFinite(requiredTrophies)) {
    return null;
  }
  const normalized = Math.trunc(requiredTrophies);
  const match = TROPHY_LEAGUE_LABELS.find((entry) => normalized >= entry.trophies);
  return match?.label ?? null;
}

function extractValue(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return raw[key];
    }
  }
  return undefined;
}

function toDumpClanInfoJsonValue(
  value: DumpClanInfoCache | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ?? Prisma.DbNull;
}

export function parseDumpClanInfoCache(value: unknown): DumpClanInfoCache | null {
  if (!isRecord(value)) return null;
  if (!DUMP_CACHE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return null;
  }

  const clanTag = normalizeDumpClanTag(value.clanTag as string | null | undefined);
  const name = parseNullableString(value.name);
  const joinType = normalizeDumpJoinType(value.joinType);
  const minTownHall = parseNullableNumber(value.minTownHall);
  const minLeagueLabel = parseNullableString(value.minLeagueLabel);
  const minTrophies = parseNullableNumber(value.minTrophies);

  if (!clanTag || !name) return null;
  if (value.joinType !== null && joinType === null) return null;
  if (value.minTownHall !== null && minTownHall === null) return null;
  if (value.minLeagueLabel !== null && minLeagueLabel === null) return null;
  if (value.minTrophies !== null && minTrophies === null) return null;

  return {
    clanTag,
    name,
    joinType,
    minTownHall,
    minLeagueLabel,
    minTrophies,
  };
}

export function buildDumpClanInfoCacheFromClan(input: {
  clan: unknown;
  clanTag: string;
}): DumpClanInfoCache | null {
  if (!isRecord(input.clan)) return null;
  const liveClanTag = extractValue(input.clan, ["tag"]);
  const liveName = extractValue(input.clan, ["name"]);
  const liveRequiredLeague = extractValue(input.clan, [
    "requiredLeagueLabel",
    "requiredLeagueName",
    "requiredLeague",
  ]);
  const liveRequiredLeagueObject = extractValue(input.clan, ["requiredLeague"]);
  const clanTag =
    normalizeDumpClanTag(typeof liveClanTag === "string" ? liveClanTag : null) ??
    normalizeDumpClanTag(input.clanTag);
  const name = parseNullableString(liveName) ?? "Unknown";
  const joinType = normalizeDumpJoinType(extractValue(input.clan, ["type"]));
  const minTownHall = parseNullableNumber(
    extractValue(input.clan, ["requiredTownHallLevel", "requiredTownhallLevel"]),
  );
  const directLeagueLabel =
    parseNullableString(liveRequiredLeague) ??
    (isRecord(liveRequiredLeagueObject)
      ? parseNullableString(liveRequiredLeagueObject.name)
      : null);
  const requiredTrophies = parseNullableNumber(extractValue(input.clan, ["requiredTrophies"]));
  const minLeagueLabel = directLeagueLabel ?? leagueLabelFromRequiredTrophies(requiredTrophies);

  if (!clanTag) return null;

  return {
    clanTag,
    name,
    joinType,
    minTownHall,
    minLeagueLabel,
    minTrophies: requiredTrophies,
  };
}

export function buildDumpClanInfoContent(
  cache: DumpClanInfoCache,
  link: string,
): string {
  return [...formatDumpClanInfoLines(cache), `<${link}>`].join("\n");
}

export function buildDumpClanInfoFallbackContent(link: string): string {
  return ["Clan info unavailable", `<${link}>`].join("\n");
}

export function extractDumpClanTagFromLink(link: string): string | null {
  const trimmed = String(link ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const tag = url.searchParams.get("tag");
    return normalizeDumpClanTag(tag);
  } catch {
    return null;
  }
}

export function normalizeDumpLink(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  if (!unwrapped) return null;

  try {
    const parsed = new URL(unwrapped);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return unwrapped;
  } catch {
    return null;
  }
}

export async function getDumpLinkForGuild(
  guildId: string,
): Promise<DumpLinkRecord | null> {
  const normalizedGuildId = String(guildId ?? "").trim();
  if (!normalizedGuildId) return null;

  return prisma.dumpLink.findUnique({
    where: { guildId: normalizedGuildId },
    select: {
      guildId: true,
      link: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
      clanInfoJson: true,
      clanInfoFetchedAt: true,
    },
  });
}

export async function upsertDumpLinkForGuild(input: {
  guildId: string;
  link: string;
  updatedByDiscordUserId: string;
}): Promise<DumpLinkRecord> {
  const guildId = String(input.guildId ?? "").trim();
  const link = String(input.link ?? "").trim();
  const updatedByDiscordUserId = String(input.updatedByDiscordUserId ?? "").trim();

  return prisma.dumpLink.upsert({
    where: { guildId },
    create: {
      guildId,
      link,
      updatedByDiscordUserId,
      clanInfoJson: Prisma.DbNull,
      clanInfoFetchedAt: null,
    },
    update: {
      link,
      updatedByDiscordUserId,
      clanInfoJson: Prisma.DbNull,
      clanInfoFetchedAt: null,
    },
    select: {
      guildId: true,
      link: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
      clanInfoJson: true,
      clanInfoFetchedAt: true,
    },
  });
}

export async function updateDumpLinkClanInfoForGuild(input: {
  guildId: string;
  clanInfoJson: DumpClanInfoCache | null;
  clanInfoFetchedAt: Date | null;
}): Promise<DumpLinkRecord | null> {
  const guildId = String(input.guildId ?? "").trim();
  if (!guildId) return null;

  return prisma.dumpLink.update({
    where: { guildId },
    data: {
      clanInfoJson: toDumpClanInfoJsonValue(input.clanInfoJson),
      clanInfoFetchedAt: input.clanInfoFetchedAt,
    },
    select: {
      guildId: true,
      link: true,
      updatedByDiscordUserId: true,
      createdAt: true,
      updatedAt: true,
      clanInfoJson: true,
      clanInfoFetchedAt: true,
    },
  });
}
