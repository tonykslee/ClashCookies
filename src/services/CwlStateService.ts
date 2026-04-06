import {
  type ClanWar,
  type ClanWarLeagueClanMember,
  type ClanWarLeagueGroup,
  type ClanWarMember,
} from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import {
  normalizeClanTag,
  normalizePersistedPlayerName,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { parseCocTime } from "./war-events/core";

export type CwlCurrentRoundRecord = {
  season: string;
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  teamSize: number | null;
  attacksPerMember: number;
  preparationStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  sourceUpdatedAt: Date;
  members: CwlCurrentRoundMemberRecord[];
};

export type CwlCurrentRoundMemberRecord = {
  season: string;
  clanTag: string;
  playerTag: string;
  roundDay: number;
  playerName: string;
  mapPosition: number | null;
  townHall: number | null;
  attacksUsed: number;
  attacksAvailable: number;
  stars: number;
  destruction: number;
  subbedIn: boolean;
  subbedOut: boolean;
};

export type CwlPreparationSnapshotRecord = {
  season: string;
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  preparationStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  sourceUpdatedAt: Date;
  members: Array<{
    playerTag: string;
    playerName: string;
    mapPosition: number | null;
    townHall: number | null;
    subbedIn: boolean;
    subbedOut: boolean;
  }>;
};

export type CwlSeasonRosterEntry = {
  season: string;
  clanTag: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  linkedDiscordUserId: string | null;
  linkedDiscordUsername: string | null;
  daysParticipated: number;
  currentRound: {
    roundDay: number;
    roundState: string;
    inCurrentLineup: boolean;
    attacksUsed: number;
    attacksAvailable: number;
    opponentTag: string | null;
    opponentName: string | null;
    phaseEndsAt: Date | null;
  } | null;
};

export type CwlActualLineup = {
  season: string;
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  phaseEndsAt: Date | null;
  members: Array<{
    playerTag: string;
    playerName: string;
    mapPosition: number | null;
    townHall: number | null;
    attacksUsed: number;
    attacksAvailable: number;
    subbedIn: boolean;
    subbedOut: boolean;
  }>;
};

export type RefreshTrackedCwlStateResult = {
  season: string;
  trackedClanCount: number;
  refreshedClanCount: number;
  currentRoundCount: number;
  currentMemberCount: number;
  historyRoundCount: number;
  historyMemberCount: number;
};

type ObservedCwlRoundMember = {
  playerTag: string;
  playerName: string;
  mapPosition: number | null;
  townHall: number | null;
  attacksUsed: number;
  attacksAvailable: number;
  stars: number;
  destruction: number;
  subbedIn: boolean;
  subbedOut: boolean;
};

type ObservedCwlRound = {
  season: string;
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  leagueGroupState: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  teamSize: number | null;
  attacksPerMember: number;
  preparationStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
  sourceUpdatedAt: Date;
  members: ObservedCwlRoundMember[];
};

type ObservedSeasonRosterMember = {
  playerTag: string;
  playerName: string;
  townHall: number | null;
  daysParticipated: number;
  lastRoundDay: number | null;
};

type ObservedTrackedClanState = {
  season: string;
  clanTag: string;
  fetched: boolean;
  currentRound: ObservedCwlRound | null;
  currentPreparationRound: ObservedCwlRound | null;
  historyRounds: ObservedCwlRound[];
  seasonRoster: ObservedSeasonRosterMember[];
};

function sanitizeCwlName(input: unknown, fallback: string | null = null): string | null {
  return normalizePersistedPlayerName(input) ?? fallback;
}

function normalizeSeasonKey(input: unknown, fallback: string): string {
  const normalized = String(input ?? "").trim();
  return /^\d{4}-\d{2}$/.test(normalized) ? normalized : fallback;
}

function normalizePlayerTags(input: string[]): string[] {
  return [...new Set(input.map((tag) => normalizePlayerTag(String(tag ?? ""))).filter(Boolean))];
}

function normalizeRoundState(input: unknown): string {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : "notInWar";
}

function isCurrentRoundState(state: string): boolean {
  const normalized = state.toLowerCase();
  return normalized.includes("preparation") || normalized.includes("inwar");
}

function isEndedRoundState(state: string): boolean {
  return state.toLowerCase().includes("warended");
}

function scoreCurrentRoundState(state: string): number {
  const normalized = state.toLowerCase();
  if (normalized.includes("inwar")) return 2;
  if (normalized.includes("preparation")) return 1;
  return 0;
}

function resolvePhaseEndsAt(input: {
  roundState: string;
  preparationStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
}): Date | null {
  const state = input.roundState.toLowerCase();
  if (state.includes("preparation")) return input.startTime;
  if (state.includes("inwar")) return input.endTime;
  return input.endTime;
}

type CwlActualLineupOwner = {
  season: string;
  clanTag: string;
  clanName: string | null;
  roundDay: number;
  roundState: string;
  opponentTag: string | null;
  opponentName: string | null;
  preparationStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
};

type CwlPrepSnapshotOwner = CwlActualLineupOwner & {
  lineupJson: unknown;
  sourceUpdatedAt: Date;
};

function toRecordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "x"].includes(normalized)) return true;
    if (["false", "0", "no", "n", ""].includes(normalized)) return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

