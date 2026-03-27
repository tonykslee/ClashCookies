import { ClanWar } from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildPlayerSignalStateKey,
  extractGamesChampionTotalFromSignalState,
} from "./ActivitySignalService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { CoCService } from "./CoCService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
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

type TodoWindow = {
  active: boolean;
  startMs: number;
  endMs: number;
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
const TODO_SNAPSHOT_WRITE_CHUNK_SIZE = 50;
const TODO_CWL_SEASON_WRITE_CHUNK_SIZE = 100;

/** Purpose: keep all Todo snapshot reads/writes in one service boundary. */
export class TodoSnapshotService {
  private refreshAllPromise: Promise<TodoSnapshotRefreshResult> | null = null;
  private readonly refreshByBatchKey = new Map<
    string,
    Promise<TodoSnapshotRefreshResult>
  >();

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
  }): Promise<TodoSnapshotRefreshResult> {
    if (this.refreshAllPromise) {
      return this.refreshAllPromise;
    }

    const task = this.refreshAllLinkedPlayerSnapshotsInternal(input).finally(() => {
      this.refreshAllPromise = null;
    });
    this.refreshAllPromise = task;
    return task;
  }

  /** Purpose: refresh one targeted player-tag subset with deduped in-flight locking. */
  async refreshSnapshotsForPlayerTags(input: {
    playerTags: string[];
    cocService?: CoCService;
    nowMs?: number;
  }): Promise<TodoSnapshotRefreshResult> {
    const normalizedTags = normalizePlayerTags(input.playerTags);
    if (normalizedTags.length <= 0) {
      return { playerCount: 0, updatedCount: 0 };
    }

    const batchKey = normalizedTags.join(",");
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
  }): Promise<TodoSnapshotRefreshResult> {
    const links = await prisma.playerLink.findMany({
      select: { playerTag: true },
      orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
    });

    const playerTags = normalizePlayerTags(links.map((row) => row.playerTag));
    if (playerTags.length <= 0) {
      return { playerCount: 0, updatedCount: 0 };
    }

    return this.refreshSnapshotsForPlayerTagsInternal({
      playerTags,
      cocService: input.cocService,
      nowMs: input.nowMs,
    });
  }

  /** Purpose: compute and persist todo snapshots for one normalized player-tag set. */
  private async refreshSnapshotsForPlayerTagsInternal(input: {
    playerTags: string[];
    cocService?: CoCService;
    nowMs?: number;
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

    const clanTags = [
      ...new Set(
        normalizedTags
          .map((playerTag) => {
            const fromMember = latestClanMemberByTag.get(playerTag)?.clanTag ?? "";
            const fromExisting = existingByTag.get(playerTag)?.clanTag ?? "";
            return normalizeClanTag(fromMember || fromExisting);
          })
          .filter(Boolean),
      ),
    ];

    const [trackedClanRows, currentWarRows, cwlTrackedClanRows, cwlSeasonMappingRows] =
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
    const mappedCwlClanByPlayerTag = new Map(
      cwlSeasonMappingRows
        .map((row) => [
          normalizePlayerTag(row.playerTag),
          normalizeClanTag(row.cwlClanTag),
        ] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
    );
    const cwlWarByClan =
      input.cocService && cwlTrackedTagSet.size > 0
        ? await loadActiveCwlWarsByClan(input.cocService, [...cwlTrackedTagSet])
        : new Map<string, ClanWar | null>();
    const activeCwlClanByPlayerTag = buildActiveCwlClanByPlayerTag({
      cwlWarByClan,
      trackedCwlTags: cwlTrackedTagSet,
    });

    const snapshotUpserts: Array<
      Parameters<typeof prisma.todoPlayerSnapshot.upsert>[0]
    > = [];
    const cwlSeasonUpserts: Array<
      Parameters<typeof prisma.cwlPlayerClanSeason.upsert>[0]
    > = [];

    for (const playerTag of normalizedTags) {
      const existing = existingByTag.get(playerTag);
      const latestClanMember = latestClanMemberByTag.get(playerTag) ?? null;
      const resolvedClanTag =
        normalizeClanTag(latestClanMember?.clanTag ?? "") ||
        normalizeClanTag(existing?.clanTag ?? "") ||
        null;
      const resolvedClanName =
        (resolvedClanTag ? trackedClanNameByTag.get(resolvedClanTag) : null) ||
        sanitizeDisplayText(existing?.clanName ?? "") ||
        null;
      const activeMappedCwlClanTag =
        activeCwlClanByPlayerTag.get(playerTag) ?? "";
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
      const resolvedCwlClanName =
        (resolvedCwlClanTag
          ? cwlTrackedClanNameByTag.get(resolvedCwlClanTag) ||
            trackedClanNameByTag.get(resolvedCwlClanTag)
          : null) ||
        sanitizeDisplayText(existing?.cwlClanName ?? "") ||
        null;
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

      const cwlWar = resolvedCwlClanTag
        ? cwlWarByClan.get(resolvedCwlClanTag) ?? null
        : null;
      const cwlParticipant =
        !!resolvedCwlClanTag &&
        activeCwlClanByPlayerTag.get(playerTag) === resolvedCwlClanTag;
      const cwlActive = isWarStateActive(cwlWar?.state ?? "") && cwlParticipant;
      const cwlPhase = cwlActive
        ? normalizeWarPhaseLabel(cwlWar?.state ?? "")
        : null;
      const cwlEndsAt = cwlActive ? resolveCwlPhaseEnd(cwlWar) : null;
      const cwlAttacksUsed = cwlActive
        ? clampInt(findWarAttacksUsed(cwlWar, playerTag), 0, 1)
        : 0;

      const derivedGames = deriveTodoGamesValues({
        gamesWindowActive: gamesWindow.active,
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
        cwlAttacksMax: 1,
        cwlPhase,
        cwlEndsAt,
        raidActive: raidWindow.active,
        raidAttacksUsed: clampInt(existing?.raidAttacksUsed, 0, 6),
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

      if (resolvedCwlClanTag) {
        cwlSeasonUpserts.push({
          where: {
            season_playerTag: {
              season: currentCwlSeason,
              playerTag,
            },
          },
          update: {
            cwlClanTag: resolvedCwlClanTag,
          },
          create: {
            season: currentCwlSeason,
            playerTag,
            cwlClanTag: resolvedCwlClanTag,
          },
        });
      }
    }

    try {
      await runChunkedWrites(
        snapshotUpserts,
        TODO_SNAPSHOT_WRITE_CHUNK_SIZE,
        async (upsert) => {
          await prisma.todoPlayerSnapshot.upsert(upsert);
        },
      );

      await runChunkedWrites(
        cwlSeasonUpserts,
        TODO_CWL_SEASON_WRITE_CHUNK_SIZE,
        async (upsert) => {
          await prisma.cwlPlayerClanSeason.upsert(upsert);
        },
      );
    } catch (err) {
      console.error(
        `[todo-snapshot] persist_failed players=${normalizedTags.length} snapshots=${snapshotUpserts.length} cwl=${cwlSeasonUpserts.length} error=${formatError(err)}`,
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

/** Purpose: normalize potentially-empty cycle-key input into nullable stable string. */
function normalizeGamesCycleKey(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Purpose: derive snapshot-owned Clan Games observability values and bounded points. */
function deriveTodoGamesValues(input: {
  gamesWindowActive: boolean;
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

  if (!input.gamesWindowActive) {
    return {
      points: null,
      target: null,
      championTotal,
      seasonBaseline: championTotal,
      cycleKey: activeCycleKey,
    };
  }

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

  if (resolvedBaseline === null) {
    return {
      points: 0,
      target: TODO_GAMES_TARGET_POINTS,
      championTotal,
      seasonBaseline: null,
      cycleKey: activeCycleKey,
    };
  }

  const resolvedTotal = championTotal ?? resolvedBaseline;
  const points = clampInt(
    resolvedTotal - resolvedBaseline,
    0,
    TODO_GAMES_POINTS_MAX,
  );
  return {
    points,
    target: TODO_GAMES_TARGET_POINTS,
    championTotal,
    seasonBaseline: resolvedBaseline,
    cycleKey: activeCycleKey,
  };
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

/** Purpose: compute CWL phase-end from one war payload using official CoC timestamps. */
function resolveCwlPhaseEnd(war: ClanWar | null): Date | null {
  if (!war) return null;
  const state = String(war.state ?? "").toLowerCase();
  if (state.includes("preparation")) {
    return parseCocTime(war.startTime ?? null);
  }
  if (state.includes("inwar")) {
    return parseCocTime(war.endTime ?? null);
  }
  return null;
}

/** Purpose: find one player's attack usage across both war sides by normalized tag. */
function findWarAttacksUsed(war: ClanWar | null, playerTag: string): number {
  if (!war) return 0;
  const normalizedTarget = normalizePlayerTag(playerTag);
  if (!normalizedTarget) return 0;

  const members = [
    ...(Array.isArray(war.clan?.members) ? war.clan.members : []),
    ...(Array.isArray(war.opponent?.members) ? war.opponent.members : []),
  ];
  const match = members.find(
    (member) => normalizePlayerTag(String(member?.tag ?? "")) === normalizedTarget,
  );
  return Array.isArray(match?.attacks) ? match.attacks.length : 0;
}

/** Purpose: derive a season-scoped player->CWL-clan map from active CWL wars for tracked CWL clans. */
function buildActiveCwlClanByPlayerTag(input: {
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
async function loadActiveCwlWarsByClan(
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

/** Purpose: compute current or next monthly clan-games window in UTC. */
function resolveClanGamesWindow(nowMs: number): TodoWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const currentStart = Date.UTC(year, month, 22, 8, 0, 0, 0);
  const currentEnd = Date.UTC(year, month, 28, 8, 0, 0, 0);

  if (nowMs >= currentStart && nowMs < currentEnd) {
    return { active: true, startMs: currentStart, endMs: currentEnd };
  }
  if (nowMs < currentStart) {
    return { active: false, startMs: currentStart, endMs: currentEnd };
  }

  const nextStart = Date.UTC(year, month + 1, 22, 8, 0, 0, 0);
  const nextEnd = Date.UTC(year, month + 1, 28, 8, 0, 0, 0);
  return { active: false, startMs: nextStart, endMs: nextEnd };
}
