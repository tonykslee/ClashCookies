import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  normalizeClashTagInput,
  normalizeClashTagBareInput,
  normalizeClashTagWithHash,
} from "../helper/clashTag";
import { normalizeDiscordUserId } from "./PlayerLinkService";

export type WarPlanViolationHistoryPeriod = "30d" | "lifetime";

export type WarPlanViolationHistoryPlayerSummary = {
  playerTag: string;
  playerName: string;
  townHallLevel: number | null;
  discordUserId: string | null;
  violationCount: number;
  affectedWarCount: number;
};

export type WarPlanViolationHistoryClanSummary = {
  clanTag: string;
  clanName: string;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  distinctPlayerCount: number;
};

export type WarPlanViolationHistoryAllianceOverview = {
  outcome: "success";
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: Date | null;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  distinctPlayerCount: number;
  distinctClanCount: number;
  distinctCurrentDiscordUserCount: number;
  clanSummaries: WarPlanViolationHistoryClanSummary[];
  topPlayers: WarPlanViolationHistoryPlayerSummary[];
  hasCompletedEvaluations: boolean;
};

export type WarPlanViolationHistoryClanLeaderboardSuccess = {
  outcome: "success";
  clanTag: string;
  clanName: string;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: Date | null;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  distinctPlayerCount: number;
  players: WarPlanViolationHistoryPlayerSummary[];
  hasCompletedEvaluations: boolean;
};

export type WarPlanViolationHistoryClanLeaderboardNotFound = {
  outcome: "not_found";
  clanTag: string;
  clanName: null;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: null;
  evaluatedWarCount: 0;
  affectedWarCount: 0;
  violationCount: 0;
  distinctPlayerCount: 0;
  players: [];
  hasCompletedEvaluations: false;
};

export type WarPlanViolationHistoryClanLeaderboardResult =
  | WarPlanViolationHistoryClanLeaderboardSuccess
  | WarPlanViolationHistoryClanLeaderboardNotFound;

export type WarPlanViolationHistoryPlayerHistoryEntry = {
  violationId: string;
  evaluationId: string;
  warId: number;
  warStartTime: Date;
  warEndTime: Date | null;
  clanTag: string;
  clanName: string;
  opponentTag: string;
  opponentName: string | null;
  expectedOutcome: string | null;
  loseStyle: string | null;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
  playerPosition: number | null;
  violationType: string;
  reasonLabel: string | null;
  expectedBehavior: string;
  actualBehavior: string;
  breachStarsAt: number | null;
  breachTimeRemaining: string | null;
  attackEvidence: WarPlanViolationHistoryAttackEvidence;
};

export type WarPlanViolationHistoryAttackEvidence = {
  attacks: WarPlanViolationHistoryAttackEvidenceAttack[];
  breachContext: WarPlanViolationHistoryAttackEvidenceBreachContext | null;
};

export type WarPlanViolationHistoryAttackEvidenceAttack = {
  defenderPosition: number | null;
  stars: number | null;
  attackOrder: number | null;
  isBreach: boolean;
};

export type WarPlanViolationHistoryAttackEvidenceBreachContext = {
  starsAtBreach: number | null;
  timeRemaining: string | null;
};

export type WarPlanViolationHistoryPlayerHistorySuccess = {
  outcome: "success";
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: Date | null;
  playerTag: string;
  playerName: string;
  townHallLevel: number | null;
  discordUserId: string | null;
  violationCount: number;
  affectedWarCount: number;
  hasRecordedViolations: true;
  hasViolationsInPeriod: boolean;
  entries: WarPlanViolationHistoryPlayerHistoryEntry[];
};

export type WarPlanViolationHistoryPlayerHistoryInvalidTag = {
  outcome: "invalid_tag";
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: null;
  playerTag: "";
  playerName: null;
  townHallLevel: null;
  discordUserId: null;
  violationCount: 0;
  affectedWarCount: 0;
  hasRecordedViolations: false;
  hasViolationsInPeriod: false;
  entries: [];
};

export type WarPlanViolationHistoryPlayerHistoryNotFound = {
  outcome: "not_found";
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  trackingSince: null;
  playerTag: string;
  playerName: null;
  townHallLevel: null;
  discordUserId: null;
  violationCount: 0;
  affectedWarCount: 0;
  hasRecordedViolations: false;
  hasViolationsInPeriod: false;
  entries: [];
};

export type WarPlanViolationHistoryPlayerHistoryResult =
  | WarPlanViolationHistoryPlayerHistorySuccess
  | WarPlanViolationHistoryPlayerHistoryInvalidTag
  | WarPlanViolationHistoryPlayerHistoryNotFound;

export type WarPlanViolationHistoryDiscordUserAggregateSuccess = {
  outcome: "success";
  discordUserId: string;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  clanTag: string | null;
  trackingSince: Date | null;
  currentLinkedAccountCount: number;
  violatingAccountCount: number;
  violationCount: number;
  affectedWarCount: number;
  hasViolationsInPeriod: boolean;
  accounts: WarPlanViolationHistoryPlayerSummary[];
};

export type WarPlanViolationHistoryDiscordUserAggregateInvalidUser = {
  outcome: "invalid_user";
  discordUserId: string;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  clanTag: string | null;
  trackingSince: null;
  currentLinkedAccountCount: 0;
  violatingAccountCount: 0;
  violationCount: 0;
  affectedWarCount: 0;
  hasViolationsInPeriod: false;
  accounts: [];
};

export type WarPlanViolationHistoryDiscordUserAggregateInvalidClan = {
  outcome: "invalid_clan";
  discordUserId: string;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  clanTag: string | null;
  trackingSince: null;
  currentLinkedAccountCount: 0;
  violatingAccountCount: 0;
  violationCount: 0;
  affectedWarCount: 0;
  hasViolationsInPeriod: false;
  accounts: [];
};

export type WarPlanViolationHistoryDiscordUserAggregateNotFound = {
  outcome: "not_found";
  discordUserId: string;
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date | null;
  clanTag: string | null;
  trackingSince: null;
  currentLinkedAccountCount: 0;
  violatingAccountCount: 0;
  violationCount: 0;
  affectedWarCount: 0;
  hasViolationsInPeriod: false;
  accounts: [];
};

export type WarPlanViolationHistoryDiscordUserAggregateResult =
  | WarPlanViolationHistoryDiscordUserAggregateSuccess
  | WarPlanViolationHistoryDiscordUserAggregateInvalidUser
  | WarPlanViolationHistoryDiscordUserAggregateInvalidClan
  | WarPlanViolationHistoryDiscordUserAggregateNotFound;

export type WarPlanViolationHistoryClanPlayerViolationCountsResult = {
  period: WarPlanViolationHistoryPeriod;
  cutoff: Date;
  clanTag: string;
  hasCompletedEvaluations: boolean;
  evaluatedWarCount: number;
  violationCountByPlayerTag: Map<string, number>;
};

type CompletedEvaluationRow = {
  warId: number;
  warHistory: {
    warId: number;
    clanTag: string;
    clanName: string | null;
    warStartTime: Date;
    warEndTime: Date | null;
  } | null;
  violations: Array<{
    playerTag: string;
    playerNameSnapshot: string | null;
    townHallLevelSnapshot: number | null;
  }>;
};

type PlayerHistoryEvaluationRow = {
  id: string;
  evaluationId: string;
  playerTag: string;
  playerNameSnapshot: string | null;
  playerPosition: number | null;
  townHallLevelSnapshot: number | null;
  violationType: string;
  reasonLabel: string | null;
  expectedBehavior: string;
  actualBehavior: string;
  breachStarsAt: number | null;
  breachTimeRemaining: string | null;
  attackDetails: Prisma.JsonValue | null;
  evaluation: {
    id: string;
    expectedOutcome: string | null;
    loseStyle: string | null;
    warHistory: {
      warId: number;
      clanTag: string;
      clanName: string | null;
      opponentTag: string | null;
      opponentName: string | null;
      warStartTime: Date;
      warEndTime: Date | null;
    };
  };
};

type PlayerSnapshotFallback = {
  playerName: string | null;
  townHallLevel: number | null;
};

type AggregatedPlayerRow = {
  playerTag: string;
  violationCount: number;
  affectedWarIds: Set<number>;
};

type AggregatedClanRow = {
  clanTag: string;
  clanNameSnapshot: string;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  distinctPlayerTags: Set<string>;
};

type HistoryAggregation = {
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  trackingSince: Date | null;
  clans: Map<string, AggregatedClanRow>;
  players: Map<string, AggregatedPlayerRow>;
  playerFallbacks: Map<string, PlayerSnapshotFallback>;
};

type CurrentPlayerRow = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
};

type FwaClanMemberCurrentRow = {
  playerTag: string;
  clanTag: string;
  townHall: number | null;
  sourceSyncedAt: Date;
};

type FwaPlayerCatalogRow = {
  playerTag: string;
  latestName: string | null;
  latestTownHall: number | null;
};

type TodoPlayerSnapshotRow = {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
};

type PlayerLinkRow = {
  playerTag: string;
  discordUserId: string | null;
  verificationStatus: string;
};

