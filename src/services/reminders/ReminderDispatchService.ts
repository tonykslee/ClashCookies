import { ReminderType } from "@prisma/client";
import { Client } from "discord.js";
import type { ClanWar } from "../../generated/coc-api";
import { formatError } from "../../helper/formatError";
import { splitDiscordLineMessages } from "../../helper/discordLineMessageSplit";
import { prisma } from "../../prisma";
import { CoCService, type ClanCapitalRaidSeason } from "../CoCService";
import { normalizeClanTag, normalizePlayerTag } from "../PlayerLinkService";
import { parseCocTime } from "../war-events/core";

export type ReminderDispatchInput = {
  guildId: string;
  channelId: string;
  reminderId: string;
  type: ReminderType;
  clanTag: string;
  clanName: string | null;
  offsetSeconds: number;
  eventIdentity: string;
  eventEndsAt: Date;
  eventLabel: string;
};

export type ReminderDispatchResult =
  | {
      status: "sent";
      messageId: string;
    }
  | {
      status: "failed";
      errorMessage: string;
  };

type ReminderDispatchCoCClient = Pick<
  CoCService,
  "getClanWarLeagueGroup" | "getClanWarLeagueWar" | "getClanCapitalRaidSeasons" | "getClan"
>;

type ReminderDispatchDependencies = {
  cocService?: ReminderDispatchCoCClient | null;
  nowMsProvider?: () => number;
};

type ReminderRosterSemantic = "WAR" | "CWL" | "RAIDS" | "OTHER";

type ReminderRosterEntry = {
  playerTag: string;
  playerName: string;
  position: number | null;
  discordUserId: string | null;
  attacksRemaining: number;
  attacksMax: number;
};

type ReminderRosterResolveResult = {
  windowActive: boolean;
  lines: string[];
};

const MAX_REMINDER_MESSAGES = 3;

/** Purpose: send one reminder message sequence to configured channels with deterministic type-aware content. */
export class ReminderDispatchService {
  private resolvedDefaultCoCService = false;
  private cachedDefaultCoCService: ReminderDispatchCoCClient | null = null;

  /** Purpose: initialize optional runtime dependencies used by send-time roster enrichment. */
  constructor(private readonly deps: ReminderDispatchDependencies = {}) {}

  /** Purpose: dispatch one reminder notification and return sent/failed metadata for fire-log persistence. */
  async dispatchReminder(client: Client, input: ReminderDispatchInput): Promise<ReminderDispatchResult> {
    try {
      const channel = await client.channels.fetch(input.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return {
          status: "failed",
          errorMessage: "channel_unavailable_or_not_text_based",
        };
      }

      const contents = await buildReminderDispatchContents({
        input,
        nowMs: this.getNowMs(),
        cocService: this.getCoCService(),
      });
      if (contents.length <= 0) {
        return {
          status: "failed",
          errorMessage: "attack_window_not_active",
        };
      }
      let firstMessageId: string | null = null;
      for (const content of contents) {
        const sent = await channel.send({
          content,
          allowedMentions: {
            parse: ["users"],
          },
        });
        if (!firstMessageId) {
          firstMessageId = sent.id;
        }
      }
      return {
        status: "sent",
        messageId: firstMessageId ?? "unknown",
      };
    } catch (error) {
      return {
        status: "failed",
        errorMessage: formatError(error),
      };
    }
  }

  /** Purpose: resolve one deterministic "now" timestamp source for all render math in this send call. */
  private getNowMs(): number {
    return this.deps.nowMsProvider ? this.deps.nowMsProvider() : Date.now();
  }

  /** Purpose: resolve one optional CoC client for CWL/RAIDS roster lookups without hard-failing when env is missing. */
  private getCoCService(): ReminderDispatchCoCClient | null {
    if (this.deps.cocService !== undefined) {
      return this.deps.cocService;
    }
    if (this.resolvedDefaultCoCService) {
      return this.cachedDefaultCoCService;
    }
    this.resolvedDefaultCoCService = true;
    try {
      this.cachedDefaultCoCService = new CoCService();
    } catch {
      this.cachedDefaultCoCService = null;
    }
    return this.cachedDefaultCoCService;
  }
}

/** Purpose: expose one shared reminder dispatch service singleton. */
export const reminderDispatchService = new ReminderDispatchService();

