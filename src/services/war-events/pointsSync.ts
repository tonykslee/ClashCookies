import { prisma } from "../../prisma";
import {
  chooseMatchTypeResolution,
  inferMatchTypeFromOpponentPoints,
  resolveCurrentWarMatchTypeSignal,
  toSyncIsFwa,
} from "../MatchTypeResolutionService";
import { PointsProjectionService } from "../PointsProjectionService";
import { PointsSyncService } from "../PointsSyncService";
import { SettingsService } from "../SettingsService";
import {
  deriveExpectedOutcome,
  normalizeTag,
  normalizeTagBare,
} from "./core";

type WarStartPointsCheckJob = {
  clanTag: string;
  opponentTag: string;
  warId: string | null;
  warStartTime: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtMs: number;
  completed: boolean;
  status: "pending" | "in_sync" | "out_of_sync" | "max_attempts" | "error";
  trackedPointBalanceSite: number | null;
  trackedPointBalanceDb: number | null;
  siteSyncNumber: number | null;
  siteOpponentTag: string | null;
  siteOpponentBalance: number | null;
  siteOpponentActiveFwa: boolean | null;
  siteOpponentNotFound: boolean | null;
  inferredOpponentIsFwa: boolean | null;
  opponentChecked: boolean;
  lastCheckedAtMs: number | null;
};

export type PointsSyncSubscriptionLike = {
  clanTag: string;
  fwaPoints: number | null;
};

export type WarStartPointsCheckContext = {
  guildId: string;
  clanTag: string;
  warId: string | number | null;
  warStartTime: Date | null;
  opponentTag: string;
};

type ExactCurrentWarRow = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  startTime: Date | null;
  opponentTag: string | null;
  fwaPoints: number | null;
  state: string | null;
  matchType: string | null;
  inferredMatchType: boolean | null;
  clanStars: number | null;
  opponentStars: number | null;
};

/** Purpose: manage previous sync recovery and war-start points-site retry jobs. */
export class WarStartPointsSyncService {
  private static readonly WAR_START_POINTS_JOB_PREFIX = "warStartPointsCheck";
  private static readonly WAR_START_POINTS_RECHECK_MS = 30 * 60 * 1000;
  private static readonly WAR_START_POINTS_MAX_ATTEMPTS = 10;

  /** Purpose: initialize points sync service dependencies. */
  constructor(
    private readonly points: PointsProjectionService,
    private readonly settings: SettingsService,
    private readonly pointsSync = new PointsSyncService()
  ) {}

  /** Purpose: load the exact canonical current-war row for a retry context. */
  private async loadExactCurrentWarRow(
    context: WarStartPointsCheckContext,
  ): Promise<ExactCurrentWarRow | null> {
    const clanTag = normalizeTag(context.clanTag);
    const opponentTag = normalizeTag(context.opponentTag);
    const warId =
      context.warId !== null &&
      context.warId !== undefined &&
      Number.isFinite(Number(context.warId))
        ? Math.trunc(Number(context.warId))
        : null;
    const warStartTime =
      context.warStartTime instanceof Date &&
      Number.isFinite(context.warStartTime.getTime())
        ? context.warStartTime
        : null;
    if (!clanTag || !opponentTag || warId === null || !warStartTime) {
      return null;
    }
    return prisma.currentWar.findFirst({
      where: {
        guildId: context.guildId,
        clanTag,
        warId,
        startTime: warStartTime,
        opponentTag,
      },
      select: {
        guildId: true,
        clanTag: true,
        warId: true,
        startTime: true,
        opponentTag: true,
        fwaPoints: true,
        state: true,
        matchType: true,
        inferredMatchType: true,
        clanStars: true,
        opponentStars: true,
      },
    });
  }

