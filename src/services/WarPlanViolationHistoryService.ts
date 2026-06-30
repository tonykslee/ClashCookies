import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import {
  normalizeClashTagInput,
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

      const snapshotFallback = playerFallbacks.get(playerTag) ?? {
        playerName: null,
        townHallLevel: null,
      };
      const playerName = normalizeDisplayText(violation.playerNameSnapshot);
      const townHallLevel = normalizePositiveInteger(violation.townHallLevelSnapshot);
      if (snapshotFallback.playerName === null && playerName !== null) {
        playerFallbacks.set(playerTag, {
          playerName,
          townHallLevel: snapshotFallback.townHallLevel,
        });
      }
      if (snapshotFallback.townHallLevel === null && townHallLevel !== null) {
        playerFallbacks.set(playerTag, {
          playerName: playerFallbacks.get(playerTag)?.playerName ?? snapshotFallback.playerName,
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
