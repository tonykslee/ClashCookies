import { FwaStatsClient } from "./fwa-feeds/FwaStatsClient";
import { normalizeFwaTag } from "./fwa-feeds/normalize";

type OpponentCacheEntry = {
  fetchedAtMs: number;
  expiresAtMs: number;
  opponents: Set<string>;
};

/** Purpose: read active opponent tags for a clan from fwastats. */
export class FwaStatsService {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private readonly cache = new Map<string, OpponentCacheEntry>();
  private readonly inFlight = new Map<string, Promise<OpponentCacheEntry>>();

  /** Purpose: initialize fwastats service dependencies. */
  constructor(private readonly client = new FwaStatsClient()) {}

  /** Purpose: clear in-memory cache (tests/maintenance). */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** Purpose: check whether opponent appears in the active wars list for a clan. */
  async isOpponentInActiveWars(
    clanTag: string,
    opponentTag: string
  ): Promise<boolean | null> {
    const clan = normalizeFwaTag(clanTag);
    const opponent = normalizeFwaTag(opponentTag);
    if (!clan || !opponent) return null;

    try {
      const entry = await this.getOpponentCache(clan);
      return entry.opponents.has(opponent);
    } catch {
      return null;
    }
  }

  /** Purpose: load or reuse cached fwastats opponent set for one clan. */
  private async getOpponentCache(clanTag: string): Promise<OpponentCacheEntry> {
    const now = Date.now();
    const cached = this.cache.get(clanTag);
    if (cached && cached.expiresAtMs > now) {
      return cached;
    }

    const pending = this.inFlight.get(clanTag);
    if (pending) return pending;

    const load = this.fetchOpponentCache(clanTag)
      .then((entry) => {
        this.cache.set(clanTag, entry);
        return entry;
      })
      .finally(() => {
        this.inFlight.delete(clanTag);
      });

    this.inFlight.set(clanTag, load);
    return load;
  }

  /** Purpose: fetch active opponent list from fwastats wars endpoint. */
  private async fetchOpponentCache(clanTag: string): Promise<OpponentCacheEntry> {
    const rows = await this.client.fetchClanWars(clanTag);
    const opponents = new Set<string>();
    for (const row of rows) {
      if (!row.opponentTag) continue;
      const opponent = normalizeFwaTag(row.opponentTag);
      if (!opponent) continue;

      // Prefer wars that are matched/synced; keep unknown rows to avoid false negatives.
      const matched = row.matched;
      const synced = row.synced;
      if (matched === false && synced === false) continue;

      opponents.add(opponent);
    }

    const fetchedAtMs = Date.now();
    return {
      fetchedAtMs,
      expiresAtMs: fetchedAtMs + FwaStatsService.CACHE_TTL_MS,
      opponents,
    };
  }
}
