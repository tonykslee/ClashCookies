import { CoCService } from "./CoCService";
import {
  listPlayerLinksForDiscordUser,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  todoSnapshotService,
  type TodoSnapshotRecord,
} from "./TodoSnapshotService";

export const TODO_TYPES = ["WAR", "CWL", "RAIDS", "GAMES"] as const;
export type TodoType = (typeof TODO_TYPES)[number];

export type TodoPagesResult = {
  linkedPlayerCount: number;
  pages: Record<TodoType, string>;
};

type TodoRenderRow = {
  playerTag: string;
  playerName: string;
  clanTag: string | null;
  clanName: string | null;
  cwlClanTag: string | null;
  cwlClanName: string | null;
  snapshot: TodoSnapshotRecord | null;
  missingSnapshot: boolean;
  staleSnapshot: boolean;
};

type TodoEventGroup = {
  clanTag: string | null;
  clanName: string | null;
  phase: string;
  phaseEndsAt: Date | null;
  rows: TodoRenderRow[];
};

type CachedTodoRender = {
  expiresAtMs: number;
  pages: TodoPagesResult;
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

  const renderRows = links.map((link) => {
    const normalizedTag = normalizePlayerTag(link.playerTag);
    const snapshot = snapshotByTag.get(normalizedTag) ?? null;
    const missingSnapshot = snapshot === null;
    const staleSnapshot = snapshot ? isSnapshotStale(snapshot, nowMs) : false;
    const resolvedPlayerName = resolveTodoPlayerDisplayName({
      playerTag: normalizedTag,
      snapshotPlayerName: snapshot?.playerName,
      linkedName: link.linkedName,
    });
    return {
      playerTag: normalizedTag,
      playerName: resolvedPlayerName,
      clanTag: snapshot?.clanTag ?? null,
      clanName: snapshot?.clanName ?? null,
      cwlClanTag: snapshot?.cwlClanTag ?? null,
      cwlClanName: snapshot?.cwlClanName ?? null,
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

/** Purpose: build the WAR page using grouped active contexts and explicit inactive fallback. */
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
  const inactiveRows = rows.filter((row) => !row.snapshot?.warActive);
  const lines: string[] = [];
  for (const group of grouped) {
    lines.push(`**${buildEventGroupHeader(group)}**`);
    for (const row of group.rows) {
      lines.push(formatTodoRow(row, getWarRowStatus(row)));
    }
    lines.push("");
  }

  if (inactiveRows.length > 0) {
    lines.push("**Not in active war**");
    for (const row of inactiveRows) {
      lines.push(formatTodoRow(row, getWarNeutralStatus(row)));
    }
  } else if (lines.at(-1) === "") {
    lines.pop();
  }

  return buildTodoPageDescription({
    heading: "WAR",
    linkedPlayerCount,
    lines,
  });
}

/** Purpose: build the CWL page using grouped active contexts and explicit inactive fallback. */
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
  const inactiveRows = rows.filter((row) => !row.snapshot?.cwlActive);
  const lines: string[] = [];
  for (const group of grouped) {
    lines.push(`**${buildEventGroupHeader(group)}**`);
    for (const row of group.rows) {
      lines.push(formatTodoRow(row, getCwlRowStatus(row)));
    }
    lines.push("");
  }

  if (inactiveRows.length > 0) {
    lines.push("**Not in active CWL**");
    for (const row of inactiveRows) {
      lines.push(formatTodoRow(row, getCwlNeutralStatus(row)));
    }
  } else if (lines.at(-1) === "") {
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
      phase,
      phaseEndsAt: phaseEndsAt ?? null,
      rows: [row],
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) =>
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
  const clan = buildGroupClanIdentity(group);
  const endsAt = group.phaseEndsAt
    ? ` ends ${formatRelativeTimestamp(group.phaseEndsAt)}`
    : "";
  return `${clan} - ${group.phase}${endsAt}`;
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
    return "war attacks: 0/2 - snapshot unavailable";
  }
  const used = clampInt(row.snapshot.warAttacksUsed, 0, row.snapshot.warAttacksMax || 2);
  const max = Math.max(1, clampInt(row.snapshot.warAttacksMax, 1, 2));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";
  return `war attacks: ${used}/${max}${staleSuffix}`;
}

/** Purpose: build neutral WAR row status text for linked players outside active war groups. */
function getWarNeutralStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "war attacks: 0/2 - snapshot unavailable";
  }

  const used = clampInt(row.snapshot.warAttacksUsed, 0, row.snapshot.warAttacksMax || 2);
  const max = Math.max(1, clampInt(row.snapshot.warAttacksMax, 1, 2));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";
  return `war attacks: ${used}/${max} - not in active war${staleSuffix}`;
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

/** Purpose: build neutral CWL row status text for linked players outside active CWL groups. */
function getCwlNeutralStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "CWL attacks: 0/1 - snapshot unavailable";
  }

  const used = clampInt(row.snapshot.cwlAttacksUsed, 0, row.snapshot.cwlAttacksMax || 1);
  const max = Math.max(1, clampInt(row.snapshot.cwlAttacksMax, 1, 1));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";
  return `CWL attacks: ${used}/${max} - not in active CWL war${staleSuffix}`;
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

/** Purpose: sort games rows by champion total desc with stable deterministic tie-breakers. */
function sortGamesRows(rows: TodoRenderRow[]): TodoRenderRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
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
