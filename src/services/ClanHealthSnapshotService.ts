import type { TrackedClan } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeClashTagInput } from "../helper/clashTag";
import { normalizeDiscordUserId } from "./PlayerLinkService";
import {
  readExternalClanCurrentComposition,
  readTrackedClanCurrentComposition,
  type CompoActualStateTrackedClanComposition,
  type CompoActualStateExternalClanComposition,
} from "./CompoActualStateService";
import {
  WarPlanViolationHistoryService,
  type WarPlanViolationHistoryClanLeaderboardBoundedResult,
} from "./WarPlanViolationHistoryService";
import {
  ClanHealthHistoricalWindowService,
  type ClanHealthHistoricalWindow,
} from "./ClanHealthHistoricalWindowService";
import { FwaClanWarsSyncService } from "./fwa-feeds/FwaClanWarsSyncService";
import { FwaFeedSyncStateService } from "./fwa-feeds/FwaFeedSyncStateService";
import { classifyOpponentInfo } from "./fwa-feeds/FwaClanMatchStatsCurrentSyncService";

const EXTERNAL_WAR_REFRESH_MINIMUM_INTERVAL_MS = 15 * 60 * 1000;
const EXTERNAL_WAR_FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;
const EXTERNAL_WAR_SAMPLE_LIMIT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CLAN_HEALTH_DEFAULT_WINDOW_DAYS = 30;
export const CLAN_HEALTH_MIN_WINDOW_DAYS = 7;
export const CLAN_HEALTH_MAX_WINDOW_DAYS = 180;

type ClanHealthSnapshotTelemetry = {
  warRows: number;
  recognizedWarRows: number | null;
  participationRows?: number;
  activityRows?: number;
  linkRows?: number;
  compositionMemberCount: number | null;
  compositionUnresolvedCount: number | null;
  compositionComplete: boolean | null;
  compositionSelectedHeatMapRefAvailable: boolean;
  compositionDeviationScore: number | null;
  compositionSourceAgeMs: number | null;
  warSourceAgeMs: number | null;
  refreshAttempted: boolean;
  refreshStatus: "not_needed" | "success" | "noop" | "skipped" | "failed";
  staleFallbackUsed: boolean;
  durationMs: number;
};

export type ClanHealthTrackedSnapshot = {
  viewType: "tracked";
  clanTag: string;
  clanName: string;
  historicalWindow: ClanHealthHistoricalWindow;
  composition: CompoActualStateTrackedClanComposition;
  warPlanCompliance: {
    hasCompletedEvaluations: boolean;
    evaluatedWarCount: number;
    affectedWarCount: number;
    violationCount: number;
    distinctPlayerCount: number;
    distinctCurrentDiscordUserCount: number;
  };
  warMetrics: {
    endedWarSampleSize: number;
    fwaMatchCount: number;
    fwaWinCount: number;
    fwaLossCount: number;
    blMatchCount: number;
    mmMatchCount: number;
    blInclusiveMatchCount: number;
    winCount: number;
  };
  inactiveWars: {
    warsAvailable: number;
    warsSampled: number;
    inactivePlayerCount: number;
  };
  inactiveDays: {
    thresholdDays: number;
    staleHours: number;
    observedMemberCount: number;
    inactivePlayerCount: number;
  };
  missingLinks: {
    observedMemberCount: number;
    linkedMemberCount: number;
    missingMemberCount: number;
  };
  telemetry: ClanHealthSnapshotTelemetry;
};

export type ClanHealthExternalWarPerformance = {
  windowSize: number;
  endedWarSampleSize: number;
  recognizedWarRows: number;
  fwaMatchCount: number;
  fwaWinCount: number;
  fwaLossCount: number;
  blMatchCount: number;
  mmMatchCount: number;
  blInclusiveMatchCount: number;
  winCount: number;
  sourceSyncedAt: Date | null;
  sourceAgeMs: number | null;
  refreshAttempted: boolean;
  refreshStatus: ClanHealthSnapshotTelemetry["refreshStatus"];
  staleFallbackUsed: boolean;
};