type DiscordUserAggregateViolationRow = {
  id: string;
  playerTag: string;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
  evaluation: {
    warHistory: {
      warId: number;
      clanTag: string;
      warStartTime: Date;
      warEndTime: Date | null;
    };
  };
};

type DiscordUserAggregatePlayerRow = {
  playerTag: string;
  violationCount: number;
  affectedWarIds: Set<number>;
  snapshotFallback: PlayerSnapshotFallback | undefined;
};

type PlayerAutocompleteSnapshotFallbackRow = {
  playerTag: string;
  playerNameSnapshot: string | null;
  townHallLevelSnapshot: number | null;
};

const PLAYER_AUTOCOMPLETE_DISCOVERY_CAP = 100;

type PlayerAutocompleteCandidate = {
  playerTag: string;
  violationCount: number;
  snapshotFallback: PlayerSnapshotFallback | undefined;
  current: CurrentPlayerRow | null;
  fwaMemberRows: FwaClanMemberCurrentRow[];
  fwaCatalog: FwaPlayerCatalogRow | null;
  todoSnapshot: TodoPlayerSnapshotRow | null;
  playerLink: PlayerLinkRow | null;
  resolvedName: string;
};

type PlayerIdentityData = {
  currentByTag: Map<string, CurrentPlayerRow>;
  fwaMemberRowsByTag: Map<string, FwaClanMemberCurrentRow[]>;
  fwaCatalogByTag: Map<string, FwaPlayerCatalogRow>;
  todoSnapshotByTag: Map<string, TodoPlayerSnapshotRow>;
  playerLinkByTag: Map<string, PlayerLinkRow>;
};

type PeriodWindow = {
  now: Date;
  cutoff: Date | null;
};

/** Purpose: normalize free-form display text while preserving empty-as-null semantics. */
function normalizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Purpose: canonicalize stored or queried Clash tags into comparable #TAG form. */
function normalizeTag(input: string | null | undefined): string {
  return normalizeClashTagInput(input);
}

/** Purpose: normalize a positive integer snapshot field when present. */
function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Purpose: rank FWA clan-member rows by newest sync and deterministic clan tag tie-breaker. */
function compareFwaClanMemberRowsDesc(
  a: FwaClanMemberCurrentRow,
  b: FwaClanMemberCurrentRow,
): number {
  const syncDelta = b.sourceSyncedAt.getTime() - a.sourceSyncedAt.getTime();
  if (syncDelta !== 0) return syncDelta;
  return a.clanTag.localeCompare(b.clanTag);
}

/** Purpose: choose the newest applicable FWA clan-member row for one player. */
function pickPreferredFwaClanMemberRow(
  rows: FwaClanMemberCurrentRow[],
): FwaClanMemberCurrentRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(compareFwaClanMemberRowsDesc)[0] ?? null;
}

/** Purpose: normalize a persisted PlayerLink row into the current-owner attribution contract. */
function normalizePlayerLinkRow(row: PlayerLinkRow): PlayerLinkRow {
  const discordUserId = normalizeDiscordUserId(row.discordUserId);
  return {
    playerTag: normalizeTag(row.playerTag),
    discordUserId: row.verificationStatus === "REVOKED" ? null : discordUserId,
    verificationStatus: row.verificationStatus,
  };
}

/** Purpose: resolve the best persisted identity fields for one violating player. */
function resolveEnrichedPlayerIdentity(input: {
  playerTag: string;
  fallback: PlayerSnapshotFallback | undefined;
  current: CurrentPlayerRow | null;
  fwaMemberRows: FwaClanMemberCurrentRow[];
  fwaCatalog: FwaPlayerCatalogRow | null;
  todoSnapshot: TodoPlayerSnapshotRow | null;
  playerLink: PlayerLinkRow | null;
}): {
  playerName: string;
  townHallLevel: number | null;
  discordUserId: string | null;
} {
  const currentName = normalizeDisplayText(input.current?.playerName);
  const fwaName = normalizeDisplayText(input.fwaCatalog?.latestName);
  const todoName = normalizeDisplayText(input.todoSnapshot?.playerName);
  const fallbackName = normalizeDisplayText(input.fallback?.playerName);

  const playerName = currentName ?? fwaName ?? todoName ?? fallbackName ?? normalizeTag(input.playerTag);

  const currentTownHall = normalizePositiveInteger(input.current?.townHall);
  const preferredMember = pickPreferredFwaClanMemberRow(input.fwaMemberRows);
  const memberTownHall = normalizePositiveInteger(preferredMember?.townHall);
  const fwaTownHall = normalizePositiveInteger(input.fwaCatalog?.latestTownHall);
  const todoTownHall = normalizePositiveInteger(input.todoSnapshot?.townHall);
  const fallbackTownHall = normalizePositiveInteger(input.fallback?.townHallLevel);

  const townHallLevel =
    currentTownHall ?? memberTownHall ?? fwaTownHall ?? todoTownHall ?? fallbackTownHall ?? null;

  const normalizedPlayerLink = input.playerLink ? normalizePlayerLinkRow(input.playerLink) : null;
  const discordUserId = normalizedPlayerLink?.discordUserId ?? null;

  return {
    playerName,
    townHallLevel,
    discordUserId,
  };
}

/** Purpose: derive a single canonical chronology timestamp for a completed war row. */
function resolveCanonicalChronologyMs(row: CompletedEvaluationRow): number {
  const history = row.warHistory;
  if (!history) return Number.NEGATIVE_INFINITY;
  const canonicalTime = history.warEndTime ?? history.warStartTime;
  return canonicalTime.getTime();
}

/** Purpose: order rows by newest canonical history first, then war id as the final tie-breaker. */
function compareCanonicalRowsDesc(a: CompletedEvaluationRow, b: CompletedEvaluationRow): number {
  const timeDelta = resolveCanonicalChronologyMs(b) - resolveCanonicalChronologyMs(a);
  if (timeDelta !== 0) return timeDelta;
  return b.warId - a.warId;
}

