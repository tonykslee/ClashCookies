import { prisma } from "../prisma";
import { normalizeClanTag, normalizeDiscordUserId, normalizePlayerTag } from "./PlayerLinkService";
import { normalizeClanLeadershipRole, type ClanLeadershipRole } from "./ClanLeadershipRole";

export type ClanLeadershipLookupPair = {
  clanTag: string;
  discordUserId: string;
};

export type ClanLeadershipLookupAccount = {
  clanTag: string;
  discordUserId: string;
  playerTag: string;
  playerName: string;
  role: ClanLeadershipRole;
};

export type ClanLeadershipLookupEntry = {
  clanTag: string;
  discordUserId: string;
  rosterAvailable: boolean;
  observedAt: Date | null;
  accounts: ClanLeadershipLookupAccount[];
};

export type ClanLeadershipLookupResult = {
  entries: ClanLeadershipLookupEntry[];
};

type MemberRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  role: string | null;
  sourceSyncedAt: Date | null;
};

type PlayerLinkRow = {
  playerTag: string;
  discordUserId: string | null;
};

/** Purpose: normalize persisted player names while keeping a stable tag fallback. */
function normalizePlayerName(input: unknown, fallback: string): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

/** Purpose: keep leader accounts ahead of co-leaders and make equal-role ordering stable. */
function compareAccounts(left: ClanLeadershipLookupAccount, right: ClanLeadershipLookupAccount): number {
  const roleOrder = left.role === right.role ? 0 : left.role === "leader" ? -1 : 1;
  return (
    roleOrder ||
    left.playerName.localeCompare(right.playerName) ||
    left.playerTag.localeCompare(right.playerTag)
  );
}

/** Purpose: keep lookup output deterministic across normalized clan and Discord-user pairs. */
function compareEntries(left: ClanLeadershipLookupEntry, right: ClanLeadershipLookupEntry): number {
  return left.clanTag.localeCompare(right.clanTag) || left.discordUserId.localeCompare(right.discordUserId);
}

/** Purpose: bulk-read current persisted roster rows and requested PlayerLink ownership without external calls or writes. */
export async function lookupClanLeadershipForPairs(
  pairs: ClanLeadershipLookupPair[],
): Promise<ClanLeadershipLookupResult> {
  const normalizedPairs = [...new Map(
    pairs
      .map((pair) => {
        const clanTag = normalizeClanTag(pair.clanTag);
        const discordUserId = normalizeDiscordUserId(pair.discordUserId);
        return clanTag && discordUserId
          ? [`${clanTag}:${discordUserId}`, { clanTag, discordUserId }]
          : null;
      })
      .filter((entry): entry is [string, ClanLeadershipLookupPair] => Boolean(entry)),
  ).values()];

  if (normalizedPairs.length === 0) return { entries: [] };

  const clanTags = [...new Set(normalizedPairs.map((pair) => pair.clanTag))];
  const memberRows = (await prisma.fwaClanMemberCurrent.findMany({
    where: { clanTag: { in: clanTags } },
    orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
    select: { clanTag: true, playerTag: true, playerName: true, role: true, sourceSyncedAt: true },
  })) as MemberRow[];

  const normalizedMemberRows = memberRows
    .map((row) => ({
      ...row,
      clanTag: normalizeClanTag(row.clanTag),
      playerTag: normalizePlayerTag(row.playerTag),
    }))
    .filter((row) => Boolean(row.clanTag && row.playerTag));
  const playerTags = [...new Set(normalizedMemberRows.map((row) => row.playerTag))];
  const discordUserIds = [...new Set(normalizedPairs.map((pair) => pair.discordUserId))];
  const playerLinks = playerTags.length > 0
    ? ((await prisma.playerLink.findMany({
        where: { playerTag: { in: playerTags }, discordUserId: { in: discordUserIds } },
        select: { playerTag: true, discordUserId: true },
      })) as PlayerLinkRow[])
    : [];

  const discordUserByPlayerTag = new Map<string, string | null>();
  for (const row of playerLinks) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (playerTag) discordUserByPlayerTag.set(playerTag, normalizeDiscordUserId(row.discordUserId));
  }

  const memberRowsByClan = new Map<string, typeof normalizedMemberRows>();
  for (const row of normalizedMemberRows) {
    const clanRows = memberRowsByClan.get(row.clanTag) ?? [];
    clanRows.push(row);
    memberRowsByClan.set(row.clanTag, clanRows);
  }

  const entries = normalizedPairs.map((pair) => {
    const rows = memberRowsByClan.get(pair.clanTag) ?? [];
    const accountsByTag = new Map<string, ClanLeadershipLookupAccount>();
    for (const row of rows) {
      const role = normalizeClanLeadershipRole(row.role);
      const linkedDiscordUserId = discordUserByPlayerTag.get(row.playerTag);
      if (!role || linkedDiscordUserId !== pair.discordUserId || accountsByTag.has(row.playerTag)) continue;
      accountsByTag.set(row.playerTag, {
        clanTag: pair.clanTag,
        discordUserId: pair.discordUserId,
        playerTag: row.playerTag,
        playerName: normalizePlayerName(row.playerName, row.playerTag),
        role,
      });
    }

    const observedAt = rows
      .map((row) => row.sourceSyncedAt instanceof Date ? row.sourceSyncedAt : null)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    return {
      clanTag: pair.clanTag,
      discordUserId: pair.discordUserId,
      rosterAvailable: rows.length > 0,
      observedAt,
      accounts: [...accountsByTag.values()].sort(compareAccounts),
    } satisfies ClanLeadershipLookupEntry;
  });

  return { entries: entries.sort(compareEntries) };
}
