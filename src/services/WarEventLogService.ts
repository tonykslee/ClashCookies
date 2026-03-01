import {
  ChannelType,
  Client,
  EmbedBuilder,
  GuildBasedChannel,
  PublicThreadChannel,
  PrivateThreadChannel,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { findSyncBadgeEmojiForClan } from "../helper/syncBadgeEmoji";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";
import { SettingsService } from "./SettingsService";
import {
  type EventType,
  type FwaLoseStyle,
  type MatchType,
  type WarComplianceSnapshot,
  type WarEndResultSnapshot,
  type WarState,
  compareTagsForTiebreak,
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
  deriveExpectedOutcome,
  deriveState,
  eventTitle,
  formatList,
  formatPercent,
  normalizeOutcome,
  normalizeTag,
  normalizeTagBare,
  parseCocTime,
  sanitizeClanName,
  shouldEmit,
  toDiscordRelativeTime,
} from "./war-events/core";
export {
  computeWarComplianceForTest,
  computeWarPointsDeltaForTest,
} from "./war-events/core";

type TestSource = "current" | "last";

type SubscriptionRow = {
  id: number;
  guildId: string;
  clanTag: string;
  channelId: string;
  notify: boolean;
  inferredMatchType: boolean;
  notifyRole: string | null;
  fwaPoints: number | null;
  opponentFwaPoints: number | null;
  outcome: string | null;
  matchType: MatchType;
  warStartFwaPoints: number | null;
  warEndFwaPoints: number | null;
  lastClanStars: number | null;
  lastOpponentStars: number | null;
  lastState: string | null;
  lastWarStartTime: Date | null;
  lastOpponentTag: string | null;
  lastOpponentName: string | null;
  clanName: string | null;
};


type PollSyncContext = {
  previousSync: number | null;
  activeSync: number | null;
};

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

/** Purpose: format badge emoji inline. */
function formatBadgeEmojiInline(emoji: { id: string; name: string; animated?: boolean } | null): string {
  if (!emoji) return "Unavailable";
  return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

/** Purpose: parse badge emoji map. */
function parseBadgeEmojiMap(): Record<string, string> {
  const raw = (process.env.WAR_EVENT_BADGE_EMOJI_BY_TAG ?? "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const tag = normalizeTag(key);
      const emoji = String(value ?? "").trim();
      if (!tag || !emoji) continue;
      out[tag] = emoji;
    }
    return out;
  } catch {
    return {};
  }
}


export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly settings: SettingsService;
  private readonly badgeEmojiByTag: Record<string, string>;
  private static readonly PREVIOUS_SYNC_KEY = "previousSyncNum";
  private static readonly WAR_START_POINTS_JOB_PREFIX = "warStartPointsCheck";
  private static readonly WAR_START_POINTS_RECHECK_MS = 30 * 60 * 1000;
  private static readonly WAR_START_POINTS_MAX_ATTEMPTS = 10;

  /** Purpose: initialize service dependencies. */
  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.settings = new SettingsService();
    this.badgeEmojiByTag = parseBadgeEmojiMap();
  }

  /** Purpose: recover previous sync num from points. */
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
      await this.settings.set(WarEventLogService.PREVIOUS_SYNC_KEY, String(next));
      return next;
    }
    return null;
  }

  /** Purpose: get previous sync num. */
  private async getPreviousSyncNum(): Promise<number | null> {
    const raw = await this.settings.get(WarEventLogService.PREVIOUS_SYNC_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    return this.recoverPreviousSyncNumFromPoints();
  }

  /** Purpose: build war start points job key. */
  private buildWarStartPointsJobKey(clanTag: string): string {
    return `${WarEventLogService.WAR_START_POINTS_JOB_PREFIX}:${normalizeTagBare(clanTag)}`;
  }

  /** Purpose: get war start points job. */
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

  /** Purpose: set war start points job. */
  private async setWarStartPointsJob(job: WarStartPointsCheckJob): Promise<void> {
    await this.settings.set(this.buildWarStartPointsJobKey(job.clanTag), JSON.stringify(job));
  }

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
    const winner = mode === "low sync" ? (cmp < 0 ? primaryName : opponentName) : cmp > 0 ? primaryName : opponentName;
    return `${winner} should win by tiebreak (${x} = ${y}, ${mode})`;
  }

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

  private async resetWarStartPointsJob(
    clanTag: string,
    opponentTag: string
  ): Promise<WarStartPointsCheckJob> {
    const now = Date.now();
    const next: WarStartPointsCheckJob = {
      clanTag: normalizeTag(clanTag),
      opponentTag: normalizeTag(opponentTag),
      attempts: 0,
      maxAttempts: WarEventLogService.WAR_START_POINTS_MAX_ATTEMPTS,
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
    return next;
  }

  private async maybeRunWarStartPointsCheck(
    sub: SubscriptionRow,
    opponentTagInput: string,
    clanNameInput: string | null,
    opponentNameInput: string | null
  ): Promise<void> {
    const clanTag = normalizeTag(sub.clanTag);
    const opponentTag = normalizeTag(opponentTagInput);
    if (!clanTag || !opponentTag) return;

    let job = await this.getWarStartPointsJob(clanTag);
    if (!job || normalizeTag(job.opponentTag) !== opponentTag) {
      job = await this.resetWarStartPointsJob(clanTag, opponentTag);
    }
    if (job.completed) return;
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
          : Date.now() + WarEventLogService.WAR_START_POINTS_RECHECK_MS,
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
          : Date.now() + WarEventLogService.WAR_START_POINTS_RECHECK_MS,
        lastCheckedAtMs: Date.now(),
      });
    }
  }

  /** Purpose: poll. */
  async poll(): Promise<void> {
    const previousSync = await this.getPreviousSyncNum();
    const syncContext: PollSyncContext = {
      previousSync,
      activeSync: previousSync === null ? null : previousSync + 1,
    };
    const subs = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "WarEventLogSubscription"
        WHERE "notify" = true
        ORDER BY "updatedAt" ASC
      `
    );
    let sawWarEnded = false;
    for (const sub of subs) {
      const ended = await this.processSubscription(sub.id, syncContext).catch((err) => {
        console.error(
          `[war-events] process failed guild=${sub.guildId} clan=${sub.clanTag} error=${formatError(
            err
          )}`
        );
        return false;
      });
      sawWarEnded = sawWarEnded || ended;
    }
    if (sawWarEnded && syncContext.activeSync !== null) {
      await this.settings.set(
        WarEventLogService.PREVIOUS_SYNC_KEY,
        String(syncContext.activeSync)
      );
    }
  }

  async emitTestEventForClan(params: {
    guildId: string;
    clanTag: string;
    eventType: EventType;
    source: TestSource;
  }): Promise<{ ok: boolean; reason?: string }> {
    const sub = await this.findSubscriptionByGuildAndTag(params.guildId, params.clanTag);
    if (!sub) return { ok: false, reason: "No war event subscription found for that guild+clan." };
    if (!sub.channelId) return { ok: false, reason: "Subscription has no configured channel." };

    const previousSync = await this.getPreviousSyncNum();
    const activeSync = previousSync === null ? null : previousSync + 1;
    const syncNumber = params.source === "last" ? previousSync : activeSync;

    const currentWar =
      params.source === "current"
        ? await this.coc.getCurrentWar(sub.clanTag).catch(() => null)
        : null;
    const lastWarLogEntry =
      params.source === "last"
        ? (await this.coc.getClanWarLog(sub.clanTag, 1))[0] ?? null
        : null;
    const lastWarRow =
      params.source === "last"
        ? await prisma.warHistoryParticipant.findFirst({
            where: { clanTag: normalizeTag(sub.clanTag), warEndTime: { not: null } },
            orderBy: { warStartTime: "desc" },
            select: {
              clanName: true,
              opponentClanTag: true,
              opponentClanName: true,
              warStartTime: true,
            },
          })
        : null;

    const clanTag = normalizeTag(sub.clanTag);
    const opponentTag = normalizeTag(
      currentWar?.opponent?.tag ??
        lastWarLogEntry?.opponent?.tag ??
        lastWarRow?.opponentClanTag ??
        sub.lastOpponentTag ??
        ""
    );
    const clanName =
      String(
        currentWar?.clan?.name ??
          lastWarLogEntry?.clan?.name ??
          lastWarRow?.clanName ??
          sub.clanName ??
          clanTag
      ).trim() || clanTag;
    const opponentName =
      String(
        currentWar?.opponent?.name ??
          lastWarLogEntry?.opponent?.name ??
          lastWarRow?.opponentClanName ??
          sub.lastOpponentName ??
          "Unknown"
      ).trim() ||
      "Unknown";

    let fwaPoints = sub.fwaPoints;
    let opponentFwaPoints = sub.opponentFwaPoints;
    let outcome = normalizeOutcome(sub.outcome);
    if (params.source === "current" && opponentTag) {
      const [a, b] = await Promise.all([
        this.points.fetchSnapshot(clanTag),
        this.points.fetchSnapshot(opponentTag),
      ]);
      fwaPoints = a.balance;
      opponentFwaPoints = b.balance;
      outcome = deriveExpectedOutcome(clanTag, opponentTag, a.balance, b.balance, syncNumber);
    }

    await this.emitEvent(sub.channelId, {
      eventType: params.eventType,
      clanTag,
      clanName,
      opponentTag,
      opponentName,
      syncNumber,
      notifyRole: sub.notifyRole,
      fwaPoints,
      opponentFwaPoints,
      outcome,
      matchType: sub.matchType,
      warStartFwaPoints: sub.warStartFwaPoints,
      warEndFwaPoints: sub.warEndFwaPoints,
      lastClanStars:
        params.source === "last"
          ? Number.isFinite(Number(lastWarLogEntry?.clan?.stars))
            ? Number(lastWarLogEntry?.clan?.stars)
            : sub.lastClanStars
          : Number.isFinite(Number(currentWar?.clan?.stars))
            ? Number(currentWar?.clan?.stars)
            : sub.lastClanStars,
      lastOpponentStars:
        params.source === "last"
          ? Number.isFinite(Number(lastWarLogEntry?.opponent?.stars))
            ? Number(lastWarLogEntry?.opponent?.stars)
            : sub.lastOpponentStars
          : Number.isFinite(Number(currentWar?.opponent?.stars))
            ? Number(currentWar?.opponent?.stars)
            : sub.lastOpponentStars,
      warStartTime: lastWarRow?.warStartTime ?? sub.lastWarStartTime ?? parseCocTime(currentWar?.startTime ?? null),
    });

    return { ok: true };
  }

  private async findSubscriptionByGuildAndTag(
    guildId: string,
    clanTag: string
  ): Promise<SubscriptionRow | null> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "WarEventLogSubscription"
        WHERE "guildId" = ${guildId} AND UPPER(REPLACE("clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `
    );
    return rows[0] ?? null;
  }

  /** Purpose: has war end recorded. */
  private async hasWarEndRecorded(clanTagInput: string, warStartTime: Date): Promise<boolean> {
    const clanTag = normalizeTag(clanTagInput);
    const existing = await prisma.warClanHistory.findUnique({
      where: { clanTag_warStartTime: { clanTag, warStartTime } },
      select: { warId: true },
    });
    return Boolean(existing?.warId);
  }

  /** Purpose: compute bl points delta. */
  private computeBlPointsDelta(finalResult: WarEndResultSnapshot): number {
    if (finalResult.resultLabel === "WIN") return 3;
    if ((finalResult.clanDestruction ?? 0) >= 60) return 2;
    return 1;
  }

  private async processSubscription(
    subscriptionId: number,
    syncContext: PollSyncContext
  ): Promise<boolean> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "WarEventLogSubscription"
        WHERE "id" = ${subscriptionId}
        LIMIT 1
      `
    );
    const sub = rows[0] ?? null;
    if (!sub || !sub.notify) return false;

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    const currentState: WarState = war ? deriveState(String(war.state ?? "")) : "notInWar";
    const prevState: WarState = deriveState(sub.lastState ?? "notInWar");
    const nextClanName =
      String(war?.clan?.name ?? sub.clanName ?? sub.clanTag).trim() || sub.clanTag;
    const nextOpponentTag = normalizeTag(war?.opponent?.tag ?? sub.lastOpponentTag ?? "");
    const nextOpponentName = String(war?.opponent?.name ?? sub.lastOpponentName ?? "").trim() || null;
    const nextWarStartTime = (() => {
      const raw = war?.startTime;
      if (!raw) return sub.lastWarStartTime;
      const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
      if (!m) return sub.lastWarStartTime;
      const [, y, mo, d, h, mi, s] = m;
      return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    })();

    const eventTypeRaw = shouldEmit(prevState, currentState);
    let eventType = eventTypeRaw;
    if (eventType === "war_ended") {
      if (!sub.lastWarStartTime) {
        eventType = null;
      } else if (await this.hasWarEndRecorded(sub.clanTag, sub.lastWarStartTime)) {
        eventType = null;
      }
    }
    const syncNumberForEvent =
      eventType === "war_ended"
        ? syncContext.activeSync
        : currentState === "notInWar"
          ? syncContext.previousSync
          : syncContext.activeSync;
    if (eventType === "war_started" && nextOpponentTag) {
      await this.resetWarStartPointsJob(sub.clanTag, nextOpponentTag).catch(() => null);
    }
    if (currentState !== "notInWar" && nextOpponentTag) {
      await this.maybeRunWarStartPointsCheck(
        sub,
        nextOpponentTag,
        nextClanName,
        nextOpponentName
      ).catch(() => null);
    }

    let nextFwaPoints = sub.fwaPoints;
    let nextOpponentFwaPoints = sub.opponentFwaPoints;
    let nextOutcome = sub.outcome;
    let nextWarStartFwaPoints = sub.warStartFwaPoints;
    let nextWarEndFwaPoints = sub.warEndFwaPoints;
    let nextClanStars =
      Number.isFinite(Number((war as { clan?: { stars?: number } } | null)?.clan?.stars))
        ? Number((war as { clan?: { stars?: number } }).clan?.stars)
        : sub.lastClanStars;
    let nextOpponentStars =
      Number.isFinite(Number((war as { opponent?: { stars?: number } } | null)?.opponent?.stars))
        ? Number((war as { opponent?: { stars?: number } }).opponent?.stars)
        : sub.lastOpponentStars;
    if (nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? "")) {
      const projectionClanTag = sub.clanTag;
      const projectionOpponentTag = nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? "");
      const [a, b] = await Promise.all([
        this.points.fetchSnapshot(projectionClanTag),
        this.points.fetchSnapshot(projectionOpponentTag),
      ]);
      nextFwaPoints = a.balance;
      nextOpponentFwaPoints = b.balance;
      nextOutcome = deriveExpectedOutcome(
        projectionClanTag,
        projectionOpponentTag,
        a.balance,
        b.balance,
        syncNumberForEvent
      );
      if (eventType === "war_started") {
        nextWarStartFwaPoints = a.balance;
      }
      if (eventType === "war_ended") {
        nextWarEndFwaPoints = a.balance;
      }
    }
    let nextMatchType = sub.matchType;
    let nextInferredMatchType = sub.inferredMatchType;
    if (eventType === "war_started") {
      if (
        nextMatchType === null &&
        nextOpponentFwaPoints !== null &&
        Number.isFinite(nextOpponentFwaPoints)
      ) {
        nextMatchType = "FWA";
        nextInferredMatchType = true;
      } else if (
        nextMatchType === null &&
        (nextOpponentFwaPoints === null || !Number.isFinite(nextOpponentFwaPoints))
      ) {
        nextMatchType = "MM";
        nextInferredMatchType = true;
      }
    }
    if (
      eventType === "war_ended" &&
      nextMatchType === null &&
      nextInferredMatchType
    ) {
      nextMatchType =
        nextOpponentFwaPoints !== null && Number.isFinite(nextOpponentFwaPoints)
          ? "FWA"
          : "MM";
    }

    if (eventType === "war_ended" && nextMatchType === "BL") {
      const finalResult = await this.getWarEndResultSnapshot({
        clanTag: sub.clanTag,
        opponentTag: nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? ""),
        fallbackClanStars: nextClanStars,
        fallbackOpponentStars: nextOpponentStars,
        warStartTime: nextWarStartTime,
      });
      const delta = this.computeBlPointsDelta(finalResult);
      const before =
        nextWarStartFwaPoints !== null && Number.isFinite(nextWarStartFwaPoints)
          ? nextWarStartFwaPoints
          : nextFwaPoints !== null && Number.isFinite(nextFwaPoints)
            ? nextFwaPoints
            : null;
      if (before !== null) {
        const after = before + delta;
        nextWarEndFwaPoints = after;
        nextFwaPoints = after;
      }
    }

    if (eventType) {
      const eventPayload = {
        eventType,
        clanTag: sub.clanTag,
        clanName: nextClanName,
        opponentTag: nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? ""),
        opponentName: nextOpponentName || sub.lastOpponentName || "Unknown",
        syncNumber: syncNumberForEvent,
        notifyRole: sub.notifyRole,
        fwaPoints: nextFwaPoints,
        opponentFwaPoints: nextOpponentFwaPoints,
        outcome: normalizeOutcome(nextOutcome),
        matchType: nextMatchType,
        warStartFwaPoints: nextWarStartFwaPoints,
        warEndFwaPoints: nextWarEndFwaPoints,
        lastClanStars: nextClanStars,
        lastOpponentStars: nextOpponentStars,
        warStartTime: nextWarStartTime,
      } as const;

      if (eventType === "war_ended") {
        await this.persistWarEndHistory(eventPayload).catch((err) => {
          console.error(
            `[war-events] persist war history failed guild=${sub.guildId} clan=${sub.clanTag} error=${formatError(err)}`
          );
        });
      }
      await this.emitEvent(sub.channelId, eventPayload);
    }

    await prisma.warEventLogSubscription.update({
      where: { id: sub.id },
      data: {
        lastState: currentState,
        fwaPoints: nextFwaPoints,
        opponentFwaPoints: nextOpponentFwaPoints,
        outcome: nextOutcome,
        matchType: nextMatchType,
        inferredMatchType: nextInferredMatchType,
        warStartFwaPoints: nextWarStartFwaPoints,
        warEndFwaPoints: nextWarEndFwaPoints,
        lastClanStars: nextClanStars,
        lastOpponentStars: nextOpponentStars,
        lastWarStartTime: currentState === "notInWar" ? null : nextWarStartTime,
        lastOpponentTag: nextOpponentTag || sub.lastOpponentTag,
        lastOpponentName: nextOpponentName || sub.lastOpponentName,
        clanName: nextClanName,
        updatedAt: new Date(),
      },
    });
    return eventType === "war_ended";
  }

  private async emitEvent(
    channelId: string,
    payload: {
      eventType: EventType;
      clanTag: string;
      clanName: string;
      opponentTag: string;
      opponentName: string;
      syncNumber: number | null;
      notifyRole: string | null;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: "WIN" | "LOSE" | null;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
      lastClanStars: number | null;
      lastOpponentStars: number | null;
      warStartTime: Date | null;
    }
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    const opponentTag = normalizeTag(payload.opponentTag);
    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(
        payload.eventType === "war_started"
          ? 0x3498db
          : payload.eventType === "battle_day"
            ? 0xf1c40f
            : 0x2ecc71
      )
      .setTimestamp(new Date());

    embed.addFields({
      name: "Opponent",
      value: `${payload.opponentName} (${opponentTag ? `#${opponentTag}` : "unknown"})`,
      inline: false,
    });
    embed.addFields({
      name: "Sync #",
      value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
      inline: true,
    });

    if (payload.eventType === "battle_day") {
      embed.addFields({
        name: "Match Type",
        value: payload.matchType ?? "unknown",
        inline: true,
      });
      if (payload.matchType !== "BL" && payload.matchType !== "MM") {
        const outcome = payload.outcome ? payload.outcome[0] + payload.outcome.slice(1).toLowerCase() : "Unknown";
        embed.addFields({
          name: "Outcome",
          value:
            payload.outcome === null
              ? `Unknown war outcome against ${payload.opponentName}`
              : `${outcome} war against ${payload.opponentName}`,
          inline: false,
        });
        embed.addFields({
          name: "War Plan",
          value: (await this.buildWarPlanText(payload.matchType, payload.outcome, payload.clanTag)) ?? "N/A",
          inline: false,
        });
      }
      if (payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value:
            "Battle day has started! Thank you for your help swapping to war bases, please swap back to FWA bases asap!",
          inline: false,
        });
      }
    }

    if (payload.eventType === "war_started") {
      embed.addFields({
        name: "Prep Day Remaining",
        value: toDiscordRelativeTime(payload.warStartTime),
        inline: true,
      });
      embed.addFields({
        name: "Match Type",
        value: payload.matchType ?? "unknown",
        inline: true,
      });
      if (payload.matchType === "FWA") {
        embed.addFields({
          name: "Outcome",
          value: payload.outcome ?? "unknown",
          inline: false,
        });
        embed.addFields({
          name: "War Plan",
          value: (await this.buildWarPlanText(payload.matchType, payload.outcome, payload.clanTag)) ?? "N/A",
          inline: false,
        });
      }
    }

    if (payload.eventType === "war_ended") {
      const finalResult = await this.getWarEndResultSnapshot({
        clanTag: payload.clanTag,
        opponentTag: payload.opponentTag,
        fallbackClanStars: payload.lastClanStars,
        fallbackOpponentStars: payload.lastOpponentStars,
        warStartTime: payload.warStartTime,
      });
      const compliance = await this.getWarComplianceSnapshot(
        payload.clanTag,
        payload.warStartTime,
        payload.matchType,
        payload.outcome
      );
      embed.addFields({
        name: "Result",
        value: [
          ...(payload.matchType === "BL" ? [] : [`Outcome: **${finalResult.resultLabel}**`]),
          `Stars: **${payload.clanName}** ${finalResult.clanStars ?? "unknown"} | **${payload.opponentName}** ${finalResult.opponentStars ?? "unknown"}`,
          `Destruction: **${payload.clanName}** ${formatPercent(finalResult.clanDestruction)} | **${payload.opponentName}** ${formatPercent(finalResult.opponentDestruction)}`,
        ].join("\n"),
        inline: false,
      });
      embed.addFields({
        name: "FWA Points",
        value: this.buildWarEndPointsLine(payload, finalResult),
        inline: false,
      });
      embed.addFields({
        name: "Missed Both Attacks",
        value: formatList(compliance.missedBoth),
        inline: false,
      });
      embed.addFields({
        name: "Didn't Follow War Plan",
        value:
          payload.matchType === "BL" || payload.matchType === "MM"
            ? "N/A for BL/MM wars"
            : formatList(compliance.notFollowingPlan),
        inline: false,
      });
    }

    const roleMention = payload.notifyRole ? `<@&${payload.notifyRole}>` : null;
    await channel.send({
      content: roleMention ?? undefined,
      embeds: [embed],
      allowedMentions: roleMention ? { roles: [payload.notifyRole as string] } : undefined,
    }).catch((err) => {
      console.error(
        `[war-events] send failed channel=${channelId} clan=${payload.clanTag} error=${formatError(err)}`
      );
    });
  }

  private resolveTrackedClanBadgeEmoji(
    channel: GuildBasedChannel | PublicThreadChannel<boolean> | PrivateThreadChannel,
    clanTag: string,
    clanName: string
  ): string {
    const mapped = this.badgeEmojiByTag[normalizeTag(clanTag)];
    if (mapped) return mapped;

    const fromSyncBadgeMap = findSyncBadgeEmojiForClan(this.client.user?.id, clanName);
    if (fromSyncBadgeMap) {
      return formatBadgeEmojiInline({
        id: fromSyncBadgeMap.id,
        name: fromSyncBadgeMap.name,
      });
    }

    const guild = "guild" in channel ? channel.guild : null;
    if (!guild) return "Unavailable";
    const emojis = [...guild.emojis.cache.values()];
    if (emojis.length === 0) return "Unavailable";

    const normalizedName = clanName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const initials = clanName
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0]?.toLowerCase() ?? "")
      .join("");
    const candidates = new Set<string>([
      normalizeTagBare(clanTag).toLowerCase(),
      normalizedName,
      initials,
    ]);

    for (const emoji of emojis) {
      const rawName = String(emoji.name ?? "").trim();
      if (!rawName) continue;
      const name = rawName.toLowerCase();
      if ([...candidates].some((candidate) => candidate && (name === candidate || name.includes(candidate)))) {
        return formatBadgeEmojiInline({
          id: emoji.id,
          name: rawName,
          animated: emoji.animated === true,
        });
      }
    }
    return "Unavailable";
  }

  private buildWarEndPointsLine(
    payload: {
      clanName: string;
      matchType: MatchType;
      warStartFwaPoints: number | null;
      warEndFwaPoints: number | null;
    },
    finalResult: WarEndResultSnapshot
  ): string {
    const before = payload.warStartFwaPoints;
    const delta = this.computeWarPointsDelta({
      matchType: payload.matchType,
      before,
      after: payload.warEndFwaPoints,
      finalResult,
    });

    if (payload.matchType === "BL") {
      const afterFromRow = payload.warEndFwaPoints;
      const after =
        afterFromRow !== null && Number.isFinite(afterFromRow)
          ? afterFromRow
          : before !== null && Number.isFinite(before) && delta !== null
            ? before + delta
            : null;
      const resolvedBefore =
        before !== null && Number.isFinite(before)
          ? before
          : after !== null && Number.isFinite(after) && delta !== null
            ? after - delta
            : null;
      return `${payload.clanName}: ${resolvedBefore ?? "unknown"} -> ${after ?? "unknown"} (${delta !== null && delta >= 0 ? `+${delta}` : String(delta ?? "unknown")}) [BL]`;
    }

    const after = payload.warEndFwaPoints;
    if (
      before !== null &&
      Number.isFinite(before) &&
      after !== null &&
      Number.isFinite(after)
    ) {
      return `${payload.clanName}: ${before} -> ${after} (${delta !== null && delta >= 0 ? `+${delta}` : String(delta ?? after - before)})`;
    }
    return `${payload.clanName}: ${before ?? "unknown"} -> ${after ?? "unknown"}`;
  }

  private computeWarPointsDelta(input: {
    matchType: MatchType;
    before: number | null;
    after: number | null;
    finalResult: WarEndResultSnapshot;
  }): number | null {
    return computeWarPointsDeltaForTest(input);
  }

  private async buildWarPlanText(
    matchType: MatchType,
    expectedOutcome: "WIN" | "LOSE" | null,
    clanTag: string
  ): Promise<string | null> {
    if (matchType !== "FWA") return null;
    if (expectedOutcome === "WIN") {
      return [
        "Win plan: if clan stars are under 100 and time remaining is over 12h,",
        "one attack must be a 3-star on mirror. Other attack can be 3-star on already-tripled base,",
        "or 2-star/1-star any base. Outside that window, free hit plan applies.",
      ].join(" ");
    }
    if (expectedOutcome === "LOSE") {
      const loseStyle = await this.getLoseStyleForClan(normalizeTag(clanTag));
      if (loseStyle === "TRIPLE_TOP_30") {
        return "Lose plan (Triple Top 30): hit only top 30 bases with both attacks; do not hit bottom 20.";
      }
      return [
        "Lose plan (Traditional): when under 12h remaining, do mirror 2-star plus non-mirror 1-star.",
        "Before that, do 1-star/2-star hits while keeping clan stars at or under 100.",
      ].join(" ");
    }
    return "FWA plan unavailable (expected outcome unknown).";
  }

  /** Purpose: get lose style for clan. */
  private async getLoseStyleForClan(clanTagInput: string): Promise<FwaLoseStyle> {
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return "TRIPLE_TOP_30";
    const row = await prisma.trackedClan.findUnique({
      where: { tag: clanTag },
      select: { loseStyle: true },
    });
    const loseStyle = String(row?.loseStyle ?? "").toUpperCase();
    if (loseStyle === "TRADITIONAL" || loseStyle === "TRIPLE_TOP_30") {
      return loseStyle;
    }
    return "TRIPLE_TOP_30";
  }

  private async persistWarEndHistory(payload: {
    eventType: EventType;
    clanTag: string;
    clanName: string;
    opponentTag: string;
    opponentName: string;
    syncNumber: number | null;
    notifyRole: string | null;
    fwaPoints: number | null;
    opponentFwaPoints: number | null;
    outcome: "WIN" | "LOSE" | null;
    matchType: MatchType;
    warStartFwaPoints: number | null;
    warEndFwaPoints: number | null;
    lastClanStars: number | null;
    lastOpponentStars: number | null;
    warStartTime: Date | null;
  }): Promise<void> {
    if (payload.eventType !== "war_ended") return;

    const clanTag = normalizeTag(payload.clanTag);
    const warStartTime =
      payload.warStartTime ??
      (
        await prisma.warHistoryParticipant.findFirst({
          where: { clanTag, warEndTime: { not: null } },
          orderBy: { warStartTime: "desc" },
          select: { warStartTime: true },
        })
      )?.warStartTime ??
      null;
    if (!warStartTime) return;

    const finalResult = await this.getWarEndResultSnapshot({
      clanTag: payload.clanTag,
      opponentTag: payload.opponentTag,
      fallbackClanStars: payload.lastClanStars,
      fallbackOpponentStars: payload.lastOpponentStars,
      warStartTime,
    });
    const attacks = await prisma.warHistoryAttack.findMany({
      where: { clanTag, warStartTime },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const warEndTime =
      finalResult.warEndTime ??
      (await prisma.warHistoryParticipant.findFirst({
        where: { clanTag, warStartTime },
        orderBy: { updatedAt: "desc" },
        select: { warEndTime: true },
      }))?.warEndTime ??
      null;

    const pointsDelta = this.computeWarPointsDelta({
      matchType: payload.matchType,
      before: payload.warStartFwaPoints,
      after: payload.warEndFwaPoints,
      finalResult,
    });
    const enemyPoints =
      payload.matchType === "FWA" &&
      payload.opponentFwaPoints !== null &&
      Number.isFinite(payload.opponentFwaPoints)
        ? payload.opponentFwaPoints
        : null;

    const row = await prisma.$queryRaw<Array<{ warId: number }>>(
      Prisma.sql`
        INSERT INTO "WarClanHistory"
          ("syncNumber","matchType","clanStars","clanDestruction","opponentStars","opponentDestruction","fwaPointsGained","expectedOutcome","actualOutcome","enemyPoints","warStartTime","warEndTime","clanName","clanTag","opponentName","opponentTag","updatedAt")
        VALUES
          (${payload.syncNumber}, ${payload.matchType}, ${finalResult.clanStars}, ${finalResult.clanDestruction}, ${finalResult.opponentStars}, ${finalResult.opponentDestruction}, ${pointsDelta}, ${payload.outcome}, ${finalResult.resultLabel}, ${enemyPoints}, ${warStartTime}, ${warEndTime}, ${payload.clanName}, ${clanTag}, ${payload.opponentName}, ${normalizeTag(payload.opponentTag) || null}, NOW())
        ON CONFLICT ("clanTag","warStartTime")
        DO UPDATE SET
          "syncNumber" = EXCLUDED."syncNumber",
          "matchType" = EXCLUDED."matchType",
          "clanStars" = EXCLUDED."clanStars",
          "clanDestruction" = EXCLUDED."clanDestruction",
          "opponentStars" = EXCLUDED."opponentStars",
          "opponentDestruction" = EXCLUDED."opponentDestruction",
          "fwaPointsGained" = EXCLUDED."fwaPointsGained",
          "expectedOutcome" = EXCLUDED."expectedOutcome",
          "actualOutcome" = EXCLUDED."actualOutcome",
          "enemyPoints" = EXCLUDED."enemyPoints",
          "warEndTime" = EXCLUDED."warEndTime",
          "clanName" = EXCLUDED."clanName",
          "opponentName" = EXCLUDED."opponentName",
          "opponentTag" = EXCLUDED."opponentTag",
          "updatedAt" = NOW()
        RETURNING "warId"
      `
    );
    const warId = Number(row[0]?.warId ?? NaN);
    if (!Number.isFinite(warId)) return;

    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "WarLookup" ("warId","payload","updatedAt")
        VALUES (${warId}, ${JSON.stringify(attacks)}::jsonb, NOW())
        ON CONFLICT ("warId")
        DO UPDATE SET
          "payload" = EXCLUDED."payload",
          "updatedAt" = NOW()
      `
    );
  }

  private async getWarEndResultSnapshot(input: {
    clanTag: string;
    opponentTag: string;
    fallbackClanStars: number | null;
    fallbackOpponentStars: number | null;
    warStartTime: Date | null;
  }): Promise<WarEndResultSnapshot> {
    const log = await this.coc.getClanWarLog(input.clanTag, 10);
    const normalizedOpponentTag = normalizeTag(input.opponentTag);

    const matched =
      log.find((entry) => normalizeTag(entry.opponent?.tag ?? "") === normalizedOpponentTag) ??
      log[0] ??
      null;

    const clanStars =
      Number.isFinite(Number(matched?.clan?.stars))
        ? Number(matched?.clan?.stars)
        : input.fallbackClanStars;
    const opponentStars =
      Number.isFinite(Number(matched?.opponent?.stars))
        ? Number(matched?.opponent?.stars)
        : input.fallbackOpponentStars;
    const clanDestruction = Number.isFinite(Number(matched?.clan?.destructionPercentage))
      ? Number(matched?.clan?.destructionPercentage)
      : null;
    const opponentDestruction = Number.isFinite(Number(matched?.opponent?.destructionPercentage))
      ? Number(matched?.opponent?.destructionPercentage)
      : null;
    const warEndTime = parseCocTime(matched?.endTime ?? null);

    let resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN" = "UNKNOWN";
    if (clanStars !== null && opponentStars !== null) {
      resultLabel = clanStars > opponentStars ? "WIN" : clanStars < opponentStars ? "LOSE" : "TIE";
    } else if (matched?.result) {
      const result = String(matched.result).toLowerCase();
      if (result.includes("win")) resultLabel = "WIN";
      else if (result.includes("lose")) resultLabel = "LOSE";
      else if (result.includes("tie")) resultLabel = "TIE";
    }

    return {
      clanStars,
      opponentStars,
      clanDestruction,
      opponentDestruction,
      warEndTime,
      resultLabel,
    };
  }

  private async getWarComplianceSnapshot(
    clanTagInput: string,
    preferredWarStartTime: Date | null,
    matchType: MatchType,
    expectedOutcome: "WIN" | "LOSE" | null
  ): Promise<WarComplianceSnapshot> {
    if (matchType === "BL" || matchType === "MM") {
      return { missedBoth: [], notFollowingPlan: [] };
    }
    const clanTag = normalizeTag(clanTagInput);
    const warStartTime = preferredWarStartTime
      ? preferredWarStartTime
      : (
          await prisma.warHistoryParticipant.findFirst({
            where: { clanTag, warEndTime: { not: null } },
            orderBy: { warStartTime: "desc" },
            select: { warStartTime: true },
          })
        )?.warStartTime ?? null;
    if (!warStartTime) {
      return { missedBoth: [], notFollowingPlan: [] };
    }

    const participants = await prisma.warHistoryParticipant.findMany({
      where: { clanTag, warStartTime },
      select: { playerName: true, playerTag: true, attacksUsed: true, playerPosition: true },
      orderBy: [{ playerPosition: "asc" }, { playerName: "asc" }],
    });
    const attacks = await prisma.warHistoryAttack.findMany({
      where: { clanTag, warStartTime },
      select: {
        playerTag: true,
        playerName: true,
        playerPosition: true,
        defenderPosition: true,
        stars: true,
        trueStars: true,
        attackSeenAt: true,
        warEndTime: true,
        attackOrder: true,
      },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const loseStyle = await this.getLoseStyleForClan(clanTag);
    return computeWarComplianceForTest({
      clanTag,
      participants,
      attacks,
      matchType,
      expectedOutcome,
      loseStyle,
    });
  }
}
