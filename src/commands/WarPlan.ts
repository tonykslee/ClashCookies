import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  parseAllBasesOpenHoursLeftInput,
  parseNonMirrorTripleMinClanStarsInput,
  resolveWarPlanComplianceConfig,
  type WarPlanComplianceConfig,
} from "../services/warPlanComplianceConfig";
import { WarEventHistoryService } from "../services/war-events/history";
import {
  emojiResolverService,
  type EmojiResolverService,
} from "../services/emoji/EmojiResolverService";

type PlanMatchType = "FWA" | "BL" | "MM";
type PlanOutcome = "WIN" | "LOSE" | "ANY";
type PlanLoseStyle = "TRADITIONAL" | "TRIPLE_TOP_30" | "ANY";
type PlanScope = "CUSTOM" | "DEFAULT";
type PlanMatchSelector =
  | "BL"
  | "MM"
  | "FWA"
  | "FWA_WIN"
  | "FWA_LOSE_TRIPLE_TOP_30"
  | "FWA_LOSE_TRADITIONAL";
type PlanTarget = {
  matchType: PlanMatchType;
  outcome: PlanOutcome;
  loseStyle: PlanLoseStyle;
};

const PLAN_MODAL_PREFIX = "warplan-edit";
const PLAN_MODAL_INPUT_ID = "plan-text";
const PLAN_MODAL_MIN_STARS_INPUT_ID = "non-mirror-min-stars";
const PLAN_MODAL_OPEN_HOURS_INPUT_ID = "all-bases-open-hours-left";

const MATCH_SELECTOR_CHOICES = [
  { name: "BL", value: "BL" },
  { name: "MM", value: "MM" },
  { name: "FWA (WIN + both LOSE styles)", value: "FWA" },
  { name: "FWA WIN", value: "FWA_WIN" },
  { name: "FWA LOSE TRIPLE_TOP_30", value: "FWA_LOSE_TRIPLE_TOP_30" },
  { name: "FWA LOSE TRADITIONAL", value: "FWA_LOSE_TRADITIONAL" },
] as const;
const MATCH_SELECTOR_CHOICES_SINGLE_TARGET = MATCH_SELECTOR_CHOICES.filter(
  (choice) => choice.value !== "FWA",
);
const DEFAULT_MODAL_NON_MIRROR_TRIPLE_MIN_CLAN_STARS = 101;
const DEFAULT_MODAL_ALL_BASES_OPEN_HOURS_LEFT = 0;

const DEFAULT_TRADITIONAL_MODAL_NON_MIRROR_TWO_STAR_MIN_CLAN_STARS = 0;
const DEFAULT_TRADITIONAL_MODAL_ALL_BASES_OPEN_HOURS_LEFT = 12;

