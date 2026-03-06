import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { WarEventHistoryService } from "../services/war-events/history";

type PlanMatchType = "FWA" | "BL" | "MM";
type PlanOutcome = "WIN" | "LOSE" | "ANY";
type PlanLoseStyle = "TRADITIONAL" | "TRIPLE_TOP_30" | "ANY";
type PlanScope = "CUSTOM" | "DEFAULT";

function normalizeClanTag(value: string | null): string {
  return String(value ?? "").trim().toUpperCase().replace(/^#/, "");
}

function normalizeMatchType(value: string | null): PlanMatchType {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "BL" || upper === "MM" || upper === "FWA") return upper;
  return "FWA";
}

function normalizeOutcome(value: string | null): PlanOutcome | null {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "WIN" || upper === "LOSE" || upper === "ANY") return upper;
  return null;
}

function normalizeLoseStyle(value: string | null): PlanLoseStyle | null {
  const upper = String(value ?? "").toUpperCase();
  if (upper === "TRADITIONAL" || upper === "TRIPLE_TOP_30" || upper === "ANY") return upper;
  return null;
}

function normalizePlanTextInput(raw: string): string {
  const decoded = raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
  // Embed fields do not reliably render markdown headings, so convert to bold section titles.
  return decoded
    .split("\n")
    .map((line) => {
      const header = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
      return header ? `**${header[1]}**` : line;
    })
    .join("\n");
}

function formatKeyLabel(matchType: PlanMatchType, outcome: PlanOutcome, loseStyle: PlanLoseStyle): string {
  if (matchType === "FWA") {
    if (outcome === "LOSE" && loseStyle !== "ANY") return `FWA-LOSE-${loseStyle}`;
    if (outcome === "WIN" || outcome === "LOSE") return `FWA-${outcome}`;
  }
  return matchType;
}

