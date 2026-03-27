import { CoCService } from "./CoCService";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { prisma } from "../prisma";
import {
  todoSnapshotService,
  type TodoSnapshotRecord,
} from "./TodoSnapshotService";
import {
  buildTrackedWarMemberStateByClanAndPlayer,
  buildTrackedWarMemberStateByPlayerTag,
  isTodoWarStateActive,
  type TodoTrackedCurrentWarRow,
} from "./TodoTrackedWarStateService";

export const TODO_TYPES = ["WAR", "CWL", "RAIDS", "GAMES"] as const;
export type TodoType = (typeof TODO_TYPES)[number];

export type TodoPagesResult = {
  linkedPlayerCount: number;
  pages: Record<TodoType, string>;
};

type TodoRenderRow = {
  playerTag: string;
  playerName: string;
  defaultIndex: number;
  clanTag: string | null;
  clanName: string | null;
  cwlClanTag: string | null;
  cwlClanName: string | null;
  warPosition: number | null;
  warAttackDetails: Array<{
    defenderPosition: number | null;
    stars: number | null;
  }>;
  warHeaderBadge: string | null;
  warMatchIndicator: string;
  snapshot: TodoSnapshotRecord | null;
  missingSnapshot: boolean;
  staleSnapshot: boolean;
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

type WarMemberCurrentRow = {
  clanTag: string;
  playerTag: string;
  position: number | null;
  attacks: number | null;
  defender1Position: number | null;
  stars1: number | null;
  defender2Position: number | null;
  stars2: number | null;
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

type CurrentWarMatchContextRow = {
  clanTag: string;
  warId: number | null;
  startTime: Date | null;
  matchType: string | null;
  outcome: string | null;
  state: string | null;
  updatedAt: Date;
};

const DISCORD_DESCRIPTION_LIMIT = 4096;
const TODO_RENDER_CACHE_TTL_MS = 30_000;
const TODO_STALE_ACTIVE_WAR_MS = 2 * 60 * 1000;
const TODO_STALE_ACTIVE_CWL_MS = 5 * 60 * 1000;
const TODO_STALE_ACTIVE_RAID_MS = 15 * 60 * 1000;
const TODO_STALE_ACTIVE_GAMES_MS = 30 * 60 * 1000;
const TODO_STALE_IDLE_MS = 4 * 60 * 60 * 1000;
const TODO_DEFAULT_GAMES_TARGET = 4000;
const TODO_GAMES_COMPLETE_POINTS = 4000;
const TODO_GAMES_MAX_POINTS = 10_000;
const todoRenderCacheByKey = new Map<string, CachedTodoRender>();

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
}

/** Purpose: build snapshot-backed todo pages for one user with cheap cache re-use. */
export async function buildTodoPagesForUser(input: {
  discordUserId: string;
  cocService?: CoCService;
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
    };
  }

  const linkedTags = links.map((row) => row.playerTag);
  const snapshotVersion = await todoSnapshotService.getSnapshotVersion({
    playerTags: linkedTags,
  });
  const cacheKey = buildTodoRenderCacheKey({
    discordUserId: input.discordUserId,
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
  const clanTags = [
    ...new Set(
      snapshotRows
        .map((row) => normalizeClanTag(row.clanTag ?? ""))
        .filter(Boolean),
    ),
  ];

  const [warMemberRows, trackedClanRows, currentWarRows] = await Promise.all([
    prisma.fwaWarMemberCurrent.findMany({
      where: { playerTag: { in: linkedTags } },
      select: {
        clanTag: true,
        playerTag: true,
        position: true,
        attacks: true,
        defender1Position: true,
        stars1: true,
        defender2Position: true,
        stars2: true,
        sourceSyncedAt: true,
      },
    }),
    clanTags.length > 0
      ? prisma.trackedClan.findMany({
          where: { tag: { in: clanTags } },
          select: { tag: true, clanBadge: true },
        })
      : Promise.resolve([]),
    clanTags.length > 0
      ? prisma.currentWar.findMany({
          where: { clanTag: { in: clanTags } },
          select: {
            clanTag: true,
            warId: true,
            startTime: true,
            matchType: true,
            outcome: true,
            state: true,
            updatedAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const latestWarMemberByClanAndPlayer =
    pickLatestWarMemberByClanAndPlayer(warMemberRows);
  const latestWarMemberByPlayerTag = pickLatestWarMemberByPlayerTag(warMemberRows);
  const trackedClanTagSet = new Set(
    trackedClanRows
      .map((row) => normalizeClanTag(row.tag))
      .filter(Boolean),
  );
  const clanBadgeByTag = new Map(
    trackedClanRows
      .map((row) => [normalizeClanTag(row.tag), sanitizeStatusText(row.clanBadge)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
  const warMatchContextByClanTag =
    pickLatestCurrentWarMatchContextByClanTag(currentWarRows);
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
    });
  }
  const activeTrackedClanTags = [...activeTrackedCurrentWarByClanTag.keys()];
  const trackedWarAttackRows: WarAttacksRow[] =
    activeTrackedClanTags.length > 0
      ? await prisma.warAttacks.findMany({
          where: {
            clanTag: { in: activeTrackedClanTags },
            playerTag: { in: linkedTags },
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
  const trackedWarMemberByClanAndPlayer = buildTrackedWarMemberStateByClanAndPlayer({
    currentWarByClanTag: activeTrackedCurrentWarByClanTag,
    warAttackRows: trackedWarAttackRows,
  });
  const trackedWarMemberByPlayerTag = buildTrackedWarMemberStateByPlayerTag(
    trackedWarMemberByClanAndPlayer,
  );

  const renderRows = links.map((link, index) => {
    const normalizedTag = normalizePlayerTag(link.playerTag);
    const snapshot = snapshotByTag.get(normalizedTag) ?? null;
    const missingSnapshot = snapshot === null;
    const staleSnapshot = snapshot ? isSnapshotStale(snapshot, nowMs) : false;
    const resolvedClanTag = normalizeClanTag(snapshot?.clanTag ?? "") || null;
    const warMemberKey = resolvedClanTag ? `${resolvedClanTag}:${normalizedTag}` : "";
    const warMemberFromFeed = warMemberKey
      ? latestWarMemberByClanAndPlayer.get(warMemberKey) ?? null
      : null;
    const fallbackWarMemberFromFeed =
      warMemberFromFeed ?? latestWarMemberByPlayerTag.get(normalizedTag) ?? null;
    const trackedWarMember = warMemberKey
      ? trackedWarMemberByClanAndPlayer.get(warMemberKey) ?? null
      : null;
    const fallbackTrackedWarMember =
      trackedWarMember ?? trackedWarMemberByPlayerTag.get(normalizedTag) ?? null;
    const trackedClanActive = Boolean(
      resolvedClanTag && trackedClanTagSet.has(resolvedClanTag),
    );
    const resolvedWarPosition = trackedClanActive
      ? toFiniteIntOrNull(
          fallbackTrackedWarMember?.position ?? fallbackWarMemberFromFeed?.position,
        )
      : toFiniteIntOrNull(fallbackWarMemberFromFeed?.position);
    const resolvedWarAttackDetails = trackedClanActive
      ? (fallbackTrackedWarMember?.attackDetails ?? [])
      : resolveWarAttackDetails(fallbackWarMemberFromFeed);
    const matchContext = resolvedClanTag
      ? warMatchContextByClanTag.get(resolvedClanTag) ?? null
      : null;
    const resolvedPlayerName = resolveTodoPlayerDisplayName({
      playerTag: normalizedTag,
      snapshotPlayerName: snapshot?.playerName,
      linkedName: link.linkedName,
    });
    return {
      playerTag: normalizedTag,
      playerName: resolvedPlayerName,
      defaultIndex: index,
      clanTag: resolvedClanTag,
      clanName: snapshot?.clanName ?? null,
      cwlClanTag: snapshot?.cwlClanTag ?? null,
      cwlClanName: snapshot?.cwlClanName ?? null,
      warPosition: resolvedWarPosition,
      warAttackDetails: resolvedWarAttackDetails,
      warHeaderBadge: resolvedClanTag ? clanBadgeByTag.get(resolvedClanTag) ?? null : null,
      warMatchIndicator: resolveWarMatchStatusIndicator(matchContext),
      snapshot,
      missingSnapshot,
      staleSnapshot,
    } satisfies TodoRenderRow;
  });

  const missingOrStaleTags = renderRows
    .filter((row) => row.missingSnapshot || row.staleSnapshot)
    .map((row) => row.playerTag);
  if (missingOrStaleTags.length > 0) {
    void todoSnapshotService
      .refreshSnapshotsForPlayerTags({
        playerTags: missingOrStaleTags,
      })
      .catch(() => undefined);
  }

  const pages = {
    linkedPlayerCount: linkedTags.length,
    pages: {
      WAR: buildWarPageDescription(renderRows, linkedTags.length),
      CWL: buildCwlPageDescription(renderRows, linkedTags.length),
      RAIDS: buildRaidsPageDescription(renderRows, linkedTags.length),
      GAMES: buildGamesPageDescription(renderRows, linkedTags.length),
    },
  } satisfies TodoPagesResult;

  todoRenderCacheByKey.set(cacheKey, {
    expiresAtMs: nowMs + TODO_RENDER_CACHE_TTL_MS,
    pages,
  });
  return pages;
}

/** Purpose: build one compact, user-scoped render cache key tied to linked tags + snapshot version. */
function buildTodoRenderCacheKey(input: {
  discordUserId: string;
  linkedTags: string[];
  snapshotVersion: { snapshotCount: number; maxUpdatedAtMs: number };
}): string {
  return [
    input.discordUserId,
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
  const ageMs = Math.max(0, nowMs - snapshot.lastUpdatedAt.getTime());
  if (snapshot.warActive) return ageMs > TODO_STALE_ACTIVE_WAR_MS;
  if (snapshot.cwlActive) return ageMs > TODO_STALE_ACTIVE_CWL_MS;
  if (snapshot.raidActive) return ageMs > TODO_STALE_ACTIVE_RAID_MS;
  if (snapshot.gamesActive) return ageMs > TODO_STALE_ACTIVE_GAMES_MS;
  return ageMs > TODO_STALE_IDLE_MS;
}

/** Purpose: build the WAR page from grouped active contexts only. */
function buildWarPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
): string {
  const activeRows = rows.filter((row) => Boolean(row.snapshot?.warActive));
  if (activeRows.length <= 0) {
    return buildTodoPageDescription({
      heading: "WAR",
      linkedPlayerCount,
      lines: ["No war active"],
    });
  }

  const grouped = buildEventGroups(activeRows, "war");
  const unfinishedGroups = grouped.filter((group) => !isWarEventGroupComplete(group));
  const completedGroups = grouped.filter((group) => isWarEventGroupComplete(group));
  const groupedByCompletion = [...unfinishedGroups, ...completedGroups];
  const lines: string[] = [];
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

  return buildTodoPageDescription({
    heading: "WAR",
    linkedPlayerCount,
    lines,
  });
}

/** Purpose: build the CWL page from grouped active contexts only. */
function buildCwlPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
): string {
  const activeRows = rows.filter((row) => Boolean(row.snapshot?.cwlActive));
  if (activeRows.length <= 0) {
    return buildTodoPageDescription({
      heading: "CWL",
      linkedPlayerCount,
      lines: ["No CWL active"],
    });
  }

  const grouped = buildEventGroups(activeRows, "cwl");
  const lines: string[] = [];
  for (const group of grouped) {
    lines.push(`**${buildEventGroupHeader(group)}**`);
    for (const row of group.rows) {
      lines.push(formatTodoRow(row, getCwlRowStatus(row)));
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return buildTodoPageDescription({
    heading: "CWL",
    linkedPlayerCount,
    lines,
  });
}

/** Purpose: build the RAIDS page with one shared timer header and row-level usage only. */
function buildRaidsPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
): string {
  const hasActive = rows.some((row) => Boolean(row.snapshot?.raidActive));
  if (!hasActive) {
    return buildTodoPageDescription({
      heading: "RAIDS",
      linkedPlayerCount,
      lines: ["No raids active"],
    });
  }

  const lines: string[] = [];
  const sharedEndsAt = getSharedEndsAt(rows, "raid");
  if (sharedEndsAt) {
    lines.push(`**Time remaining:** ${formatRelativeTimestamp(sharedEndsAt)}`);
    lines.push("");
  }
  for (const row of rows) {
    lines.push(formatTodoRow(row, getRaidRowStatus(row)));
  }

  return buildTodoPageDescription({
    heading: "RAIDS",
    linkedPlayerCount,
    lines,
  });
}

/** Purpose: build the GAMES page with one shared timer header, points, and completion markers. */
function buildGamesPageDescription(
  rows: TodoRenderRow[],
  linkedPlayerCount: number,
): string {
  const hasActive = rows.some((row) => Boolean(row.snapshot?.gamesActive));
  if (!hasActive) {
    return buildTodoPageDescription({
      heading: "GAMES",
      linkedPlayerCount,
      lines: ["Clan Games is not active"],
    });
  }

  const lines: string[] = [];
  const sharedEndsAt = getSharedEndsAt(rows, "games");
  if (sharedEndsAt) {
    lines.push(`**Time remaining:** ${formatRelativeTimestamp(sharedEndsAt)}`);
    lines.push("");
  }
  const sortedRows = sortGamesRows(rows);
  for (const row of sortedRows) {
    lines.push(formatGamesTodoRow(row, getGamesRowStatus(row), getGamesProgressEmoji(row)));
  }

  return buildTodoPageDescription({
    heading: "GAMES",
    linkedPlayerCount,
    lines,
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
    const groupedClanTag = mode === "war" ? row.clanTag : row.cwlClanTag;
    const groupedClanName = mode === "war" ? row.clanName : row.cwlClanName;
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
function getSharedEndsAt(rows: TodoRenderRow[], mode: "raid" | "games"): Date | null {
  const candidates = rows
    .map((row) => {
      if (!row.snapshot) return null;
      if (mode === "raid" && row.snapshot.raidActive) {
        return row.snapshot.raidEndsAt ?? null;
      }
      if (mode === "games" && row.snapshot.gamesActive) {
        return row.snapshot.gamesEndsAt ?? null;
      }
      return null;
    })
    .filter((value): value is Date => value instanceof Date);
  if (candidates.length <= 0) return null;
  return [...candidates].sort((a, b) => a.getTime() - b.getTime())[0];
}

/** Purpose: format one todo row with stable identity context (player + tag). */
function formatTodoRow(row: TodoRenderRow, status: string): string {
  return `- ${formatPlayerIdentity(row)} - ${status}`;
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

/** Purpose: format one GAMES row with optional completion marker next to player identity text. */
function formatGamesTodoRow(
  row: TodoRenderRow,
  status: string,
  progressEmoji: string,
): string {
  const progressPrefix = progressEmoji.length > 0 ? `${progressEmoji} ` : "";
  return `- ${progressPrefix}${formatPlayerIdentity(row)} - ${status}`;
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
  lines: string[];
}): string {
  const lines = [
    `Type: ${input.heading}`,
    `Linked players: ${input.linkedPlayerCount}`,
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
  const { used, max } = getWarRowProgress(row);
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";
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
    return "CWL attacks: 0/1 - snapshot unavailable";
  }

  const used = clampInt(row.snapshot.cwlAttacksUsed, 0, row.snapshot.cwlAttacksMax || 1);
  const max = Math.max(1, clampInt(row.snapshot.cwlAttacksMax, 1, 1));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";
  return `CWL attacks: ${used}/${max}${staleSuffix}`;
}

/** Purpose: build RAIDS row status text with usage only and without per-row timer duplication. */
function getRaidRowStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan capital raids: snapshot unavailable";
  }

  const used = clampInt(
    row.snapshot.raidAttacksUsed,
    0,
    row.snapshot.raidAttacksMax || 6,
  );
  const max = Math.max(1, clampInt(row.snapshot.raidAttacksMax, 1, 6));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";

  if (!row.snapshot.raidActive) {
    return `clan capital raids: ${used}/${max} - not active${staleSuffix}`;
  }
  return `clan capital raids: ${used}/${max}${staleSuffix}`;
}

/** Purpose: build GAMES row status text with points and completion marker, without per-row timer duplication. */
function getGamesRowStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan games points: snapshot unavailable";
  }

  const points = Math.max(0, toFiniteIntOrNull(row.snapshot.gamesPoints) ?? 0);
  const target =
    toFiniteIntOrNull(row.snapshot.gamesTarget) ?? TODO_DEFAULT_GAMES_TARGET;
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";

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

/** Purpose: extract compact first/second attack details from one latest war-member row. */
function resolveWarAttackDetails(
  row: Pick<
    WarMemberCurrentRow,
    "defender1Position" | "stars1" | "defender2Position" | "stars2"
  > | null,
): Array<{ defenderPosition: number | null; stars: number | null }> {
  if (!row) return [];
  return [
    {
      defenderPosition: toFiniteIntOrNull(row.defender1Position),
      stars: toFiniteIntOrNull(row.stars1),
    },
    {
      defenderPosition: toFiniteIntOrNull(row.defender2Position),
      stars: toFiniteIntOrNull(row.stars2),
    },
  ];
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
  context: Pick<CurrentWarMatchContextRow, "matchType" | "outcome"> | null,
): string {
  const matchType = sanitizeStatusText(context?.matchType).toUpperCase();
  const outcome = sanitizeStatusText(context?.outcome).toUpperCase();
  if (matchType === "BL") return ":black_circle:";
  if (matchType === "MM") return ":white_circle:";
  if (matchType === "SKIP") return ":yellow_circle:";
  if (matchType === "FWA") {
    if (outcome === "LOSE") return ":red_circle:";
    return ":green_circle:";
  }
  return ":white_circle:";
}

/** Purpose: keep only the freshest war-member row for each clan+player pair. */
function pickLatestWarMemberByClanAndPlayer(
  rows: WarMemberCurrentRow[],
): Map<string, WarMemberCurrentRow> {
  const latest = new Map<string, WarMemberCurrentRow>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    const key = `${clanTag}:${playerTag}`;
    const existing = latest.get(key);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latest.set(key, {
        clanTag,
        playerTag,
        position: toFiniteIntOrNull(row.position),
        attacks: toFiniteIntOrNull(row.attacks),
        defender1Position: toFiniteIntOrNull(row.defender1Position),
        stars1: toFiniteIntOrNull(row.stars1),
        defender2Position: toFiniteIntOrNull(row.defender2Position),
        stars2: toFiniteIntOrNull(row.stars2),
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep one freshest war-member row per player tag as fallback when clan-tag joins are stale. */
function pickLatestWarMemberByPlayerTag(
  rows: WarMemberCurrentRow[],
): Map<string, WarMemberCurrentRow> {
  const latest = new Map<string, WarMemberCurrentRow>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!clanTag || !playerTag) continue;
    const existing = latest.get(playerTag);
    if (!existing || row.sourceSyncedAt > existing.sourceSyncedAt) {
      latest.set(playerTag, {
        clanTag,
        playerTag,
        position: toFiniteIntOrNull(row.position),
        attacks: toFiniteIntOrNull(row.attacks),
        defender1Position: toFiniteIntOrNull(row.defender1Position),
        stars1: toFiniteIntOrNull(row.stars1),
        defender2Position: toFiniteIntOrNull(row.defender2Position),
        stars2: toFiniteIntOrNull(row.stars2),
        sourceSyncedAt: row.sourceSyncedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep one latest current-war match context row per clan for header indicator rendering. */
function pickLatestCurrentWarMatchContextByClanTag(
  rows: CurrentWarMatchContextRow[],
): Map<string, CurrentWarMatchContextRow> {
  const latest = new Map<string, CurrentWarMatchContextRow>();
  for (const row of rows) {
    const clanTag = normalizeClanTag(row.clanTag);
    if (!clanTag) continue;
    const existing = latest.get(clanTag);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latest.set(clanTag, {
        clanTag,
        warId: toFiniteIntOrNull(row.warId),
        startTime: row.startTime ?? null,
        matchType: row.matchType,
        outcome: row.outcome,
        state: row.state,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
}

/** Purpose: keep one latest current-war identity row per clan for tracked WarAttacks resolution. */
function pickLatestCurrentWarIdentityByClanTag(
  rows: Array<{
    clanTag: string;
    warId: number | null;
    startTime: Date | null;
    state: string | null;
    updatedAt: Date;
  }>,
): Map<
  string,
  {
    clanTag: string;
    warId: number | null;
    startTime: Date | null;
    state: string | null;
    updatedAt: Date;
  }
> {
  const latest = new Map<
    string,
    {
      clanTag: string;
      warId: number | null;
      startTime: Date | null;
      state: string | null;
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
        startTime: row.startTime ?? null,
        state: row.state ?? null,
        updatedAt: row.updatedAt,
      });
    }
  }
  return latest;
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

/** Purpose: map games progress points to deterministic status emoji thresholds. */
function getGamesProgressEmoji(row: TodoRenderRow): string {
  if (!row.snapshot || !row.snapshot.gamesActive) return "";
  const points = Math.max(0, toFiniteIntOrNull(row.snapshot.gamesPoints) ?? 0);
  if (points <= 0) return "";
  if (points >= TODO_GAMES_MAX_POINTS) return "🏆";
  if (points >= TODO_GAMES_COMPLETE_POINTS) return "✅";
  return "🟡";
}

/** Purpose: format one date as a Discord relative timestamp token. */
function formatRelativeTimestamp(input: Date): string {
  return `<t:${Math.floor(input.getTime() / 1000)}:R>`;
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
