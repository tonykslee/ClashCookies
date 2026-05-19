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