function resolveRowKey(
  matchType: PlanMatchType,
  outcomeInput: PlanOutcome | null,
  loseStyleInput: PlanLoseStyle | null
): { outcome: PlanOutcome; loseStyle: PlanLoseStyle } | { error: string } {
  if (matchType !== "FWA") {
    if (outcomeInput || loseStyleInput) {
      return { error: "`outcome` and `lose-style` can only be used when `match-type` is FWA." };
    }
    return { outcome: "ANY", loseStyle: "ANY" };
  }
  if (!outcomeInput) return { outcome: "ANY", loseStyle: "ANY" };
  if (outcomeInput === "WIN") {
    if (loseStyleInput) return { error: "`lose-style` can only be used with `outcome:LOSE`." };
    return { outcome: "WIN", loseStyle: "ANY" };
  }
  if (!loseStyleInput || loseStyleInput === "ANY") {
    return { error: "`lose-style` is required for `match-type:FWA outcome:LOSE`." };
  }
  return { outcome: "LOSE", loseStyle: loseStyleInput };
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

function planTargets(
  hasMatchType: boolean,
  matchType: PlanMatchType,
  outcomeInput: PlanOutcome | null,
  loseStyleInput: PlanLoseStyle | null
): Array<{ matchType: PlanMatchType; outcome: PlanOutcome; loseStyle: PlanLoseStyle }> | { error: string } {
  const targets: Array<{ matchType: PlanMatchType; outcome: PlanOutcome; loseStyle: PlanLoseStyle }> = [];
  if (!hasMatchType) {
    targets.push(
      { matchType: "BL", outcome: "ANY", loseStyle: "ANY" },
      { matchType: "MM", outcome: "ANY", loseStyle: "ANY" },
      { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" }
    );
    return targets;
  }
  if (matchType === "FWA" && !outcomeInput) {
    targets.push(
      { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
      { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" }
    );
    return targets;
  }
  const resolved = resolveRowKey(matchType, outcomeInput, loseStyleInput);
  if ("error" in resolved) return resolved;
  targets.push({ matchType, outcome: resolved.outcome, loseStyle: resolved.loseStyle });
  return targets;
}

export const WarPlan: Command = {
  name: "warplan",
  description: "Set, show, or reset clan-scoped war plans; manage editable guild defaults",
  options: [
    {
      name: "set",
      description: "Set clan custom war plan text",
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
          description: "War match type",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "plan-text",
          description: "Custom plan text (max 1500 chars). Supports {opponent}, \\n, and # headers.",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "outcome",
          description: "FWA outcome (optional; omit to set WIN and both LOSE styles)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Required for FWA LOSE plan",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
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
          description: "War match type (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Show FWA LOSE plan for specific lose style",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
        },
      ],
    },
    {
      name: "reset",
      description: "Reset clan custom war plans to defaults",
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
          description: "War match type (optional; omit to reset all clan custom plans)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Reset FWA LOSE plan for specific lose style",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
        },
      ],
    },
    {
      name: "set-default",
      description: "Set editable guild default plan text (fallback used when clan has no custom plan)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "War match type",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "plan-text",
          description: "Default plan text (max 1500 chars). Supports {opponent}, \\n, and # headers.",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "outcome",
          description: "FWA outcome (optional; omit to set WIN and both LOSE styles)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Required for FWA LOSE plan",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
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
          description: "War match type (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Show FWA LOSE default plan for specific lose style",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
        },
      ],
    },
    {
      name: "reset-default",
      description: "Reset editable guild default plans back to built-in defaults",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "match-type",
          description: "War match type (optional; omit to reset all editable defaults)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "FWA", value: "FWA" },
            { name: "BL", value: "BL" },
            { name: "MM", value: "MM" },
          ],
        },
        {
          name: "outcome",
          description: "FWA outcome (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "WIN", value: "WIN" },
            { name: "LOSE", value: "LOSE" },
          ],
        },
        {
          name: "lose-style",
          description: "Reset FWA LOSE default for specific lose style",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "TRIPLE_TOP_30", value: "TRIPLE_TOP_30" },
            { name: "TRADITIONAL", value: "TRADITIONAL" },
          ],
        },
      ],
    },
  ],
  run: async (_client: Client, interaction: ChatInputCommandInteraction, cocService: CoCService) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand(true);
    const mode: PlanScope = subcommand.includes("default") ? "DEFAULT" : "CUSTOM";
    const history = new WarEventHistoryService(cocService);
    const clanTag = mode === "CUSTOM" ? normalizeClanTag(interaction.options.getString("clan-tag", true)) : "";
    if (mode === "CUSTOM" && !clanTag) {
      await interaction.editReply("`clan-tag` is required.");
      return;
    }

    const matchType = normalizeMatchType(interaction.options.getString("match-type", false));
    const outcomeInput = normalizeOutcome(interaction.options.getString("outcome", false));
    const loseStyleInput = normalizeLoseStyle(interaction.options.getString("lose-style", false));
    const isSet = subcommand === "set" || subcommand === "set-default";
    const isShow = subcommand === "show" || subcommand === "show-default";
    const isReset = subcommand === "reset" || subcommand === "reset-default";

    if (isSet) {
      const requiredMatchType = normalizeMatchType(interaction.options.getString("match-type", true));
      const requiredOutcome = normalizeOutcome(interaction.options.getString("outcome", false));
      const requiredLoseStyle = normalizeLoseStyle(interaction.options.getString("lose-style", false));
      const rawPlanText = interaction.options.getString("plan-text", true);
      const planText = normalizePlanTextInput(rawPlanText);

      if (!planText.length) {
        await interaction.editReply("Plan text cannot be empty.");
        return;
      }
      if (planText.length > 1500) {
        await interaction.editReply("Plan text must be 1500 characters or fewer.");
        return;
      }

      if (requiredMatchType === "FWA" && !requiredOutcome) {
        await prisma.$transaction([
          prisma.clanWarPlan.upsert({
            where: {
              guildId_scope_clanTag_matchType_outcome_loseStyle: {
                guildId,
                scope: mode,
                clanTag,
                matchType: "FWA",
                outcome: "WIN",
                loseStyle: "ANY",
              },
            },
            update: { planText },
            create: { guildId, scope: mode, clanTag, matchType: "FWA", outcome: "WIN", loseStyle: "ANY", planText },
          }),
          prisma.clanWarPlan.upsert({
            where: {
              guildId_scope_clanTag_matchType_outcome_loseStyle: {
                guildId,
                scope: mode,
                clanTag,
                matchType: "FWA",
                outcome: "LOSE",
                loseStyle: "TRIPLE_TOP_30",
              },
            },
            update: { planText },
            create: {
              guildId,
              scope: mode,
              clanTag,
              matchType: "FWA",
              outcome: "LOSE",
              loseStyle: "TRIPLE_TOP_30",
              planText,
            },
          }),
          prisma.clanWarPlan.upsert({
            where: {
              guildId_scope_clanTag_matchType_outcome_loseStyle: {
                guildId,
                scope: mode,
                clanTag,
                matchType: "FWA",
                outcome: "LOSE",
                loseStyle: "TRADITIONAL",
              },
            },
            update: { planText },
            create: {
              guildId,
              scope: mode,
              clanTag,
              matchType: "FWA",
              outcome: "LOSE",
              loseStyle: "TRADITIONAL",
              planText,
            },
          }),
        ]);
        await interaction.editReply(
          `${mode === "DEFAULT" ? "Saved editable guild default" : "Saved clan custom"} plan for **FWA-WIN**, **FWA-LOSE-TRIPLE_TOP_30**, and **FWA-LOSE-TRADITIONAL**.\nLength: ${planText.length} chars each`
        );
        return;
      }

      const resolved = resolveRowKey(requiredMatchType, requiredOutcome, requiredLoseStyle);
      if ("error" in resolved) {
        await interaction.editReply(resolved.error);
        return;
      }

      await prisma.clanWarPlan.upsert({
        where: {
          guildId_scope_clanTag_matchType_outcome_loseStyle: {
            guildId,
            scope: mode,
            clanTag,
            matchType: requiredMatchType,
            outcome: resolved.outcome,
            loseStyle: resolved.loseStyle,
          },
        },
        update: { planText },
        create: {
          guildId,
          scope: mode,
          clanTag,
          matchType: requiredMatchType,
          outcome: resolved.outcome,
          loseStyle: resolved.loseStyle,
          planText,
        },
      });

      await interaction.editReply(
        `${mode === "DEFAULT" ? "Saved editable guild default" : "Saved clan custom"} plan for **${formatKeyLabel(requiredMatchType, resolved.outcome, resolved.loseStyle)}**.\nLength: ${planText.length} chars`
      );
      return;
    }

    if (isShow) {
      const targetsResult = planTargets(
        Boolean(interaction.options.getString("match-type", false)),
        matchType,
        outcomeInput,
        loseStyleInput
      );
      if ("error" in targetsResult) {
        await interaction.editReply(targetsResult.error);
        return;
      }
      const targets = targetsResult;

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
        },
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
        const text = scopedText ?? (await getDefaultPlanText(history, guildId, target.matchType, target.outcome, target.loseStyle));
        fields.push({
          name: `${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)} (${scopedText ? (mode === "DEFAULT" ? "Editable Default" : "Custom") : "Effective Fallback"})`,
          value: text,
          inline: false,
        });
        if (i < targets.length - 1) {
          fields.push({
            name: "\u200b",
            value: "──────────",
            inline: false,
          });
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
      const hasMatchType = Boolean(interaction.options.getString("match-type", false));
      if (!hasMatchType) {
        const result = await prisma.clanWarPlan.deleteMany({ where: { guildId, scope: mode, clanTag } });
        await interaction.editReply(
          `${mode === "DEFAULT" ? "Reset all editable guild defaults." : "Reset all clan custom plans."}\nRemoved entries: ${result.count}`
        );
        return;
      }

      if (matchType === "FWA" && !outcomeInput) {
        const result = await prisma.clanWarPlan.deleteMany({
          where: {
            guildId,
            scope: mode,
            clanTag,
            matchType: "FWA",
            OR: [
              { outcome: "WIN", loseStyle: "ANY" },
              { outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
              { outcome: "LOSE", loseStyle: "TRADITIONAL" },
            ],
          },
        });
        await interaction.editReply(
          `Reset **FWA-WIN**, **FWA-LOSE-TRIPLE_TOP_30**, and **FWA-LOSE-TRADITIONAL** ${mode === "DEFAULT" ? "editable default" : "custom"} plans.\nRemoved entries: ${result.count}`
        );
        return;
      }

      const resolved = resolveRowKey(matchType, outcomeInput, loseStyleInput);
      if ("error" in resolved) {
        await interaction.editReply(resolved.error);
        return;
      }

      const result = await prisma.clanWarPlan.deleteMany({
        where: {
          guildId,
          scope: mode,
          clanTag,
          matchType,
          outcome: resolved.outcome,
          loseStyle: resolved.loseStyle,
        },
      });
      await interaction.editReply(
        `Reset **${formatKeyLabel(matchType, resolved.outcome, resolved.loseStyle)}** ${mode === "DEFAULT" ? "editable default" : "custom"} plan.\nRemoved entries: ${result.count}`
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