  /** Purpose: read previous sync from ClanPointsSync with ClanWarHistory fallback. */
  async getPreviousSyncNum(): Promise<number | null> {
    const latestSync = await this.pointsSync.findLatestSyncNum();
    if (latestSync !== null) {
      return Math.max(0, latestSync - 1);
    }
    const latestHistory = await prisma.clanWarHistory.findFirst({
      where: { syncNumber: { not: null } },
      orderBy: { warStartTime: "desc" },
      select: { syncNumber: true },
    });
    const latestHistorySync = Number(latestHistory?.syncNumber ?? NaN);
    if (Number.isFinite(latestHistorySync)) {
      return Math.max(0, Math.trunc(latestHistorySync));
    }
    return null;
  }

  /** Purpose: reset/start a new war-start points check job for a clan+opponent pair. */
  async resetWarStartPointsJob(
    context: WarStartPointsCheckContext,
  ): Promise<void> {
    const now = Date.now();
    const clanTag = normalizeTag(context.clanTag);
    const opponentTag = normalizeTag(context.opponentTag);
    const warId =
      context.warId !== null &&
      context.warId !== undefined &&
      Number.isFinite(Number(context.warId)) &&
      Math.trunc(Number(context.warId)) > 0
        ? String(Math.trunc(Number(context.warId)))
        : null;
    const warStartTime =
      context.warStartTime instanceof Date &&
      Number.isFinite(context.warStartTime.getTime())
        ? context.warStartTime.toISOString()
        : null;
    if (!clanTag || !opponentTag || !warId || !warStartTime) return;
    const next: WarStartPointsCheckJob = {
      clanTag,
      opponentTag,
      warId,
      warStartTime,
      attempts: 0,
      maxAttempts: WarStartPointsSyncService.WAR_START_POINTS_MAX_ATTEMPTS,
      nextAttemptAtMs: now,
      completed: false,
      status: "pending",
      trackedPointBalanceSite: null,
      trackedPointBalanceDb: null,
      siteSyncNumber: null,
      siteOpponentTag: null,
      siteOpponentBalance: null,
      siteOpponentActiveFwa: null,
      siteOpponentNotFound: null,
      inferredOpponentIsFwa: null,
      opponentChecked: false,
      lastCheckedAtMs: null,
    };
    await this.setWarStartPointsJob(next);
  }

