import { recordFetchEvent, runFetchTelemetryBatch } from "../../helper/fetchTelemetry";
import { formatError } from "../../helper/formatError";
import { SteadyStateLogGate } from "../../helper/steadyStateLogGate";
import { FwaClansCatalogSyncService } from "./FwaClansCatalogSyncService";
import { FwaClanMembersSyncService } from "./FwaClanMembersSyncService";
import { FwaWarMembersSyncService } from "./FwaWarMembersSyncService";
import { FwaClanWarsSyncService } from "./FwaClanWarsSyncService";
import { FwaClanWarsWatchService } from "./FwaClanWarsWatchService";
import { FwaFeedSyncStateService } from "./FwaFeedSyncStateService";

type SchedulerConfig = {
  clansEnabled: boolean;
  clanMembersEnabled: boolean;
  warMembersSweepEnabled: boolean;
  trackedClanWarsWatchEnabled: boolean;
  globalClanWarsSweepEnabled: boolean;
  clansIntervalMs: number;
  clanMembersIntervalMs: number;
  sweepTickIntervalMs: number;
  trackedClanWarsWatchTickMs: number;
  warMembersSweepChunkSize: number;
  globalClanWarsSweepChunkSize: number;
  maxConcurrency: number;
  jitterMs: number;
};

type TrackedClanWarsWatchSummary = {
  trackedClanCount: number;
  activeClanCount: number;
  polledClanCount: number;
  updateAcquiredCount: number;
};

