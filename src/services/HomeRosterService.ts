import { normalizeClashTagWithHash } from "../helper/clashTag";
import { prisma } from "../prisma";
import {
  ClanHomeMembershipService,
  type ActiveHomeMembership,
  type PendingHomeTransferCandidate,
} from "./ClanHomeMembershipService";
import {
  FwaFeedSyncStateService,
  type FwaFeedSyncStateService as FwaFeedSyncStateServiceType,
} from "./fwa-feeds/FwaFeedSyncStateService";
import {
  isAuthoritativeLivePlayerCurrentSource,
  PLAYER_CURRENT_SIGNUP_MAX_AGE_MS,
  playerCurrentService,
  type PlayerCurrentLike,
  type PlayerCurrentService,
} from "./PlayerCurrentService";

export type HomeRosterPresence = "PRESENT" | "AWAY" | "UNKNOWN";
export type HomeRosterCoverage = "CURRENT" | "STALE" | "UNAVAILABLE";

export const HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES = 15;
export const HOME_ROSTER_COVERAGE_CADENCE_MULTIPLIER = 3;
const HOME_ROSTER_COVERAGE_SCHEDULER_JITTER_MS = 30_000;

export type HomeRosterMember = {
  playerTag: string;
  playerName: string;
  homeClanTag: string;
  startedAtSyncTime: Date;
  qualifiedAtSyncTime: Date;
  presence: HomeRosterPresence;
  currentClanTag: string | null;
  currentClanName: string | null;
  currentLocationObservedAt: Date | null;
  pendingTransfer: {
    id: string;
    toClanTag: string;
    toClanName: string | null;
    startedAtSyncTime: Date;
    qualifiedAtSyncTime: Date;
  } | null;
};

export type ClanHomeRoster = {
  guildId: string;
  clanTag: string;
  clanName: string | null;
  homeMemberCount: number;
  presentCount: number;
  awayCount: number;
  unknownCount: number;
  openHomeSpots: number;
  currentClanMemberCount: number | null;
  unassignedPresentCount: number | null;
  pendingTransferCount: number;
  currentRosterCoverage: HomeRosterCoverage;
  currentRosterObservedAt: Date | null;
  members: HomeRosterMember[];
};

type HomeRosterDb = {
  clanHomeMembershipPeriod: { findMany: (args?: any) => Promise<any[]> };
  fwaClanMemberCurrent: { findMany: (args?: any) => Promise<any[]> };
  fwaPlayerCatalog: { findMany: (args?: any) => Promise<any[]> };
  trackedClan: { findMany: (args?: any) => Promise<any[]> };
};

const defaultDb = prisma as unknown as HomeRosterDb;
const defaultFeedSyncStateService = new FwaFeedSyncStateService();
const defaultPlayerCurrentService = playerCurrentService;
const defaultHomeMembershipService = new ClanHomeMembershipService();

type HomeRosterDependencies = {
  db?: HomeRosterDb;
  feedSyncStateService?: Pick<FwaFeedSyncStateServiceType, "getState">;
  playerCurrentService?: Pick<PlayerCurrentService, "listPlayerCurrentByTags">;
  homeMembershipService?: Pick<ClanHomeMembershipService, "getPendingTransferCandidates">;
};

/** Purpose: normalize a player or clan tag for deterministic persisted lookups. */
function normalizeTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

/** Purpose: normalize optional display text while collapsing whitespace and empty values. */
function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Purpose: accept only finite Date instances from persisted or test input. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Purpose: convert an invalid persisted date into an explicit null. */
function validDateOrNull(value: unknown): Date | null {
  return isValidDate(value) ? value : null;
}

/** Purpose: normalize one active Home period row while preserving its immutable qualification facts. */
function normalizeActiveHome(row: any): ActiveHomeMembership | null {
  const guildId = normalizeText(row?.guildId);
  const playerTag = normalizeTag(row?.playerTag);
  const clanTag = normalizeTag(row?.clanTag);
  if (!guildId || !playerTag || !clanTag) return null;
  if (!isValidDate(row?.startedAtSyncTime) || !isValidDate(row?.qualifiedAtSyncTime)) return null;
  return {
    id: String(row.id ?? ""),
    guildId,
    playerTag,
    clanTag,
    startedAtSyncTime: row.startedAtSyncTime,
    qualifiedAtSyncTime: row.qualifiedAtSyncTime,
    endedAtSyncTime: validDateOrNull(row.endedAtSyncTime),
    establishmentSource: String(row.establishmentSource ?? ""),
    endReason: normalizeText(row.endReason),
  };
}

