import { prisma } from "../prisma";
import { buildAccountsRows } from "./AccountRowsService";
import {
  getPlayerLinksForDiscordUserWithTrust,
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";

type AccountRow = Awaited<ReturnType<typeof buildAccountsRows>>[number];

type FillerAccountRecord = {
  playerTag: string;
};

type FillerAccountDelegate = {
  findMany(args: any): Promise<FillerAccountRecord[]>;
  upsert(args: any): Promise<unknown>;
  deleteMany(args: any): Promise<{ count: number }>;
};

const fillerAccountPrisma = prisma as typeof prisma & {
  fillerAccount: FillerAccountDelegate;
};

type PlayerLinkRow = {
  playerTag: string;
  discordUserId: string | null;
  discordUsername: string | null;
  playerName: string | null;
};

export type FillerAccountViewRow = AccountRow & {
  discordUserId: string | null;
  discordUsername: string | null;
  linkedName: string | null;
  isFiller: boolean;
};

export type FillerAccountSelectionUpdateResult = {
  guildId: string;
  actorDiscordUserId: string;
  linkedPlayerTags: string[];
  selectedPlayerTags: string[];
  createdCount: number;
  removedCount: number;
};

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => normalizePlayerTag(tag)).filter(Boolean))];
}

function buildPlayerLinkByTag(rows: PlayerLinkRow[]): Map<string, PlayerLinkRow> {
  const byTag = new Map<string, PlayerLinkRow>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    if (byTag.has(playerTag)) continue;
    byTag.set(playerTag, {
      playerTag,
      discordUserId: normalizeDiscordUserId(row.discordUserId),
      discordUsername: normalizeText(row.discordUsername),
      playerName: normalizeText(row.playerName),
    });
  }
  return byTag;
}

async function buildViewRowsForTags(input: {
  guildId: string;
  tags: string[];
  playerLinks: PlayerLinkRow[];
  fillerTagSet: Set<string>;
}): Promise<FillerAccountViewRow[]> {
  const normalizedTags = normalizeTags(input.tags);
  if (normalizedTags.length === 0) return [];

  const linkedNameByTag = new Map(
    input.playerLinks
      .map((row) => [normalizePlayerTag(row.playerTag), normalizeText(row.playerName)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
  const accountRows = await buildAccountsRows({
    guildId: input.guildId,
    linkedNameByTag,
    tags: normalizedTags,
  });
  const playerLinkByTag = buildPlayerLinkByTag(input.playerLinks);

  return accountRows.map((row) => {
    const link = playerLinkByTag.get(row.tag) ?? null;
    return {
      ...row,
      discordUserId: link?.discordUserId ?? null,
      discordUsername: link?.discordUsername ?? null,
      linkedName: link?.playerName ?? null,
      isFiller: input.fillerTagSet.has(row.tag),
    };
  });
}

async function getGuildFillerTags(guildId: string): Promise<string[]> {
  const fillerRows = await fillerAccountPrisma.fillerAccount.findMany({
    where: { guildId },
    orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    select: { playerTag: true },
  });
  return normalizeTags(fillerRows.map((row: FillerAccountRecord) => row.playerTag));
}

export async function listFillerAccountTagsForGuild(input: {
  guildId: string;
}): Promise<string[]> {
  return getGuildFillerTags(input.guildId);
}

export async function listFillerAccountsForGuild(input: {
  guildId: string;
}): Promise<FillerAccountViewRow[]> {
  const tags = await getGuildFillerTags(input.guildId);
  if (tags.length === 0) return [];

  const playerLinks = await prisma.playerLink.findMany({
    where: { playerTag: { in: tags } },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
    },
  });

  return buildViewRowsForTags({
    guildId: input.guildId,
    tags,
    playerLinks: playerLinks as PlayerLinkRow[],
    fillerTagSet: new Set(tags),
  });
}

export async function listFillerAccountsForDiscordUser(input: {
  guildId: string;
  discordUserId: string;
}): Promise<FillerAccountViewRow[]> {
  const guildTags = await getGuildFillerTags(input.guildId);
  if (guildTags.length === 0) return [];

  const normalizedUserId = normalizeDiscordUserId(input.discordUserId);
  if (!normalizedUserId) return [];

  const linkedRows = await getPlayerLinksForDiscordUserWithTrust({
    discordUserId: normalizedUserId,
  });
  const linkedTagSet = new Set(linkedRows.map((row) => row.playerTag));
  const tags = guildTags.filter((tag) => linkedTagSet.has(tag));
  if (tags.length === 0) return [];

  return buildViewRowsForTags({
    guildId: input.guildId,
    tags,
    playerLinks: linkedRows.map((row) => ({
      playerTag: row.playerTag,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      playerName: row.playerName,
    })),
    fillerTagSet: new Set(tags),
  });
}

export async function listFillerEditorAccountsForDiscordUser(input: {
  guildId: string;
  discordUserId: string;
}): Promise<FillerAccountViewRow[]> {
  const normalizedUserId = normalizeDiscordUserId(input.discordUserId);
  if (!normalizedUserId) return [];

  const linkedRows = await listPlayerLinksForDiscordUser({
    discordUserId: normalizedUserId,
  });
  const linkedTags = normalizeTags(linkedRows.map((row) => row.playerTag));
  if (linkedTags.length === 0) return [];

  const playerLinks = await prisma.playerLink.findMany({
    where: { playerTag: { in: linkedTags } },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
    },
  });
  const fillerRows = await fillerAccountPrisma.fillerAccount.findMany({
    where: {
      guildId: input.guildId,
      playerTag: { in: linkedTags },
    },
    select: { playerTag: true },
  });
  const fillerTagSet = new Set(
    fillerRows
      .map((row: FillerAccountRecord) => normalizePlayerTag(row.playerTag))
      .filter((tag): tag is string => Boolean(tag)),
  );

  return buildViewRowsForTags({
    guildId: input.guildId,
    tags: linkedTags,
    playerLinks: playerLinks as PlayerLinkRow[],
    fillerTagSet,
  });
}

export async function listFillerAccountsForClan(input: {
  guildId: string;
  clanTag: string;
}): Promise<FillerAccountViewRow[]> {
  const guildTags = await getGuildFillerTags(input.guildId);
  if (guildTags.length === 0) return [];

  const normalizedClanTag = normalizeClanTag(input.clanTag);
  if (!normalizedClanTag) return [];

  const playerLinks = await prisma.playerLink.findMany({
    where: { playerTag: { in: guildTags } },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
    },
  });

  const rows = await buildViewRowsForTags({
    guildId: input.guildId,
    tags: guildTags,
    playerLinks: playerLinks as PlayerLinkRow[],
    fillerTagSet: new Set(guildTags),
  });

  return rows.filter((row) => normalizeClanTag(String(row.clanTag ?? "")) === normalizedClanTag);
}

