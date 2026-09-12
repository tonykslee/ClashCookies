import { prisma } from "../prisma";
import { normalizeClanTag } from "./PlayerLinkService";
import type { KnownBlacklistEvidenceSource } from "./MatchTypeResolutionService";

export type KnownBlacklistEvidenceDb = {
  blacklistClan: {
    findMany(args: any): Promise<Array<{ clanTag: string; active: boolean }>>;
  };
  fwaClanWarLogCurrent: {
    findMany(args: any): Promise<Array<{ opponentTag: string; opponentInfo: string | null }>>;
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
          opponentInfo: { equals: "Blacklisted", mode: "insensitive" },
        },
        select: { opponentTag: true, opponentInfo: true },
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

    for (const row of warLogRows) {
      const tag = normalizeClanTag(String(row.opponentTag ?? ""));
      const opponentInfo = String(row.opponentInfo ?? "").trim().toLowerCase();
      if (
        !tag ||
        opponentInfo !== "blacklisted" ||
        inactiveRegistryTags.has(tag) ||
        evidence.has(tag)
      ) {
        continue;
      }
      evidence.set(tag, "known_blacklist_fwa_war_log");
    }

    return evidence;
  }
}

export const knownBlacklistEvidenceService = new KnownBlacklistEvidenceService();