/** Purpose: normalize one pending transfer candidate before matching it to an active Home period. */
function normalizePendingCandidate(row: PendingHomeTransferCandidate): PendingHomeTransferCandidate | null {
  const playerTag = normalizeTag(row.playerTag);
  const fromClanTag = normalizeTag(row.fromClanTag);
  const toClanTag = normalizeTag(row.toClanTag);
  if (!playerTag || !fromClanTag || !toClanTag) return null;
  return {
    ...row,
    playerTag,
    fromClanTag,
    toClanTag,
  };
}

/** Purpose: choose the deterministic display-name fallback order for one Home member. */
function chooseName(input: {
  playerTag: string;
  currentMemberName: string | null;
  playerCurrent: PlayerCurrentLike | undefined;
  catalogName: string | null;
}): string {
  return input.currentMemberName || normalizeText(input.playerCurrent?.playerName) || input.catalogName || input.playerTag;
}

/** Purpose: derive the bounded Home-roster coverage age from the configured feed cadence. */
export function getHomeRosterCoverageMaxAgeMs(cadenceMinutes: number): number {
  const normalizedCadenceMinutes = Math.max(
    HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES,
    Number.isFinite(cadenceMinutes) ? cadenceMinutes : HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES,
  );
  return normalizedCadenceMinutes * HOME_ROSTER_COVERAGE_CADENCE_MULTIPLIER * 60_000 + HOME_ROSTER_COVERAGE_SCHEDULER_JITTER_MS;
}

/** Purpose: classify persisted CLAN_MEMBERS coverage deterministically as current, stale, or unavailable. */
export function getHomeRosterCoverage(input: {
  lastSuccessAt: Date | null | undefined;
  now: Date;
  cadenceMinutes?: number;
}): { coverage: HomeRosterCoverage; observedAt: Date | null } {
  const observedAt = validDateOrNull(input.lastSuccessAt);
  if (!observedAt) return { coverage: "UNAVAILABLE", observedAt: null };
  const now = isValidDate(input.now) ? input.now : new Date();
  const ageMs = now.getTime() - observedAt.getTime();
  return {
    coverage: ageMs <= getHomeRosterCoverageMaxAgeMs(input.cadenceMinutes ?? HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES)
      ? "CURRENT"
      : "STALE",
    observedAt,
  };
}

/** Purpose: read the configured CLAN_MEMBERS cadence using the scheduler's safe minimum. */
function getConfiguredClanMembersCadenceMinutes(): number {
  const configured = Number(process.env.FWA_CLAN_MEMBERS_SYNC_MINUTES ?? HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES, configured)
    : HOME_ROSTER_COVERAGE_MIN_CADENCE_MINUTES;
}

/** Purpose: select the newest real PlayerCurrent timestamp that can describe clan location. */
function getPlayerCurrentLocationObservedAt(playerCurrent: PlayerCurrentLike): Date | null {
  return [validDateOrNull(playerCurrent.lastFetchedAt), validDateOrNull(playerCurrent.lastSeenAt)]
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
}

/** Purpose: allow only fresh, authoritative, non-contradictory Away destinations into the read model. */
function getAuthoritativeAwayLocation(input: {
  playerCurrent: PlayerCurrentLike | undefined;
  homeClanTag: string;
  currentRosterObservedAt: Date;
  now: Date;
}): { clanTag: string; clanName: string | null; observedAt: Date } | null {
  const playerCurrent = input.playerCurrent;
  if (!playerCurrent || !isAuthoritativeLivePlayerCurrentSource(playerCurrent.lastSource)) return null;
  const observedAt = getPlayerCurrentLocationObservedAt(playerCurrent);
  const clanTag = normalizeTag(playerCurrent.currentClanTag);
  if (!observedAt || !clanTag || clanTag === input.homeClanTag) return null;
  if (observedAt.getTime() < input.currentRosterObservedAt.getTime()) return null;
  if (input.now.getTime() - observedAt.getTime() > PLAYER_CURRENT_SIGNUP_MAX_AGE_MS) return null;
  return {
    clanTag,
    clanName: normalizeText(playerCurrent.currentClanName),
    observedAt,
  };
}

/** Purpose: read the authoritative persisted Home roster facts without refreshing any source. */
export class HomeRosterService {
  private readonly db: HomeRosterDb;
  private readonly feedSyncStateService: Pick<FwaFeedSyncStateServiceType, "getState">;
  private readonly playerCurrentService: Pick<PlayerCurrentService, "listPlayerCurrentByTags">;
  private readonly homeMembershipService: Pick<ClanHomeMembershipService, "getPendingTransferCandidates">;

