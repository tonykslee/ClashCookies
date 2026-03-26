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
  snapshot: TodoSnapshotRecord | null;
  missingSnapshot: boolean;
  staleSnapshot: boolean;
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

  const renderRows = linkedTags.map((playerTag) => {
    const normalizedTag = normalizePlayerTag(playerTag);
    const snapshot = snapshotByTag.get(normalizedTag) ?? null;
    const missingSnapshot = snapshot === null;
    const staleSnapshot = snapshot ? isSnapshotStale(snapshot, nowMs) : false;
    return {
      playerTag: normalizedTag,
      playerName: snapshot?.playerName ?? normalizedTag,
      clanTag: snapshot?.clanTag ?? null,
      clanName: snapshot?.clanName ?? null,
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
      WAR: buildTodoPageDescription({
        heading: "WAR",
        linkedPlayerCount: linkedTags.length,
        rows: renderRows.map((row) => formatTodoRow(row, getWarStatus(row))),
      }),
      CWL: buildTodoPageDescription({
        heading: "CWL",
        linkedPlayerCount: linkedTags.length,
        rows: renderRows.map((row) => formatTodoRow(row, getCwlStatus(row))),
      }),
      RAIDS: buildTodoPageDescription({
        heading: "RAIDS",
        linkedPlayerCount: linkedTags.length,
        rows: renderRows.map((row) => formatTodoRow(row, getRaidStatus(row))),
      }),
      GAMES: buildTodoPageDescription({
        heading: "GAMES",
        linkedPlayerCount: linkedTags.length,
        rows: renderRows.map((row) => formatTodoRow(row, getGamesStatus(row))),
      }),
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

/** Purpose: format one todo row with stable identity context (player + tag + optional clan). */
function formatTodoRow(row: TodoRenderRow, status: string): string {
  const clanSuffix =
    row.clanTag && row.clanName
      ? ` - ${row.clanName} (${row.clanTag})`
      : row.clanTag
        ? ` - ${row.clanTag}`
        : "";
  return `- ${row.playerName} (${row.playerTag})${clanSuffix}: ${status}`;
}

/** Purpose: build one bounded embed description block for a todo page. */
function buildTodoPageDescription(input: {
  heading: TodoType;
  linkedPlayerCount: number;
  rows: string[];
}): string {
  const lines = [
    `Type: ${input.heading}`,
    `Linked players: ${input.linkedPlayerCount}`,
    "",
    ...input.rows,
  ];
  const full = lines.join("\n");
  if (full.length <= DISCORD_DESCRIPTION_LIMIT) return full;
  const suffix = "\n...truncated";
  return `${full.slice(0, DISCORD_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
}

/** Purpose: build WAR status text from snapshot data with stale/unavailable fallback labels. */
function getWarStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "war attacks: 0/2 - snapshot unavailable";
  }

  const used = clampInt(row.snapshot.warAttacksUsed, 0, row.snapshot.warAttacksMax || 2);
  const max = Math.max(1, clampInt(row.snapshot.warAttacksMax, 1, 2));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";

  if (!row.snapshot.warActive) {
    return `war attacks: ${used}/${max} - not in active war${staleSuffix}`;
  }

  const phase = sanitizeStatusText(row.snapshot.warPhase) || "active phase";
  if (row.snapshot.warEndsAt) {
    const unix = Math.floor(row.snapshot.warEndsAt.getTime() / 1000);
    return `war attacks: ${used}/${max} - ${phase} ends <t:${unix}:R>${staleSuffix}`;
  }
  return `war attacks: ${used}/${max} - ${phase}${staleSuffix}`;
}

/** Purpose: build CWL status text from snapshot data with stale/unavailable fallback labels. */
function getCwlStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "CWL attacks: 0/1 - snapshot unavailable";
  }

  const used = clampInt(row.snapshot.cwlAttacksUsed, 0, row.snapshot.cwlAttacksMax || 1);
  const max = Math.max(1, clampInt(row.snapshot.cwlAttacksMax, 1, 1));
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";

  if (!row.snapshot.cwlActive) {
    return `CWL attacks: ${used}/${max} - not in active CWL war${staleSuffix}`;
  }

  const phase = sanitizeStatusText(row.snapshot.cwlPhase) || "active phase";
  if (row.snapshot.cwlEndsAt) {
    const unix = Math.floor(row.snapshot.cwlEndsAt.getTime() / 1000);
    return `CWL attacks: ${used}/${max} - ${phase} ends <t:${unix}:R>${staleSuffix}`;
  }
  return `CWL attacks: ${used}/${max} - ${phase}${staleSuffix}`;
}

/** Purpose: build RAIDS status text from snapshot data with neutral and stale variants. */
function getRaidStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan capital raids: 0/6 - snapshot unavailable";
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

  if (row.snapshot.raidEndsAt) {
    const unix = Math.floor(row.snapshot.raidEndsAt.getTime() / 1000);
    return `clan capital raids: ${used}/${max} - ends <t:${unix}:R>${staleSuffix}`;
  }
  return `clan capital raids: ${used}/${max} - active${staleSuffix}`;
}

/** Purpose: build GAMES status text from snapshot data with neutral and stale variants. */
function getGamesStatus(row: TodoRenderRow): string {
  if (row.missingSnapshot || !row.snapshot) {
    return "clan games: snapshot unavailable";
  }

  const points = toFiniteIntOrNull(row.snapshot.gamesPoints) ?? 0;
  const target =
    toFiniteIntOrNull(row.snapshot.gamesTarget) ?? TODO_DEFAULT_GAMES_TARGET;
  const staleSuffix = row.staleSnapshot ? " - stale snapshot" : "";

  if (!row.snapshot.gamesActive) {
    return `clan games: ${points}/${target} - not active${staleSuffix}`;
  }

  if (row.snapshot.gamesEndsAt) {
    const unix = Math.floor(row.snapshot.gamesEndsAt.getTime() / 1000);
    return `clan games: ${points}/${target} - ends <t:${unix}:R>${staleSuffix}`;
  }
  return `clan games: ${points}/${target} - active${staleSuffix}`;
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