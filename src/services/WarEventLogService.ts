import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
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

const NOTIFY_WAR_REFRESH_PREFIX = "notify-war-refresh";
const BATTLE_DAY_REFRESH_MS = 20 * 60 * 1000;
const battleDayPostByGuildTag = new Map<string, { channelId: string; messageId: string }>();

function buildNextRefreshRelativeLabel(intervalMs: number): string {
  return `Next refresh <t:${Math.floor((Date.now() + intervalMs) / 1000)}:R>`;
}

type TestSource = "current" | "last";

type SubscriptionRow = {
  id: number;
  guildId: string;
  clanTag: string;
  warId: number | null;
  currentSyncNum: number | null;
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

type EmbedWarStats = {
  clanStars: number | null;
  opponentStars: number | null;
  clanAttacks: number | null;
  opponentAttacks: number | null;
  teamSize: number | null;
  attacksPerMember: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
};

type EventEmitPayload = {
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
  warEndTime: Date | null;
  clanAttacks: number | null;
  opponentAttacks: number | null;
  teamSize: number | null;
  attacksPerMember: number | null;
  clanDestruction: number | null;
  opponentDestruction: number | null;
  testFinalResultOverride?: WarEndResultSnapshot | null;
};

export type NotifyWarPreviewResult = {
  ok: boolean;
  reason?: string;
  clanName?: string;
  clanTag?: string;
  channelId?: string;
  embeds?: EmbedBuilder[];
};

/** Purpose: detect if current poll belongs to a newer war cycle than the stored snapshot. */
function isNewWarCycle(
  previousWarStartTime: Date | null,
  nextWarStartTime: Date | null
): boolean {
  if (!(nextWarStartTime instanceof Date) || Number.isNaN(nextWarStartTime.getTime())) return false;
  if (!(previousWarStartTime instanceof Date) || Number.isNaN(previousWarStartTime.getTime())) return true;
  return nextWarStartTime.getTime() !== previousWarStartTime.getTime();
}

function deriveResultLabelFromStars(
  clanStars: number | null,
  opponentStars: number | null
): "WIN" | "LOSE" | "TIE" | "UNKNOWN" {
  if (clanStars === null || opponentStars === null) return "UNKNOWN";
  if (clanStars > opponentStars) return "WIN";
  if (clanStars < opponentStars) return "LOSE";
  return "TIE";
}

function formatResultLabelForEmbed(
  result: "WIN" | "LOSE" | "TIE" | "UNKNOWN"
): "WIN" | "LOSS" | "DRAW" | "UNKNOWN" {
  if (result === "WIN") return "WIN";
  if (result === "LOSE") return "LOSS";
  if (result === "TIE") return "DRAW";
  return "UNKNOWN";
}

function makeBattleDayPostKey(guildId: string, clanTag: string): string {
  return `${guildId}:${normalizeTag(clanTag)}`;
}

function formatWarStatCellLeft(value: string): string {
  return value.padStart(10, " ");
}

function formatWarStatCellRight(value: string): string {
  return value.padEnd(10, " ");
}

function formatWarStatLine(left: string, emoji: string, right: string): string {
  return `\`${formatWarStatCellLeft(left)}\` ${emoji} \`${formatWarStatCellRight(right)}\``;
}

function formatWarInt(input: unknown): string {
  const value = Number(input);
  if (!Number.isFinite(value)) return "?";
  return String(Math.max(0, Math.trunc(value)));
}

function formatWarPercent(input: unknown): string {
  const value = Number(input);
  if (!Number.isFinite(value)) return "?";
  const rounded = Math.round(value * 100) / 100;
  const withPrecision = Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(2)}`;
  return `${withPrecision.replace(/\.00$/, "")}%`;
}

function buildWarStatsLines(stats: EmbedWarStats): string[] {
  const starsLeft = formatWarInt(stats.clanStars);
  const starsRight = formatWarInt(stats.opponentStars);
  const attacksPerMember = Number.isFinite(Number(stats.attacksPerMember))
    ? Math.max(1, Math.trunc(Number(stats.attacksPerMember)))
    : 2;
  const teamSize = Number.isFinite(Number(stats.teamSize))
    ? Math.max(1, Math.trunc(Number(stats.teamSize)))
    : 0;
  const totalAttacks = teamSize > 0 ? teamSize * attacksPerMember : 0;
  const attacksLeft = formatWarInt(stats.clanAttacks);
  const attacksRight = formatWarInt(stats.opponentAttacks);
  const attacksLeftText = totalAttacks > 0 ? `${attacksLeft}/${totalAttacks}` : `${attacksLeft}/?`;
  const attacksRightText = totalAttacks > 0 ? `${attacksRight}/${totalAttacks}` : `${attacksRight}/?`;
  return [
    "War Stats",
    formatWarStatLine(starsLeft, ":star:", starsRight),
    formatWarStatLine(attacksLeftText, ":crossed_swords:", attacksRightText),
    formatWarStatLine(formatWarPercent(stats.clanDestruction), ":boom:", formatWarPercent(stats.opponentDestruction)),
  ];
}

export class WarEventLogService {
  private readonly points: PointsProjectionService;
  private readonly pointsSync: WarStartPointsSyncService;
  private readonly history: WarEventHistoryService;

  /** Purpose: initialize service dependencies. */
  constructor(private readonly client: Client, private readonly coc: CoCService) {
    this.points = new PointsProjectionService(coc);
    this.pointsSync = new WarStartPointsSyncService(this.points, new SettingsService());
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
          "id","guildId","clanTag","warId","currentSyncNum","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "CurrentWar"
        ORDER BY "updatedAt" ASC
      `
    );
    for (const sub of subs) {
      await this.processSubscription(sub.id, syncContext).catch((err) => {
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
    const payload = await this.buildTestEventPayload(sub, params);
    await this.emitEvent(sub.channelId, payload);

    return { ok: true };
  }

  async buildTestEventPreviewForClan(params: {
    guildId: string;
    clanTag: string;
    eventType: EventType;
    source: TestSource;
  }): Promise<NotifyWarPreviewResult> {
    const sub = await this.findSubscriptionByGuildAndTag(params.guildId, params.clanTag);
    if (!sub) return { ok: false, reason: "No war event subscription found for that guild+clan." };
    if (!sub.channelId) return { ok: false, reason: "Subscription has no configured channel." };

    const payload = await this.buildTestEventPayload(sub, params);
    const warId = await this.resolveWarId(payload.clanTag, payload.warStartTime);
    const message = await this.buildEventMessage(payload, params.guildId, {
      includeRoleMention: false,
      includeEventComponents: false,
      warId,
    });
    return {
      ok: true,
      clanName: payload.clanName,
      clanTag: payload.clanTag,
      channelId: sub.channelId,
      embeds: message.embeds,
    };
  }

  private async buildTestEventPayload(
    sub: SubscriptionRow,
    params: { eventType: EventType; source: TestSource }
  ): Promise<EventEmitPayload> {
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
        ? await prisma.warAttacks.findFirst({
            where: { clanTag: normalizeTag(sub.clanTag), warEndTime: { not: null }, attackOrder: 0 },
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
      ).trim() || "Unknown";

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

    const currentWarStartTime = parseCocTime(currentWar?.startTime ?? null);
    const testWarStartTime =
      params.source === "current"
        ? currentWarStartTime ?? sub.lastWarStartTime
        : lastWarRow?.warStartTime ?? sub.lastWarStartTime ?? currentWarStartTime;
    const currentClanStars = Number.isFinite(Number(currentWar?.clan?.stars))
      ? Number(currentWar?.clan?.stars)
      : sub.lastClanStars;
    const currentOpponentStars = Number.isFinite(Number(currentWar?.opponent?.stars))
      ? Number(currentWar?.opponent?.stars)
      : sub.lastOpponentStars;
    const testFinalResultOverride: WarEndResultSnapshot | null =
      params.source === "current" && params.eventType === "war_ended"
        ? {
            clanStars: currentClanStars,
            opponentStars: currentOpponentStars,
            clanDestruction: Number.isFinite(Number(currentWar?.clan?.destructionPercentage))
              ? Number(currentWar?.clan?.destructionPercentage)
              : null,
            opponentDestruction: Number.isFinite(Number(currentWar?.opponent?.destructionPercentage))
              ? Number(currentWar?.opponent?.destructionPercentage)
              : null,
            warEndTime: new Date(),
            resultLabel: deriveResultLabelFromStars(currentClanStars, currentOpponentStars),
          }
        : null;
    const testWarStartFwaPoints =
      params.source === "current" ? sub.warStartFwaPoints ?? fwaPoints : sub.warStartFwaPoints;
    let testWarEndFwaPoints = sub.warEndFwaPoints;
    if (params.source === "current" && params.eventType === "war_ended") {
      if (sub.matchType === "BL" && testFinalResultOverride) {
        const before = testWarStartFwaPoints ?? fwaPoints;
        const delta = this.computeBlPointsDelta(testFinalResultOverride);
        testWarEndFwaPoints = before !== null && Number.isFinite(before) ? before + delta : null;
      } else if (sub.matchType === "FWA" && testFinalResultOverride) {
        const before = testWarStartFwaPoints ?? fwaPoints;
        const delta = this.computeTestFwaPointsDelta(testFinalResultOverride);
        testWarEndFwaPoints = before !== null && Number.isFinite(before) ? before + delta : null;
      } else if (sub.matchType === "MM") {
        const before = testWarStartFwaPoints ?? fwaPoints;
        testWarEndFwaPoints = before !== null && Number.isFinite(before) ? before : fwaPoints;
      } else {
        testWarEndFwaPoints = fwaPoints;
      }
    }

    return {
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
      warStartFwaPoints: testWarStartFwaPoints,
      warEndFwaPoints: testWarEndFwaPoints,
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
      warStartTime: testWarStartTime,
      warEndTime: parseCocTime(currentWar?.endTime ?? null),
      clanAttacks: Number.isFinite(Number(currentWar?.clan?.attacks))
        ? Number(currentWar?.clan?.attacks)
        : null,
      opponentAttacks: Number.isFinite(Number(currentWar?.opponent?.attacks))
        ? Number(currentWar?.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(currentWar?.teamSize)) ? Number(currentWar?.teamSize) : null,
      attacksPerMember: Number.isFinite(Number(currentWar?.attacksPerMember))
        ? Number(currentWar?.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(currentWar?.clan?.destructionPercentage))
        ? Number(currentWar?.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(Number(currentWar?.opponent?.destructionPercentage))
        ? Number(currentWar?.opponent?.destructionPercentage)
        : null,
      testFinalResultOverride,
    };
  }

  private async buildEventMessage(
    payload: EventEmitPayload,
    guildId: string | null,
    options?: {
      includeRoleMention?: boolean;
      includeEventComponents?: boolean;
      warId?: number | null;
    }
  ): Promise<{
    content?: string;
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
    allowedMentions?: { roles: string[] };
  }> {
    const includeRoleMention = options?.includeRoleMention ?? true;
    const includeEventComponents = options?.includeEventComponents ?? true;
    const warId = options?.warId ?? null;
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
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
      .setTimestamp(new Date());

    embed.addFields(
      {
        name: "Opponent",
        value: `${payload.opponentName} (${opponentTag ? `#${opponentTag}` : "unknown"})`,
        inline: false,
      },
      {
        name: "Sync #",
        value: payload.syncNumber ? `#${payload.syncNumber}` : "unknown",
        inline: true,
      }
    );

    if (payload.eventType === "battle_day") {
      embed.addFields(
        {
          name: "Battle Day Remaining",
          value: toDiscordRelativeTime(payload.warEndTime),
          inline: true,
        },
        {
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        }
      );
      if (payload.matchType !== "BL" && payload.matchType !== "MM") {
        embed.addFields({
          name: "War Plan",
          value:
            (await this.history.buildWarPlanText(
              payload.matchType,
              payload.outcome,
              payload.clanTag,
              payload.opponentName
            )) ?? "N/A",
          inline: false,
        });
      }
      if (payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value:
            "**Battle day has started! Thank you for helping with war bases; please switch back to FWA bases asap.**",
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: "Attack whatever you want! Free for all!",
          inline: false,
        });
      }
      embed.addFields({
        name: "\u200b",
        value: buildWarStatsLines({
          clanStars: payload.lastClanStars,
          opponentStars: payload.lastOpponentStars,
          clanAttacks: payload.clanAttacks,
          opponentAttacks: payload.opponentAttacks,
          teamSize: payload.teamSize,
          attacksPerMember: payload.attacksPerMember,
          clanDestruction: payload.clanDestruction,
          opponentDestruction: payload.opponentDestruction,
        }).join("\n"),
        inline: false,
      });
    }

    if (payload.eventType === "war_started") {
      embed.addFields(
        {
          name: "Prep Day Remaining",
          value: toDiscordRelativeTime(payload.warStartTime),
          inline: true,
        },
        {
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        }
      );
      if (payload.matchType === "FWA") {
        embed.addFields({
          name: "War Plan",
          value:
            (await this.history.buildWarPlanText(
              payload.matchType,
              payload.outcome,
              payload.clanTag,
              payload.opponentName
            )) ?? "N/A",
          inline: false,
        });
      }
      if (payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value: [
            `BLACKLIST WAR vs ${payload.opponentName}`,
            "Everyone switch to WAR BASES!",
            "This is an opportunity to gain extra FWA points.",
          ].join("\n"),
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: [
            `MISMATCHED WAR vs ${payload.opponentName}`,
            "Keep war base active and attack what you can.",
          ].join("\n"),
          inline: false,
        });
      }
    }

    if (payload.eventType === "war_ended") {
      const finalResult =
        payload.testFinalResultOverride ??
        (await this.history.getWarEndResultSnapshot({
          clanTag: payload.clanTag,
          opponentTag: payload.opponentTag,
          fallbackClanStars: payload.lastClanStars,
          fallbackOpponentStars: payload.lastOpponentStars,
          warStartTime: payload.warStartTime,
        }));
      const compliance = await this.history.getWarComplianceSnapshot(
        payload.clanTag,
        payload.warStartTime,
        payload.matchType,
        payload.outcome
      );
      embed.addFields(
        {
          name: "Result",
          value: formatResultLabelForEmbed(finalResult.resultLabel),
          inline: false,
        },
        {
          name: "Match Type",
          value: payload.matchType ?? "unknown",
          inline: true,
        },
        {
          name: "\u200b",
          value: buildWarStatsLines({
            clanStars: finalResult.clanStars,
            opponentStars: finalResult.opponentStars,
            clanAttacks: payload.clanAttacks,
            opponentAttacks: payload.opponentAttacks,
            teamSize: payload.teamSize,
            attacksPerMember: payload.attacksPerMember,
            clanDestruction: finalResult.clanDestruction,
            opponentDestruction: finalResult.opponentDestruction,
          }).join("\n"),
          inline: false,
        },
        {
          name: "FWA Points",
          value: this.history.buildWarEndPointsLine(payload, finalResult),
          inline: false,
        },
        {
          name: "Missed Both Attacks",
          value: formatList(compliance.missedBoth),
          inline: false,
        },
        {
          name: "Didn't Follow War Plan",
          value:
            payload.matchType === "BL" || payload.matchType === "MM"
              ? "N/A for BL/MM wars"
              : formatList(compliance.notFollowingPlan),
          inline: false,
        }
      );
    }

    const roleMention =
      includeRoleMention && payload.pingRole && payload.notifyRole ? `<@&${payload.notifyRole}>` : null;
    const nextRefreshLabel =
      payload.eventType === "battle_day" ? buildNextRefreshRelativeLabel(BATTLE_DAY_REFRESH_MS) : null;
    const content =
      payload.eventType === "battle_day"
        ? roleMention
          ? `${roleMention}\n${nextRefreshLabel}`
          : (nextRefreshLabel ?? undefined)
        : (roleMention ?? undefined);
    const components =
      includeEventComponents && payload.eventType === "battle_day" && guildId
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
                .setLabel("Refresh")
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];

    return {
      content,
      embeds: [embed],
      components,
      allowedMentions: roleMention ? { roles: [payload.notifyRole as string] } : undefined,
    };
  }

  private async findSubscriptionByGuildAndTag(
    guildId: string,
    clanTag: string
  ): Promise<SubscriptionRow | null> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","warId","currentSyncNum","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "CurrentWar"
        WHERE "guildId" = ${guildId} AND UPPER(REPLACE("clanTag",'#','')) = ${normalizeTagBare(clanTag)}
        LIMIT 1
      `
    );
    return rows[0] ?? null;
  }

  /** Purpose: has war end recorded. */
  private async hasWarEndRecorded(clanTagInput: string, warStartTime: Date): Promise<boolean> {
    const clanTag = normalizeTag(clanTagInput);
    const existing = await prisma.clanWarHistory.findFirst({
      where: { clanTag, warStartTime },
      orderBy: { warId: "desc" },
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

  private computeTestFwaPointsDelta(finalResult: WarEndResultSnapshot): number {
    if (finalResult.resultLabel === "WIN") return -1;
    if (finalResult.resultLabel === "LOSE") return 1;
    return 0;
  }

  private async processSubscription(
    subscriptionId: number,
    syncContext: PollSyncContext
  ): Promise<boolean> {
    const rows = await prisma.$queryRaw<SubscriptionRow[]>(
      Prisma.sql`
        SELECT
          "id","guildId","clanTag","warId","currentSyncNum","channelId","notify","pingRole","inferredMatchType","notifyRole","fwaPoints","opponentFwaPoints","outcome","matchType","warStartFwaPoints","warEndFwaPoints","lastClanStars","lastOpponentStars","lastState","lastWarStartTime","lastOpponentTag","lastOpponentName","clanName"
        FROM "CurrentWar"
        WHERE "id" = ${subscriptionId}
        LIMIT 1
      `
    );
    const sub = rows[0] ?? null;
    if (!sub) return false;

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    const resolvedState: WarState = war ? deriveState(String(war.state ?? "")) : "notInWar";
    const resolvedOpponentTag = normalizeTag(war?.opponent?.tag ?? "");
    const currentState: WarState =
      resolvedState === "inWar" && !resolvedOpponentTag ? "notInWar" : resolvedState;
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
    const nextWarEndTime = parseCocTime(war?.endTime ?? null);

    const eventTypeRaw = shouldEmit(prevState, currentState);
    let eventType = eventTypeRaw;
    if (!eventType && isNewWarCycle(sub.lastWarStartTime, nextWarStartTime)) {
      if (currentState === "preparation") {
        eventType = "war_started";
      } else if (currentState === "inWar") {
        eventType = "battle_day";
      }
    }
    if (eventType === "war_ended") {
      if (!sub.lastWarStartTime) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=no_last_war_start prev=${prevState} current=${currentState}`
        );
        eventType = null;
      } else if (await this.hasWarEndRecorded(sub.clanTag, sub.lastWarStartTime)) {
        console.log(
          `[war-events] war_ended suppressed guild=${sub.guildId} clan=${sub.clanTag} reason=already_recorded warStart=${sub.lastWarStartTime.toISOString()}`
        );
        eventType = null;
      }
    }
    const syncNumberForEvent =
      eventType === "war_ended"
        ? (sub.currentSyncNum !== null && Number.isFinite(Number(sub.currentSyncNum))
            ? Math.trunc(Number(sub.currentSyncNum))
            : syncContext.activeSync)
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
    const nextClanAttacks = Number.isFinite(Number(war?.clan?.attacks))
      ? Number(war?.clan?.attacks)
      : null;
    const nextOpponentAttacks = Number.isFinite(Number(war?.opponent?.attacks))
      ? Number(war?.opponent?.attacks)
      : null;
    const nextTeamSize = Number.isFinite(Number(war?.teamSize)) ? Number(war?.teamSize) : null;
    const nextAttacksPerMember = Number.isFinite(Number(war?.attacksPerMember))
      ? Number(war?.attacksPerMember)
      : null;
    const nextClanDestruction = Number.isFinite(Number(war?.clan?.destructionPercentage))
      ? Number(war?.clan?.destructionPercentage)
      : null;
    const nextOpponentDestruction = Number.isFinite(Number(war?.opponent?.destructionPercentage))
      ? Number(war?.opponent?.destructionPercentage)
      : null;
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
      console.log(
        `[war-events] transition detected guild=${sub.guildId} clan=${sub.clanTag} event=${eventType} prev=${prevState} current=${currentState} sync=${syncNumberForEvent ?? "unknown"} warStart=${nextWarStartTime?.toISOString() ?? "unknown"} warEnd=${nextWarEndTime?.toISOString() ?? "unknown"} opponent=${nextOpponentTag || normalizeTag(sub.lastOpponentTag ?? "") || "unknown"}`
      );
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
        warEndTime: nextWarEndTime,
        clanAttacks: nextClanAttacks,
        opponentAttacks: nextOpponentAttacks,
        teamSize: nextTeamSize,
        attacksPerMember: nextAttacksPerMember,
        clanDestruction: nextClanDestruction,
        opponentDestruction: nextOpponentDestruction,
      } as const;

      if (eventType === "war_ended") {
        await this.history.persistWarEndHistory(eventPayload).catch((err) => {
          console.error(
            `[war-events] persist war history failed guild=${sub.guildId} clan=${sub.clanTag} error=${formatError(err)}`
          );
        });
      }
      console.log(
        `[war-events] emit start guild=${sub.guildId} channel=${sub.channelId} clan=${eventPayload.clanTag} event=${eventPayload.eventType}`
      );
      if (sub.notify) {
        await this.emitEvent(sub.channelId, eventPayload);
      }
    }

    const resolvedWarId =
      currentState === "notInWar" ? null : await this.resolveWarId(sub.clanTag, nextWarStartTime);

    await prisma.currentWar.update({
      where: { id: sub.id },
      data: {
        warId: resolvedWarId,
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

  private async resolveWarId(clanTagInput: string, warStartTime: Date | null): Promise<number | null> {
    if (!warStartTime) return null;
    const clanTag = normalizeTag(clanTagInput);
    if (!clanTag) return null;
    const currentWarId = await prisma.currentWar
      .findFirst({
        where: {
          clanTag,
          lastWarStartTime: warStartTime,
        },
        select: { warId: true },
      })
      .catch(() => null);
    if (currentWarId?.warId !== null && currentWarId?.warId !== undefined) {
      return Number(currentWarId.warId);
    }
    return (
      await prisma.clanWarHistory
        .findFirst({
          where: {
            clanTag,
            warStartTime,
          },
          orderBy: { warId: "desc" },
          select: { warId: true },
        })
        .catch(() => null)
    )?.warId ?? null;
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
      warEndTime: Date | null;
      clanAttacks: number | null;
      opponentAttacks: number | null;
      teamSize: number | null;
      attacksPerMember: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
      testFinalResultOverride?: WarEndResultSnapshot | null;
    }
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_found`
      );
      return;
    }
    if (!channel.isTextBased()) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=channel_not_text_based`
      );
      return;
    }
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread
    ) {
      console.warn(
        `[war-events] emit skipped channel=${channelId} clan=${payload.clanTag} event=${payload.eventType} reason=unsupported_channel_type type=${channel.type}`
      );
      return;
    }

    const guildId = (channel as { guildId?: string }).guildId ?? null;
    const warId = await this.resolveWarId(payload.clanTag, payload.warStartTime);
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
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
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
        name: "Battle Day Remaining",
        value: toDiscordRelativeTime(payload.warEndTime),
        inline: true,
      });
      embed.addFields({
        name: "Match Type",
        value: payload.matchType ?? "unknown",
        inline: true,
      });
      if (payload.matchType !== "BL" && payload.matchType !== "MM") {
        embed.addFields({
          name: "War Plan",
          value:
            (await this.history.buildWarPlanText(
              payload.matchType,
              payload.outcome,
              payload.clanTag,
              payload.opponentName
            )) ?? "N/A",
          inline: false,
        });
      }
      if (payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value:
            "**Battle day has started! Thank you for your help swapping to war bases, please swap back to FWA bases asap!**",
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: "Attack whatever you want! Free for all! ⚔️",
          inline: false,
        });
      }
    }

    if (payload.eventType === "battle_day") {
      embed.addFields({
        name: "\u200b",
        value: buildWarStatsLines({
          clanStars: payload.lastClanStars,
          opponentStars: payload.lastOpponentStars,
          clanAttacks: payload.clanAttacks,
          opponentAttacks: payload.opponentAttacks,
          teamSize: payload.teamSize,
          attacksPerMember: payload.attacksPerMember,
          clanDestruction: payload.clanDestruction,
          opponentDestruction: payload.opponentDestruction,
        }).join("\n"),
        inline: false,
      });
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
          name: "War Plan",
          value:
            (await this.history.buildWarPlanText(
              payload.matchType,
              payload.outcome,
              payload.clanTag,
              payload.opponentName
            )) ?? "N/A",
          inline: false,
        });
      }
      if (payload.matchType === "BL") {
        embed.addFields({
          name: "Message",
          value: [
            `**⚫️ BLACKLIST WAR 🆚 ${payload.opponentName} 🏴‍☠️**`,
            "Everyone switch to WAR BASES!!",
            "This is our opportunity to gain some extra FWA points!",
            "➕ 30+ people switch to war base = +1 point",
            "➕ 60% total destruction = +1 point",
            "➕ win war = +1 point",
            "---",
            "If you need war base, check https://clashofclans-layouts.com/ or ⁠bases",
          ].join("\n"),
          inline: false,
        });
      }
      if (payload.matchType === "MM") {
        embed.addFields({
          name: "Message",
          value: [
            `⚪️ MISMATCHED WAR 🆚 ${payload.opponentName} :sob:`,
            "Keep WA base active, attack what you can!",
          ].join("\n"),
          inline: false,
        });
      }
    }

    if (payload.eventType === "war_ended") {
      const finalResult =
        payload.testFinalResultOverride ??
        (await this.history.getWarEndResultSnapshot({
          clanTag: payload.clanTag,
          opponentTag: payload.opponentTag,
          fallbackClanStars: payload.lastClanStars,
          fallbackOpponentStars: payload.lastOpponentStars,
          warStartTime: payload.warStartTime,
        }));
      const compliance = await this.history.getWarComplianceSnapshot(
        payload.clanTag,
        payload.warStartTime,
        payload.matchType,
        payload.outcome
      );
      embed.addFields({
        name: "Result",
        value: formatResultLabelForEmbed(finalResult.resultLabel),
        inline: false,
      });
      embed.addFields({
        name: "Match Type",
        value: payload.matchType ?? "unknown",
        inline: true,
      });
      embed.addFields({
        name: "\u200b",
        value: buildWarStatsLines({
          clanStars: finalResult.clanStars,
          opponentStars: finalResult.opponentStars,
          clanAttacks: payload.clanAttacks,
          opponentAttacks: payload.opponentAttacks,
          teamSize: payload.teamSize,
          attacksPerMember: payload.attacksPerMember,
          clanDestruction: finalResult.clanDestruction,
          opponentDestruction: finalResult.opponentDestruction,
        }).join("\n"),
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
    const components =
      payload.eventType === "battle_day" && guildId
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
                .setLabel("Refresh")
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];
    const sent = await channel
      .send({
        content: roleMention ?? undefined,
        embeds: [embed],
        components,
        allowedMentions: roleMention ? { roles: [payload.notifyRole as string] } : undefined,
      })
      .catch((err) => {
        console.error(
          `[war-events] send failed channel=${channelId} clan=${payload.clanTag} error=${formatError(err)}`
        );
        return null;
      });
    if (guildId) {
      const key = makeBattleDayPostKey(guildId, payload.clanTag);
      if (payload.eventType === "battle_day" && sent) {
        battleDayPostByGuildTag.set(key, { channelId, messageId: sent.id });
      } else if (payload.eventType !== "battle_day") {
        battleDayPostByGuildTag.delete(key);
      }
    }
    if (sent) {
      console.log(
        `[war-events] emit success guild=${guildId ?? "unknown"} channel=${channelId} message=${sent.id} clan=${payload.clanTag} event=${payload.eventType}`
      );
    }
  }

  async refreshBattleDayPosts(): Promise<void> {
    const keys = [...battleDayPostByGuildTag.keys()];
    for (const key of keys) {
      await this.refreshBattleDayPostByKey(key).catch((err) => {
        console.error(`[war-events] battle-day refresh failed key=${key} error=${formatError(err)}`);
      });
    }
  }

  async refreshBattleDayPostByInteraction(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseNotifyWarRefreshCustomId(interaction.customId);
    if (!parsed) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ ephemeral: true, content: "Invalid refresh action." });
      }
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const key = makeBattleDayPostKey(parsed.guildId, parsed.clanTag);
    battleDayPostByGuildTag.set(key, {
      channelId: interaction.channelId,
      messageId: interaction.message.id,
    });
    await this.refreshBattleDayPostByKey(key);
    await interaction.editReply({ content: "Battle day embed refreshed." });
  }

  private async refreshBattleDayPostByKey(key: string): Promise<void> {
    const tracked = battleDayPostByGuildTag.get(key);
    if (!tracked) return;
    const [guildId, clanTag] = key.split(":");
    if (!guildId || !clanTag) {
      battleDayPostByGuildTag.delete(key);
      return;
    }

    const sub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!sub || !sub.notify) {
      battleDayPostByGuildTag.delete(key);
      return;
    }

    const war = await this.coc.getCurrentWar(sub.clanTag).catch(() => null);
    if (!war || deriveState(String(war.state ?? "")) !== "inWar") {
      battleDayPostByGuildTag.delete(key);
      return;
    }

    const warStartTime = parseCocTime(war.startTime ?? null) ?? sub.lastWarStartTime ?? null;
    const warEndTime = parseCocTime(war.endTime ?? null);
    const nextClanName = String(war.clan?.name ?? sub.clanName ?? sub.clanTag).trim() || sub.clanTag;
    const nextOpponentTag = normalizeTag(war.opponent?.tag ?? sub.lastOpponentTag ?? "");
    const nextOpponentName =
      String(war.opponent?.name ?? sub.lastOpponentName ?? "Unknown").trim() || "Unknown";
    const nextClanStars = Number.isFinite(Number(war.clan?.stars))
      ? Number(war.clan?.stars)
      : sub.lastClanStars;
    const nextOpponentStars = Number.isFinite(Number(war.opponent?.stars))
      ? Number(war.opponent?.stars)
      : sub.lastOpponentStars;
    const resolvedWarId =
      warStartTime === null ? null : await this.resolveWarId(sub.clanTag, warStartTime);
    await prisma.currentWar.update({
      where: { id: sub.id },
      data: {
        warId: resolvedWarId,
        lastState: "inWar",
        lastWarStartTime: warStartTime,
        lastOpponentTag: nextOpponentTag || sub.lastOpponentTag,
        lastOpponentName: nextOpponentName || sub.lastOpponentName,
        clanName: nextClanName,
        lastClanStars: nextClanStars,
        lastOpponentStars: nextOpponentStars,
        updatedAt: new Date(),
      },
    });

    const refreshedSub = await this.findSubscriptionByGuildAndTag(guildId, clanTag);
    if (!refreshedSub) {
      battleDayPostByGuildTag.delete(key);
      return;
    }

    const channel = await this.client.channels.fetch(tracked.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      battleDayPostByGuildTag.delete(key);
      return;
    }
    const message = await (channel as any).messages.fetch(tracked.messageId).catch(() => null);
    if (!message) {
      battleDayPostByGuildTag.delete(key);
      return;
    }

    const payload = {
      eventType: "battle_day" as const,
      clanTag: refreshedSub.clanTag,
      clanName: String(war.clan?.name ?? refreshedSub.clanName ?? refreshedSub.clanTag).trim() || refreshedSub.clanTag,
      opponentTag: normalizeTag(war.opponent?.tag ?? refreshedSub.lastOpponentTag ?? ""),
      opponentName:
        String(war.opponent?.name ?? refreshedSub.lastOpponentName ?? "Unknown").trim() || "Unknown",
      syncNumber: await this.pointsSync.getPreviousSyncNum(),
      notifyRole: refreshedSub.notifyRole,
      pingRole: refreshedSub.pingRole,
      fwaPoints: refreshedSub.fwaPoints,
      opponentFwaPoints: refreshedSub.opponentFwaPoints,
      outcome: normalizeOutcome(refreshedSub.outcome),
      matchType: refreshedSub.matchType,
      warStartFwaPoints: refreshedSub.warStartFwaPoints,
      warEndFwaPoints: refreshedSub.warEndFwaPoints,
      lastClanStars: Number.isFinite(Number(war.clan?.stars))
        ? Number(war.clan?.stars)
        : refreshedSub.lastClanStars,
      lastOpponentStars: Number.isFinite(Number(war.opponent?.stars))
        ? Number(war.opponent?.stars)
        : refreshedSub.lastOpponentStars,
      warStartTime,
      warEndTime,
      clanAttacks: Number.isFinite(Number(war.clan?.attacks)) ? Number(war.clan?.attacks) : null,
      opponentAttacks: Number.isFinite(Number(war.opponent?.attacks))
        ? Number(war.opponent?.attacks)
        : null,
      teamSize: Number.isFinite(Number(war.teamSize)) ? Number(war.teamSize) : null,
      attacksPerMember: Number.isFinite(Number(war.attacksPerMember))
        ? Number(war.attacksPerMember)
        : null,
      clanDestruction: Number.isFinite(Number(war.clan?.destructionPercentage))
        ? Number(war.clan?.destructionPercentage)
        : null,
      opponentDestruction: Number.isFinite(Number(war.opponent?.destructionPercentage))
        ? Number(war.opponent?.destructionPercentage)
        : null,
    };
    const warId =
      warStartTime && normalizeTag(payload.clanTag)
        ? (
            await prisma.clanWarHistory.findFirst({
              where: {
                clanTag: normalizeTag(payload.clanTag),
                warStartTime,
              },
              orderBy: { warId: "desc" },
              select: { warId: true },
            })
          )?.warId ?? null
        : null;
    const embed = EmbedBuilder.from(message.embeds[0] ?? new EmbedBuilder());
    const next = await this.buildBattleDayRefreshEmbed(payload, warId, embed);
    await message.edit({
      content: buildNextRefreshRelativeLabel(BATTLE_DAY_REFRESH_MS),
      embeds: [next],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(buildNotifyWarRefreshCustomId(guildId, payload.clanTag))
            .setLabel("Refresh")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async buildBattleDayRefreshEmbed(
    payload: {
      eventType: "battle_day";
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
      warEndTime: Date | null;
      clanAttacks: number | null;
      opponentAttacks: number | null;
      teamSize: number | null;
      attacksPerMember: number | null;
      clanDestruction: number | null;
      opponentDestruction: number | null;
    },
    warId: number | null,
    _previous: EmbedBuilder
  ): Promise<EmbedBuilder> {
    const opponentTag = normalizeTag(payload.opponentTag);
    const embed = new EmbedBuilder()
      .setTitle(`Event: ${eventTitle(payload.eventType)} - ${payload.clanName}`)
      .setColor(0xf1c40f)
      .setFooter({ text: `War ID: ${warId ?? "unknown"}` })
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
    embed.addFields({
      name: "Battle Day Remaining",
      value: toDiscordRelativeTime(payload.warEndTime),
      inline: true,
    });
    embed.addFields({
      name: "Match Type",
      value: payload.matchType ?? "unknown",
      inline: true,
    });
    if (payload.matchType !== "BL" && payload.matchType !== "MM") {
      embed.addFields({
        name: "War Plan",
        value:
          (await this.history.buildWarPlanText(
            payload.matchType,
            payload.outcome,
            payload.clanTag,
            payload.opponentName
          )) ?? "N/A",
        inline: false,
      });
    } else if (payload.matchType === "BL") {
      embed.addFields({
        name: "Message",
        value:
          "**Battle day has started! Thank you for your help swapping to war bases, please swap back to FWA bases asap!**",
        inline: false,
      });
    } else {
      embed.addFields({
        name: "Message",
        value: "Attack whatever you want! Free for all! ⚔️",
        inline: false,
      });
    }
    embed.addFields({
      name: "\u200b",
      value: buildWarStatsLines({
        clanStars: payload.lastClanStars,
        opponentStars: payload.lastOpponentStars,
        clanAttacks: payload.clanAttacks,
        opponentAttacks: payload.opponentAttacks,
        teamSize: payload.teamSize,
        attacksPerMember: payload.attacksPerMember,
        clanDestruction: payload.clanDestruction,
        opponentDestruction: payload.opponentDestruction,
      }).join("\n"),
      inline: false,
    });
    return embed;
  }

}

export function buildNotifyWarRefreshCustomId(guildId: string, clanTag: string): string {
  return `${NOTIFY_WAR_REFRESH_PREFIX}:${guildId}:${normalizeTagBare(clanTag)}`;
}

export function parseNotifyWarRefreshCustomId(
  customId: string
): { guildId: string; clanTag: string } | null {
  const [prefix, guildId, clanTagBare] = String(customId ?? "").split(":");
  if (prefix !== NOTIFY_WAR_REFRESH_PREFIX || !guildId || !clanTagBare) return null;
  return { guildId, clanTag: normalizeTag(clanTagBare) };
}

export function isNotifyWarRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${NOTIFY_WAR_REFRESH_PREFIX}:`);
}

export async function handleNotifyWarRefreshButton(
  interaction: ButtonInteraction
): Promise<void> {
  const service = new WarEventLogService(interaction.client, new CoCService());
  await service.refreshBattleDayPostByInteraction(interaction);
}

export const notifyWarBattleDayRefreshIntervalMs = BATTLE_DAY_REFRESH_MS;

