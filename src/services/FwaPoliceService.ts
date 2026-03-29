import { createHash } from "crypto";
import { Client, EmbedBuilder, type APIEmbed } from "discord.js";
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
  type WarComplianceIssue,
  type WarComplianceService,
} from "./WarComplianceService";
import { type FwaLoseStyle, type MatchType, normalizeOutcome } from "./war-events/core";
import {
  classifyFwaPoliceViolation,
  FWA_POLICE_SAMPLE_OFFENDER,
  FWA_POLICE_VIOLATIONS,
  FWA_POLICE_VIOLATION_METADATA,
  normalizeFwaPoliceText,
  renderFwaPoliceTemplate,
  type FwaPoliceApplicabilityContext,
  type FwaPoliceTemplateSource,
  type FwaPoliceViolation,
  validateFwaPoliceTemplatePlaceholders,
} from "./FwaPoliceTemplateCatalog";
import { emojiResolverService } from "./emoji/EmojiResolverService";

type TrackedClanPoliceRow = {
  tag: string;
  name: string | null;
  loseStyle: FwaLoseStyle;
  fwaPoliceDmEnabled: boolean;
  fwaPoliceLogEnabled: boolean;
  logChannelId: string | null;
  notifyChannelId: string | null;
  mailChannelId: string | null;
};

type WarComplianceEvaluator = Pick<
  WarComplianceService,
  "evaluateComplianceForCommand"
>;

type FwaPoliceTemplateResolution = {
  violation: FwaPoliceViolation;
  source: FwaPoliceTemplateSource;
  effectiveTemplate: string;
  rawCustomTemplate: string | null;
  rawDefaultTemplate: string | null;
};

export type FwaPoliceClanConfig = {
  clanTag: string;
  clanName: string | null;
  enableDm: boolean;
  enableLog: boolean;
};

export type FwaPoliceTemplateWriteResult =
  | { ok: true }
  | { ok: false; error: "CLAN_NOT_TRACKED" | "EMPTY_TEMPLATE" | "INVALID_PLACEHOLDER"; detail?: string };

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

export type FwaPoliceTemplatePreviewRow = {
  violation: FwaPoliceViolation;
  label: string;
  effectiveSource: FwaPoliceTemplateSource;
  rawCustomTemplate: string | null;
  rawDefaultTemplate: string | null;
  effectiveTemplate: string;
  renderedSample: string;
  sampleEmbed: APIEmbed;
  isApplicable: boolean;
  applicabilityText: string;
};

export type FwaPoliceTemplatePreviewBundle = {
  clanTag: string;
  clanName: string | null;
  context: FwaPoliceWarplanContext;
  contextSummary: string;
  rows: FwaPoliceTemplatePreviewRow[];
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
  return (
    normalizeFwaPoliceText(clan.logChannelId) ||
    normalizeFwaPoliceText(clan.notifyChannelId) ||
    normalizeFwaPoliceText(clan.mailChannelId) ||
    null
  );
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
    return `#${playerPosition} - ${playerName}`;
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
    allowedMentions?: { users?: string[] };
  }) => Promise<unknown>;
} {
  if (!channel || typeof channel !== "object") return false;
  if (!("isTextBased" in channel) || typeof (channel as any).isTextBased !== "function") return false;
  if (!(channel as any).isTextBased()) return false;
  return "send" in (channel as object);
}

function buildWarplanContextSummary(context: FwaPoliceWarplanContext): string {
  const expectedLabel = context.expectedOutcome ? ` ${context.expectedOutcome}` : "";
  return [
    `Match type context: ${context.matchTypeContext ?? "UNKNOWN"}${expectedLabel}`,
    `Lose style: ${context.loseStyle}`,
    `Free-for-all star threshold: ${context.freeForAllStarThreshold}`,
    `Free-for-all time threshold: ${context.freeForAllTimeThresholdHours}h`,
  ].join(" | ");
}