/** Purpose: build one to three reminder messages with optional attack-remaining roster continuation for send-time reminder posts. */
async function buildReminderDispatchContents(input: {
  input: ReminderDispatchInput;
  nowMs: number;
  cocService: ReminderDispatchCoCClient | null;
}): Promise<string[]> {
  const payload = input.input;
  const headerLines = buildReminderDispatchHeaderLines({
    input: payload,
    nowMs: input.nowMs,
  });
  const semantic = resolveReminderRosterSemantic({
    reminderType: payload.type,
    eventIdentity: payload.eventIdentity,
  });
  const roster = await resolveReminderRosterLines({
    input: payload,
    semantic,
    cocService: input.cocService,
    nowMs: input.nowMs,
  });
  if (semantic !== "OTHER" && !roster.windowActive) {
    return [];
  }
  return buildReminderContentsWithRosterOverflow({
    headerLines,
    rosterLines: roster.lines,
  });
}

/** Purpose: build deterministic core reminder header lines shared by all reminder dispatch messages. */
function buildReminderDispatchHeaderLines(input: {
  input: ReminderDispatchInput;
  nowMs: number;
}): string[] {
  const payload = input.input;
  const clanLabel = payload.clanName
    ? `${payload.clanName} ${payload.clanTag}`
    : payload.clanTag;
  const offsetLabel = formatOffsetLabel(payload.offsetSeconds);
  const remainingSeconds = Math.max(
    0,
    Math.floor((payload.eventEndsAt.getTime() - input.nowMs) / 1000),
  );
  const endUnix = Math.floor(payload.eventEndsAt.getTime() / 1000);

  return [
    `### ${getReminderHeadingLabel(payload.type)} in ${offsetLabel}`,
    `Clan: ${clanLabel}`,
    `Time remaining: <t:${endUnix}:R> (${remainingSeconds}s)`,
    `Ends at: <t:${endUnix}:F> (<t:${endUnix}:R>)`,
  ];
}

/** Purpose: resolve roster semantics for WAR/CWL/RAIDS reminder sends, using event identity to split WAR vs CWL paths. */
function resolveReminderRosterSemantic(input: {
  reminderType: ReminderType;
  eventIdentity: string;
}): ReminderRosterSemantic {
  if (input.reminderType === ReminderType.RAIDS) return "RAIDS";
  if (input.reminderType !== ReminderType.WAR_CWL) return "OTHER";
  return String(input.eventIdentity).startsWith("CWL:") ? "CWL" : "WAR";
}

