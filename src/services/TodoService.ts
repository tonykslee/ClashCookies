import { ClanWar } from "../generated/coc-api";
import { CoCService } from "./CoCService";
import {
  listPlayerLinksForDiscordUser,
  normalizeClanTag,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { parseCocTime } from "./war-events/core";

export const TODO_TYPES = ["WAR", "CWL", "RAIDS", "GAMES"] as const;
export type TodoType = (typeof TODO_TYPES)[number];

type TodoPlayerContext = {
  playerTag: string;
  playerName: string;
  clanTag: string | null;
  clanName: string | null;
};

type TodoWindow = {
  active: boolean;
  startMs: number;
  endMs: number;
};

export type TodoPagesResult = {
  linkedPlayerCount: number;
  pages: Record<TodoType, string>;
};

const DISCORD_DESCRIPTION_LIMIT = 4096;

/** Purpose: normalize `/todo type` input into a safe enum value. */
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

/** Purpose: build all todo pages for one Discord user using linked player tags. */
export async function buildTodoPagesForUser(input: {
  discordUserId: string;
  cocService: CoCService;
  nowMs?: number;
}): Promise<TodoPagesResult> {
  const links = await listPlayerLinksForDiscordUser({
    discordUserId: input.discordUserId,
  });
  if (links.length === 0) {
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
  const players = await resolveTodoPlayers(input.cocService, linkedTags);
  const clanTags = [
    ...new Set(
      players
        .map((player) => player.clanTag)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const [warByClanTag, cwlByClanTag] = await Promise.all([
    loadCurrentWarsByClan(input.cocService, clanTags),
    loadActiveCwlWarsByClan(input.cocService, clanTags),
  ]);
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const raidWindow = resolveRaidWeekendWindow(nowMs);
  const clanGamesWindow = resolveClanGamesWindow(nowMs);

  const warRows = players.map((player) =>
    formatTodoRow(player, getWarStatus(player, warByClanTag.get(player.clanTag ?? ""))),
  );
  const cwlRows = players.map((player) =>
    formatTodoRow(player, getCwlStatus(player, cwlByClanTag.get(player.clanTag ?? ""))),
  );
  const raidRows = players.map((player) =>
    formatTodoRow(player, getRaidStatus(raidWindow)),
  );
  const gamesRows = players.map((player) =>
    formatTodoRow(player, getClanGamesStatus(clanGamesWindow)),
  );

  return {
    linkedPlayerCount: players.length,
    pages: {
      WAR: buildTodoPageDescription({
        linkedPlayerCount: players.length,
        heading: "WAR",
        rows: warRows,
      }),
      CWL: buildTodoPageDescription({
        linkedPlayerCount: players.length,
        heading: "CWL",
        rows: cwlRows,
      }),
      RAIDS: buildTodoPageDescription({
        linkedPlayerCount: players.length,
        heading: "RAIDS",
        rows: raidRows,
      }),
      GAMES: buildTodoPageDescription({
        linkedPlayerCount: players.length,
        heading: "GAMES",
        rows: gamesRows,
      }),
    },
  };
}

/** Purpose: load normalized player context for all linked tags. */
async function resolveTodoPlayers(
  cocService: CoCService,
  linkedTags: string[],
): Promise<TodoPlayerContext[]> {
  const profiles = await Promise.all(
    linkedTags.map(async (playerTag) => {
      const profile = await cocService.getPlayerRaw(playerTag).catch(() => null);
      const normalizedTag = normalizePlayerTag(playerTag);
      const playerName = sanitizeDisplayText(String(profile?.name ?? "")) || normalizedTag;
      const clanTagRaw = normalizeClanTag(String(profile?.clan?.tag ?? ""));
      const clanTag = clanTagRaw || null;
      const clanName =
        sanitizeDisplayText(String(profile?.clan?.name ?? "")) || null;
      return {
        playerTag: normalizedTag,
        playerName,
        clanTag,
        clanName,
      } satisfies TodoPlayerContext;
    }),
  );

  return profiles;
}

/** Purpose: bulk-load current-war snapshots for all clans in one command render. */
async function loadCurrentWarsByClan(
  cocService: CoCService,
  clanTags: string[],
): Promise<Map<string, ClanWar | null>> {
  const entries = await Promise.all(
    clanTags.map(async (clanTag) => {
      const war = await cocService.getCurrentWar(clanTag).catch(() => null);
      return [clanTag, war] as const;
    }),
  );
  return new Map(entries);
}

/** Purpose: bulk-load active CWL wars for all clans in one command render. */
async function loadActiveCwlWarsByClan(
  cocService: CoCService,
  clanTags: string[],
): Promise<Map<string, ClanWar | null>> {
  const cwlWarByTag = new Map<string, ClanWar | null>();
  const entries = await Promise.all(
    clanTags.map(async (clanTag) => {
      const war = await resolveActiveCwlWarForClan({
        cocService,
        clanTag,
        cwlWarByTag,
      });
      return [clanTag, war] as const;
    }),
  );
  return new Map(entries);
}

/** Purpose: resolve one clan's currently active CWL war, if present. */
async function resolveActiveCwlWarForClan(input: {
  cocService: CoCService;
  clanTag: string;
  cwlWarByTag: Map<string, ClanWar | null>;
}): Promise<ClanWar | null> {
  const group = await input.cocService
    .getClanWarLeagueGroup(input.clanTag)
    .catch(() => null);
  if (!group || !isCwlGroupActive(group.state)) return null;

  const rounds = Array.isArray(group.rounds) ? [...group.rounds].reverse() : [];
  for (const round of rounds) {
    const warTags = [
      ...new Set(
        (Array.isArray(round?.warTags) ? round.warTags : [])
          .map((warTag) => String(warTag ?? "").trim())
          .filter((warTag) => warTag.length > 0 && warTag !== "#0"),
      ),
    ];
    if (warTags.length === 0) continue;

    const wars = await Promise.all(
      warTags.map(async (warTag) => {
        if (input.cwlWarByTag.has(warTag)) {
          return input.cwlWarByTag.get(warTag) ?? null;
        }
        const war = await input.cocService
          .getClanWarLeagueWar(warTag)
          .catch(() => null);
        input.cwlWarByTag.set(warTag, war);
        return war;
      }),
    );

    const activeWar = wars.find((war) =>
      isWarActiveForClan(war, input.clanTag),
    );
    if (activeWar) return activeWar;
  }

  return null;
}

/** Purpose: format one todo row with required player identity context. */
function formatTodoRow(player: TodoPlayerContext, status: string): string {
  const clanSuffix =
    player.clanTag && player.clanName
      ? ` - ${player.clanName} (${player.clanTag})`
      : player.clanTag
        ? ` - ${player.clanTag}`
        : "";
  return `- ${player.playerName} (${player.playerTag})${clanSuffix}: ${status}`;
}

/** Purpose: build one bounded embed description for a todo category page. */
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

/** Purpose: compute WAR page status text for one player. */
function getWarStatus(player: TodoPlayerContext, war: ClanWar | null | undefined): string {
  if (!player.clanTag) return "war attacks: 0/2 - no clan";
  if (!war || !isWarStateActive(war.state)) {
    return "war attacks: 0/2 - not in active war";
  }
  const member = findWarMemberByTag(war, player.playerTag);
  const attacksUsed = Math.max(
    0,
    Math.min(2, Array.isArray(member?.attacks) ? member.attacks.length : 0),
  );
  const phase = normalizeWarPhaseLabel(war.state);
  const phaseEnd = resolvePhaseEndUnix(war);
  if (phaseEnd !== null) {
    return `war attacks: ${attacksUsed}/2 - ${phase} ends <t:${phaseEnd}:R>`;
  }
  return `war attacks: ${attacksUsed}/2 - ${phase}`;
}

/** Purpose: compute CWL page status text for one player. */
function getCwlStatus(player: TodoPlayerContext, cwlWar: ClanWar | null | undefined): string {
  if (!player.clanTag) return "CWL attacks: 0/1 - no clan";
  if (!cwlWar || !isWarStateActive(cwlWar.state)) {
    return "CWL attacks: 0/1 - not in active CWL war";
  }
  const member = findWarMemberByTag(cwlWar, player.playerTag);
  const attacksUsed = Math.max(
    0,
    Math.min(1, Array.isArray(member?.attacks) ? member.attacks.length : 0),
  );
  const phase = normalizeWarPhaseLabel(cwlWar.state);
  const phaseEnd = resolvePhaseEndUnix(cwlWar);
  if (phaseEnd !== null) {
    return `CWL attacks: ${attacksUsed}/1 - ${phase} ends <t:${phaseEnd}:R>`;
  }
  return `CWL attacks: ${attacksUsed}/1 - ${phase}`;
}

/** Purpose: compute RAIDS page status text using current raid-weekend window. */
function getRaidStatus(window: TodoWindow): string {
  if (!window.active) {
    return `clan capital raids: 0/6 - not active (starts <t:${Math.floor(
      window.startMs / 1000,
    )}:R>)`;
  }
  return `clan capital raids: 0/6 - ends <t:${Math.floor(window.endMs / 1000)}:R>`;
}

/** Purpose: compute GAMES page status text using current clan-games window. */
function getClanGamesStatus(window: TodoWindow): string {
  if (!window.active) {
    return `clan games: not active (starts <t:${Math.floor(window.startMs / 1000)}:R>)`;
  }
  return `clan games: active - ends <t:${Math.floor(window.endMs / 1000)}:R>`;
}

/** Purpose: find a war member across both sides by player tag. */
function findWarMemberByTag(war: ClanWar, playerTag: string) {
  const normalizedTarget = normalizePlayerTag(playerTag);
  const allMembers = [
    ...(Array.isArray(war.clan?.members) ? war.clan.members : []),
    ...(Array.isArray(war.opponent?.members) ? war.opponent.members : []),
  ];
  return allMembers.find(
    (member) => normalizePlayerTag(String(member?.tag ?? "")) === normalizedTarget,
  );
}

/** Purpose: map CoC war-state input to simplified active phase label. */
function normalizeWarPhaseLabel(state: unknown): string {
  const normalized = String(state ?? "").toLowerCase();
  if (normalized.includes("preparation")) return "preparation";
  if (normalized.includes("inwar")) return "battle day";
  return "active phase";
}

/** Purpose: determine whether a war object is active for a specific clan. */
function isWarActiveForClan(war: ClanWar | null | undefined, clanTag: string): boolean {
  if (!war || !isWarStateActive(war.state)) return false;
  const normalizedClanTag = normalizeClanTag(clanTag);
  const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));
  return warClanTag === normalizedClanTag || warOpponentTag === normalizedClanTag;
}

/** Purpose: determine whether CWL group state can contain an active war. */
function isCwlGroupActive(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

/** Purpose: determine whether one war-state value is considered active. */
function isWarStateActive(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

/** Purpose: resolve active phase end-time unix value from one war payload. */
function resolvePhaseEndUnix(war: ClanWar): number | null {
  const normalizedState = String(war.state ?? "").toLowerCase();
  if (normalizedState.includes("preparation")) {
    const prepEnd = parseCocTime(war.startTime ?? null);
    if (prepEnd) return Math.floor(prepEnd.getTime() / 1000);
    return null;
  }
  if (normalizedState.includes("inwar")) {
    const warEnd = parseCocTime(war.endTime ?? null);
    if (warEnd) return Math.floor(warEnd.getTime() / 1000);
    return null;
  }
  return null;
}

/** Purpose: compute the current or next raid-weekend window in UTC. */
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

/** Purpose: compute current or next clan-games window in UTC month cycle. */
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

/** Purpose: sanitize display text values for deterministic compact row output. */
function sanitizeDisplayText(input: string): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

