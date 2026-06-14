import { ClanWar, type ClanWarMember } from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildPlayerSignalStateKey,
  extractGamesChampionTotalFromSignalState,
} from "./ActivitySignalService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import type { CwlLeagueFetchSource } from "./CwlFetchCycleCache";
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
      const cwlDiscoveryClanTag = normalizeClanTag(
        resolvedMembership.clanTag ?? livePlayer?.clanTag ?? observedLivePlayer?.clanTag ?? "",
      ) || null;
      cwlDiscoveryClanTagByPlayerTag.set(playerTag, cwlDiscoveryClanTag);
    }
    if (input.includeNonTrackedCwlRefresh) {
      try {
        await cwlStateService.refreshSeasonalCwlClanMappingsForPlayerTags({
          cocService: input.cocService,
          cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
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
    const [currentWarRows, cwlTrackedClanRows, cwlSeasonMappingRows, currentCwlRoundRows, currentCwlMemberRows] =
      await Promise.all([
        clanTags.length > 0
          ? prisma.currentWar.findMany({
              where: { clanTag: { in: clanTags } },
              select: {
                clanTag: true,
                warId: true,
                state: true,
                startTime: true,
                endTime: true,
                updatedAt: true,
              },
            })
          : Promise.resolve([]),
        prisma.cwlTrackedClan.findMany({
          where: { season: currentCwlSeason },
          select: { tag: true, name: true },
        }),
        prisma.cwlPlayerClanSeason.findMany({
          where: {
            season: currentCwlSeason,
            playerTag: { in: normalizedTags },
          },
          select: {
            playerTag: true,
            cwlClanTag: true,
          },
        }),
        prisma.currentCwlRound.findMany({
          where: {
            season: currentCwlSeason,
          },
          select: {
            season: true,
            clanTag: true,
            clanName: true,
            roundState: true,
            startTime: true,
            endTime: true,
          },
        }),
        prisma.cwlRoundMemberCurrent.findMany({
          where: {
            season: currentCwlSeason,
            playerTag: { in: normalizedTags },
          },
          select: {
            season: true,
            clanTag: true,
            playerTag: true,
            attacksUsed: true,
            attacksAvailable: true,
            subbedIn: true,
          },
        }),
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
    const activeTrackedCurrentWarByClanTag = new Map<string, TodoTrackedCurrentWarRow>();
    for (const [clanTag, currentWar] of currentWarByClanTag.entries()) {
      if (!trackedClanTagSet.has(clanTag)) continue;
      if (!isTodoWarStateActive(currentWar.state ?? "")) continue;
      activeTrackedCurrentWarByClanTag.set(clanTag, {
        clanTag,
        warId: toFiniteIntOrNull(currentWar.warId),
        startTime: currentWar.startTime ?? null,
        state: currentWar.state ?? null,
      });
    }
    const activeTrackedClanTags = [...activeTrackedCurrentWarByClanTag.keys()];
    const rosterCurrentRows: Array<{ clanTag: string }> =
      activeTrackedClanTags.length > 0
        ? await prisma.fwaTrackedClanWarRosterCurrent.findMany({
            where: { clanTag: { in: activeTrackedClanTags } },
            select: { clanTag: true },
          })
        : [];
    const rosterCurrentClanTagSet = new Set(
      rosterCurrentRows.map((row) => normalizeClanTag(row.clanTag)).filter(Boolean),
    );
    const activeTrackedWarRosterRows = trackedWarRosterRows.filter((row) => {
      const clanTag = normalizeClanTag(row.clanTag);
      return Boolean(
        clanTag &&
          activeTrackedCurrentWarByClanTag.has(clanTag) &&
          rosterCurrentClanTagSet.has(clanTag),
      );
    });
    const activeTrackedWarClanTagByPlayerTag = new Map<string, string>();
    for (const row of activeTrackedWarRosterRows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const clanTag = normalizeClanTag(row.clanTag);
      if (!playerTag || !clanTag || activeTrackedWarClanTagByPlayerTag.has(playerTag)) {
        continue;
      }
      activeTrackedWarClanTagByPlayerTag.set(playerTag, clanTag);
    }
    const activeTrackedWarRosterByClanAndPlayer = new Map(
      activeTrackedWarRosterRows.map((row) => [
        `${normalizeClanTag(row.clanTag)}:${normalizePlayerTag(row.playerTag)}`,
        row,
      ] as const),
    );
    const allowedFwaWarMemberFallbackByPlayerTag = new Map<string, WarMemberCurrentRow>();
    for (const row of fwaWarMemberFallbackByClanAndPlayer.values()) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const clanTag = normalizeClanTag(row.clanTag);
      if (!playerTag || !clanTag) continue;
      if (!activeTrackedCurrentWarByClanTag.has(clanTag)) continue;
      if (activeTrackedWarRosterByClanAndPlayer.has(`${clanTag}:${playerTag}`)) continue;

      const existing = allowedFwaWarMemberFallbackByPlayerTag.get(playerTag);
      if (!existing || isBetterWarMemberFallbackCandidate(row, existing)) {
        allowedFwaWarMemberFallbackByPlayerTag.set(playerTag, row);
      }
    }
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
    const liveCurrentWarCandidateClanTagsByPlayerTag = new Map<string, string[]>();
    const liveCurrentWarFallbackCandidateTagsByClanTag = new Map<string, Set<string>>();
    const liveCurrentWarCandidateClanTags = new Set<string>();
    for (const playerTag of normalizedTags) {
      const activeTrackedClanTag = activeTrackedWarClanTagByPlayerTag.get(playerTag) ?? null;
      if (activeTrackedClanTag || allowedFwaWarMemberFallbackByPlayerTag.has(playerTag)) {
        continue;
      }
      const currentMembershipClanTag = currentMembershipByPlayerTag.get(playerTag)?.clanTag ?? null;
      const existingSnapshot = existingByTag.get(playerTag) ?? null;
      const legacyWarHintClanTag =
        normalizeClanTag(existingSnapshot?.warClanTag ?? "") ||
        (existingSnapshot?.warActive
          ? normalizeClanTag(existingSnapshot?.clanTag ?? "")
          : null);
      const candidateClanTags = [
        trackedClanTagSet.has(normalizeClanTag(currentMembershipClanTag ?? ""))
          ? currentMembershipClanTag
          : null,
        legacyWarHintClanTag && trackedClanTagSet.has(legacyWarHintClanTag)
          ? legacyWarHintClanTag
          : null,
      ]
        .map((clanTag) => normalizeClanTag(clanTag ?? ""))
        .filter((clanTag): clanTag is string => Boolean(clanTag));
      const orderedUniqueClanTags = [...new Set(candidateClanTags)];
      if (orderedUniqueClanTags.length <= 0) {
        continue;
      }
      liveCurrentWarCandidateClanTagsByPlayerTag.set(playerTag, orderedUniqueClanTags);
      for (const clanTag of orderedUniqueClanTags) {
        liveCurrentWarCandidateClanTags.add(clanTag);
        const candidateTags =
          liveCurrentWarFallbackCandidateTagsByClanTag.get(clanTag) ?? new Set<string>();
        candidateTags.add(playerTag);
        liveCurrentWarFallbackCandidateTagsByClanTag.set(clanTag, candidateTags);
      }
    }
    const liveCurrentWarFallbackByClanTag = await loadLiveCurrentWarFallbackContextsByClanTag({
      cocService: input.cocService,
      clanTags: [...liveCurrentWarCandidateClanTags],
      preloadedCurrentWarSnapshotsByClanTag:
        input.preloadedCurrentWarSnapshotsByClanTag ?? null,
      producer: input.producer ?? null,
    });
    for (const [clanTag, candidateTags] of liveCurrentWarFallbackCandidateTagsByClanTag.entries()) {
      const context = liveCurrentWarFallbackByClanTag.get(clanTag) ?? null;
      if (!context) continue;

      const matchedTags = [...candidateTags].filter((playerTag) =>
        context.membersByPlayerTag.has(playerTag),
      );
      if (matchedTags.length <= 0) continue;

      const missingTags = [...candidateTags].filter(
        (playerTag) => !context.membersByPlayerTag.has(playerTag),
      );
      console.info(
        `[todo-snapshot] event=todo_live_current_war_roster_fallback_used clanTag=${clanTag} currentWarState=${context.currentWarState} linkedCandidateCount=${candidateTags.size} matchedRosterCount=${matchedTags.length} missingRosterCount=${missingTags.length} source=live_current_war sampleTags=${matchedTags.slice(0, 3).join(",") || "none"}`,
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
          cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
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

    const snapshotUpserts: Array<
      Parameters<typeof prisma.todoPlayerSnapshot.upsert>[0]
    > = [];
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

    for (const playerTag of normalizedTags) {
      const existing = existingByTag.get(playerTag);
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
      const activeRosterClanTag = activeTrackedWarClanTagByPlayerTag.get(playerTag) ?? null;
      const activeRosterWarKey = activeRosterClanTag ? `${activeRosterClanTag}:${playerTag}` : "";
      const activeRosterRow = activeRosterWarKey
        ? activeTrackedWarRosterByClanAndPlayer.get(
            activeRosterWarKey as `${string}:${string}`,
          ) ?? null
        : null;
      const allowedFallbackWarMember =
        allowedFwaWarMemberFallbackByPlayerTag.get(playerTag) ?? null;
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
      const candidateLiveCurrentWarClanTags =
        liveCurrentWarCandidateClanTagsByPlayerTag.get(playerTag) ?? [];
      let liveCurrentWarFallbackContext: LiveCurrentWarFallbackContext | null = null;
      let liveCurrentWarFallbackMember:
        | {
            clanTag: string;
            playerName: string;
            townHall: number | null;
            mapPosition: number | null;
            attacksUsed: number;
            attacksAvailable: number;
          }
        | null = null;
      for (const candidateClanTag of candidateLiveCurrentWarClanTags) {
        const candidateContext = liveCurrentWarFallbackByClanTag.get(candidateClanTag) ?? null;
        if (!candidateContext) continue;
        const candidateMember = candidateContext.membersByPlayerTag.get(playerTag) ?? null;
        if (!candidateMember) continue;
        liveCurrentWarFallbackContext = candidateContext;
        liveCurrentWarFallbackMember = candidateMember;
        break;
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
        ) ||
        normalizeClanTag(existing?.cwlClanTag ?? "") ||
        null;
      const liveNonTrackedCwlContext =
        resolvedCwlClanTag && !cwlTrackedTagSet.has(resolvedCwlClanTag)
          ? liveNonTrackedCwlContextByClanTag.get(resolvedCwlClanTag) ?? null
          : null;
      const liveNonTrackedCwlMember = liveNonTrackedCwlContext
        ? liveNonTrackedCwlContext.membersByPlayerTag.get(playerTag) ?? null
        : null;
      const resolvedLiveCwlClanTag =
        normalizeClanTag(liveNonTrackedCwlContext?.clanTag ?? "") || null;
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
        sanitizeDisplayText(existing?.cwlClanName ?? "") ||
        null;
      const persistedCurrentCwlRound = finalResolvedCwlClanTag
        ? currentCwlRoundByClanTag.get(finalResolvedCwlClanTag) ?? null
        : null;
      const currentCwlRound = liveNonTrackedCwlContext ?? persistedCurrentCwlRound;
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
      const cwlHasContext = Boolean(
        currentCwlRound ||
          liveNonTrackedCwlContext ||
          existing?.cwlClanTag ||
          existing?.cwlClanName,
      );
      const cwlActive = cwlHasContext && cwlParticipant;
      const cwlPhase = cwlHasContext
        ? normalizeWarPhaseLabel(
            currentCwlRound?.roundState ?? persistedCurrentCwlRound?.roundState ?? "",
          )
        : null;
      const cwlEndsAt = liveNonTrackedCwlContext?.phaseEndsAt
        ? liveNonTrackedCwlContext.phaseEndsAt
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

      const warClanTag =
        normalizeClanTag(activeRosterClanTag ?? "") ||
        normalizeClanTag(allowedFallbackWarMember?.clanTag ?? "") ||
        normalizeClanTag(liveCurrentWarFallbackContext?.clanTag ?? "") ||
        null;
      const warTrackedClanActive = Boolean(
        warClanTag && activeTrackedCurrentWarByClanTag.has(warClanTag),
      );
      const currentWar = warClanTag
        ? currentWarByClanTag.get(warClanTag) ?? null
        : null;
      const warState = liveCurrentWarFallbackMember
        ? liveCurrentWarFallbackContext?.currentWarState ?? ""
        : currentWar?.state ?? "";
      const warStateActive = isTodoWarStateActive(warState);
      const warStatePreparation = isWarStatePreparation(warState);

      const warMemberKey = warClanTag ? `${warClanTag}:${playerTag}` : "";
      const trackedWarMember =
        warTrackedClanActive && activeRosterRow && warMemberKey
          ? activeTrackedWarMemberByClanAndTag.get(warMemberKey) ?? null
          : null;
      const allowedFallbackWarMemberForWarClan =
        allowedFallbackWarMember &&
        warMemberKey === `${normalizeClanTag(allowedFallbackWarMember.clanTag)}:${playerTag}`
          ? allowedFallbackWarMember
          : null;
      const warMember =
        trackedWarMember ??
        allowedFallbackWarMemberForWarClan ??
        liveCurrentWarFallbackMember ??
        null;
      if (
        allowedFallbackWarMemberForWarClan &&
        warMember === allowedFallbackWarMemberForWarClan
      ) {
        fallbackWarMemberUsedClanTags.add(allowedFallbackWarMemberForWarClan.clanTag);
        fallbackWarMemberUsedPlayerTags.add(playerTag);
      }
      const warStateSourceEndsAt = liveCurrentWarFallbackContext
        ? liveCurrentWarFallbackContext.phaseEndsAt ?? null
        : currentWar
          ? resolveCurrentWarPhaseEnd(currentWar)
          : null;
      const warActive =
        warStateActive &&
        warMember !== null &&
        Boolean(warClanTag && trackedClanTagSet.has(warClanTag));
      const warPhase = warActive
        ? normalizeWarPhaseLabel(warState)
        : null;
      const warEndsAt = warActive ? warStateSourceEndsAt : null;
      const warAttacksUsed = !warActive
        ? 0
        : warStatePreparation
          ? 0
          : trackedWarMember
            ? clampInt(trackedWarMember.attacksUsed, 0, 2)
            : allowedFallbackWarMemberForWarClan
              ? clampInt(allowedFallbackWarMemberForWarClan.attacks, 0, 2)
              : liveCurrentWarFallbackMember
                ? clampInt(liveCurrentWarFallbackMember.attacksUsed, 0, 2)
                : 0;
      const resolvedPlayerName =
        sanitizeDisplayText(activeRosterRow?.playerName ?? "") ||
        sanitizeDisplayText(allowedFallbackWarMemberForWarClan?.playerName ?? "") ||
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
          activeRosterRow?.townHall !== null &&
          activeRosterRow?.townHall !== undefined &&
          activeRosterRow.townHall > 0
        ) {
          return activeRosterRow.townHall;
        }
        if (
          allowedFallbackWarMemberForWarClan?.townHall !== null &&
          allowedFallbackWarMemberForWarClan?.townHall !== undefined &&
          allowedFallbackWarMemberForWarClan.townHall > 0
        ) {
          return allowedFallbackWarMemberForWarClan.townHall;
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
        warClanTag,
        warClanName:
          (warClanTag ? trackedClanNameByTag.get(warClanTag) : null) ||
          (warClanTag ? raidTrackedClanNameByTag.get(warClanTag) : null) ||
          (warClanTag ? liveCurrentWarFallbackContext?.clanName : null) ||
          null,
        warPosition:
          trackedWarMember
            ? toFiniteIntOrNull(trackedWarMember.position)
            : allowedFallbackWarMemberForWarClan
              ? toFiniteIntOrNull(allowedFallbackWarMemberForWarClan.position)
              : liveCurrentWarFallbackMember
                ? toFiniteIntOrNull(liveCurrentWarFallbackMember.mapPosition ?? null)
                : null,
        warSourceUpdatedAt:
          trackedWarMember && currentWar
            ? currentWar.updatedAt
            : allowedFallbackWarMemberForWarClan?.sourceSyncedAt ??
              liveCurrentWarFallbackContext?.sourceUpdatedAt ??
              null,
        clanMembershipObservedAt: membershipContext.observedAt ?? null,
        cwlClanTag: resolvedCwlClanTag,
        cwlClanName: resolvedCwlClanName,
        warActive,
        warAttacksUsed,
        warAttacksMax: 2,
        warPhase,
        warEndsAt,
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
        trackedWarMember && currentWar
          ? "tracked_roster"
          : allowedFallbackWarMemberForWarClan
            ? "war_member"
            : liveCurrentWarFallbackMember
              ? "live_current_war"
              : "none";
      if (warActive && data.warPosition === null) {
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
      `[todo-snapshot] event=raid_snapshot_refresh now_ms=${nowMs} raid_start_ms=${raidWindow.startMs} raid_end_ms=${raidWindow.endMs} raid_active=${raidWindow.active} player_count=${normalizedTags.length} raid_active_rows=${raidActiveTrueCount} raid_inactive_rows=${raidActiveFalseCount} raid_observed_count=${raidObservedCount} raid_preserved_unavailable_count=${raidPreservedUnavailableCount} raid_preserved_failed_count=${raidPreservedFailedCount} raid_authoritative_clear_count=${raidAuthoritativeClearCount} raid_expired_context_clear_count=${raidExpiredContextClearCount} raid_clan_fetch_failure_count=${liveRaidContextLookup.clanFetchFailureCount}`,
    );

    try {
      await runChunkedWrites(
        snapshotUpserts,
        TODO_SNAPSHOT_WRITE_CHUNK_SIZE,
        async (upsert) => {
          await prisma.todoPlayerSnapshot.upsert(upsert);
        },
      );
    } catch (err) {
      console.error(
        `[todo-snapshot] persist_failed players=${normalizedTags.length} snapshots=${snapshotUpserts.length} error=${formatError(err)}`,
      );
      throw err;
    }

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

/** Purpose: choose one deterministic raw-war fallback row when tracked roster members are missing. */
function isBetterWarMemberFallbackCandidate(
  candidate: WarMemberCurrentRow,
  existing: WarMemberCurrentRow,
): boolean {
  const candidateSyncedAt = candidate.sourceSyncedAt.getTime();
  const existingSyncedAt = existing.sourceSyncedAt.getTime();
  if (candidateSyncedAt !== existingSyncedAt) {
    return candidateSyncedAt > existingSyncedAt;
  }

  const candidatePosition =
    candidate.position !== null && candidate.position > 0
      ? candidate.position
      : Number.MAX_SAFE_INTEGER;
  const existingPosition =
    existing.position !== null && existing.position > 0
      ? existing.position
      : Number.MAX_SAFE_INTEGER;
  if (candidatePosition !== existingPosition) {
    return candidatePosition < existingPosition;
  }

  const candidateClanTag = normalizeClanTag(candidate.clanTag);
  const existingClanTag = normalizeClanTag(existing.clanTag);
  if (candidateClanTag !== existingClanTag) {
    return candidateClanTag.localeCompare(existingClanTag) < 0;
  }

  const candidatePlayerTag = normalizePlayerTag(candidate.playerTag);
  const existingPlayerTag = normalizePlayerTag(existing.playerTag);
  return candidatePlayerTag.localeCompare(existingPlayerTag) < 0;
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
  const buildContext = (clanTag: string, war: CurrentWarSnapshot | null): LiveCurrentWarFallbackContext | null => {
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
  };

  const result = new Map<string, LiveCurrentWarFallbackContext>();
  let preloadedHitCount = 0;
  for (const clanTag of normalizedClanTags) {
    if (!preloadedCurrentWarSnapshotsByClanTag.has(clanTag)) continue;
    preloadedHitCount += 1;
    const context = buildContext(clanTag, preloadedCurrentWarSnapshotsByClanTag.get(clanTag) ?? null);
    if (context) {
      result.set(clanTag, context);
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
        return [clanTag, buildContext(clanTag, war)] as const;
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