export type ClanHealthExternalSnapshot = {
  viewType: "external";
  clanTag: string;
  clanName: string;
  composition: CompoActualStateExternalClanComposition;
  warPerformance: ClanHealthExternalWarPerformance | null;
  telemetry: ClanHealthSnapshotTelemetry;
};

export type ClanHealthSnapshot = ClanHealthTrackedSnapshot | ClanHealthExternalSnapshot;

type WarHistoryMetricRow = {
  warId: number | string | null;
  matchType: string | null;
  actualOutcome: string | null;
};

type ParticipationMetricRow = {
  playerTag: string;
  missedBoth: boolean;
};

type ActivityMetricRow = {
  tag: string;
  lastSeenAt: Date;
};

const DEFAULT_INACTIVE_DAYS_THRESHOLD = 6;
const DEFAULT_INACTIVE_STALE_HOURS = 6;

/** Purpose: normalize an explicitly supplied Discord/runtime day window into the supported range. */
export function normalizeClanHealthWindowDays(input: unknown): number {
  if (input === null || input === undefined || String(input).trim() === "") {
    throw new Error("Clan Health day window is only valid when explicitly supplied.");
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return CLAN_HEALTH_DEFAULT_WINDOW_DAYS;
  return Math.min(
    CLAN_HEALTH_MAX_WINDOW_DAYS,
    Math.max(CLAN_HEALTH_MIN_WINDOW_DAYS, Math.trunc(parsed)),
  );
}

/** Purpose: derive the shared historical cutoff used by tracked Clan Health metrics. */
export function buildClanHealthHistoricalCutoff(now: Date, windowDays: number): Date {
  return new Date(now.getTime() - windowDays * DAY_MS);
}

/** Purpose: keep testable time overrides valid without weakening the production clock contract. */
function resolveSnapshotNow(input: Date | undefined): Date {
  return input instanceof Date && Number.isFinite(input.getTime()) ? input : new Date();
}

/** Purpose: normalize clan tags into canonical uppercase + leading-# format. */
function normalizeClanTag(input: string): string {
  return normalizeClashTagInput(input);
}

/** Purpose: derive ended-war rate metrics from the selected historical day window. */
function computeWarMetrics(rows: WarHistoryMetricRow[]) {
  const endedWarSampleSize = rows.length;
  const fwaRows = rows.filter((row) => String(row.matchType ?? "").toUpperCase() === "FWA");
  const fwaMatchCount = fwaRows.length;
  const fwaWinCount = fwaRows.filter((row) => String(row.actualOutcome ?? "").toUpperCase() === "WIN").length;
  const fwaLossCount = fwaRows.filter((row) => String(row.actualOutcome ?? "").toUpperCase() === "LOSE").length;
  const blMatchCount = rows.filter((row) => String(row.matchType ?? "").toUpperCase() === "BL").length;
  const mmMatchCount = rows.filter((row) => String(row.matchType ?? "").toUpperCase() === "MM").length;
  const blInclusiveMatchCount = fwaMatchCount + blMatchCount;
  const winCount = rows.filter((row) => String(row.actualOutcome ?? "").toUpperCase() === "WIN").length;
  return {
    endedWarSampleSize,
    fwaMatchCount,
    fwaWinCount,
    fwaLossCount,
    blMatchCount,
    mmMatchCount,
    blInclusiveMatchCount,
    winCount,
  };
}

/** Purpose: count players with at least one missed-both war in the selected recent window. */
function computeInactiveWarsPlayerCount(rows: ParticipationMetricRow[]): number {
  const missedByPlayer = new Map<string, boolean>();
  for (const row of rows) {
    const tag = String(row.playerTag ?? "").trim().toUpperCase();
    if (!tag) continue;
    if (row.missedBoth) missedByPlayer.set(tag, true);
    else if (!missedByPlayer.has(tag)) missedByPlayer.set(tag, false);
  }
  let total = 0;
  for (const missed of missedByPlayer.values()) {
    if (missed) total += 1;
  }
  return total;
}

/** Purpose: compute inactivity and link counts from observed member rows and linked tags. */
function computeActivityAndLinkMetrics(input: {
  rows: ActivityMetricRow[];
  linkedTags: Set<string>;
  inactiveCutoff: Date;
  thresholdDays: number;
  staleHours: number;
}) {
  const uniqueRowsByTag = new Map<string, ActivityMetricRow>();
  for (const row of input.rows) {
    const normalizedTag = String(row.tag ?? "").trim().toUpperCase();
    if (!normalizedTag) continue;
    uniqueRowsByTag.set(normalizedTag, row);
  }

  let inactivePlayerCount = 0;
  let linkedMemberCount = 0;
  for (const [tag, row] of uniqueRowsByTag.entries()) {
    if (row.lastSeenAt.getTime() < input.inactiveCutoff.getTime()) inactivePlayerCount += 1;
    if (input.linkedTags.has(tag)) linkedMemberCount += 1;
  }

  const observedMemberCount = uniqueRowsByTag.size;
  const missingMemberCount = Math.max(0, observedMemberCount - linkedMemberCount);
  return {
    inactiveDays: {
      thresholdDays: input.thresholdDays,
      staleHours: input.staleHours,
      observedMemberCount,
      inactivePlayerCount,
    },
    missingLinks: {
      observedMemberCount,
      linkedMemberCount,
      missingMemberCount,
    },
  };
}

function getLatestValidDate(...candidates: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const candidate of candidates) {
    if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) continue;
    if (!latest || candidate.getTime() > latest.getTime()) {
      latest = candidate;
    }
  }
  return latest;
}

