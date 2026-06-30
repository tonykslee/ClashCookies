import { prisma } from "../prisma";
import { normalizeClashTagInput } from "../helper/clashTag";

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
  status: string;
  warId: number;
  completedAt: Date | null;
  warHistory: {
    warId: number;
    clanTag: string;
    clanName: string | null;
    warEndTime: Date | null;
    warStartTime: Date;
  } | null;
  violations: Array<{
    playerTag: string;
    playerNameSnapshot: string | null;
    townHallLevelSnapshot: number | null;
  }>;
};

type PlayerAggregate = {
  playerTag: string;
  playerNameSnapshot: string;
  townHallLevelSnapshot: number | null;
  violationCount: number;
  affectedWarCount: number;
};

type ClanAggregate = {
  clanTag: string;
  clanName: string;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  distinctPlayerTags: Set<string>;
};

function normalizeDisplayText(input: unknown): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTag(input: string | null | undefined): string {
  return normalizeClashTagInput(input);
}

function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSortTime(row: CompletedEvaluationRow): number {
  const warEndTime = row.warHistory?.warEndTime;
  if (warEndTime instanceof Date) return warEndTime.getTime();
  const completedAt = row.completedAt;
  if (completedAt instanceof Date) return completedAt.getTime();
  return Number.NEGATIVE_INFINITY;
}

function sortPlayerSummaries(a: WarPlanViolationHistoryPlayerSummary, b: WarPlanViolationHistoryPlayerSummary): number {
  if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
  const nameCompare = a.playerNameSnapshot.localeCompare(b.playerNameSnapshot);
  if (nameCompare !== 0) return nameCompare;
  return a.playerTag.localeCompare(b.playerTag);
}

function sortClanSummaries(a: WarPlanViolationHistoryClanSummary, b: WarPlanViolationHistoryClanSummary): number {
  if (b.violationCount !== a.violationCount) return b.violationCount - a.violationCount;
  const nameCompare = a.clanName.localeCompare(b.clanName);
  if (nameCompare !== 0) return nameCompare;
  return a.clanTag.localeCompare(b.clanTag);
}

function buildPlayerSummaries(rows: CompletedEvaluationRow[]): WarPlanViolationHistoryPlayerSummary[] {
  const orderedRows = [...rows].sort((a, b) => {
    const sortTime = resolveSortTime(b) - resolveSortTime(a);
    if (sortTime !== 0) return sortTime;
    return b.warId - a.warId;
  });

  const playerByTag = new Map<string, PlayerAggregate>();

  for (const row of orderedRows) {
    for (const violation of row.violations) {
      const playerTag = normalizeTag(violation.playerTag);
      if (!playerTag) continue;

      const current = playerByTag.get(playerTag);
      const playerNameSnapshot = normalizeDisplayText(violation.playerNameSnapshot) ?? playerTag;
      const townHallLevelSnapshot = normalizePositiveInteger(violation.townHallLevelSnapshot);

      if (!current) {
        playerByTag.set(playerTag, {
          playerTag,
          playerNameSnapshot,
          townHallLevelSnapshot,
          violationCount: 1,
          affectedWarCount: 1,
        });
        continue;
      }

      current.violationCount += 1;
      current.affectedWarCount += 1;
      if (current.townHallLevelSnapshot === null && townHallLevelSnapshot !== null) {
        current.townHallLevelSnapshot = townHallLevelSnapshot;
      }
    }
  }

  return [...playerByTag.values()]
    .map((row) => ({
      playerTag: row.playerTag,
      playerNameSnapshot: row.playerNameSnapshot,
      townHallLevelSnapshot: row.townHallLevelSnapshot,
      violationCount: row.violationCount,
      affectedWarCount: row.affectedWarCount,
    }))
    .sort(sortPlayerSummaries);
}

