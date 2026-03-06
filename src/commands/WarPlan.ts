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
import { WarEventHistoryService } from "../services/war-events/history";

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
type PlanTarget = { matchType: PlanMatchType; outcome: PlanOutcome; loseStyle: PlanLoseStyle };

const PLAN_MODAL_PREFIX = "warplan-edit";
const PLAN_MODAL_INPUT_ID = "plan-text";

const MATCH_SELECTOR_CHOICES = [
  { name: "BL", value: "BL" },
  { name: "MM", value: "MM" },
  { name: "FWA (WIN + both LOSE styles)", value: "FWA" },
  { name: "FWA WIN", value: "FWA_WIN" },
  { name: "FWA LOSE TRIPLE_TOP_30", value: "FWA_LOSE_TRIPLE_TOP_30" },
  { name: "FWA LOSE TRADITIONAL", value: "FWA_LOSE_TRADITIONAL" },
] as const;
const MATCH_SELECTOR_CHOICES_SINGLE_TARGET = MATCH_SELECTOR_CHOICES.filter(
  (choice) => choice.value !== "FWA"
);

const ALL_TARGETS: PlanTarget[] = [
  { matchType: "BL", outcome: "ANY", loseStyle: "ANY" },
  { matchType: "MM", outcome: "ANY", loseStyle: "ANY" },
  { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
  { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
  { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" },
];

function normalizeClanTag(value: string | null): string {
  return String(value ?? "").trim().toUpperCase().replace(/^#/, "");
}

function normalizePlanTextInput(raw: string): string {
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

async function resolveCustomEmojiShortcodes(
  text: string,
  interaction: ChatInputCommandInteraction
): Promise<string> {
  const guild = interaction.guild;
  if (!guild) return text;

  try {
    await guild.emojis.fetch();
  } catch {
    return text;
  }

  return text.replace(
    /(^|[\s([{"'])\:([a-zA-Z0-9_]{2,32})\:(?=$|[\s)\]}".,!?:;'"-])/g,
    (full, prefix: string, emojiName: string) => {
      const match = guild.emojis.cache.find((emoji) => emoji.name === emojiName);
      if (!match) return full;
      const token = `<${match.animated ? "a" : ""}:${match.name}:${match.id}>`;
      return `${prefix}${token}`;
    }
  );
}

function formatKeyLabel(matchType: PlanMatchType, outcome: PlanOutcome, loseStyle: PlanLoseStyle): string {
  if (matchType === "FWA") {
    if (outcome === "LOSE" && loseStyle !== "ANY") return `FWA-LOSE-${loseStyle}`;
    if (outcome === "WIN" || outcome === "LOSE") return `FWA-${outcome}`;
  }
  return matchType;
}

function parseSelector(value: string | null | undefined): PlanTarget[] | { error: string } {
  const selector = String(value ?? "").toUpperCase() as PlanMatchSelector;
  if (!selector) return ALL_TARGETS;
  if (selector === "BL") return [{ matchType: "BL", outcome: "ANY", loseStyle: "ANY" }];
  if (selector === "MM") return [{ matchType: "MM", outcome: "ANY", loseStyle: "ANY" }];
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

async function getDefaultPlanText(
  history: WarEventHistoryService,
  guildId: string,
  matchType: PlanMatchType,
  outcome: PlanOutcome,
  loseStyle: PlanLoseStyle
): Promise<string> {
  if (matchType === "FWA" && (outcome === "WIN" || outcome === "LOSE")) {
    const clanTagHint = loseStyle === "TRADITIONAL" ? "#LOSETRADITIONAL" : "#LOSETRIPLETOP30";
    return (
      (await history.buildWarPlanText(
        guildId,
        "FWA",
        outcome,
        clanTagHint,
        "{opponent}",
        "battle"
      )) ?? "FWA plan unavailable."
    );
  }
  if (matchType === "BL") {
    return [
      "\u26ab\ufe0f BLACKLIST WAR \ud83c\udd9a {opponent} \ud83c\udff4\u200d\u2620\ufe0f ",
      "Everyone switch to WAR BASES!!",
      "This is our opportunity to gain some extra FWA points!",
      "\u2795 30+ people switch to war base = +1 point",
      "\u2795 60% total destruction = +1 point",
      "\u2795 win war = +1 point",
      "---",
      "If you need war base, check https://clashofclans-layouts.com/ or bases",
    ].join("\n");
  }
  return [
    "\u26aa\ufe0f MISMATCHED WAR \ud83c\udd9a {opponent} :sob:",
    "Keep WA base active, attack what you can!",
  ].join("\n");
}

async function getCurrentOrDefaultPlanText(params: {
  guildId: string;
  scope: PlanScope;
  clanTag: string;
  target: PlanTarget;
  history: WarEventHistoryService;
}): Promise<string> {
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
    select: { planText: true },
  });
  if (existing?.planText?.trim()) return existing.planText;
  return getDefaultPlanText(
    params.history,
    params.guildId,
    params.target.matchType,
    params.target.outcome,
    params.target.loseStyle
  );
}

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
  run: async (_client: Client, interaction: ChatInputCommandInteraction, cocService: CoCService) => {
    if (!interaction.guildId) {
      await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
      return;
    }

    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand(true);
    const mode: PlanScope = subcommand.includes("default") ? "DEFAULT" : "CUSTOM";
    const isSet = subcommand === "set" || subcommand === "set-default";
    const isShow = subcommand === "show" || subcommand === "show-default";
    const isReset = subcommand === "reset" || subcommand === "reset-default";
    const history = new WarEventHistoryService(cocService);
    const clanTag = mode === "CUSTOM" ? normalizeClanTag(interaction.options.getString("clan-tag", true)) : "";

    if (mode === "CUSTOM" && !clanTag) {
      await interaction.reply({ ephemeral: true, content: "`clan-tag` is required." });
      return;
    }

    const selectorRaw = interaction.options.getString("match-type", false);
    const targetsResult = parseSelector(selectorRaw);
    if ("error" in targetsResult) {
      await interaction.reply({ ephemeral: true, content: targetsResult.error });
      return;
    }
    const targets = targetsResult;

    if (isSet) {
      const selectedRaw = interaction.options.getString("match-type", true);
      const selectedResult = parseSelector(selectedRaw);
      if ("error" in selectedResult) {
        await interaction.reply({ ephemeral: true, content: selectedResult.error });
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
      const prefill = await getCurrentOrDefaultPlanText({
        guildId,
        scope: mode,
        clanTag,
        target,
        history,
      });

      const modalId = `${PLAN_MODAL_PREFIX}:${mode}:${clanTag || "_"}:${target.matchType}:${target.outcome}:${target.loseStyle}`;
      const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Edit ${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)}`);
      const input = new TextInputBuilder()
        .setCustomId(PLAN_MODAL_INPUT_ID)
        .setLabel("Plan text")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
        .setPlaceholder(
          "Bold: **text** | Italic: *text* | Code: `text` | Block: ```text``` | Emoji: :name: or <:name:id>"
        )
        .setValue(prefill);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);

      try {
        const submitted = await interaction.awaitModalSubmit({
          filter: (m) => m.customId === modalId && m.user.id === interaction.user.id,
          time: 10 * 60 * 1000,
        });
        const normalizedPlanText = normalizePlanTextInput(
          submitted.fields.getTextInputValue(PLAN_MODAL_INPUT_ID)
        );
        const planText = await resolveCustomEmojiShortcodes(normalizedPlanText, interaction);
        if (!planText.length) {
          await submitted.reply({ ephemeral: true, content: "Plan text cannot be empty." });
          return;
        }
        if (planText.length > 1500) {
          await submitted.reply({ ephemeral: true, content: "Plan text must be 1500 characters or fewer." });
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
          update: { planText },
          create: {
            guildId,
            scope: mode,
            clanTag,
            matchType: target.matchType,
            outcome: target.outcome,
            loseStyle: target.loseStyle,
            planText,
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
        select: { matchType: true, outcome: true, loseStyle: true, planText: true },
      });
      const rowByKey = new Map<string, string>();
      for (const row of rows) {
        rowByKey.set(`${row.matchType}:${row.outcome}:${row.loseStyle}`, row.planText);
      }

      const fields = [];
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const key = `${target.matchType}:${target.outcome}:${target.loseStyle}`;
        const scopedText = rowByKey.get(key);
        const text =
          scopedText ??
          (await getDefaultPlanText(history, guildId, target.matchType, target.outcome, target.loseStyle));
        fields.push({
          name: `${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)} (${scopedText ? (mode === "DEFAULT" ? "Editable Default" : "Custom") : "Effective Fallback"})`,
          value: text,
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
            : "Effective clan plans (custom overrides default)."
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
        `${mode === "DEFAULT" ? "Reset editable guild default plans." : "Reset clan custom plans."}\nRemoved entries: ${result.count}`
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
        const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter((c) => c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(choices);
  },
};