const ALL_TARGETS: PlanTarget[] = [
  { matchType: "BL", outcome: "ANY", loseStyle: "ANY" },
  { matchType: "MM", outcome: "ANY", loseStyle: "ANY" },
  { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
  { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
  { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
];

function normalizeClanTag(value: string | null): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^#/, "");
}

function normalizePlanTextInput(raw: string): string {
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function planTargetKey(target: PlanTarget): string {
  return `${target.matchType}:${target.outcome}:${target.loseStyle}`;
}

function clampEmbedFieldValue(value: string): string {
  const text = String(value ?? "").trim();
  if (text.length <= 1024) return text;
  return `${text.slice(0, 1012)}\n(+truncated)`;
}

function buildComplianceConfigLine(input: {
  target: PlanTarget;
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
}): string {
  const applicability =
    input.target.matchType === "FWA" && input.target.outcome === "WIN"
      ? ""
      : " (applies to FWA_WIN only)";
  return `Compliance gate: nonMirrorTripleMinClanStars=${input.nonMirrorTripleMinClanStars}, allBasesOpenHoursLeft=${input.allBasesOpenHoursLeft}h${applicability}`;
}

type EmojiShortcodeResolver = Pick<EmojiResolverService, "replaceShortcodes">;

/** Purpose: normalize warplan shortcode text via shared application-emoji resolver. */
async function resolveWarPlanEmojiShortcodes(params: {
  text: string;
  client: Client;
  resolver?: EmojiShortcodeResolver;
}): Promise<string> {
  const resolver = params.resolver ?? emojiResolverService;
  return resolver
    .replaceShortcodes(params.client, params.text)
    .catch(() => params.text);
}

function formatKeyLabel(
  matchType: PlanMatchType,
  outcome: PlanOutcome,
  loseStyle: PlanLoseStyle,
): string {
  if (matchType === "FWA") {
    if (outcome === "LOSE" && loseStyle !== "ANY")
      return `FWA-LOSE-${loseStyle}`;
    if (outcome === "WIN" || outcome === "LOSE") return `FWA-${outcome}`;
  }
  return matchType;
}

function parseSelector(
  value: string | null | undefined,
): PlanTarget[] | { error: string } {
  const selector = String(value ?? "").toUpperCase() as PlanMatchSelector;
  if (!selector) return ALL_TARGETS;
  if (selector === "BL")
    return [{ matchType: "BL", outcome: "ANY", loseStyle: "ANY" }];
  if (selector === "MM")
    return [{ matchType: "MM", outcome: "ANY", loseStyle: "ANY" }];
  if (selector === "FWA") {
    return [
      { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
    ];
  }
  if (selector === "FWA_WIN") {
    return [{ matchType: "FWA", outcome: "WIN", loseStyle: "ANY" }];
  }
  if (selector === "FWA_LOSE_TRIPLE_TOP_30") {
    return [{ matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" }];
  }
  if (selector === "FWA_LOSE_TRADITIONAL") {
    return [{ matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" }];
  }
  return { error: "Unsupported match-type selector." };
}

function getModalComplianceFieldConfig(target: PlanTarget): {
  minStarsLabel: string;
  minStarsDefault: number;
  openHoursDefault: number;
  openHoursDefaultText: string;
} {
  if (
    target.matchType === "FWA" &&
    target.outcome === "LOSE" &&
    target.loseStyle === "TRADITIONAL"
  ) {
    return {
      minStarsLabel: "Minimum clan stars before non-mirror ★★☆",
      minStarsDefault: DEFAULT_TRADITIONAL_MODAL_NON_MIRROR_TWO_STAR_MIN_CLAN_STARS ,
      openHoursDefault: DEFAULT_TRADITIONAL_MODAL_ALL_BASES_OPEN_HOURS_LEFT,
      openHoursDefaultText: "12h",
    };
  } else if (
    target.matchType === "FWA" &&
    target.outcome === "LOSE" &&
    target.loseStyle === "TRIPLE_TOP_30"
  ) {
    return {
      minStarsLabel: "Minimum clan stars before non-mirror ★★☆",
      minStarsDefault: 0 ,
      openHoursDefault: 0,
      openHoursDefaultText: "0",
    };
  }

  return {
    minStarsLabel: "Minimum clan stars before non-mirror ★★★",
    minStarsDefault: DEFAULT_MODAL_NON_MIRROR_TRIPLE_MIN_CLAN_STARS ,
    openHoursDefault: DEFAULT_MODAL_ALL_BASES_OPEN_HOURS_LEFT ,
    openHoursDefaultText: "0",
  };
}

function getModalCompliancePrefillDefaults(
  target: PlanTarget,
  resolvedConfig: WarPlanComplianceConfig,
): {
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
} {
  if (
    target.matchType === "FWA" &&
    target.outcome === "LOSE" &&
    target.loseStyle === "TRADITIONAL"
  ) {
    return {
      nonMirrorTripleMinClanStars: 0,
      allBasesOpenHoursLeft: 12,
    };
  }

  return {
    nonMirrorTripleMinClanStars: resolvedConfig.nonMirrorTripleMinClanStars,
    allBasesOpenHoursLeft: resolvedConfig.allBasesOpenHoursLeft,
  };
}

async function getDefaultPlanText(
  history: WarEventHistoryService,
  guildId: string,
  matchType: PlanMatchType,
  outcome: PlanOutcome,
  loseStyle: PlanLoseStyle
): Promise<string> {
  const expectedOutcome =
    matchType === "FWA" && (outcome === "WIN" || outcome === "LOSE") ? outcome : null;

  const forcedLoseStyle =
    matchType === "FWA" &&
    outcome === "LOSE" &&
    (loseStyle === "TRADITIONAL" || loseStyle === "TRIPLE_TOP_30")
      ? loseStyle
      : null;

  const clanHeaderLabel =
    matchType === "BL"
      ? "BLACKLIST"
      : matchType === "MM"
        ? "MISMATCH"
        : matchType === "FWA" && outcome === "WIN"
          ? "WIN"
          : matchType === "FWA" && outcome === "LOSE"
            ? "LOSE"
            : "{clan}";

  return (
    (await history.buildWarPlanText(
      guildId,
      matchType,
      expectedOutcome,
      "",
      "{opponent}",
      "battle",
      clanHeaderLabel,
      { forcedLoseStyle }
    )) ?? `${matchType} plan unavailable.`
  );
}

async function getCurrentOrDefaultPlanData(params: {
  guildId: string;
  scope: PlanScope;
  clanTag: string;
  target: PlanTarget;
  history: WarEventHistoryService;
}): Promise<{
  planText: string;
  nonMirrorTripleMinClanStars: number;
  allBasesOpenHoursLeft: number;
}> {
  const existing = await prisma.clanWarPlan.findUnique({
    where: {
      guildId_scope_clanTag_matchType_outcome_loseStyle: {
        guildId: params.guildId,
        scope: params.scope,
        clanTag: params.clanTag,
        matchType: params.target.matchType,
        outcome: params.target.outcome,
        loseStyle: params.target.loseStyle,
      },
    },
    select: {
      planText: true,
      nonMirrorTripleMinClanStars: true,
      allBasesOpenHoursLeft: true,
    },
  });

  let fallbackConfig: {
    nonMirrorTripleMinClanStars: number | null;
    allBasesOpenHoursLeft: number | null;
  } | null = null;
  if (params.scope === "CUSTOM") {
    const defaultRow = await prisma.clanWarPlan.findUnique({
      where: {
        guildId_scope_clanTag_matchType_outcome_loseStyle: {
          guildId: params.guildId,
          scope: "DEFAULT",
          clanTag: "",
          matchType: params.target.matchType,
          outcome: params.target.outcome,
          loseStyle: params.target.loseStyle,
        },
      },
      select: {
        nonMirrorTripleMinClanStars: true,
        allBasesOpenHoursLeft: true,
      },
    });
    fallbackConfig = defaultRow;
  }

  const resolvedConfig = resolveWarPlanComplianceConfig({
    primary: existing,
    fallback: fallbackConfig,
  });

  const planText =
    existing?.planText?.trim() ||
    (await getDefaultPlanText(
      params.history,
      params.guildId,
      params.target.matchType,
      params.target.outcome,
      params.target.loseStyle,
    ));

  const modalDefaults =
    params.target.matchType === "FWA" &&
    params.target.outcome === "LOSE" &&
    params.target.loseStyle === "TRADITIONAL"
      ? {
          nonMirrorTripleMinClanStars: DEFAULT_TRADITIONAL_MODAL_NON_MIRROR_TWO_STAR_MIN_CLAN_STARS,
          allBasesOpenHoursLeft: DEFAULT_TRADITIONAL_MODAL_ALL_BASES_OPEN_HOURS_LEFT,
        }
      : {
          nonMirrorTripleMinClanStars: 0,
          allBasesOpenHoursLeft: 0,
        };

  return {
    planText,
    nonMirrorTripleMinClanStars: modalDefaults.nonMirrorTripleMinClanStars,
    allBasesOpenHoursLeft: modalDefaults.allBasesOpenHoursLeft,
  };
}

export const resolveWarPlanEmojiShortcodesForTest =
  resolveWarPlanEmojiShortcodes;

export const WarPlan: Command = {
  name: "warplan",
  description: "Manage clan custom war plans and editable guild defaults",
  options: [
    {
      name: "set",
      description: "Edit clan custom war plan in a modal",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "match-type",
          description: "Plan set to edit",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [...MATCH_SELECTOR_CHOICES_SINGLE_TARGET],
        },
      ],
    },
    {
      name: "show",
      description: "Show effective clan war plans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "match-type",
          description: "Plan set to show (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [...MATCH_SELECTOR_CHOICES],
        },
      ],
    },
    {
      name: "reset",
      description: "Reset clan custom plans to defaults",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "match-type",
          description: "Plan set to reset (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [...MATCH_SELECTOR_CHOICES],
        },
      ],
    },
    {
      name: "set-default",
      description: "Edit guild default war plan in a modal",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "Default plan set to edit",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [...MATCH_SELECTOR_CHOICES_SINGLE_TARGET],
        },
      ],
    },
    {
      name: "show-default",
      description: "Show editable guild default plans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "Default plan set to show (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [...MATCH_SELECTOR_CHOICES],
        },
      ],
    },
    {
      name: "reset-default",
      description: "Reset editable guild defaults to built-in defaults",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "Default plan set to reset (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [...MATCH_SELECTOR_CHOICES],
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService,
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand(true);
    const mode: PlanScope = subcommand.includes("default")
      ? "DEFAULT"
      : "CUSTOM";
    const isSet = subcommand === "set" || subcommand === "set-default";
    const isShow = subcommand === "show" || subcommand === "show-default";
    const isReset = subcommand === "reset" || subcommand === "reset-default";
    const history = new WarEventHistoryService(cocService);
    const clanTag =
      mode === "CUSTOM"
        ? normalizeClanTag(interaction.options.getString("clan-tag", true))
        : "";

    if (mode === "CUSTOM" && !clanTag) {
      await interaction.reply({
        ephemeral: true,
        content: "`clan-tag` is required.",
      });
      return;
    }

    const selectorRaw = interaction.options.getString("match-type", false);
    const targetsResult = parseSelector(selectorRaw);
    if ("error" in targetsResult) {
      await interaction.reply({
        ephemeral: true,
        content: targetsResult.error,
      });
      return;
    }
    const targets = targetsResult;

    if (isSet) {
      const selectedRaw = interaction.options.getString("match-type", true);
      const selectedResult = parseSelector(selectedRaw);
      if ("error" in selectedResult) {
        await interaction.reply({
          ephemeral: true,
          content: selectedResult.error,
        });
        return;
      }
      if (selectedResult.length !== 1) {
        await interaction.reply({
          ephemeral: true,
          content:
            "Modal edit requires a single target set. Use BL/MM/FWA_WIN/FWA_LOSE_TRIPLE_TOP_30/FWA_LOSE_TRADITIONAL.",
        });
        return;
      }
      const target = selectedResult[0];
      const prefill = await getCurrentOrDefaultPlanData({
        guildId,
        scope: mode,
        clanTag,
        target,
        history,
      });

      const modalConfig = getModalComplianceFieldConfig(target);
      const modalId = `${PLAN_MODAL_PREFIX}:${mode}:${clanTag || "_"}:${target.matchType}:${target.outcome}:${target.loseStyle}`;
      const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(
          `Edit ${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)}`,
        );
      const input = new TextInputBuilder()
        .setCustomId(PLAN_MODAL_INPUT_ID)
        .setLabel("Plan text")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setPlaceholder(
          "Bold: **text** | Italic: *text* | Code: `text` | Block: ```text``` | Emoji: :name: or <:name:id>",
        )
        .setValue(prefill.planText);
      const minStarsInput = new TextInputBuilder()
        .setCustomId(PLAN_MODAL_MIN_STARS_INPUT_ID)
        .setLabel(modalConfig.minStarsLabel)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(4)
        .setPlaceholder(`Default: ${modalConfig.minStarsDefault}`)
        .setValue(String(prefill.nonMirrorTripleMinClanStars));
      const openHoursInput = new TextInputBuilder()
        .setCustomId(PLAN_MODAL_OPEN_HOURS_INPUT_ID)
        .setLabel("All bases open hours left (H or Hh)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(3)
        .setPlaceholder(`Default: ${modalConfig.openHoursDefaultText}`)
        .setValue(String(prefill.allBasesOpenHoursLeft));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input),
        new ActionRowBuilder<TextInputBuilder>().addComponents(minStarsInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(openHoursInput),
      );
      await interaction.showModal(modal);

      try {
        const submitted = await interaction.awaitModalSubmit({
          filter: (m) =>
            m.customId === modalId && m.user.id === interaction.user.id,
          time: 10 * 60 * 1000,
        });
        const normalizedPlanText = normalizePlanTextInput(
          submitted.fields.getTextInputValue(PLAN_MODAL_INPUT_ID),
        );
        const minStarsRaw = submitted.fields.getTextInputValue(
          PLAN_MODAL_MIN_STARS_INPUT_ID,
        );
        const openHoursRaw = submitted.fields.getTextInputValue(
          PLAN_MODAL_OPEN_HOURS_INPUT_ID,
        );
        const parsedMinStars =
          parseNonMirrorTripleMinClanStarsInput(minStarsRaw);
        if (!parsedMinStars.ok) {
          await submitted.reply({
            ephemeral: true,
            content: parsedMinStars.error,
          });
          return;
        }
        const parsedOpenHours = parseAllBasesOpenHoursLeftInput(openHoursRaw);
        if (!parsedOpenHours.ok) {
          await submitted.reply({
            ephemeral: true,
            content: parsedOpenHours.error,
          });
          return;
        }

        const planText = await resolveWarPlanEmojiShortcodes({
          text: normalizedPlanText,
          client: interaction.client,
        });
        if (!planText.length) {
          await submitted.reply({
            ephemeral: true,
            content: "Plan text cannot be empty.",
          });
          return;
        }
        if (planText.length > 1500) {
          await submitted.reply({
            ephemeral: true,
            content: "Plan text must be 1500 characters or fewer.",
          });
          return;
        }

        await prisma.clanWarPlan.upsert({
          where: {
            guildId_scope_clanTag_matchType_outcome_loseStyle: {
              guildId,
              scope: mode,
              clanTag,
              matchType: target.matchType,
              outcome: target.outcome,
              loseStyle: target.loseStyle,
            },
          },
          update: {
            planText,
            nonMirrorTripleMinClanStars: parsedMinStars.value,
            allBasesOpenHoursLeft: parsedOpenHours.value,
          },
          create: {
            guildId,
            scope: mode,
            clanTag,
            matchType: target.matchType,
            outcome: target.outcome,
            loseStyle: target.loseStyle,
            planText,
            nonMirrorTripleMinClanStars: parsedMinStars.value,
            allBasesOpenHoursLeft: parsedOpenHours.value,
          },
        });
        await submitted.reply({
          ephemeral: true,
          content: `${mode === "DEFAULT" ? "Saved editable guild default" : "Saved clan custom"} plan for **${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)}**.`,
        });
      } catch {
        // no-op: modal timed out
      }
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (isShow) {
      const rows = await prisma.clanWarPlan.findMany({
        where: {
          guildId,
          scope: mode,
          clanTag,
          OR: targets.map((target) => ({
            matchType: target.matchType,
            outcome: target.outcome,
            loseStyle: target.loseStyle,
          })),
        },
        select: {
          matchType: true,
          outcome: true,
          loseStyle: true,
          planText: true,
          nonMirrorTripleMinClanStars: true,
          allBasesOpenHoursLeft: true,
        },
      });
      const rowByKey = new Map<
        string,
        {
          planText: string;
          nonMirrorTripleMinClanStars: number | null;
          allBasesOpenHoursLeft: number | null;
        }
      >();
      for (const row of rows) {
        rowByKey.set(planTargetKey(row as PlanTarget), {
          planText: row.planText,
          nonMirrorTripleMinClanStars: row.nonMirrorTripleMinClanStars,
          allBasesOpenHoursLeft: row.allBasesOpenHoursLeft,
        });
      }

      const defaultRowByKey = new Map<
        string,
        {
          nonMirrorTripleMinClanStars: number | null;
          allBasesOpenHoursLeft: number | null;
        }
      >();
      if (mode === "CUSTOM") {
        const defaultRows = await prisma.clanWarPlan.findMany({
          where: {
            guildId,
            scope: "DEFAULT",
            clanTag: "",
            OR: targets.map((target) => ({
              matchType: target.matchType,
              outcome: target.outcome,
              loseStyle: target.loseStyle,
            })),
          },
          select: {
            matchType: true,
            outcome: true,
            loseStyle: true,
            nonMirrorTripleMinClanStars: true,
            allBasesOpenHoursLeft: true,
          },
        });
        for (const row of defaultRows) {
          defaultRowByKey.set(planTargetKey(row as PlanTarget), {
            nonMirrorTripleMinClanStars: row.nonMirrorTripleMinClanStars,
            allBasesOpenHoursLeft: row.allBasesOpenHoursLeft,
          });
        }
      }

      const fields = [];
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const key = planTargetKey(target);
        const scopedRow = rowByKey.get(key);
        const scopedText = scopedRow?.planText;
        const text =
          scopedText ??
          (await getDefaultPlanText(
            history,
            guildId,
            target.matchType,
            target.outcome,
            target.loseStyle,
          ));
        const resolvedConfig = resolveWarPlanComplianceConfig({
          primary: scopedRow ?? null,
          fallback:
            mode === "CUSTOM" ? (defaultRowByKey.get(key) ?? null) : null,
        });
        const fieldValue = clampEmbedFieldValue(
          `${text}\n\n${buildComplianceConfigLine({
            target,
            nonMirrorTripleMinClanStars:
              resolvedConfig.nonMirrorTripleMinClanStars,
            allBasesOpenHoursLeft: resolvedConfig.allBasesOpenHoursLeft,
          })}`,
        );
        fields.push({
          name: `${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)} (${scopedText ? (mode === "DEFAULT" ? "Editable Default" : "Custom") : "Effective Fallback"})`,
          value: fieldValue,
          inline: false,
        });
        if (i < targets.length - 1) {
          fields.push({ name: "\u200b", value: "──────────", inline: false });
        }
      }

      const embed = new EmbedBuilder()
        .setTitle(mode === "DEFAULT" ? "War Plan Defaults" : "War Plans")
        .setDescription(
          mode === "DEFAULT"
            ? "Editable guild defaults; missing entries fall back to built-in defaults."
            : "Effective clan plans (custom overrides default).",
        )
        .addFields(fields)
        .setColor(0x3498db)
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (isReset) {
      const where =
        selectorRaw === null
          ? { guildId, scope: mode, clanTag }
          : {
              guildId,
              scope: mode,
              clanTag,
              OR: targets.map((target) => ({
                matchType: target.matchType,
                outcome: target.outcome,
                loseStyle: target.loseStyle,
              })),
            };
      const result = await prisma.clanWarPlan.deleteMany({ where });
      await interaction.editReply(
        `${mode === "DEFAULT" ? "Reset editable guild default plans." : "Reset clan custom plans."}\nRemoved entries: ${result.count}`,
      );
      return;
    }

    await interaction.editReply("Unsupported /warplan usage.");
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan-tag") {
      await interaction.respond([]);
      return;
    }
    const query = normalizeClanTag(String(focused.value ?? "")).toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });
    const choices = tracked
      .map((clan) => {
        const tag = normalizeClanTag(clan.tag);
        const label = clan.name?.trim()
          ? `${clan.name.trim()} (#${tag})`
          : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query),
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
};
