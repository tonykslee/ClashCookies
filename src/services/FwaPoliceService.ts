import { createHash } from "crypto";
import { Client, EmbedBuilder } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  listPlayerLinksForClanMembers,
  normalizeClanTag,
  normalizePlayerTag,
} from "./PlayerLinkService";
import {
  DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
  resolveWarPlanComplianceConfig,
} from "./warPlanComplianceConfig";
import {
  type WarComplianceReport,
  type WarComplianceIssue,
  type WarComplianceService,
} from "./WarComplianceService";
import { type FwaLoseStyle, type MatchType, normalizeOutcome } from "./war-events/core";
import {
  classifyFwaPoliceViolation,
  FWA_POLICE_VIOLATIONS,
  FWA_POLICE_VIOLATION_METADATA,
  normalizeFwaPoliceText,
  renderFwaPoliceTemplate,
  type FwaPoliceApplicabilityContext,
  type FwaPoliceViolation,
} from "./FwaPoliceTemplateCatalog";
import { emojiResolverService } from "./emoji/EmojiResolverService";
import { BotLogChannelService } from "./BotLogChannelService";

type TrackedClanPoliceRow = {
  tag: string;
  name: string | null;
  loseStyle: FwaLoseStyle;
  fwaPoliceDmEnabled: boolean;
  fwaPoliceLogEnabled: boolean;
  logChannelId: string | null;
};

type WarComplianceEvaluator = Pick<
  WarComplianceService,
  "evaluateComplianceForCommand"
>;

export type FwaPoliceClanConfig = {
  clanTag: string;
  clanName: string | null;
  enableDm: boolean;
  enableLog: boolean;
};

export type FwaPoliceEnforcementResult = {
  evaluatedViolations: number;
  created: number;
  deduped: number;
  dmSent: number;
  logSent: number;
};

export type FwaPoliceWarplanContext = {
  matchTypeContext: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
  freeForAllStarThreshold: number;
  freeForAllTimeThresholdHours: number;
};


export type FwaPoliceSendSampleResult =
  | { ok: true; deliveredTo: "DM" | "LOG"; rendered: string }
  | {
      ok: false;
      error:
        | "CLAN_NOT_TRACKED"
        | "DM_UNAVAILABLE"
        | "LOG_CHANNEL_NOT_CONFIGURED"
        | "LOG_CHANNEL_UNAVAILABLE";
    };

type FwaPoliceLogResolutionSource = "tracked_clan" | "bot_logs" | "none";

type FwaPoliceLogDestinationResolution = {
  trackedLogChannelId: string | null;
  botLogChannelId: string | null;
  resolvedChannelId: string | null;
  source: FwaPoliceLogResolutionSource;
};

export type FwaPoliceStatusChannelHealth =
  | "not_configured"
  | "ok"
  | "missing_or_inaccessible"
  | "not_text_sendable";

export type FwaPoliceStatusReport = {
  scope: "guild" | "clan";
  policeEnabled: boolean;
  dmEnabled: boolean;
  logEnabled: boolean;
  storedPoliceLogChannelOverrideId: string | null;
  storedBotLogChannelId: string | null;
  storedBotLogChannelHealth: FwaPoliceStatusChannelHealth;
  fallbackBehavior: string;
  enabledViolationTypes: FwaPoliceViolation[];
  trackedClanSummary: {
    total: number;
    policeEnabled: number;
    dmEnabled: number;
    logEnabled: number;
    withTrackedLogChannel: number;
    logEnabledWithoutTrackedLogChannel: number;
  };
  clan: null | {
    clanTag: string;
    clanName: string | null;
    policeEnabled: boolean;
    dmEnabled: boolean;
    logEnabled: boolean;
    storedTrackedLogChannelId: string | null;
    storedTrackedLogChannelHealth: FwaPoliceStatusChannelHealth;
    effectiveLogChannelId: string | null;
    effectiveLogChannelSource: FwaPoliceLogResolutionSource;
    effectiveLogChannelHealth: FwaPoliceStatusChannelHealth;
  };
  warnings: string[];
};

export type FwaPoliceStatusResult =
  | { ok: true; report: FwaPoliceStatusReport }
  | { ok: false; error: "CLAN_NOT_TRACKED"; clanTag: string };

type FwaPoliceResolvedEmojiState = {
  alert: string;
  alertBlue: string;
  yes: string;
  no: string;
  green: string;
  red: string;
  black: string;
  white: string;
  yellow: string;
};

const FWA_POLICE_EMOJI_FALLBACKS: FwaPoliceResolvedEmojiState = {
  alert: ":rotating_light:",
  alertBlue: ":oncoming_police_car:",
  yes: ":yes:",
  no: ":no:",
  green: ":green_circle:",
  red: ":red_circle:",
  black: ":black_circle:",
  white: ":white_circle:",
  yellow: ":yellow_circle:",
};

function sortViolationsDeterministically(
  issues: WarComplianceIssue[],
): WarComplianceIssue[] {
  return [...issues].sort((a, b) => {
    const posA =
      Number.isFinite(Number(a.playerPosition)) && Number(a.playerPosition) > 0
        ? Number(a.playerPosition)
        : Number.MAX_SAFE_INTEGER;
    const posB =
      Number.isFinite(Number(b.playerPosition)) && Number(b.playerPosition) > 0
        ? Number(b.playerPosition)
        : Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    const tagA = normalizePlayerTag(a.playerTag);
    const tagB = normalizePlayerTag(b.playerTag);
    if (tagA !== tagB) return tagA.localeCompare(tagB);
    return String(a.ruleType ?? "").localeCompare(String(b.ruleType ?? ""));
  });
}