function normalizePrepSnapshotMembers(value: unknown): CwlPreparationSnapshotRecord["members"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = toRecordValue(entry);
      if (!record) return null;
      const playerTag = normalizePlayerTag(String(record.playerTag ?? ""));
      if (!playerTag) return null;
      const playerName =
        sanitizeCwlName(record.playerName, playerTag) ??
        playerTag;
      const mapPosition = Number.isFinite(Number(record.mapPosition))
        ? Math.trunc(Number(record.mapPosition))
        : null;
      const townHall = Number.isFinite(Number(record.townHall))
        ? Math.trunc(Number(record.townHall))
        : null;
      return {
        playerTag,
        playerName,
        mapPosition,
        townHall,
        subbedIn: normalizeBooleanValue(record.subbedIn, true),
        subbedOut: normalizeBooleanValue(record.subbedOut, false),
      };
    })
    .filter((member): member is CwlPreparationSnapshotRecord["members"][number] => Boolean(member))
    .sort(compareRoundMembers);
}

function buildPrepSnapshotLineupJson(
  members: ObservedCwlRoundMember[],
): Array<{
  playerTag: string;
  playerName: string;
  mapPosition: number | null;
  townHall: number | null;
  subbedIn: boolean;
  subbedOut: boolean;
}> {
  return members.map((member) => ({
    playerTag: member.playerTag,
    playerName: member.playerName,
    mapPosition: member.mapPosition,
    townHall: member.townHall,
    subbedIn: member.subbedIn,
    subbedOut: member.subbedOut,
  }));
}