function toApplicabilityContext(context: FwaPoliceWarplanContext): FwaPoliceApplicabilityContext {
  return {
    matchType: context.matchTypeContext,
    expectedOutcome: context.expectedOutcome,
    loseStyle: context.loseStyle,
  };
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

function buildPoliceMessagePresentation(input: {
  violation: FwaPoliceViolation;
  resolvedTemplate: string;
  offender: string;
  user: string;
  expectedBehavior: string;
  actualBehavior: string;
  matchTypeContext: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  emojis: FwaPoliceResolvedEmojiState;
}): { renderedTemplate: string; embed: EmbedBuilder } {
  const metadata = FWA_POLICE_VIOLATION_METADATA[input.violation];
  const renderedTemplate = renderFwaPoliceTemplate({
    template: input.resolvedTemplate,
    offender: input.offender,
    user: input.user,
  });
  const description = [
    `## ${input.emojis.alert} ${input.emojis.alertBlue} FWA Police - Warplan violation detected ${input.emojis.alertBlue} ${input.emojis.alert}`,
    `**War**: ${resolveWarLine({
      matchTypeContext: input.matchTypeContext,
      expectedOutcome: input.expectedOutcome,
      emojis: input.emojis,
    })}`,
    `**Violation**: ${metadata.label}`,
  ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setDescription(description)
    .addFields(
      {
        name: "**Message**",
        value: clampEmbedFieldValue(renderedTemplate),
        inline: false,
      },
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
      notifyChannelId: true,
      mailChannelId: true,
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

  /** Purpose: save one clan-scoped template override for a canonical police violation. */
  async setClanTemplate(input: {
    clanTag: string;
    violation: FwaPoliceViolation;
    template: string;
  }): Promise<FwaPoliceTemplateWriteResult> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) {
      return { ok: false, error: "CLAN_NOT_TRACKED" };
    }

    const template = input.template.trim();
    if (!template) {
      return { ok: false, error: "EMPTY_TEMPLATE" };
    }
    const validation = validateFwaPoliceTemplatePlaceholders(template);
    if (!validation.ok) {
      return {
        ok: false,
        error: "INVALID_PLACEHOLDER",
        detail: validation.unknownPlaceholders.join(", "),
      };
    }

    await prisma.fwaPoliceClanTemplate.upsert({
      where: {
        clanTag_violation: {
          clanTag: normalizeClanTag(tracked.tag),
          violation: input.violation,
        },
      },
      update: { template },
      create: {
        clanTag: normalizeClanTag(tracked.tag),
        violation: input.violation,
        template,
      },
    });

    return { ok: true };
  }

  /** Purpose: save one global default template override keyed only by canonical police violation. */
  async setDefaultTemplate(input: {
    violation: FwaPoliceViolation;
    template: string;
  }): Promise<FwaPoliceTemplateWriteResult> {
    const template = input.template.trim();
    if (!template) {
      return { ok: false, error: "EMPTY_TEMPLATE" };
    }
    const validation = validateFwaPoliceTemplatePlaceholders(template);
    if (!validation.ok) {
      return {
        ok: false,
        error: "INVALID_PLACEHOLDER",
        detail: validation.unknownPlaceholders.join(", "),
      };
    }

    await prisma.fwaPoliceDefaultTemplate.upsert({
      where: { violation: input.violation },
      update: { template },
      create: {
        violation: input.violation,
        template,
      },
    });

    return { ok: true };
  }

  /** Purpose: remove one clan-scoped template override for a canonical violation. */
  async resetClanTemplate(input: {
    clanTag: string;
    violation: FwaPoliceViolation;
  }): Promise<{ ok: true } | { ok: false; error: "CLAN_NOT_TRACKED" }> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) {
      return { ok: false, error: "CLAN_NOT_TRACKED" };
    }
    await prisma.fwaPoliceClanTemplate.deleteMany({
      where: {
        clanTag: normalizeClanTag(tracked.tag),
        violation: input.violation,
      },
    });
    return { ok: true };
  }

  /** Purpose: remove one global default override for a canonical violation. */
  async resetDefaultTemplate(input: { violation: FwaPoliceViolation }): Promise<void> {
    await prisma.fwaPoliceDefaultTemplate.deleteMany({
      where: { violation: input.violation },
    });
  }

  /** Purpose: resolve template text with strict precedence (Custom -> Default -> Built-in) and include raw configured values. */
  private async resolveTemplateForViolation(input: {
    clanTag: string;
    violation: FwaPoliceViolation;
  }): Promise<FwaPoliceTemplateResolution> {
    const normalizedClanTag = normalizeClanTag(input.clanTag);
    const [customRow, defaultRow] = await Promise.all([
      prisma.fwaPoliceClanTemplate.findUnique({
        where: {
          clanTag_violation: {
            clanTag: normalizedClanTag,
            violation: input.violation,
          },
        },
        select: { template: true },
      }),
      prisma.fwaPoliceDefaultTemplate.findUnique({
        where: { violation: input.violation },
        select: { template: true },
      }),
    ]);

    const rawCustomTemplate = customRow?.template?.trim() || null;
    const rawDefaultTemplate = defaultRow?.template?.trim() || null;
    if (rawCustomTemplate) {
      return {
        violation: input.violation,
        source: "Custom",
        effectiveTemplate: rawCustomTemplate,
        rawCustomTemplate,
        rawDefaultTemplate,
      };
    }
    if (rawDefaultTemplate) {
      return {
        violation: input.violation,
        source: "Default",
        effectiveTemplate: rawDefaultTemplate,
        rawCustomTemplate,
        rawDefaultTemplate,
      };
    }
    return {
      violation: input.violation,
      source: "Built-in",
      effectiveTemplate: FWA_POLICE_VIOLATION_METADATA[input.violation].builtInTemplate,
      rawCustomTemplate,
      rawDefaultTemplate,
    };
  }

  /** Purpose: build preview rows for all canonical violations using shared template resolution + renderer logic. */
  private async buildPreviewRows(input: {
    client: Client;
    clanTag: string;
    context: FwaPoliceWarplanContext;
    sampleUserId?: string | null;
  }): Promise<FwaPoliceTemplatePreviewRow[]> {
    const emojis = await resolveFwaPolicePresentationEmojis(input.client);
    const templateResolutions = await Promise.all(
      FWA_POLICE_VIOLATIONS.map((violation) =>
        this.resolveTemplateForViolation({
          clanTag: input.clanTag,
          violation,
        }),
      ),
    );

    return templateResolutions.map((resolved) => {
      const metadata = FWA_POLICE_VIOLATION_METADATA[resolved.violation];
      const presentation = buildPoliceMessagePresentation({
        violation: resolved.violation,
        resolvedTemplate: resolved.effectiveTemplate,
        offender: FWA_POLICE_SAMPLE_OFFENDER,
        user: input.sampleUserId ? `<@${input.sampleUserId}>` : "UNLINKED_USER",
        expectedBehavior: buildSampleExpectedBehavior(resolved.violation),
        actualBehavior: buildSampleActualBehavior(resolved.violation),
        matchTypeContext: input.context.matchTypeContext,
        expectedOutcome: input.context.expectedOutcome,
        emojis,
      });
      const isApplicable = metadata.isApplicable(toApplicabilityContext(input.context));
      return {
        violation: resolved.violation,
        label: metadata.label,
        effectiveSource: resolved.source,
        rawCustomTemplate: resolved.rawCustomTemplate,
        rawDefaultTemplate: resolved.rawDefaultTemplate,
        effectiveTemplate: resolved.effectiveTemplate,
        renderedSample: presentation.renderedTemplate,
        sampleEmbed: presentation.embed.toJSON(),
        isApplicable,
        applicabilityText: isApplicable
          ? "Applicable"
          : "Not applicable under current warplan",
      };
    });
  }

  /** Purpose: build one full preview bundle for a tracked clan, including warplan-aware applicability context. */
  async getTemplatePreviewBundle(input: {
    client: Client;
    guildId: string;
    clanTag: string;
    sampleUserId?: string | null;
  }): Promise<FwaPoliceTemplatePreviewBundle | null> {
    const tracked = await resolveTrackedClanByTag(input.clanTag);
    if (!tracked) return null;

    const normalizedClanTag = normalizeClanTag(tracked.tag);
    const context = await resolveWarplanContextForClan({
      guildId: input.guildId,
      clanTag: normalizedClanTag,
      loseStyle: tracked.loseStyle,
    });
    const rows = await this.buildPreviewRows({
      client: input.client,
      clanTag: normalizedClanTag,
      context,
      sampleUserId: input.sampleUserId ?? null,
    });

    return {
      clanTag: normalizedClanTag,
      clanName: normalizeFwaPoliceText(tracked.name) || null,
      context,
      contextSummary: buildWarplanContextSummary(context),
      rows,
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
    const resolution = await this.resolveTemplateForViolation({
      clanTag: normalizedClanTag,
      violation: input.violation,
    });
    const presentation = buildPoliceMessagePresentation({
      violation: input.violation,
      resolvedTemplate: resolution.effectiveTemplate,
      offender: FWA_POLICE_SAMPLE_OFFENDER,
      user: `<@${input.requestingUserId}>`,
      expectedBehavior: buildSampleExpectedBehavior(input.violation),
      actualBehavior: buildSampleActualBehavior(input.violation),
      matchTypeContext: context.matchTypeContext,
      expectedOutcome: context.expectedOutcome,
      emojis,
    });

    if (input.destination === "DM") {
      const user = await input.client.users.fetch(input.requestingUserId).catch(() => null);
      const dm = await user?.createDM().catch(() => null);
      if (!dm) {
        return { ok: false, error: "DM_UNAVAILABLE" };
      }
      await dm.send({
        embeds: [presentation.embed],
        allowedMentions: { users: [input.requestingUserId] },
      });
      return { ok: true, deliveredTo: "DM", rendered: presentation.renderedTemplate };
    }

    const strictLogChannelId = normalizeFwaPoliceText(tracked.logChannelId) || null;
    if (!strictLogChannelId) {
      return { ok: false, error: "LOG_CHANNEL_NOT_CONFIGURED" };
    }
    const channel = await input.client.channels.fetch(strictLogChannelId).catch(() => null);
    if (!isTextChannelWithSend(channel)) {
      return { ok: false, error: "LOG_CHANNEL_UNAVAILABLE" };
    }
    await channel.send({
      embeds: [presentation.embed],
      allowedMentions: { users: [input.requestingUserId] },
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

    const evaluation = await input.warCompliance
      .evaluateComplianceForCommand({
        guildId: input.guildId,
        clanTag: normalizedClanTag,
        scope: "war_id",
        warId: normalizedWarId,
      })
      .catch((err) => {
        console.error(
          `[fwa-police] compliance_eval_failed guild=${input.guildId} clan=${normalizedClanTag} warId=${normalizedWarId} error=${formatError(err)}`,
        );
        return null;
      });
    if (!evaluation || evaluation.status !== "ok" || !evaluation.report) {
      return empty;
    }

    const report = evaluation.report;
    const issues = sortViolationsDeterministically(report.notFollowingPlan);
    if (issues.length <= 0) return empty;

    const links = await listPlayerLinksForClanMembers({
      memberTagsInOrder: issues.map((issue) => normalizePlayerTag(issue.playerTag)),
    });
    const discordUserIdByTag = new Map(
      links.map((link) => [normalizePlayerTag(link.playerTag), link.discordUserId]),
    );

    const resolvedLogChannelId = enableLog ? resolveClanLogChannelId(tracked) : null;
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
    const context: FwaPoliceApplicabilityContext = {
      matchType: report.matchType,
      expectedOutcome: report.expectedOutcome,
      loseStyle: report.loseStyle,
    };
    const emojis = await resolveFwaPolicePresentationEmojis(input.client);
    const templateByViolation = new Map<FwaPoliceViolation, FwaPoliceTemplateResolution>(
      (
        await Promise.all(
          FWA_POLICE_VIOLATIONS.map(async (violation) => {
            const resolved = await this.resolveTemplateForViolation({
              clanTag: normalizedClanTag,
              violation,
            });
            return [violation, resolved] as const;
          }),
        )
      ).map((entry) => [entry[0], entry[1]]),
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
      const templateResolution =
        templateByViolation.get(violation) ??
        (await this.resolveTemplateForViolation({
          clanTag: normalizedClanTag,
          violation,
        }));
      const presentation = buildPoliceMessagePresentation({
        violation,
        resolvedTemplate: templateResolution.effectiveTemplate,
        offender: buildOffenderLabel({
          playerPosition: issue.playerPosition ?? null,
          playerName: issue.playerName,
          playerTag: issue.playerTag,
        }),
        user: linkedDiscordUserId ? `<@${linkedDiscordUserId}>` : "UNLINKED_USER",
        expectedBehavior: issue.expectedBehavior,
        actualBehavior: issue.actualBehavior,
        matchTypeContext: report.matchType,
        expectedOutcome: report.expectedOutcome,
        emojis,
      });

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
              embeds: [presentation.embed],
              allowedMentions: {
                users: linkedDiscordUserId ? [linkedDiscordUserId] : [],
              },
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
            embeds: [presentation.embed],
            allowedMentions: {
              users: linkedDiscordUserId ? [linkedDiscordUserId] : [],
            },
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