export const computeWarMetricsForTest = computeWarMetrics;
export const computeInactiveWarsPlayerCountForTest = computeInactiveWarsPlayerCount;
export const computeActivityAndLinkMetricsForTest = computeActivityAndLinkMetrics;

export class ClanHealthSnapshotService {
  /** Purpose: initialize the snapshot service with explicit persisted-history dependencies. */
  constructor(
    private readonly db = prisma,
    private readonly compoActualStateService: {
      readTrackedClanCurrentComposition: typeof readTrackedClanCurrentComposition;
      readExternalClanCurrentComposition: typeof readExternalClanCurrentComposition;
    } = {
      readTrackedClanCurrentComposition,
      readExternalClanCurrentComposition,
    },
    private readonly warPlanViolationHistoryService: Pick<
      WarPlanViolationHistoryService,
      "getClanLeaderboardForCutoff" | "getClanLeaderboardForSyncNumbers"
    > = new WarPlanViolationHistoryService(),
    private readonly feedSyncStateService: Pick<FwaFeedSyncStateService, "getState"> = new FwaFeedSyncStateService(),
    private readonly clanWarsSyncService: Pick<FwaClanWarsSyncService, "syncClan"> = new FwaClanWarsSyncService(),
    private readonly historicalWindowService: ClanHealthHistoricalWindowService = new ClanHealthHistoricalWindowService()
  ) {}

  /** Purpose: load a single-clan leadership snapshot from persisted DB state only. */
  async getSnapshot(input: {
    guildId: string;
    clanTag: string;
    historicalWindowDays?: number;
    inactiveDaysThreshold?: number;
    inactiveStaleHours?: number;
    now?: Date;
  }): Promise<ClanHealthSnapshot | null> {
    const normalizedTag = normalizeClanTag(input.clanTag);
    if (!normalizedTag) return null;

    const trackedClan = await this.db.trackedClan.findFirst({
      where: { tag: { equals: normalizedTag, mode: "insensitive" } },
      select: { tag: true, name: true, shortName: true },
    });
    if (trackedClan) {
      const now = resolveSnapshotNow(input.now);
      const historicalWindow: ClanHealthHistoricalWindow = input.historicalWindowDays === undefined
        ? await this.historicalWindowService.resolveLatestSyncWindow({
            guildId: input.guildId,
            now,
          })
        : (() => {
            const days = normalizeClanHealthWindowDays(input.historicalWindowDays);
            return {
              kind: "days" as const,
              days,
              cutoff: buildClanHealthHistoricalCutoff(now, days),
            };
          })();
      return this.buildTrackedSnapshot({
        guildId: input.guildId,
        trackedClan,
        historicalWindow,
        inactiveDaysThreshold: Math.max(
          1,
          Math.trunc(input.inactiveDaysThreshold ?? DEFAULT_INACTIVE_DAYS_THRESHOLD),
        ),
        inactiveStaleHours: Math.max(
          1,
          Math.trunc(
            input.inactiveStaleHours ??
              Number(process.env.INACTIVE_STALE_HOURS ?? DEFAULT_INACTIVE_STALE_HOURS),
          ),
        ),
        now,
      });
    }

    const catalogClan = await this.db.fwaClanCatalog.findFirst({
      where: { clanTag: { equals: normalizedTag, mode: "insensitive" } },
      select: { clanTag: true, name: true },
    });
    if (!catalogClan) return null;

    return this.buildExternalSnapshot({
      clanTag: normalizedTag,
      clanName: String(catalogClan.name ?? "").trim() || normalizedTag,
      guildId: input.guildId,
    });
  }