function toBool(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined) return fallback;
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toInt(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export const toIntWithFallbackForTest = toInt;

function minutesToMsWithMin(valueMinutes: number, minMinutes: number): number {
  return Math.max(minMinutes, valueMinutes) * 60 * 1000;
}

/** Purpose: serialize tracked-clan watch summary into a deterministic comparison key. */
function buildTrackedClanWarsWatchSummaryKey(summary: TrackedClanWarsWatchSummary): string {
  return `tracked=${summary.trackedClanCount}|active=${summary.activeClanCount}|polled=${summary.polledClanCount}|acquired=${summary.updateAcquiredCount}`;
}

/** Purpose: flag whether a tracked-clan watch summary represents actual polling work. */
function hasTrackedClanWarsWatchActivity(summary: TrackedClanWarsWatchSummary): boolean {
  return (
    summary.activeClanCount > 0 ||
    summary.polledClanCount > 0 ||
    summary.updateAcquiredCount > 0
  );
}

/** Purpose: keep watch summaries at info for work/changes, and demote repeated no-op states to debug. */
function resolveTrackedClanWarsWatchSummaryLogLevel(params: {
  summary: TrackedClanWarsWatchSummary;
  summaryChanged: boolean;
}): "info" | "debug" {
  if (hasTrackedClanWarsWatchActivity(params.summary) || params.summaryChanged) {
    return "info";
  }
  return "debug";
}

export const buildTrackedClanWarsWatchSummaryKeyForTest =
  buildTrackedClanWarsWatchSummaryKey;
export const resolveTrackedClanWarsWatchSummaryLogLevelForTest =
  resolveTrackedClanWarsWatchSummaryLogLevel;

/** Purpose: orchestrate bounded fwastats feed scheduler jobs with explicit cadence and cost controls. */
export class FwaFeedSchedulerService {
  private readonly config: SchedulerConfig;
  private readonly syncState = new FwaFeedSyncStateService();
  private readonly clansSync = new FwaClansCatalogSyncService();
  private readonly membersSync = new FwaClanMembersSyncService();
  private readonly warMembersSync = new FwaWarMembersSyncService();
  private readonly clanWarsSync = new FwaClanWarsSyncService();
  private readonly watchService = new FwaClanWarsWatchService(this.clanWarsSync);

  private clansInProgress = false;
  private membersInProgress = false;
  private warMembersInProgress = false;
  private watchInProgress = false;
  private globalWarsInProgress = false;
  private readonly trackedClanWarsWatchSummaryLogGate = new SteadyStateLogGate();

  /** Purpose: initialize scheduler config from env with safe minimum intervals and bounded defaults. */
  constructor() {
    const clansMinutesRaw = toInt(process.env.FWA_CLANS_SYNC_CRON_OR_MINUTES, 360);
    const clanMembersMinutesRaw = toInt(process.env.FWA_CLAN_MEMBERS_SYNC_MINUTES, 15);
    const sweepTickMinutesRaw = toInt(process.env.FWA_SWEEP_TICK_MINUTES, 15);
    const trackedWatchMinutesRaw = toInt(process.env.FWA_TRACKED_CLAN_WARS_WATCH_TICK_MINUTES, 5);
    this.config = {
      clansEnabled: toBool(process.env.FWA_CLANS_SYNC_ENABLED, true),
      clanMembersEnabled: toBool(process.env.FWA_CLAN_MEMBERS_SYNC_ENABLED, true),
      warMembersSweepEnabled: toBool(process.env.FWA_WAR_MEMBERS_SWEEP_ENABLED, true),
      trackedClanWarsWatchEnabled: toBool(process.env.FWA_TRACKED_CLAN_WARS_WATCH_ENABLED, true),
      globalClanWarsSweepEnabled: toBool(process.env.FWA_GLOBAL_CLAN_WARS_SWEEP_ENABLED, false),
      clansIntervalMs: minutesToMsWithMin(clansMinutesRaw, 15),
      clanMembersIntervalMs: minutesToMsWithMin(clanMembersMinutesRaw, 15),
      sweepTickIntervalMs: minutesToMsWithMin(sweepTickMinutesRaw, 15),
      trackedClanWarsWatchTickMs: minutesToMsWithMin(trackedWatchMinutesRaw, 5),
      warMembersSweepChunkSize: Math.max(1, toInt(process.env.FWA_WAR_MEMBERS_SWEEP_CHUNK_SIZE, 6)),
      globalClanWarsSweepChunkSize: Math.max(
        1,
        toInt(process.env.FWA_GLOBAL_CLAN_WARS_SWEEP_CHUNK_SIZE, 20),
      ),
      maxConcurrency: Math.max(1, toInt(process.env.FWA_FEED_MAX_CONCURRENCY, 4)),
      jitterMs: Math.max(0, toInt(process.env.FWA_FEED_JOB_JITTER_MS, 30_000)),
    };
  }

  /** Purpose: start all enabled fwa feed loops with bounded intervals and overlap guards. */
  start(): void {
    if (this.config.clansEnabled) {
      this.runWithJitter(() => this.runClansJob());
      setInterval(() => {
        this.runClansJob().catch((error) => {
          console.error(`[fwa-feed] clans interval failed: ${formatError(error)}`);
        });
      }, this.config.clansIntervalMs);
      console.log(
        `[fwa-feed] CLANS sync enabled interval_minutes=${Math.round(this.config.clansIntervalMs / 60000)}`,
      );
    }

    if (this.config.clanMembersEnabled) {
      this.runWithJitter(() => this.runTrackedClanMembersJob());
      setInterval(() => {
        this.runTrackedClanMembersJob().catch((error) => {
          console.error(`[fwa-feed] clan-members interval failed: ${formatError(error)}`);
        });
      }, this.config.clanMembersIntervalMs);
      console.log(
        `[fwa-feed] CLAN_MEMBERS sync enabled interval_minutes=${Math.round(this.config.clanMembersIntervalMs / 60000)}`,
      );
    }

    if (this.config.warMembersSweepEnabled) {
      this.runWithJitter(() => this.runWarMembersSweepJob());
      setInterval(() => {
        this.runWarMembersSweepJob().catch((error) => {
          console.error(`[fwa-feed] war-members sweep interval failed: ${formatError(error)}`);
        });
      }, this.config.sweepTickIntervalMs);
      console.log(
        `[fwa-feed] WAR_MEMBERS sweep enabled tick_minutes=${Math.round(this.config.sweepTickIntervalMs / 60000)} chunk=${this.config.warMembersSweepChunkSize}`,
      );
    }

    if (this.config.trackedClanWarsWatchEnabled) {
      this.runWithJitter(() => this.runTrackedClanWarsWatchJob());
      setInterval(() => {
        this.runTrackedClanWarsWatchJob().catch((error) => {
          console.error(`[fwa-feed] tracked clan wars watch interval failed: ${formatError(error)}`);
        });
      }, this.config.trackedClanWarsWatchTickMs);
      console.log(
        `[fwa-feed] tracked CLAN_WARS watch enabled tick_minutes=${Math.round(this.config.trackedClanWarsWatchTickMs / 60000)}`,
      );
    }

    if (this.config.globalClanWarsSweepEnabled) {
      this.runWithJitter(() => this.runGlobalClanWarsSweepJob());
      setInterval(() => {
        this.runGlobalClanWarsSweepJob().catch((error) => {
          console.error(`[fwa-feed] global clan wars sweep interval failed: ${formatError(error)}`);
        });
      }, this.config.sweepTickIntervalMs);
      console.log(
        `[fwa-feed] global CLAN_WARS sweep enabled tick_minutes=${Math.round(this.config.sweepTickIntervalMs / 60000)} chunk=${this.config.globalClanWarsSweepChunkSize}`,
      );
    }
  }

  /** Purpose: run one global Clans.json sync cycle with overlap guard and aggregate sync-state row. */
  async runClansJob(): Promise<void> {
    if (this.clansInProgress) return;
    this.clansInProgress = true;
    const now = new Date();
    const scope = { feedType: "CLANS" as const, scopeType: "GLOBAL" as const, scopeKey: null };
    try {
      await runFetchTelemetryBatch("fwa_clans_catalog_sync", async () => {
        const startedAt = Date.now();
        const result = await this.clansSync.syncGlobalCatalog({
          minimumIntervalMs: this.config.clansIntervalMs,
          now,
        });
        console.info(
          `[fwa-feed] job=clans status=${result.status} rows=${result.rowCount} changed=${result.changedRowCount} duration_ms=${Date.now() - startedAt}`,
        );
        recordFetchEvent({
          namespace: "fwastats_feed",
          operation: "clans_scheduler",
          source: "cache_miss",
          status: "success",
          detail: `rows=${result.rowCount} changed=${result.changedRowCount} status=${result.status}`,
        });
      });
    } catch (error) {
      const nextEligibleAt = new Date(now.getTime() + this.config.clansIntervalMs);
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SCHEDULER_FAILED",
          errorSummary: String((error as { message?: string })?.message ?? "unknown error").slice(
            0,
            200,
          ),
          nextEligibleAt,
        },
        now,
      );
      throw error;
    } finally {
      this.clansInProgress = false;
    }
  }

  /** Purpose: run one tracked-clan Members.json sync cycle with bounded concurrency. */
  async runTrackedClanMembersJob(): Promise<void> {
    if (this.membersInProgress) return;
    this.membersInProgress = true;
    const now = new Date();
    const scope = {
      feedType: "CLAN_MEMBERS" as const,
      scopeType: "TRACKED_CLANS" as const,
      scopeKey: null,
    };
    const nextEligibleAt = new Date(now.getTime() + this.config.clanMembersIntervalMs);
    try {
      await this.syncState.recordAttempt(scope, nextEligibleAt, now);
      await runFetchTelemetryBatch("fwa_clan_members_sync", async () => {
        const startedAt = Date.now();
        const result = await this.membersSync.syncAllTrackedClans({
          minimumIntervalMs: this.config.clanMembersIntervalMs,
          now,
          concurrency: this.config.maxConcurrency,
        });
        await this.syncState.recordSuccess(
          {
            ...scope,
            rowCount: result.rowCount,
            changedRowCount: result.changedRowCount,
            contentHash: null,
            status: "SUCCESS",
            nextEligibleAt,
          },
          now,
        );
        console.info(
          `[fwa-feed] job=clan_members status=SUCCESS clans=${result.clanCount} rows=${result.rowCount} changed=${result.changedRowCount} failed=${result.failedClans.length} duration_ms=${Date.now() - startedAt}`,
        );
      });
    } catch (error) {
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SCHEDULER_FAILED",
          errorSummary: String((error as { message?: string })?.message ?? "unknown error").slice(
            0,
            200,
          ),
          nextEligibleAt,
        },
        now,
      );
      throw error;
    } finally {
      this.membersInProgress = false;
    }
  }

  /** Purpose: run one cursor-based WAR_MEMBERS sweep tick with bounded per-clan processing. */
  async runWarMembersSweepJob(): Promise<void> {
    if (this.warMembersInProgress) return;
    this.warMembersInProgress = true;
    const now = new Date();
    const scope = { feedType: "WAR_MEMBERS" as const, scopeType: "GLOBAL" as const, scopeKey: "SWEEP" };
    const nextEligibleAt = new Date(now.getTime() + this.config.sweepTickIntervalMs);
    try {
      await this.syncState.recordAttempt(scope, nextEligibleAt, now);
      await runFetchTelemetryBatch("fwa_war_members_sweep", async () => {
        const startedAt = Date.now();
        const summary = await this.warMembersSync.runDistributedSweep({
          chunkSize: this.config.warMembersSweepChunkSize,
          concurrency: this.config.maxConcurrency,
          minimumIntervalMs: 0,
          now,
        });
        await this.syncState.recordSuccess(
          {
            ...scope,
            rowCount: summary.rowCount,
            changedRowCount: summary.changedRowCount,
            contentHash: summary.nextCursor,
            status: "SUCCESS",
            nextEligibleAt,
          },
          now,
        );
        console.info(
          `[fwa-feed] job=war_members_sweep clans=${summary.attemptedClans} rows=${summary.rowCount} changed=${summary.changedRowCount} failed=${summary.failedClans.length} next_cursor=${summary.nextCursor ?? "none"} duration_ms=${Date.now() - startedAt}`,
        );
      });
    } catch (error) {
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SCHEDULER_FAILED",
          errorSummary: String((error as { message?: string })?.message ?? "unknown error").slice(
            0,
            200,
          ),
          nextEligibleAt,
        },
        now,
      );
      throw error;
    } finally {
      this.warMembersInProgress = false;
    }
  }

  /** Purpose: run one tracked-clan watch tick for 5-minute Wars.json update-acquisition windows. */
  async runTrackedClanWarsWatchJob(): Promise<void> {
    if (this.watchInProgress) return;
    this.watchInProgress = true;
    const now = new Date();
    const scope = {
      feedType: "CLAN_WARS" as const,
      scopeType: "TRACKED_CLANS" as const,
      scopeKey: "WATCH",
    };
    const nextEligibleAt = new Date(now.getTime() + this.config.trackedClanWarsWatchTickMs);
    try {
      await this.syncState.recordAttempt(scope, nextEligibleAt, now);
      await runFetchTelemetryBatch("fwa_tracked_clan_wars_watch", async () => {
        const startedAt = Date.now();
        const summary = await this.watchService.runWatchTick({
          now,
          concurrency: this.config.maxConcurrency,
        });
        await this.syncState.recordSuccess(
          {
            ...scope,
            rowCount: summary.polledClanCount,
            changedRowCount: summary.updateAcquiredCount,
            contentHash: `${summary.activeClanCount}`,
            status: "SUCCESS",
            nextEligibleAt,
          },
          now,
        );
        const summaryChanged = this.trackedClanWarsWatchSummaryLogGate.shouldEmitInfo(
          "tracked_clan_wars_watch",
          buildTrackedClanWarsWatchSummaryKey(summary),
        );
        const logLevel = resolveTrackedClanWarsWatchSummaryLogLevel({
          summary,
          summaryChanged,
        });
        const line = `[fwa-feed] job=tracked_clan_wars_watch tracked=${summary.trackedClanCount} active=${summary.activeClanCount} polled=${summary.polledClanCount} acquired=${summary.updateAcquiredCount} duration_ms=${Date.now() - startedAt}`;
        if (logLevel === "info") {
          console.info(line);
        } else {
          console.debug(line);
        }
      });
    } catch (error) {
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SCHEDULER_FAILED",
          errorSummary: String((error as { message?: string })?.message ?? "unknown error").slice(
            0,
            200,
          ),
          nextEligibleAt,
        },
        now,
      );
      throw error;
    } finally {
      this.watchInProgress = false;
    }
  }

  /** Purpose: run one optional global clan-wars cursor sweep tick for broader dataset refreshes. */
  async runGlobalClanWarsSweepJob(): Promise<void> {
    if (this.globalWarsInProgress) return;
    this.globalWarsInProgress = true;
    const now = new Date();
    const scope = { feedType: "CLAN_WARS" as const, scopeType: "GLOBAL" as const, scopeKey: "SWEEP" };
    const nextEligibleAt = new Date(now.getTime() + this.config.sweepTickIntervalMs);
    try {
      await this.syncState.recordAttempt(scope, nextEligibleAt, now);
      await runFetchTelemetryBatch("fwa_global_clan_wars_sweep", async () => {
        const startedAt = Date.now();
        const summary = await this.clanWarsSync.runDistributedSweep({
          chunkSize: this.config.globalClanWarsSweepChunkSize,
          concurrency: this.config.maxConcurrency,
          minimumIntervalMs: 0,
          now,
        });
        await this.syncState.recordSuccess(
          {
            ...scope,
            rowCount: summary.rowCount,
            changedRowCount: summary.changedRowCount,
            contentHash: summary.nextCursor,
            status: "SUCCESS",
            nextEligibleAt,
          },
          now,
        );
        console.info(
          `[fwa-feed] job=global_clan_wars_sweep clans=${summary.attemptedClans} rows=${summary.rowCount} changed=${summary.changedRowCount} failed=${summary.failedClans.length} next_cursor=${summary.nextCursor ?? "none"} duration_ms=${Date.now() - startedAt}`,
        );
      });
    } catch (error) {
      await this.syncState.recordFailure(
        {
          ...scope,
          errorCode: "SCHEDULER_FAILED",
          errorSummary: String((error as { message?: string })?.message ?? "unknown error").slice(
            0,
            200,
          ),
          nextEligibleAt,
        },
        now,
      );
      throw error;
    } finally {
      this.globalWarsInProgress = false;
    }
  }

  /** Purpose: apply one-time startup jitter to spread background load across restarts. */
  private runWithJitter(run: () => Promise<void>): void {
    const jitterMs = this.config.jitterMs;
    if (jitterMs <= 0) {
      run().catch((error) => {
        console.error(`[fwa-feed] startup run failed: ${formatError(error)}`);
      });
      return;
    }
    const delayMs = Math.floor(Math.random() * jitterMs);
    setTimeout(() => {
      run().catch((error) => {
        console.error(`[fwa-feed] startup jitter run failed: ${formatError(error)}`);
      });
    }, delayMs);
  }
}