/** Purpose: resolve and format all send-time roster lines with linked-user mentions for eligible members with attacks remaining. */
async function resolveReminderRosterLines(input: {
  input: ReminderDispatchInput;
  semantic: ReminderRosterSemantic;
  cocService: ReminderDispatchCoCClient | null;
  nowMs: number;
}): Promise<ReminderRosterResolveResult> {
  if (input.semantic === "OTHER") {
    return { windowActive: true, lines: [] };
  }

  let windowActive = false;
  let roster: ReminderRosterEntry[] = [];
  if (input.semantic === "WAR") {
    const resolved = await resolveWarReminderRoster({
      clanTag: input.input.clanTag,
    });
    windowActive = resolved.windowActive;
    roster = resolved.roster;
  } else if (input.semantic === "CWL") {
    const resolved = await resolveCwlReminderRoster({
      clanTag: input.input.clanTag,
      cocService: input.cocService,
    });
    windowActive = resolved.windowActive;
    roster = resolved.roster;
  } else if (input.semantic === "RAIDS") {
    const resolved = await resolveRaidsReminderRoster({
      clanTag: input.input.clanTag,
      cocService: input.cocService,
      nowMs: input.nowMs,
    });
    windowActive = resolved.windowActive;
    roster = resolved.roster;
  }

  if (!windowActive || roster.length <= 0) {
    return {
      windowActive,
      lines: [],
    };
  }

  const tags = [...new Set(roster.map((entry) => entry.playerTag).filter(Boolean))];
  const linkRows =
    tags.length > 0
      ? await prisma.playerLink.findMany({
          where: { playerTag: { in: tags } },
          select: {
            playerTag: true,
            discordUserId: true,
          },
        })
      : [];
  const linkedDiscordIdByTag = new Map(
    linkRows
      .map((row) => [normalizePlayerTag(row.playerTag), String(row.discordUserId)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
  const sortedRoster = keepSameUserAccountsAdjacent(
    roster.map((entry) => ({
      ...entry,
      discordUserId: linkedDiscordIdByTag.get(entry.playerTag) ?? null,
    })),
  );

  return {
    windowActive,
    lines: sortedRoster.map((entry) => {
      const mention = entry.discordUserId;
      if (input.semantic === "RAIDS") {
        if (mention) {
          return `${entry.playerName} - <@${mention}> - ${entry.attacksRemaining} / ${entry.attacksMax}`;
        }
        return `:no: ${entry.playerName} - ${entry.attacksRemaining} / ${entry.attacksMax}`;
      }

      const positionLabel =
        entry.position !== null && entry.position > 0 ? `#${entry.position}` : "#?";
      if (mention) {
        return `${positionLabel} - ${entry.playerName} - <@${mention}> - ${entry.attacksRemaining} / ${entry.attacksMax}`;
      }
      return `${positionLabel} - :no: ${entry.playerName} - ${entry.attacksRemaining} / ${entry.attacksMax}`;
    }),
  };
}

/** Purpose: resolve WAR roster entries from current war-member feed rows and keep only members with attacks remaining. */
async function resolveWarReminderRoster(input: {
  clanTag: string;
}): Promise<{ windowActive: boolean; roster: ReminderRosterEntry[] }> {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag) return { windowActive: false, roster: [] };

  const currentWar = await prisma.currentWar.findFirst({
    where: { clanTag },
    orderBy: { updatedAt: "desc" },
    select: { state: true },
  });
  if (!isBattleWarState(currentWar?.state)) {
    return { windowActive: false, roster: [] };
  }

  const rows = await prisma.fwaWarMemberCurrent.findMany({
    where: { clanTag },
    select: {
      playerTag: true,
      playerName: true,
      position: true,
      attacks: true,
    },
  });

  const roster = rows
    .map((row): ReminderRosterEntry | null => {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) return null;
      const playerName = sanitizeReminderPlayerName(row.playerName, playerTag);
      const attacksUsed = clampInt(row.attacks, 0, 2);
      const attacksRemaining = Math.max(0, 2 - attacksUsed);
      return {
        playerTag,
        playerName,
        position: toFiniteIntOrNull(row.position),
        discordUserId: null,
        attacksRemaining,
        attacksMax: 2,
      } satisfies ReminderRosterEntry;
    })
    .filter((entry): entry is ReminderRosterEntry => Boolean(entry && entry.attacksRemaining > 0))
    .sort(compareRosterByPositionThenName);

  return {
    windowActive: true,
    roster,
  };
}

/** Purpose: resolve CWL roster entries from the currently active CWL war roster for the tracked clan side only. */
async function resolveCwlReminderRoster(input: {
  clanTag: string;
  cocService: ReminderDispatchCoCClient | null;
}): Promise<{ windowActive: boolean; roster: ReminderRosterEntry[] }> {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag || !input.cocService) {
    return { windowActive: false, roster: [] };
  }

  const war = await resolveActiveCwlBattleWarForClan({
    clanTag,
    cocService: input.cocService,
  });
  if (!war) return { windowActive: false, roster: [] };

  const members = resolveTrackedWarMembers({
    war,
    trackedClanTag: clanTag,
  });
  const roster = members
    .map((member): ReminderRosterEntry | null => {
      const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
      if (!playerTag) return null;
      const playerName = sanitizeReminderPlayerName(member?.name, playerTag);
      const attacksUsed = Array.isArray(member?.attacks) ? member.attacks.length : 0;
      const attacksRemaining = Math.max(0, 1 - clampInt(attacksUsed, 0, 1));
      return {
        playerTag,
        playerName,
        position: toFiniteIntOrNull(member?.mapPosition),
        discordUserId: null,
        attacksRemaining,
        attacksMax: 1,
      } satisfies ReminderRosterEntry;
    })
    .filter((entry): entry is ReminderRosterEntry => Boolean(entry && entry.attacksRemaining > 0))
    .sort(compareRosterByPositionThenName);

  return {
    windowActive: true,
    roster,
  };
}

