import { CoCService } from "./CoCService";
import {
  buildPlayerSignalStateKey,
  extractSignalStateFreshnessMsFromState,
} from "./ActivitySignalService";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { prisma } from "../prisma";
import {
  todoSnapshotService,
  resolveClanGamesCycleBoundaryFromCycleKey,
  type TodoSnapshotRecord,
} from "./TodoSnapshotService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlEventResolutionService } from "./CwlEventResolutionService";
import { cwlRotationService } from "./CwlRotationService";
import {
  buildTrackedWarMemberStateByClanAndPlayer,
  classifyTrackedWarRosterCurrentIdentity,
  isTodoWarStateActive,
  resolveTrackedWarRosterRenderState,
  type TodoTrackedCurrentWarRow,
  type TodoTrackedWarRosterCurrentRow,
  type TrackedWarRosterIdentityMatch,
  type TrackedWarRosterRenderState,
} from "./TodoTrackedWarStateService";
import { resolveCurrentWarMatchTypeSignal } from "./MatchTypeResolutionService";

export const TODO_TYPES = ["WAR", "CWL", "RAIDS", "GAMES"] as const;
export type TodoType = (typeof TODO_TYPES)[number];

export type TodoPagesResult = {
  linkedPlayerCount: number;
  pages: Record<TodoType, string>;
  sidebarStateByType: Record<TodoType, TodoSidebarState>;
};

export type TodoSidebarState = "default" | "incomplete" | "complete";

type TodoRenderRow = {
  playerTag: string;
  playerName: string;
  defaultIndex: number;
  townHall: number | null;
  clanTag: string | null;
  clanName: string | null;
  warClanTag: string | null;
  warClanName: string | null;
  raidClanTracked: boolean;
  cwlClanTag: string | null;
  cwlClanName: string | null;
  cwlPlannedSubInAt: Date | null;
  warPosition: number | null;
  warSourceUpdatedAt: Date | null;
  clanMembershipObservedAt: Date | null;
  currentMembershipFresh: boolean;
  warAttackDetails: Array<{
    defenderPosition: number | null;
    stars: number | null;
  }>;
  warHeaderBadge: string | null;
  warMatchIndicator: string;
  inValidatedWarMemberSet: boolean;
  activeTrackedWarClan: boolean;
  warTrackedClanActive: boolean;
  snapshot: TodoSnapshotRecord | null;
  missingSnapshot: boolean;
  staleSnapshot: boolean;
  displayedFreshnessAtMsByType: Record<TodoType, number | null>;
};

type TodoEventGroup = {
  clanTag: string | null;
  clanName: string | null;
  clanBadge: string | null;
  matchIndicator: string;
  phase: string;
  phaseEndsAt: Date | null;
  rows: TodoRenderRow[];
};

type CachedTodoRender = {
  expiresAtMs: number;
  pages: TodoPagesResult;
};

type CurrentWarMatchContextRow = {
  clanTag: string;
  clanName: string | null;
  warId: number | null;
  startTime: Date | null;
  matchType: string | null;
  outcome: string | null;
  state: string | null;
  inferredMatchType: boolean | null;
  updatedAt: Date;
};

type CurrentWarRenderRow = CurrentWarMatchContextRow;

type FwaClanMemberTownHallRow = {
  playerTag: string;
  clanTag: string;
  townHall: number | null;
  sourceSyncedAt: Date;
};

type FwaPlayerCatalogTownHallRow = {
  playerTag: string;
  latestTownHall: number | null;
  lastSeenAt: Date | null;
  lastSyncedAt: Date | null;
};

const DISCORD_DESCRIPTION_LIMIT = 4096;
const TODO_RENDER_CACHE_TTL_MS = 30_000;
const TODO_STALE_ACTIVE_WAR_MS = 2 * 60 * 1000;
const TODO_STALE_ACTIVE_CWL_MS = 5 * 60 * 1000;
const TODO_STALE_ACTIVE_RAID_MS = 15 * 60 * 1000;
const TODO_STALE_ACTIVE_GAMES_MS = 30 * 60 * 1000;
const TODO_STALE_IDLE_MS = 4 * 60 * 60 * 1000;
const TODO_CURRENT_MEMBERSHIP_MAX_AGE_MS = 60 * 60 * 1000;
const TODO_DEFAULT_GAMES_TARGET = 4000;
const TODO_GAMES_COMPLETE_POINTS = 4000;
const TODO_GAMES_MAX_POINTS = 10_000;
const TODO_WAR_NON_LINEUP_SECTION_LIMIT = 8;
const TODO_LOCALE = "en-US";
const TODO_GUILD_SCOPE_DM = "dm";
const todoRenderCacheByKey = new Map<string, CachedTodoRender>();
const todoRenderGenerationByUser = new Map<string, number>();

/** Purpose: normalize `/todo type` input into one safe enum value. */
export function normalizeTodoType(input: string | null | undefined): TodoType {
  const value = String(input ?? "").trim().toUpperCase();
  if (
    value === "WAR" ||
    value === "CWL" ||
    value === "RAIDS" ||
    value === "GAMES"
  ) {
    return value;
  }
  return "WAR";
}

/** Purpose: clear in-memory todo render cache between isolated tests. */
export function resetTodoRenderCacheForTest(): void {
  todoRenderCacheByKey.clear();
  todoRenderGenerationByUser.clear();
}

/** Purpose: bump the render cache generation for one user after snapshot refreshes. */
export function bumpTodoRenderCacheGenerationForUser(discordUserId: string): void {
  const key = String(discordUserId ?? "").trim();
  if (!key) return;
  const current = todoRenderGenerationByUser.get(key) ?? 0;
  todoRenderGenerationByUser.set(key, current + 1);
}

/** Purpose: invalidate cached todo render entries for one Discord user after snapshot rebuilds. */
export function invalidateTodoRenderCacheForUser(discordUserId: string): void {
  const keyPrefix = `${String(discordUserId ?? "").trim()}|`;
  for (const key of todoRenderCacheByKey.keys()) {
    if (key.startsWith(keyPrefix)) {
      todoRenderCacheByKey.delete(key);
    }
  }
}