  private async buildTrackedSnapshot(input: {
    guildId: string;
    trackedClan: Pick<TrackedClan, "tag" | "name"> & { shortName?: string | null };
    historicalWindow: ClanHealthHistoricalWindow;
    inactiveDaysThreshold: number;
    inactiveStaleHours: number;
    now: Date;
  }): Promise<ClanHealthTrackedSnapshot | null> {
    const startedAtMs = Date.now();
    const canonicalClanTag = normalizeClanTag(input.trackedClan.tag);
    const canonicalClanName = String(input.trackedClan.name ?? "").trim() || canonicalClanTag;
    const staleCutoff = new Date(input.now.getTime() - input.inactiveStaleHours * 60 * 60 * 1000);
    const inactiveCutoff = new Date(input.now.getTime() - input.inactiveDaysThreshold * DAY_MS);
    const compositionNow = input.now;
    const compositionPromise = this.compoActualStateService.readTrackedClanCurrentComposition({
      guildId: input.guildId,
      trackedClan: input.trackedClan,
      now: compositionNow,
    });

    const [warRows, activityRows, warPlanLeaderboard, composition] = await Promise.all([
      this.db.clanWarHistory.findMany({
        where: {
          clanTag: canonicalClanTag,
          ...(input.historicalWindow.kind === "syncs"
            ? {
                syncNumber: { in: input.historicalWindow.syncNumbers },
                warEndTime: { not: null },
              }
            : { warEndTime: { gte: input.historicalWindow.cutoff } }),
        },
        orderBy: [{ warEndTime: "desc" }, { warStartTime: "desc" }],
        select: { warId: true, matchType: true, actualOutcome: true },
      }),
      this.db.playerActivity.findMany({
        where: {
          guildId: input.guildId,
          clanTag: canonicalClanTag,
          updatedAt: { gte: staleCutoff },
        },
        select: { tag: true, lastSeenAt: true },
      }),
      input.historicalWindow.kind === "syncs"
        ? this.warPlanViolationHistoryService.getClanLeaderboardForSyncNumbers({
            guildId: input.guildId,
            clanTag: canonicalClanTag,
            syncNumbers: input.historicalWindow.syncNumbers,
          })
        : this.warPlanViolationHistoryService.getClanLeaderboardForCutoff({
            guildId: input.guildId,
            clanTag: canonicalClanTag,
            cutoff: input.historicalWindow.cutoff,
          }),
      compositionPromise,
    ]);
    if (!composition) {
      return null;
    }

    const eligibleFwaWarIds = [
      ...new Set(
        warRows
          .filter((row) => String(row.matchType ?? "").toUpperCase() === "FWA")
          .map((row) => String(row.warId ?? "").trim()),
      ),
    ]
      .filter((warId) => warId.length > 0);

    const [participationRows, linkedRows] = await Promise.all([
      eligibleFwaWarIds.length > 0
        ? this.db.clanWarParticipation.findMany({
            where: {
              guildId: input.guildId,
              clanTag: canonicalClanTag,
              matchType: "FWA",
              warId: { in: eligibleFwaWarIds },
            },
            select: { playerTag: true, missedBoth: true },
          })
        : Promise.resolve([] as ParticipationMetricRow[]),
      activityRows.length > 0
        ? this.db.playerLink.findMany({
            where: {
              playerTag: { in: activityRows.map((row) => row.tag) },
              discordUserId: { not: null },
            },
            select: { playerTag: true },
          })
        : Promise.resolve([] as Array<{ playerTag: string }>),
    ]);

    const linkedTags = new Set(
      linkedRows
        .map((row) => String(row.playerTag ?? "").trim().toUpperCase())
        .filter((tag) => tag.length > 0),
    );
    const activityAndLinks = computeActivityAndLinkMetrics({
      rows: activityRows,
      linkedTags,
      inactiveCutoff,
      thresholdDays: input.inactiveDaysThreshold,
      staleHours: input.inactiveStaleHours,
    });
    const warMetrics = computeWarMetrics(warRows);
    const inactivePlayerCount = computeInactiveWarsPlayerCount(participationRows);
    const durationMs = Date.now() - startedAtMs;
    const warPlanCompliance = buildWarPlanComplianceSummary(warPlanLeaderboard);
    const warSourceAgeMs = null;

    this.logClanHealthSnapshot({
      guildId: input.guildId,
      clanTag: canonicalClanTag,
      viewType: "tracked",
      historicalWindow: input.historicalWindow,
      warRows: warRows.length,
      recognizedWarRows: warRows.length,
      complianceEvaluatedWarCount: warPlanCompliance.evaluatedWarCount,
      complianceAffectedWarCount: warPlanCompliance.affectedWarCount,
      complianceViolationCount: warPlanCompliance.violationCount,
      compliancePlayerCount: warPlanCompliance.distinctPlayerCount,
      complianceDiscordUserCount: warPlanCompliance.distinctCurrentDiscordUserCount,
      compositionMemberCount: composition.memberCount,
      compositionUnresolvedCount: composition.unresolvedWeightCount,
      compositionComplete: composition.unresolvedWeightCount === 0,
      compositionSelectedHeatMapRefAvailable: composition.selectedHeatMapRefAvailable,
      compositionDeviationScore: composition.deviationScore,
      compositionSourceAgeMs: composition.sourceAgeMs,
      warSourceAgeMs,
      refreshAttempted: false,
      refreshStatus: "not_needed",
      staleFallbackUsed: false,
      durationMs,
    });

    return {
      viewType: "tracked",
      clanTag: canonicalClanTag,
      clanName: canonicalClanName,
      historicalWindow: input.historicalWindow,
      composition,
      warPlanCompliance,
      warMetrics,
      inactiveWars: {
        warsAvailable: eligibleFwaWarIds.length,
        warsSampled: eligibleFwaWarIds.length,
        inactivePlayerCount,
      },
      inactiveDays: activityAndLinks.inactiveDays,
      missingLinks: activityAndLinks.missingLinks,
      telemetry: {
        warRows: warRows.length,
        recognizedWarRows: warRows.length,
        participationRows: participationRows.length,
        activityRows: activityRows.length,
        linkRows: linkedRows.length,
        compositionMemberCount: composition.memberCount,
        compositionUnresolvedCount: composition.unresolvedWeightCount,
        compositionComplete: composition.unresolvedWeightCount === 0,
        compositionSelectedHeatMapRefAvailable: composition.selectedHeatMapRefAvailable,
        compositionDeviationScore: composition.deviationScore,
        compositionSourceAgeMs: composition.sourceAgeMs,
        warSourceAgeMs,
        refreshAttempted: false,
        refreshStatus: "not_needed",
        staleFallbackUsed: false,
        durationMs,
      },
    };
  }