/** Purpose: resolve RAIDS roster entries from the current active raid-season member eligibility set for one tracked clan. */
async function resolveRaidsReminderRoster(input: {
  clanTag: string;
  cocService: ReminderDispatchCoCClient | null;
  nowMs: number;
}): Promise<{ windowActive: boolean; roster: ReminderRosterEntry[] }> {
  const clanTag = normalizeClanTag(input.clanTag);
  if (!clanTag || !input.cocService) {
    return { windowActive: false, roster: [] };
  }

  const seasons = await input.cocService
    .getClanCapitalRaidSeasons(clanTag, 2)
    .catch(() => []);
  const activeSeason = selectActiveRaidSeasonForReminder({
    seasons,
    nowMs: input.nowMs,
  });
  if (!activeSeason) return { windowActive: false, roster: [] };

  const clan = await input.cocService.getClan(clanTag).catch(() => null);
  const clanMembers = Array.isArray(clan?.members)
    ? (clan.members as Array<{ tag?: unknown; name?: unknown }>)
    : [];
  const clanMemberNameByTag = new Map(
    clanMembers
      .map((member) => {
        const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
        const playerName = sanitizeReminderPlayerName(member?.name, playerTag);
        return [playerTag, playerName] as const;
      })
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );

  const raidMembers = Array.isArray(activeSeason.members)
    ? (activeSeason.members as Array<{ tag?: unknown; name?: unknown; attacks?: unknown }>)
    : [];
  const roster: ReminderRosterEntry[] = [];
  for (const member of raidMembers) {
    const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
    if (!playerTag) continue;
    const playerName = sanitizeReminderPlayerName(
      member?.name ?? clanMemberNameByTag.get(playerTag),
      playerTag,
    );
    const attacksUsed = clampInt(member?.attacks, 0, 6);
    const attacksRemaining = Math.max(0, 6 - attacksUsed);
    if (attacksRemaining <= 0) continue;
    roster.push({
      playerTag,
      playerName,
      position: null,
      discordUserId: null,
      attacksRemaining,
      attacksMax: 6,
    });
  }

  return {
    windowActive: true,
    roster: roster.sort((a, b) => {
      if (a.attacksRemaining !== b.attacksRemaining) {
        return a.attacksRemaining - b.attacksRemaining;
      }
      const byName = a.playerName.localeCompare(b.playerName, undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
      return a.playerTag.localeCompare(b.playerTag);
    }),
  };
}

/** Purpose: select one raid season aligned to active-window or event-end timing so send-time roster resolution stays deterministic. */
function selectActiveRaidSeasonForReminder(input: {
  seasons: ClanCapitalRaidSeason[];
  nowMs: number;
}): ClanCapitalRaidSeason | null {
  if (!Array.isArray(input.seasons) || input.seasons.length <= 0) return null;

  const candidates = input.seasons.map((season) => {
    const startMs = parseCocTime(season.startTime ?? null)?.getTime() ?? null;
    const endMs = parseCocTime(season.endTime ?? null)?.getTime() ?? null;
    return {
      season,
      startMs,
      endMs,
    };
  });

  const active = candidates.find((candidate) => {
    if (!Number.isFinite(candidate.startMs) || !Number.isFinite(candidate.endMs)) return false;
    return input.nowMs >= Number(candidate.startMs) && input.nowMs < Number(candidate.endMs);
  });
  return active?.season ?? null;
}

/** Purpose: resolve the tracked clan side member list from one CWL war payload. */
function resolveTrackedWarMembers(input: {
  war: ClanWar;
  trackedClanTag: string;
}): Array<{
  tag?: string;
  name?: string;
  mapPosition?: number;
  attacks?: unknown[] | null;
}> {
  const trackedClanTag = normalizeClanTag(input.trackedClanTag);
  const warClanTag = normalizeClanTag(String(input.war?.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(input.war?.opponent?.tag ?? ""));
  if (trackedClanTag && trackedClanTag === warClanTag) {
    return Array.isArray(input.war?.clan?.members)
      ? input.war.clan.members
      : [];
  }
  if (trackedClanTag && trackedClanTag === warOpponentTag) {
    return Array.isArray(input.war?.opponent?.members)
      ? input.war.opponent.members
      : [];
  }
  return [];
}

/** Purpose: resolve one active CWL war for a clan by traversing league rounds newest-first with shared war-tag fetches. */
async function resolveActiveCwlBattleWarForClan(input: {
  clanTag: string;
  cocService: ReminderDispatchCoCClient;
}): Promise<ClanWar | null> {
  const group = await input.cocService.getClanWarLeagueGroup(input.clanTag).catch(() => null);
  if (!group || !isActiveWarState(group.state)) return null;

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
      warTags.map((warTag) =>
        input.cocService.getClanWarLeagueWar(warTag).catch(() => null),
      ),
    );

    const active = wars.find((war) => {
      if (!war || !isBattleWarState(war.state)) return false;
      const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
      const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));
      return warClanTag === input.clanTag || warOpponentTag === input.clanTag;
    });
    if (active) return active;
  }

  return null;
}

