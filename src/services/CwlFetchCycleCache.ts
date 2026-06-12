import { normalizeClanTag } from "./PlayerLinkService";
import { CoCService } from "./CoCService";

type CwlGroupSnapshot = Awaited<ReturnType<CoCService["getClanWarLeagueGroup"]>>;
type CwlWarSnapshot = Awaited<ReturnType<CoCService["getClanWarLeagueWar"]>>;

export type CwlLeagueFetchSource = Pick<
  CoCService,
  "getClanWarLeagueGroup" | "getClanWarLeagueWar"
>;

export type CwlFetchCycleCacheStats = {
  groupHitCount: number;
  groupMissCount: number;
  warHitCount: number;
  warMissCount: number;
  cachedGroupCount: number;
  cachedWarCount: number;
};

function normalizeWarTag(input: string): string {
  return String(input ?? "").trim();
}

/** Purpose: cache CWL group/war fetches within one poll cycle. */
export class CwlFetchCycleCache implements CwlLeagueFetchSource {
  private readonly groupByClanTag = new Map<string, CwlGroupSnapshot | null>();
  private readonly warByWarTag = new Map<string, CwlWarSnapshot | null>();
  private readonly pendingGroupByClanTag = new Map<string, Promise<CwlGroupSnapshot | null>>();
  private readonly pendingWarByWarTag = new Map<string, Promise<CwlWarSnapshot | null>>();
  private groupHitCount = 0;
  private groupMissCount = 0;
  private warHitCount = 0;
  private warMissCount = 0;

  constructor(private readonly cocService: CwlLeagueFetchSource) {}

  async getClanWarLeagueGroup(clanTag: string): Promise<CwlGroupSnapshot | null> {
    const normalizedClanTag = normalizeClanTag(clanTag);
    if (this.groupByClanTag.has(normalizedClanTag)) {
      this.groupHitCount += 1;
      return this.groupByClanTag.get(normalizedClanTag) ?? null;
    }

    const pending = this.pendingGroupByClanTag.get(normalizedClanTag);
    if (pending) {
      this.groupHitCount += 1;
      return pending;
    }

    this.groupMissCount += 1;
    const task = this.cocService
      .getClanWarLeagueGroup(normalizedClanTag || clanTag)
      .then((group) => {
        this.groupByClanTag.set(normalizedClanTag, group);
        return group;
      })
      .finally(() => {
        this.pendingGroupByClanTag.delete(normalizedClanTag);
      });
    this.pendingGroupByClanTag.set(normalizedClanTag, task);
    return task;
  }

  async getClanWarLeagueWar(warTag: string): Promise<CwlWarSnapshot | null> {
    const normalizedWarTag = normalizeWarTag(warTag);
    if (this.warByWarTag.has(normalizedWarTag)) {
      this.warHitCount += 1;
      return this.warByWarTag.get(normalizedWarTag) ?? null;
    }

    const pending = this.pendingWarByWarTag.get(normalizedWarTag);
    if (pending) {
      this.warHitCount += 1;
      return pending;
    }

    this.warMissCount += 1;
    const task = this.cocService
      .getClanWarLeagueWar(normalizedWarTag)
      .then((war) => {
        this.warByWarTag.set(normalizedWarTag, war);
        return war;
      })
      .finally(() => {
        this.pendingWarByWarTag.delete(normalizedWarTag);
      });
    this.pendingWarByWarTag.set(normalizedWarTag, task);
    return task;
  }

  getStats(): CwlFetchCycleCacheStats {
    return {
      groupHitCount: this.groupHitCount,
      groupMissCount: this.groupMissCount,
      warHitCount: this.warHitCount,
      warMissCount: this.warMissCount,
      cachedGroupCount: this.groupByClanTag.size,
      cachedWarCount: this.warByWarTag.size,
    };
  }
}
