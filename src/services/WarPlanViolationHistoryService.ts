import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  normalizeClashTagInput,
  normalizeClashTagWithHash,
} from "../helper/clashTag";

export type WarPlanViolationHistoryPeriod = "30d" | "lifetime";

export type WarPlanViolationHistoryPlayerSummary = {
  playerTag: string;
  playerNameSnapshot: string;
  townHallLevelSnapshot: number | null;
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

type AggregatedPlayerRow = {
  playerTag: string;
  playerNameSnapshot: string;
  townHallLevelSnapshot: number | null;
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
  const nameCompare = a.playerNameSnapshot.localeCompare(b.playerNameSnapshot);
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

      const player = players.get(playerTag);
      const playerNameSnapshot = normalizeDisplayText(violation.playerNameSnapshot) ?? playerTag;
      const townHallLevelSnapshot = normalizePositiveInteger(violation.townHallLevelSnapshot);

      if (!player) {
        players.set(playerTag, {
          playerTag,
          playerNameSnapshot,
          townHallLevelSnapshot,
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
      if (player.townHallLevelSnapshot === null && townHallLevelSnapshot !== null) {
        player.townHallLevelSnapshot = townHallLevelSnapshot;
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
  };
}

/** Purpose: convert aggregated player state into the public summary shape. */
function toPlayerSummaries(
  players: Map<string, AggregatedPlayerRow>,
): WarPlanViolationHistoryPlayerSummary[] {
  return [...players.values()]
    .map((row) => ({
      playerTag: row.playerTag,
      playerNameSnapshot: row.playerNameSnapshot,
      townHallLevelSnapshot: row.townHallLevelSnapshot,
      violationCount: row.violationCount,
      affectedWarCount: row.affectedWarIds.size,
    }))
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
    const topPlayers = toPlayerSummaries(aggregate.players);
    const distinctClanCount = new Set(
      rows.flatMap((row) => {
        const clanTag = normalizeTag(row.warHistory?.clanTag ?? "");
        return clanTag ? [clanTag] : [];
      }),
    ).size;
    const distinctPlayerCount = new Set(topPlayers.map((row) => row.playerTag)).size;

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
      clanSummaries,
      topPlayers,
      hasCompletedEvaluations: rows.length > 0,
    };
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
      where: { clanTag: normalizedClanTag },
      orderBy: [
        { warEndTime: "desc" },
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
    const players = toPlayerSummaries(aggregate.players);

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
