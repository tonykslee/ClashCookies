import { ChannelType, Client, EmbedBuilder } from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";
import { SettingsService } from "./SettingsService";

type WarState = "notInWar" | "preparation" | "inWar";
type EventType = "war_started" | "battle_day" | "war_ended";

function normalizeTag(input: string | null | undefined): string {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}


function deriveState(rawState: string | null | undefined): WarState {
  const state = String(rawState ?? "").toLowerCase();
  if (state.includes("preparation")) return "preparation";
  if (state.includes("inwar")) return "inWar";
  return "notInWar";
}

function eventTitle(eventType: EventType): string {
  if (eventType === "war_started") return "War Started";
  if (eventType === "battle_day") return "Battle Day";
  return "War Ended";
}

function shouldEmit(prev: WarState, next: WarState): EventType | null {
  if (prev === "notInWar" && next === "preparation") return "war_started";
  if ((prev === "preparation" || prev === "notInWar") && next === "inWar") return "battle_day";
  if ((prev === "inWar" || prev === "preparation") && next === "notInWar") return "war_ended";
  return null;
}

function rankChar(ch: string): number {
  const order = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const idx = order.indexOf(ch);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function compareTagsForTiebreak(primaryTag: string, opponentTag: string): number {
  const a = normalizeTag(primaryTag);
  const b = normalizeTag(opponentTag);
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ra = rankChar(a[i] ?? "");
    const rb = rankChar(b[i] ?? "");
    if (ra === rb) continue;
    return ra - rb;
  }
  return 0;
}

function deriveExpectedOutcome(
  clanTag: string,
  opponentTag: string,
  clanPoints: number | null,
  opponentPoints: number | null,
  syncNumber: number | null
): "WIN" | "LOSE" | null {
  if (clanPoints === null || opponentPoints === null) return null;
  if (clanPoints > opponentPoints) return "WIN";
  if (clanPoints < opponentPoints) return "LOSE";
  if (syncNumber === null) return null;
  const mode = syncNumber % 2 === 0 ? "high" : "low";
  const cmp = compareTagsForTiebreak(clanTag, opponentTag);
  if (cmp === 0) return null;
  const wins = mode === "low" ? cmp < 0 : cmp > 0;
  return wins ? "WIN" : "LOSE";
}

export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly settings: SettingsService;
  private static readonly PREVIOUS_SYNC_KEY = "previousSyncNum";
  private static readonly PREVIOUS_SYNC_DEFAULT = 469;

  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.settings = new SettingsService();
  }

  private async getPreviousSyncNum(): Promise<number> {
    const raw = await this.settings.get(WarEventLogService.PREVIOUS_SYNC_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    await this.settings.set(
      WarEventLogService.PREVIOUS_SYNC_KEY,
      String(WarEventLogService.PREVIOUS_SYNC_DEFAULT)
    );
    return WarEventLogService.PREVIOUS_SYNC_DEFAULT;
  }

  private async updatePreviousSyncOnWarEnd(observedSync: number | null): Promise<void> {
    if (observedSync === null || !Number.isFinite(observedSync)) return;
    const current = await this.getPreviousSyncNum();
    const next = Math.max(current, Math.trunc(observedSync));
    if (next !== current) {
      await this.settings.set(WarEventLogService.PREVIOUS_SYNC_KEY, String(next));
    }
  }

  async poll(): Promise<void> {
    type SubRow = {
      id: number;
      guildId: string;
      clanTag: string;
      channelId: string;
      notify: boolean;
      notifyRole: string | null;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: string | null;
      matchType: "FWA" | "BL" | "MM" | null;
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

    const subs = await prisma.$queryRaw<SubRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "WarEventLogSubscription"
        WHERE "notify" = true
        ORDER BY "updatedAt" ASC
      `
    );
    for (const sub of subs) {
      await this.processSubscription(sub.id).catch((err) => {
        console.error(
          `[war-events] process failed guild=${sub.guildId} clan=${sub.clanTag} error=${formatError(
            err
          )}`
        );
      });
    }
  }

  private async processSubscription(subscriptionId: number): Promise<void> {
    type SubRow = {
      id: number;
      guildId: string;
      clanTag: string;
      channelId: string;
      notify: boolean;
      notifyRole: string | null;
      fwaPoints: number | null;
      opponentFwaPoints: number | null;
      outcome: string | null;
      matchType: "FWA" | "BL" | "MM" | null;
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
    const rows = await prisma.$queryRaw<SubRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "WarEventLogSubscription"
        WHERE "id" = ${subscriptionId}
        LIMIT 1
      `
    );
    const sub = rows[0] ?? null;
    if (!sub || !sub.notify) return;

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

    const eventType = shouldEmit(prevState, currentState);
    const previousSync = await this.getPreviousSyncNum();
    const activeSync = previousSync + 1;
    const syncNumberForEvent =
      eventType === "war_ended"
        ? activeSync
        : currentState === "notInWar"
          ? previousSync
          : activeSync;

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
    if (eventType === "war_started") {
      if (
        nextMatchType === null &&
        nextFwaPoints !== null &&
        Number.isFinite(nextFwaPoints) &&
        nextOpponentFwaPoints !== null &&
        Number.isFinite(nextOpponentFwaPoints)
      ) {
        nextMatchType = "FWA";
      }
    }

    if (eventType) {
      if (eventType === "war_ended") {
        await this.updatePreviousSyncOnWarEnd(activeSync);
      }
      await this.emitEvent(sub.channelId, {
        eventType,
        clanTag: sub.clanTag,
        clanName: nextClanName,
        opponentTag: nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? ""),
        opponentName: nextOpponentName || sub.lastOpponentName || "Unknown",
        syncNumber: syncNumberForEvent,
        notifyRole: sub.notifyRole,
        fwaPoints: nextFwaPoints,
        opponentFwaPoints: nextOpponentFwaPoints,
        outcome: nextOutcome,
      });
    }

    await prisma.warEventLogSubscription.update({
      where: { id: sub.id },
      data: {
        lastState: currentState,
        fwaPoints: nextFwaPoints,
        opponentFwaPoints: nextOpponentFwaPoints,
        outcome: nextOutcome,
        matchType: nextMatchType,
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
      outcome: string | null;
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

    const clanTag = normalizeTag(payload.clanTag);
    const opponentTag = normalizeTag(payload.opponentTag);
    const pointsLine =
      payload.fwaPoints !== null && payload.opponentFwaPoints !== null
        ? `Points: ${payload.clanName}: ${payload.fwaPoints} | ${payload.opponentName}: ${payload.opponentFwaPoints}`
        : "Points: unavailable";
    const projection = payload.outcome ? `Projection: ${payload.outcome}` : "Projection: unavailable";

    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(
        payload.eventType === "war_started"
          ? 0x3498db
          : payload.eventType === "battle_day"
            ? 0xf1c40f
            : 0x2ecc71
      )
      .addFields(
        {
          name: "Clan",
          value: `${payload.clanName} (${normalizeTag(payload.clanTag) ? `#${normalizeTag(payload.clanTag)}` : payload.clanTag})`,
          inline: false,
        },
        {
          name: "Opponent",
          value: `${payload.opponentName} (${opponentTag ? `#${opponentTag}` : "unknown"})`,
          inline: false,
        },
        {
          name: "Sync #",
          value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
          inline: true,
        },
        {
          name: "FWA Points",
          value: pointsLine,
          inline: false,
        },
        {
          name: "Which Clan Should Win",
          value: projection,
          inline: false,
        }
      )
      .setTimestamp(new Date());

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
}
