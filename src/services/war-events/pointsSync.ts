import { prisma } from "../../prisma";
import { CoCService } from "../CoCService";
import { PointsProjectionService } from "../PointsProjectionService";
import { SettingsService } from "../SettingsService";
import {
  compareTagsForTiebreak,
  normalizeTag,
  normalizeTagBare,
  sanitizeClanName,
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

type TrackedClanPointsScrape = {
  version: number;
  source: "points.fwafarm";
  fetchedAtMs: number;
  trackedClanName: string | null;
  trackedClanTag: string;
  opponentClanName: string | null;
  opponentClanTag: string | null;
  pointBalance: number | null;
  opponentPointBalance: number | null;
  activeFwa: boolean;
  syncNumber: number | null;
  matchup: string;
  pointsSiteUpToDate: boolean;
};

export type PointsSyncSubscriptionLike = {
  clanTag: string;
  fwaPoints: number | null;
};

/** Purpose: manage previous sync recovery and war-start points-site retry jobs. */
export class WarStartPointsSyncService {
  static readonly PREVIOUS_SYNC_KEY = "previousSyncNum";
  private static readonly WAR_START_POINTS_JOB_PREFIX = "warStartPointsCheck";
  private static readonly WAR_START_POINTS_RECHECK_MS = 30 * 60 * 1000;
  private static readonly WAR_START_POINTS_MAX_ATTEMPTS = 10;

  /** Purpose: initialize points sync service dependencies. */
  constructor(
    private readonly coc: CoCService,
    private readonly points: PointsProjectionService,
    private readonly settings: SettingsService
  ) {}

  /** Purpose: read previous sync from settings or recover it from points site state. */
  async getPreviousSyncNum(): Promise<number | null> {
    const raw = await this.settings.get(WarStartPointsSyncService.PREVIOUS_SYNC_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    return this.recoverPreviousSyncNumFromPoints();
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
        await this.persistTrackedClanPointsScrape({
          trackedClanTag: clanTag,
          trackedClanName: sanitizeClanName(clanNameInput) ?? sanitizeClanName(primary.clanName),
          opponentClanTag: opponentTag,
          opponentClanName: sanitizeClanName(opponentNameInput),
          trackedPoints: trackedSite,
          opponentPoints: opponentBalance,
          syncNumber:
            primary.winnerBoxSync !== null && Number.isFinite(primary.winnerBoxSync)
              ? Math.trunc(primary.winnerBoxSync)
              : null,
          pointsSiteUpToDate: true,
          activeFwa: true,
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

  /** Purpose: recover previous sync by comparing tracked clans and live points-site opponent linkage. */
  private async recoverPreviousSyncNumFromPoints(): Promise<number | null> {
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true },
    });
    for (const clan of tracked) {
      const tag = normalizeTag(clan.tag);
      const war = await this.coc.getCurrentWar(tag).catch(() => null);
      const opponentTag = normalizeTag(war?.opponent?.tag ?? "");
      if (!opponentTag) continue;

      const snapshot = await this.points.fetchSnapshot(tag).catch(() => null);
      if (!snapshot || snapshot.winnerBoxSync === null) continue;

      const siteUpdated = snapshot.winnerBoxTags
        .map((t) => normalizeTag(t))
        .includes(opponentTag);
      const recoveredPrevious = siteUpdated
        ? snapshot.winnerBoxSync - 1
        : snapshot.winnerBoxSync;
      if (!Number.isFinite(recoveredPrevious) || recoveredPrevious < 0) continue;

      const next = Math.trunc(recoveredPrevious);
      await this.settings.set(WarStartPointsSyncService.PREVIOUS_SYNC_KEY, String(next));
      return next;
    }
    return null;
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

  /** Purpose: store points-site key fields into TrackedClan.pointsScrape when site data is confirmed current. */
  private async persistTrackedClanPointsScrape(input: {
    trackedClanTag: string;
    trackedClanName: string | null;
    opponentClanTag: string | null;
    opponentClanName: string | null;
    trackedPoints: number | null;
    opponentPoints: number | null;
    syncNumber: number | null;
    pointsSiteUpToDate: boolean;
    activeFwa: boolean;
  }): Promise<void> {
    const blob: TrackedClanPointsScrape = {
      version: 1,
      source: "points.fwafarm",
      fetchedAtMs: Date.now(),
      trackedClanName: input.trackedClanName?.trim() || null,
      trackedClanTag: normalizeTag(input.trackedClanTag),
      opponentClanName: input.opponentClanName?.trim() || null,
      opponentClanTag: normalizeTag(input.opponentClanTag ?? "") || null,
      pointBalance:
        input.trackedPoints !== null && Number.isFinite(input.trackedPoints)
          ? input.trackedPoints
          : null,
      opponentPointBalance:
        input.opponentPoints !== null && Number.isFinite(input.opponentPoints)
          ? input.opponentPoints
          : null,
      activeFwa: Boolean(input.activeFwa),
      syncNumber:
        input.syncNumber !== null && Number.isFinite(input.syncNumber)
          ? Math.trunc(input.syncNumber)
          : null,
      matchup: this.buildPointsSiteMatchupSummary({
        trackedClanName: input.trackedClanName,
        trackedClanTag: input.trackedClanTag,
        opponentClanName: input.opponentClanName,
        opponentClanTag: input.opponentClanTag,
        trackedPoints: input.trackedPoints,
        opponentPoints: input.opponentPoints,
        syncNumber: input.syncNumber,
        activeFwa: input.activeFwa,
      }),
      pointsSiteUpToDate: input.pointsSiteUpToDate,
    };

    await prisma.trackedClan.updateMany({
      where: { tag: { equals: blob.trackedClanTag, mode: "insensitive" } },
      data: { pointsScrape: blob },
    });
  }

  /** Purpose: compose the points-site matchup evaluation string stored in pointsScrape. */
  private buildPointsSiteMatchupSummary(input: {
    trackedClanName: string | null;
    trackedClanTag: string;
    opponentClanName: string | null;
    opponentClanTag: string | null;
    trackedPoints: number | null;
    opponentPoints: number | null;
    syncNumber: number | null;
    activeFwa: boolean;
  }): string {
    if (!input.activeFwa) return "Not marked as an FWA match.";
    const primaryName = input.trackedClanName ?? normalizeTagBare(input.trackedClanTag);
    const opponentName = input.opponentClanName ?? normalizeTagBare(input.opponentClanTag ?? "");
    const x = input.trackedPoints;
    const y = input.opponentPoints;
    if (
      x === null ||
      y === null ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return "Not marked as an FWA match.";
    }
    if (x > y) return `${primaryName} should win by points (${x} > ${y})`;
    if (x < y) return `${opponentName} should win by points (${x} < ${y})`;
    if (input.syncNumber === null || !Number.isFinite(input.syncNumber)) {
      return "Not marked as an FWA match.";
    }
    const mode = input.syncNumber % 2 === 0 ? "high sync" : "low sync";
    const cmp = compareTagsForTiebreak(input.trackedClanTag, input.opponentClanTag ?? "");
    if (cmp === 0) return "Not marked as an FWA match.";
    const winner =
      mode === "low sync"
        ? cmp < 0
          ? primaryName
          : opponentName
        : cmp > 0
          ? primaryName
          : opponentName;
    return `${winner} should win by tiebreak (${x} = ${y}, ${mode})`;
  }
}

