import {
  type ClanWar,
  type ClanWarLeagueClanMember,
  type ClanWarLeagueGroup,
  type ClanWarMember,
} from "../generated/coc-api";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import type { CwlLeagueFetchSource } from "./CwlFetchCycleCache";
import { cwlEventResolutionService } from "./CwlEventResolutionService";
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
  currentWeight?: number | null;
  role?: string | null;
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

type CwlPrepSnapshotLineupMember = {
  playerTag: string;
  playerName: string;
  mapPosition: number | null;
  townHall: number | null;
  subbedIn: boolean;
  subbedOut: boolean;
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

export type RefreshSeasonalCwlClanMappingsResult = {
  season: string;
  playerCount: number;
  existingMappingCount: number;
  persistedEvidenceCount: number;
  liveEvidenceCount: number;
  learnedClanCount: number;
  failedClanCount: number;
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

type ObservedSeasonRosterReconciliation = {
  rawObservedCount: number;
  distinctRosterCount: number;
};

type ObservedTrackedClanState = {
  season: string;
  clanTag: string;
  fetched: boolean;
  eventInstanceId: string | null;
  eventCreated: boolean;
  eventCurrentChanged: boolean;
  eventAnchorWarTag: string | null;
  eventObservedWarTagCount: number;
  currentRound: ObservedCwlRound | null;
  currentPreparationRound: ObservedCwlRound | null;
  historyRounds: ObservedCwlRound[];
  seasonRoster: ObservedSeasonRosterMember[];
  seasonRosterReconciliation: ObservedSeasonRosterReconciliation;
};

export function canonicalizeCwlSeasonRosterEntries<T extends { playerTag: string }>(entries: T[]): T[] {
  const byTag = new Map<string, T>();
  for (const entry of entries) {
    const normalizedPlayerTag = normalizePlayerTag(entry.playerTag);
    if (!normalizedPlayerTag || byTag.has(normalizedPlayerTag)) continue;
    byTag.set(normalizedPlayerTag, {
      ...entry,
      playerTag: normalizedPlayerTag,
    } as T);
  }
  return [...byTag.values()];
}

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

function normalizeLiveCwlRoundState(input: unknown): string {
  const value = String(input ?? "").trim();
  return value.length > 0 ? value : "notInWar";
}

function scoreLiveCwlRoundState(state: string): number {
  const normalized = state.toLowerCase();
  if (normalized.includes("inwar")) return 2;
  if (normalized.includes("preparation")) return 1;
  return 0;
}

function resolveLiveCwlSide(
  clanTag: string,
  war: ClanWar,
): { clanName: string | null; members: ClanWarMember[] } | null {
  const normalizedClanTag = normalizeClanTag(clanTag);
  const warClanTag = normalizeClanTag(String(war.clan?.tag ?? ""));
  const warOpponentTag = normalizeClanTag(String(war.opponent?.tag ?? ""));

  if (warClanTag === normalizedClanTag && war.clan) {
    return {
      clanName: sanitizeCwlName(war.clan.name) || null,
      members: Array.isArray(war.clan.members) ? war.clan.members : [],
    };
  }
  if (warOpponentTag === normalizedClanTag && war.opponent) {
    return {
      clanName: sanitizeCwlName(war.opponent.name) || null,
      members: Array.isArray(war.opponent.members) ? war.opponent.members : [],
    };
  }
  return null;
}

type CwlActualLineupOwner = {
  eventInstanceId: string;
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

type CwlDayOwnerResolution =
  | {
      owner: CwlActualLineupOwner;
      source: "current" | "history";
    }
  | {
      owner: CwlPrepSnapshotOwner;
      source: "prep";
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
  const record = toRecordValue(value);
  const membersValue = Array.isArray(value) ? value : Array.isArray(record?.members) ? record.members : [];
  return membersValue
    .map((entry) => {
      const entryRecord = toRecordValue(entry);
      if (!entryRecord) return null;
      const playerTag = normalizePlayerTag(String(entryRecord.playerTag ?? ""));
      if (!playerTag) return null;
      const playerName =
        sanitizeCwlName(entryRecord.playerName, playerTag) ??
        playerTag;
      const mapPosition = Number.isFinite(Number(entryRecord.mapPosition))
        ? Math.trunc(Number(entryRecord.mapPosition))
        : null;
      const townHall = Number.isFinite(Number(entryRecord.townHall))
        ? Math.trunc(Number(entryRecord.townHall))
        : null;
      return {
        playerTag,
        playerName,
        mapPosition,
        townHall,
        subbedIn: normalizeBooleanValue(entryRecord.subbedIn, true),
        subbedOut: normalizeBooleanValue(entryRecord.subbedOut, false),
      };
    })
    .filter((member): member is CwlPreparationSnapshotRecord["members"][number] => Boolean(member))
    .sort(compareRoundMembers);
}

function buildPrepSnapshotLineupJson(
  members: ReadonlyArray<CwlPrepSnapshotLineupMember>,
): CwlPrepSnapshotLineupMember[] {
  return members.map((member) => ({
    playerTag: member.playerTag,
    playerName: member.playerName,
    mapPosition: member.mapPosition,
    townHall: member.townHall,
    subbedIn: member.subbedIn,
    subbedOut: member.subbedOut,
  }));
}

function buildCwlPersistLogSuffix(input: {
  season: string;
  clanTag: string;
  currentRoundCount: number;
  currentMemberCount: number;
  historyRoundCount: number;
  historyMemberCount: number;
  phase: string;
  block?: string | null;
  status: string;
  durationMs?: number | null;
  lastBlock?: string | null;
  attempts?: number | null;
  error?: unknown;
}): string {
  const parts = [
    `season=${input.season}`,
    `clan_tag=${input.clanTag}`,
    `phase=${input.phase}`,
    `status=${input.status}`,
    `current_round_count=${input.currentRoundCount}`,
    `current_member_count=${input.currentMemberCount}`,
    `history_round_count=${input.historyRoundCount}`,
    `history_member_count=${input.historyMemberCount}`,
  ];
  if (input.block) parts.push(`block=${input.block}`);
  if (input.lastBlock) parts.push(`last_block=${input.lastBlock}`);
  if (typeof input.durationMs === "number") parts.push(`duration_ms=${input.durationMs}`);
  if (typeof input.attempts === "number") parts.push(`attempts=${input.attempts}`);
  if (input.error) parts.push(`error=${formatError(input.error)}`);
  return parts.join(" ");
}

function logCwlPersistPhase(input: {
  season: string;
  clanTag: string;
  currentRoundCount: number;
  currentMemberCount: number;
  historyRoundCount: number;
  historyMemberCount: number;
  phase: string;
  block?: string | null;
  status: string;
  durationMs?: number | null;
  lastBlock?: string | null;
  attempts?: number | null;
  error?: unknown;
}): void {
  const message = `[cwl-state] event=tracked_cwl_persist ${buildCwlPersistLogSuffix(input)}`;
  if (input.status === "failed") {
    console.error(message);
    return;
  }
  console.info(message);
}

const CWL_SEASON_ROSTER_RECONCILIATION_RETRY_LIMIT = 3;

function isRetryableCwlSeasonRosterReconciliationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "P2002" || code === "P2034";
}

type CwlSeasonRosterReconciliationTxOutcome =
  | {
      outcome: "allowed";
      previousPersistedCount: number;
      previousAuthoritativeRosterCount: number | null;
      staleRowsRemoved: number;
      candidateRosterCount: number;
    }
  | {
      outcome: "blocked";
      reason: string;
      previousPersistedCount: number;
      previousAuthoritativeRosterCount: number | null;
      staleRowsRemoved: number;
      candidateRosterCount: number;
    };

async function runCwlSeasonRosterReconciliationWithRetry(input: {
  eventInstanceId: string;
  season: string;
  clanTag: string;
  rawObservedCount: number;
  distinctRosterCount: number;
  seasonRosterRows: Array<{
    eventInstanceId: string;
    season: string;
    playerTag: string;
    cwlClanTag: string;
    playerName: string;
    townHall: number | null;
    daysParticipated: number;
    lastRoundDay: number | null;
  }>;
  currentRoundCount: number;
  currentMemberCount: number;
  historyRoundCount: number;
  historyMemberCount: number;
}): Promise<void> {
  const startedAt = Date.now();
  logCwlPersistPhase({
    season: input.season,
    clanTag: input.clanTag,
    currentRoundCount: input.currentRoundCount,
    currentMemberCount: input.currentMemberCount,
    historyRoundCount: input.historyRoundCount,
    historyMemberCount: input.historyMemberCount,
    phase: "season_roster",
    status: "start",
  });

  let attempts = 0;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= CWL_SEASON_ROSTER_RECONCILIATION_RETRY_LIMIT; attempt += 1) {
    attempts = attempt;
    try {
      const outcome = (await prisma.$transaction(
        async (tx): Promise<CwlSeasonRosterReconciliationTxOutcome> => {
          const candidateRowsByTag = new Map<string, (typeof input.seasonRosterRows)[number]>();
          for (const rosterMember of input.seasonRosterRows) {
            const normalizedPlayerTag = normalizePlayerTag(rosterMember.playerTag);
            if (!normalizedPlayerTag || candidateRowsByTag.has(normalizedPlayerTag)) continue;
            candidateRowsByTag.set(normalizedPlayerTag, {
              ...rosterMember,
              playerTag: normalizedPlayerTag,
            });
          }

          const candidateRows = [...candidateRowsByTag.values()];
          const candidateRosterTags = [...candidateRowsByTag.keys()];
          const candidateRosterCount = candidateRows.length;
          const previousPersistedCount = await tx.cwlPlayerClanSeason.count({
            where: {
              eventInstanceId: input.eventInstanceId,
              season: input.season,
              cwlClanTag: input.clanTag,
            },
          });
          const existingRosterState = await tx.cwlSeasonRosterState.findUnique({
            where: {
              eventInstanceId_clanTag: {
                eventInstanceId: input.eventInstanceId,
                clanTag: input.clanTag,
              },
            },
          });
          const rejectionReason =
            input.rawObservedCount <= 0
              ? "empty_members"
              : input.distinctRosterCount <= 0
                ? "no_valid_member_tags"
                : existingRosterState &&
                    candidateRosterCount < existingRosterState.authoritativeRosterCount
                  ? "suspicious_roster_shrink"
                  : null;
          if (rejectionReason) {
            return {
              outcome: "blocked" as const,
              reason: rejectionReason,
              previousPersistedCount,
              previousAuthoritativeRosterCount: existingRosterState?.authoritativeRosterCount ?? null,
              staleRowsRemoved: 0,
              candidateRosterCount,
            };
          }

          for (const rosterMember of candidateRows) {
            await tx.cwlPlayerClanSeason.upsert({
              where: {
                eventInstanceId_playerTag: {
                  eventInstanceId: input.eventInstanceId,
                  playerTag: rosterMember.playerTag,
                },
              },
              create: {
                eventInstanceId: input.eventInstanceId,
                season: input.season,
                playerTag: rosterMember.playerTag,
                cwlClanTag: input.clanTag,
                playerName: rosterMember.playerName,
                townHall: rosterMember.townHall,
                daysParticipated: rosterMember.daysParticipated,
                lastRoundDay: rosterMember.lastRoundDay,
              },
              update: {
                eventInstanceId: input.eventInstanceId,
                cwlClanTag: input.clanTag,
                playerName: rosterMember.playerName,
                townHall: rosterMember.townHall,
                daysParticipated: rosterMember.daysParticipated,
                lastRoundDay: rosterMember.lastRoundDay,
              },
            });
          }

          let staleRowsRemoved = 0;
          if (candidateRosterTags.length > 0) {
            const deleted = await tx.cwlPlayerClanSeason.deleteMany({
              where: {
                eventInstanceId: input.eventInstanceId,
                season: input.season,
                cwlClanTag: input.clanTag,
                playerTag: { notIn: candidateRosterTags },
              },
            });
            staleRowsRemoved = deleted.count;
          }

          const reconciledAt = new Date();
          await tx.cwlSeasonRosterState.upsert({
            where: {
              eventInstanceId_clanTag: {
                eventInstanceId: input.eventInstanceId,
                clanTag: input.clanTag,
              },
            },
            create: {
              eventInstanceId: input.eventInstanceId,
              season: input.season,
              clanTag: input.clanTag,
              authoritativeRosterCount: candidateRosterCount,
              reconciledAt,
            },
            update: {
              eventInstanceId: input.eventInstanceId,
              authoritativeRosterCount: candidateRosterCount,
              reconciledAt,
            },
          });

          return {
            outcome: "allowed" as const,
            previousPersistedCount,
            previousAuthoritativeRosterCount: existingRosterState?.authoritativeRosterCount ?? null,
            staleRowsRemoved,
            candidateRosterCount,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      )) as CwlSeasonRosterReconciliationTxOutcome;

      logCwlSeasonRosterReconciliation({
        season: input.season,
        clanTag: input.clanTag,
        rawObservedCount: input.rawObservedCount,
        distinctRosterCount: input.distinctRosterCount,
        previousPersistedCount: outcome.previousPersistedCount,
        previousAuthoritativeRosterCount: outcome.previousAuthoritativeRosterCount,
        staleRowsRemoved: outcome.staleRowsRemoved,
        allowed: outcome.outcome === "allowed",
        reason: outcome.outcome === "allowed" ? null : outcome.reason,
      });
      logCwlPersistPhase({
        season: input.season,
        clanTag: input.clanTag,
        currentRoundCount: input.currentRoundCount,
        currentMemberCount: input.currentMemberCount,
        historyRoundCount: input.historyRoundCount,
        historyMemberCount: input.historyMemberCount,
        phase: "season_roster",
        status: "complete",
        durationMs: Date.now() - startedAt,
        lastBlock:
          outcome.outcome === "allowed"
            ? `reconciled_${outcome.candidateRosterCount}`
            : outcome.reason,
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        !isRetryableCwlSeasonRosterReconciliationError(error) ||
        attempt >= CWL_SEASON_ROSTER_RECONCILIATION_RETRY_LIMIT
      ) {
        break;
      }
    }
  }

  logCwlPersistPhase({
    season: input.season,
    clanTag: input.clanTag,
    currentRoundCount: input.currentRoundCount,
    currentMemberCount: input.currentMemberCount,
    historyRoundCount: input.historyRoundCount,
    historyMemberCount: input.historyMemberCount,
    phase: "season_roster",
    status: "failed",
    durationMs: Date.now() - startedAt,
    attempts,
    error: lastError,
  });

  const attemptsText = attempts > 0 ? attempts.toString() : "0";
  const code =
    lastError && typeof lastError === "object"
      ? String((lastError as { code?: unknown }).code ?? "")
      : "";
  const message =
    lastError instanceof Error && String(lastError.message ?? "").trim()
      ? lastError.message
      : "unknown error";
  const error = new Error(
    `Failed to reconcile CWL season roster after ${attemptsText} attempt(s): ${message}`,
  );
  if (code) {
    (error as { code?: string }).code = code;
  }
  (error as { attempts?: number }).attempts = attempts;
  throw error;
}

async function runCwlPersistPhase(input: {
  season: string;
  clanTag: string;
  currentRoundCount: number;
  currentMemberCount: number;
  historyRoundCount: number;
  historyMemberCount: number;
  phase: string;
  work: (tx: Prisma.TransactionClient, trackBlock: (block: string) => void) => Promise<void>;
}): Promise<void> {
  const startedAt = Date.now();
  let lastBlock = "phase_start";
  logCwlPersistPhase({
    season: input.season,
    clanTag: input.clanTag,
    currentRoundCount: input.currentRoundCount,
    currentMemberCount: input.currentMemberCount,
    historyRoundCount: input.historyRoundCount,
    historyMemberCount: input.historyMemberCount,
    phase: input.phase,
    status: "start",
  });

  try {
    await prisma.$transaction(async (tx) => {
      logCwlPersistPhase({
        season: input.season,
        clanTag: input.clanTag,
        currentRoundCount: input.currentRoundCount,
        currentMemberCount: input.currentMemberCount,
        historyRoundCount: input.historyRoundCount,
        historyMemberCount: input.historyMemberCount,
        phase: input.phase,
        status: "transaction_started",
      });
      await input.work(tx, (block) => {
        lastBlock = block;
      });
    });
    logCwlPersistPhase({
      season: input.season,
      clanTag: input.clanTag,
      currentRoundCount: input.currentRoundCount,
      currentMemberCount: input.currentMemberCount,
      historyRoundCount: input.historyRoundCount,
      historyMemberCount: input.historyMemberCount,
      phase: input.phase,
      status: "complete",
      durationMs: Date.now() - startedAt,
      lastBlock,
    });
  } catch (error) {
    logCwlPersistPhase({
      season: input.season,
      clanTag: input.clanTag,
      currentRoundCount: input.currentRoundCount,
      currentMemberCount: input.currentMemberCount,
      historyRoundCount: input.historyRoundCount,
      historyMemberCount: input.historyMemberCount,
      phase: input.phase,
      status: "failed",
      durationMs: Date.now() - startedAt,
      lastBlock,
      error,
    });
    throw error;
  }
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
            eventInstanceId: input.owner.eventInstanceId,
            clanTag: input.owner.clanTag,
            roundDay: input.owner.roundDay,
          },
          orderBy: [{ mapPosition: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
        })
      : await prisma.cwlRoundMemberHistory.findMany({
          where: {
            eventInstanceId: input.owner.eventInstanceId,
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

async function loadPersistedCwlDayOwner(input: {
  clanTag: string;
  season: string;
  roundDay: number;
  eventInstanceId?: string | null;
}): Promise<CwlDayOwnerResolution | null> {
  const eventInstanceId =
    input.eventInstanceId ?? (await cwlEventResolutionService.resolveCurrentCwlEventForClan({
      clanTag: input.clanTag,
    }))?.id ?? null;
  if (!eventInstanceId) {
    return null;
  }

  const currentRound = await prisma.currentCwlRound.findUnique({
    where: { eventInstanceId_clanTag: { eventInstanceId, clanTag: input.clanTag } },
  });
  if (currentRound && currentRound.roundDay === input.roundDay) {
    return { owner: currentRound, source: "current" };
  }

  const historyRound = await prisma.cwlRoundHistory.findUnique({
    where: {
      eventInstanceId_clanTag_roundDay: {
        eventInstanceId,
        clanTag: input.clanTag,
        roundDay: input.roundDay,
      },
    },
  });
  if (historyRound) {
    return { owner: historyRound, source: "history" };
  }

  const preparationSnapshot = await prisma.currentCwlPrepSnapshot.findUnique({
    where: {
      eventInstanceId_clanTag: { eventInstanceId, clanTag: input.clanTag },
    },
  });
  if (preparationSnapshot && preparationSnapshot.roundDay === input.roundDay) {
    return { owner: preparationSnapshot, source: "prep" };
  }

  return null;
}

async function resolveCwlEventInstanceIdForClan(input: {
  clanTag: string;
  eventInstanceId?: string | null;
}): Promise<string | null> {
  const explicitEventInstanceId = String(input.eventInstanceId ?? "").trim();
  if (explicitEventInstanceId) {
    return explicitEventInstanceId;
  }
  const currentEvent = await cwlEventResolutionService.resolveCurrentCwlEventForClan({
    clanTag: input.clanTag,
  });
  return currentEvent?.id ?? null;
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

function resolveTrackedLeagueRosterClan(
  trackedClanTag: string,
  group: ClanWarLeagueGroup | null,
): NonNullable<ClanWarLeagueGroup["clans"]>[number] | null {
  if (!group || !Array.isArray(group.clans)) return null;
  const normalizedTrackedClanTag = normalizeClanTag(trackedClanTag);
  return (
    group.clans.find(
    (clan) => normalizeClanTag(String(clan?.tag ?? "")) === normalizedTrackedClanTag,
    ) ?? null
  );
}

function buildLeagueRosterMap(
  trackedClanMembers: ClanWarLeagueClanMember[],
): Map<string, { playerName: string; townHall: number | null }> {
  const map = new Map<string, { playerName: string; townHall: number | null }>();
  for (const member of trackedClanMembers) {
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
      if (!existing) continue;
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

function logCwlSeasonRosterReconciliation(input: {
  season: string;
  clanTag: string;
  rawObservedCount: number;
  distinctRosterCount: number;
  previousPersistedCount: number;
  previousAuthoritativeRosterCount: number | null;
  staleRowsRemoved: number;
  allowed: boolean;
  reason: string | null;
}): void {
  const parts = [
    `[cwl-state] event=tracked_cwl_season_roster_reconcile`,
    `season=${input.season}`,
    `clan_tag=${input.clanTag}`,
    `raw_observed_count=${input.rawObservedCount}`,
    `distinct_roster_count=${input.distinctRosterCount}`,
    `previous_persisted_count=${input.previousPersistedCount}`,
    `previous_authoritative_count=${input.previousAuthoritativeRosterCount ?? "none"}`,
    `stale_rows_removed=${input.staleRowsRemoved}`,
    `allowed=${input.allowed ? "yes" : "no"}`,
  ];
  if (input.reason) {
    parts.push(`reason=${input.reason}`);
  }
  console.info(parts.join(" "));
}

async function loadObservedTrackedClanState(input: {
  cwlFetchSource: CwlLeagueFetchSource;
  trackedClanTag: string;
  defaultSeason: string;
  warByWarTag: Map<string, ClanWar | null>;
}): Promise<ObservedTrackedClanState> {
  const sourceUpdatedAt = new Date();
  const normalizedTrackedClanTag = normalizeClanTag(input.trackedClanTag);
  let group: ClanWarLeagueGroup | null = null;
  try {
    group = await input.cwlFetchSource.getClanWarLeagueGroup(input.trackedClanTag);
  } catch (err) {
    console.error(
      `[cwl-state] tracked_clan=${input.trackedClanTag} stage=league_group_fetch_failed error=${formatError(err)}`,
    );
    return {
      season: input.defaultSeason,
      clanTag: normalizedTrackedClanTag,
      fetched: false,
      eventInstanceId: null,
      eventCreated: false,
      eventCurrentChanged: false,
      eventAnchorWarTag: null,
      eventObservedWarTagCount: 0,
      currentRound: null,
      currentPreparationRound: null,
      historyRounds: [],
      seasonRoster: [],
      seasonRosterReconciliation: {
        rawObservedCount: 0,
        distinctRosterCount: 0,
      },
    };
  }

  const season = normalizeSeasonKey(group?.season, input.defaultSeason);
  const leagueGroupState = sanitizeCwlName(group?.state) ?? null;
  const trackedLeagueClan = resolveTrackedLeagueRosterClan(input.trackedClanTag, group);
  const trackedLeagueClanMembers = Array.isArray(trackedLeagueClan?.members) ? trackedLeagueClan.members : [];
  const leagueRosterByTag = buildLeagueRosterMap(trackedLeagueClanMembers);
  const rawObservedCount = trackedLeagueClanMembers.length;
  const distinctRosterCount = leagueRosterByTag.size;
  const observedRounds: ObservedCwlRound[] = [];
  const observedWarTags = new Set<string>();
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
      observedWarTags.add(warTag);
    }

    for (const warTag of warTags) {
      let war = input.warByWarTag.get(warTag) ?? null;
      if (war === undefined || !input.warByWarTag.has(warTag)) {
        war = await input.cwlFetchSource.getClanWarLeagueWar(warTag).catch(() => null);
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

  const resolution = await cwlEventResolutionService.resolveCwlEventForClan({
    season,
    clanTag: normalizedTrackedClanTag,
    observedWarTags: [...observedWarTags],
    observedAt: sourceUpdatedAt,
  });
  if (resolution.kind !== "resolved") {
    return {
      season,
      clanTag: normalizedTrackedClanTag,
      fetched: false,
      eventInstanceId: null,
      eventCreated: false,
      eventCurrentChanged: false,
      eventAnchorWarTag: null,
      eventObservedWarTagCount: resolution.observedWarTagCount,
      currentRound: null,
      currentPreparationRound: null,
      historyRounds: [],
      seasonRoster: [],
      seasonRosterReconciliation: {
        rawObservedCount: 0,
        distinctRosterCount: 0,
      },
    };
  }

  return {
    season,
    clanTag: normalizedTrackedClanTag,
    fetched: true,
    eventInstanceId: resolution.eventInstanceId,
    eventCreated: resolution.created,
    eventCurrentChanged: resolution.previousCurrentEventInstanceId !== resolution.eventInstanceId,
    eventAnchorWarTag: resolution.anchorWarTag,
    eventObservedWarTagCount: resolution.observedWarTagCount,
    currentRound,
    currentPreparationRound,
    historyRounds,
    seasonRoster: buildObservedSeasonRoster({
      leagueRosterByTag,
      currentRound,
      historyRounds,
    }),
    seasonRosterReconciliation: {
      rawObservedCount,
      distinctRosterCount,
    },
  };
}

/** Purpose: persist tracked CWL current/prep rounds, ended history, and derived season-roster summaries from CoC. */
export class CwlStateService {
  /** Purpose: refresh persisted seasonal CWL clan mappings for bounded player tags. */
  async refreshSeasonalCwlClanMappingsForPlayerTags(input: {
    cocService?: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    playerTags: string[];
    season?: string;
    candidateClanTags?: string[];
  }): Promise<RefreshSeasonalCwlClanMappingsResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const normalizedTags = [...new Set(normalizePlayerTags(input.playerTags))];
    if (normalizedTags.length <= 0) {
      return {
        season,
        playerCount: 0,
        existingMappingCount: 0,
        persistedEvidenceCount: 0,
        liveEvidenceCount: 0,
        learnedClanCount: 0,
        failedClanCount: 0,
      };
    }

    const trackedClanRows = await prisma.cwlTrackedClan.findMany({
      where: { season },
      select: { tag: true },
    });
    const trackedClanTagSet = new Set(
      trackedClanRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean),
    );
    const candidateClanTags = [
      ...new Set(
        (input.candidateClanTags ?? [])
          .map((tag) => normalizeClanTag(tag))
          .filter(
            (tag): tag is string => Boolean(tag && !trackedClanTagSet.has(tag)),
          ),
      ),
    ];
    const cwlFetchSource = input.cwlFetchCycleCache ?? input.cocService ?? null;
    const currentEventRows =
      trackedClanTagSet.size > 0
        ? await prisma.cwlEventClan.findMany({
            where: {
              clanTag: {
                in: [...trackedClanTagSet],
              },
              isCurrent: true,
            },
            select: {
              clanTag: true,
              eventInstanceId: true,
            },
          })
        : [];
    const currentEventIds = [
      ...new Set(
        currentEventRows
          .map((row) => String(row.eventInstanceId ?? "").trim())
          .filter(Boolean),
      ),
    ];

    const candidateLiveEvents: Array<{
      clanTag: string;
      eventInstanceId: string;
      warTags: string[];
    }> = [];
    if (cwlFetchSource && candidateClanTags.length > 0) {
      const observedAt = new Date();
      for (const clanTag of candidateClanTags) {
        let group: ClanWarLeagueGroup | null = null;
        try {
          group = await cwlFetchSource.getClanWarLeagueGroup(clanTag);
        } catch (error) {
          console.warn(
            `[cwl-mapping] season=${season} clan_tag=${clanTag} stage=group_fetch_failed error=${formatError(error)}`,
          );
          continue;
        }

        const warTags = [
          ...new Set(
            (Array.isArray(group?.rounds) ? group.rounds : [])
              .flatMap((round) => (Array.isArray(round?.warTags) ? round.warTags : []))
              .map((warTag) => String(warTag ?? "").trim())
              .filter((warTag) => warTag.length > 0 && warTag !== "#0"),
          ),
        ];
        if (warTags.length <= 0) {
          continue;
        }

        const resolution = await cwlEventResolutionService.resolveCwlEventForClan({
          season,
          clanTag,
          observedWarTags: warTags,
          observedAt,
        });
        if (resolution.kind !== "resolved") {
          console.info(
            `[cwl-mapping] season=${season} clan_tag=${clanTag} existing_mapping=no live_discovery_ran=yes learned_clan=no source=event_resolution_${resolution.kind}`,
          );
          continue;
        }

        candidateLiveEvents.push({
          clanTag: normalizeClanTag(clanTag),
          eventInstanceId: resolution.eventInstanceId,
          warTags,
        });
      }
    }

    const resolvedEventIds = [
      ...new Set([
        ...currentEventIds,
        ...candidateLiveEvents.map((row) => row.eventInstanceId),
      ]),
    ];

    const existingMappings = resolvedEventIds.length > 0
      ? await prisma.cwlPlayerClanSeason.findMany({
          where: {
            eventInstanceId: { in: resolvedEventIds },
            playerTag: { in: normalizedTags },
          },
          select: {
            eventInstanceId: true,
            playerTag: true,
            cwlClanTag: true,
          },
        })
      : [];
    const existingMappingsByPlayerTag = new Map<string, Set<string>>();
    const existingMappingsByEventId = new Map<string, Set<string>>();
    for (const row of existingMappings) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const eventInstanceId = String(row.eventInstanceId ?? "").trim();
      if (!playerTag || !eventInstanceId) continue;
      const playerEventIds = existingMappingsByPlayerTag.get(playerTag) ?? new Set<string>();
      playerEventIds.add(eventInstanceId);
      existingMappingsByPlayerTag.set(playerTag, playerEventIds);
      const eventPlayerTags = existingMappingsByEventId.get(eventInstanceId) ?? new Set<string>();
      eventPlayerTags.add(playerTag);
      existingMappingsByEventId.set(eventInstanceId, eventPlayerTags);
    }

    const directEvidenceRows = await Promise.all([
      resolvedEventIds.length > 0
        ? prisma.cwlRoundMemberCurrent.findMany({
            where: {
              eventInstanceId: { in: resolvedEventIds },
              playerTag: { in: normalizedTags },
            },
            select: {
              eventInstanceId: true,
              playerTag: true,
              clanTag: true,
              playerName: true,
              townHall: true,
              roundDay: true,
            },
          })
        : Promise.resolve([]),
      resolvedEventIds.length > 0
        ? prisma.cwlRoundMemberHistory.findMany({
            where: {
              eventInstanceId: { in: resolvedEventIds },
              playerTag: { in: normalizedTags },
            },
            select: {
              eventInstanceId: true,
              playerTag: true,
              clanTag: true,
              playerName: true,
              townHall: true,
              roundDay: true,
            },
            orderBy: [{ roundDay: "desc" }, { updatedAt: "desc" }, { playerTag: "asc" }],
          })
        : Promise.resolve([]),
    ]);

    type EventScopedCwlEvidence = {
      eventInstanceId: string;
      clanTag: string;
      playerName: string | null;
      townHall: number | null;
      roundDay: number | null;
      source: "current" | "history";
      sourceRank: number;
    };
    const evidenceByPlayerTag = new Map<string, EventScopedCwlEvidence>();
    const evidenceByEventIdAndPlayerTag = new Map<string, Map<string, EventScopedCwlEvidence>>();
    for (const row of directEvidenceRows[0]) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const clanTag = normalizeClanTag(row.clanTag);
      const eventInstanceId = String(row.eventInstanceId ?? "").trim();
      if (!playerTag || !clanTag || !eventInstanceId) continue;
      const next = {
        eventInstanceId,
        clanTag,
        playerName: sanitizeCwlName(row.playerName) ?? playerTag,
        townHall: Number.isFinite(Number(row.townHall))
          ? Math.trunc(Number(row.townHall))
          : null,
        roundDay: Number.isFinite(Number(row.roundDay))
          ? Math.trunc(Number(row.roundDay))
          : null,
        source: "current" as const,
        sourceRank: 2,
      };
      const eventRows = evidenceByEventIdAndPlayerTag.get(eventInstanceId) ?? new Map();
      const existingForEvent = eventRows.get(playerTag);
      if (
        !existingForEvent ||
        next.sourceRank > existingForEvent.sourceRank ||
        (next.sourceRank === existingForEvent.sourceRank &&
          (next.roundDay ?? 0) >= (existingForEvent.roundDay ?? 0))
      ) {
        eventRows.set(playerTag, next);
      }
      evidenceByEventIdAndPlayerTag.set(eventInstanceId, eventRows);
      const existing = evidenceByPlayerTag.get(playerTag);
      if (
        !existing ||
        next.sourceRank > existing.sourceRank ||
        (next.sourceRank === existing.sourceRank &&
          (next.roundDay ?? 0) >= (existing.roundDay ?? 0))
      ) {
        evidenceByPlayerTag.set(playerTag, next);
      }
    }
    for (const row of directEvidenceRows[1]) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const clanTag = normalizeClanTag(row.clanTag);
      const eventInstanceId = String(row.eventInstanceId ?? "").trim();
      if (!playerTag || !clanTag || !eventInstanceId) continue;
      const next = {
        eventInstanceId,
        clanTag,
        playerName: sanitizeCwlName(row.playerName) ?? playerTag,
        townHall: Number.isFinite(Number(row.townHall))
          ? Math.trunc(Number(row.townHall))
          : null,
        roundDay: Number.isFinite(Number(row.roundDay))
          ? Math.trunc(Number(row.roundDay))
          : null,
        source: "history" as const,
        sourceRank: 1,
      };
      const eventRows = evidenceByEventIdAndPlayerTag.get(eventInstanceId) ?? new Map();
      const existingForEvent = eventRows.get(playerTag);
      if (
        !existingForEvent ||
        next.sourceRank > existingForEvent.sourceRank ||
        (next.sourceRank === existingForEvent.sourceRank &&
          (next.roundDay ?? 0) >= (existingForEvent.roundDay ?? 0))
      ) {
        eventRows.set(playerTag, next);
      }
      evidenceByEventIdAndPlayerTag.set(eventInstanceId, eventRows);
      const existing = evidenceByPlayerTag.get(playerTag);
      if (
        !existing ||
        next.sourceRank > existing.sourceRank ||
        (next.sourceRank === existing.sourceRank &&
          (next.roundDay ?? 0) >= (existing.roundDay ?? 0))
      ) {
        evidenceByPlayerTag.set(playerTag, next);
      }
    }

    const liveEvidenceByPlayerTag = new Map<
      string,
      {
        eventInstanceId: string;
        clanTag: string;
        playerName: string | null;
        townHall: number | null;
        roundDay: number | null;
        sourceRank: number;
      }
    >();
    const liveDiscoveryRan = Boolean(cwlFetchSource && candidateLiveEvents.length > 0);
    if (liveDiscoveryRan && cwlFetchSource) {
      for (const candidate of candidateLiveEvents) {
        const targetPlayerTagSet = new Set(
          normalizedTags.filter((playerTag) => {
            const candidateMapping = existingMappingsByEventId.get(candidate.eventInstanceId) ?? new Set<string>();
            const candidateEvidence = evidenceByEventIdAndPlayerTag.get(candidate.eventInstanceId) ?? new Map();
            return !candidateMapping.has(playerTag) && !candidateEvidence.has(playerTag);
          }),
        );
        if (targetPlayerTagSet.size <= 0) {
          continue;
        }

        for (const warTag of candidate.warTags) {
          const war = await cwlFetchSource.getClanWarLeagueWar(warTag).catch(() => null);
          if (!war) continue;
          const side = resolveLiveCwlSide(candidate.clanTag, war);
          if (!side) continue;
          const roundState = normalizeLiveCwlRoundState(war.state);
          const roundScore = scoreLiveCwlRoundState(roundState);
          if (roundScore <= 0) continue;

          for (const member of side.members) {
            const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
            if (!playerTag || !targetPlayerTagSet.has(playerTag)) continue;
            const existing = liveEvidenceByPlayerTag.get(playerTag);
            if (!existing || roundScore > existing.sourceRank) {
              liveEvidenceByPlayerTag.set(playerTag, {
                eventInstanceId: candidate.eventInstanceId,
                clanTag: candidate.clanTag,
                playerName: sanitizeCwlName(member?.name) ?? playerTag,
                townHall: Number.isFinite(Number(member?.townhallLevel))
                  ? Math.trunc(Number(member?.townhallLevel))
                  : null,
                roundDay: null,
                sourceRank: roundScore,
              });
            }
          }

          const remaining = [...targetPlayerTagSet].filter((playerTag) => {
            const candidateMapping = existingMappingsByEventId.get(candidate.eventInstanceId) ?? new Set<string>();
            const candidateEvidence = evidenceByEventIdAndPlayerTag.get(candidate.eventInstanceId) ?? new Map();
            return (
              !candidateMapping.has(playerTag) &&
              !candidateEvidence.has(playerTag) &&
              !liveEvidenceByPlayerTag.has(playerTag)
            );
          });
          if (remaining.length <= 0) break;
        }
      }
    }

    let learnedClanCount = 0;
    let persistedEvidenceCount = 0;
    let liveEvidenceCount = 0;
    await prisma.$transaction(async (tx) => {
      for (const playerTag of normalizedTags) {
        const liveEvidence = liveEvidenceByPlayerTag.get(playerTag) ?? null;
        const persistedEvidence = evidenceByPlayerTag.get(playerTag) ?? null;
        const evidence = liveEvidence ?? persistedEvidence ?? null;
        const candidateEventInstanceId = evidence?.eventInstanceId ?? "";
        const hadExistingMapping =
          candidateEventInstanceId.length > 0 &&
          (existingMappingsByPlayerTag.get(playerTag)?.has(candidateEventInstanceId) ?? false);
        if (hadExistingMapping) {
          console.info(
            `[cwl-mapping] season=${season} player_tag=${playerTag} existing_mapping=yes live_discovery_ran=${liveDiscoveryRan ? "yes" : "no"} learned_clan=no source=existing_mapping`,
          );
          continue;
        }

        const persistedClanTag = persistedEvidence?.clanTag ?? "";
        const liveClanTag = liveEvidence?.clanTag ?? "";
        const clanTag = normalizeClanTag(persistedClanTag || liveClanTag);
        if (!clanTag || !candidateEventInstanceId) {
          console.info(
            `[cwl-mapping] season=${season} player_tag=${playerTag} existing_mapping=no live_discovery_ran=${liveDiscoveryRan ? "yes" : "no"} learned_clan=no source=${persistedClanTag ? "persisted" : liveClanTag ? "live" : "none"}`,
          );
          continue;
        }

        if (persistedClanTag) {
          persistedEvidenceCount += 1;
        } else if (liveClanTag) {
          liveEvidenceCount += 1;
        }

        await tx.cwlPlayerClanSeason.upsert({
          where: {
            eventInstanceId_playerTag: {
              eventInstanceId: candidateEventInstanceId,
              playerTag,
            },
          },
          create: {
            eventInstanceId: candidateEventInstanceId,
            season,
            playerTag,
            cwlClanTag: clanTag,
            playerName: evidence?.playerName ?? playerTag,
            townHall: evidence?.townHall ?? null,
            daysParticipated: 0,
            lastRoundDay: null,
          },
          update: {
            eventInstanceId: candidateEventInstanceId,
            cwlClanTag: clanTag,
            playerName: evidence?.playerName ?? playerTag,
            townHall: evidence?.townHall ?? null,
          },
        });
        learnedClanCount += 1;
        console.info(
          `[cwl-mapping] season=${season} player_tag=${playerTag} existing_mapping=no live_discovery_ran=${liveDiscoveryRan ? "yes" : "no"} learned_clan=yes clan_tag=${clanTag} source=${persistedClanTag ? "persisted" : "live"}`,
        );
      }
    });

    console.info(
      `[cwl-mapping] season=${season} requested_player_count=${normalizedTags.length} existing_mapping_count=${existingMappingsByPlayerTag.size} persisted_evidence_count=${persistedEvidenceCount} live_evidence_count=${liveEvidenceCount} learned_clan_count=${learnedClanCount} candidate_clan_count=${candidateClanTags.length}`,
    );

    return {
      season,
      playerCount: normalizedTags.length,
      existingMappingCount: existingMappingsByPlayerTag.size,
      persistedEvidenceCount,
      liveEvidenceCount,
      learnedClanCount,
      failedClanCount: 0,
    };
  }

  /** Purpose: refresh tracked CWL state only for clans associated with one linked player set. */
  async refreshTrackedCwlStateForPlayerTags(input: {
    cocService: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
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

    const trackedClanRows = await prisma.cwlTrackedClan.findMany({
      where: { season },
      select: { tag: true },
    });
    const trackedClanTags = [
      ...new Set(
        trackedClanRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean),
      ),
    ];
    const currentEventRows = trackedClanTags.length > 0
      ? await prisma.cwlEventClan.findMany({
          where: {
            clanTag: { in: trackedClanTags },
            isCurrent: true,
          },
          select: {
            clanTag: true,
            eventInstanceId: true,
          },
        })
      : [];
    const currentEventIds = [
      ...new Set(
        currentEventRows
          .map((row) => String(row.eventInstanceId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const candidateClanRows = currentEventIds.length > 0
      ? await prisma.cwlPlayerClanSeason.findMany({
          where: {
            eventInstanceId: { in: currentEventIds },
            playerTag: { in: normalizedTags },
          },
          select: {
            eventInstanceId: true,
            cwlClanTag: true,
          },
        })
      : [];
    const candidateClanTags = [
      ...new Set(
        candidateClanRows
          .map((row) => normalizeClanTag(row.cwlClanTag))
          .filter((tag): tag is string => Boolean(tag)),
      ),
    ];

    return this.refreshTrackedCwlStateForClanTags({
      cocService: input.cocService,
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      season,
      trackedClanTags: candidateClanTags,
    });
  }

  async refreshTrackedCwlState(input: {
    cocService: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
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
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      season,
      trackedClanTags,
    });
  }

  /** Purpose: refresh tracked CWL state for one clan only. */
  async refreshTrackedCwlStateForClan(input: {
    cocService: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
    clanTag: string;
    season?: string;
    nowMs?: number;
  }): Promise<RefreshTrackedCwlStateResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey(input.nowMs);
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) {
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

    return this.refreshTrackedCwlStateForClanTags({
      cocService: input.cocService,
      cwlFetchCycleCache: input.cwlFetchCycleCache ?? null,
      season,
      trackedClanTags: [clanTag],
    });
  }

  /** Purpose: refresh tracked CWL state for one bounded clan-tag set. */
  private async refreshTrackedCwlStateForClanTags(input: {
    cocService: CoCService;
    cwlFetchCycleCache?: CwlLeagueFetchSource | null;
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

    const cwlFetchSource = input.cwlFetchCycleCache ?? input.cocService;
    const warByWarTag = new Map<string, ClanWar | null>();
    const observedStates: ObservedTrackedClanState[] = [];
    for (const trackedClanTag of trackedClanTags) {
      observedStates.push(
        await loadObservedTrackedClanState({
          cwlFetchSource,
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

    for (const observed of observedStates) {
      if (!observed.fetched) continue;
      const eventInstanceId = observed.eventInstanceId ?? "";

      const currentRoundPlan = observed.currentRound
        ? {
            eventInstanceId,
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
            memberRows: observed.currentRound.members.map((member) => ({
              season: observed.season,
              eventInstanceId,
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
          }
        : null;
      const currentRoundCountForClan = currentRoundPlan ? 1 : 0;
      const currentMemberCountForClan = currentRoundPlan?.memberRows.length ?? 0;

      const currentPrepSnapshotPlan = observed.currentPreparationRound
        ? {
            eventInstanceId,
            roundDay: observed.currentPreparationRound.roundDay,
            clanName: observed.currentPreparationRound.clanName,
            opponentTag: observed.currentPreparationRound.opponentTag,
            opponentName: observed.currentPreparationRound.opponentName,
            roundState: observed.currentPreparationRound.roundState,
            leagueGroupState: observed.currentPreparationRound.leagueGroupState,
            preparationStartTime: observed.currentPreparationRound.preparationStartTime,
            startTime: observed.currentPreparationRound.startTime,
            endTime: observed.currentPreparationRound.endTime,
            lineupJson: buildPrepSnapshotLineupJson(observed.currentPreparationRound.members),
            sourceUpdatedAt: observed.currentPreparationRound.sourceUpdatedAt,
          }
        : null;

      const historyRoundPlans = observed.historyRounds.map((round) => ({
        eventInstanceId,
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
        memberRows: round.members.map((member) => ({
          season: observed.season,
          eventInstanceId,
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
      }));
      const historyRoundCountForClan = historyRoundPlans.length;
      const historyMemberCountForClan = historyRoundPlans.reduce(
        (sum, round) => sum + round.memberRows.length,
        0,
      );

      const seasonRosterRows = observed.seasonRoster.map((rosterMember) => ({
        eventInstanceId,
        season: observed.season,
        playerTag: rosterMember.playerTag,
        cwlClanTag: observed.clanTag,
        playerName: rosterMember.playerName,
        townHall: rosterMember.townHall,
        daysParticipated: rosterMember.daysParticipated,
        lastRoundDay: rosterMember.lastRoundDay,
      }));

      currentRoundCount += currentRoundCountForClan;
      currentMemberCount += currentMemberCountForClan;
      historyRoundCount += historyRoundCountForClan;
      historyMemberCount += historyMemberCountForClan;

      await runCwlPersistPhase({
        season: observed.season,
        clanTag: observed.clanTag,
        currentRoundCount: currentRoundCountForClan,
        currentMemberCount: currentMemberCountForClan,
        historyRoundCount: historyRoundCountForClan,
        historyMemberCount: historyMemberCountForClan,
        phase: "current_round",
        work: async (tx, trackBlock) => {
          trackBlock("current_round");
          logCwlPersistPhase({
            season: observed.season,
            clanTag: observed.clanTag,
            currentRoundCount: currentRoundCountForClan,
            currentMemberCount: currentMemberCountForClan,
            historyRoundCount: historyRoundCountForClan,
            historyMemberCount: historyMemberCountForClan,
            phase: "current_round",
            block: "current_round",
            status: "block_start",
          });
          if (currentRoundPlan) {
            await tx.currentCwlRound.upsert({
              where: {
                eventInstanceId_clanTag: {
                  eventInstanceId,
                  clanTag: observed.clanTag,
                },
              },
              create: {
                eventInstanceId,
                season: observed.season,
                clanTag: observed.clanTag,
                roundDay: currentRoundPlan.roundDay,
                clanName: currentRoundPlan.clanName,
                opponentTag: currentRoundPlan.opponentTag,
                opponentName: currentRoundPlan.opponentName,
                roundState: currentRoundPlan.roundState,
                leagueGroupState: currentRoundPlan.leagueGroupState,
                teamSize: currentRoundPlan.teamSize,
                attacksPerMember: currentRoundPlan.attacksPerMember,
                preparationStartTime: currentRoundPlan.preparationStartTime,
                startTime: currentRoundPlan.startTime,
                endTime: currentRoundPlan.endTime,
                sourceUpdatedAt: currentRoundPlan.sourceUpdatedAt,
              },
              update: {
                eventInstanceId,
                roundDay: currentRoundPlan.roundDay,
                clanName: currentRoundPlan.clanName,
                opponentTag: currentRoundPlan.opponentTag,
                opponentName: currentRoundPlan.opponentName,
                roundState: currentRoundPlan.roundState,
                leagueGroupState: currentRoundPlan.leagueGroupState,
                teamSize: currentRoundPlan.teamSize,
                attacksPerMember: currentRoundPlan.attacksPerMember,
                preparationStartTime: currentRoundPlan.preparationStartTime,
                startTime: currentRoundPlan.startTime,
                endTime: currentRoundPlan.endTime,
                sourceUpdatedAt: currentRoundPlan.sourceUpdatedAt,
              },
            });
            await tx.cwlRoundMemberCurrent.deleteMany({
              where: {
                eventInstanceId,
                season: observed.season,
                clanTag: observed.clanTag,
              },
            });
            if (currentRoundPlan.memberRows.length > 0) {
              await tx.cwlRoundMemberCurrent.createMany({
                data: currentRoundPlan.memberRows,
              });
            }
          } else {
            await tx.cwlRoundMemberCurrent.deleteMany({
              where: { eventInstanceId, season: observed.season, clanTag: observed.clanTag },
            });
            await tx.currentCwlRound.deleteMany({
              where: { eventInstanceId, season: observed.season, clanTag: observed.clanTag },
            });
          }
          logCwlPersistPhase({
            season: observed.season,
            clanTag: observed.clanTag,
            currentRoundCount: currentRoundCountForClan,
            currentMemberCount: currentMemberCountForClan,
            historyRoundCount: historyRoundCountForClan,
            historyMemberCount: historyMemberCountForClan,
            phase: "current_round",
            block: "current_round",
            status: "block_complete",
          });
        },
      });

      await runCwlPersistPhase({
        season: observed.season,
        clanTag: observed.clanTag,
        currentRoundCount: currentRoundCountForClan,
        currentMemberCount: currentMemberCountForClan,
        historyRoundCount: historyRoundCountForClan,
        historyMemberCount: historyMemberCountForClan,
        phase: "prep_snapshot",
        work: async (tx, trackBlock) => {
          trackBlock("prep_snapshot");
          logCwlPersistPhase({
            season: observed.season,
            clanTag: observed.clanTag,
            currentRoundCount: currentRoundCountForClan,
            currentMemberCount: currentMemberCountForClan,
            historyRoundCount: historyRoundCountForClan,
            historyMemberCount: historyMemberCountForClan,
            phase: "prep_snapshot",
            block: "prep_snapshot",
            status: "block_start",
          });
          if (currentPrepSnapshotPlan) {
            await tx.currentCwlPrepSnapshot.upsert({
              where: {
                eventInstanceId_clanTag: {
                  eventInstanceId,
                  clanTag: observed.clanTag,
                },
              },
              create: {
                eventInstanceId,
                season: observed.season,
                clanTag: observed.clanTag,
                roundDay: currentPrepSnapshotPlan.roundDay,
                clanName: currentPrepSnapshotPlan.clanName,
                opponentTag: currentPrepSnapshotPlan.opponentTag,
                opponentName: currentPrepSnapshotPlan.opponentName,
                roundState: currentPrepSnapshotPlan.roundState,
                leagueGroupState: currentPrepSnapshotPlan.leagueGroupState,
                preparationStartTime: currentPrepSnapshotPlan.preparationStartTime,
                startTime: currentPrepSnapshotPlan.startTime,
                endTime: currentPrepSnapshotPlan.endTime,
                lineupJson: currentPrepSnapshotPlan.lineupJson,
                sourceUpdatedAt: currentPrepSnapshotPlan.sourceUpdatedAt,
              },
              update: {
                eventInstanceId,
                roundDay: currentPrepSnapshotPlan.roundDay,
                clanName: currentPrepSnapshotPlan.clanName,
                opponentTag: currentPrepSnapshotPlan.opponentTag,
                opponentName: currentPrepSnapshotPlan.opponentName,
                roundState: currentPrepSnapshotPlan.roundState,
                leagueGroupState: currentPrepSnapshotPlan.leagueGroupState,
                preparationStartTime: currentPrepSnapshotPlan.preparationStartTime,
                startTime: currentPrepSnapshotPlan.startTime,
                endTime: currentPrepSnapshotPlan.endTime,
                lineupJson: currentPrepSnapshotPlan.lineupJson,
                sourceUpdatedAt: currentPrepSnapshotPlan.sourceUpdatedAt,
              },
            });
          } else {
            await tx.currentCwlPrepSnapshot.deleteMany({
              where: { eventInstanceId, season: observed.season, clanTag: observed.clanTag },
            });
          }
          logCwlPersistPhase({
            season: observed.season,
            clanTag: observed.clanTag,
            currentRoundCount: currentRoundCountForClan,
            currentMemberCount: currentMemberCountForClan,
            historyRoundCount: historyRoundCountForClan,
            historyMemberCount: historyMemberCountForClan,
            phase: "prep_snapshot",
            block: "prep_snapshot",
            status: "block_complete",
          });
        },
      });

      await runCwlPersistPhase({
        season: observed.season,
        clanTag: observed.clanTag,
        currentRoundCount: currentRoundCountForClan,
        currentMemberCount: currentMemberCountForClan,
        historyRoundCount: historyRoundCountForClan,
        historyMemberCount: historyMemberCountForClan,
        phase: "history_rounds",
        work: async (tx, trackBlock) => {
          for (const round of historyRoundPlans) {
            trackBlock(`history_round_${round.roundDay}`);
            logCwlPersistPhase({
              season: observed.season,
              clanTag: observed.clanTag,
              currentRoundCount: currentRoundCountForClan,
              currentMemberCount: currentMemberCountForClan,
              historyRoundCount: historyRoundCountForClan,
              historyMemberCount: historyMemberCountForClan,
              phase: "history_rounds",
              block: `history_round_${round.roundDay}`,
              status: "block_start",
            });
            await tx.cwlRoundHistory.upsert({
              where: {
                eventInstanceId_clanTag_roundDay: {
                  eventInstanceId,
                  clanTag: observed.clanTag,
                  roundDay: round.roundDay,
                },
              },
              create: {
                eventInstanceId,
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
                eventInstanceId,
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
            logCwlPersistPhase({
              season: observed.season,
              clanTag: observed.clanTag,
              currentRoundCount: currentRoundCountForClan,
              currentMemberCount: currentMemberCountForClan,
              historyRoundCount: historyRoundCountForClan,
              historyMemberCount: historyMemberCountForClan,
              phase: "history_rounds",
              block: `history_round_${round.roundDay}`,
              status: "block_complete",
            });
          }
        },
      });

      await runCwlPersistPhase({
        season: observed.season,
        clanTag: observed.clanTag,
        currentRoundCount: currentRoundCountForClan,
        currentMemberCount: currentMemberCountForClan,
        historyRoundCount: historyRoundCountForClan,
        historyMemberCount: historyMemberCountForClan,
        phase: "history_members",
        work: async (tx, trackBlock) => {
          for (const round of historyRoundPlans) {
            trackBlock(`history_members_${round.roundDay}`);
            logCwlPersistPhase({
              season: observed.season,
              clanTag: observed.clanTag,
              currentRoundCount: currentRoundCountForClan,
              currentMemberCount: currentMemberCountForClan,
              historyRoundCount: historyRoundCountForClan,
              historyMemberCount: historyMemberCountForClan,
              phase: "history_members",
              block: `history_members_${round.roundDay}`,
              status: "block_start",
            });
            await tx.cwlRoundMemberHistory.deleteMany({
              where: {
                eventInstanceId,
                season: observed.season,
                clanTag: observed.clanTag,
                roundDay: round.roundDay,
              },
            });
            if (round.memberRows.length > 0) {
              await tx.cwlRoundMemberHistory.createMany({
                data: round.memberRows,
              });
            }
            logCwlPersistPhase({
              season: observed.season,
              clanTag: observed.clanTag,
              currentRoundCount: currentRoundCountForClan,
              currentMemberCount: currentMemberCountForClan,
              historyRoundCount: historyRoundCountForClan,
              historyMemberCount: historyMemberCountForClan,
              phase: "history_members",
              block: `history_members_${round.roundDay}`,
              status: "block_complete",
            });
          }
        },
      });

      await runCwlSeasonRosterReconciliationWithRetry({
        eventInstanceId,
        season: observed.season,
        clanTag: observed.clanTag,
        rawObservedCount: observed.seasonRosterReconciliation.rawObservedCount,
        distinctRosterCount: observed.seasonRosterReconciliation.distinctRosterCount,
        seasonRosterRows,
        currentRoundCount: currentRoundCountForClan,
        currentMemberCount: currentMemberCountForClan,
        historyRoundCount: historyRoundCountForClan,
        historyMemberCount: historyMemberCountForClan,
      });
    }

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
    eventInstanceId?: string | null;
  }): Promise<CwlCurrentRoundRecord | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;
    const eventInstanceId = await resolveCwlEventInstanceIdForClan({
      clanTag,
      eventInstanceId: input.eventInstanceId,
    });
    if (!eventInstanceId) return null;

    const round = await prisma.currentCwlRound.findUnique({
      where: {
        eventInstanceId_clanTag: {
          eventInstanceId,
          clanTag,
        },
      },
    });
    if (!round) return null;

    const members = await prisma.cwlRoundMemberCurrent.findMany({
      where: { eventInstanceId, clanTag },
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
    eventInstanceId?: string | null;
  }): Promise<CwlPreparationSnapshotRecord | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;
    const eventInstanceId = await resolveCwlEventInstanceIdForClan({
      clanTag,
      eventInstanceId: input.eventInstanceId,
    });
    if (!eventInstanceId) return null;

    const snapshot = await prisma.currentCwlPrepSnapshot.findUnique({
      where: {
        eventInstanceId_clanTag: {
          eventInstanceId,
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
    eventInstanceId?: string | null;
    throughRoundDay: number;
  }): Promise<Map<string, number>> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    const throughRoundDay = Math.max(1, Math.trunc(Number(input.throughRoundDay) || 0));
    if (!clanTag || throughRoundDay <= 0) {
      return new Map();
    }
    const eventInstanceId = await resolveCwlEventInstanceIdForClan({
      clanTag,
      eventInstanceId: input.eventInstanceId,
    });
    if (!eventInstanceId) return new Map();

    const [historyMembers, currentMembers] = await Promise.all([
      prisma.cwlRoundMemberHistory.findMany({
        where: {
          eventInstanceId,
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
          eventInstanceId,
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
    eventInstanceId?: string | null;
  }): Promise<CwlActualLineup | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    const roundDay = Math.max(1, Math.trunc(Number(input.roundDay) || 0));
    if (!clanTag || roundDay <= 0) return null;

    const resolvedOwner = await loadPersistedCwlDayOwner({
      clanTag,
      season,
      roundDay,
      eventInstanceId: input.eventInstanceId,
    });
    if (!resolvedOwner) {
      return null;
    }

    if (resolvedOwner.source === "prep") {
      return mapPreparationSnapshotToActualLineup(resolvedOwner.owner);
    }
    return loadPersistedCwlActualLineup({
      owner: resolvedOwner.owner,
      memberSource: resolvedOwner.source,
    });
  }

  /** Purpose: load the persisted battle-day start timestamp for one requested CWL day. */
  async getBattleDayStartForClanDay(input: {
    clanTag: string;
    season?: string;
    roundDay: number;
    eventInstanceId?: string | null;
  }): Promise<Date | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    const roundDay = Math.max(1, Math.trunc(Number(input.roundDay) || 0));
    if (!clanTag || roundDay <= 0) return null;

    const resolvedOwner = await loadPersistedCwlDayOwner({
      clanTag,
      season,
      roundDay,
      eventInstanceId: input.eventInstanceId,
    });
    return resolvedOwner?.owner.startTime ?? null;
  }

  /** Purpose: build one DB-first current-season CWL roster view from persisted roster and round owners. */
  async listSeasonRosterForClan(input: {
    clanTag: string;
    season?: string;
    eventInstanceId?: string | null;
  }): Promise<CwlSeasonRosterEntry[]> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return [];
    const eventInstanceId = await resolveCwlEventInstanceIdForClan({
      clanTag,
      eventInstanceId: input.eventInstanceId,
    });
    if (!eventInstanceId) return [];

    const rosterRows = await prisma.cwlPlayerClanSeason.findMany({
      where: { eventInstanceId, cwlClanTag: clanTag },
      orderBy: [{ lastRoundDay: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
    });
    const rosterRowsByTag = new Map<string, (typeof rosterRows)[number]>();
    for (const row of rosterRows) {
      const normalizedPlayerTag = normalizePlayerTag(row.playerTag);
      if (!normalizedPlayerTag || rosterRowsByTag.has(normalizedPlayerTag)) continue;
      rosterRowsByTag.set(normalizedPlayerTag, row);
    }
    const rosterTags = [...rosterRowsByTag.keys()];
    const [currentRound, currentMembers, playerLinks, playerCurrents] = await Promise.all([
      prisma.currentCwlRound.findUnique({
        where: { eventInstanceId_clanTag: { eventInstanceId, clanTag } },
      }),
      prisma.cwlRoundMemberCurrent.findMany({
        where: { eventInstanceId, clanTag },
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
      prisma.playerCurrent.findMany({
        where: {
          playerTag: { in: rosterTags },
        },
        select: {
          playerTag: true,
          currentWeight: true,
          role: true,
        },
      }),
    ]);

    const currentMemberByTag = new Map<string, (typeof currentMembers)[number]>();
    for (const member of currentMembers) {
      const normalizedPlayerTag = normalizePlayerTag(member.playerTag);
      if (!normalizedPlayerTag || currentMemberByTag.has(normalizedPlayerTag)) continue;
      currentMemberByTag.set(normalizedPlayerTag, member);
    }
    const playerLinkByTag = new Map<string, (typeof playerLinks)[number]>();
    for (const row of playerLinks) {
      const normalizedPlayerTag = normalizePlayerTag(row.playerTag);
      if (!normalizedPlayerTag || playerLinkByTag.has(normalizedPlayerTag)) continue;
      playerLinkByTag.set(normalizedPlayerTag, row);
    }
    const playerCurrentByTag = new Map<string, (typeof playerCurrents)[number]>();
    for (const row of playerCurrents) {
      const normalizedPlayerTag = normalizePlayerTag(row.playerTag);
      if (!normalizedPlayerTag || playerCurrentByTag.has(normalizedPlayerTag)) continue;
      playerCurrentByTag.set(normalizedPlayerTag, row);
    }
    const rosterEntries = [...rosterRowsByTag.entries()].map(([playerTag, row]) => {
      const currentMember = currentMemberByTag.get(playerTag) ?? null;
      const playerLink = playerLinkByTag.get(playerTag) ?? null;
      const playerCurrent = playerCurrentByTag.get(playerTag) ?? null;
      return {
        season: row.season,
        clanTag: row.cwlClanTag,
        playerTag,
        playerName:
          sanitizeCwlName(playerLink?.playerName) ??
          sanitizeCwlName(row.playerName) ??
          sanitizeCwlName(currentMember?.playerName) ??
          playerTag,
        townHall: currentMember?.townHall ?? row.townHall,
        currentWeight: playerCurrent?.currentWeight ?? null,
        role: playerCurrent?.role ?? null,
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
    return canonicalizeCwlSeasonRosterEntries(rosterEntries);
  }
}

export const cwlStateService = new CwlStateService();