/** Purpose: build snapshot-backed todo pages for one user with cheap cache re-use. */
export async function buildTodoPagesForUser(input: {
  discordUserId: string;
  cocService?: CoCService;
  guildScopeId?: string | null;
  nowMs?: number;
}): Promise<TodoPagesResult> {
  const links = await listPlayerLinksForDiscordUser({
    discordUserId: input.discordUserId,
  });
  if (links.length <= 0) {
    return {
      linkedPlayerCount: 0,
      pages: {
        WAR: "",
        CWL: "",
        RAIDS: "",
        GAMES: "",
      },
      sidebarStateByType: {
        WAR: "default",
        CWL: "default",
        RAIDS: "default",
        GAMES: "default",
      },
    };
  }

  const linkedTags = links.map((row) => row.playerTag);
  const snapshotVersion = await todoSnapshotService.getSnapshotVersion({
    playerTags: linkedTags,
  });
  const renderGuildScopeId = resolveTodoRenderScopeId(input.guildScopeId);
  const cacheKey = buildTodoRenderCacheKey({
    discordUserId: input.discordUserId,
    guildScopeId: renderGuildScopeId,
    linkedTags,
    snapshotVersion,
  });
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();

  pruneExpiredTodoRenderCache(nowMs);
  const cached = todoRenderCacheByKey.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.pages;
  }

  const snapshotRows = await todoSnapshotService.listSnapshotsByPlayerTags({
    playerTags: linkedTags,
  });
  const snapshotByTag = new Map(snapshotRows.map((row) => [row.playerTag, row]));
  const currentMembershipClanTags = [
    ...new Set(
      snapshotRows
        .map((row) => normalizeClanTag(row.clanTag ?? ""))
        .filter(Boolean),
    ),
  ];
  const activeWarOwnerClanTags = [
    ...new Set(
      snapshotRows
        .map((row) =>
          row.warActive
            ? normalizeClanTag(row.warClanTag ?? "") || normalizeClanTag(row.clanTag ?? "")
            : "",
        )
        .filter(Boolean),
    ),
  ];
  const activeRaidOwnerClanTags = [
    ...new Set(
      snapshotRows
        .map((row) =>
          row.raidActive
            ? normalizeClanTag(row.raidClanTag ?? "") || normalizeClanTag(row.clanTag ?? "")
            : "",
        )
        .filter(Boolean),
    ),
  ];
  const trackedClanLookupTags = [
    ...new Set([
      ...currentMembershipClanTags,
      ...activeWarOwnerClanTags,
      ...activeRaidOwnerClanTags,
    ]),
  ];
  const raidTrackedClanLookupTags = [
    ...new Set([...currentMembershipClanTags, ...activeRaidOwnerClanTags]),
  ];
  const currentWarLookupTags = [
    ...new Set([...currentMembershipClanTags, ...activeWarOwnerClanTags]),
  ];
  const cwlClanTags = [
    ...new Set(
      snapshotRows
        .map((row) => normalizeClanTag(row.cwlClanTag ?? ""))
        .filter(Boolean),
    ),
  ];
  const cwlCurrentEvents = cwlClanTags.length > 0
    ? await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
        clanTags: cwlClanTags,
      })
    : new Map();
  const cwlEventIds = [...new Set([...cwlCurrentEvents.values()].map((event) => event.id))];

  const currentWarGuildId = resolveTodoRenderScopeGuildId(renderGuildScopeId);
  const [
    trackedClanRows,
    raidTrackedClanRows,
    currentWarRows,
    trackedWarRosterParentRows,
    clanMemberTownHallRows,
    playerCatalogTownHallRows,
    playerSignalStateRows,
    currentCwlRoundRows,
    currentCwlMemberRows,
    activeCwlPlans,
  ] =
    await Promise.all([
    trackedClanLookupTags.length > 0
      ? prisma.trackedClan.findMany({
          where: { tag: { in: trackedClanLookupTags } },
          select: { tag: true, clanBadge: true, name: true },
        })
      : Promise.resolve([]),
    raidTrackedClanLookupTags.length > 0
      ? prisma.raidTrackedClan.findMany({
          where: { clanTag: { in: raidTrackedClanLookupTags } },
          select: { clanTag: true, name: true },
        })
      : Promise.resolve([]),
    currentWarLookupTags.length > 0
      ? prisma.currentWar.findMany({
          where: currentWarGuildId
            ? { guildId: currentWarGuildId, clanTag: { in: currentWarLookupTags } }
            : { clanTag: { in: currentWarLookupTags } },
          select: {
            clanTag: true,
            clanName: true,
            warId: true,
            startTime: true,
            matchType: true,
            outcome: true,
            state: true,
            inferredMatchType: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
    activeWarOwnerClanTags.length > 0
      ? prisma.fwaTrackedClanWarRosterCurrent.findMany({
          where: { clanTag: { in: activeWarOwnerClanTags } },
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
      : Promise.resolve([]),
    linkedTags.length > 0
      ? prisma.fwaClanMemberCurrent.findMany({
          where: { playerTag: { in: linkedTags } },
          select: {
            playerTag: true,
            clanTag: true,
            townHall: true,
            sourceSyncedAt: true,
          },
        })
      : Promise.resolve([]),
    linkedTags.length > 0
      ? prisma.fwaPlayerCatalog.findMany({
          where: { playerTag: { in: linkedTags } },
          select: {
            playerTag: true,
            latestTownHall: true,
            lastSeenAt: true,
            lastSyncedAt: true,
          },
        })
      : Promise.resolve([]),
    linkedTags.length > 0
      ? prisma.botSetting.findMany({
          where: {
            key: {
              in: linkedTags.map((tag) => buildPlayerSignalStateKey(tag)),
            },
          },
          select: {
            key: true,
            value: true,
          },
        })
      : Promise.resolve([]),
    cwlEventIds.length > 0
      ? prisma.currentCwlRound.findMany({
          where: { eventInstanceId: { in: cwlEventIds } },
          select: {
            eventInstanceId: true,
            clanTag: true,
            clanName: true,
            roundDay: true,
            roundState: true,
            startTime: true,
            endTime: true,
            sourceUpdatedAt: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
    cwlEventIds.length > 0
      ? prisma.cwlRoundMemberCurrent.findMany({
          where: {
            eventInstanceId: { in: cwlEventIds },
          },
          select: {
            eventInstanceId: true,
            clanTag: true,
            playerTag: true,
            subbedIn: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
    cwlClanTags.length > 0
      ? cwlRotationService.listActivePlanExports({
          season: resolveCurrentCwlSeasonKey(),
          clanTags: cwlClanTags,
        })
      : Promise.resolve([]),
    ]);

  const currentCwlRoundList = Array.isArray(currentCwlRoundRows)
    ? currentCwlRoundRows
    : [];
  const currentCwlMemberList = Array.isArray(currentCwlMemberRows)
    ? currentCwlMemberRows
    : [];
  const activeCwlPlanList = Array.isArray(activeCwlPlans)
    ? activeCwlPlans
    : [];
  const raidTrackedClanTagSet = new Set(
    (raidTrackedClanRows as Array<{ clanTag: string }>)
      .map((row) => normalizeClanTag(row.clanTag))
      .filter(Boolean),
  );

  const townHallByClanAndPlayer = new Map<string, number>();
  const latestTownHallByClanAndPlayer = new Map<string, Date>();
  const townHallByPlayerTag = new Map<string, number>();
  const latestTownHallByPlayerTag = new Map<string, Date>();
  for (const row of clanMemberTownHallRows as FwaClanMemberTownHallRow[]) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const normalizedTownHall = toFiniteIntOrNull(row.townHall);
    if (normalizedTownHall === null || normalizedTownHall <= 0) continue;

    const clanTag = normalizeClanTag(row.clanTag);
    if (clanTag) {
      const clanPlayerKey = `${clanTag}:${playerTag}`;
      const existingSyncedAt = latestTownHallByClanAndPlayer.get(clanPlayerKey);
      if (!existingSyncedAt || row.sourceSyncedAt > existingSyncedAt) {
        latestTownHallByClanAndPlayer.set(clanPlayerKey, row.sourceSyncedAt);
        townHallByClanAndPlayer.set(clanPlayerKey, normalizedTownHall);
      }
    }

    const existingPlayerSyncedAt = latestTownHallByPlayerTag.get(playerTag);
    if (!existingPlayerSyncedAt || row.sourceSyncedAt > existingPlayerSyncedAt) {
      latestTownHallByPlayerTag.set(playerTag, row.sourceSyncedAt);
      townHallByPlayerTag.set(playerTag, normalizedTownHall);
    }
  }

  const townHallByPlayerCatalogTag = new Map<string, number>();
  const latestPlayerCatalogSeenAtByTag = new Map<string, Date>();
  for (const row of playerCatalogTownHallRows as FwaPlayerCatalogTownHallRow[]) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    const townHall = toFiniteIntOrNull(row.latestTownHall);
    if (townHall === null || townHall <= 0) continue;
    townHallByPlayerCatalogTag.set(playerTag, townHall);
    if (row.lastSeenAt instanceof Date) {
      const existingSeenAt = latestPlayerCatalogSeenAtByTag.get(playerTag);
      if (!existingSeenAt || row.lastSeenAt > existingSeenAt) {
        latestPlayerCatalogSeenAtByTag.set(playerTag, row.lastSeenAt);
      }
    }
  }

  const playerSignalStateList = Array.isArray(playerSignalStateRows)
    ? playerSignalStateRows
    : [];
  const playerSignalStateFreshnessByTag = new Map<string, number>();
  for (const row of playerSignalStateList as Array<{ key: string; value: string }>) {
    const playerTag = normalizePlayerTag(String(row.key ?? "").replace(/^player_signal_state:/i, ""));
    if (!playerTag) continue;
    const freshnessMs = extractSignalStateFreshnessMsFromState(row.value);
    if (freshnessMs === null) continue;
    const existingFreshnessMs = playerSignalStateFreshnessByTag.get(playerTag);
    if (existingFreshnessMs === undefined || freshnessMs > existingFreshnessMs) {
      playerSignalStateFreshnessByTag.set(playerTag, freshnessMs);
    }
  }

  const currentCwlRoundByClanTag = new Map<
    string,
    {
      season: string;
      clanTag: string;
      clanName: string | null;
      roundDay: number;
      roundState: string;
      startTime: Date | null;
      endTime: Date | null;
      sourceUpdatedAt: Date;
      updatedAt: Date;
    }
  >();
  for (const row of currentCwlRoundList as Array<{
    clanTag: string;
    clanName: string | null;
    roundDay: number;
    roundState: string;
    startTime: Date | null;
    endTime: Date | null;
    sourceUpdatedAt: Date;
    updatedAt: Date;
  }>) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    currentCwlRoundByClanTag.set(clanTag, {
      season: resolveCurrentCwlSeasonKey(),
      clanTag,
      clanName: sanitizeStatusText(row.clanName) || null,
      roundDay: Math.max(1, Math.trunc(Number(row.roundDay) || 1)),
      roundState: row.roundState,
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      sourceUpdatedAt: row.sourceUpdatedAt,
      updatedAt: row.updatedAt,
    });
  }

  const currentCwlMemberByClanAndPlayerTag = new Map<
    string,
    {
      clanTag: string;
      playerTag: string;
      subbedIn: boolean;
      updatedAt: Date;
    }
  >();
  for (const row of currentCwlMemberList as Array<{
    clanTag: string;
    playerTag: string;
    subbedIn: boolean;
    updatedAt: Date;
  }>) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    currentCwlMemberByClanAndPlayerTag.set(`${clanTag}:${playerTag}`, {
      clanTag,
      playerTag,
      subbedIn: Boolean(row.subbedIn),
      updatedAt: row.updatedAt,
    });
  }

  const activeCwlPlanByClanTag = new Map<
    string,
    {
      clanTag: string;
      clanName: string | null;
      updatedAt: Date;
      days: Array<{
        roundDay: number;
        rows: Array<{
          playerTag: string;
          playerName: string;
          subbedOut: boolean;
          assignmentOrder: number;
        }>;
      }>;
    }
  >();
  for (const plan of activeCwlPlanList as Array<{
    clanTag: string;
    clanName: string | null;
    updatedAt: Date;
    days: Array<{
      roundDay: number;
      rows: Array<{
        playerTag: string;
        playerName: string;
        subbedOut: boolean;
        assignmentOrder: number;
      }>;
    }>;
  }>) {
    const clanTag = normalizeClanTag(plan.clanTag);
    if (!clanTag) continue;
    activeCwlPlanByClanTag.set(clanTag, plan);
  }

  const trackedClanTagSet = new Set(
    trackedClanRows
      .map((row) => normalizeClanTag(row.tag))
      .filter(Boolean),
  );
  const clanBadgeByTag = new Map<string, string>();
  const trackedClanNameByTag = new Map<string, string | null>();
  for (const row of trackedClanRows as Array<{ tag: string; clanBadge: string | null }>) {
    const clanTag = normalizeClanTag(row.tag);
    const clanBadge = sanitizeStatusText(row.clanBadge);
    if (!clanTag || !clanBadge) continue;
    clanBadgeByTag.set(clanTag, clanBadge);
  }
  for (const row of trackedClanRows as Array<{ tag: string; name: string | null }>) {
    const clanTag = normalizeClanTag(row.tag);
    if (!clanTag) continue;
    trackedClanNameByTag.set(clanTag, sanitizeStatusText(row.name) || null);
  }
  const raidTrackedClanNameByTag = new Map<string, string | null>();
  for (const row of raidTrackedClanRows as Array<{ clanTag: string; name: string | null }>) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    raidTrackedClanNameByTag.set(clanTag, sanitizeStatusText(row.name) || null);
  }
  const warMatchContextByClanTag = pickPreferredCurrentWarByClanTag(currentWarRows);
  const currentWarIdentityByClanTag = pickLatestCurrentWarIdentityByClanTag(currentWarRows);
  const activeTrackedCurrentWarByClanTag = new Map<string, TodoTrackedCurrentWarRow>();
  for (const [clanTag, currentWar] of currentWarIdentityByClanTag.entries()) {
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
  const trackedWarSnapshotByClanTag = new Map<string, TodoSnapshotRecord>();
  for (const snapshot of snapshotRows) {
    const clanTag = normalizeClanTag(snapshot.warClanTag ?? snapshot.clanTag ?? "");
    if (!clanTag || trackedWarSnapshotByClanTag.has(clanTag)) continue;
    trackedWarSnapshotByClanTag.set(clanTag, snapshot);
  }
  const trackedWarRosterParentRowList = Array.isArray(trackedWarRosterParentRows)
    ? (trackedWarRosterParentRows as TodoTrackedWarRosterCurrentRow[])
    : [];
  const trackedWarRosterParentByClanTag = new Map<string, TodoTrackedWarRosterCurrentRow>(
    trackedWarRosterParentRowList.map((row) => [
      normalizeClanTag(row.clanTag),
      row,
    ] as const).filter((entry): entry is [string, TodoTrackedWarRosterCurrentRow] => Boolean(entry[0])),
  );
  const exactTrackedWarContextByClanTag = new Map<string, TodoTrackedCurrentWarRow>();
  for (const [clanTag, parent] of trackedWarRosterParentByClanTag.entries()) {
    if (!trackedClanTagSet.has(clanTag)) continue;
    const currentWar = currentWarIdentityByClanTag.get(clanTag) ?? null;
    if (!currentWar) continue;
    const identityMatch: TrackedWarRosterIdentityMatch = classifyTrackedWarRosterCurrentIdentity({
      roster: parent,
      currentWar,
    });
    if (identityMatch !== "EXACT_WAR_ID" && identityMatch !== "EXACT_START_TIME") continue;
    const existingSnapshot = trackedWarSnapshotByClanTag.get(clanTag) ?? null;
    const renderState: TrackedWarRosterRenderState = resolveTrackedWarRosterRenderState({
      roster: parent,
      currentWar,
      existingSnapshot,
      identityMatch,
    });
    if (renderState !== "ACTIVE" && renderState !== "RETAINED_ENDED") continue;

    exactTrackedWarContextByClanTag.set(clanTag, {
      clanTag,
      warId: toFiniteIntOrNull(currentWar.warId),
      startTime: currentWar.startTime ?? null,
      state: currentWar.state ?? null,
      updatedAt: currentWar.updatedAt ?? null,
      renderState,
    });
  }
  const trackedWarAttackWhereClauses = [...exactTrackedWarContextByClanTag.values()]
    .map((context) =>
      context.warId !== null
        ? {
            clanTag: context.clanTag,
            warId: context.warId,
            playerTag: { in: linkedTags },
          }
        : context.startTime instanceof Date
          ? {
              clanTag: context.clanTag,
              warStartTime: context.startTime,
              playerTag: { in: linkedTags },
            }
          : null,
    )
    .filter(
      (
        value,
      ): value is
        | { clanTag: string; warId: number; playerTag: { in: string[] } }
        | { clanTag: string; warStartTime: Date; playerTag: { in: string[] } } => value !== null,
    );
  const [trackedWarAttackRows, trackedWarRosterRows] = await Promise.all([
    trackedWarAttackWhereClauses.length > 0
      ? prisma.warAttacks.findMany({
          where:
            trackedWarAttackWhereClauses.length === 1
              ? trackedWarAttackWhereClauses[0]
              : { OR: trackedWarAttackWhereClauses },
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
      : Promise.resolve([]),
    trackedWarAttackWhereClauses.length > 0
      ? prisma.fwaTrackedClanWarRosterMemberCurrent.findMany({
          where: {
            clanTag: { in: [...exactTrackedWarContextByClanTag.keys()] },
            playerTag: { in: linkedTags },
          },
          select: {
            clanTag: true,
            playerTag: true,
            position: true,
            playerName: true,
            townHall: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const trackedWarMemberByClanAndPlayer = buildTrackedWarMemberStateByClanAndPlayer({
    currentWarByClanTag: exactTrackedWarContextByClanTag,
    rosterRows: trackedWarRosterRows,
    warAttackRows: trackedWarAttackRows,
  });

  const renderRows = links.map((link, index) => {
    const normalizedTag = normalizePlayerTag(link.playerTag);
    const snapshot = snapshotByTag.get(normalizedTag) ?? null;
    const missingSnapshot = snapshot === null;
    const staleSnapshot = snapshot ? isSnapshotStale(snapshot, nowMs) : false;
    const snapshotWarClanTag = snapshot
      ? (snapshot as TodoSnapshotRecord & { warClanTag?: string | null }).warClanTag ?? null
      : null;
    const snapshotWarClanName = snapshot
      ? (snapshot as TodoSnapshotRecord & { warClanName?: string | null }).warClanName ?? null
      : null;
    const snapshotWarPosition = snapshot
      ? (snapshot as TodoSnapshotRecord & { warPosition?: number | null }).warPosition ?? null
      : null;
    const snapshotWarSourceUpdatedAt: Date | null = snapshot
      ? ((snapshot as TodoSnapshotRecord & { warSourceUpdatedAt?: Date | null })
          .warSourceUpdatedAt ?? null)
      : null;
    const snapshotRaidSourceUpdatedAt: Date | null = snapshot
      ? ((snapshot as TodoSnapshotRecord & { raidSourceUpdatedAt?: Date | null })
          .raidSourceUpdatedAt ?? null)
      : null;
    const snapshotClanMembershipObservedAt: Date | null = snapshot
      ? ((snapshot as TodoSnapshotRecord & { clanMembershipObservedAt?: Date | null })
          .clanMembershipObservedAt ?? null)
      : null;
    const snapshotClanMembershipObservedAtMs = toTimestampMs(snapshotClanMembershipObservedAt);
    const currentMembershipFresh = Boolean(
      snapshotClanMembershipObservedAtMs !== null &&
        nowMs - snapshotClanMembershipObservedAtMs < TODO_CURRENT_MEMBERSHIP_MAX_AGE_MS,
    );
    const resolvedClanTag = normalizeClanTag(snapshot?.clanTag ?? "") || null;
    const resolvedCwlClanTag = normalizeClanTag(snapshot?.cwlClanTag ?? "") || null;
    const resolvedWarClanTag =
      (snapshot?.warActive
        ? normalizeClanTag(snapshotWarClanTag ?? "") ||
          normalizeClanTag(snapshot?.clanTag ?? "")
        : normalizeClanTag(snapshotWarClanTag ?? "")) || null;
    const resolvedWarClanTagKey = resolvedWarClanTag ?? "";
    const resolvedRaidClanTag =
      normalizeClanTag(snapshot?.raidClanTag ?? "") ||
      (snapshot?.raidActive ? normalizeClanTag(snapshot?.clanTag ?? "") : "") ||
      null;
    const warTrackedClanActive = Boolean(
      resolvedWarClanTag && activeTrackedCurrentWarByClanTag.has(resolvedWarClanTag),
    );
    const warMemberKey = resolvedWarClanTag ? `${resolvedWarClanTag}:${normalizedTag}` : "";
    const trackedWarMember = warMemberKey
      ? trackedWarMemberByClanAndPlayer.get(warMemberKey) ?? null
      : null;
    const exactTrackedWarContext = resolvedWarClanTag
      ? exactTrackedWarContextByClanTag.get(resolvedWarClanTag) ?? null
      : null;
    const snapshotWarOwnerWarId = snapshot
      ? toFiniteIntOrNull(
          (snapshot as TodoSnapshotRecord & { warOwnerWarId?: number | null }).warOwnerWarId,
        )
      : null;
    const warAttackDetailsRenderable = Boolean(
      exactTrackedWarContext &&
        snapshot?.warActive &&
        snapshotWarOwnerWarId !== null &&
        exactTrackedWarContext.warId !== null &&
        snapshotWarOwnerWarId === exactTrackedWarContext.warId,
    );
    const currentTrackedWarClanActive = Boolean(
      resolvedClanTag && activeTrackedCurrentWarByClanTag.has(resolvedClanTag),
    );
    const inValidatedWarMemberSet = Boolean(warTrackedClanActive && trackedWarMember);
    const resolvedWarPosition = snapshot?.warActive
      ? toFiniteIntOrNull(trackedWarMember?.position ?? snapshotWarPosition)
      : null;
    const resolvedWarAttackDetails = warAttackDetailsRenderable
      ? (trackedWarMember?.attackDetails ?? [])
      : [];
    const resolvedTownHall = (() => {
      if (warMemberKey) {
        const clanScoped = townHallByClanAndPlayer.get(warMemberKey);
        if (clanScoped !== undefined && clanScoped > 0) return clanScoped;
      }
      const playerScoped = townHallByPlayerTag.get(normalizedTag);
      if (playerScoped !== undefined && playerScoped > 0) return playerScoped;
      const catalogScoped = townHallByPlayerCatalogTag.get(normalizedTag);
      if (catalogScoped !== undefined && catalogScoped > 0) return catalogScoped;
      const trackedWarTownHall = trackedWarMember?.townHall;
      if (
        trackedWarTownHall !== null &&
        trackedWarTownHall !== undefined &&
        trackedWarTownHall > 0
      ) {
        return trackedWarTownHall;
      }
      if (
        snapshot?.townHall !== null &&
        snapshot?.townHall !== undefined &&
        snapshot.townHall > 0
      ) {
        return snapshot.townHall;
      }
      return null;
    })();
    const currentCwlRound = resolvedCwlClanTag
      ? currentCwlRoundByClanTag.get(resolvedCwlClanTag) ?? null
      : null;
    const currentCwlMember = resolvedCwlClanTag
      ? currentCwlMemberByClanAndPlayerTag.get(`${resolvedCwlClanTag}:${normalizedTag}`) ?? null
      : null;
    const activeCwlPlan = resolvedCwlClanTag
      ? activeCwlPlanByClanTag.get(resolvedCwlClanTag) ?? null
      : null;
    const cwlPlannedSubInAt = resolveTodoCwlPlannedSubInAt({
      currentRound: currentCwlRound,
      currentMemberSubbedIn: Boolean(currentCwlMember?.subbedIn),
      activePlan: activeCwlPlan,
      playerTag: normalizedTag,
    });
    const matchContext = resolvedWarClanTag
      ? warMatchContextByClanTag.get(resolvedWarClanTag) ?? null
      : resolvedClanTag
        ? warMatchContextByClanTag.get(resolvedClanTag) ?? null
      : null;
    const resolvedPlayerName = resolveTodoPlayerDisplayName({
      playerTag: normalizedTag,
      snapshotPlayerName: snapshot?.playerName,
      linkedName: link.linkedName,
    });
    const warFreshnessCandidates = [
      resolvedWarClanTag
        ? currentWarIdentityByClanTag.get(resolvedWarClanTag)?.updatedAt.getTime() ?? null
        : null,
      toTimestampMs(snapshotWarSourceUpdatedAt),
      trackedWarMember?.attackDetails
        ? Math.min(
            ...trackedWarMember.attackDetails
              .map((detail) => detail.seenAtMs)
              .filter((value): value is number => Number.isFinite(value)),
          )
        : null,
      currentTrackedWarClanActive &&
      currentMembershipFresh &&
      Boolean(snapshot) &&
      !snapshot?.warActive &&
      !inValidatedWarMemberSet
        ? toTimestampMs(snapshotClanMembershipObservedAt)
        : null,
      currentTrackedWarClanActive &&
      currentMembershipFresh &&
      Boolean(snapshot) &&
      !snapshot?.warActive &&
      !inValidatedWarMemberSet
        ? currentWarIdentityByClanTag.get(resolvedClanTag ?? "")?.updatedAt.getTime() ?? null
        : null,
    ].filter((value): value is number => Number.isFinite(value));
    const cwlFreshnessCandidates = [
      resolvedCwlClanTag
        ? currentCwlRoundByClanTag.get(resolvedCwlClanTag)?.sourceUpdatedAt?.getTime() ?? null
        : null,
      resolvedCwlClanTag
        ? currentCwlRoundByClanTag.get(resolvedCwlClanTag)?.updatedAt?.getTime() ?? null
        : null,
      resolvedCwlClanTag && normalizedTag
        ? currentCwlMemberByClanAndPlayerTag.get(`${resolvedCwlClanTag}:${normalizedTag}`)?.updatedAt?.getTime() ?? null
        : null,
    ].filter((value): value is number => Number.isFinite(value));
    const raidFreshnessAtMs = resolveFirstTimestampMs([
      snapshotRaidSourceUpdatedAt?.getTime() ?? null,
      snapshot?.lastUpdatedAt?.getTime() ?? null,
      snapshot?.updatedAt?.getTime() ?? null,
    ]);
    const gamesFreshnessCandidates = [
      playerSignalStateFreshnessByTag.get(normalizedTag) ?? null,
    ].filter((value): value is number => Number.isFinite(value));
    return {
      playerTag: normalizedTag,
      playerName: resolvedPlayerName,
      defaultIndex: index,
      townHall: resolvedTownHall,
      clanTag: resolvedClanTag,
      clanName: snapshot?.clanName ?? null,
      warClanTag: resolvedWarClanTag,
      warClanName:
        (snapshotWarClanTag
          ? currentWarIdentityByClanTag.get(resolvedWarClanTagKey)?.clanName ??
            trackedClanNameByTag.get(resolvedWarClanTagKey) ??
            raidTrackedClanNameByTag.get(resolvedWarClanTagKey) ??
            snapshotWarClanName ??
            null
          : snapshotWarClanName ||
            (resolvedWarClanTag ? snapshot?.clanName ?? null : null) ||
            null),
      cwlClanTag: resolvedCwlClanTag,
      cwlClanName: snapshot?.cwlClanName ?? null,
      cwlPlannedSubInAt,
      warPosition: resolvedWarPosition,
      warSourceUpdatedAt:
        snapshotWarSourceUpdatedAt ??
        (resolvedWarClanTag
          ? currentWarIdentityByClanTag.get(resolvedWarClanTag)?.updatedAt ?? null
          : null),
      clanMembershipObservedAt:
        snapshotClanMembershipObservedAt ??
        snapshot?.lastUpdatedAt ??
        snapshot?.updatedAt ??
        null,
      currentMembershipFresh,
      warAttackDetails: resolvedWarAttackDetails,
      warHeaderBadge: resolvedWarClanTag ? clanBadgeByTag.get(resolvedWarClanTag) ?? null : null,
      warMatchIndicator: resolveWarMatchStatusIndicator(matchContext),
      raidClanTracked: Boolean(
        resolvedRaidClanTag &&
          (trackedClanTagSet.has(resolvedRaidClanTag) ||
            raidTrackedClanTagSet.has(resolvedRaidClanTag)),
      ),
      inValidatedWarMemberSet,
      activeTrackedWarClan: currentTrackedWarClanActive,
      warTrackedClanActive,
      snapshot,
      missingSnapshot,
      staleSnapshot,
      displayedFreshnessAtMsByType: {
        WAR: resolveMinimumTimestampMs(warFreshnessCandidates),
        CWL: resolveMinimumTimestampMs(cwlFreshnessCandidates),
        RAIDS: raidFreshnessAtMs,
        GAMES: resolveMinimumTimestampMs(gamesFreshnessCandidates),
      },
    } satisfies TodoRenderRow;
  });

  const missingOrStaleTags = renderRows
    .filter((row) => row.missingSnapshot || row.staleSnapshot)
    .map((row) => row.playerTag);
  const gamesBackfillTags = renderRows
    .filter((row) => needsGamesLifetimeBackfill(row, nowMs))
    .map((row) => row.playerTag);
  const refreshTags = [...new Set([...missingOrStaleTags, ...gamesBackfillTags])];
  if (refreshTags.length > 0) {
    void todoSnapshotService
      .refreshSnapshotsForPlayerTags({
        playerTags: refreshTags,
      })
      .catch(() => undefined);
  }

  const warFreshnessAtMs = resolveTodoPageDisplayedDataFreshnessMs(renderRows, "WAR");
  const cwlFreshnessAtMs = resolveTodoPageDisplayedDataFreshnessMs(renderRows, "CWL");
  const raidsFreshnessAtMs = resolveTodoPageDisplayedDataFreshnessMs(renderRows, "RAIDS");
  const gamesFreshnessAtMs = resolveTodoPageDisplayedDataFreshnessMs(renderRows, "GAMES");
  const warView = buildWarPageDescription(renderRows, linkedTags.length, warFreshnessAtMs);
  const activeLineupCount = renderRows.filter((row) => Boolean(row.snapshot?.warActive)).length;
  const nonLineupCount = renderRows.filter(
    (row) =>
      row.activeTrackedWarClan &&
      row.currentMembershipFresh &&
      Boolean(row.snapshot) &&
      !row.snapshot?.warActive &&
      !row.inValidatedWarMemberSet,
  ).length;
  const suppressedNonLineupStaleMembershipCount = renderRows.filter(
    (row) =>
      row.activeTrackedWarClan &&
      Boolean(row.snapshot) &&
      !row.snapshot?.warActive &&
      !row.inValidatedWarMemberSet &&
      !row.currentMembershipFresh,
  ).length;
  const activeTrackedWarClanCount = new Set(
    renderRows
      .filter((row) => row.activeTrackedWarClan)
      .map((row) => normalizeClanTag(row.clanTag ?? "")),
  ).size;
  const missingWarPositionCount = renderRows.filter(
    (row) => row.snapshot?.warActive && row.warPosition === null,
  ).length;
  const legacyWarFieldUsageCount = renderRows.filter(
    (row) => row.snapshot?.warActive && !row.snapshot?.warClanTag,
  ).length;
  const missingSnapshotCount = renderRows.filter((row) => row.missingSnapshot).length;
  const staleSnapshotCount = renderRows.filter((row) => row.staleSnapshot).length;
  console.info(
    `[todo-service] event=todo_war_render_summary user_id=${input.discordUserId} linked_player_count=${linkedTags.length} active_lineup_count=${activeLineupCount} non_lineup_count=${nonLineupCount} suppressed_non_lineup_stale_membership_count=${suppressedNonLineupStaleMembershipCount} active_tracked_war_clan_count=${activeTrackedWarClanCount} missing_war_position_count=${missingWarPositionCount} legacy_war_field_usage_count=${legacyWarFieldUsageCount} missing_snapshot_count=${missingSnapshotCount} stale_snapshot_count=${staleSnapshotCount} page=WAR`,
  );
  const cwlView = buildCwlPageDescription(renderRows, linkedTags.length, cwlFreshnessAtMs);
  const pages = {
    linkedPlayerCount: linkedTags.length,
    pages: {
      WAR: warView.description,
      CWL: cwlView.description,
      RAIDS: buildRaidsPageDescription(renderRows, linkedTags.length, raidsFreshnessAtMs, nowMs),
      GAMES: buildGamesPageDescription(renderRows, linkedTags.length, nowMs, gamesFreshnessAtMs),
    },
    sidebarStateByType: {
      WAR: warView.sidebarState,
      CWL: cwlView.sidebarState,
      RAIDS: "default",
      GAMES: "default",
    },
  } satisfies TodoPagesResult;

  todoRenderCacheByKey.set(cacheKey, {
    expiresAtMs: nowMs + TODO_RENDER_CACHE_TTL_MS,
    pages,
  });
  return pages;
}

/** Purpose: safely convert nullable Dates into freshness timestamps. */
function toTimestampMs(input: Date | null | undefined): number | null {
  return input instanceof Date ? input.getTime() : null;
}

/** Purpose: normalize a todo render scope token into a stable cache key fragment. */
function resolveTodoRenderScopeId(input: string | null | undefined): string {
  const normalized = String(input ?? "").trim();
  return normalized.length > 0 ? normalized : TODO_GUILD_SCOPE_DM;
}

/** Purpose: convert a todo render scope token into a DB guild filter when applicable. */
function resolveTodoRenderScopeGuildId(input: string | null | undefined): string | null {
  const scopeId = resolveTodoRenderScopeId(input);
  return scopeId === TODO_GUILD_SCOPE_DM ? null : scopeId;
}

/** Purpose: build one compact, user-scoped render cache key tied to scope, linked tags, and snapshot version. */
function buildTodoRenderCacheKey(input: {
  discordUserId: string;
  guildScopeId: string;
  linkedTags: string[];
  snapshotVersion: { snapshotCount: number; maxUpdatedAtMs: number };
}): string {
  const discordUserId = String(input.discordUserId ?? "").trim();
  const generation = todoRenderGenerationByUser.get(discordUserId) ?? 0;
  return [
    discordUserId,
    String(generation),
    resolveTodoRenderScopeId(input.guildScopeId),
    input.linkedTags.join(","),
    String(input.snapshotVersion.snapshotCount),
    String(input.snapshotVersion.maxUpdatedAtMs),
  ].join("|");
}

/** Purpose: drop expired todo render cache entries to keep memory bounded. */
function pruneExpiredTodoRenderCache(nowMs: number): void {
  for (const [key, value] of todoRenderCacheByKey.entries()) {
    if (value.expiresAtMs <= nowMs) {
      todoRenderCacheByKey.delete(key);
    }
  }
}

/** Purpose: classify snapshot freshness using per-type priority windows. */
function isSnapshotStale(snapshot: TodoSnapshotRecord, nowMs: number): boolean {
  const freshnessAt = snapshot.lastUpdatedAt ?? snapshot.updatedAt ?? null;
  if (!freshnessAt) return false;
  const ageMs = Math.max(0, nowMs - freshnessAt.getTime());
  if (snapshot.warActive) return ageMs > TODO_STALE_ACTIVE_WAR_MS;
  if (snapshot.cwlActive) return ageMs > TODO_STALE_ACTIVE_CWL_MS;
  if (snapshot.raidActive) return ageMs > TODO_STALE_ACTIVE_RAID_MS;
  if (isTodoGamesSessionActive(snapshot, nowMs)) {
    return ageMs > TODO_STALE_ACTIVE_GAMES_MS;
  }
  return ageMs > TODO_STALE_IDLE_MS;
}

/** Purpose: build the WAR page from grouped active contexts only. */
function buildWarPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
  displayedFreshnessAtMs: number | null,
): { description: string; sidebarState: TodoSidebarState } {
  const activeRows = rows.filter((row) => Boolean(row.snapshot?.warActive));
  const nonLineupRows = rows.filter(
    (row) =>
      row.activeTrackedWarClan &&
      row.currentMembershipFresh &&
      Boolean(row.snapshot) &&
      !row.snapshot?.warActive &&
      !row.inValidatedWarMemberSet,
  );
  const warCompletion = summarizeWarCompletionStatus(activeRows);
  const hasNonLineupRows = nonLineupRows.length > 0;
  if (activeRows.length <= 0 && !hasNonLineupRows) {
    return {
      description: buildTodoPageDescription({
        heading: "WAR",
        linkedPlayerCount,
        displayedFreshnessAtMs,
        displayedFreshnessLabel: "war data updated",
        statusLine: warCompletion.statusLine,
        lines: ["No war active"],
      }),
      sidebarState: warCompletion.sidebarState,
    };
  }

  const lines: string[] = [];
  if (activeRows.length > 0) {
    const grouped = buildEventGroups(activeRows, "war");
    const unfinishedGroups = grouped.filter((group) => !isWarEventGroupComplete(group));
    const completedGroups = grouped.filter((group) => isWarEventGroupComplete(group));
    const groupedByCompletion = [...unfinishedGroups, ...completedGroups];
    for (const group of groupedByCompletion) {
      lines.push(`**${buildEventGroupHeader(group)}**`);
      for (const row of group.rows) {
        lines.push(formatWarTodoRow(row, getWarRowStatus(row)));
      }
      lines.push("");
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }
  if (hasNonLineupRows) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...buildWarNonLineupSectionLines(nonLineupRows));
  }

  return {
    description: buildTodoPageDescription({
      heading: "WAR",
      linkedPlayerCount,
      displayedFreshnessAtMs,
      displayedFreshnessLabel: "war data updated",
      statusLine:
        activeRows.length > 0
          ? warCompletion.statusLine
          : "No linked accounts are in an active war lineup.",
      lines,
    }),
    sidebarState: warCompletion.sidebarState,
  };
}

/** Purpose: build one bounded informational WAR section for linked players in an active clan but not lineup. */
function buildWarNonLineupSectionLines(rows: TodoRenderRow[]): string[] {
  const sortedRows = [...rows].sort(compareWarNonLineupRowsForRendering);
  const visibleRows = sortedRows.slice(0, TODO_WAR_NON_LINEUP_SECTION_LIMIT);
  const omittedCount = Math.max(0, sortedRows.length - visibleRows.length);
  const lines = [
    "**In active war clan, not in lineup**",
    ...visibleRows.map((row) => formatWarNonLineupRow(row)),
  ];
  if (omittedCount > 0) {
    lines.push(`...and ${omittedCount} more`);
  }
  return lines;
}

/** Purpose: build the CWL page from grouped active contexts only. */
function buildCwlPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
  displayedFreshnessAtMs: number | null,
): { description: string; sidebarState: TodoSidebarState } {
  const contextRows = rows.filter((row) => hasCwlRenderContext(row));
  if (contextRows.length <= 0) {
    return {
      description: buildTodoPageDescription({
        heading: "CWL",
        linkedPlayerCount,
        displayedFreshnessAtMs,
        statusLine: "CWL Status: 0 / 0 attacks completed",
        lines: ["No CWL active"],
      }),
      sidebarState: "default",
    };
  }

  const cwlCompletion = summarizeCwlCompletionStatus(contextRows);
  const grouped = buildEventGroups(contextRows, "cwl");
  const lines: string[] = [];
  for (const group of grouped) {
    lines.push(buildCwlEventGroupHeader(group));
    for (const row of group.rows) {
      lines.push(formatCwlTodoRow(row));
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return {
    description: buildTodoPageDescription({
      heading: "CWL",
      linkedPlayerCount,
      displayedFreshnessAtMs,
      statusLine: cwlCompletion.statusLine,
      lines,
    }),
    sidebarState: cwlCompletion.sidebarState,
  };
}

/** Purpose: sort informational WAR rows by clan first, then player identity. */
function compareWarNonLineupRowsForRendering(a: TodoRenderRow, b: TodoRenderRow): number {
  const clanCompare = buildWarNonLineupClanIdentity(a).localeCompare(
    buildWarNonLineupClanIdentity(b),
    undefined,
    { sensitivity: "base" },
  );
  if (clanCompare !== 0) return clanCompare;
  const playerCompare = sanitizeStatusText(a.playerName).localeCompare(
    sanitizeStatusText(b.playerName),
    undefined,
    { sensitivity: "base" },
  );
  if (playerCompare !== 0) return playerCompare;
  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: render one informational WAR row as plain clan context text. */
function formatWarNonLineupRow(row: TodoRenderRow): string {
  const playerName = sanitizeStatusText(row.playerName) || row.playerTag;
  const clanName = buildWarNonLineupClanIdentity(row);
  const clanTag = row.clanTag ? ` ${row.clanTag}` : "";
  return `- ${playerName} — ${clanName}${clanTag}`;
}

/** Purpose: build stable clan identity text for the non-lineup WAR section. */
function buildWarNonLineupClanIdentity(row: TodoRenderRow): string {
  return sanitizeStatusText(row.clanName) || normalizeClanTag(row.clanTag ?? "") || "Unknown Clan";
}

/** Purpose: compute WAR completion totals and sidebar state from confirmed participating rows. */
function summarizeWarCompletionStatus(
  confirmedRows: TodoRenderRow[],
): { statusLine: string; sidebarState: TodoSidebarState } {
  const completedAttacks = confirmedRows.reduce(
    (sum, row) => sum + getWarRowProgress(row).used,
    0,
  );
  const requiredAttacks = confirmedRows.length * 2;
  const attackPhaseRows = confirmedRows.filter((row) =>
    isWarRowAttackPhaseActive(row),
  );
  if (attackPhaseRows.length <= 0) {
    return {
      statusLine: `war status: ${completedAttacks} / ${requiredAttacks} attacks completed`,
      sidebarState: "default",
    };
  }
  const attackPhaseCompleted = attackPhaseRows.reduce(
    (sum, row) => sum + getWarRowProgress(row).used,
    0,
  );
  const attackPhaseRequired = attackPhaseRows.length * 2;
  return {
    statusLine: `war status: ${completedAttacks} / ${requiredAttacks} attacks completed`,
    sidebarState:
      attackPhaseCompleted >= attackPhaseRequired ? "complete" : "incomplete",
  };
}

/** Purpose: compute CWL completion totals and sidebar state from confirmed active battle-day participants. */
function summarizeCwlCompletionStatus(
  contextRows: TodoRenderRow[],
): { statusLine: string; sidebarState: TodoSidebarState } {
  const battleDayRows = contextRows.filter((row) =>
    isCwlRowAttackPhaseActive(row),
  );
  const completedAttacks = battleDayRows.reduce(
    (sum, row) => sum + getCwlRowProgress(row).used,
    0,
  );
  const requiredAttacks = battleDayRows.reduce(
    (sum, row) => sum + getCwlRowProgress(row).max,
    0,
  );
  if (battleDayRows.length <= 0) {
    return {
      statusLine: "CWL Status: Not in war yet",
      sidebarState: "default",
    };
  }
  return {
    statusLine: `CWL Status: ${completedAttacks} / ${requiredAttacks} attacks completed`,
    sidebarState:
      completedAttacks >= requiredAttacks ? "complete" : "incomplete",
  };
}

/** Purpose: build the RAIDS page with one shared timer header and row-level usage only. */
function buildRaidsPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
  displayedFreshnessAtMs: number | null,
  nowMs = Date.now(),
): string {
  const hasActive = rows.some((row) => isTodoRaidSnapshotActive(row.snapshot, nowMs));
  if (!hasActive) {
    return buildTodoPageDescription({
      heading: "RAIDS",
      linkedPlayerCount,
      displayedFreshnessAtMs,
      lines: ["No raids active"],
    });
  }

  const lines: string[] = [];
  const sharedEndsAt = getSharedEndsAt(rows, "raid", nowMs);
  if (sharedEndsAt) {
    lines.push(`**Time remaining:** ${formatRelativeTimestamp(sharedEndsAt)}`);
    lines.push("");
  }
  for (const row of sortRaidsRows(rows, nowMs)) {
    lines.push(formatRaidsTodoRow(row, getRaidRowStatus(row, nowMs), nowMs));
  }

  return buildTodoPageDescription({
    heading: "RAIDS",
    linkedPlayerCount,
    displayedFreshnessAtMs,
    lines,
  });
}

/** Purpose: build the GAMES page with one shared timer header, points, and completion markers. */
function buildGamesPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
  nowMs: number,
  displayedFreshnessAtMs: number | null,
): string {
  const hasActive = rows.some((row) =>
    isTodoGamesSessionActive(row.snapshot, nowMs),
  );
  if (hasActive) {
    const lines: string[] = [];
    const sharedEndsAt = getSharedEndsAt(rows, "games", nowMs);
    if (sharedEndsAt) {
      lines.push(`**Time remaining:** ${formatRelativeTimestamp(sharedEndsAt)}`);
      lines.push("");
    }
    const sortedRows = sortGamesRows(rows);
    for (const row of sortedRows) {
      lines.push(
        formatGamesTodoRow(row, getGamesRowStatus(row), getGamesProgressEmoji(row)),
      );
    }

    return buildTodoPageDescription({
      heading: "GAMES",
      linkedPlayerCount,
      displayedFreshnessAtMs,
      lines,
    });
  }

  const rewardCollectionEndsAt = resolveGamesRewardCollectionEndsAt(rows, nowMs);
  if (rewardCollectionEndsAt) {
    return buildTodoPageDescription({
      heading: "GAMES",
      linkedPlayerCount,
      displayedFreshnessAtMs,
      lines: buildGamesRewardCollectionLines(rows, rewardCollectionEndsAt),
    });
  }

  const offCycleLines = buildGamesOffCycleLines(rows);
  return buildTodoPageDescription({
    heading: "GAMES",
    linkedPlayerCount,
    displayedFreshnessAtMs,
    lines: offCycleLines,
  });
}

/** Purpose: group active event rows by shared clan/phase/time context for readable section rendering. */
function buildEventGroups(
  rows: TodoRenderRow[],
  mode: "war" | "cwl",
): TodoEventGroup[] {
  const grouped = new Map<string, TodoEventGroup>();
  for (const row of rows) {
    if (!row.snapshot) continue;
    const phase =
      mode === "war"
        ? sanitizeStatusText(row.snapshot.warPhase) || "active phase"
        : sanitizeStatusText(row.snapshot.cwlPhase) || "active phase";
    const phaseEndsAt =
      mode === "war" ? row.snapshot.warEndsAt : row.snapshot.cwlEndsAt;
    const groupedClanTag = mode === "war" ? row.warClanTag ?? row.clanTag : row.cwlClanTag;
    const groupedClanName =
      mode === "war"
        ? row.warClanTag
          ? row.warClanName ?? null
          : row.clanName
        : row.cwlClanName;
    const key = [
      groupedClanTag ?? "",
      groupedClanName ?? "",
      phase,
      phaseEndsAt ? String(phaseEndsAt.getTime()) : "0",
    ].join("|");

    const existing = grouped.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    grouped.set(key, {
      clanTag: groupedClanTag ?? null,
      clanName: groupedClanName ?? null,
      clanBadge: mode === "war" ? row.warHeaderBadge : null,
      matchIndicator: mode === "war" ? row.warMatchIndicator : "",
      phase,
      phaseEndsAt: phaseEndsAt ?? null,
      rows: [row],
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      rows:
        mode === "war"
          ? [...group.rows].sort(compareWarRowsForRendering)
          : [...group.rows].sort((a, b) =>
              formatPlayerIdentity(a).localeCompare(formatPlayerIdentity(b)),
            ),
    }))
    .sort((a, b) => {
      const nameCompare = buildGroupClanIdentity(a).localeCompare(
        buildGroupClanIdentity(b),
      );
      if (nameCompare !== 0) return nameCompare;
      return (a.phaseEndsAt?.getTime() ?? 0) - (b.phaseEndsAt?.getTime() ?? 0);
    });
}

/** Purpose: build one compact active-event header line with clan and phase timing context. */
function buildEventGroupHeader(group: TodoEventGroup): string {
  const badgePrefix = sanitizeStatusText(group.clanBadge);
  const clan = buildGroupClanIdentity(group);
  const matchIndicator = sanitizeStatusText(group.matchIndicator);
  const endsAt = group.phaseEndsAt
    ? ` ends ${formatRelativeTimestamp(group.phaseEndsAt)}`
    : "";
  const prefixedClan = badgePrefix ? `${badgePrefix} ${clan}` : clan;
  const clanWithIndicator = matchIndicator
    ? `${prefixedClan} ${matchIndicator}`
    : prefixedClan;
  return `${clanWithIndicator} - ${group.phase}${endsAt}`;
}

/** Purpose: build one CWL clan section header as a clickable clan-profile line with phase timing suffix. */
function buildCwlEventGroupHeader(group: TodoEventGroup): string {
  const nextWarSuffix = group.phaseEndsAt
    ? `Next war ${formatRelativeTimestamp(group.phaseEndsAt)}`
    : "Next war unknown";
  const clanLink = buildClanProfileMarkdownLink(group.clanName, group.clanTag);
  const clanTagText = group.clanTag ? ` \`${group.clanTag}\`` : "";
  return `${clanLink}${clanTagText} - ${nextWarSuffix}`;
}

/** Purpose: render one clan-profile markdown alias using the tag-stripped Clash link when possible. */
function buildClanProfileMarkdownLink(
  clanName: string | null,
  clanTag: string | null,
): string {
  const normalizedClanTag = normalizeClanTag(clanTag ?? "");
  const fallbackLabel = normalizedClanTag || "Unknown Clan";
  const label = sanitizeStatusText(clanName) || fallbackLabel;
  if (!normalizedClanTag) {
    return label;
  }
  const encodedTag = normalizedClanTag.replace(/^#/, "");
  return `[${label}](https://link.clashofclans.com/en?action=OpenClanProfile&tag=${encodedTag})`;
}

/** Purpose: build stable clan identity text for grouped section headings. */
function buildGroupClanIdentity(group: {
  clanName: string | null;
  clanTag: string | null;
}): string {
  const clanName = sanitizeStatusText(group.clanName) || "Unknown Clan";
  if (group.clanTag) {
    return `${clanName} (${group.clanTag})`;
  }
  return clanName;
}

/** Purpose: find one shared end timestamp for active raid/games contexts to show at page top. */
function getSharedEndsAt(
  rows: TodoRenderRow[],
  mode: "raid" | "games",
  nowMs = Date.now(),
): Date | null {
  const candidates = rows
    .map((row) => {
      if (!row.snapshot) return null;
      if (mode === "raid" && isTodoRaidSnapshotActive(row.snapshot, nowMs)) {
        return row.snapshot.raidEndsAt ?? null;
      }
      if (mode === "games" && isTodoGamesSessionActive(row.snapshot, nowMs)) {
        return row.snapshot.gamesEndsAt ?? null;
      }
      return null;
    })
    .filter((value): value is Date => value instanceof Date);
  if (candidates.length <= 0) return null;
  return [...candidates].sort((a, b) => a.getTime() - b.getTime())[0];
}

/** Purpose: format one WAR row with lineup position and compact attack-detail suffixes. */
function formatWarTodoRow(row: TodoRenderRow, status: string): string {
  const identity = formatWarPlayerIdentity(row);
  const warProgress = getWarRowProgress(row);
  const usedAttacks = warProgress.used;
  const detailRows =
    usedAttacks > 0
      ? row.warAttackDetails
          .slice(0, usedAttacks)
          .map((detail) => formatWarAttackDetail(detail))
          .filter(Boolean)
      : [];
  const detailsSuffix =
    detailRows.length > 0 ? ` | ${detailRows.join(" | ")}` : "";
  const bullet = warProgress.complete ? ":white_check_mark:" : "-";
  return `${bullet} ${identity} - ${status}${detailsSuffix}`;
}

/** Purpose: format one CWL row with WAR-style completion markers and compact attack progress text. */
function formatCwlTodoRow(row: TodoRenderRow): string {
  return `${getCwlRowMarker(row)} ${row.playerName} - ${getCwlRowStatus(row)}`;
}

/** Purpose: format one GAMES row with optional completion marker next to player identity text. */
function formatGamesTodoRow(
  row: TodoRenderRow,
  status: string,
  progressEmoji: string,
): string {
  const points = Math.max(0, toFiniteIntOrNull(row.snapshot?.gamesPoints) ?? 0);
  if (row.snapshot && points <= 0) {
    return `:black_circle: ${formatPlayerIdentity(row)} - ${status}`;
  }
  const progressPrefix = progressEmoji.length > 0 ? `${progressEmoji} ` : "";
  if (progressPrefix) {
    return `${progressPrefix}${formatPlayerIdentity(row)} - ${status}`;
  }
  return `- ${formatPlayerIdentity(row)} - ${status}`;
}

/** Purpose: format one RAIDS row with completion marker emojis and unchanged status text. */
function formatRaidsTodoRow(row: TodoRenderRow, status: string, nowMs = Date.now()): string {
  const marker = getRaidRowMarker(row, nowMs);
  return `${marker} ${row.playerName} - ${status}`;
}

/** Purpose: build one stable player identity token for todo row prefixes. */
function formatPlayerIdentity(row: TodoRenderRow): string {
  if (row.playerName === row.playerTag) {
    return row.playerTag;
  }
  return `${row.playerName} ${row.playerTag}`;
}

/** Purpose: format one WAR player identity with lineup position fallback when unavailable. */
function formatWarPlayerIdentity(row: TodoRenderRow): string {
  const positionLabel =
    row.warPosition !== null && row.warPosition > 0
      ? `#${row.warPosition}`
      : "#?";
  return `${positionLabel} ${row.playerName}`;
}

/** Purpose: build one bounded embed description block for a todo page. */
function buildTodoPageDescription(input: {
  heading: TodoType;
  linkedPlayerCount: number;
  displayedFreshnessAtMs: number | null;
  displayedFreshnessLabel?: string;
  statusLine?: string | null;
  lines: string[];
}): string {
  const statusLine = sanitizeStatusText(input.statusLine ?? "");
  const lines = [
    `Type: ${input.heading}`,
    formatTodoDisplayedDataLegend(
      input.displayedFreshnessAtMs,
      input.displayedFreshnessLabel,
    ),
    statusLine || `Linked players: ${input.linkedPlayerCount}`,
    "",
    ...input.lines,
  ];
  const full = lines.join("\n");
  if (full.length <= DISCORD_DESCRIPTION_LIMIT) return full;
  const suffix = "\n...truncated";
  return `${full.slice(0, DISCORD_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
}

/** Purpose: build active WAR row status text without repeating group-level phase timing details. */
function getWarRowStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "`0 / 2` - snapshot unavailable";
  }
  const { used, max, complete } = getWarRowProgress(row);
  const staleSuffix = row.staleSnapshot && !complete ? " - :hourglass:" : "";
  return `\`${used} / ${max}\`${staleSuffix}`;
}

/** Purpose: compute stable WAR used/max progress and completion flag for row render decisions. */
function getWarRowProgress(row: TodoRenderRow): {
  used: number;
  max: number;
  complete: boolean;
} {
  if (!row.snapshot) {
    return { used: 0, max: 2, complete: false };
  }
  const used = isWarRowAttackPhaseActive(row)
    ? clampInt(row.snapshot.warAttacksUsed, 0, row.snapshot.warAttacksMax || 2)
    : 0;
  const max = Math.max(1, clampInt(row.snapshot.warAttacksMax, 1, 2));
  return { used, max, complete: used >= max };
}

/** Purpose: mark one WAR section complete only when every rendered row is complete. */
function isWarEventGroupComplete(group: TodoEventGroup): boolean {
  if (group.rows.length <= 0) return false;
  return group.rows.every((row) => getWarRowProgress(row).complete);
}

/** Purpose: build active CWL row status text without repeating group-level phase timing details. */
function getCwlRowStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "`0 / 0` - snapshot unavailable";
  }

  if (!isCwlRowAttackPhaseActive(row)) {
    const staleSuffix = row.staleSnapshot ? " - :hourglass:" : "";
    const plannedSuffix = row.cwlPlannedSubInAt
      ? ` - planned sub in ${formatRelativeTimestamp(row.cwlPlannedSubInAt)}`
      : "";
    return `\`0 / 0\`${plannedSuffix}${staleSuffix}`;
  }

  const { used, max } = getCwlRowProgress(row);
  const staleSuffix = row.staleSnapshot ? " - :hourglass:" : "";
  return `\`${used} / ${max}\`${staleSuffix}`;
}

/** Purpose: compute stable CWL used/max progress and completion state for one confirmed participant row. */
function getCwlRowProgress(row: TodoRenderRow): {
  used: number;
  max: number;
  complete: boolean;
} {
  if (!row.snapshot) {
    return { used: 0, max: 1, complete: false };
  }
  const used = clampInt(
    row.snapshot.cwlAttacksUsed,
    0,
    row.snapshot.cwlAttacksMax || 1,
  );
  const max = Math.max(1, clampInt(row.snapshot.cwlAttacksMax, 1, 1));
  return { used, max, complete: used >= max };
}

/** Purpose: resolve one future CWL sub-in timestamp from the confirmed active plan and current persisted round. */
function resolveTodoCwlPlannedSubInAt(input: {
  currentRound: {
    roundDay: number;
    startTime: Date | null;
    roundState: string;
  } | null;
  currentMemberSubbedIn: boolean;
  activePlan: {
    days: Array<{
      roundDay: number;
      rows: Array<{
        playerTag: string;
        playerName: string;
        subbedOut: boolean;
        assignmentOrder: number;
      }>;
    }>;
  } | null;
  playerTag: string;
}): Date | null {
  if (!input.currentRound || input.currentMemberSubbedIn) return null;
  if (!input.activePlan || !input.currentRound.startTime) return null;

  const futureDays = input.activePlan.days
    .filter((day) => day.roundDay > input.currentRound!.roundDay)
    .filter((day) =>
      day.rows.some(
        (row) => !row.subbedOut && normalizePlayerTag(row.playerTag) === input.playerTag,
      ),
    )
    .map((day) => day.roundDay)
    .sort((a, b) => a - b);
  const targetDay = futureDays[0];
  if (!targetDay) return null;

  const dayOffset = Math.max(1, targetDay - input.currentRound.roundDay);
  return new Date(input.currentRound.startTime.getTime() + dayOffset * 24 * 60 * 60 * 1000);
}

/** Purpose: treat only CWL battle-day contexts as attack-active for completion coloring. */
function isCwlRowAttackPhaseActive(row: TodoRenderRow): boolean {
  if (!row.snapshot?.cwlActive) return false;
  const phase = sanitizeStatusText(row.snapshot.cwlPhase).toLowerCase();
  return phase.includes("battle");
}

/** Purpose: include active or upcoming/persisted CWL-clan context rows in the shared CWL page render. */
function hasCwlRenderContext(row: TodoRenderRow): boolean {
  if (!row.snapshot) return false;
  if (row.snapshot.cwlActive) return true;
  return Boolean(row.cwlPlannedSubInAt);
}

/** Purpose: map one CWL row into prep/battle completion markers that match WAR semantics. */
function getCwlRowMarker(row: TodoRenderRow): string {
  if (!isCwlRowAttackPhaseActive(row)) {
    return ":black_circle:";
  }
  return getCwlRowProgress(row).complete
    ? ":white_check_mark:"
    : ":black_circle:";
}

/** Purpose: build RAIDS row status text with usage only and without per-row timer duplication. */
function getRaidRowStatus(row: TodoRenderRow, nowMs = Date.now()): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan capital raids: snapshot unavailable";
  }

  const { used, max } = getRaidRowProgress(row, nowMs);
  const staleSuffix = row.staleSnapshot ? " - :hourglass:" : "";

  if (isTodoRaidSnapshotActive(row.snapshot, nowMs) && used > 0 && !row.raidClanTracked) {
    return `started raids in unknown clan${staleSuffix}`;
  }
  return `${used} / ${max}${staleSuffix}`;
}

/** Purpose: compute stable RAIDS used/max progress and completion flag for row marker decisions. */
function getRaidRowProgress(row: TodoRenderRow, nowMs = Date.now()): {
  used: number;
  max: number;
  complete: boolean;
} {
  if (!row.snapshot) {
    return { used: 0, max: 6, complete: false };
  }
  const active = isTodoRaidSnapshotActive(row.snapshot, nowMs);
  const used = clampInt(
    active ? row.snapshot.raidAttacksUsed : 0,
    0,
    row.snapshot.raidAttacksMax || 6,
  );
  const max = Math.max(1, clampInt(row.snapshot.raidAttacksMax, 1, 6));
  return { used, max, complete: used >= max };
}

/** Purpose: map one RAIDS row into marker semantics for complete/active/not-started states. */
function getRaidRowMarker(row: TodoRenderRow, nowMs = Date.now()): string {
  const progress = getRaidRowProgress(row, nowMs);
  if (progress.used <= 0) {
    return ":black_circle:";
  }
  if (progress.complete) {
    return ":white_check_mark:";
  }
  return ":yellow_circle:";
}

/** Purpose: build GAMES row status text with points and completion marker, without per-row timer duplication. */
function getGamesRowStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan games points: snapshot unavailable";
  }

  const points = Math.max(0, toFiniteIntOrNull(row.snapshot.gamesPoints) ?? 0);
  const target =
    toFiniteIntOrNull(row.snapshot.gamesTarget) ?? TODO_DEFAULT_GAMES_TARGET;
  const staleSuffix = row.staleSnapshot ? " - :hourglass:" : "";

  if (!row.snapshot.gamesActive) {
    return `clan games points: ${points}/${target} - not active${staleSuffix}`;
  }
  return `clan games points: ${points}/${target}${staleSuffix}`;
}

/** Purpose: resolve one todo-row player display name with deterministic linked-user fallback ordering. */
function resolveTodoPlayerDisplayName(input: {
  playerTag: string;
  snapshotPlayerName: unknown;
  linkedName: unknown;
}): string {
  const normalizedTag = normalizePlayerTag(input.playerTag);
  const preferredSnapshotName = sanitizeStatusText(input.snapshotPlayerName);
  if (preferredSnapshotName && preferredSnapshotName !== normalizedTag) {
    return preferredSnapshotName;
  }

  const linkedName = sanitizeStatusText(input.linkedName);
  if (linkedName) {
    return linkedName;
  }

  if (preferredSnapshotName) {
    return preferredSnapshotName;
  }

  return normalizedTag;
}

/** Purpose: compare WAR rows by actual lineup position first to keep rendering aligned with war roster order. */
function compareWarRowsForRendering(a: TodoRenderRow, b: TodoRenderRow): number {
  const aHasPos = a.warPosition !== null && a.warPosition > 0;
  const bHasPos = b.warPosition !== null && b.warPosition > 0;
  if (aHasPos && bHasPos && a.warPosition !== b.warPosition) {
    return Number(a.warPosition) - Number(b.warPosition);
  }
  if (aHasPos !== bHasPos) return aHasPos ? -1 : 1;

  const byName = sanitizeStatusText(a.playerName).localeCompare(
    sanitizeStatusText(b.playerName),
    undefined,
    { sensitivity: "base" },
  );
  if (byName !== 0) return byName;

  const byTag = a.playerTag.localeCompare(b.playerTag);
  if (byTag !== 0) return byTag;

  return a.defaultIndex - b.defaultIndex;
}

/** Purpose: treat preparation phase as attack-inactive so stale prior-war attacks never render. */
function isWarRowAttackPhaseActive(row: TodoRenderRow): boolean {
  if (!row.snapshot?.warActive) return false;
  const phase = sanitizeStatusText(row.snapshot.warPhase).toLowerCase();
  if (phase.includes("preparation")) return false;
  return true;
}

/** Purpose: render one compact WAR attack detail segment for embed-friendly row suffixes. */
function formatWarAttackDetail(input: {
  defenderPosition: number | null;
  stars: number | null;
}): string {
  const defenderLabel =
    input.defenderPosition !== null && input.defenderPosition > 0
      ? `#${input.defenderPosition}`
      : "#?";
  return `:dagger: ${defenderLabel} ${formatWarStarTriplet(input.stars)}`;
}

/** Purpose: render star counts as compact visual triplets used by WAR attack detail rows. */
function formatWarStarTriplet(stars: number | null | undefined): string {
  const normalized = Math.max(0, Math.min(3, Number(stars ?? 0)));
  if (normalized >= 3) return "★ ★ ★";
  if (normalized >= 2) return "★ ★ ☆";
  if (normalized >= 1) return "★ ☆ ☆";
  return "☆ ☆ ☆";
}

/** Purpose: map clan match type/outcome into the same effective status-color semantics used by match views. */
function resolveWarMatchStatusIndicator(
  context: Pick<CurrentWarMatchContextRow, "matchType" | "outcome" | "inferredMatchType"> | null,
): string {
  const resolution = resolveCurrentWarMatchTypeSignal({
    matchType: context?.matchType,
    inferredMatchType: context?.inferredMatchType ?? null,
  });
  const matchType = resolution.confirmed?.matchType ?? resolution.unconfirmed?.matchType ?? null;
  const outcome = sanitizeStatusText(context?.outcome).toUpperCase();
  if (!matchType) return ":grey_question:";
  if (matchType === "BL") return ":black_circle:";
  if (matchType === "MM") return ":white_circle:";
  if (matchType === "SKIP") return ":yellow_circle:";
  if (matchType === "FWA") {
    if (outcome === "LOSE") return ":red_circle:";
    return ":green_circle:";
  }
  return ":grey_question:";
}

/** Purpose: keep one preferred current-war row per clan for header indicator rendering. */
function pickPreferredCurrentWarByClanTag(
  rows: CurrentWarRenderRow[],
): Map<string, CurrentWarRenderRow> {
  const latest = new Map<string, CurrentWarRenderRow>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    const existing = latest.get(clanTag);
    if (!existing || compareCurrentWarRowsForTodo(row, existing) < 0) {
      latest.set(clanTag, {
        clanTag,
        clanName: sanitizeStatusText(row.clanName) || null,
        warId: toFiniteIntOrNull(row.warId),
        startTime: row.startTime ?? null,
        matchType: row.matchType,
        outcome: row.outcome,
        state: row.state,
        inferredMatchType:
          row.inferredMatchType === null || row.inferredMatchType === undefined
            ? null
            : Boolean(row.inferredMatchType),
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep one newest current-war identity row per clan for live war rendering. */
function pickLatestCurrentWarIdentityByClanTag(
  rows: CurrentWarRenderRow[],
): Map<string, CurrentWarRenderRow> {
  const latest = new Map<string, CurrentWarRenderRow>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    const existing = latest.get(clanTag);
    if (!existing || compareCurrentWarRowsForIdentity(row, existing) < 0) {
      latest.set(clanTag, {
        clanTag,
        clanName: sanitizeStatusText(row.clanName) || null,
        warId: toFiniteIntOrNull(row.warId),
        startTime: row.startTime ?? null,
        matchType: row.matchType,
        outcome: row.outcome,
        state: row.state ?? null,
        inferredMatchType:
          row.inferredMatchType === null || row.inferredMatchType === undefined
            ? null
            : Boolean(row.inferredMatchType),
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: compare two current-war rows for deterministic todo rendering. */
function compareCurrentWarRowsForTodo(a: CurrentWarRenderRow, b: CurrentWarRenderRow): number {
  const aConfirmed = a.inferredMatchType === false ? 1 : 0;
  const bConfirmed = b.inferredMatchType === false ? 1 : 0;
  if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;

  const updatedAtDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updatedAtDiff !== 0) return updatedAtDiff;

  const startTimeDiff = (b.startTime?.getTime() ?? -1) - (a.startTime?.getTime() ?? -1);
  if (startTimeDiff !== 0) return startTimeDiff;

  const warIdDiff = (b.warId ?? -1) - (a.warId ?? -1);
  if (warIdDiff !== 0) return warIdDiff;

  return [
    sanitizeStatusText(b.matchType),
    sanitizeStatusText(b.outcome),
    sanitizeStatusText(b.state),
    sanitizeStatusText(b.clanName),
    String(b.inferredMatchType ?? ""),
    b.clanTag,
  ].join("|").localeCompare(
    [
      sanitizeStatusText(a.matchType),
      sanitizeStatusText(a.outcome),
      sanitizeStatusText(a.state),
      sanitizeStatusText(a.clanName),
      String(a.inferredMatchType ?? ""),
      a.clanTag,
    ].join("|"),
    undefined,
    { sensitivity: "base" },
  );
}

/** Purpose: compare two current-war rows for newest live-war identity selection. */
function compareCurrentWarRowsForIdentity(
  a: CurrentWarRenderRow,
  b: CurrentWarRenderRow,
): number {
  const updatedAtDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updatedAtDiff !== 0) return updatedAtDiff;

  const aStart = a.startTime?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bStart = b.startTime?.getTime() ?? Number.NEGATIVE_INFINITY;
  const startTimeDiff = bStart - aStart;
  if (startTimeDiff !== 0) return startTimeDiff;

  const aWarId = a.warId ?? Number.NEGATIVE_INFINITY;
  const bWarId = b.warId ?? Number.NEGATIVE_INFINITY;
  const warIdDiff = bWarId - aWarId;
  if (warIdDiff !== 0) return warIdDiff;

  return [
    sanitizeStatusText(b.clanName),
    sanitizeStatusText(b.matchType),
    sanitizeStatusText(b.outcome),
    sanitizeStatusText(b.state),
    b.clanTag,
  ].join("|").localeCompare(
    [
      sanitizeStatusText(a.clanName),
      sanitizeStatusText(a.matchType),
      sanitizeStatusText(a.outcome),
      sanitizeStatusText(a.state),
      a.clanTag,
    ].join("|"),
    undefined,
    { sensitivity: "base" },
  );
}

/** Purpose: sort games rows by current-cycle points first, then champion total, then stable ties. */
function sortGamesRows(rows: TodoRenderRow[]): TodoRenderRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aPoints = Math.max(0, toFiniteIntOrNull(a.row.snapshot?.gamesPoints) ?? 0);
      const bPoints = Math.max(0, toFiniteIntOrNull(b.row.snapshot?.gamesPoints) ?? 0);
      if (aPoints !== bPoints) {
        return bPoints - aPoints;
      }

      const aTotal = toFiniteIntOrNull(a.row.snapshot?.gamesChampionTotal);
      const bTotal = toFiniteIntOrNull(b.row.snapshot?.gamesChampionTotal);
      const normalizedATotal = aTotal === null ? Number.NEGATIVE_INFINITY : aTotal;
      const normalizedBTotal = bTotal === null ? Number.NEGATIVE_INFINITY : bTotal;
      if (normalizedATotal !== normalizedBTotal) {
        return normalizedBTotal - normalizedATotal;
      }

      const byName = sanitizeStatusText(a.row.playerName).localeCompare(
        sanitizeStatusText(b.row.playerName),
        undefined,
        { sensitivity: "base" },
      );
      if (byName !== 0) return byName;

      const byTag = a.row.playerTag.localeCompare(b.row.playerTag);
      if (byTag !== 0) return byTag;

      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Purpose: sort RAIDS rows by used attacks desc, then TH desc, then stable prior order. */
function sortRaidsRows(rows: TodoRenderRow[], nowMs = Date.now()): TodoRenderRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aUsed = getRaidRowProgress(a.row, nowMs).used;
      const bUsed = getRaidRowProgress(b.row, nowMs).used;
      if (aUsed !== bUsed) {
        return bUsed - aUsed;
      }

      const aTownHall =
        a.row.townHall !== null && a.row.townHall > 0
          ? a.row.townHall
          : Number.NEGATIVE_INFINITY;
      const bTownHall =
        b.row.townHall !== null && b.row.townHall > 0
          ? b.row.townHall
          : Number.NEGATIVE_INFINITY;
      if (aTownHall !== bTownHall) {
        return bTownHall - aTownHall;
      }

      if (a.row.defaultIndex !== b.row.defaultIndex) {
        return a.row.defaultIndex - b.row.defaultIndex;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Purpose: identify whether a RAID snapshot is still inside the current raid window. */
function isTodoRaidSnapshotActive(
  snapshot: TodoSnapshotRecord | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!snapshot?.raidActive) return false;
  if (!(snapshot.raidEndsAt instanceof Date)) return false;
  return snapshot.raidEndsAt.getTime() > nowMs;
}

/** Purpose: map games progress points to deterministic status emoji thresholds. */
function getGamesProgressEmoji(row: TodoRenderRow): string {
  if (!row.snapshot || !row.snapshot.gamesActive) return "";
  const points = Math.max(0, toFiniteIntOrNull(row.snapshot.gamesPoints) ?? 0);
  if (points <= 0) return "";
  if (points >= TODO_GAMES_MAX_POINTS) return "🏆";
  if (points >= TODO_GAMES_COMPLETE_POINTS) return "✅";
  return "🟡";
}

/** Purpose: build one reward-collection Games view with latest finished season results and reward-end timing context. */
function buildGamesRewardCollectionLines(
  rows: TodoRenderRow[],
  rewardCollectionEndsAt: Date,
): string[] {
  const lines: string[] = [
    "Clan Games point earning has ended. Showing latest Clan Games results during reward collection.",
    `**Reward collection time remaining:** ${formatRelativeTimestamp(rewardCollectionEndsAt)}`,
    "",
  ];
  for (const row of sortGamesLatestResultsRows(rows)) {
    lines.push(
      formatGamesTodoRow(
        row,
        getGamesRewardCollectionRowStatus(row),
        getGamesRewardCollectionProgressEmoji(row),
      ),
    );
  }
  return lines;
}

/** Purpose: resolve one reward-collection deadline from dominant snapshot cycle key and guard against post-cutoff stale rows. */
function resolveGamesRewardCollectionEndsAt(
  rows: TodoRenderRow[],
  nowMs: number,
): Date | null {
  const cycleKeys = rows
    .filter(
      (row) =>
        toFiniteIntOrNull(row.snapshot?.gamesPoints) !== null &&
        toFiniteIntOrNull(row.snapshot?.gamesTarget) !== null,
    )
    .map((row) => String(row.snapshot?.gamesCycleKey ?? "").trim())
    .filter((value) => value.length > 0);
  if (cycleKeys.length <= 0) return null;

  const countsByCycleKey = new Map<string, number>();
  for (const key of cycleKeys) {
    countsByCycleKey.set(key, (countsByCycleKey.get(key) ?? 0) + 1);
  }
  const dominantCycleKey = [...countsByCycleKey.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominantCycleKey) return null;

  const cycleBoundary = resolveClanGamesCycleBoundaryFromCycleKey(
    dominantCycleKey,
  );
  if (!cycleBoundary) return null;
  if (nowMs < cycleBoundary.earningEndsMs) return null;
  if (cycleBoundary.rewardCollectionEndsMs <= nowMs) return null;
  return new Date(cycleBoundary.rewardCollectionEndsMs);
}

/** Purpose: sort latest-results rows by final season points desc with stable identity tie-breakers. */
function sortGamesLatestResultsRows(rows: TodoRenderRow[]): TodoRenderRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aPoints = Math.max(0, toFiniteIntOrNull(a.row.snapshot?.gamesPoints) ?? 0);
      const bPoints = Math.max(0, toFiniteIntOrNull(b.row.snapshot?.gamesPoints) ?? 0);
      if (aPoints !== bPoints) return bPoints - aPoints;

      const byName = sanitizeStatusText(a.row.playerName).localeCompare(
        sanitizeStatusText(b.row.playerName),
        undefined,
        { sensitivity: "base" },
      );
      if (byName !== 0) return byName;
      const byTag = a.row.playerTag.localeCompare(b.row.playerTag);
      if (byTag !== 0) return byTag;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Purpose: render reward-collection row status with explicit non-participant labeling for zero-point accounts. */
function getGamesRewardCollectionRowStatus(row: TodoRenderRow): string {
  const points = Math.max(0, toFiniteIntOrNull(row.snapshot?.gamesPoints) ?? 0);
  const target =
    toFiniteIntOrNull(row.snapshot?.gamesTarget) ?? TODO_DEFAULT_GAMES_TARGET;
  if (points <= 0) {
    return `latest clan games points: ${points}/${target} - non-participant`;
  }
  return `latest clan games points: ${points}/${target}`;
}

/** Purpose: map final latest-season points to reward-collection row progress emojis. */
function getGamesRewardCollectionProgressEmoji(row: TodoRenderRow): string {
  const points = Math.max(0, toFiniteIntOrNull(row.snapshot?.gamesPoints) ?? 0);
  if (points <= 0) return "";
  if (points >= TODO_GAMES_MAX_POINTS) return "🏆";
  if (points >= TODO_GAMES_COMPLETE_POINTS) return "✅";
  return "🟡";
}

/** Purpose: build one off-cycle Games view with linked-account lifetime totals only. */
function buildGamesOffCycleLines(rows: TodoRenderRow[]): string[] {
  const sortedRows = sortGamesOffCycleRows(rows);
  const lines: string[] = [
    "Clan Games is not active. Showing lifetime Clan Games totals.",
    "",
  ];
  for (const entry of sortedRows) {
    lines.push(buildGamesOffCycleRowText(entry.row, entry.lifetimePoints));
  }
  return lines;
}

/** Purpose: build one off-cycle Games row from resolved player identity and comma-formatted lifetime total. */
function buildGamesOffCycleRowText(row: TodoRenderRow, lifetimePoints: number): string {
  return `${row.playerName} \`${row.playerTag}\` — ${formatLifetimePoints(lifetimePoints)}`;
}

/** Purpose: sort off-cycle Games rows by lifetime total desc with stable identity tie-breakers. */
function sortGamesOffCycleRows(
  rows: TodoRenderRow[],
): Array<{ row: TodoRenderRow; lifetimePoints: number }> {
  return rows
    .map((row, index) => ({
      row,
      index,
      lifetimePoints: Math.max(
        0,
        toFiniteIntOrNull(row.snapshot?.gamesChampionTotal) ?? 0,
      ),
    }))
    .sort((a, b) => {
      if (a.lifetimePoints !== b.lifetimePoints) {
        return b.lifetimePoints - a.lifetimePoints;
      }
      const byName = sanitizeStatusText(a.row.playerName).localeCompare(
        sanitizeStatusText(b.row.playerName),
        undefined,
        { sensitivity: "base" },
      );
      if (byName !== 0) return byName;
      const byTag = a.row.playerTag.localeCompare(b.row.playerTag);
      if (byTag !== 0) return byTag;
      return a.index - b.index;
    })
    .map(({ row, lifetimePoints }) => ({ row, lifetimePoints }));
}

/** Purpose: map lifetime totals to locale-aware comma-separated labels for off-cycle Games rows. */
function formatLifetimePoints(input: number): string {
  const normalized = Math.max(0, Math.trunc(Number(input) || 0));
  return new Intl.NumberFormat(TODO_LOCALE).format(normalized);
}

/** Purpose: define when Clan Games is actively earning points for `/todo` render and staleness semantics. */
function isTodoGamesSessionActive(
  snapshot: TodoSnapshotRecord | null | undefined,
  nowMs: number,
): boolean {
  if (!snapshot?.gamesActive) return false;
  const endsAtMs = snapshot.gamesEndsAt?.getTime();
  if (!Number.isFinite(endsAtMs)) return false;
  return Number(endsAtMs) > nowMs;
}

/** Purpose: opportunistically refresh snapshots missing off-cycle lifetime totals so `gamesChampionTotal`/baseline can backfill. */
function needsGamesLifetimeBackfill(row: TodoRenderRow, nowMs: number): boolean {
  const snapshot = row.snapshot;
  if (!snapshot) return false;
  if (isTodoGamesSessionActive(snapshot, nowMs)) return false;
  const championTotal = toFiniteIntOrNull(snapshot.gamesChampionTotal);
  const seasonBaseline = toFiniteIntOrNull(snapshot.gamesSeasonBaseline);
  return championTotal === null || seasonBaseline === null;
}

/** Purpose: format one date as a Discord relative timestamp token. */
function formatRelativeTimestamp(input: Date): string {
  return `<t:${Math.floor(input.getTime() / 1000)}:R>`;
}

/** Purpose: build the shared todo freshness legend from the displayed page data timestamp. */
function formatTodoDisplayedDataLegend(
  displayedFreshnessAtMs: number | null,
  label = "last updated",
): string {
  if (displayedFreshnessAtMs === null) {
    return `:hourglass: ${label} unknown`;
  }
  return `:hourglass: ${label} ${formatRelativeTimestamp(
    new Date(displayedFreshnessAtMs),
  )}`;
}

/** Purpose: resolve one page-wide freshness timestamp from the per-row displayed-data timestamps. */
function resolveTodoPageDisplayedDataFreshnessMs(
  rows: TodoRenderRow[],
  type: TodoType,
): number | null {
  const candidates = rows
    .map((row) => row.displayedFreshnessAtMsByType[type])
    .filter((value): value is number => Number.isFinite(value));
  return resolveMinimumTimestampMs(candidates);
}

/** Purpose: choose the oldest usable timestamp from one candidate list. */
function resolveMinimumTimestampMs(values: Array<number | null | undefined>): number | null {
  const candidates = values.filter((value): value is number => Number.isFinite(value));
  if (candidates.length <= 0) return null;
  return candidates.reduce((min, value) => (value < min ? value : min), candidates[0]);
}

/** Purpose: choose the first usable timestamp from one prioritized candidate list. */
function resolveFirstTimestampMs(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Purpose: keep status labels compact and deterministic for embed row rendering. */
function sanitizeStatusText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Purpose: clamp unknown numeric values into one bounded integer range. */
function clampInt(input: unknown, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return min;
  const truncated = Math.trunc(parsed);
  return Math.max(min, Math.min(max, truncated));
}

/** Purpose: convert unknown numeric input to finite integer or null for nullable status fields. */
function toFiniteIntOrNull(input: unknown): number | null {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}