  constructor(dependencies: HomeRosterDependencies = {}) {
    this.db = dependencies.db ?? defaultDb;
    this.feedSyncStateService = dependencies.feedSyncStateService ?? defaultFeedSyncStateService;
    this.playerCurrentService = dependencies.playerCurrentService ?? defaultPlayerCurrentService;
    this.homeMembershipService = dependencies.homeMembershipService ?? defaultHomeMembershipService;
  }

  /** Purpose: load one guild-scoped Home roster from persisted membership, feed, player, and candidate facts. */
  async getClanHomeRoster(input: { guildId: string; clanTag: string; now?: Date }): Promise<ClanHomeRoster> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeTag(input.clanTag);
    const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
    if (!guildId || !clanTag) {
      return this.emptyRoster(guildId, clanTag);
    }

    const activeRows = await this.db.clanHomeMembershipPeriod.findMany({
      where: { guildId, clanTag, endedAtSyncTime: null },
      orderBy: [{ playerTag: "asc" }, { startedAtSyncTime: "asc" }],
      select: {
        id: true,
        guildId: true,
        playerTag: true,
        clanTag: true,
        startedAtSyncTime: true,
        qualifiedAtSyncTime: true,
        endedAtSyncTime: true,
        establishmentSource: true,
        endReason: true,
      },
    });
    const activeHomes = activeRows
      .map(normalizeActiveHome)
      .filter((row): row is ActiveHomeMembership => row !== null && row.endedAtSyncTime === null);
    const playerTags = [...new Set(activeHomes.map((row) => row.playerTag))];

    const [currentRows, feedState, playerCurrentByTag, catalogRows, pendingCandidates] = await Promise.all([
      this.db.fwaClanMemberCurrent.findMany({
        where: { clanTag },
        orderBy: [{ playerTag: "asc" }],
        select: { playerTag: true, playerName: true },
      }),
      this.feedSyncStateService.getState({
        feedType: "CLAN_MEMBERS",
        scopeType: "CLAN_TAG",
        scopeKey: clanTag,
      }),
      this.playerCurrentService.listPlayerCurrentByTags(playerTags),
      playerTags.length > 0
        ? this.db.fwaPlayerCatalog.findMany({
            where: { playerTag: { in: playerTags } },
            select: { playerTag: true, latestName: true },
          })
        : Promise.resolve([]),
      playerTags.length > 0
        ? this.homeMembershipService.getPendingTransferCandidates({
            guildId,
            playerTags,
            fromClanTag: clanTag,
          })
        : Promise.resolve([]),
    ]);

    const currentMemberByTag = new Map<string, { playerTag: string; playerName: string | null }>();
    for (const row of currentRows) {
      const tag = normalizeTag(row?.playerTag);
      if (!tag) continue;
      currentMemberByTag.set(tag, { playerTag: tag, playerName: normalizeText(row?.playerName) });
    }
    const currentTags = new Set(currentMemberByTag.keys());
    const homeTags = new Set(playerTags);
    const activeHomeByPlayer = new Map(activeHomes.map((home) => [home.playerTag, home]));
    const catalogNameByTag = new Map<string, string>();
    for (const row of catalogRows) {
      const tag = normalizeTag(row?.playerTag);
      const name = normalizeText(row?.latestName);
      if (tag && name) catalogNameByTag.set(tag, name);
    }
    const pendingByPlayer = new Map<string, PendingHomeTransferCandidate>();
    for (const candidate of pendingCandidates) {
      const normalized = normalizePendingCandidate(candidate);
      const activeHome = normalized ? activeHomeByPlayer.get(normalized.playerTag) : undefined;
      if (
        normalized &&
        activeHome?.id === normalized.homeMembershipPeriodId &&
        normalized.fromClanTag === clanTag &&
        !pendingByPlayer.has(normalized.playerTag)
      ) {
        pendingByPlayer.set(normalized.playerTag, normalized);
      }
    }
    const destinationTags = [...new Set([...pendingByPlayer.values()].map((candidate) => candidate.toClanTag))];
    const clanRows = await this.db.trackedClan.findMany({
      where: { tag: { in: [clanTag, ...destinationTags] } },
      select: { tag: true, name: true },
    });
    const clanNameByTag = new Map<string, string>();
    for (const row of clanRows) {
      const tag = normalizeTag(row?.tag);
      const name = normalizeText(row?.name);
      if (tag && name) clanNameByTag.set(tag, name);
    }
    const destinationNameByTag = new Map<string, string>();
    for (const tag of destinationTags) {
      const name = clanNameByTag.get(tag);
      if (name) destinationNameByTag.set(tag, name);
    }

