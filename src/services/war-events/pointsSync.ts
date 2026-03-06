import { prisma } from "../../prisma";
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
  inferredOpponentIsFwa: boolean | null;
  opponentChecked: boolean;
  lastCheckedAtMs: number | null;
};

export type PointsSyncSubscriptionLike = {
  clanTag: string;
  fwaPoints: number | null;
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
    clanTag: string,
    opponentTag: string
  ): Promise<void> {
    const now = Date.now();
    const next: WarStartPointsCheckJob = {
      clanTag: normalizeTag(clanTag),
      opponentTag: normalizeTag(opponentTag),
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
      inferredOpponentIsFwa: null,
      opponentChecked: false,
      lastCheckedAtMs: null,
    };
    await this.setWarStartPointsJob(next);
  }

  /** Purpose: run/advance the retrying points-site sync check for an in-war clan. */
  async maybeRunWarStartPointsCheck(
    sub: PointsSyncSubscriptionLike,
    opponentTagInput: string,
    clanNameInput: string | null,
    opponentNameInput: string | null
  ): Promise<void> {
    const clanTag = normalizeTag(sub.clanTag);
    const opponentTag = normalizeTag(opponentTagInput);
    if (!clanTag || !opponentTag) return;

    let job = await this.getWarStartPointsJob(clanTag);
    if (!job || normalizeTag(job.opponentTag) !== opponentTag) {
      await this.resetWarStartPointsJob(clanTag, opponentTag);
      job = await this.getWarStartPointsJob(clanTag);
    }
    if (!job || job.completed) return;
    if (Date.now() < job.nextAttemptAtMs) return;

    const nextAttempt = job.attempts + 1;
    try {
      const primary = await this.points.fetchSnapshot(clanTag);
      const siteUpdated = primary.winnerBoxTags.map((t) => normalizeTag(t)).includes(opponentTag);
      const trackedDb = sub.fwaPoints ?? null;
      const trackedSite =
        primary.balance !== null && Number.isFinite(primary.balance) ? primary.balance : null;

      let inferredOpponentIsFwa = job.inferredOpponentIsFwa;
      let opponentChecked = job.opponentChecked;
      let opponentBalance = job.siteOpponentBalance;
      if (!opponentChecked) {
        const opp = await this.points.fetchSnapshot(opponentTag).catch(() => null);
        opponentChecked = true;
        inferredOpponentIsFwa =
          opp?.balance !== null && opp?.balance !== undefined && Number.isFinite(opp.balance);
        opponentBalance =
          opp?.balance !== null && opp?.balance !== undefined && Number.isFinite(opp.balance)
            ? opp.balance
            : null;
      }

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
        inferredOpponentIsFwa,
        opponentChecked,
        lastCheckedAtMs: Date.now(),
      });
      if (siteUpdated) {
        const currentWar = await prisma.currentWar.findFirst({
          where: {
            clanTag,
            state: { in: ["preparation", "inWar"] },
            startTime: { not: null },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            guildId: true,
            warId: true,
            startTime: true,
          },
        });
        if (
          currentWar?.guildId &&
          currentWar.startTime &&
          trackedSite !== null &&
          opponentBalance !== null &&
          primary.winnerBoxSync !== null &&
          Number.isFinite(primary.winnerBoxSync)
        ) {
          await this.pointsSync.upsertPointsSync({
            guildId: currentWar.guildId,
            clanTag,
            warId:
              currentWar.warId !== null && Number.isFinite(currentWar.warId)
                ? String(Math.trunc(currentWar.warId))
                : null,
            warStartTime: currentWar.startTime,
            syncNum: Math.trunc(primary.winnerBoxSync),
            opponentTag,
            clanPoints: trackedSite,
            opponentPoints: opponentBalance,
            outcome: deriveExpectedOutcome(
              clanTag,
              opponentTag,
              trackedSite,
              opponentBalance,
              Math.trunc(primary.winnerBoxSync)
            ),
            isFwa: true,
          });
        }
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

