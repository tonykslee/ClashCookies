import { ChannelType, Client, EmbedBuilder } from "discord.js";
import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";

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

export class WarEventLogService {
  private readonly points: PointsProjectionService;

  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
  }

  async poll(): Promise<void> {
    type SubRow = {
      id: number;
      guildId: string;
      clanTag: string;
      channelId: string;
      enabled: boolean;
      currentSyncNumber: number | null;
      lastState: string | null;
      lastWarStartTime: Date | null;
      lastOpponentTag: string | null;
      lastOpponentName: string | null;
      lastClanName: string | null;
    };

    const subs = await prisma.$queryRaw<SubRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","enabled","currentSyncNumber","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","lastClanName"
        FROM "WarEventLogSubscription"
        WHERE "enabled" = true
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
      enabled: boolean;
      currentSyncNumber: number | null;
      lastState: string | null;
      lastWarStartTime: Date | null;
      lastOpponentTag: string | null;
      lastOpponentName: string | null;
      lastClanName: string | null;
    };
    const rows = await prisma.$queryRaw<SubRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","enabled","currentSyncNumber","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","lastClanName"
        FROM "WarEventLogSubscription"
        WHERE "id" = ${subscriptionId}
        LIMIT 1
      `
    );
    const sub = rows[0] ?? null;
    if (!sub || !sub.enabled) return;

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    const currentState: WarState = war ? deriveState(String(war.state ?? "")) : "notInWar";
    const prevState: WarState = deriveState(sub.lastState ?? "notInWar");
    const nextClanName =
      String(war?.clan?.name ?? sub.lastClanName ?? sub.clanTag).trim() || sub.clanTag;
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
    const nextSyncNumber =
      eventType === "war_started"
        ? Math.max(1, Number(sub.currentSyncNumber ?? 0) + 1)
        : sub.currentSyncNumber;
    if (eventType) {
      await this.emitEvent(sub.channelId, {
        eventType,
        clanTag: sub.clanTag,
        clanName: nextClanName,
        opponentTag: nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? ""),
        opponentName: nextOpponentName || sub.lastOpponentName || "Unknown",
        syncNumber: nextSyncNumber,
      });
    }

    await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "WarEventLogSubscription"
        SET
          "lastState" = ${currentState},
          "currentSyncNumber" = ${nextSyncNumber},
          "lastWarStartTime" = ${currentState === "notInWar" ? null : nextWarStartTime},
          "lastOpponentTag" = ${nextOpponentTag || sub.lastOpponentTag},
          "lastOpponentName" = ${nextOpponentName || sub.lastOpponentName},
          "lastClanName" = ${nextClanName},
          "updatedAt" = NOW()
        WHERE "id" = ${sub.id}
      `
    );
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
    let pointsLine = "Points: unavailable";
    let projection = "Projection: unavailable";
    if (clanTag && opponentTag) {
      const [a, b] = await Promise.all([
        this.points.fetchSnapshot(clanTag),
        this.points.fetchSnapshot(opponentTag),
      ]);
      pointsLine = `Points: ${this.points.formatBalanceLine(a, b)}`;
      projection = `Projection: ${this.points.buildProjection(a, b)}`;
    }

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

    await channel.send({ embeds: [embed] }).catch((err) => {
      console.error(
        `[war-events] send failed channel=${channelId} clan=${payload.clanTag} error=${formatError(err)}`
      );
    });
  }
}