function clampEmbedFieldValue(input: unknown, maxLen = 1024): string {
  const value = String(input ?? "").trim();
  if (!value) return "_(none)_";
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function buildViolationKey(issue: WarComplianceIssue): string {
  const attackDetails = Array.isArray(issue.attackDetails)
    ? issue.attackDetails.map((row) => ({
        defenderPosition:
          Number.isFinite(Number(row.defenderPosition)) &&
          Number(row.defenderPosition) > 0
            ? Number(row.defenderPosition)
            : null,
        stars:
          Number.isFinite(Number(row.stars)) && Number(row.stars) >= 0
            ? Number(row.stars)
            : 0,
        attackOrder:
          Number.isFinite(Number(row.attackOrder)) &&
          Number(row.attackOrder) > 0
            ? Number(row.attackOrder)
            : null,
        isBreach: Boolean(row.isBreach),
      }))
    : [];
  const fingerprint = {
    ruleType: issue.ruleType,
    reasonLabel: normalizeFwaPoliceText(issue.reasonLabel),
    expectedBehavior: normalizeFwaPoliceText(issue.expectedBehavior),
    actualBehavior: normalizeFwaPoliceText(issue.actualBehavior),
    attackDetails,
  };
  return createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex");
}

function resolveClanLogChannelId(clan: TrackedClanPoliceRow): string | null {
  return normalizeFwaPoliceText(clan.logChannelId) || null;
}

function buildOffenderLabel(input: {
  playerPosition?: number | null;
  playerName?: string | null;
  playerTag?: string | null;
}): string {
  const playerName = normalizeFwaPoliceText(input.playerName) || "Unknown";
  const playerPosition =
    Number.isFinite(Number(input.playerPosition)) && Number(input.playerPosition) > 0
      ? Math.trunc(Number(input.playerPosition))
      : null;
  if (playerPosition !== null) {
    return `**#${playerPosition} - ${playerName}**`;
  }
  const tag = normalizePlayerTag(String(input.playerTag ?? ""));
  return tag ? `${tag} - ${playerName}` : playerName;
}

function isTextChannelWithSend(
  channel: unknown,
): channel is {
  isTextBased: () => boolean;
  send: (input: {
    content?: string;
    embeds?: EmbedBuilder[];
    allowedMentions?: { users?: string[]; parse?: [] };
  }) => Promise<unknown>;
} {
  if (!channel || typeof channel !== "object") return false;
  if (!("isTextBased" in channel) || typeof (channel as any).isTextBased !== "function") return false;
  if (!(channel as any).isTextBased()) return false;
  return "send" in (channel as object);
}

function buildSampleExpectedBehavior(violation: FwaPoliceViolation): string {
  if (violation === "EARLY_NON_MIRROR_TRIPLE") {
    return "Wait for FFA window before any non-mirror triple.";
  }
  if (violation === "STRICT_WINDOW_MIRROR_MISS_WIN") {
    return "Mirror triple in strict window.";
  }
  if (violation === "STRICT_WINDOW_MIRROR_MISS_LOSS") {
    return "Follow strict-window mirror requirement for loss-traditional flow.";
  }
  if (violation === "EARLY_NON_MIRROR_2STAR") {
    return "Avoid early non-mirror 2-star before FFA window opens.";
  }
  if (violation === "ANY_3STAR") {
    return "Avoid 3-star attacks in traditional FWA-loss flow.";
  }
  return "Do not earn stars on lower-20 bases in triple-top-30 loss mode.";
}

function buildSampleActualBehavior(violation: FwaPoliceViolation): string {
  if (violation === "EARLY_NON_MIRROR_TRIPLE") {
    return "#14 (* * *) : tripled non-mirror before FFA window";
  }
  if (violation === "STRICT_WINDOW_MIRROR_MISS_WIN") {
    return "#15 (* * -) : missed mirror triple during strict window";
  }
  if (violation === "STRICT_WINDOW_MIRROR_MISS_LOSS") {
    return "#15 (* - -) : mirror strict-window miss in loss-traditional flow";
  }
  if (violation === "EARLY_NON_MIRROR_2STAR") {
    return "#18 (* * -) : early non-mirror 2-star before FFA window";
  }
  if (violation === "ANY_3STAR") {
    return "#16 (* * *) : 3-star in loss-traditional flow";
  }
  return "#41 (* - -) : starred lower-20 base in triple-top-30 loss";
}

/** Purpose: resolve the canonical shared police template for one violation without custom overrides. */
function resolveStandardTemplateForViolation(violation: FwaPoliceViolation): string {
  return FWA_POLICE_VIOLATION_METADATA[violation].builtInTemplate;
}

async function resolveFwaPolicePresentationEmojis(
  client: Client,
): Promise<FwaPoliceResolvedEmojiState> {
  const inventory = await emojiResolverService
    .fetchApplicationEmojiInventory(client)
    .catch(() => null);
  if (!inventory?.ok) {
    return FWA_POLICE_EMOJI_FALLBACKS;
  }
  const resolveByName = (name: string, fallback: string): string => {
    const exact = inventory.snapshot.exactByName.get(name);
    if (exact?.rendered) return exact.rendered;
    const lower = inventory.snapshot.lowercaseByName.get(name.toLowerCase());
    if (lower?.rendered) return lower.rendered;
    return fallback;
  };
  return {
    alert: resolveByName("alert", FWA_POLICE_EMOJI_FALLBACKS.alert),
    alertBlue: resolveByName("alert_blue", FWA_POLICE_EMOJI_FALLBACKS.alertBlue),
    yes: resolveByName("yes", FWA_POLICE_EMOJI_FALLBACKS.yes),
    no: resolveByName("no", FWA_POLICE_EMOJI_FALLBACKS.no),
    green: resolveByName("green_circle", FWA_POLICE_EMOJI_FALLBACKS.green),
    red: resolveByName("red_circle", FWA_POLICE_EMOJI_FALLBACKS.red),
    black: resolveByName("black_circle", FWA_POLICE_EMOJI_FALLBACKS.black),
    white: resolveByName("white_circle", FWA_POLICE_EMOJI_FALLBACKS.white),
    yellow: resolveByName("yellow_circle", FWA_POLICE_EMOJI_FALLBACKS.yellow),
  };
}

function resolveWarLine(input: {
  matchTypeContext: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  emojis: FwaPoliceResolvedEmojiState;
}): string {
  if (input.matchTypeContext === "FWA") {
    if (input.expectedOutcome === "WIN") {
      return `FWA-WIN ${input.emojis.green}`;
    }
    if (input.expectedOutcome === "LOSE") {
      return `FWA-LOSE ${input.emojis.red}`;
    }
    return `FWA ${input.emojis.white}`;
  }
  if (input.matchTypeContext === "BL") {
    return `BL ${input.emojis.black}`;
  }
  if (input.matchTypeContext === "MM") {
    return `MM ${input.emojis.white}`;
  }
  if (input.matchTypeContext === "SKIP") {
    return `SKIP ${input.emojis.yellow}`;
  }
  return `${input.matchTypeContext} ${input.emojis.white}`;
}

function formatViolationTimeRemaining(input: {
  attackSeenAt: Date | null;
  warEndTime: Date | null;
}): string | null {
  if (!(input.attackSeenAt instanceof Date)) return null;
  if (!(input.warEndTime instanceof Date)) return null;
  const totalMinutes = Math.max(
    0,
    Math.floor((input.warEndTime.getTime() - input.attackSeenAt.getTime()) / (60 * 1000)),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m left`;
}

function resolveViolationTimeFallbackLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeFwaPoliceText(raw);
  if (!normalized) return null;
  if (!/^\d+h \d+m left$/i.test(normalized)) return null;
  return normalized;
}

function resolveStarsBeforeHitFallbackValue(
  raw: number | string | null | undefined,
): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized >= 0 ? normalized : null;
}

function resolveMentionUserId(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  return normalized;
}

function buildSingleUserAllowedMentions(userId: string | null): {
  users: string[];
  parse: [];
} {
  return userId ? { users: [userId], parse: [] } : { users: [], parse: [] };
}

function resolveWarClanDisplayName(input: {
  preferredClanName: string | null | undefined;
  fallbackClanName: string | null | undefined;
  clanTag: string;
}): string {
  return (
    normalizeFwaPoliceText(input.preferredClanName) ||
    normalizeFwaPoliceText(input.fallbackClanName) ||
    normalizeClanTag(input.clanTag) ||
    String(input.clanTag ?? "").trim() ||
    "Unknown Clan"
  );
}

function resolveBreachAttackOrder(issue: WarComplianceIssue): number | null {
  const attackDetails = Array.isArray(issue.attackDetails) ? issue.attackDetails : [];
  const breachDetail = attackDetails.find((row) => Boolean(row?.isBreach)) ?? attackDetails[0] ?? null;
  if (!breachDetail) return null;
  if (!Number.isFinite(Number(breachDetail.attackOrder))) return null;
  const attackOrder = Math.trunc(Number(breachDetail.attackOrder));
  return attackOrder > 0 ? attackOrder : null;
}

function buildPoliceMessagePresentation(input: {
  violation: FwaPoliceViolation;
  resolvedTemplate: string;
  offender: string;
  user: string;
  expectedBehavior: string;
  actualBehavior: string;
  warClanDisplayName: string;
  matchTypeContext: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  violationTimeRemaining: string;
  starsBeforeHit: number | null;
  emojis: FwaPoliceResolvedEmojiState;
}): { renderedTemplate: string; embed: EmbedBuilder } {
  const renderedTemplate = renderFwaPoliceTemplate({
    template: input.resolvedTemplate,
    offender: input.offender,
    user: input.user,
  });
  const description = [
    `## ${input.emojis.alert} Warplan violation ${input.emojis.alertBlue}`,
    `**War**: ${input.warClanDisplayName} ${resolveWarLine({
      matchTypeContext: input.matchTypeContext,
      expectedOutcome: input.expectedOutcome,
      emojis: input.emojis,
    })}`,
  ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setDescription(description)
    .addFields(
      {
        name: `**${input.emojis.yes} Expected**`,
        value: clampEmbedFieldValue(input.expectedBehavior),
        inline: false,
      },
      {
        name: `**${input.emojis.no} Actual**`,
        value: clampEmbedFieldValue(input.actualBehavior),
        inline: false,
      },
    );
  return {
    renderedTemplate,
    embed,
  };
}

async function resolveTrackedClanByTag(
  clanTag: string,
): Promise<TrackedClanPoliceRow | null> {
  const normalized = normalizeClanTag(clanTag);
  if (!normalized) return null;
  const bare = normalized.slice(1);
  return prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: normalized, mode: "insensitive" } },
        { tag: { equals: bare, mode: "insensitive" } },
      ],
    },
    select: {
      tag: true,
      name: true,
      loseStyle: true,
      fwaPoliceDmEnabled: true,
      fwaPoliceLogEnabled: true,
      logChannelId: true,
    },
  });
}