/** Purpose: sort player summaries by the documented public leaderboard order. */
function sortPlayerSummaries(
  a: WarPlanViolationHistoryPlayerSummary,
  b: WarPlanViolationHistoryPlayerSummary,
): number {
  if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
  const nameCompare = a.playerName.localeCompare(b.playerName);
  if (nameCompare !== 0) return nameCompare;
  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: sort clan summaries by the documented public leaderboard order. */
function sortClanSummaries(
  a: WarPlanViolationHistoryClanSummary,
  b: WarPlanViolationHistoryClanSummary,
): number {
  if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
  const nameCompare = a.clanName.localeCompare(b.clanName);
  if (nameCompare !== 0) return nameCompare;
  return a.clanTag.localeCompare(b.clanTag);
}

/** Purpose: derive the selected reporting window once and reuse the same Date objects for query and metadata. */
function resolvePeriodWindow(input: {
  period: WarPlanViolationHistoryPeriod;
  now?: Date;
}): PeriodWindow {
  const now = input.now ?? new Date();
  const cutoff =
    input.period === "30d" ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : null;
  return { now, cutoff };
}

/** Purpose: aggregate canonical history rows into deterministic player/clan summaries. */
function buildHistoryAggregation(rows: CompletedEvaluationRow[]): HistoryAggregation {
  const orderedRows = [...rows].sort(compareCanonicalRowsDesc);
  const clans = new Map<string, AggregatedClanRow>();
  const players = new Map<string, AggregatedPlayerRow>();
  const playerFallbacks = new Map<string, PlayerSnapshotFallback>();
  let evaluatedWarCount = 0;
  let affectedWarCount = 0;
  let violationCount = 0;
  let trackingSince: Date | null = null;

  for (const row of orderedRows) {
    evaluatedWarCount += 1;
    const history = row.warHistory;
    if (!history) continue;

    if (history.warEndTime instanceof Date) {
      if (trackingSince === null || history.warEndTime.getTime() < trackingSince.getTime()) {
        trackingSince = history.warEndTime;
      }
    }

    const clanTag = normalizeTag(history.clanTag);
    if (clanTag) {
      const clanNameSnapshot = normalizeDisplayText(history.clanName) ?? clanTag;
      const clan = clans.get(clanTag);
      if (!clan) {
        clans.set(clanTag, {
          clanTag,
          clanNameSnapshot,
          evaluatedWarCount: 1,
          affectedWarCount: row.violations.length > 0 ? 1 : 0,
          violationCount: row.violations.length,
          distinctPlayerTags: new Set(),
        });
      } else {
        clan.evaluatedWarCount += 1;
        if (row.violations.length > 0) clan.affectedWarCount += 1;
        clan.violationCount += row.violations.length;
      }
    }

    if (row.violations.length > 0) {
      affectedWarCount += 1;
    }

    const seenPlayersInRow = new Set<string>();
    for (const violation of row.violations) {
      const playerTag = normalizeTag(violation.playerTag);
      if (!playerTag) continue;

      violationCount += 1;
      if (clanTag) {
        clans.get(clanTag)?.distinctPlayerTags.add(playerTag);
      }

      const playerName = normalizeDisplayText(violation.playerNameSnapshot);
      const townHallLevel = normalizePositiveInteger(violation.townHallLevelSnapshot);
      const snapshotFallback = playerFallbacks.get(playerTag);
      if (!snapshotFallback) {
        playerFallbacks.set(playerTag, {
          playerName,
          townHallLevel,
        });
      } else if (snapshotFallback.townHallLevel === null && townHallLevel !== null) {
        playerFallbacks.set(playerTag, {
          playerName: snapshotFallback.playerName,
          townHallLevel,
        });
      }

      const player = players.get(playerTag);
      if (!player) {
        players.set(playerTag, {
          playerTag,
          violationCount: 1,
          affectedWarIds: new Set(seenPlayersInRow.has(playerTag) ? [] : [row.warId]),
        });
        seenPlayersInRow.add(playerTag);
        continue;
      }

      player.violationCount += 1;
      if (!player.affectedWarIds.has(row.warId)) {
        player.affectedWarIds.add(row.warId);
      }
      seenPlayersInRow.add(playerTag);
    }
  }

  return {
    evaluatedWarCount,
    affectedWarCount,
    violationCount,
    trackingSince,
    clans,
    players,
    playerFallbacks,
  };
}

/** Purpose: convert aggregated player state into the public summary shape. */
function toPlayerSummaries(input: {
  players: Map<string, AggregatedPlayerRow>;
  playerFallbacks: Map<string, PlayerSnapshotFallback>;
  identityData?: PlayerIdentityData | null;
}): WarPlanViolationHistoryPlayerSummary[] {
  return [...input.players.values()]
    .map((row) => {
      const fallback = input.playerFallbacks.get(row.playerTag);
      const current = input.identityData?.currentByTag.get(row.playerTag) ?? null;
      const fwaMemberRows = input.identityData?.fwaMemberRowsByTag.get(row.playerTag) ?? [];
      const fwaCatalog = input.identityData?.fwaCatalogByTag.get(row.playerTag) ?? null;
      const todoSnapshot = input.identityData?.todoSnapshotByTag.get(row.playerTag) ?? null;
      const playerLink = input.identityData?.playerLinkByTag.get(row.playerTag) ?? null;
      const identity = resolveEnrichedPlayerIdentity({
        playerTag: row.playerTag,
        fallback,
        current,
        fwaMemberRows,
        fwaCatalog,
        todoSnapshot,
        playerLink,
      });

      return {
        playerTag: row.playerTag,
        playerName: identity.playerName,
        townHallLevel: identity.townHallLevel,
        discordUserId: identity.discordUserId,
        violationCount: row.violationCount,
        affectedWarCount: row.affectedWarIds.size,
      };
    })
    .sort(sortPlayerSummaries);
}

/** Purpose: convert aggregated clan state into the public summary shape. */
function toClanSummaries(
  clans: Map<string, AggregatedClanRow>,
): WarPlanViolationHistoryClanSummary[] {
  return [...clans.values()]
    .filter((row) => row.violationCount > 0)
    .map((row) => ({
      clanTag: row.clanTag,
      clanName: row.clanNameSnapshot,
      evaluatedWarCount: row.evaluatedWarCount,
      affectedWarCount: row.affectedWarCount,
      violationCount: row.violationCount,
      distinctPlayerCount: row.distinctPlayerTags.size,
    }))
    .sort(sortClanSummaries);
}

/** Purpose: build the Prisma where input for the completed-history query. */
function buildCompletedEvaluationWhere(input: {
  guildId: string;
  cutoff: Date | null;
  clanTag: string | null;
}): Prisma.WarPlanComplianceEvaluationWhereInput {
  const warHistoryFilter: Prisma.ClanWarHistoryWhereInput = {};
  if (input.cutoff) {
    warHistoryFilter.warEndTime = { gte: input.cutoff };
  }
  if (input.clanTag) {
    warHistoryFilter.clanTag = input.clanTag;
  }

  return {
    guildId: input.guildId,
    status: "COMPLETED",
    ...(Object.keys(warHistoryFilter).length > 0
      ? {
          warHistory: {
            is: warHistoryFilter,
          },
        }
      : {}),
  };
}

/** Purpose: build the Prisma where input for player-history violation lookups. */
function buildPlayerHistoryViolationWhere(input: {
  guildId: string;
  playerTag: string;
  cutoff: Date | null;
}): Prisma.WarPlanViolationWhereInput {
  const evaluationWhere: Prisma.WarPlanComplianceEvaluationWhereInput = {
    guildId: input.guildId,
    status: "COMPLETED",
    ...(input.cutoff
      ? {
          warHistory: {
            is: {
              warEndTime: {
                gte: input.cutoff,
              },
            },
          },
        }
      : {}),
  };

  return {
    playerTag: input.playerTag,
    evaluation: {
      is: evaluationWhere,
    },
  };
}

/** Purpose: build the Prisma where input for Discord-user aggregate violation lookups. */
function buildDiscordUserAggregateViolationWhere(input: {
  guildId: string;
  playerTags: string[];
  cutoff: Date | null;
  clanTag: string | null;
}): Prisma.WarPlanViolationWhereInput {
  const warHistoryFilter: Prisma.ClanWarHistoryWhereInput = {};
  if (input.cutoff) {
    warHistoryFilter.warEndTime = { gte: input.cutoff };
  }
  if (input.clanTag) {
    warHistoryFilter.clanTag = input.clanTag;
  }

  const evaluationWhere: Prisma.WarPlanComplianceEvaluationWhereInput = {
    guildId: input.guildId,
    status: "COMPLETED",
    ...(Object.keys(warHistoryFilter).length > 0
      ? {
          warHistory: {
            is: warHistoryFilter,
          },
        }
      : {}),
  };

  return {
    playerTag: {
      in: input.playerTags,
    },
    evaluation: {
      is: evaluationWhere,
    },
  };
}

/** Purpose: derive a single canonical chronology timestamp for a player-history violation row. */
function resolvePlayerHistoryChronologyMs(row: PlayerHistoryEvaluationRow): number {
  const history = row.evaluation.warHistory;
  const canonicalTime = history.warEndTime ?? history.warStartTime;
  return canonicalTime.getTime();
}

/** Purpose: order player-history violations by newest canonical history first and violation id as a stable tie-breaker. */
function comparePlayerHistoryRowsDesc(
  a: PlayerHistoryEvaluationRow,
  b: PlayerHistoryEvaluationRow,
): number {
  const timeDelta = resolvePlayerHistoryChronologyMs(b) - resolvePlayerHistoryChronologyMs(a);
  if (timeDelta !== 0) return timeDelta;
  const warDelta = b.evaluation.warHistory.warId - a.evaluation.warHistory.warId;
  if (warDelta !== 0) return warDelta;
  return a.id.localeCompare(b.id);
}

/** Purpose: derive the canonical chronology timestamp for a Discord-user aggregate violation row. */
function resolveDiscordUserAggregateChronologyMs(row: DiscordUserAggregateViolationRow): number {
  const history = row.evaluation.warHistory;
  const canonicalTime = history.warEndTime ?? history.warStartTime;
  return canonicalTime.getTime();
}

/** Purpose: order Discord-user aggregate violations by newest canonical history first. */
function compareDiscordUserAggregateRowsDesc(
  a: DiscordUserAggregateViolationRow,
  b: DiscordUserAggregateViolationRow,
): number {
  const timeDelta = resolveDiscordUserAggregateChronologyMs(b) - resolveDiscordUserAggregateChronologyMs(a);
  if (timeDelta !== 0) return timeDelta;
  const warDelta = b.evaluation.warHistory.warId - a.evaluation.warHistory.warId;
  if (warDelta !== 0) return warDelta;
  return a.id.localeCompare(b.id);
}

/** Purpose: convert a raw violation row into the public player-history entry shape. */
function toPlayerHistoryEntry(
  row: PlayerHistoryEvaluationRow,
): WarPlanViolationHistoryPlayerHistoryEntry {
  const history = row.evaluation.warHistory;
  const clanTag = normalizeTag(history.clanTag);
  const opponentTag = normalizeTag(history.opponentTag);
  return {
    violationId: row.id,
    evaluationId: row.evaluationId,
    warId: history.warId,
    warStartTime: history.warStartTime,
    warEndTime: history.warEndTime,
    clanTag,
    clanName: normalizeDisplayText(history.clanName) ?? clanTag,
    opponentTag,
    opponentName: normalizeDisplayText(history.opponentName) ?? (opponentTag || null),
    expectedOutcome: row.evaluation.expectedOutcome ?? null,
    loseStyle: row.evaluation.loseStyle ?? null,
    playerNameSnapshot: normalizeDisplayText(row.playerNameSnapshot),
    townHallLevelSnapshot: normalizePositiveInteger(row.townHallLevelSnapshot),
    playerPosition: row.playerPosition ?? null,
    violationType: String(row.violationType ?? ""),
    reasonLabel: normalizeDisplayText(row.reasonLabel),
    expectedBehavior: normalizeDisplayText(row.expectedBehavior) ?? "",
    actualBehavior: normalizeDisplayText(row.actualBehavior) ?? "",
    breachStarsAt: row.breachStarsAt ?? null,
    breachTimeRemaining: normalizeDisplayText(row.breachTimeRemaining),
    attackEvidence: normalizePlayerHistoryAttackEvidence(row.attackDetails),
  };
}

/** Purpose: derive the canonical snapshot fallback for populated player-history results. */
function buildPlayerHistorySnapshotFallback(
  rows: PlayerHistoryEvaluationRow[],
): PlayerSnapshotFallback | undefined {
  let fallback: PlayerSnapshotFallback | undefined;
  for (const row of rows) {
    const playerName = normalizeDisplayText(row.playerNameSnapshot);
    const townHallLevel = normalizePositiveInteger(row.townHallLevelSnapshot);
    if (!fallback) {
      fallback = {
        playerName,
        townHallLevel,
      };
      continue;
    }
    if (fallback.townHallLevel === null && townHallLevel !== null) {
      fallback = {
        playerName: fallback.playerName,
        townHallLevel,
      };
    }
  }
  return fallback;
}

/** Purpose: derive a single canonical chronology timestamp for one autocomplete candidate row. */
/** Purpose: normalize the focused autocomplete text for stable comparisons. */
function normalizeAutocompleteQueryText(input: string | null | undefined): string {
  return String(input ?? "").trim().toLowerCase();
}

/** Purpose: normalize the focused autocomplete text for partial Clash-tag matching. */
function normalizeAutocompleteTagQuery(input: string | null | undefined): string {
  return normalizeClashTagBareInput(input);
}

/** Purpose: normalize the requested autocomplete limit into Discord's allowed range. */
function normalizeAutocompleteLimit(input: number | null | undefined): number {
  const parsed = Number(input ?? 25);
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(25, Math.max(1, Math.trunc(parsed)));
}

/** Purpose: build a compact Discord autocomplete label for one resolved violator. */
function buildPlayerAutocompleteChoiceName(input: {
  playerName: string;
  playerTag: string;
  violationCount: number;
}): string {
  const violationLabel = input.violationCount === 1 ? "violation" : "violations";
  const suffix = ` (${input.playerTag}) \u2014 ${input.violationCount} ${violationLabel}`;
  const maxPlayerNameLength = Math.max(0, 100 - suffix.length);
  const truncatedPlayerName =
    input.playerName.length > maxPlayerNameLength
      ? input.playerName.slice(0, maxPlayerNameLength)
      : input.playerName;
  return `${truncatedPlayerName}${suffix}`;
}

/** Purpose: classify one autocomplete candidate against the focused search text. */
function classifyPlayerAutocompleteMatch(input: {
  query: string;
  candidateTag: string;
  candidateName: string;
}): number | null {
  if (!input.query) return 4;

  const queryFullTag = normalizeClashTagInput(input.query).toLowerCase();
  const queryBareTag = normalizeClashTagBareInput(input.query).toLowerCase();
  const candidateFullTag = input.candidateTag.toLowerCase();
  const candidateBareTag = candidateFullTag.replace(/^#/, "");
  const candidateName = input.candidateName.toLowerCase();

  const exactTagMatch =
    candidateFullTag === queryFullTag ||
    candidateBareTag === queryBareTag ||
    candidateFullTag === `#${queryBareTag}` ||
    candidateBareTag === queryFullTag.replace(/^#/, "");
  if (exactTagMatch) return 0;

  const tagPrefixMatch =
    candidateFullTag.startsWith(queryFullTag) ||
    candidateBareTag.startsWith(queryBareTag);
  if (tagPrefixMatch) return 1;

  if (candidateName.startsWith(input.query)) return 2;

  const substringMatch =
    candidateFullTag.includes(queryFullTag) ||
    candidateBareTag.includes(queryBareTag) ||
    candidateName.includes(input.query);
  if (substringMatch) return 3;

  return null;
}

/** Purpose: sort autocomplete choices by match strength and the documented tie-breakers. */
function comparePlayerAutocompleteCandidates(
  a: PlayerAutocompleteCandidate & { matchRank: number },
  b: PlayerAutocompleteCandidate & { matchRank: number },
): number {
  if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
  if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
  const nameCompare = a.resolvedName.localeCompare(b.resolvedName);
  if (nameCompare !== 0) return nameCompare;
  return a.playerTag.localeCompare(b.playerTag);
}

/** Purpose: merge bounded candidate discovery lanes into one deduplicated tag list. */
function mergePlayerAutocompleteDiscoveryTags(lanes: string[][]): string[] {
  const unique = new Set<string>();
  const merged: string[] = [];
  for (const lane of lanes) {
    for (const tag of lane) {
      const normalizedTag = normalizeTag(tag);
      if (!normalizedTag || unique.has(normalizedTag)) continue;
      unique.add(normalizedTag);
      merged.push(normalizedTag);
    }
  }
  return merged;
}

/** Purpose: normalize and deduplicate player tags for bounded violation-count reads. */
function normalizePlayerTagList(playerTags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of playerTags) {
    const normalizedTag = normalizeClashTagWithHash(tag);
    if (!normalizedTag || seen.has(normalizedTag)) continue;
    seen.add(normalizedTag);
    normalized.push(normalizedTag);
  }
  return normalized;
}

/** Purpose: defensively normalize persisted player-history attack evidence. */
function normalizePlayerHistoryAttackEvidence(
  value: Prisma.JsonValue | null,
): WarPlanViolationHistoryAttackEvidence {
  if (!isPlainJsonObject(value)) {
    return {
      attacks: [],
      breachContext: null,
    };
  }

  const record = value as Record<string, unknown>;
  const attacks = Array.isArray(record.attackDetails)
    ? record.attackDetails
        .filter(isPlainJsonObject)
        .map(normalizePlayerHistoryAttackEvidenceAttack)
    : [];
  return {
    attacks,
    breachContext: normalizePlayerHistoryAttackEvidenceBreachContext(record.breachContext),
  };
}

/** Purpose: defensively normalize one persisted attack detail row. */
function normalizePlayerHistoryAttackEvidenceAttack(
  value: Record<string, unknown>,
): WarPlanViolationHistoryAttackEvidenceAttack {
  const record = value;
  return {
    defenderPosition: normalizeFiniteInteger(record.defenderPosition),
    stars: normalizeFiniteInteger(record.stars),
    attackOrder: normalizeFiniteInteger(record.attackOrder),
    isBreach: record.isBreach === true,
  };
}

/** Purpose: defensively normalize the persisted breach context for history output. */
function normalizePlayerHistoryAttackEvidenceBreachContext(
  value: unknown,
): WarPlanViolationHistoryAttackEvidenceBreachContext | null {
  if (!isPlainJsonObject(value)) return null;

  const record = value as Record<string, unknown>;
  return {
    starsAtBreach: normalizeFiniteInteger(record.starsAtBreach),
    timeRemaining: normalizePlayerHistoryTimeRemaining(record.timeRemaining),
  };
}

/** Purpose: normalize strict finite integer-like JSON values without coercion. */
function normalizeFiniteInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** Purpose: normalize breach time remaining strictly from stored string values. */
function normalizePlayerHistoryTimeRemaining(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Purpose: determine whether a JSON value is a plain object suitable for defensive inspection. */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Purpose: aggregate completed war-plan violations into read-only history summaries. */
export class WarPlanViolationHistoryService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly db = prisma) {}

  /** Purpose: build the alliance-wide read-only war-plan violation overview. */
  async getAllianceOverview(input: {
    guildId: string;
    period: WarPlanViolationHistoryPeriod;
    now?: Date;
  }): Promise<WarPlanViolationHistoryAllianceOverview> {
    const guildId = String(input.guildId ?? "").trim();
    const { cutoff } = resolvePeriodWindow(input);
    if (!guildId) {
      return {
        outcome: "success",
        period: input.period,
        cutoff,
        trackingSince: null,
        evaluatedWarCount: 0,
        affectedWarCount: 0,
        violationCount: 0,
        distinctPlayerCount: 0,
        distinctClanCount: 0,
        distinctCurrentDiscordUserCount: 0,
        clanSummaries: [],
        topPlayers: [],
        hasCompletedEvaluations: false,
      };
    }

    const rows = await this.loadCompletedEvaluations({
      guildId,
      cutoff,
    });
    const aggregate = buildHistoryAggregation(rows);
    const clanSummaries = toClanSummaries(aggregate.clans);
    const identityData =
      aggregate.players.size > 0
        ? await this.loadPlayerIdentityData([...aggregate.players.keys()])
        : null;
    const topPlayers = toPlayerSummaries({
      players: aggregate.players,
      playerFallbacks: aggregate.playerFallbacks,
      identityData,
    });
    const distinctClanCount = clanSummaries.length;
    const distinctPlayerCount = new Set(topPlayers.map((row) => row.playerTag)).size;
    const distinctCurrentDiscordUserCount = new Set(
      topPlayers
        .map((row) => row.discordUserId)
        .filter((discordUserId): discordUserId is string => Boolean(discordUserId)),
    ).size;

    return {
      outcome: "success",
      period: input.period,
      cutoff,
      trackingSince: aggregate.trackingSince,
      evaluatedWarCount: aggregate.evaluatedWarCount,
      affectedWarCount: aggregate.affectedWarCount,
      violationCount: aggregate.violationCount,
      distinctPlayerCount,
      distinctClanCount,
      distinctCurrentDiscordUserCount,
      clanSummaries,
      topPlayers,
      hasCompletedEvaluations: rows.length > 0,
    };
  }

  /** Purpose: build the read-only Discord-user aggregate war-plan report. */
  async getDiscordUserAggregate(input: {
    guildId: string;
    discordUserId: string;
    period: WarPlanViolationHistoryPeriod;
    clanTag?: string | null;
    now?: Date;
  }): Promise<WarPlanViolationHistoryDiscordUserAggregateResult> {
    const guildId = String(input.guildId ?? "").trim();
    const normalizedDiscordUserId = normalizeDiscordUserId(input.discordUserId);
    const normalizedClanTag =
      input.clanTag === undefined || input.clanTag === null || String(input.clanTag).trim() === ""
        ? null
        : normalizeClashTagWithHash(input.clanTag);
    const { cutoff } = resolvePeriodWindow(input);

    if (!normalizedDiscordUserId) {
      return {
        outcome: "invalid_user",
        discordUserId: "",
        period: input.period,
        cutoff,
        clanTag: normalizedClanTag,
        trackingSince: null,
        currentLinkedAccountCount: 0,
        violatingAccountCount: 0,
        violationCount: 0,
        affectedWarCount: 0,
        hasViolationsInPeriod: false,
        accounts: [],
      };
    }

    if (input.clanTag !== undefined && input.clanTag !== null && !normalizedClanTag) {
      return {
        outcome: "invalid_clan",
        discordUserId: normalizedDiscordUserId,
        period: input.period,
        cutoff,
        clanTag: "",
        trackingSince: null,
        currentLinkedAccountCount: 0,
        violatingAccountCount: 0,
        violationCount: 0,
        affectedWarCount: 0,
        hasViolationsInPeriod: false,
        accounts: [],
      };
    }

    if (!guildId) {
      return {
        outcome: "not_found",
        discordUserId: normalizedDiscordUserId,
        period: input.period,
        cutoff,
        clanTag: normalizedClanTag,
        trackingSince: null,
        currentLinkedAccountCount: 0,
        violatingAccountCount: 0,
        violationCount: 0,
        affectedWarCount: 0,
        hasViolationsInPeriod: false,
        accounts: [],
      };
    }

    const currentLinkRows = await this.db.playerLink.findMany({
      where: {
        discordUserId: normalizedDiscordUserId,
        verificationStatus: {
          not: "REVOKED",
        },
      },
      select: {
        playerTag: true,
        discordUserId: true,
        verificationStatus: true,
      },
      orderBy: {
        playerTag: "asc",
      },
    });

    const currentLinkedAccounts = new Map<string, PlayerLinkRow>();
    for (const row of currentLinkRows as Array<{
      playerTag: string;
      discordUserId: string | null;
      verificationStatus: string;
    }>) {
      const normalizedRow = normalizePlayerLinkRow(row);
      if (!normalizedRow.playerTag || !normalizedRow.discordUserId) continue;
      if (!currentLinkedAccounts.has(normalizedRow.playerTag)) {
        currentLinkedAccounts.set(normalizedRow.playerTag, normalizedRow);
      }
    }

    const currentLinkedTags = [...currentLinkedAccounts.keys()];
    if (currentLinkedTags.length === 0) {
      return {
        outcome: "not_found",
        discordUserId: normalizedDiscordUserId,
        period: input.period,
        cutoff,
        clanTag: normalizedClanTag,
        trackingSince: null,
        currentLinkedAccountCount: 0,
        violatingAccountCount: 0,
        violationCount: 0,
        affectedWarCount: 0,
        hasViolationsInPeriod: false,
        accounts: [],
      };
    }

    const [violationRows, identityData] = await Promise.all([
      this.db.warPlanViolation.findMany({
        where: buildDiscordUserAggregateViolationWhere({
          guildId,
          playerTags: currentLinkedTags,
          cutoff,
          clanTag: normalizedClanTag,
        }),
        select: {
          id: true,
          playerTag: true,
          playerNameSnapshot: true,
          townHallLevelSnapshot: true,
          evaluation: {
            select: {
              warHistory: {
                select: {
                  warId: true,
                  clanTag: true,
                  warStartTime: true,
                  warEndTime: true,
                },
              },
            },
          },
        },
      }),
      this.loadPlayerIdentityData(currentLinkedTags),
    ]);

    const orderedRows = [...(violationRows as DiscordUserAggregateViolationRow[])].sort(
      compareDiscordUserAggregateRowsDesc,
    );
    const accountsByTag = new Map<string, DiscordUserAggregatePlayerRow>();
    const affectedWarIds = new Set<number>();
    for (const playerTag of currentLinkedTags) {
      accountsByTag.set(playerTag, {
        playerTag,
        violationCount: 0,
        affectedWarIds: new Set<number>(),
        snapshotFallback: undefined,
      });
    }

    let violationCount = 0;
    let trackingSince: Date | null = null;

    for (const row of orderedRows) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      const account = accountsByTag.get(playerTag);
      if (!account) continue;

      account.violationCount += 1;
      violationCount += 1;
      const warId = row.evaluation.warHistory.warId;
      affectedWarIds.add(warId);
      if (!account.affectedWarIds.has(warId)) {
        account.affectedWarIds.add(warId);
      }

      const rowSnapshot = {
        playerName: normalizeDisplayText(row.playerNameSnapshot),
        townHallLevel: normalizePositiveInteger(row.townHallLevelSnapshot),
      };
      if (!account.snapshotFallback) {
        account.snapshotFallback = rowSnapshot;
      } else if (account.snapshotFallback.townHallLevel === null && rowSnapshot.townHallLevel !== null) {
        account.snapshotFallback = {
          playerName: account.snapshotFallback.playerName,
          townHallLevel: rowSnapshot.townHallLevel,
        };
      }

      const warEndTime = row.evaluation.warHistory.warEndTime;
      if (warEndTime instanceof Date) {
        if (trackingSince === null || warEndTime.getTime() < trackingSince.getTime()) {
          trackingSince = warEndTime;
        }
      }
    }

    const accounts = [...accountsByTag.values()]
      .map((row) => {
        const current = identityData?.currentByTag.get(row.playerTag) ?? null;
        const fwaMemberRows = identityData?.fwaMemberRowsByTag.get(row.playerTag) ?? [];
        const fwaCatalog = identityData?.fwaCatalogByTag.get(row.playerTag) ?? null;
        const todoSnapshot = identityData?.todoSnapshotByTag.get(row.playerTag) ?? null;
        const playerLink = identityData?.playerLinkByTag.get(row.playerTag) ?? null;
        const identity = resolveEnrichedPlayerIdentity({
          playerTag: row.playerTag,
          fallback: row.violationCount > 0 ? row.snapshotFallback : undefined,
          current,
          fwaMemberRows,
          fwaCatalog,
          todoSnapshot,
          playerLink,
        });

        return {
          playerTag: row.playerTag,
          playerName: identity.playerName,
          townHallLevel: identity.townHallLevel,
          discordUserId: identity.discordUserId,
          violationCount: row.violationCount,
          affectedWarCount: row.affectedWarIds.size,
        };
      })
      .sort(sortPlayerSummaries);

    const violatingAccountCount = accounts.filter((row) => row.violationCount > 0).length;

    return {
      outcome: "success",
      discordUserId: normalizedDiscordUserId,
      period: input.period,
      cutoff,
      clanTag: normalizedClanTag,
      trackingSince,
      currentLinkedAccountCount: currentLinkedAccounts.size,
      violatingAccountCount,
      violationCount,
      affectedWarCount: affectedWarIds.size,
      hasViolationsInPeriod: violationCount > 0,
      accounts,
    };
  }

  /** Purpose: count persisted 30-day clan violations for a bounded current-roster tag set. */
  async getClanPlayerViolationCounts(input: {
    guildId: string;
    clanTag: string;
    playerTags: string[];
    period: "30d";
    now?: Date;
  }): Promise<WarPlanViolationHistoryClanPlayerViolationCountsResult> {
    const guildId = String(input.guildId ?? "").trim();
    const clanTag = normalizeClashTagWithHash(input.clanTag);
    const { cutoff } = resolvePeriodWindow(input);
    const playerTags = normalizePlayerTagList(input.playerTags ?? []);
    const playerTagSet = new Set(playerTags);

    if (!guildId || !clanTag || playerTags.length === 0) {
      return {
        period: "30d",
        cutoff: cutoff ?? new Date(),
        clanTag: clanTag ?? "",
        hasCompletedEvaluations: false,
        evaluatedWarCount: 0,
        violationCountByPlayerTag: new Map(),
      };
    }

    const rows = await this.db.warPlanComplianceEvaluation.findMany({
      where: buildCompletedEvaluationWhere({
        guildId,
        cutoff,
        clanTag,
      }),
      select: {
        warId: true,
        violations: {
          where: {
            playerTag: {
              in: playerTags,
            },
          },
          select: {
            playerTag: true,
          },
        },
      },
    });

    const violationCountByPlayerTag = new Map<string, number>();
    for (const row of rows as Array<{
      warId: number;
      violations: Array<{ playerTag: string }>;
    }>) {
      for (const violation of row.violations ?? []) {
        const playerTag = normalizeTag(violation.playerTag);
        if (!playerTag || !playerTagSet.has(playerTag)) continue;
        violationCountByPlayerTag.set(
          playerTag,
          (violationCountByPlayerTag.get(playerTag) ?? 0) + 1,
        );
      }
    }

    return {
      period: "30d",
      cutoff: cutoff ?? new Date(),
      clanTag,
      hasCompletedEvaluations: rows.length > 0,
      evaluatedWarCount: rows.length,
      violationCountByPlayerTag,
    };
  }

  /** Purpose: build bounded autocomplete choices for recorded violators in one guild. */
  async getPlayerAutocompleteChoices(input: {
    guildId: string;
    focusedText?: string | null;
    limit?: number;
  }): Promise<Array<{ name: string; value: string }>> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return [];

    const resultLimit = normalizeAutocompleteLimit(input.limit);
    const query = normalizeAutocompleteQueryText(input.focusedText);
    const tagQuery = normalizeAutocompleteTagQuery(input.focusedText);

    const candidateTags = await this.loadPlayerAutocompleteCandidateTags({
      guildId,
      query,
      tagQuery,
    });
    if (candidateTags.length === 0) return [];

    const [countByTag, snapshotRows, identityData] = await Promise.all([
      this.loadPlayerAutocompleteViolationCounts({
        guildId,
        playerTags: candidateTags,
      }),
      this.loadPlayerAutocompleteSnapshotFallbackRows({
        guildId,
        playerTags: candidateTags,
      }),
      this.loadPlayerIdentityData(candidateTags),
    ]);

    const fallbackByTag = new Map<string, PlayerSnapshotFallback | undefined>();
    for (const row of snapshotRows) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      fallbackByTag.set(playerTag, {
        playerName: normalizeDisplayText(row.playerNameSnapshot),
        townHallLevel: normalizePositiveInteger(row.townHallLevelSnapshot),
      });
    }
    const candidates = candidateTags
      .map((candidateTag) => {
        const violationCount = countByTag.get(candidateTag) ?? 0;
        if (violationCount <= 0) return null;

        const fallback = fallbackByTag.get(candidateTag);
        const current = identityData?.currentByTag.get(candidateTag) ?? null;
        const fwaMemberRows = identityData?.fwaMemberRowsByTag.get(candidateTag) ?? [];
        const fwaCatalog = identityData?.fwaCatalogByTag.get(candidateTag) ?? null;
        const todoSnapshot = identityData?.todoSnapshotByTag.get(candidateTag) ?? null;
        const playerLink = identityData?.playerLinkByTag.get(candidateTag) ?? null;
        const identity = resolveEnrichedPlayerIdentity({
          playerTag: candidateTag,
          fallback,
          current,
          fwaMemberRows,
          fwaCatalog,
          todoSnapshot,
          playerLink,
        });
        const matchRank = classifyPlayerAutocompleteMatch({
          query,
          candidateTag,
          candidateName: identity.playerName,
        });
        if (matchRank === null) return null;

        return {
          playerTag: candidateTag,
          violationCount,
          snapshotFallback: fallback,
          current,
          fwaMemberRows,
          fwaCatalog,
          todoSnapshot,
          playerLink,
          resolvedName: identity.playerName,
          matchRank,
        };
      })
      .filter((candidate): candidate is PlayerAutocompleteCandidate & { matchRank: number } => candidate !== null)
      .sort(comparePlayerAutocompleteCandidates)
      .slice(0, resultLimit);

    return candidates.map((candidate) => ({
      name: buildPlayerAutocompleteChoiceName({
        playerName: candidate.resolvedName,
        playerTag: candidate.playerTag,
        violationCount: candidate.violationCount,
      }),
      value: candidate.playerTag,
    }));
  }

  /** Purpose: discover a bounded set of candidate tags for autocomplete. */
  private async loadPlayerAutocompleteCandidateTags(input: {
    guildId: string;
    query: string;
    tagQuery: string;
  }): Promise<string[]> {
    if (!input.query) {
      return this.loadPlayerAutocompleteTopViolatorTags({
        guildId: input.guildId,
      });
    }

    const [tagRows, snapshotRows, currentRows, catalogRows, todoRows] = await Promise.all([
      this.loadPlayerAutocompleteRecordedTagCandidates({
        guildId: input.guildId,
        tagQuery: input.tagQuery,
      }),
      this.loadPlayerAutocompleteRecordedSnapshotCandidates({
        guildId: input.guildId,
        query: input.query,
      }),
      this.loadPlayerAutocompleteCurrentNameCandidates({
        query: input.query,
      }),
      this.loadPlayerAutocompleteCatalogNameCandidates({
        query: input.query,
      }),
      this.loadPlayerAutocompleteTodoNameCandidates({
        query: input.query,
      }),
    ]);

    return mergePlayerAutocompleteDiscoveryTags([
      tagRows,
      snapshotRows,
      currentRows,
      catalogRows,
      todoRows,
    ]);
  }

  /** Purpose: discover candidate tags from recorded violation player-tag matches. */
  private async loadPlayerAutocompleteRecordedTagCandidates(input: {
    guildId: string;
    tagQuery: string;
  }): Promise<string[]> {
    if (!input.tagQuery) return [];

    const rows = await this.db.$queryRaw<Array<{ playerTag: string }>>(Prisma.sql`
      SELECT DISTINCT ON (v."playerTag")
        v."playerTag" AS "playerTag"
      FROM "WarPlanViolation" v
      INNER JOIN "WarPlanComplianceEvaluation" e
        ON e."id" = v."evaluationId"
      INNER JOIN "ClanWarHistory" h
        ON h."warId" = e."warId"
      WHERE
        e."guildId" = ${input.guildId}
        AND e."status" = 'COMPLETED'::"WarPlanComplianceEvaluationStatus"
        AND LOWER(REPLACE(v."playerTag", '#', '')) LIKE '%' || LOWER(${input.tagQuery}) || '%'
      ORDER BY
        v."playerTag" ASC,
        COALESCE(h."warEndTime", h."warStartTime") DESC,
        h."warId" DESC
      LIMIT ${PLAYER_AUTOCOMPLETE_DISCOVERY_CAP}
    `);

    return (rows as Array<{ playerTag: string }>).map((row) => row.playerTag);
  }

  /** Purpose: discover candidate tags from recorded violation snapshot-name matches. */
  private async loadPlayerAutocompleteRecordedSnapshotCandidates(input: {
    guildId: string;
    query: string;
  }): Promise<string[]> {
    if (!input.query) return [];

    const rows = await this.db.$queryRaw<Array<{ playerTag: string }>>(Prisma.sql`
      SELECT DISTINCT ON (v."playerTag")
        v."playerTag" AS "playerTag"
      FROM "WarPlanViolation" v
      INNER JOIN "WarPlanComplianceEvaluation" e
        ON e."id" = v."evaluationId"
      INNER JOIN "ClanWarHistory" h
        ON h."warId" = e."warId"
      WHERE
        e."guildId" = ${input.guildId}
        AND e."status" = 'COMPLETED'::"WarPlanComplianceEvaluationStatus"
        AND LOWER(v."playerNameSnapshot") LIKE '%' || LOWER(${input.query}) || '%'
      ORDER BY
        v."playerTag" ASC,
        COALESCE(h."warEndTime", h."warStartTime") DESC,
        h."warId" DESC
      LIMIT ${PLAYER_AUTOCOMPLETE_DISCOVERY_CAP}
    `);

    return (rows as Array<{ playerTag: string }>).map((row) => row.playerTag);
  }

  /** Purpose: discover candidate tags from current persisted player-name matches. */
  private async loadPlayerAutocompleteCurrentNameCandidates(input: {
    query: string;
  }): Promise<string[]> {
    const rows = await this.db.playerCurrent.findMany({
      where: {
        playerName: {
          contains: input.query,
          mode: "insensitive",
        },
      },
      orderBy: {
        playerTag: "asc",
      },
      select: {
        playerTag: true,
      },
      take: PLAYER_AUTOCOMPLETE_DISCOVERY_CAP,
    });

    return (rows as Array<{ playerTag: string }>).map((row) => row.playerTag);
  }

  /** Purpose: discover candidate tags from FWA catalog name matches. */
  private async loadPlayerAutocompleteCatalogNameCandidates(input: {
    query: string;
  }): Promise<string[]> {
    const rows = await this.db.fwaPlayerCatalog.findMany({
      where: {
        latestName: {
          contains: input.query,
          mode: "insensitive",
        },
      },
      orderBy: {
        playerTag: "asc",
      },
      select: {
        playerTag: true,
      },
      take: PLAYER_AUTOCOMPLETE_DISCOVERY_CAP,
    });

    return (rows as Array<{ playerTag: string }>).map((row) => row.playerTag);
  }

  /** Purpose: discover candidate tags from todo snapshot name matches. */
  private async loadPlayerAutocompleteTodoNameCandidates(input: {
    query: string;
  }): Promise<string[]> {
    const rows = await this.db.todoPlayerSnapshot.findMany({
      where: {
        playerName: {
          contains: input.query,
          mode: "insensitive",
        },
      },
      orderBy: {
        playerTag: "asc",
      },
      select: {
        playerTag: true,
      },
      take: PLAYER_AUTOCOMPLETE_DISCOVERY_CAP,
    });

    return (rows as Array<{ playerTag: string }>).map((row) => row.playerTag);
  }

  /** Purpose: load the latest canonical violator snapshot rows for a bounded set of autocomplete tags. */
  private async loadPlayerAutocompleteSnapshotFallbackRows(input: {
    guildId: string;
    playerTags: string[];
  }): Promise<PlayerAutocompleteSnapshotFallbackRow[]> {
    const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizeTag(tag)).filter(Boolean))];
    if (normalizedTags.length === 0) return [];

    const candidateTagSql = normalizedTags.map((playerTag) => Prisma.sql`(${playerTag})`);
    return (await this.db.$queryRaw<PlayerAutocompleteSnapshotFallbackRow[]>(Prisma.sql`
      WITH "params" AS (
        SELECT ${input.guildId}::text AS "guildId"
      ),
      "candidate_tags"("playerTag") AS (
        VALUES ${Prisma.join(candidateTagSql)}
      )
      SELECT
        c."playerTag" AS "playerTag",
        name_row."playerNameSnapshot" AS "playerNameSnapshot",
        th_row."townHallLevelSnapshot" AS "townHallLevelSnapshot"
      FROM "candidate_tags" c
      CROSS JOIN "params" p
      LEFT JOIN LATERAL (
        SELECT
          v."playerNameSnapshot"
        FROM "WarPlanViolation" v
        INNER JOIN "WarPlanComplianceEvaluation" e
          ON e."id" = v."evaluationId"
        INNER JOIN "ClanWarHistory" h
          ON h."warId" = e."warId"
        WHERE
          v."playerTag" = c."playerTag"
          AND e."guildId" = p."guildId"
          AND e."status" = 'COMPLETED'::"WarPlanComplianceEvaluationStatus"
        ORDER BY
          COALESCE(h."warEndTime", h."warStartTime") DESC,
          h."warId" DESC
        LIMIT 1
      ) name_row ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          v."townHallLevelSnapshot"
        FROM "WarPlanViolation" v
        INNER JOIN "WarPlanComplianceEvaluation" e
          ON e."id" = v."evaluationId"
        INNER JOIN "ClanWarHistory" h
          ON h."warId" = e."warId"
        WHERE
          v."playerTag" = c."playerTag"
          AND v."townHallLevelSnapshot" > 0
          AND e."guildId" = p."guildId"
          AND e."status" = 'COMPLETED'::"WarPlanComplianceEvaluationStatus"
        ORDER BY
          COALESCE(h."warEndTime", h."warStartTime") DESC,
          h."warId" DESC
        LIMIT 1
      ) th_row ON TRUE
      ORDER BY c."playerTag" ASC
    `)) as PlayerAutocompleteSnapshotFallbackRow[];
  }

  /** Purpose: discover the top violator tags when autocomplete has no focused text. */
  private async loadPlayerAutocompleteTopViolatorTags(input: {
    guildId: string;
  }): Promise<string[]> {
    const rows = await this.db.warPlanViolation.groupBy({
      by: ["playerTag"],
      where: {
        evaluation: {
          is: {
            guildId: input.guildId,
            status: "COMPLETED",
          },
        },
      },
      _count: {
        _all: true,
      },
      orderBy: [
        {
          _count: {
            playerTag: "desc",
          },
        },
        {
          playerTag: "asc",
        },
      ],
      take: PLAYER_AUTOCOMPLETE_DISCOVERY_CAP,
    });

    return (rows as Array<{ playerTag: string }>).map((row) => normalizeTag(row.playerTag)).filter(Boolean);
  }

  /** Purpose: build the read-only war-plan leaderboard for one clan. */
  async getClanLeaderboard(input: {
    guildId: string;
    clanTag: string;
    period: WarPlanViolationHistoryPeriod;
    now?: Date;
  }): Promise<WarPlanViolationHistoryClanLeaderboardResult> {
    const guildId = String(input.guildId ?? "").trim();
    const normalizedClanTag = normalizeClashTagWithHash(input.clanTag);
    const { cutoff } = resolvePeriodWindow(input);
    if (!guildId || !normalizedClanTag) {
      return {
        outcome: "not_found",
        clanTag: normalizedClanTag,
        clanName: null,
        period: input.period,
        cutoff,
        trackingSince: null,
        evaluatedWarCount: 0,
        affectedWarCount: 0,
        violationCount: 0,
        distinctPlayerCount: 0,
        players: [],
        hasCompletedEvaluations: false,
      };
    }

    const identityRow = await this.db.clanWarHistory.findFirst({
      where: {
        clanTag: normalizedClanTag,
        warPlanEvaluations: {
          some: {
            guildId,
            status: "COMPLETED",
          },
        },
      },
      orderBy: [
        { warStartTime: "desc" },
        { warId: "desc" },
      ],
      select: {
        clanTag: true,
        clanName: true,
      },
    });
    if (!identityRow) {
      return {
        outcome: "not_found",
        clanTag: normalizedClanTag,
        clanName: null,
        period: input.period,
        cutoff,
        trackingSince: null,
        evaluatedWarCount: 0,
        affectedWarCount: 0,
        violationCount: 0,
        distinctPlayerCount: 0,
        players: [],
        hasCompletedEvaluations: false,
      };
    }

    const rows = await this.loadCompletedEvaluations({
      guildId,
      cutoff,
      clanTag: normalizedClanTag,
    });
    if (rows.length === 0) {
      return {
        outcome: "success",
        clanTag: normalizedClanTag,
        clanName: normalizeDisplayText(identityRow.clanName) ?? normalizedClanTag,
        period: input.period,
        cutoff,
        trackingSince: null,
        evaluatedWarCount: 0,
        affectedWarCount: 0,
        violationCount: 0,
        distinctPlayerCount: 0,
        players: [],
        hasCompletedEvaluations: false,
      };
    }

    const aggregate = buildHistoryAggregation(rows);
    const clanSummary = aggregate.clans.get(normalizedClanTag);
    const identityData =
      aggregate.players.size > 0
        ? await this.loadPlayerIdentityData([...aggregate.players.keys()])
        : null;
    const players = toPlayerSummaries({
      players: aggregate.players,
      playerFallbacks: aggregate.playerFallbacks,
      identityData,
    });

    return {
      outcome: "success",
      clanTag: normalizedClanTag,
      clanName:
        clanSummary?.clanNameSnapshot ??
        normalizeDisplayText(identityRow.clanName) ??
        normalizedClanTag,
      period: input.period,
      cutoff,
      trackingSince: aggregate.trackingSince,
      evaluatedWarCount: aggregate.evaluatedWarCount,
      affectedWarCount: aggregate.affectedWarCount,
      violationCount: aggregate.violationCount,
      distinctPlayerCount: new Set(players.map((row) => row.playerTag)).size,
      players,
      hasCompletedEvaluations: true,
    };
  }

  /** Purpose: build the read-only player-history report for one player tag. */
  async getPlayerHistory(input: {
    guildId: string;
    playerTag: string;
    period: WarPlanViolationHistoryPeriod;
    now?: Date;
  }): Promise<WarPlanViolationHistoryPlayerHistoryResult> {
    const guildId = String(input.guildId ?? "").trim();
    const normalizedPlayerTag = normalizeClashTagWithHash(input.playerTag);
    const { cutoff } = resolvePeriodWindow(input);
    if (!normalizedPlayerTag) {
      return {
        outcome: "invalid_tag",
        period: input.period,
        cutoff,
        trackingSince: null,
        playerTag: "",
        playerName: null,
        townHallLevel: null,
        discordUserId: null,
        violationCount: 0,
        affectedWarCount: 0,
        hasRecordedViolations: false,
        hasViolationsInPeriod: false,
        entries: [],
      };
    }

    if (!guildId) {
      return {
        outcome: "not_found",
        period: input.period,
        cutoff,
        trackingSince: null,
        playerTag: normalizedPlayerTag,
        playerName: null,
        townHallLevel: null,
        discordUserId: null,
        violationCount: 0,
        affectedWarCount: 0,
        hasRecordedViolations: false,
        hasViolationsInPeriod: false,
        entries: [],
      };
    }

    const periodRows = await this.loadPlayerHistoryRows({
      guildId,
      playerTag: normalizedPlayerTag,
      cutoff,
    });
    if (periodRows.length === 0) {
      const recordedExists = await this.db.warPlanViolation.findFirst({
        where: buildPlayerHistoryViolationWhere({
          guildId,
          playerTag: normalizedPlayerTag,
          cutoff: null,
        }),
        select: {
          id: true,
        },
      });
      if (!recordedExists) {
        return {
          outcome: "not_found",
          period: input.period,
          cutoff,
          trackingSince: null,
          playerTag: normalizedPlayerTag,
          playerName: null,
          townHallLevel: null,
          discordUserId: null,
          violationCount: 0,
          affectedWarCount: 0,
          hasRecordedViolations: false,
          hasViolationsInPeriod: false,
          entries: [],
        };
      }
    }

    const orderedRows = [...periodRows].sort(comparePlayerHistoryRowsDesc);
    const entries = orderedRows.map(toPlayerHistoryEntry);
    const fallback = orderedRows.length > 0 ? buildPlayerHistorySnapshotFallback(orderedRows) : undefined;
    const trackingSince =
      entries.reduce<Date | null>((earliest, entry) => {
        if (!(entry.warEndTime instanceof Date)) return earliest;
        if (earliest === null || entry.warEndTime.getTime() < earliest.getTime()) {
          return entry.warEndTime;
        }
        return earliest;
      }, null) ?? null;
    const affectedWarCount = new Set(entries.map((entry) => entry.warId)).size;
    const identityData = await this.loadPlayerIdentityData([normalizedPlayerTag]);
    const identity = resolveEnrichedPlayerIdentity({
      playerTag: normalizedPlayerTag,
      fallback,
      current: identityData?.currentByTag.get(normalizedPlayerTag) ?? null,
      fwaMemberRows: identityData?.fwaMemberRowsByTag.get(normalizedPlayerTag) ?? [],
      fwaCatalog: identityData?.fwaCatalogByTag.get(normalizedPlayerTag) ?? null,
      todoSnapshot: identityData?.todoSnapshotByTag.get(normalizedPlayerTag) ?? null,
      playerLink: identityData?.playerLinkByTag.get(normalizedPlayerTag) ?? null,
    });

    return {
      outcome: "success",
      period: input.period,
      cutoff,
      trackingSince,
      playerTag: normalizedPlayerTag,
      playerName: identity.playerName,
      townHallLevel: identity.townHallLevel,
      discordUserId: identity.discordUserId,
      violationCount: entries.length,
      affectedWarCount,
      hasRecordedViolations: true,
      hasViolationsInPeriod: periodRows.length > 0,
      entries,
    };
  }

  /** Purpose: bulk-load persisted identity sources for one set of violating player tags. */
  private async loadPlayerIdentityData(playerTags: string[]): Promise<PlayerIdentityData | null> {
    const normalizedTags = [...new Set(playerTags.map((tag) => normalizeTag(tag)).filter(Boolean))];
    if (normalizedTags.length === 0) return null;

    const [
      currentRows,
      fwaMemberRows,
      fwaCatalogRows,
      todoSnapshotRows,
      playerLinkRows,
    ] = await Promise.all([
      this.db.playerCurrent.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          playerName: true,
          townHall: true,
        },
      }),
      this.db.fwaClanMemberCurrent.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          clanTag: true,
          townHall: true,
          sourceSyncedAt: true,
        },
      }),
      this.db.fwaPlayerCatalog.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          latestName: true,
          latestTownHall: true,
        },
      }),
      this.db.todoPlayerSnapshot.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          playerName: true,
          townHall: true,
        },
      }),
      this.db.playerLink.findMany({
        where: { playerTag: { in: normalizedTags } },
        select: {
          playerTag: true,
          discordUserId: true,
          verificationStatus: true,
        },
      }),
    ]);

    const currentByTag = new Map<string, CurrentPlayerRow>();
    for (const row of currentRows as Array<{ playerTag: string; playerName: string | null; townHall: number | null }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      currentByTag.set(playerTag, {
        playerTag,
        playerName: normalizeDisplayText(row.playerName),
        townHall: normalizePositiveInteger(row.townHall),
      });
    }

    const fwaMemberRowsByTag = new Map<string, FwaClanMemberCurrentRow[]>();
    for (const row of fwaMemberRows as Array<{
      playerTag: string;
      clanTag: string;
      townHall: number | null;
      sourceSyncedAt: Date;
    }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      const bucket = fwaMemberRowsByTag.get(playerTag) ?? [];
      bucket.push({
        playerTag,
        clanTag: normalizeTag(row.clanTag),
        townHall: normalizePositiveInteger(row.townHall),
        sourceSyncedAt: row.sourceSyncedAt,
      });
      fwaMemberRowsByTag.set(playerTag, bucket);
    }

    const fwaCatalogByTag = new Map<string, FwaPlayerCatalogRow>();
    for (const row of fwaCatalogRows as Array<{
      playerTag: string;
      latestName: string | null;
      latestTownHall: number | null;
    }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      fwaCatalogByTag.set(playerTag, {
        playerTag,
        latestName: normalizeDisplayText(row.latestName),
        latestTownHall: normalizePositiveInteger(row.latestTownHall),
      });
    }

    const todoSnapshotByTag = new Map<string, TodoPlayerSnapshotRow>();
    for (const row of todoSnapshotRows as Array<{
      playerTag: string;
      playerName: string | null;
      townHall: number | null;
    }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      todoSnapshotByTag.set(playerTag, {
        playerTag,
        playerName: normalizeDisplayText(row.playerName),
        townHall: normalizePositiveInteger(row.townHall),
      });
    }

    const playerLinkByTag = new Map<string, PlayerLinkRow>();
    for (const row of playerLinkRows as Array<{
      playerTag: string;
      discordUserId: string | null;
      verificationStatus: string;
    }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      playerLinkByTag.set(playerTag, {
        playerTag,
        discordUserId: normalizeDiscordUserId(row.discordUserId),
        verificationStatus: String(row.verificationStatus ?? ""),
      });
    }

    return {
      currentByTag,
      fwaMemberRowsByTag,
      fwaCatalogByTag,
      todoSnapshotByTag,
      playerLinkByTag,
    };
  }

  /** Purpose: count completed guild violations for a bounded set of autocomplete candidate tags. */
  private async loadPlayerAutocompleteViolationCounts(input: {
    guildId: string;
    playerTags: string[];
  }): Promise<Map<string, number>> {
    const normalizedTags = [...new Set(input.playerTags.map((tag) => normalizeTag(tag)).filter(Boolean))];
    if (normalizedTags.length === 0) return new Map();

    const rows = await this.db.warPlanViolation.groupBy({
      by: ["playerTag"],
      where: {
        playerTag: {
          in: normalizedTags,
        },
        evaluation: {
          is: {
            guildId: input.guildId,
            status: "COMPLETED",
          },
        },
      },
      _count: {
        _all: true,
      },
    });

    const counts = new Map<string, number>();
    for (const row of rows as Array<{ playerTag: string; _count: { _all: number } }>) {
      const playerTag = normalizeTag(row.playerTag);
      if (!playerTag) continue;
      counts.set(playerTag, row._count._all);
    }
    return counts;
  }

  /** Purpose: bulk-load player-history violation rows for one player and reporting window. */
  private async loadPlayerHistoryRows(input: {
    guildId: string;
    playerTag: string;
    cutoff: Date | null;
  }): Promise<PlayerHistoryEvaluationRow[]> {
    const rows = await this.db.warPlanViolation.findMany({
      where: buildPlayerHistoryViolationWhere(input),
      select: {
        id: true,
        evaluationId: true,
        playerTag: true,
        playerNameSnapshot: true,
        playerPosition: true,
        townHallLevelSnapshot: true,
        violationType: true,
        reasonLabel: true,
        expectedBehavior: true,
        actualBehavior: true,
        breachStarsAt: true,
        breachTimeRemaining: true,
        attackDetails: true,
        evaluation: {
          select: {
            id: true,
            expectedOutcome: true,
            loseStyle: true,
            warHistory: {
              select: {
                warId: true,
                clanTag: true,
                clanName: true,
                opponentTag: true,
                opponentName: true,
                warStartTime: true,
                warEndTime: true,
              },
            },
          },
        },
      },
    });
    return rows as PlayerHistoryEvaluationRow[];
  }

  /** Purpose: load the completed canonical history rows needed for read-only aggregation. */
  private async loadCompletedEvaluations(input: {
    guildId: string;
    cutoff: Date | null;
    clanTag?: string | null;
  }): Promise<CompletedEvaluationRow[]> {
    const where = buildCompletedEvaluationWhere({
      guildId: input.guildId,
      cutoff: input.cutoff,
      clanTag: input.clanTag ?? null,
    });
    const rows = await this.db.warPlanComplianceEvaluation.findMany({
      where,
      select: {
        warId: true,
        warHistory: {
          select: {
            warId: true,
            clanTag: true,
            clanName: true,
            warStartTime: true,
            warEndTime: true,
          },
        },
        violations: {
          select: {
            playerTag: true,
            playerNameSnapshot: true,
            townHallLevelSnapshot: true,
          },
        },
      },
    });
    return rows as CompletedEvaluationRow[];
  }
}
