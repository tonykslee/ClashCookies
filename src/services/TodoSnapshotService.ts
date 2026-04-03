import { ClanWar, type ClanWarMember } from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildPlayerSignalStateKey,
  extractGamesChampionTotalFromSignalState,
} from "./ActivitySignalService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import { cocRequestQueueService } from "./CoCRequestQueueService";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  buildTrackedWarMemberStateByClanAndPlayer,
  isTodoWarStateActive,
  type TodoTrackedCurrentWarRow,
} from "./TodoTrackedWarStateService";
import { parseCocTime } from "./war-events/core";

const TODO_SNAPSHOT_SELECT = {
  playerTag: true,
  playerName: true,
  clanTag: true,
  clanName: true,
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

type ClanMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
  playerName: string;
  sourceSyncedAt: Date;
};

type WarMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
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
    return rows
      .map((row) => ({
        ...row,
        playerTag: normalizePlayerTag(row.playerTag),
        clanTag: row.clanTag ? normalizeClanTag(row.clanTag) : null,
        cwlClanTag: row.cwlClanTag ? normalizeClanTag(row.cwlClanTag) : null,
      }))
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
      _max: { updatedAt: true },
    });

    return {
      snapshotCount: Number(aggregate._count?._all ?? 0),
      maxUpdatedAtMs: aggregate._max.updatedAt
        ? aggregate._max.updatedAt.getTime()
        : 0,
    };
  }

  /** Purpose: refresh all linked-player snapshots from existing tracked state in one bounded pass. */
  async refreshAllLinkedPlayerSnapshots(input: {
    cocService?: CoCService;
    nowMs?: number;
    producerPacingMs?: number | null;
  }): Promise<TodoSnapshotRefreshResult> {
    return this.refreshActivatedTodoLinkedPlayerSnapshots({
      cadence: "tracked",
      cocService: input.cocService,
      nowMs: input.nowMs,
      producerPacingMs: input.producerPacingMs,
    });
  }

  /** Purpose: refresh todo snapshots for previously-activated users within one cadence bucket. */
  async refreshActivatedTodoLinkedPlayerSnapshots(input: {
    cadence: TodoRefreshCadence;
    cocService?: CoCService;
    nowMs?: number;
    producerPacingMs?: number | null;
  }): Promise<TodoSnapshotRefreshResult & TodoActivatedRefreshStats> {
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

    const snapshotRows = activatedPlayerTags.length > 0
      ? await prisma.todoPlayerSnapshot.findMany({
          where: { playerTag: { in: activatedPlayerTags } },
          select: { playerTag: true, clanTag: true },
        })
      : [];
    const snapshotClanTagByPlayerTag = new Map(
      snapshotRows.map((row) => [
        normalizePlayerTag(row.playerTag),
        normalizeClanTag(row.clanTag ?? ""),
      ] as const),
    );
    const trackedClanTagRows = await prisma.trackedClan.findMany({
      select: { tag: true },
    });
    const trackedClanTagSet = new Set(
      trackedClanTagRows
        .map((row) => normalizeClanTag(row.tag))
        .filter(Boolean),
    );

    const trackedPlayerTags: string[] = [];
    const nonTrackedPlayerTags: string[] = [];
    for (const playerTag of activatedPlayerTags) {
      const clanTag = snapshotClanTagByPlayerTag.get(playerTag) ?? null;
      if (clanTag && trackedClanTagSet.has(clanTag)) {
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
    const result =
      selectedPlayerTags.length > 0
        ? await this.refreshSnapshotsForPlayerTagsInternal({
            playerTags: selectedPlayerTags,
            cocService: input.cocService,
            nowMs: input.nowMs,
            includeNonTrackedCwlRefresh: input.cadence === "observe",
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
    nowMs?: number;
    includeNonTrackedCwlRefresh?: boolean;
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
    }).finally(() => {
      this.refreshByBatchKey.delete(batchKey);
    });

    this.refreshByBatchKey.set(batchKey, task);
    return task;
  }

  /** Purpose: execute one full linked-player refresh by resolving all linked tags first. */
  private async refreshAllLinkedPlayerSnapshotsInternal(input: {
    cocService?: CoCService;
    nowMs?: number;
    producerPacingMs?: number | null;
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
      nowMs: input.nowMs,
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
    nowMs?: number;
    includeNonTrackedCwlRefresh?: boolean;
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
    const liveClanTagByPlayerTag = await loadLiveClanTagsByPlayerTag({
      cocService: input.cocService,
      playerTags: normalizedTags,
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
      playerCatalogRows,
      clanMemberRows,
      warMemberRows,
      settingRows,
    ] = await Promise.all([
      this.listSnapshotsByPlayerTags({ playerTags: normalizedTags }),
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
    const latestCatalogNameByTag = new Map(
      playerCatalogRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          sanitizeDisplayText(row.latestName),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const latestClanMemberByTag = pickLatestClanMemberByPlayerTag(clanMemberRows);
    const latestWarMemberByClanAndTag = pickLatestWarMemberByClanAndPlayer(warMemberRows);
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
    const resolvedClanTagByPlayerTag = new Map<string, string | null>();
    for (const playerTag of normalizedTags) {
      const liveClanTag = liveClanTagByPlayerTag.get(playerTag) ?? "";
      const fromMember = latestClanMemberByTag.get(playerTag)?.clanTag ?? "";
      const fromExisting = existingByTag.get(playerTag)?.clanTag ?? "";
      const resolvedClanTag =
        normalizeClanTag(liveClanTag || fromMember || fromExisting) || null;
      resolvedClanTagByPlayerTag.set(playerTag, resolvedClanTag);
    }

    const clanTags = [
      ...new Set(
        [...resolvedClanTagByPlayerTag.values()].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ];

    const [
      trackedClanRows,
      currentWarRows,
      cwlTrackedClanRows,
      cwlSeasonMappingRows,
      currentCwlRoundRows,
      currentCwlMemberRows,
    ] =
      await Promise.all([
      clanTags.length > 0
        ? prisma.trackedClan.findMany({
            where: { tag: { in: clanTags } },
            select: { tag: true, name: true },
          })
        : Promise.resolve([]),
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
    const trackedWarMemberByClanAndTag = buildTrackedWarMemberStateByClanAndPlayer({
      currentWarByClanTag: activeTrackedCurrentWarByClanTag,
      warAttackRows: trackedWarAttackRows,
    });
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
    const liveNonTrackedCwlContextByClanTag = input.includeNonTrackedCwlRefresh
      ? await loadLiveNonTrackedCwlContextsByClanTag({
          cocService: input.cocService,
          clanTags: [
            ...new Set(
              [...resolvedClanTagByPlayerTag.values()].filter(
                (value): value is string =>
                  Boolean(value && !cwlTrackedTagSet.has(value)),
              ),
            ),
          ],
        })
      : new Map<string, LiveCwlClanContext>();
    const mappedCwlClanByPlayerTag = new Map(
      cwlSeasonMappingRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          normalizeClanTag(row.cwlClanTag),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
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
    const liveRaidAttacksUsedByPlayerTag =
      await loadLiveRaidAttacksUsedByPlayerTag({
        cocService: input.cocService,
        raidWindow,
        resolvedClanTagByPlayerTag,
      });

    const snapshotUpserts: Array<
      Parameters<typeof prisma.todoPlayerSnapshot.upsert>[0]
    > = [];

    for (const playerTag of normalizedTags) {
      const existing = existingByTag.get(playerTag);
      const latestClanMember = latestClanMemberByTag.get(playerTag) ?? null;
      const resolvedClanTag = resolvedClanTagByPlayerTag.get(playerTag) ?? null;
      const resolvedClanName =
        (resolvedClanTag ? trackedClanNameByTag.get(resolvedClanTag) : null) ||
        sanitizeDisplayText(existing?.clanName ?? "") ||
        null;
      const activeMappedCwlClanTag =
        currentCwlMemberByPlayerTag.get(playerTag)?.clanTag ?? "";
      const persistedMappedCwlClanTag =
        mappedCwlClanByPlayerTag.get(playerTag) ?? "";
      const fallbackCwlClanTag =
        resolvedClanTag && cwlTrackedTagSet.has(resolvedClanTag)
          ? resolvedClanTag
          : "";
      const liveNonTrackedCwlContext =
        resolvedClanTag && !cwlTrackedTagSet.has(resolvedClanTag)
          ? liveNonTrackedCwlContextByClanTag.get(resolvedClanTag) ?? null
          : null;
      const resolvedCwlClanTag =
        normalizeClanTag(
          activeMappedCwlClanTag ||
            persistedMappedCwlClanTag ||
            fallbackCwlClanTag,
        ) ||
        normalizeClanTag(liveNonTrackedCwlContext?.clanTag ?? "") ||
        normalizeClanTag(existing?.cwlClanTag ?? "") ||
        null;
      const resolvedCwlClanName =
        (resolvedCwlClanTag
          ? currentCwlRoundByClanTag.get(resolvedCwlClanTag)?.clanName ||
            cwlTrackedClanNameByTag.get(resolvedCwlClanTag) ||
            liveNonTrackedCwlContext?.clanName ||
            resolvedClanName ||
            trackedClanNameByTag.get(resolvedCwlClanTag)
          : null) ||
        sanitizeDisplayText(existing?.cwlClanName ?? "") ||
        null;
      const liveNonTrackedCwlMember =
        resolvedClanTag && liveNonTrackedCwlContext
          ? liveNonTrackedCwlContext.membersByPlayerTag.get(playerTag) ?? null
          : null;
      const currentCwlRound = resolvedCwlClanTag
        ? currentCwlRoundByClanTag.get(resolvedCwlClanTag) ?? null
        : null;
      const currentCwlMember =
        currentCwlMemberByPlayerTag.get(playerTag) ?? liveNonTrackedCwlMember ?? null;
      const cwlParticipant = Boolean(
        resolvedCwlClanTag &&
          currentCwlMember &&
          currentCwlMember.subbedIn &&
          (!currentCwlRound || currentCwlMember.clanTag === resolvedCwlClanTag),
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
            currentCwlRound?.roundState ?? liveNonTrackedCwlContext?.roundState ?? "",
          )
        : null;
      const cwlEndsAt = currentCwlRound
        ? resolveCurrentWarPhaseEnd({
            state: currentCwlRound?.roundState ?? null,
            startTime: currentCwlRound?.startTime ?? null,
            endTime: currentCwlRound?.endTime ?? null,
          })
        : liveNonTrackedCwlContext?.phaseEndsAt ?? null;
      const cwlAttacksUsed = cwlParticipant
        ? clampInt(currentCwlMember?.attacksUsed, 0, currentCwlMember?.attacksAvailable || 1)
        : 0;
      const cwlAttacksMax = cwlParticipant
        ? Math.max(0, clampInt(currentCwlMember?.attacksAvailable, 0, 1))
        : 0;
      const resolvedPlayerName =
        sanitizeDisplayText(latestClanMember?.playerName ?? "") ||
        latestCatalogNameByTag.get(playerTag) ||
        sanitizeDisplayText(existing?.playerName ?? "") ||
        playerTag;

      const currentWar = resolvedClanTag
        ? currentWarByClanTag.get(resolvedClanTag) ?? null
        : null;
      const warStateActive = isTodoWarStateActive(currentWar?.state ?? "");
      const warStatePreparation = isWarStatePreparation(currentWar?.state ?? "");
      const trackedClanActive = Boolean(
        resolvedClanTag && trackedClanTagSet.has(resolvedClanTag),
      );

      const warMemberKey = resolvedClanTag ? `${resolvedClanTag}:${playerTag}` : "";
      const warMemberFromFeed = warMemberKey
        ? latestWarMemberByClanAndTag.get(warMemberKey) ?? null
        : null;
      const trackedWarMember =
        trackedClanActive && warMemberKey
          ? trackedWarMemberByClanAndTag.get(warMemberKey) ?? null
          : null;
      const warMember = trackedClanActive
        ? trackedWarMember ?? warMemberFromFeed
        : warMemberFromFeed;
      const warActive = warStateActive && warMember !== null;
      const warPhase = warActive
        ? normalizeWarPhaseLabel(currentWar?.state ?? "")
        : null;
      const warEndsAt = warActive ? resolveCurrentWarPhaseEnd(currentWar) : null;
      const warAttacksUsed = !warActive
        ? 0
        : warStatePreparation
          ? 0
          : trackedClanActive
            ? clampInt(trackedWarMember?.attacksUsed, 0, 2)
            : clampInt(warMemberFromFeed?.attacks, 0, 2);

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
        clanTag: resolvedClanTag,
        clanName: resolvedClanName,
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
        raidActive: raidWindow.active,
        raidAttacksUsed: raidWindow.active
          ? clampInt(liveRaidAttacksUsedByPlayerTag.get(playerTag), 0, 6)
          : 0,
        raidAttacksMax: 6,
        raidEndsAt: new Date(raidWindow.endMs),
        gamesActive: gamesWindow.active,
        gamesPoints: derivedGames.points,
        gamesTarget: derivedGames.target,
        gamesChampionTotal: derivedGames.championTotal,
        gamesSeasonBaseline: derivedGames.seasonBaseline,
        gamesCycleKey: derivedGames.cycleKey,
        gamesEndsAt: new Date(gamesWindow.endMs),
        lastUpdatedAt: now,
      };

      snapshotUpserts.push({
        where: { playerTag },
        update: data,
        create: {
          playerTag,
          ...data,
        },
      });
    }

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

/** Purpose: keep only the most recent war-member row per clan+player pair by sync time. */
function pickLatestWarMemberByClanAndPlayer(
  rows: WarMemberCurrentRow[],
): Map<string, WarMemberCurrentRow> {
  const latest = new Map<string, WarMemberCurrentRow>();
  for (const row of rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    const clanTag = normalizeClanTag(row.clanTag);
    if (!playerTag || !clanTag) continue;

    const key = `${clanTag}:${playerTag}`;
    const existing = latest.get(key);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latest.set(key, {
        playerTag,
        clanTag,
        position: toFiniteIntOrNull(row.position),
        attacks: toFiniteIntOrNull(row.attacks),
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }
  return latest;
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
  cocService: CoCService,
  clanTags: string[],
): Promise<Map<string, ClanWar | null>> {
  if (clanTags.length <= 0) return new Map();

  const cwlWarByWarTag = new Map<string, ClanWar | null>();
  const entries = await Promise.all(
    clanTags.map(async (clanTag) => {
      const war = await resolveActiveCwlWarForClan({
        cocService,
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
  cocService: CoCService;
  clanTag: string;
  cwlWarByWarTag: Map<string, ClanWar | null>;
}): Promise<ClanWar | null> {
  const group = await input.cocService
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
        const war = await input.cocService
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

/** Purpose: load one deduped live CWL context per non-tracked clan for targeted manual snapshot refreshes. */
async function loadLiveNonTrackedCwlContextsByClanTag(input: {
  cocService?: CoCService;
  clanTags: string[];
}): Promise<Map<string, LiveCwlClanContext>> {
  if (!input.cocService || input.clanTags.length <= 0) {
    return new Map();
  }

  const contexts = await Promise.all(
    [...new Set(input.clanTags)].map(async (clanTag) => {
      const normalizedClanTag = normalizeClanTag(clanTag);
      const group = await input.cocService!
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
          const war = await input.cocService!
            .getClanWarLeagueWar(warTag)
            .catch(() => null);
          if (!war) continue;

          const side = resolveLiveCwlSide(normalizedClanTag, war);
          if (!side) continue;

          const roundState = normalizeRoundState(war.state);
          if (!(isWarStatePreparation(roundState) || isWarStateActive(roundState))) {
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

          return [
            clanTag,
            {
              clanTag: normalizedClanTag,
              clanName: side.clanName || baseClanName,
              roundState,
              phaseEndsAt,
              membersByPlayerTag,
            },
          ] as const;
        }
      }

      return [
        clanTag,
        {
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

/** Purpose: resolve live current-clan tags for player tags when CoC access is available. */
async function loadLiveClanTagsByPlayerTag(input: {
  cocService?: CoCService;
  playerTags: string[];
  producer?: WarEventLinkedPlayerRefreshProducer | null;
}): Promise<Map<string, string>> {
  if (!input.cocService || typeof input.cocService.getPlayerRaw !== "function") {
    return new Map();
  }

  const normalizedTags = normalizePlayerTags(input.playerTags);
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

  const entries: Array<readonly [string, string]> = [];
  let enqueuedCount = 0;
  let deferredCount = 0;
  for (let chunkIndex = 0; chunkIndex < chunkedTags.length; chunkIndex += 1) {
    if (input.producer) {
      const queueStatus = cocRequestQueueService.getStatus();
      if (queueStatus.backgroundQueueDepth >= input.producer.backlogThreshold) {
        deferredCount = chunkedTags
          .slice(chunkIndex)
          .reduce((sum, chunk) => sum + chunk.length, 0);
        console.warn(
          `[todo-snapshot] event=war_event_player_refresh_deferred source=${input.producer.source} reason=background_backlog backlog_depth=${queueStatus.backgroundQueueDepth} threshold=${input.producer.backlogThreshold} deferred_count=${deferredCount}`,
        );
        break;
      }
      if (chunkIndex > 0 && plan.chunkDelayMs > 0) {
        console.info(
          `[todo-snapshot] event=war_event_player_refresh_stagger source=${input.producer.source} chunk_index=${chunkIndex + 1} chunk_count=${chunkedTags.length} delay_ms=${plan.chunkDelayMs}`,
        );
        await sleepMs(plan.chunkDelayMs);
      }
    }

    const chunk = chunkedTags[chunkIndex];
    if (input.producer) {
      const queueStatus = cocRequestQueueService.getStatus();
      console.info(
        `[todo-snapshot] event=war_event_player_refresh_chunk source=${input.producer.source} chunk_index=${chunkIndex + 1} chunk_count=${chunkedTags.length} chunk_size=${chunk.length} background_depth=${queueStatus.backgroundQueueDepth}`,
      );
    }
    const chunkEntries = await Promise.all(
      chunk.map(async (playerTag) => {
        const player = await input.cocService!
          .getPlayerRaw(playerTag, { suppressTelemetry: true })
          .catch(() => null);
        const clanTag = normalizeClanTag(String(player?.clan?.tag ?? ""));
        return [playerTag, clanTag] as const;
      }),
    );
    entries.push(...chunkEntries);
    enqueuedCount += chunk.length;
  }

  if (input.producer) {
    console.info(
      `[todo-snapshot] event=war_event_player_refresh_complete source=${input.producer.source} candidate_count=${plan.candidateCount} deduped_count=${plan.dedupedCount} enqueued_count=${enqueuedCount} deferred_count=${deferredCount}`,
    );
  }

  return new Map(
    entries.filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
}

/** Purpose: fetch active raid-season member attacks once per clan and fan out by player tag. */
async function loadLiveRaidAttacksUsedByPlayerTag(input: {
  cocService?: CoCService;
  raidWindow: TodoWindow;
  resolvedClanTagByPlayerTag: Map<string, string | null>;
}): Promise<Map<string, number>> {
  if (
    !input.raidWindow.active ||
    !input.cocService ||
    typeof input.cocService.getClanCapitalRaidSeasons !== "function"
  ) {
    return new Map();
  }

  const playerTagsByClanTag = new Map<string, string[]>();
  for (const [playerTag, clanTag] of input.resolvedClanTagByPlayerTag.entries()) {
    if (!clanTag) continue;
    const existing = playerTagsByClanTag.get(clanTag);
    if (existing) {
      existing.push(playerTag);
      continue;
    }
    playerTagsByClanTag.set(clanTag, [playerTag]);
  }
  if (playerTagsByClanTag.size <= 0) return new Map();

  const attacksByPlayerTag = new Map<string, number>();
  const clanTags = [...playerTagsByClanTag.keys()];
  const clanMemberMaps = await Promise.all(
    clanTags.map(async (clanTag) => {
      const seasons = await input.cocService!
        .getClanCapitalRaidSeasons(clanTag, 2)
        .catch(() => []);
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
      return [clanTag, memberAttacksByTag] as const;
    }),
  );
  const memberAttacksByClanTag = new Map(clanMemberMaps);

  for (const [clanTag, playerTags] of playerTagsByClanTag.entries()) {
    const memberAttacksByTag = memberAttacksByClanTag.get(clanTag) ?? new Map<string, number>();
    for (const playerTag of playerTags) {
      attacksByPlayerTag.set(
        playerTag,
        clampInt(memberAttacksByTag.get(playerTag), 0, 6),
      );
    }
  }

  return attacksByPlayerTag;
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
  const weekStartMs = dayStartMs - now.getUTCDay() * dayMs;
  const fridayStartMs = weekStartMs + 5 * dayMs + 7 * hourMs;
  const raidEndMs = fridayStartMs + 3 * dayMs;

  if (nowMs >= fridayStartMs && nowMs < raidEndMs) {
    return { active: true, startMs: fridayStartMs, endMs: raidEndMs };
  }
  if (nowMs < fridayStartMs) {
    return { active: false, startMs: fridayStartMs, endMs: raidEndMs };
  }

  const nextStartMs = fridayStartMs + 7 * dayMs;
  return {
    active: false,
    startMs: nextStartMs,
    endMs: nextStartMs + 3 * dayMs,
  };
}

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