export async function replaceFillerAccountsForLinkedUser(input: {
  guildId: string;
  actorDiscordUserId: string;
  linkedPlayerTags: string[];
  selectedPlayerTags: string[];
}): Promise<FillerAccountSelectionUpdateResult> {
  const guildId = String(input.guildId ?? "").trim();
  const actorDiscordUserId = normalizeDiscordUserId(input.actorDiscordUserId);
  const linkedTags = normalizeTags(input.linkedPlayerTags);
  const selectedTags = normalizeTags(input.selectedPlayerTags);
  if (!guildId || !actorDiscordUserId || linkedTags.length === 0) {
    return {
      guildId,
      actorDiscordUserId: actorDiscordUserId ?? "",
      linkedPlayerTags: linkedTags,
      selectedPlayerTags: selectedTags,
      createdCount: 0,
      removedCount: 0,
    };
  }

  const selectedLinkedTags = linkedTags.filter((tag) => selectedTags.includes(tag));
  const existingRows = await fillerAccountPrisma.fillerAccount.findMany({
    where: {
      guildId,
      playerTag: { in: linkedTags },
    },
    select: { playerTag: true },
  });
  const existingSet = new Set(
    existingRows
      .map((row: FillerAccountRecord) => normalizePlayerTag(row.playerTag))
      .filter((tag): tag is string => Boolean(tag)),
  );
  const selectedSet = new Set(selectedLinkedTags);
  const tagsToCreate = selectedLinkedTags.filter((tag) => !existingSet.has(tag));
  const tagsToRemove = linkedTags.filter((tag) => !selectedSet.has(tag) && existingSet.has(tag));

  await Promise.all(
    tagsToCreate.map((playerTag) =>
      fillerAccountPrisma.fillerAccount.upsert({
        where: {
          guildId_playerTag: {
            guildId,
            playerTag,
          },
        },
        create: {
          guildId,
          playerTag,
          createdByDiscordUserId: actorDiscordUserId,
        },
        update: {},
      }),
    ),
  );

  if (tagsToRemove.length > 0) {
    await fillerAccountPrisma.fillerAccount.deleteMany({
      where: {
        guildId,
        playerTag: { in: tagsToRemove },
      },
    });
  }

  return {
    guildId,
    actorDiscordUserId,
    linkedPlayerTags: linkedTags,
    selectedPlayerTags: selectedLinkedTags,
    createdCount: tagsToCreate.length,
    removedCount: tagsToRemove.length,
  };
}