  private async buildExternalSnapshot(input: {
    clanTag: string;
    clanName: string;
    guildId: string;
  }): Promise<ClanHealthExternalSnapshot | null> {
    const startedAtMs = Date.now();
    const now = new Date();
    const composition = await this.compoActualStateService.readExternalClanCurrentComposition({
      clanTag: input.clanTag,
      now,
    });
    if (!composition) {
      return null;
    }

    const warState = await this.loadExternalWarPerformance({
      clanTag: input.clanTag,
      now,
    });
    const durationMs = Date.now() - startedAtMs;
    this.logClanHealthSnapshot({
      guildId: input.guildId,
      clanTag: input.clanTag,
      viewType: "external",
      warRows: warState.telemetry.warRows,
      recognizedWarRows: warState.telemetry.recognizedWarRows,
      compositionMemberCount: composition.memberCount,
      compositionUnresolvedCount: composition.unresolvedWeightCount,
      compositionComplete: composition.compositionComplete,
      compositionSelectedHeatMapRefAvailable: composition.selectedHeatMapRefAvailable,
      compositionDeviationScore: composition.deviationScore,
      compositionSourceAgeMs: composition.sourceAgeMs,
      warSourceAgeMs: warState.telemetry.warSourceAgeMs,
      refreshAttempted: warState.telemetry.refreshAttempted,
      refreshStatus: warState.telemetry.refreshStatus,
      staleFallbackUsed: warState.telemetry.staleFallbackUsed,
      durationMs,
    });

    return {
      viewType: "external",
      clanTag: input.clanTag,
      clanName: input.clanName,
      composition,
      warPerformance: warState.warPerformance,
      telemetry: {
        warRows: warState.telemetry.warRows,
        recognizedWarRows: warState.telemetry.recognizedWarRows,
        compositionMemberCount: composition.memberCount,
        compositionUnresolvedCount: composition.unresolvedWeightCount,
        compositionComplete: composition.compositionComplete,
        compositionSelectedHeatMapRefAvailable: composition.selectedHeatMapRefAvailable,
        compositionDeviationScore: composition.deviationScore,
        compositionSourceAgeMs: composition.sourceAgeMs,
        warSourceAgeMs: warState.telemetry.warSourceAgeMs,
        refreshAttempted: warState.telemetry.refreshAttempted,
        refreshStatus: warState.telemetry.refreshStatus,
        staleFallbackUsed: warState.telemetry.staleFallbackUsed,
        durationMs,
      },
    };
  }

