import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";

export type FwaTrackedClanDisplayRow = {
  tag: string;
  name: string | null;
  loseStyle: string;
  mailChannelId: string | null;
  logChannelId: string | null;
  leaderChannelId: string | null;
  clanRoleId: string | null;
  leadRoleId: string | null;
  clanBadge: string | null;
  shortName: string | null;
  createdAt: Date;
};

/** Purpose: list tracked FWA clans in deterministic creation order for command rendering. */
export async function listFwaTrackedClansForDisplay(): Promise<FwaTrackedClanDisplayRow[]> {
  const rows = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      tag: true,
      name: true,
      loseStyle: true,
      mailChannelId: true,
      logChannelId: true,
      leaderChannelId: true,
      clanRoleId: true,
      leadRoleId: true,
      clanBadge: true,
      shortName: true,
      createdAt: true,
    },
  });

  return rows.map((row) => ({
    tag: normalizeClanTag(row.tag) || row.tag,
    name: row.name,
    loseStyle: row.loseStyle,
    mailChannelId: row.mailChannelId,
    logChannelId: row.logChannelId,
    leaderChannelId: row.leaderChannelId,
    clanRoleId: row.clanRoleId,
    leadRoleId: row.leadRoleId,
    clanBadge: row.clanBadge,
    shortName: row.shortName,
    createdAt: row.createdAt,
  }));
}

/** Purpose: load persisted FWA current-member counts for a set of tracked clan tags in one bulk query. */
export async function listFwaClanMemberCountsForTags(tags: string[]): Promise<Map<string, number>> {
  const normalizedTags = [
    ...new Set(tags.map((tag) => normalizeClanTag(tag)).filter((tag): tag is string => Boolean(tag))),
  ];
  if (normalizedTags.length === 0) {
    return new Map();
  }

  const rows = await prisma.fwaClanMemberCurrent.groupBy({
    by: ["clanTag"],
    where: {
      clanTag: { in: normalizedTags },
    },
    _count: {
      clanTag: true,
    },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const tag = normalizeClanTag(row.clanTag);
    if (!tag) continue;
    counts.set(tag, row._count.clanTag);
  }
  return counts;
}
