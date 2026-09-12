import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import type { KnownBlacklistEvidenceSource } from "./MatchTypeResolutionService";

export type KnownBlacklistEvidenceDb = {
  blacklistClan: {
    findMany(args: any): Promise<Array<{ clanTag: string; active: boolean }>>;
  };
  fwaClanWarLogCurrent: {
    findMany(args: any): Promise<
      Array<{
        opponentTag: string;
        opponentInfo: string | null;
        endTime: Date;
        sourceSyncedAt: Date;
      }>
    >;
  };
};

export class KnownBlacklistEvidenceService {
  constructor(private readonly db: KnownBlacklistEvidenceDb = prisma) {}

  /** Purpose: bulk-resolve normalized blacklist evidence without introducing live API or N+1 lookups. */
  async resolve(
    tags: Iterable<string>,
  ): Promise<Map<string, KnownBlacklistEvidenceSource>> {
    const normalizedTags = [
      ...new Set(
        Array.from(tags, (tag) => normalizeClanTag(String(tag ?? ""))).filter(Boolean),
      ),
    ];
    if (normalizedTags.length === 0) return new Map();

    const [registryRows, warLogRows] = await Promise.all([
      this.db.blacklistClan.findMany({
        where: { clanTag: { in: normalizedTags } },
        select: { clanTag: true, active: true },
      }),
      this.db.fwaClanWarLogCurrent.findMany({
        where: {
          opponentTag: { in: normalizedTags, mode: "insensitive" },
        },
        orderBy: [
          { endTime: "desc" },
          { sourceSyncedAt: "desc" },
          { opponentTag: "asc" },
        ],
        select: {
          opponentTag: true,
          opponentInfo: true,
          endTime: true,
          sourceSyncedAt: true,
        },
      }),
    ]);

    const evidence = new Map<string, KnownBlacklistEvidenceSource>();
    const inactiveRegistryTags = new Set<string>();
    for (const row of registryRows) {
      const tag = normalizeClanTag(String(row.clanTag ?? ""));
      if (!tag) continue;
      if (row.active === true) {
        evidence.set(tag, "known_blacklist_registry");
      } else {
        inactiveRegistryTags.add(tag);
      }
    }

    const latestFeedRowByTag = new Map<
      string,
      (typeof warLogRows)[number]
    >();
    for (const row of warLogRows) {
      const tag = normalizeClanTag(String(row.opponentTag ?? ""));
      if (!tag) continue;
      const existing = latestFeedRowByTag.get(tag);
      if (!existing || compareFeedRows(row, existing) > 0) {
        latestFeedRowByTag.set(tag, row);
      }
    }

    for (const [tag, row] of latestFeedRowByTag) {
      const opponentInfo = String(row.opponentInfo ?? "").trim().toLowerCase();
      if (
        opponentInfo === "blacklisted" &&
        !inactiveRegistryTags.has(tag) &&
        !evidence.has(tag)
      ) {
        evidence.set(tag, "known_blacklist_fwa_war_log");
      }
    }

    return evidence;
  }
}

function compareFeedRows(
  left: { endTime: Date; sourceSyncedAt: Date },
  right: { endTime: Date; sourceSyncedAt: Date },
): number {
  const endTimeDifference = left.endTime.getTime() - right.endTime.getTime();
  if (endTimeDifference !== 0) return endTimeDifference;
  return left.sourceSyncedAt.getTime() - right.sourceSyncedAt.getTime();
}

export const knownBlacklistEvidenceService = new KnownBlacklistEvidenceService();