  /** Purpose: run/advance the retrying points-site sync check for an in-war clan. */
  async maybeRunWarStartPointsCheck(
    context: WarStartPointsCheckContext,
  ): Promise<void> {
    const clanTag = normalizeTag(context.clanTag);
    const opponentTag = normalizeTag(context.opponentTag);
    const warId =
      context.warId !== null &&
      context.warId !== undefined &&
      Number.isFinite(Number(context.warId)) &&
      Math.trunc(Number(context.warId)) > 0
        ? String(Math.trunc(Number(context.warId)))
        : null;
    const warStartTime =
      context.warStartTime instanceof Date &&
      Number.isFinite(context.warStartTime.getTime())
        ? context.warStartTime
        : null;
    if (!clanTag || !opponentTag || !warId || !warStartTime) return;

    let job = await this.getWarStartPointsJob(clanTag);
    const jobMatchesContext =
      job !== null &&
      normalizeTag(job.clanTag) === clanTag &&
      normalizeTag(job.opponentTag) === opponentTag &&
      job.warId === warId &&
      job.warStartTime === warStartTime.toISOString();
    if (!jobMatchesContext) {
      await this.resetWarStartPointsJob(context);
      job = await this.getWarStartPointsJob(clanTag);
    }
    if (!job || job.completed) return;
    if (
      normalizeTag(job.clanTag) !== clanTag ||
      normalizeTag(job.opponentTag) !== opponentTag ||
      job.warId !== warId ||
      job.warStartTime !== warStartTime.toISOString()
    ) {
      return;
    }
    if (Date.now() < job.nextAttemptAtMs) return;

    const exactCurrentWarBefore = await this.loadExactCurrentWarRow(context);
    if (!exactCurrentWarBefore) return;

    const nextAttempt = job.attempts + 1;
    try {
      const primary = await this.points.fetchSnapshot(clanTag, {
        reason: "post_war_reconciliation",
        caller: "service",
      });
      const siteUpdated = primary.winnerBoxTags.map((t) => normalizeTag(t)).includes(opponentTag);
      const winnerBoxNotMarkedFwa = /not marked as an fwa match/i.test(
        String(primary.winnerBoxText ?? "")
      );
      const trackedSite =
        primary.balance !== null && Number.isFinite(primary.balance) ? primary.balance : null;

      let inferredOpponentIsFwa = job.inferredOpponentIsFwa;
      let opponentChecked = job.opponentChecked;
      let opponentBalance = job.siteOpponentBalance;
      let opponentActiveFwa = job.siteOpponentActiveFwa;
      let opponentNotFound = job.siteOpponentNotFound;
      if (!opponentChecked) {
        const opp = await this.points
          .fetchSnapshot(opponentTag, {
            reason: "post_war_reconciliation",
            caller: "service",
            fallbackTrackedClanTag: clanTag,
          })
          .catch(() => null);
        opponentChecked = true;
        const strongOpponentEvidencePresent =
          opp?.notFound === true || opp?.activeFwa === true || opp?.activeFwa === false;
        const liveResolution = inferMatchTypeFromOpponentPoints({
          available: opp !== null,
          balance: opp?.balance ?? null,
          activeFwa: opp?.activeFwa ?? null,
          notFound: opp?.notFound ?? false,
          winnerBoxNotMarkedFwa,
          opponentEvidenceMissingOrNotCurrent: !siteUpdated || !strongOpponentEvidencePresent,
        });
        inferredOpponentIsFwa = liveResolution?.syncIsFwa ?? null;
        opponentBalance =
          opp?.balance !== null && opp?.balance !== undefined && Number.isFinite(opp.balance)
            ? opp.balance
            : null;
        opponentActiveFwa = opp?.activeFwa ?? null;
        opponentNotFound = opp?.notFound ?? null;
      }

      const exactCurrentWarAfter = await this.loadExactCurrentWarRow(context);
      if (!exactCurrentWarAfter) return;
      const trackedDb =
        exactCurrentWarAfter.fwaPoints !== null &&
        exactCurrentWarAfter.fwaPoints !== undefined &&
        Number.isFinite(exactCurrentWarAfter.fwaPoints)
          ? Math.trunc(exactCurrentWarAfter.fwaPoints)
          : null;
      const mismatch =
        siteUpdated &&
        trackedDb !== null &&
        trackedSite !== null &&
        Number.isFinite(trackedDb) &&
        Number.isFinite(trackedSite) &&
        trackedDb !== trackedSite;

      const exhausted = !siteUpdated && nextAttempt >= job.maxAttempts;
      const completed = siteUpdated || exhausted;
      const status: WarStartPointsCheckJob["status"] = siteUpdated
        ? mismatch
          ? "out_of_sync"
          : "in_sync"
        : exhausted
          ? "max_attempts"
          : "pending";

      await this.setWarStartPointsJob({
        ...job,
        attempts: nextAttempt,
        nextAttemptAtMs: completed
          ? Date.now()
          : Date.now() + WarStartPointsSyncService.WAR_START_POINTS_RECHECK_MS,
        completed,
        status,
        trackedPointBalanceSite: trackedSite,
        trackedPointBalanceDb: trackedDb,
        siteSyncNumber:
          primary.winnerBoxSync !== null && Number.isFinite(primary.winnerBoxSync)
            ? Math.trunc(primary.winnerBoxSync)
            : null,
        siteOpponentTag: siteUpdated ? opponentTag : null,
        siteOpponentBalance: opponentBalance,
        siteOpponentActiveFwa: opponentActiveFwa,
        siteOpponentNotFound: opponentNotFound,
        inferredOpponentIsFwa,
        opponentChecked,
        lastCheckedAtMs: Date.now(),
      });
      if (
        siteUpdated &&
        exactCurrentWarAfter?.guildId &&
        exactCurrentWarAfter.startTime &&
        normalizeTag(exactCurrentWarAfter.opponentTag ?? null) === opponentTag &&
        String(Math.trunc(Number(exactCurrentWarAfter.warId ?? 0))) === warId &&
        exactCurrentWarAfter.startTime.toISOString() === warStartTime.toISOString() &&
        trackedSite !== null &&
        opponentBalance !== null &&
        primary.winnerBoxSync !== null &&
        Number.isFinite(primary.winnerBoxSync)
      ) {
        const currentWar = exactCurrentWarAfter;
        const strongOpponentEvidencePresent =
          opponentNotFound === true ||
          opponentActiveFwa === true ||
          opponentActiveFwa === false;
        const liveResolution = inferMatchTypeFromOpponentPoints({
          available: opponentChecked,
          balance: opponentBalance,
          activeFwa: opponentActiveFwa,
          notFound: opponentNotFound,
          winnerBoxNotMarkedFwa,
          opponentEvidenceMissingOrNotCurrent:
            !siteUpdated || !strongOpponentEvidencePresent,
          currentWarState:
            currentWar.state === "inWar" || currentWar.state === "preparation"
              ? currentWar.state
              : null,
          currentWarClanStars: currentWar.clanStars ?? null,
          currentWarOpponentStars: currentWar.opponentStars ?? null,
        });
        const currentResolution = resolveCurrentWarMatchTypeSignal({
          matchType: currentWar.matchType ?? null,
          inferredMatchType: currentWar.inferredMatchType ?? true,
        });
        const appliedResolution = chooseMatchTypeResolution({
          confirmedCurrent: currentResolution.confirmed,
          liveOpponent: liveResolution,
          storedSync: null,
          unconfirmedCurrent: currentResolution.unconfirmed,
        });
        const syncMatchType = appliedResolution?.matchType ?? currentWar.matchType ?? null;
        const syncIsFwa =
          appliedResolution?.syncIsFwa ??
          toSyncIsFwa(syncMatchType as Parameters<typeof toSyncIsFwa>[0]) ??
          false;
        const exactWarStartTime = currentWar.startTime;
        if (!exactWarStartTime) return;
        await this.pointsSync.upsertPointsSync({
          guildId: currentWar.guildId,
          clanTag,
          warId,
          warStartTime: exactWarStartTime,
          syncNum: Math.trunc(primary.winnerBoxSync),
          opponentTag,
          clanPoints: trackedSite,
          opponentPoints: opponentBalance,
          outcome: deriveExpectedOutcome(
            clanTag,
            opponentTag,
            trackedSite,
            opponentBalance,
            Math.trunc(primary.winnerBoxSync),
          ),
          isFwa: syncIsFwa,
          fetchedAt: new Date(primary.fetchedAtMs),
          fetchReason: "post_war_reconciliation",
          matchType: syncMatchType,
          needsValidation: false,
        });
      }
    } catch {
      const exhausted = nextAttempt >= job.maxAttempts;
      await this.setWarStartPointsJob({
        ...job,
        attempts: nextAttempt,
        completed: exhausted,
        status: exhausted ? "max_attempts" : "error",
        nextAttemptAtMs: exhausted
          ? Date.now()
          : Date.now() + WarStartPointsSyncService.WAR_START_POINTS_RECHECK_MS,
        lastCheckedAtMs: Date.now(),
      });
    }
  }

  /** Purpose: build the settings key used to store a clan's war-start sync-check job blob. */
  private buildWarStartPointsJobKey(clanTag: string): string {
    return `${WarStartPointsSyncService.WAR_START_POINTS_JOB_PREFIX}:${normalizeTagBare(clanTag)}`;
  }

  /** Purpose: load the persisted war-start sync-check job blob for a clan. */
  private async getWarStartPointsJob(clanTag: string): Promise<WarStartPointsCheckJob | null> {
    const raw = await this.settings.get(this.buildWarStartPointsJobKey(clanTag));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as WarStartPointsCheckJob;
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Purpose: persist the current war-start sync-check job blob for a clan. */
  private async setWarStartPointsJob(job: WarStartPointsCheckJob): Promise<void> {
    await this.settings.set(this.buildWarStartPointsJobKey(job.clanTag), JSON.stringify(job));
  }
}