function buildClanSummaries(rows: CompletedEvaluationRow[]): {
  clanSummaries: WarPlanViolationHistoryClanSummary[];
  trackedClanCount: number;
  topPlayers: WarPlanViolationHistoryPlayerSummary[];
  trackingSince: Date | null;
  evaluatedWarCount: number;
  affectedWarCount: number;
  violationCount: number;
  hasCompletedEvaluations: boolean;
  allClanAggregates: Map<string, ClanAggregate>;
} {
  const orderedRows = [...rows].sort((a, b) => {
    const sortTime = resolveSortTime(b) - resolveSortTime(a);
    if (sortTime !== 0) return sortTime;
    return b.warId - a.warId;
  });

  const clanByTag = new Map<string, ClanAggregate>();
  let evaluatedWarCount = 0;
  let affectedWarCount = 0;
  let violationCount = 0;
  let trackingSince: Date | null = null;

  for (const row of orderedRows) {
    evaluatedWarCount += 1;
    if (row.violations.length > 0) affectedWarCount += 1;

    const warEndTime = row.warHistory?.warEndTime ?? null;
    if (warEndTime instanceof Date) {
      if (trackingSince === null || warEndTime.getTime() < trackingSince.getTime()) {
        trackingSince = warEndTime;
      }
    }

    const clanTag = normalizeTag(row.warHistory?.clanTag ?? "");
    if (clanTag) {
      const currentClan = clanByTag.get(clanTag);
      const clanName = normalizeDisplayText(row.warHistory?.clanName) ?? clanTag;
      if (!currentClan) {
        clanByTag.set(clanTag, {
          clanTag,
          clanName,
          evaluatedWarCount: 1,
          affectedWarCount: row.violations.length > 0 ? 1 : 0,
          violationCount: row.violations.length,
          distinctPlayerTags: new Set(
            row.violations.map((violation) => normalizeTag(violation.playerTag)).filter(Boolean),
          ),
        });
      } else {
        currentClan.evaluatedWarCount += 1;
        currentClan.affectedWarCount += row.violations.length > 0 ? 1 : 0;
        currentClan.violationCount += row.violations.length;
        for (const violation of row.violations) {
          const playerTag = normalizeTag(violation.playerTag);
          if (playerTag) {
            currentClan.distinctPlayerTags.add(playerTag);
          }
        }
      }
    }

    for (const violation of row.violations) {
      const playerTag = normalizeTag(violation.playerTag);
      if (!playerTag) continue;

      violationCount += 1;
    }
  }

  return {
    clanSummaries: [...clanByTag.values()]
      .map((row) => ({
        clanTag: row.clanTag,
        clanName: row.clanName,
        evaluatedWarCount: row.evaluatedWarCount,
        affectedWarCount: row.affectedWarCount,
        violationCount: row.violationCount,
        distinctPlayerCount: row.distinctPlayerTags.size,
      }))
      .filter((row) => row.violationCount > 0)
      .sort(sortClanSummaries),
    trackedClanCount: clanByTag.size,
    topPlayers: buildPlayerSummaries(rows),
    trackingSince,
    evaluatedWarCount,
    affectedWarCount,
    violationCount,
    hasCompletedEvaluations: orderedRows.length > 0,
    allClanAggregates: clanByTag,
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
    const rows = await this.loadCompletedEvaluations({
      guildId: input.guildId,
      period: input.period,
      now: input.now,
    });

    const aggregate = buildClanSummaries(rows);
    const cutoff = input.period === "30d" ? new Date((input.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000) : null;

    return {
      outcome: "success",
      period: input.period,
      cutoff,
      trackingSince: aggregate.trackingSince,
      evaluatedWarCount: aggregate.evaluatedWarCount,
      affectedWarCount: aggregate.affectedWarCount,
      violationCount: aggregate.violationCount,
      distinctPlayerCount: new Set(aggregate.topPlayers.map((row) => row.playerTag)).size,
      distinctClanCount: aggregate.clanSummaries.length,
      clanSummaries: aggregate.clanSummaries,
      topPlayers: aggregate.topPlayers,
      hasCompletedEvaluations: aggregate.hasCompletedEvaluations,
    };
  }

  /** Purpose: build the read-only war-plan leaderboard for one clan. */
  async getClanLeaderboard(input: {
    guildId: string;
    clanTag: string;
    period: WarPlanViolationHistoryPeriod;
    now?: Date;
  }): Promise<WarPlanViolationHistoryClanLeaderboardResult> {
    const normalizedClanTag = normalizeTag(input.clanTag);
    if (!normalizedClanTag) {
      return {
        outcome: "not_found",
        clanTag: "",
        clanName: null,
        period: input.period,
        cutoff: input.period === "30d" ? new Date((input.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000) : null,
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
      guildId: input.guildId,
      period: input.period,
      now: input.now,
    });

    const clanRows = rows.filter((row) => normalizeTag(row.warHistory?.clanTag ?? "") === normalizedClanTag);
    if (clanRows.length === 0) {
      return {
        outcome: "not_found",
        clanTag: normalizedClanTag,
        clanName: null,
        period: input.period,
        cutoff: input.period === "30d" ? new Date((input.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000) : null,
        trackingSince: null,
        evaluatedWarCount: 0,
        affectedWarCount: 0,
        violationCount: 0,
        distinctPlayerCount: 0,
        players: [],
        hasCompletedEvaluations: false,
      };
    }

    const aggregate = buildClanSummaries(clanRows);
    const firstClan = aggregate.allClanAggregates.get(normalizedClanTag);
    const cutoff = input.period === "30d" ? new Date((input.now ?? new Date()).getTime() - 30 * 24 * 60 * 60 * 1000) : null;

    return {
      outcome: "success",
      clanTag: normalizedClanTag,
      clanName: firstClan?.clanName ?? normalizedClanTag,
      period: input.period,
      cutoff,
      trackingSince: aggregate.trackingSince,
      evaluatedWarCount: aggregate.evaluatedWarCount,
      affectedWarCount: aggregate.affectedWarCount,
      violationCount: aggregate.violationCount,
      distinctPlayerCount: new Set(aggregate.topPlayers.map((row) => row.playerTag)).size,
      players: aggregate.topPlayers,
      hasCompletedEvaluations: aggregate.hasCompletedEvaluations,
    };
  }

  /** Purpose: load completed evaluations with the canonical history and violation snapshots needed for aggregation. */
  private async loadCompletedEvaluations(input: {
    guildId: string;
    period: WarPlanViolationHistoryPeriod;
    now?: Date;
  }): Promise<CompletedEvaluationRow[]> {
    const guildId = String(input.guildId ?? "").trim();
    if (!guildId) return [];

    const now = input.now ?? new Date();
    const cutoff = input.period === "30d" ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : null;

    const rows = (await this.db.warPlanComplianceEvaluation.findMany({
      where: {
        guildId,
        status: "COMPLETED",
      },
      select: {
        warId: true,
        status: true,
        completedAt: true,
        warHistory: {
          select: {
            warId: true,
            clanTag: true,
            clanName: true,
            warEndTime: true,
            warStartTime: true,
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
    })) as CompletedEvaluationRow[];

    return rows.filter((row) => {
      if (!row || row.status !== "COMPLETED") return false;
      if (!row.warHistory) return false;
      if (input.period === "30d") {
        if (!(row.warHistory.warEndTime instanceof Date)) return false;
        if (!cutoff) return false;
        return row.warHistory.warEndTime.getTime() >= cutoff.getTime();
      }
      return true;
    });
  }
}