/** Purpose: build final one-to-three message output with line-safe overflow handling and hard cap at three messages. */
function buildReminderContentsWithRosterOverflow(input: {
  headerLines: string[];
  rosterLines: string[];
}): string[] {
  const lines =
    input.rosterLines.length > 0
      ? [...input.headerLines, "", "Players With Attacks Remaining:", ...input.rosterLines]
      : [...input.headerLines];
  return splitDiscordLineMessages({
    lines,
    maxMessages: MAX_REMINDER_MESSAGES,
  });
}

/** Purpose: compare roster rows by lineup position first, then stable name/tag fallback ordering. */
function compareRosterByPositionThenName(a: ReminderRosterEntry, b: ReminderRosterEntry): number {
  const aHasPos = a.position !== null && a.position > 0;
  const bHasPos = b.position !== null && b.position > 0;
  if (aHasPos && bHasPos && a.position !== b.position) {
    return Number(a.position) - Number(b.position);
  }
  if (aHasPos !== bHasPos) return aHasPos ? -1 : 1;

  const byName = a.playerName.localeCompare(b.playerName, undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) return byName;
  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: keep linked users' multiple accounts adjacent while preserving first-seen group order and per-group line order. */
function keepSameUserAccountsAdjacent(roster: ReminderRosterEntry[]): ReminderRosterEntry[] {
  const groups = new Map<string, ReminderRosterEntry[]>();
  const groupOrder: string[] = [];
  for (const entry of roster) {
    const ownerKey = entry.discordUserId
      ? `discord:${entry.discordUserId}`
      : `player:${entry.playerTag}`;
    if (!groups.has(ownerKey)) {
      groups.set(ownerKey, []);
      groupOrder.push(ownerKey);
    }
    groups.get(ownerKey)!.push(entry);
  }
  return groupOrder.flatMap((ownerKey) => groups.get(ownerKey) ?? []);
}

/** Purpose: normalize one player display name into compact deterministic text with player-tag fallback. */
function sanitizeReminderPlayerName(input: unknown, fallbackTag: string): string {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : fallbackTag;
}

/** Purpose: convert unknown number-like values into bounded integers for deterministic attack and position math. */
function clampInt(input: unknown, min: number, max: number): number {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return min;
  const truncated = Math.trunc(parsed);
  return Math.max(min, Math.min(max, truncated));
}

/** Purpose: convert unknown values to finite integers for nullable position fields. */
function toFiniteIntOrNull(input: unknown): number | null {
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

/** Purpose: classify war-state text values into active/non-active buckets used by CWL roster resolution. */
function isActiveWarState(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

/** Purpose: classify war-state values into attack-window-active battle-day states only. */
function isBattleWarState(state: unknown): boolean {
  const normalized = String(state ?? "").toLowerCase();
  return normalized.includes("inwar");
}

/** Purpose: map reminder types to the first-line heading label used in plain-text delivery. */
function getReminderHeadingLabel(type: ReminderType): string {
  if (type === ReminderType.WAR_CWL) return "War ends";
  if (type === ReminderType.RAIDS) return "Raid weekend ends";
  if (type === ReminderType.GAMES) return "Clan games end";
  return "Event ends";
}

/** Purpose: render one offset in human-readable compact `HhMm` format for plain-text reminder headers. */
function formatOffsetLabel(offsetSeconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(offsetSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}

export const buildReminderDispatchContentsForTest = buildReminderDispatchContents;