  private async loadExternalWarPerformance(input: {
    clanTag: string;
    now: Date;
  }): Promise<{
    warPerformance: ClanHealthExternalWarPerformance | null;
    telemetry: {
      warRows: number;
      recognizedWarRows: number;
      warSourceAgeMs: number | null;
      refreshAttempted: boolean;
      refreshStatus: ClanHealthSnapshotTelemetry["refreshStatus"];
      staleFallbackUsed: boolean;
      };
  }> {
    const loadRows = async () =>
      this.db.fwaClanWarLogCurrent.findMany({
        where: { clanTag: { equals: input.clanTag, mode: "insensitive" } },
        orderBy: [{ endTime: "desc" }, { sourceSyncedAt: "desc" }, { opponentTag: "asc" }],
        take: 100,
        select: {
          endTime: true,
          result: true,
          opponentInfo: true,
          sourceSyncedAt: true,
        },
      });
    const loadSyncState = async () =>
      this.feedSyncStateService.getState({
        feedType: "CLAN_WARS",
        scopeType: "CLAN_TAG",
        scopeKey: input.clanTag,
      });

    const getNewestSourceSyncedAt = (rows: readonly { sourceSyncedAt: Date | null }[]) =>
      rows.reduce<Date | null>((latest, row) => {
        if (!row.sourceSyncedAt) return latest;
        if (!latest || row.sourceSyncedAt.getTime() > latest.getTime()) {
          return row.sourceSyncedAt;
        }
        return latest;
      }, null);
    const getEffectiveVerificationAt = (
      rows: readonly { sourceSyncedAt: Date | null }[],
      lastSuccessAt: Date | null | undefined,
    ) => getLatestValidDate(getNewestSourceSyncedAt(rows), lastSuccessAt ?? null);

    let rows = await loadRows();
    let syncState = await loadSyncState();
    let effectiveVerificationAt = getEffectiveVerificationAt(rows, syncState?.lastSuccessAt);
    const isFresh =
      effectiveVerificationAt !== null &&
      input.now.getTime() - effectiveVerificationAt.getTime() <= EXTERNAL_WAR_FRESHNESS_WINDOW_MS;

    let refreshAttempted = false;
    let refreshStatus: ClanHealthSnapshotTelemetry["refreshStatus"] = "not_needed";
    let staleFallbackUsed = false;

    if (!isFresh || rows.length === 0) {
      refreshAttempted = true;
      try {
        const syncResult = await this.clanWarsSyncService.syncClan(input.clanTag, {
          force: false,
          minimumIntervalMs: EXTERNAL_WAR_REFRESH_MINIMUM_INTERVAL_MS,
          now: input.now,
        });
        if (syncResult.status === "SUCCESS" || syncResult.status === "NOOP") {
          refreshStatus = syncResult.status === "SUCCESS" ? "success" : "noop";
          rows = await loadRows();
          syncState = await loadSyncState();
          effectiveVerificationAt = getEffectiveVerificationAt(rows, syncState?.lastSuccessAt);
        } else {
          refreshStatus = "skipped";
          staleFallbackUsed = rows.length > 0;
        }
      } catch {
        refreshStatus = "failed";
        staleFallbackUsed = rows.length > 0;
      }
    }

    const recognizedRows = rows
      .map((row) => ({
        ...row,
        classification: classifyOpponentInfo(row.opponentInfo),
      }))
      .filter((row) => row.classification !== "IGNORED")
      .slice(0, EXTERNAL_WAR_SAMPLE_LIMIT);
    const warSourceAgeMs =
      effectiveVerificationAt === null
        ? null
        : Math.max(0, input.now.getTime() - effectiveVerificationAt.getTime());

    if (recognizedRows.length === 0) {
      return {
        warPerformance: null,
        telemetry: {
          warRows: rows.length,
          recognizedWarRows: 0,
          warSourceAgeMs,
          refreshAttempted,
          refreshStatus,
          staleFallbackUsed,
        },
      };
    }

    const summary = recognizedRows.reduce(
      (acc, row) => {
        const result = String(row.result ?? "").trim().toUpperCase();
        const isWin = result === "WIN";
        const isLose = result === "LOSE";
        if (isWin) {
          acc.winCount += 1;
        }
        if (row.classification === "FWA" || row.classification === "FRIENDLY") {
          acc.fwaMatchCount += 1;
          if (isWin) acc.fwaWinCount += 1;
          if (isLose) acc.fwaLossCount += 1;
        } else if (row.classification === "BLACKLISTED") {
          acc.blMatchCount += 1;
        } else if (row.classification === "UNKNOWN") {
          acc.mmMatchCount += 1;
        }
        return acc;
      },
      {
        fwaMatchCount: 0,
        fwaWinCount: 0,
        fwaLossCount: 0,
        blMatchCount: 0,
        mmMatchCount: 0,
        winCount: 0,
      },
    );

    const warPerformance: ClanHealthExternalWarPerformance = {
      windowSize: EXTERNAL_WAR_SAMPLE_LIMIT,
      endedWarSampleSize: recognizedRows.length,
      recognizedWarRows: recognizedRows.length,
      fwaMatchCount: summary.fwaMatchCount,
      fwaWinCount: summary.fwaWinCount,
      fwaLossCount: summary.fwaLossCount,
      blMatchCount: summary.blMatchCount,
      mmMatchCount: summary.mmMatchCount,
      blInclusiveMatchCount: summary.fwaMatchCount + summary.blMatchCount,
      winCount: summary.winCount,
      sourceSyncedAt: effectiveVerificationAt,
      sourceAgeMs: warSourceAgeMs,
      refreshAttempted,
      refreshStatus,
      staleFallbackUsed,
    };

    return {
      warPerformance,
      telemetry: {
        warRows: rows.length,
        recognizedWarRows: recognizedRows.length,
        warSourceAgeMs,
        refreshAttempted,
        refreshStatus,
        staleFallbackUsed,
      },
    };
  }

