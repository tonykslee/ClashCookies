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
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { PointsProjectionService } from "./PointsProjectionService";
import { SettingsService } from "./SettingsService";

type WarState = "notInWar" | "preparation" | "inWar";
type EventType = "war_started" | "battle_day" | "war_ended";
type MatchType = "FWA" | "BL" | "MM" | null;
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

type WarEndResultSnapshot = {
  clanStars: number | null;
  opponentStars: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
  resultLabel: "WIN" | "LOSE" | "TIE" | "UNKNOWN";
};

type WarComplianceSnapshot = {
  missedBoth: string[];
  notFollowingPlan: string[];
};

function normalizeTag(input: string | null | undefined): string {
  const raw = String(input ?? "").trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function normalizeTagBare(input: string | null | undefined): string {
  return normalizeTag(input).replace(/^#/, "");
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

function parseCocTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.\d{3}Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

function normalizeOutcome(input: string | null | undefined): "WIN" | "LOSE" | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (normalized === "WIN" || normalized === "LOSE") return normalized;
  return null;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return `${value.toFixed(2)}%`;
}

function formatList(items: string[]): string {
  if (items.length === 0) return "None";
  const capped = items.slice(0, 15);
  const extra = items.length - capped.length;
  return extra > 0 ? `${capped.join(", ")} (+${extra} more)` : capped.join(", ");
}

function formatBadgeEmojiInline(emoji: { id: string; name: string; animated?: boolean } | null): string {
  if (!emoji) return "Unavailable";
  return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
}

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
  private static readonly PREVIOUS_SYNC_DEFAULT = 469;

  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.settings = new SettingsService();
    this.badgeEmojiByTag = parseBadgeEmojiMap();
  }

  private static getDefaultPreviousSyncNum(): number {
    const raw = process.env.DEFAULT_PREVIOUS_SYNC_NUM?.trim() ?? "";
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    return WarEventLogService.PREVIOUS_SYNC_DEFAULT;
  }

  private async getPreviousSyncNum(): Promise<number> {
    const raw = await this.settings.get(WarEventLogService.PREVIOUS_SYNC_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
    const fallback = WarEventLogService.getDefaultPreviousSyncNum();
    await this.settings.set(
      WarEventLogService.PREVIOUS_SYNC_KEY,
      String(fallback)
    );
    return fallback;
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
    const subs = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","channelId","notify","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
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
    const activeSync = previousSync + 1;
    const syncNumber = params.eventType === "war_ended" ? activeSync : activeSync;

    const currentWar = params.source === "current" ? await this.coc.getCurrentWar(sub.clanTag).catch(() => null) : null;
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
      currentWar?.opponent?.tag ?? lastWarRow?.opponentClanTag ?? sub.lastOpponentTag ?? ""
    );
    const clanName =
      String(currentWar?.clan?.name ?? lastWarRow?.clanName ?? sub.clanName ?? clanTag).trim() || clanTag;
    const opponentName =
      String(currentWar?.opponent?.name ?? lastWarRow?.opponentClanName ?? sub.lastOpponentName ?? "Unknown").trim() ||
      "Unknown";

    let fwaPoints = sub.fwaPoints;
    let opponentFwaPoints = sub.opponentFwaPoints;
    let outcome = normalizeOutcome(sub.outcome);
    if (opponentTag) {
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
      lastClanStars: Number.isFinite(Number(currentWar?.clan?.stars))
        ? Number(currentWar?.clan?.stars)
        : sub.lastClanStars,
      lastOpponentStars: Number.isFinite(Number(currentWar?.opponent?.stars))
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

  private async processSubscription(subscriptionId: number): Promise<void> {
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
        outcome: normalizeOutcome(nextOutcome),
        matchType: nextMatchType,
        warStartFwaPoints: nextWarStartFwaPoints,
        warEndFwaPoints: nextWarEndFwaPoints,
        lastClanStars: nextClanStars,
        lastOpponentStars: nextOpponentStars,
        warStartTime: nextWarStartTime,
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
    const badgeEmoji = this.resolveTrackedClanBadgeEmoji(channel, payload.clanTag, payload.clanName);

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
        name: "Clan Badge",
        value: badgeEmoji,
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
      }
    }

    if (payload.eventType === "war_started") {
      embed.addFields({
        name: "Clan Badge",
        value: badgeEmoji,
        inline: true,
      });
    }

    if (payload.eventType === "war_ended") {
      const finalResult = await this.getWarEndResultSnapshot({
        clanTag: payload.clanTag,
        opponentTag: payload.opponentTag,
        fallbackClanStars: payload.lastClanStars,
        fallbackOpponentStars: payload.lastOpponentStars,
        warStartTime: payload.warStartTime,
      });
      const compliance = await this.getWarComplianceSnapshot(payload.clanTag, payload.warStartTime);
      embed.addFields({
        name: "Result",
        value: [
          `Outcome: **${finalResult.resultLabel}**`,
          `Stars: ${payload.clanName} ${finalResult.clanStars ?? "unknown"} - ${payload.opponentName} ${finalResult.opponentStars ?? "unknown"}`,
          `Destruction: ${payload.clanName} ${formatPercent(finalResult.clanDestruction)} - ${payload.opponentName} ${formatPercent(finalResult.opponentDestruction)}`,
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
        value: formatList(compliance.notFollowingPlan),
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

    if (payload.matchType === "BL") {
      const gained =
        finalResult.resultLabel === "WIN"
          ? 3
          : (finalResult.clanDestruction ?? 0) >= 60
            ? 2
            : 1;
      const after = before !== null && Number.isFinite(before) ? before + gained : null;
      return `${payload.clanName}: ${before ?? "unknown"} -> ${after ?? "unknown"} (${gained >= 0 ? `+${gained}` : String(gained)}) [BL]`;
    }

    const after = payload.warEndFwaPoints;
    if (
      before !== null &&
      Number.isFinite(before) &&
      after !== null &&
      Number.isFinite(after)
    ) {
      const delta = after - before;
      return `${payload.clanName}: ${before} -> ${after} (${delta >= 0 ? `+${delta}` : String(delta)})`;
    }
    return `${payload.clanName}: ${before ?? "unknown"} -> ${after ?? "unknown"}`;
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
      resultLabel,
    };
  }

  private async getWarComplianceSnapshot(
    clanTagInput: string,
    preferredWarStartTime: Date | null
  ): Promise<WarComplianceSnapshot> {
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
      select: { playerTag: true, playerName: true, playerPosition: true, defenderPosition: true },
    });

    const missedBoth = participants
      .filter((p) => Number(p.attacksUsed ?? 0) <= 0)
      .map((p) => String(p.playerName ?? p.playerTag).trim())
      .filter(Boolean);

    const notFollowing = new Set<string>();
    for (const attack of attacks) {
      const playerPos = attack.playerPosition ?? null;
      const defenderPos = attack.defenderPosition ?? null;
      if (playerPos === null || defenderPos === null) continue;
      if (playerPos !== defenderPos) {
        const label = String(attack.playerName ?? attack.playerTag).trim();
        if (label) notFollowing.add(label);
      }
    }

    return {
      missedBoth,
      notFollowingPlan: [...notFollowing].sort((a, b) => a.localeCompare(b)),
    };
  }
}
