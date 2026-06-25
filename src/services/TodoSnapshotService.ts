import { ClanWar, type ClanWarMember } from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildPlayerSignalStateKey,
  extractGamesChampionTotalFromSignalState,
} from "./ActivitySignalService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlEventResolutionService } from "./CwlEventResolutionService";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import { CwlFetchCycleCache, type CwlLeagueFetchSource } from "./CwlFetchCycleCache";
import { cocRequestQueueService } from "./CoCRequestQueueService";
import { cwlStateService } from "./CwlStateService";
import type { PlayerCurrentLike } from "./PlayerCurrentService";
import { isPlayerCurrentStaleForSignup } from "./PlayerCurrentFreshness";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import {
  buildTrackedWarMemberStateByClanAndPlayer,
  isTodoWarStateActive,
  type TodoTrackedCurrentWarRow,
  type TodoTrackedWarRosterRow,
} from "./TodoTrackedWarStateService";
import { parseCocTime } from "./war-events/core";

const TODO_SNAPSHOT_SELECT = {
  playerTag: true,
  playerName: true,
  townHall: true,
  clanTag: true,
  clanName: true,
  warClanTag: true,
  warClanName: true,
  warPosition: true,
  warSourceUpdatedAt: true,
  warOwnerSource: true,
  warOwnerWarId: true,
  warOwnerVerifiedAt: true,
  clanMembershipObservedAt: true,
  raidClanTag: true,
  raidClanName: true,
  cwlClanTag: true,
  cwlClanName: true,
  warActive: true,
  warAttacksUsed: true,
  warAttacksMax: true,
  warPhase: true,
  warEndsAt: true,
  cwlActive: true,
  cwlAttacksUsed: true,
  cwlAttacksMax: true,
  cwlPhase: true,
  cwlEndsAt: true,
  raidActive: true,
  raidAttacksUsed: true,
  raidAttacksMax: true,
  raidEndsAt: true,
  raidSourceUpdatedAt: true,
  gamesActive: true,
  gamesPoints: true,
  gamesTarget: true,
  gamesChampionTotal: true,
  gamesSeasonBaseline: true,
  gamesCycleKey: true,
  gamesEndsAt: true,
  lastUpdatedAt: true,
  updatedAt: true,
} as const;

export type TodoSnapshotRecord = Awaited<
  ReturnType<typeof listTodoSnapshotRecordsForTypeInference>
>[number];

type TodoSnapshotVersion = {
  snapshotCount: number;
  maxUpdatedAtMs: number;
};

type TodoSnapshotRefreshResult = {
  playerCount: number;
  updatedCount: number;
};

type TodoRefreshCadence = "tracked" | "observe";

type TodoActivatedRefreshStats = {
  activatedUserCount: number;
  totalLinkedUserCount: number;
  skippedNeverUsedUserCount: number;
  selectedPlayerCount: number;
  trackedPlayerCount: number;
  nonTrackedPlayerCount: number;
};

type ObservedLivePlayerCurrent = {
  playerTag: string;
  clanTag: string | null;
  clanName?: string | null;
  townHall: number | null;
};

type ObservedLivePlayerCurrentByTag = Map<
  string,
  {
    clanTag: string;
    clanName?: string | null;
    townHall: number | null;
  }
>;

type TodoCurrentMembershipContext = {
  clanTag: string | null;
  clanName: string | null;
  observedAt: Date | null;
  fresh: boolean;
  source:
    | "observed_live"
    | "fetched_live"
    | "player_current"
    | "fwa_member"
    | "existing"
    | "none"
    | "no_clan";
};

type LiveClanTagEntry = {
  clanTag: string;
  clanName: string | null;
  townHall: number | null;
  source: "observed_live" | "fetched_live";
};

type CurrentWarSnapshot = Awaited<ReturnType<CoCService["getCurrentWar"]>>;

type TodoTrackedWarRosterCurrentRow = {
  clanTag: string;
  clanName: string | null;
  sourceWarId: number | null;
  sourceWarStartTime: Date | null;
  sourceWarEndTime: Date | null;
  sourceWarState: string | null;
  sourceCurrentWarUpdatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  observedAt: Date | null;
};

type TrackedWarRosterIdentityMatch =
  | "EXACT_WAR_ID"
  | "EXACT_START_TIME"
  | "LEGACY_UNSCOPED"
  | "STALE_OR_MISMATCHED";

type TrackedWarRosterRenderState = "ACTIVE" | "RETAINED_ENDED" | "INACTIVE";

type TodoTrackedWarRosterCandidateRow = {
  clanTag: string;
  playerTag: string;
  position: number;
  playerName: string;
  townHall: number | null;
  parent: TodoTrackedWarRosterCurrentRow;
  identityMatch: TrackedWarRosterIdentityMatch;
};

type TodoWindow = {
  active: boolean;
  startMs: number;
  endMs: number;
};

type WarEventLinkedPlayerRefreshProducer = {
  source: string;
  pacingMs: number | null;
  backlogThreshold: number;
};

type TodoClanGamesWindow = {
  active: boolean;
  rewardCollectionActive: boolean;
  startMs: number;
  endMs: number;
  rewardCollectionEndsMs: number;
};

type LiveCwlClanContext = {
  clanTag: string;
  clanName: string | null;
  roundState: string;
  phaseEndsAt: Date | null;
  membersByPlayerTag: Map<
    string,
    {
      clanTag: string;
      playerName: string;
      townHall: number | null;
      attacksUsed: number;
      attacksAvailable: number;
      subbedIn: boolean;
      subbedOut: boolean;
    }
  >;
};

type LiveCurrentWarFallbackContext = {
  clanTag: string;
  clanName: string | null;
  currentWarState: string;
  phaseEndsAt: Date | null;
  sourceUpdatedAt: Date | null;
  membersByPlayerTag: Map<
    string,
    {
      clanTag: string;
      playerName: string;
      townHall: number | null;
      mapPosition: number | null;
      attacksUsed: number;
      attacksAvailable: number;
    }
  >;
};

type LiveRaidContextStatus = "observed" | "unavailable" | "failed";

type LiveRaidContext = {
  status: LiveRaidContextStatus;
  raidClanTag: string | null;
  raidClanName: string | null;
  attacksUsed: number;
};

type LiveRaidCandidateClanEntry = {
  clanTag: string;
  clanName: string | null;
};

type LiveRaidCandidateClanEntriesByPlayerTag = Map<string, LiveRaidCandidateClanEntry[]>;

type TodoRaidSnapshotState = {
  raidActive: boolean;
  raidClanTag: string | null;
  raidClanName: string | null;
  raidAttacksUsed: number;
  raidAttacksMax: number;
  raidEndsAt: Date | null;
  raidSourceUpdatedAt: Date | null;
};

type ClanMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
  playerName: string;
  sourceSyncedAt: Date;
};

type WarMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
  playerName: string;
  townHall: number | null;
  position: number | null;
  attacks: number | null;
  sourceSyncedAt: Date;
};

type WarAttacksRow = {
  warId: number;
  clanTag: string;
  warStartTime: Date;
  playerTag: string;
  playerPosition: number | null;
  attacksUsed: number;
  attackOrder: number;
  attackNumber: number;
  defenderPosition: number | null;
  stars: number;
  attackSeenAt: Date;
};

type TrackedWarRosterDriftDiagnostic = {
  clanTag: string;
  rawMemberCount: number;
  derivedMemberCount: number;
  missingDerivedMemberCount: number;
  rosterCurrentExists: boolean;
  currentWarState: string;
  missingDerivedMemberSampleTags: string[];
};

type WarOwnerCandidateSource =
  | "derived_roster"
  | "legacy_roster"
  | "raw_war_member"
  | "snapshot_hint"
  | "current_membership";

type TodoWarOwnerSource = "LIVE_VERIFIED" | "PERSISTED_FALLBACK" | "NONE";

type WarOwnerCandidateEntry = {
  clanTag: string;
  sources: Set<WarOwnerCandidateSource>;
  preferredClanName: string | null;
  preferredClanNameRank: number;
  currentWarUpdatedAt: Date | null;
  currentWarWarId: number | null;
};

type WarOwnerCandidateVerificationStatus =
  | "verified_present"
  | "verified_absent"
  | "unavailable";

type WarOwnerResolutionSource =
  | "live_verified"
  | "persisted_fallback"
  | "canonical_tracked_roster"
  | "authoritative_clear"
  | "unresolved";

type TodoGamesDerivedValues = {
  points: number | null;
  target: number | null;
  championTotal: number | null;
  seasonBaseline: number | null;
  cycleKey: string | null;
};

const TODO_GAMES_TARGET_POINTS = 4000;
const TODO_GAMES_POINTS_MAX = 4000;
const TODO_GAMES_REWARD_COLLECTION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const TODO_SNAPSHOT_WRITE_CHUNK_SIZE = 50;
const LIVE_CURRENT_WAR_FALLBACK_CONCURRENCY_LIMIT = 3;
const TODO_CURRENT_MEMBERSHIP_MAX_AGE_MS = 60 * 60 * 1000;