    const coverageResult = getHomeRosterCoverage({
      lastSuccessAt: feedState?.lastSuccessAt,
      now,
      cadenceMinutes: getConfiguredClanMembersCadenceMinutes(),
    });
    const currentRosterCoverage = coverageResult.coverage;
    const currentRosterObservedAt = coverageResult.observedAt;
    const hasCurrentCoverage = currentRosterCoverage === "CURRENT" && currentRosterObservedAt !== null;
    const members = activeHomes.map((home) => {
      const current = playerCurrentByTag.get(home.playerTag);
      const presence: HomeRosterPresence = !hasCurrentCoverage
        ? "UNKNOWN"
        : currentTags.has(home.playerTag)
          ? "PRESENT"
          : "AWAY";
      const pending = pendingByPlayer.get(home.playerTag) ?? null;
      const authoritativeLocation = presence === "AWAY" && currentRosterObservedAt
        ? getAuthoritativeAwayLocation({
            playerCurrent: current,
            homeClanTag: clanTag,
            currentRosterObservedAt,
            now,
          })
        : null;
      return {
        playerTag: home.playerTag,
        playerName: chooseName({
          playerTag: home.playerTag,
          currentMemberName: currentMemberByTag.get(home.playerTag)?.playerName ?? null,
          playerCurrent: current,
          catalogName: catalogNameByTag.get(home.playerTag) ?? null,
        }),
        homeClanTag: clanTag,
        startedAtSyncTime: home.startedAtSyncTime,
        qualifiedAtSyncTime: home.qualifiedAtSyncTime,
        presence,
        currentClanTag: authoritativeLocation?.clanTag ?? null,
        currentClanName: authoritativeLocation?.clanName ?? null,
        currentLocationObservedAt: authoritativeLocation?.observedAt ?? null,
        pendingTransfer: pending
          ? {
              id: pending.id,
              toClanTag: pending.toClanTag,
              toClanName: destinationNameByTag.get(pending.toClanTag) ?? null,
              startedAtSyncTime: pending.startedAtSyncTime,
              qualifiedAtSyncTime: pending.qualifiedAtSyncTime,
            }
          : null,
      };
    });
    const presentCount = members.filter((member) => member.presence === "PRESENT").length;
    const awayCount = members.filter((member) => member.presence === "AWAY").length;
    const unknownCount = members.filter((member) => member.presence === "UNKNOWN").length;
    const unassignedPresentCount = [...currentTags].filter((tag) => !homeTags.has(tag)).length;
    const result: ClanHomeRoster = {
      guildId,
      clanTag,
      clanName: clanNameByTag.get(clanTag) ?? null,
      homeMemberCount: activeHomes.length,
      presentCount,
      awayCount,
      unknownCount,
      openHomeSpots: Math.max(0, 50 - activeHomes.length),
      currentClanMemberCount: hasCurrentCoverage ? currentTags.size : null,
      unassignedPresentCount: hasCurrentCoverage ? unassignedPresentCount : null,
      pendingTransferCount: pendingByPlayer.size,
      currentRosterCoverage,
      currentRosterObservedAt,
      members,
    };
    console.info(
      `[home-roster] event=read_summary guild_id=${guildId} clan_tag=${clanTag} home=${result.homeMemberCount} present=${result.presentCount} away=${result.awayCount} unknown=${result.unknownCount} unassigned=${result.unassignedPresentCount} pending_transfers=${result.pendingTransferCount} roster_observed_at=${currentRosterObservedAt?.toISOString() ?? "unavailable"} now=${now.toISOString()}`,
    );
    return result;
  }

  /** Purpose: return an explicit empty/unavailable read model for invalid scope input. */
  private emptyRoster(guildId: string, clanTag: string): ClanHomeRoster {
    return {
      guildId,
      clanTag,
      clanName: null,
      homeMemberCount: 0,
      presentCount: 0,
      awayCount: 0,
      unknownCount: 0,
      openHomeSpots: 50,
      currentClanMemberCount: null,
      unassignedPresentCount: null,
      pendingTransferCount: 0,
      currentRosterCoverage: "UNAVAILABLE",
      currentRosterObservedAt: null,
      members: [],
    };
  }
}

export const homeRosterService = new HomeRosterService();