/** Purpose: map one persisted CWL round owner row into a lineup response with sorted members. */
async function loadPersistedCwlActualLineup(input: {
  owner: CwlActualLineupOwner;
  memberSource: "current" | "history";
}): Promise<CwlActualLineup> {
  const members =
    input.memberSource === "current"
      ? await prisma.cwlRoundMemberCurrent.findMany({
          where: {
            season: input.owner.season,
            clanTag: input.owner.clanTag,
            roundDay: input.owner.roundDay,
          },
          orderBy: [{ mapPosition: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
        })
      : await prisma.cwlRoundMemberHistory.findMany({
          where: {
            season: input.owner.season,
            clanTag: input.owner.clanTag,
            roundDay: input.owner.roundDay,
          },
          orderBy: [{ mapPosition: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
        });

  return {
    season: input.owner.season,
    clanTag: input.owner.clanTag,
    clanName: input.owner.clanName,
    roundDay: input.owner.roundDay,
    roundState: input.owner.roundState,
    opponentTag: input.owner.opponentTag,
    opponentName: input.owner.opponentName,
    phaseEndsAt: resolvePhaseEndsAt(input.owner),
    members: members.map((member) => ({
      playerTag: member.playerTag,
      playerName: member.playerName,
      mapPosition: member.mapPosition,
      townHall: member.townHall,
      attacksUsed: member.attacksUsed,
      attacksAvailable: member.attacksAvailable,
      subbedIn: member.subbedIn,
      subbedOut: member.subbedOut,
    })),
  };
}

function mapPreparationSnapshotToActualLineup(
  owner: CwlPrepSnapshotOwner,
): CwlActualLineup {
  const members = normalizePrepSnapshotMembers(owner.lineupJson);
  return {
    season: owner.season,
    clanTag: owner.clanTag,
    clanName: owner.clanName,
    roundDay: owner.roundDay,
    roundState: owner.roundState,
    opponentTag: owner.opponentTag,
    opponentName: owner.opponentName,
    phaseEndsAt: resolvePhaseEndsAt(owner),
    members: members.map((member) => ({
      playerTag: member.playerTag,
      playerName: member.playerName,
      mapPosition: member.mapPosition,
      townHall: member.townHall,
      attacksUsed: 0,
      attacksAvailable: 0,
      subbedIn: member.subbedIn,
      subbedOut: member.subbedOut,
    })),
  };
}

function compareRoundMembers(a: { mapPosition: number | null; playerName: string; playerTag: string }, b: { mapPosition: number | null; playerName: string; playerTag: string }): number {
  const aPos = a.mapPosition ?? Number.MAX_SAFE_INTEGER;
  const bPos = b.mapPosition ?? Number.MAX_SAFE_INTEGER;
  if (aPos !== bPos) return aPos - bPos;
  const byName = a.playerName.localeCompare(b.playerName, undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) return byName;
  return a.playerTag.localeCompare(b.playerTag);
}

function sumAttackStars(member: ClanWarMember | null | undefined): number {
  const attacks = Array.isArray(member?.attacks) ? member.attacks : [];
  return attacks.reduce((sum, attack) => sum + Math.max(0, Math.trunc(Number(attack?.stars ?? 0))), 0);
}

function sumAttackDestruction(member: ClanWarMember | null | undefined): number {
  const attacks = Array.isArray(member?.attacks) ? member.attacks : [];
  return attacks.reduce(
    (sum, attack) => sum + Math.max(0, Number(attack?.destructionPercentage ?? 0)),
    0,
  );
}

function resolveTrackedLeagueRosterMember(
  trackedClanTag: string,
  group: ClanWarLeagueGroup | null,
): ClanWarLeagueClanMember[] {
  if (!group || !Array.isArray(group.clans)) return [];
  const normalizedTrackedClanTag = normalizeClanTag(trackedClanTag);
  const trackedClan = group.clans.find(
    (clan) => normalizeClanTag(String(clan?.tag ?? "")) === normalizedTrackedClanTag,
  );
  return Array.isArray(trackedClan?.members) ? trackedClan.members : [];
}

function buildLeagueRosterMap(
  trackedClanTag: string,
  group: ClanWarLeagueGroup | null,
): Map<string, { playerName: string; townHall: number | null }> {
  const map = new Map<string, { playerName: string; townHall: number | null }>();
  for (const member of resolveTrackedLeagueRosterMember(trackedClanTag, group)) {
    const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
    if (!playerTag) continue;
    map.set(playerTag, {
      playerName: sanitizeCwlName(member?.name, playerTag) ?? playerTag,
      townHall: Number.isFinite(Number(member?.townHallLevel))
        ? Math.trunc(Number(member?.townHallLevel))
        : null,
    });
  }
  return map;
}

function resolveTrackedWarSides(
  trackedClanTag: string,
  war: ClanWar | null,
): {
  ownSide: NonNullable<ClanWar["clan"]> | NonNullable<ClanWar["opponent"]>;
  opponentSide: NonNullable<ClanWar["clan"]> | NonNullable<ClanWar["opponent"]>;
} | null {
  if (!war) return null;
  const normalizedTrackedClanTag = normalizeClanTag(trackedClanTag);
  const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));
  if (warClanTag === normalizedTrackedClanTag && war.clan && war.opponent) {
    return { ownSide: war.clan, opponentSide: war.opponent };
  }
  if (warOpponentTag === normalizedTrackedClanTag && war.clan && war.opponent) {
    return { ownSide: war.opponent, opponentSide: war.clan };
  }
  return null;
}

function buildObservedRound(input: {
  trackedClanTag: string;
  season: string;
  leagueGroupState: string | null;
  roundDay: number;
  war: ClanWar;
  leagueRosterByTag: Map<string, { playerName: string; townHall: number | null }>;
  sourceUpdatedAt: Date;
}): ObservedCwlRound | null {
  const sides = resolveTrackedWarSides(input.trackedClanTag, input.war);
  if (!sides) return null;

  const roundState = normalizeRoundState(input.war.state);
  const attacksPerMember = Math.max(
    1,
    Math.trunc(Number(input.war.attacksPerMember ?? 1) || 1),
  );
  const attacksAvailable = roundState.toLowerCase().includes("preparation")
    ? 0
    : attacksPerMember;
  const members = (Array.isArray(sides.ownSide.members) ? sides.ownSide.members : [])
    .map((member): ObservedCwlRoundMember | null => {
      const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
      if (!playerTag) return null;
      const rosterMember = input.leagueRosterByTag.get(playerTag);
      const playerName =
        sanitizeCwlName(member?.name) ??
        rosterMember?.playerName ??
        playerTag;
      const townHall =
        Number.isFinite(Number(member?.townhallLevel))
          ? Math.trunc(Number(member?.townhallLevel))
          : rosterMember?.townHall ?? null;
      const attacksUsed = Array.isArray(member?.attacks) ? member.attacks.length : 0;
      return {
        playerTag,
        playerName,
        mapPosition: Number.isFinite(Number(member?.mapPosition))
          ? Math.trunc(Number(member?.mapPosition))
          : null,
        townHall,
        attacksUsed,
        attacksAvailable,
        stars: sumAttackStars(member),
        destruction: sumAttackDestruction(member),
        subbedIn: true,
        subbedOut: false,
      };
    })
    .filter((member): member is ObservedCwlRoundMember => member !== null)
    .sort(compareRoundMembers);

  return {
    season: input.season,
    clanTag: normalizeClanTag(input.trackedClanTag),
    clanName: sanitizeCwlName(sides.ownSide.name),
    roundDay: input.roundDay,
    roundState,
    leagueGroupState: input.leagueGroupState,
    opponentTag: normalizeClanTag(String(sides.opponentSide.tag ?? "")) || null,
    opponentName: sanitizeCwlName(sides.opponentSide.name),
    teamSize: Number.isFinite(Number(input.war.teamSize))
      ? Math.trunc(Number(input.war.teamSize))
      : null,
    attacksPerMember,
    preparationStartTime: parseCocTime(input.war.preparationStartTime ?? null),
    startTime: parseCocTime(input.war.startTime ?? null),
    endTime: parseCocTime(input.war.endTime ?? null),
    sourceUpdatedAt: input.sourceUpdatedAt,
    members,
  };
}

function buildObservedSeasonRoster(input: {
  leagueRosterByTag: Map<string, { playerName: string; townHall: number | null }>;
  currentRound: ObservedCwlRound | null;
  historyRounds: ObservedCwlRound[];
}): ObservedSeasonRosterMember[] {
  const byTag = new Map<string, ObservedSeasonRosterMember>();
  for (const [playerTag, rosterMember] of input.leagueRosterByTag.entries()) {
    byTag.set(playerTag, {
      playerTag,
      playerName: rosterMember.playerName,
      townHall: rosterMember.townHall,
      daysParticipated: 0,
      lastRoundDay: null,
    });
  }

  const registerRoundMembers = (round: ObservedCwlRound) => {
    for (const member of round.members) {
      const existing = byTag.get(member.playerTag);
      const nextDays = (existing?.daysParticipated ?? 0) + (member.subbedIn ? 1 : 0);
      byTag.set(member.playerTag, {
        playerTag: member.playerTag,
        playerName: member.playerName,
        townHall: member.townHall,
        daysParticipated: nextDays,
        lastRoundDay: round.roundDay,
      });
    }
  };

  for (const round of input.historyRounds) {
    registerRoundMembers(round);
  }
  if (input.currentRound) {
    registerRoundMembers(input.currentRound);
  }

  return [...byTag.values()].sort((a, b) => {
    const aLastRound = a.lastRoundDay ?? Number.MAX_SAFE_INTEGER;
    const bLastRound = b.lastRoundDay ?? Number.MAX_SAFE_INTEGER;
    if (aLastRound !== bLastRound) return aLastRound - bLastRound;
    const byName = a.playerName.localeCompare(b.playerName, undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
    return a.playerTag.localeCompare(b.playerTag);
  });
}

async function loadObservedTrackedClanState(input: {
  cocService: CoCService;
  trackedClanTag: string;
  defaultSeason: string;
  warByWarTag: Map<string, ClanWar | null>;
}): Promise<ObservedTrackedClanState> {
  const sourceUpdatedAt = new Date();
  let group: ClanWarLeagueGroup | null = null;
  try {
    group = await input.cocService.getClanWarLeagueGroup(input.trackedClanTag);
  } catch (err) {
    console.error(
      `[cwl-state] tracked_clan=${input.trackedClanTag} stage=league_group_fetch_failed error=${formatError(err)}`,
    );
    return {
      season: input.defaultSeason,
      clanTag: normalizeClanTag(input.trackedClanTag),
      fetched: false,
      currentRound: null,
      currentPreparationRound: null,
      historyRounds: [],
      seasonRoster: [],
    };
  }

  const season = normalizeSeasonKey(group?.season, input.defaultSeason);
  const leagueGroupState = sanitizeCwlName(group?.state) ?? null;
  const leagueRosterByTag = buildLeagueRosterMap(input.trackedClanTag, group);
  const observedRounds: ObservedCwlRound[] = [];
  const rounds = Array.isArray(group?.rounds) ? group.rounds : [];

  for (const [index, round] of rounds.entries()) {
    const warTags = [
      ...new Set(
        (Array.isArray(round?.warTags) ? round.warTags : [])
          .map((warTag) => String(warTag ?? "").trim())
          .filter((warTag) => warTag.length > 0 && warTag !== "#0"),
      ),
    ];
    if (warTags.length <= 0) continue;

    for (const warTag of warTags) {
      let war = input.warByWarTag.get(warTag) ?? null;
      if (war === undefined || !input.warByWarTag.has(warTag)) {
        war = await input.cocService.getClanWarLeagueWar(warTag).catch(() => null);
        input.warByWarTag.set(warTag, war);
      }
      const observedRound = buildObservedRound({
        trackedClanTag: input.trackedClanTag,
        season,
        leagueGroupState,
        roundDay: index + 1,
        war: war as ClanWar,
        leagueRosterByTag,
        sourceUpdatedAt,
      });
      if (observedRound) {
        observedRounds.push(observedRound);
        break;
      }
    }
  }

  const currentRound = [...observedRounds]
    .filter((round) => isCurrentRoundState(round.roundState))
    .sort((a, b) => {
      const aScore = scoreCurrentRoundState(a.roundState);
      const bScore = scoreCurrentRoundState(b.roundState);
      if (aScore !== bScore) return bScore - aScore;
      if (a.roundDay !== b.roundDay) return b.roundDay - a.roundDay;
      return b.sourceUpdatedAt.getTime() - a.sourceUpdatedAt.getTime();
    })[0] ?? null;
  const currentPreparationRound =
    currentRound && currentRound.roundState.toLowerCase().includes("inwar")
      ? [...observedRounds]
          .filter(
            (round) =>
              round.roundState.toLowerCase().includes("preparation") &&
              round.roundDay !== currentRound.roundDay,
          )
          .sort((a, b) => {
            if (a.roundDay !== b.roundDay) return b.roundDay - a.roundDay;
            return b.sourceUpdatedAt.getTime() - a.sourceUpdatedAt.getTime();
          })[0] ?? null
      : null;
  const historyRounds = observedRounds
    .filter((round) => isEndedRoundState(round.roundState))
    .sort((a, b) => a.roundDay - b.roundDay);

  return {
    season,
    clanTag: normalizeClanTag(input.trackedClanTag),
    fetched: true,
    currentRound,
    currentPreparationRound,
    historyRounds,
    seasonRoster: buildObservedSeasonRoster({
      leagueRosterByTag,
      currentRound,
      historyRounds,
    }),
  };
}

/** Purpose: persist tracked CWL current/prep rounds, ended history, and derived season-roster summaries from CoC. */
export class CwlStateService {
  /** Purpose: refresh tracked CWL state only for clans associated with one linked player set. */
  async refreshTrackedCwlStateForPlayerTags(input: {
    cocService: CoCService;
    playerTags: string[];
    season?: string;
    nowMs?: number;
  }): Promise<RefreshTrackedCwlStateResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey(input.nowMs);
    const normalizedTags = [...new Set(normalizePlayerTags(input.playerTags))];
    if (normalizedTags.length <= 0) {
      return {
        season,
        trackedClanCount: 0,
        refreshedClanCount: 0,
        currentRoundCount: 0,
        currentMemberCount: 0,
        historyRoundCount: 0,
        historyMemberCount: 0,
      };
    }

    const candidateClanRows = await prisma.cwlPlayerClanSeason.findMany({
      where: {
        season,
        playerTag: { in: normalizedTags },
      },
      select: { cwlClanTag: true },
    });
    const candidateClanTags = [
      ...new Set(
        candidateClanRows
          .map((row) => normalizeClanTag(row.cwlClanTag))
          .filter((tag): tag is string => Boolean(tag)),
      ),
    ];

    return this.refreshTrackedCwlStateForClanTags({
      cocService: input.cocService,
      season,
      trackedClanTags: candidateClanTags,
    });
  }

  async refreshTrackedCwlState(input: {
    cocService: CoCService;
    season?: string;
    nowMs?: number;
  }): Promise<RefreshTrackedCwlStateResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey(input.nowMs);
    const trackedClanRows = await prisma.cwlTrackedClan.findMany({
      where: { season },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { tag: true },
    });
    const trackedClanTags = [
      ...new Set(
        trackedClanRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean),
      ),
    ];
    return this.refreshTrackedCwlStateForClanTags({
      cocService: input.cocService,
      season,
      trackedClanTags,
    });
  }

  /** Purpose: refresh tracked CWL state for one bounded clan-tag set. */
  private async refreshTrackedCwlStateForClanTags(input: {
    cocService: CoCService;
    season: string;
    trackedClanTags: string[];
  }): Promise<RefreshTrackedCwlStateResult> {
    const trackedClanTags = [
      ...new Set(
        input.trackedClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean),
      ),
    ];
    if (trackedClanTags.length <= 0) {
      return {
        season: input.season,
        trackedClanCount: 0,
        refreshedClanCount: 0,
        currentRoundCount: 0,
        currentMemberCount: 0,
        historyRoundCount: 0,
        historyMemberCount: 0,
      };
    }

    const warByWarTag = new Map<string, ClanWar | null>();
    const observedStates: ObservedTrackedClanState[] = [];
    for (const trackedClanTag of trackedClanTags) {
      observedStates.push(
        await loadObservedTrackedClanState({
          cocService: input.cocService,
          trackedClanTag,
          defaultSeason: input.season,
          warByWarTag,
        }),
      );
    }

    let currentRoundCount = 0;
    let currentMemberCount = 0;
    let historyRoundCount = 0;
    let historyMemberCount = 0;

    await prisma.$transaction(async (tx) => {
      for (const observed of observedStates) {
        if (!observed.fetched) continue;

        if (observed.currentRound) {
          currentRoundCount += 1;
          currentMemberCount += observed.currentRound.members.length;
          await tx.currentCwlRound.upsert({
            where: {
              season_clanTag: {
                season: observed.season,
                clanTag: observed.clanTag,
              },
            },
            create: {
              season: observed.season,
              clanTag: observed.clanTag,
              roundDay: observed.currentRound.roundDay,
              clanName: observed.currentRound.clanName,
              opponentTag: observed.currentRound.opponentTag,
              opponentName: observed.currentRound.opponentName,
              roundState: observed.currentRound.roundState,
              leagueGroupState: observed.currentRound.leagueGroupState,
              teamSize: observed.currentRound.teamSize,
              attacksPerMember: observed.currentRound.attacksPerMember,
              preparationStartTime: observed.currentRound.preparationStartTime,
              startTime: observed.currentRound.startTime,
              endTime: observed.currentRound.endTime,
              sourceUpdatedAt: observed.currentRound.sourceUpdatedAt,
            },
            update: {
              roundDay: observed.currentRound.roundDay,
              clanName: observed.currentRound.clanName,
              opponentTag: observed.currentRound.opponentTag,
              opponentName: observed.currentRound.opponentName,
              roundState: observed.currentRound.roundState,
              leagueGroupState: observed.currentRound.leagueGroupState,
              teamSize: observed.currentRound.teamSize,
              attacksPerMember: observed.currentRound.attacksPerMember,
              preparationStartTime: observed.currentRound.preparationStartTime,
              startTime: observed.currentRound.startTime,
              endTime: observed.currentRound.endTime,
              sourceUpdatedAt: observed.currentRound.sourceUpdatedAt,
            },
          });
          await tx.cwlRoundMemberCurrent.deleteMany({
            where: {
              season: observed.season,
              clanTag: observed.clanTag,
            },
          });
          if (observed.currentRound.members.length > 0) {
            await tx.cwlRoundMemberCurrent.createMany({
              data: observed.currentRound.members.map((member) => ({
                season: observed.season,
                clanTag: observed.clanTag,
                playerTag: member.playerTag,
                roundDay: observed.currentRound!.roundDay,
                playerName: member.playerName,
                mapPosition: member.mapPosition,
                townHall: member.townHall,
                attacksUsed: member.attacksUsed,
                attacksAvailable: member.attacksAvailable,
                stars: member.stars,
                destruction: member.destruction,
                subbedIn: member.subbedIn,
                subbedOut: member.subbedOut,
                sourceRoundState: observed.currentRound!.roundState,
              })),
            });
          }
        } else {
          await tx.cwlRoundMemberCurrent.deleteMany({
            where: { season: observed.season, clanTag: observed.clanTag },
          });
          await tx.currentCwlRound.deleteMany({
            where: { season: observed.season, clanTag: observed.clanTag },
          });
        }

        if (observed.currentPreparationRound) {
          await tx.currentCwlPrepSnapshot.upsert({
            where: {
              season_clanTag: {
                season: observed.season,
                clanTag: observed.clanTag,
              },
            },
            create: {
              season: observed.season,
              clanTag: observed.clanTag,
              roundDay: observed.currentPreparationRound.roundDay,
              clanName: observed.currentPreparationRound.clanName,
              opponentTag: observed.currentPreparationRound.opponentTag,
              opponentName: observed.currentPreparationRound.opponentName,
              roundState: observed.currentPreparationRound.roundState,
              leagueGroupState: observed.currentPreparationRound.leagueGroupState,
              preparationStartTime: observed.currentPreparationRound.preparationStartTime,
              startTime: observed.currentPreparationRound.startTime,
              endTime: observed.currentPreparationRound.endTime,
              lineupJson: buildPrepSnapshotLineupJson(
                observed.currentPreparationRound.members,
              ),
              sourceUpdatedAt: observed.currentPreparationRound.sourceUpdatedAt,
            },
            update: {
              roundDay: observed.currentPreparationRound.roundDay,
              clanName: observed.currentPreparationRound.clanName,
              opponentTag: observed.currentPreparationRound.opponentTag,
              opponentName: observed.currentPreparationRound.opponentName,
              roundState: observed.currentPreparationRound.roundState,
              leagueGroupState: observed.currentPreparationRound.leagueGroupState,
              preparationStartTime: observed.currentPreparationRound.preparationStartTime,
              startTime: observed.currentPreparationRound.startTime,
              endTime: observed.currentPreparationRound.endTime,
              lineupJson: buildPrepSnapshotLineupJson(
                observed.currentPreparationRound.members,
              ),
              sourceUpdatedAt: observed.currentPreparationRound.sourceUpdatedAt,
            },
          });
        } else {
          await tx.currentCwlPrepSnapshot.deleteMany({
            where: { season: observed.season, clanTag: observed.clanTag },
          });
        }

        for (const round of observed.historyRounds) {
          historyRoundCount += 1;
          historyMemberCount += round.members.length;
          await tx.cwlRoundHistory.upsert({
            where: {
              season_clanTag_roundDay: {
                season: observed.season,
                clanTag: observed.clanTag,
                roundDay: round.roundDay,
              },
            },
            create: {
              season: observed.season,
              clanTag: observed.clanTag,
              roundDay: round.roundDay,
              clanName: round.clanName,
              opponentTag: round.opponentTag,
              opponentName: round.opponentName,
              roundState: round.roundState,
              leagueGroupState: round.leagueGroupState,
              teamSize: round.teamSize,
              attacksPerMember: round.attacksPerMember,
              preparationStartTime: round.preparationStartTime,
              startTime: round.startTime,
              endTime: round.endTime,
              sourceUpdatedAt: round.sourceUpdatedAt,
            },
            update: {
              clanName: round.clanName,
              opponentTag: round.opponentTag,
              opponentName: round.opponentName,
              roundState: round.roundState,
              leagueGroupState: round.leagueGroupState,
              teamSize: round.teamSize,
              attacksPerMember: round.attacksPerMember,
              preparationStartTime: round.preparationStartTime,
              startTime: round.startTime,
              endTime: round.endTime,
              sourceUpdatedAt: round.sourceUpdatedAt,
            },
          });
          await tx.cwlRoundMemberHistory.deleteMany({
            where: {
              season: observed.season,
              clanTag: observed.clanTag,
              roundDay: round.roundDay,
            },
          });
          if (round.members.length > 0) {
            await tx.cwlRoundMemberHistory.createMany({
              data: round.members.map((member) => ({
                season: observed.season,
                clanTag: observed.clanTag,
                roundDay: round.roundDay,
                playerTag: member.playerTag,
                playerName: member.playerName,
                mapPosition: member.mapPosition,
                townHall: member.townHall,
                attacksUsed: member.attacksUsed,
                attacksAvailable: member.attacksAvailable,
                stars: member.stars,
                destruction: member.destruction,
                subbedIn: member.subbedIn,
                subbedOut: member.subbedOut,
              })),
            });
          }
        }

        for (const rosterMember of observed.seasonRoster) {
          await tx.cwlPlayerClanSeason.upsert({
            where: {
              season_playerTag: {
                season: observed.season,
                playerTag: rosterMember.playerTag,
              },
            },
            create: {
              season: observed.season,
              playerTag: rosterMember.playerTag,
              cwlClanTag: observed.clanTag,
              playerName: rosterMember.playerName,
              townHall: rosterMember.townHall,
              daysParticipated: rosterMember.daysParticipated,
              lastRoundDay: rosterMember.lastRoundDay,
            },
            update: {
              cwlClanTag: observed.clanTag,
              playerName: rosterMember.playerName,
              townHall: rosterMember.townHall,
              daysParticipated: rosterMember.daysParticipated,
              lastRoundDay: rosterMember.lastRoundDay,
            },
          });
        }
      }
    });

    return {
      season: input.season,
      trackedClanCount: trackedClanTags.length,
      refreshedClanCount: observedStates.filter((state) => state.fetched).length,
      currentRoundCount,
      currentMemberCount,
      historyRoundCount,
      historyMemberCount,
    };
  }

  /** Purpose: load one persisted current/prep CWL round with sorted member rows for a tracked clan. */
  async getCurrentRoundForClan(input: {
    clanTag: string;
    season?: string;
  }): Promise<CwlCurrentRoundRecord | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const round = await prisma.currentCwlRound.findUnique({
      where: {
        season_clanTag: {
          season,
          clanTag,
        },
      },
    });
    if (!round) return null;

    const members = await prisma.cwlRoundMemberCurrent.findMany({
      where: { season, clanTag },
      orderBy: [{ mapPosition: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
    });

    return {
      season: round.season,
      clanTag: round.clanTag,
      clanName: round.clanName,
      roundDay: round.roundDay,
      roundState: round.roundState,
      opponentTag: round.opponentTag,
      opponentName: round.opponentName,
      teamSize: round.teamSize,
      attacksPerMember: round.attacksPerMember,
      preparationStartTime: round.preparationStartTime,
      startTime: round.startTime,
      endTime: round.endTime,
      sourceUpdatedAt: round.sourceUpdatedAt,
      members: members.map((member) => ({
        season: member.season,
        clanTag: member.clanTag,
        playerTag: member.playerTag,
        roundDay: member.roundDay,
        playerName: member.playerName,
        mapPosition: member.mapPosition,
        townHall: member.townHall,
        attacksUsed: member.attacksUsed,
        attacksAvailable: member.attacksAvailable,
        stars: member.stars,
        destruction: member.destruction,
        subbedIn: member.subbedIn,
        subbedOut: member.subbedOut,
      })),
    };
  }

  /** Purpose: load one persisted live prep snapshot for a tracked clan when overlap exists. */
  async getCurrentPreparationSnapshotForClan(input: {
    clanTag: string;
    season?: string;
  }): Promise<CwlPreparationSnapshotRecord | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const snapshot = await prisma.currentCwlPrepSnapshot.findUnique({
      where: {
        season_clanTag: {
          season,
          clanTag,
        },
      },
    });
    if (!snapshot) return null;

    return {
      season: snapshot.season,
      clanTag: snapshot.clanTag,
      clanName: snapshot.clanName,
      roundDay: snapshot.roundDay,
      roundState: snapshot.roundState,
      opponentTag: snapshot.opponentTag,
      opponentName: snapshot.opponentName,
      preparationStartTime: snapshot.preparationStartTime,
      startTime: snapshot.startTime,
      endTime: snapshot.endTime,
      sourceUpdatedAt: snapshot.sourceUpdatedAt,
      members: normalizePrepSnapshotMembers(snapshot.lineupJson),
    };
  }

  /** Purpose: load per-player CWL participation counts through one round day from persisted actual rounds. */
  async getParticipationCountsForClanDay(input: {
    clanTag: string;
    season?: string;
    throughRoundDay: number;
  }): Promise<Map<string, number>> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    const throughRoundDay = Math.max(1, Math.trunc(Number(input.throughRoundDay) || 0));
    if (!clanTag || throughRoundDay <= 0) {
      return new Map();
    }

    const [historyMembers, currentMembers] = await Promise.all([
      prisma.cwlRoundMemberHistory.findMany({
        where: {
          season,
          clanTag,
          roundDay: { lte: throughRoundDay },
          subbedIn: true,
        },
        select: {
          playerTag: true,
        },
      }),
      prisma.cwlRoundMemberCurrent.findMany({
        where: {
          season,
          clanTag,
          roundDay: { lte: throughRoundDay },
          subbedIn: true,
        },
        select: {
          playerTag: true,
        },
      }),
    ]);

    const countsByPlayerTag = new Map<string, number>();
    for (const row of [...historyMembers, ...currentMembers]) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      countsByPlayerTag.set(playerTag, (countsByPlayerTag.get(playerTag) ?? 0) + 1);
    }
    return countsByPlayerTag;
  }

  /** Purpose: load one persisted actual CWL lineup for a requested round day from current, history, or live prep snapshot owners. */
  async getActualLineupForDay(input: {
    clanTag: string;
    season?: string;
    roundDay: number;
  }): Promise<CwlActualLineup | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    const roundDay = Math.max(1, Math.trunc(Number(input.roundDay) || 0));
    if (!clanTag || roundDay <= 0) return null;

    const currentRound = await prisma.currentCwlRound.findUnique({
      where: { season_clanTag: { season, clanTag } },
    });
    if (currentRound && currentRound.roundDay === roundDay) {
      return loadPersistedCwlActualLineup({
        owner: currentRound,
        memberSource: "current",
      });
    }

    const historyRound = await prisma.cwlRoundHistory.findUnique({
      where: {
        season_clanTag_roundDay: { season, clanTag, roundDay },
      },
    });
    if (historyRound) {
      return loadPersistedCwlActualLineup({
        owner: historyRound,
        memberSource: "history",
      });
    }

    const preparationSnapshot = await prisma.currentCwlPrepSnapshot.findUnique({
      where: {
        season_clanTag: { season, clanTag },
      },
    });
    if (preparationSnapshot && preparationSnapshot.roundDay === roundDay) {
      return mapPreparationSnapshotToActualLineup(preparationSnapshot);
    }

    return null;
  }

  /** Purpose: build one DB-first current-season CWL roster view from persisted roster and round owners. */
  async listSeasonRosterForClan(input: {
    clanTag: string;
    season?: string;
  }): Promise<CwlSeasonRosterEntry[]> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return [];

    const rosterRows = await prisma.cwlPlayerClanSeason.findMany({
      where: { season, cwlClanTag: clanTag },
      orderBy: [{ lastRoundDay: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
    });
    const rosterTags = rosterRows.map((row) => row.playerTag);
    const [currentRound, currentMembers, playerLinks] = await Promise.all([
      prisma.currentCwlRound.findUnique({
        where: { season_clanTag: { season, clanTag } },
      }),
      prisma.cwlRoundMemberCurrent.findMany({
        where: { season, clanTag },
      }),
      prisma.playerLink.findMany({
        where: {
          playerTag: { in: rosterTags },
        },
        select: {
          playerTag: true,
          playerName: true,
          discordUserId: true,
          discordUsername: true,
        },
      }),
    ]);

    const currentMemberByTag = new Map(currentMembers.map((member) => [member.playerTag, member]));
    const playerLinkByTag = new Map(playerLinks.map((row) => [row.playerTag, row]));
    return rosterRows.map((row) => {
      const currentMember = currentMemberByTag.get(row.playerTag) ?? null;
      const playerLink = playerLinkByTag.get(row.playerTag) ?? null;
      return {
        season: row.season,
        clanTag: row.cwlClanTag,
        playerTag: row.playerTag,
        playerName:
          sanitizeCwlName(playerLink?.playerName) ??
          sanitizeCwlName(row.playerName) ??
          sanitizeCwlName(currentMember?.playerName) ??
          row.playerTag,
        townHall: currentMember?.townHall ?? row.townHall,
        linkedDiscordUserId: playerLink?.discordUserId ?? null,
        linkedDiscordUsername: playerLink?.discordUsername ?? null,
        daysParticipated: Math.max(0, Math.trunc(Number(row.daysParticipated ?? 0) || 0)),
        currentRound:
          currentRound && currentRound.roundDay > 0
            ? {
                roundDay: currentRound.roundDay,
                roundState: currentRound.roundState,
                inCurrentLineup: Boolean(currentMember?.subbedIn),
                attacksUsed: Math.max(0, Math.trunc(Number(currentMember?.attacksUsed ?? 0) || 0)),
                attacksAvailable: Math.max(
                  0,
                  Math.trunc(Number(currentMember?.attacksAvailable ?? 0) || 0),
                ),
                opponentTag: currentRound.opponentTag,
                opponentName: currentRound.opponentName,
                phaseEndsAt: resolvePhaseEndsAt(currentRound),
              }
            : null,
      };
    });
  }
}

export const cwlStateService = new CwlStateService();
