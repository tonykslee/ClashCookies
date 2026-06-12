import { type Client } from "discord.js";
import { prisma } from "../prisma";
import {
  emojiResolverService,
  isValidEmojiShortcodeName,
  normalizeEmojiShortcodeName,
} from "./emoji/EmojiResolverService";

const FULL_CUSTOM_EMOJI_TOKEN_PATTERN = /^<a?:[A-Za-z0-9_]{2,32}:\d{1,22}>$/;

type RepWorkBadgeResolutionRow = {
  discordUserId: string | null;
  playerTag: string;
};

type RepWorkBadgeClanRow = {
  playerTag: string;
  clanTag: string;
  clan: {
    tag: string;
    clanBadge: string | null;
    createdAt: Date;
  } | null;
};

function normalizeRenderedBadge(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isFullCustomEmojiToken(value: string): boolean {
  return FULL_CUSTOM_EMOJI_TOKEN_PATTERN.test(value);
}

async function resolveBadgeToken(
  client: Client | null | undefined,
  rawBadge: string,
  renderedBadgeByRawBadge: Map<string, string | null>,
): Promise<string | null> {
  const normalizedRaw = String(rawBadge ?? "").trim();
  if (!normalizedRaw) return null;
  if (renderedBadgeByRawBadge.has(normalizedRaw)) {
    return renderedBadgeByRawBadge.get(normalizedRaw) ?? null;
  }

  let rendered: string | null = null;
  if (isFullCustomEmojiToken(normalizedRaw)) {
    rendered = normalizedRaw;
  } else if (client) {
    const lookupName = normalizeEmojiShortcodeName(normalizedRaw);
    if (lookupName && isValidEmojiShortcodeName(lookupName)) {
      const resolved = await emojiResolverService
        .resolveByName(client, lookupName)
        .catch(() => null);
      rendered = normalizeRenderedBadge(resolved?.rendered ?? null);
    }
  }

  renderedBadgeByRawBadge.set(normalizedRaw, rendered);
  return rendered;
}

/** Purpose: resolve rendered clan badges for report users from tracked rep configuration and linked player tags. */
export async function resolveRepWorkRenderedClanBadgesByUserId(input: {
  client?: Client | null;
  userIds: string[];
}): Promise<Map<string, string[]>> {
  const normalizedUserIds = [
    ...new Set(
      input.userIds.map((userId) => String(userId ?? "").trim()).filter((userId) => /^\d{15,22}$/.test(userId)),
    ),
  ];
  const badgesByUserId = new Map<string, string[]>();
  if (normalizedUserIds.length === 0) {
    return badgesByUserId;
  }
  const normalizedUserIdSet = new Set(normalizedUserIds);

  const playerLinks = (await prisma.playerLink.findMany({
    where: {
      discordUserId: { in: normalizedUserIds },
    },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    select: {
      discordUserId: true,
      playerTag: true,
    },
  })) as RepWorkBadgeResolutionRow[];

  if (playerLinks.length === 0) {
    return badgesByUserId;
  }

  const userIdsByPlayerTag = new Map<string, string>();
  const uniquePlayerTags: string[] = [];
  for (const row of playerLinks) {
    const discordUserId = String(row.discordUserId ?? "").trim();
    const playerTag = String(row.playerTag ?? "").trim().toUpperCase();
    if (!discordUserId || !playerTag) continue;
    if (!userIdsByPlayerTag.has(playerTag)) {
      uniquePlayerTags.push(playerTag);
      userIdsByPlayerTag.set(playerTag, discordUserId);
    }
  }

  if (uniquePlayerTags.length === 0) {
    return badgesByUserId;
  }

  const repRows = (await prisma.trackedClanRep.findMany({
    where: {
      playerTag: { in: uniquePlayerTags },
    },
    select: {
      playerTag: true,
      clanTag: true,
      clan: {
        select: {
          tag: true,
          clanBadge: true,
          createdAt: true,
        },
      },
    },
  })) as RepWorkBadgeClanRow[];

  if (repRows.length === 0) {
    return badgesByUserId;
  }

  repRows.sort((a, b) => {
    const aCreatedAt = a.clan?.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bCreatedAt = b.clan?.createdAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
    const aClanTag = String(a.clan?.tag ?? a.clanTag ?? "").trim();
    const bClanTag = String(b.clan?.tag ?? b.clanTag ?? "").trim();
    if (aClanTag !== bClanTag) return aClanTag.localeCompare(bClanTag);
    return String(a.playerTag ?? "").localeCompare(String(b.playerTag ?? ""));
  });

  const renderedBadgeByRawBadge = new Map<string, string | null>();
  const seenRenderedByUserId = new Map<string, Set<string>>();

  for (const row of repRows) {
    const userId = userIdsByPlayerTag.get(String(row.playerTag ?? "").trim().toUpperCase());
    if (!userId) continue;
    if (!normalizedUserIdSet.has(userId)) continue;

    const rawBadge = normalizeRenderedBadge(row.clan?.clanBadge ?? null);
    if (!rawBadge) continue;

    let rendered: string | null = null;
    try {
      rendered = await resolveBadgeToken(input.client ?? null, rawBadge, renderedBadgeByRawBadge);
    } catch {
      rendered = null;
    }
    if (!rendered) continue;

    const seen = seenRenderedByUserId.get(userId) ?? new Set<string>();
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    seenRenderedByUserId.set(userId, seen);

    const rows = badgesByUserId.get(userId) ?? [];
    rows.push(rendered);
    badgesByUserId.set(userId, rows);
  }

  return badgesByUserId;
}
