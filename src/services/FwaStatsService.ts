import axios from "axios";

type FwaStatsWarRow = {
  opponentTag?: string | null;
  matched?: boolean | string | null;
  synced?: boolean | string | null;
};

type OpponentCacheEntry = {
  fetchedAtMs: number;
  expiresAtMs: number;
  opponents: Set<string>;
};

/** Purpose: normalize clan tags to #UPPER format. */
function normalizeTag(input: string): string {
  return `#${input.trim().toUpperCase().replace(/^#/, "")}`;
}

/** Purpose: parse boolean-like API values safely. */
function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return null;
}

/** Purpose: read active opponent tags for a clan from fwastats. */
export class FwaStatsService {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly REQUEST_TIMEOUT_MS = 2000;

  private readonly cache = new Map<string, OpponentCacheEntry>();
  private readonly inFlight = new Map<string, Promise<OpponentCacheEntry>>();

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
    const clan = normalizeTag(clanTag);
    const opponent = normalizeTag(opponentTag);
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
    const bare = clanTag.replace(/^#/, "");
    const url = `https://fwastats.com/Clan/${bare}/Wars.json`;
    const response = await axios.get<unknown>(url, {
      timeout: FwaStatsService.REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      throw new Error(`fwastats returned ${response.status}`);
    }

    const rows = Array.isArray(response.data) ? (response.data as FwaStatsWarRow[]) : [];
    const opponents = new Set<string>();
    for (const row of rows) {
      const rawOpponent = String(row?.opponentTag ?? "").trim();
      if (!rawOpponent) continue;
      const opponent = normalizeTag(rawOpponent);

      // Prefer wars that are matched/synced; keep unknown rows to avoid false negatives.
      const matched = asBool(row?.matched);
      const synced = asBool(row?.synced);
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
