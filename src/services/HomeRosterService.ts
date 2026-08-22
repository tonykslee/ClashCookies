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
  playerCurrentService,
  type PlayerCurrentLike,
  type PlayerCurrentService,
} from "./PlayerCurrentService";

export type HomeRosterPresence = "PRESENT" | "AWAY" | "UNKNOWN";

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
  currentClanMemberCount: number;
  unassignedPresentCount: number;
  pendingTransferCount: number;
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

function normalizeTag(value: unknown): string {
  return normalizeClashTagWithHash(String(value ?? ""));
}

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validDateOrNull(value: unknown): Date | null {
  return isValidDate(value) ? value : null;
}

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

function chooseName(input: {
  playerTag: string;
  currentMemberName: string | null;
  playerCurrent: PlayerCurrentLike | undefined;
  catalogName: string | null;
}): string {
  return input.currentMemberName || normalizeText(input.playerCurrent?.playerName) || input.catalogName || input.playerTag;
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
    const catalogNameByTag = new Map<string, string>();
    for (const row of catalogRows) {
      const tag = normalizeTag(row?.playerTag);
      const name = normalizeText(row?.latestName);
      if (tag && name) catalogNameByTag.set(tag, name);
    }
    const pendingByPlayer = new Map<string, PendingHomeTransferCandidate>();
    for (const candidate of pendingCandidates) {
      const normalized = normalizePendingCandidate(candidate);
      if (normalized && !pendingByPlayer.has(normalized.playerTag)) {
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

    const currentRosterObservedAt = validDateOrNull(feedState?.lastSuccessAt);
    const hasCoverage = currentRosterObservedAt !== null;
    const members = activeHomes.map((home) => {
      const current = playerCurrentByTag.get(home.playerTag);
      const presence: HomeRosterPresence = !hasCoverage
        ? "UNKNOWN"
        : currentTags.has(home.playerTag)
          ? "PRESENT"
          : "AWAY";
      const pending = pendingByPlayer.get(home.playerTag) ?? null;
      const authoritativeLocation = current && isAuthoritativeLivePlayerCurrentSource(current.lastSource)
        ? current
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
        currentClanTag: presence === "AWAY" ? normalizeTag(authoritativeLocation?.currentClanTag) || null : null,
        currentClanName: presence === "AWAY" ? normalizeText(authoritativeLocation?.currentClanName) : null,
        currentLocationObservedAt: presence === "AWAY"
          ? validDateOrNull(authoritativeLocation?.lastFetchedAt) ?? validDateOrNull(authoritativeLocation?.lastSeenAt) ?? validDateOrNull(authoritativeLocation?.updatedAt)
          : null,
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
      currentClanMemberCount: currentTags.size,
      unassignedPresentCount,
      pendingTransferCount: pendingByPlayer.size,
      currentRosterObservedAt,
      members,
    };
    console.info(
      `[home-roster] event=read_summary guild_id=${guildId} clan_tag=${clanTag} home=${result.homeMemberCount} present=${result.presentCount} away=${result.awayCount} unknown=${result.unknownCount} unassigned=${result.unassignedPresentCount} pending_transfers=${result.pendingTransferCount} roster_observed_at=${currentRosterObservedAt?.toISOString() ?? "unavailable"} now=${now.toISOString()}`,
    );
    return result;
  }

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
      currentClanMemberCount: 0,
      unassignedPresentCount: 0,
      pendingTransferCount: 0,
      currentRosterObservedAt: null,
      members: [],
    };
  }
}

export const homeRosterService = new HomeRosterService();