  private logClanHealthSnapshot(input: {
    guildId: string;
    clanTag: string;
    viewType: ClanHealthSnapshot["viewType"];
    historicalWindow?: ClanHealthHistoricalWindow;
    warRows: number;
    recognizedWarRows: number | null;
    complianceEvaluatedWarCount?: number;
    complianceAffectedWarCount?: number;
    complianceViolationCount?: number;
    compliancePlayerCount?: number;
    complianceDiscordUserCount?: number;
    compositionMemberCount: number | null;
    compositionUnresolvedCount: number | null;
    compositionComplete: boolean | null;
    compositionSelectedHeatMapRefAvailable: boolean | null;
    compositionDeviationScore: number | null;
    compositionSourceAgeMs: number | null;
    warSourceAgeMs: number | null;
    refreshAttempted: boolean;
    refreshStatus: ClanHealthSnapshotTelemetry["refreshStatus"];
    staleFallbackUsed: boolean;
    durationMs: number;
  }): void {
    console.info(
      [
        "[clan-health]",
        `guild=${input.guildId}`,
        `clan=${input.clanTag}`,
        `view_type=${input.viewType}`,
        input.historicalWindow
          ? `historical_window_kind=${input.historicalWindow.kind}`
          : null,
        input.historicalWindow?.kind === "days"
          ? `historical_window_days=${input.historicalWindow.days}`
          : null,
        input.historicalWindow?.kind === "syncs"
          ? `historical_syncs_available=${input.historicalWindow.syncNumbers.length}/${input.historicalWindow.requestedSyncCount}`
          : null,
        `war_rows=${input.warRows}`,
        `recognized_war_rows=${input.recognizedWarRows ?? "n/a"}`,
        input.complianceEvaluatedWarCount !== undefined
          ? `compliance_evaluated_wars=${input.complianceEvaluatedWarCount}`
          : null,
        input.complianceAffectedWarCount !== undefined
          ? `compliance_affected_wars=${input.complianceAffectedWarCount}`
          : null,
        input.complianceViolationCount !== undefined
          ? `compliance_violations=${input.complianceViolationCount}`
          : null,
        input.compliancePlayerCount !== undefined
          ? `compliance_players=${input.compliancePlayerCount}`
          : null,
        input.complianceDiscordUserCount !== undefined
          ? `compliance_discord_users=${input.complianceDiscordUserCount}`
          : null,
        `composition_member_count=${input.compositionMemberCount ?? "n/a"}`,
        `composition_unresolved_count=${input.compositionUnresolvedCount ?? "n/a"}`,
        `composition_complete=${input.compositionComplete === null ? "n/a" : input.compositionComplete ? "true" : "false"}`,
        `composition_selected_heatmap_ref_available=${input.compositionSelectedHeatMapRefAvailable === null ? "n/a" : input.compositionSelectedHeatMapRefAvailable ? "true" : "false"}`,
        `composition_deviation=${input.compositionDeviationScore ?? "n/a"}`,
        `composition_source_age_ms=${input.compositionSourceAgeMs ?? "n/a"}`,
        `war_source_age_ms=${input.warSourceAgeMs ?? "n/a"}`,
        `refresh_attempted=${input.refreshAttempted ? "true" : "false"}`,
        `refresh_status=${input.refreshStatus}`,
        `stale_fallback_used=${input.staleFallbackUsed ? "true" : "false"}`,
        `duration_ms=${input.durationMs}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
    );
  }
}

/** Purpose: normalize the persisted war-plan leaderboard into the clan-health summary shape. */
function buildWarPlanComplianceSummary(
  result: WarPlanViolationHistoryClanLeaderboardBoundedResult
): ClanHealthTrackedSnapshot["warPlanCompliance"] {
  if (result.outcome === "not_found") {
    return {
      hasCompletedEvaluations: false,
      evaluatedWarCount: 0,
      affectedWarCount: 0,
      violationCount: 0,
      distinctPlayerCount: 0,
      distinctCurrentDiscordUserCount: 0,
    };
  }

  const distinctCurrentDiscordUserCount = new Set(
    result.players
      .filter((row) => row.violationCount > 0)
      .map((row) => normalizeDiscordUserId(row.discordUserId))
      .filter((discordUserId): discordUserId is string => discordUserId !== null)
  ).size;

  return {
    hasCompletedEvaluations: result.hasCompletedEvaluations,
    evaluatedWarCount: result.evaluatedWarCount,
    affectedWarCount: result.affectedWarCount,
    violationCount: result.violationCount,
    distinctPlayerCount: result.distinctPlayerCount,
    distinctCurrentDiscordUserCount,
  };
}
