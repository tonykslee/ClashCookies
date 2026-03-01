import {
  ChannelType,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";
import { SettingsService } from "./SettingsService";
import { WarEventHistoryService } from "./war-events/history";
import { WarStartPointsSyncService } from "./war-events/pointsSync";
import {
  type EventType,
  type MatchType,
  type WarEndResultSnapshot,
  type WarState,
  deriveExpectedOutcome,
  deriveState,
  eventTitle,
  formatList,
  formatPercent,
  normalizeOutcome,
  normalizeTag,
  normalizeTagBare,
  parseCocTime,
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
  pingRole: boolean;
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


export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly settings: SettingsService;
  private readonly pointsSync: WarStartPointsSyncService;
  private readonly history: WarEventHistoryService;

  /** Purpose: initialize service dependencies. */
  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.settings = new SettingsService();
    this.pointsSync = new WarStartPointsSyncService(coc, this.points, this.settings);
    this.history = new WarEventHistoryService(coc);
  }

  /** Purpose: poll. */
  async poll(): Promise<void> {
    const previousSync = await this.pointsSync.getPreviousSyncNum();
    const syncContext: PollSyncContext = {
      previousSync,
      activeSync: previousSync === null ? null : previousSync + 1,
    };
    const subs = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
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
        WarStartPointsSyncService.PREVIOUS_SYNC_KEY,
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

    const previousSync = await this.pointsSync.getPreviousSyncNum();
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
      pingRole: sub.pingRole,
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
          "id","guildId","clanTag","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
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
          "id","guildId","clanTag","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
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
      await this.pointsSync.resetWarStartPointsJob(sub.clanTag, nextOpponentTag).catch(() => null);
    }
    if (currentState !== "notInWar" && nextOpponentTag) {
      await this.pointsSync.maybeRunWarStartPointsCheck(
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
      const finalResult = await this.history.getWarEndResultSnapshot({
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
        pingRole: sub.pingRole,
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
        await this.history.persistWarEndHistory(eventPayload).catch((err) => {
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
      pingRole: boolean;
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
          value: (await this.history.buildWarPlanText(payload.matchType, payload.outcome, payload.clanTag)) ?? "N/A",
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
          value: (await this.history.buildWarPlanText(payload.matchType, payload.outcome, payload.clanTag)) ?? "N/A",
          inline: false,
        });
      }
    }

    if (payload.eventType === "war_ended") {
      const finalResult = await this.history.getWarEndResultSnapshot({
        clanTag: payload.clanTag,
        opponentTag: payload.opponentTag,
        fallbackClanStars: payload.lastClanStars,
        fallbackOpponentStars: payload.lastOpponentStars,
        warStartTime: payload.warStartTime,
      });
      const compliance = await this.history.getWarComplianceSnapshot(
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
        value: this.history.buildWarEndPointsLine(payload, finalResult),
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

    const roleMention =
      payload.pingRole && payload.notifyRole ? `<@&${payload.notifyRole}>` : null;
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

}