async function resolveWarplanContextForClan(input: {
  guildId: string;
  clanTag: string;
  loseStyle: FwaLoseStyle;
}): Promise<FwaPoliceWarplanContext> {
  const normalizedClanTag = normalizeClanTag(input.clanTag);
  const bare = normalizedClanTag.replace(/^#/, "");
  const [activeWar, customWinPlan, defaultWinPlan] = await Promise.all([
    prisma.currentWar.findFirst({
      where: {
        guildId: input.guildId,
        AND: [
          {
            OR: [
              { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
              { clanTag: { equals: bare, mode: "insensitive" } },
            ],
          },
          {
            OR: [
              { state: { equals: "preparation", mode: "insensitive" } },
              { state: { equals: "inWar", mode: "insensitive" } },
            ],
          },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      select: { matchType: true, outcome: true },
    }),
    prisma.clanWarPlan.findFirst({
      where: {
        guildId: input.guildId,
        scope: "CUSTOM",
        matchType: "FWA",
        outcome: "WIN",
        loseStyle: "ANY",
        OR: [
          { clanTag: { equals: normalizedClanTag, mode: "insensitive" } },
          { clanTag: { equals: bare, mode: "insensitive" } },
        ],
      },
      select: {
        nonMirrorTripleMinClanStars: true,
        allBasesOpenHoursLeft: true,
      },
    }),
    prisma.clanWarPlan.findFirst({
      where: {
        guildId: input.guildId,
        scope: "DEFAULT",
        clanTag: "",
        matchType: "FWA",
        outcome: "WIN",
        loseStyle: "ANY",
      },
      select: {
        nonMirrorTripleMinClanStars: true,
        allBasesOpenHoursLeft: true,
      },
    }),
  ]);

  const gateConfig = resolveWarPlanComplianceConfig({
    primary: customWinPlan,
    fallback: defaultWinPlan,
  });
  const matchTypeContext =
    activeWar?.matchType === "FWA" ||
    activeWar?.matchType === "BL" ||
    activeWar?.matchType === "MM" ||
    activeWar?.matchType === "SKIP"
      ? activeWar.matchType
      : "FWA";
  const expectedOutcome =
    matchTypeContext === "FWA"
      ? normalizeOutcome(activeWar?.outcome ?? null)
      : null;

  return {
    matchTypeContext,
    expectedOutcome,
    loseStyle: input.loseStyle,
    freeForAllStarThreshold:
      Number.isFinite(Number(gateConfig.nonMirrorTripleMinClanStars))
        ? Math.trunc(Number(gateConfig.nonMirrorTripleMinClanStars))
        : DEFAULT_NON_MIRROR_TRIPLE_MIN_CLAN_STARS,
    freeForAllTimeThresholdHours:
      Number.isFinite(Number(gateConfig.allBasesOpenHoursLeft))
        ? Math.trunc(Number(gateConfig.allBasesOpenHoursLeft))
        : DEFAULT_ALL_BASES_OPEN_HOURS_LEFT,
  };
}

export class FwaPoliceService {
  private readonly botLogChannels: Pick<BotLogChannelService, "getChannelId">;

  /** Purpose: initialize shared dependencies for police delivery behavior. */
  constructor(botLogChannels?: Pick<BotLogChannelService, "getChannelId">) {
    this.botLogChannels = botLogChannels ?? new BotLogChannelService();
  }

  /** Purpose: resolve police log destination via tracked clan log channel first, then guild bot-log fallback. */
  private async resolvePoliceLogDestination(input: {
    guildId: string;
    tracked: TrackedClanPoliceRow;
  }): Promise<FwaPoliceLogDestinationResolution> {
    const trackedLogChannelId = resolveClanLogChannelId(input.tracked);
    if (trackedLogChannelId) {
      return {
        trackedLogChannelId,
        botLogChannelId: null,
        resolvedChannelId: trackedLogChannelId,
        source: "tracked_clan",
      };
    }
    const botLogChannelId = await this.botLogChannels
      .getChannelId(input.guildId)
      .catch(() => null);
    const normalizedBotLogChannelId = normalizeFwaPoliceText(botLogChannelId) || null;
    return {
      trackedLogChannelId: null,
      botLogChannelId: normalizedBotLogChannelId,
      resolvedChannelId: normalizedBotLogChannelId,
      source: normalizedBotLogChannelId ? "bot_logs" : "none",
    };
  }

  /** Purpose: classify channel health for status visibility without throwing. */
  private async probeChannelHealth(input: {
    client: Client;
    channelId: string | null;
  }): Promise<FwaPoliceStatusChannelHealth> {
    if (!input.channelId) return "not_configured";
    const channel = await input.client.channels
      .fetch(input.channelId)
      .catch(() => null);
    if (!channel) return "missing_or_inaccessible";
    if (!isTextChannelWithSend(channel)) return "not_text_sendable";
    return "ok";
  }

  /** Purpose: enforce guardrail that live police checks must evaluate current-war compliance, never historical war-id scope. */
  private async evaluateLiveCurrentWarCompliance(input: {
    guildId: string;
    clanTag: string;
    warId: number;
    warCompliance: WarComplianceEvaluator;
  }): Promise<WarComplianceReport | null> {
    const evaluation = await input.warCompliance
      .evaluateComplianceForCommand({
        guildId: input.guildId,
        clanTag: input.clanTag,
        scope: "current",
        warId: input.warId,
      })
      .catch((err) => {
        console.error(
          `[fwa-police] compliance_eval_failed guild=${input.guildId} clan=${input.clanTag} warId=${input.warId} path=live_current_war error=${formatError(err)}`,
        );
        return null;
      });
    if (!evaluation) return null;

    if (evaluation.status !== "ok" || !evaluation.report) {
      console.warn(
        `[fwa-police] compliance_eval_non_ok guild=${input.guildId} clan=${input.clanTag} warId=${input.warId} path=live_current_war status=${evaluation.status} source=${evaluation.source ?? "none"} war_resolution_source=${evaluation.warResolutionSource ?? "none"} participants=${evaluation.participantsCount} attacks=${evaluation.attacksCount}`,
      );
      return null;
    }

    return evaluation.report;
  }

  /** Purpose: resolve effective police config and logging behavior for guild-wide or clan-scoped status views. */
  async getStatusReport(input: {
    client: Client;
    guildId: string;
    clanTag?: string | null;
  }): Promise<FwaPoliceStatusResult> {
    const normalizedRequestedClanTag = normalizeClanTag(input.clanTag ?? "");
    const trackedRows = (await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        tag: true,
        name: true,
        loseStyle: true,
        fwaPoliceDmEnabled: true,
        fwaPoliceLogEnabled: true,
        logChannelId: true,
      },
    })) as TrackedClanPoliceRow[];
    const normalizedBotLogChannelId =
      normalizeFwaPoliceText(
        await this.botLogChannels.getChannelId(input.guildId).catch(() => null),
      ) || null;
    const botLogChannelHealth = await this.probeChannelHealth({
      client: input.client,
      channelId: normalizedBotLogChannelId,
    });
    const trackedClanSummary = {
      total: trackedRows.length,
      policeEnabled: trackedRows.filter(
        (row) => Boolean(row.fwaPoliceDmEnabled || row.fwaPoliceLogEnabled),
      ).length,
      dmEnabled: trackedRows.filter((row) => Boolean(row.fwaPoliceDmEnabled))
        .length,
      logEnabled: trackedRows.filter((row) => Boolean(row.fwaPoliceLogEnabled))
        .length,
      withTrackedLogChannel: trackedRows.filter((row) =>
        Boolean(resolveClanLogChannelId(row)),
      ).length,
      logEnabledWithoutTrackedLogChannel: trackedRows.filter(
        (row) => Boolean(row.fwaPoliceLogEnabled) && !resolveClanLogChannelId(row),
      ).length,
    };

    const warnings: string[] = [];
    if (
      normalizedBotLogChannelId &&
      botLogChannelHealth !== "ok" &&
      botLogChannelHealth !== "not_configured"
    ) {
      warnings.push(
        `Configured /bot-logs fallback channel <#${normalizedBotLogChannelId}> is ${botLogChannelHealth.replace(/_/g, " ")}.`,
      );
    }

    if (
      !normalizedBotLogChannelId &&
      trackedClanSummary.logEnabledWithoutTrackedLogChannel > 0
    ) {
      warnings.push(
        `${trackedClanSummary.logEnabledWithoutTrackedLogChannel} log-enabled tracked clan(s) have no tracked log-channel and no /bot-logs fallback, so log delivery cannot resolve.`,
      );
    }

    const invalidTrackedLogChannelRows = await Promise.all(
      trackedRows
        .filter((row) => Boolean(row.fwaPoliceLogEnabled) && Boolean(resolveClanLogChannelId(row)))
        .map(async (row) => {
          const channelId = resolveClanLogChannelId(row);
          const health = await this.probeChannelHealth({
            client: input.client,
            channelId,
          });
          return {
            clanTag: normalizeClanTag(row.tag),
            channelId,
            health,
          };
        }),
    );
    const unresolvedTrackedLogRows = invalidTrackedLogChannelRows.filter(
      (row) => row.health !== "ok",
    );
    if (unresolvedTrackedLogRows.length > 0) {
      const preview = unresolvedTrackedLogRows
        .slice(0, 3)
        .map(
          (row) =>
            `${row.clanTag}:${row.channelId ? `<#${row.channelId}>` : "not set"}`,
        )
        .join(", ");
      warnings.push(
        `Configured tracked-clan police log channel(s) are unresolved/unusable for ${unresolvedTrackedLogRows.length} clan(s) (${preview}${unresolvedTrackedLogRows.length > 3 ? ", ..." : ""}).`,
      );
    }

    if (!normalizedRequestedClanTag) {
      return {
        ok: true,
        report: {
          scope: "guild",
          policeEnabled: trackedClanSummary.policeEnabled > 0,
          dmEnabled: trackedClanSummary.dmEnabled > 0,
          logEnabled: trackedClanSummary.logEnabled > 0,
          storedPoliceLogChannelOverrideId: null,
          storedBotLogChannelId: normalizedBotLogChannelId,
          storedBotLogChannelHealth: botLogChannelHealth,
          fallbackBehavior:
            "tracked-clan log-channel when configured, otherwise /bot-logs fallback, otherwise unresolved",
          enabledViolationTypes: [...FWA_POLICE_VIOLATIONS],
          trackedClanSummary,
          clan: null,
          warnings,
        },
      };
    }

    const tracked = trackedRows.find(
      (row) => normalizeClanTag(row.tag) === normalizedRequestedClanTag,
    );
    if (!tracked) {
      return {
        ok: false,
        error: "CLAN_NOT_TRACKED",
        clanTag: normalizedRequestedClanTag,
      };
    }

    const logResolution = await this.resolvePoliceLogDestination({
      guildId: input.guildId,
      tracked,
    });
    const trackedLogChannelHealth = await this.probeChannelHealth({
      client: input.client,
      channelId: logResolution.trackedLogChannelId,
    });
    const effectiveLogChannelHealth =
      logResolution.resolvedChannelId &&
      logResolution.resolvedChannelId === logResolution.trackedLogChannelId
        ? trackedLogChannelHealth
        : await this.probeChannelHealth({
            client: input.client,
            channelId: logResolution.resolvedChannelId,
          });
    const clanWarnings = [...warnings];
    if (
      logResolution.trackedLogChannelId &&
      trackedLogChannelHealth !== "ok" &&
      trackedLogChannelHealth !== "not_configured"
    ) {
      clanWarnings.push(
        `Tracked-clan log-channel <#${logResolution.trackedLogChannelId}> is ${trackedLogChannelHealth.replace(/_/g, " ")}.`,
      );
    }
    if (logResolution.source === "none") {
      clanWarnings.push(
        "No effective log channel resolved (missing tracked-clan log-channel and /bot-logs fallback).",
      );
    } else if (
      effectiveLogChannelHealth !== "ok" &&
      effectiveLogChannelHealth !== "not_configured"
    ) {
      clanWarnings.push(
        `Effective log destination <#${logResolution.resolvedChannelId}> is ${effectiveLogChannelHealth.replace(/_/g, " ")}.`,
      );
    }

    const clanTag = normalizeClanTag(tracked.tag);
    return {
      ok: true,
      report: {
        scope: "clan",
        policeEnabled: Boolean(
          tracked.fwaPoliceDmEnabled || tracked.fwaPoliceLogEnabled,
        ),
        dmEnabled: Boolean(tracked.fwaPoliceDmEnabled),
        logEnabled: Boolean(tracked.fwaPoliceLogEnabled),
        storedPoliceLogChannelOverrideId: null,
        storedBotLogChannelId:
          logResolution.botLogChannelId ?? normalizedBotLogChannelId,
        storedBotLogChannelHealth: botLogChannelHealth,
        fallbackBehavior:
          "tracked-clan log-channel when configured, otherwise /bot-logs fallback, otherwise unresolved",
        enabledViolationTypes: [...FWA_POLICE_VIOLATIONS],
        trackedClanSummary,
        clan: {
          clanTag,
          clanName: normalizeFwaPoliceText(tracked.name) || null,
          policeEnabled: Boolean(
            tracked.fwaPoliceDmEnabled || tracked.fwaPoliceLogEnabled,
          ),
          dmEnabled: Boolean(tracked.fwaPoliceDmEnabled),
          logEnabled: Boolean(tracked.fwaPoliceLogEnabled),
          storedTrackedLogChannelId: logResolution.trackedLogChannelId,
          storedTrackedLogChannelHealth: trackedLogChannelHealth,
          effectiveLogChannelId: logResolution.resolvedChannelId,
          effectiveLogChannelSource: logResolution.source,
          effectiveLogChannelHealth,
        },
        warnings: clanWarnings,
      },
    };
  }

  /** Purpose: resolve `Violation Time` and stars-before-hit from shared breach context and war-attack chronology. */
  private async resolveViolationPresentationContext(input: {
    clanTag: string;
    warId: number;
    playerTag: string;
    issue: WarComplianceIssue;
    reportWarEndTime: Date | null;
  }): Promise<{ violationTimeRemaining: string; starsBeforeHit: number | null }> {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    const normalizedPlayerTag = normalizePlayerTag(input.playerTag);
    const fallbackTimeRemaining =
      resolveViolationTimeFallbackLabel(input.issue.breachContext?.timeRemaining) ||
      "unknown left";
    const fallbackStarsBeforeHit = resolveStarsBeforeHitFallbackValue(
      input.issue.breachContext?.starsAtBreach,
    );
    if (!normalizedClanTag || !normalizedPlayerTag) {
      return {
        violationTimeRemaining: fallbackTimeRemaining,
        starsBeforeHit: fallbackStarsBeforeHit,
      };
    }

    const normalizedWarId = Math.trunc(Number(input.warId));
    if (!Number.isFinite(normalizedWarId) || normalizedWarId <= 0) {
      return {
        violationTimeRemaining: fallbackTimeRemaining,
        starsBeforeHit: fallbackStarsBeforeHit,
      };
    }

    const breachAttackOrder = resolveBreachAttackOrder(input.issue);
    const baseWhere = {
      clanTag: normalizedClanTag,
      warId: normalizedWarId,
      playerTag: normalizedPlayerTag,
    };
    const matchingAttackRow =
      breachAttackOrder !== null
        ? await prisma.warAttacks.findFirst({
            where: {
              ...baseWhere,
              attackOrder: breachAttackOrder,
            },
            select: {
              attackSeenAt: true,
              warEndTime: true,
            },
          })
        : null;
    const fallbackAttackRow =
      matchingAttackRow ??
      (await prisma.warAttacks.findFirst({
        where: {
          ...baseWhere,
          attackOrder: { gt: 0 },
        },
        orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }],
        select: {
          attackSeenAt: true,
          warEndTime: true,
        },
      }));
    const violationTimeRemaining =
      formatViolationTimeRemaining({
        attackSeenAt: fallbackAttackRow?.attackSeenAt ?? null,
        warEndTime: fallbackAttackRow?.warEndTime ?? input.reportWarEndTime ?? null,
      }) ||
      fallbackTimeRemaining;

    if (fallbackStarsBeforeHit !== null) {
      return {
        violationTimeRemaining,
        starsBeforeHit: fallbackStarsBeforeHit,
      };
    }

    if (breachAttackOrder === null) {
      return {
        violationTimeRemaining,
        starsBeforeHit: null,
      };
    }

    const priorWarAttacks = await prisma.warAttacks.findMany({
      where: {
        clanTag: normalizedClanTag,
        warId: normalizedWarId,
        attackOrder: {
          gt: 0,
          lt: breachAttackOrder,
        },
      },
      select: {
        trueStars: true,
      },
    });
    const computedStarsBeforeHit = priorWarAttacks.reduce((sum, row) => {
      const value = Number(row.trueStars ?? 0);
      return sum + (Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);

    return {
      violationTimeRemaining,
      starsBeforeHit: Number.isFinite(computedStarsBeforeHit)
        ? Math.max(0, Math.trunc(computedStarsBeforeHit))
        : null,
    };
  }

  /** Purpose: persist clan-scoped police automation toggles on the tracked-clan source of truth. */
  async setClanConfig(input: {
    clanTag: string;
    enableDm: boolean;
    enableLog: boolean;
  }): Promise<FwaPoliceClanConfig | null> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) return null;

    const updated = await prisma.trackedClan.update({
      where: { tag: tracked.tag },
      data: {
        fwaPoliceDmEnabled: Boolean(input.enableDm),
        fwaPoliceLogEnabled: Boolean(input.enableLog),
      },
      select: {
        tag: true,
        name: true,
        fwaPoliceDmEnabled: true,
        fwaPoliceLogEnabled: true,
      },
    });

    return {
      clanTag: normalizeClanTag(updated.tag),
      clanName: normalizeFwaPoliceText(updated.name) || null,
      enableDm: Boolean(updated.fwaPoliceDmEnabled),
      enableLog: Boolean(updated.fwaPoliceLogEnabled),
    };
  }

  /** Purpose: send one sample rendered police message using the same template/rendering path as live enforcement. */
  async sendSampleMessage(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    violation: FwaPoliceViolation;
    destination: "DM" | "LOG";
    requestingUserId: string;
  }): Promise<FwaPoliceSendSampleResult> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) {
      return { ok: false, error: "CLAN_NOT_TRACKED" };
    }

    const normalizedClanTag = normalizeClanTag(tracked.tag);
    const context = await resolveWarplanContextForClan({
      guildId: input.guildId,
      clanTag: normalizedClanTag,
      loseStyle: tracked.loseStyle,
    });
    const emojis = await resolveFwaPolicePresentationEmojis(input.client);
    const presentation = buildPoliceMessagePresentation({
      violation: input.violation,
      resolvedTemplate: resolveStandardTemplateForViolation(input.violation),
      offender: buildOffenderLabel({
        playerPosition: 15,
        playerName: "Tilonius",
        playerTag: null,
      }),
      user: `<@${input.requestingUserId}>`,
      expectedBehavior: buildSampleExpectedBehavior(input.violation),
      actualBehavior: buildSampleActualBehavior(input.violation),
      warClanDisplayName: resolveWarClanDisplayName({
        preferredClanName: normalizeFwaPoliceText(tracked.name),
        fallbackClanName: null,
        clanTag: normalizedClanTag,
      }),
      matchTypeContext: context.matchTypeContext,
      expectedOutcome: context.expectedOutcome,
      violationTimeRemaining: "23h 15m left",
      starsBeforeHit: null,
      emojis,
    });
    const mentionUserId = resolveMentionUserId(input.requestingUserId);
    const allowedMentions = buildSingleUserAllowedMentions(mentionUserId);

    if (input.destination === "DM") {
      const user = await input.client.users.fetch(input.requestingUserId).catch(() => null);
      const dm = await user?.createDM().catch(() => null);
      if (!dm) {
        return { ok: false, error: "DM_UNAVAILABLE" };
      }
      await dm.send({
        content: presentation.renderedTemplate,
        embeds: [presentation.embed],
        allowedMentions,
      });
      return { ok: true, deliveredTo: "DM", rendered: presentation.renderedTemplate };
    }

    const logResolution = await this.resolvePoliceLogDestination({
      guildId: input.guildId,
      tracked,
    });
    const resolvedLogChannelId = logResolution.resolvedChannelId;
    if (!resolvedLogChannelId) {
      return { ok: false, error: "LOG_CHANNEL_NOT_CONFIGURED" };
    }
    const channel = await input.client.channels
      .fetch(resolvedLogChannelId)
      .catch(() => null);
    if (!isTextChannelWithSend(channel)) {
      return { ok: false, error: "LOG_CHANNEL_UNAVAILABLE" };
    }
    await channel.send({
      content: presentation.renderedTemplate,
      embeds: [presentation.embed],
      allowedMentions,
    });
    return { ok: true, deliveredTo: "LOG", rendered: presentation.renderedTemplate };
  }

  /** Purpose: evaluate canonical compliance and enforce one-time police notifications per unique violation fingerprint. */
  async enforceWarViolations(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    warId: number;
    warCompliance: WarComplianceEvaluator;
  }): Promise<FwaPoliceEnforcementResult> {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    const normalizedWarId = Math.trunc(Number(input.warId));
    const empty: FwaPoliceEnforcementResult = {
      evaluatedViolations: 0,
      created: 0,
      deduped: 0,
      dmSent: 0,
      logSent: 0,
    };
    if (!normalizedClanTag || !Number.isFinite(normalizedWarId) || normalizedWarId <= 0) {
      return empty;
    }

    const tracked = await resolveTrackedClanByTag(normalizedClanTag);
    if (!tracked) return empty;
    const enableDm = Boolean(tracked.fwaPoliceDmEnabled);
    const enableLog = Boolean(tracked.fwaPoliceLogEnabled);
    if (!enableDm && !enableLog) {
      return empty;
    }

    const evaluation = await this.evaluateLiveCurrentWarCompliance({
      guildId: input.guildId,
      clanTag: normalizedClanTag,
      warId: normalizedWarId,
      warCompliance: input.warCompliance,
    });
    if (!evaluation) {
      return empty;
    }
    const report = evaluation;
    const issues = sortViolationsDeterministically(report.notFollowingPlan);
    if (issues.length <= 0) return empty;

    const links = await listPlayerLinksForClanMembers({
      memberTagsInOrder: issues.map((issue) => normalizePlayerTag(issue.playerTag)),
    });
    const discordUserIdByTag = new Map(
      links.map((link) => [normalizePlayerTag(link.playerTag), link.discordUserId]),
    );

    const logResolution = enableLog
      ? await this.resolvePoliceLogDestination({
          guildId: input.guildId,
          tracked,
        })
      : null;
    const resolvedLogChannelId = logResolution?.resolvedChannelId ?? null;
    const resolvedLogChannel =
      enableLog && resolvedLogChannelId
        ? await input.client.channels.fetch(resolvedLogChannelId).catch(() => null)
        : null;
    const canSendLog = isTextChannelWithSend(resolvedLogChannel);

    let created = 0;
    let deduped = 0;
    let dmSent = 0;
    let logSent = 0;

    const effectiveWarId = report.warId ?? normalizedWarId;
    const warClanDisplayName = resolveWarClanDisplayName({
      preferredClanName: report.clanName,
      fallbackClanName: tracked.name,
      clanTag: normalizedClanTag,
    });
    const context: FwaPoliceApplicabilityContext = {
      matchType: report.matchType,
      expectedOutcome: report.expectedOutcome,
      loseStyle: report.loseStyle,
    };
    const emojis = await resolveFwaPolicePresentationEmojis(input.client);
    const templateByViolation = new Map<FwaPoliceViolation, string>(
      FWA_POLICE_VIOLATIONS.map((violation) => [
        violation,
        resolveStandardTemplateForViolation(violation),
      ]),
    );
    for (const issue of issues) {
      const playerTag = normalizePlayerTag(issue.playerTag);
      if (!playerTag) continue;

      const violationKey = buildViolationKey(issue);
      const linkedDiscordUserId = discordUserIdByTag.get(playerTag) ?? null;
      const createdRow = await prisma.fwaPoliceHandledViolation
        .create({
          data: {
            clanTag: normalizedClanTag,
            warId: effectiveWarId,
            playerTag,
            violationKey,
            linkedDiscordUserId,
          },
          select: { id: true },
        })
        .catch((err) => {
          const code = (err as { code?: string } | null | undefined)?.code ?? "";
          if (code === "P2002") return null;
          throw err;
        });
      if (!createdRow) {
        deduped += 1;
        continue;
      }
      created += 1;

      const violation = classifyFwaPoliceViolation({ issue, context });
      const violationPresentation = await this.resolveViolationPresentationContext({
        clanTag: normalizedClanTag,
        warId: effectiveWarId,
        playerTag,
        issue,
        reportWarEndTime: report.warEndTime ?? null,
      });
      const resolvedTemplate =
        templateByViolation.get(violation) ??
        resolveStandardTemplateForViolation(violation);
      const presentation = buildPoliceMessagePresentation({
        violation,
        resolvedTemplate,
        offender: buildOffenderLabel({
          playerPosition: issue.playerPosition ?? null,
          playerName: issue.playerName,
          playerTag: issue.playerTag,
        }),
        user: linkedDiscordUserId ? `<@${linkedDiscordUserId}>` : "UNLINKED_USER",
        expectedBehavior: issue.expectedBehavior,
        actualBehavior: issue.actualBehavior,
        warClanDisplayName,
        matchTypeContext: report.matchType,
        expectedOutcome: report.expectedOutcome,
        violationTimeRemaining: violationPresentation.violationTimeRemaining,
        starsBeforeHit: violationPresentation.starsBeforeHit,
        emojis,
      });
      const mentionUserId = resolveMentionUserId(linkedDiscordUserId);
      const allowedMentions = buildSingleUserAllowedMentions(mentionUserId);

      let dmSentAt: Date | null = null;
      let logSentAt: Date | null = null;

      if (enableDm && linkedDiscordUserId) {
        try {
          const user = await input.client.users
            .fetch(linkedDiscordUserId)
            .catch(() => null);
          const dm = await user?.createDM().catch(() => null);
          if (dm) {
            await dm.send({
              content: presentation.renderedTemplate,
              embeds: [presentation.embed],
              allowedMentions,
            });
            dmSentAt = new Date();
            dmSent += 1;
          }
        } catch (err) {
          console.error(
            `[fwa-police] dm_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${effectiveWarId} player=${playerTag} user=${linkedDiscordUserId} error=${formatError(err)}`,
          );
        }
      }

      if (enableLog && canSendLog) {
        try {
          await resolvedLogChannel.send({
            content: presentation.renderedTemplate,
            embeds: [presentation.embed],
            allowedMentions,
          });
          logSentAt = new Date();
          logSent += 1;
        } catch (err) {
          console.error(
            `[fwa-police] log_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${effectiveWarId} player=${playerTag} channel=${resolvedLogChannelId ?? "unknown"} error=${formatError(err)}`,
          );
        }
      }

      if (dmSentAt || logSentAt) {
        await prisma.fwaPoliceHandledViolation.update({
          where: { id: createdRow.id },
          data: {
            dmSentAt: dmSentAt ?? undefined,
            logSentAt: logSentAt ?? undefined,
          },
        });
      }
    }

    return {
      evaluatedViolations: issues.length,
      created,
      deduped,
      dmSent,
      logSent,
    };
  }
}

export const fwaPoliceService = new FwaPoliceService();