function normalizeRosterInt(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

/** Purpose: classify tracked-roster identity without mixing identity matching with lifecycle state. */
function classifyTrackedWarRosterCurrentIdentity(input: {
  roster: TodoTrackedWarRosterCurrentRow;
  currentWar: TodoTrackedCurrentWarRow | null;
}): TrackedWarRosterIdentityMatch {
  const currentWar = input.currentWar;
  const rosterWarId = toFiniteIntOrNull(input.roster.sourceWarId);
  const rosterStartMs =
    input.roster.sourceWarStartTime instanceof Date
      ? input.roster.sourceWarStartTime.getTime()
      : null;

  if (!currentWar) {
    return rosterWarId === null && rosterStartMs === null
      ? "LEGACY_UNSCOPED"
      : "STALE_OR_MISMATCHED";
  }

  const currentWarId = toFiniteIntOrNull(currentWar.warId);
  if (rosterWarId !== null && currentWarId !== null) {
    return rosterWarId === currentWarId ? "EXACT_WAR_ID" : "STALE_OR_MISMATCHED";
  }

  const currentStartMs =
    currentWar.startTime instanceof Date ? currentWar.startTime.getTime() : null;
  if (rosterStartMs !== null && currentStartMs !== null) {
    return rosterStartMs === currentStartMs ? "EXACT_START_TIME" : "STALE_OR_MISMATCHED";
  }

  return rosterWarId === null && rosterStartMs === null
    ? "LEGACY_UNSCOPED"
    : "STALE_OR_MISMATCHED";
}

/** Purpose: allow retained ended-war roster context only when the existing todo row is still rendering that exact clan war. */
function resolveTrackedWarRosterRenderState(input: {
  roster: TodoTrackedWarRosterCurrentRow;
  currentWar: TodoTrackedCurrentWarRow | null;
  existingSnapshot: TodoSnapshotRecord | null;
  identityMatch: TrackedWarRosterIdentityMatch;
}): TrackedWarRosterRenderState {
  if (input.identityMatch === "STALE_OR_MISMATCHED") {
    return "INACTIVE";
  }
  if (input.currentWar && isTodoWarStateActive(input.currentWar.state)) {
    return "ACTIVE";
  }

  const existingWarClanTag = normalizeClanTag(
    input.existingSnapshot?.warClanTag ?? input.existingSnapshot?.clanTag ?? "",
  );
  const rosterClanTag = normalizeClanTag(input.roster.clanTag);
  if (
    input.existingSnapshot?.warActive === true &&
    existingWarClanTag &&
    rosterClanTag &&
    existingWarClanTag === rosterClanTag &&
    matchesRetainedTrackedWarRosterIdentity({
      roster: input.roster,
      currentWar: input.currentWar,
    })
  ) {
    return "RETAINED_ENDED";
  }

  return "INACTIVE";
}

/** Purpose: identify retained-ended tracked-war roster continuity by exact identity only. */
function matchesRetainedTrackedWarRosterIdentity(input: {
  roster: TodoTrackedWarRosterCurrentRow;
  currentWar: TodoTrackedCurrentWarRow | null;
}): boolean {
  if (!input.currentWar) return false;
  const rosterWarId = toFiniteIntOrNull(input.roster.sourceWarId);
  const currentWarId = toFiniteIntOrNull(input.currentWar.warId);
  if (rosterWarId !== null && currentWarId !== null) {
    return rosterWarId === currentWarId;
  }
  const rosterStartMs =
    input.roster.sourceWarStartTime instanceof Date
      ? input.roster.sourceWarStartTime.getTime()
      : null;
  const currentStartMs =
    input.currentWar.startTime instanceof Date ? input.currentWar.startTime.getTime() : null;
  return rosterWarId === null && rosterStartMs !== null && currentStartMs !== null
    ? rosterStartMs === currentStartMs
    : false;
}

/** Purpose: keep all Todo snapshot reads/writes in one service boundary. */
export class TodoSnapshotService {
  private readonly refreshByBatchKey = new Map<
    string,
    Promise<TodoSnapshotRefreshResult>
  >();

  /** Purpose: clear in-memory refresh locks between isolated tests. */
  resetForTest(): void {
    this.refreshByBatchKey.clear();
  }

  /** Purpose: load ordered snapshot rows for one player-tag set. */
  async listSnapshotsByPlayerTags(input: {
    playerTags: string[];
  }): Promise<TodoSnapshotRecord[]> {
    const normalizedTags = normalizePlayerTags(input.playerTags);
    if (normalizedTags.length <= 0) return [];

    const rows = await prisma.todoPlayerSnapshot.findMany({
      where: { playerTag: { in: normalizedTags } },
      select: TODO_SNAPSHOT_SELECT,
    });

    const indexByTag = new Map(normalizedTags.map((tag, idx) => [tag, idx]));
    const normalizedRows = rows.map((row) => ({
      ...row,
      playerTag: normalizePlayerTag(row.playerTag),
      townHall: Number.isFinite(Number(row.townHall)) ? Math.trunc(Number(row.townHall)) : null,
      clanTag: row.clanTag ? normalizeClanTag(row.clanTag) : null,
      cwlClanTag: row.cwlClanTag ? normalizeClanTag(row.cwlClanTag) : null,
    })) as TodoSnapshotRecord[];
    return normalizedRows
      .filter((row) => row.playerTag.length > 0)
      .sort((a, b) => {
        const aIndex = indexByTag.get(a.playerTag);
        const bIndex = indexByTag.get(b.playerTag);
        if (aIndex !== undefined && bIndex !== undefined && aIndex !== bIndex) {
          return aIndex - bIndex;
        }
        return a.playerTag.localeCompare(b.playerTag);
      });
  }

  /** Purpose: load ordered snapshot rows for one clan tag using the requested current-clan source. */
  async listSnapshotsByClanTag(input: {
    clanTag: string;
    source?: "clanTag" | "cwlClanTag";
  }): Promise<TodoSnapshotRecord[]> {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    if (!normalizedClanTag) return [];

    const source = input.source ?? "clanTag";
    const rows = await prisma.todoPlayerSnapshot.findMany({
      where:
        source === "cwlClanTag"
          ? { cwlClanTag: normalizedClanTag }
          : { clanTag: normalizedClanTag },
      select: TODO_SNAPSHOT_SELECT,
      orderBy: [{ playerName: "asc" }, { playerTag: "asc" }],
    });

    return rows.map((row) => ({
      ...row,
      playerTag: normalizePlayerTag(row.playerTag),
      townHall: Number.isFinite(Number(row.townHall)) ? Math.trunc(Number(row.townHall)) : null,
      clanTag: row.clanTag ? normalizeClanTag(row.clanTag) : null,
      cwlClanTag: row.cwlClanTag ? normalizeClanTag(row.cwlClanTag) : null,
    })) as TodoSnapshotRecord[];
  }

  /** Purpose: return compact snapshot-version metadata for cache-key construction. */
  async getSnapshotVersion(input: {
    playerTags: string[];
  }): Promise<TodoSnapshotVersion> {
    const normalizedTags = normalizePlayerTags(input.playerTags);
    if (normalizedTags.length <= 0) {
      return { snapshotCount: 0, maxUpdatedAtMs: 0 };
    }

    const aggregate = await prisma.todoPlayerSnapshot.aggregate({
      where: { playerTag: { in: normalizedTags } },
      _count: { _all: true },
      _max: { lastUpdatedAt: true, updatedAt: true },
    });

    const maxUpdatedAt =
      aggregate._max.lastUpdatedAt ?? aggregate._max.updatedAt ?? null;
    return {
      snapshotCount: Number(aggregate._count?._all ?? 0),
      maxUpdatedAtMs: maxUpdatedAt ? maxUpdatedAt.getTime() : 0,
    };
  }

  /** Purpose: refresh all linked-player snapshots from existing tracked state in one bounded pass. */
  async refreshAllLinkedPlayerSnapshots(input: {
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    nowMs?: number;
    producerPacingMs?: number | null;
    observedLivePlayerCurrent?: ObservedLivePlayerCurrent[];
    preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null>;
  }): Promise<TodoSnapshotRefreshResult> {
    return this.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: input.cocService,
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      nowMs: input.nowMs,
      producerPacingMs: input.producerPacingMs,
      observedLivePlayerCurrent: input.observedLivePlayerCurrent,
      preloadedCurrentWarSnapshotsByClanTag: input.preloadedCurrentWarSnapshotsByClanTag,
    });
  }

  /** Purpose: refresh todo snapshots for previously-activated users within one cadence bucket. */
  async refreshActivatedTodoLinkedPlayerSnapshots(input: {
    cadence: TodoRefreshCadence;
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    nowMs?: number;
    producerPacingMs?: number | null;
    observedLivePlayerCurrent?: ObservedLivePlayerCurrent[];
    preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null>;
  }): Promise<TodoSnapshotRefreshResult & TodoActivatedRefreshStats> {
    const nowMs = input.nowMs;
    const allLinkedUserRows = await prisma.playerLink.findMany({
      where: { discordUserId: { not: null } },
      select: { discordUserId: true, playerTag: true },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    });
    const totalLinkedUserIds = [
      ...new Set(
        allLinkedUserRows
          .map((row) => normalizeDiscordUserId(row.discordUserId))
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const activatedUserRows = await prisma.todoUserUsage.findMany({
      select: { discordUserId: true },
      orderBy: { activatedAt: "asc" },
    });
    const activatedUserIdSet = new Set(
      activatedUserRows
        .map((row) => normalizeDiscordUserId(row.discordUserId))
        .filter((value): value is string => Boolean(value)),
    );

    const activatedLinkedRows = allLinkedUserRows.filter((row) => {
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      return Boolean(discordUserId && activatedUserIdSet.has(discordUserId));
    });
    const activatedPlayerTags = normalizePlayerTags(
      activatedLinkedRows.map((row) => row.playerTag),
    );
    const currentCwlSeason = resolveCurrentCwlSeasonKey(nowMs);

    const snapshotRows = activatedPlayerTags.length > 0
      ? await prisma.todoPlayerSnapshot.findMany({
          where: { playerTag: { in: activatedPlayerTags } },
          select: {
            playerTag: true,
            clanTag: true,
            raidActive: true,
            raidClanTag: true,
            warActive: true,
            warClanTag: true,
            cwlClanTag: true,
          },
        })
      : [];
    const snapshotClanTagByPlayerTag = new Map(
      snapshotRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.clanTag ?? ""),
      ] as const),
    );
    const snapshotByPlayerTag = new Map(
      snapshotRows.map((row) => [normalizePlayerTag(row.playerTag), row] as const),
    );
    const snapshotRaidClanTagByPlayerTag = new Map(
      snapshotRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        row.raidActive
          ? normalizeClanTag(row.raidClanTag ?? "") ||
            normalizeClanTag(row.clanTag ?? "") ||
            null
          : null,
      ] as const),
    );
    const snapshotCwlClanTagByPlayerTag = new Map(
      snapshotRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.cwlClanTag ?? ""),
      ] as const),
    );
    const trackedClanRows = await prisma.trackedClan.findMany({
      select: { tag: true, name: true },
    });
    const raidTrackedClanRows = await listRaidTrackedClanRows();
    const cwlTrackedClanRows = await prisma.cwlTrackedClan.findMany({
      where: { season: currentCwlSeason },
      select: { tag: true },
    });
    const trackedClanTagSet = new Set(
      trackedClanRows
        .map((row) => normalizeClanTag(row.tag))
        .filter(Boolean),
    );
    const raidTrackedClanTagSet = new Set(
      raidTrackedClanRows
        .map((row) => normalizeClanTag(row.clanTag))
        .filter(Boolean),
    );
    const trackedRaidClanTagSet = new Set([
      ...trackedClanTagSet,
      ...raidTrackedClanTagSet,
    ]);
    const cwlTrackedClanTagSet = new Set(
      cwlTrackedClanRows
        .map((row) => normalizeClanTag(row.tag))
        .filter(Boolean),
    );

    const currentWarRows =
      trackedClanTagSet.size > 0
        ? await prisma.currentWar.findMany({
            where: { clanTag: { in: [...trackedClanTagSet] } },
            select: {
              clanTag: true,
              state: true,
            },
          })
        : [];
    const activeTrackedCurrentWarClanTagSet = new Set(
      currentWarRows
        .map((row) => [normalizeClanTag(row.clanTag), row.state] as const)
        .filter(
          (entry): entry is [string, string | null] =>
            Boolean(entry[0] && isTodoWarStateActive(entry[1])),
        )
        .map(([clanTag]) => clanTag),
    );

    const clanMemberRows =
      activatedPlayerTags.length > 0
        ? await prisma.fwaClanMemberCurrent.findMany({
            where: { playerTag: { in: activatedPlayerTags } },
            select: {
              playerTag: true,
              clanTag: true,
            },
          })
        : [];
    const warMemberRows =
      activatedPlayerTags.length > 0
        ? await prisma.fwaWarMemberCurrent.findMany({
            where: { playerTag: { in: activatedPlayerTags } },
            select: {
              playerTag: true,
              clanTag: true,
            },
          })
        : [];
    const trackedWarRosterMemberRows =
      activatedPlayerTags.length > 0
        ? await prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
            where: { playerTag: { in: activatedPlayerTags } },
            select: {
              playerTag: true,
              clanTag: true,
            },
          })
        : [];

    const clanMemberClanTagByPlayerTag = new Map(
      clanMemberRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.clanTag),
      ] as const),
    );
    const warMemberClanTagByPlayerTag = new Map(
      warMemberRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.clanTag),
      ] as const),
    );
    const trackedWarRosterClanTagByPlayerTag = new Map(
      trackedWarRosterMemberRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.clanTag),
      ] as const),
    );

    const trackedPlayerTags: string[] = [];
    const nonTrackedPlayerTags: string[] = [];
    const snapshotTrackedPlayerTagSet = new Set<string>();
    const snapshotWarContextPlayerTagSet = new Set<string>();
    const snapshotRaidContextPlayerTagSet = new Set<string>();
    const memberTrackedPlayerTagSet = new Set<string>();
    const warMemberTrackedPlayerTagSet = new Set<string>();
    const rosterTrackedPlayerTagSet = new Set<string>();
    for (const playerTag of activatedPlayerTags) {
      const snapshotClanTag = snapshotClanTagByPlayerTag.get(playerTag) ?? null;
      const snapshotRow = snapshotByPlayerTag.get(playerTag) ?? null;
      const snapshotWarClanTag =
        snapshotRow?.warActive
          ? normalizeClanTag(snapshotRow.warClanTag ?? "") ||
            normalizeClanTag(snapshotRow.clanTag ?? "") ||
            null
        : null;
      const snapshotRaidClanTag = snapshotRaidClanTagByPlayerTag.get(playerTag) ?? null;
      const snapshotCwlClanTag = snapshotCwlClanTagByPlayerTag.get(playerTag) ?? null;
      const memberClanTag = clanMemberClanTagByPlayerTag.get(playerTag) ?? null;
      const warMemberClanTag = warMemberClanTagByPlayerTag.get(playerTag) ?? null;
      const rosterClanTag = trackedWarRosterClanTagByPlayerTag.get(playerTag) ?? null;

      if (snapshotWarClanTag && trackedClanTagSet.has(snapshotWarClanTag)) {
        snapshotWarContextPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (snapshotRaidClanTag && trackedRaidClanTagSet.has(snapshotRaidClanTag)) {
        snapshotRaidContextPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (snapshotClanTag && trackedRaidClanTagSet.has(snapshotClanTag)) {
        snapshotTrackedPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (memberClanTag && trackedRaidClanTagSet.has(memberClanTag)) {
        memberTrackedPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (
        warMemberClanTag &&
        trackedClanTagSet.has(warMemberClanTag) &&
        activeTrackedCurrentWarClanTagSet.has(warMemberClanTag)
      ) {
        warMemberTrackedPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (
        rosterClanTag &&
        trackedClanTagSet.has(rosterClanTag) &&
        activeTrackedCurrentWarClanTagSet.has(rosterClanTag)
      ) {
        rosterTrackedPlayerTagSet.add(playerTag);
        trackedPlayerTags.push(playerTag);
        continue;
      }
      if (snapshotCwlClanTag && cwlTrackedClanTagSet.has(snapshotCwlClanTag)) {
        trackedPlayerTags.push(playerTag);
      } else {
        nonTrackedPlayerTags.push(playerTag);
      }
    }

    const selectedPlayerTags =
      input.cadence === "tracked" ? trackedPlayerTags : nonTrackedPlayerTags;
    const producerSource =
      input.cadence === "tracked"
        ? "war_event_poll_cycle"
        : "activity_observe_cycle";
    const observedLivePlayerCurrentByTag = buildObservedLivePlayerCurrentByTag(
      input.observedLivePlayerCurrent ?? [],
    );
    const result =
      selectedPlayerTags.length > 0
        ? await this.refreshSnapshotsForPlayerTagsInternal({
            playerTags: selectedPlayerTags,
            cocService: input.cocService,
            cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
            nowMs: input.nowMs,
            includeNonTrackedCwlRefresh: input.cadence === "observe",
            observedLivePlayerCurrentByTag,
            preloadedCurrentWarSnapshotsByClanTag:
              input.preloadedCurrentWarSnapshotsByClanTag ?? null,
            trackedClanRows,
            raidTrackedClanRows,
            producer: {
              source: producerSource,
              pacingMs:
                Number.isFinite(input.producerPacingMs ?? NaN) &&
                Number(input.producerPacingMs) > 0
                  ? Math.trunc(Number(input.producerPacingMs))
                  : null,
              backlogThreshold: 250,
            },
          })
        : { playerCount: 0, updatedCount: 0 };

    const selectedPlayerCount = normalizePlayerTags(selectedPlayerTags).length;
    const trackedPlayerCount = normalizePlayerTags(trackedPlayerTags).length;
    const nonTrackedPlayerCount = normalizePlayerTags(nonTrackedPlayerTags).length;
    const activatedUserCount = activatedUserIdSet.size;
    const skippedNeverUsedUserCount = Math.max(
      0,
      totalLinkedUserIds.length - activatedUserCount,
    );
    console.info(
      `[todo-snapshot] event=todo_refresh_population_sources cadence=${input.cadence} cwl_season=${currentCwlSeason} activated_player_count=${activatedPlayerTags.length} snapshot_tracked_count=${snapshotTrackedPlayerTagSet.size} snapshot_war_context_count=${snapshotWarContextPlayerTagSet.size} snapshot_raid_context_count=${snapshotRaidContextPlayerTagSet.size} member_tracked_count=${memberTrackedPlayerTagSet.size} war_member_tracked_count=${warMemberTrackedPlayerTagSet.size} roster_tracked_count=${rosterTrackedPlayerTagSet.size} selected_player_count=${selectedPlayerCount}`,
    );
    console.info(
      `[todo-snapshot] event=todo_refresh_population cadence=${input.cadence} activated_user_count=${activatedUserCount} total_linked_user_count=${totalLinkedUserIds.length} skipped_never_used_user_count=${skippedNeverUsedUserCount} selected_player_count=${selectedPlayerCount} tracked_player_count=${trackedPlayerCount} non_tracked_player_count=${nonTrackedPlayerCount}`,
    );

    return {
      ...result,
      activatedUserCount,
      totalLinkedUserCount: totalLinkedUserIds.length,
      skippedNeverUsedUserCount,
      selectedPlayerCount,
      trackedPlayerCount,
      nonTrackedPlayerCount,
    };
  }

  /** Purpose: refresh one targeted player-tag subset with deduped in-flight locking. */
  async refreshSnapshotsForPlayerTags(input: {
    playerTags: string[];
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    nowMs?: number;
    includeNonTrackedCwlRefresh?: boolean;
    observedLivePlayerCurrent?: ObservedLivePlayerCurrent[];
    preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null>;
  }): Promise<TodoSnapshotRefreshResult> {
    const normalizedTags = normalizePlayerTags(input.playerTags);
    if (normalizedTags.length <= 0) {
      return { playerCount: 0, updatedCount: 0 };
    }

    const batchKey = [
      normalizedTags.join(","),
      input.includeNonTrackedCwlRefresh ? "nontracked-cwl" : "default",
    ].join("|");
    const existing = this.refreshByBatchKey.get(batchKey);
    if (existing) {
      return existing;
    }

    const task = this.refreshSnapshotsForPlayerTagsInternal({
      ...input,
      playerTags: normalizedTags,
      observedLivePlayerCurrentByTag: buildObservedLivePlayerCurrentByTag(
        input.observedLivePlayerCurrent ?? [],
      ),
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      preloadedCurrentWarSnapshotsByClanTag:
        input.preloadedCurrentWarSnapshotsByClanTag ?? null,
    }).finally(() => {
      this.refreshByBatchKey.delete(batchKey);
    });

    this.refreshByBatchKey.set(batchKey, task);
    return task;
  }

  /** Purpose: execute one full linked-player refresh by resolving all linked tags first. */
  private async refreshAllLinkedPlayerSnapshotsInternal(input: {
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    nowMs?: number;
    producerPacingMs?: number | null;
    observedLivePlayerCurrent?: ObservedLivePlayerCurrent[];
    preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null>;
  }): Promise<TodoSnapshotRefreshResult> {
    const links = await prisma.playerLink.findMany({
      where: { discordUserId: { not: null } },
      select: { playerTag: true },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    });

    const playerTags = links.map((row) => row.playerTag);
    if (normalizePlayerTags(playerTags).length <= 0) {
      return { playerCount: 0, updatedCount: 0 };
    }

    return this.refreshSnapshotsForPlayerTagsInternal({
      playerTags,
      cocService: input.cocService,
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      nowMs: input.nowMs,
      observedLivePlayerCurrentByTag: buildObservedLivePlayerCurrentByTag(
        input.observedLivePlayerCurrent ?? [],
      ),
      preloadedCurrentWarSnapshotsByClanTag:
        input.preloadedCurrentWarSnapshotsByClanTag ?? null,
      producer: {
        source: "war_event_poll_cycle",
        pacingMs:
          Number.isFinite(input.producerPacingMs ?? NaN) &&
          Number(input.producerPacingMs) > 0
            ? Math.trunc(Number(input.producerPacingMs))
            : null,
        backlogThreshold: 250,
      },
    });
  }

  /** Purpose: compute and persist todo snapshots for one normalized player-tag set. */
  private async refreshSnapshotsForPlayerTagsInternal(input: {
    playerTags: string[];
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    nowMs?: number;
    includeNonTrackedCwlRefresh?: boolean;
    observedLivePlayerCurrentByTag?: ObservedLivePlayerCurrentByTag;
    preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null> | null;
    trackedClanRows?: Array<{ tag: string; name: string | null }>;
    raidTrackedClanRows?: Array<{ clanTag: string; name: string | null }>;
    producer?: WarEventLinkedPlayerRefreshProducer | null;
  }): Promise<TodoSnapshotRefreshResult> {
    const normalizedTags = normalizePlayerTags(input.playerTags);
    if (normalizedTags.length <= 0) {
      return { playerCount: 0, updatedCount: 0 };
    }

    const now = Number.isFinite(input.nowMs)
      ? new Date(Number(input.nowMs))
      : new Date();
    const nowMs = now.getTime();
    const raidWindow = resolveRaidWeekendWindow(nowMs);
    const gamesWindow = resolveClanGamesWindow(nowMs);
    const gamesCycleKey = buildClanGamesCycleKey(gamesWindow.startMs);
    const currentCwlSeason = resolveCurrentCwlSeasonKey(nowMs);
    const cwlFetchCycleCache =
      input.cwlFetchCycleCache ??
      (input.includeNonTrackedCwlRefresh && input.cocService
        ? new CwlFetchCycleCache(input.cocService)
        : null);
    const observedLivePlayerCurrentByTag = input.observedLivePlayerCurrentByTag ?? new Map();
    const trackedClanRowsForDiscovery =
      input.trackedClanRows !== undefined
        ? input.trackedClanRows
        : raidWindow.active
          ? await prisma.trackedClan.findMany({
              select: { tag: true, name: true },
            })
          : [];
    const raidTrackedClanRowsForDiscovery =
      input.raidTrackedClanRows !== undefined
        ? input.raidTrackedClanRows
        : raidWindow.active
          ? await listRaidTrackedClanRows()
          : [];
    const liveClanTagByPlayerTag = await loadLiveClanTagsByPlayerTag({
      cocService: input.cocService,
      playerTags: normalizedTags,
      observedLivePlayerCurrentByTag,
      producer: input.producer ?? null,
    });

    const signalStateKeyByTag = new Map(
      normalizedTags.map((playerTag) => [
        playerTag,
        buildPlayerSignalStateKey(playerTag),
      ]),
    );
    const settingKeys = [...new Set([...signalStateKeyByTag.values()])];

    const [
      existingSnapshots,
      playerCurrentRows,
      playerCatalogRows,
      clanMemberRows,
      warMemberRows,
      settingRows,
    ] = await Promise.all([
      this.listSnapshotsByPlayerTags({ playerTags: normalizedTags }),
      loadPlayerCurrentByTags(normalizedTags),
      prisma.fwaPlayerCatalog.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: { playerTag: true, latestName: true },
      }),
      prisma.fwaClanMemberCurrent.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          clanTag: true,
          playerName: true,
          sourceSyncedAt: true,
        },
      }),
      prisma.fwaWarMemberCurrent.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          clanTag: true,
          playerName: true,
          townHall: true,
          position: true,
          attacks: true,
          sourceSyncedAt: true,
        },
      }),
      settingKeys.length > 0
        ? prisma.botSetting.findMany({
            where: { key: { in: settingKeys } },
            select: { key: true, value: true },
          })
        : Promise.resolve([]),
    ]);

    const existingByTag = new Map(existingSnapshots.map((row) => [row.playerTag, row]));
    const playerCurrentByTag = new Map<string, PlayerCurrentLike>();
    for (const [playerTag, row] of playerCurrentRows.entries()) {
      const normalizedTag = normalizePlayerTag(playerTag);
      if (!normalizedTag) continue;
      playerCurrentByTag.set(normalizedTag, row);
    }
    const latestCatalogNameByTag = new Map(
      playerCatalogRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          sanitizeDisplayText(row.latestName),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const latestClanMemberByTag = pickLatestClanMemberByPlayerTag(clanMemberRows);
    const fwaWarMemberFallbackByClanAndPlayer =
      pickLatestWarMemberByClanAndPlayer(warMemberRows);
    const settingValueByKey = new Map(
      settingRows.map((row) => [String(row.key), String(row.value)]),
    );
    const gamesChampionTotalByTag = new Map(
      normalizedTags.map((playerTag) => [
        playerTag,
        extractGamesChampionTotalFromSignalState(
          settingValueByKey.get(signalStateKeyByTag.get(playerTag) ?? ""),
        ),
      ]),
    );
    const currentMembershipByPlayerTag = new Map<string, TodoCurrentMembershipContext>();
    const cwlDiscoveryClanTagByPlayerTag = new Map<string, string | null>();
    for (const playerTag of normalizedTags) {
      const livePlayer = liveClanTagByPlayerTag.get(playerTag) ?? null;
      const observedLivePlayer = observedLivePlayerCurrentByTag.get(playerTag) ?? null;
      const playerCurrent = playerCurrentByTag.get(playerTag) ?? null;
      const fromMember = latestClanMemberByTag.get(playerTag) ?? null;
      const fromExisting = existingByTag.get(playerTag) ?? null;
      const resolvedMembership = resolveTodoCurrentMembershipContext({
        playerTag,
        now,
        liveClanTagEntry: livePlayer,
        playerCurrent,
        latestClanMember: fromMember,
        existingSnapshot: fromExisting,
      });
      currentMembershipByPlayerTag.set(playerTag, resolvedMembership);
      const pinnedCwlClanTag =
        resolvedMembership.clanTag === null
          ? normalizeClanTag(fromExisting?.cwlClanTag ?? "")
          : "";
      const currentCwlDiscoveryClanTag = normalizeClanTag(
        resolvedMembership.clanTag ??
          livePlayer?.clanTag ??
          observedLivePlayer?.clanTag ??
          "",
      );
      const cwlDiscoveryClanTag = currentCwlDiscoveryClanTag || pinnedCwlClanTag || null;
      cwlDiscoveryClanTagByPlayerTag.set(playerTag, cwlDiscoveryClanTag);
    }
    if (input.includeNonTrackedCwlRefresh) {
      try {
        await cwlStateService.refreshSeasonalCwlClanMappingsForPlayerTags({
          cocService: input.cocService,
          cwlFetchCycleCache,
          playerTags: normalizedTags,
          season: currentCwlSeason,
          candidateClanTags: [
            ...new Set(
              [...cwlDiscoveryClanTagByPlayerTag.values()].filter(
                (value): value is string => Boolean(value),
              ),
            ),
          ],
        });
      } catch (error) {
        console.warn(
          `[todo-snapshot] event=cwl_seasonal_mapping_refresh_failed season=${currentCwlSeason} player_count=${normalizedTags.length} error=${formatError(error)}`,
        );
      }
    }

    const trackedWarRosterRows: TodoTrackedWarRosterRow[] =
      normalizedTags.length > 0
        ? await prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
            where: {
              playerTag: { in: normalizedTags },
            },
            orderBy: [{ clanTag: "asc" }, { position: "asc" }, { playerTag: "asc" }],
            select: {
              clanTag: true,
              playerTag: true,
              position: true,
              playerName: true,
              townHall: true,
            },
          })
        : [];
    const activeWarRosterClanTags = [
      ...new Set(
        trackedWarRosterRows
          .map((row) => normalizeClanTag(row.clanTag))
          .filter(Boolean),
        ),
    ];
    const fallbackWarClanTags = [
      ...new Set(
        [...fwaWarMemberFallbackByClanAndPlayer.values()]
          .map((row) => normalizeClanTag(row.clanTag))
          .filter(Boolean),
      ),
    ];
    const clanTags = [
      ...new Set(
        [
          ...[...currentMembershipByPlayerTag.values()]
            .map((entry) => entry.clanTag)
            .filter((value): value is string => Boolean(value)),
          ...Array.from(existingByTag.values())
            .map((row) => normalizeClanTag(row.clanTag ?? ""))
            .filter((value): value is string => Boolean(value)),
          ...Array.from(existingByTag.values())
            .map((row) =>
              normalizeClanTag(row.warClanTag ?? "") ||
              (row.warActive ? normalizeClanTag(row.clanTag ?? "") : ""),
            )
            .filter((value): value is string => Boolean(value)),
          ...activeWarRosterClanTags,
          ...fallbackWarClanTags,
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    const clanTagSet = new Set(clanTags);
    const trackedClanRows =
      raidWindow.active || input.trackedClanRows !== undefined
        ? trackedClanRowsForDiscovery.filter((row) =>
            clanTagSet.has(normalizeClanTag(row.tag)),
          )
        : clanTags.length > 0
          ? await prisma.trackedClan.findMany({
              where: { tag: { in: clanTags } },
              select: { tag: true, name: true },
            })
          : [];
    const cwlTrackedClanRows = await prisma.cwlTrackedClan.findMany({
      where: { season: currentCwlSeason },
      select: { tag: true, name: true },
    });
    const currentCwlClanTags = [
      ...new Set(
        [
          ...cwlTrackedClanRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean),
          ...Array.from(existingByTag.values())
            .map((row) => normalizeClanTag(row.cwlClanTag ?? ""))
            .filter((value): value is string => Boolean(value)),
        ],
      ),
    ];
    const currentCwlEventRows = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags(
      {
        clanTags: currentCwlClanTags,
      },
    );
    const currentCwlEventIdByClanTag = new Map(
      [...currentCwlEventRows.entries()].map(([clanTag, event]) => [
        normalizeClanTag(clanTag),
        event.id,
      ] as const),
    );
    const currentCwlEventIds = [
      ...new Set([...currentCwlEventRows.values()].map((event) => event.id)),
    ];
    let cwlSeasonMappingRows =
      normalizedTags.length > 0 && currentCwlEventIds.length > 0
        ? await prisma.cwlPlayerClanSeason.findMany({
            where: {
              eventInstanceId: { in: currentCwlEventIds },
              playerTag: { in: normalizedTags },
            },
            select: {
              eventInstanceId: true,
              playerTag: true,
              cwlClanTag: true,
            },
          })
        : [];
    cwlSeasonMappingRows = cwlSeasonMappingRows.filter((row) => {
      const clanTag = normalizeClanTag(row.cwlClanTag ?? "");
      const eventInstanceId = String(row.eventInstanceId ?? "").trim();
      return Boolean(
        clanTag &&
          eventInstanceId &&
          currentCwlEventIdByClanTag.get(clanTag) === eventInstanceId,
      );
    });

    const [currentWarRows, currentCwlRoundRows, currentCwlMemberRows] = await Promise.all([
      clanTags.length > 0
        ? prisma.currentWar.findMany({
            where: { clanTag: { in: clanTags } },
            select: {
              clanTag: true,
              guildId: true,
              warId: true,
              state: true,
              startTime: true,
              endTime: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([]),
      currentCwlEventIds.length > 0
        ? prisma.currentCwlRound.findMany({
            where: {
              eventInstanceId: { in: currentCwlEventIds },
            },
            select: {
              eventInstanceId: true,
              clanTag: true,
              clanName: true,
              roundState: true,
              startTime: true,
              endTime: true,
            },
          })
        : Promise.resolve([]),
      currentCwlEventIds.length > 0
        ? prisma.cwlRoundMemberCurrent.findMany({
            where: {
              eventInstanceId: { in: currentCwlEventIds },
              playerTag: { in: normalizedTags },
            },
            select: {
              eventInstanceId: true,
              clanTag: true,
              playerTag: true,
              attacksUsed: true,
              attacksAvailable: true,
              subbedIn: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const trackedClanNameByTag = new Map(
      trackedClanRows
        .map((row) => [
          normalizeClanTag(row.tag),
          sanitizeDisplayText(String(row.name ?? "")),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const raidTrackedClanRows = raidTrackedClanRowsForDiscovery;
    const raidTrackedClanNameByTag = new Map(
      raidTrackedClanRows
        .map((row) => [
          normalizeClanTag(row.clanTag),
          sanitizeDisplayText(String(row.name ?? "")),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const currentWarByClanTag = pickLatestCurrentWarByClanTag(currentWarRows);
    const trackedClanTagSet = new Set(
      trackedClanRows
        .map((row) => normalizeClanTag(row.tag))
        .filter(Boolean),
    );
    const trackedWarRosterParentRows: TodoTrackedWarRosterCurrentRow[] =
      trackedClanTagSet.size > 0
        ? await prisma.fwaTrackedClanWarRosterCurrent.findMany({
            where: { clanTag: { in: [...trackedClanTagSet] } },
            select: {
              clanTag: true,
              clanName: true,
              sourceWarId: true,
              sourceWarStartTime: true,
              sourceWarEndTime: true,
              sourceWarState: true,
              sourceCurrentWarUpdatedAt: true,
              sourceUpdatedAt: true,
              observedAt: true,
            },
          })
        : [];
    const trackedWarRosterParentByClanTag = new Map(
      trackedWarRosterParentRows.map((row) => [normalizeClanTag(row.clanTag), row] as const),
    );
    const activeTrackedCurrentWarByClanTag = new Map<string, TodoTrackedCurrentWarRow>();
    for (const [clanTag, currentWar] of currentWarByClanTag.entries()) {
      if (!trackedClanTagSet.has(clanTag)) continue;
      if (!isTodoWarStateActive(currentWar.state ?? "")) continue;
      activeTrackedCurrentWarByClanTag.set(clanTag, {
        clanTag,
        warId: toFiniteIntOrNull(currentWar.warId),
        startTime: currentWar.startTime ?? null,
        state: currentWar.state ?? null,
        updatedAt: currentWar.updatedAt ?? null,
      });
    }
    const activeTrackedClanTags = [...activeTrackedCurrentWarByClanTag.keys()];
    const rosterCurrentRows: TodoTrackedWarRosterCurrentRow[] =
      activeTrackedClanTags.length > 0
        ? await prisma.fwaTrackedClanWarRosterCurrent.findMany({
            where: { clanTag: { in: activeTrackedClanTags } },
            select: {
              clanTag: true,
              clanName: true,
              sourceWarId: true,
              sourceWarStartTime: true,
              sourceWarEndTime: true,
              sourceWarState: true,
              sourceCurrentWarUpdatedAt: true,
              sourceUpdatedAt: true,
              observedAt: true,
            },
          })
        : [];
    const rosterCurrentClanTagSet = new Set(
      rosterCurrentRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean),
    );
    const activeTrackedWarRosterRows = trackedWarRosterRows.filter((row) => {
      const clanTag = normalizeClanTag(row.clanTag);
      return Boolean(clanTag && activeTrackedCurrentWarByClanTag.has(clanTag));
    });
    const activeTrackedWarRosterByClanAndPlayer = new Map(
      activeTrackedWarRosterRows.map((row) => [
        `${normalizeClanTag(row.clanTag)}:${normalizePlayerTag(row.playerTag)}`,
        row,
      ] as const),
    );
    const trackedWarAttackRows: WarAttacksRow[] =
      activeTrackedClanTags.length > 0
        ? await prisma.warAttacks.findMany({
            where: {
              clanTag: { in: activeTrackedClanTags },
              playerTag: { in: normalizedTags },
            },
            select: {
              warId: true,
              clanTag: true,
              warStartTime: true,
              playerTag: true,
              playerPosition: true,
              attacksUsed: true,
              attackOrder: true,
              attackNumber: true,
              defenderPosition: true,
              stars: true,
              attackSeenAt: true,
            },
          })
        : [];
    const activeTrackedWarMemberByClanAndTag = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: activeTrackedCurrentWarByClanTag,
      rosterRows: activeTrackedWarRosterRows,
      warAttackRows: trackedWarAttackRows,
    });
    const trackedWarRosterDriftDiagnostics = buildTrackedWarRosterDriftDiagnostics({
      activeTrackedCurrentWarByClanTag,
      rosterCurrentClanTagSet,
      rawWarMemberByClanAndPlayer: fwaWarMemberFallbackByClanAndPlayer,
      derivedWarRosterByClanAndPlayer: activeTrackedWarRosterByClanAndPlayer,
    });
    for (const diagnostic of trackedWarRosterDriftDiagnostics) {
      console.warn(
        `[todo-snapshot] event=tracked_war_roster_drift clanTag=${diagnostic.clanTag} rawMemberCount=${diagnostic.rawMemberCount} derivedMemberCount=${diagnostic.derivedMemberCount} missingDerivedMemberCount=${diagnostic.missingDerivedMemberCount} rosterCurrentExists=${diagnostic.rosterCurrentExists} currentWarState=${diagnostic.currentWarState} missingDerivedMemberSampleTags=${diagnostic.missingDerivedMemberSampleTags.length > 0 ? diagnostic.missingDerivedMemberSampleTags.join(",") : "none"}`,
      );
    }
    const trackedWarRosterCandidateRowsByPlayerTag = new Map<
      string,
      TodoTrackedWarRosterCandidateRow[]
    >();
    for (const row of trackedWarRosterRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!clanTag || !playerTag) continue;
      const parent = trackedWarRosterParentByClanTag.get(clanTag) ?? null;
      if (!parent) continue;
      const currentWar = currentWarByClanTag.get(clanTag) ?? null;
      const candidateRow: TodoTrackedWarRosterCandidateRow = {
        clanTag,
        playerTag,
        position: toFiniteIntOrNull(row.position) ?? 0,
        playerName: row.playerName,
        townHall: toFiniteIntOrNull(row.townHall),
        parent,
        identityMatch: classifyTrackedWarRosterCurrentIdentity({
          roster: parent,
          currentWar,
        }),
      };
      const playerRows = trackedWarRosterCandidateRowsByPlayerTag.get(playerTag) ?? [];
      playerRows.push(candidateRow);
      trackedWarRosterCandidateRowsByPlayerTag.set(playerTag, playerRows);
    }
    const warOwnerCandidateEntriesByPlayerTag = new Map<
      string,
      Map<string, WarOwnerCandidateEntry>
    >();
    for (const row of trackedWarRosterRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag) continue;
      const candidateRows = trackedWarRosterCandidateRowsByPlayerTag.get(row.playerTag) ?? [];
      const candidate = candidateRows.find((entry) => entry.clanTag === clanTag) ?? null;
      if (!candidate || candidate.identityMatch !== "LEGACY_UNSCOPED") continue;
      addWarOwnerCandidateEntry({
        byPlayerTag: warOwnerCandidateEntriesByPlayerTag,
        playerTag: row.playerTag,
        clanTag,
        source: "legacy_roster",
        currentWarUpdatedAt: currentWarByClanTag.get(clanTag)?.updatedAt ?? null,
        currentWarWarId: currentWarByClanTag.get(clanTag)?.warId ?? null,
        clanName: trackedClanNameByTag.get(clanTag) ?? raidTrackedClanNameByTag.get(clanTag) ?? null,
      });
    }
    for (const row of fwaWarMemberFallbackByClanAndPlayer.values()) {
      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag || !activeTrackedCurrentWarByClanTag.has(clanTag)) continue;
      addWarOwnerCandidateEntry({
        byPlayerTag: warOwnerCandidateEntriesByPlayerTag,
        playerTag: row.playerTag,
        clanTag,
        source: "raw_war_member",
        currentWarUpdatedAt: currentWarByClanTag.get(clanTag)?.updatedAt ?? null,
        currentWarWarId: currentWarByClanTag.get(clanTag)?.warId ?? null,
        clanName: trackedClanNameByTag.get(clanTag) ?? raidTrackedClanNameByTag.get(clanTag) ?? null,
      });
    }
    for (const playerTag of normalizedTags) {
      const existingSnapshot = existingByTag.get(playerTag) ?? null;
      const legacyWarHintClanTag =
        normalizeClanTag(existingSnapshot?.warClanTag ?? "") ||
        (existingSnapshot?.warActive
          ? normalizeClanTag(existingSnapshot?.clanTag ?? "")
          : null);
      if (
        legacyWarHintClanTag &&
        trackedClanTagSet.has(legacyWarHintClanTag) &&
        activeTrackedCurrentWarByClanTag.has(legacyWarHintClanTag)
      ) {
        addWarOwnerCandidateEntry({
          byPlayerTag: warOwnerCandidateEntriesByPlayerTag,
          playerTag,
          clanTag: legacyWarHintClanTag,
          source: "snapshot_hint",
          currentWarUpdatedAt:
            currentWarByClanTag.get(legacyWarHintClanTag)?.updatedAt ?? null,
          currentWarWarId:
            currentWarByClanTag.get(legacyWarHintClanTag)?.warId ?? null,
          clanName:
            sanitizeDisplayText(existingSnapshot?.warClanName ?? "") ||
            sanitizeDisplayText(existingSnapshot?.clanName ?? "") ||
            trackedClanNameByTag.get(legacyWarHintClanTag) ||
            raidTrackedClanNameByTag.get(legacyWarHintClanTag) ||
            null,
        });
      }
    }
    for (const [playerTag, membershipContext] of currentMembershipByPlayerTag.entries()) {
      const currentMembershipClanTag = normalizeClanTag(membershipContext.clanTag ?? "");
      if (
        !currentMembershipClanTag ||
        !trackedClanTagSet.has(currentMembershipClanTag) ||
        !activeTrackedCurrentWarByClanTag.has(currentMembershipClanTag)
      ) {
        continue;
      }
      addWarOwnerCandidateEntry({
        byPlayerTag: warOwnerCandidateEntriesByPlayerTag,
        playerTag,
        clanTag: currentMembershipClanTag,
        source: "current_membership",
        currentWarUpdatedAt: currentWarByClanTag.get(currentMembershipClanTag)?.updatedAt ?? null,
        currentWarWarId: currentWarByClanTag.get(currentMembershipClanTag)?.warId ?? null,
        clanName: membershipContext.clanName ?? null,
      });
    }
    const warOwnerVerificationClanTags = new Set<string>();
    const liveFallbackPlayerTags = new Set<string>([
      ...existingByTag.keys(),
      ...currentMembershipByPlayerTag.keys(),
      ...latestClanMemberByTag.keys(),
      ...playerCurrentByTag.keys(),
      ...trackedWarRosterCandidateRowsByPlayerTag.keys(),
    ]);
    for (const playerTag of liveFallbackPlayerTags) {
      const candidateRows = trackedWarRosterCandidateRowsByPlayerTag.get(playerTag) ?? [];
      const existingSnapshot = existingByTag.get(playerTag) ?? null;
      const rawWarMemberClanTagsForPlayer = new Set(
        [...fwaWarMemberFallbackByClanAndPlayer.values()]
          .filter((row) => normalizePlayerTag(row.playerTag) === playerTag)
          .map((row) => normalizeClanTag(row.clanTag))
          .filter((clanTag): clanTag is string => Boolean(clanTag)),
      );
      const candidateClanTags = new Set<string>();
      const liveFallbackClanTags = new Set<string>();
      const exactFallbackClanTags = new Set<string>();
      for (const candidateRow of candidateRows) {
        candidateClanTags.add(candidateRow.clanTag);
        if (
          candidateRow.identityMatch === "EXACT_WAR_ID" ||
          candidateRow.identityMatch === "EXACT_START_TIME"
        ) {
          const currentWar = currentWarByClanTag.get(candidateRow.clanTag) ?? null;
          const renderState = resolveTrackedWarRosterRenderState({
            roster: candidateRow.parent,
            currentWar,
            existingSnapshot,
            identityMatch: candidateRow.identityMatch,
          });
          if (renderState === "ACTIVE" || renderState === "RETAINED_ENDED") {
            exactFallbackClanTags.add(candidateRow.clanTag);
          }
        }
      }
      const snapshotClanTag = normalizeClanTag(
        existingSnapshot?.warClanTag ?? existingSnapshot?.clanTag ?? "",
      );
      if (
        existingSnapshot?.warActive === true &&
        normalizeTodoWarOwnerSource(existingSnapshot?.warOwnerSource ?? "NONE") ===
          "PERSISTED_FALLBACK" &&
        existingSnapshot?.warOwnerWarId === null &&
        existingSnapshot?.warOwnerVerifiedAt === null &&
        snapshotClanTag &&
        trackedClanTagSet.has(snapshotClanTag)
      ) {
        const currentWar = currentWarByClanTag.get(snapshotClanTag) ?? null;
        if (currentWar && isTodoWarStateActive(currentWar.state)) {
          warOwnerVerificationClanTags.add(snapshotClanTag);
        }
        continue;
      }
      if (snapshotClanTag) {
        candidateClanTags.add(snapshotClanTag);
        liveFallbackClanTags.add(snapshotClanTag);
      }
      const membershipClanTag = normalizeClanTag(
        currentMembershipByPlayerTag.get(playerTag)?.clanTag ?? "",
      );
      if (membershipClanTag && trackedClanTagSet.has(membershipClanTag)) {
        candidateClanTags.add(membershipClanTag);
        liveFallbackClanTags.add(membershipClanTag);
      }
      const latestClanTag = normalizeClanTag(latestClanMemberByTag.get(playerTag)?.clanTag ?? "");
      if (latestClanTag && trackedClanTagSet.has(latestClanTag)) {
        candidateClanTags.add(latestClanTag);
        liveFallbackClanTags.add(latestClanTag);
      }
      const playerCurrentClanTag = normalizeClanTag(
        playerCurrentByTag.get(playerTag)?.currentClanTag ?? "",
      );
      if (playerCurrentClanTag && trackedClanTagSet.has(playerCurrentClanTag)) {
        candidateClanTags.add(playerCurrentClanTag);
        liveFallbackClanTags.add(playerCurrentClanTag);
      }

      const suppressLegacyFetchForVerifiedContinuity =
        existingSnapshot?.warActive === true &&
        normalizeTodoWarOwnerSource(existingSnapshot?.warOwnerSource ?? "NONE") === "LIVE_VERIFIED" &&
        snapshotClanTag !== "" &&
        candidateRows.length > 0 &&
        candidateRows.every((candidateRow) => candidateRow.identityMatch === "LEGACY_UNSCOPED");
      if (suppressLegacyFetchForVerifiedContinuity) {
        continue;
      }
      const applicableExactCandidateRows = candidateRows.filter((candidateRow) => {
        if (
          candidateRow.identityMatch !== "EXACT_WAR_ID" &&
          candidateRow.identityMatch !== "EXACT_START_TIME"
        ) {
          return false;
        }
        const currentWar = currentWarByClanTag.get(candidateRow.clanTag) ?? null;
        const renderState = resolveTrackedWarRosterRenderState({
          roster: candidateRow.parent,
          currentWar,
          existingSnapshot,
          identityMatch: candidateRow.identityMatch,
        });
        return renderState === "ACTIVE" || renderState === "RETAINED_ENDED";
      });
      if (applicableExactCandidateRows.length > 0) {
        continue;
      }
      const fetchClanTags = new Set([
        ...liveFallbackClanTags,
        ...exactFallbackClanTags,
      ]);
      const rawFallbackCoversAllCandidateClans =
        fetchClanTags.size > 0 &&
        [...fetchClanTags].every((clanTag) => rawWarMemberClanTagsForPlayer.has(clanTag));
      const hasNonLegacyCandidate = candidateRows.some(
        (candidateRow) => candidateRow.identityMatch !== "LEGACY_UNSCOPED",
      );
      if (rawFallbackCoversAllCandidateClans && hasNonLegacyCandidate) {
        continue;
      }
      if (candidateClanTags.size > 0) {
        if (hasNonLegacyCandidate) {
          const weakOutsideCandidateClanTags = [...candidateClanTags].filter((clanTag) => {
            if (
              candidateRows.some(
                (candidateRow) =>
                  candidateRow.clanTag === clanTag &&
                  candidateRow.identityMatch !== "LEGACY_UNSCOPED",
              )
            ) {
              return false;
            }
            const currentWar = currentWarByClanTag.get(clanTag) ?? null;
            return Boolean(currentWar && isTodoWarStateActive(currentWar.state));
          });
          if (weakOutsideCandidateClanTags.length === 0) {
            continue;
          }
        }
      }
      for (const candidateRow of candidateRows) {
        const trackedWarMemberKey = `${candidateRow.clanTag}:${playerTag}`;
        if (activeTrackedWarMemberByClanAndTag.has(trackedWarMemberKey)) {
          continue;
        }
        const currentWar = currentWarByClanTag.get(candidateRow.clanTag) ?? null;
        if (!currentWar || !isTodoWarStateActive(currentWar.state)) {
          continue;
        }
        const renderState = resolveTrackedWarRosterRenderState({
          roster: candidateRow.parent,
          currentWar,
          existingSnapshot,
          identityMatch: candidateRow.identityMatch,
        });
        if (renderState === "INACTIVE") {
          continue;
        }
        if (rawWarMemberClanTagsForPlayer.has(candidateRow.clanTag)) {
          continue;
        }
        warOwnerVerificationClanTags.add(candidateRow.clanTag);
      }
      for (const clanTag of candidateClanTags) {
        const currentWar = currentWarByClanTag.get(clanTag) ?? null;
        if (!currentWar || !isTodoWarStateActive(currentWar.state)) continue;
        const trackedWarMemberKey = `${clanTag}:${playerTag}`;
        if (activeTrackedWarMemberByClanAndTag.has(trackedWarMemberKey)) {
          continue;
        }
        if (rawWarMemberClanTagsForPlayer.has(clanTag)) {
          continue;
        }
        warOwnerVerificationClanTags.add(clanTag);
      }
    }
    const liveCurrentWarFallbackByClanTag = await loadLiveCurrentWarFallbackContextsByClanTag({
      cocService: input.cocService,
      clanTags: [...warOwnerVerificationClanTags],
      preloadedCurrentWarSnapshotsByClanTag:
        input.preloadedCurrentWarSnapshotsByClanTag ?? null,
      producer: input.producer ?? null,
    });
    const liveCurrentWarFallbackUsageByClanTag = new Map<string, Set<string>>();
    for (const [playerTag, candidateEntriesByClanTag] of warOwnerCandidateEntriesByPlayerTag.entries()) {
      for (const clanTag of candidateEntriesByClanTag.keys()) {
        const context = liveCurrentWarFallbackByClanTag.get(clanTag) ?? null;
        if (!context || !context.membersByPlayerTag.has(playerTag)) continue;
        const candidateTags = liveCurrentWarFallbackUsageByClanTag.get(clanTag) ?? new Set<string>();
        candidateTags.add(playerTag);
        liveCurrentWarFallbackUsageByClanTag.set(clanTag, candidateTags);
      }
    }
    for (const [clanTag, candidateTags] of liveCurrentWarFallbackUsageByClanTag.entries()) {
      const context = liveCurrentWarFallbackByClanTag.get(clanTag) ?? null;
      if (!context || candidateTags.size <= 0) continue;
      console.info(
        `[todo-snapshot] event=todo_live_current_war_roster_fallback_used clanTag=${clanTag} currentWarState=${context.currentWarState} linkedCandidateCount=${candidateTags.size} matchedRosterCount=${candidateTags.size} missingRosterCount=0 source=live_current_war sampleTags=${[...candidateTags].slice(0, 3).join(",") || "none"}`,
      );
    }
    const cwlTrackedTagSet = new Set(
      cwlTrackedClanRows
        .map((row) => normalizeClanTag(row.tag))
        .filter(Boolean),
    );
    const cwlTrackedClanNameByTag = new Map(
      cwlTrackedClanRows
        .map((row) => [
          normalizeClanTag(row.tag),
          sanitizeDisplayText(String(row.name ?? "")),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const mappedCwlClanByPlayerTag = new Map(
      cwlSeasonMappingRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          normalizeClanTag(row.cwlClanTag),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const liveNonTrackedCwlContextByClanTag = input.includeNonTrackedCwlRefresh
      ? await loadLiveNonTrackedCwlContextsByClanTag({
          cocService: input.cocService,
          cwlFetchCycleCache,
          clanTags: [
            ...new Set(
              [
                ...cwlDiscoveryClanTagByPlayerTag.values(),
                ...mappedCwlClanByPlayerTag.values(),
              ].filter(
                (value): value is string =>
                  Boolean(value && !cwlTrackedTagSet.has(value)),
              ),
            ),
          ],
        })
      : new Map<string, LiveCwlClanContext>();
    const currentCwlRoundByClanTag = new Map(
      currentCwlRoundRows
        .map((row) => [
          normalizeClanTag(row.clanTag),
          {
            clanTag: normalizeClanTag(row.clanTag),
            clanName: sanitizeDisplayText(String(row.clanName ?? "")) || null,
            roundState: row.roundState,
            startTime: row.startTime ?? null,
            endTime: row.endTime ?? null,
          },
        ] as const)
        .filter(
          (
            entry,
          ): entry is [
            string,
            {
              clanTag: string;
              clanName: string | null;
              roundState: string;
              startTime: Date | null;
              endTime: Date | null;
            },
          ] => Boolean(entry[0]),
        ),
    );
    const currentCwlMemberByPlayerTag = new Map(
      currentCwlMemberRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          {
            clanTag: normalizeClanTag(row.clanTag),
            attacksUsed: clampInt(row.attacksUsed, 0, 1),
            attacksAvailable: Math.max(0, clampInt(row.attacksAvailable, 0, 1)),
            subbedIn: Boolean(row.subbedIn),
          },
        ] as const)
        .filter(
          (
            entry,
          ): entry is [
            string,
            {
              clanTag: string;
              attacksUsed: number;
              attacksAvailable: number;
              subbedIn: boolean;
            },
          ] => Boolean(entry[0] && entry[1].clanTag),
        ),
    );
    const raidCandidateClanEntriesByPlayerTag = buildRaidCandidateClanEntriesByPlayerTag({
      playerTags: normalizedTags,
      currentMembershipByPlayerTag,
      existingByTag,
      trackedClanRows: trackedClanRowsForDiscovery,
      raidTrackedClanRows: raidTrackedClanRowsForDiscovery,
    });
    const liveRaidContextLookup = await loadLiveRaidContextByPlayerTag({
      cocService: input.cocService,
      raidWindow,
      candidateClanEntriesByPlayerTag: raidCandidateClanEntriesByPlayerTag,
    });
    const liveRaidContextByPlayerTag = liveRaidContextLookup.byPlayerTag;

    const snapshotUpserts: TodoSnapshotWriteOperation[] = [];
    let raidActiveTrueCount = 0;
    let raidActiveFalseCount = 0;
    let raidObservedCount = 0;
    let raidPreservedUnavailableCount = 0;
    let raidPreservedFailedCount = 0;
    let raidAuthoritativeClearCount = 0;
    let raidExpiredContextClearCount = 0;
    const fallbackWarMemberUsedClanTags = new Set<string>();
    const fallbackWarMemberUsedPlayerTags = new Set<string>();
    const currentMembershipSourceCounts = new Map<string, number>();
    const warSourceCounts = new Map<string, number>();
    let missingWarPositionCount = 0;
    let trackedRosterAuthoritativeCount = 0;
    let trackedRosterLegacyFallbackCount = 0;
    let trackedRosterStaleIdentityRejectedCount = 0;
    let trackedRosterInactiveRejectedCount = 0;
    let trackedRosterAmbiguousCount = 0;
    let trackedRosterOwnerCorrectedCount = 0;
    let trackedRosterRetainedEndedCount = 0;
    let trackedRosterCanonicalWriteCount = 0;
    let trackedRosterCanonicalWriteSuppressedStaleCount = 0;
    let trackedRosterPreloadedLiveConfirmedCount = 0;
    let trackedRosterPreloadedLiveRejectedCount = 0;
    const trackedRosterAmbiguousSamples: string[] = [];
    const trackedRosterCorrectionSamples: string[] = [];
    const trackedRosterCanonicalWriteSuppressedSamples: string[] = [];
    let warOwnerResolutionPlayerCount = 0;
    let warOwnerResolutionMultiplePersistedCount = 0;
    let warOwnerResolutionLiveConfirmedCount = 0;
    let warOwnerResolutionStaleCorrectionCount = 0;
    let warOwnerResolutionDegradedFallbackCount = 0;
    let warOwnerResolutionAuthoritativeClearCount = 0;
    let warOwnerResolutionAmbiguousLiveCount = 0;
    let warOwnerResolutionUnresolvedCount = 0;
    let verifiedContinuityPreservedCount = 0;
    let lowerConfidenceWriteSuppressedCount = 0;
    let staleWriteSuppressedCount = 0;
    let verifiedOwnerReplacedCount = 0;
    let verifiedOwnerClearedCount = 0;
    const warOwnerResolutionAmbiguousSamples: string[] = [];

    for (const playerTag of normalizedTags) {
      const existing = existingByTag.get(playerTag) ?? null;
      const latestClanMember = latestClanMemberByTag.get(playerTag) ?? null;
      const membershipContext =
        currentMembershipByPlayerTag.get(playerTag) ??
        ({
          clanTag: null,
          clanName: null,
          observedAt: null,
          fresh: false,
          source: "none",
        } satisfies TodoCurrentMembershipContext);
      const currentMembershipClanTag = membershipContext.clanTag;
      const observedLivePlayer = input.observedLivePlayerCurrentByTag?.get(playerTag) ?? null;
      const resolvedClanTag = currentMembershipClanTag;
      const existingClanTag = normalizeClanTag(existing?.clanTag ?? "");
      const existingClanName =
        resolvedClanTag && existingClanTag === resolvedClanTag
          ? sanitizeDisplayText(existing?.clanName ?? "") || null
          : null;
      const resolvedClanName =
        (resolvedClanTag ? membershipContext.clanName : null) ||
        (resolvedClanTag ? sanitizeDisplayText(observedLivePlayer?.clanName ?? "") || null : null) ||
        (resolvedClanTag ? trackedClanNameByTag.get(resolvedClanTag) : null) ||
        (resolvedClanTag ? raidTrackedClanNameByTag.get(resolvedClanTag) : null) ||
        existingClanName ||
        null;
      const raidContext = liveRaidContextByPlayerTag.get(playerTag) ?? {
        status: "unavailable" as const,
        raidClanTag: null,
        raidClanName: null,
        attacksUsed: 0,
      };
      const preserveExistingRaidData =
        Boolean(existing?.raidActive) &&
        existing?.raidEndsAt instanceof Date &&
        existing.raidEndsAt.getTime() === raidWindow.endMs;
      const preservedRaidData: TodoRaidSnapshotState = {
        raidActive: existing?.raidActive ?? false,
        raidClanTag: existing?.raidClanTag ?? null,
        raidClanName: existing?.raidClanName ?? null,
        raidAttacksUsed: clampInt(existing?.raidAttacksUsed ?? 0, 0, 6),
        raidAttacksMax: clampInt(existing?.raidAttacksMax ?? 6, 0, 6) || 6,
        raidEndsAt: existing?.raidEndsAt ?? null,
        raidSourceUpdatedAt:
          existing?.raidSourceUpdatedAt ??
          existing?.lastUpdatedAt ??
          existing?.updatedAt ??
          now,
      };
      const clearedRaidData: TodoRaidSnapshotState = {
        raidActive: false,
        raidClanTag: null,
        raidClanName: null,
        raidAttacksUsed: 0,
        raidAttacksMax: 6,
        raidEndsAt: null,
        raidSourceUpdatedAt: now,
      };
      let raidSnapshotData: TodoRaidSnapshotState = clearedRaidData;
      if (raidWindow.active) {
        if (raidContext.status === "observed") {
          raidObservedCount += 1;
          if (raidContext.raidClanTag) {
            raidSnapshotData = {
              raidActive: true,
              raidClanTag: raidContext.raidClanTag,
              raidClanName: raidContext.raidClanName,
              raidAttacksUsed: clampInt(raidContext.attacksUsed, 0, 6),
              raidAttacksMax: 6,
              raidEndsAt: new Date(raidWindow.endMs),
              raidSourceUpdatedAt: now,
            };
          } else {
            raidSnapshotData = clearedRaidData;
            raidAuthoritativeClearCount += 1;
          }
        } else if (raidContext.status === "unavailable") {
          if (preserveExistingRaidData) {
            raidSnapshotData = preservedRaidData;
            if (existing?.raidActive) {
              raidPreservedUnavailableCount += 1;
            }
          } else {
            raidSnapshotData = clearedRaidData;
            if (existing?.raidActive) {
              raidExpiredContextClearCount += 1;
            }
          }
        } else {
          if (preserveExistingRaidData) {
            raidSnapshotData = preservedRaidData;
            if (existing?.raidActive) {
              raidPreservedFailedCount += 1;
            }
          } else {
            raidSnapshotData = clearedRaidData;
            if (existing?.raidActive) {
              raidExpiredContextClearCount += 1;
            }
          }
        }
      }
      const canonicalRosterCandidateRows =
        trackedWarRosterCandidateRowsByPlayerTag.get(playerTag) ?? [];
      const canonicalRosterResolution = resolveCanonicalTrackedWarRosterOwnerForPlayer({
        playerTag,
        candidateRows: canonicalRosterCandidateRows,
        existingSnapshot: existing ?? null,
        currentWarByClanTag,
        preloadedCurrentWarSnapshotsByClanTag:
          input.preloadedCurrentWarSnapshotsByClanTag ?? new Map(),
      });
      trackedRosterLegacyFallbackCount += canonicalRosterResolution.legacyFallbackCount;
      trackedRosterStaleIdentityRejectedCount += canonicalRosterResolution.staleIdentityRejectedCount;
      trackedRosterInactiveRejectedCount += canonicalRosterResolution.inactiveRejectedCount;
      trackedRosterAmbiguousCount += canonicalRosterResolution.ambiguousCount;
      trackedRosterPreloadedLiveConfirmedCount +=
        canonicalRosterResolution.preloadedLiveConfirmedCount;
      trackedRosterPreloadedLiveRejectedCount +=
        canonicalRosterResolution.preloadedLiveRejectedCount;
      if (canonicalRosterResolution.selectedCandidate) {
        trackedRosterAuthoritativeCount += 1;
        if (canonicalRosterResolution.selectedRenderState === "RETAINED_ENDED") {
          trackedRosterRetainedEndedCount += 1;
        }
        const existingOwnerClanTag = normalizeClanTag(existing?.warClanTag ?? existing?.clanTag ?? "");
        if (
          existingOwnerClanTag &&
          existingOwnerClanTag !== canonicalRosterResolution.selectedCandidate.clanTag
        ) {
          trackedRosterOwnerCorrectedCount += 1;
          if (trackedRosterCorrectionSamples.length < 5) {
            trackedRosterCorrectionSamples.push(
              [
                `player_tag=${playerTag}`,
                `existing_owner=${existingOwnerClanTag}`,
                `selected_roster_owner=${canonicalRosterResolution.selectedCandidate.clanTag}`,
                `roster_war_id=${
                  canonicalRosterResolution.selectedCandidate.parent.sourceWarId ?? "none"
                }`,
                `roster_start_time=${
                  canonicalRosterResolution.selectedCandidate.parent.sourceWarStartTime?.toISOString() ??
                  "none"
                }`,
                `retained_state=${canonicalRosterResolution.selectedRenderState ?? "INACTIVE"}`,
                `parent_source_updated_at=${
                  canonicalRosterResolution.selectedCandidate.parent.sourceUpdatedAt?.toISOString() ??
                  "none"
                }`,
                `parent_observed_at=${
                  canonicalRosterResolution.selectedCandidate.parent.observedAt?.toISOString() ??
                  "none"
                }`,
                `parent_current_war_updated_at=${
                  canonicalRosterResolution.selectedCandidate.parent.sourceCurrentWarUpdatedAt?.toISOString() ??
                  "none"
                }`,
              ].join(" "),
            );
          }
        }
      } else if (canonicalRosterResolution.ambiguousCount > 0) {
        if (trackedRosterAmbiguousSamples.length < 5) {
          const sampleCandidate = canonicalRosterCandidateRows[0] ?? null;
          trackedRosterAmbiguousSamples.push(
            [
              `player_tag=${playerTag}`,
              `existing_owner=${normalizeClanTag(existing?.warClanTag ?? existing?.clanTag ?? "") || "none"}`,
              `selected_roster_owner=${sampleCandidate?.clanTag ?? "none"}`,
              `roster_war_id=${sampleCandidate?.parent.sourceWarId ?? "none"}`,
              `roster_start_time=${sampleCandidate?.parent.sourceWarStartTime?.toISOString() ?? "none"}`,
              `retained_state=ambiguous`,
              `parent_source_updated_at=${sampleCandidate?.parent.sourceUpdatedAt?.toISOString() ?? "none"}`,
              `parent_observed_at=${sampleCandidate?.parent.observedAt?.toISOString() ?? "none"}`,
              `parent_current_war_updated_at=${sampleCandidate?.parent.sourceCurrentWarUpdatedAt?.toISOString() ?? "none"}`,
            ].join(" "),
          );
        }
      }

      const warOwnerCandidateEntriesByClanTag =
        warOwnerCandidateEntriesByPlayerTag.get(playerTag) ?? new Map();
      const canonicalRosterHasApplicableExactCandidates =
        canonicalRosterResolution.applicableExactCandidateCount > 0;
      const canonicalRosterSelectedCandidate =
        canonicalRosterResolution.resolvedSource !== "unresolved"
          ? canonicalRosterResolution.selectedCandidate
          : null;
      const canonicalLegacyAuthoritativeClear =
        !canonicalRosterHasApplicableExactCandidates &&
        canonicalRosterResolution.resolvedSource === "authoritative_clear";
      const canonicalRosterSelectedRenderState = canonicalRosterSelectedCandidate
        ? resolveTrackedWarRosterRenderState({
            roster: canonicalRosterSelectedCandidate.parent,
            currentWar: currentWarByClanTag.get(canonicalRosterSelectedCandidate.clanTag) ?? null,
            existingSnapshot: existing ?? null,
            identityMatch: canonicalRosterSelectedCandidate.identityMatch,
          })
        : "INACTIVE";
      const genericWarOwnerResolution =
        canonicalRosterHasApplicableExactCandidates || canonicalLegacyAuthoritativeClear
          ? null
          : resolveWarOwnerForPlayer({
              playerTag,
              candidateEntriesByClanTag: warOwnerCandidateEntriesByClanTag,
              liveCurrentWarFallbackByClanTag,
            });
      const rawWarMemberClanTagsForPlayer = new Set(
        [...fwaWarMemberFallbackByClanAndPlayer.values()]
          .filter((row) => normalizePlayerTag(row.playerTag) === playerTag)
          .map((row) => normalizeClanTag(row.clanTag))
          .filter((clanTag): clanTag is string => Boolean(clanTag)),
      );
      const existingBootstrapWarClanTag = normalizeClanTag(existing?.warClanTag ?? "");
      const existingBootstrapProtectedFallback =
        existing !== null &&
        normalizeTodoWarOwnerSource(existing?.warOwnerSource ?? "NONE") ===
          "PERSISTED_FALLBACK" &&
        existing.warActive === true &&
        existingBootstrapWarClanTag !== "" &&
        existing?.warOwnerWarId === null &&
        existing?.warOwnerVerifiedAt === null &&
        Boolean(
          currentWarByClanTag.get(existingBootstrapWarClanTag) &&
            isTodoWarStateActive(currentWarByClanTag.get(existingBootstrapWarClanTag)?.state),
        );
      const canonicalRosterLiveCurrentWarFallbackContext =
        canonicalRosterSelectedCandidate &&
        (
          !(rawWarMemberClanTagsForPlayer.has(canonicalRosterSelectedCandidate.clanTag))
        )
          ? buildPreloadedLiveCurrentWarFallbackContextsByClanTag({
              clanTags: [canonicalRosterSelectedCandidate.clanTag],
              preloadedCurrentWarSnapshotsByClanTag:
                input.preloadedCurrentWarSnapshotsByClanTag ?? new Map(),
            }).get(canonicalRosterSelectedCandidate.clanTag) ?? null
          : null;
      const canonicalWarOwnerResolution =
        canonicalRosterSelectedCandidate
          ? canonicalRosterResolution.resolvedSource === "unresolved"
            ? {
                resolvedClanTag: null,
                resolvedSource: "unresolved" as const,
                selectedCandidate: null,
                candidateCount: canonicalRosterResolution.applicableExactCandidateCount,
                persistedFallbackCandidate: null,
                liveCurrentWarFallbackContext: null,
                liveCurrentWarFallbackMember: null,
                ambiguousLiveMatchCount: canonicalRosterResolution.ambiguousCount,
              }
            : {
                resolvedClanTag: canonicalRosterResolution.resolvedClanTag,
                resolvedSource: canonicalRosterResolution.resolvedSource,
                selectedCandidate: canonicalRosterSelectedCandidate,
                candidateCount: canonicalRosterResolution.applicableExactCandidateCount,
                persistedFallbackCandidate: null,
                liveCurrentWarFallbackContext: canonicalRosterLiveCurrentWarFallbackContext,
                liveCurrentWarFallbackMember: canonicalRosterSelectedCandidate
                  ? canonicalRosterLiveCurrentWarFallbackContext?.membersByPlayerTag.get(playerTag) ??
                    null
                  : null,
                ambiguousLiveMatchCount: canonicalRosterResolution.ambiguousCount,
              }
            : canonicalLegacyAuthoritativeClear
            ? {
                resolvedClanTag: null,
                resolvedSource: "authoritative_clear" as const,
                selectedCandidate: null,
                candidateCount: canonicalRosterResolution.applicableExactCandidateCount,
                persistedFallbackCandidate: null,
                liveCurrentWarFallbackContext: null,
                liveCurrentWarFallbackMember: null,
                ambiguousLiveMatchCount: canonicalRosterResolution.ambiguousCount,
              }
            : null;
      const preferGenericWarOwnerResolution =
        canonicalWarOwnerResolution !== null &&
        genericWarOwnerResolution !== null &&
        canonicalWarOwnerResolution.resolvedSource === "persisted_fallback" &&
        (genericWarOwnerResolution.resolvedSource === "live_verified" ||
          genericWarOwnerResolution.resolvedSource === "authoritative_clear");
      const warOwnerResolution =
        preferGenericWarOwnerResolution
          ? genericWarOwnerResolution!
          : canonicalWarOwnerResolution ?? genericWarOwnerResolution!;
      const guardedWarOwnerResolution =
        existingBootstrapProtectedFallback &&
              warOwnerResolution.resolvedSource === "persisted_fallback" &&
              normalizeClanTag(warOwnerResolution.resolvedClanTag ?? "") !== existingBootstrapWarClanTag
            ? {
                resolvedClanTag: null,
                resolvedSource: "unresolved" as const,
                selectedCandidate: null,
                candidateCount: warOwnerResolution.candidateCount,
                persistedFallbackCandidate: warOwnerResolution.persistedFallbackCandidate,
                liveCurrentWarFallbackContext: warOwnerResolution.liveCurrentWarFallbackContext,
                liveCurrentWarFallbackMember: warOwnerResolution.liveCurrentWarFallbackMember,
                ambiguousLiveMatchCount: warOwnerResolution.ambiguousLiveMatchCount,
              }
            : warOwnerResolution;
      warOwnerResolutionPlayerCount += 1;
      if (guardedWarOwnerResolution.candidateCount > 1) {
        warOwnerResolutionMultiplePersistedCount += 1;
      }
      if (guardedWarOwnerResolution.resolvedSource === "live_verified") {
        warOwnerResolutionLiveConfirmedCount += 1;
      } else if (guardedWarOwnerResolution.resolvedSource === "persisted_fallback") {
        warOwnerResolutionDegradedFallbackCount += 1;
      } else if (guardedWarOwnerResolution.resolvedSource === "canonical_tracked_roster") {
        // Counted separately when the write is allowed through the transaction guard.
      } else if (guardedWarOwnerResolution.resolvedSource === "authoritative_clear") {
        warOwnerResolutionAuthoritativeClearCount += 1;
      } else {
        warOwnerResolutionUnresolvedCount += 1;
      }
      if (guardedWarOwnerResolution.ambiguousLiveMatchCount > 0) {
        warOwnerResolutionAmbiguousLiveCount += 1;
        const sampleClanTags = [...warOwnerCandidateEntriesByClanTag.values()]
          .map((entry) => entry.clanTag)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 3);
        const sample = [playerTag, ...sampleClanTags].join(":");
        if (warOwnerResolutionAmbiguousSamples.length < 5 && sample.length > 0) {
          warOwnerResolutionAmbiguousSamples.push(sample);
        }
      }
      if (
        guardedWarOwnerResolution.resolvedSource === "live_verified" &&
        guardedWarOwnerResolution.persistedFallbackCandidate &&
        guardedWarOwnerResolution.persistedFallbackCandidate.clanTag !== guardedWarOwnerResolution.resolvedClanTag
      ) {
        warOwnerResolutionStaleCorrectionCount += 1;
      }
      const resolvedWarClanTag = guardedWarOwnerResolution.resolvedClanTag;
      const resolvedCanonicalRosterSelectedCandidate =
        canonicalRosterSelectedCandidate &&
        resolvedWarClanTag &&
        normalizeClanTag(canonicalRosterSelectedCandidate.clanTag) === resolvedWarClanTag
          ? canonicalRosterSelectedCandidate
          : null;
      const liveCurrentWarFallbackContext =
        resolvedWarClanTag
          ? liveCurrentWarFallbackByClanTag.get(resolvedWarClanTag) ??
            guardedWarOwnerResolution.liveCurrentWarFallbackContext
          : guardedWarOwnerResolution.liveCurrentWarFallbackContext;
      const liveCurrentWarFallbackMember = liveCurrentWarFallbackContext
        ? liveCurrentWarFallbackContext.membersByPlayerTag.get(playerTag) ?? null
        : guardedWarOwnerResolution.liveCurrentWarFallbackMember;
      const canonicalRosterMemberKey = canonicalRosterSelectedCandidate
        ? `${canonicalRosterSelectedCandidate.clanTag}:${playerTag}`
        : "";
      const canonicalRosterMember =
        canonicalRosterSelectedCandidate && canonicalRosterSelectedRenderState === "ACTIVE"
          ? activeTrackedWarMemberByClanAndTag.get(canonicalRosterMemberKey) ?? null
          : null;
      const bootstrapExistingWarClanTag = normalizeClanTag(
        existing?.warClanTag ?? existing?.clanTag ?? "",
      );
      const bootstrapTrackedSnapshotActive = Boolean(
        existing?.warActive &&
          bootstrapExistingWarClanTag &&
          currentWarByClanTag.has(bootstrapExistingWarClanTag) &&
          liveCurrentWarFallbackContext,
      );
      const bootstrapLiveVerified =
        bootstrapTrackedSnapshotActive && Boolean(liveCurrentWarFallbackMember);
      const bootstrapLiveCleared =
        bootstrapTrackedSnapshotActive && !liveCurrentWarFallbackMember;
      const warClanTag =
        bootstrapLiveCleared
          ? null
          : resolvedWarClanTag ??
            (guardedWarOwnerResolution.resolvedSource === "unresolved"
              ? canonicalRosterSelectedCandidate?.clanTag ?? null
              : null) ??
            null;
      const currentWar = warClanTag
        ? currentWarByClanTag.get(warClanTag) ?? null
        : null;
      const warState =
        liveCurrentWarFallbackContext?.currentWarState ?? currentWar?.state ?? "";
      const warStateActive = isTodoWarStateActive(warState);
      const warStatePreparation = isWarStatePreparation(warState);
      const warMemberKey = warClanTag ? `${warClanTag}:${playerTag}` : "";
      const trackedWarMember =
        bootstrapLiveCleared
          ? null
          : resolvedWarClanTag
            ? activeTrackedWarMemberByClanAndTag.get(`${resolvedWarClanTag}:${playerTag}`) ?? null
            : canonicalRosterSelectedCandidate
            ? canonicalRosterMember
            : warMemberKey
              ? activeTrackedWarMemberByClanAndTag.get(warMemberKey) ?? null
              : null;
      const rawWarMember =
        bootstrapLiveCleared
          ? null
          : resolvedWarClanTag
            ? fwaWarMemberFallbackByClanAndPlayer.get(`${resolvedWarClanTag}:${playerTag}`) ?? null
            : canonicalRosterSelectedCandidate
            ? null
            : warMemberKey
              ? fwaWarMemberFallbackByClanAndPlayer.get(warMemberKey) ?? null
              : null;
      if (rawWarMember) {
        fallbackWarMemberUsedClanTags.add(rawWarMember.clanTag);
        fallbackWarMemberUsedPlayerTags.add(playerTag);
      }
      const activeMappedCwlClanTag =
        currentCwlMemberByPlayerTag.get(playerTag)?.clanTag ?? "";
      const persistedMappedCwlClanTag =
        mappedCwlClanByPlayerTag.get(playerTag) ?? "";
      const fallbackCwlClanTag =
        resolvedClanTag && cwlTrackedTagSet.has(resolvedClanTag)
          ? resolvedClanTag
          : "";
      const resolvedCwlClanTag =
        normalizeClanTag(
          activeMappedCwlClanTag ||
            persistedMappedCwlClanTag ||
            fallbackCwlClanTag,
        ) || null;
      const liveCandidateCwlClanTag =
        !resolvedCwlClanTag
          ? normalizeClanTag(cwlDiscoveryClanTagByPlayerTag.get(playerTag) ?? "")
          : null;
      const liveNonTrackedCwlContext =
        liveCandidateCwlClanTag && !cwlTrackedTagSet.has(liveCandidateCwlClanTag)
          ? liveNonTrackedCwlContextByClanTag.get(liveCandidateCwlClanTag) ?? null
          : null;
      const liveNonTrackedCwlMember = liveNonTrackedCwlContext
        ? liveNonTrackedCwlContext.membersByPlayerTag.get(playerTag) ?? null
        : null;
      const resolvedLiveCwlClanTag =
        liveNonTrackedCwlMember
          ? normalizeClanTag(liveNonTrackedCwlContext?.clanTag ?? liveCandidateCwlClanTag ?? "") ||
            null
          : null;
      const finalResolvedCwlClanTag =
        resolvedCwlClanTag || resolvedLiveCwlClanTag || null;
      const resolvedCwlClanName =
        (finalResolvedCwlClanTag
          ? currentCwlRoundByClanTag.get(finalResolvedCwlClanTag)?.clanName ||
            cwlTrackedClanNameByTag.get(finalResolvedCwlClanTag) ||
            liveNonTrackedCwlContext?.clanName ||
            resolvedClanName ||
            trackedClanNameByTag.get(finalResolvedCwlClanTag)
          : null) ||
        null;
      const persistedCurrentCwlRound = finalResolvedCwlClanTag
        ? currentCwlRoundByClanTag.get(finalResolvedCwlClanTag) ?? null
        : null;
      const currentCwlRound =
        liveNonTrackedCwlMember ? liveNonTrackedCwlContext : persistedCurrentCwlRound;
      const currentCwlMember =
        liveNonTrackedCwlMember ??
        currentCwlMemberByPlayerTag.get(playerTag) ??
        null;
      const cwlParticipant = Boolean(
        finalResolvedCwlClanTag &&
          currentCwlMember &&
          currentCwlMember.subbedIn &&
          currentCwlMember.clanTag === finalResolvedCwlClanTag,
      );
      const cwlHasContext = Boolean(currentCwlRound);
      const cwlActive = cwlHasContext && cwlParticipant;
      const cwlPhase = cwlHasContext
        ? normalizeWarPhaseLabel(
            currentCwlRound?.roundState ?? persistedCurrentCwlRound?.roundState ?? "",
          )
        : null;
      const liveCwlPhaseEndsAt =
        liveNonTrackedCwlMember ? liveNonTrackedCwlContext?.phaseEndsAt ?? null : null;
      const cwlEndsAt = liveCwlPhaseEndsAt
        ? liveCwlPhaseEndsAt
        : persistedCurrentCwlRound
          ? resolveCurrentWarPhaseEnd({
              state: persistedCurrentCwlRound.roundState ?? null,
              startTime: persistedCurrentCwlRound.startTime ?? null,
              endTime: persistedCurrentCwlRound.endTime ?? null,
            })
          : null;
      const cwlAttacksUsed = cwlParticipant
        ? clampInt(currentCwlMember?.attacksUsed, 0, currentCwlMember?.attacksAvailable || 1)
        : 0;
      const cwlAttacksMax = cwlParticipant
        ? Math.max(0, clampInt(currentCwlMember?.attacksAvailable, 0, 1))
        : 0;
      const livePlayer = liveClanTagByPlayerTag.get(playerTag) ?? null;
      const warStateSourceEndsAt = liveCurrentWarFallbackContext
        ? liveCurrentWarFallbackContext.phaseEndsAt ?? null
        : currentWar
          ? resolveCurrentWarPhaseEnd(currentWar)
          : null;
      const resolvedPlayerName =
        sanitizeDisplayText(trackedWarMember?.playerName ?? "") ||
        sanitizeDisplayText(rawWarMember?.playerName ?? "") ||
        sanitizeDisplayText(liveCurrentWarFallbackMember?.playerName ?? "") ||
        sanitizeDisplayText(latestClanMember?.playerName ?? "") ||
        latestCatalogNameByTag.get(playerTag) ||
        sanitizeDisplayText(existing?.playerName ?? "") ||
        playerTag;
      const resolvedTownHall = (() => {
        if (livePlayer?.townHall !== null && livePlayer?.townHall !== undefined && livePlayer.townHall > 0) {
          return livePlayer.townHall;
        }
        if (
          trackedWarMember?.townHall !== null &&
          trackedWarMember?.townHall !== undefined &&
          trackedWarMember.townHall > 0
        ) {
          return trackedWarMember.townHall;
        }
        if (
          rawWarMember?.townHall !== null &&
          rawWarMember?.townHall !== undefined &&
          rawWarMember.townHall > 0
        ) {
          return rawWarMember.townHall;
        }
        if (
          liveCurrentWarFallbackMember?.townHall !== null &&
          liveCurrentWarFallbackMember?.townHall !== undefined &&
          liveCurrentWarFallbackMember.townHall > 0
        ) {
          return liveCurrentWarFallbackMember.townHall;
        }
        const existingTownHall = normalizeRosterInt(existing?.townHall ?? null);
        return existingTownHall !== null && existingTownHall > 0 ? existingTownHall : null;
      })();

      const hasWarClanTag = warClanTag !== null;
      const canonicalRosterRetainedEnded = canonicalRosterSelectedCandidate
        ? canonicalRosterSelectedRenderState === "RETAINED_ENDED"
        : false;
      const genericWarEvidencePresent = Boolean(
        trackedWarMember || rawWarMember || liveCurrentWarFallbackMember,
      );
      const attemptedWarOwnerSource: TodoWarOwnerSource =
        bootstrapLiveVerified
          ? "LIVE_VERIFIED"
          : canonicalRosterSelectedCandidate || canonicalRosterHasApplicableExactCandidates
          ? warOwnerResolution.resolvedSource === "live_verified"
            ? "LIVE_VERIFIED"
            : warOwnerResolution.resolvedSource === "persisted_fallback" ||
                warOwnerResolution.resolvedSource === "canonical_tracked_roster"
              ? "PERSISTED_FALLBACK"
              : "NONE"
          : bootstrapLiveCleared
            ? "NONE"
            : warOwnerResolution.resolvedSource === "live_verified"
            ? "LIVE_VERIFIED"
            : genericWarEvidencePresent ||
                warOwnerResolution.resolvedSource === "persisted_fallback"
              ? "PERSISTED_FALLBACK"
              : "NONE";
      const warOwnerLooksActive =
        resolvedCanonicalRosterSelectedCandidate
          ? canonicalRosterRetainedEnded
            ? Boolean(existing?.warActive)
            : warStateActive && hasWarClanTag
          : warStateActive &&
            hasWarClanTag &&
            Boolean(trackedWarMember || rawWarMember || liveCurrentWarFallbackMember);
      const warAttacksUsed = resolvedCanonicalRosterSelectedCandidate
        ? canonicalRosterRetainedEnded
          ? clampInt(existing?.warAttacksUsed ?? 0, 0, 2)
          : canonicalRosterMember
            ? clampInt(canonicalRosterMember.attacksUsed, 0, 2)
            : 0
        : !warStateActive || !hasWarClanTag
          ? 0
          : warStatePreparation
            ? 0
            : trackedWarMember
              ? clampInt(trackedWarMember.attacksUsed, 0, 2)
              : rawWarMember
                ? clampInt(rawWarMember.attacks, 0, 2)
                : liveCurrentWarFallbackMember
                  ? clampInt(liveCurrentWarFallbackMember.attacksUsed, 0, 2)
                  : genericWarOwnerResolution?.selectedCandidate?.sources.has("snapshot_hint")
                    ? clampInt(existing?.warAttacksUsed ?? 0, 0, 2)
                    : 0;
      const warPhase = resolvedCanonicalRosterSelectedCandidate
        ? canonicalRosterRetainedEnded
          ? existing?.warPhase ?? null
          : warStateActive && hasWarClanTag && warOwnerLooksActive
            ? normalizeWarPhaseLabel(warState)
            : null
        : warStateActive && hasWarClanTag && warOwnerLooksActive
          ? normalizeWarPhaseLabel(warState)
          : null;
      const warEndsAt = resolvedCanonicalRosterSelectedCandidate
        ? canonicalRosterRetainedEnded
          ? existing?.warEndsAt ?? null
          : warStateActive && hasWarClanTag && warOwnerLooksActive
            ? warStateSourceEndsAt
            : null
        : warStateActive && hasWarClanTag && warOwnerLooksActive
          ? warStateSourceEndsAt
          : null;
      const warActive = resolvedCanonicalRosterSelectedCandidate
        ? canonicalRosterRetainedEnded
          ? Boolean(existing?.warActive)
          : warStateActive && hasWarClanTag && warOwnerLooksActive
        : warOwnerLooksActive;
      const attemptedWarState: TodoWarOwnerSnapshotState = resolvedCanonicalRosterSelectedCandidate
        ? {
            warClanTag,
            warClanName:
              resolvedCanonicalRosterSelectedCandidate.parent.clanName ||
              (warClanTag ? trackedClanNameByTag.get(warClanTag) : null) ||
              (warClanTag ? raidTrackedClanNameByTag.get(warClanTag) : null) ||
              null,
            warPosition: resolvedCanonicalRosterSelectedCandidate.position,
            warSourceUpdatedAt:
              resolvedCanonicalRosterSelectedCandidate.parent.sourceCurrentWarUpdatedAt ??
              resolvedCanonicalRosterSelectedCandidate.parent.sourceUpdatedAt ??
              currentWar?.updatedAt ??
              null,
            warOwnerSource: attemptedWarOwnerSource,
            warOwnerWarId:
              currentWar
                ? toFiniteIntOrNull(currentWar.warId)
                : resolvedCanonicalRosterSelectedCandidate.parent.sourceWarId,
            warOwnerVerifiedAt: warOwnerResolution.resolvedSource === "live_verified" ? now : null,
            warAttacksMax: 2,
            warActive,
            warAttacksUsed,
            warPhase,
            warEndsAt,
          }
        : {
            warClanTag,
            warClanName:
              (warClanTag ? liveCurrentWarFallbackContext?.clanName : null) ||
              (warClanTag ? trackedClanNameByTag.get(warClanTag) : null) ||
              (warClanTag ? raidTrackedClanNameByTag.get(warClanTag) : null) ||
              (warOwnerResolution.resolvedSource !== "unresolved"
                ? genericWarOwnerResolution?.selectedCandidate?.preferredClanName
                : null) ||
              null,
            warPosition:
              trackedWarMember
                ? toFiniteIntOrNull(trackedWarMember.position)
                : rawWarMember
                  ? toFiniteIntOrNull(rawWarMember.position)
                : liveCurrentWarFallbackMember
                  ? toFiniteIntOrNull(liveCurrentWarFallbackMember.mapPosition ?? null)
                  : warOwnerResolution.resolvedSource !== "unresolved" &&
                      genericWarOwnerResolution?.selectedCandidate?.sources.has("snapshot_hint")
                    ? toFiniteIntOrNull(existing?.warPosition ?? null)
                    : null,
            warSourceUpdatedAt:
              trackedWarMember && currentWar
                ? currentWar.updatedAt
                : rawWarMember?.sourceSyncedAt ?? liveCurrentWarFallbackContext?.sourceUpdatedAt ?? null,
            warOwnerSource: attemptedWarOwnerSource,
            warOwnerWarId: currentWar ? toFiniteIntOrNull(currentWar.warId) : null,
            warOwnerVerifiedAt:
              attemptedWarOwnerSource === "LIVE_VERIFIED" ? now : null,
            warAttacksMax: 2,
            warActive,
            warAttacksUsed,
            warPhase,
            warEndsAt,
          };
      const warDecision = buildTodoWarOwnerDecision({
        existing: existing ?? null,
        attemptedState: attemptedWarState,
        attemptedObservationAt: now,
        currentWarByClanTag,
        resolutionSource: bootstrapLiveCleared
          ? "authoritative_clear"
          : bootstrapLiveVerified
            ? "live_verified"
            : warOwnerResolution.resolvedSource,
      });
      const finalWarState = warDecision.finalState;
      if (warDecision.preservationMode === "preserved_existing_verified") {
        verifiedContinuityPreservedCount += 1;
        if (warDecision.suppressionReason === "stale") {
          staleWriteSuppressedCount += 1;
          if (warOwnerResolution.resolvedSource === "canonical_tracked_roster") {
            trackedRosterCanonicalWriteSuppressedStaleCount += 1;
            if (trackedRosterCanonicalWriteSuppressedSamples.length < 5) {
              trackedRosterCanonicalWriteSuppressedSamples.push(
                [
                  `player_tag=${playerTag}`,
                  `existing_owner=${warDecision.existingWarIdentity?.clanTag ?? "none"}`,
                  `attempted_owner=${warDecision.attemptedWarIdentity.clanTag ?? "none"}`,
                  `roster_war_id=${warDecision.attemptedWarIdentity.warId ?? "none"}`,
                  `existing_verification_at=${
                    warDecision.existingWarIdentity?.verifiedAt?.toISOString() ?? "none"
                  }`,
                  `attempted_observation_at=${now.toISOString()}`,
                  `suppression_reason=${warDecision.suppressionReason}`,
                ].join(" "),
              );
            }
          }
        } else if (warDecision.suppressionReason === "lower_confidence") {
          lowerConfidenceWriteSuppressedCount += 1;
        }
        if (warDecision.existingConfidence === "LIVE_VERIFIED") {
          console.warn(
            `[todo-snapshot] event=todo_war_owner_write_suppressed player_tag=${playerTag} existing_owner=${warDecision.existingWarIdentity?.clanTag ?? "none"} attempted_owner=${warDecision.attemptedWarIdentity.clanTag ?? "none"} existing_confidence=${warDecision.existingConfidence} attempted_confidence=${warDecision.attemptedConfidence} existing_war_id=${warDecision.existingWarIdentity?.warId ?? "none"} attempted_war_id=${warDecision.attemptedWarIdentity.warId ?? "none"} existing_verified_at=${warDecision.existingWarIdentity?.verifiedAt?.toISOString() ?? "none"} attempted_observation_at=${now.toISOString()} reason=${warDecision.suppressionReason ?? "lower_confidence"}`,
          );
        }
      } else if (
        warOwnerResolution.resolvedSource === "canonical_tracked_roster" &&
        resolvedCanonicalRosterSelectedCandidate
      ) {
        trackedRosterCanonicalWriteCount += 1;
      } else if (
        warDecision.existingConfidence === "LIVE_VERIFIED" &&
        warDecision.attemptedConfidence === "LIVE_VERIFIED" &&
        warDecision.existingWarIdentity &&
        (warDecision.existingWarIdentity.clanTag !== warDecision.attemptedWarIdentity.clanTag ||
          warDecision.existingWarIdentity.warId !== warDecision.attemptedWarIdentity.warId)
      ) {
        verifiedOwnerReplacedCount += 1;
      } else if (
        warDecision.existingConfidence === "LIVE_VERIFIED" &&
        warDecision.attemptedConfidence === "NONE" &&
        warOwnerResolution.resolvedSource === "authoritative_clear"
      ) {
        verifiedOwnerClearedCount += 1;
      }

      const derivedGames = deriveTodoGamesValues({
        gamesWindowActive: gamesWindow.active,
        gamesRewardCollectionActive: gamesWindow.rewardCollectionActive,
        gamesCycleKey,
        observedChampionTotal: gamesChampionTotalByTag.get(playerTag) ?? null,
        existingChampionTotal: existing?.gamesChampionTotal ?? null,
        existingSeasonBaseline: existing?.gamesSeasonBaseline ?? null,
        existingCycleKey: existing?.gamesCycleKey ?? null,
        existingPoints: existing?.gamesPoints ?? null,
      });

      const data = {
        playerName: resolvedPlayerName,
        townHall: resolvedTownHall,
        clanTag: resolvedClanTag,
        clanName: resolvedClanName,
        warClanTag: finalWarState.warClanTag,
        warClanName: finalWarState.warClanName,
        warPosition: finalWarState.warPosition,
        warSourceUpdatedAt: finalWarState.warSourceUpdatedAt,
        warOwnerSource: finalWarState.warOwnerSource,
        warOwnerWarId: finalWarState.warOwnerWarId,
        warOwnerVerifiedAt: finalWarState.warOwnerVerifiedAt,
        clanMembershipObservedAt: membershipContext.observedAt ?? null,
        cwlClanTag: finalResolvedCwlClanTag,
        cwlClanName: resolvedCwlClanName,
        warActive: finalWarState.warActive,
        warAttacksUsed: finalWarState.warAttacksUsed,
        warAttacksMax: finalWarState.warAttacksMax,
        warPhase: finalWarState.warPhase,
        warEndsAt: finalWarState.warEndsAt,
        cwlActive,
        cwlAttacksUsed,
        cwlAttacksMax,
        cwlPhase,
        cwlEndsAt,
        raidClanTag: raidSnapshotData.raidClanTag,
        raidClanName: raidSnapshotData.raidClanName,
        raidActive: raidSnapshotData.raidActive,
        raidAttacksUsed: raidSnapshotData.raidAttacksUsed,
        raidAttacksMax: raidSnapshotData.raidAttacksMax,
        raidEndsAt: raidSnapshotData.raidEndsAt,
        raidSourceUpdatedAt: raidSnapshotData.raidSourceUpdatedAt,
        gamesActive: gamesWindow.active,
        gamesPoints: derivedGames.points,
        gamesTarget: derivedGames.target,
        gamesChampionTotal: derivedGames.championTotal,
        gamesSeasonBaseline: derivedGames.seasonBaseline,
        gamesCycleKey: derivedGames.cycleKey,
        gamesEndsAt: new Date(gamesWindow.endMs),
        lastUpdatedAt: now,
      };
      if (data.raidActive) {
        raidActiveTrueCount += 1;
      } else {
        raidActiveFalseCount += 1;
      }
      const currentMembershipSource = membershipContext.source;
      currentMembershipSourceCounts.set(
        currentMembershipSource,
        (currentMembershipSourceCounts.get(currentMembershipSource) ?? 0) + 1,
      );
      const warSource =
        canonicalRosterSelectedCandidate
          ? "tracked_roster"
          : trackedWarMember && currentWar
          ? "tracked_roster"
          : rawWarMember
            ? "war_member"
            : liveCurrentWarFallbackMember
              ? "live_current_war"
              : warOwnerResolution.resolvedSource === "persisted_fallback"
                ? "persisted_fallback"
                : "none";
      if (finalWarState.warActive && finalWarState.warPosition === null) {
        missingWarPositionCount += 1;
      }
      warSourceCounts.set(warSource, (warSourceCounts.get(warSource) ?? 0) + 1);

      snapshotUpserts.push({
        where: { playerTag },
        update: data,
        create: {
          playerTag,
          ...data,
        },
        warDecisionInput: {
          attemptedState: attemptedWarState,
          attemptedObservationAt: now,
          resolutionSource: warOwnerResolution.resolvedSource,
        },
      });
    }

    console.info(
      `[todo-snapshot] event=todo_refresh_population_sources player_count=${normalizedTags.length} membership_observed_live=${currentMembershipSourceCounts.get("observed_live") ?? 0} membership_fetched_live=${currentMembershipSourceCounts.get("fetched_live") ?? 0} membership_player_current=${currentMembershipSourceCounts.get("player_current") ?? 0} membership_fwa_member=${currentMembershipSourceCounts.get("fwa_member") ?? 0} membership_existing=${currentMembershipSourceCounts.get("existing") ?? 0} membership_no_clan=${currentMembershipSourceCounts.get("no_clan") ?? 0} membership_none=${currentMembershipSourceCounts.get("none") ?? 0} war_tracked_roster=${warSourceCounts.get("tracked_roster") ?? 0} war_member=${warSourceCounts.get("war_member") ?? 0} war_live_current=${warSourceCounts.get("live_current_war") ?? 0} war_none=${warSourceCounts.get("none") ?? 0} missing_war_position_count=${missingWarPositionCount}`,
    );
    if (fallbackWarMemberUsedPlayerTags.size > 0) {
      console.info(
        `[todo-snapshot] event=tracked_war_roster_member_fallback_used reason=missing_derived_roster_member clan_count=${fallbackWarMemberUsedClanTags.size} player_count=${fallbackWarMemberUsedPlayerTags.size}`,
      );
    }
    console.info(
      `[todo-snapshot] event=todo_war_owner_resolution_summary player_count=${warOwnerResolutionPlayerCount} multi_candidate_player_count=${warOwnerResolutionMultiplePersistedCount} live_confirmed_count=${warOwnerResolutionLiveConfirmedCount} verified_continuity_preserved_count=${verifiedContinuityPreservedCount} lower_confidence_write_suppressed_count=${lowerConfidenceWriteSuppressedCount} stale_write_suppressed_count=${staleWriteSuppressedCount} verified_owner_replaced_count=${verifiedOwnerReplacedCount} verified_owner_cleared_count=${verifiedOwnerClearedCount} stale_correction_count=${warOwnerResolutionStaleCorrectionCount} degraded_fallback_count=${warOwnerResolutionDegradedFallbackCount} authoritative_clear_count=${warOwnerResolutionAuthoritativeClearCount} ambiguous_live_match_count=${warOwnerResolutionAmbiguousLiveCount} unresolved_count=${warOwnerResolutionUnresolvedCount} tracked_authoritative_count=${trackedRosterAuthoritativeCount} tracked_legacy_fallback_count=${trackedRosterLegacyFallbackCount} tracked_stale_identity_rejected_count=${trackedRosterStaleIdentityRejectedCount} tracked_roster_inactive_rejected_count=${trackedRosterInactiveRejectedCount} tracked_ambiguous_count=${trackedRosterAmbiguousCount} tracked_owner_corrected_count=${trackedRosterOwnerCorrectedCount} tracked_retained_ended_count=${trackedRosterRetainedEndedCount} tracked_roster_canonical_write_count=${trackedRosterCanonicalWriteCount} tracked_roster_canonical_write_suppressed_stale_count=${trackedRosterCanonicalWriteSuppressedStaleCount} tracked_roster_preloaded_live_confirmed_count=${trackedRosterPreloadedLiveConfirmedCount} tracked_roster_preloaded_live_rejected_count=${trackedRosterPreloadedLiveRejectedCount}`,
    );
    if (warOwnerResolutionAmbiguousSamples.length > 0) {
      console.warn(
        `[todo-snapshot] event=todo_war_owner_resolution_ambiguous sample_count=${warOwnerResolutionAmbiguousSamples.length} sample_matches=${warOwnerResolutionAmbiguousSamples.join("|")}`,
      );
    }
    if (trackedRosterCanonicalWriteSuppressedSamples.length > 0) {
      console.warn(
        `[todo-snapshot] event=tracked_roster_canonical_write_suppressed sample_count=${trackedRosterCanonicalWriteSuppressedSamples.length} sample_matches=${trackedRosterCanonicalWriteSuppressedSamples.join("|")}`,
      );
    }

    try {
      await runChunkedWrites(
        snapshotUpserts,
        TODO_SNAPSHOT_WRITE_CHUNK_SIZE,
        async (write) => {
          const writeDecision = await persistTodoSnapshotWrite({
            write,
            currentWarByClanTag,
          });
          if (writeDecision.preservationMode === "preserved_existing_verified") {
            if (writeDecision.existingConfidence === "LIVE_VERIFIED") {
              verifiedContinuityPreservedCount += 1;
              if (writeDecision.suppressionReason === "stale") {
                staleWriteSuppressedCount += 1;
              } else {
                lowerConfidenceWriteSuppressedCount += 1;
              }
            } else {
              lowerConfidenceWriteSuppressedCount += 1;
            }
          } else if (writeDecision.preservationMode === "preserved_existing_bootstrap") {
            lowerConfidenceWriteSuppressedCount += 1;
          } else if (
            writeDecision.existingConfidence === "LIVE_VERIFIED" &&
            writeDecision.attemptedConfidence === "LIVE_VERIFIED" &&
            writeDecision.existingWarIdentity &&
            (writeDecision.existingWarIdentity.clanTag !== writeDecision.attemptedWarIdentity.clanTag ||
              writeDecision.existingWarIdentity.warId !== writeDecision.attemptedWarIdentity.warId)
          ) {
            verifiedOwnerReplacedCount += 1;
          } else if (
            writeDecision.existingConfidence === "LIVE_VERIFIED" &&
            writeDecision.attemptedConfidence === "NONE" &&
            write.warDecisionInput.resolutionSource === "authoritative_clear"
          ) {
            verifiedOwnerClearedCount += 1;
          }
        },
      );
    } catch (err) {
      console.error(
        `[todo-snapshot] persist_failed players=${normalizedTags.length} snapshots=${snapshotUpserts.length} error=${formatError(err)}`,
      );
      throw err;
    }

    console.info(
      `[todo-snapshot] event=raid_snapshot_refresh now_ms=${nowMs} raid_start_ms=${raidWindow.startMs} raid_end_ms=${raidWindow.endMs} raid_active=${raidWindow.active} player_count=${normalizedTags.length} raid_active_rows=${raidActiveTrueCount} raid_inactive_rows=${raidActiveFalseCount} raid_observed_count=${raidObservedCount} raid_preserved_unavailable_count=${raidPreservedUnavailableCount} raid_preserved_failed_count=${raidPreservedFailedCount} raid_authoritative_clear_count=${raidAuthoritativeClearCount} raid_expired_context_clear_count=${raidExpiredContextClearCount} raid_clan_fetch_failure_count=${liveRaidContextLookup.clanFetchFailureCount}`,
    );

    return {
      playerCount: normalizedTags.length,
      updatedCount: snapshotUpserts.length,
    };
  }
}

/** Purpose: provide one singleton snapshot service instance for command and background use. */
export const todoSnapshotService = new TodoSnapshotService();

/** Purpose: clear in-memory refresh locks between isolated tests. */
export function resetTodoSnapshotServiceForTest(): void {
  todoSnapshotService.resetForTest();
}

/** Purpose: satisfy TS type inference for snapshot row shape from one shared select object. */
async function listTodoSnapshotRecordsForTypeInference() {
  return prisma.todoPlayerSnapshot.findMany({
    where: { playerTag: { in: [] } },
    select: TODO_SNAPSHOT_SELECT,
  });
}

/** Purpose: normalize free-form display text into compact deterministic row-safe text. */
function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Purpose: normalize arbitrary numeric input into one bounded integer range with default zero. */
function clampInt(input: unknown, min: number, max: number): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return min;
  const truncated = Math.trunc(value);
  return Math.max(min, Math.min(max, truncated));
}

/** Purpose: map unknown numeric values to finite integer or null for nullable persistence fields. */
function toFiniteIntOrNull(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" && input.trim().length <= 0) return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Purpose: build one deterministic cycle key for Clan Games baseline ownership. */
function buildClanGamesCycleKey(startMs: number): string {
  return String(Math.trunc(startMs));
}

/** Purpose: resolve one shared Clan Games cycle boundary from persisted cycle-key state. */
export function resolveClanGamesCycleBoundaryFromCycleKey(input: unknown): {
  startMs: number;
  earningEndsMs: number;
  rewardCollectionEndsMs: number;
} | null {
  const cycleStartMs = toFiniteIntOrNull(input);
  if (cycleStartMs === null) return null;
  const cycleStart = new Date(cycleStartMs);
  return buildClanGamesCycleBoundary(
    cycleStart.getUTCFullYear(),
    cycleStart.getUTCMonth(),
  );
}

/** Purpose: load the currently stored RAID-tracked clan rows for snapshot scope decisions. */
async function listRaidTrackedClanRows(): Promise<Array<{ clanTag: string; name: string | null }>> {
  return prisma.raidTrackedClan.findMany({
    select: {
      clanTag: true,
      name: true,
    },
  });
}

/** Purpose: normalize potentially-empty cycle-key input into nullable stable string. */
function normalizeGamesCycleKey(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Purpose: derive snapshot-owned Clan Games observability values and bounded points. */
function deriveTodoGamesValues(input: {
  gamesWindowActive: boolean;
  gamesRewardCollectionActive: boolean;
  gamesCycleKey: string;
  observedChampionTotal: number | null;
  existingChampionTotal: number | null;
  existingSeasonBaseline: number | null;
  existingCycleKey: string | null;
  existingPoints: number | null;
}): TodoGamesDerivedValues {
  const championTotal =
    toFiniteIntOrNull(input.observedChampionTotal) ??
    toFiniteIntOrNull(input.existingChampionTotal);
  const existingBaseline = toFiniteIntOrNull(input.existingSeasonBaseline);
  const existingCycleKey = normalizeGamesCycleKey(input.existingCycleKey);
  const existingPoints = toFiniteIntOrNull(input.existingPoints);
  const activeCycleKey = normalizeGamesCycleKey(input.gamesCycleKey);

  let resolvedBaseline: number | null = null;
  if (existingCycleKey && activeCycleKey && existingCycleKey === activeCycleKey) {
    resolvedBaseline = existingBaseline;
    if (
      championTotal !== null &&
      resolvedBaseline === null &&
      existingPoints !== null &&
      existingPoints > 0
    ) {
      resolvedBaseline = Math.max(
        0,
        championTotal - clampInt(existingPoints, 0, TODO_GAMES_POINTS_MAX),
      );
    }
  }
  if (resolvedBaseline === null) resolvedBaseline = championTotal;
  if (
    championTotal !== null &&
    resolvedBaseline !== null &&
    championTotal < resolvedBaseline
  ) {
    resolvedBaseline = championTotal;
  }

  if (!input.gamesWindowActive && !input.gamesRewardCollectionActive) {
    return {
      points: null,
      target: null,
      championTotal,
      seasonBaseline: championTotal,
      cycleKey: activeCycleKey,
    };
  }

  if (resolvedBaseline === null && !input.gamesRewardCollectionActive) {
    return {
      points: 0,
      target: TODO_GAMES_TARGET_POINTS,
      championTotal,
      seasonBaseline: null,
      cycleKey: activeCycleKey,
    };
  }

  const points = resolveGamesCyclePoints({
    championTotal,
    seasonBaseline: resolvedBaseline,
    existingPoints,
  });
  return {
    points,
    target: TODO_GAMES_TARGET_POINTS,
    championTotal,
    seasonBaseline: resolvedBaseline,
    cycleKey: activeCycleKey,
  };
}

/** Purpose: derive latest-season points with champion/baseline math and stable existing-points fallback during reward collection. */
function resolveGamesCyclePoints(input: {
  championTotal: number | null;
  seasonBaseline: number | null;
  existingPoints: number | null;
}): number {
  if (input.championTotal !== null && input.seasonBaseline !== null) {
    return clampInt(
      input.championTotal - input.seasonBaseline,
      0,
      TODO_GAMES_POINTS_MAX,
    );
  }
  if (input.existingPoints !== null) {
    return clampInt(input.existingPoints, 0, TODO_GAMES_POINTS_MAX);
  }
  return 0;
}

function sleepMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.trunc(ms)));
}

/** Purpose: execute write operations in bounded chunks with parallel writes per chunk. */
async function runChunkedWrites<T>(
  items: T[],
  chunkSize: number,
  writeOne: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length <= 0) return;
  const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0 ? Math.trunc(chunkSize) : 1;
  for (let start = 0; start < items.length; start += safeChunkSize) {
    const chunk = items.slice(start, start + safeChunkSize);
    await Promise.all(chunk.map((item) => writeOne(item)));
  }
}

/** Purpose: normalize many player tags in stable order with uniqueness and validation. */
function normalizePlayerTags(input: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of input) {
    const playerTag = normalizePlayerTag(raw);
    if (!playerTag || seen.has(playerTag)) continue;
    seen.add(playerTag);
    normalized.push(playerTag);
  }
  return normalized;
}

function chunkArray<T>(input: T[], chunkSize: number): T[][] {
  const safeChunkSize =
    Number.isFinite(chunkSize) && chunkSize > 0 ? Math.trunc(chunkSize) : 1;
  const chunks: T[][] = [];
  for (let index = 0; index < input.length; index += safeChunkSize) {
    chunks.push(input.slice(index, index + safeChunkSize));
  }
  return chunks;
}

export function resolveWarEventLinkedPlayerRefreshPlanForTest(input: {
  candidateCount: number;
  dedupedCount: number;
  pacingMs?: number | null;
}): {
  candidateCount: number;
  dedupedCount: number;
  chunkSize: number;
  chunkCount: number;
  chunkDelayMs: number;
} {
  const candidateCount = Math.max(0, Math.trunc(Number(input.candidateCount) || 0));
  const dedupedCount = Math.max(0, Math.trunc(Number(input.dedupedCount) || 0));
  const chunkSize = dedupedCount > 0 ? 25 : 1;
  const chunkCount = dedupedCount > 0 ? Math.ceil(dedupedCount / chunkSize) : 0;
  const pacingMs =
    Number.isFinite(input.pacingMs ?? NaN) && Number(input.pacingMs) > 0
      ? Math.trunc(Number(input.pacingMs))
      : 0;
  const chunkDelayMs =
    pacingMs > 0 && chunkCount > 1
      ? Math.max(250, Math.floor(pacingMs / chunkCount))
      : 0;
  return { candidateCount, dedupedCount, chunkSize, chunkCount, chunkDelayMs };
}

/** Purpose: keep only the most recent clan-member row per player tag by source sync time. */
function pickLatestClanMemberByPlayerTag(
  rows: ClanMemberCurrentRow[],
): Map<string, ClanMemberCurrentRow> {
  const latest = new Map<string, ClanMemberCurrentRow>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const clanTag = normalizeClanTag(row.clanTag);
    if (!playerTag || !clanTag) continue;

    const existing = latest.get(playerTag);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latest.set(playerTag, {
        playerTag,
        clanTag,
        playerName: sanitizeDisplayText(row.playerName) || playerTag,
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep only the most recent war-member row per clan+player pair by source sync time. */
function pickLatestWarMemberByClanAndPlayer(
  rows: WarMemberCurrentRow[],
): Map<string, WarMemberCurrentRow> {
  const latest = new Map<string, WarMemberCurrentRow>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const clanTag = normalizeClanTag(row.clanTag);
    if (!playerTag || !clanTag) continue;

    const existing = latest.get(`${clanTag}:${playerTag}`);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latest.set(`${clanTag}:${playerTag}`, {
        playerTag,
        clanTag,
        playerName: sanitizeDisplayText(row.playerName) || playerTag,
        townHall: normalizeRosterInt(row.townHall),
        position: normalizeRosterInt(row.position),
        attacks: normalizeRosterInt(row.attacks),
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }
  return latest;
}

/** Purpose: summarize tracked-war roster drift when derived roster members lag behind raw WarMembers. */
function buildTrackedWarRosterDriftDiagnostics(input: {
  activeTrackedCurrentWarByClanTag: Map<string, TodoTrackedCurrentWarRow>;
  rosterCurrentClanTagSet: Set<string>;
  rawWarMemberByClanAndPlayer: Map<string, WarMemberCurrentRow>;
  derivedWarRosterByClanAndPlayer: Map<string, TodoTrackedWarRosterRow>;
}): TrackedWarRosterDriftDiagnostic[] {
  const rawClanAndPlayerSet = new Map<string, Set<string>>();
  for (const row of input.rawWarMemberByClanAndPlayer.values()) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;

    const playerTags = rawClanAndPlayerSet.get(clanTag) ?? new Set<string>();
    playerTags.add(playerTag);
    rawClanAndPlayerSet.set(clanTag, playerTags);
  }

  const derivedClanAndPlayerSet = new Map<string, Set<string>>();
  for (const row of input.derivedWarRosterByClanAndPlayer.values()) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;

    const playerTags = derivedClanAndPlayerSet.get(clanTag) ?? new Set<string>();
    playerTags.add(playerTag);
    derivedClanAndPlayerSet.set(clanTag, playerTags);
  }

  const diagnostics: TrackedWarRosterDriftDiagnostic[] = [];
  for (const [clanTag, currentWar] of input.activeTrackedCurrentWarByClanTag.entries()) {
    if (!input.rosterCurrentClanTagSet.has(clanTag)) continue;

    const rawPlayerTags = rawClanAndPlayerSet.get(clanTag);
    if (!rawPlayerTags || rawPlayerTags.size === 0) continue;

    const derivedPlayerTags = derivedClanAndPlayerSet.get(clanTag) ?? new Set<string>();
    const missingDerivedMemberSampleTags = [...rawPlayerTags]
      .filter((playerTag) => !derivedPlayerTags.has(playerTag))
      .sort((a, b) => a.localeCompare(b));
    if (missingDerivedMemberSampleTags.length === 0) continue;

    diagnostics.push({
      clanTag,
      rawMemberCount: rawPlayerTags.size,
      derivedMemberCount: derivedPlayerTags.size,
      missingDerivedMemberCount: missingDerivedMemberSampleTags.length,
      rosterCurrentExists: true,
      currentWarState: String(currentWar.state ?? "") || "unknown",
      missingDerivedMemberSampleTags: missingDerivedMemberSampleTags.slice(0, 3),
    });
  }

  return diagnostics;
}

/** Purpose: rank war-owner evidence sources so persisted fallback remains deterministic. */
function getWarOwnerCandidateSourceRank(source: WarOwnerCandidateSource): number {
  switch (source) {
    case "derived_roster":
      return 3;
    case "raw_war_member":
      return 2;
    case "snapshot_hint":
      return 1;
    case "legacy_roster":
      return 0.5;
    case "current_membership":
      return 0;
  }
}

/** Purpose: identify persisted WAR ownership evidence that can survive a live verification miss. */
function hasStrongWarOwnerPersistedEvidence(entry: WarOwnerCandidateEntry): boolean {
  return (
    entry.sources.has("derived_roster") ||
    entry.sources.has("raw_war_member") ||
    entry.sources.has("snapshot_hint")
  );
}

/** Purpose: collect one war-owner candidate entry without collapsing different clans together. */
function addWarOwnerCandidateEntry(input: {
  byPlayerTag: Map<string, Map<string, WarOwnerCandidateEntry>>;
  playerTag: string;
  clanTag: string;
  source: WarOwnerCandidateSource;
  currentWarUpdatedAt?: Date | null;
  currentWarWarId?: number | null;
  clanName?: string | null;
}): void {
  const playerTag = normalizePlayerTag(input.playerTag);
  const clanTag = normalizeClanTag(input.clanTag);
  if (!playerTag || !clanTag) return;

  let byClanTag = input.byPlayerTag.get(playerTag);
  if (!byClanTag) {
    byClanTag = new Map<string, WarOwnerCandidateEntry>();
    input.byPlayerTag.set(playerTag, byClanTag);
  }

  let entry = byClanTag.get(clanTag);
  if (!entry) {
    entry = {
      clanTag,
      sources: new Set<WarOwnerCandidateSource>(),
      preferredClanName: null,
      preferredClanNameRank: -1,
      currentWarUpdatedAt: input.currentWarUpdatedAt ?? null,
      currentWarWarId: input.currentWarWarId ?? null,
    };
    byClanTag.set(clanTag, entry);
  }

  entry.sources.add(input.source);
  if (
    input.currentWarUpdatedAt instanceof Date &&
    (!entry.currentWarUpdatedAt ||
      input.currentWarUpdatedAt.getTime() > entry.currentWarUpdatedAt.getTime())
  ) {
    entry.currentWarUpdatedAt = input.currentWarUpdatedAt;
  }
  if (
    input.currentWarWarId !== null &&
    input.currentWarWarId !== undefined &&
    entry.currentWarWarId === null
  ) {
    entry.currentWarWarId = input.currentWarWarId;
  }

  const clanName = sanitizeDisplayText(String(input.clanName ?? "")) || null;
  const clanNameRank = getWarOwnerCandidateSourceRank(input.source);
  if (
    clanName &&
    (entry.preferredClanName === null || clanNameRank > entry.preferredClanNameRank)
  ) {
    entry.preferredClanName = clanName;
    entry.preferredClanNameRank = clanNameRank;
  }
}

/** Purpose: compare exact tracked-war roster candidates using freshness before existing-owner tie-breaking. */
function compareCanonicalTrackedWarRosterCandidates(
  a: {
    existingMatches: boolean;
    candidate: TodoTrackedWarRosterCandidateRow;
    currentWarUpdatedAt: number;
    currentWarWarId: number;
  },
  b: {
    existingMatches: boolean;
    candidate: TodoTrackedWarRosterCandidateRow;
    currentWarUpdatedAt: number;
    currentWarWarId: number;
  },
): number {
  if (a.currentWarUpdatedAt !== b.currentWarUpdatedAt) {
    return b.currentWarUpdatedAt - a.currentWarUpdatedAt;
  }

  if (a.currentWarWarId !== b.currentWarWarId) {
    return b.currentWarWarId - a.currentWarWarId;
  }

  const aSourceUpdatedAt = a.candidate.parent.sourceUpdatedAt?.getTime() ?? 0;
  const bSourceUpdatedAt = b.candidate.parent.sourceUpdatedAt?.getTime() ?? 0;
  if (aSourceUpdatedAt !== bSourceUpdatedAt) {
    return bSourceUpdatedAt - aSourceUpdatedAt;
  }

  const aObservedAt = a.candidate.parent.observedAt?.getTime() ?? 0;
  const bObservedAt = b.candidate.parent.observedAt?.getTime() ?? 0;
  if (aObservedAt !== bObservedAt) {
    return bObservedAt - aObservedAt;
  }

  const aCurrentWarUpdatedAt = a.candidate.parent.sourceCurrentWarUpdatedAt?.getTime() ?? 0;
  const bCurrentWarUpdatedAt = b.candidate.parent.sourceCurrentWarUpdatedAt?.getTime() ?? 0;
  if (aCurrentWarUpdatedAt !== bCurrentWarUpdatedAt) {
    return bCurrentWarUpdatedAt - aCurrentWarUpdatedAt;
  }

  if (a.existingMatches !== b.existingMatches) {
    return a.existingMatches ? -1 : 1;
  }

  return 0;
}

/** Purpose: keep retained-ended tracked-war roster ownership only when the existing snapshot still renders that clan war. */
function isTrackedWarRosterExistingMatch(input: {
  existingSnapshot: TodoSnapshotRecord | null;
  candidate: TodoTrackedWarRosterCandidateRow;
  currentWar: TodoTrackedCurrentWarRow | null;
}): boolean {
  const existing = input.existingSnapshot;
  if (!existing?.warActive) return false;

  const existingClanTag = normalizeClanTag(existing.warClanTag ?? existing.clanTag ?? "");
  if (!existingClanTag || existingClanTag !== input.candidate.clanTag) {
    return false;
  }

  const currentWar = input.currentWar;
  if (!currentWar) return false;

  const rosterWarId = toFiniteIntOrNull(input.candidate.parent.sourceWarId);
  const currentWarId = toFiniteIntOrNull(currentWar.warId);
  if (rosterWarId !== null && currentWarId !== null) {
    return rosterWarId === currentWarId;
  }

  const rosterStartMs =
    input.candidate.parent.sourceWarStartTime instanceof Date
      ? input.candidate.parent.sourceWarStartTime.getTime()
      : null;
  const currentStartMs =
    currentWar.startTime instanceof Date ? currentWar.startTime.getTime() : null;
  return rosterWarId === null && rosterStartMs !== null && currentStartMs !== null
    ? rosterStartMs === currentStartMs
    : false;
}

/** Purpose: resolve the exact tracked-war roster candidate before generic fallback sources can participate. */
function resolveCanonicalTrackedWarRosterOwnerForPlayer(input: {
  playerTag: string;
  candidateRows: readonly TodoTrackedWarRosterCandidateRow[];
  existingSnapshot: TodoSnapshotRecord | null;
  currentWarByClanTag: Map<string, TodoTrackedCurrentWarRow>;
  preloadedCurrentWarSnapshotsByClanTag: Map<string, CurrentWarSnapshot | null>;
}): {
  resolvedClanTag: string | null;
  resolvedSource:
    | "live_verified"
    | "persisted_fallback"
    | "canonical_tracked_roster"
    | "authoritative_clear"
    | "unresolved";
  selectedCandidate: TodoTrackedWarRosterCandidateRow | null;
  selectedRenderState: TrackedWarRosterRenderState | null;
  exactCandidateCount: number;
  applicableExactCandidateCount: number;
  inactiveRejectedCount: number;
  legacyFallbackCount: number;
  staleIdentityRejectedCount: number;
  ambiguousCount: number;
  retainedEndedCount: number;
  preloadedLiveConfirmedCount: number;
  preloadedLiveRejectedCount: number;
} {
  const exactCandidates = input.candidateRows.filter(
    (row) =>
      row.identityMatch === "EXACT_WAR_ID" || row.identityMatch === "EXACT_START_TIME",
  );
  const legacyFallbackCount = input.candidateRows.filter(
    (row) => row.identityMatch === "LEGACY_UNSCOPED",
  ).length;
  const staleIdentityRejectedCount = input.candidateRows.filter(
    (row) => row.identityMatch === "STALE_OR_MISMATCHED",
  ).length;
  const scoredExactCandidates = exactCandidates.map((candidate) => {
    const currentWar = input.currentWarByClanTag.get(candidate.clanTag) ?? null;
    const renderState = resolveTrackedWarRosterRenderState({
      roster: candidate.parent,
      currentWar,
      existingSnapshot: input.existingSnapshot,
      identityMatch: candidate.identityMatch,
    });
    return {
      candidate,
      currentWar,
      renderState,
      existingMatches: isTrackedWarRosterExistingMatch({
        existingSnapshot: input.existingSnapshot,
        candidate,
        currentWar,
      }),
      currentWarUpdatedAt: currentWar?.updatedAt?.getTime() ?? 0,
      currentWarWarId: toFiniteIntOrNull(currentWar?.warId) ?? Number.MIN_SAFE_INTEGER,
    };
  });
  const inactiveRejectedCount = scoredExactCandidates.filter(
    (row) => row.renderState === "INACTIVE",
  ).length;
  const applicableExactCandidates = scoredExactCandidates.filter(
    (row) => row.renderState === "ACTIVE" || row.renderState === "RETAINED_ENDED",
  );
  const retainedEndedCount = applicableExactCandidates.filter(
    (row) => row.renderState === "RETAINED_ENDED",
  ).length;

  if (applicableExactCandidates.length === 0) {
    const legacyCandidates = input.candidateRows.filter(
      (row) => row.identityMatch === "LEGACY_UNSCOPED",
    );
    const activeLegacyCandidates = legacyCandidates.filter((row) => {
      const currentWar = input.currentWarByClanTag.get(row.clanTag) ?? null;
      return Boolean(currentWar && isTodoWarStateActive(currentWar.state));
    });
    if (activeLegacyCandidates.length > 0) {
      const preloadedLiveContextsByClanTag = buildPreloadedLiveCurrentWarFallbackContextsByClanTag({
        clanTags: activeLegacyCandidates.map((candidate) => candidate.clanTag),
        preloadedCurrentWarSnapshotsByClanTag: input.preloadedCurrentWarSnapshotsByClanTag,
      });
      const scoredLegacyCandidates = activeLegacyCandidates.map((candidate) => {
        const currentWar = input.currentWarByClanTag.get(candidate.clanTag) ?? null;
        const liveContext = preloadedLiveContextsByClanTag.get(candidate.clanTag) ?? null;
        const liveStatus: "verified_present" | "verified_absent" | "unavailable" = liveContext
          ? liveContext.membersByPlayerTag.has(input.playerTag)
            ? "verified_present"
            : "verified_absent"
          : "unavailable";
        return {
          candidate,
          existingMatches: false,
          currentWarUpdatedAt: currentWar?.updatedAt?.getTime() ?? 0,
          currentWarWarId: toFiniteIntOrNull(currentWar?.warId) ?? Number.MIN_SAFE_INTEGER,
          renderState: resolveTrackedWarRosterRenderState({
            roster: candidate.parent,
            currentWar,
            existingSnapshot: input.existingSnapshot,
            identityMatch: candidate.identityMatch,
          }),
          liveContext,
          liveStatus,
        };
      });
      const preloadedLiveConfirmedCount = scoredLegacyCandidates.filter(
        (row) => row.liveStatus === "verified_present",
      ).length;
      const preloadedLiveRejectedCount = scoredLegacyCandidates.filter(
        (row) => row.liveStatus === "verified_absent",
      ).length;

      const verifiedPresent = scoredLegacyCandidates.filter((row) => row.liveStatus === "verified_present");
      if (verifiedPresent.length > 0) {
        const sorted = [...verifiedPresent].sort(compareCanonicalTrackedWarRosterCandidates);
        const best = sorted[0] ?? null;
        const tied = best
          ? sorted.filter(
              (row) =>
                compareCanonicalTrackedWarRosterCandidates(row, best) === 0 &&
                compareCanonicalTrackedWarRosterCandidates(best, row) === 0,
            )
          : [];
        const selected = tied.length > 1 ? tied[0] ?? null : best;
        const existingSnapshotClanTag = normalizeClanTag(
          input.existingSnapshot?.clanTag ?? "",
        );
        const selectedClanTag = normalizeClanTag(selected?.candidate.clanTag ?? "");
        return {
          resolvedClanTag: selected?.candidate.clanTag ?? null,
          resolvedSource:
            selected && (!existingSnapshotClanTag || existingSnapshotClanTag === selectedClanTag)
              ? "live_verified"
              : selected
                ? "persisted_fallback"
                : "unresolved",
          selectedCandidate: selected?.candidate ?? null,
          selectedRenderState: selected?.renderState ?? null,
          exactCandidateCount: exactCandidates.length,
          applicableExactCandidateCount: 0,
          inactiveRejectedCount,
          legacyFallbackCount,
          staleIdentityRejectedCount,
          ambiguousCount: selected ? Math.max(0, tied.length - 1) : tied.length,
          retainedEndedCount: 0,
          preloadedLiveConfirmedCount,
          preloadedLiveRejectedCount,
        };
      }

      if (preloadedLiveRejectedCount > 0) {
        return {
          resolvedClanTag: null,
          resolvedSource: "unresolved",
          selectedCandidate: null,
          selectedRenderState: null,
          exactCandidateCount: exactCandidates.length,
          applicableExactCandidateCount: 0,
          inactiveRejectedCount,
          legacyFallbackCount,
          staleIdentityRejectedCount,
          ambiguousCount: 0,
          retainedEndedCount: 0,
          preloadedLiveConfirmedCount,
          preloadedLiveRejectedCount,
        };
      }

      const sorted = [...scoredLegacyCandidates].sort(compareCanonicalTrackedWarRosterCandidates);
      const best = sorted[0] ?? null;
      const tied = best
        ? sorted.filter(
            (row) =>
              compareCanonicalTrackedWarRosterCandidates(row, best) === 0 &&
              compareCanonicalTrackedWarRosterCandidates(best, row) === 0,
          )
        : [];
      const selected = tied.length > 1 ? tied.find((row) => row.existingMatches) ?? null : best;
      return {
        resolvedClanTag: selected?.candidate.clanTag ?? null,
        resolvedSource: selected ? "persisted_fallback" : "unresolved",
        selectedCandidate: selected?.candidate ?? null,
        selectedRenderState: selected?.renderState ?? null,
        exactCandidateCount: exactCandidates.length,
        applicableExactCandidateCount: 0,
        inactiveRejectedCount,
        legacyFallbackCount,
        staleIdentityRejectedCount,
        ambiguousCount: selected ? Math.max(0, tied.length - 1) : tied.length,
        retainedEndedCount: 0,
        preloadedLiveConfirmedCount,
        preloadedLiveRejectedCount,
      };
    }
    return {
      resolvedClanTag: null,
      resolvedSource: "unresolved",
      selectedCandidate: null,
      selectedRenderState: null,
      exactCandidateCount: exactCandidates.length,
      applicableExactCandidateCount: 0,
      inactiveRejectedCount,
      legacyFallbackCount,
      staleIdentityRejectedCount,
      ambiguousCount: 0,
      retainedEndedCount: 0,
      preloadedLiveConfirmedCount: 0,
      preloadedLiveRejectedCount: 0,
    };
  }

  const activeExactCandidates = applicableExactCandidates.filter(
    (row) => row.renderState === "ACTIVE",
  );
  const preloadedLiveContextsByClanTag = buildPreloadedLiveCurrentWarFallbackContextsByClanTag({
    clanTags: activeExactCandidates.map((row) => row.candidate.clanTag),
    preloadedCurrentWarSnapshotsByClanTag: input.preloadedCurrentWarSnapshotsByClanTag,
  });
  const scoredExactCandidatesWithLive = applicableExactCandidates.map((row) => {
    const liveContext =
      row.renderState === "ACTIVE"
        ? preloadedLiveContextsByClanTag.get(row.candidate.clanTag) ?? null
        : null;
    const liveStatus: "verified_present" | "verified_absent" | "unavailable" =
      row.renderState === "ACTIVE"
        ? liveContext
          ? liveContext.membersByPlayerTag.has(input.playerTag)
            ? "verified_present"
            : "verified_absent"
          : "unavailable"
        : "unavailable";
    return {
      ...row,
      liveContext,
      liveStatus,
    };
  });
  const preloadedLiveConfirmedCount = scoredExactCandidatesWithLive.filter(
    (row) => row.liveStatus === "verified_present",
  ).length;
  const preloadedLiveRejectedCount = scoredExactCandidatesWithLive.filter(
    (row) => row.liveStatus === "verified_absent",
  ).length;

  const verifiedPresent = scoredExactCandidatesWithLive.filter(
    (row) => row.liveStatus === "verified_present",
  );
  if (verifiedPresent.length > 0) {
    const sorted = [...verifiedPresent].sort(compareCanonicalTrackedWarRosterCandidates);
    const best = sorted[0] ?? null;
    if (!best) {
      return {
        resolvedClanTag: null,
        resolvedSource: "unresolved",
        selectedCandidate: null,
        selectedRenderState: null,
        exactCandidateCount: exactCandidates.length,
        applicableExactCandidateCount: applicableExactCandidates.length,
        inactiveRejectedCount,
        legacyFallbackCount,
        staleIdentityRejectedCount,
        ambiguousCount: 0,
        retainedEndedCount,
        preloadedLiveConfirmedCount,
        preloadedLiveRejectedCount,
      };
    }
    const tied = sorted.filter(
      (row) =>
        compareCanonicalTrackedWarRosterCandidates(row, best) === 0 &&
        compareCanonicalTrackedWarRosterCandidates(best, row) === 0,
    );
    const selected =
      tied.length > 1 ? tied.find((row) => row.existingMatches) ?? null : best;
    if (!selected) {
      return {
        resolvedClanTag: null,
        resolvedSource: "unresolved",
        selectedCandidate: null,
        selectedRenderState: null,
        exactCandidateCount: exactCandidates.length,
        applicableExactCandidateCount: applicableExactCandidates.length,
        inactiveRejectedCount,
        legacyFallbackCount,
        staleIdentityRejectedCount,
        ambiguousCount: tied.length,
        retainedEndedCount,
        preloadedLiveConfirmedCount,
        preloadedLiveRejectedCount,
      };
    }
    return {
      resolvedClanTag: selected.candidate.clanTag,
      resolvedSource: "live_verified",
      selectedCandidate: selected.candidate,
      selectedRenderState: selected.renderState,
      exactCandidateCount: exactCandidates.length,
      applicableExactCandidateCount: applicableExactCandidates.length,
      inactiveRejectedCount,
      legacyFallbackCount,
      staleIdentityRejectedCount,
      ambiguousCount: Math.max(0, tied.length - 1),
      retainedEndedCount,
      preloadedLiveConfirmedCount,
      preloadedLiveRejectedCount,
    };
  }

  const selectedExactCandidates = scoredExactCandidatesWithLive.filter(
    (row) => row.liveStatus === "unavailable",
  );
  if (selectedExactCandidates.length > 0) {
    const sorted = [...selectedExactCandidates].sort(compareCanonicalTrackedWarRosterCandidates);
    const best = sorted[0] ?? null;
    const tied = best
      ? sorted.filter(
          (row) =>
            compareCanonicalTrackedWarRosterCandidates(row, best) === 0 &&
            compareCanonicalTrackedWarRosterCandidates(best, row) === 0,
        )
      : [];
    const selected =
      tied.length > 1 ? tied.find((row) => row.existingMatches) ?? null : best;
    return {
      resolvedClanTag: selected?.candidate.clanTag ?? null,
      resolvedSource: selected ? "canonical_tracked_roster" : "unresolved",
      selectedCandidate: selected?.candidate ?? null,
      selectedRenderState: selected?.renderState ?? null,
      exactCandidateCount: exactCandidates.length,
      applicableExactCandidateCount: applicableExactCandidates.length,
      inactiveRejectedCount,
      legacyFallbackCount,
      staleIdentityRejectedCount,
      ambiguousCount: selected ? Math.max(0, tied.length - 1) : tied.length,
      retainedEndedCount,
      preloadedLiveConfirmedCount,
      preloadedLiveRejectedCount,
    };
  }

  const verifiedAbsentExactCandidates = scoredExactCandidatesWithLive.filter(
    (row) => row.liveStatus === "verified_absent",
  );
  if (verifiedAbsentExactCandidates.length > 0) {
    return {
      resolvedClanTag: null,
      resolvedSource: "authoritative_clear",
      selectedCandidate: null,
      selectedRenderState: null,
      exactCandidateCount: exactCandidates.length,
      applicableExactCandidateCount: applicableExactCandidates.length,
      inactiveRejectedCount,
      legacyFallbackCount,
      staleIdentityRejectedCount,
      ambiguousCount: 0,
      retainedEndedCount,
      preloadedLiveConfirmedCount,
      preloadedLiveRejectedCount,
    };
  }

  return {
    resolvedClanTag: null,
    resolvedSource: "unresolved",
    selectedCandidate: null,
    selectedRenderState: null,
    exactCandidateCount: exactCandidates.length,
    applicableExactCandidateCount: applicableExactCandidates.length,
    inactiveRejectedCount,
    legacyFallbackCount,
    staleIdentityRejectedCount,
    ambiguousCount: 0,
    retainedEndedCount,
    preloadedLiveConfirmedCount,
    preloadedLiveRejectedCount,
  };
}

type TodoWarOwnerSnapshotState = {
  warClanTag: string | null;
  warClanName: string | null;
  warPosition: number | null;
  warSourceUpdatedAt: Date | null;
  warOwnerSource: TodoWarOwnerSource;
  warOwnerWarId: number | null;
  warOwnerVerifiedAt: Date | null;
  warActive: boolean;
  warAttacksUsed: number;
  warAttacksMax: number;
  warPhase: string | null;
  warEndsAt: Date | null;
};

type TodoWarOwnerWriteDecision = {
  finalState: TodoWarOwnerSnapshotState;
  preservationMode:
    | "attempted"
    | "preserved_existing_verified"
    | "preserved_existing_bootstrap";
  suppressionReason: "lower_confidence" | "stale" | null;
  existingConfidence: TodoWarOwnerSource;
  attemptedConfidence: TodoWarOwnerSource;
  existingWarIdentity: {
    clanTag: string | null;
    warId: number | null;
    verifiedAt: Date | null;
  } | null;
  attemptedWarIdentity: {
    clanTag: string | null;
    warId: number | null;
    verifiedAt: Date | null;
  };
};

type TodoSnapshotWriteOperation = {
  where: { playerTag: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
  warDecisionInput: {
    attemptedState: TodoWarOwnerSnapshotState;
    attemptedObservationAt: Date;
    resolutionSource: WarOwnerResolutionSource;
  };
};

function normalizeTodoWarOwnerSource(input: unknown): TodoWarOwnerSource {
  const normalized = String(input ?? "").toUpperCase();
  if (normalized === "LIVE_VERIFIED") return "LIVE_VERIFIED";
  if (normalized === "PERSISTED_FALLBACK") return "PERSISTED_FALLBACK";
  return "NONE";
}

function buildTodoWarOwnerIdentity(input: {
  clanTag: string | null;
  warId: number | null;
  verifiedAt: Date | null;
}): {
  clanTag: string | null;
  warId: number | null;
  verifiedAt: Date | null;
} {
  return {
    clanTag: normalizeClanTag(input.clanTag ?? ""),
    warId: toFiniteIntOrNull(input.warId),
    verifiedAt: input.verifiedAt instanceof Date ? input.verifiedAt : null,
  };
}

function applyTodoWarOwnerStateToSnapshotData(
  snapshot: Record<string, unknown>,
  warState: TodoWarOwnerSnapshotState,
): Record<string, unknown> {
  return {
    ...snapshot,
    warClanTag: warState.warClanTag,
    warClanName: warState.warClanName,
    warPosition: warState.warPosition,
    warSourceUpdatedAt: warState.warSourceUpdatedAt,
    warOwnerSource: warState.warOwnerSource,
    warOwnerWarId: warState.warOwnerWarId,
    warOwnerVerifiedAt: warState.warOwnerVerifiedAt,
    warActive: warState.warActive,
    warAttacksUsed: warState.warAttacksUsed,
    warAttacksMax: warState.warAttacksMax,
    warPhase: warState.warPhase,
    warEndsAt: warState.warEndsAt,
  };
}

/** Purpose: preserve the full existing WAR state when the write guard suppresses a newer attempt. */
function buildTodoWarOwnerPreservedState(input: {
  existing: TodoSnapshotRecord;
  existingConfidence: TodoWarOwnerSource;
  existingIdentity: {
    clanTag: string | null;
    warId: number | null;
    verifiedAt: Date | null;
  } | null;
}): TodoWarOwnerSnapshotState {
  return {
    warClanTag: input.existing.warClanTag ?? null,
    warClanName: input.existing.warClanName ?? null,
    warPosition: input.existing.warPosition ?? null,
    warSourceUpdatedAt: input.existing.warSourceUpdatedAt ?? null,
    warOwnerSource: input.existingConfidence,
    warOwnerWarId: input.existingIdentity?.warId ?? null,
    warOwnerVerifiedAt: input.existingIdentity?.verifiedAt ?? null,
    warActive: Boolean(input.existing.warActive),
    warAttacksUsed: clampInt(input.existing.warAttacksUsed ?? 0, 0, 2),
    warAttacksMax: clampInt(input.existing.warAttacksMax ?? 2, 0, 2) || 2,
    warPhase: input.existing.warPhase ?? null,
    warEndsAt: input.existing.warEndsAt ?? null,
  };
}

/** Purpose: merge canonical roster metadata into an already-live verified WAR owner without downgrading provenance. */
function buildTodoWarOwnerCanonicalMergeState(input: {
  existing: TodoSnapshotRecord;
  attemptedState: TodoWarOwnerSnapshotState;
  existingConfidence: TodoWarOwnerSource;
  existingIdentity: {
    clanTag: string | null;
    warId: number | null;
    verifiedAt: Date | null;
  } | null;
}): TodoWarOwnerSnapshotState {
  return {
    warClanTag: input.attemptedState.warClanTag,
    warClanName: input.attemptedState.warClanName,
    warPosition: input.attemptedState.warPosition,
    warSourceUpdatedAt: input.attemptedState.warSourceUpdatedAt,
    warOwnerSource: input.existingConfidence,
    warOwnerWarId: input.attemptedState.warOwnerWarId,
    warOwnerVerifiedAt: input.existingIdentity?.verifiedAt ?? null,
    warActive: Boolean(input.existing.warActive),
    warAttacksUsed: clampInt(input.existing.warAttacksUsed ?? 0, 0, 2),
    warAttacksMax: clampInt(input.existing.warAttacksMax ?? 2, 0, 2) || 2,
    warPhase: input.existing.warPhase ?? null,
    warEndsAt: input.existing.warEndsAt ?? null,
  };
}

function getTodoWarOwnerFreshnessMs(input: {
  warOwnerVerifiedAt: Date | null | undefined;
  lastUpdatedAt: Date | null | undefined;
} | null): number | null {
  if (!input) return null;
  if (input.warOwnerVerifiedAt instanceof Date) {
    return input.warOwnerVerifiedAt.getTime();
  }
  if (input.lastUpdatedAt instanceof Date) {
    return input.lastUpdatedAt.getTime();
  }
  return null;
}

async function persistTodoSnapshotWrite(input: {
  write: TodoSnapshotWriteOperation;
  currentWarByClanTag: Map<string, TodoTrackedCurrentWarRow>;
}): Promise<TodoWarOwnerWriteDecision> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.write.where.playerTag}, 0))`;
    const currentSnapshot = await tx.todoPlayerSnapshot.findUnique({
      where: input.write.where,
      select: TODO_SNAPSHOT_SELECT,
    });
    const guardedWarDecision = buildTodoWarOwnerDecision({
      existing: currentSnapshot,
      attemptedState: input.write.warDecisionInput.attemptedState,
      attemptedObservationAt: input.write.warDecisionInput.attemptedObservationAt,
      currentWarByClanTag: input.currentWarByClanTag,
      resolutionSource: input.write.warDecisionInput.resolutionSource,
    });
    const guardedUpdate = applyTodoWarOwnerStateToSnapshotData(
      input.write.update,
      guardedWarDecision.finalState,
    );
    const guardedCreate = applyTodoWarOwnerStateToSnapshotData(
      input.write.create,
      guardedWarDecision.finalState,
    );
    await tx.todoPlayerSnapshot.upsert({
      where: input.write.where,
      update: guardedUpdate as any,
      create: guardedCreate as any,
    } as any);
    return guardedWarDecision;
  });
}

function buildTodoWarOwnerDecision(input: {
  existing: TodoSnapshotRecord | null;
  attemptedState: TodoWarOwnerSnapshotState;
  attemptedObservationAt: Date;
  currentWarByClanTag: Map<string, TodoTrackedCurrentWarRow>;
  resolutionSource: WarOwnerResolutionSource;
}): TodoWarOwnerWriteDecision {
  const existing = input.existing ?? null;
  const attemptedState = input.attemptedState;
  const existingConfidence = normalizeTodoWarOwnerSource(existing?.warOwnerSource ?? "NONE");
  const attemptedConfidence = normalizeTodoWarOwnerSource(attemptedState.warOwnerSource);
  const attemptedIdentity = buildTodoWarOwnerIdentity({
    clanTag: attemptedState.warClanTag,
    warId: attemptedState.warOwnerWarId,
    verifiedAt: attemptedState.warOwnerVerifiedAt,
  });
  const existingIdentity = existing
    ? buildTodoWarOwnerIdentity({
        clanTag: existing.warClanTag ?? null,
        warId: existing.warOwnerWarId ?? null,
        verifiedAt: existing.warOwnerVerifiedAt ?? null,
      })
    : null;
  const existingFreshnessMs = getTodoWarOwnerFreshnessMs(existing);
  const attemptedFreshnessMs = input.attemptedObservationAt.getTime();

  const existingWarClanTag = normalizeClanTag(existing?.warClanTag ?? "");
  const existingCurrentWar = existingWarClanTag
    ? input.currentWarByClanTag.get(existingWarClanTag) ?? null
    : null;
  const existingCurrentWarActive =
    existingCurrentWar !== null && isTodoWarStateActive(existingCurrentWar.state);
  const existingCurrentWarId = toFiniteIntOrNull(existingCurrentWar?.warId);
  const existingVerifiedContinuity =
    existing !== null &&
    existingConfidence === "LIVE_VERIFIED" &&
    existing.warActive === true &&
    existingWarClanTag !== "" &&
    existingIdentity !== null &&
    existingIdentity.clanTag === existingWarClanTag &&
    existingIdentity.warId !== null &&
    existingCurrentWar !== null &&
    existingCurrentWarActive &&
    existingCurrentWarId !== null &&
    existingCurrentWarId === existingIdentity.warId;

  const canonicalAttemptIsLiveTrackedRoster = input.resolutionSource === "canonical_tracked_roster";
  const canonicalAttemptIsSameIdentity =
    canonicalAttemptIsLiveTrackedRoster &&
    existingConfidence === "LIVE_VERIFIED" &&
    existingIdentity !== null &&
    existingIdentity.clanTag === attemptedIdentity.clanTag &&
    existingIdentity.warId !== null &&
    attemptedIdentity.warId !== null &&
    existingIdentity.warId === attemptedIdentity.warId;
  const canonicalAttemptIsDifferentIdentity =
    canonicalAttemptIsLiveTrackedRoster &&
    existingConfidence === "LIVE_VERIFIED" &&
    existingIdentity !== null &&
    (existingIdentity.clanTag !== attemptedIdentity.clanTag ||
      existingIdentity.warId !== attemptedIdentity.warId);
  const canonicalAttemptIsStale =
    canonicalAttemptIsLiveTrackedRoster &&
    existingConfidence === "LIVE_VERIFIED" &&
    existingFreshnessMs !== null &&
    attemptedFreshnessMs < existingFreshnessMs;
  const existingVerifiedStaleLowerConfidence =
    existing !== null &&
    existingConfidence === "LIVE_VERIFIED" &&
    existingFreshnessMs !== null &&
    attemptedFreshnessMs < existingFreshnessMs &&
    attemptedConfidence !== "LIVE_VERIFIED" &&
    input.resolutionSource !== "authoritative_clear";

  const existingBootstrapProtectedFallback =
    existing !== null &&
    existingConfidence === "PERSISTED_FALLBACK" &&
    existing.warActive === true &&
    existingWarClanTag !== "" &&
    existing?.warOwnerWarId === null &&
    existing?.warOwnerVerifiedAt === null &&
    existingCurrentWarActive &&
    attemptedConfidence !== "LIVE_VERIFIED" &&
    input.resolutionSource !== "authoritative_clear";

  if (input.resolutionSource === "authoritative_clear") {
    if (existing && existingFreshnessMs !== null && attemptedFreshnessMs < existingFreshnessMs) {
      return {
        finalState: buildTodoWarOwnerPreservedState({
          existing,
          existingConfidence,
          existingIdentity,
        }),
        preservationMode: "preserved_existing_verified",
        suppressionReason: "stale",
        existingConfidence,
        attemptedConfidence,
        existingWarIdentity: existingIdentity,
        attemptedWarIdentity: attemptedIdentity,
      };
    }

    return {
      finalState: {
        warClanTag: null,
        warClanName: null,
        warPosition: null,
        warSourceUpdatedAt: null,
        warOwnerSource: "NONE",
        warOwnerWarId: null,
        warOwnerVerifiedAt: null,
        warActive: false,
        warAttacksUsed: 0,
        warAttacksMax: 2,
        warPhase: null,
        warEndsAt: null,
      },
      preservationMode: "attempted",
      suppressionReason: null,
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (
    existingConfidence === "LIVE_VERIFIED" &&
    attemptedConfidence === "LIVE_VERIFIED" &&
    (existingFreshnessMs === null || attemptedFreshnessMs < existingFreshnessMs) &&
    existing
  ) {
    return {
      finalState: buildTodoWarOwnerPreservedState({
        existing,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "preserved_existing_verified",
      suppressionReason: "stale",
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (canonicalAttemptIsStale && existing) {
    return {
      finalState: buildTodoWarOwnerPreservedState({
        existing,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "preserved_existing_verified",
      suppressionReason: "stale",
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (canonicalAttemptIsSameIdentity && existing) {
    return {
      finalState: buildTodoWarOwnerCanonicalMergeState({
        existing,
        attemptedState,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "attempted",
      suppressionReason: null,
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (canonicalAttemptIsDifferentIdentity && existing) {
    return {
      finalState: {
        ...attemptedState,
        warOwnerSource: "PERSISTED_FALLBACK",
        warOwnerVerifiedAt: null,
      },
      preservationMode: "attempted",
      suppressionReason: null,
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (existingVerifiedStaleLowerConfidence && existing) {
    return {
      finalState: buildTodoWarOwnerPreservedState({
        existing,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "preserved_existing_verified",
      suppressionReason: "stale",
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (existingVerifiedContinuity && attemptedConfidence !== "LIVE_VERIFIED" && existing) {
    const suppressionReason =
      existing.lastUpdatedAt.getTime() > input.attemptedObservationAt.getTime()
        ? "stale"
        : "lower_confidence";
    return {
      finalState: buildTodoWarOwnerPreservedState({
        existing,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "preserved_existing_verified",
      suppressionReason,
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  if (existingBootstrapProtectedFallback) {
    return {
      finalState: buildTodoWarOwnerPreservedState({
        existing,
        existingConfidence,
        existingIdentity,
      }),
      preservationMode: "preserved_existing_bootstrap",
      suppressionReason: "lower_confidence",
      existingConfidence,
      attemptedConfidence,
      existingWarIdentity: existingIdentity,
      attemptedWarIdentity: attemptedIdentity,
    };
  }

  return {
    finalState: attemptedState,
    preservationMode: "attempted",
    suppressionReason: null,
    existingConfidence,
    attemptedConfidence,
    existingWarIdentity: existingIdentity,
    attemptedWarIdentity: attemptedIdentity,
  };
}

/** Purpose: resolve one player’s WAR owner from verified live evidence or deterministic persisted fallback. */
function resolveWarOwnerForPlayer(input: {
  playerTag: string;
  candidateEntriesByClanTag: Map<string, WarOwnerCandidateEntry>;
  liveCurrentWarFallbackByClanTag: Map<string, LiveCurrentWarFallbackContext>;
}): {
  resolvedClanTag: string | null;
  resolvedSource: WarOwnerResolutionSource;
  selectedCandidate: WarOwnerCandidateEntry | null;
  liveCurrentWarFallbackContext: LiveCurrentWarFallbackContext | null;
  liveCurrentWarFallbackMember:
    | {
        clanTag: string;
        playerName: string;
        townHall: number | null;
        mapPosition: number | null;
        attacksUsed: number;
        attacksAvailable: number;
      }
    | null;
  persistedFallbackCandidate: WarOwnerCandidateEntry | null;
  verifiedCandidateCount: number;
  ambiguousLiveMatchCount: number;
  candidateCount: number;
  persistedCandidateCount: number;
  strongCandidateCount: number;
  verifiedAbsentStrongCandidateCount: number;
  unavailableStrongCandidateCount: number;
} {
  const candidateEntries = [...input.candidateEntriesByClanTag.values()];
  if (candidateEntries.length <= 0) {
    return {
      resolvedClanTag: null,
      resolvedSource: "unresolved",
      selectedCandidate: null,
      liveCurrentWarFallbackContext: null,
      liveCurrentWarFallbackMember: null,
      persistedFallbackCandidate: null,
      verifiedCandidateCount: 0,
      ambiguousLiveMatchCount: 0,
      candidateCount: 0,
      persistedCandidateCount: 0,
      strongCandidateCount: 0,
      verifiedAbsentStrongCandidateCount: 0,
      unavailableStrongCandidateCount: 0,
    };
  }

  const candidateRecords = candidateEntries.map((entry) => {
    const context = input.liveCurrentWarFallbackByClanTag.get(entry.clanTag) ?? null;
    const status: WarOwnerCandidateVerificationStatus = context
      ? context.membersByPlayerTag.has(input.playerTag)
        ? "verified_present"
        : "verified_absent"
      : "unavailable";
    return {
      entry,
      context,
      status,
      strongEvidence: hasStrongWarOwnerPersistedEvidence(entry),
    };
  });
  const compareByLiveIdentity = (
    a: WarOwnerCandidateEntry,
    b: WarOwnerCandidateEntry,
  ): number => {
    const aUpdatedAt = a.currentWarUpdatedAt?.getTime() ?? 0;
    const bUpdatedAt = b.currentWarUpdatedAt?.getTime() ?? 0;
    if (aUpdatedAt !== bUpdatedAt) {
      return bUpdatedAt - aUpdatedAt;
    }

    const aWarId = a.currentWarWarId ?? Number.MIN_SAFE_INTEGER;
    const bWarId = b.currentWarWarId ?? Number.MIN_SAFE_INTEGER;
    if (aWarId !== bWarId) {
      return bWarId - aWarId;
    }

    const aSourceRank = Math.max(
      ...[...a.sources].map((source) => getWarOwnerCandidateSourceRank(source)),
    );
    const bSourceRank = Math.max(
      ...[...b.sources].map((source) => getWarOwnerCandidateSourceRank(source)),
    );
    if (aSourceRank !== bSourceRank) {
      return bSourceRank - aSourceRank;
    }

    return a.clanTag.localeCompare(b.clanTag);
  };
  const compareByPersistedFallback = (
    a: WarOwnerCandidateEntry,
    b: WarOwnerCandidateEntry,
  ): number => {
    const aSourceRank = Math.max(
      ...[...a.sources].map((source) => getWarOwnerCandidateSourceRank(source)),
    );
    const bSourceRank = Math.max(
      ...[...b.sources].map((source) => getWarOwnerCandidateSourceRank(source)),
    );
    if (aSourceRank !== bSourceRank) {
      return bSourceRank - aSourceRank;
    }

    const aUpdatedAt = a.currentWarUpdatedAt?.getTime() ?? 0;
    const bUpdatedAt = b.currentWarUpdatedAt?.getTime() ?? 0;
    if (aUpdatedAt !== bUpdatedAt) {
      return bUpdatedAt - aUpdatedAt;
    }

    const aWarId = a.currentWarWarId ?? Number.MIN_SAFE_INTEGER;
    const bWarId = b.currentWarWarId ?? Number.MIN_SAFE_INTEGER;
    if (aWarId !== bWarId) {
      return bWarId - aWarId;
    }

    return a.clanTag.localeCompare(b.clanTag);
  };

  const verifiedPresentCandidates = candidateRecords
    .filter((record) => record.status === "verified_present")
    .map((record) => record.entry);
  const unavailableStrongCandidates = candidateRecords
    .filter((record) => record.status === "unavailable" && record.strongEvidence)
    .map((record) => record.entry);
  const verifiedAbsentStrongCandidates = candidateRecords
    .filter((record) => record.status === "verified_absent" && record.strongEvidence)
    .map((record) => record.entry);
  const strongPersistedCandidates = candidateRecords
    .filter((record) => record.strongEvidence)
    .map((record) => record.entry);

  const bestStrongPersistedCandidate =
    [...strongPersistedCandidates].sort(compareByPersistedFallback)[0] ?? null;

  if (verifiedPresentCandidates.length > 0) {
    const selectedCandidate = [...verifiedPresentCandidates].sort(compareByLiveIdentity)[0] ?? null;
    const liveCurrentWarFallbackContext = selectedCandidate
      ? input.liveCurrentWarFallbackByClanTag.get(selectedCandidate.clanTag) ?? null
      : null;
    const liveCurrentWarFallbackMember =
      liveCurrentWarFallbackContext?.membersByPlayerTag.get(input.playerTag) ?? null;
    return {
      resolvedClanTag: selectedCandidate?.clanTag ?? null,
      resolvedSource: "live_verified",
      selectedCandidate,
      liveCurrentWarFallbackContext,
      liveCurrentWarFallbackMember,
      persistedFallbackCandidate: bestStrongPersistedCandidate,
      verifiedCandidateCount: verifiedPresentCandidates.length,
      ambiguousLiveMatchCount: Math.max(0, verifiedPresentCandidates.length - 1),
      candidateCount: candidateEntries.length,
      persistedCandidateCount: candidateEntries.length,
      strongCandidateCount: strongPersistedCandidates.length,
      verifiedAbsentStrongCandidateCount: verifiedAbsentStrongCandidates.length,
      unavailableStrongCandidateCount: unavailableStrongCandidates.length,
    };
  }

  if (unavailableStrongCandidates.length > 0) {
    const selectedCandidate =
      [...unavailableStrongCandidates].sort(compareByPersistedFallback)[0] ?? null;
    return {
      resolvedClanTag: selectedCandidate?.clanTag ?? null,
      resolvedSource: selectedCandidate ? "persisted_fallback" : "unresolved",
      selectedCandidate,
      liveCurrentWarFallbackContext: null,
      liveCurrentWarFallbackMember: null,
      persistedFallbackCandidate: selectedCandidate,
      verifiedCandidateCount: 0,
      ambiguousLiveMatchCount: 0,
      candidateCount: candidateEntries.length,
      persistedCandidateCount: candidateEntries.length,
      strongCandidateCount: strongPersistedCandidates.length,
      verifiedAbsentStrongCandidateCount: verifiedAbsentStrongCandidates.length,
      unavailableStrongCandidateCount: unavailableStrongCandidates.length,
    };
  }

  if (verifiedAbsentStrongCandidates.length > 0) {
    return {
      resolvedClanTag: null,
      resolvedSource: "authoritative_clear",
      selectedCandidate: null,
      liveCurrentWarFallbackContext: null,
      liveCurrentWarFallbackMember: null,
      persistedFallbackCandidate: bestStrongPersistedCandidate,
      verifiedCandidateCount: 0,
      ambiguousLiveMatchCount: 0,
      candidateCount: candidateEntries.length,
      persistedCandidateCount: candidateEntries.length,
      strongCandidateCount: strongPersistedCandidates.length,
      verifiedAbsentStrongCandidateCount: verifiedAbsentStrongCandidates.length,
      unavailableStrongCandidateCount: unavailableStrongCandidates.length,
    };
  }

  return {
    resolvedClanTag: null,
    resolvedSource: "unresolved",
    selectedCandidate: null,
    liveCurrentWarFallbackContext: null,
    liveCurrentWarFallbackMember: null,
    persistedFallbackCandidate: null,
    verifiedCandidateCount: 0,
    ambiguousLiveMatchCount: 0,
    candidateCount: candidateEntries.length,
    persistedCandidateCount: candidateEntries.length,
    strongCandidateCount: strongPersistedCandidates.length,
    verifiedAbsentStrongCandidateCount: verifiedAbsentStrongCandidates.length,
    unavailableStrongCandidateCount: unavailableStrongCandidates.length,
  };
}

/** Purpose: keep the freshest CurrentWar row per clan tag when multiple guild rows exist. */
function pickLatestCurrentWarByClanTag(
  rows: Array<{
    clanTag: string;
    warId: number | null;
    state: string | null;
    startTime: Date | null;
    endTime: Date | null;
    updatedAt: Date;
  }>,
): Map<
  string,
  {
    clanTag: string;
    warId: number | null;
    state: string | null;
    startTime: Date | null;
    endTime: Date | null;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      clanTag: string;
      warId: number | null;
      state: string | null;
      startTime: Date | null;
      endTime: Date | null;
      updatedAt: Date;
    }
  >();

  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;

    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        clanTag,
        warId: toFiniteIntOrNull(row.warId),
        state: row.state,
        startTime: row.startTime,
        endTime: row.endTime,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: detect preparation phase so attacks remain zero until battle day starts. */
function isWarStatePreparation(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation");
}

/** Purpose: keep existing CWL helpers on one shared active-phase classifier. */
function isWarStateActive(state: unknown): boolean {
  return isTodoWarStateActive(state);
}

/** Purpose: map war-state values to user-facing phase labels. */
function normalizeWarPhaseLabel(state: unknown): string {
  const normalized = String(state ?? "").toLowerCase();
  if (normalized.includes("preparation")) return "preparation";
  if (normalized.includes("inwar")) return "battle day";
  return "active phase";
}

/** Purpose: compute active-phase end time from persisted CurrentWar state fields. */
function resolveCurrentWarPhaseEnd(input: {
  state: string | null;
  startTime: Date | null;
  endTime: Date | null;
} | null): Date | null {
  if (!input) return null;
  const normalizedState = String(input.state ?? "").toLowerCase();
  if (normalizedState.includes("preparation")) {
    return input.startTime ?? null;
  }
  if (normalizedState.includes("inwar")) {
    return input.endTime ?? null;
  }
  return null;
}

/** Purpose: derive a season-scoped player->CWL-clan map from active CWL wars for tracked CWL clans. */
export function buildActiveCwlClanByPlayerTag(input: {
  cwlWarByClan: Map<string, ClanWar | null>;
  trackedCwlTags: Set<string>;
}): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const [trackedCwlTag, war] of input.cwlWarByClan.entries()) {
    const normalizedTracked = normalizeClanTag(trackedCwlTag);
    if (!normalizedTracked || !input.trackedCwlTags.has(normalizedTracked)) continue;
    if (!war || !isWarStateActive(war.state)) continue;

    const clanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
    const opponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));
    const trackedSideMembers =
      clanTag === normalizedTracked
        ? Array.isArray(war.clan?.members)
          ? war.clan.members
          : []
        : opponentTag === normalizedTracked
          ? Array.isArray(war.opponent?.members)
            ? war.opponent.members
            : []
          : [];
    for (const member of trackedSideMembers) {
      const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
      if (!playerTag) continue;
      mapped.set(playerTag, normalizedTracked);
    }
  }
  return mapped;
}

/** Purpose: load one active CWL war per clan tag with grouped war-tag reuse to avoid duplicate fetches. */
export async function loadActiveCwlWarsByClan(
  cocService: CoCService | undefined,
  clanTags: string[],
  cwlFetchCycleCache?: CwlLeagueFetchSource | null,
): Promise<Map<string, ClanWar | null>> {
  const cwlFetchSource = cwlFetchCycleCache ?? cocService ?? null;
  if (!cwlFetchSource || clanTags.length <= 0) return new Map();

  const cwlWarByWarTag = new Map<string, ClanWar | null>();
  const entries = await Promise.all(
    clanTags.map(async (clanTag) => {
      const war = await resolveActiveCwlWarForClan({
        cocService,
        cwlFetchCycleCache: cwlFetchCycleCache ?? null,
        clanTag,
        cwlWarByWarTag,
      });
      return [clanTag, war] as const;
    }),
  );
  return new Map(entries);
}

/** Purpose: resolve one clan's active CWL war by traversing rounds newest-first with shared war-tag cache. */
async function resolveActiveCwlWarForClan(input: {
  cocService?: CoCService;
  cwlFetchCycleCache?: CwlLeagueFetchSource | null;
  clanTag: string;
  cwlWarByWarTag: Map<string, ClanWar | null>;
}): Promise<ClanWar | null> {
  const cwlFetchSource = input.cwlFetchCycleCache ?? input.cocService ?? null;
  if (!cwlFetchSource) return null;
  const group = await cwlFetchSource
    .getClanWarLeagueGroup(input.clanTag)
    .catch(() => null);
  if (!group || !isWarStateActive(group.state)) {
    return null;
  }

  const rounds = Array.isArray(group.rounds) ? [...group.rounds].reverse() : [];
  for (const round of rounds) {
    const warTags = [
      ...new Set(
        (Array.isArray(round?.warTags) ? round.warTags : [])
          .map((warTag) => String(warTag ?? "").trim())
          .filter((warTag) => warTag.length > 0 && warTag !== "#0"),
      ),
    ];
    if (warTags.length <= 0) continue;

    const wars = await Promise.all(
      warTags.map(async (warTag) => {
        if (input.cwlWarByWarTag.has(warTag)) {
          return input.cwlWarByWarTag.get(warTag) ?? null;
        }
        const war = await cwlFetchSource
          .getClanWarLeagueWar(warTag)
          .catch(() => null);
        input.cwlWarByWarTag.set(warTag, war);
        return war;
      }),
    );

    const activeWar = wars.find((war) => {
      if (!war || !isWarStateActive(war.state)) return false;
      const warClan = normalizeClanTag(String(war.clan?.tag ?? ""));
      const warOpponent = normalizeClanTag(String(war.opponent?.tag ?? ""));
      const targetClan = normalizeClanTag(input.clanTag);
      return warClan === targetClan || warOpponent === targetClan;
    });
    if (activeWar) return activeWar;
  }

  return null;
}

/** Purpose: load one deduped live current-war context per tracked clan for targeted fallback refreshes. */
function buildLiveCurrentWarFallbackContextFromSnapshot(
  clanTag: string,
  war: CurrentWarSnapshot | null,
): LiveCurrentWarFallbackContext | null {
  const observedAt = new Date();
  if (!war || !isTodoWarStateActive(war.state)) {
    return null;
  }
  const side = resolveLiveCurrentWarSide(clanTag, war);
  if (!side) return null;

  const currentWarState = String(war.state ?? "");
  const phaseEndsAt = resolveCurrentWarPhaseEnd({
    state: currentWarState,
    startTime: parseCocTime(war.startTime ?? null),
    endTime: parseCocTime(war.endTime ?? null),
  });
  const attacksAvailable = Math.max(0, clampInt(war.attacksPerMember ?? 2, 0, 2));
  const membersByPlayerTag = new Map<
    string,
    {
      clanTag: string;
      playerName: string;
      townHall: number | null;
      mapPosition: number | null;
      attacksUsed: number;
      attacksAvailable: number;
    }
  >();
  for (const member of side.members) {
    const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
    if (!playerTag) continue;
    membersByPlayerTag.set(playerTag, {
      clanTag,
      playerName: sanitizeDisplayText(member?.name) || playerTag,
      townHall: normalizeRosterInt(member?.townhallLevel ?? null),
      mapPosition: normalizeRosterInt(member?.mapPosition ?? null),
      attacksUsed: isWarStatePreparation(currentWarState)
        ? 0
        : Math.min(2, Array.isArray(member?.attacks) ? member.attacks.length : 0),
      attacksAvailable,
    });
  }

  return {
    clanTag,
    clanName: side.clanName || null,
    currentWarState,
    phaseEndsAt,
    sourceUpdatedAt: observedAt,
    membersByPlayerTag,
  };
}

function buildPreloadedLiveCurrentWarFallbackContextsByClanTag(input: {
  clanTags: string[];
  preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null> | null;
}): Map<string, LiveCurrentWarFallbackContext> {
  const normalizedClanTags = [...new Set(input.clanTags)]
    .map((clanTag) => normalizeClanTag(clanTag))
    .filter((clanTag): clanTag is string => Boolean(clanTag));
  const preloadedCurrentWarSnapshotsByClanTag =
    input.preloadedCurrentWarSnapshotsByClanTag ?? new Map();
  const result = new Map<string, LiveCurrentWarFallbackContext>();
  for (const clanTag of normalizedClanTags) {
    if (!preloadedCurrentWarSnapshotsByClanTag.has(clanTag)) continue;
    const context = buildLiveCurrentWarFallbackContextFromSnapshot(
      clanTag,
      preloadedCurrentWarSnapshotsByClanTag.get(clanTag) ?? null,
    );
    if (context) {
      result.set(clanTag, context);
    }
  }
  return result;
}

async function loadLiveCurrentWarFallbackContextsByClanTag(input: {
  cocService?: CoCService;
  clanTags: string[];
  preloadedCurrentWarSnapshotsByClanTag?: Map<string, CurrentWarSnapshot | null> | null;
  producer?: WarEventLinkedPlayerRefreshProducer | null;
}): Promise<Map<string, LiveCurrentWarFallbackContext>> {
  const normalizedClanTags = [...new Set(input.clanTags)]
    .map((clanTag) => normalizeClanTag(clanTag))
    .filter((clanTag): clanTag is string => Boolean(clanTag));
  const preloadedCurrentWarSnapshotsByClanTag =
    input.preloadedCurrentWarSnapshotsByClanTag ?? new Map();
  const startedAtMs = Date.now();
  const result = buildPreloadedLiveCurrentWarFallbackContextsByClanTag({
    clanTags: normalizedClanTags,
    preloadedCurrentWarSnapshotsByClanTag,
  });
  let preloadedHitCount = 0;
  for (const clanTag of normalizedClanTags) {
    if (preloadedCurrentWarSnapshotsByClanTag.has(clanTag)) {
      preloadedHitCount += 1;
    }
  }

  const missClanTags = normalizedClanTags.filter(
    (clanTag) => !preloadedCurrentWarSnapshotsByClanTag.has(clanTag),
  );
  let fetchedCount = 0;
  let fetchedContextCount = 0;
  if (
    missClanTags.length > 0 &&
    input.cocService &&
    typeof input.cocService.getCurrentWar === "function"
  ) {
    const fetchedEntries = await mapWithConcurrency(
      missClanTags,
      LIVE_CURRENT_WAR_FALLBACK_CONCURRENCY_LIMIT,
      async (clanTag) => {
        fetchedCount += 1;
        const war = await Promise.resolve(input.cocService!.getCurrentWar(clanTag)).catch(
          () => null,
        );
        return [clanTag, buildLiveCurrentWarFallbackContextFromSnapshot(clanTag, war)] as const;
      },
    );
    for (const [clanTag, context] of fetchedEntries) {
      if (context) {
        fetchedContextCount += 1;
        result.set(clanTag, context);
      }
    }
  }

  console.info(
    `[todo-snapshot] event=todo_live_current_war_roster_fallback_fetch source=${input.producer?.source ?? "unknown"} candidate_clan_count=${normalizedClanTags.length} preloaded_current_war_hit_count=${preloadedHitCount} current_war_fetch_miss_count=${missClanTags.length} current_war_fetch_count=${fetchedCount} fetched_context_count=${fetchedContextCount} concurrency_limit=${LIVE_CURRENT_WAR_FALLBACK_CONCURRENCY_LIMIT} duration_ms=${Date.now() - startedAtMs}`,
  );

  return result;
}

/** Purpose: resolve the tracked-clan side of a live current war for fallback enrichment. */
function resolveLiveCurrentWarSide(
  clanTag: string,
  war: ClanWar,
): { clanName: string | null; members: ClanWarMember[] } | null {
  const normalizedClanTag = normalizeClanTag(clanTag);
  const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));

  if (warClanTag === normalizedClanTag && war.clan) {
    return {
      clanName: sanitizeDisplayText(war.clan.name) || null,
      members: Array.isArray(war.clan.members) ? war.clan.members : [],
    };
  }
  if (warOpponentTag === normalizedClanTag && war.opponent) {
    return {
      clanName: sanitizeDisplayText(war.opponent.name) || null,
      members: Array.isArray(war.opponent.members) ? war.opponent.members : [],
    };
  }
  return null;
}

/** Purpose: load one deduped live CWL context per non-tracked clan for targeted manual snapshot refreshes. */
async function loadLiveNonTrackedCwlContextsByClanTag(input: {
  cocService?: CoCService;
  cwlFetchCycleCache?: CwlLeagueFetchSource | null;
  clanTags: string[];
}): Promise<Map<string, LiveCwlClanContext>> {
  const cwlFetchSource = input.cwlFetchCycleCache ?? input.cocService ?? null;
  if (!cwlFetchSource || input.clanTags.length <= 0) {
    return new Map();
  }

  const contexts = await Promise.all(
    [...new Set(input.clanTags)].map(async (clanTag) => {
      const normalizedClanTag = normalizeClanTag(clanTag);
      const group = await cwlFetchSource
        .getClanWarLeagueGroup(clanTag)
        .catch(() => null);
      if (!group) {
        return [clanTag, null] as const;
      }

      const groupClan = Array.isArray(group.clans)
        ? group.clans.find(
            (entry) =>
              normalizeClanTag(String(entry?.tag ?? "")) === normalizedClanTag,
          )
        : null;
      const baseClanName = sanitizeDisplayText(groupClan?.name) || null;
      const rounds = Array.isArray(group.rounds) ? [...group.rounds].reverse() : [];
      let fallbackContext: LiveCwlClanContext | null = null;
      for (const round of rounds) {
        const warTags = [
          ...new Set(
            (Array.isArray(round?.warTags) ? round.warTags : [])
              .map((warTag) => String(warTag ?? "").trim())
              .filter((warTag) => warTag.length > 0 && warTag !== "#0"),
          ),
        ];
        if (warTags.length <= 0) continue;

        for (const warTag of warTags) {
          const war = await cwlFetchSource
            .getClanWarLeagueWar(warTag)
            .catch(() => null);
          if (!war) continue;

          const side = resolveLiveCwlSide(normalizedClanTag, war);
          if (!side) continue;

          const roundState = normalizeRoundState(war.state);
          const roundScore = scoreLiveCwlRoundState(roundState);
          if (roundScore <= 0) {
            continue;
          }

          const phaseEndsAt = resolveCurrentWarPhaseEnd({
            state: roundState,
            startTime: parseCocTime(war.startTime ?? null),
            endTime: parseCocTime(war.endTime ?? null),
          });
          const attacksAvailable = isWarStatePreparation(roundState)
            ? 0
            : Math.max(1, Math.trunc(Number(war.attacksPerMember ?? 1) || 1));
          const membersByPlayerTag = new Map<
            string,
            {
              clanTag: string;
              playerName: string;
              townHall: number | null;
              attacksUsed: number;
              attacksAvailable: number;
              subbedIn: boolean;
              subbedOut: boolean;
            }
          >();
          for (const member of side.members) {
            const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
            if (!playerTag) continue;
            membersByPlayerTag.set(playerTag, {
              clanTag: normalizedClanTag,
              playerName: sanitizeDisplayText(member?.name) || playerTag,
              townHall: Number.isFinite(Number(member?.townhallLevel))
                ? Math.trunc(Number(member?.townhallLevel))
                : null,
              attacksUsed: Array.isArray(member?.attacks) ? member.attacks.length : 0,
              attacksAvailable,
              subbedIn: true,
              subbedOut: false,
            });
          }

          const context: LiveCwlClanContext = {
            clanTag: normalizedClanTag,
            clanName: side.clanName || baseClanName,
            roundState,
            phaseEndsAt,
            membersByPlayerTag,
          };

          if (roundScore >= 2) {
            return [clanTag, context] as const;
          }

          fallbackContext ??= context;
        }
      }

      return [
        clanTag,
        fallbackContext ?? {
          clanTag: normalizedClanTag,
          clanName: baseClanName,
          roundState: "notInWar",
          phaseEndsAt: null,
          membersByPlayerTag: new Map(),
        },
      ] as const;
    }),
  );

  return new Map(
    contexts.filter((entry): entry is [string, LiveCwlClanContext] =>
      Boolean(entry[0] && entry[1]),
    ),
  );
}

/** Purpose: resolve one live CWL war side for a clan tag. */
function resolveLiveCwlSide(
  clanTag: string,
  war: ClanWar,
): { clanName: string | null; members: ClanWarMember[] } | null {
  const normalizedClanTag = normalizeClanTag(clanTag);
  const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));

  if (warClanTag === normalizedClanTag && war.clan) {
    return {
      clanName: sanitizeDisplayText(war.clan.name) || null,
      members: Array.isArray(war.clan.members) ? war.clan.members : [],
    };
  }
  if (warOpponentTag === normalizedClanTag && war.opponent) {
    return {
      clanName: sanitizeDisplayText(war.opponent.name) || null,
      members: Array.isArray(war.opponent.members) ? war.opponent.members : [],
    };
  }
  return null;
}

/** Purpose: normalize live CWL round states into a compact deterministic string. */
function normalizeRoundState(input: unknown): string {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : "notInWar";
}

/** Purpose: rank live CWL round states so active wars win over later preparation rounds. */
function scoreLiveCwlRoundState(state: string): number {
  const normalized = state.toLowerCase();
  if (normalized.includes("inwar")) return 2;
  if (normalized.includes("preparation")) return 1;
  return 0;
}

/** Purpose: resolve live current-clan tags for player tags when CoC access is available. */
async function loadLiveClanTagsByPlayerTag(input: {
  cocService?: CoCService;
  playerTags: string[];
  observedLivePlayerCurrentByTag?: ObservedLivePlayerCurrentByTag;
  producer?: WarEventLinkedPlayerRefreshProducer | null;
}): Promise<Map<string, LiveClanTagEntry>> {
  if (!input.cocService || typeof input.cocService.getPlayerRaw !== "function") {
    return buildObservedLivePlayerCurrentMap(input.playerTags, input.observedLivePlayerCurrentByTag);
  }

  const normalizedTags = normalizePlayerTags(input.playerTags);
  const observedLivePlayerCurrentByTag = input.observedLivePlayerCurrentByTag ?? new Map();
  const plan = resolveWarEventLinkedPlayerRefreshPlanForTest({
    candidateCount: input.playerTags.length,
    dedupedCount: normalizedTags.length,
    pacingMs: input.producer?.pacingMs ?? null,
  });
  const chunkedTags = chunkArray(normalizedTags, plan.chunkSize);
  if (input.producer) {
    console.info(
      `[todo-snapshot] event=war_event_player_refresh_plan source=${input.producer.source} candidate_count=${plan.candidateCount} deduped_count=${plan.dedupedCount} chunk_size=${plan.chunkSize} chunk_count=${plan.chunkCount} stagger_ms=${plan.chunkDelayMs} backlog_threshold=${input.producer.backlogThreshold}`,
    );
  }

  const entries: Array<readonly [string, LiveClanTagEntry]> = [];
  const observedHitTags = new Set<string>();
  let enqueuedCount = 0;
  let deferredCount = 0;
  for (const playerTag of normalizedTags) {
    const observed = observedLivePlayerCurrentByTag.get(playerTag);
    if (!observed) continue;
    observedHitTags.add(playerTag);
    entries.push([
      playerTag,
      {
        clanTag: observed.clanTag,
        clanName: sanitizeDisplayText(observed.clanName ?? "") || null,
        townHall: observed.townHall,
        source: "observed_live",
      },
    ]);
  }

  const fetchTags = chunkedTags
    .map((chunk) => chunk.filter((playerTag) => !observedLivePlayerCurrentByTag.has(playerTag)))
    .filter((chunk) => chunk.length > 0);

  for (let chunkIndex = 0; chunkIndex < fetchTags.length; chunkIndex += 1) {
    if (input.producer) {
      const queueStatus = cocRequestQueueService.getStatus();
      if (queueStatus.backgroundQueueDepth >= input.producer.backlogThreshold) {
        deferredCount = fetchTags
          .slice(chunkIndex)
          .reduce((sum, chunk) => sum + chunk.length, 0);
        console.warn(
          `[todo-snapshot] event=war_event_player_refresh_deferred source=${input.producer.source} reason=background_backlog backlog_depth=${queueStatus.backgroundQueueDepth} threshold=${input.producer.backlogThreshold} deferred_count=${deferredCount}`,
        );
        break;
      }
      if (chunkIndex > 0 && plan.chunkDelayMs > 0) {
        console.info(
          `[todo-snapshot] event=war_event_player_refresh_stagger source=${input.producer.source} chunk_index=${chunkIndex + 1} chunk_count=${fetchTags.length} delay_ms=${plan.chunkDelayMs}`,
        );
        await sleepMs(plan.chunkDelayMs);
      }
    }

    const chunk = fetchTags[chunkIndex];
    if (input.producer) {
      const queueStatus = cocRequestQueueService.getStatus();
      console.info(
        `[todo-snapshot] event=war_event_player_refresh_chunk source=${input.producer.source} chunk_index=${chunkIndex + 1} chunk_count=${fetchTags.length} chunk_size=${chunk.length} background_depth=${queueStatus.backgroundQueueDepth}`,
      );
    }
    const chunkEntries: Array<readonly [string, LiveClanTagEntry] | null> = await Promise.all(
      chunk.map(async (playerTag) => {
        const player = await input.cocService!
          .getPlayerRaw(playerTag, { suppressTelemetry: true })
          .catch(() => null);
        if (!player) {
          return null;
        }
        const clanTag = normalizeClanTag(String(player?.clan?.tag ?? ""));
        const clanName = sanitizeDisplayText(String(player?.clan?.name ?? "")) || null;
        const townHall = normalizeRosterInt(player?.townHallLevel ?? player?.townHall ?? null);
        return [playerTag, { clanTag, clanName, townHall, source: "fetched_live" }] as const;
      }),
    );
    for (const entry of chunkEntries) {
      if (entry) {
        entries.push(entry);
      }
    }
    enqueuedCount += chunk.length;
  }

  if (input.producer) {
    console.info(
      `[todo-snapshot] event=war_event_player_refresh_complete source=${input.producer.source} candidate_count=${plan.candidateCount} deduped_count=${plan.dedupedCount} observed_live_player_hit_count=${observedHitTags.size} live_player_fetch_miss_count=${fetchTags.reduce((sum, chunk) => sum + chunk.length, 0)} fetched_count=${enqueuedCount} deferred_count=${deferredCount}`,
    );
  }

  return new Map(entries.filter((entry): entry is [string, LiveClanTagEntry] => Boolean(entry[0])));
}

function buildObservedLivePlayerCurrentMap(
  playerTags: string[],
  observedLivePlayerCurrentByTag?: ObservedLivePlayerCurrentByTag,
): Map<string, LiveClanTagEntry> {
  const normalizedTags = normalizePlayerTags(playerTags);
  const map = new Map<string, LiveClanTagEntry>();
  if (!observedLivePlayerCurrentByTag || observedLivePlayerCurrentByTag.size <= 0) {
    return map;
  }

  for (const playerTag of normalizedTags) {
    const observed = observedLivePlayerCurrentByTag.get(playerTag);
    if (!observed) continue;
    map.set(playerTag, {
      clanTag: observed.clanTag,
      clanName: sanitizeDisplayText(observed.clanName ?? "") || null,
      townHall: observed.townHall,
      source: "observed_live",
    });
  }
  return map;
}

/** Purpose: load persisted player-current rows without creating a Todo/PlayerCurrent service cycle. */
async function loadPlayerCurrentByTags(tags: string[]): Promise<Map<string, PlayerCurrentLike>> {
  const normalizedTags = normalizePlayerTags(tags);
  if (normalizedTags.length <= 0) {
    return new Map();
  }

  const rows = await prisma.playerCurrent.findMany({
    where: {
      playerTag: { in: normalizedTags },
    },
    select: {
      playerTag: true,
      playerName: true,
      townHall: true,
      currentClanTag: true,
      currentClanName: true,
      trophies: true,
      builderTrophies: true,
      warStars: true,
      expLevel: true,
      role: true,
      leagueName: true,
      currentWeight: true,
      currentWeightSource: true,
      currentWeightMeasuredAt: true,
      achievementsJson: true,
      lastSeenAt: true,
      lastFetchedAt: true,
      lastSource: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const result = new Map<string, PlayerCurrentLike>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    result.set(playerTag, {
      playerTag: row.playerTag,
      playerName: row.playerName,
      townHall: row.townHall,
      currentClanTag: row.currentClanTag,
      currentClanName: row.currentClanName,
      trophies: row.trophies,
      builderTrophies: row.builderTrophies,
      warStars: row.warStars,
      expLevel: row.expLevel,
      role: row.role,
      leagueName: row.leagueName,
      currentWeight: row.currentWeight,
      currentWeightSource: row.currentWeightSource,
      currentWeightMeasuredAt: row.currentWeightMeasuredAt,
      achievementsJson: row.achievementsJson,
      lastSeenAt: row.lastSeenAt,
      lastFetchedAt: row.lastFetchedAt,
      lastSource: row.lastSource,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      source: "player_current",
      liveRefreshInvoked: false,
    });
  }
  return result;
}

function resolveTodoCurrentMembershipContext(input: {
  playerTag: string;
  now: Date;
  liveClanTagEntry: LiveClanTagEntry | null;
  playerCurrent: PlayerCurrentLike | null;
  latestClanMember: { clanTag: string; sourceSyncedAt: Date } | null;
  existingSnapshot: {
    clanTag: string | null;
    clanName: string | null;
    clanMembershipObservedAt: Date | null;
  } | null;
}): TodoCurrentMembershipContext {
  const observedLiveClanTag = normalizeClanTag(input.liveClanTagEntry?.clanTag ?? "");
  if (input.liveClanTagEntry) {
    if (!observedLiveClanTag) {
      return {
        clanTag: null,
        clanName: null,
        observedAt: input.now,
        fresh: true,
        source: "no_clan",
      };
    }
    return {
      clanTag: observedLiveClanTag,
      clanName:
        sanitizeDisplayText(input.liveClanTagEntry.clanName ?? "") || null,
      observedAt: input.now,
      fresh: true,
      source: input.liveClanTagEntry.source,
    };
  }

  const playerCurrentClanTag = normalizeClanTag(input.playerCurrent?.currentClanTag ?? "");
  const playerCurrentFresh =
    input.playerCurrent !== null &&
    !isPlayerCurrentStaleForSignup(
      input.playerCurrent,
      input.now,
      TODO_CURRENT_MEMBERSHIP_MAX_AGE_MS,
    );
  if (input.playerCurrent) {
    if (playerCurrentFresh) {
      return {
        clanTag: playerCurrentClanTag || null,
        clanName: playerCurrentClanTag
          ? sanitizeDisplayText(input.playerCurrent.currentClanName ?? "") || null
          : null,
        observedAt: input.playerCurrent.lastFetchedAt ?? input.playerCurrent.updatedAt ?? input.now,
        fresh: true,
        source: playerCurrentClanTag ? "player_current" : "no_clan",
      };
    }
  }

  const latestClanMemberClanTag = normalizeClanTag(input.latestClanMember?.clanTag ?? "");
  const latestClanMemberFresh =
    input.latestClanMember !== null &&
    !isPlayerCurrentStaleForSignup(
      { lastFetchedAt: input.latestClanMember.sourceSyncedAt },
      input.now,
      TODO_CURRENT_MEMBERSHIP_MAX_AGE_MS,
    );
  if (latestClanMemberClanTag && latestClanMemberFresh) {
    return {
      clanTag: latestClanMemberClanTag,
      clanName: null,
      observedAt: input.latestClanMember?.sourceSyncedAt ?? input.now,
      fresh: true,
      source: "fwa_member",
    };
  }

  const existingClanTag = normalizeClanTag(input.existingSnapshot?.clanTag ?? "");
  if (existingClanTag) {
    return {
      clanTag: existingClanTag,
      clanName: sanitizeDisplayText(input.existingSnapshot?.clanName ?? "") || null,
      observedAt: input.existingSnapshot?.clanMembershipObservedAt ?? null,
      fresh: false,
      source: "existing",
    };
  }

  return {
    clanTag: null,
    clanName: null,
    observedAt: null,
    fresh: false,
    source: "none",
  };
}

function buildObservedLivePlayerCurrentByTag(
  observedRows: ObservedLivePlayerCurrent[],
): ObservedLivePlayerCurrentByTag {
  const map: ObservedLivePlayerCurrentByTag = new Map();
  for (const row of observedRows) {
    const playerTag = normalizePlayerTag(String(row?.playerTag ?? ""));
    if (!playerTag || map.has(playerTag)) continue;
    map.set(playerTag, {
      clanTag: normalizeClanTag(String(row?.clanTag ?? "")) || "",
      clanName: sanitizeDisplayText(String(row?.clanName ?? "")) || null,
      townHall: normalizeRosterInt(row?.townHall ?? null),
    });
  }
  return map;
}

function buildRaidCandidateClanEntriesByPlayerTag(input: {
  playerTags: string[];
  currentMembershipByPlayerTag: Map<string, TodoCurrentMembershipContext>;
  existingByTag: Map<string, TodoSnapshotRecord>;
  trackedClanRows: Array<{ tag: string; name: string | null }>;
  raidTrackedClanRows: Array<{ clanTag: string; name: string | null }>;
}): LiveRaidCandidateClanEntriesByPlayerTag {
  const trackedClanNameByTag = new Map(
    input.trackedClanRows
      .map((row) => [
        normalizeClanTag(row.tag),
        sanitizeDisplayText(String(row.name ?? "")),
      ] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );
  const raidTrackedClanNameByTag = new Map(
    input.raidTrackedClanRows
      .map((row) => [
        normalizeClanTag(row.clanTag),
        sanitizeDisplayText(String(row.name ?? "")),
      ] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );
  const candidateClanEntriesByPlayerTag: LiveRaidCandidateClanEntriesByPlayerTag = new Map();

  const addCandidateClanEntry = (
    candidateClanEntries: LiveRaidCandidateClanEntry[],
    clanTag: string | null | undefined,
    clanName: string | null | undefined,
  ): void => {
    const normalizedClanTag = normalizeClanTag(String(clanTag ?? ""));
    if (!normalizedClanTag) return;
    const normalizedClanName = sanitizeDisplayText(String(clanName ?? "")) || null;
    const existing = candidateClanEntries.find((entry) => entry.clanTag === normalizedClanTag);
    if (!existing) {
      candidateClanEntries.push({
        clanTag: normalizedClanTag,
        clanName: normalizedClanName,
      });
      return;
    }
    if (!existing.clanName && normalizedClanName) {
      existing.clanName = normalizedClanName;
    }
  };

  const resolvePersistedRaidClanName = (params: {
    playerTag: string;
    clanTag: string;
  }): string | null => {
    const existing = input.existingByTag.get(params.playerTag) ?? null;
    const normalizedClanTag = normalizeClanTag(params.clanTag);
    if (!existing || !normalizedClanTag || !existing.raidActive) {
      return null;
    }

    const activeRaidClanTag = normalizeClanTag(existing.raidClanTag ?? "");
    if (activeRaidClanTag && activeRaidClanTag === normalizedClanTag) {
      return sanitizeDisplayText(existing.raidClanName ?? "") || null;
    }

    const legacyActiveClanTag = normalizeClanTag(existing.clanTag ?? "");
    if (legacyActiveClanTag && legacyActiveClanTag === normalizedClanTag) {
      return (
        sanitizeDisplayText(existing.raidClanName ?? "") ||
        sanitizeDisplayText(existing.clanName ?? "") ||
        trackedClanNameByTag.get(normalizedClanTag) ||
        raidTrackedClanNameByTag.get(normalizedClanTag) ||
        null
      );
    }

    return null;
  };

  for (const playerTag of normalizePlayerTags(input.playerTags)) {
    const candidateClanEntries: LiveRaidCandidateClanEntry[] = [];
    const existing = input.existingByTag.get(playerTag) ?? null;
    const persistedActiveRaidClanTag = existing?.raidActive
      ? normalizeClanTag(existing.raidClanTag ?? "") ||
        normalizeClanTag(existing.clanTag ?? "") ||
        null
      : null;
    if (persistedActiveRaidClanTag) {
      addCandidateClanEntry(candidateClanEntries, persistedActiveRaidClanTag, resolvePersistedRaidClanName({
        playerTag,
        clanTag: persistedActiveRaidClanTag,
      }));
    }

    const currentMembership = input.currentMembershipByPlayerTag.get(playerTag) ?? null;
    addCandidateClanEntry(
      candidateClanEntries,
      currentMembership?.clanTag ?? null,
      currentMembership?.clanName ?? null,
    );

    for (const row of input.trackedClanRows) {
      addCandidateClanEntry(candidateClanEntries, row.tag, row.name);
    }
    for (const row of input.raidTrackedClanRows) {
      addCandidateClanEntry(candidateClanEntries, row.clanTag, row.name);
    }

    candidateClanEntriesByPlayerTag.set(playerTag, candidateClanEntries);
  }

  return candidateClanEntriesByPlayerTag;
}

/** Purpose: fetch active raid-season member context once per clan and fan out by player tag. */
async function loadLiveRaidContextByPlayerTag(input: {
  cocService?: CoCService;
  raidWindow: TodoWindow;
  candidateClanEntriesByPlayerTag: LiveRaidCandidateClanEntriesByPlayerTag;
}): Promise<{
  byPlayerTag: Map<string, LiveRaidContext>;
  clanFetchFailureCount: number;
}> {
  if (!input.raidWindow.active) {
    return {
      byPlayerTag: new Map(),
      clanFetchFailureCount: 0,
    };
  }

  const playerTags = [...input.candidateClanEntriesByPlayerTag.keys()];
  const unavailableResult = (): {
    byPlayerTag: Map<string, LiveRaidContext>;
    clanFetchFailureCount: number;
  } => {
    const byPlayerTag = new Map<string, LiveRaidContext>();
    for (const playerTag of playerTags) {
      byPlayerTag.set(playerTag, {
        status: "unavailable",
        raidClanTag: null,
        raidClanName: null,
        attacksUsed: 0,
      });
    }
    return {
      byPlayerTag,
      clanFetchFailureCount: 0,
    };
  };

  if (
    !input.cocService ||
    typeof input.cocService.getClanCapitalRaidSeasons !== "function"
  ) {
    return unavailableResult();
  }

  const clanTags = [
    ...new Set(
      [...input.candidateClanEntriesByPlayerTag.values()]
        .flatMap((candidateClanEntries) => candidateClanEntries)
        .map((entry) => normalizeClanTag(entry.clanTag))
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  if (clanTags.length <= 0) return unavailableResult();

  const raidContextByPlayerTag = new Map<string, LiveRaidContext>();
  const clanFetchResults = await Promise.allSettled(
    clanTags.map(async (clanTag) => {
      const seasons = await input.cocService!.getClanCapitalRaidSeasons(clanTag, 2);
      return { clanTag, seasons };
    }),
  );
  const clanMemberMaps: Array<
    readonly [
      string,
      {
        seasonFound: boolean;
        memberAttacksByTag: Map<string, number>;
      },
    ]
  > = [];
  let clanFetchFailureCount = 0;
  const failedClanTags = new Set<string>();
  for (let index = 0; index < clanFetchResults.length; index += 1) {
    const result = clanFetchResults[index];
    const clanTag = clanTags[index] ?? "";
    if (result.status === "rejected") {
      clanFetchFailureCount += 1;
      failedClanTags.add(clanTag);
      continue;
    }
    const { clanTag: resolvedClanTag, seasons } = result.value;
    const season = selectRelevantRaidSeason({
      seasons,
      raidWindow: input.raidWindow,
    });
    const memberAttacksByTag = new Map<string, number>();
    for (const member of Array.isArray(season?.members) ? season.members : []) {
      const memberTag = normalizePlayerTag(String(member?.tag ?? ""));
      if (!memberTag) continue;
      memberAttacksByTag.set(memberTag, clampInt(member?.attacks, 0, 6));
    }
    clanMemberMaps.push([resolvedClanTag, { seasonFound: Boolean(season), memberAttacksByTag }] as const);
  }
  const memberAttacksByClanTag = new Map(clanMemberMaps);

  for (const [playerTag, candidateClanEntries] of input.candidateClanEntriesByPlayerTag.entries()) {
    const primaryEntry = candidateClanEntries[0] ?? null;
    const primaryClanTag = primaryEntry?.clanTag ?? null;
    const primaryContext =
      primaryClanTag !== null ? memberAttacksByClanTag.get(primaryClanTag) ?? null : null;
    const primaryAttacksUsed = primaryContext?.memberAttacksByTag.get(playerTag);
    if (primaryContext?.seasonFound && primaryAttacksUsed !== undefined) {
      raidContextByPlayerTag.set(playerTag, {
        status: "observed",
        raidClanTag: primaryClanTag,
        raidClanName: sanitizeDisplayText(primaryEntry?.clanName ?? "") || null,
        attacksUsed: clampInt(primaryAttacksUsed, 0, 6),
      });
      continue;
    }

    const fallbackMatch = candidateClanEntries.slice(1).find((entry) => {
      const members = memberAttacksByClanTag.get(entry.clanTag) ?? null;
      return Boolean(members?.seasonFound && members.memberAttacksByTag.has(playerTag));
    });
    if (fallbackMatch) {
      const members = memberAttacksByClanTag.get(fallbackMatch.clanTag) ?? null;
      raidContextByPlayerTag.set(playerTag, {
        status: "observed",
        raidClanTag: fallbackMatch.clanTag,
        raidClanName: sanitizeDisplayText(fallbackMatch.clanName ?? "") || null,
        attacksUsed: clampInt(members?.memberAttacksByTag.get(playerTag) ?? 0, 0, 6),
      });
      continue;
    }

    const hasFailedCandidate = candidateClanEntries.some((entry) =>
      failedClanTags.has(entry.clanTag),
    );
    if (hasFailedCandidate) {
      raidContextByPlayerTag.set(playerTag, {
        status: "failed",
        raidClanTag: null,
        raidClanName: null,
        attacksUsed: 0,
      });
      continue;
    }

    if (candidateClanEntries.length > 0) {
      raidContextByPlayerTag.set(playerTag, {
        status: "observed",
        raidClanTag: null,
        raidClanName: null,
        attacksUsed: 0,
      });
      continue;
    }

    raidContextByPlayerTag.set(playerTag, {
      status: "unavailable",
      raidClanTag: null,
      raidClanName: null,
      attacksUsed: 0,
    });
  }

  return {
    byPlayerTag: raidContextByPlayerTag,
    clanFetchFailureCount,
  };
}

/** Purpose: choose one canonical raid season aligned to the active todo raid window. */
function selectRelevantRaidSeason(input: {
  seasons: ClanCapitalRaidSeason[];
  raidWindow: TodoWindow;
}): ClanCapitalRaidSeason | null {
  if (!Array.isArray(input.seasons) || input.seasons.length <= 0) {
    return null;
  }

  const withTimes = input.seasons.map((season) => ({
    season,
    startMs: parseCocTime(season.startTime ?? null)?.getTime() ?? null,
    endMs: parseCocTime(season.endTime ?? null)?.getTime() ?? null,
  }));

  const exact = withTimes.find(
    (entry) =>
      entry.startMs === input.raidWindow.startMs ||
      entry.endMs === input.raidWindow.endMs,
  );
  if (exact) return exact.season;

  const nearestByEnd = [...withTimes]
    .filter((entry): entry is { season: ClanCapitalRaidSeason; startMs: number | null; endMs: number } => entry.endMs !== null)
    .sort(
      (a, b) =>
        Math.abs(a.endMs - input.raidWindow.endMs) -
        Math.abs(b.endMs - input.raidWindow.endMs),
    )[0];
  if (nearestByEnd) return nearestByEnd.season;

  return input.seasons[0];
}

/** Purpose: compute the current or next raid-weekend window with UTC-safe boundaries. */
function resolveRaidWeekendWindow(nowMs: number): TodoWindow {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const now = new Date(nowMs);
  const dayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const fridayDayOffset = (now.getUTCDay() - 5 + 7) % 7;
  let fridayStartMs = dayStartMs - fridayDayOffset * dayMs + 7 * hourMs;
  if (nowMs < fridayStartMs) {
    fridayStartMs -= 7 * dayMs;
  }
  const raidEndMs = fridayStartMs + 3 * dayMs;

  if (nowMs >= fridayStartMs && nowMs < raidEndMs) {
    return { active: true, startMs: fridayStartMs, endMs: raidEndMs };
  }
  const nextStartMs = fridayStartMs + 7 * dayMs;
  return {
    active: false,
    startMs: nextStartMs,
    endMs: nextStartMs + 3 * dayMs,
  };
}

/** Purpose: expose raid-weekend window resolution for isolated tests. */
export const resolveRaidWeekendWindowForTest = resolveRaidWeekendWindow;

/** Purpose: build one UTC-safe Clan Games cycle boundary set for a specific calendar month. */
function buildClanGamesCycleBoundary(
  year: number,
  month: number,
): {
  startMs: number;
  earningEndsMs: number;
  rewardCollectionEndsMs: number;
} {
  const earningEndsMs = Date.UTC(year, month, 28, 8, 0, 0, 0);
  return {
    startMs: Date.UTC(year, month, 22, 8, 0, 0, 0),
    earningEndsMs,
    rewardCollectionEndsMs:
      earningEndsMs + TODO_GAMES_REWARD_COLLECTION_DURATION_MS,
  };
}

/** Purpose: compute current Clan Games earning/reward phase with exact reward-collection cutoff in UTC. */
function resolveClanGamesWindow(nowMs: number): TodoClanGamesWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const current = buildClanGamesCycleBoundary(year, month);

  if (nowMs >= current.startMs && nowMs < current.earningEndsMs) {
    return {
      active: true,
      rewardCollectionActive: false,
      startMs: current.startMs,
      endMs: current.earningEndsMs,
      rewardCollectionEndsMs: current.rewardCollectionEndsMs,
    };
  }

  if (nowMs >= current.earningEndsMs && nowMs < current.rewardCollectionEndsMs) {
    return {
      active: false,
      rewardCollectionActive: true,
      startMs: current.startMs,
      endMs: current.earningEndsMs,
      rewardCollectionEndsMs: current.rewardCollectionEndsMs,
    };
  }

  if (nowMs < current.startMs) {
    const previous = buildClanGamesCycleBoundary(year, month - 1);
    if (
      nowMs >= previous.earningEndsMs &&
      nowMs < previous.rewardCollectionEndsMs
    ) {
      return {
        active: false,
        rewardCollectionActive: true,
        startMs: previous.startMs,
        endMs: previous.earningEndsMs,
        rewardCollectionEndsMs: previous.rewardCollectionEndsMs,
      };
    }
    return {
      active: false,
      rewardCollectionActive: false,
      startMs: current.startMs,
      endMs: current.earningEndsMs,
      rewardCollectionEndsMs: current.rewardCollectionEndsMs,
    };
  }

  const next = buildClanGamesCycleBoundary(year, month + 1);
  return {
    active: false,
    rewardCollectionActive: false,
    startMs: next.startMs,
    endMs: next.earningEndsMs,
    rewardCollectionEndsMs: next.rewardCollectionEndsMs,
  };
}

export const resolveClanGamesWindowForTest = resolveClanGamesWindow;
