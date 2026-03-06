import {
  ApplicationCommandOptionType,
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

function normalizeClanTag(value: string | null): string {
  const bare = String(value ?? "").trim().toUpperCase().replace(/^#/, "");
  return bare;
}

function formatKeyLabel(matchType: PlanMatchType, outcome: PlanOutcome, loseStyle: PlanLoseStyle): string {
  if (matchType === "FWA") {
    if (outcome === "LOSE" && loseStyle !== "ANY") return `FWA-LOSE-${loseStyle}`;
    if (outcome === "WIN" || outcome === "LOSE") return `FWA-${outcome}`;
  }
  return matchType;
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
    if (loseStyleInput) {
      return { error: "`lose-style` can only be used with `outcome:LOSE`." };
    }
    return { outcome: "WIN", loseStyle: "ANY" };
  }

  if (!loseStyleInput || loseStyleInput === "ANY") {
    return { error: "`lose-style` is required for `match-type:FWA outcome:LOSE`." };
  }
  return { outcome: "LOSE", loseStyle: loseStyleInput };
}

export const WarPlan: Command = {
  name: "warplan",
  description: "Set, show, or reset clan-scoped war plans by match type and outcome",
  options: [
    {
      name: "set",
      description: "Set war plan text for match type (or FWA outcome/lose-style)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
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
          description: "Custom plan text (max 1500 chars). Supports {opponent} placeholder.",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "outcome",
          description: "FWA outcome (optional; omit to set both WIN and LOSE defaults)",
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
      description: "Show war plans by match type/outcome/lose-style",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
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
      description: "Reset war plans to defaults",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Tracked clan tag",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "match-type",
          description: "War match type (optional; omit to reset all)",
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
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      await interaction.editReply("This command can only be used in a server.");
      return;
    }

    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand(true);
    const history = new WarEventHistoryService(cocService);
    const clanTag = normalizeClanTag(interaction.options.getString("clan-tag", true));
    if (!clanTag) {
      await interaction.editReply("`clan-tag` is required.");
      return;
    }

    const matchType = normalizeMatchType(interaction.options.getString("match-type", false));
    const outcomeInput = normalizeOutcome(interaction.options.getString("outcome", false));
    const loseStyleInput = normalizeLoseStyle(interaction.options.getString("lose-style", false));

    if (subcommand === "set") {
      const requiredMatchType = normalizeMatchType(interaction.options.getString("match-type", true));
      const requiredOutcome = normalizeOutcome(interaction.options.getString("outcome", false));
      const requiredLoseStyle = normalizeLoseStyle(interaction.options.getString("lose-style", false));
      const planText = interaction.options.getString("plan-text", true);

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
              guildId_clanTag_matchType_outcome_loseStyle: {
                guildId,
                clanTag,
                matchType: "FWA",
                outcome: "WIN",
                loseStyle: "ANY",
              },
            },
            update: { planText },
            create: { guildId, clanTag, matchType: "FWA", outcome: "WIN", loseStyle: "ANY", planText },
          }),
          prisma.clanWarPlan.upsert({
            where: {
              guildId_clanTag_matchType_outcome_loseStyle: {
                guildId,
                clanTag,
                matchType: "FWA",
                outcome: "LOSE",
                loseStyle: "TRIPLE_TOP_30",
              },
            },
            update: { planText },
            create: {
              guildId,
              clanTag,
              matchType: "FWA",
              outcome: "LOSE",
              loseStyle: "TRIPLE_TOP_30",
              planText,
            },
          }),
          prisma.clanWarPlan.upsert({
            where: {
              guildId_clanTag_matchType_outcome_loseStyle: {
                guildId,
                clanTag,
                matchType: "FWA",
                outcome: "LOSE",
                loseStyle: "TRADITIONAL",
              },
            },
            update: { planText },
            create: {
              guildId,
              clanTag,
              matchType: "FWA",
              outcome: "LOSE",
              loseStyle: "TRADITIONAL",
              planText,
            },
          }),
        ]);
        await interaction.editReply(
          `Saved war plan for **FWA-WIN**, **FWA-LOSE-TRIPLE_TOP_30**, and **FWA-LOSE-TRADITIONAL**.\nLength: ${planText.length} chars each`
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
          guildId_clanTag_matchType_outcome_loseStyle: {
            guildId,
            clanTag,
            matchType: requiredMatchType,
            outcome: resolved.outcome,
            loseStyle: resolved.loseStyle,
          },
        },
        update: { planText },
        create: {
          guildId,
          clanTag,
          matchType: requiredMatchType,
          outcome: resolved.outcome,
          loseStyle: resolved.loseStyle,
          planText,
        },
      });

      await interaction.editReply(
        `Saved war plan for **${formatKeyLabel(requiredMatchType, resolved.outcome, resolved.loseStyle)}**.\nLength: ${planText.length} chars`
      );
      return;
    }

    if (subcommand === "show") {
      const targets: Array<{ matchType: PlanMatchType; outcome: PlanOutcome; loseStyle: PlanLoseStyle }> = [];
      if (!interaction.options.getString("match-type", false)) {
        targets.push(
          { matchType: "BL", outcome: "ANY", loseStyle: "ANY" },
          { matchType: "MM", outcome: "ANY", loseStyle: "ANY" },
          { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
          { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
          { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" }
        );
      } else if (matchType === "FWA" && !outcomeInput) {
        targets.push(
          { matchType: "FWA", outcome: "WIN", loseStyle: "ANY" },
          { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" },
          { matchType: "FWA", outcome: "LOSE", loseStyle: "TRADITIONAL" }
        );
      } else {
        const resolved = resolveRowKey(matchType, outcomeInput, loseStyleInput);
        if ("error" in resolved) {
          await interaction.editReply(resolved.error);
          return;
        }
        targets.push({ matchType, outcome: resolved.outcome, loseStyle: resolved.loseStyle });
      }

      const rows = await prisma.clanWarPlan.findMany({
        where: {
          guildId,
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
      for (const target of targets) {
        const key = `${target.matchType}:${target.outcome}:${target.loseStyle}`;
        const custom = rowByKey.get(key);
        const text =
          custom ??
          (await getDefaultPlanText(
            history,
            guildId,
            target.matchType,
            target.outcome,
            target.loseStyle
          ));
        fields.push({
          name: `${formatKeyLabel(target.matchType, target.outcome, target.loseStyle)} (${custom ? "Custom" : "Default"})`,
          value: text,
          inline: false,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("War Plans")
        .setDescription("Plans by match type, outcome, and lose style")
        .addFields(fields)
        .setColor(0x3498db)
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "reset") {
      const hasMatchType = Boolean(interaction.options.getString("match-type", false));
      if (!hasMatchType) {
        const result = await prisma.clanWarPlan.deleteMany({ where: { guildId, clanTag } });
        await interaction.editReply(`Reset all war plans to defaults.\nRemoved entries: ${result.count}`);
        return;
      }

      if (matchType === "FWA" && !outcomeInput) {
        const result = await prisma.clanWarPlan.deleteMany({
          where: {
            guildId,
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
          `Reset **FWA-WIN**, **FWA-LOSE-TRIPLE_TOP_30**, and **FWA-LOSE-TRADITIONAL** plans to defaults.\nRemoved entries: ${result.count}`
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
          clanTag,
          matchType,
          outcome: resolved.outcome,
          loseStyle: resolved.loseStyle,
        },
      });
      await interaction.editReply(
        `Reset **${formatKeyLabel(matchType, resolved.outcome, resolved.loseStyle)}** plan to default.\nRemoved entries: ${result.count}`
      );
      return;
    }

    await interaction.editReply("Unsupported /warplan usage.");
  },
};
